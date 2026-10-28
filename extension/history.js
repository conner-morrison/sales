/**
 * The history: every lead that ever qualified, across every run, one entry per result
 * URL. Never cleared -- a new run, Clear results and downloads all leave it alone.
 *
 * It is what keeps the download list free of repeats: with sending to the server off,
 * a lead whose URL is already here is not added to the download again. With sending
 * on there is no check; the lead goes to the server and is recorded here regardless.
 *
 * Alongside it, the download list: the leads added since the last download. A download
 * empties it, so each download.txt holds only what is new since the one before.
 */

const HISTORY = "history";
const DOWNLOADS = "downloadList";

// The run loop records leads while the sender and the popup's download mark them;
// both rewrite the same stored object, so they take turns.
let turn = Promise.resolve();
function withStore(key, empty, change) {
  const next = turn.then(async () => {
    const stored = await chrome.storage.local.get(key);
    const value = stored[key] ?? empty;
    const updated = change(value);
    if (updated !== null && updated !== undefined) {
      await chrome.storage.local.set({ [key]: updated });
      return updated;
    }
    return value;
  });
  turn = next.catch(() => {});
  return next;
}

// New York time, like the working hours. sv-SE formats as "2026-10-13 14:02".
const stamp = (t = Date.now()) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
}).format(t);

/** The history entry for this URL, or null. */
export async function historyEntry(url) {
  const h = await withStore(HISTORY, {}, () => null);
  return h[url] || null;
}

/**
 * Record a qualified lead. A first sighting adds an entry; a repeat only counts it and
 * notes when, so the history holds each person once.
 */
export async function recordLead({ url, name, title }) {
  return withStore(HISTORY, {}, (h) => {
    const now = Date.now();
    const e = h[url];
    h[url] = e
      ? { ...e, times: (e.times || 1) + 1, last: now }
      : { url, name: name || null, title: title || null, first: now, last: now,
          times: 1, sentAt: null, downloadedAt: null };
    return h;
  });
}

export async function markSentInHistory(url) {
  return withStore(HISTORY, {}, (h) => {
    if (!h[url] || h[url].sentAt) return null;
    h[url] = { ...h[url], sentAt: Date.now() };
    return h;
  });
}

async function markDownloaded(urls) {
  return withStore(HISTORY, {}, (h) => {
    const now = Date.now();
    for (const u of urls) if (h[u]) h[u] = { ...h[u], downloadedAt: now };
    return h;
  });
}

// --- the download list --------------------------------------------------------------

export async function downloadList() {
  return withStore(DOWNLOADS, [], () => null);
}

export async function addToDownload({ url, name, title }) {
  return withStore(DOWNLOADS, [], (list) =>
    list.some((l) => l.url === url) ? null : [...list, { url, name: name || null, title: title || null }]);
}

/**
 * After a download.txt was saved: take its leads off the list and note the date in the
 * history. Only those leads -- anything added while the file was being saved stays.
 */
export async function downloaded(urls) {
  const gone = new Set(urls);
  await withStore(DOWNLOADS, [], (list) => list.filter((l) => !gone.has(l.url)));
  await markDownloaded(urls);
}

// --- first start ------------------------------------------------------------------

/**
 * First start after the history was added: fill it from what is already known -- the
 * current run's qualified leads and anything waiting in the outbox -- so the duplicate
 * check has a past to check against. Runs once.
 */
export async function seedHistory(leads, sent) {
  const stored = await chrome.storage.local.get(HISTORY);
  if (stored[HISTORY]) return;
  await withStore(HISTORY, {}, (h) => {
    const now = Date.now();
    for (const l of leads) {
      if (!l || !l.url || h[l.url]) continue;
      h[l.url] = { url: l.url, name: l.name || null, title: l.title || null,
                   first: l.at || now, last: l.at || now, times: 1,
                   sentAt: sent.has(l.url) ? now : null, downloadedAt: null };
    }
    return h;
  });
}

// --- history.txt ------------------------------------------------------------------

/** history.txt: one line per lead, oldest first, with where it went. */
export async function historyText() {
  const h = await withStore(HISTORY, {}, () => null);
  const entries = Object.values(h).sort((a, b) => a.first - b.first);
  if (!entries.length) return { ok: false, error: "the history is empty" };
  const lines = [
    "LinkedIn Harvester - history of every qualified lead",
    `${entries.length} lead(s). Found | name | title | URL | where it went (New York time)`,
    "",
  ];
  for (const e of entries) {
    const went = [e.sentAt ? `sent ${stamp(e.sentAt)}` : null,
                  e.downloadedAt ? `downloaded ${stamp(e.downloadedAt)}` : null]
      .filter(Boolean).join(", ") || "waiting";
    const again = e.times > 1 ? ` | found ${e.times} times, last ${stamp(e.last)}` : "";
    lines.push(`${stamp(e.first)} | ${e.name || "(no name)"} | ${e.title || "-"} | ` +
               `${e.url} | ${went}${again}`);
  }
  return { ok: true, text: lines.join("\n") + "\n", count: entries.length };
}

export { stamp };
