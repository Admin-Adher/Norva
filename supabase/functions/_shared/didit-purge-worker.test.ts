import {
  DIDIT_PARTNERS_CALLBACK_URL,
  type DiditConfig,
} from "./didit-partners.ts";
import {
  decryptDiditPurgeEnvelope,
  diditProviderSessionHash,
  encryptDiditPurgeEnvelope,
  loadDiditPurgeKeyring,
} from "./didit-purge-envelope.ts";
import {
  executeDiditPurgeClaim,
  sanitizeDiditPurgeClaims,
} from "./didit-purge-worker.ts";

const config: DiditConfig = {
  apiKey: "didit-api-key-at-least-sixteen",
  workflowId: "11111111-2222-4333-8444-555555555555",
  applicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  environment: "live",
  sessionExpirationSeconds: 604800,
  webhookSecret: "didit-webhook-secret-at-least-thirty-two-characters",
  callbackUrl: DIDIT_PARTNERS_CALLBACK_URL,
  idVerificationNodeId: "id-primary",
  livenessNodeId: "liveness-primary",
  faceMatchNodeId: "face-primary",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function key(version = "k1") {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index + 1;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/g, "");
  const keyring = loadDiditPurgeKeyring((name) => {
    if (name === "NORVA_PARTNERS_DIDIT_PURGE_KEYS_JSON") {
      return JSON.stringify({ [version]: encoded });
    }
    if (name === "NORVA_PARTNERS_DIDIT_PURGE_ACTIVE_KEY_VERSION") {
      return version;
    }
    return undefined;
  });
  assert(keyring, "valid purge keyring must load");
  return keyring;
}

Deno.test("Didit purge envelope is authenticated, opaque and rotation-aware", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sessionHash = await diditProviderSessionHash(sessionId);
  const keyring = key();
  const envelope = await encryptDiditPurgeEnvelope(
    sessionId,
    sessionHash,
    keyring,
  );
  assert(!envelope.includes(sessionId), "envelope must not expose session id");
  assert(
    await decryptDiditPurgeEnvelope(envelope, sessionHash, keyring) ===
      sessionId,
    "authenticated envelope must round-trip",
  );

  let rejected = false;
  try {
    await decryptDiditPurgeEnvelope(envelope, "0".repeat(64), keyring);
  } catch {
    rejected = true;
  }
  assert(rejected, "hash/AAD mismatch must fail closed");
});

Deno.test("Didit purge claim parser is exact and bounded", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sessionHash = await diditProviderSessionHash(sessionId);
  const envelope = await encryptDiditPurgeEnvelope(
    sessionId,
    sessionHash,
    key(),
  );
  const claims = sanitizeDiditPurgeClaims([{
    outbox_id: 42,
    lease_token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    provider_session_hash: sessionHash,
    provider_session_envelope: envelope,
    provider_environment: "live",
  }]);
  assert(claims.length === 1 && claims[0].outboxId === 42, "claim survives");

  let rejected = false;
  try {
    sanitizeDiditPurgeClaims([{
      ...claims[0],
      provider_session_id: sessionId,
    }]);
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown/plaintext fields must fail closed");
});

Deno.test("Didit purge worker treats 204/404 as success and classifies failures", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sessionHash = await diditProviderSessionHash(sessionId);
  const keyring = key();
  const [claim] = sanitizeDiditPurgeClaims([{
    outbox_id: 7,
    lease_token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    provider_session_hash: sessionHash,
    provider_session_envelope: await encryptDiditPurgeEnvelope(
      sessionId,
      sessionHash,
      keyring,
    ),
    provider_environment: "live",
  }]);

  const deleted = await executeDiditPurgeClaim(
    claim,
    config,
    keyring,
    (() =>
      Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch,
  );
  assert(
    deleted.kind === "purged" && deleted.result === "deleted",
    "204 must complete",
  );
  const absent = await executeDiditPurgeClaim(
    claim,
    config,
    keyring,
    (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch,
  );
  assert(
    absent.kind === "purged" && absent.result === "already_deleted",
    "404 must be replay-safe",
  );
  const limited = await executeDiditPurgeClaim(
    claim,
    config,
    keyring,
    (() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      )) as typeof fetch,
  );
  assert(
    limited.kind === "failed" && limited.retryable &&
      limited.retryAfterSeconds === 30,
    "429 must schedule bounded retry",
  );
  const rejected = await executeDiditPurgeClaim(
    claim,
    config,
    keyring,
    (() =>
      Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch,
  );
  assert(
    rejected.kind === "failed" && !rejected.retryable,
    "403 must dead-letter",
  );
});
