import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import {
  classifyDiditCreateError,
  DIDIT_CREATE_SESSION_URL,
  DIDIT_LIST_SESSIONS_URL,
  DIDIT_PARTNERS_WORKFLOW_VERSION,
  type DiditActiveSession,
  diditConfigFingerprint,
  DiditContractError,
  diditCreateBody,
  DiditSessionNotResumableError,
  inspectDiditSessionList,
  loadDiditConfig,
  parseKycCertificationInput,
  parseKycSessionInput,
  readBoundedDiditResponseBody,
  sanitizeDiditCreatedSession,
  sanitizeKycCertificationBindingMatchRpc,
  sanitizeKycCertificationCreateClaimRpc,
  sanitizeKycCertificationPrepareRpc,
  sanitizeKycCertificationSessionRecordRpc,
  sanitizeKycPrepareRpc,
  sanitizeKycSessionRecordRpc,
} from "../_shared/didit-partners.ts";
import {
  diditProviderSessionHash,
  encryptDiditPurgeEnvelope,
  loadDiditPurgeKeyring,
} from "../_shared/didit-purge-envelope.ts";
import {
  allowedMethodsForRoute,
  assertAllowedOrigin,
  assertNoQueryParameters,
  assertValidPreflight,
  BootstrapContractError,
  corsHeaders,
  isUuid,
  mapDatabaseError,
  parseAcceptTermsInput,
  parseAccessRequestInput,
  parseAllowedOrigins,
  parseApplicationInput,
  parseBearerToken,
  parseBootstrapQuery,
  parseDashboardQuery,
  parseEmptyMutationInput,
  parseFiscalProfileInput,
  parseIdempotencyKey,
  parseKycHumanReviewInput,
  parsePayoutOnboardingInput,
  PARTNERS_API_VERSION,
  PARTNERS_RPC,
  partnersMemberWriteRequestHash,
  PublicApiError,
  routeFromPath,
  sanitizeAccessRequestData,
  sanitizeAccessRequestMutationData,
  sanitizeActivationReconcile,
  sanitizeBootstrapData,
  sanitizeDashboardData,
  sanitizeFiscalProfileGet,
  sanitizeFiscalProfileMutation,
  sanitizeKycRightsData,
  sanitizeKycRightsMutationData,
  sanitizeMemberWriteReservation,
  sanitizeMutationData,
  sanitizePayoutOnboardingGet,
  sanitizePayoutOnboardingMutation,
} from "../_shared/partners-api.ts";
import { sanitizePayoutProfileGet } from "../_shared/partners-payout.ts";
import {
  claimHashFromSignedToken,
  loadReferralSecrets,
  parseClaimInput,
  sanitizeReferralClaimRpc,
} from "../_shared/partners-referral.ts";
import {
  loadTvRelayConfig,
  parseTvRelayTokenInput,
  relayTokenHashFromSignedToken,
  sanitizeTvRelayConsumeRpc,
} from "../_shared/partners-tv-relay.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  Deno.env.get("NORVA_PARTNERS_ALLOWED_ORIGINS"),
);
const DIDIT_CONFIG = loadDiditConfig((name) => Deno.env.get(name));
const DIDIT_PURGE_KEYRING = loadDiditPurgeKeyring((name) => Deno.env.get(name));
const REFERRAL_SECRETS = loadReferralSecrets((name) => Deno.env.get(name));
const TV_RELAY_CONFIG = loadTvRelayConfig((name) => Deno.env.get(name));
const ACCESS_REQUESTS_ENABLED =
  (Deno.env.get("NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED") ?? "false")
    .trim()
    .toLowerCase() === "true";
const DIDIT_CERTIFICATION_ENABLED =
  Deno.env.get("NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED") === "true";
// List Sessions does not expose workflow_version. The exceptional pre-gate
// certification is deliberately pinned to the workflow version being
// certified; a later signed webhook with any other version is quarantined.

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing required Norva Partners server configuration");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const correlationId = createCorrelationId();
  const origin = req.headers.get("Origin");
  const url = new URL(req.url);
  const route = routeFromPath(url.pathname);
  const allowedMethods = allowedMethodsForRoute(route);

  try {
    if (req.method === "OPTIONS") {
      if (!allowedMethods) {
        throw new PublicApiError(404, "route_not_found", "Route not found.");
      }
      assertValidPreflight(
        origin,
        req.headers.get("Access-Control-Request-Method"),
        req.headers.get("Access-Control-Request-Headers"),
        ALLOWED_ORIGINS,
        allowedMethods,
      );
      return new Response(null, {
        status: 204,
        headers: responseHeaders(origin, correlationId),
      });
    }

    assertAllowedOrigin(origin, ALLOWED_ORIGINS);
    if (!allowedMethods) {
      throw new PublicApiError(404, "route_not_found", "Route not found.");
    }
    if (!allowedMethods.includes(req.method)) {
      throw new PublicApiError(
        405,
        "method_not_allowed",
        "Method not allowed.",
      );
    }

    const token = parseBearerToken(req.headers.get("Authorization"));
    const userId = await requireUserId(token, admin);
    let cleanData: Record<string, unknown>;
    let status = 200;

    if (route === "/bootstrap") {
      const query = parseBootstrapQuery(url);
      const data = await callRpc(PARTNERS_RPC.bootstrap, {
        p_user_id: userId,
        p_country_code: query.countryCode,
        p_subdivision_code: query.subdivisionCode,
      });
      cleanData = sanitizeBootstrapData(data, query);
    } else if (route === "/access-request" && req.method === "GET") {
      assertNoQueryParameters(url);
      const data = await callRpc(PARTNERS_RPC.accessRequestGet, {
        p_user_id: userId,
      });
      cleanData = sanitizeAccessRequestData(data);
    } else if (route === "/access-request") {
      assertNoQueryParameters(url);
      if (!ACCESS_REQUESTS_ENABLED) {
        throw new PublicApiError(
          503,
          "partners_access_requests_disabled",
          "Norva Partners early-access requests are temporarily closed.",
        );
      }
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      const input = parseAccessRequestInput(await readJsonBody(req));
      const data = await callRpc(
        PARTNERS_RPC.accessRequestSubmit,
        {
          p_user_id: userId,
          p_country_code: input.countryCode,
          p_subdivision_code: input.subdivisionCode,
          p_idempotency_key: idempotencyKey,
        },
        "mutation",
      );
      cleanData = sanitizeAccessRequestMutationData(data);
      status = 201;
    } else if (route === "/applications") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      const input = parseApplicationInput(await readJsonBody(req));
      const data = await callRpc(
        PARTNERS_RPC.apply,
        {
          p_user_id: userId,
          p_country_code: input.countryCode,
          p_subdivision_code: input.subdivisionCode,
          p_account_type: input.accountType,
          p_idempotency_key: idempotencyKey,
        },
        "mutation",
      );
      cleanData = sanitizeMutationData(data, "application_submitted");
      status = 201;
    } else if (route === "/activate") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      const input = parseAcceptTermsInput(await readJsonBody(req));
      const data = await callRpc(
        PARTNERS_RPC.acceptTerms,
        {
          p_user_id: userId,
          p_terms_version: input.termsVersion,
          p_disclosure_version: input.disclosureVersion,
          p_idempotency_key: idempotencyKey,
        },
        "mutation",
      );
      cleanData = sanitizeMutationData(data, "terms_accepted");
    } else if (route === "/activation/reconcile") {
      assertNoQueryParameters(url);
      parseEmptyMutationInput(await readJsonBody(req));
      cleanData = sanitizeActivationReconcile(
        await callRpc(
          PARTNERS_RPC.activationReconcile,
          { p_user_id: userId },
          "mutation",
        ),
      );
    } else if (route === "/links") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      parseEmptyMutationInput(await readJsonBody(req));
      const data = await callRpc(
        PARTNERS_RPC.rotateLink,
        {
          p_user_id: userId,
          p_idempotency_key: idempotencyKey,
        },
        "mutation",
      );
      cleanData = sanitizeMutationData(data, "link_rotated");
    } else if (route === "/kyc/rights") {
      assertNoQueryParameters(url);
      cleanData = sanitizeKycRightsData(
        await callRpc(PARTNERS_RPC.kycRightsGet, {
          p_user_id: userId,
        }),
      );
    } else if (route === "/kyc/consent/withdraw") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      parseEmptyMutationInput(await readJsonBody(req));
      cleanData = sanitizeKycRightsMutationData(
        await callRpc(
          PARTNERS_RPC.biometricConsentWithdraw,
          {
            p_user_id: userId,
            p_idempotency_key: idempotencyKey,
          },
          "mutation",
        ),
        "biometric_consent_withdrawn",
      );
    } else if (route === "/kyc/reviews") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      const input = parseKycHumanReviewInput(await readJsonBody(req));
      cleanData = sanitizeKycRightsMutationData(
        await callRpc(
          PARTNERS_RPC.kycHumanReviewRequest,
          {
            p_user_id: userId,
            p_reason: input.reason,
            p_idempotency_key: idempotencyKey,
          },
          "mutation",
        ),
        "kyc_human_review_requested",
      );
      status = 201;
    } else if (route === "/kyc/sessions") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      if (!DIDIT_CONFIG || !DIDIT_PURGE_KEYRING) {
        throw new PublicApiError(
          503,
          "provider_not_configured",
          "Identity verification is not configured.",
        );
      }
      let input;
      try {
        input = parseKycSessionInput(
          await readJsonBody(req),
        );
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        throw new PublicApiError(
          400,
          "invalid_request",
          "The request payload is invalid.",
        );
      }
      const prepared = sanitizeKycPrepareRpc(
        await callRpc(
          PARTNERS_RPC.kycPrepare,
          {
            p_user_id: userId,
            p_idempotency_key: idempotencyKey,
            p_disclosure_version: input.consentVersion,
            p_biometric_consent_version: input.biometricConsentVersion,
            p_capacity_attested: input.capacityConfirmed,
            p_language: input.language,
          },
          "mutation",
        ),
      );
      // Didit documents create-session as idempotent for an unfinished
      // (workflow_id, vendor_data) pair. The database reservation is opaque,
      // scoped to this KYC attempt and stable across retries, so an external
      // success followed by a database/network failure cannot create a second
      // hosted session.
      const vendorData = prepared.kyc.reservation_key;
      const providerSession = await createDiditSession(
        DIDIT_CONFIG,
        vendorData,
        input.language,
      );
      const providerConfigFingerprint = await diditConfigFingerprint(
        DIDIT_CONFIG,
        providerSession.workflowVersion,
      );
      const providerSessionHash = await diditProviderSessionHash(
        providerSession.sessionId,
      );
      const providerSessionEnvelope = await encryptDiditPurgeEnvelope(
        providerSession.sessionId,
        providerSessionHash,
        DIDIT_PURGE_KEYRING,
      );
      const recorded = sanitizeKycSessionRecordRpc(
        await callRpc(
          PARTNERS_RPC.kycSessionRecord,
          {
            p_user_id: userId,
            p_idempotency_key: idempotencyKey,
            p_provider_session_id: providerSession.sessionId,
            p_provider_workflow_id: providerSession.workflowId,
            p_provider_workflow_version: providerSession.workflowVersion,
            p_provider_status: providerSession.providerStatus,
            p_expires_at: null,
            p_reservation_key: prepared.kyc.reservation_key,
            p_provider_environment: DIDIT_CONFIG.environment,
            p_provider_config_fingerprint: providerConfigFingerprint,
            p_provider_session_ttl_seconds:
              DIDIT_CONFIG.sessionExpirationSeconds,
            p_provider_session_envelope: providerSessionEnvelope,
          },
          "mutation",
        ),
      );
      if (recorded.session_disposition === "withdrawn") {
        throw new PublicApiError(
          409,
          "biometric_consent_withdrawn",
          "Identity verification was cancelled because biometric consent was withdrawn.",
        );
      }
      if (recorded.session_disposition === "terminal") {
        throw new PublicApiError(
          409,
          "request_in_progress",
          "Identity verification is being finalized.",
        );
      }
      cleanData = {
        schema_version: 1,
        action: "kyc_session_created",
        replayed: prepared.replayed && recorded.replayed,
        verification: {
          provider: "didit",
          status: recorded.kyc.status,
          url: providerSession.hostedUrl,
          expires_at: recorded.kyc.expires_at,
        },
      };
      status = 201;
    } else if (route === "/kyc/certification") {
      assertNoQueryParameters(url);
      if (!DIDIT_CERTIFICATION_ENABLED) {
        throw new PublicApiError(
          503,
          "didit_certification_disabled",
          "Didit certification is not available.",
        );
      }
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      if (!DIDIT_CONFIG) {
        throw new PublicApiError(
          503,
          "provider_not_configured",
          "Identity verification is not configured.",
        );
      }
      let input;
      try {
        input = parseKycCertificationInput(await readJsonBody(req));
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        throw new PublicApiError(
          400,
          "invalid_request",
          "The request payload is invalid.",
        );
      }
      // This privileged pre-gate reservation must execute as the verified
      // caller, not as service_role: the RPC authorizes auth.uid() and the
      // fresh AAL2 claim. GoTrue validation above remains authoritative.
      const caller = createCallerClient(token);
      const prepared = sanitizeKycCertificationPrepareRpc(
        await callRpcWithClient(
          caller,
          PARTNERS_RPC.kycCertificationPrepare,
          {
            p_idempotency_key: idempotencyKey,
            p_consent_version: input.consentVersion,
            p_capacity_attested: input.capacityConfirmed,
            p_language: input.language,
            p_confirmation: input.confirmation,
            p_justification: input.justification,
          },
          "mutation",
        ),
      );
      cleanData = await createCertificationHostedSession(
        prepared,
        input.language,
      );
      status = 201;
    } else if (route === "/kyc/certification/resume") {
      assertNoQueryParameters(url);
      if (!DIDIT_CERTIFICATION_ENABLED) {
        throw new PublicApiError(
          503,
          "didit_certification_disabled",
          "Didit certification is not available.",
        );
      }
      if (!DIDIT_CONFIG) {
        throw new PublicApiError(
          503,
          "provider_not_configured",
          "Identity verification is not configured.",
        );
      }
      parseEmptyMutationInput(await readJsonBody(req));
      // Resume is deliberately server-derived: the browser never persists a
      // provider id, hosted URL or the original free-text justification. The
      // caller-scoped RPC rechecks live Admin+Risk, AAL2, JWT freshness and all
      // pre-gate locks before returning the same opaque certification key.
      const caller = createCallerClient(token);
      const prepared = sanitizeKycCertificationPrepareRpc(
        await callRpcWithClient(
          caller,
          PARTNERS_RPC.kycCertificationResume,
          {},
          "mutation",
        ),
      );
      cleanData = await createCertificationHostedSession(prepared, "fr");
    } else if (route === "/referral/claim") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      if (!REFERRAL_SECRETS) {
        throw new PublicApiError(
          503,
          "referral_not_configured",
          "Referral attribution is not configured.",
        );
      }
      let claimToken: string;
      let claimHash: string;
      try {
        claimToken = parseClaimInput(await readJsonBody(req)).claimToken;
        claimHash = await claimHashFromSignedToken(
          claimToken,
          REFERRAL_SECRETS.cookieSecret,
        );
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        throw new PublicApiError(
          400,
          "invalid_request",
          "The request payload is invalid.",
        );
      }
      cleanData = sanitizeReferralClaimRpc(
        await callRpc(
          PARTNERS_RPC.referralClaim,
          {
            p_user_id: userId,
            p_claim_hash: claimHash,
            p_idempotency_key: idempotencyKey,
          },
          "mutation",
        ),
      );
    } else if (route === "/payout-profile") {
      assertNoQueryParameters(url);
      cleanData = sanitizePayoutProfileGet(
        await callRpc(PARTNERS_RPC.payoutProfileGet, {
          p_user_id: userId,
        }),
      );
    } else if (route === "/fiscal-profile") {
      assertNoQueryParameters(url);
      if (req.method === "GET") {
        cleanData = sanitizeFiscalProfileGet(
          await callRpc(PARTNERS_RPC.fiscalProfileGet, {
            p_user_id: userId,
          }),
        );
      } else {
        const idempotencyKey = parseIdempotencyKey(
          req.headers.get("Idempotency-Key"),
        );
        const input = parseFiscalProfileInput(await readJsonBody(req));
        const operation = "fiscal_profile_self_attestation" as const;
        const requestHash = await partnersMemberWriteRequestHash(operation, [
          input.countryCode,
          input.declarationVersion,
          "accepted",
        ]);
        sanitizeMemberWriteReservation(
          await callRpc(
            PARTNERS_RPC.memberWriteReserve,
            {
              p_user_id: userId,
              p_operation: operation,
              p_idempotency_key: idempotencyKey,
              p_request_hash: requestHash,
            },
            "mutation",
          ),
          operation,
        );
        cleanData = sanitizeFiscalProfileMutation(
          await callRpc(
            PARTNERS_RPC.fiscalProfileSelfAttest,
            {
              p_user_id: userId,
              p_country_code: input.countryCode,
              p_declaration_version: input.declarationVersion,
              p_declaration_accepted: input.declarationAccepted,
              p_idempotency_key: idempotencyKey,
            },
            "mutation",
          ),
        );
        status = 201;
      }
    } else if (route === "/payout-onboarding") {
      assertNoQueryParameters(url);
      if (req.method === "GET") {
        cleanData = sanitizePayoutOnboardingGet(
          await callRpc(PARTNERS_RPC.payoutOnboardingGet, {
            p_user_id: userId,
          }),
        );
      } else {
        const idempotencyKey = parseIdempotencyKey(
          req.headers.get("Idempotency-Key"),
        );
        const input = parsePayoutOnboardingInput(await readJsonBody(req));
        const operation = "payout_onboarding" as const;
        const requestHash = await partnersMemberWriteRequestHash(operation, [
          input.currency,
          "contact-consent",
        ]);
        sanitizeMemberWriteReservation(
          await callRpc(
            PARTNERS_RPC.memberWriteReserve,
            {
              p_user_id: userId,
              p_operation: operation,
              p_idempotency_key: idempotencyKey,
              p_request_hash: requestHash,
            },
            "mutation",
          ),
          operation,
        );
        cleanData = sanitizePayoutOnboardingMutation(
          await callRpc(
            PARTNERS_RPC.payoutOnboardingRequest,
            {
              p_user_id: userId,
              p_currency: input.currency,
              p_contact_consent: input.contactConsent,
              p_idempotency_key: idempotencyKey,
            },
            "mutation",
          ),
        );
        status = 201;
      }
    } else if (route === "/tv-relays/consume") {
      assertNoQueryParameters(url);
      const idempotencyKey = parseIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
      if (!TV_RELAY_CONFIG) {
        throw new PublicApiError(
          503,
          "tv_relay_not_configured",
          "Partners TV relay is not configured.",
        );
      }
      let relayTokenHash: string;
      try {
        const input = parseTvRelayTokenInput(await readJsonBody(req));
        relayTokenHash = await relayTokenHashFromSignedToken(
          input.relayToken,
          TV_RELAY_CONFIG.secret,
        );
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        throw new PublicApiError(
          400,
          "invalid_request",
          "The request payload is invalid.",
        );
      }
      cleanData = sanitizeTvRelayConsumeRpc(
        await callRpc(
          PARTNERS_RPC.tvRelayConsume,
          {
            p_user_id: userId,
            p_relay_token_hash: relayTokenHash,
            p_idempotency_key: idempotencyKey,
          },
          "mutation",
        ),
      );
    } else {
      const query = parseDashboardQuery(url);
      const data = await callRpc(PARTNERS_RPC.dashboard, {
        p_user_id: userId,
        p_history_limit: query.historyLimit,
        p_history_cursor: query.historyCursor,
        p_history_status: query.historyStatus,
      });
      cleanData = sanitizeDashboardData(data, query);
    }

    logOutcome("info", correlationId, route, "ok");
    return jsonResponse(req, correlationId, { data: cleanData }, status);
  } catch (error) {
    const problem = publicProblem(error);
    logOutcome(
      problem.status >= 500 ? "error" : "warn",
      correlationId,
      route,
      problem.code,
    );
    return jsonResponse(
      req,
      correlationId,
      {
        error: {
          code: problem.code,
          message: problem.message,
          ...(problem.nextState ? { nextState: problem.nextState } : {}),
        },
      },
      problem.status,
      problem.status === 405 && allowedMethods
        ? { Allow: `${allowedMethods.join(", ")}, OPTIONS` }
        : problem.code === "request_in_progress"
        ? { "Retry-After": "2" }
        : problem.code === "rate_limited"
        ? { "Retry-After": "60" }
        : undefined,
    );
  }
});

async function createDiditSession(
  config: NonNullable<typeof DIDIT_CONFIG>,
  vendorData: string,
  language: string,
) {
  let response: Response;
  try {
    response = await fetch(DIDIT_CREATE_SESSION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify(diditCreateBody(config, vendorData, language)),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }

  if (response.status !== 201) {
    // A documented credit failure is encoded in a 400 JSON body by Didit.
    // Read at most 4 KiB solely for allowlisted classification; the body is
    // never logged, returned, persisted or included in an exception.
    const boundedBody = response.status === 400
      ? await readBoundedDiditResponseBody(response, 4_096)
      : (await discardDiditResponseBody(response), null);
    const providerError = classifyDiditCreateError(
      response.status,
      boundedBody,
    );
    if (providerError === "rate_limited") {
      throw new PublicApiError(
        429,
        "rate_limited",
        "Identity verification is temporarily rate limited.",
      );
    }
    if (providerError === "credits_unavailable") {
      throw new PublicApiError(
        503,
        "kyc_billing_unavailable",
        "Identity verification is temporarily unavailable.",
      );
    }
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new PublicApiError(
        503,
        "provider_not_configured",
        "Identity verification is not configured.",
      );
    }
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  if (
    !text ||
    new TextEncoder().encode(text).byteLength > 65_536
  ) {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  try {
    return sanitizeDiditCreatedSession(
      JSON.parse(text),
      config,
      vendorData,
    );
  } catch (error) {
    if (error instanceof DiditContractError || error instanceof SyntaxError) {
      throw new PublicApiError(
        503,
        "provider_temporarily_unavailable",
        "Identity verification is temporarily unavailable.",
      );
    }
    throw error;
  }
}

async function discardDiditResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The public classification remains generic if cancellation races a close.
  }
}

async function callRpc(
  rpcName: string,
  args: Record<string, unknown>,
  requestKind: "query" | "mutation" = "query",
): Promise<unknown> {
  return await callRpcWithClient(admin, rpcName, args, requestKind);
}

async function callRpcWithClient(
  db: SupabaseClient,
  rpcName: string,
  args: Record<string, unknown>,
  requestKind: "query" | "mutation" = "query",
): Promise<unknown> {
  const { data, error } = await db.rpc(rpcName, args);
  if (error) {
    const mapped = mapDatabaseError(error, requestKind);
    throw new PublicApiError(mapped.status, mapped.code, mapped.message);
  }
  return data;
}

function createCallerClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

function certificationPublicStatus(
  providerStatus: string,
  recordedStatus: "pending" | "in_review",
): "not_started" | "in_progress" | "awaiting_user" {
  if (recordedStatus === "in_review") return "in_progress";
  if (providerStatus === "not_started") return "not_started";
  if (providerStatus === "awaiting_user") return "awaiting_user";
  return "in_progress";
}

async function listCertificationHostedSessions(
  config: NonNullable<typeof DIDIT_CONFIG>,
  prepared: ReturnType<typeof sanitizeKycCertificationPrepareRpc>,
) {
  const listUrl = new URL(DIDIT_LIST_SESSIONS_URL);
  listUrl.searchParams.set("vendor_data", prepared.certification.key);
  listUrl.searchParams.set("workflow_id", config.workflowId);
  listUrl.searchParams.set("session_kind", "user");
  // Two results are enough to prove ambiguity without downloading more of
  // Didit's PII-rich session representation.
  listUrl.searchParams.set("limit", "2");

  let response: Response;
  try {
    response = await fetch(listUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-api-key": config.apiKey,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }

  if (response.status !== 200) {
    await discardDiditResponseBody(response);
    if (response.status === 429) {
      throw new PublicApiError(
        429,
        "rate_limited",
        "Identity verification is temporarily rate limited.",
      );
    }
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new PublicApiError(
        503,
        "provider_not_configured",
        "Identity verification is not configured.",
      );
    }
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await discardDiditResponseBody(response);
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }

  const text = await readBoundedDiditResponseBody(response, 32_768);
  if (!text) {
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
  try {
    return inspectDiditSessionList(
      JSON.parse(text),
      config,
      prepared.certification.key,
    );
  } catch (error) {
    if (error instanceof DiditSessionNotResumableError) {
      throw new PublicApiError(
        409,
        "request_in_progress",
        "Identity verification is still being reconciled.",
      );
    }
    throw new PublicApiError(
      503,
      "provider_temporarily_unavailable",
      "Identity verification is temporarily unavailable.",
    );
  }
}

async function recoverCertificationHostedSession(
  prepared: ReturnType<typeof sanitizeKycCertificationPrepareRpc>,
  providerSession: DiditActiveSession,
): Promise<Record<string, unknown>> {
  // The list response is not authoritative for the local binding. This
  // service-only RPC hashes the candidate session id and compares it to the
  // existing private registry row before any hosted URL can leave the Edge.
  const matched = sanitizeKycCertificationBindingMatchRpc(
    await callRpc(
      PARTNERS_RPC.kycCertificationBindingMatch,
      {
        p_certification_key: prepared.certification.key,
        p_provider_session_id: providerSession.sessionId,
      },
      "mutation",
    ),
  );
  return {
    schema_version: 1,
    action: "kyc_certification_session_created",
    replayed: true,
    verification: {
      provider: "didit",
      status: certificationPublicStatus(
        providerSession.providerStatus,
        matched.certification.status,
      ),
      url: providerSession.hostedUrl,
      expires_at: matched.certification.expires_at,
    },
  };
}

async function claimCertificationCreateDispatch(
  prepared: ReturnType<typeof sanitizeKycCertificationPrepareRpc>,
) {
  return sanitizeKycCertificationCreateClaimRpc(
    await callRpc(
      PARTNERS_RPC.kycCertificationCreateClaim,
      { p_certification_key: prepared.certification.key },
      "mutation",
    ),
  );
}

async function createCertificationHostedSession(
  prepared: ReturnType<typeof sanitizeKycCertificationPrepareRpc>,
  language: string,
): Promise<Record<string, unknown>> {
  const config = DIDIT_CONFIG;
  if (!config) {
    throw new PublicApiError(
      503,
      "provider_not_configured",
      "Identity verification is not configured.",
    );
  }
  // Every attempt first reconciles the exact opaque vendor_data against Didit.
  // This read occurs before the irreversible SQL dispatch claim and before any
  // POST, so a terminal or ambiguous provider reality always fails closed.
  const inspection = await listCertificationHostedSessions(config, prepared);

  // `pending` means the private registry already contains a provider binding.
  // Never POST in that state: recover the one exact active provider session,
  // then prove its raw id against the local hash through a service-only RPC.
  if (prepared.certification.status === "pending") {
    if (inspection.kind !== "active") {
      throw new PublicApiError(
        409,
        "request_in_progress",
        "Identity verification is still being reconciled.",
      );
    }
    return await recoverCertificationHostedSession(
      prepared,
      inspection.session,
    );
  }

  // A row lock makes this NULL -> timestamp transition one-way. If another
  // replica saw the same empty list, only the winner may issue the first POST.
  // An active list candidate is bound directly and is never POSTed again: it
  // may become terminal immediately after this read, and Didit would otherwise
  // create a second charged session instead of replaying it.
  const claim = await claimCertificationCreateDispatch(prepared);
  if (inspection.kind === "active") {
    const providerConfigFingerprint = await diditConfigFingerprint(
      config,
      DIDIT_PARTNERS_WORKFLOW_VERSION,
    );
    const recorded = sanitizeKycCertificationSessionRecordRpc(
      await callRpc(
        PARTNERS_RPC.kycCertificationSessionRecord,
        {
          p_certification_key: prepared.certification.key,
          p_provider_session_id: inspection.session.sessionId,
          p_provider_workflow_id: inspection.session.workflowId,
          p_provider_workflow_version: DIDIT_PARTNERS_WORKFLOW_VERSION,
          p_provider_status: inspection.session.providerStatus,
          p_provider_environment: config.environment,
          p_provider_config_fingerprint: providerConfigFingerprint,
          p_provider_session_ttl_seconds: config.sessionExpirationSeconds,
        },
        "mutation",
      ),
    );
    return {
      schema_version: 1,
      action: "kyc_certification_session_created",
      replayed: true,
      verification: {
        provider: "didit",
        status: certificationPublicStatus(
          inspection.session.providerStatus,
          recorded.certification.status,
        ),
        url: inspection.session.hostedUrl,
        expires_at: recorded.certification.expires_at,
      },
    };
  }
  if (!claim.claimed) {
    throw new PublicApiError(
      409,
      "request_in_progress",
      "Identity verification is still being reconciled.",
    );
  }
  const providerSession = await createDiditSession(
    config,
    prepared.certification.key,
    language,
  );
  const providerConfigFingerprint = await diditConfigFingerprint(
    config,
    providerSession.workflowVersion,
  );
  const recorded = sanitizeKycCertificationSessionRecordRpc(
    await callRpc(
      PARTNERS_RPC.kycCertificationSessionRecord,
      {
        p_certification_key: prepared.certification.key,
        p_provider_session_id: providerSession.sessionId,
        p_provider_workflow_id: providerSession.workflowId,
        p_provider_workflow_version: providerSession.workflowVersion,
        p_provider_status: providerSession.providerStatus,
        p_provider_environment: config.environment,
        p_provider_config_fingerprint: providerConfigFingerprint,
        p_provider_session_ttl_seconds: config.sessionExpirationSeconds,
      },
      "mutation",
    ),
  );
  return {
    schema_version: 1,
    action: "kyc_certification_session_created",
    replayed: prepared.replayed && recorded.replayed,
    verification: {
      provider: "didit",
      status: certificationPublicStatus(
        providerSession.providerStatus,
        recorded.certification.status,
      ),
      url: providerSession.hostedUrl,
      expires_at: recorded.certification.expires_at,
    },
  };
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new PublicApiError(
      415,
      "invalid_content_type",
      "Content-Type must be application/json.",
    );
  }

  const contentLength = req.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d{1,8}$/.test(contentLength) || Number(contentLength) > 4_096)
  ) {
    throw new PublicApiError(
      413,
      "payload_too_large",
      "The request payload is too large.",
    );
  }

  let text: string;
  try {
    const reader = req.body?.getReader();
    if (!reader) throw new Error("missing_body");
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > 4_096) {
        try {
          await reader.cancel("payload_too_large");
        } catch {
          // Best-effort cancellation only; the public response remains 413.
        }
        throw new PublicApiError(
          413,
          "payload_too_large",
          "The request payload is too large.",
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    throw new PublicApiError(
      400,
      "invalid_request",
      "The request payload is invalid.",
    );
  }
  if (
    !text ||
    new TextEncoder().encode(text).byteLength > 4_096
  ) {
    throw new PublicApiError(
      text ? 413 : 400,
      text ? "payload_too_large" : "invalid_request",
      text
        ? "The request payload is too large."
        : "The request payload is invalid.",
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PublicApiError(
      400,
      "invalid_request",
      "The request payload is invalid.",
    );
  }
}

async function requireUserId(
  token: string,
  db: SupabaseClient,
): Promise<string> {
  const local = await verifyUserJwtLocally(token);
  if (local === "invalid") {
    throw new PublicApiError(
      401,
      "invalid_access_token",
      "The access token is invalid.",
    );
  }

  // Partners includes contractual mutations and will later expose financial
  // reporting. GoTrue is therefore authoritative on every route, including
  // locally verifiable HS256 tokens, so a revoked/deleted account cannot keep
  // using the member boundary until JWT expiry. The local result remains an
  // early rejection and must agree with GoTrue when it is conclusive.
  const { data, error } = await db.auth.getUser(token);
  if (
    !error &&
    data.user &&
    isUuid(data.user.id) &&
    (
      local === "fallback" ||
      (isUuid(local.id) && local.id === data.user.id)
    )
  ) {
    return data.user.id;
  }
  throw new PublicApiError(
    401,
    "invalid_access_token",
    "The access token is invalid.",
  );
}

function publicProblem(
  error: unknown,
): Pick<PublicApiError, "status" | "code" | "message" | "nextState"> {
  if (error instanceof PublicApiError) return error;
  if (error instanceof BootstrapContractError) {
    return {
      status: 503,
      code: "partners_temporarily_unavailable",
      message: "Norva Partners is temporarily unavailable.",
    };
  }
  return {
    status: 503,
    code: "partners_temporarily_unavailable",
    message: "Norva Partners is temporarily unavailable.",
  };
}

function jsonResponse(
  req: Request,
  correlationId: string,
  payload:
    | { data: unknown }
    | {
      error: {
        code: string;
        message: string;
        nextState?: "business_waitlist";
      };
    },
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      version: PARTNERS_API_VERSION,
      correlationId,
      ...payload,
    }),
    {
      status,
      headers: {
        ...responseHeaders(req.headers.get("Origin"), correlationId),
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
    },
  );
}

function responseHeaders(
  origin: string | null,
  correlationId: string,
): Record<string, string> {
  return {
    ...corsHeaders(origin, ALLOWED_ORIGINS),
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Correlation-Id": correlationId,
  };
}

function createCorrelationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `prt_${
    Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

function logOutcome(
  level: "info" | "warn" | "error",
  correlationId: string,
  route: string,
  outcome: string,
): void {
  // Deliberately excludes URL/query, JWT, e-mail, user/account UUID, affiliate
  // code and RPC/provider payloads. An arbitrary path is also collapsed so a
  // caller cannot inject identifying text into logs through the request URL.
  // correlationId is random request metadata.
  const safeRoute = allowedMethodsForRoute(route) ? route : "/unknown";
  console[level]("[norva-partners]", {
    correlationId,
    route: safeRoute,
    outcome,
  });
}
