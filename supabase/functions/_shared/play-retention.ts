import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Authentication is supplied by norva-cloud's user-only router. The user id is
// never taken from the request body and none of these actions grants access.
export async function playRetention(req: Request, userId: string, db: SupabaseClient) {
  if (req.method === "GET") {
    const [offer, prefs] = await Promise.all([
      db.rpc("norva_play_retention_offer", { p_user: userId }),
      db.from("cloud_play_retention_preferences").select("push_opt_in").eq("user_id", userId).maybeSingle(),
    ]);
    if (offer.error || prefs.error) return { status: 503, body: { error: "play_retention_unavailable" } };
    return { body: { offer: offer.data ?? null, pushOptIn: prefs.data?.push_opt_in === true, contract: 1 } };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  const body = await req.json().catch(() => null);
  if (body?.action === "push-preference" && typeof body.enabled === "boolean") {
    const { error } = await db.from("cloud_play_retention_preferences").upsert({
      user_id: userId, push_opt_in: body.enabled, updated_at: new Date().toISOString(),
    });
    return error ? { status: 503, body: { error: "play_retention_unavailable" } } : { body: { ok: true } };
  }
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body?.offerId || "")
    || !["claim", "decline"].includes(body?.action)) return { status: 400, body: { error: "invalid_retention_request" } };
  const { data, error } = await db.rpc("norva_play_retention_action", {
    p_user: userId, p_offer: body.offerId, p_action: body.action,
  });
  if (error) return { status: 503, body: { error: "play_retention_unavailable" } };
  if (!data || data.pending) return { status: 409, body: { error: data?.pending ? "play_retention_pending" : "play_retention_ineligible" } };
  return { body: { offer: data, contract: 1 } };
}
