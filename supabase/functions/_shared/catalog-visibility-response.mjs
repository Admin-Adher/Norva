const bindings = new WeakMap();
const acknowledgedMutationEpochs = new WeakMap();
const latestBoundEpochsByUser = new Map();
const LATEST_BOUND_EPOCHS_MAX = 1_024;

export const CATALOG_VISIBILITY_EPOCH_HEADER = "X-Norva-Visibility-Epoch";
export const CATALOG_VISIBILITY_EPOCH_CHANGED = "CATALOG_VISIBILITY_EPOCH_CHANGED";
export const CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN =
  "CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN";
export const CATALOG_VISIBILITY_EPOCH_UNAVAILABLE = "CATALOG_VISIBILITY_EPOCH_UNAVAILABLE";

// Public error identifiers are a protocol allowlist, never a reflection of a
// provider, gateway, callback, or database supplied token.
const PUBLIC_EDGE_ERROR_CODES = new Set([
  "subscription_required",
  "profile_locked",
  "profile_unavailable",
  "ambiguous_title_identity",
  "rating_identity_invalid",
  "rating_request_invalid",
  "rating_service_unavailable",
  "rating_source_not_found",
  "rating_storage_unavailable",
  "title_identity_unavailable",
  "SOURCE_CATALOG_NOT_VISIBLE",
  "SOURCE_CONFIG_REVISION_CHANGED",
  "PLAYBACK_CREATION_MOVED",
  "PLAYBACK_COORDINATOR_UNAVAILABLE",
  "PLAYBACK_SUPERSEDED",
  "PROVIDER_ACCOUNT_BUSY",
  "PROVIDER_BUSY",
  "PROVIDER_CONNECT_TIMEOUT",
  "PROVIDER_CONNECTION_RESET",
  "PROVIDER_DNS_FAILURE",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_UNREACHABLE",
  "PROVIDER_PROBE_CIRCUIT_OPEN",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_RESPONSE_TIMEOUT",
  "PROVIDER_TLS_FAILURE",
  "MEDIA_GATEWAY_CANARY_ROUTE_UNAVAILABLE",
  "MEDIA_GATEWAY_STORED_ROUTE_UNAVAILABLE",
  "GATEWAY_SESSION_ID_MISSING",
  "AUDIO_INDEX_MAP_MISMATCH",
  "AUDIO_STREAM_MAP_MISMATCH",
  "LANGUAGE_VALIDATION_ACCESS_REVOKED",
  "LANGUAGE_VALIDATION_BACKGROUND_UNAVAILABLE",
  "LANGUAGE_VALIDATION_BODY_INVALID",
  "LANGUAGE_VALIDATION_CACHE_BUSY",
  "LANGUAGE_VALIDATION_CACHE_MISMATCH",
  "LANGUAGE_VALIDATION_CACHE_REQUIRED",
  "LANGUAGE_VALIDATION_CACHE_SEED_FAILED",
  "LANGUAGE_VALIDATION_CHECKPOINT_FAILED",
  "LANGUAGE_VALIDATION_CODEC_AUDIO_INVALID",
  "LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED",
  "LANGUAGE_VALIDATION_CURSOR_MISMATCH",
  "LANGUAGE_VALIDATION_DURATION_INVALID",
  "LANGUAGE_VALIDATION_DURATION_TOO_SHORT",
  "LANGUAGE_VALIDATION_FINALIZE_FAILED",
  "LANGUAGE_VALIDATION_FINALIZE_MISMATCH",
  "LANGUAGE_VALIDATION_IDENTITY_CHANGED",
  "LANGUAGE_VALIDATION_IDENTITY_REQUIRED",
  "LANGUAGE_VALIDATION_IN_PROGRESS",
  "LANGUAGE_VALIDATION_JOB_BUSY",
  "LANGUAGE_VALIDATION_JOB_INVALID",
  "LANGUAGE_VALIDATION_MOVIE_ONLY",
  "LANGUAGE_VALIDATION_PLAYBACK_ACTIVE",
  "LANGUAGE_VALIDATION_PROFILE_CHANGED",
  "LANGUAGE_VALIDATION_PROVIDER_INVALID",
  "LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR",
  "LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_FAILED",
  "LANGUAGE_VALIDATION_WINDOW_CLAIMS_INVALID",
  "LANGUAGE_VALIDATION_WINDOW_CURSOR_INVALID",
  "LANGUAGE_VALIDATION_WINDOW_RECEIPTS_INVALID",
  "LANGUAGE_VALIDATION_WINDOW_RESET_FAILED",
]);

/**
 * Bind an authenticated request to the account visibility generation observed
 * before any catalog-related work starts. Callers deliberately map failures to
 * their local HTTP error type so authentication/error handling stays uniform.
 */
export async function bindCatalogVisibilityEpoch(req, userId, db) {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) throw new Error("Catalog visibility user is missing");
  const epoch = await readCatalogVisibilityEpoch(db, normalizedUserId);
  bindings.set(req, { userId: normalizedUserId, boundEpoch: epoch });
  const previous = latestBoundEpochsByUser.get(normalizedUserId);
  if (!previous || BigInt(epoch) >= BigInt(previous)) {
    latestBoundEpochsByUser.delete(normalizedUserId);
    latestBoundEpochsByUser.set(normalizedUserId, epoch);
    if (latestBoundEpochsByUser.size > LATEST_BOUND_EPOCHS_MAX) {
      const oldest = latestBoundEpochsByUser.keys().next().value;
      if (oldest !== undefined) latestBoundEpochsByUser.delete(oldest);
    }
  }
  return epoch;
}

/**
 * Record the exact next epoch produced by one of the small, explicit set of
 * mutations whose own transaction intentionally changes catalog visibility.
 * Reading it here, then again in the finalizer, distinguishes that committed
 * single-step advance from a concurrent or later cutover. This function must
 * be called only after the mutation has returned successfully.
 */
export async function acknowledgeCatalogVisibilityEpochMutation(req, db) {
  const binding = bindings.get(req);
  if (!binding) throw new Error("Catalog visibility request is not bound");
  const epoch = await readCatalogVisibilityEpoch(db, binding.userId);
  // Source create/toggle/delete each commit exactly one synchronous epoch bump.
  // A larger jump proves another cutover raced the mutation before this read;
  // never bless that later generation as if it belonged to this request.
  if (BigInt(epoch) !== BigInt(binding.boundEpoch) + 1n) {
    acknowledgedMutationEpochs.delete(req);
    return null;
  }
  acknowledgedMutationEpochs.set(req, epoch);
  return epoch;
}

/**
 * Re-read immediately before an authenticated response leaves the function.
 * A read assembled across a cutover is discarded. A mutation assembled across
 * a cutover reports an ambiguous, non-retryable outcome so clients reconcile
 * state instead of executing it twice.
 */
export async function finalizeCatalogVisibilityResponse(
  req,
  response,
  db,
  { service = "edge", corsHeaders = () => ({}) } = {},
) {
  const binding = bindings.get(req);
  if (!binding) return response;
  // Sanitize/serialize any existing authenticated error before the epoch read,
  // so the database recheck remains the final asynchronous operation before
  // the externally returned response is constructed.
  const publicResponse = await sanitizeAuthenticatedErrorResponse(response);

  let currentEpoch;
  try {
    currentEpoch = await readCatalogVisibilityEpoch(db, binding.userId);
  } catch (_) {
    console.warn(`[${service}] final catalog visibility epoch unavailable`);
    return catalogVisibilityErrorResponse(req, corsHeaders, 503, {
      error: "Catalog visibility is temporarily unavailable",
      details: {
        code: CATALOG_VISIBILITY_EPOCH_UNAVAILABLE,
      },
    }, null, true);
  }

  if (currentEpoch !== binding.boundEpoch) {
    const acknowledgedEpoch = acknowledgedMutationEpochs.get(req);
    if (acknowledgedEpoch === currentEpoch) {
      return responseWithVisibilityEpoch(publicResponse, currentEpoch);
    }

    const readRequest = req.method === "GET" || req.method === "HEAD";
    return catalogVisibilityErrorResponse(req, corsHeaders, 409, {
      error: readRequest
        ? "Catalog visibility changed while the response was being prepared"
        : "Mutation outcome must be reconciled before another attempt",
      details: {
        code: readRequest
          ? CATALOG_VISIBILITY_EPOCH_CHANGED
          : CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN,
      },
    }, currentEpoch, readRequest);
  }

  return responseWithVisibilityEpoch(publicResponse, currentEpoch);
}

export function catalogVisibilityEpochHeaders(req) {
  const epoch = acknowledgedMutationEpochs.get(req) ?? bindings.get(req)?.boundEpoch;
  return epoch ? { [CATALOG_VISIBILITY_EPOCH_HEADER]: epoch } : {};
}

// Internal cache keys must be scoped to the same visibility generation as the
// request. A cache populated before a cutover is otherwise stale even when the
// request's start/end epoch checks both observe the new generation.
export function boundCatalogVisibilityEpoch(req) {
  return bindings.get(req)?.boundEpoch ?? null;
}

// Deep catalog builders do not all carry the Request object. They may use the
// latest epoch observed by authentication for that account as a cache scope.
// Epochs are monotone per user; an older concurrent request can never move this
// value backwards, and its final response is still rejected by the end guard.
export function latestBoundCatalogVisibilityEpoch(userId) {
  return latestBoundEpochsByUser.get(String(userId ?? "").trim()) ?? null;
}

/** Build a bounded public envelope before a handler catch creates a Response. */
export function publicEdgeErrorPayload(
  error,
  status,
  { unavailableMessage = "Service temporarily unavailable" } = {},
) {
  const rawDetails = error && typeof error === "object" && error.details &&
      typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : {};
  const details = {};
  const code = publicErrorCode(rawDetails.code);
  const correlationId = stableToken(rawDetails.correlationId ?? rawDetails.correlation_id, 128);
  if (code) details.code = code;
  if (correlationId) details.correlationId = correlationId;

  const clientMessage = error instanceof Error
    ? error.message.trim().replace(/[\r\n\t]+/g, " ").slice(0, 240)
    : "";
  return {
    error: status >= 500 ? unavailableMessage : (clientMessage || "Request failed"),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

/** Keep server logs useful without copying provider, gateway, or DB payloads. */
export function publicEdgeErrorLog(error, status, payload) {
  const details = payload && typeof payload === "object" && payload.details &&
      typeof payload.details === "object" && !Array.isArray(payload.details)
    ? payload.details
    : {};
  return {
    status,
    name: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
    ...(publicErrorCode(details.code) ? { code: details.code } : {}),
    ...(stableToken(details.correlationId, 128) ? { correlationId: details.correlationId } : {}),
  };
}

async function readCatalogVisibilityEpoch(db, userId) {
  const { data, error } = await db.rpc("norva_user_catalog_visibility_epoch", {
    p_user_id: userId,
  });
  if (error) throw new Error(String(error.message ?? "Catalog visibility epoch lookup failed"));

  // The migration creates a row on the first lifecycle write. Before then, the
  // database function returns generation 1 as the immutable empty baseline.
  const epoch = String(data ?? 1).trim();
  if (!/^[1-9]\d*$/.test(epoch)) throw new Error("Invalid catalog visibility epoch");
  return epoch;
}

function responseWithVisibilityEpoch(response, epoch) {
  const headers = new Headers(response.headers);
  headers.set(CATALOG_VISIBILITY_EPOCH_HEADER, epoch);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sanitizeAuthenticatedErrorResponse(response) {
  if (response.status < 400) return response;

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  const raw = await response.clone().json().catch(() => null);
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawDetails = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details
    : {};
  const details = {};
  const code = publicErrorCode(rawDetails.code ?? record.code);
  const correlationId = stableToken(
    rawDetails.correlationId ?? rawDetails.correlation_id ?? record.correlationId ?? record.correlation_id,
    128,
  );
  if (code) details.code = code;
  if (correlationId) details.correlationId = correlationId;

  const clientMessage = typeof record.error === "string"
    ? record.error.trim().replace(/[\r\n\t]+/g, " ").slice(0, 240)
    : "";
  const payload = {
    error: response.status >= 500 ? "Service temporarily unavailable" : (clientMessage || "Request failed"),
    ...(Object.keys(details).length ? { details } : {}),
  };
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stableToken(value, maxLength) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(token)) return null;
  return token;
}

function publicErrorCode(value) {
  const code = stableToken(value, 64);
  return code && PUBLIC_EDGE_ERROR_CODES.has(code) ? code : null;
}

function catalogVisibilityErrorResponse(
  req,
  corsHeaders,
  status,
  payload,
  epoch = null,
  retryable = false,
) {
  const headers = new Headers(corsHeaders(req));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (epoch) headers.set(CATALOG_VISIBILITY_EPOCH_HEADER, epoch);
  else headers.delete(CATALOG_VISIBILITY_EPOCH_HEADER);
  if (retryable) headers.set("Retry-After", "0");
  return new Response(JSON.stringify(payload), { status, headers });
}
