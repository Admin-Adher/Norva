// The signed form token: a server-issued nonce and timestamp that the client
// carries back with its signup.
//
// It exists so submission timing can be judged at all. A timestamp the browser
// sends is worth nothing — an attacker edits it — so the server signs its own
// clock and only trusts what verifies. Everything about "this form came back
// 800 ms after it was handed out" rests on that signature.
//
// What this module does NOT decide: replay. Verifying a signature tells you the
// token is authentic, not that it is being used for the first time. Freshness of
// USE is the idempotency layer's answer, so verify() returns FRESH or EXPIRED and
// the caller upgrades to REPLAYED when the nonce claim comes back as one. Keeping
// those two questions apart is what stops a double click from being scored as a
// forgery.

import type { TokenState } from "./signup-risk-engine.ts";

/** Bump on key rotation; a token signed under an old version stops verifying. */
export const TOKEN_VERSION = 1;

/**
 * Thirty minutes. Long enough that leaving a tab open while making coffee is not
 * an anomaly, short enough that a harvested token is not worth stockpiling.
 */
export const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

const TOKEN_SECRET = Deno.env.get("NORVA_SIGNUP_TOKEN_SECRET") ?? "";

export function formTokenConfigured(): boolean {
  // A short secret is worse than an absent one, because it looks configured.
  return TOKEN_SECRET.length >= 32;
}

let macKey: Promise<CryptoKey> | null = null;
function tokenKey(): Promise<CryptoKey> {
  if (!macKey) {
    macKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(TOKEN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return macKey;
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

export interface FormTokenPayload {
  nonce: string;
  issuedAtMs: number;
}

/** 128 bits of nonce: enough that guessing one is not a strategy. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueFormToken(
  now: number,
  nonce: string = newNonce(),
): Promise<{ token: string; nonce: string }> {
  if (!formTokenConfigured()) throw new Error("form_token_secret_missing");
  const payload = new TextEncoder().encode(JSON.stringify({ n: nonce, t: now }));
  const body = toBase64Url(payload);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(),
    new TextEncoder().encode(`${TOKEN_VERSION}.${body}`),
  );
  return { token: `${TOKEN_VERSION}.${body}.${toBase64Url(new Uint8Array(mac))}`, nonce };
}

export interface FormTokenVerdict {
  /** Never REPLAYED: use of the nonce is the idempotency layer's question. */
  state: Exclude<TokenState, "TOKEN_VALID_REPLAYED">;
  payload: FormTokenPayload | null;
  /** Only meaningful once the signature verified. */
  ageMs: number | null;
}

const MISSING: FormTokenVerdict = { state: "TOKEN_MISSING", payload: null, ageMs: null };
const INVALID: FormTokenVerdict = { state: "TOKEN_INVALID", payload: null, ageMs: null };

export async function verifyFormToken(
  token: string | null | undefined,
  now: number,
): Promise<FormTokenVerdict> {
  if (!token || typeof token !== "string") return MISSING;
  if (!formTokenConfigured()) return INVALID;

  const parts = token.split(".");
  if (parts.length !== 3) return INVALID;
  const [version, body, signature] = parts;
  if (version !== String(TOKEN_VERSION)) return INVALID;

  const mac = fromBase64Url(signature);
  const payloadBytes = fromBase64Url(body);
  if (!mac || !payloadBytes) return INVALID;

  // subtle.verify rather than sign-then-compare: the comparison happens inside
  // the implementation, so there is no timing side channel to get wrong here.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await tokenKey(),
    mac,
    new TextEncoder().encode(`${version}.${body}`),
  );
  if (!ok) return INVALID;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return INVALID;
  }
  const record = parsed as { n?: unknown; t?: unknown };
  const nonce = typeof record.n === "string" ? record.n : "";
  const issuedAtMs = typeof record.t === "number" ? record.t : Number.NaN;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(issuedAtMs)) return INVALID;

  // A token stamped in the future is a forgery or a broken clock; either way its
  // age cannot be measured, so it is not treated as fresh.
  const ageMs = now - issuedAtMs;
  if (ageMs < -60_000) return INVALID;

  return {
    state: ageMs > TOKEN_MAX_AGE_MS ? "TOKEN_VALID_EXPIRED" : "TOKEN_VALID_FRESH",
    payload: { nonce, issuedAtMs },
    ageMs: Math.max(0, ageMs),
  };
}
