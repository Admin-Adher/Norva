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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
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
const LC_WINBACK = flag("NORVA_LC_WINBACK");     // MARKETING — needs consent + unsubscribe before enabling
const LC_ABANDONED = flag("NORVA_LC_ABANDONED"); // MARKETING — retired-table dependency; needs repoint before enabling
const WELCOME_WINDOW_H = 72;   // don't email the historical base — only recent signups
const BATCH = 100;
// CAN-SPAM / GDPR: every send carries a List-Unsubscribe header; the address below
// receives opt-outs. (A one-click RFC-8058 https endpoint is a follow-up before the
// marketing flows — winback/abandoned — may be enabled.)
const UNSUB_MAILTO = "mailto:unsubscribe@norva.tv?subject=unsubscribe";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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
async function emailUser(db: SupabaseClient, userId: string, make: (firstName: string | null) => Rendered): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  const { data: u } = await db.auth.admin.getUserById(userId);
  const email = u?.user?.email ?? null;
  if (!email) return false;
  const rendered = make(firstNameOf(u?.user ?? null));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [email], subject: rendered.subject, html: rendered.html,
      headers: { "List-Unsubscribe": `<${UNSUB_MAILTO}>` },
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
    try {
      if (await emailUser(db, row.user_id, (fn) => renderPaymentFailed(fn, stage))) {
        // Guard the stamp on status still past_due — don't advance a user who paid mid-run.
        await db.from("cloud_entitlement_projection")
          .update({ dunning_stage: stage, dunning_last_at: new Date().toISOString() })
          .eq("user_id", row.user_id).eq("status", "past_due");
        await pushUser(db, row.user_id, "Payment issue on your Norva plan",
          "We couldn't process your payment — update your card to keep watching.", "payment_failed");
        sent++;
      }
    } catch (e) { console.error("[norva-lifecycle] dunning failed", row.user_id, e instanceof Error ? e.message : e); }
  }
  return sent;
}

// MARKETING email (not transactional). Before enabling LC_WINBACK you MUST add a
// marketing-consent gate + one-click unsubscribe (RFC 8058) — there is no opt-out
// column yet, so this can currently send to users who never consented. Kept OFF.
async function runWinback(db: SupabaseClient): Promise<number> {
  // Once, 3–30 days after the subscription lapsed.
  const lo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const hi = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data } = await db.from("cloud_entitlement_projection")
    .select("user_id,updated_at,status")
    .in("status", ["expired", "canceled", "cancelled"])
    .is("winback_email_at", null)
    .gte("updated_at", lo).lte("updated_at", hi)
    .limit(BATCH);
  let sent = 0;
  for (const row of (data ?? []) as (Proj & { updated_at: string })[]) {
    if (!await claimMarker(db, row.user_id, "winback_email_at")) continue;
    try {
      if (await emailUser(db, row.user_id, (fn) => renderWinback(fn))) {
        await pushUser(db, row.user_id, "Your Norva catalog is waiting",
          "Pick up right where you left off — reactivate anytime.", "winback");
        sent++;
      } else { await releaseMarker(db, row.user_id, "winback_email_at"); }
    } catch (e) {
      await releaseMarker(db, row.user_id, "winback_email_at");
      console.error("[norva-lifecycle] winback failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// Checkout-abandonment relance: one email (+push), 1–48h after a card-check
// checkout was opened but never completed. Skips users who finished elsewhere.
// The low bound is ~1h ON PURPOSE: abandoned-checkout recovery peaks when the
// reminder lands within the hour and roughly halves after 24h (Klaviyo/SaleCycle
// 2024) — with the cron running every 15 min, the send lands at ≈1h-1h15.
// BLOCKED — reads cloud_stancer_payments, the RETIRED Stancer table (the web rail is
// now Revolut → cloud_revolut_orders, migration 20260711200000). On the live rail this
// recovers NOTHING (empty/stale). Before enabling LC_ABANDONED: repoint to
// cloud_revolut_orders (add a reminder_sent_at column + map the order state), AND add
// the same marketing-consent + unsubscribe gate as win-back. Kept OFF.
async function runAbandoned(db: SupabaseClient): Promise<number> {
  const lo = new Date(Date.now() - 48 * 3600_000).toISOString();
  const hi = new Date(Date.now() - 1 * 3600_000).toISOString();
  const { data } = await db.from("cloud_stancer_payments")
    .select("pi_id,user_id,created_at")
    .in("kind", ["trial_setup", "resubscribe"])
    .eq("status", "require_payment_method")
    .is("reminder_sent_at", null)
    .gte("created_at", lo).lte("created_at", hi)
    .order("created_at", { ascending: false })
    .limit(BATCH);
  const seen = new Set<string>();
  let sent = 0;
  for (const row of (data ?? []) as { pi_id: string; user_id: string }[]) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    try {
      // Completed through another payment (or another device)? Stamp + skip.
      const { data: proj } = await db.from("cloud_entitlement_projection")
        .select("status").eq("user_id", row.user_id).maybeSingle();
      const st = String((proj as { status?: string } | null)?.status ?? "");
      const stamp = () => db.from("cloud_stancer_payments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("user_id", row.user_id).eq("status", "require_payment_method").is("reminder_sent_at", null);
      if (["trialing", "active", "cancelled_at_period_end"].includes(st)) { await stamp(); continue; }
      // Deep-link back into the checkout with the plan they had picked.
      const { data: cust } = await db.from("cloud_stancer_customers")
        .select("plan,period").eq("user_id", row.user_id).maybeSingle();
      const c = cust as { plan?: string; period?: string } | null;
      if (await emailUser(db, row.user_id, (fn) => renderAbandonedCheckout(fn, { plan: c?.plan, period: c?.period }))) {
        await stamp();
        await pushUser(db, row.user_id, "Your free trial is one step away",
          "Finish the quick card check — no charge today.", "abandoned_checkout");
        sent++;
      }
    } catch (e) { console.error("[norva-lifecycle] abandoned failed", row.user_id, e instanceof Error ? e.message : e); }
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok, error: authErr } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (authErr || ok !== true) return json({ error: "Unauthorized" }, 403);

  try {
    // Each billing flow needs the MASTER switch AND its own per-flow flag. Setting only
    // NORVA_LIFECYCLE_BILLING_LIVE now enables nothing — that's the safe default. Enable
    // a flow only when it is ready (see each runX note for its preconditions).
    const out: Record<string, unknown> = {
      billing_live: BILLING_LIVE,
      enabled: { trial: LC_TRIAL, dunning: LC_DUNNING, expire: LC_EXPIRE, winback: LC_WINBACK, abandoned: LC_ABANDONED },
    };
    out.welcome = await runWelcome(db);              // always active (transactional)
    if (BILLING_LIVE && LC_TRIAL) out.trial_reminder = await runTrialReminder(db);
    if (BILLING_LIVE && LC_DUNNING) out.dunning = await runDunning(db);
    if (BILLING_LIVE && LC_EXPIRE) out.expired_past_due = await runExpirePastDue(db);
    if (BILLING_LIVE && LC_WINBACK) out.winback = await runWinback(db);
    if (BILLING_LIVE && LC_ABANDONED) out.abandoned = await runAbandoned(db);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error("[norva-lifecycle] run failed", e instanceof Error ? e.message : e);
    return json({ error: "run failed" }, 500);
  }
});
