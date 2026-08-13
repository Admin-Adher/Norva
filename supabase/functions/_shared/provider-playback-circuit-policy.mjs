export const PROVIDER_BUSY_STATUS = 458;
export const PROVIDER_CIRCUIT_BASE_COOLDOWN_MS = 2 * 60 * 1000;
export const PROVIDER_CIRCUIT_MAX_COOLDOWN_MS = 15 * 60 * 1000;

function finiteEpoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function nextProviderCircuit({ nowMs = Date.now(), failureCount = 0 } = {}) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const previous = Math.max(0, Math.min(16, Number.parseInt(String(failureCount), 10) || 0));
  const nextCount = Math.min(16, previous + 1);
  const cooldownMs = Math.min(
    PROVIDER_CIRCUIT_MAX_COOLDOWN_MS,
    PROVIDER_CIRCUIT_BASE_COOLDOWN_MS * (2 ** Math.max(0, nextCount - 1)),
  );
  return {
    failureCount: nextCount,
    cooldownMs,
    blockedUntilMs: safeNow + cooldownMs,
  };
}

/**
 * A client can prove that its own server-created playback session received the
 * provider-busy signal, but it cannot prove independent upstream observations.
 * Client reports therefore open one fixed window and are idempotent while that
 * window is live; they never increase the server-owned failure count.
 *
 * @param {{ nowMs?: number, failureCount?: number, blockedUntil?: string | number | null }} [options]
 */
export function nextClientReportedProviderCircuit({
  nowMs = Date.now(),
  failureCount = 0,
  blockedUntil = null,
} = {}) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeFailureCount = Math.max(
    1,
    Math.min(16, Number.parseInt(String(failureCount), 10) || 1),
  );
  const existingBlockedUntilMs = finiteEpoch(blockedUntil);
  if (existingBlockedUntilMs !== null && existingBlockedUntilMs > safeNow) {
    return {
      failureCount: safeFailureCount,
      blockedUntilMs: existingBlockedUntilMs,
      changed: false,
    };
  }
  return {
    failureCount: safeFailureCount,
    blockedUntilMs: safeNow + PROVIDER_CIRCUIT_BASE_COOLDOWN_MS,
    changed: true,
  };
}

/**
 * @param {{ nowMs?: number, blockedUntil?: string | number | null }} [options]
 */
export function decideProviderCircuit({ nowMs = Date.now(), blockedUntil } = {}) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const blockedUntilMs = finiteEpoch(blockedUntil);
  if (blockedUntilMs === null || blockedUntilMs <= safeNow) {
    return { open: false, retryAfterSeconds: 0, blockedUntilMs };
  }
  return {
    open: true,
    retryAfterSeconds: Math.max(1, Math.ceil((blockedUntilMs - safeNow) / 1000)),
    blockedUntilMs,
  };
}

export function isProviderBusyFailure(value = {}) {
  const code = String(value.code || value.errorCode || '').trim().toUpperCase();
  const upstreamStatus = Number(value.upstreamStatus ?? value.providerStatus ?? value.status);
  return upstreamStatus === PROVIDER_BUSY_STATUS
    || code === 'PROVIDER_BUSY'
    || code === 'PROVIDER_ACCOUNT_BUSY'
    || code === 'BLOCK_HTTP_458'
    || code === 'PROBE_HTTP_458';
}
