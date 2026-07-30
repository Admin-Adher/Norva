// RevenueCat TRANSFER replay and Partners outbox worker.
//
// The webhook persists a privacy-minimized transfer before attempting the
// RevenueCat authority read. This cron-only worker retries quarantined/partial
// transfers under a bounded lease and publishes the independent Partners
// observation only after the entitlement state machine reaches a terminal
// applied state.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  isKnownStorePlan,
  parseRevenueCatProductMap,
} from "../_shared/billing-policy.mjs";
import {
  ingestPartnerFinancialFact,
  revenueCatPartnerObservation,
} from "../_shared/partners-finance.mjs";
import {
  resolveRevenueCatTransferAuthority,
  RevenueCatTransferError,
  revenueCatTransferEvidenceFromStored,
  sha256Hex,
} from "../_shared/revenuecat-transfer.mjs";
import {
  fetchRevenueCatTransferAuthority,
  REVENUECAT_TRANSFER_RUN_BUDGET_MS,
  RevenueCatAuthorityRequestError,
  runRevenueCatTransferWorkerCycle,
} from "../_shared/revenuecat-transfer-worker.mjs";

type JsonRecord = Record<string, unknown>;
type Counts = {
  leased: number;
  applied: number;
  terminal_rejected: number;
  partial: number;
  succeeded: number;
  retry: number;
  dead_letter: number;
  dead_letter_moved: number;
};
type LeaseBatch = {
  jobs: JsonRecord[];
  deadLetterMoved: number;
};
type TransferOutcome = {
  outcome:
    | "applied"
    | "terminal_rejected"
    | "partial"
    | "retry"
    | "dead_letter";
  stopBatch: boolean;
  retryAfterSeconds: number | null;
  errorCode: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const REVENUECAT_SECRET_API_KEY =
  Deno.env.get("NORVA_REVENUECAT_SECRET_API_KEY") ?? "";
const ACCEPT_SANDBOX =
  (Deno.env.get("NORVA_RC_ACCEPT_SANDBOX") ?? "false").toLowerCase() ===
    "true";
const BATCH_SIZE = boundedInt(
  Deno.env.get("NORVA_REVENUECAT_TRANSFER_WORKER_BATCH"),
  4,
  1,
  4,
);
const MAX_BATCHES = boundedInt(
  Deno.env.get("NORVA_REVENUECAT_TRANSFER_WORKER_MAX_BATCHES"),
  1,
  1,
  1,
);
const LEASE_SECONDS = boundedInt(
  Deno.env.get("NORVA_REVENUECAT_TRANSFER_WORKER_LEASE_SECONDS"),
  120,
  120,
  300,
);
const DEFAULT_PRODUCT_MAP = {
  norva_plus_monthly: "plus",
  norva_plus_annual: "plus",
  norva_family_monthly: "family",
  norva_family_annual: "family",
  "norva_plus:monthly": "plus",
  "norva_plus:annual": "plus",
  "norva_family:monthly": "family",
  "norva_family:annual": "family",
};
const PRODUCT_MAP = parseRevenueCatProductMap(
  Deno.env.get("NORVA_RC_PRODUCT_MAP"),
  DEFAULT_PRODUCT_MAP,
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function unwrapRpcJson(value: unknown): JsonRecord {
  return recordOrEmpty(Array.isArray(value) ? value[0] : value);
}

function errorCode(error: unknown, fallback = "worker_retry"): string {
  const raw = error instanceof RevenueCatTransferError
    ? error.code
    : error instanceof Error
    ? error.message
    : fallback;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 80);
  return /^[a-z0-9_]{3,80}$/.test(normalized) ? normalized : fallback;
}

function rpcErrorCode(error: unknown): string {
  const code = recordOrEmpty(error).code;
  return typeof code === "string" && /^[A-Z0-9]{4,8}$/.test(code)
    ? code.toLowerCase()
    : "unknown";
}

async function rpc(
  db: SupabaseClient,
  name: string,
  args: JsonRecord,
): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}_${rpcErrorCode(error)}`);
  return data;
}

function leaseJobs(
  value: unknown,
  kind: "transfer" | "partner",
): LeaseBatch {
  const envelope = unwrapRpcJson(value);
  const jobs = Array.isArray(envelope.jobs)
    ? envelope.jobs.map(recordOrEmpty)
    : null;
  const deadLetterMoved = Number(
    kind === "transfer"
      ? envelope.dead_letter_moved
      : envelope.partner_dead_letter_moved,
  );
  if (
    Number(envelope.schema_version) !== 1 ||
    typeof envelope.leased_until !== "string" ||
    !Number.isSafeInteger(deadLetterMoved) ||
    deadLetterMoved < 0 ||
    deadLetterMoved > 1_000_000 ||
    !jobs ||
    jobs.some((job) =>
      typeof job.event_id !== "string" ||
      !job.event_id ||
      typeof job.event_at !== "string" ||
      !job.event_at ||
      (
        kind === "transfer" &&
        typeof job.payload_fingerprint !== "string"
      )
    )
  ) {
    throw new Error(`${kind}_lease_invalid_response`);
  }
  return { jobs, deadLetterMoved };
}

async function recordTerminalRejection(
  db: SupabaseClient,
  transfer: ReturnType<typeof revenueCatTransferEvidenceFromStored>,
  payloadFingerprint: string,
  reason: string,
  environment: string | null,
  store: string | null,
): Promise<void> {
  await rpc(db, "record_revenuecat_entitlement_transfer", {
    p_event_id: transfer.eventId,
    p_event_at: transfer.eventAt,
    p_payload_fingerprint: payloadFingerprint,
    p_reason: reason,
    p_destination_user_id: transfer.destinationUserId,
    p_source_user_ids: transfer.sourceUserIds,
    p_source_identifier_count: transfer.sourceIdentifierCount,
    p_destination_identifier_count: transfer.destinationIdentifierCount,
    p_environment: environment,
    p_store: store,
    p_retryable: false,
    p_count_delivery: false,
  });
}

async function completeTransferRetry(
  db: SupabaseClient,
  job: JsonRecord,
  workerId: string,
  leaseTokenHash: string,
  error: unknown,
  retryAfterSeconds: number | null = null,
): Promise<"retry" | "dead_letter"> {
  const result = unwrapRpcJson(
    await rpc(db, "revenuecat_transfer_retry_job_complete", {
      p_event_id: String(job.event_id),
      p_worker_id: workerId,
      p_lease_token_hash: leaseTokenHash,
      p_error_code: errorCode(error),
      p_retry_after_seconds: retryAfterSeconds,
    }),
  );
  if (result.status === "dead_letter") return "dead_letter";
  if (!["partial", "quarantined"].includes(String(result.status))) {
    throw new Error("transfer_retry_completion_invalid_response");
  }
  return "retry";
}

async function deferUnattemptedTransfer(
  db: SupabaseClient,
  job: JsonRecord,
  workerId: string,
  leaseTokenHash: string,
  reason: string,
  retryAfterSeconds: number | null,
): Promise<void> {
  await rpc(db, "revenuecat_transfer_retry_job_defer", {
    p_event_id: String(job.event_id),
    p_worker_id: workerId,
    p_lease_token_hash: leaseTokenHash,
    p_error_code: reason,
    p_retry_after_seconds: retryAfterSeconds,
  });
}

async function processTransferJob(
  db: SupabaseClient,
  job: JsonRecord,
  workerId: string,
  leaseTokenHash: string,
  deadlineMs: number,
): Promise<TransferOutcome> {
  try {
    const transfer = revenueCatTransferEvidenceFromStored(job);
    const payloadFingerprint = String(job.payload_fingerprint ?? "");
    if (!/^[0-9a-f]{64}$/.test(payloadFingerprint)) {
      throw new Error("stored_payload_fingerprint_invalid");
    }
    const customerInfo = await fetchRevenueCatTransferAuthority({
      destinationUserId: transfer.destinationUserId,
      apiKey: REVENUECAT_SECRET_API_KEY,
      deadlineMs,
    }) as JsonRecord;
    const authority = resolveRevenueCatTransferAuthority(
      customerInfo,
      transfer,
      PRODUCT_MAP,
      new Date(),
    );
    if (!isKnownStorePlan(authority.patch.plan_code)) {
      throw new Error("authority_plan_invalid");
    }
    if (authority.resolvedEnvironment === "SANDBOX" && !ACCEPT_SANDBOX) {
      await recordTerminalRejection(
        db,
        transfer,
        payloadFingerprint,
        "sandbox_disabled",
        authority.resolvedEnvironment,
        authority.resolvedStore,
      );
      return {
        outcome: "terminal_rejected",
        stopBatch: false,
        retryAfterSeconds: null,
        errorCode: null,
      };
    }
    const authorityFingerprint = await sha256Hex(
      authority.authorityFingerprintMaterial,
    );
    const rawResult = await rpc(
      db,
      "apply_revenuecat_entitlement_transfer",
      {
        p_event_id: transfer.eventId,
        p_event_at: transfer.eventAt,
        p_payload_fingerprint: payloadFingerprint,
        p_authority_fingerprint: authorityFingerprint,
        p_destination_user_id: transfer.destinationUserId,
        p_source_user_ids: transfer.sourceUserIds,
        p_source_identifier_count: transfer.sourceIdentifierCount,
        p_destination_identifier_count: transfer.destinationIdentifierCount,
        p_environment: authority.resolvedEnvironment,
        p_store: authority.resolvedStore,
        p_patch: authority.patch,
      },
    );
    const result = unwrapRpcJson(rawResult);
    if (
      typeof result.terminal !== "boolean" ||
      typeof result.applied !== "boolean"
    ) {
      throw new Error("apply_invalid_response");
    }
    if (result.terminal) {
      return {
        outcome: result.applied ? "applied" : "terminal_rejected",
        stopBatch: false,
        retryAfterSeconds: null,
        errorCode: null,
      };
    }
    return {
      outcome: "partial",
      stopBatch: false,
      retryAfterSeconds: null,
      errorCode: null,
    };
  } catch (error) {
    const retryAfterSeconds = error instanceof RevenueCatAuthorityRequestError
      ? error.retryAfterSeconds
      : null;
    const outcome = await completeTransferRetry(
      db,
      job,
      workerId,
      leaseTokenHash,
      error,
      retryAfterSeconds,
    );
    return {
      outcome,
      stopBatch: error instanceof RevenueCatAuthorityRequestError &&
        error.stopBatch,
      retryAfterSeconds,
      errorCode: errorCode(error),
    };
  }
}

async function processPartnerJob(
  db: SupabaseClient,
  job: JsonRecord,
  workerId: string,
  leaseTokenHash: string,
): Promise<"succeeded" | "retry" | "dead_letter"> {
  const eventId = String(job.event_id ?? "");
  try {
    const destinationUserId = String(job.destination_user_id ?? "");
    const eventAtMs = Date.parse(String(job.event_at ?? ""));
    if (!eventId || !destinationUserId || !Number.isFinite(eventAtMs)) {
      throw new Error("partner_job_invalid");
    }
    const observation = revenueCatPartnerObservation(
      "TRANSFER",
      {
        id: eventId,
        type: "TRANSFER",
        event_timestamp_ms: eventAtMs,
        environment: job.environment,
        store: job.store,
      },
      destinationUserId,
    );
    if (!observation) throw new Error("partner_observation_invalid");
    await ingestPartnerFinancialFact(db, observation);
  } catch (error) {
    const result = unwrapRpcJson(
      await rpc(db, "revenuecat_transfer_partner_job_complete", {
        p_event_id: eventId,
        p_worker_id: workerId,
        p_lease_token_hash: leaseTokenHash,
        p_outcome: "retry",
        p_error_code: errorCode(error, "partner_worker_retry"),
      }),
    );
    if (result.status === "dead_letter") return "dead_letter";
    if (result.status !== "pending") {
      throw new Error("partner_retry_completion_invalid_response");
    }
    return "retry";
  }

  // Keep the idempotent financial write and the lease acknowledgement as two
  // distinct ambiguity boundaries. If the acknowledgement response is lost
  // after commit, do not attempt a contradictory retry completion with the
  // same (already released) lease.
  const result = unwrapRpcJson(
    await rpc(db, "revenuecat_transfer_partner_job_complete", {
      p_event_id: eventId,
      p_worker_id: workerId,
      p_lease_token_hash: leaseTokenHash,
      p_outcome: "succeeded",
      p_error_code: null,
    }),
  );
  if (result.status !== "succeeded") {
    throw new Error("partner_completion_invalid_response");
  }
  return "succeeded";
}

function emptyCounts(): Counts {
  return {
    leased: 0,
    applied: 0,
    terminal_rejected: 0,
    partial: 0,
    succeeded: 0,
    retry: 0,
    dead_letter: 0,
    dead_letter_moved: 0,
  };
}

async function drainTransfers(
  db: SupabaseClient,
  workerId: string,
  deadlineMs: number,
): Promise<Counts> {
  const counts = emptyCounts();
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (Date.now() >= deadlineMs) break;
    const leaseTokenHash = await sha256Hex(crypto.randomUUID());
    if (Date.now() >= deadlineMs) break;
    const leased = leaseJobs(
      await rpc(db, "revenuecat_transfer_retry_jobs_lease", {
        p_worker_id: workerId,
        p_lease_token_hash: leaseTokenHash,
        p_batch_size: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      }),
      "transfer",
    );
    const jobs = leased.jobs;
    counts.dead_letter_moved += leased.deadLetterMoved;
    counts.leased += jobs.length;
    for (let index = 0; index < jobs.length; index += 1) {
      if (Date.now() >= deadlineMs - 250) {
        for (const deferred of jobs.slice(index)) {
          await deferUnattemptedTransfer(
            db,
            deferred,
            workerId,
            leaseTokenHash,
            "worker_budget_exhausted",
            null,
          );
        }
        counts.retry += jobs.length - index;
        break;
      }
      const result = await processTransferJob(
        db,
        jobs[index],
        workerId,
        leaseTokenHash,
        deadlineMs,
      );
      counts[result.outcome] += 1;
      if (result.stopBatch) {
        for (const deferred of jobs.slice(index + 1)) {
          await deferUnattemptedTransfer(
            db,
            deferred,
            workerId,
            leaseTokenHash,
            "authority_batch_deferred",
            result.retryAfterSeconds,
          );
        }
        counts.retry += jobs.length - index - 1;
        break;
      }
    }
    if (jobs.length < BATCH_SIZE) break;
  }
  return counts;
}

async function drainPartnerOutbox(
  db: SupabaseClient,
  workerId: string,
  deadlineMs: number,
): Promise<Counts> {
  const counts = emptyCounts();
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (Date.now() >= deadlineMs) break;
    const leaseTokenHash = await sha256Hex(crypto.randomUUID());
    if (Date.now() >= deadlineMs) break;
    const leased = leaseJobs(
      await rpc(db, "revenuecat_transfer_partner_jobs_lease", {
        p_worker_id: workerId,
        p_lease_token_hash: leaseTokenHash,
        p_batch_size: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      }),
      "partner",
    );
    const jobs = leased.jobs;
    counts.dead_letter_moved += leased.deadLetterMoved;
    counts.leased += jobs.length;
    for (const job of jobs) {
      const outcome = await processPartnerJob(
        db,
        job,
        workerId,
        leaseTokenHash,
      );
      counts[outcome] += 1;
    }
    if (jobs.length < BATCH_SIZE) break;
  }
  return counts;
}

async function recordWorkerHeartbeat(
  db: SupabaseClient,
  status: "healthy" | "degraded",
  details: JsonRecord,
): Promise<void> {
  await rpc(db, "partners_worker_heartbeat", {
    p_worker_name: "revenuecat_transfer",
    p_status: status,
    p_details: details,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "Service not configured" }, 503);
  }
  const path = new URL(req.url).pathname.replace(
    /^.*\/norva-revenuecat-transfer-worker/,
    "",
  ) || "/";
  if (path !== "/cron/run") return json({ error: "Not found" }, 404);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const token = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const { data: authorized, error: authError } = await db.rpc(
    "norva_verify_cron_secret",
    { presented: token },
  );
  if (authError || authorized !== true) {
    return json({ error: "Unauthorized" }, 403);
  }
  const workerId = `revenuecat-transfer-worker:${crypto.randomUUID()}`;
  const deadlineMs = Date.now() + REVENUECAT_TRANSFER_RUN_BUDGET_MS;
  try {
    const result = await runRevenueCatTransferWorkerCycle({
      deadlineMs,
      drainPartnerOutbox: (deadline: number) =>
        drainPartnerOutbox(db, workerId, deadline),
      drainTransfers: (deadline: number) =>
        REVENUECAT_SECRET_API_KEY
          ? drainTransfers(db, workerId, deadline)
          : Promise.reject(new Error("authority_api_not_configured")),
      recordHeartbeat: (
        status: "healthy" | "degraded",
        details: JsonRecord,
      ) => recordWorkerHeartbeat(db, status, details),
      errorCode,
    });
    return json({
      ok: true,
      schema_version: 1,
      transfers: result.transfers,
      partners: result.partners,
      heartbeat_status: result.heartbeat_status,
    });
  } catch (error) {
    const code = errorCode(error);
    console.error("[norva-revenuecat-transfer-worker] run failed", {
      code,
    });
    return json(
      {
        error: code === "authority_api_not_configured"
          ? "Service not configured"
          : "RevenueCat transfer worker run failed",
      },
      code === "authority_api_not_configured" ? 503 : 500,
    );
  }
});
