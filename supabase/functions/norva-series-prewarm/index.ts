import { createClient } from "npm:@supabase/supabase-js@2";

// norva-series-prewarm - service-gated batch crawler that fills cloud_series_info_cache by
// fetching get_series_info ONCE per series from the media gateway (a SINGLE STABLE IP - the
// only way past the provider's single-IP `user_multi_ip` rule on its metadata API). Once the
// cache is filled, the web serves series-info entirely from the cache -> no live provider call
// -> `user_multi_ip` becomes impossible for a fiche, at any scale. Gated by NORVA_BACKFILL_TOKEN;
// driven off-peak by pg_cron. Self-contained on purpose (no shared imports) so it stays low-risk.

type JsonRecord = Record<string, unknown>;
type RuntimeCfg = { sourceConfigKey: string; gatewayUrl: string; gatewayToken: string };

const encoder = new TextEncoder();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_URL or service key");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let cfgCache: { value: RuntimeCfg; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!BACKFILL_TOKEN || token !== BACKFILL_TOKEN) return json({ error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as JsonRecord;
    const sourceId = String(body.sourceId ?? "");
    const userId = String(body.userId ?? "");
    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 200);
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => String(v)) : null;
    if (!sourceId || !userId) return json({ error: "sourceId and userId required" }, 400);

    // Diagnostic: read the account's active-connection COUNT (Xtream login endpoint). The user
    // API never exposes the per-session IPs (panel-admin only), but active_cons vs max_connections
    // tells us live-2nd-connection (>= max) vs pure cooldown (0-1). Login usually answers even
    // during a user_multi_ip streaming/metadata block.
    if (body.probe === "account") return json(await accountInfo(sourceId, userId));

    return json(await prewarm(sourceId, userId, limit, ids));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "prewarm failed" }, 500);
  }
});

async function prewarm(sourceId: string, userId: string, limit: number, explicitIds: string[] | null) {
  const cfg = await getRuntimeCfg();
  if (!cfg.gatewayUrl || !cfg.gatewayToken) return { error: "media gateway not configured" };

  const source = await loadSource(sourceId, userId, cfg.sourceConfigKey);
  const serverUrl = strOr(source.serverUrl);
  const username = strOr(source.username);
  const password = strOr(source.password);
  const serverHost = hostOf(serverUrl);
  if (!serverUrl || !username || !password || !serverHost) return { error: "source config incomplete" };

  const targets = explicitIds?.length
    ? explicitIds.slice(0, limit)
    : await uncachedSeriesIds(sourceId, serverHost, limit);

  let cached = 0, failed429 = 0, failedOther = 0, consecutive429 = 0;
  let lastError: string | null = null;
  let aborted = false;

  for (const seriesId of targets) {
    try {
      const payload = await gatewaySeriesInfo(cfg, { serverUrl, username, password, seriesId });
      const clean = stripCreds(payload) as JsonRecord;
      if (cacheable(clean)) {
        const nowIso = new Date().toISOString();
        const { error } = await supabase.from("cloud_series_info_cache").upsert(
          { server_host: serverHost, series_id: seriesId, payload: clean, fetched_at: nowIso, updated_at: nowIso },
          { onConflict: "server_host,series_id" },
        );
        if (error) { failedOther++; lastError = error.message; }
        else { cached++; consecutive429 = 0; }
      } else {
        failedOther++;
        lastError = "empty/non-cacheable payload";
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (status === 429 || /user_multi_ip/i.test(msg)) {
        failed429++;
        consecutive429++;
        if (consecutive429 >= 3) { aborted = true; break; } // provider blocking - stop hammering
      } else {
        failedOther++;
      }
    }
    await sleep(300); // one connection at a time, spaced - never look like multiple clients
  }

  return { attempted: targets.length, cached, failed429, failedOther, aborted, lastError, serverHost };
}

async function accountInfo(sourceId: string, userId: string): Promise<JsonRecord> {
  const cfg = await getRuntimeCfg();
  const source = await loadSource(sourceId, userId, cfg.sourceConfigKey);
  const serverUrl = strOr(source.serverUrl);
  const username = strOr(source.username);
  const password = strOr(source.password);
  const serverHost = hostOf(serverUrl);
  if (!serverUrl || !username || !password) return { error: "source config incomplete" };

  const base = serverUrl.replace(/\/+$/, "");
  const url = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" } });
    const data = await resp.json().catch(() => null);
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
      note: ui ? undefined : (isRecord(data) ? data : "no user_info from provider"),
    };
  } catch (err) {
    return { serverHost, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function uncachedSeriesIds(sourceId: string, serverHost: string, limit: number): Promise<string[]> {
  const { data: items } = await supabase
    .from("cloud_media_items")
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

async function gatewaySeriesInfo(
  cfg: RuntimeCfg,
  body: { serverUrl: string; username: string; password: string; seriesId: string },
): Promise<JsonRecord> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`${cfg.gatewayUrl}/xtream/series-info`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.gatewayToken}` },
      body: JSON.stringify({ ...body, userAgent: "VLC/3.0.20 LibVLC/3.0.20" }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(isRecord(payload) ? JSON.stringify(payload) : "gateway series-info failed") as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }
    return isRecord(payload) ? payload : {};
  } finally {
    clearTimeout(timer);
  }
}

async function loadSource(sourceId: string, userId: string, sourceConfigKey: string): Promise<JsonRecord> {
  const { data: source, error } = await supabase
    .from("cloud_sources")
    .select("config_ciphertext, source_type")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!source?.config_ciphertext) throw new Error("source config not found");
  if (source.source_type !== "xtream") throw new Error("not an xtream source");
  return decryptSourceConfig(source.config_ciphertext as string, sourceConfigKey);
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
