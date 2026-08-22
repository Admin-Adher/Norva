// The Cloudflare half of the signup path.
//
// It exists for one reason: Cloudflare knows who the client is and the edge does
// not. request.cf and the connecting IP are facts here and unverifiable claims
// anywhere downstream, so this is where they get signed. The edge then trusts the
// signature and nothing else — not X-Forwarded-For, not CF-Connecting-IP, not any
// header a caller could set by reaching the edge directly.
//
// The signing code is imported from the shared module rather than reimplemented,
// because a canonical form written twice is a canonical form that will diverge.
// That module deliberately reads no environment and uses nothing beyond Web
// Crypto, so the same bytes run on Workers here and on Deno there.
//
// NOTHING IS LOGGED FROM THE BODY. Not the raw bytes, not the parsed payload, not
// the email, not the password, not the form token. This function necessarily
// holds a credential in transit — the browser used to reach GoTrue directly — so
// no console line, no exception context and no error telemetry may carry it.
// body_hash is enough for integrity.

import {
  INGRESS_AUDIENCE_SIGNUP,
  INGRESS_VERSION,
  MAX_INGRESS_BODY_BYTES,
  hashBody,
  normaliseContentType,
  normaliseMethod,
  normalisePath,
  signIngress,
  type IngressEnvelope,
} from "../../supabase/functions/_shared/edge-ingress.ts";

interface Env {
  EDGE_INGRESS_SECRET_CURRENT?: string;
  EDGE_INGRESS_KEY_VERSION?: string;
  NORVA_EDGE_BASE?: string;
}

const DEFAULT_EDGE_BASE = "https://api.norva.tv/functions/v1/norva-signup";

/** 128 bits, single-use, consumed atomically on the edge. */
function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function refuse(status: number): Response {
  // One shape for every refusal: an attacker learns nothing about which layer
  // said no.
  return new Response(
    JSON.stringify({ error: "Unable to complete registration. Please try again later." }),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

export async function proxySignedSignup(
  request: Request,
  env: Env,
  edgePath: "" | "/token",
): Promise<Response> {
  if (request.method !== "POST") return refuse(405);

  const secret = env.EDGE_INGRESS_SECRET_CURRENT ?? "";
  // Inert rather than open: with no key this path cannot mint a signature, and
  // the edge would refuse it anyway.
  if (secret.length < 32) return refuse(503);

  const contentType = normaliseContentType(request.headers.get("content-type"));
  if (contentType !== "application/json") return refuse(415);

  // Read once. A second read of the body would be a different byte sequence as
  // far as the hash is concerned, and the hash is the whole integrity story.
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > MAX_INGRESS_BODY_BYTES) return refuse(413);

  const target = `${env.NORVA_EDGE_BASE ?? DEFAULT_EDGE_BASE}${edgePath}`;
  const targetPath = normalisePath(new URL(target).pathname);

  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "";
  if (!clientIp) return refuse(400);

  const asnValue = Number(cf.asn);
  const country = typeof cf.country === "string" ? cf.country.toUpperCase() : "";

  const envelope: IngressEnvelope = {
    version: INGRESS_VERSION,
    keyVersion: Number(env.EDGE_INGRESS_KEY_VERSION ?? "1"),
    audience: INGRESS_AUDIENCE_SIGNUP,
    timestampMs: Date.now(),
    requestId: newRequestId(),
    method: normaliseMethod(request.method),
    path: targetPath,
    contentType,
    // Over the raw bytes, never over parsed-then-reserialised JSON: two layers
    // render the same structure differently, and one changed byte between here
    // and the edge has to invalidate the request.
    bodyHash: await hashBody(rawBody),
    clientIp,
    // Derived metadata. Absent is fine and must never refuse a legitimate
    // signup; the signed IP is the primary network fact.
    asn: Number.isInteger(asnValue) && asnValue > 0 ? asnValue : null,
    country: /^[A-Z]{2}$/.test(country) ? country : null,
  };

  const signature = await signIngress(envelope, secret);

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-norva-ingress": signature,
      },
      body: rawBody,
    });
    // Passed through as-is: the edge already speaks in opaque refusals and
    // allow-listed successes, so there is nothing here to reshape.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    // The catch is deliberately bare. Binding the error would put an object in
    // scope that may hold the request, and the request holds a password.
    return refuse(502);
  }
}
