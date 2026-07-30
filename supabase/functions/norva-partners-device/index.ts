import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  assertAllowedOrigin,
  assertNoQueryParameters,
  assertValidPreflight,
  corsHeaders,
  mapDatabaseError,
  parseAllowedOrigins,
  parseBearerToken,
  parseEmptyMutationInput,
  parseIdempotencyKey,
  PARTNERS_API_VERSION,
  PublicApiError,
} from "../_shared/partners-api.ts";
import { sha256Hex } from "../_shared/partners-crypto.ts";
import {
  assertDeviceToken,
  loadTvRelayConfig,
  localTvRelayUnavailable,
  PARTNERS_TV_RELAY_RPC,
  parseTvRelayTokenInput,
  prepareTvRelay,
  relayTokenHashFromSignedToken,
  sanitizeTvRelayAvailabilityRpc,
  sanitizeTvRelayCreateRpc,
  sanitizeTvRelayStatusRpc,
} from "../_shared/partners-tv-relay.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  Deno.env.get("NORVA_PARTNERS_DEVICE_ALLOWED_ORIGINS") ??
    Deno.env.get("NORVA_PARTNERS_ALLOWED_ORIGINS"),
);
const TV_RELAY_CONFIG = loadTvRelayConfig((name) => Deno.env.get(name));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing required Norva Partners device configuration");
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
    assertNoQueryParameters(url);

    const token = parseBearerToken(req.headers.get("Authorization"));
    const deviceHash = await requireTvDeviceHash(token, admin);
    let cleanData: Record<string, unknown>;
    let status = 200;

    if (route === "/availability") {
      if (!TV_RELAY_CONFIG) {
        cleanData = localTvRelayUnavailable();
      } else {
        cleanData = sanitizeTvRelayAvailabilityRpc(
          await callRpc(PARTNERS_TV_RELAY_RPC.availability, {
            p_device_hash: deviceHash,
          }),
        );
      }
    } else {
      if (!TV_RELAY_CONFIG) {
        throw new PublicApiError(
          503,
          "tv_relay_not_configured",
          "Partners TV relay is not configured.",
        );
      }
      if (route === "/relays") {
        const idempotencyKey = parseIdempotencyKey(
          req.headers.get("Idempotency-Key"),
        );
        parseEmptyMutationInput(await readJsonBody(req));
        const prepared = await prepareTvRelay(
          TV_RELAY_CONFIG,
          deviceHash,
          idempotencyKey,
        );
        cleanData = sanitizeTvRelayCreateRpc(
          await callRpc(
            PARTNERS_TV_RELAY_RPC.create,
            {
              p_device_hash: deviceHash,
              p_relay_token_hash: prepared.relayTokenHash,
              p_request_nonce_hash: prepared.requestNonceHash,
              p_expires_at: prepared.expiresAt,
            },
            "mutation",
          ),
          prepared,
        );
        status = 201;
      } else {
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
        cleanData = sanitizeTvRelayStatusRpc(
          await callRpc(PARTNERS_TV_RELAY_RPC.status, {
            p_device_hash: deviceHash,
            p_relay_token_hash: relayTokenHash,
          }),
        );
      }
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
        },
      },
      problem.status,
      problem.status === 405 && allowedMethods
        ? { Allow: `${allowedMethods.join(", ")}, OPTIONS` }
        : problem.code === "request_in_progress" ||
            problem.code === "rate_limited"
        ? { "Retry-After": "3" }
        : undefined,
    );
  }
});

async function requireTvDeviceHash(
  token: string,
  db: SupabaseClient,
): Promise<string> {
  try {
    assertDeviceToken(token);
  } catch {
    throw new PublicApiError(
      401,
      "invalid_access_token",
      "The device access token is invalid.",
    );
  }
  const deviceHash = await sha256Hex(token);
  const { data, error } = await db
    .from("cloud_devices")
    .select("device_token_hash")
    .eq("device_token_hash", deviceHash)
    .eq("device_type", "tv")
    .eq("trusted", true)
    .eq("revoked", false)
    .maybeSingle();
  if (error) {
    throw new PublicApiError(
      503,
      "partners_temporarily_unavailable",
      "Norva Partners is temporarily unavailable.",
    );
  }
  if (
    !data ||
    typeof data.device_token_hash !== "string" ||
    data.device_token_hash !== deviceHash
  ) {
    throw new PublicApiError(
      401,
      "invalid_access_token",
      "The device access token is invalid.",
    );
  }
  return deviceHash;
}

async function callRpc(
  rpcName: string,
  args: Record<string, unknown>,
  requestKind: "query" | "mutation" = "query",
): Promise<unknown> {
  const { data, error } = await admin.rpc(rpcName, args);
  if (error) {
    const code = typeof error.code === "string" ? error.code : "";
    if (code === "P0006") {
      throw new PublicApiError(
        404,
        "tv_relay_not_found",
        "The TV relay is unavailable.",
      );
    }
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
  if (!text || new TextEncoder().encode(text).byteLength > 4_096) {
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

function allowedMethodsForRoute(route: string): readonly string[] | null {
  if (route === "/availability") return ["GET"];
  if (route === "/relays" || route === "/relays/status") return ["POST"];
  return null;
}

function routeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("norva-partners-device");
  if (marker >= 0) return `/${parts.slice(marker + 1).join("/")}`;
  return `/${parts.join("/")}`;
}

function publicProblem(
  error: unknown,
): Pick<PublicApiError, "status" | "code" | "message"> {
  if (error instanceof PublicApiError) return error;
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
    | { error: { code: string; message: string } },
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
  return `ptv_${
    Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

function logOutcome(
  level: "info" | "warn" | "error",
  correlationId: string,
  route: string,
  outcome: string,
): void {
  // Never logs the device token/hash, relay token/hash, handoff URL, user id,
  // database payload or arbitrary request path.
  const safeRoute = allowedMethodsForRoute(route) ? route : "/unknown";
  console[level]("[norva-partners-device]", {
    correlationId,
    route: safeRoute,
    outcome,
  });
}
