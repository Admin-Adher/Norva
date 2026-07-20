const SECONDS_PER_HOUR = 60 * 60;

// Playback sessions deliberately remain short-lived: they participate in the
// concurrent-stream ledger and a client that disappears without running its
// teardown must not lock the account for hours.
export const DEFAULT_PLAYBACK_SESSION_TTL_SECONDS = 15 * 60;
export const MAX_PLAYBACK_SESSION_TTL_SECONDS = 2 * SECONDS_PER_HOUR;

// A /raw URL is stateless and every byte-range request is authenticated again.
// The token therefore has to cover the whole VOD, not just the initial request.
// One extra hour allows normal pauses and slow playback without turning the
// provider URL embedded in the signed token into a long-lived credential.
export const ENGINE_RAW_TOKEN_GRACE_SECONDS = SECONDS_PER_HOUR;
export const ENGINE_RAW_TOKEN_UNKNOWN_DURATION_SECONDS = 4 * SECONDS_PER_HOUR;
export const ENGINE_RAW_TOKEN_MAX_SECONDS = 8 * SECONDS_PER_HOUR;
// A native player normally reads the provider URL directly and only touches its
// signed Gateway fallback if that direct connection dies later. Live sessions
// routinely last several hours, so tying that dormant fallback to the 15-minute
// entitlement TTL makes it expired precisely when it is finally needed.
export const NATIVE_LIVE_FALLBACK_TOKEN_SECONDS = 12 * SECONDS_PER_HOUR;

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveFiniteSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function playbackHintDurationSeconds(value) {
  const hint = asRecord(value);
  const profiles = [
    asRecord(hint.codecProfile),
    asRecord(hint.codec_profile),
    hint,
  ];
  for (const profile of profiles) {
    const duration = positiveFiniteSeconds(
      profile.durationSeconds ?? profile.duration_seconds ?? profile.duration,
    );
    if (duration > 0) return duration;
  }
  return 0;
}

/**
 * Return the lifetime of a VOD media transport: the stateless /raw URL or a
 * gateway transcode session. Non-VOD callers keep the short session TTL.
 *
 * The known-duration path covers a complete replay from byte zero even when a
 * session was created from a resume point. Unknown first-play files receive a
 * bounded four-hour window; subsequent probes normally make the exact duration
 * available in codecProfile.
 */
export function vodTransportTtlSeconds({
  itemType,
  playbackHint,
  sessionTtlSeconds = DEFAULT_PLAYBACK_SESSION_TTL_SECONDS,
} = {}) {
  const safeSessionTtl = Math.max(
    60,
    Math.min(
      MAX_PLAYBACK_SESSION_TTL_SECONDS,
      Math.round(positiveFiniteSeconds(sessionTtlSeconds) || DEFAULT_PLAYBACK_SESSION_TTL_SECONDS),
    ),
  );
  if (itemType !== "movie" && itemType !== "series") return safeSessionTtl;

  const durationSeconds = playbackHintDurationSeconds(playbackHint);
  const durationAwareTtl = durationSeconds > 0
    ? Math.ceil(durationSeconds + ENGINE_RAW_TOKEN_GRACE_SECONDS)
    : ENGINE_RAW_TOKEN_UNKNOWN_DURATION_SECONDS;

  return Math.min(
    ENGINE_RAW_TOKEN_MAX_SECONDS,
    Math.max(safeSessionTtl, durationAwareTtl),
  );
}

export function vodTransportExpiresAt({
  nowMs = Date.now(),
  ...options
} = {}) {
  const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return new Date(safeNowMs + vodTransportTtlSeconds(options) * 1000).toISOString();
}

/**
 * Credential/session lifetime for the actual media transport. VOD is duration
 * aware; live has no finite duration and receives a bounded 12-hour window.
 * The separate playback entitlement record intentionally remains short-lived.
 */
export function playbackTransportTtlSeconds(options = {}) {
  const itemType = options?.itemType;
  const transportTtl = vodTransportTtlSeconds(options);
  if (itemType === "live" || itemType === "channel") {
    return Math.max(transportTtl, NATIVE_LIVE_FALLBACK_TOKEN_SECONDS);
  }
  return transportTtl;
}

export function playbackTransportExpiresAt({
  nowMs = Date.now(),
  ...options
} = {}) {
  const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return new Date(safeNowMs + playbackTransportTtlSeconds(options) * 1000).toISOString();
}

// Compatibility names for the browser byte-pipe. Raw tokens and gateway
// transcode sessions deliberately share the same duration-aware VOD policy.
export const engineRawTokenTtlSeconds = vodTransportTtlSeconds;
export const engineRawTokenExpiresAt = vodTransportExpiresAt;

/**
 * Lifetime of the dormant /raw fallback handed to Android TV/phone alongside
 * a direct provider URL. VOD reuses the duration-aware transport policy; live
 * needs a long fixed window because it has no media duration to derive one.
 * The entitlement session itself remains short-lived and is unaffected.
 */
export function nativeFallbackTokenTtlSeconds(options = {}) {
  return playbackTransportTtlSeconds(options);
}

export function nativeFallbackTokenExpiresAt({
  nowMs = Date.now(),
  ...options
} = {}) {
  const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return new Date(safeNowMs + nativeFallbackTokenTtlSeconds(options) * 1000).toISOString();
}
