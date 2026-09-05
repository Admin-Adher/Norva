import { fetchDiscoverySelection, discoveryCatalogFields } from "../_shared/discovery-sources.mjs";
import { createClient } from "npm:@supabase/supabase-js@2";
import { DISCOVERY_PLAYLIST_URL, DISCOVERY_SELECTION_ENABLED, discoverySourceId, retiredDiscoverySourceId } from "../_shared/discovery-catalog.mjs";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { playbackTransportExpiresAt } from "../_shared/playback-expiry.mjs";
import { formatSourceSyncError } from "../_shared/source-sync-error.mjs";
import {
  classifySourceAttemptFailure,
  normalizedSourceAttemptDomain,
  normalizeSourceAttemptPathShape,
  normalizeSourceAttemptType,
  sourceAttemptClientContext,
  summarizeSourceConnectionAttempt,
} from "../_shared/source-connection-attempt.mjs";
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
  fetchBoundedProviderText,
  fetchBoundedProviderTextPrefix,
} from "../_shared/bounded-provider-response.mjs";
import {
  countExtendedM3uEntries,
  fetchM3uPlaylistStream,
  hasExtendedM3uHeader,
} from "../_shared/m3u-playlist-stream.mjs";
import {
  publicSourceSyncError,
  sanitizeCatalogSource,
  sanitizeSource,
  sanitizeSourceConnectionResult,
  sanitizeSourceValidation,
  SOURCE_CATALOG_PUBLIC_SELECT,
  SOURCE_MANAGEMENT_PUBLIC_SELECT,
} from "../_shared/source-public-view.mjs";
import {
  CAST_COMMAND_PUBLIC_SELECT,
  CONTENT_EVENT_PUBLIC_SELECT,
  DEVICE_PUBLIC_SELECT,
  FAVORITE_PUBLIC_SELECT,
  MEDIA_ITEM_PUBLIC_SELECT,
  PAIRING_PUBLIC_SELECT,
  PLAYBACK_EVENT_PUBLIC_SELECT,
  PLAYBACK_SESSION_PUBLIC_SELECT,
  PROFILE_PUBLIC_SELECT,
  sanitizeCloudErrorDetails,
  sanitizeCastCommand,
  sanitizeCloudDevice,
  sanitizeCloudProfile,
  sanitizeContentEvent,
  sanitizeFavorite,
  sanitizeHistoryData,
  sanitizeMediaItem,
  sanitizePairing,
  sanitizePlaybackEvent,
  sanitizePlaybackSession,
  sanitizeXtreamSeriesInfo,
  sanitizeXtreamShortEpg,
  sanitizeWatchHistory,
  WATCH_HISTORY_PUBLIC_SELECT,
} from "../_shared/cloud-public-view.mjs";
import {
  buildLiveMaterializationPlan,
  clearLiveMaterialization,
  fetchLiveChannelIdMap,
  materializeLiveChunk,
  refreshMaterializedLiveCatalog,
  upsertLiveChannelRows,
  upsertLiveVariantRows,
} from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection } from "../_shared/vod-title-projection.ts";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { featuresForDecision, getBillingMode, getEntitlementDecision, getEntitlementRuntime, hasConsumedTrial, isAdminUser, limitNumber, realPlanCode, recordEntitlementSignal } from "../_shared/entitlements.ts";
import { driveXtreamSyncToReady, freshSyncCursor } from "../_shared/xtream-sync.ts";
import {
  assertActiveCatalogGenerationCurrent,
  type ActiveCatalogGeneration,
  catalogGenerationFields,
  catalogGenerationRpcFence,
  isCatalogGenerationSuperseded,
  readActiveCatalogGenerationSnapshot,
  withCatalogGenerationRows,
} from "../_shared/catalog-generation.ts";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import {
  acknowledgeCatalogVisibilityEpochMutation,
  bindCatalogVisibilityEpoch as bindCatalogVisibilityEpochShared,
  catalogVisibilityEpochHeaders,
  finalizeCatalogVisibilityResponse,
} from "../_shared/catalog-visibility-response.mjs";
import {
  claimPaywallExperiment,
  normalizePaywallSurface,
  paywallExperimentForPlacement,
  recordPaywallExposure,
} from "../_shared/paywall-experiments.ts";

type JsonRecord = Record<string, unknown>;
type M3uPlaylistItem = { title: string; url: string; tvgId: string; logo: string; group: string };
type CloudUser = { id: string; email?: string; app_metadata?: JsonRecord | null };
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
type DirectFallbackLeaseContext = {
  db: SupabaseClient;
  sourceId: string;
  userId: string;
  expectedProviderAccountAffinityHash: string;
  expectedConfigRevision: string;
  expectedConfigCiphertextHash: string;
  assertSourceCurrent?: () => Promise<void>;
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
// Match norva-playback: Gateway startup is bounded to 60 seconds, but a
// prepared coordinator claim must also cover provider drain and commit I/O.
const EDGE_SESSION_COORDINATOR_LOCK_TTL_MS = 120_000;

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

// ── Presence gate (incident VOD mobile 2026-07-18) ──────────────────────────────
// A viewer's FIRST play attempt has no busy-lock signal yet: the lock's writers
// (session/event/history/gateway reporter) only fire once a stream exists, so a
// background probe that starts while they browse takes the provider's single
// slot and the launch collides (458 → minutes of client retries, or a terminal
// mobile error). Fix: any authenticated app/site activity marks the user's
// provider accounts busy ("presence"), so probes stand down BEFORE the first
// play. Throttled per user per isolate; best-effort (never fails the request);
// deliberately NOT wired to the TV device heartbeat — an idle keepalive is not
// presence, and counting it would starve the night enrichment windows.
const PRESENCE_TOUCH_INTERVAL_MS = 60_000;
const presenceTouchedAt = new Map<string, number>();
function touchUserPresence(db: SupabaseClient, userId: string) {
  try {
    const now = Date.now();
    if (now - (presenceTouchedAt.get(userId) ?? 0) < PRESENCE_TOUCH_INTERVAL_MS) return;
    presenceTouchedAt.set(userId, now);
    if (presenceTouchedAt.size > 1000) {
      for (const [key, at] of presenceTouchedAt) {
        if (now - at >= PRESENCE_TOUCH_INTERVAL_MS) presenceTouchedAt.delete(key);
      }
    }
    waitUntil(Promise.resolve(db.rpc("provider_account_touch_by_user", { p_user: userId, p_kind: "presence" }))
      .then(({ error }) => {
        if (error) console.warn("[norva-cloud] presence touch failed", error.message);
      }));
  } catch (_) { /* best-effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  return await finalizeCatalogVisibilityResponse(
    req,
    await handleRequest(req),
    supabase,
    { service: "norva-cloud", corsHeaders },
  );
});

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "image") {
      return await proxyImage(req, url);
    }
    const result = await route(req, url, segments, supabase);
    const res = (req.method === "GET" && typeof result.cache === "number" && result.cache > 0)
      ? jsonCached(req, result.body, result.cache, result.status ?? 200)
      : json(req, result.body, result.status ?? 200);
    // The request named a profile the plan has LOCKED (post-downgrade) and was silently served
    // the default profile instead — say so, so the client can tell the user rather than let two
    // profiles look inexplicably "desynchronized" (sync audit 2026-07-17 P2).
    if (lockedProfileFallbacks.has(req)) res.headers.set("x-norva-profile-fallback", "locked");
    return res;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const payload = publicErrorPayload(error, status);
    console.error("[norva-cloud]", publicErrorLog(error, status, payload));
    return json(req, payload, status);
  }
}

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

async function paywallExperimentClaim(url: URL, userId: string, db: SupabaseClient) {
  let experimentKey: string | null;
  try {
    // The placement is descriptive input. The server allowlist owns the
    // placement -> experiment mapping; an experimentKey query parameter is
    // intentionally ignored even when sent by an old or hostile client.
    ({ experimentKey } = paywallExperimentForPlacement(
      url.searchParams.get("placement"),
      "subscribe",
    ));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid paywall placement");
  }
  if (!experimentKey) throw new HttpError(400, "Unsupported paywall placement");
  return await claimPaywallExperiment(db, userId, experimentKey);
}

async function paywallExperimentExposure(req: Request, userId: string, db: SupabaseClient) {
  const body = await req.json().catch(() => null) as JsonRecord | null;
  if (!body) throw new HttpError(400, "Invalid JSON");
  // A forged `variant` or `experimentKey` property is ignored. The placement
  // selects an allowlisted server experiment, then the server resolves the
  // account's sticky assignment again.
  let experimentKey: string | null;
  let placement: string;
  let surface: ReturnType<typeof normalizePaywallSurface>;
  try {
    ({ placement, experimentKey } = paywallExperimentForPlacement(body.placement, "subscribe"));
    surface = normalizePaywallSurface(body.surface);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid exposure");
  }
  if (!experimentKey) throw new HttpError(400, "Unsupported paywall placement");
  return await recordPaywallExposure(db, userId, { experimentKey, placement, surface });
}

async function googlePlayCheckoutStarted(req: Request, userId: string, db: SupabaseClient) {
  const body = await req.json().catch(() => null) as JsonRecord | null;
  if (!body) throw new HttpError(400, "Invalid JSON");
  const requestId = stringOr(body.requestId, "");
  const offeringId = stringOr(body.offeringId, "");
  const packageId = stringOr(body.packageId, "");
  const storeProductId = stringOr(body.storeProductId, "");
  const planCode = stringOr(body.planCode, "").toLowerCase();
  const cadenceIso = stringOr(body.billingCadence, "").toUpperCase();
  const currency = stringOr(body.priceCurrency, "").toUpperCase();
  const amountMicros = Number(body.priceAmountMicros);
  if (!requestId || requestId.length > 160 || !offeringId || offeringId.length > 160
      || !packageId || packageId.length > 160 || !storeProductId || storeProductId.length > 160
      || !["plus", "family"].includes(planCode)
      || !["P1M", "P1Y"].includes(cadenceIso)
      || !/^[A-Z]{3}$/.test(currency)
      || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    throw new HttpError(400, "Invalid Google Play checkout snapshot");
  }
  const { placement, experimentKey } = paywallExperimentForPlacement(body.placement, "subscribe");
  if (!experimentKey) throw new HttpError(400, "Unsupported paywall placement");
  // Immutable server-owned tuple catalog. RevenueCat/Play prices are dynamic,
  // so this validates identity and cadence only; client prices remain evidence,
  // never commercial truth. Final purchase truth comes from the RC webhook.
  const googlePlayCatalog: Readonly<Record<string, Readonly<{
    planCode: "plus" | "family"; cadence: "monthly" | "annual"; cadenceIso: "P1M" | "P1Y";
  }>>> = Object.freeze({
    "$rc_monthly|norva_plus": Object.freeze({ planCode: "plus", cadence: "monthly", cadenceIso: "P1M" }),
    "$rc_annual|norva_plus": Object.freeze({ planCode: "plus", cadence: "annual", cadenceIso: "P1Y" }),
    "family_monthly|norva_family": Object.freeze({ planCode: "family", cadence: "monthly", cadenceIso: "P1M" }),
    "family_annual|norva_family": Object.freeze({ planCode: "family", cadence: "annual", cadenceIso: "P1Y" }),
  });
  const productBaseId = storeProductId.split(":", 1)[0];
  const catalogEntry = googlePlayCatalog[`${packageId}|${productBaseId}`];
  if (!catalogEntry || catalogEntry.planCode !== planCode || catalogEntry.cadenceIso !== cadenceIso) {
    throw new HttpError(400, "Unknown or inconsistent Google Play checkout tuple");
  }
  const assignment = await claimPaywallExperiment(db, userId, experimentKey);
  if (!assignment.eligible || !assignment.variant) {
    return { ok: true, recorded: false, reason: assignment.reason ?? "account_excluded" };
  }
  const { data: previous } = await db.from("paywall_funnel_events")
    .select("id").eq("user_id", userId).eq("event_type", "paywall_exposed")
    .eq("experiment_key", experimentKey).eq("surface", "mobile_android")
    .eq("placement", placement)
    .gte("occurred_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  if (!(previous as { id?: string } | null)?.id) {
    return { ok: true, recorded: false, reason: "no_recent_mobile_exposure" };
  }
  const dedupeKey = `checkout_started:google_play:${userId}:${requestId}`;
  const { data, error } = await db.from("paywall_funnel_events").upsert({
    user_id: userId,
    event_type: "checkout_started",
    event_source: "native_google_play",
    experiment_key: assignment.experimentKey,
    experiment_variant: assignment.variant,
    placement,
    surface: "mobile_android",
    plan_code: catalogEntry.planCode,
    billing_cadence: catalogEntry.cadence,
    price_amount_minor: null,
    price_currency: null,
    previous_event_id: (previous as { id: string }).id,
    dedupe_key: dedupeKey,
    metadata: {
      store: "google_play",
      requested_selection: {
        offering_id: offeringId,
        package_id: packageId,
        store_product_id: storeProductId,
        offering_id_authority: "unverified_current_offering_observation",
      },
      client_store_snapshot: {
        price_amount_micros: amountMicros,
        price_currency: currency,
        price_formatted: stringOrNull(body.priceFormatted),
        billing_period_iso: cadenceIso,
        authority: "unverified_native_client_observation",
      },
      commercial_terms_authority: "pending_revenuecat_webhook",
      trial_eligible: body.trialEligible === true,
      native_request_id: requestId,
    },
  }, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id,dedupe_key").maybeSingle();
  if (error) throw new Error(`Google Play checkout funnel write failed: ${error.message}`);
  return { ok: true, eventId: (data as { id?: string } | null)?.id ?? null, dedupeKey };
}

async function route(
  req: Request,
  url: URL,
  segments: string[],
  db: SupabaseClient,
): Promise<{ status?: number; body: unknown; cache?: number }> {
  const [scope, id, action] = segments;

  if (req.method === "GET" && scope === "health") {
    const runtimeConfig = await getRuntimeConfig(db);
    const entitlementRuntime = getEntitlementRuntime();
    return {
      body: {
        ok: true,
        service: "norva-cloud",
        version: 28,
        behavioralLifecycleProtocol: 1,
        sourceDesiredStateProtocol: 1,
        legacySourceToggleBridge: 1,
        m3uSyncLeaseProtocol: 2,
        m3uStreamingImportProtocol: 1,
        playbackCreationProtocol: 1,
        relayTakeoverProtocol: 1,
        relayCoordinatorLockTtlMs: EDGE_SESSION_COORDINATOR_LOCK_TTL_MS,
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
    // Presence gate: any real device activity (not the idle heartbeat keepalive)
    // stands the user's probes down before their first play of the session.
    if (id !== "heartbeat") touchUserPresence(db, device.user_id);
    if (req.method === "GET" && id === "me") return { body: { device: sanitizeCloudDevice(device) } };
    // Self-unpair: the paired screen (e.g. a TV) revokes ITS OWN device token on
    // logout, so the account drops this screen and the token can't silently
    // resume the session. Authenticated by the device token (requireDevice), so
    // no user session is needed on the screen.
    if (req.method === "DELETE" && id === "me") return { body: await revokeSelfDevice(device, db) };
    if ((req.method === "POST" || req.method === "PATCH") && id === "heartbeat") {
      return { body: await heartbeatDeviceToken(device, db) };
    }
    if (req.method === "GET" && id === "sources" && !action) {
      return { body: await listVisibleSources(device.user_id, db) };
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
    if (req.method === "POST" && id === "sources" && action && segments[3] === "test") {
      await assertVisibleSource(action, device.user_id, db);
      return { body: await testSourceConnection(action, device.user_id, db) };
    }
    if (req.method === "GET" && id === "media-items") {
      return { body: await listMediaItems(url, device.user_id, db) };
    }
    if (req.method === "GET" && id === "entitlements") {
      const decision = await getEntitlementDecision(db, device.user_id);
      return { body: { ...decision, features: featuresForDecision(decision) } };
    }
    if (id === "experiments" && action === "paywall") {
      if (req.method === "GET" && !segments[3]) {
        return { body: await paywallExperimentClaim(url, device.user_id, db) };
      }
      if (req.method === "POST" && segments[3] === "exposure") {
        return { body: await paywallExperimentExposure(req, device.user_id, db) };
      }
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

    // Cross-device sync for QR-paired screens (e.g. a TV): favorites, watch history,
    // and ratings. Same tables + handlers as the user (JWT) scope below, keyed to the
    // paired account (device.user_id) and the active profile (x-norva-profile-id
    // header). This is what lets a paired TV read AND write the same favorites,
    // Continue Watching, and watched state as the phone/web — no separate store.
    if (id === "favorites") {
      if (req.method === "GET" && !action) return { body: await listFavorites(req, url, device.user_id, db) };
      if (req.method === "POST" && !action) return { status: 201, body: await addFavorite(req, device.user_id, db) };
      if (req.method === "DELETE" && !action && (url.searchParams.get("itemId") || url.searchParams.get("item_id"))) {
        return { body: await deleteFavoriteByKeys(req, url, device.user_id, db) };
      }
      if (req.method === "DELETE" && action) return { body: await deleteOwned("cloud_favorites", action, device.user_id, db) };
    }
    if (id === "ratings") {
      if (req.method === "GET" && !action) return { body: await getRating(req, url, device.user_id, db) };
      if (req.method === "POST" && !action) return { body: await setRating(req, device.user_id, db) };
    }
    if (id === "history") {
      if (req.method === "GET" && !action) {
        if (url.searchParams.get("itemId") || url.searchParams.get("item_id")) {
          return { body: await getHistoryItem(req, url, device.user_id, db) };
        }
        return { body: await listHistory(req, url, device.user_id, db) };
      }
      if (req.method === "POST" && !action) return { status: 201, body: await saveHistory(req, device.user_id, db) };
      if (req.method === "DELETE" && !action && (url.searchParams.get("itemId") || url.searchParams.get("item_id"))) {
        return { body: await deleteHistoryByKeys(req, url, device.user_id, db) };
      }
      if (req.method === "DELETE" && action) return { body: await deleteOwned("cloud_watch_history", action, device.user_id, db) };
    }
    // Account profiles: a paired TV lists the account's profiles (to land on the
    // SAME profile as the phone/web) and can read/update the active one. Same
    // handlers as the user scope, keyed to the paired account.
    if (id === "profile") {
      if (req.method === "GET") return { body: await getProfile(device.user_id, db) };
      if (req.method === "PUT" || req.method === "PATCH") return { body: await upsertProfile(req, device.user_id, db) };
    }
    if (id === "profiles") {
      if (req.method === "GET" && !action) return { body: await listProfiles(device.user_id, db) };
      if (req.method === "POST" && !action) return { status: 201, body: await createProfile(req, device.user_id, db) };
      if ((req.method === "PATCH" || req.method === "PUT") && action) return { body: await updateProfile(req, action, device.user_id, db) };
      if (req.method === "DELETE" && action) return { body: await deleteProfile(action, device.user_id, db) };
    }
    // Push-notification token registration for the paired screen.
    if (id === "push-token" && req.method === "POST" && !action) {
      return { status: 201, body: await registerPushToken(req, device.user_id, db) };
    }
    // Notification / new-content feed (same cloud_content_events table).
    if (id === "content-events") {
      if (req.method === "GET") {
        return { body: await listVisibleContentEvents(url, device.user_id, db) };
      }
      if (req.method === "POST" && action === "seen") {
        const body = await req.json().catch(() => ({})) as JsonRecord;
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((x) => typeof x === "string").slice(0, 100)
          : null;
        let q = db.from("cloud_content_events")
          .update({ seen_at: new Date().toISOString() })
          .eq("user_id", device.user_id)
          .is("seen_at", null);
        if (ids && ids.length) q = q.in("id", ids);
        await q;
        return { body: { ok: true } };
      }
    }
  }

  const user = await requireUser(req, db);

  // Presence gate: the user is actively using the app/site — stand their probes
  // down now, before the first play attempt of the session (see helper above).
  touchUserPresence(db, user.id);

  // Cold-start aggregation: a fresh app load otherwise fans out into ~7 separate
  // norva-cloud calls (profile, profiles, entitlements, sources, trial, …), each
  // paying its own isolate cold-start + auth round-trip — the dominant cause of a
  // slow first paint. /boot answers them all from ONE isolate and ONE auth, with
  // the sections fetched in parallel. Best-effort per section: a failing query
  // returns null so the client transparently falls back to its individual fetch.
  if (scope === "boot" && req.method === "GET") {
    const [profileRes, profilesRes, entitlementsRes, sourcesRes, trialRes] = await Promise.allSettled([
      getProfile(user.id, db),
      listProfiles(user.id, db),
      (async () => {
        const decision = await getEntitlementDecision(db, user.id, { isAdmin: isAdminUser(user) });
        return { ...decision, features: featuresForDecision(decision) };
      })(),
      listSources(user.id, db),
      getTrialEligibility(user.id, db),
    ]);
    // Any section may be null on a transient hiccup; the client seeds only the
    // sections it received and falls back to an individual fetch for the rest, so
    // a null is never misread as "no data" — it just means "not seeded".
    const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    return {
      body: {
        profile: settled(profileRes),
        profiles: settled(profilesRes),
        entitlements: settled(entitlementsRes),
        sources: settled(sourcesRes),
        trialEligibility: settled(trialRes),
      },
    };
  }

  if (scope === "entitlements" && req.method === "GET") {
    const decision = await getEntitlementDecision(db, user.id, { isAdmin: isAdminUser(user) });
    return { body: { ...decision, features: featuresForDecision(decision) } };
  }

  if (scope === "experiments" && id === "paywall") {
    if (req.method === "GET" && !action) {
      return { body: await paywallExperimentClaim(url, user.id, db) };
    }
    if (req.method === "POST" && action === "exposure") {
      return { body: await paywallExperimentExposure(req, user.id, db) };
    }
    if (req.method === "POST" && action === "checkout-start") {
      return { status: 201, body: await googlePlayCheckoutStarted(req, user.id, db) };
    }
  }

  // Conversion-signal log (observe-mode scaffold): the client posts when a user
  // reaches for a premium-gated feature. Never gates anything — just records
  // demand against the user's real plan. { feature, context? }.
  if (scope === "entitlements" && req.method === "POST" && id === "signal") {
    const body = await req.json().catch(() => ({})) as JsonRecord;
    const feature = typeof body.feature === "string" ? body.feature : "";
    if (feature) {
      const decision = await getEntitlementDecision(db, user.id, { autoStartTrial: false, isAdmin: isAdminUser(user) });
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
      // ?all=1 → the inbox feed: seen + unseen (recent history) plus an unread
      // count, and does NOT mark anything seen. Default (no flag) keeps the legacy
      // "unseen only" behavior for the one-shot launch toast.
      return { body: await listVisibleContentEvents(url, user.id, db) };
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
    return { body: await getTrialEligibility(user.id, db), cache: 60 };
  }

  if (scope === "profiles") {
    // NOTE: deliberately not edge-cached. The client mutates this list
    // (create/update/remove) and immediately re-lists, so a browser-cached stale
    // copy would hide a just-created profile. The in-memory client cache (which
    // is invalidated on every write) is the correct layer here.
    if (req.method === "GET" && !id) return { body: await listProfiles(user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await createProfile(req, user.id, db) };
    if ((req.method === "PATCH" || req.method === "PUT") && id) return { body: await updateProfile(req, id, user.id, db) };
    if (req.method === "DELETE" && id) return { body: await deleteProfile(id, user.id, db) };
  }

  if (!scope || scope === "profile") {
    // Not edge-cached for the same reason as /profiles: it is edited in Settings
    // and a stale browser copy would briefly show the old name/avatar after a
    // save. Client-side cache (invalidated on save) covers the dedup.
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
    if (req.method === "GET" && id === "status" && !action) return { body: await listSourceStatuses(user.id, db) };
    if (req.method === "POST" && id === "estimate" && !action) return { body: await estimateSourceByUrl(req) };
    if (req.method === "POST" && id === "attempt" && !action) {
      return { status: 202, body: await recordClientSourceConnectionAttempt(req, user.id, db) };
    }
    if (req.method === "POST" && !id) {
      const input = await readJson(req.clone());
      const inputType = stringOr(input.sourceType ?? input.source_type ?? input.type, "");
      if (inputType === "m3u" && buildSourceConfig(inputType, input).playlistUrl === DISCOVERY_PLAYLIST_URL) {
        if (!DISCOVERY_SELECTION_ENABLED) throw new HttpError(503, "Norva Selection is temporarily unavailable", { code: "SELECTION_UNAVAILABLE" });
        await requireCloudAccess(user.id, db, "source_sync");
        const selectionId = await discoverySourceId(user.id);
        const { data: existing, error } = await db.from("cloud_sources").select("id").eq("id", selectionId).eq("user_id", user.id).maybeSingle();
        if (error) throwDb(error, "Unable to check selection");
        if (existing) return { body: { source: await managedSourceSnapshot(selectionId, user.id, db), syncStarted: false } };
      }
      // A hidden Phase-4 staging source is part of the same logical provider
      // replacement and must never consume a second commercial source slot.
      await requirePlanCapacity(user.id, db, "sources", "cloud_catalog_visible_sources");
      const body = await createSource(req, user.id, db);
      await acknowledgeCatalogVisibilityEpochMutation(req, db);
      return { status: 201, body };
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
    if (req.method === "POST" && id && action === "hard-sync") {
      await requireCloudAccess(user.id, db, "source_sync");
      return { body: await hardSyncSource(id, user.id, db) };
    }
    if (req.method === "POST" && id && action === "toggle") {
      const body = await setSourceEnabled(req, id, user.id, db);
      if (body.visibilityChanged) {
        await acknowledgeCatalogVisibilityEpochMutation(req, db);
      }
      return { body };
    }
    if (req.method === "POST" && id && action === "test") {
      return { body: await testSourceConnection(id, user.id, db) };
    }
    if (req.method === "GET" && id && action === "estimate") {
      return { body: await estimateSource(id, user.id, db) };
    }
    if (req.method === "POST" && id && action === "finalize") {
      await requireCloudAccess(user.id, db, "source_sync");
      const body = await readJson(req);
      return {
        body: await finalizeCloudSourceWithLease(id, user.id, db, {
          country: stringOrNull(body.country ?? url.searchParams.get("country")),
          phase: stringOr(body.phase ?? url.searchParams.get("phase"), "titles"),
          offset: boundedInt(body.offset ?? url.searchParams.get("offset"), 0, 0, 1_000_000),
          limit: boundedInt(body.limit ?? url.searchParams.get("limit"), 1000, 1, 2000),
          afterId: stringOr(body.afterId ?? url.searchParams.get("afterId"), ""),
        }),
      };
    }
    if ((req.method === "PATCH" || req.method === "PUT") && id) {
      return { body: await updateSource(req, id, user.id, db) };
    }
    if (req.method === "DELETE" && id) {
      const result = await deleteSource(id, user.id, db);
      if (result.visibilityChanged) {
        await acknowledgeCatalogVisibilityEpochMutation(req, db);
      }
      return { body: result.body };
    }
  }

  if (scope === "media-items") {
    if (req.method === "GET") return { body: await listMediaItems(url, user.id, db) };
    if (req.method === "POST") return { status: 201, body: await upsertMediaItems(req, user.id, db) };
  }

  if (scope === "favorites") {
    if (req.method === "GET" && !id) return { body: await listFavorites(req, url, user.id, db) };
    if (req.method === "POST" && !id) return { status: 201, body: await addFavorite(req, user.id, db) };
    // DELETE /favorites?sourceId&itemId&itemType — un-favorite by keys (one round-trip);
    // DELETE /favorites/:id — legacy delete by row UUID.
    if (req.method === "DELETE" && !id && (url.searchParams.get("itemId") || url.searchParams.get("item_id"))) {
      return { body: await deleteFavoriteByKeys(req, url, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_favorites", id, user.id, db) };
  }

  if (scope === "ratings") {
    // Thumbs up/down on a title. GET ?itemType[&itemId] → current rating(s);
    // POST {sourceId,itemId,itemType,rating,expectedRevision,operationId} writes
    // one logical reaction per profile with strict compare-and-set semantics.
    // Clients that omit BOTH causal fields temporarily use the measured EXPAND
    // compatibility path; clientRevision is not accepted as a CAS substitute.
    if (req.method === "GET" && !id) return { body: await getRating(req, url, user.id, db) };
    if (req.method === "POST" && !id) return { body: await setRating(req, user.id, db) };
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
    // DELETE /history?sourceId&itemId&itemType — keyed removal (one round-trip, no stale cache);
    // DELETE /history/:id — legacy delete by row UUID.
    if (req.method === "DELETE" && !id && (url.searchParams.get("itemId") || url.searchParams.get("item_id"))) {
      return { body: await deleteHistoryByKeys(req, url, user.id, db) };
    }
    if (req.method === "DELETE" && id) return { body: await deleteOwned("cloud_watch_history", id, user.id, db) };
  }

  if (scope === "push-token" && req.method === "POST" && !id) {
    return { status: 201, body: await registerPushToken(req, user.id, db) };
  }

  if (scope === "lifecycle-events" && req.method === "POST" && !id) {
    return { status: 202, body: await recordBehavioralLifecycleEvent(req, user.id, db) };
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

  // Vérif locale d'abord (voir _shared/local-auth.ts) — GoTrue n'est consulté
  // que si le verdict est indécidable localement (alg asymétrique, secret absent).
  const local = await verifyUserJwtLocally(token);
  if (local === "invalid") throw new HttpError(401, "Invalid bearer token");
  if (local !== "fallback") {
    await bindCatalogVisibilityEpoch(req, local.id, db);
    return local;
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  await bindCatalogVisibilityEpoch(req, data.user.id, db);
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
  await bindCatalogVisibilityEpoch(req, data.user_id, db);
  return {
    id: data.id,
    user_id: data.user_id,
    device_type: data.device_type,
    device_name: data.device_name,
    capabilities: recordOrEmpty(data.capabilities),
  };
}

async function bindCatalogVisibilityEpoch(req: Request, userId: string, db: SupabaseClient) {
  try {
    await bindCatalogVisibilityEpochShared(req, userId, db);
  } catch (_) {
    console.warn("[norva-cloud] catalog visibility epoch unavailable");
    throw new HttpError(503, "Catalog visibility is temporarily unavailable");
  }
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
  filters: { revoked?: boolean; activeSession?: boolean; notDeleted?: boolean } = {},
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
  filters: { revoked?: boolean; activeSession?: boolean; notDeleted?: boolean } = {},
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
  if (filters.notDeleted) {
    query = query.is("deleted_at", null); // a soft-deleted source no longer counts against the plan
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

// The plan's `profiles` limit is a HARD cap on how many profiles are USABLE — not
// just creatable. After a downgrade (e.g. Family 5 → Plus 2) the extra profiles are
// kept intact but LOCKED. The active set is deterministic and un-gameable: the
// default profile first, then the OLDEST by created_at (immutable — deliberately NOT
// the user-reorderable sort_order, which would be a bypass vector). Returns null when
// nothing is locked (count within limit). Unlock = upgrade, or delete an active one.
function activeProfileIdSet(
  profiles: Array<{ id: string; is_default?: boolean | null; created_at?: string | null }>,
  limit: number,
): Set<string> | null {
  const cap = Math.max(1, Number(limit) || 1);
  if (profiles.length <= cap) return null;
  const ordered = [...profiles].sort((a, b) =>
    (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) ||
    String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return new Set(ordered.slice(0, cap).map((p) => p.id));
}

// Requests that asked for a LOCKED profile and were served the default instead — flagged per
// request so the serve wrapper can expose the fallback in a response header.
const lockedProfileFallbacks = new WeakSet<Request>();

// Resolve the active profile from the request header, validating it belongs to the
// account AND is not LOCKED by the plan limit. A locked profile (over the cap after a
// downgrade) is refused even if the client forces the header — it falls back to the
// default profile, so a stale "active profile" can't keep reading locked data.
async function resolveProfileId(
  req: Request,
  userId: string,
  db: SupabaseClient,
  options: { mutation?: boolean } = {},
): Promise<string> {
  const headerId = stringOrNull(req.headers.get(PROFILE_HEADER));
  if (headerId) {
    const { data, error } = await db
      .from("cloud_account_profiles")
      .select("id, is_default, created_at")
      .eq("user_id", userId);
    if (error) throwDb(error, "Unable to resolve active profile");
    const rows = data ?? [];
    const target = rows.find((p) => p.id === headerId);
    if (target) {
      // Only multi-profile accounts can possibly be over the cap — skip the
      // entitlement lookup entirely for the common single-profile case.
      if (rows.length > 1) {
        const decision = await getEntitlementDecision(db, userId, { autoStartTrial: false });
        const limit = limitNumber(decision.limits, "profiles", 1);
        const activeSet = activeProfileIdSet(rows, limit);
        if (activeSet && !activeSet.has(headerId)) {
          if (options.mutation) {
            throw new HttpError(
              409,
              "Active profile is locked by the current plan",
              { code: "profile_locked" },
            );
          }
          lockedProfileFallbacks.add(req); // surfaced as x-norva-profile-fallback: locked
          return await getOrCreateDefaultProfileId(userId, db);
        }
      }
      return headerId;
    }
    // Reads retain the historical default-profile fallback for stale local
    // state. Mutations must never silently write another profile.
    if (options.mutation) {
      throw new HttpError(
        409,
        "Active profile is no longer available",
        { code: "profile_unavailable" },
      );
    }
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
  const rows = data ?? [];
  // Mark each profile locked/usable so the client can grey out + upsell the extras
  // after a downgrade. `locked` is false for every profile when within the cap.
  const activeSet = activeProfileIdSet(rows, limit);
  const profiles = rows.map((p) => ({ ...p, locked: activeSet ? !activeSet.has(p.id) : false }));
  return { profiles, limit, canCreate: rows.length < limit };
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
    .select(PROFILE_PUBLIC_SELECT)
    .eq("id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load profile");
  return sanitizeCloudProfile(data);
}

async function upsertProfile(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const { data: existing, error: existingError } = await db
    .from("cloud_profiles")
    .select("display_name,avatar_url,locale")
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
    .select(PROFILE_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to save profile");
  return sanitizeCloudProfile(data);
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
  return { devices: (data ?? []).map(sanitizeCloudDevice) };
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
  return { device: sanitizeCloudDevice(data), deviceToken: deviceToken || undefined };
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
  return { device: sanitizeCloudDevice(data) };
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

// Device-token-authenticated self-revoke (the screen unpairing itself on
// logout). Same effect as an owner-initiated revoke, but scoped to the caller's
// own device row — requireDevice already proved ownership of the token.
async function revokeSelfDevice(device: CloudDevice, db: SupabaseClient) {
  const { error } = await db
    .from("cloud_devices")
    .update({ revoked: true })
    .eq("id", device.id)
    .eq("user_id", device.user_id);
  if (error) throwDb(error, "Unable to unpair device");
  return { success: true, unpaired: true };
}

async function listSources(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_source_management_sources")
    .select(SOURCE_MANAGEMENT_PUBLIC_SELECT)
    .eq("user_id", userId)
    .is("deleted_at", null) // hide soft-deleted sources awaiting the reaper
    .order("created_at", { ascending: false });
  if (error) throwDb(error, "Unable to list sources");
  // Withdrawn Selection stays archived server-side without an unusable Enable
  // action in the ordinary paused-provider onboarding or source manager.
  const retiredId = await retiredDiscoverySourceId(userId);
  const withdrawnId = DISCOVERY_SELECTION_ENABLED ? null : await discoverySourceId(userId);
  return { sources: (data ?? []).filter(source => source.id !== retiredId && source.id !== withdrawnId).map(sanitizeSource) };
}

async function listVisibleSources(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select(SOURCE_CATALOG_PUBLIC_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throwDb(error, "Unable to list visible sources");
  return { sources: (data ?? []).map(sanitizeCatalogSource) };
}

async function listVisibleSourceIds(userId: string, db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id")
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to load visible sources");
  return new Set(
    (data ?? [])
      .map((source: Record<string, unknown>) => stringOr(source.id, ""))
      .filter((sourceId: string) => UUID_PATTERN.test(sourceId)),
  );
}

function visibleContentEventFilter(visibleSourceIds: Set<string>) {
  const ids = [...visibleSourceIds];
  return ids.length
    ? `source_id.is.null,source_id.in.(${ids.join(",")})`
    : "source_id.is.null";
}

async function listVisibleContentEvents(url: URL, userId: string, db: SupabaseClient) {
  const all = url.searchParams.get("all") === "1";
  const sourceFilter = visibleContentEventFilter(await listVisibleSourceIds(userId, db));
  let feedQuery = db
    .from("cloud_content_events")
    .select(CONTENT_EVENT_PUBLIC_SELECT)
    .eq("user_id", userId)
    .or(sourceFilter);
  if (!all) feedQuery = feedQuery.is("seen_at", null);
  const feedPromise = feedQuery
    .order("created_at", { ascending: false })
    .limit(all ? 40 : 20);

  if (!all) {
    const { data, error } = await feedPromise;
    if (error) throwDb(error, "Unable to list content events");
    return { events: (data ?? []).map(sanitizeContentEvent).filter(Boolean) };
  }

  const [feedRes, unreadRes] = await Promise.all([
    feedPromise,
    db.from("cloud_content_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("seen_at", null)
      .or(sourceFilter),
  ]);
  if (feedRes.error) throwDb(feedRes.error, "Unable to list content events");
  if (unreadRes.error) throwDb(unreadRes.error, "Unable to count content events");
  return {
    events: (feedRes.data ?? []).map(sanitizeContentEvent).filter(Boolean),
    unread: unreadRes.count ?? 0,
  };
}

async function managedSourceSnapshot(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_source_management_sources")
    .select(SOURCE_MANAGEMENT_PUBLIC_SELECT)
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!data) throw new HttpError(404, "Source not found");
  return sanitizeSource(data);
}

async function createSource(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceType = stringOr(body.sourceType ?? body.source_type ?? body.type, "");
  const displayName = stringOr(body.displayName ?? body.display_name ?? body.name, "");
  const rawConfig = buildSourceConfig(sourceType, body);
  const attempt = await summarizeSourceConnectionAttempt({
    sourceType,
    url: sourceType === "xtream"
      ? stringOr(rawConfig.serverUrl, "")
      : sourceType === "m3u"
        ? stringOr(rawConfig.playlistUrl, "")
        : "",
    inputPathShape: body.inputPathShape ?? body.input_path_shape,
  });
  const clientContext = sourceAttemptClientContext(req.headers.get("user-agent"));

  try {
    if (!sourceType || !displayName) throw new HttpError(400, "sourceType and displayName are required");
    if (!["xtream", "m3u", "epg"].includes(sourceType)) throw new HttpError(400, "Unsupported source type");

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

    const selectionId = sourceType === "m3u" && rawConfig.playlistUrl === DISCOVERY_PLAYLIST_URL
      ? await discoverySourceId(userId) : null;
    const row = {
      ...(selectionId ? { id: selectionId } : {}),
      user_id: userId,
      source_type: sourceType,
      display_name: displayName,
      config_ciphertext: configCiphertext,
      config_hint: compactRecord(configHint),
      sync_status: syncNow ? "syncing" : stringOr(body.syncStatus ?? body.sync_status, "idle"),
    };

    const { data, error } = await db.from("cloud_sources").insert(row).select("id").single();
    if (error?.code === "23505" && selectionId) {
      return { source: await managedSourceSnapshot(selectionId, userId, db), syncStarted: false };
    }
    if (error) throwDb(error, "Unable to create source");

    if (syncNow) {
      waitUntil(syncCloudSource(data.id, userId, db));
    }

    const result = {
      source: await managedSourceSnapshot(data.id, userId, db),
      validation: sanitizeSourceValidation(validation),
      syncStarted: syncNow,
    };
    scheduleSourceConnectionAttempt(db, userId, attempt, clientContext, null);
    return result;
  } catch (error) {
    scheduleSourceConnectionAttempt(db, userId, attempt, clientContext, error);
    throw error;
  }
}

const SOURCE_ATTEMPT_CLIENT_WINDOW_MS = 60_000;
const SOURCE_ATTEMPT_CLIENT_MAX_PER_WINDOW = 12;
const sourceAttemptClientWindows = new Map<string, { startedAt: number; count: number }>();

function admitClientSourceAttempt(userId: string) {
  const now = Date.now();
  const current = sourceAttemptClientWindows.get(userId);
  if (!current || now - current.startedAt >= SOURCE_ATTEMPT_CLIENT_WINDOW_MS) {
    if (!current && sourceAttemptClientWindows.size >= 2000) {
      for (const [key, window] of sourceAttemptClientWindows) {
        if (now - window.startedAt >= SOURCE_ATTEMPT_CLIENT_WINDOW_MS) sourceAttemptClientWindows.delete(key);
      }
      if (sourceAttemptClientWindows.size >= 2000) return false;
    }
    sourceAttemptClientWindows.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= SOURCE_ATTEMPT_CLIENT_MAX_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

async function recordClientSourceConnectionAttempt(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const allowedKeys = new Set([
    "sourceType", "domainNormalized", "hostHash", "pathShape", "failureFamily",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, "Unsupported source attempt diagnostic field");
  }

  const sourceType = normalizeSourceAttemptType(body.sourceType);
  const pathShape = normalizeSourceAttemptPathShape(body.pathShape);
  const rawDomain = stringOr(body.domainNormalized, "").trim().toLowerCase();
  const hostHash = stringOr(body.hostHash, "").trim().toLowerCase();
  const failureFamily = stringOr(body.failureFamily, "").trim().toLowerCase();
  if (!sourceType || !pathShape) throw new HttpError(400, "Invalid source attempt diagnostic");
  if (rawDomain && !/^[a-z0-9._-]{1,253}$/.test(rawDomain)) {
    throw new HttpError(400, "Invalid source attempt domain");
  }
  if (hostHash && !/^[0-9a-f]{64}$/.test(hostHash)) {
    throw new HttpError(400, "Invalid source attempt host hash");
  }
  if (!["missing_credentials", "invalid_input"].includes(failureFamily)) {
    throw new HttpError(400, "Invalid source attempt failure family");
  }
  if (!admitClientSourceAttempt(userId)) return { accepted: true };

  const domainNormalized = ["ip-address", "local-address"].includes(rawDomain)
    ? rawDomain : normalizedSourceAttemptDomain(rawDomain);
  const attempt = {
    sourceType,
    domainNormalized,
    hostHash: domainNormalized ? hostHash || null : null,
    pathShape: domainNormalized ? pathShape : "invalid",
  };
  const clientContext = sourceAttemptClientContext(req.headers.get("user-agent"));
  scheduleSourceConnectionAttempt(
    db,
    userId,
    attempt,
    clientContext,
    new HttpError(422, "Client-side source validation failed", {
      code: failureFamily === "missing_credentials" ? "MISSING_CREDENTIALS" : "INVALID_REQUEST",
    }),
  );
  return { accepted: true };
}

function scheduleSourceConnectionAttempt(
  db: SupabaseClient,
  userId: string,
  attempt: {
    sourceType: string;
    domainNormalized: string | null;
    hostHash: string | null;
    pathShape: string;
  } | null,
  clientContext: { platform: string; appVersion: string | null },
  failure: unknown,
) {
  if (!attempt) return;
  const status = failure instanceof HttpError
    ? Math.max(100, Math.min(599, Math.trunc(failure.status)))
    : failure
      ? 500
      : 201;
  const details = failure instanceof HttpError ? recordOrEmpty(failure.details) : {};
  const failureFamily = failure
    ? classifySourceAttemptFailure({
      status,
      code: details.code,
      message: failure instanceof Error ? failure.message : "",
    })
    : null;

  const outcome = failure ? "failed" : "accepted";
  const behavioralEventId = crypto.randomUUID();
  waitUntil(Promise.allSettled([
    Promise.resolve(db.rpc("norva_record_source_connection_attempt", {
      p_user_id: userId,
      p_source_type: attempt.sourceType,
      p_domain_normalized: attempt.domainNormalized,
      p_host_hash: attempt.hostHash,
      p_path_shape: attempt.pathShape,
      p_outcome: outcome,
      p_http_status: status,
      p_failure_family: failureFamily,
      p_platform: clientContext.platform,
      p_app_version: clientContext.appVersion,
    })).then(({ error }) => {
      if (error) throw error;
    }),
    Promise.resolve(db.rpc("norva_capture_behavioral_source_attempt", {
      p_user_id: userId,
      p_source_type: attempt.sourceType,
      p_outcome: outcome,
      p_failure_family: failureFamily,
      p_platform: clientContext.platform,
      p_app_version: clientContext.appVersion,
      p_event_id: behavioralEventId,
    })).then(({ error }) => {
      if (error) throw error;
    }),
  ]).then((results) => {
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const rawCode = (result.reason as { code?: unknown } | undefined)?.code;
      const safeCode = /^[A-Z0-9_]{1,16}$/.test(String(rawCode ?? "").toUpperCase())
        ? String(rawCode).toUpperCase()
        : "DATABASE_ERROR";
      console.warn(
        `[norva-cloud] ${index === 0 ? "source attempt telemetry" : "behavioral source projection"} failed`,
        safeCode,
      );
    });
  }));
}

async function updateSource(req: Request, id: string, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  assertLegacySourcePatchAllowlisted(body);
  const displayName = stringOr(body.displayName ?? body.display_name, "");
  if (!displayName || displayName.length > 160) {
    throw new HttpError(400, "Invalid source display name", { code: "INVALID_REQUEST" });
  }

  const { data, error } = await db
    .from("cloud_sources")
    .update({ display_name: displayName })
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) throwDb(error, "Unable to update source");
  if (!data) throw new HttpError(404, "Source not found");

  return { source: await managedSourceSnapshot(data.id, userId, db) };
}

const LEGACY_SOURCE_CREDENTIAL_FIELDS = new Set([
  "serverUrl",
  "server_url",
  "username",
  "password",
  "playlistUrl",
  "playlist_url",
  "epgUrl",
  "epg_url",
  "url",
  "config",
  "configCiphertext",
  "config_ciphertext",
]);

const LEGACY_SOURCE_PATCH_FIELDS = new Set(["displayName", "display_name"]);

function assertLegacySourcePatchAllowlisted(body: JsonRecord) {
  const keys = Object.keys(body);
  if (keys.some((key) => LEGACY_SOURCE_CREDENTIAL_FIELDS.has(key))) {
    throw new HttpError(409, "Use the credential transition workflow", {
      code: "DIRECT_CREDENTIAL_MUTATION_FORBIDDEN",
    });
  }
  if (keys.length === 0 || keys.some((key) => !LEGACY_SOURCE_PATCH_FIELDS.has(key))) {
    throw new HttpError(400, "Only the source display name can be updated", { code: "INVALID_REQUEST" });
  }
}

type LegacyM3uClaimRestore = {
  expectedUpdatedAt: string;
  patch: Record<"sync_status" | "sync_error", string | null> & {
    config_hint?: JsonRecord;
  };
};

async function restoreLegacyM3uClaimState(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  restore: LegacyM3uClaimRestore,
) {
  const { error } = await db
    .from("cloud_sources")
    .update(restore.patch)
    .eq("id", sourceId)
    .eq("user_id", userId)
    .eq("source_type", "m3u")
    .eq("sync_status", "syncing")
    .eq("updated_at", restore.expectedUpdatedAt);
  if (error) {
    console.error("[norva-cloud] legacy M3U claim-state restore failed", sourceId, error.message);
  }
}

async function syncExistingSource(id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  await assertVisibleSource(id, userId, db);
  const { data: prior, error: priorError } = await db
    .from("cloud_sources")
    .select("source_type,sync_status,sync_error,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (priorError) throwDb(priorError, "Unable to read source sync state");
  if (!prior) throw new HttpError(404, "Source not found");
  const { data, error } = await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("updated_at", String(prior.updated_at))
    .select("id,updated_at")
    .maybeSingle();
  if (error) throwDb(error, "Unable to start source sync");
  if (!data) throw new HttpError(409, "Source state changed; retry synchronization");
  const legacyRestore: LegacyM3uClaimRestore | null = prior.source_type === "m3u"
    ? {
      expectedUpdatedAt: String(data.updated_at),
      patch: {
        sync_status: stringOr(prior.sync_status, "idle"),
        // This stored value crosses a persistence boundary again during the
        // bounded rollback, so apply the canonical redaction and length cap.
        sync_error: typeof prior.sync_error === "string" && prior.sync_error.trim()
          ? formatSourceSyncError(new Error(prior.sync_error), "Source sync failed")
          : null,
      },
    }
    : null;
  waitUntil(syncCloudSource(id, userId, db, legacyRestore));
  return { source: await managedSourceSnapshot(data.id, userId, db), syncStarted: true };
}

// Set the desired source state. Disabled = paused: excluded from auto-refresh/resume and hidden from
// the catalog UI (the client filters `sources.filter(s => s.enabled)`), but its data is kept.
//
// This endpoint intentionally accepts a desired state rather than an instruction to invert the
// current value. Retries are therefore idempotent. The conditional update is the only transition
// winner, so two simultaneous enable requests can never start two sync drivers.
async function setSourceEnabled(req: Request, id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  const body = await readJson(req);
  const hasDesiredState = Object.prototype.hasOwnProperty.call(body, "enabled");
  if (hasDesiredState && typeof body.enabled !== "boolean") {
    throw new HttpError(400, "The desired source state is required", {
      code: "SOURCE_ENABLED_STATE_REQUIRED",
    });
  }
  const { data: cur, error: readErr } = await db
    .from("cloud_sources")
    .select("enabled,source_type,sync_status,deleted_at")
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readErr) throwDb(readErr, "Unable to read source");
  if (!cur) throw new HttpError(404, "Source not found");
  const current = (cur as JsonRecord).enabled === true;
  // Rolling-deploy bridge: tabs loaded before the desired-state client shipped
  // still send an empty body. Preserve their legacy one-shot inversion so an
  // urgent Disable remains available. Newly loaded clients always send the
  // explicit desired state and therefore retain retry idempotence.
  const desired = hasDesiredState ? body.enabled === true : !current;
  if (desired && (id === await retiredDiscoverySourceId(userId)
    || (!DISCOVERY_SELECTION_ENABLED && id === await discoverySourceId(userId)))) {
    throw new HttpError(503, "Norva Selection is temporarily unavailable", { code: "SELECTION_UNAVAILABLE" });
  }
  const legacyToggle = !hasDesiredState;
  const sourceType = stringOr((cur as JsonRecord | null)?.source_type, "");
  const syncStatus = stringOr((cur as JsonRecord | null)?.sync_status, "idle");
  if (current === desired) {
    return {
      success: true,
      enabled: desired,
      syncStarted: false,
      visibilityChanged: false,
      legacyToggle,
      source: await managedSourceSnapshot(id, userId, db),
    };
  }

  const { data, error } = await db
    .from("cloud_sources")
    .update({ enabled: desired })
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("enabled", current)
    .select("id")
    .maybeSingle();
  if (error) throwDb(error, "Unable to change source state");

  // A concurrent winner may already have committed the same desired state.
  // Treat that as a successful no-op; only the actual transition winner may
  // resume a paused import.
  if (!data) {
    const { data: latest, error: latestError } = await db
      .from("cloud_sources")
      .select("enabled")
      .eq("id", id)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (latestError) throwDb(latestError, "Unable to verify source state");
    if (!latest) throw new HttpError(404, "Source not found");
    if ((latest as JsonRecord).enabled !== desired) {
      throw new HttpError(409, "The source state changed concurrently", {
        code: "SOURCE_STATE_CONFLICT",
      });
    }
    return {
      success: true,
      enabled: desired,
      syncStarted: false,
      visibilityChanged: false,
      legacyToggle,
      source: await managedSourceSnapshot(id, userId, db),
    };
  }

  // Disabling during a large resumable import deliberately pauses that source.
  // Re-enabling persists a due cursor/progress marker in the BEFORE trigger;
  // the minutely resume-stuck watchdog owns the retry.  Correctness therefore
  // survives an Edge isolate dying immediately after this CAS commits.
  // Re-enabling a ready M3U is also a durable recovery action: it clears the
  // raw-only fair-refresh suspension and makes that lane immediately due while
  // preserving the ready catalogue and its cursor-free state.
  const syncScheduled = desired && (syncStatus !== "ready" || sourceType === "m3u");

  return {
    success: true,
    enabled: desired,
    // Preserve the public response field while making the durable scheduling
    // semantics explicit for newer clients and operational evidence.
    syncStarted: syncScheduled,
    syncScheduled,
    visibilityChanged: true,
    legacyToggle,
    source: await managedSourceSnapshot(data.id, userId, db),
  };
}

// Check a source's connection on demand (the "Check service" button). Reuses the same validation
// the create/edit flow runs (gateway-first for Xtream, so it doesn't trip the provider's IP block).
async function testSourceConnection(id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  const { data: src } = await db
    .from("cloud_sources").select("source_type").eq("id", id).eq("user_id", userId).maybeSingle();
  const type = stringOr((src as JsonRecord | null)?.source_type, "");
  try {
    const configRevision = await sourceConfigRevisionSnapshot(id, userId, db);
    const loaded = await loadSourceConfigEnvelope(id, userId, db);
    const assertSourceCurrent = () => assertSourceConfigRevisionCurrent(id, userId, configRevision, db);
    const directFallback = type === "xtream"
      ? {
        db,
        sourceId: id,
        userId,
        ...await buildProviderDirectFallbackSnapshot({
          serverUrl: loaded.config.serverUrl,
          username: loaded.config.username,
          configCiphertext: loaded.configCiphertext,
          configRevision,
        }),
        assertSourceCurrent,
      }
      : null;
    const validate = async () => validateCloudSource(
      type,
      loaded.config,
      await getRuntimeConfig(db),
      directFallback,
    );
    if (type === "m3u") {
      await withM3uSourceLease(db, id, userId, validate);
    } else {
      await validate();
    }
    await assertSourceCurrent();
    return sanitizeSourceConnectionResult({
      success: true,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    const details = err instanceof HttpError ? recordOrEmpty(err.details) : {};
    return sanitizeSourceConnectionResult({
      success: false,
      code: details.code,
      status,
      checkedAt: new Date().toISOString(),
    });
  }
}

// Per-source sync status for the client's post-"Sync now" poll. Shape matches what refreshSource
// looks for: an entry with { source_id, type: 'all', status } where status is success|error|syncing.
async function listSourceStatuses(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_source_management_sources")
    .select("id,sync_status,sync_error,catalog_visible,user_visibility_epoch")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (error) throwDb(error, "Unable to list source statuses");
  return (data ?? []).map((s) => {
    const raw = stringOr((s as JsonRecord).sync_status, "");
    const publicError = publicSourceSyncError((s as JsonRecord).sync_error);
    return {
      source_id: String((s as JsonRecord).id),
      type: "all",
      status: raw === "ready" ? "success" : raw === "error" ? "error" : "syncing",
      error: publicError.message,
      error_code: publicError.code,
      catalog_visible: (s as JsonRecord).catalog_visible === true,
      user_visibility_epoch: stringOrNull((s as JsonRecord).user_visibility_epoch),
    };
  });
}

// Count the items a playlist would import without buffering the full catalogue.
// Stop as soon as the warning threshold is proven. The UI does not need to
// download a complete large catalogue before it can let the background import
// begin, and a bounded lower bound is more honest than a timed-out exact count.
async function estimateM3uPlaylist(url: string) {
  const result = await fetchM3uItems(url, 15_000, {
    maxBytes: 32 * 1024 * 1024,
    maxItems: 10_001,
  });
  return {
    count: result.items.length,
    needsWarning: result.items.length > 10_000 || result.truncated,
    countIsLowerBound: result.truncated,
  };
}

async function estimateSource(id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  const config = await loadSourceConfig(id, userId, db);
  const url = stringOr(config.playlistUrl, "");
  if (!url) return { count: 0, needsWarning: false };
  assertHttpUrl(url);
  return await withM3uSourceLease(db, id, userId, async () => (
    await estimateM3uPlaylist(url)
  ));
}

async function estimateSourceByUrl(req: Request) {
  const body = await readJson(req);
  const url = stringOr(body.url, "");
  if (stringOr(body.type, "m3u") !== "m3u") return { count: 0, needsWarning: false };
  if (!url) throw new HttpError(400, "A playlist URL is required");
  assertHttpUrl(url);
  return await estimateM3uPlaylist(url);
}

// Rebuild the catalogue (the "Rebuild catalog" button): clear the incremental sync signature/cursors
// so the next sync re-discovers the whole catalogue from the provider and re-upserts it, then start
// it. We deliberately do NOT delete the existing rows inline — for a large panel that would exceed
// the request timeout (the bug the Remove button had); the full re-sync overwrites items in place.
async function hardSyncSource(id: string, userId: string, db: SupabaseClient) {
  await assertOwnedSource(id, userId, db);
  await assertVisibleSource(id, userId, db);
  const { data: cur, error: currentError } = await db
    .from("cloud_sources")
    .select("source_type,sync_status,sync_error,config_hint,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (currentError) throwDb(currentError, "Unable to read source rebuild state");
  if (!cur) throw new HttpError(404, "Source not found");
  const priorHint = recordOrEmpty((cur as JsonRecord).config_hint);
  const hint = { ...priorHint };
  for (const k of ["contentSignature", "syncCursor", "finalizeCursor", "finalizeLease", "syncProgress"]) delete hint[k];
  const { data, error } = await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null, config_hint: compactRecord(hint) })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("updated_at", String(cur.updated_at))
    .select("id,updated_at")
    .maybeSingle();
  if (error) throwDb(error, "Unable to start rebuild");
  if (!data) throw new HttpError(409, "Source state changed; retry rebuild");
  const legacyRestore: LegacyM3uClaimRestore | null = cur.source_type === "m3u"
    ? {
      expectedUpdatedAt: String(data.updated_at),
      patch: {
        sync_status: stringOr(cur.sync_status, "idle"),
        sync_error: typeof cur.sync_error === "string" && cur.sync_error.trim()
          ? formatSourceSyncError(new Error(cur.sync_error), "Source sync failed")
          : null,
        config_hint: priorHint,
      },
    }
    : null;
  waitUntil(syncCloudSource(id, userId, db, legacyRestore));
  return { source: await managedSourceSnapshot(data.id, userId, db), syncStarted: true, hard: true };
}

function buildSourceConfig(sourceType: string, body: JsonRecord): JsonRecord {
  const supplied = recordOrEmpty(body.config);
  if (Object.keys(supplied).length) return supplied;

  if (sourceType === "xtream") {
    const serverUrl = stringOr(body.serverUrl ?? body.server_url ?? body.url, "");
    const username = typeof body.username === "string" && body.username.trim() ? body.username : "";
    const password = typeof body.password === "string" && body.password.length ? body.password : "";
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
// this edge runtime's datacenter IP. A direct edge fetch is used only when no gateway
// is configured. Once the gateway path is selected, every provider or network verdict
// is surfaced as-is and is never retried through a second route.
async function withExistingXtreamDirectFallback<T>(
  context: DirectFallbackLeaseContext,
  ownerScope: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await withSourceDirectFallbackLease({
      ...context,
      owner: providerDirectFallbackLeaseOwner(ownerScope),
      ttlSeconds: directFallbackLeaseTtlSeconds(timeoutMs),
    }, operation);
  } catch (error) {
    if (error instanceof ProviderDirectFallbackLeaseError) {
      throw new HttpError(error.status, error.message, error.details);
    }
    throw error;
  }
}

async function validateXtreamAccount(
  runtimeConfig: RuntimeConfig,
  creds: { serverUrl: string; username: string; password: string },
  directFallback: DirectFallbackLeaseContext | null = null,
): Promise<JsonRecord> {
  const { serverUrl, username, password } = creds;
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    const payload = recordOrEmpty(
      await requestGatewayMetadata(runtimeConfig, { serverUrl, username, password, action: "account_info" }, 20000),
    );
    await directFallback?.assertSourceCurrent?.();
    return payload;
  }
  const directFetch = async () => {
    const payload = await fetchJson(xtreamApiUrl({ serverUrl, username, password }), 12000);
    await directFallback?.assertSourceCurrent?.();
    return payload;
  };
  if (!directFallback) {
    // Creation validates a source that does not exist yet and therefore cannot
    // have an in-flight transition. Existing-source checks always pass the
    // atomic lease context above.
    return recordOrEmpty(await directFetch());
  }
  return recordOrEmpty(await withExistingXtreamDirectFallback(
    directFallback,
    "cloud-source-test",
    12_000,
    directFetch,
  ));
}

async function validateCloudSource(
  sourceType: string,
  config: JsonRecord,
  runtimeConfig: RuntimeConfig,
  directFallback: DirectFallbackLeaseContext | null = null,
) {
  if (sourceType === "xtream") {
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
    const password = typeof config.password === "string" && config.password.length ? config.password : "";
    if (!serverUrl || !username || !password) {
      throw new HttpError(400, "Xtream requires server URL, username and password");
    }

    const payload = await validateXtreamAccount(runtimeConfig, { serverUrl, username, password }, directFallback);
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
    const preview = await fetchTextPrefix(playlistUrl, 12000, 64 * 1024);
    if (!hasExtendedM3uHeader(preview.text)) {
      throw new HttpError(400, "This URL does not look like a valid M3U playlist");
    }
    const previewItems = countExtendedM3uEntries(preview.text);
    return {
      playlistUrl,
      // A prefix count is a lower bound, not an estimate. Avoid persisting it as
      // an exact catalogue size; the background sync reports the final count.
      estimatedItems: preview.truncated ? undefined : previewItems,
    };
  }

  return {};
}

function buildSourceHint(sourceType: string, config: JsonRecord, validation: JsonRecord) {
  if (sourceType === "xtream") {
    const serverUrl = stringOr(validation.serverUrl ?? config.serverUrl, "");
    return {
      serverHost: safeHost(serverUrl),
      username: typeof (validation.username ?? config.username) === "string"
        && String(validation.username ?? config.username).trim()
        ? String(validation.username ?? config.username)
        : "",
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
  for (const flag of ["moviesReady", "seriesReady", "liveReady", "browseReady", "usable"]) {
    if (current[flag] === true || patch[flag] === true) merged[flag] = true;
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
    moviesReady: true,
    seriesReady: true,
    liveReady: true,
    browseReady: true,
    usable: true,
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

async function sourceSyncIoAllowed(sourceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .eq("enabled", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify source sync visibility");
  return Boolean(data);
}

type M3uSyncLeaseClaim = {
  claimed: boolean;
  reason: string;
  retryAt: string;
  attemptCount: number;
  leaseUntil: string;
};

const M3U_SYNC_LEASE_TTL_SECONDS = 300;

async function claimM3uSyncLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
): Promise<M3uSyncLeaseClaim> {
  const { data, error } = await db.rpc("norva_claim_source_m3u_sync_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: M3U_SYNC_LEASE_TTL_SECONDS,
  });
  if (error) throwDb(error, "Unable to claim M3U sync lease");
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  return {
    claimed: result.claimed === true,
    reason: stringOr(result.reason, ""),
    retryAt: stringOr(result.retryAt ?? result.retry_at, ""),
    attemptCount: Math.max(0, Number(result.attemptCount ?? result.attempt_count) || 0),
    leaseUntil: stringOr(result.leaseUntil ?? result.lease_until, ""),
  };
}

async function claimM3uDiagnosticLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
): Promise<M3uSyncLeaseClaim> {
  const { data, error } = await db.rpc("norva_claim_source_m3u_diagnostic_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: M3U_SYNC_LEASE_TTL_SECONDS,
  });
  if (error) throwDb(error, "Unable to claim M3U diagnostic lease");
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  return {
    claimed: result.claimed === true,
    reason: stringOr(result.reason, ""),
    retryAt: stringOr(result.retryAt ?? result.retry_at, ""),
    attemptCount: Math.max(0, Number(result.attemptCount ?? result.attempt_count) || 0),
    leaseUntil: stringOr(result.leaseUntil ?? result.lease_until, ""),
  };
}

async function assertM3uSyncLeaseCurrent(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
) {
  const { data, error } = await db.rpc("norva_renew_source_m3u_sync_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: M3U_SYNC_LEASE_TTL_SECONDS,
  });
  if (error) throwDb(error, "Unable to renew M3U sync lease");
  if (data !== true) {
    throw new HttpError(409, "M3U sync ownership changed", {
      code: "M3U_SYNC_LEASE_LOST",
    });
  }
}

async function settleM3uSyncLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
  outcome: "success" | "transient_error" | "permanent_error" | "cancelled",
  errorKind: string | null,
) {
  const { data, error } = await db.rpc("norva_settle_source_m3u_sync_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_outcome: outcome,
    p_error_kind: errorKind,
  });
  if (error) {
    console.error("[norva-cloud] Unable to settle M3U sync lease", error.message);
    return { settled: false, state: "unknown" };
  }
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  return { settled: result.settled === true, state: stringOr(result.state, "") };
}

function classifyM3uSyncFailure(error: unknown): {
  outcome: "transient_error" | "permanent_error";
  errorKind: string;
} {
  const status = error instanceof HttpError ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if ([400, 401, 403, 404, 410, 422].includes(status)) {
    return { outcome: "permanent_error", errorKind: `HTTP_${status}` };
  }
  if (/managed cloud configuration|decrypt|invalid playlist|no playable catalog/i.test(message)) {
    return { outcome: "permanent_error", errorKind: "M3U_CONFIGURATION_OR_CONTENT" };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "transient_error", errorKind: status ? `HTTP_${status}` : "PROVIDER_TRANSIENT" };
  }
  if (/timeout|timed out|network|fetch|connection|socket|econn|temporar|upstream/i.test(message)) {
    return { outcome: "transient_error", errorKind: "PROVIDER_TRANSIENT" };
  }
  return { outcome: "transient_error", errorKind: "M3U_SYNC_UNKNOWN" };
}

async function withM3uSourceLease<T>(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const leaseToken = crypto.randomUUID();
  const claim = await claimM3uDiagnosticLease(db, sourceId, userId, leaseToken);
  if (!claim.claimed) {
    const quarantined = claim.reason === "quarantined";
    throw new HttpError(409, quarantined
      ? "This source must be disabled and enabled before another provider check"
      : "A source operation is already in progress", {
      code: quarantined ? "M3U_SYNC_QUARANTINED" : "M3U_SYNC_BUSY",
      retryAt: claim.retryAt || undefined,
    });
  }

  try {
    const result = await operation();
    await assertM3uSyncLeaseCurrent(db, sourceId, userId, leaseToken);
    await settleM3uSyncLease(db, sourceId, userId, leaseToken, "success", null);
    return result;
  } catch (error) {
    // Check/estimate are foreground diagnostics, not durable import attempts.
    // They share the exclusion lease but must not consume the import retry
    // budget or quarantine a source after a user closes/cancels the request.
    await settleM3uSyncLease(db, sourceId, userId, leaseToken, "cancelled", null);
    throw error;
  }
}

async function syncCloudSource(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  legacyRestore: LegacyM3uClaimRestore | null = null,
) {
  let baseHint: JsonRecord = {};
  let progress: JsonRecord = {};
  let generation: ActiveCatalogGeneration | null = null;
  let m3uLeaseToken: string | null = null;
  let m3uLeaseNextHeartbeatAt = 0;
  const heartbeatM3uSyncLease = async () => {
    if (!m3uLeaseToken || Date.now() < m3uLeaseNextHeartbeatAt) return;
    await assertM3uSyncLeaseCurrent(db, sourceId, userId, m3uLeaseToken);
    m3uLeaseNextHeartbeatAt = Date.now() + 60_000;
  };

  try {
    if (!await sourceSyncIoAllowed(sourceId, userId, db)) return;
    const { data: source, error } = await db
      .from("cloud_sources")
      .select("*")
      .eq("id", sourceId)
      .eq("user_id", userId)
      .eq("enabled", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throwDb(error, "Unable to load source");
    // A disable/delete racing the durable watchdog is a normal pause, not a
    // source error.  Stop before decrypting credentials or opening provider I/O.
    if (!source) return;
    if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");
    generation = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);

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
      // Idempotent re-entry: if a discovery chain is already in flight, join it
      // rather than restart (a restart wipes + re-imports and the two generations
      // deadlock each other under load).
      const cur = recordOrEmpty(baseHint.syncCursor);
      const heartbeat = Date.parse(stringOr(cur.heartbeatAt, "")) || 0;
      const inDiscovery = cur.active === true && stringOr(cur.phase, "") === "discover";
      if (inDiscovery && String(source.sync_status) === "syncing") {
        if (Date.now() - heartbeat < 75_000) return; // a chain is alive — join it
        if (!await sourceSyncIoAllowed(sourceId, userId, db)) return;
        await driveXtreamSyncToReady(sourceId, userId, db); // stalled → resume without wiping
        return;
      }

      // Big "8K" catalogues (100k+ items, 1000+ categories) can't be discovered,
      // imported and materialized inside one edge isolate's wall-clock budget.
      // Reset the resumable cursor for a fresh run, then hand to the driver which
      // walks categories incrementally and self-continues across isolates until
      // the raw catalogue is imported; the existing finalize stepper (driven by
      // the client poll / cron) then materializes it to "ready".
      const cursor = freshSyncCursor(startedAt);
      await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
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
      if (!await sourceSyncIoAllowed(sourceId, userId, db)) return;
      await driveXtreamSyncToReady(sourceId, userId, db);
      return;
    }

    // m3u / other source types stay on the single-isolate path (bounded size).
    if (source.source_type === "m3u") {
      const candidateToken = crypto.randomUUID();
      const claim = await claimM3uSyncLease(db, sourceId, userId, candidateToken);
      if (!claim.claimed) {
        // Old app builds pre-marked a source as syncing before this durable
        // claim existed. Restore only backoff/quarantine refusals, and only if
        // the exact post-write updated_at fence still owns the row. A leased
        // refusal deliberately remains syncing because another worker owns it.
        if (legacyRestore && ["backoff", "quarantined"].includes(claim.reason)) {
          await restoreLegacyM3uClaimState(db, sourceId, userId, legacyRestore);
        }
        return;
      }
      m3uLeaseToken = candidateToken;
      m3uLeaseNextHeartbeatAt = Date.now() + 60_000;
      baseHint = {
        ...baseHint,
        m3uSyncControl: compactRecord({
          v: 1,
          state: "running",
          attemptCount: claim.attemptCount,
          leaseUntil: claim.leaseUntil,
          updatedAt: startedAt,
        }),
      };
    }

    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
    const { error: startError } = await db
      .from("cloud_sources")
      .update({
        sync_status: "syncing",
        sync_error: null,
        last_synced_at: startedAt,
        config_hint: compactRecord({ ...baseHint, syncProgress: progress }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (startError) throwDb(startError, "Unable to start source sync");

    if (!await sourceSyncIoAllowed(sourceId, userId, db)) {
      if (m3uLeaseToken) {
        await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "cancelled", null);
        m3uLeaseToken = null;
      }
      return;
    }
    if (m3uLeaseToken) {
      await assertM3uSyncLeaseCurrent(db, sourceId, userId, m3uLeaseToken);
    }
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
    const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
      await heartbeatM3uSyncLease();
      progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
      await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation!);
      await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
    };

    if (!await sourceSyncIoAllowed(sourceId, userId, db)) {
      if (m3uLeaseToken) {
        await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "cancelled", null);
        m3uLeaseToken = null;
      }
      return;
    }
    const result = source.source_type === "m3u"
      ? await syncM3uSource(
        sourceId,
        userId,
        config,
        db,
        generation,
        reportProgress,
        heartbeatM3uSyncLease,
      )
      : { total: 0 };

    if (source.source_type === "m3u" && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }
    if (m3uLeaseToken) {
      await assertM3uSyncLeaseCurrent(db, sourceId, userId, m3uLeaseToken);
    }

    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
    const syncedAt = new Date().toISOString();
    const { error: readyError } = await db
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
    if (readyError) throwDb(readyError, "Unable to complete source sync");
    if (m3uLeaseToken) {
      await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "success", null);
      m3uLeaseToken = null;
    }
  } catch (error) {
    if (error instanceof HttpError
        && stringOr(recordOrEmpty(error.details).code, "") === "M3U_SYNC_LEASE_LOST") {
      if (m3uLeaseToken) {
        await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "cancelled", null);
      }
      return;
    }
    if (isCatalogGenerationSuperseded(error)) {
      if (m3uLeaseToken) {
        await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "cancelled", null);
      }
      return;
    }
    if (generation) {
      try {
        await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
      } catch (_) {
        if (m3uLeaseToken) {
          await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, "cancelled", null);
        }
        return;
      }
    }
    const message = formatSourceSyncError(error, "Source sync failed");
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
    if (m3uLeaseToken) {
      const failure = classifyM3uSyncFailure(error);
      await settleM3uSyncLease(db, sourceId, userId, m3uLeaseToken, failure.outcome, failure.errorKind);
    }
  }
}

type FinalizeCloudSourceOptions = {
  country: string | null;
  phase: string;
  offset: number;
  limit: number;
  afterId?: string;
};

// The authenticated client and the durable watchdog are two adapters over the
// same finalization machine. They must therefore share the same PostgreSQL CAS
// lease. Without this fence, rapid mobile polling could start several identical
// live-materialization batches while the watchdog also owned one, creating tuple
// lock chains and turning otherwise tiny upserts into statement timeouts.
async function finalizeCloudSourceWithLease(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  options: FinalizeCloudSourceOptions,
) {
  const ttlMs = boundedInt(Deno.env.get("NORVA_FINALIZE_LEASE_TTL_MS"), 240_000, 30_000, 900_000);
  const leaseToken = crypto.randomUUID();
  const claimed = await claimCloudFinalizeLease(db, sourceId, userId, leaseToken, ttlMs);
  if (!claimed) {
    return {
      sourceId,
      status: "syncing",
      deferred: true,
      reason: "finalize_in_progress",
    };
  }

  try {
    const result = await finalizeCloudSource(sourceId, userId, db, options);
    await releaseCloudFinalizeLease(db, sourceId, userId, leaseToken);
    return result;
  } catch (error) {
    // A timeout can reach the caller before PostgreSQL has finished cancelling
    // the statement. Keep the claim until TTL so a poll retry cannot enter the
    // locks still owned by that abandoned request. Permanent errors release the
    // lease immediately and retain the endpoint's existing error semantics.
    if (!isTransientCloudFinalizeError(error)) {
      await releaseCloudFinalizeLease(db, sourceId, userId, leaseToken);
    }
    throw error;
  }
}

function isTransientCloudFinalizeError(error: unknown) {
  const details = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : String(details.message ?? error);
  const diagnostic = `${message} ${JSON.stringify(details)}`;
  return (error instanceof HttpError && error.status === 503)
    || /resource|timeout|timing out|upstream server|compute|deadlock|lock|statement|canceling|57014/i.test(diagnostic);
}

async function claimCloudFinalizeLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
  ttlMs: number,
) {
  const { data, error } = await db.rpc("norva_claim_source_finalize_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: Math.max(30, Math.ceil(ttlMs / 1000)),
  });
  return !error && data === true;
}

async function releaseCloudFinalizeLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
) {
  await db.rpc("norva_release_source_finalize_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
  });
}

async function pruneCatalogGenerationBeforeReady(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generation: ActiveCatalogGeneration,
) {
  const { data, error } = await db.rpc("norva_prune_catalog_generation_before_ready", {
    p_source_id: sourceId,
    p_user_id: userId,
    ...catalogGenerationRpcFence(generation),
    p_limit: 200,
  });
  if (error) throwDb(error, "Unable to prove catalog prune before ready");
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  const returned = recordOrEmpty(result.writeSnapshot ?? result.write_snapshot);
  const nextSnapshot = {
    generationId: stringOr(returned.generationId ?? returned.generation_id, ""),
    headRevision: String(returned.headRevision ?? returned.head_revision ?? ""),
    configRevision: String(returned.configRevision ?? returned.config_revision ?? ""),
    sourceVisibilityEpoch: String(
      returned.sourceVisibilityEpoch ?? returned.source_visibility_epoch ?? "",
    ),
    userVisibilityEpoch: String(
      returned.userVisibilityEpoch ?? returned.user_visibility_epoch ?? "",
    ),
  };
  if (
    !nextSnapshot.generationId || !nextSnapshot.headRevision ||
    !nextSnapshot.configRevision || !nextSnapshot.sourceVisibilityEpoch ||
    !nextSnapshot.userVisibilityEpoch ||
    nextSnapshot.generationId !== generation.generationId ||
    nextSnapshot.headRevision !== generation.headRevision ||
    nextSnapshot.configRevision !== generation.configRevision ||
    nextSnapshot.sourceVisibilityEpoch !== generation.sourceVisibilityEpoch
  ) {
    throw new CatalogGenerationSupersededError("Catalog access changed during ready prune");
  }
  generation.userVisibilityEpoch = nextSnapshot.userVisibilityEpoch;
  return {
    catalogVersion: Number(result.catalogVersion) || 0,
    deletedRows: Math.max(0, Number(result.deletedRows) || 0),
    complete: result.complete === true,
  };
}

async function finalizeCloudSource(sourceId: string, userId: string, db: SupabaseClient, options: FinalizeCloudSourceOptions) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");
  const versionedCatalog = stringOr(source.source_type, "") === "xtream";
  const generation = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);

  const baseHint = recordOrEmpty(source.config_hint);
  const existingProgress = recordOrEmpty(baseHint.syncProgress);
  const startedAt = stringOr(existingProgress.startedAt ?? source.last_synced_at, new Date().toISOString());
  const phase = normalizeFinalizePhase(options.phase);
  // Preserve an in-flight pre-rollout live-first cursor. New cinema-first runs
  // publish moviesReady/seriesReady, so the order remains explicit without
  // widening the persisted finalize-cursor schema during a rolling deploy.
  const legacyLiveFirst = usesLegacyLiveFirstFinalize(phase, existingProgress);
  const batchLimit = Math.max(1, Math.min(2000, options.limit || 1000));
  const batchOffset = Math.max(0, options.offset || 0);
  const batchAfterId = stringOr(options.afterId, "");
  const counts = await countSourceItems(sourceId, userId, db, generation, existingProgress);
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
    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
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

    if (phase === "live" || phase === "live_channels" || phase === "live_variants") {
      const totalVod = counts.movies + counts.series;
      // Match the durable finalizer: large provider lists must not create a
      // multi-thousand-row materialization transaction in a client isolate.
      const LIVE_CHUNK = 10;
      if (batchOffset === 0) {
        await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
        const cleared = await clearLiveMaterialization(db, sourceId, userId, generation);
        if (!cleared.complete) {
          return {
            sourceId, status: "syncing", phase: "live",
            nextPhase: "live", nextOffset: 0, limit: LIVE_CHUNK, totalVod, ...result,
            liveCatalog: {
              rawLive: counts.live,
              clearing: true,
              deletedRows: cleared.deletedRows,
              callerProtocol: cleared.callerProtocol,
            },
          };
        }
      }
      if (counts.live <= 0) {
        await reportProgress({
          liveReady: true,
        });
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: legacyLiveFirst && totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, liveReady: true,
          ...result,
          liveCatalog: { rawLive: 0, logicalChannels: 0, liveVariants: 0, skipped: true },
        };
      }
      // Materialise the live catalogue in bounded chunks: a 50k+ channel list
      // can't be loaded + name-parsed whole in one isolate (it exceeds the edge
      // compute limit). Walk live rows by offset, clearing once at the start;
      // channels/variants merge across chunks by their logical/stream keys.
      const liveChunk = await loadSourceItems(sourceId, userId, db, generation, {
        itemTypes: ["live"], offset: batchOffset, limit: LIVE_CHUNK,
      });
      if (!liveChunk.length) {
        await reportProgress({
          stage: "finalizing",
          percent: 99,
          liveReady: true,
          steps: { finalize: { status: "running" } },
        });
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: legacyLiveFirst && totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, liveReady: true,
          ...result,
          liveCatalog: { rawLive: counts.live, done: true },
        };
      }
      const mat = await materializeLiveChunk(db, {
        sourceId, userId, rows: liveChunk,
        country: options.country || stringOr(config.country, "FR"),
        generation,
      });
      const nextOffset = batchOffset + liveChunk.length;
      await reportProgress({
        stage: "building_live_channels",
        percent: Math.max(91, Math.min(99, 91 + Math.round((8 * nextOffset) / Math.max(1, counts.live)))),
        liveReady: true,
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId, status: "syncing", phase: "live",
        nextPhase: "live", nextOffset, limit: LIVE_CHUNK, totalVod, liveReady: true, ...result,
        liveCatalog: { ...mat, rawLive: counts.live, offset: nextOffset },
      };
    }

    if (phase === "titles") {
      const totalVod = counts.movies + counts.series;
      const rows = await loadSourceItems(sourceId, userId, db, generation, {
        itemTypes: ["movie", "series"],
        afterId: batchAfterId,
        limit: batchLimit,
      });
      const sourceType = stringOr(source.source_type, "");
      const rcTitles = await getRuntimeConfig(db);
      const titleProjection = await refreshVodTitleProjection({
        sourceId,
        userId,
        rows,
        db,
        generation,
        xtreamConfig: sourceType === "xtream" && config.serverUrl && config.username && config.password
          ? {
            serverUrl: normalizeBaseUrl(stringOr(config.serverUrl, "")),
            username: typeof config.username === "string" && config.username.trim() ? config.username : "",
            password: typeof config.password === "string" && config.password.length ? config.password : "",
          }
          : null,
        mediaGatewayUrl: rcTitles.mediaGatewayUrl,
        mediaGatewayToken: rcTitles.mediaGatewayToken,
        directFallbackLease: {
          db,
          sourceId,
          userId,
          ownerScope: "cloud-title-projection",
          configCiphertext: String(source.config_ciphertext ?? ""),
          configRevision: generation.configRevision,
        },
        vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_FINALIZE_LIMIT"), 0, 0, 1000),
        // Onboarding B: small inline enrichment → fast release; crons + reuse + bar fill the rest.
        // Defer TMDB validation to the background crons — at huge-catalogue scale
        // it's hundreds of inline lookups; titles still appear from provider data.
        tmdbValidateLimit: boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_FINALIZE_LIMIT"), 0, 0, 1000),
        assertSourceCurrent: () => assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation),
      });
      const nextOffset = Math.min(totalVod, batchOffset + rows.length);
      const nextAfterId = rows.length ? String((rows[rows.length - 1] as { id?: unknown }).id ?? batchAfterId) : batchAfterId;
      // Keyset walk identical to norva-source-sync (advance by id) so a cursor handed
      // off between engines stays consistent and a keyset position is never re-applied
      // as a raw offset. Cap the done-comparison at PostgREST's 1000-row response
      // limit so batchLimit >= 1000 never reads a capped page as "short" and stops early.
      const pageCap = Math.min(batchLimit, 1000);
      const done = rows.length === 0 || rows.length < pageCap;
      // Movies and Series unlock independently as soon as their first projected
      // page is available. The finalizer still walks the complete cinema catalog
      // before beginning Live TV, so no provider lane can starve the other.
      const thresholds = titleUnlockThresholds(totalVod);
      const moviesReady = existingProgress.moviesReady === true || counts.movies <= 0 || done || rows.some((row) => row.item_type === "movie");
      const seriesReady = existingProgress.seriesReady === true || counts.series <= 0 || done || rows.some((row) => row.item_type === "series");
      const browseReady = moviesReady || seriesReady;
      const usable = moviesReady && seriesReady && nextOffset >= thresholds.usable;
      await reportProgress({
        stage: done ? "building_live_channels" : "building_titles",
        percent: done ? 90 : titleFinalizePercent(nextOffset, thresholds.usable),
        ...(moviesReady ? { moviesReady: true } : {}),
        ...(seriesReady ? { seriesReady: true } : {}),
        ...(browseReady ? { browseReady: true } : {}),
        ...(usable ? { usable: true } : {}),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "titles",
        nextPhase: done ? (legacyLiveFirst ? "complete" : "live") : "titles",
        nextOffset: done ? 0 : nextOffset,
        nextAfterId: done ? "" : nextAfterId,
        limit: batchLimit,
        totalVod,
        done,
        moviesReady,
        seriesReady,
        browseReady,
        usable,
        ...result,
        titleProjection,
      };
    }

    if (phase !== "complete") throw new HttpError(400, "Invalid catalog finalization phase");

    // Prune only after the complete cinema-first → Live-last walk, immediately
    // before READY, so the fallback engine matches norva-source-sync exactly.
    if (versionedCatalog) {
      const readyPrune = await pruneCatalogGenerationBeforeReady(
        db,
        sourceId,
        userId,
        generation,
      );
      await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
      if (!readyPrune.complete) {
        await reportProgress({
          stage: "finalizing",
          percent: 99,
          moviesReady: true,
          seriesReady: true,
          liveReady: true,
          browseReady: true,
          usable: true,
          steps: { finalize: { status: "running" } },
        });
        return {
          sourceId,
          status: "syncing",
          phase: "complete",
          nextPhase: "complete",
          nextOffset: batchOffset,
          nextAfterId: batchAfterId,
          moviesReady: true,
          seriesReady: true,
          liveReady: true,
          browseReady: true,
          usable: true,
          readyPrune,
          ...result,
        };
      }
    }

    // Safety net (mirrors norva-source-sync): a client-driven titles phase can stop
    // early and leave verified titles without playable variants (they vanish from
    // genre rails). Heal them before marking ready, so this fallback engine never
    // declares a partial catalog "ready" with missing variants.
    try {
      await db.rpc("heal_cloud_title_variants", {
        p_user_id: userId,
        p_source_id: sourceId,
        ...catalogGenerationRpcFence(generation),
      });
    } catch (healError) {
      if (isCatalogGenerationSuperseded(healError)) throw healError;
      console.warn("[norva-cloud] variant heal failed:", healError instanceof Error ? healError.message : healError);
    }

    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
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
    if (isCatalogGenerationSuperseded(error)) {
      return { sourceId, status: "superseded", generationId: generation.generationId };
    }
    try {
      await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
    } catch (_) {
      return { sourceId, status: "superseded", generationId: generation.generationId };
    }
    const message = formatSourceSyncError(error, "Source finalization failed");
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
  return "titles";
}

function usesLegacyLiveFirstFinalize(phase: string, progress: JsonRecord) {
  const hasCinemaFirstMarker = Object.prototype.hasOwnProperty.call(progress, "moviesReady")
    || Object.prototype.hasOwnProperty.call(progress, "seriesReady");
  if (hasCinemaFirstMarker) return false;
  return phase === "live" || (phase === "titles" && progress.liveReady === true);
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
  if (phase === "complete") return 99;
  return liveFinalizePercent("live", offset, counts.live);
}

function liveFinalizePercent(phase: string, offset: number, total: number) {
  const ratio = total ? Math.max(0, Math.min(1, offset / total)) : 1;
  if (phase === "live_channels") return Math.max(91, Math.min(95, Math.round(91 + ratio * 4)));
  if (phase === "live_variants") return Math.max(95, Math.min(99, Math.round(95 + ratio * 4)));
  return Math.max(91, Math.min(99, Math.round(91 + ratio * 8)));
}

function titleUnlockThresholds(totalVod: number) {
  const browse = boundedInt(Deno.env.get("NORVA_BROWSE_TITLE_THRESHOLD"), 80, 0, 200000);
  const usable = boundedInt(Deno.env.get("NORVA_USABLE_TITLE_THRESHOLD"), 2000, 0, 200000);
  return {
    browse: browse > 0 ? Math.min(totalVod, browse) : totalVod,
    usable: usable > 0 ? Math.min(totalVod, usable) : totalVod,
  };
}

function titleFinalizePercent(offset: number, totalVod: number) {
  // Band aligned with norva-source-sync (74 -> 90) so the same physical progress
  // shows the same % whichever engine drives finalize.
  if (!totalVod) return 90;
  const ratio = Math.max(0, Math.min(1, offset / totalVod));
  return Math.max(74, Math.min(90, Math.round(74 + ratio * 16)));
}

async function countRowsByType(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
  itemType: string,
) {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("generation_id", generation.generationId)
    .eq("item_type", itemType);
  if (error) throwDb(error, `Unable to count ${itemType} catalog items`);
  return count ?? 0;
}

async function countRowsInTable(
  table: string,
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
) {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("generation_id", generation.generationId);
  if (error) throwDb(error, `Unable to count ${table}`);
  return count ?? 0;
}

async function existingLiveMaterializationCounts(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
) {
  const [logicalChannels, liveVariants] = await Promise.all([
    countRowsInTable("cloud_live_logical_channels", sourceId, userId, db, generation),
    countRowsInTable("cloud_live_variants", sourceId, userId, db, generation),
  ]);
  return { logicalChannels, liveVariants };
}

async function countSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
  progress: JsonRecord = {},
) {
  // Prefer the counts the import already persisted (instant): an exact count(*)
  // over a huge source can exceed the 8s statement budget on a busy DB. Fall back
  // to counting only when no trustworthy persisted total exists (e.g. legacy rows).
  const persisted = recordOrEmpty(progress.counts);
  const pLive = Number(persisted.live), pMovies = Number(persisted.movies), pSeries = Number(persisted.series);
  let live: number, movies: number, series: number;
  if (Number(persisted.total) > 0 && [pLive, pMovies, pSeries].every(Number.isFinite)) {
    live = pLive || 0; movies = pMovies || 0; series = pSeries || 0;
  } else {
    [live, movies, series] = await Promise.all([
      countRowsByType(sourceId, userId, db, generation, "live"),
      countRowsByType(sourceId, userId, db, generation, "movie"),
      countRowsByType(sourceId, userId, db, generation, "series"),
    ]);
  }
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
  afterId?: string;
};

async function loadSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
  options: LoadSourceItemsOptions = {},
): Promise<LiveCatalogItem[]> {
  const rows: LiveCatalogItem[] = [];
  const pageSize = options.limit ? Math.max(1, Math.min(2000, options.limit)) : 1000;
  const maxRows = options.limit ? pageSize : Number.POSITIVE_INFINITY;
  // Keyset mode (WHERE id > afterId, ORDER BY id) when an afterId is supplied —
  // identical to norva-source-sync's loadSourceItems, so a finalize cursor is
  // portable between the two engines (the client falls back from one to the other
  // on a 5xx). Offset mode is kept for the live phase + other callers.
  const keyset = typeof options.afterId === "string";
  let afterId = options.afterId || "";
  for (let offset = Math.max(0, options.offset ?? 0); rows.length < maxRows; offset += pageSize) {
    let query = db
      .from("cloud_media_items")
      .select("id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("generation_id", generation.generationId);
    const itemTypes = (options.itemTypes || []).filter(Boolean);
    if (itemTypes.length === 1) query = query.eq("item_type", itemTypes[0]);
    else if (itemTypes.length > 1) query = query.in("item_type", itemTypes);

    if (keyset) {
      query = query.order("id", { ascending: true }).limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
    } else {
      query = query
        .order("item_type", { ascending: true })
        .order("external_id", { ascending: true })
        .range(offset, offset + pageSize - 1);
    }

    const { data, error } = await query;
    if (error) throwDb(error, "Unable to load imported catalog items");
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...(data as LiveCatalogItem[]));
    if (keyset) afterId = String((data[data.length - 1] as { id?: unknown }).id ?? "");
    if (data.length < pageSize) break;
    if (options.limit) break;
  }
  return Number.isFinite(maxRows) ? rows.slice(0, maxRows) : rows;
}

async function syncM3uSource(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
  reportProgress: SyncProgressReporter = async () => {},
  heartbeat: () => Promise<void> = async () => {},
) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  await reportProgress({
    stage: "connecting",
    percent: 10,
    steps: { connect: { status: "running" } },
  });
  await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
  const playlist = playlistUrl === DISCOVERY_PLAYLIST_URL
    ? await fetchDiscoverySelection({ heartbeat })
    : await fetchM3uItems(playlistUrl, 60_000, {
      maxBytes: 128 * 1024 * 1024,
      maxItems: 100_000,
    });
  await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
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
  const items = playlist.items as M3uPlaylistItem[];
  const rows: JsonRecord[] = [];
  for (let index = 0; index < items.length; index += 500) {
    await heartbeat();
    const chunk = await Promise.all(items.slice(index, index + 500).map(async (item) => ({
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
      ...discoveryCatalogFields(playlistUrl, item),
    })));
    rows.push(...chunk);
  }

  const movieCount = rows.filter(row => row.item_type === "movie").length;
  const liveCount = rows.length - movieCount;
  const categoryCount = new Set(rows.map((row) => stringOr(row.parent_external_id, "")).filter(Boolean)).size;
  await reportProgress({
    stage: "importing",
    percent: 62,
    counts: { live: liveCount, movies: movieCount, series: 0, total: rows.length },
    categories: { live: liveCount ? categoryCount : 0, movies: movieCount ? categoryCount : 0, series: 0, total: categoryCount },
    steps: {
      channels: { status: "done", count: liveCount },
      movies: { status: "done", count: movieCount },
      categories: { status: "done", count: categoryCount },
      import: { status: "running", count: rows.length },
    },
  });
  const savedRows = await replaceSourceItems(
    sourceId,
    userId,
    rows,
    db,
    generation,
    heartbeat,
    playlistUrl === DISCOVERY_PLAYLIST_URL,
  );
  await reportProgress({
    stage: "finalizing",
    percent: 86,
    steps: { import: { status: "done", count: savedRows.length }, finalize: { status: "running" } },
  });
  const liveCatalog = await refreshMaterializedLiveCatalog(db, {
    sourceId, userId, rows: savedRows.filter(row => row.item_type === "live"), generation, heartbeat,
  });
  if (movieCount > 0) {
    await refreshVodTitleProjection({
      sourceId, userId, db, generation,
      rows: savedRows.filter(row => row.item_type === "movie"),
      xtreamConfig: null, vodInfoLimit: 0, tmdbValidateLimit: 0,
      assertSourceCurrent: () => assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation),
    });
  }
  return {
    live: liveCount,
    movies: movieCount,
    total: rows.length,
    liveCatalog,
    discoverySources: "sources" in playlist ? playlist.sources : undefined,
    importTruncated: playlist.truncated || undefined,
    importLimitReason: playlist.truncated ? playlist.truncationReason : undefined,
  };
}

async function replaceSourceItems(
  sourceId: string,
  userId: string,
  rows: JsonRecord[],
  db: SupabaseClient,
  generation: ActiveCatalogGeneration,
  heartbeat: () => Promise<void> = async () => {},
  preserveUntilSaved = false,
): Promise<LiveCatalogItem[]> {
  const savedRows: LiveCatalogItem[] = [];
  const catalogVersion = preserveUntilSaved ? Date.now() : null;
  await heartbeat();
  if (!preserveUntilSaved) await clearCatalogGenerationMediaItems(db, sourceId, userId, generation, heartbeat);
  for (let index = 0; index < rows.length; index += 500) {
    await heartbeat();
    const chunk = withCatalogGenerationRows(rows.slice(index, index + 500).map(row =>
      preserveUntilSaved ? { ...row, catalog_version: catalogVersion } : row
    ), generation);
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,generation_id,item_type,external_id" })
      .select("id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available");
    if (error) throwDb(error, "Unable to save cloud media items");
    if (Array.isArray(data)) savedRows.push(...data as LiveCatalogItem[]);
  }
  if (preserveUntilSaved) {
    for (let guard = 0; guard < 600; guard += 1) {
      await heartbeat();
      const { data, error } = await db.rpc("norva_prune_stale_catalog_generation_items", {
        p_source_id: sourceId, p_user_id: userId,
        ...catalogGenerationRpcFence(generation),
        p_catalog_version: catalogVersion, p_limit: 100,
      });
      if (error) throwDb(error, "Unable to prune obsolete Selection items");
      const removed = Number(Array.isArray(data) ? data[0] : data) || 0;
      if (removed < 100) break;
      if (guard === 599) throw new Error("Selection prune exceeded its bounded batch budget");
    }
  }
  return savedRows;
}

async function clearCatalogGenerationMediaItems(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generation: ActiveCatalogGeneration,
  heartbeat: () => Promise<void> = async () => {},
) {
  for (let guard = 0; guard < 100; guard += 1) {
    await heartbeat();
    const { data, error } = await db.rpc("norva_delete_catalog_generation_items_batch", {
      p_source_id: sourceId,
      p_user_id: userId,
      ...catalogGenerationRpcFence(generation),
      p_limit: 2000,
    });
    if (error) throwDb(error, "Unable to clear old catalog items");
    const removed = Number(Array.isArray(data) ? data[0] : data) || 0;
    if (removed < 2000) return;
  }
  throw new Error("Catalog generation clear exceeded its bounded batch budget");
}

async function listMediaItems(url: URL, userId: string, db: SupabaseClient) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");
  const search = url.searchParams.get("q");
  const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 1000);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 100000);

  let query = db
    .from("cloud_catalog_visible_media_items")
    .select(MEDIA_ITEM_PUBLIC_SELECT)
    .eq("user_id", userId)
    .range(offset, offset + limit - 1)
    .order("title", { ascending: true });

  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list media items");
  return { items: (data ?? []).map(sanitizeMediaItem) };
}

async function getXtreamSeriesInfo(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  const visibleSource = await visibleSourceSnapshot(sourceId, userId, db);
  const configRevision = sourceSnapshotConfigRevision(visibleSource);
  const seriesId = url.searchParams.get("series_id") ?? url.searchParams.get("seriesId") ?? "";
  if (!seriesId) throw new HttpError(400, "series_id is required");

  const loadedSource = await loadSourceConfigEnvelope(sourceId, userId, db);
  const sourceConfig = loadedSource.config;
  const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
  const username = typeof sourceConfig.username === "string" && sourceConfig.username.trim()
    ? sourceConfig.username : "";
  const password = typeof sourceConfig.password === "string" && sourceConfig.password.length
    ? sourceConfig.password : "";
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
      const info = sanitizeXtreamSeriesInfo(
        await requestGatewaySeriesInfo(runtimeConfig, { serverUrl, username, password, seriesId }),
        { knownSecrets: [username, password] },
      ) as JsonRecord;
      await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
      return info;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-cloud] gateway series-info unavailable, falling back to direct", status);
    }
  }

  const info = sanitizeXtreamSeriesInfo(await withExistingXtreamDirectFallback(
    {
      db,
      sourceId,
      userId,
      ...await buildProviderDirectFallbackSnapshot({
        serverUrl,
        username,
        configCiphertext: loadedSource.configCiphertext,
        configRevision,
      }),
    },
    "cloud-series-info",
    20_000,
    async () => {
      const payload = await fetchJson(
        xtreamApiUrl({ serverUrl, username, password, action: "get_series_info" }, { series_id: seriesId }),
        20_000,
      );
      // Keep A's lease until the final snapshot check: a transition must not
      // commit between the last provider byte and our ABA verdict.
      await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
      return payload;
    },
  ), { knownSecrets: [username, password] }) as JsonRecord;

  await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
  return info;
}

async function getXtreamShortEpg(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  const visibleSource = await visibleSourceSnapshot(sourceId, userId, db);
  const configRevision = sourceSnapshotConfigRevision(visibleSource);
  const streamId = url.searchParams.get("stream_id") ?? url.searchParams.get("streamId") ?? "";
  const limit = String(boundedInt(url.searchParams.get("limit"), 8, 1, 24));
  if (!streamId) throw new HttpError(400, "stream_id is required");

  const loadedSource = await loadSourceConfigEnvelope(sourceId, userId, db);
  const sourceConfig = loadedSource.config;
  const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
  const username = typeof sourceConfig.username === "string" && sourceConfig.username.trim()
    ? sourceConfig.username : "";
  const password = typeof sourceConfig.password === "string" && sourceConfig.password.length
    ? sourceConfig.password : "";
  if (!serverUrl || !username || !password) {
    throw new HttpError(400, "Short EPG requires an Xtream source");
  }

  const runtimeConfig = await getRuntimeConfig(db);
  const gatewayRequest = { serverUrl, username, password, streamId, limit };
  const cleanShortEpg = (payload: unknown) => sanitizeXtreamShortEpg(
    payload,
    { knownSecrets: [username, password] },
  ) as JsonRecord;
  const directFallbackSnapshot = await buildProviderDirectFallbackSnapshot({
    serverUrl,
    username,
    configCiphertext: loadedSource.configCiphertext,
    configRevision,
  });
  const directEpg = (action: string, timeoutMs: number, params: Record<string, string>) =>
    withExistingXtreamDirectFallback(
      { db, sourceId, userId, ...directFallbackSnapshot },
      "cloud-short-epg",
      timeoutMs,
      async () => {
        const payload = await fetchJson(
          xtreamApiUrl({ serverUrl, username, password, action }, params),
          timeoutMs,
        );
        await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
        return payload;
      },
    );
  const shortEpg = runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken
    ? cleanShortEpg(await requestGatewayXtreamEpg(runtimeConfig, { ...gatewayRequest, action: "get_short_epg" }).catch(async (error) => {
      if (error instanceof HttpError && (error.status === 404 || error.status === 405 || error.status === 503)) {
        return await directEpg("get_short_epg", 12_000, { stream_id: streamId, limit });
      }
      throw error;
    }))
    : cleanShortEpg(await directEpg("get_short_epg", 12_000, { stream_id: streamId, limit }));
  if (epgPayloadHasCurrentOrFuture(shortEpg)) {
    await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
    return shortEpg;
  }

  const simpleTable = runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken
    ? cleanShortEpg(await requestGatewayXtreamEpg(runtimeConfig, { ...gatewayRequest, action: "get_simple_data_table" }).catch(() => shortEpg))
    : cleanShortEpg(await directEpg("get_simple_data_table", 15_000, { stream_id: streamId }).catch(() => shortEpg));
  const result = epgPayloadHasListings(simpleTable) ? simpleTable : shortEpg;
  await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
  return result;
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
  // Check before consulting the in-memory EPG cache: a source hidden after the
  // cache was filled must stop returning listings immediately.
  const visibleSource = await visibleSourceSnapshot(sourceId, userId, db);
  const beforeHours = boundedInt(url.searchParams.get("beforeHours") ?? url.searchParams.get("windowBeforeHours"), 2, 0, 24);
  const afterHours = boundedInt(url.searchParams.get("afterHours") ?? url.searchParams.get("windowAfterHours"), 8, 1, 48);
  const refresh = url.searchParams.get("refresh") === "1";
  const now = Date.now();
  const windowStartMs = now - beforeHours * 60 * 60 * 1000;
  const windowEndMs = now + afterHours * 60 * 60 * 1000;
  const bucketStart = Math.floor(windowStartMs / EPG_WINDOW_BUCKET_MS) * EPG_WINDOW_BUCKET_MS;
  const bucketEnd = Math.ceil(windowEndMs / EPG_WINDOW_BUCKET_MS) * EPG_WINDOW_BUCKET_MS;
  // A same-source credential transition increments config_revision. Keeping it
  // in the key prevents the new login from inheriting XMLTV cached under the
  // previous provider configuration.
  const configRevision = sourceSnapshotConfigRevision(visibleSource);
  const cacheKey = `${userId}:${sourceId}:config:${configRevision}:${bucketStart}:${bucketEnd}`;
  const cached = epgCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > now) {
    await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
    return cached.data;
  }

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
  let xtreamDirectEpg = false;
  let xtreamDirectFallback: DirectFallbackLeaseContext | null = null;
  if (sourceType === "xtream") {
    const serverUrl = normalizeBaseUrl(stringOr(sourceConfig.serverUrl, ""));
    const username = typeof sourceConfig.username === "string" && sourceConfig.username.trim()
      ? sourceConfig.username : "";
    const password = typeof sourceConfig.password === "string" && sourceConfig.password.length
      ? sourceConfig.password : "";
    if (!serverUrl || !username || !password) {
      throw new HttpError(400, "Xtream EPG requires server URL, username and password");
    }
    epgUrl = xtreamXmltvUrl({ serverUrl, username, password });
    xtreamDirectEpg = true;
    xtreamDirectFallback = {
      db,
      sourceId,
      userId,
      ...await buildProviderDirectFallbackSnapshot({
        serverUrl,
        username,
        configCiphertext: String(source.config_ciphertext),
        configRevision,
      }),
    };
  } else if (sourceType === "epg") {
    epgUrl = stringOr(sourceConfig.epgUrl, "");
    assertHttpUrl(epgUrl);
  } else {
    await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
    return { channels: [], programmes: [], sourceId, generatedAt: new Date().toISOString(), cloud: true };
  }

  const fetchEpgXml = () => fetchText(
    epgUrl,
    45_000,
    EPG_MAX_XML_BYTES,
    providerHeaders("VLC/3.0.20 LibVLC/3.0.20"),
  );
  const xml = xtreamDirectEpg
    ? await withExistingXtreamDirectFallback(
      xtreamDirectFallback!,
      "cloud-xmltv-epg",
      45_000,
      async () => {
        const payload = await fetchEpgXml();
        await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
        return payload;
      },
    )
    : await fetchEpgXml();
  const data = {
    ...parseXmltvWindow(xml, { windowStartMs, windowEndMs, maxProgrammes: EPG_MAX_PROGRAMMES }),
    sourceId,
    generatedAt: new Date().toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    cloud: true,
  };
  await assertVisibleSourceSnapshotCurrent(sourceId, userId, visibleSource, db);
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
  await assertVisibleSource(sourceId, userId, db);
  const generation = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);

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
    .upsert(withCatalogGenerationRows(rows, generation), {
      onConflict: "source_id,generation_id,item_type,external_id",
    })
    .select(MEDIA_ITEM_PUBLIC_SELECT);
  if (error) throwDb(error, "Unable to upsert media items");
  await assertActiveCatalogGenerationCurrent(db, sourceId, userId, generation);
  return { items: (data ?? []).map(sanitizeMediaItem) };
}

async function listFavorites(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  let query = db
    .from("cloud_catalog_visible_favorites")
    .select(FAVORITE_PUBLIC_SELECT)
    .eq("user_id", userId)
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false });

  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("itemType");
  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list favorites");
  return { favorites: (data ?? []).map(sanitizeFavorite) };
}

async function addFavorite(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  const sourceId = stringOr(body.sourceId ?? body.source_id, "");
  const itemType = stringOr(body.itemType ?? body.item_type, "live");
  const itemId = stringOr(body.itemId ?? body.item_id, "");
  if (!sourceId || !itemId) throw new HttpError(400, "sourceId and itemId are required");
  const profileId = await resolveProfileId(req, userId, db);

  const { data, error } = await db
    .rpc("upsert_cloud_favorite_visible", {
      p_user_id: userId,
      p_profile_id: profileId,
      p_source_id: sourceId,
      p_item_type: itemType,
      p_item_id: itemId,
      p_item_name: stringOrNull(body.itemName ?? body.item_name),
      p_item_meta: recordOrEmpty(body.itemMeta ?? body.item_meta),
    })
    .select(FAVORITE_PUBLIC_SELECT)
    .single();
  if (error?.code === "55000") {
    throw new HttpError(409, "This catalog is not currently available", {
      code: "SOURCE_CATALOG_NOT_VISIBLE",
    });
  }
  if (error) throwDb(error, "Unable to save favorite");
  return { favorite: sanitizeFavorite(data) };
}

// Delete a favorite by its logical KEYS (source_id, item_type, item_id) for the
// active profile — so the client can un-favorite in one round-trip instead of
// listing the whole set to resolve the row UUID first. Idempotent: deleting a
// row that isn't there still returns success.
async function deleteFavoriteByKeys(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  const sourceId = stringOr(url.searchParams.get("sourceId") ?? url.searchParams.get("source_id"), "");
  const itemType = stringOr(url.searchParams.get("itemType") ?? url.searchParams.get("item_type"), "live");
  const itemId = stringOr(url.searchParams.get("itemId") ?? url.searchParams.get("item_id"), "");
  if (!sourceId || !itemId) throw new HttpError(400, "sourceId and itemId are required");
  const { error } = await db
    .from("cloud_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("profile_id", profileId)
    .eq("source_id", sourceId)
    .eq("item_type", itemType)
    .eq("item_id", itemId);
  if (error) throwDb(error, "Unable to delete favorite");
  return { success: true };
}

// DELETE /history?sourceId&itemId&itemType — remove a Continue Watching entry by its natural
// keys, one round-trip. Same motif as deleteFavoriteByKeys (the client's old list-then-find
// missed rows written by another device against a 20s-stale cache and "deleted" nothing —
// sync audit 2026-07-17 P2). Also clears the same title's rows orphaned to source_id=null by a
// source renewal, so the card can't resurrect from the fallback read.
async function deleteHistoryByKeys(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  const sourceId = stringOr(url.searchParams.get("sourceId") ?? url.searchParams.get("source_id"), "");
  const itemType = stringOr(url.searchParams.get("itemType") ?? url.searchParams.get("item_type"), "");
  const itemId = stringOr(url.searchParams.get("itemId") ?? url.searchParams.get("item_id"), "");
  if (!itemType || !itemId) throw new HttpError(400, "itemType and itemId are required");
  // sourceId feeds a PostgREST .or() filter string — only a UUID shape may pass.
  if (sourceId && !/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(400, "invalid sourceId");
  let q = db
    .from("cloud_watch_history")
    .delete()
    .eq("user_id", userId)
    .eq("profile_id", profileId)
    .eq("item_type", itemType)
    .eq("item_id", itemId);
  // With a sourceId: that source's row + null-source orphans of the same title.
  // Without: every row of the title on this profile.
  if (sourceId) q = q.or(`source_id.eq.${sourceId},source_id.is.null`);
  const { error } = await q;
  if (error) throwDb(error, "Unable to delete history entry");
  return { success: true };
}

type RatingItemType = "movie" | "series";
type RatingTitleIdentity = {
  titleId: string;
  itemType: RatingItemType;
};
type RatingRow = {
  id?: string | null;
  title_id?: string | null;
  source_id?: string | null;
  item_type?: string | null;
  item_id?: string | null;
  rating?: number | string | null;
  server_revision?: number | string | null;
  updated_at?: string | null;
};

const RATING_CONTRACT_VERSION = 2;
const RATING_LIST_DEFAULT_LIMIT = 250;
const RATING_LIST_MAX_LIMIT = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ratingItemType(value: unknown): RatingItemType;
function ratingItemType(value: unknown, options: { required: false }): RatingItemType | "";
function ratingItemType(
  value: unknown,
  { required = true }: { required?: boolean } = {},
): RatingItemType | "" {
  const normalized = stringOr(value, "").trim().toLowerCase();
  if (!normalized && !required) return "";
  if (normalized !== "movie" && normalized !== "series") {
    throw new HttpError(400, "itemType must be movie or series");
  }
  return normalized;
}

function ratingPublicError(
  status: number,
  message: string,
  code: string,
  correlationId: string,
): HttpError {
  return new HttpError(status, message, { code, correlationId });
}

function ratingErrorCode(error: unknown): string {
  if (error instanceof HttpError && isRecord(error.details)) {
    return stringOr(error.details.code, "");
  }
  if (isRecord(error)) return stringOr(error.code, "");
  return "";
}

function rethrowSanitizedRatingError(
  error: unknown,
  correlationId: string,
  operation: "read" | "write",
): never {
  const databaseCode = ratingErrorCode(error);
  console.error("[norva-cloud][ratings]", {
    correlationId,
    operation,
    databaseCode: databaseCode || undefined,
    name: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
  });

  if (databaseCode === "23503") {
    throw ratingPublicError(
      409,
      "The rating target is no longer available",
      "rating_identity_invalid",
      correlationId,
    );
  }
  if (databaseCode === "22023") {
    throw ratingPublicError(
      400,
      "The rating request is invalid",
      "rating_request_invalid",
      correlationId,
    );
  }
  if (databaseCode.toUpperCase().startsWith("PGRST")) {
    throw ratingPublicError(
      503,
      "Ratings are temporarily unavailable",
      "rating_service_unavailable",
      correlationId,
    );
  }

  if (error instanceof HttpError && error.status < 500) {
    const safeCodes = new Set([
      "ambiguous_title_identity",
      "profile_locked",
      "profile_unavailable",
      "rating_request_invalid",
      "rating_source_not_found",
      "title_identity_unavailable",
    ]);
    throw ratingPublicError(
      error.status,
      error.message,
      safeCodes.has(databaseCode) ? databaseCode : "rating_request_invalid",
      correlationId,
    );
  }

  throw ratingPublicError(
    503,
    "Ratings are temporarily unavailable",
    "rating_storage_unavailable",
    correlationId,
  );
}

function requireRatingUuid(
  value: unknown,
  field: string,
  correlationId: string,
): string {
  const normalized = stringOr(value, "");
  if (!UUID_PATTERN.test(normalized)) {
    throw ratingPublicError(
      400,
      `${field} must be a valid UUID`,
      "rating_request_invalid",
      correlationId,
    );
  }
  return normalized;
}

function ratingRevision(row: RatingRow | null | undefined): number {
  const revision = Number(row?.server_revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function ratingValue(row: RatingRow | null | undefined): -1 | 0 | 1 {
  const value = Number(row?.rating);
  return value === 1 || value === -1 ? value : 0;
}

function ratingTimestamp(row: RatingRow | null | undefined): number {
  const timestamp = Date.parse(stringOr(row?.updated_at, ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// server_revision is the causal authority. updated_at only resolves equal
// revisions (including pre-EXPAND revision-zero rows).
function authoritativeRatingRow(rows: RatingRow[]): RatingRow | null {
  if (!rows.length) return null;
  return [...rows].sort((left, right) =>
    ratingRevision(right) - ratingRevision(left) ||
    ratingTimestamp(right) - ratingTimestamp(left) ||
    stringOr(right.id, "").localeCompare(stringOr(left.id, ""))
  )[0] ?? null;
}

// Resolve a provider alias to Norva's existing logical VOD projection. Several
// source variants of the same work share cloud_titles.id, so the reaction
// follows the title when the selected provider/version changes.
async function resolveRatingTitleIdentity(
  db: SupabaseClient,
  userId: string,
  itemType: RatingItemType,
  itemId: string,
  sourceId: string | null,
): Promise<RatingTitleIdentity | null> {
  let query = db
    .from("cloud_catalog_visible_title_variants")
    .select("title_id,item_type,source_id")
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .eq("external_id", itemId);
  if (sourceId) query = query.eq("source_id", sourceId);

  const { data, error } = await query.limit(sourceId ? 2 : 50);
  if (error) throwDb(error, "Unable to resolve logical title");

  const candidates = (data ?? []) as Array<{
    title_id?: string | null;
    item_type?: string | null;
  }>;
  const titleIds = [...new Set(candidates
    .map((candidate) => stringOrNull(candidate.title_id))
    .filter((id): id is string => Boolean(id)))];

  if (!titleIds.length) return null;
  if (titleIds.length > 1 || (!sourceId && candidates.length >= 50)) {
    // Provider external IDs are not globally unique. Never borrow another
    // source's reaction when a legacy GET omitted sourceId. A saturated capped
    // lookup is conservatively ambiguous because it cannot prove uniqueness.
    throw new HttpError(
      409,
      "sourceId is required because this item id is ambiguous",
      { code: "ambiguous_title_identity" },
    );
  }
  return { titleId: titleIds[0], itemType };
}

async function readExactRating(
  db: SupabaseClient,
  userId: string,
  profileId: string,
  itemType: RatingItemType,
  itemId: string,
  sourceId: string | null,
) {
  const identity = await resolveRatingTitleIdentity(
    db,
    userId,
    itemType,
    itemId,
    sourceId,
  );

  const canonicalPromise = identity
    ? db
      .from("cloud_title_ratings")
      .select("id,title_id,source_id,item_type,item_id,rating,server_revision,updated_at")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .eq("title_id", identity.titleId)
      .order("server_revision", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(200)
    : Promise.resolve({ data: [] as RatingRow[], error: null });

  const legacyPromise = sourceId
    ? db
      .from("cloud_title_ratings")
      .select("id,title_id,source_id,item_type,item_id,rating,server_revision,updated_at")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .eq("source_id", sourceId)
      .eq("item_type", itemType)
      .eq("item_id", itemId)
      .maybeSingle()
    : Promise.resolve({ data: null as RatingRow | null, error: null });

  const [canonicalResult, legacyResult] = await Promise.all([
    canonicalPromise,
    legacyPromise,
  ]);
  if (canonicalResult.error) {
    throwDb(canonicalResult.error, "Unable to read logical rating");
  }
  if (legacyResult.error) {
    throwDb(legacyResult.error, "Unable to read provider rating");
  }

  const deduplicated = new Map<string, RatingRow>();
  for (const row of (canonicalResult.data ?? []) as RatingRow[]) {
    deduplicated.set(stringOr(row.id, crypto.randomUUID()), row);
  }
  const legacyRow = legacyResult.data as RatingRow | null;
  if (legacyRow) {
    deduplicated.set(stringOr(legacyRow.id, "legacy-exact"), legacyRow);
  }

  return {
    identity,
    row: authoritativeRatingRow([...deduplicated.values()]),
  };
}

async function getRating(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const correlationId = crypto.randomUUID();
  try {
    const profileId = await resolveProfileId(req, userId, db);
    const itemType = ratingItemType(
      url.searchParams.get("itemType") ?? url.searchParams.get("item_type"),
      { required: false },
    );
    const itemId = stringOrNull(
      url.searchParams.get("itemId") ?? url.searchParams.get("item_id"),
    );
    const rawSourceId = stringOrNull(
      url.searchParams.get("sourceId") ?? url.searchParams.get("source_id"),
    );
    const sourceId = rawSourceId
      ? requireRatingUuid(rawSourceId, "sourceId", correlationId)
      : null;

    if (itemId) {
      if (!itemType) throw new HttpError(400, "itemType is required with itemId");
      const { identity, row } = await readExactRating(
        db,
        userId,
        profileId,
        itemType,
        itemId,
        sourceId,
      );
      return {
        contractVersion: RATING_CONTRACT_VERSION,
        rating: ratingValue(row),
        revision: ratingRevision(row),
        titleId: identity?.titleId ?? stringOrNull(row?.title_id),
        sourceId,
        itemType,
        itemId,
        correlationId,
      };
    }

    const limit = boundedInt(
      url.searchParams.get("limit"),
      RATING_LIST_DEFAULT_LIMIT,
      1,
      RATING_LIST_MAX_LIMIT,
    );
    let query = db
      .from("cloud_title_ratings")
      .select("id,title_id,source_id,item_type,item_id,rating,server_revision,updated_at")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .order("updated_at", { ascending: false })
      .limit(limit + 1);
    if (itemType) query = query.eq("item_type", itemType);
    const { data, error } = await query;
    if (error) throwDb(error, "Unable to read ratings");

    const rawRows = (data ?? []) as RatingRow[];
    const truncated = rawRows.length > limit;
    const groups = new Map<string, RatingRow[]>();
    for (const row of rawRows.slice(0, limit)) {
      const key = stringOrNull(row.title_id)
        ? `title:${row.title_id}`
        : `legacy:${stringOr(row.source_id, "")}:${stringOr(row.item_type, "")}:${stringOr(row.item_id, "")}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    const ratings = [...groups.values()]
      .map((rows) => authoritativeRatingRow(rows))
      .filter((row): row is RatingRow => Boolean(row))
      .filter((row) => ratingValue(row) !== 0)
      .sort((left, right) => ratingTimestamp(right) - ratingTimestamp(left))
      .map((row) => ({
        titleId: stringOrNull(row.title_id),
        sourceId: stringOrNull(row.source_id),
        itemType: stringOr(row.item_type, ""),
        itemId: stringOr(row.item_id, ""),
        rating: ratingValue(row),
        revision: ratingRevision(row),
        updatedAt: stringOrNull(row.updated_at),
      }));

    return {
      contractVersion: RATING_CONTRACT_VERSION,
      ratings,
      truncated,
      limit,
      correlationId,
    };
  } catch (error) {
    rethrowSanitizedRatingError(error, correlationId, "read");
  }
}

async function setRating(req: Request, userId: string, db: SupabaseClient) {
  const correlationId = crypto.randomUUID();
  try {
    const body = await readJson(req);
    const sourceId = requireRatingUuid(
      body.sourceId ?? body.source_id,
      "sourceId",
      correlationId,
    );
    const itemType = ratingItemType(body.itemType ?? body.item_type);
    const itemId = stringOr(body.itemId ?? body.item_id, "");
    const requestedRating = Number(body.rating);
    if (!itemId) throw new HttpError(400, "itemId is required");
    if (![1, -1, 0].includes(requestedRating)) {
      throw new HttpError(400, "rating must be 1, -1 or 0");
    }

    const hasExpectedRevision =
      Object.prototype.hasOwnProperty.call(body, "expectedRevision") ||
      Object.prototype.hasOwnProperty.call(body, "expected_revision");
    const hasOperationId =
      Object.prototype.hasOwnProperty.call(body, "operationId") ||
      Object.prototype.hasOwnProperty.call(body, "operation_id");
    if (hasExpectedRevision !== hasOperationId) {
      throw new HttpError(
        400,
        "expectedRevision and operationId must be provided together",
      );
    }

    const compatibilityMode = !hasExpectedRevision;
    const rawExpectedRevision = body.expectedRevision ?? body.expected_revision;
    const expectedRevision = compatibilityMode ? null : Number(rawExpectedRevision);
    if (
      !compatibilityMode &&
      (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
    ) {
      throw new HttpError(
        400,
        "expectedRevision must be a non-negative safe integer",
      );
    }
    const operationId = compatibilityMode
      ? crypto.randomUUID()
      : requireRatingUuid(
        body.operationId ?? body.operation_id,
        "operationId",
        correlationId,
      );

    const { data: source, error: sourceError } = await db
      .from("cloud_catalog_visible_sources")
      .select("id")
      .eq("id", sourceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (sourceError) throwDb(sourceError, "Unable to verify rating source");
    if (!source) {
      throw new HttpError(
        404,
        "Rating source not found",
        { code: "rating_source_not_found" },
      );
    }

    const profileId = await resolveProfileId(req, userId, db, { mutation: true });
    const identity = await resolveRatingTitleIdentity(
      db,
      userId,
      itemType,
      itemId,
      sourceId,
    );
    if (!identity) {
      throw new HttpError(
        409,
        "Logical title identity is not ready; refresh the catalogue and retry",
        { code: "title_identity_unavailable" },
      );
    }

    // A neutral rating remains a revision tombstone. Deleting it would let a
    // delayed older intent resurrect a cleared reaction.
    const { data, error } = await db.rpc("upsert_cloud_title_rating_cas", {
      p_user_id: userId,
      p_profile_id: profileId,
      p_title_id: identity.titleId,
      p_source_id: sourceId,
      p_item_type: identity.itemType,
      p_item_id: itemId,
      p_rating: requestedRating,
      p_operation_id: operationId,
      p_expected_revision: expectedRevision,
      p_compatibility_mode: compatibilityMode,
    });
    if (error) throwDb(error, "Unable to save rating");
    const row = (Array.isArray(data) ? data[0] : data) as {
      rating?: number | string;
      revision?: number | string;
      applied?: boolean;
      conflict?: boolean;
      idempotent?: boolean;
      compatibility_mode?: boolean;
    } | null;
    const revision = Number(row?.revision);
    if (
      !row ||
      ![1, -1, 0].includes(Number(row.rating)) ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw new HttpError(503, "Invalid rating storage response");
    }

    return {
      contractVersion: RATING_CONTRACT_VERSION,
      rating: Number(row.rating),
      revision,
      applied: row.applied === true,
      conflict: row.conflict === true,
      idempotent: row.idempotent === true,
      compatibilityMode: row.compatibility_mode === true,
      operationId,
      titleId: identity.titleId,
      correlationId,
    };
  } catch (error) {
    rethrowSanitizedRatingError(error, correlationId, "write");
  }
}

function strictOptionalSourceReference(
  primary: unknown,
  secondary: unknown,
  label: string,
): string | null {
  const supplied = [primary, secondary].filter((value) => value !== undefined && value !== null && value !== "");
  if (!supplied.length) return null;
  if (supplied.some((value) => typeof value !== "string")) {
    throw new HttpError(400, `${label} must be a valid UUID`);
  }
  const normalized = supplied.map((value) => String(value).trim()).filter(Boolean);
  if (!normalized.length) return null;
  if (new Set(normalized).size !== 1 || !UUID_PATTERN.test(normalized[0])) {
    throw new HttpError(400, `${label} must be one exact source UUID`);
  }
  return normalized[0];
}

function storedHistoryDataSourceReference(value: unknown): { sourceId: string | null; invalid: boolean } {
  if (!isRecord(value)) return { sourceId: null, invalid: false };
  const supplied = [value.sourceId, value.source_id]
    .filter((entry) => entry !== undefined && entry !== null && entry !== "");
  if (!supplied.length) return { sourceId: null, invalid: false };
  if (supplied.some((entry) => typeof entry !== "string")) return { sourceId: null, invalid: true };
  const normalized = supplied.map((entry) => String(entry).trim()).filter(Boolean);
  if (!normalized.length) return { sourceId: null, invalid: false };
  if (new Set(normalized).size !== 1 || !UUID_PATTERN.test(normalized[0])) {
    return { sourceId: null, invalid: true };
  }
  return { sourceId: normalized[0], invalid: false };
}

function normalizeHistoryRowForVisibility(
  value: unknown,
  visibleSourceIds: Set<string>,
): JsonRecord | null {
  if (!isRecord(value)) return null;
  const row = { ...value } as JsonRecord;
  const topLevelSourceId = stringOrNull(row.source_id);
  const embedded = storedHistoryDataSourceReference(row.data);
  if (topLevelSourceId) {
    if (!visibleSourceIds.has(topLevelSourceId)) return null;
    const data = { ...recordOrEmpty(row.data), sourceId: topLevelSourceId };
    delete data.source_id;
    row.data = data;
    return row;
  }
  if (embedded.invalid) return null;
  if (embedded.sourceId) {
    if (!visibleSourceIds.has(embedded.sourceId)) return null;
    const data = { ...recordOrEmpty(row.data), sourceId: embedded.sourceId };
    delete data.source_id;
    row.source_id = embedded.sourceId;
    row.data = data;
    return row;
  }
  const data = { ...recordOrEmpty(row.data) };
  delete data.sourceId;
  delete data.source_id;
  row.data = data;
  return row;
}

async function loadLegacyNullHistoryData(
  userId: string,
  profileId: string,
  itemType: string,
  itemId: string,
  updatedAt: unknown,
  db: SupabaseClient,
) {
  let query = db
    .from("cloud_watch_history")
    .select("data,updated_at")
    .eq("user_id", userId)
    .eq("profile_id", profileId)
    .eq("item_type", itemType)
    .eq("item_id", itemId)
    .is("source_id", null);
  if (typeof updatedAt === "string" && updatedAt) query = query.eq("updated_at", updatedAt);
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throwDb(error, "Unable to validate legacy history source");
  return data ? recordOrEmpty(data.data) : null;
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
  if (sourceId && !UUID_PATTERN.test(sourceId)) throw new HttpError(400, "invalid sourceId");

  const cols = "source_id,item_type,item_id,progress_seconds,duration_seconds,completed,updated_at";
  // The requested source visibility and the exact/null-source fallback are
  // evaluated by one database statement. A hidden source therefore returns no
  // row instead of accidentally borrowing an orphaned legacy resume position.
  const { data, error } = await db
    .rpc("get_cloud_watch_history_item_visible", {
      p_user_id: userId,
      p_profile_id: profileId,
      p_source_id: sourceId,
      p_item_type: itemType,
      p_item_id: itemId,
    })
    .select(cols)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load history item");
  if (!data) return { item: null };

  const visibleSourceIds = await listVisibleSourceIds(userId, db);
  const candidate = { ...(data as JsonRecord) };
  if (!candidate.source_id) {
    const legacyData = await loadLegacyNullHistoryData(
      userId,
      profileId,
      itemType,
      itemId,
      candidate.updated_at,
      db,
    );
    if (!legacyData) return { item: null };
    candidate.data = legacyData;
  }
  const visible = normalizeHistoryRowForVisibility(candidate, visibleSourceIds);
  if (!visible || (sourceId && visible.source_id && visible.source_id !== sourceId)) return { item: null };
  // The targeted resume contract intentionally returns progress only. The raw
  // legacy data was loaded solely to validate its embedded source reference.
  visible.data = {};
  return { item: sanitizeWatchHistory(visible) };
}

async function listHistory(req: Request, url: URL, userId: string, db: SupabaseClient) {
  const profileId = await resolveProfileId(req, userId, db);
  const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 5_000);
  const itemType = stringOrNull(url.searchParams.get("itemType") ?? url.searchParams.get("item_type"));
  const visibleSourceIds = await listVisibleSourceIds(userId, db);

  // PostgREST commonly caps one response at 1,000 rows. Walk bounded 500-row
  // windows inside the edge function so old cards keep their true watch state.
  // Every page is selected from the visibility projection itself: no separate
  // source-id snapshot can race a Provider Access hide/promotion.
  const data: JsonRecord[] = [];
  const pageSize = 500;
  const maxRowsToInspect = Math.max(pageSize, Math.min(20_000, limit * 4));
  for (let offset = 0; data.length < limit && offset < maxRowsToInspect; offset += pageSize) {
    let query = db
      .from("cloud_catalog_visible_watch_history")
      .select(WATCH_HISTORY_PUBLIC_SELECT)
      .eq("user_id", userId)
      .eq("profile_id", profileId);
  // Cross-device "recent live channels" reuse this table with item_type='live'.
  // A default history read (Continue Watching) must NOT surface those as resumable
  // titles — so exclude 'live' unless it is explicitly requested (?itemType=live).
    if (itemType) query = query.eq("item_type", itemType);
    else query = query.neq("item_type", "live");
    const { data: page, error } = await query
      .order("updated_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throwDb(error, "Unable to list history");
    data.push(
      ...((page ?? []) as JsonRecord[])
        .map((row) => normalizeHistoryRowForVisibility(row, visibleSourceIds))
        .filter((row): row is JsonRecord => Boolean(row)),
    );
    if ((page?.length ?? 0) < pageSize) break;
  }

  // Orphan handling (Layer 1): hide resume cards for movies the provider has since dropped
  // from its catalogue — the "Continue Watching shows a media that 404s on click" problem.
  // Gated on a STABLY-synced source (sync_status ready/completed) so a mid-sync empty-catalogue
  // window can never hide a still-valid resume, and the underlying row is preserved untouched
  // so the card returns automatically if the title comes back. Scoped to movies, whose
  // history item_id maps 1:1 to cloud_media_items.external_id (series history is not keyed the
  // same way, so it is left untouched). Fail-safe: any error keeps every item.
  const sources = await listHistorySources(userId, db);
  const stableSourceIds = new Set(
    sources.filter((s) => s.status === "ready" || s.status === "completed").map((s) => s.id),
  );
  const history = await pruneUnavailableHistory(data.slice(0, limit), userId, stableSourceIds, db);
  return { history: history.map(sanitizeWatchHistory) };
}

async function listHistorySources(userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id,sync_status,sync_error,last_synced_at")
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to list history sources");

  return (data ?? [])
    .filter((source: Record<string, unknown>) => {
      if (source.sync_error) return false;
      const status = String(source.sync_status || "").toLowerCase();
      return status === "ready" || status === "completed" || Boolean(source.last_synced_at);
    })
    .map((source: Record<string, unknown>) => ({
      id: String(source.id),
      status: String(source.sync_status || "").toLowerCase(),
    }))
    .filter((s) => Boolean(s.id));
}

// Drop history entries for movies whose specific stream no longer exists in the catalogue
// (provider removed it). Only movies on a stably-synced source are eligible; everything else
// passes through unchanged. On any DB error we return the rows untouched (never hide a card
// because of a transient read failure).
async function pruneUnavailableHistory(
  rows: Array<Record<string, unknown>>,
  userId: string,
  stableSourceIds: Set<string>,
  db: SupabaseClient,
) {
  const eligible = (r: Record<string, unknown>) =>
    String(r.item_type) === "movie" &&
    r.source_id != null &&
    stableSourceIds.has(String(r.source_id)) &&
    r.item_id != null && String(r.item_id) !== "";

  const candidates = rows.filter(eligible);
  if (!candidates.length) return rows;

  // Batch existence checks per source: which external_ids are still in the catalogue.
  const present = new Set<string>(); // `${source_id}:${external_id}`
  const idsBySource = new Map<string, Set<string>>();
  for (const r of candidates) {
    const sid = String(r.source_id);
    const set = idsBySource.get(sid) ?? new Set<string>();
    set.add(String(r.item_id));
    idsBySource.set(sid, set);
  }
  for (const [sid, idSet] of idsBySource) {
    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data, error } = await db
        .from("cloud_catalog_visible_media_items")
        .select("external_id")
        .eq("user_id", userId)
        .eq("source_id", sid)
        .eq("item_type", "movie")
        .in("external_id", chunk);
      if (error) return rows; // fail-safe: keep everything on any read error
      for (const row of data ?? []) present.add(`${sid}:${String((row as Record<string, unknown>).external_id)}`);
    }
  }

  return rows.filter((r) => {
    if (!eligible(r)) return true;
    return present.has(`${String(r.source_id)}:${String(r.item_id)}`);
  });
}

async function saveHistory(req: Request, userId: string, db: SupabaseClient) {
  const body = await readJson(req);
  let sourceId = strictOptionalSourceReference(body.sourceId, body.source_id, "sourceId");
  const rawHistoryData = recordOrEmpty(body.data);
  if (!sourceId) {
    sourceId = strictOptionalSourceReference(
      rawHistoryData.sourceId,
      rawHistoryData.source_id,
      "data.sourceId",
    );
  }
  const itemType = stringOr(body.itemType ?? body.item_type ?? body.type, "");
  const itemId = stringOr(body.itemId ?? body.item_id ?? body.id, "");
  if (!itemType || !itemId) throw new HttpError(400, "itemType and itemId are required");
  if (sourceId) await assertVisibleSource(sourceId, userId, db);
  const profileId = await resolveProfileId(req, userId, db);
  const historyData = sanitizeHistoryData(rawHistoryData) as JsonRecord;
  delete historyData.source_id;
  if (sourceId) historyData.sourceId = sourceId;
  else delete historyData.sourceId;

  const incomingDuration = boundedInt(body.durationSeconds ?? body.duration_seconds ?? body.duration, 0, 0, 10_000_000);
  const incomingProgress = boundedInt(body.progressSeconds ?? body.progress_seconds ?? body.progress, 0, 0, 10_000_000);

  // Every client stamps when the position was CAPTURED. The database RPC compares
  // that timestamp atomically inside INSERT .. ON CONFLICT, so two devices racing
  // cannot let the later-arriving but older packet regress progress. A deliberate
  // backward seek is still accepted because its capture time is newer.
  const incomingWatchedAt = stringOrNull(body.watchedAt ?? body.watched_at);
  const receivedAtMs = Date.now();
  const incomingWatchedAtMs = incomingWatchedAt ? Date.parse(incomingWatchedAt) : 0;
  // Never let a device with a fast/malicious clock freeze every other device
  // behind a far-future value. Past capture times remain meaningful; any future
  // value is clamped to this server's receipt time.
  const capturedAt = new Date(
    incomingWatchedAtMs > 0 ? Math.min(incomingWatchedAtMs, receivedAtMs) : receivedAtMs,
  ).toISOString();

  // `completed` is the manual "mark watched" flag: preserved when the save doesn't mention it
  // (heartbeats used to reset it to false on every tick). The RPC applies the
  // ≥60s real-rewatch rule atomically against the winning row.
  const completed = body.completed !== undefined ? Boolean(body.completed) : null;

  const row = {
    user_id: userId,
    profile_id: profileId,
    source_id: sourceId,
    item_type: itemType,
    item_id: itemId,
    parent_item_id: stringOrNull(body.parentItemId ?? body.parent_item_id),
    item_name: stringOrNull(body.itemName ?? body.item_name ?? body.name),
    progress_seconds: incomingProgress,
    // Zero means "not supplied"; the RPC keeps the existing known duration.
    duration_seconds: incomingDuration,
    completed,
    data: historyData,
    watched_at: capturedAt,
  };

  const { data, error } = await db.rpc("upsert_cloud_watch_history_causal", {
    p_user_id: row.user_id,
    p_profile_id: row.profile_id,
    p_source_id: row.source_id,
    p_item_type: row.item_type,
    p_item_id: row.item_id,
    p_parent_item_id: row.parent_item_id,
    p_item_name: row.item_name,
    p_progress_seconds: row.progress_seconds,
    p_duration_seconds: row.duration_seconds,
    p_completed: row.completed,
    p_data: row.data,
    p_watched_at: row.watched_at,
  })
    .select(WATCH_HISTORY_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to save history");

  // Account busy-lock writer (2026-07-10 458 incident, docs/LIVE-TV-458-SLOT-CONTENTION.md):
  // the ~10s watch-progress save IS the live heartbeat — refresh the provider ACCOUNT's
  // activity signal so autonomous probes yield the single connection slot to this viewer.
  // Best-effort: bookkeeping must never fail the save.
  try {
    if (sourceId) await db.rpc("provider_account_touch_by_source", { p_source_id: sourceId, p_kind: "history" });
  } catch (_) { /* best-effort */ }

  return { item: sanitizeWatchHistory(data) };
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
    .select(PLAYBACK_EVENT_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to record playback event");

  // Account busy-lock writer (twin of norva-playback recordPlaybackEvent) — device-fallback path.
  try {
    if (sourceId) await db.rpc("provider_account_touch_by_source", { p_source_id: sourceId, p_kind: "event" });
  } catch (_) { /* best-effort */ }

  if (sourceId && ttff && (eventType === "first_frame" || eventType === "play_started")) {
    await recordPlaybackStartupObservation(db, { userId, sourceId, itemType, itemId, startupMs: ttff });
  }

  return { event: sanitizePlaybackEvent(data) };
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

  const { data, error } = await db
    .from("cloud_pairing_sessions")
    .insert(row)
    .select("id,code,status,expires_at")
    .single();
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
    .select("id,status,expires_at,device_type,device_name,platform,app_version,device_public_key,device_capabilities,pairing_secret_hash")
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
    .select(PAIRING_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to approve pairing");
  return { pairing: sanitizePairing(data), device: sanitizeCloudDevice(device) };
}

async function listCommands(url: URL, userId: string, db: SupabaseClient) {
  const deviceId = url.searchParams.get("deviceId");
  let query = db
    .from("cloud_cast_commands")
    .select(CAST_COMMAND_PUBLIC_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (deviceId) query = query.eq("target_device_id", deviceId);
  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list commands");
  return { commands: (data ?? []).map(sanitizeCastCommand) };
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
    .select(CAST_COMMAND_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to queue command");
  return { command: sanitizeCastCommand(data) };
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
    .select(CAST_COMMAND_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to update command");
  return { command: sanitizeCastCommand(data) };
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
  return { device: sanitizeCloudDevice(data) };
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
    .select(CAST_COMMAND_PUBLIC_SELECT)
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
  return { commands: (data ?? []).map(sanitizeCastCommand) };
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
    .select(CAST_COMMAND_PUBLIC_SELECT)
    .single();
  if (error) throwDb(error, "Unable to update device command");
  return { command: sanitizeCastCommand(data) };
}

async function createPlaybackSession(
  _req: Request,
  _userId: string,
  _db: SupabaseClient,
  _defaultDeviceId: string | null = null,
): Promise<never> {
  // Compatibility tombstone: all creation must pass through norva-playback's
  // owned-target resolution, provider circuit and atomic account claim.
  throw new HttpError(410, "Playback session creation has moved to norva-playback", {
    code: "PLAYBACK_CREATION_MOVED",
  });
}

async function getPlaybackSession(id: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_playback_sessions")
    .select(`${PLAYBACK_SESSION_PUBLIC_SELECT},cloud_gateway_sessions(id,playback_session_id,mode,status,hls_url,expires_at,created_at,updated_at)`)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load playback session");
  if (!data) throw new HttpError(404, "Playback session not found");
  return { session: publicPlaybackSession(data) };
}

function publicPlaybackSession(value: unknown): JsonRecord {
  return sanitizePlaybackSession(value);
}

async function expirePlaybackSession(id: string, userId: string, db: SupabaseClient) {
  // Resolve every gateway identifier only after proving that this playback
  // session belongs to the authenticated user. The service-role client must
  // never accept caller-provided gateway IDs.
  const { data: session, error } = await db
    .from("cloud_playback_sessions")
    .select("id,source_id,cloud_gateway_sessions(id,external_session_id)")
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
  let rawPumpsAborted = 0;

  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    // A signed /raw pipe has no cloud_gateway_sessions row. Abort it by the
    // authenticated owner's hash plus the already-authorized playback ID.
    try {
      const ownerKey = await sha256Hex(userId);
      const rawUrl = new URL(`${runtimeConfig.mediaGatewayUrl}/raw-pumps`);
      rawUrl.searchParams.set("ownerKey", ownerKey);
      rawUrl.searchParams.set("sid", id);
      const rawResponse = await fetch(rawUrl.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}` },
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
        .eq("user_id", userId)
        .eq("playback_session_id", id)
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
    gatewayErrors: gatewayErrors.length,
  };
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
    lockTtlMs: EDGE_SESSION_COORDINATOR_LOCK_TTL_MS,
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
    return {
      status: "pending",
      session: data,
      hlsUrl: null,
      startupMs: null,
      audioStreamIndex: boundedNullableInt(
        playbackHint.audioStreamIndex ?? playbackHint.audio_stream_index,
        0,
        1024,
      ),
      requestedSeekOffset: 0,
      actualStartOffset: 0,
      localSeekTarget: 0,
      sourceTimestamps: false,
    };
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
  const audioStreamIndex = boundedNullableInt(
    gatewayBody.audioStreamIndex ??
      gatewayBody.audio_stream_index ??
      playbackHint.audioStreamIndex ??
      playbackHint.audio_stream_index,
    0,
    1024,
  );
  const requestedSeekOffset = boundedNullableNumber(
    gatewayBody.requestedSeekOffset ??
      gatewayBody.requested_seek_offset ??
      gatewayBody.seekOffset ??
      gatewayBody.seek_offset ??
      seekOffset,
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
  return {
    status: data.status,
    session: data,
    hlsUrl: data.hls_url,
    startupMs,
    codecProfile,
    audioStreamIndex,
    requestedSeekOffset,
    actualStartOffset,
    localSeekTarget,
    sourceTimestamps,
  };
}

async function recordPlaybackStartupObservation(
  db: SupabaseClient,
  options: { userId: string; sourceId: string; itemType: string; itemId: string; startupMs: number },
) {
  const itemType = options.itemType === "series" ? "series" : options.itemType === "movie" ? "movie" : "";
  if (!itemType || !options.itemId || !Number.isFinite(options.startupMs) || options.startupMs <= 0) return;

  try {
    const generation = await readActiveCatalogGenerationSnapshot(db, options.sourceId, options.userId);
    await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
    const cost = Math.max(1, Math.min(999, Math.round(options.startupMs / 10)));
    const { error } = await db
      .from("cloud_title_variants")
      .update({
        last_observed_ttff_ms: Math.round(options.startupMs),
        playback_cost_score: cost,
        ...catalogGenerationFields(generation),
      })
      .eq("user_id", options.userId)
      .eq("source_id", options.sourceId)
      .eq("generation_id", generation.generationId)
      .eq("item_type", itemType)
      .eq("external_id", options.itemId);
    if (error) {
      if (isCatalogGenerationSuperseded(error)) return;
      if (!isProjectionMissing(error)) {
        console.warn("[norva-cloud] unable to record playback startup observation", error.message);
      }
      return;
    }
    await assertActiveCatalogGenerationCurrent(db, options.sourceId, options.userId, generation);
  } catch (error) {
    if (!isCatalogGenerationSuperseded(error)) {
      console.warn(
        "[norva-cloud] unable to record playback startup observation",
        error instanceof Error ? error.message : "catalog observation write failed",
      );
    }
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
      || !stringOr(row.container_extension, "")
    ) {
      return null;
    }
    if (parentSeriesId && stringOr(row.parent_series_id, "") !== parentSeriesId) {
      throw new HttpError(409, "Episode does not belong to the requested parent series");
    }
    return row;
  } catch (error) {
    if (error instanceof HttpError) throw error;
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
  exactEpisodeCoordinates: JsonRecord | null = null,
) {
  await assertVisibleSource(sourceId, userId, db);
  if (exactEpisodeCoordinates) {
    const sourceConfig = await loadSourceConfig(sourceId, userId, db);
    return xtreamStreamUrl({
      serverUrl: stringOr(sourceConfig.serverUrl, ""),
      username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
        ? sourceConfig.username : "",
      password: typeof sourceConfig.password === "string" && sourceConfig.password.length
        ? sourceConfig.password : "",
      streamType: "series",
      streamId: stringOr(exactEpisodeCoordinates.episode_id, ""),
      container: stringOr(exactEpisodeCoordinates.container_extension, "mp4"),
    });
  }
  const { data: item, error } = await db
    .from("cloud_catalog_visible_media_items")
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
        username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
          ? sourceConfig.username : "",
        password: typeof sourceConfig.password === "string" && sourceConfig.password.length
          ? sourceConfig.password : "",
        streamType: "series",
        streamId: itemId,
        container: stringOr(requestHint.container, "mp4"),
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
      username: typeof sourceConfig.username === "string" && sourceConfig.username.trim()
        ? sourceConfig.username : "",
      password: typeof sourceConfig.password === "string" && sourceConfig.password.length
        ? sourceConfig.password : "",
      streamType,
      streamId: stringOr(hint.streamId, ""),
      container: xtreamPlaybackContainer(hint, streamType),
    });
  }

  throw new HttpError(400, "This media item has no playback target");
}

async function loadSourceConfig(sourceId: string, userId: string, db: SupabaseClient) {
  return (await loadSourceConfigEnvelope(sourceId, userId, db)).config;
}

async function loadSourceConfigEnvelope(sourceId: string, userId: string, db: SupabaseClient) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("config_ciphertext")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source config");
  if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
  const configCiphertext = String(source.config_ciphertext);
  return {
    config: await decryptSourceConfig(configCiphertext, await getRuntimeConfig(db)),
    configCiphertext,
  };
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

async function fetchJson(url: string, timeoutMs: number, maxBytes = 8 * 1024 * 1024) {
  try {
    const { response, value: payload } = await fetchBoundedProviderJson(url, {
      timeoutMs,
      maxBytes,
      headers: providerHeaders(),
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw boundedProviderHttpError(error, "JSON");
  }
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
    if (!response.ok) {
      const payloadRecord = recordOrEmpty(payload);
      const payloadDetails = recordOrEmpty(payloadRecord.details);
      const rawCode = stringOr(payloadRecord.code, "").trim().toUpperCase();
      const rawNetworkCause = stringOr(
        payloadDetails.networkCause ?? payloadDetails.network_cause,
        "",
      ).trim().toLowerCase();
      const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
        ? rawCode
        : response.status === 504
          ? "PROVIDER_RESPONSE_TIMEOUT"
          : "PROVIDER_REQUEST_FAILED";
      const safeNetworkCause = /^[a-z][a-z0-9_]{0,63}$/.test(rawNetworkCause)
        ? rawNetworkCause
        : "provider";
      throw new HttpError(response.status, "Media gateway refused the metadata request", {
        code: response.status === 458 ? "PROVIDER_BUSY" : safeCode,
        networkCause: safeNetworkCause,
        upstreamStatus: response.status,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const failure = classifyGatewayNetworkFailure(error);
    throw new HttpError(
      failure.code === "PROVIDER_RESPONSE_TIMEOUT" ? 504 : 502,
      "Unable to reach media gateway",
      failure,
    );
  } finally {
    clearTimeout(timer);
  }
}

function classifyGatewayNetworkFailure(error: unknown): { code: string; networkCause: string } {
  const errorRecord = recordOrEmpty(error);
  const causeRecord = recordOrEmpty(errorRecord.cause);
  const normalized = stringOr(
    causeRecord.code,
    stringOr(errorRecord.code, error instanceof Error ? error.name : ""),
  ).trim().toUpperCase();

  if (normalized === "ABORTERROR" || normalized === "UND_ERR_HEADERS_TIMEOUT") {
    return { code: "PROVIDER_RESPONSE_TIMEOUT", networkCause: "timeout" };
  }
  if (normalized === "UND_ERR_CONNECT_TIMEOUT" || normalized === "ETIMEDOUT") {
    return { code: "PROVIDER_CONNECT_TIMEOUT", networkCause: "timeout" };
  }
  if (normalized === "ECONNRESET" || normalized === "UND_ERR_SOCKET" || normalized === "EPIPE") {
    return { code: "PROVIDER_CONNECTION_RESET", networkCause: "connection_reset" };
  }
  if (normalized === "ENOTFOUND" || normalized === "EAI_AGAIN") {
    return { code: "PROVIDER_DNS_FAILURE", networkCause: "dns" };
  }
  if (normalized === "ENETUNREACH" || normalized === "EHOSTUNREACH" || normalized === "ECONNREFUSED") {
    return { code: "PROVIDER_NETWORK_UNREACHABLE", networkCause: "network_unreachable" };
  }
  if (/CERT|TLS|SSL/.test(normalized)) {
    return { code: "PROVIDER_TLS_FAILURE", networkCause: "tls" };
  }
  return { code: "PROVIDER_REQUEST_FAILED", networkCause: "network" };
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number, headers = providerHeaders()) {
  try {
    const { response, value: text } = await fetchBoundedProviderText(url, {
      timeoutMs,
      maxBytes,
      headers,
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw boundedProviderHttpError(error, "text");
  }
}

async function fetchTextPrefix(url: string, timeoutMs: number, maxBytes: number, headers = providerHeaders()) {
  try {
    const { response, value: text, truncated } = await fetchBoundedProviderTextPrefix(url, {
      timeoutMs,
      maxBytes,
      headers,
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return { text, truncated };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw boundedProviderHttpError(error, "playlist preview");
  }
}

async function fetchM3uItems(
  url: string,
  timeoutMs: number,
  limits: { maxBytes: number; maxItems: number },
) {
  try {
    const result = await fetchM3uPlaylistStream(url, {
      timeoutMs,
      maxBytes: limits.maxBytes,
      maxItems: limits.maxItems,
      headers: providerHeaders(),
    });
    if (!result.response.ok) throw new HttpError(result.response.status, "IPTV provider request failed");
    if (!result.headerDetected) throw new HttpError(400, "This URL does not look like a valid M3U playlist");
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw boundedProviderHttpError(error, "playlist");
  }
}

function boundedProviderHttpError(error: unknown, payloadType: string) {
  if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
    return new HttpError(413, `Provider ${payloadType} payload is too large for this cloud request`);
  }
  if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
    return new HttpError(504, "IPTV provider response deadline exceeded");
  }
  return new HttpError(502, "Unable to reach IPTV provider");
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

async function sourceCatalogVisible(sourceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db.rpc("norva_source_catalog_visible", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) throwDb(error, "Unable to verify catalog visibility");
  return data === true;
}

async function visibleSourceSnapshot(sourceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id,config_revision")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify catalog visibility");
  if (data) return data as JsonRecord;
  throw new HttpError(409, "This catalog is not currently available", {
    code: "SOURCE_CATALOG_NOT_VISIBLE",
  });
}

function sourceSnapshotConfigRevision(snapshot: JsonRecord) {
  const revision = stringOr(snapshot.config_revision, "");
  if (!/^\d+$/.test(revision)) {
    throw new HttpError(503, "Source configuration revision is unavailable");
  }
  return revision.replace(/^0+(?=\d)/, "");
}

async function assertVisibleSourceSnapshotCurrent(
  sourceId: string,
  userId: string,
  expected: JsonRecord,
  db: SupabaseClient,
) {
  let current: JsonRecord;
  try {
    current = await visibleSourceSnapshot(sourceId, userId, db);
  } catch (error) {
    if (error instanceof HttpError && recordOrEmpty(error.details).code === "SOURCE_CATALOG_NOT_VISIBLE") {
      throw cloudCatalogChanged();
    }
    throw error;
  }
  if (sourceSnapshotConfigRevision(current) !== sourceSnapshotConfigRevision(expected)) {
    throw cloudCatalogChanged();
  }
}

function cloudCatalogChanged() {
  return new HttpError(409, "Catalog access changed while provider metadata was loading", {
    code: "SOURCE_CATALOG_CHANGED",
  });
}

async function sourceConfigRevisionSnapshot(sourceId: string, userId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("cloud_source_lifecycle")
    .select("config_revision")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify source configuration revision");
  const revision = stringOr(data?.config_revision, "");
  if (!revision || !/^\d+$/.test(revision)) {
    throw new HttpError(503, "Source configuration revision is unavailable");
  }
  return revision;
}

async function assertSourceConfigRevisionCurrent(
  sourceId: string,
  userId: string,
  expectedRevision: string,
  db: SupabaseClient,
) {
  const currentRevision = await sourceConfigRevisionSnapshot(sourceId, userId, db);
  if (currentRevision !== expectedRevision) {
    throw new HttpError(409, "Source configuration changed while the connection was being checked", {
      code: "SOURCE_CONFIG_REVISION_CHANGED",
    });
  }
}

async function assertVisibleSource(sourceId: string, userId: string, db: SupabaseClient) {
  if (await sourceCatalogVisible(sourceId, userId, db)) return;
  throw new HttpError(409, "This catalog is not currently available", {
    code: "SOURCE_CATALOG_NOT_VISIBLE",
  });
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
  // Soft-delete: mark the source removed (instant, one row) so it leaves the user's list right away
  // and stops re-syncing. The heavy per-user child cascade — hundreds of thousands of rows for a big
  // panel, with a per-row rollup trigger on cloud_title_variants — is drained by the
  // reap_deleted_sources cron in committed batches. Doing that cascade inline here is exactly what
  // exceeded the request timeout and left the account un-removable. The GLOBAL scan cache
  // (catalog_titles / catalog_file_tracks, keyed by tmdb id / host, no user_id) is never touched:
  // only this user's per-user copy is removed, and a re-added same-host source reuses the cache.
  const { data, error } = await db
    .from("cloud_sources")
    .update({ deleted_at: new Date().toISOString(), auto_refresh_next_at: null })
    .eq("id", sourceId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) throwDb(error, "Unable to delete provider account");

  return {
    body: { success: true, sourceId },
    // A repeated idempotent DELETE updates no row and therefore owns no epoch
    // advance; do not acknowledge a concurrent cutover on its behalf.
    visibilityChanged: Boolean(data?.id),
  };
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

// Phase 2 push: the mobile app's WebView posts its FCM token here (authenticated). Service-role upsert
// into the service-only cloud_push_tokens (keyed by token); the digest sender reads these to push.
async function registerPushToken(req: Request, userId: string, db: SupabaseClient): Promise<JsonRecord> {
  const body = await readJson(req);
  const token = stringOr(body.token, "");
  if (!token || token.length > 4096) throw new HttpError(400, "Missing or invalid push token");
  const platformRaw = String(body.platform ?? "android");
  const platform = ["android", "ios", "web"].includes(platformRaw) ? platformRaw : "android";
  const permissionRaw = String(body.permissionState ?? body.permission_state ?? "unknown").toLowerCase();
  const permissionState = ["unknown", "prompt", "granted", "denied"].includes(permissionRaw)
    ? permissionRaw
    : "unknown";
  const timezone = stringOr(body.timezone, "UTC").slice(0, 64);
  const locale = stringOrNull(body.locale)?.slice(0, 35) ?? null;
  const appVersion = stringOrNull(body.appVersion ?? body.app_version)?.slice(0, 40) ?? null;
  const { data, error } = await db.rpc("norva_register_push_token", {
    p_user_id: userId,
    p_token: token,
    p_platform: platform,
    p_permission_state: permissionState,
    p_timezone: timezone,
    p_locale: locale,
    p_app_version: appVersion,
  });
  if (error) throwDb(error, "Unable to register push token");
  return isRecord(data) ? data : { ok: true, permission_state: permissionState };
}

async function recordBehavioralLifecycleEvent(
  req: Request,
  userId: string,
  db: SupabaseClient,
): Promise<JsonRecord> {
  const body = await readJson(req);
  const allowedKeys = new Set(["deliveryId", "delivery_id", "event"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, "Unsupported lifecycle event field");
  }
  const deliveryId = stringOr(body.deliveryId ?? body.delivery_id, "").trim();
  const event = stringOr(body.event, "").trim().toLowerCase();
  if (event === "source_form_opened" && !deliveryId) {
    const clientContext = sourceAttemptClientContext(req.headers.get("user-agent"));
    const { data, error } = await db.rpc("norva_record_behavioral_product_event", {
      p_user_id: userId,
      p_event_name: event,
      p_platform: clientContext.platform,
      p_app_version: clientContext.appVersion,
      p_event_id: crypto.randomUUID(),
    });
    if (error) throwDb(error, "Unable to record lifecycle product event");
    return { accepted: data === true };
  }
  if (!UUID_PATTERN.test(deliveryId) || !["delivered", "opened", "deep_link_opened"].includes(event)) {
    throw new HttpError(400, "Invalid lifecycle event");
  }
  const { data, error } = await db.rpc("norva_record_behavioral_delivery_event", {
    p_user_id: userId,
    p_delivery_id: deliveryId,
    p_event_kind: event,
  });
  if (error) throwDb(error, "Unable to record lifecycle event");
  return { accepted: data === true };
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
      ...catalogVisibilityEpochHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Same as json() but with a short PRIVATE browser cache. `private` keeps the
// per-user payload out of any shared/CDN cache; Vary on Authorization +
// x-norva-profile-id keys it per token + active profile so a cached response can
// never leak across accounts. Used for the stable boot reads (profile, profiles,
// trial eligibility) that change rarely — repeat navigations and hard reloads
// within the TTL skip the edge function entirely.
function jsonCached(req: Request, data: unknown, cacheSeconds: number, status = 200) {
  const s = Math.max(0, Math.floor(cacheSeconds));
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      ...catalogVisibilityEpochHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": s > 0 ? `private, max-age=${s}, stale-while-revalidate=${s * 2}` : "no-store",
      Vary: "Origin, Authorization, x-norva-profile-id",
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
    // Lets browser JS read the locked-profile fallback signal (resolveProfileId).
    "Access-Control-Expose-Headers": "x-norva-profile-fallback, x-norva-visibility-epoch, x-norva-user-visibility-epoch, x-norva-global-visibility-epoch, x-norva-catalog-cache-contract, retry-after",
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

function publicErrorPayload(error: unknown, status: number): JsonRecord {
  const detailRecord = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  const details = sanitizeCloudErrorDetails(detailRecord);
  const message = status >= 500
    ? "Norva Cloud is temporarily unavailable"
    : error instanceof HttpError
      ? error.message
      : "Request failed";
  return compactRecord({ error: message, details: Object.keys(details).length ? details : undefined });
}

function publicErrorLog(error: unknown, status: number, payload: JsonRecord): JsonRecord {
  const rawDetails = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  const safeDetails = sanitizeCloudErrorDetails(rawDetails);
  return compactRecord({
    status,
    name: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
    code: safeDetails.code,
    publicCode: stringOr(recordOrEmpty(payload.details).code, "") || undefined,
    correlationId: stringOr(recordOrEmpty(payload.details).correlationId, "") || undefined,
  });
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
