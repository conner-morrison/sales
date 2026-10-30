/**
 * The popup: set the filters, start a run, watch it, take the file or switch sending
 * to the relay on and off.
 *
 * Everything it shows comes from the service worker over chrome.runtime messaging --
 * the popup makes no network call itself; the relay is the worker's to talk to. The
 * polling below is a message to a worker in the same browser, which is why it can
 * afford to be frequent while a run is going.
 */

const $ = (id) => document.getElementById(id);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

let running = false;
let paused = false;
let qualified = 0;
let decided = 0;
let autoOn = false;
let sleeping = false;
let relayWarned = false;

let last = null;          // the most recent state, for the local ticker

/** Seconds until the run acts again, or 0 when it is not waiting on a clock. */
function secondsLeft(nextAt) {
  if (!nextAt) return 0;
  return Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
}

/**
 * The status line: what the run is doing, and how long until the next thing.
 *
 * Driven from the stored state rather than recomputed by the worker, so it can tick
 * every second while the worker is polled every two -- and a 20s pause between result
 * pages reads as a countdown rather than a frozen interface.
 *
 * Note what it cannot count down: the scroll pauses inside capture.js and the lazy-load
 * scroll inside lead.js are the content scripts' own, and the worker is simply blocked
 * waiting for a reply. Those show as "reading page 3" and "reading the profile" with no
 * number, which is honest -- a made-up countdown would be worse than none.
 */
function statusLine(s) {
  // Idle with leads still queued is the state after an interrupted run. Saying so is
  // the difference between "it broke" and "press Start".
  if (s && !s.running && s.pending) return `${s.pending} queued - press Start to carry on`;
  if (!s || !s.running) return (s && s.summary) || "";
  if (s.paused) return "paused - will resume where it stopped";

  const left = secondsLeft(s.nextAt);
  const doing = s.currentName || s.current || "";
  if (!left) return doing;
  // Hours for the night's sleep; seconds read fine for everything shorter.
  const when = left >= 3600
    ? `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m`
    : left >= 600 ? `${Math.floor(left / 60)}m` : `${left}s`;
  return doing ? `${doing} - next in ${when}` : `next in ${when}`;
}

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: "STATE" });
  } catch {
    // The worker is asleep and the message woke nothing; the next tick will get it.
    return;
  }
  if (!s) return;

  running = !!s.running;
  paused = !!s.paused;
  qualified = s.qualified || 0;
  decided = s.decided || 0;

  last = s;
  $("runDot").className = "dot" + (running ? (paused ? "" : " on") : "");
  $("phase").textContent = !running
    ? (s.finishedAt ? "Finished" : "Idle")
    : (paused ? `${cap(s.phase || "run")} — paused` : cap(s.phase || "running"));
  $("session").textContent = statusLine(s);

  const c = s.counts || {};
  $("captured").textContent = c.captured ?? "–";
  $("waiting").textContent = s.pending ?? "–";
  $("enriched").textContent = c.enriched ?? "–";
  $("failed").textContent = c.failed ?? "–";
  $("yes").textContent = c.yes ?? "–";
  $("no").textContent = c.no ?? "–";
  $("skipped").textContent = c.skipped ?? "–";

  // Three states, two buttons: Start alone, or Pause/Resume beside Stop.
  // A run asleep for the night offers to start now instead of to pause.
  sleeping = running && !paused && /^Sleeping until/.test(s.current || "");
  $("runBtn").textContent = !running ? "Start" : sleeping ? "Start now" : (paused ? "Resume" : "Pause");
  $("runBtn").className = !running || sleeping ? "" : (paused ? "" : "pause");
  $("stopBtn").hidden = !running;

  // Enabled by run events alone too: a run that stopped before deciding anyone is the
  // one whose reason is most worth reading.
  $("logBtn").disabled = decided === 0 && !s.events;
  $("logBtn").textContent = decided ? `Download log.txt (${decided})` : "Download log.txt";

  // New since the last download, without repeats of anyone in the history.
  const fresh = (s.relay && s.relay.downloads) || 0;
  $("dlBtn").disabled = fresh === 0;
  $("dlBtn").textContent = fresh ? `Download .txt (${fresh})` : "Download .txt";

  // A switch, not a one-off: on, every lead is sent the moment it qualifies. Always
  // enabled -- pressing it without a channel is how the warning gets shown.
  const rl = s.relay || {};
  autoOn = !!rl.auto;
  const tally = qualified ? ` (${rl.sent || 0}/${qualified})` : "";
  $("sendBtn").textContent = (autoOn ? "Stop sending" : "Send to server") + tally;
  $("sendBtn").className = autoOn ? "stop" : "ghost";

  showRelay(rl);

  $("ver").textContent = "v" + (s.version || chrome.runtime.getManifest().version);
  if (s.stats && s.stats.lastError) $("err").textContent = cap(s.stats.lastError);
}

$("runBtn").addEventListener("click", () => {
  $("err").textContent = "";
  const type = !running ? "START" : sleeping ? "WAKE" : (paused ? "RESUME" : "PAUSE");
  chrome.runtime.sendMessage({ type }).then((r) => {
    if (r && r.startError) $("err").textContent = cap(r.startError);
    setTimeout(refresh, 300);
  });
});

// Stop ends the run: the leads it had not reached go back on the queue, so pressing
// Start again picks them up rather than losing them.
$("stopBtn").addEventListener("click", () => {
  $("err").textContent = "";
  chrome.runtime.sendMessage({ type: "STOP" }).then(() => setTimeout(refresh, 300));
});

/** The relay row: where registration stands, and the channel once there is one. */
function showRelay(r) {
  const st = r.status || "none";
  $("relayDot").className = "dot" + (st === "approved" ? (r.channel ? " on" : " wait")
                                   : st === "pending" ? " wait"
                                   : st === "rejected" ? " bad" : "");
  $("relayState").textContent =
      st === "approved" ? (r.channel ? `Channel: ${r.channel}` : "Registered - no channel yet")
    : st === "pending"  ? "Waiting for approval" + (r.fingerprint ? ` · ${r.fingerprint}` : "")
    : st === "rejected" ? "Refused by the server"
    : "Not registered";
  $("relayState").title = $("relayState").textContent;
  // Why sending stopped, or why the last lead did not go -- and cleared once it is no
  // longer true, without wiping a warning that came from a click.
  if (r.error) { warn(cap(r.error)); relayWarned = true; }
  else if (relayWarned) { warn(""); relayWarned = false; }
  $("regBtn").hidden = st === "approved";
  $("regBtn").disabled = st === "pending";
  $("regBtn").textContent = st === "pending" ? "Request sent" : "Register";
  $("relayResetBtn").hidden = st === "none";
  // The server has the name it registered with; editing it now would change nothing there.
  $("nameIn").disabled = st !== "none" && st !== "rejected";
  $("nameIn").title = $("nameIn").disabled ? "Forget the registration to change the name" : "";
}

$("dlBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  const r = await chrome.runtime.sendMessage({ type: "DOWNLOAD" });
  $("err").textContent = r && r.ok
    ? `Saved ${r.filename} — ${r.count} URL(s).`
    : cap((r && r.error) || "Download failed");
});

// Saved from here, not by the worker: the popup can make a Blob URL, which has no size
// limit worth worrying about, where the worker could only use a data: URL.
$("logBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  const r = await chrome.runtime.sendMessage({ type: "LOG_TEXT" });
  if (!r || !r.ok) {
    $("err").textContent = cap((r && r.error) || "Could not read the log");
    return;
  }
  const url = URL.createObjectURL(new Blob([r.text], { type: "text/plain" }));
  try {
    await chrome.downloads.download({ url, filename: "log.txt", saveAs: false });
    $("err").textContent = `Saved log.txt — ${r.count} profile(s).`;
  } catch (e) {
    $("err").textContent = cap(String((e && e.message) || e));
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
});

// history.txt is saved from here, like the log: it only grows.
$("histBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  const r = await chrome.runtime.sendMessage({ type: "HISTORY_TEXT" });
  if (!r || !r.ok) {
    $("err").textContent = cap((r && r.error) || "Could not read the history");
    return;
  }
  const url = URL.createObjectURL(new Blob([r.text], { type: "text/plain" }));
  try {
    await chrome.downloads.download({ url, filename: "history.txt", saveAs: false });
    $("err").textContent = `Saved history.txt — ${r.count} lead(s).`;
  } catch (e) {
    $("err").textContent = cap(String((e && e.message) || e));
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
});

// --- filters ----------------------------------------------------------------------

const BOXES = {
  fAI: ["stacks", "ai"], fFull: ["stacks", "fullstack"], fData: ["stacks", "data"],
  fBS: ["degrees", "bs"], fMS: ["degrees", "ms"], fPhD: ["degrees", "phd"],
  fMBA: ["degrees", "mba"],
  fSpeak: ["speaking"], fCompany: ["big_company"], fUni: ["big_university"],
  aStack: ["all", "stacks"], aBack: ["all", "background"], aDeg: ["all", "degrees"],
};

// Beside each group's AND box: how the ticked boxes in it combine.
const MODES = { aStack: "mStack", aBack: "mBack", aDeg: "mDeg" };

function showModes() {
  for (const [box, span] of Object.entries(MODES)) {
    $(span).textContent = $(box).checked ? "(all ticked)" : "(any ticked)";
  }
}

function showFilters(f) {
  $("fYears").value = f.min_years;
  for (const [id, path] of Object.entries(BOXES)) {
    $(id).checked = !!(path.length === 2 ? f[path[0]][path[1]] : f[path[0]]);
  }
  showModes();
}

function readFilters() {
  const f = { min_years: Math.max(0, Number($("fYears").value) || 0),
              stacks: {}, degrees: {}, all: {} };
  for (const [id, path] of Object.entries(BOXES)) {
    if (path.length === 2) f[path[0]][path[1]] = $(id).checked;
    else f[path[0]] = $(id).checked;
  }
  return f;
}

async function saveFilters() {
  showModes();
  const f = await chrome.runtime.sendMessage({ type: "SET_FILTERS", filters: readFilters() });
  if (f) showFilters(f);
}

$("fYears").addEventListener("change", saveFilters);
for (const id of Object.keys(BOXES)) $(id).addEventListener("change", saveFilters);

chrome.runtime.sendMessage({ type: "GET_FILTERS" }).then((f) => { if (f) showFilters(f); })
  .catch(() => {});

// --- name and Telegram ------------------------------------------------------------

function showSettings(st) {
  // The default is the placeholder, so an empty box means "unnamed".
  $("nameIn").value = st.name === "LinkedIn Harvester" ? "" : st.name;
  $("tgToken").value = st.telegram.token;
  $("tgChat").value = st.telegram.chatId;
}

$("nameIn").addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", name: $("nameIn").value }));

for (const id of ["tgToken", "tgChat"]) {
  $(id).addEventListener("change", () => chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    telegram: { token: $("tgToken").value, chatId: $("tgChat").value },
  }));
}

$("tgTestBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  $("tgTestBtn").disabled = true;
  // Saved first: a value typed but not yet blurred has not fired "change".
  await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    telegram: { token: $("tgToken").value, chatId: $("tgChat").value },
  });
  const r = await chrome.runtime.sendMessage({ type: "TEST_TELEGRAM" });
  $("tgTestBtn").disabled = false;
  $("err").textContent = r && r.ok ? "Test message sent."
                                   : cap((r && r.error) || "Telegram test failed");
});

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).then((st) => { if (st) showSettings(st); })
  .catch(() => {});

function warn(text) {
  $("warn").textContent = text || "";
  $("warn").hidden = !text;
}

$("sendBtn").addEventListener("click", async () => {
  $("err").textContent = "";
  warn("");
  $("sendBtn").disabled = true;
  const r = await chrome.runtime.sendMessage({ type: autoOn ? "AUTO_OFF" : "AUTO_ON" });
  $("sendBtn").disabled = false;
  if (r && !r.ok) warn(cap(r.error || "Could not start sending"));
  refresh();
});

$("regBtn").addEventListener("click", async () => {
  warn("");
  $("err").textContent = "";
  $("regBtn").disabled = true;
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", name: $("nameIn").value });
  const r = await chrome.runtime.sendMessage({ type: "REGISTER" });
  $("err").textContent = r && r.ok
    ? "Registration requested - approve it in the relay console."
    : cap((r && r.error) || "Registration failed");
  refresh();
});

$("relayResetBtn").addEventListener("click", async () => {
  warn("");
  await chrome.runtime.sendMessage({ type: "RELAY_RESET" });
  refresh();
});

// Two presses rather than a dialog: a popup cannot show window.confirm without closing
// itself. Nothing is kept between runs anyway, so what this loses is the current
// result set -- which is worth one confirmation if the file has not been taken yet.
let clearArmed = null;

$("clearBtn").addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = setTimeout(() => {
      clearArmed = null;
      $("clearBtn").textContent = "Clear results";
      $("clearBtn").classList.remove("arm");
    }, 4000);
    $("clearBtn").textContent = qualified
      ? `Press again — ${qualified} qualified will be lost`
      : "Press again to clear";
    $("clearBtn").classList.add("arm");
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  $("clearBtn").textContent = "Clear results";
  $("clearBtn").classList.remove("arm");

  const r = await chrome.runtime.sendMessage({ type: "CLEAR" });
  $("err").textContent = r && r.ok ? "Cleared." : cap((r && r.error) || "Clear failed");
  refresh();
});

// The countdown ticks locally. Asking the worker every second to be told a number it
// already handed over would wake the service worker sixty times a minute for nothing.
setInterval(() => {
  if (last && last.running && !last.paused && last.nextAt) {
    $("session").textContent = statusLine(last);
  }
}, 500);

(async () => {
  refresh();
  // Two seconds while a run is on, because the phase and the current profile change
  // that often. Fifteen when idle: nothing moves, and there is no reason to keep
  // waking the service worker to be told so.
  let tick = null;
  const pace = () => {
    const waiting = last && last.relay && (last.relay.status === "pending" ||
                    (last.relay.status === "approved" && !last.relay.channel));
    const want = running ? 2000 : (waiting ? 3000 : 15000);   // paused counts as running: Resume should feel instant
    if (tick && tick.ms === want) return;
    if (tick) clearInterval(tick.id);
    tick = { ms: want, id: setInterval(() => { refresh().then(pace); }, want) };
  };
  pace();
})();
