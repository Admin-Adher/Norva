const MAX_AUTHORITY_BYTES = 2_000_000;
const MAX_RETRY_AFTER_SECONDS = 6 * 60 * 60;

export const REVENUECAT_AUTHORITY_TIMEOUT_MS = 8_000;
export const REVENUECAT_TRANSFER_RUN_BUDGET_MS = 45_000;

function boundedCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(1_000_000, Math.floor(count)));
}

export class RevenueCatAuthorityRequestError extends Error {
  constructor(code, { retryAfterSeconds = null, stopBatch = false } = {}) {
    super(code);
    this.name = "RevenueCatAuthorityRequestError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.stopBatch = stopBatch;
  }
}

export function parseRevenueCatRetryAfterSeconds(
  rawValue,
  now = new Date(),
) {
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim();
  if (!value) return null;
  if (/^\d{1,8}$/.test(value)) {
    return Math.max(
      1,
      Math.min(MAX_RETRY_AFTER_SECONDS, Number(value)),
    );
  }
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(nowMs) || !Number.isFinite(retryAtMs)) return null;
  return Math.max(
    1,
    Math.min(
      MAX_RETRY_AFTER_SECONDS,
      Math.ceil((retryAtMs - nowMs) / 1000),
    ),
  );
}

export async function fetchRevenueCatTransferAuthority({
  destinationUserId,
  apiKey,
  deadlineMs,
  fetchImpl = globalThis.fetch,
  nowMs = () => Date.now(),
}) {
  const remainingMs = Math.floor(Number(deadlineMs) - Number(nowMs()));
  if (!Number.isFinite(remainingMs) || remainingMs <= 250) {
    throw new RevenueCatAuthorityRequestError("worker_budget_exhausted", {
      stopBatch: true,
    });
  }
  const timeoutMs = Math.max(
    1,
    Math.min(REVENUECAT_AUTHORITY_TIMEOUT_MS, remainingMs - 100),
  );
  let response;
  try {
    response = await fetchImpl(
      `https://api.revenuecat.com/v1/subscribers/${
        encodeURIComponent(destinationUserId)
      }`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (_) {
    throw new RevenueCatAuthorityRequestError(
      "authority_fetch_unavailable",
    );
  }

  if (response.status !== 200) {
    const status = Number.isInteger(response.status)
      ? Math.max(100, Math.min(599, response.status))
      : 500;
    const stopBatch = status === 429 || status === 503;
    throw new RevenueCatAuthorityRequestError(
      `authority_fetch_http_${status}`,
      {
        retryAfterSeconds: stopBatch
          ? parseRevenueCatRetryAfterSeconds(
            response.headers?.get?.("Retry-After") ?? null,
            new Date(nowMs()),
          )
          : null,
        stopBatch,
      },
    );
  }

  const text = await response.text();
  if (!text || text.length > MAX_AUTHORITY_BYTES) {
    throw new RevenueCatAuthorityRequestError("authority_response_invalid");
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new RevenueCatAuthorityRequestError("authority_response_invalid");
  }
}

export function revenueCatTransferHeartbeatStatus(transfers, partners) {
  const degraded = [
    transfers?.partial,
    transfers?.retry,
    transfers?.dead_letter,
    transfers?.dead_letter_moved,
    partners?.retry,
    partners?.dead_letter,
    partners?.dead_letter_moved,
  ].some((value) => boundedCount(value) > 0);
  return degraded ? "degraded" : "healthy";
}

export function revenueCatTransferHeartbeatDetails(
  transfers,
  partners,
  durationMs,
  failureCode = null,
) {
  const details = {
    duration_ms: boundedCount(durationMs),
    transfer_leased: boundedCount(transfers?.leased),
    transfer_applied: boundedCount(transfers?.applied),
    transfer_partial: boundedCount(transfers?.partial),
    transfer_retry: boundedCount(transfers?.retry),
    transfer_dead_letter: boundedCount(transfers?.dead_letter),
    transfer_dead_letter_moved: boundedCount(transfers?.dead_letter_moved),
    partner_leased: boundedCount(partners?.leased),
    partner_succeeded: boundedCount(partners?.succeeded),
    partner_retry: boundedCount(partners?.retry),
    partner_dead_letter: boundedCount(partners?.dead_letter),
    partner_dead_letter_moved: boundedCount(partners?.dead_letter_moved),
  };
  if (
    typeof failureCode === "string" &&
    /^[a-z0-9_]{3,80}$/.test(failureCode)
  ) {
    details.failure_code = failureCode;
  }
  return details;
}

export async function runRevenueCatTransferWorkerCycle({
  deadlineMs,
  drainPartnerOutbox,
  drainTransfers,
  recordHeartbeat,
  errorCode = (_error) => "worker_failed",
  nowMs = () => Date.now(),
}) {
  const startedAt = nowMs();
  let partners = null;
  let transfers = null;
  try {
    // Publishing the already-committed Partners observation does not require a
    // RevenueCat network round-trip and must never starve behind authority GETs.
    partners = await drainPartnerOutbox(deadlineMs);
    transfers = await drainTransfers(deadlineMs);
    const status = revenueCatTransferHeartbeatStatus(transfers, partners);
    await recordHeartbeat(
      status,
      revenueCatTransferHeartbeatDetails(
        transfers,
        partners,
        nowMs() - startedAt,
      ),
    );
    return { transfers, partners, heartbeat_status: status };
  } catch (error) {
    try {
      await recordHeartbeat(
        "degraded",
        revenueCatTransferHeartbeatDetails(
          transfers,
          partners,
          nowMs() - startedAt,
          errorCode(error),
        ),
      );
    } catch (_) {
      // The original failure remains authoritative. The caller returns 500 so
      // the cron transport also records that no trustworthy heartbeat landed.
    }
    throw error;
  }
}
