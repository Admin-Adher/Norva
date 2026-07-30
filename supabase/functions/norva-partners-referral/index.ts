import { createClient } from "npm:@supabase/supabase-js@2";
import {
  assertValidInternalSignature,
  loadReferralSecrets,
  newReferralClaim,
  parseReferralResolveInput,
  ReferralContractError,
  sanitizeReferralResolveRpc,
} from "../_shared/partners-referral.ts";
import { sha256Hex } from "../_shared/partners-crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const REFERRAL_SECRETS = loadReferralSecrets((name) => Deno.env.get(name));
const MAX_BODY_BYTES = 4_096;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing required Norva referral server configuration");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const correlationId = correlation();
  try {
    const url = new URL(req.url);
    const route = routeFromPath(url.pathname);
    if (route !== "/resolve") {
      return problem(404, "route_not_found", correlationId);
    }
    if (req.method !== "POST") {
      return problem(405, "method_not_allowed", correlationId, {
        Allow: "POST",
      });
    }
    if (url.search || url.hash) {
      return problem(400, "invalid_request", correlationId);
    }
    if (!REFERRAL_SECRETS) {
      return problem(503, "referral_not_configured", correlationId);
    }
    const contentType = req.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      return problem(415, "invalid_content_type", correlationId);
    }
    const length = req.headers.get("Content-Length");
    if (
      length !== null &&
      (!/^\d{1,8}$/.test(length) || Number(length) > MAX_BODY_BYTES)
    ) {
      return problem(413, "payload_too_large", correlationId);
    }
    const rawBody = new Uint8Array(await req.arrayBuffer());
    if (rawBody.byteLength < 2 || rawBody.byteLength > MAX_BODY_BYTES) {
      return problem(413, "payload_too_large", correlationId);
    }
    let nonceHash: string;
    let input;
    try {
      ({ nonceHash } = await assertValidInternalSignature(
        req,
        rawBody,
        REFERRAL_SECRETS.edgeHmacSecret,
        "/resolve",
      ));
      input = parseReferralResolveInput(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)),
      );
    } catch (error) {
      if (
        error instanceof ReferralContractError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      ) {
        log("warn", correlationId, "rejected");
        return problem(401, "internal_authentication_failed", correlationId);
      }
      throw error;
    }

    const claim = await newReferralClaim(REFERRAL_SECRETS.cookieSecret);
    const { data, error } = await admin.rpc(
      "partners_service_referral_resolve",
      {
        p_code_hash: await sha256Hex(input.code),
        p_claim_hash: claim.claimHash,
        p_expires_at: claim.expiresAt,
        p_request_nonce_hash: nonceHash,
        p_network_hash: input.networkHash,
        p_user_agent_hash: input.userAgentHash,
      },
    );
    if (error) {
      if (error.code === "P0005") {
        log("warn", correlationId, "rate_limited");
        return problem(429, "rate_limited", correlationId, {
          "Retry-After": "60",
        });
      }
      log("error", correlationId, "database_unavailable");
      return problem(503, "temporarily_unavailable", correlationId);
    }
    let result;
    try {
      result = sanitizeReferralResolveRpc(data);
    } catch {
      log("error", correlationId, "database_contract_invalid");
      return problem(503, "temporarily_unavailable", correlationId);
    }
    if (!result.accepted) {
      log("info", correlationId, "unavailable");
      return json(200, { accepted: false }, correlationId);
    }
    if (Date.parse(result.expiresAt!) !== Date.parse(claim.expiresAt)) {
      log("error", correlationId, "expiry_contract_invalid");
      return problem(503, "temporarily_unavailable", correlationId);
    }
    log("info", correlationId, "resolved");
    return json(
      200,
      {
        accepted: true,
        cookieToken: claim.cookieToken,
        expiresAt: claim.expiresAt,
      },
      correlationId,
    );
  } catch {
    log("error", correlationId, "unhandled");
    return problem(503, "temporarily_unavailable", correlationId);
  }
});

function routeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("norva-partners-referral");
  if (marker >= 0) return `/${parts.slice(marker + 1).join("/")}`;
  if (parts.length === 1) return `/${parts[0]}`;
  return `/${parts.join("/")}`;
}

function json(
  status: number,
  data: Record<string, unknown>,
  correlationId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return envelope(status, { data }, correlationId, extraHeaders);
}

function envelope(
  status: number,
  payload: Record<string, unknown>,
  correlationId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ version: "2026-07-29", correlationId, ...payload }),
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/json; charset=utf-8",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Correlation-Id": correlationId,
        ...extraHeaders,
      },
    },
  );
}

function problem(
  status: number,
  code: string,
  correlationId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return envelope(
    status,
    {
      error: {
        code,
        message: status >= 500
          ? "Referral attribution is temporarily unavailable."
          : "The referral request was rejected.",
      },
    },
    correlationId,
    extraHeaders,
  );
}

function correlation(): string {
  return `prf_${
    Array.from(
      crypto.getRandomValues(new Uint8Array(12)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("")
  }`;
}

function log(
  level: "info" | "warn" | "error",
  correlationId: string,
  outcome: string,
): void {
  // Deliberately excludes the public code, claim, network/user-agent hashes,
  // nonce and all RPC payloads.
  console[level]("[norva-partners-referral]", { correlationId, outcome });
}
