import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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
  // the decision is already allowed, so this never triggers. Checked ONLY on the deny
  // path, and — unless the caller passed options.isAdmin — with a single getUserById
  // there, so the allowed hot path costs nothing extra.
  if (!decision.allowed && !HARD_BLOCK_STATUSES.has(decision.reason)) {
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

  if (!projection) return applyEntitlementMode(softDeny("subscription_required", null));

  const now = Date.now();
  const status = String(projection.status || "unknown");
  const planCode = String(projection.plan_code || "none");
  const limits = normalizeLimits(planCode, projection.limits);
  const periodEnd = timeMs(projection.current_period_end);
  const trialEnd = timeMs(projection.trial_ends_at);
  const failOpenUntil = timeMs(projection.fail_open_until);
  const lastVerifiedAt = timeMs(projection.last_verified_at);

  if (HARD_BLOCK_STATUSES.has(status)) {
    return applyEntitlementMode(blockedDecision(status, projection, limits));
  }

  if (status === "trialing") {
    const effectiveEnd = trialEnd || periodEnd;
    if (!effectiveEnd || effectiveEnd > now) {
      return applyEntitlementMode(allowedDecision("trialing", projection, limits, false));
    }
    return applyEntitlementMode(softDeny("trial_expired", projection, limits));
  }

  if (status === "active") {
    if (!periodEnd || periodEnd > now) {
      return applyEntitlementMode(allowedDecision("active", projection, limits, false));
    }
    if (failOpenUntil && failOpenUntil > now) {
      return applyEntitlementMode(allowedDecision("billing_grace", projection, limits, true));
    }
    if (lastVerifiedAt && lastVerifiedAt + DEFAULT_FAIL_OPEN_HOURS * 60 * 60 * 1000 > now) {
      return applyEntitlementMode(allowedDecision("billing_recently_verified", projection, limits, true));
    }
    return applyEntitlementMode(softDeny("subscription_expired", projection, limits));
  }

  if (status === "cancelled_at_period_end") {
    if (!periodEnd || periodEnd > now) {
      return applyEntitlementMode(allowedDecision("cancelled_at_period_end", projection, limits, false));
    }
    return applyEntitlementMode(softDeny("subscription_expired", projection, limits));
  }

  if (status === "grace" || status === "past_due" || status === "unknown") {
    if ((periodEnd && periodEnd > now) || (failOpenUntil && failOpenUntil > now)) {
      return applyEntitlementMode(allowedDecision("billing_grace", projection, limits, true));
    }
    if (lastVerifiedAt && lastVerifiedAt + DEFAULT_FAIL_OPEN_HOURS * 60 * 60 * 1000 > now) {
      return applyEntitlementMode(allowedDecision("billing_recently_verified", projection, limits, true));
    }
    return applyEntitlementMode(blockedDecision("billing_unverified", projection, limits));
  }

  if (status === "expired") {
    return applyEntitlementMode(softDeny("subscription_expired", projection, limits));
  }

  return applyEntitlementMode(softDeny("subscription_required", projection, limits));
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
  return {
    allowed: true,
    reason,
    status: String(projection.status || "unknown"),
    planCode: String(projection.plan_code || "none"),
    mode: ENTITLEMENTS_MODE,
    enforced: ENTITLEMENTS_MODE === "enforce",
    failOpen,
    limits,
    projection: sanitizeProjection(projection),
    message: failOpen
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

// In RevenueCat billing mode, "soft" denials (no subscription / trial ended /
// subscription expired) degrade to free browse instead of a hard block — the
// user is walled only at playback (the soft-wall model). Legacy mode keeps the
// historical hard block, and observe mode overrides everything anyway, so this
// is dormant until billing_mode=revenuecat AND entitlements_mode=enforce.
function softDeny(reason: string, projection: JsonRecord | null, limits = PLAN_LIMITS.none): EntitlementDecision {
  if (BILLING_MODE === "revenuecat") return freeBrowseDecision(reason, projection);
  return blockedDecision(reason, projection, limits);
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
  return { ...planDefaults, ...record };
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

function timeMs(value: unknown) {
  if (!value) return 0;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  const reason = decision.reason.replace(/^gate0_(observe|bypass)_/, "");
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
