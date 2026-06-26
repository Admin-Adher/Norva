// Norva — account self-deletion endpoint (Google Play / GDPR requirement).
//
// Verifies the caller's Supabase JWT, then deletes the auth user with the
// service role. Every user-owned table references auth.users(id)
// ON DELETE CASCADE, so deleting the auth user removes all of their data
// (sources, devices, history, entitlements, projections, …).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv",
  "https://www.norva.tv",
  "http://localhost:3000",
  "http://localhost:5173",
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function isLocalOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowAll = allowed.includes("*");
  const allowOrigin =
    origin && (allowAll || allowed.includes(origin) || isLocalOrigin(origin))
      ? origin
      : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Branded closure email (dark theme, matches the auth emails). No action link.
function accountDeletedHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px;text-align:center">
          <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">
          <div style="color:#ffffff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;margin-top:10px">Norva</div>
        </td></tr>
        <tr><td style="padding:18px 32px 6px;text-align:center">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">Your account has been deleted</h1>
        </td></tr>
        <tr><td style="padding:10px 32px 22px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
          Your Norva account and all associated data have been permanently removed, as requested. We're sorry to see you go.<br><br>
          If you didn't request this, please contact us right away.
        </td></tr>
        <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          You can create a new account anytime at norva.tv.
        </td></tr>
      </table>
      <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>
    </td></tr>
  </table>
</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  // Authenticate the caller from their Supabase JWT.
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(req, { error: "Missing bearer token" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    return json(req, { error: "Invalid or expired session" }, 401);
  }
  const user = userData.user;

  // Require an explicit confirmation so a stray POST can never wipe an account.
  let confirm = "";
  try {
    const body = await req.json();
    confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";
  } catch (_) {
    /* no JSON body */
  }
  const email = (user.email ?? "").toLowerCase();
  if (confirm !== "DELETE" && (!email || confirm.toLowerCase() !== email)) {
    return json(
      req,
      {
        error: "Confirmation required",
        hint: 'POST { "confirm": "DELETE" } or { "confirm": "<your account email>" }',
      },
      400,
    );
  }

  // Deletes the auth user; ON DELETE CASCADE removes every user-owned row.
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return json(req, { error: "Deletion failed", details: delErr.message }, 500);
  }

  // Best-effort closure email — the deletion already succeeded, so never fail over it.
  try {
    const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
    const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
    if (resendKey && email) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [email],
          subject: "Your Norva account has been deleted",
          html: accountDeletedHtml(),
        }),
      });
    }
  } catch (_) {
    /* email is best-effort */
  }

  return json(req, { ok: true, deleted: true, userId: user.id });
});
