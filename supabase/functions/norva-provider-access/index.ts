import { createClient } from "npm:@supabase/supabase-js@2";
import {
  compareProviderCatalogIdentity,
  PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION,
  PROVIDER_CATALOG_IDENTITY_DECISIONS,
} from "../_shared/provider-catalog-identity.mjs";
import { stageXtreamCredentialCatalogGeneration } from "../_shared/xtream-sync.ts";
import {
  extractProviderAccessState,
  PROVIDER_ACCESS_DETECTION_VERSION,
} from "../_shared/provider-access-state.mjs";

// Provider Access v1 is intentionally a service-mediated API.  Browser/user
// requests are authenticated with a Supabase user JWT, while the durable job
// worker additionally requires a dedicated fixed token.  No route accepts a
// device token and no provider response is ever copied into an HTTP response.

const API_VERSION = "provider-access.norva/v1";
const CONTRACT_HEADER = "Norva-Contract-Version";
const FEATURE_FLAG = "provider_credential_transition_v1_enabled";
const REPLACEMENT_FEATURE_FLAG = "provider_replacement_v1_enabled";
const ACCESS_FEATURE_FLAG = "provider_access_v1_enabled";
const ACCESS_DETECTION_FEATURE_FLAG = "provider_access_auto_detection_v1_enabled";
const FUNCTION_NAME = "norva-provider-access";
const MAX_JSON_BYTES = 32_768;
const MAX_GATEWAY_ACCOUNT_BYTES = 256 * 1024;
const MAX_GATEWAY_PAGE_BYTES = 5 * 1024 * 1024;
// One claim per invocation prevents later jobs from sitting behind a slow
// gateway request until their lease is already stale.
const WORKER_MAX_CLAIMS = 1;
const WORKER_LEASE_SECONDS = 300;
const WORKER_PROTOCOL = "credential-transition-worker-v2-title-cleanup";
const GATEWAY_REQUEST_TIMEOUT_MS = 120_000;
const WORKER_MIN_START_LEASE_MS = GATEWAY_REQUEST_TIMEOUT_MS + 30_000;
const GATEWAY_ACTIONS = Object.freeze([
  "account_info",
  "get_live_categories",
  "get_vod_categories",
  "get_series_categories",
  "get_live_streams",
  "get_vod_streams",
  "get_series",
]);
const GATEWAY_PAGE_ACTIONS = Object.freeze(GATEWAY_ACTIONS.filter((action) => action !== "account_info"));
const GATEWAY_SAFE_ERROR_CODES = Object.freeze(new Set([
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_BUSY",
  "PROVIDER_MULTI_IP",
  "PROVIDER_RATE_LIMIT",
  "PROXY_AUTH_FAILED",
  "PROVIDER_CONNECT_TIMEOUT",
  "PROVIDER_CONNECTION_RESET",
  "PROVIDER_DNS_FAILURE",
  "PROVIDER_NETWORK_UNREACHABLE",
  "PROVIDER_TLS_FAILURE",
  "PROVIDER_RESPONSE_TIMEOUT",
  "PROVIDER_FETCH_FAILED",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "account_busy",
  "background_busy",
  "viewer_preempted",
  "catalog_spool_build_failed",
  "catalog_cursor_stale",
  "invalid_catalog_params",
  "invalid_egress_target",
]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{8,200}$/;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const ENV_GATEWAY_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "");
const ENV_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
const WORKER_TOKEN = Deno.env.get("NORVA_PROVIDER_ACCESS_WORKER_TOKEN") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const encoder = new TextEncoder();
let runtimeConfigCache = null;

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: [400, "The request is invalid.", false],
  CONTRACT_VERSION_UNSUPPORTED: [400, "This contract version is not supported.", false],
  AUTHENTICATION_REQUIRED: [401, "Authentication is required.", false],
  SOURCE_NOT_FOUND: [404, "The source was not found.", false],
  TRANSITION_NOT_FOUND: [404, "The credential candidate was not found.", false],
  REPLACEMENT_NOT_FOUND: [404, "The catalog replacement was not found.", false],
  SOURCE_REVISION_MISMATCH: [409, "The source changed. Refresh and try again.", false],
  ACCESS_REVISION_MISMATCH: [409, "Provider access changed. Refresh and try again.", false],
  TRANSITION_REVISION_MISMATCH: [409, "The candidate changed. Refresh and try again.", false],
  IDEMPOTENCY_KEY_REUSED: [409, "This idempotency key was already used.", false],
  TRANSITION_ALREADY_PENDING: [409, "Another provider transition is already pending.", false],
  INVALID_TRANSITION_STATE: [409, "This action is not available for the candidate.", false],
  DIFFERENT_CATALOG_REQUIRES_REPLACEMENT: [409, "This catalog requires a provider replacement.", false],
  CANDIDATE_CREDENTIALS_REJECTED: [422, "The provider rejected these credentials.", false],
  CATALOG_COMPARISON_INSUFFICIENT: [422, "The catalogs could not be compared safely.", false],
  PRECONDITION_REQUIRED: [428, "A required request precondition is missing.", false],
  FEATURE_DISABLED: [503, "This provider workflow is not available.", false],
  PROVIDER_CHECK_TEMPORARY_FAILURE: [503, "The provider check is temporarily unavailable.", true],
  INVARIANT_VIOLATION: [500, "The operation could not be completed safely.", false],
});

class ContractError extends Error {
  constructor(code, overrides = {}) {
    const definition = ERROR_DEFINITIONS[code] ?? ERROR_DEFINITIONS.INVARIANT_VIOLATION;
    super(definition[1]);
    this.name = "ContractError";
    this.code = code in ERROR_DEFINITIONS ? code : "INVARIANT_VIOLATION";
    this.status = overrides.status ?? definition[0];
    this.retryable = overrides.retryable ?? definition[2];
  }
}

class WorkerFault extends Error {
  constructor(queueCode, retryable, publicCode = "PROVIDER_CHECK_TEMPORARY_FAILURE") {
    super(publicCode);
    this.name = "WorkerFault";
    this.queueCode = queueCode;
    this.retryable = retryable;
    this.publicCode = publicCode;
  }
}

Deno.serve(async (req) => {
  const requestId = requestIdentifier(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) throw new ContractError("INVARIANT_VIOLATION");
    return await routeRequest(req, requestId);
  } catch (error) {
    const safe = normalizePublicError(error);
    console.error("[norva-provider-access] request_failed", {
      requestId,
      code: safe.code,
      status: safe.status,
    });
    return errorResponse(req, requestId, safe);
  }
});

async function routeRequest(req, requestId) {
  const segments = routeSegments(new URL(req.url).pathname);
  if (req.method === "POST" && segments.join("/") === "internal/worker/drain") {
    return handleWorkerDrain(req, requestId);
  }
  if (req.method === "POST" && segments.join("/") === "internal/access-check/drain") {
    return handleProviderAccessCheckDrain(req, requestId);
  }

  const match = matchProviderRoute(segments);
  if (!match) throw new ContractError("INVALID_REQUEST", { status: 404 });

  if (match.resource === "access") {
    await requireAccessFeatureFlag();
    if (req.method !== "GET") requireContractVersion(req);
  } else if (req.method === "POST") {
    // The flag is deliberately read before authentication and every other
    // business precondition. A missing/unreadable row is OFF.
    if (match.resource === "replacement") await requireReplacementFeatureFlag();
    else await requireCredentialFeatureFlag();
    requireContractVersion(req);
  }

  const user = await requireUserJwt(req);
  const source = match.resource === "replacement" && match.kind !== "collection"
    ? await requireOwnedReplacementSource(match.sourceId, user.id)
    : await requireOwnedSource(match.sourceId, user.id);

  if (match.resource === "access") {
    if (req.method === "GET" && match.kind === "access") {
      return getProviderAccess(req, requestId, user, source);
    }
    if (req.method === "POST" && match.kind === "access-cycles") {
      return createProviderAccessCycle(req, requestId, user, source);
    }
    if (req.method === "PATCH" && match.kind === "access-cycle") {
      return updateProviderAccessCycle(req, requestId, user, source, match.cycleId);
    }
    if (req.method === "DELETE" && match.kind === "access-cycle") {
      return endProviderAccessCycle(req, requestId, user, source, match.cycleId);
    }
    throw new ContractError("INVALID_REQUEST", { status: 404 });
  }

  if (match.resource === "replacement") {
    if (req.method === "POST" && match.kind === "collection") {
      return createSourceReplacement(req, requestId, user, source);
    }
    if (req.method === "GET" && match.kind === "replacement") {
      return getSourceReplacement(req, requestId, user, source, match.replacementId);
    }
    if (req.method === "POST" && match.kind === "action") {
      if (match.action === "promote") {
        return promoteSourceReplacement(req, requestId, user, source, match.replacementId);
      }
      if (match.action === "cancel") {
        return cancelSourceReplacement(req, requestId, user, source, match.replacementId);
      }
      if (match.action === "rollback") {
        return rollbackSourceReplacement(req, requestId, user, source, match.replacementId);
      }
    }
    throw new ContractError("INVALID_REQUEST", { status: 404 });
  }
  if (req.method === "POST" && match.kind === "collection") {
    return createCredentialCandidate(req, requestId, user, source);
  }
  if (req.method === "GET" && match.kind === "candidate") {
    return getCredentialCandidate(req, requestId, user, source, match.candidateId);
  }
  if (req.method === "POST" && match.kind === "action") {
    if (match.action === "decision") {
      return decideCredentialCandidate(req, requestId, user, source, match.candidateId);
    }
    if (match.action === "apply") {
      return applyCredentialCandidate(req, requestId, user, source, match.candidateId);
    }
    if (match.action === "cancel") {
      return cancelCredentialCandidate(req, requestId, user, source, match.candidateId);
    }
  }
  throw new ContractError("INVALID_REQUEST", { status: 404 });
}

function routeSegments(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf(FUNCTION_NAME);
  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : parts;
}

function matchProviderRoute(parts) {
  if (parts.length < 4 || parts[0] !== "v1" || parts[1] !== "sources") return null;
  if (!UUID_RE.test(parts[2])) return null;
  if (parts[3] === "access") {
    if (parts.length === 4) return { resource: "access", kind: "access", sourceId: parts[2] };
    if (parts.length === 5 && parts[4] === "cycles") {
      return { resource: "access", kind: "access-cycles", sourceId: parts[2] };
    }
    if (parts.length === 6 && parts[4] === "cycles" && UUID_RE.test(parts[5])) {
      return { resource: "access", kind: "access-cycle", sourceId: parts[2], cycleId: parts[5] };
    }
    return null;
  }
  if (parts[3] === "replacements") {
    if (parts.length === 4) return { resource: "replacement", kind: "collection", sourceId: parts[2] };
    if (!UUID_RE.test(parts[4])) return null;
    if (parts.length === 5) {
      return { resource: "replacement", kind: "replacement", sourceId: parts[2], replacementId: parts[4] };
    }
    if (parts.length === 6 && ["promote", "cancel", "rollback"].includes(parts[5])) {
      return {
        resource: "replacement",
        kind: "action",
        sourceId: parts[2],
        replacementId: parts[4],
        action: parts[5],
      };
    }
    return null;
  }
  if (parts[3] !== "credential-candidates") return null;
  if (parts.length === 4) return { resource: "credential", kind: "collection", sourceId: parts[2] };
  if (!UUID_RE.test(parts[4])) return null;
  if (parts.length === 5) return { resource: "credential", kind: "candidate", sourceId: parts[2], candidateId: parts[4] };
  if (parts.length === 6 && ["decision", "apply", "cancel"].includes(parts[5])) {
    return { resource: "credential", kind: "action", sourceId: parts[2], candidateId: parts[4], action: parts[5] };
  }
  return null;
}

async function requireCredentialFeatureFlag() {
  if (!await credentialFeatureFlagEnabled()) throw new ContractError("FEATURE_DISABLED");
}

async function credentialFeatureFlagEnabled() {
  const { data, error } = await admin.rpc("feature_flag", { p_key: FEATURE_FLAG });
  return !error && data === true;
}

async function requireReplacementFeatureFlag() {
  if (!await replacementFeatureFlagEnabled()) throw new ContractError("FEATURE_DISABLED");
}

async function requireAccessFeatureFlag() {
  if (!await accessFeatureFlagEnabled()) throw new ContractError("FEATURE_DISABLED");
}

async function accessFeatureFlagEnabled() {
  const { data, error } = await admin.rpc("feature_flag", { p_key: ACCESS_FEATURE_FLAG });
  return !error && data === true;
}

async function accessDetectionFeatureFlagEnabled() {
  const { data, error } = await admin.rpc("feature_flag", { p_key: ACCESS_DETECTION_FEATURE_FLAG });
  return !error && data === true;
}

async function replacementFeatureFlagEnabled() {
  const { data, error } = await admin.rpc("feature_flag", { p_key: REPLACEMENT_FEATURE_FLAG });
  return !error && data === true;
}

function requireContractVersion(req) {
  if (req.headers.get(CONTRACT_HEADER) !== API_VERSION) {
    throw new ContractError("CONTRACT_VERSION_UNSUPPORTED");
  }
}

async function requireUserJwt(req) {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? "";
  if (!token) throw new ContractError("AUTHENTICATION_REQUIRED");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.id) throw new ContractError("AUTHENTICATION_REQUIRED");
  return { id: data.user.id, actor: `user:${data.user.id}` };
}

async function requireOwnedSource(sourceId, userId) {
  const { data, error } = await admin
    .from("cloud_sources")
    .select("id,user_id,source_type,config_ciphertext,deleted_at,enabled")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ContractError("INVARIANT_VIOLATION");
  if (!data || data.deleted_at) throw new ContractError("SOURCE_NOT_FOUND");
  const { data: lifecycle, error: lifecycleError } = await admin
    .from("cloud_source_lifecycle")
    .select("config_revision,lifecycle_state,catalog_visibility")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (lifecycleError) throw new ContractError("INVARIANT_VIOLATION");
  // Restore access remains available when access policy has hidden a manually
  // disabled/expired source. Only lifecycle-incompatible staging/replaced/
  // purge states are rejected; visibility is not an ownership precondition.
  if (!lifecycle || lifecycle.lifecycle_state !== "active") {
    throw new ContractError("SOURCE_NOT_FOUND");
  }
  if (String(data.source_type ?? "").toLowerCase() !== "xtream") {
    throw new ContractError("INVALID_REQUEST");
  }
  return {
    id: data.id,
    userId: data.user_id,
    sourceType: String(data.source_type ?? ""),
    configCiphertext: data.config_ciphertext,
    revision: nonNegativeInteger(lifecycle.config_revision, "SOURCE_REVISION_MISMATCH"),
  };
}

async function createCredentialCandidate(req, requestId, user, source) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedSourceRevision = parseEntityTag(req, "source");
  const body = await readJsonObject(req);
  const config = normalizeCandidateConfig(body);
  const candidateHint = candidateConfigHint(config);
  const candidateAccountAffinityHash = await credentialAccountAffinityHash(config);
  const runtime = await getRuntimeConfig();
  const ciphertext = await encryptSourceConfig(config, runtime.sourceConfigKey);
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "create_credential_candidate",
    sourceId: source.id,
    expectedSourceRevision,
    config,
    candidateHint,
  });
  const result = await rpc("norva_create_credential_transition", {
    p_user_id: user.id,
    p_source_id: source.id,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
    p_if_match_revision: expectedSourceRevision,
    p_candidate_config_ciphertext: ciphertext,
    p_candidate_config_hint: candidateHint,
    p_actor: user.actor,
    p_candidate_account_affinity_hash: candidateAccountAffinityHash,
  }, { cas: "source", atomicCreate: true });
  // The 9-argument overload creates the transition, binds candidate affinity,
  // and makes its job claimable in one SQL transaction. Missing overloads fail
  // closed: never fall back to the legacy create-then-bind crash gap.
  const candidate = sanitizeCredentialCandidate(result, source.id);
  return successResponse(req, requestId, "CredentialCandidate", candidate, 202, {
    ETag: transitionTag(candidate.revision),
    Location: candidateLocation(source.id, candidate.candidateId),
  });
}

async function getCredentialCandidate(req, requestId, user, source, candidateId) {
  const result = await rpc("norva_get_credential_transition", {
    p_transition_id: candidateId,
    p_user_id: user.id,
  });
  const candidate = sanitizeCredentialCandidate(result, source.id);
  return successResponse(req, requestId, "CredentialCandidate", candidate, 200, {
    ETag: transitionTag(candidate.revision),
  });
}

async function decideCredentialCandidate(req, requestId, user, source, candidateId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedTransitionRevision = parseEntityTag(req, "transition");
  const body = await readJsonObject(req);
  const decision = String(body.decision ?? "").trim().toUpperCase();
  if (decision === "CANCEL") {
    return cancelCredentialCandidateWith(req, requestId, user, source, candidateId, {
      idempotencyKey,
      expectedTransitionRevision,
      body: { decision: "CANCEL" },
    });
  }
  if (!['KEEP_AS_SAME_CATALOG', 'REPLACE_WITH_NEW_CATALOG'].includes(decision)) {
    throw new ContractError("INVALID_REQUEST");
  }
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "decide_credential_candidate",
    sourceId: source.id,
    candidateId,
    expectedTransitionRevision,
    decision,
  });
  let result = await rpc("norva_decide_ambiguous_credential_transition", {
    p_transition_id: candidateId,
    p_user_id: user.id,
    p_decision: decision,
    p_actor: user.actor,
    p_expected_transition_revision: expectedTransitionRevision,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
  }, { cas: "transition" });

  // Manual KEEP never bypasses the import. Identity can only be AMBIGUOUS after
  // the candidate generation was completely built and sealed; the SQL RPC
  // below independently rechecks that readiness proof before changing state.
  if (decision === "KEEP_AS_SAME_CATALOG" && String(result?.state ?? "").toUpperCase() === "IMPORTING") {
    result = await rpc("norva_mark_credential_transition_ready", {
      p_transition_id: candidateId,
      p_user_id: user.id,
      p_readiness_check_id: crypto.randomUUID(),
      p_expected_transition_revision: nonNegativeInteger(result.revision, "TRANSITION_REVISION_MISMATCH"),
    }, { cas: "transition" });
  }
  const candidate = sanitizeCredentialCandidate(result, source.id);
  return successResponse(req, requestId, "CredentialCandidate", candidate, 200, {
    ETag: transitionTag(candidate.revision),
  });
}

async function applyCredentialCandidate(req, requestId, user, source, candidateId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedSourceRevision = parseEntityTag(req, "source");
  const body = await readJsonObject(req);
  const expectedTransitionRevision = nonNegativeInteger(body.transitionRevision, "PRECONDITION_REQUIRED");
  const snapshot = sanitizeCredentialCandidate(await rpc("norva_get_credential_transition", {
    p_transition_id: candidateId,
    p_user_id: user.id,
  }), source.id);
  if (snapshot.comparison === "DIFFERENT_CATALOG") {
    throw new ContractError("DIFFERENT_CATALOG_REQUIRES_REPLACEMENT");
  }
  if (snapshot.comparison !== "SAME_CATALOG") throw new ContractError("INVALID_TRANSITION_STATE");
  const generation = normalizeCredentialGeneration(await rpc("norva_get_credential_catalog_generation", {
    p_transition_id: candidateId,
    p_user_id: user.id,
  }));
  if (generation.state !== "READY" || generation.isActiveHead) {
    throw new ContractError("INVALID_TRANSITION_STATE");
  }
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "apply_credential_candidate",
    sourceId: source.id,
    candidateId,
    expectedSourceRevision,
    expectedTransitionRevision,
    generationId: generation.generationId,
    generationRevision: generation.generationRevision,
    headRevision: generation.headRevision,
  });
  const result = await rpc("norva_begin_credential_swap", {
    p_transition_id: candidateId,
    p_user_id: user.id,
    p_generation_id: generation.generationId,
    p_expected_generation_revision: generation.generationRevision,
    p_expected_transition_revision: expectedTransitionRevision,
    p_expected_source_revision: expectedSourceRevision,
    p_expected_head_revision: generation.headRevision,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
  }, { cas: "source" });
  const candidate = sanitizeCredentialCandidate(result, source.id);
  scheduleWorkerAcceleration();
  return successResponse(req, requestId, "CredentialCandidate", candidate, 202, {
    ETag: transitionTag(candidate.revision),
    Location: candidateLocation(source.id, candidate.candidateId),
  });
}

async function cancelCredentialCandidate(req, requestId, user, source, candidateId) {
  const options = {
    idempotencyKey: requireIdempotencyKey(req),
    expectedTransitionRevision: parseEntityTag(req, "transition"),
    body: await readJsonObject(req),
  };
  return cancelCredentialCandidateWith(req, requestId, user, source, candidateId, options);
}

async function cancelCredentialCandidateWith(req, requestId, user, source, candidateId, options) {
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "cancel_credential_candidate",
    sourceId: source.id,
    candidateId,
    expectedTransitionRevision: options.expectedTransitionRevision,
  });
  const result = await rpc("norva_cancel_credential_transition", {
    p_transition_id: candidateId,
    p_user_id: user.id,
    p_actor: user.actor,
    p_expected_transition_revision: options.expectedTransitionRevision,
    p_idempotency_key: options.idempotencyKey,
    p_request_fingerprint: fingerprint,
  }, { cas: "transition" });
  const candidate = sanitizeCredentialCandidate(result, source.id);
  return successResponse(req, requestId, "CredentialCandidate", candidate, 200, {
    ETag: transitionTag(candidate.revision),
  });
}

async function requireOwnedReplacementSource(sourceId, userId) {
  const { data, error } = await admin
    .from("cloud_sources")
    .select("id,user_id,source_type,config_ciphertext,deleted_at,enabled")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ContractError("INVARIANT_VIOLATION");
  if (!data || data.deleted_at) throw new ContractError("SOURCE_NOT_FOUND");
  const { data: lifecycle, error: lifecycleError } = await admin
    .from("cloud_source_lifecycle")
    .select("config_revision,lifecycle_state,catalog_visibility")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (lifecycleError) throw new ContractError("INVARIANT_VIOLATION");
  if (!lifecycle || !["active", "replaced"].includes(String(lifecycle.lifecycle_state))) {
    throw new ContractError("SOURCE_NOT_FOUND");
  }
  if (String(data.source_type ?? "").toLowerCase() !== "xtream") {
    throw new ContractError("INVALID_REQUEST");
  }
  return {
    id: data.id,
    userId: data.user_id,
    sourceType: String(data.source_type ?? ""),
    configCiphertext: data.config_ciphertext,
    revision: nonNegativeInteger(lifecycle.config_revision, "SOURCE_REVISION_MISMATCH"),
  };
}

async function getProviderAccess(req, requestId, user, source) {
  const value = await rpc("norva_get_provider_access", {
    p_user_id: user.id,
    p_source_id: source.id,
  }, { resource: "source" });
  const access = sanitizeProviderAccess(value, source.id);
  return successResponse(req, requestId, "ProviderAccess", access, 200, {
    ETag: providerAccessTag(access.revision),
  });
}

async function createProviderAccessCycle(req, requestId, user, source) {
  const idempotencyKey = requireIdempotencyKey(req);
  const body = normalizeAccessCycleBody(await readJsonObject(req), false);
  const runtime = await getRuntimeConfig();
  const requestFingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "create_provider_access_cycle",
    sourceId: source.id,
    ...body,
  });
  const value = await rpc("norva_create_provider_access_cycle", {
    p_user_id: user.id,
    p_source_id: source.id,
    p_started_on: body.startedOn,
    p_expires_on: body.expiresOn,
    p_term_value: body.termValue,
    p_term_unit: body.termUnit,
    p_reminders_enabled: body.remindersEnabled,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: requestFingerprint,
    p_actor: user.actor,
  }, { resource: "source", cas: "access" });
  const access = sanitizeProviderAccess(value, source.id);
  const cycleId = access.activeCycle?.cycleId;
  if (!cycleId) throw new ContractError("INVARIANT_VIOLATION");
  return successResponse(req, requestId, "ProviderAccess", access, value?.replayed === true ? 200 : 201, {
    ETag: providerAccessTag(access.revision),
    Location: `/v1/sources/${source.id}/access/cycles/${cycleId}`,
  });
}

async function updateProviderAccessCycle(req, requestId, user, source, cycleId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedRevision = parseEntityTag(req, "provider-access");
  const body = normalizeAccessCycleBody(await readJsonObject(req), true);
  const runtime = await getRuntimeConfig();
  const requestFingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "update_provider_access_cycle",
    sourceId: source.id,
    cycleId,
    expectedRevision,
    ...body,
  });
  const value = await rpc("norva_update_provider_access_cycle", {
    p_user_id: user.id,
    p_source_id: source.id,
    p_cycle_id: cycleId,
    p_expected_revision: expectedRevision,
    p_started_on: body.startedOn,
    p_expires_on: body.expiresOn,
    p_term_value: body.termValue,
    p_term_unit: body.termUnit,
    p_reminders_enabled: body.remindersEnabled,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: requestFingerprint,
    p_actor: user.actor,
  }, { resource: "source", cas: "access" });
  const access = sanitizeProviderAccess(value, source.id);
  return successResponse(req, requestId, "ProviderAccess", access, 200, {
    ETag: providerAccessTag(access.revision),
  });
}

async function endProviderAccessCycle(req, requestId, user, source, cycleId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedRevision = parseEntityTag(req, "provider-access");
  const runtime = await getRuntimeConfig();
  const requestFingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "end_provider_access_cycle",
    sourceId: source.id,
    cycleId,
    expectedRevision,
  });
  const value = await rpc("norva_end_provider_access_cycle", {
    p_user_id: user.id,
    p_source_id: source.id,
    p_cycle_id: cycleId,
    p_expected_revision: expectedRevision,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: requestFingerprint,
    p_actor: user.actor,
  }, { resource: "source", cas: "access" });
  const access = sanitizeProviderAccess(value, source.id);
  return successResponse(req, requestId, "ProviderAccess", access, 200, {
    ETag: providerAccessTag(access.revision),
  });
}

function normalizeAccessCycleBody(body, requireComplete) {
  const fields = ["startedOn", "expiresOn", "termValue", "termUnit", "remindersEnabled"];
  if (requireComplete && fields.some((field) => !Object.hasOwn(body, field))) {
    throw new ContractError("INVALID_REQUEST");
  }
  const startedOn = nullableDateKey(body.startedOn);
  const expiresOn = nullableDateKey(body.expiresOn);
  if (startedOn && expiresOn && expiresOn < startedOn) throw new ContractError("INVALID_REQUEST");
  const termValue = body.termValue === null || body.termValue === undefined
    ? null
    : positiveInteger(body.termValue, 10_000);
  const termUnit = body.termUnit === null || body.termUnit === undefined
    ? null
    : enumValue(String(body.termUnit), ["DAY", "WEEK", "MONTH", "YEAR"], "INVALID_REQUEST").toLowerCase();
  if ((termValue === null) !== (termUnit === null)) throw new ContractError("INVALID_REQUEST");
  const remindersEnabled = body.remindersEnabled === undefined ? false : body.remindersEnabled;
  if (typeof remindersEnabled !== "boolean") throw new ContractError("INVALID_REQUEST");
  return Object.freeze({ startedOn, expiresOn, termValue, termUnit, remindersEnabled });
}

function sanitizeProviderAccess(value, expectedSourceId) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  const sourceId = uuidValue(value.sourceId ?? value.source_id);
  if (sourceId !== expectedSourceId) throw new ContractError("SOURCE_NOT_FOUND");
  const cyclesRaw = Array.isArray(value.cycles) ? value.cycles : [];
  if (cyclesRaw.length > 100) throw new ContractError("INVARIANT_VIOLATION");
  const cycles = cyclesRaw.map(sanitizeProviderAccessCycle);
  const activeCycle = value.activeCycle === null || value.active_cycle === null
    ? null
    : sanitizeProviderAccessCycle(value.activeCycle ?? value.active_cycle);
  if (activeCycle && !cycles.some((cycle) => cycle.cycleId === activeCycle.cycleId)) {
    throw new ContractError("INVARIANT_VIOLATION");
  }
  return Object.freeze({
    sourceId,
    revision: positiveInteger(value.revision, Number.MAX_SAFE_INTEGER, "INVARIANT_VIOLATION"),
    status: enumValue(String(value.status ?? "").toUpperCase(), [
      "UNKNOWN", "ACTIVE", "EXPIRING", "EXPECTED_EXPIRED", "EXPIRED_CONFIRMED",
      "ACCESS_UNAVAILABLE_CONFIRMED", "CHECK_FAILED_TEMPORARY", "RESTORING",
    ], "INVARIANT_VIOLATION"),
    startedOn: nullableDateKey(value.startedOn ?? value.started_on),
    expiresOn: nullableDateKey(value.expiresOn ?? value.expires_on),
    expirySource: nullableEnum(
      String(value.expirySource ?? value.expiry_source ?? "").toUpperCase() || null,
      ["USER_ENTERED", "PROVIDER_REPORTED", "INFERRED"],
    ),
    manualOverride: value.manualOverride === true || value.manual_override === true,
    remindersEnabled: value.remindersEnabled === true || value.reminders_enabled === true,
    lastCheckedAt: isoOrNull(value.lastCheckedAt ?? value.last_checked_at),
    lastConfirmedActiveAt: isoOrNull(value.lastConfirmedActiveAt ?? value.last_confirmed_active_at),
    lastDetectedAt: isoOrNull(value.lastDetectedAt ?? value.last_detected_at),
    hiddenAt: isoOrNull(value.hiddenAt ?? value.hidden_at),
    restoredAt: isoOrNull(value.restoredAt ?? value.restored_at),
    detectionVersion: nullablePositiveInteger(value.detectionVersion ?? value.detection_version),
    lastDetectionCode: safeMachineCode(value.lastDetectionCode ?? value.last_detection_code),
    lastContradictionCount: nonNegativeInteger(
      value.lastContradictionCount ?? value.last_contradiction_count ?? 0,
      "INVARIANT_VIOLATION",
    ),
    activeCycle,
    cycles: Object.freeze(cycles),
  });
}

function sanitizeProviderAccessCycle(value) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  const termValue = nullablePositiveInteger(value.termValue ?? value.term_value);
  const termUnit = nullableEnum(
    String(value.termUnit ?? value.term_unit ?? "").toUpperCase() || null,
    ["DAY", "WEEK", "MONTH", "YEAR"],
  );
  if ((termValue === null) !== (termUnit === null)) throw new ContractError("INVARIANT_VIOLATION");
  return Object.freeze({
    cycleId: uuidValue(value.cycleId ?? value.cycle_id),
    revision: positiveInteger(value.revision, Number.MAX_SAFE_INTEGER, "INVARIANT_VIOLATION"),
    startedOn: nullableDateKey(value.startedOn ?? value.started_on),
    expiresOn: nullableDateKey(value.expiresOn ?? value.expires_on),
    termValue,
    termUnit,
    origin: enumValue(String(value.origin ?? "").toUpperCase(), ["USER_ENTERED", "PROVIDER_REPORTED"], "INVARIANT_VIOLATION"),
    status: enumValue(String(value.status ?? "").toUpperCase(), ["ACTIVE", "SUPERSEDED", "ENDED"], "INVARIANT_VIOLATION"),
    createdAt: isoOrNull(value.createdAt ?? value.created_at),
    updatedAt: isoOrNull(value.updatedAt ?? value.updated_at),
  });
}

function providerAccessTag(revision) {
  return `"provider-access-rev-${positiveInteger(revision, Number.MAX_SAFE_INTEGER)}"`;
}

function nullableDateKey(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ContractError("INVALID_REQUEST");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ContractError("INVALID_REQUEST");
  }
  return text;
}

function positiveInteger(value, maximum, code = "INVALID_REQUEST") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ContractError(code);
  }
  return parsed;
}

function nullablePositiveInteger(value) {
  return value === null || value === undefined || value === ""
    ? null
    : positiveInteger(value, Number.MAX_SAFE_INTEGER, "INVARIANT_VIOLATION");
}

async function createSourceReplacement(req, requestId, user, source) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedSourceRevision = parseEntityTag(req, "source");
  const body = await readJsonObject(req);
  const credentialCandidateId = requestUuid(body.credentialCandidateId);
  const displayName = boundedDisplayName(body.displayName);
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "create_source_replacement",
    sourceId: source.id,
    credentialCandidateId,
    expectedSourceRevision,
    displayName,
  });
  const result = await rpc("norva_create_source_replacement_from_candidate", {
    p_user_id: user.id,
    p_source_id: source.id,
    p_credential_transition_id: credentialCandidateId,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
    p_expected_source_revision: expectedSourceRevision,
    p_display_name: displayName,
    p_actor: user.actor,
  }, { cas: "source", atomicCreate: true });
  const replacement = sanitizeSourceReplacement(result, source.id);
  scheduleWorkerAcceleration();
  return successResponse(req, requestId, "SourceReplacement", replacement, 202, {
    ETag: transitionTag(replacement.revision),
    Location: replacementLocation(source.id, replacement.replacementId),
  });
}

async function getSourceReplacement(req, requestId, user, source, replacementId) {
  const result = await rpc("norva_get_source_replacement", {
    p_transition_id: replacementId,
    p_user_id: user.id,
  }, { resource: "replacement" });
  const replacement = sanitizeSourceReplacement(result, source.id);
  return successResponse(req, requestId, "SourceReplacement", replacement, 200, {
    ETag: transitionTag(replacement.revision),
  });
}

async function promoteSourceReplacement(req, requestId, user, source, replacementId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedSourceRevision = parseEntityTag(req, "source");
  const body = await readJsonObject(req);
  const expectedTransitionRevision = nonNegativeInteger(body.transitionRevision, "PRECONDITION_REQUIRED");
  const snapshot = sanitizeSourceReplacement(await rpc("norva_get_source_replacement", {
    p_transition_id: replacementId,
    p_user_id: user.id,
  }, { resource: "replacement" }), source.id);
  if (snapshot.state !== "READY_TO_SWITCH" || snapshot.comparison !== "DIFFERENT_CATALOG") {
    throw new ContractError("INVALID_TRANSITION_STATE");
  }
  if (snapshot.revision !== expectedTransitionRevision) {
    throw new ContractError("TRANSITION_REVISION_MISMATCH");
  }
  const generation = normalizeCredentialGeneration(await rpc("norva_get_replacement_catalog_generation", {
    p_transition_id: replacementId,
    p_user_id: user.id,
  }, { resource: "replacement" }));
  if (generation.state !== "READY" || generation.isActiveHead) {
    throw new ContractError("INVALID_TRANSITION_STATE");
  }
  const result = await rpc("norva_promote_source_replacement_v3", {
    p_transition_id: replacementId,
    p_user_id: user.id,
    p_idempotency_key: idempotencyKey,
    p_expected_source_revision: expectedSourceRevision,
    p_expected_transition_revision: expectedTransitionRevision,
    p_expected_candidate_head_revision: generation.headRevision,
  }, { cas: "source" });
  const replacement = sanitizeSourceReplacement(result, source.id);
  return successResponse(req, requestId, "SourceReplacement", replacement, 200, {
    ETag: transitionTag(replacement.revision),
    Location: replacementLocation(source.id, replacement.replacementId),
  });
}

async function cancelSourceReplacement(req, requestId, user, source, replacementId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedTransitionRevision = parseEntityTag(req, "transition");
  await readJsonObject(req);
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "cancel_source_replacement",
    sourceId: source.id,
    replacementId,
    expectedTransitionRevision,
  });
  const result = await rpc("norva_cancel_source_replacement", {
    p_transition_id: replacementId,
    p_user_id: user.id,
    p_actor: user.actor,
    p_expected_transition_revision: expectedTransitionRevision,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
  }, { cas: "transition" });
  const replacement = sanitizeSourceReplacement(result, source.id);
  return successResponse(req, requestId, "SourceReplacement", replacement, 200, {
    ETag: transitionTag(replacement.revision),
  });
}

async function rollbackSourceReplacement(req, requestId, user, source, replacementId) {
  const idempotencyKey = requireIdempotencyKey(req);
  const expectedTransitionRevision = parseEntityTag(req, "transition");
  await readJsonObject(req);
  const snapshot = sanitizeSourceReplacement(await rpc("norva_get_source_replacement", {
    p_transition_id: replacementId,
    p_user_id: user.id,
  }, { resource: "replacement" }), source.id);
  if (snapshot.revision !== expectedTransitionRevision) {
    throw new ContractError("TRANSITION_REVISION_MISMATCH");
  }
  if (snapshot.state !== "COMPLETED" || !snapshot.rollbackUntil
      || Date.parse(snapshot.rollbackUntil) <= Date.now()) {
    throw new ContractError("INVALID_TRANSITION_STATE");
  }
  const { data: activeLifecycle, error: lifecycleError } = await admin
    .from("cloud_source_lifecycle")
    .select("config_revision,lifecycle_state,catalog_visibility")
    .eq("source_id", snapshot.candidateSourceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (lifecycleError) throw new ContractError("INVARIANT_VIOLATION");
  if (!activeLifecycle || activeLifecycle.lifecycle_state !== "active"
      || activeLifecycle.catalog_visibility !== "visible") {
    throw new ContractError("INVALID_TRANSITION_STATE");
  }
  const expectedActiveSourceRevision = nonNegativeInteger(
    activeLifecycle.config_revision,
    "SOURCE_REVISION_MISMATCH",
  );
  const runtime = await getRuntimeConfig();
  const fingerprint = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "rollback_source_replacement",
    sourceId: source.id,
    replacementId,
    expectedTransitionRevision,
    activeSourceId: snapshot.candidateSourceId,
    expectedActiveSourceRevision,
  });
  const result = await rpc("norva_rollback_source_replacement", {
    p_transition_id: replacementId,
    p_user_id: user.id,
    p_actor: user.actor,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: fingerprint,
    p_expected_transition_revision: expectedTransitionRevision,
    p_expected_active_source_revision: expectedActiveSourceRevision,
  }, { cas: "transition" });
  const rollback = sanitizeSourceReplacementRollback(result, replacementId, source.id);
  return successResponse(req, requestId, "SourceReplacementRollback", rollback, 200, {
    ETag: transitionTag(expectedTransitionRevision),
    Location: replacementLocation(source.id, replacementId),
  });
}

function boundedDisplayName(value) {
  const displayName = String(value ?? "").normalize("NFC").trim();
  if (!displayName || displayName.length > 160 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new ContractError("INVALID_REQUEST");
  }
  return displayName;
}

function requestUuid(value) {
  const id = String(value ?? "").toLowerCase();
  if (!UUID_RE.test(id)) throw new ContractError("INVALID_REQUEST");
  return id;
}

function normalizeCandidateConfig(body) {
  const credentials = isRecord(body.credentials) ? body.credentials : body;
  const serverUrl = normalizeServerUrl(credentials.serverUrl);
  const username = boundedSecret(credentials.username, "username");
  const password = boundedSecret(credentials.password, "password");
  return { serverUrl, username, password };
}

function candidateConfigHint(config) {
  const parsed = new URL(config.serverUrl);
  const hostname = parsed.hostname.toLowerCase();
  const serverHost = parsed.host.toLowerCase();
  const port = parsed.port;
  if (!hostname || hostname.length > 253
      || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname)
      || (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))
      || !serverHost || serverHost.length > 259 || /[\/@]/.test(serverHost)) {
    throw new ContractError("INVALID_REQUEST");
  }
  // This service-only hint intentionally replaces, rather than merges with,
  // A's status/cursor/signature fields at the CAS switch. It contains no URL,
  // username, password, token, account id, or provider response.
  return { sourceType: "xtream", serverHost, hasPassword: true };
}

function normalizeServerUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new ContractError("INVALID_REQUEST");
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error("invalid");
    }
    url.hash = "";
    url.search = "";
    return trimTrailingSlash(url.href);
  } catch (_) {
    throw new ContractError("INVALID_REQUEST");
  }
}

function boundedSecret(value, _field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
      || (_field === "username" && !value.trim())
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractError("INVALID_REQUEST");
  }
  return value;
}

function requireIdempotencyKey(req) {
  const value = req.headers.get("Idempotency-Key") ?? "";
  if (!value) throw new ContractError("PRECONDITION_REQUIRED");
  if (!IDEMPOTENCY_KEY_RE.test(value)) throw new ContractError("INVALID_REQUEST");
  return value;
}

function parseEntityTag(req, kind) {
  const raw = req.headers.get("If-Match") ?? "";
  if (!raw) throw new ContractError("PRECONDITION_REQUIRED");
  const match = raw.match(new RegExp(`^"${kind}-rev-(0|[1-9][0-9]*)"$`));
  if (!match) throw new ContractError("INVALID_REQUEST");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new ContractError("INVALID_REQUEST");
  return revision;
}

function transitionTag(revision) {
  return `"transition-rev-${nonNegativeInteger(revision, "INVARIANT_VIOLATION")}"`;
}

function candidateLocation(sourceId, candidateId) {
  return `/v1/sources/${sourceId}/credential-candidates/${candidateId}`;
}

function replacementLocation(sourceId, replacementId) {
  return `/v1/sources/${sourceId}/replacements/${replacementId}`;
}

function sanitizeSourceReplacement(value, expectedSourceId) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  const replacementId = uuidValue(value.replacementId ?? value.replacement_id);
  const oldSourceId = uuidValue(value.oldSourceId ?? value.old_source_id);
  const candidateSourceId = uuidValue(value.candidateSourceId ?? value.candidate_source_id);
  if (oldSourceId !== expectedSourceId || candidateSourceId === oldSourceId) {
    throw new ContractError("REPLACEMENT_NOT_FOUND");
  }
  const state = enumValue(value.state, [
    "VALIDATING", "STAGING", "IMPORTING", "READY_TO_SWITCH",
    "COMMITTING", "COMPLETED", "FAILED", "CANCELLED",
  ], "INVARIANT_VIOLATION");
  const comparison = nullableEnum(value.comparison ?? value.identityDecision ?? value.identity_decision, [
    "SAME_CATALOG", "DIFFERENT_CATALOG", "AMBIGUOUS",
  ]);
  const revision = nonNegativeInteger(value.revision, "INVARIANT_VIOLATION");
  const rollbackUntil = isoOrNull(value.rollbackUntil ?? value.rollback_until);
  const rollbackTransitionId = nullableApiUuid(
    value.rollbackTransitionId ?? value.rollback_transition_id,
  );
  const rolledBackAt = isoOrNull(value.rolledBackAt ?? value.rolled_back_at);
  return Object.freeze({
    replacementId,
    oldSourceId,
    candidateSourceId,
    state,
    comparison,
    decisionOrigin: nullableEnum(value.decisionOrigin ?? value.decision_origin, ["AUTOMATIC", "MANUAL"]),
    revision,
    sourceRevision: nonNegativeInteger(
      value.expectedSourceRevision ?? value.expected_source_revision,
      "INVARIANT_VIOLATION",
    ),
    candidateRevision: nonNegativeInteger(
      value.expectedCandidateRevision ?? value.expected_candidate_revision,
      "INVARIANT_VIOLATION",
    ),
    candidateGenerationId: nullableApiUuid(value.candidateGenerationId ?? value.candidate_generation_id),
    readinessCheckId: nullableApiUuid(value.readinessCheckId ?? value.readiness_check_id),
    startedAt: isoOrNull(value.startedAt ?? value.started_at),
    readyAt: isoOrNull(value.readyAt ?? value.ready_at),
    completedAt: isoOrNull(value.completedAt ?? value.completed_at),
    rollbackUntil,
    rollbackTransitionId,
    rolledBackAt,
    failureCode: safeMachineCode(value.failureCode ?? value.failure_code),
    actions: Object.freeze({
      canPromote: state === "READY_TO_SWITCH" && comparison === "DIFFERENT_CATALOG",
      canCancel: ["VALIDATING", "STAGING", "IMPORTING", "READY_TO_SWITCH"].includes(state),
      canRollback: state === "COMPLETED" && rollbackTransitionId === null
        && rollbackUntil !== null && Date.parse(rollbackUntil) > Date.now(),
    }),
  });
}

function sanitizeSourceReplacementRollback(value, expectedReplacementId, expectedActiveSourceId) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  const replacementId = uuidValue(value.replacementId ?? value.replacement_id);
  const rollbackTransitionId = uuidValue(value.rollbackTransitionId ?? value.rollback_transition_id);
  const activeSourceId = uuidValue(value.activeSourceId ?? value.active_source_id);
  const retiredSourceId = uuidValue(value.retiredSourceId ?? value.retired_source_id);
  if (replacementId !== expectedReplacementId || activeSourceId !== expectedActiveSourceId
      || retiredSourceId === activeSourceId) {
    throw new ContractError("REPLACEMENT_NOT_FOUND");
  }
  return Object.freeze({
    replacementId,
    rollbackTransitionId,
    state: enumValue(value.state, ["COMPLETED"], "INVARIANT_VIOLATION"),
    activeSourceId,
    retiredSourceId,
    visibilityEpoch: nonNegativeInteger(value.visibilityEpoch ?? value.visibility_epoch, "INVARIANT_VIOLATION"),
    replayed: value.replayed === true,
  });
}

function nullableApiUuid(value) {
  if (value === null || value === undefined || value === "") return null;
  return uuidValue(value);
}

function sanitizeCredentialCandidate(value, expectedSourceId) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  const candidateId = uuidValue(value.transitionId ?? value.transition_id);
  const sourceId = uuidValue(value.sourceId ?? value.source_id);
  if (sourceId !== expectedSourceId) throw new ContractError("TRANSITION_NOT_FOUND");
  const state = enumValue(value.state, [
    "VALIDATING", "STAGING", "IMPORTING", "READY_TO_SWITCH",
    "COMMITTING", "COMPLETED", "FAILED", "CANCELLED",
  ], "INVARIANT_VIOLATION");
  const comparison = nullableEnum(value.identityDecision ?? value.identity_decision, [
    "SAME_CATALOG", "DIFFERENT_CATALOG", "AMBIGUOUS",
  ]);
  const decisionOrigin = nullableEnum(value.decisionOrigin ?? value.decision_origin, ["AUTOMATIC", "MANUAL"]);
  const revision = nonNegativeInteger(value.revision, "INVARIANT_VIOLATION");
  const sourceRevision = nonNegativeInteger(
    value.currentSourceRevision ?? value.current_source_revision ?? value.expectedSourceRevision ?? value.expected_source_revision,
    "INVARIANT_VIOLATION",
  );
  const failureCode = safeMachineCode(value.failureCode ?? value.failure_code);
  const data = {
    candidateId,
    sourceId,
    state,
    comparison,
    decisionOrigin,
    revision,
    sourceRevision,
    createdAt: isoOrNull(value.startedAt ?? value.started_at),
    readyAt: isoOrNull(value.readyAt ?? value.ready_at),
    committingAt: isoOrNull(value.committingAt ?? value.committing_at),
    completedAt: isoOrNull(value.completedAt ?? value.completed_at),
    failureCode,
    actions: candidateActions(state, comparison, decisionOrigin),
  };
  return Object.freeze(data);
}

function candidateActions(state, comparison, decisionOrigin) {
  return Object.freeze({
    canDecide: state === "IMPORTING" && comparison === "AMBIGUOUS" && decisionOrigin !== "MANUAL",
    canApply: state === "READY_TO_SWITCH" && comparison === "SAME_CATALOG",
    canCancel: ["VALIDATING", "STAGING", "IMPORTING", "READY_TO_SWITCH"].includes(state),
    requiresReplacement: comparison === "DIFFERENT_CATALOG",
  });
}

function normalizeCredentialGeneration(value) {
  if (!isRecord(value)) throw new ContractError("INVARIANT_VIOLATION");
  return Object.freeze({
    generationId: uuidValue(value.generationId ?? value.generation_id),
    generationRevision: nonNegativeInteger(
      value.generationRevision ?? value.generation_revision,
      "INVARIANT_VIOLATION",
    ),
    headRevision: nonNegativeInteger(value.headRevision ?? value.head_revision, "INVARIANT_VIOLATION"),
    state: enumValue(value.generationState ?? value.generation_state, ["BUILDING", "READY", "ACTIVE", "RETAINED"], "INVARIANT_VIOLATION"),
    isActiveHead: value.isActiveHead === true || value.is_active_head === true,
    identityEvidence: value.identityEvidence ?? value.identity_evidence ?? null,
    strongIdentity: normalizeStrongIdentity(value.strongIdentity ?? value.strong_identity),
  });
}

function normalizeStrongIdentity(value) {
  if (!isRecord(value)) {
    return Object.freeze({ currentKnown: false, candidateKnown: false, match: false, distinct: false });
  }
  const result = {
    currentKnown: value.currentKnown === true || value.current_known === true,
    candidateKnown: value.candidateKnown === true || value.candidate_known === true,
    match: value.match === true,
    distinct: value.distinct === true,
  };
  if ((result.match || result.distinct) && (!result.currentKnown || !result.candidateKnown)) {
    throw new ContractError("INVARIANT_VIOLATION");
  }
  if (result.match && result.distinct) throw new ContractError("INVARIANT_VIOLATION");
  return Object.freeze(result);
}

async function rpc(name, params, context = {}) {
  const { data, error } = await admin.rpc(name, params);
  if (error) throw mapRpcError(error, context);
  if (data === null || data === undefined) throw new ContractError("INVARIANT_VIOLATION");
  return data;
}

function mapRpcError(error, context = {}) {
  const sqlstate = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  const detail = String(error?.details ?? "").toLowerCase();
  if (
    sqlstate === "55P03" &&
    /(?:^|;)reason=direct_fallback_lease_active(?:;|$)/.test(detail)
  ) {
    return new ContractError("PROVIDER_CHECK_TEMPORARY_FAILURE");
  }
  if (
    context.atomicCreate === true &&
    sqlstate === "55P03" &&
    /(?:^|;)reason=account_transition_active(?:;|$)/.test(detail)
  ) {
    return new ContractError("TRANSITION_ALREADY_PENDING");
  }
  if (
    context.atomicCreate === true &&
    ((sqlstate === "55000" && /(?:^|;)reason=affinity_missing(?:;|$)/.test(detail)) ||
      sqlstate === "42883" || sqlstate === "PGRST202")
  ) {
    return new ContractError("PROVIDER_CHECK_TEMPORARY_FAILURE");
  }
  if (message.includes("feature") && message.includes("disabled")) return new ContractError("FEATURE_DISABLED");
  if (message.includes("idempotency") && message.includes("reused")) return new ContractError("IDEMPOTENCY_KEY_REUSED");
  if (message.includes("already pending") || (sqlstate === "23505" && message.includes("nonterminal"))) {
    return new ContractError("TRANSITION_ALREADY_PENDING");
  }
  if (sqlstate === "P0002" || message.includes("not found")) {
    return new ContractError(
      context.resource === "source"
        ? "SOURCE_NOT_FOUND"
        : context.resource === "replacement"
          ? "REPLACEMENT_NOT_FOUND"
          : "TRANSITION_NOT_FOUND",
    );
  }
  if (sqlstate === "40001" || message.includes(" cas failed") || message.includes("stale source revision")) {
    return new ContractError(
      context.cas === "source"
        ? "SOURCE_REVISION_MISMATCH"
        : context.cas === "access"
          ? "ACCESS_REVISION_MISMATCH"
          : "TRANSITION_REVISION_MISMATCH",
    );
  }
  if (message.includes("different_catalog") || message.includes("different catalog")) {
    return new ContractError("DIFFERENT_CATALOG_REQUIRES_REPLACEMENT");
  }
  if (sqlstate === "55000" && message.includes("state")) return new ContractError("INVALID_TRANSITION_STATE");
  if (sqlstate === "22023" && message.includes("idempotency")) return new ContractError("IDEMPOTENCY_KEY_REUSED");
  if (sqlstate === "42501") return new ContractError("INVARIANT_VIOLATION");
  return new ContractError("INVARIANT_VIOLATION");
}

async function getRuntimeConfig() {
  if (runtimeConfigCache?.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  let mediaGatewayUrl = ENV_GATEWAY_URL;
  let mediaGatewayToken = ENV_GATEWAY_TOKEN;
  if (!sourceConfigKey || !mediaGatewayUrl || !mediaGatewayToken) {
    const { data, error } = await admin
      .from("cloud_runtime_config")
      .select("key,value")
      .in("key", ["NORVA_SOURCE_CONFIG_KEY", "NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"]);
    if (error) throw new ContractError("INVARIANT_VIOLATION");
    for (const row of data ?? []) {
      if (typeof row?.value !== "string" || !row.value) continue;
      if (row.key === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = row.value;
      if (row.key === "NORVA_MEDIA_GATEWAY_URL" && !mediaGatewayUrl) mediaGatewayUrl = trimTrailingSlash(row.value);
      if (row.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !mediaGatewayToken) mediaGatewayToken = row.value;
    }
  }
  if (!sourceConfigKey) throw new ContractError("INVARIANT_VIOLATION");
  const value = { sourceConfigKey, mediaGatewayUrl, mediaGatewayToken };
  runtimeConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function encryptSourceConfig(config, secret) {
  if (!secret) throw new ContractError("INVARIANT_VIOLATION");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sourceAesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(config)),
  );
  return `aesgcm.v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptSourceConfig(ciphertext, secret) {
  if (!secret || typeof ciphertext !== "string") throw new WorkerFault("internal_error", false);
  const [scheme, version, ivPart, dataPart] = ciphertext.split(".");
  if (scheme !== "aesgcm" || version !== "v1" || !ivPart || !dataPart) {
    throw new WorkerFault("internal_error", false);
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
      await sourceAesKey(secret),
      base64UrlToBytes(dataPart),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (!isRecord(parsed)) throw new Error("invalid");
    return normalizeCandidateConfig(parsed);
  } catch (error) {
    if (error instanceof ContractError) throw new WorkerFault("invalid_payload", false);
    throw new WorkerFault("internal_error", false);
  }
}

async function sourceAesKey(secret) {
  let material = base64UrlToBytes(secret);
  if (material.byteLength !== 32) {
    material = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function keyedFingerprint(secret, value) {
  if (!secret) throw new ContractError("INVARIANT_VIOLATION");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`provider-access-fingerprint-v1\u0000${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalJson(value)));
  return bytesToHex(new Uint8Array(signature));
}

async function handleProviderAccessCheckDrain(req, requestId) {
  await requireWorkerAuthorization(req);
  if (!await accessFeatureFlagEnabled() || !await accessDetectionFeatureFlagEnabled()) {
    throw new ContractError("FEATURE_DISABLED");
  }
  const body = await readJsonObject(req);
  if (Object.keys(body).some((key) => key !== "scheduleLimit")) {
    throw new ContractError("INVALID_REQUEST");
  }
  const scheduleLimit = body.scheduleLimit === undefined ? 100 : positiveInteger(body.scheduleLimit, 500);
  const workerId = `provider-access-check:${crypto.randomUUID()}`;
  await rpc("norva_schedule_provider_access_checks", {
    p_limit: scheduleLimit,
    p_now: new Date().toISOString(),
  });
  const claimed = await rpc("norva_claim_provider_access_check_jobs", {
    p_worker: workerId,
    p_limit: 1,
    p_lease_seconds: WORKER_LEASE_SECONDS,
  });
  const row = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!isRecord(row)) {
    return successResponse(req, requestId, "ProviderAccessCheckDrain", Object.freeze({
      claimed: 0, completed: 0, retried: 0, dead: 0,
    }));
  }
  const job = Object.freeze({
    jobId: uuidValue(row.job_id ?? row.jobId, true),
    userId: uuidValue(row.user_id ?? row.userId, true),
    sourceId: uuidValue(row.source_id ?? row.sourceId, true),
    leaseSequence: positiveInteger(row.lease_sequence ?? row.leaseSequence, Number.MAX_SAFE_INTEGER, "INVARIANT_VIOLATION"),
    attemptCount: positiveInteger(row.attempt_count ?? row.attemptCount, 20, "INVARIANT_VIOLATION"),
  });
  try {
    const result = await executeClaimedProviderAccessCheck(job, workerId);
    return successResponse(req, requestId, "ProviderAccessCheckDrain", Object.freeze({
      claimed: 1,
      completed: result.jobState === "COMPLETED" ? 1 : 0,
      retried: result.jobState === "RETRY" ? 1 : 0,
      dead: 0,
      status: result.status,
      reasonCode: result.reasonCode,
    }), result.jobState === "RETRY" ? 202 : 200);
  } catch (error) {
    const safe = normalizeWorkerFault(error);
    const settled = await settleProviderAccessCheckFailure(job, workerId, safe);
    return successResponse(req, requestId, "ProviderAccessCheckDrain", Object.freeze({
      claimed: 1,
      completed: 0,
      retried: settled === "RETRY" ? 1 : 0,
      dead: settled === "DEAD" ? 1 : 0,
    }), settled === "RETRY" ? 202 : 200);
  }
}

async function executeClaimedProviderAccessCheck(job, workerId) {
  const { data: source, error: sourceError } = await admin
    .from("cloud_sources")
    .select("id,user_id,source_type,config_ciphertext,deleted_at,enabled")
    .eq("id", job.sourceId)
    .eq("user_id", job.userId)
    .maybeSingle();
  if (sourceError) throw new WorkerFault("internal_error", true);
  if (!source || source.deleted_at || !source.enabled || String(source.source_type).toLowerCase() !== "xtream") {
    throw new WorkerFault("source_inactive", false);
  }
  const runtime = await getRuntimeConfig();
  let config;
  try {
    config = await decryptSourceConfig(source.config_ciphertext, runtime.sourceConfigKey);
  } catch (_) {
    throw new WorkerFault("invalid_payload", false);
  }
  const checkedAt = new Date().toISOString();
  let detection;
  let retryable = false;
  try {
    await assertProviderReadAllowed(job, config);
    detection = extractProviderAccessState(await gatewayAccountInfo(runtime, config), { now: checkedAt });
  } catch (error) {
    const fault = normalizeWorkerFault(error);
    retryable = fault.retryable;
    detection = providerAccessDetectionForFault(fault);
  }
  const value = await workerRpc("norva_apply_claimed_provider_access_detection", {
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_detection: detection,
    p_checked_at: checkedAt,
    p_retry_after_seconds: retryable ? retryDelaySeconds(job.attemptCount) : null,
  });
  const sanitized = sanitizeProviderAccess(value, job.sourceId);
  return Object.freeze({
    status: sanitized.status,
    reasonCode: safeMachineCode(detection.reasonCode),
    jobState: enumValue(value.jobState ?? value.job_state, ["COMPLETED", "RETRY"], "INVARIANT_VIOLATION"),
  });
}

function providerAccessDetectionForFault(fault) {
  if (!fault.retryable && fault.queueCode === "auth_rejected") {
    return Object.freeze({
      detectionVersion: PROVIDER_ACCESS_DETECTION_VERSION,
      status: "access_unavailable_confirmed",
      reasonCode: "PROVIDER_CREDENTIALS_REJECTED",
      expiresOn: null,
      hideEligible: true,
      restorationConfirmed: false,
      contradictions: [],
    });
  }
  return Object.freeze({
    detectionVersion: PROVIDER_ACCESS_DETECTION_VERSION,
    status: "check_failed_temporary",
    reasonCode: fault.retryable ? "PROVIDER_CHECK_TEMPORARY_FAILURE" : "PROVIDER_RESPONSE_INCONSISTENT",
    expiresOn: null,
    hideEligible: false,
    restorationConfirmed: false,
    contradictions: fault.retryable ? [] : ["PROVIDER_RESPONSE_INVALID"],
  });
}

async function settleProviderAccessCheckFailure(job, workerId, fault) {
  try {
    const value = await workerRpc("norva_fail_provider_access_check_job", {
      p_job_id: job.jobId,
      p_worker: workerId,
      p_expected_lease_sequence: job.leaseSequence,
      p_error_code: safeMachineCode(fault.queueCode) ?? "INTERNAL_ERROR",
      p_retryable: fault.retryable,
      p_retry_after_seconds: retryDelaySeconds(job.attemptCount),
    });
    return enumValue(value.state, ["RETRY", "DEAD"], "INVARIANT_VIOLATION");
  } catch (_) {
    // A lost lease is already durable evidence that another worker owns the
    // continuation. Never attempt to repair or overwrite it from Edge.
    return "RETRY";
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function handleWorkerDrain(req, requestId) {
  await requireWorkerAuthorization(req);
  const body = await readJsonObject(req);
  const limit = Math.min(WORKER_MAX_CLAIMS, Math.max(1, Number.isInteger(body.limit) ? body.limit : WORKER_MAX_CLAIMS));
  const [credentialEnabled, replacementEnabled] = await Promise.all([
    credentialFeatureFlagEnabled(),
    replacementFeatureFlagEnabled(),
  ]);
  const workerId = `provider-access:${crypto.randomUUID()}`;
  // Replacement claims run first so the legacy credential claimant can never
  // accidentally consume a replacement build while both rollout flags are ON.
  // PostgreSQL still owns the lease; this ordering is only a compatibility
  // fence during the rolling DB/Edge upgrade.
  let claim = replacementEnabled
    ? await claimReplacementCatalogBuildJobs(workerId, limit)
    : { data: [], error: null };
  if (!claim.error && (!Array.isArray(claim.data) || claim.data.length === 0)) {
    claim = await claimCredentialTransitionJobs(workerId, limit);
  }
  const { data, error } = claim;
  if (error) throw new ContractError("INVARIANT_VIOLATION");
  const jobs = Array.isArray(data) ? data.slice(0, limit) : [];
  const summary = {
    claimed: jobs.length,
    completed: 0,
    checkpointed: 0,
    retried: 0,
    dead: 0,
    featureBlocked: 0,
    leaseLost: 0,
    replacementCleanup: null,
  };
  for (const rawJob of jobs) {
    let job;
    try {
      job = normalizeClaimedJob(rawJob);
    } catch (_) {
      // A schema-drifted or otherwise malformed claimed row must not poison the
      // whole drain.  Settle it only when the lease identity itself is strict;
      // never echo the untrusted row (which may contain future private fields).
      const lease = claimedJobLeaseIdentity(rawJob);
      let settled = false;
      if (lease) {
        try {
          settled = await settleJob(lease, workerId, "dead", "invalid_payload", 60);
        } catch (_) {
          settled = false;
        }
      }
      if (settled) summary.dead += 1;
      else summary.leaseLost += 1;
      console.warn("[norva-provider-access] job_rejected", {
        requestId,
        jobId: lease?.jobId ?? null,
        code: "invalid_payload",
        outcome: settled ? "dead" : "lease_lost",
      });
      continue;
    }
    try {
      const featureEnabled = job.transitionKind === "replacement"
        ? replacementEnabled
        : credentialEnabled;
      const disposition = await processWorkerJobUnderGuards(job, workerId, featureEnabled);
      if (disposition === "checkpointed") summary.checkpointed += 1;
      else if (disposition === "feature_blocked") summary.featureBlocked += 1;
      else if (disposition === "handled") summary.completed += 1;
      else {
        const settled = await settleJob(job, workerId, "completed", null, 60);
        if (settled) summary.completed += 1;
        else summary.leaseLost += 1;
      }
    } catch (error) {
      const failure = normalizeWorkerFault(error);
      const outcome = failure.retryable && job.failureAttemptCount < workerRetryAttemptLimit(job.kind)
        ? "retry"
        : "dead";
      if (outcome === "dead" && failure.retryable
          && ["validate_candidate", "build_candidate_generation"].includes(job.kind)) {
        try {
          await failCredentialValidation(job, "validation_exhausted");
          summary.completed += 1;
          continue;
        } catch (_) {
          // Lease settlement still proceeds; an operator can reconcile the
          // nonterminal transition from the dead durable job without guessing.
        }
      }
      if (outcome === "dead" && failure.retryable && failure.queueCode !== "stale"
          && job.kind === "post_switch_verify") {
        try {
          await restoreAfterPostSwitchFailure(job, workerId, failure);
          summary.completed += 1;
          continue;
        } catch (_) {
          // If compensation CAS itself fails, dead-letter the proof job. The
          // transition remains nonterminal for explicit operator repair.
        }
      }
      const settled = await settleJob(
        job,
        workerId,
        outcome,
        failure.queueCode,
        retryDelaySeconds(job.failureAttemptCount + 1),
      );
      if (!settled) summary.leaseLost += 1;
      else if (outcome === "retry") summary.retried += 1;
      else summary.dead += 1;
      console.warn("[norva-provider-access] job_failed", {
        requestId,
        jobId: job.jobId,
        transitionId: job.transitionId,
        kind: job.kind,
        code: failure.queueCode,
        outcome,
      });
    }
  }
  // Terminal replacement cleanup is independent from rollout flags: once a
  // rollback/cancellation has durably scheduled a purge, turning a feature flag
  // OFF must not strand ciphertext or staging rows. Run one bounded batch only
  // when the transition queues are idle so ordinary proof work stays dominant.
  if (jobs.length === 0) {
    const { data: cleanup, error: cleanupError } = await admin.rpc(
      "norva_run_replacement_cleanup_batch",
      { p_worker: workerId, p_limit: 200 },
    );
    if (cleanupError || !isRecord(cleanup)) {
      throw new ContractError("INVARIANT_VIOLATION");
    }
    summary.replacementCleanup = {
      claimed: cleanup.claimed === true,
      complete: cleanup.complete === true,
      deletedRows: nonNegativeInteger(
        cleanup.deletedRows ?? cleanup.deleted_rows ?? 0,
        "INVARIANT_VIOLATION",
      ),
    };
  }
  return successResponse(req, requestId, "CredentialTransitionWorkerRun", summary, 200);
}

async function claimCredentialTransitionJobs(workerId, limit) {
  const common = {
    p_worker: workerId,
    p_limit: limit,
    p_lease_seconds: WORKER_LEASE_SECONDS,
  };
  const current = await admin.rpc("norva_claim_credential_transition_jobs", {
    ...common,
    p_worker_protocol: WORKER_PROTOCOL,
  });
  if (!current.error) return current;
  // Rolling Edge-new/DB-old compatibility. The legacy overload is attempted
  // once only when Postgres/PostgREST proves the four-argument overload is
  // absent. Any operational/auth/CAS error stays fail-closed. On DB-new, that
  // legacy overload cannot claim v2 cleanup jobs, protecting old workers.
  if (!rpcOverloadMissing(current.error)) return current;
  return admin.rpc("norva_claim_credential_transition_jobs", common);
}

async function claimReplacementCatalogBuildJobs(workerId, limit) {
  return admin.rpc("norva_claim_replacement_catalog_build_jobs_v2", {
    p_worker: workerId,
    p_limit: limit,
    p_lease_seconds: WORKER_LEASE_SECONDS,
  });
}

function rpcOverloadMissing(error) {
  if (!isRecord(error)) return false;
  const code = String(error.code ?? "");
  const evidence = [error.message, error.details, error.hint]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (!evidence.includes("norva_claim_credential_transition_jobs")) return false;
  if (code === "42883") {
    return evidence.includes("does not exist") && (
      evidence.includes("p_worker_protocol")
      || /\(\s*text\s*,\s*integer\s*,\s*integer\s*,\s*text\s*\)/.test(evidence)
    );
  }
  if (code === "PGRST202") {
    return evidence.includes("p_worker_protocol")
      && (evidence.includes("could not find") || evidence.includes("schema cache"));
  }
  return false;
}

async function requireWorkerAuthorization(req) {
  const platformAuthorization = req.headers.get("Authorization") ?? "";
  const fixedToken = req.headers.get("X-Norva-Worker-Token") ?? "";
  const bearer = platformAuthorization.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!bearer || !WORKER_TOKEN || !constantTimeEqual(fixedToken, WORKER_TOKEN)) {
    throw new ContractError("AUTHENTICATION_REQUIRED");
  }
  const { data, error } = await admin.rpc("norva_verify_cron_secret", { presented: bearer });
  if (error || data !== true) throw new ContractError("AUTHENTICATION_REQUIRED");
}

function normalizeClaimedJob(value) {
  if (!isRecord(value)) throw new WorkerFault("invalid_payload", false);
  const kind = String(value.job_kind ?? value.jobKind ?? "");
  if (!["validate_candidate", "build_candidate_generation", "post_switch_verify", "rollback_refresh",
    "promote_generation_titles", "purge_terminal_generation"].includes(kind)) {
    throw new WorkerFault("invalid_payload", false);
  }
  const progress = value.progress ?? null;
  if (progress !== null && !isRecord(progress)) throw new WorkerFault("invalid_payload", false);
  return {
    jobId: uuidValue(value.job_id ?? value.jobId, true),
    userId: uuidValue(value.user_id ?? value.userId, true),
    transitionId: uuidValue(value.transition_id ?? value.transitionId, true),
    sourceId: uuidValue(value.source_id ?? value.sourceId, true),
    comparisonSourceId: nullableWorkerUuid(value.comparison_source_id ?? value.comparisonSourceId),
    catalogGenerationId: nullableWorkerUuid(value.catalog_generation_id ?? value.catalogGenerationId),
    kind,
    transitionKind: String(value.transition_kind ?? value.transitionKind ?? "credential").toLowerCase() === "replacement"
      ? "replacement"
      : "credential",
    leaseSequence: nonNegativeInteger(value.lease_sequence ?? value.leaseSequence, "INVARIANT_VIOLATION"),
    failureAttemptCount: nonNegativeInteger(
      value.failure_attempt_count ?? value.failureAttemptCount,
      "INVARIANT_VIOLATION",
    ),
    checkpointRevision: nonNegativeInteger(
      value.checkpoint_revision ?? value.checkpointRevision,
      "INVARIANT_VIOLATION",
    ),
    progress,
    transitionRevision: nonNegativeInteger(
      value.transition_revision ?? value.transitionRevision,
      "INVARIANT_VIOLATION",
    ),
    expectedSourceRevision: nonNegativeInteger(
      value.expected_source_revision ?? value.expectedSourceRevision,
      "INVARIANT_VIOLATION",
    ),
    leaseUntilMs: leaseEpochMilliseconds(value.lease_until ?? value.leaseUntil),
  };
}

function claimedJobLeaseIdentity(value) {
  if (!isRecord(value)) return null;
  try {
    return {
      jobId: uuidValue(value.job_id ?? value.jobId, true),
      leaseSequence: nonNegativeInteger(
        value.lease_sequence ?? value.leaseSequence,
        "INVARIANT_VIOLATION",
      ),
    };
  } catch (_) {
    return null;
  }
}

function leaseEpochMilliseconds(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new WorkerFault("invalid_payload", false);
  return parsed;
}

function workerJobAllowedByFeatureFlag(kind, featureEnabled) {
  return featureEnabled === true || [
    "post_switch_verify",
    "rollback_refresh",
    "promote_generation_titles",
    "purge_terminal_generation",
  ].includes(kind);
}

async function processWorkerJobUnderGuards(job, workerId, featureEnabled, nowMs = Date.now()) {
  // SQL applies the same filter before claiming. This independent check makes a
  // stale schema/config fail closed without fetching the provider or swapping.
  if (!workerJobAllowedByFeatureFlag(job.kind, featureEnabled)) return "feature_blocked";
  if (!Number.isFinite(nowMs) || job.leaseUntilMs - nowMs < WORKER_MIN_START_LEASE_MS) {
    throw new WorkerFault("lease_expired", true);
  }
  return processClaimedJob(job, workerId);
}

async function processClaimedJob(job, workerId) {
  if (job.kind === "validate_candidate") return validateCredentialCandidateJob(job, workerId);
  if (job.kind === "build_candidate_generation") return buildCandidateGenerationJob(job, workerId);
  if (job.kind === "post_switch_verify") return verifyPostSwitchJob(job, workerId);
  if (job.kind === "rollback_refresh") return verifyRollbackJob(job, workerId);
  if (job.kind === "promote_generation_titles") return promoteGenerationTitlesJob(job, workerId);
  if (job.kind === "purge_terminal_generation") return purgeTerminalGenerationJob(job, workerId);
  throw new WorkerFault("invalid_payload", false);
}

const TERMINAL_CONTINUATION_BATCH_LIMIT = 200;

async function promoteGenerationTitlesJob(job, workerId) {
  const generationId = requiredJobGenerationId(job);
  const value = await continuationWorkerRpc("norva_promote_credential_generation_titles_batch", {
    p_generation_id: generationId,
    p_user_id: job.userId,
    p_limit: TERMINAL_CONTINUATION_BATCH_LIMIT,
  });
  const batch = normalizeTerminalContinuationBatch(
    value,
    generationId,
    "processedTitles",
    TERMINAL_CONTINUATION_BATCH_LIMIT,
    true,
  );
  if (!batch.complete) {
    await continuationWorkerRpc("norva_requeue_credential_title_promotion", {
      p_job_id: job.jobId,
      p_user_id: job.userId,
      p_worker: workerId,
      p_expected_lease_sequence: job.leaseSequence,
      p_retry_after_seconds: 1,
    });
    return "checkpointed";
  }
  return "settle";
}

async function purgeTerminalGenerationJob(job, workerId) {
  const generationId = requiredJobGenerationId(job);
  const value = await continuationWorkerRpc("norva_purge_cancelled_credential_generation_batch", {
    p_generation_id: generationId,
    p_user_id: job.userId,
    p_limit: TERMINAL_CONTINUATION_BATCH_LIMIT,
  });
  const batch = normalizeTerminalContinuationBatch(
    value,
    generationId,
    "deletedRows",
    TERMINAL_CONTINUATION_BATCH_LIMIT,
    false,
  );
  if (!batch.complete) {
    await continuationWorkerRpc("norva_requeue_credential_generation_purge", {
      p_job_id: job.jobId,
      p_user_id: job.userId,
      p_worker: workerId,
      p_expected_lease_sequence: job.leaseSequence,
      p_retry_after_seconds: 1,
    });
    return "checkpointed";
  }
  return "settle";
}

function requiredJobGenerationId(job) {
  if (!job.catalogGenerationId) throw new WorkerFault("invalid_payload", false);
  return job.catalogGenerationId;
}

function normalizeTerminalContinuationBatch(value, generationId, countField, limit, requireReturnedLimit) {
  if (!isRecord(value) || typeof value.complete !== "boolean") {
    throw new WorkerFault("invalid_payload", false);
  }
  const returnedGenerationId = uuidValue(value.generationId ?? value.generation_id, true);
  const count = nonNegativeInteger(
    value[countField] ?? value[countField.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)],
    "INVARIANT_VIOLATION",
  );
  if (returnedGenerationId !== generationId || count > limit) {
    throw new WorkerFault("invalid_payload", false);
  }
  if (requireReturnedLimit) {
    const returnedLimit = nonNegativeInteger(value.limit, "INVARIANT_VIOLATION");
    if (returnedLimit !== limit) throw new WorkerFault("invalid_payload", false);
  }
  return { complete: value.complete, count };
}

async function continuationWorkerRpc(name, params) {
  const { data, error } = await admin.rpc(name, params);
  if (error) throw new WorkerFault("internal_error", true);
  if (data === null || data === undefined) throw new WorkerFault("invalid_payload", false);
  return Array.isArray(data) ? data[0] : data;
}

function workerRetryAttemptLimit(kind) {
  // Purging a very large cancelled/failed generation is a terminal cleanup
  // outbox with SQL max_attempts=25. Other jobs retain the historical five
  // failure attempts; normal bounded continuations requeue without consuming
  // this failure budget.
  return kind === "purge_terminal_generation" ? 24 : 4;
}

async function validateCredentialCandidateJob(job, workerId) {
  const runtime = await getRuntimeConfig();
  if (!runtime.mediaGatewayUrl || !runtime.mediaGatewayToken) {
    throw new WorkerFault("provider_unavailable", true);
  }
  const candidateCiphertext = await readTransitionSecret(job, "candidate");
  const candidateConfig = await decryptSourceConfig(candidateCiphertext, runtime.sourceConfigKey);
  try {
    await assertProviderReadAllowed(job, candidateConfig);
    const account = await gatewayAccountInfo(runtime, candidateConfig, job);
    assertAuthenticatedAccount(account);
  } catch (error) {
    const fault = normalizeWorkerFault(error);
    if (!fault.retryable && fault.queueCode === "auth_rejected") {
      await failCredentialValidation(job, "candidate_auth_rejected");
      return "handled";
    } else if (!fault.retryable && fault.queueCode === "invalid_payload") {
      await failCredentialValidation(job, "candidate_invalid");
      return "handled";
    }
    throw fault;
  }
  await workerRpc("norva_mark_credential_candidate_validated", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_expected_transition_revision: job.transitionRevision,
    p_category_count: 0,
  });
  return "handled";
}

async function failCredentialValidation(job, failureCode) {
  if (job.transitionKind === "replacement") {
    const snapshot = await workerRpc("norva_get_source_replacement", {
      p_transition_id: job.transitionId,
      p_user_id: job.userId,
    });
    const revision = nonNegativeInteger(snapshot.revision, "INVARIANT_VIOLATION");
    const runtime = await getRuntimeConfig();
    await workerRpc("norva_fail_source_replacement", {
      p_transition_id: job.transitionId,
      p_user_id: job.userId,
      p_expected_transition_revision: revision,
      p_failure_code: failureCode,
      p_actor: "provider-access-worker",
      p_idempotency_key: `worker:${job.jobId}:${failureCode}`,
      p_request_fingerprint: await keyedFingerprint(runtime.sourceConfigKey, {
        operation: "fail_source_replacement",
        transitionId: job.transitionId,
        failureCode,
      }),
    });
    return;
  }
  const snapshot = await workerRpc("norva_get_credential_transition", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
  });
  const revision = nonNegativeInteger(snapshot.revision, "INVARIANT_VIOLATION");
  const runtime = await getRuntimeConfig();
  await workerRpc("norva_fail_credential_transition_validation", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_expected_transition_revision: revision,
    p_failure_code: failureCode,
    p_actor: "provider-access-worker",
    p_idempotency_key: `worker:${job.jobId}:${failureCode}`,
    p_request_fingerprint: await keyedFingerprint(runtime.sourceConfigKey, {
      operation: "fail_credential_validation",
      transitionId: job.transitionId,
      failureCode,
    }),
  });
}

const MANIFEST_SEAL_BATCH_LIMIT = 25_000;
const MANIFEST_SEAL_MAX_SLICES = 32;
const MANIFEST_SEAL_DEADLINE_MS = 45_000;

async function sealCredentialCatalogGenerationUnderLease({
  job,
  workerId,
  generationId,
  transitionRevision,
  generationRevision,
  now = () => Date.now(),
}) {
  const startedAt = now();
  let expectedGenerationRevision = generationRevision;
  let expectedCheckpointRevision = job.checkpointRevision;
  let slices = 0;

  while (slices < MANIFEST_SEAL_MAX_SLICES) {
    const sliceStartedAt = now();
    if (
      sliceStartedAt - startedAt >= MANIFEST_SEAL_DEADLINE_MS
      || job.leaseUntilMs - sliceStartedAt < WORKER_MIN_START_LEASE_MS
    ) break;

    const value = await workerRpc("norva_seal_credential_catalog_generation", {
      p_transition_id: job.transitionId,
      p_user_id: job.userId,
      p_generation_id: generationId,
      p_job_id: job.jobId,
      p_worker: workerId,
      p_expected_attempt: job.leaseSequence,
      p_expected_transition_revision: transitionRevision,
      p_expected_generation_revision: expectedGenerationRevision,
    });
    const batch = normalizeManifestSealBatch(
      value,
      job,
      generationId,
      expectedGenerationRevision,
      expectedCheckpointRevision,
    );
    slices += 1;
    expectedGenerationRevision = batch.generationRevision;
    expectedCheckpointRevision = batch.checkpointRevision;
    if (batch.complete) return { complete: true, slices };
  }

  const checkpoint = await workerRpc("norva_checkpoint_credential_generation_job", {
    p_job_id: job.jobId,
    p_user_id: job.userId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_expected_checkpoint_revision: expectedCheckpointRevision,
    p_progress: job.progress,
    p_retry_after_seconds: 0,
  });
  normalizeManifestSealCheckpoint(
    checkpoint,
    job.jobId,
    expectedCheckpointRevision,
    job.progress,
  );
  return { complete: false, slices };
}

function normalizeManifestSealBatch(
  value,
  job,
  generationId,
  expectedGenerationRevision,
  expectedCheckpointRevision,
) {
  if (!isRecord(value) || typeof value.complete !== "boolean") {
    throw new WorkerFault("invalid_payload", false);
  }
  const returnedTransitionId = manifestUuid(value.transitionId ?? value.transition_id);
  const returnedGenerationId = manifestUuid(value.generationId ?? value.generation_id);
  const returnedGenerationRevision = manifestNonNegativeInteger(
    value.generationRevision ?? value.generation_revision,
  );
  const processedRows = manifestNonNegativeInteger(value.processedRows ?? value.processed_rows);
  const batchLimit = manifestNonNegativeInteger(value.batchLimit ?? value.batch_limit);
  if (
    returnedTransitionId !== job.transitionId
    || returnedGenerationId !== generationId
    || batchLimit !== MANIFEST_SEAL_BATCH_LIMIT
    || processedRows > batchLimit
    || returnedGenerationRevision < expectedGenerationRevision
    || returnedGenerationRevision > expectedGenerationRevision + 1
  ) {
    throw new WorkerFault("invalid_payload", false);
  }

  if (value.complete) {
    if (
      value.leaseRetained !== false
      || String(value.generationState ?? value.generation_state ?? "") !== "READY"
      || String(value.sealPhase ?? value.seal_phase ?? "") !== "complete"
    ) throw new WorkerFault("invalid_payload", false);
    return {
      complete: true,
      generationRevision: returnedGenerationRevision,
      checkpointRevision: expectedCheckpointRevision,
    };
  }

  const checkpointRevision = manifestNonNegativeInteger(
    value.checkpointRevision ?? value.checkpoint_revision,
  );
  const sealRole = String(value.sealRole ?? value.seal_role ?? "");
  const sealPhase = String(value.sealPhase ?? value.seal_phase ?? "");
  if (
    value.leaseRetained !== true
    || String(value.generationState ?? value.generation_state ?? "") !== "BUILDING"
    || checkpointRevision !== expectedCheckpointRevision
    || !["previous", "candidate"].includes(sealRole)
    || ![
      "media_items",
      "title_variants",
      "live_channels",
      "live_variants",
      "episode_memberships",
      "series_inventory",
    ].includes(sealPhase)
  ) throw new WorkerFault("invalid_payload", false);
  return {
    complete: false,
    generationRevision: returnedGenerationRevision,
    checkpointRevision,
  };
}

function normalizeManifestSealCheckpoint(value, jobId, expectedCheckpointRevision, progress) {
  if (!isRecord(value)) throw new WorkerFault("invalid_payload", false);
  const returnedJobId = manifestUuid(value.jobId ?? value.job_id);
  const checkpointRevision = manifestNonNegativeInteger(
    value.checkpointRevision ?? value.checkpoint_revision,
  );
  if (
    returnedJobId !== jobId
    || String(value.state ?? "") !== "PENDING"
    || checkpointRevision !== expectedCheckpointRevision + 1
    || canonicalJson(value.progress) !== canonicalJson(progress)
  ) throw new WorkerFault("invalid_payload", false);
}

function manifestUuid(value) {
  try {
    return uuidValue(value, true);
  } catch (_) {
    throw new WorkerFault("invalid_payload", false);
  }
}

function manifestNonNegativeInteger(value) {
  try {
    return nonNegativeInteger(value, "INVARIANT_VIOLATION");
  } catch (_) {
    throw new WorkerFault("invalid_payload", false);
  }
}

async function buildCandidateGenerationJob(job, workerId) {
  const runtime = await getRuntimeConfig();
  if (!runtime.mediaGatewayUrl || !runtime.mediaGatewayToken) throw new WorkerFault("provider_unavailable", true);
  const candidateCiphertext = await readTransitionSecret(job, "candidate");
  const candidateConfig = await decryptSourceConfig(candidateCiphertext, runtime.sourceConfigKey);
  let generationId = job.catalogGenerationId;
  let transitionRevision = job.transitionRevision;
  if (!generationId) {
    const allocation = job.transitionKind === "replacement"
      ? await workerRpc("norva_allocate_replacement_catalog_generation", {
        p_transition_id: job.transitionId,
        p_user_id: job.userId,
        p_job_id: job.jobId,
        p_worker: workerId,
        p_expected_lease_sequence: job.leaseSequence,
        p_expected_transition_revision: transitionRevision,
      })
      : await workerRpc("norva_allocate_credential_catalog_generation", {
        p_transition_id: job.transitionId,
        p_user_id: job.userId,
        p_job_id: job.jobId,
        p_worker: workerId,
        p_expected_attempt: job.leaseSequence,
        p_expected_transition_revision: transitionRevision,
      });
    generationId = uuidValue(allocation.generationId ?? allocation.generation_id, true);
    transitionRevision = nonNegativeInteger(
      allocation.transitionRevision ?? allocation.transition_revision,
      "INVARIANT_VIOLATION",
    );
  }

  let generation = normalizeCredentialGeneration(await workerRpc(
    job.transitionKind === "replacement"
      ? "norva_get_replacement_catalog_generation"
      : "norva_get_credential_catalog_generation", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
  }));
  if (generation.generationId !== generationId) throw new WorkerFault("catalog_unhealthy", false);

  if (generation.state === "BUILDING" && !generationProgressComplete(job.progress)) {
    await assertProviderReadAllowed(job, candidateConfig);
    let staged: Awaited<ReturnType<typeof stageXtreamCredentialCatalogGeneration>>;
    try {
      staged = await stageXtreamCredentialCatalogGeneration({
        db: admin,
        userId: job.userId,
        sourceId: job.sourceId,
        transitionId: job.transitionId,
        generationId,
        jobId: job.jobId,
        leaseSequence: job.leaseSequence,
        leaseOwner: workerId,
        cursor: job.progress,
        fetchMetadataPage: (request) => gatewayMetadataPage(
          runtime,
          candidateConfig,
          job,
          generationId,
          request,
        ),
        // Eight serial pages cap each lease at ~2,000 rows (250/page) and the
        // 45s deadline remains authoritative. A 100k-row catalogue therefore
        // needs about 50 successful claims; 1M rows about 500, without an
        // unbounded loop or a whole-catalogue Edge buffer.
        maxSlices: 8,
        deadlineMs: 45_000,
      });
    } catch (error) {
      const fault = normalizeWorkerFault(error);
      if (!fault.retryable && fault.queueCode === "catalog_changed_during_build") {
        await failCredentialValidation(job, "catalog_changed_during_staging");
        return "handled";
      }
      throw error;
    }
    const checkpoint = (staged as unknown as Record<string, unknown>).checkpoint
      ?? (staged.done ? null : staged.nextCursor);
    if (!isRecord(checkpoint)) {
      // Completion is never inferred from a null cursor. A bounded, DB-valid
      // completion checkpoint is required so a fresh lease performs the seal.
      throw new WorkerFault("catalog_unhealthy", false);
    }
    await workerRpc("norva_checkpoint_credential_generation_job", {
      p_job_id: job.jobId,
      p_user_id: job.userId,
      p_worker: workerId,
      p_expected_lease_sequence: job.leaseSequence,
      p_expected_checkpoint_revision: job.checkpointRevision,
      p_progress: checkpoint,
      p_retry_after_seconds: staged.pending === true
        ? boundedGatewayRetryAfter(staged.retryAfterSeconds ?? 2)
        : 0,
    });
    return "checkpointed";
  }

  if (generation.state === "BUILDING") {
    await sealCredentialCatalogGenerationUnderLease({
      job,
      workerId,
      generationId,
      transitionRevision,
      generationRevision: generation.generationRevision,
    });
    // An incomplete bounded seal is checkpointed exactly once by the helper.
    // A complete seal atomically releases the build job back to PENDING so a
    // fresh claim can assess the durable READY identity evidence.
    return "checkpointed";
  }
  if (generation.state !== "READY" || generation.isActiveHead) {
    throw new WorkerFault("catalog_unhealthy", false);
  }

  if (job.transitionKind === "replacement") {
    await workerRpc("norva_mark_replacement_transition_ready", {
      p_transition_id: job.transitionId,
      p_user_id: job.userId,
      p_readiness_check_id: crypto.randomUUID(),
      p_expected_transition_revision: transitionRevision,
    });
    return "settle";
  }

  try {
    await assessSealedCredentialGeneration(job, generation, runtime);
  } catch (error) {
    const fault = normalizeWorkerFault(error);
    if (!fault.retryable && ["catalog_unhealthy", "invalid_payload"].includes(fault.queueCode)) {
      await failCredentialValidation(job, "identity_validation_failed");
      return "handled";
    }
    if (!(error instanceof WorkerFault)) {
      await failCredentialValidation(job, "identity_validation_failed");
      return "handled";
    }
    throw fault;
  }
  // The READY continuation still owns an active lease; generic settlement is
  // performed only after assessment (and automatic readiness, when SAME).
  return "settle";
}

async function readTransitionSecret(job, purpose) {
  const { data, error } = await admin.rpc("norva_read_credential_transition_secret", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_purpose: purpose,
  });
  if (error || typeof data !== "string" || !data) throw new WorkerFault("internal_error", false);
  return data;
}

function generationProgressComplete(progress) {
  return isRecord(progress) && progress.action === "complete";
}

async function assessSealedCredentialGeneration(job, generation, runtime) {
  const active = await workerRpc("norva_get_active_catalog_identity_evidence", {
    p_user_id: job.userId,
    p_source_id: job.sourceId,
  });
  const previousConfig = await decryptSourceConfig(
    await readTransitionSecret(job, "previous"),
    runtime.sourceConfigKey,
  );
  const candidateConfig = await decryptSourceConfig(
    await readTransitionSecret(job, "candidate"),
    runtime.sourceConfigKey,
  );
  const currentEvidence = normalizeCatalogIdentityEvidence(
    active.identityEvidence ?? active.identity_evidence,
    previousConfig,
    generation.strongIdentity.distinct
      ? { id: "verified-registry-current", strength: "strong" }
      : undefined,
  );
  const candidateEvidence = normalizeCatalogIdentityEvidence(
    generation.identityEvidence,
    candidateConfig,
    generation.strongIdentity.distinct
      ? { id: "verified-registry-candidate-distinct", strength: "strong" }
      : undefined,
  );
  const assessment = compareProviderCatalogIdentity({ current: currentEvidence, candidate: candidateEvidence });
  const reasonCode = assessment.decision === PROVIDER_CATALOG_IDENTITY_DECISIONS.SAME_CATALOG
    ? "manifest_and_typed_overlap_same_catalog"
    : assessment.decision === PROVIDER_CATALOG_IDENTITY_DECISIONS.DIFFERENT_CATALOG
      ? "distinct_complete_catalog"
      : assessment.contentManifest.currentPresent
          && assessment.contentManifest.candidatePresent
          && !assessment.contentManifest.matching
        ? "manifest_mismatch"
        : "insufficient_or_conflicting_evidence";
  const result = await workerRpc("norva_record_credential_identity_assessment", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_algorithm_version: PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION,
    p_sample_size_old: assessment.sampleSizeCurrent,
    p_sample_size_new: assessment.sampleSizeCandidate,
    p_overlap_count: assessment.overlapCount,
    p_similarity_score: Number(assessment.similarityScore.toFixed(5)),
    p_summary: {
      sample_complete: Boolean(assessment.evidenceComplete.current && assessment.evidenceComplete.candidate),
      strong_identity_distinct: generation.strongIdentity.distinct,
      canonical_identity_match: generation.strongIdentity.match,
      content_manifest_checksum_match: assessment.contentManifest.matching,
      decision_reason_code: reasonCode,
    },
    p_automatic_decision: assessment.decision,
  });
  if (assessment.decision === PROVIDER_CATALOG_IDENTITY_DECISIONS.SAME_CATALOG) {
    await workerRpc("norva_mark_credential_transition_ready", {
      p_transition_id: job.transitionId,
      p_user_id: job.userId,
      p_readiness_check_id: crypto.randomUUID(),
      p_expected_transition_revision: nonNegativeInteger(result.revision, "INVARIANT_VIOLATION"),
    });
  }
}

function normalizeCatalogIdentityEvidence(value, config, canonicalIdentity) {
  if (!isRecord(value) || typeof value.complete !== "boolean"
      || !Array.isArray(value.sample) || value.sample.length > 256) {
    throw new WorkerFault("catalog_unhealthy", false);
  }
  const movieExternalIds = [];
  const seriesExternalIds = [];
  for (const row of value.sample) {
    if (!isRecord(row)) throw new WorkerFault("catalog_unhealthy", false);
    const itemType = String(row.itemType ?? row.item_type ?? "").toLowerCase();
    const digest = String(row.externalIdHash ?? row.external_id_hash ?? "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new WorkerFault("catalog_unhealthy", false);
    if (itemType === "movie") movieExternalIds.push(digest);
    else if (itemType === "series") seriesExternalIds.push(digest);
    else throw new WorkerFault("catalog_unhealthy", false);
  }
  const categories = boundedIdentityCategories(value.categories ?? value.categoryEvidence ?? []);
  const rawContentManifestChecksum = value.contentManifestChecksum ?? value.content_manifest_checksum;
  let contentManifestChecksum;
  if (rawContentManifestChecksum !== undefined && rawContentManifestChecksum !== null
      && rawContentManifestChecksum !== "") {
    if (typeof rawContentManifestChecksum !== "string"
        || !/^[a-f0-9]{64}$/.test(rawContentManifestChecksum.toLowerCase())) {
      throw new WorkerFault("catalog_unhealthy", false);
    }
    contentManifestChecksum = rawContentManifestChecksum.toLowerCase();
  }
  return {
    movieExternalIds,
    seriesExternalIds,
    sampleComplete: value.complete,
    host: new URL(config.serverUrl).host,
    sourceType: "xtream",
    categories,
    canonicalIdentity,
    contentManifestChecksum,
  };
}

function boundedIdentityCategories(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new WorkerFault("catalog_unhealthy", false);
  return value.map((entry) => {
    const text = String(entry ?? "").normalize("NFC").trim().toLowerCase();
    if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new WorkerFault("catalog_unhealthy", false);
    }
    return text;
  });
}

async function verifyPostSwitchJob(job, workerId) {
  const runtime = await getRuntimeConfig();
  const candidateConfig = await decryptSourceConfig(
    await readTransitionSecret(job, "candidate"),
    runtime.sourceConfigKey,
  );
  try {
    await assertProviderReadAllowed(job, candidateConfig);
    assertAuthenticatedAccount(await gatewayAccountInfo(runtime, candidateConfig, job));
  } catch (error) {
    const fault = normalizeWorkerFault(error);
    // Provider pressure, local/distributed playback, proxy outages, and gateway
    // preemption are retryable proof failures. They must never roll back an
    // otherwise healthy switch merely because the proof lane was occupied.
    if (fault.retryable) throw fault;
    await restoreAfterPostSwitchFailure(job, workerId, fault);
    return "handled";
  }
  const refresh = await runActivePostSwitchRefresh(job, workerId, runtime, candidateConfig);
  if (!refresh.complete) return "handled";
  await workerRpc("norva_complete_credential_transition", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_expected_transition_revision: job.transitionRevision,
    p_expected_head_revision: refresh.headRevision,
    p_refresh_proof_id: refresh.refreshProofId,
  });
  return "handled";
}

// The post-switch lane never reuses the candidate-generation writer: its SQL
// contract is deliberately different (active head, exact job lease, refresh
// run, action ledger and compensable prune).  One invocation consumes at most
// one gateway page or one bounded prune batch, then atomically requeues itself.
// Consequently a crash can only replay a SQL-fenced page, never invent a
// refresh proof in Edge memory.
const ACTIVE_REFRESH_ACTIONS = Object.freeze([
  { action: "live_categories", gateway: "get_live_categories", kind: "category", itemType: "live", categoryKind: "live" },
  { action: "vod_categories", gateway: "get_vod_categories", kind: "category", itemType: "movie", categoryKind: "vod" },
  { action: "series_categories", gateway: "get_series_categories", kind: "category", itemType: "series", categoryKind: "series" },
  { action: "live_streams", gateway: "get_live_streams", kind: "item", itemType: "live", categoryKind: "live" },
  { action: "vod_streams", gateway: "get_vod_streams", kind: "item", itemType: "movie", categoryKind: "vod" },
  { action: "series_streams", gateway: "get_series", kind: "item", itemType: "series", categoryKind: "series" },
]);

async function runActivePostSwitchRefresh(job, workerId, runtime, candidateConfig) {
  const expectedGenerationId = requiredJobGenerationId(job);
  const snapshot = activeRefreshSnapshot(await workerRpc("norva_get_catalog_write_snapshot", {
    p_source_id: job.sourceId,
    p_user_id: job.userId,
  }), expectedGenerationId);
  const run = activeRefreshRun(await workerRpc("norva_begin_active_catalog_title_projection_refresh", {
    p_source_id: job.sourceId,
    p_user_id: job.userId,
    p_generation_id: expectedGenerationId,
    p_job_id: job.jobId,
    p_worker: workerId,
    p_lease_sequence: job.leaseSequence,
    p_head_revision: snapshot.headRevision,
    p_config_revision: snapshot.configRevision,
    p_source_visibility_epoch: snapshot.sourceVisibilityEpoch,
    p_user_visibility_epoch: snapshot.userVisibilityEpoch,
  }));
  const state = activeRefreshProgress(run.checkpoint, run.generationRevision);
  const fence = {
    p_source_id: job.sourceId, p_user_id: job.userId,
    p_generation_id: expectedGenerationId, p_refresh_run_id: run.refreshRunId,
    p_job_id: job.jobId, p_worker: workerId, p_lease_sequence: job.leaseSequence,
    p_head_revision: snapshot.headRevision, p_config_revision: snapshot.configRevision,
    p_source_visibility_epoch: snapshot.sourceVisibilityEpoch,
    p_user_visibility_epoch: run.userVisibilityEpoch,
  };

  if (state.action === "complete") {
    // The marker is deliberately repeated on replay: its SQL CAS is idempotent
    // and remains the only source of the proof UUID accepted by completion.
    await workerRpc("norva_reconcile_active_catalog_title_projection_batch", { ...fence, p_limit: 200 });
    await workerRpc("norva_mark_active_catalog_title_projection_refreshed", fence);
    return { complete: true, headRevision: snapshot.headRevision, refreshProofId: run.refreshRunId };
  }

  const actionIndex = ACTIVE_REFRESH_ACTIONS.findIndex((entry) => entry.action === state.action);
  if (actionIndex < 0) throw new WorkerFault("catalog_unhealthy", false);
  const action = ACTIVE_REFRESH_ACTIONS[actionIndex];
  if (state.actionComplete) {
    let visibilityEpoch = fence.p_user_visibility_epoch;
    if (action.kind === "item") {
      const pruned = rpcObject(await workerRpc("norva_prune_active_catalog_refresh_action_batch", {
        ...fence,
        p_expected_checkpoint_revision: run.checkpointRevision,
        p_action_kind: action.categoryKind,
        p_catalog_version: state.catalogVersion,
        p_limit: 200,
      }));
      visibilityEpoch = activeVisibilityEpoch(
        pruned,
        fence.p_user_visibility_epoch,
      );
      if (pruned.complete !== true) {
        await checkpointActiveRefresh(
          { ...fence, p_user_visibility_epoch: visibilityEpoch },
          run.checkpointRevision,
          state,
          true,
          1,
        );
        return { complete: false };
      }
    }
    const next = actionIndex === ACTIVE_REFRESH_ACTIONS.length - 1
      ? { ...state, action: "complete", actionComplete: true, cursor: "", spoolToken: "" }
      : emptyActiveRefreshProgress(ACTIVE_REFRESH_ACTIONS[actionIndex + 1].action, state.catalogVersion);
    const checkpoint = await checkpointActiveRefresh(
      { ...fence, p_user_visibility_epoch: visibilityEpoch },
      run.checkpointRevision,
      next,
      true,
      1,
    );
    if (next.action !== "complete") return { complete: false };
    // The complete checkpoint can only be persisted after all three action
    // proofs are current.  A new lease will perform the final marker.
    return { complete: false, checkpointRevision: checkpoint.checkpointRevision };
  }

  const page = await gatewayMetadataPage(runtime, candidateConfig, job, expectedGenerationId, {
    action: action.gateway,
    categoryId: null,
    cursor: state.cursor || null,
    spoolToken: state.spoolToken || null,
    maxItems: action.kind === "category" ? 500 : 250,
  });
  if (page.pending) {
    await checkpointActiveRefresh(fence, run.checkpointRevision, state, true, boundedGatewayRetryAfter(page.retryAfterSeconds ?? 2));
    return { complete: false };
  }
  const spoolToken = cleanActiveSpoolToken(page.spoolToken ?? state.spoolToken);
  const contentSha256 = activeSpoolDigest(spoolToken);
  if (!contentSha256) throw new WorkerFault("catalog_unhealthy", false);
  if (state.contentSha256 && state.contentSha256 !== contentSha256) {
    throw new WorkerFault("catalog_changed_during_build", false);
  }
  // Bind the immutable Gateway spool digest into PostgreSQL before any payload
  // writer runs.  Every writer independently requires this incomplete
  // checkpoint, so a worker that loses its lease cannot write a fetched page.
  const boundCheckpoint = await checkpointActiveRefresh(
    fence,
    run.checkpointRevision,
    {
      ...state,
      contentSha256,
      spoolToken,
      actionComplete: false,
    },
    false,
    0,
  );
  const boundCheckpointRevision = boundCheckpoint.checkpointRevision;
  if (action.kind === "category") {
    const categories = activeCategories(page.items, state.categoryCount);
    const categoryResult = rpcObject(await workerRpc("norva_upsert_active_catalog_refresh_categories", {
      ...fence,
      p_action_kind: action.categoryKind,
      p_categories: categories,
    }));
    const visibilityEpoch = activeVisibilityEpoch(categoryResult, fence.p_user_visibility_epoch);
    const next = {
      ...state, contentSha256, cursor: page.done ? "" : requiredActiveCursor(page.nextCursor), spoolToken,
      actionComplete: page.done,
      processedCategories: state.processedCategories + categories.length,
      categoryCount: state.categoryCount + categories.length,
    };
    await checkpointActiveRefresh({ ...fence, p_user_visibility_epoch: visibilityEpoch }, boundCheckpointRevision, next, true, 1);
    return { complete: false };
  }

  const rawItems = page.items.filter(isRecord);
  if (rawItems.length !== page.items.length) throw new WorkerFault("invalid_payload", false);
  const media = activeMediaRows(job, rawItems, action.itemType);
  const mediaResult = rpcObject(await workerRpc("norva_upsert_active_catalog_media_items", {
    ...fence, p_catalog_version: state.catalogVersion, p_items: media,
  }));
  let visibilityEpoch = activeVisibilityEpoch(mediaResult, fence.p_user_visibility_epoch);
  if (action.itemType === "live") {
    const live = activeLivePayload(job, media, mediaResult);
    const liveResult = rpcObject(await workerRpc("norva_upsert_active_catalog_live_materialization", {
      ...fence, p_user_visibility_epoch: visibilityEpoch, p_catalog_version: state.catalogVersion,
      p_channels: live.channels, p_variants: live.variants,
    }));
    visibilityEpoch = activeVisibilityEpoch(liveResult, visibilityEpoch);
  } else {
    const titles = activeTitlePayload(job, media);
    const titleResult = rpcObject(await workerRpc("norva_upsert_active_catalog_title_payloads", {
      ...fence, p_user_visibility_epoch: visibilityEpoch, p_titles: titles,
    }));
    visibilityEpoch = activeVisibilityEpoch(titleResult, visibilityEpoch);
    const variants = activeTitleVariants(media, mediaResult, titleResult);
    const variantResult = rpcObject(await workerRpc("norva_upsert_active_catalog_title_variants", {
      ...fence, p_user_visibility_epoch: visibilityEpoch, p_catalog_version: state.catalogVersion, p_variants: variants,
    }));
    visibilityEpoch = activeVisibilityEpoch(variantResult, visibilityEpoch);
    await workerRpc("norva_confirm_active_catalog_title_projection_batch", {
      ...fence, p_user_visibility_epoch: visibilityEpoch,
      p_titles: activeTitleConfirmations(titleResult),
    });
  }
  const next = {
    ...state, contentSha256, cursor: page.done ? "" : requiredActiveCursor(page.nextCursor), spoolToken,
    actionComplete: page.done,
    processedItems: state.processedItems + media.length,
    observedItems: state.observedItems + media.length,
  };
  await checkpointActiveRefresh({ ...fence, p_user_visibility_epoch: visibilityEpoch }, boundCheckpointRevision, next, true, 1);
  return { complete: false };
}

function rpcObject(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!isRecord(row)) throw new WorkerFault("catalog_unhealthy", false);
  return row;
}

function activeRefreshSnapshot(value, expectedGenerationId) {
  const row = rpcObject(value);
  const generationId = uuidValue(row.generationId ?? row.generation_id, true);
  if (generationId !== expectedGenerationId || row.isCatalogVisible !== true && row.is_catalog_visible !== true) {
    throw new WorkerFault("catalog_unhealthy", false);
  }
  return {
    headRevision: nonNegativeInteger(row.headRevision ?? row.head_revision, "INVARIANT_VIOLATION"),
    configRevision: nonNegativeInteger(row.configRevision ?? row.config_revision, "INVARIANT_VIOLATION"),
    sourceVisibilityEpoch: nonNegativeInteger(row.sourceVisibilityEpoch ?? row.source_visibility_epoch, "INVARIANT_VIOLATION"),
    userVisibilityEpoch: nonNegativeInteger(row.userVisibilityEpoch ?? row.user_visibility_epoch, "INVARIANT_VIOLATION"),
  };
}

function activeRefreshRun(value) {
  const row = rpcObject(value);
  return {
    refreshRunId: uuidValue(row.refreshRunId ?? row.refresh_run_id, true),
    checkpointRevision: nonNegativeInteger(row.checkpointRevision ?? row.checkpoint_revision, "INVARIANT_VIOLATION"),
    generationRevision: nonNegativeInteger(row.generationRevision ?? row.generation_revision, "INVARIANT_VIOLATION"),
    userVisibilityEpoch: nonNegativeInteger(row.visibilityEpoch ?? row.visibility_epoch, "INVARIANT_VIOLATION"),
    checkpoint: rpcObject(row.checkpoint),
  };
}

function activeRefreshProgress(value, generationRevision) {
  const action = String(value.action ?? "");
  const known = ACTIVE_REFRESH_ACTIONS.some((entry) => entry.action === action) || action === "complete";
  const catalogVersion = nonNegativeInteger(value.catalogVersion ?? value.catalog_version, "INVARIANT_VIOLATION");
  if (!known || catalogVersion !== generationRevision || typeof value.actionComplete !== "boolean") {
    throw new WorkerFault("catalog_unhealthy", false);
  }
  const stringField = (name) => {
    const field = value[name];
    if (typeof field !== "string" || field.length > 2048 || /[\u0000-\u001f\u007f]/u.test(field)) {
      throw new WorkerFault("catalog_unhealthy", false);
    }
    return field;
  };
  return {
    version: 1,
    catalogVersion,
    action,
    actionComplete: value.actionComplete,
    cursor: stringField("cursor"),
    spoolToken: stringField("spoolToken"),
    contentSha256: stringField("contentSha256"),
    processedCategories: nonNegativeInteger(value.processedCategories, "INVARIANT_VIOLATION"),
    processedItems: nonNegativeInteger(value.processedItems, "INVARIANT_VIOLATION"),
    observedItems: nonNegativeInteger(value.observedItems, "INVARIANT_VIOLATION"),
    categoryCount: nonNegativeInteger(value.categoryCount, "INVARIANT_VIOLATION"),
  };
}

function emptyActiveRefreshProgress(action, catalogVersion) {
  return {
    version: 1, catalogVersion, action, actionComplete: false,
    cursor: "", spoolToken: "", contentSha256: "",
    processedCategories: 0, processedItems: 0, observedItems: 0, categoryCount: 0,
  };
}

async function checkpointActiveRefresh(fence, checkpointRevision, progress, requeue, delaySeconds) {
  return activeRefreshCheckpoint(await workerRpc("norva_checkpoint_active_catalog_title_refresh", {
    ...fence,
    p_expected_checkpoint_revision: checkpointRevision,
    p_progress: progress,
    p_requeue: requeue,
    p_delay_seconds: delaySeconds,
  }));
}

function activeRefreshCheckpoint(value) {
  const row = rpcObject(value);
  return {
    checkpointRevision: nonNegativeInteger(row.checkpointRevision ?? row.checkpoint_revision, "INVARIANT_VIOLATION"),
    userVisibilityEpoch: nonNegativeInteger(row.visibilityEpoch ?? row.visibility_epoch, "INVARIANT_VIOLATION"),
    checkpoint: rpcObject(row.checkpoint),
    requeued: row.requeued === true,
  };
}

function cleanActiveSpoolToken(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WorkerFault("catalog_unhealthy", false);
  }
  return value;
}

function activeSpoolDigest(token) {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(base64));
    const digest = isRecord(decoded) ? String(decoded.d ?? "").toLowerCase() : "";
    return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch (_) {
    return null;
  }
}

function requiredActiveCursor(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WorkerFault("catalog_unhealthy", false);
  }
  return value;
}

function activeVisibilityEpoch(value, fallback) {
  const candidate = value.visibilityEpoch ?? value.visibility_epoch;
  return candidate === undefined ? fallback : nonNegativeInteger(candidate, "INVARIANT_VIOLATION");
}

function activeCategories(items, ordinalBase) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!isRecord(item)) throw new WorkerFault("invalid_payload", false);
    const id = String(item.id ?? item.category_id ?? item.categoryId ?? "").normalize("NFC").trim();
    const name = String(item.name ?? item.category_name ?? item.categoryName ?? "").normalize("NFC").trim();
    if (!id || !name || id.length > 1200 || name.length > 2000 || /[\u0000-\u001f\u007f]/u.test(id + name)) {
      throw new WorkerFault("invalid_payload", false);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ category_ordinal: ordinalBase + result.length, provider_category_id: id, category_name: name });
  }
  return result;
}

function activeMediaRows(job, items, itemType) {
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    const externalId = String(item.stream_id ?? item.series_id ?? item.id ?? "").normalize("NFC").trim();
    const title = String(item.name ?? item.title ?? "").normalize("NFC").trim();
    if (!externalId || !title || externalId.length > 1200 || title.length > 2000 || /[\u0000-\u001f\u007f]/u.test(externalId + title)) {
      throw new WorkerFault("invalid_payload", false);
    }
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const categoryId = nullableString(item.category_id ?? item.categoryId);
    const categoryName = nullableString(item.category_name ?? item.categoryName);
    const providerTmdbId = nullableString(item.tmdb_id ?? item.tmdbId ?? item.tmdb);
    const providerImdbId = nullableString(item.imdb_id ?? item.imdbId ?? item.imdb);
    const container = nullableString(item.container_extension) || (itemType === "live" ? "ts" : "mp4");
    rows.push({
      item_type: itemType, external_id: externalId, parent_external_id: categoryId,
      title, subtitle: categoryName, poster_url: nullableString(item.stream_icon ?? item.cover), backdrop_url: null,
      metadata: compactActiveRecord({ categoryId, categoryName, rating: item.rating, added: item.added,
        overview: nullableString(item.plot ?? item.description ?? item.overview ?? item.desc), providerTmdbId, providerImdbId }),
      playback_hint: compactActiveRecord({ sourceType: "xtream", streamId: externalId, streamType: itemType,
        container, containerExplicit: Boolean(nullableString(item.container_extension)), providerTmdbId, providerImdbId }),
      available: true,
    });
  }
  return rows;
}

function activeTitlePayload(job, mediaRows) {
  const titles = new Map();
  const languages = new Map();
  const syncedAt = new Date().toISOString();
  for (const media of mediaRows) {
    const metadata = rpcObject(media.metadata ?? {});
    const tmdb = nullableString(metadata.providerTmdbId);
    const imdb = nullableString(metadata.providerImdbId);
    const normalized = normalizedTitleIdentity(media.title);
    const identity = tmdb ? { key: `tmdb:${tmdb}`, source: "provider_tmdb" }
      : imdb ? { key: `imdb:${imdb}`, source: "provider_imdb" }
        : { key: `norm:${normalized}`, source: "normalized" };
    if (!titles.has(identity.key)) {
      titles.set(identity.key, {
        user_id: job.userId, item_type: media.item_type, identity_key: identity.key,
        identity_source: identity.source, provider_tmdb_id: tmdb, provider_imdb_id: imdb,
        match_status: tmdb || imdb ? "provider_unverified" : "unmatched",
        title: media.title, original_title: media.title,
        release_year: activeReleaseYear(media.title, metadata.year ?? metadata.releaseYear ?? metadata.release_date),
        poster_url: media.poster_url, backdrop_url: media.backdrop_url,
        metadata: compactActiveRecord({ ...metadata, identityKey: identity.key, identitySource: identity.source, projectionVersion: 3 }),
        synced_at: syncedAt, version_languages: [],
      });
    }
    const language = activeLanguageTag(media.title);
    if (language) {
      const values = languages.get(identity.key) ?? new Set();
      values.add(language);
      languages.set(identity.key, values);
    }
  }
  for (const [identityKey, title] of titles) {
    title.version_languages = [...(languages.get(identityKey) ?? [])].sort();
  }
  return [...titles.values()];
}

function activeTitleVariants(mediaRows, mediaResult, titleResult) {
  const mediaIds = activeMediaIdMap(mediaResult);
  const titleIds = new Map();
  for (const title of arrayRecordField(titleResult, "titles")) {
    const key = nullableString(title.identityKey ?? title.identity_key);
    const id = nullableString(title.titleId ?? title.title_id);
    if (key && id) titleIds.set(key, id);
  }
  const variants = [];
  for (const media of mediaRows) {
    const metadata = rpcObject(media.metadata ?? {});
    const tmdb = nullableString(metadata.providerTmdbId);
    const imdb = nullableString(metadata.providerImdbId);
    const identityKey = tmdb ? `tmdb:${tmdb}` : imdb ? `imdb:${imdb}` : `norm:${normalizedTitleIdentity(media.title)}`;
    const mediaItemId = mediaIds.get(`${media.item_type}:${media.external_id}`);
    const titleId = titleIds.get(identityKey);
    if (!mediaItemId || !titleId) throw new WorkerFault("catalog_unhealthy", false);
    const hint = rpcObject(media.playback_hint ?? {});
    const version = activeVersionInfo(media.title);
    variants.push({
      title_id: titleId, media_item_id: mediaItemId, item_type: media.item_type, external_id: media.external_id,
      raw_title: media.title, label: version.label, language: version.language, quality: version.quality,
      resolution: version.resolution, container_extension: nullableString(hint.container), poster_url: media.poster_url,
      playback_hint: hint, codec_profile: rpcObject(metadata.codecProfile ?? metadata.codec_profile ?? {}),
      compatibility_tier: "unknown", playback_cost_score: 500, last_observed_ttff_ms: null,
      observed_success_rate: null, metadata: compactActiveRecord({ ...metadata, identityKey }),
    });
  }
  return variants;
}

function activeTitleConfirmations(titleResult) {
  return arrayRecordField(titleResult, "titles").map((title) => ({
    itemType: String(title.itemType ?? title.item_type ?? ""),
    identityKey: String(title.identityKey ?? title.identity_key ?? ""),
    titleId: String(title.titleId ?? title.title_id ?? ""),
    payloadUpdatedAt: String(title.payloadUpdatedAt ?? title.payload_updated_at ?? ""),
  }));
}

function activeLivePayload(job, mediaRows, mediaResult) {
  const mediaIds = activeMediaIdMap(mediaResult);
  const channels = new Map();
  const variants = [];
  const now = new Date().toISOString();
  for (const media of mediaRows) {
    const metadata = rpcObject(media.metadata ?? {});
    const hint = rpcObject(media.playback_hint ?? {});
    const categoryId = nullableString(metadata.categoryId) ?? "uncategorized";
    const categoryName = nullableString(metadata.categoryName) ?? "Uncategorized";
    const logicalId = `xtream:${media.external_id}`;
    const mediaItemId = mediaIds.get(`live:${media.external_id}`);
    if (!mediaItemId) throw new WorkerFault("catalog_unhealthy", false);
    if (!channels.has(logicalId)) {
      channels.set(logicalId, {
        logical_id: logicalId, logical_key: logicalId, title: media.title, lcn: null, section: "other",
        category_id: categoryId, category_name: categoryName, poster_url: media.poster_url, stream_icon: media.poster_url,
        default_stream_id: media.external_id, variant_count: 1, default_variant: {}, variant_preview: [],
        playback_hint: hint, metadata, synced_at: now,
      });
    }
    variants.push({
      logical_id: logicalId, media_item_id: mediaItemId, stream_id: String(hint.streamId ?? media.external_id),
      external_id: media.external_id, label: "HD", rank: 2, health_rank: 1, title: media.title, raw_title: media.title,
      category_id: categoryId, category_name: categoryName, poster_url: media.poster_url, stream_icon: media.poster_url,
      playback_hint: hint, metadata, container_extension: nullableString(hint.container), synced_at: now,
    });
  }
  return { channels: [...channels.values()], variants };
}

function activeMediaIdMap(mediaResult) {
  const ids = new Map();
  for (const item of arrayRecordField(mediaResult, "items")) {
    const type = nullableString(item.itemType ?? item.item_type);
    const externalId = nullableString(item.externalId ?? item.external_id);
    const id = nullableString(item.mediaItemId ?? item.media_item_id);
    if (!type || !externalId || !id) throw new WorkerFault("catalog_unhealthy", false);
    ids.set(`${type}:${externalId}`, id);
  }
  return ids;
}

function arrayRecordField(value, field) {
  const raw = value[field];
  if (!Array.isArray(raw) || raw.some((row) => !isRecord(row))) throw new WorkerFault("catalog_unhealthy", false);
  return raw;
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize("NFC").trim();
  return text && text.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

function compactActiveRecord(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function normalizedTitleIdentity(value) {
  const normalized = String(value).normalize("NFKD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-");
  if (!normalized || normalized.length > 1000) throw new WorkerFault("invalid_payload", false);
  return normalized;
}

function activeReleaseYear(title, explicit) {
  const candidate = nullableString(explicit) ?? (String(title).match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1] ?? null);
  if (!candidate || !/^(?:19|20)\d{2}$/.test(candidate)) return null;
  const year = Number(candidate);
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1 ? year : null;
}

function activeLanguageTag(title) {
  const match = String(title).toLowerCase().match(/\b(vostfr|truefrench|french|multi|vfq|vff|vf|vo)\b/);
  return match ? match[1] : null;
}

function activeVersionInfo(title) {
  const raw = String(title);
  const resolution = raw.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1]?.toUpperCase() ?? null;
  const language = activeLanguageTag(raw);
  return { label: resolution ?? language ?? "HD", language, quality: resolution, resolution };
}

async function restoreAfterPostSwitchFailure(job, workerId, fault) {
  const head = await getSourceCatalogHead(job);
  await workerRpc("norva_restore_previous_credential_config", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_expected_transition_revision: job.transitionRevision,
    p_expected_source_revision: job.expectedSourceRevision,
    p_expected_head_revision: head.headRevision,
    p_reason_code: fault.queueCode === "auth_rejected"
      ? "candidate_auth_rejected"
      : fault.queueCode === "invalid_payload" || fault.queueCode === "catalog_unhealthy"
        ? "candidate_catalog_unhealthy"
        : "candidate_refresh_failed",
  });
}

async function verifyRollbackJob(job, workerId) {
  const runtime = await getRuntimeConfig();
  const previousConfig = await decryptSourceConfig(
    await readTransitionSecret(job, "previous"),
    runtime.sourceConfigKey,
  );
  await assertProviderReadAllowed(job, previousConfig);
  assertAuthenticatedAccount(await gatewayAccountInfo(runtime, previousConfig, job));
  const head = await getSourceCatalogHead(job);
  await workerRpc("norva_finish_credential_compensation", {
    p_transition_id: job.transitionId,
    p_user_id: job.userId,
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_lease_sequence: job.leaseSequence,
    p_expected_transition_revision: job.transitionRevision,
    p_expected_head_revision: head.headRevision,
    p_refresh_proof_id: crypto.randomUUID(),
  });
  return "handled";
}

async function getSourceCatalogHead(job) {
  const value = await workerRpc("norva_get_source_catalog_head", {
    p_user_id: job.userId,
    p_source_id: job.sourceId,
  });
  if (!isRecord(value)) throw new WorkerFault("internal_error", false);
  return {
    activeGenerationId: uuidValue(value.activeGenerationId ?? value.active_generation_id, true),
    headRevision: nonNegativeInteger(value.headRevision ?? value.head_revision, "INVARIANT_VIOLATION"),
  };
}

async function gatewayAccountInfo(runtime, config, job = null) {
  if (!runtime.mediaGatewayUrl || !runtime.mediaGatewayToken) throw new WorkerFault("provider_unavailable", true);
  if (job && typeof assertProviderReadAllowed === "function") {
    await assertProviderReadAllowed(job, config);
  }
  return gatewayRequestJson(runtime, "/xtream/metadata", {
    serverUrl: config.serverUrl,
    username: config.username,
    password: config.password,
    action: "account_info",
    params: {},
    userAgent: "NorvaProviderAccess/1.0",
  }, MAX_GATEWAY_ACCOUNT_BYTES);
}

async function assertProviderReadAllowed(job, config) {
  const nowIso = new Date().toISOString();
  const { data: sessions, error: sessionError } = await admin
    .from("cloud_playback_sessions")
    .select("id")
    .eq("user_id", job.userId)
    .in("status", ["pending", "ready"])
    .gt("expires_at", nowIso)
    .limit(1);
  if (sessionError) throw new WorkerFault("internal_error", false);
  if (Array.isArray(sessions) && sessions.length) throw new WorkerFault("rate_limited", true);

  const accountKey = providerAccountActivityKey(config);
  const { data: busy, error: busyError } = await admin.rpc("provider_account_busy", { p_key: accountKey });
  if (busyError) throw new WorkerFault("internal_error", false);
  if (busy !== false) throw new WorkerFault("rate_limited", true);
}

function providerAccountActivityKey(config) {
  try {
    const host = new URL(config.serverUrl).host.toLowerCase();
    const username = String(config.username ?? "");
    // Leading/trailing spaces can be significant Xtream username bytes. Use
    // trimming only to reject an empty logical username, never to derive the
    // account-affinity key persisted by SQL and shared with the Gateway.
    const key = host && username.trim() ? `${host}/${username}` : "";
    if (!key || key.length > 300 || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error("invalid");
    return key;
  } catch (_) {
    throw new WorkerFault("invalid_payload", false);
  }
}

async function credentialAccountAffinityHash(config) {
  // This service-only digest lets SQL keep provider activity affinity stable
  // across an atomic config/hint swap without persisting the username. It is
  // deliberately separate from the HMAC request fingerprint above: gateway
  // activity calls submit the same canonical key and SQL hashes it internally.
  const key = providerAccountActivityKey(config);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  )));
}

async function gatewayMetadataPage(runtime, config, job, generationId, request) {
  if (!GATEWAY_PAGE_ACTIONS.includes(request.action)
      || !Number.isInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 500) {
    throw new WorkerFault("invalid_payload", false);
  }
  const categoryId = request.categoryId === null || request.categoryId === undefined
    ? null
    : String(request.categoryId);
  // A claimed lease is deliberately not authority to emit provider I/O.  This
  // re-check is immediately adjacent to every network request, including a
  // resumed gateway spool page after an account/source deletion fence.
  // `gatewayMetadataPage` is also extracted into a small contract-test
  // sandbox.  `typeof` keeps that isolated parser test from needing the whole
  // worker module; in the deployed module the lexical guard is always present.
  if (typeof assertProviderReadAllowed === "function") {
    await assertProviderReadAllowed(job, config);
  }
  const spoolKey = await keyedFingerprint(runtime.sourceConfigKey, {
    operation: "credential_catalog_gateway_spool",
    transitionId: job.transitionId,
    generationId,
    action: request.action,
    categoryId,
  });
  const payload = await gatewayRequestJson(runtime, "/xtream/metadata-page", {
    serverUrl: config.serverUrl,
    username: config.username,
    password: config.password,
    action: request.action,
    params: categoryId === null ? {} : { category_id: categoryId },
    cursor: request.cursor ?? null,
    spoolToken: request.spoolToken ?? null,
    spoolKey,
    maxItems: request.maxItems,
    userAgent: "NorvaProviderAccess/1.0",
  }, MAX_GATEWAY_PAGE_BYTES);
  if (payload.gatewayPending === true) {
    return {
      items: [],
      done: false,
      pending: true,
      retryAfterSeconds: payload.retryAfterSeconds,
      nextCursor: null,
      spoolToken: null,
    };
  }
  return payload;
}

async function gatewayRequestJson(runtime, pathName, body, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${runtime.mediaGatewayUrl}${pathName}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.mediaGatewayToken}`,
      },
      body: JSON.stringify(body),
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new WorkerFault("invalid_payload", false);
    }
    const payload = await readBoundedGatewayJson(response, maxBytes);
    if (response.status === 202) {
      const cursor = boundedGatewayCursor(payload.cursor);
      const spoolToken = boundedGatewayCursor(payload.spoolToken ?? payload.cursor);
      const retryAfterSeconds = boundedGatewayRetryAfter(
        payload.retryAfterSeconds ?? response.headers.get("Retry-After"),
      );
      if (payload.code !== "catalog_spool_building" || !cursor || !spoolToken) {
        throw new WorkerFault("invalid_payload", false);
      }
      return { gatewayPending: true, retryAfterSeconds };
    }
    if (!response.ok) {
      throw gatewayFailureForResponse(response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof WorkerFault) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new WorkerFault("network_timeout", true);
    throw new WorkerFault("provider_unavailable", true);
  } finally {
    clearTimeout(timer);
  }
}

function boundedGatewayRetryAfter(value) {
  const seconds = typeof value === "string" && /^[0-9]{1,2}$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new WorkerFault("invalid_payload", false);
  }
  return seconds;
}

function gatewayFailureForResponse(status, payload) {
  const rawCode = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
  const code = GATEWAY_SAFE_ERROR_CODES.has(rawCode) ? rawCode : "";
  // The gateway middleware emits 401/503 without a typed provider code. Treat
  // those as a service invariant, never as rejected customer credentials.
  if (!code) return new WorkerFault("internal_error", false);
  if (code === "PROVIDER_REQUEST_FAILED" && [401, 403].includes(status)) {
    return new WorkerFault("auth_rejected", false, "CANDIDATE_CREDENTIALS_REJECTED");
  }
  if (code === "PROXY_AUTH_FAILED") {
    return new WorkerFault("provider_unavailable", true);
  }
  if ([
    "PROVIDER_BUSY",
    "PROVIDER_MULTI_IP",
    "PROVIDER_RATE_LIMIT",
    "account_busy",
    "background_busy",
    "viewer_preempted",
  ].includes(code) || status === 458) {
    return new WorkerFault("rate_limited", true);
  }
  if (code === "catalog_cursor_stale") {
    return new WorkerFault("catalog_changed_during_build", false);
  }
  if (["invalid_catalog_params", "invalid_egress_target"].includes(code)
      || (code === "PROVIDER_REQUEST_FAILED" && status < 500)) {
    return new WorkerFault("invalid_payload", false);
  }
  return new WorkerFault("provider_unavailable", true);
}

function boundedGatewayCursor(value) {
  if (typeof value !== "string") return null;
  const cursor = value.trim();
  if (!cursor || cursor.length > 512 || /[\u0000-\u001f\u007f]/u.test(cursor)) return null;
  return cursor;
}

async function readBoundedGatewayJson(response, maxBytes) {
  if (!response.body) throw new WorkerFault("invalid_payload", false);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WorkerFault("invalid_payload", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed;
  } catch (_) {
    throw new WorkerFault("invalid_payload", false);
  }
}

function assertAuthenticatedAccount(payload) {
  const account = isRecord(payload) && isRecord(payload.user_info) ? payload.user_info : null;
  const authenticated = account && [1, "1", true, "true"].includes(account.auth);
  const status = String(account?.status ?? "").trim().toLowerCase();
  if (!authenticated || ["disabled", "banned", "expired"].includes(status)) {
    throw new WorkerFault("auth_rejected", false, "CANDIDATE_CREDENTIALS_REJECTED");
  }
}

async function workerRpc(name, params) {
  const { data, error } = await admin.rpc(name, params);
  // Every durable writer expresses a lost CAS/lease as serialization failure.
  // It is not evidence that candidate credentials are bad and must never take
  // the compensation branch; a later claim either resumes from PostgreSQL or
  // finds that the transition is terminal/cancelled.
  if (error?.code === "40001") throw new WorkerFault("stale", true);
  if (error) throw new WorkerFault("internal_error", false);
  if (data === null || data === undefined) throw new WorkerFault("internal_error", false);
  return data;
}

async function settleJob(job, workerId, outcome, errorCode, retryAfterSeconds) {
  const { error } = await admin.rpc("norva_settle_credential_transition_job", {
    p_job_id: job.jobId,
    p_worker: workerId,
    p_expected_attempt: job.leaseSequence,
    p_outcome: outcome,
    p_error_code: errorCode,
    p_retry_after_seconds: retryAfterSeconds,
  });
  return !error;
}

function normalizeWorkerFault(error) {
  if (error instanceof WorkerFault) return error;
  return new WorkerFault("internal_error", false);
}

function retryDelaySeconds(attempt) {
  return Math.min(3600, 30 * (2 ** Math.min(7, Math.max(0, attempt - 1))));
}

function scheduleWorkerAcceleration() {
  // The SQL queue is the source of truth. waitUntil deliberately does not run
  // the job itself; an authorized scheduler/worker drains it independently.
  const edgeRuntime = globalThis.EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(Promise.resolve());
}

async function readJsonObject(req) {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) throw new ContractError("INVALID_REQUEST");
  const text = await req.text();
  if (encoder.encode(text).byteLength > MAX_JSON_BYTES) throw new ContractError("INVALID_REQUEST");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed;
  } catch (_) {
    throw new ContractError("INVALID_REQUEST");
  }
}

function successResponse(req, requestId, kind, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify({ apiVersion: API_VERSION, kind, requestId, data }), {
    status,
    headers: responseHeaders(req, extraHeaders),
  });
}

function errorResponse(req, requestId, error) {
  return new Response(JSON.stringify({
    apiVersion: API_VERSION,
    requestId,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  }), {
    status: error.status,
    headers: responseHeaders(req),
  });
}

function normalizePublicError(error) {
  if (error instanceof ContractError) return error;
  return new ContractError("INVARIANT_VIOLATION");
}

function responseHeaders(req, extra = {}) {
  return {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin, Authorization",
    ...extra,
  };
}

function corsHeaders(req) {
  const origin = req.headers.get("Origin") ?? "";
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://norva.tv,https://app.norva.tv")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  const allowOrigin = configured.includes(origin) ? origin : configured[0] ?? "https://norva.tv";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": [
      "Authorization", "Content-Type", CONTRACT_HEADER, "Idempotency-Key", "If-Match",
      "X-Norva-Worker-Token", "X-Request-Id",
    ].join(", "),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "ETag, Location",
  };
}

function requestIdentifier(req) {
  const supplied = req.headers.get("X-Request-Id") ?? "";
  return UUID_RE.test(supplied) ? supplied : crypto.randomUUID();
}

function uuidValue(value, worker = false) {
  const text = String(value ?? "");
  if (!UUID_RE.test(text)) {
    if (worker) throw new WorkerFault("invalid_payload", false);
    throw new ContractError("INVARIANT_VIOLATION");
  }
  return text.toLowerCase();
}

function nullableWorkerUuid(value) {
  if (value === null || value === undefined || value === "") return null;
  return uuidValue(value, true);
}

function enumValue(value, allowed, code) {
  const normalized = String(value ?? "").toUpperCase();
  if (!allowed.includes(normalized)) throw new ContractError(code);
  return normalized;
}

function nullableEnum(value, allowed) {
  if (value === null || value === undefined || value === "") return null;
  return enumValue(value, allowed, "INVARIANT_VIOLATION");
}

function nonNegativeInteger(value, code) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new ContractError(code);
  return number;
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return nonNegativeInteger(value, "INVARIANT_VIOLATION"); } catch (_) { return null; }
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeMachineCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).toUpperCase();
  return SAFE_CODE_RE.test(normalized) ? normalized : null;
}

function normalizedExternalId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).normalize("NFC").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let diff = a.byteLength ^ b.byteLength;
  const length = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index % Math.max(1, a.byteLength)] ?? 0) ^ (b[index % Math.max(1, b.byteLength)] ?? 0);
  }
  return diff === 0;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (_) {
    return new Uint8Array();
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}
