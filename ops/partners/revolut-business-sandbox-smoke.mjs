#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

import {
  normalizeRevolutPayoutJob,
  readRevolutBusinessConfig,
  RevolutBusinessClient,
  sha256Hex,
} from "../../supabase/functions/_shared/partners-revolut-business.mjs";

const EXPECTED_STATES = Object.freeze({
  complete: "COMPLETED",
  revert: "REVERTED",
  decline: "FAILED",
  fail: "FAILED",
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    fail("sandbox_smoke_requires_protected_config_file");
  }
  return path.resolve(argv[1]);
}

function isInsideWorkspace(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function readProtectedEnvironment(filePath) {
  if (isInsideWorkspace(filePath)) {
    fail("sandbox_smoke_config_must_be_outside_workspace");
  }
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    fail("sandbox_smoke_config_unreadable");
  }
  const parsed = dotenv.parse(source);
  if (!parsed || typeof parsed !== "object") {
    fail("sandbox_smoke_config_invalid");
  }
  return parsed;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`missing_${name.toLowerCase()}`);
  }
  return value;
}

async function readPrivateKey(environment) {
  if (environment.REVOLUT_BUSINESS_PRIVATE_KEY_PEM) {
    fail("sandbox_smoke_inline_private_key_forbidden");
  }
  const filePath = path.resolve(required(
    environment,
    "REVOLUT_BUSINESS_PRIVATE_KEY_FILE",
  ));
  if (isInsideWorkspace(filePath)) {
    fail("sandbox_smoke_private_key_must_be_outside_workspace");
  }
  let privateKey;
  try {
    privateKey = await fs.readFile(filePath, "utf8");
  } catch {
    fail("sandbox_smoke_private_key_unreadable");
  }
  if (
    !/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/.test(
      privateKey,
    )
  ) {
    fail("sandbox_smoke_private_key_invalid");
  }
  return privateKey.trim();
}

function parseJob(environment) {
  let raw;
  try {
    raw = JSON.parse(required(environment, "NORVA_REVOLUT_SANDBOX_JOB_JSON"));
  } catch (error) {
    if (error?.code) throw error;
    fail("invalid_norva_revolut_sandbox_job_json");
  }
  const job = normalizeRevolutPayoutJob(raw);
  if (job.providerTransactionId !== null) {
    fail("sandbox_smoke_requires_new_transfer");
  }
  return raw;
}

async function fingerprint(value) {
  return (await sha256Hex(value)).slice(0, 16);
}

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const environment = await readProtectedEnvironment(configPath);
  if (environment.NORVA_PARTNERS_REVOLUT_API_ENABLED !== "true") {
    fail("sandbox_smoke_requires_explicit_local_api_enable");
  }
  if (environment.REVOLUT_BUSINESS_ENVIRONMENT !== "sandbox") {
    fail("sandbox_smoke_requires_sandbox_environment");
  }
  if (
    environment.REVOLUT_BUSINESS_SANDBOX_SKIP_TRANSFER_FIELDS !== "true"
  ) {
    fail("sandbox_smoke_requires_transfer_fields_override");
  }
  const action = required(
    environment,
    "REVOLUT_BUSINESS_SANDBOX_SIMULATION_ACTION",
  );
  if (!Object.hasOwn(EXPECTED_STATES, action)) {
    fail("invalid_revolut_business_sandbox_simulation_action");
  }

  const privateKeyPem = await readPrivateKey(environment);
  const baseConfig = readRevolutBusinessConfig({
    get: (name) => {
      if (name === "REVOLUT_BUSINESS_PRIVATE_KEY_PEM") return privateKeyPem;
      if (
        name === "REVOLUT_BUSINESS_REFRESH_TOKEN" &&
        !environment[name]
      ) {
        return "sandbox-smoke-access-token-only";
      }
      return environment[name];
    },
  });
  const initialAccessToken = required(
    environment,
    "REVOLUT_BUSINESS_ACCESS_TOKEN",
  );
  const initialAccessTokenExpiresAt = Number(required(
    environment,
    "REVOLUT_BUSINESS_ACCESS_TOKEN_EXPIRES_AT",
  ));
  if (
    !Number.isFinite(initialAccessTokenExpiresAt) ||
    initialAccessTokenExpiresAt <= Date.now() + 60_000
  ) {
    fail("sandbox_smoke_access_token_expired");
  }
  const config = Object.freeze({
    ...baseConfig,
    initialAccessToken,
    initialAccessTokenExpiresAt,
  });
  if (
    config?.environment !== "sandbox" ||
    config?.baseUrl !== "https://sandbox-b2b.revolut.com/api/1.0" ||
    config?.sandboxSkipTransferFields !== true
  ) {
    fail("sandbox_smoke_configuration_not_isolated");
  }

  const rawJob = parseJob(environment);
  const client = new RevolutBusinessClient(config);
  const created = await client.createOrGetTransfer(rawJob);
  const observed = await client.simulateTransferState(
    created.id,
    action,
    rawJob,
  );
  if (observed.state !== EXPECTED_STATES[action]) {
    fail("sandbox_smoke_terminal_state_mismatch");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: "sandbox",
    initial_state: created.state,
    simulated_action: action,
    observed_state: observed.state,
    transaction_fingerprint: await fingerprint(observed.id),
    request_fingerprint: await fingerprint(observed.requestId),
  })}\n`);
}

main().catch((error) => {
  const code = typeof error?.code === "string"
    ? error.code
    : "revolut_business_sandbox_smoke_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = 1;
});
