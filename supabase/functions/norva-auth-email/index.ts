/**
 * norva-auth-email — Supabase "Send Email Hook".
 *
 * Supabase Auth POSTs here whenever it needs to send a transactional email
 * (signup confirmation, password recovery, magic link, email change, invite,
 * reauthentication). We verify the Standard-Webhooks signature, render a
 * branded HTML email, and send it through the Resend API — replacing Supabase's
 * default sender entirely.
 *
 * Required secrets (set in the Supabase dashboard → Edge Functions → Secrets):
 *   RESEND_API_KEY          — Resend API key (re_...)
 *   SEND_EMAIL_HOOK_SECRET  — the hook secret Supabase shows when you enable the
 *                             Send Email Hook (looks like: v1,whsec_base64...)
 *   AUTH_EMAIL_FROM         — optional, defaults to "Norva <noreply@norva.tv>"
 * SUPABASE_URL is injected automatically by the platform.
 *
 * Deploy with JWT verification OFF (it's a signed webhook, not a user call):
 *   [functions.norva-auth-email] verify_jwt = false   (see supabase/config.toml)
 */

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const HOOK_SECRET_RAW = Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const REPLY_TO = Deno.env.get("AUTH_EMAIL_REPLY_TO") ?? "support@norva.tv";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
// Public site base for action links — keeps the email link on norva.tv instead of the
// raw supabase.co verify URL. Override with PUBLIC_SITE_URL if the domain changes.
const SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://norva.tv").replace(/\/+$/, "");

// The hook secret comes as "v1,whsec_<base64>" — keep just the base64 payload.
const HOOK_SECRET_B64 = HOOK_SECRET_RAW.replace(/^v1,whsec_/, "").replace(/^whsec_/, "");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Standard Webhooks verification (the scheme Supabase uses for auth hooks).
async function verifySignature(headers: Headers, body: string): Promise<boolean> {
  if (!HOOK_SECRET_B64) return false;
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;

  // Reject stale deliveries (replay protection): 5-minute tolerance.
  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) return false;

  const signedContent = `${id}.${ts}.${body}`;
  const keyBytes = Uint8Array.from(atob(HOOK_SECRET_B64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // webhook-signature is space-separated "v1,<base64sig>" entries.
  return sigHeader
    .split(" ")
    .map((part) => part.split(",")[1] ?? part)
    .some((sig) => timingSafeEqual(sig, expected));
}

export interface EmailData {
  token: string;
  token_hash: string;
  redirect_to: string;
  email_action_type: string;
  site_url?: string;
  token_new?: string;
  token_hash_new?: string;
}

export interface AuthEmailHookPayload {
  user: {
    email?: string | null;
    new_email?: string | null;
  };
  email_data: EmailData;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  flow: string;
}

interface ResendEmailRequest {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
}

export interface ResendAuthRequest {
  endpoint: "https://api.resend.com/emails" | "https://api.resend.com/emails/batch";
  idempotencyKey: string;
  body: ResendEmailRequest | ResendEmailRequest[];
  expectedIds: number;
  batch: boolean;
}

function resendPayload(email: OutboundEmail): ResendEmailRequest {
  return {
    from: FROM,
    to: [email.to],
    reply_to: REPLY_TO,
    subject: email.subject,
    html: email.html,
    text: email.text,
    tags: [
      { name: "app", value: "norva" },
      { name: "category", value: "transactional_auth" },
      { name: "flow", value: email.flow },
    ],
  };
}

/**
 * Secure Email Change needs two mandatory confirmations. Resend's strict batch
 * endpoint accepts or rejects the pair as one request, avoiding the partial
 * delivery state created by two sequential HTTP calls. The endpoint currently
 * supports at most 100 messages; Norva deliberately caps this hook at two.
 */
export function buildResendAuthRequest(emails: OutboundEmail[], deliveryId: string): ResendAuthRequest {
  if (emails.length < 1 || emails.length > 2) throw new Error("Invalid authentication email batch size");
  const stableId = String(deliveryId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  if (!stableId) throw new Error("Missing authentication delivery id");
  const payloads = emails.map(resendPayload);
  const batch = payloads.length > 1;
  return {
    endpoint: batch ? "https://api.resend.com/emails/batch" : "https://api.resend.com/emails",
    idempotencyKey: `norva-auth-${stableId}-${batch ? "batch" : "single"}`,
    body: batch ? payloads : payloads[0],
    expectedIds: payloads.length,
    batch,
  };
}

/** Return every provider acknowledgement or null for a partial/malformed 2xx. */
export function acknowledgedResendIds(payload: unknown, batch: boolean, expectedIds: number): string[] | null {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rawIds = batch
    ? (Array.isArray(value.data) ? value.data.map((entry) =>
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : null) : [])
    : [value.id];
  if (rawIds.length !== expectedIds) return null;
  const ids = rawIds.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function resendErrorCode(payload: unknown): string {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  return String(value.name ?? value.code ?? nested.name ?? nested.code ?? "unknown_error")
    .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "unknown_error";
}

function retryableResendFailure(status: number, code: string): boolean {
  if (status === 409) return code === "concurrent_idempotent_requests";
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

type EmailChangeRecipient = "current" | "new";

function redirectTarget(redirectTo: string | undefined): string | null {
  const raw = String(redirectTo ?? "").trim();
  if (!raw) return null;

  try {
    const site = new URL(`${SITE_URL}/`);
    const target = new URL(raw, site);
    // account.html only accepts same-origin relative return targets. Supabase has
    // already allow-listed redirect_to, but this also prevents an open redirect.
    if (target.origin !== site.origin) return null;

    // The web auth clients use account.html as the verification landing page.
    // Returning there after verification would loop. If that landing URL carries
    // a real nested returnTo, preserve the nested destination instead.
    if (target.pathname === "/account.html") {
      const nested = target.searchParams.get("returnTo") ?? "";
      if (!nested.startsWith("/") || nested.startsWith("//")) return null;
      const nestedTarget = new URL(nested, site);
      if (nestedTarget.origin !== site.origin || nestedTarget.pathname === "/account.html") return null;
      return `${nestedTarget.pathname}${nestedTarget.search}${nestedTarget.hash}`;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

// Point the action link at norva.tv carrying the one-time token_hash, NOT the raw
// {SUPABASE_URL}/auth/v1/verify URL — account.html verifies it client-side (verifyOtp),
// so the recipient only ever sees a norva.tv address (no "oupsceccx…supabase.co").
export function verifyUrl(d: EmailData, tokenHash = d.token_hash): string {
  const params = new URLSearchParams({
    token_hash: tokenHash,
    type: d.email_action_type,
  });
  const returnTo = redirectTarget(d.redirect_to);
  if (returnTo) params.set("returnTo", returnTo);
  return `${SITE_URL}/account.html?${params.toString()}`;
}

// Branded, email-client-safe HTML (tables + inline styles, dark theme).
function shell(opts: { heading: string; intro: string; cta?: { label: string; url: string }; note?: string; code?: string }): string {
  const button = opts.cta
    ? `<tr><td align="center" style="padding:8px 0 28px">
         <a href="${opts.cta.url}" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">${opts.cta.label}</a>
       </td></tr>`
    : "";
  const code = opts.code
    ? `<tr><td align="center" style="padding:8px 0 28px">
         <div style="display:inline-block;font-size:30px;letter-spacing:8px;font-weight:800;color:#ffffff;background:#161b24;border:1px solid #2a3344;border-radius:10px;padding:14px 24px">${opts.code}</div>
       </td></tr>`
    : "";
  const fallback = opts.cta
    ? `<tr><td style="padding:0 8px 8px;color:#5f6b85;font-size:12px;line-height:1.6;text-align:center">
         If the button doesn't work, copy and paste this link:<br>
         <a href="${opts.cta.url}" style="color:#7e9bff;word-break:break-all">${opts.cta.url}</a>
       </td></tr>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:#0a0c11">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${opts.heading} · Norva</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px;text-align:center">
          <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">
          <div style="color:#ffffff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;margin-top:10px">Norva</div>
        </td></tr>
        <tr><td style="padding:18px 32px 6px;text-align:center">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">${opts.heading}</h1>
        </td></tr>
        <tr><td style="padding:10px 32px 22px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${opts.intro}</td></tr>
        ${button}${code}${fallback}
        <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          ${opts.note ?? "If you didn't request this, you can safely ignore this email."}
        </td></tr>
      </table>
      <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>
    </td></tr>
  </table>
</body></html>`;
}

function renderHtml(
  d: EmailData,
  opts: { tokenHash?: string; emailChangeRecipient?: EmailChangeRecipient } = {},
): { subject: string; html: string } {
  const url = verifyUrl(d, opts.tokenHash ?? d.token_hash);
  switch (d.email_action_type) {
    case "signup":
      return {
        subject: "Confirm your email — Norva",
        html: shell({ heading: "Confirm your email", intro: "Welcome to Norva! Confirm your email address to activate your account and start watching.", cta: { label: "Confirm my email", url } }),
      };
    case "recovery":
      return {
        subject: "Reset your password — Norva",
        html: shell({ heading: "Reset your password", intro: "We received a request to reset your Norva password. Click below to choose a new one.", cta: { label: "Reset password", url } }),
      };
    case "magiclink":     // Supabase sends "magiclink" (one word); keep the underscore alias defensively.
    case "magic_link":
      return {
        subject: "Your sign-in link — Norva",
        html: shell({ heading: "Sign in to Norva", intro: "Click the button below to sign in. This link expires shortly and can be used once.", cta: { label: "Sign in", url } }),
      };
    case "email_change":
      if (opts.emailChangeRecipient === "current") {
        return {
          subject: "Confirm your email change — Norva",
          html: shell({
            heading: "Confirm your email change",
            intro: "Approve the request to change the email address on your Norva account.",
            cta: { label: "Approve email change", url },
            note: "If you didn't request this change, do not approve it and secure your account.",
          }),
        };
      }
      return {
        subject: "Confirm your new email — Norva",
        html: shell({ heading: "Confirm your new email", intro: "Confirm this address to finish updating the email on your Norva account.", cta: { label: "Confirm new email", url } }),
      };
    case "invite":
      return {
        subject: "You're invited to Norva",
        html: shell({ heading: "You're invited to Norva", intro: "You've been invited to Norva. Accept the invitation to set up your account.", cta: { label: "Accept invitation", url } }),
      };
    case "reauthentication":
      return {
        subject: "Your verification code — Norva",
        html: shell({ heading: "Verification code", intro: "Enter this code to confirm it's you.", code: d.token, note: "This code expires shortly. If you didn't request it, ignore this email." }),
      };
    default:
      return {
        subject: "Confirm your request — Norva",
        html: shell({ heading: "Confirm your request", intro: "Click below to continue.", cta: { label: "Continue", url } }),
      };
  }
}

function textFromHtml(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:h[1-6]|p|div|td|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function render(
  d: EmailData,
  opts: { tokenHash?: string; emailChangeRecipient?: EmailChangeRecipient } = {},
): { subject: string; html: string; text: string; flow: string } {
  const rendered = renderHtml(d, opts);
  const flow = d.email_action_type === "email_change"
    ? `email_change_${opts.emailChangeRecipient ?? "new"}`
    : d.email_action_type === "magiclink" ? "magic_link" : d.email_action_type;
  return { ...rendered, text: textFromHtml(rendered.html), flow };
}

/**
 * Resolve the delivery set required by the Supabase Send Email Hook.
 *
 * Supabase's email-change hash names are counterintuitive for backwards
 * compatibility: token_hash_new belongs to the current address, while
 * token_hash belongs to the new address. Without token_hash_new, Secure Email
 * Change is disabled and only the new address receives token_hash.
 */
export function buildOutboundEmails(payload: AuthEmailHookPayload): OutboundEmail[] {
  const d = payload?.email_data;
  if (!d?.email_action_type) throw new Error("Missing email data");

  const currentEmail = String(payload?.user?.email ?? "").trim();
  if (d.email_action_type !== "email_change") {
    if (!currentEmail) throw new Error("Missing recipient");
    const rendered = render(d);
    return [{ to: currentEmail, ...rendered }];
  }

  const newEmail = String(payload?.user?.new_email ?? "").trim();
  if (!newEmail) throw new Error("Missing new email recipient");
  if (!d.token_hash) throw new Error("Missing new email token hash");

  // token_hash_new is present when Secure Email Change is enabled. Reject an
  // incomplete secure payload before sending either mandatory confirmation.
  if (d.token_hash_new) {
    if (!currentEmail) throw new Error("Missing current email recipient");
    const current = render(d, {
      tokenHash: d.token_hash_new,
      emailChangeRecipient: "current",
    });
    const next = render(d, {
      tokenHash: d.token_hash,
      emailChangeRecipient: "new",
    });
    return [
      { to: currentEmail, ...current },
      { to: newEmail, ...next },
    ];
  }

  const rendered = render(d, {
    tokenHash: d.token_hash,
    emailChangeRecipient: "new",
  });
  return [{ to: newEmail, ...rendered }];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);

  const body = await req.text();
  if (!(await verifySignature(req.headers, body))) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: AuthEmailHookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }

  let emails: OutboundEmail[];
  try {
    emails = buildOutboundEmails(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid payload";
    return json({ error: detail }, 400);
  }

  const upstreamDeliveryId = String(req.headers.get("webhook-id") ?? req.headers.get("svix-id") ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  // Supabase normally supplies a stable webhook id. Hash the signed body as a
  // deterministic fallback so a retry after an ambiguous network response cannot
  // create a duplicate authentication email.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bodyDeliveryId = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 48);
  const deliveryId = upstreamDeliveryId || bodyDeliveryId;
  const request = buildResendAuthRequest(emails, deliveryId);
  try {
    const res = await fetch(request.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Auth-Email/2.0",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(8_000),
    });
    const response = await res.json().catch(() => ({})) as unknown;
    const acknowledgedIds = res.ok
      ? acknowledgedResendIds(response, request.batch, request.expectedIds)
      : null;
    if (!res.ok || !acknowledgedIds) {
      const code = res.ok ? "incomplete_provider_ack" : resendErrorCode(response);
      const retryable = res.ok || retryableResendFailure(res.status, code);
      // Provider payloads can contain recipient/content details. Log only the
      // bounded machine code and transport status, never the raw message.
      console.error("[norva-auth-email] Resend send failed", {
        status: res.status,
        code,
        retryable,
        expected_ids: request.expectedIds,
        acknowledged_ids: acknowledgedIds?.length ?? 0,
      });
      return json({ error: "Email send failed", retryable }, retryable ? 503 : 502);
    }
  } catch (error) {
    console.error("[norva-auth-email] Resend transport failed", {
      code: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "transport_error",
      retryable: true,
    });
    return json({ error: "Email send failed", retryable: true }, 503);
  }

  return json({});
});
