import { NAMES } from "./names.js";
import { firstName, lastName } from "./relay.js";

/**
 * Your own filter, run once per captured lead, before any lead page is opened.
 *
 * Return true to open this person's lead page, false to reject them now. rules.js has
 * already had its turn, so this only sees cards it could not decide.
 *
 * `lead` carries search-card fields only -- no lead page has been opened yet:
 *
 *     lead_id                "ACwAAB..."          the Sales Navigator id
 *     lead_url               "/sales/lead/..."    a path, not absolute
 *     full_name              "Ada Lovelace"       may be null
 *     title                  "Senior Engineer"    may be null
 *     company                "Acme Corp"          may be null
 *     headline               the card blurb       may be null
 *     tenure_text            "4 years 2 months in role"   may be null
 *     tenure_months          50                   time in the CURRENT role, may be null
 *     company_tenure_months  50                   time at the company, may be null
 *
 * Not here, because a card does not carry them: total career length and the employment
 * history, both checked after enrichment. `tenure_months` is time in the current role,
 * not a career length -- reading it as one rejects everyone who recently changed job.
 *
 * A card is thinner than a lead page, so a false costs that person their only chance of
 * qualifying; there is no second look. It fails open: an exception is reported once in
 * the popup and the lead is enriched anyway, because a bug in a filter should cost a
 * page load rather than silently drop people.
 */

export function shouldEnrich(lead) {
  if (!GROUPS) throw new Error("group.md was not loaded");
  // A is the first name, B the last name, as the relay extracts them.
  const a = firstName(lead.full_name);
  const b = lastName(lead.full_name);
  // LinkedIn last names are not always usable. When B is not, A alone decides: in
  // Group 1's first names it passes, otherwise it does not.
  const { group1, group2 } = GROUPS;
  if (!properLastName(b)) return inList(group1.first, a);
  // Both usable: A picks the group, and B must be in the last names that group allows.
  if (inList(group1.first, a)) return inSurnames(group1.last, b) || inSurnames(group2.last, b);
  if (inList(group2.first, a)) return inSurnames(group1.last, b);
  return false;
}

/** B as written ("De Luca") or, without its particles, its last word ("de la Cruz" is Cruz). */
function inSurnames(set, b) {
  return inList(set, b) || inList(set, b.split(" ").pop());
}

/**
 * Whether B came out as a usable last name. Not when there is none ("Madonna"), when
 * it is only an initial ("John S."), or when it carries anything but letters and the
 * marks names use -- digits, emoji, "|", which is what a headline pasted into the name
 * field leaves behind.
 */
function properLastName(b) {
  if (!b) return false;
  if (!/^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u.test(b)) return false;
  return b.replace(/[^\p{L}]/gu, "").length >= 2;
}

function inList(set, name) {
  return !!name && variants(name).some((v) => set.has(v));
}

// --- group.md -----------------------------------------------------------------------

/**
 * The name lists in group.md, read at the start of each run so an edit to the file
 * counts from the next run on. Kept as normalized forms, matched the way matchedName
 * matches: "José" is "Jose", "O'Brien" is "OBrien".
 *
 *     { group1: { first: Set, last: Set }, group2: { first: Set, last: Set } }
 */
let GROUPS = null;

export async function loadGroups() {
  const res = await fetch(chrome.runtime.getURL("group.md"), { cache: "no-store" });
  if (!res.ok) throw new Error(`group.md: HTTP ${res.status}`);
  GROUPS = parseGroups(await res.text());
  return GROUPS;
}

/**
 * "# Group N" opens a group, "## First Names" / "## Last Names" a list within it. Any
 * other line inside a list holds names separated by commas, after an optional label
 * ("**A:**", "**Male:**"); headings and blank lines in between are skipped.
 */
export function parseGroups(md) {
  const groups = {};
  let group = null;
  let list = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const g = /^#\s+group\s*(\d+)/i.exec(line);
    if (g) {
      group = groups[`group${g[1]}`] = { first: new Set(), last: new Set() };
      list = null;
      continue;
    }
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      list = /first/i.test(line) ? "first" : /last/i.test(line) ? "last" : null;
      continue;
    }
    if (!group || !list || !line || line.startsWith("#")) continue;
    for (const name of line.replace(/^\*\*[^*]*\*\*/, "").split(",")) {
      for (const v of variants(name)) if (v) group[list].add(v);
    }
  }
  if (!groups.group1) throw new Error("group.md has no \"# Group 1\" section");
  for (const k of ["group1", "group2"]) groups[k] ||= { first: new Set(), last: new Set() };
  return groups;
}

// --- name matching ----------------------------------------------------------------

/**
 * The comparable forms of a name: no accents, lower case, single-spaced.
 *
 * Two of them, because punctuation is written inconsistently. Splitting on it gives
 * "o brien"; dropping it gives "obrien". Entries and people are both indexed under
 * both, so "O'Brien" catches "OBrien" and "Mary-Jane" catches "Mary Jane".
 */
function variants(value) {
  const base = String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // accents
    .toLowerCase();
  const spaced = base.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const joined = base.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return spaced === joined ? [spaced] : [spaced, joined];
}

/**
 * The list, prepared once at load rather than per lead.
 *
 * A Set, so ten entries and ten thousand cost the same.
 */
const INDEX = (() => {
  const words = new Map();      // normalized form -> the entry as written
  for (const entry of NAMES) {
    for (const text of variants(entry)) {
      if (text && !words.has(text)) words.set(text, entry);
    }
  }
  return words;
})();

/**
 * The list entry this person's FIRST name matches, or null.
 *
 * The first word only, because the list is first names. Checking every word instead
 * would exclude Mohammed Ali for a list containing "Ali" -- a different person entirely
 * from the ones that entry is about, and one who gets no second look.
 *
 * Returns the entry rather than a boolean so a caller can say which name matched; the
 * difference between "excluded" and "excluded because of X" is most of the value when a
 * list starts rejecting more than you expected.
 */
export function matchedName(fullName) {
  for (const text of variants(fullName)) {
    if (!text) continue;                                  // no name, nothing to match
    const first = text.split(" ")[0];
    const hit = INDEX.get(first);
    if (hit) return hit;
  }
  return null;
}

/**
 * Run the filter without letting it break a run. You should not need to touch this: a
 * throw is a bug in shouldEnrich, and the honest response is to enrich anyway.
 */
export function safeShouldEnrich(lead, fn = shouldEnrich) {
  try {
    // Only an explicit false rejects. A filter that forgets to return, or returns
    // undefined down one branch, must not quietly drop everyone it touches.
    return { enrich: fn(lead) !== false, error: null };
  } catch (e) {
    return { enrich: true, error: String((e && e.message) || e) };
  }
}
