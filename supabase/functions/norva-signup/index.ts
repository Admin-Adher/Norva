// norva-signup — the observed signup path.
//
// Two routes. GET /token issues the signed form token. POST / evaluates a signup
// and, in observe mode, records everything and refuses nothing.
//
// The order below is the security contract, not a style choice. Nothing
// expensive happens before the ingress signature holds, because this function is
// publicly reachable on Hetzner and invalid signatures will arrive whatever the
// design. Cryptography answers impersonation; the Kong floor answers volume.
//
//   1  method and route
//   2  raw body, size-capped
//   3  ingress envelope verified   ← nothing costly before this line
//   4  request id consumed atomically
//   5  payload parsed and bounded
//   6  form token verified
//   7  subjects canonicalised
//   8  idempotency claimed
//   9  velocity snapshot
//  10  risk assessed
//  11  decision snapshot persisted  ← before GoTrue, always
//  12  GoTrue
//  13  idempotency settled
//
// Step 11 comes before step 12 deliberately: the snapshot has to be what was
// known at the moment of the signup, not something coloured by how the call went.
//
// NEVER LOGGED, anywhere in this file: the raw body, the parsed payload, the
// email, the password, the form token. The browser used to reach GoTrue directly;
// now this path holds a credential in transit, so no exception context, no error
// telemetry and no debug line may carry the object that holds them. body_hash is
// enough for integrity.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  INGRESS_AUDIENCE_SIGNUP,
  MAX_EMAIL_LENGTH,
  MAX_HONEYPOT_LENGTH,
  MAX_INGRESS_BODY_BYTES,
  MAX_METADATA_FIELD_LENGTH,
  MAX_TOKEN_LENGTH,
  trustedFacts,
  verifyIngress,
} from "../_shared/edge-ingress.ts";
import { canonicalizeRiskSubject } from "../_shared/risk-subject-canonical.ts";
import { createPostgresVelocityStore, HASH_VERSION, hashSubject } from "../_shared/risk-velocity-store.ts";
import {
  assessSignupRisk,
  FAMILY_CAPS,
  LEVEL_THRESHOLDS,
  NEGATIVE_CAP,
  type RiskSignal,
  SIGNALS,
  tokenStateAllowsTiming,
} from "../_shared/signup-risk-engine.ts";
import { issueFormToken, verifyFormToken } from "../_shared/signup-form-token.ts";
import {
  createPostgresIdempotencyStore,
  FINGERPRINT_VERSION,
  signupRequestFingerprint,
} from "../_shared/signup-idempotency.ts";
import {
  buildDecisionRecord,
  familyTotals,
  policyConfigHash,
  recordDecision,
  RISK_MODEL_VERSION,
  VELOCITY_RULES_VERSION,
} from "../_shared/signup-decision-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const SIGNUP_ENDPOINT_VERSION = Deno.env.get("SIGNUP_ENDPOINT_VERSION") ?? "norva-signup-v1";

const INGRESS_KEYS = {
  currentVersion: Number(Deno.env.get("EDGE_INGRESS_KEY_VERSION") ?? "1"),
  current: Deno.env.get("EDGE_INGRESS_SECRET_CURRENT") ?? "",
  previousVersion: Deno.env.get("EDGE_INGRESS_PREVIOUS_KEY_VERSION")
    ? Number(Deno.env.get("EDGE_INGRESS_PREVIOUS_KEY_VERSION"))
    : undefined,
  previous: Deno.env.get("EDGE_INGRESS_SECRET_PREVIOUS") || undefined,
};

const POLICY = {
  thresholds: { ...LEVEL_THRESHOLDS },
  familyCaps: {
    velocity: FAMILY_CAPS.velocity,
    network: FAMILY_CAPS.network,
    client: FAMILY_CAPS.client,
    email: FAMILY_CAPS.email,
  },
  negativeCap: NEGATIVE_CAP,
  riskModelVersion: RISK_MODEL_VERSION,
  velocityRulesVersion: VELOCITY_RULES_VERSION,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-norva-ingress",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * One shape for every refusal. An attacker learns the request failed and nothing
 * about which layer refused it or why — the reason lives in the logs and in the
 * decision snapshot, never in the response.
 */
function opaque(status: number): Response {
  return new Response(
    JSON.stringify({ error: "Unable to complete registration. Please try again later." }),
    { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Structured, and free of anything the person typed. */
function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

interface SignupPayload {
  email: string;
  password: string | null;
  formToken: string | null;
  honeypot: string | null;
  authMethod: "password" | "magic_link";
  surface: "web" | "mobile" | "tv";
  appVersion: string | null;
  deviceId: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  clientHintsPlatform: string | null;
}

/** Bounded on every field. A signup has no business carrying more than this. */
function readPayload(raw: unknown): SignupPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
  };
  const email = text(body.email, MAX_EMAIL_LENGTH);
  if (!email) return null;
  const authMethod = body.authMethod === "magic_link" ? "magic_link" : "password";
  const surface = body.surface === "mobile" || body.surface === "tv"
    ? body.surface
    : "web";
  return {
    email,
    // Length only. Never inspected, never logged, never stored.
    password: typeof body.password === "string" && body.password.length <= 512
      ? body.password
      : null,
    formToken: text(body.formToken, MAX_TOKEN_LENGTH),
    // Presence is the signal. The value itself is of no interest and is
    // deliberately not kept.
    honeypot: typeof body.honeypot === "string" && body.honeypot.length <= MAX_HONEYPOT_LENGTH
      ? body.honeypot
      : null,
    authMethod,
    surface,
    appVersion: text(body.appVersion, MAX_METADATA_FIELD_LENGTH),
    deviceId: text(body.deviceId, MAX_METADATA_FIELD_LENGTH),
    userAgent: text(body.userAgent, 512),
    acceptLanguage: text(body.acceptLanguage, MAX_METADATA_FIELD_LENGTH),
    clientHintsPlatform: text(body.clientHintsPlatform, MAX_METADATA_FIELD_LENGTH),
  };
}

const HEADLESS = /headlesschrome|puppeteer|playwright|phantomjs|selenium/i;

function uaFamily(userAgent: string | null): string | null {
  if (!userAgent) return null;
  if (HEADLESS.test(userAgent)) return "headless";
  if (/edg\//i.test(userAgent)) return "edge";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  if (/firefox\//i.test(userAgent)) return "firefox";
  return "other";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-signup/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return json({
      ok: true,
      service: "norva-signup",
      version: SIGNUP_ENDPOINT_VERSION,
      // Booleans only: /health says whether the path can work, never with what.
      env: {
        ingress_current: Boolean(INGRESS_KEYS.current),
        ingress_previous: Boolean(INGRESS_KEYS.previous),
        db: Boolean(SUPABASE_URL && SERVICE_KEY),
      },
    });
  }

  // 1 — route
  if (!(req.method === "POST" && (path === "/" || path === "/signup"))
    && !(req.method === "POST" && path === "/token")) {
    return opaque(404);
  }

  // 2 — raw body, read exactly once, size-capped before anything looks at it
  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_INGRESS_BODY_BYTES) return opaque(413);

  // 3 — the ingress signature. Nothing costly happens above this line.
  const verdict = await verifyIngress(
    req.headers.get("x-norva-ingress"),
    INGRESS_KEYS,
    {
      audience: INGRESS_AUDIENCE_SIGNUP,
      method: req.method,
      path: url.pathname,
      contentType: req.headers.get("content-type"),
      rawBody,
      nowMs: Date.now(),
    },
  );
  if (!verdict.ok) {
    logEvent("signup_ingress_refused", { reason: verdict.reason, path });
    return opaque(401);
  }
  const facts = trustedFacts(verdict.envelope);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4 — the request id works exactly once
  const { data: fresh, error: replayError } = await db.rpc("abuse_ingress_request_consume", {
    p_request_id: verdict.envelope.requestId,
    p_audience: verdict.envelope.audience,
    p_ttl_seconds: 300,
  });
  if (replayError || fresh !== true) {
    logEvent("signup_ingress_replayed", { request_id: verdict.envelope.requestId });
    return opaque(409);
  }

  // The token route ends here: it needs an authenticated ingress and nothing else.
  if (path === "/token") {
    try {
      const { token } = await issueFormToken(Date.now());
      return json({ token });
    } catch {
      // A missing secret must not be described to the caller.
      return opaque(503);
    }
  }

  // 5 — payload, bounded
  let payload: SignupPayload | null = null;
  try {
    payload = readPayload(JSON.parse(new TextDecoder().decode(rawBody)));
  } catch {
    payload = null;
  }
  if (!payload) return opaque(400);

  const now = Date.now();
  const signals: RiskSignal[] = [];

  // 6 — the form token. Authenticity here; first use is decided at step 8.
  const token = await verifyFormToken(payload.formToken, now);
  let tokenState: string = token.state;
  if (token.state === "TOKEN_INVALID") signals.push(SIGNALS.tokenInvalid());
  if (token.state === "TOKEN_MISSING") signals.push(SIGNALS.tokenMissing());
  if (token.state === "TOKEN_VALID_EXPIRED") signals.push(SIGNALS.tokenExpired());

  if (payload.honeypot) signals.push(SIGNALS.honeypot());

  // 7 — subjects, canonicalised then keyed. A value that cannot be parsed drops
  // its signal rather than counting a wrong subject.
  const subject = async (dimension: Parameters<typeof hashSubject>[0], value: string | null) => {
    if (!value || !canonicalizeRiskSubject(dimension, value)) return null;
    try {
      return await hashSubject(dimension, value);
    } catch {
      return null;
    }
  };
  const ipHash = await subject("ip", facts.clientIp);
  const mailboxHash = await subject("mailbox_subject", payload.email);
  const deviceHash = await subject("device", payload.deviceId);

  // 8 — idempotency. The claim is where a replay is discovered.
  const idempotency = createPostgresIdempotencyStore(db);
  let fingerprint: string | null = null;
  let claim: Awaited<ReturnType<typeof idempotency.claim>> | null = null;
  if (token.payload) {
    try {
      fingerprint = await signupRequestFingerprint({
        nonce: token.payload.nonce,
        email: payload.email,
        surface: payload.surface,
        authMethod: payload.authMethod,
        credential: payload.password,
      });
      claim = await idempotency.claim(token.payload.nonce, fingerprint, 900);
    } catch {
      claim = null;
    }
  }
  if (claim?.outcome === "replay") {
    tokenState = "TOKEN_VALID_REPLAYED";
    signals.push(SIGNALS.idempotentRetry(claim.attemptCount - 1));
  } else if (claim?.outcome === "intent_mismatch") {
    tokenState = "TOKEN_VALID_REPLAYED";
    signals.push(SIGNALS.nonceIntentMismatch());
  }

  // Timing is judged only where a signature verified AND the token is being used
  // for the first time: otherwise a double click collects the replay weight and
  // the fast-submission weight, and reaches HIGH on one human accident.
  if (tokenStateAllowsTiming(tokenState as never) && token.ageMs !== null) {
    if (token.ageMs < 1500) signals.push(SIGNALS.submissionUnder1500ms());
    else if (token.ageMs < 3000) signals.push(SIGNALS.submissionUnder3000ms());
  }

  if (!payload.userAgent) signals.push(SIGNALS.missingUserAgent());
  else if (HEADLESS.test(payload.userAgent)) signals.push(SIGNALS.headlessUserAgent());
  if (!payload.acceptLanguage) signals.push(SIGNALS.missingAcceptLanguage());

  // 9 — velocity. A failure here removes signals and never refuses a signup.
  const velocity = createPostgresVelocityStore(db);
  try {
    const queries = [];
    if (facts.clientIp) {
      queries.push({ dimension: "ip" as const, subject: facts.clientIp, windowsSeconds: [3600, 86400] });
      const subnet = canonicalizeRiskSubject("ip_subnet_24", facts.clientIp)
        ? "ip_subnet_24" as const
        : (canonicalizeRiskSubject("ip_subnet_64", facts.clientIp) ? "ip_subnet_64" as const : null);
      if (subnet) queries.push({ dimension: subnet, subject: facts.clientIp, windowsSeconds: [3600] });
    }
    queries.push({ dimension: "email" as const, subject: payload.email, windowsSeconds: [3600] });
    queries.push({ dimension: "mailbox_subject" as const, subject: payload.email, windowsSeconds: [86400] });
    if (payload.deviceId) {
      queries.push({ dimension: "device" as const, subject: payload.deviceId, windowsSeconds: [86400] });
    }
    const readings = await velocity.touch(queries);
    const count = (dimension: string, seconds: number) =>
      readings.find((r) => r.dimension === dimension)?.counts[seconds] ?? 0;

    const ipSignal = SIGNALS.velocityIp(count("ip", 3600), count("ip", 86400));
    if (ipSignal) signals.push(ipSignal);
    for (const dimension of ["ip_subnet_24", "ip_subnet_64"]) {
      const subnetSignal = SIGNALS.velocitySubnet(count(dimension, 3600));
      if (subnetSignal) signals.push(subnetSignal);
    }
    const emailSignal = SIGNALS.velocityEmailExact(count("email", 3600));
    if (emailSignal) signals.push(emailSignal);
    const mailboxSignal = SIGNALS.velocityMailbox(count("mailbox_subject", 86400));
    if (mailboxSignal) signals.push(mailboxSignal);
    const deviceSignal = SIGNALS.velocityDevice(count("device", 86400));
    if (deviceSignal) signals.push(deviceSignal);
  } catch (error) {
    // Fail open, loudly in the logs and silently for the person signing up. A
    // broken counter must never stop a legitimate account being created; the
    // Kong floor is the backstop while this is true.
    logEvent("signup_velocity_unavailable", { reason: String((error as Error)?.message ?? "unknown") });
  }

  // 10 — the verdict
  const assessment = assessSignupRisk(signals, { thresholds: POLICY.thresholds });

  // 11 — the snapshot, BEFORE GoTrue. It has to be what was known at the moment
  // of the signup, not something coloured by how the call turned out.
  const policyHash = await policyConfigHash(POLICY);
  const record = buildDecisionRecord(assessment, POLICY, policyHash, {
    ipSubjectHmac: ipHash,
    mailboxSubjectHmac: mailboxHash,
    deviceSubjectHmac: deviceHash,
    attemptFingerprint: fingerprint,
    asn: facts.asn,
    country: facts.country,
    uaFamily: uaFamily(payload.userAgent),
    authMethod: payload.authMethod,
    platform: payload.surface,
    appVersion: payload.appVersion,
    signupEndpointVersion: SIGNUP_ENDPOINT_VERSION,
    hashVersion: HASH_VERSION,
    fingerprintVersion: FINGERPRINT_VERSION,
  }, familyTotals(assessment));
  const decisionId = await recordDecision(db, record);

  logEvent("signup_attempt", {
    decision_id: decisionId,
    token_state: tokenState,
    raw_score: record.observed_raw_score,
    risk_score: record.observed_risk_score,
    risk_level: record.observed_risk_level,
    families_involved: record.families_involved,
    repeated_strong_evidence: record.repeated_strong_evidence,
    would_have_decision: record.would_have_decision,
    enforcement_enabled: record.enforcement_enabled,
    actual_decision: record.actual_decision,
    signals: record.signals.map((s) => s.code),
    policy_config_hash: policyHash,
    auth_method: record.auth_method,
    platform: record.platform,
    signup_endpoint_version: record.signup_endpoint_version,
    country: record.country,
    asn: record.asn,
  });

  // A memoised success answers immediately: the whole point of idempotency is
  // that the second click does not reach GoTrue at all.
  if (claim?.outcome === "replay") {
    if (claim.state === "SUCCESS") return json({ status: "ok", ...claim.result });
    if (claim.state === "PROCESSING") return json({ status: "pending" }, 202);
    if (claim.state === "FAILED_FINAL") return opaque(400);
    // UNKNOWN: the first attempt's outcome is genuinely unknown, so it is
    // reconciled rather than retried blind. Never a second GoTrue call.
    return json({ status: "pending" }, 202);
  }
  if (claim?.outcome === "intent_mismatch") return opaque(409);

  // Enforcement is off, so the verdict above never refuses. When it is switched
  // on, this is the only line that changes behaviour.
  if (record.actual_decision !== "ALLOW") return opaque(429);

  // 12 — GoTrue
  let upstreamStatus: number | null = null;
  let created: { user_id?: string } = {};
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ email: payload.email, password: payload.password }),
    });
    upstreamStatus = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 13 — a deterministic refusal is final; nothing ambiguous about it.
      if (fingerprint && token.payload) {
        await idempotency.settle(token.payload.nonce, fingerprint, "FAILED_FINAL", null, upstreamStatus);
      }
      logEvent("signup_upstream_refused", { decision_id: decisionId, status: upstreamStatus });
      return opaque(400);
    }
    created = { user_id: typeof body?.id === "string" ? body.id : undefined };
  } catch (error) {
    // The call left and its outcome is not known. Calling this FAILED_FINAL
    // would let the retry create a second account, which is the one thing
    // idempotency exists to prevent.
    if (fingerprint && token.payload) {
      await idempotency.settle(token.payload.nonce, fingerprint, "UNKNOWN", null, upstreamStatus);
    }
    logEvent("signup_upstream_unknown", {
      decision_id: decisionId,
      // The message only. Never the payload, never an exception carrying it.
      reason: String((error as Error)?.name ?? "unknown"),
    });
    return json({ status: "pending" }, 202);
  }

  const result = {
    user_id: created.user_id,
    email_confirmation_required: true,
    created: true,
  };
  if (fingerprint && token.payload) {
    await idempotency.settle(token.payload.nonce, fingerprint, "SUCCESS", result, upstreamStatus);
  }
  return json({ status: "ok", ...result });
});
