// POST /api/signup — the browser's entry point.
//
// Thin on purpose: Cloudflare signs who the client is, the edge decides
// everything else. See functions/_shared/signup-ingress.ts for why the signature
// exists and what is never logged along the way.
import { proxySignedSignup } from '../_shared/signup-ingress.ts';

export function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  return proxySignedSignup(request, env, '');
}
