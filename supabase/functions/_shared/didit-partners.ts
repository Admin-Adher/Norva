import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualText,
} from "./partners-crypto.ts";

export const DIDIT_CREATE_SESSION_URL =
  "https://verification.didit.me/v3/session/";
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

export type DiditCreatedSession = {
  sessionId: string;
  workflowId: string;
  workflowVersion: number;
  providerStatus: DiditStatus;
  hostedUrl: string;
};

export type DiditWebhookResult = {
  providerEventId: string;
  providerSessionId: string;
  providerWorkflowId: string;
  providerWorkflowVersion: number;
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

export class DiditContractError extends Error {
  constructor(message = "Invalid Didit contract") {
    super(message);
    this.name = "DiditContractError";
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
    webhookSecret: get("DIDIT_WEBHOOK_SECRET"),
    callbackUrl: get("DIDIT_CALLBACK_URL"),
    idVerificationNodeId: get("DIDIT_ID_VERIFICATION_NODE_ID"),
    livenessNodeId: get("DIDIT_LIVENESS_NODE_ID"),
    faceMatchNodeId: get("DIDIT_FACE_MATCH_NODE_ID"),
  };
  if (Object.values(raw).some((value) => !value)) return null;

  const callbackUrl = parseCallbackUrl(raw.callbackUrl!);
  if (
    !isBoundedSecret(raw.apiKey!, 512, 16) ||
    !UUID_PATTERN.test(raw.workflowId!) ||
    !UUID_PATTERN.test(raw.applicationId!) ||
    (raw.environment !== "live" && raw.environment !== "sandbox") ||
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
    webhookSecret: raw.webhookSecret!,
    callbackUrl,
    idVerificationNodeId: raw.idVerificationNodeId!,
    livenessNodeId: raw.livenessNodeId!,
    faceMatchNodeId: raw.faceMatchNodeId!,
  };
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
): {
  schema_version: 1;
  action: "kyc_result_applied";
  replayed: boolean;
  account: { id: string; status: string };
  kyc: { status: string; verified_at: string | null };
} {
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
    !/^kyr_[0-9a-f]{24}$/.test(vendorData) ||
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

  if (
    raw.session_kind !== "user" ||
    workflowId !== config.workflowId ||
    raw.vendor_data !== expectedVendorData ||
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
  if (
    rawBody.byteLength < 2 ||
    rawBody.byteLength > DIDIT_WEBHOOK_MAX_BYTES
  ) {
    throw new DiditContractError();
  }
  const timestampHeader = headers.get("X-Timestamp");
  const signature = headers.get("X-Signature")?.toLowerCase() ?? "";
  if (
    !timestampHeader ||
    !/^\d{10}$/.test(timestampHeader) ||
    !HEX_SHA256_PATTERN.test(signature)
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
  const expectedSignature = await hmacSha256Hex(
    config.webhookSecret,
    rawBody,
  );
  if (!timingSafeEqualText(expectedSignature, signature)) {
    throw new DiditContractError();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new DiditContractError();
  }
  if (!isRecord(raw)) throw new DiditContractError();
  if (
    raw.webhook_type !== "status.updated" ||
    raw.timestamp !== timestamp ||
    uuid(raw.application_id) !== config.applicationId ||
    raw.environment !== config.environment ||
    uuid(raw.workflow_id) !== config.workflowId ||
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
  const createdAt = epochSeconds(raw.created_at);
  const payloadHash = await sha256Hex(rawBody);

  let documentAge: number | null = null;
  let documentCountryIso3: string | null = null;
  let idCheckApproved = false;
  let livenessApproved = false;
  let faceMatchApproved = false;

  if (providerStatus === "approved") {
    const decision = record(raw.decision);
    const idResult = exactNodeResult(
      decision.id_verifications,
      config.idVerificationNodeId,
    );
    const livenessResult = exactNodeResult(
      decision.liveness_checks,
      config.livenessNodeId,
    );
    const faceResult = exactNodeResult(
      decision.face_matches,
      config.faceMatchNodeId,
    );
    idCheckApproved = idResult.status === "Approved";
    livenessApproved = livenessResult.status === "Approved";
    faceMatchApproved = faceResult.status === "Approved";
    if (idCheckApproved) {
      documentAge = age(idResult.age);
      documentCountryIso3 = iso3(idResult.issuing_state);
    }
  }

  return {
    providerEventId,
    providerSessionId,
    providerWorkflowId,
    providerWorkflowVersion,
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

function exactNodeResult(
  value: unknown,
  nodeId: string,
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length > 32) {
    throw new DiditContractError();
  }
  const matches = value.filter((entry) =>
    isRecord(entry) && entry.node_id === nodeId
  );
  if (matches.length !== 1) throw new DiditContractError();
  const result = matches[0] as Record<string, unknown>;
  if (
    typeof result.status !== "string" ||
    !["Approved", "Declined", "In Review"].includes(result.status)
  ) {
    throw new DiditContractError();
  }
  return result;
}

function parseCallbackUrl(value: string): string | null {
  if (value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["norva.tv", "www.norva.tv", "app.norva.tv"].includes(url.hostname)
    ) {
      return null;
    }
    return url.href;
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
