// POST /api/signup-token — hands the browser a server-signed form token.
//
// The browser must never be able to build one itself: the whole submission-timing
// signal rests on a timestamp only the server can vouch for.
//
// WHERE THIS IS ACTUALLY PROTECTED. An earlier comment here claimed the gateway
// gives this endpoint a volumetric floor, which is wrong about the topology.
// This URL is norva.tv/api/signup-token, a Pages Function; Kong sits behind
// api.norva.tv and never sees the request. What Kong does limit is the edge route
// this proxies to — api.norva.tv/functions/v1/norva-signup/token — so the floor
// protects the expensive half, not the public one. Capping the public URL itself
// needs a Cloudflare rate-limiting rule, and nothing else can do it.
//
// Issuance stays on the edge rather than happening here, for one reason: the
// signing secret then exists in exactly one place. Minting the token in this
// function would be marginally cheaper and would put NORVA_SIGNUP_TOKEN_SECRET
// on both sides of the boundary, doubling the rotation surface for a saving of a
// few milliseconds. The edge route does no database work at all — pure HMAC — so
// a flood of token requests costs cheap invocations that Kong already bounds.
import { proxySignedSignup } from '../_shared/signup-ingress.ts';

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedSignup(request, env, '/token');
}
