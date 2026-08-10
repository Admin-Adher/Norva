import {
  classifyDiditCreateError,
  DIDIT_PARTNERS_CALLBACK_URL,
  type DiditConfig,
  diditConfigFingerprint,
  DiditSessionNotResumableError,
  inspectDiditSessionList,
  parseKycSessionInput,
  purgeDiditSession,
  readBoundedDiditResponseBody,
  sanitizeDiditActiveSessionList,
  sanitizeDiditCreatedSession,
  sanitizeKycCertificationBindingMatchRpc,
  sanitizeKycCertificationCreateClaimRpc,
  sanitizeKycPrepareRpc,
  sanitizeKycSessionRecordRpc,
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
    purge_status: "not_required",
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
      purge_status: "not_required",
      environment: "live",
      reason: "sandbox_non_authoritative",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "live cannot use the sandbox observation contract");
});

Deno.test("Member KYC requires dedicated biometric consent", () => {
  const input = parseKycSessionInput({
    language: "fr",
    consentVersion: "partners-disclosure-v1",
    biometricConsentVersion: "partners-biometric-consent-v1",
    consentGranted: true,
    capacityConfirmed: true,
  });
  assert(
    input.biometricConsentVersion === "partners-biometric-consent-v1",
    "dedicated biometric consent must survive parsing",
  );
  const prepared = sanitizeKycPrepareRpc({
    schema_version: 1,
    action: "kyc_ready",
    replayed: false,
    account: { id: `prt_${"a".repeat(24)}`, status: "pending_verification" },
    kyc: {
      provider: "didit",
      readiness: "ready",
      minimum_age: 18,
      country_code: "FR",
      capacity_required: true,
      reservation_key: `kyr_${"b".repeat(24)}`,
      biometric_consent_version: "partners-biometric-consent-v1",
    },
  });
  assert(
    prepared.kyc.biometric_consent_version ===
      "partners-biometric-consent-v1",
    "server biometric consent contract must remain exact",
  );

  let rejected = false;
  try {
    parseKycSessionInput({
      language: "fr",
      consentVersion: "partners-disclosure-v1",
      biometricConsentVersion: "partners-biometric-consent-v0",
      consentGranted: true,
      capacityConfirmed: true,
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "stale biometric consent must fail closed");
});

Deno.test("member KYC record exposes only serialized session dispositions", () => {
  const active = sanitizeKycSessionRecordRpc({
    schema_version: 1,
    action: "kyc_session_recorded",
    replayed: false,
    session_disposition: "active",
    purge_status: "not_required",
    kyc: { status: "pending", expires_at: null },
  });
  assert(
    active.session_disposition === "active",
    "a staged non-terminal session must remain resumable",
  );

  const withdrawn = sanitizeKycSessionRecordRpc({
    schema_version: 1,
    action: "kyc_session_recorded",
    replayed: false,
    session_disposition: "withdrawn",
    purge_status: "purge_pending",
    kyc: { status: "superseded", expires_at: null },
  });
  assert(
    withdrawn.kyc.status === "superseded",
    "withdrawal must sanitize to a terminal local session",
  );

  let rejected = false;
  try {
    sanitizeKycSessionRecordRpc({
      schema_version: 1,
      action: "kyc_session_recorded",
      replayed: false,
      session_disposition: "withdrawn",
      purge_status: "not_required",
      kyc: { status: "pending", expires_at: null },
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "withdrawal cannot be disguised as an active session");
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
    session_kind: "user",
    sandbox_scenario: null,
    session_id: "99999999-8888-4777-8666-555555555555",
    status: "Approved",
    workflow_id: baseConfig.workflowId,
    workflow_version: 1,
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
  assert(
    verifiedV2.webhookType === "status.updated",
    "the normalized lifecycle event type remains explicit",
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

  const reviewPayload = {
    ...payload,
    event_id: "22345678-1234-4234-8234-123456789abc",
    webhook_type: "data.updated",
  };
  const reviewRaw = new TextEncoder().encode(JSON.stringify(reviewPayload));
  const reviewHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(reviewPayload)),
    ),
  });
  const verifiedReview = await verifyAndNormalizeDiditWebhook(
    reviewRaw,
    reviewHeaders,
    baseConfig,
    now,
  );
  assert(
    verifiedReview.webhookType === "data.updated" &&
      verifiedReview.faceMatchApproved,
    "a fully signed reviewer correction is normalized without identity data",
  );

  const pendingReviewPayload = {
    ...payload,
    event_id: "32345678-1234-4234-8234-123456789abc",
    decision: {
      ...payload.decision,
      face_matches: [{
        node_id: baseConfig.faceMatchNodeId,
        status: "In Review",
      }],
    },
  };
  const pendingReviewRaw = new TextEncoder().encode(
    JSON.stringify(pendingReviewPayload),
  );
  const pendingReviewHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(pendingReviewPayload)),
    ),
  });
  const verifiedPendingReview = await verifyAndNormalizeDiditWebhook(
    pendingReviewRaw,
    pendingReviewHeaders,
    baseConfig,
    now,
  );
  assert(
    verifiedPendingReview.providerStatus === "in_review" &&
      verifiedPendingReview.idCheckApproved &&
      verifiedPendingReview.livenessApproved &&
      !verifiedPendingReview.faceMatchApproved,
    "an aggregate approval with an explicitly reviewed feature remains non-terminal",
  );

  for (
    const documentedIndividualPayload of [
      { ...payload, session_kind: undefined },
      { ...payload, session_kind: null },
    ]
  ) {
    const documentedRaw = new TextEncoder().encode(
      JSON.stringify(documentedIndividualPayload),
    );
    const documentedHeaders = new Headers({
      "X-Timestamp": String(now),
      "X-Signature-V2": await hmacSha256Hex(
        baseConfig.webhookSecret,
        JSON.stringify(sortJson(documentedIndividualPayload)),
      ),
    });
    const documented = await verifyAndNormalizeDiditWebhook(
      documentedRaw,
      documentedHeaders,
      baseConfig,
      now,
    );
    assert(
      documented.providerSessionId === payload.session_id,
      "documented individual KYC webhooks may omit session_kind",
    );
  }

  for (
    const invalidPayload of [
      { ...payload, session_kind: "business" },
      { ...payload, session_kind: "organization" },
      { ...payload, workflow_type: "kyb" },
      { ...payload, vendor_business_id: "business-marker" },
      { ...payload, company_name: "Business marker" },
      { ...payload, webhook_type: "user.data.updated" },
      { ...payload, sandbox_scenario: { unexpected: true } },
      { ...payload, workflow_version: 2 },
    ]
  ) {
    const invalidRaw = new TextEncoder().encode(JSON.stringify(invalidPayload));
    const invalidHeaders = new Headers({
      "X-Timestamp": String(now),
      "X-Signature-V2": await hmacSha256Hex(
        baseConfig.webhookSecret,
        JSON.stringify(sortJson(invalidPayload)),
      ),
    });
    let contractRejected = false;
    try {
      await verifyAndNormalizeDiditWebhook(
        invalidRaw,
        invalidHeaders,
        baseConfig,
        now,
      );
    } catch {
      contractRejected = true;
    }
    assert(
      contractRejected,
      "non-user, KYB-marked or workflow-drifted webhooks must fail closed",
    );
  }

  const livePayload = {
    ...payload,
    environment: "live",
    sandbox_scenario: "document_invalid",
  };
  const liveRaw = new TextEncoder().encode(JSON.stringify(livePayload));
  const liveHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(livePayload)),
    ),
  });
  let liveScenarioRejected = false;
  try {
    await verifyAndNormalizeDiditWebhook(
      liveRaw,
      liveHeaders,
      { ...baseConfig, environment: "live" },
      now,
    );
  } catch {
    liveScenarioRejected = true;
  }
  assert(
    liveScenarioRejected,
    "a live webhook carrying a sandbox scenario must fail closed",
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

Deno.test("Didit console probe accepts the signed current v3 test envelope", async () => {
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

  const fullyBoundPayload = {
    ...payload,
    event_id: "12345678-1234-4234-8234-123456789abc",
    application_id: baseConfig.applicationId,
    environment: baseConfig.environment,
    sandbox_scenario: null,
    workflow_version: 1,
  };
  const fullyBoundRaw = new TextEncoder().encode(
    JSON.stringify(fullyBoundPayload),
  );
  const fullyBoundHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(fullyBoundPayload)),
    ),
  });
  assert(
    await verifyDiditConsoleTestWebhook(
      fullyBoundRaw,
      fullyBoundHeaders,
      baseConfig,
      now,
    ),
    "optional exact bindings must remain accepted",
  );

  const foreignApplication = {
    ...fullyBoundPayload,
    application_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  };
  const productionRaw = new TextEncoder().encode(
    JSON.stringify(foreignApplication),
  );
  const productionHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(foreignApplication)),
    ),
  });
  assert(
    !(await verifyDiditConsoleTestWebhook(
      productionRaw,
      productionHeaders,
      baseConfig,
      now,
    )),
    "a foreign application must never be acknowledged as a console probe",
  );

  const foreignEnvironment = { ...fullyBoundPayload, environment: "live" };
  const foreignEnvironmentRaw = new TextEncoder().encode(
    JSON.stringify(foreignEnvironment),
  );
  const foreignEnvironmentHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(foreignEnvironment)),
    ),
  });
  assert(
    !(await verifyDiditConsoleTestWebhook(
      foreignEnvironmentRaw,
      foreignEnvironmentHeaders,
      baseConfig,
      now,
    )),
    "a cross-environment probe must fail closed",
  );

  const unsignedMarkerPayload = { ...payload, metadata: {} };
  const unsignedMarkerRaw = new TextEncoder().encode(
    JSON.stringify(unsignedMarkerPayload),
  );
  const unsignedMarkerHeaders = new Headers({
    "X-Timestamp": String(now),
    "X-Didit-Test-Webhook": "true",
    "X-Signature-V2": await hmacSha256Hex(
      baseConfig.webhookSecret,
      JSON.stringify(sortJson(unsignedMarkerPayload)),
    ),
  });
  assert(
    !(await verifyDiditConsoleTestWebhook(
      unsignedMarkerRaw,
      unsignedMarkerHeaders,
      baseConfig,
      now,
    )),
    "a probe without the signed metadata marker must fail closed",
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

Deno.test("Didit terminal-session purge is bounded and replay-safe", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deleted = await purgeDiditSession(
    baseConfig,
    sessionId,
    ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch,
  );
  assert(deleted === "deleted", "204 must prove first deletion");
  assert(calls.length === 1, "purge must issue one request");
  assert(
    calls[0].url ===
      `https://verification.didit.me/v3/session/${sessionId}/delete/`,
    "purge must use the canonical Didit endpoint",
  );
  assert(calls[0].init?.method === "DELETE", "purge must use DELETE");
  assert(
    new Headers(calls[0].init?.headers).get("x-api-key") === baseConfig.apiKey,
    "purge must authenticate server-side",
  );
  assert(
    calls[0].init?.redirect === "error" &&
      calls[0].init?.signal instanceof AbortSignal,
    "purge must reject redirects and use a timeout signal",
  );

  const replayed = await purgeDiditSession(
    baseConfig,
    sessionId,
    (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch,
  );
  assert(replayed === "already_deleted", "404 must be safe after a replay");

  let rejected = false;
  try {
    await purgeDiditSession(
      baseConfig,
      sessionId,
      (() =>
        Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "permission or provider failures must fail closed");
});

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortJson(record[key])]),
  );
}
