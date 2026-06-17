import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refreshMaterializedLiveCatalog } from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection } from "../_shared/vod-title-projection.ts";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { getEntitlementDecision, getEntitlementRuntime, limitNumber } from "../_shared/entitlements.ts";

type JsonRecord = Record<string, unknown>;
type CloudUser = { id: string; email?: string };
type CloudDevice = {
  id: string;
  user_id: string;
  device_type?: string;
  device_name?: string;
  capabilities?: JsonRecord;
};
type RuntimeConfig = {
  relayBaseUrl: string;
  relayTokenSecret: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  sourceConfigKey: string;
};

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
const ENV_RELAY_BASE_URL = trimTrailingSlash(Deno.env.get("NORVA_RELAY_BASE_URL") ?? "");
const ENV_RELAY_TOKEN_SECRET = Deno.env.get("RELAY_TOKEN_SECRET") ?? "";
const ENV_MEDIA_GATEWAY_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const DEVICE_PUBLIC_SELECT =
  "id, user_id, device_type, device_name, platform, app_version, public_key, capabilities, trusted, revoked, last_seen_at, created_at, updated_at";
const RUNTIME_CONFIG_KEYS = [
  "NORVA_RELAY_BASE_URL",
  "RELAY_TOKEN_SECRET",
  "NORVA_MEDIA_GATEWAY_URL",
  "NORVA_MEDIA_GATEWAY_TOKEN",
  "NORVA_SOURCE_CONFIG_KEY",
];
const CONTENT_REGION_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const PLAYBACK_EVENT_TYPES = new Set([
  "session_created",
  "play_requested",
  "play_started",
  "first_frame",
  "pause",
  "resume",
  "ended",
  "abandoned",
  "playback_error",
  "gateway_error",
]);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;
const EPG_CACHE_TTL_MS = 10 * 60 * 1000;
const EPG_WINDOW_BUCKET_MS = 30 * 60 * 1000;
const EPG_MAX_XML_BYTES = 80_000_000;
const EPG_MAX_PROGRAMMES = 80_000;
const epgCache = new Map<string, { expiresAt: number; data: unknown }>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "image") {
      return await proxyImage(req, url);
    }
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
    const runtimeConfig = await getRuntimeConfig(db);
    const entitlementRuntime = getEntitlementRuntime();
    return {
      body: {
        ok: true,
        service: "norva-cloud",
        version: 14,
        entitlements: true,
        entitlementsMode: entitlementRuntime.mode,
        entitlementsEnforced: entitlementRuntime.enforced,
        liveMaterialization: true,
        relayConfigured: Boolean(runtimeConfig.relayBaseUrl && runtimeConfig.relayTokenSecret),
        gatewayConfigured: Boolean(runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken),
        cloudSourceConfigured: Boolean(runtimeConfig.sourceConfigKey),
        time: new Date().toISOString(),
      },
    };
  }

  if (scope === "pairing" && req.method === "POST" && id === "start") {
    return { status: 201, body: await startPairing(req, db) };
  }

  if (scope === "pairing" && req.method === "GET" && id) {
    return { body: await pollPairing(req, id, db) };
  }

  if (scope === "device") {
    const device = await requireDevice(req, db);
    if (req.method === "GET" && id === "me") return { body: { device } };
    if ((req.method === "POST" || req.method === "PATCH") && id === "heartbeat") {
      return { body: await heartbeatDeviceToken(device, db) };
    }
    if (req.method === "GET" && id === "sources" && !action) {
      return { body: await listSources(device.user_id, db) };
    }
    if (req.method === "GET" && id === "sources" && action && segments[3] === "series-info") {
      return { body: await getXtreamSeriesInfo(url, action, device.user_id, db) };
    }
    if (req.method === "GET" && id === "sources" && action && segments[3] === "short-epg") {
      return { body: await getXtreamShortEpg(url, action, device.user_id, db) };
    }
    if (req.method === "GET" && id === "sources" && action && segments[3] === "epg") {
      return { body: await getSourceEpg(url, action, device.user_id, db) };
    }
    if (req.method === "GET" && id === "media-items") {
      return { body: await listMediaItems(url, device.user_id, db) };
    }
    if (req.method === "GET" && id === "entitlements") {
      return { body: await getEntitlementDecision(db, device.user_id) };
    }
    if (id === "playback" && action === "sessions" && req.method === "POST") {
      await requirePlanCapacity(device.user_id, db, "concurrent_streams", "cloud_playback_sessions", {
        activeSession: true,
      });
      return { status: 201, body: await createPlaybackSession(req, device.user_id, db, device.id) };
    }
    if (id === "playback" && action === "events" && req.method === "POST") {
      return { status: 201, body: await recordPlaybackEvent(req, device.user_id, db, device.id) };
    }
    if (id === "commands") {
      if (req.method === "GET" && !action) return { body: await listDeviceCommands(url, device, db) };
      if (req.method === "PATCH" && action) return { body: await updateDeviceCommand(req, action, device, db) };
    }
  }

  const user = await requireUser(req, db);

  if (scope === "entitlements" && req.method === "GET") {
    return { body: await getEntitlementDecision(db, user.id) };
  }

  if (!scope || scope === "profile") {
    if (req.method === "GET") return { body: await getProfile(user.id, db) };
    if (req.method === "PUT" || req.method === "PATCH") {
      return { body: await upsertProfile(req, user.id, db) };
    }
  }

  if (scope === "devices") {
    if (req.method === "GET" && !id) return { body: await listDevices(user.id, db) };
    if (req.method === "POST" && !id) {
      await requirePlanCapacity(user.id, db, "trusted_devices", "cloud_devices", {
        revoked: false,
      });
      return { status: 201, body: await createDevice(req, user.id, db) };
    }
    if (req.method === "PATCH" && id && action === "heartbeat") {
      return { body: await heartbeatDevice(id, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await revokeDevice(id, user.id, db) };
  }

  if (scope === "sources") {
    if (req.method === "GET" && !id) return { body: await listSources(user.id, db) };
    if (req.method === "POST" && !id) {
      await requirePlanCapacity(user.id, db, "sources", "cloud_sources");
      return { status: 201, body: await createSource(req, user.id, db) };
    }
    if (req.method === "GET" && id && action === "series-info") {
      return { body: await getXtreamSeriesInfo(url, id, user.id, db) };
    }
    if (req.method === "GET" && id && action === "short-epg") {
      return { body: await getXtreamShortEpg(url, id, user.id, db) };
    }
    if (req.method === "GET" && id && action === "epg") {
      return { body: await getSourceEpg(url, id, user.id, db) };
    }
    if (req.method === "POST" && id && action === "sync") {
      await requireCloudAccess(user.id, db, "source_sync");
      return { body: await syncExistingSource(id, user.id, db) };
    }
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
    await requirePlanCapacity(user.id, db, "trusted_devices", "cloud_devices", {
      revoked: false,
    });
    return { body: await approvePairing(req, user.id, db) };
  }

  if (scope === "commands") {
    if (req.method === "GET") return { body: await listCommands(url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await queueCommand(req, user.id, db) };
    if (req.method === "PATCH" && id) return { body: await updateCommand(req, id, user.id, db) };
  }

  if (scope === "playback" && id === "sessions") {
    if (req.method === "POST" && !action) {
      await requirePlanCapacity(user.id, db, "concurrent_streams", "cloud_playback_sessions", {
        activeSession: true,
      });
      return { status: 201, body: await createPlaybackSession(req, user.id, db) };
    }
    if (req.method === "GET" && action) {
      return { body: await getPlaybackSession(action, user.id, db) };
    }
    if (req.method === "POST" && action && segments[3] === "expire") {
      return { body: await expirePlaybackSession(action, user.id, db) };
    }
  }

  if (scope === "playback" && id === "events" && req.method === "POST") {
    return { status: 201, body: await recordPlaybackEvent(req, user.id, db) };
  }

  throw new HttpError(404, "Route not found");
}

async function requireUser(req: Request, db: SupabaseClient): Promise<CloudUser> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function requireDevice(req: Request, db: SupabaseClient): Promise<CloudDevice> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing device token");

  const tokenHash = await sha256Hex(token);
  const { data, error } = await db
    .from("cloud_devices")
    .select("id, user_id, device_type, device_name, capabilities")
    .eq("device_token_hash", tokenHash)
    .eq("revoked", false)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify device token");
  if (!data) throw new HttpError(401, "Invalid device token");
  return {
    id: data.id,
    user_id: data.user_id,
    device_type: data.device_type,
    device_name: data.device_name,
    capabilities: recordOrEmpty(data.capabilities),
  };
}

async function requireCloudAccess(userId: string, db: SupabaseClient, feature: string) {
  const decision = await getEntitlementDecision(db, userId);
  if (!decision.allowed) throwEntitlementRequired(feature, decision);
  return decision;
}

async function requirePlanCapacity(
  userId: string,
  db: SupabaseClient,
  limitKey: string,
  table: string,
  filters: { revoked?: boolean; activeSession?: boolean } = {},
) {
  const decision = await requireCloudAccess(userId, db, limitKey);
  const limit = limitNumber(decision.limits, limitKey, 0);
  if (limit <= 0) throwEntitlementRequired(limitKey, decision, { limit, current: 0 });

  const count = await countEntitlementUsage(userId, db, table, filters);
  if (count >= limit) {
    throwEntitlementRequired(limitKey, decision, { limit, current: count });
  }

  return { decision, limit, current: count };
}

async function countEntitlementUsage(
  userId: string,
  db: SupabaseClient,
  table: string,
  filters: { revoked?: boolean; activeSession?: boolean } = {},
) {
  let query = db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (typeof filters.revoked === "boolean") {
    query = query.eq("revoked", filters.revoked);
  }
  if (filters.activeSession) {
    query = query.in("status", ["pending", "ready"]).gt("expires_at", new Date().toISOString());
  }

  const { count, error } = await query;
  if (error) throwDb(error, "Unable to verify Norva access limits");
  return count ?? 0;
}

function throwEntitlementRequired(feature: string, decision: unknown, usage?: unknown): never {
  throw new HttpError(402, "Norva access required", {
    code: "subscription_required",
    feature,
    entitlement: decision,
    usage,
  });
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
  const { data: existing, error: existingError } = await db
    .from("cloud_profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (existingError) throwDb(existingError, "Unable to load profile");

  const hasDisplayName =
    Object.prototype.hasOwnProperty.call(body, "displayName") ||
    Object.prototype.hasOwnProperty.call(body, "display_name");
  const hasAvatarUrl =
    Object.prototype.hasOwnProperty.call(body, "avatarUrl") ||
    Object.prototype.hasOwnProperty.call(body, "avatar_url");
  const hasLocale = Object.prototype.hasOwnProperty.call(body, "locale");
  const hasRegion =
    Object.prototype.hasOwnProperty.call(body, "preferredContentRegion") ||
    Object.prototype.hasOwnProperty.call(body, "preferred_content_region");

  const row: JsonRecord = {
    id: userId,
    display_name: hasDisplayName ? stringOrNull(body.displayName ?? body.display_name) : stringOrNull(existing?.display_name),
    avatar_url: hasAvatarUrl ? stringOrNull(body.avatarUrl ?? body.avatar_url) : stringOrNull(existing?.avatar_url),
    locale: hasLocale ? (stringOrNull(body.locale) ?? "fr-FR") : (stringOrNull(existing?.locale) ?? "fr-FR"),
  };

  if (hasRegion) {
    if (!hasExplicitContentRegionConfirmation(body)) {
      throw new HttpError(400, "preferred_content_region requires explicit user confirmation");
    }
    const region = normalizeContentRegion(body.preferredContentRegion ?? body.preferred_content_region);
    row.preferred_content_region = region;
    row.preferred_content_region_confirmed_at = region ? new Date().toISOString() : null;
    row.content_region_taxonomy_version = "v1";
  }

  const { data, error } = await db
    .from("cloud_profiles")
    .upsert(row, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to save profile");
  return data;
}

function hasExplicitContentRegionConfirmation(body: JsonRecord) {
  return (
    body.confirmPreferredContentRegion === true ||
    body.confirm_preferred_content_region === true ||
    body.preferredContentRegionConfirmed === true ||
    body.preferred_content_region_confirmed === true ||
    body.regionPreferenceConfirmed === true ||
    body.region_preference_confirmed === true
  );
}

function normalizeContentRegion(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (!CONTENT_REGION_PATTERN.test(normalized)) {
    throw new HttpError(400, "Invalid preferred_content_region");
  }
  return normalized;
}

async function listDevices(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .select(DEVICE_PUBLIC_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throwDb(error, "Unable to list devices");
  return { devices: data ?? [] };
}

async function createDevice(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const issueDeviceToken = body.issueDeviceToken === true || body.issue_device_token === true;
  const deviceToken = issueDeviceToken ? generateDeviceToken() : "";
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
    device_token_hash: deviceToken ? await sha256Hex(deviceToken) : null,
    device_token_issued_at: deviceToken ? new Date().toISOString() : null,
  };

  const { data, error } = await db.from("cloud_devices").insert(row).select(DEVICE_PUBLIC_SELECT).single();
  if (error) throwDb(error, "Unable to register device");
  return { device: data, deviceToken: deviceToken || undefined };
}

async function heartbeatDevice(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select(DEVICE_PUBLIC_SELECT)
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
  return { sources: (data ?? []).map(sanitizeSource) };
}

async function createSource(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceType = stringOr(body.sourceType ?? body.source_type ?? body.type, "");
  const displayName = stringOr(body.displayName ?? body.display_name ?? body.name, "");
  if (!sourceType || !displayName) throw new HttpError(400, "sourceType and displayName are required");
  if (!["xtream", "m3u", "epg"].includes(sourceType)) throw new HttpError(400, "Unsupported source type");

  const rawConfig = buildSourceConfig(sourceType, body);
  const hasManagedConfig = Object.keys(rawConfig).length > 0;
  const validation = hasManagedConfig ? await validateCloudSource(sourceType, rawConfig) : {};
  const configCiphertext = hasManagedConfig
    ? await encryptSourceConfig(rawConfig, await getRuntimeConfig(db))
    : stringOrNull(body.configCiphertext ?? body.config_ciphertext);
  const configHint = {
    ...recordOrEmpty(body.configHint ?? body.config_hint),
    ...buildSourceHint(sourceType, rawConfig, validation),
    managedBy: hasManagedConfig ? "norva-cloud" : undefined,
  };
  const syncNow = hasManagedConfig && body.syncNow !== false && body.sync_now !== false;

  const row = {
    user_id: userId,
    source_type: sourceType,
    display_name: displayName,
    config_ciphertext: configCiphertext,
    config_hint: compactRecord(configHint),
    sync_status: syncNow ? "syncing" : stringOr(body.syncStatus ?? body.sync_status, "idle"),
  };

  const { data, error } = await db.from("cloud_sources").insert(row).select("*").single();
  if (error) throwDb(error, "Unable to create source");

  if (syncNow) {
    waitUntil(syncCloudSource(data.id, userId, db));
  }

  return { source: sanitizeSource(data), validation, syncStarted: syncNow };
}

async function updateSource(req: Request, id: string, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const { data: existing, error: existingError } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throwDb(existingError, "Unable to load source");
  if (!existing) throw new HttpError(404, "Source not found");

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

  const requestedSourceType = stringOr(body.sourceType ?? body.source_type ?? body.type, "");
  const sourceType = requestedSourceType || stringOr(existing.source_type, "");
  if (!["xtream", "m3u", "epg"].includes(sourceType)) throw new HttpError(400, "Unsupported source type");

  const rawConfig = buildSourceConfig(sourceType, body);
  const hasManagedConfig = Object.keys(rawConfig).length > 0;
  if (hasManagedConfig) {
    const validation = await validateCloudSource(sourceType, rawConfig);
    patch.source_type = sourceType;
    patch.config_ciphertext = await encryptSourceConfig(rawConfig, await getRuntimeConfig(db));
    patch.config_hint = compactRecord({
      ...recordOrEmpty(existing.config_hint),
      ...recordOrEmpty(body.configHint ?? body.config_hint),
      ...buildSourceHint(sourceType, rawConfig, validation),
      managedBy: "norva-cloud",
    });
    patch.sync_status = body.syncNow === false || body.sync_now === false ? "idle" : "syncing";
    patch.sync_error = null;
  }

  const { data, error } = await db
    .from("cloud_sources")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to update source");

  if (hasManagedConfig && body.syncNow !== false && body.sync_now !== false) {
    waitUntil(syncCloudSource(id, userId, db));
  }

  return { source: sanitizeSource(data) };
}

async function syncExistingSource(id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  const { data, error } = await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to start source sync");
  waitUntil(syncCloudSource(id, userId, db));
  return { source: sanitizeSource(data), syncStarted: true };
}

function sanitizeSource(source: JsonRecord) {
  const { config_ciphertext: _configCiphertext, ...safeSource } = source;
  return safeSource;
}

function buildSourceConfig(sourceType: string, body: JsonRecord): JsonRecord {
  const supplied = recordOrEmpty(body.config);
  if (Object.keys(supplied).length) return supplied;

  if (sourceType === "xtream") {
    const serverUrl = stringOr(body.serverUrl ?? body.server_url ?? body.url, "");
    const username = stringOr(body.username, "");
    const password = stringOr(body.password, "");
    return serverUrl || username || password ? { serverUrl, username, password } : {};
  }

  if (sourceType === "m3u") {
    const playlistUrl = stringOr(body.playlistUrl ?? body.playlist_url ?? body.url, "");
    return playlistUrl ? { playlistUrl } : {};
  }

  if (sourceType === "epg") {
    const epgUrl = stringOr(body.epgUrl ?? body.epg_url ?? body.url, "");
    return epgUrl ? { epgUrl } : {};
  }

  return {};
}

async function validateCloudSource(sourceType: string, config: JsonRecord) {
  if (sourceType === "xtream") {
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = stringOr(config.username, "");
    const password = stringOr(config.password, "");
    if (!serverUrl || !username || !password) {
      throw new HttpError(400, "Xtream requires server URL, username and password");
    }

    const payload = recordOrEmpty(await fetchJson(xtreamApiUrl({ serverUrl, username, password }), 12000));
    const userInfo = recordOrEmpty(payload.user_info);
    const auth = String(userInfo.auth ?? "");
    if (auth !== "1" && auth.toLowerCase() !== "true") {
      throw new HttpError(401, "Xtream credentials were refused");
    }

    return {
      serverUrl,
      username,
      status: stringOr(userInfo.status, "active"),
      expiresAt: stringOrNull(userInfo.exp_date),
    };
  }

  if (sourceType === "m3u") {
    const playlistUrl = stringOr(config.playlistUrl, "");
    if (!playlistUrl) throw new HttpError(400, "M3U requires a playlist URL");
    assertHttpUrl(playlistUrl);
    const text = await fetchText(playlistUrl, 12000, 1_000_000);
    if (!text.includes("#EXTM3U")) throw new HttpError(400, "This URL does not look like a valid M3U playlist");
    return { playlistUrl, estimatedItems: Math.max(0, text.split("#EXTINF").length - 1) };
  }

  return {};
}

function buildSourceHint(sourceType: string, config: JsonRecord, validation: JsonRecord) {
  if (sourceType === "xtream") {
    const serverUrl = stringOr(validation.serverUrl ?? config.serverUrl, "");
    return {
      serverHost: safeHost(serverUrl),
      username: stringOr(validation.username ?? config.username, ""),
      status: stringOrNull(validation.status),
      hasPassword: Boolean(config.password),
    };
  }

  if (sourceType === "m3u") {
    const playlistUrl = stringOr(validation.playlistUrl ?? config.playlistUrl, "");
    return {
      playlistHost: safeHost(playlistUrl),
      estimatedItems: validation.estimatedItems,
    };
  }

  return {};
}

async function syncCloudSource(sourceId: string, userId: string, db: SupabaseClient) {
  try {
    const { data: source, error } = await db
      .from("cloud_sources")
      .select("*")
      .eq("id", sourceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to load source");
    if (!source) throw new HttpError(404, "Source not found");
    if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");

    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    const startedAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({ sync_status: "syncing", sync_error: null, last_synced_at: startedAt })
      .eq("id", sourceId)
      .eq("user_id", userId);

    const result = source.source_type === "xtream"
      ? await syncXtreamSource(sourceId, userId, config, db)
      : source.source_type === "m3u"
        ? await syncM3uSource(sourceId, userId, config, db)
        : { total: 0 };

    if ((source.source_type === "xtream" || source.source_type === "m3u") && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: new Date().toISOString(),
        config_hint: compactRecord({
          ...recordOrEmpty(source.config_hint),
          lastSync: { ...result, syncedAt: new Date().toISOString() },
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source sync failed";
    console.error("[norva-cloud] source sync failed", sourceId, message);
    await db
      .from("cloud_sources")
      .update({ sync_status: "error", sync_error: message, last_synced_at: new Date().toISOString() })
      .eq("id", sourceId)
      .eq("user_id", userId);
  }
}

async function syncXtreamSource(sourceId: string, userId: string, config: JsonRecord, db: SupabaseClient) {
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
  const [live, vod, series, liveCategories, vodCategories, seriesCategories] = await Promise.all([
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series_categories" }), 25000).catch(() => []),
  ]);
  const liveCategoryMap = categoryMap(liveCategories);
  const vodCategoryMap = categoryMap(vodCategories);
  const seriesCategoryMap = categoryMap(seriesCategories);

  const rows = [
    ...xtreamRows(sourceId, userId, Array.isArray(live) ? live : [], "live", liveCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(vod) ? vod : [], "movie", vodCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(series) ? series : [], "series", seriesCategoryMap),
  ];

  const savedRows = await replaceSourceItems(sourceId, userId, rows, db);
  const liveCatalog = await refreshMaterializedLiveCatalog(db, { sourceId, userId, rows: savedRows });
  const titleProjection = await refreshVodTitleProjection({
    sourceId,
    userId,
    rows: savedRows,
    db,
    xtreamConfig: { serverUrl, username, password },
    vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_SYNC_LIMIT"), 120, 0, 1000),
  });
  return {
    live: Array.isArray(live) ? live.length : 0,
    movies: Array.isArray(vod) ? vod.length : 0,
    series: Array.isArray(series) ? series.length : 0,
    liveCategories: liveCategoryMap.size,
    movieCategories: vodCategoryMap.size,
    seriesCategories: seriesCategoryMap.size,
    total: rows.length,
    liveCatalog,
    titleProjection,
  };
}

function categoryMap(items: unknown) {
  const categories = new Map<string, string>();
  if (!Array.isArray(items)) return categories;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = stringOr(item.category_id ?? item.categoryId ?? item.id, "");
    const name = stringOr(item.category_name ?? item.categoryName ?? item.name, "");
    if (id && name) categories.set(id, name);
  }
  return categories;
}

function xtreamRows(
  sourceId: string,
  userId: string,
  items: JsonRecord[],
  itemType: "live" | "movie" | "series",
  categories: Map<string, string>,
) {
  const rows: JsonRecord[] = [];
  for (const item of items) {
    const streamId = stringOr(item.stream_id ?? item.series_id ?? item.id, "");
    const title = stringOr(item.name ?? item.title, "");
    if (!streamId || !title) continue;
    const container = stringOr(item.container_extension, itemType === "live" ? "m3u8" : "mp4");
    const categoryId = stringOrNull(item.category_id);
    const categoryName = categoryId
      ? categories.get(categoryId) ?? stringOrNull(item.category_name)
      : stringOrNull(item.category_name);
    rows.push({
      user_id: userId,
      source_id: sourceId,
      item_type: itemType,
      external_id: streamId,
      parent_external_id: categoryId,
      title,
      subtitle: categoryName,
      poster_url: stringOrNull(item.stream_icon ?? item.cover),
      backdrop_url: null,
      metadata: compactRecord({
        categoryId,
        categoryName,
        rating: item.rating,
        added: item.added,
        providerTmdbId: stringOrNull(item.tmdb_id ?? item.tmdbId ?? item.tmdb),
        providerImdbId: stringOrNull(item.imdb_id ?? item.imdbId ?? item.imdb),
      }),
      playback_hint: compactRecord({
        sourceType: "xtream",
        streamId,
        streamType: itemType,
        container,
        providerTmdbId: stringOrNull(item.tmdb_id ?? item.tmdbId ?? item.tmdb),
        providerImdbId: stringOrNull(item.imdb_id ?? item.imdbId ?? item.imdb),
      }),
      available: true,
    });
  }
  return rows;
}

async function syncM3uSource(sourceId: string, userId: string, config: JsonRecord, db: SupabaseClient) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  const playlist = await fetchText(playlistUrl, 30000, 20_000_000);
  const items = parseM3u(playlist).slice(0, 20000);
  const rows = await Promise.all(items.map(async (item) => ({
    user_id: userId,
    source_id: sourceId,
    item_type: "live",
    external_id: item.tvgId || await sha256Hex(item.url),
    parent_external_id: item.group || null,
    title: item.title,
    subtitle: item.group || null,
    poster_url: item.logo || null,
    backdrop_url: null,
    metadata: compactRecord({ tvgId: item.tvgId, group: item.group }),
    playback_hint: compactRecord({ sourceType: "m3u", targetUrl: item.url }),
    available: true,
  })));

  const savedRows = await replaceSourceItems(sourceId, userId, rows, db);
  const liveCatalog = await refreshMaterializedLiveCatalog(db, { sourceId, userId, rows: savedRows });
  return { live: rows.length, total: rows.length, liveCatalog };
}

async function replaceSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient): Promise<LiveCatalogItem[]> {
  const savedRows: LiveCatalogItem[] = [];
  await db.from("cloud_media_items").delete().eq("source_id", sourceId).eq("user_id", userId);
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,item_type,external_id" })
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available");
    if (error) throwDb(error, "Unable to save cloud media items");
    if (Array.isArray(data)) savedRows.push(...data as LiveCatalogItem[]);
  }
  return savedRows;
}

async function listMediaItems(url: URL, userId: string, db: SupabaseClient) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");
  const search = url.searchParams.get("q");
  const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 1000);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 100000);

  let query = db
    .from("cloud_media_items")
    .select("*")
    .eq("user_id", userId)
    .range(offset, offset + limit - 1)
    .order("title", { ascending: true });

  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list media items");
  return { items: data ?? [] };
}

async function getXtreamSeriesInfo(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(sourceId, userId, db);
  const seriesId = url.searchParams.get("series_id") ?? url.searchParams.get("seriesId") ?? "";
  if (!seriesId) throw new HttpError(400, "series_id is required");

  const sourceConfig = await loadSourceConfig(sourceId, userId, db);
  const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
  const username = stringOr(sourceConfig.username, "");
  const password = stringOr(sourceConfig.password, "");
  if (!serverUrl || !username || !password) {
    throw new HttpError(400, "Series details require an Xtream source");
  }

  const info = recordOrEmpty(await fetchJson(
    xtreamApiUrl({ serverUrl, username, password, action: "get_series_info" }, { series_id: seriesId }),
    20000,
  ));

  return info;
}

async function getXtreamShortEpg(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(sourceId, userId, db);
  const streamId = url.searchParams.get("stream_id") ?? url.searchParams.get("streamId") ?? "";
  const limit = String(boundedInt(url.searchParams.get("limit"), 8, 1, 24));
  if (!streamId) throw new HttpError(400, "stream_id is required");

  const sourceConfig = await loadSourceConfig(sourceId, userId, db);
  const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
  const username = stringOr(sourceConfig.username, "");
  const password = stringOr(sourceConfig.password, "");
  if (!serverUrl || !username || !password) {
    throw new HttpError(400, "Short EPG requires an Xtream source");
  }

  const runtimeConfig = await getRuntimeConfig(db);
  const gatewayRequest = { serverUrl, username, password, streamId, limit };
  const shortEpg = runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken
    ? await requestGatewayXtreamEpg(runtimeConfig, { ...gatewayRequest, action: "get_short_epg" }).catch(async (error) => {
      if (error instanceof HttpError && (error.status === 404 || error.status === 405 || error.status === 503)) {
        return recordOrEmpty(await fetchJson(
          xtreamApiUrl({ serverUrl, username, password, action: "get_short_epg" }, { stream_id: streamId, limit }),
          12000,
        ));
      }
      throw error;
    })
    : recordOrEmpty(await fetchJson(
      xtreamApiUrl({ serverUrl, username, password, action: "get_short_epg" }, { stream_id: streamId, limit }),
      12000,
    ));
  if (epgPayloadHasCurrentOrFuture(shortEpg)) return shortEpg;

  const simpleTable = runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken
    ? await requestGatewayXtreamEpg(runtimeConfig, { ...gatewayRequest, action: "get_simple_data_table" }).catch(() => shortEpg)
    : recordOrEmpty(await fetchJson(
      xtreamApiUrl({ serverUrl, username, password, action: "get_simple_data_table" }, { stream_id: streamId }),
      15000,
    ).catch(() => shortEpg));
  return epgPayloadHasListings(simpleTable) ? simpleTable : shortEpg;
}

function epgPayloadHasListings(payload: JsonRecord) {
  return Array.isArray(payload.epg_listings) && payload.epg_listings.length > 0;
}

function epgPayloadHasCurrentOrFuture(payload: JsonRecord) {
  if (!Array.isArray(payload.epg_listings)) return false;
  const now = Math.floor(Date.now() / 1000);
  return payload.epg_listings.some((listing) => {
    if (!isRecord(listing)) return false;
    const stop = Number.parseInt(String(listing.stop_timestamp ?? listing.end_timestamp ?? ""), 10);
    return Number.isFinite(stop) && stop > now - 300;
  });
}

async function getSourceEpg(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  const beforeHours = boundedInt(url.searchParams.get("beforeHours") ?? url.searchParams.get("windowBeforeHours"), 2, 0, 24);
  const afterHours = boundedInt(url.searchParams.get("afterHours") ?? url.searchParams.get("windowAfterHours"), 8, 1, 48);
  const refresh = url.searchParams.get("refresh") === "1";
  const now = Date.now();
  const windowStartMs = now - beforeHours * 60 * 60 * 1000;
  const windowEndMs = now + afterHours * 60 * 60 * 1000;
  const bucketStart = Math.floor(windowStartMs / EPG_WINDOW_BUCKET_MS) * EPG_WINDOW_BUCKET_MS;
  const bucketEnd = Math.ceil(windowEndMs / EPG_WINDOW_BUCKET_MS) * EPG_WINDOW_BUCKET_MS;
  const cacheKey = `${userId}:${sourceId}:${bucketStart}:${bucketEnd}`;
  const cached = epgCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > now) return cached.data;

  const { data: source, error } = await db
    .from("cloud_sources")
    .select("source_type, config_ciphertext")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");
  if (!source.config_ciphertext) throw new HttpError(400, "EPG requires a managed cloud source");

  const sourceType = stringOr(source.source_type, "");
  const sourceConfig = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
  let epgUrl = "";
  if (sourceType === "xtream") {
    const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
    const username = stringOr(sourceConfig.username, "");
    const password = stringOr(sourceConfig.password, "");
    if (!serverUrl || !username || !password) {
      throw new HttpError(400, "Xtream EPG requires server URL, username and password");
    }
    epgUrl = xtreamXmltvUrl({ serverUrl, username, password });
  } else if (sourceType === "epg") {
    epgUrl = stringOr(sourceConfig.epgUrl, "");
    assertHttpUrl(epgUrl);
  } else {
    return { channels: [], programmes: [], sourceId, generatedAt: new Date().toISOString(), cloud: true };
  }

  const xml = await fetchText(epgUrl, 45000, EPG_MAX_XML_BYTES, providerHeaders("VLC/3.0.20 LibVLC/3.0.20"));
  const data = {
    ...parseXmltvWindow(xml, { windowStartMs, windowEndMs, maxProgrammes: EPG_MAX_PROGRAMMES }),
    sourceId,
    generatedAt: new Date().toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    cloud: true,
  };
  epgCache.set(cacheKey, { expiresAt: Date.now() + EPG_CACHE_TTL_MS, data });
  return data;
}

function parseXmltvWindow(xml: string, options: { windowStartMs: number; windowEndMs: number; maxProgrammes: number }) {
  const channels: JsonRecord[] = [];
  const channelIds = new Set<string>();
  const channelPattern = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let channelMatch: RegExpExecArray | null;

  while ((channelMatch = channelPattern.exec(xml)) !== null) {
    const id = xmlAttr(channelMatch[1], "id");
    if (!id || channelIds.has(id)) continue;
    const body = channelMatch[2] ?? "";
    const iconTag = body.match(/<icon\b([^>]*)\/?>/i);
    channels.push({
      id,
      name: xmlChildText(body, "display-name") || id,
      icon: iconTag ? xmlAttr(iconTag[1], "src") : null,
      url: xmlChildText(body, "url") || null,
    });
    channelIds.add(id);
  }

  const programmes: JsonRecord[] = [];
  const programmePattern = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let programmeMatch: RegExpExecArray | null;

  while ((programmeMatch = programmePattern.exec(xml)) !== null) {
    const attrs = programmeMatch[1] ?? "";
    const channelId = xmlAttr(attrs, "channel");
    const startMs = parseXmltvDateMs(xmlAttr(attrs, "start"));
    const stopMs = parseXmltvDateMs(xmlAttr(attrs, "stop"));
    if (!channelId || !Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) continue;
    if (stopMs <= options.windowStartMs || startMs >= options.windowEndMs) continue;

    const body = programmeMatch[2] ?? "";
    programmes.push({
      channelId,
      start: new Date(startMs).toISOString(),
      stop: new Date(stopMs).toISOString(),
      title: xmlChildText(body, "title") || "Programme",
      subtitle: xmlChildText(body, "sub-title") || null,
      description: xmlChildText(body, "desc") || "",
      category: xmlChildrenText(body, "category"),
      icon: xmlIcon(body),
    });

    if (programmes.length >= options.maxProgrammes) break;
  }

  if (!channels.length && programmes.length) {
    for (const channelId of new Set(programmes.map((program) => String(program.channelId)))) {
      channels.push({ id: channelId, name: channelId, icon: null, url: null });
    }
  }

  return { channels, programmes };
}

function xmlIcon(body: string) {
  const iconTag = body.match(/<icon\b([^>]*)\/?>/i);
  return iconTag ? xmlAttr(iconTag[1], "src") : null;
}

function xmlAttr(attrs: string, name: string) {
  const pattern = new RegExp(`${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = attrs.match(pattern);
  return decodeXmlText(match?.[1] ?? match?.[2] ?? "");
}

function xmlChildText(body: string, tagName: string) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = body.match(pattern);
  return decodeXmlText(match?.[1] ?? "");
}

function xmlChildrenText(body: string, tagName: string) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const value = decodeXmlText(match[1] ?? "");
    if (value) values.push(value);
  }
  return values;
}

function parseXmltvDateMs(value: string) {
  if (!value) return NaN;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!match) return Date.parse(value);
  const [, year, month, day, hour, minute, second, tz] = match;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "Z";
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
}

function decodeXmlText(value: string) {
  if (!value) return "";
  const stripped = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
  return stripped
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function recordPlaybackEvent(
  req: Request,
  userId: string,
  db: SupabaseClient,
  defaultDeviceId: string | null = null,
) {
  const body = await readJson(req);
  const eventType = stringOr(body.eventType ?? body.event_type, "");
  if (!PLAYBACK_EVENT_TYPES.has(eventType)) throw new HttpError(400, "Unsupported playback event type");

  const playbackSessionId = stringOrNull(body.playbackSessionId ?? body.playback_session_id ?? body.sessionId);
  let sourceId = stringOrNull(body.sourceId ?? body.source_id);
  let deviceId = stringOrNull(body.deviceId ?? body.device_id) ?? defaultDeviceId;
  let itemType = stringOr(body.itemType ?? body.item_type ?? body.type, "");
  let itemId = stringOr(body.itemId ?? body.item_id ?? body.id, "");
  let playbackMode = stringOrNull(body.playbackMode ?? body.playback_mode ?? body.mode);

  if (playbackSessionId) {
    const { data: session, error } = await db
      .from("cloud_playback_sessions")
      .select("id,source_id,device_id,item_type,item_id,mode")
      .eq("id", playbackSessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to verify playback session");
    if (!session) throw new HttpError(404, "Playback session not found");
    sourceId = sourceId ?? stringOrNull(session.source_id);
    deviceId = deviceId ?? stringOrNull(session.device_id);
    itemType = itemType || stringOr(session.item_type, "");
    itemId = itemId || stringOr(session.item_id, "");
    playbackMode = playbackMode ?? stringOrNull(session.mode);
  }

  if (!itemType || !itemId) throw new HttpError(400, "itemType and itemId are required");
  if (sourceId) await assertOwnedSource(sourceId, userId, db);
  if (deviceId) await assertOwnedDevice(deviceId, userId, db);

  const ttff = boundedNullableInt(
    body.timeToFirstFrameMs ?? body.time_to_first_frame_ms ?? body.ttffMs ?? body.ttff_ms,
    0,
    10 * 60 * 1000,
  );
  const row = {
    user_id: userId,
    device_id: deviceId,
    playback_session_id: playbackSessionId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    event_type: eventType,
    position_seconds: boundedInt(body.positionSeconds ?? body.position_seconds ?? body.position, 0, 0, 10_000_000),
    duration_seconds: boundedInt(body.durationSeconds ?? body.duration_seconds ?? body.duration, 0, 0, 10_000_000),
    time_to_first_frame_ms: ttff,
    playback_mode: playbackMode,
    error_code: stringOrNull(body.errorCode ?? body.error_code),
    error_message: stringOrNull(body.errorMessage ?? body.error_message),
    metadata: compactRecord(recordOrEmpty(body.metadata)),
  };

  const { data, error } = await db
    .from("cloud_playback_events")
    .insert(row)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to record playback event");

  if (sourceId && ttff && (eventType === "first_frame" || eventType === "play_started")) {
    await recordPlaybackStartupObservation(db, { userId, sourceId, itemType, itemId, startupMs: ttff });
  }

  return { event: data };
}

async function startPairing(req: Request, db: SupabaseClient) {
  const body = await readJson(req);
  const ttlSeconds = boundedInt(body.ttlSeconds ?? body.ttl_seconds, 300, 60, 900);
  const code = await uniquePairingCode(db);
  const pairingSecret = generateDeviceToken();
  const row = {
    code,
    device_type: stringOr(body.deviceType ?? body.device_type, "unknown"),
    device_name: stringOrNull(body.deviceName ?? body.device_name),
    device_public_key: stringOrNull(body.devicePublicKey ?? body.device_public_key),
    pairing_secret_hash: await sha256Hex(pairingSecret),
    platform: stringOrNull(body.platform),
    app_version: stringOrNull(body.appVersion ?? body.app_version),
    device_capabilities: recordOrEmpty(body.capabilities),
    status: "pending",
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };

  const { data, error } = await db.from("cloud_pairing_sessions").insert(row).select("*").single();
  if (error) throwDb(error, "Unable to start pairing");
  return {
    id: data.id,
    code: data.code,
    pairingSecret,
    status: data.status,
    expiresAt: data.expires_at,
  };
}

async function pollPairing(req: Request, code: string, db: SupabaseClient) {
  const url = new URL(req.url);
  const suppliedSecret =
    url.searchParams.get("secret") ??
    req.headers.get("X-Norva-Pairing-Secret") ??
    "";
  const { data, error } = await db
    .from("cloud_pairing_sessions")
    .select("id, code, status, approved_device_id, pairing_secret_hash, expires_at, approved_at")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error) throwDb(error, "Unable to poll pairing");
  if (!data) return { status: "not_found" };
  if (new Date(data.expires_at).getTime() < Date.now() && data.status === "pending") {
    await db.from("cloud_pairing_sessions").update({ status: "expired" }).eq("id", data.id);
    return { status: "expired" };
  }
  const secretMatches = suppliedSecret
    ? data.pairing_secret_hash === await sha256Hex(suppliedSecret)
    : false;
  return {
    id: data.id,
    code: data.code,
    status: data.status,
    approvedDeviceId: data.approved_device_id,
    deviceToken: data.status === "approved" && secretMatches ? suppliedSecret : undefined,
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
      platform: pair.platform,
      app_version: pair.app_version,
      public_key: pair.device_public_key,
      capabilities: recordOrEmpty(pair.device_capabilities),
      trusted: true,
      last_seen_at: new Date().toISOString(),
      device_token_hash: pair.pairing_secret_hash,
      device_token_issued_at: new Date().toISOString(),
    })
    .select(DEVICE_PUBLIC_SELECT)
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

async function heartbeatDeviceToken(device: CloudDevice, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", device.id)
    .eq("user_id", device.user_id)
    .eq("revoked", false)
    .select(DEVICE_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to update device heartbeat");
  return { device: data };
}

async function listDeviceCommands(url: URL, device: CloudDevice, db: SupabaseClient) {
  const limit = boundedInt(url.searchParams.get("limit"), 25, 1, 100);
  const now = new Date().toISOString();
  await db
    .from("cloud_cast_commands")
    .update({ status: "expired" })
    .eq("target_device_id", device.id)
    .eq("user_id", device.user_id)
    .eq("status", "queued")
    .not("expires_at", "is", null)
    .lt("expires_at", now);

  const { data, error } = await db
    .from("cloud_cast_commands")
    .select("*")
    .eq("target_device_id", device.id)
    .eq("user_id", device.user_id)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throwDb(error, "Unable to list device commands");

  const ids = (data ?? []).map((command) => command.id).filter(Boolean);
  if (ids.length) {
    await db
      .from("cloud_cast_commands")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .in("id", ids)
      .eq("target_device_id", device.id)
      .eq("user_id", device.user_id);
  }
  return { commands: data ?? [] };
}

async function updateDeviceCommand(req: Request, id: string, device: CloudDevice, db: SupabaseClient) {
  const body = await readJson(req);
  const status = stringOr(body.status, "");
  if (!["acknowledged", "failed"].includes(status)) {
    throw new HttpError(400, "Device commands can only be acknowledged or failed");
  }

  const patch: JsonRecord = { status };
  if (status === "acknowledged") patch.acknowledged_at = new Date().toISOString();
  if (status === "failed" && typeof body.error === "string") patch.payload = { error: body.error };

  const { data, error } = await db
    .from("cloud_cast_commands")
    .update(patch)
    .eq("id", id)
    .eq("target_device_id", device.id)
    .eq("user_id", device.user_id)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to update device command");
  return { command: data };
}

async function createPlaybackSession(req: Request, userId: string, db: SupabaseClient, defaultDeviceId: string | null = null) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const deviceId = stringOrNull(body.deviceId ?? body.device_id) ?? defaultDeviceId;
  const itemType = stringOr(body.itemType ?? body.item_type, "");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  let targetUrl = stringOr(body.targetUrl ?? body.target_url ?? body.url, "");
  const requestedMode = stringOr(body.mode, "auto");
  if (!targetUrl && sourceId && itemType && itemId) {
    targetUrl = await resolvePlaybackTarget(sourceId, itemType, itemId, userId, db);
  }
  if (!itemType || !itemId || !targetUrl) {
    throw new HttpError(400, "itemType, itemId and targetUrl are required");
  }
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
      status: mode === "transcode" ? "pending" : "ready",
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
  if (sourceId && gateway.startupMs) {
    await recordPlaybackStartupObservation(db, {
      userId,
      sourceId,
      itemType,
      itemId,
      startupMs: gateway.startupMs,
    });
  }
  return {
    session,
    playback: {
      mode,
      status: gateway.status,
      url: gateway.hlsUrl,
      gatewaySession: gateway.session,
      gatewayRequired: !gateway.hlsUrl,
      startupMs: gateway.startupMs ?? null,
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
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) {
    throw new HttpError(503, "Norva Relay is not configured");
  }

  const payload = JSON.stringify({
    v: 1,
    sid: playbackSessionId,
    uid: userId,
    url: targetUrl,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  });
  const signature = await hmacBase64Url(runtimeConfig.relayTokenSecret, payload);
  const token = `${base64Url(encoder.encode(payload))}.${signature}`;
  const tokenHash = await sha256Hex(token);

  const { error } = await db.from("cloud_relay_tokens").insert({
    user_id: userId,
    playback_session_id: playbackSessionId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (error) throwDb(error, "Unable to record relay token");

  return { url: `${runtimeConfig.relayBaseUrl}/relay/${token}` };
}

async function createGatewaySession(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  db: SupabaseClient,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
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
    return { status: "pending", session: data, hlsUrl: null, startupMs: null };
  }

  const startupStartedAt = performance.now();
  const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
    },
    body: JSON.stringify({
      playbackSessionId,
      ownerKey: await sha256Hex(userId),
      sourceUrl: targetUrl,
      expiresAt,
    }),
  });
  const gatewayBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
  }
  const startupMs = Math.max(1, Math.round(performance.now() - startupStartedAt));

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
  return { status: data.status, session: data, hlsUrl: data.hls_url, startupMs };
}

async function recordPlaybackStartupObservation(
  db: SupabaseClient,
  options: { userId: string; sourceId: string; itemType: string; itemId: string; startupMs: number },
) {
  const itemType = options.itemType === "series" ? "series" : options.itemType === "movie" ? "movie" : "";
  if (!itemType || !options.itemId || !Number.isFinite(options.startupMs) || options.startupMs <= 0) return;

  const cost = Math.max(1, Math.min(999, Math.round(options.startupMs / 10)));
  const { error } = await db
    .from("cloud_title_variants")
    .update({
      last_observed_ttff_ms: Math.round(options.startupMs),
      playback_cost_score: cost,
    })
    .eq("user_id", options.userId)
    .eq("source_id", options.sourceId)
    .eq("item_type", itemType)
    .eq("external_id", options.itemId);
  if (error && !isProjectionMissing(error)) {
    console.warn("[norva-cloud] unable to record playback startup observation", error.message);
  }
}

function isProjectionMissing(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: string; message?: string };
  return record.code === "42P01" || String(record.message || "").includes("cloud_title");
}

async function requestGatewayXtreamEpg(
  runtimeConfig: RuntimeConfig,
  body: {
    serverUrl: string;
    username: string;
    password: string;
    streamId: string;
    limit?: string;
    action: "get_short_epg" | "get_simple_data_table";
  },
) {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Norva Media Gateway is not configured");
  }

  const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/xtream/epg`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
    },
    body: JSON.stringify({
      ...body,
      userAgent: "VLC/3.0.20 LibVLC/3.0.20",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response || !response.ok) {
    throw new HttpError(response.status, "Media gateway refused the EPG request", payload);
  }
  return recordOrEmpty(payload);
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) {
    return runtimeConfigCache.value;
  }

  const fromDb = new Map<string, string>();
  const needsDb =
    !ENV_RELAY_BASE_URL ||
    !ENV_RELAY_TOKEN_SECRET ||
    !ENV_MEDIA_GATEWAY_URL ||
    !ENV_MEDIA_GATEWAY_TOKEN ||
    !ENV_SOURCE_CONFIG_KEY;

  if (needsDb) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", RUNTIME_CONFIG_KEYS);

    if (error) {
      console.warn("[norva-cloud] runtime config unavailable", error.message);
    } else {
      for (const item of data ?? []) {
        if (typeof item.key === "string" && typeof item.value === "string") {
          fromDb.set(item.key, item.value);
        }
      }
    }
  }

  const value = {
    relayBaseUrl: trimTrailingSlash(ENV_RELAY_BASE_URL || fromDb.get("NORVA_RELAY_BASE_URL") || ""),
    relayTokenSecret: ENV_RELAY_TOKEN_SECRET || fromDb.get("RELAY_TOKEN_SECRET") || "",
    mediaGatewayUrl: trimTrailingSlash(ENV_MEDIA_GATEWAY_URL || fromDb.get("NORVA_MEDIA_GATEWAY_URL") || ""),
    mediaGatewayToken: ENV_MEDIA_GATEWAY_TOKEN || fromDb.get("NORVA_MEDIA_GATEWAY_TOKEN") || "",
    sourceConfigKey: ENV_SOURCE_CONFIG_KEY || fromDb.get("NORVA_SOURCE_CONFIG_KEY") || "",
  };

  runtimeConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function resolvePlaybackTarget(
  sourceId: string,
  itemType: string,
  itemId: string,
  userId: string,
  db: SupabaseClient,
) {
  const { data: item, error } = await db
    .from("cloud_media_items")
    .select("playback_hint")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .eq("external_id", itemId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to resolve playback item");
  if (!item) {
    if (itemType === "series") {
      const sourceConfig = await loadSourceConfig(sourceId, userId, db);
      return xtreamStreamUrl({
        serverUrl: stringOr(sourceConfig.serverUrl, ""),
        username: stringOr(sourceConfig.username, ""),
        password: stringOr(sourceConfig.password, ""),
        streamType: "series",
        streamId: itemId,
        container: "mp4",
      });
    }
    throw new HttpError(404, "Media item not found");
  }

  const hint = recordOrEmpty(item.playback_hint);
  if (typeof hint.targetUrl === "string") return hint.targetUrl;

  if (hint.sourceType === "xtream") {
    const sourceConfig = await loadSourceConfig(sourceId, userId, db);
    return xtreamStreamUrl({
      serverUrl: stringOr(sourceConfig.serverUrl, ""),
      username: stringOr(sourceConfig.username, ""),
      password: stringOr(sourceConfig.password, ""),
      streamType: stringOr(hint.streamType, "live"),
      streamId: stringOr(hint.streamId, ""),
      container: stringOr(hint.container, "m3u8"),
    });
  }

  throw new HttpError(400, "This media item has no playback target");
}

async function loadSourceConfig(sourceId: string, userId: string, db: SupabaseClient) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("config_ciphertext")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source config");
  if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
  return decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
}

async function encryptSourceConfig(config: JsonRecord, runtimeConfig: RuntimeConfig) {
  if (!runtimeConfig.sourceConfigKey) {
    throw new HttpError(503, "Norva Cloud source encryption is not configured");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(runtimeConfig.sourceConfigKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(config)),
  );
  return `aesgcm.v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptSourceConfig(ciphertext: string, runtimeConfig: RuntimeConfig): Promise<JsonRecord> {
  if (!runtimeConfig.sourceConfigKey) {
    throw new HttpError(503, "Norva Cloud source encryption is not configured");
  }
  const [scheme, version, ivPart, dataPart] = ciphertext.split(".");
  if (scheme !== "aesgcm" || version !== "v1" || !ivPart || !dataPart) {
    throw new HttpError(500, "Unsupported source config format");
  }
  const key = await aesKey(runtimeConfig.sourceConfigKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
    key,
    base64UrlToBytes(dataPart),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isRecord(parsed)) throw new HttpError(500, "Invalid source config payload");
  return parsed;
}

async function aesKey(secret: string) {
  let material = base64UrlToBytes(secret);
  if (material.byteLength !== 32) {
    material = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function fetchJson(url: string, timeoutMs: number) {
  const response = await fetchWithTimeout(url, timeoutMs);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed", payload);
  return payload;
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number, headers = providerHeaders()) {
  const response = await fetchWithTimeout(url, timeoutMs, headers);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Provider payload is too large for this cloud request");
  }
  const text = await response.text();
  if (text.length > maxBytes) throw new HttpError(413, "Provider payload is too large for this cloud request");
  return text;
}

async function proxyImage(req: Request, url: URL) {
  const targetUrl = assertPublicImageUrl(url.searchParams.get("url") ?? "");
  const response = await fetchImageWithFallback(targetUrl, 12000).catch(() => null);
  if (!response.ok) {
    return imageFallback(req);
  }

  const contentType = imageContentType(response.headers.get("content-type"), targetUrl);
  if (!contentType) {
    await response.body?.cancel().catch(() => undefined);
    return imageFallback(req);
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": contentType,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Timing-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}

function imageFallback(req: Request) {
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(req),
      "Location": "https://norva-eight.vercel.app/img/norva-media-placeholder.png",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Timing-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Norva-Image-Fallback": "1",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

function imageContentType(value: string | null, url: string) {
  const type = (value || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  if (type === "application/octet-stream" || !type) {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  }
  return "";
}

async function fetchImageWithFallback(url: string, timeoutMs: number) {
  try {
    return await fetchImageWithTimeout(url, timeoutMs);
  } catch (error) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") throw error;
    parsed.protocol = "https:";
    return await fetchImageWithTimeout(parsed.href, timeoutMs);
  }
}

async function fetchImageWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; NorvaCloudImageProxy/1.0)",
      },
    });
  } catch (error) {
    throw new HttpError(502, "Unable to reach image host", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

function providerHeaders(userAgent = "NorvaCloud/1.0") {
  return {
    "Accept": "application/json,text/xml,application/xml,text/plain,*/*",
    "User-Agent": userAgent,
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers = providerHeaders()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers,
    });
  } catch (error) {
    throw new HttpError(502, "Unable to reach IPTV provider", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

function parseM3u(playlist: string) {
  const lines = playlist.split(/\r?\n/);
  const items: Array<{ title: string; url: string; tvgId: string; logo: string; group: string }> = [];
  let pending: { title: string; tvgId: string; logo: string; group: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      pending = {
        title: line.includes(",") ? line.slice(line.indexOf(",") + 1).trim() : "Norva channel",
        tvgId: attr(line, "tvg-id") || attr(line, "tvg-name"),
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title"),
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pending && /^https?:\/\//i.test(line)) {
      items.push({ ...pending, url: line });
      pending = null;
    }
  }

  return items;
}

function attr(value: string, name: string) {
  const match = value.match(new RegExp(`${name}=\"([^\"]*)\"`, "i"));
  return match?.[1]?.trim() ?? "";
}

function xtreamApiUrl(config: {
  serverUrl: string;
  username: string;
  password: string;
  action?: string;
}, extraParams: Record<string, string> = {}) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (config.action) url.searchParams.set("action", config.action);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.href;
}

function xtreamXmltvUrl(config: { serverUrl: string; username: string; password: string }) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/xmltv.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  return url.href;
}

function xtreamStreamUrl(config: {
  serverUrl: string;
  username: string;
  password: string;
  streamType: string;
  streamId: string;
  container: string;
}) {
  const folder = config.streamType === "movie" ? "movie" : config.streamType === "series" ? "series" : "live";
  return `${normalizeBaseUrl(config.serverUrl)}/${folder}/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(config.streamId)}.${config.container}`;
}

function normalizeBaseUrl(value: string) {
  const trimmed = trimTrailingSlash(value.trim());
  assertHttpUrl(trimmed);
  return trimmed;
}

function safeHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function compactRecord(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function waitUntil(promise: Promise<unknown>) {
  const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else promise.catch((error) => console.error("[norva-cloud] background task failed", error));
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

function generateDeviceToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `nv_dev_${base64Url(bytes)}`;
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

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function assertPublicImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password) {
      throw new Error("credentials are not allowed");
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.includes(":") ||
      isPrivateIpv4(hostname)
    ) {
      throw new Error("private hosts are not allowed");
    }
    return url.href;
  } catch {
    throw new HttpError(400, "url must be a public http(s) image URL");
  }
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boundedNullableInt(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

function stringOr(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function stringOrNull(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
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
