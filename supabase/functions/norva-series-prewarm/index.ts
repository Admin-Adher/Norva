import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildProviderDirectFallbackSnapshot,
  directFallbackLeaseTtlSeconds,
  ProviderDirectFallbackLeaseError,
  providerDirectFallbackLeaseOwner,
  withSourceDirectFallbackLease,
} from "../_shared/provider-direct-fallback-lease.mjs";
import { fetchBoundedProviderJson } from "../_shared/bounded-provider-response.mjs";

// norva-series-prewarm - service-gated batch crawler that fills cloud_series_info_cache by
// fetching get_series_info ONCE per series from the media gateway (a SINGLE STABLE IP - the
// only way past the provider's single-IP `user_multi_ip` rule on its metadata API). Once the
// cache is filled, the web serves series-info entirely from the cache -> no live provider call
// -> `user_multi_ip` becomes impossible for a fiche, at any scale. Gated by NORVA_BACKFILL_TOKEN;
// driven off-peak by pg_cron. The one shared lease helper atomically excludes direct account
// probes from credential transitions; the crawler path itself remains gateway-only.

type JsonRecord = Record<string, unknown>;
type RuntimeCfg = { sourceConfigKey: string; gatewayUrl: string; gatewayToken: string };
type SourceAccessSnapshot = {
  configRevision: string;
  sourceVisibilityEpoch: string;
  userVisibilityEpoch: string;
};

class CatalogAccessError extends Error {
  status: number;
  code: "SOURCE_CATALOG_NOT_VISIBLE" | "SOURCE_CATALOG_CHANGED" | "CATALOG_VISIBILITY_UNAVAILABLE";

  constructor(status: number, code: CatalogAccessError["code"], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const encoder = new TextEncoder();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_URL or service key");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const catalogVisibilityEpochs = new WeakMap<Request, string>();

let cfgCache: { value: RuntimeCfg; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!BACKFILL_TOKEN || token !== BACKFILL_TOKEN) return json(req, { error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as JsonRecord;
    const sourceId = String(body.sourceId ?? "");
    const userId = String(body.userId ?? "");
    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 200);
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => String(v)) : null;
    if (!sourceId || !userId) return json(req, { error: "sourceId and userId required" }, 400);

    // Diagnostic: read the account's active-connection COUNT (Xtream login endpoint). The user
    // API never exposes the per-session IPs (panel-admin only), but active_cons vs max_connections
    // tells us live-2nd-connection (>= max) vs pure cooldown (0-1). Login usually answers even
    // during a user_multi_ip streaming/metadata block.
    if (body.probe === "account") return json(req, await accountInfo(req, sourceId, userId));

    return json(req, await prewarm(req, sourceId, userId, limit, ids));
  } catch (err) {
    if (err instanceof CatalogAccessError) return json(req, { error: err.code }, err.status);
    if (err instanceof ProviderDirectFallbackLeaseError) {
      return json(req, {
        error: err.code,
        retryable: true,
        ...(err.retryAfterSeconds == null ? {} : { retryAfterSeconds: err.retryAfterSeconds }),
      }, err.status);
    }
    // This endpoint is callable with an operational token, but its response may
    // still be surfaced by an admin UI. Never echo database/provider payloads or
    // transport exception text back to the caller.
    return json(req, { error: "PREWARM_FAILED" }, 500);
  }
});

async function prewarm(
  req: Request,
  sourceId: string,
  userId: string,
  limit: number,
  explicitIds: string[] | null,
) {
  if (!(await sourceCatalogVisible(sourceId, userId))) {
    return { error: "SOURCE_CATALOG_NOT_VISIBLE", attempted: 0 };
  }
  const sourceSnapshot = await readVisibleSourceSnapshot(sourceId, userId, false);
  const cfg = await getRuntimeCfg();
  if (!cfg.gatewayUrl || !cfg.gatewayToken) return { error: "media gateway not configured" };

  const loadedSource = await loadSource(sourceId, userId, cfg.sourceConfigKey, sourceSnapshot);
  const source = loadedSource.config;
  const serverUrl = strOr(source.serverUrl);
  const username = typeof source.username === "string" && source.username.trim() ? source.username : "";
  const password = typeof source.password === "string" && source.password.length ? source.password : "";
  const serverHost = hostOf(serverUrl);
  if (!serverUrl || !username || !password || !serverHost) return { error: "source config incomplete" };

  const targets = explicitIds?.length
    ? explicitIds.slice(0, limit)
    : await uncachedSeriesIds(sourceId, serverHost, limit);
  await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);

  let cached = 0, failed429 = 0, failedOther = 0, consecutive429 = 0;
  let lastError: string | null = null;
  let aborted = false;

  const accountKey = `${serverHost.toLowerCase()}/${username}`;
  for (const seriesId of targets) {
    try {
      const { data: busy } = await supabase.rpc("provider_account_busy", { p_key: accountKey });
      if (busy === true) {
        aborted = true;
        lastError = "provider-account-busy";
        break;
      }
    } catch (_) { /* fail-open: keep warming */ }
    try {
      await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
      const payload = await gatewaySeriesInfo(cfg, { serverUrl, username, password, seriesId });
      const clean = stripCreds(payload) as JsonRecord;
      await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
      if (cacheable(clean)) {
        const nowIso = new Date().toISOString();
        const { error } = await supabase.from("cloud_series_info_cache").upsert(
          { server_host: serverHost, series_id: seriesId, payload: clean, fetched_at: nowIso, updated_at: nowIso },
          { onConflict: "server_host,series_id" },
        );
        if (error) { failedOther++; lastError = "CACHE_WRITE_FAILED"; }
        else {
          try {
            await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
          } catch (guardError) {
            await discardSeriesInfoCacheWrite(serverHost, seriesId, nowIso);
            throw guardError;
          }
          cached++;
          consecutive429 = 0;
        }
      } else {
        failedOther++;
        lastError = "empty/non-cacheable payload";
      }
    } catch (err) {
      if (err instanceof CatalogAccessError) throw err;
      const status = (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : "";
      if (status === 429 || /user_multi_ip/i.test(msg)) {
        lastError = "PROVIDER_THROTTLED";
        failed429++;
        consecutive429++;
        if (consecutive429 >= 3) { aborted = true; break; } // provider blocking - stop hammering
      } else {
        lastError = classifyPrewarmFailure(status);
        failedOther++;
      }
    }
    await sleep(300); // one connection at a time, spaced - never look like multiple clients
  }

  await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
  catalogVisibilityEpochs.set(req, sourceSnapshot.userVisibilityEpoch);
  return { attempted: targets.length, cached, failed429, failedOther, aborted, lastError, serverHost };
}

async function accountInfo(req: Request, sourceId: string, userId: string): Promise<JsonRecord> {
  if (!(await sourceCatalogVisible(sourceId, userId))) {
    throw new CatalogAccessError(409, "SOURCE_CATALOG_NOT_VISIBLE", "Catalog is not currently available");
  }
  const sourceSnapshot = await readVisibleSourceSnapshot(sourceId, userId, false);
  const cfg = await getRuntimeCfg();
  const loadedSource = await loadSource(sourceId, userId, cfg.sourceConfigKey, sourceSnapshot);
  const source = loadedSource.config;
  const serverUrl = strOr(source.serverUrl);
  const username = typeof source.username === "string" && source.username.trim() ? source.username : "";
  const password = typeof source.password === "string" && source.password.length ? source.password : "";
  const serverHost = hostOf(serverUrl);
  if (!serverUrl || !username || !password) return { error: "source config incomplete" };

  const base = serverUrl.replace(/\/+$/, "");
  const url = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  try {
    await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
    const { resp, data } = await withSourceDirectFallbackLease({
      db: supabase,
      sourceId,
      userId,
      owner: providerDirectFallbackLeaseOwner("series-prewarm-account"),
      ttlSeconds: directFallbackLeaseTtlSeconds(15_000),
      ...await buildProviderDirectFallbackSnapshot({
        serverUrl,
        username,
        configCiphertext: loadedSource.configCiphertext,
        configRevision: sourceSnapshot.configRevision,
      }),
    }, async () => {
      const { response, value: data } = await fetchBoundedProviderJson(url, {
        timeoutMs: 15_000,
        maxBytes: 1024 * 1024,
        headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" },
      });
      return { resp: response, data };
    });
    await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
    catalogVisibilityEpochs.set(req, sourceSnapshot.userVisibilityEpoch);
    const ui = isRecord(data) && isRecord(data.user_info) ? (data.user_info as JsonRecord) : null;
    return {
      serverHost,
      httpOk: resp.ok,
      httpStatus: resp.status,
      user_info: ui
        ? {
            auth: ui.auth,
            status: ui.status,
            active_cons: ui.active_cons,
            max_connections: ui.max_connections,
            is_trial: ui.is_trial,
            exp_date: ui.exp_date,
          }
        : null,
      note: ui ? undefined : "PROVIDER_ACCOUNT_STATUS_UNAVAILABLE",
    };
  } catch (err) {
    if (err instanceof CatalogAccessError) throw err;
    if (err instanceof ProviderDirectFallbackLeaseError) throw err;
    await assertSourceSnapshotCurrent(sourceId, userId, sourceSnapshot);
    catalogVisibilityEpochs.set(req, sourceSnapshot.userVisibilityEpoch);
    return { serverHost, error: "PROVIDER_ACCOUNT_PROBE_FAILED" };
  }
}

async function uncachedSeriesIds(sourceId: string, serverHost: string, limit: number): Promise<string[]> {
  const { data: items } = await supabase
    .from("cloud_catalog_visible_media_items")
    .select("external_id")
    .eq("source_id", sourceId)
    .eq("item_type", "series")
    .limit(6000);
  const all = Array.from(new Set((items ?? []).map((r) => String((r as JsonRecord).external_id)).filter(Boolean)));
  const { data: cachedRows } = await supabase
    .from("cloud_series_info_cache")
    .select("series_id")
    .eq("server_host", serverHost)
    .limit(20000);
  const have = new Set((cachedRows ?? []).map((r) => String((r as JsonRecord).series_id)));
  return all.filter((id) => !have.has(id)).slice(0, limit);
}

async function sourceCatalogVisible(sourceId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("norva_source_catalog_visible", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) {
    throw new CatalogAccessError(
      503,
      "CATALOG_VISIBILITY_UNAVAILABLE",
      "Catalog visibility is temporarily unavailable",
    );
  }
  return data === true;
}

async function readVisibleSourceSnapshot(
  sourceId: string,
  userId: string,
  changedDuringOperation: boolean,
): Promise<SourceAccessSnapshot> {
  const { data, error } = await supabase
    .from("cloud_catalog_visible_sources")
    .select("config_revision,visibility_epoch,user_visibility_epoch")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new CatalogAccessError(
      503,
      "CATALOG_VISIBILITY_UNAVAILABLE",
      "Catalog visibility is temporarily unavailable",
    );
  }
  if (!data) {
    throw new CatalogAccessError(
      409,
      changedDuringOperation ? "SOURCE_CATALOG_CHANGED" : "SOURCE_CATALOG_NOT_VISIBLE",
      changedDuringOperation
        ? "Catalog access changed while prewarming series metadata"
        : "Catalog is not currently available",
    );
  }
  const configRevision = revisionToken(data.config_revision);
  const sourceVisibilityEpoch = revisionToken(data.visibility_epoch);
  const userVisibilityEpoch = revisionToken(data.user_visibility_epoch);
  if (!configRevision || !sourceVisibilityEpoch || !userVisibilityEpoch) {
    throw new CatalogAccessError(
      503,
      "CATALOG_VISIBILITY_UNAVAILABLE",
      "Catalog visibility is temporarily unavailable",
    );
  }
  return { configRevision, sourceVisibilityEpoch, userVisibilityEpoch };
}

async function assertSourceSnapshotCurrent(
  sourceId: string,
  userId: string,
  expected: SourceAccessSnapshot,
): Promise<void> {
  const current = await readVisibleSourceSnapshot(sourceId, userId, true);
  if (
    current.configRevision !== expected.configRevision
    || current.sourceVisibilityEpoch !== expected.sourceVisibilityEpoch
    || current.userVisibilityEpoch !== expected.userVisibilityEpoch
  ) {
    throw new CatalogAccessError(
      409,
      "SOURCE_CATALOG_CHANGED",
      "Catalog access changed while prewarming series metadata",
    );
  }
}

function revisionToken(value: unknown): string {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, "");
  }
  return "";
}

async function gatewaySeriesInfo(
  cfg: RuntimeCfg,
  body: { serverUrl: string; username: string; password: string; seriesId: string },
): Promise<JsonRecord> {
  const { response, value } = await fetchBoundedProviderJson(
    `${cfg.gatewayUrl}/xtream/series-info`,
    {
      timeoutMs: 20_000,
      maxBytes: 8 * 1024 * 1024,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.gatewayToken}` },
      body: JSON.stringify({ ...body, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
    },
  );
  if (!response.ok) {
    // Keep the upstream body private. Callers only need the status class to
    // apply bounded backoff; provider/gateway payloads can contain account
    // identifiers or implementation details.
    const err = new Error("gateway series-info failed") as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return isRecord(value) ? value : {};
}

async function discardSeriesInfoCacheWrite(
  serverHost: string,
  seriesId: string,
  writeMarker: string,
): Promise<void> {
  try {
    await supabase
      .from("cloud_series_info_cache")
      .delete()
      .eq("server_host", serverHost)
      .eq("series_id", seriesId)
      .eq("fetched_at", writeMarker)
      .eq("updated_at", writeMarker);
  } catch (_) {
    // Best effort. The worker still stops and never reports the A-era payload.
  }
}

async function loadSource(
  sourceId: string,
  userId: string,
  sourceConfigKey: string,
  expectedSnapshot: SourceAccessSnapshot,
): Promise<{ config: JsonRecord; configCiphertext: string }> {
  const { data: source, error } = await supabase
    .from("cloud_sources")
    .select("config_ciphertext, source_type")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!source?.config_ciphertext) throw new Error("source config not found");
  if (source.source_type !== "xtream") throw new Error("not an xtream source");
  const config = await decryptSourceConfig(source.config_ciphertext as string, sourceConfigKey);
  await assertSourceSnapshotCurrent(sourceId, userId, expectedSnapshot);
  return { config, configCiphertext: String(source.config_ciphertext) };
}

async function getRuntimeCfg(): Promise<RuntimeCfg> {
  if (cfgCache && cfgCache.expiresAt > Date.now()) return cfgCache.value;
  let sourceConfigKey = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
  let gatewayUrl = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
  let gatewayToken = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
  if (!sourceConfigKey || !gatewayUrl || !gatewayToken) {
    const { data } = await supabase
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", ["NORVA_SOURCE_CONFIG_KEY", "NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"]);
    for (const item of data ?? []) {
      const v = (item as JsonRecord).value;
      const k = (item as JsonRecord).key;
      if (typeof v !== "string" || !v) continue;
      if (k === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = v;
      else if (k === "NORVA_MEDIA_GATEWAY_URL" && !gatewayUrl) gatewayUrl = v.replace(/\/+$/, "");
      else if (k === "NORVA_MEDIA_GATEWAY_TOKEN" && !gatewayToken) gatewayToken = v;
    }
  }
  const value = { sourceConfigKey, gatewayUrl, gatewayToken };
  cfgCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function decryptSourceConfig(ciphertext: string, sourceConfigKey: string): Promise<JsonRecord> {
  if (!sourceConfigKey) throw new Error("source encryption key not configured");
  const [scheme, version, ivPart, dataPart] = ciphertext.split(".");
  if (scheme !== "aesgcm" || version !== "v1" || !ivPart || !dataPart) throw new Error("unsupported config format");
  const key = await aesKey(sourceConfigKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
    key,
    base64UrlToBytes(dataPart),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isRecord(parsed)) throw new Error("invalid source config payload");
  return parsed;
}

async function aesKey(secret: string) {
  let material = base64UrlToBytes(secret);
  if (material.byteLength !== 32) {
    material = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]);
}

function stripCreds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCreds);
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === "direct_source") continue;
      out[k] = stripCreds(v);
    }
    return out;
  }
  return value;
}

function cacheable(payload: JsonRecord): boolean {
  const episodes = payload.episodes;
  if (isRecord(episodes) && Object.keys(episodes).length > 0) return true;
  const info = payload.info;
  if (isRecord(info) && Object.keys(info).length > 0) return true;
  return false;
}

function hostOf(value: string): string {
  try { return new URL(value).host; } catch { return ""; }
}

function strOr(v: unknown): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function isRecord(v: unknown): v is JsonRecord {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(req: Request, data: unknown, status = 200) {
  const epoch = catalogVisibilityEpochs.get(req);
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...(epoch ? { "X-Norva-Visibility-Epoch": epoch } : {}),
      "Access-Control-Expose-Headers": "x-norva-visibility-epoch",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function classifyPrewarmFailure(status: unknown): string {
  const numericStatus = typeof status === "number" && Number.isFinite(status) ? status : 0;
  if (numericStatus === 401 || numericStatus === 403) return "PROVIDER_AUTH_FAILED";
  if (numericStatus === 408 || numericStatus === 429 || numericStatus >= 500) {
    return "PROVIDER_TEMPORARILY_UNAVAILABLE";
  }
  return "PREWARM_ITEM_FAILED";
}
