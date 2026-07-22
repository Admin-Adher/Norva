// norva-support — support tickets, both sides of the conversation.
//
// USER routes (Supabase JWT):
//   POST /create {subject, body}    → open a ticket + first message; email support@norva.tv
//   POST /reply  {ticket_id, body}  → reply on own ticket (reopens it); email support@norva.tv
//   POST /close  {ticket_id}        → mark own ticket resolved (frees the open-tickets cap)
//   GET  /mine                      → own tickets with full threads (powers support.html)
// ADMIN routes (JWT with app_metadata.role='admin'):
//   POST /admin/reply  {ticket_id, body}   → reply; ticket → 'pending'; EMAILS THE CLIENT
//   POST /admin/status {ticket_id, status} → open | pending | closed
//
// Tables are RLS-on with no policies: this function (service role) and the admin RPCs are the only
// doors. Each message and its exact outbound Resend request commit atomically. The API returns the
// durable delivery state; a cron-authenticated worker later leases, sends and CAS-acknowledges the
// request. A provider outage can therefore delay an email but cannot lose the support message.
//
// Mail routing is intentionally explicit. User messages go only to NORVA_SUPPORT_EMAIL (or the
// fixed support@norva.tv default), with Reply-To set to the authenticated user's address. Admin
// replies go only to that ticket owner's current Auth address, with Reply-To set to the same support
// inbox. We never discover recipients from admins/internal accounts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTelegram, tgEscape } from "../_shared/telegram.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPPORT_FROM = Deno.env.get("SUPPORT_EMAIL_FROM")?.trim() || "Norva Support <support@norva.tv>";
const SUPPORT_INBOX = Deno.env.get("NORVA_SUPPORT_EMAIL")?.trim().toLowerCase() || "support@norva.tv";
const SITE_URL = "https://norva.tv";
const SUPPORT_DELIVERY_BATCH = 4;
const SUPPORT_DELIVERY_SPACING_MS = 300;

// Anti-abuse: every user message emails support@ (Resend cost + inbox flood). Cap concurrent open
// tickets and hourly message volume per user, and drop identical consecutive bodies.
const MAX_OPEN_TICKETS = 8;
const MAX_MSGS_PER_HOUR = 20;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function cleanEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 320 || /[\r\n<>]/.test(email)) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanSubject(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

// Minimal branded shell (same look as the lifecycle emails).
function shell(
  heading: string,
  bodyHtml: string,
  cta?: { label: string; url: string },
  lang: "en" | "fr" = "en",
): string {
  const button = cta
    ? `<tr><td align="center" style="padding:8px 0 26px"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#5b7cfa" style="background:#5b7cfa;border-radius:10px;mso-padding-alt:14px 30px"><a href="${esc(cta.url)}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;line-height:1;text-decoration:none">${esc(cta.label)}</a></td></tr></table></td></tr>`
    : "";
  return `<!doctype html><html lang="${lang}" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(heading)}</title></head><body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(heading)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="520" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:520px;background:#11151d;border:1px solid #1f2733;border-radius:16px;border-collapse:separate">
      <tr><td style="padding:28px 32px 6px;text-align:center">
        <div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700">Norva</div></td></tr>
      <tr><td style="padding:14px 32px 6px"><h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;line-height:1.35">${esc(heading)}</h1></td></tr>
      <tr><td style="padding:12px 32px 18px;color:#9aa6bd;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65">${bodyHtml}</td></tr>
      ${button}
    </table>
    <div style="color:#667085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;margin-top:16px">&copy; Norva</div>
  </td></tr></table></body></html>`;
}

type SupportMailDirection = "user_to_support" | "support_to_user";
type FrozenSupportEmail = {
  recipientEmail: string;
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
};
type SupportMutationResult = {
  ticket_id: string;
  message_id: string;
  request_id: string;
  deduped: boolean;
  delivery_state: string;
};
type SupportDeliveryClaim = {
  delivery_key: string;
  request_id: string;
  lease_token: string;
  direction: SupportMailDirection;
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
  attempt_count: number;
};
type MailDeliveryResult = {
  accepted: boolean;
  status: number | null;
  emailId: string | null;
  response: JsonRecord;
  errorCode: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
};

function supportTags(direction: SupportMailDirection): FrozenSupportEmail["tags"] {
  return [
    { name: "app", value: "norva" },
    { name: "category", value: "transactional" },
    { name: "flow", value: direction === "user_to_support"
      ? "support_customer_message" : "support_agent_reply" },
  ];
}

function supportInboxEmail(kind: "new" | "reply", userEmail: string, subject: string, body: string): FrozenSupportEmail {
  const heading = kind === "new" ? "Nouveau ticket support" : "Réponse client sur un ticket";
  const safeEmail = cleanEmail(userEmail) ?? "Adresse client indisponible";
  const safeSubject = cleanSubject(subject);
  const html = shell(heading,
    `<b style="color:#cdd6e6">Ticket #{{ticket_ref}}</b><br><b style="color:#cdd6e6">${esc(safeEmail)}</b> — « ${esc(safeSubject)} »<br><br>
     <div style="background:#0d1117;border:1px solid #1f2733;border-radius:10px;padding:12px 14px;color:#e8e8ee;white-space:pre-wrap">${esc(body.slice(0, 4000))}</div><br>
     Répondre depuis le CRM (fiche client + page Support) pour garder le fil tracé.`,
    { label: "Ouvrir le CRM", url: `${SITE_URL}/app#admin` },
    "fr");
  return {
    recipientEmail: SUPPORT_INBOX,
    from: SUPPORT_FROM,
    replyTo: safeEmail,
    subject: `[Norva Support #{{ticket_ref}}] ${safeSubject}`,
    html,
    text: `${heading}\n\nTicket #{{ticket_ref}}\nClient: ${safeEmail}\nSujet: ${safeSubject}\n\n${body.slice(0, 4000)}\n\nRépondre depuis le CRM pour garder le fil tracé.`,
    tags: supportTags("user_to_support"),
  };
}

function supportClientEmail(subject: string, body: string): FrozenSupportEmail {
  const safeSubject = cleanSubject(subject);
  const html = shell("We replied to your support request",
    `Ticket #{{ticket_ref}} — « <b style="color:#cdd6e6">${esc(safeSubject)}</b> » has a new reply:<br><br>
     <div style="background:#0d1117;border:1px solid #1f2733;border-radius:10px;padding:12px 14px;color:#e8e8ee;white-space:pre-wrap">${esc(body.slice(0, 4000))}</div><br>
     Reply to this email or use your support page. Replies from the support page stay attached to your ticket.`,
    { label: "Open my support page", url: `${SITE_URL}/support.html?ticket={{ticket_id}}` });
  return {
    // The append RPC resolves the ticket owner's current Auth address inside the
    // same transaction. This placeholder is ignored for support_to_user.
    recipientEmail: "recipient-resolved-by-database@norva.tv",
    from: SUPPORT_FROM,
    replyTo: SUPPORT_INBOX,
    subject: `Re: [Norva Support #{{ticket_ref}}] ${safeSubject}`,
    html,
    text: `We replied to your support request\n\nTicket #{{ticket_ref}}: ${safeSubject}\n\n${body.slice(0, 4000)}\n\nReply to this email or use your support page: ${SITE_URL}/support.html?ticket={{ticket_id}}`,
    tags: supportTags("support_to_user"),
  };
}

function redactDiagnostic(value: unknown): string {
  let text = "";
  if (value instanceof Error) text = value.message;
  else if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); } catch (_) { text = "unknown_error"; }
  }
  return text
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu, "[redacted-email]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:Bearer\s+|re_|whsec_)[A-Za-z0-9._~+\/-]+/giu, "[redacted-secret]")
    .slice(0, 1000) || "unknown_error";
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Math.min(21600, Number(value.trim())));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(21600, Math.ceil((at - Date.now()) / 1000))) : null;
}

function safeProviderResponse(payload: JsonRecord, emailId: string | null): JsonRecord {
  if (emailId) return { id: emailId };
  const nested = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonRecord : null;
  const result: JsonRecord = {};
  for (const key of ["name", "type", "code", "statusCode"] as const) {
    const value = payload[key] ?? nested?.[key];
    if (typeof value === "string" || typeof value === "number") result[key] = redactDiagnostic(value).slice(0, 200);
  }
  const message = payload.message ?? nested?.message ?? payload.error;
  if (message !== undefined && message !== null) result.message = redactDiagnostic(message);
  return result;
}

function classifyRetry(status: number | null, providerCode: string, acceptedWithoutId = false): boolean {
  if (acceptedWithoutId || status === null) return true;
  if (status === 409) {
    // Resend uses 409 both for an in-flight request (safe to retry) and for an
    // idempotency key reused with different parameters (invalid, never retry).
    return /concurrent|in[_ -]?progress|already[_ -]?processing/i.test(providerCode);
  }
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sendMail(claim: SupportDeliveryClaim): Promise<MailDeliveryResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Support-Email/2.0",
        "Idempotency-Key": claim.delivery_key,
      },
      body: JSON.stringify({
        from: claim.request_from,
        to: [claim.recipient_email],
        reply_to: claim.request_reply_to,
        subject: claim.request_subject,
        html: claim.request_html,
        text: claim.request_text,
        tags: claim.request_tags,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const raw = await res.text();
    let payload: JsonRecord = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
    } catch (_) { payload = {}; }
    const emailId = typeof payload.id === "string" && payload.id.trim()
      ? payload.id.trim().slice(0, 200) : null;
    const safeResponse = safeProviderResponse(payload, emailId);
    const providerCode = redactDiagnostic(
      safeResponse.code ?? safeResponse.name ?? safeResponse.type ?? safeResponse.message ?? `resend_http_${res.status}`,
    );
    const accepted = res.ok && Boolean(emailId);
    return {
      accepted,
      status: res.status,
      emailId,
      response: safeResponse,
      errorCode: accepted ? "" : (res.ok ? "resend_missing_id" : providerCode),
      retryable: classifyRetry(res.status, providerCode, res.ok && !emailId),
      retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after")),
    };
  } catch (error) {
    const code = error instanceof DOMException && error.name === "TimeoutError"
      ? "transport_timeout"
      : "transport_error";
    return {
      accepted: false,
      status: null,
      emailId: null,
      response: {},
      errorCode: code,
      retryable: true,
      retryAfterSeconds: null,
    };
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function drainSupportEmailOutbox(): Promise<Record<string, number | boolean>> {
  if (!RESEND_API_KEY) return { configured: false, claimed: 0, sent: 0, retry_scheduled: 0, dead_letter: 0, deferred: 0, lease_lost: 0 };
  const { data, error } = await db.rpc("claim_support_email_deliveries", {
    p_batch: SUPPORT_DELIVERY_BATCH,
    p_lease_seconds: 90,
    p_max_attempts: 12,
  });
  if (error) throw new Error(`support_email_claim_failed:${redactDiagnostic(error.message)}`);
  const claims = (Array.isArray(data) ? data : []) as SupportDeliveryClaim[];
  const result = { configured: true, claimed: claims.length, sent: 0, retry_scheduled: 0, dead_letter: 0, deferred: 0, lease_lost: 0, accepted_unacknowledged: 0 };
  let networkAttempts = 0;
  let sharedRetryAfter: number | null = null;
  for (const claim of claims) {
    if (sharedRetryAfter !== null) {
      const { data: deferred, error: deferError } = await db.rpc("defer_support_email_delivery", {
        p_delivery_key: claim.delivery_key,
        p_lease_token: claim.lease_token,
        p_retry_after_seconds: sharedRetryAfter,
      });
      if (deferError || deferred !== true) result.lease_lost++;
      else result.deferred++;
      continue;
    }
    if (networkAttempts > 0) await sleep(SUPPORT_DELIVERY_SPACING_MS);
    const sent = await sendMail(claim);
    networkAttempts++;
    if (sent.status === 429) sharedRetryAfter = Math.max(1, sent.retryAfterSeconds ?? 60);
    if (sent.accepted && sent.emailId) {
      const { data: completed, error: completeError } = await db.rpc("complete_support_email_delivery", {
        p_delivery_key: claim.delivery_key,
        p_lease_token: claim.lease_token,
        p_resend_email_id: sent.emailId,
        p_http_status: sent.status,
        p_response: sent.response,
      });
      if (completeError || completed !== true) {
        result.accepted_unacknowledged++;
        console.error(`[norva-support] accepted delivery acknowledgement failed key=${claim.delivery_key.slice(0, 32)}`);
      } else result.sent++;
      continue;
    }
    const { data: failed, error: failError } = await db.rpc("fail_support_email_delivery", {
      p_delivery_key: claim.delivery_key,
      p_lease_token: claim.lease_token,
      p_http_status: sent.status,
      p_error: sent.errorCode,
      p_response: sent.response,
      p_retryable: sent.retryable,
      p_retry_after_seconds: sent.retryAfterSeconds,
      p_max_attempts: 12,
    });
    if (failError) result.lease_lost++;
    else if (failed === "dead_letter") result.dead_letter++;
    else if (failed === "retry_scheduled") result.retry_scheduled++;
    else result.lease_lost++;
  }
  return result;
}

async function cronAuthorized(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!token) return false;
  const { data, error } = await db.rpc("norva_verify_cron_secret", { presented: token });
  return !error && data === true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requestId(req: Request, bodyValue: unknown): string | null {
  const supplied = String(bodyValue ?? req.headers.get("x-request-id") ?? "").trim();
  if (!supplied) return crypto.randomUUID();
  return UUID_RE.test(supplied) ? supplied.toLowerCase() : null;
}

function emailDeliveryView(result: SupportMutationResult) {
  return { state: result.delivery_state, request_id: result.request_id };
}

function supportRpcError(error: { message?: string } | null): Response {
  const message = String(error?.message ?? "");
  if (message.includes("support_request_id_conflict")) return json({ error: "Request id already belongs to another support message" }, 409);
  if (message.includes("support_ticket_not_found")) return json({ error: "Ticket not found" }, 404);
  if (message.includes("support_recipient_unavailable")) return json({ error: "The account has no deliverable email address" }, 409);
  console.error(`[norva-support] atomic support write failed code=${redactDiagnostic(message).slice(0, 160)}`);
  return json({ error: "Could not store the support message" }, 500);
}

async function notifySupportTelegram(kind: "new" | "reply", userEmail: string, subject: string, body: string): Promise<void> {
  const safeEmail = cleanEmail(userEmail) ?? "Adresse client indisponible";
  const safeSubject = cleanSubject(subject);
  await sendTelegram(
    `${kind === "new" ? "🎫 <b>Nouveau ticket support</b>" : "💬 <b>Réponse client — ticket</b>"}\n` +
    `<b>${tgEscape(safeEmail)}</b> — « ${tgEscape(safeSubject)} »\n` +
    `${tgEscape(body.slice(0, 500))}${body.length > 500 ? "…" : ""}`,
  );
}

async function getUser(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user ?? null;
}

// Count a user's own (non-admin) messages in the last hour — author_email is set server-side.
async function userMsgCountLastHour(email: string): Promise<number> {
  if (!email) return 0;
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("cloud_support_messages")
    .select("ticket_id", { count: "exact", head: true })
    .eq("from_admin", false).eq("author_email", email).gte("created_at", since);
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-support/, "") || "/";

  if (req.method === "POST" && path === "/cron/run") {
    if (!await cronAuthorized(req)) return json({ error: "Unauthorized" }, 403);
    try {
      return json({ ok: true, ...(await drainSupportEmailOutbox()) });
    } catch (error) {
      console.error(`[norva-support] delivery worker failed code=${redactDiagnostic(error).slice(0, 180)}`);
      return json({ error: "Delivery worker failed" }, 500);
    }
  }

  const user = await getUser(req);
  if (!user?.id) return json({ error: "Not signed in" }, 401);
  const isAdmin = (user.app_metadata as JsonRecord | undefined)?.role === "admin";

  // ── USER: create a ticket ──────────────────────────────────────────────────
  if (req.method === "POST" && path === "/create") {
    let payload: { subject?: string; body?: string; request_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const subject = cleanSubject(payload.subject);
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (subject.length < 3 || body.length < 5) return json({ error: "Please describe your issue (subject and message)." }, 400);

    // Rate limit: too many concurrent tickets, or too many messages in the last hour.
    const { count: openCount } = await db.from("cloud_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).in("status", ["open", "pending"]);
    if ((openCount ?? 0) >= MAX_OPEN_TICKETS)
      return json({ error: "You already have several open tickets — please continue in an existing one." }, 429);
    if (await userMsgCountLastHour(user.email ?? "") >= MAX_MSGS_PER_HOUR)
      return json({ error: "Too many messages in a short time. Please wait a little and try again." }, 429);

    const rid = requestId(req, payload.request_id);
    if (!rid) return json({ error: "request_id must be a UUID" }, 400);
    const email = supportInboxEmail("new", user.email ?? "", subject, body);
    const { data, error } = await db.rpc("norva_create_support_message_with_email", {
      p_user_id: user.id,
      p_author_email: cleanEmail(user.email),
      p_subject: subject,
      p_body: body,
      p_request_id: rid,
      p_ticket_id: crypto.randomUUID(),
      p_message_id: crypto.randomUUID(),
      p_recipient_email: email.recipientEmail,
      p_request_from: email.from,
      p_request_reply_to: email.replyTo,
      p_request_subject: email.subject,
      p_request_html: email.html,
      p_request_text: email.text,
      p_request_tags: email.tags,
    });
    if (error || !data) return supportRpcError(error);
    const result = data as SupportMutationResult;
    if (!result.deduped) await notifySupportTelegram("new", user.email ?? "", subject, body);
    return json({
      ok: true,
      ticket_id: result.ticket_id,
      message_id: result.message_id,
      deduped: result.deduped,
      email: emailDeliveryView(result),
    });
  }

  // ── USER: reply on own ticket ──────────────────────────────────────────────
  if (req.method === "POST" && path === "/reply") {
    let payload: { ticket_id?: string; body?: string; request_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (!ticketId || body.length < 2) return json({ error: "Empty message" }, 400);

    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,subject").eq("id", ticketId).maybeSingle();
    if (!t || String(t.user_id) !== user.id) return json({ error: "Ticket not found" }, 404);

    if (await userMsgCountLastHour(user.email ?? "") >= MAX_MSGS_PER_HOUR)
      return json({ error: "Too many messages in a short time. Please wait a little and try again." }, 429);

    const rid = requestId(req, payload.request_id);
    if (!rid) return json({ error: "request_id must be a UUID" }, 400);
    const email = supportInboxEmail("reply", user.email ?? "", String(t.subject), body);
    const { data, error } = await db.rpc("norva_append_support_message_with_email", {
      p_actor_user_id: user.id,
      p_ticket_id: String(t.id),
      p_from_admin: false,
      p_author_email: cleanEmail(user.email),
      p_body: body,
      p_request_id: rid,
      p_message_id: crypto.randomUUID(),
      p_recipient_email: email.recipientEmail,
      p_request_from: email.from,
      p_request_reply_to: email.replyTo,
      p_request_subject: email.subject,
      p_request_html: email.html,
      p_request_text: email.text,
      p_request_tags: email.tags,
    });
    if (error || !data) return supportRpcError(error);
    const result = data as SupportMutationResult;
    if (!result.deduped) await notifySupportTelegram("reply", user.email ?? "", String(t.subject), body);
    return json({
      ok: true,
      ticket_id: result.ticket_id,
      message_id: result.message_id,
      deduped: result.deduped,
      email: emailDeliveryView(result),
    });
  }

  // ── USER: mark own ticket resolved ─────────────────────────────────────────
  // A user who's done cannot otherwise tidy up: only admins changed status, and every open
  // ticket counts toward MAX_OPEN_TICKETS. Idempotent on an already-closed ticket.
  if (req.method === "POST" && path === "/close") {
    let payload: { ticket_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    if (!ticketId) return json({ error: "Bad request" }, 400);
    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,status").eq("id", ticketId).maybeSingle();
    if (!t || String(t.user_id) !== user.id) return json({ error: "Ticket not found" }, 404);
    if (t.status === "closed") return json({ ok: true, status: "closed" });
    await db.from("cloud_support_tickets").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", t.id);
    try {
      await db.from("admin_events").insert({ user_id: user.id, kind: "admin_action", summary: "Ticket support fermé par le client", actor: user.email });
    } catch (_) { /* best-effort */ }
    return json({ ok: true, status: "closed" });
  }

  // ── USER: my tickets with threads ──────────────────────────────────────────
  // ?tickets=only returns just the ticket rows (no thread bodies) — the in-app
  // "support replied" notification polls this cheaply from every app boot.
  if (req.method === "GET" && path === "/mine") {
    const { data: tickets } = await db.from("cloud_support_tickets")
      .select("id,subject,status,last_from,last_message_at,created_at")
      .eq("user_id", user.id).order("last_message_at", { ascending: false }).limit(50);
    if (url.searchParams.get("tickets") === "only") return json({ ok: true, tickets: tickets ?? [] });
    const ids = (tickets ?? []).map((t) => t.id);
    let messages: JsonRecord[] = [];
    if (ids.length) {
      const { data: msgs } = await db.from("cloud_support_messages")
        .select("ticket_id,from_admin,body,created_at").in("ticket_id", ids).order("created_at");
      messages = (msgs ?? []) as JsonRecord[];
    }
    return json({ ok: true, tickets: tickets ?? [], messages });
  }

  // ── ADMIN routes ───────────────────────────────────────────────────────────
  if (!isAdmin && path.startsWith("/admin/")) return json({ error: "not authorized" }, 403);

  if (req.method === "POST" && path === "/admin/reply") {
    let payload: { ticket_id?: string; body?: string; request_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (!ticketId || body.length < 2) return json({ error: "Empty message" }, 400);

    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,subject").eq("id", ticketId).maybeSingle();
    if (!t) return json({ error: "Ticket not found" }, 404);

    const rid = requestId(req, payload.request_id);
    if (!rid) return json({ error: "request_id must be a UUID" }, 400);
    const email = supportClientEmail(String(t.subject), body);
    const { data, error } = await db.rpc("norva_append_support_message_with_email", {
      p_actor_user_id: user.id,
      p_ticket_id: String(t.id),
      p_from_admin: true,
      p_author_email: cleanEmail(user.email),
      p_body: body,
      p_request_id: rid,
      p_message_id: crypto.randomUUID(),
      p_recipient_email: email.recipientEmail,
      p_request_from: email.from,
      p_request_reply_to: email.replyTo,
      p_request_subject: email.subject,
      p_request_html: email.html,
      p_request_text: email.text,
      p_request_tags: email.tags,
    });
    if (error || !data) return supportRpcError(error);
    const result = data as SupportMutationResult;
    try {
      if (!result.deduped) {
        await db.from("admin_events").insert({
          user_id: t.user_id,
          kind: "admin_action",
          summary: "Réponse support enregistrée",
          actor: cleanEmail(user.email),
        });
      }
    } catch (_) { /* best-effort */ }

    return json({
      ok: true,
      ticket_id: result.ticket_id,
      message_id: result.message_id,
      deduped: result.deduped,
      email: emailDeliveryView(result),
    });
  }

  if (req.method === "POST" && path === "/admin/status") {
    let payload: { ticket_id?: string; status?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const status = String(payload.status ?? "");
    if (!ticketId || !["open", "pending", "closed"].includes(status)) return json({ error: "Bad request" }, 400);
    const { data: t } = await db.from("cloud_support_tickets").update({ status, updated_at: new Date().toISOString() })
      .eq("id", ticketId).select("user_id").maybeSingle();
    if (!t) return json({ error: "Ticket not found" }, 404);
    try {
      await db.from("admin_events").insert({ user_id: t.user_id, kind: "admin_action", summary: `Ticket support → ${status}`, actor: user.email });
    } catch (_) { /* best-effort */ }
    return json({ ok: true, status });
  }

  return json({ error: "Not found" }, 404);
});
