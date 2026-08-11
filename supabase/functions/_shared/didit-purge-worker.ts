import {
  DIDIT_LIST_SESSIONS_URL,
  type DiditConfig,
  DiditPurgeRequestError,
  type DiditStatus,
  normalizeDiditStatus,
  purgeDiditSession,
  readBoundedDiditResponseBody,
} from "./didit-partners.ts";
import {
  decryptDiditPurgeEnvelope,
  diditProviderSessionHash,
  type DiditPurgeKeyring,
  encryptDiditPurgeEnvelope,
} from "./didit-purge-envelope.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_PATTERN =
  /^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,384}$/;
const ORPHAN_RECOVERY_LIMIT = 5;
const DIDIT_LIST_PAGE_SIZE = 25;
const DIDIT_LIST_MAX_PAGES = 4;
const DIDIT_LIST_MAX_BYTES = 512 * 1_024;
const DIDIT_LIST_TIMEOUT_MS = 8_000;

const TERMINAL_DIDIT_PURGE_STATUSES: ReadonlySet<DiditStatus> = new Set([
  "approved",
  "declined",
  "expired",
  "abandoned",
  "kyc_expired",
]);

export type DiditPurgeClaim = {
  outboxId: number;
  leaseToken: string;
  providerSessionHash: string;
  providerSessionEnvelope: string;
  providerEnvironment: "live" | "sandbox";
};

export type DiditPurgeOrphan = {
  providerSessionHash: string;
  providerEnvironment: "live" | "sandbox";
  providerStatus: DiditStatus;
};

export type DiditPurgeRecovery = {
  providerSessionId: string;
  providerSessionEnvelope: string;
  providerEnvironment: "live" | "sandbox";
};

export type DiditPurgeOrphanRecoveryResult = {
  recoveries: DiditPurgeRecovery[];
  pending: number;
  errorCount: number;
};

type DiditPurgeRecoveryCandidate = {
  providerSessionId: string;
  providerStatus: DiditStatus;
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

export function sanitizeDiditPurgeOrphans(raw: unknown): DiditPurgeOrphan[] {
  if (!Array.isArray(raw) || raw.length > ORPHAN_RECOVERY_LIMIT) {
    throw new Error("Invalid Didit purge orphan contract");
  }
  return raw.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Invalid Didit purge orphan contract");
    }
    const keys = Object.keys(entry).sort();
    const expected = [
      "provider_environment",
      "provider_session_hash",
      "provider_status",
    ].sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      typeof entry.provider_session_hash !== "string" ||
      !SESSION_HASH_PATTERN.test(entry.provider_session_hash) ||
      (entry.provider_environment !== "live" &&
        entry.provider_environment !== "sandbox")
    ) {
      throw new Error("Invalid Didit purge orphan contract");
    }
    let providerStatus: DiditStatus;
    try {
      providerStatus = normalizeDiditStatus(entry.provider_status);
    } catch {
      throw new Error("Invalid Didit purge orphan contract");
    }
    return {
      providerSessionHash: entry.provider_session_hash,
      providerEnvironment: entry.provider_environment,
      providerStatus,
    };
  });
}

/**
 * Recovers only provider identifiers whose one-way hash exactly matches a
 * terminal Norva source and whose current provider status is terminal. The
 * stored provider status is intentionally not used as a list filter because a
 * manual review can make that historical value stale. Didit's list response is
 * PII-rich, so every response is byte-bounded and immediately reduced to
 * session id/kind/status in memory. No response body, provider field or hash is
 * logged or returned to clients.
 */
export async function recoverDiditPurgeOrphans(
  orphans: readonly DiditPurgeOrphan[],
  config: DiditConfig,
  keyring: DiditPurgeKeyring,
  fetchImpl: typeof fetch = fetch,
): Promise<DiditPurgeOrphanRecoveryResult> {
  if (orphans.length > ORPHAN_RECOVERY_LIMIT) {
    throw new Error("Invalid Didit purge orphan contract");
  }

  const recoveries: DiditPurgeRecovery[] = [];
  let errorCount = 0;
  const unresolved = new Map<string, DiditPurgeOrphan>();
  for (const orphan of orphans) {
    if (orphan.providerEnvironment !== config.environment) {
      errorCount += 1;
      continue;
    }
    unresolved.set(orphan.providerSessionHash, orphan);
  }

  try {
    for (
      let page = 0;
      page < DIDIT_LIST_MAX_PAGES && unresolved.size > 0;
      page += 1
    ) {
      const candidates = await fetchDiditPurgeRecoveryPage(
        config,
        page * DIDIT_LIST_PAGE_SIZE,
        fetchImpl,
      );
      for (const candidate of candidates) {
        const providerSessionHash = await diditProviderSessionHash(
          candidate.providerSessionId,
        );
        const orphan = unresolved.get(providerSessionHash);
        if (
          !orphan ||
          !TERMINAL_DIDIT_PURGE_STATUSES.has(candidate.providerStatus)
        ) {
          continue;
        }
        recoveries.push({
          providerSessionId: candidate.providerSessionId,
          providerSessionEnvelope: await encryptDiditPurgeEnvelope(
            candidate.providerSessionId,
            orphan.providerSessionHash,
            keyring,
          ),
          providerEnvironment: orphan.providerEnvironment,
        });
        unresolved.delete(providerSessionHash);
      }
      if (candidates.length < DIDIT_LIST_PAGE_SIZE) break;
    }
  } catch {
    errorCount += unresolved.size;
  }

  return {
    recoveries,
    pending: orphans.length - recoveries.length,
    errorCount,
  };
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

async function fetchDiditPurgeRecoveryPage(
  config: DiditConfig,
  offset: number,
  fetchImpl: typeof fetch,
): Promise<DiditPurgeRecoveryCandidate[]> {
  const url = new URL(DIDIT_LIST_SESSIONS_URL);
  url.searchParams.set("session_kind", "user");
  url.searchParams.set("workflow_id", config.workflowId);
  url.searchParams.set("limit", String(DIDIT_LIST_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIDIT_LIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "x-api-key": config.apiKey,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    try {
      await response.body?.cancel("didit_list_rejected");
    } catch {
      // The fail-closed status is authoritative.
    }
    throw new Error("Didit purge orphan discovery failed");
  }

  const boundedBody = await readBoundedDiditResponseBody(
    response,
    DIDIT_LIST_MAX_BYTES,
  );
  if (boundedBody === null) {
    throw new Error("Didit purge orphan discovery failed");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(boundedBody);
  } catch {
    throw new Error("Didit purge orphan discovery failed");
  }
  if (
    !isRecord(raw) || !Array.isArray(raw.results) ||
    raw.results.length > DIDIT_LIST_PAGE_SIZE
  ) {
    throw new Error("Didit purge orphan discovery failed");
  }

  const reduced: DiditPurgeRecoveryCandidate[] = [];
  for (const result of raw.results) {
    if (
      !isRecord(result) || result.session_kind !== "user" ||
      typeof result.session_id !== "string" ||
      !UUID_PATTERN.test(result.session_id)
    ) {
      throw new Error("Didit purge orphan discovery failed");
    }
    if (
      result.workflow_id !== undefined &&
      (typeof result.workflow_id !== "string" ||
        result.workflow_id.toLowerCase() !== config.workflowId)
    ) {
      throw new Error("Didit purge orphan discovery failed");
    }
    let observedStatus: DiditStatus;
    try {
      observedStatus = normalizeDiditStatus(result.status);
    } catch {
      throw new Error("Didit purge orphan discovery failed");
    }
    reduced.push({
      providerSessionId: result.session_id.toLowerCase(),
      providerStatus: observedStatus,
    });
  }
  return reduced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
