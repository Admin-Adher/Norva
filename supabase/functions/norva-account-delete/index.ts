// Norva — account self-deletion endpoint (Google Play / GDPR requirement).
//
// Account deletion is always the primary action. Its confirmation email uses a
// durable two-phase outbox:
//   1. freeze the exact request while the authenticated email still exists;
//   2. auth.users AFTER DELETE activates it transactionally;
//   3. a dedicated cron claims, sends and acknowledges only a Resend 2xx + id.
// A prepared row can never send a false deletion confirmation, and no retry can
// repeat or roll back the account deletion itself.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const REPLY_TO = Deno.env.get("AUTH_EMAIL_REPLY_TO") ?? "support@norva.tv";
const DELIVERY_BATCH = 5;
const DELIVERY_SPACING_MS = 250;
const RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60;
const AUTH_CLOCK_SKEW_SECONDS = 60;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv",
  "https://www.norva.tv",
  "http://localhost:3000",
  "http://localhost:5173",
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function isLocalOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowAll = allowed.includes("*");
  const allowOrigin =
    origin && (allowAll || allowed.includes(origin) || isLocalOrigin(origin))
      ? origin
      : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

interface RenderedDeletionEmail {
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
}

function renderAccountDeleted(): RenderedDeletionEmail {
  const subject = "Your Norva account has been deleted";
  return {
    subject,
    text: `Your Norva account has been deleted

Access to your Norva account is now closed. Data directly associated with the account has been removed or de-identified according to our Privacy Policy. Norva may retain limited records where required by law or for security, fraud prevention and billing.

If you did not request this, contact support@norva.tv right away.

You can create a new account anytime at https://norva.tv.

Privacy Policy: https://norva.tv/privacy.html

© Norva`,
    tags: [
      { name: "app", value: "norva" },
      { name: "category", value: "transactional_auth" },
      { name: "flow", value: "account_deleted" },
    ],
    html: `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">Access to your Norva account is now closed.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="500" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:500px;background:#11151d;border:1px solid #283143;border-radius:16px;border-collapse:separate">
        <tr><td align="center" style="padding:32px 32px 8px">
          <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;border:0;border-radius:12px;outline:none;text-decoration:none">
          <p style="margin:10px 0 0;color:#ffffff;font-family:'Century Gothic',Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;line-height:1.25">Norva</p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px 6px">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.3">Your account has been deleted</h1>
        </td></tr>
        <tr><td style="padding:12px 32px 24px;color:#bcc5d6;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;text-align:center">
          Access to your Norva account is now closed. Data directly associated with the account has been removed or de-identified according to our <a href="https://norva.tv/privacy.html" style="color:#b8c8f2;text-decoration:underline">Privacy Policy</a>. Norva may retain limited records where required by law or for security, fraud prevention and billing.<br><br>
          If you did not request this, contact <a href="mailto:support@norva.tv" style="color:#b8c8f2;text-decoration:underline">support@norva.tv</a> right away.
        </td></tr>
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #283143;color:#9ba6ba;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          You can create a new account anytime at <a href="https://norva.tv" style="color:#b8c8f2;text-decoration:underline">norva.tv</a>.
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#8994a8;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;text-align:center">&copy; Norva</p>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

interface DeletionDeliveryClaim {
  delivery_key: string;
  lease_token: string;
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
  attempt_count: number;
}

interface ResendResult {
  accepted: boolean;
  status: number | null;
  emailId: string | null;
  response: JsonRecord;
  error: string;
  retryAfterSeconds: number | null;
}

function redactDiagnosticText(value: unknown): string {
  let normalized = "";
  if (value instanceof Error) normalized = value.message;
  else if (typeof value === "string") normalized = value;
  else {
    try { normalized = JSON.stringify(value); } catch (_) { normalized = "unknown_error"; }
  }
  return normalized
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu, "[redacted-email]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:Bearer\s+|re_|whsec_)[A-Za-z0-9._~+\/-]+/giu, "[redacted-secret]")
    .slice(0, 1000);
}

function errorText(value: unknown): string {
  return redactDiagnosticText(value) || "unknown_error";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resendErrorName(payload: JsonRecord): string {
  const nested = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonRecord
    : null;
  return String(payload.name ?? payload.type ?? payload.code ?? nested?.name ?? nested?.type ?? nested?.code ?? "")
    .trim().toLowerCase();
}

function retryableResendStatus(status: number | null, payload: JsonRecord = {}): boolean {
  if (status === 409) return resendErrorName(payload) === "concurrent_idempotent_requests";
  return status === null || status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Math.min(21600, Number(value.trim())));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(21600, Math.ceil((at - Date.now()) / 1000)));
}

function safeResendResponse(payload: JsonRecord, emailId: string | null): JsonRecord {
  if (emailId) return { id: emailId };
  const nestedError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonRecord
    : null;
  const result: JsonRecord = {};
  for (const key of ["name", "type", "code", "statusCode"] as const) {
    const value = payload[key] ?? nestedError?.[key];
    if (typeof value === "string" || typeof value === "number") {
      result[key] = redactDiagnosticText(value).slice(0, 200);
    }
  }
  const message = payload.message ?? nestedError?.message ?? payload.error;
  if (message !== undefined && message !== null) result.message = errorText(message);
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type AuthenticationMethod = { method?: unknown; timestamp?: unknown };

async function deletionAuthenticationGuard(token: string): Promise<
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }
> {
  const { data, error } = await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (error || !data) {
    console.error("[norva-account-delete] authentication assurance unavailable", errorText(error));
    return {
      ok: false,
      status: 503,
      code: "authentication_assurance_unavailable",
      message: "We could not verify your sign-in security. Please try again.",
    };
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    return {
      ok: false,
      status: 403,
      code: "mfa_verification_required",
      message: "Complete your second-factor verification before deleting your account.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const latestInteractiveAuthentication = ((data.currentAuthenticationMethods ?? []) as AuthenticationMethod[])
    .filter((entry) => {
      const method = typeof entry?.method === "string" ? entry.method.trim().toLowerCase() : "";
      return Boolean(method) && method !== "token_refresh" && method !== "anonymous";
    })
    .map((entry) => Number(entry.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= now + AUTH_CLOCK_SKEW_SECONDS)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), 0);

  if (!latestInteractiveAuthentication || now - latestInteractiveAuthentication > RECENT_AUTH_MAX_AGE_SECONDS) {
    return {
      ok: false,
      status: 403,
      code: "reauthentication_required",
      message: "Sign in again before deleting your account.",
    };
  }
  return { ok: true };
}

async function sendDeletionEmail(claim: DeletionDeliveryClaim): Promise<ResendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Account-Delete/2.0",
        "Idempotency-Key": claim.delivery_key,
      },
      body: JSON.stringify({
        from: claim.request_from,
        reply_to: claim.request_reply_to,
        to: [claim.recipient_email],
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
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as JsonRecord
        : { response: String(parsed).slice(0, 1000) };
    } catch (_) {
      payload = raw ? { response: raw.slice(0, 1000) } : {};
    }
    const emailId = stringOrNull(payload.id);
    const safeResponse = safeResendResponse(payload, emailId);
    return {
      accepted: res.ok && Boolean(emailId),
      status: res.status,
      emailId,
      response: safeResponse,
      error: res.ok && emailId ? "" : errorText(payload.error ?? payload.message ?? `resend_http_${res.status}`),
      retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after")),
    };
  } catch (error) {
    return {
      accepted: false,
      status: null,
      emailId: null,
      response: {},
      error: errorText(error),
      retryAfterSeconds: null,
    };
  }
}

async function drainDeletionEmailOutbox(db: SupabaseClient): Promise<Record<string, number | boolean>> {
  if (!RESEND_API_KEY) {
    return { configured: false, claimed: 0, sent: 0, retry_scheduled: 0, dead_letter: 0, lease_lost: 0 };
  }

  const { data, error } = await db.rpc("claim_account_deletion_email_deliveries", {
    p_batch: DELIVERY_BATCH,
    p_lease_seconds: 90,
    p_max_attempts: 12,
  });
  if (error) throw new Error(`account_deletion_email_claim_failed:${error.message}`);
  const claims = (Array.isArray(data) ? data : []) as DeletionDeliveryClaim[];
  const result = {
    configured: true,
    claimed: claims.length,
    sent: 0,
    retry_scheduled: 0,
    dead_letter: 0,
    lease_lost: 0,
    accepted_unacknowledged: 0,
  };

  let networkAttempts = 0;
  let sharedRetryAfterSeconds: number | null = null;
  for (const claim of claims) {
    let sent: ResendResult;
    if (sharedRetryAfterSeconds !== null) {
      sent = {
        accepted: false,
        status: 429,
        emailId: null,
        response: { code: "resend_team_rate_limited" },
        error: "resend_team_rate_limited_before_send",
        retryAfterSeconds: sharedRetryAfterSeconds,
      };
    } else {
      if (networkAttempts > 0) await sleep(DELIVERY_SPACING_MS);
      sent = await sendDeletionEmail(claim);
      networkAttempts++;
      if (sent.status === 429) {
        // Resend's 5 req/s limit is team-wide. Do not consume the rest of this
        // claimed batch while another Norva sender is throttled.
        sharedRetryAfterSeconds = Math.max(1, sent.retryAfterSeconds ?? 60);
      }
    }
    if (sent.accepted && sent.emailId) {
      const { data: completed, error: completeError } = await db.rpc("complete_account_deletion_email_delivery", {
        p_delivery_key: claim.delivery_key,
        p_lease_token: claim.lease_token,
        p_resend_email_id: sent.emailId,
        p_http_status: sent.status,
        p_response: sent.response,
      });
      if (completeError || completed !== true) {
        // Provider acceptance is immutable. Leave the lease intact so the same
        // Idempotency-Key reconciles within the bounded replay window. SQL
        // quarantines it before the provider's 24-hour idempotency key expires.
        result.accepted_unacknowledged++;
        console.error("[norva-account-delete] accepted delivery acknowledgement failed", claim.delivery_key);
        continue;
      }
      result.sent++;
      continue;
    }

    const { data: failed, error: failError } = await db.rpc("fail_account_deletion_email_delivery", {
      p_delivery_key: claim.delivery_key,
      p_lease_token: claim.lease_token,
      p_http_status: sent.status,
      p_error: sent.error || "resend_delivery_failed",
      p_response: sent.response,
      p_retryable: (sent.status !== null && sent.status >= 200 && sent.status <= 299)
        || retryableResendStatus(sent.status, sent.response),
      p_retry_after_seconds: sent.retryAfterSeconds,
      p_max_attempts: 12,
    });
    if (failError) {
      result.lease_lost++;
      console.error("[norva-account-delete] delivery failure CAS failed", claim.delivery_key, failError.message);
    } else if (failed === "dead_letter") {
      result.dead_letter++;
      console.error("[norva-account-delete] delivery dead-lettered", claim.delivery_key, sent.status);
    } else if (failed === "retry_scheduled") result.retry_scheduled++;
    else result.lease_lost++;
  }

  return result;
}

async function cronAuthorized(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!token) return false;
  const { data, error } = await admin.rpc("norva_verify_cron_secret", { presented: token });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  const isCron = new URL(req.url).pathname.endsWith("/cron/run");
  if (isCron) {
    if (!(await cronAuthorized(req))) return json(req, { error: "Unauthorized" }, 403);
    try {
      const result = await drainDeletionEmailOutbox(admin);
      return json(req, { ok: true, ...result });
    } catch (error) {
      console.error("[norva-account-delete] delivery worker failed", errorText(error));
      return json(req, { error: "Delivery worker failed" }, 500);
    }
  }

  // Authenticate the caller from their Supabase JWT.
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(req, { error: "Missing bearer token" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    return json(req, { error: "Invalid or expired session" }, 401);
  }
  const user = userData.user;

  // Require explicit confirmation so a stray POST can never wipe an account.
  let confirm = "";
  try {
    const body = await req.json();
    confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";
  } catch (_) {
    // The validation below returns the public 400 response.
  }
  const email = (user.email ?? "").trim().toLowerCase();
  if (confirm !== "DELETE" && (!email || confirm.toLowerCase() !== email)) {
    return json(req, {
      error: "Confirmation required",
      hint: 'POST { "confirm": "DELETE" } or { "confirm": "<your account email>" }',
    }, 400);
  }

  const authenticationGuard = await deletionAuthenticationGuard(token);
  if (!authenticationGuard.ok) {
    return json(req, {
      error: authenticationGuard.message,
      code: authenticationGuard.code,
    }, authenticationGuard.status);
  }

  // Email infrastructure never blocks the primary deletion. When available, the
  // exact payload is frozen first but remains non-deliverable until auth deletion.
  let deliveryKey: string | null = null;
  if (email) {
    const rendered = renderAccountDeleted();
    const { data, error } = await admin.rpc("prepare_account_deletion_email", {
      p_user_id: user.id,
      p_recipient_email: email,
      p_request_from: FROM,
      p_request_reply_to: REPLY_TO,
      p_request_subject: rendered.subject,
      p_request_html: rendered.html,
      p_request_text: rendered.text,
      p_request_tags: rendered.tags,
    });
    if (error || typeof data !== "string" || !data) {
      console.error("[norva-account-delete] confirmation preparation unavailable", error?.message ?? "empty_result");
    } else {
      deliveryKey = data;
    }
  }

  // Deletes auth.users; ON DELETE CASCADE removes every user-owned row. The
  // activation trigger runs inside that same transaction.
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error("[norva-account-delete] account deletion failed", delErr.message);
    if (deliveryKey) {
      const { error: cancelError } = await admin.rpc("cancel_prepared_account_deletion_email", {
        p_delivery_key: deliveryKey,
      });
      if (cancelError) console.error("[norva-account-delete] prepared confirmation cleanup failed", cancelError.message);
    }
    return json(req, { error: "Deletion failed" }, 500);
  }

  let confirmation: "queued" | "unavailable" = "unavailable";
  if (deliveryKey) {
    const { data: confirmed, error: confirmError } = await admin.rpc("confirm_account_deletion_email", {
      p_delivery_key: deliveryKey,
      p_deleted_user_id: user.id,
    });
    if (!confirmError && confirmed === true) confirmation = "queued";
    else console.error("[norva-account-delete] confirmation activation unavailable", confirmError?.message ?? "not_confirmed");
  }

  // No deleted UUID/email is echoed or retained in the API response.
  return json(req, { ok: true, deleted: true, emailConfirmation: confirmation });
});
