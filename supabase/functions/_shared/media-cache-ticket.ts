const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const MEDIA_CACHE_TICKET_SCHEMA = 1;
export const MEDIA_CACHE_TICKET_PREFIX = "mc1";
export const MEDIA_CACHE_TICKET_MAX_TTL_MS = 5 * 60 * 1000;
export const MEDIA_CACHE_TICKET_CLOCK_SKEW_MS = 30 * 1000;

export type MediaCacheTicketPayload = {
  schema: 1;
  objectKey: string;
  bindingId: string;
  playbackSessionId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
};

export class MediaCacheTicketError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaCacheTicketError";
    this.code = code;
  }
}

function invalid(message: string): MediaCacheTicketError {
  return new MediaCacheTicketError("INVALID_MEDIA_CACHE_TICKET", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalMediaCacheJson(value: unknown, depth = 0): string {
  if (depth > 16) throw invalid("ticket payload is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalMediaCacheJson(item, depth + 1)).join(",")}]`;
  if (!isPlainObject(value)) throw invalid("ticket payload contains a non-JSON value");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalMediaCacheJson(value[key], depth + 1)}`).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeHexKey(value: string): Uint8Array {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw invalid("ticket HMAC key is invalid");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid("ticket base64url is invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch (_) { throw invalid("ticket base64url is invalid"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) throw invalid("ticket base64url is not canonical");
  return bytes;
}

async function hmac(secretHex: string, encodedPayload: string): Promise<Uint8Array> {
  const secretBytes = decodeHexKey(secretHex);
  const secretBuffer = new ArrayBuffer(secretBytes.byteLength);
  new Uint8Array(secretBuffer).set(secretBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`norva-media-cache-ticket-v1\0${encodedPayload}`),
  ));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % Math.max(1, left.length)] ?? 0)
      ^ (right[index % Math.max(1, right.length)] ?? 0);
  }
  return difference === 0;
}

function normalizePayload(value: unknown): MediaCacheTicketPayload {
  const keys = [
    "schema", "objectKey", "bindingId", "playbackSessionId",
    "issuedAtMs", "expiresAtMs", "nonce",
  ];
  if (!exactKeys(value, keys)
    || value.schema !== MEDIA_CACHE_TICKET_SCHEMA
    || typeof value.objectKey !== "string" || !/^[0-9a-f]{64}$/.test(value.objectKey)
    || typeof value.bindingId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.bindingId)
    || typeof value.playbackSessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.playbackSessionId)
    || typeof value.issuedAtMs !== "number" || !Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs <= 0
    || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs
    || value.expiresAtMs - value.issuedAtMs > MEDIA_CACHE_TICKET_MAX_TTL_MS
    || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce)) {
    throw invalid("ticket payload shape is invalid");
  }
  return {
    schema: MEDIA_CACHE_TICKET_SCHEMA,
    objectKey: value.objectKey,
    bindingId: value.bindingId.toLowerCase(),
    playbackSessionId: value.playbackSessionId.toLowerCase(),
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    nonce: value.nonce,
  };
}

export async function createMediaCacheTicket(
  secretHex: string,
  input: Omit<MediaCacheTicketPayload, "schema" | "issuedAtMs" | "nonce">,
  nowMs = Date.now(),
): Promise<string> {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw invalid("ticket clock is invalid");
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload = normalizePayload({
    schema: MEDIA_CACHE_TICKET_SCHEMA,
    objectKey: input.objectKey,
    bindingId: input.bindingId,
    playbackSessionId: input.playbackSessionId,
    issuedAtMs: nowMs,
    expiresAtMs: input.expiresAtMs,
    nonce: base64UrlEncode(nonceBytes),
  });
  const encodedPayload = base64UrlEncode(encoder.encode(canonicalMediaCacheJson(payload)));
  const signature = base64UrlEncode(await hmac(secretHex, encodedPayload));
  return `${MEDIA_CACHE_TICKET_PREFIX}.${encodedPayload}.${signature}`;
}

export async function verifyMediaCacheTicket(
  secretHex: string,
  ticket: string,
  nowMs = Date.now(),
): Promise<MediaCacheTicketPayload> {
  if (typeof ticket !== "string" || ticket.length > 4096) throw invalid("ticket is invalid");
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== MEDIA_CACHE_TICKET_PREFIX) throw invalid("ticket is invalid");
  const encodedPayload = parts[1];
  const providedMac = base64UrlDecode(parts[2]);
  const expectedMac = await hmac(secretHex, encodedPayload);
  if (!timingSafeEqual(providedMac, expectedMac)) throw invalid("ticket authentication failed");
  let payloadJson: string;
  let parsed: unknown;
  try {
    payloadJson = decoder.decode(base64UrlDecode(encodedPayload));
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    if (error instanceof MediaCacheTicketError) throw error;
    throw invalid("ticket payload is invalid");
  }
  if (canonicalMediaCacheJson(parsed) !== payloadJson) throw invalid("ticket payload is not canonical");
  const payload = normalizePayload(parsed);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0
    || payload.issuedAtMs > nowMs + MEDIA_CACHE_TICKET_CLOCK_SKEW_MS
    || payload.expiresAtMs <= nowMs) {
    throw new MediaCacheTicketError("MEDIA_CACHE_TICKET_EXPIRED", "ticket is expired or not yet valid");
  }
  return payload;
}
