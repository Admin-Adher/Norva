const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_ROLES = new Set(["leader", "follower", "ready"]);
const WORK_STATES = new Set(["producing", "ready"]);

export const MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL = 1;
export const MEDIA_CACHE_SINGLEFLIGHT_PIPELINE_EPOCH = "shared-hls-exact-tracks-v5";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, field, maximum) {
  if (typeof value !== "string") throw new TypeError(`${field}_must_be_string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${field}_invalid`);
  }
  return normalized;
}

function decodeOnce(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return String(value || "");
  }
}
function hexBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64Bytes(value) {
  const normalized = value.replace(/^base64:/i, "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) throw new TypeError("coordination_key_invalid");
  let binary;
  if (typeof globalThis.atob === "function") binary = globalThis.atob(padded);
  else if (typeof globalThis.Buffer === "function") binary = globalThis.Buffer.from(padded, "base64").toString("binary");
  else throw new TypeError("coordination_key_decoder_unavailable");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function mediaCacheCoordinationKeyBytes(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new TypeError("coordination_key_missing");
  const bytes = /^[0-9a-f]{64}$/i.test(raw) ? hexBytes(raw) : base64Bytes(raw);
  if (bytes.byteLength !== 32) throw new TypeError("coordination_key_must_be_32_bytes");
  return bytes;
}

export function mediaCacheCoordinationKeyIsValid(value) {
  try {
    mediaCacheCoordinationKeyBytes(value);
    return true;
  } catch (_) {
    return false;
  }
}

async function hmacHex(keyBytes, domain, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${domain}\0${value}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerCapabilityParts(targetUrl, explicitAccountScope = null) {
  const parsed = new URL(targetUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new TypeError("provider_target_url_invalid");
  }
  const host = parsed.host.toLowerCase();
  const explicit = typeof explicitAccountScope === "string" ? explicitAccountScope.trim() : "";
  if (explicit) {
    return { host, accountScope: boundedText(explicit, "provider_account_scope", 2048) };
  }

  let username = parsed.searchParams.get("username") || "";
  let password = parsed.searchParams.get("password") || "";
  const segments = parsed.pathname.split("/").filter(Boolean);
  const streamTypeIndex = segments.findIndex((segment) =>
    ["movie", "series", "live"].includes(String(segment || "").toLowerCase()));
  if ((!username || !password) && streamTypeIndex >= 0) {
    username = username || decodeOnce(segments[streamTypeIndex + 1]);
    password = password || decodeOnce(segments[streamTypeIndex + 2]);
  }
  if (username && password) {
    return { host, accountScope: `${host}\0${username}\0${password}` };
  }

  parsed.hash = "";
  return { host, accountScope: `${host}\0opaque\0${parsed.href}` };
}

function providerAssetParts(targetUrl, itemType, itemId, container) {
  const parsed = new URL(targetUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new TypeError("provider_target_url_invalid");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const streamTypeIndex = segments.findIndex((segment) =>
    ["movie", "series", "live"].includes(String(segment || "").toLowerCase()));
  const streamType = streamTypeIndex >= 0
    ? String(segments[streamTypeIndex]).toLowerCase()
    : (itemType === "movie" ? "movie" : "series");
  const streamId = streamTypeIndex >= 0 && segments[streamTypeIndex + 3]
    ? decodeOnce(segments[streamTypeIndex + 3]).replace(/\.[A-Za-z0-9]{1,12}$/, "")
    : boundedText(itemId, "item_id", 512);
  return {
    host: parsed.host.toLowerCase(),
    streamType,
    streamId: boundedText(streamId, "stream_id", 512),
    itemType: itemType === "movie" ? "movie" : "episode",
    itemId: boundedText(itemId, "item_id", 512),
    container: boundedText(container || "mkv", "container", 32).toLowerCase(),
  };
}

export async function deriveMediaCacheCoordinationFingerprints(options = {}) {
  const keyBytes = mediaCacheCoordinationKeyBytes(options.key);
  const targetUrl = boundedText(options.targetUrl, "target_url", 8192);
  const capability = providerCapabilityParts(targetUrl, options.providerAccountScope);
  const asset = providerAssetParts(targetUrl, options.itemType, options.itemId, options.container);
  const pipelineEpoch = boundedText(
    options.pipelineEpoch || MEDIA_CACHE_SINGLEFLIGHT_PIPELINE_EPOCH,
    "pipeline_epoch",
    128,
  );
  const accountFingerprint = await hmacHex(
    keyBytes,
    "norva-media-cache-account-v1",
    capability.accountScope,
  );
  const workFingerprint = await hmacHex(
    keyBytes,
    "norva-media-cache-work-v1",
    [
      accountFingerprint,
      asset.host,
      asset.streamType,
      asset.streamId,
      asset.itemType,
      asset.itemId,
      asset.container,
      pipelineEpoch,
    ].join("\0"),
  );
  const ownerInstanceId = boundedText(options.ownerInstanceId, "owner_instance_id", 256);
  const ownerInstanceFingerprint = await hmacHex(
    keyBytes,
    "norva-media-cache-owner-instance-v1",
    ownerInstanceId,
  );
  return Object.freeze({
    protocol: MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL,
    accountFingerprint,
    workFingerprint,
    ownerInstanceFingerprint,
  });
}

export function normalizeMediaCacheProducerClaim(value) {
  const row = isRecord(value) ? value : {};
  const role = String(row.claim_role ?? row.claimRole ?? "").toLowerCase();
  if (!WORK_ROLES.has(role)) return null;
  const leaseToken = row.lease_token ?? row.leaseToken ?? null;
  const objectKey = row.object_key ?? row.objectKey ?? null;
  const leaseExpiresAt = row.lease_expires_at ?? row.leaseExpiresAt ?? null;
  if (role === "leader" && (!UUID_PATTERN.test(String(leaseToken || "")) || !Number.isFinite(Date.parse(String(leaseExpiresAt || ""))))) {
    return null;
  }
  if (role === "ready" && !SHA256_PATTERN.test(String(objectKey || "").toLowerCase())) return null;
  if (role === "follower" && !Number.isFinite(Date.parse(String(leaseExpiresAt || "")))) return null;
  return Object.freeze({
    role,
    leaseToken: role === "leader" ? String(leaseToken).toLowerCase() : null,
    objectKey: role === "ready" ? String(objectKey).toLowerCase() : null,
    leaseExpiresAt: role === "ready" ? null : new Date(String(leaseExpiresAt)).toISOString(),
    preemptRequested: row.preempt_requested === true || row.preemptRequested === true,
  });
}

export function normalizeMediaCacheWorkState(value) {
  const row = isRecord(value) ? value : {};
  const state = String(row.work_state ?? row.workState ?? "").toLowerCase();
  if (!WORK_STATES.has(state)) return null;
  const objectKey = row.object_key ?? row.objectKey ?? null;
  const leaseExpiresAt = row.lease_expires_at ?? row.leaseExpiresAt ?? null;
  if (state === "ready" && !SHA256_PATTERN.test(String(objectKey || "").toLowerCase())) return null;
  if (state === "producing" && !Number.isFinite(Date.parse(String(leaseExpiresAt || "")))) return null;
  return Object.freeze({
    state,
    objectKey: state === "ready" ? String(objectKey).toLowerCase() : null,
    producerStage: state === "producing" ? String(row.producer_stage ?? row.producerStage ?? "") : null,
    leaseExpiresAt: state === "producing" ? new Date(String(leaseExpiresAt)).toISOString() : null,
    preemptRequested: row.preempt_requested === true || row.preemptRequested === true,
  });
}

function abortError() {
  const error = new Error("media cache singleflight wait aborted");
  error.name = "AbortError";
  return error;
}

export async function awaitMediaCacheSingleflight(options = {}) {
  if (typeof options.claim !== "function" || typeof options.resolve !== "function") {
    throw new TypeError("media_cache_singleflight_callbacks_required");
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const timeoutMs = Math.max(0, Math.min(60_000, Number(options.timeoutMs) || 0));
  const pollMs = Math.max(25, Math.min(2_000, Number(options.pollMs) || 250));
  const deadline = now() + timeoutMs;
  let followerRegistrations = 0;
  let transferredFollowerRegistrations = 0;
  let claim = normalizeMediaCacheProducerClaim(await options.claim());
  if (!claim) throw new Error("media_cache_singleflight_claim_invalid");

  try {
    while (true) {
      if (options.signal?.aborted) throw abortError();
      if (claim.role === "leader" || claim.role === "ready") return claim;
      followerRegistrations += 1;

      while (now() < deadline) {
        if (options.signal?.aborted) throw abortError();
        const state = normalizeMediaCacheWorkState(await options.resolve());
        if (state?.state === "ready") {
          return Object.freeze({
            role: "ready",
            leaseToken: null,
            objectKey: state.objectKey,
            leaseExpiresAt: null,
            preemptRequested: false,
          });
        }
        if (
          state?.state === "producing" &&
          state.preemptRequested !== true &&
          typeof options.tryJoin === "function"
        ) {
          const join = await options.tryJoin(state);
          if (isRecord(join)) {
            const registrationTransferred = join.joined === true ||
              join.registrationTransferred === true;
            if (registrationTransferred) transferredFollowerRegistrations += 1;
            if (join.error !== undefined && join.error !== null) throw join.error;
          }
          if (isRecord(join) && join.joined === true) {
            return Object.freeze({
              role: "joined",
              leaseToken: null,
              objectKey: null,
              leaseExpiresAt: state.leaseExpiresAt,
              preemptRequested: false,
              joinValue: join.value,
            });
          }
        }
        if (!state || Date.parse(String(state.leaseExpiresAt || "")) <= now()) {
          claim = normalizeMediaCacheProducerClaim(await options.claim());
          if (!claim) throw new Error("media_cache_singleflight_reclaim_invalid");
          break;
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      }

      if (claim.role === "follower" && now() >= deadline) {
        return Object.freeze({
          role: "pending",
          leaseToken: null,
          objectKey: null,
          leaseExpiresAt: claim.leaseExpiresAt,
          preemptRequested: claim.preemptRequested,
        });
      }
    }
  } finally {
    if (typeof options.leave === "function") {
      const registrationsToLeave = Math.max(
        0,
        followerRegistrations - transferredFollowerRegistrations,
      );
      for (let count = 0; count < registrationsToLeave; count += 1) {
        await options.leave().catch(() => false);
      }
    }
  }
}
