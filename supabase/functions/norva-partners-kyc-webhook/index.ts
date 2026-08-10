import { createClient } from "npm:@supabase/supabase-js@2";
import {
  DIDIT_WEBHOOK_MAX_BYTES,
  DiditContractError,
  DiditDecisionAuthorityError,
  DiditPayloadTooLargeError,
  hydrateDiditDataUpdatedDecision,
  loadDiditConfig,
  readDiditWebhookBody,
  sanitizeKycCertificationWebhookRpc,
  sanitizeKycWebhookRpc,
  verifyAndNormalizeDiditWebhook,
  verifyDiditConsoleTestWebhook,
} from "../_shared/didit-partners.ts";
import {
  diditProviderSessionHash,
  encryptDiditPurgeEnvelope,
  loadDiditPurgeKeyring,
} from "../_shared/didit-purge-envelope.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const DIDIT_CONFIG = loadDiditConfig((name) => Deno.env.get(name));
const DIDIT_PURGE_KEYRING = loadDiditPurgeKeyring((name) => Deno.env.get(name));

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing required Norva Partners webhook configuration");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const correlationId = correlation();
  try {
    if (req.method !== "POST") {
      return problem(405, "method_not_allowed", correlationId, {
        Allow: "POST",
      });
    }
    const url = new URL(req.url);
    if (url.search || url.hash) {
      return problem(400, "invalid_request", correlationId);
    }
    if (!DIDIT_CONFIG || !DIDIT_PURGE_KEYRING) {
      return problem(503, "provider_not_configured", correlationId);
    }
    const contentType = req.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return problem(415, "invalid_content_type", correlationId);
    }
    const contentLength = req.headers.get("Content-Length");
    if (
      contentLength !== null &&
      (
        !/^\d{1,8}$/.test(contentLength) ||
        Number(contentLength) > DIDIT_WEBHOOK_MAX_BYTES
      )
    ) {
      return problem(413, "payload_too_large", correlationId);
    }

    let rawBody: Uint8Array;
    try {
      rawBody = await readDiditWebhookBody(
        req,
        DIDIT_WEBHOOK_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof DiditPayloadTooLargeError) {
        log("warn", correlationId, "payload_too_large");
        return problem(413, "payload_too_large", correlationId);
      }
      throw error;
    }
    let event;
    try {
      if (
        req.headers.get("X-Didit-Test-Webhook") === "true" &&
        await verifyDiditConsoleTestWebhook(
          rawBody,
          req.headers,
          DIDIT_CONFIG,
        )
      ) {
        log("info", correlationId, "test_acknowledged");
        return json(
          200,
          { received: true, test: true },
          correlationId,
        );
      }
      event = await verifyAndNormalizeDiditWebhook(
        rawBody,
        req.headers,
        DIDIT_CONFIG,
      );
    } catch (error) {
      if (error instanceof DiditContractError) {
        log("warn", correlationId, "rejected");
        return problem(401, "webhook_unauthorized", correlationId);
      }
      throw error;
    }

    try {
      event = await hydrateDiditDataUpdatedDecision(
        event,
        DIDIT_CONFIG,
      );
    } catch (error) {
      if (error instanceof DiditDecisionAuthorityError) {
        log(
          "warn",
          correlationId,
          `decision_authority_${error.code}`,
        );
        // A signed reviewer event remains retryable until the authoritative
        // full decision can be reduced safely. Never acknowledge and discard
        // a partial terminal result.
        return problem(503, "temporarily_unavailable", correlationId, {
          "Retry-After": "30",
        });
      }
      throw error;
    }

    const providerSessionHash = await diditProviderSessionHash(
      event.providerSessionId,
    );
    const providerSessionEnvelope = await encryptDiditPurgeEnvelope(
      event.providerSessionId,
      providerSessionHash,
      DIDIT_PURGE_KEYRING,
    );
    // Didit emits data.updated when a reviewer changes a feature result while
    // its aggregate session status may still read Approved. Namespace that
    // signed event before hashing so SQL can admit it only as the continuation
    // of the exact certification already under review; ordinary member KYC
    // never receives this event class.
    const certificationReviewUpdate = event.webhookType === "data.updated";
    const rpcArgs = {
      p_provider_event_id: certificationReviewUpdate
        ? `data.updated:${event.providerEventId}`
        : event.providerEventId,
      p_provider_session_id: event.providerSessionId,
      p_provider_workflow_id: event.providerWorkflowId,
      p_provider_workflow_version: event.providerWorkflowVersion,
      p_provider_status: event.providerStatus,
      p_event_created_at: event.eventCreatedAt,
      p_document_age: event.documentAge,
      p_document_country_iso3: event.documentCountryIso3,
      p_id_check_approved: event.idCheckApproved,
      p_liveness_approved: event.livenessApproved,
      p_face_match_approved: event.faceMatchApproved,
      p_payload_hash: event.payloadHash,
      p_provider_environment: event.providerEnvironment,
      p_provider_config_fingerprint: event.providerConfigFingerprint,
      p_provider_session_envelope: providerSessionEnvelope,
    };
    const certificationTerminalReview = certificationReviewUpdate && [
      "approved",
      "declined",
      "abandoned",
      "expired",
      "kyc_expired",
    ].includes(event.providerStatus);
    const certificationReviewArgs = {
      ...rpcArgs,
      p_provider_delivered_at: event.providerDeliveredAt,
    };
    let certification = certificationReviewUpdate;
    let { data, error } = certificationReviewUpdate
      ? await admin.rpc(
        certificationTerminalReview
          ? "partners_service_didit_cert_review_apply_purge"
          : "partners_service_kyc_certification_webhook_apply_purge",
        certificationTerminalReview ? certificationReviewArgs : rpcArgs,
      )
      : await admin.rpc(
        "partners_service_kyc_webhook_apply_and_enqueue_purge",
        rpcArgs,
      );
    // The member reducer owns the primary namespace. Only its explicit
    // unknown-resource signal may fall through to the tightly scoped
    // certification reducer; conflicts and every other error remain terminal.
    if (!certificationReviewUpdate && error?.code === "P0006") {
      certification = true;
      ({ data, error } = await admin.rpc(
        "partners_service_kyc_certification_webhook_apply_purge",
        rpcArgs,
      ));
    }
    if (certificationReviewUpdate && error?.code === "P0006") {
      log("info", correlationId, "certification_review_update_ignored");
      return json(
        200,
        { received: true, ignored: true },
        correlationId,
      );
    }
    if (error) {
      if (error.code === "P0003") {
        log("warn", correlationId, "event_conflict");
        return problem(409, "webhook_conflict", correlationId);
      }
      if (error.code === "P0006") {
        log("warn", correlationId, "resource_unknown");
        // Didit retries only unknown/not-found and server failures. A valid,
        // signed event can arrive before the session-record transaction is
        // visible, so 404 is the bounded retry signal; 403 would drop it.
        return problem(404, "webhook_resource_unknown", correlationId);
      }
      log("error", correlationId, "database_unavailable");
      return problem(503, "temporarily_unavailable", correlationId);
    }
    if (certification) {
      let result;
      try {
        result = sanitizeKycCertificationWebhookRpc(data);
      } catch {
        log("error", correlationId, "database_contract_invalid");
        return problem(503, "temporarily_unavailable", correlationId);
      }
      if (result.action === "kyc_certification_result_quarantined") {
        log("warn", correlationId, "certification_quarantined");
        return problem(409, "webhook_quarantined", correlationId);
      }
      log(
        "info",
        correlationId,
        result.replayed ? "certification_replayed" : "certification_applied",
      );
      return json(
        200,
        { received: true, replayed: result.replayed },
        correlationId,
      );
    }
    let result;
    try {
      result = sanitizeKycWebhookRpc(data);
    } catch {
      log("error", correlationId, "database_contract_invalid");
      return problem(503, "temporarily_unavailable", correlationId);
    }
    if (result.action === "kyc_result_quarantined") {
      log("warn", correlationId, `quarantined_${result.reason}`);
      return problem(409, "webhook_quarantined", correlationId);
    }
    if (result.action === "kyc_result_observed") {
      log(
        "info",
        correlationId,
        result.replayed ? "sandbox_observation_replayed" : "sandbox_observed",
      );
      return json(
        200,
        {
          received: true,
          replayed: result.replayed,
          observed: true,
        },
        correlationId,
      );
    }
    log(
      "info",
      correlationId,
      result.replayed ? "replayed" : "applied",
    );
    return json(
      200,
      { received: true, replayed: result.replayed },
      correlationId,
    );
  } catch {
    log("error", correlationId, "unhandled");
    return problem(503, "temporarily_unavailable", correlationId);
  }
});

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
          ? "The webhook is temporarily unavailable."
          : "The webhook request was rejected.",
      },
    },
    correlationId,
    extraHeaders,
  );
}

function correlation(): string {
  return `pwh_${
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
  // Never log the body, event/session ids, provider decision, documents,
  // images, names, dates of birth or country.
  console[level]("[norva-partners-kyc-webhook]", {
    correlationId,
    outcome,
  });
}
