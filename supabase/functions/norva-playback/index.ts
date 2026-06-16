import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = {
  relayBaseUrl: string;
  relayTokenSecret: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  sourceConfigKey: string;
};
type CloudIdentity = { userId: string; deviceId?: string };

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
  "http://localhost:4173",
];
const RUNTIME_CONFIG_KEYS = [
  "NORVA_RELAY_BASE_URL",
  "RELAY_TOKEN_SECRET",
  "NORVA_MEDIA_GATEWAY_URL",
  "NORVA_MEDIA_GATEWAY_TOKEN",
  "NORVA_SOURCE_CONFIG_KEY",
];
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      const config = await getRuntimeConfig(supabase);
      return json(req, {
        ok: true,
        service: "norva-playback",
        version: 7,
        relayConfigured: Boolean(config.relayBaseUrl && config.relayTokenSecret),
        gatewayConfigured: Boolean(config.mediaGatewayUrl && config.mediaGatewayToken),
      });
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      (segments[1] === "sessions" || segments[1] === "session")
    ) {
      const identity = await requireIdentity(req, supabase);
      return json(req, await createPlaybackSession(req, identity.userId, supabase, identity.deviceId ?? null), 201);
    }
    if (req.method === "POST" && segments[0] === "playback" && segments[1] === "events") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await recordPlaybackEvent(req, identity.userId, supabase, identity.deviceId ?? null), 201);
    }
    if (req.method === "GET" && segments[0] === "playback" && segments[1] === "sessions" && segments[2]) {
      const identity = await requireIdentity(req, supabase);
      return json(req, await getPlaybackSession(segments[2], identity.userId, supabase));
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "expire"
    ) {
      const identity = await requireIdentity(req, supabase);
      return json(req, await expirePlaybackSession(segments[2], identity.userId, supabase));
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-playback]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function requireIdentity(req: Request, db: SupabaseClient): Promise<CloudIdentity> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await db.auth.getUser(token);
  if (!error && data.user) return { userId: data.user.id };

  const tokenHash = await sha256Hex(token);
  const { data: device, error: deviceError } = await db
    .from("cloud_devices")
    .select("id, user_id")
    .eq("device_token_hash", tokenHash)
    .eq("revoked", false)
    .maybeSingle();
  if (deviceError) throwDb(deviceError, "Unable to verify device token");
  if (!device) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { userId: device.user_id, deviceId: device.id };
}

async function createPlaybackSession(
  req: Request,
  userId: string,
  db: SupabaseClient,
  defaultDeviceId: string | null = null,
) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const deviceId = stringOrNull(body.deviceId ?? body.device_id) ?? defaultDeviceId;
  const itemType = stringOr(body.itemType ?? body.item_type, "");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  let targetUrl = stringOr(body.targetUrl ?? body.target_url ?? body.url, "");
  const requestedMode = stringOr(body.mode, "auto");
  const requestedPlaybackHint = recordOrEmpty(body.playbackHint ?? body.playback_hint);
  const userAgent = stringOrNull(body.userAgent ?? body.user_agent);

  if (!targetUrl && sourceId && itemType && itemId) {
    targetUrl = await resolvePlaybackTarget(sourceId, itemType, itemId, userId, db, requestedPlaybackHint);
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

  await closeOpenGatewaySessionsForUser(userId, db);

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
    return { session, playback: { mode, url: targetUrl, expiresAt } };
  }

  if (mode === "relay") {
    const relay = await createRelayAccess(session.id, userId, targetUrl, expiresAt, db);
    return { session, playback: { mode, url: relay.url, tokenExpiresAt: expiresAt } };
  }

  const gateway = await createGatewaySession(session.id, userId, targetUrl, expiresAt, db, mode, userAgent, requestedPlaybackHint);
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
      audioMode: gateway.audioMode ?? null,
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
  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .select("*, cloud_gateway_sessions(*)")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load playback session");
  if (!session) throw new HttpError(404, "Playback session not found");

  const gatewaySessions = Array.isArray(session.cloud_gateway_sessions)
    ? session.cloud_gateway_sessions
    : [];
  const runtimeConfig = await getRuntimeConfig(db);
  const closedGatewayIds: string[] = [];
  const gatewayErrors: unknown[] = [];

  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    await Promise.allSettled(gatewaySessions.map(async (gateway: JsonRecord) => {
      const externalSessionId = stringOrNull(gateway.external_session_id);
      if (!externalSessionId) return;

      const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/sessions/${encodeURIComponent(externalSessionId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        throw new HttpError(response.status, "Media gateway refused session expiry", body);
      }
      closedGatewayIds.push(String(gateway.id ?? externalSessionId));
    })).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected") gatewayErrors.push(result.reason);
      });
    });
  }

  if (gatewaySessions.length) {
    const gatewayIds = gatewaySessions
      .map((gateway: JsonRecord) => stringOrNull(gateway.id))
      .filter((gatewayId: string | null): gatewayId is string => Boolean(gatewayId));
    if (gatewayIds.length) {
      const { error: gatewayUpdateError } = await db
        .from("cloud_gateway_sessions")
        .update({ status: "expired", expires_at: new Date().toISOString() })
        .in("id", gatewayIds);
      if (gatewayUpdateError) throwDb(gatewayUpdateError, "Unable to expire gateway sessions");
    }
  }

  const { data: expired, error: updateError } = await db
    .from("cloud_playback_sessions")
    .update({ status: "expired", expires_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (updateError) throwDb(updateError, "Unable to expire playback session");

  return {
    session: expired,
    gatewayClosed: closedGatewayIds.length,
    gatewayErrors: gatewayErrors.length,
  };
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
  const { data, error } = await db
    .from("cloud_playback_events")
    .insert({
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
    })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to record playback event");

  if (sourceId && ttff && (eventType === "first_frame" || eventType === "play_started")) {
    await recordPlaybackStartupObservation(db, { userId, sourceId, itemType, itemId, startupMs: ttff });
  }

  return { event: data };
}

async function closeOpenGatewaySessionsForUser(userId: string, db: SupabaseClient) {
  const { data: gatewaySessions, error } = await db
    .from("cloud_gateway_sessions")
    .select("id, playback_session_id, external_session_id, status")
    .eq("user_id", userId)
    .in("status", ["pending", "starting", "ready"]);
  if (error) {
    console.warn("[norva-playback] unable to list open gateway sessions", error.message);
    return;
  }
  if (!gatewaySessions?.length) return;

  const runtimeConfig = await getRuntimeConfig(db);
  const gatewayIds = gatewaySessions
    .map((gateway: JsonRecord) => stringOrNull(gateway.id))
    .filter((gatewayId: string | null): gatewayId is string => Boolean(gatewayId));
  const playbackSessionIds = gatewaySessions
    .map((gateway: JsonRecord) => stringOrNull(gateway.playback_session_id))
    .filter((sessionId: string | null): sessionId is string => Boolean(sessionId));

  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    await Promise.allSettled(gatewaySessions.map(async (gateway: JsonRecord) => {
      const externalSessionId = stringOrNull(gateway.external_session_id);
      if (!externalSessionId) return;
      const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/sessions/${encodeURIComponent(externalSessionId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
      });
      if (!response.ok && response.status !== 404) {
        console.warn("[norva-playback] gateway cleanup refused", response.status, await response.text().catch(() => ""));
      }
    }));
  }

  const now = new Date().toISOString();
  if (gatewayIds.length) {
    const { error: gatewayUpdateError } = await db
      .from("cloud_gateway_sessions")
      .update({ status: "expired", expires_at: now })
      .in("id", gatewayIds);
    if (gatewayUpdateError) {
      console.warn("[norva-playback] unable to mark gateway sessions expired", gatewayUpdateError.message);
    }
  }
  if (playbackSessionIds.length) {
    const { error: playbackUpdateError } = await db
      .from("cloud_playback_sessions")
      .update({ status: "expired", expires_at: now })
      .in("id", playbackSessionIds);
    if (playbackUpdateError) {
      console.warn("[norva-playback] unable to mark playback sessions expired", playbackUpdateError.message);
    }
  }
}

async function resolvePlaybackTarget(
  sourceId: string,
  itemType: string,
  itemId: string,
  userId: string,
  db: SupabaseClient,
  requestHint: JsonRecord = {},
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
    const requestContainer = stringOrNull(requestHint.container);
    const storedContainer = stringOr(hint.container, "m3u8");
    return xtreamStreamUrl({
      serverUrl: stringOr(sourceConfig.serverUrl, ""),
      username: stringOr(sourceConfig.username, ""),
      password: stringOr(sourceConfig.password, ""),
      streamType: stringOr(hint.streamType, "live"),
      streamId: stringOr(hint.streamId, ""),
      container: requestContainer || storedContainer,
    });
  }

  throw new HttpError(400, "This media item has no playback target");
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
  mode: "direct" | "relay" | "transcode",
  userAgent: string | null = null,
  playbackHint: JsonRecord = {},
) {
  const gatewayMode = mode === "transcode" ? "transcode" : "remux";
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    const { data, error } = await db
      .from("cloud_gateway_sessions")
      .insert({
        user_id: userId,
        playback_session_id: playbackSessionId,
        status: "pending",
        mode: gatewayMode,
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error) throwDb(error, "Unable to create pending gateway session");
    return { status: "pending", session: data, hlsUrl: null, startupMs: null };
  }

  const gatewayHints = gatewayPlaybackHints(playbackHint);
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
      mode: gatewayMode,
      expiresAt,
      playbackHint: compactRecord(playbackHint),
      ...gatewayHints,
      ...(userAgent ? { userAgent } : {}),
    }),
  });
  const gatewayBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
  const startupMs = Math.max(1, Math.round(performance.now() - startupStartedAt));
  const audioMode = stringOrNull(gatewayBody.audioMode ?? gatewayBody.audio_mode);

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
  return { status: data.status, session: data, hlsUrl: data.hls_url, startupMs, audioMode };
}

function gatewayPlaybackHints(playbackHint: JsonRecord) {
  const codecProfile = recordOrEmpty(playbackHint.codecProfile ?? playbackHint.codec_profile);
  return compactRecord({
    codecProfile,
    audioCodec: stringOrNull(
      playbackHint.audioCodec ??
        playbackHint.audio_codec ??
        codecProfile.audioCodec ??
        codecProfile.audio_codec ??
        codecProfile.audio,
    ),
    audioProfile: stringOrNull(
      playbackHint.audioProfile ??
        playbackHint.audio_profile ??
        codecProfile.audioProfile ??
        codecProfile.audio_profile,
    ),
    audioChannels: boundedNullableInt(
      playbackHint.audioChannels ??
        playbackHint.audio_channels ??
        codecProfile.audioChannels ??
        codecProfile.audio_channels ??
        codecProfile.channels,
      0,
      16,
    ),
    audioMode: stringOrNull(playbackHint.audioMode ?? playbackHint.audio_mode),
    videoCodec: stringOrNull(
      playbackHint.videoCodec ??
        playbackHint.video_codec ??
        codecProfile.videoCodec ??
        codecProfile.video_codec ??
        codecProfile.video,
    ),
    clientAudioPassthrough:
      playbackHint.clientAudioPassthrough === false || playbackHint.client_audio_passthrough === false
        ? false
        : playbackHint.clientAudioPassthrough === true || playbackHint.client_audio_passthrough === true
          ? true
          : undefined,
  });
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
    console.warn("[norva-playback] unable to record playback startup observation", error.message);
  }
}

function isProjectionMissing(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: string; message?: string };
  return record.code === "42P01" || String(record.message || "").includes("cloud_title");
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

async function assertOwnedSource(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_sources")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify source ownership");
  if (!data) throw new HttpError(404, "Source not found");
}

async function assertOwnedDevice(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_devices")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("revoked", false)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify device ownership");
  if (!data) throw new HttpError(404, "Device not found");
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;

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
    if (error) console.warn("[norva-playback] runtime config unavailable", error.message);
    else {
      for (const item of data ?? []) {
        if (typeof item.key === "string" && typeof item.value === "string") fromDb.set(item.key, item.value);
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

async function decryptSourceConfig(ciphertext: string, runtimeConfig: RuntimeConfig): Promise<JsonRecord> {
  if (!runtimeConfig.sourceConfigKey) throw new HttpError(503, "Norva Cloud source encryption is not configured");
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
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function hmacBase64Url(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64Url(new Uint8Array(signature));
}

function choosePlaybackMode(requestedMode: string, body: JsonRecord) {
  if (requestedMode === "direct" || requestedMode === "relay" || requestedMode === "transcode") return requestedMode;
  if (body.requiresRelay === true || body.requires_relay === true) return "relay";
  if (body.requiresTranscode === true || body.requires_transcode === true) return "transcode";
  return "direct";
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

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
  } catch {
    throw new HttpError(400, "URL must be a valid http(s) URL");
  }
}

async function readJson(req: Request): Promise<JsonRecord> {
  const text = await req.text();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new HttpError(400, "JSON body must be an object");
  return parsed;
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

function routeSegments(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "norva-playback") parts.shift();
  return parts;
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

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function compactRecord(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
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

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
