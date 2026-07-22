import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const DEFAULT_PAYWALL_EXPERIMENT_KEY = "paywall_positioning_v1";

// Experiment selection is a product decision owned by the server. Clients may
// identify the UI placement they rendered, but they never choose an experiment
// key (or a variant). Placements absent from this map are deliberately outside
// the experiment and therefore receive no assignment/attribution.
export const PAYWALL_EXPERIMENT_BY_PLACEMENT: Readonly<Record<string, string>> = Object.freeze({
  subscribe: DEFAULT_PAYWALL_EXPERIMENT_KEY,
  subscribe_plans: DEFAULT_PAYWALL_EXPERIMENT_KEY,
  access_gate: DEFAULT_PAYWALL_EXPERIMENT_KEY,
  locked_profile: DEFAULT_PAYWALL_EXPERIMENT_KEY,
});

export const PAYWALL_SURFACES = [
  "web",
  "mobile_android",
  "android_tv",
  "samsung_tv",
  "unknown",
] as const;

export type PaywallSurface = typeof PAYWALL_SURFACES[number];

export type PaywallAssignment = {
  eligible: boolean;
  reason: string | null;
  experimentKey: string;
  variant: string | null;
  assignmentId: string | null;
  assignedAt: string | null;
  newAssignment: boolean;
};

export type PaywallExposure = PaywallAssignment & {
  exposed: boolean;
  eventId: string | null;
  eventInserted: boolean;
  placement: string;
  surface: PaywallSurface;
};

export type PaywallAttribution = {
  experimentKey: string | null;
  experimentVariant: string | null;
  placement: string | null;
  surface: PaywallSurface | null;
};

const PLACEMENT_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const EXPERIMENT_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

type RpcRecord = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

export function normalizeExperimentKey(value: unknown): string {
  const key = text(value) ?? DEFAULT_PAYWALL_EXPERIMENT_KEY;
  if (!EXPERIMENT_KEY_RE.test(key)) throw new Error("invalid paywall experiment key");
  return key;
}

export function normalizePaywallPlacement(value: unknown, fallback = "subscribe"): string {
  const placement = (text(value) ?? fallback).toLowerCase();
  if (!PLACEMENT_RE.test(placement)) throw new Error("invalid paywall placement");
  return placement;
}

export function paywallExperimentForPlacement(
  value: unknown,
  fallback = "subscribe",
): { placement: string; experimentKey: string | null } {
  const placement = normalizePaywallPlacement(value, fallback);
  return {
    placement,
    experimentKey: PAYWALL_EXPERIMENT_BY_PLACEMENT[placement] ?? null,
  };
}

export function normalizePaywallSurface(value: unknown, fallback: PaywallSurface = "unknown"): PaywallSurface {
  const surface = (text(value) ?? fallback).toLowerCase();
  if (!(PAYWALL_SURFACES as readonly string[]).includes(surface)) {
    throw new Error("invalid paywall surface");
  }
  return surface as PaywallSurface;
}

function normalizeAssignment(raw: RpcRecord | null, fallbackKey: string): PaywallAssignment {
  return {
    eligible: bool(raw?.eligible),
    reason: text(raw?.reason),
    experimentKey: text(raw?.experiment_key) ?? fallbackKey,
    variant: text(raw?.variant),
    assignmentId: text(raw?.assignment_id),
    assignedAt: text(raw?.assigned_at),
    newAssignment: bool(raw?.new_assignment),
  };
}

/**
 * Resolve the sticky variant using the authenticated account id established by
 * the Edge function. No client-provided variant ever reaches the database.
 */
export async function claimPaywallExperiment(
  db: SupabaseClient,
  userId: string,
  experimentKey: unknown = DEFAULT_PAYWALL_EXPERIMENT_KEY,
): Promise<PaywallAssignment> {
  const key = normalizeExperimentKey(experimentKey);
  const { data, error } = await db.rpc("norva_claim_paywall_experiment_for_user", {
    p_user_id: userId,
    p_experiment_key: key,
  });
  if (error) throw new Error(`paywall experiment claim failed: ${error.message}`);
  return normalizeAssignment((data ?? null) as RpcRecord | null, key);
}

/**
 * Record one idempotent exposure. The RPC claims the account assignment again,
 * so even a forged request body cannot attribute an event to another variant.
 */
export async function recordPaywallExposure(
  db: SupabaseClient,
  userId: string,
  input: { experimentKey?: unknown; placement?: unknown; surface?: unknown },
): Promise<PaywallExposure> {
  const experimentKey = normalizeExperimentKey(input.experimentKey);
  const placement = normalizePaywallPlacement(input.placement);
  const surface = normalizePaywallSurface(input.surface);
  const { data, error } = await db.rpc("norva_record_paywall_exposure_for_user", {
    p_user_id: userId,
    p_experiment_key: experimentKey,
    p_placement: placement,
    p_surface: surface,
  });
  if (error) throw new Error(`paywall exposure write failed: ${error.message}`);
  const raw = (data ?? null) as RpcRecord | null;
  return {
    ...normalizeAssignment(raw, experimentKey),
    exposed: bool(raw?.exposed),
    eventId: text(raw?.event_id),
    eventInserted: bool(raw?.event_inserted),
    placement: text(raw?.placement) ?? placement,
    surface: normalizePaywallSurface(raw?.surface, surface),
  };
}

/**
 * Server-only attribution for checkout/webhook writers. Assignment is always
 * resolved first. The latest matching exposure supplies placement/surface when
 * available; trusted server fallbacks are used otherwise.
 */
export async function latestPaywallAttribution(
  db: SupabaseClient,
  userId: string,
  input: {
    experimentKey?: unknown;
    fallbackPlacement?: string | null;
    fallbackSurface?: PaywallSurface | null;
    occurredAfter?: string | null;
    occurredBefore?: string | null;
    requiredSurface?: PaywallSurface | null;
    requiredSurfaces?: PaywallSurface[] | null;
    requireExposure?: boolean;
  } = {},
): Promise<PaywallAttribution> {
  const assignment = await claimPaywallExperiment(db, userId, input.experimentKey);
  if (!assignment.eligible || !assignment.variant) {
    return { experimentKey: null, experimentVariant: null, placement: null, surface: null };
  }
  let query = db
    .from("paywall_funnel_events")
    .select("placement,surface")
    .eq("user_id", userId)
    .eq("event_type", "paywall_exposed")
    .eq("experiment_key", assignment.experimentKey);
  if (input.occurredAfter) query = query.gte("occurred_at", input.occurredAfter);
  if (input.occurredBefore) query = query.lte("occurred_at", input.occurredBefore);
  if (input.requiredSurfaces?.length) query = query.in("surface", [...new Set(input.requiredSurfaces)]);
  else if (input.requiredSurface) query = query.eq("surface", input.requiredSurface);
  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`paywall attribution read failed: ${error.message}`);
  const row = data as { placement?: unknown; surface?: unknown } | null;
  if (!row && input.requireExposure) {
    return { experimentKey: null, experimentVariant: null, placement: null, surface: null };
  }
  const placement = row?.placement
    ? normalizePaywallPlacement(row.placement)
    : input.fallbackPlacement
      ? normalizePaywallPlacement(input.fallbackPlacement)
      : null;
  const surface = row?.surface
    ? normalizePaywallSurface(row.surface)
    : input.fallbackSurface ?? null;
  return {
    experimentKey: assignment.experimentKey,
    experimentVariant: assignment.variant,
    placement,
    surface,
  };
}
