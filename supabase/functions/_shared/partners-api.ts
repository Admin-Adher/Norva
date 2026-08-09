export const PARTNERS_API_VERSION = "2026-07-29";

export const DEFAULT_PARTNERS_ALLOWED_ORIGINS = Object.freeze([
  "https://norva.tv",
  "https://www.norva.tv",
  "https://app.norva.tv",
  "https://norva-web.pages.dev",
]);

export const PARTNERS_ALLOWED_REQUEST_HEADERS = Object.freeze([
  "authorization",
  "apikey",
  "content-type",
  "idempotency-key",
  "x-client-info",
]);

export const PARTNERS_RPC = Object.freeze({
  bootstrap: "partners_service_bootstrap",
  bootstrapV2: "partners_service_bootstrap_v2",
  join: "partners_service_join_v2",
  accessCreditQuote: "partners_service_access_credit_quote",
  accessCreditRedeem: "partners_service_access_credit_redeem",
  accessGrantsReconcile: "partners_service_access_grants_reconcile",
  accessCreditStatus: "partners_service_access_credit_status",
  payoutCountryBind: "partners_service_payout_country_bind",
  accessRequestGet: "partners_service_access_request_get",
  accessRequestSubmit: "partners_service_access_request_submit",
  apply: "partners_service_apply",
  acceptTerms: "partners_service_accept_terms",
  activationReconcile: "partners_service_activation_reconcile",
  rotateLink: "partners_service_rotate_link",
  dashboard: "partners_service_dashboard",
  dashboardV2: "partners_service_dashboard_v2",
  kycRightsGet: "partners_service_kyc_rights_get",
  biometricConsentWithdraw: "partners_service_biometric_consent_withdraw",
  kycHumanReviewRequest: "partners_service_kyc_human_review_request",
  kycPrepare: "partners_service_kyc_prepare_v2",
  kycSessionRecord: "partners_service_kyc_session_record_v3",
  kycCertificationPrepare: "admin_partners_kyc_certification_prepare",
  kycCertificationResume: "admin_partners_kyc_certification_resume",
  kycCertificationCreateClaim:
    "partners_service_kyc_certification_create_claim",
  kycCertificationSessionRecord:
    "partners_service_kyc_certification_session_record",
  kycCertificationBindingMatch:
    "partners_service_kyc_certification_binding_match",
  kycCertificationWebhookApply:
    "partners_service_kyc_certification_webhook_apply",
  referralClaim: "partners_service_referral_claim",
  payoutProfileGet: "partners_service_payout_profile_get",
  fiscalProfileGet: "partners_service_fiscal_profile_get",
  fiscalProfileSelfAttest: "partners_service_fiscal_profile_self_attest",
  payoutOnboardingGet: "partners_service_payout_onboarding_get",
  payoutOnboardingRequest: "partners_service_payout_onboarding_request",
  memberWriteReserve: "partners_service_member_write_reserve",
  tvRelayConsume: "partners_service_tv_relay_consume",
});

export type PublicErrorCode =
  | "authentication_required"
  | "invalid_access_token"
  | "cors_origin_denied"
  | "cors_preflight_denied"
  | "invalid_content_type"
  | "invalid_request"
  | "payload_too_large"
  | "invalid_query"
  | "route_not_found"
  | "method_not_allowed"
  | "business_accounts_not_supported"
  | "kyc_billing_unavailable"
  | "didit_certification_disabled"
  | "provider_not_configured"
  | "provider_temporarily_unavailable"
  | "biometric_consent_withdrawn"
  | "referral_not_configured"
  | "tv_relay_not_configured"
  | "tv_relay_not_found"
  | "rate_limited"
  | "idempotency_key_required"
  | "idempotency_key_reused"
  | "request_in_progress"
  | "partners_access_requests_disabled"
  | "membership_required"
  | "credits_disabled"
  | "quote_expired"
  | "insufficient_balance"
  | "catalog_unavailable"
  | "fx_rate_unavailable"
  | "quote_conflict"
  | "payout_country_unavailable"
  | "partners_action_not_allowed"
  | "partners_temporarily_unavailable";

export class PublicApiError extends Error {
  readonly status: number;
  readonly code: PublicErrorCode;
  readonly nextState?: "business_waitlist";

  constructor(
    status: number,
    code: PublicErrorCode,
    message: string,
    nextState?: "business_waitlist",
  ) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
    this.nextState = nextState;
  }
}

export class BootstrapContractError extends Error {
  constructor() {
    super("Invalid partners bootstrap contract");
    this.name = "BootstrapContractError";
  }
}

export type BootstrapQuery = {
  countryCode: string | null;
  subdivisionCode: string | null;
};

export type ApplicationInput = {
  accountType: "individual";
  countryCode: string;
  subdivisionCode: string | null;
};

export type AccessRequestInput = {
  countryCode: string;
  subdivisionCode: string | null;
};

export type AcceptTermsInput = {
  termsVersion: string;
  disclosureVersion: string;
};

export type JoinInput = {
  termsAccepted: true;
  disclosureAccepted: true;
};

export type AccessCreditQuoteInput = {
  months: number;
};

export type AccessCreditRedemptionInput = {
  quoteKey: string;
};

export type PayoutCountryInput = {
  countryCode: string;
};

export type DashboardQuery = {
  historyLimit: number;
  historyCursor: string | null;
  historyStatus: string;
};

export type KycHumanReviewInput = {
  reason:
    | "identity_result_contested"
    | "age_result_contested"
    | "country_result_contested"
    | "verification_unavailable"
    | "other_result_contested";
};

export type FiscalProfileInput = {
  countryCode: string;
  declarationAccepted: true;
  declarationVersion: "partners-tax-self-certification-v1";
};

export type PayoutOnboardingInput = {
  currency: string;
  contactConsent: true;
};

const VISIBILITY_REASONS = new Set([
  "disabled",
  "invite_only",
  "available",
  "existing_account",
]);
const ELIGIBILITY_REASONS = new Set([
  "disabled",
  "country_required",
  "country_not_supported",
  "subdivision_not_supported",
  "not_allowlisted",
  "account_blocked",
  "account_attention_required",
  "eligible",
]);
const ACCOUNT_STATUSES = new Set([
  "invited",
  "pending_verification",
  "active",
  "held",
  "suspended",
  "closed",
]);
const VERIFICATION_STATUSES = new Set([
  "not_started",
  "pending",
  "verified",
  "failed",
  "expired",
]);
const CONTRACT_STATUSES = new Set([
  "not_accepted",
  "accepted",
  "expired",
]);
const LINK_STATUSES = new Set([
  "none",
  "active",
  "revoked",
]);
const ACCESS_REQUEST_STATUSES = new Set([
  "requested",
  "approved",
  "declined",
]);
const ACCESS_REQUEST_NEXT_ACTIONS = new Set([
  "await_review",
  "access_approved",
  "contact_support",
]);
const MUTATION_ACTIONS = new Set([
  "application_submitted",
  "terms_accepted",
  "link_rotated",
]);
const NEXT_ACTIONS = new Set([
  "start_verification",
  "await_verification",
  "accept_terms",
  "activate_account",
  "share_link",
  "contact_support",
  "none",
]);
const DASHBOARD_HISTORY_STATUSES = new Set([
  "all",
  "pending",
  "available",
  "held",
  "redeemed",
  "paid",
  "reversed",
]);
const MEMBERSHIP_STATUSES = new Set([
  "not_joined",
  "active",
  "held",
  "suspended",
  "closed",
]);
const DASHBOARD_V2_HISTORY_TYPES = new Set([
  "accrual",
  "release",
  "access_credit_redemption",
  "payout_settlement",
  "payout_late_settlement",
  "reversal",
  "manual_reversal",
  "payout_return",
]);
const REPORTING_REASONS = new Set([
  "available",
  "no_financial_activity",
  "multiple_currencies",
]);
const KYC_LEVELS = new Set([
  "identity_age_country",
  "identity_age_country_capacity",
]);
const KYC_CONSENT_STATUSES = new Set([
  "not_available",
  "not_granted",
  "granted",
  "withdrawn",
]);
const KYC_HUMAN_REVIEW_REASONS = new Set([
  "identity_result_contested",
  "age_result_contested",
  "country_result_contested",
  "verification_unavailable",
  "other_result_contested",
]);
const KYC_HUMAN_REVIEW_STATUSES = new Set([
  "none",
  "requested",
  "in_review",
  "resolved",
]);
const KYC_HUMAN_REVIEW_RESOLUTIONS = new Set([
  "original_decision_upheld",
  "reverification_available",
]);
const KYC_HUMAN_REVIEW_KEY_PATTERN = /^khr_[0-9a-f]{24}$/;
const ACTIVITY_TYPES = new Set([
  "commission_pending",
  "commission_available",
  "commission_held",
  "commission_paid",
  "commission_reversed",
]);
const FISCAL_PROFILE_STATUSES = new Set([
  "missing",
  "pending",
  "verified",
  "rejected",
  "expired",
]);
const PAYOUT_ONBOARDING_STATUSES = new Set([
  "not_started",
  "pending",
  "in_progress",
  "rejected",
  "completed",
]);
const PAYOUT_ONBOARDING_REASON_CODES = new Set([
  "route_unavailable",
  "beneficiary_setup_required",
  "identity_mismatch",
  "unsupported_destination",
  "compliance_review",
  "duplicate_request",
]);
const MEMBER_WRITE_LIMITS = Object.freeze({
  membership_join: 4,
  link_rotation: 4,
  payout_country_bind: 8,
  access_credit_quote: 24,
  access_credit_redeem: 12,
  fiscal_profile_self_attestation: 8,
  payout_onboarding: 8,
} as const);

export type PartnersMemberWriteOperation = keyof typeof MEMBER_WRITE_LIMITS;

const MEMBER_WRITE_OPERATIONS = new Set<PartnersMemberWriteOperation>(
  Object.keys(MEMBER_WRITE_LIMITS) as PartnersMemberWriteOperation[],
);

const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const SUBDIVISION_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const VERSION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const DASHBOARD_CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const PUBLIC_LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ACCESS_CREDIT_QUOTE_KEY_PATTERN = /^crq_[0-9a-f]{24}$/;
const ACCESS_CREDIT_REDEMPTION_KEY_PATTERN = /^crd_[0-9a-f]{24}$/;
const ACCESS_GRANT_KEY_PATTERN = /^cag_[0-9a-f]{24}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_PARTNERS_ALLOWED_ORIGINS];

  const candidates = raw.split(",").map((value) => value.trim());
  if (
    candidates.length === 0 ||
    candidates.length > 20 ||
    candidates.some((value) => !value)
  ) {
    throw new Error("Invalid NORVA_PARTNERS_ALLOWED_ORIGINS");
  }

  const normalized: string[] = [];
  for (const candidate of candidates) {
    if (candidate === "*" || !isExactHttpOrigin(candidate)) {
      throw new Error("Invalid NORVA_PARTNERS_ALLOWED_ORIGINS");
    }
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  return normalized;
}

export function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": PARTNERS_ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After, X-Correlation-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function assertAllowedOrigin(
  origin: string | null,
  allowedOrigins: readonly string[],
): void {
  // Native Android and server-to-server requests do not carry Origin. When it
  // is present, it must be an exact allowlist match.
  if (origin !== null && !allowedOrigins.includes(origin)) {
    throw new PublicApiError(
      403,
      "cors_origin_denied",
      "This origin is not allowed.",
    );
  }
}

export function assertValidPreflight(
  origin: string | null,
  requestedMethod: string | null,
  requestedHeaders: string | null,
  allowedOrigins: readonly string[],
  allowedMethods: readonly string[] = ["GET"],
): void {
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new PublicApiError(
      403,
      "cors_origin_denied",
      "This origin is not allowed.",
    );
  }
  const method = (requestedMethod ?? "").toUpperCase();
  if (!allowedMethods.includes(method)) {
    throw new PublicApiError(
      403,
      "cors_preflight_denied",
      "This CORS preflight is not allowed.",
    );
  }

  const requested = (requestedHeaders ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    requested.length > PARTNERS_ALLOWED_REQUEST_HEADERS.length ||
    requested.some((value) => !PARTNERS_ALLOWED_REQUEST_HEADERS.includes(value))
  ) {
    throw new PublicApiError(
      403,
      "cors_preflight_denied",
      "This CORS preflight is not allowed.",
    );
  }
}

export function allowedMethodsForRoute(
  route: string,
): readonly string[] | null {
  if (
    route === "/bootstrap" ||
    route === "/dashboard" ||
    route === "/kyc/rights" ||
    route === "/credit/status"
  ) return ["GET"];
  if (
    route === "/access-request" ||
    route === "/fiscal-profile" ||
    route === "/payout-onboarding"
  ) return ["GET", "POST"];
  if (route === "/payout-profile") return ["GET"];
  if (
    route === "/applications" ||
    route === "/join" ||
    route === "/credit/quotes" ||
    route === "/credit/redemptions" ||
    route === "/payout-country" ||
    route === "/activate" ||
    route === "/activation/reconcile" ||
    route === "/links" ||
    route === "/kyc/consent/withdraw" ||
    route === "/kyc/reviews" ||
    route === "/kyc/sessions" ||
    route === "/kyc/certification" ||
    route === "/kyc/certification/resume" ||
    route === "/referral/claim" ||
    route === "/tv-relays/consume"
  ) {
    return ["POST"];
  }
  return null;
}

export function routeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("norva-partners");
  if (marker >= 0) return `/${parts.slice(marker + 1).join("/")}`;
  if (parts.length === 1) return `/${parts[0]}`;
  return `/${parts.join("/")}`;
}

export function parseBootstrapQuery(url: URL): BootstrapQuery {
  const allowed = new Set(["countryCode", "subdivisionCode"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw invalidQuery();
    }
  }

  const countryCode = normalizeOptionalCode(
    url.searchParams.get("countryCode"),
    COUNTRY_PATTERN,
    2,
  );
  const subdivisionCode = normalizeOptionalCode(
    url.searchParams.get("subdivisionCode"),
    SUBDIVISION_PATTERN,
    12,
  );

  if (subdivisionCode && !countryCode) {
    throw invalidQuery();
  }
  if (
    countryCode &&
    subdivisionCode?.includes("-") &&
    subdivisionCode.split("-")[0] !== countryCode
  ) {
    throw invalidQuery();
  }

  return { countryCode, subdivisionCode };
}

export function assertNoQueryParameters(url: URL): void {
  if (url.searchParams.size !== 0) throw invalidQuery();
}

export function parseApplicationInput(raw: unknown): ApplicationInput {
  const body = boundedRecord(
    raw,
    ["accountType", "countryCode"],
    ["subdivisionCode"],
  );
  if (body.accountType === "business") {
    throw new PublicApiError(
      422,
      "business_accounts_not_supported",
      "Business accounts are not supported in this release.",
      "business_waitlist",
    );
  }
  if (body.accountType !== "individual") {
    throw invalidRequest();
  }
  const countryCode = normalizeRequiredCode(
    body.countryCode,
    COUNTRY_PATTERN,
    2,
  );
  const subdivisionCode = normalizeNullableCode(
    body.subdivisionCode,
    SUBDIVISION_PATTERN,
    12,
  );
  if (
    subdivisionCode?.includes("-") &&
    subdivisionCode.split("-")[0] !== countryCode
  ) {
    throw invalidRequest();
  }
  return {
    accountType: "individual",
    countryCode,
    subdivisionCode,
  };
}

export function parseAccessRequestInput(raw: unknown): AccessRequestInput {
  const body = boundedRecord(raw, ["countryCode"], ["subdivisionCode"]);
  const countryCode = normalizeRequiredCode(
    body.countryCode,
    COUNTRY_PATTERN,
    2,
  );
  const subdivisionCode = normalizeNullableCode(
    body.subdivisionCode,
    SUBDIVISION_PATTERN,
    12,
  );
  if (
    subdivisionCode?.includes("-") &&
    subdivisionCode.split("-")[0] !== countryCode
  ) {
    throw invalidRequest();
  }
  return { countryCode, subdivisionCode };
}

export function parseFiscalProfileInput(raw: unknown): FiscalProfileInput {
  const body = boundedRecord(raw, [
    "countryCode",
    "declarationAccepted",
    "declarationVersion",
  ], []);
  const countryCode = normalizeRequiredCode(
    body.countryCode,
    COUNTRY_PATTERN,
    2,
  );
  if (
    body.declarationAccepted !== true ||
    body.declarationVersion !== "partners-tax-self-certification-v1"
  ) {
    throw invalidRequest();
  }
  return {
    countryCode,
    declarationAccepted: true,
    declarationVersion: "partners-tax-self-certification-v1",
  };
}

export function parsePayoutOnboardingInput(
  raw: unknown,
): PayoutOnboardingInput {
  const body = boundedRecord(raw, ["currency", "contactConsent"], []);
  const currency = normalizeRequiredCode(
    body.currency,
    CURRENCY_PATTERN,
    3,
  );
  if (body.contactConsent !== true) throw invalidRequest();
  return { currency, contactConsent: true };
}

export function parseAcceptTermsInput(raw: unknown): AcceptTermsInput {
  const body = boundedRecord(
    raw,
    ["termsVersion", "disclosureVersion"],
    [],
  );
  return {
    termsVersion: requestPatternString(
      body.termsVersion,
      VERSION_KEY_PATTERN,
      64,
    ),
    disclosureVersion: requestPatternString(
      body.disclosureVersion,
      VERSION_KEY_PATTERN,
      64,
    ),
  };
}

export function parseJoinInput(raw: unknown): JoinInput {
  const body = boundedRecord(raw, [
    "termsAccepted",
    "disclosureAccepted",
  ], []);
  if (
    body.termsAccepted !== true ||
    body.disclosureAccepted !== true
  ) throw invalidRequest();
  return { termsAccepted: true, disclosureAccepted: true };
}

export function parseAccessCreditQuoteInput(
  raw: unknown,
): AccessCreditQuoteInput {
  const body = boundedRecord(raw, ["months"], []);
  if (
    typeof body.months !== "number" ||
    !Number.isSafeInteger(body.months) ||
    body.months < 1 ||
    body.months > 12
  ) throw invalidRequest();
  return { months: body.months };
}

export function parseAccessCreditRedemptionInput(
  raw: unknown,
): AccessCreditRedemptionInput {
  const body = boundedRecord(raw, ["quoteKey"], []);
  if (
    typeof body.quoteKey !== "string" ||
    !ACCESS_CREDIT_QUOTE_KEY_PATTERN.test(body.quoteKey)
  ) throw invalidRequest();
  return { quoteKey: body.quoteKey };
}

export function parsePayoutCountryInput(raw: unknown): PayoutCountryInput {
  const body = boundedRecord(raw, ["countryCode"], []);
  return {
    countryCode: normalizeRequiredCode(
      body.countryCode,
      COUNTRY_PATTERN,
      2,
    ),
  };
}

export function parseEmptyMutationInput(raw: unknown): Record<string, never> {
  if (!isRecord(raw) || Object.keys(raw).length !== 0) throw invalidRequest();
  return {};
}

export function parseKycHumanReviewInput(
  raw: unknown,
): KycHumanReviewInput {
  const body = boundedRecord(raw, ["reason"], []);
  if (
    typeof body.reason !== "string" ||
    !KYC_HUMAN_REVIEW_REASONS.has(body.reason)
  ) {
    throw invalidRequest();
  }
  return { reason: body.reason as KycHumanReviewInput["reason"] };
}

export function parseIdempotencyKey(value: string | null): string {
  if (!value) {
    throw new PublicApiError(
      400,
      "idempotency_key_required",
      "An idempotency key is required.",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw invalidRequest();
  return value;
}

export function parseDashboardQuery(url: URL): DashboardQuery {
  const allowed = new Set(["limit", "cursor", "status"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw invalidQuery();
    }
  }

  const rawLimit = url.searchParams.get("limit");
  const historyLimit = rawLimit === null ? 25 : Number(rawLimit);
  if (
    (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) ||
    !Number.isSafeInteger(historyLimit) ||
    historyLimit < 1 ||
    historyLimit > 50
  ) {
    throw invalidQuery();
  }

  const rawCursor = url.searchParams.get("cursor");
  const historyCursor = rawCursor === null ? null : requestPatternString(
    rawCursor,
    DASHBOARD_CURSOR_PATTERN,
    256,
    invalidQuery,
  );
  const historyStatus = url.searchParams.get("status") ?? "all";
  if (!DASHBOARD_HISTORY_STATUSES.has(historyStatus)) throw invalidQuery();

  return { historyLimit, historyCursor, historyStatus };
}

export function parseBearerToken(header: string | null): string {
  if (!header) {
    throw new PublicApiError(
      401,
      "authentication_required",
      "Authentication is required.",
    );
  }
  const match = header.match(/^Bearer ([^\s,]+)$/);
  if (!match || match[1].length < 16 || match[1].length > 8192) {
    throw new PublicApiError(
      401,
      "invalid_access_token",
      "The access token is invalid.",
    );
  }
  return match[1];
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function sanitizeBootstrapData(
  raw: unknown,
  expected: BootstrapQuery,
): Record<string, unknown> {
  if (isRecord(raw) && raw.schema_version === 2) {
    return sanitizeBootstrapV2Data(raw);
  }
  return sanitizeBootstrapV1Data(raw, expected);
}

function sanitizeBootstrapV1Data(
  raw: unknown,
  expected: BootstrapQuery,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "flags",
    "visibility",
    "eligibility",
    "program",
    "policy",
    "allowlist",
    "account",
  ]);
  if (root.schema_version !== 1) throw new BootstrapContractError();

  const flags = exactRecord(root.flags, [
    "partners_enabled",
    "partners_invite_only",
    "partners_shadow_mode",
    "partners_payouts_live",
    "partners_tv_relay_enabled",
  ]);
  const cleanFlags = {
    partners_enabled: strictBoolean(flags.partners_enabled),
    partners_invite_only: strictBoolean(flags.partners_invite_only),
    partners_shadow_mode: strictBoolean(flags.partners_shadow_mode),
    partners_payouts_live: strictBoolean(flags.partners_payouts_live),
    partners_tv_relay_enabled: strictBoolean(flags.partners_tv_relay_enabled),
  };

  const visibility = exactRecord(root.visibility, ["visible", "reason"]);
  const cleanVisibility = {
    visible: strictBoolean(visibility.visible),
    reason: enumString(visibility.reason, VISIBILITY_REASONS),
  };
  const reasonImpliesVisible = cleanVisibility.reason === "available" ||
    cleanVisibility.reason === "existing_account";
  if (cleanVisibility.visible !== reasonImpliesVisible) {
    throw new BootstrapContractError();
  }

  const eligibility = exactRecord(root.eligibility, ["eligible", "reason"]);
  const cleanEligibility = {
    eligible: strictBoolean(eligibility.eligible),
    reason: enumString(eligibility.reason, ELIGIBILITY_REASONS),
  };
  if (cleanEligibility.eligible !== (cleanEligibility.reason === "eligible")) {
    throw new BootstrapContractError();
  }

  const account = sanitizeAccount(root.account);
  if (
    (cleanVisibility.reason === "existing_account") !== account.exists
  ) {
    throw new BootstrapContractError();
  }
  if (
    (
      cleanEligibility.reason === "account_attention_required" ||
      cleanEligibility.reason === "account_blocked"
    ) &&
    !account.exists
  ) {
    throw new BootstrapContractError();
  }
  const program = sanitizeProgram(root.program);
  // For an existing account the RPC deliberately uses the stored jurisdiction
  // instead of a caller-supplied locale. Only discovery requests must echo the
  // requested jurisdiction.
  const policy = sanitizePolicy(
    root.policy,
    account.exists === true
      ? { countryCode: null, subdivisionCode: null }
      : expected,
  );

  if (program && policy) {
    const thresholds = program.payout_thresholds as Record<string, number>;
    const settlementCurrencies = policy.payout_currencies as string[];
    if (
      settlementCurrencies.some((currency) =>
        thresholds[currency] === undefined
      )
    ) {
      throw new BootstrapContractError();
    }
  }

  const allowlist = exactRecord(root.allowlist, ["required", "included"]);
  const cleanAllowlist = {
    required: strictBoolean(allowlist.required),
    included: strictBoolean(allowlist.included),
  };

  if (cleanAllowlist.required !== cleanFlags.partners_invite_only) {
    throw new BootstrapContractError();
  }
  if (
    cleanVisibility.reason === "available" &&
    !cleanFlags.partners_enabled
  ) {
    throw new BootstrapContractError();
  }
  if (
    account.link_status === "active" &&
    (
      account.status !== "active" ||
      account.verification_status !== "verified" ||
      account.contract_status !== "accepted"
    )
  ) {
    throw new BootstrapContractError();
  }

  if (cleanEligibility.eligible) {
    if (!program || !policy) throw new BootstrapContractError();
    if (
      !cleanFlags.partners_enabled ||
      !cleanVisibility.visible ||
      !policy.individual_available ||
      (cleanAllowlist.required && !cleanAllowlist.included)
    ) {
      throw new BootstrapContractError();
    }
  }

  return {
    schema_version: 1,
    flags: cleanFlags,
    visibility: cleanVisibility,
    eligibility: cleanEligibility,
    program,
    policy,
    allowlist: cleanAllowlist,
    account,
  };
}

function sanitizeBootstrapV2Data(raw: unknown): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "flags",
    "eligibility",
    "membership",
    "program",
    "link",
    "credit_readiness",
    "cash_readiness",
  ]);
  if (root.schema_version !== 2) throw new BootstrapContractError();
  const flags = sanitizePartnersV2Flags(root.flags);
  const membership = sanitizeV2Membership(root.membership);
  const eligibility = exactRecord(root.eligibility, [
    "visible",
    "eligible",
    "reason",
  ]);
  const visible = strictBoolean(eligibility.visible);
  const eligible = strictBoolean(eligibility.eligible);
  const reason = enumString(eligibility.reason, new Set([
    "email_unconfirmed",
    "account_blocked",
    "disabled",
    "program_unavailable",
    "available",
  ]));
  const program = root.program === null
    ? null
    : sanitizeV2Program(root.program);
  const link = root.link === null
    ? null
    : sanitizeMemberLink(root.link, "created_at");
  const creditReadiness = sanitizeCreditReadiness(
    root.credit_readiness,
    null,
  );
  const cashReadiness = sanitizeCashReadiness(root.cash_readiness);
  if (
    visible !== (flags.partners_enabled || membership.exists) ||
    eligible !== (reason === "available") ||
    (eligible && (!visible || !flags.partners_enabled || program === null)) ||
    (reason === "account_blocked" &&
      !["held", "suspended", "closed"].includes(String(membership.status))) ||
    (link !== null && membership.status !== "active") ||
    (cashReadiness.reason === "cash_pilot_not_allowed" &&
      (!flags.partners_cash_pilot_allowlist_only ||
        membership.status !== "active")) ||
    (creditReadiness.ready !==
      (membership.status === "active" &&
        flags.partners_credit_redemptions_enabled)) ||
    creditReadiness.reason === "catalog_unavailable"
  ) throw new BootstrapContractError();

  return {
    schema_version: 2,
    flags,
    eligibility: { visible, eligible, reason },
    membership,
    program,
    link,
    credit_readiness: creditReadiness,
    cash_readiness: cashReadiness,
  };
}

function sanitizeAccessRequestState(
  raw: unknown,
): Record<string, unknown> {
  const request = exactRecord(raw, [
    "exists",
    "status",
    "country_code",
    "subdivision_code",
    "requested_at",
    "reviewed_at",
  ]);
  const exists = strictBoolean(request.exists);
  if (!exists) {
    if (
      request.status !== null ||
      request.country_code !== null ||
      request.subdivision_code !== null ||
      request.requested_at !== null ||
      request.reviewed_at !== null
    ) {
      throw new BootstrapContractError();
    }
    return {
      exists: false,
      status: null,
      country_code: null,
      subdivision_code: null,
      requested_at: null,
      reviewed_at: null,
    };
  }

  const status = enumString(request.status, ACCESS_REQUEST_STATUSES);
  const reviewedAt = isoTimestamp(request.reviewed_at, true);
  if (
    (status === "requested" && reviewedAt !== null) ||
    (status !== "requested" && reviewedAt === null)
  ) {
    throw new BootstrapContractError();
  }
  return {
    exists: true,
    status,
    country_code: patternString(request.country_code, COUNTRY_PATTERN, 2),
    subdivision_code: request.subdivision_code === null ? null : patternString(
      request.subdivision_code,
      SUBDIVISION_PATTERN,
      12,
    ),
    requested_at: isoTimestamp(request.requested_at, false),
    reviewed_at: reviewedAt,
  };
}

function sanitizeAccessProgramPreview(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw === null) return null;
  const preview = exactRecord(raw, [
    "commission_rate_bps",
    "attribution_window_days",
    "maturation_days",
    "payout_thresholds",
  ]);
  if (
    preview.commission_rate_bps !== 2_000 ||
    preview.attribution_window_days !== 30 ||
    preview.maturation_days !== 45
  ) {
    throw new BootstrapContractError();
  }
  return {
    commission_rate_bps: 2_000,
    attribution_window_days: 30,
    maturation_days: 45,
    payout_thresholds: sanitizeThresholds(preview.payout_thresholds),
  };
}

export function sanitizeAccessRequestData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "program_preview",
    "request",
  ]);
  if (root.schema_version !== 1) throw new BootstrapContractError();
  return {
    schema_version: 1,
    program_preview: sanitizeAccessProgramPreview(root.program_preview),
    request: sanitizeAccessRequestState(root.request),
  };
}

export function sanitizeAccessRequestMutationData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "program_preview",
    "request",
    "next_action",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "access_requested"
  ) {
    throw new BootstrapContractError();
  }
  const request = sanitizeAccessRequestState(root.request);
  if (request.exists !== true) throw new BootstrapContractError();
  const nextAction = enumString(
    root.next_action,
    ACCESS_REQUEST_NEXT_ACTIONS,
  );
  const expectedNextAction = request.status === "requested"
    ? "await_review"
    : request.status === "approved"
    ? "access_approved"
    : "contact_support";
  if (nextAction !== expectedNextAction) throw new BootstrapContractError();
  return {
    schema_version: 1,
    action: "access_requested",
    replayed: strictBoolean(root.replayed),
    program_preview: sanitizeAccessProgramPreview(root.program_preview),
    request,
    next_action: nextAction,
  };
}

function sanitizeFiscalProfileState(raw: unknown): Record<string, unknown> {
  const profile = exactRecord(raw, [
    "exists",
    "status",
    "country_code",
    "declaration_version",
    "submitted_at",
    "reviewed_at",
  ]);
  const exists = strictBoolean(profile.exists);
  const status = enumString(profile.status, FISCAL_PROFILE_STATUSES);
  if (!exists) {
    if (
      status !== "missing" ||
      profile.country_code !== null ||
      profile.declaration_version !== null ||
      profile.submitted_at !== null ||
      profile.reviewed_at !== null
    ) {
      throw new BootstrapContractError();
    }
    return {
      exists: false,
      status: "missing",
      country_code: null,
      declaration_version: null,
      submitted_at: null,
      reviewed_at: null,
    };
  }
  if (status === "missing") throw new BootstrapContractError();
  const countryCode = contractPatternString(
    profile.country_code,
    COUNTRY_PATTERN,
    2,
  );
  // Upgrade recovery is intentionally explicit: a legacy profile whose
  // consent was never recorded may only surface as expired with no synthetic
  // declaration/timestamp. POST self-attestation moves it back to pending.
  if (
    status === "expired" &&
    profile.declaration_version === null &&
    profile.submitted_at === null
  ) {
    return {
      exists: true,
      status: "expired",
      country_code: countryCode,
      declaration_version: null,
      submitted_at: null,
      reviewed_at: isoTimestamp(profile.reviewed_at, true),
    };
  }
  const declarationVersion = contractPatternString(
    profile.declaration_version,
    VERSION_KEY_PATTERN,
    64,
  );
  const submittedAt = isoTimestamp(profile.submitted_at, false);
  if (declarationVersion !== "partners-tax-self-certification-v1") {
    throw new BootstrapContractError();
  }
  const reviewedAt = isoTimestamp(profile.reviewed_at, true);
  if (
    (status === "pending" && reviewedAt !== null) ||
    (status !== "pending" && reviewedAt === null)
  ) throw new BootstrapContractError();
  return {
    exists: true,
    status,
    country_code: countryCode,
    declaration_version: declarationVersion,
    submitted_at: submittedAt,
    reviewed_at: reviewedAt,
  };
}

export function sanitizeFiscalProfileGet(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "fiscal_profile",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "fiscal_profile_loaded"
  ) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: "fiscal_profile_loaded",
    fiscal_profile: sanitizeFiscalProfileState(root.fiscal_profile),
  };
}

export function sanitizeFiscalProfileMutation(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "fiscal_profile",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "fiscal_profile_submitted"
  ) {
    throw new BootstrapContractError();
  }
  const fiscalProfile = sanitizeFiscalProfileState(root.fiscal_profile);
  if (
    fiscalProfile.exists !== true ||
    fiscalProfile.status !== "pending" ||
    fiscalProfile.declaration_version !==
      "partners-tax-self-certification-v1" ||
    fiscalProfile.submitted_at === null ||
    fiscalProfile.reviewed_at !== null
  ) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: "fiscal_profile_submitted",
    replayed: strictBoolean(root.replayed),
    fiscal_profile: fiscalProfile,
  };
}

export async function partnersMemberWriteRequestHash(
  operation: PartnersMemberWriteOperation,
  normalizedFields: readonly string[],
): Promise<string> {
  if (
    !MEMBER_WRITE_OPERATIONS.has(operation) ||
    normalizedFields.length === 0 ||
    normalizedFields.length > 8 ||
    normalizedFields.some((field) => (
      typeof field !== "string" || field.length === 0 || field.length > 64
    ))
  ) {
    throw new PublicApiError(
      400,
      "invalid_request",
      "The request payload is invalid.",
    );
  }
  const canonical = JSON.stringify([
    "norva-partners-member-write:v1",
    operation,
    ...normalizedFields,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

export function sanitizeMemberWriteReservation(
  raw: unknown,
  expectedOperation: PartnersMemberWriteOperation,
): Record<string, unknown> {
  if (!MEMBER_WRITE_OPERATIONS.has(expectedOperation)) {
    throw new BootstrapContractError();
  }
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "operation",
    "replayed",
    "limit",
    "used",
    "remaining",
    "window_seconds",
  ]);
  const expectedLimit = MEMBER_WRITE_LIMITS[expectedOperation];
  const limit = integerBetween(root.limit, expectedLimit, expectedLimit);
  const used = integerBetween(root.used, 0, limit);
  const remaining = integerBetween(root.remaining, 0, limit);
  if (
    root.schema_version !== 1 ||
    root.action !== "member_write_reserved" ||
    root.operation !== expectedOperation ||
    root.window_seconds !== 86_400 ||
    remaining !== limit - used
  ) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: "member_write_reserved",
    operation: expectedOperation,
    replayed: strictBoolean(root.replayed),
    limit,
    used,
    remaining,
    window_seconds: 86_400,
  };
}

function sanitizePayoutOnboardingState(
  raw: unknown,
): Record<string, unknown> {
  const request = exactRecord(raw, [
    "exists",
    "status",
    "currency",
    "execution_adapter",
    "reconfiguration_required",
    "requested_at",
    "updated_at",
    "reason_code",
  ]);
  const exists = strictBoolean(request.exists);
  const status = enumString(request.status, PAYOUT_ONBOARDING_STATUSES);
  const reconfigurationRequired = strictBoolean(
    request.reconfiguration_required,
  );
  if (request.execution_adapter !== "revolut_manual") {
    throw new BootstrapContractError();
  }
  if (!exists) {
    if (
      status !== "not_started" ||
      request.currency !== null ||
      reconfigurationRequired ||
      request.requested_at !== null ||
      request.updated_at !== null ||
      request.reason_code !== null
    ) {
      throw new BootstrapContractError();
    }
    return {
      exists: false,
      status: "not_started",
      currency: null,
      execution_adapter: "revolut_manual",
      reconfiguration_required: false,
      requested_at: null,
      updated_at: null,
      reason_code: null,
    };
  }
  if (status === "not_started") throw new BootstrapContractError();
  if (reconfigurationRequired && status !== "completed") {
    throw new BootstrapContractError();
  }
  const reasonCode = request.reason_code === null
    ? null
    : enumString(request.reason_code, PAYOUT_ONBOARDING_REASON_CODES);
  if ((status === "rejected") !== (reasonCode !== null)) {
    throw new BootstrapContractError();
  }
  const requestedAt = isoTimestamp(request.requested_at, false);
  const updatedAt = isoTimestamp(request.updated_at, false);
  if (requestedAt === null || updatedAt === null) {
    throw new BootstrapContractError();
  }
  if (Date.parse(updatedAt) < Date.parse(requestedAt)) {
    throw new BootstrapContractError();
  }
  return {
    exists: true,
    status,
    currency: contractPatternString(
      request.currency,
      CURRENCY_PATTERN,
      3,
    ),
    execution_adapter: "revolut_manual",
    reconfiguration_required: reconfigurationRequired,
    requested_at: requestedAt,
    updated_at: updatedAt,
    reason_code: reasonCode,
  };
}

function sanitizeAllowedCurrencies(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 32) {
    throw new BootstrapContractError();
  }
  const currencies = raw.map((currency) =>
    contractPatternString(currency, CURRENCY_PATTERN, 3)
  );
  if (
    new Set(currencies).size !== currencies.length ||
    currencies.some((currency, index) => (
      index > 0 && currencies[index - 1].localeCompare(currency) >= 0
    ))
  ) {
    throw new BootstrapContractError();
  }
  return currencies;
}

export function sanitizePayoutOnboardingGet(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "payout_onboarding",
    "allowed_currencies",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "payout_onboarding_loaded"
  ) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: "payout_onboarding_loaded",
    payout_onboarding: sanitizePayoutOnboardingState(
      root.payout_onboarding,
    ),
    allowed_currencies: sanitizeAllowedCurrencies(root.allowed_currencies),
  };
}

export function sanitizePayoutOnboardingMutation(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "payout_onboarding",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "payout_onboarding_requested"
  ) {
    throw new BootstrapContractError();
  }
  const payoutOnboarding = sanitizePayoutOnboardingState(
    root.payout_onboarding,
  );
  if (payoutOnboarding.exists !== true) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: "payout_onboarding_requested",
    replayed: strictBoolean(root.replayed),
    payout_onboarding: payoutOnboarding,
  };
}

export function sanitizeKycRightsData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "consent",
    "review",
    "actions",
  ]);
  if (root.schema_version !== 1) throw new BootstrapContractError();

  const consent = exactRecord(root.consent, [
    "status",
    "version",
    "granted_at",
    "withdrawn_at",
  ]);
  const consentStatus = enumString(
    consent.status,
    KYC_CONSENT_STATUSES,
  );
  if (consent.version !== "partners-biometric-consent-v1") {
    throw new BootstrapContractError();
  }
  const grantedAt = isoTimestamp(consent.granted_at, true);
  const withdrawnAt = isoTimestamp(consent.withdrawn_at, true);
  if (
    ((consentStatus === "not_available" || consentStatus === "not_granted") &&
      (grantedAt !== null || withdrawnAt !== null)) ||
    (consentStatus === "granted" &&
      (grantedAt === null || withdrawnAt !== null)) ||
    (consentStatus === "withdrawn" &&
      (grantedAt === null || withdrawnAt === null))
  ) {
    throw new BootstrapContractError();
  }

  const review = exactRecord(root.review, [
    "exists",
    "key",
    "status",
    "reason",
    "resolution",
    "requested_at",
    "updated_at",
    "resolved_at",
  ]);
  const reviewExists = strictBoolean(review.exists);
  const reviewStatus = enumString(review.status, KYC_HUMAN_REVIEW_STATUSES);
  const requestedAt = isoTimestamp(review.requested_at, true);
  const updatedAt = isoTimestamp(review.updated_at, true);
  const resolvedAt = isoTimestamp(review.resolved_at, true);
  if (!reviewExists) {
    if (
      review.key !== null ||
      reviewStatus !== "none" ||
      review.reason !== null ||
      review.resolution !== null ||
      requestedAt !== null ||
      updatedAt !== null ||
      resolvedAt !== null
    ) {
      throw new BootstrapContractError();
    }
  } else {
    patternString(review.key, KYC_HUMAN_REVIEW_KEY_PATTERN, 28);
    enumString(review.reason, KYC_HUMAN_REVIEW_REASONS);
    if (
      reviewStatus === "none" ||
      requestedAt === null ||
      updatedAt === null ||
      (reviewStatus === "resolved"
        ? (resolvedAt === null ||
          typeof review.resolution !== "string" ||
          !KYC_HUMAN_REVIEW_RESOLUTIONS.has(review.resolution))
        : (resolvedAt !== null || review.resolution !== null))
    ) {
      throw new BootstrapContractError();
    }
  }

  const actions = exactRecord(root.actions, [
    "can_withdraw",
    "can_request_human_review",
  ]);
  const canWithdraw = strictBoolean(actions.can_withdraw);
  const canRequestHumanReview = strictBoolean(
    actions.can_request_human_review,
  );
  if (
    canWithdraw !== (consentStatus === "granted") ||
    (canRequestHumanReview &&
      reviewExists &&
      (reviewStatus === "requested" || reviewStatus === "in_review"))
  ) {
    throw new BootstrapContractError();
  }

  return {
    schema_version: 1,
    consent: {
      status: consentStatus,
      version: "partners-biometric-consent-v1",
      granted_at: grantedAt,
      withdrawn_at: withdrawnAt,
    },
    review: {
      exists: reviewExists,
      key: reviewExists ? review.key : null,
      status: reviewStatus,
      reason: reviewExists ? review.reason : null,
      resolution: reviewExists ? review.resolution : null,
      requested_at: requestedAt,
      updated_at: updatedAt,
      resolved_at: resolvedAt,
    },
    actions: {
      can_withdraw: canWithdraw,
      can_request_human_review: canRequestHumanReview,
    },
  };
}

export function sanitizeKycRightsMutationData(
  raw: unknown,
  expectedAction:
    | "biometric_consent_withdrawn"
    | "kyc_human_review_requested",
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "rights",
  ]);
  if (root.schema_version !== 1 || root.action !== expectedAction) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 1,
    action: expectedAction,
    replayed: strictBoolean(root.replayed),
    rights: sanitizeKycRightsData(root.rights),
  };
}

export function sanitizeMutationData(
  raw: unknown,
  expectedAction:
    | "application_submitted"
    | "terms_accepted"
    | "link_rotated",
): Record<string, unknown> {
  const expectedKeys = expectedAction === "link_rotated"
    ? [
      "schema_version",
      "action",
      "replayed",
      "account",
      "next_action",
      "link",
    ]
    : [
      "schema_version",
      "action",
      "replayed",
      "account",
      "next_action",
    ];
  const root = exactRecord(raw, expectedKeys);
  if (
    root.schema_version !== 1 ||
    root.action !== expectedAction ||
    !MUTATION_ACTIONS.has(expectedAction)
  ) {
    throw new BootstrapContractError();
  }

  const account = sanitizeMemberAccount(root.account, false);
  const nextAction = enumString(root.next_action, NEXT_ACTIONS);
  const clean: Record<string, unknown> = {
    schema_version: 1,
    action: expectedAction,
    replayed: strictBoolean(root.replayed),
    account,
    next_action: nextAction,
  };

  if (expectedAction === "link_rotated") {
    const link = sanitizeMemberLink(root.link, "rotated_at");
    if (
      account.status !== "active" ||
      account.verification_status !== "verified" ||
      account.contract_status !== "accepted" ||
      account.link_status !== "active" ||
      nextAction !== "share_link"
    ) {
      throw new BootstrapContractError();
    }
    clean.link = link;
  }

  return clean;
}

export function sanitizeActivationReconcile(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "changed",
    "account",
    "next_action",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "activation_reconciled"
  ) {
    throw new BootstrapContractError();
  }

  const changed = strictBoolean(root.changed);
  const account = sanitizeMemberAccount(root.account, false);
  const nextAction = enumString(root.next_action, NEXT_ACTIONS);
  if (
    changed &&
    (
      account.status !== "active" ||
      account.verification_status !== "verified" ||
      account.contract_status !== "accepted" ||
      nextAction !== "share_link"
    )
  ) {
    throw new BootstrapContractError();
  }
  if (
    (account.status === "active" && nextAction !== "share_link") ||
    (account.status !== "active" && nextAction === "share_link")
  ) {
    throw new BootstrapContractError();
  }

  return {
    schema_version: 1,
    action: "activation_reconciled",
    changed,
    account,
    next_action: nextAction,
  };
}

export function sanitizeLinkMutationData(
  raw: unknown,
): Record<string, unknown> {
  if (isRecord(raw) && raw.schema_version === 1) {
    return sanitizeMutationData(raw, "link_rotated");
  }
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "membership",
    "link",
    "next_action",
  ]);
  if (
    root.schema_version !== 2 ||
    root.action !== "link_rotated" ||
    root.next_action !== "share_link"
  ) throw new BootstrapContractError();
  const membership = exactRecord(root.membership, [
    "status",
    "joined_at",
    "verification_status",
  ]);
  if (membership.status !== "active") throw new BootstrapContractError();
  return {
    schema_version: 2,
    action: "link_rotated",
    replayed: strictBoolean(root.replayed),
    membership: {
      status: "active",
      joined_at: isoTimestamp(membership.joined_at, false),
      verification_status: enumString(
        membership.verification_status,
        VERIFICATION_STATUSES,
      ),
    },
    link: sanitizeMemberLink(root.link, "rotated_at"),
    next_action: "share_link",
  };
}

export function sanitizeJoinData(raw: unknown): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "changed",
    "membership",
    "program",
    "link",
    "cash_readiness",
    "next_action",
  ]);
  if (
    root.schema_version !== 2 ||
    root.action !== "membership_joined" ||
    root.next_action !== "share_link"
  ) throw new BootstrapContractError();
  strictBoolean(root.changed);

  const membership = exactRecord(root.membership, [
    "status",
    "joined_at",
    "verification_status",
  ]);
  if (membership.status !== "active") throw new BootstrapContractError();

  const program = exactRecord(root.program, [
    "commission_rate_bps",
    "attribution_window_days",
    "maturation_days",
    "terms_version",
    "disclosure_version",
  ]);
  if (
    program.commission_rate_bps !== 2_000 ||
    program.attribution_window_days !== 30 ||
    program.maturation_days !== 45
  ) throw new BootstrapContractError();

  const cashReadiness = sanitizeCashReadiness(root.cash_readiness);
  if (cashReadiness.reason === "membership_required") {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 2,
    action: "membership_joined",
    replayed: strictBoolean(root.replayed),
    membership: {
      status: "active",
      joined_at: isoTimestamp(membership.joined_at, false),
      verification_status: enumString(
        membership.verification_status,
        VERIFICATION_STATUSES,
      ),
    },
    program: {
      commission_rate_bps: 2_000,
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: contractPatternString(
        program.terms_version,
        VERSION_KEY_PATTERN,
        64,
      ),
      disclosure_version: contractPatternString(
        program.disclosure_version,
        VERSION_KEY_PATTERN,
        64,
      ),
    },
    link: sanitizeMemberLink(root.link, "created_at"),
    cash_readiness: cashReadiness,
    next_action: "share_link",
  };
}

export function sanitizePayoutCountryMutationData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "account",
    "cash_readiness",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "payout_country_bound"
  ) throw new BootstrapContractError();
  const account = exactRecord(root.account, ["id", "status", "country_code"]);
  const status = enumString(account.status, ACCOUNT_STATUSES);
  const countryCode = patternString(account.country_code, COUNTRY_PATTERN, 2);
  const cashReadiness = sanitizeCashReadiness(root.cash_readiness);
  if (
    !["pending_verification", "active"].includes(status) ||
    !new Set([
      null,
      "kyc_required",
      "fiscal_profile_required",
      "corridor_required",
    ]).has(cashReadiness.reason as string | null) ||
    (status === "pending_verification" &&
      cashReadiness.reason !== "kyc_required") ||
    (status === "active" && cashReadiness.reason === "kyc_required")
  ) throw new BootstrapContractError();
  return {
    schema_version: 1,
    action: "payout_country_bound",
    replayed: strictBoolean(root.replayed),
    account: {
      id: contractPatternString(account.id, /^prt_[0-9a-f]{24}$/, 28),
      status,
      country_code: countryCode,
    },
    cash_readiness: cashReadiness,
  };
}

export function sanitizeAccessGrantReconciliationData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "provider",
    "overlay",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "access_grants_reconciled"
  ) throw new BootstrapContractError();
  const provider = sanitizeAccessProvider(root.provider);
  const overlay = sanitizeAccessGrantOverlay(root.overlay, provider);
  return {
    schema_version: 1,
    action: "access_grants_reconciled",
    provider,
    overlay,
  };
}

export function sanitizeAccessCreditQuoteData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "quote",
    "balance",
  ]);
  if (
    root.schema_version !== 2 ||
    root.action !== "access_credit_quoted"
  ) throw new BootstrapContractError();
  const quote = exactRecord(root.quote, [
    "key",
    "status",
    "currency",
    "currency_exponent",
    "plan_code",
    "months",
    "unit_amount_minor",
    "total_amount_minor",
    "reference_currency",
    "reference_currency_exponent",
    "reference_unit_amount_minor",
    "reference_total_amount_minor",
    "fx_rate_snapshot_key",
    "fx_rate_source",
    "fx_observed_at",
    "fx_valid_until",
    "duration_days",
    "expires_at",
  ]);
  const months = integerBetween(quote.months, 1, 12);
  const unitAmount = integerBetween(
    quote.unit_amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const totalAmount = integerBetween(
    quote.total_amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const currency = contractPatternString(quote.currency, CURRENCY_PATTERN, 3);
  const currencyExponent = integerBetween(quote.currency_exponent, 0, 6);
  const referenceTotal = integerBetween(
    quote.reference_total_amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const fx = sanitizeAccessCreditFxEvidence(quote, currency);
  if (
    quote.status !== "open" ||
    quote.plan_code !== "plus" ||
    quote.reference_currency !== "USD" ||
    quote.reference_currency_exponent !== 2 ||
    quote.reference_unit_amount_minor !== 499 ||
    referenceTotal !== 499 * months ||
    quote.duration_days !== months * 30
  ) throw new BootstrapContractError();
  const balance = sanitizeAvailableBalance(root.balance);
  if (
    balance.currency !== currency ||
    balance.currency_exponent !== currencyExponent ||
    balance.available_minor < totalAmount
  ) {
    throw new BootstrapContractError();
  }
  return {
    schema_version: 2,
    action: "access_credit_quoted",
    replayed: strictBoolean(root.replayed),
    quote: {
      key: contractPatternString(
        quote.key,
        ACCESS_CREDIT_QUOTE_KEY_PATTERN,
        28,
      ),
      status: "open",
      currency,
      currency_exponent: currencyExponent,
      plan_code: "plus",
      months,
      unit_amount_minor: unitAmount,
      total_amount_minor: totalAmount,
      reference_currency: "USD",
      reference_currency_exponent: 2,
      reference_unit_amount_minor: 499,
      reference_total_amount_minor: referenceTotal,
      ...fx,
      duration_days: months * 30,
      expires_at: isoTimestamp(quote.expires_at, false),
    },
    balance,
  };
}

export function sanitizeAccessCreditRedemptionData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "redemption",
    "grant",
    "balance",
    "overlay",
  ]);
  if (
    root.schema_version !== 2 ||
    root.action !== "access_credit_redeemed"
  ) throw new BootstrapContractError();

  const redemption = exactRecord(root.redemption, [
    "key",
    "status",
    "currency",
    "currency_exponent",
    "amount_minor",
    "reference_currency",
    "reference_currency_exponent",
    "reference_amount_minor",
    "fx_rate_snapshot_key",
    "fx_rate_source",
    "fx_observed_at",
    "months",
  ]);
  const months = integerBetween(redemption.months, 1, 12);
  const amountMinor = integerBetween(
    redemption.amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const currency = contractPatternString(
    redemption.currency,
    CURRENCY_PATTERN,
    3,
  );
  const currencyExponent = integerBetween(
    redemption.currency_exponent,
    0,
    6,
  );
  const referenceAmount = integerBetween(
    redemption.reference_amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const fx = sanitizeAccessCreditFxEvidence({
    reference_currency: redemption.reference_currency,
    reference_currency_exponent: redemption.reference_currency_exponent,
    reference_unit_amount_minor: 499,
    fx_rate_snapshot_key: redemption.fx_rate_snapshot_key,
    fx_rate_source: redemption.fx_rate_source,
    fx_observed_at: redemption.fx_observed_at,
    fx_valid_until: redemption.fx_observed_at === null
      ? null
      : redemption.fx_observed_at,
  }, currency, false);
  if (
    redemption.status !== "granted" ||
    redemption.reference_currency !== "USD" ||
    redemption.reference_currency_exponent !== 2 ||
    referenceAmount !== 499 * months
  ) throw new BootstrapContractError();

  const grant = exactRecord(root.grant, [
    "key",
    "status",
    "plan_code",
    "duration_days",
    "remaining_seconds",
    "active_from",
    "active_until",
  ]);
  const grantStatus = enumString(grant.status, new Set([
    "queued",
    "active",
    "paused_provider",
  ]));
  const durationDays = integerBetween(grant.duration_days, 30, 360);
  const remainingSeconds = integerBetween(
    grant.remaining_seconds,
    1,
    durationDays * 86_400,
  );
  const activeFrom = isoTimestamp(grant.active_from, true);
  const activeUntil = isoTimestamp(grant.active_until, true);
  if (
    grant.plan_code !== "plus" ||
    durationDays !== months * 30 ||
    (grantStatus === "active"
      ? activeFrom === null || activeUntil === null ||
        Date.parse(activeUntil) <= Date.parse(activeFrom)
      : activeFrom !== null || activeUntil !== null)
  ) throw new BootstrapContractError();

  return {
    schema_version: 2,
    action: "access_credit_redeemed",
    replayed: strictBoolean(root.replayed),
    redemption: {
      key: contractPatternString(
        redemption.key,
        ACCESS_CREDIT_REDEMPTION_KEY_PATTERN,
        28,
      ),
      status: "granted",
      currency,
      currency_exponent: currencyExponent,
      amount_minor: amountMinor,
      reference_currency: "USD",
      reference_currency_exponent: 2,
      reference_amount_minor: referenceAmount,
      fx_rate_snapshot_key: fx.fx_rate_snapshot_key,
      fx_rate_source: fx.fx_rate_source,
      fx_observed_at: fx.fx_observed_at,
      months,
    },
    grant: {
      key: contractPatternString(
        grant.key,
        ACCESS_GRANT_KEY_PATTERN,
        28,
      ),
      status: grantStatus,
      plan_code: "plus",
      duration_days: durationDays,
      remaining_seconds: remainingSeconds,
      active_from: activeFrom,
      active_until: activeUntil,
    },
    balance: (() => {
      const balance = sanitizeAvailableBalance(root.balance);
      if (
        balance.currency !== currency ||
        balance.currency_exponent !== currencyExponent
      ) throw new BootstrapContractError();
      return balance;
    })(),
    overlay: sanitizeAccessGrantOverlay(root.overlay),
  };
}

export function sanitizeAccessCreditStatusData(
  raw: unknown,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "balance",
    "catalog",
    "next_maturation_at",
    "credit_readiness",
    "cash_readiness",
    "overlay",
    "provider",
  ]);
  if (
    root.schema_version !== 2 ||
    root.action !== "access_credit_status"
  ) throw new BootstrapContractError();
  const provider = sanitizeAccessProvider(root.provider);
  const catalog = root.catalog === null
    ? null
    : sanitizeAccessCreditCatalog(root.catalog);
  const creditReadiness = sanitizeCreditReadiness(
    root.credit_readiness,
    catalog !== null,
    true,
  );
  const cashReadiness = sanitizeCashReadiness(root.cash_readiness);
  return {
    schema_version: 2,
    action: "access_credit_status",
    balance: sanitizeAccessCreditBalance(root.balance),
    catalog,
    next_maturation_at: isoTimestamp(root.next_maturation_at, true),
    credit_readiness: creditReadiness,
    cash_readiness: cashReadiness,
    overlay: sanitizeAccessGrantOverlay(root.overlay, provider),
    provider,
  };
}

export function sanitizeDashboardData(
  raw: unknown,
  query: DashboardQuery,
): Record<string, unknown> {
  if (isRecord(raw) && raw.schema_version === 2) {
    return sanitizeDashboardV2Data(raw, query);
  }
  return sanitizeDashboardV1Data(raw, query);
}

function sanitizeDashboardV1Data(
  raw: unknown,
  query: DashboardQuery,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "account",
    "link",
    "reporting",
    "history",
  ]);
  if (root.schema_version !== 1) throw new BootstrapContractError();

  const account = sanitizeMemberAccount(root.account, true, false);
  const link = root.link === null
    ? null
    : sanitizeMemberLink(root.link, "created_at");
  if (
    (account.link_status === "active") !== (link !== null) ||
    (
      link !== null &&
      (
        account.status !== "active" ||
        account.verification_status !== "verified" ||
        account.contract_status !== "accepted"
      )
    )
  ) {
    throw new BootstrapContractError();
  }

  const reporting = exactRecord(root.reporting, [
    "available",
    "reason",
    "currency",
    "clicks",
    "referrals",
    "pending_minor",
    "available_minor",
    "paid_minor",
    "currencies",
  ]);
  const reportingAvailable = strictBoolean(reporting.available);
  const reportingReason = enumString(reporting.reason, REPORTING_REASONS);
  const clicks = integerBetween(reporting.clicks, 0, Number.MAX_SAFE_INTEGER);
  const referrals = integerBetween(
    reporting.referrals,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  let currency: string | null = null;
  let pendingMinor: number | null = null;
  let availableMinor: number | null = null;
  let paidMinor: number | null = null;
  if (
    !Array.isArray(reporting.currencies) || reporting.currencies.length > 32
  ) {
    throw new BootstrapContractError();
  }
  const currencyBalances = reporting.currencies.map((value) => {
    const balance = exactRecord(value, [
      "currency",
      "pending_minor",
      "available_minor",
      "paid_minor",
      "payout_destination_ready",
    ]);
    return {
      currency: contractPatternString(
        balance.currency,
        CURRENCY_PATTERN,
        3,
      ),
      pending_minor: integerBetween(
        balance.pending_minor,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      available_minor: integerBetween(
        balance.available_minor,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      paid_minor: integerBetween(
        balance.paid_minor,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      payout_destination_ready: strictBoolean(
        balance.payout_destination_ready,
      ),
    };
  });
  if (
    new Set(currencyBalances.map((balance) => balance.currency)).size !==
      currencyBalances.length
  ) {
    throw new BootstrapContractError();
  }
  if (reportingAvailable && reportingReason === "available") {
    if (currencyBalances.length !== 1) throw new BootstrapContractError();
    currency = contractPatternString(reporting.currency, CURRENCY_PATTERN, 3);
    pendingMinor = integerBetween(
      reporting.pending_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    availableMinor = integerBetween(
      reporting.available_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    paidMinor = integerBetween(
      reporting.paid_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      currencyBalances[0].currency !== currency ||
      currencyBalances[0].pending_minor !== pendingMinor ||
      currencyBalances[0].available_minor !== availableMinor ||
      currencyBalances[0].paid_minor !== paidMinor
    ) {
      throw new BootstrapContractError();
    }
  } else if (
    reportingAvailable &&
    reportingReason === "multiple_currencies"
  ) {
    if (
      currencyBalances.length < 2 ||
      reporting.currency !== null ||
      reporting.pending_minor !== null ||
      reporting.available_minor !== null ||
      reporting.paid_minor !== null
    ) {
      throw new BootstrapContractError();
    }
  } else if (
    reportingAvailable ||
    reportingReason === "available" ||
    reportingReason === "multiple_currencies" ||
    reporting.currency !== null ||
    reporting.pending_minor !== null ||
    reporting.available_minor !== null ||
    reporting.paid_minor !== null ||
    currencyBalances.length !== 0
  ) {
    throw new BootstrapContractError();
  }

  const history = exactRecord(root.history, [
    "status",
    "items",
    "next_cursor",
  ]);
  if (history.status !== query.historyStatus || !Array.isArray(history.items)) {
    throw new BootstrapContractError();
  }
  if (history.items.length > query.historyLimit) {
    throw new BootstrapContractError();
  }
  const historyItems = history.items.map((item) => {
    const row = exactRecord(item, ["type", "occurred_at"]);
    const sanitized = {
      type: enumString(row.type, ACTIVITY_TYPES),
      occurred_at: isoTimestamp(row.occurred_at, false),
    };
    const expectedType = query.historyStatus === "all"
      ? null
      : `commission_${query.historyStatus}`;
    if (expectedType !== null && sanitized.type !== expectedType) {
      throw new BootstrapContractError();
    }
    return sanitized;
  });
  const nextCursor = history.next_cursor === null
    ? null
    : contractPatternString(
      history.next_cursor,
      DASHBOARD_CURSOR_PATTERN,
      256,
    );
  if (nextCursor !== null && nextCursor === query.historyCursor) {
    throw new BootstrapContractError();
  }
  if (
    reportingReason === "no_financial_activity" &&
    (historyItems.length !== 0 || nextCursor !== null)
  ) {
    throw new BootstrapContractError();
  }

  return {
    schema_version: 1,
    account,
    link,
    reporting: {
      available: reportingAvailable,
      reason: reportingReason,
      currency,
      clicks,
      referrals,
      pending_minor: pendingMinor,
      available_minor: availableMinor,
      paid_minor: paidMinor,
      currencies: currencyBalances,
    },
    history: {
      status: query.historyStatus,
      items: historyItems,
      next_cursor: nextCursor,
    },
  };
}

function sanitizeDashboardV2Data(
  raw: unknown,
  query: DashboardQuery,
): Record<string, unknown> {
  const root = exactRecord(raw, [
    "schema_version",
    "membership",
    "link",
    "program",
    "flags",
    "balances",
    "next_maturation_at",
    "credit_readiness",
    "cash_readiness",
    "overlay",
    "provider",
    "history",
  ]);
  if (root.schema_version !== 2 || query.historyStatus === "held") {
    throw new BootstrapContractError();
  }
  const membership = sanitizeV2Membership(root.membership);
  const link = root.link === null
    ? null
    : sanitizeMemberLink(root.link, "created_at");
  const program = root.program === null
    ? null
    : sanitizeV2Program(root.program);
  const flags = sanitizePartnersV2Flags(root.flags);
  if (!Array.isArray(root.balances) || root.balances.length > 32) {
    throw new BootstrapContractError();
  }
  const balances = root.balances.map(sanitizeDashboardBalance);
  const balanceCurrencies = balances.map((balance) =>
    String(balance.currency)
  );
  if (
    new Set(balanceCurrencies).size !== balanceCurrencies.length ||
    balanceCurrencies.some((currency, index) =>
      index > 0 && balanceCurrencies[index - 1].localeCompare(currency) >= 0
    )
  ) throw new BootstrapContractError();
  const provider = sanitizeAccessProvider(root.provider);
  const overlay = sanitizeAccessGrantOverlay(root.overlay, provider);

  const credit = exactRecord(root.credit_readiness, [
    "ready",
    "reason",
    "catalog",
  ]);
  const catalog = credit.catalog === null
    ? null
    : sanitizeAccessCreditCatalog(credit.catalog);
  const creditReadiness = sanitizeCreditReadiness(
    { ready: credit.ready, reason: credit.reason },
    catalog !== null,
    true,
  );
  if (
    catalog !== null &&
    balances.some((balance) => Number(balance.available_minor) > 0) &&
    !balances.some((balance) =>
      balance.currency === catalog.currency &&
      balance.currency_exponent === catalog.currency_exponent &&
      Number(balance.available_minor) > 0
    )
  ) throw new BootstrapContractError();
  const cashReadiness = sanitizeCashReadiness(root.cash_readiness);

  const history = exactRecord(root.history, [
    "status",
    "items",
    "next_cursor",
  ]);
  if (
    history.status !== query.historyStatus ||
    !Array.isArray(history.items) ||
    history.items.length > query.historyLimit
  ) throw new BootstrapContractError();
  const historyItems = history.items.map((value) => {
    const item = exactRecord(value, [
      "key",
      "type",
      "status",
      "currency",
      "currency_exponent",
      "amount_minor",
      "occurred_at",
      "matures_at",
    ]);
    const type = enumString(item.type, DASHBOARD_V2_HISTORY_TYPES);
    const status = enumString(item.status, new Set([
      "pending",
      "available",
      "redeemed",
      "paid",
      "reversed",
    ]));
    const validTypeStatus =
      (type === "accrual" && ["pending", "available"].includes(status)) ||
      (type === "release" && status === "available") ||
      (type === "access_credit_redemption" && status === "redeemed") ||
      (["payout_settlement", "payout_late_settlement"].includes(type) &&
        status === "paid") ||
      (["reversal", "manual_reversal", "payout_return"].includes(type) &&
        status === "reversed");
    if (
      !validTypeStatus ||
      (query.historyStatus !== "all" && status !== query.historyStatus)
    ) throw new BootstrapContractError();
    return {
      key: contractPatternString(item.key, /^led_[0-9a-f]{24}$/, 28),
      type,
      status,
      currency: contractPatternString(item.currency, CURRENCY_PATTERN, 3),
      currency_exponent: integerBetween(item.currency_exponent, 0, 6),
      amount_minor: integerBetween(
        item.amount_minor,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      occurred_at: isoTimestamp(item.occurred_at, false),
      matures_at: isoTimestamp(item.matures_at, true),
    };
  });
  const nextCursor = history.next_cursor === null
    ? null
    : contractPatternString(
      history.next_cursor,
      DASHBOARD_CURSOR_PATTERN,
      256,
    );
  if (nextCursor !== null && nextCursor === query.historyCursor) {
    throw new BootstrapContractError();
  }
  const expectedCreditReason = membership.status !== "active"
    ? "membership_required"
    : !flags.partners_credit_redemptions_enabled
    ? "credits_disabled"
    : creditReadiness.reason;
  if (
    (link !== null && membership.status !== "active") ||
    (cashReadiness.reason === "cash_pilot_not_allowed" &&
      (!flags.partners_cash_pilot_allowlist_only ||
        membership.status !== "active")) ||
    creditReadiness.ready !== (expectedCreditReason === null) ||
    creditReadiness.reason !== expectedCreditReason ||
    (expectedCreditReason !== null && catalog !== null) ||
    (!membership.exists &&
      (link !== null || historyItems.length !== 0 || nextCursor !== null ||
        balances.length !== 0))
  ) throw new BootstrapContractError();

  return {
    schema_version: 2,
    membership,
    link,
    program,
    flags,
    balances,
    next_maturation_at: isoTimestamp(root.next_maturation_at, true),
    credit_readiness: { ...creditReadiness, catalog },
    cash_readiness: cashReadiness,
    overlay,
    provider,
    history: {
      status: query.historyStatus,
      items: historyItems,
      next_cursor: nextCursor,
    },
  };
}

export function mapDatabaseError(
  raw: unknown,
  requestKind: "query" | "mutation" | "guarded_action" = "query",
): Pick<PublicApiError, "status" | "code" | "message"> {
  const code = isRecord(raw) && typeof raw.code === "string" ? raw.code : "";
  const controlled: Record<
    string,
    Pick<PublicApiError, "status" | "code" | "message">
  > = {
    P1001: {
      status: 409,
      code: "membership_required",
      message: "Join Norva Partners before using access credits.",
    },
    P1002: {
      status: 409,
      code: "credits_disabled",
      message: "Partners access credits are currently unavailable.",
    },
    P1003: {
      status: 409,
      code: "quote_expired",
      message: "This access credit quote has expired. Create a new quote.",
    },
    P1004: {
      status: 409,
      code: "insufficient_balance",
      message: "Your available Partners balance is too low for this credit.",
    },
    P1005: {
      status: 503,
      code: "catalog_unavailable",
      message: "The Norva access credit catalog is temporarily unavailable.",
    },
    P1006: {
      status: 409,
      code: "quote_conflict",
      message: "This access credit quote is no longer available.",
    },
    P1008: {
      status: 503,
      code: "fx_rate_unavailable",
      message: "A current verified exchange rate is unavailable for this balance.",
    },
    P1007: {
      status: 422,
      code: "payout_country_unavailable",
      message: "Cash transfers are not available for this payout country yet.",
    },
  };
  if (Object.hasOwn(controlled, code)) return controlled[code];
  if (code === "22023") {
    return {
      status: 400,
      code: requestKind === "query" ? "invalid_query" : "invalid_request",
      message: requestKind === "query"
        ? "The request parameters are invalid."
        : "The request payload is invalid.",
    };
  }
  if (code === "P0002") {
    if (requestKind === "guarded_action") {
      return {
        status: 409,
        code: "partners_action_not_allowed",
        message: "This Partners action is not available for the account.",
      };
    }
    return {
      status: 401,
      code: "invalid_access_token",
      message: "The access token is invalid.",
    };
  }
  if (code === "P0003") {
    return {
      status: 409,
      code: "idempotency_key_reused",
      message: "This idempotency key was already used for another request.",
    };
  }
  if (code === "P0004") {
    if (requestKind === "guarded_action") {
      return {
        status: 409,
        code: "partners_action_not_allowed",
        message: "This Partners action is not available for the account.",
      };
    }
    return {
      status: 409,
      code: "request_in_progress",
      message: "This request is already in progress.",
    };
  }
  if (code === "P0008") {
    return {
      status: 429,
      code: "rate_limited",
      message: "Too many access requests were received. Try again later.",
    };
  }
  if (code === "P0001") {
    return {
      status: 409,
      code: "partners_action_not_allowed",
      message: "This Partners action is not available for the account.",
    };
  }
  if (code === "P0006") {
    return {
      status: 400,
      code: "invalid_request",
      message: "The request payload is invalid.",
    };
  }
  return {
    status: 503,
    code: "partners_temporarily_unavailable",
    message: "Norva Partners is temporarily unavailable.",
  };
}

function sanitizeCashReadiness(value: unknown): Record<string, unknown> {
  const readiness = exactRecord(value, ["ready", "reason"]);
  const ready = strictBoolean(readiness.ready);
  const reason = readiness.reason === null
    ? null
    : enumString(readiness.reason, new Set([
      "account_blocked",
      "membership_required",
      "cash_pilot_not_allowed",
      "payout_country_required",
      "kyc_required",
      "fiscal_profile_required",
      "corridor_required",
      "fiscal_or_corridor_required",
    ]));
  if ((ready && reason !== null) || (!ready && reason === null)) {
    throw new BootstrapContractError();
  }
  return { ready, reason };
}

function sanitizePartnersV2Flags(value: unknown): Record<string, boolean> {
  const flags = exactRecord(value, [
    "partners_enabled",
    "partners_invite_only",
    "partners_cash_pilot_allowlist_only",
    "partners_earnings_enabled",
    "partners_credit_redemptions_enabled",
    "partners_payouts_live",
  ]);
  return {
    partners_enabled: strictBoolean(flags.partners_enabled),
    partners_invite_only: strictBoolean(flags.partners_invite_only),
    partners_cash_pilot_allowlist_only: strictBoolean(
      flags.partners_cash_pilot_allowlist_only,
    ),
    partners_earnings_enabled: strictBoolean(
      flags.partners_earnings_enabled,
    ),
    partners_credit_redemptions_enabled: strictBoolean(
      flags.partners_credit_redemptions_enabled,
    ),
    partners_payouts_live: strictBoolean(flags.partners_payouts_live),
  };
}

function sanitizeV2Membership(value: unknown): Record<string, unknown> {
  const membership = exactRecord(value, [
    "exists",
    "status",
    "joined_at",
    "verification_status",
  ]);
  const exists = strictBoolean(membership.exists);
  const status = enumString(membership.status, MEMBERSHIP_STATUSES);
  const joinedAt = isoTimestamp(membership.joined_at, true);
  const verificationStatus = membership.verification_status === null
    ? null
    : enumString(membership.verification_status, VERIFICATION_STATUSES);
  if (
    (!exists &&
      (status !== "not_joined" || joinedAt !== null ||
        verificationStatus !== null)) ||
    (status === "active" && (!exists || joinedAt === null)) ||
    (exists && verificationStatus === null)
  ) throw new BootstrapContractError();
  return {
    exists,
    status,
    joined_at: joinedAt,
    verification_status: verificationStatus,
  };
}

function sanitizeV2Program(value: unknown): Record<string, unknown> {
  const program = exactRecord(value, [
    "commission_rate_bps",
    "attribution_window_days",
    "maturation_days",
    "terms_version",
    "disclosure_version",
  ]);
  if (
    program.commission_rate_bps !== 2_000 ||
    program.attribution_window_days !== 30 ||
    program.maturation_days !== 45
  ) throw new BootstrapContractError();
  return {
    commission_rate_bps: 2_000,
    attribution_window_days: 30,
    maturation_days: 45,
    terms_version: contractPatternString(
      program.terms_version,
      VERSION_KEY_PATTERN,
      64,
    ),
    disclosure_version: contractPatternString(
      program.disclosure_version,
      VERSION_KEY_PATTERN,
      64,
    ),
  };
}

function sanitizeAvailableBalance(value: unknown): {
  currency: string;
  currency_exponent: number;
  available_minor: number;
} {
  const balance = exactRecord(value, [
    "currency",
    "currency_exponent",
    "available_minor",
  ]);
  return {
    currency: contractPatternString(balance.currency, CURRENCY_PATTERN, 3),
    currency_exponent: integerBetween(balance.currency_exponent, 0, 6),
    available_minor: integerBetween(
      balance.available_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function sanitizeAccessCreditBalance(value: unknown): Record<string, unknown> {
  const balance = exactRecord(value, [
    "currency",
    "currency_exponent",
    "pending_minor",
    "available_minor",
    "recovery_due_minor",
    "redeemed_minor",
  ]);
  return {
    currency: contractPatternString(balance.currency, CURRENCY_PATTERN, 3),
    currency_exponent: integerBetween(balance.currency_exponent, 0, 6),
    pending_minor: integerBetween(
      balance.pending_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    available_minor: integerBetween(
      balance.available_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    recovery_due_minor: integerBetween(
      balance.recovery_due_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    redeemed_minor: integerBetween(
      balance.redeemed_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function sanitizeDashboardBalance(value: unknown): Record<string, unknown> {
  const balance = exactRecord(value, [
    "currency",
    "currency_exponent",
    "pending_minor",
    "available_minor",
    "recovery_due_minor",
    "redeemed_minor",
  ]);
  return {
    currency: contractPatternString(balance.currency, CURRENCY_PATTERN, 3),
    currency_exponent: integerBetween(balance.currency_exponent, 0, 6),
    pending_minor: integerBetween(
      balance.pending_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    available_minor: integerBetween(
      balance.available_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    recovery_due_minor: integerBetween(
      balance.recovery_due_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    redeemed_minor: integerBetween(
      balance.redeemed_minor,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function sanitizeAccessCreditCatalog(value: unknown): Record<string, unknown> {
  const catalog = exactRecord(value, [
    "catalog_key",
    "plan_code",
    "currency",
    "currency_exponent",
    "unit_amount_minor",
    "unit_duration_days",
    "minimum_months",
    "maximum_months",
    "reference_currency",
    "reference_currency_exponent",
    "reference_unit_amount_minor",
    "fx_rate_snapshot_key",
    "fx_rate_source",
    "fx_observed_at",
    "fx_valid_until",
  ]);
  const currency = contractPatternString(catalog.currency, CURRENCY_PATTERN, 3);
  const currencyExponent = integerBetween(catalog.currency_exponent, 0, 6);
  const unitAmount = integerBetween(
    catalog.unit_amount_minor,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const fx = sanitizeAccessCreditFxEvidence(catalog, currency);
  if (
    catalog.plan_code !== "plus" ||
    catalog.reference_currency !== "USD" ||
    catalog.reference_currency_exponent !== 2 ||
    catalog.reference_unit_amount_minor !== 499 ||
    catalog.unit_duration_days !== 30 ||
    catalog.minimum_months !== 1 ||
    catalog.maximum_months !== 12
  ) throw new BootstrapContractError();
  return {
    catalog_key: contractPatternString(
      catalog.catalog_key,
      /^acc_[a-z0-9][a-z0-9._-]{2,63}$/,
      68,
    ),
    plan_code: "plus",
    currency,
    currency_exponent: currencyExponent,
    unit_amount_minor: unitAmount,
    unit_duration_days: 30,
    minimum_months: 1,
    maximum_months: 12,
    reference_currency: "USD",
    reference_currency_exponent: 2,
    reference_unit_amount_minor: 499,
    ...fx,
  };
}

function sanitizeAccessCreditFxEvidence(
  value: unknown,
  sourceCurrency: string,
  requireValidUntil = true,
): Record<string, unknown> {
  if (!isRecord(value)) throw new BootstrapContractError();
  if (
    value.reference_currency !== "USD" ||
    value.reference_currency_exponent !== 2 ||
    value.reference_unit_amount_minor !== 499
  ) throw new BootstrapContractError();
  if (sourceCurrency === "USD") {
    if (
      value.fx_rate_snapshot_key !== null ||
      value.fx_rate_source !== null ||
      value.fx_observed_at !== null ||
      (requireValidUntil && value.fx_valid_until !== null)
    ) throw new BootstrapContractError();
    return {
      fx_rate_snapshot_key: null,
      fx_rate_source: null,
      fx_observed_at: null,
      ...(requireValidUntil ? { fx_valid_until: null } : {}),
    };
  }
  const observedAt = isoTimestamp(value.fx_observed_at, false);
  const validUntil = requireValidUntil
    ? isoTimestamp(value.fx_valid_until, false)
    : null;
  if (
    requireValidUntil &&
    Date.parse(String(validUntil)) <= Date.parse(String(observedAt))
  ) throw new BootstrapContractError();
  return {
    fx_rate_snapshot_key: contractPatternString(
      value.fx_rate_snapshot_key,
      /^fxr_[0-9a-f]{24}$/,
      28,
    ),
    fx_rate_source: enumString(value.fx_rate_source, new Set([
      "ecb_reference",
      "revolut_quote",
      "finance_manual",
    ])),
    fx_observed_at: observedAt,
    ...(requireValidUntil ? { fx_valid_until: validUntil } : {}),
  };
}

function sanitizeCreditReadiness(
  value: unknown,
  hasCatalog: boolean | null,
  allowCurrencyNotSupported = false,
): Record<string, unknown> {
  const readiness = exactRecord(value, ["ready", "reason"]);
  const ready = strictBoolean(readiness.ready);
  const reason = readiness.reason === null
    ? null
    : enumString(readiness.reason, new Set([
      "membership_required",
      "credits_disabled",
      "catalog_unavailable",
      ...(allowCurrencyNotSupported ? ["fx_rate_unavailable"] : []),
    ]));
  if (
    (ready && (reason !== null || hasCatalog === false)) ||
    (!ready && reason === null) ||
    (reason === "catalog_unavailable" && hasCatalog === true) ||
    (reason === "fx_rate_unavailable" && hasCatalog !== false)
  ) throw new BootstrapContractError();
  return { ready, reason };
}

function sanitizeAccessProvider(value: unknown): Record<string, unknown> {
  const provider = exactRecord(value, [
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
  ]);
  const providerName = provider.provider === null
    ? null
    : contractPatternString(
      provider.provider,
      /^[a-z][a-z0-9_]{0,63}$/,
      64,
    );
  const status = provider.status === null
    ? null
    : enumString(
      provider.status,
      new Set([
        "trialing",
        "active",
        "grace",
        "past_due",
        "cancelled_at_period_end",
        "expired",
        "revoked",
        "refunded",
        "fraud",
        "unknown",
      ]),
    );
  const active = strictBoolean(provider.active);
  const hardBlock = strictBoolean(provider.hard_block);
  const reason = enumString(provider.reason, new Set([
    "trialing",
    "active",
    "cancelled_at_period_end",
    "billing_grace",
    "billing_recently_verified",
    "trial_expired",
    "billing_unverified",
    "subscription_expired",
    "subscription_required",
    "revoked",
    "refunded",
    "fraud",
  ]));
  const failOpen = strictBoolean(provider.fail_open);
  const currentPeriodEnd = isoTimestamp(provider.current_period_end, true);
  const trialEndsAt = isoTimestamp(provider.trial_ends_at, true);
  const failOpenUntil = isoTimestamp(provider.fail_open_until, true);
  const lastVerifiedAt = isoTimestamp(provider.last_verified_at, true);
  const hardStatuses = new Set(["revoked", "refunded", "fraud"]);
  const failOpenReasons = new Set([
    "billing_grace",
    "billing_recently_verified",
  ]);
  const allowedActiveReasons: Record<string, Set<string>> = {
    trialing: new Set(["trialing"]),
    active: new Set(["active", ...failOpenReasons]),
    cancelled_at_period_end: new Set(["cancelled_at_period_end"]),
    grace: failOpenReasons,
    past_due: failOpenReasons,
    unknown: failOpenReasons,
  };
  const allowedInactiveReasons: Record<string, Set<string>> = {
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
  const trialOrPeriodEnd = trialEndsAt ?? currentPeriodEnd;
  if (
    (status === null &&
      (providerName !== null || active || hardBlock || failOpen ||
        reason !== "subscription_required" || currentPeriodEnd !== null ||
        trialEndsAt !== null || failOpenUntil !== null ||
        lastVerifiedAt !== null)) ||
    (status !== null && providerName === null) ||
    (active && hardBlock) ||
    (hardBlock && (status === null || !hardStatuses.has(status))) ||
    (hardBlock && reason !== status) ||
    (failOpen !== failOpenReasons.has(reason)) ||
    (active &&
      (status === null || !allowedActiveReasons[status]?.has(reason))) ||
    (!active && !hardBlock && status !== null &&
      !allowedInactiveReasons[status]?.has(reason)) ||
    (["trialing", "trial_expired"].includes(reason) &&
      trialOrPeriodEnd === null) ||
    (reason === "active" && currentPeriodEnd === null &&
      !providerIsPerpetual) ||
    (reason === "cancelled_at_period_end" && currentPeriodEnd === null) ||
    (reason === "billing_grace" &&
      (status === "active"
        ? failOpenUntil === null
        : currentPeriodEnd === null && failOpenUntil === null)) ||
    (reason === "billing_recently_verified" && lastVerifiedAt === null) ||
    (reason === "subscription_expired" &&
      ["active", "cancelled_at_period_end"].includes(String(status)) &&
      currentPeriodEnd === null)
  ) throw new BootstrapContractError();
  return {
    provider: providerName,
    status,
    active,
    hard_block: hardBlock,
    reason,
    fail_open: failOpen,
    current_period_end: currentPeriodEnd,
    trial_ends_at: trialEndsAt,
    fail_open_until: failOpenUntil,
    last_verified_at: lastVerifiedAt,
  };
}

function sanitizeAccessGrantOverlay(
  value: unknown,
  provider?: Record<string, unknown>,
): Record<string, unknown> {
  const overlay = exactRecord(value, [
    "status",
    "active_grant",
    "queued_grants",
    "remaining_seconds",
  ]);
  const status = enumString(overlay.status, new Set([
    "blocked_provider",
    "paused_provider",
    "active",
    "queued",
    "none",
  ]));
  const queuedGrants = integerBetween(
    overlay.queued_grants,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const remainingSeconds = integerBetween(
    overlay.remaining_seconds,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  let activeGrant: Record<string, unknown> | null = null;
  if (overlay.active_grant !== null) {
    const grant = exactRecord(overlay.active_grant, [
      "key",
      "status",
      "plan_code",
      "remaining_seconds",
      "active_from",
      "active_until",
    ]);
    const activeFrom = isoTimestamp(grant.active_from, false) as string;
    const activeUntil = isoTimestamp(grant.active_until, false) as string;
    const grantRemaining = integerBetween(
      grant.remaining_seconds,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      grant.status !== "active" ||
      !new Set(["plus", "family", "premium"]).has(String(grant.plan_code)) ||
      Date.parse(activeUntil) <= Date.parse(activeFrom)
    ) throw new BootstrapContractError();
    activeGrant = {
      key: contractPatternString(
        grant.key,
        ACCESS_GRANT_KEY_PATTERN,
        28,
      ),
      status: "active",
      plan_code: grant.plan_code,
      remaining_seconds: grantRemaining,
      active_from: activeFrom,
      active_until: activeUntil,
    };
  }

  const hasProvider = provider !== undefined;
  const providerActive = provider?.active === true;
  const providerHardBlock = provider?.hard_block === true;
  if (
    (hasProvider && status === "blocked_provider" && !providerHardBlock) ||
    (hasProvider && status === "paused_provider" &&
      (!providerActive || providerHardBlock)) ||
    (status === "active" &&
      ((hasProvider && (providerActive || providerHardBlock)) ||
        activeGrant === null ||
        remainingSeconds !== activeGrant.remaining_seconds)) ||
    (status === "queued" &&
      ((hasProvider && (providerActive || providerHardBlock)) ||
        activeGrant !== null ||
        queuedGrants < 1 || remainingSeconds !== 0)) ||
    (status === "none" &&
      ((hasProvider && (providerActive || providerHardBlock)) ||
        activeGrant !== null ||
        queuedGrants !== 0 || remainingSeconds !== 0)) ||
    (["blocked_provider", "paused_provider"].includes(status) &&
      (activeGrant !== null || remainingSeconds !== 0))
  ) throw new BootstrapContractError();

  return {
    status,
    active_grant: activeGrant,
    queued_grants: queuedGrants,
    remaining_seconds: remainingSeconds,
  };
}

function sanitizeProgram(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const program = exactRecord(value, [
    "version_key",
    "commission_rate_bps",
    "attribution_window_days",
    "maturation_days",
    "payout_thresholds",
    "effective_from",
    "effective_until",
  ]);
  const commissionRateBps = integerBetween(
    program.commission_rate_bps,
    0,
    10_000,
  );
  const attributionWindowDays = integerBetween(
    program.attribution_window_days,
    1,
    3_650,
  );
  const maturationDays = integerBetween(program.maturation_days, 0, 3_650);
  if (
    commissionRateBps !== 2_000 ||
    attributionWindowDays !== 30 ||
    maturationDays !== 45
  ) {
    throw new BootstrapContractError();
  }
  return {
    version_key: patternString(program.version_key, VERSION_KEY_PATTERN, 64),
    commission_rate_bps: commissionRateBps,
    attribution_window_days: attributionWindowDays,
    maturation_days: maturationDays,
    payout_thresholds: sanitizeThresholds(program.payout_thresholds),
    effective_from: isoTimestamp(program.effective_from, false),
    effective_until: isoTimestamp(program.effective_until, true),
  };
}

function sanitizePolicy(
  value: unknown,
  expected: BootstrapQuery,
): Record<string, unknown> | null {
  if (value === null) return null;
  const policy = exactRecord(value, [
    "country_code",
    "subdivision_code",
    "individual_available",
    "minimum_age",
    "capacity_required",
    "kyc_level",
    "payout_currencies",
    "terms_version",
    "disclosure_version",
  ]);
  const countryCode = patternString(policy.country_code, COUNTRY_PATTERN, 2);
  const subdivisionCode = policy.subdivision_code === null
    ? null
    : patternString(policy.subdivision_code, SUBDIVISION_PATTERN, 12);

  if (expected.countryCode && countryCode !== expected.countryCode) {
    throw new BootstrapContractError();
  }
  if (
    expected.subdivisionCode &&
    subdivisionCode !== null &&
    subdivisionCode !== expected.subdivisionCode
  ) {
    throw new BootstrapContractError();
  }
  const capacityRequired = strictBoolean(policy.capacity_required);
  const kycLevel = enumString(policy.kyc_level, KYC_LEVELS);
  if (
    capacityRequired &&
    kycLevel !== "identity_age_country_capacity"
  ) {
    throw new BootstrapContractError();
  }

  return {
    country_code: countryCode,
    subdivision_code: subdivisionCode,
    individual_available: strictBoolean(policy.individual_available),
    minimum_age: integerBetween(policy.minimum_age, 18, 99),
    capacity_required: capacityRequired,
    kyc_level: kycLevel,
    payout_currencies: currencyArray(policy.payout_currencies),
    terms_version: patternString(policy.terms_version, VERSION_KEY_PATTERN, 64),
    disclosure_version: patternString(
      policy.disclosure_version,
      VERSION_KEY_PATTERN,
      64,
    ),
  };
}

function sanitizeAccount(value: unknown): Record<string, unknown> {
  const account = exactRecord(value, [
    "exists",
    "status",
    "account_type",
    "verification_status",
    "contract_status",
    "link_status",
  ]);
  const exists = strictBoolean(account.exists);
  if (!exists) {
    if (
      account.status !== null ||
      account.account_type !== null ||
      account.verification_status !== null ||
      account.contract_status !== null ||
      account.link_status !== null
    ) {
      throw new BootstrapContractError();
    }
    return {
      exists: false,
      status: null,
      account_type: null,
      verification_status: null,
      contract_status: null,
      link_status: null,
    };
  }

  if (account.account_type !== "individual") {
    throw new BootstrapContractError();
  }
  return {
    exists: true,
    status: enumString(account.status, ACCOUNT_STATUSES),
    account_type: "individual",
    verification_status: enumString(
      account.verification_status,
      VERIFICATION_STATUSES,
    ),
    contract_status: enumString(account.contract_status, CONTRACT_STATUSES),
    link_status: enumString(account.link_status, LINK_STATUSES),
  };
}

function sanitizeMemberAccount(
  value: unknown,
  includeJurisdiction: boolean,
  requireExists = true,
): Record<string, unknown> {
  const keys = includeJurisdiction
    ? [
      "exists",
      "status",
      "verification_status",
      "contract_status",
      "link_status",
      "country_code",
      "subdivision_code",
      "created_at",
      "updated_at",
    ]
    : [
      "exists",
      "status",
      "verification_status",
      "contract_status",
      "link_status",
    ];
  const account = exactRecord(value, keys);
  if (account.exists !== true) {
    if (
      requireExists ||
      account.exists !== false ||
      keys
        .filter((key) => key !== "exists")
        .some((key) => account[key] !== null)
    ) {
      throw new BootstrapContractError();
    }
    return Object.fromEntries(keys.map((key) => [
      key,
      key === "exists" ? false : null,
    ]));
  }

  const clean: Record<string, unknown> = {
    exists: true,
    status: enumString(account.status, ACCOUNT_STATUSES),
    verification_status: enumString(
      account.verification_status,
      VERIFICATION_STATUSES,
    ),
    contract_status: enumString(account.contract_status, CONTRACT_STATUSES),
    link_status: enumString(account.link_status, LINK_STATUSES),
  };
  if (
    clean.link_status === "active" &&
    (
      clean.status !== "active" ||
      clean.verification_status !== "verified" ||
      clean.contract_status !== "accepted"
    )
  ) {
    throw new BootstrapContractError();
  }
  if (
    clean.status === "active" &&
    (
      clean.verification_status !== "verified" ||
      clean.contract_status !== "accepted"
    )
  ) {
    throw new BootstrapContractError();
  }

  if (includeJurisdiction) {
    clean.country_code = patternString(
      account.country_code,
      COUNTRY_PATTERN,
      2,
    );
    clean.subdivision_code = account.subdivision_code === null
      ? null
      : patternString(
        account.subdivision_code,
        SUBDIVISION_PATTERN,
        12,
      );
    clean.created_at = isoTimestamp(account.created_at, false);
    clean.updated_at = isoTimestamp(account.updated_at, false);
  }

  return clean;
}

function sanitizeMemberLink(
  value: unknown,
  dateKey: "created_at" | "rotated_at",
): Record<string, unknown> {
  const link = exactRecord(value, ["status", "share_url", dateKey]);
  if (link.status !== "active") throw new BootstrapContractError();
  return {
    status: "active",
    share_url: sanitizeShareUrl(link.share_url),
    [dateKey]: isoTimestamp(link[dateKey], false),
  };
}

function sanitizeShareUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 180) {
    throw new BootstrapContractError();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BootstrapContractError();
  }
  const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
  if (
    url.origin !== "https://norva.tv" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !PUBLIC_LINK_CODE_PATTERN.test(match[1])
  ) {
    throw new BootstrapContractError();
  }
  return url.href;
}

function sanitizeThresholds(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new BootstrapContractError();
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 32) {
    throw new BootstrapContractError();
  }
  const clean: Record<string, number> = {};
  for (const [currency, amount] of entries) {
    if (!CURRENCY_PATTERN.test(currency)) throw new BootstrapContractError();
    clean[currency] = integerBetween(amount, 1, Number.MAX_SAFE_INTEGER);
  }
  // P0 uses USD as its immutable commercial reference. Settlement still
  // remains exact in each configured currency and is never inferred by FX.
  if (clean.USD !== 1_000) throw new BootstrapContractError();
  return clean;
}

function currencyArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new BootstrapContractError();
  }
  const clean = value.map((currency) =>
    patternString(currency, CURRENCY_PATTERN, 3)
  );
  if (new Set(clean).size !== clean.length) throw new BootstrapContractError();
  return clean;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new BootstrapContractError();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new BootstrapContractError();
  }
  return value;
}

function boundedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw invalidRequest();
  }
  return value;
}

function strictBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BootstrapContractError();
  return value;
}

function enumString(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new BootstrapContractError();
  }
  return value;
}

function patternString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new BootstrapContractError();
  }
  return value;
}

function contractPatternString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new BootstrapContractError();
  }
  return value;
}

function integerBetween(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BootstrapContractError();
  }
  return value;
}

function isoTimestamp(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new BootstrapContractError();
  }
  return value;
}

function normalizeOptionalCode(
  value: string | null,
  pattern: RegExp,
  maxLength: number,
): string | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  if (
    !normalized ||
    normalized.length > maxLength ||
    !pattern.test(normalized)
  ) {
    throw invalidQuery();
  }
  return normalized;
}

function normalizeRequiredCode(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string {
  if (typeof value !== "string") throw invalidRequest();
  const normalized = value.trim().toUpperCase();
  if (
    !normalized ||
    normalized.length > maxLength ||
    !pattern.test(normalized)
  ) {
    throw invalidRequest();
  }
  return normalized;
}

function normalizeNullableCode(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeRequiredCode(value, pattern, maxLength);
}

function requestPatternString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
  errorFactory: () => PublicApiError = invalidRequest,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw errorFactory();
  }
  return value;
}

function invalidQuery(): PublicApiError {
  return new PublicApiError(
    400,
    "invalid_query",
    "The request parameters are invalid.",
  );
}

function invalidRequest(): PublicApiError {
  return new PublicApiError(
    400,
    "invalid_request",
    "The request payload is invalid.",
  );
}

function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
