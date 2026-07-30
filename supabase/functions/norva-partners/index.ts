import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import {
  DIDIT_CREATE_SESSION_URL,
  DiditContractError,
  diditCreateBody,
  loadDiditConfig,
  parseKycSessionInput,
  sanitizeDiditCreatedSession,
  sanitizeKycPrepareRpc,
  sanitizeKycSessionRecordRpc,
} from "../_shared/didit-partners.ts";
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
  parseAllowedOrigins,
  parseApplicationInput,
  parseBearerToken,
  parseBootstrapQuery,
  parseDashboardQuery,
  parseEmptyMutationInput,
  parseIdempotencyKey,
  PARTNERS_API_VERSION,
  PARTNERS_RPC,
  PublicApiError,
  routeFromPath,
  sanitizeBootstrapData,
  sanitizeDashboardData,
  sanitizeMutationData,
} from "../_shared/partners-api.ts";
import {
  parsePayoutProfileInput,
  PayoutContractError,
  sanitizePayoutProfileGet,
  sanitizePayoutProfileSet,
} from "../_shared/partners-payout.ts";
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
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  Deno.env.get("NORVA_PARTNERS_ALLOWED_ORIGINS"),
);
const DIDIT_CONFIG = loadDiditConfig((name) => Deno.env.get(name));
const REFERRAL_SECRETS = loadReferralSecrets((name) => Deno.env.get(name));
const TV_RELAY_CONFIG = loadTvRelayConfig((name) => Deno.env.get(name));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
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
    } else if (route === "/kyc/sessions") {
      assertNoQueryParameters(url);
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
            p_consent_version: input.consentVersion,
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
          },
          "mutation",
        ),
      );
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
      if (req.method === "GET") {
        cleanData = sanitizePayoutProfileGet(
          await callRpc(PARTNERS_RPC.payoutProfileGet, {
            p_user_id: userId,
          }),
        );
      } else {
        const idempotencyKey = parseIdempotencyKey(
          req.headers.get("Idempotency-Key"),
        );
        let input;
        try {
          input = parsePayoutProfileInput(await readJsonBody(req));
        } catch (error) {
          if (error instanceof PublicApiError) throw error;
          if (error instanceof PayoutContractError) {
            throw new PublicApiError(
              400,
              "invalid_request",
              "The request payload is invalid.",
            );
          }
          throw error;
        }
        cleanData = sanitizePayoutProfileSet(
          await callRpc(
            PARTNERS_RPC.payoutProfileSet,
            {
              p_user_id: userId,
              p_idempotency_key: idempotencyKey,
              p_provider: input.provider,
              p_beneficiary_token_ref: input.beneficiaryTokenRef,
              p_display_masked: input.displayMasked,
              p_currency: input.currency,
            },
            "mutation",
          ),
        );
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
    // Provider error bodies can contain configuration details or user input;
    // they are deliberately neither read into logs nor forwarded.
    try {
      await response.body?.cancel();
    } catch {
      // Nothing else to do: the public error below is intentionally generic.
    }
    if (response.status === 402) {
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

async function callRpc(
  rpcName: string,
  args: Record<string, unknown>,
  requestKind: "query" | "mutation" = "query",
): Promise<unknown> {
  const { data, error } = await admin.rpc(rpcName, args);
  if (error) {
    const mapped = mapDatabaseError(error, requestKind);
    throw new PublicApiError(mapped.status, mapped.code, mapped.message);
  }
  return data;
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
    text = await req.text();
  } catch {
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
