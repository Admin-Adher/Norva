import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildLiveMaterializationPlan,
  clearLiveMaterialization,
  fetchLiveChannelIdMap,
  refreshMaterializedLiveCatalog,
  upsertLiveChannelRows,
  upsertLiveVariantRows,
} from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection } from "../_shared/vod-title-projection.ts";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { featuresForDecision, getBillingMode, getEntitlementDecision, getEntitlementRuntime, hasConsumedTrial, limitNumber, realPlanCode, recordEntitlementSignal } from "../_shared/entitlements.ts";

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
  "https://norva.tv",
  "https://app.norva.tv",
  "https://norva-web.pages.dev",
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
  "seek",
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

// Whether the signed-in account may still start a free trial. Trial eligibility
// is account-level (keyed to trial_consumed_at), so it follows the user across
// Play / web / TV and prevents stacking trials across stores.
async function getTrialEligibility(userId: string, db: SupabaseClient) {
  const consumed = await hasConsumedTrial(db, userId);
  return {
    eligible: !consumed,
    trialConsumed: consumed,
    billingMode: getBillingMode(),
  };
}

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
        version: 21,
        entitlements: true,
        entitlementsMode: entitlementRuntime.mode,
        entitlementsEnforced: entitlementRuntime.enforced,
        billingMode: getBillingMode(),
        liveMaterialization: true,
        relayConfigured: Boolean(runtimeConfig.relayBaseUrl && runtimeConfig.relayTokenSecret),
        gatewayConfigured: Boolean(runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken),
        cloudSourceConfigured: Boolean(runtimeConfig.sourceConfigKey),
        time: new Date().toISOString(),
      },
    };
  }

  // Service-authed continuation for the resumable Xtream sync. driveXtreamSyncToReady
  // self-invokes this between isolates to import an "8K"-scale catalogue across
  // several short background runs. Authorized by the service key, or the Vault cron
  // secret via a service_role-only SECURITY DEFINER check (never exposed here).
  if (scope === "cron" && req.method === "POST") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let authorized = SUPABASE_SERVICE_KEY !== "" && token === SUPABASE_SERVICE_KEY;
    if (!authorized && token) {
      const { data: ok } = await db.rpc("norva_verify_cron_secret", { presented: token });
      authorized = ok === true;
    }
    if (!authorized) throw new HttpError(403, "forbidden");
    if (id === "sync-step" && action) {
      const { data: src } = await db
        .from("cloud_sources").select("user_id, source_type").eq("id", action).maybeSingle();
      if (!src) throw new HttpError(404, "Source not found");
      if (String(src.source_type) === "xtream") {
        waitUntil(driveXtreamSyncToReady(action, String(src.user_id), db));
      }
      return { body: { ok: true, started: true, sourceId: action } };
    }
    throw new HttpError(404, "Route not found");
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
      const decision = await getEntitlementDecision(db, device.user_id);
      return { body: { ...decision, features: featuresForDecision(decision) } };
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
    const decision = await getEntitlementDecision(db, user.id);
    return { body: { ...decision, features: featuresForDecision(decision) } };
  }

  // Conversion-signal log (observe-mode scaffold): the client posts when a user
  // reaches for a premium-gated feature. Never gates anything — just records
  // demand against the user's real plan. { feature, context? }.
  if (scope === "entitlements" && req.method === "POST" && id === "signal") {
    const body = await req.json().catch(() => ({})) as JsonRecord;
    const feature = typeof body.feature === "string" ? body.feature : "";
    if (feature) {
      const decision = await getEntitlementDecision(db, user.id, { autoStartTrial: false });
      const context = body.context && typeof body.context === "object" && !Array.isArray(body.context)
        ? body.context as JsonRecord
        : {};
      await recordEntitlementSignal(db, user.id, feature, realPlanCode(decision), context);
    }
    return { body: { ok: true } };
  }

  // "What's new" feed (free in-app notification). GET unseen events; POST
  // /content-events/seen marks them read.
  if (scope === "content-events") {
    if (req.method === "GET") {
      const { data } = await db
        .from("cloud_content_events")
        .select("id,source_id,kind,summary,payload,created_at")
        .eq("user_id", user.id)
        .is("seen_at", null)
        .order("created_at", { ascending: false })
        .limit(20);
      return { body: { events: data ?? [] } };
    }
    if (req.method === "POST" && id === "seen") {
      const body = await req.json().catch(() => ({})) as JsonRecord;
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x) => typeof x === "string").slice(0, 100)
        : null;
      let q = db.from("cloud_content_events")
        .update({ seen_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .is("seen_at", null);
      if (ids && ids.length) q = q.in("id", ids);
      await q;
      return { body: { ok: true } };
    }
  }

  if (scope === "billing" && id === "trial-eligibility" && req.method === "GET") {
    return { body: await getTrialEligibility(user.id, db) };
  }

  if (scope === "profiles") {
    if (req.method === "GET" && !id) return { body: await listProfiles(user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await createProfile(req, user.id, db) };
    if ((req.method === "PATCH" || req.method === "PUT") && id) return { body: await updateProfile(req, id, user.id, db) };
    if (req.method === "DELETE" && id) return { body: await deleteProfile(id, user.id, db) };
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
    if (req.method === "POST" && id && action === "finalize") {
      await requireCloudAccess(user.id, db, "source_sync");
      const body = await readJson(req);
      return {
        body: await finalizeCloudSource(id, user.id, db, {
          country: stringOrNull(body.country ?? url.searchParams.get("country")),
          phase: stringOr(body.phase ?? url.searchParams.get("phase"), "live"),
          offset: boundedInt(body.offset ?? url.searchParams.get("offset"), 0, 0, 1_000_000),
          limit: boundedInt(body.limit ?? url.searchParams.get("limit"), 1000, 1, 2000),
        }),
      };
    }
    if ((req.method === "PATCH" || req.method === "PUT") && id) {
      return { body: await updateSource(req, id, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await deleteSource(id, user.id, db) };
  }

  if (scope === "media-items") {
    if (req.method === "GET") return { body: await listMediaItems(url, user.id, db) };
    if (req.method === "POST") return { status: 201, body: await upsertMediaItems(req, user.id, db) };
  }

  if (scope === "favorites") {
    if (req.method === "GET" && !id) return { body: await listFavorites(req, url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await addFavorite(req, user.id, db) };
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_favorites", id, user.id, db) };
  }

  if (scope === "history") {
    if (req.method === "GET" && !id) {
      // Targeted lookup (?itemId&itemType[&sourceId]) → single item's progress,
      // used for authoritative cross-device resume; otherwise list recent history.
      if (url.searchParams.get("itemId") || url.searchParams.get("item_id")) {
        return { body: await getHistoryItem(req, url, user.id, db) };
      }
      return { body: await listHistory(req, url, user.id, db) };
    }
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

// --- Account profiles (Netflix-style "who's watching") --------------------

const PROFILE_HEADER = "x-norva-profile-id";
const PROFILE_SELECT =
  "id, name, avatar_id, is_kids, is_default, sort_order, preferred_audio_language, preferred_subtitle_language, preferred_genres, hidden_genres, setup_completed, created_at";

// Every account always has at least one profile. Provisions a default (named
// from the account display name) the first time it's needed.
async function getOrCreateDefaultProfileId(userId: string, db: SupabaseClient): Promise<string> {
  const { data: existing } = await db
    .from("cloud_account_profiles")
    .select("id")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: account } = await db.from("cloud_profiles").select("display_name").eq("id", userId).maybeSingle();
  const name = stringOrNull(account?.display_name) || "Profile 1";
  const { data, error } = await db
    .from("cloud_account_profiles")
    .insert({ user_id: userId, name, avatar_id: "avatar-01", is_default: true, sort_order: 0 })
    .select("id")
    .single();
  if (error) throwDb(error, "Unable to create default profile");
  return data.id as string;
}

// Resolve the active profile from the request header, validating it belongs to
// the account. Falls back to (and provisions) the default profile.
async function resolveProfileId(req: Request, userId: string, db: SupabaseClient): Promise<string> {
  const headerId = stringOrNull(req.headers.get(PROFILE_HEADER));
  if (headerId) {
    const { data } = await db
      .from("cloud_account_profiles")
      .select("id")
      .eq("id", headerId)
      .eq("user_id", userId)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }
  return await getOrCreateDefaultProfileId(userId, db);
}

async function listProfiles(userId: string, db: SupabaseClient) {
  await getOrCreateDefaultProfileId(userId, db); // ensure at least one exists
  const { data, error } = await db
    .from("cloud_account_profiles")
    .select(PROFILE_SELECT)
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throwDb(error, "Unable to list profiles");
  const decision = await getEntitlementDecision(db, userId, { autoStartTrial: false });
  const limit = limitNumber(decision.limits, "profiles", 1);
  const profiles = data ?? [];
  return { profiles, limit, canCreate: profiles.length < limit };
}

async function createProfile(req: Request, userId: string, db: SupabaseClient) {
  // Enforces the plan's `profiles` limit (5 in enforce, manual in observe).
  await requirePlanCapacity(userId, db, "profiles", "cloud_account_profiles");
  const body = await readJson(req);
  const name = normalizeProfileName(body.name ?? body.profileName);
  if (!name) throw new HttpError(400, "A profile name is required");

  const { data: last } = await db
    .from("cloud_account_profiles")
    .select("sort_order")
    .eq("user_id", userId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (Number(last?.sort_order) || 0) + 1;

  const { data, error } = await db
    .from("cloud_account_profiles")
    .insert({
      user_id: userId,
      name,
      avatar_id: normalizeAvatarId(body.avatarId ?? body.avatar_id),
      is_kids: Boolean(body.isKids ?? body.is_kids ?? false),
      is_default: false,
      sort_order: sortOrder,
      preferred_audio_language: stringOrNull(body.preferredAudioLanguage ?? body.preferred_audio_language),
      preferred_subtitle_language: stringOrNull(body.preferredSubtitleLanguage ?? body.preferred_subtitle_language),
      preferred_genres: normalizeGenres(body.preferredGenres ?? body.preferred_genres),
      hidden_genres: normalizeGenres(body.hiddenGenres ?? body.hidden_genres),
      setup_completed: true,
    })
    .select(PROFILE_SELECT)
    .single();
  if (error) throwDb(error, "Unable to create profile");
  return { profile: data };
}

async function updateProfile(req: Request, profileId: string, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const patch: JsonRecord = {};
  if (body.name !== undefined || body.profileName !== undefined) {
    const name = normalizeProfileName(body.name ?? body.profileName);
    if (!name) throw new HttpError(400, "A profile name is required");
    patch.name = name;
  }
  if (body.avatarId !== undefined || body.avatar_id !== undefined) {
    patch.avatar_id = normalizeAvatarId(body.avatarId ?? body.avatar_id);
  }
  if (body.isKids !== undefined || body.is_kids !== undefined) {
    patch.is_kids = Boolean(body.isKids ?? body.is_kids);
  }
  if (body.preferredAudioLanguage !== undefined || body.preferred_audio_language !== undefined) {
    patch.preferred_audio_language = stringOrNull(body.preferredAudioLanguage ?? body.preferred_audio_language);
  }
  if (body.preferredSubtitleLanguage !== undefined || body.preferred_subtitle_language !== undefined) {
    patch.preferred_subtitle_language = stringOrNull(body.preferredSubtitleLanguage ?? body.preferred_subtitle_language);
  }
  if (body.preferredGenres !== undefined || body.preferred_genres !== undefined) {
    patch.preferred_genres = normalizeGenres(body.preferredGenres ?? body.preferred_genres);
  }
  if (body.hiddenGenres !== undefined || body.hidden_genres !== undefined) {
    patch.hidden_genres = normalizeGenres(body.hiddenGenres ?? body.hidden_genres);
  }
  if (body.setupCompleted !== undefined || body.setup_completed !== undefined) {
    patch.setup_completed = Boolean(body.setupCompleted ?? body.setup_completed);
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "No profile fields to update");

  const { data, error } = await db
    .from("cloud_account_profiles")
    .update(patch)
    .eq("id", profileId)
    .eq("user_id", userId)
    .select(PROFILE_SELECT)
    .maybeSingle();
  if (error) throwDb(error, "Unable to update profile");
  if (!data) throw new HttpError(404, "Profile not found");
  return { profile: data };
}

async function deleteProfile(profileId: string, userId: string, db: SupabaseClient) {
  const { data: profiles, error: listErr } = await db
    .from("cloud_account_profiles")
    .select("id, is_default")
    .eq("user_id", userId);
  if (listErr) throwDb(listErr, "Unable to load profiles");
  const all = (profiles ?? []) as Array<{ id: string; is_default: boolean }>;
  const target = all.find((p) => p.id === profileId);
  if (!target) throw new HttpError(404, "Profile not found");
  if (all.length <= 1) throw new HttpError(400, "You must keep at least one profile");

  const { error } = await db.from("cloud_account_profiles").delete().eq("id", profileId).eq("user_id", userId);
  if (error) throwDb(error, "Unable to delete profile");

  // Removing the default promotes another profile to default.
  if (target.is_default) {
    const next = all.find((p) => p.id !== profileId);
    if (next) {
      await db.from("cloud_account_profiles").update({ is_default: true }).eq("id", next.id).eq("user_id", userId);
    }
  }
  return { ok: true, deleted: profileId };
}

function normalizeProfileName(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.slice(0, 40);
}

function normalizeAvatarId(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return /^avatar-\d{1,2}$/.test(s) ? s : "avatar-01";
}

function normalizeGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((g) => String(g)).filter(Boolean).slice(0, 20);
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
  const runtimeConfig = await getRuntimeConfig(db);
  const validation = hasManagedConfig ? await validateCloudSource(sourceType, rawConfig, runtimeConfig) : {};
  const configCiphertext = hasManagedConfig
    ? await encryptSourceConfig(rawConfig, runtimeConfig)
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
    const runtimeConfig = await getRuntimeConfig(db);
    const validation = await validateCloudSource(sourceType, rawConfig, runtimeConfig);
    patch.source_type = sourceType;
    patch.config_ciphertext = await encryptSourceConfig(rawConfig, runtimeConfig);
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

// Validate Xtream credentials via the media gateway (the IP the provider tolerates)
// so adding/updating a source never trips the provider's user_multi_ip block from
// this edge runtime's datacenter IP. Falls back to a direct edge fetch only when the
// gateway itself can't serve the request — unconfigured, unreachable, or an older
// build that rejects the `account_info` action (400). A provider verdict (401 bad
// creds, 429 multi_ip) is surfaced as-is, never silently retried direct.
async function validateXtreamAccount(
  runtimeConfig: RuntimeConfig,
  creds: { serverUrl: string; username: string; password: string },
): Promise<JsonRecord> {
  const { serverUrl, username, password } = creds;
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return recordOrEmpty(
        await requestGatewayMetadata(runtimeConfig, { serverUrl, username, password, action: "account_info" }, 20000),
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![400, 404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-cloud] gateway account-info unavailable, falling back to direct", status);
    }
  }
  return recordOrEmpty(await fetchJson(xtreamApiUrl({ serverUrl, username, password }), 12000));
}

async function validateCloudSource(sourceType: string, config: JsonRecord, runtimeConfig: RuntimeConfig) {
  if (sourceType === "xtream") {
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = stringOr(config.username, "");
    const password = stringOr(config.password, "");
    if (!serverUrl || !username || !password) {
      throw new HttpError(400, "Xtream requires server URL, username and password");
    }

    const payload = await validateXtreamAccount(runtimeConfig, { serverUrl, username, password });
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

type SyncProgressReporter = (progress: JsonRecord) => Promise<void>;

function syncProgressSteps(status: "pending" | "running" | "done" | "error" | "skipped" = "pending") {
  return {
    connect: { status },
    channels: { status },
    movies: { status },
    series: { status },
    categories: { status },
    import: { status },
    finalize: { status },
  };
}

function mergeSyncProgress(current: JsonRecord, patch: JsonRecord) {
  const merged = compactRecord({
    ...current,
    ...patch,
    steps: {
      ...recordOrEmpty(current.steps),
      ...recordOrEmpty(patch.steps),
    },
    counts: {
      ...recordOrEmpty(current.counts),
      ...recordOrEmpty(patch.counts),
    },
    categories: {
      ...recordOrEmpty(current.categories),
      ...recordOrEmpty(patch.categories),
    },
  });
  if ("percent" in current || "percent" in patch) {
    merged.percent = Math.max(
      boundedProgressPercent(current.percent),
      boundedProgressPercent(patch.percent),
    );
  }
  return merged;
}

function boundedProgressPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function catalogCountsFromSyncResult(result: JsonRecord) {
  const live = Number(result.live ?? result.channels ?? 0) || 0;
  const movies = Number(result.movies ?? result.vod ?? 0) || 0;
  const series = Number(result.series ?? 0) || 0;
  const liveCategories = Number(result.liveCategories ?? 0) || 0;
  const movieCategories = Number(result.movieCategories ?? 0) || 0;
  const seriesCategories = Number(result.seriesCategories ?? 0) || 0;
  return {
    live,
    movies,
    series,
    total: Number(result.total ?? (live + movies + series)) || 0,
    categories: {
      live: liveCategories,
      movies: movieCategories,
      series: seriesCategories,
      total: liveCategories + movieCategories + seriesCategories,
    },
  };
}

function completedSyncProgress(result: JsonRecord, startedAt: string, syncedAt: string) {
  const counts = catalogCountsFromSyncResult(result);
  return compactRecord({
    status: "ready",
    stage: "ready",
    percent: 100,
    startedAt,
    updatedAt: syncedAt,
    counts: {
      live: counts.live,
      movies: counts.movies,
      series: counts.series,
      total: counts.total,
    },
    categories: counts.categories,
    steps: {
      connect: { status: "done" },
      channels: { status: "done", count: counts.live },
      movies: { status: "done", count: counts.movies },
      series: { status: "done", count: counts.series },
      categories: { status: "done", count: counts.categories.total },
      import: { status: "done", count: counts.total },
      finalize: { status: "done" },
    },
  });
}

async function writeSourceSyncProgress(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  baseHint: JsonRecord,
  progress: JsonRecord,
) {
  const { error } = await db
    .from("cloud_sources")
    .update({
      config_hint: compactRecord({
        ...baseHint,
        syncProgress: progress,
      }),
    })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) console.warn("[norva-cloud] Unable to update source sync progress", error.message);
}

async function syncCloudSource(sourceId: string, userId: string, db: SupabaseClient) {
  let baseHint: JsonRecord = {};
  let progress: JsonRecord = {};

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

    const startedAt = new Date().toISOString();
    baseHint = recordOrEmpty(source.config_hint);
    progress = compactRecord({
      status: "syncing",
      stage: "connecting",
      percent: 4,
      startedAt,
      updatedAt: startedAt,
      counts: { live: 0, movies: 0, series: 0, total: 0 },
      categories: { live: 0, movies: 0, series: 0, total: 0 },
      steps: {
        ...syncProgressSteps("pending"),
        connect: { status: "running" },
      },
    });

    if (source.source_type === "xtream") {
      // Big "8K" catalogues (100k+ items, 1000+ categories) can't be discovered,
      // imported and materialized inside one edge isolate's wall-clock budget.
      // Reset the resumable cursor for a fresh run, then hand to the driver which
      // walks categories incrementally and self-continues across isolates until
      // the raw catalogue is imported; the existing finalize stepper (driven by
      // the client poll / cron) then materializes it to "ready".
      const cursor = freshSyncCursor(startedAt);
      await db
        .from("cloud_sources")
        .update({
          sync_status: "syncing",
          sync_error: null,
          last_synced_at: startedAt,
          config_hint: compactRecord({ ...baseHint, syncProgress: progress, syncCursor: cursor }),
        })
        .eq("id", sourceId)
        .eq("user_id", userId);
      await driveXtreamSyncToReady(sourceId, userId, db);
      return;
    }

    // m3u / other source types stay on the single-isolate path (bounded size).
    await db
      .from("cloud_sources")
      .update({
        sync_status: "syncing",
        sync_error: null,
        last_synced_at: startedAt,
        config_hint: compactRecord({ ...baseHint, syncProgress: progress }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);

    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
      progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
      await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
    };

    const result = source.source_type === "m3u"
      ? await syncM3uSource(sourceId, userId, config, db, reportProgress)
      : { total: 0 };

    if (source.source_type === "m3u" && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    const syncedAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: syncedAt,
        config_hint: compactRecord({
          ...baseHint,
          lastSync: { ...result, syncedAt },
          syncProgress: completedSyncProgress(result, startedAt, syncedAt),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source sync failed";
    console.error("[norva-cloud] source sync failed", sourceId, message);
    const failedAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: mergeSyncProgress(progress, {
            status: "error",
            stage: "error",
            percent: Number(progress.percent ?? 0) || 0,
            updatedAt: failedAt,
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  }
}

// ── Resumable Xtream discovery ───────────────────────────────────────────────
// State lives in cloud_sources.config_hint.syncCursor and survives across edge
// isolates so an "8K"-scale catalogue can be imported over several short runs.
const DISCOVER_TYPES: { type: "live" | "movie" | "series"; action: string }[] = [
  { type: "live", action: "get_live_streams" },
  { type: "movie", action: "get_vod_streams" },
  { type: "series", action: "get_series" },
];
const DISCOVER_CONCURRENCY = 14;
// Work budget per isolate. Kept well under the runtime's background wall-clock so
// the self-invoke (which spawns the next isolate) always lands before recycle.
const SYNC_DRIVE_BUDGET_MS = 90_000;
const SYNC_MAX_CONTINUATIONS = 160;

function freshSyncCursor(startedAt: string): JsonRecord {
  return {
    v: 1,
    active: true,
    phase: "discover",
    deleted: false,
    typeIdx: 0,
    catIdx: 0,
    counts: { live: 0, movies: 0, series: 0 },
    startedAt,
    attempts: 0,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// A provider commonly lists the same stream in several categories; a single
// upsert command can't touch the same (source_id, item_type, external_id) twice
// ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so collapse
// duplicates within a batch (keeping the last) before upserting.
function dedupeByConflictKey(rows: JsonRecord[]): JsonRecord[] {
  const map = new Map<string, JsonRecord>();
  for (const row of rows) {
    map.set(`${stringOr(row.item_type, "")}:${stringOr(row.external_id, "")}`, row);
  }
  return [...map.values()];
}

// Incremental import: upsert a batch of rows (no delete, no select-back). The
// initial delete-all happens once per fresh sync; finalize reloads rows from the
// table, so we don't need the saved rows here — keeping peak memory tiny.
async function appendSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient) {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const { error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,item_type,external_id" });
    if (error) throwDb(error, "Unable to save cloud media items");
  }
}

// Fire the next isolate. The /cron/sync-step route kicks driveXtreamSyncToReady
// in the background and returns immediately, so this await resolves fast and the
// current (near-budget) isolate can exit cleanly.
async function selfInvokeSyncStep(sourceId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("[norva-cloud] cannot self-invoke sync-step: missing URL/service key", sourceId);
    return;
  }
  const url = `${SUPABASE_URL}/functions/v1/norva-cloud/cron/sync-step/${encodeURIComponent(sourceId)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[norva-cloud] self-invoke sync-step failed", sourceId, error);
  }
}

// Drive one isolate's worth of resumable discovery. Imports every category's
// stream slice incrementally from a persisted cursor; when the wall-clock budget
// is hit before the catalogue is fully imported it checkpoints and self-invokes
// a fresh isolate. On completion it leaves the source in the finalize-pending
// handoff state ({import: done, finalize: running}) the client/cron stepper
// already knows how to materialize to "ready".
async function driveXtreamSyncToReady(sourceId: string, userId: string, db: SupabaseClient) {
  const deadline = Date.now() + SYNC_DRIVE_BUDGET_MS;
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.error("[norva-cloud] sync driver load failed", sourceId, error.message); return; }
  if (!source) return;
  if (String(source.sync_status) === "ready") return; // a stale continuation raced past completion

  const baseHint = recordOrEmpty(source.config_hint);
  let cursor = recordOrEmpty(baseHint.syncCursor);
  if (!isRecord(baseHint.syncCursor)) cursor = freshSyncCursor(new Date().toISOString());
  let progress = recordOrEmpty(baseHint.syncProgress);

  // Single config_hint writer during discovery — re-reads the row each time so a
  // concurrent finalize progress write is never clobbered.
  const persist = async (progressPatch: JsonRecord | null) => {
    if (progressPatch) {
      progress = mergeSyncProgress(progress, compactRecord({ ...progressPatch, status: "syncing", updatedAt: new Date().toISOString() }));
    }
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    await db
      .from("cloud_sources")
      .update({
        config_hint: compactRecord({
          ...freshHint,
          syncProgress: progressPatch ? progress : freshHint.syncProgress,
          syncCursor: cursor,
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  };

  try {
    cursor.attempts = (Number(cursor.attempts) || 0) + 1;
    if (Number(cursor.attempts) > SYNC_MAX_CONTINUATIONS) {
      throw new HttpError(500, "Catalog sync exceeded its continuation budget");
    }
    // A continuation is making progress — clear any error left by a prior isolate.
    if (String(source.sync_status) !== "syncing") {
      await db.from("cloud_sources").update({ sync_status: "syncing", sync_error: null }).eq("id", sourceId).eq("user_id", userId);
    }

    const runtimeConfig = await getRuntimeConfig(db);
    const config = await decryptSourceConfig(String(source.config_ciphertext), runtimeConfig);
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = stringOr(config.username, "");
    const password = stringOr(config.password, "");
    if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
    const fetchCatalog = (action: string, params?: Record<string, string>) =>
      fetchProviderMetadata(runtimeConfig, { serverUrl, username, password, action, params, timeoutMs: 25000 }).catch(() => []);

    // Re-fetch the (tiny) category lists each isolate for fresh id→name maps.
    const [liveCats, vodCats, seriesCats] = await Promise.all([
      fetchCatalog("get_live_categories"),
      fetchCatalog("get_vod_categories"),
      fetchCatalog("get_series_categories"),
    ]);
    const nameMaps: Record<string, Map<string, string>> = {
      live: categoryMap(liveCats),
      movie: categoryMap(vodCats),
      series: categoryMap(seriesCats),
    };

    // Establish the stable, sorted category-id worklist once (persisted), so the
    // cursor index stays meaningful even if the provider reorders categories.
    if (!isRecord(cursor.cats)) {
      cursor.cats = {
        live: [...nameMaps.live.keys()].sort(),
        movie: [...nameMaps.movie.keys()].sort(),
        series: [...nameMaps.series.keys()].sort(),
      };
      cursor.catCounts = { live: nameMaps.live.size, movies: nameMaps.movie.size, series: nameMaps.series.size };
    }
    const cats = recordOrEmpty(cursor.cats);

    if (!cursor.deleted) {
      await db.from("cloud_media_items").delete().eq("source_id", sourceId).eq("user_id", userId);
      cursor.deleted = true;
      await persist({
        stage: "discovering",
        percent: 18,
        steps: {
          connect: { status: "done" },
          channels: { status: "running" },
          movies: { status: "running" },
          series: { status: "running" },
          categories: { status: "running" },
        },
      });
    }

    const counts = recordOrEmpty(cursor.counts);
    let liveCount = Number(counts.live) || 0;
    let movieCount = Number(counts.movies) || 0;
    let seriesCount = Number(counts.series) || 0;
    let typeIdx = Number(cursor.typeIdx) || 0;
    let catIdx = Number(cursor.catIdx) || 0;

    const targetsFor = (type: string): (Record<string, string> | undefined)[] => {
      const ids = asStringArray(cats[type]);
      return ids.length ? ids.map((id) => ({ category_id: id })) : [undefined];
    };
    const totalTargets = DISCOVER_TYPES.reduce((sum, d) => sum + targetsFor(d.type).length, 0);
    const completedTargets = () => {
      let done = catIdx;
      for (let i = 0; i < typeIdx; i++) done += targetsFor(DISCOVER_TYPES[i].type).length;
      return done;
    };

    let sincePersist = 0;
    while (Date.now() < deadline && typeIdx < DISCOVER_TYPES.length) {
      const def = DISCOVER_TYPES[typeIdx];
      const targets = targetsFor(def.type);
      if (catIdx >= targets.length) { typeIdx++; catIdx = 0; continue; }
      const batch = targets.slice(catIdx, catIdx + DISCOVER_CONCURRENCY);
      const slices = await Promise.all(batch.map((p) => fetchCatalog(def.action, p)));
      const rawRows: JsonRecord[] = [];
      for (const slice of slices) {
        if (!Array.isArray(slice) || !slice.length) continue;
        const r = xtreamRows(sourceId, userId, slice as JsonRecord[], def.type, nameMaps[def.type]);
        for (const row of r) rawRows.push(row);
      }
      // Collapse cross-category duplicates before counting/upserting.
      const batchRows = dedupeByConflictKey(rawRows);
      if (batchRows.length) {
        await appendSourceItems(sourceId, userId, batchRows, db);
        if (def.type === "live") liveCount += batchRows.length;
        else if (def.type === "movie") movieCount += batchRows.length;
        else seriesCount += batchRows.length;
      }
      catIdx += batch.length;
      if (catIdx >= targets.length) { typeIdx++; catIdx = 0; }
      cursor.typeIdx = typeIdx;
      cursor.catIdx = catIdx;
      cursor.counts = { live: liveCount, movies: movieCount, series: seriesCount };
      sincePersist++;
      if (sincePersist >= 4 || Date.now() >= deadline) {
        sincePersist = 0;
        const percent = Math.max(18, Math.min(57, 18 + Math.round((39 * completedTargets()) / Math.max(1, totalTargets))));
        await persist({
          stage: "discovering",
          percent,
          counts: { live: liveCount, movies: movieCount, series: seriesCount, total: liveCount + movieCount + seriesCount },
        });
      }
    }

    if (typeIdx < DISCOVER_TYPES.length) {
      // Budget hit before the catalogue is fully imported → checkpoint + continue.
      await persist(null);
      await selfInvokeSyncStep(sourceId);
      return;
    }

    // Catalogue fully imported → leave the finalize-pending handoff state.
    const total = liveCount + movieCount + seriesCount;
    if (total <= 0) throw new HttpError(422, "No playable catalog items were imported from this source");
    const catCounts = recordOrEmpty(cursor.catCounts);
    const liveCats2 = Number(catCounts.live) || 0;
    const movieCats2 = Number(catCounts.movies) || 0;
    const seriesCats2 = Number(catCounts.series) || 0;
    const catTotal = liveCats2 + movieCats2 + seriesCats2;
    cursor.active = false;
    cursor.phase = "imported";
    await persist({
      stage: "materializing",
      percent: 74,
      counts: { live: liveCount, movies: movieCount, series: seriesCount, total },
      categories: { live: liveCats2, movies: movieCats2, series: seriesCats2, total: catTotal },
      steps: {
        connect: { status: "done" },
        channels: { status: "done", count: liveCount },
        movies: { status: "done", count: movieCount },
        series: { status: "done", count: seriesCount },
        categories: { status: "done", count: catTotal },
        import: { status: "done", count: total },
        finalize: { status: "running" },
      },
    });
    // The client poll and the cron finalize stepper take it from here to "ready".
  } catch (err) {
    const message = err instanceof Error ? err.message : "Source sync failed";
    console.error("[norva-cloud] sync driver failed", sourceId, message);
    const failedAt = new Date().toISOString();
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...freshHint,
          syncProgress: mergeSyncProgress(recordOrEmpty(freshHint.syncProgress), {
            status: "error",
            stage: "error",
            percent: Number(recordOrEmpty(freshHint.syncProgress).percent) || 0,
            updatedAt: failedAt,
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  }
}

type FinalizeCloudSourceOptions = {
  country: string | null;
  phase: string;
  offset: number;
  limit: number;
};

async function finalizeCloudSource(sourceId: string, userId: string, db: SupabaseClient, options: FinalizeCloudSourceOptions) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");

  const baseHint = recordOrEmpty(source.config_hint);
  const existingProgress = recordOrEmpty(baseHint.syncProgress);
  const startedAt = stringOr(existingProgress.startedAt ?? source.last_synced_at, new Date().toISOString());
  const phase = normalizeFinalizePhase(options.phase);
  const batchLimit = Math.max(1, Math.min(2000, options.limit || 1000));
  const batchOffset = Math.max(0, options.offset || 0);
  const counts = await countSourceItems(sourceId, userId, db, existingProgress);
  let progress: JsonRecord = compactRecord({
    ...existingProgress,
    status: "syncing",
    stage: finalizePhaseStage(phase),
    percent: Math.max(74, Number(existingProgress.percent ?? 0) || 0),
    startedAt,
    updatedAt: new Date().toISOString(),
  });
  const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
    progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null })
    .eq("id", sourceId)
    .eq("user_id", userId);

  try {
    if (counts.total <= 0) throw new HttpError(422, "No imported catalog items were found for this source");
    await reportProgress({
      stage: finalizePhaseStage(phase),
      percent: finalizePhasePercent(phase, batchOffset, counts),
      counts: {
        live: counts.live,
        movies: counts.movies,
        series: counts.series,
        total: counts.total,
      },
      categories: counts.categories,
      steps: {
        connect: { status: "done" },
        channels: { status: "done", count: counts.live },
        movies: { status: "done", count: counts.movies },
        series: { status: "done", count: counts.series },
        categories: { status: "done", count: counts.categories.total },
        import: { status: "done", count: counts.total },
        finalize: { status: "running" },
      },
    });

    const config: JsonRecord = source.config_ciphertext
      ? await decryptSourceConfig(String(source.config_ciphertext), await getRuntimeConfig(db)).catch(() => ({} as JsonRecord))
      : {};

    const result = {
      live: counts.live,
      movies: counts.movies,
      series: counts.series,
      liveCategories: counts.categories.live,
      movieCategories: counts.categories.movies,
      seriesCategories: counts.categories.series,
      total: counts.total,
      recoveredFromImportedItems: true,
    };

    if (phase === "live") {
      const existingLiveCatalog = await existingLiveMaterializationCounts(sourceId, userId, db);
      const totalVod = counts.movies + counts.series;
      if (counts.live <= 0) {
        return {
          sourceId,
          status: "syncing",
          phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0,
          limit: batchLimit,
          totalVod,
          ...result,
          liveCatalog: { rawLive: 0, logicalChannels: 0, liveVariants: 0, skipped: true },
        };
      }

      const liveCatalogComplete = existingLiveCatalog.logicalChannels > 0 && existingLiveCatalog.liveVariants > 0;
      if (liveCatalogComplete) {
        await reportProgress({
          stage: "building_titles",
          percent: 86,
          steps: { finalize: { status: "running" } },
        });
        return {
          sourceId,
          status: "syncing",
          phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0,
          limit: batchLimit,
          totalVod,
          ...result,
          liveCatalog: { ...existingLiveCatalog, rawLive: counts.live, reused: true },
        };
      }

      await reportProgress({
        stage: "building_live_channels",
        percent: 76,
        steps: { finalize: { status: "running" } },
      });
      await clearLiveMaterialization(db, sourceId, userId);
      const livePlan = buildLiveMaterializationPlan({
        sourceId,
        userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
        country: options.country || stringOr(config.country, "FR"),
      });
      await reportProgress({
        stage: "building_live_channels",
        percent: 76,
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "live",
        nextPhase: livePlan.channelRows.length > 0 ? "live_channels" : "titles",
        nextOffset: 0,
        limit: batchLimit,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        totalVod,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: livePlan.channelRows.length,
          liveVariants: livePlan.variantRows.length,
          reset: true,
        },
      };
    }

    if (phase === "live_channels") {
      const livePlan = buildLiveMaterializationPlan({
        sourceId,
        userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
        country: options.country || stringOr(config.country, "FR"),
      });
      const insertedChannels = await upsertLiveChannelRows(db, livePlan.channelRows, batchOffset, batchLimit);
      const nextOffset = Math.min(livePlan.channelRows.length, batchOffset + insertedChannels.length);
      const done = insertedChannels.length < batchLimit || nextOffset >= livePlan.channelRows.length;
      await reportProgress({
        stage: done ? "building_live_variants" : "building_live_channels",
        percent: done ? 80 : liveFinalizePercent("live_channels", nextOffset, livePlan.channelRows.length),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "live_channels",
        nextPhase: done ? "live_variants" : "live_channels",
        nextOffset: done ? 0 : nextOffset,
        limit: batchLimit,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        totalVod: counts.movies + counts.series,
        done,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: nextOffset,
          liveVariants: 0,
        },
      };
    }

    if (phase === "live_variants") {
      const livePlan = buildLiveMaterializationPlan({
        sourceId,
        userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
        country: options.country || stringOr(config.country, "FR"),
      });
      const channelIdByLogicalId = await fetchLiveChannelIdMap(db, sourceId, userId);
      const insertedVariants = await upsertLiveVariantRows(db, livePlan.variantRows, channelIdByLogicalId, batchOffset, batchLimit);
      const nextOffset = Math.min(livePlan.variantRows.length, batchOffset + insertedVariants);
      const done = insertedVariants < batchLimit || nextOffset >= livePlan.variantRows.length;
      await reportProgress({
        stage: done ? "building_titles" : "building_live_variants",
        percent: done ? 86 : liveFinalizePercent("live_variants", nextOffset, livePlan.variantRows.length),
        steps: { finalize: { status: "running" } },
      });
      const totalVod = counts.movies + counts.series;
      return {
        sourceId,
        status: "syncing",
        phase: "live_variants",
        nextPhase: totalVod > 0 ? "titles" : "complete",
        nextOffset: done ? 0 : nextOffset,
        limit: batchLimit,
        totalVod,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        done,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: livePlan.channelRows.length,
          liveVariants: nextOffset,
        },
      };
    }

    if (phase === "titles") {
      const totalVod = counts.movies + counts.series;
      const rows = await loadSourceItems(sourceId, userId, db, {
        itemTypes: ["movie", "series"],
        offset: batchOffset,
        limit: batchLimit,
      });
      const sourceType = stringOr(source.source_type, "");
      const rcTitles = await getRuntimeConfig(db);
      const titleProjection = await refreshVodTitleProjection({
        sourceId,
        userId,
        rows,
        db,
        xtreamConfig: sourceType === "xtream" && config.serverUrl && config.username && config.password
          ? {
            serverUrl: normalizeBaseUrl(stringOr(config.serverUrl, "")),
            username: stringOr(config.username, ""),
            password: stringOr(config.password, ""),
          }
          : null,
        mediaGatewayUrl: rcTitles.mediaGatewayUrl,
        mediaGatewayToken: rcTitles.mediaGatewayToken,
        vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_FINALIZE_LIMIT"), 0, 0, 1000),
        // Onboarding B: small inline enrichment → fast release; crons + reuse + bar fill the rest.
        tmdbValidateLimit: boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_FINALIZE_LIMIT"), 15, 0, 1000),
      });
      const nextOffset = Math.min(totalVod, batchOffset + rows.length);
      const done = rows.length < batchLimit || nextOffset >= totalVod;
      await reportProgress({
        stage: done ? "finalizing" : "building_titles",
        percent: done ? 96 : titleFinalizePercent(nextOffset, totalVod),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "titles",
        nextPhase: done ? "complete" : "titles",
        nextOffset,
        limit: batchLimit,
        totalVod,
        done,
        ...result,
        titleProjection,
      };
    }

    if (phase !== "complete") throw new HttpError(400, "Invalid catalog finalization phase");

    const syncedAt = new Date().toISOString();
    const { error: updateError } = await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: syncedAt,
        config_hint: compactRecord({
          ...baseHint,
          lastSync: { ...result, syncedAt },
          syncProgress: completedSyncProgress(result, startedAt, syncedAt),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (updateError) throwDb(updateError, "Unable to update source sync status");

    return { sourceId, status: "ready", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source finalization failed";
    const failedAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: mergeSyncProgress(progress, {
            status: "error",
            stage: "error",
            percent: Number(progress.percent ?? 0) || 0,
            updatedAt: failedAt,
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    throw error;
  }
}

function normalizeFinalizePhase(value: string) {
  const phase = String(value || "").trim().toLowerCase();
  if (
    phase === "live" ||
    phase === "live_channels" ||
    phase === "live_variants" ||
    phase === "titles" ||
    phase === "complete"
  ) return phase;
  return "live";
}

function finalizePhaseStage(phase: string) {
  if (phase === "live_channels") return "building_live_channels";
  if (phase === "live_variants") return "building_live_variants";
  if (phase === "titles") return "building_titles";
  if (phase === "complete") return "finalizing";
  return "materializing";
}

function finalizePhasePercent(phase: string, offset: number, counts: { live: number; movies: number; series: number }) {
  if (phase === "live_channels") return liveFinalizePercent("live_channels", offset, counts.live);
  if (phase === "live_variants") return liveFinalizePercent("live_variants", offset, counts.live);
  if (phase === "titles") return titleFinalizePercent(offset, counts.movies + counts.series);
  if (phase === "complete") return 96;
  return 74;
}

function liveFinalizePercent(phase: string, offset: number, total: number) {
  const ratio = total ? Math.max(0, Math.min(1, offset / total)) : 1;
  if (phase === "live_channels") return Math.max(76, Math.min(80, Math.round(76 + ratio * 4)));
  return Math.max(80, Math.min(86, Math.round(80 + ratio * 6)));
}

function titleFinalizePercent(offset: number, totalVod: number) {
  if (!totalVod) return 96;
  const ratio = Math.max(0, Math.min(1, offset / totalVod));
  return Math.max(86, Math.min(95, Math.round(86 + ratio * 9)));
}

async function countRowsByType(sourceId: string, userId: string, db: SupabaseClient, itemType: string) {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("item_type", itemType);
  if (error) throwDb(error, `Unable to count ${itemType} catalog items`);
  return count ?? 0;
}

async function countRowsInTable(table: string, sourceId: string, userId: string, db: SupabaseClient) {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId);
  if (error) throwDb(error, `Unable to count ${table}`);
  return count ?? 0;
}

async function existingLiveMaterializationCounts(sourceId: string, userId: string, db: SupabaseClient) {
  const [logicalChannels, liveVariants] = await Promise.all([
    countRowsInTable("cloud_live_logical_channels", sourceId, userId, db),
    countRowsInTable("cloud_live_variants", sourceId, userId, db),
  ]);
  return { logicalChannels, liveVariants };
}

async function countSourceItems(sourceId: string, userId: string, db: SupabaseClient, progress: JsonRecord = {}) {
  const [live, movies, series] = await Promise.all([
    countRowsByType(sourceId, userId, db, "live"),
    countRowsByType(sourceId, userId, db, "movie"),
    countRowsByType(sourceId, userId, db, "series"),
  ]);
  const categories = recordOrEmpty(progress.categories);
  return {
    live,
    movies,
    series,
    total: live + movies + series,
    categories: {
      live: Number(categories.live ?? 0) || 0,
      movies: Number(categories.movies ?? 0) || 0,
      series: Number(categories.series ?? 0) || 0,
      total: Number(categories.total ?? 0) || 0,
    },
  };
}

type LoadSourceItemsOptions = {
  itemTypes?: string[];
  offset?: number;
  limit?: number;
};

async function loadSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  options: LoadSourceItemsOptions = {},
): Promise<LiveCatalogItem[]> {
  const rows: LiveCatalogItem[] = [];
  const pageSize = options.limit ? Math.max(1, Math.min(2000, options.limit)) : 1000;
  const startOffset = Math.max(0, options.offset ?? 0);
  const maxRows = options.limit ? pageSize : Number.POSITIVE_INFINITY;
  for (let offset = startOffset; rows.length < maxRows; offset += pageSize) {
    let query = db
      .from("cloud_media_items")
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .order("item_type", { ascending: true })
      .order("external_id", { ascending: true });
    const itemTypes = (options.itemTypes || []).filter(Boolean);
    if (itemTypes.length === 1) query = query.eq("item_type", itemTypes[0]);
    else if (itemTypes.length > 1) query = query.in("item_type", itemTypes);

    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throwDb(error, "Unable to load imported catalog items");
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...(data as LiveCatalogItem[]));
    if (data.length < pageSize) break;
    if (options.limit) break;
  }
  return Number.isFinite(maxRows) ? rows.slice(0, maxRows) : rows;
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
    const rawContainer = stringOr(item.container_extension, "");
    const container = rawContainer || (itemType === "live" ? "ts" : "mp4");
    const containerExplicit = Boolean(rawContainer);
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
        containerExplicit,
        providerTmdbId: stringOrNull(item.tmdb_id ?? item.tmdbId ?? item.tmdb),
        providerImdbId: stringOrNull(item.imdb_id ?? item.imdbId ?? item.imdb),
      }),
      available: true,
    });
  }
  return rows;
}

async function syncM3uSource(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  reportProgress: SyncProgressReporter = async () => {},
) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  await reportProgress({
    stage: "connecting",
    percent: 10,
    steps: { connect: { status: "running" } },
  });
  const playlist = await fetchText(playlistUrl, 30000, 20_000_000);
  await reportProgress({
    stage: "discovered",
    percent: 42,
    steps: {
      connect: { status: "done" },
      channels: { status: "running" },
      movies: { status: "skipped" },
      series: { status: "skipped" },
      categories: { status: "running" },
    },
  });
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

  const categoryCount = new Set(rows.map((row) => stringOr(row.parent_external_id, "")).filter(Boolean)).size;
  await reportProgress({
    stage: "importing",
    percent: 62,
    counts: { live: rows.length, movies: 0, series: 0, total: rows.length },
    categories: { live: categoryCount, movies: 0, series: 0, total: categoryCount },
    steps: {
      channels: { status: "done", count: rows.length },
      categories: { status: "done", count: categoryCount },
      import: { status: "running", count: rows.length },
    },
  });
  const savedRows = await replaceSourceItems(sourceId, userId, rows, db);
  await reportProgress({
    stage: "finalizing",
    percent: 86,
    steps: { import: { status: "done", count: savedRows.length }, finalize: { status: "running" } },
  });
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

  // Route through the media gateway so series-info reaches the provider from the
  // SAME IP as streaming. A direct fetch from this Supabase edge runtime egresses
  // a different (provider-blocked) datacenter IP for the same account → the
  // provider's user_multi_ip anti-sharing block (429). Fall back to a direct
  // fetch only on gateway-side failures (missing route / unreachable / timeout).
  const runtimeConfig = await getRuntimeConfig(db);
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return recordOrEmpty(
        await requestGatewaySeriesInfo(runtimeConfig, { serverUrl, username, password, seriesId }),
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-cloud] gateway series-info unavailable, falling back to direct", status);
    }
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

async function listFavorites(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  let query = db
    .from("cloud_favorites")
    .select("*")
    .eq("user_id", userId)
    .eq("profile_id", profileId)
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
  const profileId = await resolveProfileId(req, userId, db);

  const row = {
    user_id: userId,
    profile_id: profileId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    item_name: stringOrNull(body.itemName ?? body.item_name),
    item_meta: recordOrEmpty(body.itemMeta ?? body.item_meta),
  };

  const { data, error } = await db
    .from("cloud_favorites")
    .upsert(row, { onConflict: "profile_id,source_id,item_type,item_id" })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to save favorite");
  return { favorite: data };
}

async function getHistoryItem(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  const itemId = stringOr(url.searchParams.get("itemId") ?? url.searchParams.get("item_id"), "");
  const itemType = stringOr(
    url.searchParams.get("itemType") ?? url.searchParams.get("item_type") ?? url.searchParams.get("type"),
    "",
  );
  const sourceId = stringOrNull(url.searchParams.get("sourceId") ?? url.searchParams.get("source_id"));
  if (!itemId || !itemType) throw new HttpError(400, "itemId and itemType are required");
  let q = db
    .from("cloud_watch_history")
    .select("source_id,item_type,item_id,progress_seconds,duration_seconds,completed,updated_at")
    .eq("profile_id", profileId)
    .eq("item_type", itemType)
    .eq("item_id", itemId);
  q = sourceId ? q.eq("source_id", sourceId) : q.is("source_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throwDb(error, "Unable to load history item");
  return { item: data ?? null };
}

async function listHistory(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 500);
  const readySourceIds = await listHistorySourceIds(userId, db);
  if (!readySourceIds.length) return { history: [] };

  const { data, error } = await db
    .from("cloud_watch_history")
    .select("*")
    .eq("user_id", userId)
    .eq("profile_id", profileId)
    .in("source_id", readySourceIds)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throwDb(error, "Unable to list history");
  return { history: data ?? [] };
}

async function listHistorySourceIds(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_sources")
    .select("id,sync_status,sync_error,last_synced_at")
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to list history sources");

  return (data ?? [])
    .filter((source: Record<string, unknown>) => {
      if (source.sync_error) return false;
      const status = String(source.sync_status || "").toLowerCase();
      return status === "ready" || status === "completed" || Boolean(source.last_synced_at);
    })
    .map((source: Record<string, unknown>) => String(source.id))
    .filter(Boolean);
}

async function saveHistory(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const itemType = stringOr(body.itemType ?? body.item_type ?? body.type, "");
  const itemId = stringOr(body.itemId ?? body.item_id ?? body.id, "");
  if (!itemType || !itemId) throw new HttpError(400, "itemType and itemId are required");
  if (sourceId) await assertOwnedSource(sourceId, userId, db);
  const profileId = await resolveProfileId(req, userId, db);

  // A progress-only update (e.g. the native player's onProgress, which only
  // knows source/item/position) must NOT wipe the rich metadata an earlier
  // save stored. Load the existing row and merge: incoming fields win, but
  // title/poster/name/duration are preserved when the update omits them —
  // otherwise Continue Watching shows a placeholder ("Norva" + the logo)
  // after a cross-device resume.
  let existingQuery = db
    .from("cloud_watch_history")
    .select("item_name,parent_item_id,duration_seconds,data")
    .eq("profile_id", profileId)
    .eq("item_type", itemType)
    .eq("item_id", itemId);
  existingQuery = sourceId
    ? existingQuery.eq("source_id", sourceId)
    : existingQuery.is("source_id", null);
  const { data: existing } = await existingQuery.maybeSingle();

  const mergedData = { ...recordOrEmpty(existing?.data), ...recordOrEmpty(body.data) };
  const incomingDuration = boundedInt(body.durationSeconds ?? body.duration_seconds ?? body.duration, 0, 0, 10_000_000);

  const row = {
    user_id: userId,
    profile_id: profileId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    parent_item_id: stringOrNull(body.parentItemId ?? body.parent_item_id)
      ?? stringOrNull(existing?.parent_item_id),
    item_name: stringOrNull(body.itemName ?? body.item_name ?? body.name)
      ?? stringOrNull(existing?.item_name),
    progress_seconds: boundedInt(body.progressSeconds ?? body.progress_seconds ?? body.progress, 0, 0, 10_000_000),
    // Keep a known duration if this update doesn't carry one (e.g. native exit
    // before the player resolved the duration).
    duration_seconds: incomingDuration > 0
      ? incomingDuration
      : boundedInt(existing?.duration_seconds, 0, 0, 10_000_000),
    completed: Boolean(body.completed ?? false),
    data: mergedData,
    watched_at: stringOrNull(body.watchedAt ?? body.watched_at) ?? new Date().toISOString(),
  };

  const { data, error } = await db
    .from("cloud_watch_history")
    .upsert(row, { onConflict: "profile_id,source_id,item_type,item_id" })
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
  const requestedPlaybackHint = recordOrEmpty(body.playbackHint ?? body.playback_hint);
  const edgeCoordination = mode === "transcode"
    ? await prepareEdgeSessionCoordinator({
      userId,
      sourceId,
      deviceId,
      itemType,
      itemId,
      targetUrlHash,
      expiresAt,
    }, db)
    : null;
  if (edgeCoordination?.waitMs) await sleep(edgeCoordination.waitMs);

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
      playback_hint: requestedPlaybackHint,
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

  let gateway;
  try {
    gateway = await createGatewaySession(session.id, userId, targetUrl, expiresAt, db, requestedPlaybackHint);
    await commitEdgeSessionCoordinator(edgeCoordination, {
      playbackSessionId: session.id,
      gatewaySessionId: stringOrNull(gateway.session?.external_session_id),
      itemType,
      itemId,
      targetUrlHash,
      expiresAt,
    });
  } catch (error) {
    await abortEdgeSessionCoordinator(edgeCoordination);
    throw error;
  }
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
      codecProfile: gateway.codecProfile ?? null,
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
  const { data: existing, error: loadError } = await db
    .from("cloud_playback_sessions")
    .select("id, source_id, cloud_gateway_sessions(external_session_id)")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (loadError) throwDb(loadError, "Unable to load playback session");

  const { data, error } = await db
    .from("cloud_playback_sessions")
    .update({ status: "expired", expires_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to expire playback session");

  await endEdgeSessionCoordinator({
    userId,
    sourceId: stringOrNull(existing?.source_id),
    playbackSessionId: id,
    gatewaySessionId: gatewaySessionIdFromSession(existing),
  }, db);

  return { session: data };
}

async function prepareEdgeSessionCoordinator(
  options: {
    userId: string;
    sourceId: string | null;
    deviceId: string | null;
    itemType: string;
    itemId: string;
    targetUrlHash: string;
    expiresAt: string;
  },
  db: SupabaseClient,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) return null;

  const ownerKey = await sha256Hex(options.userId);
  const sourceKey = options.sourceId ? await sha256Hex(options.sourceId) : "account";
  const deviceKey = options.deviceId ? await sha256Hex(options.deviceId) : "";
  const body = compactRecord({
    ownerKey,
    sourceKey,
    deviceKey,
    itemType: options.itemType,
    itemId: options.itemId,
    targetHash: options.targetUrlHash,
    expiresAt: options.expiresAt,
  });

  const payload = await requestEdgeCoordinator(runtimeConfig, "/sessions/prepare", body);
  if (!payload?.ok) return null;

  return {
    runtimeConfig,
    ownerKey,
    sourceKey,
    deviceKey,
    lockId: stringOrNull(payload.lockId),
    waitMs: boundedInt(payload.waitMs, 0, 0, 10_000),
  };
}

async function commitEdgeSessionCoordinator(
  coordination: Awaited<ReturnType<typeof prepareEdgeSessionCoordinator>>,
  options: {
    playbackSessionId: string;
    gatewaySessionId: string | null;
    itemType: string;
    itemId: string;
    targetUrlHash: string;
    expiresAt: string;
  },
) {
  if (!coordination?.runtimeConfig || !coordination.lockId) return;
  await requestEdgeCoordinator(coordination.runtimeConfig, "/sessions/start", compactRecord({
    lockId: coordination.lockId,
    ownerKey: coordination.ownerKey,
    sourceKey: coordination.sourceKey,
    deviceKey: coordination.deviceKey,
    playbackSessionId: options.playbackSessionId,
    gatewaySessionId: options.gatewaySessionId,
    itemType: options.itemType,
    itemId: options.itemId,
    targetHash: options.targetUrlHash,
    expiresAt: options.expiresAt,
  }));
}

async function abortEdgeSessionCoordinator(coordination: Awaited<ReturnType<typeof prepareEdgeSessionCoordinator>>) {
  if (!coordination?.runtimeConfig || !coordination.lockId) return;
  await requestEdgeCoordinator(coordination.runtimeConfig, "/sessions/abort", {
    lockId: coordination.lockId,
    ownerKey: coordination.ownerKey,
    sourceKey: coordination.sourceKey,
  });
}

async function endEdgeSessionCoordinator(
  options: {
    userId: string;
    sourceId: string | null;
    playbackSessionId: string;
    gatewaySessionId: string | null;
  },
  db: SupabaseClient,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) return;
  await requestEdgeCoordinator(runtimeConfig, "/sessions/end", compactRecord({
    ownerKey: await sha256Hex(options.userId),
    sourceKey: options.sourceId ? await sha256Hex(options.sourceId) : "account",
    playbackSessionId: options.playbackSessionId,
    gatewaySessionId: options.gatewaySessionId,
  }));
}

async function requestEdgeCoordinator(runtimeConfig: RuntimeConfig, path: string, body: JsonRecord) {
  try {
    const response = await fetch(`${runtimeConfig.relayBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.relayTokenSecret}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn("[norva-cloud] edge coordinator skipped", response.status, payload);
      return null;
    }
    return recordOrEmpty(payload);
  } catch (error) {
    console.warn("[norva-cloud] edge coordinator unavailable", error instanceof Error ? error.message : error);
    return null;
  }
}

function gatewaySessionIdFromSession(session: unknown) {
  const record = recordOrEmpty(session);
  const rows = Array.isArray(record.cloud_gateway_sessions) ? record.cloud_gateway_sessions : [];
  for (const row of rows) {
    const id = stringOrNull(recordOrEmpty(row).external_session_id);
    if (id) return id;
  }
  return null;
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
  playbackHint: JsonRecord = {},
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

  const seekOffset = boundedNullableNumber(
    playbackHint.seekOffset ??
      playbackHint.seek_offset ??
      playbackHint.startOffset ??
      playbackHint.start_offset ??
      playbackHint.resumeTime ??
      playbackHint.resume_time,
    0,
    24 * 60 * 60,
  );
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
      playbackHint: compactRecord(playbackHint),
      seekOffset,
      startOffset: seekOffset,
    }),
  });
  const gatewayBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
  }
  const codecProfile = recordOrEmpty(gatewayBody.codecProfile ?? gatewayBody.codec_profile);
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
  return { status: data.status, session: data, hlsUrl: data.hls_url, startupMs, codecProfile };
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

async function requestGatewaySeriesInfo(
  runtimeConfig: RuntimeConfig,
  body: { serverUrl: string; username: string; password: string; seriesId: string },
) {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Norva Media Gateway is not configured");
  }

  const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/xtream/series-info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
    },
    body: JSON.stringify({ ...body, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response || !response.ok) {
    throw new HttpError(response.status, "Media gateway refused the series-info request", payload);
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

function xtreamPlaybackContainer(hint: JsonRecord, streamTypeValue: unknown) {
  const streamType = stringOr(streamTypeValue, "live");
  const storedContainer = stringOr(hint.container, streamType === "live" ? "ts" : "mp4");
  const explicit = Boolean(hint.containerExplicit || hint.container_explicit);
  if (streamType === "live" && storedContainer.toLowerCase() === "m3u8" && !explicit) return "ts";
  return storedContainer;
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
    const streamType = stringOr(hint.streamType, "live");
    return xtreamStreamUrl({
      serverUrl: stringOr(sourceConfig.serverUrl, ""),
      username: stringOr(sourceConfig.username, ""),
      password: stringOr(sourceConfig.password, ""),
      streamType,
      streamId: stringOr(hint.streamId, ""),
      container: xtreamPlaybackContainer(hint, streamType),
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

// Fetch Xtream catalogue/VOD metadata, preferring the media gateway so the crawl
// reaches the provider from the SAME tolerated IP as streaming instead of this
// Supabase edge runtime's provider-BLOCKED datacenter IP (user_multi_ip + empty
// catalogues). Falls back to a direct fetch only on gateway-side problems.
// deno-lint-ignore no-explicit-any
async function fetchProviderMetadata(
  runtimeConfig: RuntimeConfig,
  args: { serverUrl: string; username: string; password: string; action: string; params?: Record<string, string>; timeoutMs?: number },
): Promise<any> {
  const timeoutMs = args.timeoutMs ?? 25000;
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return await requestGatewayMetadata(runtimeConfig, args, Math.max(timeoutMs + 10000, 45000));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-cloud] gateway metadata unavailable, falling back to direct", args.action, status);
    }
  }
  return fetchJson(
    xtreamApiUrl({ serverUrl: args.serverUrl, username: args.username, password: args.password, action: args.action }, args.params ?? {}),
    timeoutMs,
  );
}

async function requestGatewayMetadata(
  runtimeConfig: RuntimeConfig,
  args: { serverUrl: string; username: string; password: string; action: string; params?: Record<string, string> },
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/xtream/metadata`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
      },
      body: JSON.stringify({
        serverUrl: args.serverUrl,
        username: args.username,
        password: args.password,
        action: args.action,
        params: args.params ?? {},
        userAgent: "VLC/3.0.20 LibVLC/3.0.20",
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, "Media gateway refused the metadata request", payload);
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new HttpError(aborted ? 504 : 502, "Unable to reach media gateway", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
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
  if (!response?.ok) {
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
  // Redirect every dead image to the single validated branded Norva poster on the
  // production domain (norva.tv) — never the stale preview origin, which can still
  // serve an older low-quality placeholder. Keeps the fallback identical to the
  // edge relay so users see the same branded poster regardless of which proxy ran.
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(req),
      "Location": "https://norva.tv/img/norva-media-placeholder.png",
      "X-Norva-Image-Fallback": "1",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
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

async function deleteSource(sourceId: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(sourceId, userId, db);
  const affectedTitleIds = await listSourceTitleIds(sourceId, userId, db);

  await deleteRowsBySource(db, "cloud_live_variants", sourceId, userId);
  await deleteRowsBySource(db, "cloud_live_logical_channels", sourceId, userId);
  await deleteRowsBySource(db, "cloud_title_variants", sourceId, userId);
  await deleteRowsBySource(db, "cloud_title_overrides", sourceId, userId);
  await deleteRowsBySource(db, "cloud_favorites", sourceId, userId);
  await deleteRowsBySource(db, "cloud_media_items", sourceId, userId);
  await deleteRowsBySource(db, "cloud_watch_history", sourceId, userId);
  await clearSourceReference(db, "cloud_playback_sessions", sourceId, userId);
  await clearSourceReference(db, "cloud_playback_events", sourceId, userId);

  const { error } = await db
    .from("cloud_sources")
    .delete()
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to delete provider account");

  if (affectedTitleIds.length) {
    waitUntil(deleteOrphanTitles(affectedTitleIds, userId, db));
  }

  return { success: true, sourceId };
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

async function listSourceTitleIds(sourceId: string, userId: string, db: SupabaseClient) {
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("cloud_title_variants")
      .select("title_id")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .range(from, from + pageSize - 1);
    if (error) {
      if (isMissingRelation(error)) return [];
      throwDb(error, "Unable to inspect provider variants");
    }
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const titleId = stringOrNull((row as JsonRecord).title_id);
      if (titleId) ids.add(titleId);
    }
    if (rows.length < pageSize) break;
  }
  return Array.from(ids);
}

async function deleteRowsBySource(
  db: SupabaseClient,
  table: string,
  sourceId: string,
  userId: string,
) {
  for (;;) {
    const ids = await listRowIdsBySource(db, table, sourceId, userId);
    if (!ids.length) return;

    const { error } = await db
      .from(table)
      .delete()
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .in("id", ids);
    if (error) {
      if (isMissingRelation(error)) return;
      throwDb(error, `Unable to clear ${table}`);
    }
  }
}

async function clearSourceReference(
  db: SupabaseClient,
  table: string,
  sourceId: string,
  userId: string,
) {
  for (;;) {
    const ids = await listRowIdsBySource(db, table, sourceId, userId);
    if (!ids.length) return;

    const { error } = await db
      .from(table)
      .update({ source_id: null })
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .in("id", ids);
    if (error) {
      if (isMissingRelation(error)) return;
      throwDb(error, `Unable to detach ${table}`);
    }
  }
}

async function listRowIdsBySource(
  db: SupabaseClient,
  table: string,
  sourceId: string,
  userId: string,
  batchSize = 500,
) {
  const { data, error } = await db
    .from(table)
    .select("id")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .limit(batchSize);
  if (error) {
    if (isMissingRelation(error)) return [];
    throwDb(error, `Unable to inspect ${table}`);
  }
  return (Array.isArray(data) ? data : [])
    .map((row) => stringOrNull((row as JsonRecord).id))
    .filter((id): id is string => Boolean(id));
}

async function deleteOrphanTitles(titleIds: string[], userId: string, db: SupabaseClient) {
  for (const chunk of chunkArray(Array.from(new Set(titleIds)), 500)) {
    const { data, error } = await db
      .from("cloud_title_variants")
      .select("title_id")
      .eq("user_id", userId)
      .in("title_id", chunk);
    if (error) {
      if (isMissingRelation(error)) return;
      throwDb(error, "Unable to inspect remaining title variants");
    }

    const remaining = new Set(
      (Array.isArray(data) ? data : [])
        .map((row) => stringOrNull((row as JsonRecord).title_id))
        .filter((id): id is string => Boolean(id)),
    );
    const orphanIds = chunk.filter((id) => !remaining.has(id));
    if (!orphanIds.length) continue;

    const { error: deleteError } = await db
      .from("cloud_titles")
      .delete()
      .eq("user_id", userId)
      .in("id", orphanIds);
    if (deleteError) {
      if (isMissingRelation(deleteError)) return;
      throwDb(deleteError, "Unable to clear orphan titles");
    }
  }
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: string; message?: string };
  const message = String(record.message || "");
  return record.code === "42P01" || message.includes("Could not find the table");
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-norva-profile-id",
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

function boundedNullableNumber(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
