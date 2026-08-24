// Durable Provider Access notification transport. PostgreSQL owns scheduling,
// leases, eligibility and terminal state; this worker only resolves the current
// recipient/token, performs the final authorization CAS and calls Resend/FCM.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fcmConfigured, sendFcmPush } from "../_shared/fcm.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("PROVIDER_ACCESS_EMAIL_FROM") ?? "Norva <hello@norva.tv>";
const EMAIL_REPLY_TO = Deno.env.get("PROVIDER_ACCESS_EMAIL_REPLY_TO") ?? "support@norva.tv";
const BATCH = 4;
const MAX_ATTEMPTS = 12;
const DEEP_LINK = "https://norva.tv/app.html?mobile=1#settings/sources";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Channel = "email" | "push";
type EventKind = "expiry_7d" | "expiry_1d" | "expiry_today" | "access_hidden" | "access_restored";

interface Claim {
  notification_id: string;
  delivery_key: string;
  lease_sequence: number;
  user_id: string;
  source_id: string;
  access_cycle_id: string;
  event_kind: EventKind;
  source_name: string;
  expires_on: string | null;
  attempt_count: number;
}

interface Copy {
  subject: string;
  title: string;
  body: string;
  detail: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function copyFor(kind: EventKind, expiresOn: string | null): Copy {
  const date = expiresOn
    ? new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${expiresOn}T12:00:00Z`))
    : null;
  switch (kind) {
    case "expiry_7d":
      return {
        subject: "Your external catalog access expires in 7 days",
        title: "Catalog access reminder",
        body: "Your external provider access expires in 7 days. Your Norva plan is not affected.",
        detail: date ? `The estimated access end date is ${date}.` : "The estimated access end date is in 7 days.",
      };
    case "expiry_1d":
      return {
        subject: "Your external catalog access expires tomorrow",
        title: "Catalog access reminder",
        body: "Your external provider access expires tomorrow. Your Norva plan is not affected.",
        detail: date ? `The estimated access end date is ${date}.` : "The estimated access end date is tomorrow.",
      };
    case "expiry_today":
      return {
        subject: "Your external catalog access expires today",
        title: "Catalog access reminder",
        body: "Your external provider access expires today. Your Norva plan is not affected.",
        detail: date ? `The estimated access end date is ${date}.` : "The estimated access end date is today.",
      };
    case "access_hidden":
      return {
        subject: "Your external catalog needs attention",
        title: "Catalog access needs attention",
        body: "Norva confirmed that your external provider access is unavailable and hid this catalog. Your Norva plan is not affected.",
        detail: "Open Provider access in Settings to check or restore the catalog.",
      };
    case "access_restored":
      return {
        subject: "Your external catalog access is restored",
        title: "Catalog access restored",
        body: "Your external provider access is available again. Your Norva plan is not affected.",
        detail: "The catalog is available again in Norva.",
      };
  }
  throw new Error("unsupported_provider_access_event");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function emailHtml(copy: Copy): string {
  return `<!doctype html><html><body style="margin:0;background:#090b12;color:#f5f7fb;font-family:Inter,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="font-size:24px;font-weight:700">Norva</div><h1 style="font-size:24px;line-height:1.25;margin:28px 0 12px">${escapeHtml(copy.title)}</h1><p style="font-size:16px;line-height:1.6;color:#d7dbea">${escapeHtml(copy.body)}</p><p style="font-size:16px;line-height:1.6;color:#d7dbea">${escapeHtml(copy.detail)}</p><a href="${DEEP_LINK}" style="display:inline-block;margin-top:12px;padding:12px 18px;border-radius:10px;background:#7c6df2;color:#fff;text-decoration:none;font-weight:650">Review provider access</a><p style="margin-top:30px;font-size:13px;line-height:1.5;color:#9299aa">This reminder concerns access supplied by an external provider. Norva does not provide, sell or extend external catalogs.</p></div></body></html>`;
}

function emailText(copy: Copy): string {
  return `Norva\n\n${copy.title}\n\n${copy.body}\n\n${copy.detail}\n\nReview provider access: ${DEEP_LINK}\n\nThis reminder concerns access supplied by an external provider. Norva does not provide, sell or extend external catalogs.`;
}

function retryableStatus(status: number | null): boolean {
  return status === null || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.min(21_600, Math.max(0, Number(value.trim())));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(21_600, Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)))
    : null;
}

async function claim(channel: Channel, worker: string): Promise<Claim[]> {
  const { data, error } = await admin.rpc("norva_claim_provider_access_notifications", {
    p_channel: channel,
    p_worker: worker,
    p_limit: BATCH,
    p_lease_seconds: 90,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new Error(`${channel}_claim_failed:${error.code ?? "db_error"}`);
  return (Array.isArray(data) ? data : []) as Claim[];
}

async function authorize(claimed: Claim, channel: Channel, worker: string, email: string | null): Promise<boolean> {
  const { data, error } = await admin.rpc("norva_authorize_provider_access_notification", {
    p_notification_id: claimed.notification_id,
    p_channel: channel,
    p_worker: worker,
    p_expected_lease_sequence: claimed.lease_sequence,
    p_expected_recipient_email: email,
  });
  return !error && data === true;
}

async function rolloutEligible(userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("norva_provider_access_rollout_status", {
    p_user_id: userId,
  });
  return !error && data?.eligible === true;
}

async function complete(claimed: Claim, channel: Channel, worker: string, code: string, providerId: string | null): Promise<boolean> {
  const { data, error } = await admin.rpc("norva_complete_provider_access_notification", {
    p_notification_id: claimed.notification_id,
    p_channel: channel,
    p_worker: worker,
    p_expected_lease_sequence: claimed.lease_sequence,
    p_completion_code: code,
    p_provider_message_id: providerId,
  });
  return !error && data === true;
}

async function fail(claimed: Claim, channel: Channel, worker: string, code: string, retryable: boolean, retryAfter: number | null = null): Promise<string> {
  const { data, error } = await admin.rpc("norva_fail_provider_access_notification", {
    p_notification_id: claimed.notification_id,
    p_channel: channel,
    p_worker: worker,
    p_expected_lease_sequence: claimed.lease_sequence,
    p_error_code: code,
    p_retryable: retryable,
    p_retry_after_seconds: retryAfter,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) return "stale";
  if (data === "retry_scheduled") return "retry";
  if (data === "dead_letter") return "dead_letter";
  return "stale";
}

async function currentEmail(userId: string): Promise<{ email: string | null; lookupFailed: boolean }> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) {
    const status = Number((error as { status?: unknown }).status ?? 0);
    const code = String((error as { code?: unknown }).code ?? "").toLowerCase();
    if (status === 404 || code === "user_not_found") return { email: null, lookupFailed: false };
    return { email: null, lookupFailed: true };
  }
  const email = data.user?.email?.trim().toLowerCase() ?? "";
  return { email: email || null, lookupFailed: false };
}

async function sendEmail(claimed: Claim, worker: string): Promise<"delivered" | "retry" | "dead_letter" | "stale"> {
  if (!await rolloutEligible(claimed.user_id)) {
    return (await fail(claimed, "email", worker, "ROLLOUT_INELIGIBLE", false)) as "dead_letter" | "stale";
  }
  const resolved = await currentEmail(claimed.user_id);
  if (resolved.lookupFailed) {
    return (await fail(claimed, "email", worker, "AUTH_RECIPIENT_LOOKUP_ERROR", true)) as "retry" | "dead_letter" | "stale";
  }
  if (!await authorize(claimed, "email", worker, resolved.email)) return "stale";
  const recipient = resolved.email;
  if (!recipient) return "stale";
  if (!RESEND_API_KEY) {
    return (await fail(claimed, "email", worker, "RESEND_NOT_CONFIGURED", true)) as "retry" | "dead_letter" | "stale";
  }
  const copy = copyFor(claimed.event_kind, claimed.expires_on);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": claimed.delivery_key,
        "User-Agent": "Norva-Provider-Access/2.0",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        reply_to: EMAIL_REPLY_TO,
        to: [recipient],
        subject: copy.subject,
        html: emailHtml(copy),
        text: emailText(copy),
        tags: [{ name: "flow", value: "provider_access" }, { name: "event", value: claimed.event_kind }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json().catch(() => ({})) as { id?: unknown };
    const providerId = typeof payload.id === "string" ? payload.id.slice(0, 240) : null;
    if (response.ok && providerId) {
      return await complete(claimed, "email", worker, "RESEND_ACCEPTED", providerId) ? "delivered" : "stale";
    }
    const retryable = response.ok || retryableStatus(response.status);
    return (await fail(
      claimed,
      "email",
      worker,
      response.ok ? "RESEND_MISSING_ID" : `RESEND_HTTP_${response.status}`,
      retryable,
      retryAfterSeconds(response.headers.get("retry-after")),
    )) as "retry" | "dead_letter" | "stale";
  } catch (error) {
    const code = error instanceof DOMException && error.name === "TimeoutError" ? "RESEND_TIMEOUT" : "RESEND_TRANSPORT_ERROR";
    return (await fail(claimed, "email", worker, code, true)) as "retry" | "dead_letter" | "stale";
  }
}

async function sendPush(claimed: Claim, worker: string): Promise<"delivered" | "retry" | "dead_letter" | "stale"> {
  if (!await rolloutEligible(claimed.user_id)) {
    return (await fail(claimed, "push", worker, "ROLLOUT_INELIGIBLE", false)) as "dead_letter" | "stale";
  }
  const { data, error } = await admin.from("cloud_push_tokens").select("token").eq("user_id", claimed.user_id);
  if (error) return (await fail(claimed, "push", worker, "PUSH_TOKEN_LOOKUP_ERROR", true)) as "retry" | "dead_letter" | "stale";
  if (!await authorize(claimed, "push", worker, null)) return "stale";
  const tokens = [...new Set(((data ?? []) as Array<{ token?: unknown }>)
    .map((row) => typeof row.token === "string" ? row.token : "").filter(Boolean))];
  if (!tokens.length) {
    return await complete(claimed, "push", worker, "NO_REGISTERED_TOKEN", null) ? "delivered" : "stale";
  }
  if (!fcmConfigured()) return (await fail(claimed, "push", worker, "FCM_NOT_CONFIGURED", true)) as "retry" | "dead_letter" | "stale";

  const copy = copyFor(claimed.event_kind, claimed.expires_on);
  let acceptedId: string | null = null;
  let retryableFailure = false;
  let permanentFailure = false;
  for (const token of tokens) {
    const result = await sendFcmPush(token, {
      title: copy.title,
      body: copy.body,
      dataOnly: true,
      data: {
        kind: "provider_access",
        eventKind: claimed.event_kind,
        notificationId: claimed.delivery_key,
        deepLink: DEEP_LINK,
      },
    });
    if (result.ok && result.messageId) acceptedId ??= result.messageId;
    else if (result.unregistered) await admin.from("cloud_push_tokens").delete().eq("user_id", claimed.user_id).eq("token", token);
    else if (result.ok || retryableStatus(result.status || null)) retryableFailure = true;
    else permanentFailure = true;
  }
  if (retryableFailure) return (await fail(claimed, "push", worker, "FCM_RETRYABLE_ERROR", true)) as "retry" | "dead_letter" | "stale";
  if (acceptedId) return await complete(claimed, "push", worker, "FCM_ACCEPTED", acceptedId) ? "delivered" : "stale";
  if (!permanentFailure) return await complete(claimed, "push", worker, "NO_REGISTERED_TOKEN", null) ? "delivered" : "stale";
  return (await fail(claimed, "push", worker, "FCM_PERMANENT_ERROR", false)) as "retry" | "dead_letter" | "stale";
}

async function drainChannel(channel: Channel): Promise<Record<string, number>> {
  const worker = `provider-access-${channel}-${crypto.randomUUID()}`;
  const claims = await claim(channel, worker);
  const result = { claimed: claims.length, delivered: 0, retry: 0, dead_letter: 0, stale: 0 };
  for (const claimed of claims) {
    const state = channel === "email" ? await sendEmail(claimed, worker) : await sendPush(claimed, worker);
    result[state]++;
    if (channel === "email") await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return result;
}

async function drain(): Promise<Record<string, unknown>> {
  const { data: scheduled, error: scheduleError } = await admin.rpc("norva_schedule_provider_access_notifications", {
    p_now: new Date().toISOString(),
    p_limit: 500,
  });
  if (scheduleError) throw new Error(`schedule_failed:${scheduleError.code ?? "db_error"}`);
  // Channel failures are isolated: one transport never prevents the other from
  // claiming its independently durable rows. A misconfigured transport does
  // not claim or consume attempts: its rows remain pending and visible in the
  // health snapshot until the operator configures the secret or disables the
  // corresponding default-off channel flag.
  const emailDrain = RESEND_API_KEY
    ? drainChannel("email")
    : Promise.resolve({ skipped_not_configured: 1 });
  const pushDrain = fcmConfigured()
    ? drainChannel("push")
    : Promise.resolve({ skipped_not_configured: 1 });
  const settled = await Promise.allSettled([emailDrain, pushDrain]);
  const channel = (index: number) => {
    const result = settled[index];
    return result.status === "fulfilled" ? result.value : { error: "channel_drain_failed" };
  };
  const { data: health } = await admin.rpc("norva_provider_access_notification_health");
  return { scheduled, email: channel(0), push: channel(1), health: health ?? null };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);
  const path = new URL(req.url).pathname.replace(/^.*\/norva-provider-access-notify/, "") || "/";
  if (path !== "/cron/drain") return json({ error: "Not found" }, 404);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: authorized, error } = await admin.rpc("norva_verify_cron_secret", { presented: token });
  if (error || authorized !== true) return json({ error: "Unauthorized" }, 403);
  try {
    return json({ ok: true, ...(await drain()) });
  } catch (error) {
    console.error("[norva-provider-access-notify] drain failed", error instanceof Error ? error.message.slice(0, 160) : "unknown_error");
    return json({ error: "Drain failed" }, 500);
  }
});
