/**
 * Content script for a Sales Navigator LEAD page (/sales/lead/{id}).
 *
 * This is the enrichment step: one page load per prospect, read in full. It is the
 * expensive stage and the one that carries account exposure, so it does as little as
 * possible -- read the DOM, scroll to trigger the lazy sections, read again.
 *
 * The attribute mapping here is the INVERSE of a search card, which is the single
 * easiest mistake to make in this codebase:
 *
 *     search card:  job-title = "4 years 2 months in role"  (tenure)
 *                   title     = "Senior Software Engineer"  (real)
 *     lead page:    job-title = "Smart Contract Engineer"   (real)
 *                   headline  = "Smart Contract Engineer @ Veda"
 *
 * Verified against a live lead page. Location is absent here but present on the search
 * card, so the lead page's blanks must not overwrite what the card already gave.
 */

/**
 * True while this content script can still talk to the extension.
 *
 * A reloaded extension leaves already-injected content scripts running against a dead
 * chrome.runtime. Every call then resolves against chrome-extension://invalid/, which
 * Chrome logs as a failed resource load BEFORE the promise rejects -- so try/catch
 * cannot suppress it, and a report on every scroll step fills the console with
 * thousands of them. chrome.runtime.id goes undefined at exactly that moment, so it is
 * the only thing worth checking first.
 */
function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function textOf(attr) {
  const el = document.querySelector(`[data-anonymize="${attr}"]`);
  return el ? clean(el.innerText || el.textContent) : null;
}

/** Rendered means the lead's own content is present, not merely that the app booted. */
function rendered() {
  const titleOk = /\|\s*Sales Navigator\s*$/i.test(document.title || "");
  const hasName = !!document.querySelector('[data-anonymize="person-name"]');
  const long = (document.body?.innerText || "").length > 1200;
  return titleOk && hasName && long;
}

function waitForRender(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastLen = -1, stable = 0;
    const tick = () => {
      const len = (document.body?.innerText || "").length;
      stable = len === lastLen ? stable + 1 : 0;
      lastLen = len;
      if (rendered() && stable >= 2) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(rendered());
      setTimeout(tick, 400);
    };
    tick();
  });
}

/**
 * Scroll the page so the lazy sections mount.
 *
 * Probed: 4103px of content against a 641px viewport, with ten deferred blocks. The
 * current role is in the top card and needs none of this, so scrolling is best-effort
 * for the experience history -- a failure here must not fail the prospect.
 */
async function revealLazyContent(steps = 4, pauseMs) {
  const [lo, hi] = Array.isArray(pauseMs) ? pauseMs : [pauseMs || 700, pauseMs || 700];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const height = document.documentElement.scrollHeight;
  for (let i = 1; i <= steps; i++) {
    window.scrollTo(0, (height / steps) * i);
    const ms = Math.floor(lo + Math.random() * (hi - lo));
    // The worker is blocked awaiting our reply for all of this, so it cannot know how
    // long it takes. Without the report the popup reads "reading the profile" and sits
    // still for the best part of half a minute.
    if (extensionAlive()) {
      try {
        chrome.runtime.sendMessage({
          type: "PROGRESS", nextAt: Date.now() + ms,
          label: `reading the profile (${i}/${steps})`,
        }).catch(() => {});
      } catch { /* worker asleep; the read carries on regardless */ }
    }
    await sleep(ms);
  }
  window.scrollTo(0, 0);
  await sleep(300);
}

function pageProblem() {
  const url = location.href;
  if (!/\/sales\/lead\//.test(url)) return `redirected_away [${url.slice(0, 80)}]`;
  const txt = (document.body?.innerText || "").slice(0, 2000);
  if (/sign in|join linkedin|session expired|log in to continue/i.test(txt)) {
    return "auth_wall";
  }
  return null;
}

// The fold controls themselves ("...see more", "Show less") are not content.
const FOLD = /^[\s.…]*(show|see)\s+(more|less|all)\b/i;

/**
 * Whether an element is actually on screen. A folded entry is still in the document,
 * and its innerText then comes back as one run-together line -- "InternIBMJun 2010" --
 * which reads as a job title and its dates as part of the career.
 */
function shown(el) {
  return el.getClientRects().length > 0;
}

/** An element's text as non-empty lines, without the fold controls. */
function linesOf(el) {
  return (el.innerText || "").split("\n").map((t) => t.trim())
    .filter((t) => t && !FOLD.test(t));
}

/**
 * Open what the page folds away, so what is read is the text and not its first lines.
 *
 * At most ten clicks a profile: every click is activity on the client's account. The
 * About section's controls go first, then the experience section's, then the rest --
 * so if the limit binds, it is the least useful sections that stay folded. A few
 * passes, because "Show all N positions" can reveal more folded descriptions.
 *
 * Only controls inside a profile section that say "show/see more/all": nothing in
 * navigation, messaging or the page chrome, and never a link to another page. A
 * control that opens a dialog instead of unfolding in place is undone with Escape,
 * since the sections are read from the page, not from a dialog over it.
 */
async function expandHidden(maxClicks = 10) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clicked = new WeakSet();
  let clicks = 0;

  for (let pass = 0; pass < 3 && clicks < maxClicks; pass++) {
    const root = document.querySelector("main") || document.body;
    const folds = [...root.querySelectorAll('button, a, [role="button"]')].filter((b) => {
      // Only what a person could see and press: a control inside a folded entry waits
      // for the pass after the entry is opened.
      if (clicked.has(b) || !b.closest("section") || !shown(b)) return false;
      if (b.closest('nav, header, aside, [role="dialog"]')) return false;
      const href = b.tagName === "A" ? (b.getAttribute("href") || "") : "";
      if (href && !href.startsWith("#")) return false;     // a link to somewhere else
      const label = ((b.innerText || "").trim() || b.getAttribute("aria-label") || "").trim();
      return label.length < 80 && FOLD.test(label) && !/\bless\b/i.test(label);
    });
    if (!folds.length) break;

    // About first, experience second, anything else after.
    const about = sectionUnder(/^about\b/i);
    const blurb = document.querySelector('[data-anonymize="person-blurb"]');
    const experience = sectionUnder(/^experience\b/i) || sectionUnder(/experience/i);
    const rank = (b) => ((about && about.contains(b)) ||
                         (blurb && blurb.closest("section") === b.closest("section"))) ? 0
                      : (experience && experience.contains(b)) ? 1 : 2;
    folds.sort((a, b) => rank(a) - rank(b));

    for (const b of folds) {
      if (clicks >= maxClicks) break;
      clicked.add(b);
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      try { b.click(); clicks++; } catch { continue; }
      await sleep(400 + Math.random() * 400);
      if (document.querySelectorAll('[role="dialog"]').length > dialogs) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(250);
      }
    }
  }
  return clicks;
}

/**
 * Employment history: one entry per role, in page order.
 *
 * Read structurally, not by attribute. The experience section labels a role's title and
 * company with the same data-anonymize names the top card uses, so a query against the
 * document would return the current role repeatedly instead of the history.
 */
function roleHistory(scope, max = 20) {
  if (!scope) return [];
  const rows = [...scope.querySelectorAll("li")]
    .filter((li) => !li.querySelector("li") && shown(li));
  const out = [];
  for (const li of rows.length ? rows : [scope]) {
    const lines = linesOf(li);
    if (!lines.length) continue;
    const dates = lines.find((t) => /\b(19|20)\d{2}\b|present/i.test(t)) || null;
    const dur = (lines.find((t) => /\b\d+\s*(yrs?|mos?)\b/i.test(t)) || "").trim() || null;
    // Everything after title and company that is not the dates: location, employment
    // type, and the description -- where the work itself is described.
    const rest = lines.slice(2).filter((t) => t !== dates && t !== dur);
    const entry = {
      title: lines[0].slice(0, 90),
      company: (lines[1] || "").slice(0, 70) || null,
      dates: dates ? dates.slice(0, 60) : null,
      duration: dur,
      description: rest.join("\n").slice(0, 3000) || null,
    };
    if (entry.title && !out.some((e) => e.title === entry.title && e.company === entry.company)) {
      out.push(entry);
    }
    if (out.length >= max) break;
  }
  return out;
}

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Mar 2021" or "2019" -> an absolute month number. Null if there is no year. */
function monthOf(token) {
  const m = (token || "").match(/([A-Za-z]{3,})?\s*\b((?:19|20)\d{2})\b/);
  if (!m) return null;
  const mon = m[1] ? MONTH_INDEX[m[1].slice(0, 3).toLowerCase()] : 0;
  return +m[2] * 12 + (mon === undefined ? 0 : mon);
}

/** One role's date range as absolute months. "Present" ends today. */
function roleSpan(dates) {
  if (!dates) return null;
  const now = new Date();
  const today = now.getFullYear() * 12 + now.getMonth();
  // en dash, em dash, hyphen or the word "to" -- Sales Navigator uses several.
  const parts = String(dates).split(/\s(?:[–—-]|to)\s/i);
  const start = monthOf(parts[0]);
  if (start === null) return null;
  const tail = parts.slice(1).join(" ");
  const end = /present|current|now/i.test(tail) ? today : (monthOf(tail) ?? today);
  return { start, end: Math.max(start, end) };
}

/**
 * TOTAL career length: earliest role start to latest role end.
 *
 * This is the number the experience threshold is judged on, and it must be
 * the whole career -- not the current role. An earlier version summed every
 * "N yrs M mos" string on the page and took `Math.min(sum, span)`, which collapsed to
 * exactly the current role's tenure whenever the lazy history had not rendered: a
 * fifteen-year engineer four months into a new job read as four months of experience
 * and was rejected as junior.
 *
 * Taking the union of the date ranges is immune to that. Overlapping roles count once,
 * and a role whose dates did not parse is skipped rather than guessed at.
 */
function totalExperienceMonths(roles) {
  const spans = (roles || []).map((r) => roleSpan(r.dates)).filter(Boolean);
  if (!spans.length) return null;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  return Math.max(0, end - start);
}

/**
 * Total professional experience, in months, with the workings kept for diagnosis.
 *
 * Three readings, in order of trust:
 *
 *   ranges  union of every parsed role date range. The definition of total experience,
 *           and the one used whenever the history parsed at all.
 *   span    earliest year seen anywhere in the experience section, to now. A fallback
 *           for a page whose roles did not parse; wrong if an education date sneaks in.
 *   sum     every "N yrs M mos" added up. Double-counts overlaps and misses anything
 *           the page did not state, so it is reported but never used on its own.
 */
function experienceMonths() {
  // Only look below the experience heading: a "2015" in an About blurb is not a role.
  // Matched loosely ("Sarah's experience", "Experience (6)") because the exact heading
  // text varies, and a missed heading means no experience data at all.
  const heads = [...document.querySelectorAll("h1,h2,h3,h4")];
  const anchor = heads.find((h) => /experience/i.test((h.innerText || "").trim()));
  const scope = anchor
    ? (anchor.closest("section") || anchor.parentElement || document.body)
    : null;
  const scoped = scope ? (scope.innerText || "") : "";

  const roles = roleHistory(scope);
  const ranges = totalExperienceMonths(roles);

  const durations = [...scoped.matchAll(/(\d+)\s*yrs?(?:\s*(\d+)\s*mos?)?|(\d+)\s*mos?\b/gi)]
    .map((m) => m[1] ? +m[1] * 12 + (+m[2] || 0) : +m[3]);
  const sum = durations.reduce((a, b) => a + b, 0);

  const years = [...scoped.matchAll(/\b(19[7-9]\d|20[0-4]\d)\b/g)].map((m) => +m[1]);
  const earliest = years.length ? Math.min(...years) : null;
  const now = new Date();
  const span = earliest
    ? (now.getFullYear() - earliest) * 12 + now.getMonth()
    : 0;

  return { months: ranges || span || null, roles,
           text: scoped.slice(0, 20000) };
}

/**
 * The section under a heading matching `re`, or null. Headings vary ("Education (2)",
 * "Sarah's education"), so matched loosely, and the first match wins.
 */
function sectionUnder(re) {
  const head = [...document.querySelectorAll("h1,h2,h3,h4")]
    .find((h) => re.test((h.innerText || "").trim()));
  return head ? (head.closest("section") || head.parentElement) : null;
}

/** The innermost list items of a section, each as its non-empty lines. */
function entriesOf(scope, max = 12) {
  if (!scope) return [];
  const rows = [...scope.querySelectorAll("li")]
    .filter((li) => !li.querySelector("li") && shown(li));
  return rows.slice(0, max).map(linesOf).filter((lines) => lines.length);
}

/**
 * Education: one entry per school -- the school, the degree line, and the rest of the
 * entry kept as `detail` so a degree written further down is still found.
 */
function education() {
  const scope = sectionUnder(/education/i);
  const text = scope ? (scope.innerText || "").slice(0, 4000) : "";
  const entries = entriesOf(scope).map((lines) => ({
    school: lines[0].slice(0, 120),
    degree: (lines[1] || "").slice(0, 160) || null,
    detail: lines.slice(2).join(" ").slice(0, 300) || null,
  }));
  // A section that is not a list still names its schools and degrees: check its text
  // as one entry rather than finding nothing.
  if (!entries.length && text) entries.push({ school: text, degree: null, detail: null });
  return { entries, text };
}

/**
 * Volunteering: role, organisation, dates and description -- where speaking, teaching
 * and mentoring often turn up when they were never anyone's job.
 */
function volunteering() {
  const scope = sectionUnder(/volunteer/i);
  const entries = entriesOf(scope, 15).map((lines) => {
    const dates = lines.find((t) => /\b(19|20)\d{2}\b|present/i.test(t)) || null;
    return {
      role: lines[0].slice(0, 120),
      organization: (lines[1] || "").slice(0, 120) || null,
      dates: dates ? dates.slice(0, 60) : null,
      description: lines.slice(2).filter((t) => t !== dates).join("\n").slice(0, 2000) || null,
    };
  });
  return { entries, text: scope ? (scope.innerText || "").slice(0, 8000) : "" };
}

/** The About section, unfolded: the blurb element, or the section's own text if longer. */
function aboutText() {
  const blurb = textOf("person-blurb") || "";
  const scope = sectionUnder(/^about\b/i);
  const section = scope ? linesOf(scope).filter((t) => !/^about$/i.test(t)).join("\n") : "";
  const best = section.length > blurb.length ? section : blurb;
  return best.slice(0, 10000) || null;
}

/** Languages as listed, first line of each entry ("English" from "English\nNative"). */
function languages() {
  return entriesOf(sectionUnder(/^languages?\b/i), 20).map((lines) => lines[0].slice(0, 60));
}

function skillsText() {
  const scope = sectionUnder(/skills/i);
  return scope ? (scope.innerText || "").slice(0, 4000) : "";
}


/**
 * The public profile URL.
 *
 * A search result never carries this -- measured 0 of 25 cards -- but the lead page
 * links to it, so enrichment is the only chance to capture it. Stored as the full
 * public URL rather than the bare slug, because that is what a person wants to paste.
 */
function publicUrl() {
  // href first, then the embedded JSON. A probe found exactly one /in/ link on a lead
  // page and no publicIdentifier, but that was one profile on one day, and enrichment
  // has since produced zero slugs across 25 leads -- so try both and report what was
  // actually there rather than assuming either.
  for (const a of document.querySelectorAll('a[href*="/in/"]')) {
    const m = (a.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
    if (m) return "https://www.linkedin.com/in/" + decodeURIComponent(m[1]).toLowerCase();
  }
  const html = document.documentElement.innerHTML;
  const j = html.match(/"publicIdentifier"\s*:\s*"([^"]{2,60})"/);
  if (j) return "https://www.linkedin.com/in/" + j[1].toLowerCase();
  const loose = html.match(/linkedin\.com\\?\/in\\?\/([A-Za-z0-9._-]{3,60})/);
  return loose ? "https://www.linkedin.com/in/" + loose[1].toLowerCase() : null;
}


/**
 * The public profile URL, opening the overflow menu if the page does not volunteer it.
 *
 * Sales Navigator does not put the /in/ slug in the lead page: measured 0 anchors and
 * no publicIdentifier across 25 leads. It lives behind the "..." menu, as
 * "Copy LinkedIn.com URL", and the menu is rendered on demand -- so nothing in the DOM
 * has the slug until it is opened.
 *
 * Opening it is one click on a page already loaded. No extra page view, no navigation,
 * and the same thing a person does to get the link. The menu is closed again with
 * Escape, because leaving it open changes what the next read of this tab sees.
 *
 * The menu item copies via JavaScript rather than being a link, so three routes are
 * tried in order of directness: the ordinary page scan once the menu has rendered, then
 * the item's own attributes, then the surrounding markup.
 */
/**
 * Click "Copy LinkedIn.com URL" and read what it put on the clipboard.
 *
 * The menu item is not a link -- it copies with JavaScript -- so the only way to get
 * the value is to let it copy and then look. Two routes, because which one works
 * depends on how LinkedIn implements it: a `copy` event fires for execCommand-style
 * copies and carries the text directly, while navigator.clipboard.writeText() fires
 * nothing and has to be read back.
 *
 * The sentinel is the important part. Reading the clipboard blind cannot tell "the copy
 * failed" from "the clipboard still holds the PREVIOUS lead's URL" -- and that second
 * case would quietly file one person's profile under the next person enriched. Writing
 * a known value first makes a failed copy unmistakable.
 *
 * The clipboard is put back as it was found, since this runs on the user's own machine
 * and they did not ask for their clipboard to be emptied.
 */
async function copyUrlFromItem(item) {
  let fromEvent = null;
  const onCopy = (e) => {
    try {
      const t = e.clipboardData && e.clipboardData.getData("text/plain");
      if (t) fromEvent = t;
    } catch { /* some copies expose nothing to the handler */ }
  };
  document.addEventListener("copy", onCopy, true);

  const sentinel = "harvester-" + Date.now() + "-" +
                   Math.random().toString(36).slice(2);
  let previous = null;
  try { previous = await navigator.clipboard.readText(); } catch { /* no permission */ }
  try { await navigator.clipboard.writeText(sentinel); } catch { /* no permission */ }

  try { item.click(); } catch { /* detached */ }
  await new Promise((r) => setTimeout(r, 600));
  document.removeEventListener("copy", onCopy, true);

  let text = fromEvent;
  if (!text) {
    try { text = await navigator.clipboard.readText(); } catch { /* no permission */ }
  }
  if (text === sentinel) text = null;           // the click copied nothing

  if (previous !== null) {
    try { await navigator.clipboard.writeText(previous); } catch { /* best effort */ }
  }

  const m = (text || "").match(/linkedin\.com\/in\/([^/?#\s"']+)/i);
  return m ? "https://www.linkedin.com/in/" + decodeURIComponent(m[1]).toLowerCase()
           : null;
}

async function revealPublicUrl() {
  const direct = publicUrl();
  if (direct) return { url: direct, via: "page", menu_items: [] };

  const labelOf = (el) =>
    (el.getAttribute("aria-label") || el.innerText || "").trim().toLowerCase();

  // Rank the candidates rather than taking the first match. A lead page had EIGHT
  // elements matching "more/options/overflow" -- global navigation, each experience
  // entry, the messaging widget -- and clicking the first one opened a menu with no
  // profile link in it at all. The one that matters is the lead's own, next to their
  // name, so candidates inside the top card are tried first.
  const nameEl = document.querySelector('[data-anonymize="person-name"]');
  const card = nameEl ? (nameEl.closest("section,article,header") || nameEl.parentElement)
                      : null;
  const candidates = [...document.querySelectorAll('button,[role="button"]')]
    // Not the "Show more" folds: those unfold text (expandHidden, ten clicks at most),
    // and pressing them here would spend clicks that limit is there to save.
    .filter((b) => !FOLD.test(labelOf(b)))
    .filter((b) => /\b(more|options|actions|overflow)\b/.test(labelOf(b))
                   || /overflow/i.test(b.className || ""))
    .sort((a, b) => (card && card.contains(b) ? 1 : 0) - (card && card.contains(a) ? 1 : 0));

  if (!candidates.length) return { url: null, via: "no_menu_button", menu_items: [] };

  /** Text of every item in whatever menu is currently open. */
  const openMenuItems = () =>
    [...document.querySelectorAll(
      '[role="menuitem"],[role="menu"] li,[role="menu"] button,[role="menu"] a,' +
      '.artdeco-dropdown__content li,.artdeco-dropdown__content button')]
      .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);

  const closeMenu = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  };

  const seen = [];
  // Try a few, not just one. Opening a menu is cheap and local; guessing wrong once
  // should not cost the whole lead its URL.
  for (const trigger of candidates.slice(0, 4)) {
    try {
      trigger.click();
    } catch {
      continue;
    }
    await new Promise((r) => setTimeout(r, 650));

    const items = openMenuItems();
    for (const t of items) if (!seen.includes(t)) seen.push(t);

    // The menu may simply render the link now.
    let url = publicUrl();
    if (url) { await closeMenu(); return { url, via: "menu", menu_items: seen }; }

    const item = [...document.querySelectorAll('a,button,li,[role="menuitem"]')]
      .find((el) => /copy\s*linked\s*in(\.com)?\s*url/i.test(el.innerText || ""));
    if (item) {
      // The value is carried on whichever element does the copying, under a data-*
      // attribute whose name is not stable enough to hard-code.
      const scan = (el) => {
        if (!el || !el.getAttributeNames) return null;
        for (const name of el.getAttributeNames()) {
          const m = (el.getAttribute(name) || "").match(/\/in\/([^/?#"'\s]+)/);
          if (m) return m[1];
        }
        return null;
      };
      const slug = scan(item) || scan(item.parentElement)
                   || scan(item.closest("li,div"));
      if (slug) {
        await closeMenu();
        return {
          url: "https://www.linkedin.com/in/" + decodeURIComponent(slug).toLowerCase(),
          via: "menu_attr", menu_items: seen,
        };
      }
      // Nothing in the markup: actually press it and read the clipboard.
      const copied = await copyUrlFromItem(item);
      await closeMenu();
      return copied
        ? { url: copied, via: "menu_copy", menu_items: seen }
        : { url: null, via: "menu_copy_empty", menu_items: seen };
    }
    await closeMenu();
  }

  return {
    url: null,
    via: seen.length ? "menu_item_absent" : "menu_opened_empty",
    menu_items: seen,
  };
}

async function extract() {
  const problem = pageProblem();
  if (problem) return { ok: false, error: problem };

  const title = textOf("job-title");          // real title on THIS page type
  const headline = textOf("headline");
  const about = aboutText();
  const full_name = textOf("person-name");

  if (!rendered() && !title && !full_name) {
    return { ok: false,
             error: `not_rendered [chars=${(document.body?.innerText || "").length}]` };
  }

  // Everything the scorer reads, and nothing else. The location is read to judge
  // whether the page rendered and then discarded; the headshot is not read at all.
  const exp = experienceMonths();
  const edu = education();
  const vol = volunteering();
  const slug = await revealPublicUrl();
  return {
    ok: !!(title || headline || full_name),
    full_name,
    profile_url: slug.url,
    experience_months: exp.months,
    roles: exp.roles,                 // the history, for the disqualify-any-role rule
    title,
    // Prefer the richer headline; fall back to the About text so the scorer always has
    // the most role-bearing string available.
    headline: headline || (about ? about.slice(0, 300) : null),
    about,
    company: textOf("company-name"),
    experience_text: exp.text,        // descriptions too: where tech stacks are named
    education: edu.entries,
    education_text: edu.text,
    volunteering: vol.entries,
    volunteering_text: vol.text,
    languages: languages(),
    skills_text: skillsText(),
    error: null,
  };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== "READ_LEAD") return;
  (async () => {
    await waitForRender(msg.timeoutMs || 30000);
    if (msg.scroll !== false) {
      try { await revealLazyContent(4, msg.scrollPauseMs); } catch { /* best effort */ }
    }
    // After the scroll, so the lazy sections exist to be unfolded.
    try { await expandHidden(); } catch { /* best effort: read what is open */ }
    sendResponse(await extract());
  })();
  return true;      // keep the channel open for the async reply
});
