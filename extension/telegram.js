/**
 * Telegram: one message when a run has gone through its whole search -- the last
 * result page captured and every profile on it read -- and one when a run stops on its
 * own, unasked. Every message opens with this extension's name, so several copies
 * sending to one chat can be told apart.
 *
 * The bot is the user's own, entered in the popup and kept in storage.local: nothing
 * ships with the extension. The token is a credential -- anyone holding it can send as
 * that bot -- so it stays on this machine and goes only to api.telegram.org.
 */

import { getName } from "./relay.js";

const KEY = "telegram";

/** The bot as entered in the popup: {token, chatId}, either possibly empty. */
export async function getTelegram() {
  const stored = await chrome.storage.local.get(KEY);
  const t = stored[KEY] || {};
  return { token: String(t.token || "").trim(), chatId: String(t.chatId || "").trim() };
}

export async function setTelegram({ token, chatId }) {
  const next = { token: String(token || "").trim(), chatId: String(chatId || "").trim() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * Send a message: plain text, or Telegram's HTML subset with `parseMode` "HTML". Never
 * throws: a missed notification must not break a run. With no bot set up it sends
 * nothing and says so with `skipped`, which is not a failure.
 */
export async function notifyTelegram(text, parseMode = null) {
  const { token, chatId } = await getTelegram();
  if (!token || !chatId) return { ok: false, skipped: true, error: "no Telegram bot set up" };
  // The name on its own line at the top, bold where the message is HTML.
  const name = await getName();
  const top = parseMode === "HTML" ? `<b>${escapeHtml(name)}</b>` : name;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${top}\n\n${text}`,
                             disable_web_page_preview: true,
                             ...(parseMode ? { parse_mode: parseMode } : {}) }),
    });
    const data = await res.json().catch(() => null);
    return data && data.ok ? { ok: true } : { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A run that stopped by itself: a breaker, a search that would not turn its page, a
 * crash. Plain text, since the reason is whatever the stop said.
 */
export function stoppedMessage(reason, summary) {
  return `Sir, the run stopped unexpectedly:\n${reason}\n\n${summary}\n\n` +
         "Press Start once it is sorted out.";
}

/**
 * A grid drawn with box characters. Telegram has no table markup, but it shows a <pre>
 * block in a monospaced font, where these line up into a real table. Numbers are
 * right-aligned, each column as wide as its widest cell.
 */
export function boxTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const rule = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (cells, align) => "│" + cells.map((c, i) => {
    const t = String(c);
    return " " + (align === "right" ? t.padStart(widths[i]) : t.padEnd(widths[i])) + " ";
  }).join("│") + "│";
  return [rule("┌", "┬", "┐"), line(headers), rule("├", "┼", "┤"),
          ...rows.map((r) => line(r, "right")), rule("└", "┴", "┘")].join("\n");
}

/**
 * The end-of-pool report, as HTML for Telegram: the greeting, the numbers as a table,
 * and the question.
 *
 * Profiles: captured from the search; Enriched: lead pages read in full; Leads: the
 * ones that qualified; Sent: posted to the server this run; Dropped: not sent because
 * the person had been sent before.
 */
export function finishedMessage({ captured, enriched, leads, sent, dropped }) {
  const table = boxTable(["Profiles", "Enriched", "Leads", "Sent", "Dropped"],
                         [[captured, enriched, leads, sent, dropped]]);
  // Only digits and box characters go inside the <pre>: nothing there needs escaping.
  return "Sir, I've finished going through the current pool. Here's the result:\n\n" +
         `<pre>${table}</pre>\n\n` +
         "Shall I move on to a new pool?";
}
