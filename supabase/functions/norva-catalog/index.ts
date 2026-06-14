import { createClient } from "npm:@supabase/supabase-js@2";
import { buildLiveCatalog, findLiveChannel, type LiveCatalogItem } from "../_shared/live-catalog.ts";

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
      return json(req, { ok: true, service: "norva-catalog", version: 3, liveContract: "norva.live.logical.v1" });
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
  const includeVariants = boolParam(url.searchParams.get("includeVariants"));
  const maxRows = boundedInt(url.searchParams.get("maxRows"), LIVE_MAX_ROWS, 1000, LIVE_MAX_ROWS);
  const rows = await listLiveRows(userId, sourceId, maxRows);
  return buildLiveCatalog(rows, { country, sourceId, categoryId, includeVariants });
}

async function listLiveChannelVariants(url: URL, userId: string, logicalId: string) {
  const sourceId = url.searchParams.get("sourceId");
  const country = url.searchParams.get("country") || "FR";
  const rows = await listLiveRows(userId, sourceId, boundedInt(url.searchParams.get("maxRows"), LIVE_MAX_ROWS, 1000, LIVE_MAX_ROWS));
  const catalog = buildLiveCatalog(rows, { country, sourceId, includeVariants: true });
  const channel = findLiveChannel(catalog, logicalId);
  if (!channel) throw new HttpError(404, "Logical channel not found");
  return {
    contract: "norva.live.logical.v1",
    channel,
    variants: Array.isArray(channel.variants) ? channel.variants : [],
  };
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
