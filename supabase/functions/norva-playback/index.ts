import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getEntitlementDecision, getEntitlementRuntime, limitNumber } from "../_shared/entitlements.ts";

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
      const entitlementRuntime = getEntitlementRuntime();
      return json(req, {
        ok: true,
        service: "norva-playback",
        version: 13,
        entitlements: true,
        entitlementsMode: entitlementRuntime.mode,
        entitlementsEnforced: entitlementRuntime.enforced,
        relayConfigured: Boolean(config.relayBaseUrl && config.relayTokenSecret),
        gatewayConfigured: Boolean(config.mediaGatewayUrl && config.mediaGatewayToken),
      });
    }
    if (req.method === "GET" && segments[0] === "telemetry" && segments[1] === "summary") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await getPlaybackTelemetrySummary(url, identity.userId, supabase));
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      (segments[1] === "sessions" || segments[1] === "session") &&
      !segments[2]
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

async function requirePlaybackCapacity(userId: string, db: SupabaseClient) {
  const decision = await getEntitlementDecision(db, userId);
  if (!decision.allowed) throwEntitlementRequired("playback", decision);

  const limit = limitNumber(decision.limits, "concurrent_streams", 0);
  if (limit <= 0) throwEntitlementRequired("concurrent_streams", decision, { limit, current: 0 });

  const { count, error } = await db
    .from("cloud_playback_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["pending", "ready"])
    .gt("expires_at", new Date().toISOString());

  if (error) throwDb(error, "Unable to verify Norva access limits");
  if ((count ?? 0) >= limit) {
    throwEntitlementRequired("concurrent_streams", decision, { limit, current: count ?? 0 });
  }
}

function throwEntitlementRequired(feature: string, decision: unknown, usage?: unknown): never {
  throw new HttpError(402, "Norva access required", {
    code: "subscription_required",
    feature,
    entitlement: decision,
    usage,
  });
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
  let requestedPlaybackHint = recordOrEmpty(body.playbackHint ?? body.playback_hint);
  const userAgent = stringOrNull(body.userAgent ?? body.user_agent);
  const clientMetadata = clientTelemetryMetadataFromBody(body);

  if (!targetUrl && sourceId && itemType && itemId) {
    const resolved = await resolvePlaybackTarget(sourceId, itemType, itemId, userId, db, requestedPlaybackHint);
    targetUrl = resolved.targetUrl;
    requestedPlaybackHint = mergePlaybackHints(resolved.playbackHint, requestedPlaybackHint);
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
  await requirePlaybackCapacity(userId, db);

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

  let gateway;
  try {
    gateway = await createGatewaySession(session.id, userId, targetUrl, expiresAt, db, mode, userAgent, requestedPlaybackHint);
  } catch (error) {
    await recordPlaybackSessionFailure(db, {
      userId,
      deviceId,
      playbackSessionId: session.id,
      sourceId,
      itemType,
      itemId,
      playbackMode: mode,
      clientMetadata,
      error,
    });
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
  if (sourceId && gateway.codecProfile) {
    await persistObservedCodecProfile(db, {
      userId,
      sourceId,
      itemType,
      itemId,
      codecProfile: gateway.codecProfile,
      startupMs: gateway.startupMs,
      audioMode: gateway.audioMode,
    });
  }
  const responseCodecProfile = mergeCodecProfileAnnotations(
    firstUsefulCodecProfile(requestedPlaybackHint.codecProfile, requestedPlaybackHint.codec_profile),
    recordOrEmpty(gateway.codecProfile),
  );
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
      codecProfile: hasUsefulCodecProfile(responseCodecProfile) ? responseCodecProfile : null,
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

async function recordPlaybackSessionFailure(
  db: SupabaseClient,
  options: {
    userId: string;
    deviceId: string | null;
    playbackSessionId: string;
    sourceId: string | null;
    itemType: string;
    itemId: string;
    playbackMode: string;
    clientMetadata: JsonRecord;
    error: unknown;
  },
) {
  const failure = classifyPlaybackFailure(options.error);
  const now = new Date().toISOString();

  const { error: sessionError } = await db
    .from("cloud_playback_sessions")
    .update({
      status: "failed",
      error_code: failure.errorCode,
      error_message: failure.errorMessage,
      updated_at: now,
    })
    .eq("id", options.playbackSessionId)
    .eq("user_id", options.userId);
  if (sessionError) {
    console.warn("[norva-playback] unable to mark failed playback session", sessionError.message);
  }

  const { error: eventError } = await db
    .from("cloud_playback_events")
    .insert({
      user_id: options.userId,
      device_id: options.deviceId,
      playback_session_id: options.playbackSessionId,
      source_id: options.sourceId,
      item_type: options.itemType,
      item_id: options.itemId,
      event_type: "gateway_error",
      position_seconds: 0,
      duration_seconds: 0,
      playback_mode: options.playbackMode,
      error_code: failure.errorCode,
      error_message: failure.errorMessage,
      metadata: compactRecord({
        ...options.clientMetadata,
        failureCategory: failure.failureCategory,
        gatewayStatus: failure.gatewayStatus,
        providerStatus: failure.providerStatus,
        providerConcurrencySignal: failure.providerConcurrencySignal,
        gatewayDetails: failure.gatewayDetails,
      }),
    });
  if (eventError) {
    console.warn("[norva-playback] unable to record playback failure event", eventError.message);
  }
}

async function getPlaybackTelemetrySummary(url: URL, userId: string, db: SupabaseClient) {
  const days = boundedInt(url.searchParams.get("days"), 7, 1, 90);
  const limit = boundedInt(url.searchParams.get("limit"), 5000, 100, 20000);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  const { data, error } = await db
    .from("cloud_playback_events")
    .select("item_type,event_type,time_to_first_frame_ms,playback_mode,error_code,metadata,created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throwDb(error, "Unable to load playback telemetry");

  const rows = (data ?? []) as JsonRecord[];
  const byContentType: Record<string, JsonRecord> = {};
  const byClientSurface: Record<string, JsonRecord> = {};
  const ttffOverall: number[] = [];
  const ttffByContentType: Record<string, number[]> = {};
  let providerConcurrencyRefusals = 0;
  let gatewayErrors = 0;
  let playbackErrors = 0;

  for (const row of rows) {
    const itemType = normalizeTelemetryKey(row.item_type, "unknown");
    const eventType = normalizeTelemetryKey(row.event_type, "unknown");
    const metadata = recordOrEmpty(row.metadata);
    const surface = normalizeTelemetryKey(
      metadata.clientSurface ?? metadata.client_surface ?? metadata.surface ?? metadata.client,
      "unknown",
    );

    const typeBucket = telemetryBucket(byContentType, itemType);
    const surfaceBucket = telemetryBucket(byClientSurface, surface);
    typeBucket.events = numberValue(typeBucket.events) + 1;
    surfaceBucket.events = numberValue(surfaceBucket.events) + 1;

    if (eventType === "play_requested") {
      typeBucket.requests = numberValue(typeBucket.requests) + 1;
      surfaceBucket.requests = numberValue(surfaceBucket.requests) + 1;
    }
    if (eventType === "first_frame") {
      typeBucket.firstFrames = numberValue(typeBucket.firstFrames) + 1;
      surfaceBucket.firstFrames = numberValue(surfaceBucket.firstFrames) + 1;
    }
    if (eventType === "playback_error") {
      playbackErrors += 1;
      typeBucket.errors = numberValue(typeBucket.errors) + 1;
      surfaceBucket.errors = numberValue(surfaceBucket.errors) + 1;
    }
    if (eventType === "gateway_error") {
      gatewayErrors += 1;
      typeBucket.errors = numberValue(typeBucket.errors) + 1;
      typeBucket.gatewayErrors = numberValue(typeBucket.gatewayErrors) + 1;
      surfaceBucket.errors = numberValue(surfaceBucket.errors) + 1;
      surfaceBucket.gatewayErrors = numberValue(surfaceBucket.gatewayErrors) + 1;
    }

    const isConcurrencySignal =
      metadata.providerConcurrencySignal === true ||
      metadata.provider_concurrency_signal === true ||
      stringOr(metadata.failureCategory ?? metadata.failure_category, "") === "provider_concurrency_or_auth";
    if (isConcurrencySignal) {
      providerConcurrencyRefusals += 1;
      typeBucket.providerConcurrencyRefusals = numberValue(typeBucket.providerConcurrencyRefusals) + 1;
      surfaceBucket.providerConcurrencyRefusals = numberValue(surfaceBucket.providerConcurrencyRefusals) + 1;
    }

    const ttff = boundedNullableInt(row.time_to_first_frame_ms, 0, 10 * 60 * 1000);
    if (ttff && (eventType === "first_frame" || eventType === "play_started")) {
      ttffOverall.push(ttff);
      if (!ttffByContentType[itemType]) ttffByContentType[itemType] = [];
      ttffByContentType[itemType].push(ttff);
    }
  }

  const liveRequests = numberValue(byContentType.live?.requests);
  const movieRequests = numberValue(byContentType.movie?.requests);
  const seriesRequests = numberValue(byContentType.series?.requests);
  const vodRequests = movieRequests + seriesRequests;
  const totalRequests = Math.max(1, liveRequests + vodRequests);
  const androidTvRequests = numberValue(byClientSurface["android-tv"]?.requests);

  return {
    window: { since, until, days, sampleSize: rows.length, limit },
    playback: {
      byContentType,
      byClientSurface,
      errors: {
        gatewayErrors,
        playbackErrors,
        providerConcurrencyRefusals,
      },
      ttff: {
        overall: percentileSummary(ttffOverall),
        byContentType: Object.fromEntries(
          Object.entries(ttffByContentType).map(([key, values]) => [key, percentileSummary(values)]),
        ),
      },
    },
    decisionSignals: {
      liveRequestShare: roundRatio(liveRequests / totalRequests),
      vodRequestShare: roundRatio(vodRequests / totalRequests),
      androidTvRequestShare: roundRatio(androidTvRequests / totalRequests),
      providerConcurrencyRefusals,
    },
  };
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
    .select("playback_hint,metadata")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .eq("external_id", itemId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to resolve playback item");
  if (!item) {
    if (itemType === "series") {
      const sourceConfig = await loadSourceConfig(sourceId, userId, db);
      const requestContainer = stringOr(requestHint.container, "mp4");
      return {
        targetUrl: xtreamStreamUrl({
          serverUrl: stringOr(sourceConfig.serverUrl, ""),
          username: stringOr(sourceConfig.username, ""),
          password: stringOr(sourceConfig.password, ""),
          streamType: "series",
          streamId: itemId,
          container: requestContainer,
        }),
        playbackHint: mergePlaybackHints(recordOrEmpty(requestHint), compactRecord({
          container: requestContainer,
          streamType: "series",
          itemType: "series",
        })),
      };
    }
    throw new HttpError(404, "Media item not found");
  }

  const hint = recordOrEmpty(item.playback_hint);
  const metadata = recordOrEmpty(item.metadata);
  const storedCodecProfile = firstUsefulCodecProfile(
    hint.codecProfile,
    hint.codec_profile,
    metadata.codecProfile,
    metadata.codec_profile,
  );
  const storedPlaybackHint = mergePlaybackHints(
    compactRecord({
      ...hint,
      codecProfile: storedCodecProfile,
    }),
    {},
  );
  if (typeof hint.targetUrl === "string") {
    return { targetUrl: hint.targetUrl, playbackHint: storedPlaybackHint };
  }

  if (hint.sourceType === "xtream") {
    const sourceConfig = await loadSourceConfig(sourceId, userId, db);
    const requestContainer = stringOrNull(requestHint.container);
    const storedContainer = stringOr(hint.container, "m3u8");
    return {
      targetUrl: xtreamStreamUrl({
        serverUrl: stringOr(sourceConfig.serverUrl, ""),
        username: stringOr(sourceConfig.username, ""),
        password: stringOr(sourceConfig.password, ""),
        streamType: stringOr(hint.streamType, "live"),
        streamId: stringOr(hint.streamId, ""),
        container: requestContainer || storedContainer,
      }),
      playbackHint: mergePlaybackHints(storedPlaybackHint, compactRecord({ container: requestContainer || storedContainer })),
    };
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
  const gatewayMode = gatewayModeForPlayback(mode, playbackHint);
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
  const baseGatewayBody = {
    playbackSessionId,
    ownerKey: await sha256Hex(userId),
    sourceUrl: targetUrl,
    mode: gatewayMode,
    expiresAt,
    playbackHint: compactRecord(playbackHint),
    seekOffset: gatewayHints.seekOffset,
    startOffset: gatewayHints.startOffset,
    ...gatewayHints,
    ...(userAgent ? { userAgent } : {}),
  };
  let { response, body: gatewayBody } = await requestGatewaySession(runtimeConfig.mediaGatewayUrl, runtimeConfig.mediaGatewayToken, baseGatewayBody);
  if (!response.ok && shouldRetryGatewayWithAudioTranscode(gatewayHints, response.status)) {
    const fallbackHint = mergePlaybackHints(playbackHint, {
      audioMode: "transcode",
      audioFallbackReason: "copy_start_failed",
    });
    ({ response, body: gatewayBody } = await requestGatewaySession(runtimeConfig.mediaGatewayUrl, runtimeConfig.mediaGatewayToken, {
      ...baseGatewayBody,
      playbackHint: fallbackHint,
      audioMode: "transcode",
    }));
  }
  if (!response.ok) throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
  const startupMs = Math.max(1, Math.round(performance.now() - startupStartedAt));
  const audioMode = stringOrNull(gatewayBody.audioMode ?? gatewayBody.audio_mode);
  const codecProfile = firstUsefulCodecProfile(gatewayBody.codecProfile, gatewayBody.codec_profile);

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
  return { status: data.status, session: data, hlsUrl: data.hls_url, startupMs, audioMode, codecProfile };
}

async function requestGatewaySession(
  baseUrl: string,
  token: string,
  body: JsonRecord,
) {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json().catch(() => ({})),
  };
}

function shouldRetryGatewayWithAudioTranscode(gatewayHints: JsonRecord, status: number) {
  if (![500, 502, 503, 504].includes(status)) return false;
  const requested = normalizeCodecToken(gatewayHints.audioMode ?? gatewayHints.audio_mode);
  if (requested === "transcode" || requested === "encode") return false;
  return Boolean(
    firstUsefulCodecProfile(gatewayHints.codecProfile, gatewayHints.codec_profile) ||
    stringOrNull(gatewayHints.audioCodec ?? gatewayHints.audio_codec),
  );
}

function gatewayModeForPlayback(mode: "direct" | "relay" | "transcode", playbackHint: JsonRecord): "remux" | "transcode" {
  const requested = normalizeCodecToken(playbackHint.gatewayMode ?? playbackHint.gateway_mode);
  if (requested === "remux" || requested === "copy") return "remux";
  if (requested === "transcode" || requested === "encode") return "transcode";
  return mode === "transcode" ? "transcode" : "remux";
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
    audioStreamIndex: boundedNullableInt(
      playbackHint.audioStreamIndex ??
        playbackHint.audio_stream_index,
      0,
      1024,
    ),
    audioMode: stringOrNull(playbackHint.audioMode ?? playbackHint.audio_mode),
    videoCodec: stringOrNull(
      playbackHint.videoCodec ??
        playbackHint.video_codec ??
        codecProfile.videoCodec ??
        codecProfile.video_codec ??
        codecProfile.video,
    ),
    seekOffset: boundedNullableNumber(
      playbackHint.seekOffset ??
        playbackHint.seek_offset ??
        playbackHint.startOffset ??
        playbackHint.start_offset ??
        playbackHint.resumeTime ??
        playbackHint.resume_time,
      0,
      24 * 60 * 60,
    ),
    startOffset: boundedNullableNumber(
      playbackHint.startOffset ??
        playbackHint.start_offset ??
        playbackHint.seekOffset ??
        playbackHint.seek_offset ??
        playbackHint.resumeTime ??
        playbackHint.resume_time,
      0,
      24 * 60 * 60,
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

async function persistObservedCodecProfile(
  db: SupabaseClient,
  options: {
    userId: string;
    sourceId: string;
    itemType: string;
    itemId: string;
    codecProfile: JsonRecord;
    startupMs: number | null;
    audioMode: string | null;
  },
) {
  const itemType = options.itemType === "series" ? "series" : options.itemType === "movie" ? "movie" : "";
  const observedCodecProfile = normalizeCodecProfile(options.codecProfile);
  if (!itemType || !options.itemId || !hasUsefulCodecProfile(observedCodecProfile)) return;

  const observedAt = new Date().toISOString();
  const { data: item, error } = await db
    .from("cloud_media_items")
    .select("id,metadata,playback_hint")
    .eq("user_id", options.userId)
    .eq("source_id", options.sourceId)
    .eq("item_type", itemType)
    .eq("external_id", options.itemId)
    .maybeSingle();
  if (error) {
    console.warn("[norva-playback] unable to load media item for codec profile", error.message);
    return;
  }

  const metadata = recordOrEmpty(item?.metadata);
  const playbackHint = recordOrEmpty(item?.playback_hint);
  const codecProfile = mergeCodecProfileAnnotations(
    firstUsefulCodecProfile(metadata.codecProfile, metadata.codec_profile, playbackHint.codecProfile, playbackHint.codec_profile),
    observedCodecProfile,
  );
  const mergedPlaybackHint = mergePlaybackHints(playbackHint, compactRecord({
    codecProfile,
    audioMode: options.audioMode || undefined,
  }));
  if (item?.id) {
    const { error: itemUpdateError } = await db
      .from("cloud_media_items")
      .update({
        metadata: compactRecord({
          ...metadata,
          codecProfile,
          codecProfileObservedAt: observedAt,
        }),
        playback_hint: mergedPlaybackHint,
      })
      .eq("id", item.id);
    if (itemUpdateError) {
      console.warn("[norva-playback] unable to persist media codec profile", itemUpdateError.message);
    }
  }

  const tier = compatibilityTierForCodecProfile(codecProfile, mergedPlaybackHint);
  const variantPatch: JsonRecord = compactRecord({
    codec_profile: codecProfile,
    compatibility_tier: tier,
    playback_cost_score: playbackCostScoreForObservation(tier, options.startupMs),
  });
  const { error: variantError } = await db
    .from("cloud_title_variants")
    .update(variantPatch)
    .eq("user_id", options.userId)
    .eq("source_id", options.sourceId)
    .eq("item_type", itemType)
    .eq("external_id", options.itemId);
  if (variantError && !isProjectionMissing(variantError)) {
    console.warn("[norva-playback] unable to persist variant codec profile", variantError.message);
  }
}

function mergePlaybackHints(base: JsonRecord, override: JsonRecord) {
  const baseRecord = recordOrEmpty(base);
  const overrideRecord = recordOrEmpty(override);
  const codecProfile = firstUsefulCodecProfile(
    overrideRecord.codecProfile,
    overrideRecord.codec_profile,
    baseRecord.codecProfile,
    baseRecord.codec_profile,
  );
  return compactRecord({
    ...baseRecord,
    ...overrideRecord,
    ...(hasUsefulCodecProfile(codecProfile) ? { codecProfile } : {}),
  });
}

function firstUsefulCodecProfile(...values: unknown[]) {
  for (const value of values) {
    const profile = normalizeCodecProfile(recordOrEmpty(value));
    if (hasUsefulCodecProfile(profile)) return profile;
  }
  return {};
}

function mergeCodecProfileAnnotations(existingValue: unknown, observedValue: unknown) {
  const existing = normalizeCodecProfile(recordOrEmpty(existingValue));
  const observed = normalizeCodecProfile(recordOrEmpty(observedValue));
  if (!hasUsefulCodecProfile(observed)) return existing;
  if (!hasUsefulCodecProfile(existing)) return observed;

  return compactRecord({
    ...observed,
    subtitles: mergeSubtitleTrackAnnotations(existing.subtitles, observed.subtitles),
  });
}

function mergeSubtitleTrackAnnotations(existingValue: unknown, observedValue: unknown) {
  const existing = Array.isArray(existingValue) ? existingValue.map((track) => recordOrEmpty(track)) : [];
  const observed = Array.isArray(observedValue) ? observedValue.map((track) => recordOrEmpty(track)) : [];
  if (!observed.length) return observed;

  return observed.map((track, order) => {
    const match = findMatchingCodecTrack(existing, track, order);
    const inferredLanguage = stringOrNull(track.inferredLanguage ?? track.inferred_language)
      ?? stringOrNull(match?.inferredLanguage ?? match?.inferred_language);
    return compactRecord({
      ...track,
      inferredLanguage,
    });
  });
}

function findMatchingCodecTrack(tracks: JsonRecord[], target: JsonRecord, order: number) {
  const targetIndex = boundedNullableInt(target.index, 0, 128);
  if (targetIndex !== null) {
    const byIndex = tracks.find((track) => boundedNullableInt(track.index, 0, 128) === targetIndex);
    if (byIndex) return byIndex;
  }

  const targetOrder = boundedNullableInt(target.order, 0, 128) ?? order;
  const byOrder = tracks.find((track) => boundedNullableInt(track.order, 0, 128) === targetOrder);
  if (byOrder) return byOrder;

  return tracks[order] ?? null;
}

function normalizeCodecProfile(profile: JsonRecord) {
  return compactRecord({
    videoCodec: stringOrNull(profile.videoCodec ?? profile.video_codec ?? profile.video),
    videoProfile: stringOrNull(profile.videoProfile ?? profile.video_profile),
    videoWidth: boundedNullableInt(profile.videoWidth ?? profile.video_width ?? profile.width, 0, 16_384),
    videoHeight: boundedNullableInt(profile.videoHeight ?? profile.video_height ?? profile.height, 0, 16_384),
    videoPixelFormat: stringOrNull(profile.videoPixelFormat ?? profile.video_pixel_format ?? profile.pix_fmt),
    audioCodec: stringOrNull(profile.audioCodec ?? profile.audio_codec ?? profile.audio),
    audioProfile: stringOrNull(profile.audioProfile ?? profile.audio_profile),
    audioChannels: boundedNullableInt(profile.audioChannels ?? profile.audio_channels ?? profile.channels, 0, 16),
    audioChannelLayout: stringOrNull(profile.audioChannelLayout ?? profile.audio_channel_layout ?? profile.channel_layout),
    audioSampleRate: boundedNullableInt(profile.audioSampleRate ?? profile.audio_sample_rate ?? profile.sample_rate, 0, 384_000),
    audioTracks: normalizeCodecProfileTracks(profile.audioTracks ?? profile.audio_tracks, "audio"),
    subtitles: normalizeCodecProfileTracks(profile.subtitles ?? profile.subtitleTracks ?? profile.subtitle_tracks, "subtitle"),
    container: stringOrNull(profile.container),
    durationSeconds: boundedNullableNumber(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration, 0, 24 * 60 * 60),
    bitRate: boundedNullableInt(profile.bitRate ?? profile.bit_rate, 0, 1_000_000_000),
    probeSource: stringOrNull(profile.probeSource ?? profile.probe_source),
    probeMs: boundedNullableInt(profile.probeMs ?? profile.probe_ms, 0, 120_000),
    probedAt: stringOrNull(profile.probedAt ?? profile.probed_at),
  });
}

function normalizeCodecProfileTracks(value: unknown, kind: "audio" | "subtitle") {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 32)
    .map((entry, order) => {
      const track = recordOrEmpty(entry);
      if (kind === "audio") {
        return compactRecord({
          index: boundedNullableInt(track.index, 0, 128),
          order: boundedNullableInt(track.order, 0, 128) ?? order,
          language: stringOrNull(track.language ?? track.lang),
          title: stringOrNull(track.title ?? track.name),
          codec: stringOrNull(track.codec ?? track.codecName ?? track.codec_name),
          channels: boundedNullableInt(track.channels, 0, 16),
          default: booleanOrNull(track.default),
        });
      }
      const subtitleType = stringOrNull(track.subtitleType ?? track.subtitle_type) || null;
      const extractable = booleanOrNull(track.extractable);
      return compactRecord({
        index: boundedNullableInt(track.index, 0, 128),
        order: boundedNullableInt(track.order, 0, 128) ?? order,
        language: stringOrNull(track.language ?? track.lang),
        inferredLanguage: stringOrNull(track.inferredLanguage ?? track.inferred_language),
        title: stringOrNull(track.title ?? track.name),
        codec: stringOrNull(track.codec ?? track.codecName ?? track.codec_name),
        subtitleType,
        extractable,
        burnInRequired: booleanOrNull(track.burnInRequired ?? track.burn_in_required),
        unsupportedReason: stringOrNull(track.unsupportedReason ?? track.unsupported_reason),
      });
    })
    .filter((track) => Object.keys(track).length > 0);
}

function booleanOrNull(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  return null;
}

function hasUsefulCodecProfile(profile: JsonRecord) {
  return Boolean(
    stringOrNull(profile.videoCodec ?? profile.video_codec ?? profile.video) ||
    stringOrNull(profile.audioCodec ?? profile.audio_codec ?? profile.audio) ||
    (Array.isArray(profile.audioTracks) && profile.audioTracks.length > 0) ||
    (Array.isArray(profile.audio_tracks) && profile.audio_tracks.length > 0) ||
    (Array.isArray(profile.subtitles) && profile.subtitles.length > 0) ||
    (Array.isArray(profile.subtitleTracks) && profile.subtitleTracks.length > 0) ||
    (Array.isArray(profile.subtitle_tracks) && profile.subtitle_tracks.length > 0)
  );
}

function compatibilityTierForCodecProfile(profile: JsonRecord, playbackHint: JsonRecord) {
  const video = normalizeCodecToken(profile.videoCodec ?? profile.video_codec ?? profile.video);
  const audio = normalizeCodecToken(profile.audioCodec ?? profile.audio_codec ?? profile.audio);
  const audioProfile = normalizeCodecToken(profile.audioProfile ?? profile.audio_profile);
  const channels = boundedNullableInt(profile.audioChannels ?? profile.audio_channels ?? profile.channels, 0, 16);
  const container = normalizeCodecToken(playbackHint.container ?? profile.container);
  const safeVideo = !video || video === "h264" || video === "avc1";
  const safeAudio = isBrowserSafeAudio(audio, audioProfile, channels);
  if (!safeVideo) return "video_transcode";
  if (audio && !safeAudio) return "audio_transcode";
  if (safeVideo && safeAudio) return container === "mp4" || container === "movmp4m4a3gp3g2mj2" ? "direct" : "remux";
  return "unknown";
}

function playbackCostScoreForObservation(tier: string, startupMs: number | null) {
  if (startupMs && Number.isFinite(startupMs) && startupMs > 0) {
    return Math.max(1, Math.min(999, Math.round(startupMs / 10)));
  }
  if (tier === "direct") return 100;
  if (tier === "remux") return 250;
  if (tier === "audio_transcode") return 380;
  if (tier === "video_transcode") return 650;
  return 500;
}

function isBrowserSafeAudio(codec: string, profile: string, channels: number | null) {
  const joined = `${codec} ${profile}`;
  if (!codec) return false;
  if (channels && channels > 2) return false;
  if (
    joined.includes("heaac") ||
    joined.includes("aache") ||
    joined.includes("sbr") ||
    joined.includes("mp4a.40.5") ||
    joined.includes("mp4a.40.29") ||
    codec.includes("eac3") ||
    codec.includes("e-ac3") ||
    codec.includes("ac3") ||
    codec.includes("dts") ||
    codec.includes("truehd") ||
    codec.includes("flac") ||
    codec.includes("pcm")
  ) return false;
  return codec.includes("aac") || codec.includes("mp4a.40.2") || codec.includes("mp3") || codec.includes("opus") || codec.includes("vorbis");
}

function normalizeCodecToken(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
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

function boundedNullableNumber(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value));
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

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function clientTelemetryMetadataFromBody(body: JsonRecord) {
  const nested = recordOrEmpty(body.metadata);
  const client = recordOrEmpty(
    body.clientMetadata ??
      body.client_metadata ??
      nested.clientMetadata ??
      nested.client_metadata,
  );
  const clientSurface = normalizeTelemetryKey(client.clientSurface ?? client.client_surface ?? client.surface, "");
  const viewportClass = normalizeTelemetryKey(client.viewportClass ?? client.viewport_class, "");
  const appMode = normalizeTelemetryKey(client.appMode ?? client.app_mode, "");
  const playbackEntry = normalizeTelemetryKey(client.playbackEntry ?? client.playback_entry, "");
  return compactRecord({
    clientSurface,
    viewportClass,
    appMode,
    playbackEntry,
  });
}

function classifyPlaybackFailure(error: unknown) {
  const gatewayStatus = error instanceof HttpError ? error.status : null;
  const message = error instanceof Error ? error.message : "Playback failed";
  const details = error instanceof HttpError ? error.details : undefined;
  const detailText = sanitizeTelemetryText(textFromGatewayDetails(details));
  const combined = `${message} ${detailText}`.toLowerCase();
  const providerStatus = extractProviderStatus(details, combined);
  const providerConcurrencySignal = Boolean(
    providerStatus === 401 ||
      providerStatus === 403 ||
      providerStatus === 429 ||
      /\b(maximum|max|too many|concurrent|connection limit|connections?)\b/.test(combined) ||
      /\b(unauthorized|unauthorised|authorization failed|forbidden|rate limit)\b/.test(combined)
  );
  const failureCategory = providerConcurrencySignal
    ? "provider_concurrency_or_auth"
    : gatewayStatus === 503
      ? "gateway_unavailable"
      : gatewayStatus && gatewayStatus >= 500
        ? "gateway_startup_failed"
        : "playback_session_failed";
  return {
    gatewayStatus,
    providerStatus,
    providerConcurrencySignal,
    failureCategory,
    errorCode: providerConcurrencySignal ? "provider_concurrency_or_auth" : `gateway_${gatewayStatus || "error"}`,
    errorMessage: truncateText(sanitizeTelemetryText(message), 240),
    gatewayDetails: truncateText(detailText, 500),
  };
}

function extractProviderStatus(details: unknown, text: string) {
  const fromRecord = firstNumericField(details, ["providerStatus", "provider_status", "upstreamStatus", "upstream_status", "statusCode", "status_code"]);
  if (fromRecord) return fromRecord;
  const match = text.match(/\b(401|403|408|429|500|502|503|504)\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function firstNumericField(value: unknown, fields: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const field of fields) {
    const parsed = boundedNullableInt(value[field], 100, 599);
    if (parsed) return parsed;
  }
  return null;
}

function textFromGatewayDetails(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return [
    value.error,
    value.message,
    value.details,
    value.reason,
    value.code,
  ]
    .map((entry) => typeof entry === "string" ? entry : "")
    .filter(Boolean)
    .join(" ");
}

function sanitizeTelemetryText(value: unknown) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/([?&](?:username|password|token|key)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeTelemetryKey(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function telemetryBucket(target: Record<string, JsonRecord>, key: string) {
  if (!target[key]) {
    target[key] = {
      events: 0,
      requests: 0,
      firstFrames: 0,
      errors: 0,
      gatewayErrors: 0,
      providerConcurrencyRefusals: 0,
    };
  }
  return target[key];
}

function percentileSummary(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], ratio: number) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function roundRatio(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
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
