// POST /api/signup-token — hands the browser a server-signed form token.
//
// The browser must never be able to build one itself: the whole submission-timing
// signal rests on a timestamp only the server can vouch for.
//
// WHERE THIS IS ACTUALLY PROTECTED: nowhere, volumetrically. Two corrections,
// both of claims previously written here.
//
// This URL is norva.tv/api/signup-token, a Pages Function. Kong sits behind
// api.norva.tv and never sees the request, so the first version's claim that the
// gateway floors this endpoint was wrong about the topology.
//
// The replacement claim — that Kong at least floors the edge route this proxies
// to — is also wrong, and was asserted without checking. Verified in
// ops/hetzner/volumes/api/kong.yml: the generic `functions-v1` service carries a
// single plugin, `cors`. No key-auth, no acl, no rate-limiting, and kong.yml
// declares no global plugins. rate-limiting exists only on the four auth
// services and seven partners routes. So /functions/v1/* is unmetered.
//
// The honest statement: nothing rate-limits this path today, at either layer.
// That is not a regression this endpoint introduces — it is the standing
// condition of all nineteen edge functions — but it does mean the volumetric
// floor is still owed, and it belongs before a public canary. Either a Kong
// service + route for /functions/v1/norva-signup following the pattern already
// proven on auth-v1-signup, or a Cloudflare rate-limiting rule for the public
// URL, which is the only thing that can cap the public half.
//
// Issuance stays on the edge rather than happening here for one reason: the
// signing secret then exists in exactly one place. Minting the token here would
// be marginally cheaper and would put NORVA_SIGNUP_TOKEN_SECRET on both sides of
// the boundary, doubling the rotation surface to save a few milliseconds. What
// remains true is that the edge /token route touches no database at all — pure
// HMAC — so a flood costs edge invocations rather than Postgres writes. Edge
// invocations are not free: the runtime's router is a single-threaded V8 isolate
// capping around 95 req/s per container.
import { proxySignedSignup } from '../_shared/signup-ingress.ts';

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedSignup(request, env, '/token');
}
