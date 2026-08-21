// The Cloudflare → edge boundary.
//
// The edge function sits on a public Hetzner address. Anything it believes about
// the network — who the client is, which network they came from — has to be
// proved, because otherwise a request sent straight to the edge with a chosen
// X-Forwarded-For picks its own identity, and every velocity counter and every
// IP signal becomes whatever an attacker types.
//
// So the Pages Function signs a statement of fact and the edge trusts nothing
// else. Not X-Forwarded-For, not X-Real-IP, not CF-Connecting-IP, not
// CF-IPCountry, not a bespoke ASN header, however coherent they look. Only the
// signed values, and only after verification. That way a future change of proxy
// cannot quietly reintroduce trust in a public header.
//
// This module touches no environment and no runtime API beyond Web Crypto, on
// purpose: the signing side runs on Cloudflare Workers and the verifying side
// runs on Deno, and both must use exactly the same code. Keys are passed in.
//
// WHAT THE ENVELOPE COVERS, and why each field is there:
//
//   version, keyVersion   rotation without an emergency
//   audience              an envelope minted for this endpoint cannot be
//                         replayed against another service that later adopts the
//                         same mechanism
//   timestampMs           a short window, so a captured envelope dies quickly
//   requestId             consumed atomically, so it works exactly once
//   method, path          compared against the route actually called, never
//                         merely read out of the envelope
//   contentType           normalised, so a signed JSON body cannot be re-fed as
//                         something else
//   bodyHash              SHA-256 of the RAW BYTES. Not of parsed-then-
//                         reserialised JSON: two layers serialise the same
//                         structure differently, and one changed byte between
//                         Cloudflare and the edge must invalidate the request.
//   clientIp, asn, country the network facts, which is the entire point

export const INGRESS_VERSION = 1;
export const INGRESS_AUDIENCE_SIGNUP = "norva-signup-edge-v1";

/** Short: this protects one hop, not a user session. */
export const INGRESS_MAX_AGE_MS = 3 * 60 * 1000;
/** Real clocks drift; a minute either way is not an attack. */
export const INGRESS_CLOCK_SKEW_MS = 60 * 1000;

/** A signup body has no business being large. */
export const MAX_INGRESS_BODY_BYTES = 16 * 1024;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_TOKEN_LENGTH = 512;
export const MAX_HONEYPOT_LENGTH = 256;
export const MAX_METADATA_FIELD_LENGTH = 128;
export const INGRESS_CONTENT_TYPE = "application/json";

export interface IngressEnvelope {
  version: number;
  keyVersion: number;
  audience: string;
  timestampMs: number;
  requestId: string;
  method: string;
  path: string;
  contentType: string;
  bodyHash: string;
  clientIp: string;
  asn: number | null;
  country: string | null;
}

export type IngressFailure =
  | "ingress_header_missing"
  | "ingress_header_malformed"
  | "ingress_version_unknown"
  | "ingress_key_unknown"
  | "ingress_audience_mismatch"
  | "ingress_stale"
  | "ingress_future"
  | "ingress_route_mismatch"
  | "ingress_content_type_mismatch"
  | "ingress_body_too_large"
  | "ingress_body_mismatch"
  | "ingress_signature_invalid";

export type IngressVerdict =
  | { ok: true; envelope: IngressEnvelope }
  | { ok: false; reason: IngressFailure };

// ── normalisation, applied identically on both sides ───────────────────────

export function normaliseMethod(method: string): string {
  return String(method ?? "").trim().toUpperCase();
}

/**
 * Path only: no query, no fragment, no trailing slash except at the root. The
 * query string is excluded because it is not part of what is being authorised
 * and because two encodings of the same query would break the comparison.
 */
export function normalisePath(path: string): string {
  let value = String(path ?? "").trim();
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value || "/";
}

/** Lowercased, parameters dropped: "application/json; charset=utf-8" is JSON. */
export function normaliseContentType(contentType: string | null | undefined): string {
  return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashBody(raw: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return hex(new Uint8Array(digest));
}

/**
 * Length-prefixed fields, so no rearrangement of values produces another valid
 * message: "ab" + "c" must not collide with "a" + "bc".
 */
export function canonicalEnvelope(envelope: IngressEnvelope): string {
  return [
    envelope.version,
    envelope.keyVersion,
    envelope.audience,
    envelope.timestampMs,
    envelope.requestId,
    envelope.method,
    envelope.path,
    envelope.contentType,
    envelope.bodyHash,
    envelope.clientIp,
    envelope.asn === null ? "" : envelope.asn,
    envelope.country ?? "",
  ].map((part) => {
    const text = String(part);
    return `${text.length}:${text}`;
  }).join("|");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function macKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/** Signing side: Cloudflare. */
export async function signIngress(
  envelope: IngressEnvelope,
  secret: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret, ["sign"]),
    new TextEncoder().encode(canonicalEnvelope(envelope)),
  );
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
  return `${envelope.version}.${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** Constant-time for two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface IngressKeyring {
  /** The version currently minting signatures. */
  currentVersion: number;
  current: string;
  /** Accepted during a rotation window, then removed. */
  previousVersion?: number;
  previous?: string;
}

export interface IngressExpectation {
  audience: string;
  /** The route ACTUALLY called, not what the envelope claims. */
  method: string;
  path: string;
  contentType: string | null;
  rawBody: ArrayBuffer | Uint8Array;
  nowMs: number;
  maxAgeMs?: number;
}

/**
 * Verification, in the order that keeps the cheap refusals cheap. The edge is
 * publicly reachable, so a flood of invalid signatures will arrive whatever the
 * design; nothing expensive may happen before the signature holds. The Kong
 * floor stays in front of this endpoint for the volumetric half of the problem —
 * cryptography answers impersonation, not volume.
 */
export async function verifyIngress(
  header: string | null | undefined,
  keys: IngressKeyring,
  expected: IngressExpectation,
): Promise<IngressVerdict> {
  if (!header || typeof header !== "string") {
    return { ok: false, reason: "ingress_header_missing" };
  }

  const bodyBytes = expected.rawBody instanceof Uint8Array
    ? expected.rawBody
    : new Uint8Array(expected.rawBody);
  if (bodyBytes.byteLength > MAX_INGRESS_BODY_BYTES) {
    return { ok: false, reason: "ingress_body_too_large" };
  }

  const parts = header.split(".");
  if (parts.length !== 3) return { ok: false, reason: "ingress_header_malformed" };
  const [versionText, body, signature] = parts;
  if (versionText !== String(INGRESS_VERSION)) {
    return { ok: false, reason: "ingress_version_unknown" };
  }
  const payloadBytes = fromBase64Url(body);
  const mac = fromBase64Url(signature);
  if (!payloadBytes || !mac) return { ok: false, reason: "ingress_header_malformed" };

  let envelope: IngressEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(payloadBytes)) as IngressEnvelope;
  } catch {
    return { ok: false, reason: "ingress_header_malformed" };
  }
  if (
    typeof envelope?.audience !== "string"
    || typeof envelope?.requestId !== "string"
    || !/^[0-9a-f]{32}$/.test(envelope.requestId)
    || typeof envelope?.timestampMs !== "number"
    || !Number.isFinite(envelope.timestampMs)
    || typeof envelope?.bodyHash !== "string"
    || !/^[0-9a-f]{64}$/.test(envelope.bodyHash)
    || typeof envelope?.clientIp !== "string"
    || !envelope.clientIp
    || typeof envelope?.keyVersion !== "number"
  ) {
    return { ok: false, reason: "ingress_header_malformed" };
  }

  const secret = envelope.keyVersion === keys.currentVersion
    ? keys.current
    : (envelope.keyVersion === keys.previousVersion ? keys.previous : undefined);
  if (!secret) return { ok: false, reason: "ingress_key_unknown" };

  if (envelope.audience !== expected.audience) {
    return { ok: false, reason: "ingress_audience_mismatch" };
  }

  const age = expected.nowMs - envelope.timestampMs;
  if (age > (expected.maxAgeMs ?? INGRESS_MAX_AGE_MS)) {
    return { ok: false, reason: "ingress_stale" };
  }
  if (age < -INGRESS_CLOCK_SKEW_MS) return { ok: false, reason: "ingress_future" };

  // The signed route is compared against the route actually served. Reading it
  // out of the envelope and believing it would let one signed statement be
  // pointed at a different handler.
  if (
    envelope.method !== normaliseMethod(expected.method)
    || envelope.path !== normalisePath(expected.path)
  ) {
    return { ok: false, reason: "ingress_route_mismatch" };
  }
  const contentType = normaliseContentType(expected.contentType);
  if (envelope.contentType !== contentType || contentType !== INGRESS_CONTENT_TYPE) {
    return { ok: false, reason: "ingress_content_type_mismatch" };
  }

  // Recomputed over the bytes that actually arrived, before any parsing.
  if (!timingSafeEqual(envelope.bodyHash, await hashBody(bodyBytes))) {
    return { ok: false, reason: "ingress_body_mismatch" };
  }

  const ok = await crypto.subtle.verify(
    "HMAC",
    await macKey(secret, ["verify"]),
    mac,
    new TextEncoder().encode(canonicalEnvelope(envelope)),
  );
  if (!ok) return { ok: false, reason: "ingress_signature_invalid" };

  return { ok: true, envelope };
}

/**
 * The network facts, and only from a verified envelope. asn and country are
 * derived metadata: useful for observability and for a weak signal, never a
 * security truth, and their absence must not refuse a legitimate signup. The
 * signed client IP is the primary network fact.
 */
export interface TrustedNetworkFacts {
  clientIp: string;
  asn: number | null;
  country: string | null;
}

export function trustedFacts(envelope: IngressEnvelope): TrustedNetworkFacts {
  const asn = typeof envelope.asn === "number" && Number.isInteger(envelope.asn)
    && envelope.asn >= 0 && envelope.asn <= 4294967295
    ? envelope.asn
    : null;
  const country = typeof envelope.country === "string"
    && /^[A-Z]{2}$/.test(envelope.country)
    ? envelope.country
    : null;
  return { clientIp: envelope.clientIp, asn, country };
}
