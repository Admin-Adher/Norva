/**
 * norva-auth-challenge — prove mailbox ownership before GoTrue may create a
 * user. The browser reaches this service only through signed Cloudflare Pages
 * proxies, so velocity decisions use authenticated network facts.
 *
 * Order on /request:
 *   ingress -> replay guard -> bounded payload -> velocity -> domain -> HMAC DB
 *   row -> email transport
 *
 * Order on /verify:
 *   ingress -> replay guard -> bounded payload -> atomic code verification ->
 *   account existence (server-only) -> generate one-time Auth token
 *
 * Raw emails and codes are never logged or stored in Postgres.
 */
import { requestEmailProvider } from '../_shared/email-provider-request.mjs';
import {
  INGRESS_AUDIENCE_AUTH_CHALLENGE,
  MAX_EMAIL_LENGTH,
  MAX_INGRESS_BODY_BYTES,
  MAX_METADATA_FIELD_LENGTH,
  trustedFacts,
  verifyIngress,
} from "../_shared/edge-ingress.ts";
import {
  createPostgresVelocityStore,
  hashPrivateValue,
  hashSubject,
} from "../_shared/risk-velocity-store.ts";

export const AUTH_EMAIL_CHALLENGE_PROTOCOL = 1;
const CHALLENGE_TTL_SECONDS = 15 * 60;
const MAX_REDIRECT_LENGTH = 512;
const MAX_METADATA_ENTRIES = 10;
const CHALLENGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_METADATA_KEYS = new Set([
  "norva_signup_platform",
  "norva_signup_surface",
  "norva_signup_method",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-norva-ingress",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
});

const opaque = (status: number) => json({
  error: "Unable to verify this email right now. Please try again later.",
}, status);

export interface AuthChallengeLogEvent {
  event: string;
  stage: string;
  requestId?: string;
  reason?: string;
  status?: number;
}

export interface AuthLinkResult {
  tokenHash: string;
  verificationType: "signup" | "magiclink";
}

export interface AuthChallengeDeps {
  // deno-lint-ignore no-explicit-any
  db: any;
  now: () => number;
  ingressKeys: { currentVersion: number; current: string; previousVersion?: number; previous?: string };
  resolveMailDomain: (domain: string) => Promise<"valid" | "invalid" | "unknown">;
  sendChallenge: (email: string, code: string, challengeId: string) => Promise<boolean>;
  createAuthLink: (email: string, metadata: Record<string, string>, redirectTo: string) => Promise<AuthLinkResult>;
  log: (event: AuthChallengeLogEvent) => void;
}

interface BasePayload {
  email: string;
  challengeId: string | null;
}

interface RequestPayload extends BasePayload {
  metadata: Record<string, string>;
  redirectTo: string;
}

interface VerifyPayload extends BasePayload {
  challengeId: string;
  code: string;
  metadata: Record<string, string>;
  redirectTo: string;
}

function canonicalEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/i.test(email)) return null;
  if (email.includes("..")) return null;
  return email;
}

function readMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METADATA_ENTRIES) break;
    if (typeof raw !== "string") continue;
    const safeKey = key.trim();
    const safeValue = raw.trim();
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(safeKey)) continue;
    if (!ALLOWED_METADATA_KEYS.has(safeKey)) continue;
    if (!safeValue || safeValue.length > MAX_METADATA_FIELD_LENGTH) continue;
    out[safeKey] = safeValue;
  }
  return out;
}

function safeRedirect(value: unknown): string {
  const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://norva.tv").replace(/\/+$/, "");
  const fallback = `${site}/account.html?client=unified_email_otp`;
  if (typeof value !== "string" || !value || value.length > MAX_REDIRECT_LENGTH) return fallback;
  try {
    const target = new URL(value);
    const expected = new URL(site);
    if (target.origin !== expected.origin || target.pathname !== "/account.html") return fallback;
    return target.toString();
  } catch {
    return fallback;
  }
}

function readPayload(raw: Uint8Array, verify: boolean): RequestPayload | VerifyPayload | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const email = canonicalEmail(body.email);
  if (!email) return null;
  const challengeId = typeof body.challengeId === "string" && CHALLENGE_ID_PATTERN.test(body.challengeId)
    ? body.challengeId.toLowerCase()
    : null;
  const shared = {
    email,
    challengeId,
    metadata: readMetadata(body.metadata),
    redirectTo: safeRedirect(body.redirectTo),
  };
  if (!verify) return shared;
  const code = typeof body.code === "string" && /^\d{6}$/.test(body.code) ? body.code : null;
  if (!challengeId || !code) return null;
  return { ...shared, challengeId, code };
}

function randomCode(): string {
  // Rejection sampling avoids modulo bias over the six-digit code space.
  const sample = new Uint32Array(1);
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(sample); while (sample[0] >= ceiling);
  return String(sample[0] % 1_000_000).padStart(6, "0");
}

async function consumeIngressRequest(deps: AuthChallengeDeps, requestId: string): Promise<boolean> {
  try {
    const { data, error } = await deps.db.rpc("abuse_ingress_request_consume", {
      p_request_id: requestId,
      p_audience: INGRESS_AUDIENCE_AUTH_CHALLENGE,
      p_ttl_seconds: 300,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function handleAuthChallenge(req: Request, deps: AuthChallengeDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/norva-auth-challenge/, "") || "/";
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return json({ ok: true, protocol: AUTH_EMAIL_CHALLENGE_PROTOCOL });
  }
  const isRequest = req.method === "POST" && path === "/request";
  const isVerify = req.method === "POST" && path === "/verify";
  if (!isRequest && !isVerify) return opaque(404);

  const rawBody = new Uint8Array(await req.arrayBuffer());
  if (rawBody.byteLength > MAX_INGRESS_BODY_BYTES) return opaque(413);
  const verdict = await verifyIngress(req.headers.get("x-norva-ingress"), deps.ingressKeys, {
    audience: INGRESS_AUDIENCE_AUTH_CHALLENGE,
    method: req.method,
    route: path,
    contentType: req.headers.get("content-type"),
    rawBody,
    nowMs: deps.now(),
  });
  if (!verdict.ok) {
    deps.log({ event: "auth_challenge_ingress_refused", stage: "ingress", reason: verdict.reason });
    return opaque(401);
  }
  if (!await consumeIngressRequest(deps, verdict.envelope.requestId)) {
    deps.log({ event: "auth_challenge_ingress_replayed", stage: "request_id", requestId: verdict.envelope.requestId });
    return opaque(409);
  }

  const payload = readPayload(rawBody, isVerify);
  if (!payload) return opaque(400);
  const facts = trustedFacts(verdict.envelope);

  if (isRequest) {
    try {
      const readings = await createPostgresVelocityStore(deps.db).touch([
        { dimension: "ip", subject: facts.clientIp, windowsSeconds: [3600] },
        { dimension: "email", subject: payload.email, windowsSeconds: [3600] },
      ]);
      const ipCount = readings.find((row) => row.dimension === "ip")?.counts[3600] ?? 0;
      const emailCount = readings.find((row) => row.dimension === "email")?.counts[3600] ?? 0;
      if (ipCount > 20 || emailCount > 5) return opaque(429);
    } catch {
      deps.log({ event: "auth_challenge_velocity_unavailable", stage: "velocity" });
      return opaque(503);
    }

    const domain = payload.email.slice(payload.email.lastIndexOf("@") + 1);
    let domainState: "valid" | "invalid" | "unknown" = "unknown";
    try { domainState = await deps.resolveMailDomain(domain); } catch { /* assistive check fails open */ }
    if (domainState === "invalid") {
      return json({ error: "Check the email address and its domain before continuing." }, 422);
    }

    const challengeId = crypto.randomUUID();
    const code = randomCode();
    let emailHash = "";
    let codeHash = "";
    try {
      emailHash = await hashSubject("email", payload.email);
      codeHash = await hashPrivateValue("auth_email_code", `${challengeId}:${code}`);
    } catch {
      return opaque(503);
    }
    const issued = await deps.db.rpc("auth_email_challenge_issue", {
      p_challenge_id: challengeId,
      p_email_hash: emailHash,
      p_code_hash: codeHash,
      p_ttl_seconds: CHALLENGE_TTL_SECONDS,
    });
    if (issued.error || issued.data !== true) return opaque(503);

    let delivered = false;
    try { delivered = await deps.sendChallenge(payload.email, code, challengeId); } catch { delivered = false; }
    if (!delivered) {
      await deps.db.rpc("auth_email_challenge_invalidate", { p_challenge_id: challengeId });
      deps.log({ event: "auth_challenge_transport_failed", stage: "email" });
      return opaque(502);
    }
    return json({ challengeId, expiresIn: CHALLENGE_TTL_SECONDS });
  }

  const verifiedPayload = payload as VerifyPayload;
  let emailHash = "";
  let codeHash = "";
  try {
    emailHash = await hashSubject("email", verifiedPayload.email);
    codeHash = await hashPrivateValue(
      "auth_email_code",
      `${verifiedPayload.challengeId}:${verifiedPayload.code}`,
    );
  } catch {
    return opaque(503);
  }
  const proof = await deps.db.rpc("auth_email_challenge_verify", {
    p_challenge_id: verifiedPayload.challengeId,
    p_email_hash: emailHash,
    p_code_hash: codeHash,
  });
  if (proof.error) return opaque(503);
  const status = String(proof.data?.status ?? "invalid");
  if (status !== "verified") {
    return json({ error: status === "expired"
      ? "This code has expired. Request a new one."
      : "That code is invalid. Check the email or request a new code." }, 400);
  }

  try {
    const auth = await deps.createAuthLink(
      verifiedPayload.email,
      verifiedPayload.metadata,
      verifiedPayload.redirectTo,
    );
    return json({ tokenHash: auth.tokenHash, verificationType: auth.verificationType });
  } catch {
    deps.log({ event: "auth_challenge_token_failed", stage: "auth" });
    return opaque(503);
  }
}

async function resolveMailDomain(domain: string): Promise<"valid" | "invalid" | "unknown"> {
  const query = async (type: "MX" | "A" | "AAAA") => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3500) },
    );
    if (!response.ok) throw new Error("dns_unavailable");
    return await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  };
  try {
    const mx = await query("MX");
    if (mx.Status === 3) return "invalid";
    const mxAnswers = Array.isArray(mx.Answer) ? mx.Answer.filter((answer) => answer.type === 15) : [];
    if (mxAnswers.some((answer) => !/\s\.\s*$/.test(String(answer.data ?? "")))) return "valid";
    if (mxAnswers.length > 0) return "invalid"; // RFC 7505 null MX
    const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
    if (a.Status === 3 && aaaa.Status === 3) return "invalid";
    const hasAddress = [a, aaaa].some((result) => Array.isArray(result.Answer) && result.Answer.length > 0);
    return hasAddress ? "valid" : "invalid";
  } catch {
    // DNS is an assistive typo check, not an availability dependency. Syntax,
    // velocity and mailbox ownership still remain mandatory when DoH is down.
    return "unknown";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] as string);
}

export async function sendChallenge(email: string, code: string, challengeId: string): Promise<boolean> {
  const key = Deno.env.get("NORVA_POSTAL_WIRE_KEY") ?? "";
  if (!key) return false;
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <support@norva.tv>";
  const replyTo = Deno.env.get("AUTH_EMAIL_REPLY_TO") ?? "support@norva.tv";
  const safeCode = escapeHtml(code);
  let response: Response;
  try { response = await requestEmailProvider("postal:send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": `norva-mailbox-proof-${challengeId}`,
      "User-Agent": "Norva-Auth-Challenge/2.0",
    },
    body: JSON.stringify({
      from,
      to: [email],
      reply_to: replyTo,
      subject: "Your verification code — Norva",
      html: `<div style="background:#0a0d16;color:#eef1f8;font-family:Arial,sans-serif;padding:32px"><div style="max-width:520px;margin:auto;background:#111624;border:1px solid #252b3a;border-radius:16px;padding:28px"><h1 style="font-size:22px;margin:0 0 12px">Confirm this email address</h1><p style="color:#a2adc2;line-height:1.55">Enter this six-digit code on the Norva screen where you started. Your account is not created until this code is verified.</p><div style="font-size:30px;letter-spacing:8px;font-weight:800;text-align:center;background:#0a0d16;border:1px solid #2a3344;border-radius:10px;padding:14px 20px;margin:24px 0">${safeCode}</div><p style="color:#828da3;font-size:13px">The code expires in 15 minutes. If you did not request it, ignore this email.</p></div></div>`,
      text: `Your Norva verification code is ${code}. It expires in 15 minutes. Your account is not created until this code is verified.`,
      tags: [
        { name: "app", value: "norva" },
        { name: "category", value: "transactional_auth" },
        { name: "flow", value: "mailbox_preverification" },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  } catch { return false; }
  if (!response.ok) return false;
  // A positive HTTP response without a provider receipt is not an acknowledged
  // OTP delivery. Do not expose provider content, codes or recipients in logs.
  const receipt = await response.json().catch(() => null);
  return typeof receipt?.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(receipt.id);
}

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// deno-lint-ignore no-explicit-any
function realDeps(db: any): AuthChallengeDeps {
  return {
    db,
    now: () => Date.now(),
    ingressKeys: {
      currentVersion: Number(Deno.env.get("EDGE_INGRESS_KEY_VERSION") ?? "1"),
      current: Deno.env.get("EDGE_INGRESS_SECRET_CURRENT") ?? "",
      previousVersion: Number(Deno.env.get("EDGE_INGRESS_PREVIOUS_KEY_VERSION") || "0") || undefined,
      previous: Deno.env.get("EDGE_INGRESS_SECRET_PREVIOUS") || undefined,
    },
    resolveMailDomain,
    sendChallenge,
    createAuthLink: async (email, metadata, redirectTo) => {
      const existsResult = await db.rpc("norva_auth_email_exists", { p_email: email });
      if (existsResult.error) throw new Error("email_lookup_failed");
      const exists = existsResult.data === true;
      const params = exists
        ? { type: "magiclink" as const, email, options: { redirectTo } }
        : { type: "signup" as const, email, password: randomPassword(), options: { data: metadata, redirectTo } };
      const { data, error } = await db.auth.admin.generateLink(params);
      if (error) throw error;
      const tokenHash = String(data?.properties?.hashed_token ?? "");
      const verificationType = String(data?.properties?.verification_type ?? (exists ? "magiclink" : "signup"));
      if (!tokenHash || (verificationType !== "magiclink" && verificationType !== "signup")) {
        throw new Error("auth_token_missing");
      }
      return { tokenHash, verificationType } as AuthLinkResult;
    },
    log: (event) => console.log(JSON.stringify(event)),
  };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  Deno.serve((req) => handleAuthChallenge(req, realDeps(db)));
}
