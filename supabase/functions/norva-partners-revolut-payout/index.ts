// Norva Partners Revolut Business payout boundary.
//
// POST /cron/run
//   Future API rail. It is inert unless the environment kill-switch is the
//   literal "true"; PostgreSQL independently requires the managed feature flag,
//   release gate, active API corridor and an approved live cycle.
//
// POST /manual/statements
//   Finance/AAL2-only. A raw Revolut CSV is normalized in memory and only
//   NORVA-* reference, amount, currency, value date, opaque transaction ID and
//   hashes reach PostgreSQL. The raw statement and foreign rows are never
//   logged or stored.
//
// POST /manual/beneficiaries/propose
//   Finance/AAL2-only. PostgreSQL mints a five-minute one-use authorization;
//   this trusted boundary signs its canonical payload with a versioned HMAC
//   key before creating a pending maker-checker binding. HMAC keys never reach
//   the browser or PostgreSQL.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  readRevolutBeneficiaryHmacConfig,
  RevolutBeneficiaryContractError,
  signRevolutBeneficiaryFingerprint,
} from "../_shared/partners-revolut-beneficiary.mjs";
import {
  readRevolutBusinessConfig,
  revolutApiEnvironmentEnabled,
  RevolutBusinessClient,
  RevolutBusinessContractError,
  sha256Hex,
} from "../_shared/partners-revolut-business.mjs";
import {
  normalizeRevolutStatementCsv,
  RevolutStatementContractError,
} from "../_shared/partners-revolut-statement.mjs";
import {
  assertAllowedOrigin,
  corsHeaders,
  parseAllowedOrigins,
  parseBearerToken,
  PublicApiError,
} from "../_shared/partners-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
  "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  Deno.env.get("NORVA_PARTNERS_ALLOWED_ORIGINS"),
);
// Revolut calls are sequential, while every row returned by the lease RPC gets
// the same expiry. Claiming one job at a time prevents a later row from losing
// its item fence before its provider outcome can be recorded.
const BATCH_SIZE = 1;
const MAX_BATCHES = boundedInt(
  Deno.env.get("NORVA_PARTNERS_REVOLUT_API_MAX_BATCHES"),
  2,
  1,
  4,
);
const PAYOUT_LEASE_SECONDS = boundedInt(
  Deno.env.get("NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS"),
  240,
  60,
  240,
);
const GLOBAL_LEASE_SECONDS = 300;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error("Missing required Norva Partners Revolut configuration");
}

const serviceDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let BENEFICIARY_HMAC_CONFIG:
  | ReturnType<typeof readRevolutBeneficiaryHmacConfig>
  | null = null;
let BENEFICIARY_HMAC_CONFIG_ERROR = false;
let REVOLUT_CONFIG: ReturnType<typeof readRevolutBusinessConfig> = null;
let REVOLUT_CONFIG_ERROR = false;
try {
  REVOLUT_CONFIG = readRevolutBusinessConfig(
    { get: (name: string) => Deno.env.get(name) } as typeof Deno.env,
  );
} catch {
  REVOLUT_CONFIG_ERROR = true;
}
const REVOLUT_CLIENT = REVOLUT_CONFIG
  ? new RevolutBusinessClient(REVOLUT_CONFIG)
  : null;

type JsonRecord = Record<string, unknown>;

class EdgeError extends Error {
  status: number;
  code: string;
  publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(code);
    this.name = "EdgeError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

Deno.serve(async (req) => {
  const route = new URL(req.url).pathname.replace(
    /^.*\/norva-partners-revolut-payout/,
    "",
  ) || "/";
  const isStatement = route === "/manual/statements";
  const isBeneficiaryProposal = route === "/manual/beneficiaries/propose";
  const isBrowserRoute = isStatement || isBeneficiaryProposal;
  try {
    if (req.method === "OPTIONS" && isBrowserRoute) {
      const origin = req.headers.get("Origin");
      assertAllowedOrigin(origin, ALLOWED_ORIGINS);
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin, ALLOWED_ORIGINS),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (req.method !== "POST") {
      throw new EdgeError(405, "method_not_allowed", "Method not allowed.");
    }
    if (route === "/cron/run") return await handleCron(req);
    if (isStatement) return await handleStatement(req);
    if (isBeneficiaryProposal) {
      return await handleBeneficiaryProposal(req);
    }
    throw new EdgeError(404, "route_not_found", "Route not found.");
  } catch (error) {
    const problem = publicProblem(error);
    console.error("[norva-partners-revolut-payout] request failed", {
      route,
      code: problem.code,
    });
    return json(
      { error: { code: problem.code, message: problem.publicMessage } },
      problem.status,
      isBrowserRoute ? req : null,
    );
  }
});

async function handleCron(req: Request) {
  await requireCron(req);
  if (
    !revolutApiEnvironmentEnabled(
      { get: (name: string) => Deno.env.get(name) } as typeof Deno.env,
    )
  ) {
    return json({
      ok: true,
      mode: "revolut_api",
      enabled: false,
      leased: 0,
      observed: 0,
      completed: 0,
      pending: 0,
      terminal_exception: 0,
      retried: 0,
      dead_letter: 0,
    });
  }

  const workerId = `partners-revolut:${crypto.randomUUID()}`;
  const leaseHash = await sha256Hex(crypto.randomUUID());
  const acquired = recordOrEmpty(
    await serviceRpc("partners_worker_revolut_global_lease_acquire", {
      p_worker_id: workerId,
      p_lease_token_hash: leaseHash,
      p_lease_seconds: GLOBAL_LEASE_SECONDS,
    }),
  );
  if (
    acquired.schema_version !== 1 ||
    ![
      "revolut_api_disabled",
      "revolut_api_global_lease_acquired",
      "revolut_api_global_lease_busy",
    ].includes(String(acquired.action ?? "")) ||
    typeof acquired.acquired !== "boolean"
  ) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }
  if (acquired.action === "revolut_api_disabled") {
    return json({
      ok: true,
      mode: "revolut_api",
      enabled: false,
      leased: 0,
      observed: 0,
      completed: 0,
      pending: 0,
      terminal_exception: 0,
      retried: 0,
      dead_letter: 0,
    });
  }
  if (acquired.action === "revolut_api_global_lease_busy") {
    return json({
      ok: true,
      mode: "revolut_api",
      enabled: true,
      busy: true,
      leased: 0,
      observed: 0,
      completed: 0,
      pending: 0,
      terminal_exception: 0,
      retried: 0,
      dead_letter: 0,
    });
  }
  const generation = Number(acquired.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }

  let leased = 0;
  let observedCount = 0;
  let completed = 0;
  let pending = 0;
  let terminalException = 0;
  let retried = 0;
  let deadLetter = 0;
  try {
    if (REVOLUT_CONFIG_ERROR || !REVOLUT_CLIENT) {
      throw new EdgeError(
        503,
        "revolut_business_not_configured",
        "The Revolut Business payout rail is unavailable.",
      );
    }
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      await renewGlobalLease(workerId, leaseHash, generation);
      const envelope = recordOrEmpty(
        await serviceRpc("partners_worker_revolut_payout_lease", {
          p_worker_id: workerId,
          p_lease_token_hash: leaseHash,
          p_global_lease_generation: generation,
          p_limit: BATCH_SIZE,
          p_lease_seconds: PAYOUT_LEASE_SECONDS,
        }),
      );
      if (
        envelope.schema_version !== 1 ||
        ![
          "revolut_api_disabled",
          "revolut_api_jobs_leased",
        ].includes(String(envelope.action ?? "")) ||
        !Array.isArray(envelope.jobs)
      ) {
        throw new EdgeError(
          503,
          "invalid_service_response",
          "The payout service is unavailable.",
        );
      }
      if (
        envelope.action === "revolut_api_disabled" ||
        envelope.jobs.length === 0
      ) break;

      leased += envelope.jobs.length;
      for (const rawJob of envelope.jobs) {
        const job = recordOrEmpty(rawJob);
        try {
          await renewGlobalLease(workerId, leaseHash, generation);
          const transaction = await REVOLUT_CLIENT.createOrGetTransfer(job);
          await renewGlobalLease(workerId, leaseHash, generation);
          const eventHash = await sha256Hex(
            [
              "norva:partners:revolut-business-observation:v1",
              transaction.id,
              transaction.state,
              transaction.requestId ?? "",
            ].join(":"),
          );
          const observation = recordOrEmpty(
            await serviceRpc("partners_worker_revolut_payout_observe", {
              p_execution_key: job.execution_key,
              p_provider_transaction_id: transaction.id,
              p_provider_state: transaction.state,
              p_provider_event_hash: eventHash,
              p_observed_at: new Date().toISOString(),
              p_worker_id: workerId,
              p_lease_token_hash: leaseHash,
              p_global_lease_generation: generation,
            }),
          );
          if (
            observation.schema_version !== 1 ||
            observation.action !== "revolut_api_observation_recorded"
          ) {
            throw new RevolutBusinessContractError(
              "revolut_business_observation_invalid",
              true,
            );
          }
          observedCount += 1;
          if (transaction.state === "COMPLETED") completed += 1;
          else if (
            ["CREATED", "PENDING", "PROCESSING"].includes(transaction.state)
          ) pending += 1;
          else terminalException += 1;
        } catch (error) {
          await renewGlobalLease(workerId, leaseHash, generation);
          const retryEnvelope = recordOrEmpty(
            await serviceRpc("partners_worker_revolut_payout_retry", {
              p_execution_key: job.execution_key,
              p_worker_id: workerId,
              p_lease_token_hash: leaseHash,
              p_global_lease_generation: generation,
              p_error_code: providerErrorCode(error),
              p_retryable: providerErrorRetryable(error),
            }),
          );
          if (
            retryEnvelope.schema_version !== 1 ||
            retryEnvelope.action !== "revolut_api_job_retried"
          ) {
            throw new EdgeError(
              503,
              "invalid_service_response",
              "The payout service is unavailable.",
            );
          }
          const execution = recordOrEmpty(retryEnvelope.execution);
          if (execution.job_status === "dead_letter") deadLetter += 1;
          else retried += 1;
        }
      }
      if (envelope.jobs.length < BATCH_SIZE) break;
    }
  } finally {
    try {
      await serviceRpc("partners_worker_revolut_global_lease_release", {
        p_worker_id: workerId,
        p_lease_token_hash: leaseHash,
        p_generation: generation,
      });
    } catch {
      console.error("[norva-partners-revolut-payout] lease release failed", {
        code: "revolut_api_global_lease_release_failed",
      });
    }
  }

  return json({
    ok: true,
    mode: "revolut_api",
    enabled: true,
    leased,
    observed: observedCount,
    completed,
    pending,
    terminal_exception: terminalException,
    retried,
    dead_letter: deadLetter,
  });
}

async function renewGlobalLease(
  workerId: string,
  leaseHash: string,
  generation: number,
) {
  const renewed = recordOrEmpty(
    await serviceRpc("partners_worker_revolut_global_lease_renew", {
      p_worker_id: workerId,
      p_lease_token_hash: leaseHash,
      p_generation: generation,
      p_lease_seconds: GLOBAL_LEASE_SECONDS,
    }),
  );
  if (
    renewed.schema_version !== 1 ||
    renewed.action !== "revolut_api_global_lease_renewed" ||
    Number(renewed.generation) !== generation
  ) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }
}

async function handleStatement(req: Request) {
  const origin = req.headers.get("Origin");
  assertAllowedOrigin(origin, ALLOWED_ORIGINS);
  const token = parseBearerToken(req.headers.get("Authorization"));
  const { data: userData, error: userError } = await serviceDb.auth.getUser(
    token,
  );
  if (userError || !userData.user) {
    throw new EdgeError(401, "invalid_access_token", "Unauthorized.");
  }
  const userDb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const context = recordOrEmpty(
    await authenticatedRpc(
      userDb,
      "admin_partners_revolut_statement_context",
      {},
    ),
  );
  const currencyExponents = recordOrEmpty(context.currency_exponents);
  if (
    context.schema_version !== 1 ||
    context.action !== "revolut_statement_context" ||
    Object.keys(currencyExponents).length < 1 ||
    Object.keys(currencyExponents).length > 64 ||
    Object.entries(currencyExponents).some(([currency, exponent]) =>
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isInteger(exponent) ||
      Number(exponent) < 0 ||
      Number(exponent) > 6
    )
  ) {
    throw new EdgeError(
      409,
      "statement_context_unavailable",
      "No authoritative payout currency context is available.",
    );
  }

  // A valid 5 MB CSV may nearly double once quotes, backslashes, tabs and
  // newlines are escaped inside JSON. The parser still enforces the 5 MB raw
  // limit after decoding.
  const body = await readJsonBody(req, 10_100_000);
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.csv !== "string"
  ) {
    throw new EdgeError(
      400,
      "invalid_statement",
      "The Revolut statement is invalid.",
    );
  }
  const normalized = await normalizeRevolutStatementCsv(
    body.csv,
    currencyExponents,
  );
  if (normalized.groups.length !== 1) {
    throw new EdgeError(
      400,
      "mixed_currency_statement",
      "Import one Revolut statement currency at a time.",
    );
  }
  const group = normalized.groups[0];
  // Mint the short-lived, one-use service ticket only after the Finance/AAL2
  // context and the complete statement have been validated. The service RPC
  // consumes it atomically and binds its pseudonymous actor to the import.
  const authorization = recordOrEmpty(
    await authenticatedRpc(
      userDb,
      "admin_partners_revolut_statement_authorize",
      {},
    ),
  );
  const importTicket = String(authorization.import_ticket ?? "").toLowerCase();
  const ticketExpiresAt = Date.parse(String(authorization.expires_at ?? ""));
  const now = Date.now();
  if (
    authorization.schema_version !== 1 ||
    authorization.action !== "revolut_statement_authorized" ||
    authorization.allowed !== true ||
    !/^[0-9a-f]{64}$/.test(importTicket) ||
    !Number.isFinite(ticketExpiresAt) ||
    ticketExpiresAt <= now ||
    ticketExpiresAt > now + 5 * 60_000 + 10_000
  ) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }
  const actorHash = await sha256Hex(userData.user.id);
  const data = await serviceRpc("partners_service_revolut_statement_ingest", {
    p_source_file_hash: normalized.sourceFileHash,
    p_period_start: group.periodStart,
    p_period_end: group.periodEnd,
    p_currency: group.currency,
    p_rows: group.rows,
    p_worker_id: `admin-statement:${actorHash.slice(0, 16)}`,
    p_import_ticket: importTicket,
  });
  return json(
    {
      data: recordOrEmpty(data),
      ignoredRows: normalized.ignoredRowCount,
    },
    200,
    req,
  );
}

async function handleBeneficiaryProposal(req: Request) {
  const origin = req.headers.get("Origin");
  assertAllowedOrigin(origin, ALLOWED_ORIGINS);
  const token = parseBearerToken(req.headers.get("Authorization"));
  const { data: userData, error: userError } = await serviceDb.auth.getUser(
    token,
  );
  if (userError || !userData.user) {
    throw new EdgeError(401, "invalid_access_token", "Unauthorized.");
  }
  const userDb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const body = await readJsonBody(req, 16_384);
  const proposal = parseBeneficiaryProposal(body);
  const hmacConfig = beneficiaryHmacConfig();
  const activeKeyVersion = hmacConfig.activeVersion;
  const authorization = recordOrEmpty(
    await authenticatedRpc(
      userDb,
      "admin_partners_revolut_beneficiary_binding_authorize_by_request",
      {
        p_request_key: proposal.requestKey,
        p_beneficiary_token_ref: proposal.beneficiaryTokenRef,
        p_beneficiary_payment_method_ref: proposal.beneficiaryPaymentMethodRef,
        p_display_masked: proposal.displayMasked,
        p_fingerprint_key_version: activeKeyVersion,
        p_mapping_evidence_hash: proposal.mappingEvidenceHash,
        p_justification: proposal.justification,
      },
    ),
  );
  const ticket = String(authorization.binding_ticket ?? "").toLowerCase();
  const fingerprintPayload = String(
    authorization.fingerprint_payload ?? "",
  );
  const attestationPayload = String(
    authorization.attestation_payload ?? "",
  );
  const keyVersion = Number(authorization.fingerprint_key_version);
  const authorizedCurrency = String(authorization.currency ?? "");
  const expiresAt = Date.parse(String(authorization.expires_at ?? ""));
  const now = Date.now();
  if (
    authorization.schema_version !== 1 ||
    authorization.action !== "revolut_beneficiary_binding_authorized" ||
    !/^rbt_[0-9a-f]{24}\.[0-9a-f]{64}$/.test(ticket) ||
    !fingerprintPayload ||
    new TextEncoder().encode(fingerprintPayload).length > 4096 ||
    !attestationPayload ||
    new TextEncoder().encode(attestationPayload).length > 4096 ||
    keyVersion !== activeKeyVersion ||
    !/^[A-Z]{3}$/.test(authorizedCurrency) ||
    authorization.request_key !== proposal.requestKey ||
    typeof authorization.partner_key !== "string" ||
    !/^prt_[0-9a-f]{24}$/.test(authorization.partner_key) ||
    attestationPayload.includes("account_id=") ||
    !attestationPayload.includes(`request_key=${proposal.requestKey}`) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 5 * 60_000 + 10_000
  ) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }

  const fingerprint = await signRevolutBeneficiaryFingerprint(
    fingerprintPayload,
    keyVersion,
    hmacConfig,
  );
  const attestation = await signRevolutBeneficiaryFingerprint(
    attestationPayload,
    keyVersion,
    hmacConfig,
  );
  const proposed = recordOrEmpty(
    await serviceRpc(
      "partners_service_revolut_beneficiary_binding_propose",
      {
        p_beneficiary_fingerprint_hmac: fingerprint,
        p_mapping_attestation_hmac: attestation,
        p_binding_ticket: ticket,
      },
    ),
  );
  const binding = recordOrEmpty(proposed.binding);
  if (
    proposed.schema_version !== 1 ||
    proposed.action !== "revolut_beneficiary_binding_proposed" ||
    !/^rbb_[0-9a-f]{24}$/.test(String(binding.key ?? "")) ||
    binding.currency !== authorizedCurrency ||
    !Number.isSafeInteger(Number(binding.version)) ||
    Number(binding.version) < 1 ||
    Number(binding.fingerprint_key_version) !== keyVersion ||
    binding.status !== "pending" ||
    binding.display_masked !== proposal.displayMasked ||
    typeof binding.payment_method_configured !== "boolean"
  ) {
    throw new EdgeError(
      503,
      "invalid_service_response",
      "The payout service is unavailable.",
    );
  }
  return json({ data: proposed }, 200, req);
}

function parseBeneficiaryProposal(body: unknown) {
  if (!isRecord(body)) {
    throw new EdgeError(
      400,
      "invalid_beneficiary_proposal",
      "The beneficiary proposal is invalid.",
    );
  }
  const allowedKeys = new Set([
    "request_key",
    "beneficiary_token_ref",
    "beneficiary_payment_method_ref",
    "display_masked",
    "mapping_evidence_hash",
    "justification",
  ]);
  if (
    Object.keys(body).length !== allowedKeys.size ||
    Object.keys(body).some((key) => !allowedKeys.has(key))
  ) {
    throw new EdgeError(
      400,
      "invalid_beneficiary_proposal",
      "The beneficiary proposal is invalid.",
    );
  }
  // Revolut documents UUID identifiers, but its Sandbox can return historical
  // UUID-shaped values without RFC version/variant nibbles. These are provider
  // identifiers, not Norva-owned request UUIDs, so validate the exact UUID
  // shape while keeping the surrounding proposal contract fail-closed.
  const providerUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const requestKey = String(body.request_key ?? "").trim().toLowerCase();
  const beneficiaryTokenRef = String(
    body.beneficiary_token_ref ?? "",
  ).trim().toLowerCase();
  const rawPaymentMethod = body.beneficiary_payment_method_ref;
  const beneficiaryPaymentMethodRef = rawPaymentMethod == null ||
      String(rawPaymentMethod).trim() === ""
    ? null
    : String(rawPaymentMethod).trim().toLowerCase();
  const displayMasked = String(body.display_masked ?? "").trim();
  const mappingEvidenceHash = String(
    body.mapping_evidence_hash ?? "",
  ).trim().toLowerCase();
  const justification = String(body.justification ?? "").trim();
  const compactMasked = displayMasked.replace(/[\s-]/g, "");
  if (
    !/^por_[0-9a-f]{24}$/.test(requestKey) ||
    !providerUuid.test(beneficiaryTokenRef) ||
    (
      beneficiaryPaymentMethodRef !== null &&
      !providerUuid.test(beneficiaryPaymentMethodRef)
    ) ||
    displayMasked.length < 4 ||
    displayMasked.length > 64 ||
    !/[*•]/u.test(displayMasked) ||
    /[\u0000-\u001f\u007f]/u.test(displayMasked) ||
    /[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}/i.test(compactMasked) ||
    /[0-9]{6,}/.test(displayMasked.replace(/[^0-9]/g, "")) ||
    !/^[0-9a-f]{64}$/.test(mappingEvidenceHash) ||
    justification.length < 12 ||
    justification.length > 1000
  ) {
    throw new EdgeError(
      400,
      "invalid_beneficiary_proposal",
      "The beneficiary proposal is invalid.",
    );
  }
  return {
    requestKey,
    beneficiaryTokenRef,
    beneficiaryPaymentMethodRef,
    displayMasked,
    mappingEvidenceHash,
    justification,
  };
}

function beneficiaryHmacConfig() {
  if (BENEFICIARY_HMAC_CONFIG) return BENEFICIARY_HMAC_CONFIG;
  if (BENEFICIARY_HMAC_CONFIG_ERROR) {
    throw new EdgeError(
      503,
      "beneficiary_registry_unavailable",
      "The beneficiary registry is unavailable.",
    );
  }
  try {
    BENEFICIARY_HMAC_CONFIG = readRevolutBeneficiaryHmacConfig(
      { get: (name: string) => Deno.env.get(name) } as typeof Deno.env,
    );
    return BENEFICIARY_HMAC_CONFIG;
  } catch {
    BENEFICIARY_HMAC_CONFIG_ERROR = true;
    throw new EdgeError(
      503,
      "beneficiary_registry_unavailable",
      "The beneficiary registry is unavailable.",
    );
  }
}

async function authenticatedRpc(
  db: typeof serviceDb,
  name: string,
  args: JsonRecord,
): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (!error) return Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (error.code === "42501") {
    throw new EdgeError(403, "finance_aal2_required", "Forbidden.");
  }
  throw new EdgeError(
    503,
    "payout_service_unavailable",
    "The payout service is unavailable.",
  );
}

async function requireCron(req: Request) {
  const presented = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const { data, error } = await serviceDb.rpc("norva_verify_cron_secret", {
    presented,
  });
  if (error || data !== true) {
    throw new EdgeError(403, "forbidden", "Forbidden.");
  }
}

async function serviceRpc(name: string, args: JsonRecord): Promise<unknown> {
  const { data, error } = await serviceDb.rpc(name, args);
  if (!error) return Array.isArray(data) && data.length === 1 ? data[0] : data;
  const contractConflict = [
    "22023",
    "23505",
    "23514",
    "55000",
    "P0004",
    "P0005",
    "P0006",
  ].includes(error.code);
  throw new EdgeError(
    error.code === "42501" ? 403 : contractConflict ? 409 : 503,
    error.code === "42501"
      ? "forbidden"
      : contractConflict
      ? "payout_contract_conflict"
      : "payout_service_unavailable",
    error.code === "42501"
      ? "Forbidden."
      : contractConflict
      ? "The payout state could not be recorded safely."
      : "The payout service is unavailable.",
  );
}

async function readJsonBody(req: Request, maxBytes: number) {
  const contentLength = req.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d{1,9}$/.test(contentLength) || Number(contentLength) > maxBytes)
  ) {
    throw new EdgeError(413, "payload_too_large", "Payload too large.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new EdgeError(400, "invalid_json", "Invalid JSON.");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          await reader.cancel("payload_too_large");
        } catch {
          // Best-effort cancellation only; the public response remains 413.
        }
        throw new EdgeError(413, "payload_too_large", "Payload too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    throw new EdgeError(400, "invalid_json", "Invalid JSON.");
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EdgeError(400, "invalid_json", "Invalid JSON.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EdgeError(400, "invalid_json", "Invalid JSON.");
  }
}

function publicProblem(error: unknown) {
  if (error instanceof EdgeError) return error;
  if (error instanceof PublicApiError) {
    return new EdgeError(error.status, error.code, error.message);
  }
  if (
    error instanceof RevolutStatementContractError ||
    error instanceof RevolutBusinessContractError ||
    error instanceof RevolutBeneficiaryContractError
  ) {
    return new EdgeError(
      error instanceof RevolutBeneficiaryContractError ? 503 : 400,
      error instanceof RevolutBeneficiaryContractError
        ? "beneficiary_registry_unavailable"
        : error.code,
      error instanceof RevolutStatementContractError
        ? "The Revolut statement is invalid."
        : error instanceof RevolutBeneficiaryContractError
        ? "The beneficiary registry is unavailable."
        : "The Revolut Business payout request is invalid.",
    );
  }
  return new EdgeError(
    500,
    "internal_error",
    "The payout service is temporarily unavailable.",
  );
}

function providerErrorCode(error: unknown) {
  const raw = error instanceof RevolutBusinessContractError
    ? error.code
    : error instanceof EdgeError
    ? error.code
    : "revolut_business_unavailable";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .slice(0, 64);
}

function providerErrorRetryable(error: unknown) {
  if (error instanceof RevolutBusinessContractError) {
    return error.retryable === true;
  }
  return error instanceof EdgeError ? error.status >= 500 : true;
}

function json(
  payload: unknown,
  status = 200,
  corsReq: Request | null = null,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (corsReq) {
    Object.assign(
      headers,
      corsHeaders(corsReq.headers.get("Origin"), ALLOWED_ORIGINS),
    );
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
