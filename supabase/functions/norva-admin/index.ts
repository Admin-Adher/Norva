// norva-admin — privileged admin actions on users (resend confirmation · change role · suspend).
//
// These touch Supabase Auth (app_metadata.role, ban_duration, confirmation emails), which require the
// SERVICE ROLE key — hence an edge function, not a browser RPC. Every request is gated by an ADMIN
// JWT: we verify the caller's token resolves to a user whose server-set app_metadata.role === 'admin'
// (non-spoofable). Each action writes an admin_events row so it shows in the client's timeline.
//
// Routes (POST):
//   /user/:id/resend-confirmation   → re-send the signup confirmation email
//   /user/:id/role       { role }    → set app_metadata.role to 'admin' | 'user'
//   /user/:id/suspend    { suspend } → ban (suspend) or unban the account
//   /user/:id/refund     { pi_id }   → merchant-initiated Revolut refund of a captured charge
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTelegram, tgEscape } from "../_shared/telegram.ts";
import { sendFcmPush, fcmConfigured } from "../_shared/fcm.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

// Revolut Merchant API (same secret/base every payment function reads — edge secrets are project-wide).
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");

// Ops email is deliberately explicit and singular. Never infer operational
// recipients from auth.users, admin roles, or a currently signed-in account:
// those are product identities, not an incident-notification configuration.
const OPS_EMAIL = (() => {
  const candidate = (Deno.env.get("NORVA_OPS_EMAIL") ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
})();

const htmlEscape = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Constant-time string compare for shared-secret checks (avoids a timing side-channel on the
// backfill token). Length difference short-circuits (length is not itself secret here).
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv", "https://www.norva.tv", "https://app.norva.tv",
  "https://norva-web.pages.dev", "http://localhost:3000", "http://localhost:5173", "http://localhost:4173",
];
function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const isLocal = (() => { try { return origin ? ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname) : false; } catch { return false; } })();
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin) || isLocal) ? origin : allowed[0];
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
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function logEvent(userId: string, kind: string, summary: string, actor: string | null, meta: JsonRecord = {}) {
  try { await admin.from("admin_events").insert({ user_id: userId, kind, summary, actor, meta }); }
  catch (_) { /* best-effort audit */ }
}

async function resolveCapturedResubscribeException(
  orderId: string,
  userId: string,
): Promise<{ result: string | null; error: string | null }> {
  const { data, error } = await admin.rpc("resolve_revolut_resubscribe_refund", {
    p_order_id: orderId,
    p_user_id: userId,
  });
  return {
    result: typeof data === "string" ? data : null,
    error: error?.message ?? null,
  };
}

// Merchant-initiated refund of a Revolut order. Mirrors norva-revolut-billing's charge call
// (new Merchant API + version header — the legacy /api/1.0 payment path 404s). Refunds the given
// amount in the capture's authoritative ISO currency. Returns Revolut's raw
// outcome so the caller can journal + surface it.
async function revolutRefund(
  orderId: string,
  amountCents: number,
  currency: string,
  idempotencyKey: string,
): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
  try {
    const res = await fetch(`${REVOLUT_API_BASE}/api/orders/${encodeURIComponent(orderId)}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Revolut-Api-Version": "2024-09-01",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ amount: amountCents, currency }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
    return { ok: res.ok, status: res.status, body: (parsed ?? {}) as JsonRecord };
  } catch (error) {
    return { ok: false, status: 0, body: {
      error: "network_error", message: error instanceof Error ? error.message : String(error),
    } };
  }
}

async function revolutOrder(orderId: string): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
  try {
    const res = await fetch(`${REVOLUT_API_BASE}/api/orders/${encodeURIComponent(orderId)}`, {
      headers: {
        Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
        "Accept": "application/json",
        "Revolut-Api-Version": "2024-09-01",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch (_) { /* keep raw */ }
    return { ok: res.ok, status: res.status, body: (parsed ?? {}) as JsonRecord };
  } catch (error) {
    return { ok: false, status: 0, body: {
      error: "network_error", message: error instanceof Error ? error.message : String(error),
    } };
  }
}

// Infra URLs live server-side (edge secrets first, else the cloud_runtime_config table). We only need
// reachability, so resolving them here — not exposing them to the browser — is the point of /health.
async function resolveInfraUrls(): Promise<{ gateway: string; relay: string }> {
  let gateway = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
  let relay = (Deno.env.get("NORVA_RELAY_BASE_URL") ?? "").replace(/\/+$/, "");
  if (!gateway || !relay) {
    try {
      const { data } = await admin.from("cloud_runtime_config").select("key,value")
        .in("key", ["NORVA_MEDIA_GATEWAY_URL", "NORVA_RELAY_BASE_URL"]);
      for (const r of (data ?? []) as JsonRecord[]) {
        const v = String(r.value ?? "").replace(/\/+$/, "");
        if (r.key === "NORVA_MEDIA_GATEWAY_URL" && !gateway) gateway = v;
        if (r.key === "NORVA_RELAY_BASE_URL" && !relay) relay = v;
      }
    } catch (_) { /* best-effort */ }
  }
  return { gateway, relay };
}

// Liveness ping: ANY HTTP response (even 404) means the host is reachable ("up"); a network error or
// timeout means "down". Robust without knowing each service's exact health path.
async function ping(url: string): Promise<JsonRecord> {
  const start = performance.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4500) });
    await res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status, ms: Math.round(performance.now() - start) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - start), error: String((e as Error)?.message ?? e).slice(0, 80) };
  }
}

// ── Proactive ops alerting (pg_cron → /ops-alert every 15 min) ─────────────────────────────────
// Checks are CHEAP: counters come from the precomputed admin_dashboard_cache overview (refreshed
// every 5 min by its own cron) + two live pings (gateway/relay). Each problem has a stable key with
// a 6h cooldown persisted in admin_alert_state so an ongoing incident emails at most 4×/day — and
// the state row is DELETED the moment its condition heals, so a NEW occurrence alerts immediately.
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000;

async function runOpsAlertSweep(): Promise<JsonRecord> {
  // 1) Snapshot counters (free) + staleness of the snapshot itself. The `cron` blob carries
  // per-job last_run/last_status (refresh_admin_dashboard's lateral join) — the alert
  // conditions below use THAT, not the 24h trailing counters.
  const { data: cache } = await admin.from("admin_dashboard_cache")
    .select("overview, cron, refreshed_at").eq("id", 1).maybeSingle();
  const ov = (cache?.overview ?? {}) as JsonRecord;
  const refreshedAt = cache?.refreshed_at ? new Date(String(cache.refreshed_at)).getTime() : 0;
  const snapshotAgeMin = refreshedAt ? Math.round((Date.now() - refreshedAt) / 60000) : Infinity;

  // 2) Live infra pings — including Revolut (the payment API: any HTTP response = reachable).
  const { gateway, relay } = await resolveInfraUrls();
  const revolutApiBase = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
  const [gw, rl, st] = await Promise.all([
    gateway ? ping(gateway) : Promise.resolve(null),
    relay ? ping(relay) : Promise.resolve(null),
    ping(revolutApiBase),
  ]);

  // 3) Conditions → stable keys. `detail` goes into the email body.
  const problems: { key: string; detail: string }[] = [];
  if (snapshotAgeMin > 20) problems.push({ key: "snapshot_stale", detail: `Snapshot admin non rafraîchi depuis ${snapshotAgeMin} min (cron admin-dashboard-refresh en panne ?)` });
  if (Number(ov.sources_error) > 0) problems.push({ key: "sources_error", detail: `${ov.sources_error} source(s) en erreur de sync` });
  if (Number(ov.sources_incomplete) > 0) problems.push({ key: "sources_incomplete", detail: `${ov.sources_incomplete} source(s) en sync incomplète (VOD sans variants)` });
  // Cron health: alert on jobs whose MOST RECENT run failed (an outage happening NOW), not
  // on the 24h trailing count — a one-off self-healed failure (e.g. a transient deadlock,
  // recovered on the very next run) otherwise kept re-alerting every 6h until the failed row
  // aged out of the 24h window. The per-job last_status is already in the snapshot's cron blob.
  const crons = Array.isArray(cache?.cron) ? (cache!.cron as JsonRecord[]) : [];
  const failingNow = crons.filter((c) => c.active !== false && String(c.last_status ?? "") === "failed");
  if (failingNow.length) problems.push({ key: "cron_fails", detail: `${failingNow.length} cron(s) actuellement en échec (dernier run failed) : ${failingNow.map((c) => c.jobname).join(", ")}` });
  if (gw && gw.ok !== true) problems.push({ key: "gateway_down", detail: `Gateway injoignable (${String(gw.error ?? "timeout")})` });
  if (rl && rl.ok !== true) problems.push({ key: "relay_down", detail: `Relay injoignable (${String(rl.error ?? "timeout")})` });
  // Billing crons: same last-run-failed semantics, matched by name (jobname-agnostic to the
  // Stancer→Revolut rename — the old billing_cron_fails_24h counter still filtered the retired
  // 'norva-stancer-billing' jobname, so Revolut billing failures were invisible to alerting).
  const billingFailing = failingNow.filter((c) => /revolut-billing|stancer-billing|lifecycle/.test(String(c.jobname ?? "")));
  if (billingFailing.length) problems.push({ key: "billing_cron_fails", detail: `Cron BILLING actuellement en échec : ${billingFailing.map((c) => c.jobname).join(", ")} — le moteur de revenu est peut-être en panne` });
  if (Number(ov.billing_past_due) >= 3) problems.push({ key: "billing_past_due", detail: `${ov.billing_past_due} abonnement(s) en échec de paiement (past_due/grace) simultanés` });
  if (st && st.ok !== true) problems.push({ key: "revolut_down", detail: `API Revolut injoignable (${String(st.error ?? "timeout")}) — les paiements ne passent plus` });
  if (Number(ov.support_stale_24h) > 0) problems.push({ key: "support_stale", detail: `${ov.support_stale_24h} ticket(s) support sans réponse depuis plus de 24 h` });

  // VAT / OSS proactive nudges (from the cache overview). The 10 000 € threshold is
  // assessed on the current AND previous calendar year (whichever is higher). Amounts
  // are USD cents → convert with the same indicative rate the TVA tab uses. The
  // threshold nudge is suppressed once the founder has registered for OSS (business
  // profile), so it heals instead of re-firing every 6h for the rest of the year.
  const VAT_EUR = 0.92;
  const vatMaxEur = Math.max(Number(ov.vat_ytd_eu_cross_cents ?? 0), Number(ov.vat_prevy_eu_cross_cents ?? 0)) * VAT_EUR;
  let ossRegistered = false;
  if (vatMaxEur >= 800_000) {
    const { data: prof } = await admin.from("admin_business_profile").select("demarches").eq("id", 1).maybeSingle()
      .then((r) => r, () => ({ data: null }));
    ossRegistered = ((prof as JsonRecord | null)?.demarches as JsonRecord | undefined)?.oss === true;
  }
  if (vatMaxEur >= 800_000 && !ossRegistered) {
    problems.push({ key: "vat_threshold", detail: `TVA — seuil OSS proche : ~${Math.round(vatMaxEur / 100)} € de ventes UE transfrontalières (≥ 80 % des 10 000 €). Préparez l'inscription au guichet OSS (onglet TVA & conformité).` });
  }
  if (ov.vat_fx_pending) {
    // Taux BCE du dernier jour du trimestre clos, joint à l'alerte (suggestion —
    // l'humain confirme dans l'onglet). Best-effort : sans réseau, alerte sans taux.
    let fxSugg = "";
    try {
      const nowD = new Date();
      const lastDay = new Date(Date.UTC(nowD.getUTCFullYear(), Math.floor(nowD.getUTCMonth() / 3) * 3, 0));
      const r = await fetch(`https://api.frankfurter.dev/v1/${lastDay.toISOString().slice(0, 10)}?base=USD&symbols=EUR`, { signal: AbortSignal.timeout(4000) });
      const d = await r.json() as JsonRecord;
      const rate = (d?.rates as JsonRecord | undefined)?.EUR;
      if (rate) fxSugg = ` Taux BCE suggéré : ${rate} (à confirmer dans l'onglet).`;
    } catch (_) { /* alerte sans suggestion */ }
    problems.push({ key: "vat_fx_pending", detail: `TVA — trimestre ${ov.vat_fx_pending} clos avec des ventes UE : figez le taux BCE dans l'onglet TVA pour finaliser la déclaration OSS (2 min).${fxSugg}` });
  }

  // 4) Cooldown state: alert only keys not alerted within the window. Resolved
  // keys remain durable until at least one recovery channel acknowledges them;
  // otherwise a transient Telegram/Resend outage would erase the only retry state.
  // `details` is read too so the recovery notice can say WHAT was resolved.
  const { data: stateRows } = await admin.from("admin_alert_state").select("key, last_alerted_at, details");
  const state = new Map<string, number>();
  const stateDetails = new Map<string, string>();
  for (const r of (stateRows ?? []) as JsonRecord[]) {
    state.set(String(r.key), new Date(String(r.last_alerted_at)).getTime());
    if (r.details) stateDetails.set(String(r.key), String(r.details));
  }
  const activeKeys = new Set(problems.map((p) => p.key));
  const healed = [...state.keys()].filter((k) => !activeKeys.has(k));
  const toAlert = problems.filter((p) => (state.get(p.key) ?? 0) < Date.now() - ALERT_COOLDOWN_MS);

  // 5) Notify — one digest per sweep, Telegram first, plus the one explicitly
  // configured ops mailbox. Product/admin Auth addresses are never recipients.
  // The 6h per-key cooldown is updated when EITHER channel delivered, so a
  // Resend outage cannot turn Telegram into a 15-minute spam loop (and vice versa).
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
  const recipients = OPS_EMAIL ? [OPS_EMAIL] : [];

  let emailed: string[] = [];
  if (toAlert.length) {
    let delivered = false;
    const tgOk = await sendTelegram(
      `⚠️ <b>Norva Ops — ${toAlert.length} alerte${toAlert.length > 1 ? "s" : ""}</b>\n` +
      toAlert.map((p) => `• ${tgEscape(p.detail)}`).join("\n"),
    );
    if (tgOk) delivered = true;
    if (resendKey && recipients.length) {
      const items = toAlert.map((p) => `<li style="margin:6px 0;color:#e8e8ee">${htmlEscape(p.detail)}</li>`).join("");
      const text = `Norva Ops — ${toAlert.length} active alert${toAlert.length > 1 ? "s" : ""}\n\n` +
        toAlert.map((p) => `- ${p.detail}`).join("\n") +
        "\n\nOpen the operations console: https://norva.tv/app.html";
      const alertBucket = Math.floor(Date.now() / ALERT_COOLDOWN_MS);
      const html = `<body style="margin:0;padding:24px;background:#0a0c11;font-family:Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;background:#11151d;border:1px solid #1f2733;border-radius:14px;padding:22px 26px">
          <h2 style="margin:0 0 6px;color:#ff6b6b;font-size:18px">⚠️ Norva Ops — ${toAlert.length} alerte${toAlert.length > 1 ? "s" : ""}</h2>
          <p style="margin:0 0 14px;color:#9aa4b2;font-size:13px">Sweep automatique (15 min). Prochain rappel de ces alertes dans 6 h si non résolues.</p>
          <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${items}</ul>
          <a href="https://norva.tv/app.html" style="display:inline-block;background:#5b7cfa;color:#fff;font-weight:700;font-size:13px;text-decoration:none;padding:10px 20px;border-radius:9px">Ouvrir le CRM</a>
        </div></body>`;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "User-Agent": "Norva-Ops-Email/2.0",
            "Idempotency-Key": `norva-ops-alert-${alertBucket}-${toAlert.map((p) => p.key).sort().join("-")}`.slice(0, 240),
          },
          body: JSON.stringify({
            from,
            to: recipients,
            reply_to: OPS_EMAIL,
            subject: `⚠️ Norva Ops — ${toAlert.map((p) => p.key).join(", ")}`,
            html,
            text,
            tags: [
              { name: "app", value: "norva" },
              { name: "category", value: "operational" },
              { name: "flow", value: "ops_health_alert" },
            ],
          }),
          signal: AbortSignal.timeout(8_000),
        });
        const payload = await res.json().catch(() => ({})) as JsonRecord;
        if (res.ok && typeof payload.id === "string" && payload.id) {
          emailed = recipients;
          delivered = true;
        }
      } catch (_) { /* email failure → maybe telegram delivered; state update decided below */ }
    }
    if (delivered) {
      const now = new Date().toISOString();
      await admin.from("admin_alert_state").upsert(
        toAlert.map((p) => ({ key: p.key, last_alerted_at: now, details: p.detail })),
        { onConflict: "key" },
      );
    }
  }

  // 6) Recovery notice. Keep the incident rows until Telegram or Resend confirms
  // acceptance. If both fail, the next sweep retries instead of losing recovery.
  let recoveryDelivered = false;
  let recoveryStateCleared = false;
  const recoveryChannels: string[] = [];
  if (healed.length) {
    const lines = healed.map((k) => `• ${tgEscape(stateDetails.get(k) ?? k)}`).join("\n");
    const recoveryTelegramOk = await sendTelegram(`✅ <b>Norva Ops — résolu</b>\n${lines}`);
    if (recoveryTelegramOk) {
      recoveryDelivered = true;
      recoveryChannels.push("telegram");
    }
    if (resendKey && recipients.length) {
      const items = healed.map((k) => `<li style="margin:6px 0;color:#d9f2e3">${htmlEscape(stateDetails.get(k) ?? k)}</li>`).join("");
      const text = "Norva Ops — incident resolved\n\n" +
        healed.map((k) => `- ${stateDetails.get(k) ?? k}`).join("\n");
      const recoveryBucket = Math.floor(Date.now() / ALERT_COOLDOWN_MS);
      const html = `<body style="margin:0;padding:24px;background:#0a0c11;font-family:Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;background:#101913;border:1px solid #1f3327;border-radius:14px;padding:22px 26px">
          <h2 style="margin:0 0 6px;color:#4ade80;font-size:18px">✅ Norva Ops — résolu</h2>
          <p style="margin:0 0 14px;color:#9aa4b2;font-size:13px">Ces alertes ne sont plus actives (vérifié par le sweep 15 min).</p>
          <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${items}</ul>
        </div></body>`;
      try {
        const recoveryResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "User-Agent": "Norva-Ops-Email/2.0",
            "Idempotency-Key": `norva-ops-recovery-${recoveryBucket}-${healed.slice().sort().join("-")}`.slice(0, 240),
          },
          body: JSON.stringify({
            from,
            to: recipients,
            reply_to: OPS_EMAIL,
            subject: `✅ Norva Ops — résolu: ${healed.join(", ")}`,
            html,
            text,
            tags: [
              { name: "app", value: "norva" },
              { name: "category", value: "operational" },
              { name: "flow", value: "ops_health_recovery" },
            ],
          }),
          signal: AbortSignal.timeout(8_000),
        });
        const recoveryPayload = await recoveryResponse.json().catch(() => ({})) as JsonRecord;
        if (recoveryResponse.ok && typeof recoveryPayload.id === "string" && recoveryPayload.id) {
          recoveryDelivered = true;
          recoveryChannels.push("email");
        }
      } catch (_) { /* best-effort */ }
    }
    if (recoveryDelivered) {
      const { error: clearError } = await admin.from("admin_alert_state").delete().in("key", healed);
      if (clearError) {
        // Preserve the rows when acknowledgement persistence fails. The next
        // sweep retries with the same six-hour Resend idempotency bucket.
        console.error("[norva-admin] recovery state clear failed", clearError.message);
      } else {
        recoveryStateCleared = true;
      }
    }
  }

  return {
    checked: ["snapshot_stale", "sources_error", "sources_incomplete", "cron_fails", "gateway_down", "relay_down", "billing_cron_fails", "billing_past_due", "revolut_down", "support_stale", "vat_threshold", "vat_fx_pending"],
    problems, alerted: toAlert.map((p) => p.key), healed, emailed,
    recovery_delivered: recoveryDelivered,
    recovery_channels: recoveryChannels,
    recovery_pending: healed.length > 0 && !recoveryStateCleared,
    email_configured: Boolean(OPS_EMAIL),
    snapshotAgeMin: Number.isFinite(snapshotAgeMin) ? snapshotAgeMin : null,
  };
}

// ── Weekly business digest (pg_cron → /weekly-digest, Monday 07:00) ────────────────────────────
// A proactive founder digest on Telegram: growth, revenue, support — read entirely from the
// precomputed admin_dashboard_cache overview (no extra queries). Cheap, once a week.
async function sendWeeklyDigest(): Promise<JsonRecord> {
  const { data: cache } = await admin.from("admin_dashboard_cache")
    .select("overview, refreshed_at").eq("id", 1).maybeSingle();
  const ov = (cache?.overview ?? {}) as JsonRecord;
  const n = (v: unknown) => Number(v) || 0;
  const usd = (c: unknown) => `$${(n(c) / 100).toFixed(2)}`;
  const mrr = n(ov.billing_mrr_cents);

  const parts: string[] = [
    "📊 <b>Norva — Résumé hebdo</b>",
    "",
    "👥 <b>Croissance</b>",
    `• Nouveaux inscrits : ${n(ov.users_new_7d)} (7 j) · ${n(ov.users_new_30d)} (30 j)`,
    `• Actifs 7 j : ${n(ov.users_active_7d)}`,
    "",
    "💶 <b>Revenu</b>",
    `• MRR : <b>${usd(mrr)}</b> · ARR ${usd(mrr * 12)}`,
    `• Payants : ${n(ov.billing_active)} · en essai : ${n(ov.billing_trialing)}`,
    `• Conversions (7 j) : ${n(ov.billing_conversions_7d)} · encaissé 30 j : ${usd(ov.billing_collected_30d_cents)}`,
  ];
  if (n(ov.billing_past_due)) parts.push(`• ⚠️ Échecs de paiement : ${n(ov.billing_past_due)}`);
  parts.push("", "🎫 <b>Support</b>", `• Ouverts : ${n(ov.support_open)} · à répondre : ${n(ov.support_needs_reply)}`);
  if (n(ov.sources_error)) parts.push(`• 🔧 Sources en erreur : ${n(ov.sources_error)}`);

  // TVA/OSS : uniquement si un signal existe (ventes UE transfrontalières ou taux à figer).
  const vatEurLine = Math.round(Math.max(n(ov.vat_ytd_eu_cross_cents), n(ov.vat_prevy_eu_cross_cents)) * 0.92 / 100);
  if (vatEurLine > 0 || ov.vat_fx_pending) {
    parts.push("", "🇪🇺 <b>TVA / OSS</b>");
    if (vatEurLine > 0) parts.push(`• Ventes UE transfrontalières : ~${vatEurLine} € / 10 000 € (seuil OSS)`);
    if (ov.vat_fx_pending) parts.push(`• ⏳ Trimestre ${ov.vat_fx_pending} clos : figez le taux BCE pour déclarer`);
  }

  const sent = await sendTelegram(parts.join("\n"));
  return { ok: true, sent, mrr_cents: mrr };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!token) return json(req, { error: "Missing bearer token" }, 401);

    // ── route: /ops-alert — proactive alerting sweep (pg_cron every 15 min). Dual auth: the
    // service backfill token (cron) OR an admin JWT (manual test from the dashboard). ──
    if (segments[segments.length - 1] === "ops-alert") {
      const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
      let authed = Boolean(expected) && timingSafeEqual(token, expected);
      if (!authed) {
        const { data: sa } = await admin.auth.getUser(token);
        authed = ((sa?.user?.app_metadata as JsonRecord | undefined)?.role) === "admin";
      }
      if (!authed) return json(req, { error: "not authorized" }, 403);
      return json(req, await runOpsAlertSweep());
    }

    // ── route: /weekly-digest — business digest to Telegram (pg_cron Monday). Same dual auth. ──
    if (segments[segments.length - 1] === "weekly-digest") {
      const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
      let authed = Boolean(expected) && timingSafeEqual(token, expected);
      if (!authed) {
        const { data: sa } = await admin.auth.getUser(token);
        authed = ((sa?.user?.app_metadata as JsonRecord | undefined)?.role) === "admin";
      }
      if (!authed) return json(req, { error: "not authorized" }, 403);
      return json(req, await sendWeeklyDigest());
    }

    // ── admin gate (all other routes) ──
    const { data: au } = await admin.auth.getUser(token);
    const actorRole = (au?.user?.app_metadata as JsonRecord | undefined)?.role;
    if (actorRole !== "admin") return json(req, { error: "not authorized" }, 403);
    const actorEmail = au?.user?.email ?? null;
    const actorId = au?.user?.id ?? "";

    // ── route: /health — real-time infra reachability (edge/DB/gateway/relay) ──
    if (segments[segments.length - 1] === "health") {
      const dbStart = performance.now();
      let db: JsonRecord;
      // supabase-js resolves (does NOT reject) on a query-level error — capture { error } so an
      // RLS denial / permission / timeout / missing relation reads as "down", not a false "ok".
      // The try/catch stays for a total network/fetch throw.
      try {
        const { error: dbErr } = await admin.from("admin_dashboard_cache").select("id").limit(1);
        db = dbErr
          ? { ok: false, ms: Math.round(performance.now() - dbStart), error: String(dbErr.message ?? dbErr).slice(0, 80) }
          : { ok: true, ms: Math.round(performance.now() - dbStart) };
      } catch (e) { db = { ok: false, ms: Math.round(performance.now() - dbStart), error: String((e as Error)?.message ?? e).slice(0, 80) }; }
      const { gateway, relay } = await resolveInfraUrls();
      // Billing / go-live gate state — Supabase edge secrets are project-wide, so this function reads
      // the same NORVA_*/REVOLUT_* env every payment function sees. Plus live PSP + email reachability.
      const revolutKey = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
      const revolutApiBase = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
      const revolutSandbox = /sandbox/i.test(revolutApiBase);
      const [gw, rl, revolutPing, resendPing] = await Promise.all([
        gateway ? ping(gateway) : Promise.resolve({ configured: false } as JsonRecord),
        relay ? ping(relay) : Promise.resolve({ configured: false } as JsonRecord),
        ping(revolutApiBase),
        ping("https://api.resend.com"),
      ]);
      const billing = {
        revolut_mode: revolutSandbox ? "sandbox" : "prod",
        revolut_configured: Boolean(revolutKey),
        revolut_sandbox: revolutSandbox,
        billing_mode: (Deno.env.get("NORVA_BILLING_MODE") ?? "legacy").toLowerCase(),
        entitlements_mode: (Deno.env.get("NORVA_ENTITLEMENTS_MODE") ?? "enforce").toLowerCase(),
        lifecycle_billing_live: (Deno.env.get("NORVA_LIFECYCLE_BILLING_LIVE") ?? "").toLowerCase() === "true",
        webhook_secret_set: Boolean(Deno.env.get("REVOLUT_WEBHOOK_SIGNING_SECRET")),
        resend_configured: Boolean(Deno.env.get("RESEND_API_KEY")),
        revolut: revolutPing,
        resend: resendPing,
      };
      return json(req, {
        edge: { ok: true },
        db,
        gateway: { configured: Boolean(gateway), ...gw },
        relay: { configured: Boolean(relay), ...rl },
        billing,
      });
    }

    // ── route: /marketing-push — envoi d'une notification marketing à un SEGMENT
    // d'appareils (cloud_push_tokens × cloud_entitlement_projection via la fonction
    // marketing_push_targets), avec purge des tokens morts et journalisation dans
    // marketing_push_log (onglet Notifications de la page Marketing admin).
    // Best-effort par token : un échec n'arrête pas la boucle. ──
    if (segments[segments.length - 1] === "marketing-push") {
      const mp = await req.json().catch(() => ({})) as JsonRecord;
      const title = String(mp.title ?? "").trim();
      const text = String(mp.body ?? "").trim();
      const AUDIENCES = ["all", "trialing", "paying", "monthly", "free"];
      const audience = AUDIENCES.includes(String(mp.audience ?? "")) ? String(mp.audience) : "all";
      if (title.length < 2 || title.length > 60) return json(req, { error: "title must be 2..60 characters" }, 400);
      if (text.length < 2 || text.length > 240) return json(req, { error: "body must be 2..240 characters" }, 400);
      if (!fcmConfigured()) return json(req, { error: "FCM not configured (FCM_SERVICE_ACCOUNT secret missing)" }, 500);
      let tokQuery = admin.from("cloud_push_tokens").select("token");
      if (audience !== "all") {
        const { data: uids, error: segErr } = await admin.rpc("marketing_push_targets", { p_audience: audience });
        if (segErr) return json(req, { error: `segment resolution failed: ${segErr.message} — migration 20260719110000 appliquée + NOTIFY pgrst ?` }, 500);
        const userIds = (uids ?? []).map((u: unknown) => String(u)).filter(Boolean);
        if (!userIds.length) {
          try {
            await admin.from("marketing_push_log").insert({
              title, body: text, audience, sent_count: 0, fail_count: 0, dead_count: 0, actor: actorEmail,
            });
          } catch (_) { /* best-effort */ }
          return json(req, { ok: true, devices: 0, sent: 0, fail: 0, dead: 0, audience });
        }
        tokQuery = tokQuery.in("user_id", userIds);
      }
      const { data: toks, error: tokErr } = await tokQuery;
      if (tokErr) return json(req, { error: `token read failed: ${tokErr.message}` }, 500);
      const tokens = [...new Set((toks ?? []).map((t) => String((t as { token?: string }).token)).filter(Boolean))];
      let sent = 0, fail = 0, dead = 0;
      for (const tk of tokens) {
        const r = await sendFcmPush(tk, { title, body: text, data: { kind: "marketing" } });
        if (r.ok) sent++;
        else if (r.unregistered) { dead++; try { await admin.from("cloud_push_tokens").delete().eq("token", tk); } catch (_) { /* noop */ } }
        else fail++;
      }
      try {
        await admin.from("marketing_push_log").insert({
          title, body: text, audience,
          sent_count: sent, fail_count: fail, dead_count: dead, actor: actorEmail,
        });
      } catch (_) { /* le log ne doit pas faire échouer un envoi réussi */ }
      try {
        await sendTelegram(`📣 <b>Push marketing envoyé</b> (${audience})\n${tgEscape(title)}\n${sent} envoyé(s) · ${fail} échec(s) · ${dead} token(s) mort(s) purgé(s)`);
      } catch (_) { /* best-effort */ }
      return json(req, { ok: true, devices: tokens.length, sent, fail, dead, audience });
    }

    // ── route: /user/:id/:action ──
    const i = segments.indexOf("user");
    const userId = i >= 0 ? segments[i + 1] : "";
    const action = i >= 0 ? segments[i + 2] : "";
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return json(req, { error: "Missing/invalid user id" }, 400);

    const body = await req.json().catch(() => ({})) as JsonRecord;

    // Target must exist (and gives us the email for resend + a friendly label).
    const { data: target, error: getErr } = await admin.auth.admin.getUserById(userId);
    if (getErr || !target?.user) return json(req, { error: "user not found" }, 404);
    const targetEmail = target.user.email ?? "";

    if (action === "resend-confirmation") {
      if (target.user.email_confirmed_at) return json(req, { ok: false, message: "Email déjà confirmé." });
      if (!ANON_KEY) return json(req, { error: "resend not configured" }, 503);
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { error } = await anon.auth.resend({ type: "signup", email: targetEmail });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", "Email de confirmation renvoyé", actorEmail);
      return json(req, { ok: true, message: "Email de confirmation renvoyé." });
    }

    // ── action: refund — merchant-initiated Revolut refund of a captured charge ──
    // The only rail with an admin refund route (Stancer retired). Idempotent: refuses a
    // second refund of the same order. Refunds the payment's full amount unless a smaller
    // amount_cents is given. Journals a `refund` row into the cross-rail ledger + timeline.
    if (action === "refund") {
      if (!REVOLUT_SECRET_KEY) return json(req, { error: "Revolut non configuré (REVOLUT_SECRET_KEY absent)." }, 503);
      const piId = String(body.pi_id ?? "").trim();
      if (!piId) return json(req, { error: "pi_id requis" }, 400);

      // Load the target payment, scoped to THIS user (no cross-user refunds).
      const { data: pay, error: payErr } = await admin
        .from("cloud_billing_ledger")
        .select("pi_id,user_id,kind,amount,currency,status,provider,order_id,provider_payment_id,country_code")
        .eq("pi_id", piId).eq("user_id", userId).maybeSingle();
      if (payErr) return json(req, { error: "lookup failed: " + payErr.message }, 500);
      if (!pay) return json(req, { error: "Paiement introuvable pour ce client." }, 404);
      if ((pay.provider ?? "stancer") !== "revolut") return json(req, { error: "Remboursement dispo uniquement sur le rail Revolut." }, 400);
      if (pay.status !== "captured") return json(req, { error: "Seul un paiement encaissé peut être remboursé." }, 400);
      const orderId = String(pay.order_id ?? "").trim();
      if (!orderId) return json(req, { error: "order_id manquant sur ce paiement — remboursement impossible." }, 400);

      const full = Number(pay.amount) || 0;
      const amountCents = body.amount_cents != null ? Math.round(Number(body.amount_cents)) : full;
      if (!Number.isFinite(amountCents) || amountCents !== full || full <= 0) {
        return json(req, { error: `Seul le remboursement total (${full} cents) est disponible.` }, 400);
      }
      const cur = String(pay.currency ?? "usd").toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) {
        return json(req, { error: "La devise du paiement est invalide; remboursement bloqué." }, 409);
      }
      const leaseToken = crypto.randomUUID();
      const { data: claimed, error: claimError } = await admin.rpc("claim_revolut_full_refund", {
        p_order_id: orderId,
        p_user_id: userId,
        p_original_pi_id: piId,
        p_amount_cents: amountCents,
        p_currency: cur,
        p_lease_token: leaseToken,
        p_lease_seconds: 90,
      });
      if (claimError) return json(req, { error: `Refund reservation failed: ${claimError.message}` }, 409);
      const claim = (Array.isArray(claimed) ? claimed[0] : claimed) as {
        action?: string; refund_key?: string; provider_refund_id?: string | null;
      } | null;
      if (!claim?.refund_key) return json(req, { error: "Refund reservation returned no idempotency key." }, 503);
      if (claim.action === "wait") {
        return json(req, { error: "Un remboursement est déjà en cours pour ce paiement." }, 409);
      }
      if (claim.action === "done") {
        const resolved = await resolveCapturedResubscribeException(orderId, userId);
        if (resolved.error) return json(req, { error: "Refund completed; terminal reconciliation is pending." }, 503);
        return json(req, {
          ok: true, idempotent: true, refunded_cents: amountCents, order_id: orderId,
          terminal_resolution: resolved.result,
          message: `Remboursement de ${(amountCents / 100).toFixed(2)} ${cur} déjà effectué.`,
        });
      }
      if (claim.action !== "create" && claim.action !== "reconcile") {
        return json(req, { error: "Refund reservation is not actionable." }, 503);
      }

      const r = claim.action === "create"
        ? await revolutRefund(orderId, amountCents, cur, claim.refund_key)
        : await revolutOrder(String(claim.provider_refund_id ?? ""));
      if (!r.ok) {
        const detail = JSON.stringify(r.body).slice(0, 300);
        if (claim.action === "create") {
          await admin.rpc("fail_revolut_full_refund", {
            p_order_id: orderId, p_user_id: userId, p_lease_token: leaseToken,
            p_error: `HTTP ${r.status}: ${detail}`,
          });
        } else if (claim.provider_refund_id) {
          await admin.rpc("mark_revolut_full_refund_processing", {
            p_order_id: orderId, p_user_id: userId, p_lease_token: leaseToken,
            p_provider_refund_id: claim.provider_refund_id,
            p_provider_response: r.body,
          });
        }
        console.error("[norva-admin] refund failed", r.status, detail);
        if (claim.action === "reconcile") {
          return json(req, { error: "Refund status is temporarily unavailable.", detail }, 503);
        }
        return json(req, { error: `Revolut a refusé le remboursement (HTTP ${r.status}).`, detail }, 502);
      }
      const providerRefundId = typeof r.body.id === "string"
        ? r.body.id
        : typeof r.body.refund_id === "string" ? r.body.refund_id : claim.provider_refund_id ?? null;
      if (!providerRefundId || (claim.provider_refund_id && providerRefundId !== claim.provider_refund_id)) {
        if (claim.action === "create") {
          await admin.rpc("fail_revolut_full_refund", {
            p_order_id: orderId, p_user_id: userId, p_lease_token: leaseToken,
            p_error: "provider refund response has no stable order id",
          });
        }
        return json(req, { error: "Provider refund order id is missing or inconsistent." }, 502);
      }
      const { data: processing, error: processingError } = await admin.rpc(
        "mark_revolut_full_refund_processing",
        {
          p_order_id: orderId, p_user_id: userId, p_lease_token: leaseToken,
          p_provider_refund_id: providerRefundId, p_provider_response: r.body,
        },
      );
      if (processingError) {
        return json(req, { error: "Refund created; durable processing confirmation is pending." }, 503);
      }
      if (processing === "already_applied") {
        return json(req, { ok: true, idempotent: true, refunded_cents: amountCents, order_id: orderId });
      }

      const providerState = String(r.body.state ?? "").toUpperCase();
      if (["FAILED", "DECLINED", "CANCELLED", "REVERSED", "VOIDED"].includes(providerState)) {
        await admin.rpc("fail_revolut_refund_order", {
          p_provider_refund_id: providerRefundId,
          p_provider_state: providerState,
          p_provider_response: r.body,
        });
        return json(req, { error: `Refund failed (${providerState}).`, retryable: true }, 502);
      }
      if (providerState !== "COMPLETED") {
        return json(req, {
          ok: true, pending: true, status: "refund_processing",
          refund_order_id: providerRefundId, refunded_cents: amountCents, order_id: orderId,
          message: "The refund was accepted and is still processing.",
        }, 202);
      }

      const { data: completed, error: completeError } = await admin.rpc("complete_revolut_full_refund", {
        p_order_id: orderId, p_user_id: userId,
        p_provider_refund_id: providerRefundId,
        p_provider_state: providerState,
        p_related_order_id: typeof r.body.related_order_id === "string" ? r.body.related_order_id : null,
        p_provider_amount_cents: Number.isFinite(Number(r.body.amount)) ? Math.round(Number(r.body.amount)) : null,
        p_provider_currency: typeof r.body.currency === "string" ? r.body.currency.toUpperCase() : null,
        p_provider_response: r.body,
      });
      if (completeError) {
        return json(req, { error: "Refund completed; atomic confirmation is pending." }, 503);
      }
      const terminalResolution = String(completed ?? "applied");
      await logEvent(userId, "refund", `Remboursement Revolut ${(amountCents / 100).toFixed(2)} ${cur}`, actorEmail,
        { order_id: orderId, pi_id: piId, amount_cents: amountCents, terminal_resolution: terminalResolution });
      return json(req, { ok: true, refunded_cents: amountCents, order_id: orderId,
        terminal_resolution: terminalResolution,
        message: `Remboursement de ${(amountCents / 100).toFixed(2)} ${cur} effectué.` });
    }

    // Anti self-lockout: an admin cannot demote or suspend their OWN account (would strand the panel).
    if (userId === actorId && action === "role" && String(body.role) === "user") {
      return json(req, { error: "Vous ne pouvez pas retirer votre propre rôle admin." }, 400);
    }
    if (userId === actorId && action === "suspend" && (body.suspend === true || body.suspend === "true")) {
      return json(req, { error: "Vous ne pouvez pas suspendre votre propre compte." }, 400);
    }

    // Last-admin protection: the self-guard above stops an admin locking THEMSELVES out, but two
    // admins could demote/suspend each other. Refuse an action that removes the LAST active admin.
    const targetRole = ((target.user.app_metadata ?? {}) as JsonRecord).role;
    const removesAdmin = targetRole === "admin" && (
      (action === "role" && String(body.role) === "user") ||
      (action === "suspend" && (body.suspend === true || body.suspend === "true"))
    );
    if (removesAdmin) {
      const { data: activeAdmins } = await admin.rpc("admin_count_active");
      if (Number(activeAdmins) <= 1) {
        return json(req, { error: "Action refusée : ce serait le dernier administrateur actif." }, 400);
      }
    }

    if (action === "role") {
      const role = String(body.role ?? "");
      if (role !== "admin" && role !== "user") return json(req, { error: "role must be admin|user" }, 400);
      const existing = (target.user.app_metadata ?? {}) as JsonRecord;
      const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...existing, role } });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", `Rôle changé → ${role}`, actorEmail, { role });
      return json(req, { ok: true, role });
    }

    if (action === "suspend") {
      const suspend = body.suspend === true || body.suspend === "true";
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: suspend ? "876000h" : "none" });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", suspend ? "Compte suspendu" : "Compte réactivé", actorEmail);
      return json(req, { ok: true, suspended: suspend });
    }

    return json(req, { error: "Unknown action" }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[norva-admin]", message);
    return json(req, { error: message }, 500);
  }
});
