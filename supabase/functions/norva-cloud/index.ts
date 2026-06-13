import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const encoder = new TextEncoder();

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva-eight.vercel.app",
  "https://norva-pgkk.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const RELAY_BASE_URL = trimTrailingSlash(Deno.env.get("NORVA_RELAY_BASE_URL") ?? "");
const RELAY_TOKEN_SECRET = Deno.env.get("RELAY_TOKEN_SECRET") ?? "";
const MEDIA_GATEWAY_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "");
const MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    const result = await route(req, url, segments, supabase);
    return json(req, result.body, result.status ?? 200);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-cloud]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function route(
  req: Request,
  url: URL,
  segments: string[],
  db: SupabaseClient,
): Promise<{ status?: number; body: unknown }> {
  const [scope, id, action] = segments;

  if (req.method === "GET" && scope === "health") {
    return {
      body: {
        ok: true,
        service: "norva-cloud",
        version: 1,
        time: new Date().toISOString(),
      },
    };
  }

  if (scope === "pairing" && req.method === "POST" && id === "start") {
    return { status: 201, body: await startPairing(req, db) };
  }

  if (scope === "pairing" && req.method === "GET" && id) {
    return { body: await pollPairing(id, db) };
  }

  const user = await requireUser(req, db);

  if (!scope || scope === "profile") {
    if (req.method === "GET") return { body: await getProfile(user.id, db) };
    if (req.method === "PUT" || req.method === "PATCH") {
      return { body: await upsertProfile(req, user.id, db) };
    }
  }

  if (scope === "devices") {
    if (req.method === "GET" && !id) return { body: await listDevices(user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await createDevice(req, user.id, db) };
    if (req.method === "PATCH" && id && action === "heartbeat") {
      return { body: await heartbeatDevice(id, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await revokeDevice(id, user.id, db) };
  }

  if (scope === "sources") {
    if (req.method === "GET" && !id) return { body: await listSources(user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await createSource(req, user.id, db) };
    if ((req.method === "PATCH" || req.method === "PUT") && id) {
      return { body: await updateSource(req, id, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_sources", id, user.id, db) };
  }

  if (scope === "media-items") {
    if (req.method === "GET") return { body: await listMediaItems(url, user.id, db) };
    if (req.method === "POST") return { status: 201, body: await upsertMediaItems(req, user.id, db) };
  }

  if (scope === "favorites") {
    if (req.method === "GET" && !id) return { body: await listFavorites(url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await addFavorite(req, user.id, db) };
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_favorites", id, user.id, db) };
  }

  if (scope === "history") {
    if (req.method === "GET" && !id) return { body: await listHistory(url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await saveHistory(req, user.id, db) };
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_watch_history", id, user.id, db) };
  }

  if (scope === "pairing" && req.method === "POST" && id === "approve") {
    return { body: await approvePairing(req, user.id, db) };
  }

  if (scope === "commands") {
    if (req.method === "GET") return { body: await listCommands(url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await queueCommand(req, user.id, db) };
    if (req.method === "PATCH" && id) return { body: await updateCommand(req, id, user.id, db) };
  }

  if (scope === "playback" && id === "sessions") {
    if (req.method === "POST" && !action) {
      return { status: 201, body: await createPlaybackSession(req, user.id, db) };
    }
    if (req.method === "GET" && action) {
      return { body: await getPlaybackSession(action, user.id, db) };
    }
    if (req.method === "POST" && action && segments[3] === "expire") {
      return { body: await expirePlaybackSession(action, user.id, db) };
    }
  }

  throw new HttpError(404, "Route not found");
}

async function requireUser(req: Request, db: SupabaseClient): Promise<{ id: string; email?: string }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function getProfile(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load profile");
  return data ?? { id: userId };
}

async function upsertProfile(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const row = {
    id: userId,
    display_name: stringOrNull(body.displayName ?? body.display_name),
    avatar_url: stringOrNull(body.avatarUrl ?? body.avatar_url),
    locale: stringOrNull(body.locale) ?? "fr-FR",
  };

  const { data, error } = await db
    .from("cloud_profiles")
    .upsert(row, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to save profile");
  return data;
}

async function listDevices(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throwDb(error, "Unable to list devices");
  return { devices: data ?? [] };
}

async function createDevice(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const row = {
    user_id: userId,
    device_type: stringOr(body.deviceType ?? body.device_type, "unknown"),
    device_name: stringOr(body.deviceName ?? body.device_name, "Norva Device"),
    platform: stringOrNull(body.platform),
    app_version: stringOrNull(body.appVersion ?? body.app_version),
    public_key: stringOrNull(body.publicKey ?? body.public_key),
    capabilities: recordOrEmpty(body.capabilities),
    trusted: Boolean(body.trusted ?? false),
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = await db.from("cloud_devices").insert(row).select("*").single();
  if (error) throwDb(error, "Unable to register device");
  return { device: data };
}

async function heartbeatDevice(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to update device heartbeat");
  return { device: data };
}

async function revokeDevice(id: string, userId: string, db: SupabaseClient) {
  const { error } = await db
    .from("cloud_devices")
    .update({ revoked: true })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to revoke device");
  return { success: true };
}

async function listSources(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throwDb(error, "Unable to list sources");
  return { sources: data ?? [] };
}

async function createSource(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceType = stringOr(body.sourceType ?? body.source_type ?? body.type, "");
  const displayName = stringOr(body.displayName ?? body.display_name ?? body.name, "");
  if (!sourceType || !displayName) throw new HttpError(400, "sourceType and displayName are required");

  const row = {
    user_id: userId,
    source_type: sourceType,
    display_name: displayName,
    config_ciphertext: stringOrNull(body.configCiphertext ?? body.config_ciphertext),
    config_hint: recordOrEmpty(body.configHint ?? body.config_hint),
    sync_status: stringOr(body.syncStatus ?? body.sync_status, "idle"),
  };

  const { data, error } = await db.from("cloud_sources").insert(row).select("*").single();
  if (error) throwDb(error, "Unable to create source");
  return { source: data };
}

async function updateSource(req: Request, id: string, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const patch: JsonRecord = {};
  copyString(body, patch, "displayName", "display_name");
  copyString(body, patch, "display_name", "display_name");
  copyString(body, patch, "configCiphertext", "config_ciphertext");
  copyString(body, patch, "config_ciphertext", "config_ciphertext");
  copyString(body, patch, "syncStatus", "sync_status");
  copyString(body, patch, "sync_status", "sync_status");
  copyString(body, patch, "syncError", "sync_error");
  copyString(body, patch, "sync_error", "sync_error");
  if (isRecord(body.configHint)) patch.config_hint = body.configHint;
  if (isRecord(body.config_hint)) patch.config_hint = body.config_hint;
  if (body.lastSyncedAt || body.last_synced_at) {
    patch.last_synced_at = stringOrNull(body.lastSyncedAt ?? body.last_synced_at);
  }

  const { data, error } = await db
    .from("cloud_sources")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to update source");
  return { source: data };
}

async function listMediaItems(url: URL, userId: string, db: SupabaseClient) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");
  const search = url.searchParams.get("q");
  const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 250);

  let query = db
    .from("cloud_media_items")
    .select("*")
    .eq("user_id", userId)
    .limit(limit)
    .order("title", { ascending: true });

  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list media items");
  return { items: data ?? [] };
}

async function upsertMediaItems(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOr(body.sourceId ?? body.source_id, "");
  if (!sourceId) throw new HttpError(400, "sourceId is required");
  await assertOwnedSource(sourceId, userId, db);

  const rawItems = Array.isArray(body.items) ? body.items : [body];
  const rows = rawItems.map((item) => {
    if (!isRecord(item)) throw new HttpError(400, "items must be objects");
    const externalId = stringOr(item.externalId ?? item.external_id, "");
    const itemType = stringOr(item.itemType ?? item.item_type, "");
    const title = stringOr(item.title ?? item.name, "");
    if (!externalId || !itemType || !title) {
      throw new HttpError(400, "Each item requires externalId, itemType and title");
    }
    return {
      user_id: userId,
      source_id: sourceId,
      item_type: itemType,
      external_id: externalId,
      parent_external_id: stringOrNull(item.parentExternalId ?? item.parent_external_id),
      title,
      subtitle: stringOrNull(item.subtitle),
      poster_url: stringOrNull(item.posterUrl ?? item.poster_url),
      backdrop_url: stringOrNull(item.backdropUrl ?? item.backdrop_url),
      metadata: recordOrEmpty(item.metadata),
      playback_hint: recordOrEmpty(item.playbackHint ?? item.playback_hint),
      available: item.available === undefined ? true : Boolean(item.available),
    };
  });

  const { data, error } = await db
    .from("cloud_media_items")
    .upsert(rows, { onConflict: "source_id,item_type,external_id" })
    .select("*");
  if (error) throwDb(error, "Unable to upsert media items");
  return { items: data ?? [] };
}

async function listFavorites(url: URL, userId: string, db: SupabaseClient) {
  let query = db
    .from("cloud_favorites")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("itemType");
  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list favorites");
  return { favorites: data ?? [] };
}

async function addFavorite(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOr(body.sourceId ?? body.source_id, "");
  const itemType = stringOr(body.itemType ?? body.item_type, "live");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  if (!sourceId || !itemId) throw new HttpError(400, "sourceId and itemId are required");
  await assertOwnedSource(sourceId, userId, db);

  const row = {
    user_id: userId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    item_name: stringOrNull(body.itemName ?? body.item_name),
    item_meta: recordOrEmpty(body.itemMeta ?? body.item_meta),
  };

  const { data, error } = await db
    .from("cloud_favorites")
    .upsert(row, { onConflict: "user_id,source_id,item_type,item_id" })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to save favorite");
  return { favorite: data };
}

async function listHistory(url: URL, userId: string, db: SupabaseClient) {
  const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 500);
  const { data, error } = await db
    .from("cloud_watch_history")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throwDb(error, "Unable to list history");
  return { history: data ?? [] };
}

async function saveHistory(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const itemType = stringOr(body.itemType ?? body.item_type ?? body.type, "");
  const itemId = stringOr(body.itemId ?? body.item_id ?? body.id, "");
  if (!itemType || !itemId) throw new HttpError(400, "itemType and itemId are required");
  if (sourceId) await assertOwnedSource(sourceId, userId, db);

  const row = {
    user_id: userId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    parent_item_id: stringOrNull(body.parentItemId ?? body.parent_item_id),
    item_name: stringOrNull(body.itemName ?? body.item_name ?? body.name),
    progress_seconds: boundedInt(body.progressSeconds ?? body.progress_seconds ?? body.progress, 0, 0, 10_000_000),
    duration_seconds: boundedInt(body.durationSeconds ?? body.duration_seconds ?? body.duration, 0, 0, 10_000_000),
    completed: Boolean(body.completed ?? false),
    data: recordOrEmpty(body.data),
    watched_at: stringOrNull(body.watchedAt ?? body.watched_at) ?? new Date().toISOString(),
  };

  const { data, error } = await db
    .from("cloud_watch_history")
    .upsert(row, { onConflict: "user_id,source_id,item_type,item_id" })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to save history");
  return { item: data };
}

async function startPairing(req: Request, db: SupabaseClient) {
  const body = await readJson(req);
  const ttlSeconds = boundedInt(body.ttlSeconds ?? body.ttl_seconds, 300, 60, 900);
  const code = await uniquePairingCode(db);
  const row = {
    code,
    device_type: stringOr(body.deviceType ?? body.device_type, "unknown"),
    device_name: stringOrNull(body.deviceName ?? body.device_name),
    device_public_key: stringOrNull(body.devicePublicKey ?? body.device_public_key),
    status: "pending",
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };

  const { data, error } = await db.from("cloud_pairing_sessions").insert(row).select("*").single();
  if (error) throwDb(error, "Unable to start pairing");
  return {
    id: data.id,
    code: data.code,
    status: data.status,
    expiresAt: data.expires_at,
  };
}

async function pollPairing(code: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_pairing_sessions")
    .select("id, code, status, approved_device_id, expires_at, approved_at")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error) throwDb(error, "Unable to poll pairing");
  if (!data) return { status: "not_found" };
  if (new Date(data.expires_at).getTime() < Date.now() && data.status === "pending") {
    await db.from("cloud_pairing_sessions").update({ status: "expired" }).eq("id", data.id);
    return { status: "expired" };
  }
  return {
    id: data.id,
    code: data.code,
    status: data.status,
    approvedDeviceId: data.approved_device_id,
    expiresAt: data.expires_at,
    approvedAt: data.approved_at,
  };
}

async function approvePairing(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const code = stringOr(body.code, "").toUpperCase();
  if (!code) throw new HttpError(400, "code is required");

  const { data: pair, error: pairError } = await db
    .from("cloud_pairing_sessions")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (pairError) throwDb(pairError, "Unable to load pairing session");
  if (!pair) throw new HttpError(404, "Pairing session not found");
  if (pair.status !== "pending") throw new HttpError(409, "Pairing session is not pending");
  if (new Date(pair.expires_at).getTime() < Date.now()) throw new HttpError(410, "Pairing session expired");

  const { data: device, error: deviceError } = await db
    .from("cloud_devices")
    .insert({
      user_id: userId,
      device_type: pair.device_type ?? "unknown",
      device_name: pair.device_name ?? "Norva Device",
      public_key: pair.device_public_key,
      trusted: true,
      last_seen_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (deviceError) throwDb(deviceError, "Unable to create paired device");

  const { data, error } = await db
    .from("cloud_pairing_sessions")
    .update({
      user_id: userId,
      approved_device_id: device.id,
      status: "approved",
      approved_at: new Date().toISOString(),
    })
    .eq("id", pair.id)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to approve pairing");
  return { pairing: data, device };
}

async function listCommands(url: URL, userId: string, db: SupabaseClient) {
  const deviceId = url.searchParams.get("deviceId");
  let query = db
    .from("cloud_cast_commands")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (deviceId) query = query.eq("target_device_id", deviceId);
  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list commands");
  return { commands: data ?? [] };
}

async function queueCommand(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const targetDeviceId = stringOr(body.targetDeviceId ?? body.target_device_id, "");
  const command = stringOr(body.command, "");
  if (!targetDeviceId || !command) throw new HttpError(400, "targetDeviceId and command are required");
  await assertOwnedDevice(targetDeviceId, userId, db);

  const sourceDeviceId = stringOrNull(body.sourceDeviceId ?? body.source_device_id);
  if (sourceDeviceId) await assertOwnedDevice(sourceDeviceId, userId, db);

  const ttlSeconds = boundedInt(body.ttlSeconds ?? body.ttl_seconds, 120, 10, 3600);
  const { data, error } = await db
    .from("cloud_cast_commands")
    .insert({
      user_id: userId,
      source_device_id: sourceDeviceId,
      target_device_id: targetDeviceId,
      command,
      payload: recordOrEmpty(body.payload),
      status: "queued",
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to queue command");
  return { command: data };
}

async function updateCommand(req: Request, id: string, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const status = stringOr(body.status, "");
  if (!status) throw new HttpError(400, "status is required");
  const patch: JsonRecord = { status };
  if (status === "delivered") patch.delivered_at = new Date().toISOString();
  if (status === "acknowledged") patch.acknowledged_at = new Date().toISOString();

  const { data, error } = await db
    .from("cloud_cast_commands")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to update command");
  return { command: data };
}

async function createPlaybackSession(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const deviceId = stringOrNull(body.deviceId ?? body.device_id);
  const itemType = stringOr(body.itemType ?? body.item_type, "");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  const targetUrl = stringOr(body.targetUrl ?? body.target_url ?? body.url, "");
  const requestedMode = stringOr(body.mode, "auto");
  if (!itemType || !itemId || !targetUrl) throw new HttpError(400, "itemType, itemId and targetUrl are required");
  assertHttpUrl(targetUrl);
  if (sourceId) await assertOwnedSource(sourceId, userId, db);
  if (deviceId) await assertOwnedDevice(deviceId, userId, db);

  const mode = choosePlaybackMode(requestedMode, body);
  const ttlSeconds = boundedInt(body.ttlSeconds ?? body.ttl_seconds, 900, 60, 7200);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const targetUrlHash = await sha256Hex(targetUrl);

  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .insert({
      user_id: userId,
      source_id: sourceId,
      device_id: deviceId,
      item_type: itemType,
      item_id: itemId,
      mode,
      status: mode === "transcode" && !MEDIA_GATEWAY_URL ? "pending" : "ready",
      target_url_hash: targetUrlHash,
      stream_mime: stringOrNull(body.streamMime ?? body.stream_mime),
      playback_hint: recordOrEmpty(body.playbackHint ?? body.playback_hint),
      expires_at: expiresAt,
    })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to create playback session");

  if (mode === "direct") {
    return {
      session,
      playback: {
        mode,
        url: targetUrl,
        expiresAt,
      },
    };
  }

  if (mode === "relay") {
    const relay = await createRelayAccess(session.id, userId, targetUrl, expiresAt, db);
    return {
      session,
      playback: {
        mode,
        url: relay.url,
        tokenExpiresAt: expiresAt,
      },
    };
  }

  const gateway = await createGatewaySession(session.id, userId, targetUrl, expiresAt, db);
  return {
    session,
    playback: {
      mode,
      status: gateway.status,
      url: gateway.hlsUrl,
      gatewaySession: gateway.session,
      gatewayRequired: !gateway.hlsUrl,
    },
  };
}

async function getPlaybackSession(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_playback_sessions")
    .select("*, cloud_gateway_sessions(*)")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load playback session");
  if (!data) throw new HttpError(404, "Playback session not found");
  return { session: data };
}

async function expirePlaybackSession(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_playback_sessions")
    .update({ status: "expired", expires_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to expire playback session");
  return { session: data };
}

async function createRelayAccess(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  db: SupabaseClient,
) {
  if (!RELAY_BASE_URL || !RELAY_TOKEN_SECRET) {
    throw new HttpError(503, "Norva Relay is not configured");
  }

  const payload = JSON.stringify({
    v: 1,
    sid: playbackSessionId,
    uid: userId,
    url: targetUrl,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  });
  const signature = await hmacBase64Url(RELAY_TOKEN_SECRET, payload);
  const token = `${base64Url(encoder.encode(payload))}.${signature}`;
  const tokenHash = await sha256Hex(token);

  const { error } = await db.from("cloud_relay_tokens").insert({
    user_id: userId,
    playback_session_id: playbackSessionId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (error) throwDb(error, "Unable to record relay token");

  return { url: `${RELAY_BASE_URL}/relay/${token}` };
}

async function createGatewaySession(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  db: SupabaseClient,
) {
  if (!MEDIA_GATEWAY_URL || !MEDIA_GATEWAY_TOKEN) {
    const { data, error } = await db
      .from("cloud_gateway_sessions")
      .insert({
        user_id: userId,
        playback_session_id: playbackSessionId,
        status: "pending",
        mode: "remux",
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error) throwDb(error, "Unable to create pending gateway session");
    return { status: "pending", session: data, hlsUrl: null };
  }

  const response = await fetch(`${MEDIA_GATEWAY_URL}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MEDIA_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ playbackSessionId, sourceUrl: targetUrl, expiresAt }),
  });
  const gatewayBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
  }

  const { data, error } = await db
    .from("cloud_gateway_sessions")
    .insert({
      user_id: userId,
      playback_session_id: playbackSessionId,
      external_session_id: stringOrNull(gatewayBody.id),
      status: stringOr(gatewayBody.status, "starting"),
      mode: stringOr(gatewayBody.mode, "remux"),
      hls_url: stringOrNull(gatewayBody.hlsUrl ?? gatewayBody.hls_url),
      expires_at: expiresAt,
    })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to record gateway session");
  return { status: data.status, session: data, hlsUrl: data.hls_url };
}

async function assertOwnedSource(sourceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify source");
  if (!data) throw new HttpError(404, "Source not found");
}

async function assertOwnedDevice(deviceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .select("id")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .eq("revoked", false)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify device");
  if (!data) throw new HttpError(404, "Device not found");
}

async function deleteOwned(table: string, id: string, userId: string, db: SupabaseClient) {
  const { error } = await db.from(table).delete().eq("id", id).eq("user_id", userId);
  if (error) throwDb(error, "Unable to delete row");
  return { success: true };
}

async function uniquePairingCode(db: SupabaseClient) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generatePairingCode();
    const { data, error } = await db
      .from("cloud_pairing_sessions")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (error) throwDb(error, "Unable to reserve pairing code");
    if (!data) return code;
  }
  throw new HttpError(503, "Unable to generate pairing code");
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function choosePlaybackMode(requestedMode: string, body: JsonRecord): "direct" | "relay" | "transcode" {
  if (requestedMode === "direct" || requestedMode === "relay" || requestedMode === "transcode") {
    return requestedMode;
  }
  if (body.requiresTranscode === true) return "transcode";
  if (body.requiresRelay === true || body.corsSafe === false) return "relay";
  return "direct";
}

function routeSegments(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "norva-cloud") parts.shift();
  return parts;
}

async function readJson(req: Request): Promise<JsonRecord> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("JSON body must be an object");
    return parsed;
  } catch (error) {
    throw new HttpError(400, "Invalid JSON body", error instanceof Error ? error.message : undefined);
  }
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

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowAll = allowed.includes("*");
  const allowOrigin = origin && (allowAll || allowed.includes(origin) || isLocalOrigin(origin)) ? origin : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isLocalOrigin(origin: string) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw new HttpError(400, "targetUrl must be a valid http(s) URL");
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function copyString(source: JsonRecord, target: JsonRecord, from: string, to: string) {
  if (typeof source[from] === "string") target[to] = source[from];
}

function throwDb(error: { message?: string; code?: string; details?: string }, fallback: string): never {
  throw new HttpError(500, fallback, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
}
