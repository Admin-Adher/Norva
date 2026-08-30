// POST /api/auth-email-challenge-request — sends a short-lived verification
// code without creating a Supabase Auth user. Cloudflare contributes the signed
// client-network facts; the Edge service owns validation and delivery.
import { proxySignedAuthChallenge } from "../_shared/signup-ingress.ts";

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedAuthChallenge(request, env, "/request");
}
