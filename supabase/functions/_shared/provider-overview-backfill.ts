import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

type ProviderOverviewCandidate = {
  external_id?: unknown;
  cached_overview?: unknown;
  cached_status?: unknown;
};

type ProviderOverviewFetch = (externalId: string) => Promise<unknown>;

type ProviderOverviewBackfillOptions = {
  db: SupabaseClient;
  userId: string;
  sourceId: string;
  fetchVodInfo: ProviderOverviewFetch;
  limit?: number;
  concurrency?: number;
};

const EMPTY_PROVIDER_TEXT =
  /^(?:n\/?a|none|null|undefined|no (?:description|overview|plot)(?: available)?|no summary available yet\.?)$/i;

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function boundedProviderText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringOrNull(value);
    if (!text || EMPTY_PROVIDER_TEXT.test(text)) continue;
    return text.slice(0, 4000);
  }
  return null;
}

/**
 * Xtream panels do not agree on the get_vod_info shape. Keep the parser pure
 * and deliberately narrow: only known synopsis fields are accepted, never a
 * title/category/error string that could be displayed as a synopsis.
 */
export function extractProviderOverview(payload: unknown): string | null {
  const root = recordOrEmpty(payload);
  const info = recordOrEmpty(root.info);
  const movie = recordOrEmpty(root.movie_data ?? root.movieData);
  return boundedProviderText(
    info.plot,
    info.description,
    info.overview,
    info.desc,
    movie.plot,
    movie.description,
    movie.overview,
    movie.desc,
    root.plot,
    root.description,
    root.overview,
    root.desc,
  );
}

function cleanProviderId(value: unknown, kind: "tmdb" | "imdb"): string | null {
  const text = stringOrNull(value);
  if (!text || /^(?:0|null|undefined|n\/?a)$/i.test(text)) return null;
  if (kind === "tmdb") {
    const digits = text.match(/\d+/)?.[0] ?? "";
    return digits && !/^0+$/.test(digits) ? digits : null;
  }
  const imdb = text.match(/tt\d+/i)?.[0] ?? "";
  return imdb ? imdb.toLowerCase() : null;
}

export function extractProviderOverviewIds(payload: unknown) {
  const root = recordOrEmpty(payload);
  const info = recordOrEmpty(root.info);
  const movie = recordOrEmpty(root.movie_data ?? root.movieData);
  return {
    tmdbId: cleanProviderId(
      info.tmdb_id ?? info.tmdbId ?? info.tmdb ??
        movie.tmdb_id ?? movie.tmdbId ?? movie.tmdb ??
        root.tmdb_id ?? root.tmdbId ?? root.tmdb,
      "tmdb",
    ),
    imdbId: cleanProviderId(
      info.imdb_id ?? info.imdbId ?? info.imdb ??
        movie.imdb_id ?? movie.imdbId ?? movie.imdb ??
        root.imdb_id ?? root.imdbId ?? root.imdb,
      "imdb",
    ),
  };
}

function isoAfter(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function errorStatus(error: unknown): number {
  const status = Number(recordOrEmpty(error).status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

async function recordProviderOverview(
  db: SupabaseClient,
  input: {
    userId: string;
    sourceId: string;
    externalId: string;
    overview: string | null;
    tmdbId: string | null;
    imdbId: string | null;
    outcome: "resolved" | "missing" | "retry";
    retryAt: string | null;
    provenance: JsonRecord;
  },
) {
  const { data, error } = await db.rpc("record_provider_overview_outcome", {
    p_user_id: input.userId,
    p_source_id: input.sourceId,
    p_external_id: input.externalId,
    p_provider_overview: input.overview,
    p_provider_tmdb_id: input.tmdbId,
    p_provider_imdb_id: input.imdbId,
    p_outcome: input.outcome,
    p_retry_at: input.retryAt,
    p_provenance: input.provenance,
  });
  if (error) throw new Error(`record_provider_overview_outcome failed: ${error.message}`);
  return recordOrEmpty(data);
}

/**
 * One resumable, provider-friendly get_vod_info batch.
 *
 * The database owns eligibility and retry timestamps. This worker never keeps
 * an in-memory/global cursor, so a killed Edge isolate simply retries the
 * unstamped row. The source fleet's provider lease prevents two users sharing
 * one canonical panel from opening overlapping metadata crawls.
 */
export async function backfillProviderOverviews(options: ProviderOverviewBackfillOptions) {
  const limit = Math.max(1, Math.min(8, Number(options.limit) || 4));
  const concurrency = Math.max(1, Math.min(2, Number(options.concurrency) || 2));
  const { data, error } = await options.db.rpc("claim_provider_overview_candidates", {
    p_user_id: options.userId,
    p_source_id: options.sourceId,
    p_limit: limit,
  });
  if (error) throw new Error(`claim_provider_overview_candidates failed: ${error.message}`);

  const candidates = (Array.isArray(data) ? data : []) as ProviderOverviewCandidate[];
  if (!candidates.length) {
    return {
      mode: "provider-overview",
      processed: 0,
      updated: 0,
      resolved: 0,
      cached: 0,
      missing: 0,
      retried: 0,
      hasMore: false,
      exhausted: true,
    };
  }

  let cursor = 0;
  let processed = 0;
  let updated = 0;
  let resolved = 0;
  let cached = 0;
  let missing = 0;
  let retried = 0;
  let lastId: string | null = null;
  let paused = false;
  let stoppedAt: string | null = null;

  const worker = async () => {
    while (!paused) {
      const candidate = candidates[cursor++];
      if (!candidate) return;
      const externalId = stringOrNull(candidate.external_id);
      if (!externalId) continue;

      const cachedOverview = boundedProviderText(candidate.cached_overview);
      if (cachedOverview && stringOrNull(candidate.cached_status) === "resolved") {
        const result = await recordProviderOverview(options.db, {
          userId: options.userId,
          sourceId: options.sourceId,
          externalId,
          overview: cachedOverview,
          tmdbId: null,
          imdbId: null,
          outcome: "resolved",
          retryAt: null,
          provenance: { kind: "canonical-provider-cache", schemaVersion: 1 },
        });
        processed += 1;
        cached += 1;
        resolved += 1;
        updated += Math.max(0, Number(result.titles_updated) || 0);
        lastId = externalId;
        continue;
      }

      let payload: unknown;
      try {
        payload = await options.fetchVodInfo(externalId);
      } catch (fetchError) {
        const status = errorStatus(fetchError);
        const providerWide = status === 401 || status === 403 || status === 429;
        const retryMs = status === 401 || status === 403
          ? 6 * 60 * 60 * 1000
          : status === 429
          ? 60 * 60 * 1000
          : 30 * 60 * 1000;
        await recordProviderOverview(options.db, {
          userId: options.userId,
          sourceId: options.sourceId,
          externalId,
          overview: null,
          tmdbId: null,
          imdbId: null,
          outcome: "retry",
          retryAt: isoAfter(retryMs),
          provenance: {
            kind: "xtream-get-vod-info",
            schemaVersion: 1,
            httpStatus: status || undefined,
            transient: true,
          },
        });
        processed += 1;
        retried += 1;
        lastId = externalId;
        if (providerWide) {
          // Stop after at most the already-running second request. Continuing a
          // batch after an auth/rate-limit response would be hostile to the panel.
          paused = true;
          stoppedAt = status === 429 ? "provider-rate-limit" : "provider-auth";
        }
        continue;
      }

      const overview = extractProviderOverview(payload);
      const ids = extractProviderOverviewIds(payload);
      const outcome = overview ? "resolved" : "missing";
      const result = await recordProviderOverview(options.db, {
        userId: options.userId,
        sourceId: options.sourceId,
        externalId,
        overview,
        tmdbId: ids.tmdbId,
        imdbId: ids.imdbId,
        outcome,
        // A real response with no synopsis is not a transient failure. Recheck
        // quarterly because providers can enrich old rows later.
        retryAt: overview ? null : isoAfter(90 * 24 * 60 * 60 * 1000),
        provenance: {
          kind: "xtream-get-vod-info",
          schemaVersion: 1,
          hasOverview: Boolean(overview),
          hasTmdbId: Boolean(ids.tmdbId),
          hasImdbId: Boolean(ids.imdbId),
        },
      });
      processed += 1;
      updated += Math.max(0, Number(result.titles_updated) || 0);
      lastId = externalId;
      if (overview) resolved += 1;
      else missing += 1;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );

  return {
    mode: "provider-overview",
    processed,
    updated,
    resolved,
    cached,
    missing,
    retried,
    lastId,
    paused,
    skipped: stoppedAt,
    hasMore: paused || candidates.length >= limit,
    exhausted: !paused && candidates.length < limit,
  };
}
