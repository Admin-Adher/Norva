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

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

// Revolut Merchant API (same secret/base every payment function reads — edge secrets are project-wide).
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");

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

// Merchant-initiated refund of a Revolut order. Mirrors norva-revolut-billing's charge call
// (new Merchant API + version header — the legacy /api/1.0 payment path 404s). Refunds the given
// amount in cents (USD). Returns Revolut's raw outcome so the caller can journal + surface it.
async function revolutRefund(orderId: string, amountCents: number): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
  const res = await fetch(`${REVOLUT_API_BASE}/api/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Revolut-Api-Version": "2024-09-01",
    },
    body: JSON.stringify({ amount: amountCents, currency: "USD" }),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
  return { ok: res.ok, status: res.status, body: (parsed ?? {}) as JsonRecord };
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

  // 4) Cooldown state: alert only keys not alerted within the window; heal (delete) resolved keys.
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
  if (healed.length) await admin.from("admin_alert_state").delete().in("key", healed);
  const toAlert = problems.filter((p) => (state.get(p.key) ?? 0) < Date.now() - ALERT_COOLDOWN_MS);

  // 5) Notify — Telegram (instant, founder's phone) + email every admin. The cooldown state
  // is updated when EITHER channel delivered, so a Resend outage can't turn Telegram into a
  // 15-min spam loop (and vice versa).
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
  let recipients: string[] = [];
  if (toAlert.length || healed.length) {
    const { data: admins } = await admin.rpc("admin_alert_recipients").then(
      (r) => r,
      () => ({ data: null }),
    );
    recipients = Array.isArray(admins) ? (admins as string[]) : [];
  }

  let emailed: string[] = [];
  if (toAlert.length) {
    let delivered = false;
    const tgOk = await sendTelegram(
      `⚠️ <b>Norva Ops — ${toAlert.length} alerte${toAlert.length > 1 ? "s" : ""}</b>\n` +
      toAlert.map((p) => `• ${tgEscape(p.detail)}`).join("\n"),
    );
    if (tgOk) delivered = true;
    if (resendKey && recipients.length) {
      const items = toAlert.map((p) => `<li style="margin:6px 0;color:#e8e8ee">${p.detail}</li>`).join("");
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
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: recipients, subject: `⚠️ Norva Ops — ${toAlert.map((p) => p.key).join(", ")}`, html }),
        });
        if (res.ok) { emailed = recipients; delivered = true; }
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

  // 6) Recovery notice — heal fires exactly once per incident (its state row was deleted
  // above), so this can never spam. Tells the founder the incident is over instead of
  // leaving the last ⚠️ as the final word.
  if (healed.length) {
    const lines = healed.map((k) => `• ${tgEscape(stateDetails.get(k) ?? k)}`).join("\n");
    await sendTelegram(`✅ <b>Norva Ops — résolu</b>\n${lines}`);
    if (resendKey && recipients.length) {
      const items = healed.map((k) => `<li style="margin:6px 0;color:#d9f2e3">${stateDetails.get(k) ?? k}</li>`).join("");
      const html = `<body style="margin:0;padding:24px;background:#0a0c11;font-family:Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;background:#101913;border:1px solid #1f3327;border-radius:14px;padding:22px 26px">
          <h2 style="margin:0 0 6px;color:#4ade80;font-size:18px">✅ Norva Ops — résolu</h2>
          <p style="margin:0 0 14px;color:#9aa4b2;font-size:13px">Ces alertes ne sont plus actives (vérifié par le sweep 15 min).</p>
          <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${items}</ul>
        </div></body>`;
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: recipients, subject: `✅ Norva Ops — résolu: ${healed.join(", ")}`, html }),
        });
      } catch (_) { /* best-effort */ }
    }
  }

  return {
    checked: ["snapshot_stale", "sources_error", "sources_incomplete", "cron_fails", "gateway_down", "relay_down", "billing_cron_fails", "billing_past_due", "revolut_down", "support_stale"],
    problems, alerted: toAlert.map((p) => p.key), healed, emailed,
    snapshotAgeMin: Number.isFinite(snapshotAgeMin) ? snapshotAgeMin : null,
  };
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
        .from("cloud_stancer_payments")
        .select("pi_id,user_id,kind,amount,currency,status,provider,order_id,provider_payment_id")
        .eq("pi_id", piId).eq("user_id", userId).maybeSingle();
      if (payErr) return json(req, { error: "lookup failed: " + payErr.message }, 500);
      if (!pay) return json(req, { error: "Paiement introuvable pour ce client." }, 404);
      if ((pay.provider ?? "stancer") !== "revolut") return json(req, { error: "Remboursement dispo uniquement sur le rail Revolut." }, 400);
      if (pay.status !== "captured") return json(req, { error: "Seul un paiement encaissé peut être remboursé." }, 400);
      const orderId = String(pay.order_id ?? "").trim();
      if (!orderId) return json(req, { error: "order_id manquant sur ce paiement — remboursement impossible." }, 400);

      const full = Number(pay.amount) || 0;
      const amountCents = body.amount_cents != null ? Math.round(Number(body.amount_cents)) : full;
      if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > full) {
        return json(req, { error: `Montant invalide (1..${full} cents).` }, 400);
      }

      // Idempotency: one refund ledger row per order → refuse a re-refund (guards double money-out).
      const refundPi = `rfnd_${orderId}`;
      const { data: existing } = await admin
        .from("cloud_stancer_payments").select("pi_id").eq("pi_id", refundPi).maybeSingle();
      if (existing) return json(req, { error: "Ce paiement a déjà été remboursé." }, 409);

      const r = await revolutRefund(orderId, amountCents);
      if (!r.ok) {
        const detail = JSON.stringify(r.body).slice(0, 300);
        console.error("[norva-admin] refund failed", r.status, detail);
        return json(req, { error: `Revolut a refusé le remboursement (HTTP ${r.status}).`, detail }, 502);
      }

      // Journal the refund (kind='refund' → excluded from `collected`, shown in the fiche history).
      // supabase-js resolves with { error } rather than throwing; the money already moved either way.
      const { error: insErr } = await admin.from("cloud_stancer_payments").insert({
        pi_id: refundPi, user_id: userId, kind: "refund",
        amount: amountCents, currency: (pay.currency ?? "usd"), status: "refunded",
        provider: "revolut", order_id: orderId, provider_payment_id: pay.provider_payment_id ?? null,
      });
      if (insErr) console.error("[norva-admin] refund ledger insert failed", insErr.message);

      const cur = String(pay.currency ?? "usd").toUpperCase();
      await logEvent(userId, "refund", `Remboursement Revolut ${(amountCents / 100).toFixed(2)} ${cur}`, actorEmail,
        { order_id: orderId, pi_id: piId, amount_cents: amountCents });
      return json(req, { ok: true, refunded_cents: amountCents, order_id: orderId,
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
