// Fail-closed Airwallex adapter for Norva Partners.
//
// Official contracts used by this module:
// - POST /api/v1/authentication/login with x-client-id + x-api-key
// - POST /api/v1/beneficiaries/create (PERSONAL / BANK_ACCOUNT)
// - POST /api/v1/transfers/create with a stable request_id
// - GET /api/v1/transfers/{id} and GET /api/v1/transfers?request_id=...
// - webhook HMAC-SHA256 over `${x-timestamp}${rawBody}`
//
// Bank details are accepted only as an ephemeral argument to the provider
// request. They are never returned by this module and must never be logged or
// persisted by callers.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,50}$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROVIDER_STATUS_RE = /^[A-Z][A-Z_]{2,47}$/;
const SAFE_CODE_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const BANK_FIELD_RE = /^[a-z][a-z0-9_]{1,63}$/;
const WEBHOOK_EVENT_RE =
  /^payout\.transfer\.(?:scheduled|processing|sent|paid|failed|cancelled|funding\.reversed)$/;
const TRANSFER_STATES = new Set([
  "SCHEDULED",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "CANCELLED",
  "REVERSED",
]);
const TRANSFER_METHODS = new Set(["LOCAL", "SWIFT"]);
const BASE_URLS = Object.freeze({
  production: "https://api.airwallex.com",
  sandbox: "https://api.sandbox.airwallex.com",
});
const API_VERSION = "2025-06-30";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BANK_FIELDS = 40;

export class AirwallexContractError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "AirwallexContractError";
    this.code = SAFE_CODE_RE.test(String(code ?? "")) ? code : "invalid_contract";
    this.retryable = options.retryable === true;
    this.uncertainOutcome = options.uncertainOutcome === true;
    this.httpStatus = Number.isInteger(options.httpStatus)
      ? options.httpStatus
      : null;
  }
}

export function loadAirwallexConfig(get) {
  const provider = cleanText(get("NORVA_PARTNERS_PAYOUT_PROVIDER"), 32)
    ?.toLowerCase();
  if (!provider) return null;
  if (provider !== "airwallex") {
    throw new AirwallexContractError("unsupported_payout_provider");
  }

  const environment = cleanText(get("AIRWALLEX_ENVIRONMENT"), 16)
    ?.toLowerCase();
  const clientId = cleanSecret(get("AIRWALLEX_CLIENT_ID"));
  const apiKey = cleanSecret(get("AIRWALLEX_API_KEY"));
  const webhookSecret = cleanSecret(get("AIRWALLEX_WEBHOOK_SECRET"));
  const loginAs = cleanText(get("AIRWALLEX_LOGIN_AS"), 128);
  const reason = cleanText(get("AIRWALLEX_TRANSFER_REASON"), 64);
  const configuredVersion = cleanText(get("AIRWALLEX_API_VERSION"), 10) ??
    API_VERSION;

  if (
    !environment ||
    !(environment in BASE_URLS) ||
    !clientId ||
    !apiKey ||
    !webhookSecret ||
    (loginAs && !PROVIDER_ID_RE.test(loginAs)) ||
    !reason ||
    !/^[A-Za-z][A-Za-z0-9 _-]{1,63}$/.test(reason) ||
    configuredVersion !== API_VERSION
  ) {
    throw new AirwallexContractError("airwallex_not_configured");
  }

  return Object.freeze({
    provider: "airwallex",
    environment,
    baseUrl: BASE_URLS[environment],
    apiVersion: API_VERSION,
    clientId,
    apiKey,
    webhookSecret,
    loginAs: loginAs ?? null,
    transferReason: reason,
    timeoutMs: boundedInt(
      get("AIRWALLEX_TIMEOUT_MS"),
      7_000,
      1_000,
      12_000,
    ),
    webhookToleranceMs: boundedInt(
      get("AIRWALLEX_WEBHOOK_TOLERANCE_MS"),
      5 * 60_000,
      30_000,
      10 * 60_000,
    ),
  });
}

export function parsePersonalBeneficiaryInput(raw) {
  const body = exactRecord(raw, [
    "firstName",
    "lastName",
    "dateOfBirth",
    "address",
    "bankDetails",
    "currency",
    "transferMethod",
  ]);
  const firstName = requiredHumanText(body.firstName, 1, 100);
  const lastName = requiredHumanText(body.lastName, 1, 100);
  const dateOfBirth = cleanText(body.dateOfBirth, 10);
  const currency = cleanText(body.currency, 3)?.toUpperCase();
  const transferMethod = cleanText(body.transferMethod, 8)?.toUpperCase();
  const address = exactRecord(body.address, [
    "city",
    "countryCode",
    "postcode",
    "state",
    "streetAddress",
  ]);
  const countryCode = cleanText(address.countryCode, 2)?.toUpperCase();

  if (
    !dateOfBirth ||
    !DATE_RE.test(dateOfBirth) ||
    !isRealPastDate(dateOfBirth) ||
    !currency ||
    !CURRENCY_RE.test(currency) ||
    !transferMethod ||
    !TRANSFER_METHODS.has(transferMethod) ||
    !countryCode ||
    !COUNTRY_RE.test(countryCode)
  ) {
    throw new AirwallexContractError("invalid_beneficiary");
  }

  const cleanAddress = {
    city: requiredHumanText(address.city, 1, 100),
    country_code: countryCode,
    postcode: requiredHumanText(address.postcode, 1, 32),
    state: optionalHumanText(address.state, 100),
    street_address: requiredHumanText(address.streetAddress, 1, 200),
  };
  if (cleanAddress.state === null) delete cleanAddress.state;

  const bankDetails = sanitizeBankDetails(body.bankDetails);
  if (
    bankDetails.account_currency !== currency ||
    !COUNTRY_RE.test(String(bankDetails.bank_country_code ?? "")) ||
    typeof bankDetails.account_name !== "string" ||
    (
      typeof bankDetails.iban !== "string" &&
      typeof bankDetails.account_number !== "string"
    )
  ) {
    throw new AirwallexContractError("invalid_bank_details");
  }

  return {
    firstName,
    lastName,
    dateOfBirth,
    address: cleanAddress,
    bankDetails,
    currency,
    transferMethod,
    displayMasked: maskedBankLabel(bankDetails),
  };
}

export function buildPersonalBeneficiaryRequest(input, externalIdentifier) {
  if (
    !input ||
    !PROVIDER_ID_RE.test(String(externalIdentifier ?? ""))
  ) {
    throw new AirwallexContractError("invalid_beneficiary_reservation");
  }
  return {
    beneficiary: {
      additional_info: {
        external_identifier: externalIdentifier,
      },
      address: { ...input.address },
      bank_details: { ...input.bankDetails },
      date_of_birth: input.dateOfBirth,
      entity_type: "PERSONAL",
      first_name: input.firstName,
      last_name: input.lastName,
      type: "BANK_ACCOUNT",
    },
    transfer_methods: [input.transferMethod],
  };
}

export function minorUnitsToDecimal(amountMinor, exponent) {
  const raw = typeof amountMinor === "bigint"
    ? amountMinor.toString()
    : String(amountMinor ?? "");
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    throw new AirwallexContractError("invalid_transfer_amount");
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new AirwallexContractError("invalid_currency_exponent");
  }
  if (exponent === 0) return raw;
  const padded = raw.padStart(exponent + 1, "0");
  const whole = padded.slice(0, -exponent);
  const fraction = padded.slice(-exponent);
  return `${whole}.${fraction}`;
}

export function buildTransferRequest(job, transferReason) {
  const requestId = cleanText(job?.request_id, 50);
  const beneficiaryId = cleanText(job?.beneficiary_token_ref, 128);
  const currency = cleanText(job?.currency, 3)?.toUpperCase();
  const method = cleanText(job?.transfer_method, 8)?.toUpperCase();
  const dispatchKey = cleanText(job?.key, 64);
  const reason = cleanText(transferReason, 64);
  const exponent = Number(job?.currency_exponent);

  if (
    !requestId ||
    !REQUEST_ID_RE.test(requestId) ||
    !beneficiaryId ||
    !PROVIDER_ID_RE.test(beneficiaryId) ||
    !currency ||
    !CURRENCY_RE.test(currency) ||
    !method ||
    !TRANSFER_METHODS.has(method) ||
    !dispatchKey ||
    !/^pds_[0-9a-f]{24}$/.test(dispatchKey) ||
    !reason ||
    !/^[A-Za-z][A-Za-z0-9 _-]{1,63}$/.test(reason)
  ) {
    throw new AirwallexContractError("invalid_dispatch_job");
  }

  return {
    beneficiary_id: beneficiaryId,
    reason,
    reference: `NORVA-${dispatchKey.slice(-12).toUpperCase()}`,
    request_id: requestId,
    transfer_amount: minorUnitsToDecimal(job.amount_minor, exponent),
    transfer_currency: currency,
    transfer_method: method,
  };
}

export function canonicalTransferState(providerStatus, fundingStatus = null) {
  const status = cleanText(providerStatus, 48)?.toUpperCase();
  const funding = cleanText(fundingStatus, 48)?.toUpperCase();
  if (funding === "REVERSED") return "REVERSED";
  if (status === "OVERDUE" || status === "IN_APPROVAL") return "SCHEDULED";
  if (
    status === "APPROVAL_REJECTED" ||
    status === "APPROVAL_BLOCKED" ||
    status === "APPROVAL_RECALLED"
  ) return "FAILED";
  if (!status || !TRANSFER_STATES.has(status)) {
    throw new AirwallexContractError("unknown_transfer_status");
  }
  return status;
}

export function canAdvanceTransferState(previous, next) {
  // A create response may already be PROCESSING/SENT/PAID by the time it is
  // received. The response is authoritative, so every documented state is a
  // valid first observation.
  if (previous == null) return TRANSFER_STATES.has(next);
  if (!TRANSFER_STATES.has(previous) || !TRANSFER_STATES.has(next)) {
    return false;
  }
  const transitions = {
    SCHEDULED: new Set([
      "SCHEDULED", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED",
      "REVERSED",
    ]),
    PROCESSING: new Set([
      "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED", "REVERSED",
    ]),
    SENT: new Set(["SENT", "PAID", "FAILED", "CANCELLED", "REVERSED"]),
    // PAID is intentionally non-terminal: Airwallex documents late failures.
    PAID: new Set(["PAID", "FAILED", "CANCELLED", "REVERSED"]),
    FAILED: new Set(["FAILED", "CANCELLED", "REVERSED"]),
    CANCELLED: new Set(["CANCELLED", "REVERSED"]),
    REVERSED: new Set(["REVERSED"]),
  };
  return transitions[previous].has(next);
}

export async function verifyAirwallexWebhook({
  rawBody,
  timestamp,
  signature,
  secret,
  nowMs = Date.now(),
  toleranceMs = 5 * 60_000,
}) {
  if (
    typeof rawBody !== "string" ||
    rawBody.length < 2 ||
    rawBody.length > MAX_RESPONSE_BYTES ||
    typeof timestamp !== "string" ||
    !/^\d{13}$/.test(timestamp) ||
    typeof signature !== "string" ||
    !/^[0-9a-f]{64}$/i.test(signature) ||
    !cleanSecret(secret) ||
    !Number.isFinite(nowMs) ||
    !Number.isInteger(toleranceMs) ||
    toleranceMs < 30_000 ||
    toleranceMs > 10 * 60_000
  ) return false;

  const eventMillis = Number(timestamp);
  if (
    !Number.isSafeInteger(eventMillis) ||
    Math.abs(nowMs - eventMillis) > toleranceMs
  ) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}${rawBody}`),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeHexEqual(expected, signature.toLowerCase());
}

export function parseAirwallexTransferWebhook(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AirwallexContractError("invalid_webhook");
  }
  const event = recordOrNull(parsed);
  const data = recordOrNull(event?.data);
  const eventId = cleanText(event?.id, 160);
  const name = cleanText(event?.name, 96);
  const transferId = cleanText(data?.id, 128);
  if (
    !eventId ||
    !PROVIDER_ID_RE.test(eventId) ||
    !name ||
    !WEBHOOK_EVENT_RE.test(name) ||
    !transferId ||
    !PROVIDER_ID_RE.test(transferId)
  ) {
    throw new AirwallexContractError("unsupported_webhook");
  }
  return { eventId, name, transferId };
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class AirwallexClient {
  constructor(config, fetchImpl = fetch) {
    if (
      !config ||
      config.provider !== "airwallex" ||
      !Object.values(BASE_URLS).includes(config.baseUrl) ||
      config.apiVersion !== API_VERSION ||
      typeof fetchImpl !== "function"
    ) {
      throw new AirwallexContractError("airwallex_not_configured");
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async createPersonalBeneficiary(input, externalIdentifier) {
    const body = buildPersonalBeneficiaryRequest(input, externalIdentifier);
    const response = await this.authorizedJson(
      "POST",
      "/api/v1/beneficiaries/create",
      body,
      { mutation: true },
    );
    const id = cleanText(response?.id, 128);
    const beneficiary = recordOrNull(response?.beneficiary);
    const methods = Array.isArray(response?.transfer_methods)
      ? response.transfer_methods
      : [];
    if (
      !id ||
      !PROVIDER_ID_RE.test(id) ||
      beneficiary?.entity_type !== "PERSONAL" ||
      beneficiary?.type !== "BANK_ACCOUNT" ||
      !methods.includes(input.transferMethod)
    ) {
      throw new AirwallexContractError("invalid_beneficiary_response", {
        uncertainOutcome: true,
      });
    }
    return { id };
  }

  async createTransfer(job) {
    const body = buildTransferRequest(job, this.config.transferReason);
    try {
      const response = await this.authorizedJson(
        "POST",
        "/api/v1/transfers/create",
        body,
        { mutation: true },
      );
      return sanitizeTransferResponse(response, body);
    } catch (error) {
      if (
        !(error instanceof AirwallexContractError) ||
        !(
          error.uncertainOutcome ||
          error.code === "request_id_duplicate" ||
          error.code === "request_pending"
        )
      ) throw error;
      return await this.getTransferByRequestId(body.request_id, body);
    }
  }

  async getTransfer(id) {
    if (!PROVIDER_ID_RE.test(String(id ?? ""))) {
      throw new AirwallexContractError("invalid_transfer_id");
    }
    const response = await this.authorizedJson(
      "GET",
      `/api/v1/transfers/${encodeURIComponent(id)}`,
    );
    return sanitizeTransferResponse(response);
  }

  async getTransferByRequestId(requestId, expectedRequest = null) {
    if (!REQUEST_ID_RE.test(String(requestId ?? ""))) {
      throw new AirwallexContractError("invalid_request_id");
    }
    const response = await this.authorizedJson(
      "GET",
      `/api/v1/transfers?request_id=${
        encodeURIComponent(requestId)
      }&page_size=2`,
    );
    const items = Array.isArray(response?.items) ? response.items : null;
    if (!items || items.length !== 1) {
      throw new AirwallexContractError("transfer_outcome_unknown", {
        retryable: true,
        uncertainOutcome: true,
      });
    }
    return sanitizeTransferResponse(items[0], expectedRequest);
  }

  async authorizedJson(method, path, body = null, options = {}) {
    let token = await this.login();
    try {
      return await this.requestJson(method, path, {
        body,
        token,
        mutation: options.mutation === true,
      });
    } catch (error) {
      if (
        error instanceof AirwallexContractError &&
        error.httpStatus === 401
      ) {
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        token = await this.login();
        return await this.requestJson(method, path, {
          body,
          token,
          mutation: options.mutation === true,
        });
      }
      throw error;
    }
  }

  async login() {
    if (
      this.accessToken &&
      this.accessTokenExpiresAt > Date.now() + 60_000
    ) return this.accessToken;

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey,
      "x-client-id": this.config.clientId,
      "x-api-version": this.config.apiVersion,
    };
    if (this.config.loginAs) headers["x-login-as"] = this.config.loginAs;
    const response = await this.requestJson(
      "POST",
      "/api/v1/authentication/login",
      { headers, authentication: true },
    );
    const token = cleanSecret(response?.token);
    const expiresAt = Date.parse(String(response?.expires_at ?? ""));
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new AirwallexContractError("invalid_auth_response");
    }
    this.accessToken = token;
    this.accessTokenExpiresAt = expiresAt;
    return token;
  }

  async requestJson(method, path, options = {}) {
    const headers = options.headers
      ? { ...options.headers }
      : {
        "Authorization": `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "x-api-version": this.config.apiVersion,
      };
    let response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === null || options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new AirwallexContractError("provider_network_error", {
        retryable: true,
        uncertainOutcome: options.mutation === true,
      });
    }

    const text = await readBoundedResponse(response);
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AirwallexContractError("invalid_provider_response", {
          retryable: response.status >= 500,
          uncertainOutcome: options.mutation === true && response.ok,
          httpStatus: response.status,
        });
      }
    }
    if (!response.ok) {
      const providerCode = providerErrorCode(parsed);
      throw new AirwallexContractError(providerCode, {
        retryable: response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
        uncertainOutcome: options.mutation === true &&
          (response.status === 409 || response.status >= 500),
        httpStatus: response.status,
      });
    }
    return parsed;
  }
}

function sanitizeTransferResponse(raw, expected = null) {
  const transfer = recordOrNull(raw);
  const funding = recordOrNull(transfer?.funding);
  const id = cleanText(transfer?.id, 128);
  const requestId = cleanText(transfer?.request_id, 50);
  const providerStatus = cleanText(transfer?.status, 48)?.toUpperCase();
  const fundingStatus = cleanText(funding?.status, 48)?.toUpperCase() ?? null;
  const currency = cleanText(transfer?.transfer_currency, 3)?.toUpperCase();
  if (
    !id ||
    !PROVIDER_ID_RE.test(id) ||
    !requestId ||
    !REQUEST_ID_RE.test(requestId) ||
    !providerStatus ||
    !PROVIDER_STATUS_RE.test(providerStatus) ||
    (fundingStatus && !PROVIDER_STATUS_RE.test(fundingStatus)) ||
    !currency ||
    !CURRENCY_RE.test(currency)
  ) {
    throw new AirwallexContractError("invalid_transfer_response");
  }
  const state = canonicalTransferState(providerStatus, fundingStatus);
  if (
    expected &&
    (
      requestId !== expected.request_id ||
      currency !== expected.transfer_currency ||
      !decimalValuesEqual(
        transfer.transfer_amount,
        expected.transfer_amount,
      )
    )
  ) {
    throw new AirwallexContractError("transfer_response_mismatch");
  }
  const updatedAtRaw = cleanText(transfer.updated_at, 80);
  const updatedAtMillis = Date.parse(String(updatedAtRaw ?? ""));
  return {
    id,
    requestId,
    state,
    providerStatus,
    fundingStatus,
    updatedAt: Number.isFinite(updatedAtMillis)
      ? new Date(updatedAtMillis).toISOString()
      : null,
  };
}

function sanitizeBankDetails(value) {
  const record = recordOrNull(value);
  if (!record) throw new AirwallexContractError("invalid_bank_details");
  const keys = Object.keys(record);
  if (keys.length < 3 || keys.length > MAX_BANK_FIELDS) {
    throw new AirwallexContractError("invalid_bank_details");
  }
  const result = {};
  for (const key of keys) {
    const item = cleanText(record[key], 255);
    if (
      !BANK_FIELD_RE.test(key) ||
      !item ||
      /[\u0000-\u001f\u007f]/u.test(item)
    ) {
      throw new AirwallexContractError("invalid_bank_details");
    }
    result[key] = key === "account_currency"
      ? item.toUpperCase()
      : key === "bank_country_code"
      ? item.toUpperCase()
      : item;
  }
  return result;
}

function maskedBankLabel(bankDetails) {
  const raw = String(bankDetails.iban ?? bankDetails.account_number ?? "");
  const compact = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (compact.length < 4) {
    throw new AirwallexContractError("invalid_bank_details");
  }
  const country = String(bankDetails.bank_country_code ?? "").toUpperCase();
  return `${country} •••• ${compact.slice(-4)}`;
}

function exactRecord(value, expectedKeys) {
  const record = recordOrNull(value);
  if (!record) throw new AirwallexContractError("invalid_request");
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new AirwallexContractError("invalid_request");
  }
  return record;
}

function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean &&
      clean.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(clean)
    ? clean
    : null;
}

function cleanSecret(value) {
  if (typeof value !== "string") return null;
  return value.length >= 8 &&
      value.length <= 512 &&
      !/[\s\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function requiredHumanText(value, min, max) {
  const clean = cleanText(value, max);
  if (!clean || clean.length < min) {
    throw new AirwallexContractError("invalid_beneficiary");
  }
  return clean;
}

function optionalHumanText(value, max) {
  if (value === null || value === undefined || value === "") return null;
  return requiredHumanText(value, 1, max);
}

function isRealPastDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    parsed.getTime() < Date.now();
}

function decimalValuesEqual(left, right) {
  const normalize = (value) => {
    const raw = typeof value === "number"
      ? String(value)
      : String(value ?? "").trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) return null;
    const [whole, fraction = ""] = raw.split(".");
    return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
  };
  return normalize(left) !== null && normalize(left) === normalize(right);
}

function providerErrorCode(parsed) {
  const root = recordOrNull(parsed);
  const nested = recordOrNull(root?.error);
  const candidate = cleanText(root?.code, 64) ?? cleanText(nested?.code, 64);
  return candidate && SAFE_CODE_RE.test(candidate.toLowerCase())
    ? candidate.toLowerCase()
    : "provider_request_failed";
}

async function readBoundedResponse(response) {
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new AirwallexContractError("provider_response_too_large", {
      retryable: response.status >= 500,
      httpStatus: response.status,
    });
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new AirwallexContractError("provider_response_too_large", {
      retryable: response.status >= 500,
      httpStatus: response.status,
    });
  }
  return text;
}

function boundedInt(raw, fallback, min, max) {
  const number = Number(raw ?? fallback);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
}

function constantTimeHexEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
