export const MEDIA_CACHE_CANARY_PROTOCOL = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CANARY_USERS = 32;
const CANARY_STAGES = Object.freeze([
  "off",
  "read",
  "singleflight",
  "live-join",
]);

export function parseMediaCacheCanaryUserHashes(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return Object.freeze([]);
  if (raw.length > MAX_CANARY_USERS * 65) return null;
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  if (
    !entries.length ||
    entries.length > MAX_CANARY_USERS ||
    entries.some((entry) => !SHA256_PATTERN.test(entry))
  ) return null;
  return Object.freeze([...new Set(entries)]);
}

export function buildMediaCacheCanaryConfig(input = {}) {
  const rawHashes = typeof input.userHashes === "string" ? input.userHashes.trim() : "";
  const rawStage = typeof input.stage === "string" ? input.stage.trim().toLowerCase() : "";
  const userHashes = parseMediaCacheCanaryUserHashes(rawHashes);
  const stage = rawStage || "off";
  const hasInput = Boolean(rawHashes || rawStage);
  const validStage = CANARY_STAGES.includes(stage);
  const state = !hasInput
    ? "off"
    : (!userHashes || !validStage
      ? "invalid"
      : (stage === "off" || userHashes.length === 0 ? "standby" : "ready"));
  return Object.freeze({
    protocol: MEDIA_CACHE_CANARY_PROTOCOL,
    state,
    stage: validStage ? stage : "off",
    userHashes: userHashes ?? Object.freeze([]),
  });
}

function globalFlags(input = {}) {
  const enabled = input.enabled === true;
  const singleflight = enabled && input.singleflight === true;
  const liveJoin = singleflight && input.liveJoin === true;
  return { enabled, singleflight, liveJoin };
}

export function mediaCacheFlagsForUser(config, userHash, global = {}) {
  const flags = globalFlags(global);
  const normalizedHash = typeof userHash === "string" ? userHash.trim().toLowerCase() : "";
  const selected = config?.state === "ready" && SHA256_PATTERN.test(normalizedHash) &&
    config.userHashes.includes(normalizedHash);
  if (!selected) return Object.freeze({ ...flags, selected: false });

  const stage = config.stage;
  return Object.freeze({
    enabled: flags.enabled || ["read", "singleflight", "live-join"].includes(stage),
    singleflight: flags.singleflight || ["singleflight", "live-join"].includes(stage),
    liveJoin: flags.liveJoin || stage === "live-join",
    selected: true,
  });
}

export function mediaCacheServiceFlags(config, global = {}) {
  const flags = globalFlags(global);
  const canaryReady = config?.state === "ready" && config.userHashes.length > 0;
  const stage = canaryReady ? config.stage : "off";
  return Object.freeze({
    enabled: flags.enabled || ["read", "singleflight", "live-join"].includes(stage),
    singleflight: flags.singleflight || ["singleflight", "live-join"].includes(stage),
    liveJoin: flags.liveJoin || stage === "live-join",
  });
}
