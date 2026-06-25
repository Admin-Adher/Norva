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
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

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

interface EmailData {
  token: string;
  token_hash: string;
  redirect_to: string;
  email_action_type: string;
  site_url?: string;
  token_new?: string;
  token_hash_new?: string;
}

function verifyUrl(d: EmailData): string {
  const params = new URLSearchParams({
    token: d.token_hash,
    type: d.email_action_type,
    redirect_to: d.redirect_to ?? "",
  });
  return `${SUPABASE_URL}/auth/v1/verify?${params.toString()}`;
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
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11">
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

function render(d: EmailData): { subject: string; html: string } {
  const url = verifyUrl(d);
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
    case "magic_link":
      return {
        subject: "Your sign-in link — Norva",
        html: shell({ heading: "Sign in to Norva", intro: "Click the button below to sign in. This link expires shortly and can be used once.", cta: { label: "Sign in", url } }),
      };
    case "email_change":
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);

  const body = await req.text();
  if (!(await verifySignature(req.headers, body))) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: { user: { email: string }; email_data: EmailData };
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }

  const to = payload?.user?.email;
  if (!to) return json({ error: "Missing recipient" }, 400);

  const { subject, html } = render(payload.email_data);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("[norva-auth-email] Resend send failed", res.status, detail);
    // Non-2xx tells Supabase the email failed so it can surface the error.
    return json({ error: "Email send failed" }, 502);
  }

  return json({});
});
