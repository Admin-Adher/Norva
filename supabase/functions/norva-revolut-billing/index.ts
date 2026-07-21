// Revolut recurring-billing cron — the ONLY place that charges a saved Revolut card.
// INERT until REVOLUT_SECRET_KEY is set. A pg_cron job POSTs here hourly; this:
//   • TRIAL → FIRST CHARGE: provider='revolut' + status='trialing' + trial_ends_at ≤ now →
//     charge the saved payment method for the plan amount; success → 'active'
//     (+ current_period_end); fail → 'past_due'.
//   • RENEWAL: status='active' + current_period_end ≤ now → charge again; extend or → 'past_due'.
//   • cancelled_at_period_end whose period is over → 'expired' (never charged).
//
// MIT charge (merchant-initiated, saved card) — confirmed API shape:
//   1) POST /api/1.0/orders  { amount, currency:"USD", capture_mode:"AUTOMATIC",
//                              merchant_order_ext_ref, description, customer_id } → { id }
//   2) POST /api/1.0/orders/{id}/payments
//        { saved_payment_method: { type:"card", id:<payment_method_id>, initiator:"merchant" } }
//      success = order state COMPLETED.
// Idempotency: a DB cycle claim is acquired BEFORE any Revolut POST. The claim owns
// one deterministic merchant_order_ext_ref and survives ambiguous network failures;
// another isolate resumes that exact remote order instead of opening a second debit.
// Only an authoritative ORDER state COMPLETED is ever accounted as captured.
//
// Cron to register (self-host) AFTER DEPLOY:
//   select cron.schedule('norva-revolut-billing', '23 * * * *', $$
//     select net.http_post(
//       url := 'https://api.norva.tv/functions/v1/norva-revolut-billing/cron/run',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 90000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { renderReceipt } from "../_shared/lifecycle-email.ts";
import { sendTelegram, tgEscape } from "../_shared/telegram.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const REVOLUT_SECRET_KEY = Deno.env.get("REVOLUT_SECRET_KEY") ?? "";
const REVOLUT_API_BASE = (Deno.env.get("REVOLUT_API_BASE") ?? "https://sandbox-merchant.revolut.com").replace(/\/+$/, "");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
// Each user does 2-3 Revolut round-trips (create + pay [+ refetch]); keep the batch
// small so a run stays well within the edge wall-clock limit. The cron runs hourly.
const BATCH = 25;
const CHECKOUT_RECONCILE_BATCH = 10;

// NB: pas de table de prix ici, et c'est voulu — ce cron débite EXCLUSIVEMENT
// cloud_revolut_customers.amount_cents, le prix verrouillé à la souscription.
// Le catalogue courant (promos incluses) vit dans billing_prices et ne concerne
// que les nouveaux checkouts (norva-revolut) — jamais les renouvellements.

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

interface RevolutResponse {
  ok: boolean;
  status: number;
  body: JsonRecord;
  ambiguous: boolean;
  error?: string;
}

async function revolut(method: "GET" | "POST", path: string, body?: JsonRecord, extraHeaders?: Record<string, string>): Promise<RevolutResponse> {
  try {
    const res = await fetch(`${REVOLUT_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${REVOLUT_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(extraHeaders ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
    return {
      ok: res.ok,
      status: res.status,
      body: (parsed ?? {}) as JsonRecord,
      // A gateway/server response may arrive after Revolut accepted the request.
      // Treat it as unknown until merchant_order_ext_ref/order lookup proves otherwise.
      ambiguous: res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {},
      ambiguous: true,
      error: error instanceof Error ? error.message : "network_error",
    };
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

type ChargeOutcome = "captured" | "pending" | "failed" | "unknown";
type ChargeResult = {
  outcome: ChargeOutcome;
  orderId: string | null;
  paymentId: string | null;
  remoteState: string | null;
  paymentAttempted?: boolean;
  detail?: unknown;
};

const ORDER_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "DECLINED", "REVERSED", "VOIDED", "EXPIRED"]);
const ORDER_PENDING_STATES = new Set([
  "PENDING", "PROCESSING", "AUTHORISED", "AUTHORIZED",
  "AUTHORISATION_STARTED", "AUTHORIZATION_STARTED",
  "AUTHORISATION_PASSED", "AUTHORIZATION_PASSED",
  "CAPTURE_STARTED", "CAPTURED",
]);

// Deliberately strict: Revolut documents COMPLETED as the final order state.
// AUTHORISED and payment-level intermediate states are not proof of settlement.
function classifyOrderState(state: unknown): ChargeOutcome {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "captured";
  if (ORDER_FAILURE_STATES.has(normalized)) return "failed";
  if (ORDER_PENDING_STATES.has(normalized)) return "pending";
  return "unknown";
}

function remoteStateOf(order: JsonRecord): string {
  return String(order.state ?? "").trim().toUpperCase();
}

function paymentIdOf(order: JsonRecord): string | null {
  const payments = Array.isArray(order.payments) ? order.payments as JsonRecord[] : [];
  for (let i = payments.length - 1; i >= 0; i--) {
    const id = stringOrNull(payments[i]?.id);
    if (id) return id;
  }
  return null;
}

function orderList(body: unknown): JsonRecord[] {
  if (Array.isArray(body)) return body.filter((v) => v && typeof v === "object") as JsonRecord[];
  const record = (body && typeof body === "object") ? body as JsonRecord : {};
  const list = Array.isArray(record.orders) ? record.orders : Array.isArray(record.data) ? record.data : [];
  return list.filter((v) => v && typeof v === "object") as JsonRecord[];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function addPeriod(fromIso: string | null, period: string): string {
  const d = fromIso ? new Date(fromIso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  if (period === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

// Best-effort payment receipt after a successful charge.
async function sendReceipt(db: SupabaseClient, userId: string, planLabel: string, amountCents: number, periodEnd: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  try {
    const { data: u } = await db.auth.admin.getUserById(userId);
    const email = u?.user?.email;
    if (!email) return;
    const m = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const full = String(m.display_name ?? m.name ?? "").trim();
    const first = full ? full.split(/\s+/)[0] : null;
    const r = renderReceipt(first, { planLabel, amount: `$${(amountCents / 100).toFixed(2)}`, periodEnd });
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [email], subject: r.subject, html: r.html }),
    });
  } catch (_) { /* best-effort */ }
}

// Is this the owner's own test account? This check is also the service-level
// billing kill-switch, so database errors must fail closed (throw) rather than
// silently treating an unknown account as billable.  Callers used only for
// notifications already wrap it in best-effort try/catch.
async function isInternal(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.from("admin_internal_accounts")
    .select("user_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`internal_account_check_failed:${error.message}`);
  return Boolean(data);
}
async function userEmail(db: SupabaseClient, userId: string): Promise<string> {
  try { const { data } = await db.auth.admin.getUserById(userId); return data?.user?.email ?? userId; }
  catch (_) { return userId; }
}

// 🎉 A REAL (non-internal) customer just converted from trial → first paid charge. Highest-signal
// moment for the founder → instant Telegram. Best-effort, never blocks the billing action.
async function pingConversion(db: SupabaseClient, userId: string, planLabel: string, amountCents: number, period: string): Promise<void> {
  try {
    if (await isInternal(db, userId)) return;
    const email = await userEmail(db, userId);
    await sendTelegram(
      `🎉 <b>Nouvelle conversion Norva</b>\n${tgEscape(email)}\n${tgEscape(planLabel)} · ${tgEscape(period)}\n💶 <b>$${(amountCents / 100).toFixed(2)}</b> encaissés (1ᵉʳ prélèvement)`,
    );
  } catch (_) { /* best-effort */ }
}
// 💳 A real subscriber's charge was DECLINED → past_due. Individual dunning alert (vs the ops
// sweep's ≥3-simultaneous threshold), so a single lost renewal is caught early.
async function pingChargeFailed(db: SupabaseClient, userId: string, planLabel: string, kind: "first_charge" | "renewal"): Promise<void> {
  try {
    if (await isInternal(db, userId)) return;
    const email = await userEmail(db, userId);
    await sendTelegram(
      `💳 <b>Échec de paiement Norva</b>\n${tgEscape(email)}\n${tgEscape(planLabel)} · ${kind === "first_charge" ? "conversion trial" : "renouvellement"}\n→ passé en <b>past_due</b>, dunning enclenché.`,
    );
  } catch (_) { /* best-effort */ }
}

type RemoteOrder = {
  order: JsonRecord;
  orderId: string;
  state: string;
};

async function retrieveRemoteOrder(orderId: string): Promise<{ order?: RemoteOrder; response: RevolutResponse }> {
  const response = await revolut("GET", `/api/1.0/orders/${encodeURIComponent(orderId)}`);
  const resolvedId = stringOrNull(response.body.id) ?? orderId;
  if (!response.ok || !resolvedId) return { response };
  return {
    response,
    order: { order: response.body, orderId: resolvedId, state: remoteStateOf(response.body) },
  };
}

async function findRemoteOrderByExtRef(extRef: string): Promise<{ order?: RemoteOrder; response: RevolutResponse }> {
  const response = await revolut(
    "GET",
    `/api/1.0/orders?merchant_order_ext_ref=${encodeURIComponent(extRef)}&limit=20`,
  );
  if (!response.ok) return { response };
  const found = orderList(response.body).find((candidate) =>
    String(candidate.merchant_order_ext_ref ?? "") === extRef
  );
  const orderId = stringOrNull(found?.id);
  if (!found || !orderId) return { response };
  const detailed = await retrieveRemoteOrder(orderId);
  if (detailed.order) return detailed;
  return {
    response,
    order: { order: found, orderId, state: remoteStateOf(found) },
  };
}

async function resolveOrCreateRemoteOrder(
  customerId: string,
  amount: number,
  extRef: string,
  desc: string,
  existingOrderId: string | null,
): Promise<{ remote?: RemoteOrder; outcome?: ChargeOutcome; detail?: unknown }> {
  if (existingOrderId) {
    const existing = await retrieveRemoteOrder(existingOrderId);
    if (existing.order) return { remote: existing.order };
  }

  // Recovery precedes creation: it handles both a crashed prior isolate and a POST
  // whose response timed out after Revolut accepted the immutable external ref.
  const recovered = await findRemoteOrderByExtRef(extRef);
  if (recovered.order) return { remote: recovered.order };
  if (!recovered.response.ok && recovered.response.ambiguous) {
    return { outcome: "unknown", detail: recovered.response.error ?? recovered.response.body };
  }

  const created = await revolut("POST", "/api/1.0/orders", {
    amount,
    currency: "USD",
    capture_mode: "AUTOMATIC",
    merchant_order_ext_ref: extRef,
    description: desc,
    customer_id: customerId,
  });
  const createdId = stringOrNull(created.body.id);
  if (created.ok && createdId) {
    return {
      remote: { order: created.body, orderId: createdId, state: remoteStateOf(created.body) || "PENDING" },
    };
  }

  // Duplicate, timeout and 5xx are all resolved by ext_ref before any retry.
  const afterCreate = await findRemoteOrderByExtRef(extRef);
  if (afterCreate.order) return { remote: afterCreate.order };
  return {
    // A rejected/ambiguous create is an integration outcome, not proof that the
    // customer's payment failed.  Only an authoritative order/payment state may
    // enter dunning.
    outcome: "unknown",
    detail: created.error ?? created.body,
  };
}

async function pollRemoteOrder(orderId: string): Promise<ChargeResult> {
  let lastState: string | null = null;
  let lastPaymentId: string | null = null;
  let lastDetail: unknown;
  let sawAuthoritative = false;
  for (const waitMs of [0, 350, 850]) {
    if (waitMs) await delay(waitMs);
    const fetched = await retrieveRemoteOrder(orderId);
    if (!fetched.order) {
      lastDetail = fetched.response.error ?? fetched.response.body;
      continue;
    }
    sawAuthoritative = true;
    lastState = fetched.order.state;
    lastPaymentId = paymentIdOf(fetched.order.order) ?? lastPaymentId;
    lastDetail = fetched.order.order;
    const outcome = classifyOrderState(lastState);
    if (outcome === "captured" || outcome === "failed") {
      return {
        outcome,
        orderId,
        paymentId: lastPaymentId,
        remoteState: lastState,
        detail: outcome === "failed" ? lastDetail : undefined,
      };
    }
  }
  return {
    outcome: sawAuthoritative ? "pending" : "unknown",
    orderId,
    paymentId: lastPaymentId,
    remoteState: lastState,
    detail: lastDetail,
  };
}

// Merchant-initiated charge of a saved card. The DB lease must journal the remote
// order before this function is allowed to POST a payment.
async function chargeSavedCard(
  customerId: string,
  pmId: string,
  amount: number,
  extRef: string,
  desc: string,
  existingOrderId: string | null,
  existingPaymentId: string | null,
  paymentAlreadyStarted: boolean,
  onOrderReady: (orderId: string, state: string, order: JsonRecord) => Promise<boolean>,
  onPaymentReady: (orderId: string, state: string, order: JsonRecord) => Promise<boolean>,
): Promise<ChargeResult> {
  const resolved = await resolveOrCreateRemoteOrder(customerId, amount, extRef, desc, existingOrderId);
  if (!resolved.remote) {
    return {
      outcome: resolved.outcome ?? "unknown",
      orderId: existingOrderId,
      paymentId: null,
      remoteState: null,
      detail: resolved.detail,
    };
  }

  const { order, orderId } = resolved.remote;
  const state = resolved.remote.state || "PENDING";
  const initialOutcome = classifyOrderState(state);
  if (!(await onOrderReady(orderId, state, order))) {
    return {
      outcome: "unknown",
      orderId,
      paymentId: paymentIdOf(order),
      remoteState: state,
      detail: "billing_attempt_lease_lost",
    };
  }
  if (initialOutcome === "captured" || initialOutcome === "failed") {
    return {
      outcome: initialOutcome,
      orderId,
      paymentId: paymentIdOf(order),
      remoteState: state,
      detail: initialOutcome === "failed" ? order : undefined,
    };
  }

  // A payment already exists. Never POST another while Revolut is processing or
  // holding an authorisation; reconcile until the ORDER reaches a final state.
  if (state !== "PENDING" || paymentAlreadyStarted || existingPaymentId || paymentIdOf(order)) {
    return await pollRemoteOrder(orderId);
  }

  // Persist the at-most-once payment intent before the irreversible POST.  If the
  // isolate dies on either side of the network call, the next run only polls this
  // order; it never guesses that a second debit is safe.
  if (!(await onPaymentReady(orderId, state, order))) {
    return {
      outcome: "unknown",
      orderId,
      paymentId: null,
      remoteState: state,
      detail: "billing_payment_claim_lost",
    };
  }

  const pay = await revolut(
    "POST",
    `/api/orders/${encodeURIComponent(orderId)}/payments`,
    { saved_payment_method: { type: "card", id: pmId, initiator: "merchant" } },
    { "Revolut-Api-Version": "2024-09-01" },
  );
  const paymentId = stringOrNull(pay.body.id);
  const paymentState = String(pay.body.state ?? "").trim().toUpperCase();
  const authoritative = await pollRemoteOrder(orderId);
  authoritative.paymentAttempted = true;
  if (!authoritative.paymentId) authoritative.paymentId = paymentId;
  if (authoritative.outcome === "captured" || authoritative.outcome === "failed") return authoritative;

  const explicitPaymentFailure = ORDER_FAILURE_STATES.has(paymentState)
    || paymentState === "AUTHORISATION_FAILED"
    || paymentState === "AUTHORIZATION_FAILED";
  if (explicitPaymentFailure) {
    return {
      outcome: "failed",
      orderId,
      paymentId,
      remoteState: authoritative.remoteState ?? state,
      paymentAttempted: true,
      detail: pay.error ?? pay.body,
    };
  }

  // An HTTP/API error is operationally unknown unless Revolut explicitly marks
  // the payment/order failed.  Never put a customer in dunning for our bad
  // credentials, schema drift, or a transient duplicate response.
  if (!pay.ok && !pay.ambiguous) {
    return {
      outcome: "unknown",
      orderId,
      paymentId,
      remoteState: authoritative.remoteState ?? state,
      paymentAttempted: true,
      detail: pay.error ?? pay.body,
    };
  }

  // Intermediate payment states remain pending until GET order says COMPLETED.
  return {
    outcome: pay.ambiguous && authoritative.outcome === "unknown" ? "unknown" : "pending",
    orderId,
    paymentId,
    remoteState: authoritative.remoteState ?? state,
    paymentAttempted: true,
    detail: authoritative.detail ?? pay.error ?? pay.body,
  };
}

interface Row { user_id: string; plan_code: string | null; trial_ends_at: string | null; current_period_end: string | null; billing_retry_count?: number | null }

interface BillingCustomer {
  revolut_customer_id?: string;
  payment_method_id?: string;
  plan?: string;
  period?: string;
  amount_cents?: number;
  discount_next_pct?: number;
  card_country?: string;
  base_amount_cents?: number | null;
  promo_cycles_left?: number | null;
}

interface BillingClaim {
  action: "internal" | "blocked" | "done" | "failed" | "wait" | "apply" | "apply_failed" | "resume" | "create";
  status: string;
  order_id: string | null;
  payment_id: string | null;
  merchant_ext_ref: string;
  amount_cents: number;
  plan_code: "plus" | "family";
  bill_period: "monthly" | "annual";
  discount_pct: number;
  promo_cycles_before: number | null;
  base_amount_cents: number | null;
  remote_state: string | null;
  generation: number;
}

type ChargeUserResult = "charged" | "failed" | "pending" | "unknown" | "no_card" | "no_plan" | "skipped";

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 1000);
  if (typeof value === "string") return value.slice(0, 1000);
  try { return JSON.stringify(value).slice(0, 1000); } catch (_) { return "unknown_error"; }
}

function reportBillingError(errors: unknown[], userId: string, cycleKey: string, detail: unknown): void {
  if (errors.length >= 5) return;
  errors.push({ user_id: userId, cycle_key: cycleKey, detail: errorText(detail).slice(0, 400) });
}

function billingCycleIdentity(userId: string, kind: "first_charge" | "renewal", cycleAnchor: string | null, retryAttempt: number): {
  cycleKey: string;
  merchantExtRef: string;
  canonicalAnchor: string;
} {
  const timestamp = Date.parse(String(cycleAnchor ?? ""));
  if (!Number.isFinite(timestamp)) throw new Error("billing_cycle_anchor_missing");
  const canonicalAnchor = new Date(timestamp).toISOString();
  const anchorToken = Math.floor(timestamp / 1000).toString(36);
  const userToken = userId.replace(/-/g, "").slice(0, 20);
  const kindToken = kind === "first_charge" ? "f" : "r";
  return {
    cycleKey: `revolut:${userId}:${kind}:${canonicalAnchor}:retry:${retryAttempt}`,
    merchantExtRef: `nb-${userToken}-${kindToken}${anchorToken}-${retryAttempt}`.slice(0, 40),
    canonicalAnchor,
  };
}

async function claimBillingCycle(
  db: SupabaseClient,
  input: {
    cycleKey: string;
    userId: string;
    kind: "first_charge" | "renewal";
    cycleAnchor: string;
    retryAttempt: number;
    planCode: "plus" | "family";
    billPeriod: "monthly" | "annual";
    amountCents: number;
    discountPct: number;
    promoCyclesBefore: number | null;
    baseAmountCents: number | null;
    merchantExtRef: string;
    leaseToken: string;
  },
): Promise<BillingClaim> {
  const { data, error } = await db.rpc("claim_revolut_billing_cycle", {
    p_cycle_key: input.cycleKey,
    p_user_id: input.userId,
    p_kind: input.kind,
    p_cycle_anchor: input.cycleAnchor,
    p_retry_attempt: input.retryAttempt,
    p_plan_code: input.planCode,
    p_bill_period: input.billPeriod,
    p_amount_cents: input.amountCents,
    p_discount_pct: input.discountPct,
    p_promo_cycles_before: input.promoCyclesBefore,
    p_base_amount_cents: input.baseAmountCents,
    p_merchant_ext_ref: input.merchantExtRef,
    p_lease_token: input.leaseToken,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`billing_cycle_claim_failed:${error.message}`);
  const claim = (Array.isArray(data) ? data[0] : data) as BillingClaim | null;
  if (!claim?.action || !claim.merchant_ext_ref) throw new Error("billing_cycle_claim_empty");
  return claim;
}

async function recordBillingAttempt(
  db: SupabaseClient,
  cycleKey: string,
  leaseToken: string,
  status: "creating" | "order_created" | "payment_pending" | "completed" | "failed" | "unknown",
  result: { orderId?: string | null; paymentId?: string | null; remoteState?: string | null; detail?: unknown } = {},
  releaseLease = false,
): Promise<boolean> {
  const { data, error } = await db.rpc("record_revolut_billing_attempt", {
    p_cycle_key: cycleKey,
    p_lease_token: leaseToken,
    p_status: status,
    p_order_id: result.orderId ?? null,
    p_payment_id: result.paymentId ?? null,
    p_remote_state: result.remoteState ?? null,
    p_error: result.detail == null ? null : errorText(result.detail),
    p_release_lease: releaseLease,
  });
  if (error) throw new Error(`billing_attempt_record_failed:${error.message}`);
  return data === true;
}

async function journalBillingOrder(
  db: SupabaseClient,
  input: {
    orderId: string | null;
    userId: string;
    kind: "first_charge" | "renewal";
    planCode: "plus" | "family";
    billPeriod: "monthly" | "annual";
    amountCents: number;
    cycleKey: string;
    retryAttempt: number;
    merchantExtRef: string;
    outcome: ChargeOutcome;
    remoteState: string | null;
    paymentId: string | null;
  },
): Promise<void> {
  if (!input.orderId) return;
  const nowIso = new Date().toISOString();
  const isFinal = input.outcome === "captured" || input.outcome === "failed";
  const state = (input.remoteState || (input.outcome === "captured" ? "COMPLETED" : input.outcome.toUpperCase())).toUpperCase();
  const { error } = await db.from("cloud_revolut_orders").upsert({
    order_id: input.orderId,
    user_id: input.userId,
    kind: input.kind,
    amount: input.amountCents,
    requested_amount_cents: input.amountCents,
    currency: "USD",
    state,
    plan: input.planCode,
    period: input.billPeriod,
    merchant_ext_ref: input.merchantExtRef,
    cycle_key: input.cycleKey,
    retry_attempt: input.retryAttempt,
    last_reconciled_at: nowIso,
    finalization_result: { outcome: input.outcome, payment_id: input.paymentId, cycle_key: input.cycleKey },
    ...(isFinal ? { finalized_at: nowIso } : {}),
    updated_at: nowIso,
  }, { onConflict: "order_id" });
  if (error) throw new Error(`billing_order_journal_failed:${error.message}`);
}

async function applyBillingSuccess(db: SupabaseClient, cycleKey: string, leaseToken: string, nextPeriodEnd: string): Promise<{ applied: boolean; alreadyApplied: boolean; warning: string | null }> {
  const { data, error } = await db.rpc("apply_revolut_billing_success", {
    p_cycle_key: cycleKey,
    p_lease_token: leaseToken,
    p_next_period_end: nextPeriodEnd,
  });
  if (error) throw new Error(`billing_success_apply_failed:${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { applied?: boolean; already_applied?: boolean; warning?: string | null } | null;
  if (!row) throw new Error("billing_success_apply_empty");
  return { applied: row.applied === true, alreadyApplied: row.already_applied === true, warning: row.warning ?? null };
}

async function applyBillingFailure(db: SupabaseClient, cycleKey: string, leaseToken: string, failOpenUntil: string | null): Promise<{ applied: boolean; alreadyApplied: boolean; warning: string | null }> {
  const { data, error } = await db.rpc("apply_revolut_billing_failure", {
    p_cycle_key: cycleKey,
    p_lease_token: leaseToken,
    p_fail_open_until: failOpenUntil,
  });
  if (error) throw new Error(`billing_failure_apply_failed:${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { applied?: boolean; already_applied?: boolean; warning?: string | null } | null;
  if (!row) throw new Error("billing_failure_apply_empty");
  return { applied: row.applied === true, alreadyApplied: row.already_applied === true, warning: row.warning ?? null };
}

async function markUnchargeable(
  db: SupabaseClient,
  row: Row,
  kind: "first_charge" | "renewal",
  cycleAnchor: string,
  retryAttempt: number,
  nowIso: string,
): Promise<boolean> {
  const update = {
    status: "past_due",
    last_event_at: nowIso,
    ...(retryAttempt > 0 ? { billing_retry_count: retryAttempt } : { fail_open_until: addHours(nowIso, 72) }),
  };
  let response;
  if (kind === "first_charge") {
    response = await db.from("cloud_entitlement_projection").update(update)
      .eq("user_id", row.user_id).eq("provider", "revolut").eq("status", "trialing")
      .eq("trial_ends_at", cycleAnchor).select("user_id");
  } else if (retryAttempt > 0) {
    response = await db.from("cloud_entitlement_projection").update(update)
      .eq("user_id", row.user_id).eq("provider", "revolut").eq("status", "past_due")
      .eq("current_period_end", cycleAnchor).eq("billing_retry_count", retryAttempt - 1).select("user_id");
  } else {
    response = await db.from("cloud_entitlement_projection").update(update)
      .eq("user_id", row.user_id).eq("provider", "revolut").eq("status", "active")
      .eq("current_period_end", cycleAnchor).select("user_id");
  }
  if (response.error) throw new Error(`unchargeable_projection_cas_failed:${response.error.message}`);
  return Array.isArray(response.data) && response.data.length === 1;
}

// opts.retryAttempt (1|2) = relance automatique d'un past_due (J+3/J+5).
// Every remote POST is preceded by a database claim for one immutable cycle.
async function chargeUser(
  db: SupabaseClient,
  row: Row,
  kind: "first_charge" | "renewal",
  cycleAnchor: string | null,
  errors: unknown[],
  opts: { retryAttempt?: number } = {},
): Promise<ChargeUserResult> {
  const retryAttempt = opts.retryAttempt ?? 0;
  // First guard is deliberately before customer/card lookup and, critically,
  // before the immutable-cycle claim that leads to a remote POST /orders.
  if (await isInternal(db, row.user_id)) return "skipped";
  const identity = billingCycleIdentity(row.user_id, kind, cycleAnchor, retryAttempt);
  const { data: cust, error: customerError } = await db.from("cloud_revolut_customers")
    .select("revolut_customer_id,payment_method_id,plan,period,amount_cents,discount_next_pct,card_country,base_amount_cents,promo_cycles_left")
    .eq("user_id", row.user_id).maybeSingle();
  if (customerError) throw new Error(`billing_customer_read_failed:${customerError.message}`);
  const c = cust as BillingCustomer | null;
  const customerId = stringOrNull(c?.revolut_customer_id);
  const pmId = stringOrNull(c?.payment_method_id);
  const period: "monthly" | "annual" = c?.period === "annual" ? "annual" : "monthly";
  const amount = typeof c?.amount_cents === "number" ? c.amount_cents : 0;
  const discountPct = typeof c?.discount_next_pct === "number" && c.discount_next_pct >= 1 && c.discount_next_pct <= 99 ? c.discount_next_pct : 0;
  const mappedPlan: "plus" | "family" = c?.plan === "family" || (c?.plan !== "plus" && row.plan_code === "family") ? "family" : "plus";
  const planLabel = mappedPlan === "family" ? "Norva Family" : "Norva";
  const nowIso = new Date().toISOString();

  if (!customerId || !pmId || amount <= 0 || amount > 9_999_999) {
    const changed = await markUnchargeable(db, row, kind, identity.canonicalAnchor, retryAttempt, nowIso);
    return changed ? (pmId ? "no_plan" : "no_card") : "skipped";
  }

  const chargeAmount = discountPct ? Math.max(50, Math.round(amount * (100 - discountPct) / 100)) : amount;
  const promoCyclesBefore = typeof c?.promo_cycles_left === "number" && c.promo_cycles_left > 0 ? c.promo_cycles_left : null;
  const baseAmountCents = typeof c?.base_amount_cents === "number" && c.base_amount_cents >= 100 && c.base_amount_cents <= 99999 ? c.base_amount_cents : null;
  const leaseToken = crypto.randomUUID();
  const claim = await claimBillingCycle(db, {
    cycleKey: identity.cycleKey,
    userId: row.user_id,
    kind,
    cycleAnchor: identity.canonicalAnchor,
    retryAttempt,
    planCode: mappedPlan,
    billPeriod: period,
    amountCents: chargeAmount,
    discountPct,
    promoCyclesBefore,
    baseAmountCents,
    merchantExtRef: identity.merchantExtRef,
    leaseToken,
  });
  const plan = claim.plan_code;
  const cadence = claim.bill_period;
  const billedAmount = claim.amount_cents;
  const label = plan === "family" ? "Norva Family" : "Norva";
  const desc = `${label} ${cadence} — ${kind}${retryAttempt ? ` (auto-retry ${retryAttempt})` : ""}${claim.discount_pct ? ` (${claim.discount_pct}% off)` : ""}`;

  // The SQL wrapper returns `internal` without inserting a billing attempt.  A
  // second registry read closes the race where an admin tags the account after
  // the first service check but before/while the claim transaction completes.
  if (claim.action === "internal") return "skipped";
  if (await isInternal(db, row.user_id)) return "skipped";
  if (claim.action === "blocked" || claim.action === "wait") return "pending";
  if (claim.action === "done") return "charged";
  if (claim.action === "failed") return "failed";

  const journal = async (result: ChargeResult): Promise<void> => await journalBillingOrder(db, {
    orderId: result.orderId,
    userId: row.user_id,
    kind,
    planCode: plan,
    billPeriod: cadence,
    amountCents: billedAmount,
    cycleKey: identity.cycleKey,
    retryAttempt,
    merchantExtRef: claim.merchant_ext_ref,
    outcome: result.outcome,
    remoteState: result.remoteState,
    paymentId: result.paymentId,
  });

  const finalizeCaptured = async (result: ChargeResult): Promise<ChargeUserResult> => {
    try {
      await journal(result);
      const { error: ledgerError } = await db.from("cloud_billing_ledger").upsert({
        pi_id: `rvl_${result.orderId ?? claim.merchant_ext_ref}`,
        user_id: row.user_id,
        kind,
        amount: billedAmount,
        currency: "usd",
        status: "captured",
        provider: "revolut",
        order_id: result.orderId,
        provider_payment_id: result.paymentId,
        country_code: typeof c?.card_country === "string" && /^[A-Z]{2}$/.test(c.card_country) ? c.card_country : null,
      }, { onConflict: "pi_id", ignoreDuplicates: true });
      if (ledgerError) throw new Error(`billing_ledger_write_failed:${ledgerError.message}`);
      const nextEnd = addPeriod(identity.canonicalAnchor, cadence);
      const applied = await applyBillingSuccess(db, identity.cycleKey, leaseToken, nextEnd);
      if (!applied.applied && !applied.alreadyApplied) throw new Error("billing_success_not_applied");
      if (applied.warning) reportBillingError(errors, row.user_id, identity.cycleKey, applied.warning);
      if (applied.applied) {
        if (retryAttempt) {
          try {
            if (!(await isInternal(db, row.user_id))) {
              const email = await userEmail(db, row.user_id);
              await sendTelegram(`💚 <b>Paiement récupéré</b> (relance auto n°${retryAttempt})\n${tgEscape(email)}\n${tgEscape(label)} · ${cadence} · $${(billedAmount / 100).toFixed(2)}`);
            }
          } catch (_) { /* best-effort */ }
        }
        await sendReceipt(db, row.user_id, claim.discount_pct ? `${label} (${claim.discount_pct}% off applied)` : label, billedAmount, nextEnd);
        if (kind === "first_charge") await pingConversion(db, row.user_id, label, billedAmount, cadence);
      }
      return "charged";
    } catch (error) {
      reportBillingError(errors, row.user_id, identity.cycleKey, error);
      return "unknown";
    }
  };

  const finalizeFailed = async (result: ChargeResult): Promise<ChargeUserResult> => {
    try {
      await journal(result);
      const failOpenUntil = retryAttempt ? null : addHours(nowIso, 72);
      const applied = await applyBillingFailure(db, identity.cycleKey, leaseToken, failOpenUntil);
      if (!applied.applied && !applied.alreadyApplied) throw new Error("billing_failure_not_applied");
      if (applied.warning) reportBillingError(errors, row.user_id, identity.cycleKey, applied.warning);
      if (applied.applied && !retryAttempt && applied.warning !== "projection_changed_elsewhere") {
        await pingChargeFailed(db, row.user_id, label, kind);
      }
      return "failed";
    } catch (error) {
      reportBillingError(errors, row.user_id, identity.cycleKey, error);
      return "unknown";
    }
  };

  const storedResult: ChargeResult = {
    outcome: claim.status === "completed" ? "captured" : claim.status === "failed" ? "failed" : "unknown",
    orderId: claim.order_id,
    paymentId: claim.payment_id,
    remoteState: claim.remote_state,
  };
  if (claim.action === "apply") return await finalizeCaptured(storedResult);
  if (claim.action === "apply_failed") return await finalizeFailed(storedResult);

  let charge: ChargeResult;
  try {
    charge = await chargeSavedCard(
      customerId,
      pmId,
      billedAmount,
      claim.merchant_ext_ref,
      desc,
      claim.order_id,
      claim.payment_id,
      claim.status === "payment_pending" || Boolean(claim.payment_id),
      async (orderId, state, order) => {
        const initialOutcome = classifyOrderState(state);
        const paymentId = paymentIdOf(order) ?? claim.payment_id;
        await journalBillingOrder(db, {
          orderId,
          userId: row.user_id,
          kind,
          planCode: plan,
          billPeriod: cadence,
          amountCents: billedAmount,
          cycleKey: identity.cycleKey,
          retryAttempt,
          merchantExtRef: claim.merchant_ext_ref,
          outcome: initialOutcome,
          remoteState: state,
          paymentId,
        });
        const status = initialOutcome === "captured" ? "completed"
          : initialOutcome === "failed" ? "failed"
          : (state !== "PENDING" || paymentId ? "payment_pending" : "order_created");
        return await recordBillingAttempt(db, identity.cycleKey, leaseToken, status, {
          orderId,
          paymentId,
          remoteState: state,
        });
      },
      async (orderId, state, order) => await recordBillingAttempt(
        db,
        identity.cycleKey,
        leaseToken,
        "payment_pending",
        {
          orderId,
          paymentId: paymentIdOf(order) ?? claim.payment_id,
          remoteState: state,
        },
      ),
    );
  } catch (error) {
    reportBillingError(errors, row.user_id, identity.cycleKey, error);
    try {
      await recordBillingAttempt(db, identity.cycleKey, leaseToken, "unknown", { detail: error }, true);
    } catch (_) { /* lease expiry permits reconciliation */ }
    return "unknown";
  }

  const paymentWasStarted = charge.paymentAttempted === true || claim.status === "payment_pending" || Boolean(claim.payment_id);
  const status = charge.outcome === "captured" ? "completed"
    : charge.outcome === "failed" ? "failed"
    : charge.outcome === "pending" ? "payment_pending"
    : paymentWasStarted ? "payment_pending" : "unknown";
  const recorded = await recordBillingAttempt(db, identity.cycleKey, leaseToken, status, {
    orderId: charge.orderId,
    paymentId: charge.paymentId,
    remoteState: charge.remoteState,
    detail: charge.detail,
  }, charge.outcome === "pending" || charge.outcome === "unknown");
  if (!recorded) {
    reportBillingError(errors, row.user_id, identity.cycleKey, "billing_attempt_lease_lost");
    return "unknown";
  }
  try { await journal(charge); } catch (error) {
    reportBillingError(errors, row.user_id, identity.cycleKey, error);
    return "unknown";
  }
  if (charge.outcome === "captured") return await finalizeCaptured(charge);
  if (charge.outcome === "failed") {
    if (charge.detail) reportBillingError(errors, row.user_id, identity.cycleKey, charge.detail);
    return await finalizeFailed(charge);
  }
  return charge.outcome;
}

function addHours(fromIso: string, hours: number): string {
  return new Date(new Date(fromIso).getTime() + hours * 3600_000).toISOString();
}

interface OpenCheckoutRow {
  order_id: string;
  state: string | null;
  expires_at: string | null;
  kind: string;
}

// Reconcile a bounded set of checkout/setup orders without applying entitlement
// business state here.  In particular, AUTHORISED is a setup/authorisation state,
// never revenue.  Expiration is claimed locally before the one remote cancel call,
// so overlapping cron isolates cannot send duplicate cancellation requests.
async function reconcileOpenCheckouts(db: SupabaseClient): Promise<{
  checkout_reconciled: number;
  checkout_authorised: number;
  checkout_expired: number;
  checkout_cancelled: number;
  checkout_unknown: number;
}> {
  const result = {
    checkout_reconciled: 0,
    checkout_authorised: 0,
    checkout_expired: 0,
    checkout_cancelled: 0,
    checkout_unknown: 0,
  };
  const now = new Date();
  const nowIso = now.toISOString();
  const { data, error } = await db.from("cloud_revolut_orders")
    .select("order_id,state,expires_at,kind")
    .in("kind", ["trial_setup", "plan_change", "resubscribe", "card_update"])
    .is("finalized_at", null)
    .is("expired_at", null)
    .is("superseded_at", null)
    .lte("expires_at", nowIso)
    .order("last_reconciled_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(CHECKOUT_RECONCILE_BATCH);
  if (error) throw new Error(`checkout_reconcile_read_failed:${error.message}`);

  for (const checkout of (data ?? []) as OpenCheckoutRow[]) {
    const fetched = await retrieveRemoteOrder(checkout.order_id);
    if (!fetched.order) {
      const isMissing = fetched.response.status === 404;
      const isExpired = checkout.expires_at != null && Date.parse(checkout.expires_at) <= now.getTime();
      if (isMissing && isExpired) {
        const { data: claimed, error: claimError } = await db.from("cloud_revolut_orders").update({
          state: "NOT_FOUND",
          expired_at: nowIso,
          public_id: null,
          checkout_url: null,
          last_reconciled_at: nowIso,
          finalization_result: { outcome: "expired_checkout", cancel: "remote_not_found" },
          updated_at: nowIso,
        }).eq("order_id", checkout.order_id).is("finalized_at", null).is("expired_at", null).select("order_id");
        if (claimError) throw new Error(`checkout_missing_expire_failed:${claimError.message}`);
        if (Array.isArray(claimed) && claimed.length === 1) result.checkout_expired++;
      } else {
        result.checkout_unknown++;
      }
      continue;
    }

    const remoteState = fetched.order.state || "UNKNOWN";
    const { error: stateError } = await db.from("cloud_revolut_orders").update({
      state: remoteState,
      last_reconciled_at: nowIso,
      updated_at: nowIso,
    }).eq("order_id", checkout.order_id).is("finalized_at", null).is("expired_at", null);
    if (stateError) throw new Error(`checkout_reconcile_write_failed:${stateError.message}`);
    result.checkout_reconciled++;

    if (remoteState === "AUTHORISED" || remoteState === "AUTHORIZED" || remoteState === "AUTHORISATION_PASSED" || remoteState === "AUTHORIZATION_PASSED") {
      result.checkout_authorised++;
      continue;
    }

    const isExpired = checkout.expires_at != null && Date.parse(checkout.expires_at) <= now.getTime();
    if (!isExpired || (remoteState !== "PENDING" && remoteState !== "PROCESSING")) continue;

    // This UPDATE is the exactly-once cancel claim.  It also immediately revokes
    // the browser token, so a stale tab cannot reopen an expired checkout.
    const { data: claimed, error: claimError } = await db.from("cloud_revolut_orders").update({
      expired_at: nowIso,
      public_id: null,
      checkout_url: null,
      last_reconciled_at: nowIso,
      finalization_result: { outcome: "expired_checkout", cancel: "claimed" },
      updated_at: nowIso,
    }).eq("order_id", checkout.order_id)
      .is("finalized_at", null)
      .is("expired_at", null)
      .in("state", ["PENDING", "PROCESSING"])
      .select("order_id");
    if (claimError) throw new Error(`checkout_expire_claim_failed:${claimError.message}`);
    if (!Array.isArray(claimed) || claimed.length !== 1) continue;
    result.checkout_expired++;

    const cancelled = await revolut(
      "POST",
      `/api/orders/${encodeURIComponent(checkout.order_id)}/cancel`,
      undefined,
      { "Revolut-Api-Version": "2024-09-01" },
    );
    const cancelledState = cancelled.ok ? (remoteStateOf(cancelled.body) || "CANCELLED") : remoteState;
    const cancelOutcome = cancelled.ok ? "cancelled"
      : cancelled.ambiguous ? "cancel_unknown"
      : "cancel_failed";
    const { error: cancelWriteError } = await db.from("cloud_revolut_orders").update({
      state: cancelledState,
      last_reconciled_at: new Date().toISOString(),
      finalization_result: {
        outcome: "expired_checkout",
        cancel: cancelOutcome,
        http_status: cancelled.status,
        detail: errorText(cancelled.error ?? cancelled.body),
      },
      updated_at: new Date().toISOString(),
    }).eq("order_id", checkout.order_id).eq("expired_at", nowIso);
    if (cancelWriteError) throw new Error(`checkout_cancel_journal_failed:${cancelWriteError.message}`);
    if (cancelled.ok) result.checkout_cancelled++;
    else result.checkout_unknown++;
  }
  return result;
}

async function run(db: SupabaseClient): Promise<Record<string, unknown>> {
  const nowIso = new Date().toISOString();
  const out = {
    trial_charged: 0,
    renew_charged: 0,
    retry_recovered: 0,
    retry_failed: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    no_card: 0,
    no_plan: 0,
    skipped: 0,
    ended: 0,
  };
  const errors: unknown[] = [];

  // 1) Trials whose free days are up → first charge.
  const { data: trials } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "revolut").eq("status", "trialing").lte("trial_ends_at", nowIso).limit(BATCH);
  for (const row of (trials ?? []) as Row[]) {
    const r = await chargeUser(db, row, "first_charge", row.trial_ends_at, errors);
    if (r === "charged") out.trial_charged++;
    else if (r === "no_card") out.no_card++;
    else if (r === "no_plan") out.no_plan++;
    else if (r === "failed") out.failed++;
    else if (r === "pending") out.pending++;
    else if (r === "unknown") out.unknown++;
    else out.skipped++;
  }

  // 2) Active subscriptions due for renewal.
  const { data: renewals } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end")
    .eq("provider", "revolut").eq("status", "active").lte("current_period_end", nowIso).limit(BATCH);
  for (const row of (renewals ?? []) as Row[]) {
    const r = await chargeUser(db, row, "renewal", row.current_period_end, errors);
    if (r === "charged") out.renew_charged++;
    else if (r === "no_card") out.no_card++;
    else if (r === "no_plan") out.no_plan++;
    else if (r === "failed") out.failed++;
    else if (r === "pending") out.pending++;
    else if (r === "unknown") out.unknown++;
    else out.skipped++;
  }

  // 2bis) Relances automatiques des past_due (anti-churn involontaire) : ~2/3 des
  // échecs de carte sont transitoires — on re-tente J+3 puis J+5 après l'échéance,
  // avant que le dunning n'expire l'abonnement (~J+10). Succès → réactivation
  // (période ancrée sur l'échéance d'origine, jamais de temps facturé deux fois) ;
  // échec → past_due inchangé, la grâce de 72 h ne se ré-étend pas.
  const d3 = new Date(Date.now() - 3 * 86400_000).toISOString();
  const d5 = new Date(Date.now() - 5 * 86400_000).toISOString();
  const { data: retries } = await db.from("cloud_entitlement_projection")
    .select("user_id,plan_code,trial_ends_at,current_period_end,billing_retry_count")
    .eq("provider", "revolut").eq("status", "past_due")
    .or(`and(billing_retry_count.eq.0,current_period_end.lte.${d3}),and(billing_retry_count.eq.1,current_period_end.lte.${d5})`)
    .limit(BATCH);
  for (const row of (retries ?? []) as Row[]) {
    const attempt = (row.billing_retry_count ?? 0) + 1;
    const r = await chargeUser(db, row, "renewal", row.current_period_end, errors, { retryAttempt: attempt });
    if (r === "charged") out.retry_recovered++;
    else if (r === "failed") out.retry_failed++;
    else if (r === "no_card") out.no_card++;
    else if (r === "no_plan") out.no_plan++;
    else if (r === "pending") out.pending++;
    else if (r === "unknown") out.unknown++;
    else out.skipped++;
  }

  // 3) Cancelled plans whose paid/trial period is over → expired (never charged).
  const { data: ended } = await db.from("cloud_entitlement_projection")
    .select("user_id")
    .eq("provider", "revolut").eq("status", "cancelled_at_period_end").lte("current_period_end", nowIso).limit(BATCH);
  for (const row of (ended ?? []) as { user_id: string }[]) {
    const { data, error } = await db.from("cloud_entitlement_projection")
      .update({ status: "expired", last_event_at: nowIso })
      .eq("user_id", row.user_id).eq("provider", "revolut").eq("status", "cancelled_at_period_end")
      .lte("current_period_end", nowIso).select("user_id");
    if (error) throw new Error(`billing_expiry_cas_failed:${error.message}`);
    if (Array.isArray(data) && data.length === 1) out.ended++;
  }

  // Checkout cleanup is deliberately last: a slow legacy provider order must
  // never delay a due subscription charge.  Failures remain visible in the cron
  // report and the next hourly run resumes the bounded oldest-first sweep.
  let checkoutReconciliation = {
    checkout_reconciled: 0,
    checkout_authorised: 0,
    checkout_expired: 0,
    checkout_cancelled: 0,
    checkout_unknown: 0,
  };
  try {
    checkoutReconciliation = await reconcileOpenCheckouts(db);
  } catch (error) {
    if (errors.length < 5) errors.push({ phase: "checkout_reconciliation", detail: errorText(error).slice(0, 400) });
  }
  const summary = { ...out, ...checkoutReconciliation };
  return errors.length ? { ...summary, errors } : summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (ok !== true) return json({ error: "Unauthorized" }, 403);

  // Inert until the rail is configured — nothing charges without a key.
  if (!REVOLUT_SECRET_KEY) return json({ ok: true, inert: true });

  try {
    const result = await run(db);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[norva-revolut-billing] run failed", e instanceof Error ? e.message : e);
    return json({ error: "run failed" }, 500);
  }
});
