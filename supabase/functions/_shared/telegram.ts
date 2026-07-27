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

export interface TelegramSendResult {
  accepted: boolean;
  status: number | null;
  messageId: number | null;
  retryAfterSeconds: number | null;
  error: string;
}

export function telegramConfigured(): boolean {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
  return Boolean(token && chatId);
}

/** Detailed result for durable workers. Never returns Telegram response text or credentials. */
export async function sendTelegramDetailed(text: string): Promise<TelegramSendResult> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
  if (!token || !chatId || !text) {
    return {
      accepted: false,
      status: null,
      messageId: null,
      retryAfterSeconds: null,
      error: !token || !chatId ? "telegram_not_configured" : "telegram_empty_message",
    };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 4096 = Telegram hard cap per message; truncate rather than 400.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    const raw = (await res.text()).slice(0, 4000);
    let payload: Record<string, unknown> = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch (_) {
      // A malformed provider response is represented by the safe error code below.
    }
    const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : {};
    const parameters = payload.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters)
      ? payload.parameters as Record<string, unknown>
      : {};
    const rawMessageId = result.message_id;
    const messageId = typeof rawMessageId === "number" && Number.isSafeInteger(rawMessageId) && rawMessageId > 0
      ? rawMessageId
      : null;
    const rawRetryAfter = parameters.retry_after;
    const retryAfterSeconds = typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter)
      ? Math.min(21600, Math.max(0, Math.ceil(rawRetryAfter)))
      : null;
    const accepted = res.ok && payload.ok === true && messageId !== null;
    return {
      accepted,
      status: res.status,
      messageId,
      retryAfterSeconds,
      error: accepted ? "" : `telegram_http_${res.status}`,
    };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return {
      accepted: false,
      status: null,
      messageId: null,
      retryAfterSeconds: null,
      error: timeout ? "telegram_transport_timeout" : "telegram_transport_error",
    };
  }
}

export async function sendTelegram(text: string): Promise<boolean> {
  return (await sendTelegramDetailed(text)).accepted;
}
