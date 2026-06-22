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

  return json(req, { ok: true, deleted: true, userId: user.id });
});
