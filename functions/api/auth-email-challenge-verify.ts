// POST /api/auth-email-challenge-verify — exchanges a proven mailbox challenge
// for a one-time Auth token. Account creation can only happen behind this route.
import { proxySignedAuthChallenge } from "../_shared/signup-ingress.ts";

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedAuthChallenge(request, env, "/verify");
}
