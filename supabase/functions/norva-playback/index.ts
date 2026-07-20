import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getEntitlementDecision, getEntitlementRuntime, limitNumber } from "../_shared/entitlements.ts";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = {
  relayBaseUrl: string;
  relayTokenSecret: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  lidWorkerUrl: string;
  lidWorkerToken: string;
  sourceConfigKey: string;
  whisperDetect: boolean; // Phase 2: detect untagged audio-track languages via the relay (Workers AI). Off by default.
};
type CloudIdentity = { userId: string; deviceId?: string };
type LidDetectionPolicy = {
  enabled: boolean;
  mode: "off" | "shadow" | "primary" | "conflict";
  untaggedScope: string | null;
  taggedScope: string | null;
  cascadeMode: "off" | "shadow" | "canary" | "primary" | "conflict";
  cascadeScope: string | null;
  cascadePolicyVersion: string | null;
  cascadeSeed: string | null;
  cascadeShadowBps: number;
  cascadeCanaryBps: number;
  cascadeDailyCap: number;
  cascadeAttemptsToday: number;
  cascadeExpiresAt: string | null;
  cascadeTaggedWritesEnabled: boolean;
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
  "http://localhost:4173",
];
const RUNTIME_CONFIG_KEYS = [
  "NORVA_RELAY_BASE_URL",
  "RELAY_TOKEN_SECRET",
  "NORVA_MEDIA_GATEWAY_URL",
  "NORVA_MEDIA_GATEWAY_TOKEN",
  "NORVA_LID_WORKER_URL",
  "NORVA_LID_WORKER_TOKEN",
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
// Public origin for URLs handed to EXTERNAL callers — the browser (storyboard
// sprite) and the Railway media gateway (transcribe/storyboard callbacks + the
// signed upload URL). On self-host SUPABASE_URL is the internal http://kong:8000,
// unreachable from outside the box, so anything that leaves the edge must use the
// public origin. On managed SUPABASE_PUBLIC_URL == SUPABASE_URL, so this is inert.
const PUBLIC_ORIGIN = trimTrailingSlash(Deno.env.get("SUPABASE_PUBLIC_URL") ?? "") || SUPABASE_URL;
const ENV_RELAY_BASE_URL = trimTrailingSlash(Deno.env.get("NORVA_RELAY_BASE_URL") ?? "");
const ENV_RELAY_TOKEN_SECRET = Deno.env.get("RELAY_TOKEN_SECRET") ?? "";
const ENV_MEDIA_GATEWAY_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
const ENV_LID_WORKER_URL = trimTrailingSlash(Deno.env.get("NORVA_LID_WORKER_URL") ?? "");
const ENV_LID_WORKER_TOKEN = Deno.env.get("NORVA_LID_WORKER_TOKEN") ?? "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const ENV_WHISPER_DETECT = Deno.env.get("NORVA_WHISPER_DETECT") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;
let lidDetectionPolicyCache: { value: LidDetectionPolicy; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      const config = await getRuntimeConfig(supabase);
      const lidPolicy = await getLidDetectionPolicy(supabase);
      const entitlementRuntime = getEntitlementRuntime();
      return json(req, {
        ok: true,
        service: "norva-playback",
        version: 34,
        lidBenchmarkProtocol: 2,
        lidDetectOnlyProtocol: 1,
        lidCascadeProtocol: 2,
        audioLidEnabled: lidPolicy.enabled,
        lidDetectOnlyMode: lidPolicy.mode,
        lidCascadeMode: lidPolicy.cascadeMode,
        lidCascadePolicyVersion: lidPolicy.cascadePolicyVersion,
        lidCascadeShadowBps: lidPolicy.cascadeShadowBps,
        lidCascadeCanaryBps: lidPolicy.cascadeCanaryBps,
        lidCascadeDailyCap: lidPolicy.cascadeDailyCap,
        lidCascadeAttemptsToday: lidPolicy.cascadeAttemptsToday,
        lidCascadeExpiresAt: lidPolicy.cascadeExpiresAt,
        lidCascadeWorkerConfigured: Boolean(config.lidWorkerUrl && config.lidWorkerToken),
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
    // Dedicated route: an older edge replica returns 404 instead of interpreting a
    // benchmark payload as a normal audio-backfill mutation during a rolling deploy.
    if (req.method === "POST" && segments[0] === "lid-benchmark") {
      return json(req, await runLidBenchmarkEndpoint(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "transcribe-callback") {
      return json(req, await runTranscribeCallback(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "pregen-gate") {
      return json(req, await runPregenGate(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "account-activity") {
      return json(req, await runAccountActivity(req, supabase));
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
    // Seek-thumbnail storyboards (sprite JPEG in Storage, cross-user cache).
    if (req.method === "GET" && segments[0] === "storyboard") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await getStoryboard(req, identity.userId, supabase));
    }
    if (req.method === "POST" && segments[0] === "storyboard-callback") {
      return json(req, await runStoryboardCallback(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "catalog-mirror-verify") {
      return json(req, await runCatalogMirrorVerify(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "catalog-media-mirror-verify") {
      return json(req, await runCatalogMediaMirrorVerify(req, supabase));
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

  // Vérif locale d'abord (voir _shared/local-auth.ts) — GoTrue n'est consulté
  // que si le verdict est indécidable localement (alg asymétrique, secret absent).
  const local = await verifyUserJwtLocally(token);
  if (local !== "invalid" && local !== "fallback") return { userId: local.id };
  if (local === "fallback") {
    const { data, error } = await db.auth.getUser(token);
    if (!error && data.user) return { userId: data.user.id };
  }

  const tokenHash = await sha256Hex(token);
  const { data: device, error: deviceError } = await db
    .from("cloud_devices")
    .select("id, user_id")
    .eq("device_token_hash", tokenHash)
    .eq("revoked", false)
    .maybeSingle();
  if (deviceError) throwDb(deviceError, "Unable to verify device token");
  if (!device) throw new HttpError(401, "Invalid bearer token");
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

  // Account busy-lock writer: every playback session start means this provider account's
  // single connection slot is (about to be) held — direct native plays included. Best-effort.
  await touchProviderAccountByUrl(db, targetUrl, "session");

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
      // Register the raw byte-pipe in the SAME cross-device ledger as transcode:
      // starting it evicts a lingering gateway transcode (real DELETE → frees the
      // provider slot) or another device's pipe (raw-pump abort at the gateway),
      // instead of the two lanes silently fighting a single-slot provider (458).
      // Coordinator unavailable → null → plays exactly as before (best-effort).
      const rawCoordination = await prepareEdgeSessionCoordinator({
        userId, sourceId, deviceId, itemType, itemId, targetUrlHash, expiresAt,
      }, db);
      if (rawCoordination?.waitMs) await sleep(rawCoordination.waitMs);
      const pipe = await createBytePipeAccess(session.id, userId, targetUrl, expiresAt, db, userAgent);
      await commitEdgeSessionCoordinator(rawCoordination, {
        playbackSessionId: session.id,
        gatewaySessionId: null,
        lane: "raw",
        itemType, itemId, targetUrlHash, expiresAt,
      });
      // Name the audio AND subtitle tracks for the in-browser engine: it streams the raw
      // file via the gateway and can't read per-stream language tags. ONE relay header-parse
      // returns both (the container header carries both → zero extra provider round-trips).
      //  - Reuse the exact provider-file cache when present (no probe).
      //  - Otherwise probe that exact file and feed the global file cache.
      // A cloud_titles map is a grouped-title facet and may belong to a sibling
      // dub; its absolute indices must never label another variant.
      // All best-effort — never blocks or breaks playback.
      let audioTracks: Array<{ index: number; lang: string | null }> = [];
      let subtitleTracks: JsonRecord[] = [];
      let audioLanguageVerified = false;
      let audioLanguageVerifiedAt: string | null = null;
      let audioLanguageVerification: JsonRecord = {};
      const titleRow = await resolveEngineAudioTitleRow(db, userId, sourceId, itemType, itemId, requestedPlaybackHint)
        .catch(() => null);
      let haveAudio = false;
      let haveSub = false;

      // Cross-mirror cache key (providerKey when known, else the host) — drives the
      // global file-track read, the share/fan-out, and the whisper-detect cache below.
      const serverHost = await resolveFileTracksKey(stringOr(sourceId, ""), userId, db, targetUrl);
      // itemId is the PLAYED file (episode id for series), whereas audioSeriesId
      // only resolves the parent title row. File caches must stay episode-exact.
      const fileExternalId = itemId;

      // Cross-user reuse: another user (or the crawl) may have already probed this exact
      // provider file. Pull from the global per-file cache (no provider hit) and fill this
      // user's row, before ever falling back to a probe.
      if (serverHost && fileExternalId) {
        try {
          const { data: fr } = await db.from("catalog_file_tracks")
            .select("audio_tracks, subtitle_tracks, audio_probed_at, subtitle_probed_at, audio_lang_verified_at, audio_lang_verification")
            .eq("server_host", serverHost).eq("item_type", itemType).eq("external_id", fileExternalId)
            .maybeSingle();
          const fileRow = fr as JsonRecord | null;
          if (fileRow) {
            if (fileRow.audio_probed_at) {
              const ga = (Array.isArray(fileRow.audio_tracks) ? fileRow.audio_tracks as JsonRecord[] : [])
                .map((t) => ({ index: Number(t?.index), lang: stringOrNull(t?.lang) })).filter((t) => Number.isInteger(t.index));
              audioTracks = ga;
              haveAudio = true;
              audioLanguageVerified = Boolean(fileRow.audio_lang_verified_at);
              audioLanguageVerifiedAt = stringOrNull(fileRow.audio_lang_verified_at);
              audioLanguageVerification = recordOrEmpty(fileRow.audio_lang_verification);
            }
            if (fileRow.subtitle_probed_at) {
              const gs = Array.isArray(fileRow.subtitle_tracks) ? fileRow.subtitle_tracks as JsonRecord[] : [];
              subtitleTracks = gs;
              haveSub = true;
            }
          }
        } catch (_) { /* best-effort global reuse */ }
      }

      // Still missing → probe the provider ONCE, persist to this user's row, and SHARE to the
      // global file cache + fan out to every other owner so they skip the probe entirely.
      // A codec profile is stored on the exact cloud_title_variants row, so it
      // is a safe second source when the global file cache has not caught up.
      const exactVariantProfile = itemType === "movie"
        && String(titleRow?.variant_external_id ?? "") === String(itemId);
      const variantProfile = exactVariantProfile
        ? recordOrEmpty(titleRow?.variant_codec_profile)
        : {};
      const variantAudioRaw = variantProfile.audioTracks ?? variantProfile.audio_tracks;
      const variantSubtitleRaw = variantProfile.subtitles ?? variantProfile.subtitleTracks ?? variantProfile.subtitle_tracks;
      if (!haveAudio && Array.isArray(variantAudioRaw) && variantAudioRaw.length) {
        audioTracks = (variantAudioRaw as JsonRecord[])
          .map((t) => ({ index: Number(t?.index), lang: stringOrNull(t?.lang ?? t?.language) }))
          .filter((t) => Number.isInteger(t.index));
        haveAudio = audioTracks.length > 0;
      }
      if (!haveSub && Array.isArray(variantSubtitleRaw) && (haveAudio || variantSubtitleRaw.length)) {
        subtitleTracks = (variantSubtitleRaw as JsonRecord[])
          .filter((t) => Number.isInteger(Number(t?.index)));
        haveSub = true;
      }

      // Backwards compatibility for a genuinely single-version title only.
      // In that case title == file; grouped-title indices are never safe.
      const singleMovieTitle = itemType === "movie" && Number(titleRow?.variant_count ?? 0) <= 1;
      if (singleMovieTitle) {
        if (!haveAudio) {
          const singleAudio = (titleRow && Array.isArray(titleRow.audio_tracks) ? titleRow.audio_tracks as JsonRecord[] : [])
            .map((t) => ({ index: Number(t?.index), lang: stringOrNull(t?.lang) }))
            .filter((t) => Number.isInteger(t.index));
          if (singleAudio.length) { audioTracks = singleAudio; haveAudio = true; }
        }
        if (!haveSub) {
          const singleSub = (titleRow && Array.isArray(titleRow.subtitle_tracks) ? titleRow.subtitle_tracks as JsonRecord[] : [])
            .filter((t) => Number.isInteger(Number(t?.index)));
          if (singleSub.length || titleRow?.subtitle_probed_at) {
            subtitleTracks = singleSub;
            haveSub = true;
          }
        }
      }

      if (!haveAudio || !haveSub) {
        let probed = { audioTracks: [] as Array<{ index: number; lang: string | null }>, subtitleTracks: [] as JsonRecord[] };
        try { probed = await probeEngineTracks(db, userId, targetUrl); } catch (_) { /* best-effort */ }
        const probeOk = probed.audioTracks.length > 0; // every video has audio → audio present == parse ok
        const gotAudio = !haveAudio && probeOk;
        const gotSub = !haveSub && probeOk;
        if (gotAudio) {
          audioTracks = probed.audioTracks;
          haveAudio = true;
        }
        if (gotSub) {
          subtitleTracks = probed.subtitleTracks;
          haveSub = true;
        }
        if (titleRow?.id && singleMovieTitle && (gotAudio || gotSub)) {
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
        if (gotAudio && titleRow?.id && singleMovieTitle && serverHost && fileExternalId
          && audioTracks.length >= 2 && audioTracks.some((t) => !t.lang)) {
          const rc = await getRuntimeConfig(db);
          if (rc.whisperDetect && rc.mediaGatewayUrl && rc.mediaGatewayToken) {
            runBackground(detectUntaggedAudioLanguages({
              db, runtimeConfig: rc, userId, targetUrl, userAgent,
              audioTracks, titleId: titleRow.id, tmdbId: stringOrNull(titleRow.provider_tmdb_id),
              serverHost, itemType, fileExternalId, sessionId: session.id, expiresAt,
              variantId: stringOrNull(titleRow.variant_id) || undefined,
              fileScoped: Boolean(titleRow.variant_id),
            }));
          }
        }
      }
      // The grouped-title language facets are a UNION of exact provider files,
      // never a representative file's absolute stream-index map. Pair the
      // resolved parent variant with the exact played file id after track
      // validation. For series, the variant is the parent while itemId remains
      // the exact episode, so the SQL layer can keep episode evidence distinct.
      if (titleRow?.id && titleRow.variant_id && (haveAudio || haveSub)) {
        try {
          await db.rpc("merge_cloud_title_file_languages", {
            p_user_id: userId,
            p_title_id: titleRow.id,
            p_variant_id: titleRow.variant_id,
            p_file_external_id: fileExternalId,
            p_audio_tracks: audioTracks,
            p_subtitle_tracks: subtitleTracks,
            p_has_audio: haveAudio,
            p_has_subtitle: haveSub,
          });
        } catch (_) { /* exact-language union is best-effort; playback must continue */ }
      }
      return {
        session,
        playback: {
          mode: "relay",
          url: pipe.url,
          tokenExpiresAt: expiresAt,
          ...(audioTracks.length ? {
            audioTracks,
            audioLanguageValidationStatus: audioLanguageVerified
              ? "verified"
              : audioTracks.some((track) => Boolean(stringOrNull(track.lang)))
                ? "probed"
                : "pending",
            audioLanguageVerifiedAt,
            audioLanguageVerification,
          } : {}),
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
  const gatewaySessionResponse = gateway.session && typeof gateway.session === "object"
    ? {
      ...gateway.session,
      audioStreamIndex: gateway.audioStreamIndex ?? null,
      audio_stream_index: gateway.audioStreamIndex ?? null,
      requestedSeekOffset: gateway.requestedSeekOffset ?? 0,
      requested_seek_offset: gateway.requestedSeekOffset ?? 0,
      actualStartOffset: gateway.actualStartOffset ?? 0,
      actual_start_offset: gateway.actualStartOffset ?? 0,
      localSeekTarget: gateway.localSeekTarget ?? 0,
      local_seek_target: gateway.localSeekTarget ?? 0,
      sourceTimestamps: gateway.sourceTimestamps === true,
      source_timestamps: gateway.sourceTimestamps === true,
    }
    : gateway.session;
  return {
    session,
    playback: {
      mode,
      status: gateway.status,
      url: gateway.hlsUrl,
      gatewaySession: gatewaySessionResponse,
      gatewayRequired: !gateway.hlsUrl,
      startupMs: gateway.startupMs ?? null,
      audioMode: gateway.audioMode ?? null,
      audioStreamIndex: gateway.audioStreamIndex ?? null,
      audio_stream_index: gateway.audioStreamIndex ?? null,
      requestedSeekOffset: gateway.requestedSeekOffset ?? 0,
      requested_seek_offset: gateway.requestedSeekOffset ?? 0,
      actualStartOffset: gateway.actualStartOffset ?? 0,
      actual_start_offset: gateway.actualStartOffset ?? 0,
      localSeekTarget: gateway.localSeekTarget ?? 0,
      local_seek_target: gateway.localSeekTarget ?? 0,
      sourceTimestamps: gateway.sourceTimestamps === true,
      source_timestamps: gateway.sourceTimestamps === true,
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
  // Error payloads quote strings parsed from BINARY data (fMP4 box names, source-head
  // bytes) which can carry NUL/control chars. Postgres rejects U+0000 in text/jsonb,
  // and one dirty byte used to lose the whole failure event. Scrub server-side too
  // (the client scrubs at its send boundary, but old clients keep posting raw).
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "\u00B7");
    if (Array.isArray(v)) return v.map(scrub);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
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
      error_code: scrub(stringOrNull(body.errorCode ?? body.error_code)),
      error_message: scrub(stringOrNull(body.errorMessage ?? body.error_message)),
      metadata: scrub(compactRecord(recordOrEmpty(body.metadata))),
    })
    .select("*")
    .single();
  if (error) throwDb(error, "Unable to record playback event");

  // Account busy-lock writer: any playback event (zap, first frame, error, ended) means the
  // provider account was just being used — refresh its activity signal. Best-effort.
  await touchProviderAccountBySource(db, sourceId, "event");

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
  // The 3 sizing unknowns (see docs/roadmap/scaling-cost-hetzner-plan.md §9.8/§10):
  // playback_mode (= the cost tier: transcode/engine = metered, relay = cheap,
  // direct = free) and the video codec mix. Surface (browser vs native) already
  // rides byClientSurface.
  const byPlaybackMode: Record<string, JsonRecord> = {};
  const byCodec: Record<string, JsonRecord> = {};
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

    const mode = normalizeTelemetryKey(row.playback_mode, "unknown");
    const codec = normalizeTelemetryKey(
      metadata.videoCodec ?? metadata.video_codec ?? metadata.codec ?? metadata.container,
      "unknown",
    );

    const typeBucket = telemetryBucket(byContentType, itemType);
    const surfaceBucket = telemetryBucket(byClientSurface, surface);
    const modeBucket = telemetryBucket(byPlaybackMode, mode);
    const codecBucket = telemetryBucket(byCodec, codec);
    typeBucket.events = numberValue(typeBucket.events) + 1;
    surfaceBucket.events = numberValue(surfaceBucket.events) + 1;
    modeBucket.events = numberValue(modeBucket.events) + 1;
    codecBucket.events = numberValue(codecBucket.events) + 1;

    if (eventType === "play_requested") {
      typeBucket.requests = numberValue(typeBucket.requests) + 1;
      surfaceBucket.requests = numberValue(surfaceBucket.requests) + 1;
      modeBucket.requests = numberValue(modeBucket.requests) + 1;
      codecBucket.requests = numberValue(codecBucket.requests) + 1;
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

  // Cost-tier shares (the media-cost signal, docs §9.8): transcode = Railway/GEX44
  // FFmpeg (metered egress + CPU, most expensive), engine = raw byte-pipe (metered
  // egress, no CPU), relay = Cloudflare (cheap), direct = native (free to Norva).
  const modeRequests = (m: string) => numberValue(byPlaybackMode[m]?.requests);
  const modeTotal = Math.max(1, modeRequests("transcode") + modeRequests("engine") + modeRequests("relay") + modeRequests("direct") + modeRequests("unknown"));

  return {
    window: { since, until, days, sampleSize: rows.length, limit },
    playback: {
      byContentType,
      byClientSurface,
      byPlaybackMode,
      byCodec,
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
      // Media-cost tiers: transcode+engine are Norva-metered (Railway/GEX44 egress),
      // relay is cheap (Cloudflare), direct is free. Drives the AX42+Railway vs GEX44
      // capacity/cost sizing (docs §9-§10).
      transcodeRequestShare: roundRatio(modeRequests("transcode") / modeTotal),
      engineRequestShare: roundRatio(modeRequests("engine") / modeTotal),
      relayRequestShare: roundRatio(modeRequests("relay") / modeTotal),
      directRequestShare: roundRatio(modeRequests("direct") / modeTotal),
      meteredRequestShare: roundRatio((modeRequests("transcode") + modeRequests("engine")) / modeTotal),
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
    lane?: string;
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
    lane: options.lane,
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

// Provider identity for a source. The cross-tenant key comes only from the
// server-written source→identity link; config_hint is owner-editable and is
// retained solely for the tenant's configured host.
// the playback path adds at most one lookup per source per isolate.
//  - host: the configured provider hostname.
//  - key:  the canonical CROSS-MIRROR cache key. Phase B: the STABLE provider IDENTITY id when the
//          source resolves to one — so two resellers of ONE panel (different providerKey) AND a
//          taxonomy-drifted key all share a single cross-user cache. A reseller hands out many URLs
//          (DNS aliases / reverse-proxies) for one Xtream panel, and the panel's category taxonomy
//          drifts, so keying on either hostname or providerKey FRAGMENTS the cache. The identity id
//          (resolved from stream-ID overlap, see docs/PROVIDER-IDENTITY-DEDUP.md §8) is invariant to
//          both. An unresolved source falls back to a source-scoped key, never
//          another tenant's providerKey/host cache row.
//  - fingerprint: server-written provider fingerprint when available.
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
  let identityId = "";
  let providerKey = "";
  try {
    const { data: verifiedLink } = await db
      .from("catalog_source_provider_identities")
      .select("identity_id,provider_key")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .maybeSingle();
    identityId = stringOr((verifiedLink as JsonRecord | null)?.identity_id, "");
    providerKey = stringOr((verifiedLink as JsonRecord | null)?.provider_key, "");
  } catch (_) { /* rolling migration: use the tenant-scoped fallback */ }
  const key = identityId || `source:${sourceId}`;
  const identity = { host, key, fingerprint: providerKey || key };
  sourceIdentityCache.set(cacheKey, identity);
  return identity;
}
// catalog_media_items keying stays on the hostname (its writer writes the hostname;
// re-keying it on providerKey is a scoped follow-up — see the dedup doc).
async function resolveSourceHost(sourceId: string, userId: string, db: SupabaseClient): Promise<string> {
  return (await resolveSourceIdentity(sourceId, userId, db)).host;
}
// Cross-mirror cache key for catalog_file_tracks. The fallback is source-scoped,
// so an owner-editable host cannot authorize a cross-tenant cache read/write.
async function resolveFileTracksKey(sourceId: string, userId: string, db: SupabaseClient, _fallbackUrl: string): Promise<string> {
  const { key } = await resolveSourceIdentity(sourceId, userId, db);
  return key || `source:${sourceId}`;
}

// Anti-ban footprint policy for a source's provider identity. Returns null unless the identity
// is marked low_footprint (provider_footprint_policy). When set, the audio-backfill runner routes
// probes through the gateway's residential IP and honours the hourly budget (provider_probe_hits).
async function getFootprint(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
): Promise<{ lowFootprint: boolean; identityKey: string; allowed: boolean; maxPerHour: number | null; hits: number } | null> {
  try {
    const ident = await resolveSourceIdentity(sourceId, userId, db);
    if (!ident.key) return null;
    const { data } = await db.rpc("provider_footprint_budget", { p_identity_key: ident.key });
    const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
    if (!row || stringOr(row.mode, "standard") !== "low_footprint") return null;
    return {
      lowFootprint: true,
      identityKey: ident.key,
      allowed: row.allowed !== false,
      maxPerHour: (row.max_probes_per_hour ?? null) as number | null,
      hits: Number(row.hits_last_hour ?? 0),
    };
  } catch (_) {
    return null;
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
//
// Resolution order (séries fix, post cron-audit): Ninja and Ferran REJECT the edge's direct
// datacenter-IP get_series_info — their séries sat at ~0 probed forever (5/37 999 and 7/10 676,
// every candidate noTarget), while Promax/super8k/Airysat/KING365 tolerate it. So:
//   1. cloud_series_info_cache — zero provider hit (filled by the fiche read-through);
//   2. the media gateway's /xtream/series-info — the residential IP the panel already trusts
//      (same path the fiche prewarm used; VLC UA like the gateway's streaming identity);
//   3. the historical direct call — kept for gateway-down / not-configured.
// Calls stay strictly sequential inside a probe tick (concurrency 1) — same single-connection
// discipline as before, just from an IP the panel accepts.
// emptySeries=true only when the GATEWAY returned an authoritative series-info payload (an `info`
// object — Xtream auth errors carry `user_info`, not `info`) that contains no episode: the série is
// an empty shell on the panel, a deterministic negative the caller may mark probed (180d window).
// Never inferred from the direct path (Ninja/Ferran feed junk to datacenter IPs) nor from the cache
// (could be stale) — a transient failure must stay indistinguishable from "retry next tick".
async function resolveSeriesEpisode(sourceId: string, seriesId: string, userId: string, db: SupabaseClient): Promise<{ url: string | null; emptySeries: boolean }> {
  const miss = { url: null, emptySeries: false };
  const cfg = await loadSourceConfig(sourceId, userId, db).catch(() => null);
  if (!cfg) return miss;
  const serverUrl = stringOr((cfg as JsonRecord).serverUrl, "");
  const username = stringOr((cfg as JsonRecord).username, "");
  const password = stringOr((cfg as JsonRecord).password, "");
  if (!serverUrl || !username || !password) return miss;
  let base: string;
  try { base = normalizeBaseUrl(serverUrl); } catch { return miss; }

  // episodes is keyed by season number ({"1":[...]}), but some panels return a plain array
  // (of season arrays or flat episode objects) — accept all three shapes; pick the first episode.
  const episodeUrlFrom = (info: JsonRecord | null): string | null => {
    const raw = info?.episodes;
    const groups: unknown[] = Array.isArray(raw)
      ? raw
      : isRecord(raw)
        ? Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((k) => (raw as JsonRecord)[k])
        : [];
    for (const group of groups) {
      const ep = recordOrEmpty(Array.isArray(group) ? group[0] : group);
      const epId = stringOr(ep.id, "");
      const container = stringOr(ep.container_extension, "mp4");
      if (epId) return xtreamStreamUrl({ serverUrl, username, password, streamType: "series", streamId: epId, container });
    }
    return null;
  };

  // 1) Series-info cache (keyed server_host + series_id, PK-indexed) — no provider hit at all.
  try {
    const host = new URL(base).host;
    const { data: row } = await db.from("cloud_series_info_cache")
      .select("payload").eq("server_host", host).eq("series_id", seriesId).maybeSingle();
    const cached = episodeUrlFrom(recordOrEmpty((row as JsonRecord | null)?.payload));
    if (cached) return { url: cached, emptySeries: false };
  } catch (_) { /* cache unavailable → fall through */ }

  // 2) Media gateway (residential IP): the only path Ninja/Ferran accept.
  try {
    const rc = await getRuntimeConfig(db);
    if (rc.mediaGatewayUrl && rc.mediaGatewayToken) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const resp = await fetch(`${rc.mediaGatewayUrl}/xtream/series-info`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${rc.mediaGatewayToken}` },
          body: JSON.stringify({ serverUrl, username, password, seriesId, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
        });
        if (resp.ok) {
          const body = recordOrEmpty(await resp.json().catch(() => null));
          const viaGateway = episodeUrlFrom(body);
          if (viaGateway) return { url: viaGateway, emptySeries: false };
          // Authoritative fiche with no episode → empty shell; skip the direct call (same
          // panel would give the same answer — one provider hit saved).
          if (isRecord(body.info)) return { url: null, emptySeries: true };
        }
      } finally { clearTimeout(timer); }
    }
  } catch (_) { /* gateway hiccup → fall through to direct */ }

  // 3) Historical direct call (works on panels that tolerate datacenter IPs).
  const api = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(api, { headers: { "user-agent": "NorvaCloud/1.0", accept: "application/json" } }).catch(() => null);
  if (!res || !res.ok) return miss;
  return { url: episodeUrlFrom((await res.json().catch(() => null)) as JsonRecord | null), emptySeries: false };
}

async function resolveSeriesEpisodeUrl(sourceId: string, seriesId: string, userId: string, db: SupabaseClient): Promise<string | null> {
  return (await resolveSeriesEpisode(sourceId, seriesId, userId, db)).url;
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
  scope: string | null = null,
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
    ...(scope ? { scope } : {}),
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
    const audioStreamIndex = boundedNullableInt(
      playbackHint.audioStreamIndex ?? playbackHint.audio_stream_index,
      0,
      1024,
    );
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
    return {
      status: "pending",
      session: data,
      hlsUrl: null,
      startupMs: null,
      audioStreamIndex,
      requestedSeekOffset: gatewayHints.seekOffset ?? 0,
      actualStartOffset: gatewayHints.seekOffset ?? 0,
      localSeekTarget: 0,
      sourceTimestamps: false,
    };
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
  // The gateway resolves the absolute ffmpeg stream index it actually mapped.
  // Preserve it end-to-end so the player can distinguish the requested track
  // from the browser/HLS default and avoid relabeling English as French.
  const audioStreamIndex = boundedNullableInt(
    gatewayBody.audioStreamIndex ??
      gatewayBody.audio_stream_index ??
      gatewayHints.audioStreamIndex ??
      gatewayHints.audio_stream_index,
    0,
    1024,
  );
  const requestedSeekOffset = boundedNullableNumber(
    gatewayBody.requestedSeekOffset ??
      gatewayBody.requested_seek_offset ??
      gatewayBody.seekOffset ??
      gatewayBody.seek_offset ??
      gatewayHints.seekOffset,
    0,
    24 * 60 * 60,
  ) ?? 0;
  const actualStartOffset = boundedNullableNumber(
    gatewayBody.actualStartOffset ??
      gatewayBody.actual_start_offset ??
      requestedSeekOffset,
    0,
    24 * 60 * 60,
  ) ?? requestedSeekOffset;
  const localSeekTarget = boundedNullableNumber(
    gatewayBody.localSeekTarget ??
      gatewayBody.local_seek_target ??
      Math.max(0, requestedSeekOffset - actualStartOffset),
    0,
    24 * 60 * 60,
  ) ?? Math.max(0, requestedSeekOffset - actualStartOffset);
  const sourceTimestamps = gatewayBody.sourceTimestamps === true
    || gatewayBody.source_timestamps === true;
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
  return {
    status: data.status,
    session: data,
    hlsUrl: data.hls_url,
    startupMs,
    audioMode,
    audioStreamIndex,
    requestedSeekOffset,
    actualStartOffset,
    localSeekTarget,
    sourceTimestamps,
    codecProfile,
  };
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
    !ENV_LID_WORKER_URL ||
    !ENV_LID_WORKER_TOKEN ||
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
    lidWorkerUrl: trimTrailingSlash(ENV_LID_WORKER_URL || fromDb.get("NORVA_LID_WORKER_URL") || ""),
    lidWorkerToken: ENV_LID_WORKER_TOKEN || fromDb.get("NORVA_LID_WORKER_TOKEN") || "",
    sourceConfigKey: ENV_SOURCE_CONFIG_KEY || fromDb.get("NORVA_SOURCE_CONFIG_KEY") || "",
    whisperDetect: (ENV_WHISPER_DETECT || fromDb.get("NORVA_WHISPER_DETECT") || "") === "true",
  };
  runtimeConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

// Dynamic, database-backed rollout policy. This deliberately does not piggyback on
// getRuntimeConfig(): that helper may skip the database when every secret comes from env,
// whereas an operational LID kill switch must take effect on both inline and fleet work
// within one short cache window. A read failure preserves the historical detector but fails
// closed for every detect-only scope.
async function getLidDetectionPolicy(db: SupabaseClient): Promise<LidDetectionPolicy> {
  if (lidDetectionPolicyCache && lidDetectionPolicyCache.expiresAt > Date.now()) {
    return lidDetectionPolicyCache.value;
  }
  let value: LidDetectionPolicy = {
    enabled: true,
    mode: "off",
    untaggedScope: null,
    taggedScope: null,
    cascadeMode: "off",
    cascadeScope: null,
    cascadePolicyVersion: null,
    cascadeSeed: null,
    cascadeShadowBps: 0,
    cascadeCanaryBps: 0,
    cascadeDailyCap: 0,
    cascadeAttemptsToday: 0,
    cascadeExpiresAt: null,
    cascadeTaggedWritesEnabled: false,
  };
  try {
    const { data, error } = await db
      .from("admin_feature_flags")
      .select("key,enabled")
      .in("key", [
        "audio_lid_enabled",
        "lid_detect_only_shadow_enabled",
        "lid_detect_only_production_enabled",
        "lid_cascade_shadow_enabled",
        "lid_cascade_canary_enabled",
        "lid_cascade_primary_enabled",
        "lid_cascade_tagged_writes_enabled",
      ]);
    if (error) throw error;
    const flags = new Map<string, boolean>();
    for (const row of data ?? []) {
      if (typeof row.key === "string") flags.set(row.key, row.enabled === true);
    }
    const enabled = !flags.has("audio_lid_enabled") || flags.get("audio_lid_enabled") === true;
    const primary = flags.get("lid_detect_only_production_enabled") === true;
    const shadow = flags.get("lid_detect_only_shadow_enabled") === true;
    const conflict = primary && shadow;
    const cascadeShadow = flags.get("lid_cascade_shadow_enabled") === true;
    const cascadeCanary = flags.get("lid_cascade_canary_enabled") === true;
    const cascadePrimary = flags.get("lid_cascade_primary_enabled") === true;
    const cascadeTaggedWritesEnabled = flags.get("lid_cascade_tagged_writes_enabled") === true;
    const cascadeStageCount = [cascadeShadow, cascadeCanary, cascadePrimary].filter(Boolean).length;
    value = {
      enabled,
      mode: !enabled ? "off" : (conflict ? "conflict" : (primary ? "primary" : (shadow ? "shadow" : "off"))),
      // Detect-only writes are restricted to previously untagged streams. A wrong tagged
      // correction can contaminate global union facets and is materially harder to roll back.
      untaggedScope: enabled && !conflict
        ? (primary ? "lid-production-detect-only" : (shadow ? "lid-shadow" : null))
        : null,
      // Shadow always returns the historical full-transcript verdict. Primary mode keeps
      // tagged verification entirely on that historical path.
      taggedScope: enabled && shadow && !conflict ? "lid-shadow" : null,
      cascadeMode: !enabled
        ? "off"
        : (
          cascadeStageCount > 1 || cascadeTaggedWritesEnabled || conflict ||
            (cascadeStageCount === 1 && (primary || shadow))
            ? "conflict"
            : (cascadePrimary ? "primary" : (cascadeCanary ? "canary" : (cascadeShadow ? "shadow" : "off")))
        ),
      cascadeScope: null,
      cascadePolicyVersion: null,
      cascadeSeed: null,
      cascadeShadowBps: 0,
      cascadeCanaryBps: 0,
      cascadeDailyCap: 0,
      cascadeAttemptsToday: 0,
      cascadeExpiresAt: null,
      cascadeTaggedWritesEnabled,
    };
    if (
      enabled &&
      value.cascadeMode !== "off" &&
      value.cascadeMode !== "conflict"
    ) {
      const { data: policyRow, error: policyError } = await db
        .from("audio_lid_cascade_policy")
        .select(
          "policy_version,rollout_seed,shadow_bps,canary_bps,daily_cap,expires_at",
        )
        .eq("singleton", true)
        .maybeSingle();
      if (policyError || !policyRow) throw policyError ?? new Error("Missing cascade policy");
      const policy = policyRow as JsonRecord;
      const policyVersion = stringOrNull(policy.policy_version);
      const rolloutSeed = stringOrNull(policy.rollout_seed);
      const shadowBps = boundedInt(policy.shadow_bps, 0, 0, 10_000);
      const canaryBps = boundedInt(policy.canary_bps, 0, 0, 10_000);
      const dailyCap = boundedInt(policy.daily_cap, 0, 0, 1_000_000);
      const expiresAt = stringOrNull(policy.expires_at);
      const expiryMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
      const activePolicy = (
        policyVersion === "lid-cascade-v1" &&
        Boolean(rolloutSeed) &&
        dailyCap > 0 &&
        Number.isFinite(expiryMs) &&
        expiryMs > Date.now() &&
        (value.cascadeMode !== "shadow" || shadowBps > 0) &&
        (value.cascadeMode !== "canary" || canaryBps > 0)
      );
      if (!activePolicy) {
        value = {
          ...value,
          cascadeMode: "conflict",
          cascadeScope: null,
          cascadePolicyVersion: policyVersion,
          cascadeSeed: null,
          cascadeShadowBps: shadowBps,
          cascadeCanaryBps: canaryBps,
          cascadeDailyCap: dailyCap,
          cascadeExpiresAt: expiresAt,
        };
      } else {
        const todayUtc = new Date();
        todayUtc.setUTCHours(0, 0, 0, 0);
        const { count, error: countError } = await db
          .from("catalog_audio_lid_attempts")
          .select("attempt_id", { count: "exact", head: true })
          .eq("policy_version", policyVersion)
          .gte("created_at", todayUtc.toISOString());
        if (countError) throw countError;
        value = {
          ...value,
          cascadeScope: value.cascadeMode === "shadow"
            ? "lid-cascade-shadow-v1"
            : (
              value.cascadeMode === "canary"
                ? "lid-cascade-untagged-canary-v1"
                : "lid-cascade-untagged-primary-v1"
            ),
          cascadePolicyVersion: policyVersion,
          cascadeSeed: rolloutSeed,
          cascadeShadowBps: shadowBps,
          cascadeCanaryBps: canaryBps,
          cascadeDailyCap: dailyCap,
          cascadeAttemptsToday: Math.max(0, count ?? 0),
          cascadeExpiresAt: expiresAt,
        };
      }
    }
  } catch (_) {
    // Historical behaviour remains available; no unsigned/implicit cascade mode is ever selected.
    value = {
      ...value,
      cascadeMode: value.cascadeMode === "off" ? "off" : "conflict",
      cascadeScope: null,
      cascadeSeed: null,
    };
  }
  lidDetectionPolicyCache = { value, expiresAt: Date.now() + 30_000 };
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
  const v = String(value || "").toLowerCase().trim().split(/[-_]/)[0];
  if (!v || ["un", "und", "mis", "mul", "zxx", "nar"].includes(v)) return null;
  const map: Record<string, string> = {
    alb: "sq", sqi: "sq", ara: "ar", arm: "hy", hye: "hy", baq: "eu", eus: "eu",
    ben: "bn", bos: "bs", bul: "bg", bur: "my", mya: "my", cat: "ca",
    chi: "zh", zho: "zh", cze: "cs", ces: "cs", dan: "da", dut: "nl", nld: "nl",
    eng: "en", est: "et", fil: "tl", fin: "fi", fre: "fr", fra: "fr",
    geo: "ka", kat: "ka", ger: "de", deu: "de", gre: "el", ell: "el",
    heb: "he", hin: "hi", hrv: "hr", hun: "hu", ice: "is", isl: "is",
    ind: "id", ita: "it", jpn: "ja", kor: "ko", lav: "lv", lit: "lt",
    mac: "mk", mkd: "mk", may: "ms", msa: "ms", nob: "no", nor: "no",
    per: "fa", fas: "fa", pol: "pl", por: "pt", rum: "ro", ron: "ro",
    rus: "ru", slo: "sk", slk: "sk", slv: "sl", spa: "es", srp: "sr",
    swe: "sv", tam: "ta", tel: "te", tha: "th", tur: "tr", ukr: "uk",
    urd: "ur", vie: "vi",
  };
  const code = map[v] || v;
  return /^[a-z]{2}$/.test(code) ? code : null;
}

type BasicLidEvidence = {
  accepted: boolean;
  lang: string | null;
  method: "whisper-detect-only-v1" | "whisper-basic-v1";
  fastPath: boolean;
  confidence: number;
};

type LidCascadeSelection = {
  mode: "shadow" | "canary" | "primary";
  scope:
    | "lid-cascade-shadow-v1"
    | "lid-cascade-untagged-canary-v1"
    | "lid-cascade-untagged-primary-v1";
  policyVersion: "lid-cascade-v1";
  cohortBucket: number;
};

const LID_CASCADE_PROTOCOL_VERSION = 2;
const LID_CASCADE_POLICY_VERSION = "lid-cascade-v1";
const LID_CASCADE_METHOD = "lid-cascade-v1";
const LID_CASCADE_MAX_WAV_BYTES = 1_572_864; // 1.5 MiB
const LID_CASCADE_SAMPLE_SECONDS = 20;
const LID_CASCADE_SAMPLE_OFFSETS = [60, 300, 900] as const;
const LID_CASCADE_DETECTED_ROUTES = new Set([
  "fast-consensus",
  "whisper-tiebreak",
  "full-transcript-fallback",
]);
const LID_CASCADE_PENDING_ROUTES = new Set([
  "pending-no-speech",
  "pending-disagreement",
]);
const LID_CASCADE_ROUTES = new Set([
  ...LID_CASCADE_DETECTED_ROUTES,
  ...LID_CASCADE_PENDING_ROUTES,
]);

async function selectLidCascadeCohort(
  policy: LidDetectionPolicy,
  serverHost: string,
  itemType: string,
  fileExternalId: string,
): Promise<LidCascadeSelection | null> {
  if (
    policy.cascadeMode === "off" ||
    policy.cascadeMode === "conflict" ||
    !policy.cascadeScope ||
    policy.cascadePolicyVersion !== LID_CASCADE_POLICY_VERSION ||
    !policy.cascadeSeed ||
    !serverHost ||
    itemType !== "movie" ||
    !fileExternalId ||
    policy.cascadeDailyCap <= 0 ||
    policy.cascadeAttemptsToday >= policy.cascadeDailyCap
  ) {
    return null;
  }
  const digest = await sha256Hex(
    `${policy.cascadeSeed}|${serverHost}|${itemType}|${fileExternalId}`,
  );
  const cohortBucket = Number.parseInt(digest.slice(0, 8), 16) % 10_000;
  const eligible = policy.cascadeMode === "primary" ||
    (policy.cascadeMode === "shadow" && cohortBucket < policy.cascadeShadowBps) ||
    (policy.cascadeMode === "canary" && cohortBucket < policy.cascadeCanaryBps);
  if (!eligible) return null;
  return {
    mode: policy.cascadeMode,
    scope: policy.cascadeScope as LidCascadeSelection["scope"],
    policyVersion: LID_CASCADE_POLICY_VERSION,
    cohortBucket,
  };
}

function lidCascadeResponseContainsMedia(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => lidCascadeResponseContainsMedia(entry, depth + 1));
  }
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    if (/^(audio|wav|transcript|transcription|text|samples?|pcm|payload)$/i.test(key)) {
      return true;
    }
    if (lidCascadeResponseContainsMedia(entry, depth + 1)) return true;
  }
  return false;
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        value.fill(0);
        await reader.cancel("bounded-body-limit").catch(() => {});
        throw new Error("response-body-too-large");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return result;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function persistLidCascadeOutcome(
  db: SupabaseClient,
  values: {
    attemptId: string;
    serverHost: string;
    itemType: string;
    fileExternalId: string;
    streamIndex: number;
    expectedAudioProbedAt: string;
    selection: LidCascadeSelection;
    route: string | null;
    status: "detected" | "pending" | "error";
    language: string | null;
    confidence: number | null;
    sampleSha256: string | null;
    sampleBytes: number | null;
    extractionMs: number | null;
    inferenceMs: number | null;
    evidence: JsonRecord;
  },
): Promise<JsonRecord | null> {
  const retryAt = values.status === "detected"
    ? null
    : new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { data, error } = await db.rpc("persist_catalog_audio_lid_outcome", {
    p_attempt_id: values.attemptId,
    p_server_host: values.serverHost,
    p_item_type: values.itemType,
    p_external_id: values.fileExternalId,
    p_stream_index: values.streamIndex,
    p_expected_audio_probed_at: values.expectedAudioProbedAt,
    p_policy_version: values.selection.policyVersion,
    p_rollout_mode: values.selection.mode,
    p_cohort_bucket: values.selection.cohortBucket,
    p_route: values.route,
    p_status: values.status,
    p_language: values.language,
    p_confidence: values.confidence,
    p_sample_sha256: values.sampleSha256,
    p_sample_bytes: values.sampleBytes,
    p_extraction_ms: values.extractionMs,
    p_inference_ms: values.inferenceMs,
    p_evidence: values.evidence,
    p_retry_at: retryAt,
  });
  if (error) throw error;
  return isRecord(data) ? data : null;
}

async function runLidCascadeAttempt(opts: {
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  userId: string;
  targetUrl: string;
  userAgent: string | null;
  track: {
    index: number;
    lang: string | null;
    lidAttemptedAt?: string | null;
    lidVerdict?: string | null;
    lidMethod?: string | null;
    lidConfidence?: number | null;
  };
  serverHost: string;
  itemType: string;
  fileExternalId: string;
  sessionId: string;
  expiresAt: string;
  selection: LidCascadeSelection;
}): Promise<boolean> {
  const {
    db, runtimeConfig, userId, targetUrl, userAgent, track, serverHost,
    itemType, fileExternalId, sessionId, expiresAt, selection,
  } = opts;
  const attemptId = crypto.randomUUID();
  let expectedAudioProbedAt = "";
  let wavBytes: Uint8Array | null = null;
  let sampleSha256: string | null = null;
  let extractionMs: number | null = null;
  let cascadeClaimed = false;
  let priorAttemptCount = 0;
  let phase: "preflight" | "extract" | "worker" | "validate" | "persist" = "preflight";
  try {
    const { data: canonicalData, error: canonicalError } = await db
      .from("catalog_file_tracks")
      .select("audio_tracks,audio_probed_at,audio_lang_verified_at")
      .eq("server_host", serverHost)
      .eq("item_type", itemType)
      .eq("external_id", fileExternalId)
      .maybeSingle();
    if (canonicalError || !canonicalData) return false;
    const canonical = canonicalData as JsonRecord;
    // Strict proof always wins. A stale caller must also never overwrite a language
    // that another worker filled after the candidate was read.
    if (canonical.audio_lang_verified_at) return false;
    expectedAudioProbedAt = stringOrNull(canonical.audio_probed_at) ?? "";
    if (!expectedAudioProbedAt) return false;
    const canonicalTrack = (Array.isArray(canonical.audio_tracks) ? canonical.audio_tracks : [])
      .find((candidate) =>
        isRecord(candidate) &&
        boundedNullableInt(candidate.index, 0, 1024) === track.index
      ) as JsonRecord | undefined;
    if (!canonicalTrack) return false;
    if (normalizeIsoLang(stringOrNull(canonicalTrack.lang ?? canonicalTrack.language))) return false;

    // Each retry advances to a different deterministic window. After every bounded
    // window was tried, hand the file back to the unchanged historical detector
    // instead of consuming the daily cascade budget forever on the same silence.
    const { count: priorAttempts, error: priorError } = await db
      .from("catalog_audio_lid_attempts")
      .select("attempt_id", { count: "exact", head: true })
      .eq("server_host", serverHost)
      .eq("item_type", itemType)
      .eq("external_id", fileExternalId)
      .eq("stream_index", track.index)
      .eq("policy_version", selection.policyVersion)
      .eq("rollout_mode", selection.mode);
    if (priorError) return false;
    priorAttemptCount = Math.max(0, priorAttempts ?? 0);
    if (
      (selection.mode === "shadow" && priorAttemptCount > 0) ||
      priorAttemptCount >= LID_CASCADE_SAMPLE_OFFSETS.length
    ) {
      return false;
    }

    // Re-read the global cap immediately before touching the provider. The
    // normal policy cache keeps fleet traffic cheap, but it must not allow a
    // sequential extraction to start after another request has just filled the
    // daily ledger. The SQL RPC remains the final atomic authority.
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const [
      { data: freshPolicy, error: freshPolicyError },
      { count: freshAttempts, error: freshAttemptsError },
    ] = await Promise.all([
      db.from("audio_lid_cascade_policy")
        .select("policy_version,daily_cap,expires_at")
        .eq("singleton", true)
        .maybeSingle(),
      db.from("catalog_audio_lid_attempts")
        .select("attempt_id", { count: "exact", head: true })
        .eq("policy_version", selection.policyVersion)
        .gte("created_at", todayUtc.toISOString()),
    ]);
    const freshCap = boundedInt(
      (freshPolicy as JsonRecord | null)?.daily_cap,
      0,
      0,
      1_000_000,
    );
    const freshExpiryMs = new Date(
      stringOrNull((freshPolicy as JsonRecord | null)?.expires_at) ?? "",
    ).getTime();
    if (
      freshPolicyError ||
      freshAttemptsError ||
      (freshPolicy as JsonRecord | null)?.policy_version !== selection.policyVersion ||
      freshCap <= 0 ||
      !Number.isFinite(freshExpiryMs) ||
      freshExpiryMs <= Date.now() ||
      Math.max(0, freshAttempts ?? 0) >= freshCap
    ) {
      return false;
    }

    phase = "extract";
    cascadeClaimed = true;
    const pipe = await createBytePipeAccess(
      sessionId,
      userId,
      targetUrl,
      expiresAt,
      db,
      userAgent,
      selection.scope,
    );
    const rawMarker = "/raw/";
    const rawMarkerAt = pipe.url.indexOf(rawMarker);
    if (rawMarkerAt < 0) throw new Error("gateway-assertion");
    const lidAssertion = pipe.url.slice(rawMarkerAt + rawMarker.length);
    if (!lidAssertion) throw new Error("gateway-assertion");
    // Provider credentials remain inside the HMAC assertion header. They never
    // enter a request path, reverse-proxy access log or worker payload.
    const extractUrl = `${runtimeConfig.mediaGatewayUrl}/extract-language-wav`;
    const start = LID_CASCADE_SAMPLE_OFFSETS[
      (selection.cohortBucket + track.index + priorAttemptCount) %
        LID_CASCADE_SAMPLE_OFFSETS.length
    ];
    const extractStartedAt = performance.now();
    const extractResponse = await fetch(extractUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
        "X-Norva-LID-Assertion": lidAssertion,
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({
        index: track.index,
        start,
        durationSeconds: LID_CASCADE_SAMPLE_SECONDS,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    extractionMs = Math.max(1, Math.round(performance.now() - extractStartedAt));
    // Gateway capacity rejection happens before provider I/O. It is not a
    // language attempt, must not consume the rollout cap, and must not fall
    // through to the legacy writer in this invocation. Gateway health keeps
    // the aggregate backpressure counter; the exact file remains retryable.
    if (extractResponse.status === 429) return true;
    if (!extractResponse.ok) {
      throw new Error(`gateway-status-${extractResponse.status}`);
    }
    const contentType = (extractResponse.headers.get("content-type") ?? "")
      .split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
      throw new Error("gateway-content-type");
    }
    const rawDeclaredLength = extractResponse.headers.get("content-length");
    const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
    if (
      declaredLength !== null &&
      (!Number.isInteger(declaredLength) || declaredLength <= 0 ||
        declaredLength > LID_CASCADE_MAX_WAV_BYTES)
    ) {
      throw new Error("gateway-wav-too-large");
    }
    wavBytes = await readBoundedResponseBytes(extractResponse, LID_CASCADE_MAX_WAV_BYTES);
    if (!wavBytes.byteLength || wavBytes.byteLength > LID_CASCADE_MAX_WAV_BYTES) {
      throw new Error("gateway-wav-size");
    }
    const declaredBytes = Number(extractResponse.headers.get("x-norva-sample-bytes"));
    if (!Number.isInteger(declaredBytes) || declaredBytes !== wavBytes.byteLength) {
      throw new Error("gateway-byte-count");
    }
    const sampleSeconds = Number(extractResponse.headers.get("x-norva-audio-seconds"));
    if (
      !Number.isFinite(sampleSeconds) ||
      sampleSeconds <= 0 ||
      sampleSeconds > LID_CASCADE_SAMPLE_SECONDS + 0.5
    ) {
      throw new Error("gateway-audio-duration");
    }
    sampleSha256 = await sha256BytesHex(wavBytes);
    const declaredSha256 = (
      extractResponse.headers.get("x-norva-sample-sha256") ??
      extractResponse.headers.get("x-norva-audio-sha256") ??
      extractResponse.headers.get("x-content-sha256") ??
      ""
    ).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(declaredSha256) || declaredSha256 !== sampleSha256) {
      throw new Error("gateway-sha256");
    }
    const gatewayExtractMs = boundedNullableInt(
      extractResponse.headers.get("x-norva-extract-ms"),
      1,
      60_000,
    );
    if (gatewayExtractMs !== null) extractionMs = gatewayExtractMs;

    phase = "worker";
    const workerStartedAt = performance.now();
    const workerResponse = await fetch(`${runtimeConfig.lidWorkerUrl}/v1/classify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeConfig.lidWorkerToken}`,
        "Content-Type": "audio/wav",
        Accept: "application/json",
        "X-Norva-Sample-Sha256": sampleSha256,
        "X-Norva-Lid-Attempt": attemptId,
        "X-Norva-Lid-Policy": selection.policyVersion,
        "X-Norva-Lid-Mode": selection.mode,
        "X-Norva-Lid-Protocol": String(LID_CASCADE_PROTOCOL_VERSION),
      },
      body: wavBytes,
      signal: AbortSignal.timeout(105_000),
    });
    const measuredInferenceMs = Math.max(1, Math.round(performance.now() - workerStartedAt));
    const workerContentType = (workerResponse.headers.get("content-type") ?? "")
      .split(";", 1)[0].trim().toLowerCase();
    if (workerContentType !== "application/json") {
      throw new Error("worker-content-type");
    }
    const rawResponseLength = workerResponse.headers.get("content-length");
    const responseLength = rawResponseLength === null ? null : Number(rawResponseLength);
    if (
      responseLength !== null &&
      (!Number.isInteger(responseLength) || responseLength < 0 || responseLength > 65_536)
    ) {
      throw new Error("worker-response-too-large");
    }
    const workerResponseBytes = await readBoundedResponseBytes(workerResponse, 65_536);
    const workerText = new TextDecoder().decode(workerResponseBytes);
    workerResponseBytes.fill(0);
    if (!workerResponse.ok) {
      throw new Error(`worker-status-${workerResponse.status}`);
    }
    phase = "validate";
    const workerBody = JSON.parse(workerText) as unknown;
    const workerResponseFields = new Set([
      "ok",
      "protocolVersion",
      "attemptId",
      "policyVersion",
      "mode",
      "method",
      "route",
      "language",
      "verified",
      "persisted",
      "sampleSha256",
      "sampleBytes",
      "timings",
      "evidence",
    ]);
    if (
      !isRecord(workerBody) ||
      Object.keys(workerBody).some((key) => !workerResponseFields.has(key)) ||
      workerBody.ok !== true ||
      workerBody.protocolVersion !== LID_CASCADE_PROTOCOL_VERSION ||
      workerBody.attemptId !== attemptId ||
      workerBody.policyVersion !== selection.policyVersion ||
      workerBody.mode !== selection.mode ||
      workerBody.method !== LID_CASCADE_METHOD ||
      workerBody.verified !== false ||
      workerBody.persisted !== false ||
      workerBody.sampleSha256 !== sampleSha256 ||
      workerBody.sampleBytes !== wavBytes.byteLength ||
      !isRecord(workerBody.timings) ||
      !isRecord(workerBody.evidence) ||
      lidCascadeResponseContainsMedia(workerBody)
    ) {
      throw new Error("worker-contract");
    }
    const route = stringOrNull(workerBody.route);
    if (!route || !LID_CASCADE_ROUTES.has(route)) {
      throw new Error("worker-route");
    }
    const rawLanguage = stringOrNull(workerBody.language);
    const language = normalizeIsoLang(rawLanguage);
    const detected = LID_CASCADE_DETECTED_ROUTES.has(route);
    if (
      (
        detected &&
        (!rawLanguage || rawLanguage !== rawLanguage.toLowerCase() || rawLanguage !== language)
      ) ||
      (!detected && rawLanguage !== null)
    ) {
      throw new Error("worker-language");
    }
    const timings = recordOrEmpty(workerBody.timings);
    const evidence = recordOrEmpty(workerBody.evidence);
    const serializedEvidence = JSON.stringify(evidence);
    if (serializedEvidence.length > 16_384) {
      throw new Error("worker-evidence-too-large");
    }
    const inferenceMs = boundedNullableInt(
      timings.inferenceMs ?? timings.totalMs ?? measuredInferenceMs,
      1,
      105_000,
    ) ?? measuredInferenceMs;
    const rawConfidence = evidence.confidence;
    if (
      (
        detected &&
        (
          typeof rawConfidence !== "number" ||
          !Number.isFinite(rawConfidence) ||
          rawConfidence < 0 ||
          rawConfidence > 1
        )
      ) ||
      (!detected && rawConfidence !== null)
    ) {
      throw new Error("worker-confidence");
    }
    const confidence = detected ? rawConfidence as number : null;
    const status = detected ? "detected" : "pending";
    phase = "persist";
    const persisted = await persistLidCascadeOutcome(db, {
      attemptId,
      serverHost,
      itemType,
      fileExternalId,
      streamIndex: track.index,
      expectedAudioProbedAt,
      selection,
      route,
      status,
      language: detected ? language : null,
      confidence,
      sampleSha256,
      sampleBytes: wavBytes.byteLength,
      extractionMs,
      inferenceMs,
      evidence: {
        protocolVersion: LID_CASCADE_PROTOCOL_VERSION,
        method: LID_CASCADE_METHOD,
        sampleSeconds,
        start,
        timings,
        classifier: evidence,
      },
    });
    if (
      selection.mode !== "shadow" &&
      detected &&
      language &&
      persisted?.persisted === true
    ) {
      track.lang = language;
      track.lidAttemptedAt = new Date().toISOString();
      track.lidVerdict = "detected";
      track.lidMethod = LID_CASCADE_METHOD;
      track.lidConfidence = confidence;
    }
  } catch (error) {
    if (!expectedAudioProbedAt) return cascadeClaimed;
    try {
      await persistLidCascadeOutcome(db, {
        attemptId,
        serverHost,
        itemType,
        fileExternalId,
        streamIndex: track.index,
        expectedAudioProbedAt,
        selection,
        route: null,
        status: "error",
        language: null,
        confidence: null,
        sampleSha256,
        sampleBytes: wavBytes?.byteLength ?? null,
        extractionMs,
        inferenceMs: null,
        evidence: {
          protocolVersion: LID_CASCADE_PROTOCOL_VERSION,
          phase,
          error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
        },
      });
    } catch (_) {
      // The attempt RPC is idempotent. A transient database failure remains retryable.
    }
  } finally {
    // The Edge never retains, logs, serializes or returns provider audio.
    wavBytes?.fill(0);
    wavBytes = null;
  }
  return cascadeClaimed;
}

// Keep the old >=4-word contract and add a distinct detect-only contract. In particular,
// wordCount=0 is correct for -dl and can never be confused with a transcript. The Edge
// independently enforces the 0.95 floor even if a gateway replica is misconfigured lower.
function basicLidEvidence(det: JsonRecord | null): BasicLidEvidence {
  const lang = normalizeIsoLang(stringOrNull(det?.language));
  const words = Number(det?.wordCount ?? 0);
  const confidence = Number(det?.confidence ?? 0);
  const fastPath = det?.method === "whisper-detect-only-v1";
  if (fastPath) {
    const accepted = Boolean(
      lang &&
      det?.confident === true &&
      det?.verified === false &&
      det?.fastPathAccepted === true &&
      det?.fallbackUsed === false &&
      det?.validationStatus === "pending" &&
      det?.evidence === "lid-only-high-confidence" &&
      Number.isFinite(confidence) &&
      confidence >= 0.95 &&
      confidence <= 1 &&
      words === 0,
    );
    return {
      accepted,
      lang,
      method: "whisper-detect-only-v1",
      fastPath: true,
      confidence,
    };
  }
  return {
    accepted: Boolean(lang && det?.confident === true && words >= 4),
    lang,
    method: "whisper-basic-v1",
    fastPath: false,
    confidence,
  };
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
  // A series variant identifies the parent series, while the probe below opens
  // one representative episode. Persisting that episode's absolute indices on
  // the parent makes every other episode appear to expose the same tracks.
  if (variantItemType === "series") return false;
  let targetUrl: string | null;
  const target = await resolvePlaybackTarget(sourceId, variantItemType, externalId, userId, db).catch(() => null);
  targetUrl = target?.targetUrl ?? null;
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
  audioValidationWrite = false,
  audioDetectionWrite = false,
): Promise<boolean> {
  if (!serverHost || !externalId || (!hasAudio && !hasSubtitle)) return false;
  const args = {
    p_server_host: serverHost,
    p_item_type: itemType,
    p_external_id: externalId,
    p_audio_tracks: audioTracks,
    p_subtitle_tracks: subtitleTracks,
    p_has_audio: hasAudio,
    p_has_subtitle: hasSubtitle,
  };
  try {
    const upsertRpc = audioValidationWrite
      ? "upsert_catalog_file_validated_tracks"
      : audioDetectionWrite
      ? "upsert_catalog_file_detected_tracks"
      : "upsert_catalog_file_tracks";
    const { error } = await db.rpc(
      upsertRpc,
      args,
    );
    if (error) return false;
  } catch (_) {
    return false;
  }
  // Fanout must use the canonical row after the upsert. Once speech validation
  // corrected a bad container tag, a later raw ffprobe may still report that
  // stale tag; forwarding the raw arguments would re-poison every owner even
  // when the canonical cache correctly preserved the verified language.
  let canonicalArgs = args;
  try {
    const { data: canonical } = await db.from("catalog_file_tracks")
      .select("audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at")
      .eq("server_host", serverHost)
      .eq("item_type", itemType)
      .eq("external_id", externalId)
      .maybeSingle();
    const row = canonical as JsonRecord | null;
    if (row) {
      canonicalArgs = {
        ...args,
        p_audio_tracks: Array.isArray(row.audio_tracks) ? row.audio_tracks : audioTracks,
        p_subtitle_tracks: Array.isArray(row.subtitle_tracks) ? row.subtitle_tracks : subtitleTracks,
        p_has_audio: hasAudio && Boolean(row.audio_probed_at),
        p_has_subtitle: hasSubtitle && Boolean(row.subtitle_probed_at),
      };
    }
  } catch (_) { /* rolling migration fallback uses the submitted map */ }
  try {
    const fanoutRpc = audioDetectionWrite
      ? "fanout_detected_file_tracks_to_users"
      : "fanout_file_tracks_to_users";
    const { data, error } = await db.rpc(fanoutRpc, canonicalArgs);
    const persisted = !error && Number(data) > 0;
    if (persisted && audioDetectionWrite && canonicalArgs.p_has_audio) {
      try {
        const { error: provenanceError } = await db.rpc(
          "refresh_catalog_file_audio_detection_provenance",
          {
            p_server_host: serverHost,
            p_item_type: itemType,
            p_external_id: externalId,
            p_audio_tracks: canonicalArgs.p_audio_tracks,
          },
        );
        if (provenanceError) {
          console.warn("[norva-playback] audio LID provenance refresh deferred");
        }
      } catch (_) {
        // Rolling migration fallback: per-track lidMethod remains durable and the next
        // detection write repairs the aggregate canonical/owner provenance.
      }
    }
    return persisted;
  } catch (_) {
    return false;
  }
}

// Distributed crawler lease: provider_account_busy protects human playback,
// while this prevents two autonomous workers from probing one canonical provider
// identity at the same time. Fail-open during a rolling migration so an older DB
// cannot take the whole enrichment fleet down; the viewer lock still applies.
async function claimProviderFileProbe(
  db: SupabaseClient,
  identityKey: string,
  owner: string,
  ttlSeconds = 150,
): Promise<boolean> {
  if (!identityKey || !owner) return true;
  try {
    const { data, error } = await db.rpc("claim_provider_file_probe", {
      p_identity_key: identityKey,
      p_lease_owner: owner,
      p_ttl_seconds: Math.max(30, Math.min(900, Math.round(ttlSeconds))),
    });
    if (error) return true;
    return data === true;
  } catch (_) {
    return true;
  }
}

async function releaseProviderFileProbe(
  db: SupabaseClient,
  identityKey: string,
  owner: string,
): Promise<void> {
  if (!identityKey || !owner) return;
  try {
    await db.rpc("release_provider_file_probe", {
      p_identity_key: identityKey,
      p_lease_owner: owner,
    });
  } catch (_) { /* lease expiry is the crash-safe fallback */ }
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
  audioTracks: Array<{
    index: number;
    lang: string | null;
    lidAttemptedAt?: string | null;
    lidVerdict?: string | null;
    lidMethod?: string | null;
    lidConfidence?: number | null;
    speechVerifiedAt?: string | null;
    speechVerdict?: string | null;
  }>;
  titleId: string;
  tmdbId: string | null;
  serverHost: string;
  itemType: string;
  fileExternalId: string;
  sessionId: string;
  expiresAt: string;
  variantId?: string;
  fileScoped?: boolean;
}): Promise<void> {
  const {
    db, runtimeConfig, userId, targetUrl, userAgent, audioTracks, titleId, tmdbId,
    serverHost, itemType, fileExternalId, sessionId, expiresAt, variantId,
    fileScoped = false,
  } = opts;
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) return;
  const lidPolicy = await getLidDetectionPolicy(db);
  if (!lidPolicy.enabled) return;
  const unknownTracks = audioTracks.filter((t) =>
    !normalizeIsoLang(t.lang) && Number.isInteger(t.index)
  );
  if (!unknownTracks.length) return;
  // Cascade rollout is exact-file only. Once its signed WAV extraction is claimed,
  // this invocation never falls through to the legacy detector: doing so would turn
  // a shadow/pending/error result into an accidental production write.
  if (
    fileScoped &&
    runtimeConfig.lidWorkerUrl &&
    runtimeConfig.lidWorkerToken
  ) {
    const cascadeTrack = unknownTracks.find((track) => !track.lidAttemptedAt) ?? unknownTracks[0];
    const cascadeSelection = await selectLidCascadeCohort(
      lidPolicy,
      serverHost,
      itemType,
      fileExternalId,
    );
    if (cascadeTrack && cascadeSelection) {
      const cascadeHandled = await runLidCascadeAttempt({
        db,
        runtimeConfig,
        userId,
        targetUrl,
        userAgent,
        track: cascadeTrack,
        serverHost,
        itemType,
        fileExternalId,
        sessionId,
        expiresAt,
        selection: cascadeSelection,
      });
      if (cascadeHandled) return;
    }
  }
  // The proven basic detector sweeps bounded offsets inside the gateway and stops on the first
  // clear 20s speech window. Two tracks per file keep a two-file fleet claim inside its 540s
  // request budget even when every gateway call reaches the 120s shadow-safe timeout. Per-track
  // cursors make
  // larger multi-audio files resumable without forcing strict multi-window consensus.
  const pending = unknownTracks.filter((t) => !t.lidAttemptedAt).slice(0, 2);

  // Gateway byte-pipe token → derive the /detect-language base from the /raw URL. The gateway
  // extracts a WAV per track, runs whisper.cpp + a transcript detector locally (no paid API,
  // no relay round-trip), and returns the language. ENRICH-only.
  const nowIso = new Date().toISOString();
  if (pending.length) {
    try {
      const pipe = await createBytePipeAccess(
        sessionId,
        userId,
        targetUrl,
        expiresAt,
        db,
        userAgent,
        // Primary writes are limited to canonical exact-file identities. Legacy title-only
        // rows keep the full transcript path; shadow remains safe because it returns that
        // same historical verdict.
        fileScoped
          ? lidPolicy.untaggedScope
          : (lidPolicy.mode === "shadow" ? "lid-shadow" : null),
      );
      const detectBase = pipe.url.replace("/raw/", "/detect-language/");
      for (const track of pending) {
        try {
          const res = await fetch(
            `${detectBase}?index=${track.index}&dur=20`,
            { signal: AbortSignal.timeout(120_000) },
          );
          // Transport/provider failures are not observations. Leave only this track due instead
          // of suppressing it for the retry window; another track may still be readable.
          if (!res.ok) continue;
          const det = await res.json().catch(() => null) as JsonRecord | null;
          const evidence = basicLidEvidence(det);
          track.lidAttemptedAt = nowIso;
          // The legacy path still needs >=4 transcript words. Detect-only instead carries
          // an explicit high-confidence evidence contract and correctly reports zero words.
          if (evidence.accepted && evidence.lang) {
            track.lang = evidence.lang;
            track.lidVerdict = "detected";
            track.lidMethod = evidence.method;
            track.lidConfidence = evidence.confidence;
          } else {
            track.lidVerdict = "pending";
          }
        } catch (_) {
          // Best-effort per track: a transient failure keeps this exact cursor retryable.
        }
      }
    } catch (_) {
      return;
    }
  }

  const complete = unknownTracks.every((t) =>
    Boolean(normalizeIsoLang(t.lang) || t.lidAttemptedAt)
  );
  const enriched = audioTracks.map((t) => ({
    index: t.index,
    lang: t.lang ?? null,
    ...(!complete && t.lidAttemptedAt
      ? { lidAttemptedAt: t.lidAttemptedAt, lidVerdict: t.lidVerdict ?? null }
      : {}),
    ...(t.lidMethod
      ? {
        lidMethod: t.lidMethod,
        lidConfidence: typeof t.lidConfidence === "number" && Number.isFinite(t.lidConfidence)
          ? t.lidConfidence
          : null,
      }
      : {}),
    ...(t.speechVerifiedAt && t.speechVerdict === "detected"
      ? { speechVerifiedAt: t.speechVerifiedAt, speechVerdict: t.speechVerdict }
      : {}),
  }));
  const detectionMethods = [...new Set(
    enriched.map((t) => t.lidMethod).filter((method): method is string => Boolean(method)),
  )].sort();
  const detectOnlyDetectedCount = enriched.filter(
    (t) => t.lidMethod === "whisper-detect-only-v1",
  ).length;
  const transcriptDetectedCount = enriched.filter(
    (t) => t.lidMethod === "whisper-basic-v1",
  ).length;
  const codes = [...new Set(enriched.map((t) => t.lang).filter((l): l is string => Boolean(l)))].sort();
  if (fileScoped) {
    const persisted = await shareFileTracks(
      db,
      serverHost,
      itemType,
      fileExternalId,
      enriched,
      [],
      true,
      false,
      false,
      true,
    );
    // Do not remove the candidate from the queue until the exact-file cache and
    // tenant fanout actually accepted the detected map.
    if (!persisted) return;
  } else {
    try {
      await db.from("cloud_titles").update({
        audio_tracks: enriched,
        audio_languages: codes,
        audio_probed_at: nowIso,
        ...(complete && !enriched.some((t) => !normalizeIsoLang(t.lang))
          ? { whisper_attempted_at: nowIso }
          : {}),
      })
        .eq("user_id", userId).eq("id", titleId);
    } catch (_) { /* best-effort legacy title persist */ }
  }
  // A global title-language UNION cannot cheaply unlearn one wrong canary result. Keep
  // detect-only evidence exact-file/tenant scoped until calibration promotes the engine;
  // historical transcript results retain the existing global merge.
  if (
    detectOnlyDetectedCount === 0 &&
    codes.length &&
    tmdbId &&
    !/^(tt)?0+$/i.test(tmdbId)
  ) {
    try { await db.rpc("merge_catalog_title_audio", { p_item_type: itemType, p_provider_tmdb_id: tmdbId, p_codes: codes }); } catch (_) { /* best-effort global mirror */ }
  }
  if (!fileScoped) {
    try {
      await shareFileTracks(
        db, serverHost, itemType, fileExternalId, enriched, [],
        true, false, false, true,
      );
    } catch (_) { /* best-effort */ }
  }
  if (!complete) return;

  const pendingCount = enriched.filter((t) => !normalizeIsoLang(t.lang)).length;
  const completed = pendingCount === 0;
  const retryAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  if (fileScoped && variantId) {
    try {
      const { data, error } = await db.rpc("record_catalog_file_audio_whisper_outcome", {
        p_server_host: serverHost,
        p_item_type: itemType,
        p_external_id: fileExternalId,
        p_completed: completed,
        p_attempted_at: nowIso,
        p_retry_at: completed ? null : retryAt,
        p_provenance: {
          method: detectOnlyDetectedCount > 0
            ? "whisper-detect-only-v1"
            : "whisper-basic-v1",
          detectionMethods,
          status: completed ? "detected" : "pending",
          sampleDurationSeconds: 20,
          consensus: 1,
          acceptance: "explicit-gateway-evidence-v2",
          detectOnlyDetectedCount,
          transcriptDetectedCount,
          trackCount: unknownTracks.length,
          pendingCount,
          attemptedAt: nowIso,
        },
      });
      if (error || data !== true) {
        await db.from("cloud_title_variants")
          .update(completed
            ? { audio_whisper_attempted_at: nowIso, audio_whisper_retry_at: null }
            : { audio_whisper_retry_at: retryAt })
          .eq("user_id", userId).eq("id", variantId);
      }
    } catch (_) { /* rolling migration fallback retries naturally */ }
  }
}

// Verify TAGGED-but-contradictory tracks (mistagged containers — "German" on a French film).
// Providers mux scene releases with wrong container language tags; the probe stores tags as-is
// and whisper LID only ever ran on UNTAGGED tracks, so a wrong tag was permanent and
// user-visible (player audio menu prefers cloud audio_tracks; language filters use
// audio_languages). This listens to the ACTUAL speech via the gateway's whisper.cpp and
// rewrites the track lang after the basic detector finds a clear speech window (at least 4 words).
// Returns "corrected" | "detected" | "pending" — or null on a TRANSIENT failure (byte-pipe
// down, every clip 503/timeout), which must NOT mark the title verified (retry next tick).
// A non-verdict is a retryable "pending" state, never a guessed language.
async function verifyTaggedAudioLanguages(opts: {
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  userId: string;
  targetUrl: string;
  audioTracks: Array<{
    index: number;
    lang: string | null;
    speechVerifiedAt?: string | null;
    speechVerdict?: string | null;
  }>;
  suspectLangs: string[];
  titleId: string;
  tmdbId: string | null;
  serverHost: string;
  itemType: string;
  fileExternalId: string;
  expiresAt: string;
  variantId?: string;
  fileScoped?: boolean;
}): Promise<"corrected" | "detected" | "pending" | "partial" | null> {
  const {
    db, runtimeConfig, userId, targetUrl, audioTracks, suspectLangs, titleId,
    tmdbId, serverHost, itemType, fileExternalId, expiresAt, variantId,
    fileScoped = false,
  } = opts;
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) return null;
  const lidPolicy = await getLidDetectionPolicy(db);
  if (!lidPolicy.enabled) return null;
  const nowIso = new Date().toISOString();
  const detectionMethods = new Set<string>();
  const recordDetection = async (
    completed: boolean,
    provenance: JsonRecord,
    extra: JsonRecord = {},
  ) => {
    const detected = stringOr(provenance.status, "") === "detected";
    const retryAt = new Date(
      Date.now() + (detected ? 90 : 1) * 24 * 3600 * 1000,
    ).toISOString();
    try {
      if (fileScoped && variantId) {
        const { data, error } = await db.rpc("record_catalog_file_audio_whisper_outcome", {
          p_server_host: serverHost,
          p_item_type: itemType,
          p_external_id: fileExternalId,
          p_completed: completed,
          p_attempted_at: nowIso,
          // A completed basic detection is deliberately revisited after 90
          // days, but it never creates or clears strict verification proof.
          p_retry_at: retryAt,
          p_provenance: provenance,
        });
        // Rolling-migration/cache-miss fallback remains exact-tenant scoped
        // and only advances the basic-detector cursor. In particular it must
        // never null audio_lang_verified_at from a stronger historical proof.
        if (error || data !== true) {
          await db.from("cloud_title_variants")
            .update(completed
              ? { audio_whisper_attempted_at: nowIso, audio_whisper_retry_at: retryAt }
              : { audio_whisper_retry_at: retryAt })
            .eq("user_id", userId).eq("id", variantId);
        }
      } else {
        await db.from("cloud_titles").update({
          ...extra,
          ...(completed ? { whisper_attempted_at: nowIso } : {}),
        })
          .eq("user_id", userId).eq("id", titleId);
      }
    } catch (_) { /* best-effort marker */ }
  };
  const taggedTracks = audioTracks.filter(
    (t) => t.lang && suspectLangs.includes(t.lang) && Number.isInteger(t.index),
  );
  // Keep the historical two-track cap. The gateway sweeps offsets internally and returns after
  // the first clear 20s speech window, so two tracks remain bounded while multi-audio files stay
  // resumable through the per-track cursor.
  const suspects = taggedTracks.filter((t) => !t.speechVerifiedAt).slice(0, 2);
  const finalizeVerification = async (extra: JsonRecord = {}) => {
    const confirmedCount = taggedTracks.filter((t) => t.speechVerdict === "confirmed").length;
    const correctedCount = taggedTracks.filter((t) => t.speechVerdict === "corrected").length;
    const pendingVerdictCount = taggedTracks.filter((t) => t.speechVerdict === "pending").length;
    const detectedCount = taggedTracks.filter((t) => t.speechVerdict === "detected").length;
    const pendingCount = taggedTracks.filter(
      (t) => !t.speechVerifiedAt ||
        !["confirmed", "corrected", "detected", "pending"].includes(String(t.speechVerdict || "")),
    ).length;
    const classified = taggedTracks.length > 0 &&
      pendingCount === 0 &&
      pendingVerdictCount === 0 &&
      audioTracks.every((track) => Boolean(track.lang)) &&
      confirmedCount + correctedCount + detectedCount === taggedTracks.length;
    // Basic one-window LID is valuable detection evidence, not a strict
    // certificate. Persist the corrected map and a long retry cursor, but never
    // create audio_verified_at or a user-facing "confirmed" claim.
    await recordDetection(classified, {
      method: "whisper-basic-v1",
      detectionMethods: [...detectionMethods].sort(),
      status: classified ? "detected" : "pending",
      sampleDurationSeconds: 20,
      consensus: 1,
      minWords: 4,
      trackCount: taggedTracks.length,
      confirmedCount,
      correctedCount,
      detectedCount,
      pendingVerdictCount,
      pendingCount,
      attemptedAt: nowIso,
    }, extra);
    if (!classified) return "pending" as const;
    return correctedCount > 0 ? "corrected" as const : "detected" as const;
  };
  if (!suspects.length) return await finalizeVerification();
  let detectBase: string;
  try {
    const pipe = await createBytePipeAccess(
      "whisper-verify",
      userId,
      targetUrl,
      expiresAt,
      db,
      null,
      lidPolicy.taggedScope,
    );
    detectBase = pipe.url.replace("/raw/", "/detect-language/");
  } catch (_) { return null; }

  let changed = false, transient = 0, attempted = 0;
  for (const t of suspects) {
    try {
      const res = await fetch(
        `${detectBase}?index=${t.index}&dur=20`,
        { signal: AbortSignal.timeout(120_000) },
      );
      if (!res.ok) { transient++; continue; } // incl. the gateway's 503 account-slot-busy
      const det = await res.json().catch(() => null) as JsonRecord | null;
      const evidence = basicLidEvidence(det);
      const lang = evidence.lang;
      if (!evidence.accepted || !lang) {
        t.speechVerifiedAt = nowIso;
        t.speechVerdict = "pending";
        attempted++;
        continue;
      }
      detectionMethods.add(evidence.method);
      t.speechVerifiedAt = nowIso;
      t.speechVerdict = lang === t.lang ? "confirmed" : "corrected";
      attempted++;
      if (lang === t.lang) continue;
      t.lang = lang;
      changed = true;
    } catch (_) { transient++; }
  }

  {
    if (!attempted) {
      if (transient > 0) return null;
      return "pending";
    }
    const complete = taggedTracks.every((t) => Boolean(t.speechVerifiedAt));
    // Keep the cursor while a large file is partial; strip it once complete so
    // the variant-level 90-day recheck can sample every track again.
    const enriched = audioTracks.map((t) => ({
      index: t.index,
      lang: t.lang ?? null,
      ...(!complete && t.speechVerifiedAt
        ? { speechVerifiedAt: t.speechVerifiedAt, speechVerdict: t.speechVerdict ?? null }
        : {}),
    }));
    const codes = [...new Set(enriched.map((t) => t.lang).filter((l): l is string => Boolean(l)))].sort();
    if (fileScoped) {
      const persisted = await shareFileTracks(
        db,
        serverHost,
        itemType,
        fileExternalId,
        enriched,
        [],
        true,
        false,
        false,
        true,
      );
      if (!persisted) return null;
    } else if (!complete) {
      try {
        await db.from("cloud_titles").update({ audio_tracks: enriched })
          .eq("user_id", userId).eq("id", titleId);
      } catch (_) { return null; }
    }
    // NOTE: the global mirror is a race-safe UNION — it gains the corrected lang but cannot
    // unlearn the wrong one (union semantics protect other panels' genuinely-foreign files).
    if (changed && codes.length && tmdbId && !/^(tt)?0+$/i.test(tmdbId)) {
      try { await db.rpc("merge_catalog_title_audio", { p_item_type: itemType, p_provider_tmdb_id: tmdbId, p_codes: codes }); } catch (_) { /* best-effort */ }
    }
    if (!fileScoped) {
      try {
        await shareFileTracks(
          db, serverHost, itemType, fileExternalId, enriched, [],
          true, false, false, true,
        );
      } catch (_) { /* best-effort */ }
    }
    if (!complete) return "partial";
    return await finalizeVerification(
      fileScoped ? {} : { audio_tracks: enriched, audio_languages: codes },
    );
  }
}

// Resolve the parent title plus the exact variant codec profile. The parent is
// used only for single-version backwards compatibility; all multi-version track
// indices come from the exact file cache/profile. A series episode id is still
// distinct from its parent series title id.
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
    .select("id,title_id,external_id,codec_profile")
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
    .select("id, variant_count, audio_tracks, subtitle_tracks, subtitle_probed_at, provider_tmdb_id")
    .eq("user_id", userId)
    .eq("id", titleId)
    .maybeSingle();
  return row
    ? {
      ...(row as EngineTitleRow),
      variant_id: String((variant as JsonRecord | null)?.id ?? ""),
      variant_external_id: String((variant as JsonRecord | null)?.external_id ?? ""),
      variant_codec_profile: recordOrEmpty((variant as JsonRecord | null)?.codec_profile),
    }
    : null;
}

type EngineTitleRow = {
  id: string;
  variant_count: number;
  variant_id: string;
  variant_external_id: string;
  variant_codec_profile: JsonRecord;
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
// For series, `externalId` is historically AMBIGUOUS: service callers (title variants, the
// whitelist cron) carry the SERIES id, while the player carries the EPISODE id it is watching.
// Only series ids exist as catalog items — episodes never do — so the catalog row decides:
// series id → fiche path (first episode, unchanged for crons); no row → treat it as an episode
// and build its URL directly (resolvePlaybackTarget's series fallback), so per-episode artifacts
// (storyboards, player-triggered transcriptions) read the frames actually on screen.
async function resolveVariantUrl(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  externalId: string,
  itemType: string,
  opts: { container?: string; forbidSeriesFiche?: boolean } = {},
): Promise<string | null> {
  const hint = opts.container ? { container: opts.container } : {};
  if (itemType !== "series") {
    return ((await resolvePlaybackTarget(sourceId, itemType, externalId, userId, db, hint).catch(() => null))?.targetUrl ?? null);
  }
  let isSeriesId = false;
  if (mediaReadFromCatalog()) {
    const host = await resolveSourceHost(sourceId, userId, db).catch(() => "");
    if (host) {
      const { data } = await db.from("catalog_media_items").select("external_id")
        .eq("server_host", host).eq("item_type", "series").eq("external_id", externalId).maybeSingle();
      isSeriesId = Boolean(data);
    }
  }
  if (!isSeriesId) {
    const { data } = await db.from("cloud_media_items").select("external_id")
      .eq("source_id", sourceId).eq("user_id", userId).eq("item_type", "series").eq("external_id", externalId).maybeSingle();
    isSeriesId = Boolean(data);
  }
  if (isSeriesId) {
    // Defense in depth for viewer-origin transcriptions: the fiche path silently transcribes the
    // FIRST episode and caches it under the SERIES id — a viewer watching S3E7 would get S1E1
    // subtitles presented as legitimate. Only the crons may take this path knowingly.
    if (opts.forbidSeriesFiche) {
      throw new HttpError(422, "a series id was given — AI subtitles need the specific episode id");
    }
    return await resolveSeriesEpisodeUrl(sourceId, externalId, userId, db).catch(() => null);
  }
  return ((await resolvePlaybackTarget(sourceId, "series", externalId, userId, db, hint).catch(() => null))?.targetUrl ?? null);
}

// ── Viewer transcription budget (anti-abuse) ─────────────────────────────────
// Every transcription/OCR is a FULL provider read (up to ~30 min of stream pull per attempt) plus
// a whisper/tesseract run on the single-lane gateway. Opening the option to every VOD (movies,
// episodes, titles that already have tracks) multiplies the clickable surface, so viewer-origin
// enqueues are budgeted: counted as EVENTS in generated_subtitle_requests at enqueue time (rows in
// the cross-user cache can be re-claimed/taken over without a new row — counting those would let
// retry loops and force replays bypass any cap). Cache hits never reach these counters.
const VIEWER_TRANSCRIBE_DAILY_USER_CAP = 10;      // per user, transcript+ocr combined
const VIEWER_TRANSCRIBE_DAILY_IDENTITY_CAP = 15;  // per provider identity, all users combined

async function assertViewerTranscribeBudget(db: SupabaseClient, userId: string, providerKey: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: byUser } = await db.from("generated_subtitle_requests")
    .select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);
  if ((byUser ?? 0) >= VIEWER_TRANSCRIBE_DAILY_USER_CAP) {
    throw new HttpError(429, "AI subtitle daily limit reached — try again tomorrow");
  }
  if (providerKey) {
    const { count: byIdentity } = await db.from("generated_subtitle_requests")
      .select("id", { count: "exact", head: true }).eq("provider_key", providerKey).gte("created_at", since);
    if ((byIdentity ?? 0) >= VIEWER_TRANSCRIBE_DAILY_IDENTITY_CAP) {
      throw new HttpError(429, "AI subtitle daily limit reached for this provider — try again tomorrow");
    }
  }
}

// Best-effort event record (one row per REAL enqueue accepted by the gateway).
async function recordViewerTranscribeRequest(db: SupabaseClient, userId: string, providerKey: string, kind: string): Promise<void> {
  try {
    await db.from("generated_subtitle_requests").insert({ user_id: userId, provider_key: providerKey, kind });
  } catch (_) { /* accounting must never fail the enqueue */ }
}

// Phase 3 (3a) ASYNC enqueue: kick off a background full-film transcription on the gateway and
// cache the VTT cross-user (keyed by providerKey + file) when it calls back. Returns immediately.
// 'ready' short-circuits straight from the cache. Shared by the service `transcribe-enqueue` mode
// and the user-authed POST generated-subtitle route, so the trigger logic lives in exactly one place.
async function transcribeEnqueue(
  db: SupabaseClient,
  userId: string,
  runtimeConfig: RuntimeConfig,
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string; index?: number; start?: number; dur?: number; force?: boolean; respectFailedCooldown?: boolean; origin?: string },
): Promise<JsonRecord> {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, opts);
  // origin drives the gateway's priority classes AND the viewer-only guards below.
  const origin = ["viewer", "service", "pregen"].includes(stringOr(opts.origin, "")) ? stringOr(opts.origin, "") : "service";
  // Low-footprint identities (e.g. the re-provisioned Ninja account, capped 60 probes/h after the
  // July 3 ban) must not take full-file viewer reads: a transcription is a far heavier provider
  // fingerprint than a probe, and PROVIDER-ANTIBAN-NINJA.md gates whisper on an observation window
  // that hasn't passed. Refuse cleanly; the player shows an honest "not available on this provider".
  if (origin === "viewer") {
    const fp = await getFootprint(db, sourceId, userId);
    if (fp?.lowFootprint) throw new HttpError(429, "AI subtitles temporarily unavailable on this provider");
  }
  const tUrl = await resolveVariantUrl(db, userId, sourceId, externalId, itemType, { forbidSeriesFiche: origin === "viewer" });
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
  // Viewer budget AFTER the cache fast-paths (a capped user keeps full access to everything
  // already generated) and BEFORE the claim (an over-cap request must not steal the claim).
  if (origin === "viewer") await assertViewerTranscribeBudget(db, userId, pkey);
  // Atomically claim the job. The RPC's ON CONFLICT ... WHERE makes "take over the row" a single
  // race-free decision, so two concurrent triggers can't both enqueue a duplicate transcription
  // onto the single-slot gateway: exactly one wins and proceeds, the loser reuses the live job.
  // A still-fresh 'processing' row (within the TTL) blocks takeover; a stale one is reclaimed.
  const PROCESSING_TTL_MS = 90 * 60 * 1000;
  const jobId = crypto.randomUUID();
  const { data: claim, error: claimErr } = await db.rpc("claim_generated_subtitle_job", {
    p_provider_key: pkey, p_item_type: itemType, p_external_id: externalId, p_kind: "transcript", p_lang: "src",
    p_new_job_id: jobId, p_processing_ttl_ms: PROCESSING_TTL_MS, p_force: opts.force === true,
    p_claimed_by: userId, // whose provider slot the job's ffmpeg will hold → this account's crons yield
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
  const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
  // origin (hoisted above, it also drives the viewer guards) sets the gateway's priority class:
  // a viewer waiting in front of the player jumps ahead of the nightly pregen batch.
  const asyncUrl = `${pipe.url.replace("/raw/", "/transcribe-async/")}?index=${idx}&jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&start=${bStart}&dur=${bDur}&origin=${origin}`;
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const gw = await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (_) { gwStatus = 0; }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    // An enqueue failure is terminal like a callback failure: resolve any pending email/bell
    // subscriptions instead of leaving them orphaned forever (audit 2026-07-17, gap n°3).
    try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "transcript", lang: "src", status: "failed" }); }
    catch (_) { /* best-effort */ }
    return { status: "error", jobId, providerKey: pkey, gatewayStatus: gwStatus, gateway: gwBody };
  }
  // One budget event per REAL accepted enqueue (a full provider read will follow) — never for
  // cache hits, lost claims, or gateway refusals above.
  if (origin === "viewer") await recordViewerTranscribeRequest(db, userId, pkey, "transcript");
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
  opts: { titleId?: string; sourceId?: string; externalId?: string; itemType?: string; index?: number; lang?: string; fmt?: string; force?: boolean; origin?: string },
): Promise<JsonRecord> {
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) throw new HttpError(503, "Media gateway is not configured");
  const idx = Number(opts.index);
  if (!Number.isInteger(idx) || idx < 0) throw new HttpError(400, "a valid subtitle stream index is required for OCR");
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, opts);
  const origin = ["viewer", "service", "pregen"].includes(stringOr(opts.origin, "")) ? stringOr(opts.origin, "") : "service";
  // Same viewer guards as transcribeEnqueue: OCR is a full provider sub-stream read too.
  if (origin === "viewer") {
    const fp = await getFootprint(db, sourceId, userId);
    if (fp?.lowFootprint) throw new HttpError(429, "AI subtitles temporarily unavailable on this provider");
  }
  const tUrl = await resolveVariantUrl(db, userId, sourceId, externalId, itemType, { forbidSeriesFiche: origin === "viewer" });
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
  if (origin === "viewer") await assertViewerTranscribeBudget(db, userId, pkey);
  const PROCESSING_TTL_MS = 90 * 60 * 1000;
  const jobId = crypto.randomUUID();
  const { data: claim, error: claimErr } = await db.rpc("claim_generated_subtitle_job", {
    p_provider_key: pkey, p_item_type: itemType, p_external_id: externalId, p_kind: "ocr", p_lang: cacheLang,
    p_new_job_id: jobId, p_processing_ttl_ms: PROCESSING_TTL_MS, p_force: opts.force === true,
    p_claimed_by: userId, // whose provider slot the job's ffmpeg will hold → this account's crons yield
  });
  if (claimErr) throwDb(claimErr, "ocr enqueue claim failed");
  const claimRow = (Array.isArray(claim) ? claim[0] : claim) as JsonRecord | null;
  if (!claimRow?.won) {
    return { status: stringOr(claimRow?.status, "processing"), cached: true, jobId: claimRow?.job_id ?? null, providerKey: pkey, kind: "ocr", lang };
  }
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const pipe = await createBytePipeAccess("ocr-job", userId, tUrl, exp, db, null);
  const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
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
    try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "ocr", lang: cacheLang, status: "failed" }); }
    catch (_) { /* best-effort */ }
    return { status: "error", jobId, providerKey: pkey, kind: "ocr", lang, gatewayStatus: gwStatus, gateway: gwBody };
  }
  if (origin === "viewer") await recordViewerTranscribeRequest(db, userId, pkey, "ocr");
  return { status: "processing", jobId, providerKey: pkey, kind: "ocr", lang, gateway: gwBody };
}

// ISO 639-2 "no real language" codes (und=undetermined, mul=multiple, zxx=no linguistic content,
// mis=uncoded). They satisfy the [a-z]{2,3} shape but Argos has no model for them, so translating TO
// one is a guaranteed gateway 422 → never enqueue such a job (both enqueue paths guard on this set).
const NON_TRANSLATABLE_LANGS = new Set(["und", "mul", "zxx", "mis"]);

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
  if (NON_TRANSLATABLE_LANGS.has(target)) {
    // Undetermined / no-language target: Argos can't translate to it (gateway 422). Return a clean
    // status instead of enqueuing a job that is guaranteed to fail and leave a "failed" cache row.
    return { status: "unsupported-target", kind: "translation", lang: target };
  }
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

  const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
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
    try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "translation", lang: target, status: "failed" }); }
    catch (_) { /* best-effort */ }
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
  const COLS = "status, vtt, source_lang, segments, audio_sec, job_id, updated_at, error, stage, claimed_by";
  let { data: row } = await db.from("catalog_generated_subtitles")
    .select(COLS)
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", kind).eq("lang", cacheLang).maybeSingle();
  // Transition fallback: a VTT generated before the identity re-key still lives under the raw
  // providerKey until the cache backfill moves it — serve it instead of regenerating.
  if (!row && ident.fingerprint && ident.fingerprint !== pkey) {
    ({ data: row } = await db.from("catalog_generated_subtitles")
      .select(COLS)
      .eq("provider_key", ident.fingerprint).eq("item_type", itemType).eq("external_id", externalId)
      .eq("kind", kind).eq("lang", cacheLang).maybeSingle());
  }
  const rec = row as JsonRecord | null;
  if (!rec) return { status: "none", providerKey: pkey, kind, lang };
  const status = stringOr(rec.status, "none");
  const partialVtt = status === "processing" ? stringOr(rec.vtt, "") : "";
  return {
    status, kind, lang, providerKey: pkey, jobId: rec.job_id ?? null,
    sourceLang: rec.source_lang ?? null, segments: rec.segments ?? null, audioSec: rec.audio_sec ?? null,
    updatedAt: rec.updated_at ?? null,
    // The real failure cause (creds-redacted at the source) — the player shows a short human
    // reason and keeps the full text in a tooltip, instead of a blind "failed — retry".
    error: status === "failed" ? stringOrNull(rec.error) : null,
    // Honest progress: gateway heartbeats stamp the stage (queued/deferred/extracting/
    // transcribing); "deferred because of YOUR playback" only when the requester is the claimer.
    stage: status === "processing" ? stringOrNull(rec.stage) : null,
    deferredByYou: status === "processing" && stringOr(rec.stage, "") === "deferred" && stringOr(rec.claimed_by, "") === userId,
    // Progressive delivery: a partial VTT streams in while transcription continues.
    partial: Boolean(partialVtt),
    vtt: status === "ready" ? stringOr(rec.vtt, "") : (partialVtt || null),
  };
}

// ==================== Seek-thumbnail storyboards ====================
// Netflix-style scrubber previews. Cross-user cached like the AI subtitles
// (provider_key + item_type + external_id); the sprite JPEG lives in the public
// norva-storyboards bucket, generated by the gateway from ONE provider
// connection that the pregen gate defers while the account is watching.

const STORYBOARD_BUCKET = "norva-storyboards";

function storyboardPath(pkey: string, itemType: string, externalId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${safe(pkey)}/${safe(itemType)}-${safe(externalId)}.jpg`;
}

async function getStoryboard(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const url = new URL(req.url);
  const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, {
    titleId: stringOr(url.searchParams.get("titleId"), ""),
    sourceId: stringOr(url.searchParams.get("sourceId"), ""),
    externalId: stringOr(url.searchParams.get("externalId"), ""),
    itemType: stringOr(url.searchParams.get("itemType"), ""),
  });
  // `why` on every early exit: the player ignores it (only reads status), but it
  // makes a silent "none" diagnosable straight from the browser's Network tab.
  const pkey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  if (!pkey) return { status: "none", why: "no-provider-key" };

  const { data: row } = await db.from("catalog_storyboards")
    .select("status, sprite_path, tile_cols, tile_rows, tile_count, interval_sec, job_id, updated_at, error")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId).maybeSingle();
  const rec = row as JsonRecord | null;
  if (rec?.status === "ready") {
    // Time-axis self-heal: a sprite enqueued before the film's duration was known
    // was built on an ASSUMED grid (the gateway defaults to 2h), so for a longer
    // film every hover past the covered range clamps onto the last tile — the
    // "same preview image for the whole second half" bug. When the player now
    // reports a real duration materially beyond the sprite's coverage, fall
    // through and regenerate (the upsert reuses the same sprite_path; storage
    // overwrites in place). Non-enqueue readers keep the old sprite meanwhile.
    const covered = (Number(rec.tile_count) || 0) * (Number(rec.interval_sec) || 0);
    const reqDuration = Math.max(0, Number(url.searchParams.get("duration")) || 0);
    const axisStale = covered > 0 && reqDuration > covered * 1.2 && url.searchParams.get("enqueue") === "1";
    if (!axisStale) {
      const spriteUrl = `${PUBLIC_ORIGIN}/storage/v1/object/public/${STORYBOARD_BUCKET}/${stringOr(rec.sprite_path, "")}`;
      return {
        status: "ready", spriteUrl,
        cols: rec.tile_cols ?? 10, rows: rec.tile_rows ?? 1,
        count: rec.tile_count ?? 0, intervalSec: rec.interval_sec ?? 0,
      };
    }
  }
  const ageMs = rec ? Date.now() - Date.parse(stringOr(rec.updated_at, "")) : Infinity;
  // A live processing row (heartbeat-fresh) blocks re-enqueue; stale/failed rows may retry.
  if (rec?.status === "processing" && ageMs < 2 * 3600 * 1000) return { status: "processing" };
  if (rec?.status === "failed" && ageMs < 24 * 3600 * 1000) return { status: "failed", error: stringOrNull(rec.error) };
  if (url.searchParams.get("enqueue") !== "1") return { status: rec ? stringOr(rec.status, "none") : "none", why: "not-enqueued" };

  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) return { status: "none", why: "gateway-not-configured" };
  // Container of the episode being watched (player-provided) — keeps the direct
  // episode URL honest for non-mp4 files on panels that 404 a wrong extension.
  const container = stringOr(url.searchParams.get("container"), "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const tUrl = await resolveVariantUrl(db, userId, sourceId, externalId, itemType, container ? { container } : {});
  if (!tUrl) return { status: "none", why: "no-playback-target" };

  const jobId = crypto.randomUUID();
  const spritePath = storyboardPath(pkey, itemType, externalId);
  const { error: upsertErr } = await db.from("catalog_storyboards").upsert({
    provider_key: pkey, item_type: itemType, external_id: externalId,
    status: "processing", sprite_path: spritePath, job_id: jobId, error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider_key,item_type,external_id" });
  if (upsertErr) throwDb(upsertErr, "storyboard upsert failed");

  // Signed upload URL: the gateway PUTs the sprite without ever holding a service key.
  const { data: signed, error: signErr } = await db.storage.from(STORYBOARD_BUCKET)
    .createSignedUploadUrl(spritePath, { upsert: true });
  if (signErr || !signed?.signedUrl) {
    await db.from("catalog_storyboards").update({ status: "failed", error: "signed upload unavailable", updated_at: new Date().toISOString() }).eq("job_id", jobId);
    return { status: "failed", error: "storage unavailable" };
  }

  const duration = Math.max(0, Number(url.searchParams.get("duration")) || 0);
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const pipe = await createBytePipeAccess("storyboard-job", userId, tUrl, exp, db, null);
  const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/storyboard-callback`;
  // The signed upload URL is minted against the internal SUPABASE_URL; rewrite its
  // origin to the public one so the external gateway can PUT to it (token stays valid).
  const uploadUrl = signed.signedUrl.replace(SUPABASE_URL, PUBLIC_ORIGIN);
  const asyncUrl = `${pipe.url.replace("/raw/", "/storyboard-async/")}?jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&uploadUrl=${encodeURIComponent(uploadUrl)}&duration=${duration}&origin=service`;
  let gwStatus = 0;
  try { gwStatus = (await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) })).status; } catch (_) { gwStatus = 0; }
  if (gwStatus !== 202) {
    await db.from("catalog_storyboards").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    return { status: "failed", error: `gateway ${gwStatus}` };
  }
  return { status: "processing", enqueued: true };
}

async function runStoryboardCallback(req: Request, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!runtimeConfig.mediaGatewayToken || provided !== runtimeConfig.mediaGatewayToken) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const jobId = stringOr(body.jobId, "");
  if (!jobId) throw new HttpError(400, "jobId is required");
  const nowIso = new Date().toISOString();
  // Gateway heartbeats (queued/deferred/extracting) just keep the row fresh.
  if (body.heartbeat === true) {
    await db.from("catalog_storyboards").update({ updated_at: nowIso }).eq("job_id", jobId).eq("status", "processing");
    return { ok: true, heartbeat: true, jobId };
  }
  if (body.ok === true) {
    await db.from("catalog_storyboards").update({
      status: "ready",
      tile_cols: Number(body.cols) || 10,
      tile_rows: Number(body.rows) || 1,
      tile_count: Number(body.count) || 0,
      interval_sec: Number(body.intervalSec) || 0,
      error: null,
      updated_at: nowIso,
    }).eq("job_id", jobId);
    return { ok: true, jobId };
  }
  await db.from("catalog_storyboards").update({
    status: "failed", error: stringOr(body.error, "unknown").slice(0, 400), updated_at: nowIso,
  }).eq("job_id", jobId);
  return { ok: true, jobId, failed: true };
}

// Phase 3 (3a) user-facing trigger: a viewer asks for AI subtitles on a title with no usable subs.
// Enqueues a full-film transcription (dur 0) — cross-user cached, so the first viewer pays the cost
// and the rest get it free. Returns immediately; the client polls GET generated-subtitle.
async function postGeneratedSubtitle(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  // Phase 4: an OCR request (kind='ocr') routes to the tesseract path for an image-sub track.
  // force is NOT honored on the user route (below too): p_force bypasses both the ready fast-path
  // and the processing TTL, i.e. it re-burns a full provider read + gateway lane on a title that
  // is already done — with it, any daily cap is a fiction. It stays a service/admin affordance.
  if (stringOr(body.kind, "transcript") === "ocr") {
    return await ocrEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""), sourceId: stringOr(body.sourceId, ""), externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""),
      index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
      lang: stringOr(body.lang, ""), fmt: stringOr(body.fmt, ""), force: false, origin: "viewer",
    });
  }
  // Phase 3b: a translation request (kind='translation' or a target lang) routes to the Argos path.
  const target = stringOr(body.targetLang, "").toLowerCase();
  if (stringOr(body.kind, "transcript") === "translation" || (target && target !== "src")) {
    const tr = await translateEnqueue(db, userId, runtimeConfig, {
      titleId: stringOr(body.titleId, ""), sourceId: stringOr(body.sourceId, ""), externalId: stringOr(body.externalId, ""),
      itemType: stringOr(body.itemType, ""), targetLang: target, force: body.force === true,
    });
    // Chained click (language picked at click time, body.chain): no transcript yet → record the
    // intention SERVER-SIDE as a 'pending-transcript' translation row (it survives closing the
    // tab — the transcript callback resolves it) and kick the transcript in the same call.
    if (body.chain === true && target && stringOr(tr.status, "") === "transcript-required") {
      const { sourceId, externalId, itemType } = await resolveSubtitleTarget(db, userId, {
        titleId: stringOr(body.titleId, ""), sourceId: stringOr(body.sourceId, ""), externalId: stringOr(body.externalId, ""),
        itemType: stringOr(body.itemType, ""),
      });
      const pkey = stringOr(tr.providerKey, "");
      if (pkey && /^[a-z]{2,3}$/.test(target)) {
        const nowIso = new Date().toISOString();
        // Never clobbers a live/ready row (insert-if-absent)…
        await db.from("catalog_generated_subtitles").upsert({
          provider_key: pkey, item_type: itemType, external_id: externalId, kind: "translation", lang: target,
          status: "pending-transcript", job_id: crypto.randomUUID(), error: null, claimed_by: userId, updated_at: nowIso,
        }, { onConflict: "provider_key,item_type,external_id,kind,lang", ignoreDuplicates: true });
        // …but a previously-FAILED translation must not block the fresh chain: flip it to pending.
        await db.from("catalog_generated_subtitles")
          .update({ status: "pending-transcript", claimed_by: userId, error: null, updated_at: nowIso })
          .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
          .eq("kind", "translation").eq("lang", target).eq("status", "failed");
      }
      const t = await transcribeEnqueue(db, userId, runtimeConfig, {
        titleId: stringOr(body.titleId, ""), sourceId, externalId, itemType, origin: "viewer",
      });
      return { kind: "transcript", lang: "src", chained: target, ...t };
    }
    return tr;
  }
  const r = await transcribeEnqueue(db, userId, runtimeConfig, {
    titleId: stringOr(body.titleId, ""),
    sourceId: stringOr(body.sourceId, ""),
    externalId: stringOr(body.externalId, ""),
    itemType: stringOr(body.itemType, ""),
    index: Number.isInteger(Number(body.index)) ? Number(body.index) : undefined,
    force: false, // never honored on the user route — see the OCR branch note above
    origin: "viewer", // a human is waiting in front of the player — outranks the pregen batch
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
  const titleLabel = stringOr(body.titleLabel, "").slice(0, 300) || null;
  const seriesId = stringOr(body.seriesId, "").slice(0, 100) || null;
  const subRow = {
    user_id: userId, email, provider_key: pkey, item_type: itemType, external_id: externalId,
    kind, lang, title_label: titleLabel, source_id: sourceId || null, series_id: seriesId,
  };

  // Late-opt-in race + orphan rescue (audit 2026-07-17): the client polls every 20-60 s, so a
  // viewer can flip the chip AFTER the callback already fan-outed — the pending row would then
  // never resolve (the dispatch only fires once, at the terminal callback). If the cache row is
  // ALREADY terminal, answer NOW instead of registering a promise nobody will keep: ready with
  // speech → send the email immediately (+ bell); no speech / failed → refuse honestly so the
  // client reverts the chip. Only reachable in that race window (the chip renders only while the
  // client believes 'processing'), so the immediate send can't be farmed for email spam.
  const { data: cacheRow } = await db.from("catalog_generated_subtitles")
    .select("status, segments")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", kind).eq("lang", lang).maybeSingle();
  const cacheStatus = stringOr((cacheRow as JsonRecord | null)?.status, "");
  if (cacheStatus === "ready" || cacheStatus === "failed") {
    const hasSpeech = cacheStatus === "ready" && Number((cacheRow as JsonRecord | null)?.segments ?? 0) > 0;
    if (!hasSpeech) {
      return { ok: false, enabled: false, reason: cacheStatus === "ready" ? "finished — no speech detected" : "generation already failed" };
    }
    const sent = await sendSubtitleReadyEmail(email, titleLabel ?? "", subtitleWatchRoute(subRow as unknown as JsonRecord) || undefined);
    try { await insertSubtitleBellEvents(db, [subRow as unknown as JsonRecord], "ready"); } catch (_) { /* best-effort */ }
    const { error } = await db.from("catalog_generated_subtitle_notifications").upsert({
      ...subRow, status: sent ? "sent" : "failed", created_at: nowIso, sent_at: nowIso,
    }, { onConflict: "user_id,provider_key,item_type,external_id,kind,lang" });
    if (error) throwDb(error, "notify registration failed");
    return { ok: true, enabled: true, already: "ready", emailed: sent };
  }

  const { error } = await db.from("catalog_generated_subtitle_notifications").upsert({
    ...subRow, status: "pending", created_at: nowIso, sent_at: null,
  }, { onConflict: "user_id,provider_key,item_type,external_id,kind,lang" });
  if (error) throwDb(error, "notify registration failed");
  return { ok: true, enabled: true };
}

// Deep-link route to a title's fiche (no origin, no leading slash): the app resolves
// "#movies/open:<sourceId>:<streamId>:<title>" / "#series/open:<sourceId>:<seriesId>:<title>" at
// boot via openFicheFromRoute (app.js). Episodes are cached by EPISODE id but the fiche opens by
// SERIES id — series_id is stored at opt-in for exactly this; rows that predate it (or a
// non-cloud source id) return "" and the caller falls back to the site root.
function subtitleWatchRoute(sub: JsonRecord): string {
  const src = stringOr(sub.source_id, "");
  if (!/^[0-9a-f-]{36}$/i.test(src)) return "";
  const title = stringOr(sub.title_label, "").slice(0, 120);
  const enc = (s: string) => encodeURIComponent(s);
  if (stringOr(sub.item_type, "") === "series") {
    const seriesId = stringOr(sub.series_id, "");
    return seriesId ? `series/open:${enc(src)}:${enc(seriesId)}:${enc(title)}` : "";
  }
  const extId = stringOr(sub.external_id, "");
  return extId ? `movies/open:${enc(src)}:${enc(extId)}:${enc(title)}` : "";
}

// In-app bell entries (second notification channel — the email used to be the ONLY one; a closed
// tab with no email opt-in learned nothing). One cloud_content_events row per subscriber; the
// bell's catalog branch renders them as-is, and payload.watch makes the entry a deep link into
// the fiche. Also rings on 'empty'/'failed' — the silent-outcome gap of the 2026-07-17 audit.
async function insertSubtitleBellEvents(db: SupabaseClient, subs: JsonRecord[], outcome: "ready" | "empty" | "failed"): Promise<void> {
  const rows = subs
    .map((s) => {
      const title = stringOr(s.title_label, "") || "your film";
      const summary = outcome === "ready"
        ? `AI subtitles ready — ${title}`
        : outcome === "empty"
          ? `AI subtitles finished for “${title}” — no speech detected`
          : `AI subtitles for “${title}” failed — you can retry from the captions menu`;
      const src = stringOr(s.source_id, "");
      const route = subtitleWatchRoute(s);
      return {
        user_id: stringOr(s.user_id, ""),
        source_id: /^[0-9a-f-]{36}$/i.test(src) ? src : null,
        kind: `subtitle_${outcome}`,
        summary: summary.slice(0, 300),
        payload: {
          itemType: stringOr(s.item_type, ""), externalId: stringOr(s.external_id, ""),
          kind: stringOr(s.kind, "transcript"), lang: stringOr(s.lang, "src"),
          ...(route && outcome === "ready" ? { watch: route } : {}),
        },
      };
    })
    .filter((r) => r.user_id);
  if (!rows.length) return;
  const { error } = await db.from("cloud_content_events").insert(rows);
  if (error) console.error("[norva-playback] subtitle bell event insert failed", error.message);
}

// Branded, email-client-safe "your subtitles are ready" HTML (tables + inline styles, dark theme),
// mirroring norva-auth-email so the two transactional senders look like one product. `ctaUrl` deep
// links straight to the title's fiche when the subscription carries enough identity for one.
function subtitleReadyEmailHtml(titleLabel: string, siteUrl: string, ctaUrl?: string): string {
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
          <a href="${ctaUrl || siteUrl}" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">${ctaUrl ? "Watch with AI subtitles" : "Open Norva"}</a>
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
// `watchRoute` (from subtitleWatchRoute) turns the CTA into a deep link to the title's fiche —
// without it the button lands on the site root and the viewer has to find the film by hand.
async function sendSubtitleReadyEmail(to: string, titleLabel: string, watchRoute?: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
  const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://norva.tv").replace(/\/+$/, "");
  if (!key || !to) return false;
  const ctaUrl = watchRoute ? `${site}/app.html#${watchRoute}` : "";
  const subject = `Your AI subtitles for “${titleLabel || "your film"}” are ready — Norva`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html: subtitleReadyEmailHtml(titleLabel, site, ctaUrl || undefined) }),
    });
    if (!res.ok) { console.error("[norva-playback] subtitle-ready email failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("[norva-playback] subtitle-ready email error", String(e)); return false; }
}

// Fan out pending "email me" subscriptions for a transcript that just finished. Ready WITH speech
// → email each subscriber (deep-linked to the fiche) and mark 'sent'. Ready but EMPTY (no
// dialogue) → mark 'skipped' (nothing to show, so no email). Failed → mark 'failed'. Every
// outcome ALSO rings the in-app bell — email stops being the only channel, and a subscriber whose
// generation ended without speech/failed finally learns the result somewhere.
async function dispatchSubtitleNotifications(db: SupabaseClient, row: JsonRecord | null): Promise<void> {
  if (!row) return;
  const status = stringOr(row.status, "");
  if (status !== "ready" && status !== "failed") return;
  const providerKey = stringOr(row.provider_key, ""), itemType = stringOr(row.item_type, "");
  const externalId = stringOr(row.external_id, ""), kind = stringOr(row.kind, "transcript"), lang = stringOr(row.lang, "src");
  if (!providerKey || !externalId) return;
  const { data: subs } = await db.from("catalog_generated_subtitle_notifications")
    .select("id, user_id, email, title_label, source_id, series_id, item_type, external_id, kind, lang")
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
    try { await insertSubtitleBellEvents(db, rows, status === "ready" ? "empty" : "failed"); }
    catch (e) { console.error("[norva-playback] bell fan-out failed", String(e)); }
    return;
  }
  for (const s of rows) {
    const ok = await sendSubtitleReadyEmail(stringOr(s.email, ""), stringOr(s.title_label, ""), subtitleWatchRoute(s) || undefined);
    await db.from("catalog_generated_subtitle_notifications")
      .update({ status: ok ? "sent" : "failed", sent_at: nowIso }).eq("id", String(s.id));
  }
  try { await insertSubtitleBellEvents(db, rows, "ready"); }
  catch (e) { console.error("[norva-playback] bell fan-out failed", String(e)); }
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

  // NON-TERMINAL heartbeat: the gateway stamps the job's stage (queued/deferred/extracting/
  // transcribing) and keeps updated_at fresh — a live job deferred for hours is no longer
  // reaped at 2h nor re-claimed at 90min mid-flight. Never touches status.
  if (body.heartbeat === true) {
    const stage = ["queued", "deferred", "extracting", "transcribing"].includes(stringOr(body.stage, ""))
      ? stringOr(body.stage, "") : null;
    await db.from("catalog_generated_subtitles")
      .update({ stage, updated_at: nowIso })
      .eq("job_id", jobId).eq("status", "processing"); // never resurrect a terminal row
    return { ok: true, heartbeat: true, jobId, stage };
  }

  // NON-TERMINAL partial delivery (V2 chunked pipeline): a growing VTT streams in while the
  // transcription continues — the player attaches it minutes after the real start.
  if (body.partial === true) {
    await db.from("catalog_generated_subtitles")
      .update({
        vtt: stringOr(body.vtt, ""), source_lang: stringOrNull(body.sourceLang),
        segments: Number.isFinite(Number(body.segments)) ? Number(body.segments) : null,
        stage: "transcribing", updated_at: nowIso,
      })
      .eq("job_id", jobId).eq("status", "processing");
    return { ok: true, partial: true, jobId };
  }

  const patch: JsonRecord = body.ok === true
    ? { status: "ready", vtt: stringOr(body.vtt, ""), source_lang: stringOrNull(body.sourceLang),
        audio_sec: Number.isFinite(Number(body.audioSec)) ? Number(body.audioSec) : null,
        segments: Number.isFinite(Number(body.segments)) ? Number(body.segments) : null, error: null, stage: null, updated_at: nowIso }
    : { status: "failed", error: stringOr(body.error, "unknown").slice(0, 300), stage: null, updated_at: nowIso };
  const { data: updated, error } = await db.from("catalog_generated_subtitles").update(patch).eq("job_id", jobId)
    .select("provider_key, item_type, external_id, kind, lang, status, segments, source_lang, vtt, claimed_by").maybeSingle();
  if (error) throwDb(error, "transcribe callback update failed");
  // Server-side translation chaining: a transcript landing (ready OR failed) resolves every
  // 'pending-transcript' intention recorded at click time — works with the viewer's tab closed.
  const updRec = updated as JsonRecord | null;
  if (updRec && stringOr(updRec.kind, "") === "transcript") {
    try { await resolvePendingTranslations(db, runtimeConfig, updRec); }
    catch (e) { console.error("[norva-playback] pending-translation chain failed", String(e)); }
  }
  // Email anyone who opted in for this transcript (best-effort: a send/dispatch failure here must
  // not fail the callback, or the gateway will think the result was lost and the row stays stuck).
  try { await dispatchSubtitleNotifications(db, updated as JsonRecord | null); }
  catch (e) { console.error("[norva-playback] notify dispatch failed", String(e)); }
  return { ok: true, jobId, status: patch.status };
}

// Resolve the 'pending-transcript' translation intentions of a transcript that just landed:
// same language → served the transcript directly (zero cost); translatable → POST the gateway's
// pure-CPU /translate-async (no provider connection, ~20-45s/film — the subtitle in the picked
// language arrives ~1 min after the transcript, tab open or not); untranslatable/failed source →
// the pending row is failed with a clear reason (never left orphaned — the reaper also backstops
// at 24h). Each pending row is claimed via a status-guarded UPDATE, so a concurrent viewer click
// (translateEnqueue) and this chain can't double-enqueue.
async function resolvePendingTranslations(db: SupabaseClient, runtimeConfig: RuntimeConfig, tr: JsonRecord) {
  const pkey = stringOr(tr.provider_key, ""), itemType = stringOr(tr.item_type, ""), externalId = stringOr(tr.external_id, "");
  if (!pkey || !itemType || !externalId) return;
  const { data: pendings } = await db.from("catalog_generated_subtitles")
    .select("lang")
    .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", "translation").eq("status", "pending-transcript");
  const rows = (pendings ?? []) as JsonRecord[];
  if (!rows.length) return;
  const nowIso = new Date().toISOString();
  const ready = stringOr(tr.status, "") === "ready";
  const vtt = stringOr(tr.vtt, "");
  const segments = Number(tr.segments ?? 0);
  const sourceLang = (stringOr(tr.source_lang, "") || "en").toLowerCase();
  const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
  for (const p of rows) {
    const target = stringOr(p.lang, "");
    if (!target) continue;
    const failPending = async (msg: string) => {
      await db.from("catalog_generated_subtitles")
        .update({ status: "failed", error: msg.slice(0, 300), updated_at: nowIso })
        .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
        .eq("kind", "translation").eq("lang", target).eq("status", "pending-transcript");
      // A dead chained translation is terminal for its subscribers too — resolve, don't orphan.
      try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "translation", lang: target, status: "failed" }); }
      catch (_) { /* best-effort */ }
    };
    if (NON_TRANSLATABLE_LANGS.has(target.toLowerCase())) { await failPending("unsupported translation target (no language model)"); continue; }
    if (!ready) { await failPending("source transcript failed"); continue; }
    if (!vtt || segments <= 0) { await failPending("no speech in the source transcript"); continue; }
    if (sourceLang === target) {
      // The film already speaks the requested language — the transcript IS the answer.
      const { data: upd } = await db.from("catalog_generated_subtitles")
        .update({ status: "ready", vtt, source_lang: sourceLang, segments, error: null, stage: null, updated_at: nowIso })
        .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
        .eq("kind", "translation").eq("lang", target).eq("status", "pending-transcript")
        .select("lang").maybeSingle();
      if (upd) {
        try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "translation", lang: target, status: "ready", segments }); }
        catch (_) { /* best-effort */ }
      }
      continue;
    }
    if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) { await failPending("translation gateway not configured"); continue; }
    const jobId = crypto.randomUUID();
    const { data: claimed } = await db.from("catalog_generated_subtitles")
      .update({ status: "processing", job_id: jobId, error: null, stage: null, updated_at: nowIso })
      .eq("provider_key", pkey).eq("item_type", itemType).eq("external_id", externalId)
      .eq("kind", "translation").eq("lang", target).eq("status", "pending-transcript")
      .select("lang").maybeSingle();
    if (!claimed) continue; // raced away (a viewer click claimed it first)
    let gwStatus = 0, gwErr = "";
    try {
      const gw = await fetch(`${runtimeConfig.mediaGatewayUrl}/translate-async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
        body: JSON.stringify({ jobId, callback: cbUrl, source: sourceLang, target, vtt }),
        signal: AbortSignal.timeout(20000),
      });
      gwStatus = gw.status;
      if (gwStatus !== 202) gwErr = stringOr(((await gw.json().catch(() => null)) as JsonRecord | null)?.error, "");
    } catch (_) { gwStatus = 0; }
    if (gwStatus !== 202) {
      await db.from("catalog_generated_subtitles")
        .update({ status: "failed", error: (gwErr || `translate gateway ${gwStatus}`).slice(0, 300), updated_at: nowIso })
        .eq("job_id", jobId);
    }
  }
}

// Crawl-yield governance. Default ON since 2026-07-10 (458 incident, docs/LIVE-TV-458-SLOT-
// CONTENTION.md): the autonomous crawl yields the provider's single connection slot to a live
// human aggressively — (1) the "recently active" window below widens to CRAWL_VIEWER_GRACE_MS
// (covers the grace tail after a viewer stops — the ~8s the provider is slow to free the slot +
// reconnect churn), and (2) the crawl re-checks MID-TICK (see runOneDimension loop) so a viewer
// who starts DURING a ~100s tick isn't collided with. Cost: one indexed read every few batches.
// Set NORVA_CRAWL_YIELD_TO_VIEWERS=false to restore the pre-incident behaviour.
const CRAWL_YIELD_TO_VIEWERS = (Deno.env.get("NORVA_CRAWL_YIELD_TO_VIEWERS") || "true") === "true";
const CRAWL_VIEWER_GRACE_MS = boundedInt(Deno.env.get("NORVA_CRAWL_VIEWER_GRACE_MS"), 300_000, 60_000, 900_000);

// True when the user is actively watching right now: a fresh playback event (the player emits
// heartbeats during playback) or a still-valid 'ready' session (covers the gap before the first
// event). Autonomous provider probes defer while this holds — a live stream egresses from the
// gateway's residential proxy IP, a relay probe from Cloudflare, and the provider's single-IP panel
// ("user_multi_ip") then 429s one of them. Enrichment resumes a few minutes after playback stops.
async function userHasLiveSession(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  // OFF => original 4-min window (byte-identical). ON => widened grace tail.
  const windowMs = CRAWL_YIELD_TO_VIEWERS ? Math.max(4 * 60 * 1000, CRAWL_VIEWER_GRACE_MS) : 4 * 60 * 1000;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const { data: ev } = await db.from("cloud_playback_events")
    .select("id").eq("user_id", userId).gt("created_at", sinceIso).limit(1);
  if (ev && ev.length) return true;
  // Steady playback emits NO event between first_frame and pause/ended, and the session rows are
  // rotated/expired within seconds of start — both signals go dark ~4 min into every real viewing
  // (proven 2026-07-04: a pregen ffmpeg opened the account's 2nd provider connection at 08:11
  // while watch-history was still bumping at 08:13). The watch-progress save (every 10 s while
  // actually playing) IS the live heartbeat, so read it here.
  const { data: hist } = await db.from("cloud_watch_history")
    .select("id").eq("user_id", userId).gt("updated_at", sinceIso).limit(1);
  if (hist && hist.length) return true;
  const { data: sess } = await db.from("cloud_playback_sessions")
    .select("id").eq("user_id", userId).eq("status", "ready").gt("expires_at", new Date().toISOString()).limit(1);
  return Boolean(sess && sess.length);
}

// Crons ↔ pregen coordination (subtitle-failures audit, fix #3). Two independent directions:
//  (a) an enrichment tick SKIPS an account while a pregen/OCR job claimed by that account is in
//      flight (status='processing', fresh): the job's gateway ffmpeg holds the account's single
//      provider slot for up to ~45 min, and a relay probe beside it is exactly the 2-connection
//      collision ("user_multi_ip") that burned the 01/07 super8k jobs;
//  (b) the gateway polls /pregen-gate before opening a job's provider connection and defers while
//      a tick ran in the last ENRICH_TICK_DEFER_MS or a viewer is live — the reverse collision
//      (job landing mid-tick), proven second-exact in the audit.
// Both fail-open: coordination must never wedge enrichment or the gateway queue.
const ENRICH_TICK_DEFER_MS = 150 * 1000;        // ticks run ≤ ~110 s (cron timeout) + margin
const PREGEN_ACTIVE_TTL_MS = 2 * 3600 * 1000;   // matches the stale-processing reaper threshold

async function accountPregenActive(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const sinceIso = new Date(Date.now() - PREGEN_ACTIVE_TTL_MS).toISOString();
    const { data } = await db.from("catalog_generated_subtitles")
      .select("job_id").eq("claimed_by", userId).eq("status", "processing")
      .gt("updated_at", sinceIso).limit(1);
    return Boolean(data && data.length);
  } catch (_) { return false; } // fail-open: unreadable state must not stall enrichment
}

// One upsert per provider-touching dimension run; /pregen-gate reads it to defer gateway jobs.
async function bumpEnrichmentHeartbeat(db: SupabaseClient, userId: string) {
  try {
    await db.from("enrichment_tick_heartbeat").upsert(
      { user_id: userId, ticked_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  } catch (_) { /* best-effort */ }
}

// ── Provider ACCOUNT busy-lock (2026-07-10 458 incident) ────────────────────────────────────────
// max_connections is per provider ACCOUNT (host+username), not per user or panel identity. The
// canonical key mirrors the gateway's proxyKeyFromUrl: URL host (port kept when non-default; the
// URL parser already lowercases hostnames) + '/' + the username path segment of an Xtream stream
// URL (/movie|series|live/USER/PASS/...). Same form as provider_account_touch_by_source builds
// from config_hint (serverHost + username). See docs/LIVE-TV-458-SLOT-CONTENTION.md §5.4.
function providerAccountKeyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2) return u.host;
    // DECODE the username segment: stream URLs are built with encodeURIComponent(username)
    // (xtreamStreamUrl), but provider_account_touch_by_source writes the RAW username from
    // config_hint. All producers must converge on the DECODED form or a username with a
    // URL-special char (@, +, space…) writes/reads mismatched keys and the lock goes blind.
    let user = segs[1];
    try { user = decodeURIComponent(user); } catch { /* keep raw on malformed % */ }
    return u.host + "/" + user;
  } catch {
    return "";
  }
}

// POST /account-activity (gateway-token auth, like /pregen-gate): { keys: string[] } → { ok }.
// The media gateway reports the provider accounts it is CURRENTLY holding a connection for
// (viewer transcode sessions, engine raw pumps, background ffmpeg extractions) every ~60s.
// This is the missing WRITER that makes provider_account_busy() see web Live TV — the viewing
// path whose per-user signals go dark ~4 min in (see userHasLiveSession's comment).
async function runAccountActivity(req: Request, db: SupabaseClient) {
  const runtimeConfig = await getRuntimeConfig(db);
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!runtimeConfig.mediaGatewayToken || provided !== runtimeConfig.mediaGatewayToken) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 300)
    .slice(0, 64);
  if (!keys.length) return { ok: true, touched: 0 };
  const kind = stringOr(body.kind, "gateway").slice(0, 32);
  // Fail-open like every other writer/reader in this feature: a bookkeeping error (RPC/table
  // absent on a lagged env, transient DB) must never 500 the gateway reporter.
  try {
    const { error } = await db.rpc("provider_account_touch_many", { p_keys: keys, p_kind: kind });
    if (error) return { ok: true, touched: 0, warn: "rpc-error" };
  } catch (_) { return { ok: true, touched: 0, warn: "rpc-exception" }; }
  return { ok: true, touched: keys.length };
}

// Best-effort account-activity touches from the edge's own playback paths (fail-open — a
// bookkeeping error must never break playback). URL variant for paths that hold the raw
// provider URL; source variant for paths that only carry a source_id.
async function touchProviderAccountByUrl(db: SupabaseClient, url: string, kind: string) {
  try {
    const key = providerAccountKeyFromUrl(url);
    if (key) await db.rpc("provider_account_touch_many", { p_keys: [key], p_kind: kind });
  } catch (_) { /* best-effort */ }
}
async function touchProviderAccountBySource(db: SupabaseClient, sourceId: string | null, kind: string) {
  try {
    if (sourceId) await db.rpc("provider_account_touch_by_source", { p_source_id: sourceId, p_kind: kind });
  } catch (_) { /* best-effort */ }
}

// POST /pregen-gate (gateway-token auth, like transcribe-callback): { userId } → { defer, reason }.
// The gateway is blind to relay-side cron activity and viewer sessions — this is its one window.
async function runPregenGate(req: Request, db: SupabaseClient) {
  const runtimeConfig = await getRuntimeConfig(db);
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!runtimeConfig.mediaGatewayToken || provided !== runtimeConfig.mediaGatewayToken) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const userId = stringOr(body.userId, "");
  if (!userId) return { defer: false, reason: "no-user" };
  if (await userHasLiveSession(db, userId)) return { defer: true, reason: "live-session" };
  try {
    const sinceIso = new Date(Date.now() - ENRICH_TICK_DEFER_MS).toISOString();
    const { data } = await db.from("enrichment_tick_heartbeat")
      .select("user_id").eq("user_id", userId).gt("ticked_at", sinceIso).limit(1);
    if (data && data.length) return { defer: true, reason: "enrichment-tick" };
  } catch (_) { /* fail-open */ }
  return { defer: false };
}

// Exhausted-dimension short-circuit (cron audit #11, corrected fix). A dimension that returned 0
// candidates still cost a full variant-driven panel scan per tick (airysat: 357ms/46k buffers to
// return 0; ninja post-drain: up to 360 ticks/day × 172k-variant scans). The scan visits EVERY
// panel variant regardless of pending-set size, so shrinking the set can't fix it — instead we
// remember "this (user, source, dimension) is dry" and skip it entirely for a SHORT TTL. 30 min is
// deliberate: the auto-refresh importer lands new titles every ~30 min, so staleness is bounded by
// one refresh cycle; a tick that DOES process work clears the mark early. Fail-open everywhere.
const EXHAUSTED_TTL_MS = 30 * 60 * 1000;

// Only candidate-driven sweeps participate — targeted/on-demand modes (titleIds, orderedTitleIds,
// catalog fill, transcribe/ocr paths) must never be short-circuited. null = not a sweep.
function sweepDimKey(body: JsonRecord): string | null {
  if (Array.isArray(body.orderedTitleIds) || Array.isArray(body.titleIds) || Array.isArray(body.verifyTitleIds)) return null;
  const mode = stringOr(body.mode, "");
  const subtitleTarget = stringOr(body.target, "") === "subtitle";
  if (!subtitleTarget && !["", "vod", "probe", "whisper"].includes(mode)) return null;
  const itemType = stringOr(body.type, "movie") === "series" ? "series" : "movie";
  const dim = subtitleTarget ? "subtitle" : (mode || "vod");
  return `${stringOr(body.userId, "")}:${stringOr(body.sourceId, "") || "*"}:${itemType}:${dim}`;
}

async function exhaustedMap(db: SupabaseClient, keys: (string | null)[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const wanted = keys.filter((k): k is string => Boolean(k));
  if (!wanted.length) return map;
  try {
    const { data } = await db.from("enrichment_exhausted").select("k, exhausted_until").in("k", wanted);
    for (const r of (data ?? []) as JsonRecord[]) map.set(String(r.k), new Date(String(r.exhausted_until)).getTime());
  } catch (_) { /* fail-open: unreadable state = no short-circuit */ }
  return map;
}

async function recordExhaustion(db: SupabaseClient, key: string, processed: number, skipped: unknown) {
  try {
    if (skipped) return;                              // live-session ticks say nothing about the panel
    if (processed > 0) { await db.from("enrichment_exhausted").delete().eq("k", key); return; }
    await db.from("enrichment_exhausted").upsert(
      { k: key, exhausted_until: new Date(Date.now() + EXHAUSTED_TTL_MS).toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "k" },
    );
  } catch (_) { /* best-effort */ }
}

// A probe response status that reads as "the provider is refusing us" (auth / rate-limit / gateway
// or upstream error) rather than "this one item is gone" (404/410). Only these advance the probe
// circuit breaker, so a catalog full of dead items can't trip it, but a ban-in-progress does.
function isBanishStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function finiteBenchmarkNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function benchmarkLanguage(value: unknown): string | null {
  const code = String(value || "").toLowerCase().trim();
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

const LID_BENCHMARK_WAV_MAX_BYTES = 1536 * 1024;
const LID_BENCHMARK_WAV_BASE64_MAX_CHARS = 1536 * 1024;

function invalidLidBenchmarkWavCapture(): never {
  throw new HttpError(502, "Gateway returned an invalid LID benchmark WAV capture");
}

async function sanitizeLidBenchmarkWavCapture(payload: JsonRecord): Promise<JsonRecord> {
  const sample = recordOrEmpty(payload.sample);
  if (!isRecord(payload.wavCapture)) invalidLidBenchmarkWavCapture();
  const capture = payload.wavCapture;
  const bytes = capture.bytes;
  const digest = capture.digest;
  const base64 = capture.base64;
  if (
    capture.contentType !== "audio/wav" ||
    capture.encoding !== "base64" ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 44 ||
    bytes > LID_BENCHMARK_WAV_MAX_BYTES ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    typeof base64 !== "string" ||
    base64.length === 0 ||
    base64.length > LID_BENCHMARK_WAV_BASE64_MAX_CHARS ||
    base64.length !== Math.ceil(bytes / 3) * 4 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    sample.wavBytes !== bytes ||
    sample.digest !== digest
  ) {
    invalidLidBenchmarkWavCapture();
  }

  let binary = "";
  try {
    binary = atob(base64);
  } catch (_) {
    invalidLidBenchmarkWavCapture();
  }
  if (binary.length !== bytes) invalidLidBenchmarkWavCapture();
  const decoded = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  if (
    decoded[0] !== 0x52 || decoded[1] !== 0x49 ||
    decoded[2] !== 0x46 || decoded[3] !== 0x46 ||
    decoded[8] !== 0x57 || decoded[9] !== 0x41 ||
    decoded[10] !== 0x56 || decoded[11] !== 0x45
  ) {
    invalidLidBenchmarkWavCapture();
  }
  const hash = await crypto.subtle.digest("SHA-256", decoded);
  const computedDigest = Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (computedDigest !== digest) invalidLidBenchmarkWavCapture();

  return {
    contentType: "audio/wav",
    encoding: "base64",
    bytes,
    digest,
    base64,
  };
}

function sanitizeLidBenchmarkResult(payload: JsonRecord): JsonRecord {
  const sample = recordOrEmpty(payload.sample);
  const engine = recordOrEmpty(payload.engine);
  const system = recordOrEmpty(payload.system);
  const timings = recordOrEmpty(payload.timings);
  const current = recordOrEmpty(payload.current);
  const detectOnly = recordOrEmpty(payload.detectOnly);
  const agreement = recordOrEmpty(payload.agreement);
  const gains = recordOrEmpty(payload.gains);
  return {
    schemaVersion: finiteBenchmarkNumber(payload.schemaVersion, 1),
    benchmarkId: stringOrNull(payload.benchmarkId),
    persisted: false,
    sample: {
      trackIndex: finiteBenchmarkNumber(sample.trackIndex),
      startSec: finiteBenchmarkNumber(sample.startSec),
      requestedDurationSec: finiteBenchmarkNumber(sample.requestedDurationSec),
      audioSec: finiteBenchmarkNumber(sample.audioSec),
      wavBytes: finiteBenchmarkNumber(sample.wavBytes),
      digest: stringOrNull(sample.digest),
    },
    engine: {
      gatewayVersion: finiteBenchmarkNumber(engine.gatewayVersion),
      family: stringOr(engine.family, "whisper.cpp"),
      model: stringOrNull(engine.model),
      commit: stringOrNull(engine.commit),
      binarySha256: stringOrNull(engine.binarySha256),
      modelSha256: stringOrNull(engine.modelSha256),
      runtimeVerified: engine.runtimeVerified === true,
      threads: finiteBenchmarkNumber(engine.threads),
    },
    system: {
      instance: stringOrNull(system.instance),
      loadBefore: Array.isArray(system.loadBefore)
        ? system.loadBefore.map((value) => finiteBenchmarkNumber(value)).slice(0, 3)
        : [],
      loadAfter: Array.isArray(system.loadAfter)
        ? system.loadAfter.map((value) => finiteBenchmarkNumber(value)).slice(0, 3)
        : [],
      contended: system.contended === true,
    },
    order: Array.isArray(payload.order)
      ? payload.order.map(String).filter((item) => item === "current" || item === "detect-only")
      : [],
    timings: {
      extractMs: finiteBenchmarkNumber(timings.extractMs),
      currentMs: finiteBenchmarkNumber(timings.currentMs),
      detectOnlyMs: finiteBenchmarkNumber(timings.detectOnlyMs),
      currentContainerCpuMs: timings.currentContainerCpuMs == null
        ? null
        : finiteBenchmarkNumber(timings.currentContainerCpuMs),
      detectOnlyContainerCpuMs: timings.detectOnlyContainerCpuMs == null
        ? null
        : finiteBenchmarkNumber(timings.detectOnlyContainerCpuMs),
      totalCurrentMs: finiteBenchmarkNumber(timings.totalCurrentMs),
      totalDetectOnlyMs: finiteBenchmarkNumber(timings.totalDetectOnlyMs),
    },
    current: {
      ok: current.ok === true,
      candidateLanguage: benchmarkLanguage(current.candidateLanguage),
      probability: finiteBenchmarkNumber(current.probability),
      transcriptLanguage: benchmarkLanguage(current.transcriptLanguage),
      transcriptConfident: current.transcriptConfident === true,
      wordCount: finiteBenchmarkNumber(current.wordCount),
      productionAccepted: current.productionAccepted === true,
      productionLanguage: benchmarkLanguage(current.productionLanguage),
    },
    detectOnly: {
      ok: detectOnly.ok === true,
      candidateLanguage: benchmarkLanguage(detectOnly.candidateLanguage),
      probability: finiteBenchmarkNumber(detectOnly.probability),
      timedOut: detectOnly.timedOut === true,
      error: stringOrNull(detectOnly.error),
    },
    agreement: {
      whisperLanguage: agreement.whisperLanguage === true,
      productionLanguage: agreement.productionLanguage === true,
    },
    gains: {
      lidSpeedup: gains.lidSpeedup == null ? null : finiteBenchmarkNumber(gains.lidSpeedup),
      endToEndSpeedup: gains.endToEndSpeedup == null
        ? null
        : finiteBenchmarkNumber(gains.endToEndSpeedup),
    },
  };
}

async function runLidBenchmarkEndpoint(req: Request, db: SupabaseClient) {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const audit = {
    userId: stringOr(body.userId, "") || null,
    sourceId: stringOr(body.sourceId, "") || null,
  };
  try {
    const { data: paused } = await db.rpc("feature_flag", { p_key: "enrichment_paused" });
    if (paused === true) {
      return { paused: true, skipped: "enrichment_paused", persisted: false, audit };
    }
  } catch (_) { /* preserve the existing fail-open maintenance behavior */ }
  return {
    ...(await runLidBenchmark(db, { ...body, mode: "lid-benchmark" }, true)),
    audit,
  };
}

// Manual, service-gated and catalogue-read-only benchmark. One request means one exact
// variant, one cached audio stream and one offset. The gateway reuses one WAV for both modes.
async function runLidBenchmark(
  db: SupabaseClient,
  body: JsonRecord,
  allowWavCapture = false,
): Promise<JsonRecord> {
  let enabled = false;
  try {
    const { data } = await db
      .from("admin_feature_flags")
      .select("enabled,updated_at")
      .eq("key", "lid_benchmark_enabled")
      .maybeSingle();
    const updatedAt = Date.parse(stringOr((data as JsonRecord | null)?.updated_at, ""));
    enabled = (data as JsonRecord | null)?.enabled === true
      && Number.isFinite(updatedAt)
      && updatedAt >= Date.now() - 2 * 60 * 60 * 1000;
  } catch (_) { enabled = false; }
  if (!enabled) throw new HttpError(403, "LID benchmark is disabled or its operator lease expired");

  const userId = stringOr(body.userId, "");
  const variantId = stringOr(body.variantId, "");
  const trackIndex = Number(body.index);
  const start = finiteBenchmarkNumber(body.start, 600);
  const dur = finiteBenchmarkNumber(body.dur, 20);
  const order = stringOr(body.order, "") === "detect-first" ? "detect-first" : "current-first";
  if (!allowWavCapture && body.captureWav === true) {
    throw new HttpError(400, "WAV capture requires the dedicated LID benchmark endpoint");
  }
  const captureWav = allowWavCapture && body.captureWav === true;
  if (!userId || !variantId) throw new HttpError(400, "userId and variantId are required");
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 1024) {
    throw new HttpError(400, "A valid audio stream index is required");
  }
  if (start < 0 || start > 21600 || dur < 8 || dur > 30) {
    throw new HttpError(400, "Invalid LID benchmark window");
  }
  if (await userHasLiveSession(db, userId)) {
    return { mode: "lid-benchmark", persisted: false, skipped: "live-session" };
  }
  if (await accountPregenActive(db, userId)) {
    return { mode: "lid-benchmark", persisted: false, skipped: "pregen-active" };
  }

  const { data: rawVariant, error: variantError } = await db
    .from("cloud_title_variants")
    .select("id,title_id,source_id,external_id,item_type,label,language,container_extension")
    .eq("id", variantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (variantError) throwDb(variantError, "Unable to load benchmark variant");
  const variant = rawVariant as JsonRecord | null;
  if (!variant) throw new HttpError(404, "Variant not found");
  const sourceId = stringOr(variant.source_id, "");
  const externalId = stringOr(variant.external_id, "");
  const itemType = stringOr(variant.item_type, "movie");
  if (!sourceId || !externalId || itemType !== "movie") {
    throw new HttpError(400, "Benchmark requires an exact movie variant");
  }

  const target = await resolvePlaybackTarget(sourceId, itemType, externalId, userId, db);
  const targetUrl = stringOrNull(target?.targetUrl);
  if (!targetUrl) throw new HttpError(404, "Playback target unavailable");
  const accountKey = providerAccountKeyFromUrl(targetUrl);
  if (accountKey) {
    const { data: busy, error: busyError } = await db.rpc("provider_account_busy", {
      p_key: accountKey,
    });
    if (busyError) throwDb(busyError, "Unable to verify benchmark provider availability");
    if (busy === true) {
      return { mode: "lid-benchmark", persisted: false, skipped: "provider-account-busy" };
    }
  }
  const footprint = await getFootprint(db, sourceId, userId);
  if (footprint?.lowFootprint) {
    return { mode: "lid-benchmark", persisted: false, skipped: "low-footprint-provider" };
  }

  const serverHost = await resolveFileTracksKey(sourceId, userId, db, targetUrl);
  const { data: rawTracks, error: tracksError } = await db
    .from("catalog_file_tracks")
    .select("audio_tracks,audio_probed_at")
    .eq("server_host", serverHost)
    .eq("item_type", itemType)
    .eq("external_id", externalId)
    .maybeSingle();
  if (tracksError) throwDb(tracksError, "Unable to load benchmark audio map");
  const fileTracks = rawTracks as JsonRecord | null;
  const tracks = (Array.isArray(fileTracks?.audio_tracks)
    ? (fileTracks!.audio_tracks as JsonRecord[])
    : [])
    .map((track) => ({
      index: Number(track?.index),
      lang: normalizeIsoLang(stringOrNull(track?.lang)),
    }))
    .filter((track) => Number.isInteger(track.index));
  const selectedTrack = tracks.find((track) => track.index === trackIndex);
  if (!fileTracks?.audio_probed_at || !selectedTrack) {
    return { mode: "lid-benchmark", persisted: false, skipped: "audio-track-not-cached" };
  }

  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Media gateway is not configured");
  }
  const identityKey = (await resolveSourceIdentity(sourceId, userId, db)).key;
  const leaseOwner = `lid-benchmark:${crypto.randomUUID()}`;
  const { data: leaseClaimed, error: leaseError } = await db.rpc("claim_provider_file_probe", {
    p_identity_key: identityKey,
    p_lease_owner: leaseOwner,
    p_ttl_seconds: 240,
  });
  if (leaseError) throwDb(leaseError, "Unable to claim the benchmark provider lease");
  if (leaseClaimed !== true) {
    return { mode: "lid-benchmark", persisted: false, skipped: "provider-lease-busy" };
  }

  try {
    // Close the race between the initial guards and the provider fetch. Viewer playback and
    // subtitle generation always win; the strict distributed lease remains held until return.
    if (await userHasLiveSession(db, userId)) {
      return { mode: "lid-benchmark", persisted: false, skipped: "live-session-race" };
    }
    if (await accountPregenActive(db, userId)) {
      return { mode: "lid-benchmark", persisted: false, skipped: "pregen-active-race" };
    }
    if (accountKey) {
      const { data: busy, error: busyError } = await db.rpc("provider_account_busy", {
        p_key: accountKey,
      });
      if (busyError) throwDb(busyError, "Unable to recheck benchmark provider availability");
      if (busy === true) {
        return { mode: "lid-benchmark", persisted: false, skipped: "provider-account-busy-race" };
      }
    }
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const pipe = await createBytePipeAccess(
      `lid-benchmark:${crypto.randomUUID()}`,
      userId,
      targetUrl,
      expiresAt,
      db,
      null,
      "lid-benchmark",
    );
    const endpoint = pipe.url.replace("/raw/", "/benchmark-language/");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
      },
      body: JSON.stringify({ index: trackIndex, start, dur, order, includeWav: captureWav }),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = recordOrEmpty(await response.json().catch(() => ({})));
    if (!response.ok) {
      const safeDetails = truncateText(
        sanitizeTelemetryText(stringOr(payload.details, "")),
        300,
      );
      return {
        mode: "lid-benchmark",
        persisted: false,
        status: response.status,
        error: stringOr(payload.error, "Gateway benchmark failed"),
        details: safeDetails || null,
        retryAfter: response.headers.get("retry-after"),
      };
    }
    const benchmark = sanitizeLidBenchmarkResult(payload);
    if (captureWav) {
      benchmark.wavCapture = await sanitizeLidBenchmarkWavCapture(payload);
    }
    return {
      mode: "lid-benchmark",
      persisted: false,
      variant: {
        id: stringOr(variant.id, ""),
        titleId: stringOr(variant.title_id, ""),
        label: stringOrNull(variant.label),
        declaredLanguage: normalizeIsoLang(stringOrNull(variant.language)),
        container: stringOrNull(variant.container_extension),
      },
      // This is a cache hint only (often ffprobe metadata), never benchmark ground truth.
      cachedLanguageHint: selectedTrack.lang,
      benchmark,
    };
  } finally {
    await releaseProviderFileProbe(db, identityKey, leaseOwner);
  }
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
  const auditMeta = {
    userId: stringOr(body.userId, "") || null,
    sourceId: stringOr(body.sourceId, "") || null,
  };
  const withAuditMeta = (payload: JsonRecord): JsonRecord => ({ ...payload, audit: auditMeta });

  // Global kill switch (admin feature flag): when enrichment_paused is ON, skip all backfill work so
  // NO provider connection is opened this tick — an ops pause (incident, provider protection). One
  // cheap flag read; FAIL-OPEN (a transient read error keeps enriching rather than silently halting).
  try {
    const { data: paused } = await db.rpc("feature_flag", { p_key: "enrichment_paused" });
    if (paused === true) return withAuditMeta({ paused: true, skipped: "enrichment_paused" });
  } catch (_) { /* fail-open: keep enriching if the flag can't be read */ }

  if (stringOr(body.mode, "") === "lid-benchmark") {
    return withAuditMeta(await runLidBenchmark(db, body));
  }

  // One dimension per call by default. With fallthrough:true (set on the DAYTIME audio-films
  // crons), once the primary dimension runs out of candidates we DRAIN the next unfinished
  // dimension for the same provider — so a finished daytime window accelerates the night-only
  // dimensions (series / subtitles / whisper) instead of idling. `processed` is the candidate
  // count, so processed===0 means "this dimension is done" → advance to the next.
  // SLOT-SAFE: dimensions run STRICTLY sequentially (one provider access at a time); each keeps
  // its own userHasLiveSession() guard; the chain STOPS the instant a user is live (skipped) so
  // it can never open a 2nd provider connection next to a live stream (the user_multi_ip trap).
  if (body.fallthrough !== true) {
    // Single-dim path (night crons): same short-circuit as the chain below.
    const soloKey = sweepDimKey(body);
    if (!soloKey) return withAuditMeta((await runOneDimension(db, body)) as JsonRecord);
    const soloEx = await exhaustedMap(db, [soloKey]);
    if ((soloEx.get(soloKey) ?? 0) > Date.now()) {
      return withAuditMeta({ skipped: "exhausted", key: soloKey, until: new Date(soloEx.get(soloKey)!).toISOString() });
    }
    const soloRes = (await runOneDimension(db, body)) as JsonRecord;
    await recordExhaustion(db, soloKey, Number(soloRes?.processed ?? 0), soloRes?.skipped);
    return withAuditMeta(soloRes);
  }
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
  // ONE indexed read fetches the exhaustion state of the whole chain; dry dimensions are skipped
  // without touching their panel (a fully-exhausted tick costs ~2 cheap queries instead of 6 scans).
  const chainKeys = chain.map((dim) => sweepDimKey(dim));
  const ex = await exhaustedMap(db, chainKeys);
  const tried: JsonRecord[] = [];
  for (let i = 0; i < chain.length; i++) {
    const dim = chain[i];
    const key = chainKeys[i];
    const kind = dim.target ? "subtitle" : stringOr(dim.mode, "vod");
    if (key && (ex.get(key) ?? 0) > Date.now()) {
      tried.push({ type: stringOr(dim.type, "?"), kind, skipped: "exhausted" });
      continue;
    }
    const r = (await runOneDimension(db, dim)) as JsonRecord;
    const processed = Number(r?.processed ?? 0);
    if (key) await recordExhaustion(db, key, processed, r?.skipped);
    tried.push({ type: stringOr(dim.type, "?"), kind, processed, skipped: stringOrNull(r?.skipped) });
    if (r?.skipped) return withAuditMeta({ mode: "fallthrough", stoppedAt: r.skipped, tried });   // live viewer / in-flight pregen → stop the whole chain
    if (processed > 0) return withAuditMeta({ mode: "fallthrough", workedOn: tried[tried.length - 1], tried, result: r });
  }
  return withAuditMeta({ mode: "fallthrough", exhausted: true, tried });
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
    if (itemType === "series") {
      return { mode: "catalog", filled: 0, processed: 0, seriesSkipped: true };
    }
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
        const r = await transcribeEnqueue(db, userId, runtimeConfig, { titleId, respectFailedCooldown: true, origin: "pregen" });
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
    if (itemType === "series") {
      return {
        mode: "whisper", processed: 0, verified: 0, corrected: 0,
        candidates: 0, detected: 0, lastId: afterId, hasMore: false,
        seriesSkipped: true,
      };
    }
    if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
      throw new HttpError(503, "Media gateway is not configured");
    }
    // Defer while the user is live (avoids a 2nd provider connection / IP next to their stream).
    if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
      return { mode: "whisper", skipped: "live-session", processed: 0, candidates: 0, detected: 0 };
    }
    // Same for an in-flight pregen/OCR job of this account (its ffmpeg holds the provider slot).
    if (body.ignoreLiveSession !== true && await accountPregenActive(db, userId)) {
      return { mode: "whisper", skipped: "pregen-active", processed: 0, candidates: 0, detected: 0 };
    }
    await bumpEnrichmentHeartbeat(db, userId);
    const fileWhisperScope = body.fileScope !== false;
    const speechTarget = ["tagged", "untagged"].includes(stringOr(body.speechTarget, ""))
      ? stringOr(body.speechTarget, "")
      : "";

    // ── Phase VERIFY (fix "German tag on a French film", "Bangla tag on a Hindi film") ──
    // Container tags that contradict strong signals — whisper listens to the actual speech
    // and corrects the catalog (which also fixes the player's audio menu: it prefers cloud
    // audio_tracks over container tags). Candidates come from the audio_tag_suspects RPC:
    // class 1 = FR-marked title without fr (429 measured live), class 2 = a SINGLE probed
    // language whose name is literally a word of the title (the releaser pattern that tagged
    // the Hindi film "Bhooth Bangla" as Bengali) — class 2 served first. Explicit
    // body.verifyTitleIds bypasses the candidate query entirely (targeted support runs).
    // Bounded (≤ verifyLimit titles/tick, ≤ 2 suspect tracks each, sequential) and runs
    // BEFORE the untagged phase. 90d re-verify window; best-effort throughout.
    const explicitVerifyIds = Array.isArray(body.verifyTitleIds)
      ? (body.verifyTitleIds as unknown[]).map(String).filter(Boolean).slice(0, 10) : [];
    const verifyLimit = speechTarget === "untagged"
      ? 0
      : Math.max(0, Math.min(Number(
        body.verifyLimit ?? (speechTarget === "tagged" ? limit : Math.ceil(limit / 2)),
      ), 2));
    let verified = 0, detectedTagged = 0, corrected = 0, pendingVerification = 0, verificationWork = 0;
    if (verifyLimit > 0) {
      try {
        const verifyRetryBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
        // Per-panel crons (sourceId set) filter AFTER resolving variants → over-fetch.
        const { data: srows } = fileWhisperScope
          ? await db.rpc("file_audio_tag_suspect_variants", {
              p_user: userId,
              p_source: sourceId || null,
              p_limit: verifyLimit,
              p_retry_before: verifyRetryBefore,
              p_title_ids: explicitVerifyIds.length ? explicitVerifyIds : null,
            })
            : await db.rpc("audio_tag_suspects", {
                p_user: userId,
                p_item_type: itemType,
                p_limit: sourceId ? verifyLimit * 5 : verifyLimit,
                p_retry_before: verifyRetryBefore,
              });
        const suspectsAll = (srows ?? []) as JsonRecord[];
        const svIds = suspectsAll.map((t) => stringOrNull(t.default_variant_id)).filter(Boolean) as string[];
        const svById = new Map<string, JsonRecord>();
        if (svIds.length) {
          const { data: vs } = await db.from("cloud_title_variants").select("id, source_id, external_id, item_type").in("id", svIds);
          for (const v of vs ?? []) svById.set(String(v.id), v as JsonRecord);
        }
        const vExp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const verifyLeaseOwner = `verify:${crypto.randomUUID()}`;
        for (const t of suspectsAll) {
          if (verificationWork >= verifyLimit) break;
          const variant = t.default_variant_id ? svById.get(String(t.default_variant_id)) : null;
          if (!variant) continue;
          const vSourceId = stringOr(variant.source_id, "");
          if (sourceId && vSourceId !== sourceId) continue; // per-panel cron: stay on this host
          const externalId = stringOr(variant.external_id, "");
          const vit = stringOr(variant.item_type, itemType);
          if (!vSourceId || !externalId) continue;
          const targetUrl = vit === "series"
            ? await resolveSeriesEpisodeUrl(vSourceId, externalId, userId, db).catch(() => null)
            : ((await resolvePlaybackTarget(vSourceId, vit, externalId, userId, db).catch(() => null))?.targetUrl ?? null);
          if (!targetUrl) continue;
          // Account busy-lock: a whisper extraction pulls the stream for minutes and DOES hold the
          // single connection slot (unlike a panel call). The branch's top-level userHasLiveSession
          // guard is per-user + goes dark ~4min in; re-check the account here so we yield to any
          // viewer/device on this account before starting the extraction. Skip (not fail) when busy.
          if (body.ignoreLiveSession !== true) {
            const ak = providerAccountKeyFromUrl(targetUrl);
            if (ak) { try { const { data: b } = await db.rpc("provider_account_busy", { p_key: ak }); if (b === true) continue; } catch (_) { /* fail-open */ } }
          }
          const tracks = ((t.audio_tracks as JsonRecord[]) || [])
            .map((x) => ({
              index: Number(x?.index),
              lang: normalizeIsoLang(stringOrNull(x?.lang)),
              speechVerifiedAt: stringOrNull(x?.speechVerifiedAt ?? x?.speech_verified_at),
              speechVerdict: stringOrNull(x?.speechVerdict ?? x?.speech_verdict),
            }))
            .filter((x) => Number.isInteger(x.index));
          const identityKey = (await resolveSourceIdentity(vSourceId, userId, db)).key;
          if (!await claimProviderFileProbe(db, identityKey, verifyLeaseOwner, 900)) continue;
          let outcome: "corrected" | "detected" | "pending" | "partial" | null = null;
          try {
            outcome = await verifyTaggedAudioLanguages({
              db, runtimeConfig, userId, targetUrl, audioTracks: tracks,
              // Every tagged language is eligible: a provider tag saying French
              // can itself be wrong (the user's concrete French→Italian case).
              suspectLangs: [...new Set(tracks.map((x) => x.lang).filter((l): l is string => Boolean(l)))],
              titleId: String(t.id), tmdbId: stringOrNull(t.provider_tmdb_id),
              serverHost: await resolveFileTracksKey(vSourceId, userId, db, targetUrl),
              itemType: vit, fileExternalId: externalId, expiresAt: vExp,
              variantId: stringOrNull(variant.id) || undefined,
              fileScoped: fileWhisperScope,
            });
          } finally {
            await releaseProviderFileProbe(db, identityKey, verifyLeaseOwner);
          }
          // A transient/timeout still consumed one bounded work slot. Continue through the
          // requested verifyLimit so a single bad file cannot monopolize every fleet tick.
          verificationWork += 1;
          if (outcome === "detected" || outcome === "corrected") detectedTagged += 1;
          if (outcome === "corrected") corrected += 1;
          if (outcome === "pending") pendingVerification += 1;
        }
      } catch (_) { /* verify phase is best-effort — never blocks the untagged phase */ }
    }

    // Explicit tagged lanes stop after their requested file budget. A generic/manual Whisper
    // request may continue into the untagged phase, matching the former basic-detector workflow.
    if (speechTarget === "tagged") {
      return {
        mode: "whisper", scope: fileWhisperScope ? "file" : "title",
        speechTarget,
        processed: verificationWork, verificationWork, verified, corrected, pending: pendingVerification,
        candidates: 0, detected: detectedTagged, hasMore: verifyLimit > 0 && verificationWork >= verifyLimit,
      };
    }

    const wConcurrency = fileWhisperScope
      ? 1
      : Math.max(1, Math.min(Number(body.concurrency) || 1, 4));
    // Select REAL candidates DB-side via RPC (raw jsonb @>): titles whose audio_tracks still hold
    // an untagged (lang null) track, skipping those attempted within the retry window so the queue
    // advances instead of re-trying the same front forever. (The old in-memory filter scanned the
    // first N titles by id, so the sparse untagged residual was almost never in the window → it did
    // nothing. PostgREST can't cleanly express the jsonb-array containment, hence the RPC.)
    const whisperRetryBefore = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: wrows, error: wErr } = fileWhisperScope
      ? await db.rpc("file_whisper_candidate_variants", {
          p_user: userId,
          p_source: sourceId || null,
          p_limit: limit,
          p_retry_before: whisperRetryBefore,
        })
      : await db.rpc("whisper_candidate_titles", {
          p_user: userId, p_item_type: itemType, p_limit: limit,
          p_retry_before: whisperRetryBefore, p_after: afterId || null,
          p_source: sourceId || null,
        });
    if (wErr) throwDb(wErr, "Unable to list titles for whisper backfill");
    if (!wrows || !wrows.length) {
      return {
        mode: "whisper", scope: fileWhisperScope ? "file" : "title",
        processed: verificationWork, verificationWork, verified, corrected, pending: pendingVerification,
        candidates: 0, detected: detectedTagged,
        lastId: afterId, hasMore: false,
      };
    }
    const whisperRows = wrows as JsonRecord[];
    const candidates = whisperRows.filter((t: JsonRecord) => {
      const arr = Array.isArray(t.audio_tracks) ? t.audio_tracks as JsonRecord[] : [];
      return arr.some((x) =>
        !normalizeIsoLang(stringOrNull(x?.lang ?? x?.language))
      );
    }).slice(0, Math.max(1, Math.min(limit, 4)));
    const wvIds = candidates.map((t: JsonRecord) => stringOrNull(t.default_variant_id)).filter(Boolean) as string[];
    const wvById = new Map<string, JsonRecord>();
    if (wvIds.length) {
      const { data: vs } = await db.from("cloud_title_variants").select("id, source_id, external_id, item_type").in("id", wvIds);
      for (const v of vs ?? []) wvById.set(String(v.id), v as JsonRecord);
    }

    let detected = 0;
    const whisperLeaseOwner = `whisper:${crypto.randomUUID()}`;
    const footprintBySource = new Map<string, Awaited<ReturnType<typeof getFootprint>>>();
    const footprintHitsThisTick = new Map<string, number>();
    // STRUCTURAL dead-ends (no variant / no source+external id) are permanent — mark them attempted so
    // they leave the candidate set and can't clog the cursor-less front-of-queue forever. TRANSIENT
    // failures (URL won't resolve, thrown errors) are NOT marked: a provider outage must not defer a
    // whole provider's untagged tracks for the 30-day retry window — they retry next run.
    const markWhisperAttempted = (titleId: string, variantId: string) =>
      (fileWhisperScope
        ? db.from("cloud_title_variants")
            .update({ audio_whisper_attempted_at: new Date().toISOString() })
            .eq("id", variantId).eq("user_id", userId)
        : db.from("cloud_titles")
            .update({ whisper_attempted_at: new Date().toISOString() })
            .eq("id", titleId).eq("user_id", userId)
      ).then(() => {}, () => {});
    const runOne = async (t: JsonRecord) => {
      const titleId = String(t.id);
      const variantId = stringOr(t.default_variant_id, "");
      try {
        const variant = wvById.get(variantId);
        if (!variant) { await markWhisperAttempted(titleId, variantId); return; }
        const variantSourceId = stringOr(variant.source_id, "");
        const externalId = stringOr(variant.external_id, "");
        const vit = stringOr(variant.item_type, itemType);
        if (!variantSourceId || !externalId) {
          await markWhisperAttempted(titleId, variantId);
          return;
        }
        const targetUrl = vit === "series"
          ? await resolveSeriesEpisodeUrl(variantSourceId, externalId, userId, db).catch(() => null)
          : ((await resolvePlaybackTarget(variantSourceId, vit, externalId, userId, db).catch(() => null))?.targetUrl ?? null);
        if (!targetUrl) return;
        if (body.ignoreLiveSession !== true) {
          const accountKey = providerAccountKeyFromUrl(targetUrl);
          if (accountKey) {
            try {
              const { data: busy } = await db.rpc("provider_account_busy", { p_key: accountKey });
              if (busy === true) return;
            } catch (_) { /* fail-open */ }
          }
        }
        let footprint = footprintBySource.get(variantSourceId);
        if (footprint === undefined) {
          footprint = await getFootprint(db, variantSourceId, userId);
          footprintBySource.set(variantSourceId, footprint);
        }
        if (footprint?.lowFootprint && !footprint.allowed) return;
        if (footprint?.lowFootprint && footprint.maxPerHour != null) {
          const localHits = footprintHitsThisTick.get(footprint.identityKey) ?? 0;
          if (footprint.hits + localHits >= footprint.maxPerHour) return;
        }
        const identityKey = (await resolveSourceIdentity(variantSourceId, userId, db)).key;
        // Up to five sequential 90s language detections can run for one file.
        // Keep the distributed lease longer than that worst-case provider hold.
        if (!await claimProviderFileProbe(db, identityKey, whisperLeaseOwner, 600)) return;
        if (footprint?.lowFootprint) {
          footprintHitsThisTick.set(
            footprint.identityKey,
            (footprintHitsThisTick.get(footprint.identityKey) ?? 0) + 1,
          );
        }
        const audioTracks = ((t.audio_tracks as JsonRecord[]) || [])
          .map((x) => ({
            index: Number(x?.index),
            lang: stringOrNull(x?.lang),
            lidAttemptedAt: stringOrNull(x?.lidAttemptedAt ?? x?.lid_attempted_at),
            lidVerdict: stringOrNull(x?.lidVerdict ?? x?.lid_verdict),
            lidMethod: stringOrNull(x?.lidMethod ?? x?.lid_method),
            lidConfidence: (x?.lidConfidence ?? x?.lid_confidence) != null &&
                Number.isFinite(Number(x?.lidConfidence ?? x?.lid_confidence))
              ? Number(x?.lidConfidence ?? x?.lid_confidence)
              : null,
            speechVerifiedAt: stringOrNull(x?.speechVerifiedAt ?? x?.speech_verified_at),
            speechVerdict: stringOrNull(x?.speechVerdict ?? x?.speech_verdict),
          }))
          .filter((x) => Number.isInteger(x.index));
        const before = audioTracks.filter((x) => x.lang).length;
        try {
          // Generate this capability immediately before each file. A previous
          // shared five-minute expiry could elapse while the preceding
          // multi-track file was still being sampled.
          const fileExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          await detectUntaggedAudioLanguages({
            db, runtimeConfig, userId, targetUrl, userAgent: null,
            audioTracks, titleId: String(t.id), tmdbId: stringOrNull(t.provider_tmdb_id),
            serverHost: await resolveFileTracksKey(variantSourceId, userId, db, targetUrl),
            itemType: vit, fileExternalId: externalId,
            sessionId: "whisper-backfill", expiresAt: fileExpiresAt,
            variantId, fileScoped: fileWhisperScope,
          });
          if (footprint?.lowFootprint) {
            try {
              await db.rpc("provider_footprint_record_hit", {
                p_identity_key: footprint.identityKey,
              });
            } catch (_) { /* best-effort budget accounting */ }
          }
        } finally {
          await releaseProviderFileProbe(db, identityKey, whisperLeaseOwner);
        }
        if (audioTracks.filter((x) => x.lang).length > before) detected += 1;
      } catch (_) { /* best-effort per title */ }
    };
    for (let i = 0; i < candidates.length; i += wConcurrency) {
      await Promise.all(candidates.slice(i, i + wConcurrency).map(runOne));
    }
    return {
      mode: "whisper", scope: fileWhisperScope ? "file" : "title",
      processed: candidates.length + verificationWork, verificationWork, verified, corrected, pending: pendingVerification,
      candidates: candidates.length, detected: detected + detectedTagged,
      lastId: candidates.length ? String(candidates[candidates.length - 1].id) : afterId,
      hasMore: whisperRows.length > candidates.length || wrows.length === limit,
    };
  }

  // Generic audio/subtitle crawling resolves a representative episode for a
  // series and would then write those file-local indices onto the series parent.
  // Until variants carry exact episode ids, series are playback-only for track
  // discovery and must not enter the title-level crawler.
  if (itemType === "series") {
    return { mode, processed: 0, updated: 0, lastId: afterId, hasMore: false, seriesSkipped: true };
  }

  // Autonomous provider probe (audio-langs / subtitle backfill via the relay). Defer while the user
  // is live: the live stream (gateway/residential IP) and a relay probe (Cloudflare IP) hit the
  // provider from two IPs at once → its single-IP panel returns 429 user_multi_ip and breaks live
  // browsing. ignoreLiveSession bypasses this for a manual/one-shot backfill.
  if (body.ignoreLiveSession !== true && await userHasLiveSession(db, userId)) {
    return { mode, skipped: "live-session", processed: 0, updated: 0, userId };
  }
  // A pregen/OCR job claimed by this account is holding (or about to hold) the provider slot
  // from the gateway's IP — a relay probe beside it is exactly the 2-connection collision.
  if (body.ignoreLiveSession !== true && await accountPregenActive(db, userId)) {
    return { mode, skipped: "pregen-active", processed: 0, updated: 0, userId };
  }
  await bumpEnrichmentHeartbeat(db, userId); // /pregen-gate defers gateway jobs while ticks run

  // Circuit breaker (anti-ban): if this provider identity has been returning nothing but
  // auth/rate/5xx rejections, its breaker is OPEN — skip the whole tick so we stop hammering a
  // provider that's actively refusing us (persistent failed auth only deepens an IPTV ban). The
  // `skipped` return stops the fallthrough chain (every dimension is the same identity) and does
  // not mark the panel exhausted. Fail-open: a breaker read error must never halt probing.
  let probeIdentityKey = "";
  if (sourceId && mode === "probe") {
    try {
      probeIdentityKey = (await resolveSourceIdentity(sourceId, userId, db)).key || "";
      if (probeIdentityKey) {
        const { data: cbState } = await db.rpc("provider_probe_circuit_state", { p_identity_key: probeIdentityKey });
        const cb = (Array.isArray(cbState) ? cbState[0] : cbState) as JsonRecord | null;
        if (cb?.open === true) {
          return { mode, updated: 0, processed: 0, skipped: "circuit_open", identityKey: probeIdentityKey, openUntil: cb.open_until ?? null };
        }
      }
    } catch (_) { /* fail-open: never let the breaker read stop the crawl */ }
  }

  // untaggedOnly = titles with NO version tag (e.g. plain French films). These carry no
  // language signal in the title, so they MUST be probed; ~60% expose a real default-track
  // language via the cheap get_vod_info (mode=vod). Excluded from the tag-targeted crons.
  const untaggedOnly = body.untaggedOnly === true || stringOr(body.untaggedOnly, "") === "1";
  // A header probe belongs to one provider file, not to a grouped logical title.
  // afterId keeps the legacy title cursor; fileScope:false is a rollback switch.
  const exactFileScope =
    itemType === "movie" &&
    mode === "probe" &&
    !afterId &&
    body.fileScope !== false;
  // Per-panel scope (sourceId) → audio_backfill_candidates RPC: the SAME filter (audio unresolved
  // + 30d probe-retry window, OR never subtitle-probed) but scoped to one source, variant-driven so
  // work is bounded by that source. Account-wide (no sourceId) keeps the original PostgREST path.
  const titlesResult = exactFileScope
    ? await db.rpc("file_audio_backfill_candidates", {
        p_user: userId,
        p_source: sourceId || null,
        p_item_type: itemType,
        p_target: subtitleTarget ? "subtitle" : "audio",
        p_require_tags: requireTags.length ? requireTags : null,
        p_untagged_only: untaggedOnly,
        p_limit: limit,
      })
    : sourceId
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
        // Recent-first (mirrors audio_backfill_candidates' order, 2026-07-16): probe the titles
        // users actually open before the archive tail. An explicit afterId (manual/ops paging)
        // assumes gt(id) semantics, so that path keeps the plain id order.
        return (afterId
          ? q.order("id", { ascending: true })
          : q.order("release_year", { ascending: false, nullsFirst: false }).order("id", { ascending: true })
        ).limit(limit);
      })();
  const titles = titlesResult.data as { id: string; default_variant_id: string | null; provider_tmdb_id: string | null }[] | null;
  const error = titlesResult.error;
  if (error) throwDb(error, "Unable to list titles for backfill");
  if (!titles || !titles.length) {
    return {
      mode, scope: exactFileScope ? "file" : "title",
      processed: 0, updated: 0, lastId: afterId, hasMore: false,
    };
  }

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
  const diag = {
    noVariant: 0, noTarget: 0, emptySeries: 0, relayNotOk: 0,
    relayEmpty: 0, noLang: 0, exception: 0, footprintCapped: 0,
    accountBusy: 0, cacheHydrated: 0, identityBusy: 0, circuitOpen: 0,
    persistenceFailed: 0,
  };
  // Circuit-breaker tallies for this tick: cbOk = provider served us at least once; cbBanish =
  // auth/rate/5xx rejections. Recorded once at the end of the tick (see below).
  let cbOk = 0;
  let cbBanish = 0;
  const probeHealthByIdentity = new Map<string, { ok: number; banish: number }>();
  const circuitOpenByIdentity = new Map<string, boolean>();
  let sample: JsonRecord | null = null;
  const lastId = String(titles[titles.length - 1].id);

  // Anti-ban: for a low_footprint provider identity, probes go through the gateway's residential
  // IP and are capped per hour. Resolved once per tick (per-panel crons set sourceId). Over budget
  // → skip the tick entirely so the crawl stays under the provider's abuse threshold.
  const footprint = (sourceId && mode === "probe" && runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken)
    ? await getFootprint(db, sourceId, userId)
    : null;
  if (footprint && !footprint.allowed) {
    return { mode, updated: 0, processed: 0, deferred: "footprint_budget", identityKey: footprint.identityKey, hitsLastHour: footprint.hits, maxPerHour: footprint.maxPerHour };
  }
  // Low-footprint pacing: serialize (concurrency 1), cap this tick to the remaining hourly budget,
  // and jitter each provider hit so the crawl doesn't look like a metronome.
  const effConcurrency = exactFileScope || footprint?.lowFootprint ? 1 : concurrency;
  const footprintByCandidateSource = new Map<string, Awaited<ReturnType<typeof getFootprint>>>();
  const footprintHitsByIdentity = new Map<string, number>();
  const probeLeaseOwner = `file-probe:${crypto.randomUUID()}`;

  // Account busy-lock, TICK LEVEL (per-source crons: 62-65, 79-80 — the ones that caused the
  // incident). If a human is watching THIS source's provider account right now, skip the whole
  // tick before ANY resolution — series target-resolution itself hits the panel (resolveSeriesEpisode
  // → get_series_info), so a per-title gate placed after resolution can't protect series. Derived
  // from the source config (DB-only, no provider hit); key mirrors provider_account_touch_by_source
  // (lower host + '/' + raw username). Skipped (not stamped, not counted as work) so the exhausted
  // mark and the fallthrough chain treat it as a no-op. Account-wide ticks (no sourceId — crons
  // 10/36, movie-type, DB-only resolution) fall through to the per-title gate below. Fail-open.
  if (sourceId && body.ignoreLiveSession !== true) {
    try {
      const sc = await loadSourceConfig(sourceId, userId, db);
      const host = sc?.serverUrl ? new URL(normalizeBaseUrl(String(sc.serverUrl))).host : "";
      const key = host && sc?.username ? host + "/" + String(sc.username) : "";
      if (key) {
        const { data } = await db.rpc("provider_account_busy", { p_key: key });
        if (data === true) return { mode, processed: 0, updated: 0, skipped: "account-busy", sourceId, lastId: afterId, hasMore: true };
      }
    } catch (_) { /* fail-open: never let the lock read halt the crawl */ }
  }

  // Account busy-lock READER (2026-07-10 458 incident): before ANY provider hit (relay header
  // probe, gateway residential probe, or vod-info panel call — all are the user_multi_ip signal
  // when a human is watching the same account), consult provider_account_activity. Keyed per
  // TITLE's target URL so account-wide ticks (no sourceId — e.g. cron 36) are covered per panel,
  // not per user. Cached in-tick for 20s per key: fresh enough to catch a viewer who starts
  // mid-tick, cheap enough to add ~1 read per 20s per account. Fail-open: an RPC error must
  // never halt the crawl (busy=false). Skipped titles are NOT stamped → retried next tick.
  const accountBusyCache = new Map<string, { busy: boolean; at: number }>();
  // 10s: short enough that a probe stops STARTING within ~10s of a viewer's first touch (keeps
  // the worst-case slot-contention window under the web VOD retry budget), cheap enough to add
  // at most ~1 indexed RPC read per account per 10s of a tick.
  const ACCOUNT_BUSY_CACHE_MS = 10_000;
  const accountBusyCached = async (accountKey: string): Promise<boolean> => {
    const now = Date.now();
    const hit = accountBusyCache.get(accountKey);
    if (hit && (now - hit.at) < ACCOUNT_BUSY_CACHE_MS) return hit.busy;
    let busy = false;
    try {
      const { data } = await db.rpc("provider_account_busy", { p_key: accountKey });
      busy = data === true;
    } catch (_) { /* fail-open */ }
    accountBusyCache.set(accountKey, { busy, at: now });
    return busy;
  };

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

      // Reuse a fresh exact-file cache before opening a provider connection.
      // A file observed by one account is therefore free for every later owner.
      let fileServerKey = "";
      if (exactFileScope) {
        try {
          fileServerKey = await resolveFileTracksKey(sourceId, userId, db, "");
          if (fileServerKey) {
            const { data: cached } = await db.from("catalog_file_tracks")
              .select("audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at")
              .eq("server_host", fileServerKey)
              .eq("item_type", variantItemType)
              .eq("external_id", externalId)
              .maybeSingle();
            const fileRow = cached as JsonRecord | null;
            const audioAt = Date.parse(stringOr(fileRow?.audio_probed_at, ""));
            const hasFreshAudio = Number.isFinite(audioAt) &&
              audioAt >= Date.now() - 180 * 24 * 3600 * 1000;
            const hasSubtitles = Boolean(fileRow?.subtitle_probed_at);
            const satisfiesTarget = subtitleTarget ? hasSubtitles : hasFreshAudio;
            if (fileRow && satisfiesTarget) {
              const { error: hydrateError } = await db.rpc("merge_cloud_title_file_languages", {
                p_user_id: userId,
                p_title_id: String(title.id),
                p_variant_id: String(variant.id),
                p_file_external_id: externalId,
                p_audio_tracks: hasFreshAudio && Array.isArray(fileRow.audio_tracks)
                  ? fileRow.audio_tracks
                  : [],
                p_subtitle_tracks: hasSubtitles && Array.isArray(fileRow.subtitle_tracks)
                  ? fileRow.subtitle_tracks
                  : [],
                p_has_audio: hasFreshAudio,
                p_has_subtitle: hasSubtitles,
              });
              if (!hydrateError) {
                diag.cacheHydrated++;
                updated++;
                return;
              }
            }
          }
        } catch (_) { /* cache miss/unavailable => probe normally */ }
      }

      // Series have no directly-streamable id (provider 406s on a series id) — resolve a
      // representative episode first. A series' audio is consistent across episodes.
      let targetUrl: string | null;
      let seriesEmpty = false;
      if (variantItemType === "series") {
        const resolved = await resolveSeriesEpisode(sourceId, externalId, userId, db).catch(() => ({ url: null, emptySeries: false }));
        targetUrl = resolved.url;
        seriesEmpty = resolved.emptySeries;
      } else {
        const target = await resolvePlaybackTarget(sourceId, variantItemType, externalId, userId, db).catch(() => null);
        targetUrl = target?.targetUrl ?? null;
      }
      if (!targetUrl) {
        // Empty shell confirmed by the panel (fiche with zero episode): a deterministic
        // negative — mark probed (audio + subtitles, mirroring relayEmpty) so the crawl
        // advances instead of re-resolving the same episode-less séries every tick.
        if (seriesEmpty) {
          diag.emptySeries++;
          await markProbed(mode === "probe" ? { subtitle_tracks: [], subtitle_probed_at: new Date().toISOString() } : {});
        } else {
          diag.noTarget++;
        }
        return;
      }

      // Account busy-lock: someone (any user, any device, the gateway, a viewer mid-film whose
      // per-user signals went dark) currently holds this provider ACCOUNT — skip WITHOUT
      // stamping so the title retries next tick. Honors the manual-backfill bypass
      // (ignoreLiveSession), which crons never send.
      if (body.ignoreLiveSession !== true) {
        const accountKey = providerAccountKeyFromUrl(targetUrl);
        if (accountKey && await accountBusyCached(accountKey)) {
          diag.accountBusy++;
          return;
        }
      }

      const candidateIdentityKey = mode === "probe"
        ? (probeIdentityKey || (await resolveSourceIdentity(sourceId, userId, db)).key)
        : "";
      if (mode === "probe" && !probeIdentityKey && candidateIdentityKey) {
        let circuitOpen = circuitOpenByIdentity.get(candidateIdentityKey);
        if (circuitOpen === undefined) {
          try {
            const { data: state } = await db.rpc("provider_probe_circuit_state", {
              p_identity_key: candidateIdentityKey,
            });
            const row = (Array.isArray(state) ? state[0] : state) as JsonRecord | null;
            circuitOpen = row?.open === true;
          } catch (_) {
            circuitOpen = false;
          }
          circuitOpenByIdentity.set(candidateIdentityKey, circuitOpen);
        }
        if (circuitOpen) {
          diag.circuitOpen++;
          return;
        }
      }
      let candidateFootprint = footprint;
      if (!candidateFootprint && mode === "probe") {
        candidateFootprint = footprintByCandidateSource.get(sourceId);
        if (candidateFootprint === undefined) {
          candidateFootprint = await getFootprint(db, sourceId, userId);
          footprintByCandidateSource.set(sourceId, candidateFootprint);
        }
      }
      if (candidateFootprint?.lowFootprint) {
        const localHits = footprintHitsByIdentity.get(candidateFootprint.identityKey) ?? 0;
        if (
          !candidateFootprint.allowed ||
          (
            candidateFootprint.maxPerHour != null &&
            candidateFootprint.hits + localHits >= candidateFootprint.maxPerHour
          )
        ) {
          diag.footprintCapped++;
          return;
        }
      }
      if (!await claimProviderFileProbe(db, candidateIdentityKey, probeLeaseOwner)) {
        diag.identityBusy++;
        return;
      }
      if (candidateFootprint?.lowFootprint) {
        footprintHitsByIdentity.set(
          candidateFootprint.identityKey,
          (footprintHitsByIdentity.get(candidateFootprint.identityKey) ?? 0) + 1,
        );
      }
      const noteProbeHealth = (ok: boolean) => {
        if (ok) cbOk++;
        else cbBanish++;
        if (!candidateIdentityKey) return;
        const health = probeHealthByIdentity.get(candidateIdentityKey) ?? { ok: 0, banish: 0 };
        if (ok) health.ok++;
        else health.banish++;
        probeHealthByIdentity.set(candidateIdentityKey, health);
      };
      try {
        let info: JsonRecord | null = null;
        let token = "";
      if (candidateFootprint?.lowFootprint && mode === "probe") {
        // Low-footprint provider (anti-ban): route the header-probe through the gateway's
        // RESIDENTIAL IP instead of the Cloudflare relay, so a mono-connection anti-abuse
        // account is seen from ONE household IP (probe + metadata + playback). Same JSON shape.
        // Human-like spacing between provider hits (concurrency is forced to 1 here).
        await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 1000)));
        try {
          const gw = await fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
            body: JSON.stringify({ url: targetUrl, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
          });
          if (!gw.ok) {
            diag.relayNotOk++;
            if (isBanishStatus(gw.status)) noteProbeHealth(false);
            if (debug && !sample) sample = { stage: "gatewayProbeNotOk", status: gw.status, host: new URL(targetUrl).host };
            return;
          }
          info = await gw.json().catch(() => null);
          noteProbeHealth(true);
        } catch (_) { diag.relayNotOk++; noteProbeHealth(false); return; }
        // Count the provider hit against the identity's hourly budget (observability + cap).
        try {
          await db.rpc("provider_footprint_record_hit", {
            p_identity_key: candidateFootprint.identityKey,
          });
        } catch (_) { /* best-effort */ }
      } else {
        const payload = JSON.stringify({ v: 1, sid: "audio-backfill", uid: userId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
        const signature = await hmacBase64Url(runtimeConfig.relayTokenSecret, payload);
        token = `${base64Url(encoder.encode(payload))}.${signature}`;

        const endpoint = mode === "probe" ? "probe-audio" : "vod-info";
        const res = await fetch(`${runtimeConfig.relayBaseUrl}/${endpoint}/${token}`, { headers: { accept: "application/json" } });
        if (!res.ok) {
          diag.relayNotOk++;
          if (isBanishStatus(res.status)) noteProbeHealth(false);
          if (debug && !sample) sample = { stage: "relayNotOk", status: res.status, host: new URL(targetUrl).host, body: (await res.text().catch(() => "")).slice(0, 200) };
          return;
        }
        info = await res.json().catch(() => null);
        noteProbeHealth(true);
      }
      if (debug && !sample && token) {
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
      // Absolute stream indexes are exact-file data. Keep untagged entries so
      // the offline Whisper queue can name them later without re-probing.
      const orderedTracks = mode === "probe" && info && Array.isArray(info.audioTracks)
        ? (info.audioTracks as JsonRecord[])
            .map((t) => ({
              index: Number(t?.index),
              lang: normalizeIsoLang(stringOrNull(t?.lang ?? t?.language)),
            }))
            .filter((t) => Number.isInteger(t.index))
        : [];

      const codes = new Set<string>();
      if (mode === "probe") {
        const incoming = info && Array.isArray(info.audioLanguages) ? info.audioLanguages : [];
        const hasTracks = (Array.isArray(info?.audioTracks) && info.audioTracks.length) || orderedSubtitles.length;
        // Truly empty (no langs AND no tracks at all) = header-parse failed → mark probed
        // (incl. subtitles) so the crawl advances, mirroring the audio progression marker.
        if (!incoming.length && !hasTracks) {
          diag.relayEmpty++;
          if (exactFileScope) {
            const persisted = await shareFileTracks(
              db,
              fileServerKey || await resolveFileTracksKey(sourceId, userId, db, targetUrl),
              variantItemType,
              externalId,
              [],
              [],
              true,
              true,
            );
            if (persisted) updated++;
            else diag.persistenceFailed++;
          } else {
            await markProbed(subtitleFields);
          }
          return;
        }
        for (const code of incoming) { const normalized = normalizeIsoLang(stringOrNull(code)); if (normalized) codes.add(normalized); }
      } else {
        const tracks = info && Array.isArray(info.audioTracks) ? info.audioTracks : [];
        if (!tracks.length) { diag.relayEmpty++; await markProbed(); return; }
        for (const track of tracks) { const normalized = normalizeIsoLang(stringOrNull((track as JsonRecord)?.language)); if (normalized) codes.add(normalized); }
      }
      // No audio language resolved, but the probe SUCCEEDED (tracks/subs present): still
      // persist subtitles + advance the audio marker so we don't re-probe forever.
      if (!codes.size) {
        diag.noLang++;
        if (exactFileScope) {
          const persisted = await shareFileTracks(
            db,
            fileServerKey || await resolveFileTracksKey(sourceId, userId, db, targetUrl),
            variantItemType,
            externalId,
            orderedTracks,
            orderedSubtitles,
            true,
            true,
          );
          if (persisted) updated++;
          else diag.persistenceFailed++;
        } else {
          await markProbed(subtitleFields);
        }
        return;
      }

      // Capture the ORDERED per-track map (absolute index -> lang) alongside the deduped
      // set, so the player never has to probe at playback. mode=probe only — it's the
      // path carrying the full container track list. Undetermined tracks kept (lang null)
      // to preserve index/position alignment for the engine.
      const sortedCodes = [...codes].sort();
      if (exactFileScope) {
        const persisted = await shareFileTracks(
          db,
          fileServerKey || await resolveFileTracksKey(sourceId, userId, db, targetUrl),
          variantItemType,
          externalId,
          orderedTracks,
          orderedSubtitles,
          true,
          true,
        );
        if (persisted) updated++;
        else diag.persistenceFailed++;
        const tmdbId = stringOrNull(title.provider_tmdb_id);
        if (tmdbId && !/^(tt)?0+$/i.test(tmdbId)) {
          try {
            await db.rpc("merge_catalog_title_audio", {
              p_item_type: itemType,
              p_provider_tmdb_id: tmdbId,
              p_codes: sortedCodes,
            });
          } catch (_) { /* best-effort global union */ }
        }
        return;
      }
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
      } finally {
        await releaseProviderFileProbe(db, candidateIdentityKey, probeLeaseOwner);
      }
    } catch (e) {
      diag.exception++;
      if (debug && !sample) sample = { stage: "exception", error: String(e).slice(0, 200) };
    }
  };

  for (let i = 0, batch = 0; i < titles.length; i += effConcurrency, batch++) {
    // Crawl-yield mid-tick (flag ON): a viewer/download can begin AFTER the entry check at the top
    // of this dimension already passed, during this ~100s tick. Re-check every ~8 batches and abort
    // the rest so the crawl stops racing the human for the provider's single slot. Cheap + bounded
    // (one indexed read every few batches) and only when the flag is ON — OFF keeps the original
    // loop with zero extra reads. Resumes from the cursor next tick (hasMore + lastId of processed).
    if (CRAWL_YIELD_TO_VIEWERS && body.ignoreLiveSession !== true && i > 0 && batch % 8 === 0
        && await userHasLiveSession(db, userId)) {
      return { mode, processed: i, updated, diag, skipped: "viewer-midtick", lastId: String(titles[i - 1].id), hasMore: true, ...(debug ? { sample } : {}) };
    }
    await Promise.all(titles.slice(i, i + effConcurrency).map((t) => processOne(t as JsonRecord)));
  }

  // Feed the circuit breaker ONE tick outcome (one write, no per-item row contention): a healthy
  // response anywhere in the tick clears it; a tick that's nothing but auth/rate/5xx rejections
  // advances it toward opening + back-off. Best-effort — never fail the crawl on a bookkeeping error.
  if (mode === "probe") {
    for (const [identityKey, health] of probeHealthByIdentity) {
      if (!health.ok && !health.banish) continue;
      try {
        await db.rpc("provider_probe_circuit_record_tick", {
          p_identity_key: identityKey,
          p_ok_count: health.ok,
          p_fail_count: health.banish,
        });
      } catch (_) { /* best-effort */ }
    }
  }

  // If the whole tick did no provider work because the account(s) were busy (account-wide path,
  // where the per-title gate — not the tick-level one — did the skipping), report it as skipped
  // so the exhausted-dimension mark isn't cleared and the fallthrough chain doesn't count it as
  // progress. hasMore keeps the cursor so the same titles are retried once the viewer stops.
  if (diag.accountBusy > 0 && updated === 0 && cbOk === 0 && cbBanish === 0) {
    return { mode, processed: 0, updated: 0, diag, skipped: "account-busy", lastId: afterId, hasMore: true };
  }
  if (diag.identityBusy > 0 && updated === 0 && cbOk === 0 && cbBanish === 0) {
    return { mode, processed: 0, updated: 0, diag, skipped: "identity-busy", lastId: afterId, hasMore: true };
  }
  if (diag.circuitOpen > 0 && updated === 0 && cbOk === 0 && cbBanish === 0) {
    return { mode, processed: 0, updated: 0, diag, skipped: "circuit-open", lastId: afterId, hasMore: true };
  }

  return {
    mode, scope: exactFileScope ? "file" : "title",
    processed: titles.length, updated, diag, ...(debug ? { sample } : {}),
    lastId, hasMore: titles.length === limit,
    ...(cbBanish || cbOk ? { probeHealth: { ok: cbOk, banish: cbBanish } } : {}),
  };
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

// Read-cutover trust artifact for the RAW catalogue (docs/roadmap/phase2-dedup-execution.md):
// prove the provider-global catalog_media_items is a faithful mirror of ONE source's per-user
// cloud_media_items BEFORE flipping NORVA_CATALOG_MEDIA_READ_SOURCE onto the global store. Same
// role runCatalogMirrorVerify plays for catalog_titles, but per-source (the RPC is source-scoped).
// `clean` is the flip gate: every per-user item mirrored (cloud_only=0), playback resolves
// identically from global (mismatch_playback_hint=0), and global is never blanker than per-user
// (global_weaker_*=0). A non-zero mismatch_metadata is tolerated — at multi-user scale keep-best
// can legitimately hold the richer of two users' rows. Read-only; service-role gated like backfill.
async function runCatalogMediaMirrorVerify(req: Request, db: SupabaseClient) {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");
  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const sourceId = stringOr(body.source_id ?? body.sourceId, "");
  if (!sourceId) throw new HttpError(400, "Missing source_id");
  const { data, error } = await db.rpc("catalog_media_mirror_diff", { p_source_id: sourceId });
  if (error) throw new HttpError(500, `catalog_media_mirror_diff failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
  const n = (k: string) => Number((row?.[k] as number | undefined) ?? -1);
  const clean = !!row &&
    n("cloud_only") === 0 && n("mismatch_playback_hint") === 0 &&
    n("global_weaker_title") === 0 && n("global_weaker_poster") === 0;
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

async function sha256BytesHex(value: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
