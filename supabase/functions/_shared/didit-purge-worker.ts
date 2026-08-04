import {
  type DiditConfig,
  DiditPurgeRequestError,
  purgeDiditSession,
} from "./didit-partners.ts";
import {
  decryptDiditPurgeEnvelope,
  type DiditPurgeKeyring,
} from "./didit-purge-envelope.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_PATTERN =
  /^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,384}$/;

export type DiditPurgeClaim = {
  outboxId: number;
  leaseToken: string;
  providerSessionHash: string;
  providerSessionEnvelope: string;
  providerEnvironment: "live" | "sandbox";
};

export type DiditPurgeWorkerOutcome =
  | { kind: "purged"; result: "deleted" | "already_deleted" }
  | {
    kind: "failed";
    code:
      | "provider_timeout"
      | "provider_network"
      | "provider_rate_limited"
      | "provider_server_error"
      | "provider_rejected"
      | "configuration_mismatch"
      | "envelope_invalid";
    status: number | null;
    retryable: boolean;
    retryAfterSeconds: number | null;
  };

export function sanitizeDiditPurgeClaims(raw: unknown): DiditPurgeClaim[] {
  if (!Array.isArray(raw) || raw.length > 25) {
    throw new Error("Invalid Didit purge claim contract");
  }
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new Error("Invalid Didit purge claim contract");
    const keys = Object.keys(entry).sort();
    const expected = [
      "lease_token",
      "outbox_id",
      "provider_environment",
      "provider_session_envelope",
      "provider_session_hash",
    ].sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      typeof entry.outbox_id !== "number" ||
      !Number.isSafeInteger(entry.outbox_id) ||
      entry.outbox_id < 1 ||
      typeof entry.lease_token !== "string" ||
      !UUID_PATTERN.test(entry.lease_token) ||
      typeof entry.provider_session_hash !== "string" ||
      !SESSION_HASH_PATTERN.test(entry.provider_session_hash) ||
      typeof entry.provider_session_envelope !== "string" ||
      entry.provider_session_envelope.length > 512 ||
      !ENVELOPE_PATTERN.test(entry.provider_session_envelope) ||
      (entry.provider_environment !== "live" &&
        entry.provider_environment !== "sandbox")
    ) {
      throw new Error("Invalid Didit purge claim contract");
    }
    return {
      outboxId: entry.outbox_id,
      leaseToken: entry.lease_token.toLowerCase(),
      providerSessionHash: entry.provider_session_hash,
      providerSessionEnvelope: entry.provider_session_envelope,
      providerEnvironment: entry.provider_environment,
    };
  });
}

export async function executeDiditPurgeClaim(
  claim: DiditPurgeClaim,
  config: DiditConfig,
  keyring: DiditPurgeKeyring,
  fetchImpl: typeof fetch = fetch,
): Promise<DiditPurgeWorkerOutcome> {
  if (claim.providerEnvironment !== config.environment) {
    return failure("configuration_mismatch", null, false, null);
  }

  let providerSessionId: string;
  try {
    providerSessionId = await decryptDiditPurgeEnvelope(
      claim.providerSessionEnvelope,
      claim.providerSessionHash,
      keyring,
    );
  } catch {
    return failure("envelope_invalid", null, false, null);
  }

  try {
    return {
      kind: "purged",
      result: await purgeDiditSession(config, providerSessionId, fetchImpl),
    };
  } catch (error) {
    if (error instanceof DiditPurgeRequestError) {
      return failure(
        error.code,
        error.status,
        error.retryable,
        error.retryAfterSeconds,
      );
    }
    return failure("provider_network", null, true, null);
  }
}

function failure(
  code: Extract<DiditPurgeWorkerOutcome, { kind: "failed" }>["code"],
  status: number | null,
  retryable: boolean,
  retryAfterSeconds: number | null,
): Extract<DiditPurgeWorkerOutcome, { kind: "failed" }> {
  return { kind: "failed", code, status, retryable, retryAfterSeconds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
