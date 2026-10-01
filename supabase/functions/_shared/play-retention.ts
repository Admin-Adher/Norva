import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Authentication is supplied by norva-cloud's user-only router. The user id is
// never taken from the request body and none of these actions grants access.
export async function playRetention(req: Request, userId: string, db: SupabaseClient) {
  if (req.method === "GET") {
    const offerId = new URL(req.url).searchParams.get("offerId");
    if (offerId !== null) {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(offerId)) {
        return { status: 400, body: { error: "invalid_retention_request" } };
      }
      // Read the verified purchase ledger, never the SDK callback or client price.
      // Filtering by owner is mandatory even though this client has service access.
      const { data, error } = await db.from("cloud_play_retention_offers")
        .select("state,accepted_at,purchase_event,claimed_at,expires_at")
        .eq("user_id", userId).eq("id", offerId).maybeSingle();
      if (error) return { status: 503, body: { error: "play_retention_unavailable" } };
      if (!data) return { status: 404, body: { error: "play_retention_unavailable" } };
      const state = data.state === "accepted" && data.accepted_at && data.purchase_event ? "confirmed"
        : data.state === "accepted" ? "pending"
        : data.state === "declined" ? "declined"
        : Date.parse(data.expires_at) <= Date.now() ? "expired"
        : data.claimed_at ? "pending" : "available";
      return { body: { confirmation: { state }, contract: 1 } };
    }
    const [offer, prefs, recent] = await Promise.all([
      db.rpc("norva_play_retention_offer", { p_user: userId }),
      db.from("cloud_play_retention_preferences").select("push_opt_in").eq("user_id", userId).maybeSingle(),
      db.from("cloud_play_retention_offers").select("id,state,accepted_at,purchase_event")
        .eq("user_id", userId).gte("claimed_at", new Date(Date.now() - 600_000).toISOString())
        .order("claimed_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (offer.error || prefs.error || recent.error) return { status: 503, body: { error: "play_retention_unavailable" } };
    const confirmation = recent.data && recent.data.state !== "declined" ? {
      offerId: recent.data.id,
      state: recent.data.state === "accepted" && recent.data.accepted_at && recent.data.purchase_event ? "confirmed" : "pending",
    } : null;
    return { body: { offer: offer.data ?? null, confirmation, pushOptIn: prefs.data?.push_opt_in === true, contract: 1 } };
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
