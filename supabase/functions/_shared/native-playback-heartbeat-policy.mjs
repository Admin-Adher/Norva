export const NATIVE_HEARTBEAT_ACTIVE_STATUSES = Object.freeze(["pending", "ready"]);
export const NATIVE_HEARTBEAT_GRACE_SECONDS = 2 * 60;
export const NATIVE_HEARTBEAT_MAX_SESSION_AGE_SECONDS = 12 * 60 * 60;
export const NATIVE_HEARTBEAT_MIN_WRITE_INTERVAL_SECONDS = 30;

const ACTIVE_STATUS_SET = new Set(NATIVE_HEARTBEAT_ACTIVE_STATUSES);

function timestampMs(value) {
  if (typeof value === "number") return value;
  return new Date(String(value ?? "")).getTime();
}

/**
 * Pure policy for the authenticated native heartbeat route.
 *
 * The short playback-session expiry continues to own entitlement/concurrency.
 * A first pulse must arrive before that expiry. Only an already-established,
 * recently refreshed chain may remain live afterwards, and no chain can exceed
 * the absolute age bound.
 */
export function decideNativePlaybackHeartbeat({
  nowMs,
  status,
  createdAt,
  nativeHeartbeatAt,
  expiresAt,
}) {
  const now = Number(nowMs);
  const created = timestampMs(createdAt);
  const nativeHeartbeat = nativeHeartbeatAt == null
    ? Number.NaN
    : timestampMs(nativeHeartbeatAt);
  const expires = timestampMs(expiresAt);
  const validBaseTimes = Number.isFinite(now) &&
    Number.isFinite(created) &&
    Number.isFinite(expires);
  const hasHeartbeatChain = Number.isFinite(nativeHeartbeat);
  const validHeartbeat = nativeHeartbeatAt == null || (
    hasHeartbeatChain &&
    created <= nativeHeartbeat &&
    nativeHeartbeat <= now
  );
  const activeStatus = ACTIVE_STATUS_SET.has(String(status ?? ""));
  const ageAllowed = validBaseTimes &&
    validHeartbeat &&
    created <= now &&
    created <= expires &&
    now - created <= NATIVE_HEARTBEAT_MAX_SESSION_AGE_SECONDS * 1000;
  const graceCutoffMs = now - NATIVE_HEARTBEAT_GRACE_SECONDS * 1000;
  const writeCutoffMs = now - NATIVE_HEARTBEAT_MIN_WRITE_INTERVAL_SECONDS * 1000;
  const livenessAllowed = validBaseTimes && validHeartbeat &&
    (expires > now || (hasHeartbeatChain && nativeHeartbeat > graceCutoffMs));
  const accepted = activeStatus && ageAllowed && livenessAllowed;

  return {
    accepted,
    shouldWrite: accepted && (!hasHeartbeatChain || nativeHeartbeat <= writeCutoffMs),
    hasHeartbeatChain,
    graceCutoffMs,
    writeCutoffMs,
  };
}
