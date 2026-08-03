import {
  classifyDiditCreateError,
  DIDIT_PARTNERS_CALLBACK_URL,
  type DiditConfig,
  diditConfigFingerprint,
  DiditSessionNotResumableError,
  inspectDiditSessionList,
  readBoundedDiditResponseBody,
  sanitizeDiditActiveSessionList,
  sanitizeDiditCreatedSession,
  sanitizeKycCertificationBindingMatchRpc,
  sanitizeKycCertificationCreateClaimRpc,
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

Deno.test("Didit create errors classify only bounded credits and rate limits", () => {
  assert(
    classifyDiditCreateError(
      400,
      JSON.stringify({
        detail:
          "You don't have enough credits to perform this request. Please top up at https://business.didit.me",
      }),
    ) === "credits_unavailable",
    "the documented 400 credit response must be recognized",
  );
  assert(
    classifyDiditCreateError(402, null) === "credits_unavailable",
    "legacy 402 credit responses remain supported",
  );
  assert(
    classifyDiditCreateError(429, null) === "rate_limited",
    "429 must remain a public rate limit without inspecting its body",
  );
  for (
    const body of [
      null,
      "not-json",
      JSON.stringify({ detail: "Invalid workflow_id." }),
      JSON.stringify({ detail: "You don't have enough credits\nsecret" }),
      JSON.stringify({ detail: "x".repeat(513) }),
      "x".repeat(4_097),
    ]
  ) {
    assert(
      classifyDiditCreateError(400, body) === "other",
      "unknown or oversized provider errors must fail closed",
    );
  }
});

Deno.test("Didit pending recovery accepts one exact active KYC session only", () => {
  const key = `kcf_${"b".repeat(24)}`;
  const candidate = {
    session_id: "99999999-8888-4777-8666-555555555555",
    session_url: "https://verify.didit.me/session/opaque-token",
    status: "In Progress",
    vendor_data: key,
    workflow_id: baseConfig.workflowId,
    session_kind: "user",
    full_name: "PII discarded",
  };
  const recovered = sanitizeDiditActiveSessionList(
    { count: 1, results: [candidate] },
    baseConfig,
    key,
  );
  assert(
    recovered.sessionId === candidate.session_id,
    "the exact candidate id must reach only the private binding verifier",
  );
  assert(
    sanitizeDiditActiveSessionList(
      {
        count: 1,
        results: [{ ...candidate, workflow_id: undefined }],
      },
      baseConfig,
      key,
    ).workflowId === baseConfig.workflowId,
    "an omitted list-row workflow_id inherits the exact request filter",
  );
  assert(
    !JSON.stringify(recovered).includes("PII discarded"),
    "the list sanitizer must discard provider PII",
  );
  assert(
    inspectDiditSessionList(
      { count: 0, results: [] },
      baseConfig,
      key,
    ).kind === "empty",
    "an exact empty list must be distinguishable before the dispatch claim",
  );
  assert(
    sanitizeDiditActiveSessionList(
      { count: 1, results: [{ ...candidate, session_kind: undefined }] },
      baseConfig,
      key,
    ).providerStatus === "in_progress",
    "a legacy KYC row without a kind is accepted only without KYB markers",
  );

  for (
    const invalid of [
      { count: 2, results: [candidate, candidate] },
      {
        count: 1,
        results: [{ ...candidate, vendor_data: `kcf_${"c".repeat(24)}` }],
      },
      {
        count: 1,
        results: [{
          ...candidate,
          workflow_id: "11111111-2222-4333-8444-666666666666",
        }],
      },
      { count: 1, results: [{ ...candidate, session_kind: "business" }] },
      {
        count: 1,
        results: [{
          ...candidate,
          session_kind: undefined,
          company_name: "KYB",
        }],
      },
      {
        count: 1,
        results: [{
          ...candidate,
          session_url: "https://attacker.example/session/token",
        }],
      },
    ]
  ) {
    let rejected = false;
    try {
      sanitizeDiditActiveSessionList(invalid, baseConfig, key);
    } catch {
      rejected = true;
    }
    assert(rejected, "ambiguous or mismatched recovery data must fail closed");
  }

  let terminal = false;
  try {
    sanitizeDiditActiveSessionList(
      { count: 1, results: [{ ...candidate, status: "Approved" }] },
      baseConfig,
      key,
    );
  } catch (error) {
    terminal = error instanceof DiditSessionNotResumableError;
  }
  assert(terminal, "a terminal session must never be recreated");
});

Deno.test("Didit list recovery body is byte-bounded and UTF-8 strict", async () => {
  const exact = JSON.stringify({ count: 0, results: [] });
  assert(
    await readBoundedDiditResponseBody(new Response(exact), 32_768) === exact,
    "a bounded JSON body must remain readable",
  );
  assert(
    await readBoundedDiditResponseBody(
      new Response("x".repeat(32_769)),
      32_768,
    ) === null,
    "an oversized provider body must fail closed",
  );
  assert(
    await readBoundedDiditResponseBody(
      new Response(new Uint8Array([0xc3, 0x28])),
      32_768,
    ) === null,
    "invalid UTF-8 must fail closed",
  );
});

Deno.test("Didit binding-match RPC sanitizer is exact and identifier-free", () => {
  const expiresAt = "2026-08-10T12:00:00.000Z";
  const matched = sanitizeKycCertificationBindingMatchRpc({
    schema_version: 1,
    action: "kyc_certification_binding_matched",
    matched: true,
    certification: { status: "pending", expires_at: expiresAt },
  });
  assert(matched.matched === true, "the private hash match must be explicit");
  assert(
    !JSON.stringify(matched).includes("session_id"),
    "no provider identifier may cross the RPC sanitizer",
  );
  let rejected = false;
  try {
    sanitizeKycCertificationBindingMatchRpc({
      ...matched,
      provider_session_id: "forbidden",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "extra provider fields must fail closed");
});

Deno.test("Didit create-claim RPC sanitizer exposes one immutable timestamp only", () => {
  const expiresAt = "2026-08-10T12:00:00.000Z";
  const dispatchedAt = "2026-08-10T10:00:00.000Z";
  const claimed = sanitizeKycCertificationCreateClaimRpc({
    schema_version: 1,
    action: "kyc_certification_create_claimed",
    claimed: true,
    certification: {
      status: "reserved",
      expires_at: expiresAt,
      provider_create_dispatched_at: dispatchedAt,
    },
  });
  assert(claimed.claimed, "the first durable dispatch claim must be explicit");
  assert(
    claimed.certification.provider_create_dispatched_at === dispatchedAt,
    "the immutable dispatch timestamp must survive",
  );
  let rejected = false;
  try {
    sanitizeKycCertificationCreateClaimRpc({
      ...claimed,
      provider_session_id: "forbidden",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "claim responses cannot expose provider identifiers");
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
