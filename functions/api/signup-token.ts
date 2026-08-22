// POST /api/signup-token — hands the browser a server-signed form token.
//
// The browser must never be able to build one itself: the whole submission-timing
// signal rests on a timestamp only the server can vouch for.
//
// This endpoint needs its own volumetric floor at the gateway. Without one the
// problem simply moves from spamming /api/signup to spamming this, and issuing a
// token is cheap enough that a bot would happily do it all day.
import { proxySignedSignup } from '../_shared/signup-ingress.ts';

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedSignup(request, env, '/token');
}
