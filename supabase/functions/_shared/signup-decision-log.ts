// The decision log: what the engine saw, what it would have done, what it did.
//
// This is the only artefact that makes recalibration possible, so it records the
// calculation rather than its conclusion. A stored "47 / MEDIUM" is useless three
// weeks later if the weights and thresholds have moved — and they are meant to
// move. Hence policy_config_hash: a digest over a canonical rendering of the
// configuration that was actually in force. A policy_version alone cannot carry
// that weight, because configuration is changeable at runtime and two rows
// stamped "v1" could have been computed under different thresholds. The hash
// changes whether or not anybody remembered to bump a name.
//
// The hash is a plain SHA-256, not a keyed digest. Configuration is not a secret,
// and the property wanted here is reproducibility: the same policy must produce
// the same hash on any machine, so two deployments can be compared.

import type { RiskAssessment, SignalFamily } from "./signup-risk-engine.ts";

export const RISK_MODEL_VERSION = "signup-risk-v1";
export const VELOCITY_RULES_VERSION = "velocity-v1";

/** Names the intent of a policy. The hash below is what actually identifies it. */
export const POLICY_VERSION = Deno.env.get("NORVA_ABUSE_POLICY_VERSION")
  ?? "observe-2026-08-22-01";

/**
 * Enforcement is off until the distributions have been read. It is read here
 * once so a single environment variable governs the whole path, and the database
 * carries the same invariant as a constraint: with enforcement off, no row can
 * record anything but ALLOW.
 */
export function enforcementEnabled(): boolean {
  return Deno.env.get("NORVA_ABUSE_ENFORCEMENT_ENABLED") === "true";
}

export type SignupDecision = "ALLOW" | "RESTRICT" | "REJECT" | "BLOCK";

/**
 * Stable rendering: keys sorted at every depth, no insertion-order dependence,
 * no whitespace. Two configurations that differ only in the order they were
 * written must hash the same, and two that differ in any value must not.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface PolicySnapshot {
  thresholds: Record<string, number>;
  familyCaps: Record<string, number>;
  negativeCap: number;
  riskModelVersion: string;
  velocityRulesVersion: string;
}

export async function policyConfigHash(policy: PolicySnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(policy));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Level to decision. The mapping is policy, so it travels with the snapshot. */
export function decisionFor(level: RiskAssessment["level"]): SignupDecision {
  switch (level) {
    case "CRITICAL":
      return "BLOCK";
    case "HIGH":
      return "REJECT";
    case "MEDIUM":
      return "RESTRICT";
    default:
      return "ALLOW";
  }
}

export interface DecisionContext {
  /** Pseudonymised subjects, or null when the value could not be canonicalised. */
  ipSubjectHmac: string | null;
  mailboxSubjectHmac: string | null;
  deviceSubjectHmac: string | null;
  attemptFingerprint: string | null;
  asn: number | null;
  country: string | null;
  uaFamily: string | null;
  authMethod: string;
  platform: string;
  appVersion: string | null;
  signupEndpointVersion: string;
  hashVersion: number;
  fingerprintVersion: number;
}

export interface FamilyTotal {
  raw: number;
  capped: number;
}

/**
 * Raw and capped per family. The difference is the whole point: a signal that was
 * clipped looks identical to one that never fired if only the total is kept, and
 * "this cap is too tight" then becomes unarguable.
 */
export function familyTotals(assessment: RiskAssessment): Record<string, FamilyTotal> {
  const totals: Record<string, FamilyTotal> = {};
  for (const contribution of assessment.contributions) {
    const key = contribution.family as SignalFamily;
    totals[key] ??= { raw: 0, capped: 0 };
    totals[key].raw += contribution.requested;
    totals[key].capped += contribution.weight;
  }
  return totals;
}

export interface DecisionRecord {
  risk_model_version: string;
  policy_version: string;
  policy_config_hash: string;
  velocity_rules_version: string;
  fingerprint_version: number;
  hash_version: number;
  thresholds_used: Record<string, number>;
  family_caps_used: Record<string, number>;
  observed_raw_score: number;
  observed_risk_score: number;
  observed_risk_level: RiskAssessment["level"];
  risk_floor: number;
  signals: Array<{
    code: string;
    family: string;
    weight: number;
    requested: number;
    capped: boolean;
  }>;
  family_totals: Record<string, FamilyTotal>;
  families_involved: string[];
  repeated_strong_evidence: boolean;
  would_have_decision: SignupDecision;
  enforcement_enabled: boolean;
  actual_decision: SignupDecision;
  ip_subject_hmac: string | null;
  mailbox_subject_hmac: string | null;
  device_subject_hmac: string | null;
  attempt_fingerprint: string | null;
  asn: number | null;
  country: string | null;
  ua_family: string | null;
  auth_method: string;
  platform: string;
  app_version: string | null;
  signup_endpoint_version: string;
}

export function buildDecisionRecord(
  assessment: RiskAssessment,
  policy: PolicySnapshot,
  policyHash: string,
  context: DecisionContext,
  rawFamilyTotals: Record<string, FamilyTotal>,
): DecisionRecord {
  const wouldHave = decisionFor(assessment.level);
  const enforcing = enforcementEnabled();
  return {
    risk_model_version: policy.riskModelVersion,
    policy_version: POLICY_VERSION,
    policy_config_hash: policyHash,
    velocity_rules_version: policy.velocityRulesVersion,
    fingerprint_version: context.fingerprintVersion,
    hash_version: context.hashVersion,
    thresholds_used: policy.thresholds,
    family_caps_used: { ...policy.familyCaps, negative: policy.negativeCap },
    observed_raw_score: assessment.rawScore,
    observed_risk_score: assessment.riskScore,
    observed_risk_level: assessment.level,
    risk_floor: assessment.floorApplied,
    signals: assessment.contributions,
    family_totals: rawFamilyTotals,
    families_involved: assessment.familiesInvolved,
    repeated_strong_evidence: assessment.repeatedStrongEvidence,
    would_have_decision: wouldHave,
    enforcement_enabled: enforcing,
    // The invariant, in the one place that produces the value. The database
    // carries it too, so a future caller cannot record a refusal while
    // enforcement is off even by constructing the row itself.
    actual_decision: enforcing ? wouldHave : "ALLOW",
    ip_subject_hmac: context.ipSubjectHmac,
    mailbox_subject_hmac: context.mailboxSubjectHmac,
    device_subject_hmac: context.deviceSubjectHmac,
    attempt_fingerprint: context.attemptFingerprint,
    asn: context.asn,
    country: context.country,
    ua_family: context.uaFamily,
    auth_method: context.authMethod,
    platform: context.platform,
    app_version: context.appVersion,
    signup_endpoint_version: context.signupEndpointVersion,
  };
}

/** Ninety days: long enough for a subscription cohort to mature, no longer. */
export const DECISION_RETENTION_DAYS = 90;

// deno-lint-ignore no-explicit-any
export async function recordDecision(db: any, record: DecisionRecord): Promise<string | null> {
  const { data, error } = await db.rpc("abuse_signup_decision_record", {
    p_decision: record,
    p_retention_days: DECISION_RETENTION_DAYS,
  });
  // Telemetry must never be the reason a signup fails. A lost row costs one
  // observation; a thrown error would cost a person their account.
  if (error) return null;
  return typeof data === "string" ? data : null;
}
