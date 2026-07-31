// Revolut Business payout client for Norva Partners.
//
// This module is deliberately independent from the Revolut Merchant billing
// client. It accepts only already-tokenized counterparty ids, never logs a
// transfer payload, validates every RPC job exactly and stays inert unless the
// Edge kill-switch is the literal string "true".

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXECUTION_KEY = /^rpx_[0-9a-f]{24}$/;
const REFERENCE = /^NORVA-[A-F0-9]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TOKEN = /^[^\s\u0000-\u001f\u007f]{8,255}$/u;
const HASH = /^[0-9a-f]{64}$/;
const API_BASES = new Set([
  "https://b2b.revolut.com/api/1.0",
  "https://sandbox-b2b.revolut.com/api/1.0",
]);
const TRANSACTION_STATES = new Map([
  ["created", "CREATED"],
  ["pending", "PENDING"],
  ["processing", "PROCESSING"],
  ["completed", "COMPLETED"],
  ["failed", "FAILED"],
  ["declined", "FAILED"],
  ["cancelled", "CANCELLED"],
  ["canceled", "CANCELLED"],
  ["reverted", "REVERTED"],
]);

export class RevolutBusinessContractError extends Error {
  constructor(code = "revolut_business_contract_error", retryable = false) {
    super(code);
    this.name = "RevolutBusinessContractError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function revolutApiEnvironmentEnabled(env = Deno.env) {
  return env.get("NORVA_PARTNERS_REVOLUT_API_ENABLED") === "true";
}

export function readRevolutBusinessConfig(env = Deno.env) {
  if (!revolutApiEnvironmentEnabled(env)) return null;
  const environment = cleanText(
    env.get("REVOLUT_BUSINESS_ENVIRONMENT"),
    16,
  )?.toLowerCase();
  const baseUrl = environment === "production"
    ? "https://b2b.revolut.com/api/1.0"
    : environment === "sandbox"
    ? "https://sandbox-b2b.revolut.com/api/1.0"
    : null;
  const refreshToken = cleanText(
    env.get("REVOLUT_BUSINESS_REFRESH_TOKEN"),
    4096,
  );
  const clientId = cleanText(
    env.get("REVOLUT_BUSINESS_CLIENT_ID"),
    255,
  );
  const issuer = cleanText(
    env.get("REVOLUT_BUSINESS_ISSUER"),
    255,
  )?.toLowerCase();
  const privateKeyPem = normalizePrivateKey(
    env.get("REVOLUT_BUSINESS_PRIVATE_KEY_PEM"),
  );
  const rawAccounts = env.get("REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON");
  const rawFeeCaps = env.get("REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON");
  const timeoutMs = boundedInteger(
    env.get("REVOLUT_BUSINESS_TIMEOUT_MS"),
    1_000,
    15_000,
    7_000,
  );
  if (
    !baseUrl ||
    !API_BASES.has(baseUrl) ||
    !refreshToken ||
    !clientId ||
    !TOKEN.test(clientId) ||
    !issuer ||
    !isDomainName(issuer) ||
    !privateKeyPem ||
    !rawAccounts ||
    !rawFeeCaps
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_not_configured",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawAccounts);
  } catch {
    throw new RevolutBusinessContractError(
      "revolut_business_accounts_invalid",
    );
  }
  let parsedFeeCaps;
  try {
    parsedFeeCaps = JSON.parse(rawFeeCaps);
  } catch {
    throw new RevolutBusinessContractError(
      "revolut_business_fee_caps_invalid",
    );
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length < 1 ||
    Object.keys(parsed).length > 64
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_accounts_invalid",
    );
  }
  const sourceAccounts = {};
  const maxFeeMinor = {};
  for (const [currency, accountId] of Object.entries(parsed)) {
    if (
      !CURRENCY.test(currency) ||
      typeof accountId !== "string" ||
      !UUID.test(accountId)
    ) {
      throw new RevolutBusinessContractError(
        "revolut_business_accounts_invalid",
      );
    }
    sourceAccounts[currency] = accountId;
  }
  if (
    !isRecord(parsedFeeCaps) ||
    Object.keys(parsedFeeCaps).length !== Object.keys(parsed).length
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_fee_caps_invalid",
    );
  }
  for (const [currency, feeCap] of Object.entries(parsedFeeCaps)) {
    if (
      !Object.hasOwn(sourceAccounts, currency) ||
      !Number.isSafeInteger(feeCap) ||
      feeCap < 0
    ) {
      throw new RevolutBusinessContractError(
        "revolut_business_fee_caps_invalid",
      );
    }
    maxFeeMinor[currency] = feeCap;
  }
  return Object.freeze({
    environment,
    baseUrl,
    refreshToken,
    clientId,
    issuer,
    privateKeyPem,
    sourceAccounts: Object.freeze(sourceAccounts),
    maxFeeMinor: Object.freeze(maxFeeMinor),
    timeoutMs,
  });
}

export function normalizeRevolutPayoutJob(raw) {
  if (!isRecord(raw)) {
    throw new RevolutBusinessContractError("invalid_revolut_payout_job");
  }
  const expected = new Set([
    "execution_key",
    "request_id",
    "reference",
    "provider_transaction_id",
    "beneficiary_token_ref",
    "beneficiary_payment_method_ref",
    "amount_minor",
    "currency",
    "currency_exponent",
  ]);
  if (
    Object.keys(raw).length !== expected.size ||
    Object.keys(raw).some((key) => !expected.has(key)) ||
    typeof raw.execution_key !== "string" ||
    !EXECUTION_KEY.test(raw.execution_key) ||
    typeof raw.request_id !== "string" ||
    !UUID.test(raw.request_id) ||
    typeof raw.reference !== "string" ||
    !REFERENCE.test(raw.reference) ||
    (
      raw.provider_transaction_id !== null &&
      (
        typeof raw.provider_transaction_id !== "string" ||
        !TOKEN.test(raw.provider_transaction_id) ||
        raw.provider_transaction_id.length > 128
      )
    ) ||
    typeof raw.beneficiary_token_ref !== "string" ||
    !UUID.test(raw.beneficiary_token_ref) ||
    typeof raw.beneficiary_payment_method_ref !== "string" ||
    !UUID.test(raw.beneficiary_payment_method_ref) ||
    !Number.isSafeInteger(raw.amount_minor) ||
    raw.amount_minor < 1 ||
    typeof raw.currency !== "string" ||
    !CURRENCY.test(raw.currency) ||
    !Number.isInteger(raw.currency_exponent) ||
    raw.currency_exponent < 0 ||
    raw.currency_exponent > 6
  ) {
    throw new RevolutBusinessContractError("invalid_revolut_payout_job");
  }
  return Object.freeze({
    executionKey: raw.execution_key,
    requestId: raw.request_id,
    reference: raw.reference,
    providerTransactionId: raw.provider_transaction_id,
    beneficiaryTokenRef: raw.beneficiary_token_ref,
    beneficiaryPaymentMethodRef: raw.beneficiary_payment_method_ref,
    amountMinor: raw.amount_minor,
    currency: raw.currency,
    currencyExponent: raw.currency_exponent,
  });
}

export function formatMinorUnits(amountMinor, exponent) {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6
  ) {
    throw new RevolutBusinessContractError("invalid_revolut_amount");
  }
  const digits = String(amountMinor);
  if (exponent === 0) return digits;
  const padded = digits.padStart(exponent + 1, "0");
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

function parseNegativeProviderAmountMinor(value, exponent) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value >= 0
  ) {
    return null;
  }
  return parseUnsignedProviderAmountMinor(-value, exponent, false);
}

function parseUnsignedProviderAmountMinor(value, exponent, allowZero) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6
  ) {
    return null;
  }
  const unsigned = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(unsigned)) return null;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > exponent) return null;
  const minorText = `${whole}${fraction.padEnd(exponent, "0")}`
    .replace(/^0+(?=\d)/, "");
  const amountMinor = Number(minorText || "0");
  return Number.isSafeInteger(amountMinor) &&
      (allowZero ? amountMinor >= 0 : amountMinor > 0)
    ? amountMinor
    : null;
}

export class RevolutBusinessClient {
  constructor(config, fetchImpl = fetch) {
    if (
      !isRecord(config) ||
      !API_BASES.has(config.baseUrl) ||
      typeof config.refreshToken !== "string" ||
      !config.refreshToken ||
      !["sandbox", "production"].includes(config.environment) ||
      config.baseUrl !== (
        config.environment === "production"
          ? "https://b2b.revolut.com/api/1.0"
          : "https://sandbox-b2b.revolut.com/api/1.0"
      ) ||
      typeof config.clientId !== "string" ||
      !config.clientId ||
      typeof config.issuer !== "string" ||
      !config.issuer ||
      typeof config.privateKeyPem !== "string" ||
      !config.privateKeyPem ||
      !isRecord(config.sourceAccounts) ||
      !isRecord(config.maxFeeMinor) ||
      typeof fetchImpl !== "function"
    ) {
      throw new RevolutBusinessContractError(
        "revolut_business_not_configured",
      );
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.accessToken = config.initialAccessToken || null;
    this.accessTokenExpiresAt = config.initialAccessToken
      ? Number.POSITIVE_INFINITY
      : 0;
    this.refreshPromise = null;
  }

  async createOrGetTransfer(rawJob) {
    const job = normalizeRevolutPayoutJob(rawJob);
    if (job.providerTransactionId) {
      return await this.getTransfer(job.providerTransactionId, rawJob);
    }
    const accountId = this.config.sourceAccounts[job.currency];
    if (!accountId || !UUID.test(accountId)) {
      throw new RevolutBusinessContractError(
        "revolut_source_account_unavailable",
      );
    }
    const receiver = {
      counterparty_id: job.beneficiaryTokenRef,
      account_id: job.beneficiaryPaymentMethodRef,
    };
    const fields = await this.#request("/pay/fields", {
      method: "POST",
      body: { account_id: accountId, receiver },
    });
    const corridorFields = validateTransferFields(fields, job.reference);

    const amountText = formatMinorUnits(
      job.amountMinor,
      job.currencyExponent,
    );
    const amount = Number(amountText);
    const scale = 10 ** job.currencyExponent;
    if (
      !Number.isFinite(amount) ||
      Math.round(amount * scale) !== job.amountMinor
    ) {
      throw new RevolutBusinessContractError("invalid_revolut_amount");
    }
    const payment = {
      request_id: job.requestId,
      account_id: accountId,
      receiver,
      amount,
      currency: job.currency,
      reference: job.reference,
      ...corridorFields,
    };
    const quote = await this.#request("/pay/indicative-quote", {
      method: "POST",
      body: {
        account_id: payment.account_id,
        receiver: payment.receiver,
        amount: payment.amount,
        currency: payment.currency,
        ...corridorFields,
      },
    });
    validateIndicativeQuote(
      quote,
      job,
      this.config.maxFeeMinor[job.currency],
    );
    let result;
    let payResponseReceived = false;
    try {
      result = await this.#request("/pay", {
        method: "POST",
        body: payment,
      });
      payResponseReceived = true;
      const acknowledgement = normalizeRevolutPaymentResponse(result);
      return await this.getTransfer(acknowledgement.id, rawJob);
    } catch (error) {
      if (
        !(error instanceof RevolutBusinessContractError) ||
        !(
          payResponseReceived ||
          error.retryable ||
          error.code === "revolut_business_http_409"
        )
      ) {
        throw error;
      }
      try {
        return await this.findTransferByRequestId(job.requestId, rawJob);
      } catch (recoveryError) {
        if (
          recoveryError instanceof RevolutBusinessContractError &&
          recoveryError.code === "revolut_business_transaction_not_found"
        ) {
          throw payResponseReceived && !error.retryable
            ? new RevolutBusinessContractError(error.code, true)
            : error;
        }
        throw recoveryError;
      }
    }
  }

  async getTransfer(providerTransactionId, rawJob) {
    if (
      typeof providerTransactionId !== "string" ||
      !TOKEN.test(providerTransactionId) ||
      providerTransactionId.length > 128
    ) {
      throw new RevolutBusinessContractError(
        "invalid_revolut_transaction",
      );
    }
    const job = normalizeRevolutPayoutJob(rawJob);
    const sourceAccountId = this.config.sourceAccounts[job.currency];
    if (!UUID.test(sourceAccountId)) {
      throw new RevolutBusinessContractError(
        "revolut_source_account_unavailable",
      );
    }
    const result = await this.#request(
      `/transaction/${encodeURIComponent(providerTransactionId)}`,
      { method: "GET" },
    );
    return normalizeRevolutTransaction(
      result,
      job,
      sourceAccountId,
      providerTransactionId,
    );
  }

  async findTransferByRequestId(requestId, rawJob) {
    if (typeof requestId !== "string" || !UUID.test(requestId)) {
      throw new RevolutBusinessContractError(
        "invalid_revolut_request_id",
      );
    }
    const job = normalizeRevolutPayoutJob(rawJob);
    if (job.requestId !== requestId) {
      throw new RevolutBusinessContractError(
        "invalid_revolut_request_id",
      );
    }
    const sourceAccountId = this.config.sourceAccounts[job.currency];
    if (!UUID.test(sourceAccountId)) {
      throw new RevolutBusinessContractError(
        "revolut_source_account_unavailable",
      );
    }
    const from = new Date(Date.now() - 13 * 24 * 60 * 60 * 1_000)
      .toISOString();
    const query = new URLSearchParams({
      request_id: requestId,
      account: sourceAccountId,
      type: "transfer",
      from,
      count: "10",
    });
    const transactions = await this.#request(
      `/transactions?${query.toString()}`,
      { method: "GET", expect: "array" },
    );
    const matching = transactions.filter((transaction) =>
      isRecord(transaction) && transaction.request_id === requestId
    );
    if (matching.length === 0) {
      throw new RevolutBusinessContractError(
        "revolut_business_transaction_not_found",
        true,
      );
    }
    if (matching.length !== 1) {
      throw new RevolutBusinessContractError(
        "revolut_business_transaction_ambiguous",
      );
    }
    return await this.getTransfer(matching[0].id, rawJob);
  }

  async #request(
    path,
    { method, body, expect = "record" } = {},
    retried = false,
  ) {
    const accessToken = await this.#accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401 && !retried) {
          this.accessToken = null;
          this.accessTokenExpiresAt = 0;
          return await this.#request(path, { method, body, expect }, true);
        }
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500;
        throw new RevolutBusinessContractError(
          `revolut_business_http_${response.status}`,
          retryable,
        );
      }
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new RevolutBusinessContractError(
            "revolut_business_response_invalid",
            true,
          );
        }
      }
      if (
        (expect === "record" && !isRecord(payload)) ||
        (expect === "array" && !Array.isArray(payload)) ||
        !["record", "array"].includes(expect)
      ) {
        throw new RevolutBusinessContractError(
          "revolut_business_response_invalid",
          true,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof RevolutBusinessContractError) throw error;
      throw new RevolutBusinessContractError(
        error?.name === "AbortError"
          ? "revolut_business_timeout"
          : "revolut_business_unavailable",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #accessToken() {
    if (
      this.accessToken &&
      Date.now() < this.accessTokenExpiresAt - 60_000
    ) {
      return this.accessToken;
    }
    this.refreshPromise ??= this.#refreshAccessToken()
      .finally(() => {
        this.refreshPromise = null;
      });
    return await this.refreshPromise;
  }

  async #refreshAccessToken() {
    const clientAssertion = await createClientAssertion(this.config);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl}/auth/token`,
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new RevolutBusinessContractError(
          `revolut_business_oauth_http_${response.status}`,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new RevolutBusinessContractError(
          "revolut_business_oauth_response_invalid",
          true,
        );
      }
      if (
        !isRecord(payload) ||
        typeof payload.access_token !== "string" ||
        !cleanText(payload.access_token, 4096) ||
        !Number.isInteger(payload.expires_in) ||
        payload.expires_in < 60 ||
        payload.expires_in > 86_400
      ) {
        throw new RevolutBusinessContractError(
          "revolut_business_oauth_response_invalid",
          true,
        );
      }
      this.accessToken = payload.access_token;
      this.accessTokenExpiresAt = Date.now() + payload.expires_in * 1_000;
      return this.accessToken;
    } catch (error) {
      if (error instanceof RevolutBusinessContractError) throw error;
      throw new RevolutBusinessContractError(
        error?.name === "AbortError"
          ? "revolut_business_oauth_timeout"
          : "revolut_business_oauth_unavailable",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeRevolutPaymentResponse(raw) {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !TOKEN.test(raw.id) ||
    raw.id.length > 128 ||
    typeof raw.state !== "string"
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_invalid",
    );
  }
  const state = TRANSACTION_STATES.get(raw.state.toLowerCase());
  if (!state) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_state_unknown",
    );
  }
  return Object.freeze({ id: raw.id, state });
}

export function normalizeRevolutTransaction(
  raw,
  job,
  sourceAccountId,
  expectedTransactionId,
) {
  const acknowledgement = normalizeRevolutPaymentResponse(raw);
  if (
    !isRecord(job) ||
    !UUID.test(sourceAccountId) ||
    typeof expectedTransactionId !== "string" ||
    acknowledgement.id !== expectedTransactionId ||
    raw.type !== "transfer" ||
    raw.request_id !== job.requestId ||
    raw.reference !== job.reference ||
    !Array.isArray(raw.legs) ||
    raw.legs.length < 1 ||
    raw.legs.length > 16
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_mismatch",
    );
  }
  const sourceLegs = raw.legs.filter((leg) =>
    isRecord(leg) && leg.account_id === sourceAccountId
  );
  if (
    sourceLegs.length !== 1 ||
    sourceLegs[0].currency !== job.currency ||
    parseNegativeProviderAmountMinor(
        sourceLegs[0].amount,
        job.currencyExponent,
      ) !== job.amountMinor
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_mismatch",
    );
  }
  const exposedCounterpartyIds = [
    isRecord(raw.receiver) && "counterparty_id" in raw.receiver
      ? raw.receiver.counterparty_id
      : undefined,
    isRecord(sourceLegs[0].counterparty) &&
        "counterparty_id" in sourceLegs[0].counterparty
      ? sourceLegs[0].counterparty.counterparty_id
      : undefined,
  ].filter((value) => value !== undefined);
  if (
    exposedCounterpartyIds.some((value) =>
      value !== job.beneficiaryTokenRef
    )
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_mismatch",
    );
  }
  const exposedPaymentMethodIds = [
    isRecord(raw.receiver) && "account_id" in raw.receiver
      ? raw.receiver.account_id
      : undefined,
    isRecord(sourceLegs[0].counterparty) &&
        "account_id" in sourceLegs[0].counterparty
      ? sourceLegs[0].counterparty.account_id
      : undefined,
  ].filter((value) => value !== undefined);
  if (
    exposedPaymentMethodIds.some((value) =>
      value !== job.beneficiaryPaymentMethodRef
    )
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_transaction_mismatch",
    );
  }
  return Object.freeze({
    id: acknowledgement.id,
    state: acknowledgement.state,
    requestId: raw.request_id,
  });
}

export async function revolutWebhookSignatureMatches({
  rawBody,
  timestamp,
  signatureHeader,
  signingSecret,
  now = Date.now(),
  toleranceMs = 300_000,
}) {
  if (
    typeof rawBody !== "string" ||
    typeof timestamp !== "string" ||
    !/^\d{10,16}$/.test(timestamp) ||
    typeof signatureHeader !== "string" ||
    typeof signingSecret !== "string" ||
    signingSecret.length < 16
  ) {
    return false;
  }
  const timestampMs = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > toleranceMs
  ) {
    return false;
  }
  const payload = `v1.${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    ),
  );
  const expected = `v1=${bytesToHex(digest)}`;
  return signatureHeader
    .split(",")
    .map((value) => value.trim())
    .some((candidate) => timingSafeEqual(candidate, expected));
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(value)),
    ),
  );
  return bytesToHex(digest);
}

function validateIndicativeQuote(raw, job, maxFeeMinor) {
  if (
    !isRecord(raw) ||
    !isRecord(raw.amount) ||
    !isRecord(raw.fee) ||
    !isRecord(raw.estimated_total) ||
    !Number.isSafeInteger(maxFeeMinor) ||
    maxFeeMinor < 0 ||
    raw.amount.currency !== job.currency ||
    raw.fee.currency !== job.currency ||
    raw.estimated_total.currency !== job.currency
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_quote_invalid",
    );
  }
  const quotedAmountMinor = parseUnsignedProviderAmountMinor(
    raw.amount.amount,
    job.currencyExponent,
    false,
  );
  const quotedFeeMinor = parseUnsignedProviderAmountMinor(
    raw.fee.amount,
    job.currencyExponent,
    true,
  );
  const quotedTotalMinor = parseUnsignedProviderAmountMinor(
    raw.estimated_total.amount,
    job.currencyExponent,
    false,
  );
  const expectedTotalMinor = job.amountMinor + quotedFeeMinor;
  if (
    quotedAmountMinor !== job.amountMinor ||
    quotedFeeMinor === null ||
    quotedFeeMinor > maxFeeMinor ||
    !Number.isSafeInteger(expectedTotalMinor) ||
    quotedTotalMinor !== expectedTotalMinor
  ) {
    throw new RevolutBusinessContractError(
      quotedFeeMinor !== null && quotedFeeMinor > maxFeeMinor
        ? "revolut_business_fee_limit_exceeded"
        : "revolut_business_quote_invalid",
    );
  }
}

function validateTransferFields(raw, payoutReference) {
  if (!isRecord(raw) || !Array.isArray(raw.fields) || raw.fields.length > 64) {
    throw new RevolutBusinessContractError(
      "revolut_business_transfer_fields_invalid",
    );
  }
  const referenceField = raw.fields.find((field) =>
    isRecord(field) && field.name === "reference"
  );
  if (!referenceField) {
    throw new RevolutBusinessContractError(
      "revolut_business_reference_not_supported",
    );
  }
  const maxLength = referenceField.validation?.max_length;
  const minLength = referenceField.validation?.min_length;
  const referencePattern = referenceField.validation?.regex;
  if (
    maxLength !== undefined &&
    (!Number.isInteger(maxLength) || maxLength < payoutReference.length)
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_reference_not_supported",
    );
  }
  if (
    minLength !== undefined &&
    (
      !Number.isInteger(minLength) ||
      minLength < 0 ||
      minLength > payoutReference.length
    )
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_reference_not_supported",
    );
  }
  if (referencePattern !== undefined) {
    if (
      typeof referencePattern !== "string" ||
      referencePattern.length < 1 ||
      referencePattern.length > 512
    ) {
      throw new RevolutBusinessContractError(
        "revolut_business_reference_not_supported",
      );
    }
    try {
      if (!new RegExp(referencePattern, "u").test(payoutReference)) {
        throw new RevolutBusinessContractError(
          "revolut_business_reference_not_supported",
        );
      }
    } catch (error) {
      if (error instanceof RevolutBusinessContractError) throw error;
      throw new RevolutBusinessContractError(
        "revolut_business_reference_not_supported",
      );
    }
  }
  if (
    raw.fields.some((field) =>
      isRecord(field) &&
      !["reference", "charge_bearer"].includes(field.name) &&
      field.required === true
    )
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_corridor_fields_unconfigured",
    );
  }
  const chargeBearerField = raw.fields.find((field) =>
    isRecord(field) && field.name === "charge_bearer"
  );
  if (!chargeBearerField) return Object.freeze({});
  if (
    !Array.isArray(chargeBearerField.options) ||
    !chargeBearerField.options.some((option) =>
      isRecord(option) && option.value === "debtor"
    )
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_exact_amount_not_supported",
    );
  }
  return Object.freeze({ charge_bearer: "debtor" });
}

export async function createClientAssertion(config, now = Date.now()) {
  if (
    !isRecord(config) ||
    typeof config.clientId !== "string" ||
    !TOKEN.test(config.clientId) ||
    typeof config.issuer !== "string" ||
    !isDomainName(config.issuer) ||
    typeof config.privateKeyPem !== "string"
  ) {
    throw new RevolutBusinessContractError(
      "revolut_business_oauth_config_invalid",
    );
  }
  const header = base64UrlText(JSON.stringify({
    alg: "RS256",
    typ: "JWT",
  }));
  const issuedAt = Math.floor(now / 1_000);
  const payload = base64UrlText(JSON.stringify({
    iss: config.issuer,
    sub: config.clientId,
    aud: "https://revolut.com",
    iat: issuedAt,
    exp: issuedAt + 300,
  }));
  const unsigned = `${header}.${payload}`;
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToBytes(config.privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new RevolutBusinessContractError(
      "revolut_business_private_key_invalid",
    );
  }
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  ));
  return `${unsigned}.${base64UrlBytes(signature)}`;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (
    !cleaned ||
    cleaned.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function normalizePrivateKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\n/g, "\n");
  if (
    normalized.length < 256 ||
    normalized.length > 16_384 ||
    !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/
      .test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isDomainName(value) {
  return typeof value === "string" &&
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
      .test(value);
}

function pemToBytes(pem) {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0)
  );
}

function base64UrlText(value) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(value) {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
