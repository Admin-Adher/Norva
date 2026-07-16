// Best-effort Telegram notifier → the founder's ops channel. Reuses the same bot as the
// box-side Netdata alerts (see ops/hetzner/monitoring/MONITORING.md), but app-side via the
// standard edge-secret pattern: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID on the functions
// container (ops/hetzner/.env → docker-compose.supabase.yml → Deno.env). No-op when the
// vars are unset (local dev, CI) and never throws — notification loss must never fail the
// business write it decorates (ticket stored first, alert sweep completes, etc.).

/** Escape user-provided text for Telegram HTML parse mode. Slice BEFORE escaping. */
export function tgEscape(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegram(text: string): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
  if (!token || !chatId || !text) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 4096 = Telegram hard cap per message; truncate rather than 400.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch (_) {
    return false;
  }
}
