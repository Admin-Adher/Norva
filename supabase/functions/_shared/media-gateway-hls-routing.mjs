import { selectMediaGatewayRouteForUserHash } from './media-gateway-canary-routing.mjs';

const HASH = /^[a-f0-9]{64}$/;
const unavailable = () => Object.assign(new Error('HLS gateway routing unavailable'), {
  code: 'MEDIA_GATEWAY_HLS_ROUTING_UNAVAILABLE',
});

// This policy only selects NEW HLS producers. Native/raw routes continue to
// use their existing selector; existing HLS sessions resolve their stored ID.
export function buildMediaGatewayHlsRoutingConfig({ basisPoints, routing } = {}) {
  const raw = basisPoints == null ? '' : typeof basisPoints === 'string' ? basisPoints.trim() : null;
  const parsed = raw === '' ? 0 : raw !== null && /^(?:0|[1-9]\d{0,4})$/.test(raw) ? Number(raw) : null;
  const validNumber = parsed !== null && parsed >= 0 && parsed <= 10000;
  const routesReady = Boolean(routing?.defaultRoute && routing?.canaryRoute
    && routing.canaryRoute.gatewayId && routing.canaryState !== 'invalid'
    && routing.defaultRoute.url !== routing.canaryRoute.url);
  return Object.freeze({ protocol: 1,
    state: !validNumber || (parsed > 0 && !routesReady) ? 'invalid' : parsed > 0 ? 'ready' : 'off',
    basisPoints: validNumber ? parsed : null,
  });
}

export function selectMediaGatewayHlsRoute(routing, policy, userHash) {
  if (!policy || policy.protocol !== 1 || !['off', 'ready'].includes(policy.state)
    || !Number.isInteger(policy.basisPoints)
    || (policy.state === 'off' ? policy.basisPoints !== 0
      : policy.basisPoints < 1 || policy.basisPoints > 10000)) throw unavailable();
  const hash = typeof userHash === 'string' ? userHash.trim().toLowerCase() : '';
  const explicitlySelected = HASH.test(hash) && routing?.canaryUserHashes?.includes(hash);
  // Preserve the private allowlist, including its fail-closed behavior.
  if (explicitlySelected) {
    const route = selectMediaGatewayRouteForUserHash(routing, hash);
    if (!route) throw unavailable();
    return route;
  }
  if (policy.state === 'off') return routing?.defaultRoute ?? null;
  if (!HASH.test(hash)) throw unavailable();
  // Hash is computed by the server from the authenticated user ID. The bucket
  // is independent of request order, replica, title, and restart timing.
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 10000;
  const route = bucket < policy.basisPoints ? routing?.canaryRoute : routing?.defaultRoute;
  if (!route) throw unavailable();
  return route;
}
