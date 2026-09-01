import {
  canonicalMediaCacheJson,
  MediaCacheTicketError,
  verifyMediaCacheTicket,
  type MediaCacheTicketPayload,
} from "../../../supabase/functions/_shared/media-cache-ticket.ts";

type R2ChecksumsLike = { sha256?: ArrayBuffer };
type R2RangeLike = { offset?: number; length?: number };
type R2ObjectLike = {
  key: string;
  size: number;
  etag: string;
  httpEtag?: string;
  uploaded?: Date;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
  checksums?: R2ChecksumsLike;
  range?: R2RangeLike;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
};
type R2BucketLike = {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | string | null, options?: Record<string, unknown>): Promise<R2ObjectLike | null>;
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectLike | null>;
  head(key: string): Promise<Omit<R2ObjectLike, "body" | "arrayBuffer"> | null>;
};

export type MediaCacheWorkerEnv = {
  MEDIA_CACHE_BUCKET: R2BucketLike;
  MEDIA_CACHE_GATEWAY_TOKEN: string;
  MEDIA_CACHE_MANIFEST_HMAC_KEY: string;
  MEDIA_CACHE_TICKET_HMAC_KEY: string;
  MEDIA_CACHE_ALLOWED_ORIGINS?: string;
};

type ManifestFile = {
  path: string;
  objectName: string;
  size: number;
  sha256: string;
  contentType: string;
};
type SharedManifest = {
  schema: 1;
  identityKind: "global-media-object";
  objectKey: string;
  components: Record<string, string>;
  rootPlaylist: string;
  files: ManifestFile[];
  totalBytes: number;
  createdAtMs: number;
  expiresAtMs: number;
  completion: { kind: "complete-hls"; sourceEof: true; ffmpegExitCode: 0 };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_INTERNAL_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 20_000;
const MANIFEST_CACHE_MS = 30_000;
const MANIFEST_CACHE_MAX = 256;
const REVOCATION_NEGATIVE_CACHE_MS = 2_000;
const manifestCache = new Map<string, { manifest: SharedManifest; cachedUntilMs: number }>();
const revocationCache = new Map<string, { revoked: boolean; cachedUntilMs: number }>();

class WorkerHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WorkerHttpError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeAssetPath(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f?#%]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new WorkerHttpError(400, "INVALID_ASSET_PATH", "Invalid media cache asset path");
  }
  return path;
}

function exactDigest(value: unknown): string {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new WorkerHttpError(400, "INVALID_DIGEST", "Invalid media cache digest");
  }
  return digest;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function hexToBytes(value: string): Uint8Array {
  const digest = exactDigest(value);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlDecode(value: string, maximumBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximumBytes * 4 / 3) + 4) {
    throw new WorkerHttpError(400, "INVALID_BASE64URL", "Invalid media cache encoding");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch (_) {
    throw new WorkerHttpError(400, "INVALID_BASE64URL", "Invalid media cache encoding");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let canonical = "";
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  canonical = btoa(canonical).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (canonical !== value) throw new WorkerHttpError(400, "INVALID_BASE64URL", "Invalid media cache encoding");
  return bytes;
}

function decodeInternalObjectKey(encoded: string): string {
  let key: string;
  try { key = decoder.decode(base64UrlDecode(encoded, 1024)); } catch (error) {
    if (error instanceof WorkerHttpError) throw error;
    throw new WorkerHttpError(400, "INVALID_OBJECT_KEY", "Invalid media cache object key");
  }
  const match = key.match(/^media-cache\/v1\/([0-9a-f]{2})\/([0-9a-f]{64})\/(?:assets\/[0-9a-f]{64}|manifest\.auth\.json)$/);
  if (!match || match[1] !== match[2].slice(0, 2)) {
    throw new WorkerHttpError(400, "INVALID_OBJECT_KEY", "Invalid media cache object key");
  }
  return key;
}

function validateObjectMetadataBinding(
  key: string,
  expectedSha256: string,
  metadata: Record<string, string>,
): void {
  const match = key.match(/^media-cache\/v1\/[0-9a-f]{2}\/([0-9a-f]{64})\/(assets\/[0-9a-f]{64}|manifest\.auth\.json)$/);
  if (!match || metadata["object-key"] !== match[1]) {
    throw new WorkerHttpError(400, "OBJECT_METADATA_MISMATCH", "Media cache metadata is not bound to its object");
  }
  if (match[2].startsWith("assets/")) {
    if (metadata.kind !== "hls-asset" || metadata["asset-sha256"] !== expectedSha256
      || !/^[0-9a-f]{64}$/.test(metadata["logical-path-sha256"] || "")) {
      throw new WorkerHttpError(400, "OBJECT_METADATA_MISMATCH", "Media cache asset metadata is invalid");
    }
  } else if (metadata.kind !== "hls-manifest" || metadata["manifest-sha256"] !== expectedSha256) {
    throw new WorkerHttpError(400, "OBJECT_METADATA_MISMATCH", "Media cache manifest metadata is invalid");
  }
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(1, a.length)] ?? 0) ^ (b[index % Math.max(1, b.length)] ?? 0);
  }
  return difference === 0;
}

function requireInternalAuth(request: Request, env: MediaCacheWorkerEnv): void {
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const expected = String(env.MEDIA_CACHE_GATEWAY_TOKEN || "");
  if (expected.length < 32 || !timingSafeTextEqual(provided, expected)) {
    throw new WorkerHttpError(401, "UNAUTHORIZED", "Unauthorized");
  }
}

function normalizedMetadata(encoded: string | null): Record<string, string> {
  if (!encoded) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(base64UrlDecode(encoded, 48 * 1024))); } catch (error) {
    if (error instanceof WorkerHttpError) throw error;
    throw new WorkerHttpError(400, "INVALID_METADATA", "Invalid media cache metadata");
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).length > 32) {
    throw new WorkerHttpError(400, "INVALID_METADATA", "Invalid media cache metadata");
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || typeof value !== "string"
      || value.length > 1024 || /[\u0000\r\n]/.test(value)) {
      throw new WorkerHttpError(400, "INVALID_METADATA", "Invalid media cache metadata");
    }
    metadata[key] = value;
  }
  return metadata;
}

function externalMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => key !== "norva-sha256"));
}

function base64UrlEncodeText(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonResponse(payload: Record<string, unknown>, status = 200, headers: HeadersInit = {}): Response {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function internalPutObject(request: Request, env: MediaCacheWorkerEnv, key: string): Promise<Response> {
  const declaredSize = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_INTERNAL_OBJECT_BYTES || !request.body) {
    throw new WorkerHttpError(413, "INVALID_OBJECT_SIZE", "Invalid media cache object size");
  }
  const expectedSha256 = exactDigest(request.headers.get("x-norva-content-sha256"));
  const metadata = normalizedMetadata(request.headers.get("x-norva-object-metadata"));
  validateObjectMetadataBinding(key, expectedSha256, metadata);
  const contentType = String(request.headers.get("content-type") || "application/octet-stream");
  if (!contentType || contentType.length > 256 || /[\u0000\r\n]/.test(contentType)) {
    throw new WorkerHttpError(400, "INVALID_CONTENT_TYPE", "Invalid media cache content type");
  }
  const storedMetadata = { ...metadata, "norva-sha256": expectedSha256 };
  const uploaded = await env.MEDIA_CACHE_BUCKET.put(key, request.body, {
    onlyIf: new Headers({ "if-none-match": "*" }),
    sha256: expectedSha256,
    httpMetadata: { contentType, cacheControl: "private, max-age=31536000, immutable" },
    customMetadata: storedMetadata,
  });
  if (uploaded) {
    if (uploaded.size !== declaredSize
      || uploaded.customMetadata?.["norva-sha256"] !== expectedSha256
      || (uploaded.checksums?.sha256 && bytesToHex(new Uint8Array(uploaded.checksums.sha256)) !== expectedSha256)) {
      throw new WorkerHttpError(502, "OBJECT_WRITE_UNVERIFIED", "Media cache object write could not be verified");
    }
    return jsonResponse({ ok: true, status: "created", key, sha256: expectedSha256, size: declaredSize }, 201);
  }
  const existing = await env.MEDIA_CACHE_BUCKET.head(key);
  if (existing && existing.size === declaredSize
    && existing.customMetadata?.["norva-sha256"] === expectedSha256
    && canonicalMediaCacheJson(externalMetadata(existing.customMetadata)) === canonicalMediaCacheJson(metadata)) {
    return jsonResponse({ ok: true, status: "already-exists", key, sha256: expectedSha256, size: declaredSize });
  }
  throw new WorkerHttpError(409, "IMMUTABLE_CONFLICT", "Immutable media cache object conflict");
}

async function internalGetObject(env: MediaCacheWorkerEnv, key: string): Promise<Response> {
  const object = await env.MEDIA_CACHE_BUCKET.get(key);
  if (!object) throw new WorkerHttpError(404, "OBJECT_NOT_FOUND", "Media cache object not found");
  const expectedSha256 = exactDigest(object.customMetadata?.["norva-sha256"]);
  if (object.checksums?.sha256 && bytesToHex(new Uint8Array(object.checksums.sha256)) !== expectedSha256) {
    throw new WorkerHttpError(502, "OBJECT_CORRUPT", "Media cache object checksum is invalid");
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
      "x-norva-content-sha256": expectedSha256,
      "x-norva-object-metadata": base64UrlEncodeText(canonicalMediaCacheJson(externalMetadata(object.customMetadata))),
    },
  });
}

async function revokePlaybackSession(env: MediaCacheWorkerEnv, playbackSessionId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playbackSessionId)) {
    throw new WorkerHttpError(400, "INVALID_SESSION", "Invalid playback session");
  }
  const normalized = playbackSessionId.toLowerCase();
  const key = `media-cache-revocations/v1/${normalized}`;
  const body = encoder.encode("revoked\n");
  const bodySha256 = await sha256Hex(body);
  await env.MEDIA_CACHE_BUCKET.put(key, body, {
    onlyIf: new Headers({ "if-none-match": "*" }),
    sha256: bodySha256,
    httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
    customMetadata: { kind: "playback-revocation", "norva-sha256": bodySha256 },
  });
  revocationCache.set(normalized, { revoked: true, cachedUntilMs: Number.MAX_SAFE_INTEGER });
  return jsonResponse({ ok: true, status: "revoked", playbackSessionId: normalized });
}

function allowedOrigins(env: MediaCacheWorkerEnv): Set<string> {
  return new Set(String(env.MEDIA_CACHE_ALLOWED_ORIGINS || "https://norva.tv,https://app.norva.tv")
    .split(",").map((value) => value.trim()).filter(Boolean));
}

function corsHeaders(request: Request, env: MediaCacheWorkerEnv): Headers {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("origin") || "";
  if (allowedOrigins(env).has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-headers", "Authorization, Range");
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-expose-headers", "Content-Length, Content-Range, ETag");
  }
  return headers;
}

function extractTicket(request: Request): string {
  const ticket = request.headers.get("authorization")?.match(/^Bearer\s+(mc1\..+)$/i)?.[1] ?? "";
  if (!ticket) throw new WorkerHttpError(401, "TICKET_REQUIRED", "Media cache ticket required");
  return ticket;
}

async function playbackRevoked(env: MediaCacheWorkerEnv, payload: MediaCacheTicketPayload, nowMs: number): Promise<boolean> {
  const cached = revocationCache.get(payload.playbackSessionId);
  if (cached && cached.cachedUntilMs > nowMs) return cached.revoked;
  const marker = await env.MEDIA_CACHE_BUCKET.head(`media-cache-revocations/v1/${payload.playbackSessionId}`);
  const revoked = Boolean(marker);
  revocationCache.set(payload.playbackSessionId, {
    revoked,
    cachedUntilMs: revoked ? payload.expiresAtMs : Math.min(payload.expiresAtMs, nowMs + REVOCATION_NEGATIVE_CACHE_MS),
  });
  return revoked;
}

async function importManifestKey(secretHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

function decodeCanonicalBase64Url(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== "string") throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  return base64UrlDecode(value, maximumBytes);
}

function normalizeManifestPayload(value: unknown, expectedObjectKey: string, nowMs: number): SharedManifest {
  const keys = [
    "schema", "identityKind", "objectKey", "components", "rootPlaylist", "files",
    "totalBytes", "createdAtMs", "expiresAtMs", "completion",
  ];
  if (!exactKeys(value, keys) || value.schema !== 1 || value.identityKind !== "global-media-object"
    || value.objectKey !== expectedObjectKey || !isPlainObject(value.components)
    || Object.keys(value.components).sort().join(",") !== "audio,content,duration,pipeline,segmenter,size,subtitles,video"
    || Object.values(value.components).some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_MANIFEST_FILES
    || !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) <= 0
    || !Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.expiresAtMs)
    || Number(value.createdAtMs) <= 0 || Number(value.expiresAtMs) <= Number(value.createdAtMs)
    || Number(value.expiresAtMs) <= nowMs
    || !exactKeys(value.completion, ["kind", "sourceEof", "ffmpegExitCode"])
    || value.completion.kind !== "complete-hls" || value.completion.sourceEof !== true
    || value.completion.ffmpegExitCode !== 0) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  const rootPlaylist = safeAssetPath(value.rootPlaylist);
  const files: ManifestFile[] = [];
  let total = 0;
  let previousPath = "";
  for (const rawFile of value.files) {
    if (!exactKeys(rawFile, ["path", "objectName", "size", "sha256", "contentType"])) {
      throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
    }
    const filePath = safeAssetPath(rawFile.path);
    if (filePath <= previousPath || typeof rawFile.objectName !== "string"
      || !/^assets\/[0-9a-f]{64}$/.test(rawFile.objectName)
      || !Number.isSafeInteger(rawFile.size) || Number(rawFile.size) <= 0
      || typeof rawFile.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rawFile.sha256)
      || typeof rawFile.contentType !== "string" || !rawFile.contentType
      || rawFile.contentType.length > 256 || /[\u0000\r\n]/.test(rawFile.contentType)) {
      throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
    }
    previousPath = filePath;
    total += Number(rawFile.size);
    files.push({
      path: filePath,
      objectName: rawFile.objectName,
      size: Number(rawFile.size),
      sha256: rawFile.sha256,
      contentType: rawFile.contentType,
    });
  }
  if (total !== value.totalBytes || !files.some((file) => file.path === rootPlaylist)) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  return {
    schema: 1,
    identityKind: "global-media-object",
    objectKey: expectedObjectKey,
    components: value.components as Record<string, string>,
    rootPlaylist,
    files,
    totalBytes: Number(value.totalBytes),
    createdAtMs: Number(value.createdAtMs),
    expiresAtMs: Number(value.expiresAtMs),
    completion: { kind: "complete-hls", sourceEof: true, ffmpegExitCode: 0 },
  };
}

async function loadManifest(env: MediaCacheWorkerEnv, objectKey: string, nowMs: number): Promise<SharedManifest> {
  const cached = manifestCache.get(objectKey);
  if (cached && cached.cachedUntilMs > nowMs && cached.manifest.expiresAtMs > nowMs) return cached.manifest;
  const key = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/manifest.auth.json`;
  const object = await env.MEDIA_CACHE_BUCKET.get(key);
  if (!object) throw new WorkerHttpError(404, "OBJECT_NOT_READY", "Media cache object is not ready");
  if (object.size <= 0 || object.size > MAX_MANIFEST_BYTES) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  const body = new Uint8Array(await object.arrayBuffer());
  const bodySha256 = await sha256Hex(body);
  if (body.length !== object.size
    || object.customMetadata?.["norva-sha256"] !== bodySha256
    || (object.checksums?.sha256 && bytesToHex(new Uint8Array(object.checksums.sha256)) !== bodySha256)) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest checksum is invalid");
  }
  let envelope: unknown;
  let text: string;
  try {
    text = decoder.decode(body);
    envelope = JSON.parse(text);
  } catch (_) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  if (!exactKeys(envelope, ["schema", "keyId", "payload", "mac"]) || envelope.schema !== 1
    || typeof envelope.keyId !== "string" || !/^[0-9a-f]{16}$/.test(envelope.keyId)) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  const encodedPayload = typeof envelope.payload === "string" ? envelope.payload : "";
  const mac = decodeCanonicalBase64Url(envelope.mac, 64);
  const keyId = (await sha256Hex(hexToBytes(env.MEDIA_CACHE_MANIFEST_HMAC_KEY))).slice(0, 16);
  const manifestKey = await importManifestKey(env.MEDIA_CACHE_MANIFEST_HMAC_KEY);
  const validMac = await crypto.subtle.verify(
    "HMAC",
    manifestKey,
    mac,
    encoder.encode(`norva-shared-hls-manifest-v1\0${envelope.keyId}\0${encodedPayload}`),
  );
  if (!timingSafeTextEqual(envelope.keyId, keyId) || !validMac) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest authentication failed");
  }
  let payloadText: string;
  let payload: unknown;
  try {
    payloadText = decoder.decode(decodeCanonicalBase64Url(encodedPayload, MAX_MANIFEST_BYTES));
    payload = JSON.parse(payloadText);
  } catch (_) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  if (canonicalMediaCacheJson(payload) !== payloadText || `${canonicalMediaCacheJson(envelope)}\n` !== text) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is not canonical");
  }
  const manifest = normalizeManifestPayload(payload, objectKey, nowMs);
  if (manifestCache.size >= MANIFEST_CACHE_MAX) manifestCache.delete(manifestCache.keys().next().value as string);
  manifestCache.set(objectKey, { manifest, cachedUntilMs: Math.min(manifest.expiresAtMs, nowMs + MANIFEST_CACHE_MS) });
  return manifest;
}

async function publicHlsAsset(
  request: Request,
  env: MediaCacheWorkerEnv,
  objectKey: string,
  logicalPath: string,
): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(objectKey)) throw new WorkerHttpError(404, "OBJECT_NOT_FOUND", "Media cache object not found");
  const nowMs = Date.now();
  let ticket: MediaCacheTicketPayload;
  try { ticket = await verifyMediaCacheTicket(env.MEDIA_CACHE_TICKET_HMAC_KEY, extractTicket(request), nowMs); } catch (error) {
    if (error instanceof MediaCacheTicketError) throw new WorkerHttpError(401, error.code, "Media cache ticket is invalid");
    throw error;
  }
  if (ticket.objectKey !== objectKey || await playbackRevoked(env, ticket, nowMs)) {
    throw new WorkerHttpError(403, "ACCESS_REVOKED", "Media cache access is revoked");
  }
  const assetPath = safeAssetPath(logicalPath);
  const manifest = await loadManifest(env, objectKey, nowMs);
  const record = manifest.files.find((file) => file.path === assetPath);
  if (!record) throw new WorkerHttpError(404, "ASSET_NOT_FOUND", "Media cache asset not found");
  const range = request.headers.get("range");
  const object = await env.MEDIA_CACHE_BUCKET.get(
    `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/${record.objectName}`,
    range ? { range: request.headers } : undefined,
  );
  if (!object || object.size !== record.size
    || object.customMetadata?.["norva-sha256"] !== record.sha256
    || (object.checksums?.sha256 && bytesToHex(new Uint8Array(object.checksums.sha256)) !== record.sha256)) {
    throw new WorkerHttpError(502, "ASSET_CORRUPT", "Media cache asset is unavailable");
  }
  const headers = corsHeaders(request, env);
  headers.set("content-type", record.contentType);
  headers.set("cache-control", "private, max-age=300, immutable");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag || object.etag);
  let status = 200;
  if (range && object.range && Number.isSafeInteger(object.range.offset) && Number.isSafeInteger(object.range.length)) {
    const offset = Number(object.range.offset);
    const length = Number(object.range.length);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${record.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(record.size));
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

async function handle(request: Request, env: MediaCacheWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && segments.length === 1 && segments[0] === "health") {
    return jsonResponse({
      ok: true,
      service: "norva-media-cache",
      protocol: 1,
      objectStoreConfigured: Boolean(env.MEDIA_CACHE_BUCKET),
      gatewayAuthConfigured: String(env.MEDIA_CACHE_GATEWAY_TOKEN || "").length >= 32,
      manifestAuthConfigured: /^[0-9a-f]{64}$/i.test(String(env.MEDIA_CACHE_MANIFEST_HMAC_KEY || "")),
      ticketAuthConfigured: /^[0-9a-f]{64}$/i.test(String(env.MEDIA_CACHE_TICKET_HMAC_KEY || "")),
    });
  }
  if (segments[0] === "internal" && segments[1] === "v1") {
    requireInternalAuth(request, env);
    if (segments[2] === "objects" && segments.length === 4) {
      const key = decodeInternalObjectKey(segments[3]);
      if (request.method === "PUT") return internalPutObject(request, env, key);
      if (request.method === "GET") return internalGetObject(env, key);
    }
    if (segments[2] === "revocations" && segments.length === 4 && request.method === "PUT") {
      return revokePlaybackSession(env, segments[3]);
    }
    throw new WorkerHttpError(404, "ROUTE_NOT_FOUND", "Route not found");
  }
  if (segments[0] === "v1" && segments[1] === "hls" && segments.length >= 4
    && ["GET", "HEAD"].includes(request.method)) {
    const objectKey = segments[2];
    let logicalPath: string;
    try { logicalPath = segments.slice(3).map((segment) => decodeURIComponent(segment)).join("/"); } catch (_) {
      throw new WorkerHttpError(400, "INVALID_ASSET_PATH", "Invalid media cache asset path");
    }
    return publicHlsAsset(request, env, objectKey, logicalPath);
  }
  if (request.method === "OPTIONS" && segments[0] === "v1" && segments[1] === "hls") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  throw new WorkerHttpError(404, "ROUTE_NOT_FOUND", "Route not found");
}

export default {
  async fetch(request: Request, env: MediaCacheWorkerEnv): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      const status = error instanceof WorkerHttpError ? error.status : 500;
      const code = error instanceof WorkerHttpError ? error.code : "INTERNAL_ERROR";
      const message = status >= 500 ? "Media cache is temporarily unavailable" : (error instanceof Error ? error.message : "Request failed");
      return jsonResponse({ ok: false, code, error: message }, status, corsHeaders(request, env));
    }
  },
};
