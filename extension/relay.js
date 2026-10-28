/**
 * The relay: where the qualified list goes instead of a file.
 *
 * The extension is a "worker" in the relay's /upwork workspace. It cannot invent its
 * own credential -- the id it speaks with is the server's to give -- so joining is a
 * request a person answers in the relay console:
 *
 *     POST /upwork/enrol            {name, label}   -> a ticket
 *     GET  /upwork/enrol/{ticket}?wait=N            -> held open until approved, then
 *                                                      the worker_id
 *     GET  /upwork/messages         Bearer worker_id -> what this worker's channels hold
 *     POST /upwork/publish          Bearer worker_id {channel, body, id}
 *
 * Leads go one per message, {first_name, url}, as each one qualifies -- once automatic
 * sending has been switched on from the popup.
 *
 * Approval alone is not enough to send. The id says who this is; a channel says where
 * its words go, and that is a second decision made in the console. The server sends a
 * notification when it allocates one; until then, sending is refused here with a
 * warning rather than tried and lost.
 *
 * The relay cannot call the extension -- it has no address -- so the extension asks.
 * The approval wait is a long poll, re-armed by an alarm because MV3 kills idle workers
 * and the loop with them.
 */

import { profileUrl } from "./urls.js";

export const RELAY_BASE = "https://relay-production-7643.up.railway.app/upwork";

const KEY = "relay";
const ALARM = "relay-check";
// Under MV3's ~30s idle limit, so a held-open request never outlives the worker.
const WAIT_S = 25;

const EMPTY = {
  status: "none",      // 'none' | 'pending' | 'approved' | 'rejected'
  ticket: null,
  fingerprint: null,   // what the console shows beside the request, to match them up
  workerId: null,
  channel: null,       // the channel this worker was allocated, once there is one
  auto: false,         // send each qualified lead the moment it is found
  error: null,
};

export async function getRelay() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...EMPTY, ...(stored[KEY] || {}) };
}

async function putRelay(patch) {
  const next = { ...(await getRelay()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(RELAY_BASE + path, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, data: null, error: "cannot reach the relay server" };
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  const detail = data && (typeof data.detail === "string" ? data.detail : data.message);
  return { status: res.status, data, error: res.ok ? null : (detail || `HTTP ${res.status}`) };
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic", iconUrl: "icons/icon-128.png", title, message,
    });
  } catch { /* notifications are a courtesy */ }
}

// --- registration -----------------------------------------------------------------

// The name this copy registers under. "LinkedIn Harvester" is what the extension is;
// this is which one it is, so the console can tell several apart.
const NAME = "workerName";
const DEFAULT_NAME = "LinkedIn Harvester";

export async function getName() {
  const stored = await chrome.storage.local.get(NAME);
  return String(stored[NAME] || "").trim() || DEFAULT_NAME;
}

export async function setName(name) {
  await chrome.storage.local.set({ [NAME]: String(name || "").trim() });
}

/** Ask to join. Starting over is allowed: a rejected or stale request is replaced. */
export async function register() {
  const r = await getRelay();
  if (r.status === "approved") return { ok: false, error: "already registered" };
  if (r.status === "pending" && r.ticket) {
    pollApproval();
    return { ok: true, relay: r };
  }

  const name = await getName();
  const label = `extension v${chrome.runtime.getManifest().version}`;
  const res = await call("POST", "/enrol", { body: { name, label } });
  const ticket = res.data && (res.data.ticket || res.data.ref);
  if (res.error || !ticket) {
    const relay = await putRelay({ error: res.error || "the server gave no ticket" });
    return { ok: false, error: relay.error, relay };
  }
  const relay = await putRelay({
    ...EMPTY, status: "pending", ticket,
    fingerprint: res.data.fingerprint || null,
  });
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  pollApproval();
  return { ok: true, relay };
}

/** Forget the registration on this side, so Register can start again. */
export async function resetRelay() {
  await chrome.storage.local.set({ [KEY]: { ...EMPTY } });
  await chrome.alarms.clear(ALARM);
  return { ok: true, relay: { ...EMPTY } };
}

let polling = false;

/**
 * Wait for a person to answer the request. One loop at a time; the alarm restarts it
 * if the worker was killed in the middle.
 */
export async function pollApproval() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const r = await getRelay();
      if (r.status !== "pending" || !r.ticket) return;

      const res = await call("GET", `/enrol/${encodeURIComponent(r.ticket)}?wait=${WAIT_S}`);
      if (res.status === 404) {
        // Declined in the console, or expired: the ticket is gone.
        await putRelay({ ...EMPTY, error: "the registration request was declined or expired - register again" });
        return;
      }
      if (res.error) {
        await putRelay({ error: res.error });
        return;                                   // the alarm tries again in a minute
      }

      const d = res.data || {};
      const status = String(d.status || "").toLowerCase();
      if (d.worker_id) {
        await putRelay({ status: "approved", workerId: d.worker_id, error: null });
        notify("Relay: registered",
               "The server approved this extension. Waiting for a channel to be allocated.");
        listenForChannel();
        return;
      }
      if (/reject|refus|denied|declin/.test(status)) {
        await putRelay({ ...EMPTY, status: "rejected", error: "the server refused the request" });
        notify("Relay: refused", "The server refused this extension's registration.");
        await chrome.alarms.clear(ALARM);
        return;
      }
      if (d.fingerprint && d.fingerprint !== r.fingerprint) {
        await putRelay({ fingerprint: d.fingerprint });
      }
      await putRelay({ error: null });
      // Still pending: ask again straight away; the wait above is the pacing.
    }
  } finally {
    polling = false;
  }
}

// --- channel ----------------------------------------------------------------------

/**
 * The channel the server's notices leave this worker in. /messages carries them beside
 * the messages: {kind: "joined" | "left", channel}, one per change, in order. Each is
 * handed over once and then deleted on the server, so one that is not acted on here is
 * gone for good.
 */
function channelAfter(notices, current) {
  let channel = current;
  for (const n of notices || []) {
    if (!n || typeof n.channel !== "string") continue;
    if (n.kind === "joined") channel = n.channel;
    else if (n.kind === "left" && n.channel === channel) channel = null;
  }
  return channel;
}

let listening = false;

/**
 * Wait for the server's notice that this worker was added to a channel. The server
 * cannot call the extension, so the notice is collected the same way approval is: a
 * request held open on /messages until something arrives. One loop at a time; the alarm
 * restarts it if the worker was killed in the middle.
 */
export async function listenForChannel() {
  if (listening) return;
  listening = true;
  try {
    for (;;) {
      const r = await getRelay();
      if (r.status !== "approved" || !r.workerId || r.channel) return;

      const res = await call("GET", `/messages?wait=${WAIT_S}`, { token: r.workerId });
      if (res.status === 401) {
        // The id was revoked or reissued in the console. It is no longer this worker.
        await chrome.alarms.clear(ALARM);
        await putRelay({ ...EMPTY, error: "the server no longer accepts this extension's id - register again" });
        return;
      }
      if (res.error) {
        await putRelay({ error: res.error });
        return;                                   // the alarm tries again in a minute
      }

      // Channel messages are not this extension's business, but unacknowledged ones
      // come back on every ask; acknowledge them so they stop.
      for (const m of res.data?.messages || []) {
        if (m && typeof m.channel === "string" && Number.isInteger(m.seq)) {
          await call("POST", "/ack", { token: r.workerId, body: { channel: m.channel, seq: m.seq } });
        }
      }

      const channel = channelAfter(res.data?.notices, null);
      if (channel) {
        await putRelay({ channel, error: null });
        await chrome.alarms.clear(ALARM);
        notify("Relay: channel allocated", `This extension now sends to "${channel}".`);
        return;
      }
    }
  } finally {
    listening = false;
  }
}

// --- sending ----------------------------------------------------------------------

/**
 * Whether there is somewhere to send to. Returns null when there is, or the warning to
 * show -- a lead sent without a channel would go nowhere, so it is refused here instead.
 */
export async function sendBlocker() {
  const r = await getRelay();
  if (r.status !== "approved" || !r.workerId) {
    return r.status === "pending"
      ? "Not sending: the registration is still waiting for approval on the server"
      : "Not sending: this extension is not registered - press Register first";
  }
  if (!r.channel) return "Not sending: the server has not allocated a channel to this extension yet";
  return null;
}

/** The first word of a name, or null. */
export function firstName(fullName) {
  const first = String(fullName ?? "").trim().split(/\s+/)[0];
  return first || null;
}

/**
 * Send one lead: its first name and URL, as one message.
 *
 * `warning` marks a refusal that retrying will not fix -- no registration, no channel --
 * which is what turns automatic sending off. Anything else is worth trying again.
 */
export async function sendLead(lead) {
  const blocked = await sendBlocker();
  if (blocked) return { ok: false, warning: true, error: blocked };
  const r = await getRelay();
  // Leads queued before Sales Navigator links were converted still carry one.
  const url = profileUrl(lead.url);

  const res = await call("POST", "/publish", {
    token: r.workerId,
    // The URL as the id: the same person sent twice is one message, not two.
    body: { channel: r.channel, body: { first_name: firstName(lead.name), url },
            id: url },
  });
  if (res.status === 401) {
    await putRelay({ ...EMPTY, error: "the server no longer accepts this extension's id - register again" });
    return { ok: false, warning: true,
             error: "Not sending: the server no longer recognises this extension - register again" };
  }
  if (res.status === 403 || res.status === 404) {
    // Taken out of the channel: wait for the server to allocate one again.
    await putRelay({ channel: null });
    chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    listenForChannel();
    return { ok: false, warning: true,
             error: `Not sending: this extension is no longer in channel "${r.channel}"` };
  }
  // 409: the same id again -- the relay already has this person.
  if (res.error && res.status !== 409) return { ok: false, error: res.error };
  if (r.error) await putRelay({ error: null });     // whatever went wrong before, this went
  return { ok: true, channel: r.channel };
}

// --- what has gone ------------------------------------------------------------------

// Kept apart from the run record: sending runs alongside the run loop, and two writers
// of one stored object lose each other's updates.
const SENT = "relaySent";

export async function sentUrls() {
  const stored = await chrome.storage.local.get(SENT);
  return new Set(stored[SENT] || []);
}

export async function markSent(url) {
  const sent = await sentUrls();
  sent.add(url);
  await chrome.storage.local.set({ [SENT]: [...sent] });
}

// --- the outbox ---------------------------------------------------------------------
//
// Every qualified lead the server has not accepted yet, across runs: queued when it
// qualifies, removed only once the server takes it. Sending switched off, no channel,
// a network failure -- whatever kept a lead back, it waits here, and it is what the
// .txt download holds. A new run does not clear it.

const OUTBOX = "relayOutbox";

// The run loop adds while the sender removes. Both read and rewrite the one stored
// list, so they take turns: without this, one would overwrite the other's change.
let outboxTurn = Promise.resolve();
function withOutbox(change) {
  const next = outboxTurn.then(async () => {
    const stored = await chrome.storage.local.get(OUTBOX);
    const list = stored[OUTBOX] || [];
    const updated = change(list);
    if (updated) await chrome.storage.local.set({ [OUTBOX]: updated });
    return updated || list;
  });
  outboxTurn = next.catch(() => {});
  return next;
}

export async function outbox() {
  return withOutbox(() => null);
}

/** Queue a lead for the server, unless it is already queued or already sent. */
export async function addToOutbox(lead, sent = null) {
  const done = sent || await sentUrls();
  return withOutbox((list) =>
    done.has(lead.url) || list.some((l) => l.url === lead.url)
      ? null
      : [...list, { url: lead.url, name: lead.name || null, title: lead.title || null,
                    at: Date.now() }]);
}

export async function removeFromOutbox(url) {
  return withOutbox((list) => list.filter((l) => l.url !== url));
}

/**
 * First start after this was added: the leads that qualified earlier and never went
 * out are in the current run only. Queue them once, so they are not left behind.
 */
export async function seedOutbox(qualified) {
  const stored = await chrome.storage.local.get(OUTBOX);
  if (stored[OUTBOX]) return;
  const sent = await sentUrls();
  await withOutbox(() => []);
  for (const q of qualified) await addToOutbox(q, sent);
}

/** Say why sending stopped, where the popup will show it. */
export async function noteError(error) {
  await putRelay({ error });
}

// --- automatic sending --------------------------------------------------------------

export async function isAuto() {
  return !!(await getRelay()).auto;
}

/** Turn automatic sending on, unless there is nowhere to send to. */
export async function setAuto(on) {
  if (on) {
    const blocked = await sendBlocker();
    if (blocked) return { ok: false, warning: true, error: blocked };
  }
  await putRelay({ auto: !!on });
  return { ok: true, auto: !!on };
}

// --- waking up ----------------------------------------------------------------------

/** Resume whatever was in progress when this worker last died. */
export async function resumeRelay() {
  const r = await getRelay();
  if (r.status === "pending") pollApproval();
  else if (r.status === "approved" && !r.channel) listenForChannel();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) resumeRelay();
});
