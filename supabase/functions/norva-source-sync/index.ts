import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildLiveMaterializationPlan,
  clearLiveMaterialization,
  fetchLiveChannelIdMap,
  materializeLiveChunk,
  refreshMaterializedLiveCatalog,
  upsertLiveChannelRows,
  upsertLiveVariantRows,
} from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection, validateTmdbCandidate, searchTmdbMatch } from "../_shared/vod-title-projection.ts";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { getEntitlementDecision, planFeatureEntitled, realPlanCode } from "../_shared/entitlements.ts";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string; mediaGatewayUrl: string; mediaGatewayToken: string };

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
  "https://www.norva.tv",
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
      return json(req, { ok: true, service: "norva-source-sync", version: 8, liveMaterialization: true, syncProgress: true, catalogFinalize: true, catalogFinalizeBatches: true, liveFinalizeBatches: true, yearBackfill: true });
    }
    // Premium per-user background refresh (pg_cron → here). Drives a small batch
    // of due, entitled sources through the same sync state machine — locked,
    // backed-off and change-detection-cheap. Dormant until a user is actually
    // entitled to auto_refresh_background.
    //
    // Authorized by a dedicated cron secret that lives only in Vault (single
    // source of truth — never in this repo, an env var, or the pg_cron command).
    // pg_cron pulls it from Vault and sends it as the bearer; here we verify it
    // via a service_role-only SECURITY DEFINER function that returns just a
    // boolean, so the secret never leaves the database. The service key still
    // works as an admin fallback for manual triggering.
    if (req.method === "POST" && segments[0] === "cron") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      let authorized = SUPABASE_SERVICE_KEY !== "" && token === SUPABASE_SERVICE_KEY;
      if (!authorized && token) {
        const { data: ok } = await supabase.rpc("norva_verify_cron_secret", { presented: token });
        authorized = ok === true;
      }
      if (!authorized) {
        return json(req, { error: "forbidden" }, 403);
      }
      if (segments[1] === "refresh-due") {
        return json(req, await cronRefreshDue(supabase));
      }
      // Service-authed finalize drivers (no user session), for recovering a
      // source whose client-side finalize was interrupted:
      //  • /cron/finalize/:id       — best-effort budget-bounded loop in ONE
      //    isolate. Fine for small sources; a big catalogue can exhaust the
      //    isolate's CPU mid-rebuild, so prefer the stepper below for those.
      //  • /cron/finalize-step/:id  — runs exactly ONE finalize batch and returns
      //    the next {nextPhase, nextOffset}. Call it in a loop (each call a fresh
      //    isolate, like the client) to materialize a large source reliably.
      if (segments[1] === "finalize" && segments[2]) {
        return json(req, await cronFinalizeSource(supabase, segments[2], url.searchParams.get("country")));
      }
      if (segments[1] === "finalize-step" && segments[2]) {
        const { data: src } = await supabase.from("cloud_sources").select("user_id").eq("id", segments[2]).maybeSingle();
        if (!src) return json(req, { error: "source not found" }, 404);
        const result = await finalizeCloudSource(segments[2], String(src.user_id), supabase, {
          country: url.searchParams.get("country"),
          phase: stringOr(url.searchParams.get("phase"), "live"),
          offset: Number(url.searchParams.get("offset")) || 0,
          afterId: stringOr(url.searchParams.get("afterId"), ""),
          limit: Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1500)),
        });
        return json(req, result);
      }
      // Resumable-discovery continuation. driveXtreamSyncToReady self-invokes this
      // between isolates to import an "8K"-scale catalogue across several short
      // background runs; kicks the next step and returns immediately.
      if (segments[1] === "sync-step" && segments[2]) {
        const { data: src } = await supabase.from("cloud_sources").select("user_id, source_type").eq("id", segments[2]).maybeSingle();
        if (!src) return json(req, { error: "source not found" }, 404);
        if (String(src.source_type) === "xtream") {
          runInBackground(driveXtreamSyncToReady(segments[2], String(src.user_id), supabase));
        }
        return json(req, { ok: true, started: true, sourceId: segments[2] });
      }
      // Watchdog: re-kick discovery chains whose isolate died silently (heartbeat
      // went stale), so a big import always finishes even if the chain breaks.
      if (segments[1] === "resume-stuck") {
        return json(req, await cronResumeStuck(supabase));
      }
      // Backfill release_year from TMDB for unverified titles. One batch per call
      // (cursor-resumable); drive it in a loop until {done:true}.
      if (segments[1] === "backfill-years") {
        const limit = boundedInt(url.searchParams.get("limit"), 300, 1, 1000);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 15, 1, 50);
        return json(req, await cronBackfillYears(supabase, limit, reset, concurrency));
      }
      // Re-validate unverified titles against every language (multi-lang matching).
      if (segments[1] === "revalidate") {
        const limit = boundedInt(url.searchParams.get("limit"), 150, 1, 500);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 12, 1, 30);
        return json(req, await cronRevalidate(supabase, limit, reset, concurrency));
      }
      // Search-match titles that have no provider TMDB id (TMDB search + confirm).
      if (segments[1] === "search-match") {
        const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 300);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 8, 1, 20);
        return json(req, await cronSearchMatch(supabase, limit, reset, concurrency));
      }
      return json(req, { error: "not_found" }, 404);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "sync") {
      const user = await requireUser(req, supabase);
      const force = url.searchParams.get("force") === "1";
      const result = await syncCloudSource(segments[1], user.id, supabase, url.searchParams.get("country"), { force });
      return json(req, result);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "finalize") {
      const user = await requireUser(req, supabase);
      const result = await finalizeCloudSource(segments[1], user.id, supabase, {
        country: url.searchParams.get("country"),
        phase: stringOr(url.searchParams.get("phase"), "live"),
        offset: boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000),
        // Keyset cursor for the titles phase — the client threads it back from each
        // response so it resumes the same forward walk the background driver uses
        // (and cooperates with it) instead of re-scanning by OFFSET.
        afterId: stringOr(url.searchParams.get("afterId"), ""),
        limit: boundedInt(url.searchParams.get("limit"), 1000, 1, 2000),
      });
      return json(req, result);
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-source-sync]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function requireUser(req: Request, db: SupabaseClient) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { id: data.user.id, email: data.user.email ?? undefined };
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
  if (error) console.warn("[norva-source-sync] Unable to update source sync progress", error.message);
}

async function syncCloudSource(sourceId: string, userId: string, db: SupabaseClient, country: string | null = null, opts: { force?: boolean; rawOnly?: boolean } = {}) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");
  if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");

  // Previously-imported catalogue fingerprint, for change-detection.
  const previousSignature = recordOrEmpty(source.config_hint).contentSignature;
  const startedAt = new Date().toISOString();
  const baseHint = recordOrEmpty(source.config_hint);

  // Detection-only (cron): never mutate the catalogue, materialization, signature
  // or sync_status — stream the provider and compare its signature against our
  // last full import, surfacing the app-closed "what's new" signal on growth.
  // Memory-safe (only the running fingerprint is held, never the rows).
  if (opts.rawOnly) {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    let result: JsonRecord | null = null;
    if (source.source_type === "xtream") {
      result = await detectXtreamChange(sourceId, userId, config, db, previousSignature);
    } else if (source.source_type === "m3u") {
      result = await syncM3uSource(sourceId, userId, config, db, country, async () => {}, { previousSignature, force: false, rawOnly: true }) as unknown as JsonRecord;
    }
    if (!result) return { sourceId, status: "detected", changed: false };
    if (result.changed) await maybeRecordContentEvent(db, userId, sourceId, previousSignature, result);
    return { sourceId, status: "detected", changed: Boolean(result.changed), ...result };
  }

  let progress: JsonRecord = compactRecord({
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
    // Idempotent re-sync: if a discovery chain is already in flight, join it
    // instead of restarting (a restart wipes + re-imports and the two
    // generations deadlock each other). Only force=1 forces a clean restart.
    const cur = recordOrEmpty(baseHint.syncCursor);
    const heartbeat = Date.parse(stringOr(cur.heartbeatAt, "")) || 0;
    const inDiscovery = cur.active === true && stringOr(cur.phase, "") === "discover";
    if (!opts.force && inDiscovery && String(source.sync_status) === "syncing") {
      if (Date.now() - heartbeat < 75_000) {
        return { sourceId, status: "syncing", started: false, joined: true };
      }
      // Heartbeat went stale → the chain died mid-run; resume without wiping.
      runInBackground(driveXtreamSyncToReady(sourceId, userId, db));
      return { sourceId, status: "syncing", started: true, resumed: true };
    }

    // "8K"-scale catalogues can't be discovered + imported + materialized in one
    // edge isolate. Reset the resumable cursor, then drive discovery in the
    // background (it self-continues across isolates to the finalize-pending
    // handoff). Return immediately so the caller/route isn't held open.
    const cursor = freshSyncCursor(startedAt, { country, force: Boolean(opts.force), previousSignature });
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
    runInBackground(driveXtreamSyncToReady(sourceId, userId, db));
    return { sourceId, status: "syncing", started: true };
  }

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

  const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
    progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  try {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    const syncOpts = { previousSignature, force: opts.force, rawOnly: false };
    const result = source.source_type === "m3u"
      ? await syncM3uSource(sourceId, userId, config, db, country, reportProgress, syncOpts)
      : { total: 0 };
    const resultRecord = result as JsonRecord;

    if (source.source_type === "m3u" && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    const syncedAt = new Date().toISOString();
    const { error: updateError } = await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: syncedAt,
        config_hint: compactRecord({
          ...recordOrEmpty(source.config_hint),
          contentSignature: resultRecord.contentSignature ?? previousSignature,
          lastSync: { ...result, syncedAt },
          syncProgress: completedSyncProgress(result, startedAt, syncedAt),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (updateError) throwDb(updateError, "Unable to update source sync status");

    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, resultRecord);
    return { sourceId, status: "ready", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source sync failed";
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: new Date().toISOString(),
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: mergeSyncProgress(progress, {
            status: "error",
            stage: "error",
            percent: Number(progress.percent ?? 0) || 0,
            updatedAt: new Date().toISOString(),
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    throw error;
  }
}

// Run a promise to completion after the HTTP response is sent. Supabase exposes
// EdgeRuntime.waitUntil to keep the isolate alive for background work; fall back
// to a detached promise where it isn't present.
function runInBackground(task: Promise<unknown>) {
  const safe = task.catch((e) => console.error("[cron] background task failed", e));
  try {
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) { er.waitUntil(safe); return; }
  } catch (_) { /* ignore — fall through to detached */ }
  void safe;
}

// ── Release-year backfill ────────────────────────────────────────────────────
// Provider VOD/series lists carry no release year, and many cloud_titles rows are
// "provider_unverified" (TMDB id known, details never fetched) so their
// release_year is null — leaving blanks on the browse grid even after the
// read-time projection in norva-catalog. This walks those rows by id cursor and
// fills release_year from TMDB: one fetch per distinct movie/series id, fanned out
// to every row that shares it. Resumable + idempotent — the cursor in
// norva_year_backfill_state only moves forward, and a found year is written only
// where release_year is still null.
function tmdbApiKey() {
  return stringOr(
    Deno.env.get("NORVA_TMDB_API_KEY") ?? Deno.env.get("TMDB_API_KEY") ?? Deno.env.get("TMDB_READ_TOKEN"),
    "",
  );
}

// number → year found; null → TMDB has no date (don't retry); "error" → transient.
async function fetchTmdbYear(apiKey: string, itemType: string, tmdbId: string): Promise<number | null | "error"> {
  const endpoint = itemType === "series" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
  const headers: Record<string, string> = {};
  if (apiKey.startsWith("eyJ")) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set("api_key", apiKey);
  const language = stringOr(Deno.env.get("NORVA_TMDB_LANGUAGE"), "en-US");
  if (language) url.searchParams.set("language", language);
  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return null;            // no such title → stop retrying
    if (!res.ok) return "error";                    // rate-limited / 5xx → retry later
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const date = String((body?.release_date ?? body?.first_air_date) ?? "");
    const match = date.match(/(19|20)\d{2}/);
    if (!match) return null;                         // matched, but TMDB has no date
    const year = Number(match[0]);
    return Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null;
  } catch (_) {
    return "error";
  }
}

async function cronBackfillYears(db: SupabaseClient, limit: number, reset: boolean, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };

  let cursor: string | null = null;
  if (!reset) {
    const { data } = await db.from("norva_year_backfill_state").select("last_id").eq("id", 1).maybeSingle();
    cursor = (data?.last_id as string | null) ?? null;
  }

  let q = db
    .from("cloud_titles")
    .select("id, item_type, provider_tmdb_id")
    .is("release_year", null)
    .not("provider_tmdb_id", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt("id", cursor);

  const { data: rows, error } = await q;
  if (error) throw new HttpError(500, "backfill select failed", error.message);

  const scanned = rows?.length ?? 0;
  if (!scanned) {
    await db.from("norva_year_backfill_state")
      .update({ done: true, last_run: { scanned: 0, done: true, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
      .eq("id", 1);
    return { scanned: 0, distinct: 0, found: 0, updated: 0, done: true };
  }

  // One fetch per distinct (item_type, tmdbId); remember the cursor end.
  const distinct = new Map<string, { itemType: string; tmdbId: string }>();
  let maxId = cursor;
  for (const row of rows!) {
    maxId = String(row.id);
    const itemType = String(row.item_type);
    const tmdbId = stringOr(row.provider_tmdb_id, "");
    if (!tmdbId) continue;
    distinct.set(`${itemType}:${tmdbId}`, { itemType, tmdbId });
  }

  // Fetch years with bounded concurrency (TMDB tolerates ~40 in flight).
  const entries = [...distinct.values()];
  const yearByKey = new Map<string, number>();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const year = await fetchTmdbYear(apiKey, entry.itemType, entry.tmdbId);
      if (typeof year === "number") yearByKey.set(`${entry.itemType}:${entry.tmdbId}`, year);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, worker));

  // Write each found year to every row that shares the id and is still null.
  let updated = 0;
  for (const entry of entries) {
    const year = yearByKey.get(`${entry.itemType}:${entry.tmdbId}`);
    if (!year) continue;
    const { count } = await db
      .from("cloud_titles")
      .update({ release_year: year }, { count: "exact" })
      .eq("item_type", entry.itemType)
      .eq("provider_tmdb_id", entry.tmdbId)
      .is("release_year", null);
    updated += count ?? 0;
  }

  const done = scanned < limit;
  const summary = { scanned, distinct: distinct.size, found: yearByKey.size, updated, done };
  await db.from("norva_year_backfill_state")
    .update({ last_id: maxId, done, last_run: { ...summary, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
    .eq("id", 1);
  return summary;
}

// Re-validate titles that have a provider TMDB id but didn't pass the original
// (single-language) sanity check — now scored against EVERY language
// (alternative_titles + translations). Matches are promoted to provider_verified
// and get their i18n stored. Cursor-resumable; drive it like the year backfill.
async function cronRevalidate(db: SupabaseClient, limit: number, reset: boolean, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };

  let cursor: string | null = null;
  if (!reset) {
    const { data } = await db.from("norva_revalidate_state").select("last_id").eq("id", 1).maybeSingle();
    cursor = (data?.last_id as string | null) ?? null;
  }

  let q = db
    .from("cloud_titles")
    .select("id, item_type, provider_tmdb_id, title, original_title, release_year, metadata, poster_url, backdrop_url")
    .in("match_status", ["provider_unverified", "weak"])
    .not("provider_tmdb_id", "is", null)
    .neq("provider_tmdb_id", "0")
    .order("id", { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt("id", cursor);

  const { data: rows, error } = await q;
  if (error) throw new HttpError(500, "revalidate select failed", error.message);

  const scanned = rows?.length ?? 0;
  if (!scanned) {
    await db.from("norva_revalidate_state")
      .update({ done: true, last_run: { scanned: 0, revalidated: 0, done: true, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
      .eq("id", 1);
    return { scanned: 0, revalidated: 0, done: true };
  }

  const maxId = String(rows![rows!.length - 1].id);
  let next = 0;
  let revalidated = 0;
  const worker = async () => {
    while (next < rows!.length) {
      const row = rows![next++];
      const tmdbId = stringOr(row.provider_tmdb_id, "");
      if (!tmdbId) continue;
      const itemType = row.item_type === "series" ? "series" : "movie";
      try {
        const validation = await validateTmdbCandidate(apiKey, {
          itemType,
          tmdbId,
          title: stringOr(row.original_title ?? row.title, ""),
          year: row.release_year != null ? String(row.release_year) : null,
        });
        if (!validation.valid) continue;
        const metadata = isRecord(row.metadata) ? row.metadata : {};
        const { error: upErr } = await db.from("cloud_titles").update({
          match_status: "provider_verified",
          title: validation.title || row.title,
          poster_url: stringOr(row.poster_url, "") || validation.posterUrl,
          backdrop_url: stringOr(row.backdrop_url, "") || validation.backdropUrl,
          release_year: row.release_year ?? (validation.year ? Number(validation.year) : null),
          metadata: {
            ...metadata,
            tmdb: validation.details,
            i18n: validation.i18n,
            tmdbValidation: { valid: true, title: validation.title, year: validation.year, confidence: validation.confidence, reason: validation.reason },
            revalidatedAt: new Date().toISOString(),
          },
        }).eq("id", row.id);
        if (!upErr) revalidated += 1;
      } catch (_) { /* a TMDB hiccup must not abort the batch */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows!.length) }, worker));

  const done = scanned < limit;
  const summary = { scanned, revalidated, done };
  await db.from("norva_revalidate_state")
    .update({ last_id: maxId, done, last_run: { ...summary, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
    .eq("id", 1);
  return summary;
}

// Search-based matching for UNMATCHED titles (no provider TMDB id): find the title
// on TMDB by name+year and, when it confirms strongly, set the id + verify +
// localize it. Cursor-resumable; drive it like the other backfills. New ids can
// duplicate an existing tmdb: title — run the dedupe migration afterwards.
async function cronSearchMatch(db: SupabaseClient, limit: number, reset: boolean, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };

  let cursor: string | null = null;
  if (!reset) {
    const { data } = await db.from("norva_search_match_state").select("last_id").eq("id", 1).maybeSingle();
    cursor = (data?.last_id as string | null) ?? null;
  }

  let q = db
    .from("cloud_titles")
    .select("id, item_type, title, original_title, release_year, metadata, poster_url, backdrop_url")
    .eq("match_status", "unmatched")
    .order("id", { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt("id", cursor);

  const { data: rows, error } = await q;
  if (error) throw new HttpError(500, "search-match select failed", error.message);

  const scanned = rows?.length ?? 0;
  if (!scanned) {
    await db.from("norva_search_match_state")
      .update({ done: true, last_run: { scanned: 0, matched: 0, done: true, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
      .eq("id", 1);
    return { scanned: 0, matched: 0, done: true };
  }

  const maxId = String(rows![rows!.length - 1].id);
  let next = 0;
  let matched = 0;
  const worker = async () => {
    while (next < rows!.length) {
      const row = rows![next++];
      const itemType = row.item_type === "series" ? "series" : "movie";
      const title = stringOr(row.original_title ?? row.title, "");
      if (!title) continue;
      try {
        const match = await searchTmdbMatch(apiKey, itemType, title, row.release_year != null ? String(row.release_year) : null);
        if (!match) continue;
        const metadata = isRecord(row.metadata) ? row.metadata : {};
        const { error: upErr } = await db.from("cloud_titles").update({
          provider_tmdb_id: match.tmdbId,
          match_status: "provider_verified",
          title: match.title || row.title,
          poster_url: match.posterUrl || stringOr(row.poster_url, "") || null,
          backdrop_url: match.backdropUrl || stringOr(row.backdrop_url, "") || null,
          release_year: match.year ? Number(match.year) : row.release_year,
          metadata: {
            ...metadata,
            tmdb: match.details,
            i18n: match.i18n,
            tmdbValidation: { valid: true, title: match.title, year: match.year, confidence: match.confidence, reason: match.reason },
            searchMatchedAt: new Date().toISOString(),
          },
        }).eq("id", row.id);
        if (!upErr) matched += 1;
      } catch (_) { /* a TMDB hiccup must not abort the batch */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows!.length) }, worker));

  const done = scanned < limit;
  const summary = { scanned, matched, done };
  await db.from("norva_search_match_state")
    .update({ last_id: maxId, done, last_run: { ...summary, at: new Date().toISOString() }, updated_at: new Date().toISOString() })
    .eq("id", 1);
  return summary;
}

// Premium per-user background refresh — the step-5 state machine. Picks a small
// batch of DUE sources, ENFORCES the auto_refresh_background entitlement (skips
// anyone who isn't premium), and takes a compare-and-set lock so overlapping
// ticks can never double-run. Per source it runs a DETECTION-ONLY refresh in the
// background: fetch the provider catalogue and compare its signature against our
// last full import. That's the wall-clock-safe, app-closed "is there new content?"
// signal premium pays for — on a change it records a capped "what's new" event
// (surfaced in-app on open). It deliberately does NOT import or materialize here:
// the full delete+rebuild+materialization overruns a single isolate on big
// catalogues, so the proven client-driven, batched import/finalize still runs on
// the next open. We return the HTTP response at once (work runs in the
// background); on success the next window is scheduled, on a provider error it
// backs off exponentially. Locking also pushes the due window out by the lock
// TTL, so a source isn't re-picked mid-run — and if the isolate dies first, the
// lock self-frees after that same TTL and the source is retried on a later tick.
async function cronRefreshDue(db: SupabaseClient) {
  const CADENCE_MS = 6 * 60 * 60 * 1000;   // premium cadence: every 6h
  const LOCK_TTL_MS = 12 * 60 * 1000;      // a stuck/crashed run frees after 12 min
  const BATCH = 1;                          // sources kicked per tick — kept at 1 so a
                                            // background sync owns the isolate's budget
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleIso = new Date(nowMs - LOCK_TTL_MS).toISOString();
  const asMs = (v: unknown) => { const m = new Date(String(v ?? "")).getTime(); return Number.isFinite(m) ? m : 0; };

  const { data: due, error } = await db
    .from("cloud_sources")
    .select("id,user_id,source_type,auto_refresh_state,auto_refresh_next_at")
    .in("source_type", ["xtream", "m3u"])
    .or(`auto_refresh_next_at.is.null,auto_refresh_next_at.lte.${nowIso}`)
    .order("auto_refresh_next_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) return { ok: false, error: error.message };

  const schedule = (id: string, nextMs: number, state: JsonRecord) =>
    db.from("cloud_sources")
      .update({ auto_refresh_next_at: new Date(nextMs).toISOString(), auto_refresh_state: state })
      .eq("id", id); // a state without lockedAt releases the lock

  const toSync: { id: string; userId: string; state: JsonRecord }[] = [];
  let skipped = 0, notEntitled = 0;

  for (const src of (due ?? [])) {
    const id = String(src.id);
    const userId = String(src.user_id);
    const state = isRecord(src.auto_refresh_state) ? src.auto_refresh_state : {};

    // Backing off after a recent provider error → leave it alone this tick.
    if (asMs(state.backoffUntil) > nowMs) { skipped++; continue; }

    // ENFORCE premium. Non-entitled → push the next window out a full cadence so
    // we don't re-check it every tick.
    let entitled = false;
    try {
      const decision = await getEntitlementDecision(db, userId, { autoStartTrial: false });
      entitled = planFeatureEntitled(realPlanCode(decision), "auto_refresh_background");
    } catch (_) { entitled = false; }
    if (!entitled) { await schedule(id, nowMs + CADENCE_MS, { attempts: 0 }); notEntitled++; continue; }

    // Compare-and-set lock: only proceed if no fresh lock is held (another tick
    // holding it → update matches 0 rows → skip, no double-run). We also push the
    // due window out by the lock TTL so this source isn't re-picked while its
    // background sync runs.
    const { data: locked } = await db
      .from("cloud_sources")
      .update({
        auto_refresh_state: { ...state, lockedAt: nowIso },
        auto_refresh_next_at: new Date(nowMs + LOCK_TTL_MS).toISOString(),
      })
      .eq("id", id)
      .or(`auto_refresh_state->>lockedAt.is.null,auto_refresh_state->>lockedAt.lt.${staleIso}`)
      .select("id");
    if (!locked || !locked.length) { skipped++; continue; }

    toSync.push({ id, userId, state });
  }

  // Drive the heavy syncs in the background so pg_net gets a fast response rather
  // than holding the connection open for the whole import. Each job reschedules
  // itself (next window on success, exponential backoff on a provider error).
  if (toSync.length) {
    runInBackground((async () => {
      for (const job of toSync) {
        try {
          // Detection-only refresh: fetch the provider and compare its signature
          // against our last full import. On a change, a capped "what's new" event
          // is recorded (the app-closed premium signal). Wall-clock-safe — it never
          // imports or materializes; the client does that on next open.
          await syncCloudSource(job.id, job.userId, db, null, { force: false, rawOnly: true });
          await schedule(job.id, Date.now() + CADENCE_MS, { attempts: 0 });
        } catch (_) {
          const attempts = (Number(job.state.attempts) || 0) + 1;
          const backoff = Math.min(CADENCE_MS, 5 * 60 * 1000 * Math.pow(2, Math.min(attempts, 6)));
          await schedule(job.id, Date.now() + backoff, { attempts, backoffUntil: new Date(Date.now() + backoff).toISOString() });
        }
      }
    })());
  }

  return { ok: true, due: (due ?? []).length, locked: toSync.length, skipped, notEntitled };
}

// Watchdog for the resumable discovery chain. An isolate can occasionally be
// recycled mid-step without erroring or self-invoking (e.g. killed during a
// backoff), leaving a source "syncing" with an active discover cursor and a stale
// heartbeat. This re-kicks those so a big import always finishes — even app-closed.
async function cronResumeStuck(db: SupabaseClient) {
  const staleIso = new Date(Date.now() - 120_000).toISOString();
  const { data, error } = await db
    .from("cloud_sources")
    .select("id,user_id,config_hint")
    .eq("sync_status", "syncing")
    .eq("source_type", "xtream")
    .limit(100);
  if (error) return { ok: false, error: error.message };
  const resumed: string[] = [];
  const finalizingStages = new Set(["materializing", "building_titles", "building_live_channels", "building_live_variants", "finalizing"]);
  for (const src of (data ?? [])) {
    const hint = recordOrEmpty(src.config_hint);
    const cursor = recordOrEmpty(hint.syncCursor);
    const progress = recordOrEmpty(hint.syncProgress);
    const inDiscovery = cursor.active === true && stringOr(cursor.phase, "") === "discover";
    const inFinalize = !inDiscovery && finalizingStages.has(stringOr(progress.stage, ""));
    if (!inDiscovery && !inFinalize) continue;
    // Recent activity (heartbeat / startedAt for discovery, progress updatedAt for
    // finalize) → still alive; only re-kick a genuinely stalled run.
    const lastSeen = inDiscovery
      ? (stringOr(cursor.heartbeatAt, "") || stringOr(cursor.startedAt, ""))
      : stringOr(progress.updatedAt, "");
    if (lastSeen && lastSeen > staleIso) continue;
    if (inDiscovery) runInBackground(driveXtreamSyncToReady(String(src.id), String(src.user_id), db));
    else runInBackground(driveFinalizeToReady(db, String(src.id), String(src.user_id), null));
    resumed.push(String(src.id));
    if (resumed.length >= 5) break;
  }
  return { ok: true, scanned: (data ?? []).length, resumed };
}

// Service-authed entry point to finish a source's materialization without a user
// session. Looks up the owning user and drives the resumable finalize phases in
// the background, returning immediately.
async function cronFinalizeSource(db: SupabaseClient, sourceId: string, country: string | null) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("id,user_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!source) return { ok: false, error: "source not found" };
  runInBackground(driveFinalizeToReady(db, sourceId, String(source.user_id), country));
  return { ok: true, started: true, sourceId };
}

// Walk the resumable finalize phases (live → titles → complete) to completion.
// Bounded by a wall-clock budget; the {phase, offset} cursor is persisted so a
// fresh isolate resumes where the last left off, and the driver self-invokes the
// next isolate at the budget — a huge catalogue (~200 batches) finishes
// hands-off, app-closed, without the client's ~160-call ceiling.
async function driveFinalizeToReady(db: SupabaseClient, sourceId: string, userId: string, country: string | null) {
  const deadline = Date.now() + 90_000;
  const { data: src0 } = await db.from("cloud_sources").select("config_hint,sync_status").eq("id", sourceId).maybeSingle();
  if (src0 && String(src0.sync_status) === "ready") return; // already done
  const fc = recordOrEmpty(recordOrEmpty(src0?.config_hint).finalizeCursor);
  let phase = stringOr(fc.phase, "live");
  let offset = Number(fc.offset) || 0;
  let afterId = stringOr(fc.afterId, "");
  let guard = 0;
  while (Date.now() < deadline && guard++ < 400) {
    let result: JsonRecord;
    try {
      // Smaller titles batch: the per-batch cloud_titles/title_variant upserts must finish
      // inside the authenticator's 8s statement_timeout even under concurrent read load AND
      // a re-walk that re-fires the keep-best / mirror triggers on already-built rows. The
      // upsert of 500 rows measured ~6.4s under load — too close to the ceiling — so 300
      // buys headroom; the cost is just more (cheap) self-invocations.
      const batchLimit = phase === "titles" ? 300 : 1500;
      result = await finalizeCloudSource(sourceId, userId, db, { country, phase, offset, afterId, limit: batchLimit }) as unknown as JsonRecord;
    } catch (e) {
      // Transient contention/compute spike → continue in a fresh isolate; a real
      // error (e.g. 422 no items) surfaces and stops the chain. A statement timeout
      // surfaces as a PLAIN Error (not HttpError), so match the message regardless of
      // type — otherwise a timed-out batch wrongly stops the whole finalize.
      const msg = e instanceof HttpError ? `${e.message} ${JSON.stringify(e.details ?? "")}` : String(e);
      const transient = (e instanceof HttpError && e.status === 503)
        || /resource|timeout|compute|deadlock|lock|statement|canceling|57014/i.test(msg);
      console.error("[cron] finalize batch failed", sourceId, transient ? "(transient)" : "", e);
      if (transient) await selfInvokeFinalize(sourceId, country);
      return;
    }
    if (String(result.status) === "ready") {
      await patchSourceConfigHint(db, sourceId, (hint) => { delete hint.finalizeCursor; return hint; });
      return;
    }
    phase = stringOr(result.nextPhase, "complete");
    offset = Number(result.nextOffset) || 0;
    afterId = stringOr(result.nextAfterId, afterId);
    await patchSourceConfigHint(db, sourceId, (hint) => { hint.finalizeCursor = { phase, offset, afterId }; return hint; });
  }
  // Budget/guard hit before ready → continue in a fresh isolate.
  await selfInvokeFinalize(sourceId, country);
}

// Read-merge-write a single config_hint mutation (preserves concurrent writers'
// fields like syncProgress).
async function patchSourceConfigHint(db: SupabaseClient, sourceId: string, mutate: (hint: JsonRecord) => JsonRecord) {
  const { data } = await db.from("cloud_sources").select("config_hint").eq("id", sourceId).maybeSingle();
  const hint = mutate(recordOrEmpty(data?.config_hint));
  await db.from("cloud_sources").update({ config_hint: compactRecord(hint) }).eq("id", sourceId);
}

// Kick a fresh finalize isolate (resumes from the persisted finalize cursor).
async function selfInvokeFinalize(sourceId: string, country: string | null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const q = country ? `?country=${encodeURIComponent(country)}` : "";
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/norva-source-sync/cron/finalize/${encodeURIComponent(sourceId)}${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[norva-source-sync] self-invoke finalize failed", sourceId, error);
  }
}

type FinalizeCloudSourceOptions = {
  country: string | null;
  phase: string;
  offset: number;
  afterId?: string;
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
  const batchAfterId = stringOr(options.afterId, "");
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

    if (phase === "live" || phase === "live_channels" || phase === "live_variants") {
      const totalVod = counts.movies + counts.series;
      if (counts.live <= 0) {
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, ...result,
          liveCatalog: { rawLive: 0, logicalChannels: 0, liveVariants: 0, skipped: true },
        };
      }
      // Materialise the live catalogue in bounded chunks: a 50k+ channel list
      // can't be loaded + name-parsed whole in one isolate (it exceeds the edge
      // compute limit). Walk live rows by offset, clearing once at the start;
      // channels/variants merge across chunks by their logical/stream keys.
      const LIVE_CHUNK = 4000;
      if (batchOffset === 0) await clearLiveMaterialization(db, sourceId, userId);
      const liveChunk = await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"], offset: batchOffset, limit: LIVE_CHUNK });
      if (!liveChunk.length) {
        await reportProgress({ stage: "building_titles", percent: 86, steps: { finalize: { status: "running" } } });
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, ...result,
          liveCatalog: { rawLive: counts.live, done: true },
        };
      }
      const mat = await materializeLiveChunk(db, {
        sourceId, userId, rows: liveChunk,
        country: options.country || stringOr(config.country, "FR"),
      });
      const nextOffset = batchOffset + liveChunk.length;
      await reportProgress({
        stage: "building_live_channels",
        percent: Math.max(76, Math.min(85, 76 + Math.round((9 * nextOffset) / Math.max(1, counts.live)))),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId, status: "syncing", phase: "live",
        nextPhase: "live", nextOffset, limit: LIVE_CHUNK, totalVod, ...result,
        liveCatalog: { ...mat, rawLive: counts.live, offset: nextOffset },
      };
    }

    if (phase === "titles") {
      const totalVod = counts.movies + counts.series;
      const rows = await loadSourceItems(sourceId, userId, db, {
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
        // Onboarding B: keep inline enrichment small so the user is released fast; the
        // scheduled enrichment crons + the cross-user reuse + the header bar fill the rest.
        // Defer TMDB validation to the background crons — at huge-catalogue scale
        // it's hundreds of inline lookups; titles still appear from provider data.
        tmdbValidateLimit: boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_FINALIZE_LIMIT"), 0, 0, 1000),
      });
      const nextOffset = Math.min(totalVod, batchOffset + rows.length);
      const nextAfterId = rows.length ? String((rows[rows.length - 1] as { id?: unknown }).id ?? batchAfterId) : batchAfterId;
      // Keyset: batchLimit (500) is below PostgREST's 1000-row cap, so a short page is
      // genuinely the last one — done when the batch is empty or under the limit.
      const done = rows.length === 0 || rows.length < batchLimit;
      // Progress = walk position / total VOD. The keyset offset advances 1:1 with titles
      // built (each movie/series item projects one variant), so it IS "titles built / total".
      // Monotonicity is already guaranteed downstream — both mergeSyncProgress and the client
      // max-clamp the percent — so a resume/re-walk can never push the bar backward. (An
      // explicit built-count COUNT(*) here was the wrong tool: ~6s under concurrent upsert
      // load + autovacuum, which blew the 8s batch budget and froze the cursor.)
      await reportProgress({
        stage: done ? "finalizing" : "building_titles",
        percent: done ? 99 : titleFinalizePercent(nextOffset, totalVod),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "titles",
        nextPhase: done ? "complete" : "titles",
        nextOffset,
        nextAfterId,
        limit: batchLimit,
        totalVod,
        done,
        ...result,
        titleProjection,
      };
    }

    if (phase !== "complete") throw new HttpError(400, "Invalid catalog finalization phase");

    // Safety net: the client-driven "titles" phase can stop early and leave
    // verified titles without playable variants (vanishing from genre rails).
    // Deterministically materialise any missing variants before marking ready.
    try {
      await db.rpc("heal_cloud_title_variants", { p_user_id: userId, p_source_id: sourceId });
    } catch (healError) {
      console.warn("[norva-source-sync] variant heal failed:", healError instanceof Error ? healError.message : healError);
    }

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
    // A statement timeout / lock / resource spike is transient at scale — keep the
    // source in its syncing/finalizing state (do NOT flip to "error") so the driver's
    // self-invoke AND the resume-stuck watchdog both pick it up and continue from the
    // cursor. Only a genuine failure marks the source errored.
    const transient = (error instanceof HttpError && error.status === 503)
      || /resource|timeout|compute|deadlock|lock|statement|canceling|57014/i.test(message);
    if (!transient) {
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
  if (phase === "complete") return 99;
  return 74;
}

function liveFinalizePercent(phase: string, offset: number, total: number) {
  const ratio = total ? Math.max(0, Math.min(1, offset / total)) : 1;
  if (phase === "live_channels") return Math.max(76, Math.min(80, Math.round(76 + ratio * 4)));
  return Math.max(80, Math.min(86, Math.round(80 + ratio * 6)));
}

function titleFinalizePercent(built: number, totalVod: number) {
  if (!totalVod) return 99;
  const ratio = Math.max(0, Math.min(1, built / totalVod));
  // Wide band (86→99): on a huge catalogue the titles phase is by far the longest part
  // of the finalize (hundreds of thousands of items), so it gets the largest share of
  // the bar. A narrow band made the percent appear frozen for the whole phase. The
  // "complete" phase then lands it on 100 via completedSyncProgress.
  return Math.max(86, Math.min(99, Math.round(86 + ratio * 13)));
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
      countRowsByType(sourceId, userId, db, "live"),
      countRowsByType(sourceId, userId, db, "movie"),
      countRowsByType(sourceId, userId, db, "series"),
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
  afterId?: string;
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
  const maxRows = options.limit ? pageSize : Number.POSITIVE_INFINITY;
  // Keyset mode (WHERE id > afterId, ORDER BY id): constant-time regardless of
  // position — used by the titles finalize so it doesn't slow down as OFFSET would
  // scan+skip ever more rows on a huge catalogue. Offset mode kept for other callers.
  const keyset = typeof options.afterId === "string";
  let afterId = options.afterId || "";
  for (let offset = Math.max(0, options.offset ?? 0); rows.length < maxRows; offset += pageSize) {
    let query = db
      .from("cloud_media_items")
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("source_id", sourceId)
      .eq("user_id", userId);
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
    rows.push(...data as LiveCatalogItem[]);
    if (keyset) afterId = String((data[data.length - 1] as { id?: unknown }).id ?? "");
    if (data.length < pageSize) break;
    if (options.limit) break;
  }
  return Number.isFinite(maxRows) ? rows.slice(0, maxRows) : rows;
}

function catalogCountsFromRows(rows: LiveCatalogItem[]) {
  const categorySets = {
    live: new Set<string>(),
    movies: new Set<string>(),
    series: new Set<string>(),
  };
  let live = 0;
  let movies = 0;
  let series = 0;
  for (const row of rows) {
    const type = String(row.item_type || "");
    const category = stringOr(row.parent_external_id, "");
    if (type === "live") {
      live += 1;
      if (category) categorySets.live.add(category);
    } else if (type === "movie") {
      movies += 1;
      if (category) categorySets.movies.add(category);
    } else if (type === "series") {
      series += 1;
      if (category) categorySets.series.add(category);
    }
  }
  return {
    live,
    movies,
    series,
    total: live + movies + series,
    categories: {
      live: categorySets.live.size,
      movies: categorySets.movies.size,
      series: categorySets.series.size,
      total: categorySets.live.size + categorySets.movies.size + categorySets.series.size,
    },
  };
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

function freshSyncCursor(startedAt: string, extra: JsonRecord = {}): JsonRecord {
  return {
    v: 1,
    active: true,
    phase: "discover",
    deleted: false,
    typeIdx: 0,
    catIdx: 0,
    counts: { live: 0, movies: 0, series: 0 },
    sig: emptySig(),
    startedAt,
    attempts: 0,
    ...extra,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// Fast, synchronous, order-independent catalogue fingerprint that streams (so it
// works across isolates without holding every id). Per type we keep a count, the
// newest provider `added`, and a commutative XOR+sum of a cheap FNV-1a hash of
// each external id — additions/removals flip the combined hash and the count.
function fnv32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function emptySig(): JsonRecord {
  return {
    live: { count: 0, maxAdded: 0, xor: 0, add: 0 },
    movie: { count: 0, maxAdded: 0, xor: 0, add: 0 },
    series: { count: 0, maxAdded: 0, xor: 0, add: 0 },
  };
}

function updateSig(sig: JsonRecord, type: string, ext: string, added: number) {
  const bucket = recordOrEmpty(sig[type]);
  const h = fnv32(ext);
  bucket.count = (Number(bucket.count) || 0) + 1;
  bucket.xor = ((Number(bucket.xor) || 0) ^ h) >>> 0;
  bucket.add = ((Number(bucket.add) || 0) + h) >>> 0;
  if (Number.isFinite(added) && added > (Number(bucket.maxAdded) || 0)) bucket.maxAdded = added;
  sig[type] = bucket;
}

function finalizeSig(sig: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const type of ["live", "movie", "series"]) {
    const b = recordOrEmpty(sig[type]);
    const count = Number(b.count) || 0;
    if (!count) continue;
    out[type] = {
      count,
      maxAdded: Number(b.maxAdded) || 0,
      idsHash: `${((Number(b.xor) || 0) >>> 0).toString(16)}:${((Number(b.add) || 0) >>> 0).toString(16)}`,
    };
  }
  return out;
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

const IMPORT_BATCH_SIZE = 250;

// Statement timeout / deadlock / lock / resource errors are transient contention
// on a busy DB — worth retrying or handing to a fresh isolate; a schema error is not.
function isTransientDbError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "").toLowerCase();
  return /timeout|deadlock|could not serialize|lock|connection|temporar|resource/.test(msg);
}

// A few quick retries to ride out a brief spike — kept short so a slow batch never
// holds the isolate long enough to overrun its wall-clock mid-retry. On a
// persistent transient failure, throw a tagged 503 so the driver can checkpoint
// and continue in a fresh isolate (where the DB may have recovered).
async function withDbRetry(op: () => PromiseLike<{ error: unknown }>, label: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await op();
    if (!error) return;
    lastError = error;
    if (!isTransientDbError(error)) break;
    await new Promise((r) => setTimeout(r, Math.min(2500, Math.round(500 * Math.pow(1.8, attempt)))));
  }
  if (isTransientDbError(lastError)) {
    throw new HttpError(503, label, { transient: true, db: (lastError as { message?: string })?.message });
  }
  throwDb(lastError as { message?: string }, label);
}

// Incremental import: upsert a batch of rows (no delete, no select-back). The
// initial delete-all happens once per fresh sync; finalize reloads rows from the
// table, so we don't need the saved rows here — keeping peak memory tiny.
// Small batches keep each statement well under the edge connection's 8s budget;
// ignoreDuplicates (ON CONFLICT DO NOTHING) skips the row-lock + re-write of an
// already-present stream (a fresh sync deletes first, so these are inserts), which
// is far lighter on a busy DB than DO UPDATE.
async function appendSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient) {
  for (let index = 0; index < rows.length; index += IMPORT_BATCH_SIZE) {
    const chunk = rows.slice(index, index + IMPORT_BATCH_SIZE);
    if (!chunk.length) continue;
    await withDbRetry(
      () => db.from("cloud_media_items").upsert(chunk, { onConflict: "source_id,item_type,external_id", ignoreDuplicates: true }),
      "Unable to save cloud catalog items",
    );
  }
}

// Clear a source's items in bounded chunks so no single DELETE exceeds the edge
// connection's 8s statement budget (a big catalogue is 100k+ rows).
async function deleteSourceItems(sourceId: string, userId: string, db: SupabaseClient) {
  for (let guard = 0; guard < 2000; guard++) {
    const { data, error } = await db
      .from("cloud_media_items")
      .select("id")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .limit(2000);
    if (error) throwDb(error, "Unable to clear old catalog items");
    if (!data || !data.length) return;
    const ids = (data as { id: string }[]).map((r) => r.id);
    await withDbRetry(() => db.from("cloud_media_items").delete().in("id", ids), "Unable to clear old catalog items");
    if (data.length < 2000) return;
  }
}

// Fire the next isolate. The /cron/sync-step route kicks driveXtreamSyncToReady
// in the background and returns immediately, so this await resolves fast and the
// current (near-budget) isolate can exit cleanly.
async function selfInvokeSyncStep(sourceId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("[norva-source-sync] cannot self-invoke sync-step: missing URL/service key", sourceId);
    return;
  }
  const url = `${SUPABASE_URL}/functions/v1/norva-source-sync/cron/sync-step/${encodeURIComponent(sourceId)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[norva-source-sync] self-invoke sync-step failed", sourceId, error);
  }
}

// Detection-only (cron): stream the provider catalogue and compute its signature
// without importing anything. Memory-safe — only the running fingerprint is held.
async function detectXtreamChange(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  previousSignature: unknown,
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
  if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
  const fetchCatalog = (action: string, params?: Record<string, string>) =>
    fetchProviderMetadata(runtimeConfig, { serverUrl, username, password, action, params, timeoutMs: 25000 }).catch(() => []);
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    fetchCatalog("get_live_categories"),
    fetchCatalog("get_vod_categories"),
    fetchCatalog("get_series_categories"),
  ]);
  const maps: Record<string, Map<string, string>> = {
    live: categoryMap(liveCats),
    movie: categoryMap(vodCats),
    series: categoryMap(seriesCats),
  };
  const sig = emptySig();
  let liveCount = 0, movieCount = 0, seriesCount = 0;
  for (const def of DISCOVER_TYPES) {
    const ids = [...maps[def.type].keys()];
    const targets: (Record<string, string> | undefined)[] = ids.length ? ids.map((id) => ({ category_id: id })) : [undefined];
    for (let i = 0; i < targets.length; i += DISCOVER_CONCURRENCY) {
      const slices = await Promise.all(targets.slice(i, i + DISCOVER_CONCURRENCY).map((p) => fetchCatalog(def.action, p)));
      for (const slice of slices) {
        if (!Array.isArray(slice) || !slice.length) continue;
        for (const raw of slice) {
          if (!isRecord(raw)) continue;
          const ext = stringOr(raw.stream_id ?? raw.series_id ?? raw.id, "");
          if (!ext) continue;
          updateSig(sig, def.type, ext, Number(raw.added));
          if (def.type === "live") liveCount++;
          else if (def.type === "movie") movieCount++;
          else seriesCount++;
        }
      }
    }
  }
  const contentSignature = finalizeSig(sig);
  const changed = Boolean(previousSignature) && !contentSignatureEquals(contentSignature, previousSignature);
  return { live: liveCount, movies: movieCount, series: seriesCount, total: liveCount + movieCount + seriesCount, contentSignature, changed, detectOnly: true };
}

// Drive one isolate's worth of resumable discovery. Imports every category's
// stream slice incrementally from a persisted cursor (also accumulating the
// change-detection signature); when the wall-clock budget is hit before the
// catalogue is fully imported it checkpoints and self-invokes a fresh isolate.
// On completion it writes the new signature, records the "what's new" event and
// leaves the finalize-pending handoff state the client/cron stepper materializes.
async function driveXtreamSyncToReady(sourceId: string, userId: string, db: SupabaseClient) {
  const deadline = Date.now() + SYNC_DRIVE_BUDGET_MS;
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.error("[norva-source-sync] sync driver load failed", sourceId, error.message); return; }
  if (!source) return;
  if (String(source.sync_status) === "ready") return; // a stale continuation raced past completion

  const baseHint = recordOrEmpty(source.config_hint);
  let cursor = recordOrEmpty(baseHint.syncCursor);
  if (!isRecord(baseHint.syncCursor)) cursor = freshSyncCursor(new Date().toISOString());
  let progress = recordOrEmpty(baseHint.syncProgress);
  const previousSignature = cursor.previousSignature ?? baseHint.contentSignature;

  // Single-flight: a fresh sync (syncCloudSource) stamps a new startedAt. If this
  // isolate sees a different one it has been superseded — stop writing so two
  // generations don't fight over the cursor and the same rows (which deadlocks
  // and statement-times-out under load). Self-invoke continuations keep the same
  // startedAt, so the chain is unaffected.
  const myRun = stringOr(cursor.startedAt, "");
  let superseded = false;

  const persist = async (progressPatch: JsonRecord | null) => {
    if (progressPatch) {
      progress = mergeSyncProgress(progress, compactRecord({ ...progressPatch, status: "syncing", updatedAt: new Date().toISOString() }));
    }
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    if (stringOr(recordOrEmpty(freshHint.syncCursor).startedAt, myRun) !== myRun) { superseded = true; return; }
    cursor.heartbeatAt = new Date().toISOString();
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

    if (!isRecord(cursor.cats)) {
      cursor.cats = {
        live: [...nameMaps.live.keys()].sort(),
        movie: [...nameMaps.movie.keys()].sort(),
        series: [...nameMaps.series.keys()].sort(),
      };
      cursor.catCounts = { live: nameMaps.live.size, movies: nameMaps.movie.size, series: nameMaps.series.size };
    }
    const cats = recordOrEmpty(cursor.cats);
    if (!isRecord(cursor.sig)) cursor.sig = emptySig();
    const sig = recordOrEmpty(cursor.sig);

    if (!cursor.deleted) {
      await deleteSourceItems(sourceId, userId, db);
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
      if (superseded) return;
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
      // Collapse cross-category duplicates before counting/signing/upserting.
      const batchRows = dedupeByConflictKey(rawRows);
      for (const row of batchRows) {
        updateSig(sig, def.type, stringOr(row.external_id, ""), Number(recordOrEmpty(row.metadata).added));
      }
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
      cursor.sig = sig;
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
      if (superseded) return;
    }

    if (typeIdx < DISCOVER_TYPES.length) {
      await persist(null);
      if (superseded) return;
      await selfInvokeSyncStep(sourceId);
      return;
    }

    const total = liveCount + movieCount + seriesCount;
    if (total <= 0) throw new HttpError(422, "No playable catalog items were imported from this source");
    const catCounts = recordOrEmpty(cursor.catCounts);
    const liveCats2 = Number(catCounts.live) || 0;
    const movieCats2 = Number(catCounts.movies) || 0;
    const seriesCats2 = Number(catCounts.series) || 0;
    const catTotal = liveCats2 + movieCats2 + seriesCats2;
    const contentSignature = finalizeSig(sig);
    cursor.active = false;
    cursor.phase = "imported";

    // Final config_hint write: persist the new signature + handoff progress.
    progress = mergeSyncProgress(progress, compactRecord({
      status: "syncing",
      stage: "materializing",
      percent: 74,
      updatedAt: new Date().toISOString(),
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
    }));
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    if (stringOr(recordOrEmpty(freshHint.syncCursor).startedAt, myRun) !== myRun) return; // superseded by a newer sync
    await db
      .from("cloud_sources")
      .update({
        config_hint: compactRecord({ ...freshHint, contentSignature, syncProgress: progress, syncCursor: cursor }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);

    // "What's new" feed: record a capped event when the catalogue grew.
    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, {
      contentSignature,
      live: liveCount,
      movies: movieCount,
      series: seriesCount,
      total,
    });
    // Discovery done → kick the self-continuing finalize driver so a huge
    // catalogue materialises to "ready" hands-off (the client's ~160-call loop
    // can't finish one); idempotent with the client poll if the app is open.
    await selfInvokeFinalize(sourceId, stringOrNull(cursor.country));
  } catch (err) {
    // Transient DB contention (timeout/lock/resource): don't fail the sync — the
    // cursor is checkpointed, so hand off to a fresh isolate where the DB may have
    // recovered. Bounded by the continuation cap so a real outage still surfaces.
    const transient = err instanceof HttpError && err.status === 503;
    if (transient && Number(cursor.attempts) < SYNC_MAX_CONTINUATIONS) {
      console.warn("[norva-source-sync] transient sync error — continuing in a fresh isolate", sourceId);
      try { await persist(null); } catch (_) { /* ignore — the cursor's last checkpoint stands */ }
      await selfInvokeSyncStep(sourceId);
      return;
    }
    const message = err instanceof Error ? err.message : "Source sync failed";
    console.error("[norva-source-sync] sync driver failed", sourceId, message);
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

// Cheap change-detection fingerprint of a freshly-fetched catalogue. Per item
// type we keep the count, the newest provider `added` timestamp, and a hash of
// the sorted external ids — so additions/removals flip the hash and the count.
// A sync whose signature matches the last completed one can skip the heavy
// delete+rebuild+projection entirely (the existing data is already correct).
async function computeContentSignature(rows: JsonRecord[]): Promise<JsonRecord> {
  const byType = new Map<string, { count: number; maxAdded: number; ids: string[] }>();
  for (const row of rows) {
    const type = stringOr(row.item_type, "");
    const ext = stringOr(row.external_id, "");
    if (!type || !ext) continue;
    let bucket = byType.get(type);
    if (!bucket) { bucket = { count: 0, maxAdded: 0, ids: [] }; byType.set(type, bucket); }
    bucket.count += 1;
    bucket.ids.push(ext);
    const meta = isRecord(row.metadata) ? row.metadata : {};
    const added = Number(meta.added);
    if (Number.isFinite(added) && added > bucket.maxAdded) bucket.maxAdded = added;
  }
  const signature: JsonRecord = {};
  for (const [type, bucket] of byType) {
    bucket.ids.sort();
    signature[type] = {
      count: bucket.count,
      maxAdded: bucket.maxAdded,
      idsHash: await sha256Hex(bucket.ids.join(",")),
    };
  }
  return signature;
}

// Two signatures are "the same catalogue" when every type matches on count +
// id-set hash. maxAdded is informational only (some providers jitter it), so it
// is deliberately excluded from the equality to avoid false "changed" results.
// Plain-language "what's new" summary from two signatures: the net per-type
// count increase since the last sync. Net-positive only (a churned catalogue
// that adds + removes equal amounts reads as "nothing new", which is the right
// conservative behaviour for a notification). Drives the free in-app feed.
function summarizeContentDelta(prev: unknown, next: unknown): { total: number; byType: JsonRecord; summary: string } {
  const labels: Record<string, string> = { movie: "movies", series: "shows", live: "channels" };
  const byType: JsonRecord = {};
  const parts: string[] = [];
  let total = 0;
  for (const type of ["movie", "series", "live"]) {
    const oldCount = isRecord(prev) && isRecord(prev[type]) ? Number(prev[type].count) || 0 : 0;
    const newCount = isRecord(next) && isRecord(next[type]) ? Number(next[type].count) || 0 : 0;
    const delta = newCount - oldCount;
    if (delta > 0) {
      byType[type] = delta;
      total += delta;
      parts.push(`${delta} new ${labels[type]}`);
    }
  }
  return { total, byType, summary: parts.join(" · ") };
}

// Record a one-per-source-per-day "what's new" event when a sync actually
// changed the catalogue. Best-effort and rate-capped; never blocks the sync.
async function maybeRecordContentEvent(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  previousSignature: unknown,
  result: JsonRecord,
) {
  try {
    if (!previousSignature || result.skipped) return; // first import / no change
    const delta = summarizeContentDelta(previousSignature, result.contentSignature);
    if (delta.total <= 0) return;
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await db
      .from("cloud_content_events")
      .select("id")
      .eq("user_id", userId)
      .eq("source_id", sourceId)
      .gt("created_at", since)
      .limit(1);
    if (recent && recent.length) return; // already notified today (free 1/day cap)
    await db.from("cloud_content_events").insert({
      user_id: userId,
      source_id: sourceId,
      kind: "new_content",
      summary: delta.summary,
      payload: { byType: delta.byType, total: delta.total },
    });
  } catch (_) {
    // observability feature — never let it break a sync
  }
}

function contentSignatureEquals(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return false;
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (!isRecord(av) || !isRecord(bv)) return false;
    if (Number(av.count) !== Number(bv.count)) return false;
    if (stringOr(av.idsHash, "") !== stringOr(bv.idsHash, "")) return false;
  }
  return true;
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
  country: string | null = null,
  reportProgress: SyncProgressReporter = async () => {},
  opts: { previousSignature?: unknown; force?: boolean; rawOnly?: boolean } = {},
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

  // Change-detection (same as Xtream): skip the rebuild when the playlist's
  // channel set is unchanged since the last completed import.
  const contentSignature = await computeContentSignature(rows);

  if (opts.rawOnly) {
    // Detection-only (cron) path — see the matching note in syncXtreamSource.
    const changed = Boolean(opts.previousSignature) && !contentSignatureEquals(contentSignature, opts.previousSignature);
    return { live: rows.length, total: rows.length, contentSignature, changed, detectOnly: true };
  }

  if (!opts.force && opts.previousSignature && contentSignatureEquals(contentSignature, opts.previousSignature)) {
    await reportProgress({
      stage: "unchanged",
      percent: 100,
      counts: { live: rows.length, movies: 0, series: 0, total: rows.length },
      steps: { import: { status: "done", count: rows.length }, finalize: { status: "done" } },
    });
    return { live: rows.length, total: rows.length, contentSignature, skipped: true };
  }

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
  const liveCatalog = await refreshMaterializedLiveCatalog(db, { sourceId, userId, rows: savedRows, country: country || stringOr(config.country, "FR") });
  return { live: rows.length, total: rows.length, liveCatalog, contentSignature };
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
    if (error) throwDb(error, "Unable to save cloud catalog items");
    if (Array.isArray(data)) savedRows.push(...data as LiveCatalogItem[]);
  }
  return savedRows;
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  let mediaGatewayUrl = ENV_MEDIA_GATEWAY_URL;
  let mediaGatewayToken = ENV_MEDIA_GATEWAY_TOKEN;
  if (!sourceConfigKey || !mediaGatewayUrl || !mediaGatewayToken) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", ["NORVA_SOURCE_CONFIG_KEY", "NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"]);
    if (error) console.warn("[norva-source-sync] runtime config unavailable", error.message);
    for (const item of data ?? []) {
      if (typeof item.value !== "string" || !item.value) continue;
      if (item.key === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = item.value;
      else if (item.key === "NORVA_MEDIA_GATEWAY_URL" && !mediaGatewayUrl) mediaGatewayUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !mediaGatewayToken) mediaGatewayToken = item.value;
    }
  }
  const value = { sourceConfigKey, mediaGatewayUrl, mediaGatewayToken };
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
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function fetchJson(url: string, timeoutMs: number) {
  const response = await fetchWithTimeout(url, timeoutMs);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed", payload);
  return payload;
}

// Fetch Xtream catalogue/VOD metadata, preferring the media gateway so the crawl
// reaches the provider from the SAME tolerated IP as streaming. A direct fetch
// from this Supabase edge runtime egresses a provider-BLOCKED datacenter IP —
// both a user_multi_ip trigger and, for blocked ranges, an outright sync failure
// (empty catalogue). Falls back to a direct fetch only on gateway-side problems
// (missing route / unreachable / timeout), never on provider-origin errors.
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
      console.warn("[norva-source-sync] gateway metadata unavailable, falling back to direct", args.action, status);
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

async function fetchText(url: string, timeoutMs: number, maxBytes: number) {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
  const text = await response.text();
  if (text.length > maxBytes) throw new HttpError(413, "Playlist is too large for this cloud import");
  return text;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "NorvaCloud/1.0" },
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
  const match = value.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1]?.trim() ?? "";
}

function xtreamApiUrl(config: {
  serverUrl: string;
  username: string;
  password: string;
  action?: string;
}, params: Record<string, string> = {}) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (config.action) url.searchParams.set("action", config.action);
  // Forward request params (e.g. category_id) so the direct fallback fetches the
  // same per-category slice the gateway does — never the full, OOM-prone list.
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
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

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (parts[0] === "norva-source-sync") parts.shift();
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

function compactRecord(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
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

function stringOrNull(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
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

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
