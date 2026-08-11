import { createClient } from "npm:@supabase/supabase-js@2";
import { loadDiditConfig } from "../_shared/didit-partners.ts";
import { loadDiditPurgeKeyring } from "../_shared/didit-purge-envelope.ts";
import {
  executeDiditPurgeClaim,
  recoverDiditPurgeOrphans,
  sanitizeDiditPurgeClaims,
  sanitizeDiditPurgeOrphans,
} from "../_shared/didit-purge-worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const DIDIT_CONFIG = loadDiditConfig((name) => Deno.env.get(name));
const PURGE_KEYRING = loadDiditPurgeKeyring((name) => Deno.env.get(name));
const BATCH_SIZE = boundedInt(
  Deno.env.get("NORVA_PARTNERS_DIDIT_PURGE_BATCH"),
  10,
  1,
  25,
);
const MAX_BATCHES = boundedInt(
  Deno.env.get("NORVA_PARTNERS_DIDIT_PURGE_MAX_BATCHES"),
  2,
  1,
  4,
);
const LEASE_SECONDS = boundedInt(
  Deno.env.get("NORVA_PARTNERS_DIDIT_PURGE_LEASE_SECONDS"),
  60,
  30,
  300,
);

type Counts = {
  claimed: number;
  purged: number;
  retry: number;
  dead_letter: number;
  orphan_recovered: number;
  orphan_pending: number;
  orphan_recovery_error: number;
  orphaned_source_dead_letter: number;
  database_error: number;
};

Deno.serve(async (request) => {
  const correlationId = crypto.randomUUID();
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed", correlationId }, {
      Allow: "POST",
    });
  }
  const path = new URL(request.url).pathname.replace(
    /^.*\/norva-partners-didit-purge-worker/,
    "",
  ) || "/";
  if (path !== "/cron/run") {
    return json(404, { error: "not_found", correlationId });
  }
  if (
    !SUPABASE_URL || !SERVICE_KEY || !DIDIT_CONFIG || !PURGE_KEYRING
  ) {
    return json(503, { error: "service_not_configured", correlationId });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const heartbeat = async (
    outcome: "running" | "ok" | "partial" | "failed",
    counts: Counts,
  ): Promise<boolean> => {
    const { error } = await db.rpc(
      "partners_service_didit_purge_heartbeat",
      {
        p_outcome: outcome,
        p_claimed_count: counts.claimed,
        p_purged_count: counts.purged,
        p_retry_count: counts.retry,
        p_dead_letter_count: counts.dead_letter,
      },
    );
    return !error;
  };
  const token = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const { data: authorized, error: authorizationError } = await db.rpc(
    "norva_verify_cron_secret",
    { presented: token },
  );
  if (authorizationError || authorized !== true) {
    return json(403, { error: "unauthorized", correlationId });
  }

  const counts: Counts = {
    claimed: 0,
    purged: 0,
    retry: 0,
    dead_letter: 0,
    orphan_recovered: 0,
    orphan_pending: 0,
    orphan_recovery_error: 0,
    orphaned_source_dead_letter: 0,
    database_error: 0,
  };
  if (!await heartbeat("running", counts)) {
    return json(503, { error: "temporarily_unavailable", correlationId });
  }

  try {
    const { data: orphanData, error: orphanError } = await db.rpc(
      "partners_service_didit_purge_orphans",
      {
        p_provider_environment: DIDIT_CONFIG.environment,
        p_limit: 5,
      },
    );
    if (orphanError) {
      counts.database_error += 1;
    } else {
      const orphans = sanitizeDiditPurgeOrphans(orphanData ?? []);
      const recovery = await recoverDiditPurgeOrphans(
        orphans,
        DIDIT_CONFIG,
        PURGE_KEYRING,
      );
      counts.orphan_pending = recovery.pending;
      counts.orphan_recovery_error = recovery.errorCount;
      for (const recovered of recovery.recoveries) {
        const { data: recoverData, error: recoverError } = await db.rpc(
          "partners_service_didit_purge_recover",
          {
            p_provider_session_id: recovered.providerSessionId,
            p_provider_session_envelope: recovered.providerSessionEnvelope,
            p_provider_environment: recovered.providerEnvironment,
          },
        );
        const purgeStatus = recoverError
          ? null
          : rpcText(recoverData, "purge_status");
        if (
          purgeStatus !== "purge_pending" && purgeStatus !== "purged" &&
          purgeStatus !== "purge_dead_letter"
        ) {
          counts.database_error += recoverError ? 1 : 0;
          counts.orphan_recovery_error += 1;
          counts.orphan_pending += 1;
        } else {
          counts.orphan_recovered += 1;
        }
      }
    }

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const { data, error } = await db.rpc(
        "partners_service_didit_purge_claim",
        {
          p_batch_size: BATCH_SIZE,
          p_lease_seconds: LEASE_SECONDS,
        },
      );
      if (error) throw new Error("claim_failed");
      const claims = sanitizeDiditPurgeClaims(data ?? []);
      counts.claimed += claims.length;
      await Promise.all(claims.map(async (claim) => {
        const outcome = await executeDiditPurgeClaim(
          claim,
          DIDIT_CONFIG,
          PURGE_KEYRING,
        );
        if (outcome.kind === "purged") {
          const { error: completeError } = await db.rpc(
            "partners_service_didit_purge_complete",
            {
              p_outbox_id: claim.outboxId,
              p_lease_token: claim.leaseToken,
              p_result: outcome.result,
            },
          );
          if (completeError) counts.database_error += 1;
          else counts.purged += 1;
          return;
        }

        const { data: failureData, error: failureError } = await db.rpc(
          "partners_service_didit_purge_fail",
          {
            p_outbox_id: claim.outboxId,
            p_lease_token: claim.leaseToken,
            p_error_code: outcome.code,
            p_http_status: outcome.status,
            p_retryable: outcome.retryable,
            p_retry_after_seconds: outcome.retryAfterSeconds,
          },
        );
        if (failureError) {
          counts.database_error += 1;
          return;
        }
        const action = rpcAction(failureData);
        if (action === "retry_scheduled") counts.retry += 1;
        else if (action === "dead_lettered") counts.dead_letter += 1;
        else counts.database_error += 1;
      }));
      if (claims.length < BATCH_SIZE) break;
    }

    const { data: statusData, error: statusError } = await db.rpc(
      "partners_service_didit_purge_status",
    );
    const orphanedSourceDeadLetter = statusError
      ? null
      : rpcNonNegativeInteger(statusData, "orphaned_source_dead_letter");
    const orphanedSourcePending = statusError
      ? null
      : rpcNonNegativeInteger(statusData, "orphaned_source_pending");
    if (
      orphanedSourceDeadLetter === null || orphanedSourcePending === null
    ) {
      counts.database_error += 1;
    } else {
      counts.orphaned_source_dead_letter = orphanedSourceDeadLetter;
      counts.orphan_pending = orphanedSourcePending;
      if (orphanedSourceDeadLetter > 0) {
        console.error("[norva-partners-didit-purge] orphaned dead letters", {
          correlationId,
          count: orphanedSourceDeadLetter,
        });
      }
    }

    const finalOutcome = counts.database_error > 0 || counts.dead_letter > 0 ||
        counts.orphan_pending > 0 || counts.orphan_recovery_error > 0 ||
        counts.orphaned_source_dead_letter > 0
      ? "partial"
      : "ok";
    if (!await heartbeat(finalOutcome, counts)) {
      counts.database_error += 1;
    }
    console.info("[norva-partners-didit-purge] completed", {
      outcome: finalOutcome,
      ...counts,
    });
    return json(counts.database_error > 0 ? 503 : 200, {
      data: {
        outcome: finalOutcome,
        claimed: counts.claimed,
        purged: counts.purged,
        retry: counts.retry,
        deadLetter: counts.dead_letter,
        orphanRecovered: counts.orphan_recovered,
        orphanPending: counts.orphan_pending,
        orphanRecoveryError: counts.orphan_recovery_error,
        orphanedSourceDeadLetter: counts.orphaned_source_dead_letter,
      },
      correlationId,
    });
  } catch {
    await heartbeat("failed", counts);
    console.error("[norva-partners-didit-purge] failed", {
      outcome: "failed",
      ...counts,
    });
    return json(503, { error: "temporarily_unavailable", correlationId });
  }
});

function rpcAction(raw: unknown): string | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof candidate !== "object" || candidate === null ||
    Array.isArray(candidate)
  ) return null;
  const action = (candidate as Record<string, unknown>).action;
  return typeof action === "string" ? action : null;
}

function rpcNonNegativeInteger(raw: unknown, key: string): number | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof candidate !== "object" || candidate === null ||
    Array.isArray(candidate)
  ) return null;
  const value = (candidate as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function rpcText(raw: unknown, key: string): string | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof candidate !== "object" || candidate === null ||
    Array.isArray(candidate)
  ) return null;
  const value = (candidate as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!raw || !/^\d{1,4}$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function json(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}
