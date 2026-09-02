import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getEntitlementDecision, getEntitlementRuntime, limitNumber } from "../_shared/entitlements.ts";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import {
  bindCatalogVisibilityEpoch as bindCatalogVisibilityEpochShared,
  catalogVisibilityEpochHeaders,
  finalizeCatalogVisibilityResponse,
  latestBoundCatalogVisibilityEpoch,
  publicEdgeErrorLog,
  publicEdgeErrorPayload,
} from "../_shared/catalog-visibility-response.mjs";
import {
  PLAYBACK_EVENT_PUBLIC_SELECT,
  PLAYBACK_SESSION_PUBLIC_SELECT,
  sanitizeGatewaySession,
  sanitizePlaybackEvent,
  sanitizePlaybackSession,
} from "../_shared/cloud-public-view.mjs";
import {
  engineRawTokenExpiresAt,
  playbackTransportExpiresAt,
} from "../_shared/playback-expiry.mjs";
import {
  decideNativePlaybackHeartbeat,
  NATIVE_HEARTBEAT_ACTIVE_STATUSES,
  NATIVE_HEARTBEAT_MAX_SESSION_AGE_SECONDS,
} from "../_shared/native-playback-heartbeat-policy.mjs";
import {
  createProviderProbeTickGuard,
  decideProviderCircuit,
  isProviderBusyFailure,
  PROVIDER_HANDOFF_CIRCUIT_GRACE_MS,
  providerProbeTerminalCode,
  shouldOpenCircuitForProviderBusy,
} from "../_shared/provider-playback-circuit-policy.mjs";
import { sealRelayCoordinatorRoute } from "../_shared/relay-coordinator-route.mjs";
import { renderSubtitleReadyEmail } from "../_shared/subtitle-ready-email.ts";
import { cleanupMediaGatewaySession } from "../_shared/media-gateway-session-lifecycle.mjs";
import {
  buildMediaGatewayRoutingConfig,
  MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL,
  selectMediaGatewayRouteForGatewayId,
  selectMediaGatewayRouteForUserHash,
} from "../_shared/media-gateway-canary-routing.mjs";
import {
  type ActiveCatalogGeneration,
  assertActiveCatalogGenerationCurrent,
  callActiveCatalogGenerationRpc,
  catalogGenerationFields,
  catalogGenerationRpcFence,
  isRollingRpcUnavailable,
  isCatalogGenerationSuperseded,
  readActiveCatalogGenerationSnapshot,
} from "../_shared/catalog-generation.ts";
import {
  buildProviderDirectFallbackSnapshot,
  directFallbackLeaseTtlSeconds,
  ProviderDirectFallbackLeaseError,
  providerDirectFallbackLeaseOwner,
  withSourceDirectFallbackLease,
} from "../_shared/provider-direct-fallback-lease.mjs";
import {
  BoundedProviderResponseError,
  fetchBoundedProviderJson,
} from "../_shared/bounded-provider-response.mjs";
import { createMediaCacheTicket } from "../_shared/media-cache-ticket.ts";
import {
  awaitMediaCacheSingleflight,
  deriveMediaCacheCoordinationFingerprints,
  MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL,
  mediaCacheCoordinationKeyIsValid,
} from "../_shared/media-cache-singleflight.mjs";

type JsonRecord = Record<string, unknown>;
type MediaGatewayRoute = {
  kind: "default" | "canary";
  url: string;
  token: string;
  gatewayId: string | null;
};
type MediaGatewayRoutingConfig = {
  protocol: number;
  defaultRoute: MediaGatewayRoute | null;
  canaryRoute: MediaGatewayRoute | null;
  canaryUserHashes: readonly string[];
  canaryState: "off" | "standby" | "invalid" | "ready";
};
type RuntimeConfig = {
  relayBaseUrl: string;
  relayTokenSecret: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  mediaGatewayRouting: MediaGatewayRoutingConfig;
  lidWorkerUrl: string;
  lidWorkerToken: string;
  sourceConfigKey: string;
  whisperDetect: boolean; // Phase 2: detect untagged audio-track languages via the relay (Workers AI). Off by default.
  mediaCacheWorkerUrl: string;
  mediaCacheWorkerToken: string;
  mediaCacheTicketHmacKey: string;
  mediaCacheEnabled: boolean;
  mediaCacheTicketTtlSeconds: number;
  mediaCacheSingleflightEnabled: boolean;
  mediaCacheLiveJoinEnabled: boolean;
  mediaCacheCoordinationHmacKey: string;
  mediaCacheFollowerWaitMs: number;
};
type MediaCacheProducerContext = {
  protocol: number;
  workFingerprint: string;
  accountFingerprint: string;
  leaseToken: string;
  ownerInstanceFingerprint: string;
  admission: {
    mode: "off" | "shadow" | "enforced";
    admitted: boolean;
    score: number;
    confidence: number;
    reason: "repeated" | "popular" | "costly" | "not-admitted";
    ttlSeconds: number;
  };
};
type MediaCacheSingleflightLifecycle = {
  producer: MediaCacheProducerContext | null;
  transferredToGateway: boolean;
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
  cascadeHealth: "inactive" | "active" | "expiring" | "expired" | "conflict" | "misconfigured";
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
  "NORVA_MEDIA_GATEWAY_CANARY_URL",
  "NORVA_MEDIA_GATEWAY_CANARY_TOKEN",
  "NORVA_MEDIA_GATEWAY_CANARY_ID",
  "NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES",
  "NORVA_LID_WORKER_URL",
  "NORVA_LID_WORKER_TOKEN",
  "NORVA_SOURCE_CONFIG_KEY",
  "NORVA_WHISPER_DETECT",
  "NORVA_MEDIA_CACHE_WORKER_URL",
  "NORVA_MEDIA_CACHE_WORKER_TOKEN",
  "NORVA_MEDIA_CACHE_TICKET_HMAC_KEY",
  "NORVA_MEDIA_CACHE_ENABLED",
  "NORVA_MEDIA_CACHE_TICKET_TTL_SECONDS",
  "NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED",
  "NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED",
  "NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY",
  "NORVA_MEDIA_CACHE_FOLLOWER_WAIT_MS",
];
const PROVIDER_SLOT_RELEASE_DELAY_MS = boundedInt(
  Deno.env.get("NORVA_PROVIDER_SLOT_RELEASE_DELAY_MS") ?? Deno.env.get("PROVIDER_SLOT_RELEASE_DELAY_MS"),
  2_500,
  0,
  15_000,
);
const PROVIDER_CATALOG_REFRESH_DRAIN_MS = boundedInt(
  Deno.env.get("NORVA_PROVIDER_CATALOG_REFRESH_DRAIN_MS"),
  60_000,
  0,
  120_000,
);
const PROVIDER_NATIVE_TAKEOVER_GRACE_MS = boundedInt(
  Deno.env.get("NORVA_PROVIDER_NATIVE_TAKEOVER_GRACE_MS"),
  6_000,
  0,
  15_000,
);
// A Gateway startup may legitimately use its full 60-second startup budget,
// plus provider-drain and coordinator round trips. Keep the prepared claim
// alive for that bounded window so a ready Gateway session can still commit.
const EDGE_SESSION_COORDINATOR_LOCK_TTL_MS = 120_000;
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
  "subtitle_first_cue",
]);
const PLAYBACK_SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE_VALIDATION_PROTOCOL = 2;
const LANGUAGE_VALIDATION_METHOD = "whisper-strict-consensus-v4";
const LANGUAGE_VALIDATION_SCOPE = "lid-legacy-full";
const LANGUAGE_VALIDATION_RETRY_SECONDS = 24 * 60 * 60;
const LANGUAGE_VALIDATION_LEASE_SECONDS = 900;
const LANGUAGE_VALIDATION_TASK_BUDGET_MS = 270_000;
const LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS = 30_000;
const LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS = 240_000;
const LANGUAGE_VALIDATION_ACCOUNT_LEASE_SECONDS = LANGUAGE_VALIDATION_LEASE_SECONDS;
const LANGUAGE_VALIDATION_JOB_LEASE_SECONDS = 300;
const LANGUAGE_VALIDATION_POLL_SECONDS = 3;
const LANGUAGE_VALIDATION_MIN_SAMPLES = 4;
const LANGUAGE_VALIDATION_MIN_PROBABILITY = 0.95;
const LANGUAGE_VALIDATION_MIN_WORDS = 12;
const LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS = 8;
const LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS = 20;
const LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL = 1;
const LANGUAGE_VALIDATION_WINDOW_RECEIPT_MAX_CHARS = 98_304;
const LANGUAGE_VALIDATION_FINALIZE_BODY_MAX_BYTES = 1_048_576;
const LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL = 1;
const LANGUAGE_VALIDATION_RETRY_WORKER_BATCH = 2;
const LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS = 4;
// Persistent media-extraction failures must not consume a single-connection
// provider twice every minute. Watched files stay prioritized by the durable
// worker, but a failed Gateway attempt yields the provider lane for five
// minutes before another bounded retry.
const LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS = 5 * 60 * 1000;
const LANGUAGE_VALIDATION_WINDOW_RECEIPT_PATTERN =
  /^v1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/;

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
const ENV_MEDIA_GATEWAY_CANARY_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_GATEWAY_CANARY_URL") ?? "");
const ENV_MEDIA_GATEWAY_CANARY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_CANARY_TOKEN") ?? "";
const ENV_MEDIA_GATEWAY_CANARY_ID = Deno.env.get("NORVA_MEDIA_GATEWAY_CANARY_ID") ?? "";
const ENV_MEDIA_GATEWAY_CANARY_USER_HASHES = Deno.env.get("NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES") ?? "";
const ENV_LID_WORKER_URL = trimTrailingSlash(Deno.env.get("NORVA_LID_WORKER_URL") ?? "");
const ENV_LID_WORKER_TOKEN = Deno.env.get("NORVA_LID_WORKER_TOKEN") ?? "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const ENV_WHISPER_DETECT = Deno.env.get("NORVA_WHISPER_DETECT") ?? "";
const ENV_MEDIA_CACHE_WORKER_URL = trimTrailingSlash(Deno.env.get("NORVA_MEDIA_CACHE_WORKER_URL") ?? "");
const ENV_MEDIA_CACHE_WORKER_TOKEN = Deno.env.get("NORVA_MEDIA_CACHE_WORKER_TOKEN") ?? "";
const ENV_MEDIA_CACHE_TICKET_HMAC_KEY = Deno.env.get("NORVA_MEDIA_CACHE_TICKET_HMAC_KEY") ?? "";
const ENV_MEDIA_CACHE_ENABLED = Deno.env.get("NORVA_MEDIA_CACHE_ENABLED") ?? "";
const ENV_MEDIA_CACHE_TICKET_TTL_SECONDS = Deno.env.get("NORVA_MEDIA_CACHE_TICKET_TTL_SECONDS") ?? "";
const ENV_MEDIA_CACHE_SINGLEFLIGHT_ENABLED = Deno.env.get("NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED") ?? "";
const ENV_MEDIA_CACHE_LIVE_JOIN_ENABLED = Deno.env.get("NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED") ?? "";
const ENV_MEDIA_CACHE_COORDINATION_HMAC_KEY = Deno.env.get("NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY") ?? "";
const ENV_MEDIA_CACHE_FOLLOWER_WAIT_MS = Deno.env.get("NORVA_MEDIA_CACHE_FOLLOWER_WAIT_MS") ?? "";
const MEDIA_CACHE_SINGLEFLIGHT_OWNER_INSTANCE_ID = crypto.randomUUID();
const MEDIA_CACHE_SINGLEFLIGHT_LEASE_TTL_SECONDS = 120;
const MEDIA_CACHE_BACKGROUND_PREEMPT_WAIT_MS = 8_000;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUBTITLE_EMAIL_FROM = Deno.env.get("NORVA_SUBTITLE_EMAIL_FROM") ?? "Norva Updates <updates@norva.tv>";
const EMAIL_REPLY_TO = Deno.env.get("NORVA_EMAIL_REPLY_TO") ?? "support@norva.tv";
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://norva.tv").replace(/\/+$/, "");
const SUBTITLE_EMAIL_BATCH = 4;
const SUBTITLE_EMAIL_LEASE_SECONDS = 180;
const SUBTITLE_EMAIL_MAX_ATTEMPTS = 12;
const RESEND_TIMEOUT_MS = 10_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;
let lidDetectionPolicyCache: { value: LidDetectionPolicy; expiresAt: number } | null = null;
const languageValidationTasks = new Map<string, Promise<void>>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  return await finalizeCatalogVisibilityResponse(
    req,
    await handleRequest(req),
    supabase,
    { service: "norva-playback", corsHeaders },
  );
});

async function handleRequest(req: Request): Promise<Response> {
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
        version: 77,
        nativeHeartbeatProtocol: 1,
        providerCircuitProtocol: 1,
        exactTrackCrawlerProtocol: 2,
        providerFileProbeLeaseProtocol: 2,
        repairGatewayOnlyProtocol: 1,
        repairPreSpawnAttemptCancelProtocol: 1,
        basicLidConsensusProtocol: 2,
        vodContainerSelfHealProtocol: 1,
        exactFileCodecProfileProtocol: 1,
        relayCoordinatorLockTtlMs: EDGE_SESSION_COORDINATOR_LOCK_TTL_MS,
        languageValidationProtocol: LANGUAGE_VALIDATION_PROTOCOL,
        languageValidationPresenceIntentProtocol: 1,
        languageValidationPlaybackLeaseProtocol: 1,
        languageValidationActivityProtocol: 1,
        languageValidationDurationClaimProtocol: 1,
        languageValidationWindowCheckpointProtocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL,
        languageValidationTaskBudgetMs: LANGUAGE_VALIDATION_TASK_BUDGET_MS,
        languageValidationFetchTimeoutMs: LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS,
        languageValidationPostFetchReserveMs: LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS,
        languageValidationJobLeaseSeconds: LANGUAGE_VALIDATION_JOB_LEASE_SECONDS,
        languageValidationSampleDurationSeconds: LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS,
        languageValidationRetryWorkerProtocol: LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL,
        languageValidationRetryWorkerBatch: LANGUAGE_VALIDATION_RETRY_WORKER_BATCH,
        languageValidationProviderAttemptProtocol: 1,
        languageValidationViewerPreemptionProtocol: 1,
        languageValidationMaxConsecutiveProviderNoProgress:
          LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS,
        languageValidationGatewayFailureRetrySeconds:
          LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS / 1000,
        automaticStrictUndAudioProtocol: 1,
        automaticStrictUndAudioConsensus: "4/6",
        languageValidationGatewayMethod: "POST",
        languageValidationHeaderCapability: true,
        languageValidationServiceAuthRequired: true,
        relayTakeoverProtocol: 1,
        handoffCircuitGraceMs: PROVIDER_HANDOFF_CIRCUIT_GRACE_MS,
        engineTrackProbeBlocking: false,
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
        lidCascadeHealth: lidPolicy.cascadeHealth,
        lidCascadeWorkerConfigured: Boolean(config.lidWorkerUrl && config.lidWorkerToken),
        exactEpisodeAudioPipeline: true,
        entitlements: true,
        entitlementsMode: entitlementRuntime.mode,
        entitlementsEnforced: entitlementRuntime.enforced,
        relayConfigured: Boolean(config.relayBaseUrl && config.relayTokenSecret),
        gatewayConfigured: Boolean(config.mediaGatewayUrl && config.mediaGatewayToken),
        mediaGatewayCanaryRouting: {
          protocol: MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL,
          state: config.mediaGatewayRouting.canaryState,
          selectedUsers: config.mediaGatewayRouting.canaryUserHashes.length,
        },
        exactTailDrainSafe: true,
        providerCatalogRefreshDrainMs: PROVIDER_CATALOG_REFRESH_DRAIN_MS,
        completeHlsCacheCallbackProtocol: 1,
        providerAdaptiveRouteControlProtocol: 1,
        privateMediaCacheTicketProtocol: 1,
        sharedMediaCacheHotPlaybackProtocol: 1,
        sharedMediaCachePublicationProtocol: 1,
        sharedMediaCacheSingleflightProtocol: MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL,
        sharedMediaCacheDemandContinuationProtocol: 1,
        sharedMediaCacheLiveJoinProtocol: 1,
        privateMediaCacheDelivery: {
          enabled: config.mediaCacheEnabled,
          workerConfigured: Boolean(config.mediaCacheWorkerUrl && config.mediaCacheWorkerToken),
          ticketKeyConfigured: /^[0-9a-f]{64}$/i.test(config.mediaCacheTicketHmacKey),
          ticketTtlSeconds: config.mediaCacheTicketTtlSeconds,
          singleflight: {
            requested: config.mediaCacheSingleflightEnabled,
            active: config.mediaCacheSingleflightEnabled
              && Boolean(mediaCachePlaybackWorkerUrl(config))
              && mediaCacheCoordinationKeyIsValid(config.mediaCacheCoordinationHmacKey),
            coordinationKeyConfigured: mediaCacheCoordinationKeyIsValid(
              config.mediaCacheCoordinationHmacKey,
            ),
            followerWaitMs: config.mediaCacheFollowerWaitMs,
            liveJoinRequested: config.mediaCacheLiveJoinEnabled,
            liveJoinActive: config.mediaCacheLiveJoinEnabled
              && config.mediaCacheSingleflightEnabled
              && Boolean(mediaCachePlaybackWorkerUrl(config))
              && mediaCacheCoordinationKeyIsValid(config.mediaCacheCoordinationHmacKey),
          },
        },
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
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      segments[1] === "language-validation" &&
      !segments[2]
    ) {
      const identity = await requireIdentity(req, supabase);
      const result = await startPlaybackLanguageValidation(req, identity.userId, supabase);
      return json(req, result.body, result.status);
    }
    if (
      req.method === "GET" &&
      segments[0] === "playback" &&
      segments[1] === "language-validation" &&
      segments[2] &&
      !segments[3]
    ) {
      const identity = await requireIdentity(req, supabase);
      const result = await getPlaybackLanguageValidation(segments[2], identity.userId, supabase);
      return json(req, result.body, result.status);
    }
    if (req.method === "POST" && segments[0] === "playback" && segments[1] === "events") {
      const identity = await requireIdentity(req, supabase);
      return json(req, await recordPlaybackEvent(req, identity.userId, supabase, identity.deviceId ?? null), 201);
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "heartbeat" &&
      !segments[4]
    ) {
      const identity = await requireIdentity(req, supabase);
      return json(req, await heartbeatPlaybackSession(segments[2], identity.userId, supabase));
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "media-cache-ticket" &&
      !segments[4]
    ) {
      const identity = await requireIdentity(req, supabase);
      return json(
        req,
        await issueMediaCachePlaybackTicket(req, segments[2], identity.userId, supabase),
      );
    }
    if (
      req.method === "POST" &&
      segments[0] === "playback" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "provider-failure" &&
      !segments[4]
    ) {
      const identity = await requireIdentity(req, supabase);
      return json(
        req,
        await reportProviderPlaybackFailure(req, segments[2], identity.userId, supabase),
      );
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
    if (req.method === "POST" && segments[0] === "codec-profile-backfill") {
      return json(req, await runCodecProfileBackfill(req, supabase));
    }
    // Dedicated route: an older edge replica returns 404 instead of interpreting a
    // benchmark payload as a normal audio-backfill mutation during a rolling deploy.
    if (req.method === "POST" && segments[0] === "lid-benchmark") {
      return json(req, await runLidBenchmarkEndpoint(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "transcribe-callback") {
      return json(req, await runTranscribeCallback(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "subtitle-email-delivery") {
      return json(req, await runSubtitleEmailDelivery(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "language-validation-worker" && !segments[1]) {
      return json(req, await runLanguageValidationRetryWorker(req, supabase), 202);
    }
    if (req.method === "POST" && segments[0] === "pregen-gate") {
      return json(req, await runPregenGate(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "account-activity") {
      return json(req, await runAccountActivity(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "provider-route" && segments[1] === "resolve") {
      return json(req, await runProviderRouteResolve(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "provider-route" && segments[1] === "activity") {
      return json(req, await runProviderRouteActivity(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "provider-route" && segments[1] === "benchmark") {
      return json(req, await runProviderRouteBenchmark(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "media-cache" && segments[1] === "publication") {
      return json(req, await runMediaCachePublicationCallback(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "media-cache" && segments[1] === "producer-control") {
      return json(req, await runMediaCacheProducerControl(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "media-cache" && segments[1] === "maintenance") {
      return json(req, await runMediaCacheMaintenance(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "media-cache" && segments[1] === "purge") {
      return json(req, await runMediaCachePurge(req, supabase), 202);
    }
    if (req.method === "POST" && segments[0] === "media-cache" && segments[1] === "recovery") {
      return json(req, await runMediaCacheRecovery(req, supabase));
    }
    if (req.method === "POST" && segments[0] === "complete-cache-callback") {
      return json(req, await runCompleteHlsCacheCallback(req, supabase));
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
    const payload = publicEdgeErrorPayload(error, status, {
      unavailableMessage: "Norva Playback is temporarily unavailable",
    });
    console.error("[norva-playback]", publicEdgeErrorLog(error, status, payload));
    return json(req, payload, status);
  }
}

type ActiveCatalogPatchResult = {
  data: JsonRecord[];
  error: unknown;
  superseded: boolean;
};

// Catalog observations are mutable metadata on a physical generation row. The
// transient proof fields are validated and cleared atomically by the database
// trigger, so a head/config/visibility ABA cannot authorize a late playback
// writer. A superseded observation is successful cancellation: playback and
// source health must never be failed because its former generation disappeared.
async function patchActiveCatalogTitleVariants(
  db: SupabaseClient,
  options: {
    userId: string;
    sourceId: string;
    patch: JsonRecord;
    generation?: ActiveCatalogGeneration;
    id?: string | null;
    itemType?: string | null;
    externalId?: string | null;
  },
): Promise<ActiveCatalogPatchResult> {
  try {
    const generation = options.generation ?? await readActiveCatalogGenerationSnapshot(
      db,
      options.sourceId,
      options.userId,
    );
    await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
    let query = db
      .from("cloud_title_variants")
      .update({ ...options.patch, ...catalogGenerationFields(generation) })
      .eq("user_id", options.userId)
      .eq("source_id", options.sourceId)
      .eq("generation_id", generation.generationId);
    if (options.id) query = query.eq("id", options.id);
    if (options.itemType) query = query.eq("item_type", options.itemType);
    if (options.externalId) query = query.eq("external_id", options.externalId);
    const { data, error } = await query.select("id");
    if (error) {
      if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
      return { data: [], error, superseded: false };
    }
    try {
      await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
    } catch (error) {
      if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
      throw error;
    }
    return { data: (data ?? []) as JsonRecord[], error: null, superseded: false };
  } catch (error) {
    if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
    return { data: [], error, superseded: false };
  }
}

async function patchActiveCatalogMediaItems(
  db: SupabaseClient,
  options: {
    userId: string;
    sourceId: string;
    patch: JsonRecord;
    generation?: ActiveCatalogGeneration;
    id: string;
    updatedAt?: string | null;
  },
): Promise<ActiveCatalogPatchResult> {
  try {
    const generation = options.generation ?? await readActiveCatalogGenerationSnapshot(
      db,
      options.sourceId,
      options.userId,
    );
    await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
    let query = db
      .from("cloud_media_items")
      .update({ ...options.patch, ...catalogGenerationFields(generation) })
      .eq("id", options.id)
      .eq("user_id", options.userId)
      .eq("source_id", options.sourceId)
      .eq("generation_id", generation.generationId);
    if (options.updatedAt) query = query.eq("updated_at", options.updatedAt);
    const { data, error } = await query.select("id");
    if (error) {
      if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
      return { data: [], error, superseded: false };
    }
    try {
      await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
    } catch (error) {
      if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
      throw error;
    }
    return { data: (data ?? []) as JsonRecord[], error: null, superseded: false };
  } catch (error) {
    if (isCatalogGenerationSuperseded(error)) return { data: [], error: null, superseded: true };
    return { data: [], error, superseded: false };
  }
}

async function requireIdentity(req: Request, db: SupabaseClient): Promise<CloudIdentity> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");

  // Vérif locale d'abord (voir _shared/local-auth.ts) — GoTrue n'est consulté
  // que si le verdict est indécidable localement (alg asymétrique, secret absent).
  const local = await verifyUserJwtLocally(token);
  if (local !== "invalid" && local !== "fallback") {
    await bindCatalogVisibilityEpoch(req, local.id, db);
    return { userId: local.id };
  }
  if (local === "fallback") {
    const { data, error } = await db.auth.getUser(token);
    if (!error && data.user) {
      await bindCatalogVisibilityEpoch(req, data.user.id, db);
      return { userId: data.user.id };
    }
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
  await bindCatalogVisibilityEpoch(req, device.user_id, db);
  return { userId: device.user_id, deviceId: device.id };
}

async function bindCatalogVisibilityEpoch(req: Request, userId: string, db: SupabaseClient) {
  try {
    await bindCatalogVisibilityEpochShared(req, userId, db);
  } catch (_) {
    console.warn("[norva-playback] catalog visibility epoch unavailable");
    throw new HttpError(503, "Catalog visibility is temporarily unavailable");
  }
}

async function requirePlaybackEntitlement(
  userId: string,
  db: SupabaseClient,
) {
  const decision = await getEntitlementDecision(db, userId);
  if (!decision.allowed) throwEntitlementRequired("playback", decision);

  const limit = limitNumber(decision.limits, "concurrent_streams", 0);
  if (limit <= 0) throwEntitlementRequired("concurrent_streams", decision, { limit, current: 0 });
  return { decision, limit };
}

async function requirePlaybackCapacity(
  userId: string,
  db: SupabaseClient,
  replacingProviderAccountHash: string | null = null,
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>> | null = null,
) {
  const capacity = entitlement ?? await requirePlaybackEntitlement(userId, db);
  const { decision, limit } = capacity;

  let activeQuery = db
    .from("cloud_playback_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["pending", "ready"])
    .gt("expires_at", new Date().toISOString());
  // Starting another title on the same single-slot provider account is a
  // replacement, not a second concurrent entitlement. The atomic claim below
  // expires that exact account's previous session before the new one is visible.
  if (replacingProviderAccountHash) {
    activeQuery = activeQuery.or(
      `provider_account_hash.is.null,provider_account_hash.neq.${replacingProviderAccountHash}`,
    );
  }
  const { count, error } = await activeQuery;

  if (error) throwDb(error, "Unable to verify Norva access limits");
  if ((count ?? 0) >= limit) {
    throwEntitlementRequired("concurrent_streams", decision, { limit, current: count ?? 0 });
  }
  return capacity;
}

function throwEntitlementRequired(feature: string, decision: unknown, usage?: unknown): never {
  throw new HttpError(402, "Norva access required", {
    code: "subscription_required",
    feature,
    entitlement: decision,
    usage,
  });
}

function publicPlaybackSession(value: unknown): JsonRecord {
  return sanitizePlaybackSession(stripMkvH264FastStartProofDeep(value)) as JsonRecord;
}

function stripMkvH264FastStartProofDeep(value: unknown, depth = 0): unknown {
  // Playback hints are persisted owner-readable JSON. The signed attestation is
  // not a secret, but it is deliberately not part of the public playback API.
  // Copy while walking so response sanitization never mutates the DB object.
  if (depth > 24) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => stripMkvH264FastStartProofDeep(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const clean: JsonRecord = {};
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    if (
      key === "mkvH264FastStartProof" || key === "mkv_h264_fast_start_proof" ||
      key === "mkvCompleteHlsCacheProof" || key === "mkv_complete_hls_cache_proof" ||
      key === "__norvaMkvH264FastStartItemCasV2"
    ) continue;
    clean[key] = stripMkvH264FastStartProofDeep(entry, depth + 1);
  }
  return clean;
}

async function providerAccountHashFromUrl(targetUrl: string): Promise<string> {
  const accountKey = providerAccountKeyFromUrl(targetUrl);
  if (!accountKey) throw new HttpError(422, "Provider account could not be identified");
  return await sha256Hex(accountKey);
}

async function assertProviderCircuitClosed(
  providerAccountHash: string,
  db: SupabaseClient,
) {
  const { data, error } = await db
    .from("provider_playback_circuits")
    .select("blocked_until,failure_count,reason_code")
    .eq("provider_account_hash", providerAccountHash)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify provider playback availability");
  const decision = decideProviderCircuit({ blockedUntil: data?.blocked_until });
  if (!decision.open) return;
  throw new HttpError(409, "Provider account is already in use", {
    code: "PROVIDER_ACCOUNT_BUSY",
    upstreamStatus: 458,
    retryAfterSeconds: decision.retryAfterSeconds,
    blockedUntil: data?.blocked_until ?? null,
  });
}

async function latestProviderSelfReleaseAt(
  providerAccountHash: string,
  db: SupabaseClient,
  excludeSessionId: string | null = null,
): Promise<string | null> {
  let query = db
    .from("cloud_playback_sessions")
    .select("superseded_at, updated_at, expires_at")
    .eq("provider_account_hash", providerAccountHash)
    .or("superseded_at.not.is.null,status.in.(expired,failed)")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (excludeSessionId) query = query.neq("id", excludeSessionId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.warn(
      "[norva-playback] unable to load latest provider self-release",
      error.message,
    );
    return null;
  }
  const row = recordOrEmpty(data);
  return stringOrNull(row.superseded_at) || stringOrNull(row.updated_at) || stringOrNull(row.expires_at);
}

async function openProviderPlaybackCircuit(
  providerAccountHash: string,
  db: SupabaseClient,
  escalate: boolean,
) {
  const { data, error } = await db.rpc("open_provider_playback_circuit", {
    p_provider_account_hash: providerAccountHash,
    p_reason_code: "PROVIDER_BUSY",
    p_escalate: escalate,
  });
  if (error) throwDb(error, "Unable to open provider playback circuit");
  const row = Array.isArray(data) ? recordOrEmpty(data[0]) : recordOrEmpty(data);
  const blockedUntil = stringOrNull(row.blocked_until);
  const decision = decideProviderCircuit({ blockedUntil });
  return {
    code: "PROVIDER_ACCOUNT_BUSY",
    upstreamStatus: 458,
    blockedUntil,
    retryAfterSeconds: decision.retryAfterSeconds,
    failureCount: boundedInt(row.failure_count, 1, 1, 16),
  };
}

async function releaseSupersededPlaybackSessions(
  sessionIds: string[],
  db: SupabaseClient,
) {
  if (!sessionIds.length) return 0;
  const { data: sessions, error } = await db
    .from("cloud_playback_sessions")
    .select("id,user_id")
    .in("id", sessionIds);
  if (error) throwDb(error, "Unable to load superseded playback sessions");
  const results = await Promise.allSettled(
    (sessions ?? []).map((session) => expirePlaybackSession(
      stringOr(session.id, ""),
      stringOr(session.user_id, ""),
      db,
    )),
  );
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.warn(
        "[norva-playback] superseded transport cleanup failed",
        result.reason instanceof Error ? result.reason.message : "unknown",
      );
    }
  });
  return sessionIds.length;
}

const PROVIDER_NETWORK_CAUSES = new Set([
  "PROVIDER_BUSY",
  "PROVIDER_CONNECT_TIMEOUT",
  "PROVIDER_RESPONSE_TIMEOUT",
  "PROVIDER_CONNECTION_RESET",
  "PROVIDER_DNS_FAILURE",
  "PROVIDER_TLS_FAILURE",
  "PROVIDER_NETWORK_UNREACHABLE",
  "PROVIDER_HTTP_ERROR",
]);

function boundedProviderNetworkCause(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  return PROVIDER_NETWORK_CAUSES.has(normalized) ? normalized : "PROVIDER_HTTP_ERROR";
}

async function reportProviderPlaybackFailure(
  req: Request,
  id: string,
  userId: string,
  db: SupabaseClient,
) {
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(id)) {
    throw new HttpError(400, "Invalid playback session id");
  }
  const body = await readJson(req);
  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .select("id,user_id,status,provider_account_hash,superseded_at,error_code")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify provider playback failure");
  if (!session) throw new HttpError(404, "Playback session unavailable");
  if (session.superseded_at) {
    throw new HttpError(409, "Playback session was replaced", {
      code: "PLAYBACK_SUPERSEDED",
    });
  }

  const providerAccountHash = stringOr(session.provider_account_hash, "");
  if (!providerAccountHash) throw new HttpError(409, "Playback session has no provider account");
  const upstreamStatus = boundedNullableInt(
    body.upstreamStatus ?? body.upstream_status ?? body.httpStatus ?? body.http_status,
    400,
    599,
  );
  const requestedCode = stringOr(body.code ?? body.errorCode ?? body.error_code, "");
  const providerBusy = isProviderBusyFailure({ code: requestedCode, upstreamStatus });
  const networkCause = providerBusy
    ? "PROVIDER_BUSY"
    : boundedProviderNetworkCause(body.networkCause ?? body.network_cause ?? requestedCode);

  // Idempotent client reporting: one playback attempt can surface the same
  // terminal signal through Media3 and its WebView close callback. Do not extend
  // the circuit or increase its failure count twice for the same session.
  if (stringOr(session.error_code, "") === networkCause.toLowerCase()) {
    return { ok: true, duplicate: true, code: networkCause };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from("cloud_playback_sessions")
    .update({
      status: "failed",
      error_code: networkCause.toLowerCase(),
      error_message: networkCause,
      expires_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .eq("user_id", userId)
    .in("status", ["pending", "ready"])
    .is("error_code", null)
    .select("id")
    .maybeSingle();
  if (updateError) throwDb(updateError, "Unable to record provider playback failure");
  if (!updated) return { ok: true, duplicate: true, code: networkCause };

  let circuit = null;
  let circuitSkipped = false;
  if (providerBusy) {
    const lastSelfReleaseAt = await latestProviderSelfReleaseAt(providerAccountHash, db, id);
    if (shouldOpenCircuitForProviderBusy({ lastSelfReleaseAt })) {
      circuit = await openProviderPlaybackCircuit(providerAccountHash, db, false);
    } else {
      circuitSkipped = true;
    }
  }
  const cleanup = await expirePlaybackSession(id, userId, db).catch(() => null);
  return {
    ok: true,
    code: networkCause,
    upstreamStatus,
    circuit,
    ...(circuitSkipped ? { circuitSkipped: true } : {}),
    transportReleased: Boolean(cleanup),
  };
}

function playbackRequestAbortError(): Error {
  const error = new Error("Playback request aborted");
  error.name = "AbortError";
  return error;
}

async function preflightAuthorizedMediaCachePlayback(
  mediaCacheValue: unknown,
  requestSignal: AbortSignal,
): Promise<void> {
  const mediaCache = recordOrEmpty(mediaCacheValue);
  const authorization = recordOrEmpty(mediaCache.authorization);
  const playlistUrl = stringOr(mediaCache.playlistUrl, "");
  const ticket = stringOr(authorization.token, "");
  if (!playlistUrl || authorization.scheme !== "Bearer" || !ticket) {
    throw new HttpError(503, "Private media cache delivery is unavailable", {
      code: "MEDIA_CACHE_DELIVERY_UNAVAILABLE",
      cacheCode: "authorization-invalid",
    });
  }
  if (requestSignal.aborted) throw playbackRequestAbortError();
  let response: Response;
  try {
    response = await fetch(playlistUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${ticket}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch (_) {
    throw new HttpError(503, "Private media cache delivery is unavailable", {
      code: "MEDIA_CACHE_DELIVERY_UNAVAILABLE",
      cacheCode: "network",
    });
  }
  if (!response.ok) {
    let cacheCode = `http-${response.status}`;
    try {
      const errorPayload = recordOrEmpty(await response.json());
      const candidate = stringOr(errorPayload.code, "").toLowerCase();
      if (/^[a-z0-9_-]{1,64}$/.test(candidate)) cacheCode = candidate;
    } catch (_) {
      await response.body?.cancel().catch(() => {});
    }
    throw new HttpError(503, "Private media cache delivery is unavailable", {
      code: "MEDIA_CACHE_DELIVERY_UNAVAILABLE",
      cacheCode,
      cacheStatus: response.status,
    });
  }
  const contentType = stringOr(response.headers.get("content-type"), "").toLowerCase();
  if (!contentType.includes("mpegurl")) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(503, "Private media cache delivery is unavailable", {
      code: "MEDIA_CACHE_DELIVERY_UNAVAILABLE",
      cacheCode: "playlist-content-type",
    });
  }
  await response.body?.cancel().catch(() => {});
  if (requestSignal.aborted) throw playbackRequestAbortError();
}

async function completeClaimedMediaCachePlayback(options: {
  req: Request;
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>>;
  sessionId: string;
  userId: string;
  expiresAt: string;
  claimValue: unknown;
  expectedObjectKey?: string | null;
}) {
  const {
    req, db, runtimeConfig, entitlement, sessionId, userId, expiresAt,
    claimValue, expectedObjectKey = null,
  } = options;
  const rows = Array.isArray(claimValue) ? claimValue : (claimValue ? [claimValue] : []);
  if (rows.length !== 1) {
    throw new HttpError(503, "Private media cache claim is ambiguous", {
      code: "MEDIA_CACHE_CLAIM_INVALID",
    });
  }
  const claim = recordOrEmpty(rows[0]);
  if (claim.cache_hit !== true) {
    throw new HttpError(503, "Private media cache claim is invalid", {
      code: "MEDIA_CACHE_CLAIM_INVALID",
    });
  }
  if (expectedObjectKey && stringOr(claim.object_key, "") !== expectedObjectKey) {
    throw new HttpError(409, "Shared media cache work authority changed", {
      code: "MEDIA_CACHE_WORK_AUTHORITY_CHANGED",
    });
  }
  if (claim.capacity_exceeded === true) {
    throwEntitlementRequired("concurrent_streams", entitlement.decision, {
      limit: entitlement.limit,
      current: boundedInt(claim.current_streams, entitlement.limit, 0, 64),
    });
  }

  const claimedSessionId = stringOr(claim.new_session_id, "");
  if (claimedSessionId !== sessionId) {
    throw new HttpError(503, "Private media cache claim is invalid", {
      code: "MEDIA_CACHE_CLAIM_INVALID",
    });
  }
  const supersededSessionIds = Array.isArray(claim.superseded_session_ids)
    ? claim.superseded_session_ids
      .map((value) => stringOrNull(value))
      .filter((value): value is string => Boolean(value))
    : [];

  try {
    if (req.signal.aborted) throw playbackRequestAbortError();
    const mediaCache = await createAuthorizedMediaCachePlayback(runtimeConfig, sessionId, claim);
    await preflightAuthorizedMediaCachePlayback(mediaCache, req.signal);
    const { data: session, error: sessionError } = await db
      .from("cloud_playback_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .single();
    if (sessionError || !session) {
      if (sessionError) throwDb(sessionError, "Unable to load shared media cache playback session");
      throw new HttpError(500, "Unable to load shared media cache playback session");
    }
    await releaseSupersededPlaybackSessions(supersededSessionIds, db);
    if (req.signal.aborted) throw playbackRequestAbortError();
    runBackground(db.rpc("norva_record_media_cache_metric", {
      p_metric: "viewer_joined", p_value: 1, p_samples: 1,
      p_layer: "l2", p_market_region: "global", p_route_slot: "none",
      p_route_protocol: "none", p_outcome: "hit", p_score: null, p_confidence: null,
    }).then(() => undefined));
    return {
      session: publicPlaybackSession(session),
      playback: {
        mode: "shared-cache",
        status: "ready",
        url: mediaCache.playlistUrl,
        transport: mediaCache.transport,
        mediaCache,
        gatewayRequired: false,
        transportExpiresAt: expiresAt,
        sessionExpiresAt: expiresAt,
      },
    };
  } catch (claimError) {
    try {
      await expirePlaybackSession(sessionId, userId, db);
    } catch (_) {
      console.warn("[norva-playback] unable to roll back shared media cache playback claim");
    }
    const details = claimError instanceof HttpError ? recordOrEmpty(claimError.details) : {};
    if (details.code === "MEDIA_CACHE_DELIVERY_UNAVAILABLE") {
      await releaseSupersededPlaybackSessions(supersededSessionIds, db).catch(() => null);
      const objectKey = stringOr(claim.object_key, "").toLowerCase();
      const cacheCode = stringOr(details.cacheCode, "").toLowerCase();
      runBackground((async () => {
        await db.rpc("norva_record_media_cache_metric", {
          p_metric: "cache_fallback",
          p_value: 1,
          p_samples: 1,
          p_layer: "l2",
          p_market_region: "global",
          p_route_slot: "none",
          p_route_protocol: "none",
          p_outcome: "fallback",
          p_score: null,
          p_confidence: null,
        });
        if (MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)
          && ["asset_corrupt", "manifest_invalid", "object_quarantined"].includes(cacheCode)) {
          await db.rpc("norva_enqueue_media_cache_purge", {
            p_object_key: objectKey,
            p_reason: "corruption",
          });
        }
      })());
      return null;
    }
    throw claimError;
  }
}

async function tryCreateHotMediaCachePlayback(options: {
  req: Request;
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>>;
  sessionId: string;
  userId: string;
  sourceId: string;
  deviceId: string | null;
  itemType: string;
  itemId: string;
  targetUrlHash: string;
  streamMime: string | null;
  playbackHint: JsonRecord;
  expiresAt: string;
}) {
  const {
    req, db, runtimeConfig, entitlement, sessionId, userId, sourceId,
    deviceId, itemType, itemId, targetUrlHash, streamMime, playbackHint, expiresAt,
  } = options;
  if (!mediaCachePlaybackWorkerUrl(runtimeConfig)) return null;

  const { data, error } = await db.rpc("norva_claim_media_cache_playback", {
    p_session_id: sessionId,
    p_user_id: userId,
    p_source_id: sourceId,
    p_device_id: deviceId,
    p_item_type: itemType,
    p_item_id: itemId,
    p_target_url_hash: targetUrlHash,
    p_stream_mime: streamMime,
    p_playback_hint: playbackHint,
    p_expires_at: expiresAt,
    p_ticket_ttl_seconds: runtimeConfig.mediaCacheTicketTtlSeconds,
    p_concurrent_limit: entitlement.limit,
  });
  // The claim is a write RPC. An ambiguous database failure must never fall
  // through to a provider-backed session, because the cache session may already
  // have committed and would then own a second entitlement generation.
  if (error) throwDb(error, "Unable to claim shared media cache playback");
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (rows.length === 0) return null;
  return await completeClaimedMediaCachePlayback({
    req, db, runtimeConfig, entitlement, sessionId, userId, expiresAt,
    claimValue: rows,
  });
}

async function claimReadyMediaCacheWorkPlayback(options: {
  req: Request;
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>>;
  workFingerprint: string;
  expectedObjectKey: string;
  sessionId: string;
  userId: string;
  sourceId: string;
  deviceId: string | null;
  itemType: string;
  itemId: string;
  targetUrlHash: string;
  streamMime: string | null;
  playbackHint: JsonRecord;
  expiresAt: string;
}) {
  const {
    req, db, runtimeConfig, entitlement, workFingerprint, expectedObjectKey,
    sessionId, userId, sourceId, deviceId, itemType, itemId, targetUrlHash,
    streamMime, playbackHint, expiresAt,
  } = options;
  const { data, error } = await db.rpc("norva_claim_ready_media_cache_work_playback", {
    p_work_fingerprint: workFingerprint,
    p_session_id: sessionId,
    p_user_id: userId,
    p_source_id: sourceId,
    p_device_id: deviceId,
    p_item_type: itemType,
    p_item_id: itemId,
    p_target_url_hash: targetUrlHash,
    p_stream_mime: streamMime,
    p_playback_hint: playbackHint,
    p_expires_at: expiresAt,
    p_ticket_ttl_seconds: runtimeConfig.mediaCacheTicketTtlSeconds,
    p_concurrent_limit: entitlement.limit,
  });
  // A completed work result is already globally visible. Ambiguous errors must
  // not open a second provider/FFmpeg producer behind it.
  if (error) throwDb(error, "Unable to claim completed shared media cache work");
  return await completeClaimedMediaCachePlayback({
    req, db, runtimeConfig, entitlement, sessionId, userId, expiresAt,
    claimValue: data,
    expectedObjectKey,
  });
}

async function rollbackMediaCacheLivePlayback(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  attachmentId: string,
) {
  const { error } = await db.rpc("norva_rollback_media_cache_live_playback", {
    p_session_id: sessionId,
    p_user_id: userId,
    p_attachment_id: attachmentId,
  });
  if (error) throw error;
}

async function revokeMediaCacheLiveGatewayAttachment(options: {
  route: MediaGatewayRoute;
  gatewaySessionId: string;
  attachmentId: string;
  playbackSessionId: string;
}) {
  const { route, gatewaySessionId, attachmentId, playbackSessionId } = options;
  const url = new URL(
    `${route.url}/sessions/${encodeURIComponent(gatewaySessionId)}` +
      `/viewers/${encodeURIComponent(attachmentId)}`,
  );
  url.searchParams.set("playbackSessionId", playbackSessionId);
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${route.token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new HttpError(response.status, "Media gateway refused live attachment cleanup");
  }
  await response.body?.cancel().catch(() => {});
  return true;
}

async function tryCreateLiveMediaCachePlayback(options: {
  req: Request;
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>>;
  workFingerprint: string;
  userId: string;
  sourceId: string;
  deviceId: string | null;
  itemType: string;
  itemId: string;
  targetUrlHash: string;
  streamMime: string | null;
  playbackHint: JsonRecord;
  expiresAt: string;
}) {
  const {
    req, db, runtimeConfig, entitlement, workFingerprint, userId, sourceId,
    deviceId, itemType, itemId, targetUrlHash, streamMime, playbackHint, expiresAt,
  } = options;
  if (!runtimeConfig.mediaCacheLiveJoinEnabled) return null;
  const liveSessionId = crypto.randomUUID();
  const { data, error } = await db.rpc("norva_claim_media_cache_live_playback", {
    p_work_fingerprint: workFingerprint,
    p_session_id: liveSessionId,
    p_user_id: userId,
    p_source_id: sourceId,
    p_device_id: deviceId,
    p_item_type: itemType,
    p_item_id: itemId,
    p_target_url_hash: targetUrlHash,
    p_stream_mime: streamMime,
    p_playback_hint: playbackHint,
    p_expires_at: expiresAt,
    p_concurrent_limit: entitlement.limit,
  });
  if (error) throwDb(error, "Unable to claim shared live media playback");
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new HttpError(503, "Shared live media claim is ambiguous", {
      code: "MEDIA_CACHE_LIVE_JOIN_INVALID",
    });
  }
  const claim = recordOrEmpty(rows[0]);
  if (claim.capacity_exceeded === true) {
    throwEntitlementRequired("concurrent_streams", entitlement.decision, {
      limit: entitlement.limit,
      current: boundedInt(claim.current_streams, entitlement.limit, 0, 64),
    });
  }
  const claimedSessionId = stringOr(claim.new_session_id, "");
  const attachmentId = stringOr(claim.attachment_id, "");
  const producerGatewaySessionId = stringOr(claim.producer_external_session_id, "");
  if (
    claimedSessionId !== liveSessionId ||
    !PLAYBACK_SESSION_UUID_PATTERN.test(attachmentId) ||
    !PLAYBACK_SESSION_UUID_PATTERN.test(producerGatewaySessionId)
  ) {
    throw new HttpError(503, "Shared live media claim is invalid", {
      code: "MEDIA_CACHE_LIVE_JOIN_INVALID",
    });
  }
  const route = mediaGatewayRouteForStoredSession(runtimeConfig, {
    gateway_id: stringOrNull(claim.producer_gateway_id),
  });
  if (!route) {
    await rollbackMediaCacheLivePlayback(db, liveSessionId, userId, attachmentId)
      .catch(() => null);
    throw new HttpError(503, "Shared live media gateway route is unavailable", {
      code: "MEDIA_GATEWAY_STORED_ROUTE_UNAVAILABLE",
    });
  }

  const { data: claimedSession, error: sessionError } = await db
    .from("cloud_playback_sessions")
    .select("*,cloud_gateway_sessions(*)")
    .eq("id", liveSessionId)
    .eq("user_id", userId)
    .single();
  if (sessionError || !claimedSession) {
    await rollbackMediaCacheLivePlayback(db, liveSessionId, userId, attachmentId)
      .catch(() => null);
    if (sessionError) throwDb(sessionError, "Unable to load shared live media session");
    throw new HttpError(503, "Shared live media session is unavailable");
  }

  let gatewayBody: JsonRecord = {};
  let attachmentCreationAttempted = false;
  let followerRegistrationTransferred = false;
  let activationOutcomeUncertain = false;
  try {
    if (req.signal.aborted) throw playbackRequestAbortError();
    attachmentCreationAttempted = true;
    const response = await fetch(
      `${route.url}/sessions/${encodeURIComponent(producerGatewaySessionId)}/viewers`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${route.token}`,
        },
        body: JSON.stringify({
          attachmentId,
          playbackSessionId: liveSessionId,
          expiresAt: stringOr(claim.producer_expires_at, expiresAt),
        }),
        signal: req.signal,
      },
    );
    gatewayBody = await response.json().catch(() => ({} as JsonRecord));
    if ([404, 410, 425, 429].includes(response.status)) {
      await revokeMediaCacheLiveGatewayAttachment({
        route,
        gatewaySessionId: producerGatewaySessionId,
        attachmentId,
        playbackSessionId: liveSessionId,
      }).catch(() => null);
      await rollbackMediaCacheLivePlayback(db, liveSessionId, userId, attachmentId);
      return null;
    }
    if (!response.ok) {
      throw new HttpError(response.status, "Media gateway refused shared live attachment", gatewayBody);
    }
    const liveJoin = recordOrEmpty(gatewayBody.liveJoin ?? gatewayBody.live_join);
    const hlsUrl = stringOr(gatewayBody.hlsUrl ?? gatewayBody.hls_url, "");
    const audioStreamIndex = boundedNullableInt(
      gatewayBody.audioStreamIndex ?? gatewayBody.audio_stream_index,
      0,
      1024,
    );
    const subtitleStreamIndex = boundedNullableInt(
      gatewayBody.subtitleStreamIndex ?? gatewayBody.subtitle_stream_index,
      0,
      1024,
    );
    const codecProfile = firstUsefulCodecProfile(gatewayBody.codecProfile, gatewayBody.codec_profile);
    const audioRenditions = normalizeGatewayAudioRenditions(
      gatewayBody.audioRenditions ?? gatewayBody.audio_renditions,
      audioStreamIndex,
    );
    const multiAudioHls = normalizeGatewayMultiAudioHls(
      gatewayBody.multiAudioHls ?? gatewayBody.multi_audio_hls,
      audioRenditions,
      audioStreamIndex,
      codecProfile,
    );
    const subtitleRenditions = normalizeGatewaySubtitleRenditions(
      gatewayBody.subtitleRenditions ?? gatewayBody.subtitle_renditions,
      codecProfile,
    );
    const exactSubtitleHls = normalizeGatewayExactSubtitleHls(
      gatewayBody.exactSubtitleHls ?? gatewayBody.exact_subtitle_hls,
      subtitleRenditions,
      codecProfile,
    );
    if (
      !hlsUrl ||
      stringOr(gatewayBody.id, "") !== producerGatewaySessionId ||
      liveJoin.joinable !== true ||
      liveJoin.topologyValidated !== true ||
      liveJoin.continuityValidated !== true ||
      stringOr(liveJoin.attachmentId ?? liveJoin.attachment_id, "") !== attachmentId ||
      Number(liveJoin.audioRenditionCount) !== (multiAudioHls ? (audioRenditions?.length ?? 0) : 0) ||
      Number(liveJoin.subtitleRenditionCount) !== (exactSubtitleHls ? (subtitleRenditions?.length ?? 0) : 0)
    ) {
      throw new HttpError(502, "Shared live media topology is invalid", {
        code: "MEDIA_CACHE_LIVE_JOIN_TOPOLOGY_INVALID",
      });
    }

    let activated: unknown = false;
    let activationError: unknown = null;
    // The SQL activation is idempotent. Retry once so a committed transaction
    // whose PostgREST response was lost is acknowledged without consuming a
    // second singleflight follower registration.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const activation = await db.rpc(
        "norva_activate_media_cache_live_playback",
        {
          p_session_id: liveSessionId,
          p_user_id: userId,
          p_attachment_id: attachmentId,
          p_hls_url: hlsUrl,
        },
      );
      activated = activation.data;
      activationError = activation.error;
      if (!activationError || req.signal.aborted) break;
    }
    if (activationError) {
      const { data: activationRows, error: activationInspectionError } = await db
        .from("cloud_gateway_sessions")
        .select("status,hls_url,media_cache_live_attachment_state")
        .eq("playback_session_id", liveSessionId)
        .eq("user_id", userId)
        .eq("media_cache_live_attachment_id", attachmentId)
        .limit(1);
      if (activationInspectionError) {
        activationOutcomeUncertain = true;
      } else {
        const activationRow = recordOrEmpty(
          Array.isArray(activationRows) ? activationRows[0] : activationRows,
        );
        if (stringOr(activationRow.media_cache_live_attachment_state, "") === "active") {
          followerRegistrationTransferred = true;
          activated = stringOr(activationRow.status, "") === "ready" &&
            stringOr(activationRow.hls_url, "") === hlsUrl;
        }
      }
      if (activated !== true) {
        throwDb(activationError, "Unable to activate shared live media playback");
      }
    }
    if (activated !== true) {
      await revokeMediaCacheLiveGatewayAttachment({
        route,
        gatewaySessionId: producerGatewaySessionId,
        attachmentId,
        playbackSessionId: liveSessionId,
      }).catch(() => null);
      await rollbackMediaCacheLivePlayback(db, liveSessionId, userId, attachmentId)
        .catch(() => null);
      return null;
    }
    followerRegistrationTransferred = true;

    const supersededSessionIds = Array.isArray(claim.superseded_session_ids)
      ? claim.superseded_session_ids
        .map((value) => stringOrNull(value))
        .filter((value): value is string => Boolean(value))
      : [];
    await releaseSupersededPlaybackSessions(supersededSessionIds, db).catch(() => {
      console.warn("[norva-playback] superseded shared live attachment cleanup failed");
    });
    const gatewayRows = Array.isArray(claimedSession.cloud_gateway_sessions)
      ? claimedSession.cloud_gateway_sessions
      : [];
    const gatewayRow = recordOrEmpty(gatewayRows[0]);
    const gatewaySessionResponse = {
      ...sanitizeGatewaySession({ ...gatewayRow, status: "ready", hls_url: hlsUrl }),
      audioStreamIndex,
      audio_stream_index: audioStreamIndex,
      subtitleStreamIndex,
      subtitle_stream_index: subtitleStreamIndex,
      audioRenditions: multiAudioHls ? audioRenditions : null,
      audio_renditions: multiAudioHls ? audioRenditions : null,
      multiAudioHls,
      multi_audio_hls: multiAudioHls,
      subtitleRenditions: exactSubtitleHls ? subtitleRenditions : null,
      subtitle_renditions: exactSubtitleHls ? subtitleRenditions : null,
      exactSubtitleHls,
      exact_subtitle_hls: exactSubtitleHls,
      liveJoin,
      live_join: liveJoin,
    };
    runBackground(db.rpc("norva_record_media_cache_metric", {
      p_metric: "viewer_joined", p_value: 1, p_samples: 1,
      p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
      p_route_protocol: "none", p_outcome: "hit", p_score: null, p_confidence: null,
    }).then(() => undefined));
    return {
      session: publicPlaybackSession({ ...claimedSession, status: "ready" }),
      playback: {
        mode: "transcode",
        status: "ready",
        url: hlsUrl,
        transport: "shared-live-hls",
        gatewaySession: gatewaySessionResponse,
        gatewayRequired: false,
        startupMs: 0,
        audioMode: stringOrNull(gatewayBody.audioMode ?? gatewayBody.audio_mode),
        audioStreamIndex,
        audio_stream_index: audioStreamIndex,
        subtitleStreamIndex,
        subtitle_stream_index: subtitleStreamIndex,
        audioRenditions: multiAudioHls ? audioRenditions : null,
        audio_renditions: multiAudioHls ? audioRenditions : null,
        multiAudioHls,
        multi_audio_hls: multiAudioHls,
        subtitleRenditions: exactSubtitleHls ? subtitleRenditions : null,
        subtitle_renditions: exactSubtitleHls ? subtitleRenditions : null,
        exactSubtitleHls,
        exact_subtitle_hls: exactSubtitleHls,
        startupPolicy: normalizeGatewayStartupPolicy(
          gatewayBody.startupPolicy ?? gatewayBody.startup_policy,
        ),
        codecProfile: hasUsefulCodecProfile(codecProfile) ? codecProfile : null,
        liveJoin,
        live_join: liveJoin,
        transportExpiresAt: stringOr(claim.producer_expires_at, expiresAt),
        sessionExpiresAt: expiresAt,
      },
    };
  } catch (joinError) {
    if (attachmentCreationAttempted) {
      await revokeMediaCacheLiveGatewayAttachment({
        route,
        gatewaySessionId: producerGatewaySessionId,
        attachmentId,
        playbackSessionId: liveSessionId,
      }).catch(() => null);
    }
    if (followerRegistrationTransferred || activationOutcomeUncertain) {
      await Promise.resolve(db.rpc("norva_finalize_media_cache_live_attachment_release", {
        p_playback_session_id: liveSessionId,
        p_user_id: userId,
        p_attachment_id: attachmentId,
      })).catch(() => null);
    } else {
      await rollbackMediaCacheLivePlayback(db, liveSessionId, userId, attachmentId)
        .catch(() => null);
    }
    const failure = joinError instanceof Error
      ? joinError
      : new Error("Shared live media playback failed");
    (failure as Error & { mediaCacheFollowerRegistrationTransferred?: boolean })
      .mediaCacheFollowerRegistrationTransferred =
        followerRegistrationTransferred || activationOutcomeUncertain;
    throw failure;
  }
}

async function abandonMediaCacheProducerClaim(
  db: SupabaseClient,
  producer: MediaCacheProducerContext,
) {
  const { data, error } = await db.rpc("norva_abandon_media_cache_producer", {
    p_work_fingerprint: producer.workFingerprint,
    p_lease_token: producer.leaseToken,
    p_owner_instance_fingerprint: producer.ownerInstanceFingerprint,
  });
  if (error) throw error;
  return data === true;
}

function mediaCacheDemandCostScore(options: {
  playbackHint: JsonRecord;
  authoritativeVodTier: string | null;
  forceVideoTranscode: boolean;
}): number {
  const { playbackHint, authoritativeVodTier, forceVideoTranscode } = options;
  let score = 45;
  const gatewayMode = stringOr(
    playbackHint.gatewayMode ?? playbackHint.gateway_mode,
    "",
  ).toLowerCase();
  if (authoritativeVodTier === "video_transcode" || forceVideoTranscode || gatewayMode === "transcode") {
    score = 95;
  } else if (authoritativeVodTier === "audio_transcode" || gatewayMode === "audio-transcode") {
    score = 80;
  } else if (gatewayMode === "remux") {
    score = 60;
  }
  const durationSeconds = boundedNullableInt(
    playbackHint.durationSeconds ?? playbackHint.duration_seconds ?? playbackHint.duration,
    1,
    24 * 60 * 60,
  );
  if (durationSeconds && durationSeconds >= 2 * 60 * 60) score += 10;
  const audioTrackCount = boundedNullableInt(
    playbackHint.audioTrackCount ?? playbackHint.audio_track_count,
    0,
    256,
  );
  const subtitleTrackCount = boundedNullableInt(
    playbackHint.subtitleTrackCount ?? playbackHint.subtitle_track_count,
    0,
    256,
  );
  if ((audioTrackCount ?? 0) > 1) score += 5;
  if ((subtitleTrackCount ?? 0) > 0) score += 5;
  return Math.max(0, Math.min(100, score));
}

function normalizeMediaCacheAdmission(value: unknown): MediaCacheProducerContext["admission"] | null {
  const row = recordOrEmpty(value);
  const mode = stringOr(row.policy_mode ?? row.policyMode, "");
  const reason = stringOr(row.reason, "");
  const score = boundedNullableInt(row.admission_score ?? row.admissionScore, 0, 100);
  const confidence = boundedNullableInt(row.confidence, 0, 100);
  const ttlSeconds = boundedNullableInt(row.ttl_seconds ?? row.ttlSeconds, 300, 7_776_000);
  if (!["off", "shadow", "enforced"].includes(mode)
    || !["repeated", "popular", "costly", "not-admitted"].includes(reason)
    || score === null || confidence === null || ttlSeconds === null
    || (row.admitted === true && mode !== "enforced")) return null;
  return {
    mode: mode as "off" | "shadow" | "enforced",
    admitted: row.admitted === true,
    score,
    confidence,
    reason: reason as "repeated" | "popular" | "costly" | "not-admitted",
    ttlSeconds,
  };
}

async function coordinateColdMediaCachePlayback(options: {
  req: Request;
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  lifecycle: MediaCacheSingleflightLifecycle;
  entitlement: Awaited<ReturnType<typeof requirePlaybackEntitlement>>;
  targetUrl: string;
  providerAccountScope: string;
  container: string;
  sessionId: string;
  userId: string;
  sourceId: string;
  deviceId: string | null;
  itemType: string;
  itemId: string;
  targetUrlHash: string;
  streamMime: string | null;
  playbackHint: JsonRecord;
  expiresAt: string;
  costScore: number;
}) {
  const {
    req, db, runtimeConfig, lifecycle, entitlement, targetUrl,
    providerAccountScope, container, sessionId, userId, sourceId, deviceId,
    itemType, itemId, targetUrlHash, streamMime, playbackHint, expiresAt, costScore,
  } = options;
  if (!runtimeConfig.mediaCacheSingleflightEnabled) return null;
  if (!mediaCachePlaybackWorkerUrl(runtimeConfig)
    || !mediaCacheCoordinationKeyIsValid(runtimeConfig.mediaCacheCoordinationHmacKey)) {
    throw new HttpError(503, "Shared media cache singleflight is misconfigured", {
      code: "MEDIA_CACHE_SINGLEFLIGHT_CONFIG_INVALID",
    });
  }
  const fingerprints = await deriveMediaCacheCoordinationFingerprints({
    key: runtimeConfig.mediaCacheCoordinationHmacKey,
    targetUrl,
    providerAccountScope: providerAccountScope || null,
    itemType,
    itemId,
    container,
    ownerInstanceId: MEDIA_CACHE_SINGLEFLIGHT_OWNER_INSTANCE_ID,
  });
  let admission: MediaCacheProducerContext["admission"] = {
    mode: "off",
    admitted: false,
    score: 0,
    confidence: 0,
    reason: "not-admitted",
    ttlSeconds: 604_800,
  };
  const { data: admissionData, error: admissionError } = await db.rpc(
    "norva_record_media_cache_demand",
    {
      p_work_fingerprint: fingerprints.workFingerprint,
      p_account_fingerprint: fingerprints.accountFingerprint,
      p_cost_score: Math.max(0, Math.min(100, Math.round(costScore))),
    },
  );
  if (!admissionError) {
    const admissionRows = Array.isArray(admissionData)
      ? admissionData
      : (admissionData ? [admissionData] : []);
    admission = admissionRows.length === 1
      ? (normalizeMediaCacheAdmission(admissionRows[0]) ?? admission)
      : admission;
  } else {
    // Fail closed for shared-cache writes, while leaving the real viewer's
    // provider-backed playback available during a rolling schema deployment.
    console.warn("[norva-playback] media cache admission unavailable; publication disabled");
  }
  // Shadow/off governance records demand and recommendations only. It must be
  // observational: claiming a producer here would transfer cache-only
  // constraints to the Gateway even though this playback can never publish an
  // object. In particular, imperfect provider suffixes must still fall through
  // to the ordinary self-healing MKV path without a cache context.
  if (admission.admitted !== true) return null;
  const rpcSingleRow = (data: unknown, label: string) => {
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    if (rows.length !== 1) throw new HttpError(503, label, { code: "MEDIA_CACHE_SINGLEFLIGHT_INVALID" });
    return rows[0];
  };
  const claim = async () => {
    const { data, error } = await db.rpc("norva_claim_media_cache_producer", {
      p_work_fingerprint: fingerprints.workFingerprint,
      p_account_fingerprint: fingerprints.accountFingerprint,
      p_owner_instance_fingerprint: fingerprints.ownerInstanceFingerprint,
      p_ttl_seconds: MEDIA_CACHE_SINGLEFLIGHT_LEASE_TTL_SECONDS,
    });
    if (error) throwDb(error, "Unable to coordinate shared media cache producer");
    return rpcSingleRow(data, "Shared media cache producer claim is invalid");
  };
  const resolve = async () => {
    const { data, error } = await db.rpc("norva_resolve_media_cache_work", {
      p_work_fingerprint: fingerprints.workFingerprint,
    });
    if (error) throwDb(error, "Unable to resolve shared media cache work");
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    if (rows.length > 1) {
      throw new HttpError(503, "Shared media cache work state is ambiguous", {
        code: "MEDIA_CACHE_SINGLEFLIGHT_INVALID",
      });
    }
    return rows[0] ?? null;
  };
  const leave = async () => {
    const { data, error } = await db.rpc("norva_leave_media_cache_follower", {
      p_work_fingerprint: fingerprints.workFingerprint,
    });
    if (error) throw error;
    return data === true;
  };

  const outcome = await awaitMediaCacheSingleflight({
    claim,
    resolve,
    leave,
    tryJoin: runtimeConfig.mediaCacheLiveJoinEnabled
      ? async () => {
        try {
          const joined = await tryCreateLiveMediaCachePlayback({
            req,
            db,
            runtimeConfig,
            entitlement,
            workFingerprint: fingerprints.workFingerprint,
            userId,
            sourceId,
            deviceId,
            itemType,
            itemId,
            targetUrlHash,
            streamMime,
            playbackHint,
            expiresAt,
          });
          return joined ? { joined: true, value: joined } : null;
        } catch (error) {
          return {
            joined: false,
            registrationTransferred: Boolean(
              (error as { mediaCacheFollowerRegistrationTransferred?: boolean })
                ?.mediaCacheFollowerRegistrationTransferred,
            ),
            error,
          };
        }
      }
      : undefined,
    timeoutMs: runtimeConfig.mediaCacheFollowerWaitMs,
    pollMs: 250,
    signal: req.signal,
  });
  if (outcome.role === "leader") {
    const leaseToken = stringOrNull(outcome.leaseToken);
    if (!leaseToken) {
      throw new HttpError(503, "Shared media cache producer claim is invalid", {
        code: "MEDIA_CACHE_SINGLEFLIGHT_INVALID",
      });
    }
    lifecycle.producer = {
      protocol: MEDIA_CACHE_SINGLEFLIGHT_PROTOCOL,
      workFingerprint: fingerprints.workFingerprint,
      accountFingerprint: fingerprints.accountFingerprint,
      leaseToken,
      ownerInstanceFingerprint: fingerprints.ownerInstanceFingerprint,
      admission,
    };
    runBackground(db.rpc("norva_record_media_cache_metric", {
      p_metric: "producer_started", p_value: 1, p_samples: 1,
      p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
      p_route_protocol: "none", p_outcome: "none",
      p_score: admission.score, p_confidence: admission.confidence,
    }).then(() => undefined));
    return null;
  }
  if (outcome.role === "ready") {
    const readyObjectKey = stringOrNull(outcome.objectKey);
    if (!readyObjectKey || !MEDIA_CACHE_OBJECT_KEY_PATTERN.test(readyObjectKey)) {
      throw new HttpError(503, "Shared media cache work result is invalid", {
        code: "MEDIA_CACHE_SINGLEFLIGHT_INVALID",
      });
    }
    return await claimReadyMediaCacheWorkPlayback({
      req, db, runtimeConfig, entitlement,
      workFingerprint: fingerprints.workFingerprint,
      expectedObjectKey: readyObjectKey,
      sessionId, userId, sourceId, deviceId, itemType, itemId, targetUrlHash,
      streamMime, playbackHint, expiresAt,
    });
  }
  const joinValue = (outcome as { joinValue?: Awaited<ReturnType<typeof tryCreateLiveMediaCachePlayback>> })
    .joinValue;
  if (outcome.role === "joined" && joinValue) {
    return joinValue;
  }
  throw new HttpError(425, "Another viewer is preparing this film", {
    code: "MEDIA_CACHE_PRODUCER_ACTIVE",
    retryAfterSeconds: 2,
  });
}

async function mediaCacheAccountFingerprintForPlayback(options: {
  runtimeConfig: RuntimeConfig;
  targetUrl: string;
  providerAccountScope: string;
  itemType: string;
  itemId: string;
  container: string;
}) {
  const {
    runtimeConfig, targetUrl, providerAccountScope, itemType, itemId, container,
  } = options;
  if (!runtimeConfig.mediaCacheSingleflightEnabled) return null;
  if (!mediaCacheCoordinationKeyIsValid(runtimeConfig.mediaCacheCoordinationHmacKey)) {
    throw new HttpError(503, "Shared media cache coordination is misconfigured", {
      code: "MEDIA_CACHE_SINGLEFLIGHT_CONFIG_INVALID",
    });
  }
  const fingerprints = await deriveMediaCacheCoordinationFingerprints({
    key: runtimeConfig.mediaCacheCoordinationHmacKey,
    targetUrl,
    providerAccountScope: providerAccountScope || null,
    itemType,
    itemId,
    container,
    ownerInstanceId: MEDIA_CACHE_SINGLEFLIGHT_OWNER_INSTANCE_ID,
  });
  return fingerprints.accountFingerprint;
}

async function preemptBackgroundMediaCacheForViewer(options: {
  db: SupabaseClient;
  accountFingerprint: string | null;
  exceptWorkFingerprint?: string | null;
  signal?: AbortSignal | null;
}) {
  const {
    db, accountFingerprint, exceptWorkFingerprint = null, signal = null,
  } = options;
  if (!accountFingerprint) return 0;
  const rpcArgs = {
    p_account_fingerprint: accountFingerprint,
    p_except_work_fingerprint: exceptWorkFingerprint,
  };
  const { error: preemptError } = await db.rpc(
    "norva_preempt_background_media_cache_producers",
    rpcArgs,
  );
  if (preemptError) throwDb(preemptError, "Unable to preempt background media cache work");

  const deadline = Date.now() + MEDIA_CACHE_BACKGROUND_PREEMPT_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw playbackRequestAbortError();
    const { data, error } = await db.rpc(
      "norva_count_background_media_cache_producers",
      rpcArgs,
    );
    if (error) throwDb(error, "Unable to verify background media cache drain");
    const active = boundedInt(data, 0, 0, 1_000_000);
    if (active === 0) return 0;
    if (Date.now() >= deadline) {
      throw new HttpError(425, "A previous cache fill is yielding to playback", {
        code: "MEDIA_CACHE_BACKGROUND_DRAINING",
        retryAfterSeconds: 1,
      });
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

async function createPlaybackSessionCore(
  req: Request,
  userId: string,
  db: SupabaseClient,
  defaultDeviceId: string | null = null,
  mediaCacheLifecycle: MediaCacheSingleflightLifecycle,
) {
  const body = await readJson(req);
  const sourceId = stringOrNull(body.sourceId ?? body.source_id);
  const deviceId = stringOrNull(body.deviceId ?? body.device_id) ?? defaultDeviceId;
  const itemType = stringOr(body.itemType ?? body.item_type, "");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  if (!sourceId || !itemType || !itemId) {
    throw new HttpError(400, "sourceId, itemType and itemId are required");
  }
  // The source ownership check must happen before any provider target is
  // resolved or hashed. Client-provided URLs are deliberately ignored.
  await assertOwnedSource(sourceId, userId, db);
  await assertSourceCatalogVisible(sourceId, userId, db);
  const playbackGeneration = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
  if (deviceId) await assertOwnedDevice(deviceId, userId, db);

  const requestedMode = stringOr(body.mode, "auto");
  const mediaCacheReadPolicy = stringOr(
    body.mediaCacheReadPolicy ?? body.media_cache_read_policy,
    "default",
  );
  if (mediaCacheReadPolicy !== "default" && mediaCacheReadPolicy !== "bypass-once") {
    throw new HttpError(400, "Invalid media cache read policy");
  }
  const mediaCacheReadBypassOnce = mediaCacheReadPolicy === "bypass-once";
  let requestedPlaybackHint = recordOrEmpty(body.playbackHint ?? body.playback_hint);
  const parentSeriesId = itemType === "series"
    ? stringOr(
      requestedPlaybackHint.audioSeriesId ??
        requestedPlaybackHint.audio_series_id ??
        requestedPlaybackHint.seriesId ??
        requestedPlaybackHint.series_id,
      "",
    )
    : "";
  const episodeCoordinates = itemType === "series"
    ? await resolveCatalogSeriesEpisodeCoordinates(
      db,
      userId,
      sourceId,
      parentSeriesId,
      itemId,
    )
    : null;
  if (episodeCoordinates) {
    requestedPlaybackHint = {
      ...requestedPlaybackHint,
      container: stringOr(episodeCoordinates.container_extension, "mp4"),
      audioSeriesId: stringOr(episodeCoordinates.parent_series_id, parentSeriesId),
    };
  }
  const userAgent = stringOrNull(body.userAgent ?? body.user_agent);
  const clientMetadata = clientTelemetryMetadataFromBody(body);

  // Coordinates owned by the user are authoritative. Never let a caller attach
  // arbitrary bytes to an otherwise valid source/item tuple: exact-file caches
  // and language fanout are keyed from those coordinates.
  const resolved = episodeCoordinates
    ? await resolveExactEpisodePlaybackTarget(
      sourceId,
      userId,
      episodeCoordinates,
      requestedPlaybackHint,
      db,
    )
    : await resolvePlaybackTarget(
      sourceId,
      itemType,
      itemId,
      userId,
      db,
      requestedPlaybackHint,
    );
  await assertActiveCatalogGenerationCurrent(db, sourceId, userId, playbackGeneration);
  const targetUrl = resolved.targetUrl;
  const resolvedContainerObservation = "containerObservation" in resolved
    ? recordOrEmpty(resolved.containerObservation)
    : {};
  requestedPlaybackHint = bindServerMkvFastStartProof(
    mergePlaybackHints(resolved.playbackHint, requestedPlaybackHint),
    // Exact-episode resolution currently carries the caller hint forward and
    // exposes no persisted episode profile. Do not mistake that echo for
    // server authority; episode fast-start remains fail-closed until its proof
    // is loaded from an owned server-side row.
    itemType === "movie" ? resolved.playbackHint : {},
    itemType === "movie",
  );
  assertHttpUrl(targetUrl);

  const clientMode = choosePlaybackMode(requestedMode, body);
  const authoritativeVodTier = itemType === "movie"
    ? authoritativeVodGatewayTier(resolved.playbackHint, resolvedContainerObservation)
    : null;
  const authoritativeVodContainer = resolvedVodContainerAuthority(
    resolved.playbackHint,
    resolvedContainerObservation,
    itemType === "movie",
  );
  const browserNativeMp4 = (itemType === "movie" || itemType === "series") &&
    authoritativeVodContainer === "mp4";
  // Old cached web bundles may still ask for an automatic Gateway lane when a
  // reliable codec probe reports HEVC/AC-3. The real MP4 container remains
  // browser-native: demote only that automatic request to the byte-preserving
  // Relay. An explicit conversion action (`gatewayAutoMode !== true`) remains
  // available after a genuine browser media rejection.
  const serverDemotedAutomaticMp4 = browserNativeMp4 &&
    clientMode === "transcode" &&
    body.gatewayAutoMode === true;
  const serverPromotedRelay = clientMode === "relay" &&
    !browserNativeMp4 &&
    (authoritativeVodTier === "video_transcode" || authoritativeVodTier === "audio_transcode");
  const mode = serverDemotedAutomaticMp4
    ? "relay"
    : serverPromotedRelay
    ? "transcode"
    : clientMode;
  if (serverPromotedRelay) {
    // The browser may still be holding a catalogue extension (for example MP4)
    // while a server-owned probe has already identified an AVI/MPEG-4/AC-3
    // file. Never ask it to fail once through the raw relay first. Preserve the
    // cheaper video-copy lane when only audio is unsafe.
    requestedPlaybackHint = mergePlaybackHints(requestedPlaybackHint, {
      gatewayMode: authoritativeVodTier === "video_transcode" ? "transcode" : "remux",
    });
  }
  const gatewayVideoTranscodeExplicit = mode === "transcode" && (
    (serverPromotedRelay && authoritativeVodTier === "video_transcode") ||
    (!serverPromotedRelay && body.gatewayAutoMode !== true)
  );
  const ttlSeconds = boundedInt(body.ttlSeconds ?? body.ttl_seconds, 900, 60, 7200);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  // Entitlement/concurrency stays short-lived, but a VOD gateway transport must
  // survive the whole movie/episode. Explicit teardown and the cross-device
  // coordinator still stop it immediately when playback ends or is replaced.
  const transportExpiresAt = playbackTransportExpiresAt({
    itemType,
    playbackHint: requestedPlaybackHint,
    sessionTtlSeconds: ttlSeconds,
  });
  const gatewayTransportExpiresAt = mode === "transcode"
    ? transportExpiresAt
    : expiresAt;
  const targetUrlHash = await sha256Hex(targetUrl);
  const resolvedItemCas = "itemCas" in resolved ? recordOrEmpty(resolved.itemCas) : {};
  const itemCasId = stringOrNull(resolvedItemCas.id);
  const itemCasUpdatedAt = stringOrNull(resolvedItemCas.updatedAt ?? resolvedItemCas.updated_at);
  requestedPlaybackHint = compactRecord({
    ...stripMkvH264FastStartInternalHints(requestedPlaybackHint),
    ...(itemType === "movie" && itemCasId && itemCasUpdatedAt
      ? {
        __norvaMkvH264FastStartItemCasV2: {
          id: itemCasId,
          updatedAt: itemCasUpdatedAt,
          targetUrlHash,
        },
      }
      : {}),
  });
  const entitlement = await requirePlaybackEntitlement(userId, db);
  let sessionId = crypto.randomUUID();
  let mediaCacheRuntimeConfig: RuntimeConfig | null = null;
  // Only exact Matroska VOD enters the shared HLS lane. Browser-native MP4
  // remains byte-preserving Relay/direct even if a stale historical binding
  // exists, preserving the zero-Gateway MP4 contract.
  if (authoritativeVodContainer === "mkv") {
    mediaCacheRuntimeConfig = await getRuntimeConfig(db);
    if (mediaCacheReadBypassOnce) {
      runBackground(db.rpc("norva_record_media_cache_metric", {
        p_metric: "cache_fallback", p_value: 1, p_samples: 1,
        p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
        p_route_protocol: "none", p_outcome: "fallback", p_score: null, p_confidence: null,
      }).then(() => undefined));
    } else {
      const hotPlayback = await tryCreateHotMediaCachePlayback({
        req,
        db,
        runtimeConfig: mediaCacheRuntimeConfig,
        entitlement,
        sessionId,
        userId,
        sourceId,
        deviceId,
        itemType,
        itemId,
        targetUrlHash,
        streamMime: stringOrNull(body.streamMime ?? body.stream_mime),
        playbackHint: requestedPlaybackHint,
        expiresAt: transportExpiresAt,
      });
      if (hotPlayback) return hotPlayback;
      // A failed private-cache preflight is rolled back before provider fallback.
      // Never reuse the expired cache-claim UUID for the fresh provider session.
      sessionId = crypto.randomUUID();
    }
  }
  const providerAccountScope = "providerAccountScope" in resolved
    ? stringOr(resolved.providerAccountScope, "")
    : "";
  const providerAccountHash = providerAccountScope
    ? await sha256Hex(providerAccountScope)
    : await providerAccountHashFromUrl(targetUrl);
  if (authoritativeVodContainer === "mkv" && mode === "transcode"
    && mediaCacheRuntimeConfig && !mediaCacheReadBypassOnce) {
    const coordinatedPlayback = await coordinateColdMediaCachePlayback({
      req,
      db,
      runtimeConfig: mediaCacheRuntimeConfig,
      lifecycle: mediaCacheLifecycle,
      entitlement,
      targetUrl,
      providerAccountScope,
      container: authoritativeVodContainer,
      sessionId,
      userId,
      sourceId,
      deviceId,
      itemType,
      itemId,
      targetUrlHash,
      streamMime: stringOrNull(body.streamMime ?? body.stream_mime),
      playbackHint: requestedPlaybackHint,
      expiresAt: transportExpiresAt,
      costScore: mediaCacheDemandCostScore({
        playbackHint: requestedPlaybackHint,
        authoritativeVodTier,
        forceVideoTranscode: gatewayVideoTranscodeExplicit,
      }),
    });
    if (coordinatedPlayback) return coordinatedPlayback;
    sessionId = crypto.randomUUID();
  }
  // A real viewer always wins over detached cache completion, including when
  // the previous producer lives on another Gateway instance. Foreground
  // producers are excluded in SQL and therefore can never be interrupted by
  // this optimization.
  mediaCacheRuntimeConfig = mediaCacheRuntimeConfig ?? await getRuntimeConfig(db);
  const mediaCacheAccountFingerprint = mediaCacheLifecycle.producer?.accountFingerprint ??
    await mediaCacheAccountFingerprintForPlayback({
      runtimeConfig: mediaCacheRuntimeConfig,
      targetUrl,
      providerAccountScope,
      itemType,
      itemId,
      container: stringOr(authoritativeVodContainer ?? requestedPlaybackHint.container, "unknown"),
    });
  await preemptBackgroundMediaCacheForViewer({
    db,
    accountFingerprint: mediaCacheAccountFingerprint,
    exceptWorkFingerprint: mediaCacheLifecycle.producer?.workFingerprint ?? null,
    signal: req.signal,
  });
  await assertProviderCircuitClosed(providerAccountHash, db);

  await requirePlaybackCapacity(userId, db, providerAccountHash, entitlement);

  const sessionStatus = mode === "transcode" ? "pending" : "ready";
  const { data: claimRows, error: claimError } = await db.rpc(
    "claim_cloud_playback_session",
    {
      p_session_id: sessionId,
      p_user_id: userId,
      p_source_id: sourceId,
      p_device_id: deviceId,
      p_item_type: itemType,
      p_item_id: itemId,
      p_mode: mode,
      p_status: sessionStatus,
      p_target_url_hash: targetUrlHash,
      p_provider_account_hash: providerAccountHash,
      p_stream_mime: stringOrNull(body.streamMime ?? body.stream_mime),
      p_playback_hint: requestedPlaybackHint,
      p_expires_at: expiresAt,
    },
  );
  if (claimError) throwDb(claimError, "Unable to claim provider playback session");

  const claim = Array.isArray(claimRows)
    ? recordOrEmpty(claimRows[0])
    : recordOrEmpty(claimRows);
  const supersededSessionIds = Array.isArray(claim.superseded_session_ids)
    ? claim.superseded_session_ids
      .map((value) => stringOrNull(value))
      .filter((value): value is string => Boolean(value))
    : [];
  const { data: session, error: sessionError } = await db
    .from("cloud_playback_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .single();
  if (sessionError || !session) {
    if (sessionError) throwDb(sessionError, "Unable to load claimed playback session");
    throw new HttpError(500, "Unable to load claimed playback session");
  }

  // Viewer playback is authoritative. The DB claim removed the background
  // validation lease under the provider advisory lock; now close every real
  // Gateway transport for that provider affinity and require an explicit drain
  // attestation before returning/opening a new provider URL. Calling all
  // configured routes also catches an orphaned broker whose DB lease expired.
  try {
    await preemptProviderLanguageValidationTransports({
      db,
      targetUrl,
    });
  } catch (preemptionError) {
    try {
      await expirePlaybackSession(sessionId, userId, db);
    } catch (_) {
      await db
        .from("cloud_playback_sessions")
        .update({
          status: "expired",
          expires_at: new Date().toISOString(),
          superseded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", userId);
    }
    throw new HttpError(503, "Background provider transport could not be drained", {
      code: "LANGUAGE_VALIDATION_PREEMPTION_DRAIN_FAILED",
      cause: preemptionError instanceof Error ? preemptionError.message : "gateway drain failed",
    });
  }

  const playbackCreatedAt = stringOr(session.created_at, new Date().toISOString());
  // A catalogue metadata call can finish before the Gateway's 60-second reporter
  // tick yet leave a single-slot provider connection draining upstream. Read its
  // last opaque activity before upgrading the holder to `session`, then wait only
  // the remaining bounded drain. This prevents the first provider connection from
  // being opened into a known collision; it is deliberately not a retry after 458.
  const catalogRefreshDrainMs = await providerCatalogRefreshDrainRemainingMs(
    db,
    providerAccountHash,
  );

  // Account busy-lock writer: every playback session start means this provider account's
  // single connection slot is (about to be) held — direct native plays included. Best-effort.
  await touchProviderAccountByUrl(db, targetUrl, "session");

  // The atomic claim already made the previous generation terminal. Close its
  // real Gateway/raw transport before any provider drain or new coordinator lock;
  // otherwise the bounded catalogue wait would consume the coordinator's TTL.
  const releasedSuperseded = await releaseSupersededPlaybackSessions(
    supersededSessionIds,
    db,
  );
  if (mode === "transcode" && releasedSuperseded > 0) {
    await sleep(PROVIDER_SLOT_RELEASE_DELAY_MS);
  }
  // Gateway pumps can be aborted server-side immediately. A direct native
  // session is owned by the previous device, so give its short heartbeat poll
  // one bounded window to observe PLAYBACK_SUPERSEDED and release the provider
  // socket before this replacement URL is returned.
  if (mode !== "transcode" && releasedSuperseded > 0) {
    await sleep(PROVIDER_NATIVE_TAKEOVER_GRACE_MS);
  }
  if (catalogRefreshDrainMs > 0) await sleep(catalogRefreshDrainMs);

  // Prepare the cross-device coordinator only after all known provider drains.
  // Its 120-second lock then covers the actual Gateway startup/commit budget,
  // rather than expiring while Norva is intentionally not opening provider I/O.
  const edgeCoordination = mode === "transcode"
    ? await prepareEdgeSessionCoordinator({
      userId,
      sourceId,
      deviceId,
      providerAccountHash,
      itemType,
      itemId,
      targetUrlHash,
      playbackCreatedAt,
      supersededSessionIds,
      expiresAt: gatewayTransportExpiresAt,
    }, db)
    : null;
  const startupWaitMs = edgeCoordination?.waitMs ?? 0;
  if (startupWaitMs) await sleep(startupWaitMs);

  if (mode === "direct") {
    // Native playback gets exactly one transport. A hidden gateway fallback
    // would turn one provider refusal into a second concurrent connection and
    // obscure the original HTTP/network cause.
    return {
      session: publicPlaybackSession(session),
      playback: {
        mode,
        url: targetUrl,
        fallbackUrl: null,
        fallbackExpiresAt: null,
        expiresAt,
      },
    };
  }

  if (mode === "relay") {
    // In-browser engine: relay the RAW bytes through the media gateway (an IP
    // the provider accepts), not the Cloudflare relay (which the provider's WAF
    // 403s). The gateway does no transcode here — just a byte-range passthrough.
    if (body.enginePipe === true || body.engine_pipe === true) {
      // The cloud session remains short-lived so a vanished client cannot hold
      // an entitlement slot for hours. The stateless /raw token is different:
      // every Range request is authenticated again, so a 15-minute token cuts a
      // healthy long VOD at the first later range. Cover the known media
      // duration (+ bounded pause margin), or a bounded unknown-duration
      // fallback, without extending direct/relay/LID credentials.
      const rawTokenExpiresAt = engineRawTokenExpiresAt({
        itemType,
        playbackHint: requestedPlaybackHint,
        sessionTtlSeconds: ttlSeconds,
      });
      // Register the raw byte-pipe in the SAME cross-device ledger as transcode:
      // starting it evicts a lingering gateway transcode (real DELETE → frees the
      // provider slot) or another device's pipe (raw-pump abort at the gateway),
      // instead of the two lanes silently fighting a single-slot provider (458).
      // Coordinator unavailable → null → plays exactly as before (best-effort).
      const rawCoordination = await prepareEdgeSessionCoordinator({
        userId, sourceId, deviceId, providerAccountHash, itemType, itemId, targetUrlHash,
        playbackCreatedAt,
        supersededSessionIds,
        // The cloud playback session still expires after 15 minutes, but the
        // coordinator must not abort a legitimate later Range request. A new
        // playback start evicts this source-scoped record immediately.
        expiresAt: rawTokenExpiresAt,
      }, db);
      if (rawCoordination?.waitMs) await sleep(rawCoordination.waitMs);
      const pipe = await createBytePipeAccess(
        session.id,
        userId,
        targetUrl,
        rawTokenExpiresAt,
        db,
        userAgent,
        null,
        null,
        true,
      );
      await commitEdgeSessionCoordinator(rawCoordination, {
        playbackSessionId: session.id,
        gatewaySessionId: null,
        lane: "raw",
        itemType, itemId, targetUrlHash, playbackCreatedAt, supersededSessionIds,
        expiresAt: rawTokenExpiresAt,
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
      const serverHost = episodeCoordinates
        ? stringOr(episodeCoordinates.server_host, "")
        : await resolveFileTracksKey(stringOr(sourceId, ""), userId, db, targetUrl);
      // itemId is the PLAYED file (episode id for series), whereas audioSeriesId
      // only resolves the parent title row. File caches must stay episode-exact.
      const fileExternalId = itemId;
      const fileCacheItemType = itemType === "series"
        ? (episodeCoordinates ? "episode" : "")
        : itemType;
      const exactFileCacheSafe = itemType === "movie" || fileCacheItemType === "episode";

      // Cross-user reuse: another user (or the crawl) may have already probed this exact
      // provider file. Pull from the global per-file cache (no provider hit) and fill this
      // user's row, before ever falling back to a probe.
      if (exactFileCacheSafe && serverHost && fileExternalId) {
        try {
          const { data: fr } = await db.from("catalog_file_tracks")
            .select("audio_tracks, subtitle_tracks, audio_probed_at, subtitle_probed_at, audio_lang_verified_at, audio_lang_verification")
            .eq("server_host", serverHost).eq("item_type", fileCacheItemType).eq("external_id", fileExternalId)
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
      const exactEpisodeTitle = itemType === "series"
        && fileCacheItemType === "episode"
        && Boolean(episodeCoordinates)
        && String(titleRow?.id ?? "") === String(episodeCoordinates?.title_id ?? "")
        && String(titleRow?.variant_id ?? "") === String(episodeCoordinates?.variant_id ?? "");
      const exactFileScopedTitle = exactVariantProfile || exactEpisodeTitle;
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

      // Provider track discovery belongs to the enrichment fleet. It must not
      // consume the account's only connection before the viewer's first range.
      const shouldBlockPlaybackForTrackEnrichment = false;
      if (shouldBlockPlaybackForTrackEnrichment && (!haveAudio || !haveSub)) {
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
        if (probeOk && exactFileCacheSafe) {
          await shareFileTracks(db, serverHost, fileCacheItemType, fileExternalId,
            gotAudio ? probed.audioTracks : [], gotSub ? probed.subtitleTracks : [], gotAudio, gotSub);
        }
        // Phase 2 (flag-gated): a freshly probed file may still carry UNTAGGED audio tracks
        // (lang null) — no provider/demux language. Detect them via Whisper IN THE BACKGROUND
        // and re-persist, so the next play is fully named. Runs once (right after the first
        // probe), best-effort, never blocks the response. Off unless NORVA_WHISPER_DETECT=true.
        if (gotAudio && titleRow?.id && exactFileScopedTitle && serverHost && fileExternalId
          && audioTracks.length >= 2 && audioTracks.some((t) => !t.lang)) {
          const rc = await getRuntimeConfig(db);
          if (rc.whisperDetect && rc.mediaGatewayUrl && rc.mediaGatewayToken) {
            runBackground(detectUntaggedAudioLanguages({
              db, runtimeConfig: rc, userId, sourceId, targetUrl, userAgent,
              audioTracks, titleId: titleRow.id, tmdbId: stringOrNull(titleRow.provider_tmdb_id),
              serverHost, itemType: fileCacheItemType, fileExternalId, sessionId: session.id, expiresAt,
              variantId: stringOrNull(titleRow.variant_id) || undefined,
              fileScoped: exactFileScopedTitle,
            }));
          }
        }
      }
      // The grouped-title language facets are a UNION of exact provider files,
      // never a representative file's absolute stream-index map. Pair the
      // resolved parent variant with the exact played file id after track
      // validation. For series, the variant is the parent while itemId remains
      // the exact episode, so the SQL layer can keep episode evidence distinct.
      if (
        titleRow?.id
        && titleRow.variant_id
        && (itemType === "movie" || exactEpisodeTitle)
        && (haveAudio || haveSub)
      ) {
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
        session: publicPlaybackSession(session),
        playback: {
          mode: "relay",
          url: pipe.url,
          tokenExpiresAt: rawTokenExpiresAt,
          sessionExpiresAt: expiresAt,
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
    // Browser-safe relay traffic is registered in the same revocable session
    // module as gateway and raw lanes. Every /relay request proves this exact
    // generation is still active, so a cross-device claim can stop an already
    // issued browser URL instead of waiting for its token to expire.
    const relayTransportExpiresAt = transportExpiresAt;
    const relayCoordination = await prepareEdgeSessionCoordinator({
      userId, sourceId, deviceId, providerAccountHash, itemType, itemId, targetUrlHash,
      playbackCreatedAt,
      supersededSessionIds,
      expiresAt: relayTransportExpiresAt,
    }, db);
    if (!relayCoordination?.lockId) {
      const coordinationError = new HttpError(503, "Playback session coordinator is unavailable", {
        code: "PLAYBACK_COORDINATOR_UNAVAILABLE",
      });
      await recordPlaybackSessionFailure(db, {
        userId, deviceId, playbackSessionId: session.id, sourceId, itemType, itemId,
        playbackMode: mode, clientMetadata, error: coordinationError,
      });
      throw coordinationError;
    }
    if (relayCoordination.waitMs) await sleep(relayCoordination.waitMs);

    try {
      const relay = await createRelayAccess(
        session.id,
        userId,
        targetUrl,
        relayTransportExpiresAt,
        db,
        relayCoordination.coord,
        userAgent,
      );
      const relayCommit = await commitEdgeSessionCoordinator(relayCoordination, {
        playbackSessionId: session.id,
        gatewaySessionId: null,
        lane: "relay",
        itemType,
        itemId,
        targetUrlHash,
        playbackCreatedAt,
        supersededSessionIds,
        expiresAt: relayTransportExpiresAt,
      });
      if (!relayCommit?.ok) {
        throw new HttpError(503, "Playback session coordinator did not accept the relay session", {
          code: "PLAYBACK_COORDINATOR_UNAVAILABLE",
        });
      }
      if (relayCommit.waitMs) await sleep(relayCommit.waitMs);
      return {
        session: publicPlaybackSession(session),
        playback: {
          mode,
          url: relay.url,
          tokenExpiresAt: relayTransportExpiresAt,
        },
      };
    } catch (error) {
      await abortEdgeSessionCoordinator(relayCoordination);
      await recordPlaybackSessionFailure(db, {
        userId, deviceId, playbackSessionId: session.id, sourceId, itemType, itemId,
        playbackMode: mode, clientMetadata, error,
      });
      throw error;
    }
  }

  let gateway;
  try {
    gateway = await createGatewaySession(
      session.id,
      userId,
      targetUrl,
      providerAccountHash,
      gatewayTransportExpiresAt,
      db,
      mode,
      userAgent,
      requestedPlaybackHint,
      {
        sourceId,
        itemType,
        itemId,
        // Variant identity is omitted until loaded from an exact owned row;
        // caller playback hints are never authority for proof scope.
        variantId: null,
      },
      playbackGeneration,
      gatewayVideoTranscodeExplicit,
      releasedSuperseded,
      resolvedContainerObservation,
      req.signal,
      mediaCacheLifecycle.producer,
      mediaCacheReadBypassOnce,
    );
    if (mediaCacheLifecycle.producer) mediaCacheLifecycle.transferredToGateway = true;
    if (req.signal.aborted) throw playbackRequestAbortError();
    const gatewayCommit = await commitEdgeSessionCoordinator(edgeCoordination, {
      playbackSessionId: session.id,
      gatewaySessionId: stringOrNull(gateway.session?.external_session_id),
      itemType,
      itemId,
      targetUrlHash,
      playbackCreatedAt,
      supersededSessionIds,
      expiresAt: gatewayTransportExpiresAt,
    });
    // The relay coordinator is an optional deployment component. Preserve the
    // existing no-coordinator path, but once a prepare lock exists its commit
    // must be acknowledged or the freshly-created Gateway session is rolled
    // back below.
    if (edgeCoordination && !gatewayCommit?.ok) {
      throw new HttpError(503, "Playback session coordinator did not accept the gateway session", {
        code: "PLAYBACK_COORDINATOR_UNAVAILABLE",
      });
    }
    if (req.signal.aborted) throw playbackRequestAbortError();
  } catch (error) {
    const gatewayExternalSessionId = stringOrNull(gateway?.session?.external_session_id);
    if (gatewayExternalSessionId) {
      const cleanup = await gateway?.cleanupCreatedSession?.();
      if (!cleanup?.ok) {
        console.warn(
          "[norva-playback] gateway startup rollback cleanup failed",
          cleanup?.status ?? 0,
          cleanup?.reason ?? "cleanup-not-available",
        );
      }
    }
    await rollbackEdgeSessionCoordinator(edgeCoordination, {
      playbackSessionId: session.id,
      gatewaySessionId: gatewayExternalSessionId,
    });
    const gatewayDatabaseId = stringOrNull(gateway?.session?.id);
    if (gatewayDatabaseId) {
      try {
        const { error: gatewayRollbackError } = await db
          .from("cloud_gateway_sessions")
          .update({ status: "failed", expires_at: new Date().toISOString() })
          .eq("id", gatewayDatabaseId)
          .eq("user_id", userId);
        if (gatewayRollbackError) {
          console.warn("[norva-playback] unable to mark rolled-back gateway session failed");
        }
      } catch (_) {
        console.warn("[norva-playback] unable to mark rolled-back gateway session failed");
      }
    }
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
    // The Gateway session is already ready at this point. Catalog telemetry is
    // best-effort and can fan out across grouped title variants, so keeping it
    // on the response path turns a sub-second MKV seek into a multi-second
    // blank player. Persist it with EdgeRuntime.waitUntil instead; the client
    // also reports the observed first frame through the playback event lane.
    runBackground(recordPlaybackStartupObservation(db, {
      userId,
      sourceId,
      itemType,
      itemId,
      startupMs: gateway.startupMs,
    }));
  }
  const originalFastStartItemCas = mkvH264FastStartItemCasFromPlaybackSession(session);
  const gatewayProfileContainer = gatewayCodecProfileContainer(
    gateway.codecProfile,
    requestedPlaybackHint,
  );
  const deferGatewayProfilePersistenceForMkvFastStart = Boolean(
    originalFastStartItemCas &&
    (gatewayProfileContainer === "mkv" || gatewayProfileContainer.includes("matroska")),
  );
  // Preserve the item version captured before playback. The full-file proof is
  // the authoritative write for this lifecycle; an intermediate public profile
  // write would advance updated_at and make the later exact CAS always miss.
  if (sourceId && gateway.codecProfile && !deferGatewayProfilePersistenceForMkvFastStart) {
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
  const responseCodecProfile = stripMkvH264FastStartProof(mergeCodecProfileAnnotations(
    firstUsefulCodecProfile(requestedPlaybackHint.codecProfile, requestedPlaybackHint.codec_profile),
    recordOrEmpty(gateway.codecProfile),
  ));
  const gatewaySessionResponse = gateway.session && typeof gateway.session === "object"
    ? {
      ...sanitizeGatewaySession(gateway.session),
      audioStreamIndex: gateway.audioStreamIndex ?? null,
      audio_stream_index: gateway.audioStreamIndex ?? null,
      requestedAudioStreamIndex: gateway.requestedAudioStreamIndex ?? null,
      requested_audio_stream_index: gateway.requestedAudioStreamIndex ?? null,
      subtitleStreamIndex: gateway.subtitleStreamIndex ?? null,
      subtitle_stream_index: gateway.subtitleStreamIndex ?? null,
      requestedSubtitleStreamIndex: gateway.requestedSubtitleStreamIndex ?? null,
      requested_subtitle_stream_index: gateway.requestedSubtitleStreamIndex ?? null,
      requestedSeekOffset: gateway.requestedSeekOffset ?? 0,
      requested_seek_offset: gateway.requestedSeekOffset ?? 0,
      actualStartOffset: gateway.actualStartOffset ?? 0,
      actual_start_offset: gateway.actualStartOffset ?? 0,
      localSeekTarget: gateway.localSeekTarget ?? 0,
      local_seek_target: gateway.localSeekTarget ?? 0,
      sourceTimestamps: gateway.sourceTimestamps === true,
      source_timestamps: gateway.sourceTimestamps === true,
      audioRenditions: gateway.audioRenditions ?? null,
      audio_renditions: gateway.audioRenditions ?? null,
      multiAudioHls: gateway.multiAudioHls ?? null,
      multi_audio_hls: gateway.multiAudioHls ?? null,
      subtitleRenditions: gateway.subtitleRenditions ?? null,
      subtitle_renditions: gateway.subtitleRenditions ?? null,
      exactSubtitleHls: gateway.exactSubtitleHls ?? null,
      exact_subtitle_hls: gateway.exactSubtitleHls ?? null,
      startupPolicy: gateway.startupPolicy ?? null,
      startup_policy: gateway.startupPolicy ?? null,
    }
    : gateway.session;
  if (req.signal.aborted) {
    try {
      await expirePlaybackSession(session.id, userId, db);
    } catch (_) {
      await gateway.cleanupCreatedSession?.().catch(() => null);
    }
    throw playbackRequestAbortError();
  }
  return {
    session: publicPlaybackSession(session),
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
      requestedAudioStreamIndex: gateway.requestedAudioStreamIndex ?? null,
      requested_audio_stream_index: gateway.requestedAudioStreamIndex ?? null,
      subtitleStreamIndex: gateway.subtitleStreamIndex ?? null,
      subtitle_stream_index: gateway.subtitleStreamIndex ?? null,
      requestedSubtitleStreamIndex: gateway.requestedSubtitleStreamIndex ?? null,
      requested_subtitle_stream_index: gateway.requestedSubtitleStreamIndex ?? null,
      requestedSeekOffset: gateway.requestedSeekOffset ?? 0,
      requested_seek_offset: gateway.requestedSeekOffset ?? 0,
      actualStartOffset: gateway.actualStartOffset ?? 0,
      actual_start_offset: gateway.actualStartOffset ?? 0,
      localSeekTarget: gateway.localSeekTarget ?? 0,
      local_seek_target: gateway.localSeekTarget ?? 0,
      sourceTimestamps: gateway.sourceTimestamps === true,
      source_timestamps: gateway.sourceTimestamps === true,
      audioRenditions: gateway.audioRenditions ?? null,
      audio_renditions: gateway.audioRenditions ?? null,
      multiAudioHls: gateway.multiAudioHls ?? null,
      multi_audio_hls: gateway.multiAudioHls ?? null,
      subtitleRenditions: gateway.subtitleRenditions ?? null,
      subtitle_renditions: gateway.subtitleRenditions ?? null,
      exactSubtitleHls: gateway.exactSubtitleHls ?? null,
      exact_subtitle_hls: gateway.exactSubtitleHls ?? null,
      startupPolicy: gateway.startupPolicy ?? null,
      startup_policy: gateway.startupPolicy ?? null,
      codecProfile: hasUsefulCodecProfile(responseCodecProfile) ? responseCodecProfile : null,
      transportExpiresAt: gatewayTransportExpiresAt,
      sessionExpiresAt: expiresAt,
    },
  };
}

async function createPlaybackSession(
  req: Request,
  userId: string,
  db: SupabaseClient,
  defaultDeviceId: string | null = null,
) {
  const mediaCacheLifecycle: MediaCacheSingleflightLifecycle = {
    producer: null,
    transferredToGateway: false,
  };
  try {
    return await createPlaybackSessionCore(
      req,
      userId,
      db,
      defaultDeviceId,
      mediaCacheLifecycle,
    );
  } finally {
    if (mediaCacheLifecycle.producer && !mediaCacheLifecycle.transferredToGateway) {
      await abandonMediaCacheProducerClaim(db, mediaCacheLifecycle.producer).catch(() => {
        console.warn("[norva-playback] unable to abandon untransferred media cache producer lease");
      });
    }
  }
}

type StrictLanguageValidationEvidence = {
  index: number;
  language: string;
  method: typeof LANGUAGE_VALIDATION_METHOD;
  consensus: number;
  sampleCount: number;
  rejectedSpeechSampleCount: 0;
  minSampleProbability: number;
  minSampleWordCount: number;
  minSampleUniqueWordCount: number;
};

// User-triggered, exact-file strict LID. The caller supplies only owned catalogue
// coordinates plus the stream-index inventory it just rendered. Provider credentials,
// the raw token and the provider URL remain server-only. V1 deliberately accepts movies
// only; an episode needs the separate canonical episode-registry proof.
async function startPlaybackLanguageValidation(
  req: Request,
  userId: string,
  db: SupabaseClient,
) {
  const body = await readJson(req);
  const allowedFields = new Set(["sourceId", "itemType", "itemId", "expectedAudioIndices"]);
  const unexpectedFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unexpectedFields.length) {
    throw new HttpError(400, "Unexpected language-validation fields", {
      code: "LANGUAGE_VALIDATION_BODY_INVALID",
      fields: unexpectedFields.slice(0, 8),
    });
  }

  const sourceId = stringOr(body.sourceId, "");
  const itemType = stringOr(body.itemType, "");
  const itemId = stringOr(body.itemId, "");
  if (!sourceId || !itemType || !itemId) {
    throw new HttpError(400, "sourceId, itemType and itemId are required");
  }
  if (itemType !== "movie") {
    throw new HttpError(400, "Language validation currently supports movie VOD only", {
      code: "LANGUAGE_VALIDATION_MOVIE_ONLY",
    });
  }
  const expectedAudioIndices = exactLanguageValidationIndices(body.expectedAudioIndices);

  await assertOwnedSource(sourceId, userId, db);
  await requireLanguageValidationEntitlement(userId, db);

  const exactProfile = await loadExactLanguageValidationProfile(
    db,
    userId,
    sourceId,
    itemId,
  );
  const exactAudioIndices = exactProfile.audioTracks
    .map((track) => Number(track.index))
    .sort((left, right) => left - right);
  if (!sameIntegerSet(expectedAudioIndices, exactAudioIndices)) {
    throw new HttpError(409, "Audio stream inventory changed", {
      code: "AUDIO_INDEX_MAP_MISMATCH",
      expectedAudioIndices,
      exactAudioIndices,
    });
  }

  // A verified provider identity is both the exact-file cache namespace and the
  // distributed provider lease. A source-scoped fallback would let two tenants
  // sharing one panel validate concurrently, so this security-sensitive route
  // fails closed until the server-written identity link exists.
  const identityKey = await loadLanguageValidationIdentity(db, userId, sourceId);
  let cache = await loadLanguageValidationCache(db, identityKey, "movie", itemId);
  if (!cache || !cache.audio_probed_at) {
    // The v90 finite-MKV lane already proved this exact file's Info + Tracks
    // structure before returning 201. Seed only that server-observed inventory;
    // this opens no provider connection and never treats container language tags
    // as speech verification.
    const seeded = await shareFileTracks(
      db,
      identityKey,
      "movie",
      itemId,
      exactProfile.audioTracks,
      exactProfile.subtitleTracks,
      true,
      true,
    );
    if (!seeded) {
      throw new HttpError(500, "Unable to cache the exact audio inventory", {
        code: "LANGUAGE_VALIDATION_CACHE_SEED_FAILED",
      });
    }
    cache = await loadLanguageValidationCache(db, identityKey, "movie", itemId);
  }
  if (!cache || !cache.audio_probed_at) {
    throw new HttpError(409, "Exact audio inventory is not cached yet", {
      code: "LANGUAGE_VALIDATION_CACHE_REQUIRED",
    });
  }
  let cachedAudioTracks = exactCachedAudioTracks(cache.audio_tracks, exactAudioIndices);
  if (!cachedAudioTracks) {
    const cacheStatus = stringOr(recordOrEmpty(cache.audio_lang_verification).status, "");
    if (
      cacheStatus === "validating" &&
      await hasActiveLanguageValidationJob(db, identityKey, "movie", itemId)
    ) {
      throw new HttpError(409, "Cached audio inventory is being validated", {
        code: "LANGUAGE_VALIDATION_CACHE_BUSY",
      });
    }
    // A newly completed gateway-inband profile is the exact same server-side
    // evidence used for the initial seed. It can safely repair a stale,
    // non-active cache map without opening another provider connection.
    await shareFileTracks(
      db,
      identityKey,
      "movie",
      itemId,
      exactProfile.audioTracks,
      exactProfile.subtitleTracks,
      true,
      true,
    );
    cache = await loadLanguageValidationCache(db, identityKey, "movie", itemId);
    cachedAudioTracks = cache
      ? exactCachedAudioTracks(cache.audio_tracks, exactAudioIndices)
      : null;
    if (!cache || !cachedAudioTracks) {
      throw new HttpError(409, "Cached audio inventory does not match the exact codec profile", {
        code: "LANGUAGE_VALIDATION_CACHE_MISMATCH",
      });
    }
  }
  const profileFingerprint = await languageValidationProfileFingerprint(
    exactProfile.profile,
    exactProfile.audioTracks,
    exactProfile.fileSizeBytes,
  );

  const cachedStrict = cachedStrictLanguageValidation(cache, exactAudioIndices, {
    profileFingerprint,
    profileProbedAt: exactProfile.profileProbedAt,
    fileSizeBytes: exactProfile.fileSizeBytes,
  });
  if (cachedStrict) {
    return {
      status: 200,
      body: languageValidationResponse({
        itemId,
        audioTracks: cachedStrict,
        verifiedAt: stringOrNull(cache.audio_lang_verified_at),
        cached: true,
      }),
    };
  }

  requireStrictLidWindowCount(Number(exactProfile.profile.durationSeconds));
  const retryAt = stringOrNull(cache.audio_lang_retry_at);
  const retryAtMs = retryAt ? Date.parse(retryAt) : Number.NaN;
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
    return {
      status: 429,
      body: languageValidationRejectedResponse({
        itemId,
        errorCode: "LANGUAGE_VALIDATION_RETRY_LATER",
        retryAt,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000)),
      }),
    };
  }

  const waitUntil = requireLanguageValidationWaitUntil();
  const { data: started, error: startError } = await db.rpc(
    "start_catalog_file_audio_validation_job",
    {
      p_requested_by: userId,
      p_source_id: sourceId,
      p_variant_id: exactProfile.variantId,
      p_identity_key: identityKey,
      p_external_id: itemId,
      p_expected_audio_indices: exactAudioIndices,
      p_profile_fingerprint: profileFingerprint,
      p_profile_probed_at: exactProfile.profileProbedAt,
      p_file_size_bytes: exactProfile.fileSizeBytes,
      p_cached_audio_tracks: cachedAudioTracks,
    },
  );
  if (startError) throwDb(startError, "Unable to start strict language validation");
  const startRecord = recordOrEmpty(started);
  if (startRecord.limited === true) {
    return {
      status: 429,
      body: languageValidationRejectedResponse({
        itemId,
        errorCode: stringOr(startRecord.code, "LANGUAGE_VALIDATION_RATE_LIMITED"),
        retryAt: stringOrNull(startRecord.retryAt),
        retryAfterSeconds: boundedNullableInt(startRecord.retryAfterSeconds, 1, 86_400) ?? 30,
      }),
    };
  }
  if (startRecord.busy === true) {
    throw new HttpError(409, "Provider file language validation is already running", {
      code: "LANGUAGE_VALIDATION_JOB_BUSY",
    });
  }
  const jobId = stringOr(startRecord.jobId, "");
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(jobId)) {
    throw new HttpError(500, "Language validation job was not created");
  }
  if (languageValidationJobScheduleDue(startRecord)) {
    scheduleLanguageValidationJob(waitUntil, db, jobId);
  }
  return {
    status: 202,
    body: languageValidationPendingResponse({
      jobId,
      itemId,
      state: stringOr(startRecord.state, "queued"),
      retryAt: stringOrNull(startRecord.retryAt),
    }),
  };
}
function exactLanguageValidationIndices(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new HttpError(400, "expectedAudioIndices must contain 1 to 32 stream indices");
  }
  const indices = value.map((entry) => {
    if (!Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > 128) {
      throw new HttpError(400, "expectedAudioIndices contains an invalid stream index");
    }
    return Number(entry);
  });
  if (new Set(indices).size !== indices.length) {
    throw new HttpError(400, "expectedAudioIndices must not contain duplicates");
  }
  return indices;
}

function sameIntegerSet(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((value, index) => value === b[index]);
}

type LanguageValidationWaitUntil = (task: Promise<unknown>) => void;

async function getPlaybackLanguageValidation(
  jobId: string,
  userId: string,
  db: SupabaseClient,
) {
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(jobId)) {
    throw new HttpError(400, "Invalid language validation job id");
  }
  const { data, error } = await db
    .from("catalog_file_audio_validation_jobs")
    .select(
      "id,requested_by,source_id,identity_key,item_type,external_id,state,next_track_position,expected_audio_indices,profile_fingerprint,profile_probed_at,file_size_bytes,queue_expires_at,lease_expires_at,retry_at,error_code,verified_at",
    )
    .eq("id", jobId)
    .eq("requested_by", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load language validation job");
  const job = data as JsonRecord | null;
  if (!job) throw new HttpError(404, "Language validation job not found");
  const sourceId = stringOr(job.source_id, "");
  try {
    await assertSourceCatalogVisible(sourceId, userId, db);
    await requireLanguageValidationEntitlement(userId, db);
  } catch (error) {
    if (languageValidationAccessWasRevoked(error)) {
      await cancelLanguageValidationJob(db, jobId, userId, "LANGUAGE_VALIDATION_ACCESS_REVOKED");
    }
    throw error;
  }

  const expectedAudioIndices = exactLanguageValidationIndices(job.expected_audio_indices);
  const itemId = stringOr(job.external_id, "");
  const state = stringOr(job.state, "failed");
  if (state === "verified") {
    const cache = await loadLanguageValidationCache(
      db,
      stringOr(job.identity_key, ""),
      stringOr(job.item_type, "") === "episode" ? "episode" : "movie",
      itemId,
    );
    const cachedStrict = cache
      ? cachedStrictLanguageValidation(cache, expectedAudioIndices, {
        profileFingerprint: stringOr(job.profile_fingerprint, ""),
        profileProbedAt: stringOr(job.profile_probed_at, ""),
        fileSizeBytes: exactPositiveSafeInteger(job.file_size_bytes) ?? 0,
      })
      : null;
    if (!cachedStrict) {
      throw new HttpError(409, "Verified language job has no exact canonical certificate", {
        code: "LANGUAGE_VALIDATION_FINALIZE_MISMATCH",
      });
    }
    return {
      status: 200,
      body: languageValidationResponse({
        itemId,
        audioTracks: cachedStrict,
        verifiedAt: stringOrNull(job.verified_at ?? cache?.audio_lang_verified_at),
        cached: false,
      }),
    };
  }
  if (state === "failed" || state === "expired" || state === "cancelled") {
    return {
      status: 200,
      body: languageValidationFailedResponse({
        jobId,
        itemId,
        errorCode: stringOr(job.error_code, "LANGUAGE_VALIDATION_FAILED"),
        retryAt: stringOrNull(job.retry_at),
      }),
    };
  }

  const retryAt = stringOrNull(job.retry_at);
  if (languageValidationJobScheduleDue(job)) {
    const waitUntil = requireLanguageValidationWaitUntil();
    scheduleLanguageValidationJob(waitUntil, db, jobId);
  }
  return {
    status: 202,
    body: languageValidationPendingResponse({
      jobId,
      itemId,
      state,
      retryAt,
      completedTracks: boundedNullableInt(job.next_track_position, 0, 32) ?? 0,
      trackCount: expectedAudioIndices.length,
    }),
  };
}

function requireLanguageValidationWaitUntil(): LanguageValidationWaitUntil {
  const edgeRuntime = (
    globalThis as { EdgeRuntime?: { waitUntil?: LanguageValidationWaitUntil } }
  ).EdgeRuntime;
  if (!edgeRuntime || typeof edgeRuntime.waitUntil !== "function") {
    throw new HttpError(503, "Durable language validation background work is unavailable", {
      code: "LANGUAGE_VALIDATION_BACKGROUND_UNAVAILABLE",
    });
  }
  return edgeRuntime.waitUntil.bind(edgeRuntime);
}

function scheduleLanguageValidationJob(
  waitUntil: LanguageValidationWaitUntil,
  db: SupabaseClient,
  jobId: string,
) {
  const existing = languageValidationTasks.get(jobId);
  if (existing) return false;
  let task: Promise<void>;
  task = Promise.resolve()
    .then(() => processOneLanguageValidationTrack(db, jobId))
    .catch(() => {
      // The durable job lease is the recovery signal. Never log the exception:
      // provider failures can carry a URL, capability or upstream response text.
      console.warn("[norva-playback] durable language validation task deferred");
    })
    .finally(() => {
      if (languageValidationTasks.get(jobId) === task) languageValidationTasks.delete(jobId);
    });
  languageValidationTasks.set(jobId, task);
  try {
    waitUntil(task);
  } catch (_) {
    if (languageValidationTasks.get(jobId) === task) languageValidationTasks.delete(jobId);
    throw new HttpError(503, "Durable language validation background work is unavailable", {
      code: "LANGUAGE_VALIDATION_BACKGROUND_UNAVAILABLE",
    });
  }
  return true;
}

function languageValidationJobScheduleDue(job: JsonRecord, nowMs = Date.now()) {
  const state = stringOr(job.state, "");
  if (state === "queued") return true;
  if (state === "retry_wait") {
    const retryAtMs = Date.parse(stringOr(job.retryAt ?? job.retry_at, ""));
    return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
  }
  if (state === "running" || state === "finalizing") {
    const leaseExpiresAtMs = Date.parse(
      stringOr(job.leaseExpiresAt ?? job.lease_expires_at, ""),
    );
    return Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= nowMs;
  }
  return false;
}

async function languageValidationProfileFingerprint(
  profile: JsonRecord,
  audioTracks: JsonRecord[],
  fileSizeBytes: number,
) {
  const stableTracks = audioTracks
    .map((track) => ({
      index: Number(track.index),
      codec: normalizeCodecToken(track.codec),
      channels: boundedNullableInt(track.channels, 0, 16),
      default: track.default === true,
    }))
    .sort((left, right) => left.index - right.index);
  return await sha256Hex(JSON.stringify({
    protocol: LANGUAGE_VALIDATION_PROTOCOL,
    metadataComplete: profile.metadataComplete === true,
    probeSource: normalizeCodecToken(profile.probeSource),
    probedAt: stringOr(profile.probedAt, ""),
    container: normalizeCodecToken(profile.container),
    durationSeconds: Number(profile.durationSeconds),
    fileSizeBytes,
    audioTracks: stableTracks,
  }));
}

async function runLanguageValidationRetryWorker(req: Request, db: SupabaseClient) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: authorized, error: authError } = await db.rpc(
    "norva_verify_cron_secret",
    { presented: token },
  );
  if (authError || authorized !== true) throw new HttpError(403, "Unauthorized");

  const { data, error } = await db.rpc(
    "list_due_catalog_file_audio_validation_jobs",
    { p_limit: LANGUAGE_VALIDATION_RETRY_WORKER_BATCH },
  );
  if (error) throwDb(error, "Unable to load due language validation jobs");
  const jobIds = (Array.isArray(data) ? data : [])
    .map((row) => stringOr(recordOrEmpty(row).job_id, ""))
    .filter((jobId) => PLAYBACK_SESSION_UUID_PATTERN.test(jobId));
  const waitUntil = jobIds.length ? requireLanguageValidationWaitUntil() : null;
  let scheduled = 0;
  for (const jobId of jobIds) {
    if (waitUntil && scheduleLanguageValidationJob(waitUntil, db, jobId)) scheduled++;
  }
  return {
    ok: true,
    protocol: LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL,
    due: jobIds.length,
    scheduled,
  };
}

async function revalidateLanguageValidationClaim(
  db: SupabaseClient,
  claim: JsonRecord,
) {
  const jobId = stringOr(claim.jobId, "");
  const userId = stringOr(claim.requestedBy, "");
  const sourceId = stringOr(claim.sourceId, "");
  const itemId = stringOr(claim.itemId, "");
  const rawItemType = stringOr(claim.itemType, "");
  const itemType = rawItemType === "movie" || rawItemType === "episode" ? rawItemType : null;
  const variantId = stringOr(claim.variantId, "");
  const identityKey = stringOr(claim.identityKey, "");
  const expectedAudioIndices = exactLanguageValidationIndices(claim.expectedAudioIndices)
    .sort((left, right) => left - right);
  const expectedFileSizeBytes = exactPositiveSafeInteger(claim.fileSizeBytes);
  if (
    !PLAYBACK_SESSION_UUID_PATTERN.test(jobId) ||
    !userId || !sourceId || !itemId || !variantId || !identityKey ||
    !itemType || !expectedFileSizeBytes
  ) {
    throw new HttpError(409, "Language validation job coordinates are invalid", {
      code: "LANGUAGE_VALIDATION_JOB_INVALID",
    });
  }
  try {
    await assertSourceCatalogVisible(sourceId, userId, db);
    await requireLanguageValidationEntitlement(userId, db);
  } catch (error) {
    if (languageValidationAccessWasRevoked(error)) {
      throw new HttpError(409, "Language validation access was revoked", {
        code: "LANGUAGE_VALIDATION_ACCESS_REVOKED",
      });
    }
    throw error;
  }
  const exactProfile = itemType === "episode"
    ? await loadExactEpisodeLanguageValidationProfile(
      db,
      jobId,
      userId,
      sourceId,
      itemId,
      variantId,
      identityKey,
    )
    : await loadExactLanguageValidationProfile(db, userId, sourceId, itemId);
  const exactAudioIndices = exactProfile.audioTracks
    .map((track) => Number(track.index))
    .sort((left, right) => left - right);
  const fingerprint = await languageValidationProfileFingerprint(
    exactProfile.profile,
    exactProfile.audioTracks,
    exactProfile.fileSizeBytes,
  );
  if (
    exactProfile.variantId !== variantId ||
    !sameIntegerSet(exactAudioIndices, expectedAudioIndices) ||
    exactProfile.fileSizeBytes !== expectedFileSizeBytes ||
    Date.parse(exactProfile.profileProbedAt) !== Date.parse(stringOr(claim.profileProbedAt, "")) ||
    fingerprint !== stringOr(claim.profileFingerprint, "")
  ) {
    throw new HttpError(409, "Exact language validation profile changed", {
      code: "LANGUAGE_VALIDATION_PROFILE_CHANGED",
    });
  }
  const currentIdentityKey = await loadLanguageValidationIdentity(db, userId, sourceId);
  if (currentIdentityKey !== identityKey) {
    throw new HttpError(409, "Provider identity changed", {
      code: "LANGUAGE_VALIDATION_IDENTITY_CHANGED",
    });
  }
  const cache = await loadLanguageValidationCache(db, identityKey, itemType, itemId);
  const cachedAudioTracks = cache
    ? exactCachedAudioTracks(cache.audio_tracks, expectedAudioIndices)
    : null;
  if (!cachedAudioTracks) {
    throw new HttpError(409, "Canonical audio inventory changed", {
      code: "LANGUAGE_VALIDATION_CACHE_MISMATCH",
    });
  }
  return {
    userId,
    sourceId,
    itemId,
    itemType,
    identityKey,
    expectedAudioIndices,
    exactProfile,
    cachedAudioTracks,
    fingerprint,
  };
}

function gatewayProviderDrainAttested(payload: JsonRecord) {
  return payload.providerDrained === true
    && payload.providerDrainProtocol === 1;
}

function acceptGatewayProviderDrain(
  payload: JsonRecord,
  retainLeaseUntilExpiry: () => void,
): boolean {
  if (gatewayProviderDrainAttested(payload)) return true;
  // A successful HTTP response is not proof that the provider-side process and
  // socket have exited. Keep the distributed exclusion until its TTL whenever
  // the gateway cannot attest protocol-v1 drainage.
  retainLeaseUntilExpiry();
  return false;
}

function strictLanguageProviderDrainAttested(payload: JsonRecord) {
  // Keep this helper self-contained: the strict-LID worker and its contract
  // tests evaluate it independently from the catalogue probe helpers.
  return payload.providerDrained === true
    && payload.providerDrainProtocol === 1;
}

function languageValidationFetchBudgetMs(taskDeadlineAt: number, nowMs = Date.now()) {
  return Math.max(0, Math.floor(Math.min(
    LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS,
    taskDeadlineAt - nowMs - LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS,
  )));
}

type StrictLidWindowState = {
  position: number;
  count: 4 | 6;
  protocol: 1;
  tokens: string[];
};

type StrictLidWindowCapabilityClaims = {
  windowCheckpointProtocol: 1;
  jobId: string;
  profileFingerprint: string;
  windowCount: 4 | 6;
  windowOrdinal?: number;
  windowFinalize?: true;
};

function strictLidWindowCountForDuration(durationSeconds: number): 4 | 6 | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 * LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS) {
    return null;
  }
  return durationSeconds >= 6 * LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS ? 6 : 4;
}

function requireStrictLidWindowCount(durationSeconds: number): 4 | 6 {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 24 * 60 * 60) {
    throw new HttpError(409, "Exact language validation duration is invalid", {
      code: "LANGUAGE_VALIDATION_DURATION_INVALID",
    });
  }
  const count = strictLidWindowCountForDuration(durationSeconds);
  if (!count) {
    throw new HttpError(422, "Exact media is too short for strict language validation", {
      code: "LANGUAGE_VALIDATION_DURATION_TOO_SHORT",
    });
  }
  return count;
}

function strictLidWindowToken(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LANGUAGE_VALIDATION_WINDOW_RECEIPT_MAX_CHARS) {
    return null;
  }
  return LANGUAGE_VALIDATION_WINDOW_RECEIPT_PATTERN.test(value) ? value : null;
}

function strictLidWindowStateFromClaim(
  claim: JsonRecord,
  exactDurationSeconds: number,
): StrictLidWindowState | null {
  const expectedCount = strictLidWindowCountForDuration(exactDurationSeconds);
  const position = Number(claim.windowPosition);
  const count = Number(claim.windowCount);
  const protocol = Number(claim.windowProtocol);
  const rawTokens = Array.isArray(claim.windowTokens) ? claim.windowTokens : [];
  const tokens = rawTokens.map(strictLidWindowToken);
  if (
    !expectedCount || count !== expectedCount || protocol !== LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL ||
    !Number.isInteger(position) || position < 0 || position > count ||
    rawTokens.length !== position || tokens.some((token) => token === null)
  ) {
    return null;
  }
  const exactTokens = tokens as string[];
  if (new Set(exactTokens).size !== exactTokens.length) return null;
  return { position, count: expectedCount, protocol: 1, tokens: exactTokens };
}

function strictLidWindowCheckpointFromGateway(
  payload: JsonRecord,
  expectedOrdinal: number,
  expectedCount: 4 | 6,
) {
  const receipt = strictLidWindowToken(payload.receipt);
  if (
    Number(payload.windowCheckpointProtocol) !== LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL ||
    Number(payload.windowOrdinal) !== expectedOrdinal ||
    Number(payload.windowCount) !== expectedCount ||
    payload.verified === true ||
    !receipt
  ) {
    return null;
  }
  return receipt;
}

function sameStrictLidWindowState(left: StrictLidWindowState, right: StrictLidWindowState) {
  return left.position === right.position &&
    left.count === right.count &&
    left.protocol === right.protocol &&
    left.tokens.length === right.tokens.length &&
    left.tokens.every((token, index) => token === right.tokens[index]);
}

type LanguageValidationGatewayResponseRead =
  | { ok: true; payload: unknown }
  | {
    ok: false;
    errorCode:
      | "LANGUAGE_VALIDATION_GATEWAY_RESPONSE_INVALID"
      | "LANGUAGE_VALIDATION_GATEWAY_TRANSPORT";
  };

async function readLanguageValidationGatewayResponse(
  response: Response,
  maxBytes = LANGUAGE_VALIDATION_FINALIZE_BODY_MAX_BYTES,
): Promise<LanguageValidationGatewayResponseRead> {
  const invalid = (): LanguageValidationGatewayResponseRead => ({
    ok: false,
    errorCode: "LANGUAGE_VALIDATION_GATEWAY_RESPONSE_INVALID",
  });
  const transport = (): LanguageValidationGatewayResponseRead => ({
    ok: false,
    errorCode: "LANGUAGE_VALIDATION_GATEWAY_TRANSPORT",
  });
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength !== null) {
    const normalizedContentLength = rawContentLength.trim();
    const advertisedBytes = Number(normalizedContentLength);
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(normalizedContentLength) ||
      !Number.isSafeInteger(advertisedBytes) ||
      advertisedBytes > maxBytes
    ) {
      try {
        await response.body?.cancel();
      } catch (_) { /* cancellation is best-effort; the response remains untrusted */ }
      return invalid();
    }
  }
  if (!response.body) return invalid();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (totalBytes + value.byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch (_) { /* the bounded reader has already rejected the payload */ }
        return invalid();
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (_) {
    try {
      await reader.cancel();
    } catch (_) { /* the transport error remains authoritative */ }
    return transport();
  } finally {
    try {
      reader.releaseLock();
    } catch (_) { /* no reusable body is trusted after this read */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, payload: JSON.parse(text) };
  } catch (_) {
    return invalid();
  }
}

async function processOneLanguageValidationTrack(db: SupabaseClient, jobId: string) {
  // edge-runtime v1.74 may retire a per-worker isolate halfway through its
  // configured lifetime. Bound the complete task, not only the fetch, so DB
  // checkpoint/finalization and provider cleanup retain a deterministic margin.
  const taskDeadlineAt = Date.now() + LANGUAGE_VALIDATION_TASK_BUDGET_MS;
  const leaseOwner = `language-validation-job:${crypto.randomUUID()}`;
  const { data: claimed, error: claimError } = await db.rpc(
    "claim_catalog_file_audio_validation_job",
    {
      p_job_id: jobId,
      p_lease_owner: leaseOwner,
      p_ttl_seconds: LANGUAGE_VALIDATION_JOB_LEASE_SECONDS,
    },
  );
  if (claimError || !claimed) return;
  const claim = recordOrEmpty(claimed);
  let providerLeaseClaimed = false;
  let providerAccountLeaseClaimed = false;
  let providerAccountLeaseReleaseSafe = false;
  let providerAccountLeaseHash = "";
  let providerLeaseOwner = "";
  let identityKey = stringOr(claim.identityKey, "");
  let providerAttemptToken: string | null = null;
  const settleProviderAttempt = async (outcome: "no_progress" | "viewer_preempted") => {
    if (!providerAttemptToken) return null;
    const attemptToken = providerAttemptToken;
    try {
      const { data, error } = await db.rpc(
        "finish_catalog_file_audio_validation_provider_attempt",
        {
          p_job_id: jobId,
          p_lease_owner: leaseOwner,
          p_attempt_token: attemptToken,
          p_outcome: outcome,
          p_max_consecutive_no_progress:
            LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS,
        },
      );
      if (error || !data) {
        console.warn("[norva-playback] language validation provider attempt settlement lost ownership");
        return null;
      }
      providerAttemptToken = null;
      return recordOrEmpty(data);
    } catch (_) {
      console.warn("[norva-playback] language validation provider attempt settlement deferred");
      return null;
    }
  };
  try {
    const current = await revalidateLanguageValidationClaim(db, claim);
    identityKey = current.identityKey;
    const trackIndex = boundedNullableInt(claim.trackIndex, 0, 128);
    if (trackIndex === null) {
      await finalizeLanguageValidationJob(db, jobId, leaseOwner, claim, current);
      return;
    }
    if (!current.expectedAudioIndices.includes(trackIndex)) {
      throw new HttpError(409, "Language validation track cursor changed", {
        code: "LANGUAGE_VALIDATION_CURSOR_MISMATCH",
      });
    }
    const initialDurationSeconds = Number(current.exactProfile.profile.durationSeconds);
    requireStrictLidWindowCount(initialDurationSeconds);
    const windowState = strictLidWindowStateFromClaim(claim, initialDurationSeconds);
    if (!windowState) {
      throw new HttpError(409, "Strict language validation window cursor is invalid", {
        code: "LANGUAGE_VALIDATION_WINDOW_CURSOR_INVALID",
      });
    }

    const resolved = current.itemType === "episode"
      ? await resolveExactEpisodePlaybackTarget(
        current.sourceId,
        current.userId,
        recordOrEmpty(current.exactProfile.episodeCoordinates),
        {},
        db,
      )
      : await resolvePlaybackTarget(
        current.sourceId,
        "movie",
        current.itemId,
        current.userId,
        db,
      );
    const targetUrl = stringOr(resolved.targetUrl, "");
    assertHttpUrl(targetUrl);
    if (windowState.position === windowState.count) {
      await finalizeLanguageValidationTrackWindows({
        db,
        jobId,
        leaseOwner,
        claim,
        current,
        targetUrl,
        trackIndex,
        windowState,
        taskDeadlineAt,
      });
      return;
    }
    const providerAccountScope = "providerAccountScope" in resolved
      ? stringOr(resolved.providerAccountScope, "")
      : "";
    const providerAccountHash = providerAccountScope
      ? await sha256Hex(providerAccountScope)
      : await providerAccountHashFromUrl(targetUrl);
    const providerAccountKey = providerAccountKeyFromUrl(targetUrl);
    if (!providerAccountKey) {
      throw new HttpError(422, "Provider account could not be identified", {
        code: "LANGUAGE_VALIDATION_PROVIDER_INVALID",
      });
    }
    await assertProviderCircuitClosed(providerAccountHash, db);
    await assertLanguageValidationIdle(
      db,
      current.userId,
      providerAccountHash,
      providerAccountKey,
    );

    // The initial claim precedes ownership/profile/provider preflight. Renew it
    // with the same owner immediately before any provider lease or I/O. If a
    // stalled preflight let another worker reclaim the row, this CAS-style
    // claim returns null and the stale worker exits without touching the lane.
    if (languageValidationFetchBudgetMs(taskDeadlineAt) <= 0) {
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED",
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      return;
    }
    const { data: renewed, error: renewError } = await db.rpc(
      "claim_catalog_file_audio_validation_job",
      {
        p_job_id: jobId,
        p_lease_owner: leaseOwner,
        p_ttl_seconds: LANGUAGE_VALIDATION_JOB_LEASE_SECONDS,
      },
    );
    const renewedClaim = recordOrEmpty(renewed);
    const renewedWindowState = strictLidWindowStateFromClaim(
      renewedClaim,
      initialDurationSeconds,
    );
    if (
      renewError || !renewed ||
      stringOr(renewedClaim.jobId, "") !== stringOr(claim.jobId, "") ||
      boundedNullableInt(renewedClaim.trackIndex, 0, 128) !== trackIndex ||
      stringOr(renewedClaim.identityKey, "") !== current.identityKey ||
      stringOr(renewedClaim.profileFingerprint, "") !== current.fingerprint ||
      !renewedWindowState || !sameStrictLidWindowState(windowState, renewedWindowState)
    ) {
      return;
    }

    const windowOrdinal = windowState.position + 1;
    providerLeaseOwner = `language-validation-track:${jobId}:${trackIndex}:window:${windowOrdinal}:${crypto.randomUUID()}`;
    providerAccountLeaseHash = providerAccountHash;
    const { data: providerAccountClaimed, error: providerAccountClaimError } = await db.rpc(
      "claim_provider_account_language_validation",
      {
        p_provider_account_hash: providerAccountHash,
        p_lease_owner: providerLeaseOwner,
        p_ttl_seconds: LANGUAGE_VALIDATION_ACCOUNT_LEASE_SECONDS,
      },
    );
    if (providerAccountClaimError) {
      throw new HttpError(503, "Unable to claim provider account validation lease", {
        code: "LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR",
      });
    }
    if (providerAccountClaimed !== true) {
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_PROVIDER_LEASE_BUSY",
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      return;
    }
    providerAccountLeaseClaimed = true;
    providerAccountLeaseReleaseSafe = true;

    const { data: providerClaimed, error: providerClaimError } = await db.rpc(
      "claim_provider_file_probe",
      {
        p_identity_key: current.identityKey,
        p_lease_owner: providerLeaseOwner,
        p_ttl_seconds: LANGUAGE_VALIDATION_LEASE_SECONDS,
      },
    );
    if (providerClaimError) {
      throw new HttpError(503, "Unable to claim provider language validation lease", {
        code: "LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR",
      });
    }
    if (providerClaimed !== true) {
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_PROVIDER_LEASE_BUSY",
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      return;
    }
    providerLeaseClaimed = true;

    // The provider lane and the exact-file profile are both checked again after
    // the distributed lease closes the race, before minting the per-track token.
    await assertProviderCircuitClosed(providerAccountHash, db);
    await assertLanguageValidationIdle(
      db,
      current.userId,
      providerAccountHash,
      providerAccountKey,
    );
    const exactAfterLease = await revalidateLanguageValidationClaim(db, claim);
    // Bind timeline sampling to the same server-observed MKV profile that was
    // fingerprinted for this job and revalidated after both provider leases.
    // The duration stays inside the HMAC capability; no unsigned query value
    // can select strict sampling offsets.
    const exactDurationSeconds = Number(
      exactAfterLease.exactProfile.profile.durationSeconds,
    );
    if (
      !Number.isFinite(exactDurationSeconds) ||
      exactDurationSeconds <= 0 ||
      exactDurationSeconds > 24 * 60 * 60 ||
      strictLidWindowCountForDuration(exactDurationSeconds) !== windowState.count
    ) {
      throw new HttpError(409, "Exact language validation duration is invalid", {
        code: "LANGUAGE_VALIDATION_DURATION_INVALID",
      });
    }
    const pipeExpiresAt = new Date(
      Date.now() + LANGUAGE_VALIDATION_LEASE_SECONDS * 1000,
    ).toISOString();
    const detectionAccess = await createBytePipeCapability(
      providerLeaseOwner,
      current.userId,
      targetUrl,
      pipeExpiresAt,
      db,
      null,
      LANGUAGE_VALIDATION_SCOPE,
      exactAfterLease.exactProfile.fileSizeBytes,
      exactDurationSeconds,
      {
        windowCheckpointProtocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL,
        jobId,
        profileFingerprint: exactAfterLease.fingerprint,
        windowOrdinal,
        windowCount: windowState.count,
      },
    );
    let response: Response;
    const fetchBudgetMs = languageValidationFetchBudgetMs(taskDeadlineAt);
    if (fetchBudgetMs <= 0) {
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED",
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      });
      return;
    }
    const { data: providerAttempt, error: providerAttemptError } = await db.rpc(
      "begin_catalog_file_audio_validation_provider_attempt",
      {
        p_job_id: jobId,
        p_lease_owner: leaseOwner,
        p_provider_account_hash: providerAccountHash,
        p_provider_lease_owner: providerLeaseOwner,
        p_stream_index: trackIndex,
        p_window_ordinal: windowOrdinal,
        p_max_consecutive_no_progress:
          LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS,
      },
    );
    const providerAttemptState = recordOrEmpty(providerAttempt);
    if (providerAttemptError) {
      throw new HttpError(503, "Unable to journal provider validation attempt", {
        code: "LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_JOURNAL_ERROR",
      });
    }
    if (providerAttemptState.quarantined === true) return;
    providerAttemptToken = stringOrNull(providerAttemptState.attemptToken);
    if (providerAttemptState.allowed !== true || !providerAttemptToken) {
      throw new HttpError(409, "Provider validation attempt lost ownership", {
        code: "LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_REJECTED",
      });
    }
    providerAccountLeaseReleaseSafe = false;
    try {
      response = await fetch(
        `${detectionAccess.gatewayUrl}/detect-language?index=${trackIndex}&strict=1&dur=${LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${detectionAccess.serviceToken}`,
            "X-Norva-Byte-Pipe-Token": detectionAccess.capability,
          },
          // The same signal remains attached while the bounded body reader consumes
          // the stream, so headers alone cannot escape the end-to-end task budget.
          signal: AbortSignal.timeout(fetchBudgetMs),
        },
      );
    } catch (error) {
      await settleProviderAttempt("no_progress");
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: error instanceof DOMException && error.name === "TimeoutError"
          ? "LANGUAGE_VALIDATION_GATEWAY_TIMEOUT"
          : "LANGUAGE_VALIDATION_GATEWAY_TRANSPORT",
        retryAt: new Date(Date.now() + LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS).toISOString(),
      });
      return;
    }
    const responseRead = await readLanguageValidationGatewayResponse(response);
    if (!responseRead.ok) {
      await settleProviderAttempt("no_progress");
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: responseRead.errorCode,
        retryAt: new Date(Date.now() + LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS).toISOString(),
      });
      return;
    }
    const payload = recordOrEmpty(responseRead.payload);
    // Release the account-wide lease only when the v92+ Gateway explicitly
    // attests that the strict broker closed its provider socket and completed
    // the panel slot-release grace before sending this response. A legacy,
    // malformed or interrupted response keeps the crash-safe TTL lease.
    providerAccountLeaseReleaseSafe = strictLanguageProviderDrainAttested(payload);
    const gatewayCode = stringOr(payload.code ?? payload.errorCode ?? payload.error_code, "");
    const { data: providerLeaseStillCurrent, error: providerLeaseCurrentError } = await db.rpc(
      "provider_account_language_validation_lease_is_current",
      {
        p_provider_account_hash: providerAccountHash,
        p_lease_owner: providerLeaseOwner,
      },
    );
    const viewerPreempted = gatewayCode === "LANGUAGE_VALIDATION_VIEWER_PREEMPTED"
      || providerLeaseStillCurrent !== true;
    if (providerLeaseCurrentError) {
      await settleProviderAttempt("no_progress");
      throw new HttpError(503, "Unable to verify provider validation ownership", {
        code: "LANGUAGE_VALIDATION_PROVIDER_LEASE_VERIFY_ERROR",
      });
    }
    if (viewerPreempted) {
      await settleProviderAttempt("viewer_preempted");
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_VIEWER_PREEMPTED",
        retryAt: new Date(Date.now() + LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS).toISOString(),
      });
      return;
    }
    const upstreamStatus = extractProviderStatus(
      payload,
      sanitizeTelemetryText(textFromGatewayDetails(payload)),
    );
    if (isProviderBusyFailure({
      code: gatewayCode,
      upstreamStatus: upstreamStatus ?? response.status,
    })) {
      await settleProviderAttempt("no_progress");
      const circuit = await openProviderPlaybackCircuit(providerAccountHash, db, true);
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "PROVIDER_ACCOUNT_BUSY",
        terminal: true,
        retryAt: circuit.blockedUntil,
      });
      return;
    }
    if (!response.ok) {
      await settleProviderAttempt("no_progress");
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: gatewayCode === "PROXY_AUTH_FAILED"
          ? "PROXY_AUTH_FAILED"
          : "LANGUAGE_VALIDATION_GATEWAY_ERROR",
        retryAt: languageValidationGatewayRetryAt(
          response.status,
          gatewayCode,
          upstreamStatus,
        ),
      });
      return;
    }
    const receipt = strictLidWindowCheckpointFromGateway(
      payload,
      windowOrdinal,
      windowState.count,
    );
    if (!receipt || !providerAccountLeaseReleaseSafe) {
      await settleProviderAttempt("no_progress");
      await failLanguageValidationJob(db, {
        jobId,
        leaseOwner,
        errorCode: "LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_INVALID",
        retryAt: new Date(Date.now() + LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS).toISOString(),
      });
      return;
    }
    const { data: checkpoint, error: checkpointError } = await db.rpc(
      "checkpoint_catalog_file_audio_validation_window",
      {
        p_job_id: jobId,
        p_lease_owner: leaseOwner,
        p_stream_index: trackIndex,
        p_window_ordinal: windowOrdinal,
        p_window_count: windowState.count,
        p_window_protocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL,
        p_window_token: receipt,
      },
    );
    if (checkpointError || !checkpoint) {
      throw new HttpError(409, "Language validation window checkpoint was not persisted", {
        code: "LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_FAILED",
      });
    }
    // The checkpoint trigger cleared the crash-safe provider attempt token and
    // reset the consecutive no-progress budget atomically with this progress.
    providerAttemptToken = null;
    if (recordOrEmpty(checkpoint).complete === true) {
      const finalCurrent = await revalidateLanguageValidationClaim(db, claim);
      await finalizeLanguageValidationTrackWindows({
        db,
        jobId,
        leaseOwner,
        claim,
        current: finalCurrent,
        targetUrl,
        trackIndex,
        windowState: {
          position: windowState.count,
          count: windowState.count,
          protocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL,
          tokens: [...windowState.tokens, receipt],
        },
        taskDeadlineAt,
      });
    }
  } catch (error) {
    await settleProviderAttempt("no_progress");
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: languageValidationTaskErrorCode(error),
      terminal: languageValidationTaskErrorIsTerminal(error),
      retryAt: languageValidationTaskRetryAt(error),
    });
  } finally {
    await settleProviderAttempt("no_progress");
    if (
      providerAccountLeaseClaimed
      && providerAccountLeaseReleaseSafe
      && providerAccountLeaseHash
      && providerLeaseOwner
    ) {
      try {
        const { error: providerAccountReleaseError } = await db.rpc(
          "release_provider_account_language_validation",
          {
            p_provider_account_hash: providerAccountLeaseHash,
            p_lease_owner: providerLeaseOwner,
          },
        );
        if (providerAccountReleaseError) {
          console.warn("[norva-playback] language validation account lease release deferred");
        }
      } catch (_) { /* lease expiry is the crash-safe fallback */ }
    }
    if (
      providerLeaseClaimed
      && providerAccountLeaseReleaseSafe
      && identityKey
      && providerLeaseOwner
    ) {
      await releaseProviderFileProbe(db, identityKey, providerLeaseOwner);
    }
  }
}

async function finalizeLanguageValidationTrackWindows(options: {
  db: SupabaseClient;
  jobId: string;
  leaseOwner: string;
  claim: JsonRecord;
  current: Awaited<ReturnType<typeof revalidateLanguageValidationClaim>>;
  targetUrl: string;
  trackIndex: number;
  windowState: StrictLidWindowState;
  taskDeadlineAt: number;
}) {
  const {
    db,
    jobId,
    leaseOwner,
    claim,
    current,
    targetUrl,
    trackIndex,
    windowState,
    taskDeadlineAt,
  } = options;
  const exactDurationSeconds = Number(current.exactProfile.profile.durationSeconds);
  if (
    windowState.position !== windowState.count ||
    windowState.tokens.length !== windowState.count ||
    new Set(windowState.tokens).size !== windowState.tokens.length ||
    strictLidWindowCountForDuration(exactDurationSeconds) !== windowState.count ||
    !current.expectedAudioIndices.includes(trackIndex)
  ) {
    throw new HttpError(409, "Strict language validation receipt set is incomplete", {
      code: "LANGUAGE_VALIDATION_WINDOW_CURSOR_INVALID",
    });
  }
  const body = JSON.stringify({ receipts: windowState.tokens });
  if (new TextEncoder().encode(body).byteLength > LANGUAGE_VALIDATION_FINALIZE_BODY_MAX_BYTES) {
    throw new HttpError(409, "Strict language validation receipt set is too large", {
      code: "LANGUAGE_VALIDATION_WINDOW_RECEIPTS_INVALID",
    });
  }
  const capabilityExpiresAt = new Date(
    Date.now() + LANGUAGE_VALIDATION_LEASE_SECONDS * 1000,
  ).toISOString();
  const finalAccess = await createBytePipeCapability(
    `language-validation-finalize:${jobId}:${trackIndex}:${crypto.randomUUID()}`,
    current.userId,
    targetUrl,
    capabilityExpiresAt,
    db,
    null,
    LANGUAGE_VALIDATION_SCOPE,
    current.exactProfile.fileSizeBytes,
    exactDurationSeconds,
    {
      windowCheckpointProtocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL,
      windowFinalize: true,
      jobId,
      profileFingerprint: current.fingerprint,
      windowCount: windowState.count,
    },
  );
  const fetchBudgetMs = languageValidationFetchBudgetMs(taskDeadlineAt);
  if (fetchBudgetMs <= 0) {
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: "LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED",
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    return;
  }

  let response: Response;
  try {
    response = await fetch(
      `${finalAccess.gatewayUrl}/detect-language/finalize?index=${trackIndex}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${finalAccess.serviceToken}`,
          "Content-Type": "application/json",
          "X-Norva-Byte-Pipe-Token": finalAccess.capability,
        },
        body,
        signal: AbortSignal.timeout(fetchBudgetMs),
      },
    );
  } catch (error) {
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: error instanceof DOMException && error.name === "TimeoutError"
        ? "LANGUAGE_VALIDATION_GATEWAY_TIMEOUT"
        : "LANGUAGE_VALIDATION_GATEWAY_TRANSPORT",
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    return;
  }

  const responseRead = await readLanguageValidationGatewayResponse(response);
  if (!responseRead.ok) {
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: responseRead.errorCode,
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    return;
  }
  const payload = recordOrEmpty(responseRead.payload);
  const providerDrained = strictLanguageProviderDrainAttested(payload);
  const gatewayCode = stringOr(payload.code ?? payload.errorCode ?? payload.error_code, "");
  if (
    response.status === 409 &&
    gatewayCode === "strict_lid_checkpoint_reset_required" &&
    payload.resetRequired === true &&
    providerDrained
  ) {
    const { data: reset, error: resetError } = await db.rpc(
      "reset_catalog_file_audio_validation_windows",
      {
        p_job_id: jobId,
        p_lease_owner: leaseOwner,
        p_stream_index: trackIndex,
        p_window_position: windowState.position,
        p_window_count: windowState.count,
        p_window_protocol: windowState.protocol,
      },
    );
    if (resetError || reset !== true) {
      throw new HttpError(409, "Strict language validation receipt reset lost ownership", {
        code: "LANGUAGE_VALIDATION_WINDOW_RESET_FAILED",
      });
    }
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: "LANGUAGE_VALIDATION_CHECKPOINT_RESET_REQUIRED",
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    return;
  }
  if (!response.ok || !providerDrained) {
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: "LANGUAGE_VALIDATION_GATEWAY_ERROR",
      retryAt: languageValidationGatewayRetryAt(response.status, gatewayCode, null),
    });
    return;
  }
  const accepted = strictLanguageValidationEvidence(payload, trackIndex);
  if (!accepted) {
    await failLanguageValidationJob(db, {
      jobId,
      leaseOwner,
      errorCode: "LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING",
    });
    return;
  }
  const { data: checkpoint, error: checkpointError } = await db.rpc(
    "checkpoint_catalog_file_audio_validation_track",
    {
      p_job_id: jobId,
      p_lease_owner: leaseOwner,
      p_stream_index: trackIndex,
      p_evidence: accepted,
    },
  );
  if (checkpointError || !checkpoint) {
    throw new HttpError(409, "Language validation track checkpoint was not persisted", {
      code: "LANGUAGE_VALIDATION_CHECKPOINT_FAILED",
    });
  }
  if (recordOrEmpty(checkpoint).complete === true) {
    const finalCurrent = await revalidateLanguageValidationClaim(db, claim);
    await finalizeLanguageValidationJob(db, jobId, leaseOwner, claim, finalCurrent);
  }
}

async function finalizeLanguageValidationJob(
  db: SupabaseClient,
  jobId: string,
  leaseOwner: string,
  claim: JsonRecord,
  current: Awaited<ReturnType<typeof revalidateLanguageValidationClaim>>,
) {
  const { data, error } = await db.rpc("finalize_catalog_file_audio_validation_job", {
    p_job_id: jobId,
    p_lease_owner: leaseOwner,
    p_profile_fingerprint: current.fingerprint,
    p_profile_probed_at: current.exactProfile.profileProbedAt,
    p_file_size_bytes: current.exactProfile.fileSizeBytes,
    p_expected_audio_indices: current.expectedAudioIndices,
  });
  if (error || !data) {
    throw new HttpError(409, "Strict language validation could not be finalized", {
      code: "LANGUAGE_VALIDATION_FINALIZE_FAILED",
    });
  }
  if (stringOr(claim.profileFingerprint, "") !== current.fingerprint) {
    throw new HttpError(409, "Exact language validation profile changed", {
      code: "LANGUAGE_VALIDATION_PROFILE_CHANGED",
    });
  }
}

async function failLanguageValidationJob(
  db: SupabaseClient,
  options: {
    jobId: string;
    leaseOwner: string;
    errorCode: string;
    terminal?: boolean;
    retryAt?: string | null;
  },
) {
  const retryAt = options.retryAt || new Date(
    Date.now() + LANGUAGE_VALIDATION_RETRY_SECONDS * 1000,
  ).toISOString();
  try {
    const { data, error } = await db.rpc("fail_catalog_file_audio_validation_job", {
      p_job_id: options.jobId,
      p_lease_owner: options.leaseOwner,
      p_error_code: options.errorCode,
      p_terminal: options.terminal === true,
      p_retry_at: retryAt,
    });
    return !error && data === true;
  } catch (_) {
    return false;
  }
}

async function cancelLanguageValidationJob(
  db: SupabaseClient,
  jobId: string,
  userId: string,
  errorCode: string,
) {
  try {
    const { data, error } = await db.rpc("cancel_catalog_file_audio_validation_job", {
      p_job_id: jobId,
      p_requested_by: userId,
      p_error_code: errorCode,
    });
    return !error && data === true;
  } catch (_) {
    return false;
  }
}

function languageValidationAccessWasRevoked(error: unknown) {
  return error instanceof HttpError && [401, 402, 403, 404].includes(error.status);
}

function languageValidationTaskErrorCode(error: unknown) {
  const details = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  return stringOr(details.code, "LANGUAGE_VALIDATION_TASK_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .slice(0, 64);
}

function languageValidationTaskErrorIsTerminal(error: unknown) {
  const code = languageValidationTaskErrorCode(error);
  return new Set([
    "LANGUAGE_VALIDATION_JOB_INVALID",
    "LANGUAGE_VALIDATION_PROFILE_CHANGED",
    "LANGUAGE_VALIDATION_IDENTITY_CHANGED",
    "LANGUAGE_VALIDATION_CURSOR_MISMATCH",
    "LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED",
    "LANGUAGE_VALIDATION_CODEC_AUDIO_INVALID",
    "LANGUAGE_VALIDATION_DURATION_INVALID",
    "LANGUAGE_VALIDATION_DURATION_TOO_SHORT",
    "LANGUAGE_VALIDATION_IDENTITY_REQUIRED",
    "LANGUAGE_VALIDATION_ACCESS_REVOKED",
  ]).has(code);
}

function languageValidationTaskRetryAt(error: unknown) {
  const code = languageValidationTaskErrorCode(error);
  const details = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  const blockedUntil = stringOrNull(details.blockedUntil);
  if (blockedUntil && Number.isFinite(Date.parse(blockedUntil))) return blockedUntil;
  if (code === "LANGUAGE_VALIDATION_PLAYBACK_ACTIVE" || code === "PROVIDER_ACCOUNT_BUSY") {
    return new Date(Date.now() + 15_000).toISOString();
  }
  if (code === "LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR") {
    return new Date(Date.now() + 30_000).toISOString();
  }
  if (languageValidationTaskErrorIsTerminal(error)) return new Date().toISOString();
  return null;
}

function languageValidationPendingResponse(options: {
  jobId: string;
  itemId: string;
  state: string;
  retryAt?: string | null;
  completedTracks?: number;
  trackCount?: number;
}) {
  const retryAtMs = options.retryAt ? Date.parse(options.retryAt) : Number.NaN;
  const retryAfter = Number.isFinite(retryAtMs) && retryAtMs > Date.now()
    ? Math.max(1, Math.min(300, Math.ceil((retryAtMs - Date.now()) / 1000)))
    : LANGUAGE_VALIDATION_POLL_SECONDS;
  return compactRecord({
    protocol: LANGUAGE_VALIDATION_PROTOCOL,
    jobId: options.jobId,
    itemType: "movie",
    itemId: options.itemId,
    status: "pending",
    state: options.state,
    retryAfter,
    retryAfterSeconds: retryAfter,
    retryAt: options.retryAt,
    completedTracks: options.completedTracks,
    trackCount: options.trackCount,
  });
}

function languageValidationFailedResponse(options: {
  jobId: string;
  itemId: string;
  errorCode: string;
  retryAt: string | null;
}) {
  return compactRecord({
    protocol: LANGUAGE_VALIDATION_PROTOCOL,
    jobId: options.jobId,
    itemType: "movie",
    itemId: options.itemId,
    status: "failed",
    errorCode: options.errorCode.replace(/[^A-Z0-9_]+/gi, "_").slice(0, 64),
    retryAt: options.retryAt,
  });
}

function languageValidationRejectedResponse(options: {
  itemId: string;
  errorCode: string;
  retryAt: string | null;
  retryAfterSeconds: number;
}) {
  const retryAfter = Math.max(1, Math.min(86_400, Math.trunc(options.retryAfterSeconds)));
  return compactRecord({
    protocol: LANGUAGE_VALIDATION_PROTOCOL,
    itemType: "movie",
    itemId: options.itemId,
    status: "failed",
    errorCode: options.errorCode.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").slice(0, 64),
    retryAfter,
    retryAfterSeconds: retryAfter,
    retryAt: options.retryAt && Number.isFinite(Date.parse(options.retryAt))
      ? options.retryAt
      : null,
  });
}

async function requireLanguageValidationEntitlement(userId: string, db: SupabaseClient) {
  const decision = await getEntitlementDecision(db, userId);
  if (!decision.allowed) throwEntitlementRequired("playback", decision);
  const limit = limitNumber(decision.limits, "concurrent_streams", 0);
  if (limit <= 0) {
    throwEntitlementRequired("concurrent_streams", decision, { limit, current: 0 });
  }
}

async function loadExactLanguageValidationProfile(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  itemId: string,
) {
  const { data, error } = await db
    .from("cloud_catalog_visible_title_variants")
    .select("id,codec_profile")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .eq("item_type", "movie")
    .eq("external_id", itemId)
    .limit(2);
  if (error) throwDb(error, "Unable to load the exact movie codec profile");
  if (!Array.isArray(data) || data.length !== 1) {
    throw new HttpError(404, "Exact movie variant not found");
  }
  const rawProfile = recordOrEmpty((data[0] as JsonRecord).codec_profile);
  if (!hasExactGatewayInbandVodProfile(rawProfile)) {
    throw new HttpError(409, "Exact movie codec profile is incomplete", {
      code: "LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED",
    });
  }
  const variantId = stringOr((data[0] as JsonRecord).id, "");
  return exactLanguageValidationProfileFromGateway(rawProfile, variantId, "movie");
}

function exactLanguageValidationProfileFromGateway(
  rawProfile: unknown,
  variantId: string,
  itemType: "movie" | "episode",
) {
  if (!hasExactGatewayInbandVodProfile(rawProfile)) {
    throw new HttpError(409, `Exact ${itemType} codec profile is incomplete`, {
      code: "LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED",
    });
  }
  const profile = normalizeCodecProfile(recordOrEmpty(rawProfile));
  const fileSizeBytes = Number(profile.fileSizeBytes);
  const profileProbedAt = stringOr(profile.probedAt, "");
  const audioTracks = (Array.isArray(profile.audioTracks) ? profile.audioTracks : [])
    .map((track) => recordOrEmpty(track));
  const indices = audioTracks.map((track) => Number(track.index));
  if (
    !audioTracks.length ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index > 128) ||
    new Set(indices).size !== indices.length
  ) {
    throw new HttpError(409, `Exact ${itemType} audio inventory is invalid`, {
      code: "LANGUAGE_VALIDATION_CODEC_AUDIO_INVALID",
    });
  }
  const subtitleTracks = (Array.isArray(profile.subtitles) ? profile.subtitles : [])
    .map((track) => recordOrEmpty(track));
  return {
    variantId,
    profile,
    profileProbedAt,
    fileSizeBytes,
    audioTracks,
    subtitleTracks,
    episodeCoordinates: null as JsonRecord | null,
  };
}

function exactLanguageValidationProfileFromSnapshot(
  rawProfile: unknown,
  variantId: string,
  itemType: "movie" | "episode",
) {
  // The durable job stores the intentionally minimized
  // vod_language_profile_snapshot(), not the complete Gateway codec profile.
  // Revalidate every field that participates in the strict fingerprint without
  // incorrectly requiring the omitted video/subtitle presentation fields.
  const profile = normalizeCodecProfile(recordOrEmpty(rawProfile));
  const fileSizeBytes = Number(profile.fileSizeBytes);
  const profileProbedAt = stringOr(profile.probedAt, "");
  const durationSeconds = Number(profile.durationSeconds);
  const probeSource = normalizeCodecToken(profile.probeSource);
  const container = normalizeCodecToken(profile.container);
  const canonicalContainer = canonicalVodContainer(profile.container);
  const audioTracks = (Array.isArray(profile.audioTracks) ? profile.audioTracks : [])
    .map((track) => recordOrEmpty(track));
  const indices = audioTracks.map((track) => Number(track.index));
  const exactGatewayProfile = probeSource === "gatewayinband"
    ? profile.metadataComplete === true
    : probeSource === "gatewayprobe";
  if (
    !exactGatewayProfile ||
    (!canonicalContainer && !container.includes("matroska") && !container.includes("webm")) ||
    !Number.isFinite(durationSeconds) || durationSeconds < 80 || durationSeconds > 86_400 ||
    !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0 ||
    !Number.isFinite(Date.parse(profileProbedAt)) ||
    !audioTracks.length ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index > 128) ||
    new Set(indices).size !== indices.length
  ) {
    throw new HttpError(409, `Exact ${itemType} validation snapshot is invalid`, {
      code: "LANGUAGE_VALIDATION_PROFILE_CHANGED",
    });
  }
  return {
    variantId,
    profile,
    profileProbedAt,
    fileSizeBytes,
    audioTracks,
    subtitleTracks: [] as JsonRecord[],
    episodeCoordinates: null as JsonRecord | null,
  };
}

async function loadExactEpisodeLanguageValidationProfile(
  db: SupabaseClient,
  jobId: string,
  userId: string,
  sourceId: string,
  itemId: string,
  variantId: string,
  identityKey: string,
) {
  // Episode profiles are exact-file Gateway observations captured in the
  // service-role-only durable job. Re-bind that snapshot to the canonical
  // episode membership on every worker attempt before minting a capability.
  const [
    { data: jobs, error: jobError },
    { data: memberships, error: membershipError },
    { data: activeParents, error: activeParentError },
  ] =
    await Promise.all([
      db.from("catalog_file_audio_validation_jobs")
        .select("id,requested_by,source_id,variant_id,identity_key,item_type,external_id,profile_snapshot")
        .eq("id", jobId)
        .eq("requested_by", userId)
        .eq("source_id", sourceId)
        .eq("variant_id", variantId)
        .eq("identity_key", identityKey)
        .eq("item_type", "episode")
        .eq("external_id", itemId)
        .limit(2),
      db.from("catalog_series_episode_memberships")
        .select("parent_variant_id,provider_identity_id,generation_id,parent_item_type,parent_series_id,episode_id,container_extension")
        .eq("user_id", userId)
        .eq("source_id", sourceId)
        .eq("parent_variant_id", variantId)
        .eq("episode_id", itemId)
        .limit(2),
      db.from("cloud_catalog_visible_title_variants")
        .select("id,generation_id")
        .eq("id", variantId)
        .eq("user_id", userId)
        .eq("source_id", sourceId)
        .eq("item_type", "series")
        .limit(2),
    ]);
  if (jobError) throwDb(jobError, "Unable to reload the episode validation profile");
  if (membershipError) throwDb(membershipError, "Unable to verify the exact episode membership");
  if (activeParentError) throwDb(activeParentError, "Unable to verify the active episode generation");
  if (!Array.isArray(jobs) || jobs.length !== 1) {
    throw new HttpError(409, "Exact episode validation job changed", {
      code: "LANGUAGE_VALIDATION_PROFILE_CHANGED",
    });
  }
  const membership = Array.isArray(memberships) && memberships.length === 1
    ? recordOrEmpty(memberships[0])
    : {};
  if (
    !Array.isArray(memberships) || memberships.length !== 1 ||
    !Array.isArray(activeParents) || activeParents.length !== 1 ||
    stringOr(membership.provider_identity_id, "") !== identityKey ||
    stringOr(membership.parent_item_type, "") !== "series" ||
    stringOr(membership.episode_id, "") !== itemId ||
    !stringOr(membership.parent_series_id, "") ||
    !stringOr(membership.container_extension, "") ||
    stringOr(membership.generation_id, "") !==
      stringOr((activeParents[0] as JsonRecord).generation_id, "")
  ) {
    throw new HttpError(409, "Exact episode membership changed", {
      code: "LANGUAGE_VALIDATION_ACCESS_REVOKED",
    });
  }
  return {
    ...exactLanguageValidationProfileFromSnapshot(
    (jobs[0] as JsonRecord).profile_snapshot,
    variantId,
    "episode",
    ),
    // Carry only coordinates re-bound above to the active parent generation
    // and provider identity. The worker must never ask series-info for a
    // representative episode: it validates exactly the queued episode file.
    episodeCoordinates: {
      episode_id: itemId,
      parent_series_id: stringOr(membership.parent_series_id, ""),
      container_extension: stringOr(membership.container_extension, ""),
    },
  };
}

function hasExactGatewayInbandVodProfile(value: unknown) {
  const raw = recordOrEmpty(value);
  if (!hasReliableVodCodecProfile(raw)) return false;
  const profile = normalizeCodecProfile(raw);
  const container = normalizeCodecToken(profile.container);
  const canonicalContainer = canonicalVodContainer(profile.container);
  const durationSeconds = Number(profile.durationSeconds);
  const fileSizeBytes = Number(profile.fileSizeBytes);
  const probeSource = normalizeCodecToken(profile.probeSource);
  const exactGatewayProfile = probeSource === "gatewayinband"
    ? profile.metadataComplete === true
    : probeSource === "gatewayprobe";
  return Boolean(
    exactGatewayProfile &&
    (canonicalContainer || container.includes("matroska") || container.includes("webm")) &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    Number.isSafeInteger(fileSizeBytes) &&
    fileSizeBytes > 0 &&
    Number.isFinite(Date.parse(stringOr(profile.probedAt, "")))
  );
}

function gatewayProvesRequestedAudioFallback(
  value: unknown,
  requestedAudioStreamIndex: number | null,
  actualAudioStreamIndex: number | null,
) {
  if (
    requestedAudioStreamIndex === null ||
    actualAudioStreamIndex === null ||
    requestedAudioStreamIndex === actualAudioStreamIndex ||
    !hasExactGatewayInbandVodProfile(value)
  ) {
    return false;
  }

  const profile = normalizeCodecProfile(recordOrEmpty(value));
  const tracks = Array.isArray(profile.audioTracks)
    ? profile.audioTracks.map((track) => recordOrEmpty(track))
    : [];
  const streamIndices = tracks.map((track) => Number(track.index));
  if (
    streamIndices.length < 1 ||
    streamIndices.some((index) => !Number.isInteger(index) || index < 0 || index > 1_024) ||
    new Set(streamIndices).size !== streamIndices.length
  ) {
    return false;
  }

  // A saved preference is file-local. If a current-file Gateway probe proves
  // that the old index is not an audio stream in this exact file, accepting
  // the Gateway's proven default is safer than deleting an otherwise healthy
  // HLS session. A real map drift remains fail-closed whenever the requested
  // index is present in the exact inventory.
  return !streamIndices.includes(requestedAudioStreamIndex) &&
    streamIndices.includes(actualAudioStreamIndex);
}

async function loadLanguageValidationIdentity(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
) {
  const { data, error } = await db
    .from("catalog_source_provider_identities")
    .select("identity_id")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load the provider identity");
  const identityKey = stringOr((data as JsonRecord | null)?.identity_id, "");
  if (!identityKey) {
    throw new HttpError(409, "Verified provider identity is required", {
      code: "LANGUAGE_VALIDATION_IDENTITY_REQUIRED",
    });
  }
  return identityKey;
}

async function loadLanguageValidationCache(
  db: SupabaseClient,
  identityKey: string,
  itemType: "movie" | "episode",
  itemId: string,
) {
  const { data, error } = await db
    .from("catalog_file_tracks")
    .select(
      "audio_tracks,audio_probed_at,audio_lang_verified_at,audio_lang_retry_at,audio_lang_verification",
    )
    .eq("server_host", identityKey)
    .eq("item_type", itemType)
    .eq("external_id", itemId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load the exact audio cache");
  return data as JsonRecord | null;
}

async function hasActiveLanguageValidationJob(
  db: SupabaseClient,
  identityKey: string,
  itemType: "movie" | "episode",
  itemId: string,
) {
  const { data, error } = await db
    .from("catalog_file_audio_validation_jobs")
    .select("id,state,queue_expires_at")
    .eq("identity_key", identityKey)
    .eq("item_type", itemType)
    .eq("external_id", itemId)
    .in("state", ["queued", "running", "retry_wait", "finalizing"])
    .limit(1);
  if (error) throwDb(error, "Unable to verify active language validation job");
  const nowMs = Date.now();
  return Boolean(data?.some((row) => {
    const job = recordOrEmpty(row);
    if (stringOr(job.state, "") !== "queued") return true;
    const queueExpiresAtMs = Date.parse(stringOr(job.queue_expires_at, ""));
    return !Number.isFinite(queueExpiresAtMs) || queueExpiresAtMs > nowMs;
  }));
}

function exactCachedAudioTracks(value: unknown, expectedIndices: number[]): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const tracks = value.map((track) => recordOrEmpty(track));
  const indices = tracks.map((track) => Number(track.index));
  if (
    indices.some((index) => !Number.isInteger(index)) ||
    new Set(indices).size !== indices.length ||
    !sameIntegerSet(indices, expectedIndices)
  ) {
    return null;
  }
  return tracks;
}

function cachedStrictLanguageValidation(
  cache: JsonRecord,
  expectedIndices: number[],
  expectedProfile: {
    profileFingerprint: string;
    profileProbedAt: string;
    fileSizeBytes: number;
  },
): StrictLanguageValidationEvidence[] | null {
  if (!cache.audio_lang_verified_at) return null;
  const provenance = recordOrEmpty(cache.audio_lang_verification);
  if (
    Number(provenance.protocol) !== LANGUAGE_VALIDATION_PROTOCOL ||
    stringOr(provenance.status, "") !== "verified" ||
    stringOr(provenance.method, "") !== LANGUAGE_VALIDATION_METHOD ||
    provenance.allTracksVerified !== true ||
    Number(provenance.trackCount) !== expectedIndices.length ||
    Number(provenance.minConsensus) < LANGUAGE_VALIDATION_MIN_SAMPLES ||
    stringOr(provenance.profileFingerprint, "") !== expectedProfile.profileFingerprint ||
    Number(provenance.fileSizeBytes) !== expectedProfile.fileSizeBytes ||
    Date.parse(stringOr(provenance.profileProbedAt, "")) !==
      Date.parse(expectedProfile.profileProbedAt)
  ) {
    return null;
  }
  const cachedTracks = exactCachedAudioTracks(cache.audio_tracks, expectedIndices);
  if (!cachedTracks) return null;
  const provenanceTracks = Array.isArray(provenance.tracks)
    ? (provenance.tracks as JsonRecord[])
    : [];
  const proofByIndex = new Map(
    provenanceTracks.map((track) => [Number(track.index), recordOrEmpty(track)]),
  );
  const result: StrictLanguageValidationEvidence[] = [];
  for (const track of cachedTracks) {
    const index = Number(track.index);
    const language = normalizeIsoLang(stringOrNull(track.lang ?? track.language));
    const proof = proofByIndex.get(index);
    if (!language || !proof) return null;
    const proofLanguage = normalizeIsoLang(stringOrNull(proof.language));
    const consensus = Number(proof.consensus);
    const sampleCount = Number(proof.sampleCount);
    const rejectedSpeechSampleCount = Number(proof.rejectedSpeechSampleCount);
    const minSampleProbability = Number(proof.minSampleProbability);
    const minSampleWordCount = Number(proof.minSampleWordCount);
    const minSampleUniqueWordCount = Number(proof.minSampleUniqueWordCount);
    if (
      proofLanguage !== language ||
      stringOr(proof.method, "") !== LANGUAGE_VALIDATION_METHOD ||
      !Number.isInteger(sampleCount) ||
      sampleCount < LANGUAGE_VALIDATION_MIN_SAMPLES ||
      consensus < LANGUAGE_VALIDATION_MIN_SAMPLES ||
      rejectedSpeechSampleCount !== 0 ||
      minSampleProbability < LANGUAGE_VALIDATION_MIN_PROBABILITY ||
      minSampleWordCount < LANGUAGE_VALIDATION_MIN_WORDS ||
      minSampleUniqueWordCount < LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS
    ) {
      return null;
    }
    result.push({
      index,
      language,
      method: LANGUAGE_VALIDATION_METHOD,
      consensus,
      sampleCount,
      rejectedSpeechSampleCount: 0,
      minSampleProbability,
      minSampleWordCount,
      minSampleUniqueWordCount,
    });
  }
  return result;
}

async function assertLanguageValidationIdle(
  db: SupabaseClient,
  userId: string,
  providerAccountHash: string,
  providerAccountKey: string,
) {
  const nowIso = new Date().toISOString();
  const { data: userSessions, error: userSessionError } = await db
    .from("cloud_playback_sessions")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["pending", "ready"])
    .gt("expires_at", nowIso)
    .limit(1);
  if (userSessionError) throwDb(userSessionError, "Unable to verify active playback sessions");
  if (userSessions?.length) {
    throw new HttpError(409, "Playback must be stopped before language validation", {
      code: "LANGUAGE_VALIDATION_PLAYBACK_ACTIVE",
    });
  }

  const { data: providerSessions, error: providerSessionError } = await db
    .from("cloud_playback_sessions")
    .select("id")
    .eq("provider_account_hash", providerAccountHash)
    .in("status", ["pending", "ready"])
    .gt("expires_at", nowIso)
    .limit(1);
  if (providerSessionError) {
    throwDb(providerSessionError, "Unable to verify provider playback sessions");
  }
  if (providerSessions?.length) {
    throw new HttpError(409, "Provider account is already in use", {
      code: "PROVIDER_ACCOUNT_BUSY",
    });
  }

  // norva-cloud deliberately marks every configured account as `presence` while
  // the authenticated app is open. Strict LID also reports
  // `language-validation` so generic background jobs keep yielding throughout
  // the provider read. This foreground-only reader ignores those two intents;
  // the account lease serializes LID with playback, while null/unknown and every
  // real fresh activity remain fail-closed. The writers give real activity
  // priority in the single-row ledger.
  const { data: providerBusy, error: providerBusyError } = await db.rpc(
    "provider_account_busy_for_foreground_validation",
    { p_key: providerAccountKey },
  );
  if (providerBusyError) {
    throwDb(providerBusyError, "Unable to verify provider availability");
  }
  if (providerBusy !== false) {
    throw new HttpError(409, "Provider account is already in use", {
      code: "PROVIDER_ACCOUNT_BUSY",
    });
  }
}

function languageValidationGatewayRetryAt(
  responseStatus: number,
  gatewayCode: string,
  upstreamStatus: number | null,
  nowMs = Date.now(),
) {
  if (
    !Number.isInteger(responseStatus) || responseStatus < 500 || responseStatus > 599 ||
    Number(upstreamStatus) === 407 ||
    String(gatewayCode || "").trim().toUpperCase() === "PROXY_AUTH_FAILED"
  ) {
    return null;
  }
  return new Date(nowMs + LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS).toISOString();
}

function strictLanguageValidationEvidence(
  payload: JsonRecord,
  index: number,
): StrictLanguageValidationEvidence | null {
  const language = normalizeIsoLang(stringOrNull(payload.language));
  const samples = Array.isArray(payload.samples)
    ? (payload.samples as JsonRecord[]).map((sample) => recordOrEmpty(sample))
    : [];
  const sampleCount = Number(payload.sampleCount);
  const consensus = Number(payload.consensus);
  const rejectedSpeechSampleCount = Number(payload.rejectedSpeechSampleCount);
  const minSampleProbability = Number(payload.minSampleProbability);
  const minSampleWordCount = Number(payload.minSampleWordCount);
  const minSampleUniqueWordCount = Number(payload.minSampleUniqueWordCount);
  const samplesValid = samples.length >= LANGUAGE_VALIDATION_MIN_SAMPLES && samples.every((sample) =>
    normalizeIsoLang(stringOrNull(sample.language)) === language &&
    Number(sample.probability) >= LANGUAGE_VALIDATION_MIN_PROBABILITY &&
    Number(sample.wordCount) >= LANGUAGE_VALIDATION_MIN_WORDS &&
    Number(sample.uniqueWordCount) >= LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS
  );
  if (
    payload.verified !== true ||
    stringOr(payload.validationStatus, "") !== "verified" ||
    stringOr(payload.method, "") !== LANGUAGE_VALIDATION_METHOD ||
    !language ||
    !Number.isInteger(sampleCount) ||
    sampleCount < LANGUAGE_VALIDATION_MIN_SAMPLES ||
    samples.length !== sampleCount ||
    consensus < LANGUAGE_VALIDATION_MIN_SAMPLES ||
    rejectedSpeechSampleCount !== 0 ||
    minSampleProbability < LANGUAGE_VALIDATION_MIN_PROBABILITY ||
    minSampleWordCount < LANGUAGE_VALIDATION_MIN_WORDS ||
    minSampleUniqueWordCount < LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS ||
    !samplesValid
  ) {
    return null;
  }
  return {
    index,
    language,
    method: LANGUAGE_VALIDATION_METHOD,
    consensus,
    sampleCount,
    rejectedSpeechSampleCount: 0,
    minSampleProbability,
    minSampleWordCount,
    minSampleUniqueWordCount,
  };
}

function languageValidationResponse(options: {
  itemId: string;
  audioTracks: StrictLanguageValidationEvidence[];
  verifiedAt: string | null;
  cached: boolean;
}) {
  return {
    protocol: LANGUAGE_VALIDATION_PROTOCOL,
    itemType: "movie",
    itemId: options.itemId,
    status: "verified",
    method: LANGUAGE_VALIDATION_METHOD,
    cached: options.cached,
    persisted: true,
    verifiedAt: options.verifiedAt,
    audioTracks: options.audioTracks,
  };
}

const MEDIA_CACHE_OBJECT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_CACHE_ROOT_PLAYLIST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const MEDIA_CACHE_IDENTITY_COMPONENT_KEYS = [
  "audio", "content", "duration", "pipeline", "segmenter", "size", "subtitles", "video",
];

function validatedMediaCacheWorkerUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return trimTrailingSlash(parsed.toString());
  } catch (_) {
    return null;
  }
}

function mediaCacheAssetUrl(baseUrl: string, objectKey: string, logicalPath: string): string {
  const encodedPath = logicalPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${baseUrl}/v1/hls/${objectKey}/${encodedPath}`;
}

function mediaCachePlaybackWorkerUrl(runtimeConfig: RuntimeConfig): string | null {
  const workerUrl = validatedMediaCacheWorkerUrl(runtimeConfig.mediaCacheWorkerUrl);
  if (!runtimeConfig.mediaCacheEnabled || !workerUrl
    || runtimeConfig.mediaCacheWorkerToken.length < 32
    || !/^[0-9a-f]{64}$/i.test(runtimeConfig.mediaCacheTicketHmacKey)) return null;
  return workerUrl;
}

async function createAuthorizedMediaCachePlayback(
  runtimeConfig: RuntimeConfig,
  playbackSessionId: string,
  authorizationValue: unknown,
) {
  const workerUrl = mediaCachePlaybackWorkerUrl(runtimeConfig);
  if (!workerUrl) {
    throw new HttpError(503, "Private media cache is unavailable", {
      code: "MEDIA_CACHE_DISABLED_OR_MISCONFIGURED",
    });
  }
  const authorization = recordOrEmpty(authorizationValue);
  const bindingId = stringOr(authorization.binding_id, "");
  const objectKey = stringOr(authorization.object_key, "");
  const rootPlaylist = stringOr(authorization.root_playlist, "");
  const ticketExpiresAt = stringOr(authorization.ticket_expires_at, "");
  const hardExpiresAt = stringOr(authorization.hard_expires_at, "");
  const ticketExpiresAtMs = Date.parse(ticketExpiresAt);
  const hardExpiresAtMs = Date.parse(hardExpiresAt);
  const nowMs = Date.now();
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)
    || !PLAYBACK_SESSION_UUID_PATTERN.test(bindingId)
    || !MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)
    || authorization.storage_backend !== "r2"
    || !MEDIA_CACHE_ROOT_PLAYLIST_PATTERN.test(rootPlaylist)
    || /(^|\/)\.{1,2}(\/|$)|\/\//.test(rootPlaylist)
    || !Number.isSafeInteger(ticketExpiresAtMs) || ticketExpiresAtMs <= nowMs + 5_000
    || !Number.isSafeInteger(hardExpiresAtMs) || hardExpiresAtMs < ticketExpiresAtMs) {
    throw new HttpError(503, "Private media cache authorization is invalid", {
      code: "MEDIA_CACHE_AUTHORIZATION_INVALID",
    });
  }

  const ticket = await createMediaCacheTicket(runtimeConfig.mediaCacheTicketHmacKey, {
    objectKey,
    bindingId,
    playbackSessionId,
    expiresAtMs: ticketExpiresAtMs,
  }, nowMs);
  const remainingMs = ticketExpiresAtMs - nowMs;
  const refreshAfterMs = Math.min(
    ticketExpiresAtMs - 5_000,
    nowMs + Math.max(5_000, Math.floor(remainingMs / 2)),
  );
  return {
    protocol: 1,
    transport: "private-r2-hls",
    objectKey,
    playlistUrl: mediaCacheAssetUrl(workerUrl, objectKey, rootPlaylist),
    authorization: { scheme: "Bearer", token: ticket },
    ticketExpiresAt,
    refreshAfter: new Date(refreshAfterMs).toISOString(),
    hardExpiresAt,
  };
}

async function issueMediaCachePlaybackTicket(
  req: Request,
  playbackSessionId: string,
  userId: string,
  db: SupabaseClient,
) {
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)) {
    throw new HttpError(400, "Invalid playback session id");
  }
  const body = await readJson(req);
  if (!exactJsonKeys(body, ["objectKey", "protocol"]) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid media cache ticket request");
  }
  const objectKey = stringOr(body.objectKey, "").toLowerCase();
  if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new HttpError(400, "Invalid media cache object key");
  }

  const runtimeConfig = await getRuntimeConfig(db);
  if (!mediaCachePlaybackWorkerUrl(runtimeConfig)) {
    throw new HttpError(503, "Private media cache is unavailable", {
      code: "MEDIA_CACHE_DISABLED_OR_MISCONFIGURED",
    });
  }

  const { data, error } = await db.rpc("norva_authorize_media_cache_playback", {
    p_playback_session_id: playbackSessionId,
    p_user_id: userId,
    p_object_key: objectKey,
    p_ticket_ttl_seconds: runtimeConfig.mediaCacheTicketTtlSeconds,
  });
  if (error) throwDb(error, "Unable to authorize private media cache playback");
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (rows.length !== 1) {
    throw new HttpError(403, "Private media cache access is unavailable", {
      code: "MEDIA_CACHE_ACCESS_DENIED",
    });
  }
  const authorization = recordOrEmpty(rows[0]);
  if (stringOr(authorization.object_key, "") !== objectKey) {
    throw new HttpError(503, "Private media cache authorization is invalid", {
      code: "MEDIA_CACHE_AUTHORIZATION_INVALID",
    });
  }
  return await createAuthorizedMediaCachePlayback(runtimeConfig, playbackSessionId, authorization);
}

async function revokeMediaCachePlaybackGrant(
  playbackSessionId: string,
  userId: string,
  db: SupabaseClient,
  runtimeConfig: RuntimeConfig,
) {
  const { data, error } = await db.rpc("norva_revoke_media_cache_playback_grant", {
    p_playback_session_id: playbackSessionId,
    p_user_id: userId,
  });
  if (error) throw error;
  if (data !== true) return { grantRevoked: false, workerRevoked: false };

  const workerUrl = validatedMediaCacheWorkerUrl(runtimeConfig.mediaCacheWorkerUrl);
  if (!workerUrl || runtimeConfig.mediaCacheWorkerToken.length < 32) {
    throw new Error("private media cache revocation route is unavailable");
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        `${workerUrl}/internal/v1/revocations/${encodeURIComponent(playbackSessionId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${runtimeConfig.mediaCacheWorkerToken}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error(`private media cache revocation returned ${response.status}`);
      await response.body?.cancel().catch(() => {});
      return { grantRevoked: true, workerRevoked: true };
    } catch (workerError) {
      lastError = workerError;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("private media cache revocation failed");
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
  return { session: publicPlaybackSession(data) };
}

async function heartbeatPlaybackSession(id: string, userId: string, db: SupabaseClient) {
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(id)) {
    throw new HttpError(400, "Invalid playback session id");
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .select("id,source_id,status,created_at,native_heartbeat_at,expires_at,superseded_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify playback session");
  if (!session) throw new HttpError(404, "Playback session unavailable");
  if (session.superseded_at) {
    throw new HttpError(409, "Playback session was replaced", {
      code: "PLAYBACK_SUPERSEDED",
    });
  }

  const status = stringOr(session.status, "");
  const sourceId = stringOrNull(session.source_id);
  const createdAt = stringOr(session.created_at, "");
  const policy = decideNativePlaybackHeartbeat({
    nowMs,
    status,
    createdAt,
    nativeHeartbeatAt: session.native_heartbeat_at,
    expiresAt: session.expires_at,
  });
  if (!sourceId || !policy.accepted) throw new HttpError(410, "Playback session is not active");

  // Once the first call establishes the native liveness chain, duplicate or
  // over-eager callbacks are acknowledged without another session/activity write.
  if (!policy.shouldWrite) return { ok: true };

  const graceCutoffIso = new Date(policy.graceCutoffMs).toISOString();
  const writeCutoffIso = new Date(policy.writeCutoffMs).toISOString();

  let renewalQuery = db
    .from("cloud_playback_sessions")
    .update({ native_heartbeat_at: nowIso })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .in("status", NATIVE_HEARTBEAT_ACTIVE_STATUSES)
    .gte("created_at", new Date(nowMs - NATIVE_HEARTBEAT_MAX_SESSION_AGE_SECONDS * 1000).toISOString())
    .lte("created_at", nowIso)
    .or(`expires_at.gt.${nowIso},native_heartbeat_at.gt.${graceCutoffIso}`);
  // The first heartbeat must establish its chain even when it arrives seconds
  // after session creation. Later calls are rate-limited; concurrent first calls
  // use an optimistic timestamp match so only one can write/touch activity.
  renewalQuery = policy.hasHeartbeatChain
    ? renewalQuery.lte("native_heartbeat_at", writeCutoffIso)
    : renewalQuery.is("native_heartbeat_at", null);
  const { data: renewed, error: renewalError } = await renewalQuery
    .select("id")
    .maybeSingle();
  if (renewalError) throwDb(renewalError, "Unable to renew playback session");

  // A concurrent heartbeat can win the conditional update. Revalidate before
  // acknowledging it; never resurrect or touch a session that expired/ended in
  // the race window.
  if (!renewed) {
    const { data: current, error: currentError } = await db
      .from("cloud_playback_sessions")
      .select("source_id,status,created_at,native_heartbeat_at,expires_at,superseded_at")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (currentError) throwDb(currentError, "Unable to recheck playback session");
    if (current?.superseded_at) {
      throw new HttpError(409, "Playback session was replaced", {
        code: "PLAYBACK_SUPERSEDED",
      });
    }
    const currentPolicy = current
      ? decideNativePlaybackHeartbeat({
        // Another request may have committed after this handler captured nowMs.
        // Revalidation uses a fresh clock so that successful concurrent pulse is
        // acknowledged rather than misclassified as a future timestamp.
        nowMs: Date.now(),
        status: current.status,
        createdAt: current.created_at,
        nativeHeartbeatAt: current.native_heartbeat_at,
        expiresAt: current.expires_at,
      })
      : null;
    if (stringOrNull(current?.source_id) !== sourceId || !currentPolicy?.accepted || currentPolicy.shouldWrite) {
      throw new HttpError(410, "Playback session is not active");
    }
    return { ok: true };
  }

  const { error: activityError } = await db.rpc("provider_account_touch_by_source", {
    p_source_id: sourceId,
    p_kind: "native-heartbeat",
  });
  if (activityError) throwDb(activityError, "Unable to refresh playback activity");

  return { ok: true };
}

async function requestDemandDrivenMediaCacheContinuation(
  db: SupabaseClient,
  runtimeConfig: RuntimeConfig,
  playbackSessionId: string,
  gatewaySessionId: string,
) {
  if (!runtimeConfig.mediaCacheSingleflightEnabled) return false;
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)
    || !PLAYBACK_SESSION_UUID_PATTERN.test(gatewaySessionId)) return false;
  const { data, error } = await db.rpc(
    "norva_request_media_cache_continuation_for_gateway",
    {
      p_playback_session_id: playbackSessionId,
      p_gateway_session_id: gatewaySessionId,
      p_ttl_seconds: MEDIA_CACHE_SINGLEFLIGHT_LEASE_TTL_SECONDS,
    },
  );
  if (error) {
    // Continuation is optional. A migration lag or database ambiguity must
    // close the provider session instead of leaving an ungoverned background
    // producer behind.
    return false;
  }
  return data === true;
}

async function requestDemandDrivenMediaCacheContinuationForLiveAttachment(
  db: SupabaseClient,
  runtimeConfig: RuntimeConfig,
  playbackSessionId: string,
  attachmentId: string,
) {
  if (!runtimeConfig.mediaCacheSingleflightEnabled) return false;
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)
    || !PLAYBACK_SESSION_UUID_PATTERN.test(attachmentId)) return false;
  const { data, error } = await db.rpc(
    "norva_request_media_cache_continuation_for_live_attachment",
    {
      p_playback_session_id: playbackSessionId,
      p_attachment_id: attachmentId,
      p_ttl_seconds: MEDIA_CACHE_SINGLEFLIGHT_LEASE_TTL_SECONDS,
    },
  );
  if (error) return false;
  return data === true;
}

async function expirePlaybackSession(id: string, userId: string, db: SupabaseClient) {
  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .select("*, cloud_gateway_sessions(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load playback session");
  if (!session) throw new HttpError(404, "Playback session not found");
  // The service-role client can distinguish a genuinely absent UUID from an
  // existing session owned by another account. Native close delivery treats a
  // 404 as an idempotent terminal success, so collapsing both cases would let
  // an account switch incorrectly acknowledge a provider session it did not
  // close. UUIDs are unguessable and ownership failures expose no row data.
  if (stringOr(session.user_id, "") !== userId) {
    throw new HttpError(403, "Playback session is not owned by this account");
  }

  const gatewaySessions = Array.isArray(session.cloud_gateway_sessions)
    ? session.cloud_gateway_sessions
    : [];
  const runtimeConfig = await getRuntimeConfig(db);
  const closedGatewayIds: string[] = [];
  const preservedGatewayDatabaseIds = new Set<string>();
  const gatewayErrors: unknown[] = [];
  const mediaCacheErrors: unknown[] = [];
  let rawPumpsAborted = 0;
  let fastStartProofPersisted = false;
  let mediaCacheGrantRevoked = false;
  let mediaCacheWorkerRevoked = false;

  // Revoke browser access before allowing any provider-backed continuation to
  // detach. The immutable shared object remains reusable by another authorized
  // session; only this playback session receives a strongly consistent marker.
  if (runtimeConfig.mediaCacheEnabled) {
    try {
      const revocation = await revokeMediaCachePlaybackGrant(id, userId, db, runtimeConfig);
      mediaCacheGrantRevoked = revocation.grantRevoked;
      mediaCacheWorkerRevoked = revocation.workerRevoked;
    } catch (mediaCacheError) {
      mediaCacheErrors.push(mediaCacheError);
      console.warn("[norva-playback] private media cache revocation failed");
    }
  }

  if (
    runtimeConfig.mediaGatewayRouting.defaultRoute ||
    runtimeConfig.mediaGatewayRouting.canaryRoute
  ) {
    // Direct/native sessions may have switched to their long-lived signed /raw
    // fallback. It has no cloud_gateway_sessions row, so explicitly abort its
    // active pump on normal exit instead of leaving a provider slot occupied.
    try {
      const rawGatewayRoute = await mediaGatewayRouteForPlaybackUser(runtimeConfig, userId);
      if (!rawGatewayRoute) throw new Error("MEDIA_GATEWAY_ROUTE_UNAVAILABLE");
      const ownerKey = await sha256Hex(userId);
      const rawUrl = new URL(`${rawGatewayRoute.url}/raw-pumps`);
      rawUrl.searchParams.set("ownerKey", ownerKey);
      rawUrl.searchParams.set("sid", id);
      const rawResponse = await fetch(rawUrl.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${rawGatewayRoute.token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!rawResponse.ok && rawResponse.status !== 404) {
        const body = await rawResponse.text().catch(() => "");
        throw new HttpError(rawResponse.status, "Media gateway refused raw-pump expiry", body);
      }
      const rawResult = await rawResponse.json().catch(() => ({} as JsonRecord));
      rawPumpsAborted = boundedInt((rawResult as JsonRecord).aborted, 0, 0, 1000);
    } catch (rawError) {
      gatewayErrors.push(rawError);
    }

    await Promise.allSettled(gatewaySessions.map(async (gateway: JsonRecord) => {
      const externalSessionId = stringOrNull(gateway.external_session_id);
      if (!externalSessionId) return;
      const storedGatewayRoute = mediaGatewayRouteForStoredSession(runtimeConfig, gateway);
      if (!storedGatewayRoute) {
        throw new HttpError(503, "Stored media gateway route is unavailable", {
          code: "MEDIA_GATEWAY_STORED_ROUTE_UNAVAILABLE",
        });
      }

      const liveAttachmentId = stringOrNull(gateway.media_cache_live_attachment_id);
      const cleanupUrl = new URL(liveAttachmentId
        ? `${storedGatewayRoute.url}/sessions/${encodeURIComponent(externalSessionId)}` +
          `/viewers/${encodeURIComponent(liveAttachmentId)}`
        : `${storedGatewayRoute.url}/sessions/${encodeURIComponent(externalSessionId)}`);
      // Detach only when the distributed lease still has a waiting viewer.
      // This server-side transition marks the lease as background-preemptable;
      // a browser cannot request continuation and an idle asset is never filled.
      const continueMediaCache = liveAttachmentId
        ? await requestDemandDrivenMediaCacheContinuationForLiveAttachment(
          db,
          runtimeConfig,
          id,
          liveAttachmentId,
        )
        : await requestDemandDrivenMediaCacheContinuation(
          db,
          runtimeConfig,
          id,
          externalSessionId,
        );
      if (liveAttachmentId) cleanupUrl.searchParams.set("playbackSessionId", id);
      if (continueMediaCache) cleanupUrl.searchParams.set("completeCache", "continue");
      const response = await fetch(cleanupUrl.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${storedGatewayRoute.token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        throw new HttpError(response.status, "Media gateway refused session expiry", body);
      }
      const cleanupBody = response.ok
        ? await response.json().catch(() => ({} as JsonRecord))
        : ({} as JsonRecord);
      const continuationState = stringOrNull(
        recordOrEmpty(
          cleanupBody.completeCacheContinuation ?? cleanupBody.complete_cache_continuation,
        ).state,
      );
      const gatewayDatabaseId = stringOrNull(gateway.id);
      if (
        !liveAttachmentId &&
        response.status === 202 &&
        ["joined", "running"].includes(stringOr(continuationState, "")) &&
        gatewayDatabaseId
      ) {
        preservedGatewayDatabaseIds.add(gatewayDatabaseId);
      }
      if (liveAttachmentId) {
        const { error: finalizeError } = await db.rpc(
          "norva_finalize_media_cache_live_attachment_release",
          {
            p_playback_session_id: id,
            p_user_id: userId,
            p_attachment_id: liveAttachmentId,
          },
        );
        if (finalizeError) throw finalizeError;
      }
      const finalCodecProfile = normalizeCodecProfile(recordOrEmpty(
        cleanupBody.finalCodecProfile ?? cleanupBody.final_codec_profile,
      ));
      const finalProof = normalizeMkvH264FastStartProof(finalCodecProfile.mkvH264FastStartProof);
      const finalCompleteCacheProof = normalizeMkvH264FastStartProof(
        finalCodecProfile.mkvCompleteHlsCacheProof,
      );
      if (
        hasUsefulCodecProfile(finalCodecProfile) && stringOr(session.item_type, "") === "movie" &&
        stringOrNull(session.source_id) && stringOrNull(session.item_id)
      ) {
        const persisted = await persistObservedCodecProfile(db, {
          userId,
          sourceId: String(session.source_id),
          itemType: "movie",
          itemId: String(session.item_id),
          codecProfile: finalCodecProfile,
          startupMs: null,
          audioMode: null,
          requireItemCas: true,
          expectedItemCas: mkvH264FastStartItemCasFromPlaybackSession(session),
          allowProofReplacement: Boolean(finalProof || finalCompleteCacheProof),
        });
        fastStartProofPersisted = fastStartProofPersisted || persisted;
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
    providerAccountHash: stringOrNull(session.provider_account_hash),
    playbackSessionId: id,
    gatewaySessionId: gatewaySessions
      .map((gateway: JsonRecord) => stringOrNull(gateway.external_session_id))
      .find(Boolean) ?? null,
  }, db);

  if (gatewaySessions.length) {
    const gatewayIds = gatewaySessions
      .map((gateway: JsonRecord) => stringOrNull(gateway.id))
      .filter((gatewayId: string | null): gatewayId is string => (
        Boolean(gatewayId) && !preservedGatewayDatabaseIds.has(String(gatewayId))
      ));
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
    .select(PLAYBACK_SESSION_PUBLIC_SELECT)
    .single();
  if (updateError) throwDb(updateError, "Unable to expire playback session");

  return {
    session: publicPlaybackSession(expired),
    gatewayClosed: closedGatewayIds.length,
    rawPumpsAborted,
    fastStartProofPersisted,
    gatewayErrors: gatewayErrors.length,
    mediaCacheGrantRevoked,
    mediaCacheWorkerRevoked,
    mediaCacheErrors: mediaCacheErrors.length,
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
    .select(PLAYBACK_EVENT_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to record playback event");

  // Account busy-lock writer: any playback event (zap, first frame, error, ended) means the
  // provider account was just being used — refresh its activity signal. Best-effort.
  await touchProviderAccountBySource(db, sourceId, "event");

  if (sourceId && ttff && (eventType === "first_frame" || eventType === "play_started")) {
    await recordPlaybackStartupObservation(db, { userId, sourceId, itemType, itemId, startupMs: ttff });
  }
  if (playbackSessionId && ttff && eventType === "first_frame") {
    runBackground((async () => {
      const { data: grant } = await db
        .from("media_cache_playback_grants")
        .select("object_key")
        .eq("playback_session_id", playbackSessionId)
        .eq("user_id", userId)
        .is("revoked_at", null)
        .maybeSingle();
      const objectKey = stringOr(grant?.object_key, "").toLowerCase();
      if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)) return;
      const { data: object } = await db
        .from("media_cache_objects")
        .select("file_size_bytes,duration_milliseconds")
        .eq("object_key", objectKey)
        .maybeSingle();
      await db.rpc("norva_record_media_cache_metric", {
        p_metric: "first_image_ms", p_value: ttff, p_samples: 1,
        p_layer: "l2", p_market_region: "global", p_route_slot: "none",
        p_route_protocol: "none", p_outcome: "hit", p_score: null, p_confidence: null,
      });
      const fileSizeBytes = Number(object?.file_size_bytes || 0);
      const durationMilliseconds = Number(object?.duration_milliseconds || 0);
      if (Number.isSafeInteger(fileSizeBytes) && fileSizeBytes > 0) {
        await db.rpc("norva_record_media_cache_metric", {
          p_metric: "ffmpeg_bytes_avoided", p_value: fileSizeBytes, p_samples: 1,
          p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
          p_route_protocol: "none", p_outcome: "hit", p_score: null, p_confidence: null,
        });
      }
      if (Number.isSafeInteger(durationMilliseconds) && durationMilliseconds > 0) {
        await db.rpc("norva_record_media_cache_metric", {
          p_metric: "ffmpeg_seconds_avoided", p_value: Math.round(durationMilliseconds / 1000),
          p_samples: 1, p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
          p_route_protocol: "none", p_outcome: "hit", p_score: null, p_confidence: null,
        });
      }
    })());
  }
  return { event: sanitizePlaybackEvent(data) };
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
    .select("id,playback_session_id,gateway_id,external_session_id,status,media_cache_live_attachment_id,media_cache_lease_token")
    .eq("user_id", userId)
    .in("status", ["pending", "starting", "ready"]);
  if (error) {
    console.warn("[norva-playback] unable to list open gateway sessions", error.message);
    return 0;
  }
  if (!gatewaySessions?.length) return 0;

  const runtimeConfig = await getRuntimeConfig(db);
  const preservedGatewayDatabaseIds = new Set<string>();
  const playbackSessionIds = gatewaySessions
    .map((gateway: JsonRecord) => stringOrNull(gateway.playback_session_id))
    .filter((sessionId: string | null): sessionId is string => Boolean(sessionId));

  const playbackSessionsById = new Map<string, JsonRecord>();
  if (playbackSessionIds.length) {
    const { data: playbackSessions, error: playbackLoadError } = await db
      .from("cloud_playback_sessions")
      .select("id,user_id,source_id,item_type,item_id,target_url_hash,playback_hint")
      .eq("user_id", userId)
      .in("id", playbackSessionIds);
    if (playbackLoadError) {
      console.warn("[norva-playback] unable to load cleanup playback identities", playbackLoadError.message);
    } else {
      for (const playbackSession of playbackSessions ?? []) {
        const playbackSessionId = stringOrNull(playbackSession.id);
        if (playbackSessionId) playbackSessionsById.set(playbackSessionId, playbackSession as JsonRecord);
      }
    }
  }

  if (
    runtimeConfig.mediaGatewayRouting.defaultRoute ||
    runtimeConfig.mediaGatewayRouting.canaryRoute
  ) {
    const cleanupGatewaySession = async (gateway: JsonRecord) => {
      const externalSessionId = stringOrNull(gateway.external_session_id);
      if (!externalSessionId) return;
      const storedGatewayRoute = mediaGatewayRouteForStoredSession(runtimeConfig, gateway);
      if (!storedGatewayRoute) {
        console.warn("[norva-playback] stored gateway cleanup route unavailable");
        return;
      }
      const playbackSessionId = stringOrNull(gateway.playback_session_id);
      const liveAttachmentId = stringOrNull(gateway.media_cache_live_attachment_id);
      const cleanupUrl = new URL(liveAttachmentId
        ? `${storedGatewayRoute.url}/sessions/${encodeURIComponent(externalSessionId)}` +
          `/viewers/${encodeURIComponent(liveAttachmentId)}`
        : `${storedGatewayRoute.url}/sessions/${encodeURIComponent(externalSessionId)}`);
      const continueMediaCache = playbackSessionId
        ? (liveAttachmentId
          ? await requestDemandDrivenMediaCacheContinuationForLiveAttachment(
            db, runtimeConfig, playbackSessionId, liveAttachmentId,
          )
          : await requestDemandDrivenMediaCacheContinuation(
            db, runtimeConfig, playbackSessionId, externalSessionId,
          ))
        : false;
      if (liveAttachmentId && playbackSessionId) {
        cleanupUrl.searchParams.set("playbackSessionId", playbackSessionId);
      }
      if (continueMediaCache) cleanupUrl.searchParams.set("completeCache", "continue");
      const response = await fetch(cleanupUrl.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${storedGatewayRoute.token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok && response.status !== 404) {
        console.warn("[norva-playback] gateway cleanup refused", response.status, await response.text().catch(() => ""));
        return;
      }
      if (response.ok) {
        const cleanupBody = await response.json().catch(() => ({} as JsonRecord));
        const continuationState = stringOrNull(recordOrEmpty(
          cleanupBody.completeCacheContinuation ?? cleanupBody.complete_cache_continuation,
        ).state);
        const gatewayDatabaseId = stringOrNull(gateway.id);
        if (
          !liveAttachmentId && response.status === 202 &&
          ["joined", "running"].includes(stringOr(continuationState, "")) &&
          gatewayDatabaseId
        ) preservedGatewayDatabaseIds.add(gatewayDatabaseId);
        if (liveAttachmentId && playbackSessionId) {
          const { error: finalizeError } = await db.rpc(
            "norva_finalize_media_cache_live_attachment_release",
            {
              p_playback_session_id: playbackSessionId,
              p_user_id: userId,
              p_attachment_id: liveAttachmentId,
            },
          );
          if (finalizeError) {
            console.warn("[norva-playback] live attachment finalization failed");
          }
        }
        const finalCodecProfile = normalizeCodecProfile(recordOrEmpty(
          cleanupBody.finalCodecProfile ?? cleanupBody.final_codec_profile,
        ));
        const finalProof = normalizeMkvH264FastStartProof(finalCodecProfile.mkvH264FastStartProof);
        const finalCompleteCacheProof = normalizeMkvH264FastStartProof(
          finalCodecProfile.mkvCompleteHlsCacheProof,
        );
        const playbackSession = playbackSessionId ? playbackSessionsById.get(playbackSessionId) : null;
        if (
          hasUsefulCodecProfile(finalCodecProfile) && playbackSession && stringOr(playbackSession.item_type, "") === "movie" &&
          stringOrNull(playbackSession.source_id) && stringOrNull(playbackSession.item_id)
        ) {
          await persistObservedCodecProfile(db, {
            userId,
            sourceId: String(playbackSession.source_id),
            itemType: "movie",
            itemId: String(playbackSession.item_id),
            codecProfile: finalCodecProfile,
            startupMs: null,
            audioMode: null,
            requireItemCas: true,
            expectedItemCas: mkvH264FastStartItemCasFromPlaybackSession(playbackSession),
            allowProofReplacement: Boolean(finalProof || finalCompleteCacheProof),
          });
        }
      }
    };

    // A same-account retry can temporarily own both a viewer attachment and
    // the producer row. Detach viewers first: otherwise a concurrent producer
    // DELETE may answer `joined`, get preserved in Postgres, then lose its last
    // viewer milliseconds later and stop, leaving a stale ready row behind.
    const liveAttachmentGatewaySessions = gatewaySessions.filter(
      (gateway: JsonRecord) => Boolean(stringOrNull(gateway.media_cache_live_attachment_id)),
    );
    const producerGatewaySessions = gatewaySessions.filter(
      (gateway: JsonRecord) => !stringOrNull(gateway.media_cache_live_attachment_id),
    );
    await Promise.allSettled(liveAttachmentGatewaySessions.map(cleanupGatewaySession));
    await Promise.allSettled(producerGatewaySessions.map(cleanupGatewaySession));
  }

  const now = new Date().toISOString();
  const gatewayIds = gatewaySessions
    .map((gateway: JsonRecord) => stringOrNull(gateway.id))
    .filter((gatewayId: string | null): gatewayId is string => (
      Boolean(gatewayId) && !preservedGatewayDatabaseIds.has(String(gatewayId))
    ));
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
    providerAccountHash: string;
    itemType: string;
    itemId: string;
    targetUrlHash: string;
    playbackCreatedAt: string;
    supersededSessionIds: string[];
    expiresAt: string;
  },
  db: SupabaseClient,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) return null;

  const ownerKey = await sha256Hex(options.userId);
  const sourceKey = options.sourceId ? await sha256Hex(options.sourceId) : "account";
  const deviceKey = options.deviceId ? await sha256Hex(options.deviceId) : "";
  const coord = await hmacBase64Url(
    runtimeConfig.relayTokenSecret,
    `provider-account:${options.providerAccountHash}`,
  );
  const body = compactRecord({
    coord,
    ownerKey,
    sourceKey,
    deviceKey,
    itemType: options.itemType,
    itemId: options.itemId,
    targetHash: options.targetUrlHash,
    playbackCreatedAt: options.playbackCreatedAt,
    supersededSessionIds: options.supersededSessionIds,
    expiresAt: options.expiresAt,
    lockTtlMs: EDGE_SESSION_COORDINATOR_LOCK_TTL_MS,
  });

  const payload = await requestEdgeCoordinator(runtimeConfig, "/sessions/prepare", body);
  if (!payload?.ok) return null;

  return {
    runtimeConfig,
    coord,
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
    playbackCreatedAt: string;
    supersededSessionIds: string[];
    expiresAt: string;
  },
) {
  if (!coordination?.runtimeConfig || !coordination.lockId) return null;
  const payload = await requestEdgeCoordinator(coordination.runtimeConfig, "/sessions/start", compactRecord({
    lockId: coordination.lockId,
    coord: coordination.coord,
    ownerKey: coordination.ownerKey,
    sourceKey: coordination.sourceKey,
    deviceKey: coordination.deviceKey,
    playbackSessionId: options.playbackSessionId,
    gatewaySessionId: options.gatewaySessionId,
    lane: options.lane,
    itemType: options.itemType,
    itemId: options.itemId,
    targetHash: options.targetUrlHash,
    playbackCreatedAt: options.playbackCreatedAt,
    supersededSessionIds: options.supersededSessionIds,
    expiresAt: options.expiresAt,
  }));
  return payload?.ok === true
    ? { ok: true, waitMs: boundedInt(payload.waitMs, 0, 0, 15_000) }
    : null;
}

async function abortEdgeSessionCoordinator(coordination: Awaited<ReturnType<typeof prepareEdgeSessionCoordinator>>) {
  if (!coordination?.runtimeConfig || !coordination.lockId) return;
  await requestEdgeCoordinator(coordination.runtimeConfig, "/sessions/abort", {
    lockId: coordination.lockId,
    coord: coordination.coord,
    ownerKey: coordination.ownerKey,
    sourceKey: coordination.sourceKey,
  });
}

async function rollbackEdgeSessionCoordinator(
  coordination: Awaited<ReturnType<typeof prepareEdgeSessionCoordinator>>,
  options: { playbackSessionId: string; gatewaySessionId: string | null },
) {
  if (!coordination?.runtimeConfig || !coordination.lockId) return;
  // /sessions/start can commit durably even when its response is lost. End the
  // exact generation before aborting the prepare lock so that an ambiguous
  // response cannot leave a coordinator record behind.
  if (options.gatewaySessionId) {
    await requestEdgeCoordinator(coordination.runtimeConfig, "/sessions/end", compactRecord({
      coord: coordination.coord,
      ownerKey: coordination.ownerKey,
      sourceKey: coordination.sourceKey,
      playbackSessionId: options.playbackSessionId,
      gatewaySessionId: options.gatewaySessionId,
    }));
  }
  await abortEdgeSessionCoordinator(coordination);
}

async function endEdgeSessionCoordinator(
  options: {
    userId: string;
    sourceId: string | null;
    providerAccountHash: string | null;
    playbackSessionId: string;
    gatewaySessionId: string | null;
  },
  db: SupabaseClient,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) return;
  const coord = options.providerAccountHash
    ? await hmacBase64Url(
      runtimeConfig.relayTokenSecret,
      `provider-account:${options.providerAccountHash}`,
    )
    : null;
  await requestEdgeCoordinator(runtimeConfig, "/sessions/end", compactRecord({
    coord,
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
      signal: AbortSignal.timeout(8_000),
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
const sourceIdentityCache = new Map<string, {
  host: string;
  key: string;
  fingerprint: string;
  configRevision: string;
}>();
async function resolveSourceIdentity(sourceId: string, userId: string, db: SupabaseClient): Promise<{ host: string; key: string; fingerprint: string }> {
  const cacheKey = `${userId}:${sourceId}`;
  const { data } = await db
    .from("cloud_catalog_visible_sources")
    .select("config_hint,config_revision")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    sourceIdentityCache.delete(cacheKey);
    const key = `source:${sourceId}`;
    return { host: "", key, fingerprint: key };
  }
  const configRevision = String(data.config_revision ?? "");
  const cached = sourceIdentityCache.get(cacheKey);
  if (cached !== undefined && cached.configRevision === configRevision) return cached;
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
  const identity = { host, key, fingerprint: providerKey || key, configRevision };
  if (identityId) sourceIdentityCache.set(cacheKey, identity);
  else sourceIdentityCache.delete(cacheKey);
  return identity;
}
// catalog_media_items keying stays on the hostname (its writer writes the hostname;
// re-keying it on providerKey is a scoped follow-up — see the dedup doc).
async function resolveSourceHost(sourceId: string, userId: string, db: SupabaseClient): Promise<string> {
  return (await resolveSourceIdentity(sourceId, userId, db)).host;
}

async function resolveObservedVodContainer(
  sourceId: string,
  userId: string,
  itemType: string,
  itemId: string,
  db: SupabaseClient,
): Promise<{ container: string; evidenceKind: string; prefixSha256: string } | null> {
  if (!sourceId || !userId || !["movie", "series"].includes(itemType) || !itemId) return null;
  try {
    const serverHost = await resolveSourceHost(sourceId, userId, db);
    if (!serverHost) return null;
    const { data, error } = await db
      .from("catalog_file_container_observations")
      .select("observed_container,evidence_kind,prefix_sha256")
      .eq("server_host", serverHost)
      .eq("item_type", itemType)
      .eq("external_id", itemId)
      .maybeSingle();
    if (error) return null;
    const row = recordOrEmpty(data);
    const container = canonicalVodContainer(row.observed_container);
    const evidenceKind = stringOr(row.evidence_kind, "");
    const prefixSha256 = stringOr(row.prefix_sha256, "").toLowerCase();
    if (
      !container ||
      evidenceKind !== containerEvidenceKind(container) ||
      !/^[0-9a-f]{64}$/.test(prefixSha256)
    ) return null;
    return { container, evidenceKind, prefixSha256 };
  } catch (_) {
    // Rolling deployment: playback remains available before the additive
    // observation table is migrated.
    return null;
  }
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

async function resolveCatalogSeriesEpisodeCoordinates(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  parentSeriesId: string,
  episodeId: string,
): Promise<JsonRecord | null> {
  try {
    const { data, error } = await db.rpc("catalog_series_episode_coordinates_by_episode", {
      p_user_id: userId,
      p_source_id: sourceId,
      p_episode_id: episodeId,
    });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
    if (
      !row
      || stringOr(row.user_id, "") !== userId
      || stringOr(row.source_id, "") !== sourceId
      || stringOr(row.episode_id, "") !== episodeId
      || !stringOr(row.title_id, "")
      || !stringOr(row.variant_id, "")
      || !stringOr(row.server_host, "")
    ) {
      return null;
    }
    if (parentSeriesId && stringOr(row.parent_series_id, "") !== parentSeriesId) {
      throw new HttpError(409, "Episode does not belong to the requested parent series");
    }
    return row;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Rolling-deploy safety: playback remains available before the exact episode
    // registry migration lands, but no episode cache/fanout is trusted.
    return null;
  }
}

async function resolveExactEpisodePlaybackTarget(
  sourceId: string,
  userId: string,
  episodeCoordinates: JsonRecord,
  requestHint: JsonRecord,
  db: SupabaseClient,
) {
  const episodeId = stringOr(episodeCoordinates.episode_id, "");
  const containerObservation = await resolveObservedVodContainer(
    sourceId,
    userId,
    "series",
    episodeId,
    db,
  );
  const container = containerObservation?.container ?? stringOr(episodeCoordinates.container_extension, "mp4");
  if (!episodeId || !container) {
    throw new HttpError(404, "Exact episode coordinates are incomplete");
  }
  const sourceConfig = await loadSourceConfig(sourceId, userId, db);
  return {
    targetUrl: xtreamStreamUrl({
      serverUrl: stringOr(sourceConfig.serverUrl, ""),
      username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
        ? sourceConfig.username : "",
      password: typeof sourceConfig.password === "string" && sourceConfig.password.length
        ? sourceConfig.password : "",
      streamType: "series",
      streamId: episodeId,
      container,
    }),
    playbackHint: mergePlaybackHints(recordOrEmpty(requestHint), {
      container,
      streamType: "series",
      itemType: "series",
      audioSeriesId: stringOr(episodeCoordinates.parent_series_id, ""),
    }),
    containerObservation,
  };
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
  let ownedItem: {
    id?: unknown;
    updated_at?: unknown;
    playback_hint?: unknown;
    metadata?: unknown;
  } | null = null;
  const containerObservation = await resolveObservedVodContainer(
    sourceId,
    userId,
    itemType,
    itemId,
    db,
  );
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
  if (!item || mediaReadFromCatalog()) {
    const { data, error } = await db
      .from("cloud_catalog_visible_media_items")
      .select("id,updated_at,playback_hint,metadata")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .eq("external_id", itemId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to resolve playback item");
    ownedItem = data;
    if (!item) item = data;
  }
  if (!item) {
    if (itemType === "series") {
      const sourceConfig = await loadSourceConfig(sourceId, userId, db);
      const requestContainer = containerObservation?.container ?? stringOr(requestHint.container, "mp4");
      return {
        targetUrl: xtreamStreamUrl({
          serverUrl: stringOr(sourceConfig.serverUrl, ""),
          username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
            ? sourceConfig.username : "",
          password: typeof sourceConfig.password === "string" && sourceConfig.password.length
            ? sourceConfig.password : "",
          streamType: "series",
          streamId: itemId,
          container: requestContainer,
        }),
        playbackHint: mergePlaybackHints(recordOrEmpty(requestHint), compactRecord({
          container: requestContainer,
          streamType: "series",
          itemType: "series",
        })),
        containerObservation,
      };
    }
    throw new HttpError(404, "Media item not found");
  }

  const hint = recordOrEmpty(item.playback_hint);
  const metadata = recordOrEmpty(item.metadata);
  const catalogueCodecProfile = firstUsefulCodecProfile(
    hint.codecProfile,
    hint.codec_profile,
    metadata.codecProfile,
    metadata.codec_profile,
  );
  const ownedHint = recordOrEmpty(ownedItem?.playback_hint);
  const ownedMetadata = recordOrEmpty(ownedItem?.metadata);
  const ownedCodecProfile = firstUsefulCodecProfile(
    ownedHint.codecProfile,
    ownedHint.codec_profile,
    ownedMetadata.codecProfile,
    ownedMetadata.codec_profile,
  );
  const ownedFastStartProof = normalizeMkvH264FastStartProof(
    ownedCodecProfile.mkvH264FastStartProof ?? ownedCodecProfile.mkv_h264_fast_start_proof,
  );
  const ownedCompleteHlsCacheProof = normalizeMkvH264FastStartProof(
    ownedCodecProfile.mkvCompleteHlsCacheProof ?? ownedCodecProfile.mkv_complete_hls_cache_proof,
  );
  // Playback-produced codec evidence is stored on the exact variant row. The
  // per-item and global catalogue mirrors may legitimately lag that row, as
  // happened for Amar (catalogue MP4, exact Gateway probe AVI/MPEG-4/AC-3).
  // Load only the authenticated owner's exact file tuple and accept it as
  // routing authority only when the full reliable profile contract holds.
  let exactVariantCodecProfile: JsonRecord = {};
  if (itemType === "movie") {
    const { data: variants, error: variantError } = await db
      .from("cloud_catalog_visible_title_variants")
      .select("codec_profile")
      .eq("user_id", userId)
      .eq("source_id", sourceId)
      .eq("item_type", "movie")
      .eq("external_id", itemId)
      .limit(2);
    if (variantError) {
      console.warn("[norva-playback] unable to load exact playback variant profile", variantError.message);
    } else if (Array.isArray(variants) && variants.length === 1) {
      const candidate = firstUsefulCodecProfile((variants[0] as JsonRecord).codec_profile);
      if (hasReliableVodCodecProfile(candidate)) exactVariantCodecProfile = candidate;
    }
  }
  // The global catalogue mirror may lag a playback-produced proof. Prefer the
  // owned row only when it carries that bounded server observation; otherwise
  // keep the normal mirror-first profile choice unchanged.
  const storedCodecProfile = hasReliableVodCodecProfile(exactVariantCodecProfile)
    ? exactVariantCodecProfile
    : (containerObservation && hasUsefulCodecProfile(ownedCodecProfile))
    ? ownedCodecProfile
    : (ownedFastStartProof || ownedCompleteHlsCacheProof)
    ? ownedCodecProfile
    : catalogueCodecProfile;
  const storedPlaybackHintBase = mergePlaybackHints(
    compactRecord({
      ...hint,
      codecProfile: storedCodecProfile,
    }),
    {},
  );
  const storedPlaybackHint = containerObservation
    ? playbackHintForObservedContainer(storedPlaybackHintBase, containerObservation.container)
    : storedPlaybackHintBase;
  const itemCas = stringOrNull(ownedItem?.id) && stringOrNull(ownedItem?.updated_at)
    ? {
      id: String(ownedItem?.id),
      updatedAt: String(ownedItem?.updated_at),
    }
    : null;
  if (hint.sourceType === "xtream") {
    const sourceConfig = await loadSourceConfig(sourceId, userId, db);
    const requestContainer = stringOrNull(requestHint.container);
    const streamType = stringOr(hint.streamType, "live");
    const container = containerObservation?.container ?? xtreamPlaybackContainer(hint, streamType, requestContainer);
    return {
      targetUrl: xtreamStreamUrl({
        serverUrl: stringOr(sourceConfig.serverUrl, ""),
        username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
          ? sourceConfig.username : "",
        password: typeof sourceConfig.password === "string" && sourceConfig.password.length
          ? sourceConfig.password : "",
        streamType,
        streamId: stringOr(hint.streamId, ""),
        container,
      }),
      playbackHint: mergePlaybackHints(storedPlaybackHint, compactRecord({ container })),
      itemCas,
      containerObservation,
    };
  }

  if (typeof hint.targetUrl === "string") {
    // M3U item URLs are imported by trusted server-side sync, but they do not
    // encode a provider account identity. Scope their breaker/claim key to the
    // authenticated owner and owned source instead of deriving a global key
    // from an opaque catalogue URL.
    return {
      targetUrl: hint.targetUrl,
      playbackHint: storedPlaybackHint,
      providerAccountScope: `user-source:${userId}:${sourceId}`,
      itemCas,
      containerObservation,
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
  const loadedSource = await loadSourceConfigEnvelope(sourceId, userId, db).catch(() => null);
  if (!loadedSource) return miss;
  const assertLoadedSourceCurrent = () => assertPlaybackSourceConfigCurrent(
    sourceId,
    userId,
    loadedSource.configRevision,
    db,
  );
  const cfg = loadedSource.config;
  const serverUrl = stringOr((cfg as JsonRecord).serverUrl, "");
  const username = typeof (cfg as JsonRecord).username === "string"
    && String((cfg as JsonRecord).username).trim()
    ? String((cfg as JsonRecord).username) : "";
  const password = typeof (cfg as JsonRecord).password === "string"
    && String((cfg as JsonRecord).password).length
    ? String((cfg as JsonRecord).password) : "";
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
  let cachedEpisodeUrl: string | null = null;
  try {
    const host = new URL(base).host;
    const { data: row } = await db.from("cloud_series_info_cache")
      .select("payload").eq("server_host", host).eq("series_id", seriesId).maybeSingle();
    cachedEpisodeUrl = episodeUrlFrom(recordOrEmpty((row as JsonRecord | null)?.payload));
  } catch (_) { /* cache unavailable → fall through */ }
  if (cachedEpisodeUrl) {
    await assertLoadedSourceCurrent();
    return { url: cachedEpisodeUrl, emptySeries: false };
  }

  // 2) Media gateway (residential IP): the only path Ninja/Ferran accept.
  try {
    const rc = await getRuntimeConfig(db);
    if (rc.mediaGatewayUrl && rc.mediaGatewayToken) {
      const { response, value } = await fetchBoundedProviderJson(
        `${rc.mediaGatewayUrl}/xtream/series-info`,
        {
          method: "POST",
          timeoutMs: 12_000,
          maxBytes: 8 * 1024 * 1024,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${rc.mediaGatewayToken}` },
          body: JSON.stringify({ serverUrl, username, password, seriesId, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
        },
      );
      if (response.ok) {
        const body = recordOrEmpty(value);
        const viaGateway = episodeUrlFrom(body);
        if (viaGateway) {
          await assertLoadedSourceCurrent();
          return { url: viaGateway, emptySeries: false };
        }
        // Authoritative fiche with no episode → empty shell; skip the direct call (same
        // panel would give the same answer — one provider hit saved).
        if (isRecord(body.info)) {
          await assertLoadedSourceCurrent();
          return { url: null, emptySeries: true };
        }
      }
    }
  } catch (error) {
    if (isPlaybackSourceSnapshotError(error)) throw error;
    // Gateway hiccup/oversize/timeout → fall through to the fenced direct leg.
  }

  // 3) Historical direct call (works on panels that tolerate datacenter IPs).
  const api = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
  let directInfo: JsonRecord | null;
  try {
    directInfo = await withSourceDirectFallbackLease({
      db,
      sourceId,
      userId,
      owner: providerDirectFallbackLeaseOwner("playback-series-resolution"),
      ttlSeconds: directFallbackLeaseTtlSeconds(12_000),
      ...await buildProviderDirectFallbackSnapshot({
        serverUrl,
        username,
        configCiphertext: loadedSource.configCiphertext,
        configRevision: loadedSource.configRevision,
      }),
    }, async () => {
      try {
        const { response, value } = await fetchBoundedProviderJson(api, {
          timeoutMs: 12_000,
          maxBytes: 8 * 1024 * 1024,
          headers: { "user-agent": "NorvaCloud/1.0", accept: "application/json" },
        });
        if (!response.ok) {
          await assertLoadedSourceCurrent();
          return null;
        }
        const payload = recordOrEmpty(value);
        // The source-transition trigger shares this lease's affinity mutex, so
        // this exact revision verdict is linearized before release.
        await assertLoadedSourceCurrent();
        return payload;
      } catch (error) {
        if (error instanceof BoundedProviderResponseError) {
          await assertLoadedSourceCurrent();
          return null;
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof ProviderDirectFallbackLeaseError) {
      throw new HttpError(error.status, error.message, error.details);
    }
    throw error;
  }
  await assertLoadedSourceCurrent();
  if (!directInfo) return miss;
  return { url: episodeUrlFrom(directInfo), emptySeries: false };
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
  coord: string,
  userAgent: string | null,
) {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.relayBaseUrl || !runtimeConfig.relayTokenSecret) {
    throw new HttpError(503, "Norva Relay is not configured");
  }

  // The provider-account coordinator is stable across Norva users who share a
  // provider credential. Seal it with a random nonce before it enters the
  // browser-visible token so it cannot become a cross-account correlation id.
  const route = await sealRelayCoordinatorRoute(runtimeConfig.relayTokenSecret, coord);
  const payload = JSON.stringify({
    v: 2,
    purpose: "playback",
    sid: playbackSessionId,
    route,
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
async function createBytePipeCapability(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  _db: SupabaseClient,
  userAgent: string | null = null,
  scope: string | null = null,
  fileSizeBytes: number | null = null,
  durationSeconds: number | null = null,
  strictLidWindowClaims: StrictLidWindowCapabilityClaims | null = null,
  usePlaybackCanary = false,
) {
  const runtimeConfig = await getRuntimeConfig(_db);
  const gatewayRoute = usePlaybackCanary
    ? await mediaGatewayRouteForPlaybackUser(runtimeConfig, userId)
    : runtimeConfig.mediaGatewayRouting.defaultRoute;
  if (!gatewayRoute) {
    throw new HttpError(503, "Media gateway is not configured");
  }
  if (strictLidWindowClaims) {
    const finalizing = strictLidWindowClaims.windowFinalize === true;
    if (
      strictLidWindowClaims.windowCheckpointProtocol !== LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL ||
      !PLAYBACK_SESSION_UUID_PATTERN.test(strictLidWindowClaims.jobId) ||
      !/^[a-f0-9]{64}$/.test(strictLidWindowClaims.profileFingerprint) ||
      ![4, 6].includes(strictLidWindowClaims.windowCount) ||
      (finalizing && strictLidWindowClaims.windowOrdinal !== undefined) ||
      (!finalizing && (
        !Number.isInteger(strictLidWindowClaims.windowOrdinal) ||
        Number(strictLidWindowClaims.windowOrdinal) < 1 ||
        Number(strictLidWindowClaims.windowOrdinal) > strictLidWindowClaims.windowCount
      ))
    ) {
      throw new HttpError(409, "Strict language validation window claims are invalid", {
        code: "LANGUAGE_VALIDATION_WINDOW_CLAIMS_INVALID",
      });
    }
  }
  const payload = JSON.stringify({
    v: 1,
    sid: playbackSessionId,
    uid: userId,
    url: targetUrl,
    ...(userAgent ? { ua: userAgent } : {}),
    ...(scope ? { scope } : {}),
    ...(Number.isSafeInteger(fileSizeBytes) && Number(fileSizeBytes) > 0
      ? { fileSizeBytes }
      : {}),
    ...(Number.isFinite(durationSeconds) &&
        Number(durationSeconds) > 0 &&
        Number(durationSeconds) <= 24 * 60 * 60
      ? { durationSeconds: Number(durationSeconds) }
      : {}),
    ...(strictLidWindowClaims
      ? {
        windowCheckpointProtocol: strictLidWindowClaims.windowCheckpointProtocol,
        jobId: strictLidWindowClaims.jobId,
        profileFingerprint: strictLidWindowClaims.profileFingerprint,
        windowCount: strictLidWindowClaims.windowCount,
        ...(strictLidWindowClaims.windowFinalize === true
          ? { windowFinalize: true }
          : { windowOrdinal: strictLidWindowClaims.windowOrdinal }),
      }
      : {}),
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  });
  const signature = await hmacBase64Url(gatewayRoute.token, payload);
  const capability = `${base64Url(encoder.encode(payload))}.${signature}`;
  return {
    capability,
    gatewayUrl: gatewayRoute.url,
    serviceToken: gatewayRoute.token,
  };
}

async function createBytePipeAccess(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  expiresAt: string,
  db: SupabaseClient,
  userAgent: string | null = null,
  scope: string | null = null,
  fileSizeBytes: number | null = null,
  usePlaybackCanary = false,
) {
  const access = await createBytePipeCapability(
    playbackSessionId,
    userId,
    targetUrl,
    expiresAt,
    db,
    userAgent,
    scope,
    fileSizeBytes,
    null,
    null,
    usePlaybackCanary,
  );
  return { url: `${access.gatewayUrl}/raw/${access.capability}` };
}

function exactJsonKeys(value: JsonRecord, expected: string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalVodContainer(value: unknown): string | null {
  const token = normalizeCodecToken(value);
  const canonical = token === "matroska"
    ? "mkv"
    : token === "mpeg"
    ? "mpg"
    : token === "m4v"
    ? "mp4"
    : token;
  return ["mkv", "mp4", "mov", "avi", "ogg", "flv", "mpg", "ts"].includes(canonical)
    ? canonical
    : null;
}

function containerEvidenceKind(container: string): string | null {
  return {
    mkv: "ebml-v1",
    mp4: "iso-bmff-ftyp-v1",
    mov: "iso-bmff-ftyp-v1",
    avi: "riff-avi-v1",
    ogg: "ogg-v1",
    flv: "flv-v1",
    mpg: "mpeg-ps-v1",
    ts: "mpeg-ts-sync-v1",
  }[container] ?? null;
}

function normalizeGatewaySourceContainerMismatch(
  status: number,
  value: unknown,
  expectedSourceUrlSha256: string,
) {
  const body = recordOrEmpty(value);
  if (
    status !== 409 ||
    !exactJsonKeys(body, ["protocol", "code", "declaredContainer", "observedContainer", "evidence"]) ||
    body.protocol !== 1 ||
    body.code !== "SOURCE_CONTAINER_MISMATCH" ||
    typeof body.declaredContainer !== "string" ||
    typeof body.observedContainer !== "string"
  ) return null;
  const declaredContainer = canonicalVodContainer(body.declaredContainer);
  const observedContainer = canonicalVodContainer(body.observedContainer);
  const evidence = recordOrEmpty(body.evidence);
  if (
    declaredContainer !== "mkv" ||
    !observedContainer ||
    observedContainer === declaredContainer ||
    typeof evidence.kind !== "string" ||
    typeof evidence.prefixSha256 !== "string" ||
    typeof evidence.sourceUrlSha256 !== "string" ||
    typeof evidence.effectiveUrlSha256 !== "string" ||
    typeof evidence.validatorKind !== "string" ||
    !(evidence.validatorSha256 === null || typeof evidence.validatorSha256 === "string") ||
    !(evidence.fileSizeBytes === null || typeof evidence.fileSizeBytes === "number") ||
    !exactJsonKeys(evidence, [
      "kind",
      "prefixSha256",
      "sourceUrlSha256",
      "effectiveUrlSha256",
      "validatorKind",
      "validatorSha256",
      "fileSizeBytes",
    ])
  ) return null;
  const kind = stringOr(evidence.kind, "");
  const prefixSha256 = stringOr(evidence.prefixSha256, "").toLowerCase();
  const sourceUrlSha256 = stringOr(evidence.sourceUrlSha256, "").toLowerCase();
  const effectiveUrlSha256 = stringOr(evidence.effectiveUrlSha256, "").toLowerCase();
  const validatorKind = stringOr(evidence.validatorKind, "");
  const validatorSha256 = evidence.validatorSha256 === null
    ? null
    : stringOr(evidence.validatorSha256, "").toLowerCase();
  const fileSizeBytes = evidence.fileSizeBytes === null
    ? null
    : exactPositiveSafeInteger(evidence.fileSizeBytes);
  const expectedKind = containerEvidenceKind(observedContainer);
  if (
    !expectedKind || kind !== expectedKind ||
    !/^[0-9a-f]{64}$/.test(prefixSha256) ||
    !/^[0-9a-f]{64}$/.test(sourceUrlSha256) ||
    sourceUrlSha256 !== expectedSourceUrlSha256 ||
    !/^[0-9a-f]{64}$/.test(effectiveUrlSha256) ||
    !["etag", "last-modified", "none"].includes(validatorKind) ||
    (validatorKind === "none" ? validatorSha256 !== null : !/^[0-9a-f]{64}$/.test(validatorSha256 || "")) ||
    (evidence.fileSizeBytes !== null && fileSizeBytes === null)
  ) return null;
  return {
    declaredContainer,
    observedContainer,
    evidence: {
      kind,
      prefixSha256,
      sourceUrlSha256,
      effectiveUrlSha256,
      validatorKind,
      validatorSha256,
      fileSizeBytes,
    },
  };
}

function playbackHintForObservedContainer(value: unknown, observedContainer: string) {
  const hint = { ...recordOrEmpty(value) };
  // A wrong container label means the catalogue profile was not established
  // from this exact byte stream. Keep user track choices and identity hints,
  // but make the corrected Gateway session re-probe codecs before selecting a
  // copy/transcode graph.
  delete hint.videoCodec;
  delete hint.video_codec;
  delete hint.audioCodec;
  delete hint.audio_codec;
  delete hint.audioProfile;
  delete hint.audio_profile;
  delete hint.audioChannels;
  delete hint.audio_channels;
  const existingProfile = firstUsefulCodecProfile(hint.codecProfile, hint.codec_profile);
  const existingProfileContainer = canonicalVodContainer(existingProfile.container);
  const exactObservedProfile = Boolean(
    existingProfileContainer === observedContainer &&
    stringOrNull(existingProfile.probeSource ?? existingProfile.probe_source) &&
    stringOrNull(existingProfile.probedAt ?? existingProfile.probed_at),
  );
  delete hint.codec_profile;
  return compactRecord({
    ...hint,
    container: observedContainer,
    containerExplicit: true,
    codecProfile: exactObservedProfile
      ? compactRecord({ ...stripMkvH264FastStartProof(existingProfile), container: observedContainer })
      : { container: observedContainer },
  });
}

async function sourceContainerAuthorityFromObservation(value: unknown, sourceUrl: string) {
  const observation = recordOrEmpty(value);
  const container = canonicalVodContainer(observation.container);
  const evidenceKind = stringOr(observation.evidenceKind ?? observation.evidence_kind, "");
  const prefixSha256 = stringOr(observation.prefixSha256 ?? observation.prefix_sha256, "").toLowerCase();
  if (
    !container ||
    evidenceKind !== containerEvidenceKind(container) ||
    !/^[0-9a-f]{64}$/.test(prefixSha256)
  ) return null;
  return {
    protocol: 1,
    container,
    sourceUrlSha256: await sha256Hex(sourceUrl),
    evidenceKind,
    prefixSha256,
  };
}

function rewriteVodContainerUrl(
  value: string,
  declaredContainer: string,
  observedContainer: string,
  sourceType: string,
) {
  // Only Norva's Xtream URL builder owns the terminal extension. An opaque M3U
  // URL may merely happen to end in `.mkv`; changing it could invalidate a
  // signed/static provider path. The Gateway authority is enough for those
  // sources and keeps their exact URL intact.
  if (sourceType !== "xtream") return value;
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 4 || !["movie", "series"].includes(segments.at(-4) || "")) return value;
    const suffix = `.${declaredContainer.toLowerCase()}`;
    if (parsed.pathname.toLowerCase().endsWith(suffix)) {
      parsed.pathname = `${parsed.pathname.slice(0, -suffix.length)}.${observedContainer}`;
      return parsed.toString();
    }
  } catch (_) { /* retain the authenticated exact target */ }
  return value;
}

function containerObservationItemCas(value: unknown, expectedTargetUrlHash: string) {
  const hint = recordOrEmpty(value);
  const raw = recordOrEmpty(hint.__norvaMkvH264FastStartItemCasV2);
  const id = stringOrNull(raw.id);
  const updatedAt = stringOrNull(raw.updatedAt ?? raw.updated_at);
  const targetUrlHash = stringOr(raw.targetUrlHash ?? raw.target_url_hash, "").toLowerCase();
  if (
    !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt)) ||
    targetUrlHash !== expectedTargetUrlHash
  ) return null;
  return { id, updatedAt };
}

async function persistGatewaySourceContainerMismatch(
  db: SupabaseClient,
  options: {
    playbackSessionId: string;
    userId: string;
    sourceId: string;
    itemType: string;
    itemId: string;
    playbackHint: JsonRecord;
    expectedTargetUrlHash: string;
    mismatch: JsonRecord;
    generation: ActiveCatalogGeneration;
  },
) {
  const itemCas = containerObservationItemCas(options.playbackHint, options.expectedTargetUrlHash);
  if (!itemCas) return false;
  const { data, error } = await callActiveCatalogGenerationRpc(db, "record_catalog_file_container_observation", {
    p_playback_session_id: options.playbackSessionId,
    p_user_id: options.userId,
    p_source_id: options.sourceId,
    p_item_type: options.itemType,
    p_external_id: options.itemId,
    p_declared_container: options.mismatch.declaredContainer,
    p_observed_container: options.mismatch.observedContainer,
    p_evidence: options.mismatch.evidence,
    p_expected_media_item_id: itemCas.id,
    p_expected_media_item_updated_at: itemCas.updatedAt,
  }, options.generation);
  if (error || recordOrEmpty(data).ok !== true) {
    console.warn("[norva-playback] unable to persist provider container correction", error?.message || "invalid RPC result");
    return false;
  }
  try {
    await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, options.generation);
  } catch (_) {
    return false;
  }
  return true;
}

async function createGatewaySession(
  playbackSessionId: string,
  userId: string,
  targetUrl: string,
  providerAccountHash: string,
  expiresAt: string,
  db: SupabaseClient,
  mode: "direct" | "relay" | "transcode",
  userAgent: string | null,
  playbackHint: JsonRecord,
  playbackIdentity: {
    sourceId: string;
    itemType: string;
    itemId: string;
    variantId: string | null;
  },
  playbackGeneration: ActiveCatalogGeneration,
  forceVideoTranscode: boolean,
  releasedSuperseded = 0,
  sourceContainerObservation: JsonRecord = {},
  requestSignal: AbortSignal | null = null,
  mediaCacheProducer: MediaCacheProducerContext | null = null,
  bypassCompleteHlsCache = false,
) {
  const gatewayMode = gatewayModeForPlayback(mode, playbackHint, forceVideoTranscode);
  const gatewayHints = gatewayPlaybackHints(playbackHint);
  const requestedAudioStreamIndex = boundedNullableInt(
    gatewayHints.audioStreamIndex ?? gatewayHints.audio_stream_index,
    0,
    1024,
  );
  const requestedSubtitleStreamIndex = boundedNullableInt(
    gatewayHints.subtitleStreamIndex ?? gatewayHints.subtitle_stream_index,
    0,
    1024,
  );
  const runtimeConfig = await getRuntimeConfig(db);
  const gatewayRoute = await mediaGatewayRouteForPlaybackUser(runtimeConfig, userId);
  if (!gatewayRoute) {
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
      audioStreamIndex: null,
      requestedAudioStreamIndex,
      subtitleStreamIndex: null,
      requestedSubtitleStreamIndex,
      requestedSeekOffset: gatewayHints.seekOffset ?? 0,
      actualStartOffset: gatewayHints.seekOffset ?? 0,
      localSeekTarget: 0,
      sourceTimestamps: false,
      audioRenditions: null,
      multiAudioHls: null,
      subtitleRenditions: null,
      exactSubtitleHls: null,
      startupPolicy: null,
    };
  }

  const startupStartedAt = performance.now();
  const originalTargetUrlHash = await sha256Hex(targetUrl);
  const initialSourceContainerAuthority = await sourceContainerAuthorityFromObservation(
    sourceContainerObservation,
    targetUrl,
  );
  const baseGatewayBody = {
    playbackSessionId,
    ownerKey: await sha256Hex(userId),
    sourceUrl: targetUrl,
    mode: gatewayMode,
    expiresAt,
    playbackHint: compactRecord(stripMkvH264FastStartInternalHints(playbackHint)),
    playbackIdentity: compactRecord(playbackIdentity),
    seekOffset: gatewayHints.seekOffset,
    startOffset: gatewayHints.startOffset,
    ...gatewayHints,
    ...(initialSourceContainerAuthority ? { sourceContainerAuthority: initialSourceContainerAuthority } : {}),
    ...(mediaCacheProducer
      ? {
        mediaCacheProducer,
        // Until the verified local-L1-to-R2 promotion path is enabled, a
        // distributed leader must own the exact EOF/content digest itself.
        // Reusing a tenant-local complete cache here would leave followers
        // waiting on a lease that can never publish a global object.
        completeHlsCachePolicy: "bypass",
      }
      : (bypassCompleteHlsCache ? { completeHlsCachePolicy: "bypass" } : {})),
    ...(userAgent ? { userAgent } : {}),
  };
  let { response, body: gatewayBody } = await requestGatewaySession(
    gatewayRoute.url,
    gatewayRoute.token,
    baseGatewayBody,
    requestSignal,
  );
  let containerCorrectionRetried = false;
  if (!response.ok) {
    const mismatch = normalizeGatewaySourceContainerMismatch(
      response.status,
      gatewayBody,
      originalTargetUrlHash,
    );
    if (mismatch) {
      await persistGatewaySourceContainerMismatch(db, {
        playbackSessionId,
        userId,
        sourceId: playbackIdentity.sourceId,
        itemType: playbackIdentity.itemType,
        itemId: playbackIdentity.itemId,
        playbackHint,
        expectedTargetUrlHash: originalTargetUrlHash,
        mismatch,
        generation: playbackGeneration,
      });
      if (PROVIDER_SLOT_RELEASE_DELAY_MS > 0) await sleep(PROVIDER_SLOT_RELEASE_DELAY_MS);
      const correctedTargetUrl = rewriteVodContainerUrl(
        targetUrl,
        mismatch.declaredContainer,
        mismatch.observedContainer,
        stringOr(playbackHint.sourceType, ""),
      );
      const correctedPlaybackHint = playbackHintForObservedContainer(
        playbackHint,
        mismatch.observedContainer,
      );
      const correctedGatewayHints = gatewayPlaybackHints(correctedPlaybackHint);
      const retry = await requestGatewaySession(
        gatewayRoute.url,
        gatewayRoute.token,
        {
          ...baseGatewayBody,
          sourceUrl: correctedTargetUrl,
          playbackHint: stripMkvH264FastStartInternalHints(correctedPlaybackHint),
          ...correctedGatewayHints,
          sourceContainerAuthority: {
            protocol: 1,
            container: mismatch.observedContainer,
            sourceUrlSha256: await sha256Hex(correctedTargetUrl),
            evidenceKind: mismatch.evidence.kind,
            prefixSha256: mismatch.evidence.prefixSha256,
          },
        },
        requestSignal,
      );
      response = retry.response;
      gatewayBody = retry.body;
      containerCorrectionRetried = true;
    }
  }
  if (!response.ok) {
    const gatewayFailureCode = stringOr(
      gatewayBody.code ?? gatewayBody.errorCode ?? gatewayBody.error_code,
      "",
    );
    if (isProviderBusyFailure({
      code: gatewayFailureCode,
      upstreamStatus: response.status,
    })) {
      if (containerCorrectionRetried) {
        // The correction already consumed the only authorized second provider
        // attempt. A first 458 on that attempt is terminal: never turn a
        // metadata repair into a connection cascade. Circuit escalation still
        // honors the same bounded self-release grace as every other 458 path.
        const lastSelfReleaseAt = releasedSuperseded > 0
          ? new Date().toISOString()
          : await latestProviderSelfReleaseAt(providerAccountHash, db);
        if (shouldOpenCircuitForProviderBusy({ lastSelfReleaseAt })) {
          await openProviderPlaybackCircuit(providerAccountHash, db, true);
        }
      } else {
        const lastSelfReleaseAt = releasedSuperseded > 0
          ? new Date().toISOString()
          : await latestProviderSelfReleaseAt(providerAccountHash, db);
        if (!shouldOpenCircuitForProviderBusy({ lastSelfReleaseAt })) {
          await sleep(PROVIDER_SLOT_RELEASE_DELAY_MS);
          const retry = await requestGatewaySession(
            gatewayRoute.url,
            gatewayRoute.token,
            baseGatewayBody,
            requestSignal,
          );
          response = retry.response;
          gatewayBody = retry.body;
        } else {
          // This is the only escalating signal: norva-playback itself observed the
          // gateway's HTTP 458. Open the circuit before preserving that exact error.
          await openProviderPlaybackCircuit(providerAccountHash, db, true);
        }
      }
    }
    if (!response.ok) {
      throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);
    }
  }
  const externalSessionId = stringOrNull(gatewayBody.id);
  if (!externalSessionId) {
    throw new HttpError(502, "Media gateway returned an unmanageable session", {
      code: "GATEWAY_SESSION_ID_MISSING",
    });
  }
  const cleanupCreatedSession = () => cleanupMediaGatewaySession({
    baseUrl: gatewayRoute.url,
    token: gatewayRoute.token,
    sessionId: externalSessionId,
  });
  const startupMs = Math.max(1, Math.round(performance.now() - startupStartedAt));
  const audioMode = stringOrNull(gatewayBody.audioMode ?? gatewayBody.audio_mode);
  // The gateway resolves the absolute ffmpeg stream index it actually mapped.
  // Preserve it end-to-end so the player can distinguish the requested track
  // from the browser/HLS default and avoid relabeling English as French.
  const audioStreamIndex = boundedNullableInt(
    gatewayBody.audioStreamIndex ??
      gatewayBody.audio_stream_index,
    0,
    1024,
  );
  const subtitleStreamIndex = boundedNullableInt(
    gatewayBody.subtitleStreamIndex ??
      gatewayBody.subtitle_stream_index,
    0,
    1024,
  );
  const codecProfile = firstUsefulCodecProfile(gatewayBody.codecProfile, gatewayBody.codec_profile);
  const staleRequestedAudioFallback = gatewayProvesRequestedAudioFallback(
    codecProfile,
    requestedAudioStreamIndex,
    audioStreamIndex,
  );
  if (
    requestedAudioStreamIndex !== null &&
    audioStreamIndex !== requestedAudioStreamIndex &&
    !staleRequestedAudioFallback
  ) {
    const cleanup = await cleanupCreatedSession();
    if (!cleanup.ok) {
      console.warn("[norva-playback] mismatched audio gateway cleanup failed");
    }
    throw new HttpError(502, "Media gateway did not map the requested audio stream", {
      code: "AUDIO_STREAM_MAP_MISMATCH",
      requestedAudioStreamIndex,
      actualAudioStreamIndex: audioStreamIndex,
    });
  }
  if (staleRequestedAudioFallback) {
    console.warn("[norva-playback] stale file-local audio stream preference replaced by exact Gateway default");
  }
  if (
    requestedSubtitleStreamIndex !== null &&
    subtitleStreamIndex !== requestedSubtitleStreamIndex
  ) {
    const cleanup = await cleanupCreatedSession();
    if (!cleanup.ok) {
      console.warn("[norva-playback] mismatched subtitle gateway cleanup failed");
    }
    throw new HttpError(502, "Media gateway did not map the requested subtitle stream", {
      code: "SUBTITLE_STREAM_MAP_MISMATCH",
      requestedSubtitleStreamIndex,
      actualSubtitleStreamIndex: subtitleStreamIndex,
    });
  }
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
  const normalizedAudioRenditions = normalizeGatewayAudioRenditions(
    gatewayBody.audioRenditions,
    audioStreamIndex,
  );
  const multiAudioHls = normalizeGatewayMultiAudioHls(
    gatewayBody.multiAudioHls,
    normalizedAudioRenditions,
    audioStreamIndex,
    codecProfile,
  );
  // The two Gateway fields form one topology. Never expose a partial contract:
  // hls.js indexes are safe only when the diagnostics bind the default absolute
  // stream to the exact rendition array returned by this same Gateway response.
  const audioRenditions = multiAudioHls ? normalizedAudioRenditions : null;
  const normalizedSubtitleRenditions = normalizeGatewaySubtitleRenditions(
    gatewayBody.subtitleRenditions ?? gatewayBody.subtitle_renditions,
    codecProfile,
  );
  const exactSubtitleHls = normalizeGatewayExactSubtitleHls(
    gatewayBody.exactSubtitleHls ?? gatewayBody.exact_subtitle_hls,
    normalizedSubtitleRenditions,
    codecProfile,
  );
  // As with audio, the rendition array and its diagnostics are one indivisible
  // topology. A partial or stale Gateway response must never create selectable
  // subtitle rows in the player.
  const subtitleRenditions = exactSubtitleHls ? normalizedSubtitleRenditions : null;
  const startupPolicy = normalizeGatewayStartupPolicy(
    gatewayBody.startupPolicy ?? gatewayBody.startup_policy,
  );
  const liveJoinCandidate = recordOrEmpty(
    gatewayBody.liveJoin ?? gatewayBody.live_join,
  ).candidate === true;

  try {
    const { data, error } = await db
      .from("cloud_gateway_sessions")
      .insert({
        user_id: userId,
        playback_session_id: playbackSessionId,
        gateway_id: gatewayRoute.gatewayId,
        external_session_id: externalSessionId,
        status: stringOr(gatewayBody.status, "starting"),
        mode: stringOr(gatewayBody.mode, "remux"),
        hls_url: stringOrNull(gatewayBody.hlsUrl ?? gatewayBody.hls_url),
        expires_at: expiresAt,
        ...(mediaCacheProducer
          ? {
            media_cache_work_fingerprint: mediaCacheProducer.workFingerprint,
            media_cache_account_fingerprint: mediaCacheProducer.accountFingerprint,
            media_cache_lease_token: mediaCacheProducer.leaseToken,
            media_cache_owner_instance_fingerprint: mediaCacheProducer.ownerInstanceFingerprint,
            media_cache_admission_mode: mediaCacheProducer.admission.mode,
            media_cache_admitted: mediaCacheProducer.admission.admitted,
            media_cache_admission_score: mediaCacheProducer.admission.score,
            media_cache_admission_confidence: mediaCacheProducer.admission.confidence,
            media_cache_admission_reason: mediaCacheProducer.admission.reason,
            media_cache_ttl_seconds: mediaCacheProducer.admission.ttlSeconds,
            media_cache_live_joinable_at: liveJoinCandidate ? new Date().toISOString() : null,
            media_cache_primary_attached: true,
          }
          : {}),
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
      requestedAudioStreamIndex,
      subtitleStreamIndex,
      requestedSubtitleStreamIndex,
      requestedSeekOffset,
      actualStartOffset,
      localSeekTarget,
      sourceTimestamps,
      audioRenditions,
      multiAudioHls,
      subtitleRenditions,
      exactSubtitleHls,
      startupPolicy,
      codecProfile,
      cleanupCreatedSession,
    };
  } catch (databaseError) {
    const cleanup = await cleanupCreatedSession();
    if (!cleanup.ok) {
      console.warn(
        "[norva-playback] gateway database rollback cleanup failed",
        cleanup.status,
        cleanup.reason,
      );
    }
    throw databaseError;
  }
}

async function requestGatewaySession(
  baseUrl: string,
  token: string,
  body: JsonRecord,
  signal: AbortSignal | null = null,
) {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return {
    response,
    body: await response.json().catch(() => ({})),
  };
}

function gatewayModeForPlayback(
  mode: "direct" | "relay" | "transcode",
  playbackHint: JsonRecord,
  forceVideoTranscode = false,
): "remux" | "transcode" {
  if (forceVideoTranscode) return "transcode";
  const requested = normalizeCodecToken(playbackHint.gatewayMode ?? playbackHint.gateway_mode);
  if (requested === "remux" || requested === "copy") return "remux";
  if (requested === "transcode" || requested === "encode") return "transcode";
  return mode === "transcode" ? "transcode" : "remux";
}

function gatewayCodecProfileContainer(
  gatewayCodecProfile: unknown,
  requestedPlaybackHint: unknown,
): string {
  const observed = recordOrEmpty(gatewayCodecProfile);
  const requested = recordOrEmpty(requestedPlaybackHint);
  // The current Gateway observation is authoritative for this lifecycle. A
  // stale/client `mp4` hint must not force an intermediate T0->T1 write before
  // DELETE persists the final Matroska profile/proof under the original CAS.
  return stringOr(observed.container ?? requested.container, "").toLowerCase();
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
    subtitleStreamIndex: boundedNullableInt(
      playbackHint.subtitleStreamIndex ??
        playbackHint.subtitle_stream_index,
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
  const { error } = await patchActiveCatalogTitleVariants(db, {
    userId: options.userId,
    sourceId: options.sourceId,
    itemType,
    externalId: options.itemId,
    patch: {
      last_observed_ttff_ms: Math.round(options.startupMs),
      playback_cost_score: cost,
    },
  });
  if (error && !isProjectionMissing(error)) {
    console.warn(
      "[norva-playback] unable to record playback startup observation",
      error instanceof Error ? error.message : "catalog observation write failed",
    );
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
    variantId?: string | null;
    strict?: boolean;
    requireItemCas?: boolean;
    expectedItemCas?: {
      id: string;
      updatedAt: string;
      targetUrlHash: string;
    } | null;
    itemOnly?: boolean;
    allowProofReplacement?: boolean;
  },
) {
  const itemType = options.itemType === "series" ? "series" : options.itemType === "movie" ? "movie" : "";
  const normalizedObservedCodecProfile = normalizeCodecProfile(options.codecProfile);
  const observedCodecProfile = options.allowProofReplacement
    ? normalizedObservedCodecProfile
    : stripMkvH264FastStartProof(normalizedObservedCodecProfile);
  if (!itemType || !options.itemId || !hasUsefulCodecProfile(observedCodecProfile)) {
    if (options.strict) throw new HttpError(422, "A useful codec profile is required");
    return false;
  }

  let generation: ActiveCatalogGeneration;
  try {
    generation = await readActiveCatalogGenerationSnapshot(db, options.sourceId, options.userId);
  } catch (snapshotError) {
    if (isCatalogGenerationSuperseded(snapshotError)) return true;
    if (options.strict) throw snapshotError;
    return false;
  }

  const observedAt = new Date().toISOString();
  if (options.requireItemCas && !options.expectedItemCas) {
    if (options.strict) throw new HttpError(409, "Exact media item CAS snapshot is unavailable");
    return false;
  }
  const { data: item, error } = await db
    .from("cloud_catalog_visible_media_items")
    .select("id,metadata,playback_hint,updated_at")
    .eq("user_id", options.userId)
    .eq("source_id", options.sourceId)
    .eq("item_type", itemType)
    .eq("external_id", options.itemId)
    .maybeSingle();
  if (error) {
    if (options.strict) throwDb(error, "Unable to load media item for codec profile");
    console.warn("[norva-playback] unable to load media item for codec profile", error.message);
    return false;
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
  if (
    options.requireItemCas && (
      !item?.id || !stringOrNull(item.updated_at) ||
      String(item.id) !== options.expectedItemCas?.id ||
      String(item.updated_at) !== options.expectedItemCas?.updatedAt
    )
  ) {
    if (options.strict) throw new HttpError(409, "Exact media item CAS state is unavailable");
    return false;
  }
  if (item?.id) {
    const itemUpdateResult = await patchActiveCatalogMediaItems(db, {
      userId: options.userId,
      sourceId: options.sourceId,
      generation,
      id: options.requireItemCas ? options.expectedItemCas!.id : String(item.id),
      updatedAt: options.requireItemCas ? options.expectedItemCas!.updatedAt : null,
      patch: {
        metadata: compactRecord({
          ...metadata,
          codecProfile,
          codecProfileObservedAt: observedAt,
        }),
        playback_hint: mergedPlaybackHint,
      },
    });
    if (itemUpdateResult.superseded) return true;
    const updatedItems = itemUpdateResult.data;
    const itemUpdateError = itemUpdateResult.error;
    if (itemUpdateError) {
      if (options.strict) {
        throwDb(itemUpdateError as { message?: string; details?: string; hint?: string }, "Unable to persist media codec profile");
      }
      console.warn(
        "[norva-playback] unable to persist media codec profile",
        itemUpdateError instanceof Error ? itemUpdateError.message : "catalog observation write failed",
      );
    }
    if (options.requireItemCas && (!Array.isArray(updatedItems) || updatedItems.length !== 1)) {
      if (options.strict) throw new HttpError(409, "Media codec profile changed before CAS persistence");
      return false;
    }
  }

  if (options.itemOnly) return Boolean(item?.id);

  const tier = compatibilityTierForCodecProfile(codecProfile, mergedPlaybackHint);
  // Exact variants are owner-readable catalogue rows. They need the final
  // in-band stream inventory so post-playback language validation can bind to
  // the file, but never the private fast-start/cache attestations stored on the
  // CAS-protected media item.
  const variantCodecProfile = stripMkvH264FastStartProof(codecProfile);
  const variantPatch: JsonRecord = compactRecord({
    codec_profile: variantCodecProfile,
    compatibility_tier: tier,
    playback_cost_score: playbackCostScoreForObservation(tier, options.startupMs),
  });
  const {
    data: updatedVariants,
    error: variantError,
    superseded: variantSuperseded,
  } = await patchActiveCatalogTitleVariants(db, {
    userId: options.userId,
    sourceId: options.sourceId,
    generation,
    patch: variantPatch,
    id: options.variantId,
    itemType,
    externalId: options.itemId,
  });
  if (variantSuperseded) return true;
  if (variantError && !isProjectionMissing(variantError)) {
    if (options.strict) {
      throwDb(variantError as { message?: string; details?: string; hint?: string }, "Unable to persist exact variant codec profile");
    }
    console.warn(
      "[norva-playback] unable to persist variant codec profile",
      variantError instanceof Error ? variantError.message : "catalog observation write failed",
    );
    return false;
  }
  if (options.strict && (!Array.isArray(updatedVariants) || updatedVariants.length !== 1)) {
    throw new HttpError(404, "Exact variant codec profile was not persisted");
  }
  return !variantError;
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

function bindServerMkvFastStartProof(
  mergedHintValue: unknown,
  authoritativeHintValue: unknown,
  serverAuthority: boolean,
) {
  const mergedHint = recordOrEmpty(mergedHintValue);
  const authoritativeHint = recordOrEmpty(authoritativeHintValue);
  const mergedProfile = firstUsefulCodecProfile(
    mergedHint.codecProfile,
    mergedHint.codec_profile,
  );
  if (!hasUsefulCodecProfile(mergedProfile)) return mergedHint;
  const authoritativeProfile = firstUsefulCodecProfile(
    authoritativeHint.codecProfile,
    authoritativeHint.codec_profile,
  );
  const serverProof = serverAuthority ? normalizeMkvH264FastStartProof(
    authoritativeProfile.mkvH264FastStartProof ??
      authoritativeProfile.mkv_h264_fast_start_proof,
  ) : null;
  const serverCompleteCacheProof = serverAuthority ? normalizeMkvH264FastStartProof(
    authoritativeProfile.mkvCompleteHlsCacheProof ??
      authoritativeProfile.mkv_complete_hls_cache_proof,
  ) : null;
  // The caller controls playbackHint. Codec metadata may remain a useful hint,
  // but only a profile loaded from the owned server-side catalogue may attest
  // that packet/GOP evidence is safe enough to bypass video encoding.
  return compactRecord({
    ...mergedHint,
    codecProfile: compactRecord({
      ...mergedProfile,
      mkvH264FastStartProof: serverProof,
      mkvCompleteHlsCacheProof: serverCompleteCacheProof,
    }),
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

  const existingProof = normalizeMkvH264FastStartProof(existing.mkvH264FastStartProof);
  const observedProof = normalizeMkvH264FastStartProof(observed.mkvH264FastStartProof);
  const existingCompleteCacheProof = normalizeMkvH264FastStartProof(existing.mkvCompleteHlsCacheProof);
  const observedCompleteCacheProof = normalizeMkvH264FastStartProof(observed.mkvCompleteHlsCacheProof);
  return compactRecord({
    ...observed,
    subtitles: mergeSubtitleTrackAnnotations(existing.subtitles, observed.subtitles),
    mkvH264FastStartProof: observedProof ?? existingProof,
    mkvCompleteHlsCacheProof: observedCompleteCacheProof ?? existingCompleteCacheProof,
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

function normalizeMkvH264FastStartProof(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  const parts = value.split(".");
  if (
    parts.length !== 2 || parts[0].length === 0 || parts[0].length > 16_000 ||
    parts[1].length !== 43 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1])
  ) return null;
  // Edge deliberately does not decode or authorize this envelope. Gateway is
  // the sole HMAC verifier after current-file/validator pre-open.
  return value;
}

function stripMkvH264FastStartProof(value: unknown): JsonRecord {
  const profile = { ...recordOrEmpty(value) };
  delete profile.mkvH264FastStartProof;
  delete profile.mkv_h264_fast_start_proof;
  delete profile.mkvCompleteHlsCacheProof;
  delete profile.mkv_complete_hls_cache_proof;
  return compactRecord(profile);
}

function stripMkvH264FastStartInternalHints(value: unknown): JsonRecord {
  const hint = { ...recordOrEmpty(value) };
  delete hint.__norvaMkvH264FastStartItemCasV2;
  return compactRecord(hint);
}

function mkvH264FastStartItemCasFromPlaybackSession(value: unknown) {
  const session = recordOrEmpty(value);
  const hint = recordOrEmpty(session.playback_hint ?? session.playbackHint);
  const raw = recordOrEmpty(hint.__norvaMkvH264FastStartItemCasV2);
  const id = stringOrNull(raw.id);
  const updatedAt = stringOrNull(raw.updatedAt ?? raw.updated_at);
  const targetUrlHash = stringOrNull(raw.targetUrlHash ?? raw.target_url_hash)?.toLowerCase() ?? null;
  const sessionTargetUrlHash = stringOrNull(session.target_url_hash ?? session.targetUrlHash)?.toLowerCase() ?? null;
  if (
    !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt)) ||
    !targetUrlHash || !/^[0-9a-f]{64}$/.test(targetUrlHash) ||
    sessionTargetUrlHash !== targetUrlHash
  ) return null;
  return { id, updatedAt, targetUrlHash };
}

function normalizeGatewayStartupPolicy(value: unknown) {
  const raw = recordOrEmpty(value);
  const protocol = Number(raw.protocol);
  const pipeline = stringOr(raw.pipeline, "");
  const targetBufferSeconds = boundedNullableNumber(
    raw.targetBufferSeconds ?? raw.target_buffer_seconds,
    1,
    180,
  );
  const minimumEncodeRateX = boundedNullableNumber(
    raw.minimumEncodeRateX ?? raw.minimum_encode_rate_x,
    1,
    10,
  );
  const observedEncodeRateX = boundedNullableNumber(
    raw.observedEncodeRateX ?? raw.observed_encode_rate_x,
    0,
    20,
  );
  const reason = stringOr(raw.reason, "");
  const eligible = raw.eligible === true;
  const eligibleGraph =
    ((pipeline === "copy" || pipeline === "audio-transcode") &&
      reason === "mkv-h264-copy-ready") ||
    (pipeline === "copy" && reason === "complete-hls-cache-hit") ||
    (pipeline === "video-transcode" &&
      reason === "vaapi-transcode-ready" &&
      minimumEncodeRateX !== null && minimumEncodeRateX >= 2);
  if (
    protocol !== 2 ||
    !["copy", "audio-transcode", "video-transcode"].includes(pipeline) ||
    minimumEncodeRateX === null ||
    !/^[a-z0-9-]{1,64}$/.test(reason) ||
    (eligible && (
      targetBufferSeconds === null ||
      observedEncodeRateX === null ||
      observedEncodeRateX < minimumEncodeRateX ||
      !eligibleGraph
    )) ||
    (!eligible && targetBufferSeconds !== null)
  ) return null;
  return {
    protocol: 2,
    eligible,
    pipeline,
    targetBufferSeconds: eligible ? targetBufferSeconds : null,
    minimumEncodeRateX,
    observedEncodeRateX,
    reason,
  };
}

function normalizeCodecProfile(profile: JsonRecord) {
  const mkvH264FastStartProof = normalizeMkvH264FastStartProof(
    profile.mkvH264FastStartProof ?? profile.mkv_h264_fast_start_proof,
  );
  const mkvCompleteHlsCacheProof = normalizeMkvH264FastStartProof(
    profile.mkvCompleteHlsCacheProof ?? profile.mkv_complete_hls_cache_proof,
  );
  return compactRecord({
    videoStreamIndex: boundedNullableInt(
      profile.videoStreamIndex ?? profile.video_stream_index,
      0,
      1_024,
    ),
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
    fileSizeBytes: exactPositiveSafeInteger(
      profile.fileSizeBytes ?? profile.file_size_bytes,
    ),
    probeSource: stringOrNull(profile.probeSource ?? profile.probe_source),
    probeMs: boundedNullableInt(profile.probeMs ?? profile.probe_ms, 0, 120_000),
    probedAt: stringOrNull(profile.probedAt ?? profile.probed_at),
    metadataComplete: profile.metadataComplete === true || profile.metadata_complete === true,
    mkvH264FastStartProof,
    mkvCompleteHlsCacheProof,
  });
}

function normalizeGatewayAudioRenditions(value: unknown, selectedStreamIndex: number | null) {
  // The Gateway owns the bounded simultaneous HLS cohort. Keep the Edge
  // validator compatible with every supported Gateway cohort instead of
  // hard-coding an older deployment default (8) and silently discarding a
  // valid 12-track topology.
  if (!Array.isArray(value) || value.length > 32) return null;
  // Gateway v135 deliberately returns an empty rendition cohort for a muxed
  // mono MKV. Keep that empty array distinct from a missing/malformed contract;
  // normalizeGatewayMultiAudioHls binds it to the exact codec-profile stream.
  if (value.length === 0) return [];
  if (value.length < 2) return null;
  const normalized: JsonRecord[] = [];
  const streamIndices = new Set<number>();
  for (let position = 0; position < value.length; position += 1) {
    const raw = recordOrEmpty(value[position]);
    const hlsIndex = Number(raw.hlsIndex);
    const streamIndex = Number(raw.streamIndex);
    const language = typeof raw.language === "string" ? raw.language : "";
    const title = typeof raw.title === "string" ? raw.title : "";
    const sourceChannels = Number(raw.sourceChannels);
    if (
      !Number.isInteger(hlsIndex) || hlsIndex !== position ||
      !Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 1024 ||
      streamIndices.has(streamIndex) ||
      language.length < 2 || language.length > 32 ||
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) ||
      title.length < 1 || title.length > 96 || title.trim() !== title ||
      /[\u0000-\u001f\u007f]/.test(title) ||
      !Number.isInteger(sourceChannels) || sourceChannels < 1 || sourceChannels > 64 ||
      raw.outputChannels !== 2 || raw.codec !== "aac"
    ) {
      return null;
    }
    streamIndices.add(streamIndex);
    normalized.push({
      hlsIndex,
      streamIndex,
      language,
      title,
      sourceChannels,
      outputChannels: 2,
      codec: "aac",
    });
  }
  if (selectedStreamIndex === null || !streamIndices.has(selectedStreamIndex)) return null;
  return normalized;
}

function normalizeGatewayMultiAudioHls(
  value: unknown,
  renditions: JsonRecord[] | null,
  selectedStreamIndex: number | null,
  codecProfileValue: unknown = null,
) {
  const raw = recordOrEmpty(value);
  const codecProfile = recordOrEmpty(codecProfileValue);
  const exactAudioTracks = Array.isArray(codecProfile.audioTracks)
    ? codecProfile.audioTracks
    : (Array.isArray(codecProfile.audio_tracks) ? codecProfile.audio_tracks : []);
  const exactMonoStreamIndex = Number(exactAudioTracks[0]?.index);
  const maxAudioRenditions = Number(raw.maxAudioRenditions);

  // A muxed mono playlist has no alternate HLS renditions, but it still has one
  // exact source-audio stream. Preserve only the complete signed Gateway shape
  // and bind it to the absolute stream index in the same response's codec
  // profile. This is display-only in WatchPage; it cannot enable track switching.
  if (Array.isArray(renditions) && renditions.length === 0) {
    if (
      raw.protocol !== 1 || raw.enabled !== false ||
      raw.reason !== "audio_track_count_below_minimum" ||
      !Number.isSafeInteger(maxAudioRenditions) || maxAudioRenditions < 2 || maxAudioRenditions > 32 ||
      raw.sourceTrackCount !== 1 || raw.preparedTrackCount !== 0 ||
      raw.masterPlaylist !== "playlist.m3u8" || raw.videoPlaylist !== "playlist.m3u8" ||
      raw.defaultHlsIndex !== null || raw.defaultStreamIndex !== null ||
      typeof selectedStreamIndex !== "number" ||
      !Number.isSafeInteger(selectedStreamIndex) || selectedStreamIndex < 0 || selectedStreamIndex > 1024 ||
      exactAudioTracks.length !== 1 || !Number.isSafeInteger(exactMonoStreamIndex) ||
      exactMonoStreamIndex !== selectedStreamIndex
    ) return null;
    return {
      protocol: 1,
      enabled: false,
      reason: "audio_track_count_below_minimum",
      maxAudioRenditions,
      sourceTrackCount: 1,
      preparedTrackCount: 0,
      masterPlaylist: "playlist.m3u8",
      videoPlaylist: "playlist.m3u8",
      defaultHlsIndex: null,
      defaultStreamIndex: null,
    };
  }

  if (!renditions || renditions.length < 2 || renditions.length > 32) return null;
  const defaultHlsIndex = Number(raw.defaultHlsIndex);
  const defaultStreamIndex = Number(raw.defaultStreamIndex);
  const sourceTrackCount = Number(raw.sourceTrackCount);
  const preparedTrackCount = Number(raw.preparedTrackCount);
  const defaultRendition = Number.isSafeInteger(defaultHlsIndex)
    ? renditions[defaultHlsIndex]
    : null;
  if (
    raw.protocol !== 1 || raw.enabled !== true || raw.reason !== "enabled" ||
    !Number.isSafeInteger(maxAudioRenditions) || maxAudioRenditions < 2 || maxAudioRenditions > 32 ||
    renditions.length > maxAudioRenditions ||
    !Number.isSafeInteger(sourceTrackCount) || sourceTrackCount < renditions.length || sourceTrackCount > 1024 ||
    !Number.isSafeInteger(preparedTrackCount) || preparedTrackCount !== renditions.length ||
    raw.masterPlaylist !== "playlist.m3u8" || raw.videoPlaylist !== "video.m3u8" ||
    !Number.isSafeInteger(defaultHlsIndex) || defaultHlsIndex < 0 ||
    defaultHlsIndex >= renditions.length ||
    !Number.isSafeInteger(defaultStreamIndex) || defaultStreamIndex < 0 ||
    defaultStreamIndex > 1024 || selectedStreamIndex !== defaultStreamIndex ||
    !defaultRendition || defaultRendition.streamIndex !== defaultStreamIndex
  ) {
    return null;
  }
  return {
    protocol: 1,
    enabled: true,
    reason: "enabled",
    maxAudioRenditions,
    sourceTrackCount,
    preparedTrackCount,
    masterPlaylist: "playlist.m3u8",
    videoPlaylist: "video.m3u8",
    defaultHlsIndex,
    defaultStreamIndex,
  };
}

function normalizeGatewaySubtitleLanguage(value: unknown) {
  const normalized = String(value || "und").trim().replace(/_/g, "-").toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : "und";
}

function isExactGatewayTextSubtitleCodec(value: unknown) {
  return ["ass", "movtext", "srt", "ssa", "subrip", "text", "webvtt"]
    .includes(normalizeCodecToken(value));
}

function normalizeGatewaySubtitleRenditions(value: unknown, codecProfileValue: unknown = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const codecProfile = recordOrEmpty(codecProfileValue);
  const exactTracks = Array.isArray(codecProfile.subtitles)
    ? codecProfile.subtitles
    : (Array.isArray(codecProfile.subtitleTracks)
      ? codecProfile.subtitleTracks
      : (Array.isArray(codecProfile.subtitle_tracks) ? codecProfile.subtitle_tracks : []));
  if (exactTracks.length < value.length || exactTracks.length > 32) return null;

  const exactByStreamIndex = new Map();
  for (const exactValue of exactTracks) {
    const exact = recordOrEmpty(exactValue);
    const exactStreamIndex = Number(exact.index ?? exact.streamIndex ?? exact.stream_index);
    if (!Number.isInteger(exactStreamIndex) || exactStreamIndex < 0 || exactStreamIndex > 1024 ||
      exactByStreamIndex.has(exactStreamIndex)) return null;
    exactByStreamIndex.set(exactStreamIndex, exact);
  }

  const normalized: JsonRecord[] = [];
  const streamIndices = new Set<number>();
  for (let position = 0; position < value.length; position += 1) {
    const raw = recordOrEmpty(value[position]);
    const hlsIndex = Number(raw.hlsIndex);
    const streamIndex = Number(raw.streamIndex);
    const exact = exactByStreamIndex.get(streamIndex);
    if (!exact) return null;
    const language = normalizeGatewaySubtitleLanguage(raw.language);
    const title = typeof raw.title === "string" ? raw.title : "";
    const sourceCodec = normalizeCodecToken(raw.sourceCodec ?? raw.source_codec);
    const outputCodec = normalizeCodecToken(raw.outputCodec ?? raw.output_codec);
    const exactCodec = normalizeCodecToken(exact.codec ?? exact.codecName ?? exact.codec_name);
    const exactSubtitleType = normalizeCodecToken(exact.subtitleType ?? exact.subtitle_type ?? exact.kind);
    if (
      !Number.isInteger(hlsIndex) || hlsIndex !== position ||
      !Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 1024 ||
      streamIndices.has(streamIndex) ||
      language.length < 2 || language.length > 32 ||
      language !== normalizeGatewaySubtitleLanguage(exact.language ?? exact.lang) ||
      title.length < 1 || title.length > 96 || title.trim() !== title ||
      /[\u0000-\u001f\u007f]/.test(title) ||
      !isExactGatewayTextSubtitleCodec(sourceCodec) || sourceCodec !== exactCodec ||
      outputCodec !== "webvtt" || exact.extractable !== true ||
      (exactSubtitleType && exactSubtitleType !== "text" && !isExactGatewayTextSubtitleCodec(exactSubtitleType)) ||
      typeof raw.default !== "boolean" || typeof raw.forced !== "boolean" ||
      typeof raw.hearingImpaired !== "boolean" ||
      raw.default !== (exact.default === true) || raw.forced !== (exact.forced === true) ||
      raw.hearingImpaired !== (exact.hearingImpaired === true || exact.hearing_impaired === true) ||
      raw.playlistName !== `subtitle_${hlsIndex}.m3u8` ||
      raw.segmentPattern !== `subtitle_${hlsIndex}-%05d.vtt`
    ) return null;
    streamIndices.add(streamIndex);
    normalized.push({
      hlsIndex,
      streamIndex,
      language,
      title,
      sourceCodec,
      outputCodec: "webvtt",
      default: raw.default,
      forced: raw.forced,
      hearingImpaired: raw.hearingImpaired,
      playlistName: raw.playlistName,
      segmentPattern: raw.segmentPattern,
    });
  }
  return normalized;
}

function normalizeGatewayExactSubtitleHls(
  value: unknown,
  renditions: JsonRecord[] | null,
  codecProfileValue: unknown = null,
) {
  if (!renditions || renditions.length < 1 || renditions.length > 32) return null;
  const raw = recordOrEmpty(value);
  const codecProfile = recordOrEmpty(codecProfileValue);
  const exactTracks = Array.isArray(codecProfile.subtitles)
    ? codecProfile.subtitles
    : (Array.isArray(codecProfile.subtitleTracks)
      ? codecProfile.subtitleTracks
      : (Array.isArray(codecProfile.subtitle_tracks) ? codecProfile.subtitle_tracks : []));
  const maxRenditions = Number(raw.maxRenditions);
  const sourceTrackCount = Number(raw.sourceTrackCount);
  const preparedTrackCount = Number(raw.preparedTrackCount);
  const completeGraph = raw.cacheEligible === true && raw.reason === "enabled" &&
    sourceTrackCount === preparedTrackCount;
  const completeNonCacheableGraph = raw.cacheEligible === false &&
    raw.reason === "enabled-full-noncacheable" && sourceTrackCount === preparedTrackCount;
  const partialGraph = raw.cacheEligible === false && raw.reason === "enabled-partial" &&
    sourceTrackCount > preparedTrackCount;
  if (
    raw.protocol !== 1 || raw.enabled !== true ||
    (!completeGraph && !completeNonCacheableGraph && !partialGraph) ||
    !Number.isSafeInteger(maxRenditions) || maxRenditions < 1 || maxRenditions > 32 ||
    renditions.length > maxRenditions || exactTracks.length !== sourceTrackCount ||
    !Number.isSafeInteger(sourceTrackCount) || sourceTrackCount < renditions.length ||
    !Number.isSafeInteger(preparedTrackCount) || preparedTrackCount !== renditions.length
  ) return null;
  return {
    protocol: 1,
    enabled: true,
    cacheEligible: raw.cacheEligible,
    reason: raw.reason,
    maxRenditions,
    sourceTrackCount,
    preparedTrackCount,
  };
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
          profile: stringOrNull(track.profile),
          channels: boundedNullableInt(track.channels, 0, 16),
          sampleRate: boundedNullableInt(track.sampleRate ?? track.sample_rate, 0, 384_000),
          channelLayout: stringOrNull(track.channelLayout ?? track.channel_layout),
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
        default: booleanOrNull(track.default),
        forced: booleanOrNull(track.forced),
        hearingImpaired: booleanOrNull(track.hearingImpaired ?? track.hearing_impaired),
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

function hasReliableVodCodecProfile(value: unknown) {
  const raw = recordOrEmpty(value);
  const audioTracks = raw.audioTracks ?? raw.audio_tracks;
  const subtitles = raw.subtitles ?? raw.subtitleTracks ?? raw.subtitle_tracks;
  if (!Array.isArray(audioTracks) || !Array.isArray(subtitles)) return false;
  const profile = normalizeCodecProfile(raw);
  return Boolean(
    stringOrNull(profile.videoCodec) &&
    stringOrNull(profile.audioCodec) &&
    stringOrNull(profile.container) &&
    stringOrNull(profile.probeSource) &&
    stringOrNull(profile.probedAt)
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

function authoritativeVodGatewayTier(
  playbackHintValue: unknown,
  containerObservationValue: unknown = {},
) {
  const playbackHint = recordOrEmpty(playbackHintValue);
  const profile = firstUsefulCodecProfile(
    playbackHint.codecProfile,
    playbackHint.codec_profile,
  );
  if (hasReliableVodCodecProfile(profile)) {
    // This helper is called only with resolvePlaybackTarget() output. Prefer the
    // exact probed container over any stale top-level catalogue extension.
    return compatibilityTierForCodecProfile(profile, {
      container: profile.container,
    });
  }

  const observedContainer = canonicalVodContainer(
    recordOrEmpty(containerObservationValue).container,
  );
  // A persisted prefix observation is service-only and file-bound. These
  // legacy containers have no dependable direct browser lane, even before the
  // full codec inventory has propagated to every catalogue mirror.
  if (["avi", "flv", "mpg", "ogg"].includes(String(observedContainer || ""))) {
    return "video_transcode";
  }
  return null;
}

function resolvedVodContainerAuthority(
  playbackHintValue: unknown,
  containerObservationValue: unknown = {},
  allowServerIsoBmffInference = false,
) {
  const observedContainer = canonicalVodContainer(
    recordOrEmpty(containerObservationValue).container,
  );
  if (observedContainer) return observedContainer;

  const playbackHint = recordOrEmpty(playbackHintValue);
  const profile = firstUsefulCodecProfile(
    playbackHint.codecProfile,
    playbackHint.codec_profile,
  );
  if (hasReliableVodCodecProfile(profile)) {
    const profiledContainer = canonicalVodContainer(profile.container);
    if (profiledContainer) return profiledContainer;
    // FFprobe reports ISO-BMFF as `mov,mp4,m4a,3gp,3g2,mj2`. Preserve the
    // server-resolved file extension to distinguish a real MP4 from MOV.
    const profileToken = normalizeCodecToken(profile.container);
    if (profileToken === "movmp4m4a3gp3g2mj2") {
      const resolvedContainer = canonicalVodContainer(playbackHint.container);
      if (resolvedContainer === "mp4" || resolvedContainer === "mov") {
        return resolvedContainer;
      }
      // Some Xtream catalogues advertise `.mkv` even though the provider
      // bytes are ISO-BMFF. Only a Norva-owned Gateway probe may overrule that
      // stale extension, and callers must opt in after resolving the movie
      // profile from an owned server-side row. Browser/caller hints and exact
      // episode echoes remain fail-closed.
      const probeSource = normalizeCodecToken(profile.probeSource);
      if (
        allowServerIsoBmffInference &&
        (probeSource === "gatewayprobe" || probeSource === "gatewayinband")
      ) {
        return "mp4";
      }
    }
  }
  return canonicalVodContainer(playbackHint.container);
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

// Short-TTL memo for decrypted source configuration. Visibility is checked on
// every load and the cache is keyed by the lifecycle config revision, so a
// candidate swap cannot reuse credentials from the previous revision for 60s.
// Errors/misses are never cached.
const sourceConfigCache = new Map<string, {
  value: JsonRecord;
  configRevision: string;
  configCiphertext: string;
  expiresAt: number;
}>();

async function loadSourceConfigRevision(sourceId: string, userId: string, db: SupabaseClient): Promise<string> {
  const { data, error } = await db
    .from("cloud_source_lifecycle")
    .select("config_revision")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source lifecycle revision");
  const revision = data?.config_revision;
  if ((typeof revision !== "number" && typeof revision !== "string") || !/^\d+$/.test(String(revision))) {
    throw new HttpError(409, "Source catalog is not available", {
      code: "SOURCE_CATALOG_NOT_VISIBLE",
    });
  }
  return String(revision);
}

async function assertPlaybackSourceConfigCurrent(
  sourceId: string,
  userId: string,
  expectedRevision: string,
  db: SupabaseClient,
) {
  await assertSourceCatalogVisible(sourceId, userId, db);
  const currentRevision = await loadSourceConfigRevision(sourceId, userId, db);
  if (currentRevision !== expectedRevision) {
    sourceConfigCache.delete(`${userId}:${sourceId}`);
    throw new HttpError(409, "Source configuration changed; retry", {
      code: "SOURCE_CONFIG_REVISION_CHANGED",
    });
  }
}

function isPlaybackSourceSnapshotError(error: unknown) {
  if (!(error instanceof HttpError) || !isRecord(error.details)) return false;
  return ["SOURCE_CATALOG_NOT_VISIBLE", "SOURCE_CONFIG_REVISION_CHANGED"].includes(
    stringOr(error.details.code, ""),
  );
}

async function loadSourceConfig(sourceId: string, userId: string, db: SupabaseClient) {
  return (await loadSourceConfigEnvelope(sourceId, userId, db)).config;
}

async function loadSourceConfigEnvelope(sourceId: string, userId: string, db: SupabaseClient) {
  const cacheKey = `${userId}:${sourceId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertSourceCatalogVisible(sourceId, userId, db);
    const configRevision = await loadSourceConfigRevision(sourceId, userId, db);
    const cached = sourceConfigCache.get(cacheKey);
    if (
      cached &&
      cached.configRevision === configRevision &&
      cached.expiresAt > Date.now()
    ) {
      return {
        config: cached.value,
        configRevision: cached.configRevision,
        configCiphertext: cached.configCiphertext,
      };
    }

    const { data: source, error } = await db
      .from("cloud_sources")
      .select("config_ciphertext")
      .eq("id", sourceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDb(error, "Unable to load source config");
    if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
    const configCiphertext = String(source.config_ciphertext);
    const value = await decryptSourceConfig(configCiphertext, await getRuntimeConfig(db));

    // Re-check after the ciphertext read/decrypt. If a concurrent credential
    // transition committed, retry against the new revision instead of caching
    // a value under stale lifecycle state.
    await assertSourceCatalogVisible(sourceId, userId, db);
    const confirmedRevision = await loadSourceConfigRevision(sourceId, userId, db);
    if (confirmedRevision !== configRevision) {
      sourceConfigCache.delete(cacheKey);
      continue;
    }
    sourceConfigCache.set(cacheKey, {
      value,
      configRevision,
      configCiphertext,
      expiresAt: Date.now() + 60_000,
    });
    if (sourceConfigCache.size > 500) {               // bound the isolate's memory (multi-tenant)
      for (const [k, v] of sourceConfigCache) {
        if (v.expiresAt <= Date.now()) sourceConfigCache.delete(k);
      }
    }
    return { config: value, configRevision, configCiphertext };
  }
  throw new HttpError(409, "Source configuration changed; retry", {
    code: "SOURCE_CONFIG_REVISION_CHANGED",
  });
}

async function sourceCatalogVisible(sourceId: string, userId: string, db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("norva_source_catalog_visible", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) throwDb(error, "Unable to verify source catalog visibility");
  return data === true;
}

async function assertSourceCatalogVisible(sourceId: string, userId: string, db: SupabaseClient) {
  if (await sourceCatalogVisible(sourceId, userId, db)) return;
  sourceConfigCache.delete(`${userId}:${sourceId}`);
  throw new HttpError(409, "Source catalog is not available", {
    code: "SOURCE_CATALOG_NOT_VISIBLE",
  });
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
    !ENV_MEDIA_GATEWAY_CANARY_URL ||
    !ENV_MEDIA_GATEWAY_CANARY_TOKEN ||
    !ENV_MEDIA_GATEWAY_CANARY_ID ||
    !ENV_MEDIA_GATEWAY_CANARY_USER_HASHES ||
    !ENV_LID_WORKER_URL ||
    !ENV_LID_WORKER_TOKEN ||
    !ENV_SOURCE_CONFIG_KEY ||
    !ENV_MEDIA_CACHE_WORKER_URL ||
    !ENV_MEDIA_CACHE_WORKER_TOKEN ||
    !ENV_MEDIA_CACHE_TICKET_HMAC_KEY ||
    !ENV_MEDIA_CACHE_ENABLED ||
    !ENV_MEDIA_CACHE_TICKET_TTL_SECONDS ||
    !ENV_MEDIA_CACHE_SINGLEFLIGHT_ENABLED ||
    !ENV_MEDIA_CACHE_LIVE_JOIN_ENABLED ||
    !ENV_MEDIA_CACHE_COORDINATION_HMAC_KEY ||
    !ENV_MEDIA_CACHE_FOLLOWER_WAIT_MS;

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

  const mediaGatewayUrl = trimTrailingSlash(ENV_MEDIA_GATEWAY_URL || fromDb.get("NORVA_MEDIA_GATEWAY_URL") || "");
  const mediaGatewayToken = ENV_MEDIA_GATEWAY_TOKEN || fromDb.get("NORVA_MEDIA_GATEWAY_TOKEN") || "";
  const mediaGatewayRouting = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: mediaGatewayUrl, token: mediaGatewayToken },
    canaryRoute: {
      url: ENV_MEDIA_GATEWAY_CANARY_URL || fromDb.get("NORVA_MEDIA_GATEWAY_CANARY_URL") || "",
      token: ENV_MEDIA_GATEWAY_CANARY_TOKEN || fromDb.get("NORVA_MEDIA_GATEWAY_CANARY_TOKEN") || "",
      gatewayId: ENV_MEDIA_GATEWAY_CANARY_ID || fromDb.get("NORVA_MEDIA_GATEWAY_CANARY_ID") || "",
    },
    canaryUserHashes: ENV_MEDIA_GATEWAY_CANARY_USER_HASHES ||
      fromDb.get("NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES") || "",
  }) as MediaGatewayRoutingConfig;
  const value = {
    relayBaseUrl: trimTrailingSlash(ENV_RELAY_BASE_URL || fromDb.get("NORVA_RELAY_BASE_URL") || ""),
    relayTokenSecret: ENV_RELAY_TOKEN_SECRET || fromDb.get("RELAY_TOKEN_SECRET") || "",
    mediaGatewayUrl,
    mediaGatewayToken,
    mediaGatewayRouting,
    lidWorkerUrl: trimTrailingSlash(ENV_LID_WORKER_URL || fromDb.get("NORVA_LID_WORKER_URL") || ""),
    lidWorkerToken: ENV_LID_WORKER_TOKEN || fromDb.get("NORVA_LID_WORKER_TOKEN") || "",
    sourceConfigKey: ENV_SOURCE_CONFIG_KEY || fromDb.get("NORVA_SOURCE_CONFIG_KEY") || "",
    whisperDetect: (ENV_WHISPER_DETECT || fromDb.get("NORVA_WHISPER_DETECT") || "") === "true",
    mediaCacheWorkerUrl: trimTrailingSlash(
      ENV_MEDIA_CACHE_WORKER_URL || fromDb.get("NORVA_MEDIA_CACHE_WORKER_URL") || "",
    ),
    mediaCacheWorkerToken: ENV_MEDIA_CACHE_WORKER_TOKEN || fromDb.get("NORVA_MEDIA_CACHE_WORKER_TOKEN") || "",
    mediaCacheTicketHmacKey: ENV_MEDIA_CACHE_TICKET_HMAC_KEY ||
      fromDb.get("NORVA_MEDIA_CACHE_TICKET_HMAC_KEY") || "",
    mediaCacheEnabled: (ENV_MEDIA_CACHE_ENABLED || fromDb.get("NORVA_MEDIA_CACHE_ENABLED") || "") === "true",
    mediaCacheTicketTtlSeconds: boundedInt(
      ENV_MEDIA_CACHE_TICKET_TTL_SECONDS || fromDb.get("NORVA_MEDIA_CACHE_TICKET_TTL_SECONDS"),
      90,
      30,
      300,
    ),
    mediaCacheSingleflightEnabled: (
      ENV_MEDIA_CACHE_SINGLEFLIGHT_ENABLED ||
      fromDb.get("NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED") ||
      ""
    ) === "true",
    mediaCacheLiveJoinEnabled: (
      ENV_MEDIA_CACHE_LIVE_JOIN_ENABLED ||
      fromDb.get("NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED") ||
      ""
    ) === "true",
    mediaCacheCoordinationHmacKey: ENV_MEDIA_CACHE_COORDINATION_HMAC_KEY ||
      fromDb.get("NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY") || "",
    mediaCacheFollowerWaitMs: boundedInt(
      ENV_MEDIA_CACHE_FOLLOWER_WAIT_MS || fromDb.get("NORVA_MEDIA_CACHE_FOLLOWER_WAIT_MS"),
      25_000,
      1_000,
      60_000,
    ),
  };
  runtimeConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function mediaGatewayRouteForPlaybackUser(
  runtimeConfig: RuntimeConfig,
  userId: string,
): Promise<MediaGatewayRoute | null> {
  const userHash = await sha256Hex(userId);
  const canarySelected = runtimeConfig.mediaGatewayRouting.canaryUserHashes.includes(userHash);
  const route = selectMediaGatewayRouteForUserHash(runtimeConfig.mediaGatewayRouting, userHash) as
    MediaGatewayRoute | null;
  if (canarySelected && !route) {
    throw new HttpError(503, "Media gateway canary route is unavailable", {
      code: "MEDIA_GATEWAY_CANARY_ROUTE_UNAVAILABLE",
    });
  }
  return route;
}

function mediaGatewayRoutesForProviderPreemption(
  runtimeConfig: RuntimeConfig,
): MediaGatewayRoute[] {
  const routes = new Map<string, MediaGatewayRoute>();
  for (const route of [
    runtimeConfig.mediaGatewayRouting.defaultRoute,
    runtimeConfig.mediaGatewayRouting.canaryRoute,
  ]) {
    if (!route?.url || !route.token) continue;
    // One Gateway process may be configured as both default and canary. A
    // single authenticated drain call is sufficient and avoids duplicate work.
    if (!routes.has(route.url)) routes.set(route.url, route);
  }
  return [...routes.values()];
}

async function preemptProviderLanguageValidationTransports(options: {
  db: SupabaseClient;
  targetUrl: string;
}) {
  const providerTransportKey = providerAccountKeyFromUrl(options.targetUrl);
  if (!providerTransportKey) {
    throw new Error("provider transport affinity unavailable");
  }
  const affinityHash = await sha256Hex(providerTransportKey);
  const runtimeConfig = await getRuntimeConfig(options.db);
  const routes = mediaGatewayRoutesForProviderPreemption(runtimeConfig);
  if (!routes.length) throw new Error("media gateway preemption route unavailable");

  const outcomes = await Promise.all(routes.map(async (route) => {
    const response = await fetch(`${route.url}/sessions/stop-provider-affinities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${route.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ affinityHashes: [affinityHash] }),
      signal: AbortSignal.timeout(20_000),
    });
    const bytes = await readBoundedResponseBytes(response, 65_536);
    let payload: JsonRecord = {};
    try {
      payload = recordOrEmpty(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (_) {
      throw new Error(`media gateway ${route.kind} drain response was invalid`);
    }
    if (!response.ok || payload.protocol !== 1 || payload.providerDrained !== true) {
      throw new Error(`media gateway ${route.kind} did not attest provider drain`);
    }
    return {
      kind: route.kind,
      stoppedLanguageValidations: boundedInt(
        payload.stoppedLanguageValidations,
        0,
        0,
        1_000,
      ),
    };
  }));
  return {
    protocol: 1,
    providerDrained: true,
    routes: outcomes.length,
    stoppedLanguageValidations: outcomes.reduce(
      (total, outcome) => total + outcome.stoppedLanguageValidations,
      0,
    ),
  };
}

function mediaGatewayRouteForStoredSession(
  runtimeConfig: RuntimeConfig,
  gateway: JsonRecord,
): MediaGatewayRoute | null {
  return selectMediaGatewayRouteForGatewayId(
    runtimeConfig.mediaGatewayRouting,
    stringOrNull(gateway.gateway_id),
  ) as MediaGatewayRoute | null;
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
    cascadeHealth: "inactive",
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
      cascadeHealth: !enabled
        ? "inactive"
        : (cascadeStageCount > 1 || cascadeTaggedWritesEnabled || conflict ||
            (cascadeStageCount === 1 && (primary || shadow)))
          ? "conflict"
          : (cascadeStageCount === 0 ? "inactive" : "misconfigured"),
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
      const policyShapeValid = (
        policyVersion === "lid-cascade-v1" &&
        Boolean(rolloutSeed) &&
        dailyCap > 0 &&
        Number.isFinite(expiryMs) &&
        (value.cascadeMode !== "shadow" || shadowBps > 0) &&
        (
          value.cascadeMode !== "canary" ||
          (canaryBps > 0 && canaryBps <= 1_000 && dailyCap <= 100)
        )
      );
      const expired = policyShapeValid && expiryMs <= Date.now();
      if (!policyShapeValid || expired) {
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
          cascadeHealth: expired ? "expired" : "misconfigured",
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
          cascadeHealth: expiryMs - Date.now() <= 24 * 3600_000
            ? "expiring"
            : "active",
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
      cascadeHealth: value.cascadeMode === "off"
        ? "inactive"
        : (value.cascadeHealth === "conflict" ? "conflict" : "misconfigured"),
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
    iw: "he", in: "id", ji: "yi", jw: "jv", mo: "ro", sh: "sr",
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
    (itemType !== "movie" && itemType !== "episode") ||
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
    const canonicalTrackLanguage =
      normalizeIsoLang(stringOrNull(canonicalTrack.lang)) ??
      normalizeIsoLang(stringOrNull(canonicalTrack.language));
    if (canonicalTrackLanguage) return false;

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
    if (extractResponse.status === 409 || extractResponse.status === 429) return true;
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
      body: new Uint8Array(wavBytes).buffer,
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

function basicLidConsensusSampleAccepted(
  sample: JsonRecord | null,
  expectedLang: string,
  fastPath: boolean,
): boolean {
  const lang = normalizeIsoLang(stringOrNull(sample?.language));
  const method = stringOrNull(sample?.method);
  const confidence = Number(sample?.confidence ?? 0);
  const whisperConfidence = Number(sample?.whisperConfidence ?? 0);
  const words = Number(sample?.wordCount ?? 0);
  const uniqueWords = Number(sample?.uniqueWordCount ?? 0);
  if (!lang || lang !== expectedLang || sample?.confident !== true) return false;
  if (!Number.isFinite(confidence) || confidence < 0.95 || confidence > 1) return false;
  if (fastPath) {
    return Boolean(
      method === "whisper-detect-only-v1" &&
      sample?.verified === false &&
      sample?.fastPathAccepted === true &&
      sample?.fallbackUsed === false &&
      sample?.validationStatus === "pending" &&
      sample?.evidence === "lid-only-high-confidence" &&
      words === 0
    );
  }
  const methodCalibrated = method === "whisper-transcript-agreement-v1"
    ? sample?.transcriptAgrees === true &&
      Number.isFinite(whisperConfidence) &&
      whisperConfidence >= 0.95 &&
      whisperConfidence <= 1
    : method === "whisper" || method === "transcript";
  return Boolean(
    methodCalibrated &&
    Number.isFinite(words) &&
    words >= 12 &&
    Number.isFinite(uniqueWords) &&
    uniqueWords >= 8
  );
}

// Detect-only and transcript evidence stay explicitly distinct. wordCount=0 is correct
// for -dl and can never be confused with a transcript. Transcript evidence must itself
// be information-rich and agree across at least two windows before it can change a
// tenant-scoped exact-file map.
function basicLidEvidence(det: JsonRecord | null): BasicLidEvidence {
  const lang = normalizeIsoLang(stringOrNull(det?.language));
  const confidence = Number(det?.confidence ?? 0);
  const consensus = Number(det?.consensus ?? 0);
  const fastPath = det?.method === "whisper-detect-only-v1";
  const samples = Array.isArray(det?.samples) ? det.samples as JsonRecord[] : [];
  const matchingSamples = lang
    ? samples.filter((sample) => basicLidConsensusSampleAccepted(sample, lang, fastPath))
    : [];
  if (fastPath) {
    const accepted = Boolean(
      lang &&
      basicLidConsensusSampleAccepted(det, lang, true) &&
      Number.isFinite(consensus) &&
      consensus >= 2 &&
      matchingSamples.length >= 2,
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
    accepted: Boolean(
      lang &&
      basicLidConsensusSampleAccepted(det, lang, false) &&
      Number.isFinite(consensus) &&
      consensus >= 2 &&
      matchingSamples.length >= 2,
    ),
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
  try { return new URL(url).host; } catch { return ""; }
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
    const fanoutRpc = itemType === "episode"
      ? "fanout_episode_file_tracks_to_users"
      : audioDetectionWrite
      ? "fanout_detected_file_tracks_to_users"
      : "norva_fanout_file_tracks_to_users_fenced";
    let { data, error } = await db.rpc(fanoutRpc, canonicalArgs);
    if (
      fanoutRpc === "norva_fanout_file_tracks_to_users_fenced" &&
      error &&
      isRollingRpcUnavailable(error)
    ) {
      ({ data, error } = await db.rpc("fanout_file_tracks_to_users", canonicalArgs));
    }
    const persisted = !error && Number(data) > 0;
    if (persisted && itemType === "movie" && audioDetectionWrite && canonicalArgs.p_has_audio) {
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
// identity at the same time. New provider I/O is fail-closed: a missing identity,
// unavailable RPC or ambiguous response must defer the crawler rather than risk a
// second connection beside human playback.
async function claimProviderFileProbe(
  db: SupabaseClient,
  identityKey: string,
  owner: string,
  ttlSeconds = 150,
): Promise<boolean> {
  if (!identityKey || !owner) return false;
  try {
    const { data, error } = await db.rpc("claim_provider_file_probe", {
      p_identity_key: identityKey,
      p_lease_owner: owner,
      p_ttl_seconds: Math.max(30, Math.min(900, Math.round(ttlSeconds))),
    });
    if (error) return false;
    return data === true;
  } catch (_) {
    return false;
  }
}

async function resolveCandidateProviderIdentityKey(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  preResolvedIdentityKey = "",
): Promise<string> {
  if (preResolvedIdentityKey) return preResolvedIdentityKey;
  return (await resolveSourceIdentity(sourceId, userId, db)).key || "";
}

function newProviderProbeLeaseOwner(prefix: string, candidateId: string): string {
  const boundedCandidate = String(candidateId || "candidate").slice(0, 128);
  // claim_provider_file_probe deliberately allows same-owner re-entry. Every
  // concurrent candidate therefore needs its own owner, even inside one tick.
  return `${prefix}:${boundedCandidate}:${crypto.randomUUID()}`;
}

function authoritativeProbeFacetComplete(marker: unknown, legacyEvidence: boolean): boolean {
  if (marker === true) return true;
  if (marker === false) return false;
  // Compatibility is limited to old responses that omitted the marker. An
  // explicit false is authoritative and can never be promoted by another facet.
  return marker == null && legacyEvidence === true;
}

function subtitleProbeObservation(
  marker: unknown,
  legacyEvidence: boolean,
  tracks: JsonRecord[],
  probedAt: string,
) {
  const complete = authoritativeProbeFacetComplete(marker, legacyEvidence);
  return {
    complete,
    fields: complete
      ? { subtitle_tracks: tracks, subtitle_probed_at: probedAt }
      : {},
  };
}

function createProviderIdentitySerialQueue() {
  const tails = new Map<string, Promise<void>>();
  return async function runSerial<T>(identityKey: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(identityKey) ?? Promise.resolve();
    let unlock: () => void = () => {};
    const current = new Promise<void>((resolve) => { unlock = () => resolve(); });
    tails.set(identityKey, current);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      unlock();
      if (tails.get(identityKey) === current) tails.delete(identityKey);
    }
  };
}

type ProviderProbeLeaseOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "lease-busy" }
  | { status: "guard-unavailable" }
  | { status: "circuit-open"; openUntil: string | null };

async function runProviderProbeWithLease<T>(
  db: SupabaseClient,
  identityKey: string,
  owner: string,
  ttlSeconds: number,
  task: (control: { retainUntilExpiry: () => void }) => Promise<T>,
): Promise<ProviderProbeLeaseOutcome<T>> {
  if (!identityKey || !await claimProviderFileProbe(db, identityKey, owner, ttlSeconds)) {
    return { status: "lease-busy" };
  }
  let releaseLeaseOnExit = true;
  try {
    let circuit: { open: boolean; openUntil: string | null };
    try {
      circuit = await readProviderProbeCircuitStateStrict(db, identityKey);
    } catch (_) {
      // The task is the only callback allowed to touch the provider. Returning
      // here gives an RPC failure a mechanically testable zero-I/O boundary.
      return { status: "guard-unavailable" };
    }
    if (circuit.open) {
      return { status: "circuit-open", openUntil: circuit.openUntil };
    }
    return {
      status: "completed",
      value: await task({ retainUntilExpiry: () => { releaseLeaseOnExit = false; } }),
    };
  } finally {
    if (releaseLeaseOnExit) {
      await releaseProviderFileProbe(db, identityKey, owner);
    }
  }
}

async function providerAccountBusyForCrawler(
  db: SupabaseClient,
  accountKey: string,
): Promise<boolean> {
  if (!accountKey) return true;
  try {
    // A completed crawler probe records `catalog-refresh` activity for the
    // generic playback/validation fences.  Re-reading that generic fence here
    // makes the next sequential fleet lane mistake its own already-drained
    // activity for a viewer and starves the dedicated repair lanes.  The
    // catalog-refresh fence ignores only passive presence and the crawler's
    // own released activity; playback, language validation and unknown fresh
    // holders still fail closed.  File-probe leases and the Gateway drain
    // attestation continue to serialize the actual provider connection.
    const { data, error } = await db.rpc(
      "provider_account_busy_for_catalog_refresh",
      { p_key: accountKey },
    );
    if (error) return true;
    // Only an explicit false is permission to open a new provider connection.
    return data !== false;
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
function runBackground(p: PromiseLike<unknown>): void {
  const task = Promise.resolve(p).catch(() => {});
  try {
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(task);
  } catch (_) { /* fire-and-forget */ }
}

async function enqueueAutomaticStrictLanguageValidation(options: {
  db: SupabaseClient;
  userId: string;
  sourceId: string;
  identityKey: string;
  itemType: "movie" | "episode";
  itemId: string;
  variantId: string;
  profile: unknown;
  providerDrainAttested?: boolean;
}) {
  const {
    db, userId, sourceId, identityKey, itemType, itemId, variantId, profile,
    providerDrainAttested = false,
  } = options;
  if (!variantId || !itemId || !identityKey) return false;
  const lidPolicy = await getLidDetectionPolicy(db);
  if (!lidPolicy.enabled) return false;
  // Episode profiles are created by a fresh provider-facing /probe-audio call.
  // A successful HTTP status alone is not drainage proof, so the enqueue is
  // mechanically impossible until the same response attests protocol v1.
  if (itemType === "episode" && providerDrainAttested !== true) return false;
  await assertSourceCatalogVisible(sourceId, userId, db);
  const currentIdentityKey = await loadLanguageValidationIdentity(db, userId, sourceId);
  if (currentIdentityKey !== identityKey) return false;

  const exactProfile = exactLanguageValidationProfileFromGateway(profile, variantId, itemType);
  const exactAudioIndices = exactProfile.audioTracks
    .map((track) => Number(track.index))
    .sort((left, right) => left - right);
  requireStrictLidWindowCount(Number(exactProfile.profile.durationSeconds));

  let cache = await loadLanguageValidationCache(db, identityKey, itemType, itemId);
  let cachedAudioTracks = cache
    ? exactCachedAudioTracks(cache.audio_tracks, exactAudioIndices)
    : null;
  if (!cachedAudioTracks) {
    // The only accepted automatic snapshot is the exact Gateway response from
    // this file. Repairing the canonical inventory here opens no extra provider
    // connection and still leaves every `und` language unpublished.
    const stored = await shareFileTracks(
      db,
      identityKey,
      itemType,
      itemId,
      exactProfile.audioTracks,
      [],
      true,
      false,
    );
    if (!stored) return false;
    cache = await loadLanguageValidationCache(db, identityKey, itemType, itemId);
    cachedAudioTracks = cache
      ? exactCachedAudioTracks(cache.audio_tracks, exactAudioIndices)
      : null;
  }
  if (!cache || !cachedAudioTracks) return false;

  const profileFingerprint = await languageValidationProfileFingerprint(
    exactProfile.profile,
    exactProfile.audioTracks,
    exactProfile.fileSizeBytes,
  );
  if (cachedStrictLanguageValidation(cache, exactAudioIndices, {
    profileFingerprint,
    profileProbedAt: exactProfile.profileProbedAt,
    fileSizeBytes: exactProfile.fileSizeBytes,
  })) return true;

  const retryAtMs = Date.parse(stringOr(cache.audio_lang_retry_at, ""));
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) return false;
  const { data, error } = await db.rpc("start_automatic_catalog_file_audio_validation_job", {
    p_requested_by: userId,
    p_source_id: sourceId,
    p_variant_id: variantId,
    p_identity_key: identityKey,
    p_item_type: itemType,
    p_external_id: itemId,
    p_expected_audio_indices: exactAudioIndices,
    p_profile: exactProfile.profile,
    p_profile_fingerprint: profileFingerprint,
    p_profile_probed_at: exactProfile.profileProbedAt,
    p_file_size_bytes: exactProfile.fileSizeBytes,
    p_cached_audio_tracks: cachedAudioTracks,
    p_provider_drain_attested: itemType === "episode" && providerDrainAttested === true,
  });
  if (error) throw error;
  const started = recordOrEmpty(data);
  // Automatic callers still hold the distributed provider-file lease. The
  // minute worker schedules this durable row only after that lease is released,
  // so no enqueue can create a second simultaneous provider connection.
  return PLAYBACK_SESSION_UUID_PATTERN.test(stringOr(started.jobId, ""));
}

// Automatic UNTAGGED audio enrichment is certificate-only. An exact file may
// publish a language only after the durable 4/6-window strict job finalizes.
// The older cascade/basic detectors remain below solely for legacy title-level
// maintenance and can no longer write an exact-file language or facet.
async function detectUntaggedAudioLanguages(opts: {
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  userId: string;
  sourceId: string;
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
    db, runtimeConfig, userId, sourceId, targetUrl, userAgent, audioTracks, titleId, tmdbId,
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
  if (fileScoped && itemType === "movie" && variantId) {
    try {
      const exactProfile = await loadExactLanguageValidationProfile(
        db,
        userId,
        sourceId,
        fileExternalId,
      );
      await enqueueAutomaticStrictLanguageValidation({
        db,
        userId,
        sourceId,
        identityKey: serverHost,
        itemType: "movie",
        itemId: fileExternalId,
        variantId,
        profile: exactProfile.profile,
      });
    } catch (_) {
      // Keep the canonical language null and the candidate retryable. A missing
      // exact profile is not permission to fall back to provisional LID.
    }
    return;
  }
  if (fileScoped && itemType === "episode") {
    // Episode jobs are created in the exact Gateway probe lane, where the
    // profile and provider-drain attestation belong to the same connection.
    // Never open a second probe from this legacy whisper lane.
    return;
  }
  let catalogGeneration: ActiveCatalogGeneration | null = null;
  if (fileScoped && variantId) {
    try {
      catalogGeneration = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
    } catch (error) {
      if (isCatalogGenerationSuperseded(error)) return;
      throw error;
    }
  }
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
  // The basic detector sweeps bounded offsets inside the gateway and now requires
  // two independent 20s windows to agree before an unknown language is published.
  // Two tracks per file keep work bounded and per-track cursors make larger
  // multi-audio files resumable. A low-confidence or split verdict remains pending.
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
            `${detectBase}?index=${track.index}&dur=20&consensus=2`,
            { signal: AbortSignal.timeout(180_000) },
          );
          // Transport/provider failures are not observations. Leave only this track due instead
          // of suppressing it for the retry window; another track may still be readable.
          if (!res.ok) continue;
          const det = await res.json().catch(() => null) as JsonRecord | null;
          const evidence = basicLidEvidence(det);
          const multiWindowConsensus = Number(det?.consensus ?? 0) >= 2;
          track.lidAttemptedAt = nowIso;
          // The legacy path still needs >=4 transcript words. Detect-only instead carries
          // an explicit high-confidence evidence contract and correctly reports zero words.
          if (evidence.accepted && evidence.lang && multiWindowConsensus) {
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
  // Basic/provisional LID remains exact-file and tenant scoped. A global
  // title-language UNION cannot unlearn a false positive; only the strict LID
  // certification path may promote verified language evidence globally.
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
        ...(catalogGeneration ? catalogGenerationRpcFence(catalogGeneration) : {}),
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
          consensus: 2,
          acceptance: "two-window-gateway-consensus-v3",
          detectOnlyDetectedCount,
          transcriptDetectedCount,
          trackCount: unknownTracks.length,
          pendingCount,
          attemptedAt: nowIso,
        },
      });
      if ((error || data !== true) && itemType === "movie" && catalogGeneration) {
        await patchActiveCatalogTitleVariants(db, {
          userId,
          sourceId,
          generation: catalogGeneration,
          id: variantId,
          patch: completed
            ? { audio_whisper_attempted_at: nowIso, audio_whisper_retry_at: null }
            : { audio_whisper_retry_at: retryAt },
        });
      }
    } catch (_) { /* rolling migration fallback retries naturally */ }
  }
}

// Verify TAGGED-but-contradictory tracks (mistagged containers — "German" on a French film).
// Providers mux scene releases with wrong container language tags; the probe stores tags as-is
// and whisper LID only ever ran on UNTAGGED tracks, so a wrong tag was permanent and
// user-visible (player audio menu prefers cloud audio_tracks; language filters use
// audio_languages). This listens to the ACTUAL speech via the gateway's whisper.cpp and
// rewrites the track lang only after two high-confidence, information-rich speech windows agree.
// Returns "corrected" | "detected" | "pending" — or null on a TRANSIENT failure (byte-pipe
// down, every clip 503/timeout), which must NOT mark the title verified (retry next tick).
// A non-verdict is a retryable "pending" state, never a guessed language.
async function verifyTaggedAudioLanguages(opts: {
  db: SupabaseClient;
  runtimeConfig: RuntimeConfig;
  userId: string;
  sourceId: string;
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
    db, runtimeConfig, userId, sourceId, targetUrl, audioTracks, suspectLangs, titleId,
    serverHost, itemType, fileExternalId, expiresAt, variantId,
    fileScoped = false,
  } = opts;
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) return null;
  let catalogGeneration: ActiveCatalogGeneration | null = null;
  if (fileScoped && variantId) {
    try {
      catalogGeneration = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
    } catch (error) {
      if (isCatalogGenerationSuperseded(error)) return null;
      throw error;
    }
  }
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
          ...(catalogGeneration ? catalogGenerationRpcFence(catalogGeneration) : {}),
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
        if ((error || data !== true) && itemType === "movie" && catalogGeneration) {
          await patchActiveCatalogTitleVariants(db, {
            userId,
            sourceId,
            generation: catalogGeneration,
            id: variantId,
            patch: completed
              ? { audio_whisper_attempted_at: nowIso, audio_whisper_retry_at: retryAt }
              : { audio_whisper_retry_at: retryAt },
          });
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
    // Conservative two-window basic LID is useful tenant-scoped detection
    // evidence, not a strict certificate. Persist the corrected exact-file map
    // and a long retry cursor, but never create audio_verified_at, a global title
    // union or a user-facing "confirmed" claim.
    await recordDetection(classified, {
      method: "whisper-basic-v1",
      detectionMethods: [...detectionMethods].sort(),
      status: classified ? "detected" : "pending",
      sampleDurationSeconds: 20,
      consensus: 2,
      minConfidence: 0.95,
      minWords: 12,
      minUniqueWords: 8,
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

  let transient = 0, attempted = 0;
  for (const t of suspects) {
    try {
      const res = await fetch(
        `${detectBase}?index=${t.index}&dur=20&consensus=2`,
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
    // Basic mistag correction is still provisional. Keep it tenant/file scoped;
    // strict LID owns the only verified global promotion path.
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
const PLAYBACK_CATALOG_TITLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function hydrateVisiblePlaybackTitles(
  db: SupabaseClient,
  userId: string,
  titleIds: string[],
  requireAll = false,
): Promise<JsonRecord[]> {
  const visibilityEpoch = latestBoundCatalogVisibilityEpoch(userId);
  if (!visibilityEpoch || !/^[1-9][0-9]*$/.test(visibilityEpoch)) {
    throw new HttpError(503, "Catalog visibility is temporarily unavailable");
  }
  const orderedIds = [...new Set(titleIds.map((value) => {
    const id = String(value ?? "");
    if (!PLAYBACK_CATALOG_TITLE_UUID.test(id)) throw new HttpError(400, "Invalid title id");
    return id.toLowerCase();
  }))];
  if (!orderedIds.length) return [];
  const byId = new Map<string, JsonRecord>();
  for (let index = 0; index < orderedIds.length; index += 500) {
    const chunk = orderedIds.slice(index, index + 500);
    const { data, error } = await db.rpc("norva_get_visible_catalog_titles_by_ids", {
      p_user_id: userId,
      p_title_ids: chunk,
      p_expected_visibility_epoch: visibilityEpoch,
    });
    const epoch = isRecord(data) && (typeof data.visibilityEpoch === "number"
        || typeof data.visibilityEpoch === "string")
      ? String(data.visibilityEpoch)
      : "";
    if (error || !isRecord(data) || data.contract !== "catalog-title-hydration-v3"
        || epoch !== visibilityEpoch || !Array.isArray(data.items)) {
      throw new HttpError(503, "Catalog visibility is temporarily unavailable");
    }
    for (const value of data.items) {
      if (!isRecord(value)) throw new HttpError(503, "Catalog visibility is temporarily unavailable");
      const id = String(value.id ?? "").toLowerCase();
      if (!chunk.includes(id) || byId.has(id) || String(value.user_id ?? "") !== userId) {
        throw new HttpError(503, "Catalog visibility is temporarily unavailable");
      }
      if (Number(value.variant_count ?? 0) > 0) byId.set(id, value);
    }
  }
  if (requireAll && orderedIds.some((id) => !byId.has(id))) {
    throw new HttpError(409, "Catalog changed while playback work was running");
  }
  return orderedIds.map((id) => byId.get(id)).filter((row): row is JsonRecord => !!row);
}

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
    .from("cloud_catalog_visible_title_variants")
    .select("id,title_id,external_id,codec_profile")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .eq("item_type", itemType)
    .eq("external_id", externalId)
    .limit(1)
    .maybeSingle();
  const titleId = variant ? stringOrNull((variant as JsonRecord).title_id) : null;
  if (!titleId) return null;
  const row = (await hydrateVisiblePlaybackTitles(db, userId, [titleId]))[0] ?? null;
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
  const trow = (await hydrateVisiblePlaybackTitles(db, userId, [titleId]))[0] ?? null;
  const variantId = stringOr((trow as JsonRecord | null)?.default_variant_id, "");
  if (!variantId) throw new HttpError(404, "title or variant not found");
  const { data: variant } = await db.from("cloud_catalog_visible_title_variants")
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
    const { data } = await db.from("cloud_catalog_visible_media_items").select("external_id")
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

async function generatedSubtitleIncumbentResponse(
  db: SupabaseClient,
  claimRow: JsonRecord | null,
  base: JsonRecord,
): Promise<JsonRecord> {
  const claimStatus = stringOr(claimRow?.status, "processing");
  const claimJobId = stringOr(claimRow?.job_id, "");
  if (claimStatus !== "processing") {
    return { ...base, status: claimStatus, cached: true, jobId: claimJobId || null };
  }
  if (!claimJobId) {
    return { ...base, status: "error", cached: true, jobId: null, error: "subtitle job was not durably created" };
  }

  // The claim row is durable before the outbound gateway request is accepted.
  // Read the current milestone instead of calling that small pre-enqueue window
  // "queued".  A gateway heartbeat is also accepted as durable evidence in
  // case the best-effort queued timestamp write was interrupted after HTTP 202.
  const { data, error } = await db.from("catalog_generated_subtitles")
    .select("status, job_id, stage, enqueued_at")
    .eq("job_id", claimJobId)
    .maybeSingle();
  if (error) throwDb(error, "subtitle incumbent lookup failed");
  const current = data as JsonRecord | null;
  const status = stringOr(current?.status, claimStatus);
  const jobId = stringOr(current?.job_id, claimJobId);
  const stage = stringOr(current?.stage, "");
  const gatewayEvidence = Boolean(current?.enqueued_at)
    || ["queued", "deferred", "extracting", "transcribing", "first_vtt"].includes(stage);
  if (status === "processing" && !gatewayEvidence) {
    return { ...base, status: "starting", cached: true, jobId, stage: "enqueueing" };
  }
  return { ...base, status, cached: true, jobId: jobId || null, stage: stage || null };
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
  const requestedAt = new Date().toISOString();
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
  const resolvedAt = new Date().toISOString();
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
    return await generatedSubtitleIncumbentResponse(db, claimRow, { providerKey: pkey });
  }
  // Reset the milestone columns when a stale/failed row is reclaimed. Timing
  // instrumentation is best-effort and must never strand an otherwise valid
  // provider-safe job before it reaches the gateway.
  const { error: timingResetError } = await db.from("catalog_generated_subtitles").update({
    requested_at: requestedAt,
    resolved_at: resolvedAt,
    stage: null,
    enqueued_at: null,
    extraction_started_at: null,
    whisper_started_at: null,
    first_vtt_at: null,
    ready_at: null,
  }).eq("job_id", jobId).eq("status", "processing");
  if (timingResetError) console.error("[norva-playback] generated subtitle timing reset failed", timingResetError.message);
  const idx = Number.isInteger(Number(opts.index)) ? Number(opts.index) : 1;
  const bStart = Math.max(0, Number(opts.start) || 0);
  const bDur = Math.max(0, Number(opts.dur) || 0); // 0 = whole film (prod); >0 = clip (pipeline test)
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const pipe = await createBytePipeAccess("transcribe-job", userId, tUrl, exp, db, null);
    const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
    // origin (hoisted above, it also drives the viewer guards) sets the gateway's priority class:
    // a viewer waiting in front of the player jumps ahead of the nightly pregen batch.
    const asyncUrl = `${pipe.url.replace("/raw/", "/transcribe-async/")}?index=${idx}&jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&start=${bStart}&dur=${bDur}&origin=${origin}`;
    const gw = await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (error) {
    gwStatus = 0;
    console.error("[norva-playback] generated subtitle gateway enqueue failed", error instanceof Error ? error.message : String(error));
  }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    // An enqueue failure is terminal like a callback failure: resolve any pending email/bell
    // subscriptions instead of leaving them orphaned forever (audit 2026-07-17, gap n°3).
    try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "transcript", lang: "src", status: "failed" }); }
    catch (_) { /* best-effort */ }
    return { status: "error", jobId, providerKey: pkey, gatewayStatus: gwStatus, gateway: gwBody };
  }
  const { data: stageMarked, error: stageError } = await db.rpc("mark_generated_subtitle_stage", {
    p_job_id: jobId,
    p_stage: "queued",
    p_at: new Date().toISOString(),
  });
  if (stageError || stageMarked !== true) {
    console.error("[norva-playback] generated subtitle enqueue timing failed", stageError?.message ?? "row not processing");
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
    return await generatedSubtitleIncumbentResponse(db, claimRow, { providerKey: pkey, kind: "ocr", lang });
  }
  const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const tessLang = TESS_LANG_MAP[lang] || "";
  const fmt = ["pgs", "vobsub", "dvb"].includes(stringOr(opts.fmt, "")) ? stringOr(opts.fmt, "") : "pgs";
  let gwStatus = 0, gwBody: JsonRecord | null = null;
  try {
    const pipe = await createBytePipeAccess("ocr-job", userId, tUrl, exp, db, null);
    const cbUrl = `${PUBLIC_ORIGIN}/functions/v1/norva-playback/transcribe-callback`;
    const asyncUrl = `${pipe.url.replace("/raw/", "/ocr-async/")}?index=${idx}&jobId=${jobId}&callback=${encodeURIComponent(cbUrl)}&fmt=${fmt}${tessLang ? `&lang=${tessLang}` : ""}`;
    const gw = await fetch(asyncUrl, { method: "POST", signal: AbortSignal.timeout(20000) });
    gwStatus = gw.status; gwBody = await gw.json().catch(() => null) as JsonRecord | null;
  } catch (error) {
    gwStatus = 0;
    console.error("[norva-playback] generated OCR gateway enqueue failed", error instanceof Error ? error.message : String(error));
  }
  if (gwStatus !== 202) {
    await db.from("catalog_generated_subtitles").update({ status: "failed", error: `enqueue gateway ${gwStatus}`, updated_at: new Date().toISOString() }).eq("job_id", jobId);
    try { await dispatchSubtitleNotifications(db, { provider_key: pkey, item_type: itemType, external_id: externalId, kind: "ocr", lang: cacheLang, status: "failed" }); }
    catch (_) { /* best-effort */ }
    return { status: "error", jobId, providerKey: pkey, kind: "ocr", lang, gatewayStatus: gwStatus, gateway: gwBody };
  }
  const { data: stageMarked, error: stageError } = await db.rpc("mark_generated_subtitle_stage", {
    p_job_id: jobId,
    p_stage: "queued",
    p_at: new Date().toISOString(),
  });
  if (stageError || stageMarked !== true) {
    console.error("[norva-playback] generated OCR enqueue timing failed", stageError?.message ?? "row not processing");
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
  const COLS = "status, vtt, source_lang, segments, audio_sec, job_id, updated_at, error, stage, claimed_by, requested_at, resolved_at, enqueued_at, extraction_started_at, whisper_started_at, first_vtt_at, ready_at";
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
  const persistedStatus = stringOr(rec.status, "none");
  const jobId = stringOr(rec.job_id, "");
  // A processing label without a durable job id is not a queue.  Fail open to
  // `none` so the client can perform one real atomic enqueue instead of polling
  // a zombie row forever.
  if (persistedStatus === "processing" && !jobId) {
    return { status: "none", providerKey: pkey, kind, lang, why: "missing-job" };
  }
  const persistedStage = stringOr(rec.stage, "");
  const gatewayEvidence = Boolean(rec.enqueued_at)
    || ["queued", "deferred", "extracting", "transcribing", "first_vtt"].includes(persistedStage);
  const status = persistedStatus === "processing" && !gatewayEvidence ? "starting" : persistedStatus;
  const partialVtt = persistedStatus === "processing" ? stringOr(rec.vtt, "") : "";
  return {
    status, kind, lang, providerKey: pkey, jobId: jobId || null,
    sourceLang: rec.source_lang ?? null, segments: rec.segments ?? null, audioSec: rec.audio_sec ?? null,
    updatedAt: rec.updated_at ?? null,
    // The real failure cause (creds-redacted at the source) — the player shows a short human
    // reason and keeps the full text in a tooltip, instead of a blind "failed — retry".
    error: status === "failed" ? stringOrNull(rec.error) : null,
    // Honest progress: gateway heartbeats stamp the stage (queued/deferred/extracting/
    // transcribing); "deferred because of YOUR playback" only when the requester is the claimer.
    stage: status === "starting" ? "enqueueing" : (status === "processing" ? stringOrNull(rec.stage) : null),
    deferredByYou: status === "processing" && persistedStage === "deferred" && stringOr(rec.claimed_by, "") === userId,
    // Progressive delivery: a partial VTT streams in while transcription continues.
    partial: Boolean(partialVtt),
    vtt: status === "ready" ? stringOr(rec.vtt, "") : (partialVtt || null),
    timings: {
      requestedAt: rec.requested_at ?? null,
      resolvedAt: rec.resolved_at ?? null,
      enqueuedAt: rec.enqueued_at ?? null,
      extractionStartedAt: rec.extraction_started_at ?? null,
      whisperStartedAt: rec.whisper_started_at ?? null,
      firstVttAt: rec.first_vtt_at ?? null,
      readyAt: rec.ready_at ?? null,
    },
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
// enabled=false deletes the subscription. A transactional outbox queues delivery when the job lands.
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
    // The legacy column remains NOT NULL, but the worker resolves the current Auth
    // identity at send time. Never persist a redundant recipient snapshot here.
    user_id: userId, email: "", provider_key: pkey, item_type: itemType, external_id: externalId,
    kind, lang, title_label: titleLabel, source_id: sourceId || null, series_id: seriesId,
  };

  // Reject an opt-in whose work already ended without usable subtitles. Ready work is handled by
  // the durable outbox trigger below: the subscription and delivery are committed together, so a
  // late opt-in cannot be orphaned and this request never performs provider/network email I/O.
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
  }

  const { data: notification, error } = await db.from("catalog_generated_subtitle_notifications").upsert({
    ...subRow, status: "pending", created_at: nowIso, sent_at: null,
  }, { onConflict: "user_id,provider_key,item_type,external_id,kind,lang" }).select("id").maybeSingle();
  if (error) throwDb(error, "notify registration failed");
  const notificationId = stringOr((notification as JsonRecord | null)?.id, "");
  if (!notificationId) throw new HttpError(500, "notify registration returned no id");

  if (cacheStatus === "ready") {
    // The AFTER trigger normally queues this during the upsert transaction. This explicit call is
    // an idempotent reconciliation path for rolling deploys and makes a queue failure observable.
    const { error: queueError } = await db.rpc("queue_subtitle_ready_email_deliveries", {
      p_notification_id: notificationId,
      p_provider_key: null,
      p_item_type: null,
      p_external_id: null,
      p_kind: null,
      p_lang: null,
    });
    if (queueError) throwDb(queueError, "subtitle email queue failed");
    return { ok: true, enabled: true, already: "ready", email_queued: true };
  }
  return { ok: true, enabled: true, email_queued: false };
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

interface SubtitleEmailClaim {
  delivery_id: string;
  notification_id: string;
  delivery_key: string;
  lease_token: string;
  user_id: string;
  title_label: string | null;
  source_id: string | null;
  series_id: string | null;
  item_type: string;
  external_id: string;
  kind: string;
  lang: string;
  attempt_count: number;
}

interface PreparedSubtitleEmail {
  recipient_email: string;
  request_from: string;
  request_reply_to: string;
  request_subject: string;
  request_html: string;
  request_text: string;
  request_tags: Array<{ name: string; value: string }>;
}

interface SubtitleEmailTransportResult {
  ok: boolean;
  retryable: boolean;
  ambiguous: boolean;
  httpStatus: number | null;
  emailId: string | null;
  response: JsonRecord | null;
  error: string | null;
  retryAfterSeconds: number | null;
}

function subtitleEmailSafeError(value: unknown): string {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:bearer\s+)?[A-Za-z0-9_-]{40,}/gi, "[redacted-token]")
    .slice(0, 2_000);
}

async function subtitleEmailResponsePayload(response: Response): Promise<JsonRecord | null> {
  const raw = (await response.text().catch(() => "")).slice(0, 16_384);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { message: subtitleEmailSafeError(raw) };
    }
    // Resend responses need only these fields for acknowledgement/diagnostics.
    // Do not persist arbitrary echoed request data or recipient addresses.
    const source = parsed as JsonRecord;
    const safe: JsonRecord = {};
    if (typeof source.id === "string") safe.id = source.id.slice(0, 300);
    for (const key of ["name", "message", "error"]) {
      if (typeof source[key] === "string") safe[key] = subtitleEmailSafeError(source[key]);
    }
    return Object.keys(safe).length ? safe : { message: `Resend HTTP ${response.status}` };
  } catch (_) {
    return { message: subtitleEmailSafeError(raw) };
  }
}

function subtitleEmailPayloadMessage(payload: JsonRecord | null): string {
  for (const key of ["message", "error", "name"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function subtitleEmailRetryableStatus(status: number | null, payload: JsonRecord | null): boolean {
  if (status === 409) {
    const type = String(payload?.name ?? payload?.error ?? "").trim().toLowerCase();
    if (type === "concurrent_idempotent_requests") return true;
    if (type === "invalid_idempotent_request") return false;
    const detail = [type, subtitleEmailPayloadMessage(payload)].join(" ").toLowerCase();
    return /concurrent|in[_ -]?progress|already processing/.test(detail)
      && !/invalid|mismatch|different payload|expired/.test(detail);
  }
  return status === null || status === 401 || status === 403 || status === 408
    || status === 425 || status === 429 || (status !== null && status >= 500);
}

function subtitleEmailAmbiguousStatus(status: number | null, retryable: boolean): boolean {
  return status === null || status === 408 || status === 425 || status === 429
    || (status !== null && status >= 500) || (status === 409 && retryable);
}

function subtitleEmailRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(86_400, Math.ceil(seconds)));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(86_400, Math.ceil((at - Date.now()) / 1000)));
}

async function sendPreparedSubtitleEmail(
  claim: SubtitleEmailClaim,
  prepared: PreparedSubtitleEmail,
): Promise<SubtitleEmailTransportResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Norva-Subtitle-Email/2.0",
        "Idempotency-Key": claim.delivery_key,
      },
      body: JSON.stringify({
        from: prepared.request_from,
        reply_to: prepared.request_reply_to,
        to: [prepared.recipient_email],
        subject: prepared.request_subject,
        html: prepared.request_html,
        text: prepared.request_text,
        tags: prepared.request_tags,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    const response = await subtitleEmailResponsePayload(res);
    const emailId = typeof response?.id === "string" && response.id.trim() ? response.id.trim() : null;
    if (res.ok && emailId) {
      return {
        ok: true, retryable: false, ambiguous: false,
        httpStatus: res.status, emailId, response,
        error: null, retryAfterSeconds: null,
      };
    }
    const retryable = res.ok || subtitleEmailRetryableStatus(res.status, response);
    return {
      ok: false,
      retryable,
      ambiguous: res.ok || subtitleEmailAmbiguousStatus(res.status, retryable),
      httpStatus: res.status,
      emailId: null,
      response,
      error: res.ok
        ? "Resend returned success without an email id"
        : (subtitleEmailPayloadMessage(response) || `Resend HTTP ${res.status}`),
      retryAfterSeconds: subtitleEmailRetryAfter(res.headers.get("retry-after")),
    };
  } catch (error) {
    return {
      ok: false, retryable: true, ambiguous: true,
      httpStatus: null, emailId: null, response: null,
      error: error instanceof Error ? error.message : String(error), retryAfterSeconds: null,
    };
  }
}

async function runSubtitleEmailDelivery(req: Request, db: SupabaseClient): Promise<JsonRecord> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: authorized, error: authError } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (authError || authorized !== true) throw new HttpError(403, "Unauthorized");
  if (!RESEND_API_KEY) throw new HttpError(503, "Resend transport is not configured");
  return { ok: true, ...(await drainSubtitleEmailDeliveries(db)) };
}

async function drainSubtitleEmailDeliveries(db: SupabaseClient): Promise<JsonRecord> {
  const { data, error } = await db.rpc("claim_subtitle_email_deliveries", {
    p_limit: SUBTITLE_EMAIL_BATCH,
    p_lease_seconds: SUBTITLE_EMAIL_LEASE_SECONDS,
    p_max_attempts: SUBTITLE_EMAIL_MAX_ATTEMPTS,
  });
  if (error) throw new Error(`subtitle email claim failed: ${error.message}`);
  const claims = (data ?? []) as SubtitleEmailClaim[];
  let sent = 0, skipped = 0, retryScheduled = 0, deadLetter = 0, persistenceFailed = 0;

  const fail = async (
    claim: SubtitleEmailClaim,
    retryable: boolean,
    message: string,
    httpStatus: number | null = null,
    response: JsonRecord | null = null,
    retryAfterSeconds: number | null = null,
    ambiguous = false,
  ) => {
    const { data: disposition, error: failError } = await db.rpc("fail_subtitle_email_delivery", {
      p_delivery_id: claim.delivery_id,
      p_lease_token: claim.lease_token,
      p_retryable: retryable,
      p_http_status: httpStatus,
      p_response: response,
      p_error: subtitleEmailSafeError(message),
      p_retry_after_seconds: retryAfterSeconds,
      p_max_attempts: SUBTITLE_EMAIL_MAX_ATTEMPTS,
      p_base_backoff_seconds: 60,
      p_max_backoff_seconds: 21_600,
      p_ambiguous: ambiguous,
    });
    if (failError || !["retry_scheduled", "dead_letter"].includes(String(disposition))) {
      persistenceFailed++;
      console.error("[norva-playback] subtitle email failure persistence failed", claim.delivery_key, failError?.message ?? String(disposition));
      return;
    }
    if (disposition === "dead_letter") deadLetter++;
    else retryScheduled++;
  };

  const skip = async (claim: SubtitleEmailClaim, reason: string) => {
    const { data: applied, error: skipError } = await db.rpc("skip_subtitle_email_delivery", {
      p_delivery_id: claim.delivery_id,
      p_lease_token: claim.lease_token,
      p_reason: reason,
    });
    if (skipError || applied !== true) {
      persistenceFailed++;
      console.error("[norva-playback] subtitle email skip persistence failed", claim.delivery_key, skipError?.message ?? "stale lease");
      return;
    }
    skipped++;
  };

  // Sequential sends respect Resend's team-wide request rate. SKIP LOCKED leases
  // still allow overlapping cron invocations without duplicate ownership.
  for (const claim of claims) {
    let transportAccepted = false;
    try {
      const { data: account, error: userError } = await db.auth.admin.getUserById(claim.user_id);
      const userStatus = Number((userError as { status?: number } | null)?.status ?? 0);
      if (userError) {
        if (userStatus === 404) await skip(claim, "auth user no longer exists");
        else await fail(claim, true, `auth user lookup failed: ${userError.message}`);
        continue;
      }
      const email = stringOr(account?.user?.email, "").trim().toLowerCase();
      if (!email) {
        await skip(claim, "auth user has no current email");
        continue;
      }

      const watchRoute = subtitleWatchRoute(claim as unknown as JsonRecord);
      const rendered = renderSubtitleReadyEmail({
        titleLabel: claim.title_label,
        siteUrl: PUBLIC_SITE_URL,
        ctaUrl: watchRoute ? `${PUBLIC_SITE_URL}/app#${watchRoute}` : PUBLIC_SITE_URL,
      });

      // Freeze the complete multipart request before external I/O. Retries use the
      // same bytes and recipient for the stable Resend Idempotency-Key.
      const { data: preparedRows, error: prepareError } = await db.rpc("prepare_subtitle_email_delivery", {
        p_delivery_id: claim.delivery_id,
        p_lease_token: claim.lease_token,
        p_recipient_email: email,
        p_request_from: SUBTITLE_EMAIL_FROM,
        p_request_reply_to: EMAIL_REPLY_TO,
        p_request_subject: rendered.subject,
        p_request_html: rendered.html,
        p_request_text: rendered.text,
        p_request_tags: rendered.tags,
      });
      const prepared = (Array.isArray(preparedRows) ? preparedRows[0] : null) as PreparedSubtitleEmail | null;
      if (prepareError || !prepared?.recipient_email || !prepared.request_subject || !prepared.request_html
          || !prepared.request_text || !Array.isArray(prepared.request_tags)) {
        // No transport call occurred. Leave an ambiguous/stale CAS to lease expiry.
        persistenceFailed++;
        console.error("[norva-playback] subtitle email preparation failed", claim.delivery_key, prepareError?.message ?? "stale lease");
        continue;
      }

      const { data: transportAuthorized, error: authorizeError } = await db.rpc(
        "authorize_subtitle_email_delivery",
        { p_delivery_id: claim.delivery_id, p_lease_token: claim.lease_token },
      );
      if (authorizeError || transportAuthorized !== true) {
        // No provider request occurred. A stale/expired lease is intentionally
        // left to SQL reconciliation rather than risking an unowned send.
        persistenceFailed++;
        console.error("[norva-playback] subtitle email authorization failed", claim.delivery_key, authorizeError?.message ?? "stale lease");
        continue;
      }

      const result = await sendPreparedSubtitleEmail(claim, prepared);
      if (!result.ok) {
        console.error("[norva-playback] subtitle email transport failed", claim.delivery_key, result.httpStatus ?? "network");
        await fail(
          claim, result.retryable, result.error ?? "Resend delivery failed",
          result.httpStatus, result.response, result.retryAfterSeconds, result.ambiguous,
        );
        continue;
      }
      transportAccepted = true;

      const { data: completed, error: completeError } = await db.rpc("complete_subtitle_email_delivery", {
        p_delivery_id: claim.delivery_id,
        p_lease_token: claim.lease_token,
        p_http_status: result.httpStatus,
        p_resend_email_id: result.emailId,
        p_response: result.response,
      });
      if (completeError || completed !== true) {
        // Resend accepted the immutable key. Do not transition to failed: lease
        // expiry safely reconciles the same request without producing a second email.
        persistenceFailed++;
        console.error("[norva-playback] accepted subtitle email acknowledgement failed", claim.delivery_key, result.emailId, completeError?.message ?? "stale lease");
        continue;
      }
      sent++;
    } catch (error) {
      const message = subtitleEmailSafeError(error instanceof Error ? error.message : String(error));
      console.error("[norva-playback] subtitle email delivery failed", claim.delivery_key, message);
      if (transportAccepted) {
        // An accepted transport must never be overwritten by a failure mutation.
        // Lease expiry retries the same immutable Idempotency-Key.
        persistenceFailed++;
      } else {
        await fail(claim, true, message);
      }
    }
  }

  return {
    claimed: claims.length,
    sent,
    skipped,
    retry_scheduled: retryScheduled,
    dead_letter: deadLetter,
    persistence_failed: persistenceFailed,
  };
}

// Reconcile notifications for a completed transcript. Ready-with-speech is atomically queued in
// SQL and delivered by the leased retry worker; this explicit RPC is an idempotent backstop for
// callback paths that predate the trigger. Empty/failed work has no email and closes immediately.
async function dispatchSubtitleNotifications(db: SupabaseClient, row: JsonRecord | null): Promise<void> {
  if (!row) return;
  const status = stringOr(row.status, "");
  if (status !== "ready" && status !== "failed") return;
  const providerKey = stringOr(row.provider_key, ""), itemType = stringOr(row.item_type, "");
  const externalId = stringOr(row.external_id, ""), kind = stringOr(row.kind, "transcript"), lang = stringOr(row.lang, "src");
  if (!providerKey || !externalId) return;
  const hasSpeech = status === "ready" && Number(row.segments ?? 0) > 0;
  if (hasSpeech) {
    const { error } = await db.rpc("queue_subtitle_ready_email_deliveries", {
      p_notification_id: null,
      p_provider_key: providerKey,
      p_item_type: itemType,
      p_external_id: externalId,
      p_kind: kind,
      p_lang: lang,
    });
    if (error) throwDb(error, "subtitle email queue failed");
    return;
  }

  const { data: subs } = await db.from("catalog_generated_subtitle_notifications")
    .select("id, user_id, title_label, source_id, series_id, item_type, external_id, kind, lang")
    .eq("provider_key", providerKey).eq("item_type", itemType).eq("external_id", externalId)
    .eq("kind", kind).eq("lang", lang).eq("status", "pending");
  const rows = (subs ?? []) as JsonRecord[];
  if (!rows.length) return;
  const nowIso = new Date().toISOString();
  await db.from("catalog_generated_subtitle_notifications")
    .update({
      status: status === "ready" ? "skipped" : "failed",
      sent_at: nowIso,
      email: "",
      title_label: null,
      source_id: null,
      series_id: null,
    })
    .in("id", rows.map((s) => String(s.id)));
  try { await insertSubtitleBellEvents(db, rows, status === "ready" ? "empty" : "failed"); }
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
    if (stage) {
      const { error } = await db.rpc("mark_generated_subtitle_stage", {
        p_job_id: jobId,
        p_stage: stage,
        p_at: nowIso,
      });
      if (error) throwDb(error, "transcribe heartbeat stage failed");
    }
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
    if (stringOr(body.vtt, "").trim()) {
      const { error } = await db.rpc("mark_generated_subtitle_stage", {
        p_job_id: jobId,
        p_stage: "first_vtt",
        p_at: nowIso,
      });
      if (error) throwDb(error, "transcribe first-vtt stage failed");
    }
    return { ok: true, partial: true, jobId };
  }

  if (body.ok === true && stringOr(body.vtt, "").trim()) {
    const { error } = await db.rpc("mark_generated_subtitle_stage", {
      p_job_id: jobId,
      p_stage: "first_vtt",
      p_at: nowIso,
    });
    if (error) throwDb(error, "transcribe final-vtt stage failed");
  }
  const patch: JsonRecord = body.ok === true
    ? { status: "ready", vtt: stringOr(body.vtt, ""), source_lang: stringOrNull(body.sourceLang),
        audio_sec: Number.isFinite(Number(body.audioSec)) ? Number(body.audioSec) : null,
        segments: Number.isFinite(Number(body.segments)) ? Number(body.segments) : null, error: null, stage: null, ready_at: nowIso, updated_at: nowIso }
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
  // The cache-row trigger already committed ready emails to the durable outbox. This idempotent
  // reconciliation also closes empty/failed opt-ins; it never sends email inline with the callback.
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
  if (!userId) return true;
  try {
    // OFF => original 4-min window (byte-identical). ON => widened grace tail.
    const windowMs = CRAWL_YIELD_TO_VIEWERS ? Math.max(4 * 60 * 1000, CRAWL_VIEWER_GRACE_MS) : 4 * 60 * 1000;
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const { data: ev, error: evError } = await db.from("cloud_playback_events")
      .select("id").eq("user_id", userId).gt("created_at", sinceIso).limit(1);
    if (evError) return true;
    if (ev && ev.length) return true;
    // Steady playback emits NO event between first_frame and pause/ended, and the session rows are
    // rotated/expired within seconds of start — both signals go dark ~4 min into every real viewing
    // (proven 2026-07-04: a pregen ffmpeg opened the account's 2nd provider connection at 08:11
    // while watch-history was still bumping at 08:13). The watch-progress save (every 10 s while
    // actually playing) IS the live heartbeat, so read it here.
    const { data: hist, error: histError } = await db.from("cloud_watch_history")
      .select("id").eq("user_id", userId).gt("updated_at", sinceIso).limit(1);
    if (histError) return true;
    if (hist && hist.length) return true;
    const { data: sess, error: sessError } = await db.from("cloud_playback_sessions")
      .select("id").eq("user_id", userId).eq("status", "ready").gt("expires_at", new Date().toISOString()).limit(1);
    if (sessError) return true;
    return Boolean(sess && sess.length);
  } catch (_) {
    return true;
  }
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
// URL parser already lowercases hostnames) + '/' + the logical Xtream username, taken from the
// metadata query or the segment after movie|series|live. Same form as provider_account_touch_by_source builds
// from config_hint (serverHost + username). See docs/LIVE-TV-458-SLOT-CONTENTION.md §5.4.
function providerAccountKeyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const queryUser = u.searchParams.get("username");
    // URLSearchParams has already decoded the query value once. Decoding it again would mutate
    // a literal `%2B`, `%20` or `%2F` in the provider username.
    if (queryUser !== null && queryUser.trim()) return u.host + "/" + queryUser;

    const segs = u.pathname.split("/").filter(Boolean);
    const streamTypeIndex = segs.findIndex((segment) =>
      ["movie", "series", "live"].includes(String(segment || "").toLowerCase())
    );
    if (streamTypeIndex < 0 || !segs[streamTypeIndex + 1]) return u.host;
    // DECODE the username segment: stream URLs are built with encodeURIComponent(username)
    // (xtreamStreamUrl), but provider_account_touch_by_source writes the RAW username from
    // config_hint. All producers must converge on the DECODED form or a username with a
    // URL-special char (@, +, space…) writes/reads mismatched keys and the lock goes blind.
    let user = segs[streamTypeIndex + 1];
    try { user = decodeURIComponent(user); } catch { /* keep raw on malformed % */ }
    return user.trim() ? u.host + "/" + user : u.host;
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

type ProviderRouteCoordinate = {
  slot: number;
  nodeTransport: "http" | "socks5";
};

function providerRouteCoordinate(value: unknown): ProviderRouteCoordinate | null {
  const record = recordOrEmpty(value);
  const slot = Number(record.slot);
  const nodeTransport = stringOr(record.nodeTransport, "");
  if (!Number.isInteger(slot) || slot < 1 || slot > 32) return null;
  if (nodeTransport !== "http" && nodeTransport !== "socks5") return null;
  return { slot, nodeTransport };
}

function providerRouteCoordinateKey(value: ProviderRouteCoordinate): string {
  return `${value.slot}:${value.nodeTransport}`;
}

function providerRouteNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicProviderRouteDecision(
  state: JsonRecord,
  candidates: Map<string, ProviderRouteCoordinate>,
): JsonRecord | null {
  const coordinate = providerRouteCoordinate({
    slot: state.route_slot,
    nodeTransport: state.node_transport,
  });
  if (!coordinate || !candidates.has(providerRouteCoordinateKey(coordinate))) return null;
  const expiresAt = stringOrNull(state.expires_at);
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return null;
  return {
    ...coordinate,
    score: providerRouteNumberOrNull(state.score),
    confidence: providerRouteNumberOrNull(state.confidence),
    expiresAt,
    selectionReason: stringOr(state.selected_reason, "account-sticky"),
  };
}

async function runProviderRouteResolve(req: Request, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json()
    .then(recordOrEmpty)
    .catch(() => { throw new HttpError(400, "Invalid provider route JSON"); });
  const expectedKeys = [
    "accountFingerprint",
    "candidates",
    "hostFingerprint",
    "priority",
    "protocol",
  ];
  const actualKeys = Object.keys(body).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index]) ||
    body.protocol !== 1 || body.priority !== "viewer"
  ) {
    throw new HttpError(400, "Invalid provider route request shape");
  }
  const accountFingerprint = stringOr(body.accountFingerprint, "");
  const hostFingerprint = stringOr(body.hostFingerprint, "");
  if (!/^[0-9a-f]{64}$/.test(accountFingerprint) || !/^[0-9a-f]{64}$/.test(hostFingerprint)) {
    throw new HttpError(400, "Invalid provider route identity");
  }
  const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!rawCandidates.length || rawCandidates.length > 64) {
    throw new HttpError(400, "Invalid provider route candidates");
  }
  const candidates = new Map<string, ProviderRouteCoordinate>();
  for (const rawCandidate of rawCandidates) {
    const coordinate = providerRouteCoordinate(rawCandidate);
    if (!coordinate) throw new HttpError(400, "Invalid provider route candidates");
    const candidateRecord = recordOrEmpty(rawCandidate);
    if (Object.keys(candidateRecord).sort().join(",") !== "nodeTransport,slot") {
      throw new HttpError(400, "Invalid provider route candidates");
    }
    const key = providerRouteCoordinateKey(coordinate);
    if (candidates.has(key)) throw new HttpError(400, "Invalid provider route candidates");
    candidates.set(key, coordinate);
  }

  // A viewer always wins. This call only raises the distributed benchmark's
  // preemption bit; the existing provider-session/permit machinery remains the
  // sole admission authority for the actual provider connection.
  let benchmarkPreempted = false;
  try {
    const { data, error } = await db.rpc("norva_preempt_provider_route_lease", {
      p_account_fingerprint: accountFingerprint,
    });
    benchmarkPreempted = !error && data === true;
  } catch (_) { /* migration lag or transient DB outage: preserve playback */ }

  const disabled = {
    protocol: 1,
    enabled: false,
    apply: false,
    decision: null,
    benchmarkPreempted,
  };
  let policy: JsonRecord | null = null;
  try {
    const { data, error } = await db
      .from("provider_route_policies")
      .select("enabled,shadow_mode,route_ttl_seconds,minimum_confidence,minimum_relative_gain,sustained_candidate_wins,consecutive_failure_threshold,tiny_probe_bytes,sustained_probe_bytes,top_candidate_count,benchmark_lease_seconds")
      .eq("policy_key", "default")
      .maybeSingle();
    if (error || !data) return disabled;
    policy = recordOrEmpty(data);
  } catch (_) {
    return disabled;
  }
  if (!policy) return disabled;

  let decision: JsonRecord | null = null;
  try {
    const { data: accountState, error: accountError } = await db
      .from("provider_route_state")
      .select("route_slot,node_transport,score,confidence,expires_at,selected_reason")
      .eq("scope", "account")
      .eq("route_identity", accountFingerprint)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (!accountError && accountState) {
      decision = publicProviderRouteDecision(recordOrEmpty(accountState), candidates);
    }
    if (!decision) {
      const { data: hostStates, error: hostError } = await db
        .from("provider_route_state")
        .select("route_slot,node_transport,score,confidence,expires_at,selected_reason")
        .eq("scope", "host")
        .eq("host_fingerprint", hostFingerprint)
        .gt("expires_at", new Date().toISOString())
        .order("score", { ascending: false })
        .order("confidence", { ascending: false })
        .limit(16);
      if (!hostError) {
        for (const state of hostStates || []) {
          decision = publicProviderRouteDecision(recordOrEmpty(state), candidates);
          if (decision) {
            decision.selectionReason = "host-learned";
            break;
          }
        }
      }
    }
  } catch (_) { /* fallback remains local and sticky */ }

  const enabled = policy.enabled === true;
  const shadowMode = policy.shadow_mode !== false;
  const apply = enabled && !shadowMode && Boolean(decision);
  if (apply && decision) {
    const routeSlot = Number(decision.slot);
    const routeProtocol = stringOr(decision.nodeTransport, "");
    const rawScore = Number(decision.score);
    const rawConfidence = Number(decision.confidence);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null;
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence)))
      : null;
    if (Number.isInteger(routeSlot) && routeSlot >= 1 && routeSlot <= 32
      && ["http", "socks5"].includes(routeProtocol)) {
      const dimensions = {
        p_samples: 1, p_layer: "provider", p_market_region: "global",
        p_route_slot: `slot-${routeSlot}`, p_route_protocol: routeProtocol,
        p_outcome: "none", p_score: score, p_confidence: confidence,
      };
      runBackground(Promise.all([
        ...(score === null ? [] : [db.rpc("norva_record_media_cache_metric", {
          p_metric: "route_score", p_value: score, ...dimensions,
        })]),
        ...(confidence === null ? [] : [db.rpc("norva_record_media_cache_metric", {
          p_metric: "route_confidence", p_value: confidence, ...dimensions,
        })]),
      ]).then(() => undefined));
    }
  }
  return {
    protocol: 1,
    enabled,
    apply,
    decision,
    benchmarkPreempted,
    policy: {
      shadowMode,
      routeTtlSeconds: providerRouteNumberOrNull(policy.route_ttl_seconds),
      minimumConfidence: providerRouteNumberOrNull(policy.minimum_confidence),
      minimumRelativeGain: providerRouteNumberOrNull(policy.minimum_relative_gain),
      sustainedCandidateWins: providerRouteNumberOrNull(policy.sustained_candidate_wins),
      consecutiveFailureThreshold: providerRouteNumberOrNull(policy.consecutive_failure_threshold),
      tinyProbeBytes: providerRouteNumberOrNull(policy.tiny_probe_bytes),
      sustainedProbeBytes: providerRouteNumberOrNull(policy.sustained_probe_bytes),
      topCandidateCount: providerRouteNumberOrNull(policy.top_candidate_count),
      benchmarkLeaseSeconds: providerRouteNumberOrNull(policy.benchmark_lease_seconds),
    },
  };
}

const PROVIDER_ROUTE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_ROUTE_BENCHMARK_MEASUREMENT_KEYS = [
  "first16MiBMs",
  "first4MiBMs",
  "http5xx",
  "nodeTransport",
  "phase",
  "provider458",
  "proxy407",
  "rangeSeekOk",
  "resets",
  "sampleBytes",
  "slot",
  "success",
  "throughputBytesPerSecond",
  "timeouts",
  "ttfbMs",
  "varianceRatio",
];

type ProviderRouteMeasurement = ProviderRouteCoordinate & {
  phase: "tiny" | "sustained";
  sampleBytes: number;
  success: boolean;
  ttfbMs: number | null;
  first4MiBMs: number | null;
  first16MiBMs: number | null;
  throughputBytesPerSecond: number | null;
  varianceRatio: number | null;
  rangeSeekOk: boolean;
  resets: number;
  timeouts: number;
  proxy407: number;
  provider458: number;
  http5xx: number;
};

type ProviderRouteAggregate = ProviderRouteCoordinate & {
  score: number;
  confidence: number;
  sampleCount: number;
  metrics: ProviderRouteMeasurement;
};

function providerRouteBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  nullable = false,
): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return null;
  return number;
}

function providerRouteBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  nullable = false,
): number | null {
  const number = providerRouteBoundedNumber(value, minimum, maximum, nullable);
  return number === null || !Number.isInteger(number) ? null : number;
}

function parseProviderRouteMeasurement(value: unknown): ProviderRouteMeasurement | null {
  const record = recordOrEmpty(value);
  if (!exactJsonKeys(record, PROVIDER_ROUTE_BENCHMARK_MEASUREMENT_KEYS)) return null;
  const coordinate = providerRouteCoordinate(record);
  const phase = stringOr(record.phase, "");
  const sampleBytes = providerRouteBoundedInteger(record.sampleBytes, 0, 16 * 1024 * 1024);
  const ttfbMs = providerRouteBoundedInteger(record.ttfbMs, 0, 300_000, true);
  const first4MiBMs = providerRouteBoundedInteger(record.first4MiBMs, 0, 600_000, true);
  const first16MiBMs = providerRouteBoundedInteger(record.first16MiBMs, 0, 1_200_000, true);
  const throughputBytesPerSecond = providerRouteBoundedInteger(
    record.throughputBytesPerSecond,
    0,
    10_737_418_240,
    true,
  );
  const varianceRatio = providerRouteBoundedNumber(record.varianceRatio, 0, 100, true);
  const resets = providerRouteBoundedInteger(record.resets, 0, 32_767);
  const timeouts = providerRouteBoundedInteger(record.timeouts, 0, 32_767);
  const proxy407 = providerRouteBoundedInteger(record.proxy407, 0, 32_767);
  const provider458 = providerRouteBoundedInteger(record.provider458, 0, 32_767);
  const http5xx = providerRouteBoundedInteger(record.http5xx, 0, 32_767);
  if (
    !coordinate || !["tiny", "sustained"].includes(phase) || sampleBytes === null ||
    typeof record.success !== "boolean" || typeof record.rangeSeekOk !== "boolean" ||
    resets === null || timeouts === null || proxy407 === null || provider458 === null || http5xx === null ||
    (record.ttfbMs !== null && ttfbMs === null) ||
    (record.first4MiBMs !== null && first4MiBMs === null) ||
    (record.first16MiBMs !== null && first16MiBMs === null) ||
    (record.throughputBytesPerSecond !== null && throughputBytesPerSecond === null) ||
    (record.varianceRatio !== null && varianceRatio === null)
  ) return null;
  return {
    ...coordinate,
    phase: phase as "tiny" | "sustained",
    sampleBytes,
    success: record.success,
    ttfbMs,
    first4MiBMs,
    first16MiBMs,
    throughputBytesPerSecond,
    varianceRatio,
    rangeSeekOk: record.rangeSeekOk,
    resets,
    timeouts,
    proxy407,
    provider458,
    http5xx,
  };
}

function providerRouteClamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function scoreProviderRouteEdge(measurement: ProviderRouteMeasurement): number {
  if (measurement.proxy407 > 0) return 0;
  const ttfbMs = measurement.ttfbMs ?? 30_000;
  const first4MiBMs = Math.max(ttfbMs, measurement.first4MiBMs ?? 60_000);
  const first16MiBMs = Math.max(first4MiBMs, measurement.first16MiBMs ?? 120_000);
  const throughput = Math.max(0, measurement.throughputBytesPerSecond ?? 0);
  const varianceRatio = providerRouteClamp(measurement.varianceRatio ?? 1, 0, 4);
  const base = (
    0.2 * Math.exp(-ttfbMs / 3_000) +
    0.18 * Math.exp(-first4MiBMs / 8_000) +
    0.2 * Math.exp(-first16MiBMs / 20_000) +
    0.27 * providerRouteClamp(Math.log2(1 + throughput / (1024 * 1024)) / Math.log2(65), 0, 1) +
    0.1 * (1 - providerRouteClamp(varianceRatio, 0, 1)) +
    0.05 * (measurement.rangeSeekOk ? 1 : 0)
  );
  const penalty = Math.min(
    0.95,
    measurement.resets * 0.12 + measurement.timeouts * 0.3 +
      measurement.http5xx * 0.16 + measurement.provider458 * 0.01,
  );
  return Number((100 * Math.max(0, base - penalty)).toFixed(3));
}

function providerRouteMedian(values: Array<number | null>): number {
  const sorted = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function providerRouteConfidence(measurements: ProviderRouteMeasurement[]): number {
  if (!measurements.length) return 0;
  const complete = measurements.filter((measurement) =>
    Number(measurement.first16MiBMs || 0) > 0 &&
    Number(measurement.throughputBytesPerSecond || 0) > 0 &&
    measurement.rangeSeekOk
  ).length;
  const sampleConfidence = providerRouteClamp(measurements.length / 5, 0, 1);
  const completeness = complete / measurements.length;
  return Number(providerRouteClamp(0.2 + sampleConfidence * 0.5 + completeness * 0.3, 0, 1).toFixed(4));
}

function aggregateProviderRouteEdge(
  coordinate: ProviderRouteCoordinate,
  measurements: ProviderRouteMeasurement[],
): ProviderRouteAggregate | null {
  const matching = measurements.filter((measurement) =>
    measurement.slot === coordinate.slot && measurement.nodeTransport === coordinate.nodeTransport
  );
  if (!matching.length) return null;
  const aggregate: ProviderRouteMeasurement = {
    ...coordinate,
    phase: "sustained",
    sampleBytes: Math.max(...matching.map((measurement) => measurement.sampleBytes)),
    success: matching.filter((measurement) => measurement.success).length >= Math.ceil(matching.length / 2),
    ttfbMs: providerRouteMedian(matching.map((measurement) => measurement.ttfbMs)),
    first4MiBMs: providerRouteMedian(matching.map((measurement) => measurement.first4MiBMs)),
    first16MiBMs: providerRouteMedian(matching.map((measurement) => measurement.first16MiBMs)),
    throughputBytesPerSecond: providerRouteMedian(
      matching.map((measurement) => measurement.throughputBytesPerSecond),
    ),
    varianceRatio: providerRouteMedian(matching.map((measurement) => measurement.varianceRatio)),
    rangeSeekOk: matching.filter((measurement) => measurement.rangeSeekOk).length >= Math.ceil(matching.length / 2),
    resets: matching.reduce((sum, measurement) => sum + measurement.resets, 0),
    timeouts: matching.reduce((sum, measurement) => sum + measurement.timeouts, 0),
    proxy407: matching.reduce((sum, measurement) => sum + measurement.proxy407, 0),
    provider458: matching.reduce((sum, measurement) => sum + measurement.provider458, 0),
    http5xx: matching.reduce((sum, measurement) => sum + measurement.http5xx, 0),
  };
  return {
    ...coordinate,
    score: scoreProviderRouteEdge(aggregate),
    confidence: providerRouteConfidence(matching),
    sampleCount: matching.length,
    metrics: aggregate,
  };
}

function rankProviderRouteEdge(measurements: ProviderRouteMeasurement[]): ProviderRouteAggregate[] {
  const coordinates = new Map<string, ProviderRouteCoordinate>();
  for (const measurement of measurements) {
    coordinates.set(providerRouteCoordinateKey(measurement), {
      slot: measurement.slot,
      nodeTransport: measurement.nodeTransport,
    });
  }
  return [...coordinates.values()]
    .map((coordinate) => aggregateProviderRouteEdge(coordinate, measurements))
    .filter((aggregate): aggregate is ProviderRouteAggregate => Boolean(aggregate))
    .sort((left, right) =>
      right.score - left.score || right.confidence - left.confidence ||
      providerRouteCoordinateKey(left).localeCompare(providerRouteCoordinateKey(right))
    );
}

function providerRoutePolicyNumber(policy: JsonRecord, key: string, fallback: number): number {
  if (policy[key] === null || policy[key] === undefined) return fallback;
  const value = Number(policy[key]);
  return Number.isFinite(value) ? value : fallback;
}

function evaluateProviderRouteTransitionEdge(
  current: (ProviderRouteCoordinate & {
    score?: number;
    expiresAt?: string;
    consecutiveFailures?: number;
  }) | null,
  candidate: (ProviderRouteAggregate & { consecutiveWins?: number }) | null,
  policy: JsonRecord = {},
  nowMs = Date.now(),
): { switch: boolean; reason: string; relativeGain?: number } {
  if (!candidate) return { switch: false, reason: "no-candidate" };
  if (!current) return { switch: true, reason: "no-current-route" };
  if (providerRouteCoordinateKey(current) === providerRouteCoordinateKey(candidate)) {
    return { switch: false, reason: "same-route" };
  }
  const minimumConfidence = providerRoutePolicyNumber(policy, "minimumConfidence", 0.65);
  const minimumRelativeGain = providerRoutePolicyNumber(policy, "minimumRelativeGain", 0.2);
  const sustainedCandidateWins = providerRoutePolicyNumber(policy, "sustainedCandidateWins", 3);
  const consecutiveFailureThreshold = providerRoutePolicyNumber(
    policy,
    "consecutiveFailureThreshold",
    3,
  );
  const expiresAt = Date.parse(stringOr(current.expiresAt, ""));
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs && candidate.confidence >= minimumConfidence) {
    return { switch: true, reason: "current-expired" };
  }
  const consecutiveFailures = Math.max(0, Math.trunc(Number(current.consecutiveFailures) || 0));
  if (
    consecutiveFailures >= consecutiveFailureThreshold &&
    candidate.confidence >= minimumConfidence && candidate.score > 0
  ) return { switch: true, reason: "repeated-route-degradation" };
  const currentScore = Math.max(1, Number(current.score) || 0);
  const candidateScore = Math.max(0, Number(candidate.score) || 0);
  const relativeGain = (candidateScore - currentScore) / currentScore;
  const consecutiveWins = Math.max(0, Math.trunc(Number(candidate.consecutiveWins) || 0));
  if (
    candidate.confidence >= minimumConfidence &&
    consecutiveWins >= sustainedCandidateWins &&
    relativeGain >= minimumRelativeGain
  ) return { switch: true, reason: "sustained-significant-gain", relativeGain };
  return { switch: false, reason: "hysteresis-hold", relativeGain };
}

function providerRouteMeasurementFromRow(value: unknown): ProviderRouteMeasurement | null {
  const row = recordOrEmpty(value);
  return parseProviderRouteMeasurement({
    first16MiBMs: row.first_16mib_ms ?? null,
    first4MiBMs: row.first_4mib_ms ?? null,
    http5xx: row.http_5xx ?? 0,
    nodeTransport: row.node_transport,
    phase: row.phase,
    provider458: row.provider_458 ?? 0,
    proxy407: row.proxy_407 ?? 0,
    rangeSeekOk: row.range_seek_ok === true,
    resets: row.resets ?? 0,
    sampleBytes: row.sample_bytes ?? 0,
    slot: row.route_slot,
    success: row.success === true,
    throughputBytesPerSecond: row.throughput_bytes_per_second ?? null,
    timeouts: row.timeouts ?? 0,
    ttfbMs: row.ttfb_ms ?? null,
    varianceRatio: row.variance_ratio ?? null,
  });
}

async function getProviderRoutePolicy(db: SupabaseClient): Promise<JsonRecord | null> {
  try {
    const { data, error } = await db
      .from("provider_route_policies")
      .select("enabled,shadow_mode,route_ttl_seconds,minimum_confidence,minimum_relative_gain,sustained_candidate_wins,consecutive_failure_threshold,tiny_probe_bytes,sustained_probe_bytes,top_candidate_count,benchmark_lease_seconds,measurement_retention_seconds")
      .eq("policy_key", "default")
      .maybeSingle();
    return error || !data ? null : recordOrEmpty(data);
  } catch (_) {
    return null;
  }
}

function publicProviderRoutePolicy(policy: JsonRecord): JsonRecord {
  return {
    shadowMode: policy.shadow_mode !== false,
    routeTtlSeconds: providerRouteNumberOrNull(policy.route_ttl_seconds),
    minimumConfidence: providerRouteNumberOrNull(policy.minimum_confidence),
    minimumRelativeGain: providerRouteNumberOrNull(policy.minimum_relative_gain),
    sustainedCandidateWins: providerRouteNumberOrNull(policy.sustained_candidate_wins),
    consecutiveFailureThreshold: providerRouteNumberOrNull(policy.consecutive_failure_threshold),
    tinyProbeBytes: providerRouteNumberOrNull(policy.tiny_probe_bytes),
    sustainedProbeBytes: providerRouteNumberOrNull(policy.sustained_probe_bytes),
    topCandidateCount: providerRouteNumberOrNull(policy.top_candidate_count),
    benchmarkLeaseSeconds: providerRouteNumberOrNull(policy.benchmark_lease_seconds),
  };
}

async function runProviderRouteActivity(req: Request, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid provider route activity JSON");
  });
  if (!exactJsonKeys(body, ["accountFingerprints", "activityKind", "protocol"]) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid provider route activity shape");
  }
  const activityKind = stringOr(body.activityKind, "");
  const fingerprints = Array.isArray(body.accountFingerprints)
    ? [...new Set(body.accountFingerprints.map((value) => stringOr(value, "")))]
    : [];
  if (
    activityKind !== "viewer" || !fingerprints.length || fingerprints.length > 64 ||
    fingerprints.some((value) => !PROVIDER_ROUTE_FINGERPRINT_PATTERN.test(value))
  ) throw new HttpError(400, "Invalid provider route activity");
  try {
    const { data, error } = await db.rpc("norva_touch_provider_route_activity", {
      p_account_fingerprints: fingerprints,
      p_activity_kind: activityKind,
      p_ttl_seconds: 90,
    });
    if (error) return { protocol: 1, ok: true, touched: 0, warn: "migration-lag" };
    return { protocol: 1, ok: true, touched: Number(data || 0) };
  } catch (_) {
    return { protocol: 1, ok: true, touched: 0, warn: "migration-lag" };
  }
}

async function providerRouteBenchmarkLease(
  db: SupabaseClient,
  accountFingerprint: string,
  leaseToken: string,
): Promise<JsonRecord | null> {
  try {
    const { data, error } = await db
      .from("provider_route_leases")
      .select("host_fingerprint,lease_token,preempt_requested,expires_at")
      .eq("account_fingerprint", accountFingerprint)
      .eq("lease_token", leaseToken)
      .maybeSingle();
    if (error || !data) return null;
    const lease = recordOrEmpty(data);
    const expiresAt = Date.parse(stringOr(lease.expires_at, ""));
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? lease : null;
  } catch (_) {
    return null;
  }
}

async function recentProviderRouteMeasurements(
  db: SupabaseClient,
  column: "account_fingerprint" | "host_fingerprint",
  fingerprint: string,
  retentionSeconds: number,
): Promise<ProviderRouteMeasurement[]> {
  try {
    const since = new Date(Date.now() - retentionSeconds * 1000).toISOString();
    const { data, error } = await db
      .from("provider_route_measurements")
      .select("route_slot,node_transport,phase,sample_bytes,success,ttfb_ms,first_4mib_ms,first_16mib_ms,throughput_bytes_per_second,variance_ratio,range_seek_ok,resets,timeouts,proxy_407,provider_458,http_5xx")
      .eq(column, fingerprint)
      .gte("observed_at", since)
      .order("observed_at", { ascending: false })
      .limit(512);
    if (error) return [];
    return (data || []).map(providerRouteMeasurementFromRow)
      .filter((value): value is ProviderRouteMeasurement => Boolean(value));
  } catch (_) {
    return [];
  }
}

async function persistProviderRouteState(
  db: SupabaseClient,
  accountFingerprint: string,
  hostFingerprint: string,
  policy: JsonRecord,
  rankings: ProviderRouteAggregate[],
): Promise<JsonRecord | null> {
  const recommendation = rankings[0];
  if (!recommendation) return null;
  const now = new Date();
  const ttlSeconds = providerRoutePolicyNumber(policy, "route_ttl_seconds", 604_800);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  let current: JsonRecord | null = null;
  try {
    const { data } = await db.from("provider_route_state").select("*")
      .eq("scope", "account").eq("route_identity", accountFingerprint).maybeSingle();
    if (data) current = recordOrEmpty(data);
  } catch (_) { /* first observation */ }

  const currentCoordinate = current ? providerRouteCoordinate({
    slot: current.route_slot,
    nodeTransport: current.node_transport,
  }) : null;
  const currentRanking = currentCoordinate
    ? rankings.find((ranking) => providerRouteCoordinateKey(ranking) === providerRouteCoordinateKey(currentCoordinate)) || null
    : null;
  const sameRoute = currentCoordinate &&
    providerRouteCoordinateKey(currentCoordinate) === providerRouteCoordinateKey(recommendation);
  const priorFailures = Number(current?.consecutive_failures || 0);
  const currentFailed = Boolean(currentCoordinate) && (
    !currentRanking || currentRanking.score <= 0 || currentRanking.metrics.proxy407 > 0 ||
    currentRanking.metrics.timeouts > 0 || currentRanking.metrics.http5xx > 0
  );
  const consecutiveFailures = currentFailed ? Math.min(32_767, priorFailures + 1) : 0;
  const priorCandidateMatches = current &&
    Number(current.candidate_slot) === recommendation.slot &&
    stringOr(current.candidate_node_transport, "") === recommendation.nodeTransport;
  const candidateWins = sameRoute ? 0 : Math.min(32_767, priorCandidateMatches
    ? Number(current?.candidate_wins || 0) + 1
    : 1);
  const currentExpiresAt = Date.parse(stringOr(current?.expires_at, ""));
  const currentScore = Math.max(1, Number(currentRanking?.score ?? current?.score ?? 0));
  const transition = evaluateProviderRouteTransitionEdge(
    currentCoordinate ? {
      ...currentCoordinate,
      score: currentScore,
      expiresAt: Number.isFinite(currentExpiresAt) ? new Date(currentExpiresAt).toISOString() : undefined,
      consecutiveFailures,
    } : null,
    { ...recommendation, consecutiveWins: candidateWins },
    {
      minimumConfidence: providerRoutePolicyNumber(policy, "minimum_confidence", 0.65),
      minimumRelativeGain: providerRoutePolicyNumber(policy, "minimum_relative_gain", 0.2),
      sustainedCandidateWins: providerRoutePolicyNumber(policy, "sustained_candidate_wins", 3),
      consecutiveFailureThreshold: providerRoutePolicyNumber(
        policy,
        "consecutive_failure_threshold",
        3,
      ),
    },
    now.getTime(),
  );
  const shouldSwitch = transition.switch;
  const selectedReason = shouldSwitch ? transition.reason : "account-sticky";

  const selected = shouldSwitch || sameRoute ? recommendation : currentRanking;
  const selectedCoordinate = shouldSwitch || sameRoute
    ? recommendation
    : currentCoordinate;
  if (!selectedCoordinate) return null;
  const state = {
    scope: "account",
    route_identity: accountFingerprint,
    host_fingerprint: hostFingerprint,
    route_slot: selectedCoordinate.slot,
    node_transport: selectedCoordinate.nodeTransport,
    ffmpeg_slot: selectedCoordinate.slot,
    score: Number(selected?.score ?? current?.score ?? 0),
    confidence: Number(selected?.confidence ?? current?.confidence ?? 0),
    sample_count: Number(selected?.sampleCount ?? current?.sample_count ?? 0),
    consecutive_failures: shouldSwitch ? 0 : consecutiveFailures,
    candidate_slot: !shouldSwitch && !sameRoute ? recommendation.slot : null,
    candidate_node_transport: !shouldSwitch && !sameRoute ? recommendation.nodeTransport : null,
    candidate_wins: !shouldSwitch && !sameRoute ? candidateWins : 0,
    selected_reason: sameRoute ? "account-sticky" : selectedReason,
    selected_at: now.toISOString(),
    last_measured_at: now.toISOString(),
    expires_at: expiresAt,
    version: Math.max(1, Number(current?.version || 0) + 1),
    updated_at: now.toISOString(),
  };
  const { error } = await db.from("provider_route_state").upsert(state, {
    onConflict: "scope,route_identity",
  });
  if (error) return null;
  return state;
}

async function persistProviderHostRouteState(
  db: SupabaseClient,
  hostFingerprint: string,
  policy: JsonRecord,
  rankings: ProviderRouteAggregate[],
): Promise<void> {
  const recommendation = rankings[0];
  if (
    !recommendation ||
    recommendation.confidence < providerRoutePolicyNumber(policy, "minimum_confidence", 0.65)
  ) return;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + providerRoutePolicyNumber(policy, "route_ttl_seconds", 604_800) * 1000,
  ).toISOString();
  await db.from("provider_route_state").upsert({
    scope: "host",
    route_identity: hostFingerprint,
    host_fingerprint: hostFingerprint,
    route_slot: recommendation.slot,
    node_transport: recommendation.nodeTransport,
    ffmpeg_slot: recommendation.slot,
    score: recommendation.score,
    confidence: recommendation.confidence,
    sample_count: recommendation.sampleCount,
    consecutive_failures: 0,
    candidate_slot: null,
    candidate_node_transport: null,
    candidate_wins: 0,
    selected_reason: "host-learned",
    selected_at: now.toISOString(),
    last_measured_at: now.toISOString(),
    expires_at: expiresAt,
    version: 1,
    updated_at: now.toISOString(),
  }, { onConflict: "scope,route_identity" });
}

async function reportProviderRouteBenchmark(
  db: SupabaseClient,
  body: JsonRecord,
  accountFingerprint: string,
  hostFingerprint: string,
  leaseToken: string,
  policy: JsonRecord,
): Promise<JsonRecord> {
  const lease = await providerRouteBenchmarkLease(db, accountFingerprint, leaseToken);
  if (
    !lease || lease.preempt_requested === true ||
    stringOr(lease.host_fingerprint, "") !== hostFingerprint
  ) throw new HttpError(409, "Provider route benchmark lease was preempted");
  const rawMeasurements = Array.isArray(body.measurements) ? body.measurements : [];
  if (!rawMeasurements.length || rawMeasurements.length > 80) {
    throw new HttpError(400, "Invalid provider route measurements");
  }
  const measurements = rawMeasurements.map(parseProviderRouteMeasurement);
  if (measurements.some((measurement) => !measurement)) {
    throw new HttpError(400, "Invalid provider route measurements");
  }
  const acceptedMeasurements = measurements as ProviderRouteMeasurement[];
  const batchRankings = rankProviderRouteEdge(acceptedMeasurements);
  const confidenceByRoute = new Map(batchRankings.map((ranking) => [
    providerRouteCoordinateKey(ranking),
    ranking.confidence,
  ]));
  const rows = acceptedMeasurements.map((measurement) => ({
    account_fingerprint: accountFingerprint,
    host_fingerprint: hostFingerprint,
    route_slot: measurement.slot,
    node_transport: measurement.nodeTransport,
    phase: measurement.phase,
    sample_bytes: measurement.sampleBytes,
    success: measurement.success,
    ttfb_ms: measurement.ttfbMs,
    first_4mib_ms: measurement.first4MiBMs,
    first_16mib_ms: measurement.first16MiBMs,
    throughput_bytes_per_second: measurement.throughputBytesPerSecond,
    variance_ratio: measurement.varianceRatio,
    range_seek_ok: measurement.rangeSeekOk,
    resets: measurement.resets,
    timeouts: measurement.timeouts,
    proxy_407: measurement.proxy407,
    provider_458: measurement.provider458,
    http_5xx: measurement.http5xx,
    route_score: scoreProviderRouteEdge(measurement),
    route_confidence: confidenceByRoute.get(providerRouteCoordinateKey(measurement)) || 0,
  }));
  const { error: insertError } = await db.from("provider_route_measurements").insert(rows);
  if (insertError) throw new HttpError(503, "Provider route measurement store unavailable");

  const retentionSeconds = providerRoutePolicyNumber(policy, "measurement_retention_seconds", 2_592_000);
  const accountMeasurements = await recentProviderRouteMeasurements(
    db,
    "account_fingerprint",
    accountFingerprint,
    retentionSeconds,
  );
  const accountRankings = rankProviderRouteEdge(accountMeasurements.length
    ? accountMeasurements
    : acceptedMeasurements);
  const accountState = await persistProviderRouteState(
    db,
    accountFingerprint,
    hostFingerprint,
    policy,
    accountRankings,
  );
  const hostMeasurements = await recentProviderRouteMeasurements(
    db,
    "host_fingerprint",
    hostFingerprint,
    retentionSeconds,
  );
  await persistProviderHostRouteState(db, hostFingerprint, policy, rankProviderRouteEdge(hostMeasurements));
  if (!accountState) throw new HttpError(503, "Provider route state store unavailable");
  const candidates = new Map<string, ProviderRouteCoordinate>();
  for (const measurement of acceptedMeasurements) {
    candidates.set(providerRouteCoordinateKey(measurement), {
      slot: measurement.slot,
      nodeTransport: measurement.nodeTransport,
    });
  }
  return {
    protocol: 1,
    accepted: true,
    decision: publicProviderRouteDecision(accountState, candidates),
    measurementCount: acceptedMeasurements.length,
  };
}

async function runProviderRouteBenchmark(req: Request, db: SupabaseClient): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid provider route benchmark JSON");
  });
  const action = stringOr(body.action, "");
  if (body.protocol !== 1 || !["claim", "pulse", "report", "release"].includes(action)) {
    throw new HttpError(400, "Invalid provider route benchmark action");
  }
  const expectedKeys: Record<string, string[]> = {
    claim: ["accountFingerprint", "action", "hostFingerprint", "ownerInstanceFingerprint", "protocol"],
    pulse: ["accountFingerprint", "action", "leaseToken", "protocol"],
    report: ["accountFingerprint", "action", "hostFingerprint", "leaseToken", "measurements", "protocol"],
    release: ["accountFingerprint", "action", "leaseToken", "protocol"],
  };
  if (!exactJsonKeys(body, expectedKeys[action])) {
    throw new HttpError(400, "Invalid provider route benchmark shape");
  }
  const accountFingerprint = stringOr(body.accountFingerprint, "");
  const hostFingerprint = stringOr(body.hostFingerprint, "");
  const leaseToken = stringOr(body.leaseToken, "");
  if (!PROVIDER_ROUTE_FINGERPRINT_PATTERN.test(accountFingerprint)) {
    throw new HttpError(400, "Invalid provider route identity");
  }
  if (["claim", "report"].includes(action) && !PROVIDER_ROUTE_FINGERPRINT_PATTERN.test(hostFingerprint)) {
    throw new HttpError(400, "Invalid provider route identity");
  }
  if (["pulse", "report", "release"].includes(action) && !PLAYBACK_SESSION_UUID_PATTERN.test(leaseToken)) {
    throw new HttpError(400, "Invalid provider route lease");
  }
  if (action === "claim") {
    const ownerInstanceFingerprint = stringOr(body.ownerInstanceFingerprint, "");
    if (!PROVIDER_ROUTE_FINGERPRINT_PATTERN.test(ownerInstanceFingerprint)) {
      throw new HttpError(400, "Invalid provider route owner");
    }
    const policy = await getProviderRoutePolicy(db);
    if (!policy || policy.enabled !== true) {
      return { protocol: 1, granted: false, reason: "control-disabled" };
    }
    try {
      const { data, error } = await db.rpc("norva_claim_provider_route_lease", {
        p_account_fingerprint: accountFingerprint,
        p_host_fingerprint: hostFingerprint,
        p_owner_instance_fingerprint: ownerInstanceFingerprint,
        p_ttl_seconds: providerRoutePolicyNumber(policy, "benchmark_lease_seconds", 120),
      });
      const token = stringOr(data, "");
      if (error || !PLAYBACK_SESSION_UUID_PATTERN.test(token)) {
        return { protocol: 1, granted: false, reason: "viewer-active-or-leased" };
      }
      return {
        protocol: 1,
        granted: true,
        leaseToken: token,
        policy: publicProviderRoutePolicy(policy),
      };
    } catch (_) {
      return { protocol: 1, granted: false, reason: "control-unavailable" };
    }
  }
  if (action === "pulse") {
    const lease = await providerRouteBenchmarkLease(db, accountFingerprint, leaseToken);
    if (!lease) return { protocol: 1, active: false, preemptRequested: false };
    if (lease.preempt_requested === true) {
      return { protocol: 1, active: false, preemptRequested: true };
    }
    const policy = await getProviderRoutePolicy(db);
    if (!policy) return { protocol: 1, active: false, preemptRequested: false };
    try {
      const { data, error } = await db.rpc("norva_renew_provider_route_lease", {
        p_account_fingerprint: accountFingerprint,
        p_lease_token: leaseToken,
        p_ttl_seconds: providerRoutePolicyNumber(policy, "benchmark_lease_seconds", 120),
      });
      return { protocol: 1, active: !error && data === true, preemptRequested: false };
    } catch (_) {
      return { protocol: 1, active: false, preemptRequested: false };
    }
  }
  if (action === "report") {
    const policy = await getProviderRoutePolicy(db);
    if (!policy || policy.enabled !== true) throw new HttpError(409, "Provider route control is disabled");
    return reportProviderRouteBenchmark(
      db,
      body,
      accountFingerprint,
      hostFingerprint,
      leaseToken,
      policy,
    );
  }
  try {
    const { data, error } = await db.rpc("norva_release_provider_route_lease", {
      p_account_fingerprint: accountFingerprint,
      p_lease_token: leaseToken,
    });
    return { protocol: 1, released: !error && data === true };
  } catch (_) {
    return { protocol: 1, released: false };
  }
}

function requireConfiguredMediaGatewayCallback(
  req: Request,
  runtimeConfig: RuntimeConfig,
): Set<string | null> {
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const routes = [
    runtimeConfig.mediaGatewayRouting.defaultRoute,
    runtimeConfig.mediaGatewayRouting.canaryRoute,
  ].filter((route): route is MediaGatewayRoute => Boolean(route?.token));
  const matchedRoutes = provided
    ? routes.filter((route) => route.token === provided)
    : [];
  if (!matchedRoutes.length) throw new HttpError(401, "Unauthorized");
  return new Set(matchedRoutes.map((route) => stringOrNull(route.gatewayId)));
}

async function runMediaCacheProducerControl(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaCacheSingleflightEnabled) {
    throw new HttpError(503, "Shared media cache singleflight is disabled", {
      code: "MEDIA_CACHE_SINGLEFLIGHT_DISABLED",
    });
  }
  const authorizedGatewayIds = requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid media cache producer control JSON");
  });
  const action = stringOr(body.action, "");
  const expectedKeys = action === "pulse" || action === "continuation-pulse"
    ? ["action", "gatewaySessionId", "playbackSessionId", "protocol", "stage"]
    : action === "abandon"
    ? ["action", "gatewaySessionId", "playbackSessionId", "protocol"]
    : [];
  if (!expectedKeys.length || !exactJsonKeys(body, expectedKeys) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid media cache producer control shape");
  }
  const playbackSessionId = stringOr(body.playbackSessionId, "").toLowerCase();
  const gatewaySessionId = stringOr(body.gatewaySessionId, "").toLowerCase();
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)
    || !PLAYBACK_SESSION_UUID_PATTERN.test(gatewaySessionId)) {
    throw new HttpError(400, "Invalid media cache producer control session");
  }
  const { data: gatewaySession, error: gatewayError } = await db
    .from("cloud_gateway_sessions")
    .select("gateway_id")
    .eq("playback_session_id", playbackSessionId)
    .eq("external_session_id", gatewaySessionId)
    .maybeSingle();
  if (gatewayError) throwDb(gatewayError, "Unable to verify media cache producer Gateway session");
  if (!gatewaySession || !authorizedGatewayIds.has(stringOrNull(gatewaySession.gateway_id))) {
    throw new HttpError(404, "Media cache producer session not found");
  }

  if (action === "pulse" || action === "continuation-pulse") {
    const stage = stringOr(body.stage, "");
    if (!["probing", "producing", "uploading", "finalizing"].includes(stage)) {
      throw new HttpError(400, "Invalid media cache producer stage");
    }
    const rpcName = action === "continuation-pulse"
      ? "norva_pulse_media_cache_continuation_for_gateway"
      : "norva_pulse_media_cache_producer_for_gateway";
    const { data, error } = await db.rpc(rpcName, {
      p_playback_session_id: playbackSessionId,
      p_gateway_session_id: gatewaySessionId,
      p_stage: stage,
      p_ttl_seconds: MEDIA_CACHE_SINGLEFLIGHT_LEASE_TTL_SECONDS,
    });
    if (error) throwDb(error, "Unable to renew shared media cache producer");
    const state = stringOr(data, "invalid");
    if (!["renewed", "preempted", "idle", "expired", "missing"].includes(state)) {
      throw new HttpError(503, "Shared media cache producer pulse is invalid");
    }
    if (["preempted", "idle", "expired", "missing"].includes(state)) {
      const metric = ["preempted", "idle"].includes(state) ? "fill_preempted" : "fill_expired";
      const outcome = ["preempted", "idle"].includes(state) ? "preempted" : "expired";
      runBackground(db.rpc("norva_record_media_cache_metric", {
        p_metric: metric, p_value: 1, p_samples: 1,
        p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
        p_route_protocol: "none", p_outcome: outcome, p_score: null, p_confidence: null,
      }).then(() => undefined));
    }
    return { protocol: 1, state };
  }

  const { data, error } = await db.rpc("norva_abandon_media_cache_producer_for_gateway", {
    p_playback_session_id: playbackSessionId,
    p_gateway_session_id: gatewaySessionId,
  });
  if (error) throwDb(error, "Unable to abandon shared media cache producer");
  const state = stringOr(data, "invalid");
  if (!["abandoned", "completed", "missing"].includes(state)) {
    throw new HttpError(503, "Shared media cache producer abandon is invalid");
  }
  if (state === "abandoned") {
    runBackground(db.rpc("norva_record_media_cache_metric", {
      p_metric: "fill_failed", p_value: 1, p_samples: 1,
      p_layer: "gateway", p_market_region: "global", p_route_slot: "none",
      p_route_protocol: "none", p_outcome: "failed", p_score: null, p_confidence: null,
    }).then(() => undefined));
  }
  return { protocol: 1, state };
}

async function runMediaCacheMaintenanceCore(
  db: SupabaseClient,
  runtimeConfig: RuntimeConfig,
  batch: number,
  scanOrphans = false,
): Promise<JsonRecord> {
  const workerUrl = mediaCachePlaybackWorkerUrl(runtimeConfig);
  if (!workerUrl) {
    return { protocol: 1, claimed: 0, completed: 0, retried: 0, state: "worker-unavailable" };
  }
  const ownerFingerprint = await sha256Hex(
    `media-cache-maintenance-v1\0${MEDIA_CACHE_SINGLEFLIGHT_OWNER_INSTANCE_ID}`,
  );
  let orphanCandidates = 0;
  if (scanOrphans) {
    try {
      let inventoryCursor: string | null = null;
      const { data: inventoryPolicy } = await db
        .from("media_cache_governance_policy")
        .select("r2_inventory_cursor")
        .eq("singleton", true)
        .maybeSingle();
      const persistedCursor = stringOrNull(recordOrEmpty(inventoryPolicy).r2_inventory_cursor);
      if (persistedCursor && persistedCursor.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(persistedCursor)) {
        inventoryCursor = persistedCursor;
      }
      const inventoryUrl = new URL(`${workerUrl}/internal/v1/inventory`);
      // R2 assets are intentionally uploaded before the authoritative manifest.
      // A large multi-rendition film can require thousands of bounded writes, so
      // automatic cleanup must never race a slow but still valid publication.
      inventoryUrl.searchParams.set("minimumAgeMs", String(24 * 60 * 60 * 1_000));
      inventoryUrl.searchParams.set("limit", String(Math.max(10, batch * 5)));
      if (inventoryCursor) inventoryUrl.searchParams.set("cursor", inventoryCursor);
      const inventoryResponse = await fetch(inventoryUrl.toString(), {
        headers: { Authorization: `Bearer ${runtimeConfig.mediaCacheWorkerToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (inventoryResponse.ok) {
        const inventory = recordOrEmpty(await inventoryResponse.json());
        const partialCandidates = Array.isArray(inventory.orphanCandidates)
          ? inventory.orphanCandidates
          : [];
        const manifestCandidates = Array.isArray(inventory.manifestCandidates)
          ? inventory.manifestCandidates
          : [];
        const seenInventoryKeys = new Set<string>();
        const candidates = [...partialCandidates, ...manifestCandidates]
          .filter((candidateValue) => {
            const objectKey = stringOr(recordOrEmpty(candidateValue).objectKey, "").toLowerCase();
            if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey) || seenInventoryKeys.has(objectKey)) return false;
            seenInventoryKeys.add(objectKey);
            return true;
          })
          .slice(0, batch);
        for (const candidateValue of candidates) {
          const objectKey = stringOr(recordOrEmpty(candidateValue).objectKey, "").toLowerCase();
          if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)) continue;
          const { data: jobId } = await db.rpc("norva_enqueue_media_cache_purge", {
            p_object_key: objectKey,
            p_reason: "orphan",
          });
          if (PLAYBACK_SESSION_UUID_PATTERN.test(stringOr(jobId, ""))) orphanCandidates += 1;
        }
        const truncated = inventory.truncated === true;
        const nextCursor = truncated ? stringOrNull(inventory.cursor) : null;
        if (!truncated || (nextCursor && nextCursor.length <= 1024
          && !/[\u0000-\u001f\u007f]/.test(nextCursor))) {
          await db.from("media_cache_governance_policy").update({
            r2_inventory_cursor: nextCursor,
            r2_inventory_scanned_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("singleton", true);
        }
      } else {
        await inventoryResponse.body?.cancel().catch(() => {});
      }
    } catch (_) {
      // Inventory is advisory. Existing DB purge jobs still run below.
    }
  }
  if (orphanCandidates > 0) {
    runBackground(db.rpc("norva_record_media_cache_metric", {
      p_metric: "orphan_candidate", p_value: orphanCandidates, p_samples: orphanCandidates,
      p_layer: "l2", p_market_region: "global", p_route_slot: "none",
      p_route_protocol: "none", p_outcome: "none", p_score: null, p_confidence: null,
    }).then(() => undefined));
  }
  let claimed = 0;
  let completed = 0;
  let retried = 0;
  for (let index = 0; index < batch; index += 1) {
    const { data, error } = await db.rpc("norva_claim_media_cache_purge", {
      p_lease_owner_fingerprint: ownerFingerprint,
      p_ttl_seconds: 120,
    });
    if (error) throwDb(error, "Unable to claim media cache purge");
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    if (rows.length === 0) break;
    if (rows.length !== 1) {
      throw new HttpError(503, "Media cache purge claim is ambiguous", {
        code: "MEDIA_CACHE_PURGE_CLAIM_INVALID",
      });
    }
    const job = recordOrEmpty(rows[0]);
    const jobId = stringOr(job.job_id, "").toLowerCase();
    const objectKey = stringOr(job.object_key, "").toLowerCase();
    const reason = stringOr(job.reason, "").toLowerCase();
    const leaseToken = stringOr(job.lease_token, "").toLowerCase();
    if (!PLAYBACK_SESSION_UUID_PATTERN.test(jobId)
      || !MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)
      || !["eviction", "orphan", "corruption", "legal", "security"].includes(reason)
      || !PLAYBACK_SESSION_UUID_PATTERN.test(leaseToken)) {
      throw new HttpError(503, "Media cache purge claim is invalid", {
        code: "MEDIA_CACHE_PURGE_CLAIM_INVALID",
      });
    }
    claimed += 1;
    let success = false;
    let errorCode: string | null = null;
    try {
      const response = await fetch(`${workerUrl}/internal/v1/cache-objects/${objectKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${runtimeConfig.mediaCacheWorkerToken}`,
          "x-norva-purge-reason": reason,
        },
        signal: AbortSignal.timeout(30_000),
      });
      success = response.ok;
      if (!success) errorCode = `worker-http-${response.status}`;
      await response.body?.cancel().catch(() => {});
    } catch (_) {
      errorCode = "worker-network";
    }
    const { data: completion, error: completionError } = await db.rpc(
      "norva_complete_media_cache_purge",
      {
        p_job_id: jobId,
        p_lease_owner_fingerprint: ownerFingerprint,
        p_lease_token: leaseToken,
        p_reason: reason,
        p_success: success,
        p_error_code: success ? null : errorCode,
      },
    );
    if (completionError) throwDb(completionError, "Unable to complete media cache purge");
    if (stringOr(completion, "") === "completed") completed += 1;
    else retried += 1;
  }
  return { protocol: 1, claimed, completed, retried, orphanCandidates, state: "ok" };
}

async function runMediaCacheMaintenance(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid media cache maintenance JSON");
  });
  if (!exactJsonKeys(body, ["batch", "protocol"]) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid media cache maintenance shape");
  }
  const batch = boundedInt(body.batch, 1, 1, 10);
  const { error: scheduleError } = await db.rpc("norva_schedule_media_cache_evictions", {
    p_batch: Math.max(25, batch),
  });
  if (scheduleError) throwDb(scheduleError, "Unable to schedule media cache eviction");
  const result = await runMediaCacheMaintenanceCore(db, runtimeConfig, batch, true);
  await Promise.resolve(db.rpc("norva_prune_media_cache_demand", { p_batch: 10_000 }))
    .catch(() => null);
  return result;
}

async function runMediaCachePurge(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid media cache purge JSON");
  });
  if (!exactJsonKeys(body, ["objectKey", "protocol", "reason"]) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid media cache purge shape");
  }
  const objectKey = stringOr(body.objectKey, "").toLowerCase();
  const reason = stringOr(body.reason, "").toLowerCase();
  if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)
    || !["corruption", "legal", "security"].includes(reason)) {
    throw new HttpError(400, "Invalid media cache purge request");
  }
  const { data, error } = await db.rpc("norva_enqueue_media_cache_purge", {
    p_object_key: objectKey,
    p_reason: reason,
  });
  if (error) throwDb(error, "Unable to enqueue media cache purge");
  const jobId = stringOr(data, "").toLowerCase();
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(jobId)) {
    throw new HttpError(404, "Media cache purge object not found", {
      code: "MEDIA_CACHE_PURGE_OBJECT_NOT_FOUND",
    });
  }

  // The enqueue RPC fences the object and revokes the relevant grants before
  // this best-effort physical deletion begins. A failed attempt stays queued
  // for the normal leased maintenance worker instead of reopening delivery.
  let maintenance: JsonRecord;
  try {
    maintenance = await runMediaCacheMaintenanceCore(db, runtimeConfig, 1, false);
  } catch (_) {
    maintenance = {
      protocol: 1,
      claimed: 0,
      completed: 0,
      retried: 0,
      state: "deferred",
    };
  }
  return {
    ok: true,
    protocol: 1,
    objectKey,
    reason,
    jobId,
    state: maintenance.completed === 1 ? "completed" : "queued",
    maintenance,
  };
}

async function runMediaCacheRecovery(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const workerUrl = mediaCachePlaybackWorkerUrl(runtimeConfig);
  if (!workerUrl) throw new HttpError(503, "Private media cache is unavailable");
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid media cache recovery JSON");
  });
  if (!exactJsonKeys(body, ["objectKey", "protocol"]) || body.protocol !== 1) {
    throw new HttpError(400, "Invalid media cache recovery shape");
  }
  const objectKey = stringOr(body.objectKey, "").toLowerCase();
  if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new HttpError(400, "Invalid media cache recovery object");
  }
  const response = await fetch(`${workerUrl}/internal/v1/recoveries/${objectKey}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtimeConfig.mediaCacheWorkerToken}`,
      "x-norva-recovery-phase": "verify",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(409, "Media cache recovery is not verified", {
      code: "MEDIA_CACHE_RECOVERY_UNVERIFIED",
    });
  }
  const recovered = recordOrEmpty(await response.json());
  const components = recordOrEmpty(recovered.components);
  const rootPlaylist = stringOr(recovered.rootPlaylist, "");
  const manifestSha256 = stringOr(recovered.manifestSha256, "").toLowerCase();
  const expiresAtMs = Number(recovered.expiresAtMs);
  const totalBytes = Number(recovered.totalBytes);
  const fileCount = Number(recovered.verifiedFiles);
  const componentDigests = MEDIA_CACHE_IDENTITY_COMPONENT_KEYS.map((key) =>
    stringOr(components[key], "").toLowerCase()
  );
  const [audioSha256, contentSha256, durationSha256, pipelineSha256,
    segmenterSha256, sizeSha256, subtitleSha256, videoSha256] = componentDigests;
  const identityEnvelope = JSON.stringify({
    components: {
      audio: audioSha256,
      content: contentSha256,
      duration: durationSha256,
      pipeline: pipelineSha256,
      segmenter: segmenterSha256,
      size: sizeSha256,
      subtitles: subtitleSha256,
      video: videoSha256,
    },
    namespace: "norva-global-media-object",
    schema: 1,
  });
  const derivedObjectKey = componentDigests.every((digest) => MEDIA_CACHE_OBJECT_KEY_PATTERN.test(digest))
    ? await sha256Hex(identityEnvelope)
    : "";
  const nowMs = Date.now();
  let committed = false;
  if (exactJsonKeys(recovered, [
    "components", "expiresAtMs", "manifestSha256", "objectKey", "ok", "phase", "protocol",
    "rootPlaylist", "status", "totalBytes", "verifiedFiles",
  ])
    && recovered.ok === true && recovered.protocol === 1
    && recovered.objectKey === objectKey && recovered.phase === "verify"
    && recovered.status === "verified-quarantined"
    && exactJsonKeys(components, MEDIA_CACHE_IDENTITY_COMPONENT_KEYS)
    && derivedObjectKey === objectKey
    && MEDIA_CACHE_OBJECT_KEY_PATTERN.test(manifestSha256)
    && MEDIA_CACHE_ROOT_PLAYLIST_PATTERN.test(rootPlaylist)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(rootPlaylist)
    && Number.isSafeInteger(expiresAtMs) && expiresAtMs > nowMs + 5 * 60_000
    && expiresAtMs <= nowMs + 90 * 24 * 60 * 60_000
    && Number.isSafeInteger(totalBytes) && totalBytes > 0
    && Number.isSafeInteger(fileCount) && fileCount >= 1 && fileCount <= 20_000) {
    const { data, error } = await db.rpc("norva_recover_media_cache_object", {
      p_object_key: objectKey,
      p_content_sha256: contentSha256,
      p_video_profile_sha256: videoSha256,
      p_audio_topology_sha256: audioSha256,
      p_subtitle_topology_sha256: subtitleSha256,
      p_root_playlist: rootPlaylist,
      p_manifest_sha256: manifestSha256,
      p_total_bytes: totalBytes,
      p_file_count: fileCount,
      p_expires_at: new Date(expiresAtMs).toISOString(),
    });
    if (!error) committed = data === true;
  }
  if (!committed) {
    // The verify phase deliberately leaves the Worker quarantine marker in
    // place, so a rejected DB fence has no authorization race to close.
    throw new HttpError(409, "Media cache recovery authority changed", {
      code: "MEDIA_CACHE_RECOVERY_REJECTED",
    });
  }
  let finalized = false;
  for (let attempt = 0; attempt < 2 && !finalized; attempt += 1) {
    try {
      const finalizeResponse = await fetch(`${workerUrl}/internal/v1/recoveries/${objectKey}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeConfig.mediaCacheWorkerToken}`,
          "x-norva-recovery-phase": "commit",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (finalizeResponse.ok) {
        const finalizedBody = recordOrEmpty(await finalizeResponse.json());
        finalized = ["ready", "already-ready"].includes(stringOr(finalizedBody.status, ""));
      } else {
        await finalizeResponse.body?.cancel().catch(() => {});
      }
    } catch (_) { /* bounded idempotent retry below */ }
  }
  if (!finalized) {
    // The Worker marker still blocks delivery unless a commit response was
    // positively verified. Re-fence the DB and let the purge queue regenerate.
    await Promise.resolve(db.rpc("norva_enqueue_media_cache_purge", {
      p_object_key: objectKey,
      p_reason: "corruption",
    })).catch(() => null);
    throw new HttpError(503, "Media cache recovery finalization failed", {
      code: "MEDIA_CACHE_RECOVERY_FINALIZE_FAILED",
    });
  }
  await Promise.resolve(db.rpc("norva_record_media_cache_metric", {
    p_metric: "cache_recovery", p_value: 1, p_samples: 1,
    p_layer: "l2", p_market_region: "global", p_route_slot: "none",
    p_route_protocol: "none", p_outcome: "recovered", p_score: null, p_confidence: null,
  })).catch(() => null);
  return { ok: true, protocol: 1, objectKey, status: "ready" };
}

async function runMediaCachePublicationCallback(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaCacheEnabled) {
    throw new HttpError(503, "Shared media cache publication is disabled", {
      code: "MEDIA_CACHE_DISABLED",
    });
  }
  const authorizedGatewayIds = requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json().then(recordOrEmpty).catch(() => {
    throw new HttpError(400, "Invalid media cache publication JSON");
  });
  if (!exactJsonKeys(body, [
    "gatewaySessionId", "object", "playbackSessionId", "protocol", "status",
  ]) || body.protocol !== 1 || body.status !== "ready") {
    throw new HttpError(400, "Invalid media cache publication shape");
  }
  const playbackSessionId = stringOr(body.playbackSessionId, "").toLowerCase();
  const gatewaySessionId = stringOr(body.gatewaySessionId, "").toLowerCase();
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId)
    || !PLAYBACK_SESSION_UUID_PATTERN.test(gatewaySessionId)) {
    throw new HttpError(400, "Invalid media cache publication session");
  }
  const object = recordOrEmpty(body.object);
  if (!exactJsonKeys(object, [
    "audioTopologySha256", "contentSha256", "durationMilliseconds", "expiresAt",
    "fileCount", "fileSizeBytes", "manifestSha256", "objectKey", "pipelineBuild",
    "rootPlaylist", "segmenterBuild", "storageBackend", "subtitleTopologySha256",
    "totalBytes", "videoProfileSha256",
  ])) {
    throw new HttpError(400, "Invalid media cache publication object");
  }
  const objectKey = stringOr(object.objectKey, "").toLowerCase();
  const digests = [
    object.contentSha256,
    object.videoProfileSha256,
    object.audioTopologySha256,
    object.subtitleTopologySha256,
    object.manifestSha256,
  ].map((value) => stringOr(value, "").toLowerCase());
  const rootPlaylist = stringOr(object.rootPlaylist, "");
  const pipelineBuild = stringOr(object.pipelineBuild, "").trim();
  const segmenterBuild = stringOr(object.segmenterBuild, "").trim();
  const expiresAt = stringOr(object.expiresAt, "");
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.now();
  if (!MEDIA_CACHE_OBJECT_KEY_PATTERN.test(objectKey)
    || digests.some((digest) => !MEDIA_CACHE_OBJECT_KEY_PATTERN.test(digest))
    || object.storageBackend !== "r2"
    || !MEDIA_CACHE_ROOT_PLAYLIST_PATTERN.test(rootPlaylist)
    || /(^|\/)\.{1,2}(\/|$)|\/\//.test(rootPlaylist)
    || !pipelineBuild || pipelineBuild.length > 256 || /[\u0000-\u001f\u007f]/.test(pipelineBuild)
    || !segmenterBuild || segmenterBuild.length > 256 || /[\u0000-\u001f\u007f]/.test(segmenterBuild)
    || !Number.isSafeInteger(object.fileSizeBytes) || Number(object.fileSizeBytes) <= 0
    || !Number.isSafeInteger(object.durationMilliseconds) || Number(object.durationMilliseconds) <= 0
    || !Number.isSafeInteger(object.totalBytes) || Number(object.totalBytes) <= 0
    || !Number.isSafeInteger(object.fileCount) || Number(object.fileCount) < 1 || Number(object.fileCount) > 20_000
    || !Number.isFinite(expiresAtMs) || expiresAtMs < nowMs + 5 * 60_000
    || expiresAtMs > nowMs + 90 * 24 * 60 * 60_000) {
    throw new HttpError(400, "Invalid media cache publication object");
  }

  const { data: gatewaySession, error: gatewayError } = await db
    .from("cloud_gateway_sessions")
    .select("id,user_id,playback_session_id,gateway_id,external_session_id,status")
    .eq("external_session_id", gatewaySessionId)
    .eq("playback_session_id", playbackSessionId)
    .maybeSingle();
  if (gatewayError) throwDb(gatewayError, "Unable to verify media cache Gateway session");
  if (!gatewaySession
    || !authorizedGatewayIds.has(stringOrNull(gatewaySession.gateway_id))
    || stringOr(gatewaySession.status, "") === "failed") {
    throw new HttpError(404, "Media cache publication session not found");
  }
  const userId = stringOr(gatewaySession.user_id, "");
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(userId)) {
    throw new HttpError(404, "Media cache publication session not found");
  }

  const { data, error } = await db.rpc("norva_commit_admitted_media_cache_publication", {
    p_playback_session_id: playbackSessionId,
    p_gateway_session_id: gatewaySessionId,
    p_user_id: userId,
    p_object_key: objectKey,
    p_content_sha256: digests[0],
    p_file_size_bytes: Number(object.fileSizeBytes),
    p_video_profile_sha256: digests[1],
    p_audio_topology_sha256: digests[2],
    p_subtitle_topology_sha256: digests[3],
    p_duration_milliseconds: Number(object.durationMilliseconds),
    p_pipeline_build: pipelineBuild,
    p_segmenter_build: segmenterBuild,
    p_storage_backend: "r2",
    p_root_playlist: rootPlaylist,
    p_manifest_sha256: digests[4],
    p_total_bytes: Number(object.totalBytes),
    p_file_count: Number(object.fileCount),
    p_expires_at: new Date(expiresAtMs).toISOString(),
  });
  if (error) throwDb(error, "Unable to commit shared media cache publication");
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const committed = rows.length === 1 ? recordOrEmpty(rows[0]) : {};
  const bindingId = stringOr(committed.binding_id, "").toLowerCase();
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(bindingId)
    || stringOr(committed.object_key, "") !== objectKey) {
    // The signed manifest is already visible in R2. Fence a lost-authority
    // publication as a delayed orphan; a concurrent valid publisher can cancel
    // the untouched job transactionally before any Worker deletion is leased.
    await Promise.resolve(db.rpc("norva_enqueue_media_cache_purge", {
      p_object_key: objectKey,
      p_reason: "orphan",
    })).catch(() => null);
    throw new HttpError(409, "Shared media cache publication authority changed", {
      code: "MEDIA_CACHE_PUBLICATION_REJECTED",
    });
  }
  const { data: producerStateValue, error: producerError } = await db.rpc(
    "norva_complete_media_cache_producer_for_gateway",
    {
      p_playback_session_id: playbackSessionId,
      p_gateway_session_id: gatewaySessionId,
      p_user_id: userId,
      p_object_key: objectKey,
    },
  );
  if (producerError) throwDb(producerError, "Unable to complete shared media cache producer");
  const producerState = stringOr(producerStateValue, "invalid");
  if (!["completed", "already-completed", "not-coordinated"].includes(producerState)) {
    throw new HttpError(503, "Shared media cache producer completion was rejected", {
      code: "MEDIA_CACHE_PRODUCER_COMPLETION_REJECTED",
    });
  }
  runBackground((async () => {
    await db.rpc("norva_record_media_cache_metric", {
      p_metric: "fill_completed",
      p_value: 1,
      p_samples: 1,
      p_layer: "l2",
      p_market_region: "global",
      p_route_slot: "none",
      p_route_protocol: "none",
      p_outcome: "completed",
      p_score: null,
      p_confidence: null,
    });
    await db.rpc("norva_schedule_media_cache_evictions", { p_batch: 25 });
    await runMediaCacheMaintenanceCore(db, runtimeConfig, 1);
  })());
  return { ok: true, protocol: 1, objectKey, bindingId, producerState };
}

async function runCompleteHlsCacheCallback(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const authorizedGatewayIds = requireConfiguredMediaGatewayCallback(req, runtimeConfig);
  const body = await req.json()
    .then(recordOrEmpty)
    .catch(() => { throw new HttpError(400, "Invalid callback JSON"); });
  const expectedKeys = [
    "finalCodecProfile",
    "gatewaySessionId",
    "playbackSessionId",
    "protocol",
    "status",
  ];
  const actualKeys = Object.keys(body).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new HttpError(400, "Invalid complete-cache callback shape");
  }

  const playbackSessionId = stringOrNull(body.playbackSessionId);
  const gatewaySessionId = stringOrNull(body.gatewaySessionId);
  if (
    body.protocol !== 1 || body.status !== "completed" ||
    !playbackSessionId || !PLAYBACK_SESSION_UUID_PATTERN.test(playbackSessionId) ||
    !gatewaySessionId || !PLAYBACK_SESSION_UUID_PATTERN.test(gatewaySessionId)
  ) {
    throw new HttpError(400, "Invalid complete-cache callback identity");
  }
  const finalCodecProfile = normalizeCodecProfile(recordOrEmpty(body.finalCodecProfile));
  if (
    !hasUsefulCodecProfile(finalCodecProfile) ||
    !normalizeMkvH264FastStartProof(finalCodecProfile.mkvCompleteHlsCacheProof)
  ) {
    throw new HttpError(422, "A finalized complete-cache profile is required");
  }

  const { data: gatewaySession, error: gatewayError } = await db
    .from("cloud_gateway_sessions")
    .select("id,user_id,playback_session_id,gateway_id,external_session_id,status")
    .eq("external_session_id", gatewaySessionId)
    .eq("playback_session_id", playbackSessionId)
    .maybeSingle();
  if (gatewayError) throwDb(gatewayError, "Unable to verify complete-cache gateway session");
  if (
    !gatewaySession ||
    !authorizedGatewayIds.has(stringOrNull(gatewaySession.gateway_id))
  ) {
    throw new HttpError(404, "Complete-cache session not found");
  }

  const gatewayUserId = stringOrNull(gatewaySession.user_id);
  if (!gatewayUserId) throw new HttpError(404, "Complete-cache session not found");
  const { data: playbackSession, error: playbackError } = await db
    .from("cloud_playback_sessions")
    .select("id,user_id,source_id,item_type,item_id,target_url_hash,playback_hint,status")
    .eq("id", playbackSessionId)
    .eq("user_id", gatewayUserId)
    .maybeSingle();
  if (playbackError) throwDb(playbackError, "Unable to verify complete-cache playback session");
  if (
    !playbackSession ||
    stringOr(playbackSession.item_type, "") !== "movie" ||
    !stringOrNull(playbackSession.source_id) ||
    !stringOrNull(playbackSession.item_id)
  ) {
    throw new HttpError(404, "Complete-cache session not found");
  }

  const persisted = await persistObservedCodecProfile(db, {
    userId: gatewayUserId,
    sourceId: String(playbackSession.source_id),
    itemType: "movie",
    itemId: String(playbackSession.item_id),
    codecProfile: finalCodecProfile,
    startupMs: null,
    audioMode: null,
    requireItemCas: true,
    expectedItemCas: mkvH264FastStartItemCasFromPlaybackSession(playbackSession),
    allowProofReplacement: true,
  });
  return { ok: true, protocol: 1, persisted };
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

async function providerCatalogRefreshDrainRemainingMs(
  db: SupabaseClient,
  providerAccountHash: string,
) {
  if (!PROVIDER_CATALOG_REFRESH_DRAIN_MS || !providerAccountHash) return 0;
  try {
    const { data, error } = await db
      .from("provider_account_activity")
      .select("kind,last_seen_at")
      .eq("account_key", providerAccountHash)
      .maybeSingle();
    if (error || stringOr(data?.kind, "") !== "catalog-refresh") return 0;
    const lastSeenAt = Date.parse(stringOr(data?.last_seen_at, ""));
    if (!Number.isFinite(lastSeenAt)) return 0;
    const ageMs = Date.now() - lastSeenAt;
    if (ageMs < 0 || ageMs >= PROVIDER_CATALOG_REFRESH_DRAIN_MS) return 0;
    return Math.ceil(PROVIDER_CATALOG_REFRESH_DRAIN_MS - ageMs);
  } catch (_) {
    // Activity is a best-effort coordination signal. A bookkeeping outage must
    // not turn into a new playback outage.
    return 0;
  }
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
  const requestedType = stringOr(body.type, "movie");
  const itemType = requestedType === "series" || requestedType === "episode"
    ? requestedType
    : "movie";
  const speechTarget = stringOr(body.speechTarget, "");
  const whisperDimension = mode === "whisper" && ["tagged", "untagged"].includes(speechTarget)
    ? `whisper-${speechTarget}`
    : mode;
  const dim = subtitleTarget ? "subtitle" : (whisperDimension || "vod");
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

function sweepHasPendingEvidence(result: JsonRecord): boolean {
  return result.hasMore === true
    || Math.max(0, Number(result.candidates) || 0) > 0
    || Math.max(0, Number(result.attempted) || 0) > 0
    || Math.max(0, Number(result.deferred) || 0) > 0
    || Math.max(0, Number(result.failed) || 0) > 0
    || Math.max(0, Number(result.backpressured) || 0) > 0;
}

async function recordExhaustion(db: SupabaseClient, key: string, result: JsonRecord) {
  try {
    if (result.skipped) return;                       // live-session ticks say nothing about the panel
    if (Number(result.processed) > 0 || sweepHasPendingEvidence(result)) {
      await db.from("enrichment_exhausted").delete().eq("k", key);
      return;
    }
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

function sanitizedProviderErrorCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : null;
}

function providerProbeRejectedBeforeSpawn(
  status: number,
  providerCode: string | null,
): boolean {
  return (
    (status === 409 && providerCode === "account_busy") ||
    (status === 429 && providerCode === "background_busy")
  );
}

function providerProbeResponseAllowsLeaseRelease(
  status: number,
  providerCode: string | null,
  payload: JsonRecord,
  retainLeaseUntilExpiry: () => void,
): boolean {
  // These two Gateway responses are emitted before ffprobe is spawned, so no
  // provider transport exists to drain. Every other response, including
  // viewer_preempted and terminal/non-2xx responses, needs protocol-v1 proof.
  if (providerProbeRejectedBeforeSpawn(status, providerCode)) {
    return true;
  }
  return acceptGatewayProviderDrain(payload, retainLeaseUntilExpiry);
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

async function readProviderProbeCircuitStateStrict(
  db: SupabaseClient,
  identityKey: string,
): Promise<{ open: boolean; openUntil: string | null }> {
  if (!identityKey) throw new HttpError(422, "Provider identity is unavailable");
  const { data, error } = await db.rpc("provider_probe_circuit_state", {
    p_identity_key: identityKey,
  });
  if (error) throwDb(error, "Unable to verify provider probe availability");
  const state = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
  return {
    open: state?.open === true,
    openUntil: stringOrNull(state?.open_until),
  };
}

async function assertProviderProbeCircuitClosedStrict(
  db: SupabaseClient,
  identityKey: string,
) {
  const state = await readProviderProbeCircuitStateStrict(db, identityKey);
  if (!state.open) return;
  throw new HttpError(409, "Provider probe circuit is open", {
    code: "PROVIDER_PROBE_CIRCUIT_OPEN",
    openUntil: state.openUntil,
  });
}

async function runCodecProfileBackfill(
  req: Request,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || provided !== expected) throw new HttpError(401, "Unauthorized");

  const body = recordOrEmpty(await req.json().catch(() => ({})));
  const userId = stringOr(body.userId, "").trim().toLowerCase();
  const requestedVariantIds = Array.isArray(body.variantIds ?? body.variant_ids)
    ? (body.variantIds ?? body.variant_ids) as unknown[]
    : [];
  if (!PLAYBACK_SESSION_UUID_PATTERN.test(userId)) {
    throw new HttpError(400, "A valid userId is required");
  }
  if (!requestedVariantIds.length) {
    throw new HttpError(400, "At least one exact variantId is required");
  }
  if (requestedVariantIds.some((value) =>
    typeof value !== "string" || !PLAYBACK_SESSION_UUID_PATTERN.test(value.trim())
  )) {
    throw new HttpError(400, "Every variantId must be a UUID");
  }
  const uniqueVariantIds = [...new Set(
    requestedVariantIds.map((value) => String(value).trim().toLowerCase()),
  )];
  if (uniqueVariantIds.length > 10) {
    throw new HttpError(400, "At most ten exact variants may be backfilled");
  }
  const variantIds = uniqueVariantIds.slice(0, 10);

  const initialBlock = await episodeBackgroundBlockReason(db, userId);
  if (initialBlock) {
    return {
      protocol: 1,
      requested: variantIds.length,
      attempted: 0,
      persisted: 0,
      skipped: initialBlock,
      results: [],
    };
  }

  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Media gateway is not configured");
  }

  const { data: rawVariants, error: variantsError } = await db
    .from("cloud_catalog_visible_title_variants")
    .select("id,source_id,external_id,item_type")
    .eq("user_id", userId)
    .eq("item_type", "movie")
    .in("id", variantIds);
  if (variantsError) throwDb(variantsError, "Unable to load exact movie variants");
  const variants = (rawVariants ?? []).map((value) => value as JsonRecord);
  if (variants.length !== variantIds.length) {
    throw new HttpError(404, "One or more exact movie variants were not found");
  }
  const variantsById = new Map(
    variants.map((variant) => [stringOr(variant.id, "").toLowerCase(), variant]),
  );

  let attempted = 0;
  let persisted = 0;
  let stopped: string | null = null;
  const results: JsonRecord[] = [];

  for (const variantId of variantIds) {
    const variant = variantsById.get(variantId);
    if (!variant) throw new HttpError(404, "Exact movie variant was not found");
    const sourceId = stringOr(variant.source_id, "");
    const externalId = stringOr(variant.external_id, "");
    if (!sourceId || !externalId) {
      throw new HttpError(422, "Exact movie variant is incomplete");
    }

    const sourceIdentity = await resolveSourceIdentity(sourceId, userId, db);
    const identityKey = sourceIdentity.key;
    if (!identityKey || identityKey.startsWith("source:")) {
      stopped = "provider-identity-pending";
      results.push({ variantId, status: "deferred", code: stopped });
      break;
    }

    const target = await resolvePlaybackTarget(sourceId, "movie", externalId, userId, db);
    const targetUrl = stringOrNull(target?.targetUrl);
    if (!targetUrl) throw new HttpError(404, "Playback target unavailable");
    const providerAccountHash = await providerAccountHashFromUrl(targetUrl);

    const persistTrackMaps = async (
      profileValue: unknown,
      audioMarker: unknown,
      subtitleMarker: unknown,
    ) => {
      const rawProfile = recordOrEmpty(profileValue);
      const hasAudioMap = authoritativeProbeFacetComplete(
        audioMarker,
        Array.isArray(rawProfile.audioTracks ?? rawProfile.audio_tracks),
      );
      const hasSubtitleMap = authoritativeProbeFacetComplete(
        subtitleMarker,
        Array.isArray(rawProfile.subtitles ?? rawProfile.subtitleTracks ?? rawProfile.subtitle_tracks),
      );
      if (!hasAudioMap && !hasSubtitleMap) {
        throw new HttpError(502, "Media gateway omitted exact-file track maps");
      }
      const profile = normalizeCodecProfile(rawProfile);
      const audioTracks = (Array.isArray(profile.audioTracks) ? profile.audioTracks as JsonRecord[] : [])
        .map((track) => compactRecord({
          index: boundedNullableInt(track.index, 0, 128),
          lang: normalizeIsoLang(stringOrNull(track.language ?? track.lang)),
          codec: stringOrNull(track.codec),
          channels: boundedNullableInt(track.channels, 0, 16),
          default: booleanOrNull(track.default),
        }));
      const subtitleTracks = (Array.isArray(profile.subtitles) ? profile.subtitles as JsonRecord[] : [])
        .map((track) => compactRecord({
          index: boundedNullableInt(track.index, 0, 128),
          lang: normalizeIsoLang(stringOrNull(track.language ?? track.lang)),
          codec: stringOrNull(track.codec),
          subtitleType: stringOrNull(track.subtitleType ?? track.subtitle_type),
          extractable: booleanOrNull(track.extractable),
          forced: booleanOrNull(track.forced),
          default: booleanOrNull(track.default),
        }));
      const tracksPersisted = await shareFileTracks(
        db,
        identityKey,
        "movie",
        externalId,
        audioTracks,
        subtitleTracks,
        hasAudioMap,
        hasSubtitleMap,
      );
      if (!tracksPersisted) {
        throw new HttpError(503, "Unable to persist exact-file track maps");
      }
    };

    const beforeClaimBlock = await episodeBackgroundBlockReason(db, userId, targetUrl);
    if (beforeClaimBlock) {
      stopped = beforeClaimBlock;
      results.push({ variantId, status: "deferred", code: beforeClaimBlock });
      break;
    }
    await assertProviderCircuitClosed(providerAccountHash, db);
    await assertProviderProbeCircuitClosedStrict(db, identityKey);

    const leaseOwner = `codec-profile:${crypto.randomUUID()}`;
    if (!await claimProviderFileProbeStrict(db, identityKey, leaseOwner, 180)) {
      stopped = "provider-lease-busy";
      results.push({ variantId, status: "deferred", code: stopped });
      break;
    }

    let releaseLeaseOnExit = true;
    let providerTransportMayBeActive = false;
    try {
      const raceBlock = await episodeBackgroundBlockReason(db, userId, targetUrl);
      if (raceBlock) {
        stopped = `${raceBlock}-race`;
        results.push({ variantId, status: "deferred", code: stopped });
        break;
      }
      await assertProviderCircuitClosed(providerAccountHash, db);
      await assertProviderProbeCircuitClosedStrict(db, identityKey);

      attempted += 1;
      providerTransportMayBeActive = true;
      const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
        },
        body: JSON.stringify({
          url: targetUrl,
          userAgent: "VLC/3.0.20 LibVLC/3.0.20",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const info = recordOrEmpty(await response.json().catch(() => ({})));
      const providerCode = sanitizedProviderErrorCode(
        info.code ?? info.errorCode ?? info.error_code,
      );
      const leaseReleaseSafe = providerProbeResponseAllowsLeaseRelease(
        response.status,
        providerCode,
        info,
        () => { releaseLeaseOnExit = false; },
      );
      providerTransportMayBeActive = !leaseReleaseSafe;
      const terminalCode = providerProbeTerminalCode({
        status: response.status,
        code: providerCode ?? undefined,
      });

      if (terminalCode === "proxy_auth_failed") {
        stopped = "proxy_auth_failed";
        results.push({ variantId, status: "failed", code: stopped });
        break;
      }
      if (terminalCode === "provider_busy") {
        const circuit = await openProviderPlaybackCircuit(providerAccountHash, db, true);
        stopped = "provider_busy";
        results.push({
          variantId,
          status: "blocked",
          code: stopped,
          retryAfterSeconds: circuit.retryAfterSeconds,
        });
        break;
      }
      if (
        response.status === 409 ||
        providerCode === "account_busy" ||
        providerCode === "viewer_preempted" ||
        providerCode === "background_busy"
      ) {
        stopped = providerCode || "provider_account_busy";
        results.push({ variantId, status: "deferred", code: stopped });
        break;
      }
      if (!response.ok) {
        throw new HttpError(response.status, "Media gateway codec probe failed", {
          code: providerCode || "gateway_probe_failed",
        });
      }
      if (!leaseReleaseSafe) {
        stopped = "provider-drain-unattested";
        results.push({ variantId, status: "deferred", code: stopped });
        break;
      }

      const observedProfile = recordOrEmpty(info.codecProfile ?? info.codec_profile);
      if (!hasReliableVodCodecProfile(observedProfile)) {
        throw new HttpError(502, "Media gateway returned an incomplete codec profile", {
          code: "incomplete_codec_profile",
        });
      }
      await persistObservedCodecProfile(db, {
        userId,
        sourceId,
        itemType: "movie",
        itemId: externalId,
        codecProfile: observedProfile,
        startupMs: null,
        audioMode: null,
        variantId,
        strict: true,
      });
      await persistTrackMaps(
        observedProfile,
        info.audioProbeComplete,
        info.subtitleProbeComplete,
      );
      persisted += 1;
      results.push({ variantId, status: "persisted" });
    } catch (error) {
      // A failed fetch/body read provides no proof that ffprobe and its socket
      // exited. Preserve the distributed exclusion until its database TTL.
      if (providerTransportMayBeActive) releaseLeaseOnExit = false;
      throw error;
    } finally {
      if (releaseLeaseOnExit) {
        await releaseProviderFileProbe(db, identityKey, leaseOwner);
      }
    }
  }

  return {
    protocol: 1,
    requested: variantIds.length,
    attempted,
    persisted,
    stopped,
    results,
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
    .from("cloud_catalog_visible_title_variants")
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
  if (auditMeta.userId) {
    try {
      await bindCatalogVisibilityEpochShared(req, auditMeta.userId, db);
    } catch (_) {
      throw new HttpError(503, "Catalog visibility is temporarily unavailable");
    }
  }
  const withAuditMeta = (payload: JsonRecord): JsonRecord => ({ ...payload, audit: auditMeta });
  if (
    auditMeta.userId &&
    auditMeta.sourceId &&
    !await sourceCatalogVisible(auditMeta.sourceId, auditMeta.userId, db)
  ) {
    return withAuditMeta({
      processed: 0,
      updated: 0,
      skipped: "source-catalog-not-visible",
      code: "SOURCE_CATALOG_NOT_VISIBLE",
    });
  }

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
    await recordExhaustion(db, soloKey, soloRes);
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
    if (key) await recordExhaustion(db, key, r);
    tried.push({ type: stringOr(dim.type, "?"), kind, processed, skipped: stringOrNull(r?.skipped) });
    if (r?.skipped) return withAuditMeta({ mode: "fallthrough", stoppedAt: r.skipped, tried });   // live viewer / in-flight pregen → stop the whole chain
    if (processed > 0) return withAuditMeta({ mode: "fallthrough", workedOn: tried[tried.length - 1], tried, result: r });
  }
  return withAuditMeta({ mode: "fallthrough", exhausted: true, tried });
}

async function claimProviderFileProbeStrict(
  db: SupabaseClient,
  identityKey: string,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!identityKey || !owner) return false;
  try {
    const { data, error } = await db.rpc("claim_provider_file_probe", {
      p_identity_key: identityKey,
      p_lease_owner: owner,
      p_ttl_seconds: Math.max(30, Math.min(900, Math.round(ttlSeconds))),
    });
    return !error && data === true;
  } catch (_) {
    return false;
  }
}

async function episodeBackgroundBlockReason(
  db: SupabaseClient,
  userId: string,
  targetUrl = "",
): Promise<string | null> {
  try {
    const sinceIso = new Date(
      Date.now() - Math.max(4 * 60 * 1000, CRAWL_VIEWER_GRACE_MS),
    ).toISOString();
    const { data: events, error: eventsError } = await db.from("cloud_playback_events")
      .select("id").eq("user_id", userId).gt("created_at", sinceIso).limit(1);
    if (eventsError) return "viewer-guard-unavailable";
    if (events?.length) return "live-session";

    const { data: history, error: historyError } = await db.from("cloud_watch_history")
      .select("id").eq("user_id", userId).gt("updated_at", sinceIso).limit(1);
    if (historyError) return "viewer-guard-unavailable";
    if (history?.length) return "live-session";

    const { data: sessions, error: sessionsError } = await db.from("cloud_playback_sessions")
      .select("id").eq("user_id", userId).eq("status", "ready")
      .gt("expires_at", new Date().toISOString()).limit(1);
    if (sessionsError) return "viewer-guard-unavailable";
    if (sessions?.length) return "live-session";

    const pregenSince = new Date(Date.now() - PREGEN_ACTIVE_TTL_MS).toISOString();
    const { data: pregen, error: pregenError } = await db.from("catalog_generated_subtitles")
      .select("job_id").eq("claimed_by", userId).eq("status", "processing")
      .gt("updated_at", pregenSince).limit(1);
    if (pregenError) return "pregen-guard-unavailable";
    if (pregen?.length) return "pregen-active";

    if (targetUrl) {
      const accountKey = providerAccountKeyFromUrl(targetUrl);
      if (!accountKey) return "provider-account-unresolved";
      const { data: busy, error: busyError } = await db.rpc("provider_account_busy", {
        p_key: accountKey,
      });
      if (busyError) return "provider-guard-unavailable";
      if (busy === true) return "provider-account-busy";
    }
    return null;
  } catch (_) {
    return "background-guard-unavailable";
  }
}

function episodeAudioTracks(value: unknown): Array<{
  index: number;
  lang: string | null;
  lidAttemptedAt?: string | null;
  lidVerdict?: string | null;
  lidMethod?: string | null;
  lidConfidence?: number | null;
  speechVerifiedAt?: string | null;
  speechVerdict?: string | null;
}> {
  return (Array.isArray(value) ? value as JsonRecord[] : [])
    .map((track) => ({
      index: Number(track?.index),
      lang: normalizeIsoLang(stringOrNull(track?.lang ?? track?.language)),
      lidAttemptedAt: stringOrNull(track?.lidAttemptedAt ?? track?.lid_attempted_at),
      lidVerdict: stringOrNull(track?.lidVerdict ?? track?.lid_verdict),
      lidMethod: stringOrNull(track?.lidMethod ?? track?.lid_method),
      lidConfidence: (track?.lidConfidence ?? track?.lid_confidence) != null
          && Number.isFinite(Number(track?.lidConfidence ?? track?.lid_confidence))
        ? Number(track?.lidConfidence ?? track?.lid_confidence)
        : null,
      speechVerifiedAt: stringOrNull(track?.speechVerifiedAt ?? track?.speech_verified_at),
      speechVerdict: stringOrNull(track?.speechVerdict ?? track?.speech_verdict),
    }))
    .filter((track) => Number.isInteger(track.index));
}

async function episodeProbeCircuitState(
  db: SupabaseClient,
  providerIdentityKey: string,
): Promise<{ open: boolean; openUntil: string | null }> {
  // This guard sits immediately before provider I/O. An unavailable circuit
  // read is not evidence that the provider is safe, so let the typed DB error
  // abort the request before a URL is fetched or an extraction lease is used.
  return await readProviderProbeCircuitStateStrict(db, providerIdentityKey);
}

async function episodeProbeRetryBlocked(
  db: SupabaseClient,
  values: { userId: string; sourceId: string; variantId: string; episodeId: string },
): Promise<{ blocked: boolean; nextRetryAt: string | null }> {
  try {
    const { data, error } = await db.rpc("catalog_episode_probe_retry_state", {
      p_user: values.userId,
      p_source: values.sourceId,
      p_variant: values.variantId,
      p_episode_id: values.episodeId,
    });
    if (error) return { blocked: false, nextRetryAt: null };
    const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
    return {
      blocked: row?.blocked === true,
      nextRetryAt: stringOrNull(row?.next_retry_at),
    };
  } catch (_) {
    return { blocked: false, nextRetryAt: null };
  }
}

async function recordEpisodeProbeOutcome(
  db: SupabaseClient,
  values: {
    userId: string;
    sourceId: string;
    variantId: string;
    episodeId: string;
    success: boolean;
    status?: number | null;
    code?: string | null;
  },
) {
  try {
    const { error } = await db.rpc("record_catalog_episode_probe_outcome", {
      p_user: values.userId,
      p_source: values.sourceId,
      p_variant: values.variantId,
      p_episode_id: values.episodeId,
      p_success: values.success,
      p_status: values.status ?? null,
      p_code: values.code ?? null,
      p_transport: "gateway",
      p_retry_at: null,
    });
    if (error) {
      console.warn(
        "[norva-playback] episode probe retry state unavailable",
        sanitizedProviderErrorCode(error.code) ?? "rpc_failed",
      );
    }
  } catch (_) { /* best-effort exact-file cooldown */ }
}

async function runEpisodeAudioBackfill(
  db: SupabaseClient,
  body: JsonRecord,
): Promise<JsonRecord> {
  const userId = stringOr(body.userId, "");
  const sourceId = stringOr(body.sourceId, "");
  const mode = stringOr(body.mode, "probe") === "whisper" ? "whisper" : "probe";
  const requestedLimit = Math.max(1, Math.min(6, Number(body.limit) || 1));
  if (!userId || !sourceId) {
    throw new HttpError(400, "Episode audio backfill requires userId and sourceId");
  }
  if (!await sourceCatalogVisible(sourceId, userId, db)) {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      updated: 0,
      skipped: "source-catalog-not-visible",
      code: "SOURCE_CATALOG_NOT_VISIBLE",
      hasMore: false,
    };
  }

  try {
    const { data: enabled, error } = await db.rpc("feature_flag", {
      p_key: "episode_audio_scan_enabled",
    });
    if (error || enabled !== true) {
      return { mode, itemType: "episode", processed: 0, skipped: "episode-audio-scan-disabled" };
    }
  } catch (_) {
    return { mode, itemType: "episode", processed: 0, skipped: "episode-audio-scan-disabled" };
  }

  const { data: source, error: sourceError } = await db.from("cloud_catalog_visible_sources")
    .select("source_type")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sourceError) throwDb(sourceError, "Unable to verify episode audio source");
  if (!source) {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      skipped: "source-unavailable",
      hasMore: false,
      exhausted: true,
    };
  }
  if (stringOr((source as JsonRecord).source_type, "") !== "xtream") {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      skipped: "unsupported-source",
      hasMore: false,
      exhausted: true,
    };
  }

  const initialBlock = await episodeBackgroundBlockReason(db, userId);
  if (initialBlock) {
    return { mode, itemType: "episode", processed: 0, skipped: initialBlock };
  }

  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    throw new HttpError(503, "Media gateway is not configured");
  }
  if (mode === "whisper") {
    const policy = await getLidDetectionPolicy(db);
    if (!policy.enabled) {
      return { mode, itemType: "episode", processed: 0, skipped: "audio-lid-disabled" };
    }
  }

  const sourceConfig = await loadSourceConfig(sourceId, userId, db);
  const serverUrl = stringOr(sourceConfig.serverUrl, "");
  const username = typeof sourceConfig.username === "string" && sourceConfig.username.trim()
    ? sourceConfig.username : "";
  const password = typeof sourceConfig.password === "string" && sourceConfig.password.length
    ? sourceConfig.password : "";
  if (!serverUrl || !username || !password) {
    throw new HttpError(400, "Xtream source credentials are incomplete");
  }
  const sourceIdentity = await resolveSourceIdentity(sourceId, userId, db);
  if (!sourceIdentity.key || sourceIdentity.key.startsWith("source:")) {
    return { mode, itemType: "episode", processed: 0, skipped: "provider-identity-pending" };
  }

  const initialCircuit = await episodeProbeCircuitState(db, sourceIdentity.key);
  if (initialCircuit.open) {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      skipped: "circuit_open",
      openUntil: initialCircuit.openUntil,
      // Deferred work is not completed work. Keeping hasMore=true here marks
      // cycle_had_work and prevents the scheduler's lane-11 rest forever.
      hasMore: false,
    };
  }

  const footprint = await getFootprint(db, sourceId, userId);
  // Low-footprint providers remain on the historical four-file ceiling even
  // while the general canary advances to five/six.
  const limit = footprint?.lowFootprint
    ? Math.min(requestedLimit, 4)
    : requestedLimit;
  if (footprint?.lowFootprint && !footprint.allowed) {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      skipped: "footprint-budget",
      hitsLastHour: footprint.hits,
      maxPerHour: footprint.maxPerHour,
      batchLimit: limit,
      hasMore: false,
    };
  }

  const candidateRpc = mode === "whisper"
    ? "catalog_episode_lid_candidates"
    : "catalog_episode_probe_candidates";
  const { data, error } = await db.rpc(candidateRpc, {
    p_user: userId,
    p_source: sourceId,
    p_limit: limit,
  });
  if (error) throwDb(error, "Unable to load exact episode audio candidates");
  const candidates = (Array.isArray(data) ? data : [])
    .map((row) => row as JsonRecord)
    .filter((row) =>
      stringOr(row.user_id, "") === userId
      && stringOr(row.source_id, "") === sourceId
      && stringOr(row.server_host, "") === sourceIdentity.key
      && stringOr(row.episode_id, "")
      && stringOr(row.parent_series_id, "")
      && stringOr(row.title_id, "")
      && stringOr(row.variant_id, "")
    );
  if (!candidates.length) {
    return {
      mode,
      itemType: "episode",
      processed: 0,
      candidates: 0,
      batchLimit: limit,
      hasMore: false,
    };
  }

  await bumpEnrichmentHeartbeat(db, userId);
  let attempted = 0;
  let processed = 0;
  let persisted = 0;
  let resolved = 0;
  let deferred = 0;
  let backpressured = 0;
  let failed = 0;
  let skipped: string | null = null;
  let circuitOpenUntil: string | null = null;
  let footprintHitsThisBatch = 0;
  let probeHealthOk = 0;
  let probeHealthBanish = 0;
  for (const candidate of candidates) {
    const episodeId = stringOr(candidate.episode_id, "");
    const variantId = stringOr(candidate.variant_id, "");
    const targetUrl = xtreamStreamUrl({
      serverUrl,
      username,
      password,
      streamType: "series",
      streamId: episodeId,
      container: stringOr(candidate.container_extension, "mp4"),
    });
    const beforeClaimBlock = await episodeBackgroundBlockReason(db, userId, targetUrl);
    if (beforeClaimBlock) {
      skipped = beforeClaimBlock;
      break;
    }
    const liveCircuit = await episodeProbeCircuitState(db, sourceIdentity.key);
    if (liveCircuit.open) {
      skipped = "circuit_open";
      circuitOpenUntil = liveCircuit.openUntil;
      break;
    }
    if (
      footprint?.lowFootprint
      && footprint.maxPerHour != null
      && footprint.hits + footprintHitsThisBatch >= footprint.maxPerHour
    ) {
      skipped = "footprint-budget";
      break;
    }
    if (mode === "probe") {
      const retryState = await episodeProbeRetryBlocked(db, {
        userId,
        sourceId,
        variantId,
        episodeId,
      });
      if (retryState.blocked) {
        deferred += 1;
        continue;
      }
    }
    const leaseOwner = `episode-${mode}:${crypto.randomUUID()}`;
    let probeResponseReceived = false;
    let footprintHitRecorded = false;
    const recordFootprintHit = async () => {
      if (!footprint?.lowFootprint || footprintHitRecorded) return;
      footprintHitRecorded = true;
      footprintHitsThisBatch += 1;
      try {
        await db.rpc("provider_footprint_record_hit", {
          p_identity_key: footprint.identityKey,
        });
      } catch (_) { /* best-effort budget accounting */ }
    };
    if (!await claimProviderFileProbeStrict(
      db,
      sourceIdentity.key,
      leaseOwner,
      mode === "whisper" ? 900 : 180,
    )) {
      skipped = "provider-lease-busy";
      break;
    }
    let releaseLeaseOnExit = true;
    let providerTransportMayBeActive = false;
    try {
      const raceBlock = await episodeBackgroundBlockReason(db, userId, targetUrl);
      if (raceBlock) {
        skipped = `${raceBlock}-race`;
        break;
      }
      attempted += 1;
      if (mode === "probe") {
        providerTransportMayBeActive = true;
        const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
          },
          body: JSON.stringify({
            url: targetUrl,
            userAgent: "VLC/3.0.20 LibVLC/3.0.20",
          }),
          signal: AbortSignal.timeout(60_000),
        });
        probeResponseReceived = true;
        const info = recordOrEmpty(await response.json().catch(() => ({})));
        const providerCode = sanitizedProviderErrorCode(info.code);
        const locallyRejected = (
          (response.status === 409 && providerCode === "account_busy")
          || (response.status === 429 && providerCode === "background_busy")
        );
        const leaseReleaseSafe = providerProbeResponseAllowsLeaseRelease(
          response.status,
          providerCode,
          info,
          () => { releaseLeaseOnExit = false; },
        );
        providerTransportMayBeActive = !leaseReleaseSafe;
        // account_busy/background_busy are rejected before spawn. A
        // viewer_preempted response happens after ffprobe opened the provider
        // stream and was killed, so it still consumes the anti-ban budget.
        if (!locallyRejected) await recordFootprintHit();
        if (
          response.status === 409
          || providerCode === "account_busy"
          || providerCode === "viewer_preempted"
        ) {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: response.status,
            code: providerCode,
          });
          backpressured += 1;
          skipped = "viewer-preempted";
          break;
        }
        if (response.status === 429 && providerCode === "background_busy") {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: response.status,
            code: providerCode,
          });
          backpressured += 1;
          // This is the gateway's own sequential background lease, not a
          // provider refusal. It must never open the provider circuit.
          skipped = "background-busy";
          break;
        }
        if (response.status === 429) {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: response.status,
            code: providerCode,
          });
          backpressured += 1;
          probeHealthBanish += 1;
          skipped = "provider-backpressure";
          break;
        }
        if (!response.ok) {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: response.status,
            code: providerCode,
          });
          failed += 1;
          if (isBanishStatus(response.status)) {
            probeHealthBanish += 1;
            skipped = "provider-refused";
            break;
          }
          continue;
        }
        if (!leaseReleaseSafe) {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: 502,
            code: "provider_drain_unattested",
          });
          deferred += 1;
          skipped = "provider-drain-unattested";
          break;
        }
        probeHealthOk += 1;
        const audioTracks = episodeAudioTracks(info.audioTracks);
        const audioProbeComplete = authoritativeProbeFacetComplete(
          info.audioProbeComplete,
          audioTracks.length > 0,
        );
        if (!audioProbeComplete || !audioTracks.length) {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: 422,
            code: "no_audio_tracks",
          });
          failed += 1;
          continue;
        }
        const subtitles = (Array.isArray(info.subtitles) ? info.subtitles as JsonRecord[] : [])
          .map((track) => ({
            index: Number(track?.index),
            lang: normalizeIsoLang(stringOrNull(track?.lang ?? track?.language)),
            codec: stringOrNull(track?.codec),
            subtitleType: stringOrNull(track?.subtitleType)
              || (track?.extractable ? "text" : "image"),
            extractable: track?.extractable === true,
            forced: track?.forced === true,
            default: track?.default === true,
          }))
          .filter((track) => Number.isInteger(track.index));
        const subtitleProbeComplete = authoritativeProbeFacetComplete(
          info.subtitleProbeComplete,
          audioProbeComplete || subtitles.length > 0,
        );
        const stored = await shareFileTracks(
          db,
          sourceIdentity.key,
          "episode",
          episodeId,
          audioTracks,
          subtitles,
          audioProbeComplete,
          subtitleProbeComplete,
        );
        processed += 1;
        if (stored) {
          if (audioTracks.some((track) => !normalizeIsoLang(track.lang))) {
            try {
              await enqueueAutomaticStrictLanguageValidation({
                db,
                userId,
                sourceId,
                identityKey: sourceIdentity.key,
                itemType: "episode",
                itemId: episodeId,
                variantId,
                profile: recordOrEmpty(info.codecProfile ?? info.codec_profile),
                providerDrainAttested: gatewayProviderDrainAttested(info),
              });
            } catch (_) {
              // Exact track discovery remains valid. Leave the language null so
              // the next bounded probe can retry durable strict-job creation.
            }
          }
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: true,
            status: 200,
          });
          persisted += 1;
          resolved += audioTracks.filter((track) => Boolean(track.lang)).length;
        }
        else {
          await recordEpisodeProbeOutcome(db, {
            userId,
            sourceId,
            variantId,
            episodeId,
            success: false,
            status: 500,
            code: "observation_write_failed",
          });
          failed += 1;
        }
      } else {
        const audioTracks = episodeAudioTracks(candidate.audio_tracks);
        if (!audioTracks.some((track) => !track.lang)) {
          continue;
        }
        await recordFootprintHit();
        const beforeUnknown = audioTracks.filter((track) => !track.lang).length;
        const beforeAttemptedAt = stringOrNull(candidate.audio_whisper_attempted_at);
        const beforeRetryAt = stringOrNull(candidate.audio_whisper_retry_at);
        await detectUntaggedAudioLanguages({
          db,
          runtimeConfig,
          userId,
          sourceId,
          targetUrl,
          userAgent: null,
          audioTracks,
          titleId: stringOr(candidate.title_id, ""),
          tmdbId: null,
          serverHost: sourceIdentity.key,
          itemType: "episode",
          fileExternalId: episodeId,
          sessionId: `episode-lid:${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          variantId: stringOr(candidate.variant_id, ""),
          fileScoped: true,
        });
        const { data: refreshed, error: refreshError } = await db.from("catalog_file_tracks")
          .select("audio_tracks,audio_whisper_attempted_at,audio_whisper_retry_at,audio_lang_verification")
          .eq("server_host", sourceIdentity.key)
          .eq("item_type", "episode")
          .eq("external_id", episodeId)
          .maybeSingle();
        if (refreshError || !refreshed) {
          failed += 1;
          continue;
        }
        const refreshedRow = refreshed as JsonRecord;
        const afterTracks = episodeAudioTracks(refreshedRow.audio_tracks);
        const afterUnknown = afterTracks.filter((track) => !track.lang).length;
        const cacheAdvanced = afterUnknown < beforeUnknown
          || afterTracks.some((track) => {
            const before = audioTracks.find((candidateTrack) => candidateTrack.index === track.index);
            return Boolean(
              before
              && !before.lidAttemptedAt
              && track.lidAttemptedAt,
            );
          })
          || stringOrNull(refreshedRow.audio_whisper_attempted_at) !== beforeAttemptedAt
          || stringOrNull(refreshedRow.audio_whisper_retry_at) !== beforeRetryAt
          || stringOr(recordOrEmpty(refreshedRow.audio_lang_verification).status, "") === "validating";
        if (cacheAdvanced) {
          processed += 1;
          persisted += 1;
          resolved += Math.max(0, beforeUnknown - afterUnknown);
        } else {
          deferred += 1;
        }
      }
    } catch (error) {
      if (providerTransportMayBeActive) releaseLeaseOnExit = false;
      if (mode === "probe") {
        // The gateway may have opened ffprobe before the HTTP client timed out
        // or disconnected. Conservatively count the provider attempt unless a
        // typed pre-spawn local rejection already returned normally.
        await recordFootprintHit();
        const timedOut = error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        await recordEpisodeProbeOutcome(db, {
          userId,
          sourceId,
          variantId,
          episodeId,
          success: false,
          status: probeResponseReceived ? 500 : (timedOut ? 504 : 502),
          code: probeResponseReceived
            ? "observation_write_failed"
            : (timedOut ? "gateway_timeout" : "gateway_unreachable"),
        });
        if (!probeResponseReceived) probeHealthBanish += 1;
      }
      failed += 1;
    } finally {
      if (releaseLeaseOnExit) {
        await releaseProviderFileProbe(db, sourceIdentity.key, leaseOwner);
      }
    }
  }
  if (mode === "probe" && (probeHealthOk > 0 || probeHealthBanish > 0)) {
    try {
      await db.rpc("provider_probe_circuit_record_tick", {
        p_identity_key: sourceIdentity.key,
        p_ok_count: probeHealthOk,
        p_fail_count: probeHealthBanish,
      });
    } catch (_) { /* best-effort circuit bookkeeping */ }
  }
  return {
    mode,
    itemType: "episode",
    candidates: candidates.length,
    attempted,
    processed,
    persisted,
    resolved,
    deferred,
    failed,
    backpressured,
    skipped,
    openUntil: circuitOpenUntil,
    batchLimit: limit,
    ...(probeHealthOk || probeHealthBanish
      ? { probeHealth: { ok: probeHealthOk, banish: probeHealthBanish } }
      : {}),
    // A short last page is not drained when every remaining exact file failed
    // or was deferred. Keep the lane pending until retry state excludes those
    // rows and a later candidate query genuinely returns zero.
    hasMore: skipped === null && (
      candidates.length >= limit
      || (
        processed === 0
        && (attempted > 0 || deferred > 0 || failed > 0 || backpressured > 0)
      )
    ),
  };
}

async function runOneDimension(db: SupabaseClient, body: JsonRecord) {
  const userId = stringOr(body.userId, "");
  const sourceId = stringOr(body.sourceId, "");
  const repairCohort = body.repairCohort === true;
  if (!userId) throw new HttpError(400, "Missing userId");
  if (repairCohort && !sourceId) {
    throw new HttpError(400, "Audio repair cohort requires sourceId", {
      code: "AUDIO_REPAIR_SOURCE_REQUIRED",
    });
  }
  if (sourceId && !await sourceCatalogVisible(sourceId, userId, db)) {
    return {
      processed: 0,
      updated: 0,
      skipped: "source-catalog-not-visible",
      code: "SOURCE_CATALOG_NOT_VISIBLE",
      sourceId,
    };
  }
  if (stringOr(body.type, "") === "episode") {
    return await runEpisodeAudioBackfill(db, body);
  }
  const requestedType = stringOr(body.type, "movie");
  const itemType = requestedType === "series" || requestedType === "episode"
    ? requestedType
    : "movie";
  const limit = Math.max(
    1,
    Math.min(repairCohort ? 4 : 300, Number(body.limit) || (repairCohort ? 4 : 100)),
  );
  const concurrency = Math.max(1, Math.min(12, Number(body.concurrency) || 6));
  const afterId = stringOr(body.afterId, "");
  // Optional per-panel scope. A driving account can hold SEVERAL distinct provider hosts (e.g.
  // AÎRO's 5 panels). With sourceId set, every candidate query is scoped to that one source so
  // each host gets its own cron/connection slot and they enrich in PARALLEL — without raising any
  // single host's per-connection load (distinct hosts → no user_multi_ip). Empty = account-wide.
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
    const ts = await hydrateVisiblePlaybackTitles(db, userId, orderedIds);
    const vIds = (ts ?? []).map((t) => stringOrNull((t as JsonRecord).default_variant_id)).filter(Boolean) as string[];
    const vById = new Map<string, JsonRecord>();
    if (vIds.length) {
      const { data: vs } = await db.from("cloud_catalog_visible_title_variants").select("id, source_id, external_id, item_type").in("id", vIds);
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
    const dt = await hydrateVisiblePlaybackTitles(db, userId, diagIds);
    const dvIds = (dt ?? []).map((t) => t.default_variant_id).filter(Boolean) as string[];
    const dvById = new Map<string, JsonRecord>();
    if (dvIds.length) {
      const { data: dvs } = await db.from("cloud_catalog_visible_title_variants").select("id, source_id, external_id, item_type").in("id", dvIds);
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
    const trow = (await hydrateVisiblePlaybackTitles(db, userId, [titleId]))[0] ?? null;
    const variantId = stringOr((trow as JsonRecord | null)?.default_variant_id, "");
    if (!variantId) throw new HttpError(404, "title or variant not found");
    const { data: variant } = await db.from("cloud_catalog_visible_title_variants")
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
          const { data: vs } = await db.from("cloud_catalog_visible_title_variants").select("id, source_id, external_id, item_type").in("id", svIds);
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
            if (await providerAccountBusyForCrawler(db, ak)) continue;
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
              db, runtimeConfig, userId, sourceId: vSourceId, targetUrl, audioTracks: tracks,
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
      const { data: vs } = await db.from("cloud_catalog_visible_title_variants").select("id, source_id, external_id, item_type").in("id", wvIds);
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
    const markWhisperAttempted = async (
      titleId: string,
      variantId: string,
      variantSourceId = "",
    ) => {
      if (fileWhisperScope) {
        if (!variantId || !variantSourceId) return;
        await patchActiveCatalogTitleVariants(db, {
          userId,
          sourceId: variantSourceId,
          id: variantId,
          patch: { audio_whisper_attempted_at: new Date().toISOString() },
        });
        return;
      }
      await db.from("cloud_titles")
        .update({ whisper_attempted_at: new Date().toISOString() })
        .eq("id", titleId).eq("user_id", userId)
        .then(() => {}, () => {});
    };
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
          await markWhisperAttempted(titleId, variantId, variantSourceId);
          return;
        }
        const targetUrl = vit === "series"
          ? await resolveSeriesEpisodeUrl(variantSourceId, externalId, userId, db).catch(() => null)
          : ((await resolvePlaybackTarget(variantSourceId, vit, externalId, userId, db).catch(() => null))?.targetUrl ?? null);
        if (!targetUrl) return;
        if (body.ignoreLiveSession !== true) {
          const accountKey = providerAccountKeyFromUrl(targetUrl);
          if (await providerAccountBusyForCrawler(db, accountKey)) return;
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
        const candidateLeaseOwner = newProviderProbeLeaseOwner(
          whisperLeaseOwner,
          variantId || titleId,
        );
        if (!await claimProviderFileProbe(db, identityKey, candidateLeaseOwner, 600)) return;
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
            db, runtimeConfig, userId, sourceId: variantSourceId, targetUrl, userAgent: null,
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
          await releaseProviderFileProbe(db, identityKey, candidateLeaseOwner);
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
  // not mark the panel exhausted. The read is fail-closed: an unavailable breaker cannot authorize
  // a provider connection whose ban/cooldown state is unknown.
  let probeIdentityKey = "";
  if (sourceId && mode === "probe") {
    try {
      probeIdentityKey = (await resolveSourceIdentity(sourceId, userId, db)).key || "";
      if (probeIdentityKey) {
        const cb = await readProviderProbeCircuitStateStrict(db, probeIdentityKey);
        if (cb.open) {
          return { mode, updated: 0, processed: 0, skipped: "circuit_open", identityKey: probeIdentityKey, openUntil: cb.openUntil };
        }
      }
    } catch (_) {
      return {
        mode,
        updated: 0,
        processed: 0,
        skipped: "provider-guard-unavailable",
        identityKey: probeIdentityKey || null,
        hasMore: true,
      };
    }
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
  if (repairCohort && !exactFileScope) {
    throw new HttpError(400, "Audio repair cohort requires exact movie probe scope", {
      code: "AUDIO_REPAIR_SCOPE_REQUIRED",
    });
  }
  // Per-panel scope (sourceId) → audio_backfill_candidates RPC: the SAME filter (audio unresolved
  // + 30d probe-retry window, OR never subtitle-probed) but scoped to one source, variant-driven so
  // work is bounded by that source. Account-wide (no sourceId) keeps the original PostgREST path.
  const titlesResult = exactFileScope
    ? repairCohort
      ? await db.rpc("catalog_file_audio_repair_candidates", {
        p_user: userId,
        p_source: sourceId,
        p_limit: limit,
      })
      : await db.rpc("file_audio_backfill_candidates", {
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
          .from("cloud_catalog_visible_titles")
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
  let titles = titlesResult.data as {
    id: string;
    default_variant_id: string | null;
    provider_tmdb_id: string | null;
    repair_lease_token?: string | null;
  }[] | null;
  const error = titlesResult.error;
  if (error) throwDb(error, "Unable to list titles for backfill");
  if (!exactFileScope && !sourceId && titles?.length) {
    titles = await hydrateVisiblePlaybackTitles(
      db,
      userId,
      titles.map((title) => title.id),
      true,
    ) as {
      id: string;
      default_variant_id: string | null;
      provider_tmdb_id: string | null;
      repair_lease_token?: string | null;
    }[];
  }
  if (!titles || !titles.length) {
    return {
      mode, scope: exactFileScope ? "file" : "title",
      processed: 0, updated: 0, lastId: afterId, hasMore: false,
    };
  }

  // The exact-file candidate RPC intentionally returns a narrow shape. Load the
  // release-language hints in one tenant-scoped query so MULTI and genuinely
  // untagged files can use the robust gateway ffprobe as their first (and only)
  // provider probe instead of first failing the bounded relay parser.
  const versionLanguagesByTitleId = new Map<string, string[]>();
  try {
    const { data: languageRows } = await db
      .from("cloud_catalog_visible_titles")
      .select("id,version_languages")
      .eq("user_id", userId)
      .in("id", titles.map((title) => title.id));
    for (const row of languageRows ?? []) {
      versionLanguagesByTitleId.set(
        String(row.id),
        (Array.isArray(row.version_languages) ? row.version_languages : [])
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean),
      );
    }
  } catch (_) { /* missing hints fall back to robust unknown-file routing */ }

  const variantIds = titles.map((t) => t.default_variant_id).filter(Boolean) as string[];
  const variantById = new Map<string, JsonRecord>();
  if (variantIds.length) {
    const { data: variants } = await db
      .from("cloud_catalog_visible_title_variants")
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
    persistenceFailed: 0, providerBusy: 0, proxyAuthFailed: 0,
    circuitUnavailable: 0,
  };
  // Circuit-breaker tallies for this tick: cbOk = provider served us at least once; cbBanish =
  // auth/rate/5xx rejections. Recorded once at the end of the tick (see below).
  let cbOk = 0;
  let cbBanish = 0;
  const probeHealthByIdentity = new Map<string, { ok: number; banish: number }>();
  const providerProbeTickGuard = createProviderProbeTickGuard();
  const providerIdentitySerialQueue = createProviderIdentitySerialQueue();
  let sample: JsonRecord | null = null;
  const lastId = String(titles[titles.length - 1].id);

  // The repair RPC leases a bounded page before the tick-level provider guards run. Release
  // every still-unstarted token before an outer early-return so a viewer, footprint cap, or
  // provider guard does not strand the page for the ten-minute lease timeout. Tokens whose
  // provider attempt already started (or whose row completed) are intentionally ignored by the
  // SQL CAS, preserving the attempt budget and history.
  const deferClaimedRepairCandidates = async (reason: string) => {
    if (!repairCohort) return;
    const results = await Promise.allSettled(titles.map(async (title) => {
      const repairLeaseToken = stringOr(title.repair_lease_token, "");
      const variant = title.default_variant_id
        ? variantById.get(String(title.default_variant_id))
        : null;
      const candidateSourceId = stringOr(variant?.source_id, "");
      const candidateVariantId = stringOr(variant?.id, "");
      if (!repairLeaseToken || !candidateSourceId || !candidateVariantId) return;
      const { error: deferError } = await db.rpc(
        "norva_defer_catalog_file_audio_repair_candidate",
        {
          p_user: userId,
          p_source: candidateSourceId,
          p_variant: candidateVariantId,
          p_lease_token: repairLeaseToken,
          p_reason: reason,
          p_retry_seconds: 30,
        },
      );
      if (deferError) throw deferError;
    }));
    diag.persistenceFailed += results.filter((result) => result.status === "rejected").length;
  };

  // Anti-ban: for a low_footprint provider identity, probes go through the gateway's residential
  // IP and are capped per hour. Resolved once per tick (per-panel crons set sourceId). Over budget
  // → skip the tick entirely so the crawl stays under the provider's abuse threshold.
  const footprint = (sourceId && mode === "probe" && runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken)
    ? await getFootprint(db, sourceId, userId)
    : null;
  if (footprint && !footprint.allowed) {
    await deferClaimedRepairCandidates("footprint-budget");
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
  // 10/36, movie-type, DB-only resolution) fall through to the per-title gate below. Fail-closed.
  if (sourceId && body.ignoreLiveSession !== true) {
    try {
      const sc = await loadSourceConfig(sourceId, userId, db);
      const host = sc?.serverUrl ? new URL(normalizeBaseUrl(String(sc.serverUrl))).host : "";
      const key = host && sc?.username ? host + "/" + String(sc.username) : "";
      if (await providerAccountBusyForCrawler(db, key)) {
        await deferClaimedRepairCandidates("account-busy");
        return { mode, processed: 0, updated: 0, skipped: "account-busy", sourceId, lastId: afterId, hasMore: true };
      }
    } catch (_) {
      await deferClaimedRepairCandidates("provider-guard-unavailable");
      return { mode, processed: 0, updated: 0, skipped: "provider-guard-unavailable", sourceId, lastId: afterId, hasMore: true };
    }
  }

  // Account busy-lock READER (2026-07-10 458 incident): before ANY provider hit (relay header
  // probe, gateway residential probe, or vod-info panel call — all are the user_multi_ip signal
  // when a human is watching the same account), consult provider_account_activity. Keyed per
  // TITLE's target URL so account-wide ticks (no sourceId — e.g. cron 36) are covered per panel,
  // not per user. Cached in-tick for 20s per key: fresh enough to catch a viewer who starts
  // mid-tick, cheap enough to add ~1 read per 20s per account. Fail-closed: an RPC error or
  // unresolved account key defers new I/O. Skipped titles are NOT stamped → retried next tick.
  const accountBusyCache = new Map<string, { busy: boolean; at: number }>();
  // 10s: short enough that a probe stops STARTING within ~10s of a viewer's first touch (keeps
  // the worst-case slot-contention window under the web VOD retry budget), cheap enough to add
  // at most ~1 indexed RPC read per account per 10s of a tick.
  const ACCOUNT_BUSY_CACHE_MS = 10_000;
  const accountBusyCached = async (accountKey: string): Promise<boolean> => {
    if (!accountKey) return true;
    const now = Date.now();
    const hit = accountBusyCache.get(accountKey);
    if (hit && (now - hit.at) < ACCOUNT_BUSY_CACHE_MS) return hit.busy;
    const busy = await providerAccountBusyForCrawler(db, accountKey);
    accountBusyCache.set(accountKey, { busy, at: now });
    return busy;
  };

  const recordTerminalProbeFailure = async (
    providerAccountKey: string,
    candidateIdentityKey: string,
    targetUrl: string,
    status: number,
    payload: JsonRecord,
  ): Promise<"provider_busy" | "proxy_auth_failed" | null> => {
    const terminalCode = providerProbeTerminalCode({
      status,
      code: sanitizedProviderErrorCode(
        payload.code ?? payload.errorCode ?? payload.error_code,
      ) ?? undefined,
    });
    if (!terminalCode) return null;
    providerProbeTickGuard.stop(providerAccountKey, terminalCode);
    if (terminalCode === "proxy_auth_failed") {
      diag.proxyAuthFailed++;
      return terminalCode;
    }

    if (terminalCode === "provider_busy") {
      diag.providerBusy++;
      // This is trusted Gateway/Relay evidence, not a client report: open the
      // server-owned playback circuit immediately and stop this account's tick.
      const providerAccountHash = await providerAccountHashFromUrl(targetUrl);
      await openProviderPlaybackCircuit(providerAccountHash, db, true);
    }
    return terminalCode;
  };

  const processOne = async (title: JsonRecord) => {
    const repairLeaseToken = repairCohort
      ? stringOr(title.repair_lease_token, "")
      : "";
    let repairAttemptStarted = false;
    let repairCandidateReleased = false;
    let repairDeferReason = "provider-preflight-not-started";

    const startRepairAttempt = async (
      sourceId: string,
      variantId: string,
    ): Promise<boolean> => {
      if (!repairCohort) return true;
      if (repairAttemptStarted) return true;
      if (!repairLeaseToken || !sourceId || !variantId) {
        repairDeferReason = "repair-lease-coordinates-missing";
        diag.persistenceFailed++;
        return false;
      }
      try {
        const { data, error: startError } = await db.rpc(
          "norva_start_catalog_file_audio_repair_attempt",
          {
            p_user: userId,
            p_source: sourceId,
            p_variant: variantId,
            p_lease_token: repairLeaseToken,
          },
        );
        if (startError || data !== true) {
          repairDeferReason = startError
            ? "repair-attempt-start-error"
            : "repair-attempt-start-refused";
          diag.persistenceFailed++;
          return false;
        }
        // From this exact point onward the attempt budget represents a real
        // provider transport, even if fetch itself fails before a response.
        repairAttemptStarted = true;
        return true;
      } catch (_) {
        repairDeferReason = "repair-attempt-start-exception";
        diag.persistenceFailed++;
        return false;
      }
    };

    const cancelPreSpawnRepairAttempt = async (
      sourceId: string,
      variantId: string,
      reason: string,
    ): Promise<boolean> => {
      if (!repairCohort) return true;
      if (!repairAttemptStarted || !repairLeaseToken || !sourceId || !variantId) return false;
      try {
        const { data, error: cancelError } = await db.rpc(
          "norva_cancel_catalog_file_audio_repair_pre_spawn_attempt",
          {
            p_user: userId,
            p_source: sourceId,
            p_variant: variantId,
            p_lease_token: repairLeaseToken,
            p_reason: reason,
            p_retry_seconds: 30,
          },
        );
        if (cancelError || data !== true) {
          diag.persistenceFailed++;
          return false;
        }
        repairAttemptStarted = false;
        repairCandidateReleased = true;
        repairDeferReason = reason;
        return true;
      } catch (_) {
        diag.persistenceFailed++;
        return false;
      }
    };

    const deferUnstartedRepairCandidate = async () => {
      if (!repairCohort || repairAttemptStarted || repairCandidateReleased || !repairLeaseToken) return;
      const variant = title.default_variant_id
        ? variantById.get(String(title.default_variant_id))
        : null;
      const candidateSourceId = stringOr(variant?.source_id, "");
      const candidateVariantId = stringOr(variant?.id, "");
      if (!candidateSourceId || !candidateVariantId) return;
      try {
        const { error: deferError } = await db.rpc(
          "norva_defer_catalog_file_audio_repair_candidate",
          {
            p_user: userId,
            p_source: candidateSourceId,
            p_variant: candidateVariantId,
            p_lease_token: repairLeaseToken,
            p_reason: repairDeferReason,
            p_retry_seconds: 30,
          },
        );
        if (deferError) diag.persistenceFailed++;
      } catch (_) {
        // Expiry recovery distinguishes unstarted leases and returns them to
        // pending without consuming attempt_count, so this remains fail-safe.
        diag.persistenceFailed++;
      }
    };

    // Mark a title as audio-probed only after at least one real audio stream was
    // observed. Parser misses and transport failures stay retryable. Best-effort.
    const markProbed = async (extra: JsonRecord = {}) => {
      try {
        await db.from("cloud_titles").update({ audio_probed_at: new Date().toISOString(), ...extra })
          .eq("user_id", userId).eq("id", String(title.id));
      } catch (_) { /* best-effort progression marker */ }
    };
    try {
      const variant = title.default_variant_id ? variantById.get(String(title.default_variant_id)) : null;
      if (!variant) {
        repairDeferReason = "variant-not-visible";
        diag.noVariant++;
        return;
      }
      const sourceId = stringOr(variant.source_id, "");
      const externalId = stringOr(variant.external_id, "");
      const variantItemType = stringOr(variant.item_type, itemType);
      if (!sourceId || !externalId) {
        repairDeferReason = "provider-target-coordinates-missing";
        diag.noTarget++;
        return;
      }

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
            const cachedAudioTracks = Array.isArray(fileRow?.audio_tracks)
              ? fileRow.audio_tracks
              : [];
            const hasFreshAudio = Number.isFinite(audioAt) &&
              audioAt >= Date.now() - 180 * 24 * 3600 * 1000 &&
              cachedAudioTracks.length > 0;
            const hasSubtitles = Boolean(fileRow?.subtitle_probed_at);
            const satisfiesTarget = subtitleTarget ? hasSubtitles : hasFreshAudio;
            if (fileRow && satisfiesTarget) {
              const { error: hydrateError } = await db.rpc("merge_cloud_title_file_languages", {
                p_user_id: userId,
                p_title_id: String(title.id),
                p_variant_id: String(variant.id),
                p_file_external_id: externalId,
                p_audio_tracks: hasFreshAudio
                  ? cachedAudioTracks
                  : [],
                p_subtitle_tracks: hasSubtitles && Array.isArray(fileRow.subtitle_tracks)
                  ? fileRow.subtitle_tracks
                  : [],
                p_has_audio: hasFreshAudio,
                p_has_subtitle: hasSubtitles,
              });
              if (!hydrateError) {
                repairDeferReason = "completed-from-exact-cache";
                diag.cacheHydrated++;
                updated++;
                return;
              }
            }
          }
        } catch (_) { /* cache miss/unavailable => probe normally */ }
      }

      const candidateIdentityKey = await resolveCandidateProviderIdentityKey(
        db,
        sourceId,
        userId,
        probeIdentityKey,
      );
      if (!candidateIdentityKey) {
        repairDeferReason = "provider-identity-unavailable";
        diag.identityBusy++;
        return;
      }
      const itemProbeLeaseOwner = newProviderProbeLeaseOwner(
        probeLeaseOwner,
        stringOr(variant.id, "candidate"),
      );
      const guardedOutcome = await providerIdentitySerialQueue(
        candidateIdentityKey,
        () => runProviderProbeWithLease(
          db,
          candidateIdentityKey,
          itemProbeLeaseOwner,
          150,
          async (leaseControl) => {

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
          repairDeferReason = "provider-target-unresolved";
          diag.noTarget++;
        }
        return;
      }

      const providerAccountKey = providerAccountKeyFromUrl(targetUrl);
      const priorTerminalProbe = providerAccountKey
        ? providerProbeTickGuard.terminalCode(providerAccountKey)
        : null;
      if (priorTerminalProbe) {
        repairDeferReason = `provider-terminal-${priorTerminalProbe}`;
        if (priorTerminalProbe === "provider_busy") diag.providerBusy++;
        else diag.proxyAuthFailed++;
        return;
      }

      // Account busy-lock: someone (any user, any device, the gateway, a viewer mid-film whose
      // per-user signals went dark) currently holds this provider ACCOUNT — skip WITHOUT
      // stamping so the title retries next tick. Honors the manual-backfill bypass
      // (ignoreLiveSession), which crons never send.
      if (body.ignoreLiveSession !== true) {
        const accountKey = providerAccountKeyFromUrl(targetUrl);
        if (await accountBusyCached(accountKey)) {
          repairDeferReason = "provider-account-busy";
          diag.accountBusy++;
          return;
        }
      }

      let candidateFootprint = footprint;
      if (!candidateFootprint && mode === "probe") {
        candidateFootprint = footprintByCandidateSource.get(sourceId) ?? null;
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
          repairDeferReason = "provider-footprint-capped";
          diag.footprintCapped++;
          return;
        }
      }
      // Keep one provider connection per account even when this tick has
      // concurrency > 1. A unique distributed owner also prevents a second
      // replica from treating the tick-wide owner as re-entrant.
      if (!providerProbeTickGuard.tryEnter(providerAccountKey)) {
        repairDeferReason = "provider-tick-guard-busy";
        const blockedCode = providerProbeTickGuard.terminalCode(providerAccountKey);
        if (blockedCode === "provider_busy") diag.providerBusy++;
        else if (blockedCode === "proxy_auth_failed") diag.proxyAuthFailed++;
        else diag.identityBusy++;
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
        let usedGatewayProbe = false;
        const gatewayConfigured = Boolean(
          runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken,
        );
        if (repairCohort && !gatewayConfigured) {
          repairDeferReason = "repair-gateway-unavailable";
          return;
        }
        const versionTags = versionLanguagesByTitleId.get(String(title.id)) ?? [];
        const preferGatewayProbe = repairCohort || (
          mode === "probe" && gatewayConfigured && (
            candidateFootprint?.lowFootprint === true ||
            versionTags.length === 0 ||
            versionTags.includes("multi")
          )
        );
        const fetchGatewayProbe = async (stage: string): Promise<JsonRecord | null> => {
          let providerTransportMayBeActive = false;
          try {
            if (!await startRepairAttempt(sourceId, stringOr(variant.id, ""))) {
              return null;
            }
            providerTransportMayBeActive = true;
            const gw = await fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
              body: JSON.stringify({ url: targetUrl, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
            });
            const gatewayInfo = recordOrEmpty(await gw.json().catch(() => ({})));
            const gatewayProviderCode = sanitizedProviderErrorCode(
              gatewayInfo.code ?? gatewayInfo.errorCode ?? gatewayInfo.error_code,
            );
            const leaseReleaseSafe = providerProbeResponseAllowsLeaseRelease(
              gw.status,
              gatewayProviderCode,
              gatewayInfo,
              leaseControl.retainUntilExpiry,
            );
            providerTransportMayBeActive = !leaseReleaseSafe;
            if (providerProbeRejectedBeforeSpawn(gw.status, gatewayProviderCode)) {
              await cancelPreSpawnRepairAttempt(
                sourceId,
                stringOr(variant.id, ""),
                `gateway-${gatewayProviderCode}`,
              );
            }
            const terminalCode = await recordTerminalProbeFailure(
              providerAccountKey,
              candidateIdentityKey,
              targetUrl,
              gw.status,
              gatewayInfo,
            );
            if (terminalCode) {
              diag.relayNotOk++;
              if (debug && !sample) {
                sample = { stage: `${stage}Terminal`, status: gw.status, code: terminalCode };
              }
              return null;
            }
            if (!gw.ok) {
              diag.relayNotOk++;
              if (isBanishStatus(gw.status)) noteProbeHealth(false);
              if (debug && !sample) sample = { stage: `${stage}NotOk`, status: gw.status, host: new URL(targetUrl).host };
              return null;
            }
            if (!leaseReleaseSafe) {
              diag.relayNotOk++;
              noteProbeHealth(false);
              if (debug && !sample) {
                sample = { stage: `${stage}DrainUnattested`, status: gw.status };
              }
              return null;
            }
            const observedProfile = recordOrEmpty(gatewayInfo.codecProfile ?? gatewayInfo.codec_profile);
            if (variantItemType === "movie" && hasReliableVodCodecProfile(observedProfile)) {
              try {
                await persistObservedCodecProfile(db, {
                  userId,
                  sourceId,
                  itemType: "movie",
                  itemId: externalId,
                  codecProfile: observedProfile,
                  startupMs: null,
                  audioMode: null,
                  variantId: stringOr(variant.id, ""),
                  strict: true,
                });
              } catch (_) {
                // The audio/subtitle map below remains independently useful. Keep
                // the profile write observable and let the next probe repair it.
                diag.persistenceFailed++;
              }
            }
            noteProbeHealth(true);
            usedGatewayProbe = true;
            return gatewayInfo;
          } catch (_) {
            if (providerTransportMayBeActive) leaseControl.retainUntilExpiry();
            diag.relayNotOk++;
            noteProbeHealth(false);
            return null;
          }
        };

        if (preferGatewayProbe) {
          // MULTI/unknown files and low-footprint accounts go straight to one
          // authoritative ffprobe. The low-footprint lane keeps its human-like
          // pacing and residential egress.
          if (candidateFootprint?.lowFootprint) {
            await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 1000)));
          }
          info = await fetchGatewayProbe("gatewayProbe");
          if (!info) return;
          if (candidateFootprint?.lowFootprint) {
            try {
              await db.rpc("provider_footprint_record_hit", {
                p_identity_key: candidateFootprint.identityKey,
              });
            } catch (_) { /* best-effort */ }
          }
        } else {
          const payload = JSON.stringify({ v: 1, sid: "audio-backfill", uid: userId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 120 });
          const signature = await hmacBase64Url(runtimeConfig.relayTokenSecret, payload);
          token = `${base64Url(encoder.encode(payload))}.${signature}`;

          const endpoint = mode === "probe" ? "probe-audio" : "vod-info";
          if (!await startRepairAttempt(sourceId, stringOr(variant.id, ""))) {
            return;
          }
          let res: Response;
          let relayInfo: JsonRecord;
          try {
            res = await fetch(`${runtimeConfig.relayBaseUrl}/${endpoint}/${token}`, { headers: { accept: "application/json" } });
            relayInfo = recordOrEmpty(await res.json().catch(() => ({})));
            // Relay responses do not currently attest upstream socket drainage.
            // Keep the distributed lease to TTL unless protocol-v1 proof is
            // explicitly present, including for terminal/non-2xx responses.
            acceptGatewayProviderDrain(relayInfo, leaseControl.retainUntilExpiry);
          } catch (error) {
            leaseControl.retainUntilExpiry();
            throw error;
          }
          const terminalCode = await recordTerminalProbeFailure(
            providerAccountKey,
            candidateIdentityKey,
            targetUrl,
            res.status,
            relayInfo,
          );
          if (terminalCode) {
            diag.relayNotOk++;
            if (debug && !sample) {
              sample = { stage: "relayProbeTerminal", status: res.status, code: terminalCode };
            }
            return;
          }
          if (!res.ok) {
            diag.relayNotOk++;
            if (isBanishStatus(res.status)) noteProbeHealth(false);
            if (debug && !sample) sample = { stage: "relayNotOk", status: res.status, host: new URL(targetUrl).host };
            return;
          }
          info = relayInfo;
          noteProbeHealth(true);

          const relayAudioTracks = Array.isArray(relayInfo.audioTracks)
            ? relayInfo.audioTracks
            : [];
          const relayAudioComplete = authoritativeProbeFacetComplete(
            relayInfo.audioProbeComplete,
            relayAudioTracks.length > 0,
          );
          const relaySubtitleTracks = Array.isArray(relayInfo.subtitles)
            ? relayInfo.subtitles
            : [];
          const relaySubtitleComplete = authoritativeProbeFacetComplete(
            relayInfo.subtitleProbeComplete,
            relayAudioComplete || relaySubtitleTracks.length > 0,
          );
          if (mode === "probe" && gatewayConfigured && !relayAudioComplete) {
            // The relay request is fully consumed before this fallback begins.
            // Give provider-side connection accounting its normal release grace,
            // then open exactly one ffprobe connection; the distributed file
            // lease remains held throughout, so replicas cannot overlap it.
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            const gatewayFallback = await fetchGatewayProbe("gatewayFallback");
            if (!gatewayFallback) {
              // Subtitle evidence is independent of audio. A failed ffprobe must
              // leave audio due, but it must not discard an authoritative relay
              // subtitle map that was already obtained without another provider
              // connection.
              if (!relaySubtitleComplete) return;
              info = relayInfo;
            } else {
              const gatewayAudioTracks = Array.isArray(gatewayFallback.audioTracks)
                ? gatewayFallback.audioTracks
                : [];
              const gatewaySubtitleTracks = Array.isArray(gatewayFallback.subtitles)
                ? gatewayFallback.subtitles
                : [];
              const gatewayAudioComplete = authoritativeProbeFacetComplete(
                gatewayFallback.audioProbeComplete,
                gatewayAudioTracks.length > 0,
              );
              const gatewaySubtitleComplete = authoritativeProbeFacetComplete(
                gatewayFallback.subtitleProbeComplete,
                gatewayAudioComplete || gatewaySubtitleTracks.length > 0,
              );
              // Prefer the full ffprobe facet whenever it is authoritative. A
              // partial 200 response may still carry useful audio metadata; in
              // that case retain the already-complete relay subtitle facet.
              info = relaySubtitleComplete && !gatewaySubtitleComplete
                ? {
                  ...gatewayFallback,
                  subtitles: relaySubtitleTracks,
                  subtitleProbeComplete: true,
                }
                : gatewayFallback;
            }
          }
        }
        if (debug && !sample && token && !usedGatewayProbe) {
          let relayHead: JsonRecord = {};
          try {
            // This diagnostic range request can also open an upstream socket and
            // has no drainage protocol in its response shape.
            leaseControl.retainUntilExpiry();
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
              default: s?.default === true,
            }))
            .filter((s) => Number.isInteger(s.index))
        : [];
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

      const enqueueExactMovieUnknowns = async (persisted: boolean) => {
        if (
          !persisted || !exactFileScope || variantItemType !== "movie" || !usedGatewayProbe ||
          !orderedTracks.some((track) => !normalizeIsoLang(track.lang))
        ) return;
        const observedProfile = recordOrEmpty(info?.codecProfile ?? info?.codec_profile);
        try {
          await enqueueAutomaticStrictLanguageValidation({
            db,
            userId,
            sourceId,
            identityKey: candidateIdentityKey,
            itemType: "movie",
            itemId: externalId,
            variantId: stringOr(variant.id, ""),
            profile: observedProfile,
          });
        } catch (_) {
          // The exact inventory remains useful and the dedicated untagged lane
          // retries certification. Never downgrade to a provisional language.
        }
      };

      const vodTracks = mode !== "probe" && info && Array.isArray(info.audioTracks)
        ? info.audioTracks as JsonRecord[]
        : [];
      const audioProbeComplete = mode === "probe"
        ? authoritativeProbeFacetComplete(info?.audioProbeComplete, orderedTracks.length > 0)
        : vodTracks.length > 0;
      // Backward compatibility: pre-marker relay/gateway responses with an
      // audio map necessarily parsed the whole stream table. A subtitle-only
      // map is retained independently but can never validate audio.
      const subtitleObservation = mode === "probe"
        ? subtitleProbeObservation(
          info?.subtitleProbeComplete,
          audioProbeComplete || orderedSubtitles.length > 0,
          orderedSubtitles,
          new Date().toISOString(),
        )
        : { complete: false, fields: {} as JsonRecord };
      const subtitleProbeComplete = subtitleObservation.complete;
      const subtitleFields: JsonRecord = subtitleObservation.fields;

      const codes = new Set<string>();
      if (mode === "probe") {
        const incoming = info && Array.isArray(info.audioLanguages) ? info.audioLanguages : [];
        // No authoritative facet means parser/transport failure. Leave both
        // cursors retryable; never turn it into a 180-day negative.
        if (!audioProbeComplete && !subtitleProbeComplete) {
          diag.relayEmpty++;
          return;
        }
        if (!audioProbeComplete) {
          // A successfully parsed subtitle map remains valuable, but audio is
          // still unknown and must stay eligible for the next probe.
          if (exactFileScope) {
            const persisted = await shareFileTracks(
              db,
              fileServerKey || await resolveFileTracksKey(sourceId, userId, db, targetUrl),
              variantItemType,
              externalId,
              [],
              orderedSubtitles,
              false,
              true,
            );
            if (persisted) updated++;
            else diag.persistenceFailed++;
          } else if (Object.keys(subtitleFields).length) {
            try {
              await db.from("cloud_titles").update(subtitleFields)
                .eq("user_id", userId).eq("id", String(title.id));
            } catch (_) { /* best-effort subtitle-only observation */ }
          }
          return;
        }
        for (const code of incoming) {
          const normalized = normalizeIsoLang(stringOrNull(code));
          if (normalized) codes.add(normalized);
        }
      } else {
        if (!vodTracks.length) { diag.relayEmpty++; return; }
        for (const track of vodTracks) {
          const normalized = normalizeIsoLang(stringOrNull(track?.language));
          if (normalized) codes.add(normalized);
        }
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
            subtitleProbeComplete,
          );
          if (persisted) updated++;
          else diag.persistenceFailed++;
          await enqueueExactMovieUnknowns(persisted);
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
          subtitleProbeComplete,
        );
        if (persisted) updated++;
        else diag.persistenceFailed++;
        await enqueueExactMovieUnknowns(persisted);
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
        await shareFileTracks(
          db,
          await resolveFileTracksKey(sourceId, userId, db, targetUrl),
          variantItemType,
          externalId,
          orderedTracks,
          orderedSubtitles,
          audioProbeComplete,
          subtitleProbeComplete,
        );
      }
      } finally {
        providerProbeTickGuard.leave(providerAccountKey);
      }
          },
        ),
      );
      if (guardedOutcome.status === "lease-busy") diag.identityBusy++;
      else if (guardedOutcome.status === "guard-unavailable") diag.circuitUnavailable++;
      else if (guardedOutcome.status === "circuit-open") diag.circuitOpen++;
    } catch (e) {
      diag.exception++;
      if (debug && !sample) sample = { stage: "exception", error: String(e).slice(0, 200) };
    } finally {
      await deferUnstartedRepairCandidate();
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
      await deferClaimedRepairCandidates("viewer-midtick");
      return { mode, processed: i, updated, diag, skipped: "viewer-midtick", lastId: String(titles[i - 1].id), hasMore: true, ...(debug ? { sample } : {}) };
    }
    await Promise.all(titles.slice(i, i + effConcurrency).map((t) => processOne(t as JsonRecord)));
    const terminalCodes = providerProbeTickGuard.terminalCodes();
    if (terminalCodes.length > 0) {
      await deferClaimedRepairCandidates(
        terminalCodes.includes("provider_busy") ? "provider-busy" : "proxy-auth-failed",
      );
      return {
        mode,
        processed: i,
        updated,
        diag,
        skipped: terminalCodes.includes("provider_busy") ? "provider-busy" : "proxy-auth-failed",
        lastId: i > 0 ? String(titles[i - 1].id) : afterId,
        hasMore: true,
        ...(debug ? { sample } : {}),
      };
    }
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
  if (diag.circuitUnavailable > 0 && updated === 0 && cbOk === 0 && cbBanish === 0) {
    return { mode, processed: 0, updated: 0, diag, skipped: "provider-guard-unavailable", lastId: afterId, hasMore: true };
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

  const { data: sources } = await db.from("cloud_catalog_visible_sources").select("id, config_hint").eq("user_id", userId);
  const results: JsonRecord[] = [];
  for (const src of sources ?? []) {
    const sourceId = String((src as JsonRecord).id);
    const serverHost = stringOrNull((recordOrEmpty((src as JsonRecord).config_hint) as JsonRecord).serverHost) ?? "?";
    const { data: variants } = await db.from("cloud_catalog_visible_title_variants")
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
    "Access-Control-Expose-Headers": "x-norva-visibility-epoch, x-norva-user-visibility-epoch, x-norva-global-visibility-epoch, x-norva-catalog-cache-contract, retry-after",
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
      ...catalogVisibilityEpochHeaders(req),
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

function exactPositiveSafeInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
  const gatewayCode = isRecord(details)
    ? stringOr(details.code ?? details.errorCode ?? details.error_code, "")
    : "";
  const providerBusy = isProviderBusyFailure({ code: gatewayCode, upstreamStatus: providerStatus });
  const providerConcurrencySignal = Boolean(
    providerBusy ||
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
    gatewayCode,
    providerStatus,
    providerConcurrencySignal,
    failureCategory,
    errorCode: providerBusy
      ? "provider_busy"
      : providerConcurrencySignal
        ? "provider_concurrency_or_auth"
        : `gateway_${gatewayStatus || "error"}`,
    errorMessage: truncateText(sanitizeTelemetryText(message), 240),
    gatewayDetails: truncateText(detailText, 500),
  };
}

function extractProviderStatus(details: unknown, text: string) {
  const fromRecord = firstNumericField(details, ["providerStatus", "provider_status", "upstreamStatus", "upstream_status", "statusCode", "status_code"]);
  if (fromRecord) return fromRecord;
  const match = text.match(/\b(401|403|408|429|458|500|502|503|504)\b/);
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
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
