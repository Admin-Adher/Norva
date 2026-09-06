import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import { loadSelectionSeriesInfo } from "../_shared/selection-series-info.mjs";
import {
  type ActiveCatalogGeneration,
  assertActiveCatalogGenerationCurrent,
  catalogGenerationRpcFence,
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
import {
  bindCatalogVisibilityEpoch as bindCatalogVisibilityEpochShared,
  catalogVisibilityEpochHeaders,
  finalizeCatalogVisibilityResponse,
} from "../_shared/catalog-visibility-response.mjs";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = {
  sourceConfigKey: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  relayBaseUrl: string;
  relayTokenSecret: string;
};
type CloudIdentity = { userId: string; deviceId?: string };
type SourceAccessSnapshot = ActiveCatalogGeneration;

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const ENV_MEDIA_GATEWAY_URL = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
const ENV_RELAY_BASE_URL = (Deno.env.get("NORVA_RELAY_BASE_URL") ?? "").replace(/\/+$/, "");
const ENV_RELAY_TOKEN_SECRET = Deno.env.get("RELAY_TOKEN_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;

// How long a cached series-info payload is served WITHOUT touching the provider. The
// provider's episode list changes infrequently (new episodes of ongoing series), so a day
// of freshness collapses provider hits to ~1/series/day across ALL users while a stale
// entry is still served on a refresh failure — so a fiche never breaks on a provider 429.
const SERIES_INFO_FRESH_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  return await finalizeCatalogVisibilityResponse(
    req,
    await handleRequest(req),
    supabase,
    { service: "norva-series-info", corsHeaders },
  );
});

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      return json(req, {
        ok: true,
        service: "norva-series-info",
        version: 1,
        exactEpisodeInventory: true,
      });
    }
    if (req.method === "GET" && segments[0] === "sources" && segments[2] === "series-info") {
      const identity = await requireIdentity(req, supabase);
      await bindCatalogVisibilityEpoch(req, identity.userId, supabase);
      const sourceId = segments[1];
      const sourceSnapshot = await assertVisibleSource(sourceId, identity.userId, supabase);
      const seriesId = url.searchParams.get("series_id") ?? url.searchParams.get("seriesId") ?? "";
      // This lookup is response-critical but independent from the provider call. Start it
      // immediately so a cold provider request does not pay another database round trip after
      // the episode payload has arrived.
      const originalLanguagePromise = lookupSeriesOriginalLanguage(supabase, sourceId, seriesId);
      const seriesInfoResult = await getXtreamSeriesInfo(
        url,
        sourceId,
        identity.userId,
        supabase,
        sourceSnapshot,
      );
      const seriesInfo = seriesInfoResult.payload;
      // Augment with the title's TMDB source language (global, from catalog_titles) so the player
      // can resolve a VOSTFR/VO ("original") audio track to its real language. Best-effort; it
      // sits next to the provider payload and never replaces a provider field.
      // Build the server-trusted parent-series -> exact-episode inventory on
      // exact provider fetches. This is deliberately best-effort:
      // a rolling migration must never make a series fiche unavailable, while
      // playback/LID will stay fail-closed for cross-user episode sharing until
      // the corresponding inventory row exists.
      const originalLanguage = await originalLanguagePromise;
      // The provider/cache work above can take tens of seconds. A promotion that
      // hid A during that work must win over this response, even if the payload
      // itself was already fetched and sanitized.
      await assertSourceSnapshotCurrent(sourceId, identity.userId, sourceSnapshot, supabase);
      if (seriesInfoResult.exactInventorySafe) {
        scheduleSeriesEpisodeRegistration(
          supabase,
          identity.userId,
          sourceId,
          seriesId,
          seriesInfo,
          sourceSnapshot,
        );
      }
      return json(req, originalLanguage ? { ...seriesInfo, original_language: originalLanguage } : seriesInfo);
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = publicErrorCode(error);
    const message = status >= 500
      ? "Series details are temporarily unavailable"
      : error instanceof Error ? error.message : "Unexpected error";
    // Provider bodies, database diagnostics and transport exceptions can all be
    // present in HttpError.details. Keep both the response and the log on a
    // strict, stable allowlist.
    console.error("[norva-series-info]", status, code ?? "UNCLASSIFIED");
    return json(req, { error: message, ...(code ? { code } : {}) }, status);
  }
}

const SERIES_INFO_PUBLIC_ERROR_CODES = new Set([
  "SOURCE_CATALOG_NOT_VISIBLE",
  "SOURCE_CATALOG_CHANGED",
  "CATALOG_VISIBILITY_UNAVAILABLE",
  "PROVIDER_DIRECT_FALLBACK_RETRYABLE",
]);

function publicErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpError) || !isRecord(error.details)) return null;
  const code = error.details.code;
  return typeof code === "string" && SERIES_INFO_PUBLIC_ERROR_CODES.has(code) ? code : null;
}

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

async function bindCatalogVisibilityEpoch(req: Request, userId: string, db: SupabaseClient) {
  try {
    await bindCatalogVisibilityEpochShared(req, userId, db);
  } catch (_) {
    console.warn("[norva-series-info] catalog visibility epoch unavailable");
    throw new HttpError(503, "Catalog visibility is temporarily unavailable", {
      code: "CATALOG_VISIBILITY_UNAVAILABLE",
    });
  }
}

function scheduleSeriesEpisodeRegistration(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  parentSeriesId: string,
  payload: JsonRecord,
  expectedSnapshot: SourceAccessSnapshot,
): void {
  // Inventory registration/hydration can involve three fenced RPCs. It must complete for
  // exact playback sharing, but it is not needed to render the episode list. Keep the work
  // alive after the response without adding those RPCs to the cold fiche latency.
  const task = Promise.resolve()
    .then(() => registerSeriesEpisodes(db, userId, sourceId, parentSeriesId, payload, expectedSnapshot))
    .catch((error) => {
      // A source disabled or promoted after the final response guard is an expected abort;
      // every mutation is independently generation-fenced inside registerSeriesEpisodes.
      if (isCatalogAccessGuardError(error) || isCatalogGenerationSuperseded(error)) return;
      console.warn("[norva-series-info] background episode inventory deferred");
    });
  try {
    const runtime = (globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(task);
      return;
    }
  } catch (_) {
    // A detached, already-caught promise is the development-runtime fallback.
  }
  void task;
}

async function registerSeriesEpisodes(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  parentSeriesId: string,
  payload: JsonRecord,
  expectedSnapshot: SourceAccessSnapshot,
): Promise<void> {
  if (!userId || !sourceId || !parentSeriesId || !isRecord(payload)) return;
  try {
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    const { data: episodeCount, error } = await db.rpc("register_catalog_series_episodes", {
      p_user_id: userId,
      p_source_id: sourceId,
      ...catalogGenerationRpcFence(expectedSnapshot),
      p_parent_series_id: parentSeriesId,
      p_payload: payload,
    });
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    if (error) {
      console.warn("[norva-series-info] episode inventory deferred", error.message);
      return;
    }
    const count = Math.max(0, Number(episodeCount) || 0);
    if (count <= 0) return;
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    const { error: hydrateError } = await db.rpc("hydrate_catalog_episode_file_tracks", {
      p_user_id: userId,
      p_source_id: sourceId,
      ...catalogGenerationRpcFence(expectedSnapshot),
      p_parent_series_id: parentSeriesId,
      p_episode_ids: null,
    });
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    if (hydrateError) {
      console.warn("[norva-series-info] episode cache hydration deferred", hydrateError.message);
    }
    const { error: outcomeError } = await db.rpc("record_catalog_series_inventory_outcome", {
      p_user: userId,
      p_source: sourceId,
      ...catalogGenerationRpcFence(expectedSnapshot),
      p_parent_series_id: parentSeriesId,
      p_success: true,
      p_episode_count: count,
      p_retry_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      p_details: { method: "interactive-series-info-v1", status: "registered" },
    });
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    if (outcomeError) {
      console.warn("[norva-series-info] episode inventory outcome deferred", outcomeError.message);
    }
  } catch (error) {
    if (isCatalogAccessGuardError(error) || isCatalogGenerationSuperseded(error)) throw error;
    console.warn(
      "[norva-series-info] episode inventory deferred",
      error instanceof Error ? error.message : error,
    );
  }
}

// Best-effort lookup of the title's TMDB original_language (the global catalog fact behind
// resolving a VOSTFR/VO "original" audio track to its real language). series_id -> the series'
// provider_tmdb_id (cloud_media_items) -> catalog_titles.original_language. Never throws.
async function lookupSeriesOriginalLanguage(
  db: SupabaseClient,
  sourceId: string,
  seriesId: string,
): Promise<string | null> {
  try {
    if (!sourceId || !seriesId) return null;
    const { data: item } = await db
      .from("cloud_catalog_visible_media_items")
      .select("metadata")
      .eq("source_id", sourceId)
      .eq("item_type", "series")
      .eq("external_id", seriesId)
      .maybeSingle();
    const tmdb = item && isRecord(item.metadata)
      ? stringOr((item.metadata as JsonRecord).providerTmdbId, "")
      : "";
    if (!tmdb || !/^\d+$/.test(tmdb)) return null;
    const { data: cat } = await db
      .from("catalog_titles")
      .select("original_language")
      .eq("item_type", "series")
      .eq("provider_tmdb_id", tmdb)
      .maybeSingle();
    const lang = cat && typeof (cat as JsonRecord).original_language === "string"
      ? String((cat as JsonRecord).original_language).toLowerCase().trim()
      : "";
    return /^[a-z]{2,3}$/.test(lang) ? lang : null;
  } catch {
    return null;
  }
}

async function assertVisibleSource(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
): Promise<SourceAccessSnapshot> {
  const { data, error } = await db.rpc("norva_source_catalog_visible", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) throw catalogVisibilityUnavailable();
  if (data !== true) {
    throw new HttpError(409, "This catalog is not currently available", {
      code: "SOURCE_CATALOG_NOT_VISIBLE",
    });
  }
  return await readVisibleSourceSnapshot(sourceId, userId, db, false);
}

async function readVisibleSourceSnapshot(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  changedDuringOperation: boolean,
): Promise<SourceAccessSnapshot> {
  try {
    return await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
  } catch (error) {
    if (isCatalogGenerationSuperseded(error)) {
      throw new HttpError(409, changedDuringOperation
        ? "Catalog access changed while series details were loading"
        : "This catalog is not currently available", {
        code: changedDuringOperation ? "SOURCE_CATALOG_CHANGED" : "SOURCE_CATALOG_NOT_VISIBLE",
      });
    }
    throw catalogVisibilityUnavailable();
  }
}

async function assertSourceSnapshotCurrent(
  sourceId: string,
  userId: string,
  expected: SourceAccessSnapshot,
  db: SupabaseClient,
): Promise<void> {
  try {
    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, expected);
  } catch (error) {
    if (!isCatalogGenerationSuperseded(error)) throw error;
    throw new HttpError(409, "Catalog access changed while series details were loading", {
      code: "SOURCE_CATALOG_CHANGED",
    });
  }
}

function catalogVisibilityUnavailable(): HttpError {
  return new HttpError(503, "Catalog visibility is temporarily unavailable", {
    code: "CATALOG_VISIBILITY_UNAVAILABLE",
  });
}

function isCatalogAccessGuardError(error: unknown): boolean {
  if (!(error instanceof HttpError) || !isRecord(error.details)) return false;
  return [
    "SOURCE_CATALOG_NOT_VISIBLE",
    "SOURCE_CATALOG_CHANGED",
    "CATALOG_VISIBILITY_UNAVAILABLE",
  ].includes(stringOr(error.details.code, ""));
}

function revisionToken(value: unknown): string {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, "");
  }
  return "";
}

async function getXtreamSeriesInfo(
  url: URL,
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  expectedSnapshot: SourceAccessSnapshot,
) {
  const seriesId = url.searchParams.get("series_id") ?? url.searchParams.get("seriesId") ?? "";
  if (!seriesId) throw new HttpError(400, "series_id is required");

  const selection = await loadSelectionSeriesInfo({ db, userId, sourceId, seriesId, generationId: expectedSnapshot.generationId });
  if (selection) {
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    return { payload: selection, exactInventorySafe: false };
  }

  const loadedSource = await loadSourceConfig(sourceId, userId, db, expectedSnapshot);
  const config = loadedSource.config;
  const serverUrl = stringOr(config.serverUrl, "");
  const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
  const password = typeof config.password === "string" && config.password.length ? config.password : "";
  if (!serverUrl || !username || !password) {
    throw new HttpError(400, "Series details require a managed Xtream source");
  }

  // Cross-user cache keyed by (provider host, series_id). get_series_info is identical for
  // every user on the same provider, so the FIRST successful load is served to everyone:
  // while the entry is fresh the provider (which rate-limits hard with user_multi_ip / 429)
  // is never touched, and a later provider failure is masked by serving the cached copy.
  const serverHost = providerHost(serverUrl);
  const cached = serverHost ? await readSeriesInfoCache(db, serverHost, seriesId) : null;
  if (cached && Date.now() - cached.fetchedAt < SERIES_INFO_FRESH_MS) {
    // This legacy cache is keyed by raw host, not canonical provider identity.
    // It is safe to display, but it cannot prove episode ownership for exact
    // cross-account audio sharing.
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    return { payload: cached.payload, exactInventorySafe: false };
  }

  let payload: JsonRecord;
  try {
    payload = await fetchSeriesInfoFromProvider(db, {
      serverUrl, username, password, seriesId, userId, sourceId, serverHost, expectedSnapshot,
    });
  } catch (error) {
    // A lifecycle/config guard is terminal for this request. It must never be
    // disguised as a provider outage and replaced with an A-era stale cache.
    if (isCatalogAccessGuardError(error)) throw error;
    // Provider failed (most often user_multi_ip / 429). If we hold ANY cached copy — even a
    // stale one — serve it rather than failing the fiche; only surface the error when the
    // cache is empty (the unavoidable cold-miss case the client-side retry handles).
    if (cached) {
      console.warn(
        "[norva-series-info] provider fetch failed, serving stale cache",
        error instanceof Error ? error.message : error,
      );
      await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
      return { payload: cached.payload, exactInventorySafe: false };
    }
    throw error;
  }

  // Strip any credential-bearing field before it is returned OR cached. Xtream
  // get_series_info can embed the full user/pass stream URL in `direct_source`; the client
  // never reads it, and this cache is cross-user, so dropping it means one account's
  // credentials can never leak to another via a shared cache entry (or even the response body).
  payload = stripCredentials(payload) as JsonRecord;
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);

  // Cache ONLY a real series-info (episodes or info present). The provider returns {} on a
  // soft block — caching that would poison the entry, so we skip it and keep any prior copy.
  if (serverHost && isCacheableSeriesInfo(payload)) {
    const writeMarker = await writeSeriesInfoCache(db, serverHost, seriesId, payload);
    try {
      await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    } catch (error) {
      if (writeMarker) await discardSeriesInfoCacheWrite(db, serverHost, seriesId, writeMarker);
      throw error;
    }
  }
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  return { payload, exactInventorySafe: true };
}

function providerAccountKey(serverHost: string, username: string): string {
  const exactUsername = String(username || "");
  return exactUsername.trim()
    ? `${String(serverHost || "").trim().toLowerCase()}/${exactUsername}`
    : String(serverHost || "").trim().toLowerCase();
}

function isProviderSlotBusyError(error: unknown): boolean {
  const status = error instanceof HttpError ? error.status : 0;
  const text = [
    error instanceof Error ? error.message : String(error),
    error instanceof HttpError ? JSON.stringify(error.details ?? "") : "",
  ].join(" ");
  return status === 458 || status === 409
    || /(?:\b|_)458\b|already in use|user_multi_ip|max.?conn|account.?busy|account_sharing/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhileBackgroundBusy(db: SupabaseClient, accountKey: string): Promise<void> {
  if (!accountKey || accountKey.endsWith("/")) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data, error } = await db.rpc("provider_account_busy_for_foreground_validation", {
        p_key: accountKey,
      });
      if (error || data !== true) return;
    } catch (_) {
      return;
    }
    await sleep(2000);
  }
}

async function fetchSeriesInfoFromProvider(
  db: SupabaseClient,
  params: {
    serverUrl: string;
    username: string;
    password: string;
    seriesId: string;
    userId: string;
    sourceId: string;
    serverHost?: string;
    expectedSnapshot: SourceAccessSnapshot;
  },
): Promise<JsonRecord> {
  const { serverUrl, username, password, seriesId, userId, sourceId, serverHost, expectedSnapshot } = params;
  const accountKey = providerAccountKey(serverHost || providerHost(serverUrl), username);
  await waitWhileBackgroundBusy(db, accountKey);
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
      const payload = await requestSeriesInfoOnce(db, {
        serverUrl,
        username,
        password,
        seriesId,
        userId,
        sourceId,
        expectedSnapshot,
      });
      await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
      return payload;
    } catch (error) {
      lastError = error;
      if (isCatalogAccessGuardError(error)) throw error;
      // A provider/network failure can race the cutover just as a success can.
      // Re-check before classifying it or falling back to an A-era cache.
      await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
      if (!isProviderSlotBusyError(error) || attempt === 2) throw error;
      await sleep(8000);
    }
  }
  throw lastError instanceof Error ? lastError : new HttpError(502, "Unable to load series details");
}

async function requestSeriesInfoOnce(
  db: SupabaseClient,
  params: {
    serverUrl: string;
    username: string;
    password: string;
    seriesId: string;
    userId: string;
    sourceId: string;
    expectedSnapshot: SourceAccessSnapshot;
  },
): Promise<JsonRecord> {
  const { serverUrl, username, password, seriesId, userId, sourceId, expectedSnapshot } = params;
  const runtimeConfig = await getRuntimeConfig(db);
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);

  // PRIMARY: the Cloudflare relay. The provider user_multi_ip-blocks datacenter IPs — both the
  // Railway media gateway AND this Supabase edge runtime — but accepts Cloudflare, the same
  // egress that streams the video. So series-info is fetched from the relay, the only reliable
  // metadata path. Fall through ONLY on a relay-INFRA failure (route missing / 5xx / timeout):
  // a provider-origin 429/401/403 won't improve on the (also-blocked) gateway, so we surface it
  // and let the caller's stale-cache fallback apply.
  if (runtimeConfig.relayBaseUrl && runtimeConfig.relayTokenSecret) {
    try {
      return recordOrEmpty(
        await requestRelaySeriesInfo(runtimeConfig, { serverUrl, username, password, seriesId, userId }),
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-series-info] relay series-info unavailable, falling back", status);
    }
  }

  // FALLBACK: the media gateway (Railway). Kept for when the relay is unconfigured/unreachable
  // or hasn't yet learned this route. Same provider-error semantics as the relay branch.
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    try {
      return recordOrEmpty(
        await requestGatewaySeriesInfo(runtimeConfig, { serverUrl, username, password, seriesId }),
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-series-info] gateway series-info unavailable, falling back to direct", status);
    }
  }

  // LAST RESORT: a direct fetch from this edge runtime (also a datacenter IP — usually
  // user_multi_ip-blocked, but the cheapest thing left to try).
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  try {
    return recordOrEmpty(await withSourceDirectFallbackLease({
      db,
      sourceId,
      userId,
      owner: providerDirectFallbackLeaseOwner("series-info"),
      ttlSeconds: directFallbackLeaseTtlSeconds(20_000),
      ...await buildProviderDirectFallbackSnapshot({
        serverUrl,
        username,
        configCiphertext: loadedSource.configCiphertext,
        configRevision: expectedSnapshot.configRevision,
      }),
    }, () => fetchJson(
      xtreamApiUrl({ serverUrl, username, password, action: "get_series_info" }, { series_id: seriesId }),
      20_000,
    )));
  } catch (error) {
    if (error instanceof ProviderDirectFallbackLeaseError) {
      throw new HttpError(error.status, error.message, error.details);
    }
    throw error;
  }
}

// Mint a short-lived signed relay token whose `url` claim is the full get_series_info
// player_api.php URL, then fetch it through the relay (Cloudflare egress). Same HMAC token
// shape the relay verifies for /relay/ and /vod-info/. Stateless — no cloud_relay_tokens row
// (those track playback sessions); this is a 120s metadata token verified purely by signature.
async function requestRelaySeriesInfo(
  runtimeConfig: RuntimeConfig,
  body: { serverUrl: string; username: string; password: string; seriesId: string; userId: string },
): Promise<JsonRecord> {
  const apiUrl = xtreamApiUrl(
    { serverUrl: body.serverUrl, username: body.username, password: body.password, action: "get_series_info" },
    { series_id: body.seriesId },
  );
  const token = await signRelayToken(runtimeConfig.relayTokenSecret, {
    sid: `seriesinfo-${body.seriesId}`,
    uid: body.userId || "series-info",
    url: apiUrl,
    ua: "VLC/3.0.20 LibVLC/3.0.20",
    ttlSeconds: 120,
  });
  try {
    const { response, value: payload } = await fetchBoundedProviderJson(
      `${runtimeConfig.relayBaseUrl}/series-info/${token}`,
      {
        timeoutMs: 20_000,
        maxBytes: 8 * 1024 * 1024,
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) {
      throw new HttpError(response.status, "Relay refused the series-info request");
    }
    return recordOrEmpty(payload);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
      throw new HttpError(504, "Unable to reach Norva relay");
    }
    if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
      throw new HttpError(502, "Norva relay returned an invalid series-info response");
    }
    throw new HttpError(502, "Unable to reach Norva relay");
  }
}

async function signRelayToken(
  secret: string,
  claims: { sid: string; uid: string; url: string; ua?: string; ttlSeconds: number },
): Promise<string> {
  const payload = JSON.stringify({
    v: 1,
    sid: claims.sid,
    uid: claims.uid,
    url: claims.url,
    ...(claims.ua ? { ua: claims.ua } : {}),
    exp: Math.floor(Date.now() / 1000) + claims.ttlSeconds,
  });
  const signature = await hmacBase64Url(secret, payload);
  return `${base64Url(encoder.encode(payload))}.${signature}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
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

async function readSeriesInfoCache(
  db: SupabaseClient,
  serverHost: string,
  seriesId: string,
): Promise<{ payload: JsonRecord; fetchedAt: number } | null> {
  try {
    const { data, error } = await db
      .from("cloud_series_info_cache")
      .select("payload, fetched_at")
      .eq("server_host", serverHost)
      .eq("series_id", seriesId)
      .maybeSingle();
    if (error || !data || !isRecord(data.payload)) return null;
    const fetchedAt = Date.parse(String(data.fetched_at));
    return { payload: data.payload as JsonRecord, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
  } catch {
    return null; // the cache is best-effort — never block a fiche on a cache read
  }
}

async function writeSeriesInfoCache(
  db: SupabaseClient,
  serverHost: string,
  seriesId: string,
  payload: JsonRecord,
): Promise<string | null> {
  try {
    const nowIso = new Date().toISOString();
    const { error } = await db.from("cloud_series_info_cache").upsert(
      { server_host: serverHost, series_id: seriesId, payload, fetched_at: nowIso, updated_at: nowIso },
      { onConflict: "server_host,series_id" },
    );
    if (error) {
      console.warn("[norva-series-info] failed to write series-info cache", error.message);
      return null;
    }
    return nowIso;
  } catch (error) {
    console.warn(
      "[norva-series-info] failed to write series-info cache",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function discardSeriesInfoCacheWrite(
  db: SupabaseClient,
  serverHost: string,
  seriesId: string,
  writeMarker: string,
): Promise<void> {
  try {
    // Delete only the exact upsert from this request. A concurrent valid writer
    // changes these timestamps and is therefore preserved.
    await db
      .from("cloud_series_info_cache")
      .delete()
      .eq("server_host", serverHost)
      .eq("series_id", seriesId)
      .eq("fetched_at", writeMarker)
      .eq("updated_at", writeMarker);
  } catch (_) {
    // Best effort: the final response guard still prevents serving this payload.
  }
}

function providerHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function isCacheableSeriesInfo(payload: JsonRecord): boolean {
  const episodes = payload.episodes;
  if (isRecord(episodes) && Object.keys(episodes).length > 0) return true;
  if (Array.isArray(episodes) && episodes.length > 0) return true;
  const info = payload.info;
  if (isRecord(info) && Object.keys(info).length > 0) return true;
  return false;
}

// Recursively drop every `direct_source` key (any depth). On many Xtream panels this field
// carries the full credentialed stream URL (…/series/USER/PASS/123.mkv). The client builds
// playback URLs from the episode id + each user's OWN source, so this field is dead weight —
// and since the cache is cross-user, removing it is what keeps credentials from ever leaking.
function stripCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentials);
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "direct_source") continue;
      out[key] = stripCredentials(child);
    }
    return out;
  }
  return value;
}

async function requestGatewaySeriesInfo(
  runtimeConfig: RuntimeConfig,
  body: { serverUrl: string; username: string; password: string; seriesId: string },
): Promise<JsonRecord> {
  try {
    const { response, value: payload } = await fetchBoundedProviderJson(
      `${runtimeConfig.mediaGatewayUrl}/xtream/series-info`,
      {
        method: "POST",
        timeoutMs: 20_000,
        maxBytes: 8 * 1024 * 1024,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
        },
        body: JSON.stringify({ ...body, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
      },
    );
    if (!response.ok) {
      throw new HttpError(response.status, "Media gateway refused the series-info request");
    }
    return recordOrEmpty(payload);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
      throw new HttpError(504, "Unable to reach media gateway");
    }
    if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
      throw new HttpError(502, "Media gateway returned an invalid series-info response");
    }
    throw new HttpError(502, "Unable to reach media gateway");
  }
}

async function loadSourceConfig(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  expectedSnapshot: SourceAccessSnapshot,
) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("config_ciphertext, source_type")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source config");
  if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
  if (source.source_type !== "xtream") throw new HttpError(400, "Series details require an Xtream source");
  const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  return { config, configCiphertext: String(source.config_ciphertext) };
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  let mediaGatewayUrl = ENV_MEDIA_GATEWAY_URL;
  let mediaGatewayToken = ENV_MEDIA_GATEWAY_TOKEN;
  let relayBaseUrl = ENV_RELAY_BASE_URL;
  let relayTokenSecret = ENV_RELAY_TOKEN_SECRET;
  if (!sourceConfigKey || !mediaGatewayUrl || !mediaGatewayToken || !relayBaseUrl || !relayTokenSecret) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", [
        "NORVA_SOURCE_CONFIG_KEY",
        "NORVA_MEDIA_GATEWAY_URL",
        "NORVA_MEDIA_GATEWAY_TOKEN",
        "NORVA_RELAY_BASE_URL",
        "RELAY_TOKEN_SECRET",
      ]);
    if (error) console.warn("[norva-series-info] runtime config unavailable", error.message);
    for (const item of data ?? []) {
      if (typeof item.value !== "string" || !item.value) continue;
      if (item.key === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = item.value;
      else if (item.key === "NORVA_MEDIA_GATEWAY_URL" && !mediaGatewayUrl) mediaGatewayUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !mediaGatewayToken) mediaGatewayToken = item.value;
      else if (item.key === "NORVA_RELAY_BASE_URL" && !relayBaseUrl) relayBaseUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "RELAY_TOKEN_SECRET" && !relayTokenSecret) relayTokenSecret = item.value;
    }
  }
  const value = { sourceConfigKey, mediaGatewayUrl, mediaGatewayToken, relayBaseUrl, relayTokenSecret };
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

async function fetchJson(url: string, timeoutMs: number) {
  try {
    const { response, value: payload } = await fetchBoundedProviderJson(url, {
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      headers: { "User-Agent": "NorvaCloud/1.0" },
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
      throw new HttpError(413, "Provider JSON payload is too large");
    }
    if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
      throw new HttpError(504, "IPTV provider response deadline exceeded");
    }
    throw new HttpError(502, "Unable to reach IPTV provider");
  }
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Expose-Headers": "x-norva-visibility-epoch, x-norva-user-visibility-epoch, x-norva-global-visibility-epoch, x-norva-catalog-cache-contract",
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
  if (parts[0] === "norva-series-info") parts.shift();
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

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOr(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
