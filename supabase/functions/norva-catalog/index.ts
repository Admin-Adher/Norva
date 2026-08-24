// SELF-HOST DEPLOY NOTE: the Hetzner edge-runtime mounts the complete
// supabase/functions tree, so sibling ../_shared imports stay available. A push
// to main validates this code but does not reload production: update the server
// checkout and run ops/hetzner/scripts/04-deploy-edge-functions.sh.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildLiveCatalog, findLiveChannel, type LiveCatalogItem } from "../_shared/live-catalog.ts";
import { BUCKET_ORDER, bucketLabel } from "../_shared/genre-taxonomy.ts";
import { buildI18nFromTmdbTranslations } from "../_shared/vod-title-projection.ts";
import { verifyUserJwtLocally } from "../_shared/local-auth.ts";
import { getEntitlementDecision, limitNumber } from "../_shared/entitlements.ts";
import {
  bindCatalogVisibilityEpoch as bindCatalogVisibilityEpochShared,
  boundCatalogCacheEpoch,
  boundCatalogVisibilityEpoch,
  catalogVisibilityEpochHeaders,
  finalizeCatalogVisibilityResponse,
  latestBoundCatalogCacheEpoch,
  latestBoundCatalogVisibilityEpoch,
  publicEdgeErrorLog,
  publicEdgeErrorPayload,
} from "../_shared/catalog-visibility-response.mjs";
import {
  sanitizeCatalogMediaItem,
  sanitizeCatalogMediaPayload,
  sanitizeCatalogVariant,
  sanitizeLiveChannel,
  sanitizeLiveCatalogPayload,
  sanitizeLiveVariant,
} from "../_shared/catalog-public-view.mjs";

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
const HOME_RAIL_VARIANT_LIMIT = 10;
// UUID lists are encoded into PostgREST query strings. Keeping these batches
// small prevents genre rails with many selected titles from exceeding proxy URL
// limits before their variants can be materialized.
const TITLE_VARIANT_QUERY_CHUNK = 50;
const VISIBLE_TITLE_ID_PAGE_SIZE = 1_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LIVE_PAGE_SIZE = 1000;
const LIVE_MAX_ROWS = 80000;
const LIVE_SECTION_ORDER = ["primary", "regional", "multiplex", "other"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  return await finalizeCatalogVisibilityResponse(
    req,
    await handleRequest(req),
    db,
    { service: "norva-catalog", corsHeaders },
  );
});

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);

    if (req.method === "GET" && segments[0] === "health") {
      return json(req, {
        ok: true,
        service: "norva-catalog",
        version: 6,
        liveContract: "norva.live.logical.v1",
        materializedLive: true,
        flatCodecProfileProtocol: 1,
      });
    }

    // Background catalog-enrichment progress for the header bar: how many of the user's
    // titles are TMDB-matched (provider_tmdb_id resolved) vs total. Climbs as the
    // enrichment crons run; the client hides the bar once it's essentially complete.
    if (req.method === "GET" && segments[0] === "enrichment-progress") {
      const userId = await requireUserId(req);
      return json(req, await getEnrichmentProgress(req, userId));
    }

    if (req.method === "GET" && isLiveLogicalChannelsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, sanitizeLiveCatalogPayload(await listLiveLogicalChannels(url, userId)));
    }

    if (req.method === "GET" && isLiveChannelVariantsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(
        req,
        sanitizeLiveCatalogPayload(
          await listLiveChannelVariants(url, userId, liveChannelIdFromRoute(segments)),
        ),
      );
    }

    if (req.method === "GET" && isHomeRailsRoute(segments)) {
      const userId = await requireUserId(req);
      return jsonCached(req, sanitizeCatalogMediaPayload(await listHomeRails(req, url, userId)), 60);
    }

    if (req.method === "GET" && (segments[0] === "media-items" || (segments[0] === "device" && segments[1] === "media-items"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, sanitizeCatalogMediaPayload(await listMediaItems(url, userId)), 30);
    }

    if (req.method === "GET" && (segments[0] === "media-categories" || (segments[0] === "device" && segments[1] === "media-categories"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, await listMediaCategories(url, userId), 60);
    }

    if (req.method === "GET" && (segments[0] === "media-genre-rails" || (segments[0] === "device" && segments[1] === "media-genre-rails"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, sanitizeCatalogMediaPayload(await listGenreRails(req, url, userId)), 60);
    }

    if (req.method === "GET" && (segments[0] === "media-genre-items" || (segments[0] === "device" && segments[1] === "media-genre-items"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, sanitizeCatalogMediaPayload(await listGenreItems(req, url, userId)), 30);
    }

    if (req.method === "GET" && (segments[0] === "media-genre-summary" || (segments[0] === "device" && segments[1] === "media-genre-summary"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, await listGenreSummary(req, url, userId), 60);
    }

    if (req.method === "GET" && (segments[0] === "media-language-facets" || (segments[0] === "device" && segments[1] === "media-language-facets"))) {
      const userId = await requireUserId(req);
      return jsonCached(req, await listLanguageFacets(req, url, userId), 60);
    }

    if (req.method === "POST" && (segments[0] === "media-observed-languages" || (segments[0] === "device" && segments[1] === "media-observed-languages"))) {
      const userId = await requireUserId(req);
      return json(req, await recordObservedLanguages(req, userId));
    }

    // Live TMDB extras (trailer + cast/directors) for the fiches. Proxied here so
    // the TMDB key stays server-side; invariant per title → long CDN cache.
    if (req.method === "GET" && (segments[0] === "tmdb-meta" || (segments[0] === "device" && segments[1] === "tmdb-meta"))) {
      await requireUserId(req);
      return jsonCached(req, await getTmdbMeta(url), 86400);
    }

    // Per-episode TMDB data (stills, localized names, air dates) for the series fiche,
    // one season at a time. Proxied here so the TMDB key stays server-side; long CDN cache.
    if (req.method === "GET" && (segments[0] === "tmdb-episodes" || (segments[0] === "device" && segments[1] === "tmdb-episodes"))) {
      await requireUserId(req);
      return jsonCached(req, await getTmdbEpisodes(url), 86400);
    }

    // Crowd-learned "skip intro" markers (tmdbId + season).
    if (req.method === "GET" && (segments[0] === "intro-markers" || (segments[0] === "device" && segments[1] === "intro-markers"))) {
      await requireUserId(req);
      return jsonCached(req, await getIntroMarkers(url), 300);
    }

    if (req.method === "POST" && (segments[0] === "intro-signal" || (segments[0] === "device" && segments[1] === "intro-signal"))) {
      const userId = await requireUserId(req);
      return json(req, await recordIntroSignal(req, userId));
    }

    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const payload = publicEdgeErrorPayload(error, status, {
      unavailableMessage: "Norva Catalog is temporarily unavailable",
    });
    console.error("[norva-catalog]", publicEdgeErrorLog(error, status, payload));
    return json(req, payload, status);
  }
}

// Short in-isolate cache for the enrichment-progress aggregate. The onboarding /
// enrichment bar polls this every ~2s; uncached that hammered the DB with the COUNT
// below. Keyed by user + bound visibility epoch, 30s TTL, bounded size.
type EnrichmentProgress = { total: number; enriched: number; percent: number; settled: boolean };
const enrichmentProgressCache = new Map<string, { at: number; value: EnrichmentProgress }>();
const ENRICHMENT_PROGRESS_TTL_MS = 30_000;

async function getEnrichmentProgress(req: Request, userId: string): Promise<EnrichmentProgress> {
  const cacheEpoch = boundCatalogCacheEpoch(req);
  const cacheKey = cacheEpoch ? `${userId}:${cacheEpoch}` : null;
  const cached = cacheKey ? enrichmentProgressCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at < ENRICHMENT_PROGRESS_TTL_MS) return cached.value;
  // ESTIMATED counts (planner row-estimate via EXPLAIN, ~ms) instead of exact full
  // scans. On a freshly churned cloud_titles an EXACT count of ~68k rows ran 80-100s and,
  // polled repeatedly, piled up until Postgres refused new connections and logins 504'd
  // (a real outage). An approximate % is fine for a progress bar.
  const titlesBase = () => db.from("cloud_catalog_visible_titles").select("id", { count: "estimated", head: true })
    .eq("user_id", userId).in("item_type", ["movie", "series"]).gt("variant_count", 0);
  const [totalRes, enrichedRes, searchState, revalState] = await Promise.all([
    titlesBase(),
    titlesBase().not("provider_tmdb_id", "is", null),
    db.from("norva_search_match_state").select("done").eq("id", 1).maybeSingle(),
    db.from("norva_revalidate_state").select("done").eq("id", 1).maybeSingle(),
  ]);
  const total = totalRes.count ?? 0;
  const enriched = enrichedRes.count ?? 0;
  const percent = total > 0 ? Math.round((enriched / total) * 100) : 100;
  // The background enrichment crons (search-match + revalidate) are cursor-based,
  // one-pass scans: a title that never matches TMDB, or whose provider id never
  // validates, is LEFT in place and the cursor moves on. So the matched % plateaus
  // permanently — most IPTV catalogues keep a chunk with no TMDB entry plus many
  // provider-tagged titles that never verify (here ~13% unmatched + most of the rest
  // "provider_unverified"). "settled" = both passes have finished, i.e. there is no
  // enrichment work left and the % will never climb again. The client uses it to STOP
  // the progress bar instead of leaving it stuck at the plateau forever. The cron-state
  // rows are global (one shared scan across users) — fine here: the bar is onboarding
  // reassurance, not a per-user guarantee.
  const searchDone = (searchState.data as { done?: boolean } | null)?.done === true;
  const revalDone = (revalState.data as { done?: boolean } | null)?.done === true;
  // The cron-state rows above are GLOBAL (one shared scan), so a brand-new user whose
  // freshly imported titles haven't been scanned yet would otherwise be declared
  // "settled" at a 0%/low plateau just because another user's scan finished. Guard the
  // worst case: never settle a user who has titles but zero enriched yet. (A fully
  // per-user settle signal needs a per-user enrichment cursor — tracked as a follow-up.)
  const settled = searchDone && revalDone && (total === 0 || enriched > 0);
  const result: EnrichmentProgress = { total, enriched, percent, settled };
  if (cacheKey) {
    enrichmentProgressCache.set(cacheKey, { at: Date.now(), value: result });
    if (enrichmentProgressCache.size > 512) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of enrichmentProgressCache) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (oldestKey) enrichmentProgressCache.delete(oldestKey);
    }
  }
  return result;
}

// ==================== TMDB extras (fiches: trailer + credits) ====================

const TMDB_META_TTL_MS = 6 * 3_600_000;
// L2 (Postgres) freshness for the persistent episode cache (Phase 5). Longer than the 6h
// in-isolate tier since episode metadata is stable; short enough that a still-airing season
// picks up TMDB's new episodes within a couple weeks (the client shows provider episodes
// meanwhile — this cache is progressive enhancement, never the source of which episodes exist).
const EPISODE_I18N_TTL_MS = 14 * 24 * 3_600_000;
const tmdbMetaCache = new Map<string, { at: number; value: JsonRecord }>();

function tmdbApiKey(): string {
  return (
    Deno.env.get("NORVA_TMDB_API_KEY") ??
    Deno.env.get("TMDB_API_KEY") ??
    Deno.env.get("TMDB_READ_TOKEN") ??
    ""
  ).trim();
}

// TMDB `language` param for a validated 2-letter code. Bare ISO-639-1 is accepted by
// TMDB and covers the long tail (ar, es, de, ru, ja, hi, tr, nl…); a few languages have
// materially better coverage under a specific region, so map those explicitly. fr/en
// keep their prior fr-FR/en-US values → byte-identical for existing users.
const TMDB_REGIONAL_LOCALE: Record<string, string> = {
  en: "en-US",
  fr: "fr-FR",
  pt: "pt-BR", // Brazilian Portuguese dominates TMDB's pt catalogue
  zh: "zh-CN",
};
function tmdbLocale(lang2: string): string {
  const code = String(lang2 || "").slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return "en-US";
  return TMDB_REGIONAL_LOCALE[code] ?? code;
}

// Bounded TMDB fetch: an 8s abort so a slow or unreachable TMDB degrades to "unavailable"
// instead of stalling the fiche — matters more now that the translations append (Phase 4)
// enlarges the response. Returns null on timeout/network error; callers treat null like 404.
async function tmdbFetch(url: string, headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort on-demand population of the GLOBAL title cache. getTmdbMeta already fetches
// the title from TMDB in the user's language, so when TMDB returns a genuinely localized
// overview (empty ⇒ that translation is absent — TMDB never English-fills the overview
// field), persist it into catalog_titles.metadata.i18n[lang] so every future viewer at
// that language is served the synopsis with no further TMDB call. Idempotent via the RPC
// (fills gaps only, never overwrites); bounded so a slow write never blocks the fiche.
async function persistCatalogI18n(
  itemType: "movie" | "series", tmdbId: string, lang2: string, overview: string,
): Promise<void> {
  if (!/^[a-z]{2}$/.test(lang2) || !overview) return;
  try {
    await Promise.race([
      db.rpc("catalog_upsert_i18n", {
        p_item_type: itemType,
        p_provider_tmdb_id: tmdbId,
        p_lang: lang2,
        // Overview only: TMDB's `title` silently falls back to the original when a
        // localized title is absent (overview comes back empty instead), so persisting
        // it risks storing an English title under i18n[lang]. displayTitle already
        // falls back to the base title, and enrichment's translations pull stays the
        // authoritative source for genuinely localized titles.
        p_title: null,
        p_overview: overview,
      }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_) {
    // Never let cache population break the trailer/cast response; a missed write is
    // retried on the next cache miss for this (title, lang).
  }
}

// Phase 4 whole-map variant: persist the FULL translations map (every language TMDB has,
// title + overview) that getTmdbMeta already fetched, gap-fill style, in one RPC call — and
// stamp i18n_attempted_at so the pre-warm cron skips a title just pulled. An empty map still
// stamps the marker (records "TMDB has no translations") without touching metadata. Bounded
// and best-effort, exactly like persistCatalogI18n.
async function persistCatalogI18nMap(
  itemType: "movie" | "series", tmdbId: string, i18n: Record<string, { title?: string; overview?: string }>,
): Promise<void> {
  try {
    await Promise.race([
      db.rpc("catalog_upsert_i18n_map", {
        p_item_type: itemType,
        p_provider_tmdb_id: tmdbId,
        p_i18n: i18n,
      }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_) {
    // Best-effort: a missed write is retried on the next cache miss.
  }
}

async function getTmdbMeta(url: URL): Promise<JsonRecord> {
  const type = url.searchParams.get("type") === "series" ? "tv" : "movie";
  const tmdbId = String(url.searchParams.get("tmdbId") || "").trim();
  if (!/^\d+$/.test(tmdbId) || /^0+$/.test(tmdbId)) throw new HttpError(400, "tmdbId must be a TMDB numeric id");
  const key = tmdbApiKey();
  if (!key) return { available: false };

  const lang2 = (url.searchParams.get("lang") || "en").slice(0, 2).toLowerCase();
  const cacheKey = `${type}:${tmdbId}:${lang2}`;
  const cached = tmdbMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TMDB_META_TTL_MS) return cached.value;

  const params = new URLSearchParams({
    // translations carries EVERY language TMDB has in this one call, so a single fiche open
    // localises the title for all languages (Phase 4), not just the viewer's.
    append_to_response: "videos,credits,translations",
    language: tmdbLocale(lang2),
    // Trailers are often only tagged in en (or untagged) — widen the video pull.
    include_video_language: `${lang2},en,null`,
  });
  const headers: Record<string, string> = {};
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else params.set("api_key", key);

  const res = await tmdbFetch(`https://api.themoviedb.org/3/${type}/${tmdbId}?${params}`, headers);
  if (!res || res.status === 404) return { available: false };
  if (!res.ok) throw new HttpError(502, `TMDB responded ${res.status}`);
  const data = await res.json() as JsonRecord;

  type TmdbVideo = { site?: string; type?: string; key?: string; name?: string; official?: boolean };
  const videos = Array.isArray((data.videos as JsonRecord | undefined)?.results)
    ? (data.videos as { results: TmdbVideo[] }).results : [];
  const yt = videos.filter((v) => v?.site === "YouTube" && v?.key);
  const trailer = yt.find((v) => v.type === "Trailer" && v.official)
    ?? yt.find((v) => v.type === "Trailer")
    ?? yt.find((v) => v.type === "Teaser");

  type TmdbPerson = { name?: string; character?: string; job?: string; profile_path?: string | null };
  const credits = (data.credits ?? {}) as { cast?: TmdbPerson[]; crew?: TmdbPerson[] };
  const cast = (Array.isArray(credits.cast) ? credits.cast : []).slice(0, 12)
    .map((c) => ({ name: c?.name ?? "", character: c?.character ?? "", profile: c?.profile_path ?? null }))
    .filter((c) => c.name);
  const directors = (Array.isArray(credits.crew) ? credits.crew : [])
    .filter((c) => c?.job === "Director").slice(0, 3).map((c) => c?.name ?? "").filter(Boolean);
  const creators = (Array.isArray(data.created_by) ? data.created_by as TmdbPerson[] : [])
    .slice(0, 3).map((c) => c?.name ?? "").filter(Boolean);

  const value: JsonRecord = {
    available: true,
    // Return the requested-language synopsis as well as persisting it below, so
    // a freshly imported title can fill its open fiche before the next read.
    overview: stringOrNull(data.overview),
    trailerKey: trailer?.key ?? null,
    trailerName: trailer?.name ?? null,
    cast,
    directors,
    creators,
  };

  // Piggyback the localized details into the global i18n cache (Phase 4): the translations
  // append carries every language TMDB has, so one fiche open localises the title for all
  // viewers/languages at once. Fall back to the single-overview write when translations are
  // absent, and stamp the attempt either way so the pre-warm cron skips a just-pulled title.
  const itemType = type === "tv" ? "series" : "movie";
  const i18nMap = buildI18nFromTmdbTranslations(data);
  if (Object.keys(i18nMap).length > 0) {
    await persistCatalogI18nMap(itemType, tmdbId, i18nMap);
  } else {
    const locOverview = String(data.overview ?? "").trim();
    if (locOverview) await persistCatalogI18n(itemType, tmdbId, lang2, locOverview);
    else await persistCatalogI18nMap(itemType, tmdbId, {});
  }

  tmdbMetaCache.set(cacheKey, { at: Date.now(), value });
  if (tmdbMetaCache.size > 1024) {
    const oldest = [...tmdbMetaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) tmdbMetaCache.delete(oldest[0]);
  }
  return value;
}

const tmdbEpisodesCache = new Map<string, { at: number; value: JsonRecord }>();

// L2 (Postgres) read for a season's episode metadata (Phase 5). One PK probe on
// catalog_episode_i18n; returns the cached value when present and fresh, else null so the
// caller falls through to TMDB. Best-effort — a DB error never blocks the fiche.
async function readEpisodeI18n(tmdbId: string, season: number, lang2: string): Promise<JsonRecord | null> {
  try {
    // Bounded like every other cross-tier hop (write, tmdbFetch): a slow/hung PostgREST probe
    // must fall through to the 8s-bounded TMDB fetch within 1.5s, never block the fiche.
    const result = await Promise.race([
      db.from("catalog_episode_i18n")
        .select("episodes, fetched_at")
        .eq("provider_tmdb_id", tmdbId).eq("season", season).eq("lang", lang2)
        .maybeSingle(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!result) return null;
    const { data, error } = result;
    if (error || !data) return null;
    if (Date.now() - new Date(String(data.fetched_at)).getTime() >= EPISODE_I18N_TTL_MS) return null;
    return { available: true, episodes: (data.episodes as unknown[]) ?? [] };
  } catch (_) {
    return null;
  }
}

// L2 (Postgres) write-through for a season's episodes (Phase 5): a bounded, best-effort
// full-row upsert so a season fetched once serves every future viewer/PoP with no TMDB call.
async function writeEpisodeI18n(tmdbId: string, season: number, lang2: string, episodes: unknown[]): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    await Promise.race([
      db.from("catalog_episode_i18n").upsert(
        { provider_tmdb_id: tmdbId, season, lang: lang2, episodes, fetched_at: nowIso, updated_at: nowIso },
        { onConflict: "provider_tmdb_id,season,lang" }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_) {
    // Best-effort L2 population; a missed write just re-fetches TMDB next cold miss.
  }
}

// One TMDB season's episode metadata (still_path, localized name, air_date, runtime,
// vote_average), keyed by (tmdbId, season, lang). Served through three tiers — in-isolate
// Map (6h) → persistent catalog_episode_i18n (Phase 5, EPISODE_I18N_TTL_MS) → live TMDB — then
// the client merges it into the fiche's provider episode rows as progressive enhancement,
// degrading to provider data when the key is unset or TMDB has no match.
async function getTmdbEpisodes(url: URL): Promise<JsonRecord> {
  const tmdbId = String(url.searchParams.get("tmdbId") || "").trim();
  const season = String(url.searchParams.get("season") || "").trim();
  if (!/^\d+$/.test(tmdbId) || /^0+$/.test(tmdbId)) throw new HttpError(400, "tmdbId must be a TMDB numeric id");
  if (!/^\d+$/.test(season)) throw new HttpError(400, "season must be a numeric season number");
  const key = tmdbApiKey();
  if (!key) return { available: false };

  const lang2 = (url.searchParams.get("lang") || "en").slice(0, 2).toLowerCase();
  const cacheKey = `${tmdbId}:${season}:${lang2}`;
  const cached = tmdbEpisodesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TMDB_META_TTL_MS) return cached.value;

  // L2: persistent per-(season, lang) cache under the in-memory tier (Phase 5). Serves every
  // user/PoP without a TMDB hit and survives isolate/CDN eviction. Only for a valid 2-letter
  // lang (the table key/CHECK); any other input falls straight through to TMDB.
  const seasonNum = Number(season);
  const validLang = /^[a-z]{2}$/.test(lang2);
  if (validLang) {
    const persisted = await readEpisodeI18n(tmdbId, seasonNum, lang2);
    if (persisted) {
      tmdbEpisodesCache.set(cacheKey, { at: Date.now(), value: persisted });
      return persisted;
    }
  }

  const params = new URLSearchParams({ language: tmdbLocale(lang2) });
  const headers: Record<string, string> = {};
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else params.set("api_key", key);

  const res = await tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?${params}`, headers);
  if (!res || res.status === 404) return { available: false };
  if (!res.ok) throw new HttpError(502, `TMDB responded ${res.status}`);
  const data = await res.json() as JsonRecord;

  type TmdbEp = { episode_number?: number; name?: string; still_path?: string | null; air_date?: string | null; overview?: string | null; runtime?: number | null; vote_average?: number | null };
  const episodes = (Array.isArray(data.episodes) ? data.episodes as TmdbEp[] : [])
    .map((e) => ({
      episode_number: typeof e.episode_number === "number" ? e.episode_number : null,
      name: e.name ?? null,
      still_path: e.still_path ?? null,
      air_date: e.air_date ?? null,
      overview: e.overview ?? null,
      runtime: typeof e.runtime === "number" ? e.runtime : null,
      vote_average: typeof e.vote_average === "number" ? e.vote_average : null,
    }))
    .filter((e) => e.episode_number != null);

  const value: JsonRecord = { available: true, episodes };
  tmdbEpisodesCache.set(cacheKey, { at: Date.now(), value });
  // Populate the persistent L2 (Phase 5) — only for a valid lang and a non-empty season (never
  // cache an empty result as authoritative; a genuinely empty season re-checks TMDB next miss).
  // Prefer EdgeRuntime.waitUntil so the (bounded, best-effort) write completes AFTER the response
  // instead of adding up to 1.5s to this cold-miss request; await as a fallback where absent.
  if (validLang && episodes.length > 0) {
    const write = writeEpisodeI18n(tmdbId, seasonNum, lang2, episodes);
    const er = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(write);
    else await write;
  }
  if (tmdbEpisodesCache.size > 2048) {
    const oldest = [...tmdbEpisodesCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) tmdbEpisodesCache.delete(oldest[0]);
  }
  return value;
}

// ==================== Skip-intro markers (crowd-learned) ====================
// One upserted signal per (title, season, user): the early-forward-seek gesture.
// Markers are served once ≥3 independent viewers agree, as the median of their
// jumps — self-correcting, no editorial data and zero provider connections.

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function getIntroMarkers(url: URL): Promise<JsonRecord> {
  const tmdbId = String(url.searchParams.get("tmdbId") || "").trim();
  const season = Number.parseInt(url.searchParams.get("season") || "", 10);
  if (!/^\d+$/.test(tmdbId) || !Number.isFinite(season) || season < 0 || season > 100) {
    throw new HttpError(400, "tmdbId and season are required");
  }
  const { data, error } = await db
    .from("catalog_intro_signals")
    .select("seek_from,seek_to")
    .eq("provider_tmdb_id", tmdbId)
    .eq("season", season)
    .limit(200);
  if (error) throwDb(error, "Unable to read intro markers");
  const rows = (data ?? []) as Array<{ seek_from: number; seek_to: number }>;
  if (rows.length < 3) return { available: false, samples: rows.length };
  const introEnd = medianOf(rows.map((r) => Number(r.seek_to) || 0));
  const introStart = Math.max(0, medianOf(rows.map((r) => Number(r.seek_from) || 0)) - 15);
  if (!(introEnd > introStart + 5)) return { available: false, samples: rows.length };
  return { available: true, introStart, introEnd, samples: rows.length };
}

async function recordIntroSignal(req: Request, userId: string): Promise<JsonRecord> {
  const body = await req.json().catch(() => ({})) as JsonRecord;
  const tmdbId = String(body.tmdbId ?? "").trim();
  const season = Number.parseInt(String(body.season ?? ""), 10);
  const from = Math.round(Number(body.from ?? NaN));
  const seekTo = Math.round(Number(body.seekTo ?? NaN));
  if (!/^\d+$/.test(tmdbId) || !Number.isFinite(season) || season < 0 || season > 100) {
    throw new HttpError(400, "tmdbId and season are required");
  }
  // Same gesture window the client enforces — revalidated server-side.
  if (!Number.isFinite(from) || !Number.isFinite(seekTo)
    || from < 0 || from > 240 || seekTo < 20 || seekTo > 420 || seekTo - from < 15) {
    return { recorded: false };
  }
  const { error } = await db.from("catalog_intro_signals").upsert({
    provider_tmdb_id: tmdbId,
    season,
    user_id: userId,
    seek_from: from,
    seek_to: seekTo,
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider_tmdb_id,season,user_id" });
  if (error) throwDb(error, "Unable to record intro signal");
  return { recorded: true };
}

async function requireUserId(req: Request) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Missing bearer token");

  if (token.startsWith("nv_dev_")) {
    return await bindCatalogVisibilityEpoch(req, await requireDeviceUserId(token));
  }

  // Vérif locale d'abord (voir _shared/local-auth.ts) — GoTrue n'est consulté
  // que si le verdict est indécidable localement (alg asymétrique, secret absent).
  const local = await verifyUserJwtLocally(token);
  if (local !== "invalid" && local !== "fallback") {
    return await bindCatalogVisibilityEpoch(req, local.id);
  }
  if (local === "fallback") {
    const { data, error } = await db.auth.getUser(token);
    if (!error && data.user?.id) return await bindCatalogVisibilityEpoch(req, data.user.id);
  }

  return await bindCatalogVisibilityEpoch(req, await requireDeviceUserId(token));
}

async function bindCatalogVisibilityEpoch(req: Request, userId: string) {
  try {
    await bindCatalogVisibilityEpochShared(req, userId, db);
  } catch (_) {
    console.warn("[norva-catalog] catalog visibility epoch unavailable");
    throw new HttpError(503, "Catalog visibility is temporarily unavailable");
  }
  return userId;
}

async function requireDeviceUserId(token: string) {
  const tokenHash = await sha256Hex(token);
  const { data, error } = await db
    .from("cloud_devices")
    .select("user_id")
    .eq("device_token_hash", tokenHash)
    .eq("revoked", false)
    .maybeSingle();
  if (error) throwDb(error, "Unable to verify device token");
  if (!data?.user_id) throw new HttpError(401, "Invalid bearer token");
  return data.user_id as string;
}

// Phase 2 dedup read flag (shared with norva-playback): when set to
// "catalog_media_items", media reads resolve the provider-global catalogue.
function mediaReadFromCatalog(): boolean {
  return (Deno.env.get("NORVA_CATALOG_MEDIA_READ_SOURCE") || "").trim() === "catalog_media_items";
}

// Overlay a grid page's display + playback fields from catalog_media_items (the
// provider-global catalogue, keyed by server_host). Fills only where the global
// carries a value — never blanks a per-user field — so it is safe when the global
// is empty or partial. Lets the per-user cloud_media_items later drop poster/
// backdrop/metadata/playback_hint while the grid still renders them from global.
async function applyMediaCatalogOverlay(items: Array<Record<string, any>>, sourceId: string, userId: string) {
  // A generation-owned row is already the exact active provider snapshot. The
  // provider-global media cache is unversioned and may still contain A while B
  // is the active generation, so only legacy/global rows may consult it.
  const globalItems = items.filter((row) => !flatMediaBlocksGlobalTitleOverlay(row));
  if (!globalItems.length) return;
  const { data: src } = await db.from("cloud_catalog_visible_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
  const host = String((src as any)?.config_hint?.serverHost || "").trim();
  if (!host) return;
  const ids = [...new Set(globalItems.map((row) => String(row.external_id || "")).filter(Boolean))];
  if (!ids.length) return;
  const byKey = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await (db as any)
      .from("catalog_media_items")
      .select("item_type,external_id,title,subtitle,poster_url,backdrop_url,metadata,playback_hint")
      .eq("server_host", host)
      .in("external_id", ids.slice(i, i + 500));
    for (const g of (data ?? []) as Array<Record<string, any>>) byKey.set(`${g.item_type}:${g.external_id}`, g);
  }
  if (!byKey.size) return;
  for (const it of globalItems) {
    const g = byKey.get(`${it.item_type}:${it.external_id}`);
    if (!g) continue;
    if (g.poster_url) it.poster_url = g.poster_url;
    if (g.backdrop_url) it.backdrop_url = g.backdrop_url;
    if (g.subtitle) it.subtitle = g.subtitle;
    if (g.title && !String(it.title || "").trim()) it.title = g.title;
    if (isRecord(g.metadata) && Object.keys(g.metadata).length) it.metadata = g.metadata;
    if (isRecord(g.playback_hint) && Object.keys(g.playback_hint).length) it.playback_hint = g.playback_hint;
  }
}

async function listMediaItems(url: URL, userId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");
  const search = url.searchParams.get("q");
  const categoryId = url.searchParams.get("categoryId");
  const sort = url.searchParams.get("sort") || "default";
  const lang = railLang(url);
  const limit = boundedInt(url.searchParams.get("limit"), 1000, 1, 1000);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);

  // Year / rating / recently-added filters run in SQL over denormalized columns so
  // they span the WHOLE catalogue (not just the loaded page).
  const yearRange = decadeRange(url.searchParams.get("year"));
  const minRating = paramNumber(url.searchParams.get("minRating"));
  const addedDays = boundedInt(url.searchParams.get("addedDays"), 0, 0, 3650);
  const addedAfterEpoch = addedDays > 0
    ? Math.floor((Date.now() - addedDays * 86_400_000) / 1000)
    : null;

  // Fuzzy search: a typed title query routes through the trigram-ranked RPC (typo
  // tolerance + substring-first ordering) instead of a plain ILIKE, when it's a
  // pure title search (no source/category filter the RPC doesn't model).
  if (search && itemType && !sourceId && !categoryId) {
    const q = search.trim();
    if (q.length >= 2) {
      // dedup=1 (global-search overlay) collapses to one representative row per
      // film SERVER-SIDE (grid parity). Default returns ALL matching rows —
      // load-bearing: openByItem() re-fetches a tapped result's sibling versions
      // through this same path to build the version picker.
      const dedupSearch = url.searchParams.get("dedup") === "1";
      const { data: hits, error: rpcErr } = await db.rpc("search_media_items", {
        p_user: userId, p_item_type: itemType, p_q: q, p_limit: Math.min(limit, 50),
        p_dedup: dedupSearch,
      });
      if (!rpcErr && Array.isArray(hits)) {
        const items = (hits as Array<Record<string, any>>).map((row) => {
          row.year = row.release_year ?? null;
          return row;
        });
        await attachMediaLanguages(items, userId, itemType, lang);
        await localizeMediaTitles(items, userId, lang, itemType);
        return {
          items: items.map(sanitizeCatalogMediaItem),
          count: items.length,
          limit,
          offset: 0,
          hasMore: false,
        };
      }
      // RPC unavailable (pre-migration / error) → fall through to the deduped grid.
    }
  }

  // Main grid: server-side dedup so a film the provider lists more than once (or
  // that arrived from several sources) shows as ONE card, spanning the whole
  // catalogue so duplicates collapse even across pages. The representative row is
  // the richest (poster + resolved tmdb + rating); `total` is the distinct film
  // count. See migration list_media_items_deduped.
  const { data: rpcData, error } = await db.rpc("list_media_items_deduped", {
    p_user: userId,
    p_item_type: itemType,
    p_source: sourceId,
    p_category: categoryId,
    p_search: search,
    p_year_min: yearRange ? yearRange.min : null,
    p_year_max: yearRange ? yearRange.max : null,
    p_min_rating: minRating,
    p_added_after_epoch: addedAfterEpoch,
    p_sort: sort,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throwDb(error, "Unable to list media items");

  const payload = (rpcData ?? {}) as { items?: Array<Record<string, any>>; films?: number; total?: number };
  // release_year is a first-class column now — expose it as item.year for the card.
  const items = (payload.items ?? []).map((row) => {
    row.year = row.release_year ?? null;
    return row;
  });
  const count = typeof payload.total === "number" ? payload.total : null;
  // `items` are version rows; the page is paginated by FILM, so the client advances
  // its cursor by `films`, not by row count (a film can contribute several rows).
  const films = typeof payload.films === "number" ? payload.films : items.length;

  // Phase 2 dedup: when the read flag is on, overlay display + playback fields from
  // the provider-global catalog_media_items so the grid serves them from the shared
  // catalogue (letting the per-user copy later be thinned of those heavy fields).
  if (mediaReadFromCatalog() && sourceId) {
    await applyMediaCatalogOverlay(items, sourceId, userId);
  }

  await attachMediaLanguages(items, userId, itemType, lang);
  await localizeMediaTitles(items, userId, lang, itemType);

  return {
    items: items.map(sanitizeCatalogMediaItem),
    count,
    films,
    limit,
    offset,
    hasMore: typeof count === "number" ? offset + films < count : films >= limit,
  };
}

// Flat media rows come directly from provider inventory and do not carry a
// title_id. Keep the hydrated title proof out-of-band so neither provider JSON
// nor an accidentally serialized database row can forge or expose it.
const flatMediaGenerationTitleProof = new WeakMap<object, JsonRecord>();
// attachMediaLanguages historically ran after localizeMediaTitles and therefore
// let a validated catalogue translation win. The P proof must be bound first,
// so remember that exact G outcome and keep the reordered calls byte-compatible.
const flatMediaGlobalLocalizedTitle = new WeakSet<object>();

function flatMediaGenerationId(row: Record<string, any>): string | null {
  // Only the physical Postgres column is trusted. Provider metadata may contain
  // arbitrary camelCase keys and must never opt a row into projection handling.
  return stringOrNull(row.generation_id);
}

function flatMediaGenerationTitle(row: Record<string, any>): JsonRecord | null {
  const proof = flatMediaGenerationTitleProof.get(row);
  return proof && catalogTitleUsesGenerationPayload(proof) ? proof : null;
}

function flatMediaBlocksGlobalTitleOverlay(row: Record<string, any>): boolean {
  // A physical generation fence is sufficient to fail closed even when the
  // bounded title hydration RPC is unavailable or its visibility epoch moves.
  return Boolean(flatMediaGenerationId(row) || flatMediaGenerationTitle(row));
}

function applyFlatMediaGenerationTitle(
  row: Record<string, any>,
  title: JsonRecord,
  lang: string | null,
): void {
  const fullOverlayEnabled = catalogReadEnabled();
  applyGenerationCatalogMetadata(title, lang, fullOverlayEnabled);

  const titleMetadata = recordOrEmpty(title.metadata);
  const itemMetadata = recordOrEmpty(row.metadata);
  // Preserve exact provider routing/category facts, but let the active P
  // projection own every overlapping display field.
  row.metadata = { ...itemMetadata, ...titleMetadata };

  const tmdb = recordOrEmpty(titleMetadata.tmdb);
  const localized = lang ? recordOrEmpty(recordOrEmpty(titleMetadata.i18n)[lang]) : {};
  const projectedTitle = stringOrNull(localized.title) ?? stringOrNull(title.title);
  if (projectedTitle) {
    row.title = projectedTitle;
    row.name = projectedTitle;
  }

  const projectedOverview = boundedProviderOverview(
    localized.overview,
    tmdb.overview,
    titleMetadata.overview,
    title.__catalog_base_overview,
  );
  const existingOverview = boundedProviderOverview(row.overview, row.description, row.plot);
  const resolvedOverview = stringOrNull(localized.overview)
    ?? (fullOverlayEnabled ? projectedOverview ?? existingOverview : existingOverview ?? projectedOverview);
  if (resolvedOverview) {
    row.overview = resolvedOverview;
    row.description = resolvedOverview;
    row.plot = resolvedOverview;
    row.tmdb = { ...recordOrEmpty(row.tmdb), ...tmdb, overview: resolvedOverview };
  }

  const poster = stringOrNull(title.poster_url);
  const backdrop = stringOrNull(title.backdrop_url);
  if (poster) {
    row.poster_url = poster;
    row.posterUrl = poster;
    row.stream_icon = poster;
    row.cover = poster;
  }
  if (backdrop) {
    row.backdrop_url = backdrop;
    row.backdropUrl = backdrop;
  }

  const releaseYear = title.release_year === null || title.release_year === undefined
    ? null
    : numberOrNull(title.release_year);
  if (releaseYear !== null) {
    row.release_year = releaseYear;
    row.year = releaseYear;
  }
  const originalLanguage = stringOrNull(tmdb.original_language);
  if (originalLanguage) {
    row.original_language = originalLanguage;
    row.originalLanguage = originalLanguage;
  }
  const rawRating = title.rating_num ?? tmdb.vote_average;
  const rating = rawRating === null || rawRating === undefined ? null : numberOrNull(rawRating);
  if (rating !== null) {
    row.rating_num = rating;
    row.rating = rating;
    row.vote_average = rating;
    row.voteAverage = rating;
  }
  const runtime = tmdb.runtime === null || tmdb.runtime === undefined
    ? null
    : numberOrNull(tmdb.runtime);
  if (runtime !== null) {
    row.runtime = runtime;
    row.runtimeMinutes = runtime;
  }
}

async function bindFlatMediaGenerationTitles(
  items: Array<Record<string, any>>,
  userId: string,
  itemType: string | null,
  visibleTitles: JsonRecord[],
  lang: string | null,
): Promise<void> {
  if ((itemType !== "movie" && itemType !== "series") || !items.length || !visibleTitles.length) return;
  const titleIds = [...new Set(visibleTitles
    .map((title) => stringOrNull(title.id))
    .filter((id): id is string => Boolean(id)))];
  if (!titleIds.length) return;

  let hydrated: JsonRecord[];
  try {
    const visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId);
    hydrated = await hydrateVisibleCatalogTitlesByIds(userId, titleIds, visibilityEpoch, false);
  } catch (_) {
    // Generation-owned rows remain globally isolated by generation_id. Losing
    // progressive title enrichment is safer than silently serving A over B.
    return;
  }

  const candidatesByTmdb = new Map<string, JsonRecord[]>();
  for (const title of hydrated) {
    if (!catalogTitleUsesGenerationPayload(title)) continue;
    const tmdbId = stringOrNull(title.provider_tmdb_id);
    if (!tmdbId) continue;
    const existing = candidatesByTmdb.get(tmdbId) ?? [];
    existing.push(title);
    candidatesByTmdb.set(tmdbId, existing);
  }

  for (const item of items) {
    const metadata = recordOrEmpty(item.metadata);
    const tmdbId = stringOrNull(metadata.providerTmdbId ?? metadata.provider_tmdb_id);
    const sourceId = stringOrNull(item.source_id);
    if (!tmdbId || !sourceId) continue;
    const sourceCandidates = (candidatesByTmdb.get(tmdbId) ?? []).filter((title) => {
      const visibleSourceIds = Array.isArray(title.visible_source_ids)
        ? title.visible_source_ids.map(String)
        : [];
      return visibleSourceIds.includes(sourceId);
    });
    if (!sourceCandidates.length) continue;

    const itemGenerationId = flatMediaGenerationId(item);
    const exactGeneration = itemGenerationId
      ? sourceCandidates.filter((title) => stringOrNull(
        title.display_generation_id ?? title.displayGenerationId,
      ) === itemGenerationId)
      : [];
    const selected = exactGeneration.length === 1
      ? exactGeneration[0]
      : sourceCandidates.length === 1 ? sourceCandidates[0] : null;
    if (!selected) continue; // duplicate provider identities stay fail-closed
    flatMediaGenerationTitleProof.set(item, selected);
    applyFlatMediaGenerationTitle(item, selected, lang);
  }
}

// Override each grid card's title with the user's-language title when we have one
// (cloud_titles.metadata.i18n[lang].title) — fixes provider entries that are in a
// different language than the user (mislabeled / multi-country providers). One
// compact indexed lookup per page; only runs when a language is requested.
async function localizeMediaTitles(items: Array<Record<string, any>>, userId: string, lang: string | null, itemType: string | null) {
  if (!lang || !items.length) return;
  // P has already been localized from its exact hydrated projection. Only G is
  // allowed to consult the unversioned global/per-user title lookup below.
  const globalItems = items.filter((row) =>
    !flatMediaBlocksGlobalTitleOverlay(row) && !flatMediaGlobalLocalizedTitle.has(row));
  const tmdbIds = [...new Set(globalItems
    .map((row) => stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null))
    .filter((id): id is string => Boolean(id) && id !== "0"))];
  if (!tmdbIds.length) return;

  // Read-cutover flag: serve the localized title from the global catalog cache when on
  // (requires a known item_type — catalog_titles is keyed by it); else per-user.
  const useCatalog = catalogReadEnabled() && (itemType === "movie" || itemType === "series");
  const locByTmdb = new Map<string, string>();
  for (let i = 0; i < tmdbIds.length; i += 500) {
    const chunk = tmdbIds.slice(i, i + 500);
    let q = db
      .from(useCatalog ? "catalog_titles" : "cloud_catalog_visible_titles")
      .select(`provider_tmdb_id, loc:metadata->i18n->${lang}->>title`)
      .in("provider_tmdb_id", chunk);
    q = useCatalog ? q.eq("item_type", itemType as string) : q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) return; // localization is best-effort; never fail the page over it
    for (const row of data ?? []) {
      const id = stringOrNull((row as unknown as Record<string, unknown>).provider_tmdb_id);
      const loc = stringOrNull((row as unknown as Record<string, unknown>).loc);
      if (id && loc) locByTmdb.set(id, loc);
    }
  }
  for (const row of globalItems) {
    const tmdbId = stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null);
    const loc = tmdbId ? locByTmdb.get(tmdbId) : null;
    if (loc) { row.title = loc; row.name = loc; }
  }
}

// Attach the title's REAL detected languages (cloud_titles.audio_languages /
// version_languages) AND the precomputed ordered per-track map (audio_tracks) to each
// grid item so the client card badge shows the actual audio language AND the player can
// label every audio track with ZERO playback-time probe. cloud_media_items rows lack
// these — look them up by provider_tmdb_id (per-user; always cloud_titles, not
// catalog_titles). Best-effort, chunked — never fails the grid over a badge.
function boundedProviderOverview(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringOrNull(value);
    if (!text || /^(?:n\/?a|none|null|undefined|no (?:description|overview|plot)(?: available)?)$/i.test(text)) continue;
    return text.slice(0, 4000);
  }
  return null;
}

function catalogTextStatusEligible(value: unknown): boolean {
  return ["provider_verified", "matched", "manual"].includes(String(value ?? ""));
}

async function attachMediaLanguages(
  items: Array<Record<string, any>>,
  userId: string,
  itemType: string | null,
  lang: string | null,
) {
  if (!items.length) return;
  // Do this before TMDB/title overlays: exact file evidence exists even for an
  // unmatched provider title, and must remain attached to that one raw row.
  await attachFlatMediaFileLanguages(items, userId, itemType);
  // Preserve provider-supplied summaries even when the title has no TMDB identity
  // and has never been probed. Promote the compact metadata field to the response
  // shape consumed by movie/series fiches before any catalogue lookup can return.
  for (const row of items) {
    const metadata = recordOrEmpty(row.metadata);
    const providerOverview = boundedProviderOverview(
      metadata.overview,
      metadata.description,
      metadata.plot,
    );
    const existingOverview = stringOrNull(row.overview)
      ?? stringOrNull(row.description)
      ?? stringOrNull(row.plot);
    if (providerOverview && !existingOverview) {
      row.overview = providerOverview;
      row.description = providerOverview;
      row.plot = providerOverview;
    }
  }
  const tmdbIds = [...new Set(items
    .map((row) => stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null))
    .filter((id): id is string => Boolean(id) && id !== "0"))];
  if (!tmdbIds.length) return;
  const byTmdb = new Map<string, { audio: string[]; version: string[]; tracks: Array<{ index: number; lang: string | null }> }>();
  // Freshest display art per TMDB id, from the identity table. The flat grid rows
  // come from cloud_media_items, whose poster can go STALE (TMDB replaces an image →
  // the stored path 404s) while the background enrichment refreshes the cloud_titles
  // row. Overlaying the verified cloud_titles poster fixes matched titles that render
  // a broken/placeholder image in the grid + detail even though they're enriched.
  const artByTmdb = new Map<string, { poster: string | null; backdrop: string | null; verified: boolean }>();
  // Every non-sentinel provider id is a candidate. Cross-user text is only accepted
  // below when the per-user association is verified AND catalog_titles itself
  // records tmdbValidation.valid=true. New imports reuse that validation inline.
  const catalogCandidateIds = new Set<string>();
  const weakCatalogIds = new Set<string>();
  const visibleTitles: JsonRecord[] = [];
  for (let i = 0; i < tmdbIds.length; i += 500) {
    let query = db
      .from("cloud_catalog_visible_titles")
      .select("id, provider_tmdb_id, audio_languages, version_languages, audio_tracks, poster_url, backdrop_url, match_status, visible_source_ids")
      .eq("user_id", userId)
      .in("provider_tmdb_id", tmdbIds.slice(i, i + 500));
    if (itemType === "movie" || itemType === "series") query = query.eq("item_type", itemType);
    const { data, error } = await query;
    if (error) return; // best-effort; never fail the grid over the badge
    for (const row of data ?? []) {
      visibleTitles.push(row as JsonRecord);
      const id = stringOrNull((row as Record<string, unknown>).provider_tmdb_id);
      if (!id) continue;
      if (String((row as JsonRecord).match_status) === "weak") weakCatalogIds.add(id);
      if (catalogTextStatusEligible((row as JsonRecord).match_status) && !/^(tt)?0+$/i.test(id)) {
        catalogCandidateIds.add(id);
      }
      const next = {
        audio: titleAudioLanguages(row as JsonRecord),
        version: titleVersionLanguages(row as JsonRecord),
        tracks: titleAudioTracks(row as JsonRecord),
      };
      // Several per-user title rows can share a TMDB id (regional dedup leftovers).
      // Keep the RICHEST so a row WITHOUT the crawled per-track map can't clobber a
      // sibling that HAS it — otherwise the player loses the precomputed audio
      // languages at random (the "Audio 1/2/3 one reload out of two" symptom).
      const prev = byTmdb.get(id);
      if (!prev
        || next.tracks.length > prev.tracks.length
        || (next.tracks.length === prev.tracks.length && next.audio.length > prev.audio.length)) {
        byTmdb.set(id, next);
      }
      // Art: prefer a verified row's poster (freshest, TMDB-confirmed).
      const poster = stringOrNull((row as JsonRecord).poster_url);
      const verified = String((row as JsonRecord).match_status) === "provider_verified";
      const prevArt = artByTmdb.get(id);
      if (poster && (!prevArt || (verified && !prevArt.verified))) {
        artByTmdb.set(id, { poster, backdrop: stringOrNull((row as JsonRecord).backdrop_url), verified });
      }
    }
  }
  // A duplicated provider id with even one failed title/year validation is
  // ambiguous for flat media rows (which carry no title_id). Fail closed.
  for (const id of weakCatalogIds) catalogCandidateIds.delete(id);
  await bindFlatMediaGenerationTitles(items, userId, itemType, visibleTitles, lang);
  for (const row of items) {
    const id = stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null);
    if (!id) continue;
    const hit = byTmdb.get(id);
    if (hit) {
      // A tenant observation belongs to this exact provider file. Never replace
      // it with the grouped title union merely because the title has a TMDB id.
      if (row.audio_languages_scope !== "file" && row.audioLanguagesScope !== "file") {
        row.audio_languages = hit.audio; row.audioLanguages = hit.audio;
      }
      row.version_languages = hit.version; row.versionLanguages = hit.version;
      // Ordered map (absolute-stream order, null-lang entries kept for position) — the
      // player maps engine streams -> languages from this, no probe. Only set when present
      // so titles without a crawled map fall through to the live-probe path unchanged.
      if (hit.tracks.length) { row.audio_tracks = hit.tracks; row.audioTracks = hit.tracks; }
    }
    // P art was applied from its exact hydrated generation above. Only G may use
    // the unmarked visible-title art map.
    if (flatMediaBlocksGlobalTitleOverlay(row)) continue;
    // Overlay the fresh identity-table poster over the (possibly stale) grid poster.
    const art = artByTmdb.get(id);
    if (art?.poster) {
      row.poster_url = art.poster; row.posterUrl = art.poster; row.stream_icon = art.poster; row.cover = art.poster;
      if (art.backdrop) { row.backdrop_url = art.backdrop; row.backdropUrl = art.backdrop; }
    }
  }

  // G can reuse GLOBAL TMDB facts. P derives them from its own generation-scoped
  // catalog_metadata above and must never consult this unversioned cache.
  try {
    const candidateIds = [...catalogCandidateIds].filter((candidateId) => items.some((row) => {
      if (flatMediaBlocksGlobalTitleOverlay(row)) return false;
      const id = stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null);
      return id === candidateId;
    }));
    if ((itemType !== "movie" && itemType !== "series") || !candidateIds.length) return;
    const catByTmdb = new Map<string, {
      lang: string | null;
      localizedTitle: string | null;
      localizedOverview: string | null;
      fallbackOverview: string | null;
      poster: string | null;
      backdrop: string | null;
    }>();
    const localizedFields = lang
      ? `, loc_title:metadata->i18n->${lang}->>title, loc_overview:metadata->i18n->${lang}->>overview`
      : "";
    for (let i = 0; i < candidateIds.length; i += 500) {
      // Extract just the overview field (metadata->tmdb->>overview) instead of the whole
      // metadata blob. catalog_titles is the GLOBAL enriched source — verified titles have
      // their per-user metadata.tmdb thinned, so the overview only survives here.
      const { data } = await (db as any)
        .from("catalog_titles")
        .select(`provider_tmdb_id, original_language, poster_url, backdrop_url, trusted:metadata->tmdbValidation->>valid, base_overview:metadata->tmdb->>overview, legacy_overview:metadata->>overview, en_overview:metadata->i18n->en->>overview${localizedFields}`)
        .eq("item_type", itemType)
        .in("provider_tmdb_id", candidateIds.slice(i, i + 500));
      for (const c of data ?? []) {
        const id = stringOrNull((c as JsonRecord).provider_tmdb_id);
        if (!id || String((c as JsonRecord).trusted) !== "true") continue;
        catByTmdb.set(id, {
          lang: stringOrNull((c as JsonRecord).original_language),
          localizedTitle: stringOrNull((c as JsonRecord).loc_title),
          localizedOverview: stringOrNull((c as JsonRecord).loc_overview),
          fallbackOverview: stringOrNull((c as JsonRecord).base_overview)
            ?? stringOrNull((c as JsonRecord).legacy_overview)
            ?? stringOrNull((c as JsonRecord).en_overview),
          poster: stringOrNull((c as JsonRecord).poster_url),
          backdrop: stringOrNull((c as JsonRecord).backdrop_url),
        });
      }
    }
    for (const row of items) {
      if (flatMediaBlocksGlobalTitleOverlay(row)) continue;
      const id = stringOrNull(isRecord(row.metadata) ? row.metadata.providerTmdbId : null);
      const cat = id ? catByTmdb.get(id) : null;
      if (!cat) continue;
      if (cat.lang) { row.original_language = cat.lang; row.originalLanguage = cat.lang; }
      // Text-only global reuse remains active while the full display cutover is OFF:
      // cloud_titles.metadata is intentionally self-thinned after every new import.
      if (cat.localizedTitle) {
        row.title = cat.localizedTitle;
        row.name = cat.localizedTitle;
        flatMediaGlobalLocalizedTitle.add(row);
      }
      const rowTmdb = isRecord(row.tmdb) ? row.tmdb : {};
      const existingOverview = stringOrNull(rowTmdb.overview)
        ?? stringOrNull(row.overview)
        ?? stringOrNull(row.description)
        ?? stringOrNull(row.plot);
      // A requested-language translation wins consistently on grids and rails.
      // Otherwise the provider text wins and the catalogue remains fill-only.
      const resolvedOverview = cat.localizedOverview
        ?? existingOverview
        ?? cat.fallbackOverview;
      if (resolvedOverview && (cat.localizedOverview || !existingOverview)) {
        row.overview = resolvedOverview; row.description = resolvedOverview; row.plot = resolvedOverview;
        row.tmdb = { ...rowTmdb, overview: resolvedOverview };
      }
      // Poster/backdrop: catalog_titles is the global enriched source and the freshest
      // authority, so its art WINS over the per-user cloud_titles/provider poster (which
      // can go stale when TMDB rotates an image → the stored path 404s → placeholder).
      // This overrides the cloud_titles overlay applied above for matched titles.
      if (cat.poster) {
        row.poster_url = cat.poster; row.posterUrl = cat.poster; row.stream_icon = cat.poster; row.cover = cat.poster;
      }
      if (cat.backdrop) { row.backdrop_url = cat.backdrop; row.backdropUrl = cat.backdrop; }
    }
  } catch (_) { /* best-effort; never fail the grid over enrichment overlay */ }
}

async function listMediaCategories(url: URL, userId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");

  let query = db
    .from("cloud_catalog_visible_media_items")
    .select("source_id,parent_external_id,subtitle,metadata")
    .eq("user_id", userId)
    .not("parent_external_id", "is", null)
    .order("subtitle", { ascending: true })
    .limit(50000);

  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);

  const { data, error } = await query;
  if (error) throwDb(error, "Unable to list media categories");

  const categories = new Map<string, { source_id: string; category_id: string; category_name: string }>();
  for (const row of data ?? []) {
    const rowSourceId = String(row.source_id ?? "");
    const categoryId = String(row.parent_external_id ?? "");
    if (!rowSourceId || !categoryId) continue;
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    const categoryName = String(row.subtitle || metadata.categoryName || categoryId);
    const key = `${rowSourceId}:${categoryId}`;
    if (!categories.has(key) || categories.get(key)?.category_name === categoryId) {
      categories.set(key, {
        source_id: rowSourceId,
        category_id: categoryId,
        category_name: categoryName || categoryId,
      });
    }
  }

  return {
    categories: [...categories.values()].sort((a, b) =>
      a.category_name.localeCompare(b.category_name, undefined, { sensitivity: "base" })
    ),
  };
}

function activeCatalogProfileIds(
  profiles: Array<{ id: string; is_default?: boolean | null; created_at?: string | null }>,
  limit: number,
): Set<string> | null {
  const cap = Math.max(1, Number(limit) || 1);
  if (profiles.length <= cap) return null;
  const ordered = [...profiles].sort((left, right) =>
    (right.is_default ? 1 : 0) - (left.is_default ? 1 : 0) ||
    String(left.created_at || "").localeCompare(String(right.created_at || "")));
  return new Set(ordered.slice(0, cap).map((profile) => profile.id));
}

async function resolveCatalogProfileId(req: Request, userId: string): Promise<string | null> {
  const requestedProfileId = stringOrNull(req.headers.get("x-norva-profile-id"));
  if (requestedProfileId) {
    const { data, error } = await db
      .from("cloud_account_profiles")
      .select("id,is_default,created_at")
      .eq("user_id", userId);
    if (error) throwDb(error, "Unable to resolve active catalogue profile");
    const profiles = (data ?? []) as Array<{
      id: string;
      is_default?: boolean | null;
      created_at?: string | null;
    }>;
    const requested = profiles.find((profile) => profile.id === requestedProfileId);
    if (requested) {
      if (profiles.length <= 1) return requestedProfileId;
      const decision = await getEntitlementDecision(db, userId, { autoStartTrial: false });
      const activeIds = activeCatalogProfileIds(
        profiles,
        limitNumber(decision.limits, "profiles", 1),
      );
      if (!activeIds || activeIds.has(requestedProfileId)) return requestedProfileId;
    }
  }

  const { data, error } = await db
    .from("cloud_account_profiles")
    .select("id")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throwDb(error, "Unable to resolve default catalogue profile");
  return stringOrNull(data?.id);
}

async function listHomeRails(req: Request, url: URL, userId: string) {
  const limit = boundedInt(url.searchParams.get("limit"), 24, 1, 50);
  const lang = railLang(url);
  const type = url.searchParams.get("type");
  const includeSeries = !type || type === "series";
  const includeMovies = !type || type === "movie";
  const profilePromise = resolveCatalogProfileId(req, userId);
  const candidatePromises = new Map<"movie" | "series", Promise<JsonRecord[]>>();
  const candidatesFor = (itemType: "movie" | "series") => {
    let promise = candidatePromises.get(itemType);
    if (!promise) {
      promise = listVerifiedTitleCandidates(userId, itemType);
      candidatePromises.set(itemType, promise);
    }
    return promise;
  };
  const optionalRail = async (
    label: string,
    load: () => Promise<JsonRecord | null>,
  ): Promise<JsonRecord | null> => {
    try {
      return await load();
    } catch (error) {
      // Personalization is additive. A transient ratings/schema failure must
      // never take the whole Home experience down with it.
      console.warn("optional_home_rail_failed", {
        rail: label,
        code: publicErrorCode(error),
      });
      return null;
    }
  };

  // Fire every rail query in PARALLEL — they are independent reads. They used to run
  // as ~6 sequential awaits, so the endpoint's latency was the SUM of all rails; on a
  // big (or storm-bloated) catalogue that blew past the client's 150s idle timeout, so
  // /home/rails 504'd and Home fell back to "recent content" (the reported slow load).
  // Parallel = total ≈ the slowest single rail. (popular-movies is always fired as the
  // because-you-watched fallback and simply discarded when watch history exists — one
  // extra concurrent read, zero added wall-clock.)
  const when = <T>(cond: boolean, fn: () => Promise<T>): Promise<T | null> => (cond ? fn() : Promise.resolve(null));
  const [
    recentMovies,
    actionMovies,
    likedRail,
    watchedRail,
    popularMovies,
    popularSeries,
    recentSeries,
  ] = await Promise.all([
    when(includeMovies, () => listTitleRail(userId, "movie", "recently-added-movies", "Recently Added Movies", limit, lang)),
    when(includeMovies, () => listGenreRail(userId, "movie", "Action", "action-movies", "Action Movies", limit, lang, candidatesFor)),
    optionalRail("because_you_liked", async () => {
      const profileId = await profilePromise;
      return await listBecauseYouLikedRail(
        userId,
        profileId,
        { includeMovies, includeSeries, limit, lang, candidatesFor },
      );
    }),
    optionalRail("because_you_watched", async () => {
      const profileId = await profilePromise;
      return await listBecauseYouWatchedRail(
        userId,
        profileId,
        { includeMovies, includeSeries, limit, lang, candidatesFor },
      );
    }),
    when(includeMovies, () => listPopularTitleRail(userId, "movie", "popular-movies", "Popular Movies", limit, lang, candidatesFor)),
    when(includeSeries, () => listPopularTitleRail(userId, "series", "popular-series", "Popular Series", limit, lang, candidatesFor)),
    when(includeSeries, () => listTitleRail(userId, "series", "recently-added-series", "Recently Added Series", limit, lang)),
  ]);

  // Assemble in the intended display order.
  const rails: Array<JsonRecord | null> = [
    recentMovies,
    likedRail,
    actionMovies,
    watchedRail ?? popularMovies, // because-you-watched, else popular movies
    popularSeries,
    recentSeries,
  ];

  return {
    contract: "norva.home.rails.v1",
    rails: rails.filter((rail): rail is JsonRecord => !!rail && Array.isArray(rail.items) && rail.items.length > 0),
  };
}

// Netflix-style genre rails: one rail per curated genre bucket, built from the
// user's titles. Unlike listGenreRail (single TMDB genre, verified-only), this
// scans a broadened candidate set INCLUDING titles without a TMDB match — they
// carry a provider category name we can still classify — so niche buckets are
// not starved. classifyTitleBuckets maps each title onto one or more buckets.
// The active profile's hidden genre buckets (x-norva-profile-id header, else the
// default profile). Resilient: any error → empty set (no filtering).
async function getHiddenGenres(req: Request, userId: string): Promise<Set<string>> {
  try {
    const headerId = req.headers.get("x-norva-profile-id");
    let row: JsonRecord | null = null;
    if (headerId) {
      const { data } = await db
        .from("cloud_account_profiles")
        .select("hidden_genres")
        .eq("id", headerId)
        .eq("user_id", userId)
        .maybeSingle();
      row = (data as JsonRecord | null) ?? null;
    }
    if (!row) {
      const { data } = await db
        .from("cloud_account_profiles")
        .select("hidden_genres")
        .eq("user_id", userId)
        .order("is_default", { ascending: false })
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      row = (data as JsonRecord | null) ?? null;
    }
    const arr = row && Array.isArray(row.hidden_genres) ? row.hidden_genres : [];
    return new Set(arr.map((g) => String(g)));
  } catch (_) {
    return new Set<string>();
  }
}

// Counts of titles per curated genre bucket across the catalog, plus the
// profile's currently-hidden buckets. Powers the Manage Content genre view.
async function listGenreSummary(req: Request, url: URL, userId: string) {
  const itemType = url.searchParams.get("type") === "series" ? "series" : "movie";

  // Optional provider scope: Manage Content lets the user filter the genre view
  // to a single provider. A blank / "all" value (or any non-UUID) means every
  // provider. Validated as a UUID so we never pass junk into the RPC.
  const sourceParam = (url.searchParams.get("source") || "").trim();
  const sourceId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceParam)
      ? sourceParam
      : null;

  // Per-bucket BROWSABLE counts (variant_count > 0) straight from the denormalised
  // genre_buckets column via cloud_genre_bucket_counts — so the genre-picker numbers
  // equal exactly what the "See all" grid shows (both read genre_buckets over the whole
  // catalogue). The old path counted variant-less rows and classified in the edge, so
  // its numbers ran far ahead of the grid (e.g. 819 in the picker, 4 in the grid).
  const counts = new Map<string, number>();

  // Fast path: precomputed per-user summary (all sources), refreshed by cron at sync cadence — an
  // instant single-row read instead of the ~4.6s live group-by over a 335k catalogue. The optional
  // per-source view (Manage Content) isn't summarised, so it falls back to the live RPC below.
  let usedSummary = false;
  if (!sourceId) {
    try {
      const { data } = await db.from("cloud_catalog_facet_summary")
        .select("genre_bucket_counts").eq("user_id", userId).eq("item_type", itemType).maybeSingle();
      const gbc = (data?.genre_bucket_counts ?? null) as Record<string, unknown> | null;
      if (gbc && typeof gbc === "object") {
        for (const [bucketId, rawN] of Object.entries(gbc)) {
          const n = Number(rawN) || 0;
          if (bucketId && n > 0) counts.set(bucketId, n);
        }
        usedSummary = true;
      }
    } catch (_) { /* fall through to the live RPC */ }
  }

  if (!usedSummary) {
    try {
      const rpcArgs: Record<string, unknown> = { p_user_id: userId, p_item_type: itemType };
      if (sourceId) rpcArgs.p_source_id = sourceId;
      const { data, error } = await db.rpc("cloud_genre_bucket_counts", rpcArgs);
      if (error) {
        if (isMissingMaterialization(error)) return { type: itemType, genres: [], hidden: [] };
        throwDb(error, "Unable to summarise genres");
      }
      for (const row of (data ?? []) as Array<{ bucket?: unknown; n?: unknown }>) {
        const bucketId = String(row.bucket ?? "");
        const n = Number(row.n) || 0;
        if (bucketId && n) counts.set(bucketId, n);
      }
    } catch (error) {
      if (isMissingMaterialization(error)) return { type: itemType, genres: [], hidden: [] };
      throw error;
    }
  }

  // Older cached summaries and the source-scoped RPC intentionally omitted the
  // fallback bucket. That made a sizeable part of real provider catalogues
  // impossible to reach from the category picker ("Other" is ~10% for a typical
  // large account). Count it directly through the GIN-indexed genre_buckets
  // column when it is absent. visible_source_ids is computed only from visible
  // variants, so source-scoped counts cannot pull staging catalogue rows in.
  if (!counts.has("autres")) {
    let q: any = db.from("cloud_catalog_visible_titles").select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .gt("variant_count", 0)
      .contains("genre_buckets", ["autres"]);
    if (sourceId) q = q.contains("visible_source_ids", [sourceId]);
    const { count, error } = await q;
    if (!error && Number(count) > 0) counts.set("autres", Number(count));
  }

  const hidden = await getHiddenGenres(req, userId);
  // A visible bucket can overlap a hidden one. genre-items drops such titles
  // entirely, so recompute the small set of visible counts when profile hiding
  // is active; otherwise the picker advertises more results than its grid can
  // legally return. Normal profiles stay on the single cached summary read.
  if (hidden.size) {
    await Promise.all([...counts.keys()]
      .filter((bucketId) => !hidden.has(bucketId))
      .map(async (bucketId) => {
        let q: any = db.from("cloud_catalog_visible_titles").select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("item_type", itemType)
          .gt("variant_count", 0)
          .contains("genre_buckets", [bucketId])
          .not("genre_buckets", "ov", `{${[...hidden].join(",")}}`);
        if (sourceId) q = q.contains("visible_source_ids", [sourceId]);
        const { count, error } = await q;
        if (!error) counts.set(bucketId, Number(count) || 0);
      }));
  }
  const genres = BUCKET_ORDER
    .filter((bucketId) => !hidden.has(bucketId) && (counts.get(bucketId) ?? 0) > 0)
    .map((bucketId) => ({
      bucket: bucketId,
      label: bucketLabel(bucketId),
      count: counts.get(bucketId) ?? 0,
      hidden: hidden.has(bucketId),
    }));

  return { type: itemType, source: sourceId, genres, hidden: [...hidden] };
}

// A rail with fewer cards than this is dropped: a 1-2 card row reads as "that's
// all there is" (usually false — the bucket is just rare in the scan window) and
// wastes a whole viewport row. The bucket stays reachable via the genre picker.
const GENRE_RAIL_MIN_ITEMS = 4;
// A title may appear in at most this many rails. classifyTitleBuckets is
// deliberately multi-membership (Comedy+Drama+SciFi), but unbounded reuse made
// the same handful of recent titles repeat across 3+ visible rows.
const GENRE_RAIL_MAX_APPEARANCES = 2;

async function listGenreRails(req: Request, url: URL, userId: string) {
  const itemType = url.searchParams.get("type") === "series" ? "series" : "movie";
  const lang = railLang(url);
  const perRail = boundedInt(url.searchParams.get("limit"), 18, 1, 50);

  // Per-profile hidden genres: a title with ANY hidden bucket is dropped from
  // the whole catalog (so e.g. a Kids profile sees no Horror anywhere).
  const hidden = await getHiddenGenres(req, userId);
  const candidateBuckets = BUCKET_ORDER.filter((b) => b !== "autres" && !hidden.has(b));

  // Per-bucket, index-backed candidate fetch (genre_buckets @> {bucket}) over the
  // WHOLE catalogue — not a recency window. The old scan only saw the newest ~few-k
  // synced titles, so a bucket whose members were older/less-recently-enriched
  // rendered near-empty. genre_buckets is the denormalised curated-bucket set
  // (migration 20260704160000); the GIN index makes each of these cheap. We pull a
  // buffer (perRail * 3) newest-by-created_at per bucket so the cross-rail dedup
  // below still has enough to fill each row. Narrow select (id + buckets), so the
  // heavy metadata is detoasted only for the final chosen ids.
  const buffer = perRail * 3;
  let candidateSets: Array<{ bucket: string; rows: JsonRecord[] }>;
  try {
    candidateSets = await Promise.all(candidateBuckets.map(async (bucket) => {
      let q = db
        .from("cloud_catalog_visible_titles")
        .select("id, genre_buckets, created_at")
        .eq("user_id", userId)
        .eq("item_type", itemType)
        .gt("variant_count", 0)
        // A rail is a curated preview — only titles with artwork belong in it (a
        // TMDB-matched title always has a poster; an un-enriched one shows a blank
        // placeholder). The genre picker / "See all" grid still exposes everything.
        .not("poster_url", "is", null)
        .contains("genre_buckets", [bucket]);
      // Avoid an excessively-deep postgrest-js generic instantiation on this
      // dynamically assembled overlap filter; runtime query semantics are unchanged.
      if (hidden.size) q = (q as any).not("genre_buckets", "ov", `{${[...hidden].join(",")}}`);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(buffer);
      if (error) {
        if (isMissingMaterialization(error)) return { bucket, rows: [] as JsonRecord[] };
        throwDb(error, "Unable to list genre rail candidates");
      }
      return { bucket, rows: (data ?? []) as JsonRecord[] };
    }));
  } catch (error) {
    if (isMissingMaterialization(error)) return { contract: "norva.genre.rails.v1", type: itemType, rails: [] };
    throw error;
  }

  // A row's genre_buckets are already display-ordered and hidden-filtered by the
  // query; keep the same buckets each candidate belongs to for the dedup budget.
  const rowById = new Map<string, JsonRecord>();
  const bucketsOf = new Map<string, string[]>();
  const orderIndex = new Map<string, number>(); // recency rank within its bucket fetch
  for (const { rows } of candidateSets) {
    rows.forEach((row, i) => {
      const id = String(row.id);
      if (!rowById.has(id)) {
        rowById.set(id, row);
        const bs = Array.isArray(row.genre_buckets)
          ? (row.genre_buckets as unknown[]).map(String).filter((b) => b !== "autres" && !hidden.has(b))
          : [];
        bucketsOf.set(id, bs);
        orderIndex.set(id, i);
      }
    });
  }
  // Iterate candidates newest-first (created_at desc) for stable, resync-proof rows.
  const orderedIds = [...rowById.keys()].sort((a, b) =>
    String(rowById.get(b)!.created_at ?? "").localeCompare(String(rowById.get(a)!.created_at ?? "")));

  // Two-pass assignment with a cross-rail duplicate budget.
  // Pass 1 — each title fills ONE rail (its first bucket with a free slot).
  const byBucket = new Map<string, string[]>();
  const appearances = new Map<string, number>();
  for (const id of orderedIds) {
    for (const bucketId of bucketsOf.get(id) ?? []) {
      const list = byBucket.get(bucketId) ?? [];
      if (list.length >= perRail) continue;
      list.push(id);
      byBucket.set(bucketId, list);
      appearances.set(id, 1);
      break;
    }
  }
  // Pass 2 — top up still-short rails with bounded second appearances.
  for (const bucketId of candidateBuckets) {
    const list = byBucket.get(bucketId);
    if (!list || list.length >= perRail) continue;
    const present = new Set(list);
    for (const id of orderedIds) {
      if (list.length >= perRail) break;
      if (present.has(id)) continue;
      if ((appearances.get(id) ?? 0) >= GENRE_RAIL_MAX_APPEARANCES) continue;
      if (!(bucketsOf.get(id) ?? []).includes(bucketId)) continue;
      list.push(id);
      present.add(id);
      appearances.set(id, (appearances.get(id) ?? 0) + 1);
    }
  }

  // Batch-fetch the FULL rows only for the chosen ids (metadata detoast bounded).
  const selectedIds = [...new Set([...byBucket.values()].flat())];
  const fullRows = await hydrateVisibleCatalogTitlesByIds(
    userId,
    selectedIds,
    requiredCatalogTitleVisibilityEpoch(userId),
  );
  const fullById = new Map(fullRows.map((row) => [String(row.id), row]));
  const selectedRows = selectedIds.map((id) => fullById.get(id)).filter((r): r is JsonRecord => !!r);
  const variantsByTitle = await listVariantsByTitleIds(selectedIds, userId);
  await applyCatalogOverlay(selectedRows, itemType, lang); // full or safe text-only overlay

  const rails = candidateBuckets
    .filter((bucketId) => (byBucket.get(bucketId)?.length ?? 0) >= GENRE_RAIL_MIN_ITEMS)
    .map((bucketId) => ({
      id: `genre-${bucketId}`,
      title: bucketLabel(bucketId),
      itemType,
      source: "titles",
      curation: { kind: "genre_bucket", bucket: bucketId },
      items: (byBucket.get(bucketId) ?? [])
        .map((id) => fullById.get(id))
        .filter((row): row is JsonRecord => !!row)
        .map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
    }));

  return { contract: "norva.genre.rails.v1", type: itemType, rails };
}

// Full, paged list of one curated genre bucket (the rail's "Tout voir" / See
// all). Same shape as listMediaItems so the client grid consumes it unchanged.
// --- Exact provider-file language filtering ------------------------------------
// Audio AND soft-subtitle filters are strict: each value comes from the exact
// ffprobe-backed file union for this user's title. Release-name tags such as
// vf/multi/vostfr and global TMDB-level hints intentionally never drive filters.

function normalizeFacet(value: string | null): string | null {
  const v = (value || "").toLowerCase().trim();
  return /^[a-z]{2,10}$/.test(v) ? v : null;
}
// Filter-bar decade value -> inclusive release_year range. Mirrors the client's
// Year dropdown: a decade start ("2020", "2010", …) or "old" (before 1990).
function decadeRange(value: string | null): { min: number; max: number } | null {
  const v = (value || "").toLowerCase().trim();
  if (!v) return null;
  if (v === "old") return { min: 1800, max: 1989 };
  const start = Number.parseInt(v, 10);
  if (!Number.isInteger(start) || start < 1900 || start > 2100 || start % 10 !== 0) return null;
  return { min: start, max: start + 9 };
}
// Query-param float, null when absent/blank/garbage (Number(null) is 0 — never
// let a missing minRating silently become "rating >= 0").
function paramNumber(value: string | null): number | null {
  const v = (value || "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Canonicalize the two ISO-639 representations providers commonly mix. Facet
// requests use ISO-639-1 (`fr`) while ffprobe/container tags often use
// ISO-639-2 (`fra`/`fre`). Comparing the raw strings can select the wrong sibling.
const FILE_LANGUAGE_ALIASES: Record<string, string> = {
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
function canonicalFileLanguage(value: unknown): string | null {
  const raw = String(value ?? "").toLowerCase().trim().split(/[-_]/)[0];
  if (!raw || ["und", "un", "mis", "mul", "zxx", "nar"].includes(raw)) return null;
  const code = FILE_LANGUAGE_ALIASES[raw] || raw;
  return /^[a-z]{2}$/.test(code) ? code : null;
}
function canonicalFileLanguages(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const code = canonicalFileLanguage(value);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
function publicFileTrackLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return canonicalFileLanguages(
    value.map((track) => recordOrEmpty(track).lang ?? recordOrEmpty(track).language),
  );
}

// Audio/subtitle facet values are ISO-639 codes from exact provider-file unions
// owned by this user (file_audio_languages / file_subtitle_languages). Legacy or
// global title hints never drive strict filters.
function audioFacetIso(facet: string | null): string | null {
  return canonicalFileLanguage(facet);
}
function titleVersionLanguages(title: JsonRecord): string[] {
  const raw = (title as { version_languages?: unknown }).version_languages;
  return Array.isArray(raw) ? raw.map((tag) => String(tag).toLowerCase()) : [];
}
function titleAudioLanguages(title: JsonRecord): string[] {
  // Exact union of provider files owned by this user. The legacy
  // audio_languages field can be inherited globally by TMDB id.
  const raw = (title as { file_audio_languages?: unknown }).file_audio_languages;
  return canonicalFileLanguages(raw);
}
function titleVerifiedAudioLanguages(title: JsonRecord): string[] {
  const raw = (title as { file_audio_verified_languages?: unknown }).file_audio_verified_languages;
  return canonicalFileLanguages(raw);
}
// Exact union of soft-subtitle languages across provider files owned by this
// user. Absolute subtitle stream indices remain file-scoped.
function titleSubtitleLanguages(title: JsonRecord): string[] {
  const raw = (title as { file_subtitle_languages?: unknown }).file_subtitle_languages;
  return canonicalFileLanguages(raw);
}
// When the catalogue is scoped to one provider, the title-level arrays above
// are too broad: they are the union of every owned variant. Load exact per-file
// observations through explicit visible-variant keys; views deliberately do
// not rely on PostgREST embedded relationships.
function titleSourceObservationLanguages(title: JsonRecord, key: "audio_languages" | "subtitle_languages"): string[] {
  return canonicalFileLanguages(title[`__source_${key}`]);
}

async function attachSourceObservationLanguages(
  titles: JsonRecord[],
  userId: string,
  sourceId: string,
): Promise<void> {
  const titleIds = [...new Set(titles.map((title) => String(title.id ?? "")).filter(Boolean))];
  if (!titleIds.length) return;

  const variantTitleById = new Map<string, string>();
  for (let index = 0; index < titleIds.length; index += TITLE_VARIANT_QUERY_CHUNK) {
    const { data, error } = await db
      .from("cloud_catalog_visible_title_variants")
      .select("id,title_id")
      .eq("user_id", userId)
      .eq("source_id", sourceId)
      .in("title_id", titleIds.slice(index, index + TITLE_VARIANT_QUERY_CHUNK));
    if (error) throwDb(error, "Unable to load source language variants");
    for (const variant of (data ?? []) as JsonRecord[]) {
      const variantId = String(variant.id ?? "");
      const titleId = String(variant.title_id ?? "");
      if (variantId && titleId) variantTitleById.set(variantId, titleId);
    }
  }

  const audioByTitle = new Map<string, unknown[]>();
  const subtitlesByTitle = new Map<string, unknown[]>();
  const variantIds = [...variantTitleById.keys()];
  for (let index = 0; index < variantIds.length; index += TITLE_VARIANT_QUERY_CHUNK) {
    const { data, error } = await db
      .from("cloud_title_file_language_observations")
      .select("variant_id,audio_languages,subtitle_languages")
      .eq("user_id", userId)
      .in("variant_id", variantIds.slice(index, index + TITLE_VARIANT_QUERY_CHUNK));
    if (error) throwDb(error, "Unable to load source language observations");
    for (const observation of (data ?? []) as JsonRecord[]) {
      const titleId = variantTitleById.get(String(observation.variant_id ?? ""));
      if (!titleId) continue;
      const audio = audioByTitle.get(titleId) ?? [];
      if (Array.isArray(observation.audio_languages)) audio.push(...observation.audio_languages);
      audioByTitle.set(titleId, audio);
      const subtitles = subtitlesByTitle.get(titleId) ?? [];
      if (Array.isArray(observation.subtitle_languages)) subtitles.push(...observation.subtitle_languages);
      subtitlesByTitle.set(titleId, subtitles);
    }
  }

  for (const title of titles) {
    const titleId = String(title.id ?? "");
    title.__source_audio_languages = canonicalFileLanguages(audioByTitle.get(titleId) ?? []);
    title.__source_subtitle_languages = canonicalFileLanguages(subtitlesByTitle.get(titleId) ?? []);
  }
}

async function visibleTitleIdsBySourceLanguages(
  userId: string,
  itemType: "movie" | "series",
  sourceId: string,
  audioIso: string | null,
  subtitleIso: string | null,
): Promise<string[]> {
  const titleIds = new Set<string>();
  for (let offset = 0;; offset += VISIBLE_TITLE_ID_PAGE_SIZE) {
    const { data, error } = await db.rpc("cloud_catalog_visible_title_ids_by_source_languages", {
      p_user_id: userId,
      p_item_type: itemType,
      p_source_id: sourceId,
      p_audio_language: audioIso,
      p_subtitle_language: subtitleIso,
    })
      .order("title_id", { ascending: true })
      .range(offset, offset + VISIBLE_TITLE_ID_PAGE_SIZE - 1);
    if (error) throwDb(error, "Unable to filter visible source languages");
    const rows = (data ?? []) as JsonRecord[];
    for (const row of rows) {
      const titleId = String(row.title_id ?? "");
      if (titleId) titleIds.add(titleId);
    }
    if (rows.length < VISIBLE_TITLE_ID_PAGE_SIZE) break;
  }
  return [...titleIds];
}
// Distinct ISO-639 languages from a legacy title-level ordered map. Exact menus,
// filters, and sorting use file_audio_languages instead.
function titleAudioTrackLanguages(title: JsonRecord): string[] {
  const raw = (title as { audio_tracks?: unknown }).audio_tracks;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const track of raw) {
    const lang = (track as { lang?: unknown } | null)?.lang;
    if (typeof lang === "string") {
      const code = canonicalFileLanguage(lang);
      if (code && !out.includes(code)) out.push(code);
    }
  }
  return out;
}
// Ordered per-track audio map (absolute ffmpeg stream index -> ISO-639-1 or null), in
// stream order. Lets the in-browser engine label each demuxed audio stream by index
// with ZERO playback-time probe. Empty when not yet captured.
function titleAudioTracks(title: JsonRecord): Array<{ index: number; lang: string | null }> {
  const raw = (title as { audio_tracks?: unknown }).audio_tracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const r = (t ?? {}) as JsonRecord;
      const index = Number(r.index);
      const lang = r.lang == null ? null : String(r.lang).toLowerCase().trim();
      return { index, lang: lang && /^[a-z]{2}$/.test(lang) ? lang : null };
    })
    .filter((t) => Number.isInteger(t.index));
}
// "Best for my languages": a preferred-audio match outweighs a preferred-subtitle
// match; ties keep the incoming (recency) order via the stable index tiebreaker.
function languageMatchRank(subtitleLangs: string[], audioLangs: string[], prefAudioIso: string | null, prefSubIso: string | null): number {
  let rank = 0;
  if (prefAudioIso && audioLangs.includes(prefAudioIso)) rank += 2;
  if (prefSubIso && subtitleLangs.includes(prefSubIso)) rank += 1;
  return rank;
}

function genreTitleSortColumn(sort: string): string {
  return sort === "year-asc" ? "release_year" :
    sort === "rating" ? "rating_num" :
    sort === "added" ? "created_at" :
    sort === "name" ? "title" :
    sort === "year" ? "release_year" :
    "poster_url";
}

function applyGenreTitleOrder(q: any, sort: string) {
  return q
    .order(genreTitleSortColumn(sort), {
      ascending: sort === "year-asc" || sort === "name",
      nullsFirst: false,
    })
    .order(sort === "default" ? "created_at" : "id", { ascending: sort !== "default" })
    .order("id", { ascending: true });
}

function compareGenreTitleValues(left: unknown, right: unknown, ascending: boolean): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  const leftNumber = typeof left === "number" ? left : Number.NaN;
  const rightNumber = typeof right === "number" ? right : Number.NaN;
  const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? leftNumber - rightNumber
    : String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  return ascending ? comparison : -comparison;
}

function compareGenreTitles(left: JsonRecord, right: JsonRecord, sort: string): number {
  const primaryAscending = sort === "year-asc" || sort === "name";
  const primary = compareGenreTitleValues(
    left[genreTitleSortColumn(sort)],
    right[genreTitleSortColumn(sort)],
    primaryAscending,
  );
  if (primary) return primary;
  if (sort === "default") {
    const created = compareGenreTitleValues(left.created_at, right.created_at, false);
    if (created) return created;
  }
  return compareGenreTitleValues(left.id, right.id, true);
}

async function listGenreItems(req: Request, url: URL, userId: string) {
  const itemType = url.searchParams.get("type") === "series" ? "series" : "movie";
  const lang = railLang(url);
  const bucketParam = (url.searchParams.get("bucket") || "").trim();
  // "all" = no genre constraint. Otherwise the category picker may send
  // several curated buckets as a comma-separated list. They are OR-ed so the
  // multi-select never silently degrades to its first value.
  const requestedBuckets = bucketParam === "all"
    ? []
    : [...new Set(bucketParam.split(",").map((value) => value.trim()).filter(Boolean))];
  const limit = boundedInt(url.searchParams.get("limit"), 36, 1, 100);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const candidateLimit = boundedInt(url.searchParams.get("candidates"), 6000, 100, 8000);
  if (!bucketParam) throw new HttpError(400, "Missing bucket");
  if (requestedBuckets.some((bucket) => !BUCKET_ORDER.includes(bucket))) {
    throw new HttpError(400, "Invalid genre bucket");
  }

  const sourceParam = (url.searchParams.get("source") || "").trim();
  const sourceId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceParam)
      ? sourceParam
      : null;

  // Optional exact audio/soft-subtitle filters + "best for my languages"
  // sort. All additive: absent → the query and result are identical to before.
  const audioFacet = normalizeFacet(url.searchParams.get("audio"));
  const audioIso = audioFacetIso(audioFacet);
  const subIso = audioFacetIso(normalizeFacet(url.searchParams.get("subs")));
  const sort = (url.searchParams.get("sort") || "default").trim() || "default";
  const langSort = sort === "lang-match";
  const prefAudioIso = langSort ? audioFacetIso(normalizeFacet(url.searchParams.get("prefAudio"))) : null;
  const prefSubIso = langSort ? audioFacetIso(normalizeFacet(url.searchParams.get("prefSubs"))) : null;
  // Decade / minimum-rating filters so the whole filter bar works inside a genre
  // ("See all") or language grid — before, Year/Rating were silently ignored there.
  const yearRange = decadeRange(url.searchParams.get("year"));
  const minRating = paramNumber(url.searchParams.get("minRating"));
  const addedDays = boundedInt(url.searchParams.get("addedDays"), 0, 0, 3650);
  const addedAfterDate = addedDays > 0
    ? new Date(Date.now() - addedDays * 86_400_000).toISOString()
    : null;
  // Optional text search so it composes with the language grid (the "all" bucket).
  const search = (url.searchParams.get("q") || "").trim();

  const hasStrictLanguageFilter = Boolean(audioIso || subIso);
  const needsSourceLanguageEvidence = Boolean(
    sourceId && (hasStrictLanguageFilter || prefAudioIso || prefSubIso),
  );

  const hidden = await getHiddenGenres(req, userId);
  // The bucket itself is hidden → nothing to show.
  const buckets = requestedBuckets.filter((bucket) => !hidden.has(bucket));
  if (requestedBuckets.length && !buckets.length) {
    return { items: [], count: 0, limit, offset, hasMore: false };
  }

  // Build the shared SQL filter. genre_buckets is the denormalised curated-bucket
  // set (migration 20260704160000), GIN-indexed — so a bucket's grid is filtered
  // over the WHOLE catalogue by index, not classified in a recency-capped window.
  // Every dimension is now a real SQL predicate: exact per-file audio/subtitle unions,
  // year (release_year), rating (rating_num),
  // hidden genres (drop a title tagged with ANY hidden bucket — the "Kids profile
  // sees no Horror anywhere" rule).
  const applyFilters = (q: any) => {
    let out = q.eq("user_id", userId).eq("item_type", itemType).gt("variant_count", 0);
    if (buckets.length) out = out.overlaps("genre_buckets", buckets);
    if (sourceId) out = out.contains("visible_source_ids", [sourceId]);
    if (hidden.size) out = out.not("genre_buckets", "ov", `{${[...hidden].join(",")}}`);
    if (search) out = out.ilike("title", `%${search}%`);
    if (yearRange) out = out.gte("release_year", yearRange.min).lte("release_year", yearRange.max);
    if (minRating !== null) out = out.gte("rating_num", minRating);
    if (addedAfterDate !== null) out = out.gte("created_at", addedAfterDate);
    // Both filters use exact per-file evidence. With a selected provider, keep
    // the predicate inside that provider's variants instead of consulting the
    // title-wide union (which may contain languages owned by another source).
    if (audioIso && !sourceId) out = out.contains("file_audio_languages", [audioIso]);
    if (subIso && !sourceId) out = out.contains("file_subtitle_languages", [subIso]);
    return out;
  };

  try {
    const sourceLanguageTitleIds = sourceId && hasStrictLanguageFilter
      ? await visibleTitleIdsBySourceLanguages(userId, itemType, sourceId, audioIso, subIso)
      : null;
    if (sourceLanguageTitleIds && !sourceLanguageTitleIds.length) {
      return { items: [], count: 0, limit, offset, hasMore: false };
    }

    // "Best for my languages" sort needs an in-memory rank over the filtered set;
    // it's bounded by the (usually language/genre-narrowed) filter. Every other
    // view uses exact SQL count + range pagination over the whole catalogue.
    if (langSort && (prefAudioIso || prefSubIso)) {
      let rows: JsonRecord[] = [];
      const idBatches = sourceLanguageTitleIds
        ? Array.from({ length: Math.ceil(sourceLanguageTitleIds.length / TITLE_VARIANT_QUERY_CHUNK) }, (_, index) =>
          sourceLanguageTitleIds.slice(index * TITLE_VARIANT_QUERY_CHUNK, (index + 1) * TITLE_VARIANT_QUERY_CHUNK))
        : [null];
      for (const ids of idBatches) {
        let query = applyFilters(db.from("cloud_catalog_visible_titles").select("*"));
        if (ids) query = query.in("id", ids);
        const { data, error } = await query
          .order("created_at", { ascending: false })
          .limit(candidateLimit);
        if (error) {
          if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
          throwDb(error, "Unable to list genre items");
        }
        rows.push(...((data ?? []) as JsonRecord[]));
      }
      rows = rows
        .sort((left, right) => compareGenreTitleValues(left.created_at, right.created_at, false))
        .slice(0, candidateLimit);
      if (sourceId && needsSourceLanguageEvidence) {
        await attachSourceObservationLanguages(rows, userId, sourceId);
      }
      const ranked = rows
        .map((title, index) => ({
          title,
          index,
          rank: languageMatchRank(
            sourceId ? titleSourceObservationLanguages(title, "subtitle_languages") : titleSubtitleLanguages(title),
            sourceId ? titleSourceObservationLanguages(title, "audio_languages") : titleAudioLanguages(title),
            prefAudioIso,
            prefSubIso,
          ),
        }))
        .sort((a, b) => b.rank - a.rank || a.index - b.index)
        .map((entry) => entry.title);
      const pageRows = await hydrateVisibleCatalogTitlesByIds(
        userId,
        ranked.slice(offset, offset + limit).map((row) => String(row.id)),
        requiredCatalogTitleVisibilityEpoch(userId),
      );
      const variantsByTitle = await listVariantsByTitleIds(
        pageRows.map((row) => String(row.id)),
        userId,
        audioIso ? 24 : HOME_RAIL_VARIANT_LIMIT,
        audioIso,
        sourceId,
      );
      await applyCatalogOverlay(pageRows, itemType, lang);
      return {
        items: pageRows.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
        count: ranked.length,
        limit, offset,
        hasMore: offset + limit < ranked.length,
      };
    }

    let pageRows: JsonRecord[];
    let total: number | null;
    if (sourceLanguageTitleIds) {
      const mergedRows: JsonRecord[] = [];
      let exactTotal = 0;
      const requiredRowsPerBatch = offset + limit;
      for (let index = 0; index < sourceLanguageTitleIds.length; index += TITLE_VARIANT_QUERY_CHUNK) {
        const ids = sourceLanguageTitleIds.slice(index, index + TITLE_VARIANT_QUERY_CHUNK);
        const query = applyGenreTitleOrder(
          applyFilters(db.from("cloud_catalog_visible_titles").select("*", { count: "exact" })).in("id", ids),
          sort,
        );
        const { data, count, error } = await query.range(0, requiredRowsPerBatch - 1);
        if (error) {
          if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
          throwDb(error, "Unable to list genre items");
        }
        exactTotal += count ?? 0;
        mergedRows.push(...((data ?? []) as JsonRecord[]));
      }
      mergedRows.sort((left, right) => compareGenreTitles(left, right, sort));
      pageRows = mergedRows.slice(offset, offset + limit);
      total = exactTotal;
    } else {
      const { data, count, error } = await applyGenreTitleOrder(
        applyFilters(db.from("cloud_catalog_visible_titles").select("*", { count: "exact" })),
        sort,
      ).range(offset, offset + limit - 1);
      if (error) {
        if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
        throwDb(error, "Unable to list genre items");
      }
      pageRows = (data ?? []) as JsonRecord[];
      total = count ?? null;
    }
    pageRows = await hydrateVisibleCatalogTitlesByIds(
      userId,
      pageRows.map((row) => String(row.id)),
      requiredCatalogTitleVisibilityEpoch(userId),
    );
    const variantsByTitle = await listVariantsByTitleIds(
      pageRows.map((row) => String(row.id)),
      userId,
      audioIso ? 24 : HOME_RAIL_VARIANT_LIMIT,
      audioIso,
      sourceId,
    );
    await applyCatalogOverlay(pageRows, itemType, lang);
    return {
      items: pageRows.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
      count: total,
      limit, offset,
      hasMore: total !== null ? offset + limit < total : pageRows.length === limit,
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
    throw error;
  }
}

// Dynamic menu options: which exact audio / soft-subtitle languages exist across
// this user's provider files, so the dropdowns only show real choices.
// In-isolate memo for the language-facets endpoint. listLanguageFacets fires ~25
// count-queries per call, all per-user + per-item_type. Caching the result briefly
// stops repeated page loads (and many concurrent users at scale) from re-running the
// burst. 60s TTL bounds crawl staleness — a newly-resolved language shows up in the
// dropdown within a minute; the actual grid (listGenreItems) is uncached and always
// exact, so a momentarily-missing option never yields wrong results. Bounded LRU: Map
// preserves insertion order, delete+set bumps recency, oldest evicted past the cap.
const FACET_CACHE = new Map<string, { value: { audio: unknown[]; subtitles: unknown[] }; exp: number }>();
const FACET_CACHE_TTL_MS = 60_000;
const FACET_CACHE_MAX = 512;
const FACET_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const FACET_NUMBER = new Intl.NumberFormat("en-US");

function languageFacetLabel(value: string, count: number, itemType: "movie" | "series"): string {
  let name = value.toUpperCase();
  try { name = FACET_LANGUAGE_NAMES.of(value) || name; } catch (_) { /* keep ISO */ }
  const noun = itemType === "series" ? "series" : "movies";
  return `${name} · ${FACET_NUMBER.format(count)} ${noun}`;
}

function exactLanguageFacetItems(
  raw: unknown,
  itemType: "movie" | "series",
): Array<{ value: string; label: string; count: number }> {
  const counts = recordOrEmpty(raw);
  return Object.entries(counts)
    .map(([value, count]) => ({ value: value.toLowerCase(), count: Math.max(0, Number(count) || 0) }))
    .filter((item) =>
      /^[a-z]{2,3}$/.test(item.value) &&
      !["un", "und", "mul", "zxx", "mis", "nar"].includes(item.value) &&
      item.count > 0
    )
    .map((item) => ({ ...item, label: languageFacetLabel(item.value, item.count, itemType) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function listLanguageFacets(req: Request, url: URL, userId: string) {
  const itemType: "movie" | "series" = url.searchParams.get("type") === "series" ? "series" : "movie";
  const rawSource = (url.searchParams.get("source") || url.searchParams.get("sourceId") || "").trim();
  const sourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSource)
    ? rawSource
    : null;
  // A caller that explicitly selected a provider must never receive the global
  // counts because its local/provider id was malformed or not mapped yet.
  if (rawSource && !sourceId) return { audio: [], subtitles: [] };

  const cacheEpoch = boundCatalogCacheEpoch(req);
  const cacheKey = cacheEpoch
    ? `${userId}:${cacheEpoch}:${itemType}:${sourceId || "all"}`
    : null;
  const nowMs = Date.now();
  const hit = cacheKey ? FACET_CACHE.get(cacheKey) : null;
  if (hit && hit.exp > nowMs) {
    FACET_CACHE.delete(cacheKey); // LRU bump
    FACET_CACHE.set(cacheKey, hit);
    return hit.value;
  }

  // The facet set math runs in Postgres over file_audio_languages and
  // file_subtitle_languages. Counts are exact per title and deserialize as jsonb.
  let value: { audio: unknown[]; subtitles: unknown[] } = { audio: [], subtitles: [] };
  try {
    const rpcName = sourceId
      ? "cloud_exact_language_counts_by_source"
      : "cloud_exact_language_counts";
    const rpcArgs = sourceId
      ? { p_user_id: userId, p_item_type: itemType, p_source_id: sourceId }
      : { p_user_id: userId, p_item_type: itemType };
    const { data, error } = await db.rpc(rpcName, rpcArgs);
    if (!error && data && typeof data === "object") {
      const d = data as { audio?: unknown; subtitles?: unknown };
      value = {
        audio: exactLanguageFacetItems(d.audio, itemType),
        subtitles: exactLanguageFacetItems(d.subtitles, itemType),
      };
    } else if (!sourceId) {
      // Rolling-deploy compatibility while the database migration lands.
      const legacy = await db.rpc("cloud_language_facets", { p_user_id: userId, p_item_type: itemType });
      const d = legacy.data as { audio?: unknown; subtitles?: unknown } | null;
      value = {
        audio: Array.isArray(d?.audio) ? d.audio : [],
        subtitles: Array.isArray(d?.subtitles) ? d.subtitles : [],
      };
    }
  } catch (_) { /* leave the menus empty (falls back to the static <option>s) on any failure */ }

  if (cacheKey) {
    FACET_CACHE.set(cacheKey, { value, exp: nowMs + FACET_CACHE_TTL_MS });
    if (FACET_CACHE.size > FACET_CACHE_MAX) {
      const oldest = FACET_CACHE.keys().next().value; // oldest insertion = least-recently used
      if (oldest !== undefined) FACET_CACHE.delete(oldest);
    }
  }
  return value;
}

// Capture audio/subtitle languages observed by a client for one owned provider
// file. Client JSON is tenant-local only: it may update this user's title union
// and a true mono-movie legacy map, but never a global file/title cache or fanout.
// Legacy title-only callers are accepted solely for a truly single-variant movie.
async function recordObservedLanguages(req: Request, userId: string) {
  let body: JsonRecord;
  try { body = recordOrEmpty(await req.json()); } catch (_) { throw new HttpError(400, "Invalid JSON body"); }
  const titleId = stringOrNull(body.titleId ?? body.title_id);
  if (!titleId || !/^[0-9a-f-]{36}$/i.test(titleId)) throw new HttpError(400, "Missing or invalid titleId");

  const requestedSourceId = stringOrNull(
    body.cloudSourceId ?? body.cloud_source_id ?? body.sourceId ?? body.source_id,
  );
  const requestedTypeRaw = stringOrNull(body.itemType ?? body.item_type)?.toLowerCase() ?? null;
  if (requestedTypeRaw && requestedTypeRaw !== "movie" && requestedTypeRaw !== "series") {
    throw new HttpError(400, "Invalid itemType");
  }
  const requestedExternalId = stringOrNull(
    body.externalId ?? body.external_id ?? body.itemId ?? body.item_id,
  );
  const requestedParentExternalId = stringOrNull(
    body.parentExternalId ?? body.parent_external_id ??
      body.audioSeriesId ?? body.audio_series_id ?? body.seriesId ?? body.series_id,
  );
  const hasFileCoordinates = Boolean(
    requestedSourceId || requestedTypeRaw || requestedExternalId || requestedParentExternalId,
  );

  const cleanLanguage = (value: unknown): string | null => {
    const lang = typeof value === "string" ? value.toLowerCase().trim() : "";
    return /^[a-z]{2,3}$/.test(lang) &&
        !["un", "und", "mul", "zxx", "mis", "nar"].includes(lang)
      ? lang
      : null;
  };
  const incoming = Array.isArray(body.audio) ? body.audio : [];
  const codes = [...new Set(incoming
    .map(cleanLanguage)
    .filter((code): code is string => Boolean(code)))];
  const rawAudioTracks = body.audioTracks ?? body.audio_tracks;
  const audioTracksScope = stringOrNull(body.audioTracksScope ?? body.audio_tracks_scope)?.toLowerCase() ?? null;
  // Only an explicitly file-scoped ordered map is authoritative evidence. Null
  // languages remain in the map so absolute index/position alignment survives.
  const orderedTracks = Array.isArray(rawAudioTracks)
    ? (rawAudioTracks as unknown[])
        .map((t) => {
          const r = recordOrEmpty(t);
          const index = Number(r.index);
          return { index, lang: cleanLanguage(r.lang ?? r.language) };
        })
        .filter((t) => Number.isInteger(t.index) && t.index >= 0 && t.index <= 1024)
    : [];
  const rawSubtitleTracks = body.subtitleTracks ?? body.subtitle_tracks ?? body.subtitles;
  const subtitleTracksScope = stringOrNull(
    body.subtitleTracksScope ?? body.subtitle_tracks_scope,
  )?.toLowerCase() ?? null;
  const subtitleTracksArrayProvided = Array.isArray(rawSubtitleTracks);
  const orderedSubtitleTracks = subtitleTracksArrayProvided
    ? (rawSubtitleTracks as unknown[])
        .map((entry) => {
          const track = recordOrEmpty(entry);
          const index = Number(track.index);
          return {
            index,
            lang: cleanLanguage(track.lang ?? track.language),
            codec: stringOrNull(track.codec ?? track.codecName ?? track.codec_name),
            subtitleType: stringOrNull(track.subtitleType ?? track.subtitle_type),
            extractable: track.extractable === true,
            forced: track.forced === true,
          };
        })
        .filter((track) => Number.isInteger(track.index) && track.index >= 0 && track.index <= 1024)
    : [];

  const observedCodes = [...new Set([
    ...codes,
    ...orderedTracks.map((track) => track.lang).filter((code): code is string => Boolean(code)),
  ])].sort();
  const hasExactAudioMap = audioTracksScope === "file" && orderedTracks.length > 0;
  const hasExactSubtitleMap = subtitleTracksScope === "file" && subtitleTracksArrayProvided;
  const hasLegacyAudioObservation = orderedTracks.length > 0 || observedCodes.length > 0;
  if (!hasLegacyAudioObservation && !hasExactSubtitleMap) return { ok: true, updated: false };

  const { data: titleData, error: titleError } = await db.from("cloud_catalog_visible_titles")
    .select("id,item_type,variant_count,audio_languages,audio_tracks,audio_probed_at,subtitle_tracks,subtitle_probed_at")
    .eq("user_id", userId)
    .eq("id", titleId)
    .maybeSingle();
  if (titleError) throwDb(titleError, "Unable to validate observed-language title");
  if (!titleData) return { ok: true, updated: false, reason: "title_not_owned" };
  const title = titleData as JsonRecord;
  const titleType = String(title.item_type ?? "") === "series" ? "series" : "movie";
  const itemType = requestedTypeRaw ?? titleType;
  if (itemType !== titleType) return { ok: true, updated: false, reason: "title_type_mismatch" };

  let variant: JsonRecord | null = null;
  let sourceId: string | null = requestedSourceId;
  let fileExternalId: string | null = requestedExternalId;
  let legacyDerived = false;

  if (hasFileCoordinates) {
    if (!sourceId || !fileExternalId || (itemType === "series" && !requestedParentExternalId)) {
      return { ok: true, updated: false, reason: "incomplete_file_coordinates" };
    }
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) {
      throw new HttpError(400, "Invalid cloudSourceId");
    }
    const variantExternalId = itemType === "series" ? requestedParentExternalId : fileExternalId;
    const { data, error } = await db.from("cloud_catalog_visible_title_variants")
      .select("id,user_id,title_id,source_id,item_type,external_id")
      .eq("user_id", userId)
      .eq("title_id", titleId)
      .eq("source_id", sourceId)
      .eq("item_type", itemType)
      .eq("external_id", variantExternalId)
      .limit(1)
      .maybeSingle();
    if (error) throwDb(error, "Unable to validate observed-language variant");
    variant = (data as JsonRecord | null) ?? null;
    if (!variant) return { ok: true, updated: false, reason: "variant_not_owned" };
  } else {
    // Old clients only sent titleId. Derive a file only when the title has one
    // movie variant; a grouped movie or series episode is inherently ambiguous.
    if (itemType !== "movie") {
      return { ok: true, updated: false, reason: "file_coordinates_required" };
    }
    const { data, error } = await db.from("cloud_catalog_visible_title_variants")
      .select("id,user_id,title_id,source_id,item_type,external_id")
      .eq("user_id", userId)
      .eq("title_id", titleId)
      .eq("item_type", "movie")
      .limit(2);
    if (error) throwDb(error, "Unable to validate legacy observed-language variant");
    const variants = (data ?? []) as JsonRecord[];
    if (variants.length !== 1) {
      return { ok: true, updated: false, reason: "file_coordinates_required" };
    }
    variant = variants[0];
    sourceId = stringOrNull(variant.source_id);
    fileExternalId = stringOrNull(variant.external_id);
    legacyDerived = true;
  }
  if (!variant || !sourceId || !fileExternalId) {
    return { ok: true, updated: false, reason: "file_coordinates_required" };
  }

  // Check the real sibling count instead of trusting a potentially stale rollup.
  const { data: siblingRows, error: siblingError } = await db.from("cloud_catalog_visible_title_variants")
    .select("id")
    .eq("user_id", userId)
    .eq("title_id", titleId)
    .eq("item_type", itemType)
    .limit(2);
  if (siblingError) throwDb(siblingError, "Unable to validate title variant count");
  const trueSingleMovie = itemType === "movie" &&
    (siblingRows ?? []).length === 1 &&
    String((siblingRows ?? [])[0]?.id ?? "") === String(variant.id ?? "");

  // Replace file evidence only from complete, explicitly file-scoped maps.
  // Selected-language codes and title/global hints are never authoritative.
  let unionMerged = false;
  if (hasExactAudioMap || hasExactSubtitleMap) {
    try {
      const { error } = await db.rpc("merge_cloud_title_file_languages", {
        p_user_id: userId,
        p_title_id: titleId,
        p_variant_id: variant.id,
        p_file_external_id: fileExternalId,
        p_audio_tracks: orderedTracks,
        p_subtitle_tracks: orderedSubtitleTracks,
        p_has_audio: hasExactAudioMap,
        p_has_subtitle: hasExactSubtitleMap,
      });
      unionMerged = !error;
    } catch (_) { /* rolling deploy: legacy single-movie update below remains safe */ }
  }

  // Legacy ordered maps remain valid only when title == exact movie file.
  // Grouped movies and every series keep their absolute indices out of the
  // title row. Trusted server probes own all global exact-file cache writes.
  let storedTracks = false;
  let legacyLanguagesChanged = false;
  let mergedLegacyLanguages = Array.isArray(title.audio_languages)
    ? (title.audio_languages as unknown[]).map((code) => String(code).toLowerCase())
    : [];
  if (trueSingleMovie) {
    const update: JsonRecord = {};
    const haveAudioTracks = Array.isArray(title.audio_tracks) && (title.audio_tracks as unknown[]).length > 0;
    if (!haveAudioTracks && hasExactAudioMap) {
      update.audio_tracks = orderedTracks;
      update.audio_probed_at = new Date().toISOString();
      storedTracks = true;
    }
    const haveSubtitleProbe = Boolean(title.subtitle_probed_at);
    if (!haveSubtitleProbe && hasExactSubtitleMap) {
      update.subtitle_tracks = orderedSubtitleTracks;
      update.subtitle_probed_at = new Date().toISOString();
    }
    const currentLegacyCount = mergedLegacyLanguages.length;
    mergedLegacyLanguages = [...new Set([...mergedLegacyLanguages, ...observedCodes])].sort();
    legacyLanguagesChanged = mergedLegacyLanguages.length !== currentLegacyCount;
    if (legacyLanguagesChanged) update.audio_languages = mergedLegacyLanguages;
    if (Object.keys(update).length) {
      const { error } = await db.from("cloud_titles")
        .update(update)
        .eq("user_id", userId)
        .eq("id", titleId);
      if (error) {
        storedTracks = false;
        legacyLanguagesChanged = false;
      }
    }
  }

  for (const key of FACET_CACHE.keys()) {
    if (key.startsWith(`${userId}:`) && key.includes(`:${itemType}:`)) {
      FACET_CACHE.delete(key);
    }
  }
  return {
    ok: true,
    updated: unionMerged || storedTracks || legacyLanguagesChanged,
    exact: true,
    legacyDerived,
    audioLanguages: observedCodes,
    audioTracksStored: storedTracks,
  };
}

type CatalogTitleSelectorMode = "home_verified" | "home_recent";

const CATALOG_TITLE_SELECTOR_MAX_PAGES = 64;
const CATALOG_TITLE_SELECTOR_DEADLINE_MS = 45_000;
const CATALOG_TITLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function catalogTitleReadUnavailable(): HttpError {
  return new HttpError(503, "Catalog titles are temporarily unavailable");
}

function catalogTitleUuid(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (!CATALOG_TITLE_UUID.test(text)) throw catalogTitleReadUnavailable();
  return text.toLowerCase();
}

function requiredCatalogTitleVisibilityEpoch(userId: string): string {
  const epoch = latestBoundCatalogVisibilityEpoch(userId);
  if (!epoch || !/^[1-9][0-9]*$/.test(epoch)) throw catalogTitleReadUnavailable();
  return epoch;
}

function catalogTitleVisibilityEpoch(value: unknown, expected: string): string {
  const epoch = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!/^[1-9][0-9]*$/.test(epoch) || epoch !== expected) throw catalogTitleReadUnavailable();
  return epoch;
}

async function selectOrderedCatalogTitleIds(
  userId: string,
  itemType: "movie" | "series",
  mode: CatalogTitleSelectorMode,
  limit: number,
  visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId),
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8_000) throw catalogTitleReadUnavailable();
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: JsonRecord | null = null;
  let pages = 0;
  const startedAt = Date.now();

  while (ids.length < limit && pages < CATALOG_TITLE_SELECTOR_MAX_PAGES
      && Date.now() - startedAt < CATALOG_TITLE_SELECTOR_DEADLINE_MS) {
    const pageLimit = Math.min(300, limit - ids.length);
    const scanLimit = Math.min(1000, Math.max(pageLimit, pageLimit * 3));
    const { data, error } = await db.rpc("norva_select_catalog_title_ordered_page", {
      p_user_id: userId,
      p_item_type: itemType,
      p_mode: mode,
      p_limit: pageLimit,
      p_scan_limit: scanLimit,
      p_cursor: cursor,
      p_expected_visibility_epoch: visibilityEpoch,
    });
    if (error || !isRecord(data) || data.contract !== "catalog-title-selector-v2"
        || data.mode !== mode || !Array.isArray(data.items)
        || typeof data.complete !== "boolean") throw catalogTitleReadUnavailable();
    catalogTitleVisibilityEpoch(data.visibilityEpoch, visibilityEpoch);
    const returnedTitles = Number(data.returnedTitles);
    const inspectedTitles = Number(data.inspectedTitles);
    const returnedScanLimit = Number(data.scanLimit);
    if (!Number.isInteger(returnedTitles) || returnedTitles !== data.items.length
        || returnedTitles < 0 || returnedTitles > pageLimit
        || !Number.isInteger(inspectedTitles) || inspectedTitles < returnedTitles
        || !Number.isInteger(returnedScanLimit) || returnedScanLimit !== scanLimit) {
      throw catalogTitleReadUnavailable();
    }
    for (const entry of data.items) {
      if (!isRecord(entry)) throw catalogTitleReadUnavailable();
      const titleId = catalogTitleUuid(entry.id);
      if (seen.has(titleId)) throw catalogTitleReadUnavailable();
      seen.add(titleId);
      ids.push(titleId);
    }
    pages += 1;
    if (data.complete) {
      if (data.nextCursor !== null && data.nextCursor !== undefined) throw catalogTitleReadUnavailable();
      return ids;
    }
    if (!isRecord(data.nextCursor)
        || JSON.stringify(data.nextCursor) === JSON.stringify(cursor)) throw catalogTitleReadUnavailable();
    cursor = data.nextCursor;
  }
  // Reaching the requested visible count is success. Hitting a resource bound
  // first is fail-closed: a partial Home candidate pool would be silently biased.
  if (ids.length >= limit) return ids.slice(0, limit);
  throw catalogTitleReadUnavailable();
}

async function hydrateVisibleCatalogTitlesByIds(
  userId: string,
  titleIds: string[],
  visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId),
  requireAll = true,
): Promise<JsonRecord[]> {
  const orderedIds = [...new Set(titleIds.map(catalogTitleUuid))];
  if (!orderedIds.length) return [];
  const byId = new Map<string, JsonRecord>();
  for (let index = 0; index < orderedIds.length; index += 500) {
    const chunk = orderedIds.slice(index, index + 500);
    const { data, error } = await db.rpc("norva_get_visible_catalog_titles_by_ids", {
      p_user_id: userId,
      p_title_ids: chunk,
      p_expected_visibility_epoch: visibilityEpoch,
    });
    if (error || !isRecord(data) || data.contract !== "catalog-title-hydration-v3"
        || !Array.isArray(data.items)) throw catalogTitleReadUnavailable();
    catalogTitleVisibilityEpoch(data.visibilityEpoch, visibilityEpoch);
    for (const value of data.items) {
      if (!isRecord(value)) throw catalogTitleReadUnavailable();
      const id = catalogTitleUuid(value.id);
      if (!chunk.includes(id) || byId.has(id) || String(value.user_id ?? "") !== userId) {
        throw catalogTitleReadUnavailable();
      }
      if (Number(value.variant_count ?? 0) > 0) byId.set(id, value);
    }
  }
  if (requireAll && orderedIds.some((id) => !byId.has(id))) throw catalogTitleReadUnavailable();
  return orderedIds.map((id) => byId.get(id)).filter((row): row is JsonRecord => !!row);
}

async function listTitleRail(userId: string, itemType: "movie" | "series", id: string, title: string, limit: number, lang: string | null) {
  try {
    const visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId);
    const titleIds = await selectOrderedCatalogTitleIds(userId, itemType, "home_recent", limit, visibilityEpoch);
    const titles = await hydrateVisibleCatalogTitlesByIds(userId, titleIds, visibilityEpoch);
    const variantsByTitle = await listVariantsByTitleIds(titleIds, userId);
    await applyCatalogOverlay(titles, itemType, lang); // full or safe text-only overlay
    return {
      id,
      title,
      itemType,
      source: "titles",
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
    };
  } catch (error) {
    throw error;
  }
}

type TitleCandidatesFor = (itemType: "movie" | "series") => Promise<JsonRecord[]>;

async function listGenreRail(
  userId: string,
  itemType: "movie" | "series",
  genre: string,
  id: string,
  title: string,
  limit: number,
  lang: string | null,
  candidatesFor: TitleCandidatesFor = (type) => listVerifiedTitleCandidates(userId, type),
) {
  try {
    const candidates = await candidatesFor(itemType);
    const titles = candidates
      .filter((row) => titleGenres(row).some((value: string) => sameGenre(value, genre)))
      .sort((a, b) => String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? "")))
      .slice(0, limit);
    await applyCatalogOverlay(titles, itemType, lang);
    const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)), userId);
    return {
      id,
      title,
      itemType,
      source: "titles",
      curation: { kind: "genre", genre },
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return { id, title, itemType, source: "titles", items: [] };
    throw error;
  }
}

async function listPopularTitleRail(
  userId: string,
  itemType: "movie" | "series",
  id: string,
  title: string,
  limit: number,
  lang: string | null,
  candidatesFor: TitleCandidatesFor = (type) => listVerifiedTitleCandidates(userId, type),
) {
  try {
    const candidates = await candidatesFor(itemType);
    // Real-views signal: distinct users who have watched each title (global), so the
    // Top 10 reflects actual viewing. TMDB rating is the tiebreak, so it still reads as
    // a sensible ranking while views are sparse and self-improves as they accumulate.
    const viewsByTmdb = new Map<string, number>();
    try {
      const { data: top } = await db.rpc("top_viewed_titles", { p_item_type: itemType, p_limit: 200 });
      for (const r of ((top ?? []) as JsonRecord[])) {
        viewsByTmdb.set(String(r.provider_tmdb_id), Number(r.views) || 0);
      }
    } catch (_) { /* function unavailable → fall back to rating-only ranking below */ }
    const viewsOf = (row: JsonRecord) => viewsByTmdb.get(String(row.provider_tmdb_id)) ?? 0;
    const titles = candidates
      .filter((row) => numberOrNull(titleTmdb(row).vote_average) !== null || viewsOf(row) > 0)
      .sort((a, b) =>
        viewsOf(b) - viewsOf(a) ||
        numberOr(titleTmdb(b).vote_average, 0) - numberOr(titleTmdb(a).vote_average, 0) ||
        numberOr(b.variant_count, 0) - numberOr(a.variant_count, 0) ||
        String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? ""))
      )
      .slice(0, limit);
    await applyCatalogOverlay(titles, itemType, lang);
    const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)), userId);
    return {
      id,
      title,
      itemType,
      source: "titles",
      curation: { kind: "popular", metric: "views+tmdb_vote_average" },
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return { id, title, itemType, source: "titles", items: [] };
    throw error;
  }
}

function rankBecauseYouLikedCandidates(
  candidates: JsonRecord[],
  anchorTitle: JsonRecord,
  ratedTitleIds: Set<string>,
  limit: number,
) {
  const anchorId = String(anchorTitle.id);
  const anchorGenres = titleGenres(anchorTitle);
  const sharedGenreCount = (row: JsonRecord) => titleGenres(row).reduce(
    (count, candidateGenre) => count + (
      anchorGenres.some((anchorGenre) => sameGenre(candidateGenre, anchorGenre)) ? 1 : 0
    ),
    0,
  );
  return candidates
    .filter((row) => String(row.id) !== anchorId)
    .filter((row) => !ratedTitleIds.has(String(row.id)))
    .filter((row) => sharedGenreCount(row) > 0)
    .sort((a, b) =>
      sharedGenreCount(b) - sharedGenreCount(a) ||
      numberOr(titleTmdb(b).vote_average, 0) - numberOr(titleTmdb(a).vote_average, 0) ||
      numberOr(b.variant_count, 0) - numberOr(a.variant_count, 0) ||
      String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? ""))
    )
    .slice(0, limit);
}

async function listRatedCandidateTitleIds(
  userId: string,
  profileId: string,
  titleIds: string[],
) {
  const rated = new Set<string>();
  for (let index = 0; index < titleIds.length; index += 100) {
    const batch = titleIds.slice(index, index + 100);
    if (!batch.length) continue;
    const { data, error } = await db
      .from("cloud_title_ratings")
      .select("title_id")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .in("rating", [-1, 1])
      .in("title_id", batch);
    if (error) throwDb(error, "Unable to exclude rated recommendations");
    for (const row of (data ?? []) as JsonRecord[]) {
      const titleId = stringOrNull(row.title_id);
      if (titleId) rated.add(titleId);
    }
  }
  return rated;
}

async function listBecauseYouLikedRail(
  userId: string,
  profileId: string | null,
  options: {
    includeMovies: boolean;
    includeSeries: boolean;
    limit: number;
    lang: string | null;
    candidatesFor: TitleCandidatesFor;
  },
) {
  if (!profileId) return null;

  const itemTypes = [
    ...(options.includeMovies ? ["movie"] : []),
    ...(options.includeSeries ? ["series"] : []),
  ];
  if (!itemTypes.length) return null;

  try {
    const { data: likes, error } = await db
      .from("cloud_title_ratings")
      .select("title_id,item_type,updated_at")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .in("item_type", itemTypes)
      .eq("rating", 1)
      .not("title_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(24);
    if (error) throwDb(error, "Unable to list liked titles for home rail");

    let anchorId: string | null = null;
    let anchorTitle: JsonRecord | null = null;
    for (const like of (likes ?? []) as JsonRecord[]) {
      const candidateAnchorId = stringOrNull(like.title_id);
      if (!candidateAnchorId) continue;
      const candidateAnchor = await loadTitleById(userId, candidateAnchorId);
      if (!candidateAnchor || !titleGenres(candidateAnchor).length) continue;
      anchorId = candidateAnchorId;
      anchorTitle = candidateAnchor;
      break;
    }

    if (!anchorId || !anchorTitle) return null;
    const itemType: "movie" | "series" = String(anchorTitle.item_type) === "series" ? "series" : "movie";
    if ((itemType === "movie" && !options.includeMovies) || (itemType === "series" && !options.includeSeries)) return null;

    const candidates = await options.candidatesFor(itemType);
    const ratedTitleIds = await listRatedCandidateTitleIds(
      userId,
      profileId,
      [anchorId, ...candidates.map((row) => String(row.id))],
    );
    ratedTitleIds.add(anchorId);
    const rankedTitles = rankBecauseYouLikedCandidates(
      candidates,
      anchorTitle,
      ratedTitleIds,
      Math.min(candidates.length, Math.max(options.limit * 4, options.limit)),
    );
    if (!rankedTitles.length) return null;

    const variantsByTitle = await listVariantsByTitleIds(
      rankedTitles.map((row) => String(row.id)),
      userId,
    );
    const titles = rankedTitles
      .filter((row) => (variantsByTitle.get(String(row.id)) ?? []).length > 0)
      .slice(0, options.limit);
    if (!titles.length) return null;
    await applyCatalogOverlay(titles, itemType, options.lang);
    const anchorName = stringOrNull(anchorTitle.title ?? anchorTitle.original_title);
    return {
      id: `because-you-liked-${anchorId}`,
      title: anchorName ? `Because You Liked ${anchorName}` : "Because You Liked",
      itemType,
      source: "titles",
      curation: {
        kind: "because_you_liked",
        anchorTitleId: anchorId,
        anchorTitle: anchorName,
        genres: titleGenres(anchorTitle),
      },
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], options.lang)),
    };
  } catch (error) {
    if (isMissingRatingsExpansion(error)) return null;
    throw error;
  }
}

async function listBecauseYouWatchedRail(
  userId: string,
  profileId: string | null,
  options: {
    includeMovies: boolean;
    includeSeries: boolean;
    limit: number;
    lang: string | null;
    candidatesFor: TitleCandidatesFor;
  },
) {
  if (!profileId) return null;
  const lang = options.lang;
  const itemTypes = [
    ...(options.includeMovies ? ["movie"] : []),
    ...(options.includeSeries ? ["series"] : []),
  ];
  if (!itemTypes.length) return null;

  try {
    const { data: history, error } = await db
      .from("cloud_watch_history")
      .select("source_id,item_type,item_id,item_name,data,updated_at")
      .eq("user_id", userId)
      .eq("profile_id", profileId)
      .in("item_type", itemTypes)
      .order("updated_at", { ascending: false })
      .limit(40);
    if (error) throwDb(error, "Unable to list watch history for home rail");

    for (const entry of history ?? []) {
      const watchedTitle = await resolveWatchedTitle(userId, entry);
      if (!watchedTitle) continue;
      const genres = titleGenres(watchedTitle);
      if (!genres.length) continue;

      const itemType = String(watchedTitle.item_type) === "series" ? "series" : "movie";
      const candidates = await options.candidatesFor(itemType);
      const watchedId = String(watchedTitle.id);
      const titles = candidates
        .filter((row) => String(row.id) !== watchedId)
        .filter((row) => titleGenres(row).some((candidateGenre: string) =>
          genres.some((anchorGenre: string) => sameGenre(candidateGenre, anchorGenre))
        ))
        .sort((a, b) =>
          numberOr(titleTmdb(b).vote_average, 0) - numberOr(titleTmdb(a).vote_average, 0) ||
          String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? ""))
        )
        .slice(0, options.limit);
      if (!titles.length) continue;

      await applyCatalogOverlay(titles, itemType, lang);
      const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)), userId);
      return {
        id: `because-you-watched-${watchedId}`,
        title: "Because You Watched",
        itemType,
        source: "titles",
        curation: {
          kind: "because_you_watched",
          anchorTitleId: watchedId,
          anchorTitle: watchedTitle.title ?? watchedTitle.original_title ?? null,
          genres,
        },
        items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [], lang)),
      };
    }
  } catch (error) {
    if (isMissingMaterialization(error)) return null;
    throw error;
  }

  return null;
}

async function resolveWatchedTitle(userId: string, history: JsonRecord) {
  const data = recordOrEmpty(history.data);
  const titleId = stringOrNull(data.titleId ?? data.title_id);
  if (titleId) {
    const title = await loadTitleById(userId, titleId);
    if (title) return title;
  }

  const sourceId = stringOrNull(history.source_id);
  const itemType = String(history.item_type) === "series" ? "series" : String(history.item_type) === "movie" ? "movie" : "";
  const itemId = stringOrNull(history.item_id);
  if (!sourceId || !itemType || !itemId) return null;

  const { data: variant, error } = await db
    .from("cloud_catalog_visible_title_variants")
    .select("title_id")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .eq("item_type", itemType)
    .eq("external_id", itemId)
    .maybeSingle();
  if (error) {
    if (isMissingMaterialization(error)) return null;
    throwDb(error, "Unable to resolve watched title variant");
  }
  const resolvedTitleId = stringOrNull(variant?.title_id);
  return resolvedTitleId ? loadTitleById(userId, resolvedTitleId) : null;
}

async function loadTitleById(userId: string, titleId: string) {
  const visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId);
  const rows = await hydrateVisibleCatalogTitlesByIds(
    userId,
    [titleId],
    visibilityEpoch,
    false,
  );
  return rows[0] ?? null;
}

async function listVerifiedTitleCandidates(
  userId: string,
  itemType: "movie" | "series",
  candidateLimit = 300,
) {
  const visibilityEpoch = requiredCatalogTitleVisibilityEpoch(userId);
  const titleIds = await selectOrderedCatalogTitleIds(
    userId,
    itemType,
    "home_verified",
    candidateLimit,
    visibilityEpoch,
  );
  return await hydrateVisibleCatalogTitlesByIds(userId, titleIds, visibilityEpoch);
}

// Source-health awareness for playable cards (home audit 2026-07-04). The visible
// source projection already removes disabled/staging sources; among remaining
// sources, an errored source should rank behind a healthy variant. Cached briefly:
// every rail of one /home/rails call shares the lookup.
type SourceCatalogContext = {
  disabled: Set<string>;
  errored: Set<string>;
  exactKeysBySource: Map<string, string[]>;
};
const sourceCatalogContextCache = new Map<string, { at: number; promise: Promise<SourceCatalogContext> }>();
const SOURCE_CATALOG_CONTEXT_CACHE_TTL_MS = 30_000;
const SOURCE_CATALOG_CONTEXT_CACHE_MAX = 512;

async function sourceCatalogContextFor(userId: string): Promise<SourceCatalogContext> {
  const cacheEpoch = latestBoundCatalogCacheEpoch(userId);
  const cacheKey = cacheEpoch ? `${userId}:${cacheEpoch}` : null;
  const hit = cacheKey ? sourceCatalogContextCache.get(cacheKey) : null;
  if (hit && Date.now() - hit.at < SOURCE_CATALOG_CONTEXT_CACHE_TTL_MS) {
    sourceCatalogContextCache.delete(cacheKey!);
    sourceCatalogContextCache.set(cacheKey!, hit);
    return await hit.promise;
  }
  if (cacheKey && hit) sourceCatalogContextCache.delete(cacheKey);

  const promise = (async (): Promise<SourceCatalogContext> => {
    const context: SourceCatalogContext = {
      disabled: new Set<string>(),
      errored: new Set<string>(),
      exactKeysBySource: new Map<string, string[]>(),
    };
    try {
      const { data } = await db.from("cloud_catalog_visible_sources")
        .select("id,sync_status")
        .eq("user_id", userId);
      const visibleSourceIds: string[] = [];
      for (const source of (data ?? []) as JsonRecord[]) {
        const sourceId = String(source.id ?? "");
        const status = String(source.sync_status ?? "");
        // Unresolved providers remain strictly tenant/source-local. The sync
        // engine replaces this key below only after writing a verified identity
        // association.
        if (sourceId) {
          visibleSourceIds.push(sourceId);
          context.exactKeysBySource.set(sourceId, [`source:${sourceId}`]);
        }
        if (status === "disabled") context.disabled.add(sourceId);
        else if (status === "error") context.errored.add(sourceId);
      }
      // Cross-tenant cache keys come only from the server-written identity
      // association. cloud_sources.config_hint is owner-editable and must never
      // authorize reads from another customer's canonical file cache.
      if (visibleSourceIds.length) {
        const { data: verifiedLinks } = await db
          .from("catalog_source_provider_identities")
          .select("source_id,identity_id")
          .eq("user_id", userId)
          .in("source_id", visibleSourceIds);
        for (const link of (verifiedLinks ?? []) as JsonRecord[]) {
          const sourceId = String(link.source_id ?? "");
          const identityId = String(link.identity_id ?? "");
          if (sourceId && identityId) {
            context.exactKeysBySource.set(sourceId, [identityId]);
          }
        }
      }
    } catch (_) { /* fail-open: catalogue remains usable without enrichment */ }
    return context;
  })();

  if (cacheKey) {
    // Keep only the newest visibility generation for this account. Epochs are
    // monotone, so older entries can never serve a future authenticated read.
    for (const key of sourceCatalogContextCache.keys()) {
      if (key.startsWith(`${userId}:`) && key !== cacheKey) {
        sourceCatalogContextCache.delete(key);
      }
    }
    sourceCatalogContextCache.set(cacheKey, { at: Date.now(), promise });
    if (sourceCatalogContextCache.size > SOURCE_CATALOG_CONTEXT_CACHE_MAX) {
      const oldest = sourceCatalogContextCache.keys().next().value;
      if (oldest !== undefined) sourceCatalogContextCache.delete(oldest);
    }
  }
  return await promise;
}

async function sourceHealthFor(userId: string): Promise<{ disabled: Set<string>; errored: Set<string> }> {
  const context = await sourceCatalogContextFor(userId);
  return { disabled: context.disabled, errored: context.errored };
}

async function fileLanguageObservationsByVariant(
  variantIds: string[],
  userId: string,
): Promise<Map<string, JsonRecord>> {
  const byVariant = new Map<string, JsonRecord>();
  const ids = [...new Set(variantIds.filter(Boolean))];
  for (let index = 0; index < ids.length; index += 500) {
    const { data, error } = await db.from("cloud_title_file_language_observations")
      .select("variant_id,file_external_id,audio_languages,subtitle_languages,audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at")
      .eq("user_id", userId)
      .in("variant_id", ids.slice(index, index + 500));
    if (error) throw error;
    for (const row of (data ?? []) as JsonRecord[]) {
      const variantId = String(row.variant_id ?? "");
      if (variantId) byVariant.set(variantId, row);
    }
  }
  return byVariant;
}

function attachFileLanguageObservation(variant: JsonRecord, observation: JsonRecord | undefined) {
  if (!observation) return;
  const externalId = String(variant.external_id ?? "");
  if (!externalId || String(observation.file_external_id ?? "") !== externalId) return;
  if (observation.audio_observed === true) {
    const observedLanguages = canonicalFileLanguages(observation.audio_languages);
    variant.__file_audio_observed = true;
    variant.__file_audio_languages = observedLanguages;
    variant.__file_audio_validation_status = observation.audio_verified_at
      ? "verified"
      : observedLanguages.length ? "probed" : "pending";
    variant.__file_audio_verification = recordOrEmpty(observation.audio_verification);
    if (observation.audio_verified_at) {
      variant.__file_audio_verified_at = observation.audio_verified_at;
    } else {
      variant.__file_audio_declared_languages = observedLanguages;
    }
  }
  if (observation.subtitle_observed === true) {
    variant.__file_subtitle_languages = canonicalFileLanguages(observation.subtitle_languages);
    variant.__file_subtitle_observed = true;
  }
}

// Attach the GLOBAL cache entry for the exact provider file to each exposed
// variant. cloud_titles.audio_tracks is a grouped-title facet and may come from
// a different dub/file; absolute stream indices are only valid at
// (provider identity, item type, external id) granularity.
async function attachExactFileTracks(variantsByTitle: Map<string, JsonRecord[]>, userId: string) {
  // A series variant is the parent series id, not an episode file id. Legacy
  // crawler rows keyed (series, seriesId) describe an arbitrary first episode
  // and must never be exposed as file-scoped tracks.
  const variants = [...variantsByTitle.values()].flat()
    .filter((variant) => String(variant.item_type ?? "") === "movie");
  if (!variants.length) return;

  // Playback-time browser probes are deliberately tenant-local: they may label
  // this owned file but must never poison the cross-user ordered-track cache.
  // They are still exact evidence for a version card, so expose their language
  // SET separately from absolute stream indexes.
  try {
    const observations = await fileLanguageObservationsByVariant(
      variants.map((variant) => String(variant.id ?? "")),
      userId,
    );
    for (const variant of variants) {
      attachFileLanguageObservation(variant, observations.get(String(variant.id ?? "")));
    }
  } catch (_) {
    // Card labels remain usable from the trusted global probe or release-name
    // fallback when the tenant observation table is temporarily unavailable.
  }

  try {
    const sourceIds = [...new Set(variants.map((v) => String(v.source_id ?? "")).filter(Boolean))];
    const sourceContext = await sourceCatalogContextFor(userId);
    const keysBySource = new Map<string, string[]>();
    for (const sourceId of sourceIds) {
      const keys = sourceContext.exactKeysBySource.get(sourceId);
      if (keys?.length) keysBySource.set(sourceId, keys);
    }
    const cacheKeys = [...new Set([...keysBySource.values()].flat())];
    const externalIds = [...new Set(variants.map((v) => String(v.external_id ?? "")).filter(Boolean))];
    if (!cacheKeys.length || !externalIds.length) return;

    const rowsByKey = new Map<string, JsonRecord>();
    for (let index = 0; index < externalIds.length; index += 150) {
      const { data } = await db.from("catalog_file_tracks")
        .select("server_host,item_type,external_id,audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at,audio_lang_verified_at,audio_lang_verification,audio_whisper_verification")
        .in("server_host", cacheKeys)
        .in("external_id", externalIds.slice(index, index + 150));
      for (const row of (data ?? []) as JsonRecord[]) {
        rowsByKey.set(`${row.server_host}:${row.item_type}:${row.external_id}`, row);
      }
    }

    for (const variant of variants) {
      const sourceKeys = keysBySource.get(String(variant.source_id ?? "")) ?? [];
      const itemType = String(variant.item_type ?? "");
      const externalId = String(variant.external_id ?? "");
      const row = sourceKeys
        .map((key) => rowsByKey.get(`${key}:${itemType}:${externalId}`))
        .find(Boolean);
      if (!row) continue;
      if (row.audio_probed_at) {
        const cachedLanguages = canonicalFileLanguages(publicFileTrackLanguages(row.audio_tracks));
        const alreadyVerified = Boolean(variant.__file_audio_verified_at);
        variant.__file_audio_tracks = Array.isArray(row.audio_tracks) ? row.audio_tracks : [];
        variant.__file_audio_probed_at = row.audio_probed_at;
        variant.__file_audio_observed = true;
        if (row.audio_lang_verified_at) {
          variant.__file_audio_validation_status = "verified";
          variant.__file_audio_verification = recordOrEmpty(
            row.audio_lang_verification ?? row.audio_whisper_verification,
          );
          variant.__file_audio_verified_at = row.audio_lang_verified_at;
          variant.__file_audio_languages = cachedLanguages;
        } else if (!alreadyVerified) {
          const observedLanguages = Array.isArray(variant.__file_audio_languages) &&
              (variant.__file_audio_languages as unknown[]).length
            ? canonicalFileLanguages(variant.__file_audio_languages)
            : cachedLanguages;
          variant.__file_audio_languages = observedLanguages;
          variant.__file_audio_declared_languages = observedLanguages;
          variant.__file_audio_validation_status = observedLanguages.length ? "probed" : "pending";
          variant.__file_audio_verification = recordOrEmpty(
            row.audio_lang_verification ?? row.audio_whisper_verification,
          );
        }
      }
      if (row.subtitle_probed_at) {
        variant.__file_subtitle_tracks = Array.isArray(row.subtitle_tracks) ? row.subtitle_tracks : [];
        variant.__file_subtitle_probed_at = row.subtitle_probed_at;
      }
    }
  } catch (_) {
    // Track labels are enrichment only; a cache miss/outage must never hide the
    // catalogue or make a playable version disappear.
  }
}

function flatMediaVariantKey(row: Record<string, any>): string | null {
  const mediaItemId = stringOrNull(row.media_item_id ?? row.mediaItemId ?? row.id);
  const sourceId = stringOrNull(row.source_id ?? row.sourceId);
  const externalId = stringOrNull(row.external_id ?? row.externalId);
  if (!mediaItemId || !sourceId || !externalId) return null;
  // JSON encoding keeps arbitrary provider ids unambiguous without inventing a
  // delimiter that could itself occur in an external id.
  return JSON.stringify([mediaItemId, sourceId, externalId]);
}

// The flat media-items grid returns cloud_media_items rather than title variants.
// Join those owned rows back to their exact movie variants, then attach exact-file
// codec/playback facts plus the tenant-local language SET. No sibling fallback and
// no stream index is manufactured here.
async function attachFlatMediaFileLanguages(
  items: Array<Record<string, any>>,
  userId: string,
  itemType: string | null,
) {
  if (itemType !== "movie" || !items.length) return;
  try {
    const mediaIds = [...new Set(items.map((item) => String(item.id ?? "")).filter(Boolean))];
    if (!mediaIds.length) return;
    const variantByExactFile = new Map<string, JsonRecord>();
    for (let index = 0; index < mediaIds.length; index += 500) {
      const { data, error } = await db.from("cloud_catalog_visible_title_variants")
        .select("id,user_id,source_id,media_item_id,item_type,external_id,playback_hint,codec_profile")
        .eq("user_id", userId)
        .eq("item_type", "movie")
        .in("media_item_id", mediaIds.slice(index, index + 500));
      if (error) throw error;
      for (const variant of (data ?? []) as JsonRecord[]) {
        const exactFileKey = flatMediaVariantKey(variant);
        if (exactFileKey) variantByExactFile.set(exactFileKey, variant);
      }
    }
    const observations = await fileLanguageObservationsByVariant(
      [...variantByExactFile.values()].map((variant) => String(variant.id ?? "")),
      userId,
    );
    for (const item of items) {
      const exactFileKey = flatMediaVariantKey(item);
      const variant = exactFileKey ? variantByExactFile.get(exactFileKey) : null;
      if (!variant) continue;

      // Gateway probes persist these facts on cloud_title_variants. Project them
      // back onto the exact cloud_media_items row so the next launch can route
      // from known codecs instead of paying another gateway probe/transcode.
      const codecProfile = recordOrEmpty(variant.codec_profile);
      if (Object.keys(codecProfile).length) {
        item.codec_profile = codecProfile;
        item.codecProfile = codecProfile;
      }
      const variantPlaybackHint = recordOrEmpty(variant.playback_hint);
      if (Object.keys(variantPlaybackHint).length) {
        const mergedPlaybackHint = { ...recordOrEmpty(item.playback_hint ?? item.playbackHint), ...variantPlaybackHint };
        item.playback_hint = mergedPlaybackHint;
        item.playbackHint = mergedPlaybackHint;
      }

      attachFileLanguageObservation(variant, observations.get(String(variant.id ?? "")));
      if (variant.__file_audio_observed === true) {
        const verified = Boolean(variant.__file_audio_verified_at);
        const observedLanguages = canonicalFileLanguages(
          variant.__file_audio_languages ?? variant.__file_audio_declared_languages,
        );
        item.audio_languages = observedLanguages;
        item.audioLanguages = observedLanguages;
        item.audio_languages_scope = "file";
        item.audioLanguagesScope = "file";
        item.audio_languages_observed = true;
        item.audioLanguagesObserved = true;
        const validationStatus = verified ? "verified" : observedLanguages.length ? "probed" : "pending";
        item.audio_language_validation_status = validationStatus;
        item.audioLanguageValidationStatus = validationStatus;
        item.audio_language_verified_at = variant.__file_audio_verified_at;
        item.audioLanguageVerifiedAt = variant.__file_audio_verified_at;
      }
      if (variant.__file_subtitle_observed === true) {
        item.subtitle_languages = variant.__file_subtitle_languages;
        item.subtitleLanguages = variant.__file_subtitle_languages;
        item.subtitle_languages_scope = "file";
        item.subtitleLanguagesScope = "file";
        item.subtitle_languages_observed = true;
        item.subtitleLanguagesObserved = true;
      }
    }
  } catch (_) {
    // Exact labels are progressive enhancement; never fail a catalogue page.
  }
}

async function listVariantsByTitleIds(
  titleIds: string[],
  userId?: string,
  exposedLimit = HOME_RAIL_VARIANT_LIMIT,
  requiredAudioIso: string | null = null,
  sourceId: string | null = null,
) {
  const variantsByTitle = new Map<string, JsonRecord[]>();
  if (!titleIds.length) return variantsByTitle;
  const health = userId ? await sourceHealthFor(userId) : { disabled: new Set<string>(), errored: new Set<string>() };
  for (let index = 0; index < titleIds.length; index += TITLE_VARIANT_QUERY_CHUNK) {
    const chunk = titleIds.slice(index, index + TITLE_VARIANT_QUERY_CHUNK);
    let query = db
      .from("cloud_catalog_visible_title_variants")
      .select("id,user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title,label,language,quality,resolution,container_extension,poster_url,playback_hint,codec_profile,compatibility_tier,playback_cost_score,last_observed_ttff_ms,metadata,created_at")
      .in("title_id", chunk)
      .order("playback_cost_score", { ascending: true })
      .order("last_observed_ttff_ms", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (userId) query = query.eq("user_id", userId);
    if (sourceId) query = query.eq("source_id", sourceId);
    const { data, error } = await query;
    if (error) {
      if (isMissingMaterialization(error)) return variantsByTitle;
      throwDb(error, "Unable to list title variants");
    }
    for (const variant of data ?? []) {
      if (health.disabled.has(String(variant.source_id))) continue; // a disabled source can never play
      const key = String(variant.title_id);
      const existing = variantsByTitle.get(key) ?? [];
      existing.push(variant);
      variantsByTitle.set(key, existing);
    }
  }
  for (const [key, variants] of variantsByTitle) {
    const sorted = variants.sort(compareTitleVariants);
    // Errored sources (dead credentials) rank LAST: defaultVariant = variants[0] must be a
    // healthy pick whenever one exists, but a title whose ONLY copy sits on an errored source
    // keeps its card (the repair banner covers the account-level message).
    if (health.errored.size) {
      sorted.sort((a, b) =>
        Number(health.errored.has(String(a.source_id))) - Number(health.errored.has(String(b.source_id))));
    }
    variantsByTitle.set(key, requiredAudioIso ? sorted : sorted.slice(0, exposedLimit));
  }
  if (userId) await attachExactFileTracks(variantsByTitle, userId);
  if (requiredAudioIso) {
    const requiredCanonicalIso = canonicalFileLanguage(requiredAudioIso);
    for (const [key, variants] of variantsByTitle) {
      variants.sort((left, right) => {
        const matches = (variant: JsonRecord) => {
          if (!requiredCanonicalIso) return false;
          const orderedTrackMatch = Array.isArray(variant.__file_audio_tracks) &&
            (variant.__file_audio_tracks as JsonRecord[]).some((track) =>
              canonicalFileLanguage(track?.lang ?? track?.language) === requiredCanonicalIso);
          const tenantLanguageMatch = variant.__file_audio_observed === true &&
            Array.isArray(variant.__file_audio_languages) &&
            (variant.__file_audio_languages as unknown[]).some((language) =>
              canonicalFileLanguage(language) === requiredCanonicalIso);
          return orderedTrackMatch || tenantLanguageMatch;
        };
        return Number(matches(right)) - Number(matches(left));
      });
      variantsByTitle.set(key, variants.slice(0, exposedLimit));
    }
  }
  return variantsByTitle;
}

// User display language for localized titles/overviews: a validated 2-letter
// code from the request. Null → serve the catalogue default language.
function railLang(url: URL): string | null {
  const raw = (url.searchParams.get("lang") || "").toLowerCase().trim();
  return /^[a-z]{2}$/.test(raw) ? raw : null;
}

// ── Read-cutover flag (docs/roadmap/global-title-cache-design.md) ─────────────────
// When NORVA_CATALOG_READ_SOURCE=catalog_titles, DISPLAY metadata (title, poster,
// backdrop, i18n, tmdb, year) is served from the GLOBAL catalog_titles cache instead
// of the per-user cloud_titles row — the ÷10-100 enrichment/storage win once catalogues
// overlap. Language FILTERING stays on cloud_titles (per-user facets). Default OFF →
// byte-identical to today. The flip is gated on /catalog-mirror-verify staying clean.
function catalogReadEnabled(): boolean {
  return (Deno.env.get("NORVA_CATALOG_READ_SOURCE") ?? "cloud_titles") === "catalog_titles";
}

// Batched overlay of global display metadata. The full migrated-field replacement
// remains flag-gated; the text-only synopsis/i18n repair below is permanently active.
// touched — identity and per-user facet columns (id, variant_count, version_languages,
// audio_languages, default_variant_id, match_status) are left intact. A title missing
// from the catalog keeps its cloud_titles values (faithful fallback). Best-effort: any
// error leaves the cloud_titles values untouched.
type CatalogTextOverlay = {
  localizedTitle: string | null;
  localizedOverview: string | null;
  englishOverview: string | null;
  baseOverview: string | null;
};

// Permanent safe read path for title text removed by cloud_titles self-thinning.
// Both the per-user association and global catalogue identity must be validated.
// Assignments are fill-only and never touch year, artwork, genre or rating fields.
async function applyCatalogTextOverlay(
  rows: JsonRecord[],
  itemType: string,
  lang: string | null,
): Promise<void> {
  if (!rows.length || (itemType !== "movie" && itemType !== "series")) return;
  const eligibleRows = rows.filter((row) => catalogTextStatusEligible(row.match_status));
  const ids = [...new Set(eligibleRows
    .map((r) => stringOrNull(r.provider_tmdb_id))
    .filter((v): v is string => !!v && !/^(tt)?0+$/i.test(v)))];
  if (!ids.length) return;

  const textById = new Map<string, CatalogTextOverlay>();
  const localizedFields = lang
    ? `, loc_title:metadata->i18n->${lang}->>title, loc_overview:metadata->i18n->${lang}->>overview`
    : "";
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await (db as any)
      .from("catalog_titles")
      .select(`provider_tmdb_id, trusted:metadata->tmdbValidation->>valid, base_overview:metadata->tmdb->>overview, legacy_overview:metadata->>overview, en_overview:metadata->i18n->en->>overview${localizedFields}`)
      .eq("item_type", itemType)
      .in("provider_tmdb_id", ids.slice(i, i + 500));
    if (error) return; // best-effort: preserve the cloud row on lookup failure
    for (const row of data ?? []) {
      const id = stringOrNull((row as JsonRecord).provider_tmdb_id);
      if (!id || String((row as JsonRecord).trusted) !== "true") continue;
      textById.set(id, {
        localizedTitle: stringOrNull((row as JsonRecord).loc_title),
        localizedOverview: stringOrNull((row as JsonRecord).loc_overview),
        englishOverview: stringOrNull((row as JsonRecord).en_overview),
        baseOverview: stringOrNull((row as JsonRecord).base_overview)
          ?? stringOrNull((row as JsonRecord).legacy_overview),
      });
    }
  }

  for (const row of eligibleRows) {
    const text = textById.get(String(row.provider_tmdb_id));
    if (!text) continue;
    const metadata = recordOrEmpty(row.metadata);
    const tmdb = recordOrEmpty(metadata.tmdb);
    const i18n = { ...recordOrEmpty(metadata.i18n) };
    let changed = false;

    const existingOverview = stringOrNull(tmdb.overview) ?? stringOrNull(metadata.overview);
    const baseOverview = text.baseOverview ?? text.englishOverview;
    if (!existingOverview && baseOverview) {
      // Keep the shared fallback separate from per-user/provider metadata so
      // titleRailItem can prefer a provider synopsis when no translation exists.
      row.__catalog_base_overview = baseOverview;
    }

    if (lang && (text.localizedTitle || text.localizedOverview)) {
      const localized = { ...recordOrEmpty(i18n[lang]) };
      if (!stringOrNull(localized.title) && text.localizedTitle) {
        localized.title = text.localizedTitle;
        changed = true;
      }
      if (!stringOrNull(localized.overview) && text.localizedOverview) {
        localized.overview = text.localizedOverview;
        changed = true;
      }
      i18n[lang] = localized;
    }

    if (changed) row.metadata = { ...metadata, i18n };
  }
}

// Selector/hydration RPCs retain these fields only long enough to decide which
// display payload is authoritative. They are never part of a catalog response.
const CATALOG_TITLE_INTERNAL_PROOF_FIELDS = Object.freeze([
  "best_generation_id", "bestGenerationId",
  "display_generation_id", "displayGenerationId",
  "overlay_generation_id", "overlayGenerationId",
  "overlay_catalog_metadata", "overlayCatalogMetadata",
  "projection_generation_id", "projectionGenerationId",
  "payload_generation_id", "payloadGenerationId",
  "best_variant_id", "bestVariantId",
  "base_updated_at", "baseUpdatedAt",
  "payload_updated_at", "payloadUpdatedAt",
  "storage_kind", "storageKind",
  "visibility_epoch", "visibilityEpoch",
] as const);

function catalogTitleUsesGenerationPayload(row: JsonRecord): boolean {
  const overlayGenerationId = stringOrNull(
    row.overlay_generation_id ?? row.overlayGenerationId,
  );
  const displayGenerationId = stringOrNull(
    row.display_generation_id ?? row.displayGenerationId,
  );
  return Boolean(
    overlayGenerationId && displayGenerationId
    && overlayGenerationId === displayGenerationId,
  );
}

function applyGenerationCatalogMetadata(
  row: JsonRecord,
  lang: string | null,
  fullOverlayEnabled: boolean,
): void {
  if (!catalogTitleUsesGenerationPayload(row)) return;
  const candidate = row.overlay_catalog_metadata ?? row.overlayCatalogMetadata;
  if (!isRecord(candidate)) return;
  if (fullOverlayEnabled) {
    row.metadata = candidate;
    return;
  }

  // Flag OFF must remain equivalent to the legacy thinned cloud_titles payload.
  // Rehydrate only the same trusted, fill-only synopsis/i18n subset as the
  // permanent global text repair, but from this generation's own projection so
  // a pre-head/global row can never bleed into the active display generation.
  if (!catalogTextStatusEligible(row.match_status)) return;
  const validation = recordOrEmpty(candidate.tmdbValidation);
  if (validation.valid !== true) return;

  const metadata = recordOrEmpty(row.metadata);
  const tmdb = recordOrEmpty(metadata.tmdb);
  const candidateTmdb = recordOrEmpty(candidate.tmdb);
  const candidateI18n = recordOrEmpty(candidate.i18n);
  const i18n = { ...recordOrEmpty(metadata.i18n) };
  let changed = false;

  const existingOverview = stringOrNull(tmdb.overview) ?? stringOrNull(metadata.overview);
  const baseOverview = stringOrNull(candidateTmdb.overview)
    ?? stringOrNull(candidate.overview)
    ?? stringOrNull(recordOrEmpty(candidateI18n.en).overview);
  if (!existingOverview && baseOverview) row.__catalog_base_overview = baseOverview;

  if (lang) {
    const projectedLocalized = recordOrEmpty(candidateI18n[lang]);
    const localizedTitle = stringOrNull(projectedLocalized.title);
    const localizedOverview = stringOrNull(projectedLocalized.overview);
    if (localizedTitle || localizedOverview) {
      const localized = { ...recordOrEmpty(i18n[lang]) };
      if (!stringOrNull(localized.title) && localizedTitle) {
        localized.title = localizedTitle;
        changed = true;
      }
      if (!stringOrNull(localized.overview) && localizedOverview) {
        localized.overview = localizedOverview;
        changed = true;
      }
      i18n[lang] = localized;
    }
  }
  if (changed) row.metadata = { ...metadata, i18n };
}

function stripCatalogTitleInternalProof(row: JsonRecord): void {
  for (const field of CATALOG_TITLE_INTERNAL_PROOF_FIELDS) delete row[field];
}

// Full display overlay remains guarded by the quality-gated cutover flag. While
// it stays OFF, only the validated text subset above is restored. A durable
// generation payload is already the exact display owner and therefore bypasses
// both global overlays under either flag; its own full catalog metadata is
// supplied by the hydration RPC.
async function applyCatalogOverlay(
  rows: JsonRecord[],
  itemType: string,
  lang: string | null = null,
): Promise<void> {
  if (!rows.length) return;
  const fullOverlayEnabled = catalogReadEnabled();
  for (const row of rows) applyGenerationCatalogMetadata(row, lang, fullOverlayEnabled);
  const globalRows = rows.filter((row) => !catalogTitleUsesGenerationPayload(row));
  try {
    if (!globalRows.length) return;
    if (!fullOverlayEnabled) {
      await applyCatalogTextOverlay(globalRows, itemType, lang);
      return;
    }
    const ids = [...new Set(globalRows
      .map((r) => stringOrNull(r.provider_tmdb_id))
      .filter((v): v is string => !!v && !/^(tt)?0+$/i.test(v)))];
    if (!ids.length) return;
    const overlay = new Map<string, JsonRecord>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await db
        .from("catalog_titles")
        .select("provider_tmdb_id, title, original_title, release_year, poster_url, backdrop_url, metadata")
        .eq("item_type", itemType)
        .in("provider_tmdb_id", ids.slice(i, i + 500));
      if (error) return;
      for (const c of data ?? []) overlay.set(String((c as JsonRecord).provider_tmdb_id), c as JsonRecord);
    }
    for (const row of globalRows) {
      const cat = overlay.get(String(row.provider_tmdb_id));
      if (!cat) continue;
      row.title = cat.title;
      row.original_title = cat.original_title;
      row.release_year = cat.release_year;
      row.poster_url = cat.poster_url;
      row.backdrop_url = cat.backdrop_url;
      row.metadata = cat.metadata;
    }
  } finally {
    for (const row of rows) stripCatalogTitleInternalProof(row);
  }
}

function titleRailItem(title: JsonRecord, variants: JsonRecord[], lang?: string | null) {
  // Defense in depth for callers that do not need a global display overlay.
  applyGenerationCatalogMetadata(title, lang ?? null, catalogReadEnabled());
  stripCatalogTitleInternalProof(title);
  const defaultVariant = variants[0] ?? {};
  const variantMetadata = recordOrEmpty(defaultVariant.metadata);
  const metadata = recordOrEmpty(title.metadata);
  const tmdb = titleTmdb(title);
  const genres = titleGenres(title);
  // Provider category from the preserved genre_category COLUMN — the catalog overlay
  // drops categoryName from verified titles' metadata, so the column is the source of
  // truth (keeps the detail-page category label populated for rail-opened titles).
  const categoryName = stringOrNull(title.genre_category) ?? stringOrNull(metadata.categoryName);
  const providerOverview = boundedProviderOverview(
    variantMetadata.overview,
    variantMetadata.description,
    variantMetadata.plot,
  );
  const overview = stringOrNull(tmdb.overview)
    ?? stringOrNull(metadata.overview)
    ?? providerOverview
    ?? stringOrNull(title.__catalog_base_overview);
  // Localized display: serve the user's language from the per-title i18n when
  // present, else the catalogue default (i18n is stored by the enrichment).
  const i18n = recordOrEmpty(metadata.i18n);
  const loc = lang ? recordOrEmpty((i18n as Record<string, unknown>)[lang]) : {};
  const displayTitle = stringOrNull(loc.title) ?? title.title;
  const displayOverview = stringOrNull(loc.overview) ?? overview;
  const rating = numberOrNull(tmdb.vote_average ?? metadata.vote_average);
  const runtime = numberOrNull(tmdb.runtime ?? metadata.runtime);
  const defaultVariantId = defaultVariant.id ?? title.default_variant_id ?? null;
  const posterUrl = preferSecureImage(title.poster_url ?? defaultVariant.poster_url, tmdbImageUrl(tmdb.poster_path, "w500"));
  const backdropUrl = preferSecureImage(title.backdrop_url, tmdbImageUrl(tmdb.backdrop_path, "w780"));
  const serializedDefaultVariant = titleVariantItem(defaultVariant);
  const observedAudioLanguages = titleAudioLanguages(title);
  const verifiedAudioLanguages = titleVerifiedAudioLanguages(title);
  const anyAudioObserved = variants.some((variant) => variant.__file_audio_observed === true);
  const expectedVariantCount = Math.max(0, Number(title.variant_count) || 0);
  const strictlyVerifiedVariants = variants.filter((variant) =>
    variant.__file_audio_observed === true &&
    canonicalFileLanguages(variant.__file_audio_languages).length > 0 &&
    Boolean(variant.__file_audio_verified_at)
  );
  // Two grouped files can share the same language code while only one carries
  // strict proof. Comparing title-level unions would then incorrectly certify
  // both. A grouped badge is strict only when every owned version is loaded,
  // observed, and independently verified.
  const everyOwnedVersionStrictlyVerified = observedAudioLanguages.length > 0 &&
    expectedVariantCount > 0 &&
    variants.length >= expectedVariantCount &&
    strictlyVerifiedVariants.length >= expectedVariantCount;
  const titleAudioValidationStatus = everyOwnedVersionStrictlyVerified
    ? "verified_union"
    : observedAudioLanguages.length ? "probed_union"
    : anyAudioObserved ? "pending" : "not_analyzed";
  return sanitizeCatalogMediaItem({
    id: title.id,
    title_id: title.id,
    titleId: title.id,
    item_type: title.item_type,
    type: title.item_type,
    item_id: defaultVariant.external_id ?? title.id,
    itemId: defaultVariant.external_id ?? title.id,
    source_id: defaultVariant.source_id ?? null,
    sourceId: defaultVariant.source_id ?? null,
    external_id: defaultVariant.external_id ?? null,
    name: displayTitle,
    title: displayTitle,
    original_title: title.original_title,
    year: title.release_year,
    poster_url: posterUrl,
    posterUrl: posterUrl,
    stream_icon: posterUrl,
    backdrop_url: backdropUrl,
    backdropUrl: backdropUrl,
    overview: displayOverview,
    description: displayOverview,
    genres,
    category_name: categoryName,
    categoryName: categoryName,
    rating,
    vote_average: rating,
    voteAverage: rating,
    runtime,
    runtimeMinutes: runtime,
    provider_tmdb_id: title.provider_tmdb_id ?? null,
    providerTmdbId: title.provider_tmdb_id ?? null,
    match_status: title.match_status,
    matchStatus: title.match_status,
    default_variant_id: defaultVariantId,
    defaultVariantId: defaultVariantId,
    default_variant: serializedDefaultVariant,
    defaultVariant: serializedDefaultVariant,
    variants: variants.map(titleVariantItem),
    exposed_variant_count: variants.length,
    exposedVariantCount: variants.length,
    variant_count: title.variant_count,
    variantCount: title.variant_count,
    playback_cost_score: defaultVariant.playback_cost_score ?? null,
    playbackCostScore: defaultVariant.playback_cost_score ?? null,
    last_observed_ttff_ms: defaultVariant.last_observed_ttff_ms ?? title.last_observed_ttff_ms ?? null,
    lastObservedTtffMs: defaultVariant.last_observed_ttff_ms ?? title.last_observed_ttff_ms ?? null,
    // "New in your catalog" timestamp (immutable first-seen) — powers the client's NEW badge,
    // which was dead for cloud rails because no added/added_at field was ever emitted.
    added: title.created_at ?? null,
    added_at: title.created_at ?? null,
    // Real detected languages (crawl/capture) so the client card badge shows the actual
    // audio language instead of guessing from the title. Already on the cloud_titles row.
    audio_languages: observedAudioLanguages,
    audioLanguages: observedAudioLanguages,
    audio_verified_languages: verifiedAudioLanguages,
    audioVerifiedLanguages: verifiedAudioLanguages,
    audio_language_validation_status: titleAudioValidationStatus,
    audioLanguageValidationStatus: titleAudioValidationStatus,
    // Ordered per-track map so the player labels each engine audio stream by absolute
    // index — real language names with NO playback-time probe.
    audio_tracks: numberOr(title.variant_count, variants.length) <= 1
      ? serializedDefaultVariant.audioTracks ?? []
      : [],
    audioTracks: numberOr(title.variant_count, variants.length) <= 1
      ? serializedDefaultVariant.audioTracks ?? []
      : [],
    audio_tracks_scope: numberOr(title.variant_count, variants.length) <= 1 ? "file" : "title",
    audioTracksScope: numberOr(title.variant_count, variants.length) <= 1 ? "file" : "title",
    version_languages: titleVersionLanguages(title),
    versionLanguages: titleVersionLanguages(title),
    metadata,
    tmdb,
    data: {
      ...metadata,
      description: displayOverview,
      overview: displayOverview,
      genres,
      categoryName: categoryName,
      rating,
      voteAverage: rating,
      runtime,
      runtimeMinutes: runtime,
      backdrop: title.backdrop_url ?? null,
      backdropUrl: title.backdrop_url ?? null,
      tmdb,
      sourceId: defaultVariant.source_id ?? null,
      containerExtension: defaultVariant.container_extension ?? null,
      providerTmdbId: title.provider_tmdb_id ?? null,
      titleId: title.id,
    },
  });
}

function titleTmdb(title: JsonRecord) {
  return recordOrEmpty(recordOrEmpty(title.metadata).tmdb);
}

function tmdbImageUrl(path: unknown, size: string) {
  const value = stringOrNull(path);
  return value ? `https://image.tmdb.org/t/p/${size}${value}` : null;
}

// Serve a secure image. Keep https provider art (often a localized / CDN poster
// worth preserving); when the stored image is insecure http:// (the provider's
// own host — slow and frequently expiring) or missing, prefer the verified TMDB
// image when one exists. http provider images with no TMDB match are kept as-is
// (the client image proxy still serves them over https).
function preferSecureImage(stored: unknown, tmdbUrl: string | null) {
  const value = stringOrNull(stored);
  if (value && !/^http:\/\//i.test(value)) return value;
  return tmdbUrl ?? value ?? null;
}

function titleGenres(title: JsonRecord) {
  const tmdb = titleTmdb(title);
  const metadata = recordOrEmpty(title.metadata);
  // Prefer the denormalised genre_payload COLUMN. It survives cloud_titles metadata
  // thinning (Phase-1 dedup), whereas metadata.tmdb.genres is '{}' at rest and only
  // refilled by applyCatalogOverlay AFTER genre classification has already run.
  const rawGenres: unknown[] = Array.isArray(title.genre_payload)
    ? title.genre_payload as unknown[]
    : Array.isArray(tmdb.genres)
      ? tmdb.genres
      : Array.isArray(metadata.genres)
        ? metadata.genres
        : [];
  return rawGenres
    .map((genre: unknown) => typeof genre === "string" ? genre : stringOrNull(recordOrEmpty(genre).name))
    .filter((genre: string | null): genre is string => Boolean(genre));
}

function sameGenre(left: string, right: string) {
  return normalizeGenre(left) === normalizeGenre(right);
}

function normalizeGenre(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compareTitleVariants(left: JsonRecord, right: JsonRecord) {
  return numberOr(left.playback_cost_score, 9999) - numberOr(right.playback_cost_score, 9999) ||
    numberOr(left.last_observed_ttff_ms, 999999) - numberOr(right.last_observed_ttff_ms, 999999) ||
    qualityRank(right.quality) - qualityRank(left.quality) ||
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
}

function qualityRank(value: unknown) {
  const text = String(value ?? "").toUpperCase();
  if (text.includes("4K") || text.includes("UHD") || text.includes("2160")) return 4;
  if (text.includes("FHD") || text.includes("1080")) return 3;
  if (text.includes("HD") || text.includes("720")) return 2;
  if (text.includes("SD") || text.includes("480")) return 1;
  return 0;
}

function numberOr(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function titleVariantItem(variant: JsonRecord) {
  const audioVerified = Boolean(variant.__file_audio_verified_at);
  const rawAudioTracks = Array.isArray(variant.__file_audio_tracks)
    ? variant.__file_audio_tracks as JsonRecord[]
    : undefined;
  // Exact-file probe tags remain useful catalogue evidence. Whisper verification
  // upgrades/corrects them, but a stricter verifier must never erase the probe.
  const audioTracks = rawAudioTracks;
  const subtitleTracks = Array.isArray(variant.__file_subtitle_tracks)
    ? variant.__file_subtitle_tracks
    : undefined;
  const audioLanguages = variant.__file_audio_observed === true
    ? canonicalFileLanguages(
      variant.__file_audio_languages ?? variant.__file_audio_declared_languages,
    )
    : undefined;
  const subtitleLanguages = variant.__file_subtitle_observed === true
    ? (Array.isArray(variant.__file_subtitle_languages) ? variant.__file_subtitle_languages : [])
    : undefined;
  return sanitizeCatalogVariant({
    id: variant.id,
    source_id: variant.source_id,
    sourceId: variant.source_id,
    media_item_id: variant.media_item_id,
    mediaItemId: variant.media_item_id,
    item_type: variant.item_type,
    itemType: variant.item_type,
    external_id: variant.external_id,
    item_id: variant.external_id,
    itemId: variant.external_id,
    raw_title: variant.raw_title,
    rawTitle: variant.raw_title,
    label: variant.label,
    language: variant.language,
    quality: variant.quality,
    resolution: variant.resolution,
    container_extension: variant.container_extension,
    containerExtension: variant.container_extension,
    poster_url: variant.poster_url,
    posterUrl: variant.poster_url,
    playback_hint: recordOrEmpty(variant.playback_hint),
    playbackHint: recordOrEmpty(variant.playback_hint),
    codec_profile: recordOrEmpty(variant.codec_profile),
    codecProfile: recordOrEmpty(variant.codec_profile),
    audio_tracks: audioTracks,
    audioTracks,
    audio_tracks_scope: audioTracks !== undefined ? "file" : undefined,
    audioTracksScope: audioTracks !== undefined ? "file" : undefined,
    audio_probed_at: variant.__file_audio_probed_at,
    audioProbedAt: variant.__file_audio_probed_at,
    audio_languages: audioLanguages,
    audioLanguages,
    audio_languages_scope: audioLanguages !== undefined ? "file" : undefined,
    audioLanguagesScope: audioLanguages !== undefined ? "file" : undefined,
    audio_languages_observed: audioLanguages !== undefined,
    audioLanguagesObserved: audioLanguages !== undefined,
    audio_language_validation_status: audioVerified ? "verified" :
      variant.__file_audio_observed === true && (audioLanguages?.length ?? 0) > 0
        ? "probed"
        : variant.__file_audio_observed === true ? "pending" : "not_analyzed",
    audioLanguageValidationStatus: audioVerified ? "verified" :
      variant.__file_audio_observed === true && (audioLanguages?.length ?? 0) > 0
        ? "probed"
        : variant.__file_audio_observed === true ? "pending" : "not_analyzed",
    audio_language_verified_at: variant.__file_audio_verified_at,
    audioLanguageVerifiedAt: variant.__file_audio_verified_at,
    audio_language_verification: recordOrEmpty(variant.__file_audio_verification),
    audioLanguageVerification: recordOrEmpty(variant.__file_audio_verification),
    subtitle_tracks: subtitleTracks,
    subtitleTracks,
    subtitle_tracks_scope: subtitleTracks !== undefined ? "file" : undefined,
    subtitleTracksScope: subtitleTracks !== undefined ? "file" : undefined,
    subtitle_probed_at: variant.__file_subtitle_probed_at,
    subtitleProbedAt: variant.__file_subtitle_probed_at,
    subtitle_languages: subtitleLanguages,
    subtitleLanguages,
    subtitle_languages_scope: subtitleLanguages !== undefined ? "file" : undefined,
    subtitleLanguagesScope: subtitleLanguages !== undefined ? "file" : undefined,
    subtitle_languages_observed: subtitleLanguages !== undefined,
    subtitleLanguagesObserved: subtitleLanguages !== undefined,
    compatibility_tier: variant.compatibility_tier,
    compatibilityTier: variant.compatibility_tier,
    playback_cost_score: variant.playback_cost_score,
    playbackCostScore: variant.playback_cost_score,
    last_observed_ttff_ms: variant.last_observed_ttff_ms,
    lastObservedTtffMs: variant.last_observed_ttff_ms,
    metadata: recordOrEmpty(variant.metadata),
  });
}

async function listRawMediaRail(userId: string, itemType: "movie" | "series", id: string, title: string, limit: number) {
  const { data, error } = await db
    .from("cloud_catalog_visible_media_items")
    .select("*")
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .eq("available", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throwDb(error, "Unable to list fallback home rail");
  return {
    id,
    title,
    itemType,
    source: "raw",
    items: (data ?? []).map((item) => sanitizeCatalogMediaItem({
      ...item,
      type: item.item_type,
      item_id: item.external_id,
      itemId: item.external_id,
      name: item.title,
      stream_icon: item.poster_url,
      data: {
        ...recordOrEmpty(item.metadata),
        sourceId: item.source_id,
        containerExtension: recordOrEmpty(item.playback_hint).container,
      },
    })),
  };
}

async function listLiveLogicalChannels(url: URL, userId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const country = url.searchParams.get("country") || "FR";
  const categoryId = url.searchParams.get("categoryId");
  const search = stringOrNull(url.searchParams.get("q"));
  const includeVariants = boolParam(url.searchParams.get("includeVariants"));
  const materialized = await listMaterializedLiveLogicalChannels(url, userId, { sourceId, country, categoryId, search, includeVariants });
  if (materialized) return materialized;
  const maxRows = boundedInt(url.searchParams.get("maxRows"), LIVE_MAX_ROWS, 1000, LIVE_MAX_ROWS);
  const rows = await listLiveRows(userId, sourceId, maxRows);
  const catalog = buildLiveCatalog(rows, { country, sourceId, categoryId, includeVariants });
  if (search) {
    const needle = normalizeSearchText(search);
    catalog.channels = (catalog.channels || []).filter((channel) => {
      const title = normalizeSearchText(stringFrom(channel.title ?? channel.name));
      const group = normalizeSearchText(stringFrom(channel.category_name ?? channel.group_name ?? channel.section));
      return title.includes(needle) || group.includes(needle);
    });
    catalog.count = catalog.channels.length;
    catalog.groups = liveGroupsFromChannels(catalog.channels);
  }
  return { ...catalog, materialized: false };
}

async function listLiveChannelVariants(url: URL, userId: string, logicalId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const country = url.searchParams.get("country") || "FR";
  const materialized = await listMaterializedLiveChannelVariants(userId, logicalId, sourceId, country);
  if (materialized) return materialized;
  const rows = await listLiveRows(userId, sourceId, boundedInt(url.searchParams.get("maxRows"), LIVE_MAX_ROWS, 1000, LIVE_MAX_ROWS));
  const catalog = buildLiveCatalog(rows, { country, sourceId, includeVariants: true });
  const channel = findLiveChannel(catalog, logicalId);
  if (!channel) throw new HttpError(404, "Logical channel not found");
  return {
    contract: "norva.live.logical.v1",
    materialized: false,
    channel,
    variants: Array.isArray(channel.variants) ? channel.variants : [],
  };
}

// Overlay live channel rows' heavy display fields from the provider-global
// catalog_live_logical_channels (keyed by server_host + logical_id), mirroring
// applyMediaCatalogOverlay. Targets the biggest live bloat — default_variant +
// variant_preview (the TOAST-heavy JSON summaries) — plus poster/icon/playback_hint/
// metadata, so the per-user copy can later drop them. section/lcn/title stay on the
// per-user row (the lineup sorts on them). Fills only where global has a value.
async function applyLiveCatalogOverlay(rows: Array<Record<string, any>>, sourceId: string, userId: string) {
  if (!rows.length) return;
  const { data: src } = await db.from("cloud_catalog_visible_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
  const host = String((src as any)?.config_hint?.serverHost || "").trim();
  if (!host) return;
  const ids = [...new Set(rows.map((row) => String(row.logical_id || "")).filter(Boolean))];
  if (!ids.length) return;
  const byId = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await (db as any)
      .from("catalog_live_logical_channels")
      .select("logical_id,title,category_name,poster_url,stream_icon,default_stream_id,variant_count,default_variant,variant_preview,playback_hint,metadata")
      .eq("server_host", host)
      .in("logical_id", ids.slice(i, i + 500));
    for (const g of (data ?? []) as Array<Record<string, any>>) byId.set(String(g.logical_id), g);
  }
  if (!byId.size) return;
  for (const r of rows) {
    const g = byId.get(String(r.logical_id));
    if (!g) continue;
    if (g.poster_url) r.poster_url = g.poster_url;
    if (g.stream_icon) r.stream_icon = g.stream_icon;
    if (g.default_stream_id) r.default_stream_id = g.default_stream_id;
    if (g.title && !String(r.title || "").trim()) r.title = g.title;
    if (g.category_name && !String(r.category_name || "").trim()) r.category_name = g.category_name;
    if (typeof g.variant_count === "number" && g.variant_count) r.variant_count = g.variant_count;
    if (isRecord(g.default_variant) && Object.keys(g.default_variant).length) r.default_variant = g.default_variant;
    if (Array.isArray(g.variant_preview) && g.variant_preview.length) r.variant_preview = g.variant_preview;
    if (isRecord(g.playback_hint) && Object.keys(g.playback_hint).length) r.playback_hint = g.playback_hint;
    if (isRecord(g.metadata) && Object.keys(g.metadata).length) r.metadata = g.metadata;
  }
}

async function listMaterializedLiveLogicalChannels(
  url: URL,
  userId: string,
  options: { sourceId: string | null; country: string; categoryId: string | null; search: string | null; includeVariants: boolean },
) {
  try {
    const limit = boundedInt(url.searchParams.get("limit"), LIVE_PAGE_SIZE, 1, LIVE_PAGE_SIZE);
    const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
    const { rows, total } = options.search || options.categoryId
      ? await listFilteredMaterializedLiveRows(userId, options, limit, offset)
      : await listOrderedMaterializedLiveRows(userId, options, limit, offset);
    if (!rows.length) return null;

    // Phase 2 dedup: overlay channel display fields from the provider-global cache.
    if (mediaReadFromCatalog() && options.sourceId) {
      await applyLiveCatalogOverlay(rows, options.sourceId, userId);
    }

    let variantsByChannelId = new Map<string, JsonRecord[]>();
    if (options.includeVariants) {
      variantsByChannelId = await listMaterializedVariantsByChannelIds(rows.map((row) => String(row.id)));
    }

    const channels = rankLiveSearchChannels(
      rows
        .filter((row) => materializedRowMatchesCountry(row, options.country))
        .map((row) => materializedChannel(row, variantsByChannelId.get(String(row.id)) ?? null)),
      options.search,
    );
    if (!channels.length && rows.length) return null;
    return {
      contract: "norva.live.logical.v1",
      country: options.country,
      sourceId: options.sourceId || null,
      materialized: true,
      syncedAt: rows.reduce((latest: string | null, row) => {
        const syncedAt = stringOrNull(row.synced_at);
        return syncedAt && (!latest || syncedAt > latest) ? syncedAt : latest;
      }, null),
      channels,
      groups: liveGroupsFromChannels(channels),
      count: channels.length,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      rawCount: null,
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return null;
    throw error;
  }
}

async function listFilteredMaterializedLiveRows(
  userId: string,
  options: { sourceId: string | null; categoryId: string | null; search: string | null },
  limit: number,
  offset: number,
) {
  let query = db
    .from("cloud_catalog_visible_live_logical_channels")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("section", { ascending: true })
    .order("lcn", { ascending: true, nullsFirst: false })
    .order("title", { ascending: true })
    .range(offset, offset + limit - 1);

  if (options.sourceId) query = query.eq("source_id", options.sourceId);
  if (options.categoryId) query = query.eq("category_id", options.categoryId);
  if (options.search) {
    const like = escapePostgrestLike(options.search);
    query = query.or([
      `title.ilike.%${like}%`,
      `logical_key.ilike.%${like}%`,
      `category_name.ilike.%${like}%`,
      `section.ilike.%${like}%`,
    ].join(","));
  }

  const { data, count, error } = await query;
  if (error) {
    if (isMissingMaterialization(error)) return { rows: [], total: 0 };
    throwDb(error, "Unable to list materialized live catalog");
  }
  return { rows: data ?? [], total: count ?? (data ?? []).length };
}

async function listOrderedMaterializedLiveRows(
  userId: string,
  options: { sourceId: string | null },
  limit: number,
  offset: number,
) {
  const rows: JsonRecord[] = [];
  let total = 0;
  let skip = offset;
  let remaining = limit;

  for (const section of LIVE_SECTION_ORDER) {
    const sectionCount = await countMaterializedLiveSection(userId, options.sourceId, section);
    total += sectionCount;
    if (remaining <= 0) continue;
    if (skip >= sectionCount) {
      skip -= sectionCount;
      continue;
    }

    let query = db
      .from("cloud_catalog_visible_live_logical_channels")
      .select("*")
      .eq("user_id", userId)
      .eq("section", section)
      .order("lcn", { ascending: true, nullsFirst: false })
      .order("category_name", { ascending: true })
      .order("title", { ascending: true })
      .range(skip, skip + remaining - 1);

    if (options.sourceId) query = query.eq("source_id", options.sourceId);

    const { data, error } = await query;
    if (error) {
      if (isMissingMaterialization(error)) return { rows: [], total: 0 };
      throwDb(error, "Unable to list ordered materialized live catalog");
    }

    const chunk = data ?? [];
    rows.push(...chunk);
    remaining -= chunk.length;
    skip = 0;
  }

  return { rows, total };
}

async function countMaterializedLiveSection(userId: string, sourceId: string | null, section: string) {
  let query = db
    .from("cloud_catalog_visible_live_logical_channels")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("section", section);

  if (sourceId) query = query.eq("source_id", sourceId);

  const { count, error } = await query;
  if (error) {
    if (isMissingMaterialization(error)) return 0;
    throwDb(error, "Unable to count materialized live section");
  }
  return count ?? 0;
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rankLiveSearchChannels(channels: JsonRecord[], search: string | null) {
  if (!search) return channels;
  const needle = normalizeSearchText(search);
  if (!needle) return channels;
  const score = (channel: JsonRecord) => {
    const title = normalizeSearchText(stringFrom(channel.title ?? channel.name));
    const group = normalizeSearchText(stringFrom(channel.category_name ?? channel.group_name ?? channel.section));
    if (title === needle) return 1000;
    if (title.startsWith(`${needle} `) || title.startsWith(`${needle}-`) || title.startsWith(`${needle}:`)) return 900;
    if (title.startsWith(needle)) return 800;
    if (title.includes(` ${needle} `) || title.endsWith(` ${needle}`)) return 650;
    if (title.includes(needle)) return 500;
    if (group.includes(needle)) return 250;
    return 0;
  };
  return channels
    .map((channel, index) => ({ channel, index, score: score(channel) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.channel);
}

function stringFrom(value: unknown) {
  return typeof value === "string" ? value : "";
}

function escapePostgrestLike(value: string) {
  return value.replace(/[%_,()]/g, (char) => `\\${char}`);
}

async function listMaterializedLiveChannelVariants(userId: string, logicalId: string, sourceId: string | null, country: string) {
  try {
    let query = db
      .from("cloud_catalog_visible_live_logical_channels")
      .select("*")
      .eq("user_id", userId)
      .eq("logical_id", logicalId);
    if (sourceId) query = query.eq("source_id", sourceId);

    const { data: channel, error } = await query.maybeSingle();
    if (error) {
      if (isMissingMaterialization(error)) return null;
      throwDb(error, "Unable to load materialized live channel");
    }
    if (!channel || !materializedRowMatchesCountry(channel, country)) return null;

    // Phase 2 dedup: overlay this channel's display fields from the global cache.
    if (mediaReadFromCatalog() && sourceId) {
      await applyLiveCatalogOverlay([channel], sourceId, userId);
    }

    const { data: variants, error: variantsError } = await db
      .from("cloud_catalog_visible_live_variants")
      .select("*")
      .eq("user_id", userId)
      .eq("logical_channel_id", channel.id)
      .order("health_rank", { ascending: true })
      .order("rank", { ascending: true })
      .order("label", { ascending: true });
    if (variantsError) throwDb(variantsError, "Unable to load materialized live variants");
    const normalizedVariants = (variants ?? []).map(materializedVariant);
    return {
      contract: "norva.live.logical.v1",
      country,
      sourceId: channel.source_id,
      materialized: true,
      channel: materializedChannel(channel, variants ?? []),
      variants: normalizedVariants,
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return null;
    throw error;
  }
}

async function listMaterializedVariantsByChannelIds(channelIds: string[]) {
  const variantsByChannelId = new Map<string, JsonRecord[]>();
  for (let index = 0; index < channelIds.length; index += 200) {
    const chunk = channelIds.slice(index, index + 200);
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("cloud_catalog_visible_live_variants")
      .select("*")
      .in("logical_channel_id", chunk)
      .order("health_rank", { ascending: true })
      .order("rank", { ascending: true })
      .order("label", { ascending: true });
    if (error) throwDb(error, "Unable to list materialized live variants");
    for (const variant of data ?? []) {
      const id = String(variant.logical_channel_id);
      const existing = variantsByChannelId.get(id) ?? [];
      existing.push(variant);
      variantsByChannelId.set(id, existing);
    }
  }
  return variantsByChannelId;
}

function materializedChannel(row: JsonRecord, variantRows: JsonRecord[] | null = null) {
  const defaultVariant = recordOrEmpty(row.default_variant);
  const variants = Array.isArray(variantRows) ? variantRows.map(materializedVariant) : null;
  const preview = Array.isArray(row.variant_preview) ? row.variant_preview : [];
  const channel: JsonRecord = {
    id: row.logical_id,
    logical_id: row.logical_id,
    logical_key: row.logical_key,
    source_id: row.source_id,
    sourceId: row.source_id,
    item_type: "live",
    type: "live",
    external_id: defaultVariant.external_id ?? row.default_stream_id,
    stream_id: defaultVariant.stream_id ?? defaultVariant.streamId ?? row.default_stream_id,
    streamId: defaultVariant.streamId ?? defaultVariant.stream_id ?? row.default_stream_id,
    title: row.title,
    name: row.title,
    lcn: row.lcn ?? null,
    num: row.lcn ?? null,
    section: row.section,
    category_id: row.category_id,
    category_name: row.category_name,
    group_id: row.category_id,
    group_name: row.category_name,
    poster_url: row.poster_url,
    stream_icon: row.stream_icon,
    variant_count: row.variant_count,
    variantCount: row.variant_count,
    variant_preview: preview,
    default_variant: defaultVariant,
    defaultVariant,
    playback_hint: recordOrEmpty(row.playback_hint),
    playbackHint: recordOrEmpty(row.playback_hint),
    metadata: {
      ...recordOrEmpty(row.metadata),
      logical: true,
      materialized: true,
      syncedAt: row.synced_at,
    },
  };
  if (variants) channel.variants = variants;
  return sanitizeLiveChannel(channel);
}

function materializedVariant(row: JsonRecord) {
  return sanitizeLiveVariant({
    id: `${row.source_id}:${row.stream_id}`,
    media_item_id: row.media_item_id ?? null,
    mediaItemId: row.media_item_id ?? null,
    label: row.label,
    rank: row.rank,
    healthRank: row.health_rank,
    health_rank: row.health_rank,
    source_id: row.source_id,
    sourceId: row.source_id,
    stream_id: row.stream_id,
    streamId: row.stream_id,
    external_id: row.external_id,
    item_type: "live",
    raw: row.raw_title ?? row.title,
    title: row.title,
    name: row.title,
    poster_url: row.poster_url,
    stream_icon: row.stream_icon,
    category_id: row.category_id,
    category_name: row.category_name,
    playback_hint: recordOrEmpty(row.playback_hint),
    playbackHint: recordOrEmpty(row.playback_hint),
    metadata: recordOrEmpty(row.metadata),
    container_extension: row.container_extension,
  });
}

function materializedRowMatchesCountry(row: JsonRecord, country: string) {
  const requested = String(country || "FR").toUpperCase();
  const metadata = recordOrEmpty(row.metadata);
  const actual = stringOrNull(metadata.country)?.toUpperCase() || "FR";
  return actual === requested;
}

function liveGroupsFromChannels(channels: JsonRecord[]) {
  const groups = new Map<string, JsonRecord>();
  for (const channel of channels) {
    const id = String(channel.category_id || "uncategorized");
    const existing = groups.get(id) ?? {
      id,
      category_id: id,
      name: channel.category_name || id,
      category_name: channel.category_name || id,
      priority: id === "primary" ? 1 : id === "regional" ? 2 : id === "multiplex" ? 3 : 20,
      defaultCollapsed: id !== "primary",
      count: 0,
    };
    existing.count = Number(existing.count || 0) + 1;
    groups.set(id, existing);
  }
  return [...groups.values()].sort((a, b) =>
    (Number(a.priority || 20) - Number(b.priority || 20)) ||
    String(a.category_name || a.name).localeCompare(String(b.category_name || b.name), undefined, { sensitivity: "base" })
  );
}

async function listLiveRows(userId: string, sourceId: string | null, maxRows: number): Promise<LiveCatalogItem[]> {
  const rows: LiveCatalogItem[] = [];
  for (let offset = 0; offset < maxRows; offset += LIVE_PAGE_SIZE) {
    let query = db
      .from("cloud_catalog_visible_media_items")
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("user_id", userId)
      .eq("item_type", "live")
      .eq("available", true)
      .order("title", { ascending: true })
      .order("external_id", { ascending: true })
      .range(offset, offset + LIVE_PAGE_SIZE - 1);

    if (sourceId) query = query.eq("source_id", sourceId);

    const { data, error } = await query;
    if (error) throwDb(error, "Unable to list live catalog");
    const chunk = (data ?? []) as LiveCatalogItem[];
    rows.push(...chunk);
    if (chunk.length < LIVE_PAGE_SIZE) break;
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOrNull(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function isMissingMaterialization(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: string; message?: string };
  const message = String(record.message || "");
  return record.code === "42P01" || message.includes("cloud_live_") || message.includes("cloud_title");
}

function isMissingRatingsExpansion(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST204";
}

function publicErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/i.test(code)
    ? code
    : "unknown";
}

function bearer(req: Request) {
  return (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function routeSegments(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "norva-catalog") parts.shift();
  return parts;
}

function isLiveLogicalChannelsRoute(segments: string[]) {
  return (
    (segments[0] === "live" && segments[1] === "logical-channels") ||
    (segments[0] === "device" && segments[1] === "live" && segments[2] === "logical-channels")
  );
}

function isLiveChannelVariantsRoute(segments: string[]) {
  return (
    (segments[0] === "live" && segments[1] === "channel" && Boolean(segments[2]) && segments[3] === "variants") ||
    (segments[0] === "device" && segments[1] === "live" && segments[2] === "channel" && Boolean(segments[3]) && segments[4] === "variants")
  );
}

function isHomeRailsRoute(segments: string[]) {
  return (
    (segments[0] === "home" && segments[1] === "rails") ||
    (segments[0] === "device" && segments[1] === "home" && segments[2] === "rails")
  );
}

function liveChannelIdFromRoute(segments: string[]) {
  const id = segments[0] === "device" ? segments[3] : segments[2];
  if (!id) throw new HttpError(400, "Missing logical channel id");
  return decodeURIComponent(id);
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

// Historical call sites still pass a TTL, but authenticated catalog responses must
// always revalidate with the server. A tab can sit idle while another device performs
// an atomic source cutover; a browser-fresh response keyed to the old epoch would then
// bypass both the server's final epoch check and the client's epoch observation. The
// in-memory client cache remains short-lived and epoch-scoped, so this only disables
// the independent browser HTTP cache.
function jsonCached(req: Request, data: unknown, cacheSeconds: number, status = 200) {
  void cacheSeconds;
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      ...catalogVisibilityEpochHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Vary": "Origin, Authorization, x-norva-profile-id",
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

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boolParam(value: unknown) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
