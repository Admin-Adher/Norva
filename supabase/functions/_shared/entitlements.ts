import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { shouldAdminBypass } from "./billing-policy.mjs";
import { evaluateEntitlementProjection } from "./entitlement-evaluator.mjs";

type JsonRecord = Record<string, unknown>;

export type EntitlementDecision = {
  allowed: boolean;
  reason: string;
  status: string;
  planCode: string;
  mode: string;
  enforced: boolean;
  failOpen: boolean;
  limits: JsonRecord;
  projection: JsonRecord | null;
  message: string;
};

type AccessGrantPlanCode = "plus" | "family" | "premium";

type AccessGrantReconciliation = {
  provider: {
    provider: string | null;
    status: string | null;
    active: boolean;
    hard_block: boolean;
    reason: string;
    fail_open: boolean;
    current_period_end: string | null;
    trial_ends_at: string | null;
    fail_open_until: string | null;
    last_verified_at: string | null;
  };
  overlay: {
    status:
      | "blocked_provider"
      | "paused_provider"
      | "active"
      | "queued"
      | "none";
    active_grant: {
      key: string;
      status: "active";
      plan_code: AccessGrantPlanCode;
      remaining_seconds: number;
      active_from: string;
      active_until: string;
    } | null;
    queued_grants: number;
    remaining_seconds: number;
  };
};

const DEFAULT_TRIAL_DAYS = boundedEnvInt("NORVA_TRIAL_DAYS", 7, 1, 60);
const DEFAULT_FAIL_OPEN_HOURS = boundedEnvInt("NORVA_BILLING_FAIL_OPEN_HOURS", 72, 1, 24 * 14);
const ENTITLEMENTS_MODE = normalizeEntitlementsMode(Deno.env.get("NORVA_ENTITLEMENTS_MODE") ?? "enforce");
// "legacy"     → auto-start a no-card 7-day trial on first access (current).
// "revenuecat" → trials/subscriptions come from the store + webhook with a
//                payment method; no trial is auto-granted server-side.
const BILLING_MODE = normalizeBillingMode(Deno.env.get("NORVA_BILLING_MODE") ?? "legacy");

const PLAN_LIMITS: Record<string, JsonRecord> = {
  trial: {
    trusted_devices: 5,
    concurrent_streams: 10,
    sources: 2,
    profiles: 1,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  // Norva (entry plan) and Norva Family share full feature parity. The ONLY
  // difference is the number of PROFILES (2 vs 5). We do NOT sell "simultaneous
  // streams" — how many streams can play at once is the user's IPTV provider's
  // account limit, not ours. concurrent_streams here is just a generous, identical
  // backend guard (never advertised) so a runaway account can't open unbounded
  // gateway/transcode sessions. Everything else (trusted devices, sources, feature
  // flags) is intentionally identical between the two paid plans.
  plus: {
    trusted_devices: 10,
    concurrent_streams: 10,
    sources: 5,
    profiles: 2,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  family: {
    trusted_devices: 10,
    concurrent_streams: 10,
    sources: 5,
    profiles: 5,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  premium: {
    trusted_devices: 18,
    concurrent_streams: 6,
    sources: 8,
    profiles: 8,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  manual: {
    trusted_devices: 20,
    concurrent_streams: 8,
    sources: 10,
    profiles: 8,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  free: {
    // Soft-wall browse tier: connect one source and browse the catalogue, but
    // concurrent_streams: 0 means playback is walled until a plan/trial starts.
    trusted_devices: 5,
    concurrent_streams: 0,
    sources: 1,
    profiles: 1,
    gateway: true,
    cloud_sync: true,
    metadata: true,
  },
  none: {
    trusted_devices: 0,
    concurrent_streams: 0,
    sources: 0,
    profiles: 0,
    gateway: false,
    cloud_sync: false,
    metadata: false,
  },
};

// Premium add-on feature flags (observe-mode scaffold for the auto-refresh
// roadmap — defined here so the model stays the single source of truth shared
// with future enforcement + the billing webhook). Paid plans and the trial get
// them; the free/none soft-wall tiers do not, which is what the upsell + the
// conversion-signal logging key off. Nothing is enforced while the runtime mode
// is "observe".
const PREMIUM_FEATURE_KEYS = [
  "auto_refresh_background",        // refresh the catalogue while the app is closed (cloud cron)
  "auto_refresh_fast",             // sub-daily refresh cadence
  "content_notifications_frequent", // more than the one free daily "what's new" notification
] as const;
for (const [code, limits] of Object.entries(PLAN_LIMITS)) {
  const premium = code !== "free" && code !== "none";
  for (const key of PREMIUM_FEATURE_KEYS) limits[key] = premium;
}

const HARD_BLOCK_STATUSES = new Set(["revoked", "refunded", "fraud"]);

export function getEntitlementRuntime() {
  return {
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
  };
}

export type EntitlementOptions = { autoStartTrial?: boolean; isAdmin?: boolean };

export async function getEntitlementDecision(
  db: SupabaseClient,
  userId: string,
  options: EntitlementOptions = {},
): Promise<EntitlementDecision> {
  const decision = await computeDecision(db, userId, options);
  // Admin safety net: an account with app_metadata.role='admin' (the owner/staff) is
  // never soft-walled — full access, no subscription required. Hard blocks
  // (revoked/refunded/fraud) still apply. Only meaningful under enforce; in observe
  // the decision is already allowed, so this never triggers. RevenueCat's browse-only
  // soft wall is technically allowed with zero streams; treat that as a deny for the
  // admin safety net too. Unless the caller passed options.isAdmin, this costs one
  // getUserById only on a deny/soft-wall path — never on a paying hot path.
  if (shouldAdminBypass(decision) && !HARD_BLOCK_STATUSES.has(decision.reason)) {
    const admin = options.isAdmin === true ||
      (options.isAdmin === undefined && await isUserAdmin(db, userId));
    if (admin) return adminDecision(decision.projection);
  }
  return decision;
}

// Full-access decision for an admin. planCode 'manual' carries the highest limits.
function adminDecision(projection: JsonRecord | null): EntitlementDecision {
  return {
    allowed: true,
    reason: "admin_bypass",
    status: "active",
    planCode: "manual",
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen: false,
    limits: PLAN_LIMITS.manual,
    projection,
    message: "Norva admin access.",
  };
}

// Sync admin check from an already-resolved auth user (JWT app_metadata.role).
// Callers holding the user pass isAdmin: isAdminUser(user) so an enforce-mode deny
// never costs a getUserById round-trip.
export function isAdminUser(user: { app_metadata?: JsonRecord | null } | null | undefined): boolean {
  return String((user?.app_metadata as JsonRecord | undefined)?.role ?? "") === "admin";
}

async function isUserAdmin(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data } = await db.auth.admin.getUserById(userId);
    const meta = data?.user?.app_metadata as JsonRecord | undefined;
    return String(meta?.role ?? "") === "admin";
  } catch (_) {
    return false;
  }
}

async function computeDecision(
  db: SupabaseClient,
  userId: string,
  options: EntitlementOptions = {},
): Promise<EntitlementDecision> {
  const { data, error } = await db
    .from("cloud_entitlement_projection")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return applyEntitlementMode(uncertainDecision("billing_projection_unavailable", null));
  }

  let projection = data as JsonRecord | null;
  // Legacy mode auto-starts a no-card trial on first access. Once billing runs
  // through RevenueCat, trials are created by the store/webhook with a payment
  // method, so we no longer auto-grant one here.
  const autoTrialAllowed = BILLING_MODE === "legacy" && options.autoStartTrial !== false;
  if (!projection && autoTrialAllowed) {
    projection = await startTrialProjection(db, userId);
  }

  const planCode = String(projection?.plan_code || "none");
  const limits = normalizeLimits(planCode, projection?.limits);
  const verdict = evaluateEntitlementProjection(projection, {
    now: Date.now(),
    billingMode: BILLING_MODE,
    failOpenHours: DEFAULT_FAIL_OPEN_HOURS,
  });
  const providerDecision = verdict.kind === "allow"
    ? applyEntitlementMode(allowedDecision(
      verdict.reason,
      projection as JsonRecord,
      limits,
      verdict.failOpen,
    ))
    : verdict.kind === "soft"
    ? applyEntitlementMode(freeBrowseDecision(verdict.reason, projection))
    : applyEntitlementMode(blockedDecision(verdict.reason, projection, limits));

  // Provider-paid access is the hot path. The projection trigger introduced
  // with access credits pauses their clocks transactionally whenever this same
  // evaluator would allow the provider, so no overlay RPC is needed here.
  if (verdict.kind === "allow") return providerDecision;

  // A provider refund, revocation or fraud block is authoritative even if the
  // grants RPC is unavailable or temporarily inconsistent. Never let a
  // non-cash Partners credit bypass a provider hard block.
  if (HARD_BLOCK_STATUSES.has(providerDecision.reason)) {
    return providerDecision;
  }

  const reconciliation = await reconcileAccessGrantOverlay(db, userId);
  if (!reconciliation) {
    // Fail closed for the overlay while preserving the pre-existing billing
    // behaviour: a missing/malformed grant response cannot create access.
    return providerDecision;
  }

  if (reconciliation.provider.hard_block) {
    return applyEntitlementMode(blockedDecision(
      reconciliation.provider.status as "revoked" | "refunded" | "fraud",
      projection,
      limits,
    ));
  }
  if (reconciliation.provider.active) {
    // The SQL reconciliation pauses queued/active grants while paid provider
    // access is authoritative. The provider decision and limits remain the
    // only source of access on this branch.
    return providerDecision;
  }

  const activeGrant = reconciliation.overlay.active_grant;
  if (
    reconciliation.overlay.status === "active" &&
    activeGrant &&
    activeGrant.remaining_seconds > 0
  ) {
    return applyEntitlementMode(accessGrantDecision(
      activeGrant.plan_code,
      projection,
    ));
  }
  return providerDecision;
}

async function reconcileAccessGrantOverlay(
  db: SupabaseClient,
  userId: string,
): Promise<AccessGrantReconciliation | null> {
  try {
    const { data, error } = await db.rpc(
      "partners_service_access_grants_reconcile",
      { p_user_id: userId },
    );
    if (error) return null;
    return sanitizeAccessGrantReconciliation(data);
  } catch (_) {
    return null;
  }
}

function sanitizeAccessGrantReconciliation(
  value: unknown,
): AccessGrantReconciliation | null {
  if (!isExactRecord(value, ["schema_version", "action", "provider", "overlay"])) {
    return null;
  }
  if (
    value.schema_version !== 1 ||
    value.action !== "access_grants_reconciled" ||
    !isExactRecord(value.provider, [
      "provider",
      "status",
      "active",
      "hard_block",
      "reason",
      "fail_open",
      "current_period_end",
      "trial_ends_at",
      "fail_open_until",
      "last_verified_at",
    ]) ||
    !isExactRecord(value.overlay, [
      "status",
      "active_grant",
      "queued_grants",
      "remaining_seconds",
    ])
  ) return null;

  const provider = value.provider;
  const overlay = value.overlay;
  const providerName = provider.provider;
  const providerStatus = provider.status;
  const providerReason = provider.reason;
  const providerFailOpen = provider.fail_open;
  const failOpenReasons = new Set([
    "billing_grace",
    "billing_recently_verified",
  ]);
  const activeReasons: Record<string, Set<string>> = {
    trialing: new Set(["trialing"]),
    active: new Set(["active", ...failOpenReasons]),
    cancelled_at_period_end: new Set(["cancelled_at_period_end"]),
    grace: failOpenReasons,
    past_due: failOpenReasons,
    unknown: failOpenReasons,
  };
  const inactiveReasons: Record<string, Set<string>> = {
    trialing: new Set(["trial_expired", "billing_unverified"]),
    active: new Set(["subscription_expired", "billing_unverified"]),
    cancelled_at_period_end: new Set([
      "subscription_expired",
      "billing_unverified",
    ]),
    grace: new Set(["billing_unverified"]),
    past_due: new Set(["billing_unverified"]),
    unknown: new Set(["billing_unverified"]),
    expired: new Set(["subscription_expired"]),
  };
  const providerIsPerpetual = providerName === "system" ||
    providerName === "manual";
  const trialOrPeriodEnd = provider.trial_ends_at ??
    provider.current_period_end;
  if (
    (providerName !== null && !boundedState(providerName)) ||
    (providerStatus !== null && !boundedState(providerStatus)) ||
    typeof provider.active !== "boolean" ||
    typeof provider.hard_block !== "boolean" ||
    typeof providerReason !== "string" ||
    !boundedState(providerReason) ||
    typeof providerFailOpen !== "boolean" ||
    (provider.current_period_end !== null &&
      !isValidIsoTimestamp(provider.current_period_end)) ||
    (provider.trial_ends_at !== null &&
      !isValidIsoTimestamp(provider.trial_ends_at)) ||
    (provider.fail_open_until !== null &&
      !isValidIsoTimestamp(provider.fail_open_until)) ||
    (provider.last_verified_at !== null &&
      !isValidIsoTimestamp(provider.last_verified_at)) ||
    (providerStatus === null &&
      (providerName !== null || provider.active || provider.hard_block ||
        providerFailOpen || providerReason !== "subscription_required" ||
        provider.current_period_end !== null || provider.trial_ends_at !== null ||
        provider.fail_open_until !== null ||
        provider.last_verified_at !== null)) ||
    (providerStatus !== null && providerName === null) ||
    (provider.active && provider.hard_block) ||
    (provider.hard_block && !HARD_BLOCK_STATUSES.has(String(providerStatus))) ||
    (provider.hard_block && providerReason !== providerStatus) ||
    (providerFailOpen !== failOpenReasons.has(providerReason)) ||
    (provider.active &&
      !activeReasons[String(providerStatus)]?.has(providerReason)) ||
    (!provider.active && !provider.hard_block && providerStatus !== null &&
      !inactiveReasons[String(providerStatus)]?.has(providerReason)) ||
    (["trialing", "trial_expired"].includes(providerReason) &&
      trialOrPeriodEnd === null) ||
    (providerReason === "active" &&
      provider.current_period_end === null && !providerIsPerpetual) ||
    (providerReason === "cancelled_at_period_end" &&
      provider.current_period_end === null) ||
    (providerReason === "billing_grace" &&
      (providerStatus === "active"
        ? provider.fail_open_until === null
        : provider.current_period_end === null &&
          provider.fail_open_until === null)) ||
    (providerReason === "billing_recently_verified" &&
      provider.last_verified_at === null) ||
    (providerReason === "subscription_expired" &&
      ["active", "cancelled_at_period_end"].includes(
        String(providerStatus),
      ) && provider.current_period_end === null) ||
    ![
      "blocked_provider",
      "paused_provider",
      "active",
      "queued",
      "none",
    ].includes(String(overlay.status)) ||
    !isNonNegativeSafeInteger(overlay.queued_grants) ||
    !isNonNegativeSafeInteger(overlay.remaining_seconds)
  ) return null;

  let activeGrant: AccessGrantReconciliation["overlay"]["active_grant"] = null;
  if (overlay.active_grant !== null) {
    const grant = overlay.active_grant;
    if (
      !isExactRecord(grant, [
        "key",
        "status",
        "plan_code",
        "remaining_seconds",
        "active_from",
        "active_until",
      ]) ||
      typeof grant.key !== "string" ||
      !/^cag_[0-9a-f]{24}$/.test(grant.key) ||
      grant.status !== "active" ||
      !["plus", "family", "premium"].includes(String(grant.plan_code)) ||
      !isNonNegativeSafeInteger(grant.remaining_seconds) ||
      grant.remaining_seconds <= 0 ||
      !isValidIsoTimestamp(grant.active_from) ||
      !isValidIsoTimestamp(grant.active_until) ||
      Date.parse(grant.active_until as string) <= Date.parse(grant.active_from as string)
    ) return null;
    activeGrant = grant as AccessGrantReconciliation["overlay"]["active_grant"];
  }

  if (
    (overlay.status === "blocked_provider" &&
      (!provider.hard_block || activeGrant !== null)) ||
    (overlay.status === "paused_provider" &&
      (!provider.active || provider.hard_block || activeGrant !== null)) ||
    (overlay.status === "active" &&
      (provider.active || provider.hard_block || activeGrant === null)) ||
    (overlay.status === "queued" &&
      (provider.active || provider.hard_block || activeGrant !== null ||
        overlay.queued_grants < 1)) ||
    (overlay.status === "none" &&
      (provider.active || provider.hard_block || activeGrant !== null ||
        overlay.queued_grants !== 0 || overlay.remaining_seconds !== 0)) ||
    (activeGrant !== null &&
      overlay.remaining_seconds < activeGrant.remaining_seconds)
  ) return null;

  return {
    provider: {
      provider: providerName as string | null,
      status: providerStatus as string | null,
      active: provider.active as boolean,
      hard_block: provider.hard_block as boolean,
      reason: providerReason,
      fail_open: providerFailOpen,
      current_period_end: provider.current_period_end as string | null,
      trial_ends_at: provider.trial_ends_at as string | null,
      fail_open_until: provider.fail_open_until as string | null,
      last_verified_at: provider.last_verified_at as string | null,
    },
    overlay: {
      status: overlay.status as AccessGrantReconciliation["overlay"]["status"],
      active_grant: activeGrant,
      queued_grants: overlay.queued_grants as number,
      remaining_seconds: overlay.remaining_seconds as number,
    },
  };
}

function accessGrantDecision(
  planCode: AccessGrantPlanCode,
  projection: JsonRecord | null,
): EntitlementDecision {
  return {
    allowed: true,
    reason: "partners_access_credit",
    status: "active",
    planCode,
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen: false,
    limits: PLAN_LIMITS[planCode],
    projection: projection ? sanitizeProjection(projection) : null,
    message: "Norva access is active through a Partners credit.",
  };
}

export function limitNumber(limits: JsonRecord, key: string, fallback = 0) {
  const value = limits[key];
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : fallback;
}

// Canonical limits for a plan code. Single source of truth shared with the
// billing webhook so a projection always stores limits that match the catalog.
export function planLimits(planCode: string): JsonRecord {
  return { ...(PLAN_LIMITS[planCode] ?? PLAN_LIMITS.none) };
}

// Whether an account has already consumed a free trial on ANY billing rail.
// Keyed to the Supabase user (= RevenueCat App User ID), so it stops a user
// from stacking a Play trial and a web trial. Fails open (returns false) on a
// read error so a transient outage never wrongly blocks a legitimate first
// trial — the purchase path can apply a stricter policy if needed.
export async function hasConsumedTrial(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("cloud_entitlement_projection")
    .select("trial_consumed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.trial_consumed_at);
}

function allowedDecision(reason: string, projection: JsonRecord, limits: JsonRecord, failOpen: boolean): EntitlementDecision {
  const provider = String(projection.provider || "").toLowerCase();
  const includedAccess = String(projection.status || "").toLowerCase() === "active" &&
    (provider === "system" || provider === "manual");
  return {
    allowed: true,
    reason: includedAccess ? "included_access" : reason,
    status: String(projection.status || "unknown"),
    planCode: String(projection.plan_code || "none"),
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen,
    limits,
    projection: sanitizeProjection(projection),
    message: includedAccess
      ? "Norva access is included with this account."
      : failOpen
      ? "Norva access is temporarily allowed while billing status is being verified."
      : "Norva access is active.",
  };
}

// Soft-wall browse decision: the user keeps access to browse (connect a source,
// see their catalogue) but cannot play (free tier has concurrent_streams: 0).
function freeBrowseDecision(reason: string, projection: JsonRecord | null): EntitlementDecision {
  return {
    allowed: true,
    reason: `free_${reason}`,
    status: String(projection?.status || "none"),
    planCode: "free",
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen: false,
    limits: PLAN_LIMITS.free,
    projection: projection ? sanitizeProjection(projection) : null,
    message: billingMessage(reason),
  };
}

function blockedDecision(reason: string, projection: JsonRecord | null, limits = PLAN_LIMITS.none): EntitlementDecision {
  return {
    allowed: false,
    reason,
    status: String(projection?.status || "none"),
    planCode: String(projection?.plan_code || "none"),
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen: false,
    limits,
    projection: projection ? sanitizeProjection(projection) : null,
    message: billingMessage(reason),
  };
}

function uncertainDecision(reason: string, projection: JsonRecord | null): EntitlementDecision {
  const limits = normalizeLimits(String(projection?.plan_code || "manual"), projection?.limits);
  return {
    allowed: true,
    reason,
    status: String(projection?.status || "unknown"),
    planCode: String(projection?.plan_code || "manual"),
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen: true,
    limits,
    projection: projection ? sanitizeProjection(projection) : null,
    message: "Norva access is temporarily allowed because billing status could not be verified.",
  };
}

function applyEntitlementMode(decision: EntitlementDecision): EntitlementDecision {
  if (ENTITLEMENTS_MODE === "enforce") {
    return { ...decision, mode: ENTITLEMENTS_MODE, enforced: true };
  }

  if (HARD_BLOCK_STATUSES.has(decision.reason)) {
    return { ...decision, mode: ENTITLEMENTS_MODE, enforced: true };
  }

  return {
    ...decision,
    allowed: true,
    reason: decision.allowed ? `gate0_observe_${decision.reason}` : `gate0_bypass_${decision.reason}`,
    planCode: decision.planCode === "none" ? "manual" : decision.planCode,
    mode: ENTITLEMENTS_MODE,
    enforced: false,
    failOpen: true,
    limits: PLAN_LIMITS.manual,
    message: "Gate 0 access is open. Billing is being observed but not enforced.",
  };
}

async function startTrialProjection(db: SupabaseClient, userId: string): Promise<JsonRecord | null> {
  const trialEndsAt = new Date(Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const row = {
    user_id: userId,
    provider: "system",
    plan_code: "trial",
    status: "trialing",
    limits: PLAN_LIMITS.trial,
    current_period_end: trialEndsAt,
    trial_ends_at: trialEndsAt,
    trial_consumed_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    notes: "Auto-started Norva trial projection.",
  };
  const { data, error } = await db
    .from("cloud_entitlement_projection")
    .insert(row)
    .select("*")
    .single();
  if (!error) return data as JsonRecord;

  const { data: existing, error: existingError } = await db
    .from("cloud_entitlement_projection")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return existingError ? null : existing as JsonRecord | null;
}

function normalizeLimits(planCode: string, value: unknown): JsonRecord {
  const planDefaults = PLAN_LIMITS[planCode] || PLAN_LIMITS.none;
  const record = isRecord(value) ? value : {};
  // Preserve unknown forward-compatible keys, but canonical catalogue limits win
  // over stale JSON snapshots written by older webhook/function versions.
  return { ...record, ...planDefaults };
}

function sanitizeProjection(projection: JsonRecord): JsonRecord {
  return {
    user_id: projection.user_id,
    provider: projection.provider,
    plan_code: projection.plan_code,
    status: projection.status,
    limits: normalizeLimits(String(projection.plan_code || "none"), projection.limits),
    current_period_end: projection.current_period_end,
    trial_ends_at: projection.trial_ends_at,
    last_verified_at: projection.last_verified_at,
    fail_open_until: projection.fail_open_until,
    updated_at: projection.updated_at,
  };
}

function billingMessage(reason: string) {
  if (reason === "trial_expired") return "Norva trial has ended. Choose a plan to keep watching.";
  if (reason === "subscription_expired") return "Norva access has expired. Update your plan to keep watching.";
  if (reason === "revoked" || reason === "refunded" || reason === "fraud") {
    return "Norva access is unavailable for this account.";
  }
  if (reason === "billing_unverified") return "Norva could not verify access. Try again shortly or manage your plan.";
  return "Norva access is required.";
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is JsonRecord {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value));
}

function boundedState(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[a-z][a-z0-9_]*$/.test(value);
}

function normalizeBillingMode(value: string) {
  const mode = value.trim().toLowerCase();
  return mode === "revenuecat" || mode === "rc" ? "revenuecat" : "legacy";
}

export function getBillingMode() {
  return BILLING_MODE;
}

// The plan a user would effectively be on UNDER ENFORCEMENT. Observe mode
// rewrites planCode→"manual" and allowed→true, so for upsell/signal purposes we
// reconstruct the real plan from the underlying reason + projection. Denied
// reasons (no/expired access) collapse to "free" so an expired trial is treated
// as a conversion target, not as still-entitled.
const DENIED_REASONS = new Set([
  "subscription_required", "trial_expired", "subscription_expired",
  "billing_unverified", "revoked", "refunded", "fraud", "none",
]);
export function realPlanCode(decision: EntitlementDecision): string {
  if (decision.planCode === "free") return "free";
  const reason = decision.reason
    .replace(/^gate0_(observe|bypass)_/, "")
    .replace(/^free_/, "");
  if (DENIED_REASONS.has(reason)) return "free";
  const projection = decision.projection as JsonRecord | null;
  return String(projection?.plan_code || "free");
}

export function planFeatureEntitled(planCode: string, feature: string): boolean {
  const limits = PLAN_LIMITS[planCode] ?? PLAN_LIMITS.free;
  return Boolean(limits[feature]);
}

// Map of premium features → whether the user's real plan grants them. Exposed
// on the entitlements decision so the client can render upsells correctly even
// while observe mode leaves everything unlocked.
export function featuresForDecision(decision: EntitlementDecision): JsonRecord {
  const plan = realPlanCode(decision);
  const features: JsonRecord = {};
  for (const key of PREMIUM_FEATURE_KEYS) {
    features[key] = { entitled: planFeatureEntitled(plan, key) };
  }
  return features;
}

// Conversion signal: record that a user reached for a premium-gated feature.
// Best-effort and non-blocking — a signal must never break a request, and in
// observe mode it never gates anything; it only feeds the conversion funnel.
export async function recordEntitlementSignal(
  db: SupabaseClient,
  userId: string,
  feature: string,
  planCode: string,
  context: JsonRecord = {},
): Promise<void> {
  try {
    await db.from("cloud_entitlement_signals").insert({
      user_id: userId,
      feature: String(feature).slice(0, 64),
      plan_code: planCode,
      mode: ENTITLEMENTS_MODE,
      context: isRecord(context) ? context : {},
    });
  } catch (_) {
    // swallow — the funnel is observability, never a hard dependency
  }
}

function normalizeEntitlementsMode(value: string) {
  const mode = value.trim().toLowerCase().replace(/_/g, "-");
  if (mode === "observe" || mode === "gate0" || mode === "gate0-observe" || mode === "off") {
    return "observe";
  }
  return "enforce";
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number) {
  const raw = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
