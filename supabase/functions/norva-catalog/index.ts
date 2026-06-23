import { createClient } from "npm:@supabase/supabase-js@2";
import { buildLiveCatalog, findLiveChannel, type LiveCatalogItem } from "../_shared/live-catalog.ts";
import { BUCKET_ORDER, bucketLabel, classifyTitleBuckets } from "../_shared/genre-taxonomy.ts";

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
  "https://norva-eight.vercel.app",
  "https://norva-pgkk.vercel.app",
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

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);

    if (req.method === "GET" && segments[0] === "health") {
      return json(req, { ok: true, service: "norva-catalog", version: 5, liveContract: "norva.live.logical.v1", materializedLive: true });
    }

    if (req.method === "GET" && isLiveLogicalChannelsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, await listLiveLogicalChannels(url, userId));
    }

    if (req.method === "GET" && isLiveChannelVariantsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, await listLiveChannelVariants(url, userId, liveChannelIdFromRoute(segments)));
    }

    if (req.method === "GET" && isHomeRailsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, await listHomeRails(url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-items" || (segments[0] === "device" && segments[1] === "media-items"))) {
      const userId = await requireUserId(req);
      return json(req, await listMediaItems(url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-categories" || (segments[0] === "device" && segments[1] === "media-categories"))) {
      const userId = await requireUserId(req);
      return json(req, await listMediaCategories(url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-genre-rails" || (segments[0] === "device" && segments[1] === "media-genre-rails"))) {
      const userId = await requireUserId(req);
      return json(req, await listGenreRails(req, url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-genre-items" || (segments[0] === "device" && segments[1] === "media-genre-items"))) {
      const userId = await requireUserId(req);
      return json(req, await listGenreItems(req, url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-genre-summary" || (segments[0] === "device" && segments[1] === "media-genre-summary"))) {
      const userId = await requireUserId(req);
      return json(req, await listGenreSummary(req, url, userId));
    }

    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-catalog]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function requireUserId(req: Request) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Missing bearer token");

  if (token.startsWith("nv_dev_")) {
    return requireDeviceUserId(token);
  }

  const { data, error } = await db.auth.getUser(token);
  if (!error && data.user?.id) return data.user.id;

  return requireDeviceUserId(token);
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

async function listMediaItems(url: URL, userId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");
  const search = url.searchParams.get("q");
  const categoryId = url.searchParams.get("categoryId");
  const limit = boundedInt(url.searchParams.get("limit"), 1000, 1, 1000);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);

  let query = db
    .from("cloud_media_items")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("title", { ascending: true })
    .order("external_id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (sourceId) query = query.eq("source_id", sourceId);
  if (itemType) query = query.eq("item_type", itemType);
  if (categoryId) query = query.eq("parent_external_id", categoryId);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data, count, error } = await query;
  if (error) throwDb(error, "Unable to list media items");

  return {
    items: data ?? [],
    count: count ?? null,
    limit,
    offset,
    hasMore: typeof count === "number" ? offset + limit < count : (data?.length ?? 0) === limit,
  };
}

async function listMediaCategories(url: URL, userId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const itemType = url.searchParams.get("type");

  let query = db
    .from("cloud_media_items")
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

async function listHomeRails(url: URL, userId: string) {
  const limit = boundedInt(url.searchParams.get("limit"), 24, 1, 50);
  const type = url.searchParams.get("type");
  const includeSeries = !type || type === "series";
  const includeMovies = !type || type === "movie";
  const rails: JsonRecord[] = [];

  if (includeMovies) {
    rails.push(await listTitleRail(userId, "movie", "recently-added-movies", "Recently Added Movies", limit));
    rails.push(await listGenreRail(userId, "movie", "Action", "action-movies", "Films d'action", limit));
  }

  const watchedRail = await listBecauseYouWatchedRail(userId, { includeMovies, includeSeries, limit });
  if (watchedRail) {
    rails.push(watchedRail);
  } else if (includeMovies) {
    rails.push(await listPopularTitleRail(userId, "movie", "popular-movies", "Films populaires", limit));
  }

  if (includeSeries) {
    rails.push(await listPopularTitleRail(userId, "series", "popular-series", "Series populaires", limit));
    rails.push(await listTitleRail(userId, "series", "recently-added-series", "Recently Added Series", limit));
  }

  return {
    contract: "norva.home.rails.v1",
    rails: rails.filter((rail) => Array.isArray(rail.items) && rail.items.length > 0),
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

  // Aggregate in SQL: distinct (categoryName, tmdb genres) combos + counts.
  // Returns ~a few thousand grouped rows instead of tens of thousands of full
  // rows, which overran the function ("Unable to load genres"). The curated
  // bucket mapping stays in TS, multiplying each combo by its count.
  let rows: Array<{ category_name?: unknown; genres?: unknown; n?: unknown }>;
  try {
    const rpcArgs: Record<string, unknown> = { p_user_id: userId, p_item_type: itemType };
    if (sourceId) rpcArgs.p_source_id = sourceId;
    const { data, error } = await db.rpc("cloud_genre_summary", rpcArgs);
    if (error) {
      if (isMissingMaterialization(error)) return { type: itemType, genres: [], hidden: [] };
      throwDb(error, "Unable to summarise genres");
    }
    rows = (data ?? []) as Array<{ category_name?: unknown; genres?: unknown; n?: unknown }>;
  } catch (error) {
    if (isMissingMaterialization(error)) return { type: itemType, genres: [], hidden: [] };
    throw error;
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.n) || 0;
    if (!n) continue;
    for (const bucketId of classifyTitleBuckets(row.category_name, row.genres)) {
      if (bucketId === "autres") continue;
      counts.set(bucketId, (counts.get(bucketId) ?? 0) + n);
    }
  }

  const hidden = await getHiddenGenres(req, userId);
  const genres = BUCKET_ORDER
    .filter((bucketId) => bucketId !== "autres" && (counts.get(bucketId) ?? 0) > 0)
    .map((bucketId) => ({
      bucket: bucketId,
      label: bucketLabel(bucketId),
      count: counts.get(bucketId) ?? 0,
      hidden: hidden.has(bucketId),
    }));

  return { type: itemType, source: sourceId, genres, hidden: [...hidden] };
}

async function listGenreRails(req: Request, url: URL, userId: string) {
  const itemType = url.searchParams.get("type") === "series" ? "series" : "movie";
  const perRail = boundedInt(url.searchParams.get("limit"), 18, 1, 50);
  const candidateLimit = boundedInt(url.searchParams.get("candidates"), 2000, 100, 5000);

  let titles: JsonRecord[];
  try {
    const { data, error } = await db
      .from("cloud_titles")
      .select("*")
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .gt("variant_count", 0)
      .order("synced_at", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(candidateLimit);
    if (error) {
      if (isMissingMaterialization(error)) return { contract: "norva.genre.rails.v1", type: itemType, rails: [] };
      throwDb(error, "Unable to list genre rail candidates");
    }
    titles = (data ?? []) as JsonRecord[];
  } catch (error) {
    if (isMissingMaterialization(error)) return { contract: "norva.genre.rails.v1", type: itemType, rails: [] };
    throw error;
  }

  // Per-profile hidden genres: a title with ANY hidden bucket is dropped from
  // the whole catalog (so e.g. a Kids profile sees no Horror anywhere).
  const hidden = await getHiddenGenres(req, userId);

  // Bucket -> titles (multi-membership), capped per rail, recency preserved.
  const byBucket = new Map<string, JsonRecord[]>();
  for (const title of titles) {
    const categoryName = recordOrEmpty(title.metadata).categoryName;
    const buckets = classifyTitleBuckets(categoryName, titleGenres(title));
    if (buckets.some((b) => hidden.has(b))) continue;
    for (const bucketId of buckets) {
      if (bucketId === "autres") continue; // never surface an "Autres" rail
      const list = byBucket.get(bucketId) ?? [];
      if (list.length < perRail) {
        list.push(title);
        byBucket.set(bucketId, list);
      }
    }
  }

  // One batched variant fetch for the union of selected titles.
  const selectedIds = new Set<string>();
  for (const list of byBucket.values()) {
    for (const title of list) selectedIds.add(String(title.id));
  }
  const variantsByTitle = await listVariantsByTitleIds([...selectedIds]);

  const rails = BUCKET_ORDER
    .filter((bucketId) => bucketId !== "autres" && (byBucket.get(bucketId)?.length ?? 0) > 0)
    .map((bucketId) => ({
      id: `genre-${bucketId}`,
      title: bucketLabel(bucketId),
      itemType,
      source: "titles",
      curation: { kind: "genre_bucket", bucket: bucketId },
      items: (byBucket.get(bucketId) ?? []).map((row) =>
        titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])
      ),
    }));

  return { contract: "norva.genre.rails.v1", type: itemType, rails };
}

// Full, paged list of one curated genre bucket (the rail's "Tout voir" / See
// all). Same shape as listMediaItems so the client grid consumes it unchanged.
async function listGenreItems(req: Request, url: URL, userId: string) {
  const itemType = url.searchParams.get("type") === "series" ? "series" : "movie";
  const bucket = (url.searchParams.get("bucket") || "").trim();
  const limit = boundedInt(url.searchParams.get("limit"), 36, 1, 100);
  const offset = boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const candidateLimit = boundedInt(url.searchParams.get("candidates"), 4000, 100, 8000);
  if (!bucket) throw new HttpError(400, "Missing bucket");

  const hidden = await getHiddenGenres(req, userId);
  // The bucket itself is hidden → nothing to show.
  if (hidden.has(bucket)) return { items: [], count: 0, limit, offset, hasMore: false };

  let titles: JsonRecord[];
  try {
    const { data, error } = await db
      .from("cloud_titles")
      .select("*")
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .gt("variant_count", 0)
      .order("synced_at", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(candidateLimit);
    if (error) {
      if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
      throwDb(error, "Unable to list genre items");
    }
    titles = (data ?? []) as JsonRecord[];
  } catch (error) {
    if (isMissingMaterialization(error)) return { items: [], count: 0, limit, offset, hasMore: false };
    throw error;
  }

  const matched = titles.filter((title) => {
    const buckets = classifyTitleBuckets(recordOrEmpty(title.metadata).categoryName, titleGenres(title));
    return buckets.includes(bucket) && !buckets.some((b) => hidden.has(b));
  });
  const pageRows = matched.slice(offset, offset + limit);
  const variantsByTitle = await listVariantsByTitleIds(pageRows.map((row) => String(row.id)));

  return {
    items: pageRows.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])),
    count: matched.length,
    limit,
    offset,
    hasMore: offset + limit < matched.length,
  };
}

async function listTitleRail(userId: string, itemType: "movie" | "series", id: string, title: string, limit: number) {
  try {
    const { data: titles, error } = await db
      .from("cloud_titles")
      .select("*")
      .eq("user_id", userId)
      .eq("item_type", itemType)
      .gt("variant_count", 0)
      .order("synced_at", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingMaterialization(error)) return listRawMediaRail(userId, itemType, id, title, limit);
      throwDb(error, "Unable to list title rail");
    }
    const variantsByTitle = await listVariantsByTitleIds((titles ?? []).map((row) => String(row.id)));
    return {
      id,
      title,
      itemType,
      source: "titles",
      items: (titles ?? []).map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])),
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return listRawMediaRail(userId, itemType, id, title, limit);
    throw error;
  }
}

async function listGenreRail(
  userId: string,
  itemType: "movie" | "series",
  genre: string,
  id: string,
  title: string,
  limit: number,
) {
  try {
    const candidates = await listVerifiedTitleCandidates(userId, itemType);
    const titles = candidates
      .filter((row) => titleGenres(row).some((value: string) => sameGenre(value, genre)))
      .sort((a, b) => String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? "")))
      .slice(0, limit);
    const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)));
    return {
      id,
      title,
      itemType,
      source: "titles",
      curation: { kind: "genre", genre },
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])),
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
) {
  try {
    const candidates = await listVerifiedTitleCandidates(userId, itemType);
    const titles = candidates
      .filter((row) => numberOrNull(titleTmdb(row).vote_average) !== null)
      .sort((a, b) =>
        numberOr(titleTmdb(b).vote_average, 0) - numberOr(titleTmdb(a).vote_average, 0) ||
        numberOr(b.variant_count, 0) - numberOr(a.variant_count, 0) ||
        String(b.synced_at ?? b.updated_at ?? "").localeCompare(String(a.synced_at ?? a.updated_at ?? ""))
      )
      .slice(0, limit);
    const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)));
    return {
      id,
      title,
      itemType,
      source: "titles",
      curation: { kind: "popular", metric: "tmdb_vote_average" },
      items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])),
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return { id, title, itemType, source: "titles", items: [] };
    throw error;
  }
}

async function listBecauseYouWatchedRail(
  userId: string,
  options: { includeMovies: boolean; includeSeries: boolean; limit: number },
) {
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
      const candidates = await listVerifiedTitleCandidates(userId, itemType);
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

      const variantsByTitle = await listVariantsByTitleIds(titles.map((row) => String(row.id)));
      return {
        id: `because-you-watched-${watchedId}`,
        title: "Parce que vous avez regarde",
        itemType,
        source: "titles",
        curation: {
          kind: "because_you_watched",
          anchorTitleId: watchedId,
          anchorTitle: watchedTitle.title ?? watchedTitle.original_title ?? null,
          genres,
        },
        items: titles.map((row) => titleRailItem(row, variantsByTitle.get(String(row.id)) ?? [])),
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
    .from("cloud_title_variants")
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
  const { data, error } = await db
    .from("cloud_titles")
    .select("*")
    .eq("user_id", userId)
    .eq("id", titleId)
    .maybeSingle();
  if (error) {
    if (isMissingMaterialization(error)) return null;
    throwDb(error, "Unable to load title");
  }
  return data ?? null;
}

async function listVerifiedTitleCandidates(userId: string, itemType: "movie" | "series", candidateLimit = 300) {
  const { data, error } = await db
    .from("cloud_titles")
    .select("*")
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .eq("match_status", "provider_verified")
    .gt("variant_count", 0)
    .order("synced_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(candidateLimit);
  if (error) throwDb(error, "Unable to list verified title candidates");
  return (data ?? []) as JsonRecord[];
}

async function listVariantsByTitleIds(titleIds: string[]) {
  const variantsByTitle = new Map<string, JsonRecord[]>();
  if (!titleIds.length) return variantsByTitle;
  for (let index = 0; index < titleIds.length; index += 200) {
    const chunk = titleIds.slice(index, index + 200);
    const { data, error } = await db
      .from("cloud_title_variants")
      .select("*")
      .in("title_id", chunk)
      .order("playback_cost_score", { ascending: true })
      .order("last_observed_ttff_ms", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) {
      if (isMissingMaterialization(error)) return variantsByTitle;
      throwDb(error, "Unable to list title variants");
    }
    for (const variant of data ?? []) {
      const key = String(variant.title_id);
      const existing = variantsByTitle.get(key) ?? [];
      existing.push(variant);
      variantsByTitle.set(key, existing);
    }
  }
  for (const [key, variants] of variantsByTitle) {
    variantsByTitle.set(key, variants.sort(compareTitleVariants).slice(0, HOME_RAIL_VARIANT_LIMIT));
  }
  return variantsByTitle;
}

function titleRailItem(title: JsonRecord, variants: JsonRecord[]) {
  const defaultVariant = variants[0] ?? {};
  const metadata = recordOrEmpty(title.metadata);
  const tmdb = titleTmdb(title);
  const genres = titleGenres(title);
  const overview = stringOrNull(tmdb.overview ?? metadata.overview);
  const rating = numberOrNull(tmdb.vote_average ?? metadata.vote_average);
  const runtime = numberOrNull(tmdb.runtime ?? metadata.runtime);
  const defaultVariantId = defaultVariant.id ?? title.default_variant_id ?? null;
  const posterUrl = preferSecureImage(title.poster_url ?? defaultVariant.poster_url, tmdbImageUrl(tmdb.poster_path, "w500"));
  const backdropUrl = preferSecureImage(title.backdrop_url, tmdbImageUrl(tmdb.backdrop_path, "w780"));
  return {
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
    name: title.title,
    title: title.title,
    original_title: title.original_title,
    year: title.release_year,
    poster_url: posterUrl,
    posterUrl: posterUrl,
    stream_icon: posterUrl,
    backdrop_url: backdropUrl,
    backdropUrl: backdropUrl,
    overview,
    description: overview,
    genres,
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
    default_variant: titleVariantItem(defaultVariant),
    defaultVariant: titleVariantItem(defaultVariant),
    variants: variants.map(titleVariantItem),
    exposed_variant_count: variants.length,
    exposedVariantCount: variants.length,
    variant_count: title.variant_count,
    variantCount: title.variant_count,
    playback_cost_score: defaultVariant.playback_cost_score ?? null,
    playbackCostScore: defaultVariant.playback_cost_score ?? null,
    last_observed_ttff_ms: defaultVariant.last_observed_ttff_ms ?? title.last_observed_ttff_ms ?? null,
    lastObservedTtffMs: defaultVariant.last_observed_ttff_ms ?? title.last_observed_ttff_ms ?? null,
    metadata,
    tmdb,
    data: {
      ...metadata,
      description: overview,
      overview,
      genres,
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
  };
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
  const rawGenres: unknown[] = Array.isArray(tmdb.genres)
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
  return {
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
    compatibility_tier: variant.compatibility_tier,
    compatibilityTier: variant.compatibility_tier,
    playback_cost_score: variant.playback_cost_score,
    playbackCostScore: variant.playback_cost_score,
    last_observed_ttff_ms: variant.last_observed_ttff_ms,
    lastObservedTtffMs: variant.last_observed_ttff_ms,
    metadata: recordOrEmpty(variant.metadata),
  };
}

async function listRawMediaRail(userId: string, itemType: "movie" | "series", id: string, title: string, limit: number) {
  const { data, error } = await db
    .from("cloud_media_items")
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
    items: (data ?? []).map((item) => ({
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
    .from("cloud_live_logical_channels")
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
      .from("cloud_live_logical_channels")
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
    .from("cloud_live_logical_channels")
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
      .from("cloud_live_logical_channels")
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

    const { data: variants, error: variantsError } = await db
      .from("cloud_live_variants")
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
      .from("cloud_live_variants")
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
  return channel;
}

function materializedVariant(row: JsonRecord) {
  return {
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
  };
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
      .from("cloud_media_items")
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
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
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
