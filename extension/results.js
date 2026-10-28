/**
 * What a run produces: the qualified people, and a decision log naming everyone it saw.
 *
 * No database and no history -- the next run replaces both. The log is a trade: it is
 * the only thing that explains why a run returned 12 people out of 2,500, and it means
 * holding a name for everyone rejected rather than only for those who qualified.
 *
 * It lives in chrome.storage.local rather than in memory because MV3 kills idle service
 * workers, and a run that paused between pages would lose everything at the first one.
 */

import { profileUrl } from "./urls.js";
import { stamp } from "./history.js";

const KEY = "run";

const EMPTY = {
  startedAt: null,
  query: null,
  seen: [],          // lead ids, for dedupe across pages
  pending: [],       // captured, still to be enriched
  qualified: [],     // {url, name, title} -- the file
  log: [],           // {stage, name, url, verdict, reason, extracted} -- one per person
  counts: { captured: 0, skipped: 0, enriched: 0, failed: 0, yes: 0, no: 0 },
  finishedAt: null,
  stoppedBecause: null,
  captureComplete: false,   // the search's last page was captured
};

// --- pure: the parts worth testing ------------------------------------------------

/**
 * The public profile when enrichment captured one. Otherwise the lead's Sales Navigator
 * id as an ordinary linkedin.com/in/ link (urls.js), since a Sales Navigator link opens
 * only for someone with a Sales Navigator seat.
 */
export function urlFor(lead) {
  if (lead.profile_url) return lead.profile_url;
  const path = lead.lead_url || "";
  return profileUrl(path.startsWith("http") ? path : "https://www.linkedin.com" + path);
}

/** One URL per line, nothing else. A trailing newline so the file ends properly. */
export function buildTxt(qualified) {
  return qualified.map((q) => q.url).join("\n") + (qualified.length ? "\n" : "");
}

/** The filename: when the snapshot was taken. UTC, since the reader may be elsewhere. */
export function exportName(when = new Date(), prefix = "leads", ext = "txt") {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${prefix}-${when.getUTCFullYear()}-${p(when.getUTCMonth() + 1)}-` +
         `${p(when.getUTCDate())}_${p(when.getUTCHours())}${p(when.getUTCMinutes())}` +
         `${p(when.getUTCSeconds())}Z.${ext}`;
}

/**
 * One CSV field, quoted only when it has to be.
 *
 * Names contain commas ("Smith, Jr.") and reasons contain quotes. Getting this wrong
 * shifts every later column on the row -- corruption nobody notices until they are
 * reading the wrong person's verdict.
 */
function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The decision log as CSV: one row per person, in the order they were decided. */
export function buildLogCsv(log) {
  const rows = [["name", "verdict", "reason"]];
  for (const e of log) rows.push([e.name, e.verdict, e.reason]);
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/**
 * What was read from a lead page, kept for the log: the fields the decision used,
 * with the long free text cut short.
 */
export function extractedOf(data) {
  const cut = (v, n) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t ? (t.length > n ? t.slice(0, n) + "..." : t) : null;
  };
  return {
    title: cut(data.title, 200),
    company: cut(data.company, 200),
    headline: cut(data.headline, 300),
    experience_months: data.experience_months ?? null,
    roles: (data.roles || []).map((r) => ({
      title: cut(r.title, 120), company: cut(r.company, 120), dates: cut(r.dates, 60),
      description: cut(r.description, 1500),
    })),
    volunteering: (data.volunteering || []).map((v) => ({
      role: cut(v.role, 120), organization: cut(v.organization, 120),
      dates: cut(v.dates, 60), description: cut(v.description, 1000),
    })),
    education: (data.education || []).map((e) => ({
      school: cut(e.school, 160), degree: cut(e.degree, 160),
    })),
    languages: data.languages || [],
    skills: cut(data.skills_text, 400),
    about: cut(data.about, 3000),
  };
}

// --- run events -------------------------------------------------------------------
//
// Every start, stop, finish, pause, sleep and wake-up, with its reason -- kept across
// runs, unlike the per-person log, so "why did it stop?" can be answered afterwards.

const EVENTS = "runEvents";
const EVENTS_KEEP = 200;
let eventsTurn = Promise.resolve();

/** Record why the run did something. Never throws. */
export function noteEvent(message) {
  eventsTurn = eventsTurn.then(async () => {
    const { [EVENTS]: list } = await chrome.storage.local.get(EVENTS);
    const next = [...(list || []), { at: Date.now(), message }].slice(-EVENTS_KEEP);
    await chrome.storage.local.set({ [EVENTS]: next });
  }).catch(() => {});
  return eventsTurn;
}

export async function runEvents() {
  await eventsTurn;
  const { [EVENTS]: list } = await chrome.storage.local.get(EVENTS);
  return list || [];
}

/** The decision log as readable text: a header, the run events, then one block per person. */
export function buildLogTxt(run, events = []) {
  const c = run.counts;
  const when = (t) => (t ? `${stamp(t)} New York time` : "-");
  const out = [
    "LinkedIn Harvester - run log",
    `Search:   ${run.query || "-"}`,
    `Started:  ${when(run.startedAt)}`,
    `Finished: ${when(run.finishedAt)}${run.stoppedBecause ? ` (${run.stoppedBecause})` : ""}`,
    `Captured ${c.captured}, skipped on card ${c.skipped}, enriched ${c.enriched}, ` +
      `failed ${c.failed}, YES ${c.yes}, NO ${c.no}`,
    "",
    `Run events - starts, stops and the reason for each (New York time, last ${EVENTS_KEEP}, all runs):`,
    ...(events.length ? events.map((e) => `  ${stamp(e.at)}  ${e.message}`) : ["  (none yet)"]),
    "",
    `Below: the last ${run.log.length} people decided (at most ${LOG_KEEP} are kept).`,
    "",
  ];
  const line = (label, value) => {
    if (value !== null && value !== undefined && value !== "") {
      out.push(`    ${(label + ":").padEnd(12)}${value}`);
    }
  };
  run.log.forEach((e, i) => {
    out.push(`[${i + 1}] ${e.verdict}  ${e.name}`);
    line("URL", e.url);
    line("Stage", e.stage === "card" ? "search card (lead page not opened)"
                : e.stage === "lead" ? "lead page" : null);
    line(e.verdict === "YES" ? "Why yes" : e.verdict === "FAILED" ? "Error" : "Why no",
         e.reason);
    const x = e.extracted;
    if (x) {
      line("Title", x.title);
      line("Company", x.company);
      line("Headline", x.headline);
      line("Tenure", x.tenure);
      if (x.experience_months !== null && x.experience_months !== undefined) {
        line("Experience", `${(x.experience_months / 12).toFixed(1)} years`);
      }
      if (x.roles && x.roles.length) {
        out.push("    Roles:");
        for (const r of x.roles) {
          out.push(`      - ${r.title || "?"}${r.company ? " @ " + r.company : ""}` +
                   `${r.dates ? " (" + r.dates + ")" : ""}`);
          if (r.description) out.push(`          ${r.description}`);
        }
      }
      if (x.volunteering && x.volunteering.length) {
        out.push("    Volunteering:");
        for (const v of x.volunteering) {
          out.push(`      - ${v.role || "?"}${v.organization ? " @ " + v.organization : ""}` +
                   `${v.dates ? " (" + v.dates + ")" : ""}`);
          if (v.description) out.push(`          ${v.description}`);
        }
      }
      if (x.education && x.education.length) {
        out.push("    Education:");
        for (const ed of x.education) {
          out.push(`      - ${ed.school || "?"}${ed.degree ? " - " + ed.degree : ""}`);
        }
      }
      if (x.languages && x.languages.length) line("Languages", x.languages.join(", "));
      line("Skills", x.skills);
      line("About", x.about);
    }
    out.push("");
  });
  return out.join("\n");
}

/** A one-line summary for the popup. */
export function summarize(run) {
  const c = run.counts;
  return `${c.yes} qualified of ${c.captured} captured` +
         (c.skipped ? `, ${c.skipped} skipped on the card` : "") +
         (c.failed ? `, ${c.failed} failed` : "");
}

// --- stored: the run itself --------------------------------------------------------

export async function getRun() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...EMPTY, ...(stored[KEY] || {}) };
}

async function putRun(run) {
  await chrome.storage.local.set({ [KEY]: run });
  return run;
}

/** Begin a run, discarding whatever the last one produced. */
export async function startRun(query) {
  return putRun({ ...EMPTY, startedAt: Date.now(), query: query || null,
                  counts: { ...EMPTY.counts } });
}

export async function clearRun() {
  await chrome.storage.local.remove(KEY);
}

/**
 * Record a page's worth of cards.
 *
 * A lead the screen rejects is counted and dropped rather than queued -- that saved
 * page load is what screening is for. Duplicates across pages are ignored: Sales
 * Navigator repeats people when the result set shifts under you.
 */
export async function addCaptured(leads, screen) {
  const run = await getRun();
  const seen = new Set(run.seen);
  let added = 0, skipped = 0;

  for (const lead of leads) {
    if (!lead || !lead.lead_id || seen.has(lead.lead_id)) continue;
    seen.add(lead.lead_id);
    run.counts.captured += 1;
    added += 1;
    const rejected = screen && screen(lead);
    if (rejected) {
      run.counts.skipped += 1;
      run.counts.no += 1;
      skipped += 1;
      run.log.push({
        stage: "card",
        name: lead.full_name || "(no name)",
        url: urlFor(lead),
        verdict: "NO",
        // A boolean screen cannot say why; a screen that returns a verdict can.
        reason: (rejected.reasons && rejected.reasons[0]) || "rejected from the search card",
        extracted: { title: lead.title || null, company: lead.company || null,
                     headline: lead.headline || null, tenure: lead.tenure_text || null },
      });
      continue;
    }
    run.pending.push(lead);
  }

  trimLog(run);
  run.seen = [...seen];
  await putRun(run);
  return { added, skipped, pending: run.pending.length };
}

/**
 * The next batch to work on, left on the queue until each one is recorded.
 *
 * Handing a batch out used to remove it, which put everyone in it between two stools:
 * no longer waiting, not yet enriched. The popup showed "Waiting 0" with two dozen
 * people still to visit, and the counts did not add up until the batch happened to
 * finish. Leaving them queued until recordResult takes them off is what makes
 *
 *     captured = skipped + enriched + failed + waiting
 *
 * true at every moment rather than only at the end. It also means a worker killed
 * mid-batch leaves its leads queued instead of dropping them.
 */
export async function takePending(n) {
  const run = await getRun();
  return run.pending.slice(0, n);
}

/**
 * The log keeps the last LOG_KEEP people and lets the rest go. The counts in the header
 * still cover the whole run; the log is for reading the most recent decisions.
 */
const LOG_KEEP = 50;

function trimLog(run) {
  if (run.log.length > LOG_KEEP) run.log.splice(0, run.log.length - LOG_KEEP);
}

/** Record one enrichment outcome, and take the lead off the queue. */
export async function recordResult(lead, data, verdict, reason = "") {
  const run = await getRun();
  // Off the queue only now that there is an outcome to put against it.
  run.pending = run.pending.filter((p) => p.lead_id !== lead.lead_id);
  const named = data?.full_name || lead.full_name || "(no name)";
  if (!data || !data.ok) {
    run.counts.failed += 1;
    // Not a verdict: the rules never got to see this person. Conflating it with a
    // rejection is what makes a log useless for telling a bad persona from a bad run.
    run.log.push({ stage: "lead", name: named, url: urlFor(lead), verdict: "FAILED",
                   reason: data?.error || "the lead page could not be read" });
    trimLog(run);
    return putRun(run);
  }
  run.counts.enriched += 1;
  run.log.push({ stage: "lead", name: named, url: urlFor({ ...lead, ...data }), verdict,
                 reason, extracted: extractedOf(data) });
  trimLog(run);
  if (verdict === "YES") {
    run.counts.yes += 1;
    run.qualified.push({
      url: urlFor({ ...lead, ...data }),
      name: data.full_name || lead.full_name || null,
      title: data.title || lead.title || null,
    });
  } else {
    run.counts.no += 1;
  }
  return putRun(run);
}

export async function markCaptureComplete() {
  const run = await getRun();
  run.captureComplete = true;
  return putRun(run);
}

export async function finishRun(reason) {
  const run = await getRun();
  run.finishedAt = Date.now();
  run.stoppedBecause = reason || null;
  return putRun(run);
}

/**
 * download.txt: the leads added since the last download (history.js keeps the list).
 * A data: URL is fine here -- this list is short, unlike the log.
 */
export async function downloadTxt(list = []) {
  if (!list.length) return { ok: false, error: "nothing new since the last download" };
  return handOver(buildTxt(list), "text/plain", "download.txt", list.length);
}

/**
 * The decision log as text, for the popup to save. Handed over as text rather than
 * downloaded here: a data: URL is the only way a service worker can download, and
 * Chrome refuses one past a couple of megabytes -- which a long run's log passes.
 */
export async function logText() {
  const run = await getRun();
  if (!run.log.length && !(await runEvents()).length) return { ok: false, error: "nothing decided yet" };
  return { ok: true, text: buildLogTxt(run, await runEvents()), count: run.log.length };
}

/**
 * A data: URL rather than a Blob: MV3 service workers have no URL.createObjectURL, and
 * these files are small enough that it does not matter.
 */
async function handOver(text, mime, filename, count) {
  const url = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  const id = await chrome.downloads.download({ url, filename, saveAs: false });
  return { ok: true, id, filename, count };
}
