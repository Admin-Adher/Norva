import {
  DIDIT_PARTNERS_CALLBACK_URL,
  type DiditConfig,
  diditConfigFingerprint,
  sanitizeDiditCreatedSession,
  sanitizeKycWebhookRpc,
  verifyAndNormalizeDiditWebhook,
  verifyDiditConsoleTestWebhook,
} from "./didit-partners.ts";
import { hmacSha256Hex } from "./partners-crypto.ts";

const baseConfig: DiditConfig = {
  apiKey: "didit-api-key-at-least-sixteen",
  workflowId: "11111111-2222-4333-8444-555555555555",
  applicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  environment: "sandbox",
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

Deno.test("Didit fingerprint ignores secret rotation but binds environment", async () => {
  const fingerprint = await diditConfigFingerprint(baseConfig, 4);
  assert(
    /^[0-9a-f]{64}$/.test(fingerprint),
    "fingerprint must be lowercase SHA-256",
  );
  assert(
    await diditConfigFingerprint(
      {
        ...baseConfig,
        apiKey: "rotated-api-key-at-least-sixteen",
        webhookSecret: "rotated-webhook-secret-at-least-thirty-two-characters",
      },
      4,
    ) === fingerprint,
    "secret rotation must preserve the binding",
  );
  assert(
    await diditConfigFingerprint(
      {
        ...baseConfig,
        environment: "live",
      },
      4,
    ) !== fingerprint,
    "sandbox and live must never share a binding",
  );
  assert(
    await diditConfigFingerprint(baseConfig, 5) !== fingerprint,
    "workflow version changes must produce a new binding",
  );
  assert(
    await diditConfigFingerprint(
      { ...baseConfig, sessionExpirationSeconds: 3600 },
      4,
    ) !== fingerprint,
    "session expiry changes must produce a new binding",
  );
});

Deno.test("Didit RPC states cannot disguise sandbox as authoritative", () => {
  const observed = sanitizeKycWebhookRpc({
    schema_version: 1,
    action: "kyc_result_observed",
    replayed: false,
    environment: "sandbox",
    reason: "sandbox_non_authoritative",
  });
  assert(
    observed.action === "kyc_result_observed",
    "sandbox result must remain an observation",
  );

  let rejected = false;
  try {
    sanitizeKycWebhookRpc({
      schema_version: 1,
      action: "kyc_result_observed",
      replayed: false,
      environment: "live",
      reason: "sandbox_non_authoritative",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "live cannot use the sandbox observation contract");
});

Deno.test("Didit session response accepts the v3 OpenAPI shape but rejects KYB markers", () => {
  const reservation = `kyr_${"a".repeat(24)}`;
  const response = {
    session_id: "99999999-8888-4777-8666-555555555555",
    session_token: "provider-secret",
    url: "https://verify.didit.me/fr/session/opaque-token",
    vendor_data: reservation,
    status: "Not Started",
    workflow_id: baseConfig.workflowId,
    workflow_version: 4,
    callback: DIDIT_PARTNERS_CALLBACK_URL,
  };
  const sanitized = sanitizeDiditCreatedSession(
    response,
    baseConfig,
    reservation,
  );
  assert(sanitized.workflowVersion === 4, "workflow version must survive");
  assert(
    !JSON.stringify(sanitized).includes("provider-secret"),
    "the hosted session token must never leave the provider sanitizer",
  );

  let rejected = false;
  try {
    sanitizeDiditCreatedSession(
      { ...response, session_kind: "business" },
      baseConfig,
      reservation,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "an explicit business session must fail closed");
});

Deno.test("Didit webhook prefers canonical V2, falls back to raw, and rejects envelope-only signatures", async () => {
  const now = 1_774_970_000;
  const payload = {
    event_id: "12345678-1234-4234-8234-123456789abc",
    webhook_type: "status.updated",
    timestamp: now,
    created_at: now - 4,
    application_id: baseConfig.applicationId,
    environment: "sandbox",
    session_id: "99999999-8888-4777-8666-555555555555",
    status: "Approved",
    workflow_id: baseConfig.workflowId,
    workflow_version: 4,
    decision: {
      id_verifications: [{
        node_id: baseConfig.idVerificationNodeId,
        status: "Approved",
        age: 28,
        issuing_state: "ESP",
        full_name: "José must be discarded",
      }],
      liveness_checks: [{
        node_id: baseConfig.livenessNodeId,
        status: "Approved",
      }],
      face_matches: [{
        node_id: baseConfig.faceMatchNodeId,
        status: "Approved",
      }],
    },
  };
  const raw = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  const canonical = JSON.stringify(sortJson(payload));
  const v2Headers = new Headers({
    "X-Timestamp": String(now),
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      canonical,
    ),
  });
  const verifiedV2 = await verifyAndNormalizeDiditWebhook(
    raw,
    v2Headers,
    baseConfig,
    now,
  );
  assert(verifiedV2.documentAge === 28, "V2 authenticates the full decision");
  assert(
    !JSON.stringify(verifiedV2).includes("José"),
    "raw identity data must not cross the sanitizer",
  );

  const rawHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Signature": await hmacSha256Hex(baseConfig.webhookSecret, raw),
  });
  const verifiedRaw = await verifyAndNormalizeDiditWebhook(
    raw,
    rawHeaders,
    baseConfig,
    now,
  );
  assert(
    verifiedRaw.payloadHash === verifiedV2.payloadHash,
    "both full-body signature variants must normalize identically",
  );

  let rejected = false;
  try {
    await verifyAndNormalizeDiditWebhook(
      raw,
      new Headers({
        "X-Timestamp": String(now),
        "X-Signature-Simple": await hmacSha256Hex(
          baseConfig.webhookSecret,
          `${now}:${payload.session_id}:${payload.status}:${payload.webhook_type}`,
        ),
      }),
      baseConfig,
      now,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "the envelope-only signature must never authorize KYC data");
});

Deno.test("Didit console probe is accepted only as a fully signed non-production shape", async () => {
  const now = 1_785_661_809;
  const payload = {
    session_id: "99999999-8888-4777-8666-555555555555",
    status: "Approved",
    vendor_data: "test-vendor-data-123",
    webhook_type: "status.updated",
    timestamp: now,
    created_at: now,
    workflow_id: baseConfig.workflowId,
    metadata: { test_webhook: true },
    decision: { status: "Approved" },
  };
  const raw = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  const headers = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(payload)),
    ),
  });
  assert(
    await verifyDiditConsoleTestWebhook(raw, headers, baseConfig, now),
    "the current authenticated console payload must be acknowledged",
  );

  const withProductionEnvelope = {
    ...payload,
    event_id: "12345678-1234-4234-8234-123456789abc",
  };
  const productionRaw = new TextEncoder().encode(
    JSON.stringify(withProductionEnvelope),
  );
  const productionHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(withProductionEnvelope)),
    ),
  });
  assert(
    !(await verifyDiditConsoleTestWebhook(
      productionRaw,
      productionHeaders,
      baseConfig,
      now,
    )),
    "a production-like event must never bypass normal event validation",
  );

  const tampered = new Headers(headers);
  tampered.set("X-Signature-V2", "0".repeat(64));
  let rejected = false;
  try {
    await verifyDiditConsoleTestWebhook(raw, tampered, baseConfig, now);
  } catch {
    rejected = true;
  }
  assert(rejected, "an unsigned or tampered console probe must fail closed");
});

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortJson(record[key])]),
  );
}
