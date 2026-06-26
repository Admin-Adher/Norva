import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string; mediaGatewayUrl: string; mediaGatewayToken: string };
type CloudIdentity = { userId: string; deviceId?: string };

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
const ENV_MEDIA_GATEWAY_URL = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";

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

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      return json(req, { ok: true, service: "norva-series-info", version: 1 });
    }
    if (req.method === "GET" && segments[0] === "sources" && segments[2] === "series-info") {
      const identity = await requireIdentity(req, supabase);
      const seriesInfo = await getXtreamSeriesInfo(url, segments[1], identity.userId, supabase);
      return json(req, seriesInfo);
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-series-info]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function requireIdentity(req: Request, db: SupabaseClient): Promise<CloudIdentity> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await db.auth.getUser(token);
  if (!error && data.user) return { userId: data.user.id };

  const tokenHash = await sha256Hex(token);
  const { data: device, error: deviceError } = await db
    .from("cloud_devices")
    .select("id, user_id")
    .eq("device_token_hash", tokenHash)
    .eq("revoked", false)
    .maybeSingle();
  if (deviceError) throwDb(deviceError, "Unable to verify device token");
  if (!device) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { userId: device.user_id, deviceId: device.id };
}

async function getXtreamSeriesInfo(url: URL, sourceId: string, userId: string, db: SupabaseClient) {
  const seriesId = url.searchParams.get("series_id") ?? url.searchParams.get("seriesId") ?? "";
  if (!seriesId) throw new HttpError(400, "series_id is required");

  const config = await loadSourceConfig(sourceId, userId, db);
  const serverUrl = stringOr(config.serverUrl, "");
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
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
    return cached.payload;
  }

  let payload: JsonRecord;
  try {
    payload = await fetchSeriesInfoFromProvider(db, { serverUrl, username, password, seriesId });
  } catch (error) {
    // Provider failed (most often user_multi_ip / 429). If we hold ANY cached copy — even a
    // stale one — serve it rather than failing the fiche; only surface the error when the
    // cache is empty (the unavoidable cold-miss case the client-side retry handles).
    if (cached) {
      console.warn(
        "[norva-series-info] provider fetch failed, serving stale cache",
        error instanceof Error ? error.message : error,
      );
      return cached.payload;
    }
    throw error;
  }

  // Strip any credential-bearing field before it is returned OR cached. Xtream
  // get_series_info can embed the full user/pass stream URL in `direct_source`; the client
  // never reads it, and this cache is cross-user, so dropping it means one account's
  // credentials can never leak to another via a shared cache entry (or even the response body).
  payload = stripCredentials(payload) as JsonRecord;

  // Cache ONLY a real series-info (episodes or info present). The provider returns {} on a
  // soft block — caching that would poison the entry, so we skip it and keep any prior copy.
  if (serverHost && isCacheableSeriesInfo(payload)) {
    await writeSeriesInfoCache(db, serverHost, seriesId, payload);
  }
  return payload;
}

async function fetchSeriesInfoFromProvider(
  db: SupabaseClient,
  params: { serverUrl: string; username: string; password: string; seriesId: string },
): Promise<JsonRecord> {
  const { serverUrl, username, password, seriesId } = params;
  // Route through the media gateway so series-info reaches the provider from the SAME IP as
  // video streaming. A direct fetch from this Supabase edge runtime egresses a different (and
  // provider-blocked) datacenter IP for the same account, which trips the provider's
  // user_multi_ip anti-sharing block (429). Fall back to a direct fetch only when the gateway
  // is unconfigured or too old to know this route (404/405/5xx) — never worse than before.
  const runtimeConfig = await getRuntimeConfig(db);
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return recordOrEmpty(
        await requestGatewaySeriesInfo(runtimeConfig, { serverUrl, username, password, seriesId }),
      );
    } catch (error) {
      // Fall back only when the GATEWAY itself is the problem (missing route / unreachable /
      // timeout). Provider-origin errors (401/403/429) won't improve via a direct Supabase
      // fetch from a blocked IP — surface those so the stale-cache fallback above can apply.
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-series-info] gateway series-info unavailable, falling back to direct", status);
    }
  }

  return recordOrEmpty(await fetchJson(
    xtreamApiUrl({ serverUrl, username, password, action: "get_series_info" }, { series_id: seriesId }),
    20000,
  ));
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
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const { error } = await db.from("cloud_series_info_cache").upsert(
      { server_host: serverHost, series_id: seriesId, payload, fetched_at: nowIso, updated_at: nowIso },
      { onConflict: "server_host,series_id" },
    );
    if (error) {
      console.warn("[norva-series-info] failed to write series-info cache", error.message);
    }
  } catch (error) {
    console.warn(
      "[norva-series-info] failed to write series-info cache",
      error instanceof Error ? error.message : error,
    );
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/xtream/series-info`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
      },
      body: JSON.stringify({ ...body, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new HttpError(response.status, "Media gateway refused the series-info request", payload);
    }
    return recordOrEmpty(payload);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new HttpError(aborted ? 504 : 502, "Unable to reach media gateway", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

async function loadSourceConfig(sourceId: string, userId: string, db: SupabaseClient) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("config_ciphertext, source_type")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source config");
  if (!source?.config_ciphertext) throw new HttpError(404, "Source config not found");
  if (source.source_type !== "xtream") throw new HttpError(400, "Series details require an Xtream source");
  return decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
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
    if (error) console.warn("[norva-series-info] runtime config unavailable", error.message);
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
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function fetchJson(url: string, timeoutMs: number) {
  const response = await fetchWithTimeout(url, timeoutMs);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed", payload);
  return payload;
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
