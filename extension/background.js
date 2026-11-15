/**
 * Service worker: drives the two stages against the client's logged-in session.
 *
 *   CAPTURE  walks a Sales Navigator search result set. Reads cards, clicks the real
 *            Next button, scores each card. ~1 page load per 25 leads.
 *   ENRICH   opens each lead page that survived the card screen, reads the full
 *            profile, scores it. 1 page load per person -- the expensive, exposed stage.
 *
 * Scoring is keyword rules (qualify.js) and the run's results live in
 * chrome.storage.local (results.js). The deliverable is each qualified lead's first name
 * and URL, sent to the relay server (relay.js) one at a time as they are found when
 * sending is on, and downloadable as a .txt either way. Nothing is kept between runs:
 * the next Start replaces the last result set.
 *
 * Two rules matter more than anything else here:
 *
 *   1. Consecutive failures stop the run. In August an earlier version recorded the
 *      error and carried on: 2,168 attempts against 1,985 failures, hours of requests
 *      into a login wall. That pattern is far more visible than the reading it was
 *      attempting, so the breaker is not optional and not user-tunable downward here.
 *   2. Capture is cheap and enrichment is not. Every card the screen can reject is a
 *      lead page not opened on the client's account, so the screen runs first.
 *
 * MV3 kills idle service workers, so no state lives in memory -- everything that must
 * survive a restart is in chrome.storage, and every loop is re-entrant.
 */

import { classify, screenCard, verdictOf } from "./qualify.js";
import { parseTenure } from "./tenure.js";
import { safeShouldEnrich, loadGroups, groupThreeSchool } from "./prefilter.js";
import { DEFAULT_RULES } from "./rules.js";
import { loadConfig } from "./config.js";
import * as results from "./results.js";
import * as relay from "./relay.js";
import { notifyTelegram, finishedMessage, stoppedMessage, getTelegram, setTelegram }
  from "./telegram.js";
import * as history from "./history.js";

const VERSION = chrome.runtime.getManifest().version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo));

async function state() {
  const s = await chrome.storage.session.get([
    "phase", "running", "paused", "tabId", "current", "currentName", "nextAt", "stats",
    "page", "stopReason", "rateHits",
  ]);
  return {
    phase: s.phase || null,                 // 'capture' | 'enrich'
    running: s.running || false,
    // Paused keeps the run alive and the queue intact; only Stop ends it.
    paused: s.paused || false,
    // Why the run ended. Held separately from stats.lastError because the generic
    // end-of-run message used to overwrite it, and the breaker's "check you are still
    // signed in" is the single most useful thing this tool ever says.
    stopReason: s.stopReason || null,
    tabId: s.tabId === undefined ? null : s.tabId,
    current: s.current || null,
    currentName: s.currentName || null,
    nextAt: s.nextAt || 0,
    page: s.page || 0,
    // "Too many requests" answered in a row, which sets how long the next rest is.
    rateHits: s.rateHits || 0,
    // Only what results.js does not already count: the breaker's streak, and the
    // line the popup shows. Keeping a second copy of captured/enriched/failed here
    // meant two sets of numbers that could disagree about the same run.
    stats: s.stats || { streak: 0, lastError: null },
  };
}
const setState = (patch) => chrome.storage.session.set(patch);

/** The persona: the stored copy if the options page has written one, else the default. */
async function rules() {
  const { rules: stored } = await chrome.storage.local.get("rules");
  return { ...DEFAULT_RULES, ...(stored || {}) };
}

/**
 * The popup's filters: minimum years, and three groups of checks -- tech stack,
 * background, degrees -- plus grouping, the name screen prefilter.js runs on search
 * cards. `all` holds each group's AND box: off, any one ticked check in the group is
 * enough. Read for every lead, so a change in the popup applies from the next profile
 * on (grouping: from the next search page).
 *
 * Grouping "1" starts ticked: it is the name screen every run had before the box
 * existed, so a saved setting from then keeps it.
 */
const DEFAULT_FILTERS = {
  min_years: 10,
  max_years: 0,                  // 0 = no maximum
  stacks: { ai: false, fullstack: false, data: false },
  speaking: false,
  big_company: false,
  big_university: false,
  degrees: { bs: false, ms: false, phd: false, mba: false },
  grouping: { 1: true, 2: false, 3: false },
  all: { stacks: false, background: false, degrees: false },
};

async function filters() {
  const { filters: f } = await chrome.storage.local.get("filters");
  const s = f || {};
  // Degrees used to sit behind an on/off box that hid the ticks without clearing them.
  // A setting saved with that box off asked for no degree, whatever was ticked under it.
  const degrees = s.degrees && s.degrees.on === false ? {} : s.degrees || {};
  const { on, ...ticked } = degrees;
  return {
    ...DEFAULT_FILTERS, ...s,
    stacks: { ...DEFAULT_FILTERS.stacks, ...(s.stacks || {}) },
    degrees: { ...DEFAULT_FILTERS.degrees, ...ticked },
    grouping: { ...DEFAULT_FILTERS.grouping, ...(s.grouping || {}) },
    all: { ...DEFAULT_FILTERS.all, ...(s.all || {}) },
  };
}

async function bumpStat(message) {
  const s = await state();
  await setState({ stats: { ...s.stats, lastError: message } });
}

/**
 * Block while paused. Returns false if the run was stopped, so callers can treat it as
 * "should I still be going?".
 *
 * Polling once a second is not only how it notices Resume: each state() call is a
 * chrome.storage read, and an extension API call resets MV3's idle timer. A pause on a
 * bare setTimeout would let the worker be killed, and the run would be gone, not paused.
 */
async function waitWhilePaused() {
  let announced = null;                     // null | "paused" | "sleeping"
  for (;;) {
    const s = await state();
    if (!s.running) return false;
    const night = s.paused ? { asleep: false } : await sleepNow();
    if (!s.paused && !night.asleep) {
      if (announced === "sleeping") results.noteEvent("Woke up - carrying on with the run");
      if (announced) await setState({ current: null, nextAt: 0 });
      return true;
    }
    const mode = s.paused ? "paused" : "sleeping";
    if (announced !== mode) {
      await setState(mode === "paused"
        ? { current: "Paused", nextAt: 0 }
        : { current: `Sleeping until ${hhmm(night.wakeAt)} New York time`,
            nextAt: Date.now() + night.msLeft });
      if (mode === "sleeping") {
        results.noteEvent(`Went to sleep for the night - waking at ${hhmm(night.wakeAt)} New York time`);
      }
      announced = mode;
    }
    await sleep(1000);
  }
}

// --- working hours ------------------------------------------------------------
//
// The run sleeps at night, New York time, at hours that differ from night to night: it
// goes to sleep at a random time between 22:00 and midnight and wakes at a random time
// between 05:00 and 07:00. Each night's two times are drawn once and stored, so a
// worker restart does not draw new ones.
//
// Checked where a pause is checked -- before each result page and each lead page -- so
// a run that reaches its bedtime finishes the page it is on and then waits.
//
// Pressing Start (or "Start now" on a sleeping run) during the night skips the rest of
// that night's sleep. The next night is slept as usual.

const ZONE = "America/New_York";
const SLEEP_FROM = 22 * 60, SLEEP_SPREAD = 120;    // bedtime: 22:00 - 24:00
const WAKE_FROM = 5 * 60, WAKE_SPREAD = 120;       // wake-up: 05:00 - 07:00

/** New York wall-clock time and date for `d`. */
function nyClock(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  // Some engines write midnight as "24".
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
           h: Number(parts.hour) % 24, m: Number(parts.minute), s: Number(parts.second) };
}

function dayBefore(date) {
  const t = new Date(date + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Which night `d` belongs to -- named by the evening it starts on -- and whether that
 * night's plan has the run asleep at `d`. Pure, given the plan.
 *
 * Returns { night, asleep, msLeft }: msLeft is the time until that night's wake-up.
 */
function sleepAt(d, planFor) {
  const c = nyClock(d);
  const minute = c.h * 60 + c.m;
  // From noon on, the coming night is tonight's; before noon it began yesterday.
  const night = minute >= 12 * 60 ? c.date : dayBefore(c.date);
  const plan = planFor(night);
  const secs = c.s;
  if (minute >= 12 * 60) {
    if (minute < plan.sleep) return { night, asleep: false, msLeft: 0 };
    return { night, asleep: true, msLeft: ((24 * 60 - minute + plan.wake) * 60 - secs) * 1000 };
  }
  if (minute >= plan.wake) return { night, asleep: false, msLeft: 0 };
  return { night, asleep: true, msLeft: ((plan.wake - minute) * 60 - secs) * 1000 };
}

const NIGHTS = "nights";             // { "<evening date>": { sleep, wake } } in minutes
const SKIP = "sleepSkippedNight";    // the night whose sleep a manual Start cancelled

/** Plans for the nights around now, drawing any that do not exist yet. */
async function nightPlans(d = new Date()) {
  const { [NIGHTS]: stored } = await chrome.storage.local.get(NIGHTS);
  const plans = stored || {};
  const today = nyClock(d).date;
  let changed = false;
  for (const night of [dayBefore(today), today]) {
    if (!plans[night]) {
      plans[night] = { sleep: SLEEP_FROM + Math.floor(Math.random() * (SLEEP_SPREAD + 1)),
                       wake: WAKE_FROM + Math.floor(Math.random() * (WAKE_SPREAD + 1)) };
      changed = true;
    }
  }
  // Only recent nights are worth keeping.
  for (const night of Object.keys(plans).sort().slice(0, -7)) { delete plans[night]; changed = true; }
  if (changed) await chrome.storage.local.set({ [NIGHTS]: plans });
  return plans;
}

/** Whether the run should be asleep now, and until when. */
async function sleepNow(d = new Date()) {
  const plans = await nightPlans(d);
  const st = sleepAt(d, (night) => plans[night]);
  if (!st.asleep) return { asleep: false, msLeft: 0 };
  const { [SKIP]: skipped } = await chrome.storage.local.get(SKIP);
  if (skipped === st.night) return { asleep: false, msLeft: 0 };
  return { ...st, wakeAt: plans[st.night].wake };
}

/** Skip the rest of tonight's sleep -- for a Start pressed at night. */
async function skipTonightsSleep() {
  const st = await sleepNow();
  if (st.asleep) await chrome.storage.local.set({ [SKIP]: st.night });
  return st.asleep;
}

const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/**
 * Sleep somewhere the popup can see.
 *
 * `nextAt` is when the run will act again, so the popup counts down without asking.
 * Every deliberate wait goes through here: a bare sleep shows as a frozen interface,
 * which is indistinguishable from a hang.
 */
async function waitFor(ms, label) {
  const until = Date.now() + ms;
  const patch = { nextAt: until };
  if (label !== undefined) patch.current = label;
  await setState(patch);

  // Chunked rather than one long sleep, for the same reason waitWhilePaused polls: MV3
  // terminates a service worker after ~30s with no extension API activity, and a bare
  // setTimeout is not activity. At a 60-300s pause the worker was being killed mid-wait
  // and taking the run with it, which looks exactly like the run stopping by itself.
  // Each pass reads state, which resets that timer.
  //
  // It also makes Stop responsive: it used to take effect only once the pause had run
  // its course, so stopping during a five-minute wait did nothing for five minutes.
  // Capped at 20s so the worker is always touched well inside MV3's ~30s window, and
  // a fraction of the wait so a short one is still interruptible rather than atomic.
  const step = Math.min(20000, Math.max(200, Math.ceil(ms / 8)));
  while (Date.now() < until) {
    await sleep(Math.min(step, until - Date.now()));
    if (!(await state()).running) break;
  }
  await setState({ nextAt: 0 });
}

/** Navigate the working tab and wait for the load to complete. */
function navigate(tabId, url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) done(false);
    });
    setTimeout(() => done(false), timeoutMs);
  });
}

async function tabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || ""; } catch { return ""; }
}

/**
 * Message the content script, injecting it if absent -- which it is in any tab opened
 * before the extension was loaded or reloaded.
 */
async function ask(tabId, msg, file) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      await sleep(600);
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      return { ok: false, error: `content_script_unreachable: ${String(e2.message || e2)}` };
    }
  }
}

/** Reload a tab and wait for the load to complete. */
function reloadTab(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) done(false);
    });
    setTimeout(() => done(false), timeoutMs);
  });
}

// --- not too many requests ----------------------------------------------------------
//
// LinkedIn answers a burst with "too many requests" and stops showing results. Two
// things here: a cap on page loads per hour so bursts do not happen, and a rest -- longer
// each time it is said again -- when one does. Pressing on into the notice is what turns
// a slow-down into a restricted account.

const HOUR = 60 * 60 * 1000;
const LOADS = "pageLoads";                  // when each recent LinkedIn page was loaded

/**
 * Take one page load from the hour's allowance, waiting for one to free up if it is
 * spent. False if the run was stopped meanwhile.
 */
async function spendLoad(cfg) {
  const cap = cfg.limits.hourly_page_cap;
  for (;;) {
    if (!(await state()).running) return false;
    const now = Date.now();
    const { [LOADS]: list } = await chrome.storage.session.get(LOADS);
    const recent = (list || []).filter((t) => now - t < HOUR);
    if (!cap || recent.length < cap) {
      await chrome.storage.session.set({ [LOADS]: [...recent, now] });
      return true;
    }
    await waitFor(recent[0] + HOUR - now + jitter(5000, 60000),
                  `${cap} LinkedIn pages in the last hour - waiting before the next`);
  }
}

/**
 * LinkedIn said too many requests: rest, telling the log, the popup and Telegram, then
 * let the caller try again. Each rest in a row is longer; after the last one the run
 * stops. False if the run stopped, by this or by hand.
 *
 * The rest is kept in session storage, so a worker restarted mid-rest finishes it
 * rather than carrying straight on.
 */
async function rest(cfg, where) {
  const s = await state();
  const steps = cfg.limits.rest_minutes;
  const n = s.rateHits;
  if (n >= steps.length) {
    await stop(`LinkedIn kept saying too many requests (${where}), after ${n} rests in a ` +
               `row - leave it a few hours, then press Start`);
    return false;
  }
  const minutes = Math.round(steps[n] * (1 + Math.random() * 0.25));
  const until = Date.now() + minutes * 60000;
  await setState({ rateHits: n + 1, restUntil: until,
                   stats: { ...s.stats, lastError: `LinkedIn said too many requests - ` +
                                                   `resting ${minutes} min` } });
  results.noteEvent(`LinkedIn said too many requests (${where}) - resting ${minutes} min ` +
                    `before trying again`);
  notifyTelegram(`LinkedIn said too many requests (${where}).\n` +
                 `Resting ${minutes} min, then carrying on by itself.`);
  await waitFor(until - Date.now(), `resting ${minutes} min - LinkedIn said too many requests`);
  await setState({ restUntil: 0 });
  return (await state()).running;
}

/** Finish a rest that a restarted worker interrupted. */
async function finishRest() {
  const { restUntil } = await chrome.storage.session.get("restUntil");
  if (restUntil && restUntil > Date.now()) {
    await waitFor(restUntil - Date.now(), "resting - LinkedIn said too many requests");
  }
  await setState({ restUntil: 0 });
}

/**
 * Press Next, and make sure the page turned. A press that seems to fail is not the end
 * of the search: LinkedIn may have refused it for too many requests, or been slow. So
 * rest or wait, reload, and look at where the search really is -- the click may have
 * worked after all -- before pressing again. Three tries, then the run stops.
 */
async function turnPage(cfg, tabId, page, firstBefore) {
  const c = cfg.capture;
  let error = "no answer from the page";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await spendLoad(cfg))) return { ok: true };
    const nav = await ask(tabId, { type: "CAPTURE_NEXT", timeoutMs: c.page_timeout_ms },
                          "capture.js");
    if (nav && nav.ok) return { ok: true };
    error = (nav && nav.error) || "no answer from the page";

    // Reloaded until it is not refusing, or the rests run out.
    for (;;) {
      if (error === "rate_limited") {
        if (!(await rest(cfg, `turning search page ${page}`))) return { ok: true };
      } else {
        results.noteEvent(`Next on search page ${page} did not turn it (${error}) - ` +
                          `reloading and trying again`);
        await waitFor(jitter(30000, 60000), `Next on page ${page} did not work - trying again`);
        if (!(await state()).running) return { ok: true };
      }
      await focusSearch(tabId, c);
      if (!(await spendLoad(cfg))) return { ok: true };
      await reloadTab(tabId, c.page_timeout_ms);
      await waitFor(c.settle_ms, `reloading search page ${page}`);
      const st = await ask(tabId, { type: "PAGE_STATUS", timeoutMs: c.page_timeout_ms },
                           "capture.js");
      if (st && st.problem === "rate_limited") { error = "rate_limited"; continue; }
      // The click had worked: the search is on the next page now.
      if (st && st.first && st.first !== firstBefore) return { ok: true };
      break;
    }
  }
  return { ok: false, error };
}

/**
 * Make the search the shown tab of its own window, and wait until that window is on the
 * screen. Its window is never focused: that took the keyboard and the front of the
 * screen away from whatever the person was doing.
 */
async function focusSearch(tabId, c) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await waitFor(c.settle_ms, "showing the search");
  } catch { /* tab went away; the ask that follows will report it */ }
  await waitVisible(tabId, "capture.js", "search");
}

/**
 * Wait while a tab's page is hidden.
 *
 * Chrome stops drawing a page that is not on the screen -- its window minimized, or
 * covered completely by other windows -- and LinkedIn's pages then never fill in. Not
 * being focused is fine: a window that shows even a strip of itself draws normally. So
 * the run waits, saying why, instead of reading an empty page or stealing the screen.
 * A page that cannot answer counts as shown; the read that follows reports a real fault.
 */
async function waitVisible(tabId, file, what) {
  let since = 0, told = false, why = null;
  for (;;) {
    if (!(await state()).running) return false;
    const r = await ask(tabId, { type: "VISIBILITY" }, file);
    if (!r || r.visible !== false) {
      if (since) {
        results.noteEvent(`The ${what} window is showing again after ` +
                          `${Math.round((Date.now() - since) / 60000)} min - carrying on`);
      }
      return true;
    }
    const now = await hiddenWhy(tabId);
    if (now.code !== why) {
      why = now.code;
      results.noteEvent(`The ${what} window is hidden: ${now.text} - waiting`);
    }
    since ||= Date.now();
    if (!told && Date.now() - since > 10 * 60000) {
      told = true;
      notifyTelegram(`The ${what} window has been hidden for 10 minutes, so the run is ` +
                     `waiting.\nWhy: ${now.text}.\n${now.fix}`);
    }
    await waitFor(10000, `waiting: the ${what} window ${now.short}`);
  }
}

/**
 * Why a tab is hidden, as far as can be told: its window minimized, the screen locked,
 * or else covered. Covered is the one a switch fixes -- Chrome started with
 * --disable-backgrounding-occluded-windows keeps drawing a window that is covered, and
 * the "Chrome (Harvester)" shortcut starts it that way.
 */
const SWITCH_MISSING = "switchMissing";

// A new Chrome may have been started with the switch: forget until it is seen missing again.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove(SWITCH_MISSING));

async function hiddenWhy(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(t.windowId);
    // Another tab in front of it in its own window. Only the front tab of a window is
    // drawn, and no Chrome setting changes that: the tab needs a window of its own.
    if (!t.active) {
      return { code: "behind_tab", short: "is behind another tab in its window",
               text: "another tab is in front of it in its window",
               fix: "Drag the tab out into a window of its own, and do not switch tabs " +
                    "in that window." };
    }
    if (w.state === "minimized") {
      return { code: "minimized", short: "is minimized - un-minimize it",
               text: "the window is minimized",
               fix: "Un-minimize it; the run carries on by itself." };
    }
    if ((await chrome.idle.queryState(60)) === "locked") {
      return { code: "locked", short: "is hidden - the screen is locked",
               text: "the screen is locked or turned off",
               fix: "It carries on by itself once the screen is unlocked." };
    }
  } catch { /* window gone or no answer: treat as covered */ }
  // With the switch on, a covered window stays visible -- so this Chrome lacks it. The
  // popup offers the setup file until Chrome is next started.
  await chrome.storage.local.set({ [SWITCH_MISSING]: Date.now() });
  return { code: "covered", short: "is completely covered by another window",
           text: "another window covers it completely",
           fix: "Leave a strip of it showing, or run the setup file the popup offers and " +
                "restart Chrome: then a covered window keeps working." };
}

// --- one run, two phases ------------------------------------------------------
//
// Start reads the situation: a search tab captures then enriches, anywhere else with
// leads queued enriches only, neither refuses. The phases stay distinct because they
// cost wildly different amounts -- one page load per ~25 people against one per person.

async function runStart() {
  // Started by hand at night: the person wants it running now, not at the wake-up.
  if (await skipTonightsSleep()) {
    results.noteEvent("Start pressed during the night - skipping the rest of tonight's sleep");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSearch = !!(tab && /linkedin\.com\/sales\/search\//.test(tab.url || ""));
  const waiting = (await results.getRun()).pending.length;

  if (!onSearch && !waiting) {
    return { ok: false,
             error: "open a Sales Navigator people search to capture, or capture one " +
                    "first - nothing is waiting to enrich" };
  }

  // Only the front tab of a window is drawn: sharing one window, the search and the
  // profiles would take turns being hidden.
  const linked = await linkedTab();
  if (onSearch && linked && linked.windowId === tab.windowId) {
    return { ok: false,
             error: "the linked profile tab is in the same window as this search - move " +
                    "one of them to its own window (drag the tab out), then press Start" };
  }

  // A fresh capture is a fresh result set. Resuming an enrich-only run keeps the one
  // that is already half finished, otherwise pressing Start to drain a queue would
  // throw away the people it had already qualified.
  if (onSearch) {
    await results.startRun(tab.url);
    await relay.resetSendCounts();
  }

  await setState({
    running: true, phase: onSearch ? "capture" : "enrich",
    tabId: onSearch ? tab.id : null, page: 0,
    current: null, currentName: null, nextAt: 0, stopReason: null, paused: false,
    stats: { streak: 0, lastError: null },
    // Start pressed by hand is the person's call: no rest left over from before.
    rateHits: 0, restUntil: 0,
  });

  results.noteEvent(onSearch
    ? `Started: capture and read the search at ${tab.url}`
    : `Started: reading the ${waiting} queued lead(s) - no search to capture`);
  launch(onSearch ? tab : null);
  return { ok: true, phases: onSearch ? "capture + enrich" : "enrich" };
}

// --- surviving a restarted worker -------------------------------------------------
//
// A run lives in this worker's memory, its state in chrome.storage.session. Chrome ends
// the worker when the computer sleeps, on an update, or simply when it chooses to; the
// session storage survives it and the loop does not. The state then said "running"
// forever while nothing ran -- the popup frozen on the search tab's last "scrolling
// (pass N)" for hours, on the same page.
//
// So a worker that finds a run marked running which it did not start itself takes it
// up again: same run, same people seen, the search tab where it was. The alarm is what
// wakes a worker to notice, rather than waiting for someone to open the popup.

const WATCH = "run-watch";
let runHere = false;                        // a run was started or taken up by this worker

function launch(searchTab) {
  runHere = true;
  chrome.alarms.create(WATCH, { periodInMinutes: 1 });
  runAll(searchTab).catch(async (e) => {
    await stop(`run failed: ${String(e.message || e)}`);
  });
}

async function resumeOrphan() {
  // Claimed before the first await: a worker woken by the alarm calls this twice at
  // once, from the top level and from the alarm, and only one may take the run up.
  if (runHere) {
    if (!(await state()).running) await chrome.alarms.clear(WATCH);
    return;
  }
  runHere = true;
  const s = await state();
  if (!s.running) { runHere = false; await chrome.alarms.clear(WATCH); return; }

  let tab = null;
  if (s.tabId !== null) {
    try {
      const t = await chrome.tabs.get(s.tabId);
      if (/linkedin\.com\/sales\/search\//.test(t.url || "")) tab = t;
    } catch { /* closed */ }
  }
  const waiting = (await results.getRun()).pending.length;
  if (!tab && (s.phase === "capture" || !waiting)) {
    await stop(`the run was interrupted on search page ${s.page} when Chrome restarted the ` +
               `extension, and the search tab is gone - open the search and press Start`);
    return;
  }
  results.noteEvent(`Chrome restarted the extension mid-run - carrying on from ` +
                    (tab ? `search page ${s.page}` : `the ${waiting} queued lead(s)`));
  // The page counter goes up as a page is read; this one is read again, under its number.
  await setState({ page: Math.max(0, s.page - 1), current: null, currentName: null,
                   nextAt: 0, phase: tab ? "capture" : "enrich" });
  launch(tab);
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === WATCH) resumeOrphan(); });
resumeOrphan();

async function runAll(searchTab) {
  const cfg = await loadConfig();
  await finishRest();
  if (searchTab) {
    // Interleaved: read a page, enrich what it produced, then turn the page. Verdicts
    // arrive while the search is still being walked, and stopping early leaves whole
    // pages finished rather than hundreds of half-filled rows.
    const res = await runCapture(cfg, searchTab);
    // The search ran out of pages, as opposed to failing or being stopped: once the
    // queue is drained, this run has seen everything the search held.
    if (res.reason === "complete") await results.markCaptureComplete();
    if (!(await state()).running) {
      const s = await state();
      const queued = (await results.getRun()).pending.length;
      const note = queued
        ? `${queued} lead(s) are still queued - press Start from a non-search tab ` +
          `to enrich them`
        : null;
      await bumpStat([s.stopReason, note].filter(Boolean).join(". ") || "stopped");
      return;
    }
    // Anything the per-page passes did not reach.
    await setState({ phase: "enrich", current: null, currentName: null, nextAt: 0 });
    await runEnrich(cfg);
  } else {
    await runEnrich(cfg);
  }
  await finish();
}

/** End of a run that was not stopped by hand. */
async function finish() {
  const s = await state();
  const run = await results.getRun();
  // A stop already said why. Anything else ending here is a finish, with the reason
  // the capture left behind -- or, with none, a search read to the end.
  if (s.running) {
    results.noteEvent(`${s.stopReason ? "Stopped" : "Finished"}: ${s.stopReason ||
      (run.captureComplete ? "every page of the search captured and every lead read"
                           : "every queued lead read")}` +
      ` - ${results.summarize(run)}`);
  }
  // Told only when the whole search is done: the last page captured and nobody left to
  // read. Not on a stop, a breaker, or a run that ended short of the last page.
  let telegramNote = "";
  if (s.running && run.captureComplete && !run.pending.length) {
    const sends = await relay.sendCounts();
    const c = run.counts;
    const r = await notifyTelegram(finishedMessage({
      captured: c.captured, enriched: c.enriched,
      leads: run.qualified.length, sent: sends.sent, dropped: sends.dropped,
    }), "HTML");
    if (!r.ok && !r.skipped) {
      telegramNote = `. Telegram notification failed: ${r.error}`;
      results.noteEvent(`Telegram notification failed: ${r.error}`);
    }
  }
  // The search stopped turning its pages -- unreadable, stuck, no Next button -- and the
  // run read what was queued and ended here. A page limit is the user's own.
  if (s.running && s.stopReason && !/^page limit/.test(s.stopReason)) {
    await alertStop(s.stopReason);
  }
  await results.finishRun(s.stopReason || "finished");
  await setState({ running: false, paused: false, current: null, currentName: null,
                   nextAt: 0 });
  await closeEnrichTab();
  const why = s.stopReason ? `${s.stopReason} - ` : "";
  await bumpStat(`${why}${results.summarize(run)}. Send to server, or Download the .txt` +
                 telegramNote);
}

// --- phase 1: capture ---------------------------------------------------------

async function runCapture(cfg, tab) {
  const c = cfg.capture;
  const between = c.between_ms;
  const maxPages = c.max_pages;
  const q = await rules();

  // The card screen. Returns the rejecting verdict -- not merely true -- so the
  // decision log can say which rule turned this person away rather than only that
  // something did.
  //
  // The rules go first and the operator's own filter second, so prefilter.js only ever
  // sees cards the persona did not already decide -- and a slow or throwing filter
  // cannot cost anything on a card that was never going to be enriched.
  let filterError = null;
  // The name lists the filter reads. If they cannot be loaded the filter throws, which
  // enriches everyone and says so, rather than turning everyone away.
  try { await loadGroups(); } catch (e) { filterError = `prefilter.js: ${e.message || e}`; }
  // The popup's Grouping boxes, read again before each page.
  let grouping = {};
  const screen = (lead) => {
    const byRules = screenCard(lead, q);
    if (byRules) return byRules;
    const { enrich, error } = safeShouldEnrich(lead, grouping);
    if (error && !filterError) filterError = `prefilter.js threw: ${error}`;
    if (enrich) return false;
    return { reasons: ["Excluded by prefilter.js"],
             disqualifiers: ["prefilter"] };
  };

  let captured = 0;
  let unreadable = 0;
  let stale = 0;

  while ((await state()).running) {
    if (!(await waitWhilePaused())) return { captured, reason: "stopped" };
    const s = await state();
    const page = s.page + 1;
    await setState({ page, current: `Reading page ${page}` });
    // The read scrolls the list, and a hidden page does not load more rows.
    if (!(await waitVisible(s.tabId, "capture.js", "search"))) {
      return { captured, reason: "stopped" };
    }

    const res = await ask(s.tabId, {
      type: "CAPTURE_PAGE", timeoutMs: c.page_timeout_ms,
      scrollPauseMs: c.scroll_pause_ms, scrollStep: c.scroll_step,
    }, "capture.js");

    if (!res || !res.ok) {
      const err = (res && res.error) || "unknown";
      // Read again under the same number.
      await setState({ page: page - 1 });
      if (err === "rate_limited") {
        // Not a broken page: LinkedIn wants a rest. Then reload and read it again.
        if (!(await rest(cfg, `reading search page ${page}`))) return { captured, reason: "stopped" };
        await focusSearch(s.tabId, c);
        if (!(await spendLoad(cfg))) return { captured, reason: "stopped" };
        await reloadTab(s.tabId, c.page_timeout_ms);
        await waitFor(c.settle_ms, `reloading search page ${page}`);
        continue;
      }
      unreadable += 1;
      await setState({ stats: { ...s.stats, lastError: err } });
      // A search that cannot be read twice running is not going to start working.
      if (unreadable >= 2) {
        await setState({ stopReason:
          `search page ${page} could not be read twice in a row (${err})` +
          (err === "auth_wall" ? " - LinkedIn is asking to sign in" : "") });
        return { captured, reason: err };
      }
      // waitFor, not sleep: the last bare wait long enough for MV3 to end the worker.
      await waitFor(jitter(between[0], between[1]), `retrying page ${page}`);
      continue;
    }

    unreadable = 0;
    await setState({ rateHits: 0 });
    // The card's tenure line is parsed here so the lead carries months rather than
    // prose; nothing downstream should have to read "4 years 2 months in role".
    const leads = res.leads.map((lead) => {
      const t = parseTenure(lead.tenure_text);
      return { ...lead, tenure_months: t.role, company_tenure_months: t.company };
    });

    const f = await filters();
    grouping = f.grouping;
    const added = await results.addCaptured(leads, screen);
    captured += added.added;

    // A page of nobody new, twice running, is the search not moving: the same page read
    // again however Next was pressed. Stop and say so rather than circle on it.
    stale = added.added ? 0 : stale + 1;
    if (stale >= 2) {
      await setState({ stopReason: `search page ${page} showed only people already read ` +
                                   `in this run, twice in a row - the search is not moving on` });
      return { captured, reason: "stuck" };
    }

    const st = await state();
    // Said once per run, not once per lead: a filter that throws throws for everyone,
    // and the message would otherwise replace every other thing the popup has to say.
    if (filterError) {
      await setState({ stats: { ...st.stats, lastError: filterError } });
      filterError = null;
    }
    // A page that yields fewer than it said it held means the list did not finish
    // mounting. Surface it rather than silently banking 19 of 25.
    const thin = res.short
      ? `Page ${page}: ${res.leads.length} of ${res.target} leads after `
        + `${res.scroll_passes} scroll passes`
        + (res.at_bottom ? " (reached the bottom)" : " (did not reach the bottom)")
      : (res.has_next && !res.target && res.leads.length < 10
          ? `Page ${page}: ${res.leads.length} leads after ${res.scroll_passes} scroll `
            + `passes (${res.cards_before_scroll} were loaded before scrolling)`
          : null);
    await setState({ stats: { ...st.stats,
                              lastError: thin || st.stats.lastError } });

    // Enrich this page before moving on. Bounded by what the page produced, so the two
    // stages stay in step instead of one racing ahead.
    if (added.pending && (await state()).running) {
      await setState({ phase: "enrich" });
      await runEnrich(cfg, added.pending);
      await setState({ phase: "capture" });
      if (!(await state()).running) return { captured, reason: "stopped" };
    }

    if (!res.has_next) {
      results.noteEvent(`Last page of the search reached (page ${page})`);
      return { captured, reason: "complete" };
    }
    if (maxPages && page >= maxPages) {
      await setState({ stopReason: `page limit reached (${maxPages})` });
      return { captured, reason: "page limit" };
    }
    if (!(await state()).running) break;

    await waitFor(jitter(between[0], between[1]), `page ${page} done`);

    await focusSearch(s.tabId, c);
    const nav = await turnPage(cfg, s.tabId, page, res.leads[0]?.lead_id || null);
    if (!(await state()).running) break;
    if (!nav.ok) {
      await setState({ stopReason: `the Next button on search page ${page} could not be ` +
                                   `pressed, three tries (${nav.error})` });
      return { captured, reason: "no next button" };
    }
    await waitFor(c.settle_ms, `opening page ${page + 1}`);
  }

  return { captured, reason: "stopped" };
}

// --- phase 2: enrich ----------------------------------------------------------

/**
 * Enrichment's own window, opened without focus and never focused after.
 *
 * It used to take focus for every profile, on the belief that Chrome does not draw an
 * unfocused window. What Chrome does not draw is a hidden one -- minimized, or covered
 * completely -- and focusing was only a heavy way of making sure it showed, which left
 * the person unable to use their own browser. Now the window opens behind, where the
 * person last put it, and enrichOne waits while it is hidden (waitVisible).
 *
 * A separate window rather than a tab, so it does not take over the one the search is in.
 */
const ENRICH_BOUNDS = "enrichBounds";

async function enrichTab() {
  // A tab the person linked from the popup comes first: theirs to place, so it is used
  // where it is and never closed. Kept in session storage, as tab ids do not outlive
  // the browser.
  const linked = await linkedTab();
  if (linked) {
    if (!linked.active) await chrome.tabs.update(linked.id, { active: true });
    return linked.id;
  }
  const { enrichTabId } = await chrome.storage.session.get(["enrichTabId"]);
  if (enrichTabId !== undefined && enrichTabId !== null) {
    try {
      const t = await chrome.tabs.get(enrichTabId);
      // The shown tab of its own window; the window itself is left where it is.
      if (!t.active) await chrome.tabs.update(enrichTabId, { active: true });
      return enrichTabId;
    } catch { /* closed; make a new one */ }
  }
  const { [ENRICH_BOUNDS]: bounds } = await chrome.storage.local.get(ENRICH_BOUNDS);
  const win = await chrome.windows.create({
    url: "about:blank", focused: false, state: "normal",
    ...(bounds || { width: 1100, height: 900 }),
  });
  await chrome.storage.session.set({ enrichTabId: win.tabs[0].id });
  return win.tabs[0].id;
}

// Wherever the person moves or sizes the profile window is where the next one opens --
// typically a corner of the screen they leave showing.
chrome.windows.onBoundsChanged.addListener(async (w) => {
  const { enrichTabId } = await chrome.storage.session.get(["enrichTabId"]);
  if (enrichTabId === undefined || enrichTabId === null) return;
  try {
    if ((await chrome.tabs.get(enrichTabId)).windowId !== w.id) return;
  } catch { return; }
  if (w.state !== "normal") return;
  await chrome.storage.local.set({ [ENRICH_BOUNDS]:
    { left: w.left, top: w.top, width: w.width, height: w.height } });
});

// --- the linked profile tab ---------------------------------------------------------

const LINKED = "linkedTabId";

/** The linked tab, or null when none is linked or it has been closed. */
async function linkedTab() {
  const { [LINKED]: id } = await chrome.storage.session.get(LINKED);
  if (id === undefined || id === null) return null;
  try { return await chrome.tabs.get(id); } catch {
    await chrome.storage.session.remove(LINKED);
    return null;
  }
}

/**
 * Link a tab for profiles. Not a search tab: the search needs its own tab, and the
 * profiles would replace it.
 */
async function linkTab(tabId) {
  const t = await chrome.tabs.get(tabId);
  if (/linkedin\.com\/sales\/search\//.test(t.url || "")) {
    return { ok: false, error: "this is a search tab - link a tab in another window for the profiles" };
  }
  const s = await state();
  if (s.tabId !== null && s.tabId === tabId) {
    return { ok: false, error: "this is the run's search tab - link a tab in another window" };
  }
  await chrome.storage.session.set({ [LINKED]: tabId });
  // A window the extension opened before the link is not needed any more. Mid-run it may
  // be reading someone; it is closed when the run ends instead.
  if (!s.running) await closeEnrichTab();
  results.noteEvent("Profile tab linked: profiles open in it from now on");
  return { ok: true };
}

async function linkInfo() {
  const t = await linkedTab();
  return t ? { linked: true, windowId: t.windowId } : { linked: false };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [LINKED]: id } = await chrome.storage.session.get(LINKED);
  if (id === tabId) await chrome.storage.session.remove(LINKED);
});

async function closeEnrichTab() {
  const { enrichTabId } = await chrome.storage.session.get(["enrichTabId"]);
  if (enrichTabId === undefined || enrichTabId === null) return;
  try { await chrome.tabs.remove(enrichTabId); } catch { /* already closed */ }
  await chrome.storage.session.set({ enrichTabId: null });
}

async function enrichOne(tabId, lead, c) {
  const url = "https://www.linkedin.com" + lead.lead_url;
  const loaded = await navigate(tabId, url, c.page_timeout_ms);
  const landed = await tabUrl(tabId);

  if (!loaded) {
    return { ok: false, error: `page_load_timeout [${landed.slice(0, 70)}]` };
  }
  // A redirect off /sales/lead/ means LinkedIn refused -- a login wall, most often.
  // The content script does not run there, so name it rather than blaming injection.
  if (landed && !/linkedin\.com\/sales\/lead\//i.test(landed)) {
    return { ok: false, error: `redirected_away [${landed.slice(0, 70)}]` };
  }

  if (!(await waitVisible(tabId, "lead.js", "profile"))) {
    return { ok: false, error: "stopped" };
  }
  await waitFor(c.settle_ms, undefined);
  await setState({ current: "reading the profile" });
  const data = await ask(tabId, { type: "READ_LEAD", timeoutMs: c.page_timeout_ms,
                                  scrollPauseMs: c.scroll_pause_ms }, "lead.js");
  if (!data) return { ok: false, error: "no_response" };
  return data;
}

async function runEnrich(cfg, limit = 0) {
  const c = cfg.enrich;
  const between = c.between_ms;
  const breaker = c.failure_breaker;
  const q = await rules();
  // The Group 3 universities. A run that only drains the queue never went through the
  // capture that loads them.
  try { await loadGroups(); } catch { /* the capture reports a broken group.md */ }
  let done = 0;

  while ((await state()).running) {
    if (limit && done >= limit) return;        // this page's worth is finished

    const batch = await results.takePending(limit ? limit - done : 25);
    if (!batch.length) {
      if (limit) return;
      return;                                  // the queue is empty; runAll finishes up
    }

    const tabId = await enrichTab();

    for (let i = 0; i < batch.length; i++) {
      const lead = batch[i];
      // Before the page load, not after: pausing should stop the next visit happening,
      // not interrupt one that is already open.
      // Leaving early is safe: a lead stays on the queue until recordResult takes it
      // off, so whatever this batch did not reach is still waiting.
      if (!(await waitWhilePaused())) return;
      if (!(await state()).running) return;
      await setState({ current: lead.lead_id, currentName: lead.full_name || null });

      if (!(await spendLoad(cfg))) return;
      const data = await enrichOne(tabId, lead, c);
      // Stopped while waiting for a hidden window: this person stays on the queue.
      if (!(await state()).running) return;
      // LinkedIn wants a rest: take it, then open the same person again.
      if (!data.ok && data.error === "rate_limited") {
        if (!(await rest(cfg, `opening ${lead.full_name || "a profile"}`))) return;
        i--;
        continue;
      }
      done++;

      // The verdict is decided here, from the card fields plus whatever the lead page
      // added. Instant, local, and explainable as "matched this keyword in this title".
      let verdict = null, reason = "";
      if (data.ok) {
        const merged = { ...lead, ...data };
        const f = await filters();
        // Box 3 let this name through; a Group 3 university in the education drops it.
        const school = f.grouping[3] ? groupThreeSchool(lead, data.education) : null;
        if (school) {
          verdict = "NO";
          reason = `Grouping 3: studied at a Group 3 university (${school})`;
        } else {
          const decided = classify(merged, q, f);
          verdict = verdictOf(decided);
          reason = decided.reasons[0] || "";
        }
      }
      // Where a YES goes depends on whether sending is on:
      //   on  -- to the server, no history check;
      //   off -- checked against the history by URL: a lead found before is left out,
      //          a new one goes to the download list and waits in the outbox for the
      //          server. The history records it either way.
      let found = null, auto = false, duplicateOf = null;
      if (verdict === "YES") {
        found = { url: results.urlFor({ ...lead, ...data }),
                  name: data.full_name || lead.full_name || null,
                  title: data.title || lead.title || null };
        auto = await relay.isAuto();
        if (!auto) duplicateOf = await history.historyEntry(found.url);
      }
      const note = duplicateOf
        ? ` (duplicate: first found ${history.stamp(duplicateOf.first)}, not added to the download)`
        : "";
      await results.recordResult(lead, data, verdict, reason + note);
      if (found) {
        await history.recordLead(found);
        if (auto) {
          await relay.addToOutbox(found);
          flushLeads();                         // not awaited: sending must not hold up the run
        } else {
          // A duplicate stays out of the download, but still goes to the server once
          // sending is switched on.
          if (!duplicateOf) await history.addToDownload(found);
          await relay.addToOutbox(found);
        }
      }

      const s = await state();
      const streak = data.ok ? 0 : s.stats.streak + 1;
      await setState({
        ...(data.ok ? { rateHits: 0 } : {}),
        current: null,
        currentName: null,
        stats: { ...s.stats, streak,
                 lastError: data.ok ? s.stats.lastError : data.error },
      });

      // THE BREAKER. A dead session fails every page; without this the run would keep
      // opening lead pages into a login wall for as long as it was left alone.
      if (streak >= breaker) {
        return stop(`stopped after ${streak} consecutive failures - last: ` +
                    `${data.error}. Check you are still signed in to LinkedIn.`);
      }
      const counts = (await results.getRun()).counts;
      // The list is the point: once it is long enough, opening more profiles buys
      // nothing and costs the same exposure as the ones that did.
      if (c.yes_cap && counts.yes >= c.yes_cap) {
        return stop(`target reached - ${counts.yes} qualified. Send to server, ` +
                    `or Download the .txt`, { expected: true });
      }
      if (c.session_cap && counts.enriched >= c.session_cap) {
        return stop(`session limit reached (${c.session_cap}) - press Start again ` +
                    `to continue`, { expected: true });
      }
      if (!(await state()).running) return;

      await waitFor(jitter(between[0], between[1]), null);
    }
  }
}

// --- sending to the relay ---------------------------------------------------------

let flushing = false;
let flushAgain = false;

/**
 * Send everything in the outbox, one message each, oldest first -- leads from this run
 * and any earlier one that were held back. Does nothing unless sending is on.
 *
 * Called when a lead qualifies, when sending is switched on, when the server allocates
 * a channel, and every few minutes while anything is waiting, so a lead held back by a
 * failure goes out once the failure has passed.
 *
 * One pass at a time: a call mid-pass asks for another pass rather than starting a
 * second sender that would race this one for the same people. A refusal retrying
 * cannot fix -- no channel, no registration -- turns sending off and says why; anything
 * else leaves the lead queued for the next pass.
 */
async function flushLeads() {
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    do {
      flushAgain = false;
      if (!(await relay.isAuto())) return;
      const [queued, sent] = await Promise.all([relay.outbox(), relay.sentUrls()]);
      for (const lead of queued) {
        // Queued before an earlier copy of the same person went out: already sent.
        if (sent.has(lead.url)) {
          await relay.removeFromOutbox(lead.url);
          await relay.countSend("dropped");
          continue;
        }
        if (!(await relay.isAuto())) return;    // Stop sending, pressed mid-pass
        const r = await relay.sendLead(lead);
        if (r.ok) {
          if (r.outcome === "sent" || r.outcome === "dropped") await relay.countSend(r.outcome);
          await relay.markSent(lead.url);
          await relay.removeFromOutbox(lead.url);
          await history.markSentInHistory(lead.url);
          if (r.note) {
            results.noteEvent(r.note);
            await relay.noteError(r.note);     // shown in the popup until a lead really posts
          }
          continue;
        }
        if (r.warning) await relay.setAuto(false);
        await relay.noteError(r.error);
        return;
      }
    } while (flushAgain);
  } finally {
    flushing = false;
  }
}

// Retry what a failure held back. Every five minutes while sending is on and something
// is waiting; a quiet check otherwise.
const RETRY_ALARM = "outbox-retry";
chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== RETRY_ALARM) return;
  if ((await relay.isAuto()) && (await relay.outbox()).length) flushLeads();
});

// Sending switched on, or a channel allocated while it was on: send what is waiting.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.relay) return;
  const was = changes.relay.oldValue || {};
  const now = changes.relay.newValue || {};
  if (now.auto && now.channel && !(was.auto && was.channel)) flushLeads();
});

// --- stop ---------------------------------------------------------------------

/**
 * End a run now. `reason` null is Stop pressed; any other reason is the run stopping by
 * itself, which goes to Telegram too -- unless `expected`, a limit the user set.
 */
async function stop(reason, { expected = false } = {}) {
  results.noteEvent(`Stopped: ${reason || "Stop pressed"}`);
  await setState({ running: false, paused: false, current: null, currentName: null,
                   nextAt: 0, stopReason: reason || "stopped by the user" });
  await results.finishRun(reason || "stopped by the user");
  await closeEnrichTab();
  if (!reason) return;
  await bumpStat(reason);
  if (!expected) await alertStop(reason);
}

/** Tell Telegram a run stopped by itself. A failure to send is logged, not thrown. */
async function alertStop(reason) {
  const r = await notifyTelegram(stoppedMessage(reason,
                                                results.summarize(await results.getRun())));
  if (!r.ok && !r.skipped) results.noteEvent(`Telegram notification failed: ${r.error}`);
}

/**
 * Clear this run's results. Refuses mid-run, or the loop would write into what it just
 * cleared. Settings survive: having to retype them is not "clearing".
 */
async function clearRun() {
  if ((await state()).running) return { ok: false, error: "stop the run first" };
  await results.clearRun();
  // The linked tab is a setting, not a result.
  const { [LINKED]: linked } = await chrome.storage.session.get(LINKED);
  await chrome.storage.session.clear();
  await setState({
    stats: { streak: 0, lastError: "cleared" },
    ...(linked !== undefined ? { [LINKED]: linked } : {}),
  });
  return { ok: true };
}

// --- what the popup asks for --------------------------------------------------

async function snapshot() {
  const [s, run, r, sent, queued, toDownload, sends] = await Promise.all([
    state(), results.getRun(), relay.getRelay(), relay.sentUrls(), relay.outbox(),
    history.downloadList(), relay.sendCounts()]);
  return {
    ...s,
    relay: { status: r.status, fingerprint: r.fingerprint, channel: r.channel, error: r.error,
             // Sent at some point and not waiting to go again: a lead re-qualified this
             // run is in the outbox until it really goes out.
             auto: !!r.auto,
             sent: run.qualified.filter((q) => sent.has(q.url) &&
                                               !queued.some((l) => l.url === q.url)).length,
             unsent: queued.length, downloads: toDownload.length,
             reallySent: sends.sent, dropped: sends.dropped },
    version: VERSION,
    switchMissing: !!(await chrome.storage.local.get(SWITCH_MISSING))[SWITCH_MISSING],
    profileTab: await linkInfo(),
    counts: run.counts,
    pending: run.pending.length,
    qualified: run.qualified.length,
    decided: run.log.length,
    events: (await results.runEvents()).length,
    finishedAt: run.finishedAt,
    summary: results.summarize(run),
  };
}

/** Pause leaves everything standing and the loop waits; only Stop ends a run. */
async function pause(on) {
  const s = await state();
  if (!s.running) return { ok: false, error: "nothing is running" };
  await setState({ paused: !!on });
  results.noteEvent(on ? "Paused - Pause pressed" : "Resumed - Resume pressed");
  return { ok: true, paused: !!on };
}

// Pick up a registration that was waiting for approval when this worker last died, and
// any leads that qualified while sending could not keep up.
relay.resumeRelay();
results.getRun().then(async (run) => {
  await relay.seedOutbox(run.qualified);
  await history.seedHistory([...run.qualified, ...(await relay.outbox())],
                            await relay.sentUrls());
}).then(flushLeads);

const MESSAGES = new Set(["STATE", "START", "STOP", "PAUSE", "RESUME", "CLEAR",
                          "AUTO_ON", "AUTO_OFF", "REGISTER", "RELAY_RESET", "DOWNLOAD", "LOG_TEXT", "WAKE",
                          "HISTORY_TEXT",
                          "GET_FILTERS", "SET_FILTERS", "LINK_TAB", "UNLINK_TAB",
                          "GET_SETTINGS", "SET_SETTINGS", "TEST_TELEGRAM",
                          "PROGRESS"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!MESSAGES.has(msg?.type)) return false;
  (async () => {
    if (msg.type === "START") {
      const r = await runStart();
      sendResponse({ ...(await snapshot()), startError: r.ok ? null : r.error });
    } else if (msg.type === "STOP") {
      await stop(null);
      sendResponse(await snapshot());
    } else if (msg.type === "WAKE") {
      // "Start now" on a sleeping run: skip the rest of tonight's sleep. The run's own
      // wait notices within a second.
      if (await skipTonightsSleep()) {
        results.noteEvent("Start now pressed - skipping the rest of tonight's sleep");
      }
      sendResponse(await snapshot());
    } else if (msg.type === "PAUSE" || msg.type === "RESUME") {
      await pause(msg.type === "PAUSE");
      sendResponse(await snapshot());
    } else if (msg.type === "CLEAR") {
      sendResponse(await clearRun());
    } else if (msg.type === "AUTO_ON" || msg.type === "AUTO_OFF") {
      const r = await relay.setAuto(msg.type === "AUTO_ON");
      if (r.ok) {
        await relay.noteError(null);
        if (r.auto) flushLeads();           // whoever qualified before it was switched on
      }
      sendResponse(r);
    } else if (msg.type === "DOWNLOAD") {
      // What is new since the last download; saving it starts the next list afresh.
      const list = await history.downloadList();
      const r = await results.downloadTxt(list);
      if (r.ok) await history.downloaded(list.map((l) => l.url));
      sendResponse(r);
    } else if (msg.type === "HISTORY_TEXT") {
      sendResponse(await history.historyText());
    } else if (msg.type === "LOG_TEXT") {
      sendResponse(await results.logText());
    } else if (msg.type === "GET_FILTERS") {
      sendResponse(await filters());
    } else if (msg.type === "LINK_TAB") {
      sendResponse(await linkTab(msg.tabId));
    } else if (msg.type === "UNLINK_TAB") {
      await chrome.storage.session.remove(LINKED);
      results.noteEvent("Profile tab unlinked: profiles open in a window of their own again");
      sendResponse({ ok: true });
    } else if (msg.type === "SET_FILTERS") {
      await chrome.storage.local.set({ filters: msg.filters });
      sendResponse(await filters());
    } else if (msg.type === "GET_SETTINGS") {
      sendResponse({ name: await relay.getName(), telegram: await getTelegram() });
    } else if (msg.type === "SET_SETTINGS") {
      if (msg.name !== undefined) await relay.setName(msg.name);
      if (msg.telegram) await setTelegram(msg.telegram);
      sendResponse({ name: await relay.getName(), telegram: await getTelegram() });
    } else if (msg.type === "TEST_TELEGRAM") {
      sendResponse(await notifyTelegram("Test message - " +
                                        "notifications reach this chat."));
    } else if (msg.type === "REGISTER") {
      sendResponse(await relay.register());
    } else if (msg.type === "RELAY_RESET") {
      sendResponse(await relay.resetRelay());
    } else if (msg.type === "PROGRESS") {
      // From a content script, mid-read, while this worker is blocked awaiting its
      // reply. Only honoured during a live run: a stale tab reporting after a stop
      // would otherwise leave the popup counting down to something that is not coming.
      const s = await state();
      if (s.running && !s.paused) {
        await setState({ nextAt: msg.nextAt || 0, current: msg.label || s.current });
      }
      sendResponse({ ok: true });
    } else {
      sendResponse(await snapshot());
    }
  })();
  return true;
});
