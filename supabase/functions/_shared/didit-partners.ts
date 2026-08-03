import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualText,
} from "./partners-crypto.ts";

export const DIDIT_CREATE_SESSION_URL =
  "https://verification.didit.me/v3/session/";
export const DIDIT_LIST_SESSIONS_URL =
  "https://verification.didit.me/v3/sessions/";
export const DIDIT_PARTNERS_CALLBACK_URL =
  "https://norva.tv/partners-kyc-return";
export const DIDIT_WEBHOOK_MAX_AGE_SECONDS = 300;
export const DIDIT_WEBHOOK_MAX_BYTES = 2 * 1_024 * 1_024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;
const ISO3_PATTERN = /^[A-Z]{3}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIDIT_HOSTED_URL_PATTERN = /^https:\/\/verify\.didit\.me\//;
const DIDIT_VENDOR_DATA_PATTERN = /^(?:kyr|kcf)_[0-9a-f]{24}$/;
const DIDIT_CERTIFICATION_CONSENT_VERSION = "partners-didit-certification-v1";
const DIDIT_CERTIFICATION_CONFIRMATION = "CERTIFIER DIDIT";

export type DiditStatus =
  | "not_started"
  | "in_progress"
  | "approved"
  | "declined"
  | "in_review"
  | "expired"
  | "abandoned"
  | "kyc_expired"
  | "resubmitted"
  | "awaiting_user";

export type DiditConfig = {
  apiKey: string;
  workflowId: string;
  applicationId: string;
  environment: "live" | "sandbox";
  sessionExpirationSeconds: number;
  webhookSecret: string;
  callbackUrl: string;
  idVerificationNodeId: string;
  livenessNodeId: string;
  faceMatchNodeId: string;
};

export type KycSessionInput = {
  language: string;
  consentVersion: string;
  consentGranted: true;
  capacityConfirmed: true;
};

export type KycCertificationInput = {
  language: string;
  consentVersion: typeof DIDIT_CERTIFICATION_CONSENT_VERSION;
  consentGranted: true;
  capacityConfirmed: true;
  confirmation: typeof DIDIT_CERTIFICATION_CONFIRMATION;
  justification: string;
};

export type DiditCreatedSession = {
  sessionId: string;
  workflowId: string;
  workflowVersion: number;
  providerStatus: DiditStatus;
  hostedUrl: string;
};

export type DiditActiveSession = {
  sessionId: string;
  workflowId: string;
  providerStatus:
    | "not_started"
    | "in_progress"
    | "resubmitted"
    | "awaiting_user";
  hostedUrl: string;
};

export type DiditSessionListInspection =
  | { kind: "empty" }
  | { kind: "active"; session: DiditActiveSession };

export type DiditCreateErrorKind =
  | "credits_unavailable"
  | "rate_limited"
  | "other";

export type DiditWebhookResult = {
  providerEventId: string;
  providerSessionId: string;
  providerWorkflowId: string;
  providerWorkflowVersion: number;
  providerEnvironment: "live" | "sandbox";
  providerConfigFingerprint: string;
  providerStatus: DiditStatus;
  eventCreatedAt: string;
  documentAge: number | null;
  documentCountryIso3: string | null;
  idCheckApproved: boolean;
  livenessApproved: boolean;
  faceMatchApproved: boolean;
  payloadHash: string;
};

export type KycPrepareResult = {
  schema_version: 1;
  action: "kyc_ready";
  replayed: boolean;
  account: {
    id: string;
    status: "pending_verification";
  };
  kyc: {
    provider: "didit";
    readiness: "ready";
    minimum_age: number;
    country_code: string;
    capacity_required: boolean;
    reservation_key: string;
  };
};

export type KycWebhookRpcResult =
  | {
    schema_version: 1;
    action: "kyc_result_applied";
    replayed: boolean;
    account: { id: string; status: string };
    kyc: { status: string; verified_at: string | null };
  }
  | {
    schema_version: 1;
    action: "kyc_result_observed";
    replayed: boolean;
    environment: "sandbox";
    reason: "sandbox_non_authoritative";
  }
  | {
    schema_version: 1;
    action: "kyc_result_quarantined";
    replayed: boolean;
    environment: "live" | "sandbox";
    reason:
      | "legacy_provider_binding"
      | "provider_environment_mismatch"
      | "provider_config_mismatch";
  };

export type KycCertificationPrepareResult = {
  schema_version: 1;
  action: "kyc_certification_reserved";
  replayed: boolean;
  certification: {
    key: string;
    status: "reserved" | "pending";
    expires_at: string;
  };
};

export type KycCertificationCreateClaimResult = {
  schema_version: 1;
  action: "kyc_certification_create_claimed";
  claimed: boolean;
  certification: {
    status: "reserved";
    expires_at: string;
    provider_create_dispatched_at: string;
  };
};

export type KycCertificationWebhookRpcResult = {
  schema_version: 1;
  action:
    | "kyc_certification_result_applied"
    | "kyc_certification_result_quarantined";
  replayed: boolean;
  certification: {
    status:
      | "pending"
      | "in_review"
      | "approved"
      | "declined"
      | "expired"
      | "quarantined"
      | "revoked";
    verified: boolean;
    reason?:
      | "provider_environment_mismatch"
      | "provider_config_mismatch"
      | "provider_workflow_mismatch"
      | "approved_checks_incomplete"
      | "stale_event"
      | "binding_conflict";
  };
};

export class DiditContractError extends Error {
  constructor(message = "Invalid Didit contract") {
    super(message);
    this.name = "DiditContractError";
  }
}

export class DiditSessionNotResumableError extends DiditContractError {
  constructor() {
    super("Didit session is not resumable");
    this.name = "DiditSessionNotResumableError";
  }
}

export class DiditPayloadTooLargeError extends Error {
  constructor() {
    super("Didit webhook payload exceeds the bounded reader limit");
    this.name = "DiditPayloadTooLargeError";
  }
}

export async function readDiditWebhookBody(
  request: Request,
  maxBytes = DIDIT_WEBHOOK_MAX_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new DiditContractError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("payload_too_large");
        } catch {
          // The size verdict is authoritative even if upstream cancellation
          // itself races a closed transport.
        }
        throw new DiditPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already have released its lock.
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedDiditResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return null;
  }
  const declared = response.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try {
      await response.body.cancel("provider_response_body_too_large");
    } catch {
      // The bounded verdict remains authoritative.
    }
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("provider_response_body_too_large");
        } catch {
          // The bounded verdict remains authoritative.
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted response may already have released its lock.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function loadDiditConfig(
  get: (name: string) => string | undefined,
): DiditConfig | null {
  const raw = {
    apiKey: get("DIDIT_API_KEY"),
    workflowId: get("DIDIT_WORKFLOW_ID"),
    applicationId: get("DIDIT_APPLICATION_ID"),
    environment: get("DIDIT_ENVIRONMENT"),
    sessionExpirationSeconds: get("DIDIT_SESSION_EXPIRATION_SECONDS"),
    webhookSecret: get("DIDIT_WEBHOOK_SECRET"),
    callbackUrl: get("DIDIT_CALLBACK_URL"),
    idVerificationNodeId: get("DIDIT_ID_VERIFICATION_NODE_ID"),
    livenessNodeId: get("DIDIT_LIVENESS_NODE_ID"),
    faceMatchNodeId: get("DIDIT_FACE_MATCH_NODE_ID"),
  };
  if (Object.values(raw).some((value) => !value)) return null;

  const callbackUrl = parseCallbackUrl(raw.callbackUrl!);
  const sessionExpirationSeconds = Number(raw.sessionExpirationSeconds);
  if (
    !isBoundedSecret(raw.apiKey!, 512, 16) ||
    !UUID_PATTERN.test(raw.workflowId!) ||
    !UUID_PATTERN.test(raw.applicationId!) ||
    (raw.environment !== "live" && raw.environment !== "sandbox") ||
    !/^\d{4,7}$/.test(raw.sessionExpirationSeconds!) ||
    !Number.isSafeInteger(sessionExpirationSeconds) ||
    String(sessionExpirationSeconds) !== raw.sessionExpirationSeconds ||
    sessionExpirationSeconds < 3_600 ||
    sessionExpirationSeconds > 2_419_200 ||
    !isBoundedSecret(raw.webhookSecret!, 512, 16) ||
    !NODE_ID_PATTERN.test(raw.idVerificationNodeId!) ||
    !NODE_ID_PATTERN.test(raw.livenessNodeId!) ||
    !NODE_ID_PATTERN.test(raw.faceMatchNodeId!) ||
    new Set([
        raw.idVerificationNodeId,
        raw.livenessNodeId,
        raw.faceMatchNodeId,
      ]).size !== 3 ||
    !callbackUrl
  ) {
    return null;
  }

  return {
    apiKey: raw.apiKey!,
    workflowId: raw.workflowId!.toLowerCase(),
    applicationId: raw.applicationId!.toLowerCase(),
    environment: raw.environment,
    sessionExpirationSeconds,
    webhookSecret: raw.webhookSecret!,
    callbackUrl,
    idVerificationNodeId: raw.idVerificationNodeId!,
    livenessNodeId: raw.livenessNodeId!,
    faceMatchNodeId: raw.faceMatchNodeId!,
  };
}

/**
 * Binds a provider session to the non-secret Didit configuration that created
 * it. API and webhook secrets are deliberately excluded so routine secret
 * rotation does not invalidate an otherwise identical verification contract.
 */
export async function diditConfigFingerprint(
  config: DiditConfig,
  workflowVersion: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(workflowVersion) ||
    workflowVersion < 1 ||
    workflowVersion > 1_000_000
  ) {
    throw new DiditContractError();
  }
  return await diditBindingFingerprint({
    environment: config.environment,
    applicationId: config.applicationId,
    workflowId: config.workflowId,
    workflowVersion,
    callbackUrl: config.callbackUrl,
    idVerificationNodeId: config.idVerificationNodeId,
    livenessNodeId: config.livenessNodeId,
    faceMatchNodeId: config.faceMatchNodeId,
    sessionExpirationSeconds: config.sessionExpirationSeconds,
  });
}

async function diditBindingFingerprint(binding: {
  environment: "live" | "sandbox";
  applicationId: string;
  workflowId: string;
  workflowVersion: number;
  callbackUrl: string;
  idVerificationNodeId: string;
  livenessNodeId: string;
  faceMatchNodeId: string;
  sessionExpirationSeconds: number;
}): Promise<string> {
  return await sha256Hex([
    "norva:didit:config:v1",
    `sessions_api_url=${DIDIT_CREATE_SESSION_URL}`,
    "webhook_contract=status.updated:v1",
    `environment=${binding.environment}`,
    `application_id=${binding.applicationId}`,
    `workflow_id=${binding.workflowId}`,
    `workflow_version=${binding.workflowVersion}`,
    `callback_url=${binding.callbackUrl}`,
    `id_verification_node_id=${binding.idVerificationNodeId}`,
    `liveness_node_id=${binding.livenessNodeId}`,
    `face_match_node_id=${binding.faceMatchNodeId}`,
    `session_expiration_seconds=${binding.sessionExpirationSeconds}`,
  ].join("\n"));
}

export function parseKycSessionInput(
  raw: unknown,
): KycSessionInput {
  const body = exactRecord(raw, [
    "language",
    "consentVersion",
    "consentGranted",
    "capacityConfirmed",
  ]);
  if (
    typeof body.language !== "string" ||
    !LANGUAGE_PATTERN.test(body.language) ||
    typeof body.consentVersion !== "string" ||
    !VERSION_PATTERN.test(body.consentVersion) ||
    body.consentGranted !== true ||
    body.capacityConfirmed !== true
  ) {
    throw new DiditContractError();
  }
  return {
    language: body.language,
    consentVersion: body.consentVersion,
    consentGranted: true,
    capacityConfirmed: true,
  };
}

export function parseKycCertificationInput(
  raw: unknown,
): KycCertificationInput {
  const body = exactRecord(raw, [
    "language",
    "consentVersion",
    "consentGranted",
    "capacityConfirmed",
    "confirmation",
    "justification",
  ]);
  const rawJustification = typeof body.justification === "string"
    ? body.justification
    : "";
  const justification = rawJustification.replace(/^ +| +$/g, "");
  if (
    typeof body.language !== "string" ||
    !LANGUAGE_PATTERN.test(body.language) ||
    body.consentVersion !== DIDIT_CERTIFICATION_CONSENT_VERSION ||
    body.consentGranted !== true ||
    body.capacityConfirmed !== true ||
    body.confirmation !== DIDIT_CERTIFICATION_CONFIRMATION ||
    justification.length < 12 ||
    justification.length > 1_000 ||
    /[\u0000-\u001f\u007f]/.test(rawJustification)
  ) {
    throw new DiditContractError();
  }
  return {
    language: body.language,
    consentVersion: DIDIT_CERTIFICATION_CONSENT_VERSION,
    consentGranted: true,
    capacityConfirmed: true,
    confirmation: DIDIT_CERTIFICATION_CONFIRMATION,
    justification,
  };
}

export function sanitizeKycCertificationPrepareRpc(
  raw: unknown,
): KycCertificationPrepareResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "certification",
  ]);
  const certification = exactRecord(root.certification, [
    "key",
    "status",
    "expires_at",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_certification_reserved" ||
    typeof root.replayed !== "boolean" ||
    typeof certification.key !== "string" ||
    !/^kcf_[0-9a-f]{24}$/.test(certification.key) ||
    (certification.status !== "reserved" &&
      certification.status !== "pending") ||
    !isIsoTimestamp(certification.expires_at)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_certification_reserved",
    replayed: root.replayed,
    certification: {
      key: certification.key,
      status: certification.status,
      expires_at: certification.expires_at,
    },
  };
}

export function sanitizeKycCertificationCreateClaimRpc(
  raw: unknown,
): KycCertificationCreateClaimResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "claimed",
    "certification",
  ]);
  const certification = exactRecord(root.certification, [
    "status",
    "expires_at",
    "provider_create_dispatched_at",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_certification_create_claimed" ||
    typeof root.claimed !== "boolean" ||
    certification.status !== "reserved" ||
    !isIsoTimestamp(certification.expires_at) ||
    !isIsoTimestamp(certification.provider_create_dispatched_at)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_certification_create_claimed",
    claimed: root.claimed,
    certification: {
      status: "reserved",
      expires_at: certification.expires_at,
      provider_create_dispatched_at:
        certification.provider_create_dispatched_at,
    },
  };
}

export function sanitizeKycCertificationSessionRecordRpc(
  raw: unknown,
): {
  schema_version: 1;
  action: "kyc_certification_session_recorded";
  replayed: boolean;
  certification: {
    status: "pending" | "in_review";
    expires_at: string;
  };
} {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "certification",
  ]);
  const certification = exactRecord(root.certification, [
    "status",
    "expires_at",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_certification_session_recorded" ||
    typeof root.replayed !== "boolean" ||
    (certification.status !== "pending" &&
      certification.status !== "in_review") ||
    !isIsoTimestamp(certification.expires_at)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_certification_session_recorded",
    replayed: root.replayed,
    certification: {
      status: certification.status,
      expires_at: certification.expires_at,
    },
  };
}

export function sanitizeKycCertificationBindingMatchRpc(
  raw: unknown,
): {
  schema_version: 1;
  action: "kyc_certification_binding_matched";
  matched: true;
  certification: {
    status: "pending";
    expires_at: string;
  };
} {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "matched",
    "certification",
  ]);
  const certification = exactRecord(root.certification, [
    "status",
    "expires_at",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_certification_binding_matched" ||
    root.matched !== true ||
    certification.status !== "pending" ||
    !isIsoTimestamp(certification.expires_at)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_certification_binding_matched",
    matched: true,
    certification: {
      status: "pending",
      expires_at: certification.expires_at,
    },
  };
}

export function sanitizeKycCertificationWebhookRpc(
  raw: unknown,
): KycCertificationWebhookRpcResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "certification",
  ]);
  const quarantined = root.action ===
    "kyc_certification_result_quarantined";
  if (
    root.schema_version !== 1 ||
    typeof root.replayed !== "boolean" ||
    (!quarantined && root.action !== "kyc_certification_result_applied")
  ) {
    throw new DiditContractError();
  }
  const certification = exactRecord(
    root.certification,
    quarantined ? ["status", "verified", "reason"] : ["status", "verified"],
  );
  const statuses = new Set([
    "pending",
    "in_review",
    "approved",
    "declined",
    "expired",
    "quarantined",
    "revoked",
  ]);
  const reasons = new Set([
    "provider_environment_mismatch",
    "provider_config_mismatch",
    "provider_workflow_mismatch",
    "approved_checks_incomplete",
    "stale_event",
    "binding_conflict",
  ]);
  if (
    typeof certification.status !== "string" ||
    !statuses.has(certification.status) ||
    typeof certification.verified !== "boolean" ||
    (certification.verified && certification.status !== "approved") ||
    (!quarantined && certification.status === "quarantined") ||
    (quarantined &&
      (certification.status !== "quarantined" ||
        typeof certification.reason !== "string" ||
        !reasons.has(certification.reason)))
  ) {
    throw new DiditContractError();
  }
  if (quarantined) {
    return {
      schema_version: 1,
      action: "kyc_certification_result_quarantined",
      replayed: root.replayed,
      certification: {
        status: "quarantined",
        verified: false,
        reason: certification
          .reason as KycCertificationWebhookRpcResult["certification"][
            "reason"
          ],
      },
    };
  }
  return {
    schema_version: 1,
    action: "kyc_certification_result_applied",
    replayed: root.replayed,
    certification: {
      status: certification.status as Exclude<
        KycCertificationWebhookRpcResult["certification"]["status"],
        "quarantined"
      >,
      verified: certification.verified,
    },
  };
}

export function sanitizeKycPrepareRpc(raw: unknown): KycPrepareResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "account",
    "kyc",
  ]);
  const account = exactRecord(root.account, ["id", "status"]);
  const kyc = exactRecord(root.kyc, [
    "provider",
    "readiness",
    "minimum_age",
    "country_code",
    "capacity_required",
    "reservation_key",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_ready" ||
    typeof root.replayed !== "boolean" ||
    typeof account.id !== "string" ||
    !/^prt_[0-9a-f]{24}$/.test(account.id) ||
    account.status !== "pending_verification" ||
    kyc.provider !== "didit" ||
    kyc.readiness !== "ready" ||
    typeof kyc.minimum_age !== "number" ||
    !Number.isSafeInteger(kyc.minimum_age) ||
    kyc.minimum_age < 18 ||
    kyc.minimum_age > 99 ||
    typeof kyc.country_code !== "string" ||
    !/^[A-Z]{2}$/.test(kyc.country_code) ||
    typeof kyc.capacity_required !== "boolean" ||
    typeof kyc.reservation_key !== "string" ||
    !/^kyr_[0-9a-f]{24}$/.test(kyc.reservation_key)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_ready",
    replayed: root.replayed,
    account: {
      id: account.id,
      status: "pending_verification",
    },
    kyc: {
      provider: "didit",
      readiness: "ready",
      minimum_age: kyc.minimum_age,
      country_code: kyc.country_code,
      capacity_required: kyc.capacity_required,
      reservation_key: kyc.reservation_key,
    },
  };
}

export function sanitizeKycSessionRecordRpc(
  raw: unknown,
): {
  schema_version: 1;
  action: "kyc_session_recorded";
  replayed: boolean;
  kyc: { status: "pending"; expires_at: string | null };
} {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "kyc",
  ]);
  const kyc = exactRecord(root.kyc, ["status", "expires_at"]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_session_recorded" ||
    typeof root.replayed !== "boolean" ||
    kyc.status !== "pending" ||
    (
      kyc.expires_at !== null &&
      (
        typeof kyc.expires_at !== "string" ||
        kyc.expires_at.length > 40 ||
        !Number.isFinite(Date.parse(kyc.expires_at))
      )
    )
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_session_recorded",
    replayed: root.replayed,
    kyc: {
      status: "pending",
      expires_at: kyc.expires_at as string | null,
    },
  };
}

export function sanitizeKycWebhookRpc(
  raw: unknown,
): KycWebhookRpcResult {
  if (!isRecord(raw)) throw new DiditContractError();
  if (raw.action === "kyc_result_observed") {
    const root = exactRecord(raw, [
      "schema_version",
      "action",
      "replayed",
      "environment",
      "reason",
    ]);
    if (
      root.schema_version !== 1 ||
      typeof root.replayed !== "boolean" ||
      root.environment !== "sandbox" ||
      root.reason !== "sandbox_non_authoritative"
    ) {
      throw new DiditContractError();
    }
    return {
      schema_version: 1,
      action: "kyc_result_observed",
      replayed: root.replayed,
      environment: "sandbox",
      reason: "sandbox_non_authoritative",
    };
  }
  if (raw.action === "kyc_result_quarantined") {
    const root = exactRecord(raw, [
      "schema_version",
      "action",
      "replayed",
      "environment",
      "reason",
    ]);
    const reasons = new Set([
      "legacy_provider_binding",
      "provider_environment_mismatch",
      "provider_config_mismatch",
    ]);
    if (
      root.schema_version !== 1 ||
      typeof root.replayed !== "boolean" ||
      (root.environment !== "live" && root.environment !== "sandbox") ||
      typeof root.reason !== "string" ||
      !reasons.has(root.reason)
    ) {
      throw new DiditContractError();
    }
    return {
      schema_version: 1,
      action: "kyc_result_quarantined",
      replayed: root.replayed,
      environment: root.environment,
      reason: root.reason as
        | "legacy_provider_binding"
        | "provider_environment_mismatch"
        | "provider_config_mismatch",
    };
  }
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "account",
    "kyc",
  ]);
  const account = exactRecord(root.account, ["id", "status"]);
  const kyc = exactRecord(root.kyc, ["status", "verified_at"]);
  const accountStatuses = new Set([
    "pending_verification",
    "active",
    "held",
    "suspended",
    "closed",
  ]);
  const kycStatuses = new Set([
    "pending",
    "verified",
    "failed",
    "expired",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "kyc_result_applied" ||
    typeof root.replayed !== "boolean" ||
    typeof account.id !== "string" ||
    !/^prt_[0-9a-f]{24}$/.test(account.id) ||
    typeof account.status !== "string" ||
    !accountStatuses.has(account.status) ||
    typeof kyc.status !== "string" ||
    !kycStatuses.has(kyc.status) ||
    (
      kyc.verified_at !== null &&
      (
        typeof kyc.verified_at !== "string" ||
        kyc.verified_at.length > 40 ||
        !Number.isFinite(Date.parse(kyc.verified_at))
      )
    ) ||
    (kyc.status === "verified") !== (kyc.verified_at !== null)
  ) {
    throw new DiditContractError();
  }
  return {
    schema_version: 1,
    action: "kyc_result_applied",
    replayed: root.replayed,
    account: { id: account.id, status: account.status },
    kyc: { status: kyc.status, verified_at: kyc.verified_at as string | null },
  };
}

export function diditCreateBody(
  config: DiditConfig,
  vendorData: string,
  language: string,
): Record<string, unknown> {
  if (
    !DIDIT_VENDOR_DATA_PATTERN.test(vendorData) ||
    !LANGUAGE_PATTERN.test(language)
  ) {
    throw new DiditContractError();
  }
  // Intentionally omit contact_details, expected_details, metadata and all
  // images. Didit hosts collection; Norva supplies only an opaque stable
  // subject, workflow, return URL and UI language.
  return {
    workflow_id: config.workflowId,
    vendor_data: vendorData,
    callback: config.callbackUrl,
    callback_method: "completer",
    language,
  };
}

/**
 * Classifies only the two provider failures that have a stable public meaning.
 * The caller supplies an already byte-bounded body and must never log or
 * forward it. Every unrecognised shape deliberately collapses to `other`.
 */
export function classifyDiditCreateError(
  status: number,
  boundedBody: string | null,
): DiditCreateErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 402) return "credits_unavailable";
  if (
    status !== 400 ||
    typeof boundedBody !== "string" ||
    boundedBody.length === 0 ||
    boundedBody.length > 4_096
  ) {
    return "other";
  }

  try {
    const raw = JSON.parse(boundedBody);
    if (!isRecord(raw) || typeof raw.detail !== "string") return "other";
    const detail = raw.detail.trim();
    if (
      detail.length === 0 ||
      detail.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(detail)
    ) {
      return "other";
    }
    return /\byou (?:do not|don't) have enough credits\b/i.test(detail)
      ? "credits_unavailable"
      : "other";
  } catch {
    return "other";
  }
}

/**
 * Reduces Didit's PII-rich list response to the only fields needed to reopen
 * one already-bound hosted KYC session. The caller must byte-bound the JSON
 * before parsing it and must never log, persist or forward the raw response.
 */
export function inspectDiditSessionList(
  raw: unknown,
  config: DiditConfig,
  expectedVendorData: string,
): DiditSessionListInspection {
  if (!DIDIT_VENDOR_DATA_PATTERN.test(expectedVendorData)) {
    throw new DiditContractError();
  }
  const root = record(raw);
  if (
    root.count === 0 &&
    Array.isArray(root.results) &&
    root.results.length === 0
  ) {
    return { kind: "empty" };
  }
  if (
    typeof root.count === "number" &&
    Number.isSafeInteger(root.count) &&
    root.count > 1 &&
    Array.isArray(root.results)
  ) {
    throw new DiditSessionNotResumableError();
  }
  if (
    root.count !== 1 ||
    !Array.isArray(root.results) ||
    root.results.length !== 1
  ) {
    throw new DiditContractError();
  }

  const candidate = record(root.results[0]);
  const sessionKind = candidate.session_kind;
  const workflowType = typeof candidate.workflow_type === "string"
    ? candidate.workflow_type.trim().toLowerCase()
    : candidate.workflow_type;
  const explicitKyb = sessionKind === "business" ||
    workflowType === "business" || workflowType === "kyb" ||
    Object.hasOwn(candidate, "business_session_id") ||
    Object.hasOwn(candidate, "vendor_business_id") ||
    Object.hasOwn(candidate, "company_name") ||
    Object.hasOwn(candidate, "registration_number");
  if (
    explicitKyb ||
    (sessionKind !== undefined && sessionKind !== "user") ||
    (workflowType !== undefined && workflowType !== "user" &&
      workflowType !== "kyc") ||
    candidate.vendor_data !== expectedVendorData
  ) {
    throw new DiditContractError();
  }

  const sessionId = uuid(candidate.session_id);
  // Didit's documented List Sessions row shape may omit workflow_id even
  // when the request was filtered by that exact value. The URL filter is the
  // source of truth in that case; if the field is returned, it must still
  // match exactly so a contradictory provider response fails closed.
  const workflowId = candidate.workflow_id === undefined
    ? config.workflowId
    : uuid(candidate.workflow_id);
  const hostedUrl = diditHostedUrl(candidate.session_url);
  if (workflowId !== config.workflowId) throw new DiditContractError();

  const providerStatus = normalizeDiditStatus(candidate.status);
  if (
    providerStatus !== "not_started" &&
    providerStatus !== "in_progress" &&
    providerStatus !== "resubmitted" &&
    providerStatus !== "awaiting_user"
  ) {
    throw new DiditSessionNotResumableError();
  }
  return {
    kind: "active",
    session: {
      sessionId,
      workflowId,
      providerStatus,
      hostedUrl,
    },
  };
}

export function sanitizeDiditActiveSessionList(
  raw: unknown,
  config: DiditConfig,
  expectedVendorData: string,
): DiditActiveSession {
  const inspection = inspectDiditSessionList(
    raw,
    config,
    expectedVendorData,
  );
  if (inspection.kind !== "active") throw new DiditContractError();
  return inspection.session;
}

export function sanitizeDiditCreatedSession(
  raw: unknown,
  config: DiditConfig,
  expectedVendorData: string,
): DiditCreatedSession {
  if (!isRecord(raw)) throw new DiditContractError();
  const sessionId = uuid(raw.session_id);
  const workflowId = uuid(raw.workflow_id);
  const workflowVersion = positiveInteger(raw.workflow_version);
  const providerStatus = normalizeDiditStatus(raw.status);
  const hostedUrl = diditHostedUrl(raw.url);
  const sessionKind = raw.session_kind;

  if (
    // Didit's v3 OpenAPI response schema does not currently declare
    // session_kind, although newer KYC responses can include "user". Accept
    // that documented omission, but fail closed on every explicit KYB marker.
    (sessionKind !== undefined && sessionKind !== "user") ||
    Object.hasOwn(raw, "business_session_id") ||
    Object.hasOwn(raw, "vendor_business_id") ||
    workflowId !== config.workflowId ||
    raw.vendor_data !== expectedVendorData ||
    raw.callback !== config.callbackUrl ||
    ![
      "not_started",
      "in_progress",
      "resubmitted",
      "awaiting_user",
    ].includes(providerStatus)
  ) {
    throw new DiditContractError();
  }
  return {
    sessionId,
    workflowId,
    workflowVersion,
    providerStatus,
    hostedUrl,
  };
}

export async function verifyAndNormalizeDiditWebhook(
  rawBody: Uint8Array,
  headers: Headers,
  config: DiditConfig,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<DiditWebhookResult> {
  const { raw, timestamp } = await authenticateDiditWebhook(
    rawBody,
    headers,
    config,
    nowEpochSeconds,
  );

  if (
    raw.webhook_type !== "status.updated" ||
    raw.timestamp !== timestamp ||
    uuid(raw.application_id) !== config.applicationId ||
    (raw.environment !== "live" && raw.environment !== "sandbox") ||
    raw.session_kind === "business" ||
    Object.hasOwn(raw, "business_session_id")
  ) {
    throw new DiditContractError();
  }

  const providerStatus = normalizeDiditStatus(raw.status);
  const providerEventId = uuid(raw.event_id);
  const providerSessionId = uuid(raw.session_id);
  const providerWorkflowId = uuid(raw.workflow_id);
  const providerWorkflowVersion = positiveInteger(raw.workflow_version);
  const providerEnvironment = raw.environment;
  const createdAt = epochSeconds(raw.created_at);
  // Didit keeps event_id and the underlying event stable across delivery
  // retries, but refreshes the top-level dispatch timestamp and its signature.
  // Deduplicate on the complete signed semantic payload, excluding only that
  // transport timestamp. Session, application, environment, workflow,
  // created_at, status and the full decision remain bound to this hash.
  const payloadHash = await sha256Hex(
    stableDiditWebhookPayload(raw),
  );

  let documentAge: number | null = null;
  let documentCountryIso3: string | null = null;
  let idCheckApproved = false;
  let livenessApproved = false;
  let faceMatchApproved = false;
  let observedIdNodeId = config.idVerificationNodeId;
  let observedLivenessNodeId = config.livenessNodeId;
  let observedFaceNodeId = config.faceMatchNodeId;

  if (providerStatus === "approved") {
    const decision = isRecord(raw.decision) ? raw.decision : {};
    const idObservation = observedNodeResult(
      decision.id_verifications,
      config.idVerificationNodeId,
    );
    const livenessObservation = observedNodeResult(
      decision.liveness_checks,
      config.livenessNodeId,
    );
    const faceObservation = observedNodeResult(
      decision.face_matches,
      config.faceMatchNodeId,
    );
    observedIdNodeId = idObservation.bindingId;
    observedLivenessNodeId = livenessObservation.bindingId;
    observedFaceNodeId = faceObservation.bindingId;
    idCheckApproved = idObservation.result?.status === "Approved";
    livenessApproved = livenessObservation.result?.status === "Approved";
    faceMatchApproved = faceObservation.result?.status === "Approved";
    if (idCheckApproved) {
      try {
        documentAge = age(idObservation.result?.age);
        documentCountryIso3 = iso3(idObservation.result?.issuing_state);
      } catch {
        // A signed but structurally drifted decision must remain observable.
        // Force a divergent binding and let SQL quarantine it before policy.
        observedIdNodeId = "!invalid:identity-policy";
        idCheckApproved = false;
        documentAge = null;
        documentCountryIso3 = null;
      }
    }
  }
  const providerConfigFingerprint = await diditBindingFingerprint({
    environment: providerEnvironment,
    applicationId: config.applicationId,
    workflowId: providerWorkflowId,
    workflowVersion: providerWorkflowVersion,
    callbackUrl: config.callbackUrl,
    idVerificationNodeId: observedIdNodeId,
    livenessNodeId: observedLivenessNodeId,
    faceMatchNodeId: observedFaceNodeId,
    sessionExpirationSeconds: config.sessionExpirationSeconds,
  });

  return {
    providerEventId,
    providerSessionId,
    providerWorkflowId,
    providerWorkflowVersion,
    providerEnvironment,
    providerConfigFingerprint,
    providerStatus,
    eventCreatedAt: new Date(createdAt * 1_000).toISOString(),
    documentAge,
    documentCountryIso3,
    idCheckApproved,
    livenessApproved,
    faceMatchApproved,
    payloadHash,
  };
}

/**
 * Didit's console currently signs its test payload correctly but omits the
 * production event/application/environment/version envelope. A probe may be
 * acknowledged only when both the transport header and the signed JSON mark
 * it as a test, the configured workflow is exact, and every omitted
 * production-only field is genuinely absent. No decision from this shape is
 * ever persisted or treated as KYC evidence.
 */
export async function verifyDiditConsoleTestWebhook(
  rawBody: Uint8Array,
  headers: Headers,
  config: DiditConfig,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  const { raw, timestamp } = await authenticateDiditWebhook(
    rawBody,
    headers,
    config,
    nowEpochSeconds,
  );
  const metadata = isRecord(raw.metadata) ? raw.metadata : null;
  const productionEnvelopeFields = [
    "event_id",
    "application_id",
    "environment",
    "workflow_version",
  ];
  if (
    headers.get("X-Didit-Test-Webhook") !== "true" ||
    metadata?.test_webhook !== true ||
    productionEnvelopeFields.some((key) => Object.hasOwn(raw, key)) ||
    raw.webhook_type !== "status.updated" ||
    raw.timestamp !== timestamp ||
    uuid(raw.workflow_id) !== config.workflowId ||
    raw.session_kind === "business" ||
    Object.hasOwn(raw, "business_session_id") ||
    Object.hasOwn(raw, "vendor_business_id")
  ) {
    return false;
  }
  uuid(raw.session_id);
  normalizeDiditStatus(raw.status);
  epochSeconds(raw.created_at);
  return true;
}

async function authenticateDiditWebhook(
  rawBody: Uint8Array,
  headers: Headers,
  config: DiditConfig,
  nowEpochSeconds: number,
): Promise<{ raw: Record<string, unknown>; timestamp: number }> {
  if (
    rawBody.byteLength < 2 ||
    rawBody.byteLength > DIDIT_WEBHOOK_MAX_BYTES
  ) {
    throw new DiditContractError();
  }
  const timestampHeader = headers.get("X-Timestamp");
  const signatureV2 = headers.get("X-Signature-V2")?.toLowerCase() ?? "";
  const rawSignature = headers.get("X-Signature")?.toLowerCase() ?? "";
  if (
    !timestampHeader ||
    !/^\d{10}$/.test(timestampHeader) ||
    (
      !HEX_SHA256_PATTERN.test(signatureV2) &&
      !HEX_SHA256_PATTERN.test(rawSignature)
    )
  ) {
    throw new DiditContractError();
  }
  const timestamp = Number(timestampHeader);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowEpochSeconds - timestamp) > DIDIT_WEBHOOK_MAX_AGE_SECONDS
  ) {
    throw new DiditContractError();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new DiditContractError();
  }
  if (!isRecord(raw)) throw new DiditContractError();

  // Prefer Didit's middleware-safe v2 signature over recursively sorted,
  // compact, Unicode-preserved JSON. Retain the exact raw-body signature as a
  // fully authenticated fallback. The envelope-only signature variant is
  // deliberately never accepted because it does not authenticate the KYC
  // decision.
  let signatureVerified = false;
  if (HEX_SHA256_PATTERN.test(signatureV2)) {
    const expectedV2 = await hmacSha256Hex(
      config.webhookSecret,
      JSON.stringify(sortJsonValue(raw)),
    );
    signatureVerified = timingSafeEqualText(expectedV2, signatureV2);
  }
  if (!signatureVerified && HEX_SHA256_PATTERN.test(rawSignature)) {
    const expectedRaw = await hmacSha256Hex(
      config.webhookSecret,
      rawBody,
    );
    signatureVerified = timingSafeEqualText(expectedRaw, rawSignature);
  }
  if (!signatureVerified) throw new DiditContractError();
  return { raw, timestamp };
}

export function normalizeDiditStatus(value: unknown): DiditStatus {
  if (typeof value !== "string") throw new DiditContractError();
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "not_started":
    case "in_progress":
    case "approved":
    case "declined":
    case "in_review":
    case "expired":
    case "abandoned":
    case "kyc_expired":
    case "resubmitted":
    case "awaiting_user":
      return normalized;
    default:
      throw new DiditContractError();
  }
}

function observedNodeResult(
  value: unknown,
  nodeId: string,
): {
  bindingId: string;
  result: Record<string, unknown> | null;
} {
  if (!Array.isArray(value) || value.length === 0) {
    return { bindingId: "!missing", result: null };
  }
  if (value.length > 32) {
    return { bindingId: "!invalid:oversized", result: null };
  }
  const results: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.node_id !== "string" ||
      !NODE_ID_PATTERN.test(entry.node_id) ||
      typeof entry.status !== "string" ||
      !["Approved", "Declined", "In Review"].includes(entry.status)
    ) {
      return { bindingId: "!invalid", result: null };
    }
    results.push(entry);
  }
  const matches = results.filter((entry) => entry.node_id === nodeId);
  if (matches.length === 1) {
    return { bindingId: nodeId, result: matches[0] };
  }
  const observedIds = [
    ...new Set(
      results.map((entry) => String(entry.node_id)),
    ),
  ].sort();
  return {
    // "!" is forbidden by NODE_ID_PATTERN, so an unresolved observation can
    // never collide with a valid configured node identifier.
    bindingId: `!unmatched:${observedIds.join(",")}`,
    result: null,
  };
}

function stableDiditWebhookPayload(
  payload: Record<string, unknown>,
): string {
  const semanticPayload = { ...payload };
  delete semanticPayload.timestamp;
  return JSON.stringify(sortJsonValue(semanticPayload));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function parseCallbackUrl(value: string): string | null {
  if (value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.href === DIDIT_PARTNERS_CALLBACK_URL
      ? DIDIT_PARTNERS_CALLBACK_URL
      : null;
  } catch {
    return null;
  }
}

function diditHostedUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new DiditContractError();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DiditContractError();
  }
  if (
    !DIDIT_HOSTED_URL_PATTERN.test(url.href) ||
    url.username ||
    url.password ||
    url.protocol !== "https:"
  ) {
    throw new DiditContractError();
  }
  return url.href;
}

function isBoundedSecret(value: string, max: number, min: number): boolean {
  return (
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new DiditContractError();
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new DiditContractError();
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DiditContractError();
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new DiditContractError();
  }
  return value.toLowerCase();
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000_000
  ) {
    throw new DiditContractError();
  }
  return value;
}

function epochSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_577_836_800 ||
    value > 4_102_444_800
  ) {
    throw new DiditContractError();
  }
  return value;
}

function age(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 120
  ) {
    throw new DiditContractError();
  }
  return value;
}

function iso3(value: unknown): string {
  if (typeof value !== "string" || !ISO3_PATTERN.test(value)) {
    throw new DiditContractError();
  }
  return value;
}
