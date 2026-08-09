#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

import {
  createClientAssertion,
  sha256Hex,
} from "../../supabase/functions/_shared/partners-revolut-business.mjs";

const BASE_URL = "https://sandbox-b2b.revolut.com/api/1.0";
const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const SECRET = /^[^\s\u0000-\u001f\u007f]{8,4096}$/u;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
let bootstrapPhase = "initialization";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isSecret(value) {
  return typeof value === "string" && SECRET.test(value);
}

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    fail("sandbox_bootstrap_requires_protected_config_file");
  }
  return path.resolve(argv[1]);
}

function isInsideWorkspace(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertOutsideWorkspace(filePath, code) {
  if (isInsideWorkspace(filePath)) fail(code);
  return filePath;
}

async function readProtectedEnvironment(filePath) {
  assertOutsideWorkspace(
    filePath,
    "sandbox_bootstrap_config_must_be_outside_workspace",
  );
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    fail("sandbox_bootstrap_config_unreadable");
  }
  const parsed = dotenv.parse(source);
  if (!parsed || typeof parsed !== "object") {
    fail("sandbox_bootstrap_config_invalid");
  }
  return parsed;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`missing_${name.toLowerCase()}`);
  }
  return value.trim();
}

function optionalInteger(environment, name, minimum, maximum, fallback) {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) fail(`invalid_${name.toLowerCase()}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function optionalNumber(environment, name, minimum, maximum, fallback) {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

async function readSecretFile(filePath, errorPrefix) {
  assertOutsideWorkspace(filePath, `${errorPrefix}_must_be_outside_workspace`);
  let value;
  try {
    value = (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    fail(`${errorPrefix}_unreadable`);
  }
  if (!isSecret(value)) fail(`${errorPrefix}_invalid`);
  return value;
}

async function readPrivateKey(filePath) {
  assertOutsideWorkspace(
    filePath,
    "sandbox_bootstrap_private_key_must_be_outside_workspace",
  );
  let privateKey;
  try {
    privateKey = (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    fail("sandbox_bootstrap_private_key_unreadable");
  }
  if (
    !/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----$/.test(
      privateKey,
    )
  ) {
    fail("sandbox_bootstrap_private_key_invalid");
  }
  return privateKey;
}

async function request(
  endpoint,
  { accessToken, method = "GET", body, form, timeoutMs, expect = "record" },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: {
        "Accept": "application/json",
        ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body
        ? JSON.stringify(body)
        : form
        ? form.toString()
        : undefined,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      fail(`sandbox_bootstrap_http_${response.status}`);
    }
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      fail("sandbox_bootstrap_response_invalid");
    }
    if (
      (expect === "record" && (!payload || Array.isArray(payload) ||
        typeof payload !== "object")) ||
      (expect === "array" && !Array.isArray(payload)) ||
      !["record", "array"].includes(expect)
    ) {
      fail("sandbox_bootstrap_response_invalid");
    }
    return payload;
  } catch (error) {
    if (error?.code) throw error;
    fail(error?.name === "AbortError"
      ? "sandbox_bootstrap_timeout"
      : "sandbox_bootstrap_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function selectExactAccount(accounts, currency, preferredId, errorPrefix) {
  const candidates = accounts.filter((account) =>
    account &&
    typeof account === "object" &&
    PROVIDER_UUID.test(account.id) &&
    account.currency === currency &&
    (!Object.hasOwn(account, "state") ||
      String(account.state).toLowerCase() === "active") &&
    (!preferredId || account.id === preferredId)
  );
  if (candidates.length === 0) fail(`${errorPrefix}_not_found`);
  if (preferredId && candidates.length !== 1) {
    fail(`${errorPrefix}_ambiguous`);
  }
  // A fresh Revolut Sandbox can contain several accounts in the same
  // currency. This bootstrap is sandbox-only, so choose deterministically
  // while persisting the selected UUID in the protected runtime file. The
  // production adapter never performs this selection: its account mapping
  // remains explicit and fail-closed.
  const ranked = [...candidates].sort((left, right) => {
    const score = (account) =>
      (/current/i.test(String(account.name || "")) ? 0 : 10) +
      (/^(revolut|internal)$/i.test(String(account.type || "")) ? 0 : 1);
    return score(left) - score(right) || left.id.localeCompare(right.id);
  });
  return ranked[0];
}

async function findOrCreateCounterparty({
  accessToken,
  timeoutMs,
  testUserIndex,
}) {
  const name = `Test User ${testUserIndex}`;
  const revtag = `john${testUserIndex}pvki`;
  const query = new URLSearchParams({ name, limit: "100" });
  let counterparties = await request(`/counterparties?${query}`, {
    accessToken,
    timeoutMs,
    expect: "array",
  });
  let matching = counterparties.filter((counterparty) =>
    counterparty &&
    typeof counterparty === "object" &&
    counterparty.name === name &&
    counterparty.revtag === revtag &&
    ["created", "active"].includes(
      String(counterparty.state).toLowerCase(),
    ) &&
    PROVIDER_UUID.test(counterparty.id)
  );
  if (matching.length === 0) {
    const created = await request("/counterparty", {
      accessToken,
      method: "POST",
      body: { profile_type: "personal", name, revtag },
      timeoutMs,
    });
    if (!PROVIDER_UUID.test(created.id)) {
      fail("sandbox_bootstrap_counterparty_invalid");
    }
    matching = [created];
  }
  if (matching.length !== 1) {
    fail("sandbox_bootstrap_counterparty_ambiguous");
  }
  const counterparty = await request(
    `/counterparty/${encodeURIComponent(matching[0].id)}`,
    { accessToken, timeoutMs },
  );
  if (counterparty.id !== matching[0].id) {
    fail("sandbox_bootstrap_counterparty_id_invalid");
  }
  if (counterparty.name !== name) {
    fail("sandbox_bootstrap_counterparty_name_invalid");
  }
  if (
    Object.hasOwn(counterparty, "revtag") &&
    counterparty.revtag !== revtag
  ) {
    fail("sandbox_bootstrap_counterparty_revtag_invalid");
  }
  if (
    !["created", "active"].includes(
      String(counterparty.state).toLowerCase(),
    )
  ) {
    fail("sandbox_bootstrap_counterparty_state_invalid");
  }
  const accounts = Array.isArray(counterparty.accounts)
    ? counterparty.accounts
    : Array.isArray(matching[0].accounts)
    ? matching[0].accounts
    : [];
  return Object.freeze({ ...counterparty, accounts });
}

function dotenvLine(name, value) {
  const text = String(value);
  if (/[\r\n']/u.test(text)) fail("sandbox_bootstrap_output_invalid");
  return `${name}='${text}'`;
}

async function atomicWrite(filePath, contents) {
  assertOutsideWorkspace(
    filePath,
    "sandbox_bootstrap_output_must_be_outside_workspace",
  );
  const parent = await fs.realpath(path.dirname(filePath)).catch(() => null);
  if (!parent || parent !== path.dirname(filePath)) {
    fail("sandbox_bootstrap_output_directory_invalid");
  }
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("sandbox_bootstrap_output_exists");
    if (error?.code) fail("sandbox_bootstrap_output_write_failed");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await fs.chmod(filePath, 0o600).catch(() => {});
}

async function readTokenStage(filePath, clientId, issuer) {
  const source = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!source) return null;
  const parsed = dotenv.parse(source);
  if (
    parsed.REVOLUT_BUSINESS_ENVIRONMENT !== "sandbox" ||
    parsed.REVOLUT_BUSINESS_CLIENT_ID !== clientId ||
    parsed.REVOLUT_BUSINESS_ISSUER !== issuer ||
    !isSecret(parsed.REVOLUT_BUSINESS_REFRESH_TOKEN)
  ) {
    fail("sandbox_bootstrap_token_stage_invalid");
  }
  return parsed.REVOLUT_BUSINESS_REFRESH_TOKEN;
}

async function writeTokenStage(
  filePath,
  { clientId, issuer, refreshToken },
) {
  const contents = [
    "# Short-lived local recovery stage for Revolut Business Sandbox.",
    dotenvLine("REVOLUT_BUSINESS_ENVIRONMENT", "sandbox"),
    dotenvLine("REVOLUT_BUSINESS_CLIENT_ID", clientId),
    dotenvLine("REVOLUT_BUSINESS_ISSUER", issuer),
    dotenvLine("REVOLUT_BUSINESS_REFRESH_TOKEN", refreshToken),
    "",
  ].join("\n");
  await atomicWrite(filePath, contents);
}

async function fingerprint(value) {
  return (await sha256Hex(value)).slice(0, 16);
}

async function main() {
  bootstrapPhase = "configuration";
  const configPath = parseConfigPath(process.argv.slice(2));
  const environment = await readProtectedEnvironment(configPath);
  if (required(environment, "REVOLUT_BUSINESS_ENVIRONMENT") !== "sandbox") {
    fail("sandbox_bootstrap_requires_sandbox_environment");
  }
  const clientId = required(environment, "REVOLUT_BUSINESS_CLIENT_ID");
  const issuer = required(environment, "REVOLUT_BUSINESS_ISSUER")
    .toLowerCase();
  if (!SECRET.test(clientId) || !DOMAIN.test(issuer)) {
    fail("sandbox_bootstrap_oauth_config_invalid");
  }
  const privateKeyFile = path.resolve(required(
    environment,
    "REVOLUT_BUSINESS_PRIVATE_KEY_FILE",
  ));
  const authorizationCodeFile = assertOutsideWorkspace(
    path.resolve(required(
      environment,
      "REVOLUT_BUSINESS_AUTHORIZATION_CODE_FILE",
    )),
    "sandbox_bootstrap_authorization_code_must_be_outside_workspace",
  );
  const tokenStageFile = assertOutsideWorkspace(
    path.resolve(required(
      environment,
      "REVOLUT_BUSINESS_SANDBOX_TOKEN_FILE",
    )),
    "sandbox_bootstrap_token_stage_must_be_outside_workspace",
  );
  const outputFile = assertOutsideWorkspace(
    path.resolve(required(
      environment,
      "REVOLUT_BUSINESS_SANDBOX_OUTPUT_FILE",
    )),
    "sandbox_bootstrap_output_must_be_outside_workspace",
  );
  const privateKeyPem = await readPrivateKey(privateKeyFile);
  const currency = required(
    environment,
    "REVOLUT_BUSINESS_SOURCE_CURRENCY",
  ).toUpperCase();
  if (!CURRENCY.test(currency)) fail("sandbox_bootstrap_currency_invalid");
  const preferredSourceId = environment.REVOLUT_BUSINESS_SOURCE_ACCOUNT_ID ||
    null;
  const preferredBeneficiaryId =
    environment.REVOLUT_BUSINESS_BENEFICIARY_ACCOUNT_ID || null;
  if (
    (preferredSourceId && !PROVIDER_UUID.test(preferredSourceId)) ||
    (preferredBeneficiaryId && !PROVIDER_UUID.test(preferredBeneficiaryId))
  ) {
    fail("sandbox_bootstrap_account_id_invalid");
  }
  const timeoutMs = optionalInteger(
    environment,
    "REVOLUT_BUSINESS_TIMEOUT_MS",
    1_000,
    15_000,
    7_000,
  );
  const testUserIndex = optionalInteger(
    environment,
    "REVOLUT_BUSINESS_TEST_USER_INDEX",
    1,
    9,
    1,
  );
  const topupAmount = optionalNumber(
    environment,
    "REVOLUT_BUSINESS_TOPUP_AMOUNT",
    1,
    10_000,
    100,
  );
  const smokeAmountMinor = optionalInteger(
    environment,
    "REVOLUT_BUSINESS_SMOKE_AMOUNT_MINOR",
    1,
    100_000,
    100,
  );
  const maxFeeMinor = optionalInteger(
    environment,
    "REVOLUT_BUSINESS_MAX_FEE_MINOR",
    0,
    100_000,
    1_000,
  );

  bootstrapPhase = "oauth_assertion";
  const clientAssertion = await createClientAssertion({
    clientId,
    issuer,
    privateKeyPem,
  });
  let stagedRefreshToken = await readTokenStage(
    tokenStageFile,
    clientId,
    issuer,
  );
  let form;
  if (stagedRefreshToken) {
    form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stagedRefreshToken,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    });
  } else {
    const authorizationCode = await readSecretFile(
      authorizationCodeFile,
      "sandbox_bootstrap_authorization_code",
    );
    form = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    });
  }
  bootstrapPhase = "oauth_exchange";
  let tokenResponse;
  try {
    tokenResponse = await request("/auth/token", {
      method: "POST",
      form,
      timeoutMs,
    });
  } finally {
    await fs.rm(authorizationCodeFile, { force: true }).catch(() => {});
  }
  bootstrapPhase = "oauth_response_validation";
  if (
    !isSecret(tokenResponse.access_token) ||
    !Number.isInteger(tokenResponse.expires_in) ||
    tokenResponse.expires_in < 60
  ) {
    fail("sandbox_bootstrap_oauth_response_invalid");
  }
  const refreshToken = isSecret(tokenResponse.refresh_token)
    ? tokenResponse.refresh_token
    : stagedRefreshToken;
  bootstrapPhase = "oauth_token_staging";
  if (refreshToken && !stagedRefreshToken) {
    await writeTokenStage(tokenStageFile, {
      clientId,
      issuer,
      refreshToken,
    });
    stagedRefreshToken = refreshToken;
  }

  bootstrapPhase = "source_account";
  const accounts = await request("/accounts", {
    accessToken: tokenResponse.access_token,
    timeoutMs,
    expect: "array",
  });
  const sourceAccount = selectExactAccount(
    accounts,
    currency,
    preferredSourceId,
    "sandbox_bootstrap_source_account",
  );
  bootstrapPhase = "sandbox_topup";
  const topup = await request("/sandbox/topup", {
    accessToken: tokenResponse.access_token,
    method: "POST",
    body: {
      account_id: sourceAccount.id,
      amount: topupAmount,
      currency,
      reference: "Norva Partners sandbox bootstrap",
      state: "completed",
    },
    timeoutMs,
  });
  if (
    !PROVIDER_UUID.test(topup.id) ||
    String(topup.state).toLowerCase() !== "completed"
  ) {
    fail("sandbox_bootstrap_topup_invalid");
  }

  bootstrapPhase = "counterparty";
  const counterparty = await findOrCreateCounterparty({
    accessToken: tokenResponse.access_token,
    timeoutMs,
    testUserIndex,
  });
  // A Revtag counterparty with a single internal Revolut destination can omit
  // `accounts` in Sandbox. Revolut requires `receiver.account_id` only when
  // several payment methods exist, so preserve an explicit account when the
  // API exposes one and otherwise bind the transfer to the counterparty alone.
  const beneficiaryAccount = counterparty.accounts.length > 0 ||
      preferredBeneficiaryId
    ? selectExactAccount(
      counterparty.accounts,
      currency,
      preferredBeneficiaryId,
      "sandbox_bootstrap_beneficiary_account",
    )
    : null;
  const job = {
    execution_key: `rpx_${randomBytes(12).toString("hex")}`,
    request_id: randomUUID(),
    reference: `NORVA-${randomBytes(6).toString("hex").toUpperCase()}`,
    provider_transaction_id: null,
    beneficiary_token_ref: counterparty.id,
    beneficiary_payment_method_ref: beneficiaryAccount?.id ?? null,
    amount_minor: smokeAmountMinor,
    currency,
    currency_exponent: 2,
  };
  bootstrapPhase = "runtime_output";
  const output = [
    "# Generated locally for the isolated Revolut Business Sandbox only.",
    "# May contain a refresh token. Never copy this file into Git or production.",
    dotenvLine("NORVA_PARTNERS_REVOLUT_API_ENABLED", "true"),
    dotenvLine("REVOLUT_BUSINESS_ENVIRONMENT", "sandbox"),
    dotenvLine("REVOLUT_BUSINESS_SANDBOX_SKIP_TRANSFER_FIELDS", "true"),
    dotenvLine("REVOLUT_BUSINESS_SANDBOX_SIMULATION_ACTION", "complete"),
    dotenvLine("REVOLUT_BUSINESS_CLIENT_ID", clientId),
    dotenvLine("REVOLUT_BUSINESS_ISSUER", issuer),
    dotenvLine(
      "REVOLUT_BUSINESS_PRIVATE_KEY_FILE",
      privateKeyFile.replaceAll("\\", "/"),
    ),
    ...(refreshToken
      ? [dotenvLine("REVOLUT_BUSINESS_REFRESH_TOKEN", refreshToken)]
      : []),
    dotenvLine("REVOLUT_BUSINESS_ACCESS_TOKEN", tokenResponse.access_token),
    dotenvLine(
      "REVOLUT_BUSINESS_ACCESS_TOKEN_EXPIRES_AT",
      Date.now() + tokenResponse.expires_in * 1_000,
    ),
    dotenvLine(
      "REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON",
      JSON.stringify({ [currency]: sourceAccount.id }),
    ),
    dotenvLine(
      "REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON",
      JSON.stringify({ [currency]: maxFeeMinor }),
    ),
    dotenvLine("REVOLUT_BUSINESS_TIMEOUT_MS", timeoutMs),
    dotenvLine("NORVA_REVOLUT_SANDBOX_JOB_JSON", JSON.stringify(job)),
    "",
  ].join("\n");
  await atomicWrite(outputFile, output);
  await fs.rm(tokenStageFile, { force: true });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: "sandbox",
    currency,
    source_account_fingerprint: await fingerprint(sourceAccount.id),
    counterparty_fingerprint: await fingerprint(counterparty.id),
    beneficiary_account_fingerprint: beneficiaryAccount
      ? await fingerprint(beneficiaryAccount.id)
      : null,
    refresh_token_available: Boolean(refreshToken),
    output_file: outputFile,
    authorization_code_deleted: true,
    token_stage_deleted: true,
  })}\n`);
}

main().catch((error) => {
  const code = typeof error?.code === "string"
    ? error.code
    : "revolut_business_sandbox_bootstrap_failed";
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: code,
    phase: bootstrapPhase,
  })}\n`);
  process.exitCode = 1;
});
