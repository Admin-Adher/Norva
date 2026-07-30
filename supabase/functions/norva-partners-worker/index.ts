// Norva Partners financial worker.
//
// This endpoint is called only by pg_cron with NORVA_CRON_SHARED_SECRET,
// verified by the database. It leases bounded batches, delegates all monetary
// arithmetic and immutable ledger writes to SECURITY DEFINER RPCs, matures only
// database-selected J+45 accruals, and runs shadow reconciliation in dry-run
// mode. It never calls another Edge Function or a payout provider.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  classifyPartnersWorkerRpcFailure,
  sha256Hex,
} from "../_shared/partners-finance.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const BATCH_SIZE = boundedInt(
  Deno.env.get("NORVA_PARTNERS_WORKER_BATCH"),
  20,
  1,
  50,
);
const MAX_BATCHES = boundedInt(
  Deno.env.get("NORVA_PARTNERS_WORKER_MAX_BATCHES"),
  2,
  1,
  8,
);
const LEASE_SECONDS = boundedInt(
  Deno.env.get("NORVA_PARTNERS_WORKER_LEASE_SECONDS"),
  90,
  30,
  300,
);
const SHADOW_WINDOW_HOURS = boundedInt(
  Deno.env.get("NORVA_PARTNERS_SHADOW_WINDOW_HOURS"),
  24,
  1,
  24 * 7,
);

type JsonRecord = Record<string, unknown>;
type JobKind = "commission" | "correction" | "maturation";
type WorkerName = JobKind | "reconciliation";
type JobCounts = {
  leased: number;
  succeeded: number;
  retry: number;
  dead_letter: number;
  lease_lost: number;
};
type LeaseJob = {
  key: string;
  kind?: "accrual" | "reversal";
  fact_key?: string;
  ledger_entry_key?: string;
};

class RpcFailure extends Error {
  code: string;

  constructor(scope: string, code: string) {
    super(`${scope}:${code}`);
    this.name = "RpcFailure";
    this.code = code;
  }
}

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
  const candidate = Array.isArray(value) ? value[0] : value;
  return recordOrEmpty(candidate);
}

function rpcCode(error: unknown): string {
  const code = recordOrEmpty(error).code;
  return typeof code === "string" && /^[A-Z0-9]{4,8}$/.test(code)
    ? code
    : "unknown";
}

function sanitizedFailureCode(error: unknown): string {
  const raw = error instanceof RpcFailure ? error.code : "unknown";
  return /^[A-Za-z0-9_]{2,32}$/.test(raw) ? raw.toLowerCase() : "unknown";
}

function completionErrorCode(
  classification: { outcome: string; code: string },
): string {
  if (classification.outcome === "dead_letter") {
    return classification.code === "P0006"
      ? "unknown_signed_resource"
      : "invalid_financial_job";
  }
  return "worker_rpc_retry";
}

function emptyCounts(): JobCounts {
  return { leased: 0, succeeded: 0, retry: 0, dead_letter: 0, lease_lost: 0 };
}

function validateLeaseEnvelope(
  value: unknown,
  kind: JobKind,
): { jobs: LeaseJob[] } {
  const envelope = unwrapRpcJson(value);
  const jobs = Array.isArray(envelope.jobs)
    ? envelope.jobs.map(recordOrEmpty)
    : null;
  const keyPattern = kind === "commission"
    ? /^job_[0-9a-f]{24}$/
    : kind === "correction"
    ? /^crw_[0-9a-f]{24}$/
    : /^mat_[0-9a-f]{24}$/;
  if (
    Number(envelope.schema_version) !== 1 ||
    typeof envelope.leased_until !== "string" ||
    !jobs ||
    jobs.some((job) =>
      !keyPattern.test(String(job.key ?? "")) ||
      (
        kind === "commission" &&
        (
          !["accrual", "reversal"].includes(String(job.kind ?? "")) ||
          !/^fac_[0-9a-f]{24}$/.test(String(job.fact_key ?? ""))
        )
      ) ||
      (
        kind === "maturation" &&
        !/^led_[0-9a-f]{24}$/.test(String(job.ledger_entry_key ?? ""))
      )
    )
  ) {
    throw new RpcFailure(`${kind}_lease_invalid_response`, "invalid_response");
  }
  return { jobs: jobs as LeaseJob[] };
}

function validateCompletion(
  value: unknown,
  kind: JobKind,
  expectedJobKey: string,
): "succeeded" | "retry" | "dead_letter" {
  const envelope = unwrapRpcJson(value);
  const job = recordOrEmpty(envelope.job);
  const status = String(job.status ?? "");
  const expectedAction = kind === "commission"
    ? "commission_job_completed"
    : kind === "correction"
    ? "chargeback_reversal_job_completed"
    : "maturation_job_completed";
  if (
    Number(envelope.schema_version) !== 1 ||
    envelope.action !== expectedAction ||
    job.key !== expectedJobKey ||
    !["succeeded", "retry", "dead_letter"].includes(status)
  ) {
    throw new RpcFailure("job_complete_invalid_response", "invalid_response");
  }
  return status as "succeeded" | "retry" | "dead_letter";
}

async function rpc(
  db: SupabaseClient,
  name: string,
  args: JsonRecord,
): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new RpcFailure(name, rpcCode(error));
  return data;
}

async function recordHeartbeat(
  db: SupabaseClient,
  worker: WorkerName,
  status: "healthy" | "degraded",
  details: JsonRecord,
): Promise<void> {
  const result = unwrapRpcJson(
    await rpc(db, "partners_worker_heartbeat", {
      p_worker_name: worker,
      p_status: status,
      p_details: details,
    }),
  );
  if (
    Number(result.schema_version) !== 1 ||
    result.action !== "worker_heartbeat_recorded" ||
    result.worker !== worker ||
    result.status !== status
  ) {
    throw new RpcFailure(
      "worker_heartbeat_invalid_response",
      "invalid_response",
    );
  }
}

function rpcNames(kind: JobKind): {
  lease: string;
  complete: string;
} {
  return kind === "commission"
    ? {
      lease: "partners_worker_commission_jobs_lease",
      complete: "partners_worker_commission_job_complete",
    }
    : kind === "correction"
    ? {
      lease: "partners_worker_revolut_dispute_won_jobs_lease",
      complete: "partners_worker_revolut_dispute_won_job_complete",
    }
    : {
      lease: "partners_worker_maturation_lease",
      complete: "partners_worker_maturation_complete",
    };
}

async function completeJob(
  db: SupabaseClient,
  kind: JobKind,
  job: LeaseJob,
  workerId: string,
  leaseTokenHash: string,
  counts: JobCounts,
): Promise<void> {
  const names = rpcNames(kind);
  const args = {
    p_job_key: job.key,
    p_worker_id: workerId,
    p_lease_token_hash: leaseTokenHash,
  };

  try {
    const result = await rpc(db, names.complete, {
      ...args,
      p_outcome: "succeeded",
      p_error_code: null,
    });
    const status = validateCompletion(result, kind, job.key);
    counts[status] += 1;
    return;
  } catch (error) {
    const classification = classifyPartnersWorkerRpcFailure({
      code: error instanceof RpcFailure ? error.code : "unknown",
    });
    if (kind === "correction" && classification.code === "P0006") {
      classification.outcome = "retry";
    }
    if (classification.outcome === "lease_lost") {
      counts.lease_lost += 1;
      return;
    }

    const desiredOutcome = classification.outcome === "dead_letter"
      ? "dead_letter"
      : "retry";
    try {
      const result = await rpc(db, names.complete, {
        ...args,
        p_outcome: desiredOutcome,
        p_error_code: completionErrorCode(classification),
      });
      const status = validateCompletion(result, kind, job.key);
      counts[status] += 1;
    } catch (completionError) {
      if (
        completionError instanceof RpcFailure &&
        completionError.code === "P0004"
      ) {
        // The initial P0004 can mean a legitimate held/not-ready business
        // state, so we first ask the owning lease to schedule a retry. If that
        // CAS itself returns P0004, the lease was actually lost/expired.
        counts.lease_lost += 1;
        return;
      }
      const completionClassification = classifyPartnersWorkerRpcFailure({
        code: completionError instanceof RpcFailure
          ? completionError.code
          : "unknown",
      });
      if (completionClassification.outcome === "lease_lost") {
        counts.lease_lost += 1;
        return;
      }
      // Leave the lease intact. Expiry makes the job retryable without an
      // unsafe direct table mutation.
      throw completionError;
    }
  }
}

async function drainJobKind(
  db: SupabaseClient,
  kind: JobKind,
  workerId: string,
): Promise<JobCounts> {
  const counts = emptyCounts();
  const names = rpcNames(kind);

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const leaseTokenHash = await sha256Hex(crypto.randomUUID());
    const leased = validateLeaseEnvelope(
      await rpc(db, names.lease, {
        p_worker_id: workerId,
        p_lease_token_hash: leaseTokenHash,
        p_limit: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      }),
      kind,
    );
    counts.leased += leased.jobs.length;
    if (!leased.jobs.length) break;

    for (const job of leased.jobs) {
      await completeJob(db, kind, job, workerId, leaseTokenHash, counts);
    }
    if (leased.jobs.length < BATCH_SIZE) break;
  }

  return counts;
}

async function shadowReconcile(
  db: SupabaseClient,
  workerId: string,
): Promise<JsonRecord> {
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - SHADOW_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const result = unwrapRpcJson(
    await rpc(db, "partners_worker_shadow_reconcile", {
      p_worker_id: workerId,
      p_window_start: windowStart.toISOString(),
      p_window_end: windowEnd.toISOString(),
      // P0 is observation-only. A mismatch can alert an operator but this worker
      // never manufactures repair entries or flips a payout/live gate.
      p_dry_run: true,
    }),
  );
  const run = recordOrEmpty(result.run);
  if (
    Number(result.schema_version) !== 1 ||
    !["clean", "mismatch"].includes(String(run.status ?? "")) ||
    run.dry_run !== true
  ) {
    throw new RpcFailure(
      "shadow_reconcile_invalid_response",
      "invalid_response",
    );
  }
  return {
    key: run.key,
    status: run.status,
    facts: run.facts,
    ledger_entries: run.ledger_entries,
    mismatches: run.mismatches,
    dry_run: true,
  };
}

async function recoverKycBindings(
  db: SupabaseClient,
): Promise<{ expired: number }> {
  const result = unwrapRpcJson(
    await rpc(db, "partners_service_kyc_binding_recover", {
      p_limit: BATCH_SIZE,
    }),
  );
  const expired = Number(result.expired);
  if (
    Number(result.schema_version) !== 1 ||
    result.action !== "kyc_binding_recovery_completed" ||
    !Number.isSafeInteger(expired) ||
    expired < 0 ||
    expired > BATCH_SIZE
  ) {
    throw new RpcFailure(
      "kyc_binding_recovery_invalid_response",
      "invalid_response",
    );
  }
  return { expired };
}

async function runObservedTask<T>(
  db: SupabaseClient,
  worker: WorkerName,
  execute: () => Promise<T>,
  healthyDetails: (value: T) => JsonRecord,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value = await execute();
    await recordHeartbeat(db, worker, "healthy", healthyDetails(value));
    return { ok: true, value };
  } catch (error) {
    const errorCode = sanitizedFailureCode(error);
    try {
      await recordHeartbeat(db, worker, "degraded", {
        error_code: errorCode,
      });
    } catch (heartbeatError) {
      console.error("[norva-partners-worker] heartbeat failed", {
        worker,
        code: sanitizedFailureCode(heartbeatError),
      });
    }
    console.error("[norva-partners-worker] task failed", {
      worker,
      code: errorCode,
    });
    return { ok: false };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "Service not configured" }, 500);
  }

  const path =
    new URL(req.url).pathname.replace(/^.*\/norva-partners-worker/, "") || "/";
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
    {
      presented: token,
    },
  );
  if (authError || authorized !== true) {
    return json({ error: "Unauthorized" }, 403);
  }

  const workerId = `partners-worker:${crypto.randomUUID()}`;
  let kycRecovery:
    | { ok: true; value: { expired: number } }
    | { ok: false };
  try {
    kycRecovery = {
      ok: true,
      value: await recoverKycBindings(db),
    };
  } catch (error) {
    console.error("[norva-partners-worker] KYC recovery failed", {
      code: sanitizedFailureCode(error),
    });
    kycRecovery = { ok: false };
  }
  const commission = await runObservedTask(
    db,
    "commission",
    () => drainJobKind(db, "commission", workerId),
    (counts) => ({ ...counts }),
  );
  const correction = await runObservedTask(
    db,
    "correction",
    () => drainJobKind(db, "correction", workerId),
    (counts) => ({ ...counts }),
  );
  const maturation = await runObservedTask(
    db,
    "maturation",
    () => drainJobKind(db, "maturation", workerId),
    (counts) => ({ ...counts }),
  );
  const reconciliation = await runObservedTask(
    db,
    "reconciliation",
    () => shadowReconcile(db, workerId),
    (result) => ({
      status: result.status,
      facts: result.facts,
      ledger_entries: result.ledger_entries,
      mismatches: result.mismatches,
      dry_run: true,
    }),
  );

  if (
    !kycRecovery.ok ||
    !commission.ok ||
    !correction.ok ||
    !maturation.ok ||
    !reconciliation.ok
  ) {
    return json({ error: "Partners worker run failed" }, 500);
  }
  return json({
    ok: true,
    schema_version: 1,
    kyc_recovery: kycRecovery.value,
    commission: commission.value,
    correction: correction.value,
    maturation: maturation.value,
    reconciliation: reconciliation.value,
  });
});
