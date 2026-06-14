import { createClient } from "npm:@supabase/supabase-js@2";
import { buildLiveCatalog, findLiveChannel, type LiveCatalogItem } from "../_shared/live-catalog.ts";

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

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LIVE_PAGE_SIZE = 1000;
const LIVE_MAX_ROWS = 80000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);

    if (req.method === "GET" && segments[0] === "health") {
      return json(req, { ok: true, service: "norva-catalog", version: 4, liveContract: "norva.live.logical.v1", materializedLive: true });
    }

    if (req.method === "GET" && isLiveLogicalChannelsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, await listLiveLogicalChannels(url, userId));
    }

    if (req.method === "GET" && isLiveChannelVariantsRoute(segments)) {
      const userId = await requireUserId(req);
      return json(req, await listLiveChannelVariants(url, userId, liveChannelIdFromRoute(segments)));
    }

    if (req.method === "GET" && (segments[0] === "media-items" || (segments[0] === "device" && segments[1] === "media-items"))) {
      const userId = await requireUserId(req);
      return json(req, await listMediaItems(url, userId));
    }

    if (req.method === "GET" && (segments[0] === "media-categories" || (segments[0] === "device" && segments[1] === "media-categories"))) {
      const userId = await requireUserId(req);
      return json(req, await listMediaCategories(url, userId));
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
      const title = normalizeSearchText(stringOr(channel.title ?? channel.name, ""));
      const group = normalizeSearchText(stringOr(channel.category_name ?? channel.group_name ?? channel.section, ""));
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
      if (isMissingMaterialization(error)) return null;
      throwDb(error, "Unable to list materialized live catalog");
    }
    const rows = data ?? [];
    if (!rows.length) return null;

    let variantsByChannelId = new Map<string, JsonRecord[]>();
    if (options.includeVariants) {
      variantsByChannelId = await listMaterializedVariantsByChannelIds(rows.map((row) => String(row.id)));
    }

    const channels = rows.map((row) => materializedChannel(row, variantsByChannelId.get(String(row.id)) ?? null));
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
      total: count ?? channels.length,
      limit,
      offset,
      hasMore: typeof count === "number" ? offset + limit < count : rows.length === limit,
      rawCount: null,
    };
  } catch (error) {
    if (isMissingMaterialization(error)) return null;
    throw error;
  }
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
    if (!channel) return null;

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
  return record.code === "42P01" || String(record.message || "").includes("cloud_live_");
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
