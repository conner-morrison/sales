/**
 * Content script for Sales Navigator SEARCH RESULTS.
 *
 * Reads the visible result cards. Makes no network requests of its own -- everything
 * here comes from the DOM the page already rendered, which is why capture is close to
 * invisible at the account level: paging a search costs one page load per ~25 leads.
 *
 * Field mapping was established by probing a live result set, not guessed. Note the
 * trap: on a search card `data-anonymize="job-title"` holds the TENURE line
 * ("4 years 2 months in role"), and the real job title is under `title`. On a LEAD page
 * the same attribute means the opposite. lead.js handles that page; do not share code.
 */

const CARD_SEL = '[data-x-search-result="LEAD"]';

const clean = (s) => (s || "").replace(/\s+/g, " ").trim() || null;

function textOf(root, attr) {
  const el = root.querySelector(`[data-anonymize="${attr}"]`);
  if (!el) return null;
  return clean(el.innerText || el.textContent);
}

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

/** Cards are rooted at the <li>: the search-result marker sits on an inner element,
 *  and the headshot lives outside it. */
function cards() {
  const marked = [...document.querySelectorAll(CARD_SEL)]
    .map((m) => m.closest("li") || m);
  if (marked.length) return [...new Set(marked)];
  // Fallback for a markup change: anything that links to a lead.
  return [...new Set([...document.querySelectorAll('a[href*="/sales/lead/"]')]
    .map((a) => a.closest("li")).filter(Boolean))];
}

function leadIdFrom(card) {
  const href = card.querySelector('a[href*="/sales/lead/"]')?.getAttribute("href") || "";
  const direct = href.match(/\/sales\/lead\/([^,?/]+)/);
  if (direct) return { id: direct[1], url: href };
  // Some rows carry the id only as a URN on the scroll anchor.
  const urn = card.querySelector("[data-scroll-into-view]")
    ?.getAttribute("data-scroll-into-view") || "";
  const m = urn.match(/fs_salesProfile:\(([^,)]+)/);
  return m ? { id: m[1], url: `/sales/lead/${m[1]}` } : null;
}

function readCard(card) {
  const lead = leadIdFrom(card);
  if (!lead) return null;
  // The name, plus the three fields the scorer reads. The card also carries a
  // headshot and a location; neither is read, because the verdict does not use them
  // and a face is the most identifying thing on the card.
  return {
    lead_id: lead.id,
    lead_url: lead.url,
    full_name: textOf(card, "person-name"),
    title: textOf(card, "title"),          // NOT "job-title" -- that is the tenure line
    company: textOf(card, "company-name"),
    headline: textOf(card, "person-blurb"),
    // "1 year 1 month in role 1 year 1 month in company". Confusingly filed under
    // job-title on a search card -- see the note above readCard. Sent raw and parsed
    // by tenure.js, where the parser is tested.
    tenure_text: textOf(card, "job-title"),
  };
}

/**
 * Every ancestor of `el` that has its own scrollbar, innermost first.
 *
 * Needed because the list is not scrolled by the window. The page has about a pixel of
 * slack, so window.scrollTo did nothing, and scrollIntoView moved the page enough to
 * nudge LinkedIn's sticky chrome -- a visible layout change that looks like progress
 * while the row container never moves and no rows load.
 */
function scrollableAncestors(el) {
  const found = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight - n.clientHeight > 20) {
      found.push(n);
    }
  }
  return found;
}

/**
 * How many results this page should yield.
 *
 * Sales Navigator paginates at 25, but the last page holds fewer, and stopping short
 * of 25 there is correct rather than a shortfall. The header states the actual range --
 * "1 - 25 of 2,431 results" -- which answers both cases, so it is read rather than
 * assumed. Null when the header cannot be found: then there is no target and the
 * collector falls back to "stop when the list stops growing".
 */
function expectedOnPage() {
  const text = document.body ? document.body.innerText : "";
  const m = text.match(/(\d[\d,]*)\s*[-\u2013\u2014]\s*(\d[\d,]*)\s+of\s+[\d,]+/i);
  if (!m) return null;
  const from = +m[1].replace(/,/g, "");
  const to = +m[2].replace(/,/g, "");
  return to >= from && to - from < 200 ? to - from + 1 : null;
}

/**
 * Walk the result list, collecting rows as they appear.
 *
 * Paced deliberately: a screenful every 1.5-3s, jittered, which is roughly reading
 * speed. Going faster gains nothing -- the rows need that long to load regardless --
 * and a page scrolled end to end in a few hundred milliseconds is not what a person
 * browsing a search looks like.
 *
 * Scrolls a screenful at a time rather than jumping to the end: a lazy loader watching
 * for a threshold may never fire if the container goes straight from top to bottom, and
 * a virtualiser unmounts what it passes. Harvesting into a Map keyed by lead id makes
 * both harmless -- a row only has to exist once, at some point.
 *
 * Needs several quiet passes before concluding the list has ended. One is not enough:
 * a slow batch is indistinguishable from the end after a single tick, which is how a
 * 25-lead page kept reporting 3.
 */
async function collectAllLeads(opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Pacing comes from config.js, passed in by the service worker.
  const [pMin, pMax] = opts.pauseMs || [2000, 5000];
  const step = opts.step || 0.6;
  const idlePasses = opts.idlePasses || 4;
  const maxPasses = opts.maxPasses || 120;
  // How many times to back off and come down again when the bottom is reached short of
  // the target. Each one costs a pause, so it is bounded.
  const maxNudges = opts.maxNudges === undefined ? 3 : opts.maxNudges;
  // Uniform pauses at a constant step are their own pattern. Both vary, and roughly
  // one step in five gets a longer pause -- the equivalent of stopping to read
  // something before carrying on.
  const pause = () => {
    const base = pMin + Math.random() * (pMax - pMin);
    const dwell = Math.random() < 0.2 ? 1.6 + Math.random() * 1.4 : 1;
    return Math.floor(base * dwell);
  };

  /**
   * Pause, and tell the worker how long for so the popup can count it down.
   *
   * The worker is blocked awaiting our reply for the whole of a page read, so it cannot
   * know on its own: without this the interface reads "Reading page 3" and then sits
   * still for a minute, which is indistinguishable from a hang. Fire and forget -- a
   * failed report must never interrupt a capture.
   */
  const waitScroll = async (n) => {
    const ms = pause();
    if (extensionAlive()) {
      try {
        chrome.runtime.sendMessage({
          type: "PROGRESS", nextAt: Date.now() + ms, label: `scrolling (pass ${n})`,
        }).catch(() => {});
      } catch { /* worker asleep; the capture carries on regardless */ }
    }
    await sleep(ms);
  };
  // Step jitters +/-25% around the configured fraction, so no two passes advance by
  // exactly the same amount.
  const stepNow = () => step * (0.75 + Math.random() * 0.5);

  // What this page owes us. Without it the collector could only ask "has the list
  // stopped growing?", and a lazy loader that pauses for a few seconds looks exactly
  // like a finished one -- which is how pages returned 19 of 25 and reported success.
  const target = opts.target || expectedOnPage();

  const found = new Map();
  let idle = 0, passes = 0, scrolled = 0, nudges = 0, atBottom = false;

  const harvest = () => {
    for (const card of cards()) {
      const lead = readCard(card);
      if (lead && lead.lead_id && !found.has(lead.lead_id)) found.set(lead.lead_id, lead);
    }
  };

  harvest();
  while (passes++ < maxPasses) {
    const before = found.size;
    const rows = cards();
    const last = rows[rows.length - 1];
    const containers = last ? scrollableAncestors(last) : [];

    if (containers.length) {
      // Advance each real scroller by a screenful. Assigning scrollTop fires a
      // native scroll event, which is what a lazy loader is listening for.
      for (const c of containers) {
        const room = c.scrollHeight - c.clientHeight - c.scrollTop;
        if (room > 4) {
          c.scrollTop = Math.min(c.scrollTop + c.clientHeight * stepNow(),
                                 c.scrollHeight);
          scrolled++;
        }
      }
      atBottom = containers.every(
        (c) => c.scrollHeight - c.clientHeight - c.scrollTop <= 4);
    } else if (last) {
      last.scrollIntoView({ block: "end" });   // nothing has its own scrollbar
      atBottom = window.innerHeight + window.scrollY
                 >= document.documentElement.scrollHeight - 4;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);

    await waitScroll(passes);
    harvest();
    idle = found.size > before ? 0 : idle + 1;

    if (target && found.size >= target) break;      // the page is complete

    // Being short at the bottom is not the same as being finished. A virtualised list
    // sometimes needs the scroll position to move back before it will mount the rest,
    // so back off and come down again rather than giving up on the remainder.
    if (atBottom && idle >= idlePasses && target && found.size < target
        && nudges < maxNudges) {
      nudges++;
      for (const c of containers) c.scrollTop = Math.max(0, c.scrollTop - c.clientHeight * 2);
      await waitScroll(passes);
      harvest();
      idle = 0;
      continue;
    }

    // Stop only once the list has gone quiet AND there is nowhere left to scroll.
    // Idleness alone used to end the walk halfway down a slow-loading page.
    if (idle >= idlePasses && (atBottom || !containers.length)) break;
    if (idle >= idlePasses * 4) break;              // hard stop: nothing is moving
  }

  const first = cards()[0];
  if (first) {
    for (const c of scrollableAncestors(first)) c.scrollTop = 0;
    first.scrollIntoView({ block: "start" });
  }
  await sleep(250);
  return { leads: [...found.values()], passes, scrolled, target, nudges,
           atBottom, short: !!(target && found.size < target) };
}

/** True once the results have actually rendered, rather than merely being requested. */
function resultsReady() {
  return cards().length > 0;
}

/** Wait for the result list to stop growing. Sales Navigator renders results well after
 *  load, so a fixed sleep either wastes time or reads a half-painted list. */
function waitForResults(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let last = -1, stable = 0;
    const tick = () => {
      const n = cards().length;
      stable = n > 0 && n === last ? stable + 1 : 0;
      last = n;
      if (stable >= 3) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(n > 0);
      setTimeout(tick, 400);
    };
    tick();
  });
}

/** What went wrong, in a form that is diagnosable rather than a guess. */
function pageState() {
  const url = location.href;
  if (!/\/sales\//.test(url)) return `redirected_away [${url.slice(0, 80)}]`;
  const txt = (document.body?.innerText || "").slice(0, 2000);
  if (/sign in|join linkedin|session expired/i.test(txt)) return "auth_wall";
  if (/no results|couldn't find/i.test(txt)) return "no_results";
  return null;
}

/** The pagination control. Clicked, never synthesised as a URL: driving the real button
 *  is both more reliable across markup changes and ordinary page use. */
function nextButton() {
  return [...document.querySelectorAll("button")].find((b) => {
    const t = ((b.getAttribute("aria-label") || "") + " " + (b.innerText || "")).toLowerCase();
    return t.includes("next") && !b.disabled;
  }) || null;
}

/**
 * Why did this page yield what it did?
 *
 * Gathered on the page and handed back with the leads, because asking a person to
 * paste console output has now failed four times -- wrong page, stale build, or a probe
 * that printed nothing useful. The extension is already here; it can answer for itself.
 */
function diagnose() {
  const sel = {
    marker: document.querySelectorAll('[data-x-search-result="LEAD"]').length,
    marker_li: new Set([...document.querySelectorAll('[data-x-search-result="LEAD"]')]
      .map((m) => m.closest("li")).filter(Boolean)).size,
    lead_links: document.querySelectorAll('a[href*="/sales/lead/"]').length,
    lead_link_li: new Set([...document.querySelectorAll('a[href*="/sales/lead/"]')]
      .map((a) => a.closest("li")).filter(Boolean)).size,
    person_name: document.querySelectorAll('[data-anonymize="person-name"]').length,
    all_li: document.querySelectorAll("li").length,
  };

  const scrollers = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollHeight - el.clientHeight < 40 || el.clientHeight < 120) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    scrollers.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString()
      .split(/\s+/)[0] || "-"} h=${el.clientHeight}/${el.scrollHeight}`);
    if (scrollers.length >= 5) break;
  }

  const m = (document.body.innerText.match(/([\d,]+)\s*results?/i) || [])[0] || null;
  return {
    selectors: sel,
    scrollers,
    doc: `${document.documentElement.clientHeight}/${document.documentElement.scrollHeight}`,
    results_text: m,
  };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "CAPTURE_PAGE") {
    (async () => {
      await waitForResults(msg.timeoutMs || 30000);
      const beforeScroll = cards().length;
      const problem = pageState();
      if (problem && !resultsReady()) {
        sendResponse({ ok: false, error: problem, leads: [] });
        return;
      }
      const { leads, passes, scrolled, target, nudges, atBottom, short } =
        await collectAllLeads({
          pauseMs: msg.scrollPauseMs, step: msg.scrollStep,
        });
      sendResponse({
        ok: leads.length > 0,
        leads,
        cards_seen: cards().length,
        // Reported so a shortfall is visible in the log rather than silent: if
        // scrolling keeps revealing rows, the viewport was hiding them.
        cards_before_scroll: beforeScroll,
        scroll_passes: passes,
        scroll_moves: scrolled,
        // What the page said it held, and whether we got it. A shortfall against a
        // stated target is a fact, not a guess, and belongs in the record.
        target,
        short,
        scroll_nudges: nudges,
        at_bottom: atBottom,
        diag: diagnose(),
        has_next: !!nextButton(),
        error: leads.length ? null : (problem || "no_leads_parsed"),
      });
    })();
    return true;
  }

  if (msg?.type === "CAPTURE_NEXT") {
    const btn = nextButton();
    if (!btn) {
      sendResponse({ ok: false, end: true, error: "no_next_button" });
      return true;
    }
    btn.click();
    sendResponse({ ok: true, end: false });
    return true;
  }
});
