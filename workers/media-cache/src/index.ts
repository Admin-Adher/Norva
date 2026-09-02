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
type R2ListResultLike = {
  objects: Array<Omit<R2ObjectLike, "body" | "arrayBuffer">>;
  truncated: boolean;
  cursor?: string;
};
type R2BucketLike = {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | string | null, options?: Record<string, unknown>): Promise<R2ObjectLike | null>;
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectLike | null>;
  head(key: string): Promise<Omit<R2ObjectLike, "body" | "arrayBuffer"> | null>;
  list(options?: Record<string, unknown>): Promise<R2ListResultLike>;
  delete(keys: string | string[]): Promise<void>;
};
type EdgeCacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
};
type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };
type CloudflarePurgeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type MediaCacheWorkerEnv = {
  MEDIA_CACHE_BUCKET: R2BucketLike;
  MEDIA_CACHE_GATEWAY_TOKEN: string;
  MEDIA_CACHE_MANIFEST_HMAC_KEY: string;
  MEDIA_CACHE_TICKET_HMAC_KEY: string;
  MEDIA_CACHE_ALLOWED_ORIGINS?: string;
  MEDIA_CACHE_EDGE_CACHE?: EdgeCacheLike;
  MEDIA_CACHE_R2_MAX_BYTES?: string;
  MEDIA_CACHE_R2_MAX_OBJECTS?: string;
  MEDIA_CACHE_MAX_FILES_PER_OBJECT?: string;
  MEDIA_CACHE_CLOUDFLARE_ZONE_ID?: string;
  MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN?: string;
  MEDIA_CACHE_CLOUDFLARE_PURGE_FETCH?: CloudflarePurgeFetch;
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
const QUARANTINE_PREFIX = "media-cache-quarantine/v1/";
const MAX_PURGE_OBJECTS = MAX_MANIFEST_FILES + 1;
const R2_DELETE_BATCH = 1_000;
const MAX_LOCAL_EDGE_PURGE_ENTRIES = 256;
const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 3_000, 10_000] as const;
const manifestCache = new Map<string, { manifest: SharedManifest; cachedUntilMs: number }>();
const revocationCache = new Map<string, { revoked: boolean; cachedUntilMs: number }>();
const workerMetrics = {
  startedAtMs: Date.now(),
  requests: 0,
  failures: 0,
  cdnHits: 0,
  cdnMisses: 0,
  cdnFailures: 0,
  l2Hits: 0,
  l2Misses: 0,
  l2Failures: 0,
  bytesFromCdn: 0,
  bytesFromR2: 0,
  manifestsLoaded: 0,
  manifestCacheHits: 0,
  immutableFilesCreated: 0,
  immutableFilesAlreadyPresent: 0,
  objectsPurged: 0,
  bytesPurged: 0,
  quarantines: 0,
  recoveries: 0,
  orphanCandidates: 0,
  lookupLatencyMs: { count: 0, total: 0, maximum: 0, buckets: Array(LATENCY_BUCKETS_MS.length + 1).fill(0) as number[] },
  playlistLatencyMs: { count: 0, total: 0, maximum: 0, buckets: Array(LATENCY_BUCKETS_MS.length + 1).fill(0) as number[] },
};

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

function boundedEnvInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function exactObjectKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new WorkerHttpError(400, "INVALID_OBJECT_KEY", "Invalid media cache object key");
  }
  return key;
}

function recordLatency(
  metric: { count: number; total: number; maximum: number; buckets: number[] },
  elapsedMs: number,
): void {
  const value = Math.max(0, Math.round(Number(elapsedMs) || 0));
  metric.count += 1;
  metric.total += value;
  metric.maximum = Math.max(metric.maximum, value);
  const bucket = LATENCY_BUCKETS_MS.findIndex((limit) => value <= limit);
  metric.buckets[bucket < 0 ? LATENCY_BUCKETS_MS.length : bucket] += 1;
}

function publicLatencyMetric(metric: { count: number; total: number; maximum: number; buckets: number[] }) {
  return {
    count: metric.count,
    average: metric.count ? Number((metric.total / metric.count).toFixed(2)) : null,
    maximum: metric.count ? metric.maximum : null,
    buckets: Object.fromEntries([
      ...LATENCY_BUCKETS_MS.map((limit, index) => [`le_${limit}`, metric.buckets[index]]),
      ["gt_10000", metric.buckets[LATENCY_BUCKETS_MS.length]],
    ]),
  };
}

function publicWorkerMetrics(env: MediaCacheWorkerEnv): Record<string, unknown> {
  return {
    protocol: 1,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - workerMetrics.startedAtMs) / 1_000)),
    requests: workerMetrics.requests,
    failures: workerMetrics.failures,
    layers: {
      cdn: {
        hits: workerMetrics.cdnHits,
        misses: workerMetrics.cdnMisses,
        failures: workerMetrics.cdnFailures,
        bytes: workerMetrics.bytesFromCdn,
      },
      r2: {
        hits: workerMetrics.l2Hits,
        misses: workerMetrics.l2Misses,
        failures: workerMetrics.l2Failures,
        bytes: workerMetrics.bytesFromR2,
      },
    },
    manifests: {
      loaded: workerMetrics.manifestsLoaded,
      memoryHits: workerMetrics.manifestCacheHits,
    },
    lifecycle: {
      immutableFilesCreated: workerMetrics.immutableFilesCreated,
      immutableFilesAlreadyPresent: workerMetrics.immutableFilesAlreadyPresent,
      purged: workerMetrics.objectsPurged,
      bytesPurged: workerMetrics.bytesPurged,
      quarantined: workerMetrics.quarantines,
      recovered: workerMetrics.recoveries,
      orphanCandidates: workerMetrics.orphanCandidates,
    },
    latencyMs: {
      lookup: publicLatencyMetric(workerMetrics.lookupLatencyMs),
      playlist: publicLatencyMetric(workerMetrics.playlistLatencyMs),
    },
    quotas: {
      r2MaxBytes: boundedEnvInteger(
        env.MEDIA_CACHE_R2_MAX_BYTES,
        1024 * 1024 * 1024 * 1024,
        1024 * 1024 * 1024,
        Number.MAX_SAFE_INTEGER,
      ),
      r2MaxObjects: boundedEnvInteger(env.MEDIA_CACHE_R2_MAX_OBJECTS, 250_000, 1_000, 10_000_000),
      maxFilesPerObject: boundedEnvInteger(
        env.MEDIA_CACHE_MAX_FILES_PER_OBJECT,
        MAX_MANIFEST_FILES,
        4,
        MAX_MANIFEST_FILES,
      ),
      globalPurgeConfigured: cloudflareGlobalPurgeConfigured(env),
    },
  };
}

function edgeCache(env: MediaCacheWorkerEnv): EdgeCacheLike | null {
  if (env.MEDIA_CACHE_EDGE_CACHE) return env.MEDIA_CACHE_EDGE_CACHE;
  const storage = (globalThis as unknown as { caches?: { default?: EdgeCacheLike } }).caches;
  return storage?.default ?? null;
}

async function publicR2Read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (_) {
    workerMetrics.l2Failures += 1;
    throw new WorkerHttpError(503, "R2_UNAVAILABLE", "Media cache object storage is temporarily unavailable");
  }
}

function canonicalEdgeCacheRequest(request: Request, objectKey: string, assetSha256: string): Request {
  const source = new URL(request.url);
  source.pathname = `/__norva_private_media_cache/v1/${objectKey}/${assetSha256}`;
  source.search = "";
  source.hash = "";
  return new Request(source.toString(), { method: "GET" });
}

function objectCacheTag(objectKey: string): string {
  return `norva-mc-${exactObjectKey(objectKey)}`;
}

function cloudflareGlobalPurgeConfigured(env: MediaCacheWorkerEnv): boolean {
  return /^[0-9a-f]{32}$/i.test(String(env.MEDIA_CACHE_CLOUDFLARE_ZONE_ID || ""))
    && /^[A-Za-z0-9_-]{32,256}$/.test(String(env.MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN || ""));
}

async function purgeCloudflareCacheTag(
  env: MediaCacheWorkerEnv,
  objectKey: string,
): Promise<{ configured: boolean; success: boolean; status: number | null }> {
  if (!cloudflareGlobalPurgeConfigured(env)) {
    return { configured: false, success: false, status: null };
  }
  const zoneId = String(env.MEDIA_CACHE_CLOUDFLARE_ZONE_ID);
  const token = String(env.MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN);
  const request = env.MEDIA_CACHE_CLOUDFLARE_PURGE_FETCH || fetch;
  try {
    const response = await request(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: [objectCacheTag(objectKey)] }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { configured: true, success: false, status: response.status };
    }
    const payload = await response.json().catch(() => null) as { success?: unknown } | null;
    return { configured: true, success: payload?.success === true, status: response.status };
  } catch (_) {
    return { configured: true, success: false, status: null };
  }
}

function quarantineKey(objectKey: string): string {
  return `${QUARANTINE_PREFIX}${exactObjectKey(objectKey)}`;
}

async function objectQuarantine(
  env: MediaCacheWorkerEnv,
  objectKey: string,
): Promise<{ reason: string } | null> {
  const marker = await env.MEDIA_CACHE_BUCKET.head(quarantineKey(objectKey));
  if (!marker) return null;
  const reason = String(marker.customMetadata?.reason || "integrity-failure").toLowerCase();
  return { reason: /^[a-z][a-z0-9_-]{0,63}$/.test(reason) ? reason : "integrity-failure" };
}

async function isObjectQuarantined(env: MediaCacheWorkerEnv, objectKey: string): Promise<boolean> {
  return Boolean(await objectQuarantine(env, objectKey));
}

async function markObjectQuarantined(
  env: MediaCacheWorkerEnv,
  objectKey: string,
  reason: string,
): Promise<void> {
  const normalizedKey = exactObjectKey(objectKey);
  const normalizedReason = /^[a-z][a-z0-9_-]{0,63}$/.test(reason) ? reason : "integrity-failure";
  const existing = await objectQuarantine(env, normalizedKey);
  const priority = (value: string): number => {
    if (value === "security") return 4;
    if (value === "legal") return 3;
    if (value === "corruption") return 2;
    return 1;
  };
  if (existing && priority(existing.reason) >= priority(normalizedReason)) {
    manifestCache.delete(normalizedKey);
    return;
  }
  const body = encoder.encode("quarantined\n");
  const digest = await sha256Hex(body);
  await env.MEDIA_CACHE_BUCKET.put(quarantineKey(normalizedKey), body, {
    sha256: digest,
    httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
    customMetadata: {
      kind: "media-cache-quarantine",
      "object-key": normalizedKey,
      reason: normalizedReason,
      "norva-sha256": digest,
    },
  });
  manifestCache.delete(normalizedKey);
  workerMetrics.quarantines += 1;
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

function isolatedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", isolatedArrayBuffer(bytes))));
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
  const quarantine = await objectQuarantine(env, metadata["object-key"]);
  if (quarantine && quarantine.reason !== "corruption") {
    throw new WorkerHttpError(409, "OBJECT_QUARANTINED", "Media cache object is quarantined");
  }
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
      || !uploaded.checksums?.sha256
      || bytesToHex(new Uint8Array(uploaded.checksums.sha256)) !== expectedSha256) {
      throw new WorkerHttpError(502, "OBJECT_WRITE_UNVERIFIED", "Media cache object write could not be verified");
    }
    workerMetrics.immutableFilesCreated += 1;
    return jsonResponse({ ok: true, status: "created", key, sha256: expectedSha256, size: declaredSize }, 201);
  }
  const existing = await env.MEDIA_CACHE_BUCKET.head(key);
  if (existing && existing.size === declaredSize
    && existing.customMetadata?.["norva-sha256"] === expectedSha256
    && existing.checksums?.sha256
    && bytesToHex(new Uint8Array(existing.checksums.sha256)) === expectedSha256
    && canonicalMediaCacheJson(externalMetadata(existing.customMetadata)) === canonicalMediaCacheJson(metadata)) {
    workerMetrics.immutableFilesAlreadyPresent += 1;
    return jsonResponse({ ok: true, status: "already-exists", key, sha256: expectedSha256, size: declaredSize });
  }
  throw new WorkerHttpError(409, "IMMUTABLE_CONFLICT", "Immutable media cache object conflict");
}

async function internalGetObject(env: MediaCacheWorkerEnv, key: string): Promise<Response> {
  const objectKey = key.match(/^media-cache\/v1\/[0-9a-f]{2}\/([0-9a-f]{64})\//)?.[1] || "";
  const quarantine = await objectQuarantine(env, objectKey);
  if (quarantine && quarantine.reason !== "corruption") {
    throw new WorkerHttpError(409, "OBJECT_QUARANTINED", "Media cache object is quarantined");
  }
  const object = await env.MEDIA_CACHE_BUCKET.get(key);
  if (!object) throw new WorkerHttpError(404, "OBJECT_NOT_FOUND", "Media cache object not found");
  const expectedSha256 = exactDigest(object.customMetadata?.["norva-sha256"]);
  if (!object.checksums?.sha256
    || bytesToHex(new Uint8Array(object.checksums.sha256)) !== expectedSha256) {
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
    headers.set(
      "access-control-expose-headers",
      "Content-Length, Content-Range, ETag, Server-Timing, X-Norva-Cache-Layer",
    );
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
  return crypto.subtle.importKey(
    "raw",
    isolatedArrayBuffer(hexToBytes(secretHex)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function decodeCanonicalBase64Url(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== "string") throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  return base64UrlDecode(value, maximumBytes);
}

function normalizeManifestPayload(
  value: unknown,
  expectedObjectKey: string,
  nowMs: number,
  maximumFiles = MAX_MANIFEST_FILES,
): SharedManifest {
  const keys = [
    "schema", "identityKind", "objectKey", "components", "rootPlaylist", "files",
    "totalBytes", "createdAtMs", "expiresAtMs", "completion",
  ];
  if (!exactKeys(value, keys) || value.schema !== 1 || value.identityKind !== "global-media-object"
    || value.objectKey !== expectedObjectKey || !isPlainObject(value.components)
    || Object.keys(value.components).sort().join(",") !== "audio,content,duration,pipeline,segmenter,size,subtitles,video"
    || Object.values(value.components).some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > maximumFiles
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

async function loadManifest(
  env: MediaCacheWorkerEnv,
  objectKey: string,
  nowMs: number,
  allowQuarantined = false,
): Promise<SharedManifest> {
  if (!allowQuarantined && await publicR2Read(() => isObjectQuarantined(env, objectKey))) {
    throw new WorkerHttpError(503, "OBJECT_QUARANTINED", "Media cache object is quarantined");
  }
  const cached = manifestCache.get(objectKey);
  if (cached && cached.cachedUntilMs > nowMs && cached.manifest.expiresAtMs > nowMs) {
    workerMetrics.manifestCacheHits += 1;
    return cached.manifest;
  }
  const key = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/manifest.auth.json`;
  const object = await publicR2Read(() => env.MEDIA_CACHE_BUCKET.get(key));
  if (!object) {
    workerMetrics.l2Misses += 1;
    throw new WorkerHttpError(404, "OBJECT_NOT_READY", "Media cache object is not ready");
  }
  workerMetrics.l2Hits += 1;
  if (object.size <= 0 || object.size > MAX_MANIFEST_BYTES) {
    throw new WorkerHttpError(502, "MANIFEST_INVALID", "Media cache manifest is invalid");
  }
  const body = new Uint8Array(await publicR2Read(() => object.arrayBuffer()));
  const bodySha256 = await sha256Hex(body);
  if (body.length !== object.size
    || object.customMetadata?.["norva-sha256"] !== bodySha256
    || !object.checksums?.sha256
    || bytesToHex(new Uint8Array(object.checksums.sha256)) !== bodySha256) {
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
    isolatedArrayBuffer(mac),
    isolatedArrayBuffer(encoder.encode(`norva-shared-hls-manifest-v1\0${envelope.keyId}\0${encodedPayload}`)),
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
  const manifest = normalizeManifestPayload(
    payload,
    objectKey,
    nowMs,
    boundedEnvInteger(env.MEDIA_CACHE_MAX_FILES_PER_OBJECT, MAX_MANIFEST_FILES, 4, MAX_MANIFEST_FILES),
  );
  if (manifestCache.size >= MANIFEST_CACHE_MAX) manifestCache.delete(manifestCache.keys().next().value as string);
  manifestCache.set(objectKey, { manifest, cachedUntilMs: Math.min(manifest.expiresAtMs, nowMs + MANIFEST_CACHE_MS) });
  workerMetrics.manifestsLoaded += 1;
  return manifest;
}

async function publicHlsAsset(
  request: Request,
  env: MediaCacheWorkerEnv,
  objectKey: string,
  logicalPath: string,
  executionContext?: ExecutionContextLike,
): Promise<Response> {
  const lookupStartedAt = Date.now();
  if (!/^[0-9a-f]{64}$/.test(objectKey)) throw new WorkerHttpError(404, "OBJECT_NOT_FOUND", "Media cache object not found");
  const nowMs = Date.now();
  let ticket: MediaCacheTicketPayload;
  try { ticket = await verifyMediaCacheTicket(env.MEDIA_CACHE_TICKET_HMAC_KEY, extractTicket(request), nowMs); } catch (error) {
    if (error instanceof MediaCacheTicketError) throw new WorkerHttpError(401, error.code, "Media cache ticket is invalid");
    throw error;
  }
  if (ticket.objectKey !== objectKey
    || await publicR2Read(() => playbackRevoked(env, ticket, nowMs))) {
    throw new WorkerHttpError(403, "ACCESS_REVOKED", "Media cache access is revoked");
  }
  const assetPath = safeAssetPath(logicalPath);
  let manifest: SharedManifest;
  try {
    manifest = await loadManifest(env, objectKey, nowMs);
  } catch (error) {
    const code = error instanceof WorkerHttpError ? error.code : "";
    if (["MANIFEST_INVALID"].includes(code)) {
      await markObjectQuarantined(env, objectKey, "manifest-integrity").catch(() => {});
    }
    throw error;
  }
  const record = manifest.files.find((file) => file.path === assetPath);
  if (!record) throw new WorkerHttpError(404, "ASSET_NOT_FOUND", "Media cache asset not found");
  const range = request.headers.get("range");
  const cache = edgeCache(env);
  const canonicalRequest = canonicalEdgeCacheRequest(request, objectKey, record.sha256);
  if (!range && request.method === "GET" && cache) {
    let cached: Response | undefined;
    let cacheLookupFailed = false;
    try {
      cached = await cache.match(canonicalRequest);
    } catch (_) {
      cacheLookupFailed = true;
      workerMetrics.cdnFailures += 1;
    }
    if (cached) {
      const cachedSize = Number(cached.headers.get("content-length"));
      const cachedDigest = cached.headers.get("x-norva-content-sha256");
      if (cached.status === 200 && cachedSize === record.size && cachedDigest === record.sha256 && cached.body) {
        workerMetrics.cdnHits += 1;
        workerMetrics.bytesFromCdn += record.size;
        const headers = corsHeaders(request, env);
        headers.set("content-type", record.contentType);
        headers.set("content-length", String(record.size));
        // The Worker cache is shared explicitly through Cache API. Browser
        // storage must never outlive a ticket revocation or binding change.
        headers.set("cache-control", "private, no-store");
        headers.set("accept-ranges", "bytes");
        headers.set("etag", cached.headers.get("etag") || `\"${record.sha256}\"`);
        headers.set("x-norva-cache-layer", "cdn");
        headers.set("server-timing", `cache;desc=cdn-hit;dur=${Math.max(0, Date.now() - lookupStartedAt)}`);
        recordLatency(workerMetrics.lookupLatencyMs, Date.now() - lookupStartedAt);
        if (assetPath.toLowerCase().endsWith(".m3u8")) {
          recordLatency(workerMetrics.playlistLatencyMs, Date.now() - lookupStartedAt);
        }
        return new Response(cached.body, { status: 200, headers });
      }
      await cache.delete(canonicalRequest).catch(() => {
        workerMetrics.cdnFailures += 1;
        return false;
      });
    }
    if (!cacheLookupFailed) workerMetrics.cdnMisses += 1;
  }
  const objectStorageKey = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/${record.objectName}`;
  const object = request.method === "HEAD" && !range
    ? await publicR2Read(() => env.MEDIA_CACHE_BUCKET.head(objectStorageKey))
    : await publicR2Read(() => env.MEDIA_CACHE_BUCKET.get(
      objectStorageKey,
      range ? { range: request.headers } : undefined,
    ));
  if (!object || object.size !== record.size
    || object.customMetadata?.["norva-sha256"] !== record.sha256
    || !object.checksums?.sha256
    || bytesToHex(new Uint8Array(object.checksums.sha256)) !== record.sha256) {
    if (!object) workerMetrics.l2Misses += 1;
    await markObjectQuarantined(env, objectKey, "asset-integrity").catch(() => {});
    throw new WorkerHttpError(502, "ASSET_CORRUPT", "Media cache asset is unavailable");
  }
  workerMetrics.l2Hits += 1;
  const headers = corsHeaders(request, env);
  headers.set("content-type", record.contentType);
  headers.set("cache-control", "private, no-store");
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
  headers.set("x-norva-cache-layer", "r2");
  headers.set("server-timing", `cache;desc=r2;dur=${Math.max(0, Date.now() - lookupStartedAt)}`);
  workerMetrics.bytesFromR2 += status === 206 && object.range
    ? Number(object.range.length || 0)
    : record.size;
  recordLatency(workerMetrics.lookupLatencyMs, Date.now() - lookupStartedAt);
  if (assetPath.toLowerCase().endsWith(".m3u8")) {
    recordLatency(workerMetrics.playlistLatencyMs, Date.now() - lookupStartedAt);
  }
  const objectBody = "body" in object && object.body instanceof ReadableStream
    ? object.body as ReadableStream<Uint8Array>
    : null;
  if (!range && request.method === "GET" && cache && objectBody) {
    const cacheHeaders = new Headers({
      "content-type": record.contentType,
      "content-length": String(record.size),
      "cache-control": "public, max-age=31536000, immutable",
      "etag": object.httpEtag || object.etag,
      "x-norva-content-sha256": record.sha256,
      "cache-tag": objectCacheTag(objectKey),
    });
    const cachedResponse = new Response(objectBody, { status: 200, headers: cacheHeaders });
    const write = cache.put(canonicalRequest, cachedResponse.clone()).catch(() => {
      workerMetrics.cdnFailures += 1;
    });
    if (executionContext) executionContext.waitUntil(write);
    else await write;
    return new Response(cachedResponse.body, { status, headers });
  }
  return new Response(request.method === "HEAD" ? null : objectBody, { status, headers });
}

async function listObjectRecords(
  env: MediaCacheWorkerEnv,
  objectKey: string,
): Promise<Array<Omit<R2ObjectLike, "body" | "arrayBuffer">>> {
  const prefix = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/`;
  const records: Array<Omit<R2ObjectLike, "body" | "arrayBuffer">> = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA_CACHE_BUCKET.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    for (const object of page.objects || []) {
      if (!object.key.startsWith(prefix)) {
        throw new WorkerHttpError(502, "R2_LIST_INVALID", "Media cache inventory is invalid");
      }
      records.push(object);
      if (records.length > MAX_PURGE_OBJECTS) {
        throw new WorkerHttpError(409, "OBJECT_FILE_LIMIT_EXCEEDED", "Media cache object exceeds its purge bound");
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) {
      throw new WorkerHttpError(502, "R2_LIST_INVALID", "Media cache inventory is invalid");
    }
  } while (cursor);
  return records;
}

async function purgeEdgeObject(
  request: Request,
  env: MediaCacheWorkerEnv,
  objectKey: string,
  records: Array<Omit<R2ObjectLike, "body" | "arrayBuffer">>,
): Promise<{ removed: number; attempted: number; truncated: boolean }> {
  const cache = edgeCache(env);
  if (!cache) return { removed: 0, attempted: 0, truncated: false };
  let removed = 0;
  const candidates = records.filter((record) => {
    const digest = record.customMetadata?.["asset-sha256"];
    return Boolean(digest && /^[0-9a-f]{64}$/.test(digest));
  });
  const bounded = candidates.slice(0, MAX_LOCAL_EDGE_PURGE_ENTRIES);
  for (const record of bounded) {
    const digest = record.customMetadata?.["asset-sha256"];
    if (!digest) continue;
    if (await cache.delete(canonicalEdgeCacheRequest(request, objectKey, digest)).catch(() => false)) removed += 1;
  }
  return { removed, attempted: bounded.length, truncated: bounded.length < candidates.length };
}

async function purgeCacheObject(
  request: Request,
  env: MediaCacheWorkerEnv,
  objectKeyValue: string,
  reasonValue: string,
): Promise<Response> {
  const objectKey = exactObjectKey(objectKeyValue);
  const reason = String(reasonValue || "").trim().toLowerCase();
  if (!["corruption", "eviction", "legal", "orphan", "security"].includes(reason)) {
    throw new WorkerHttpError(400, "INVALID_PURGE_REASON", "Invalid media cache purge reason");
  }
  if (["corruption", "legal", "security"].includes(reason)) {
    await markObjectQuarantined(env, objectKey, reason);
  }
  const records = await listObjectRecords(env, objectKey);
  const localEdgePurge = await purgeEdgeObject(request, env, objectKey, records);
  const globalEdgePurge = await purgeCloudflareCacheTag(env, objectKey);
  if (["corruption", "legal", "security"].includes(reason) && !globalEdgePurge.success) {
    throw new WorkerHttpError(
      503,
      "GLOBAL_EDGE_PURGE_UNAVAILABLE",
      "Global media cache purge is unavailable",
    );
  }
  for (let offset = 0; offset < records.length; offset += R2_DELETE_BATCH) {
    await env.MEDIA_CACHE_BUCKET.delete(records.slice(offset, offset + R2_DELETE_BATCH).map((record) => record.key));
  }
  manifestCache.delete(objectKey);
  const bytesPurged = records.reduce((sum, record) => sum + Math.max(0, Number(record.size) || 0), 0);
  workerMetrics.objectsPurged += 1;
  workerMetrics.bytesPurged += bytesPurged;
  return jsonResponse({
    ok: true,
    protocol: 1,
    objectKey,
    reason,
    objectsPurged: records.length,
    bytesPurged,
    edgeEntriesPurged: localEdgePurge.removed,
    edgeEntriesAttempted: localEdgePurge.attempted,
    edgeLocalPurgeTruncated: localEdgePurge.truncated,
    globalEdgePurgeConfigured: globalEdgePurge.configured,
    globalEdgePurgeCompleted: globalEdgePurge.success,
    quarantined: ["corruption", "legal", "security"].includes(reason),
  });
}

async function recoverCacheObject(
  request: Request,
  env: MediaCacheWorkerEnv,
  objectKeyValue: string,
): Promise<Response> {
  const objectKey = exactObjectKey(objectKeyValue);
  const phase = String(request.headers.get("x-norva-recovery-phase") || "verify").trim().toLowerCase();
  if (phase !== "verify" && phase !== "commit") {
    throw new WorkerHttpError(400, "INVALID_RECOVERY_PHASE", "Invalid media cache recovery phase");
  }
  const quarantine = await objectQuarantine(env, objectKey);
  const quarantined = Boolean(quarantine);
  if (!quarantined && phase === "verify") {
    throw new WorkerHttpError(409, "OBJECT_NOT_QUARANTINED", "Media cache object is not quarantined");
  }
  if (quarantine && quarantine.reason !== "corruption") {
    throw new WorkerHttpError(409, "OBJECT_RECOVERY_FORBIDDEN", "Media cache object cannot be recovered");
  }
  manifestCache.delete(objectKey);
  const manifest = await loadManifest(env, objectKey, Date.now(), true);
  const manifestRecord = await env.MEDIA_CACHE_BUCKET.head(
    `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/manifest.auth.json`,
  );
  const manifestSha256 = manifestRecord?.customMetadata?.["norva-sha256"] || "";
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new WorkerHttpError(409, "OBJECT_RECOVERY_UNVERIFIED", "Media cache object recovery is unverified");
  }
  for (const file of manifest.files) {
    const object = await env.MEDIA_CACHE_BUCKET.head(
      `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/${file.objectName}`,
    );
    if (!object || object.size !== file.size
      || object.customMetadata?.["norva-sha256"] !== file.sha256
      || !object.checksums?.sha256
      || bytesToHex(new Uint8Array(object.checksums.sha256)) !== file.sha256) {
      manifestCache.delete(objectKey);
      throw new WorkerHttpError(409, "OBJECT_RECOVERY_UNVERIFIED", "Media cache object recovery is unverified");
    }
  }
  if (phase === "commit" && quarantined) {
    await env.MEDIA_CACHE_BUCKET.delete(quarantineKey(objectKey));
    manifestCache.delete(objectKey);
    workerMetrics.recoveries += 1;
  }
  return jsonResponse({
    ok: true,
    protocol: 1,
    objectKey,
    verifiedFiles: manifest.files.length,
    totalBytes: manifest.totalBytes,
    components: manifest.components,
    rootPlaylist: manifest.rootPlaylist,
    manifestSha256,
    expiresAtMs: manifest.expiresAtMs,
    phase,
    status: phase === "verify"
      ? "verified-quarantined"
      : (quarantined ? "ready" : "already-ready"),
  });
}

async function inventoryPage(request: Request, env: MediaCacheWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = boundedEnvInteger(url.searchParams.get("limit"), 1_000, 1, 1_000);
  const minimumAgeMs = boundedEnvInteger(
    url.searchParams.get("minimumAgeMs"),
    24 * 60 * 60 * 1_000,
    5 * 60 * 1_000,
    30 * 24 * 60 * 60 * 1_000,
  );
  const cursor = url.searchParams.get("cursor") || undefined;
  const page = await env.MEDIA_CACHE_BUCKET.list({ prefix: "media-cache/v1/", cursor, limit });
  const nowMs = Date.now();
  const candidates = new Map<string, { oldestAtMs: number; listedObjects: number; listedBytes: number }>();
  let listedBytes = 0;
  for (const object of page.objects || []) {
    listedBytes += Math.max(0, Number(object.size) || 0);
    const match = object.key.match(/^media-cache\/v1\/[0-9a-f]{2}\/([0-9a-f]{64})\//);
    if (!match || match[1].slice(0, 2) !== object.key.slice("media-cache/v1/".length, "media-cache/v1/".length + 2)) continue;
    const uploadedAtMs = object.uploaded instanceof Date ? object.uploaded.getTime() : nowMs;
    const current = candidates.get(match[1]) || { oldestAtMs: uploadedAtMs, listedObjects: 0, listedBytes: 0 };
    current.oldestAtMs = Math.min(current.oldestAtMs, uploadedAtMs);
    current.listedObjects += 1;
    current.listedBytes += Math.max(0, Number(object.size) || 0);
    candidates.set(match[1], current);
  }
  const orphanCandidates: Array<Record<string, unknown>> = [];
  const manifestCandidates: Array<Record<string, unknown>> = [];
  for (const [objectKey, candidate] of candidates) {
    if (nowMs - candidate.oldestAtMs < minimumAgeMs) continue;
    const manifest = await env.MEDIA_CACHE_BUCKET.head(
      `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/manifest.auth.json`,
    );
    if (!manifest) {
      orphanCandidates.push({ objectKey, ageMs: nowMs - candidate.oldestAtMs, ...candidate });
    } else {
      // A manifest proves R2 completeness, not database authority. Edge will
      // reconcile this bounded candidate against PostgreSQL; ready objects are
      // retained, while callbacks lost during an outage become delayed orphans.
      manifestCandidates.push({ objectKey, ageMs: nowMs - candidate.oldestAtMs, ...candidate });
    }
  }
  workerMetrics.orphanCandidates += orphanCandidates.length;
  return jsonResponse({
    ok: true,
    protocol: 1,
    listedObjects: page.objects?.length || 0,
    listedBytes,
    orphanCandidates,
    manifestCandidates,
    truncated: page.truncated === true,
    ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
  });
}

async function handle(
  request: Request,
  env: MediaCacheWorkerEnv,
  executionContext?: ExecutionContextLike,
): Promise<Response> {
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
      sharedEdgeCacheConfigured: Boolean(edgeCache(env)),
      globalEdgePurgeConfigured: cloudflareGlobalPurgeConfigured(env),
      metricsProtocol: 1,
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
    if (segments[2] === "metrics" && segments.length === 3 && request.method === "GET") {
      return jsonResponse({ ok: true, ...publicWorkerMetrics(env) });
    }
    if (segments[2] === "inventory" && segments.length === 3 && request.method === "GET") {
      return inventoryPage(request, env);
    }
    if (segments[2] === "cache-objects" && segments.length === 4) {
      if (request.method === "DELETE") {
        return purgeCacheObject(request, env, segments[3], request.headers.get("x-norva-purge-reason") || "");
      }
      if (request.method === "PUT") {
        await markObjectQuarantined(
          env,
          segments[3],
          request.headers.get("x-norva-quarantine-reason") || "integrity-failure",
        );
        return jsonResponse({ ok: true, protocol: 1, objectKey: exactObjectKey(segments[3]), status: "quarantined" });
      }
    }
    if (segments[2] === "recoveries" && segments.length === 4 && request.method === "POST") {
      return recoverCacheObject(request, env, segments[3]);
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
    return publicHlsAsset(request, env, objectKey, logicalPath, executionContext);
  }
  if (request.method === "OPTIONS" && segments[0] === "v1" && segments[1] === "hls") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  throw new WorkerHttpError(404, "ROUTE_NOT_FOUND", "Route not found");
}

export default {
  async fetch(
    request: Request,
    env: MediaCacheWorkerEnv,
    executionContext?: ExecutionContextLike,
  ): Promise<Response> {
    workerMetrics.requests += 1;
    try {
      return await handle(request, env, executionContext);
    } catch (error) {
      workerMetrics.failures += 1;
      const status = error instanceof WorkerHttpError ? error.status : 500;
      const code = error instanceof WorkerHttpError ? error.code : "INTERNAL_ERROR";
      const message = status >= 500 ? "Media cache is temporarily unavailable" : (error instanceof Error ? error.message : "Request failed");
      return jsonResponse({ ok: false, code, error: message }, status, corsHeaders(request, env));
    }
  },
};
