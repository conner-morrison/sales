/**
 * "1 year 1 month in role 1 year 1 month in company" -> months.
 *
 * The string comes from a search card's `job-title` attribute, which on a card holds
 * the tenure line rather than the job -- see the note above readCard in capture.js.
 */

// Shapes without one half, or with only months, or only years, all have to parse.
const TENURE_RE = /(?:(\d+)\s*years?)?\s*(?:(\d+)\s*months?)?\s*in\s+(role|company)/gi;

/**
 * Returns { role, company } in months; either may be null.
 *
 * A match that carried neither a year nor a month count is skipped rather than
 * recorded as zero -- "in role" on its own says nothing about how long.
 */
export function parseTenure(text) {
  const out = { role: null, company: null };
  if (!text) return out;
  for (const m of String(text).matchAll(TENURE_RE)) {
    const [, years, months, which] = m;
    if (!years && !months) continue;
    out[which.toLowerCase()] = Number(years || 0) * 12 + Number(months || 0);
  }
  return out;
}
