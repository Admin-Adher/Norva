// Signup risk scoring — a pure function, deliberately.
//
// Signals in, score out. No database, no clock, no network, no environment. The
// caller gathers evidence and the caller acts on the verdict; this module only
// arithmetic. That is what makes every arbitration in it testable, and it is why
// the weights below can be argued about from a test file rather than from
// production.
//
// SCOPE. This is signup_risk: bots, automation, spam, signup flood. It is NOT
// trial abuse. Repeated trials, mailbox rotation and device trial history are a
// separate score with different weights, because the same history means opposite
// things to the two questions — a device carrying an old healthy account is
// reassuring for "is this a human signing up" and mildly suspicious for "should
// this person get another free trial". Sharing weights mechanically between the
// two would be a category error.
//
// THE MODEL. Additive with per-family caps, then a floor:
//
//   positive   = sum of positive signals, each family capped
//   negative   = max(NEGATIVE_CAP, sum of negative signals)
//   candidate  = positive + negative
//   raw_score  = candidate, or the highest hard-evidence floor if higher
//   risk_score = clamp(raw_score, 0, 100)
//
// The floor is what earlier drafts got wrong. A rule of the form "hard evidence
// disables negative signals" reads well and is wrong: the 3rd account on one
// device is +25, so under such a rule it would have cancelled the trusted-device
// credit and pushed a family sharing a laptop to MEDIUM — the exact false
// positive this engine exists to prevent. A floor keeps strong evidence
// un-whitewashable without touching ordinary velocity.
//
// raw_score is kept alongside risk_score. Four nonce replays are 115, and
// knowing a request was at 115 rather than clamped to 100 is worth having when
// the distributions are read.

export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Families exist so weak signals cannot stack into a verdict. A Linux user on a
 * VPN with no Accept-Language from a hosting ASN is a privacy-conscious
 * developer; four such signals must not add up to a refusal.
 */
export type SignalFamily =
  | "behaviour"
  | "velocity"
  | "network"
  | "client"
  | "email"
  | "trust";

export interface RiskSignal {
  code: string;
  family: SignalFamily;
  weight: number;
  /** Set on the evidence that cannot be argued away by a negative signal. */
  floor?: number;
}

/** Caps are per family, not global: behaviour is where evidence is meant to add up. */
export const FAMILY_CAPS: Record<SignalFamily, number> = {
  behaviour: Number.POSITIVE_INFINITY,
  velocity: 60,
  network: 18,
  client: 40,
  email: 15,
  trust: 0,
};

/** Negative signals are bounded so trust can never become a laundering path. */
export const NEGATIVE_CAP = -20;

export const LEVEL_THRESHOLDS = {
  low: 20,
  medium: 40,
  high: 65,
  critical: 85,
} as const;

export type LevelThresholds = typeof LEVEL_THRESHOLDS;

export interface RiskAssessment {
  rawScore: number;
  riskScore: number;
  level: RiskLevel;
  /** Every signal that fired, with the weight it actually contributed. */
  contributions: Array<{ code: string; family: SignalFamily; weight: number; capped: boolean }>;
  /**
   * Distinct positive families involved. Logged from the first day even though
   * only enforcement will read it: honeypot plus a double-click is 85, yet both
   * are single-family behavioural accidents, and refusing on that would be
   * refusing on one kind of evidence twice. Without this recorded now, the
   * question "how many of our HIGH verdicts rested on two independent families"
   * has no historical answer later.
   */
  familiesInvolved: SignalFamily[];
  /** Evidence that repeated rather than merely occurred. */
  repeatedStrongEvidence: boolean;
  floorApplied: number;
}

function levelFor(score: number, thresholds: LevelThresholds): RiskLevel {
  if (score >= thresholds.critical) return "CRITICAL";
  if (score >= thresholds.high) return "HIGH";
  if (score >= thresholds.medium) return "MEDIUM";
  if (score >= thresholds.low) return "LOW";
  return "SAFE";
}

export function assessSignupRisk(
  signals: RiskSignal[],
  options: { thresholds?: LevelThresholds; familyCaps?: Record<SignalFamily, number> } = {},
): RiskAssessment {
  const thresholds = options.thresholds ?? LEVEL_THRESHOLDS;
  const caps = options.familyCaps ?? FAMILY_CAPS;

  const positiveByFamily = new Map<SignalFamily, number>();
  const contributions: RiskAssessment["contributions"] = [];
  const families = new Set<SignalFamily>();
  let negative = 0;
  let floor = 0;
  let strongCount = 0;

  for (const signal of signals) {
    if (!Number.isFinite(signal.weight) || signal.weight === 0) continue;

    if (signal.weight < 0) {
      negative += signal.weight;
      contributions.push({ ...signal, capped: false });
      continue;
    }

    const cap = caps[signal.family] ?? Number.POSITIVE_INFINITY;
    const used = positiveByFamily.get(signal.family) ?? 0;
    const room = Math.max(0, cap - used);
    const applied = Math.min(signal.weight, room);
    positiveByFamily.set(signal.family, used + applied);
    contributions.push({
      code: signal.code,
      family: signal.family,
      weight: applied,
      capped: applied < signal.weight,
    });
    // A capped-to-zero signal still proves its family was involved: the evidence
    // existed, the budget for it was simply spent.
    families.add(signal.family);

    if (typeof signal.floor === "number" && signal.floor > floor) floor = signal.floor;
    if (signal.weight >= 30) strongCount += 1;
  }

  const positive = [...positiveByFamily.values()].reduce((a, b) => a + b, 0);
  const candidate = positive + Math.max(NEGATIVE_CAP, negative);
  // A floor of zero means no floor, not a lower bound: raw_score is allowed to
  // go negative so the logs can show that trust outweighed risk. risk_score is
  // where the clamping belongs.
  const rawScore = floor > 0 ? Math.max(candidate, floor) : candidate;
  const riskScore = Math.min(100, Math.max(0, rawScore));

  return {
    rawScore,
    riskScore,
    level: levelFor(riskScore, thresholds),
    contributions,
    familiesInvolved: [...families],
    repeatedStrongEvidence: strongCount >= 2,
    floorApplied: floor,
  };
}

// ── The catalogue ───────────────────────────────────────────────────────────
//
// Weights live here, thresholds live in configuration. Adding a signal is code;
// re-tuning one during an attack must not be.

/** Exclusive by construction, so the token can never be scored twice. */
export type TokenState =
  | "TOKEN_VALID_FRESH"
  | "TOKEN_VALID_EXPIRED"
  | "TOKEN_VALID_REPLAYED"
  | "TOKEN_MISSING"
  | "TOKEN_INVALID";

/**
 * Only a token whose signature verified carries a server timestamp worth
 * trusting, so only those states allow the submission delay to be judged. And a
 * replay is excluded even though its timestamp is sound: a double click would
 * otherwise collect the replay weight AND the fast-submission weight, reaching
 * HIGH on one human accident.
 */
export function tokenStateAllowsTiming(state: TokenState): boolean {
  return state === "TOKEN_VALID_FRESH" || state === "TOKEN_VALID_EXPIRED";
}

export const SIGNALS = {
  tokenInvalid: (): RiskSignal =>
    ({ code: "token_signature_invalid", family: "behaviour", weight: 55, floor: 55 }),
  tokenMissing: (): RiskSignal =>
    ({ code: "token_missing", family: "behaviour", weight: 35 }),
  tokenExpired: (): RiskSignal =>
    ({ code: "token_expired", family: "behaviour", weight: 10 }),
  /** First replay floors at 40; each further one adds, so two reach HIGH. */
  tokenReplay: (occurrence: number): RiskSignal =>
    occurrence <= 1
      ? { code: "token_replay_first", family: "behaviour", weight: 40, floor: 40 }
      : { code: "token_replay_repeat", family: "behaviour", weight: 25 },
  honeypot: (): RiskSignal =>
    ({ code: "honeypot_filled", family: "behaviour", weight: 45, floor: 45 }),
  submissionUnder1500ms: (): RiskSignal =>
    ({ code: "submission_under_1500ms", family: "behaviour", weight: 30 }),
  submissionUnder3000ms: (): RiskSignal =>
    ({ code: "submission_under_3000ms", family: "behaviour", weight: 12 }),

  velocityIp: (per1h: number, per24h: number): RiskSignal | null => {
    // Only the highest matching tier of a dimension counts. Stacking tiers would
    // put one dimension at 55 and let a single signal reach HIGH.
    if (per1h >= 5) return { code: "velocity_ip_5_per_1h", family: "velocity", weight: 30 };
    if (per24h >= 10) return { code: "velocity_ip_10_per_24h", family: "velocity", weight: 25 };
    if (per1h >= 3) return { code: "velocity_ip_3_per_1h", family: "velocity", weight: 15 };
    return null;
  },
  velocityDevice: (accounts: number): RiskSignal | null => {
    if (accounts >= 5) return { code: "velocity_device_5_accounts", family: "velocity", weight: 40 };
    if (accounts >= 3) return { code: "velocity_device_3_accounts", family: "velocity", weight: 25 };
    return null;
  },
  velocitySubnet: (per1h: number): RiskSignal | null =>
    per1h >= 8 ? { code: "velocity_subnet_8_per_1h", family: "velocity", weight: 20 } : null,
  velocityEmailExact: (per1h: number): RiskSignal | null =>
    per1h >= 3 ? { code: "velocity_email_3_per_1h", family: "velocity", weight: 20 } : null,
  velocityMailbox: (accounts: number): RiskSignal | null =>
    // Moderate here on purpose. One inbox behind several accounts is worth far
    // more to trial_abuse than to the question of whether this is a bot.
    accounts >= 3 ? { code: "velocity_mailbox_3_accounts", family: "velocity", weight: 20 } : null,

  datacenterAsn: (): RiskSignal =>
    ({ code: "network_datacenter_asn", family: "network", weight: 12 }),
  torExit: (): RiskSignal =>
    ({ code: "network_tor_exit", family: "network", weight: 15 }),
  knownVpn: (): RiskSignal =>
    // A VPN is not a bot. It moves the needle only alongside something else.
    ({ code: "network_known_vpn", family: "network", weight: 6 }),

  headlessUserAgent: (): RiskSignal =>
    ({ code: "client_headless_ua", family: "client", weight: 30 }),
  missingUserAgent: (): RiskSignal =>
    ({ code: "client_no_ua", family: "client", weight: 25 }),
  clientHintsContradiction: (): RiskSignal =>
    ({ code: "client_hints_contradiction", family: "client", weight: 20 }),
  missingAcceptLanguage: (): RiskSignal =>
    ({ code: "client_no_accept_language", family: "client", weight: 8 }),
  /**
   * A common User-Agent is not evidence. Thousands of people share one Chrome on
   * Android build, and at Norva's scale this fires on its own by arithmetic.
   * It counts for very little, and only once behaviour has already spoken.
   */
  sharedUserAgent: (behaviouralSignalFired: boolean): RiskSignal | null =>
    behaviouralSignalFired
      ? { code: "client_shared_ua_with_behaviour", family: "client", weight: 5 }
      : null,

  disposableEmailDomain: (): RiskSignal =>
    ({ code: "email_disposable_domain", family: "email", weight: 15 }),

  /**
   * Trust, not innocence. "Healthy" is defined strictly on purpose: verifying one
   * address and then farming from the same browser must not earn a discount.
   */
  trustedDevice: (): RiskSignal =>
    ({ code: "trust_device_history", family: "trust", weight: -15 }),
  authenticatedSession: (): RiskSignal =>
    ({ code: "trust_existing_session", family: "trust", weight: -10 }),
  credibleInteraction: (): RiskSignal =>
    // Weak by design: focus, keydown and human-looking delays are all simulable.
    ({ code: "trust_frontend_interaction", family: "trust", weight: -5 }),
} as const;
