const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const app = express();

// Residential proxy POOL for ALL outbound provider traffic. Some IPTV providers
// 458/block datacenter IPs (e.g. Railway) while serving residential IPs fine; routing
// the gateway's provider requests through residential proxies makes the provider see a
// residential exit IP.
//
//   PROVIDER_PROXY_URLS  comma/space/newline-separated list of proxy URLs
//                        (e.g. http://user:pass@host:port). Used as a POOL.
//   PROVIDER_PROXY_URL   single URL (back-compat). Merged into the pool.
//
// Each provider ACCOUNT is pinned to ONE pool IP (sticky by a stable key — the Norva
// user id, or host+username from the stream URL). Stickiness matters: a single account
// hitting from many IPs looks like a proxy and gets flagged; one stable residential IP
// per account looks normal. Across many users the pool spreads load over the IPs (less
// density per IP, more aggregate bandwidth). undici is only loaded when a proxy is set.
// Secrets live in env only — never commit them.
const providerProxyUrls = ((process.env.PROVIDER_PROXY_URLS || process.env.PROVIDER_PROXY_URL || '')
    .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
let providerProxyAgents = [];
if (providerProxyUrls.length) {
    try {
        const { ProxyAgent } = require('undici');
        providerProxyAgents = providerProxyUrls.map((u) => new ProxyAgent(u));
        // Node's built-in fetch ignores http_proxy env (it needs the per-request dispatcher),
        // but spawned ffmpeg/ffprobe DO honour http_proxy/https_proxy. Set a default (first
        // pool IP) so any spawn without an explicit per-request env still exits residential;
        // per-request spawns override it via proxyEnvFor(). Supabase/internal fetch() stays
        // direct (fetch ignores these env vars).
        if (!process.env.http_proxy) process.env.http_proxy = providerProxyUrls[0];
        if (!process.env.https_proxy) process.env.https_proxy = providerProxyUrls[0];
        console.log(`[media-gateway] provider proxy ENABLED — pool of ${providerProxyAgents.length} residential IP(s), sticky per account`);
    } catch (err) {
        console.error('[media-gateway] PROVIDER_PROXY_URL(S) set but proxy could not be initialised:', (err && err.message) || err);
        providerProxyAgents = [];
    }
}
// FNV-1a hash → stable index into the pool for a given key (same key → same IP).
function poolIndexForKey(key) {
    if (providerProxyAgents.length <= 1) return 0;
    const s = String(key || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % providerProxyAgents.length;
}
// Per-account sticky key from a provider stream URL: host + the username path segment
// (Xtream: /movie|series|live/USER/PASS/ID.ext → USER), falling back to the host.
function proxyKeyFromUrl(url) {
    try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean);
        return u.host + (segs.length >= 2 ? '/' + segs[1] : '');
    } catch (_) { return String(url || ''); }
}
function pickProxyAgent(key) {
    return providerProxyAgents.length ? providerProxyAgents[poolIndexForKey(key)] : null;
}
// Spawn env routing a child (ffmpeg/ffprobe) through this key's sticky pool IP.
function proxyEnvFor(key) {
    if (!providerProxyAgents.length) return undefined;
    const url = providerProxyUrls[poolIndexForKey(key)];
    return { ...process.env, http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url };
}

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.NORVA_MEDIA_GATEWAY_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(os.tmpdir(), 'norva-media-gateway'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const DEFAULT_TTL_SECONDS = clampInt(process.env.SESSION_TTL_SECONDS, 30 * 60, 60, 12 * 60 * 60);
// Linear-read VOD resume (-seekable 0) reaches the resume point by reading from
// byte 0, so far resumes need a longer startup budget than a normal stream.
const STARTUP_TIMEOUT_MS = clampInt(process.env.STARTUP_TIMEOUT_MS, 60_000, 5_000, 180_000);
const PLAYLIST_REQUEST_TIMEOUT_MS = clampInt(process.env.PLAYLIST_REQUEST_TIMEOUT_MS, 45_000, 5_000, 180_000);
const XTREAM_REQUEST_TIMEOUT_MS = clampInt(process.env.XTREAM_REQUEST_TIMEOUT_MS, 15_000, 5_000, 60_000);
const CODEC_PROBE_TIMEOUT_MS = clampInt(process.env.CODEC_PROBE_TIMEOUT_MS, 12_000, 1_000, 30_000);
const CODEC_PROBE_ANALYZE_DURATION_US = clampInt(process.env.CODEC_PROBE_ANALYZE_DURATION_US, 2_000_000, 250_000, 20_000_000);
const CODEC_PROBE_SIZE_BYTES = clampInt(process.env.CODEC_PROBE_SIZE_BYTES, 2_000_000, 64_000, 20_000_000);
// Cache the ffprobe codec profile per source URL so repeated probes of the SAME
// file (audio-menu re-open, /subtitle enumeration, a fresh session) don't each open
// a new provider connection — that extra connection is what a single-slot provider
// 458s, intermittently blanking the audio-track languages. TTL-bounded + size-capped;
// only successful profiles are cached, so a transient probe failure still retries.
// Set CODEC_PROFILE_CACHE_TTL_MS=0 to disable.
const CODEC_PROFILE_CACHE_TTL_MS = clampInt(process.env.CODEC_PROFILE_CACHE_TTL_MS, 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
const CODEC_PROFILE_CACHE_MAX = clampInt(process.env.CODEC_PROFILE_CACHE_MAX, 5_000, 0, 100_000);
// IN-BAND HEADER PARSE (stage 2, OFF by default). When enabled, /raw tees the file's
// LEADING bytes (which the engine fetches first anyway) into memory; a codec probe then
// runs ffprobe on those local bytes instead of opening a SECOND provider connection —
// the connection a single-slot provider 458s. Covers MKV + faststart MP4 (header at
// front); falls back to the provider probe when the local bytes don't parse (e.g. an
// MP4 with moov at the end). Memory is bounded by bytes/entry × entries.
const INBAND_HEADER_PARSE = (process.env.INBAND_HEADER_PARSE || 'false') === 'true';
const INBAND_HEADER_BYTES = clampInt(process.env.INBAND_HEADER_BYTES, 4_000_000, 256_000, 32_000_000);
const INBAND_HEADER_CACHE_MAX = clampInt(process.env.INBAND_HEADER_CACHE_MAX, 16, 0, 256);
const INBAND_HEADER_TTL_MS = clampInt(process.env.INBAND_HEADER_TTL_MS, 5 * 60 * 1000, 0, 60 * 60 * 1000);
// whisper.cpp audio-track language detection (Phase 2, self-hosted / free). Unset WHISPER_BIN
// or WHISPER_MODEL to disable the /detect-language endpoint.
const WHISPER_BIN = process.env.WHISPER_BIN || '';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '';
const WHISPER_THREADS = clampInt(process.env.WHISPER_THREADS, 4, 1, 16);
const WHISPER_TIMEOUT_MS = clampInt(process.env.WHISPER_TIMEOUT_MS, 60_000, 5_000, 300_000);
// Bounded mid-film sweep for language detection: a film opens with logos/silence/music, so
// sampling at offset 0 detects nothing. Try these offsets (seconds) in order and stop at the
// first clip with real speech; a clip past the file's end yields no WAV and is skipped. Bounded
// (≤ length) so it never hammers a single-connection provider. Override via WHISPER_SWEEP_OFFSETS.
const WHISPER_SWEEP_OFFSETS = (process.env.WHISPER_SWEEP_OFFSETS || '600,1500,300')
    .split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
// Full transcription (Phase 3) runs whisper on a whole film → much longer than the 20s LID clip.
const WHISPER_TRANSCRIBE_TIMEOUT_MS = clampInt(process.env.WHISPER_TRANSCRIBE_TIMEOUT_MS, 1_200_000, 30_000, 7_200_000);
const AUDIO_EXTRACT_TIMEOUT_MS = clampInt(process.env.AUDIO_EXTRACT_TIMEOUT_MS, 1_800_000, 30_000, 7_200_000);
const LIVE_INPUT_ANALYZE_DURATION_US = clampInt(process.env.LIVE_INPUT_ANALYZE_DURATION_US, 1_500_000, 250_000, 10_000_000);
const LIVE_INPUT_PROBE_SIZE_BYTES = clampInt(process.env.LIVE_INPUT_PROBE_SIZE_BYTES, 2_000_000, 64_000, 10_000_000);
const VOD_INPUT_ANALYZE_DURATION_US = clampInt(process.env.VOD_INPUT_ANALYZE_DURATION_US, 8_000_000, 250_000, 30_000_000);
const VOD_INPUT_PROBE_SIZE_BYTES = clampInt(process.env.VOD_INPUT_PROBE_SIZE_BYTES, 8_000_000, 64_000, 30_000_000);
const MAX_SUBTITLE_TRACKS = clampInt(process.env.MAX_SUBTITLE_TRACKS, 32, 1, 64);
const PROVIDER_SLOT_RELEASE_DELAY_MS = clampInt(process.env.PROVIDER_SLOT_RELEASE_DELAY_MS, 2_500, 0, 15_000);
const STOP_CONFLICTING_SOURCE_SESSIONS = (process.env.STOP_CONFLICTING_SOURCE_SESSIONS || 'true') !== 'false';
const STOP_CONFLICTING_OWNER_SESSIONS = (process.env.STOP_CONFLICTING_OWNER_SESSIONS || 'true') !== 'false';
// The provider allows a single concurrent connection; a fresh session can hit a
// 401 while the previous connection's slot is still releasing. Retry startup a
// few times (after re-evicting + waiting) before surfacing a 502 to the client.
// Defaults tuned for fast-fail: a dead/blocked channel surfaces a 502 in ~3s
// (1 retry @ 1.5s) instead of ~12s (2 retries @ 4s), and hits the provider 2x
// instead of 3x — far less load on a single-slot provider's anti-abuse. A
// legitimate channel switch still gets its retry: the client already frees the
// old slot (prepareLiveSwitch) ~1-2s before the new ffmpeg starts, so the slot
// is released by the 1.5s retry. Overridable via env.
const PROVIDER_AUTH_RETRY_LIMIT = clampInt(process.env.PROVIDER_AUTH_RETRY_LIMIT, 1, 0, 5);
const PROVIDER_AUTH_RETRY_DELAY_MS = clampInt(process.env.PROVIDER_AUTH_RETRY_DELAY_MS, 1_500, 0, 15_000);
// The in-browser byte-pipe (/raw) issues many short byte-range requests. The
// single-slot provider can 401/403/429 one whose connection slot from the prior
// read hasn't released yet (~PROVIDER_SLOT_RELEASE_DELAY_MS). ffmpeg rides this
// out via auto-reconnect; mirror it here with a few quick retries so a transient
// provider auth blip doesn't abort playback. Fewer attempts with LONGER quiet gaps:
// a single-slot provider only frees the slot after it sees no connection for a
// stretch (~8s), so packing many quick retries keeps poking it and the slot never
// goes quiet. Bigger gaps give the provider real silence to release between tries.
const RAW_PROVIDER_RETRY_LIMIT = clampInt(process.env.RAW_PROVIDER_RETRY_LIMIT, 3, 0, 8);
const RAW_PROVIDER_RETRY_DELAYS_MS = [1500, 5000, 9000, 9000, 9000, 9000, 9000, 9000];
const FFMPEG_USER_AGENT = process.env.FFMPEG_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Norva/1.0';
const MAX_LOG_TAIL = 12000;
const GATEWAY_VERSION = 54;
// Browser playback fetches HLS playlists/segments cross-origin, so these must
// list every Norva web origin or the browser blocks the response (CORS). Keep
// in sync with the relay's ALLOWED_ORIGINS (services/norva-relay/wrangler.jsonc).
const DEFAULT_ALLOWED_ORIGINS = [
    'https://norva.tv',
    'https://app.norva.tv',
    'https://norva-web.pages.dev',
    'http://localhost:3000',
    'http://localhost:5173',
].join(',');
// Fallback audio path: plain AAC-LC stereo @48k. Source HE-AAC / unusual sample
// rates can make hls.js label the track mp4a.40.5 (HE-AAC), and Chrome's MSE
// may reject the append. Copy audio only when the codec hint is browser-safe.
const TRANSCODE_AUDIO_ARGS = [
    '-af', 'aresample=48000:async=1:first_pts=0',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '160k'
];

const sessions = new Map();
// sourceUrl -> { profile, expiresAt }. Populated by probeCodecProfile (cached wrapper).
const codecProfileCache = new Map();
// sourceUrl -> { chunks: Buffer[], len, done, capturing, updatedAt }. Leading bytes tee'd
// from /raw so a codec probe can read the header locally (no 2nd provider connection).
const headerByteCache = new Map();
const lastFailures = [];
const probeStats = {
    attempts: 0,
    successes: 0,
    failures: 0,
    empty: 0,
    cacheHits: 0,
    inbandHits: 0,
    last: null,
    lastFailure: null
};

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors);

app.options('*', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        codecProbe: true,
        codecProbeTimeoutMs: CODEC_PROBE_TIMEOUT_MS,
        codecProbeAnalyzeDurationUs: CODEC_PROBE_ANALYZE_DURATION_US,
        codecProbeSizeBytes: CODEC_PROBE_SIZE_BYTES,
        maxSubtitleTracks: MAX_SUBTITLE_TRACKS,
        probeStats,
        codecProfileCacheSize: codecProfileCache.size,
        languageDetect: Boolean(WHISPER_BIN && WHISPER_MODEL),
        providerProxy: providerProxyAgents.length > 0,
        providerProxyPool: providerProxyAgents.length,
        inbandHeaderParse: INBAND_HEADER_PARSE,
        headerByteCacheSize: headerByteCache.size,
        activeSessions: activeSessionCount(),
        totalSessions: sessions.size,
        lastFailureCount: lastFailures.length,
        time: new Date().toISOString()
    });
});

app.get('/debug/failures', requireGatewayAuth, (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        failures: lastFailures
    });
});

app.get('/debug/sessions', requireGatewayAuth, (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        sessions: Array.from(sessions.values()).map(debugSession)
    });
});

app.post('/xtream/epg', requireGatewayAuth, async (req, res) => {
    try {
        const {
            serverUrl,
            username,
            password,
            streamId,
            action = 'get_short_epg',
            limit,
            userAgent
        } = req.body || {};

        const normalizedAction = action === 'get_simple_data_table' ? 'get_simple_data_table' : 'get_short_epg';
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password || !streamId) {
            return res.status(400).json({ error: 'serverUrl, username, password and streamId are required' });
        }

        const url = xtreamPlayerApiUrl({
            serverUrl,
            username,
            password,
            action: normalizedAction,
            streamId,
            limit: normalizedAction === 'get_short_epg' ? limit : ''
        });
        const payload = await fetchProviderJson(url, sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT);
        res.json(payload);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            details: err.details || undefined,
            code: err.code || undefined
        });
    }
});

// Xtream series metadata (get_series_info), proxied through the gateway so it
// reaches the provider from the SAME IP as streaming. Fetched directly from the
// Supabase edge runtime, series-info egresses a *different* (and provider-
// blocked) datacenter IP for the same account — the provider then sees one
// account "connected" from several IPs at once and trips its user_multi_ip
// anti-account-sharing block (429). Routing it here collapses metadata + video
// onto one provider-facing IP. Mirrors /xtream/epg.
app.post('/xtream/series-info', requireGatewayAuth, async (req, res) => {
    try {
        const { serverUrl, username, password, seriesId, userAgent } = req.body || {};
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password || !seriesId) {
            return res.status(400).json({ error: 'serverUrl, username, password and seriesId are required' });
        }
        const url = xtreamPlayerApiUrl({
            serverUrl,
            username,
            password,
            action: 'get_series_info',
            params: { series_id: seriesId }
        });
        const payload = await fetchProviderJson(url, sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT);
        res.json(payload);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            details: err.details || undefined,
            code: err.code || undefined
        });
    }
});

// Generic Xtream metadata proxy (catalogue sync, VOD info, …), proxied so the
// crawl reaches the provider from the SAME tolerated IP as streaming instead of
// the Supabase edge IP (provider-blocked → user_multi_ip AND outright sync
// failures). Actions are whitelisted to read-only player_api endpoints; the
// gateway never becomes an open proxy. Catalogue payloads are large + slow, so a
// generous per-call timeout is used (the global default is tuned for small EPG).
const XTREAM_METADATA_ACTIONS = new Set([
    'get_live_streams', 'get_vod_streams', 'get_series',
    'get_live_categories', 'get_vod_categories', 'get_series_categories',
    'get_vod_info', 'get_series_info', 'get_short_epg', 'get_simple_data_table',
]);
const XTREAM_METADATA_TIMEOUT_MS = clampInt(process.env.XTREAM_METADATA_TIMEOUT_MS, 45_000, 10_000, 120_000);
app.post('/xtream/metadata', requireGatewayAuth, async (req, res) => {
    try {
        const { serverUrl, username, password, action, params, userAgent } = req.body || {};
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password || !action) {
            return res.status(400).json({ error: 'serverUrl, username, password and action are required' });
        }
        // `account_info` validates credentials: the bare player_api.php (no action)
        // returns { user_info, server_info }. Routed through the gateway so source
        // add/validate egresses the tolerated IP, not the provider-blocked Supabase
        // edge IP (which trips user_multi_ip on the account's single connection).
        const isAccountInfo = String(action) === 'account_info';
        if (!isAccountInfo && !XTREAM_METADATA_ACTIONS.has(String(action))) {
            return res.status(400).json({ error: `Unsupported metadata action: ${action}` });
        }
        const url = xtreamPlayerApiUrl({
            serverUrl,
            username,
            password,
            action: isAccountInfo ? '' : String(action),
            params: (params && typeof params === 'object') ? params : undefined
        });
        const payload = await fetchProviderJson(
            url,
            sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT,
            XTREAM_METADATA_TIMEOUT_MS,
        );
        res.json(payload);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            details: err.details || undefined,
            code: err.code || undefined
        });
    }
});

// Raw byte-range passthrough for the in-browser engine. The browser remuxes +
// transcodes the file itself, so the gateway only needs to relay the raw bytes
// from an IP the provider accepts (no FFmpeg, no transcode). Auth is a per-
// session HMAC token signed by the playback function with the shared gateway
// token, carried in the path; the engine fetches it cross-origin with Range.
app.get('/raw/:token', async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const headers = { 'user-agent': claims.ua || FFMPEG_USER_AGENT };
    if (req.headers.range) headers.range = req.headers.range;
    if (req.headers.accept) headers.accept = req.headers.accept;
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

    // Retry transient provider auth/slot failures (single-slot 401/403/429/458) so a
    // burst of byte-range reads doesn't get one connection rejected and abort the
    // whole pump. 458 = "max connections": on a reload/resume the new stream opens
    // while the PRIOR session's slot is still releasing (~8s), so the first /raw 458s
    // and playback dies (PROBE_HTTP_458). The backoff below spans that release window.
    // Anything else (206/200/404/...) passes straight through.
    const maxAttempts = 1 + RAW_PROVIDER_RETRY_LIMIT;
    let upstream = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            upstream = await fetch(claims.url, { method, headers, redirect: 'follow', signal: ac.signal, dispatcher: pickProxyAgent(claims.uid || proxyKeyFromUrl(claims.url)) || undefined });
        } catch (err) {
            if (ac.signal.aborted) { try { res.end(); } catch (_) {} return; }
            if (attempt >= maxAttempts) {
                return res.status(502).json({ error: 'Byte pipe failed', details: String((err && err.message) || err) });
            }
            await sleep(RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000);
            continue;
        }
        const retryable = upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status === 458;
        if (retryable && attempt < maxAttempts) {
            try { await upstream.body?.cancel(); } catch (_) {} // free the slot before retrying
            if (ac.signal.aborted) { try { res.end(); } catch (_) {} return; }
            console.warn(`[media-gateway] /raw provider ${upstream.status} (attempt ${attempt}/${maxAttempts}); retrying in ${RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1]}ms`);
            await sleep(RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000);
            continue;
        }
        break;
    }
    if (ac.signal.aborted) { try { res.end(); } catch (_) {} return; }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=30');
    if (method === 'HEAD' || !upstream.body) { res.end(); return; }
    const nodeStream = require('stream').Readable.fromWeb(upstream.body);
    // In-band header capture: if this response carries the file's LEADING bytes, tee them
    // (best-effort) so a later codec probe reads the header locally instead of opening a
    // second provider connection. Attached BEFORE pipe() so no leading chunk is missed;
    // never throws into the pipe; respects pipe backpressure (no data flows while paused).
    if (INBAND_HEADER_PARSE) {
        try { maybeCaptureHeaderBytes(claims.url, upstream, nodeStream); } catch (_) { /* never break the byte pipe */ }
    }
    nodeStream.pipe(res);
});

// Tee the leading bytes of a /raw response into headerByteCache when the response starts
// at offset 0 (status 200, or 206 with content-range "bytes 0-..."). Appends until
// INBAND_HEADER_BYTES is reached, then detaches. First writer per URL wins; concurrent
// range reads for the same file are ignored so chunks never interleave.
function maybeCaptureHeaderBytes(sourceUrl, upstream, nodeStream) {
    if (!sourceUrl || INBAND_HEADER_BYTES <= 0) return;
    const status = upstream.status;
    if (status === 200) {
        // full body -> starts at 0
    } else if (status === 206) {
        const cr = upstream.headers.get('content-range') || '';
        if (!/^bytes\s+0-/i.test(cr)) return; // not the leading range
    } else {
        return;
    }
    const existing = headerByteCache.get(sourceUrl);
    if (existing && (existing.done || existing.capturing)) return; // already captured / in progress
    // Bound entry count (Map keeps insertion order -> first key is oldest).
    while (INBAND_HEADER_CACHE_MAX > 0 && headerByteCache.size >= INBAND_HEADER_CACHE_MAX) {
        const oldest = headerByteCache.keys().next().value;
        if (oldest === undefined || oldest === sourceUrl) break;
        headerByteCache.delete(oldest);
    }
    const entry = { chunks: [], len: 0, done: false, capturing: true, updatedAt: Date.now() };
    headerByteCache.set(sourceUrl, entry);
    const onData = (chunk) => {
        try {
            if (entry.done) return;
            entry.chunks.push(chunk);
            entry.len += chunk.length;
            entry.updatedAt = Date.now();
            if (entry.len >= INBAND_HEADER_BYTES) {
                entry.done = true;
                entry.capturing = false;
                nodeStream.removeListener('data', onData);
            }
        } catch (_) { /* best-effort capture */ }
    };
    const finalize = () => {
        entry.capturing = false;
        nodeStream.removeListener('data', onData);
        nodeStream.removeListener('end', finalize);
        nodeStream.removeListener('error', finalize);
        nodeStream.removeListener('close', finalize);
    };
    nodeStream.on('data', onData);
    nodeStream.once('end', finalize);
    nodeStream.once('error', finalize);
    nodeStream.once('close', finalize);
}

// Subtitle support for the in-browser ENGINE (byte-pipe) path. The engine plays the
// raw file client-side and can't render subtitles, so it asks the gateway to:
//   - enumerate the container's subtitle tracks (no `index`): ffprobe -> JSON, or
//   - extract a chosen TEXT track to WebVTT (`index`, windowed by `start`/`dur`).
// Auth + source URL come from the same byte-pipe token used by /raw.
app.get('/subtitle/:token', async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    const ua = claims.ua || FFMPEG_USER_AGENT;

    // Enumeration: ffprobe the container, return its subtitle tracks (index, lang, codec).
    if (req.query.index === undefined) {
        try {
            const profile = await probeCodecProfile(claims.url, ua);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            return res.json({
                subtitles: Array.isArray(profile?.subtitles) ? profile.subtitles : [],
                // ffprobe also reads audio-track languages robustly; the client uses
                // them as a fallback when the relay probe couldn't name the audio.
                audioTracks: Array.isArray(profile?.audioTracks) ? profile.audioTracks : [],
            });
        } catch (err) {
            return res.status(502).json({ error: 'Subtitle probe failed', details: String((err && err.message) || err) });
        }
    }

    // Extraction: one TEXT track -> WebVTT, windowed. Mirrors server/routes/subtitle.js
    // (input-side -ss rebases cue timestamps to the window; the client offsets them
    // back) so the player's existing windowed cue machinery is reused unchanged.
    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid subtitle index' });
    const startOffset = Number.parseFloat(req.query.start);
    const hasStart = Number.isFinite(startOffset) && startOffset > 0;
    const windowDur = Math.min(Math.max(Number.parseFloat(req.query.dur) || 300, 1), 900);
    const outputPath = path.join(os.tmpdir(), `norva-sub-${Date.now()}-${crypto.randomUUID()}.vtt`);

    const args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-user_agent', ua,
        '-probesize', '2000000', '-analyzeduration', '3000000',
        ...(hasStart ? ['-ss', String(startOffset)] : []),
        '-i', claims.url,
        '-map', `0:${trackIndex}`,
        '-t', String(windowDur),
        '-c:s', 'webvtt', '-f', 'webvtt',
        outputPath,
    ];

    let child;
    try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(claims.uid || proxyKeyFromUrl(claims.url)) }); }
    catch (_) { return res.status(500).json({ error: 'Subtitle extraction failed' }); }
    let stderr = '';
    let clientClosed = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30_000);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    res.on('close', () => { if (!res.writableEnded) { clientClosed = true; try { child.kill('SIGKILL'); } catch (_) {} } });
    child.on('error', () => { clearTimeout(timer); if (!res.headersSent) res.status(500).end(); });
    child.on('close', async (code) => {
        clearTimeout(timer);
        if (clientClosed) { fsp.unlink(outputPath).catch(() => {}); return; }
        if (code !== 0) {
            console.warn(`[media-gateway] /subtitle ffmpeg exit ${code}: ${stderr.slice(-300)}`);
            fsp.unlink(outputPath).catch(() => {});
            if (!res.headersSent) res.status(502).json({ error: 'Subtitle extraction failed' });
            return;
        }
        let body = '';
        try { body = await fsp.readFile(outputPath, 'utf8'); } catch (_) { body = ''; }
        fsp.unlink(outputPath).catch(() => {});
        if (!String(body || '').trim()) body = 'WEBVTT\n\n';
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(body);
    });
});

// Phase 2: detect the language of ONE audio track, fully self-hosted (no paid API). ffmpeg
// extracts a short mono/16 kHz WAV of the track, whisper.cpp identifies the spoken language,
// and a transcript-based detector resolves script-family ambiguities (Persian/Kurdish/Urdu vs
// Arabic, Ukrainian/Serbian vs Russian). Same byte-pipe token as /raw. Used only for untagged
// tracks and cached upstream, so this 2nd provider connection runs at most once per file.
app.get('/detect-language/:token', async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    if (!WHISPER_BIN || !WHISPER_MODEL) return res.status(503).json({ error: 'Language detection not configured' });
    const ua = claims.ua || FFMPEG_USER_AGENT;

    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid audio index' });
    const dur = Math.min(Math.max(Number.parseFloat(req.query.dur) || 20, 4), 60);
    // An explicit ?start pins a single offset (caller knows where speech is); otherwise sweep the
    // bounded mid-film offsets and stop at the first clip that actually contains speech.
    const explicitStart = Number.parseFloat(req.query.start);
    const offsets = (Number.isFinite(explicitStart) && explicitStart >= 0) ? [explicitStart] : WHISPER_SWEEP_OFFSETS;

    try {
        let best = null;          // best partial result across offsets (most words), as a fallback
        let extractions = 0;      // bound the provider connections
        for (const off of offsets) {
            let wavPath = null;
            try {
                wavPath = await extractAudioWav(claims.url, ua, trackIndex, off > 0 ? off : 0, dur);
                if (!wavPath) continue;   // extraction failed or offset past the file's end → next offset
                extractions++;
                const whisper = await runWhisperDetect(wavPath);
                const det = detectLanguageFromText(whisper.text);
                // Prefer the transcript detector when confident (disambiguates script families);
                // otherwise fall back to whisper.cpp's own language id.
                const language = det.confident ? det.lang : (whisper.lang || null);
                const result = {
                    language,
                    candidate: det.lang || whisper.lang || null,
                    confidence: det.confident ? det.score : (whisper.prob || 0),
                    whisperLang: whisper.lang || null,
                    wordCount: det.words,
                    sample: String(whisper.text || '').slice(0, 160),
                    offset: off,
                };
                // "Good" = a clear transcript with a language → real speech. Stop sweeping. A
                // silent/music clip yields ~no words → keep the best partial and try the next offset.
                if (language && det.words >= 4) {
                    res.setHeader('Cache-Control', 'private, max-age=3600');
                    return res.json(result);
                }
                if (!best || result.wordCount > best.wordCount) best = result;
            } catch (_) { /* try the next offset */ }
            finally { if (wavPath) fsp.unlink(wavPath).catch(() => {}); }
        }
        if (extractions === 0) return res.status(502).json({ error: 'Audio extraction failed' });
        // No clip had clear speech → return the best partial (language may be null).
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.json(best || { language: null, candidate: null, confidence: 0, whisperLang: null, wordCount: 0, sample: '' });
    } catch (err) {
        return res.status(502).json({ error: 'Language detection failed', details: String((err && err.message) || err) });
    }
});

// Phase 3: full timestamped transcription → WebVTT. Extracts the whole audio track (dur 0) or a
// [start, start+dur] window (benchmarking) and runs whisper.cpp -ovtt. Returns the VTT + timings;
// rtf = whisperMs / audioSec is the benchmark number (on-demand viable if rtf is small). Same
// byte-pipe token as /raw. HEAVY + LONG — meant for a job/queue, never the hot path.
app.get('/transcribe/:token', async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    if (!WHISPER_BIN || !WHISPER_MODEL) return res.status(503).json({ error: 'Transcription not configured' });
    const ua = claims.ua || FFMPEG_USER_AGENT;

    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid audio index' });
    const startOffset = Math.max(0, Number.parseFloat(req.query.start) || 0);
    const dur = Math.max(0, Number.parseFloat(req.query.dur) || 0);  // 0 = whole track
    const forceLang = /^[a-z]{2,3}$/i.test(String(req.query.lang || '')) ? String(req.query.lang).toLowerCase() : '';

    let wavPath = null;
    try {
        const e0 = Date.now();
        wavPath = await extractAudioWav(claims.url, ua, trackIndex, startOffset, dur, AUDIO_EXTRACT_TIMEOUT_MS);
        const extractMs = Date.now() - e0;
        if (!wavPath) return res.status(502).json({ error: 'Audio extraction failed' });
        let audioSec = 0;
        try { audioSec = (await fsp.stat(wavPath)).size / (16000 * 2); } catch (_) { audioSec = 0; } // 16kHz mono s16le = 32000 B/s
        const w = await runWhisperVtt(wavPath, forceLang);
        const segments = (w.vtt.match(/-->/g) || []).length;
        return res.json({
            vtt: w.vtt,
            language: w.lang,
            confidence: w.prob,
            audioSec: Math.round(audioSec),
            segments,
            extractMs,
            whisperMs: w.ms,
            rtf: audioSec > 0 ? Number((w.ms / 1000 / audioSec).toFixed(3)) : null,
        });
    } catch (err) {
        return res.status(502).json({ error: 'Transcription failed', details: String((err && err.message) || err) });
    } finally {
        if (wavPath) fsp.unlink(wavPath).catch(() => {});
    }
});

// Extract a mono/16 kHz pcm_s16le WAV of one audio track to a temp file. Resolves the path, or
// null on failure. `dur` 0 = the whole track (full-film transcription); >0 = a clip. `timeoutMs`
// defaults to 30 s (LID clip) — pass a longer value for a full-film extraction.
function extractAudioWav(url, ua, trackIndex, startOffset, dur, timeoutMs = 30_000) {
    return new Promise((resolve) => {
        const outputPath = path.join(os.tmpdir(), `norva-audio-${Date.now()}-${crypto.randomUUID()}.wav`);
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-user_agent', ua,
            '-probesize', '2000000', '-analyzeduration', '3000000',
            ...(startOffset > 0 ? ['-ss', String(startOffset)] : []),
            '-i', url,
            '-map', `0:${trackIndex}`,
            ...(dur > 0 ? ['-t', String(dur)] : []),
            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
            outputPath,
        ];
        let child;
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(url)) }); }
        catch (_) { return resolve(null); }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                console.warn(`[media-gateway] audio-extract ffmpeg exit ${code}: ${stderr.slice(-300)}`);
                fsp.unlink(outputPath).catch(() => {});
                return resolve(null);
            }
            let ok = false;
            try { ok = (await fsp.stat(outputPath)).size > 4000; } catch (_) { ok = false; }
            resolve(ok ? outputPath : null);
        });
    });
}

// Run whisper.cpp on a WAV: auto-detect language + transcribe. Resolves { text, lang, prob };
// best-effort (empties on failure). `lang`/`prob` are parsed from whisper's own LID line.
function runWhisperDetect(wavPath) {
    return new Promise((resolve) => {
        const outPrefix = wavPath.replace(/\.wav$/i, '');
        const args = [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-l', 'auto',
            '-nt',                 // no timestamps -> clean transcript
            '-otxt', '-of', outPrefix,
            '-t', String(WHISPER_THREADS),
        ];
        let child;
        try { child = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
        catch (_) { return resolve({ text: '', lang: null, prob: 0 }); }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, WHISPER_TIMEOUT_MS);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => { clearTimeout(timer); resolve({ text: '', lang: null, prob: 0 }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : null;
            const prob = m ? (Number(m[2]) || 0) : 0;
            let text = '';
            try { text = await fsp.readFile(outPrefix + '.txt', 'utf8'); } catch (_) { text = ''; }
            fsp.unlink(outPrefix + '.txt').catch(() => {});
            if (code !== 0 && !text && !lang) console.warn(`[media-gateway] whisper exit ${code}: ${stderr.slice(-300)}`);
            resolve({ text: String(text || '').trim(), lang, prob });
        });
    });
}

// Phase 3: full timestamped transcription to WebVTT. whisper.cpp emits VTT natively (-ovtt).
// Resolves { vtt, lang, prob, ms } (empties on failure). forceLang pins the source language.
function runWhisperVtt(wavPath, forceLang) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const outPrefix = wavPath.replace(/\.wav$/i, '');
        const args = [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-l', (forceLang && /^[a-z]{2,3}$/i.test(forceLang)) ? forceLang : 'auto',
            '-ovtt', '-of', outPrefix,
            '-t', String(WHISPER_THREADS),
        ];
        let child;
        try { child = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
        catch (_) { return resolve({ vtt: '', lang: null, prob: 0, ms: 0 }); }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, WHISPER_TRANSCRIBE_TIMEOUT_MS);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => { clearTimeout(timer); resolve({ vtt: '', lang: null, prob: 0, ms: Date.now() - t0 }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : (forceLang || null);
            const prob = m ? (Number(m[2]) || 0) : 0;
            let vtt = '';
            try { vtt = await fsp.readFile(outPrefix + '.vtt', 'utf8'); } catch (_) { vtt = ''; }
            fsp.unlink(outPrefix + '.vtt').catch(() => {});
            if (code !== 0 && !vtt) console.warn(`[media-gateway] whisper-vtt exit ${code}: ${stderr.slice(-300)}`);
            resolve({ vtt: String(vtt || '').trim(), lang, prob, ms: Date.now() - t0 });
        });
    });
}

// Detect the language of a (Whisper) transcript with zero dependencies. Non-Latin scripts are
// resolved by Unicode range (high confidence, incl. Persian/Kurdish/Urdu vs Arabic by the
// letters Arabic lacks, and Ukrainian/Serbian vs Russian by distinctive Cyrillic letters);
// Latin-script languages by stop-word frequency. Returns { lang, score, confident, words }.
// `confident` is conservative so the caller only enriches on a clear result.
function detectLanguageFromText(raw) {
  const text = String(raw || "").trim();
  const letters = text.replace(/[^\p{L}]/gu, "");
  const words = text.split(/\s+/).filter(Boolean);
  const out = (lang, score, confident) => ({ lang, score, confident, words: words.length });
  if (letters.length < 12) return out(null, 0, false); // script detection needs only letters

  const total = letters.length;
  const frac = (re) => (text.match(re) || []).length / total;
  const arabic = frac(/[؀-ۿݐ-ݿ]/g);
  if (arabic > 0.3) {
    // Letters Arabic does not use → Perso-Arabic family.
    const perso = /[پچژگیک]/.test(text); // pe che zhe gaf farsi-yeh keheh
    if (perso) {
      if (/[ڵەێۆڕ]/.test(text)) return out("ku", 0.8, true); // Sorani Kurdish
      if (/[ھٹڈںہ]/.test(text)) return out("ur", 0.75, true); // Urdu
      return out("fa", 0.82, true); // Persian
    }
    return out("ar", 0.85, true);
  }
  if (frac(/[֐-׿]/g) > 0.3) return out("he", 0.9, true);
  if (frac(/[Ͱ-Ͽ]/g) > 0.3) return out("el", 0.9, true);
  if (frac(/[぀-ヿ]/g) > 0.08) return out("ja", 0.9, true);
  if (frac(/[가-힯]/g) > 0.2) return out("ko", 0.9, true);
  if (frac(/[一-鿿]/g) > 0.2) return out("zh", 0.82, true);
  if (frac(/[ऀ-ॿ]/g) > 0.3) return out("hi", 0.82, true);
  if (frac(/[฀-๿]/g) > 0.3) return out("th", 0.9, true);
  if (frac(/[Ѐ-ӿ]/g) > 0.3) {
    if (/[іїєґ]/i.test(text)) return out("uk", 0.8, true);
    if (/[ђћњљџ]/i.test(text)) return out("sr", 0.75, true);
    return out("ru", 0.78, true);
  }

  // Latin script → stop-word frequency (needs whitespace-delimited words).
  if (words.length < 3) return out(null, 0, false);
  const lower = " " + text.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim() + " ";
  const STOP = {
    en: ["the", "and", "you", "that", "this", "with", "for", "are", "was", "have", "what", "not", "but"],
    fr: ["le", "la", "les", "de", "des", "un", "une", "et", "est", "que", "pas", "vous", "nous", "je", "ne", "pour", "dans"],
    es: ["el", "la", "los", "las", "de", "que", "no", "es", "un", "una", "por", "con", "para", "pero", "como", "está"],
    it: ["il", "la", "che", "di", "non", "un", "una", "per", "sono", "con", "ma", "questo", "come", "ci"],
    pt: ["o", "a", "de", "que", "não", "um", "uma", "para", "com", "você", "mais", "como", "mas", "está"],
    de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "ich", "wir", "mit", "auch", "was", "sie"],
    nl: ["de", "het", "een", "en", "ik", "je", "niet", "dat", "is", "wat", "met", "voor", "maar"],
    tr: ["bir", "bu", "ve", "için", "ben", "sen", "var", "yok", "ama", "çok", "daha", "gibi", "değil"],
    ro: ["si", "de", "la", "un", "nu", "este", "ce", "cu", "mai", "dar", "sa", "pe", "să"],
    pl: ["nie", "to", "jest", "sie", "się", "na", "że", "co", "jak", "ale", "tak", "jestem"],
    sv: ["och", "att", "det", "som", "en", "ett", "jag", "är", "inte", "har", "den", "för"],
  };
  let best = null, bestScore = 0, second = 0;
  for (const [lang, stops] of Object.entries(STOP)) {
    let hits = 0;
    for (const w of stops) if (lower.includes(" " + w + " ")) hits++;
    const score = hits / stops.length;
    if (score > bestScore) { second = bestScore; bestScore = score; best = lang; }
    else if (score > second) second = score;
  }
  const confident = bestScore >= 0.18 && (bestScore - second) >= 0.08;
  return out(best, +bestScore.toFixed(2), confident);
}

app.post('/sessions', requireGatewayAuth, async (req, res) => {
    try {
        const {
            sourceUrl,
            playbackSessionId,
            ownerKey,
            mode = 'remux',
            expiresAt,
            userAgent,
            playbackHint,
            codecProfile,
            audioCodec,
            audioProfile,
            audioChannels,
            audioStreamIndex,
            audio_stream_index,
            audioMode,
            videoCodec,
            clientAudioPassthrough,
            seekOffset,
            startOffset,
            resumeTime
        } = req.body || {};
        if (!sourceUrl || !isHttpUrl(sourceUrl)) {
            return res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
        }

        const normalizedOwnerKey = normalizeSessionKey(ownerKey);
        let stoppedConflictingSessions = 0;
        if (STOP_CONFLICTING_OWNER_SESSIONS && normalizedOwnerKey) {
            stoppedConflictingSessions += await stopConflictingOwnerSessions(normalizedOwnerKey);
        }

        if (STOP_CONFLICTING_SOURCE_SESSIONS) {
            stoppedConflictingSessions += await stopConflictingSourceSessions(sourceUrl);
        }

        if (stoppedConflictingSessions > 0 && PROVIDER_SLOT_RELEASE_DELAY_MS > 0) {
            console.log(`[media-gateway] waiting ${PROVIDER_SLOT_RELEASE_DELAY_MS}ms for provider slot release after stopping ${stoppedConflictingSessions} session(s)`);
            await sleep(PROVIDER_SLOT_RELEASE_DELAY_MS);
        }

        const id = crypto.randomUUID();
        const accessToken = randomToken();
        const outputDir = resolveSessionDir(id);
        await fsp.mkdir(outputDir, { recursive: true });
        const sourceKey = sourceSessionKey(sourceUrl);

        const expiresAtDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
        const normalizedPlaybackHint = asRecord(playbackHint);
        const normalizedSeekOffset = normalizeSeekOffset(
            seekOffset ??
            startOffset ??
            resumeTime ??
            normalizedPlaybackHint.seekOffset ??
            normalizedPlaybackHint.seek_offset ??
            normalizedPlaybackHint.startOffset ??
            normalizedPlaybackHint.start_offset ??
            normalizedPlaybackHint.resumeTime ??
            normalizedPlaybackHint.resume_time
        );
        let normalizedCodecProfile = asRecord(codecProfile || normalizedPlaybackHint.codecProfile || normalizedPlaybackHint.codec_profile);
        let codecProfileSource = hasUsefulCodecProfile(normalizedCodecProfile) ? 'request' : '';
        const shouldProbe = shouldProbeCodecProfile(normalizedPlaybackHint, sourceUrl);
        const shouldCompleteProfile = shouldProbe && shouldProbeMissingSubtitleTracks(normalizedCodecProfile, normalizedPlaybackHint, sourceUrl);
        if ((!codecProfileSource || shouldCompleteProfile) && shouldProbe) {
            try {
                const probedCodecProfile = await probeCodecProfile(sourceUrl, sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT);
                if (hasUsefulCodecProfile(probedCodecProfile)) {
                    normalizedCodecProfile = mergeCodecProfiles(normalizedCodecProfile, probedCodecProfile);
                    codecProfileSource = codecProfileSource ? `${codecProfileSource}+gateway_probe` : 'gateway_probe';
                }
            } catch (err) {
                rememberProbeFailure(err.message || String(err), sourceUrl);
                console.warn('[media-gateway] codec probe skipped:', sanitizeLog(err.message || String(err), sourceUrl));
            }
        }
        const session = {
            id,
            playbackSessionId: playbackSessionId || null,
            sourceUrl,
            sourceKey,
            ownerKey: normalizedOwnerKey,
            mode: mode === 'transcode' ? 'transcode' : 'remux',
            userAgent: sanitizeUserAgent(userAgent),
            playbackHint: normalizedPlaybackHint,
            seekOffset: normalizedSeekOffset,
            codecProfile: normalizedCodecProfile,
            codecProfileSource,
            audioCodec: stringOrNull(audioCodec) || stringOrNull(normalizedPlaybackHint.audioCodec) || stringOrNull(normalizedPlaybackHint.audio_codec) || stringOrNull(normalizedCodecProfile.audioCodec) || stringOrNull(normalizedCodecProfile.audio_codec) || stringOrNull(normalizedCodecProfile.audio),
            audioProfile: stringOrNull(audioProfile) || stringOrNull(normalizedPlaybackHint.audioProfile) || stringOrNull(normalizedPlaybackHint.audio_profile) || stringOrNull(normalizedCodecProfile.audioProfile) || stringOrNull(normalizedCodecProfile.audio_profile),
            audioChannels: nullableInt(audioChannels ?? normalizedPlaybackHint.audioChannels ?? normalizedPlaybackHint.audio_channels ?? normalizedCodecProfile.audioChannels ?? normalizedCodecProfile.audio_channels ?? normalizedCodecProfile.channels),
            audioStreamIndex: normalizeAudioStreamIndex(audioStreamIndex ?? audio_stream_index ?? normalizedPlaybackHint.audioStreamIndex ?? normalizedPlaybackHint.audio_stream_index),
            audioMode: stringOrNull(audioMode) || stringOrNull(normalizedPlaybackHint.audioMode) || stringOrNull(normalizedPlaybackHint.audio_mode),
            videoCodec: stringOrNull(videoCodec) || stringOrNull(normalizedPlaybackHint.videoCodec) || stringOrNull(normalizedPlaybackHint.video_codec) || stringOrNull(normalizedCodecProfile.videoCodec) || stringOrNull(normalizedCodecProfile.video_codec) || stringOrNull(normalizedCodecProfile.video),
            clientAudioPassthrough: clientAudioPassthrough === false || normalizedPlaybackHint.clientAudioPassthrough === false || normalizedPlaybackHint.client_audio_passthrough === false ? false : true,
            status: 'starting',
            outputDir,
            playlistPath: path.join(outputDir, 'playlist.m3u8'),
            accessToken,
            createdAt: new Date(),
            expiresAt: expiresAtDate,
            ffmpeg: null,
            lastError: null,
            logTail: ''
        };

        sessions.set(id, session);

        const hlsUrl = publicUrl(req, `/sessions/${id}/playlist.m3u8?token=${encodeURIComponent(accessToken)}`);
        const started = await startSessionWithProviderRetry(session);
        if (!started) {
            const detail = session.lastError || 'Playlist was not generated';
            rememberFailure(session, detail);
            await stopSession(session);
            return res.status(502).json({
                error: 'Failed to start media session',
                details: detail
            });
        }

        res.status(201).json({
            id,
            status: session.status,
            mode: session.mode,
            audioMode: audioModeForSession(session),
            videoMode: videoModeForSession(session),
            audioStreamIndex: session.audioStreamIndex,
            codecProfile: session.codecProfile,
            codecProfileSource: session.codecProfileSource || null,
            hlsUrl,
            expiresAt: session.expiresAt.toISOString()
        });
    } catch (err) {
        console.error('[media-gateway] create session failed:', err);
        res.status(500).json({ error: 'Failed to create media session' });
    }
});

app.get('/sessions/:id', requireGatewayAuth, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(serializeSession(req, session));
});

app.delete('/sessions/:id', requireGatewayAuth, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await stopSession(session);
    res.json({ success: true });
});

app.get('/sessions/:id/playlist.m3u8', requirePlaybackToken, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    try {
        await waitForPlaylist(session, PLAYLIST_REQUEST_TIMEOUT_MS);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const playlist = await fsp.readFile(session.playlistPath, 'utf8');
        res.send(rewritePlaylistSegments(playlist, session.accessToken));
    } catch (err) {
        const status = session.lastError ? 502 : 202;
        res.status(status).send(session.lastError || 'Playlist is not ready yet');
    }
});

app.get('/sessions/:id/:file', requirePlaybackToken, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    const requested = path.basename(req.params.file);
    const filePath = path.join(session.outputDir, requested);
    if (!isWithin(session.outputDir, filePath)) return res.status(400).send('Invalid segment path');
    if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');

    res.setHeader('Content-Type', segmentContentType(requested));
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.sendFile(filePath);
});

app.use((err, req, res, next) => {
    console.error('[media-gateway] server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

async function bootstrap() {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    app.listen(PORT, () => {
        console.log(`Norva Media Gateway listening on ${PORT}`);
        console.log(`Output directory: ${OUTPUT_DIR}`);
    });
}

function isProviderConcurrencyFailure(session) {
    const text = String((session && session.lastError) || '').toLowerCase();
    if (!text) return false;
    // The Xtream provider answers a connection it can't grant (single slot still
    // held) with 401/403, and a stale slot often surfaces as a timeout/reset.
    return text.includes('401')
        || text.includes('unauthorized')
        || text.includes('403')
        || text.includes('forbidden')
        || text.includes('connection timed out')
        || text.includes('connection reset')
        || text.includes('-10053')
        || text.includes('-10054');
}

// Start FFmpeg and wait for the first playlist. If startup fails because the
// provider's single connection slot wasn't free yet (401/403/timeout), wait for
// the slot to release and retry, instead of bubbling a 502 that pushes the web
// client into a relay/direct fallback it can never play (e.g. MKV in-browser).
async function startSessionWithProviderRetry(session) {
    const maxAttempts = 1 + PROVIDER_AUTH_RETRY_LIMIT;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) {
            await stopChildProcess(session.ffmpeg).catch(() => {});
            await removeSessionDir(session.outputDir).catch(() => {});
            await fsp.mkdir(session.outputDir, { recursive: true }).catch(() => {});
            session.status = 'starting';
            session.lastError = null;
            session.logTail = '';
        }
        session.ffmpeg = startFfmpeg(session);
        try {
            await waitForPlaylist(session, STARTUP_TIMEOUT_MS);
            if (session.status === 'starting') session.status = 'ready';
            return true;
        } catch (err) {
            if (attempt >= maxAttempts || !isProviderConcurrencyFailure(session)) return false;
            console.warn(`[media-gateway] provider slot busy for ${session.id} (attempt ${attempt}/${maxAttempts}); waiting ${PROVIDER_AUTH_RETRY_DELAY_MS}ms before retry`);
            await sleep(PROVIDER_AUTH_RETRY_DELAY_MS);
        }
    }
    return false;
}

function startFfmpeg(session) {
    const segmentPattern = path.join(session.outputDir, 'segment-%05d.ts');
    const audioArgs = audioArgsForSession(session);
    const audioMap = audioMapForSession(session);
    const inputProbeArgs = inputProbeArgsForSession(session);
    const encodeVideo = session.mode === 'transcode' || !shouldCopyVideo(session);
    const { preInputSeek, postInputSeek } = seekArgsForSession(session, encodeVideo);
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-y',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        // NOTE: deliberately NO -reconnect_on_http_error. This provider is
        // single-connection and 429s ("user_multi_ip" / rate limit) when it sees a
        // 2nd connection — retrying an HTTP error here makes ffmpeg HOLD the failing
        // connect and hammer the slot, which overlaps the next attempt and triggers
        // MORE 429s. Fast-fail instead: ffmpeg exits on the HTTP error and the
        // gateway's own startup retry (PROVIDER_AUTH_RETRY, which first evicts the
        // conflicting session and waits PROVIDER_SLOT_RELEASE_DELAY_MS) re-attempts
        // cleanly. -reconnect/-reconnect_streamed still cover mid-stream drops.
        '-reconnect_delay_max', '5',
        '-rw_timeout', '15000000',
        '-user_agent', session.userAgent || FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
        '-fflags', '+genpts',
        ...inputProbeArgs,
        ...preInputSeek,
        '-i', session.sourceUrl,
        ...postInputSeek,
        '-map', '0:v:0?',
        '-map', audioMap,
        '-max_muxing_queue_size', '1024'
    ];

    // Encode video when the session is in transcode mode OR when a remux
    // session's source video isn't browser-safe (e.g. HEVC/H.265, MPEG-2):
    // copying those into HLS yields a stream Chrome can't decode. VOD is
    // probed so the codec is known; live isn't probed, so an unknown codec
    // is trusted as copyable (the web client already routes HEVC live to
    // full transcode by channel name).
    if (encodeVideo) {
        args.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-crf', '23',
            '-g', '48',
            '-sc_threshold', '0',
            ...audioArgs
        );
    } else {
        args.push(
            '-c:v', 'copy',
            ...audioArgs
        );
    }

    args.push(
        '-fps_mode', 'passthrough',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        // EVENT playlist: a growing VOD transcode the player can seek from the
        // start. Avoids the live-edge chase that LIVE playlists trigger, and
        // ffmpeg appends #EXT-X-ENDLIST on clean completion.
        '-hls_playlist_type', 'event',
        '-hls_segment_type', 'mpegts',
        // No `append_list`: it injected a spurious leading #EXT-X-DISCONTINUITY
        // that stalled hls.js fragment indexing. `temp_file` makes each segment
        // appear in the playlist only once fully written (no partial reads).
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', segmentPattern,
        session.playlistPath
    );

    appendSubtitleOutputs(args, session, postInputSeek);

    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(session.userId || proxyKeyFromUrl(session.sourceUrl)) });
    session.status = 'starting';

    child.stderr.on('data', (chunk) => {
        const text = sanitizeLog(chunk.toString(), session.sourceUrl);
        appendLogTail(session, text);
        if (text.trim()) console.warn(`[ffmpeg:${session.id}] ${text.trim()}`);
    });

    child.on('error', (err) => {
        session.status = 'failed';
        session.lastError = err.message;
        console.error(`[ffmpeg:${session.id}] failed to start:`, err.message);
    });

    child.on('exit', (code, signal) => {
        if (session.status !== 'ended' && code !== 0) {
            session.status = 'failed';
            const reason = lastNonEmptyLine(session.logTail);
            session.lastError = `FFmpeg exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${reason ? `: ${reason}` : ''}`;
        } else if (session.status !== 'failed') {
            session.status = 'ended';
        }
    });

    waitForPlaylist(session, STARTUP_TIMEOUT_MS)
        .then(() => {
            if (session.status === 'starting') session.status = 'ready';
        })
        .catch((err) => {
            if (session.status === 'starting') {
                console.warn(`[ffmpeg:${session.id}] playlist still warming after ${STARTUP_TIMEOUT_MS}ms: ${err.message}`);
            }
        });

    return child;
}

function seekArgsForSession(session, encodeVideo) {
    const seekOffset = Number(session.seekOffset) > 0 ? Math.floor(Number(session.seekOffset)) : 0;
    if (seekOffset <= 0) return { preInputSeek: [], postInputSeek: [] };
    // Copy mode can't decode, so it must input-seek. That's fine: copy is only
    // used for browser-safe MP4, which carries a real index and seeks cleanly.
    if (!encodeVideo) {
        return { preInputSeek: ['-ss', String(seekOffset)], postInputSeek: [] };
    }
    // Encode path. The Xtream provider only honors BOUNDED HTTP Range requests
    // (`bytes=N-M`); the open-ended `bytes=N-` requests ffmpeg uses to seek are
    // answered with byte 0, so a normal seek lands on garbage and the decoder
    // emits a continuous stream of corrupt frames ("top block unavailable /
    // corrupt decoded frame" = the macroblock "saturation" users saw right
    // after Resume). Force a linear read (-seekable 0 -> no range seeks) and do
    // an ACCURATE output seek (-ss AFTER -i) to the exact target: reliable and
    // clean. Trade-off: startup scales with the resume point (linear read from
    // byte 0), so far resumes take longer to first frame.
    return { preInputSeek: ['-seekable', '0'], postInputSeek: ['-ss', String(seekOffset)] };
}

function inputProbeArgsForSession(session) {
    const live = isLiveSession(session);
    return [
        '-analyzeduration', String(live ? LIVE_INPUT_ANALYZE_DURATION_US : VOD_INPUT_ANALYZE_DURATION_US),
        '-probesize', String(live ? LIVE_INPUT_PROBE_SIZE_BYTES : VOD_INPUT_PROBE_SIZE_BYTES)
    ];
}

function isLiveSession(session) {
    const hint = asRecord(session.playbackHint);
    const type = String(hint.streamType || hint.stream_type || hint.itemType || hint.item_type || '').toLowerCase();
    if (type === 'live' || type === 'channel') return true;
    try {
        const extension = path.extname(new URL(session.sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        return extension === 'ts' || extension === 'm3u8';
    } catch (_) {
        return false;
    }
}

function audioArgsForSession(session) {
    return shouldCopyAudio(session) ? ['-c:a', 'copy'] : TRANSCODE_AUDIO_ARGS;
}

function audioModeForSession(session) {
    return shouldCopyAudio(session) ? 'copy' : 'transcode';
}

function videoModeForSession(session) {
    return (session.mode === 'transcode' || !shouldCopyVideo(session)) ? 'encode' : 'copy';
}

function appendSubtitleOutputs(args, session, postInputSeek = []) {
    const tracks = subtitleTracksForSession(session);
    if (!tracks.length) return;

    for (const track of tracks) {
        args.push(
            // Output seek is per-output: re-apply the same fine seek used for the
            // HLS output so extracted subtitles stay aligned with the seeked
            // video/audio instead of starting SEEK_DECODE_PREROLL_SECONDS early.
            ...postInputSeek,
            '-map', `0:${track.index}?`,
            '-c:s', 'webvtt',
            '-flush_packets', '1',
            '-f', 'webvtt',
            path.join(session.outputDir, `sub_${track.index}.vtt`)
        );
    }
    console.log(`[media-gateway] extracting subtitle stream(s): ${tracks.map((track) => track.index).join(', ')}`);
}

function subtitleTracksForSession(session) {
    const tracks = Array.isArray(session.codecProfile?.subtitles)
        ? session.codecProfile.subtitles
        : (Array.isArray(session.playbackHint?.subtitles) ? session.playbackHint.subtitles : []);
    const seen = new Set();

    return tracks
        .filter((track) => track && track.extractable === true && subtitleKind(track.codec) === 'text')
        .map((track) => ({ ...track, index: nullableInt(track.index) }))
        .filter((track) => {
            if (track.index === null || track.index === undefined) return false;
            if (seen.has(track.index)) return false;
            seen.add(track.index);
            return true;
        })
        .slice(0, MAX_SUBTITLE_TRACKS);
}

function shouldCopyAudio(session) {
    const requestedMode = normalizeCodecToken(session.audioMode);
    if (requestedMode === 'transcode' || requestedMode === 'encode') return false;
    if (session.clientAudioPassthrough === false) return false;

    const selectedTrack = selectedAudioTrackForSession(session);
    const codec = normalizeCodecToken(
        selectedTrack?.codec ||
        session.audioCodec ||
        session.codecProfile?.audioCodec ||
        session.codecProfile?.audio_codec ||
        session.codecProfile?.audio
    );
    const profile = normalizeCodecToken(
        session.audioProfile ||
        session.codecProfile?.audioProfile ||
        session.codecProfile?.audio_profile
    );
    const channels = nullableInt(selectedTrack?.channels ?? session.audioChannels ?? session.codecProfile?.audioChannels ?? session.codecProfile?.audio_channels ?? session.codecProfile?.channels);

    if (!codec) return false;
    if (!Number.isInteger(channels) || channels <= 0) return false;
    if (channels && channels > 2) return false;
    if (isKnownUnsafeAudio(codec, profile)) return false;
    return isKnownBrowserSafeAudio(codec, profile);
}

function shouldCopyVideo(session) {
    // Only consulted for remux sessions (transcode always encodes). Copy the
    // video stream straight into HLS only when it's a codec browsers can play
    // via MSE (H.264). Anything else (HEVC/H.265, MPEG-2, VP9, AV1, ...) must
    // be re-encoded. Unknown codec (live: not probed to respect the provider's
    // single-connection limit) is trusted as copyable — the web client already
    // routes HEVC live channels to full transcode by name.
    const codec = normalizeCodecToken(
        session.videoCodec ||
        session.codecProfile?.videoCodec ||
        session.codecProfile?.video_codec ||
        session.codecProfile?.video
    );
    if (!codec) return true;
    return isKnownBrowserSafeVideo(codec);
}

function isKnownBrowserSafeVideo(codec) {
    const normalized = normalizeCodecToken(codec);
    return normalized.includes('h264') || normalized.includes('avc');
}

function audioMapForSession(session) {
    const selectedTrack = selectedAudioTrackForSession(session);
    const selectedIndex = nullableInt(selectedTrack?.index);
    if (Number.isInteger(selectedIndex)) return `0:${selectedIndex}?`;
    if (Number.isInteger(session.audioStreamIndex)) return `0:${session.audioStreamIndex}?`;
    return '0:a:0?';
}

function selectedAudioTrackForSession(session) {
    const tracks = Array.isArray(session.codecProfile?.audioTracks)
        ? session.codecProfile.audioTracks
        : (Array.isArray(session.codecProfile?.audio_tracks) ? session.codecProfile.audio_tracks : []);
    if (!tracks.length) return null;
    if (Number.isInteger(session.audioStreamIndex)) {
        const selected = tracks.find((track) => nullableInt(track?.index) === session.audioStreamIndex);
        if (selected) return selected;
    }
    return tracks.find((track) => track?.default === true) || tracks[0] || null;
}

function isKnownBrowserSafeAudio(codec, profile) {
    const joined = `${codec} ${profile}`;
    if (hasHeAacMarker(joined)) return false;
    return (
        codec.includes('aac') ||
        codec.includes('mp4a.40.2') ||
        codec.includes('mp3') ||
        codec.includes('opus') ||
        codec.includes('vorbis')
    );
}

function isKnownUnsafeAudio(codec, profile) {
    const joined = `${codec} ${profile}`;
    return (
        hasHeAacMarker(joined) ||
        codec.includes('eac3') ||
        codec.includes('e-ac3') ||
        codec.includes('ac3') ||
        codec.includes('dts') ||
        codec.includes('truehd') ||
        codec.includes('flac') ||
        codec.includes('pcm')
    );
}

function hasHeAacMarker(value) {
    const normalized = normalizeCodecToken(value);
    return (
        normalized.includes('heaac') ||
        normalized.includes('aache') ||
        normalized.includes('sbr') ||
        normalized.includes('mp4a.40.5') ||
        normalized.includes('mp4a.40.29')
    );
}

// Map an ffprobe JSON payload (-show_streams -show_format) to the codec profile the
// rest of the gateway consumes. Shared by the provider probe and the in-band local
// header probe so both yield identical shapes (incl. per-track audio languages).
function buildCodecProfile(payload, startedAt, probeSource) {
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find((stream) => stream?.codec_type === 'video') || {};
    const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
    const subtitleStreams = streams.filter((stream) => stream?.codec_type === 'subtitle');
    const audio = audioStreams[0] || {};
    const format = asRecord(payload.format);
    return compactRecord({
        videoCodec: stringOrNull(video.codec_name),
        videoProfile: stringOrNull(video.profile),
        videoWidth: nullableInt(video.width),
        videoHeight: nullableInt(video.height),
        videoPixelFormat: stringOrNull(video.pix_fmt),
        audioCodec: stringOrNull(audio.codec_name),
        audioProfile: stringOrNull(audio.profile),
        audioChannels: nullableInt(audio.channels),
        audioChannelLayout: stringOrNull(audio.channel_layout),
        audioSampleRate: nullableInt(audio.sample_rate),
        audioTracks: audioStreams.map((stream, order) => compactRecord({
            index: nullableInt(stream.index),
            order,
            language: streamLanguage(stream),
            title: streamTitle(stream, `Audio ${order + 1}`),
            codec: stringOrNull(stream.codec_name),
            channels: nullableInt(stream.channels),
            default: stream.disposition?.default === 1
        })),
        subtitles: subtitleStreams.map((stream, order) => {
            const codec = stringOrNull(stream.codec_name);
            const subtitleType = subtitleKind(codec);
            const extractable = subtitleType === 'text';
            return compactRecord({
                index: nullableInt(stream.index),
                order,
                language: streamLanguage(stream),
                title: streamTitle(stream, `Subtitle ${order + 1}`),
                codec,
                subtitleType,
                extractable,
                burnInRequired: subtitleType === 'image',
                unsupportedReason: extractable
                    ? null
                    : (subtitleType === 'image'
                        ? 'Image subtitles require burn-in video transcoding'
                        : `Unsupported subtitle codec: ${codec || 'unknown'}`)
            });
        }),
        container: stringOrNull(format.format_name),
        durationSeconds: nullableFloat(format.duration),
        bitRate: nullableInt(format.bit_rate),
        probeSource: probeSource || 'gateway_probe',
        probeMs: Math.max(1, Date.now() - startedAt),
        probedAt: new Date().toISOString()
    });
}

// Store a successful profile in the codec-profile cache (TTL + size cap). No-op for
// empty/failed profiles, so a transient probe failure still retries next time.
function cacheCodecProfile(sourceUrl, profile) {
    if (CODEC_PROFILE_CACHE_TTL_MS <= 0 || !sourceUrl || !hasUsefulCodecProfile(profile)) return;
    codecProfileCache.set(sourceUrl, { profile, expiresAt: Date.now() + CODEC_PROFILE_CACHE_TTL_MS });
    // Bound memory: Map preserves insertion order, so the first key is the oldest.
    while (CODEC_PROFILE_CACHE_MAX > 0 && codecProfileCache.size > CODEC_PROFILE_CACHE_MAX) {
        const oldest = codecProfileCache.keys().next().value;
        if (oldest === undefined) break;
        codecProfileCache.delete(oldest);
    }
}

// Run ffprobe on the in-band-captured leading bytes (a local temp file) so we learn the
// track languages WITHOUT a provider connection. Returns a useful profile or null (caller
// then falls back to the provider probe — e.g. an MP4 whose moov sits at the end, so the
// leading bytes don't parse). Best-effort; never throws.
async function probeFromHeaderBytes(sourceUrl) {
    const entry = headerByteCache.get(sourceUrl);
    if (!entry || entry.len <= 0) return null;
    // Need a meaningful header slice: a completed capture, or at least 256 KB so far.
    if (!entry.done && entry.len < 256_000) return null;
    const buf = Buffer.concat(entry.chunks, entry.len);
    const tmpFile = path.join(OUTPUT_DIR, `hdr-${crypto.randomBytes(8).toString('hex')}.bin`);
    const startedAt = Date.now();
    try {
        await fsp.mkdir(OUTPUT_DIR, { recursive: true });
        await fsp.writeFile(tmpFile, buf);
        const args = [
            '-v', 'error',
            '-analyzeduration', String(CODEC_PROBE_ANALYZE_DURATION_US),
            '-probesize', String(Math.min(buf.length, CODEC_PROBE_SIZE_BYTES)),
            '-show_streams',
            '-show_format',
            '-print_format', 'json',
            tmpFile
        ];
        const payload = await runFfprobe(args, CODEC_PROBE_TIMEOUT_MS, sourceUrl);
        const profile = buildCodecProfile(payload, startedAt, 'gateway_inband');
        return hasUsefulCodecProfile(profile) ? profile : null;
    } catch (_) {
        return null;
    } finally {
        fsp.unlink(tmpFile).catch(() => {});
    }
}

// Cached front for probeCodecProfileUncached. Resolution order, cheapest first:
//   1. codec-profile cache (memory, no work)              -> probeStats.cacheHits
//   2. in-band header bytes tee'd from /raw (local probe) -> probeStats.inbandHits, ZERO provider conn
//   3. provider probe (opens a connection)                -> probeStats.successes
// A successful profile for a source URL is reused for CODEC_PROFILE_CACHE_TTL_MS. Failures
// and empty profiles are NOT cached, so a transient refusal retries on the next call.
async function probeCodecProfile(sourceUrl, userAgent) {
    if (CODEC_PROFILE_CACHE_TTL_MS > 0 && sourceUrl) {
        const hit = codecProfileCache.get(sourceUrl);
        if (hit) {
            if (hit.expiresAt > Date.now()) {
                probeStats.cacheHits += 1;
                return hit.profile;
            }
            codecProfileCache.delete(sourceUrl); // expired
        }
    }
    if (INBAND_HEADER_PARSE && sourceUrl) {
        try {
            const local = await probeFromHeaderBytes(sourceUrl);
            if (local && hasUsefulCodecProfile(local)) {
                probeStats.inbandHits += 1;
                cacheCodecProfile(sourceUrl, local);
                headerByteCache.delete(sourceUrl); // header no longer needed
                return local;
            }
        } catch (_) { /* fall back to the provider probe */ }
    }
    const profile = await probeCodecProfileUncached(sourceUrl, userAgent);
    cacheCodecProfile(sourceUrl, profile);
    return profile;
}

async function probeCodecProfileUncached(sourceUrl, userAgent) {
    const startedAt = Date.now();
    probeStats.attempts += 1;
    const args = [
        '-v', 'error',
        '-rw_timeout', '8000000',
        '-user_agent', userAgent || FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
        '-analyzeduration', String(CODEC_PROBE_ANALYZE_DURATION_US),
        '-probesize', String(CODEC_PROBE_SIZE_BYTES),
        '-show_streams',
        '-show_format',
        '-print_format', 'json',
        sourceUrl
    ];

    const payload = await runFfprobe(args, CODEC_PROBE_TIMEOUT_MS, sourceUrl);
    const profile = buildCodecProfile(payload, startedAt, 'gateway_probe');
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
    const subtitleStreams = streams.filter((stream) => stream?.codec_type === 'subtitle');
    if (hasUsefulCodecProfile(profile)) {
        probeStats.successes += 1;
        probeStats.last = compactRecord({
            ok: true,
            streamCount: streams.length,
            videoCount: streams.filter((stream) => stream?.codec_type === 'video').length,
            audioCount: audioStreams.length,
            subtitleCount: subtitleStreams.length,
            extractableSubtitleCount: profile.subtitles.filter((track) => track.extractable === true).length,
            probeMs: profile.probeMs,
            time: profile.probedAt
        });
        return profile;
    }

    probeStats.empty += 1;
    probeStats.last = {
        ok: false,
        reason: 'empty_profile',
        streamCount: streams.length,
        probeMs: Math.max(1, Date.now() - startedAt),
        time: new Date().toISOString()
    };
    return {};
}

function rememberProbeFailure(detail, sourceUrl) {
    probeStats.failures += 1;
    probeStats.lastFailure = {
        detail: sanitizeLog(detail || 'Codec probe failed', sourceUrl).slice(0, 1000),
        time: new Date().toISOString()
    };
    probeStats.last = {
        ok: false,
        reason: 'probe_failed',
        time: probeStats.lastFailure.time
    };
}

function streamLanguage(stream) {
    const tags = asRecord(stream?.tags);
    return stringOrNull(tags.language || tags.LANGUAGE || tags.lang || tags.LANG);
}

function streamTitle(stream, fallback) {
    const tags = asRecord(stream?.tags);
    return stringOrNull(tags.title || tags.TITLE || tags.handler_name || tags.HANDLER_NAME) || fallback;
}

function subtitleKind(codec) {
    const normalized = normalizeCodecToken(codec);
    if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'movtext', 'text'].includes(normalized)) return 'text';
    if (['hdmvpgssubtitle', 'dvdsubtitle', 'dvbsubtitle', 'xsub'].includes(normalized)) return 'image';
    return normalized ? 'unknown' : '';
}

function runFfprobe(args, timeoutMs, sourceUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(FFPROBE_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let finished = false;
        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill('SIGTERM');
            reject(new Error('Codec probe timeout'));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
        });
        child.stderr.on('data', (chunk) => {
            stderr += sanitizeLog(chunk.toString(), sourceUrl);
            if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
        });
        child.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code, signal) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Codec probe exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${stderr ? `: ${lastNonEmptyLine(stderr)}` : ''}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout || '{}'));
            } catch (err) {
                reject(new Error(`Codec probe returned invalid JSON: ${err.message}`));
            }
        });
    });
}

function hasUsefulCodecProfile(profile) {
    const record = asRecord(profile);
    return Boolean(
        stringOrNull(record.videoCodec) ||
        stringOrNull(record.video_codec) ||
        stringOrNull(record.video) ||
        stringOrNull(record.audioCodec) ||
        stringOrNull(record.audio_codec) ||
        stringOrNull(record.audio) ||
        (Array.isArray(record.audioTracks) && record.audioTracks.length > 0) ||
        (Array.isArray(record.audio_tracks) && record.audio_tracks.length > 0) ||
        (Array.isArray(record.subtitles) && record.subtitles.length > 0) ||
        (Array.isArray(record.subtitleTracks) && record.subtitleTracks.length > 0) ||
        (Array.isArray(record.subtitle_tracks) && record.subtitle_tracks.length > 0)
    );
}

function mergeCodecProfiles(baseProfile, probeProfile) {
    const base = asRecord(baseProfile);
    const probe = asRecord(probeProfile);
    return compactRecord({
        ...base,
        ...probe,
        audioTracks: Array.isArray(probe.audioTracks) && probe.audioTracks.length ? probe.audioTracks : base.audioTracks,
        subtitles: Array.isArray(probe.subtitles) && probe.subtitles.length ? probe.subtitles : base.subtitles,
    });
}

function shouldProbeMissingSubtitleTracks(profile, playbackHint, sourceUrl) {
    const record = asRecord(profile);
    if (
        (Array.isArray(record.subtitles) && record.subtitles.length > 0) ||
        (Array.isArray(record.subtitleTracks) && record.subtitleTracks.length > 0) ||
        (Array.isArray(record.subtitle_tracks) && record.subtitle_tracks.length > 0)
    ) return false;

    const hint = asRecord(playbackHint);
    const streamType = String(hint.streamType || hint.stream_type || hint.itemType || hint.item_type || '').toLowerCase();
    if (streamType === 'live' || streamType === 'channel') return false;

    const container = String(hint.container || record.container || '').toLowerCase();
    if (['mkv', 'webm', 'avi'].includes(container)) return true;

    try {
        const extension = path.extname(new URL(sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        return ['mkv', 'webm', 'avi'].includes(extension);
    } catch (_) {
        return streamType === 'series' || streamType === 'movie';
    }
}

function shouldProbeCodecProfile(playbackHint, sourceUrl) {
    const hint = asRecord(playbackHint);
    const streamType = String(hint.streamType || hint.stream_type || hint.itemType || hint.item_type || '').toLowerCase();
    if (streamType === 'live' || streamType === 'channel') return false;
    const container = String(hint.container || '').toLowerCase();
    if (container === 'm3u8' || container === 'ts') return false;
    try {
        const extension = path.extname(new URL(sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        if (extension === 'm3u8' || extension === 'ts') return false;
        return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'mpeg', 'mpg', 'vob'].includes(extension) || streamType === 'movie' || streamType === 'series';
    } catch (_) {
        return streamType === 'movie' || streamType === 'series';
    }
}

async function waitForPlaylist(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (session.lastError) throw new Error(session.lastError);
        if (fs.existsSync(session.playlistPath)) return;
        await sleep(250);
    }
    throw new Error('Playlist timeout');
}

async function stopSession(session) {
    if (session.stoppingPromise) return session.stoppingPromise;

    session.status = 'stopping';
    session.stoppingPromise = (async () => {
        const child = session.ffmpeg;
        session.ffmpeg = null;
        await stopChildProcess(child);
        session.status = 'ended';
        sessions.delete(session.id);
        await removeSessionDir(session.outputDir);
    })();

    return session.stoppingPromise;
}

async function stopConflictingSourceSessions(sourceUrl) {
    const sourceKey = sourceSessionKey(sourceUrl);
    if (!sourceKey) return 0;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.sourceKey !== sourceKey) return false;
        return isSessionBlockingProviderSlot(session);
    });

    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same source: ${session.id}`);
        await stopSession(session);
    }));
    return conflicts.length;
}

async function stopConflictingOwnerSessions(ownerKey) {
    const normalizedOwnerKey = normalizeSessionKey(ownerKey);
    if (!normalizedOwnerKey) return 0;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.ownerKey !== normalizedOwnerKey) return false;
        return isSessionBlockingProviderSlot(session);
    });

    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same owner: ${session.id}`);
        await stopSession(session);
    }));
    return conflicts.length;
}

function activeSessionCount() {
    return Array.from(sessions.values())
        .filter((session) => session.status === 'starting' || session.status === 'ready')
        .length;
}

function isSessionBlockingProviderSlot(session) {
    return session?.status === 'starting' || session?.status === 'ready' || session?.status === 'stopping';
}

function stopChildProcess(child, timeoutMs = 2500) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.signalCode) {
            resolve();
            return;
        }

        let done = false;
        let killTimer = null;
        const finish = () => {
            if (done) return;
            done = true;
            if (killTimer) clearTimeout(killTimer);
            child.off('exit', finish);
            child.off('error', finish);
            resolve();
        };
        killTimer = setTimeout(() => {
            if (!done) {
                try { child.kill('SIGKILL'); } catch (_) { }
            }
        }, timeoutMs);

        child.once('exit', finish);
        child.once('error', finish);
        try {
            child.kill('SIGTERM');
        } catch (_) {
            finish();
        }
    });
}

function normalizeSessionKey(value) {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

async function removeSessionDir(dir) {
    const resolved = path.resolve(dir);
    if (!isWithin(OUTPUT_DIR, resolved) || resolved === OUTPUT_DIR) return;
    await fsp.rm(resolved, { recursive: true, force: true });
}

function requireGatewayAuth(req, res, next) {
    if (!GATEWAY_TOKEN) {
        return res.status(503).json({ error: 'Gateway token is not configured' });
    }
    const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token || !timingSafeEqual(token, GATEWAY_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requirePlaybackToken(req, res, next) {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    if (session.expiresAt.getTime() < Date.now()) {
        stopSession(session).catch((err) => console.error('[media-gateway] cleanup failed:', err));
        return res.status(410).send('Session expired');
    }
    const token = req.query.token || '';
    if (!token || !timingSafeEqual(String(token), session.accessToken)) {
        return res.status(401).send('Unauthorized');
    }
    next();
}

function cors(req, res, next) {
    const allowed = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const origin = req.headers.origin;
    if (origin && (allowed.includes('*') || allowed.includes(origin) || isLocalOrigin(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (allowed[0]) {
        res.setHeader('Access-Control-Allow-Origin', allowed[0]);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
    res.setHeader('Vary', 'Origin');
    next();
}

function serializeSession(req, session) {
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: session.audioStreamIndex,
        codecProfile: session.codecProfile,
        codecProfileSource: session.codecProfileSource || null,
        hlsUrl: publicUrl(req, `/sessions/${session.id}/playlist.m3u8?token=${encodeURIComponent(session.accessToken)}`),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: session.logTail
    };
}

function debugSession(session) {
    const selectedTrack = selectedAudioTrackForSession(session);
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: session.audioStreamIndex,
        audioMap: audioMapForSession(session),
        audioCodec: session.audioCodec,
        audioChannels: session.audioChannels,
        selectedAudioTrack: selectedTrack
            ? {
                index: nullableInt(selectedTrack.index),
                language: selectedTrack.language || null,
                title: selectedTrack.title || null,
                codec: selectedTrack.codec || null,
                channels: nullableInt(selectedTrack.channels),
                default: selectedTrack.default === true
            }
            : null,
        codecProfileSource: session.codecProfileSource || null,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: String(session.logTail || '').slice(-1200)
    };
}

function publicUrl(req, pathname) {
    if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}${pathname}`;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}${pathname}`;
}

function resolveSessionDir(id) {
    const dir = path.resolve(OUTPUT_DIR, id);
    if (!isWithin(OUTPUT_DIR, dir)) throw new Error('Invalid session directory');
    return dir;
}

function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// Verify a byte-pipe token: `base64url(payload).base64url(HMAC-SHA256(payload,
// secret))`. Same format the playback function signs (with the shared gateway
// token as the key). Returns the claims object, or null if invalid.
function verifyRawToken(token, secret) {
    try {
        if (!secret) return null;
        const [payloadPart, signaturePart] = String(token).split('.');
        if (!payloadPart || !signaturePart) return null;
        const payload = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        if (!timingSafeEqual(signaturePart, expected)) return null;
        const claims = JSON.parse(payload);
        if (!claims || claims.v !== 1 || !claims.url || !claims.exp) return null;
        if (!isHttpUrl(claims.url)) return null;
        return claims;
    } catch (_) {
        return null;
    }
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function xtreamPlayerApiUrl({ serverUrl, username, password, action, streamId, limit, params }) {
    const url = new URL(`${String(serverUrl).replace(/\/+$/, '')}/player_api.php`);
    url.searchParams.set('username', String(username));
    url.searchParams.set('password', String(password));
    // Empty action → bare player_api.php (the account-info / credential-validation
    // call). Every other caller passes a real action, so behaviour is unchanged.
    if (action) url.searchParams.set('action', String(action));
    if (streamId !== undefined && streamId !== null && String(streamId) !== '') {
        url.searchParams.set('stream_id', String(streamId));
    }
    if (limit) url.searchParams.set('limit', String(limit));
    // Action-specific params (e.g. series_id for get_series_info, vod_id for
    // get_vod_info). Only the caller's whitelisted keys reach the provider.
    if (params && typeof params === 'object') {
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || String(value) === '') continue;
            url.searchParams.set(key, String(value));
        }
    }
    return url.href;
}

async function fetchProviderJson(url, userAgent, timeoutMs = XTREAM_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            dispatcher: pickProxyAgent(proxyKeyFromUrl(url)) || undefined,
            headers: {
                'Accept': 'application/json,text/plain,*/*',
                'User-Agent': userAgent
            }
        });
        const text = await response.text();
        const payload = text ? safeJson(text) : {};
        if (!response.ok) {
            const failure = classifyProviderFailure(response.status, payload);
            const error = new Error(failure.publicMessage);
            error.status = failure.status;
            error.publicMessage = failure.publicMessage;
            error.code = failure.code;
            error.details = payload;
            throw error;
        }
        return payload;
    } catch (err) {
        if (err.status) throw err;
        const error = new Error('Unable to reach IPTV provider');
        error.status = err.name === 'AbortError' ? 504 : 502;
        error.publicMessage = 'Unable to reach IPTV provider';
        error.details = err.message;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return { raw: String(text || '').slice(0, 2000) };
    }
}

function classifyProviderFailure(status, payload) {
    const text = JSON.stringify(payload || {}).toLowerCase();
    if (/user[_\s-]*multi[_\s-]*ip|multi[_\s-]*ip|max(?:imum)? connections?|active connections?|connection limit|same account.*ip|account sharing/.test(text)) {
        return {
            status: 429,
            code: 'PROVIDER_MULTI_IP',
            publicMessage: 'IPTV provider refused the account because it already sees one active connection. Stop all other playback attempts, wait 1–2 minutes, then retry from one device.'
        };
    }
    if (status === 429 || /too many requests|rate limit|ratelimit/.test(text)) {
        return {
            status: 429,
            code: 'PROVIDER_RATE_LIMIT',
            publicMessage: 'IPTV provider is rate limiting this account. Wait a moment, then retry.'
        };
    }
    return {
        status,
        code: 'PROVIDER_REQUEST_FAILED',
        publicMessage: 'IPTV provider request failed'
    };
}

function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringOrNull(value) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    return null;
}

function nullableInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAudioStreamIndex(value) {
    const parsed = nullableInt(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1024) return null;
    return parsed;
}

function nullableFloat(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSeekOffset(value) {
    const parsed = nullableFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.max(0, Math.min(Math.floor(parsed), 24 * 60 * 60));
}

function compactRecord(record) {
    return Object.fromEntries(Object.entries(asRecord(record)).filter(([, value]) => (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(typeof value === 'number' && !Number.isFinite(value))
    )));
}

function normalizeCodecToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
}

function sanitizeUserAgent(value) {
    if (typeof value !== 'string') return null;
    // Strip control chars (incl. CR/LF) so the value cannot inject extra
    // FFmpeg header lines, then cap length defensively.
    const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!cleaned) return null;
    return cleaned.slice(0, 256);
}

function sourceSessionKey(value) {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const folder = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';
        const identity = `${url.origin}/${folder}/${username}/${password}`;
        return crypto.createHash('sha256').update(identity).digest('hex');
    } catch (_) {
        return '';
    }
}

function segmentContentType(file) {
    if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    if (file.endsWith('.m4s')) return 'video/iso.segment';
    if (file.endsWith('.mp4')) return 'video/mp4';
    if (file.endsWith('.aac')) return 'audio/aac';
    return 'video/mp2t';
}

function appendLogTail(session, text) {
    session.logTail = `${session.logTail || ''}${text}`.slice(-MAX_LOG_TAIL);
}

function rememberFailure(session, detail) {
    lastFailures.push({
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        mode: session.mode,
        status: session.status,
        detail: String(detail || '').slice(0, 1000),
        logTail: String(session.logTail || '').slice(-2000),
        time: new Date().toISOString()
    });
    while (lastFailures.length > 10) lastFailures.shift();
}

function rewritePlaylistSegments(playlist, token) {
    const encodedToken = encodeURIComponent(token);
    return String(playlist || '')
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#EXT-X-MAP')) {
                return line.replace(/URI="([^"]+)"/i, (_match, uri) => `URI="${appendToken(uri, encodedToken)}"`);
            }
            if (trimmed.startsWith('#')) return line;
            if (/^https?:\/\//i.test(trimmed)) return appendToken(trimmed, encodedToken);
            return appendToken(trimmed, encodedToken);
        })
        .join('\n');
}

function appendToken(uri, encodedToken) {
    if (/[?&]token=/.test(uri)) return uri;
    return `${uri}${uri.includes('?') ? '&' : '?'}token=${encodedToken}`;
}

function sanitizeLog(text, sourceUrl) {
    let safe = String(text || '');
    try {
        const parsed = new URL(sourceUrl);
        safe = safe.replaceAll(sourceUrl, `${parsed.origin}/<redacted>`);
        for (const part of parsed.pathname.split('/').filter(Boolean)) {
            if (part.length >= 4) safe = safe.replaceAll(part, '<redacted>');
        }
        for (const [key, value] of parsed.searchParams.entries()) {
            if (value) safe = safe.replaceAll(value, '<redacted>');
            safe = safe.replaceAll(key, '<redacted>');
        }
    } catch (_) {
        safe = safe.replace(/https?:\/\/\S+/g, '<redacted-url>');
    }
    return safe;
}

function lastNonEmptyLine(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0] || '';
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalOrigin(origin) {
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch (_) {
        return false;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
        if (session.expiresAt.getTime() < now) {
            stopSession(session).catch((err) => console.error('[media-gateway] cleanup failed:', err));
        }
    }
    // Purge expired codec-profile cache entries (read-path also evicts lazily).
    for (const [key, entry] of codecProfileCache) {
        if (entry.expiresAt <= now) codecProfileCache.delete(key);
    }
    // Purge stale in-band header buffers (only needed transiently around playback start).
    if (INBAND_HEADER_TTL_MS > 0) {
        for (const [key, entry] of headerByteCache) {
            if (now - entry.updatedAt >= INBAND_HEADER_TTL_MS) headerByteCache.delete(key);
        }
    }
}, 60 * 1000).unref();

bootstrap().catch((err) => {
    console.error('[media-gateway] bootstrap failed:', err);
    process.exit(1);
});
