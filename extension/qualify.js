/**
 * The qualification decision.
 *
 * Pure: no DOM, no chrome.*, no storage, so it runs under Node for the tests and in the
 * extension for real verdicts. Anything needing the browser belongs to the caller.
 */

const UNKNOWN = "(unknown)";

// A LinkedIn "generated summary" stands in for a headline when the person wrote none.
// It names an employer and a school but never a job, so it cannot support a verdict.
const GENERATED_HEADLINE = /^\s*(experience|education)\s*:/i;

function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function field(prospect, key) {
  const v = prospect ? prospect[key] : undefined;
  return v === undefined ? null : v;
}

/**
 * The text describing what this person does now.
 *
 * The title, or the headline when there is no title. The headline is only a fallback
 * because it carries slogans and skill lists -- "ex-consultant", "building for
 * designers" -- and matching rules against that prose rejects people for words that
 * were never their job.
 */
export function currentRole(prospect) {
  const title = clean(field(prospect, "title"));
  if (title && title !== UNKNOWN) return title;
  const headline = clean(field(prospect, "headline"));
  if (!headline || headline === UNKNOWN || GENERATED_HEADLINE.test(headline)) return "";
  return headline;
}

/** Roles as an array, whether they arrived as JSON text or already parsed. */
function rolesOf(prospect) {
  const raw = field(prospect, "roles_json") ?? field(prospect, "roles");
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Every job title on this prospect: the current one plus the whole history. */
export function historyRoles(prospect) {
  const titles = [clean(field(prospect, "title"))];
  for (const r of rolesOf(prospect)) {
    if (r && typeof r === "object") titles.push(clean(r.title));
  }
  return titles.filter((t) => t && t !== UNKNOWN);
}

/**
 * Career length in months, inferred from the earliest year in the role history.
 *
 * A fallback for profiles whose lead page stated no total. Deliberately generous: it
 * measures from the earliest year found to today, which over-counts if a role is listed
 * out of order. Since this number can only ever *reject* someone, over-counting is the
 * safe direction to be wrong in.
 */
function monthsFromHistory(prospect, today = new Date()) {
  const roles = rolesOf(prospect);
  if (!roles.length) return null;
  const years = [];
  for (const r of roles) {
    if (!r || typeof r !== "object") continue;
    for (const f of ["dates", "duration"]) {
      const text = String(r[f] ?? "");
      for (const m of text.matchAll(/\b(19[7-9]\d|20[0-4]\d)\b/g)) years.push(Number(m[1]));
    }
  }
  if (!years.length) return null;
  return Math.max(0, (today.getFullYear() - Math.min(...years)) * 12);
}

/** Total professional experience, or null when the profile does not say. */
export function experienceMonths(prospect, today = new Date()) {
  const stated = field(prospect, "experience_months");
  // Truthy, not just non-null: a stated zero means "not stated", so it falls through to
  // the history rather than rejecting someone on a number nobody wrote down.
  if (stated) return Math.trunc(Number(stated));
  return monthsFromHistory(prospect, today);
}

/**
 * The first keyword found as a whole word in `text`, or null.
 *
 * Whole-word so "Securities Analyst" in finance does not trip "security", and
 * "Designer" does not fire on "Design Systems Engineer"... which it would, so the
 * ordering of the rules is what protects that case, not the matcher.
 *
 * A space in a keyword matches any run of whitespace, so "entry level" still matches a
 * title that arrived with a newline or a double space in it.
 */
export function matches(text, keywords) {
  for (const kw of keywords || []) {
    const escaped = String(kw).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = "(?<![a-z0-9])" + escaped.replace(/ /g, "\\s+") + "(?![a-z0-9])";
    if (new RegExp(pattern).test(text)) return kw;
  }
  return null;
}

/** Half-to-even, matching the original scorer this threshold was carried over from. */
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * A verdict is yes or no. There is no third answer.
 *
 * There used to be: a profile we could not read was held back as "needs a human look",
 * on the principle that missing data should not reject anyone. That queue is gone by
 * choice -- anything not positively qualified is rejected, and an unreadable profile
 * is simply one of those. The `disqualifier` still records WHY, so a run that rejects
 * everything for unreadable_role is diagnosable as a rendering problem rather than a
 * persona that matched nobody.
 *
 * It carries no confidence number either. A rule is not sure of anything; it either
 * matched or it did not.
 */
function verdict(fit, reason, disqualifier = null) {
  return { fit, reasons: [reason], disqualifiers: disqualifier ? [disqualifier] : [] };
}

/** Quote a string for a reason line, preferring single quotes. */
function repr(s) {
  const str = String(s);
  return str.includes("'") && !str.includes('"') ? `"${str}"` : `'${str.replace(/'/g, "\\'")}'`;
}

/** 5 rather than 5.0, while 4.5 stays 4.5. */
function fmtG(n) {
  return String(Number(n));
}

/**
 * Does this title name a software role?
 *
 * Returns the matching term, or null. A role term alone passes, and either kind fails
 * if the title names a field that is not software -- "Civil Engineer", "Interior
 * Architect". A broad term (project manager, consultant) needs software beside it:
 * in the title, or, when `profile` text is given, anywhere in the profile. Without
 * `profile` -- the search card -- a broad term passes on its own, to be judged again
 * once the lead page has been read.
 */
export function softwareRole(title, rules, profile = null) {
  const t = clean(title);
  if (!t || t === UNKNOWN) return null;
  if (matches(t, rules.non_software_fields)) return null;
  const direct = matches(t, rules.role_terms);
  if (direct) return direct;
  const broad = matches(t, rules.role_terms_need_software);
  if (!broad) return null;
  if (profile === null) return broad;
  if (matches(t, rules.software_context)) return broad;
  if (matches(profile, rules.software_profile_terms)) return broad;
  for (const pack of Object.values(rules.stacks || {})) {
    if (matches(profile, pack)) return broad;
  }
  return null;
}

/** All the text a profile has, lower-cased, for the "anywhere in the profile" checks. */
function profileText(p) {
  const parts = [field(p, "title"), field(p, "headline"), field(p, "about"),
                 field(p, "company"), field(p, "experience_text"), field(p, "skills_text"),
                 field(p, "education_text"), field(p, "volunteering_text")];
  for (const r of rolesOf(p)) if (r) parts.push(r.title, r.company, r.description);
  return clean(parts.filter(Boolean).join(" \n "));
}

/** Every employer in the history, current one included. */
function companiesOf(p) {
  const list = [field(p, "company")];
  for (const r of rolesOf(p)) if (r) list.push(r.company);
  return list.map(clean).filter(Boolean);
}

function educationOf(p) {
  const e = field(p, "education");
  return Array.isArray(e) ? e : [];
}

/** The first of the wanted degrees any education entry shows, or null. */
function degreeFound(p, wanted, rules) {
  const mbaWords = /master of business administration|\bm\.?b\.?a\b|\bemba\b/gi;
  for (const entry of educationOf(p)) {
    const text = clean([entry.school, entry.degree, entry.detail].filter(Boolean).join(" "));
    for (const kind of wanted) {
      const terms = rules.degrees[kind] || [];
      // An MBA is a master's too, but it is asked for separately: do not let it pass
      // for an MS.
      const seen = kind === "ms" ? text.replace(mbaWords, " ") : text;
      const kw = matches(seen, terms);
      if (kw) return { kind, kw };
    }
  }
  return null;
}

const STACK_NAMES = { ai: "AI", fullstack: "Full-stack", data: "Data" };
const DEGREE_NAMES = { bs: "BS", ms: "MS", phd: "PhD", mba: "MBA" };

/**
 * The whole qualification decision for a lead page. Pure function of the profile, the
 * term lists and the popup's filters.
 *
 * Every check must pass. Each failure names itself, so the log says why.
 */
export function classify(prospect, rules, filters = {}, today = new Date()) {
  const q = rules;
  const f = filters;
  const passed = [];

  // The card's title test again: a card with no title was let through unread.
  const role = currentRole(prospect);
  if (!role) {
    return verdict(false, "No job title could be read from the profile", "unreadable_role");
  }
  const text = profileText(prospect);
  const roleKw = softwareRole(role, q, text);
  if (!roleKw) {
    return verdict(false, `Current role ${repr(role)} is not a software role`,
                   "not_a_software_role");
  }
  passed.push(repr(role));

  const excluded = matches(text, q.exclude_anywhere);
  if (excluded) {
    return verdict(false, `Profile mentions ${repr(excluded)}`, "excluded_term");
  }

  const months = experienceMonths(prospect, today);
  const need = roundHalfToEven((Number(f.min_years) || 0) * 12);
  if (need) {
    if (months === null) {
      return verdict(false, "Years of experience could not be read", "unreadable_experience");
    }
    if (months < need) {
      return verdict(false,
        `${(months / 12).toFixed(1)} years of experience, under the ` +
        `${fmtG(f.min_years)}-year minimum`, "under_minimum_experience");
    }
    passed.push(`${(months / 12).toFixed(1)} years`);
  }

  // Ticked packs: any one of them is enough.
  const stacks = Object.keys(STACK_NAMES).filter((k) => f.stacks && f.stacks[k]);
  if (stacks.length) {
    let hit = null;
    for (const k of stacks) {
      const kw = matches(text, q.stacks[k]);
      if (kw) { hit = `${STACK_NAMES[k]}: ${repr(kw)}`; break; }
    }
    if (!hit) {
      return verdict(false,
        `No ${stacks.map((k) => STACK_NAMES[k]).join(" / ")} terms in the profile`,
        "no_tech_stack");
    }
    passed.push(hit);
  }

  if (f.speaking) {
    const kw = matches(text, q.speaking);
    if (!kw) return verdict(false, "Nothing about speaking, teaching or mentoring", "no_speaking");
    passed.push(`speaking: ${repr(kw)}`);
  }

  if (f.big_company) {
    let kw = null;
    for (const c of companiesOf(prospect)) { kw = matches(c, q.big_companies); if (kw) break; }
    if (!kw) return verdict(false, "No big company in the experience", "no_big_company");
    passed.push(`company: ${repr(kw)}`);
  }

  if (f.big_university) {
    let kw = null;
    for (const e of educationOf(prospect)) {
      kw = matches(clean(e.school), q.big_universities);
      if (kw) break;
    }
    if (!kw) return verdict(false, "No big university in the education", "no_big_university");
    passed.push(`university: ${repr(kw)}`);
  }

  if (f.degrees && f.degrees.on) {
    const wanted = Object.keys(DEGREE_NAMES).filter((k) => f.degrees[k]);
    if (wanted.length) {
      const hit = degreeFound(prospect, wanted, q);
      if (!hit) {
        return verdict(false,
          `No ${wanted.map((k) => DEGREE_NAMES[k]).join(" / ")} in the education`,
          "no_degree");
      }
      passed.push(`degree: ${DEGREE_NAMES[hit.kind]}`);
    }
  }

  return verdict(true, passed.join("; "));
}

/** YES or NO. Anything not positively qualified is a rejection. */
export function verdictOf(res) {
  return res.fit ? "YES" : "NO";
}

/**
 * Judge a search card, before any lead page has been opened: its title, and nothing
 * else.
 *
 * Returns a rejection verdict, or null meaning "open the lead page". A card with no
 * title is null too: the lead page is routinely richer than the card, and rejecting on
 * a blank is rejecting on our own missing data.
 */
export function screenCard(card, rules) {
  const title = clean(field(card, "title"));
  if (!title || title === UNKNOWN) return null;
  if (softwareRole(title, rules)) return null;
  return verdict(false, `Card title ${repr(title)} is not a software role`,
                 "not_a_software_role");
}
