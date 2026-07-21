// Phase 1 import-lifecycle DIGEST sender. A pg_cron job POSTs here every ~2 min. The database
// snapshots settled events into a stable delivery, leases complete (user, kind) groups, and returns
// one claim per digest. The delivery UUID is also the Resend Idempotency-Key: a crash after Resend
// accepts an email but before SQL acknowledgement cannot create a second message on retry.
// English-only (Norva is English-only). Auth mirrors the source-sync crons (norva_verify_cron_secret).
//
// Cron to register AT DEPLOY (held until then — pointing a cron at a missing function would 404 every run):
//   select cron.schedule('norva-import-notify-digest', '*/2 * * * *', $$
//     select net.http_post(
//       url := 'https://api.norva.tv/functions/v1/norva-import-notify/cron/digest',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 60000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  importEmailTags,
  plainTextFromImportHtml,
  renderImportStarted,
  renderImportCompleted,
  renderImportFailed,
  type ProviderStat,
  type RenderedImportEmail,
} from "../_shared/import-email.ts";
import { sendFcmPush, fcmConfigured } from "../_shared/fcm.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("NORVA_IMPORT_EMAIL_FROM") ?? "Norva Updates <updates@norva.tv>";
const REPLY_TO = Deno.env.get("NORVA_EMAIL_REPLY_TO") ?? "support@norva.tv";
const SETTLE_SECONDS = 60;   // let a burst (multi-provider add) settle so it digests into one email
// The pg_net caller waits 60s. Four sequential 10s transport attempts leave room
// for auth/provider queries and SQL acknowledgement without overrunning the call.
const GROUP_BATCH = 4;
const LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 8;
const RESEND_TIMEOUT_MS = 10_000;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

interface DeliveryClaim {
  delivery_key: string;
  lease_token: string;
  user_id: string;
  kind: string;
  notification_ids: string[];
  source_ids: string[];
  attempt_count: number;
}

interface ResendResult {
  ok: boolean;
  retryable: boolean;
  httpStatus: number | null;
  emailId: string | null;
  response: Record<string, unknown> | null;
  error: string | null;
}

interface PreparedDelivery {
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
}

function firstNameOf(user: { user_metadata?: Record<string, unknown>; email?: string } | null): string | null {
  const m = user?.user_metadata ?? {};
  const full = String(m.full_name ?? m.name ?? m.first_name ?? "").trim();
  if (full) return full.split(/\s+/)[0];
  return null;
}

async function providerStats(db: SupabaseClient, sourceIds: string[], withCounts: boolean): Promise<ProviderStat[]> {
  const out: ProviderStat[] = [];
  for (const sourceId of sourceIds) {
    const { data: src } = await db.from("cloud_sources").select("display_name").eq("id", sourceId).maybeSingle();
    const name = String((src as { display_name?: string } | null)?.display_name ?? "Your provider");
    const stat: ProviderStat = { name };
    if (withCounts) {
      for (const [key, type] of [["movies", "movie"], ["series", "series"]] as const) {
        const { count } = await db.from("cloud_media_items").select("id", { count: "exact", head: true })
          .eq("source_id", sourceId).eq("item_type", type);
        stat[key] = count ?? 0;
      }
      const { count: live } = await db.from("cloud_media_items").select("id", { count: "exact", head: true })
        .eq("source_id", sourceId).not("item_type", "in", "(movie,series)");
      stat.channels = live ?? 0;
    }
    out.push(stat);
  }
  return out;
}

function renderFor(kind: string, firstName: string | null, providers: ProviderStat[]): RenderedImportEmail | null {
  if (kind === "import_started") return renderImportStarted(firstName, providers);
  if (kind === "import_completed") return renderImportCompleted(firstName, providers);
  if (kind === "import_failed") return renderImportFailed(firstName, providers);
  return null;
}

function payloadMessage(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  for (const key of ["message", "error", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function safeProviderText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:re_|whsec_)[A-Za-z0-9_-]{12,}\b/g, "[credential]")
    .slice(0, 500);
}

function safeProviderResponse(value: unknown): Record<string, unknown> {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const safe: Record<string, unknown> = {};
  const id = safeProviderText(payload.id);
  const name = safeProviderText(payload.name ?? payload.type ?? payload.code);
  const message = safeProviderText(payload.message ?? payload.error);
  const statusCode = typeof payload.statusCode === "number" ? payload.statusCode : null;
  if (id) safe.id = id;
  if (name) safe.name = name;
  if (message) safe.message = message;
  if (statusCode !== null) safe.status_code = statusCode;
  return safe;
}

async function responsePayload(response: Response): Promise<Record<string, unknown> | null> {
  const text = (await response.text().catch(() => "")).slice(0, 16_384);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return safeProviderResponse(parsed);
  } catch (_) {
    return safeProviderResponse({ message: text });
  }
}

// 4xx request/recipient errors are permanent, except credentials/rate limits and
// timeout-like statuses that can recover after configuration or provider backoff.
function retryableResendStatus(status: number | null): boolean {
  return status === null || status === 401 || status === 403 || status === 408
    || status === 425 || status === 429 || status >= 500;
}

function resendErrorName(payload: Record<string, unknown> | null): string {
  const value = payload?.name ?? payload?.type ?? payload?.code;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function retryableResendFailure(status: number | null, payload: Record<string, unknown> | null): boolean {
  if (status === 409) return resendErrorName(payload) === "concurrent_idempotent_requests";
  return retryableResendStatus(status);
}

async function sendImportEmail(
  prepared: PreparedDelivery,
  deliveryKey: string,
): Promise<ResendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Import-Email/2.0",
        "Idempotency-Key": `norva-import-${deliveryKey}`,
      },
      body: JSON.stringify({
        from: prepared.request_from,
        reply_to: prepared.request_reply_to,
        to: [prepared.recipient_email],
        subject: prepared.request_subject,
        html: prepared.request_html,
        text: prepared.request_text,
        tags: prepared.request_tags,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    const response = await responsePayload(res);
    const emailId = typeof response?.id === "string" && response.id.trim() ? response.id.trim() : null;
    if (res.ok && emailId) {
      return { ok: true, retryable: false, httpStatus: res.status, emailId, response, error: null };
    }
    const error = res.ok
      ? "Resend returned success without an email id"
      : (payloadMessage(response) || `Resend HTTP ${res.status}`);
    return {
      ok: false,
      retryable: res.ok || retryableResendFailure(res.status, response),
      httpStatus: res.status,
      emailId: null,
      response,
      error,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      httpStatus: null,
      emailId: null,
      response: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Short push copy (mobile, app-closed). Completed/failed only — "started" stays email-only (the user
// just acted and is likely in the app).
function pushTextFor(kind: string, providers: ProviderStat[]): { title: string; body: string } {
  const many = providers.length > 1;
  if (kind === "import_completed") {
    const p0 = providers[0] ?? { name: "Your catalog" };
    const stats = many ? `${providers.length} catalogs ready` : [
      p0.movies ? `${p0.movies.toLocaleString("en-US")} movies` : "",
      p0.series ? `${p0.series.toLocaleString("en-US")} series` : "",
      p0.channels ? `${p0.channels.toLocaleString("en-US")} channels` : "",
    ].filter(Boolean).join(" · ");
    return { title: many ? "Your catalogs are ready 🎬" : `${p0.name} is ready 🎬`, body: stats || "Your catalog is ready to watch." };
  }
  return { title: "Import issue", body: `We hit a snag importing ${providers.map((p) => p.name).join(", ")}. We're on it.` };
}

// Send an FCM push to all of a user's registered devices (best-effort). Dead tokens (UNREGISTERED) are
// purged. Runs alongside the email so app-closed mobile users are notified too.
async function sendPushForGroup(db: SupabaseClient, userId: string, kind: string, providers: ProviderStat[]): Promise<void> {
  if (!fcmConfigured()) return;
  try {
    const { data: toks } = await db.from("cloud_push_tokens").select("token").eq("user_id", userId);
    const tokens = [...new Set((toks ?? []).map((t) => String((t as { token?: string }).token)).filter(Boolean))];
    if (!tokens.length) return;
    const { title, body } = pushTextFor(kind, providers);
    for (const token of tokens) {
      const r = await sendFcmPush(token, { title, body, data: { kind } });
      if (r.unregistered) { try { await db.from("cloud_push_tokens").delete().eq("token", token); } catch (_) { /* noop */ } }
    }
  } catch (_) { /* best-effort */ }
}

async function runDigest(db: SupabaseClient): Promise<Record<string, number>> {
  // A missing transport is an operational outage, not a reason to consume and
  // permanently skip user notifications.
  if (!RESEND_API_KEY) throw new Error("Resend transport is not configured");

  const { data, error } = await db.rpc("claim_import_notification_deliveries", {
    p_group_limit: GROUP_BATCH,
    p_settle_seconds: SETTLE_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new Error(`delivery claim failed: ${error.message}`);
  const claims = (data ?? []) as DeliveryClaim[];
  if (!claims.length) {
    return { groups: 0, sent: 0, skipped: 0, failed: 0, dead_letter: 0, persistence_failed: 0, rows: 0 };
  }

  let sent = 0, skipped = 0, failed = 0, deadLetter = 0, persistenceFailed = 0, rows = 0;

  const recordFailure = async (
    claim: DeliveryClaim,
    retryable: boolean,
    errorMessage: string,
    httpStatus: number | null = null,
    response: Record<string, unknown> | null = null,
  ): Promise<void> => {
    const { data: disposition, error: failureError } = await db.rpc("fail_import_notification_delivery", {
      p_delivery_key: claim.delivery_key,
      p_notification_ids: claim.notification_ids,
      p_lease_token: claim.lease_token,
      p_retryable: retryable,
      p_http_status: httpStatus,
      p_response: response,
      p_error: errorMessage,
      p_max_attempts: MAX_ATTEMPTS,
      p_base_backoff_seconds: 120,
      p_max_backoff_seconds: 21_600,
    });
    if (failureError || !["retry_scheduled", "dead_letter"].includes(String(disposition))) {
      persistenceFailed++;
      console.error(
        "[norva-import-notify] delivery failure persistence failed",
        claim.delivery_key,
        failureError?.message ?? String(disposition),
      );
      return;
    }
    if (disposition === "dead_letter") deadLetter++;
    else failed++;
  };

  const skipDelivery = async (claim: DeliveryClaim, reason: string, email: string | null = null): Promise<void> => {
    const { data: applied, error: skipError } = await db.rpc("skip_import_notification_delivery", {
      p_delivery_key: claim.delivery_key,
      p_notification_ids: claim.notification_ids,
      p_lease_token: claim.lease_token,
      p_reason: reason,
      p_recipient_email: email,
    });
    if (skipError || applied !== true) {
      persistenceFailed++;
      console.error(
        "[norva-import-notify] delivery skip persistence failed",
        claim.delivery_key,
        skipError?.message ?? "stale lease",
      );
      return;
    }
    skipped += claim.notification_ids.length;
  };

  // Sequential delivery stays below Resend's team-wide request rate and makes the
  // claimed lease budget predictable. Database claims still prevent overlap with
  // another cron worker.
  for (const claim of claims) {
    rows += claim.notification_ids.length;
    const userId = claim.user_id;
    try {
      // Resolve the recipient only after claiming. An email changed since the
      // import event was inserted therefore goes to the current auth identity.
      const { data: u, error: userError } = await db.auth.admin.getUserById(userId);
      const userStatus = Number((userError as { status?: number } | null)?.status ?? 0);
      if (userError) {
        if (userStatus === 404) await skipDelivery(claim, "auth user no longer exists");
        else await recordFailure(claim, true, `auth user lookup failed: ${userError.message}`);
        continue;
      }

      const email = String(u?.user?.email ?? "").trim().toLowerCase();
      if (!email) {
        await skipDelivery(claim, "auth user has no current email");
        continue;
      }

      const sourceIds = [...new Set(claim.source_ids.map(String).filter(Boolean))];
      const providers = await providerStats(db, sourceIds, claim.kind === "import_completed");
      const rendered = renderFor(claim.kind, firstNameOf(u?.user ?? null), providers);
      if (!rendered) {
        await skipDelivery(claim, `unsupported notification kind: ${claim.kind}`, email);
        continue;
      }

      // Persist the exact request before touching Resend. On the first attempt it
      // uses the current auth email; retries reuse the frozen recipient and HTML
      // so the stable Idempotency-Key always represents a byte-identical send.
      const { data: preparedRows, error: prepareError } = await db.rpc("prepare_import_notification_delivery", {
        p_delivery_key: claim.delivery_key,
        p_notification_ids: claim.notification_ids,
        p_lease_token: claim.lease_token,
        p_recipient_email: email,
        p_request_from: FROM,
        p_request_reply_to: REPLY_TO,
        p_request_subject: rendered.subject,
        p_request_html: rendered.html,
        p_request_text: plainTextFromImportHtml(rendered.html),
        p_request_tags: importEmailTags(claim.kind),
      });
      const prepared = (Array.isArray(preparedRows) ? preparedRows[0] : null) as PreparedDelivery | null;
      if (prepareError || !prepared?.recipient_email || !prepared.request_from || !prepared.request_reply_to
        || !prepared.request_subject || !prepared.request_html || !prepared.request_text
        || !Array.isArray(prepared.request_tags) || prepared.request_tags.length < 1) {
        // No network call occurred, so an expired lease can safely retry. Avoid a
        // second mutation when the preparation CAS itself is ambiguous.
        persistenceFailed++;
        console.error(
          "[norva-import-notify] delivery preparation failed",
          claim.delivery_key,
          prepareError?.message ?? "stale lease",
        );
        continue;
      }

      const result = await sendImportEmail(prepared, claim.delivery_key);
      if (!result.ok) {
        console.error(
          "[norva-import-notify] Resend delivery failed",
          claim.delivery_key,
          result.httpStatus ?? "network",
        );
        await recordFailure(
          claim,
          result.retryable,
          result.error ?? "Resend delivery failed",
          result.httpStatus,
          result.response,
        );
        continue;
      }

      const { data: completed, error: completeError } = await db.rpc("complete_import_notification_delivery", {
        p_delivery_key: claim.delivery_key,
        p_notification_ids: claim.notification_ids,
        p_lease_token: claim.lease_token,
        p_recipient_email: prepared.recipient_email,
        p_http_status: result.httpStatus,
        p_resend_email_id: result.emailId,
        p_response: result.response,
      });
      if (completeError || completed !== true) {
        // Do not overwrite this accepted response with a failure transition. The
        // lease expires and the same Idempotency-Key safely reconciles it later.
        persistenceFailed++;
        console.error(
          "[norva-import-notify] accepted delivery acknowledgement failed",
          claim.delivery_key,
          result.emailId,
          completeError?.message ?? "stale lease",
        );
        continue;
      }

      sent += claim.notification_ids.length;
      // Mobile push (app-closed) remains best-effort and is attempted only after
      // the durable email acknowledgement has committed.
      if (claim.kind === "import_completed" || claim.kind === "import_failed") {
        await sendPushForGroup(db, userId, claim.kind, providers);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[norva-import-notify] delivery failed", claim.delivery_key, message);
      await recordFailure(claim, true, message);
    }
  }

  return {
    groups: claims.length,
    sent,
    skipped,
    failed,
    dead_letter: deadLetter,
    persistence_failed: persistenceFailed,
    rows,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Cron auth: same secret check as the source-sync crons.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok, error: authErr } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (authErr || ok !== true) return json({ error: "Unauthorized" }, 403);

  try {
    const result = await runDigest(db);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[norva-import-notify] digest failed", e instanceof Error ? e.message : e);
    return json({ error: "digest failed" }, 500);
  }
});
