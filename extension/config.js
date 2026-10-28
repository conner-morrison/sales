/**
 * Pacing and limits.
 *
 * The pauses are the pacing: LinkedIn cannot see the extension, it sees behaviour --
 * how fast pages open, how many per session, and whether activity continues after a
 * challenge. Capture pauses less than enrichment because it costs less: ~100 result
 * pages across a run against ~1,500 lead pages, one of which is a page load per person
 * on the client's own account.
 *
 * Before tuning: the pauses are not most of the wall-clock. About 12s per lead goes on
 * LinkedIn's own SPA rendering -- settle_ms, the lazy-history scroll, the stability
 * polls -- and none of that moves however these are set.
 */

export const DEFAULT_CONFIG = {
  capture: {
    settle_ms: 2500,              // let the SPA paint before reading cards
    between_ms: [10000, 20000],   // pause between result pages
    scroll_pause_ms: [2000, 5000],   // between scroll steps while loading a page
    scroll_step: 0.6,
    // 0 = walk to the end of the result set. Off, because enrich.yes_cap is the
    // intended limit: the run ends when the list is long enough rather than after a
    // fixed amount of crawling.
    //
    // What ends a run that never reaches the cap is then the result set itself. Sales
    // Navigator stops paging at around 100 pages, so that is the practical ceiling --
    // ~2,500 cards and, at the current screen, ~800 lead pages. Set a number here if
    // that is further than you want a thin search to carry you.
    max_pages: 0,
    page_timeout_ms: 30000,
  },
  enrich: {
    settle_ms: 3000,              // lead pages are SPA-rendered; let them finish
    // Between the four scroll steps that force a lead page's experience history to
    // load. This is the most expensive number here: it fires four times per lead, on
    // ~1,500 leads, so each second added is about 100 minutes across a full run.
    scroll_pause_ms: [2000, 5000],
    between_ms: [60000, 300000],  // measured AFTER scoring, which is instant
    page_timeout_ms: 30000,
    session_cap: 0,               // 0 = unlimited; stop after this many lead pages
    /**
     * Stop the run once this many people have qualified. 0 = no limit.
     *
     * A ceiling on the useful output rather than on the effort: the list is the point,
     * and once it is long enough there is nothing to gain from opening more profiles on
     * an account that has already been warned once.
     *
     * Whether this or max_pages binds first depends entirely on how selective the
     * persona is. At a 6% qualify rate, 150 people is ~2,500 lead pages -- more than a
     * 100-page capture produces -- so on a narrow persona the page limit still ends the
     * run and this never fires.
     */
    yes_cap: 0,
    /**
     * Stop the whole run after this many consecutive failures.
     *
     * Not a rate limit, and not to be raised casually. A logged-out or challenged
     * session fails every single page, and an earlier version of this tool recorded the
     * error and carried on: 2,168 attempts against 1,985 failures, hours of requests
     * into a login wall. That pattern is far more conspicuous than the reading it was
     * attempting. Three failures in a row means the session is gone, not that three
     * profiles were odd.
     */
    failure_breaker: 3,
  },
};

/** The stored overrides merged over the defaults. */
export async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  const over = config || {};
  return {
    capture: { ...DEFAULT_CONFIG.capture, ...(over.capture || {}) },
    enrich: { ...DEFAULT_CONFIG.enrich, ...(over.enrich || {}) },
  };
}

export async function saveConfig(patch) {
  const { config } = await chrome.storage.local.get("config");
  const next = {
    capture: { ...((config || {}).capture || {}), ...(patch.capture || {}) },
    enrich: { ...((config || {}).enrich || {}), ...(patch.enrich || {}) },
  };
  await chrome.storage.local.set({ config: next });
  return next;
}
