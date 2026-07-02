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
  whisperDetect: boolean; // Phase 2: detect untagged audio-track languages via the relay (Workers AI). Off by default.
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
  "https://norva.tv",
  "https://app.norva.tv",
  "https://norva-web.pages.dev",
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
  "NORVA_WHISPER_DETECT",
];
const PROVIDER_SLOT_RELEASE_DELAY_MS = boundedInt(
  Deno.env.get("NORVA_PROVIDER_SLOT_RELEASE_DELAY_MS") ?? Deno.env.get("PROVIDER_SLOT_RELEASE_DELAY_MS"),
  2_500,
  0,
  15_000,
);
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
const ENV_WHISPER_DETECT = Deno.env.get("NORVA_WHISPER_DETECT") ?? "";

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
        version: 26,
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
    if (req.method === "POST" && segments[0] === "audio-backfill") {
      return json(req, await runAudioBackfill(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "transcribe-callback") {
      return json(req, await runTranscribeCallback(req, supabase));
    }
    if (req.method === "GET" && segments[0] === "generated-subtitle") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await getGeneratedSubtitle(req, identity.userId, supabase));
    }
    if (req.method === "POST" && segments[0] === "generated-subtitle") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await postGeneratedSubtitle(req, identity.userId, supabase));
    }
    if (req.method === "POST" && segments[0] === "generated-subtitle-notify") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await setGeneratedSubtitleNotify(req, identity.userId, supabase));
    }
    if (req.method === "GET" && segments[0] === "generated-subtitle-langs") {
      await requireIdentity(req, supabase);
      return json(req, { targets: await getTranslateTargets(await getRuntimeConfig(supabase)) });
    }
    if (req.method === "POST" && segments[0] === "catalog-mirror-verify") {
      return json(req, await runCatalogMirrorVerify(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "provider-playback-check") {
      return json(req, await runProviderPlaybackCheck(req, supabase));
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

  const closedGatewaySessions = await closeOpenGatewaySessionsForUser(userId, db);
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
  // Only the cloud-gateway transcode path shares the provider's single slot, so
  // only it benefits from a brief release wait after evicting a previous gateway
  // session. Direct/relay (residential native players, pass-through) never hold a
  // gateway slot — make them wait nothing. The gateway also retries provider 401s
  // internally, so this is a small head start, not the old 8s blanket stall that
  // made switching titles feel slow.
  const needsSlotWait = mode === "transcode" && closedGatewaySessions > 0;
  const startupWaitMs = Math.max(
    edgeCoordination?.waitMs ?? 0,
    needsSlotWait ? PROVIDER_SLOT_RELEASE_DELAY_MS : 0,
  );
  if (startupWaitMs) await sleep(startupWaitMs);
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
    // Direct plays straight from the device's residential IP. Some providers
    // reject that IP (e.g. HTTP 401) while accepting the media gateway's IP, so
    // hand the native player a gateway byte-pipe URL to fall back to on an
    // auth/IP/connection error. Minting it is just an HMAC — no DB write, no
    // provider connection (see createBytePipeAccess) — so it's safe to attach to
    // every direct response; the gateway only dials the provider if the device
    // actually fetches it. Best-effort: if the gateway isn't configured, direct
    // still works without a fallback.
    let fallbackUrl: string | null = null;
    try {
      const fb = await createBytePipeAccess(session.id, userId, targetUrl, expiresAt, db, userAgent);
      fallbackUrl = fb.url;
    } catch (_) { /* gateway not configured — no fallback, direct unaffected */ }
    return { session, playback: { mode, url: targetUrl, fallbackUrl, expiresAt } };
  }

  if (mode === "relay") {
    // In-browser engine: relay the RAW bytes through the media gateway (an IP
    // the provider accepts), not the Cloudflare relay (which the provider's WAF
    // 403s). The gateway does no transcode here — just a byte-range passthrough.
    if (body.enginePipe === true || body.engine_pipe === true) {
      const pipe = await createBytePipeAccess(session.id, userId, targetUrl, expiresAt, db, userAgent);
      // Name the audio AND subtitle tracks for the in-browser engine: it streams the raw
      // file via the gateway and can't read per-stream language tags. ONE relay header-parse
      // returns both (the container header carries both → zero extra provider round-trips).
      //  - Reuse the title's precomputed maps when present (no probe).
      //  - Otherwise probe + persist onto the title row, so the grid + next play are instant,
      //    the subtitle-pref restore works (tracks known at load), and the global cache is fed.
      // All best-effort — never blocks or breaks playback.
      let audioTracks: Array<{ index: number; lang: string | null }> = [];
      let subtitleTracks: JsonRecord[] = [];
      const titleRow = await resolveEngineAudioTitleRow(db, userId, sourceId, itemType, itemId, requestedPlaybackHint)
        .catch(() => null);
      let haveAudio = false; // this user's row already has the audio map
      let haveSub = false;   // ...or a subtitle probe (possibly empty) so we shouldn't re-probe
      const precomputedAudio = (titleRow && Array.isArray(titleRow.audio_tracks) ? titleRow.audio_tracks as JsonRecord[] : [])
        .map((t) => ({ index: Number(t?.index), lang: stringOrNull(t?.lang) }))
        .filter((t) => Number.isInteger(t.index));
      if (precomputedAudio.length) { audioTracks = precomputedAudio; haveAudio = true; }
      const precomputedSub = (titleRow && Array.isArray(titleRow.subtitle_tracks) ? titleRow.subtitle_tracks as JsonRecord[] : [])
        .filter((t) => Number.isInteger(Number(t?.index)));
      if (precomputedSub.length) { subtitleTracks = precomputedSub; haveSub = true; }
      // subtitle_probed_at distinguishes "probed, file has no subs" (skip) from "never probed".
      if (titleRow && titleRow.subtitle_probed_at) haveSub = true;

      // Cross-mirror cache key (providerKey when known, else the host) — drives the
      // global file-track read, the share/fan-out, and the whisper-detect cache below.
      const serverHost = await resolveFileTracksKey(sourceId, userId, db, targetUrl);
      const fileExternalId = itemType === "series"
        ? stringOr(requestedPlaybackHint.audioSeriesId ?? requestedPlaybackHint.audio_series_id ?? requestedPlaybackHint.seriesId ?? requestedPlaybackHint.series_id, "")
        : itemId;

      // Cross-user reuse: another user (or the crawl) may have already probed this exact
      // provider file. Pull from the global per-file cache (no provider hit) and fill this
      // user's row, before ever falling back to a probe.
      if ((!haveAudio || !haveSub) && titleRow?.id && serverHost && fileExternalId) {
        try {
          const { data: fr } = await db.from("catalog_file_tracks")
            .select("audio_tracks, subtitle_tracks, audio_probed_at, subtitle_probed_at")
            .eq("server_host", serverHost).eq("item_type", itemType).eq("external_id", fileExternalId)
            .maybeSingle();
          const fileRow = fr as JsonRecord | null;
          if (fileRow) {
            const fill: JsonRecord = {};
            if (!haveAudio && fileRow.audio_probed_at) {
              const ga = (Array.isArray(fileRow.audio_tracks) ? fileRow.audio_tracks as JsonRecord[] : [])
                .map((t) => ({ index: Number(t?.index), lang: stringOrNull(t?.lang) })).filter((t) => Number.isInteger(t.index));
              if (ga.length) {
                audioTracks = ga; haveAudio = true;
                fill.audio_tracks = ga;
                fill.audio_languages = [...new Set(ga.map((t) => t.lang).filter((l): l is string => Boolean(l)))].sort();
                fill.audio_probed_at = new Date().toISOString();
              }
            }
            if (!haveSub && fileRow.subtitle_probed_at) {
              const gs = Array.isArray(fileRow.subtitle_tracks) ? fileRow.subtitle_tracks as JsonRecord[] : [];
              subtitleTracks = gs; haveSub = true;
              fill.subtitle_tracks = gs;
              fill.subtitle_probed_at = new Date().toISOString();
            }
            if (Object.keys(fill).length) {
              try { await db.from("cloud_titles").update(fill).eq("user_id", userId).eq("id", titleRow.id); } catch (_) { /* best-effort */ }
            }
          }
        } catch (_) { /* best-effort global reuse */ }
      }

      // Still missing → probe the provider ONCE, persist to this user's row, and SHARE to the
      // global file cache + fan out to every other owner so they skip the probe entirely.
      if (!haveAudio || !haveSub) {
        let probed = { audioTracks: [] as Array<{ index: number; lang: string | null }>, subtitleTracks: [] as JsonRecord[] };
        try { probed = await probeEngineTracks(db, userId, targetUrl); } catch (_) { /* best-effort */ }
        const probeOk = probed.audioTracks.length > 0; // every video has audio → audio present == parse ok
        const gotAudio = !haveAudio && probeOk;
        const gotSub = !haveSub && probeOk;
        if (gotAudio) audioTracks = probed.audioTracks;
        if (gotSub) subtitleTracks = probed.subtitleTracks;
        if (titleRow?.id && (gotAudio || gotSub)) {
          const update: JsonRecord = {};
          let codes: string[] = [];
          if (gotAudio) {
            codes = [...new Set(probed.audioTracks.map((t) => t.lang).filter((l): l is string => Boolean(l)))].sort();
            update.audio_tracks = probed.audioTracks;
            update.audio_languages = codes;
            update.audio_probed_at = new Date().toISOString();
          }
          if (gotSub) {
            update.subtitle_tracks = probed.subtitleTracks;
            update.subtitle_probed_at = new Date().toISOString();
          }
          try {
            await db.from("cloud_titles").update(update).eq("user_id", userId).eq("id", titleRow.id);
            const tmdbId = stringOrNull(titleRow.provider_tmdb_id);
            if (codes.length && tmdbId && !/^(tt)?0+$/i.test(tmdbId)) {
              try {
                await db.rpc("merge_catalog_title_audio", { p_item_type: itemType, p_provider_tmdb_id: tmdbId, p_codes: codes });
              } catch (_) { /* best-effort global mirror */ }
            }
          } catch (_) { /* best-effort persist */ }
        }
        if (probeOk) {
          await shareFileTracks(db, serverHost, itemType, fileExternalId,
            gotAudio ? probed.audioTracks : [], gotSub ? probed.subtitleTracks : [], gotAudio, gotSub);
        }
        // Phase 2 (flag-gated): a freshly probed file may still carry UNTAGGED audio tracks
        // (lang null) — no provider/demux language. Detect them via Whisper IN THE BACKGROUND
        // and re-persist, so the next play is fully named. Runs once (right after the first
        // probe), best-effort, never blocks the response. Off unless NORVA_WHISPER_DETECT=true.
        if (gotAudio && titleRow?.id && serverHost && fileExternalId
          && audioTracks.length >= 2 && audioTracks.some((t) => !t.lang)) {
          const rc = await getRuntimeConfig(db);
          if (rc.whisperDetect && rc.mediaGatewayUrl && rc.mediaGatewayToken) {
            runBackground(detectUntaggedAudioLanguages({
              db, runtimeConfig: rc, userId, targetUrl, userAgent,
              audioTracks, titleId: titleRow.id, tmdbId: stringOrNull(titleRow.provider_tmdb_id),
              serverHost, itemType, fileExternalId, sessionId: session.id, expiresAt,
            }));
          }
        }
      }
      return {
        session,
        playback: {
          mode: "relay",
          url: pipe.url,
          tokenExpiresAt: expiresAt,
          ...(audioTracks.length ? { audioTracks } : {}),
          ...(subtitleTracks.length ? { subtitleTracks } : {}),
        },
      };
    }
    const relay = await createRelayAccess(session.id, userId, targetUrl, expiresAt, db, userAgent);
    return { session, playback: { mode, url: relay.url, tokenExpiresAt: expiresAt } };
  }

  let gateway;
  try {
    gateway = await createGatewaySession(session.id, userId, targetUrl, expiresAt, db, mode, userAgent, requestedPlaybackHint);
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

  await endEdgeSessionCoordinator({
    userId,
    sourceId: stringOrNull(session.source_id),
    playbackSessionId: id,
    gatewaySessionId: gatewaySessions
      .map((gateway: JsonRecord) => stringOrNull(gateway.external_session_id))
      .find(Boolean) ?? null,
  }, db);

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

  let sessionLinked = false;
  if (playbackSessionId) {
    const { data: session, error } = await db
      .from("cloud_playback_sessions")
      .select("id,source_id,device_id,item_type,item_id,mode")
      .eq("id", playbackSessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to verify playback session");
    if (session) {
      sessionLinked = true;
      sourceId = sourceId ?? stringOrNull(session.source_id);
      deviceId = deviceId ?? stringOrNull(session.device_id);
      itemType = itemType || stringOr(session.item_type, "");
      itemId = itemId || stringOr(session.item_id, "");
      playbackMode = playbackMode ?? stringOrNull(session.mode);
    }
    // If the session is already gone, DON'T drop the event: a late event (e.g. a failure
    // snapshot posted after the engine tore down / retried, or an end-of-playback ping)
    // still carries itemType/itemId and is exactly the diagnostic we must not lose. Record
    // it UNLINKED instead of 404ing — which silently lost every post-teardown error report.
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
      playback_session_id: sessionLinked ? playbackSessionId : null,
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

async function closeOpenGatewaySessionsForUser(userId: string, db: SupabaseClient): Promise<number> {
  const { data: gatewaySessions, error } = await db
    .from("cloud_gateway_sessions")
    .select("id, playback_session_id, external_session_id, status")
    .eq("user_id", userId)
    .in("status", ["pending", "starting", "ready"]);
  if (error) {
    console.warn("[norva-playback] unable to list open gateway sessions", error.message);
    return 0;
  }
  if (!gatewaySessions?.length) return 0;

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
  return gatewaySessions.length;
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
    waitMs: boundedInt(payload.waitMs, 0, 0, 15_000),
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
      console.warn("[norva-playback] edge coordinator skipped", response.status, payload);
      return null;
    }
    return payload as JsonRecord;
  } catch (error) {
    console.warn("[norva-playback] edge coordinator unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

// Phase 2 dedup read flag: when set to "catalog_media_items", playback resolves
// the provider-global catalogue instead of the per-user copy. Default OFF.
function mediaReadFromCatalog(): boolean {
  return (Deno.env.get("NORVA_CATALOG_MEDIA_READ_SOURCE") || "").trim() === "catalog_media_items";
}

// Provider identity for a source (non-secret, from config_hint). Cached in-isolate so
// the playback path adds at most one lookup per source per isolate.
//  - host: the configured provider hostname.
//  - key:  the canonical CROSS-MIRROR cache key. Phase B: the STABLE provider IDENTITY id when the
//          source resolves to one — so two resellers of ONE panel (different providerKey) AND a
//          taxonomy-drifted key all share a single cross-user cache. A reseller hands out many URLs
//          (DNS aliases / reverse-proxies) for one Xtream panel, and the panel's category taxonomy
//          drifts, so keying on either hostname or providerKey FRAGMENTS the cache. The identity id
//          (resolved from stream-ID overlap, see docs/PROVIDER-IDENTITY-DEDUP.md §8) is invariant to
//          both. Falls back to providerKey, then host, so an unresolved/deleted-provider source keeps
//          the old behaviour exactly (defensive).
//  - fingerprint: the raw providerKey (pre-identity). Kept so a read can fall back to the old key
//          during the transition window before the cache backfill runs.
const sourceIdentityCache = new Map<string, { host: string; key: string; fingerprint: string }>();
async function resolveSourceIdentity(sourceId: string, userId: string, db: SupabaseClient): Promise<{ host: string; key: string; fingerprint: string }> {
  const cacheKey = `${userId}:${sourceId}`;
  const cached = sourceIdentityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { data } = await db
    .from("cloud_sources")
    .select("config_hint")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  const hint = recordOrEmpty(data?.config_hint);
  const host = stringOr(hint.serverHost, "");
  const providerKey = stringOr(hint.providerKey, "");
  let key = providerKey || host;
  if (providerKey) {
    // Upgrade to the canonical identity id when this fingerprint resolves to one (Phase B). A missing
    // identity (unresolved / deleted provider) simply keeps the providerKey — no regression.
    try {
      const { data: idRow } = await db
        .from("catalog_provider_identities")
        .select("identity_id")
        .eq("provider_key", providerKey)
        .maybeSingle();
      const identityId = stringOr((idRow as JsonRecord | null)?.identity_id, "");
      if (identityId) key = identityId;
    } catch (_) { /* keep the providerKey fallback */ }
  }
  const identity = { host, key, fingerprint: providerKey || host };
  sourceIdentityCache.set(cacheKey, identity);
  return identity;
}
// catalog_media_items keying stays on the hostname (its writer writes the hostname;
// re-keying it on providerKey is a scoped follow-up — see the dedup doc).
async function resolveSourceHost(sourceId: string, userId: string, db: SupabaseClient): Promise<string> {
  return (await resolveSourceIdentity(sourceId, userId, db)).host;
}
// Cross-mirror cache key for catalog_file_tracks. Falls back to the stream URL host when
// the source has neither providerKey nor serverHost (rare; preserves old behaviour).
async function resolveFileTracksKey(sourceId: string, userId: string, db: SupabaseClient, fallbackUrl: string): Promise<string> {
  const { key } = await resolveSourceIdentity(sourceId, userId, db);
  return key || hostFromUrl(fallbackUrl);
}

async function resolvePlaybackTarget(
  sourceId: string,
  itemType: string,
  itemId: string,
  userId: string,
  db: SupabaseClient,
  requestHint: JsonRecord = {},
) {
  // Phase 2 dedup: when the read flag is on, resolve playback_hint/metadata from
  // the provider-global catalog_media_items (keyed by server_host) instead of the
  // per-user copy, with a per-user fallback so a global miss can never break
  // playback. mirror-verify proves playback_hint is byte-identical between the two,
  // so flag-on is provably equivalent — until the per-user copy is thinned away.
  let item: { playback_hint?: unknown; metadata?: unknown } | null = null;
  if (mediaReadFromCatalog()) {
    const host = await resolveSourceHost(sourceId, userId, db);
    if (host) {
      const { data } = await db
        .from("catalog_media_items")
        .select("playback_hint,metadata")
        .eq("server_host", host)
        .eq("item_type", itemType)
        .eq("external_id", itemId)
        .maybeSingle();
      if (data) item = data;
    }
  }
  if (!item) {
    const { data, error } = await db
      .from("cloud_media_items")
      .select("playback_hint,metadata")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .eq("external_id", itemId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to resolve playback item");
    item = data;
  }
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
    const streamType = stringOr(hint.streamType, "live");
    const container = xtreamPlaybackContainer(hint, streamType, requestContainer);
    return {
      targetUrl: xtreamStreamUrl({
        serverUrl: stringOr(sourceConfig.serverUrl, ""),
        username: stringOr(sourceConfig.username, ""),
        password: stringOr(sourceConfig.password, ""),
        streamType,
        streamId: stringOr(hint.streamId, ""),
        container,
      }),
      playbackHint: mergePlaybackHints(storedPlaybackHint, compactRecord({ container })),
    };
  }

  throw new HttpError(400, "This media item has no playback target");
}

// Series have no directly-playable stream id — the provider 406s on a series id; only
// EPISODES are streamable. Resolve a representative episode (first episode of the lowest
// season) via get_series_info, so the audio header-probe has a real file to read. A
// series' audio tracks are consistent across episodes, so one episode represents it.
async function resolveSeriesEpisodeUrl(sourceId: string, seriesId: string, userId: string, db: SupabaseClient): Promise<string | null> {
  const cfg = await loadSourceConfig(sourceId, userId, db).catch(() => null);
  if (!cfg) return null;
  const serverUrl = stringOr((cfg as JsonRecord).serverUrl, "");
  const username = stringOr((cfg as JsonRecord).username, "");
  const password = stringOr((cfg as JsonRecord).password, "");
  if (!serverUrl || !username || !password) return null;
  let base: string;
  try { base = normalizeBaseUrl(serverUrl); } catch { return null; }
  const api = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(api, { headers: { "user-agent": "NorvaCloud/1.0", accept: "application/json" } }).catch(() => null);
  if (!res || !res.ok) return null;
  const info = (await res.json().catch(() => null)) as JsonRecord | null;
  const episodes = recordOrEmpty(info?.episodes);
  // episodes is keyed by season number; pick the first episode of the lowest season.
  for (const sk of Object.keys(episodes).sort((a, b) => Number(a) - Number(b))) {
    const list = (episodes as JsonRecord)[sk];
    if (Array.isArray(list) && list.length) {
      const ep = recordOrEmpty(list[0]);
      const epId = stringOr(ep.id, "");
      const container = stringOr(ep.container_extension, "mp4");
      if (epId) return xtreamStreamUrl({ serverUrl, username, password, streamType: "series", streamId: epId, container });
    }
  }
  return null;
}

async function createRelayAccess(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  db: SupabaseClient,
  userAgent: string | null = null,
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
    // Carry the source's IPTV User-Agent so the relay reaches the provider with
    // the same UA the gateway uses (a browser UA is 403'd by providers).
    ...(userAgent ? { ua: userAgent } : {}),
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

// Byte-range passthrough URL on the media gateway for the in-browser engine.
// Signs the same token shape as the relay but with the shared gateway token, so
// the gateway verifies it statelessly (HMAC), then proxies the raw bytes from an
// IP the provider accepts. No transcode — the browser does that.
async function createBytePipeAccess(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  _db: SupabaseClient,
  userAgent: string | null = null,
) {
  const runtimeConfig = await getRuntimeConfig(_db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Media gateway is not configured");
  }
  const payload = JSON.stringify({
    v: 1,
    sid: playbackSessionId,
    uid: userId,
    url: targetUrl,
    ...(userAgent ? { ua: userAgent } : {}),
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  });
  const signature = await hmacBase64Url(runtimeConfig.mediaGatewayToken, payload);
  const token = `${base64Url(encoder.encode(payload))}.${signature}`;
  return { url: `${runtimeConfig.mediaGatewayUrl}/raw/${token}` };
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

function xtreamPlaybackContainer(hint: JsonRecord, streamTypeValue: unknown, requestedContainerValue: unknown = "") {
  const requestedContainer = stringOr(requestedContainerValue, "");
  if (requestedContainer) return requestedContainer;
  const streamType = stringOr(streamTypeValue, "live");
  const storedContainer = stringOr(hint.container, streamType === "live" ? "ts" : "mp4");
  const explicit = Boolean(hint.containerExplicit || hint.container_explicit);
  if (streamType === "live" && storedContainer.toLowerCase() === "m3u8" && !explicit) return "ts";
  return storedContainer;
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

// Short-TTL memo (cron audit, Lot 3): the enrichment sweeps call this PER TITLE via
// resolvePlaybackTarget/resolveSeriesEpisodeUrl — 1 PostgREST round-trip + 1 AES-GCM decrypt per
// probed title (~45k/day) for a config that changes only when the user edits credentials. 60s TTL
// covers a whole tick (25 sequential lookups → 1); the same runtimeConfigCache pattern as above.
// Config edits propagate within ≤60s — enrichment tolerates that; playback paths were already
// per-request. Errors/misses are NOT cached (a 404 keeps its original semantics).
const sourceConfigCache = new Map<string, { value: JsonRecord; expiresAt: number }>();

async function loadSourceConfig(sourceId: string, userId: string, db: SupabaseClient) {
  const cacheKey = `${userId}:${sourceId}`;
  const cached = sourceConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("config_ciphertext")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source config");
  if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
  const value = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
  sourceConfigCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  if (sourceConfigCache.size > 500) {                 // bound the isolate's memory (multi-tenant)
    for (const [k, v] of sourceConfigCache) { if (v.expiresAt <= Date.now()) sourceConfigCache.delete(k); }
  }
  return value;
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
    whisperDetect: (ENV_WHISPER_DETECT || fromDb.get("NORVA_WHISPER_DETECT") || "") === "true",
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

// ISO-639-2/local -> ISO-639-1 for the audio_languages column.
function normalizeIsoLang(value: string | null): string | null {
  const v = String(value || "").toLowerCase().trim();
  if (!v || v === "und") return null;
  const map: Record<string, string> = {
    fre: "fr", fra: "fr", eng: "en", ger: "de", deu: "de", spa: "es", ita: "it",
    por: "pt", dut: "nl", nld: "nl", ara: "ar", rus: "ru", tur: "tr", pol: "pl",
    hin: "hi", jpn: "ja", kor: "ko", zho: "zh", chi: "zh",
  };
  const code = map[v] || v;
  return /^[a-z]{2}$/.test(code) ? code : null;
}

// Probe a title's container for the ORDERED per-track audio map and persist it to
// cloud_titles.audio_tracks = [{index, lang}, ...] (absolute ffmpeg stream index ->
// ISO-639-1, or null when undetermined). The deduped SET already lives in
// audio_languages; this preserves ORDER so the in-browser engine (libav, which can't
// read per-stream language tags) labels each audio stream it demuxes by absolute index
// WITHOUT a playback-time probe. ALL audio tracks are kept in order (even null-lang ones)
// so index/position alignment holds. Best-effort; returns true on a stored, non-empty map.
async function persistOrderedAudioForTitle(
  db: SupabaseClient,
  runtimeConfig: RuntimeConfig,
  userId: string,
  titleId: string,
  variant: JsonRecord,
  fallbackItemType: string,
): Promise<boolean> {
  const sourceId = stringOr(variant.source_id, "");
  const externalId = stringOr(variant.external_id, "");
  const variantItemType = stringOr(variant.item_type, fallbackItemType);
  if (!sourceId || !externalId) return false;
  let targetUrl: string | null;
  if (variantItemType === "series") {
    targetUrl = await resolveSeriesEpisodeUrl(sourceId, externalId, userId, db).catch(() => null);
  } else {
    const target = await resolvePlaybackTarget(sourceId, variantItemType, externalId, userId, db).catch(() => null);
    targetUrl = target?.targetUrl ?? null;
  }
  if (!targetUrl) return false;
  const payload = JSON.stringify({ v: 1, sid: "audio-order", uid: userId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
  const token = `${base64Url(encoder.encode(payload))}.${await hmacBase64Url(runtimeConfig.relayTokenSecret, payload)}`;
  const res = await fetch(`${runtimeConfig.relayBaseUrl}/probe-audio/${token}`, { headers: { accept: "application/json" } });
  if (!res.ok) return false;
  const info = await res.json().catch(() => null) as JsonRecord | null;
  const raw = info && Array.isArray(info.audioTracks) ? info.audioTracks as JsonRecord[] : [];
  const ordered = raw
    .map((t) => ({ index: Number(t?.index), lang: normalizeIsoLang(stringOrNull(t?.lang)) }))
    .filter((t) => Number.isInteger(t.index));
  // Subtitles ride along — the relay returns both in one call (zero extra cost).
  const subs = info && Array.isArray(info.subtitles) ? info.subtitles as JsonRecord[] : [];
  const orderedSubs = subs
    .map((s) => ({
      index: Number(s?.index),
      lang: normalizeIsoLang(stringOrNull(s?.lang ?? s?.language)),
      codec: stringOrNull(s?.codec),
      subtitleType: stringOrNull(s?.subtitleType) || (s?.extractable ? "text" : "image"),
      extractable: s?.extractable === true,
      forced: s?.forced === true,
    }))
    .filter((s) => Number.isInteger(s.index));
  if (!ordered.length) return false;
  const { error } = await db.from("cloud_titles")
    .update({ audio_tracks: ordered, subtitle_tracks: orderedSubs, subtitle_probed_at: new Date().toISOString() })
    .eq("user_id", userId).eq("id", titleId);
  // Cross-user share: global per-file cache + fan out to every owner.
  await shareFileTracks(db, await resolveFileTracksKey(sourceId, userId, db, targetUrl), variantItemType, externalId, ordered, orderedSubs, true, true);
  return !error;
}

// Probe a target's container for the ORDERED per-track audio map via the relay —
// the only path that reaches the provider (Deno egress is IP-blocked). Returns
// [{index, lang|null}, ...] in absolute ffmpeg-stream order, or [] on any failure.
// Used to name audio tracks for the IN-BROWSER ENGINE: it streams the raw file via
// the media gateway (an IP the provider accepts) and its libav build can't read
// per-stream language tags, so the browser CANNOT probe these titles itself. The
// relay 24h-edge-caches by (host, vod_id), so repeat plays are cheap. Best-effort,
// short-bounded; never throws (callers stay on the no-names path on failure).
async function probeEngineTracks(
  db: SupabaseClient,
  userId: string,
  targetUrl: string,
): Promise<{ audioTracks: Array<{ index: number; lang: string | null }>; subtitleTracks: JsonRecord[] }> {
  const empty = { audioTracks: [], subtitleTracks: [] };
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) return empty;
  const payload = JSON.stringify({ v: 1, sid: "engine-audio", uid: userId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
  const token = `${base64Url(encoder.encode(payload))}.${await hmacBase64Url(runtimeConfig.relayTokenSecret, payload)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${runtimeConfig.relayBaseUrl}/probe-audio/${token}`, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return empty;
    const info = await res.json().catch(() => null) as JsonRecord | null;
    const rawAudio = info && Array.isArray(info.audioTracks) ? info.audioTracks as JsonRecord[] : [];
    const audioTracks = rawAudio
      .map((t) => ({ index: Number(t?.index), lang: normalizeIsoLang(stringOrNull(t?.lang ?? t?.language)) }))
      .filter((t) => Number.isInteger(t.index));
    const rawSub = info && Array.isArray(info.subtitles) ? info.subtitles as JsonRecord[] : [];
    const subtitleTracks = rawSub
      .map((s) => ({
        index: Number(s?.index),
        lang: normalizeIsoLang(stringOrNull(s?.lang ?? s?.language)),
        codec: stringOrNull(s?.codec),
        subtitleType: stringOrNull(s?.subtitleType) || (s?.extractable ? "text" : "image"),
        extractable: s?.extractable === true,
        forced: s?.forced === true,
      }))
      .filter((s) => Number.isInteger(s.index)) as JsonRecord[];
    return { audioTracks, subtitleTracks };
  } catch (_) {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

function hostFromUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

// Cross-user track-map sharing: store the file's map in the global per-file cache AND fan it
// out to every OTHER user owning the same provider file, so they get the tracks with zero
// re-probe. Keyed by (server_host, item_type, external_id) — the file identity. Best-effort:
// must never fail the probe/playback. p_has_* gates the audio/subtitle halves independently.
async function shareFileTracks(
  db: SupabaseClient,
  serverHost: string,
  itemType: string,
  externalId: string,
  audioTracks: JsonRecord[],
  subtitleTracks: JsonRecord[],
  hasAudio: boolean,
  hasSubtitle: boolean,
): Promise<void> {
  if (!serverHost || !externalId || (!hasAudio && !hasSubtitle)) return;
  const args = {
    p_server_host: serverHost,
    p_item_type: itemType,
    p_external_id: externalId,
    p_audio_tracks: audioTracks,
    p_subtitle_tracks: subtitleTracks,
    p_has_audio: hasAudio,
    p_has_subtitle: hasSubtitle,
  };
  try { await db.rpc("upsert_catalog_file_tracks", args); } catch (_) { /* best-effort global cache */ }
  try { await db.rpc("fanout_file_tracks_to_users", args); } catch (_) { /* best-effort fan-out */ }
}

// Keep a best-effort task alive past the response on Supabase Edge (background work) without
// blocking it. Falls back to fire-and-forget where EdgeRuntime.waitUntil isn't present.
function runBackground(p: Promise<unknown>): void {
  const task = p.catch(() => {});
  try {
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(task);
  } catch (_) { /* fire-and-forget */ }
}

// Phase 2: detect the language of UNTAGGED audio tracks via the gateway's self-hosted
// whisper.cpp (no paid API), then re-persist the enriched map. The gateway extracts a short WAV
// per track, runs whisper.cpp + a transcript detector, and returns the language. ENRICH-only:
// fills a null lang, never overrides. Best-effort and background — never blocks playback. NOTE:
// the WAV extraction is a 2nd provider connection, so on a single-slot source it can lose to the
// live stream (458); an offline backfill is the single-slot-friendly alternative.
async function detectUntaggedAudioLanguages(opts: {
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  userId: string;
  targetUrl: string;
  userAgent: string | null;
  audioTracks: Array<{ index: number; lang: string | null }>;
  titleId: string;
  tmdbId: string | null;
  serverHost: string;
  itemType: string;
  fileExternalId: string;
  sessionId: string;
  expiresAt: string;
}): Promise<void> {
  const { db, runtimeConfig, userId, targetUrl, userAgent, audioTracks, titleId, tmdbId, serverHost, itemType, fileExternalId, sessionId, expiresAt } = opts;
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) return;
  const untagged = audioTracks.filter((t) => !t.lang && Number.isInteger(t.index)).slice(0, 5);
  if (!untagged.length) return;

  // Gateway byte-pipe token → derive the /detect-language base from the /raw URL. The gateway
  // extracts a WAV per track, runs whisper.cpp + a transcript detector locally (no paid API,
  // no relay round-trip), and returns the language. ENRICH-only.
  let detectBase: string;
  try {
    const pipe = await createBytePipeAccess(sessionId, userId, targetUrl, expiresAt, db, userAgent);
    detectBase = pipe.url.replace("/raw/", "/detect-language/");
  } catch (_) { return; }

  const byIndex = new Map(audioTracks.map((t) => [t.index, t]));
  let filled = 0;
  for (const t of untagged) {
    try {
      const res = await fetch(`${detectBase}?index=${t.index}&dur=20`, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) continue;
      const det = await res.json().catch(() => null) as JsonRecord | null;
      const lang = normalizeIsoLang(stringOrNull(det?.language));
      if (lang) { const entry = byIndex.get(t.index); if (entry) { entry.lang = lang; filled++; } }
    } catch (_) { /* best-effort per track */ }
  }
  const nowIso = new Date().toISOString();
  if (!filled) {
    // Mark attempted even on no-detection (silent/music/undetectable) so the backfill queue
    // advances instead of re-trying this file every tick. 30d retry window (see the candidate
    // query) lets a future detector improvement re-attempt it.
    try { await db.from("cloud_titles").update({ whisper_attempted_at: nowIso }).eq("user_id", userId).eq("id", titleId); } catch (_) { /* best-effort */ }
    return;
  }

  const enriched = audioTracks.map((t) => ({ index: t.index, lang: t.lang ?? null }));
  const codes = [...new Set(enriched.map((t) => t.lang).filter((l): l is string => Boolean(l)))].sort();
  try {
    await db.from("cloud_titles")
      .update({ audio_tracks: enriched, audio_languages: codes, audio_probed_at: nowIso, whisper_attempted_at: nowIso })
      .eq("user_id", userId).eq("id", titleId);
    if (codes.length && tmdbId && !/^(tt)?0+$/i.test(tmdbId)) {
      try { await db.rpc("merge_catalog_title_audio", { p_item_type: itemType, p_provider_tmdb_id: tmdbId, p_codes: codes }); } catch (_) { /* best-effort global mirror */ }
    }
  } catch (_) { /* best-effort persist */ }
  try { await shareFileTracks(db, serverHost, itemType, fileExternalId, enriched, [], true, false); } catch (_) { /* best-effort */ }
}

// Map an engine playback (source + item) to its cloud_titles row, so a probed audio
// map can be reused (skip the relay probe) and persisted (grid + next play instant).
// Movies map by the variant's external_id (= the played stream id). A series episode's
// stream id is the EPISODE, not the series, so the client passes the series id in the
// hint (audioSeriesId). Returns null when it can't resolve a row (then we just probe).
async function resolveEngineAudioTitleRow(
  db: SupabaseClient,
  userId: string,
  sourceId: string | null,
  itemType: string,
  itemId: string,
  hint: JsonRecord,
): Promise<EngineTitleRow | null> {
  if (!sourceId) return null;
  const externalId = itemType === "series"
    ? stringOr(hint.audioSeriesId ?? hint.audio_series_id ?? hint.seriesId ?? hint.series_id, "")
    : itemId;
  if (!externalId) return null;
  const { data: variant } = await db
    .from("cloud_title_variants")
    .select("title_id")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .eq("item_type", itemType)
    .eq("external_id", externalId)
    .limit(1)
    .maybeSingle();
  const titleId = variant ? stringOrNull((variant as JsonRecord).title_id) : null;
  if (!titleId) return null;
  const { data: row } = await db
    .from("cloud_titles")
    .select("id, audio_tracks, subtitle_tracks, subtitle_probed_at, provider_tmdb_id")
    .eq("user_id", userId)
    .eq("id", titleId)
    .maybeSingle();
  return row ? (row as EngineTitleRow) : null;
}

type EngineTitleRow = {
  id: string;
  audio_tracks: unknown;
  subtitle_tracks: unknown;
  subtitle_probed_at: string | null;
  provider_tmdb_id: string | null;
};

// Resolve a title's default variant → its provider file coordinates. Shared by the transcription
// trigger/benchmark, the async enqueue, and the user-facing subtitle delivery API.
async function resolveTitleVariant(
  db: SupabaseClient,
  userId: string,
  titleId: string,
): Promise<{ sourceId: string; externalId: string; itemType: string }> {
  const { data: trow } = await db.from("cloud_titles")
    .select("default_variant_id").eq("user_id", userId).eq("id", titleId).maybeSingle();
  const variantId = stringOr((trow as JsonRecord | null)?.default_variant_id, "");
  if (!variantId) throw new HttpError(404, "title or variant not found");
  const { data: variant } = await db.from("cloud_title_variants")
    .select("source_id, external_id, item_type").eq("id", variantId).maybeSingle();
  const vrec = variant as JsonRecord | null;
  const sourceId = stringOr(vrec?.source_id, ""), externalId = stringOr(vrec?.external_id, ""), itemType = stringOr(vrec?.item_type, "movie");
  if (!sourceId || !externalId) throw new HttpError(404, "variant not found");
  return { sourceId, externalId, itemType };
}

// Resolve the (sourceId, externalId, itemType) that key a subtitle cache row. Accepts EITHER the
// player's direct file coordinates (sourceId + externalId [+ itemType]) — what a catalog/gateway
// playback always has — OR a cloud_titles titleId (resolved via its default variant). Direct coords
// win, so the feature works even when the client doesn't hold a cloud_titles UUID.
async function resolveSubtitleTarget(
  db: SupabaseClient,
  userId: string,
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string },
): Promise<{ sourceId: string; externalId: string; itemType: string }> {
  const sourceId = stringOr(opts.sourceId, ""), externalId = stringOr(opts.externalId, "");
  if (sourceId && externalId) {
    const itemType = stringOr(opts.itemType, "movie") === "series" ? "series" : "movie";
    return { sourceId, externalId, itemType };
  }
  const titleId = stringOr(opts.titleId, "");
  if (!titleId) throw new HttpError(400, "titleId or (sourceId, externalId) is required");
  return resolveTitleVariant(db, userId, titleId);
}

// Resolve a variant's current playback URL (series episode vs movie target). null if unreachable.
async function resolveVariantUrl(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  externalId: string,
  itemType: string,
): Promise<string | null> {
  return itemType === "series"
    ? await resolveSeriesEpisodeUrl(sourceId, externalId, userId, db).catch(() => null)
    : ((await resolvePlaybackTarget(sourceId, itemType, externalId, userId, db).catch(() => null))?.targetUrl ?? null);
}

// Phase 3 (3a) ASYNC enqueue: kick off a background full-film transcription on the gateway and
// cache the VTT cross-user (keyed by providerKey + file) when it calls back. Returns immediately.
// 'ready' short-circuits straight from the cache. Shared by the service `transcribe-enqueue` mode
// and the user-authed POST generated-subtitle route, so the trigger logic lives in exactly one place.
async function transcribeEnqueue(
  db: SupabaseClient,
  userId: string,
  runtimeConfig: RuntimeConfig,
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string; index?: number; start?: number; dur?: number; force?: boolean; respectFailedCooldown?: boolean },
): Promise<JsonRecord> {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, opts);
  const tUrl = await resolveVariantUrl(db, userId, sourceId, externalId, itemType);
  if (!tUrl) throw new HttpError(422, `no playback target (source=${sourceId} ext=${externalId} type=${itemType})`);
  // Require a real provider key (no hostFromUrl fallback): the READ paths (getGeneratedSubtitle,
  // translateEnqueue) key on .key only, so a host-keyed write would be a zombie the player can never
  // read back. Fail loudly instead — all sources carry a providerKey today.
  const pkey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  // A blank provider key would collide every unkeyed title onto one cache row — refuse rather
  // than cross-contaminate transcripts. (Shouldn't happen: tUrl is a real, host-bearing URL.)
  if (!pkey) throw new HttpError(422, "no provider key for source");
  // Fast path: a ready transcript is served straight from the cache (no gateway pipe build).
  const { data: existing } = await db.from("catalog_generated_subtitles")
    .select("status, job_id, updated_at").eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", "transcript").eq("lang", "src").maybeSingle();
  const exrec = existing as JsonRecord | null;
  if (exrec?.status === "ready" && !opts.force) return { status: "ready", cached: true, jobId: exrec.job_id, providerKey: pkey };
  // Failed-cooldown: a title that just FAILED isn't re-attempted by the nightly whitelist for 24h, so a
  // permanently-broken title can't re-burn a whisper slot every night and starve fresh candidates.
  // On-demand (no flag) ignores this and retries immediately when the viewer asks.
  const FAILED_COOLDOWN_MS = 24 * 3600 * 1000;
  if (opts.respectFailedCooldown && exrec?.status === "failed" && !opts.force
      && Date.parse(stringOr(exrec.updated_at, "")) > Date.now() - FAILED_COOLDOWN_MS) {
    return { status: "failed", cached: true, cooldown: true, jobId: exrec.job_id, providerKey: pkey };
  }
  // Atomically claim the job. The RPC's ON CONFLICT ... WHERE makes "take over the row" a single
  // race-free decision, so two concurrent triggers can't both enqueue a duplicate transcription
  // onto the single-slot gateway: exactly one wins and proceeds, the loser reuses the live job.
  // A still-fresh 'processing' row (within the TTL) blocks takeover; a stale one is reclaimed.
  const PROCESSING_TTL_MS = 90 * 60 * 1000;
  const jobId = crypto.randomUUID();
  const { data: claim, error: claimErr } = await db.rpc("claim_generated_subtitle_job", {
    p_provider_key: pkey, p_item_type: itemType, p_external_id: externalId, p_kind: "transcript", p_lang: "src",
    p_new_job_id: jobId, p_processing_ttl_ms: PROCESSING_TTL_MS, p_force: opts.force === true,
  });
  if (claimErr) throwDb(claimErr, "enqueue claim failed");
  const claimRow = (Array.isArray(claim) ? claim[0] : claim) as JsonRecord | null;
  if (!claimRow?.won) {
    // Another trigger owns a fresh job (or it just turned ready) — reuse it, don't double-enqueue.
    return { status: stringOr(claimRow?.status, "processing"), cached: true, jobId: claimRow?.job_id ?? null, providerKey: pkey };
  }
  const idx = Number.isInteger(Number(opts.index)) ? Number(opts.index) : 1;
  const bStart = Math.max(0, Number(opts.start) || 0);
  const bDur = Math.max(0, Number(opts.dur) || 0); // 0 = whole film (prod); >0 = clip (pipeline test)
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const pipe = await createBytePipeAccess("transcribe-job", userId, tUrl, exp, db, null);
  const cbUrl = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/norva-playback/transcribe-callback`;
  const asyncUrl = `${pipe.url.replace("/raw/", "/transcribe-async/")}?index=${idx}&jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&start=${bStart}&dur=${bDur}`;
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const gw = await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (_) { gwStatus = 0; }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    return { status: "error", jobId, providerKey: pkey, gatewayStatus: gwStatus, gateway: gwBody };
  }
  return { status: "processing", jobId, providerKey: pkey, gateway: gwBody };
}

// Phase 4: OCR of a PGS (Blu-ray) image-subtitle track → WebVTT, cached cross-user
// (kind='ocr', lang=<track language>). Mirrors transcribeEnqueue: claim the job, then POST to the
// gateway /ocr-async, which extracts the image-sub track to a .sup and runs tesseract per cue; the
// shared transcribe-callback writes the VTT back by job_id. `index` = the image-sub stream index to
// OCR; `lang` = that track's language (it IS the cache key, so two image tracks of different
// languages cache independently, and a 2-letter hint maps to a tesseract model for accuracy).
// Touches the provider (one sub-stream read) → the caller live-guards it (user_multi_ip).
const TESS_LANG_MAP: Record<string, string> = {
  en: "eng", fr: "fra", es: "spa", de: "deu", it: "ita", pt: "por", nl: "nld",
};
async function ocrEnqueue(
  db: SupabaseClient,
  userId: string,
  runtimeConfig: RuntimeConfig,
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string; index?: number; lang?: string; fmt?: string; force?: boolean },
): Promise<JsonRecord> {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
  const idx = Number(opts.index);
  if (!Number.isInteger(idx) || idx < 0) throw new HttpError(400, "a valid subtitle stream index is required for OCR");
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, opts);
  const tUrl = await resolveVariantUrl(db, userId, sourceId, externalId, itemType);
  if (!tUrl) throw new HttpError(422, `no playback target (source=${sourceId} ext=${externalId} type=${itemType})`);
  // Require a real provider key (no hostFromUrl fallback): the READ paths (getGeneratedSubtitle,
  // translateEnqueue) key on .key only, so a host-keyed write would be a zombie the player can never
  // read back. Fail loudly instead — all sources carry a providerKey today.
  const pkey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  if (!pkey) throw new HttpError(422, "no provider key for source");
  const lang = (stringOr(opts.lang, "").toLowerCase().match(/^[a-z]{2,3}$/)?.[0]) || "und";
  // Per-track cache key: a title can have several image tracks of the same language (incl. 'und'),
  // so distinguish them by stream index — `<lang>#<idx>` — while keeping `lang` bare for tesseract +
  // the player's <track srclang>. getGeneratedSubtitle forms the identical key from its ?index=.
  const cacheLang = `${lang}#${idx}`;
  // Fast path: a ready OCR track is served straight from the cache (no gateway pipe build).
  const { data: existing } = await db.from("catalog_generated_subtitles")
    .select("status, job_id").eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", "ocr").eq("lang", cacheLang).maybeSingle();
  const exrec = existing as JsonRecord | null;
  if (exrec?.status === "ready" && !opts.force) return { status: "ready", cached: true, jobId: exrec.job_id, providerKey: pkey, kind: "ocr", lang };
  const PROCESSING_TTL_MS = 90 * 60 * 1000;
  const jobId = crypto.randomUUID();
  const { data: claim, error: claimErr } = await db.rpc("claim_generated_subtitle_job", {
    p_provider_key: pkey, p_item_type: itemType, p_external_id: externalId, p_kind: "ocr", p_lang: cacheLang,
    p_new_job_id: jobId, p_processing_ttl_ms: PROCESSING_TTL_MS, p_force: opts.force === true,
  });
  if (claimErr) throwDb(claimErr, "ocr enqueue claim failed");
  const claimRow = (Array.isArray(claim) ? claim[0] : claim) as JsonRecord | null;
  if (!claimRow?.won) {
    return { status: stringOr(claimRow?.status, "processing"), cached: true, jobId: claimRow?.job_id ?? null, providerKey: pkey, kind: "ocr", lang };
  }
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const pipe = await createBytePipeAccess("ocr-job", userId, tUrl, exp, db, null);
  const cbUrl = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/norva-playback/transcribe-callback`;
  const tessLang = TESS_LANG_MAP[lang] || "";
  const fmt = ["pgs", "vobsub", "dvb"].includes(stringOr(opts.fmt, "")) ? stringOr(opts.fmt, "") : "pgs";
  const asyncUrl = `${pipe.url.replace("/raw/", "/ocr-async/")}?index=${idx}&jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&fmt=${fmt}${tessLang ? `&lang=${tessLang}` : ""}`;
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const gw = await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (_) { gwStatus = 0; }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    return { status: "error", jobId, providerKey: pkey, kind: "ocr", lang, gatewayStatus: gwStatus, gateway: gwBody };
  }
  return { status: "processing", jobId, providerKey: pkey, kind: "ocr", lang, gateway: gwBody };
}

// Phase 3 (3b) ASYNC translation: translate a cached transcript into a target language on the gateway
// (Argos / CTranslate2) and cache the result cross-user (kind='translation', lang=target). Reuses the
// transcript claim RPC + transcribe-callback — translation is pure text on the gateway (NO provider
// connection, no audio), so it never contends with playback. Requires the source transcript to be
// ready first; returns {status:'transcript-required'} otherwise so the client can produce it (3a).
async function translateEnqueue(
  db: SupabaseClient,
  userId: string,
  runtimeConfig: RuntimeConfig,
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string; targetLang: string; force?: boolean },
): Promise<JsonRecord> {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
  const target = stringOr(opts.targetLang, "").toLowerCase();
  if (!/^[a-z]{2,3}$/.test(target)) throw new HttpError(400, "invalid target lang");
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, opts);
  // Provider key from the stored source row (cached DB lookup, NO provider round-trip — translation
  // works purely off the cached transcript).
  const pkey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  if (!pkey) throw new HttpError(422, "no provider key for source");

  const baseSel = db.from("catalog_generated_subtitles").select("status, vtt, source_lang, job_id")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId);
  // A ready translation short-circuits straight from the cache.
  const { data: tr } = await baseSel.eq("kind", "translation").eq("lang", target).maybeSingle();
  const trRec = tr as JsonRecord | null;
  if (trRec?.status === "ready" && !opts.force) {
    return { status: "ready", cached: true, jobId: trRec.job_id, providerKey: pkey, kind: "translation", lang: target };
  }

  // Need the SOURCE transcript (3a) before we can translate it.
  const { data: src } = await db.from("catalog_generated_subtitles").select("status, vtt, source_lang, job_id")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", "transcript").eq("lang", "src").maybeSingle();
  const srcRec = src as JsonRecord | null;
  if (!srcRec || srcRec.status !== "ready") {
    return { status: "transcript-required", providerKey: pkey, kind: "translation", lang: target, transcriptStatus: srcRec?.status ?? "none" };
  }
  const sourceLang = (stringOr(srcRec.source_lang, "") || "en").toLowerCase();
  if (sourceLang === target) {
    // The transcript is already in the requested language — serve it directly, no translation needed.
    return { status: "ready", cached: true, sameLang: true, kind: "transcript", lang: "src", providerKey: pkey };
  }
  const sourceVtt = stringOr(srcRec.vtt, "");
  if (!sourceVtt) return { status: "error", error: "empty source transcript", providerKey: pkey, kind: "translation", lang: target };

  // Atomically claim the translation job (separate cache row, kind=translation + lang=target).
  const PROCESSING_TTL_MS = 30 * 60 * 1000; // translation is fast (~min); a stale lock clears quickly
  const jobId = crypto.randomUUID();
  const { data: claim, error: claimErr } = await db.rpc("claim_generated_subtitle_job", {
    p_provider_key: pkey, p_item_type: itemType, p_external_id: externalId, p_kind: "translation", p_lang: target,
    p_new_job_id: jobId, p_processing_ttl_ms: PROCESSING_TTL_MS, p_force: opts.force === true,
  });
  if (claimErr) throwDb(claimErr, "translation claim failed");
  const claimRow = (Array.isArray(claim) ? claim[0] : claim) as JsonRecord | null;
  if (!claimRow?.won) {
    return { status: stringOr(claimRow?.status, "processing"), cached: true, jobId: claimRow?.job_id ?? null, providerKey: pkey, kind: "translation", lang: target };
  }

  const cbUrl = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/norva-playback/transcribe-callback`;
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const gw = await fetch(`${runtimeConfig.mediaGatewayUrl}/translate-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
      body: JSON.stringify({ jobId, callback: cbUrl, source: sourceLang, target, vtt: sourceVtt }),
      signal: AbortSignal.timeout(20000),
    });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (_) { gwStatus = 0; }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `translate gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    return { status: "error", jobId, providerKey: pkey, gatewayStatus: gwStatus, gateway: gwBody, kind: "translation", lang: target };
  }
  return { status: "processing", jobId, providerKey: pkey, kind: "translation", lang: target };
}

// Available translation TARGET languages (the gateway's installed Argos set). Cached briefly so the
// captions menu can list them without a per-open round-trip. Empty when translation isn't configured.
let translateTargetsCache: { value: string[]; expiresAt: number } | null = null;
async function getTranslateTargets(runtimeConfig: RuntimeConfig): Promise<string[]> {
  if (translateTargetsCache && translateTargetsCache.expiresAt > Date.now()) return translateTargetsCache.value;
  let value: string[] = [];
  if (runtimeConfig.mediaGatewayUrl) {
    try {
      const r = await fetch(`${runtimeConfig.mediaGatewayUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => null) as JsonRecord | null;
      if (j && Array.isArray(j.translateTargets)) value = (j.translateTargets as unknown[]).map((x) => String(x)).filter((x) => /^[a-z]{2,3}$/.test(x));
    } catch (_) { /* gateway down → empty list */ }
  }
  translateTargetsCache = { value, expiresAt: Date.now() + 5 * 60 * 1000 };
  return value;
}

// Phase 3 (3a) user-facing read: resolve a title to its cross-user transcript-cache row and return
// the delivery state. Status 'ready' carries the VTT body (the player attaches it as a text track);
// 'processing'/'failed'/'none' tell the client to poll, retry, or trigger. providerKey-scoped, so
// one transcription serves every user of that panel. lang defaults to 'src' (whisper transcript).
async function getGeneratedSubtitle(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const url = new URL(req.url);
  const rawKind = stringOr(url.searchParams.get("kind"), "transcript");
  const kind = rawKind === "translation" ? "translation" : (rawKind === "ocr" ? "ocr" : "transcript");
  // ocr/translation are per-track/per-target → lang is the cache key; transcript is always 'src'.
  const lang = kind === "transcript"
    ? "src"
    : stringOr(url.searchParams.get("lang"), kind === "ocr" ? "und" : "");
  if (kind === "translation" && !lang) throw new HttpError(400, "lang is required for translation");
  // OCR is per image-sub TRACK: a title can carry several image tracks of the same language (incl.
  // untagged 'und'), so the cache row is keyed by `<lang>#<streamIndex>` to keep them distinct. The
  // returned `lang` stays the bare code (for the player's <track srclang> + display).
  const ocrIdx = url.searchParams.get("index");
  const cacheLang = (kind === "ocr" && ocrIdx !== null && /^\d+$/.test(ocrIdx)) ? `${lang}#${ocrIdx}` : lang;
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, {
    titleId: stringOr(url.searchParams.get("titleId"), ""),
    sourceId: stringOr(url.searchParams.get("sourceId"), ""),
    externalId: stringOr(url.searchParams.get("externalId"), ""),
    itemType: stringOr(url.searchParams.get("itemType"), ""),
  });
  const ident = await resolveSourceIdentity(sourceId, userId, db);
  const pkey = ident.key;
  if (!pkey) return { status: "none", providerKey: null };
  let { data: row } = await db.from("catalog_generated_subtitles")
    .select("status, vtt, source_lang, segments, audio_sec, job_id, updated_at")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", kind).eq("lang", cacheLang).maybeSingle();
  // Transition fallback: a VTT generated before the identity re-key still lives under the raw
  // providerKey until the cache backfill moves it — serve it instead of regenerating.
  if (!row && ident.fingerprint && ident.fingerprint !== pkey) {
    ({ data: row } = await db.from("catalog_generated_subtitles")
      .select("status, vtt, source_lang, segments, audio_sec, job_id, updated_at")
      .eq("provider_key", ident.fingerprint).eq("item_type", itemType).eq("external_id", externalId)
      .eq("kind", kind).eq("lang", cacheLang).maybeSingle());
  }
  const rec = row as JsonRecord | null;
  if (!rec) return { status: "none", providerKey: pkey, kind, lang };
  const status = stringOr(rec.status, "none");
  return {
    status, kind, lang, providerKey: pkey, jobId: rec.job_id ?? null,
    sourceLang: rec.source_lang ?? null, segments: rec.segments ?? null, audioSec: rec.audio_sec ?? null,
    updatedAt: rec.updated_at ?? null,
    vtt: status === "ready" ? stringOr(rec.vtt, "") : null,
  };
}

// Phase 3 (3a) user-facing trigger: a viewer asks for AI subtitles on a title with no usable subs.
// Enqueues a full-film transcription (dur 0) — cross-user cached, so the first viewer pays the cost
// and the rest get it free. Returns immediately; the client polls GET generated-subtitle.
async function postGeneratedSubtitle(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  // Phase 4: an OCR request (kind='ocr') routes to the tesseract path for an image-sub track.
  if (stringOr(body.kind, "transcript") === "ocr") {
    return await ocrEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""), sourceId: stringOr(body.sourceId, ""), externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""),
      index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
      lang: stringOr(body.lang, ""), fmt: stringOr(body.fmt, ""), force: body.force === true,
    });
  }
  // Phase 3b: a translation request (kind='translation' or a target lang) routes to the Argos path.
  const target = stringOr(body.targetLang, "").toLowerCase();
  if (stringOr(body.kind, "transcript") === "translation" || (target && target !== "src")) {
    return await translateEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""), sourceId: stringOr(body.sourceId, ""), externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""), targetLang: target, force: body.force === true,
    });
  }
  const r = await transcribeEnqueue(db, userId, runtimeConfig, {
    titleId: stringOr(body.titleId, ""),
    sourceId: stringOr(body.sourceId, ""),
    externalId: stringOr(body.externalId, ""),
    itemType: stringOr(body.itemType, ""),
    index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
    force: body.force === true,
    // dur 0 = whole film; user triggers never clip (clipping is a pipeline-test affordance only).
  });
  return { kind: "transcript", lang: "src", ...r };
}

// Phase 3 (3a): per-viewer "email me when it's ready" opt-in for a pending AI transcription.
// The transcript cache (catalog_generated_subtitles) is CROSS-USER, so the notification preference
// lives in its own per-(user, file) table. Deliberately cheap: it resolves the provider key from
// the stored source row (a cached DB lookup — NO provider round-trip), so toggling this while a
// stream is live can never open a 2nd provider connection (the user_multi_ip trap). Reversible:
// enabled=false deletes the subscription. transcribe-callback fans these out when the job lands.
async function setGeneratedSubtitleNotify(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, {
    titleId: stringOr(body.titleId, ""),
    sourceId: stringOr(body.sourceId, ""),
    externalId: stringOr(body.externalId, ""),
    itemType: stringOr(body.itemType, ""),
  });
  const kind = stringOr(body.kind, "transcript") === "translation" ? "translation" : "transcript";
  const lang = stringOr(body.lang, kind === "translation" ? "" : "src");
  if (kind === "translation" && !lang) throw new HttpError(400, "lang is required for translation");
  // Same provider key the enqueue/cache uses — when present it's the stored providerKey, so the
  // callback match is exact. No stored key → we can't reliably match the cross-user row at
  // callback time, so report that and let the client keep the toggle purely local.
  const pkey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  if (!pkey) return { ok: false, enabled: false, reason: "no provider key for source" };

  const enabled = body.enabled !== false; // default true
  if (!enabled) {
    await db.from("catalog_generated_subtitle_notifications").delete()
      .eq("user_id", userId).eq("provider_key", pkey).eq("item_type", itemType)
      .eq("external_id", externalId).eq("kind", kind).eq("lang", lang);
    return { ok: true, enabled: false };
  }

  let email = "";
  try { const { data } = await db.auth.admin.getUserById(userId); email = stringOr(data?.user?.email, ""); }
  catch (_) { /* fall through to the no-email branch */ }
  if (!email) return { ok: false, enabled: false, reason: "no email on account" };

  const nowIso = new Date().toISOString();
  const { error } = await db.from("catalog_generated_subtitle_notifications").upsert({
    user_id: userId, email, provider_key: pkey, item_type: itemType, external_id: externalId,
    kind, lang, title_label: stringOr(body.titleLabel, "").slice(0, 300) || null,
    status: "pending", created_at: nowIso, sent_at: null,
  }, { onConflict: "user_id,provider_key,item_type,external_id,kind,lang" });
  if (error) throwDb(error, "notify registration failed");
  return { ok: true, enabled: true };
}

// Branded, email-client-safe "your subtitles are ready" HTML (tables + inline styles, dark theme),
// mirroring norva-auth-email so the two transactional senders look like one product.
function subtitleReadyEmailHtml(titleLabel: string, siteUrl: string): string {
  const title = (titleLabel || "your film").replace(/[<>]/g, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px;text-align:center">
          <img src="https://norva.tv/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">
          <div style="color:#ffffff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;margin-top:10px">Norva</div>
        </td></tr>
        <tr><td style="padding:18px 32px 6px;text-align:center">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">✨ Your AI subtitles are ready</h1>
        </td></tr>
        <tr><td style="padding:10px 32px 22px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
          We finished transcribing <strong style="color:#dbe3f4">${title}</strong>. Re-open the film on Norva and pick <strong style="color:#dbe3f4">✨ AI subtitles</strong> in the captions menu to watch with them.
        </td></tr>
        <tr><td align="center" style="padding:8px 0 28px">
          <a href="${siteUrl}" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">Open Norva</a>
        </td></tr>
        <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          You're getting this because you asked to be notified when these subtitles finished. They're cached, so they'll load instantly next time.
        </td></tr>
      </table>
      <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>
    </td></tr>
  </table>
</body></html>`;
}

// Send one "subtitles ready" email through Resend (same key/sender as norva-auth-email; secrets are
// project-wide). Returns true on a 2xx; never throws (a send failure must not break the callback).
async function sendSubtitleReadyEmail(to: string, titleLabel: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
  const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://norva.tv").replace(/\/+$/, "");
  if (!key || !to) return false;
  const subject = `Your AI subtitles for “${titleLabel || "your film"}” are ready — Norva`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html: subtitleReadyEmailHtml(titleLabel, site) }),
    });
    if (!res.ok) { console.error("[norva-playback] subtitle-ready email failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("[norva-playback] subtitle-ready email error", String(e)); return false; }
}

// Fan out pending "email me" subscriptions for a transcript that just finished. Ready WITH speech
// → email each subscriber and mark 'sent'. Ready but EMPTY (no dialogue) → mark 'skipped' (there's
// nothing to show, so no email). Failed → mark 'failed' (silent — we don't nag on failure).
async function dispatchSubtitleNotifications(db: SupabaseClient, row: JsonRecord | null): Promise<void> {
  if (!row) return;
  const status = stringOr(row.status, "");
  if (status !== "ready" && status !== "failed") return;
  const providerKey = stringOr(row.provider_key, ""), itemType = stringOr(row.item_type, "");
  const externalId = stringOr(row.external_id, ""), kind = stringOr(row.kind, "transcript"), lang = stringOr(row.lang, "src");
  if (!providerKey || !externalId) return;
  const { data: subs } = await db.from("catalog_generated_subtitle_notifications")
    .select("id, email, title_label")
    .eq("provider_key", providerKey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", kind).eq("lang", lang).eq("status", "pending");
  const rows = (subs ?? []) as JsonRecord[];
  if (!rows.length) return;
  const nowIso = new Date().toISOString();
  const hasSpeech = status === "ready" && Number(row.segments ?? 0) > 0;
  if (!hasSpeech) {
    await db.from("catalog_generated_subtitle_notifications")
      .update({ status: status === "ready" ? "skipped" : "failed", sent_at: nowIso })
      .in("id", rows.map((s) => String(s.id)));
    return;
  }
  for (const s of rows) {
    const ok = await sendSubtitleReadyEmail(stringOr(s.email, ""), stringOr(s.title_label, ""));
    await db.from("catalog_generated_subtitle_notifications")
      .update({ status: ok ? "sent" : "failed", sent_at: nowIso }).eq("id", String(s.id));
  }
}

// Phase 3 (3a): the gateway calls this back when an async transcription finishes (auth = the shared
// gateway token). Writes the VTT into the cross-user cache by job_id → every user of that panel
// gets the subtitles. Best-effort idempotent (a late/duplicate callback just re-writes the row).
async function runTranscribeCallback(req: Request, db: SupabaseClient) {
  const runtimeConfig = await getRuntimeConfig(db);
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!runtimeConfig.mediaGatewayToken || provided !== runtimeConfig.mediaGatewayToken) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const jobId = stringOr(body.jobId, "");
  if (!jobId) throw new HttpError(400, "jobId is required");
  const nowIso = new Date().toISOString();
  const patch: JsonRecord = body.ok === true
    ? { status: "ready", vtt: stringOr(body.vtt, ""), source_lang: stringOrNull(body.sourceLang),
        audio_sec: Number.isFinite(Number(body.audioSec)) ? Number(body.audioSec) : null,
        segments: Number.isFinite(Number(body.segments)) ? Number(body.segments) : null, error: null, updated_at: nowIso }
    : { status: "failed", error: stringOr(body.error, "unknown").slice(0, 300), updated_at: nowIso };
  const { data: updated, error } = await db.from("catalog_generated_subtitles").update(patch).eq("job_id", jobId)
    .select("provider_key, item_type, external_id, kind, lang, status, segments").maybeSingle();
  if (error) throwDb(error, "transcribe callback update failed");
  // Email anyone who opted in for this transcript (best-effort: a send/dispatch failure here must
  // not fail the callback, or the gateway will think the result was lost and the row stays stuck).
  try { await dispatchSubtitleNotifications(db, updated as JsonRecord | null); }
  catch (e) { console.error("[norva-playback] notify dispatch failed", String(e)); }
  return { ok: true, jobId, status: patch.status };
}

// True when the user is actively watching right now: a fresh playback event (the player emits
// heartbeats during playback) or a still-valid 'ready' session (covers the gap before the first
// event). Autonomous provider probes defer while this holds — a live stream egresses from the
// gateway's residential proxy IP, a relay probe from Cloudflare, and the provider's single-IP panel
// ("user_multi_ip") then 429s one of them. Enrichment resumes a few minutes after playback stops.
async function userHasLiveSession(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  const sinceIso = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const { data: ev } = await db.from("cloud_playback_events")
    .select("id").eq("user_id", userId).gt("created_at", sinceIso).limit(1);
  if (ev && ev.length) return true;
  const { data: sess } = await db.from("cloud_playback_sessions")
    .select("id").eq("user_id", userId).eq("status", "ready").gt("expires_at", new Date().toISOString()).limit(1);
  return Boolean(sess && sess.length);
}

// Service-gated maintenance backfill of cloud_titles.audio_languages via the
// relay's get_vod_info (the only path that reaches the provider — Deno egress is
// IP-blocked). Resolves the DEFAULT audio-track language per title: a VO file's
// single track is its real original language; a Multi file's primary track. A
// header-probe for Multi's secondary tracks is a separate step. Resumable by id
// cursor; best-effort per title; bounded concurrency.
async function runAudioBackfill(req: Request, db: SupabaseClient) {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));

  // Global kill switch (admin feature flag): when enrichment_paused is ON, skip all backfill work so
  // NO provider connection is opened this tick — an ops pause (incident, provider protection). One
  // cheap flag read; FAIL-OPEN (a transient read error keeps enriching rather than silently halting).
  try {
    const { data: paused } = await db.rpc("feature_flag", { p_key: "enrichment_paused" });
    if (paused === true) return { paused: true, skipped: "enrichment_paused" };
  } catch (_) { /* fail-open: keep enriching if the flag can't be read */ }

  // One dimension per call by default. With fallthrough:true (set on the DAYTIME audio-films
  // crons), once the primary dimension runs out of candidates we DRAIN the next unfinished
  // dimension for the same provider — so a finished daytime window accelerates the night-only
  // dimensions (series / subtitles / whisper) instead of idling. `processed` is the candidate
  // count, so processed===0 means "this dimension is done" → advance to the next.
  // SLOT-SAFE: dimensions run STRICTLY sequentially (one provider access at a time); each keeps
  // its own userHasLiveSession() guard; the chain STOPS the instant a user is live (skipped) so
  // it can never open a 2nd provider connection next to a live stream (the user_multi_ip trap).
  if (body.fallthrough !== true) return await runOneDimension(db, body);
  const fuId = stringOr(body.userId, "");
  // Carry the primary cron's panel scope (sourceId) into EVERY drained dimension. Without this the
  // chain would fall back to account-wide draining and could open a provider connection on ANOTHER
  // panel's host — re-introducing the user_multi_ip collision the per-panel split exists to avoid.
  const fuScope = stringOr(body.sourceId, "") ? { sourceId: stringOr(body.sourceId, "") } : {};
  const chain: JsonRecord[] = [
    body,                                                                   // primary (already carries sourceId)
    { userId: fuId, ...fuScope, type: "series", mode: "probe", limit: 15, concurrency: 1 },
    { userId: fuId, ...fuScope, type: "movie", target: "subtitle", limit: 10, concurrency: 1 },
    { userId: fuId, ...fuScope, type: "series", target: "subtitle", limit: 10, concurrency: 1 },
    { userId: fuId, ...fuScope, type: "movie", mode: "whisper", limit: 4, concurrency: 1 },
    { userId: fuId, ...fuScope, type: "series", mode: "whisper", limit: 4, concurrency: 1 },
  ];
  const tried: JsonRecord[] = [];
  for (const dim of chain) {
    const r = (await runOneDimension(db, dim)) as JsonRecord;
    const processed = Number(r?.processed ?? 0);
    tried.push({ type: stringOr(dim.type, "?"), kind: dim.target ? "subtitle" : stringOr(dim.mode, "vod"), processed, skipped: stringOrNull(r?.skipped) });
    if (r?.skipped) return { mode: "fallthrough", stoppedAt: "live-session", tried };   // user live → stop the whole chain
    if (processed > 0) return { mode: "fallthrough", workedOn: tried[tried.length - 1], tried, result: r };
  }
  return { mode: "fallthrough", exhausted: true, tried };
}

async function runOneDimension(db: SupabaseClient, body: JsonRecord) {
  const userId = stringOr(body.userId, "");
  const itemType = stringOr(body.type, "movie") === "series" ? "series" : "movie";
  const limit = Math.max(1, Math.min(300, Number(body.limit) || 100));
  const concurrency = Math.max(1, Math.min(12, Number(body.concurrency) || 6));
  const afterId = stringOr(body.afterId, "");
  // Optional per-panel scope. A driving account can hold SEVERAL distinct provider hosts (e.g.
  // AÎRO's 5 panels). With sourceId set, every candidate query is scoped to that one source so
  // each host gets its own cron/connection slot and they enrich in PARALLEL — without raising any
  // single host's per-connection load (distinct hosts → no user_multi_ip). Empty = account-wide.
  const sourceId = stringOr(body.sourceId, "");
  // mode 'vod' = get_vod_info default track (cheap); 'probe' = container header-probe
  // for ALL tracks (heavier — Range-reads the moov/Tracks). requireTag narrows to a
  // version tag (e.g. 'multi') so the heavy probe only runs where it helps.
  // target='subtitle' = sweep titles missing a subtitle probe (forces the header-parse,
  // which fills subtitle_tracks AND audio_tracks in one relay call).
  const subtitleTarget = stringOr(body.target, "") === "subtitle";
  const mode = (stringOr(body.mode, "vod") === "probe" || subtitleTarget) ? "probe" : "vod";
  // requireTag = comma-list of version tags (OR). Narrows the heavy probe to where the
  // real audio language is unknown & valuable: 'multi' (many tracks), 'vostfr'/'vo'
  // (original audio — JP for anime, etc., not encoded in the tag). Empty = all unresolved.
  const requireTags = stringOr(body.requireTag, "").toLowerCase().split(",").map((t) => t.trim()).filter((t) => /^[a-z_]{1,12}$/.test(t));
  if (!userId) throw new HttpError(400, "Missing userId");

  // mode 'catalog' = fill this user's unresolved audio_languages from the GLOBAL cache
  // (no provider hit). The scale dedup: a title probed by ANY user is shared to all
  // others for free here, instead of re-probing the same provider file once per user.
  if (stringOr(body.mode, "") === "catalog") {
    const { data: filled, error: fillErr } = await db.rpc("fill_user_audio_from_catalog", {
      p_user_id: userId,
      p_item_type: itemType,
      p_limit: Math.max(1, Math.min(20000, Number(body.limit) || 5000)),
    });
    if (fillErr) throwDb(fillErr, "catalog fill failed");
    return { mode: "catalog", filled: Number(filled ?? 0) };
  }

  const runtimeConfig = await getRuntimeConfig(db);
  // The transcribe/ocr/whisper modes talk ONLY to the media gateway (they re-check it themselves),
  // never the relay — so they must not be gated on the relay being configured. Only the relay-using
  // modes (probe / vod-info capture, sync transcribe) require it.
  const gatewayOnlyMode = ["transcribe", "transcribe-enqueue", "ocr-enqueue", "transcribe-whitelist", "whisper"]
    .includes(stringOr(body.mode, ""));
  if (!gatewayOnlyMode && (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret)) {
    throw new HttpError(503, "Norva Relay is not configured");
  }

  // Targeted ordered-track capture (on-demand): populate cloud_titles.audio_tracks for
  // SPECIFIC titles now, instead of waiting for them to be re-played/re-crawled. The
  // player serves this map directly, so a MULTI title shows real per-track language names
  // with ZERO playback-time probe.
  const orderedIds = Array.isArray((body as JsonRecord).orderedTitleIds)
    ? ((body as JsonRecord).orderedTitleIds as unknown[]).filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200)
    : null;
  if (orderedIds && orderedIds.length) {
    const { data: ts } = await db.from("cloud_titles")
      .select("id, default_variant_id").eq("user_id", userId).in("id", orderedIds);
    const vIds = (ts ?? []).map((t) => stringOrNull((t as JsonRecord).default_variant_id)).filter(Boolean) as string[];
    const vById = new Map<string, JsonRecord>();
    if (vIds.length) {
      const { data: vs } = await db.from("cloud_title_variants").select("id, source_id, external_id, item_type").in("id", vIds);
      for (const v of vs ?? []) vById.set(String(v.id), v as JsonRecord);
    }
    let stored = 0;
    for (const t of ts ?? []) {
      const variant = vById.get(String((t as JsonRecord).default_variant_id));
      if (!variant) continue;
      try { if (await persistOrderedAudioForTitle(db, runtimeConfig, userId, String((t as JsonRecord).id), variant, itemType)) stored += 1; }
      catch (_) { /* best-effort per title */ }
    }
    return { mode: "ordered", requested: orderedIds.length, found: (ts ?? []).length, stored };
  }

  // Diagnostic (ops): probe SPECIFIC titles and return, per title, the provider's
  // get_vod_info DEFAULT-track language AND the full header-probe languages — to see
  // whether a title's audio is detectable at all vs genuinely 'und' in the container.
  const diagIds = Array.isArray((body as JsonRecord).titleIds)
    ? ((body as JsonRecord).titleIds as unknown[]).filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 60)
    : null;
  if (diagIds && diagIds.length) {
    const { data: dt } = await db.from("cloud_titles")
      .select("id, title, default_variant_id, version_languages, audio_languages")
      .eq("user_id", userId).in("id", diagIds);
    const dvIds = (dt ?? []).map((t) => t.default_variant_id).filter(Boolean) as string[];
    const dvById = new Map<string, JsonRecord>();
    if (dvIds.length) {
      const { data: dvs } = await db.from("cloud_title_variants").select("id, source_id, external_id, item_type").in("id", dvIds);
      for (const v of dvs ?? []) dvById.set(String(v.id), v as JsonRecord);
    }
    const diag: JsonRecord[] = [];
    for (const t of dt ?? []) {
      const variant = t.default_variant_id ? dvById.get(String(t.default_variant_id)) : null;
      if (!variant) { diag.push({ title: t.title, error: "no variant" }); continue; }
      const sid = stringOr(variant.source_id, ""), ext = stringOr(variant.external_id, ""), vit = stringOr(variant.item_type, "movie");
      const tgt = await resolvePlaybackTarget(sid, vit, ext, userId, db).catch(() => null);
      const url = vit === "series" ? await resolveSeriesEpisodeUrl(sid, ext, userId, db).catch(() => null) : (tgt?.targetUrl ?? null);
      if (!url) { diag.push({ title: t.title, error: "no target" }); continue; }
      const payload = JSON.stringify({ v: 1, sid: "audio-diag", uid: userId, url, exp: Math.floor(Date.now() / 1000) + 120 });
      const token = `${base64Url(encoder.encode(payload))}.${await hmacBase64Url(runtimeConfig.relayTokenSecret, payload)}`;
      const vod = await fetch(`${runtimeConfig.relayBaseUrl}/vod-info/${token}`, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null);
      const probe = await fetch(`${runtimeConfig.relayBaseUrl}/probe-audio/${token}`, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null);
      const vodTracks = vod && Array.isArray(vod.audioTracks) ? (vod.audioTracks as JsonRecord[]).map((x) => stringOrNull(x.language)) : [];
      diag.push({
        title: String(t.title).slice(0, 50),
        version_tags: t.version_languages,
        vod_default_raw: vodTracks,
        vod_default_norm: vodTracks.map((l) => normalizeIsoLang(l)).filter(Boolean),
        probe_languages: probe && Array.isArray(probe.audioLanguages) ? probe.audioLanguages : [],
      });
    }
    return { diagnostic: diag };
  }

  // Phase 3 (3a) transcription trigger / benchmark: build the byte-pipe token (the edge holds the
  // gateway token) and call /transcribe, returning the gateway timings. rtf = whisperMs/audioSec
  // decides on-demand viability. titleId + optional index/start/dur (dur 0 = whole film). No cache
  // yet — this is the de-risking probe before the full 3a/3b/3c build.
  if (stringOr(body.mode, "") === "transcribe") {
    if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
    const titleId = stringOr(body.titleId, "");
    if (!titleId) throw new HttpError(400, "titleId is required");
    const { data: trow } = await db.from("cloud_titles")
      .select("default_variant_id").eq("user_id", userId).eq("id", titleId).maybeSingle();
    const variantId = stringOr((trow as JsonRecord | null)?.default_variant_id, "");
    if (!variantId) throw new HttpError(404, "title or variant not found");
    const { data: variant } = await db.from("cloud_title_variants")
      .select("source_id, external_id, item_type").eq("id", variantId).maybeSingle();
    const vrec = variant as JsonRecord | null;
    const vSource = stringOr(vrec?.source_id, ""), vExternal = stringOr(vrec?.external_id, ""), vItem = stringOr(vrec?.item_type, "movie");
    if (!vSource || !vExternal) throw new HttpError(404, "variant not found");
    const tUrl = vItem === "series"
      ? await resolveSeriesEpisodeUrl(vSource, vExternal, userId, db).catch(() => null)
      : ((await resolvePlaybackTarget(vSource, vItem, vExternal, userId, db).catch(() => null))?.targetUrl ?? null);
    if (!tUrl) throw new HttpError(422, "no playback target");
    const idx = Number.isInteger(Number(body.index)) ? Number(body.index) : 1;
    const start = Math.max(0, Number(body.start) || 0);
    const dur = Math.max(0, Number(body.dur) || 0);
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const pipe = await createBytePipeAccess("transcribe-bench", userId, tUrl, exp, db, null);
    const base = pipe.url.replace("/raw/", "/transcribe/");
    const tRes = await fetch(`${base}?index=${idx}&start=${start}&dur=${dur}`, { signal: AbortSignal.timeout(25 * 60 * 1000) });
    const tBody = await tRes.json().catch(() => null) as JsonRecord | null;
    const vtt = stringOr(tBody?.vtt, "");
    return {
      mode: "transcribe", ok: tRes.ok, status: tRes.status,
      language: tBody?.language ?? null, audioSec: tBody?.audioSec ?? null,
      extractMs: tBody?.extractMs ?? null, whisperMs: tBody?.whisperMs ?? null,
      rtf: tBody?.rtf ?? null, segments: tBody?.segments ?? null,
      vttChars: vtt.length, vttSample: vtt.slice(0, 500),
      error: tRes.ok ? null : (tBody?.error ?? null),
    };
  }

  // Phase 3 (3a) ASYNC enqueue (service path): kick a background full-film transcription on the
  // gateway and cache the VTT cross-user when it calls back. Returns immediately. Shares its body
  // with the user-authed POST generated-subtitle route via transcribeEnqueue().
  if (stringOr(body.mode, "") === "transcribe-enqueue") {
    const r = await transcribeEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""),
      sourceId: stringOr(body.sourceId, ""),
      externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""),
      index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
      // Always whole-track (dur 0): the async path CACHES the VTT as the full transcript, so a
      // partial clip (dur>0) would poison the cache. Clip benchmarking lives in the sync 'transcribe'
      // mode, which returns the VTT inline and never writes the cache.
      force: body.force === true,
    });
    return { mode: "transcribe-enqueue", ...r };
  }

  // Phase 4 service path: kick an OCR pass on a specific image-sub track (index + lang required).
  // Shares ocrEnqueue() with the user-authed POST generated-subtitle route. Live-guarded like the
  // other provider-touching dimensions (the .sup read is a provider connection).
  if (stringOr(body.mode, "") === "ocr-enqueue") {
    if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
      return { mode: "ocr-enqueue", skipped: "live-session" };
    }
    const r = await ocrEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""),
      sourceId: stringOr(body.sourceId, ""),
      externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""),
      index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
      lang: stringOr(body.lang, ""),
      fmt: stringOr(body.fmt, ""),
      force: body.force === true,
    });
    return { mode: "ocr-enqueue", ...r };
  }

  // mode 'transcribe-whitelist' (Phase 3c): nightly pre-generation of AI subtitles for a provider's
  // "hot" titles (recently played + new-release films that lack a text subtitle), most-wanted first
  // via whitelist_subtitle_candidates. transcribeEnqueue only POSTs to the gateway queue (fast); the
  // gateway serialises the actual whisper runs (concurrency 1), so enqueuing a small N just feeds the
  // night queue. Deferred while a user is live (the audio read would be a 2nd provider connection
  // beside their stream → user_multi_ip). `limit` = how many NEW jobs to start (cached/in-flight
  // titles are skipped and don't count, so the run keeps advancing past already-done ones).
  if (stringOr(body.mode, "") === "transcribe-whitelist") {
    if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
      throw new HttpError(503, "Media gateway is not configured");
    }
    if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
      return { mode: "transcribe-whitelist", skipped: "live-session", enqueued: 0 };
    }
    const want = Math.max(1, Math.min(Number(body.limit) || 2, 10));
    const { data: cands, error: candErr } = await db.rpc("whitelist_subtitle_candidates", {
      p_user: userId, p_limit: Math.max(want * 6, 20), // over-fetch: most candidates are already cached
    });
    if (candErr) throwDb(candErr, "Unable to list whitelist candidates");
    const rows = Array.isArray(cands) ? cands as JsonRecord[] : [];
    let enqueued = 0, cached = 0, errored = 0;
    const started: JsonRecord[] = [];
    for (const row of rows) {
      if (enqueued >= want) break;
      const titleId = stringOr(row.title_id, "");
      if (!titleId) continue;
      try {
        // respectFailedCooldown: skip a title that failed in the last 24h so it can't re-burn a
        // slot every night; a fresh candidate is tried instead.
        const r = await transcribeEnqueue(db, userId, runtimeConfig, { titleId, respectFailedCooldown: true });
        if (stringOr(r.status, "") === "processing" && r.cached !== true) {
          enqueued += 1; started.push({ titleId, jobId: r.jobId ?? null, priority: row.priority });
        } else if (stringOr(r.status, "") === "error") errored += 1;
        else cached += 1; // ready, in-flight, or in failed-cooldown
      } catch (_) { errored += 1; }
    }
    return { mode: "transcribe-whitelist", candidates: rows.length, enqueued, cached, errored, started };
  }

  // mode 'whisper' = OFFLINE language detection (single-slot-safe alternative to the inline
  // trigger). Walks titles whose audio_tracks still have UNTAGGED entries (lang null) and runs
  // the gateway's self-hosted whisper.cpp per untagged track. Meant to run when nothing is
  // streaming, so the WAV extraction doesn't contend with a live stream. Serialized by default
  // (concurrency 1) since each detection is a provider connection; resumable by id cursor.
  if (stringOr(body.mode, "") === "whisper") {
    if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
      throw new HttpError(503, "Media gateway is not configured");
    }
    // Defer while the user is live (avoids a 2nd provider connection / IP next to their stream).
    if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
      return { mode: "whisper", skipped: "live-session", processed: 0, candidates: 0, detected: 0 };
    }
    const wConcurrency = Math.max(1, Math.min(Number(body.concurrency) || 1, 4));
    // Select REAL candidates DB-side via RPC (raw jsonb @>): titles whose audio_tracks still hold
    // an untagged (lang null) track, skipping those attempted within the retry window so the queue
    // advances instead of re-trying the same front forever. (The old in-memory filter scanned the
    // first N titles by id, so the sparse untagged residual was almost never in the window → it did
    // nothing. PostgREST can't cleanly express the jsonb-array containment, hence the RPC.)
    const whisperRetryBefore = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: wrows, error: wErr } = await db.rpc("whisper_candidate_titles", {
      p_user: userId, p_item_type: itemType, p_limit: limit,
      p_retry_before: whisperRetryBefore, p_after: afterId || null,
      p_source: sourceId || null,   // per-panel scope: keep whisper's provider hit on this source's host only
    });
    if (wErr) throwDb(wErr, "Unable to list titles for whisper backfill");
    if (!wrows || !wrows.length) return { mode: "whisper", processed: 0, candidates: 0, detected: 0, lastId: afterId, hasMore: false };
    const wLastId = String(wrows[wrows.length - 1].id);

    const candidates = wrows.filter((t) => {
      const arr = Array.isArray((t as JsonRecord).audio_tracks) ? (t as JsonRecord).audio_tracks as JsonRecord[] : [];
      return arr.some((x) => !stringOrNull(x?.lang));
    });
    const wvIds = candidates.map((t) => stringOrNull((t as JsonRecord).default_variant_id)).filter(Boolean) as string[];
    const wvById = new Map<string, JsonRecord>();
    if (wvIds.length) {
      const { data: vs } = await db.from("cloud_title_variants").select("id, source_id, external_id, item_type").in("id", wvIds);
      for (const v of vs ?? []) wvById.set(String(v.id), v as JsonRecord);
    }

    let detected = 0;
    const wExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    // STRUCTURAL dead-ends (no variant / no source+external id) are permanent — mark them attempted so
    // they leave the candidate set and can't clog the cursor-less front-of-queue forever. TRANSIENT
    // failures (URL won't resolve, thrown errors) are NOT marked: a provider outage must not defer a
    // whole provider's untagged tracks for the 30-day retry window — they retry next run.
    const markWhisperAttempted = (titleId: string) =>
      db.from("cloud_titles").update({ whisper_attempted_at: new Date().toISOString() })
        .eq("id", titleId).eq("user_id", userId).then(() => {}, () => {});
    const runOne = async (t: JsonRecord) => {
      const titleId = String(t.id);
      try {
        const variant = wvById.get(String(t.default_variant_id));
        if (!variant) { await markWhisperAttempted(titleId); return; }
        const sourceId = stringOr(variant.source_id, ""), externalId = stringOr(variant.external_id, ""), vit = stringOr(variant.item_type, itemType);
        if (!sourceId || !externalId) { await markWhisperAttempted(titleId); return; }
        const targetUrl = vit === "series"
          ? await resolveSeriesEpisodeUrl(sourceId, externalId, userId, db).catch(() => null)
          : ((await resolvePlaybackTarget(sourceId, vit, externalId, userId, db).catch(() => null))?.targetUrl ?? null);
        if (!targetUrl) return;
        const audioTracks = ((t.audio_tracks as JsonRecord[]) || [])
          .map((x) => ({ index: Number(x?.index), lang: stringOrNull(x?.lang) }))
          .filter((x) => Number.isInteger(x.index));
        const before = audioTracks.filter((x) => x.lang).length;
        await detectUntaggedAudioLanguages({
          db, runtimeConfig, userId, targetUrl, userAgent: null,
          audioTracks, titleId: String(t.id), tmdbId: stringOrNull(t.provider_tmdb_id),
          serverHost: await resolveFileTracksKey(sourceId, userId, db, targetUrl), itemType: vit, fileExternalId: externalId,
          sessionId: "whisper-backfill", expiresAt: wExp,
        });
        if (audioTracks.filter((x) => x.lang).length > before) detected += 1;
      } catch (_) { /* best-effort per title */ }
    };
    for (let i = 0; i < candidates.length; i += wConcurrency) {
      await Promise.all(candidates.slice(i, i + wConcurrency).map(runOne));
    }
    return { mode: "whisper", processed: wrows.length, candidates: candidates.length, detected, lastId: wLastId, hasMore: wrows.length === limit };
  }

  // Autonomous provider probe (audio-langs / subtitle backfill via the relay). Defer while the user
  // is live: the live stream (gateway/residential IP) and a relay probe (Cloudflare IP) hit the
  // provider from two IPs at once → its single-IP panel returns 429 user_multi_ip and breaks live
  // browsing. ignoreLiveSession bypasses this for a manual/one-shot backfill.
  if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
    return { mode, skipped: "live-session", processed: 0, updated: 0, userId };
  }

  // untaggedOnly = titles with NO version tag (e.g. plain French films). These carry no
  // language signal in the title, so they MUST be probed; ~60% expose a real default-track
  // language via the cheap get_vod_info (mode=vod). Excluded from the tag-targeted crons.
  const untaggedOnly = body.untaggedOnly === true || stringOr(body.untaggedOnly, "") === "1";
  // Per-panel scope (sourceId) → audio_backfill_candidates RPC: the SAME filter (audio unresolved
  // + 30d probe-retry window, OR never subtitle-probed) but scoped to one source, variant-driven so
  // work is bounded by that source. Account-wide (no sourceId) keeps the original PostgREST path.
  const titlesResult = sourceId
    ? await db.rpc("audio_backfill_candidates", {
        p_user: userId,
        p_source: sourceId,
        p_item_type: itemType,
        p_target: subtitleTarget ? "subtitle" : "audio",
        p_require_tags: requireTags.length ? requireTags : null,
        p_untagged_only: untaggedOnly,
        p_limit: limit,
      })
    : await (() => {
        let q = db
          .from("cloud_titles")
          .select("id, default_variant_id, provider_tmdb_id")
          .eq("user_id", userId)
          .eq("item_type", itemType)
          .gt("variant_count", 0);
        if (subtitleTarget) {
          // Subtitle sweep: titles never subtitle-probed. Independent of audio state, so it also
          // covers titles whose audio is already resolved (the one header-parse fills both).
          q = q.is("subtitle_probed_at", null);
        } else {
          q = q.eq("audio_languages", "{}");
          // Progression: skip titles already probed recently so the crawl ADVANCES past
          // genuinely-untagged titles instead of re-probing the same front of the queue forever.
          // 180d re-probe window: transient failures (relay 429/5xx) never set audio_probed_at —
          // they retry next tick — so this window only governs DETERMINISTIC negatives (relay ok,
          // container has no usable audio language). Re-probing those is near-certain waste, so we
          // stretch it to twice a year (no-op during first pass; frees the connection slot after).
          // Mirrors audio_backfill_candidates' 180d window (per-source path) — keep the two in sync.
          const probeRetryBefore = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
          q = q.or(`audio_probed_at.is.null,audio_probed_at.lt.${probeRetryBefore}`);
        }
        if (requireTags.length) q = q.overlaps("version_languages", requireTags);
        if (untaggedOnly) q = q.eq("version_languages", "{}");
        if (afterId) q = q.gt("id", afterId);
        return q.order("id", { ascending: true }).limit(limit);
      })();
  const titles = titlesResult.data as { id: string; default_variant_id: string | null; provider_tmdb_id: string | null }[] | null;
  const error = titlesResult.error;
  if (error) throwDb(error, "Unable to list titles for backfill");
  if (!titles || !titles.length) return { processed: 0, updated: 0, lastId: afterId, hasMore: false };

  const variantIds = titles.map((t) => t.default_variant_id).filter(Boolean) as string[];
  const variantById = new Map<string, JsonRecord>();
  if (variantIds.length) {
    const { data: variants } = await db
      .from("cloud_title_variants")
      .select("id, source_id, external_id, item_type")
      .in("id", variantIds);
    for (const v of variants ?? []) variantById.set(String(v.id), v as JsonRecord);
  }

  let updated = 0;
  const debug = stringOr(body.debug, "") === "1";
  const diag = { noVariant: 0, noTarget: 0, relayNotOk: 0, relayEmpty: 0, noLang: 0, exception: 0 };
  let sample: JsonRecord | null = null;
  const lastId = String(titles[titles.length - 1].id);

  const processOne = async (title: JsonRecord) => {
    // Mark a title as probed (resolved or genuinely-empty) so the progression filter
    // advances past it. Only called after a SUCCESSFUL relay response — never on a
    // transient relayNotOk (429), so those retry on the next pass. Best-effort.
    const markProbed = async (extra: JsonRecord = {}) => {
      try {
        await db.from("cloud_titles").update({ audio_probed_at: new Date().toISOString(), ...extra })
          .eq("user_id", userId).eq("id", String(title.id));
      } catch (_) { /* best-effort progression marker */ }
    };
    try {
      const variant = title.default_variant_id ? variantById.get(String(title.default_variant_id)) : null;
      if (!variant) { diag.noVariant++; return; }
      const sourceId = stringOr(variant.source_id, "");
      const externalId = stringOr(variant.external_id, "");
      const variantItemType = stringOr(variant.item_type, itemType);
      if (!sourceId || !externalId) { diag.noTarget++; return; }

      // Series have no directly-streamable id (provider 406s on a series id) — resolve a
      // representative episode first. A series' audio is consistent across episodes.
      let targetUrl: string | null;
      if (variantItemType === "series") {
        targetUrl = await resolveSeriesEpisodeUrl(sourceId, externalId, userId, db).catch(() => null);
      } else {
        const target = await resolvePlaybackTarget(sourceId, variantItemType, externalId, userId, db).catch(() => null);
        targetUrl = target?.targetUrl ?? null;
      }
      if (!targetUrl) { diag.noTarget++; return; }

      const payload = JSON.stringify({ v: 1, sid: "audio-backfill", uid: userId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
      const signature = await hmacBase64Url(runtimeConfig.relayTokenSecret, payload);
      const token = `${base64Url(encoder.encode(payload))}.${signature}`;

      const endpoint = mode === "probe" ? "probe-audio" : "vod-info";
      const res = await fetch(`${runtimeConfig.relayBaseUrl}/${endpoint}/${token}`, { headers: { accept: "application/json" } });
      if (!res.ok) {
        diag.relayNotOk++;
        if (debug && !sample) sample = { stage: "relayNotOk", status: res.status, host: new URL(targetUrl).host, body: (await res.text().catch(() => "")).slice(0, 200) };
        return;
      }
      const info = await res.json().catch(() => null);
      if (debug && !sample) {
        let relayHead: JsonRecord = {};
        try {
          const rr = await fetch(`${runtimeConfig.relayBaseUrl}/relay/${token}`, { headers: { range: "bytes=0-400" } });
          const u8 = new Uint8Array(await rr.arrayBuffer());
          relayHead = { status: rr.status, len: u8.length, hex: [...u8.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(""), cr: rr.headers.get("content-range"), path: rr.headers.get("x-norva-relay-path") };
        } catch (e) { relayHead = { error: String(e).slice(0, 120) }; }
        sample = { stage: "relayOk", mode, info, relayHead };
      }
      // Subtitles ride along with the probe-mode header-parse: the relay returns audio AND
      // subtitle tracks in ONE call, so the crawl persists subtitles for free wherever it
      // probes audio (and the dedicated subtitle sweep, target=subtitle, uses the same path).
      const orderedSubtitles = mode === "probe" && info && Array.isArray(info.subtitles)
        ? (info.subtitles as JsonRecord[])
            .map((s) => ({
              index: Number(s?.index),
              lang: normalizeIsoLang(stringOrNull(s?.lang ?? s?.language)),
              codec: stringOrNull(s?.codec),
              subtitleType: stringOrNull(s?.subtitleType) || (s?.extractable ? "text" : "image"),
              extractable: s?.extractable === true,
              forced: s?.forced === true,
            }))
            .filter((s) => Number.isInteger(s.index))
        : [];
      const subtitleFields: JsonRecord = mode === "probe"
        ? { subtitle_tracks: orderedSubtitles, subtitle_probed_at: new Date().toISOString() }
        : {};

      const codes = new Set<string>();
      if (mode === "probe") {
        const incoming = info && Array.isArray(info.audioLanguages) ? info.audioLanguages : [];
        const hasTracks = (Array.isArray(info?.audioTracks) && info.audioTracks.length) || orderedSubtitles.length;
        // Truly empty (no langs AND no tracks at all) = header-parse failed → mark probed
        // (incl. subtitles) so the crawl advances, mirroring the audio progression marker.
        if (!incoming.length && !hasTracks) { diag.relayEmpty++; await markProbed(subtitleFields); return; }
        for (const code of incoming) { const normalized = normalizeIsoLang(stringOrNull(code)); if (normalized) codes.add(normalized); }
      } else {
        const tracks = info && Array.isArray(info.audioTracks) ? info.audioTracks : [];
        if (!tracks.length) { diag.relayEmpty++; await markProbed(); return; }
        for (const track of tracks) { const normalized = normalizeIsoLang(stringOrNull((track as JsonRecord)?.language)); if (normalized) codes.add(normalized); }
      }
      // No audio language resolved, but the probe SUCCEEDED (tracks/subs present): still
      // persist subtitles + advance the audio marker so we don't re-probe forever.
      if (!codes.size) { diag.noLang++; await markProbed(subtitleFields); return; }

      // Capture the ORDERED per-track map (absolute index -> lang) alongside the deduped
      // set, so the player never has to probe at playback. mode=probe only — it's the
      // path carrying the full container track list. Undetermined tracks kept (lang null)
      // to preserve index/position alignment for the engine.
      const orderedTracks = mode === "probe" && info && Array.isArray(info.audioTracks)
        ? (info.audioTracks as JsonRecord[])
            .map((t) => ({ index: Number(t?.index), lang: normalizeIsoLang(stringOrNull(t?.lang ?? t?.language)) }))
            .filter((t) => Number.isInteger(t.index))
        : [];

      const sortedCodes = [...codes].sort();
      const updatePayload: JsonRecord = { ...subtitleFields, audio_languages: sortedCodes, audio_probed_at: new Date().toISOString() };
      if (orderedTracks.length) updatePayload.audio_tracks = orderedTracks;
      const { error: updateError } = await db
        .from("cloud_titles")
        .update(updatePayload)
        .eq("user_id", userId)
        .eq("id", String(title.id));
      if (!updateError) {
        updated += 1;
        // Scale-readiness: mirror into the global catalog cache (race-safe SQL union).
        // Best-effort — must never fail the per-user backfill. NOTE: the Supabase builder
        // is a thenable without .catch(), so this MUST be a try/catch, not a .catch().
        const tmdbId = stringOrNull(title.provider_tmdb_id);
        if (tmdbId && !/^(tt)?0+$/i.test(tmdbId)) {
          try {
            await db.rpc("merge_catalog_title_audio", {
              p_item_type: itemType,
              p_provider_tmdb_id: tmdbId,
              p_codes: sortedCodes,
            });
          } catch (_) { /* best-effort global mirror */ }
        }
      }
      // Cross-user share: store the file map in the global per-file cache + fan out to every
      // owner (probe mode only — it carries the full ordered track list; subtitles ride along).
      if (mode === "probe") {
        await shareFileTracks(db, await resolveFileTracksKey(sourceId, userId, db, targetUrl), variantItemType, externalId, orderedTracks, orderedSubtitles, orderedTracks.length > 0, true);
      }
    } catch (e) {
      diag.exception++;
      if (debug && !sample) sample = { stage: "exception", error: String(e).slice(0, 200) };
    }
  };

  for (let i = 0; i < titles.length; i += concurrency) {
    await Promise.all(titles.slice(i, i + concurrency).map((t) => processOne(t as JsonRecord)));
  }

  return { processed: titles.length, updated, diag, ...(debug ? { sample } : {}), lastId, hasMore: titles.length === limit };
}

// Read-cutover trust artifact (docs/roadmap/global-title-cache-design.md): prove
// catalog_titles is a faithful mirror of the per-user title metadata BEFORE the
// global-read flip is ever enabled. Read-only; service-role gated like the backfill.
// `clean` is the gate — flipping NORVA_CATALOG_READ_SOURCE to catalog_titles is only
// safe when this stays true across a window.
async function runCatalogMirrorVerify(req: Request, db: SupabaseClient) {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");
  let itemType: string | null = null;
  try {
    const b = await req.json();
    if (b?.type === "movie" || b?.type === "series") itemType = b.type;
  } catch (_) { /* optional body */ }
  const { data, error } = await db.rpc("catalog_mirror_diff", { p_item_type: itemType });
  if (error) throw new HttpError(500, `catalog_mirror_diff failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
  const n = (k: string) => Number((row?.[k] as number | undefined) ?? -1);
  const clean = !!row &&
    n("title_mismatch") === 0 && n("original_title_mismatch") === 0 &&
    n("release_year_mismatch") === 0 && n("poster_url_mismatch") === 0 &&
    n("backdrop_url_mismatch") === 0 && n("i18n_mismatch") === 0 &&
    n("tmdb_mismatch") === 0 && n("cloud_only") === 0;
  return { ok: true, clean, diff: row };
}

// Multi-provider smoke test (docs/roadmap/scaling-status.md §C): for one movie per
// distinct provider host, run a real 1-byte Range request through the relay and assert
// 206 — catches a provider whose auth/redirect broke BEFORE users hit it. Service-role
// gated; read-only.
async function runProviderPlaybackCheck(req: Request, db: SupabaseClient) {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const userId = stringOr(body.userId, "");
  if (!userId) throw new HttpError(400, "Missing userId");
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) throw new HttpError(503, "Norva Relay is not configured");

  const { data: sources } = await db.from("cloud_sources").select("id, config_hint").eq("user_id", userId);
  const results: JsonRecord[] = [];
  for (const src of sources ?? []) {
    const sourceId = String((src as JsonRecord).id);
    const serverHost = stringOrNull((recordOrEmpty((src as JsonRecord).config_hint) as JsonRecord).serverHost) ?? "?";
    const { data: variants } = await db.from("cloud_title_variants")
      .select("external_id, item_type").eq("source_id", sourceId).eq("item_type", "movie").limit(1);
    const v = (variants ?? [])[0] as JsonRecord | undefined;
    if (!v) { results.push({ serverHost, ok: false, reason: "no movie variant" }); continue; }
    const target = await resolvePlaybackTarget(sourceId, "movie", String(v.external_id), userId, db).catch(() => null);
    if (!target?.targetUrl) { results.push({ serverHost, ok: false, reason: "no target" }); continue; }
    const payload = JSON.stringify({ v: 1, sid: "provider-check", uid: userId, url: target.targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
    const signature = await hmacBase64Url(runtimeConfig.relayTokenSecret, payload);
    const token = `${base64Url(encoder.encode(payload))}.${signature}`;
    const t0 = Date.now();
    const rr = await fetch(`${runtimeConfig.relayBaseUrl}/relay/${token}`, { headers: { range: "bytes=0-1" } }).catch(() => null);
    const ms = Date.now() - t0;
    const status = rr?.status ?? 0;
    results.push({ serverHost, status, ok: status === 206, ms, path: rr?.headers.get("x-norva-relay-path") ?? null });
  }
  return { checked: results.length, allOk: results.length > 0 && results.every((r) => r.ok), results };
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-norva-profile-id",
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
