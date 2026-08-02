export type PayoutProvider =
  | "wise"
  | "revolut"
  | "stripe_connect";

const PROVIDERS = new Set<PayoutProvider>([
  "wise",
  "revolut",
  "stripe_connect",
]);
const ACCOUNT_STATUSES = new Set([
  "invited",
  "pending_verification",
  "active",
  "held",
  "suspended",
  "closed",
]);
const FISCAL_STATUSES = new Set([
  "missing",
  "pending",
  "verified",
  "rejected",
  "expired",
]);
const PROFILE_STATUSES = new Set([
  "active",
  "disabled",
  "verification_required",
]);
const READINESS_REASONS = new Set([
  "account_not_active",
  "kyc_not_verified",
  "fiscal_profile_required",
  "provider_not_configured",
  "payouts_not_live",
]);
const PUBLIC_ACCOUNT_PATTERN = /^prt_[0-9a-f]{24}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

export class PayoutContractError extends Error {
  constructor(message = "Invalid payout profile contract") {
    super(message);
    this.name = "PayoutContractError";
  }
}

export function sanitizePayoutProfileGet(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "account",
    "fiscal",
    "profile",
    "profiles",
    "readiness",
  ]);
  if (root.schema_version !== 1) throw new PayoutContractError();
  const account = sanitizeAccount(root.account);
  const fiscal = root.fiscal === null ? null : sanitizeFiscal(root.fiscal);
  const profile = root.profile === null ? null : sanitizeProfile(root.profile);
  if (!Array.isArray(root.profiles) || root.profiles.length > 32) {
    throw new PayoutContractError();
  }
  const profiles = root.profiles.map(sanitizeProfile);
  if (
    new Set(profiles.map((item) => item.currency)).size !== profiles.length ||
    ((profile === null) !== (profiles.length === 0)) ||
    (
      profile !== null &&
      !profiles.some((item) =>
        item.provider === profile.provider &&
        item.display_masked === profile.display_masked &&
        item.currency === profile.currency &&
        item.status === profile.status
      )
    )
  ) {
    throw new PayoutContractError();
  }
  const readiness = sanitizeReadiness(root.readiness);

  if (
    readiness.ready &&
    (
      readiness.reason !== null ||
      !readiness.payouts_live ||
      account.status !== "active" ||
      fiscal?.status !== "verified" ||
      profile?.status !== "active"
    )
  ) {
    throw new PayoutContractError();
  }
  if (!readiness.ready && readiness.reason === null) {
    throw new PayoutContractError();
  }
  if (
    readiness.reason === "account_not_active" &&
    account.status === "active"
  ) {
    throw new PayoutContractError();
  }
  if (
    readiness.reason === "fiscal_profile_required" &&
    fiscal?.status === "verified"
  ) {
    throw new PayoutContractError();
  }
  if (
    readiness.reason === "payouts_not_live" &&
    readiness.payouts_live
  ) {
    throw new PayoutContractError();
  }

  return {
    schema_version: 1,
    account,
    fiscal,
    profile,
    profiles,
    readiness,
  };
}

function sanitizeAccount(value: unknown): { id: string; status: string } {
  const account = exactRecord(value, ["id", "status"]);
  if (
    typeof account.id !== "string" ||
    !PUBLIC_ACCOUNT_PATTERN.test(account.id) ||
    typeof account.status !== "string" ||
    !ACCOUNT_STATUSES.has(account.status)
  ) {
    throw new PayoutContractError();
  }
  return { id: account.id, status: account.status };
}

function sanitizeFiscal(
  value: unknown,
): { status: string; country_code: string } {
  const fiscal = exactRecord(value, ["status", "country_code"]);
  if (
    typeof fiscal.status !== "string" ||
    !FISCAL_STATUSES.has(fiscal.status) ||
    typeof fiscal.country_code !== "string" ||
    !COUNTRY_PATTERN.test(fiscal.country_code)
  ) {
    throw new PayoutContractError();
  }
  return {
    status: fiscal.status,
    country_code: fiscal.country_code,
  };
}

function sanitizeProfile(
  value: unknown,
): {
  provider: PayoutProvider;
  display_masked: string;
  currency: string;
  status: string;
} {
  const profile = exactRecord(value, [
    "provider",
    "display_masked",
    "currency",
    "status",
  ]);
  if (
    typeof profile.provider !== "string" ||
    !PROVIDERS.has(profile.provider as PayoutProvider) ||
    typeof profile.display_masked !== "string" ||
    profile.display_masked !== profile.display_masked.trim() ||
    profile.display_masked.length < 4 ||
    profile.display_masked.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(profile.display_masked) ||
    looksLikeRawFinancialIdentifier(profile.display_masked) ||
    typeof profile.currency !== "string" ||
    !CURRENCY_PATTERN.test(profile.currency) ||
    typeof profile.status !== "string" ||
    !PROFILE_STATUSES.has(profile.status)
  ) {
    throw new PayoutContractError();
  }
  return {
    provider: profile.provider as PayoutProvider,
    display_masked: profile.display_masked,
    currency: profile.currency,
    status: profile.status,
  };
}

function sanitizeReadiness(
  value: unknown,
): {
  ready: boolean;
  payouts_live: boolean;
  reason: string | null;
} {
  const readiness = exactRecord(value, [
    "ready",
    "payouts_live",
    "reason",
  ]);
  if (
    typeof readiness.ready !== "boolean" ||
    typeof readiness.payouts_live !== "boolean" ||
    (
      readiness.reason !== null &&
      (
        typeof readiness.reason !== "string" ||
        !READINESS_REASONS.has(readiness.reason)
      )
    )
  ) {
    throw new PayoutContractError();
  }
  return {
    ready: readiness.ready,
    payouts_live: readiness.payouts_live,
    reason: readiness.reason as string | null,
  };
}

function looksLikeRawFinancialIdentifier(value: string): boolean {
  const compact = value.replace(/[- ]/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return true;
  if (/^\d{6,34}$/.test(value.replace(/[-:/. ]/g, ""))) return true;
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return true;
  return false;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new PayoutContractError();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PayoutContractError();
  }
  return record;
}
