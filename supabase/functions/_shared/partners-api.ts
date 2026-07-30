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
  apply: "partners_service_apply",
  acceptTerms: "partners_service_accept_terms",
  rotateLink: "partners_service_rotate_link",
  dashboard: "partners_service_dashboard",
  kycPrepare: "partners_service_kyc_prepare",
  kycSessionRecord: "partners_service_kyc_session_record",
  referralClaim: "partners_service_referral_claim",
  payoutProfileGet: "partners_service_payout_profile_get",
  payoutProfileSet: "partners_service_payout_profile_set",
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
  | "provider_not_configured"
  | "provider_temporarily_unavailable"
  | "referral_not_configured"
  | "tv_relay_not_configured"
  | "tv_relay_not_found"
  | "rate_limited"
  | "idempotency_key_required"
  | "idempotency_key_reused"
  | "request_in_progress"
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

export type AcceptTermsInput = {
  termsVersion: string;
  disclosureVersion: string;
};

export type DashboardQuery = {
  historyLimit: number;
  historyCursor: string | null;
  historyStatus: string;
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
  "paid",
  "reversed",
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
const ACTIVITY_TYPES = new Set([
  "commission_pending",
  "commission_available",
  "commission_held",
  "commission_paid",
  "commission_reversed",
]);

const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const SUBDIVISION_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const VERSION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const DASHBOARD_CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const PUBLIC_LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
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
  if (route === "/bootstrap" || route === "/dashboard") return ["GET"];
  if (route === "/payout-profile") return ["GET", "PUT"];
  if (
    route === "/applications" ||
    route === "/activate" ||
    route === "/links" ||
    route === "/kyc/sessions" ||
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

export function parseEmptyMutationInput(raw: unknown): Record<string, never> {
  if (!isRecord(raw) || Object.keys(raw).length !== 0) throw invalidRequest();
  return {};
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

export function sanitizeDashboardData(
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
  if (!Array.isArray(reporting.currencies) || reporting.currencies.length > 32) {
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
    new Set(currencyBalances.map((balance) => balance.currency)).size
      !== currencyBalances.length
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
      currencyBalances[0].currency !== currency
      || currencyBalances[0].pending_minor !== pendingMinor
      || currencyBalances[0].available_minor !== availableMinor
      || currencyBalances[0].paid_minor !== paidMinor
    ) {
      throw new BootstrapContractError();
    }
  } else if (
    reportingAvailable
    && reportingReason === "multiple_currencies"
  ) {
    if (
      currencyBalances.length < 2
      || reporting.currency !== null
      || reporting.pending_minor !== null
      || reporting.available_minor !== null
      || reporting.paid_minor !== null
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

export function mapDatabaseError(
  raw: unknown,
  requestKind: "query" | "mutation" = "query",
): Pick<PublicApiError, "status" | "code" | "message"> {
  const code = isRecord(raw) && typeof raw.code === "string" ? raw.code : "";
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
    return {
      status: 409,
      code: "request_in_progress",
      message: "This request is already in progress.",
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
