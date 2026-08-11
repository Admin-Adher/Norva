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
  recoverDiditPurgeOrphans,
  sanitizeDiditPurgeClaims,
  sanitizeDiditPurgeOrphans,
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

Deno.test("Didit purge orphan parser is exact, status-aware and bounded", async () => {
  const sessionHash = await diditProviderSessionHash(
    "11111111-2222-4333-8444-555555555555",
  );
  const [orphan] = sanitizeDiditPurgeOrphans([{
    provider_session_hash: sessionHash,
    provider_environment: "live",
    provider_status: "Not Started",
  }]);
  assert(orphan.providerStatus === "not_started", "status must normalize");

  let rejected = false;
  try {
    sanitizeDiditPurgeOrphans([{
      provider_session_hash: sessionHash,
      provider_environment: "live",
      provider_status: "not_started",
      provider_session_id: "11111111-2222-4333-8444-555555555555",
    }]);
  } catch {
    rejected = true;
  }
  assert(rejected, "plaintext/unknown orphan fields must fail closed");
  rejected = false;
  try {
    sanitizeDiditPurgeOrphans(Array.from({ length: 6 }, () => ({
      provider_session_hash: sessionHash,
      provider_environment: "live",
      provider_status: "not_started",
    })));
  } catch {
    rejected = true;
  }
  assert(rejected, "orphan recovery must remain bounded to five rows");
});

Deno.test("Didit orphan recovery reduces PII-rich list rows before staging", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sessionHash = await diditProviderSessionHash(sessionId);
  const keyring = key();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [{
            session_id: sessionId,
            session_kind: "user",
            workflow_id: config.workflowId,
            status: "Not Started",
            vendor_data: "must-not-survive",
            contact_details: { email: "pii@example.invalid" },
            full_name: "Sensitive Person",
            document_images: ["signed-provider-url"],
          }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }) as typeof fetch;

  const result = await recoverDiditPurgeOrphans(
    [{
      providerSessionHash: sessionHash,
      providerEnvironment: "live",
      providerStatus: "not_started",
    }],
    config,
    keyring,
    fetcher,
  );
  assert(result.recoveries.length === 1, "matching hash must be recovered");
  assert(result.pending === 0 && result.errorCount === 0, "recovery is clean");
  assert(
    await decryptDiditPurgeEnvelope(
      result.recoveries[0].providerSessionEnvelope,
      sessionHash,
      keyring,
    ) === sessionId,
    "recovered identifier must be stored only in an authenticated envelope",
  );
  const publicShape = JSON.stringify(result);
  assert(!publicShape.includes("Sensitive Person"), "name must be discarded");
  assert(
    !publicShape.includes("pii@example.invalid"),
    "email must be discarded",
  );
  assert(
    !publicShape.includes("signed-provider-url"),
    "media URL must be discarded",
  );
  assert(requests.length === 1, "one bounded provider page is sufficient");
  const requested = new URL(requests[0].url);
  assert(
    requested.origin + requested.pathname ===
      "https://verification.didit.me/v3/sessions/",
    "canonical list endpoint",
  );
  assert(requested.searchParams.get("session_kind") === "user", "KYC only");
  assert(
    requested.searchParams.get("workflow_id") === config.workflowId,
    "workflow must be bound",
  );
  assert(
    requested.searchParams.get("status") === "Not Started",
    "provider status must be bound",
  );
  assert(requested.searchParams.get("limit") === "25", "page must be bounded");
  assert(requested.searchParams.get("offset") === "0", "first page offset");
  assert(requests[0].init?.redirect === "error", "redirects must fail closed");
});

Deno.test("Didit orphan recovery never follows provider pagination beyond four pages", async () => {
  const targetId = "11111111-2222-4333-8444-555555555555";
  const targetHash = await diditProviderSessionHash(targetId);
  let calls = 0;
  const fetcher = ((_input: string | URL | Request, _init?: RequestInit) => {
    const page = calls++;
    const results = Array.from({ length: 25 }, (_, index) => ({
      session_id: `00000000-0000-4000-8000-${
        String(
          page * 25 + index + 1,
        ).padStart(12, "0")
      }`,
      session_kind: "user",
      workflow_id: config.workflowId,
      status: "Not Started",
    }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          count: 10_000,
          next: "https://provider.example.invalid/untrusted",
          results,
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const result = await recoverDiditPurgeOrphans(
    [{
      providerSessionHash: targetHash,
      providerEnvironment: "live",
      providerStatus: "not_started",
    }],
    config,
    key(),
    fetcher,
  );
  assert(calls === 4, "recovery must stop after four computed pages");
  assert(
    result.recoveries.length === 0 && result.pending === 1,
    "unmatched source remains pending",
  );
  assert(result.errorCount === 0, "bounded absence is not provider corruption");
});

Deno.test("Didit orphan recovery shares one four-page budget across statuses", async () => {
  let calls = 0;
  const fetcher = ((input: string | URL | Request, _init?: RequestInit) => {
    calls += 1;
    const requested = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const results = Array.from({ length: 25 }, (_, index) => ({
      session_id: `00000000-0000-4000-8000-${
        String(
          calls * 25 + index + 1,
        ).padStart(12, "0")
      }`,
      session_kind: "user",
      status: requested.searchParams.get("status"),
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ results }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  const result = await recoverDiditPurgeOrphans(
    [
      {
        providerSessionHash: "1".repeat(64),
        providerEnvironment: "live",
        providerStatus: "approved",
      },
      {
        providerSessionHash: "2".repeat(64),
        providerEnvironment: "live",
        providerStatus: "declined",
      },
    ],
    config,
    key(),
    fetcher,
  );

  assert(calls === 4, "all status groups must share the four-page ceiling");
  assert(
    result.recoveries.length === 0 && result.pending === 2,
    "unmatched sources remain pending for the next bounded cycle",
  );
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
