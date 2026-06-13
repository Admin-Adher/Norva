import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string };

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
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";

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
      return json(req, { ok: true, service: "norva-source-sync", version: 2 });
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "sync") {
      const user = await requireUser(req, supabase);
      const result = await syncCloudSource(segments[1], user.id, supabase);
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

async function syncCloudSource(sourceId: string, userId: string, db: SupabaseClient) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");
  if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");

  const startedAt = new Date().toISOString();
  await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null, last_synced_at: startedAt })
    .eq("id", sourceId)
    .eq("user_id", userId);

  try {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    const result = source.source_type === "xtream"
      ? await syncXtreamSource(sourceId, userId, config, db)
      : source.source_type === "m3u"
        ? await syncM3uSource(sourceId, userId, config, db)
        : { total: 0 };

    if ((source.source_type === "xtream" || source.source_type === "m3u") && Number(result.total ?? 0) <= 0) {
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
          lastSync: { ...result, syncedAt },
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (updateError) throwDb(updateError, "Unable to update source sync status");

    return { sourceId, status: "ready", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source sync failed";
    await db
      .from("cloud_sources")
      .update({ sync_status: "error", sync_error: message, last_synced_at: new Date().toISOString() })
      .eq("id", sourceId)
      .eq("user_id", userId);
    throw error;
  }
}

async function syncXtreamSource(sourceId: string, userId: string, config: JsonRecord, db: SupabaseClient) {
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
  if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");

  const [live, vod, series, liveCategories, vodCategories, seriesCategories] = await Promise.all([
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series_categories" }), 25000).catch(() => []),
  ]);
  const liveCategoryMap = categoryMap(liveCategories);
  const vodCategoryMap = categoryMap(vodCategories);
  const seriesCategoryMap = categoryMap(seriesCategories);

  const rows = [
    ...xtreamRows(sourceId, userId, Array.isArray(live) ? live : [], "live", liveCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(vod) ? vod : [], "movie", vodCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(series) ? series : [], "series", seriesCategoryMap),
  ];

  await replaceSourceItems(sourceId, userId, rows, db);
  return {
    live: Array.isArray(live) ? live.length : 0,
    movies: Array.isArray(vod) ? vod.length : 0,
    series: Array.isArray(series) ? series.length : 0,
    liveCategories: liveCategoryMap.size,
    movieCategories: vodCategoryMap.size,
    seriesCategories: seriesCategoryMap.size,
    total: rows.length,
  };
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
    const container = stringOr(item.container_extension, itemType === "live" ? "m3u8" : "mp4");
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
      }),
      playback_hint: compactRecord({
        sourceType: "xtream",
        streamId,
        streamType: itemType,
        container,
      }),
      available: true,
    });
  }
  return rows;
}

async function syncM3uSource(sourceId: string, userId: string, config: JsonRecord, db: SupabaseClient) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  const playlist = await fetchText(playlistUrl, 30000, 20_000_000);
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

  await replaceSourceItems(sourceId, userId, rows, db);
  return { live: rows.length, total: rows.length };
}

async function replaceSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient) {
  await db.from("cloud_media_items").delete().eq("source_id", sourceId).eq("user_id", userId);
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const { error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,item_type,external_id" });
    if (error) throwDb(error, "Unable to save cloud catalog items");
  }
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  if (!sourceConfigKey) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("value")
      .eq("key", "NORVA_SOURCE_CONFIG_KEY")
      .maybeSingle();
    if (error) console.warn("[norva-source-sync] runtime config unavailable", error.message);
    if (typeof data?.value === "string") sourceConfigKey = data.value;
  }
  const value = { sourceConfigKey };
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
}) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (config.action) url.searchParams.set("action", config.action);
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
