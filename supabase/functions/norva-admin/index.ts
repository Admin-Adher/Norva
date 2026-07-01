// norva-admin — privileged admin actions on users (resend confirmation · change role · suspend).
//
// These touch Supabase Auth (app_metadata.role, ban_duration, confirmation emails), which require the
// SERVICE ROLE key — hence an edge function, not a browser RPC. Every request is gated by an ADMIN
// JWT: we verify the caller's token resolves to a user whose server-set app_metadata.role === 'admin'
// (non-spoofable). Each action writes an admin_events row so it shows in the client's timeline.
//
// Routes (POST):
//   /user/:id/resend-confirmation   → re-send the signup confirmation email
//   /user/:id/role       { role }    → set app_metadata.role to 'admin' | 'user'
//   /user/:id/suspend    { suspend } → ban (suspend) or unban the account
import { createClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv", "https://www.norva.tv", "https://app.norva.tv",
  "https://norva-web.pages.dev", "http://localhost:3000", "http://localhost:5173", "http://localhost:4173",
];
function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const isLocal = (() => { try { return origin ? ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname) : false; } catch { return false; } })();
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin) || isLocal) ? origin : allowed[0];
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
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function logEvent(userId: string, kind: string, summary: string, actor: string | null, meta: JsonRecord = {}) {
  try { await admin.from("admin_events").insert({ user_id: userId, kind, summary, actor, meta }); }
  catch (_) { /* best-effort audit */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

    // ── admin gate ──
    const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!token) return json(req, { error: "Missing bearer token" }, 401);
    const { data: au } = await admin.auth.getUser(token);
    const actorRole = (au?.user?.app_metadata as JsonRecord | undefined)?.role;
    if (actorRole !== "admin") return json(req, { error: "not authorized" }, 403);
    const actorEmail = au?.user?.email ?? null;
    const actorId = au?.user?.id ?? "";

    // ── route: /user/:id/:action ──
    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    const i = segments.indexOf("user");
    const userId = i >= 0 ? segments[i + 1] : "";
    const action = i >= 0 ? segments[i + 2] : "";
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return json(req, { error: "Missing/invalid user id" }, 400);

    const body = await req.json().catch(() => ({})) as JsonRecord;

    // Target must exist (and gives us the email for resend + a friendly label).
    const { data: target, error: getErr } = await admin.auth.admin.getUserById(userId);
    if (getErr || !target?.user) return json(req, { error: "user not found" }, 404);
    const targetEmail = target.user.email ?? "";

    if (action === "resend-confirmation") {
      if (target.user.email_confirmed_at) return json(req, { ok: false, message: "Email déjà confirmé." });
      if (!ANON_KEY) return json(req, { error: "resend not configured" }, 503);
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { error } = await anon.auth.resend({ type: "signup", email: targetEmail });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", "Email de confirmation renvoyé", actorEmail);
      return json(req, { ok: true, message: "Email de confirmation renvoyé." });
    }

    // Anti self-lockout: an admin cannot demote or suspend their OWN account (would strand the panel).
    if (userId === actorId && action === "role" && String(body.role) === "user") {
      return json(req, { error: "Vous ne pouvez pas retirer votre propre rôle admin." }, 400);
    }
    if (userId === actorId && action === "suspend" && (body.suspend === true || body.suspend === "true")) {
      return json(req, { error: "Vous ne pouvez pas suspendre votre propre compte." }, 400);
    }

    if (action === "role") {
      const role = String(body.role ?? "");
      if (role !== "admin" && role !== "user") return json(req, { error: "role must be admin|user" }, 400);
      const existing = (target.user.app_metadata ?? {}) as JsonRecord;
      const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...existing, role } });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", `Rôle changé → ${role}`, actorEmail, { role });
      return json(req, { ok: true, role });
    }

    if (action === "suspend") {
      const suspend = body.suspend === true || body.suspend === "true";
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: suspend ? "876000h" : "none" });
      if (error) return json(req, { error: error.message }, 400);
      await logEvent(userId, "admin_action", suspend ? "Compte suspendu" : "Compte réactivé", actorEmail);
      return json(req, { ok: true, suspended: suspend });
    }

    return json(req, { error: "Unknown action" }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[norva-admin]", message);
    return json(req, { error: message }, 500);
  }
});
