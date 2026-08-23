// Atomic exclusion for the legacy direct-to-provider fallback used by active
// catalogue workflows. The database serializes this lease with credential
// transition creation on the same server-derived provider-affinity advisory
// lock. Only opaque SHA-256 snapshot proofs cross the Edge/SQL boundary; they
// are never returned or logged. A caller must never contact the provider
// directly unless the claim below succeeded.
// Rolling prerequisite: deploy DB 173000 then 174000 before these Edge bundles;
// apply 180000/181000 and their backfill, validation, and contract gates next.
// Every Phase 3 flag stays OFF until a later rollout is explicitly authorized.
// A DB-old missing-RPC response is retryable/fail-closed, never a bypass.

export const PROVIDER_DIRECT_FALLBACK_CLAIM_RPC = "norva_claim_source_direct_fallback_lease";
export const PROVIDER_DIRECT_FALLBACK_RELEASE_RPC = "norva_release_source_direct_fallback_lease";
export const PROVIDER_DIRECT_FALLBACK_ERROR_CODE = "PROVIDER_DIRECT_FALLBACK_RETRYABLE";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ProviderDirectFallbackLeaseError extends Error {
  constructor(reason, retryAfterSeconds = null) {
    super("Provider direct fallback is temporarily unavailable");
    this.name = "ProviderDirectFallbackLeaseError";
    this.status = 503;
    this.code = PROVIDER_DIRECT_FALLBACK_ERROR_CODE;
    this.reason = reason;
    this.retryable = true;
    this.retryAfterSeconds = boundedRetryAfter(retryAfterSeconds);
    this.details = {
      code: this.code,
      retryable: true,
      ...(this.retryAfterSeconds == null ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

export function directFallbackLeaseTtlSeconds(timeoutMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ProviderDirectFallbackLeaseError("invalid_timeout");
  }
  // The SQL contract caps TTL at 120 seconds. Refuse an operation whose own
  // deadline cannot fit with a 15-second release margin; silently clamping it
  // would let a transition start while the provider request is still alive.
  const ttl = Math.max(30, Math.ceil(timeout / 1000) + 15);
  if (ttl > 120) throw new ProviderDirectFallbackLeaseError("timeout_exceeds_lease");
  return ttl;
}

export function providerDirectFallbackLeaseOwner(scope) {
  const safeScope = String(scope ?? "catalog")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "catalog";
  return `edge-${safeScope}-${crypto.randomUUID()}`;
}

export async function buildProviderDirectFallbackSnapshot(input) {
  const serverUrl = String(input?.serverUrl ?? "").trim();
  const username = String(input?.username ?? "");
  const configCiphertext = String(input?.configCiphertext ?? "");
  const configRevision = revisionToken(input?.configRevision);
  let host = "";
  try {
    const parsed = new URL(serverUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("invalid");
    }
    host = parsed.host.toLowerCase();
  } catch (_) {
    throw new ProviderDirectFallbackLeaseError("invalid_snapshot");
  }
  // The provider contract treats whitespace as username data. Keep the exact
  // decrypted value in the digest and use trim only for non-empty validation.
  const accountKey = host && username.trim() ? `${host}/${username}` : "";
  if (!accountKey || accountKey.length > 300 || /[\u0000-\u001f\u007f]/u.test(accountKey) ||
    !configCiphertext || configCiphertext.length > 1024 * 1024 || !configRevision) {
    throw new ProviderDirectFallbackLeaseError("invalid_snapshot");
  }
  return Object.freeze({
    expectedProviderAccountAffinityHash: await sha256Hex(accountKey),
    expectedConfigRevision: configRevision,
    expectedConfigCiphertextHash: await sha256Hex(configCiphertext),
  });
}

// Build one serializer per logical source run. Gateway calls remain concurrent;
// only their direct fallback legs queue here, so sibling workers cannot contend
// with one another for the same exclusive database lease.
export function createSourceDirectFallbackLeaseRunner(context) {
  let tail = Promise.resolve();
  return function runSourceDirectFallback(timeoutMs, operation) {
    const pending = tail.then(() => withSourceDirectFallbackLease({
      db: context?.db,
      sourceId: context?.sourceId,
      userId: context?.userId,
      owner: providerDirectFallbackLeaseOwner(context?.ownerScope),
      ttlSeconds: directFallbackLeaseTtlSeconds(timeoutMs),
      expectedProviderAccountAffinityHash: context?.expectedProviderAccountAffinityHash,
      expectedConfigRevision: context?.expectedConfigRevision,
      expectedConfigCiphertextHash: context?.expectedConfigCiphertextHash,
    }, operation));
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
}

export async function withSourceDirectFallbackLease(options, operation) {
  if (!options || typeof options !== "object" || typeof operation !== "function") {
    throw new ProviderDirectFallbackLeaseError("invalid_context");
  }
  const db = options.db;
  const sourceId = String(options.sourceId ?? "");
  const userId = String(options.userId ?? "");
  const owner = String(options.owner ?? "");
  const ttlSeconds = Number(options.ttlSeconds);
  const expectedProviderAccountAffinityHash = String(options.expectedProviderAccountAffinityHash ?? "");
  const expectedConfigRevision = revisionToken(options.expectedConfigRevision);
  const expectedConfigCiphertextHash = String(options.expectedConfigCiphertextHash ?? "");
  if (!db || typeof db.rpc !== "function" || !UUID_PATTERN.test(sourceId) ||
    !UUID_PATTERN.test(userId) || !owner || owner.length > 160 ||
    !Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 120 ||
    !SHA256_PATTERN.test(expectedProviderAccountAffinityHash) || !expectedConfigRevision ||
    !SHA256_PATTERN.test(expectedConfigCiphertextHash)) {
    throw new ProviderDirectFallbackLeaseError("invalid_context");
  }

  const lease = await claimSourceDirectFallbackLease(db, {
    sourceId,
    userId,
    owner,
    ttlSeconds,
    expectedProviderAccountAffinityHash,
    expectedConfigRevision,
    expectedConfigCiphertextHash,
  });

  let value;
  let operationFailed = false;
  let operationError = null;
  let releaseError = null;
  try {
    try {
      value = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
  } finally {
    try {
      await releaseSourceDirectFallbackLease(db, sourceId, userId, lease.leaseToken);
    } catch (error) {
      releaseError = error;
    }
  }

  // Preserve the provider verdict when both the operation and cleanup fail.
  // The unreleased lease remains fail-closed until its short TTL expires.
  if (operationFailed) {
    if (releaseError instanceof ProviderDirectFallbackLeaseError) {
      console.warn("[provider-direct-fallback] lease release failed after provider error", releaseError.reason);
    }
    throw operationError;
  }
  if (releaseError !== null) throw releaseError;
  return value;
}

async function claimSourceDirectFallbackLease(db, input) {
  let response;
  try {
    response = await db.rpc(PROVIDER_DIRECT_FALLBACK_CLAIM_RPC, {
      p_source_id: input.sourceId,
      p_user_id: input.userId,
      p_owner: input.owner,
      p_ttl_seconds: input.ttlSeconds,
      p_expected_provider_account_affinity_hash: input.expectedProviderAccountAffinityHash,
      p_expected_config_revision: input.expectedConfigRevision,
      p_expected_config_ciphertext_hash: input.expectedConfigCiphertextHash,
    });
  } catch (_) {
    throw new ProviderDirectFallbackLeaseError("claim_failed");
  }
  if (response?.error) throw claimFailure(response.error);

  const data = Array.isArray(response?.data) ? response.data[0] : response?.data;
  if (!data || typeof data !== "object" || data.claimed !== true ||
    data.sourceId !== input.sourceId || data.userId !== input.userId ||
    data.leaseOwner !== input.owner || !UUID_PATTERN.test(String(data.leaseToken ?? "")) ||
    !validFutureTimestamp(data.leaseUntil)) {
    throw new ProviderDirectFallbackLeaseError("claim_invalid");
  }
  return { leaseToken: String(data.leaseToken), leaseUntil: String(data.leaseUntil) };
}

async function releaseSourceDirectFallbackLease(db, sourceId, userId, leaseToken) {
  let response;
  try {
    response = await db.rpc(PROVIDER_DIRECT_FALLBACK_RELEASE_RPC, {
      p_source_id: sourceId,
      p_user_id: userId,
      p_lease_token: leaseToken,
    });
  } catch (_) {
    throw new ProviderDirectFallbackLeaseError("release_failed");
  }
  if (response?.error || response?.data !== true) {
    throw new ProviderDirectFallbackLeaseError(response?.error ? "release_failed" : "release_rejected");
  }
}

function claimFailure(error) {
  const details = typeof error?.details === "string" ? error.details : "";
  const reason = /(?:^|;)reason=transition_active(?:;|$)/.test(details)
    ? "transition_active"
    : /(?:^|;)reason=lease_busy(?:;|$)/.test(details)
    ? "lease_busy"
    : "claim_failed";
  const retryAfter = /(?:^|;)retry_after_seconds=(\d{1,3})(?:;|$)/.exec(details)?.[1] ?? null;
  return new ProviderDirectFallbackLeaseError(reason, retryAfter);
}

function boundedRetryAfter(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(120, Math.ceil(parsed)));
}

function validFutureTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function revisionToken(value) {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, "");
  }
  return "";
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
