export const MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CANARY_USERS = 32;
const MAX_TOKEN_LENGTH = 512;

function normalizeBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 2048 || /[\u0000\r\n]/.test(raw)) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return null; }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) return null;
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeToken(value) {
  return typeof value === "string" &&
      value.length >= 32 && value.length <= MAX_TOKEN_LENGTH &&
      !/[\u0000-\u0020\u007f]/.test(value)
    ? value
    : null;
}

function normalizeGatewayId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

export function parseMediaGatewayCanaryUserHashes(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return Object.freeze([]);
  if (raw.length > MAX_CANARY_USERS * 65) return null;
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  if (!entries.length || entries.length > MAX_CANARY_USERS || entries.some((entry) => !SHA256_PATTERN.test(entry))) {
    return null;
  }
  return Object.freeze([...new Set(entries)]);
}

function normalizeDefaultRoute(input) {
  const url = normalizeBaseUrl(input?.url);
  const token = normalizeToken(input?.token);
  return url && token
    ? Object.freeze({ kind: "default", url, token, gatewayId: null })
    : null;
}

function normalizeCanaryRoute(input) {
  const url = normalizeBaseUrl(input?.url);
  const token = normalizeToken(input?.token);
  const gatewayId = normalizeGatewayId(input?.gatewayId);
  return url && token && gatewayId
    ? Object.freeze({ kind: "canary", url, token, gatewayId })
    : null;
}

export function buildMediaGatewayRoutingConfig(input = {}) {
  const defaultRoute = normalizeDefaultRoute(input.defaultRoute);
  const canaryUserHashes = parseMediaGatewayCanaryUserHashes(input.canaryUserHashes);
  const canaryRoute = normalizeCanaryRoute(input.canaryRoute);
  const hasCanaryInput = Boolean(
    String(input.canaryRoute?.url ?? "").trim() ||
    String(input.canaryRoute?.token ?? "") ||
    String(input.canaryRoute?.gatewayId ?? "").trim() ||
    String(input.canaryUserHashes ?? "").trim(),
  );
  const canaryState = !hasCanaryInput
    ? "off"
    : (!canaryUserHashes || !canaryRoute
      ? "invalid"
      : (canaryUserHashes.length ? "ready" : "standby"));
  return Object.freeze({
    protocol: MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL,
    defaultRoute,
    canaryRoute,
    canaryUserHashes: canaryUserHashes ?? Object.freeze([]),
    canaryState,
  });
}

export function selectMediaGatewayRouteForUserHash(config, userHash) {
  const normalizedHash = typeof userHash === "string" ? userHash.trim().toLowerCase() : "";
  const selectedForCanary = SHA256_PATTERN.test(normalizedHash) &&
    config?.canaryUserHashes?.includes(normalizedHash);
  if (!selectedForCanary) return config?.defaultRoute ?? null;
  return config?.canaryState === "ready" ? config.canaryRoute : null;
}

export function selectMediaGatewayRouteForGatewayId(config, gatewayId) {
  const normalizedGatewayId = gatewayId == null ? null : normalizeGatewayId(gatewayId);
  if (gatewayId == null || gatewayId === "") return config?.defaultRoute ?? null;
  if (!normalizedGatewayId) return null;
  return config?.canaryRoute?.gatewayId === normalizedGatewayId ? config.canaryRoute : null;
}
