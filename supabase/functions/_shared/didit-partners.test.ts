import {
  DIDIT_PARTNERS_CALLBACK_URL,
  type DiditConfig,
  diditConfigFingerprint,
  sanitizeKycWebhookRpc,
} from "./didit-partners.ts";

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
