// Lifecycle / billing email cron. A pg_cron job POSTs here every ~15 min; this scans the
// cloud_entitlement_projection and sends, once each, the right lifecycle email via Resend, then
// stamps the send marker (see migration 20260703160000). English-only. Auth mirrors the other
// crons (norva_verify_cron_secret).
//
//   - WELCOME            → always active (independent of billing). New projections (proxy for a
//                          new signup that reached the app) created in the last 72h.
//   - TRIAL J-2 REMINDER → GATED behind NORVA_LIFECYCLE_BILLING_LIVE=true. Only meaningful once the
//                          trial is CARD-backed and auto-converts; sending "we'll charge you in 2
//                          days" in the legacy no-card mode would be false, so it stays off.
//   - DUNNING (1..3)     → GATED. Escalating reminders while status='past_due'.
//   - WIN-BACK           → GATED. Once, a few days after expiry/cancel.
//
// Cron to register AT/AFTER DEPLOY (pointing a cron at a missing function 404s every run):
//   select cron.schedule('norva-lifecycle', '*/15 * * * *', $$
//     select net.http_post(
//       url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-lifecycle/cron/run',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 60000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  renderWelcome, renderTrialEnding, renderPaymentFailed, renderWinback, renderAbandonedCheckout, type Rendered,
} from "../_shared/lifecycle-email.ts";
import { sendFcmPush, fcmConfigured } from "../_shared/fcm.ts";
import { syncResendAudienceContact } from "../_shared/resend-audience.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const PUBLIC_FUNCTIONS_URL = (Deno.env.get("SUPABASE_PUBLIC_URL") ?? SUPABASE_URL).replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// Environment-specific by design: staging must never fall back to the production
// audience. Missing ID leaves the durable queue untouched and fails closed.
const RESEND_AUDIENCE_ID = (Deno.env.get("RESEND_AUDIENCE_ID") ?? "").trim();
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const UNSUBSCRIBE_SECRET = Deno.env.get("NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET") ?? "";
const POSTAL_ADDRESS = (Deno.env.get("NORVA_POSTAL_ADDRESS") ?? "").trim();
const flag = (name: string) => (Deno.env.get(name) ?? "false").toLowerCase() === "true";
// NORVA_LIFECYCLE_BILLING_LIVE is now a MASTER kill-switch: nothing billing-related
// sends unless it is true AND the flow's own flag is true. This replaces the old
// single flag that unleashed all five flows at once — so each can be enabled only
// when it is actually ready (dunning provider-scoped, marketing consent + unsubscribe
// in place, abandoned repointed off the retired Stancer table). Setting only the
// master now does NOTHING, which is the safe default.
const BILLING_LIVE = flag("NORVA_LIFECYCLE_BILLING_LIVE");
const LC_TRIAL = flag("NORVA_LC_TRIAL");         // edge trial reminder (see runTrialReminder note — DB crons already do this)
const LC_DUNNING = flag("NORVA_LC_DUNNING");     // failed-payment escalation (Revolut/web only)
const LC_EXPIRE = flag("NORVA_LC_EXPIRE");       // past_due → expired state transition
const LC_WINBACK = flag("NORVA_LC_WINBACK");     // MARKETING; remains false unless explicitly enabled
const LC_ABANDONED = flag("NORVA_LC_ABANDONED"); // MARKETING; remains false unless explicitly enabled
const WELCOME_WINDOW_H = 72;   // don't email the historical base — only recent signups
const BATCH = 100;
// Start every claimed contact immediately. Ten concurrent contacts cap Resend
// pressure while keeping PATCH→POST→PATCH (3 × 12s) well inside the 180s lease.
const RESEND_OUTBOX_BATCH = 10;
// Transactional sends retain the mailto fallback. Marketing sends add a signed
// HTTPS endpoint plus List-Unsubscribe-Post for RFC8058 one-click handling.
const UNSUB_MAILTO = "mailto:unsubscribe@norva.tv?subject=unsubscribe";
const UNSUBSCRIBE_URL = `${PUBLIC_FUNCTIONS_URL}/functions/v1/norva-lifecycle/unsubscribe`;
// Consent is necessary but not sufficient: commercial sends also require a stable
// HMAC secret for RFC8058 and the registered postal address rendered in the footer.
// The internal self-host URL is http://kong:8000, so accepting SUPABASE_URL here
// would put an unreachable, non-HTTPS link in every marketing message.
const MARKETING_READY = Boolean(
  UNSUBSCRIBE_SECRET.length >= 32 && POSTAL_ADDRESS && /^https:\/\/[^/]+/i.test(PUBLIC_FUNCTIONS_URL),
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const UTF8 = new TextEncoder();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function unsubscribeKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw", UTF8.encode(UNSUBSCRIBE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

async function makeUnsubscribeToken(userId: string): Promise<string> {
  const payload = base64Url(UTF8.encode(JSON.stringify({ v: 1, user_id: userId })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await unsubscribeKey(), UTF8.encode(payload)));
  return `${payload}.${base64Url(signature)}`;
}

async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  if (!UNSUBSCRIBE_SECRET || token.length > 1024) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await unsubscribeKey(), base64UrlDecode(signature).buffer as ArrayBuffer, UTF8.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { v?: number; user_id?: string };
    return parsed.v === 1 && UUID_RE.test(parsed.user_id ?? "") ? parsed.user_id! : null;
  } catch (_) {
    return null;
  }
}

async function marketingEmailAllowed(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!MARKETING_READY) return false;
  const { data, error } = await db.rpc("norva_marketing_email_allowed", { p_user_id: userId });
  if (error) {
    console.error("[norva-lifecycle] marketing consent check failed", userId, error.message);
    return false;
  }
  return data === true;
}

type ResendAudienceClaim = {
  email: string;
  user_id: string | null;
  desired_unsubscribed: boolean;
  first_name: string | null;
  revision: number;
  attempt_count: number;
  lease_token: string;
};

// Durable audience reconciliation is operational, not a marketing send. It runs
// on every authenticated lifecycle cron invocation even while every marketing flow
// flag is OFF, and acknowledges a revision only after Resend confirms HTTP success.
async function runResendAudienceOutbox(db: SupabaseClient) {
  if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) {
    return { configured: false, claimed: 0, synced: 0, failed: 0, persistence_failed: 0 };
  }

  const { data, error } = await db.rpc("claim_resend_audience_outbox", {
    p_limit: RESEND_OUTBOX_BATCH,
    p_lease_seconds: 180,
  });
  if (error) {
    console.error("[norva-lifecycle] Resend audience outbox claim failed", error.message);
    return { configured: true, claimed: 0, synced: 0, failed: 0, persistence_failed: 1 };
  }

  const claims = (data ?? []) as ResendAudienceClaim[];
  let synced = 0;
  let failed = 0;
  let persistenceFailed = 0;

  await Promise.all(claims.map(async (claim) => {
    const result = await syncResendAudienceContact({
      apiKey: RESEND_API_KEY,
      audienceId: RESEND_AUDIENCE_ID,
      email: claim.email,
      unsubscribed: claim.desired_unsubscribed,
      firstName: claim.first_name,
    });

    if (result.ok) {
      const { data: applied, error: completeError } = await db.rpc("complete_resend_audience_outbox", {
        p_email: claim.email,
        p_revision: claim.revision,
        p_lease_token: claim.lease_token,
        p_http_status: result.httpStatus,
        p_result: result.result,
      });
      if (completeError || applied !== true) {
        // A false CAS means a newer preference/email revision now owns this row.
        // It is intentionally not called synced; the newer desired state will run.
        persistenceFailed++;
        console.error(
          "[norva-lifecycle] Resend audience completion CAS failed",
          completeError?.message ?? `stale revision ${claim.revision}`,
        );
      } else synced++;
      return;
    }

    const { data: recorded, error: failError } = await db.rpc("fail_resend_audience_outbox", {
      p_email: claim.email,
      p_revision: claim.revision,
      p_lease_token: claim.lease_token,
      p_http_status: result.httpStatus,
      p_result: result.result,
      p_error: result.error,
    });
    if (failError || recorded !== true) {
      persistenceFailed++;
      console.error(
        "[norva-lifecycle] Resend audience failure CAS failed",
        failError?.message ?? `stale revision ${claim.revision}`,
      );
    } else {
      failed++;
      console.error(
        "[norva-lifecycle] Resend audience request failed",
        result.httpStatus ?? "network",
        result.error ?? "unknown error",
      );
    }
  }));

  return {
    configured: true,
    claimed: claims.length,
    synced,
    failed,
    persistence_failed: persistenceFailed,
  };
}

function unsubscribeHtml(token: string, completed: boolean): Response {
  const body = completed
    ? `<h1>You are unsubscribed</h1><p>Norva will no longer send you marketing emails. Transactional account and billing messages are unaffected.</p>`
    : `<h1>Unsubscribe from marketing emails?</h1><p>Transactional account and billing messages will still be delivered.</p>
       <form method="post" action="?token=${encodeURIComponent(token)}">
         <input type="hidden" name="List-Unsubscribe" value="One-Click">
         <button type="submit">Unsubscribe</button>
       </form>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norva email preferences</title><style>body{margin:0;background:#0a0c11;color:#f8fafc;font:16px Arial,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:520px;padding:36px;background:#11151d;border:1px solid #263044;border-radius:16px}p{color:#aab4c8;line-height:1.6}button{border:0;border-radius:10px;padding:13px 20px;background:#5b7cfa;color:#fff;font-weight:700;cursor:pointer}</style></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      "Cache-Control": "no-store",
    },
  });
}

interface Proj { user_id: string; status: string; trial_ends_at: string | null; plan_code: string | null; dunning_stage: number | null }

function firstNameOf(user: { user_metadata?: Record<string, unknown>; email?: string } | null): string | null {
  const m = user?.user_metadata ?? {};
  const full = String(m.full_name ?? m.name ?? m.display_name ?? m.first_name ?? "").trim();
  if (full) return full.split(/\s+/)[0];
  return null;
}

function planLabel(code: string | null): string {
  const c = String(code ?? "").toLowerCase();
  if (c.includes("family")) return "Norva Family";
  if (c.includes("plus") || c.includes("plan")) return "Norva";
  return "your Norva plan";
}

// Resolve a user's email + first name, then send one rendered email. Returns true on success.
async function emailUser(
  db: SupabaseClient,
  userId: string,
  make: (firstName: string | null, context: { unsubscribeUrl?: string }) => Rendered,
  opts: { idempotencyKey?: string; marketing?: boolean } = {},
): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  // This is the final, race-aware gate immediately before the external send.
  // Missing consent, an unsubscribe, an internal account, or incomplete RFC8058
  // configuration all fail closed without affecting transactional email.
  if (opts.marketing && !await marketingEmailAllowed(db, userId)) return false;
  const { data: u } = await db.auth.admin.getUserById(userId);
  const email = u?.user?.email ?? null;
  if (!email) return false;
  const unsubscribeUrl = opts.marketing
    ? `${UNSUBSCRIBE_URL}?token=${encodeURIComponent(await makeUnsubscribeToken(userId))}`
    : undefined;
  const rendered = make(firstNameOf(u?.user ?? null), { unsubscribeUrl });
  const unsubscribeHeaders = opts.marketing && unsubscribeUrl
    ? {
      "List-Unsubscribe": `<${UNSUB_MAILTO}>, <${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }
    : null;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: FROM, to: [email], subject: rendered.subject, html: rendered.html,
      ...(unsubscribeHeaders ? { headers: unsubscribeHeaders } : {}),
    }),
  });
  if (!res.ok) { console.error("[norva-lifecycle] Resend failed", res.status, await res.text().catch(() => "")); return false; }
  return true;
}

// Best-effort billing push on the existing FCM rail (same pattern as import-notify):
// rides along the emails so the reminder reaches the phone even with mail unread.
async function pushUser(db: SupabaseClient, userId: string, title: string, body: string, kind: string): Promise<void> {
  if (!fcmConfigured()) return;
  try {
    const { data: toks } = await db.from("cloud_push_tokens").select("token").eq("user_id", userId);
    for (const t of (toks ?? []) as { token: string }[]) {
      const r = await sendFcmPush(t.token, { title, body, data: { kind } });
      if (r.unregistered) { try { await db.from("cloud_push_tokens").delete().eq("token", t.token); } catch (_) { /* noop */ } }
    }
  } catch (_) { /* push is best-effort — never block the email path */ }
}

// Atomically CLAIM a per-user send marker before sending, so two overlapping cron
// runs can't both send the same email. The UPDATE is a compare-and-swap: it only
// flips the column when it is still NULL, and .select() returns the row only to the
// run that won. Send AFTER claiming; on failure, release() so a later run retries.
async function claimMarker(db: SupabaseClient, userId: string, column: string): Promise<boolean> {
  const { data } = await db.from("cloud_entitlement_projection")
    .update({ [column]: new Date().toISOString() })
    .eq("user_id", userId).is(column, null).select("user_id");
  return Array.isArray(data) && data.length > 0;
}
async function releaseMarker(db: SupabaseClient, userId: string, column: string): Promise<void> {
  try { await db.from("cloud_entitlement_projection").update({ [column]: null }).eq("user_id", userId); } catch (_) { /* noop */ }
}

async function runWelcome(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - WELCOME_WINDOW_H * 3600_000).toISOString();
  const { data } = await db.from("cloud_entitlement_projection")
    .select("user_id")
    .is("welcome_email_at", null)
    .gt("created_at", since)
    .limit(BATCH);
  // Never welcome internal/test accounts (owner, family, internal test) — mirrors
  // the admin_internal_accounts exclusion the finance/funnel views already apply.
  const { data: internal } = await db.from("admin_internal_accounts").select("user_id");
  const internalIds = new Set((internal ?? []).map((r: { user_id: string }) => r.user_id));
  let sent = 0;
  for (const row of (data ?? []) as { user_id: string }[]) {
    if (internalIds.has(row.user_id)) continue;
    if (!await claimMarker(db, row.user_id, "welcome_email_at")) continue; // another run got it
    try {
      if (await emailUser(db, row.user_id, (fn) => renderWelcome(fn))) sent++;
      else await releaseMarker(db, row.user_id, "welcome_email_at");
    } catch (e) {
      await releaseMarker(db, row.user_id, "welcome_email_at");
      console.error("[norva-lifecycle] welcome failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// NOTE: the LIVE trial-ending reminders are the DB pg_cron jobs norva-trial-ending-3d
// / -1d (migration 20260708120000), which fire regardless of this flag. This edge flow
// is an alternative and stays OFF (LC_TRIAL default false) to avoid DOUBLE-SENDING —
// only enable NORVA_LC_TRIAL if you first unschedule those DB crons. It is also
// provider-scoped to Revolut (web): Play/Apple trials are the store's to remind.
async function runTrialReminder(db: SupabaseClient): Promise<number> {
  // Trials ending in ~36–60h (a "2 days out" window) not yet reminded.
  const lo = new Date(Date.now() + 36 * 3600_000).toISOString();
  const hi = new Date(Date.now() + 60 * 3600_000).toISOString();
  const { data } = await db.from("cloud_entitlement_projection")
    .select("user_id,trial_ends_at,plan_code")
    .eq("provider", "revolut")
    .eq("status", "trialing")
    .is("trial_reminder_email_at", null)
    .gte("trial_ends_at", lo).lte("trial_ends_at", hi)
    .limit(BATCH);
  let sent = 0;
  for (const row of (data ?? []) as Proj[]) {
    if (!await claimMarker(db, row.user_id, "trial_reminder_email_at")) continue;
    try {
      if (await emailUser(db, row.user_id, (fn) => renderTrialEnding(fn, { endsAt: row.trial_ends_at ?? "", planLabel: planLabel(row.plan_code) }))) {
        await pushUser(db, row.user_id, "Your free trial ends soon",
          "Your Norva plan starts then — cancel anytime before if you change your mind.", "trial_ending");
        sent++;
      } else { await releaseMarker(db, row.user_id, "trial_reminder_email_at"); }
    } catch (e) {
      await releaseMarker(db, row.user_id, "trial_reminder_email_at");
      console.error("[norva-lifecycle] trial reminder failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

async function runDunning(db: SupabaseClient): Promise<number> {
  // past_due, at most one email per ~24h, up to 3 stages. PROVIDER-SCOPED to Revolut:
  // a Play/Apple past_due is the store's card to fix, so a Norva "update your card"
  // email with a norva.tv CTA would be a wrong-cohort mis-fire (the store already duns).
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await db.from("cloud_entitlement_projection")
    .select("user_id,dunning_stage,dunning_last_at,status")
    .eq("provider", "revolut")
    .eq("status", "past_due")
    .lt("dunning_stage", 3)
    .or(`dunning_last_at.is.null,dunning_last_at.lt.${cutoff}`)
    .limit(BATCH);
  let sent = 0;
  for (const row of (data ?? []) as (Proj & { dunning_last_at: string | null })[]) {
    const stage = (row.dunning_stage ?? 0) + 1;
    const nowIso = new Date().toISOString();
    // CAS-claim dunning_last_at (its throttle marker) BEFORE sending, so two overlapping
    // runs can't both send this stage: only the run whose observed last_at still matches
    // flips it; the loser matches 0 rows and skips. Guarded on status past_due too.
    let claim = db.from("cloud_entitlement_projection")
      .update({ dunning_last_at: nowIso })
      .eq("user_id", row.user_id).eq("status", "past_due");
    claim = row.dunning_last_at == null
      ? claim.is("dunning_last_at", null)
      : claim.eq("dunning_last_at", row.dunning_last_at);
    const { data: claimed } = await claim.select("user_id");
    if (!Array.isArray(claimed) || !claimed.length) continue;   // another run claimed it (or user recovered)
    try {
      if (await emailUser(db, row.user_id, (fn) => renderPaymentFailed(fn, stage))) {
        await db.from("cloud_entitlement_projection")
          .update({ dunning_stage: stage })
          .eq("user_id", row.user_id).eq("status", "past_due");
        await pushUser(db, row.user_id, "Payment issue on your Norva plan",
          "We couldn't process your payment — update your card to keep watching.", "payment_failed");
        sent++;
      } else {
        // send failed → roll the throttle marker back so a later run retries this stage
        await db.from("cloud_entitlement_projection").update({ dunning_last_at: row.dunning_last_at }).eq("user_id", row.user_id);
      }
    } catch (e) {
      try { await db.from("cloud_entitlement_projection").update({ dunning_last_at: row.dunning_last_at }).eq("user_id", row.user_id); } catch (_) { /* noop */ }
      console.error("[norva-lifecycle] dunning failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// MARKETING email (not transactional). It is consent-gated twice (before claim and
// immediately before Resend), carries RFC8058 one-click headers, and stays OFF by
// default until the per-flow flag is deliberately enabled.
async function runWinback(db: SupabaseClient): Promise<number> {
  // Once, 3–30 days after the subscription lapsed.
  const lo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const hi = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data } = await db.from("cloud_entitlement_projection")
    .select("user_id,last_event_at,status")
    .in("status", ["expired", "canceled", "cancelled"])
    .is("winback_email_at", null)
    .gte("last_event_at", lo).lte("last_event_at", hi)
    .limit(BATCH);
  let sent = 0;
  for (const row of (data ?? []) as (Proj & { last_event_at: string })[]) {
    if (!await marketingEmailAllowed(db, row.user_id)) continue;
    if (!await claimMarker(db, row.user_id, "winback_email_at")) continue;
    try {
      if (await emailUser(
        db,
        row.user_id,
        (fn, context) => renderWinback(fn, { unsubscribeUrl: context.unsubscribeUrl }),
        { idempotencyKey: `norva-winback-${row.user_id}`, marketing: true },
      )) {
        // Push is marketing too: re-check after the email in case the user opted
        // out in the small interval between the two external deliveries.
        if (await marketingEmailAllowed(db, row.user_id)) {
          await pushUser(db, row.user_id, "Your Norva catalog is waiting",
            "Pick up right where you left off — reactivate anytime.", "winback");
        }
        sent++;
      } else { await releaseMarker(db, row.user_id, "winback_email_at"); }
    } catch (e) {
      await releaseMarker(db, row.user_id, "winback_email_at");
      console.error("[norva-lifecycle] winback failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// Checkout-abandonment relance: one email (+push), 1–48h after the latest Revolut
// card-check was opened but never completed. The SQL RPC atomically elects one cron,
// suppresses older attempts when a newer tab was opened, and excludes internal/live
// accounts. The SQL claim and Edge sender both require explicit consent; the flow
// still remains OFF by default and needs both the master and per-flow flags.
async function runAbandoned(db: SupabaseClient): Promise<number> {
  type Claim = {
    order_id: string;
    user_id: string;
    plan: string | null;
    period: string | null;
    amount: number | null;
    currency: string | null;
    claimed_at: string;
  };
  const { data, error } = await db.rpc("claim_revolut_abandoned_orders", { p_limit: BATCH });
  if (error) throw new Error(`abandoned claim failed: ${error.message}`);
  let sent = 0;
  for (const row of (data ?? []) as Claim[]) {
    const release = async () => {
      const { error: releaseError } = await db.from("cloud_revolut_orders")
        .update({ reminder_claimed_at: null, updated_at: new Date().toISOString() })
        .eq("order_id", row.order_id)
        .eq("reminder_claimed_at", row.claimed_at)
        .is("reminder_sent_at", null);
      if (releaseError) console.error("[norva-lifecycle] abandoned release failed", row.order_id, releaseError.message);
    };
    const finish = async () => {
      const nowIso = new Date().toISOString();
      const { data: updated, error: updateError } = await db.from("cloud_revolut_orders")
        .update({ reminder_sent_at: nowIso, reminder_claimed_at: null, updated_at: nowIso })
        .eq("order_id", row.order_id)
        .eq("reminder_claimed_at", row.claimed_at)
        .is("reminder_sent_at", null)
        .select("order_id");
      if (updateError) throw new Error(`abandoned finalize failed: ${updateError.message}`);
      if (!Array.isArray(updated) || updated.length !== 1) throw new Error("abandoned claim was lost before finalize");
    };
    try {
      if (!await marketingEmailAllowed(db, row.user_id)) { await release(); continue; }
      // Last-moment race guard: the user may have paid after the SQL claim.
      const { data: proj, error: projError } = await db.from("cloud_entitlement_projection")
        .select("status,trial_ends_at,current_period_end").eq("user_id", row.user_id).maybeSingle();
      if (projError) throw new Error(`projection recheck failed: ${projError.message}`);
      const p = proj as { status?: string; trial_ends_at?: string; current_period_end?: string } | null;
      const nowMs = Date.now();
      const status = String(p?.status ?? "");
      const live =
        (status === "trialing" && new Date(p?.trial_ends_at ?? 0).getTime() > nowMs) ||
        (["active", "cancelled_at_period_end"].includes(status) &&
          (!p?.current_period_end || new Date(p.current_period_end).getTime() > nowMs));
      if (live) { await finish(); continue; }

      // New orders carry immutable plan/period. Only legacy rows need the mutable
      // customer fallback; those rows are all internal in today's production data.
      let plan = row.plan ?? undefined;
      let period = row.period ?? undefined;
      if (!plan || !period) {
        const { data: customer } = await db.from("cloud_revolut_customers")
          .select("plan,period").eq("user_id", row.user_id).maybeSingle();
        const c = customer as { plan?: string; period?: string } | null;
        plan ||= c?.plan;
        period ||= c?.period;
      }
      const currency = String(row.currency ?? "USD").toUpperCase();
      const amount = Number(row.amount ?? 50);
      const validationAmount = currency === "USD" && Number.isFinite(amount)
        ? `$${(amount / 100).toFixed(2)}`
        : "$0.50";
      if (await emailUser(
        db,
        row.user_id,
        (fn, context) => renderAbandonedCheckout(fn, {
          plan, period, validationAmount, unsubscribeUrl: context.unsubscribeUrl,
        }),
        { idempotencyKey: `norva-abandoned-${row.order_id}`, marketing: true },
      )) {
        await finish();
        if (await marketingEmailAllowed(db, row.user_id)) {
          await pushUser(db, row.user_id, "Your free trial is one step away",
            "Finish the quick card check — no charge today.", "abandoned_checkout");
        }
        sent++;
      } else await release();
    } catch (e) {
      await release();
      console.error("[norva-lifecycle] abandoned failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// Close the dunning loop: a Revolut past_due that exhausted its 3 reminders (7+ days
// ago), or that has been stuck for 21+ days, becomes `expired` — access ends cleanly
// and the win-back email can eventually re-engage. RevenueCat rows are untouched
// (the store webhook owns their expiration).
async function runExpirePastDue(db: SupabaseClient): Promise<number> {
  const nowIso = new Date().toISOString();
  const staleDunning = new Date(Date.now() - 7 * 86400_000).toISOString();
  const staleAny = new Date(Date.now() - 21 * 86400_000).toISOString();
  let expired = 0;
  const { data: exhausted } = await db.from("cloud_entitlement_projection")
    .select("user_id").eq("provider", "revolut").eq("status", "past_due")
    .gte("dunning_stage", 3).lte("dunning_last_at", staleDunning).limit(BATCH);
  const { data: stuck } = await db.from("cloud_entitlement_projection")
    .select("user_id").eq("provider", "revolut").eq("status", "past_due")
    .lte("last_event_at", staleAny).limit(BATCH);
  const ids = new Set<string>([
    ...((exhausted ?? []) as { user_id: string }[]).map((r) => r.user_id),
    ...((stuck ?? []) as { user_id: string }[]).map((r) => r.user_id),
  ]);
  for (const userId of ids) {
    // Guard the transition on status STILL past_due — a webhook may have flipped the
    // user back to active (they paid) between the SELECT above and this UPDATE; never
    // expire a now-paying account.
    const { data: upd } = await db.from("cloud_entitlement_projection")
      .update({ status: "expired", last_event_at: nowIso })
      .eq("user_id", userId).eq("status", "past_due").select("user_id");
    if (Array.isArray(upd) && upd.length) expired++;
  }
  return expired;
}

async function authenticatedUserId(db: SupabaseClient, req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  return !error && data.user?.id ? data.user.id : null;
}

async function readMarketingPreference(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("cloud_marketing_email_preferences")
    .select("marketing_email_opt_in,opted_in_at,opted_in_source,unsubscribed_at,unsubscribed_source,updated_at")
    .eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`preference read failed: ${error.message}`);
  return data as {
    marketing_email_opt_in?: boolean;
    opted_in_at?: string | null;
    opted_in_source?: string | null;
    unsubscribed_at?: string | null;
    unsubscribed_source?: string | null;
    updated_at?: string | null;
  } | null;
}

async function setMarketingPreference(
  db: SupabaseClient,
  userId: string,
  enabled: boolean,
  source: string,
): Promise<{ changed: boolean; preference: Awaited<ReturnType<typeof readMarketingPreference>> }> {
  const current = await readMarketingPreference(db, userId);
  if (enabled && current?.marketing_email_opt_in === true && !current.unsubscribed_at) {
    return { changed: false, preference: current };
  }
  if (!enabled && current?.marketing_email_opt_in === false && current.unsubscribed_at) {
    return { changed: false, preference: current };
  }

  const nowIso = new Date().toISOString();
  const payload: {
    user_id: string;
    marketing_email_opt_in: boolean;
    opted_in_at: string | null;
    opted_in_source: string | null;
    unsubscribed_at: string | null;
    unsubscribed_source: string | null;
    updated_at: string;
  } = {
    user_id: userId,
    marketing_email_opt_in: enabled,
    // Preserve historical opt-in evidence on unsubscribe for auditability.
    opted_in_at: enabled ? nowIso : (current?.opted_in_at ?? null),
    opted_in_source: enabled ? source : (current?.opted_in_source ?? null),
    unsubscribed_at: enabled ? null : (current?.unsubscribed_at ?? nowIso),
    unsubscribed_source: enabled
      ? null
      : (current?.unsubscribed_at ? (current.unsubscribed_source ?? source) : source),
    updated_at: nowIso,
  };
  const { error } = await db.from("cloud_marketing_email_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw new Error(`preference update failed: ${error.message}`);
  return { changed: true, preference: await readMarketingPreference(db, userId) };
}

async function handleUnsubscribe(db: SupabaseClient, req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = url.searchParams.get("token") ?? "";
  const userId = await verifyUnsubscribeToken(token);
  if (!userId) return json({ error: "Invalid unsubscribe link" }, 400);
  // GET is deliberately non-mutating so link scanners cannot unsubscribe a user.
  // Mail clients perform RFC8058 one-click with POST; browser clicks show a form.
  if (req.method === "GET") return unsubscribeHtml(token, false);
  try {
    const { data: account } = await db.auth.admin.getUserById(userId);
    // A deleted account is already unable to receive lifecycle marketing; keep an
    // old one-click link idempotently successful instead of surfacing a 500.
    if (!account.user) return unsubscribeHtml(token, true);
    await setMarketingPreference(db, userId, false, "rfc8058_one_click");
    return unsubscribeHtml(token, true);
  } catch (e) {
    console.error("[norva-lifecycle] unsubscribe failed", userId, e instanceof Error ? e.message : e);
    return json({ error: "Unable to update preference" }, 500);
  }
}

async function handlePreferences(db: SupabaseClient, req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const userId = await authenticatedUserId(db, req);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  try {
    if (req.method === "GET") {
      const preference = await readMarketingPreference(db, userId);
      const { data: effective } = await db.rpc("norva_marketing_email_allowed", { p_user_id: userId });
      return json({
        marketing_email: preference?.marketing_email_opt_in === true && !preference.unsubscribed_at,
        effective: MARKETING_READY && effective === true,
        delivery_configured: MARKETING_READY,
        opted_in_at: preference?.opted_in_at ?? null,
        opted_in_source: preference?.opted_in_source ?? null,
        unsubscribed_at: preference?.unsubscribed_at ?? null,
        unsubscribed_source: preference?.unsubscribed_source ?? null,
      });
    }

    const body = await req.json().catch(() => null) as { marketing_email?: unknown; source?: unknown } | null;
    if (typeof body?.marketing_email !== "boolean") {
      return json({ error: "marketing_email must be a boolean" }, 400);
    }
    const allowedSources = new Set(["account_settings", "signup_checkbox", "checkout_checkbox"]);
    const requestedSource = typeof body.source === "string" ? body.source : "account_settings";
    const source = allowedSources.has(requestedSource) ? requestedSource : "account_settings";
    const result = await setMarketingPreference(db, userId, body.marketing_email, source);
    const { data: effective } = await db.rpc("norva_marketing_email_allowed", { p_user_id: userId });
    return json({
      ok: true,
      changed: result.changed,
      marketing_email: result.preference?.marketing_email_opt_in === true && !result.preference?.unsubscribed_at,
      effective: MARKETING_READY && effective === true,
      delivery_configured: MARKETING_READY,
      opted_in_at: result.preference?.opted_in_at ?? null,
      unsubscribed_at: result.preference?.unsubscribed_at ?? null,
      unsubscribed_source: result.preference?.unsubscribed_source ?? null,
    });
  } catch (e) {
    console.error("[norva-lifecycle] preference endpoint failed", userId, e instanceof Error ? e.message : e);
    return json({ error: "Unable to update preference" }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const url = new URL(req.url);
  if (url.pathname.endsWith("/unsubscribe")) return await handleUnsubscribe(db, req, url);
  if (url.pathname.endsWith("/preferences")) return await handlePreferences(db, req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok, error: authErr } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (authErr || ok !== true) return json({ error: "Unauthorized" }, 403);

  try {
    // Each billing flow needs the MASTER switch AND its own per-flow flag. Setting only
    // NORVA_LIFECYCLE_BILLING_LIVE now enables nothing — that's the safe default. Enable
    // a flow only when it is ready (see each runX note for its preconditions).
    const out: Record<string, unknown> = {
      billing_live: BILLING_LIVE,
      marketing_ready: MARKETING_READY,
      enabled: { trial: LC_TRIAL, dunning: LC_DUNNING, expire: LC_EXPIRE && LC_DUNNING, winback: LC_WINBACK, abandoned: LC_ABANDONED },
    };
    // Audience state is reconciled regardless of marketing feature flags. Those
    // flags control sends; they must never prevent unsubscribe propagation/retries.
    out.resend_audience = await runResendAudienceOutbox(db);
    out.welcome = await runWelcome(db);              // always active (transactional)
    if (BILLING_LIVE && LC_TRIAL) out.trial_reminder = await runTrialReminder(db);
    if (BILLING_LIVE && LC_DUNNING) out.dunning = await runDunning(db);
    // Expiry is never allowed to run without the warning/dunning flow, even if
    // an environment variable is accidentally toggled in isolation.
    if (BILLING_LIVE && LC_DUNNING && LC_EXPIRE) out.expired_past_due = await runExpirePastDue(db);
    if (BILLING_LIVE && LC_WINBACK) out.winback = await runWinback(db);
    if (BILLING_LIVE && LC_ABANDONED) out.abandoned = await runAbandoned(db);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error("[norva-lifecycle] run failed", e instanceof Error ? e.message : e);
    return json({ error: "run failed" }, 500);
  }
});
