// Norva Partners Airwallex boundary.
//
// Routes:
// - POST /beneficiaries   authenticated PERSONAL beneficiary tokenization
// - POST /cron/run        bounded approved-cycle dispatch + authoritative poll
// - POST /cron/reports    bounded Financial Reports reconciliation
// - POST /webhooks/airwallex signed webhook followed by authoritative re-fetch
//
// This function is inert unless NORVA_PARTNERS_PAYOUT_PROVIDER=airwallex and
// every required Airwallex secret is present. PostgreSQL independently checks
// the payout feature flag, release gates, approved live cycle, fiscal/KYC state
// and active country/currency provider route before leasing a transfer.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import {
  AirwallexClient,
  AirwallexContractError,
  loadAirwallexConfig,
  parseAirwallexTransferWebhook,
  parsePersonalBeneficiaryInput,
  sha256Hex,
  verifyAirwallexWebhook,
} from "../_shared/partners-airwallex.mjs";
import {
  AirwallexReportContractError,
  buildTransactionReportRequest,
  isApprovedReportContract,
  loadAirwallexFinancialReportsConfig,
  parseTransactionReconciliationCsv,
  sanitizeFinancialReport,
  sha256Bytes,
} from "../_shared/airwallex-financial-reports.mjs";
import {
  assertAllowedOrigin,
  corsHeaders,
  isUuid,
  mapDatabaseError,
  parseAllowedOrigins,
  parseBearerToken,
  parseIdempotencyKey,
  PublicApiError,
} from "../_shared/partners-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  Deno.env.get("NORVA_PARTNERS_ALLOWED_ORIGINS"),
);
const BATCH_SIZE = boundedInt(
  Deno.env.get("NORVA_PARTNERS_PAYOUT_BATCH"),
  10,
  1,
  25,
);
const MAX_BATCHES = boundedInt(
  Deno.env.get("NORVA_PARTNERS_PAYOUT_MAX_BATCHES"),
  2,
  1,
  4,
);
const LEASE_SECONDS = boundedInt(
  Deno.env.get("NORVA_PARTNERS_PAYOUT_LEASE_SECONDS"),
  90,
  30,
  300,
);
const REPORT_LEASE_SECONDS = boundedInt(
  Deno.env.get("AIRWALLEX_FINANCIAL_REPORTS_LEASE_SECONDS"),
  180,
  60,
  300,
);
const REPORT_BUDGET_MS = boundedInt(
  Deno.env.get("AIRWALLEX_FINANCIAL_REPORTS_BUDGET_MS"),
  45_000,
  10_000,
  50_000,
);

let AIRWALLEX_CONFIG: ReturnType<typeof loadAirwallexConfig> = null;
let AIRWALLEX_CONFIG_ERROR = false;
try {
  AIRWALLEX_CONFIG = loadAirwallexConfig((name: string) => Deno.env.get(name));
} catch {
  AIRWALLEX_CONFIG_ERROR = true;
}
let AIRWALLEX_REPORTS_CONFIG: ReturnType<
  typeof loadAirwallexFinancialReportsConfig
> = null;
let AIRWALLEX_REPORTS_CONFIG_ERROR = false;
try {
  AIRWALLEX_REPORTS_CONFIG = loadAirwallexFinancialReportsConfig(
    (name: string) => Deno.env.get(name),
  );
} catch {
  AIRWALLEX_REPORTS_CONFIG_ERROR = true;
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error("Missing required Norva Partners payout configuration");
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type JsonRecord = Record<string, unknown>;
type LeaseJob = {
  key: string;
  request_id?: string;
  beneficiary_token_ref?: string;
  amount_minor?: number | string;
  currency?: string;
  currency_exponent?: number;
  transfer_method?: string;
  provider_transfer_id?: string;
};
type ReportRun = {
  key: string;
  environment: "sandbox" | "production";
  contract_version: string;
  period_start: string;
  period_end: string;
  file_name: string;
  provider_report_id: string | null;
  provider_status: "PENDING" | "COMPLETED" | null;
  attempt: number;
};

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
  const route =
    new URL(req.url).pathname.replace(/^.*\/norva-partners-payout/, "") ||
    "/";
  try {
    if (req.method === "OPTIONS" && route === "/beneficiaries") {
      const origin = req.headers.get("Origin");
      assertAllowedOrigin(origin, ALLOWED_ORIGINS);
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin, ALLOWED_ORIGINS),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "authorization, content-type, idempotency-key",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (req.method !== "POST") {
      throw new EdgeError(405, "method_not_allowed", "Method not allowed.");
    }
    if (route === "/beneficiaries") {
      return await handleBeneficiary(req);
    }
    if (route === "/cron/run") {
      return await handleCron(req);
    }
    if (route === "/cron/reports") {
      return await handleReportsCron(req);
    }
    if (route === "/webhooks/airwallex") {
      return await handleWebhook(req);
    }
    throw new EdgeError(404, "route_not_found", "Route not found.");
  } catch (error) {
    const problem = publicProblem(error);
    console.error("[norva-partners-payout] request failed", {
      route,
      code: problem.code,
    });
    return json(
      {
        error: {
          code: problem.code,
          message: problem.publicMessage,
        },
      },
      problem.status,
      route === "/beneficiaries" ? req : null,
    );
  }
});

async function handleBeneficiary(req: Request): Promise<Response> {
  const origin = req.headers.get("Origin");
  assertAllowedOrigin(origin, ALLOWED_ORIGINS);
  const client = requireProvider();
  const token = parseBearerToken(req.headers.get("Authorization"));
  const userId = await requireUserId(token, db);
  const idempotencyKey = parseIdempotencyKey(
    req.headers.get("Idempotency-Key"),
  );
  const input = parsePersonalBeneficiaryInput(
    await readJsonBody(req, 12 * 1024),
  );
  const prepared = unwrapRpc(
    await rpc("partners_service_airwallex_beneficiary_prepare", {
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
      p_currency: input.currency,
      p_transfer_method: input.transferMethod,
    }),
  );
  const beneficiary = recordOrEmpty(prepared.beneficiary);
  if (
    prepared.schema_version !== 1 ||
    prepared.action !== "airwallex_beneficiary_prepared"
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
  if (beneficiary.status === "recorded") {
    return json({ data: safeProfileFromPrepared(beneficiary) }, 200, req);
  }
  const reservationKey = String(beneficiary.reservation_key ?? "");
  if (
    beneficiary.status !== "prepared" ||
    !/^pbr_[0-9a-f]{24}$/.test(reservationKey)
  ) {
    throw new EdgeError(
      409,
      "beneficiary_manual_review_required",
      "This payout destination requires a secure manual review.",
    );
  }
  const started = unwrapRpc(
    await rpc("partners_service_airwallex_beneficiary_start", {
      p_user_id: userId,
      p_reservation_key: reservationKey,
    }),
  );
  if (
    started.schema_version !== 1 ||
    started.action !== "airwallex_beneficiary_started" ||
    started.reservation_key !== reservationKey
  ) throw new EdgeError(503, "invalid_service_response", unavailable());

  let provider;
  try {
    provider = await client.createPersonalBeneficiary(input, reservationKey);
  } catch (error) {
    const code = providerErrorCode(error);
    try {
      await rpc("partners_service_airwallex_beneficiary_unknown", {
        p_user_id: userId,
        p_reservation_key: reservationKey,
        p_error_code: code,
      });
    } catch {
      // The provider call has already begun. Failing closed is more important
      // than replacing the original sanitized error with a second RPC error.
    }
    throw new EdgeError(
      503,
      "beneficiary_manual_review_required",
      "The payout destination could not be confirmed automatically.",
    );
  }
  const recorded = unwrapRpc(
    await rpc("partners_service_airwallex_beneficiary_record", {
      p_user_id: userId,
      p_reservation_key: reservationKey,
      p_provider_beneficiary_id: provider.id,
      p_display_masked: input.displayMasked,
    }),
  );
  if (
    recorded.schema_version !== 1 ||
    recorded.action !== "airwallex_beneficiary_recorded"
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
  return json({ data: safeRecordedProfile(recorded.profile) }, 201, req);
}

async function handleCron(req: Request): Promise<Response> {
  await requireCron(req);
  const client = requireProvider();
  const workerId = `partners-payout:${crypto.randomUUID()}`;
  let dispatchCounts = emptyCounts();
  let reconcileCounts = emptyCounts();
  try {
    dispatchCounts = await drainDispatch(client, workerId);
    reconcileCounts = await drainReconciliation(client, workerId);
    await recordHeartbeat("healthy", {
      dispatch_leased: dispatchCounts.leased,
      dispatch_succeeded: dispatchCounts.succeeded,
      dispatch_retry: dispatchCounts.retry,
      reconcile_leased: reconcileCounts.leased,
      reconcile_succeeded: reconcileCounts.succeeded,
      reconcile_retry: reconcileCounts.retry,
    });
  } catch (error) {
    await safeHeartbeat("degraded", {
      error_code: providerErrorCode(error),
    });
    throw error;
  }
  return json({
    ok: true,
    schema_version: 1,
    dispatch: dispatchCounts,
    reconciliation: reconcileCounts,
  });
}

async function handleReportsCron(req: Request): Promise<Response> {
  await requireCron(req);
  const startedAt = Date.now();
  let client: AirwallexClient;
  try {
    client = requireReportsProvider();
  } catch (error) {
    await safeReportHeartbeat("blocked", {
      error_code: providerErrorCode(error),
      state: "not_configured",
    });
    throw error;
  }
  const config = AIRWALLEX_REPORTS_CONFIG!;
  const workerId = `partners-payout-report:${crypto.randomUUID()}`;
  const leaseHash = await sha256Hex(crypto.randomUUID());
  let run: ReportRun | null = null;

  try {
    const leased = validateReportLease(
      await rpc("partners_worker_airwallex_report_lease", {
        p_environment: AIRWALLEX_CONFIG!.environment,
        p_worker_id: workerId,
        p_lease_token_hash: leaseHash,
        p_lookback_days: config.lookbackDays,
        p_lease_seconds: REPORT_LEASE_SECONDS,
      }),
    );
    run = leased.run;
    if (!run) {
      await recordReportHeartbeat("healthy", {
        state: "idle",
        reports_processed: 0,
      });
      return json({
        ok: true,
        schema_version: 1,
        state: "idle",
      });
    }

    const result = await processFinancialReport(
      client,
      run,
      workerId,
      leaseHash,
      startedAt + REPORT_BUDGET_MS,
    );
    await recordReportHeartbeat("healthy", {
      state: result.state,
      report_rows: result.rowCount,
      candidates: result.candidateCount,
      matched: result.matchedCount,
      unmatched: result.unmatchedCount,
    });
    return json({
      ok: true,
      schema_version: 1,
      state: result.state,
      row_count: result.rowCount,
      candidate_count: result.candidateCount,
      matched_count: result.matchedCount,
      unmatched_count: result.unmatchedCount,
    });
  } catch (error) {
    const code = providerErrorCode(error);
    if (run) {
      try {
        const retryAfterSeconds = boundedRetryAfter(error, run.attempt);
        await rpc("partners_worker_airwallex_report_retry", {
          p_report_key: run.key,
          p_worker_id: workerId,
          p_lease_token_hash: leaseHash,
          p_error_code: code,
          p_retry_after_seconds: retryAfterSeconds,
          p_terminal: isTerminalReportError(error),
        });
      } catch {
        // A lost lease is intentionally not replaced with a blind state write.
      }
    }
    await safeReportHeartbeat(
      isTerminalReportError(error) ? "blocked" : "degraded",
      {
        error_code: code,
        state: isTerminalReportError(error) ? "exception" : "retry",
      },
    );
    throw error;
  }
}

async function processFinancialReport(
  client: AirwallexClient,
  run: ReportRun,
  workerId: string,
  leaseHash: string,
  deadline: number,
) {
  const config = AIRWALLEX_REPORTS_CONFIG!;
  ensureReportBudget(deadline);
  const expected = {
    fileName: run.file_name,
    fromDate: run.period_start,
    toDate: run.period_end,
  };
  let report;
  if (run.provider_report_id) {
    report = sanitizeFinancialReport(
      await client.getFinancialReport(run.provider_report_id),
      expected,
    );
  } else {
    report = await recoverOrCreateFinancialReport(client, expected);
  }
  const reportStatus = report.status;
  if (reportStatus !== "PENDING" && reportStatus !== "COMPLETED") {
    throw new AirwallexReportContractError("invalid_report_response");
  }

  const providerRecord = unwrapRpc(
    await rpc("partners_worker_airwallex_report_provider_record", {
      p_report_key: run.key,
      p_worker_id: workerId,
      p_lease_token_hash: leaseHash,
      p_provider_report_id: report.id,
      p_provider_status: reportStatus,
      p_retry_after_seconds: 60,
    }),
  );
  const recordedState = validateReportProviderRecord(
    providerRecord,
    run.key,
    reportStatus,
  );
  if (reportStatus === "PENDING") {
    if (recordedState === "exception") {
      throw new AirwallexReportContractError(
        "provider_report_pending_timeout",
      );
    }
    return {
      state: "pending",
      rowCount: 0,
      candidateCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
    };
  }

  ensureReportBudget(deadline);
  const candidates = validateReportCandidates(
    await rpc("partners_worker_airwallex_report_candidates", {
      p_report_key: run.key,
      p_worker_id: workerId,
      p_lease_token_hash: leaseHash,
    }),
  );
  const content = await client.downloadFinancialReportContent(
    report.id,
    config.maxBytes,
  );
  const contentHash = await sha256Bytes(content.bytes);
  const parsed = await parseTransactionReconciliationCsv(content.bytes, {
    fromDate: run.period_start,
    toDate: run.period_end,
    candidates: candidates.items,
    maxBytes: config.maxBytes,
    maxRows: config.maxRows,
    maxMatches: config.maxMatches,
  });
  if (
    parsed.candidateCount !== candidates.total ||
    parsed.matchedCount + parsed.unmatchedCount !== parsed.candidateCount
  ) {
    throw new AirwallexReportContractError("report_completeness_mismatch");
  }
  if (parsed.unmatchedCount !== 0) {
    throw new AirwallexReportContractError(
      "report_candidates_unmatched",
      { retryable: true },
    );
  }

  ensureReportBudget(deadline);
  const applied = unwrapRpc(
    await rpc("partners_worker_airwallex_report_apply", {
      p_report_key: run.key,
      p_worker_id: workerId,
      p_lease_token_hash: leaseHash,
      p_content_sha256: contentHash,
      p_content_bytes: content.contentLength,
      p_row_count: parsed.rowCount,
      p_candidate_count: parsed.candidateCount,
      p_observations: parsed.matches.map((match) => ({
        amount_minor: match.amountMinor,
        currency: match.currency,
        dispatch_key: match.dispatchKey,
        observed_at: match.observedAt,
        proof_hash: match.proofHash,
        provider_transfer_id: match.providerTransferId,
        settlement_reference: match.settlementReference,
        value_date: match.valueDate,
      })),
    }),
  );
  validateReportApplication(applied, run.key, parsed);
  return {
    state: "completed",
    rowCount: parsed.rowCount,
    candidateCount: parsed.candidateCount,
    matchedCount: parsed.matchedCount,
    unmatchedCount: parsed.unmatchedCount,
  };
}

async function recoverOrCreateFinancialReport(
  client: AirwallexClient,
  expected: { fileName: string; fromDate: string; toDate: string },
) {
  const matches = [];
  for (let page = 0; page < 3; page += 1) {
    const listed = recordOrEmpty(await client.listFinancialReports(page));
    const items = Array.isArray(listed.items) ? listed.items : null;
    if (!items || items.length > 100 || typeof listed.has_more !== "boolean") {
      throw new AirwallexReportContractError("invalid_report_list");
    }
    for (const item of items) {
      const candidate = recordOrEmpty(item);
      if (candidate.file_name === expected.fileName) {
        matches.push(sanitizeFinancialReport(candidate, expected));
      }
    }
    if (!listed.has_more) break;
    if (page === 2) {
      throw new AirwallexReportContractError("report_recovery_incomplete");
    }
  }
  if (matches.length > 1) {
    throw new AirwallexReportContractError("duplicate_provider_report");
  }
  if (matches.length === 1) return matches[0];

  const request = buildTransactionReportRequest(expected);
  return sanitizeFinancialReport(
    await client.createFinancialReport(request),
    expected,
  );
}

async function handleWebhook(req: Request): Promise<Response> {
  const client = requireProvider();
  const rawBody = await readRawBody(req, 64 * 1024);
  const timestamp = req.headers.get("x-timestamp") ?? "";
  const signature = req.headers.get("x-signature") ?? "";
  if (
    !await verifyAirwallexWebhook({
      rawBody,
      timestamp,
      signature,
      secret: AIRWALLEX_CONFIG?.webhookSecret ?? "",
      toleranceMs: AIRWALLEX_CONFIG?.webhookToleranceMs ?? 0,
    })
  ) {
    throw new EdgeError(401, "invalid_webhook_signature", "Unauthorized.");
  }
  const event = parseAirwallexTransferWebhook(rawBody);
  // The signed payload is a wake-up signal, never the financial source of
  // truth. Re-fetch the transfer over the authenticated API before mutation.
  const transfer = await client.getTransfer(event.transferId);
  const eventHash = await sha256Hex(event.eventId);
  const observed = unwrapRpc(
    await rpc("partners_worker_airwallex_observation_record", {
      p_dispatch_key: null,
      p_provider_transfer_id: transfer.id,
      p_provider_state: transfer.state,
      p_provider_status: transfer.providerStatus,
      p_funding_status: transfer.fundingStatus,
      p_provider_event_hash: eventHash,
      p_observed_at: transfer.updatedAt ?? new Date().toISOString(),
      p_worker_id: null,
      p_lease_token_hash: null,
    }),
  );
  validateObservation(observed);
  return json({ ok: true });
}

async function drainDispatch(
  client: AirwallexClient,
  workerId: string,
): Promise<ReturnType<typeof emptyCounts>> {
  const counts = emptyCounts();
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const leaseHash = await sha256Hex(crypto.randomUUID());
    const jobs = validateLease(
      await rpc("partners_worker_airwallex_dispatch_lease", {
        p_worker_id: workerId,
        p_lease_token_hash: leaseHash,
        p_limit: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      }),
      "dispatch",
    );
    counts.leased += jobs.length;
    if (!jobs.length) break;
    for (const job of jobs) {
      try {
        const transfer = await client.createTransfer(job);
        const observed = unwrapRpc(
          await rpc("partners_worker_airwallex_observation_record", {
            p_dispatch_key: job.key,
            p_provider_transfer_id: transfer.id,
            p_provider_state: transfer.state,
            p_provider_status: transfer.providerStatus,
            p_funding_status: transfer.fundingStatus,
            p_provider_event_hash: null,
            p_observed_at: transfer.updatedAt ?? new Date().toISOString(),
            p_worker_id: workerId,
            p_lease_token_hash: leaseHash,
          }),
        );
        validateObservation(observed, job.key);
        counts.succeeded += 1;
      } catch (error) {
        try {
          await rpc("partners_worker_airwallex_dispatch_retry", {
            p_dispatch_key: job.key,
            p_worker_id: workerId,
            p_lease_token_hash: leaseHash,
            p_error_code: providerErrorCode(error),
          });
          counts.retry += 1;
        } catch {
          counts.lease_lost += 1;
        }
      }
    }
    if (jobs.length < BATCH_SIZE) break;
  }
  return counts;
}

async function drainReconciliation(
  client: AirwallexClient,
  workerId: string,
): Promise<ReturnType<typeof emptyCounts>> {
  const counts = emptyCounts();
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const leaseHash = await sha256Hex(crypto.randomUUID());
    const jobs = validateLease(
      await rpc("partners_worker_airwallex_reconcile_lease", {
        p_worker_id: workerId,
        p_lease_token_hash: leaseHash,
        p_limit: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      }),
      "reconcile",
    );
    counts.leased += jobs.length;
    if (!jobs.length) break;
    for (const job of jobs) {
      try {
        const transfer = await client.getTransfer(job.provider_transfer_id);
        const observed = unwrapRpc(
          await rpc("partners_worker_airwallex_observation_record", {
            p_dispatch_key: job.key,
            p_provider_transfer_id: transfer.id,
            p_provider_state: transfer.state,
            p_provider_status: transfer.providerStatus,
            p_funding_status: transfer.fundingStatus,
            p_provider_event_hash: null,
            p_observed_at: transfer.updatedAt ?? new Date().toISOString(),
            p_worker_id: workerId,
            p_lease_token_hash: leaseHash,
          }),
        );
        validateObservation(observed, job.key);
        counts.succeeded += 1;
      } catch {
        // Reconciliation never guesses. Leaving the lease to expire makes the
        // same authoritative GET retryable without altering financial state.
        counts.retry += 1;
      }
    }
    if (jobs.length < BATCH_SIZE) break;
  }
  return counts;
}

function validateLease(raw: unknown, kind: "dispatch" | "reconcile") {
  const envelope = unwrapRpc(raw);
  const jobs = Array.isArray(envelope.jobs)
    ? envelope.jobs.map(recordOrEmpty)
    : null;
  if (
    envelope.schema_version !== 1 ||
    typeof envelope.leased_until !== "string" ||
    !jobs ||
    jobs.length > BATCH_SIZE ||
    jobs.some((job) =>
      !/^pds_[0-9a-f]{24}$/.test(String(job.key ?? "")) ||
      (
        kind === "dispatch" &&
        (
          !/^[A-Za-z0-9._:-]{8,50}$/.test(
            String(job.request_id ?? ""),
          ) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(
            String(job.beneficiary_token_ref ?? ""),
          ) ||
          !/^[A-Z]{3}$/.test(String(job.currency ?? "")) ||
          !["LOCAL", "SWIFT"].includes(String(job.transfer_method ?? ""))
        )
      ) ||
      (
        kind === "reconcile" &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(
          String(job.provider_transfer_id ?? ""),
        )
      )
    )
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
  return jobs as LeaseJob[];
}

function validateObservation(raw: JsonRecord, expectedKey?: string) {
  const dispatch = recordOrEmpty(raw.dispatch);
  if (
    raw.schema_version !== 1 ||
    raw.action !== "airwallex_observation_recorded" ||
    typeof raw.replayed !== "boolean" ||
    !/^pds_[0-9a-f]{24}$/.test(String(dispatch.key ?? "")) ||
    (expectedKey && dispatch.key !== expectedKey) ||
    ![
      "SCHEDULED",
      "PROCESSING",
      "SENT",
      "PAID",
      "FAILED",
      "CANCELLED",
      "REVERSED",
    ].includes(String(dispatch.state ?? "")) ||
    ![
      "not_ready",
      "pending",
      "confirmed",
      "exception",
      "reversed",
    ].includes(String(dispatch.reconciliation_status ?? ""))
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
}

function validateReportLease(raw: unknown): { run: ReportRun | null } {
  const envelope = unwrapRpc(raw);
  const contract = recordOrEmpty(envelope.contract);
  const expectedEnvironment = String(
    AIRWALLEX_CONFIG?.environment ?? "",
  );
  if (
    envelope.schema_version !== 1 ||
    ![
      "airwallex_report_leased",
      "airwallex_report_lease_empty",
    ].includes(String(envelope.action ?? "")) ||
    !isApprovedReportContract(contract, expectedEnvironment)
  ) {
    throw new EdgeError(503, "invalid_service_response", unavailable());
  }
  if (envelope.run === null) {
    if (envelope.action !== "airwallex_report_lease_empty") {
      throw new EdgeError(503, "invalid_service_response", unavailable());
    }
    return { run: null };
  }
  const value = recordOrEmpty(envelope.run);
  const providerReportId = value.provider_report_id;
  const providerStatus = value.provider_status;
  const run: ReportRun = {
    key: String(value.key ?? ""),
    environment: String(value.environment ?? "") as ReportRun["environment"],
    contract_version: String(value.contract_version ?? ""),
    period_start: String(value.period_start ?? ""),
    period_end: String(value.period_end ?? ""),
    file_name: String(value.file_name ?? ""),
    provider_report_id: providerReportId === null
      ? null
      : String(providerReportId ?? ""),
    provider_status: providerStatus === null
      ? null
      : String(providerStatus ?? "") as ReportRun["provider_status"],
    attempt: Number(value.attempt),
  };
  if (
    envelope.action !== "airwallex_report_leased" ||
    !/^afr_[0-9a-f]{24}$/.test(run.key) ||
    run.environment !== expectedEnvironment ||
    !/^\d{4}-\d{2}-\d{2}$/.test(run.period_start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(run.period_end) ||
    !/^NORVA_TRANSACTION_RECON_\d{4}_\d{2}_\d{2}_[0-9a-f]{12}\.csv$/
      .test(run.file_name) ||
    (
      run.provider_report_id !== null &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(
        run.provider_report_id,
      )
    ) ||
    ![null, "PENDING", "COMPLETED"].includes(run.provider_status) ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    run.attempt > 20
  ) {
    throw new EdgeError(503, "invalid_service_response", unavailable());
  }
  return { run };
}

function validateReportProviderRecord(
  raw: JsonRecord,
  expectedKey: string,
  expectedProviderStatus: "PENDING" | "COMPLETED",
) {
  const run = recordOrEmpty(raw.run);
  const expectedState = expectedProviderStatus === "PENDING"
    ? ["pending", "exception"]
    : ["leased"];
  if (
    raw.schema_version !== 1 ||
    raw.action !== "airwallex_report_provider_recorded" ||
    run.key !== expectedKey ||
    run.provider_status !== expectedProviderStatus ||
    !expectedState.includes(String(run.status ?? ""))
  ) {
    throw new EdgeError(503, "invalid_service_response", unavailable());
  }
  return String(run.status);
}

function validateReportCandidates(raw: unknown) {
  const envelope = unwrapRpc(raw);
  const items = Array.isArray(envelope.items) ? envelope.items : null;
  const total = Number(envelope.total);
  if (
    envelope.schema_version !== 1 ||
    envelope.action !== "airwallex_report_candidates" ||
    !Number.isInteger(total) ||
    total < 0 ||
    total > 250 ||
    envelope.truncated !== false ||
    !items ||
    items.length !== total
  ) {
    throw new AirwallexReportContractError("invalid_report_candidates");
  }
  return { total, items };
}

function validateReportApplication(
  raw: JsonRecord,
  expectedKey: string,
  parsed: {
    rowCount: number;
    candidateCount: number;
    matchedCount: number;
    unmatchedCount: number;
  },
) {
  const run = recordOrEmpty(raw.run);
  if (
    raw.schema_version !== 1 ||
    raw.action !== "airwallex_report_applied" ||
    raw.observed_count !== parsed.candidateCount ||
    run.key !== expectedKey ||
    run.status !== "completed" ||
    run.row_count !== parsed.rowCount ||
    run.candidate_count !== parsed.candidateCount ||
    run.matched_count !== parsed.matchedCount ||
    run.unmatched_count !== parsed.unmatchedCount
  ) {
    throw new EdgeError(503, "invalid_service_response", unavailable());
  }
}

function ensureReportBudget(deadline: number) {
  if (!Number.isFinite(deadline) || Date.now() + 1500 >= deadline) {
    throw new AirwallexReportContractError("report_budget_exhausted", {
      retryable: true,
    });
  }
}

async function requireCron(req: Request) {
  const presented = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const { data, error } = await db.rpc("norva_verify_cron_secret", {
    presented,
  });
  if (error || data !== true) {
    throw new EdgeError(403, "forbidden", "Forbidden.");
  }
}

async function requireUserId(
  token: string,
  client: SupabaseClient,
): Promise<string> {
  const local = await verifyUserJwtLocally(token);
  if (local === "invalid") {
    throw new EdgeError(401, "invalid_access_token", "Unauthorized.");
  }
  const { data, error } = await client.auth.getUser(token);
  if (
    error ||
    !data.user ||
    !isUuid(data.user.id) ||
    !(
      local === "fallback" ||
      (isUuid(local.id) && local.id === data.user.id)
    )
  ) throw new EdgeError(401, "invalid_access_token", "Unauthorized.");
  return data.user.id;
}

function requireProvider(): AirwallexClient {
  if (AIRWALLEX_CONFIG_ERROR || !AIRWALLEX_CONFIG) {
    throw new EdgeError(
      503,
      "payout_provider_not_configured",
      unavailable(),
    );
  }
  return new AirwallexClient(AIRWALLEX_CONFIG);
}

function requireReportsProvider(): AirwallexClient {
  if (
    AIRWALLEX_REPORTS_CONFIG_ERROR ||
    !AIRWALLEX_REPORTS_CONFIG ||
    AIRWALLEX_CONFIG_ERROR ||
    !AIRWALLEX_CONFIG
  ) {
    throw new EdgeError(
      503,
      "airwallex_reports_not_configured",
      unavailable(),
    );
  }
  return new AirwallexClient(AIRWALLEX_CONFIG);
}

async function rpc(name: string, args: JsonRecord): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const mapped = mapDatabaseError(error, "mutation");
  throw new EdgeError(mapped.status, mapped.code, mapped.message);
}

async function recordHeartbeat(
  status: "healthy" | "degraded",
  details: JsonRecord,
) {
  const result = unwrapRpc(
    await rpc("partners_worker_heartbeat", {
      p_worker_name: "payout",
      p_status: status,
      p_details: details,
    }),
  );
  if (
    result.schema_version !== 1 ||
    result.action !== "worker_heartbeat_recorded" ||
    result.worker !== "payout" ||
    result.status !== status
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
}

async function safeHeartbeat(
  status: "healthy" | "degraded",
  details: JsonRecord,
) {
  try {
    await recordHeartbeat(status, details);
  } catch {
    // Preserve the original failure; heartbeat expiry remains observable.
  }
}

async function recordReportHeartbeat(
  status: "healthy" | "degraded" | "blocked",
  details: JsonRecord,
) {
  const result = unwrapRpc(
    await rpc("partners_worker_heartbeat", {
      p_worker_name: "payout_report",
      p_status: status,
      p_details: details,
    }),
  );
  if (
    result.schema_version !== 1 ||
    result.action !== "worker_heartbeat_recorded" ||
    result.worker !== "payout_report" ||
    result.status !== status
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
}

async function safeReportHeartbeat(
  status: "healthy" | "degraded" | "blocked",
  details: JsonRecord,
) {
  try {
    await recordReportHeartbeat(status, details);
  } catch {
    // Preserve the report failure. Heartbeat expiry remains observable.
  }
}

function safeProfileFromPrepared(raw: JsonRecord) {
  return safeRecordedProfile({
    provider: "airwallex",
    display_masked: raw.display_masked,
    currency: raw.currency,
    transfer_method: raw.transfer_method,
    status: "active",
  });
}

function safeRecordedProfile(raw: unknown) {
  const profile = recordOrEmpty(raw);
  if (
    profile.provider !== "airwallex" ||
    typeof profile.display_masked !== "string" ||
    profile.display_masked.length < 4 ||
    profile.display_masked.length > 64 ||
    !/^[A-Z]{3}$/.test(String(profile.currency ?? "")) ||
    !["LOCAL", "SWIFT"].includes(String(profile.transfer_method ?? "")) ||
    profile.status !== "active"
  ) throw new EdgeError(503, "invalid_service_response", unavailable());
  return {
    schema_version: 1,
    action: "airwallex_beneficiary_recorded",
    profile: {
      provider: "airwallex",
      display_masked: profile.display_masked,
      currency: profile.currency,
      transfer_method: profile.transfer_method,
      status: "active",
    },
  };
}

async function readJsonBody(req: Request, maxBytes: number) {
  const contentType = req.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new EdgeError(
      415,
      "invalid_content_type",
      "Content-Type must be application/json.",
    );
  }
  const text = await readRawBody(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new EdgeError(400, "invalid_request", "Invalid request.");
  }
}

async function readRawBody(req: Request, maxBytes: number) {
  const length = req.headers.get("Content-Length");
  if (
    length !== null &&
    (!/^\d{1,8}$/.test(length) || Number(length) > maxBytes)
  ) throw new EdgeError(413, "payload_too_large", "Payload too large.");
  const text = await req.text();
  if (
    !text ||
    new TextEncoder().encode(text).byteLength > maxBytes
  ) {
    throw new EdgeError(
      text ? 413 : 400,
      text ? "payload_too_large" : "invalid_request",
      text ? "Payload too large." : "Invalid request.",
    );
  }
  return text;
}

function json(
  body: unknown,
  status = 200,
  corsRequest: Request | null = null,
) {
  const origin = corsRequest?.headers.get("Origin") ?? null;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(corsRequest ? corsHeaders(origin, ALLOWED_ORIGINS) : {}),
    },
  });
}

function publicProblem(error: unknown): EdgeError {
  if (error instanceof EdgeError) return error;
  if (error instanceof PublicApiError) {
    return new EdgeError(error.status, error.code, error.message);
  }
  if (error instanceof AirwallexContractError) {
    return new EdgeError(
      error.code === "invalid_request" ||
        error.code === "invalid_beneficiary" ||
        error.code === "invalid_bank_details"
        ? 400
        : 503,
      error.code === "invalid_request" ||
        error.code === "invalid_beneficiary" ||
        error.code === "invalid_bank_details"
        ? "invalid_request"
        : "payout_provider_temporarily_unavailable",
      error.code === "invalid_request" ||
        error.code === "invalid_beneficiary" ||
        error.code === "invalid_bank_details"
        ? "Invalid request."
        : unavailable(),
    );
  }
  if (error instanceof AirwallexReportContractError) {
    return new EdgeError(
      503,
      "airwallex_report_temporarily_unavailable",
      unavailable(),
    );
  }
  return new EdgeError(503, "payout_temporarily_unavailable", unavailable());
}

function providerErrorCode(error: unknown) {
  const value = error instanceof AirwallexContractError ||
      error instanceof AirwallexReportContractError ||
      error instanceof EdgeError
    ? String(error.code)
    : "unknown";
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value) ? value : "unknown";
}

function boundedRetryAfter(error: unknown, attempt: number) {
  const providerDelay = error instanceof AirwallexContractError
    ? error.retryAfterMs
    : null;
  if (
    Number.isInteger(providerDelay) &&
    Number(providerDelay) >= 0
  ) {
    return Math.max(
      30,
      Math.min(21_600, Math.ceil(Number(providerDelay) / 1000)),
    );
  }
  const exponent = Number.isInteger(attempt)
    ? Math.max(0, Math.min(10, attempt))
    : 0;
  return Math.max(30, Math.min(3600, 30 * (2 ** exponent)));
}

function isTerminalReportError(error: unknown) {
  if (error instanceof AirwallexReportContractError) {
    return error.retryable !== true;
  }
  if (error instanceof AirwallexContractError) {
    return error.retryable !== true;
  }
  return error instanceof EdgeError &&
    [
      "invalid_service_response",
      "airwallex_reports_not_configured",
    ].includes(error.code);
}

function unwrapRpc(value: unknown): JsonRecord {
  const candidate = Array.isArray(value) ? value[0] : value;
  return recordOrEmpty(candidate);
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function emptyCounts() {
  return { leased: 0, succeeded: 0, retry: 0, lease_lost: 0 };
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

function unavailable() {
  return "Partner payouts are temporarily unavailable.";
}
