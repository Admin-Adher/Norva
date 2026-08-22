// norva-signup — the observed signup path.
//
// The handler is exported as a function over injected dependencies, and
// Deno.serve only wires the real ones at the bottom. That is not tidiness: the
// contract here is an ORDER, and an order is only provable by watching the calls
// happen. Asserting that `recordDecision` appears above `fetch` in the source
// demonstrates the layout of a file, not the behaviour of a program, and it stops
// being true the moment somebody moves the call into a helper.
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
// Step 11 precedes step 12 deliberately: the snapshot must be what was known at
// the moment of the signup, not something coloured by how the call went.
//
// LOGGING. The logger takes a closed set of named scalars and nothing else. An
// earlier version had a generic logEvent(event, fields) and argued that an
// unbound `catch {}` kept the request out of scope — which was simply wrong:
// `catch (error)` does not pull `request` into scope, and `catch {}` does not stop
// anyone passing a body to a logger. The property has to be structural, so there
// is no shape here that a payload could be handed to.

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
import {
  createPostgresVelocityStore,
  HASH_VERSION,
  hashSubject,
  type VelocityDimension,
} from "../_shared/risk-velocity-store.ts";
import {
  assessSignupRisk,
  FAMILY_CAPS,
  LEVEL_THRESHOLDS,
  NEGATIVE_CAP,
  type RiskSignal,
  SIGNALS,
  tokenStateAllowsTiming,
  type TokenState,
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

export const POLICY = {
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
 * The only shape a log line can take. Every field is a scalar the caller has to
 * name, so there is no parameter a payload, a body or a request could be passed
 * as. That is the structural property; an unbound catch was never one.
 */
export interface SignupLogEvent {
  event: string;
  stage: string;
  requestId?: string;
  decisionId?: string | null;
  reason?: string;
  errorName?: string;
  tokenState?: string;
  rawScore?: number;
  riskScore?: number;
  riskLevel?: string;
  wouldHaveDecision?: string;
  actualDecision?: string;
  enforcementEnabled?: boolean;
  repeatedStrongEvidence?: boolean;
  policyConfigHash?: string;
  authMethod?: string;
  platform?: string;
  signupEndpointVersion?: string;
  country?: string | null;
  asn?: number | null;
  upstreamStatus?: number | null;
  signalCodes?: string[];
  familiesInvolved?: string[];
}

export interface SignupDeps {
  // deno-lint-ignore no-explicit-any
  db: any;
  fetchUpstream: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  issueToken: (nowMs: number) => Promise<{ token: string }>;
  log: (entry: SignupLogEvent) => void;
  ingressKeys: { currentVersion: number; current: string; previousVersion?: number; previous?: string };
  supabaseUrl: string;
  serviceKey: string;
  signupEndpointVersion: string;
}

/** One shape for every refusal: an attacker learns nothing about which layer said no. */
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

interface SignupPayload {
  email: string;
  password: string | null;
  formToken: string | null;
  honeypotFilled: boolean;
  authMethod: "password" | "magic_link";
  surface: "web" | "mobile" | "tv";
  appVersion: string | null;
  deviceId: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
}

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
  return {
    email,
    // Length-checked and otherwise untouched: never inspected, never stored.
    password: typeof body.password === "string" && body.password.length <= 512
      ? body.password
      : null,
    formToken: text(body.formToken, MAX_TOKEN_LENGTH),
    // Only whether it was filled. The value itself is of no interest, so it is
    // reduced to a boolean here and cannot travel any further.
    honeypotFilled: typeof body.honeypot === "string"
      && body.honeypot.trim().length > 0
      && body.honeypot.length <= MAX_HONEYPOT_LENGTH,
    authMethod: body.authMethod === "magic_link" ? "magic_link" : "password",
    surface: body.surface === "mobile" || body.surface === "tv" ? body.surface : "web",
    appVersion: text(body.appVersion, MAX_METADATA_FIELD_LENGTH),
    deviceId: text(body.deviceId, MAX_METADATA_FIELD_LENGTH),
    userAgent: text(body.userAgent, 512),
    acceptLanguage: text(body.acceptLanguage, MAX_METADATA_FIELD_LENGTH),
  };
}

const HEADLESS = /headlesschrome|puppeteer|playwright|phantomjs|selenium/i;

// A conservative shape check, not a full IP parser: this only guards against
// header injection (CRLF, commas that would smuggle a second value) before the
// string becomes an X-Forwarded-For header. facts.clientIp is signed — it came
// from Cloudflare's own CF-Connecting-IP header via the ingress envelope — so
// it is authentic, but trustedFacts() does not itself validate the shape.
const PLAUSIBLE_IP = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Kong's auth-v1-signup service already rate-limits /auth/v1/signup at
 * 10/minute and 40/hour per source IP — but this call reaches it from inside
 * the Docker network, so without this header Kong sees the edge container's
 * address, not the signer's. Every signup would then count against the SAME
 * few IPs (one per edge-functions replica) instead of the real caller's, and
 * the floor that looks like it protects account creation would in practice
 * cap the container, not the abuser. KONG_TRUSTED_IPS already covers this
 * Docker range and KONG_REAL_IP_HEADER is already X-Forwarded-For, so nothing
 * downstream needs to change — only that this value is ever sent.
 *
 * The only acceptable source is the signed envelope. Never a header this
 * function itself received: an edge function reachable at all only through a
 * verified envelope has no legitimate caller who should be able to inject an
 * X-Forwarded-For of their choosing here.
 */
function forwardedForHeader(clientIp: string): Record<string, string> {
  return PLAUSIBLE_IP.test(clientIp) ? { "x-forwarded-for": clientIp } : {};
}

function uaFamily(userAgent: string | null): string | null {
  if (!userAgent) return null;
  if (HEADLESS.test(userAgent)) return "headless";
  if (/edg\//i.test(userAgent)) return "edge";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  if (/firefox\//i.test(userAgent)) return "firefox";
  return "other";
}

export async function handleSignup(req: Request, deps: SignupDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-signup/, "") || "/";

  // Public liveness only. A readiness probe listing which secrets are present
  // would describe the internal state of the system to anyone who asked.
  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return json({ ok: true });
  }

  const isToken = req.method === "POST" && path === "/token";
  const isSignup = req.method === "POST" && (path === "/" || path === "/signup");
  if (!isToken && !isSignup) return opaque(404);

  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > MAX_INGRESS_BODY_BYTES) return opaque(413);

  const verdict = await verifyIngress(
    req.headers.get("x-norva-ingress"),
    deps.ingressKeys,
    {
      audience: INGRESS_AUDIENCE_SIGNUP,
      method: req.method,
      // `path` et non `url.pathname` : Kong a deja retire /functions/v1 en
      // amont, donc pathname n'est pas ce que Cloudflare a signe. Les deux
      // cotes derivent maintenant le meme nom logique.
      route: path,
      contentType: req.headers.get("content-type"),
      rawBody,
      nowMs: deps.now(),
    },
  );
  if (!verdict.ok) {
    deps.log({ event: "signup_ingress_refused", stage: "ingress", reason: verdict.reason });
    return opaque(401);
  }
  const facts = trustedFacts(verdict.envelope);

  // Issuing a token is pure cryptography and touches no database on purpose.
  // Otherwise flooding this route would mean flooding Postgres, which is exactly
  // the problem the token was meant to reduce. It costs nothing to hand out, so
  // its ingress envelope is not even consumed: an extra token is not a prize.
  if (isToken) {
    try {
      const { token } = await deps.issueToken(deps.now());
      return json({ token });
    } catch {
      deps.log({ event: "signup_token_unavailable", stage: "token" });
      return opaque(503);
    }
  }

  const { data: fresh, error: replayError } = await deps.db.rpc("abuse_ingress_request_consume", {
    p_request_id: verdict.envelope.requestId,
    p_audience: verdict.envelope.audience,
    p_ttl_seconds: 300,
  });
  if (replayError || fresh !== true) {
    deps.log({
      event: "signup_ingress_replayed",
      stage: "request_id",
      requestId: verdict.envelope.requestId,
    });
    return opaque(409);
  }

  let payload: SignupPayload | null = null;
  try {
    payload = readPayload(JSON.parse(new TextDecoder().decode(rawBody)));
  } catch {
    payload = null;
  }
  if (!payload) return opaque(400);

  const now = deps.now();
  const signals: RiskSignal[] = [];

  const token = await verifyFormToken(payload.formToken, now);
  let tokenState: TokenState = token.state;
  if (token.state === "TOKEN_INVALID") signals.push(SIGNALS.tokenInvalid());
  if (token.state === "TOKEN_MISSING") signals.push(SIGNALS.tokenMissing());
  if (token.state === "TOKEN_VALID_EXPIRED") signals.push(SIGNALS.tokenExpired());
  if (payload.honeypotFilled) signals.push(SIGNALS.honeypot());

  const subject = async (dimension: VelocityDimension, value: string | null) => {
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

  const idempotency = createPostgresIdempotencyStore(deps.db);
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

  // Timing only where a signature verified and the token is on its first use.
  // Otherwise a double click collects the replay weight AND the fast-submission
  // weight, and reaches HIGH on one human accident.
  if (tokenStateAllowsTiming(tokenState) && token.ageMs !== null) {
    if (token.ageMs < 1500) signals.push(SIGNALS.submissionUnder1500ms());
    else if (token.ageMs < 3000) signals.push(SIGNALS.submissionUnder3000ms());
  }

  if (!payload.userAgent) signals.push(SIGNALS.missingUserAgent());
  else if (HEADLESS.test(payload.userAgent)) signals.push(SIGNALS.headlessUserAgent());
  if (!payload.acceptLanguage) signals.push(SIGNALS.missingAcceptLanguage());

  const velocity = createPostgresVelocityStore(deps.db);
  try {
    const queries: Array<{ dimension: VelocityDimension; subject: string; windowsSeconds: number[] }> = [];
    if (facts.clientIp) {
      queries.push({ dimension: "ip", subject: facts.clientIp, windowsSeconds: [3600, 86400] });
      const subnet: VelocityDimension | null = canonicalizeRiskSubject("ip_subnet_24", facts.clientIp)
        ? "ip_subnet_24"
        : (canonicalizeRiskSubject("ip_subnet_64", facts.clientIp) ? "ip_subnet_64" : null);
      if (subnet) queries.push({ dimension: subnet, subject: facts.clientIp, windowsSeconds: [3600] });
    }
    queries.push({ dimension: "email", subject: payload.email, windowsSeconds: [3600] });
    queries.push({ dimension: "mailbox_subject", subject: payload.email, windowsSeconds: [86400] });
    if (payload.deviceId) {
      queries.push({ dimension: "device", subject: payload.deviceId, windowsSeconds: [86400] });
    }
    const readings = await velocity.touch(queries);
    const count = (dimension: string, seconds: number) =>
      readings.find((r) => r.dimension === dimension)?.counts[seconds] ?? 0;

    const push = (signal: RiskSignal | null) => { if (signal) signals.push(signal); };
    push(SIGNALS.velocityIp(count("ip", 3600), count("ip", 86400)));
    push(SIGNALS.velocitySubnet(count("ip_subnet_24", 3600)));
    push(SIGNALS.velocitySubnet(count("ip_subnet_64", 3600)));
    push(SIGNALS.velocityEmailExact(count("email", 3600)));
    push(SIGNALS.velocityMailbox(count("mailbox_subject", 86400)));
    push(SIGNALS.velocityDevice(count("device", 86400)));
  } catch (error) {
    // Fail open. A broken counter must never stop a legitimate account being
    // created; the Kong floor is the backstop while that is true.
    deps.log({
      event: "signup_velocity_unavailable",
      stage: "velocity",
      errorName: (error as Error)?.name ?? "unknown",
    });
  }

  const assessment = assessSignupRisk(signals, { thresholds: POLICY.thresholds });

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
    signupEndpointVersion: deps.signupEndpointVersion,
    hashVersion: HASH_VERSION,
    fingerprintVersion: FINGERPRINT_VERSION,
  }, familyTotals(assessment));
  const decisionId = await recordDecision(deps.db, record);

  deps.log({
    event: "signup_attempt",
    stage: "decided",
    decisionId,
    tokenState,
    rawScore: record.observed_raw_score,
    riskScore: record.observed_risk_score,
    riskLevel: record.observed_risk_level,
    wouldHaveDecision: record.would_have_decision,
    actualDecision: record.actual_decision,
    enforcementEnabled: record.enforcement_enabled,
    repeatedStrongEvidence: record.repeated_strong_evidence,
    familiesInvolved: record.families_involved,
    signalCodes: record.signals.map((s) => s.code),
    policyConfigHash: policyHash,
    authMethod: record.auth_method,
    platform: record.platform,
    signupEndpointVersion: record.signup_endpoint_version,
    country: record.country,
    asn: record.asn,
  });

  // A memoised outcome answers here. The whole point of idempotency is that the
  // second click does not reach GoTrue at all.
  if (claim?.outcome === "replay") {
    if (claim.state === "SUCCESS") return json({ status: "ok", ...claim.result });
    if (claim.state === "FAILED_FINAL") return opaque(400);
    // PROCESSING or UNKNOWN: pending. UNKNOWN is reconciled elsewhere, never
    // retried blind from here.
    return json({ status: "pending" }, 202);
  }
  if (claim?.outcome === "intent_mismatch") return opaque(409);

  // Enforcement is off, so this never refuses. When it is switched on, this is
  // the only line whose behaviour changes.
  if (record.actual_decision !== "ALLOW") return opaque(429);

  let upstreamStatus: number | null = null;
  let userId: string | undefined;
  // GoTrue's own anti-enumeration behaviour: signing up an already-registered
  // email returns 200 with an obfuscated user whose `identities` array is
  // empty, never a duplicate-account error — and sends no confirmation email.
  // The web client's existing UI depends on exactly this distinction to show
  // "this email already has an account" instead of a dead-end "check your
  // email"; losing it here would silently break that message for every signup
  // routed through this handler instead of straight to GoTrue.
  let alreadyRegistered = false;
  try {
    const response = await deps.fetchUpstream(`${deps.supabaseUrl}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: deps.serviceKey,
        authorization: `Bearer ${deps.serviceKey}`,
        ...forwardedForHeader(facts.clientIp),
      },
      body: JSON.stringify({ email: payload.email, password: payload.password }),
    });
    upstreamStatus = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (fingerprint && token.payload) {
        await idempotency.settle(token.payload.nonce, fingerprint, "FAILED_FINAL", null, upstreamStatus);
      }
      deps.log({
        event: "signup_upstream_refused",
        stage: "upstream",
        decisionId,
        upstreamStatus,
      });
      return opaque(400);
    }
    userId = typeof (body as { id?: unknown })?.id === "string"
      ? (body as { id: string }).id
      : undefined;
    const identities = (body as { identities?: unknown })?.identities;
    alreadyRegistered = Array.isArray(identities) && identities.length === 0;
  } catch (error) {
    // The call left and its outcome is unknown. FAILED_FINAL here would let the
    // retry create a second account, which is the one thing idempotency exists
    // to prevent.
    if (fingerprint && token.payload) {
      await idempotency.settle(token.payload.nonce, fingerprint, "UNKNOWN", null, upstreamStatus);
    }
    deps.log({
      event: "signup_upstream_unknown",
      stage: "upstream",
      decisionId,
      errorName: (error as Error)?.name ?? "unknown",
    });
    return json({ status: "pending" }, 202);
  }

  const result = {
    user_id: userId,
    email_confirmation_required: !alreadyRegistered,
    created: !alreadyRegistered,
    already_registered: alreadyRegistered,
  };
  if (fingerprint && token.payload) {
    await idempotency.settle(token.payload.nonce, fingerprint, "SUCCESS", result, upstreamStatus);
  }
  return json({ status: "ok", ...result });
}

// ── real wiring ─────────────────────────────────────────────────────────────
// Only reached under Deno. The Supabase client is imported dynamically so the
// module graph stays loadable in a test runner that has no npm: resolver.

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";

  const deps: Omit<SignupDeps, "db"> & { db?: unknown } = {
    fetchUpstream: (input, init) => fetch(input, init),
    now: () => Date.now(),
    issueToken: (nowMs) => issueFormToken(nowMs),
    log: (entry) => console.log(JSON.stringify(entry)),
    ingressKeys: {
      currentVersion: Number(Deno.env.get("EDGE_INGRESS_KEY_VERSION") ?? "1"),
      current: Deno.env.get("EDGE_INGRESS_SECRET_CURRENT") ?? "",
      previousVersion: Deno.env.get("EDGE_INGRESS_PREVIOUS_KEY_VERSION")
        ? Number(Deno.env.get("EDGE_INGRESS_PREVIOUS_KEY_VERSION"))
        : undefined,
      previous: Deno.env.get("EDGE_INGRESS_SECRET_PREVIOUS") || undefined,
    },
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    signupEndpointVersion: Deno.env.get("SIGNUP_ENDPOINT_VERSION") ?? "norva-signup-v1",
  };

  let client: unknown = null;
  Deno.serve(async (req) => {
    if (!client) {
      const { createClient } = await import("npm:@supabase/supabase-js@2");
      client = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return await handleSignup(req, { ...deps, db: client } as SignupDeps);
  });
}
