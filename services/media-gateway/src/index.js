const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { parseWhisperLid, runWhisperDetectOnly } = require('./whisper-lid');

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
// ── Raw byte-pipe ledger ─────────────────────────────────────────────────────
// One playback session per provider account: pumps are tagged with their playback
// session id (claims.sid). A NEW session's first /raw aborts pumps left by a PRIOR
// session on the same account (an engine crash/retry leaves the old pump draining —
// exactly what keeps a single-slot provider answering 458), a conflicting transcode
// start aborts them all, and the relay's session coordinator can evict them
// cross-device via DELETE /raw-pumps (keyed by sha256(userId) — no credentials).
const rawPumps = new Set(); // { ac, sid, proxyKey, ownerHash }

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
function registerRawPump(entry) {
    rawPumps.add(entry);
    return entry;
}
function releaseRawPump(entry) {
    rawPumps.delete(entry);
}
// Abort pumps matching `filter`, sparing `keepSid` (legitimate concurrent range
// reads within the SAME playback session must survive).
function abortRawPumps(filter, keepSid, reason) {
    let aborted = 0;
    for (const pump of [...rawPumps]) {
        if (!filter(pump)) continue;
        if (keepSid && pump.sid && pump.sid === keepSid) continue;
        try { pump.ac.abort(); } catch (_) { /* already gone */ }
        rawPumps.delete(pump);
        aborted += 1;
    }
    if (aborted) console.log(`[media-gateway] aborted ${aborted} stale raw pump(s) — ${reason}`);
    return aborted;
}

// ── Background-extraction ledger (viewer preemption) ─────────────────────────
// Every provider-connected background ffmpeg (whisper extraction, storyboard, LID clip) registers
// here keyed by the provider ACCOUNT (proxyKeyFromUrl). A viewer pressing play on the same
// account preempts them: the viewer outranks any background job, and on a single-slot panel the
// two connections otherwise fight for minutes (the viewer eats 458s while the extraction reads
// the whole film). Preempted jobs re-queue as 'deferred' — they resume once the viewer stops.
const accountExtractions = new Map(); // proxyKey -> Set<{ child, preempted, reportActivity }>
function registerAccountExtraction(proxyKey, child, reportActivity = true) {
    const entry = { child, preempted: false, reportActivity };
    if (!proxyKey) return entry;
    let set = accountExtractions.get(proxyKey);
    if (!set) { set = new Set(); accountExtractions.set(proxyKey, set); }
    set.add(entry);
    entry.release = () => { set.delete(entry); if (!set.size) accountExtractions.delete(proxyKey); };
    return entry;
}
function preemptAccountExtractions(proxyKey, reason) {
    const set = accountExtractions.get(proxyKey);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const entry of [...set]) {
        entry.preempted = true;
        try { entry.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        n += 1;
    }
    if (n) console.log(`[media-gateway] preempted ${n} background extraction(s) — ${reason}`);
    return n;
}
// True while THIS box holds the account's provider slot for a viewer: a live transcode session
// or an engine /raw byte-pump. Checked before the edge pregen-gate — it is instant, and it sees
// what the edge can't (a paused viewer whose ffmpeg is still transcoding, a mid-film raw pump).
function accountSlotBusyLocally(url) {
    const key = proxyKeyFromUrl(url || '');
    if (!key) return false;
    for (const s of sessions.values()) {
        if (s && s.sourceUrl && proxyKeyFromUrl(s.sourceUrl) === key && isSessionBlockingProviderSlot(s)) return true;
    }
    for (const p of rawPumps) { if (p && p.proxyKey === key) return true; }
    return false;
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
// Xtream URLs embed credentials in the path (/movie/USER/PASS/id.ext) and in query params
// (username=…&password=…). Any error string that may quote a provider URL (ffmpeg stderr)
// MUST pass through here before leaving the process — job-callback errors land verbatim in
// the DB and the admin UI.
function redactCreds(s) {
    return String(s || '')
        .replace(/\/(movie|series|live)\/[^/\s]+\/[^/\s]+\//gi, '/$1/***/***/')
        .replace(/(username|password)=[^&\s'"]+/gi, '$1=***');
}

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.NORVA_MEDIA_GATEWAY_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// Backend origins the async jobs may call back / upload to. Historically only the
// managed *.supabase.co project was accepted; the self-host cutover moved the API
// to its own origin, so the allowlist is env-extensible (comma-separated) with
// api.norva.tv as the default and supabase.co kept for the rollback window. The
// check is what stops a forged enqueue from pointing callbacks at an attacker host.
const BACKEND_ORIGINS = String(process.env.NORVA_BACKEND_ORIGINS || 'https://api.norva.tv')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
function isBackendUrl(url, pathPrefix = '/') {
    const s = String(url || '');
    const managed = s.match(/^https:\/\/[^/]+\.supabase\.co(\/.*)$/);
    if (managed) return managed[1].startsWith(pathPrefix);
    return BACKEND_ORIGINS.some((origin) => s.startsWith(origin + pathPrefix));
}
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
const WHISPER_MODEL_NAME = process.env.WHISPER_MODEL_NAME || (() => {
    try { return fs.readFileSync('/opt/whisper/model-name', 'utf8').trim(); }
    catch (_) { return path.basename(WHISPER_MODEL || '') || null; }
})();
const WHISPER_CPP_COMMIT = process.env.WHISPER_CPP_COMMIT || null;
const WHISPER_BIN_BUILD_SHA256 = readBuildDigest('/opt/whisper/bin.sha256');
const WHISPER_MODEL_BUILD_SHA256 = readBuildDigest('/opt/whisper/model.sha256');
let WHISPER_BIN_SHA256 = null;
let WHISPER_MODEL_SHA256 = null;
let WHISPER_RUNTIME_VERIFIED = false;
const WHISPER_THREADS = clampInt(process.env.WHISPER_THREADS, 4, 1, 16);
const WHISPER_TIMEOUT_MS = clampInt(process.env.WHISPER_TIMEOUT_MS, 60_000, 5_000, 300_000);
const LID_BENCHMARK_INSTANCE = process.env.RAILWAY_REPLICA_ID || crypto.randomUUID();
let lidBenchmarkBusy = false;
let whisperInferenceActive = 0;
let argosInferenceActive = 0;
// Bounded mid-film sweep for language detection: a film opens with logos/silence/music, so
// sampling at offset 0 detects nothing. Try these offsets (seconds) in order and stop at the
// first clip with real speech; a clip past the file's end yields no WAV and is skipped. Bounded
// (≤ length) so it never hammers a single-connection provider. Override via WHISPER_SWEEP_OFFSETS.
const WHISPER_SWEEP_OFFSETS = (process.env.WHISPER_SWEEP_OFFSETS || '600,1500,300')
    .split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
// A language shown as verified in Norva is held to a materially stronger contract than the
// best-effort LID endpoint used during development. Four separated, information-rich speech
// windows must agree unanimously. Extra fallback windows let silence/credits or a late offset
// fail without weakening the four-sample requirement. The edge persists only `verified: true`.
const WHISPER_STRICT_OFFSETS = [
    ...new Set((process.env.WHISPER_STRICT_OFFSETS || '180,600,1200,2400,60,3000')
        .split(',').map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0)),
];
const WHISPER_STRICT_CONSENSUS = 4;
const WHISPER_STRICT_MIN_PROBABILITY = Math.min(
    0.999,
    Math.max(0.95, Number(process.env.WHISPER_STRICT_MIN_PROBABILITY) || 0.95),
);
const WHISPER_STRICT_MIN_WORDS = clampInt(process.env.WHISPER_STRICT_MIN_WORDS, 12, 12, 40);
const WHISPER_STRICT_MIN_UNIQUE_WORDS = clampInt(
    process.env.WHISPER_STRICT_MIN_UNIQUE_WORDS,
    8,
    8,
    30,
);
// Full transcription (Phase 3) runs whisper on a whole film → much longer than the 20s LID clip.
// This flat value is a FLOOR: the effective budget adapts to the WAV's real duration (see
// whisperBudgetMs) because a long film at a flat 20 min was mathematically guaranteed to be
// SIGKILLed with zero output (both 07-02 "Transcription produced no output" failures).
const WHISPER_TRANSCRIBE_TIMEOUT_MS = clampInt(process.env.WHISPER_TRANSCRIBE_TIMEOUT_MS, 1_200_000, 30_000, 7_200_000);
// Adaptive budget: measured RTF on this box is ~0.09-0.15 (8-13 min of whisper for 5 342-6 360 s
// of audio) → 0.5×duration gives 3-5× headroom while still bounding a hung run. pcm_s16le
// 16 kHz mono = 32 000 bytes/second, so duration comes free from the WAV size.
const WHISPER_RTF_BUDGET = Math.min(Math.max(Number(process.env.WHISPER_RTF_BUDGET) || 0.5, 0.2), 3);
function whisperBudgetMs(audioSec) {
    if (!Number.isFinite(audioSec) || audioSec <= 0) return WHISPER_TRANSCRIBE_TIMEOUT_MS;
    return Math.max(WHISPER_TRANSCRIBE_TIMEOUT_MS, Math.round(audioSec * WHISPER_RTF_BUDGET * 1000));
}
const AUDIO_EXTRACT_TIMEOUT_MS = clampInt(process.env.AUDIO_EXTRACT_TIMEOUT_MS, 1_800_000, 30_000, 7_200_000);
// Job-level extraction retry (mirrors the OCR extractors' d7cdbce pattern): a transient slot
// refusal (a 3s relay probe holding the panel) becomes recoverable instead of burning the job
// for 24h. LONG spaced backoff, never a burst, and a 401/403 abuse block is NOT retried —
// backing off entirely is the only safe move on a panel's anti-abuse.
const AUDIO_EXTRACT_RETRIES = clampInt(process.env.AUDIO_EXTRACT_RETRIES, 2, 0, 5);
const AUDIO_EXTRACT_BACKOFF_MS = clampInt(process.env.AUDIO_EXTRACT_BACKOFF_MS, 30_000, 5_000, 300_000);
// Phase 3b — offline subtitle translation (Argos / CTranslate2 models, see src/translate.py).
// ARGOS_PYTHON_BIN runs the bundled script against models under ARGOS_MODELS_DIR; an empty/missing
// models dir disables the /translate* endpoints. Pure CPU on a cached VTT — no provider connection.
const ARGOS_MODELS_DIR = process.env.ARGOS_MODELS_DIR || '/opt/argos-models';
const ARGOS_PYTHON_BIN = process.env.ARGOS_PYTHON_BIN || '/opt/argos-venv/bin/python3';
const ARGOS_TRANSLATE_SCRIPT = path.join(__dirname, 'translate.py');
const ARGOS_TRANSLATE_TIMEOUT_MS = clampInt(process.env.ARGOS_TRANSLATE_TIMEOUT_MS, 600_000, 30_000, 3_600_000);
const MAX_TRANSLATE_QUEUE = clampInt(process.env.MAX_TRANSLATE_QUEUE, 100, 1, 1000);
const argosHasPair = (a, b) => {
    try { return fs.existsSync(path.join(ARGOS_MODELS_DIR, `${a}_${b}`, 'model', 'model.bin')); } catch (_) { return false; }
};
// Scan the models dir once at boot for the count of installed pairs (→ /health + enable flag).
function scanArgosPairs() {
    let pairs = 0;
    try {
        for (const name of fs.readdirSync(ARGOS_MODELS_DIR)) {
            if (/^[a-z]{2,3}_[a-z]{2,3}$/.test(name) && argosHasPair(...name.split('_'))) pairs++;
        }
    } catch (_) { /* dir missing → translation disabled */ }
    return pairs;
}
const ARGOS_ENABLED = scanArgosPairs() > 0;
// Servable when there's a direct model or an English pivot (source->en->target).
function argosCanServe(source, target) {
    if (!ARGOS_ENABLED || !/^[a-z]{2,3}$/.test(source) || !/^[a-z]{2,3}$/.test(target)) return false;
    if (source === target) return true;
    if (argosHasPair(source, target)) return true;
    return source !== 'en' && target !== 'en' && argosHasPair(source, 'en') && argosHasPair('en', target);
}
// Selectable target languages = those reachable from English (every target pivots through en),
// plus 'en' itself when any X->en model is present.
function argosTargets() {
    const out = [];
    try {
        let anyToEn = false;
        for (const name of fs.readdirSync(ARGOS_MODELS_DIR)) {
            const en = /^en_([a-z]{2,3})$/.exec(name);
            if (en && argosHasPair('en', en[1])) out.push(en[1]);
            if (/^[a-z]{2,3}_en$/.test(name) && argosHasPair(name.slice(0, -3), 'en')) anyToEn = true;
        }
        if (anyToEn) out.push('en');
    } catch (_) { /* none */ }
    return Array.from(new Set(out)).sort();
}
// Phase 4 — OCR of PGS (Blu-ray / hdmv_pgs_subtitle) image subtitles → WebVTT (see src/ocr_pgs.py).
// The gateway extracts the image-sub track to a self-contained .sup, then ocr_pgs.py parses the PGS
// bitstream (exact per-cue PTS) and runs tesseract on each cue's bitmap. Reuses the argos venv (Pillow
// installed there); tesseract-ocr is on PATH. Disabled if either the script or tesseract is missing.
const OCR_PYTHON_BIN = process.env.OCR_PYTHON_BIN || ARGOS_PYTHON_BIN;
const OCR_SCRIPT = path.join(__dirname, 'ocr_pgs.py');
// VOBSUB (dvd_subtitle) + DVB (dvb_subtitle): no clean container to copy out, so we let ffmpeg DECODE
// the stream and render it with sub2video → timed PNGs, then ocr_imgsub.py OCRs them (reusing ocr_pgs
// helpers). One code path for both formats; PGS keeps its direct .sup parser.
const OCR_SCRIPT_IMGSUB = path.join(__dirname, 'ocr_imgsub.py');
const OCR_TESSERACT_BIN = process.env.TESSERACT_BIN || 'tesseract';
const OCR_LANGS = process.env.OCR_LANGS || 'eng+fra+spa+deu+ita+por';
const OCR_TIMEOUT_MS = clampInt(process.env.OCR_TIMEOUT_MS, 900_000, 30_000, 3_600_000);
const SUP_EXTRACT_TIMEOUT_MS = clampInt(process.env.SUP_EXTRACT_TIMEOUT_MS, 600_000, 30_000, 3_600_000);
const MAX_OCR_QUEUE = clampInt(process.env.MAX_OCR_QUEUE, 100, 1, 1000);
const OCR_ENABLED = (() => {
    try {
        if (!fs.existsSync(OCR_SCRIPT)) return false;
        return spawnSync(OCR_TESSERACT_BIN, ['--version'], { timeout: 5000 }).status === 0;
    } catch (_) { return false; }
})();
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
const GATEWAY_VERSION = 71;

// Last-resort safety net: a streaming proxy MUST NOT die on one bad socket. An unhandled
// 'error' on a pumped stream (provider reset mid-flow, client abort) otherwise bubbles to
// uncaughtException and kills the process — every in-flight viewer gets a Railway edge 502
// (no CORS header) and the service crash-loops while a flaky panel keeps resetting. Proven
// live 2026-07-04 on /raw (engine lane seeks). Log, redacted, and keep serving.
process.on('uncaughtException', (err) => {
    console.error('[media-gateway] uncaughtException (kept alive):', redactCreds(String((err && err.stack) || err)));
});
process.on('unhandledRejection', (err) => {
    console.error('[media-gateway] unhandledRejection (kept alive):', redactCreds(String((err && (err.stack || err.message)) || err)));
});
// Browser playback fetches HLS playlists/segments cross-origin, so these must
// list every Norva web origin or the browser blocks the response (CORS). Keep
// in sync with the relay's ALLOWED_ORIGINS (services/norva-relay/wrangler.jsonc).
// www.gstatic.com is the Chromecast Default Media Receiver: its HLS player
// fetches playlists/segments with that Origin, so casting needs it allowed
// (the session token in the URL keeps access gated exactly as for browsers).
const DEFAULT_ALLOWED_ORIGINS = [
    'https://norva.tv',
    'https://app.norva.tv',
    'https://norva-web.pages.dev',
    'https://www.gstatic.com',
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
        languageDetectEngine: WHISPER_BIN && WHISPER_MODEL ? {
            family: 'whisper.cpp',
            model: WHISPER_MODEL_NAME,
            commit: WHISPER_CPP_COMMIT,
            binarySha256: WHISPER_BIN_SHA256,
            modelSha256: WHISPER_MODEL_SHA256,
            runtimeVerified: WHISPER_RUNTIME_VERIFIED,
            detectOnlyBenchmark: true,
        } : null,
        translate: ARGOS_ENABLED,
        translateTargets: ARGOS_ENABLED ? argosTargets() : [],
        ocr: OCR_ENABLED,
        ocrLangs: OCR_ENABLED ? OCR_LANGS : '',
        providerProxy: providerProxyAgents.length > 0,
        providerProxyPool: providerProxyAgents.length,
        transcribeQueueDepth: transcribeQueue.length,
        transcribeBusy,
        ocrQueueDepth: ocrQueue.length,
        ocrBusy,
        translateQueueDepth: translateQueue.length,
        translateBusy,
        rawPumpCount: rawPumps.size,
        whisperInferenceActive,
        argosInferenceActive,
        lidBenchmarkBusy,
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
// ── /raw junk-body guard (2026-07-18 mobile VOD incident) ────────────────────────
// Textual content-types that legit stream bytes never carry. Everything else
// (video/*, audio/*, application/octet-stream, absent header) pipes untouched.
const NON_MEDIA_CONTENT_TYPE_RE = /^\s*(?:text\/|application\/(?:json|problem\+json|xml|xhtml\+xml))/i;

// One read of the response body — the leading chunk decides. A busy/ban page
// arrives whole in the first chunk; real media leads with its container magic.
async function sniffLeadingBytes(webBody, signal) {
    const reader = webBody.getReader();
    try {
        const { value, done } = await reader.read();
        return { chunk: done || !value ? Buffer.alloc(0) : Buffer.from(value), reader };
    } catch (err) {
        if (!(signal && signal.aborted)) {
            console.warn('[media-gateway] /raw body sniff failed:', redactCreds(String((err && err.message) || err)));
        }
        return { chunk: Buffer.alloc(0), reader };
    }
}

// Container magics of everything the /raw lane pipes (mp4/mov, mkv/webm, MPEG-TS,
// flv, avi/wav, ogg, mp3/ADTS, HLS playlist). Unknown BINARY leaders still pipe
// (fail-open: the player's own sniffer decides); only a text-shaped body under a
// textual content-type is refused — that shape is a busy/ban page, not a stream.
function looksLikeMediaStart(buf) {
    if (!buf || buf.length === 0) return false; // empty 2xx body = dead link, not a stream
    const head = buf.toString('latin1', 0, Math.min(buf.length, 16));
    if (buf.length >= 8 && head.slice(4, 8) === 'ftyp') return true; // mp4 / mov
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // mkv/webm (EBML)
    if (head.startsWith('FLV')) return true;
    if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return true; // MPEG-TS sync byte(s)
    if (head.startsWith('RIFF')) return true; // avi / wav
    if (head.startsWith('OggS')) return true;
    if (head.startsWith('ID3') || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return true; // mp3 / ADTS
    if (head.startsWith('#EXTM3U')) return true; // HLS playlist relayed as-is
    return !looksLikeTextStart(buf);
}

// "Text-shaped": printable ASCII + whitespace across the whole sample (optional
// UTF-8 BOM). An HTML/JSON/XML busy page matches; any real container hits a
// control byte within the first few bytes.
function looksLikeTextStart(buf) {
    let i = 0;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
    const n = Math.min(buf.length, 256);
    for (; i < n; i += 1) {
        const b = buf[i];
        const printable = (b >= 0x20 && b !== 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d;
        if (!printable) return false;
    }
    return true;
}

// Rebuild a Node stream from a sniffed body: replay the leading chunk, then pump
// the remaining web-stream reads. destroy() cancels the reader so the provider
// connection (the account's single slot) drops with the client, like fromWeb does.
function readableFromSniffedBody(sniffed) {
    const { Readable } = require('stream');
    let leading = sniffed.chunk && sniffed.chunk.length ? sniffed.chunk : null;
    const reader = sniffed.reader;
    return new Readable({
        read() {
            if (leading) { const c = leading; leading = null; this.push(c); return; }
            reader.read().then(({ value, done }) => {
                if (done) this.push(null);
                else this.push(Buffer.from(value));
            }).catch((err) => this.destroy(err));
        },
        destroy(err, cb) {
            Promise.resolve().then(() => reader.cancel()).catch(() => {}).then(() => cb(err));
        },
    });
}

app.get('/raw/:token', async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });

    const ac = new AbortController();
    // Supersede any pump left by a PREVIOUS playback session on this account —
    // same-session concurrency (parallel range reads) is spared via claims.sid.
    const pumpProxyKey = proxyKeyFromUrl(claims.url);
    const pump = registerRawPump({
        ac,
        sid: claims.sid || null,
        proxyKey: pumpProxyKey,
        ownerHash: claims.uid ? sha256Hex(claims.uid) : null,
    });
    abortRawPumps((p) => p !== pump && p.proxyKey === pumpProxyKey, claims.sid || null,
        `superseded by playback ${String(claims.sid || 'unknown').slice(0, 8)}`);
    // Same rule as the transcode lane: a viewer's byte-pump outranks any background extraction
    // holding this account's slot (the job re-queues as deferred and resumes after the viewing).
    preemptAccountExtractions(pumpProxyKey, `raw playback ${String(claims.sid || 'unknown').slice(0, 8)}`);
    res.on('close', () => { ac.abort(); releaseRawPump(pump); });
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
    let sniffedBody = null; // { chunk, reader } when a suspect 2xx body was sniffed and proved to be real media
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
        // A single-slot panel refusing a connection often answers with an HTML/JSON
        // "busy"/ban page on HTTP 200 (2026-07-18 mobile VOD incident). Piped through,
        // those bytes reach the native player as an unparseable "container"
        // (ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) — a dead-end its recovery ladder
        // used to ignore, whereas a real HTTP error arms fallback/retry. Only textual
        // content-types are suspected (panels routinely mislabel real media as
        // octet-stream, and players ignore the header anyway), and the leading bytes
        // are sniffed so a panel that mislabels REAL media as text keeps playing.
        // Junk retries like a 458: same slot-release window, same backoff.
        if (method === 'GET' && upstream.ok && upstream.body
            && NON_MEDIA_CONTENT_TYPE_RE.test(String(upstream.headers.get('content-type') || ''))) {
            const probe = await sniffLeadingBytes(upstream.body, ac.signal);
            if (ac.signal.aborted) { try { await probe.reader.cancel(); } catch (_) {} try { res.end(); } catch (_) {} return; }
            if (looksLikeMediaStart(probe.chunk)) { sniffedBody = probe; break; }
            try { await probe.reader.cancel(); } catch (_) {} // free the slot before retrying
            if (attempt < maxAttempts) {
                console.warn(`[media-gateway] /raw provider sent a non-media body (status ${upstream.status}, attempt ${attempt}/${maxAttempts}); retrying in ${RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1]}ms`);
                await sleep(RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000);
                continue;
            }
            console.warn(`[media-gateway] /raw provider kept sending a non-media body (status ${upstream.status}); refusing to pipe it as a stream`);
            return res.status(502).json({
                error: 'Provider returned a non-media body (busy/ban page) instead of stream bytes',
                upstreamStatus: upstream.status,
                contentType: String(upstream.headers.get('content-type') || '') || null,
            });
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
    const nodeStream = sniffedBody
        ? readableFromSniffedBody(sniffedBody)
        : require('stream').Readable.fromWeb(upstream.body);
    // In-band header capture: if this response carries the file's LEADING bytes, tee them
    // (best-effort) so a later codec probe reads the header locally instead of opening a
    // second provider connection. Attached BEFORE pipe() so no leading chunk is missed;
    // never throws into the pipe; respects pipe backpressure (no data flows while paused).
    if (INBAND_HEADER_PARSE) {
        try { maybeCaptureHeaderBytes(claims.url, upstream, nodeStream); } catch (_) { /* never break the byte pipe */ }
    }
    // pipe() does NOT forward errors: an unhandled 'error' on either side (provider reset
    // mid-stream, engine aborting a range read on seek, client socket reset) is an
    // uncaughtException that kills the whole process — the 2026-07-04 crash-loop. Tear the
    // response down quietly instead; the engine's own retry ladder handles the rest.
    nodeStream.on('error', (err) => {
        if (!ac.signal.aborted) {
            console.warn('[media-gateway] /raw upstream stream error:', redactCreds(String((err && err.message) || err)));
        }
        try { res.destroy(); } catch (_) { /* already gone */ }
    });
    res.on('error', () => { try { nodeStream.destroy(); } catch (_) { /* already gone */ } });
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

// Audio-language probe over the RESIDENTIAL proxy IP (anti-ban « faible empreinte »). The
// audio-backfill crawl normally header-probes via the Cloudflare relay, so a mono-connection
// anti-abuse account is seen from Cloudflare (probes) AND the residential proxy (metadata) at
// once → user_multi_ip / account-sharing bans. For a low_footprint identity the edge routes the
// probe HERE instead: ffprobe egresses the same sticky residential IP as everything else, so the
// provider sees one household. Returns the SAME shape as norva-relay /probe-audio so the
// edge runner consumes it unchanged (audioLanguages / audioTracks / subtitles).
app.post('/probe-audio', requireGatewayAuth, async (req, res) => {
    try {
        const { url, userAgent } = req.body || {};
        if (!url || !isHttpUrl(url)) {
            return res.status(400).json({ error: 'url is required' });
        }
        const ua = sanitizeUserAgent(userAgent) || 'VLC/3.0.20 LibVLC/3.0.20';
        // Concurrency 1 incl. playback: never probe while a real viewer holds this account's single
        // provider connection — that overlap is exactly the user_multi_ip / account-sharing signal
        // that got the account banned. Match on the account key (host + username in the stream path).
        const probeKey = proxyKeyFromUrl(url);
        const accountBusy = Array.from(sessions.values()).some(
            (s) => s && s.sourceUrl && proxyKeyFromUrl(s.sourceUrl) === probeKey && isSessionBlockingProviderSlot(s));
        if (accountBusy) {
            return res.status(409).json({ error: 'Account busy (active playback)', code: 'account_busy' });
        }
        const profile = await probeCodecProfile(url, ua); // ffprobe via the residential proxy
        const audioTracks = Array.isArray(profile?.audioTracks) ? profile.audioTracks : [];
        const subtitles = Array.isArray(profile?.subtitles) ? profile.subtitles : [];
        const audioLanguages = [];
        let audioDefaultLanguage = null;
        for (const t of audioTracks) {
            if (t.language && !audioLanguages.includes(t.language)) audioLanguages.push(t.language);
            if (t.default && !audioDefaultLanguage) audioDefaultLanguage = t.language || null;
        }
        res.json({ audioLanguages, audioTracks, audioDefaultLanguage, subtitles });
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({ error: err.publicMessage || 'Audio probe failed', code: err.code || undefined });
    }
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
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const ua = claims.ua || FFMPEG_USER_AGENT;

    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid audio index' });
    const strict = ['1', 'true', 'yes'].includes(String(req.query.strict || '').toLowerCase());
    const dur = Math.min(Math.max(Number.parseFloat(req.query.dur) || (strict ? 30 : 20), 4), 60);
    // An explicit ?start pins a single offset (caller knows where speech is); otherwise sweep the
    // bounded mid-film offsets and stop at the first clip that actually contains speech.
    const explicitStart = Number.parseFloat(req.query.start);
    if (strict && Number.isFinite(explicitStart)) {
        return res.status(400).json({ error: 'Strict language validation requires separated samples' });
    }
    const offsets = (Number.isFinite(explicitStart) && explicitStart >= 0)
        ? [explicitStart]
        : (strict ? WHISPER_STRICT_OFFSETS : WHISPER_SWEEP_OFFSETS);
    const consensusNeeded = strict
        ? WHISPER_STRICT_CONSENSUS
        : Math.max(1, Math.min(3, Number.parseInt(req.query.consensus, 10) || 1));
    if (strict && offsets.length < consensusNeeded) {
        return res.status(503).json({ error: 'Strict language validation needs at least four configured offsets' });
    }

    try {
        let best = null;          // best partial result across offsets (most words), as a fallback
        let extractions = 0;      // bound the provider connections
        let lastExtractErr = '';  // surfaced when EVERY offset failed (was an opaque constant string)
        const votes = new Map();
        const strictSamples = [];
        let bestStrictAccepted = null;
        let strictRejectedSpeechSamples = 0;
        const lockKey = accountJobKey(claims.uid, claims.url);
        for (const off of offsets) {
            let wavPath = null;
            try {
                // Fast-fail rather than queue behind a long extraction: the edge caller has its own
                // HTTP timeout — waiting minutes here would spend a provider hit after it hung up.
                if (isAccountJobBusy(lockKey)) { lastExtractErr = 'account provider slot busy (background job in progress)'; break; }
                // Same fast-fail when a VIEWER holds the slot on this box — the edge gate is checked
                // at tick entry only, and a viewer can start mid-sweep.
                if (accountSlotBusyLocally(claims.url)) { lastExtractErr = 'account provider slot busy (viewer playback)'; break; }
                const ex = await withAccountJobLock(lockKey, () =>
                    extractAudioWav(claims.url, ua, trackIndex, off > 0 ? off : 0, dur, 30_000, claims.uid));
                if (!ex.ok) { lastExtractErr = ex.error; continue; }   // failed or offset past the file's end → next offset
                wavPath = ex.path;
                extractions++;
                const whisper = await runWhisperDetect(wavPath);
                const det = detectLanguageFromText(whisper.text);
                // Strict validation never promotes a single-model guess. Whisper must be highly
                // confident on each window; when the independent transcript detector has enough
                // evidence, it must agree. Any accepted-language disagreement leaves the file
                // pending rather than choosing a majority.
                const whisperLang = String(whisper.lang || '').toLowerCase() || null;
                const whisperProbability = Number(whisper.prob || 0);
                const uniqueWordCount = new Set(
                    String(whisper.text || '').toLowerCase().match(/\p{L}+/gu) || [],
                ).size;
                const transcriptDisagrees = det.confident === true
                    && Boolean(det.lang)
                    && det.lang !== whisperLang;
                const whisperConfident = Boolean(whisperLang) && whisperProbability >= (
                    strict ? WHISPER_STRICT_MIN_PROBABILITY : 0.75
                );
                const enoughWords = Number(det.words || 0) >= (
                    strict ? WHISPER_STRICT_MIN_WORDS : 4
                ) && (!strict || uniqueWordCount >= WHISPER_STRICT_MIN_UNIQUE_WORDS);
                const strictAccepted = strict
                    && whisperConfident
                    && enoughWords
                    && !transcriptDisagrees;
                if (strict && enoughWords && !strictAccepted) {
                    strictRejectedSpeechSamples++;
                }
                const confident = strict
                    ? strictAccepted
                    : (det.confident === true || whisperConfident);
                const candidate = strict
                    ? whisperLang
                    : (det.confident ? det.lang : (whisperLang || det.lang || null));
                const language = confident ? candidate : null;
                const result = {
                    language,
                    candidate,
                    confidence: strict
                        ? whisperProbability
                        : (det.confident ? det.score : whisperProbability),
                    confident,
                    verified: false,
                    validationStatus: 'pending',
                    method: strict
                        ? 'whisper-strict-consensus-v4'
                        : (det.confident ? 'transcript' : (whisperConfident ? 'whisper' : 'pending')),
                    consensus: 0,
                    whisperLang,
                    transcriptLang: det.confident ? det.lang : null,
                    transcriptAgrees: det.confident ? det.lang === whisperLang : null,
                    minProbability: strict ? WHISPER_STRICT_MIN_PROBABILITY : 0.75,
                    wordCount: det.words,
                    uniqueWordCount,
                    sample: String(whisper.text || '').slice(0, 160),
                    offset: off,
                };
                // "Good" = a clear transcript with a language → real speech. Stop sweeping. A
                // silent/music clip yields ~no words → keep the best partial and try the next offset.
                if (language && det.words >= 4) {
                    const voteCount = (votes.get(language) || 0) + 1;
                    votes.set(language, voteCount);
                    result.consensus = voteCount;
                    if (strict) {
                        strictSamples.push({
                            offset: off,
                            language,
                            probability: whisperProbability,
                            wordCount: det.words,
                            uniqueWordCount,
                            transcriptAgrees: result.transcriptAgrees,
                        });
                        if (!bestStrictAccepted || result.wordCount > bestStrictAccepted.wordCount) {
                            bestStrictAccepted = result;
                        }
                    }
                    // Non-strict discovery may stop as soon as its requested vote count is met.
                    // Strict certification deliberately consumes every configured window: a
                    // fifth/sixth accepted sample that disagrees must veto four earlier votes.
                    if (!strict && voteCount >= consensusNeeded) {
                        res.setHeader('Cache-Control', 'private, max-age=3600');
                        return res.json(result);
                    }
                }
                if (!best || result.wordCount > best.wordCount) best = result;
            } catch (_) { /* try the next offset */ }
            finally { if (wavPath) fsp.unlink(wavPath).catch(() => {}); }
        }
        if (extractions === 0) return res.status(502).json({ error: 'Audio extraction failed', details: lastExtractErr });
        if (
            strict &&
            bestStrictAccepted &&
            strictSamples.length >= consensusNeeded &&
            votes.size === 1 &&
            strictRejectedSpeechSamples === 0
        ) {
            const language = strictSamples[0].language;
            const verified = {
                ...bestStrictAccepted,
                language,
                candidate: language,
                confident: true,
                verified: true,
                validationStatus: 'verified',
                consensus: strictSamples.length,
                samples: strictSamples,
                sampleCount: strictSamples.length,
                rejectedSpeechSampleCount: 0,
                minSampleProbability: Math.min(...strictSamples.map((sample) => sample.probability)),
                minSampleWordCount: Math.min(...strictSamples.map((sample) => sample.wordCount)),
                minSampleUniqueWordCount: Math.min(
                    ...strictSamples.map((sample) => sample.uniqueWordCount),
                ),
            };
            res.setHeader('Cache-Control', 'private, max-age=3600');
            return res.json(verified);
        }
        // No strict consensus is not a language result. It is a retryable pending state, so no
        // caller can accidentally surface `candidate` as if it had been validated.
        if (best && consensusNeeded > 1) {
            best = {
                ...best,
                language: null,
                confident: false,
                verified: false,
                validationStatus: 'pending',
                consensus: Math.max(0, ...votes.values()),
                sampleCount: strictSamples.length,
                rejectedSpeechSampleCount: strict ? strictRejectedSpeechSamples : undefined,
                samples: strict ? strictSamples : undefined,
            };
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.json(best || {
            language: null, candidate: null, confidence: 0, confident: false,
            verified: false, validationStatus: 'pending',
            method: strict ? 'whisper-strict-consensus-v4' : 'pending',
            consensus: 0, whisperLang: null, transcriptLang: null,
            wordCount: 0, sampleCount: 0, sample: '',
        });
    } catch (err) {
        return res.status(502).json({ error: 'Language detection failed', details: String((err && err.message) || err) });
    }
});

// Service-only A/B benchmark. A signed scope keeps browser-visible byte-pipe tokens from
// enabling the double CPU work, while gateway Bearer auth keeps the route off the public path.
// The provider is touched exactly once: both Whisper modes consume the same temporary WAV and
// nothing is persisted here or by the edge benchmark caller.
app.post('/benchmark-language/:token', requireGatewayAuth, async (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims || claims.scope !== 'lid-benchmark') {
        return res.status(401).json({ error: 'Invalid LID benchmark token' });
    }
    if (Number(claims.exp) * 1000 < Date.now()) {
        return res.status(401).json({ error: 'LID benchmark token expired' });
    }
    if (!WHISPER_BIN || !WHISPER_MODEL) {
        return res.status(503).json({ error: 'Language detection not configured' });
    }
    if (
        lidBenchmarkBusy ||
        lidProductionCpuBusy() ||
        activeSessionCount() > 0 ||
        rawPumps.size > 0
    ) {
        res.setHeader('Retry-After', '30');
        return res.status(429).json({ error: 'LID benchmark requires an idle gateway' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const trackIndex = Number.parseInt(body.index, 10);
    const startOffset = Number.parseFloat(body.start);
    const duration = Number.parseFloat(body.dur);
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 1024) {
        return res.status(400).json({ error: 'Invalid audio index' });
    }
    if (!Number.isFinite(startOffset) || startOffset < 0 || startOffset > 21600) {
        return res.status(400).json({ error: 'Invalid benchmark offset' });
    }
    if (!Number.isFinite(duration) || duration < 8 || duration > 30) {
        return res.status(400).json({ error: 'Benchmark duration must be between 8 and 30 seconds' });
    }
    const order = body.order === 'detect-first' ? 'detect-first' : 'current-first';
    const lockKey = accountJobKey(claims.uid, claims.url);
    if (isAccountJobBusy(lockKey) || accountSlotBusyLocally(claims.url)) {
        res.setHeader('Retry-After', '30');
        return res.status(429).json({ error: 'Provider account is busy' });
    }

    lidBenchmarkBusy = true;
    res.setHeader('Cache-Control', 'no-store');
    let wavPath = null;
    try {
        const extractStartedAt = performance.now();
        const ex = await withAccountJobLock(lockKey, () =>
            extractAudioWav(
                claims.url,
                claims.ua || FFMPEG_USER_AGENT,
                trackIndex,
                startOffset,
                duration,
                45_000,
                claims.uid,
                false,
            ));
        const extractMs = Math.round((performance.now() - extractStartedAt) * 100) / 100;
        if (!ex.ok) {
            return res.status(502).json({ error: 'Audio extraction failed', details: ex.error });
        }
        wavPath = ex.path;

        const stat = await fsp.stat(wavPath);
        const wavBytes = stat.size;
        const audioSec = Math.max(0, (wavBytes - 44) / (16000 * 2));
        const sampleDigest = crypto.createHash('sha256')
            .update(await fsp.readFile(wavPath))
            .digest('hex');

        let current = null;
        let detectOnly = null;
        let currentMs = 0;
        let detectOnlyMs = 0;
        let currentContainerCpuMs = null;
        let detectOnlyContainerCpuMs = null;
        const loadBefore = os.loadavg();
        const runCurrent = async () => {
            const cpuBefore = await readContainerCpuUsageMs();
            const startedAt = performance.now();
            const value = await runWhisperDetect(wavPath);
            currentMs = Math.round((performance.now() - startedAt) * 100) / 100;
            const cpuAfter = await readContainerCpuUsageMs();
            currentContainerCpuMs = cpuBefore == null || cpuAfter == null
                ? null
                : Math.round((cpuAfter - cpuBefore) * 100) / 100;
            return value;
        };
        const runDetectOnly = async () => {
            const cpuBefore = await readContainerCpuUsageMs();
            const startedAt = performance.now();
            const value = await runWhisperDetectOnly({
                bin: WHISPER_BIN,
                model: WHISPER_MODEL,
                wavPath,
                threads: WHISPER_THREADS,
                timeoutMs: WHISPER_TIMEOUT_MS,
            });
            detectOnlyMs = Math.round((performance.now() - startedAt) * 100) / 100;
            const cpuAfter = await readContainerCpuUsageMs();
            detectOnlyContainerCpuMs = cpuBefore == null || cpuAfter == null
                ? null
                : Math.round((cpuAfter - cpuBefore) * 100) / 100;
            return value;
        };
        if (order === 'detect-first') {
            detectOnly = await runDetectOnly();
            current = await runCurrent();
        } else {
            current = await runCurrent();
            detectOnly = await runDetectOnly();
        }

        const transcript = detectLanguageFromText(current.text);
        const currentLanguage = String(current.lang || '').toLowerCase() || null;
        const currentProbability = Number(current.prob || 0);
        const currentConfident = Boolean(currentLanguage) && currentProbability >= 0.75;
        const productionCandidate = transcript.confident
            ? transcript.lang
            : (currentLanguage || transcript.lang || null);
        const productionLanguage = (transcript.confident === true || currentConfident)
            && Number(transcript.words || 0) >= 4
            ? productionCandidate
            : null;
        const totalCurrentMs = extractMs + currentMs;
        const totalDetectOnlyMs = extractMs + detectOnlyMs;
        const sameLanguage = Boolean(
            currentLanguage &&
            detectOnly.ok &&
            detectOnly.lang &&
            currentLanguage === detectOnly.lang,
        );

        return res.json({
            schemaVersion: 1,
            benchmarkId: crypto.randomUUID(),
            persisted: false,
            sample: {
                trackIndex,
                startSec: startOffset,
                requestedDurationSec: duration,
                audioSec: Math.round(audioSec * 1000) / 1000,
                wavBytes,
                digest: sampleDigest,
            },
            engine: {
                family: 'whisper.cpp',
                model: WHISPER_MODEL_NAME,
                commit: WHISPER_CPP_COMMIT,
                binarySha256: WHISPER_BIN_SHA256,
                modelSha256: WHISPER_MODEL_SHA256,
                runtimeVerified: WHISPER_RUNTIME_VERIFIED,
                threads: WHISPER_THREADS,
            },
            system: {
                instance: LID_BENCHMARK_INSTANCE,
                loadBefore,
                loadAfter: os.loadavg(),
                contended: activeSessionCount() > 0 || rawPumps.size > 0 || lidProductionCpuBusy(),
            },
            order: order === 'detect-first'
                ? ['detect-only', 'current']
                : ['current', 'detect-only'],
            timings: {
                extractMs,
                currentMs,
                detectOnlyMs,
                currentContainerCpuMs,
                detectOnlyContainerCpuMs,
                totalCurrentMs: Math.round(totalCurrentMs * 100) / 100,
                totalDetectOnlyMs: Math.round(totalDetectOnlyMs * 100) / 100,
            },
            current: {
                ok: Boolean(currentLanguage || current.text),
                candidateLanguage: currentLanguage,
                probability: currentProbability,
                transcriptLanguage: transcript.confident ? transcript.lang : null,
                transcriptConfident: transcript.confident === true,
                wordCount: Number(transcript.words || 0),
                productionAccepted: Boolean(productionLanguage),
                productionLanguage,
            },
            detectOnly: {
                ok: detectOnly.ok === true,
                candidateLanguage: detectOnly.lang || null,
                probability: Number(detectOnly.prob || 0),
                timedOut: detectOnly.timedOut === true,
                error: detectOnly.error || null,
            },
            agreement: {
                whisperLanguage: sameLanguage,
                productionLanguage: Boolean(
                    productionLanguage &&
                    detectOnly.ok &&
                    productionLanguage === detectOnly.lang
                ),
            },
            gains: {
                lidSpeedup: detectOnlyMs > 0
                    ? Math.round((currentMs / detectOnlyMs) * 1000) / 1000
                    : null,
                endToEndSpeedup: totalDetectOnlyMs > 0
                    ? Math.round((totalCurrentMs / totalDetectOnlyMs) * 1000) / 1000
                    : null,
            },
        });
    } catch (error) {
        return res.status(502).json({
            error: 'LID benchmark failed',
            details: String(error?.message || error),
        });
    } finally {
        if (wavPath) fsp.unlink(wavPath).catch(() => {});
        lidBenchmarkBusy = false;
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
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const ua = claims.ua || FFMPEG_USER_AGENT;

    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid audio index' });
    const startOffset = Math.max(0, Number.parseFloat(req.query.start) || 0);
    const dur = Math.max(0, Number.parseFloat(req.query.dur) || 0);  // 0 = whole track
    const forceLang = /^[a-z]{2,3}$/i.test(String(req.query.lang || '')) ? String(req.query.lang).toLowerCase() : '';

    let wavPath = null;
    try {
        const e0 = Date.now();
        const ex = await withAccountJobLock(accountJobKey(claims.uid, claims.url), () =>
            extractAudioWav(claims.url, ua, trackIndex, startOffset, dur, AUDIO_EXTRACT_TIMEOUT_MS, claims.uid));
        const extractMs = Date.now() - e0;
        if (!ex.ok) return res.status(502).json({ error: 'Audio extraction failed', details: ex.error });
        wavPath = ex.path;
        let audioSec = 0;
        try { audioSec = (await fsp.stat(wavPath)).size / (16000 * 2); } catch (_) { audioSec = 0; } // 16kHz mono s16le = 32000 B/s
        const w = await runWhisperVtt(wavPath, forceLang, whisperBudgetMs(audioSec));
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

// Phase 3 async transcription: accept a job (202) and run it in the background, then POST the VTT
// to the edge callback. Params in the query (no body parser needed). callback must target one of
// our backend origins — isBackendUrl — (the byte-pipe token already gates the caller to whoever
// holds the gateway token = the edge).
app.post('/transcribe-async/:token', (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    if (!WHISPER_BIN || !WHISPER_MODEL) return res.status(503).json({ error: 'Transcription not configured' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const index = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid audio index' });
    const jobId = String(req.query.jobId || '');
    const callbackUrl = String(req.query.callback || '');
    if (!jobId || !isBackendUrl(callbackUrl)) {
        return res.status(400).json({ error: 'jobId and a valid backend callback are required' });
    }
    const start = Math.max(0, Number.parseFloat(req.query.start) || 0);
    const dur = Math.max(0, Number.parseFloat(req.query.dur) || 0); // 0 = whole track (production); >0 = clip (test)
    const ua = claims.ua || FFMPEG_USER_AGENT;
    // Priority class from the edge's origin tag: a viewer waiting in front of the player jumps
    // ahead of the nightly pregen batch (viewer=0 > service=1 > pregen=2).
    const prio = JOB_PRIORITY[String(req.query.origin || '')] ?? 1;
    const job = { url: claims.url, ua, index, jobId, callbackUrl, start, dur, uid: claims.uid, prio };
    const ok = enqueueTranscribe(job);
    if (!ok) return res.status(429).json({ error: 'Transcription queue full' });
    // position = where THIS job sits after priority insertion (1-based), not the queue tail.
    return res.status(202).json({ queued: true, position: transcribeQueue.indexOf(job) + 1, busy: transcribeBusy });
});

// Phase 4 async OCR: accept a job (202) for a PGS image-sub track and run it in the background, then
// POST the OCR'd VTT to the edge callback — same callback shape as /transcribe-async ({ jobId, ok,
// vtt, segments, sourceLang }). Byte-pipe token gates the caller (= the edge); `index` is the
// subtitle stream index to extract. HEAVY + LONG (whole-track extract + per-cue tesseract).
app.post('/ocr-async/:token', (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    if (!OCR_ENABLED) return res.status(503).json({ error: 'OCR not configured' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const index = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid subtitle index' });
    const jobId = String(req.query.jobId || '');
    const callbackUrl = String(req.query.callback || '');
    if (!jobId || !isBackendUrl(callbackUrl)) {
        return res.status(400).json({ error: 'jobId and a valid backend callback are required' });
    }
    const lang = /^[a-z+]{3,40}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : OCR_LANGS;
    // fmt selects the pipeline: 'pgs' (.sup parser) vs 'vobsub'/'dvb' (ffmpeg sub2video → frames).
    const fmt = ['pgs', 'vobsub', 'dvb'].includes(String(req.query.fmt || '')) ? String(req.query.fmt) : 'pgs';
    const ua = claims.ua || FFMPEG_USER_AGENT;
    // OCR is viewer-triggered by nature — same priority classes for symmetry.
    const prio = JOB_PRIORITY[String(req.query.origin || '')] ?? 0;
    const job = { url: claims.url, ua, index, jobId, callbackUrl, lang, fmt, uid: claims.uid, prio };
    const ok = enqueueOcr(job);
    if (!ok) return res.status(429).json({ error: 'OCR queue full' });
    return res.status(202).json({ queued: true, position: ocrQueue.indexOf(job) + 1, busy: ocrBusy });
});

// Seek-thumbnail storyboard: extract keyframe tiles into ONE sprite JPEG, PUT it to the signed
// Supabase Storage upload URL, then POST the tile metadata to the edge callback. Rides the same
// job queue as transcription (account lock, pregen gate, priority classes) — one provider
// connection, deferred while the account is watching.
app.post('/storyboard-async/:token', (req, res) => {
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const jobId = String(req.query.jobId || '');
    const callbackUrl = String(req.query.callback || '');
    if (!jobId || !isBackendUrl(callbackUrl)) {
        return res.status(400).json({ error: 'jobId and a valid backend callback are required' });
    }
    const uploadUrl = String(req.query.uploadUrl || '');
    if (!isBackendUrl(uploadUrl, '/storage/')) {
        return res.status(400).json({ error: 'a backend storage uploadUrl is required' });
    }
    const duration = Math.max(0, Number.parseFloat(req.query.duration) || 0);
    const prio = JOB_PRIORITY[String(req.query.origin || '')] ?? 1;
    const job = {
        kind: 'storyboard', url: claims.url, ua: claims.ua || FFMPEG_USER_AGENT,
        jobId, callbackUrl, uploadUrl, duration, uid: claims.uid, prio,
    };
    const ok = enqueueTranscribe(job);
    if (!ok) return res.status(429).json({ error: 'Job queue full' });
    return res.status(202).json({ queued: true, position: transcribeQueue.indexOf(job) + 1 });
});

// Phase 3b async translation: translate a cached transcript VTT into a target language and POST the
// result to the edge callback (reuses the transcribe-callback shape: { jobId, ok, vtt, segments }).
// No provider connection (pure text on the gateway) → auth is the gateway token (edge→gateway), like
// /xtream/* — not a byte-pipe token. Body: { jobId, callback, source, target, vtt }.
app.post('/translate-async', requireGatewayAuth, (req, res) => {
    if (!ARGOS_ENABLED) return res.status(503).json({ error: 'Translation not configured' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const body = req.body || {};
    const jobId = String(body.jobId || '');
    const callbackUrl = String(body.callback || '');
    const source = String(body.source || '').toLowerCase();
    const target = String(body.target || '').toLowerCase();
    const vtt = String(body.vtt || '');
    if (!jobId || !isBackendUrl(callbackUrl)) {
        return res.status(400).json({ error: 'jobId and a valid backend callback are required' });
    }
    if (!/^[a-z]{2,3}$/.test(source) || !/^[a-z]{2,3}$/.test(target)) return res.status(400).json({ error: 'invalid source/target' });
    if (!vtt.trim()) return res.status(400).json({ error: 'vtt is required' });
    if (!argosCanServe(source, target)) return res.status(422).json({ error: `unsupported pair ${source}->${target}` });
    const ok = enqueueTranslate({ vtt, source, target, jobId, callbackUrl });
    if (!ok) return res.status(429).json({ error: 'Translation queue full' });
    return res.status(202).json({ queued: true, position: translateQueue.length, busy: translateBusy });
});

// Sync translate (debug / benchmark): returns the translated VTT directly. Gateway-auth only.
app.post('/translate', requireGatewayAuth, async (req, res) => {
    if (!ARGOS_ENABLED) return res.status(503).json({ error: 'Translation not configured' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const body = req.body || {};
    const source = String(body.source || '').toLowerCase();
    const target = String(body.target || '').toLowerCase();
    const vtt = String(body.vtt || '');
    if (!/^[a-z]{2,3}$/.test(source) || !/^[a-z]{2,3}$/.test(target) || !vtt.trim()) {
        return res.status(400).json({ error: 'source, target, vtt required' });
    }
    if (!argosCanServe(source, target)) return res.status(422).json({ error: `unsupported pair ${source}->${target}` });
    const t0 = Date.now();
    const r = await runArgos(vtt, source, target);
    if (!r.ok) return res.status(502).json({ error: 'Translation failed', details: r.error });
    return res.json({ vtt: r.vtt, segments: (r.vtt.match(/-->/g) || []).length, ms: Date.now() - t0 });
});

// Extract a mono/16 kHz pcm_s16le WAV of one audio track to a temp file. Resolves
// { ok:true, path } or { ok:false, error } — the error carries the REAL cause (ffmpeg stderr
// tail / timeout kill / tiny output), creds-redacted, mirroring extractSubtitleSup: the opaque
// null of the first version made 7 failed pregen jobs indistinguishable in the admin.
// `dur` 0 = the whole track (full-film transcription); >0 = a clip. `timeoutMs` defaults to
// 30 s (LID clip) — pass a longer value for a full-film extraction.
function extractAudioWav(
    url,
    ua,
    trackIndex,
    startOffset,
    dur,
    timeoutMs = 30_000,
    proxyKey = '',
    reportActivity = true,
) {
    return new Promise((resolve) => {
        const outputPath = path.join(os.tmpdir(), `norva-audio-${Date.now()}-${crypto.randomUUID()}.wav`);
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            // Mid-stream drop resilience, copied from the playback ffmpeg: without these, a
            // whole-film extraction dies on the FIRST connection reset (a 3s relay probe
            // releasing the slot was enough). Deliberately NO -reconnect_on_http_error — on a
            // single-slot panel, retrying an HTTP error HOLDS the failing connect and hammers
            // the slot into more 429s; the job-level retry below re-attempts cleanly instead.
            '-reconnect', '1', '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-rw_timeout', '15000000',
            '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
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
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKey || proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child, reportActivity);
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reg.release?.(); resolve({ ok: false, error: 'ffmpeg error: ' + String((e && e.message) || e) }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            reg.release?.();
            const tail = redactCreds(stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr');
            if (reg.preempted) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback on this account' });
            }
            if (code !== 0) {
                console.warn(`[media-gateway] audio-extract ffmpeg exit ${code}: ${redactCreds(stderr.slice(-300))}`);
                fsp.unlink(outputPath).catch(() => {});
                return resolve({ ok: false, error: timedOut ? `extract timeout after ${Math.round(timeoutMs / 1000)}s: ${tail}` : `ffmpeg exit ${code}: ${tail}` });
            }
            let size = 0;
            try { size = (await fsp.stat(outputPath)).size; } catch (_) { size = 0; }
            if (size <= 4000) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({ ok: false, error: `empty/tiny WAV (${size}B) — no audio decoded (${tail})` });
            }
            resolve({ ok: true, path: outputPath });
        });
    });
}

// V2 chunked pipeline: segment the extraction into CHUNK_SEC WAV files (-f segment) so whisper
// can start on chunk 1 while ffmpeg is still downloading the rest — total wall time becomes
// max(extraction, whisper) + one chunk instead of extraction + whisper, partial subtitles reach
// the player minutes after the real start, and a whisper hang/kill costs ONE chunk instead of
// the whole film (the two 43-min SIGKILL burns of 2026-07-02 were exactly that).
const TRANSCRIBE_CHUNK_SEC = clampInt(process.env.TRANSCRIBE_CHUNK_SEC, 300, 60, 1800);
// Per-chunk whisper budget: a 300s chunk transcribes in ~30-60s (RTF 0.1-0.2); 5 min is a hang,
// not a slow run. Deliberately NOT whisperBudgetMs (its 20-min floor would defeat the bounding).
const CHUNK_WHISPER_TIMEOUT_MS = clampInt(process.env.CHUNK_WHISPER_TIMEOUT_MS, 300_000, 60_000, 1_800_000);

// Segmenting variant of extractAudioWav: same input/resilience flags, but writes
// dir/chunk-%04d.wav pieces of chunkSec each (-reset_timestamps 1 → every chunk starts at 0;
// audio-only segmentation is sample-accurate, so chunk N covers exactly [N*chunkSec, …)).
// Resolves { ok, error } when ffmpeg exits; chunk files appear in `dir` as they complete.
function extractAudioWavChunks(url, ua, trackIndex, timeoutMs, proxyKey, chunkSec, dir) {
    return new Promise((resolve) => {
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-reconnect', '1', '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-rw_timeout', '15000000',
            '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
            '-user_agent', ua,
            '-probesize', '2000000', '-analyzeduration', '3000000',
            '-i', url,
            '-map', `0:${trackIndex}`,
            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
            '-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1',
            path.join(dir, 'chunk-%04d.wav'),
        ];
        let child;
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKey || proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child);
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reg.release?.(); resolve({ ok: false, error: 'ffmpeg error: ' + String((e && e.message) || e) }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            reg.release?.();
            const tail = redactCreds(stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr');
            if (reg.preempted) {
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback on this account' });
            }
            if (code !== 0) {
                console.warn(`[media-gateway] chunked-extract ffmpeg exit ${code}: ${redactCreds(stderr.slice(-300))}`);
                return resolve({ ok: false, error: timedOut ? `extract timeout after ${Math.round(timeoutMs / 1000)}s: ${tail}` : `ffmpeg exit ${code}: ${tail}` });
            }
            resolve({ ok: true });
        });
    });
}

// Shift every cue of a (chunk) VTT by offsetSec and return the cue BLOCKS (header dropped) —
// the stitcher joins blocks from all chunks and runs cleanVtt for cross-chunk dedup. Only the
// timing line is rewritten, so cue text containing time-like strings is safe.
function shiftVttBlocks(vtt, offsetSec) {
    const out = [];
    const blocks = String(vtt || '').replace(/\r/g, '').trim().split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const ti = lines.findIndex((l) => l.includes('-->'));
        if (ti === -1) continue;
        lines[ti] = lines[ti].replace(/(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}/g, (ts) => {
            const parts = ts.split(':');
            let sec = 0;
            if (parts.length === 3) sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number.parseFloat(parts[2]);
            else sec = Number(parts[0]) * 60 + Number.parseFloat(parts[1]);
            sec = Math.max(0, sec + offsetSec);
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec - h * 3600 - m * 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
        });
        out.push(lines.join('\n'));
    }
    return out;
}

// Run whisper.cpp on a WAV: auto-detect language + transcribe. Resolves { text, lang, prob };
// best-effort (empties on failure). `lang`/`prob` are parsed from whisper's own LID line.
function runWhisperDetect(wavPath) {
    return new Promise((resolve) => {
        whisperInferenceActive += 1;
        let inferenceReleased = false;
        const releaseInference = () => {
            if (inferenceReleased) return;
            inferenceReleased = true;
            whisperInferenceActive = Math.max(0, whisperInferenceActive - 1);
        };
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
        catch (_) {
            releaseInference();
            return resolve({ text: '', lang: null, prob: 0 });
        }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, WHISPER_TIMEOUT_MS);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => {
            clearTimeout(timer);
            releaseInference();
            resolve({ text: '', lang: null, prob: 0 });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : null;
            const prob = m ? (Number(m[2]) || 0) : 0;
            let text = '';
            try { text = await fsp.readFile(outPrefix + '.txt', 'utf8'); } catch (_) { text = ''; }
            fsp.unlink(outPrefix + '.txt').catch(() => {});
            if (code !== 0 && !text && !lang) console.warn(`[media-gateway] whisper exit ${code}: ${stderr.slice(-300)}`);
            releaseInference();
            resolve({ text: String(text || '').trim(), lang, prob });
        });
    });
}

// whisper hallucinates repetition on music/silence (it loops a phrase). Deterministic cleanup:
// collapse repeated sentences inside one cue, drop a cue identical to the previous, and drop the
// common end-of-video hallucinations. Never hurts genuine dialogue beyond rare exact-repeat lines.
const VTT_HALLUCINATION = /^(sous[- ]?titr(es|age)|merci d.avoir regard|thanks? for watching|amara\.org|♪+|\[?\s*(musique|music|applause|applaudissements)\s*\]?)/i;

// SDH (hearing-impaired) annotations: Norva's AI subtitles are DIALOGUE subtitles. Whisper wraps
// sound descriptions — *musique du générique*, (Rires), [Bruit de porte], ♪…♪ — and sometimes
// mixes them with real speech. Strip wrapped segments INLINE (speech is never wrapped) and drop
// a cue whose residual is a bare sound keyword phrase. Mirrors WatchPage._stripSdhAnnotations so
// cached transcripts (and the Argos translations derived from them) are clean at the source.
const SDH_BARE_LINE = /^(musiques?|music|bruits?|rires?|cris?|applaudissements?|applause|laughter|g[ée]n[ée]riques?|silence|sonneries?|soupirs?|sifflements?|klaxons?)(\s+(de|du|des|d'|of|the)\s*[\p{L}' -]{0,40}|\s*[.…!]*)?$/iu;
function stripSdhAnnotations(text) {
    const t = String(text || '')
        .replace(/\*[^*\n]{1,80}\*/g, ' ')
        .replace(/\([^)\n]{1,80}\)/g, ' ')
        .replace(/\[[^\]\n]{1,80}\]/g, ' ')
        .replace(/♪[^♪\n]{0,120}♪/g, ' ')
        .replace(/[♪🎵🎶]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return SDH_BARE_LINE.test(t) ? '' : t;
}
function collapseRepeats(text) {
    const parts = String(text).split(/(?<=[.!?。…])\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    const kept = [];
    let lastNorm = '';
    for (const p of parts) {
        const norm = p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (!norm || norm === lastNorm) continue;
        lastNorm = norm;
        kept.push(p);
    }
    return kept.join(' ');
}
function cleanVtt(vtt) {
    if (!vtt) return vtt;
    const blocks = String(vtt).replace(/\r/g, '').trim().split(/\n\s*\n/);
    const out = ['WEBVTT'];
    let lastNorm = '';
    for (const block of blocks) {
        const blk = block.trim();
        if (!blk || (/^WEBVTT/i.test(blk) && !blk.includes('-->'))) continue;
        const lns = blk.split('\n');
        const tsIdx = lns.findIndex((l) => l.includes('-->'));
        if (tsIdx === -1) continue;
        const ts = lns[tsIdx].trim();
        const text = stripSdhAnnotations(collapseRepeats(lns.slice(tsIdx + 1).join(' ').trim()));
        const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (!norm || norm === lastNorm || VTT_HALLUCINATION.test(text.trim())) continue;
        lastNorm = norm;
        out.push(`${ts}\n${text}`);
    }
    return out.join('\n\n') + '\n';
}

// Phase 3: full timestamped transcription to WebVTT. whisper.cpp emits VTT natively (-ovtt).
// Resolves { vtt, lang, prob, ms, failReason } — vtt empty on failure, and failReason then says
// WHY (timeout SIGKILL vs crash vs spawn): whisper.cpp only writes the -ovtt file at completion,
// so a timeout kill leaves no partial VTT and used to surface as an opaque "no output".
// forceLang pins the source language. `timeoutMs` = the adaptive budget (whisperBudgetMs).
function runWhisperVtt(wavPath, forceLang, timeoutMs = WHISPER_TRANSCRIBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        whisperInferenceActive += 1;
        let inferenceReleased = false;
        const releaseInference = () => {
            if (inferenceReleased) return;
            inferenceReleased = true;
            whisperInferenceActive = Math.max(0, whisperInferenceActive - 1);
        };
        const t0 = Date.now();
        const outPrefix = wavPath.replace(/\.wav$/i, '');
        const args = [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-l', (forceLang && /^[a-z]{2,3}$/i.test(forceLang)) ? forceLang : 'auto',
            '-ovtt', '-of', outPrefix,
            '-t', String(WHISPER_THREADS),
            '-mc', '0',  // no cross-window text context → breaks whisper's repetition loops on music/silence
        ];
        let child;
        try { child = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
        catch (e) {
            releaseInference();
            return resolve({ vtt: '', lang: null, prob: 0, ms: 0, failReason: 'whisper spawn failed: ' + String((e && e.message) || e) });
        }
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            releaseInference();
            resolve({ vtt: '', lang: null, prob: 0, ms: Date.now() - t0, failReason: 'whisper error: ' + String((e && e.message) || e) });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : (forceLang || null);
            const prob = m ? (Number(m[2]) || 0) : 0;
            let vtt = '';
            try { vtt = await fsp.readFile(outPrefix + '.vtt', 'utf8'); } catch (_) { vtt = ''; }
            fsp.unlink(outPrefix + '.vtt').catch(() => {});
            if (code !== 0 && !vtt) console.warn(`[media-gateway] whisper-vtt exit ${code}: ${stderr.slice(-300)}`);
            const failReason = vtt ? null
                : timedOut ? `whisper killed by timeout after ${Math.round((Date.now() - t0) / 1000)}s (no partial VTT is written)`
                : `whisper exit ${code} wrote no VTT: ${stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr'}`;
            releaseInference();
            resolve({ vtt: cleanVtt(String(vtt || '').trim()), lang, prob, ms: Date.now() - t0, failReason });
        });
    });
}

// ONE provider-touching background ffmpeg per account at a time, ACROSS lanes (fix #2 of the
// subtitle-failures audit). The transcribe, OCR and detect-language lanes each serialize
// internally, but nothing stopped two lanes from opening two simultaneous connections on the
// same single-slot panel account (pregen extraction + whisper-LID sweep → instant user_multi_ip
// refusal — the 02/07 super8k failures). Keyed by the byte-pipe uid (the account whose provider
// credentials the URL carries), falling back to the URL host key. The lock wraps only the
// provider-connected phase (ffmpeg extraction) — whisper/tesseract are pure CPU and run outside
// it. Viewer-interactive paths (/raw, /subtitle, playback) are NOT serialized here: they have
// their own slot-eviction machinery and must never wait behind a long extraction.
const accountJobLocks = new Map(); // key -> tail promise of the wait chain
function accountJobKey(uid, url) { return String(uid || '') || proxyKeyFromUrl(url); }
function isAccountJobBusy(key) { return accountJobLocks.has(key); }
async function withAccountJobLock(key, fn) {
    if (!key) return fn();
    const prev = accountJobLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate);
    accountJobLocks.set(key, tail);
    await prev;
    try { return await fn(); }
    finally {
        release();
        if (accountJobLocks.get(key) === tail) accountJobLocks.delete(key);
    }
}

// Crons ↔ jobs coordination, direction (b) (fix #3 of the subtitle-failures audit): before a
// queued job opens its provider connection, ask the edge whether the account's slot is safe —
// no live viewer and no enrichment tick heartbeat in the last ~2.5 min. The edge is the only
// party that can see relay-side cron activity: the 01/07 super8k failures were a pregen ffmpeg
// landing mid relay-probe batch, second-exact. The enqueue-time stagger (00:20/25/30) only
// staggers the ENQUEUE — this queue executes 15-50 min later, in the middle of the cron grid.
// Deferred jobs rotate to the back of their lane so other accounts keep flowing; fail-open (an
// unreachable gate — incl. a 404 while the edge route rolls out — never wedges the queue; the
// account lock and the edge-side tick skip still bound the damage).
const JOB_GATE_POLL_MS = clampInt(process.env.JOB_GATE_POLL_MS, 60_000, 5_000, 600_000);
const JOB_GATE_MAX_DEFERRALS = clampInt(process.env.JOB_GATE_MAX_DEFERRALS, 240, 1, 2000);
async function shouldDeferJob(job) {
    try {
        const gateUrl = String(job.callbackUrl || '').replace(/\/[^/]*$/, '/pregen-gate');
        if (!isBackendUrl(gateUrl)) return false;
        const resp = await fetch(gateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ userId: job.uid || '' }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return false;
        const body = await resp.json().catch(() => null);
        return Boolean(body && body.defer === true);
    } catch (_) { return false; }
}
// Priority classes for the background lanes: a VIEWER waiting in front of the player outranks
// the nightly pregen batch (which outranks nothing else). Jobs carry `prio` from the enqueue
// route's `origin` param (viewer=0, service=1, pregen=2; absent → 1). Insertion is stable
// WITHIN a class (append after the last same-class job), so same-priority jobs stay FIFO.
const JOB_PRIORITY = { viewer: 0, service: 1, pregen: 2 };
function jobPrio(job) { return Number.isInteger(job?.prio) ? job.prio : 1; }
function insertByPriority(queue, job) {
    const p = jobPrio(job);
    let i = queue.length;
    while (i > 0 && jobPrio(queue[i - 1]) > p) i--;
    queue.splice(i, 0, job);
}

// Per-provider storyboard cooldown. A storyboard job is a FULL-FILM provider read;
// several back-to-back on the same provider can trip its anti-abuse (a burst got
// super8k to refuse the gateway's IP on 2026-07-11). After each storyboard pass we
// hold off further storyboard passes on that SAME provider for a cooldown, so the
// lane never bursts a provider even when a user watches-then-closes many of its
// films in a row. Provider-scoped (the storyboard cache is provider-keyed too), and
// it gates ONLY the storyboard lane — live playback and transcribe are untouched.
const STORYBOARD_PROVIDER_COOLDOWN_MS = clampInt(process.env.STORYBOARD_PROVIDER_COOLDOWN_MS, 10 * 60_000, 0, 6 * 60 * 60_000);
const lastStoryboardAt = new Map(); // providerKey → epoch ms of the last storyboard extraction
function markStoryboardRun(url) { if (STORYBOARD_PROVIDER_COOLDOWN_MS > 0) lastStoryboardAt.set(proxyKeyFromUrl(url), Date.now()); }
function storyboardCoolingDown(job) {
    if (job?.kind !== 'storyboard' || STORYBOARD_PROVIDER_COOLDOWN_MS <= 0) return false;
    const last = lastStoryboardAt.get(proxyKeyFromUrl(job.url));
    return Boolean(last && (Date.now() - last) < STORYBOARD_PROVIDER_COOLDOWN_MS);
}

// Per-provider TRANSCRIBE/OCR cooldown (AI-subs-everywhere rollout). A transcription or an OCR
// extraction is the same full-file provider read as a storyboard — the burst that got super8k
// to refuse this gateway's IP on 2026-07-11 applies identically. With the AI option now on every
// VOD (movies, episodes, titles that already carry tracks), a binge of "generate" clicks would
// chain many back-to-back full reads (~3-4 h continuous on a 10-episode run) on one account —
// the exact fingerprint of the July 3 Ninja ban. Space them instead: same-provider jobs wait out
// the cooldown (they defer with the honest 'deferred' heartbeat; other providers proceed).
const TRANSCRIBE_PROVIDER_COOLDOWN_MS = clampInt(process.env.TRANSCRIBE_PROVIDER_COOLDOWN_MS, 12 * 60_000, 0, 6 * 60 * 60_000);
const lastTranscribeAt = new Map(); // providerKey → epoch ms of the last full-file extraction
function markTranscribeRun(url) { if (TRANSCRIBE_PROVIDER_COOLDOWN_MS > 0) lastTranscribeAt.set(proxyKeyFromUrl(url), Date.now()); }
function transcribeCoolingDown(job) {
    if (job?.kind === 'storyboard' || TRANSCRIBE_PROVIDER_COOLDOWN_MS <= 0) return false;
    const last = lastTranscribeAt.get(proxyKeyFromUrl(job.url));
    return Boolean(last && (Date.now() - last) < TRANSCRIBE_PROVIDER_COOLDOWN_MS);
}

// Non-terminal job heartbeat: stamps the row's stage (queued/deferred/extracting/transcribing)
// AND bumps updated_at — so a job legitimately deferred for hours (viewer watching on a
// single-slot account) is no longer reaped at 2h or re-claimed at 90min mid-flight, and the
// player can show honest progress instead of an opaque "processing". Fire-and-forget.
function postJobHeartbeat(job, stage) {
    try {
        fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ jobId: job.jobId, heartbeat: true, stage }),
            signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
    } catch (_) { /* best-effort */ }
}

async function postDeferFailCallback(kind, job) {
    const minutes = Math.round((JOB_GATE_POLL_MS * JOB_GATE_MAX_DEFERRALS) / 60000);
    try {
        await fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ jobId: job.jobId, ok: false, error: `Deferred too long: the account's provider slot stayed busy (live viewer or enrichment) for ~${minutes} min` }),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) { console.warn(`[media-gateway] ${kind} defer-fail callback failed`, job.jobId, String((e && e.message) || e)); }
}
// Shift the next runnable job off `queue`; deferred jobs collect in a SIDE list during the scan
// and re-enter by priority class only after it — re-pushing them inline would break the scan
// invariant (a deferred high-priority job would be re-visited in the same pass, burning its
// deferral budget n× faster and starving lower classes). Returns null when every queued job is
// deferred (the caller sleeps and rescans).
async function nextRunnableJob(queue, kind) {
    const deferred = [];
    let picked = null;
    while (queue.length) {
        const job = queue.shift();
        // Local slot check FIRST: this box knows instantly when a viewer session or raw pump
        // holds the job's provider account — no round-trip, and it sees what the edge gate
        // can't (a paused viewer whose transcode ffmpeg still runs). Then the edge gate for
        // relay-side signals (live sessions on other lanes, enrichment ticks).
        if (!accountSlotBusyLocally(job.url) && !storyboardCoolingDown(job) && !transcribeCoolingDown(job) && !(await shouldDeferJob(job))) { job.gateDeferrals = 0; picked = job; break; }
        job.gateDeferrals = (job.gateDeferrals || 0) + 1;
        if (job.gateDeferrals > JOB_GATE_MAX_DEFERRALS) {
            console.warn(`[media-gateway] ${kind} job ${job.jobId} deferred too long — failing back to the edge`);
            await postDeferFailCallback(kind, job);
            continue; // consumed (failed) — inspect the next queued job
        }
        postJobHeartbeat(job, 'deferred'); // keeps the row alive (reaper/claim) + honest UI state
        deferred.push(job);
    }
    for (const j of deferred) insertByPriority(queue, j);
    return picked;
}

// Phase 3 transcription job queue (in-process, concurrency 1). A full-film transcription is many
// minutes long, so /transcribe-async accepts a job (202) and runs it in the BACKGROUND, then POSTs
// the result to the edge callback (auth = the shared gateway token). A gateway restart loses
// in-flight jobs → the edge reaper re-enqueues rows stuck in 'processing'. Concurrency 1 keeps
// whisper from starving the stream-proxying duties of this same instance.
const transcribeQueue = [];
let transcribeBusy = false;
const MAX_TRANSCRIBE_QUEUE = clampInt(process.env.MAX_TRANSCRIBE_QUEUE, 50, 1, 500);

function enqueueTranscribe(job) {
    if (transcribeQueue.length >= MAX_TRANSCRIBE_QUEUE) return false;
    insertByPriority(transcribeQueue, job); // viewer clicks jump ahead of the nightly pregen batch
    postJobHeartbeat(job, 'queued');
    queueMicrotask(drainTranscribeQueue);
    return true;
}
async function drainTranscribeQueue() {
    if (transcribeBusy) return;
    transcribeBusy = true;
    try {
        while (transcribeQueue.length) {
            const job = await nextRunnableJob(transcribeQueue, 'transcribe');
            if (!job) { await sleep(JOB_GATE_POLL_MS); continue; }
            await runTranscribeJob(job).catch((e) => console.warn('[media-gateway] transcribe job error', String((e && e.message) || e)));
        }
    } finally { transcribeBusy = false; }
}
async function runTranscribeJob(job) {
    if (job.kind === 'storyboard') return runStoryboardJob(job);
    const { url, ua, index, jobId, callbackUrl, start = 0, dur = 0, uid = '' } = job;
    let wavPath = null, payload;
    try {
        postJobHeartbeat(job, 'extracting');
        if (dur === 0) {
            // Whole-film production path → CHUNKED pipeline (extraction and whisper overlap,
            // partial VTT streams to the edge as chunks land).
            payload = await runChunkedTranscription(job);
        } else {
            // Clip/benchmark path (dur>0): single-shot, unchanged.
            let ex = { ok: false, error: 'not attempted' };
            for (let attempt = 0; attempt <= AUDIO_EXTRACT_RETRIES; attempt++) {
                // Account lock per ATTEMPT: the 30/60s backoff sleeps must not hold the slot.
                ex = await withAccountJobLock(accountJobKey(uid, url), () =>
                    extractAudioWav(url, ua, index, start, dur, AUDIO_EXTRACT_TIMEOUT_MS, uid));
                if (ex.ok) break;
                if (ex.preempted) break; // a viewer took the slot — re-queue, don't hammer beside them
                if (/\b(401|403)\b|Unauthorized|Forbidden/i.test(ex.error || '')) break; // abuse/auth block — do not hammer
                if (attempt < AUDIO_EXTRACT_RETRIES) await sleep(AUDIO_EXTRACT_BACKOFF_MS * (attempt + 1)); // 30s, 60s — spaced, not a burst
            }
            if (ex.preempted) {
                payload = { requeue: true };
            } else if (!ex.ok) {
                payload = { jobId, ok: false, error: ('Audio extraction failed: ' + ex.error).slice(0, 300) };
            } else {
                wavPath = ex.path;
                postJobHeartbeat(job, 'transcribing');
                let audioSec = 0;
                try { audioSec = Math.round((await fsp.stat(wavPath)).size / (16000 * 2)); } catch (_) { audioSec = 0; }
                const w = await runWhisperVtt(wavPath, '', whisperBudgetMs(audioSec));
                const segments = (w.vtt.match(/-->/g) || []).length;
                payload = w.vtt
                    ? { jobId, ok: true, vtt: w.vtt, sourceLang: w.lang, audioSec, segments }
                    : { jobId, ok: false, error: ('Transcription produced no output: ' + (w.failReason || 'unknown')).slice(0, 300) };
            }
        }
    } catch (e) {
        payload = { jobId, ok: false, error: redactCreds(String((e && e.message) || e)).slice(0, 300) };
    } finally { if (wavPath) fsp.unlink(wavPath).catch(() => {}); }
    // Start the per-provider cooldown on any TERMINAL whole-film outcome (the provider was read,
    // success or not). A viewer preemption re-queues WITHOUT marking — the read barely started,
    // and cooling it down would add 12 min to that viewer's own wait after their playback ends.
    if (dur === 0 && !(payload && payload.requeue)) markTranscribeRun(url);
    if (payload && payload.requeue) {
        // Viewer preemption is a DEFERRAL, not a failure: keep the row alive/honest and put the
        // job back in line — the queue's local slot check holds it until the viewing ends.
        console.log(`[media-gateway] transcribe job ${jobId} preempted by viewer — re-queued`);
        postJobHeartbeat(job, 'deferred');
        insertByPriority(transcribeQueue, job);
        return;
    }
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) { console.warn('[media-gateway] transcribe callback failed', jobId, String((e && e.message) || e)); }
}

// ==================== Storyboard (seek thumbnails) ====================
// One ffmpeg pass over the file (keyframe-only decode) produces a single sprite
// JPEG of up to 200 tiles at a regular interval, tiled in-process (`tile=`) —
// no intermediate frame files. Timestamps are grid-regular; the nearest-keyframe
// approximation is exactly how coarse seek thumbs behave elsewhere.
const STORYBOARD_TILE_WIDTH = 212;
const STORYBOARD_MAX_TILES = 200;
const STORYBOARD_COLS = 10;

function extractStoryboardSprite(url, ua, intervalSec, cols, rows, outputPath, timeoutMs, proxyKey = '') {
    return new Promise((resolve) => {
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-reconnect', '1', '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-rw_timeout', '15000000',
            '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
            '-user_agent', ua,
            '-probesize', '2000000', '-analyzeduration', '3000000',
            '-skip_frame', 'nokey', // decode keyframes only — the pass is network-bound, not CPU-bound
            '-i', url,
            '-map', '0:v:0',
            '-vf', `fps=1/${intervalSec},scale=${STORYBOARD_TILE_WIDTH}:-2,tile=${cols}x${rows}`,
            '-frames:v', '1',
            '-q:v', '5',
            outputPath,
        ];
        let child;
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKey || proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child);
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reg.release?.(); resolve({ ok: false, error: 'ffmpeg error: ' + String((e && e.message) || e) }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            reg.release?.();
            if (reg.preempted) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback on this account' });
            }
            const tail = redactCreds(stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr');
            // A truncated read can still have flushed a usable (partial) sprite — accept any
            // plausible JPEG; only a missing/tiny file is a failure.
            let size = 0;
            try { size = (await fsp.stat(outputPath)).size; } catch (_) { size = 0; }
            if (size > 20_000) return resolve({ ok: true, path: outputPath });
            fsp.unlink(outputPath).catch(() => {});
            if (code !== 0) {
                console.warn(`[media-gateway] storyboard ffmpeg exit ${code}: ${redactCreds(stderr.slice(-300))}`);
                return resolve({ ok: false, error: timedOut ? `storyboard timeout after ${Math.round(timeoutMs / 1000)}s: ${tail}` : `ffmpeg exit ${code}: ${tail}` });
            }
            return resolve({ ok: false, error: `empty/tiny sprite (${size}B) — no video decoded (${tail})` });
        });
    });
}

async function runStoryboardJob(job) {
    const { url, ua, jobId, callbackUrl, uploadUrl, duration = 0, uid = '' } = job;
    const outputPath = path.join(os.tmpdir(), `norva-sb-${Date.now()}-${crypto.randomUUID()}.jpg`);
    let payload;
    try {
        postJobHeartbeat(job, 'extracting');
        const dur = duration > 0 ? duration : 2 * 3600; // unknown duration → assume a 2h grid
        const intervalSec = Math.max(10, Math.ceil(dur / STORYBOARD_MAX_TILES));
        const count = Math.max(1, Math.min(STORYBOARD_MAX_TILES, Math.floor(dur / intervalSec) || 1));
        const rows = Math.max(1, Math.ceil(count / STORYBOARD_COLS));
        // The pass reads the whole file at provider speed: budget ~0.6× duration,
        // floored at 15 min for shorts and capped at 75 min for slow panels.
        const timeoutMs = Math.min(75 * 60_000, Math.max(15 * 60_000, Math.round(dur * 600)));
        const r = await withAccountJobLock(accountJobKey(uid, url), () =>
            extractStoryboardSprite(url, ua, intervalSec, STORYBOARD_COLS, rows, outputPath, timeoutMs, uid));
        markStoryboardRun(url); // start the per-provider cooldown (this provider was just read)
        if (r.preempted) {
            payload = { requeue: true };
        } else if (!r.ok) {
            payload = { jobId, ok: false, error: ('Storyboard extraction failed: ' + r.error).slice(0, 300) };
        } else {
            // Upload OUTSIDE the account lock — pure HTTPS to Supabase Storage.
            const sprite = await fsp.readFile(outputPath);
            const up = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
                body: sprite,
                signal: AbortSignal.timeout(120_000),
            });
            payload = up.ok
                ? { jobId, ok: true, cols: STORYBOARD_COLS, rows, count, intervalSec, bytes: sprite.length }
                : { jobId, ok: false, error: `Storage upload failed (${up.status})` };
        }
    } catch (e) {
        payload = { jobId, ok: false, error: redactCreds(String((e && e.message) || e)).slice(0, 300) };
    } finally {
        fsp.unlink(outputPath).catch(() => {});
    }
    if (payload && payload.requeue) {
        console.log(`[media-gateway] storyboard job ${jobId} preempted by viewer — re-queued`);
        postJobHeartbeat(job, 'deferred');
        insertByPriority(transcribeQueue, job);
        return;
    }
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) { console.warn('[media-gateway] storyboard callback failed', jobId, String((e && e.message) || e)); }
}

// V2 chunked whole-film transcription: extraction segments into CHUNK_SEC WAVs while whisper
// consumes them concurrently (the account lock is held by the EXTRACTION only — whisper is pure
// CPU). Chunk 0 auto-detects the language, later chunks force it (consistency + no per-chunk LID
// drift). Each finished chunk re-stitches the full VTT (cue timestamps shifted by its offset,
// cleanVtt for cross-chunk dedup) and posts a PARTIAL callback → the player shows cues minutes
// after the real start. A whisper hang/kill costs one chunk (counted as a gap), not the film.
// Extraction retries only when ZERO chunks were produced (an instant slot refusal); a mid-film
// cut fails honestly rather than re-downloading everything.
async function runChunkedTranscription(job) {
    const { url, ua, index, jobId, callbackUrl, uid = '' } = job;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-chunks-'));
    const chunkRe = /^chunk-(\d{4})\.wav$/;
    let extractionSettled = false;
    let extractionResult = { ok: false, error: 'not started' };
    try {
        // Extraction under the account lock for its WHOLE lifetime (the provider connection).
        const extractionDone = withAccountJobLock(accountJobKey(uid, url), async () => {
            let ex = { ok: false, error: 'not attempted' };
            for (let attempt = 0; attempt <= AUDIO_EXTRACT_RETRIES; attempt++) {
                ex = await extractAudioWavChunks(url, ua, index, AUDIO_EXTRACT_TIMEOUT_MS, uid, TRANSCRIBE_CHUNK_SEC, dir);
                if (ex.ok) break;
                if (ex.preempted) break; // a viewer took the slot — the whole job re-queues
                if (/\b(401|403)\b|Unauthorized|Forbidden/i.test(ex.error || '')) break; // abuse/auth block
                let produced = 0;
                try { produced = (await fsp.readdir(dir)).filter((f) => chunkRe.test(f)).length; } catch (_) { produced = 0; }
                if (produced > 0) break; // mid-film cut: don't re-download the whole file
                if (attempt < AUDIO_EXTRACT_RETRIES) await sleep(AUDIO_EXTRACT_BACKOFF_MS * (attempt + 1));
            }
            return ex;
        }).then((r) => { extractionSettled = true; extractionResult = r; return r; });

        // Consumer: transcribe chunks as they complete (chunk N is complete when N+1 exists or
        // the extraction has exited).
        const blocks = [];
        let lang = '';
        let chunksDone = 0, gaps = 0, totalAudioSec = 0, announcedTranscribing = false;
        for (let idx = 0; ; idx++) {
            const name = `chunk-${String(idx).padStart(4, '0')}.wav`;
            const p = path.join(dir, name);
            // Wait until this chunk is complete (or extraction settled without producing it).
            for (;;) {
                const files = await fsp.readdir(dir).catch(() => []);
                const has = files.includes(name);
                const hasNext = files.includes(`chunk-${String(idx + 1).padStart(4, '0')}.wav`);
                if (has && (hasNext || extractionSettled)) break;
                if (!has && extractionSettled) break;
                await sleep(1500);
            }
            const exists = (await fsp.readdir(dir).catch(() => [])).includes(name);
            if (!exists) break; // no more chunks
            if (!announcedTranscribing) { announcedTranscribing = true; postJobHeartbeat(job, 'transcribing'); }
            try { totalAudioSec += (await fsp.stat(p)).size / (16000 * 2); } catch (_) { /* best-effort */ }
            const w = await runWhisperVtt(p, lang, CHUNK_WHISPER_TIMEOUT_MS);
            fsp.unlink(p).catch(() => {});
            if (w.vtt) {
                if (!lang && w.lang) lang = w.lang; // chunk 0 detects, the rest are forced
                blocks.push(...shiftVttBlocks(w.vtt, idx * TRANSCRIBE_CHUNK_SEC));
                chunksDone++;
                // Partial delivery: re-stitch + dedup, stream to the edge (player picks it up on
                // its next poll). Chunks land ~45s+ apart — no extra throttling needed.
                try {
                    const partialVtt = cleanVtt('WEBVTT\n\n' + blocks.join('\n\n'));
                    const partialSegs = (partialVtt.match(/-->/g) || []).length;
                    await fetch(callbackUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
                        body: JSON.stringify({ jobId, partial: true, vtt: partialVtt, sourceLang: lang || null, segments: partialSegs }),
                        signal: AbortSignal.timeout(15000),
                    });
                } catch (_) { /* partials are best-effort */ }
            } else {
                gaps++; // one lost chunk, not a lost film
                console.warn(`[media-gateway] chunk ${idx} of job ${jobId} produced no VTT: ${w.failReason || 'unknown'}`);
            }
        }

        const ex = await extractionDone;
        const audioSec = Math.round(totalAudioSec);
        if (ex.preempted) {
            // Already-streamed partial cues stay served; the job restarts cleanly after the viewing.
            return { jobId, requeue: true };
        }
        if (!ex.ok && chunksDone === 0) {
            return { jobId, ok: false, error: ('Audio extraction failed: ' + ex.error).slice(0, 300) };
        }
        if (!ex.ok) {
            return { jobId, ok: false, error: (`Extraction died mid-film after ${chunksDone} chunk(s): ` + ex.error).slice(0, 300) };
        }
        if (!chunksDone) {
            return { jobId, ok: false, error: 'Transcription produced no output: every chunk failed or the film has no audio' };
        }
        if (gaps > chunksDone) {
            return { jobId, ok: false, error: `Transcription too degraded: whisper failed on ${gaps}/${gaps + chunksDone} chunks` };
        }
        const finalVtt = cleanVtt('WEBVTT\n\n' + blocks.join('\n\n'));
        const segments = (finalVtt.match(/-->/g) || []).length;
        return { jobId, ok: true, vtt: finalVtt, sourceLang: lang || null, audioSec, segments };
    } finally {
        fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// Phase 3b translation queue — a SEPARATE lane from transcription. Translation is pure CPU on a
// cached VTT (no provider connection, ~20-45s/film), so it must not wait behind a 40-min whisper
// job, nor block one. A gateway restart loses in-flight jobs → the edge reaper re-enqueues rows
// stuck in 'processing'.
const translateQueue = [];
let translateBusy = false;
function enqueueTranslate(job) {
    if (translateQueue.length >= MAX_TRANSLATE_QUEUE) return false;
    translateQueue.push(job);
    queueMicrotask(drainTranslateQueue);
    return true;
}
async function drainTranslateQueue() {
    if (translateBusy) return;
    translateBusy = true;
    try {
        while (translateQueue.length) {
            const job = translateQueue.shift();
            await runTranslateJob(job).catch((e) => console.warn('[media-gateway] translate job error', String((e && e.message) || e)));
        }
    } finally { translateBusy = false; }
}
// Run translate.py on a VTT: pipe the request in on stdin, read the translated VTT from stdout.
// Resolves { ok, vtt } or { ok:false, error } (the script emits a JSON error on stderr + exit code).
function runArgos(vtt, source, target) {
    return new Promise((resolve) => {
        argosInferenceActive += 1;
        let inferenceReleased = false;
        const releaseInference = () => {
            if (inferenceReleased) return;
            inferenceReleased = true;
            argosInferenceActive = Math.max(0, argosInferenceActive - 1);
        };
        let child;
        try {
            child = spawn(ARGOS_PYTHON_BIN, [ARGOS_TRANSLATE_SCRIPT], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ARGOS_MODELS_DIR },
            });
        } catch (e) {
            releaseInference();
            return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) });
        }
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, ARGOS_TRANSLATE_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            releaseInference();
            resolve({ ok: false, error: String((e && e.message) || e) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            releaseInference();
            if (code === 0 && out.trim()) return resolve({ ok: true, vtt: out });
            let msg = `translate exit ${code}`;
            try { const j = JSON.parse((err.trim().split('\n').pop() || '')); if (j && j.error) msg = j.error; } catch (_) {}
            resolve({ ok: false, error: msg });
        });
        try { child.stdin.write(JSON.stringify({ vtt, source, target })); child.stdin.end(); } catch (_) { /* close handler resolves */ }
    });
}
async function runTranslateJob(job) {
    const { vtt, source, target, jobId, callbackUrl } = job;
    const r = await runArgos(vtt, source, target);
    const payload = r.ok
        ? { jobId, ok: true, vtt: r.vtt, sourceLang: target, segments: (r.vtt.match(/-->/g) || []).length }
        : { jobId, ok: false, error: String(r.error || 'translate failed').slice(0, 300) };
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) { console.warn('[media-gateway] translate callback failed', jobId, String((e && e.message) || e)); }
}

// Phase 4 OCR queue — its OWN lane (a long whisper job must not block an OCR pass, nor vice-versa).
// Concurrency 1 within the lane so per-cue tesseract doesn't starve the instance's stream-proxying.
// A gateway restart loses in-flight jobs → the edge reaper re-enqueues rows stuck in 'processing'.
const ocrQueue = [];
let ocrBusy = false;
function enqueueOcr(job) {
    if (ocrQueue.length >= MAX_OCR_QUEUE) return false;
    insertByPriority(ocrQueue, job);
    postJobHeartbeat(job, 'queued');
    queueMicrotask(drainOcrQueue);
    return true;
}
async function drainOcrQueue() {
    if (ocrBusy) return;
    ocrBusy = true;
    try {
        while (ocrQueue.length) {
            const job = await nextRunnableJob(ocrQueue, 'ocr');
            if (!job) { await sleep(JOB_GATE_POLL_MS); continue; }
            await runOcrJob(job).catch((e) => console.warn('[media-gateway] ocr job error', String((e && e.message) || e)));
        }
    } finally { ocrBusy = false; }
}

// Extract one image-subtitle track to a self-contained .sup (PGS) with `-c:s copy` (no re-encode,
// no decode) so ocr_pgs.py gets the raw PGS bitstream with its PTS intact. Resolves the file path
// or null on failure / empty output.
// Resolves { ok:true, path } or { ok:false, error } (the ffmpeg stderr tail), so the OCR callback can
// surface WHY extraction failed (the audio path's opaque "failed" cost real debugging time). Subtitle
// streams are sparse across the file, so `-c:s copy` must demux the whole input — index is the
// absolute ffprobe stream index from the probe.
function extractSubtitleSup(url, ua, trackIndex, timeoutMs = SUP_EXTRACT_TIMEOUT_MS, proxyKey = '') {
    return new Promise((resolve) => {
        const outputPath = path.join(os.tmpdir(), `norva-sub-${Date.now()}-${crypto.randomUUID()}.sup`);
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-user_agent', ua,
            '-probesize', '5000000', '-analyzeduration', '8000000',
            '-i', url,
            '-map', `0:${trackIndex}`,
            '-c:s', 'copy', '-f', 'sup',
            outputPath,
        ];
        let child;
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKey || proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e) }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                console.warn(`[media-gateway] sup-extract ffmpeg exit ${code}: ${redactCreds(stderr.slice(-300))}`);
                fsp.unlink(outputPath).catch(() => {});
                // redactCreds: the stderr line quotes the provider URL, whose path embeds the
                // account's username/password — this string lands verbatim in the DB/admin UI.
                return resolve({ ok: false, error: `ffmpeg exit ${code}: ${redactCreds(stderr.trim().split('\n').pop() || 'no stderr')}` });
            }
            let size = 0;
            try { size = (await fsp.stat(outputPath)).size; } catch (_) { size = 0; }
            if (size <= 64) { fsp.unlink(outputPath).catch(() => {}); return resolve({ ok: false, error: `empty .sup (${size}B) — no PGS packets on stream ${trackIndex}` }); }
            resolve({ ok: true, path: outputPath });
        });
    });
}

// Run ocr_pgs.py on a .sup: pipe { sup, lang } in on stdin, read the WebVTT from stdout.
// Resolves { ok, vtt } or { ok:false, error } (the script emits a JSON error on stderr + exit code).
function runOcrPython(supPath, lang) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(OCR_PYTHON_BIN, [OCR_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, OCR_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e) }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && out.trim()) return resolve({ ok: true, vtt: out });
            let msg = `ocr exit ${code}`;
            try { const j = JSON.parse((err.trim().split('\n').pop() || '')); if (j && j.error) msg = j.error; } catch (_) {}
            resolve({ ok: false, error: msg });
        });
        try { child.stdin.write(JSON.stringify({ sup: supPath, lang })); child.stdin.end(); } catch (_) { /* close handler resolves */ }
    });
}

// VOBSUB/DVB: render the image-sub track to timed PNGs with ffmpeg's sub2video filter (decodes the
// bitmap stream; showinfo logs each frame's PTS) into a temp dir + showinfo.log. Resolves
// { ok:true, dir } or { ok:false, error } (the ffmpeg error tail). One ffmpeg pass over the URL.
function extractSubtitleFrames(url, ua, trackIndex, timeoutMs = SUP_EXTRACT_TIMEOUT_MS, proxyKey = '') {
    return new Promise((resolve) => {
        const dir = path.join(os.tmpdir(), `norva-imgsub-${Date.now()}-${crypto.randomUUID()}`);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return resolve({ ok: false, error: 'mkdir failed: ' + String((e && e.message) || e) }); }
        const args = [
            '-y', '-hide_banner', '-loglevel', 'info', '-nostdin',
            '-user_agent', ua,
            '-probesize', '5000000', '-analyzeduration', '8000000',
            '-i', url,
            // sub2video is auto-inserted before showinfo; native sub resolution (resolution-agnostic).
            '-filter_complex', `[0:${trackIndex}]showinfo[v]`,
            '-map', '[v]', '-vsync', 'passthrough', '-start_number', '0',
            path.join(dir, 'f_%05d.png'),
        ];
        let child;
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKey || proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        // showinfo is verbose (one line/frame) — keep the tail bounded but enough for a long film.
        child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 24_000_000) stderr = stderr.slice(-16_000_000); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e), dir }); });
        child.on('close', async (code) => {
            clearTimeout(timer);
            try { await fsp.writeFile(path.join(dir, 'showinfo.log'), stderr); } catch (_) { /* python falls back to file order */ }
            let nframes = 0;
            try { nframes = (await fsp.readdir(dir)).filter((f) => f.endsWith('.png')).length; } catch (_) { nframes = 0; }
            if (code !== 0 && !nframes) {
                const tail = redactCreds(stderr.split('\n').filter(Boolean).pop() || 'no stderr');
                console.warn(`[media-gateway] imgsub-extract ffmpeg exit ${code}: ${tail}`);
                return resolve({ ok: false, error: `ffmpeg exit ${code}: ${tail}`, dir });
            }
            if (!nframes) return resolve({ ok: false, error: `no subtitle frames rendered on stream ${trackIndex}`, dir });
            resolve({ ok: true, dir });
        });
    });
}

// Run ocr_imgsub.py on a rendered frame dir: pipe { dir, lang } in, read the WebVTT from stdout.
function runOcrImgsubPython(frameDir, lang) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(OCR_PYTHON_BIN, [OCR_SCRIPT_IMGSUB], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env }, cwd: __dirname });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, OCR_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e) }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && out.trim()) return resolve({ ok: true, vtt: out });
            let msg = `ocr exit ${code}`;
            try { const j = JSON.parse((err.trim().split('\n').pop() || '')); if (j && j.error) msg = j.error; } catch (_) {}
            resolve({ ok: false, error: msg });
        });
        try { child.stdin.write(JSON.stringify({ dir: frameDir, lang })); child.stdin.end(); } catch (_) { /* close handler resolves */ }
    });
}

// Provider panels allow a single concurrent connection, and extracting an image-sub track demuxes the
// whole file (sparse packets) → a long-held connection that collides with the panel's limit. So a
// transient `429`-style 4XX gets a couple of LONG, well-spaced retries — never a burst, because
// bursting is exactly what trips a panel's abuse protection into a temporary 401/403 block. An
// auth/abuse block is NOT retried here: backing off entirely (let the off-peak cron try much later) is
// the only safe move.
const OCR_EXTRACT_RETRIES = clampInt(process.env.OCR_EXTRACT_RETRIES, 2, 0, 5);
const OCR_EXTRACT_BACKOFF_MS = clampInt(process.env.OCR_EXTRACT_BACKOFF_MS, 30_000, 5_000, 300_000);
async function runOcrJob(job) {
    const { url, ua, index, jobId, callbackUrl, lang, fmt = 'pgs', uid = '' } = job;
    const useFrames = fmt === 'vobsub' || fmt === 'dvb';  // sub2video path; else PGS .sup parser
    let supPath = null, frameDir = null, payload;
    try {
        postJobHeartbeat(job, 'extracting');
        let ex = { ok: false, error: 'not attempted' };
        for (let attempt = 0; attempt <= OCR_EXTRACT_RETRIES; attempt++) {
            // Account lock per ATTEMPT (not around the loop): the 30/60 s backoff sleeps must not
            // hold the account's slot — another lane may legitimately use it between our tries.
            ex = await withAccountJobLock(accountJobKey(uid, url), () =>
                useFrames ? extractSubtitleFrames(url, ua, index, SUP_EXTRACT_TIMEOUT_MS, uid) : extractSubtitleSup(url, ua, index, SUP_EXTRACT_TIMEOUT_MS, uid));
            if (ex.ok) break;
            if (ex.dir) { fsp.rm(ex.dir, { recursive: true, force: true }).catch(() => {}); ex.dir = null; } // drop partial dir
            if (/\b(401|403)\b|Unauthorized|Forbidden/i.test(ex.error || '')) break; // abuse/auth block — do not hammer
            if (attempt < OCR_EXTRACT_RETRIES) await sleep(OCR_EXTRACT_BACKOFF_MS * (attempt + 1)); // 30s, 60s — spaced, not a burst
        }
        // OCR demuxes the whole input too (`-c:s copy` walks the file) — same per-provider
        // cooldown as a transcription once the attempts are done.
        markTranscribeRun(url);
        if (!ex.ok) {
            payload = { jobId, ok: false, error: ('Subtitle extraction failed: ' + ex.error).slice(0, 300) };
        } else {
            let r;
            if (useFrames) { frameDir = ex.dir; r = await runOcrImgsubPython(frameDir, lang || OCR_LANGS); }
            else { supPath = ex.path; r = await runOcrPython(supPath, lang || OCR_LANGS); }
            const segments = r.ok ? (r.vtt.match(/-->/g) || []).length : 0;
            payload = (r.ok && segments > 0)
                ? { jobId, ok: true, vtt: r.vtt, segments, sourceLang: null }
                : { jobId, ok: false, error: String(r.error || 'OCR produced no cues').slice(0, 300) };
        }
    } catch (e) {
        payload = { jobId, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    } finally {
        if (supPath) fsp.unlink(supPath).catch(() => {});
        if (frameDir) fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    }
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) { console.warn('[media-gateway] ocr callback failed', jobId, String((e && e.message) || e)); }
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

        // Stale engine byte-pipes on the same account hold the same provider slot as
        // the transcode about to start (the engine just failed over here) — abort them
        // like any other conflicting session so ffmpeg doesn't open against a 458.
        stoppedConflictingSessions += abortRawPumps(
            (p) => p.proxyKey === proxyKeyFromUrl(sourceUrl), null, 'transcode session start');
        // A background extraction (whisper/storyboard) mid-film on this account would fight the
        // viewer for the single slot for MINUTES — the viewer wins, the job re-queues as deferred.
        stoppedConflictingSessions += preemptAccountExtractions(proxyKeyFromUrl(sourceUrl), 'transcode session start');

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
            // Slot-busy upstream → a typed, retryable error. The "(HTTP 458 max
            // connections)" token also keeps the web client's text classifiers
            // matching (ffmpeg's own message never contains the number 458).
            if (isProviderSlotBusyFailure(session)) {
                res.set('Retry-After', '8');
                return res.status(503).json({
                    error: 'Provider connection slot busy',
                    code: 'PROVIDER_BUSY',
                    upstreamStatus: 458,
                    retryAfter: 8,
                    details: `${detail} (HTTP 458 max connections)`
                });
            }
            return res.status(502).json({
                error: 'Failed to start media session',
                details: detail
            });
        }
        await observeSessionStartOffset(session);

        res.status(201).json({
            id,
            status: session.status,
            mode: session.mode,
            audioMode: audioModeForSession(session),
            videoMode: videoModeForSession(session),
            audioStreamIndex: session.audioStreamIndex,
            requestedSeekOffset: session.seekOffset || 0,
            actualStartOffset: session.actualStartOffset || 0,
            localSeekTarget: session.localSeekTarget || 0,
            sourceTimestamps: session.sourceTimestamps === true,
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

// Cross-device kill-switch used by the relay's ProviderSessionCoordinator: abort
// every live raw byte-pipe registered for an owner (keyed by sha256(userId) — the
// coordinator only ever stores hashes, never credentials or raw ids).
app.delete('/raw-pumps', requireGatewayAuth, (req, res) => {
    const ownerKey = String(req.query.ownerKey || req.body?.ownerKey || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(ownerKey)) return res.status(400).json({ error: 'ownerKey (sha256 hex) required' });
    const sid = String(req.query.sid || req.body?.sid || '').trim();
    const globalCleanup = req.query.global === '1' || req.body?.global === true;
    if (!sid && !globalCleanup) {
        return res.status(400).json({ error: 'sid required (or global=1 for explicit owner cleanup)' });
    }
    const aborted = abortRawPumps(
        (p) => p.ownerHash === ownerKey && (globalCleanup || p.sid === sid),
        null,
        globalCleanup ? 'explicit owner eviction' : `coordinator eviction ${sid.slice(0, 8)}`
    );
    res.json({ ok: true, aborted });
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
    if (WHISPER_BIN && WHISPER_MODEL) {
        [WHISPER_BIN_SHA256, WHISPER_MODEL_SHA256] = await Promise.all([
            hashFileSha256(WHISPER_BIN),
            hashFileSha256(WHISPER_MODEL),
        ]);
        WHISPER_RUNTIME_VERIFIED = Boolean(
            WHISPER_BIN_BUILD_SHA256 &&
            WHISPER_MODEL_BUILD_SHA256 &&
            WHISPER_BIN_SHA256 === WHISPER_BIN_BUILD_SHA256 &&
            WHISPER_MODEL_SHA256 === WHISPER_MODEL_BUILD_SHA256
        );
        if (!WHISPER_RUNTIME_VERIFIED) {
            console.warn('[media-gateway] Whisper runtime hashes do not match the pinned build');
        }
    }
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
    return isProviderSlotBusyFailure(session)
        || text.includes('401')
        || text.includes('unauthorized')
        || text.includes('403')
        || text.includes('forbidden')
        || text.includes('connection timed out')
        || text.includes('connection reset')
        || text.includes('-10053')
        || text.includes('-10054');
}

// The provider's "max connections" slot-busy state specifically. CRITICAL detail:
// ffmpeg (libavformat http.c) reports an upstream 458 as the literal stderr string
// "Server returned 4XX Client Error, but not one of 40{0,1,3,4}" — the number 458
// never appears — so that catch-all IS the 458 signature on the transcode lane.
function isProviderSlotBusyFailure(session) {
    const text = String((session && session.lastError) || '').toLowerCase();
    if (!text) return false;
    return text.includes('458')
        || text.includes('max connection')
        || text.includes('429')
        || text.includes('too many requests')
        || text.includes('4xx client error, but not one of');
}

// Start FFmpeg and wait for the first playlist. If startup fails because the
// provider's single connection slot wasn't free yet (401/403/timeout), wait for
// the slot to release and retry, instead of bubbling a 502 that pushes the web
// client into a relay/direct fallback it can never play (e.g. MKV in-browser).
async function startSessionWithProviderRetry(session) {
    // Slot-busy (458) gets its own, longer ladder: the provider frees the slot ~8s
    // after the previous consumer drops, so 2s/6s/9s spans the release window.
    // Plain auth failures keep the single fast retry (fast-fail on dead channels).
    const SLOT_BUSY_RETRY_DELAYS_MS = [2000, 6000, 9000];
    const maxAttempts = 1 + Math.max(PROVIDER_AUTH_RETRY_LIMIT, SLOT_BUSY_RETRY_DELAYS_MS.length);
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
            const slotBusy = isProviderSlotBusyFailure(session);
            const authRetryBudget = 1 + PROVIDER_AUTH_RETRY_LIMIT;
            if (attempt >= maxAttempts
                || !isProviderConcurrencyFailure(session)
                || (!slotBusy && attempt >= authRetryBudget)) return false;
            const waitMs = slotBusy
                ? SLOT_BUSY_RETRY_DELAYS_MS[Math.min(attempt - 1, SLOT_BUSY_RETRY_DELAYS_MS.length - 1)]
                : PROVIDER_AUTH_RETRY_DELAY_MS;
            console.warn(`[media-gateway] provider ${slotBusy ? 'slot busy (458)' : 'auth failure'} for ${session.id} (attempt ${attempt}/${maxAttempts}); waiting ${waitMs}ms before retry`);
            await sleep(waitMs);
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
    const preserveCopySeekTimestamps = usesSourceTimestampedCopySeek(session, encodeVideo);
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
        ...(preserveCopySeekTimestamps ? ['-copyts'] : []),
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
        ...(preserveCopySeekTimestamps
            ? ['-avoid_negative_ts', 'disabled', '-mpegts_copyts', '1', '-muxpreload', '0', '-muxdelay', '0']
            : []),
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

function usesSourceTimestampedCopySeek(session, encodeVideo = session.mode === 'transcode' || !shouldCopyVideo(session)) {
    return !encodeVideo && Number(session.seekOffset) > 0;
}

async function observeSessionStartOffset(session) {
    const requested = Number(session.seekOffset) > 0 ? Math.floor(Number(session.seekOffset)) : 0;
    session.actualStartOffset = requested;
    session.localSeekTarget = 0;
    session.sourceTimestamps = false;
    if (!usesSourceTimestampedCopySeek(session) || requested <= 0) return;

    try {
        const deadline = Date.now() + 5_000;
        let firstSegment = '';
        while (Date.now() < deadline) {
            const files = await fsp.readdir(session.outputDir).catch(() => []);
            firstSegment = files.filter((name) => /^segment-\d+\.ts$/i.test(name)).sort()[0] || '';
            if (firstSegment) break;
            await sleep(50);
        }
        if (!firstSegment) throw new Error('first HLS segment not ready');
        const segmentPath = path.join(session.outputDir, firstSegment);
        const payload = await runFfprobe([
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=start_time',
            '-print_format', 'json',
            segmentPath,
        ], 5_000, segmentPath);
        const observed = Number(payload?.streams?.[0]?.start_time);
        if (!Number.isFinite(observed) || observed < 0 || observed > requested + 1) {
            throw new Error(`invalid first video PTS ${String(payload?.streams?.[0]?.start_time)}`);
        }
        session.actualStartOffset = Math.max(0, observed);
        session.localSeekTarget = Math.max(0, requested - session.actualStartOffset);
        session.sourceTimestamps = true;
    } catch (error) {
        // Fail safe: playback remains usable at the requested session offset.
        // The client only performs the local fine seek when measurement succeeds.
        console.warn(`[media-gateway] unable to measure exact copy-seek start for ${session.id}: ${error.message || error}`);
    }
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
        // MPEG-TS (and other stream containers) carry no global duration, so ffprobe leaves
        // format.duration empty even when it knows the overall bit rate and file size. Fall back to
        // size*8/bitrate (CBR estimate — plenty accurate to draw a seek bar) so an on-the-fly TS
        // transcode still gets a timeline instead of a duration-less, unseekable player.
        durationSeconds: nullableFloat(format.duration) || estimateDurationFromFormat(format),
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
    // Live/channel TS is an endless stream — never probe it (ffprobe would hang). VOD is finite.
    if (streamType === 'live' || streamType === 'channel') return false;
    // m3u8 is a playlist, not a probeable media file. NOTE: `ts` is intentionally NOT skipped here —
    // a VOD .ts movie (very common on IPTV) is a finite file we DO want to probe, both for its codec
    // metadata and, crucially, its duration (→ durationSeconds → the player's seek bar). Live TS is
    // already excluded above, so allowing it here only affects on-demand titles.
    const container = String(hint.container || '').toLowerCase();
    if (container === 'm3u8') return false;
    try {
        const extension = path.extname(new URL(sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        if (extension === 'm3u8') return false;
        return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'mpeg', 'mpg', 'vob', 'ts', 'm2ts', 'mts'].includes(extension)
            || streamType === 'movie' || streamType === 'series';
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
        requestedSeekOffset: session.seekOffset || 0,
        actualStartOffset: session.actualStartOffset || 0,
        localSeekTarget: session.localSeekTarget || 0,
        sourceTimestamps: session.sourceTimestamps === true,
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
        requestedSeekOffset: session.seekOffset || 0,
        actualStartOffset: session.actualStartOffset || 0,
        localSeekTarget: session.localSeekTarget || 0,
        sourceTimestamps: session.sourceTimestamps === true,
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
    if (status === 458) {
        return {
            status: 503,
            code: 'PROVIDER_BUSY',
            publicMessage: 'IPTV provider connection slot busy (HTTP 458 max connections). Retry in a few seconds.'
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

// Estimate media duration from an ffprobe `format` block when it has no `duration` (e.g. MPEG-TS):
// seconds ≈ size_bytes * 8 / overall_bit_rate. CBR approximation — good enough for a scrub bar.
// Returns null unless both size and bit rate are known and the result is a sane (0, 24h) value.
function estimateDurationFromFormat(format) {
    const size = nullableFloat(format && format.size);
    const bitRate = nullableFloat(format && format.bit_rate);
    if (!size || size <= 0 || !bitRate || bitRate <= 0) return null;
    const seconds = (size * 8) / bitRate;
    return Number.isFinite(seconds) && seconds > 0 && seconds < 24 * 60 * 60 ? seconds : null;
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

function readBuildDigest(filePath) {
    try {
        const digest = fs.readFileSync(filePath, 'utf8').trim().toLowerCase();
        return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
    } catch (_) {
        return null;
    }
}

function hashFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

async function readContainerCpuUsageMs() {
    try {
        const stat = await fsp.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
        const match = stat.match(/^usage_usec\s+(\d+)$/m);
        return match ? Number(match[1]) / 1000 : null;
    } catch (_) {
        return null;
    }
}

function lidProductionCpuBusy() {
    return Boolean(
        whisperInferenceActive > 0 ||
        argosInferenceActive > 0 ||
        accountJobLocks.size > 0 ||
        transcribeBusy ||
        translateBusy ||
        ocrBusy ||
        transcribeQueue.length ||
        translateQueue.length ||
        ocrQueue.length
    );
}

function rejectWhileLidBenchmarkRuns(res) {
    if (!lidBenchmarkBusy) return false;
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'LID benchmark temporarily owns the inference lane' });
    return true;
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

// ── Provider account-activity reporter (2026-07-10 458 incident) ────────────────────────────────
// Every ~60s, report to the edge (norva-playback POST /account-activity) the provider ACCOUNTS
// this box is currently holding a connection for: viewer transcode sessions, engine raw pumps,
// and background ffmpeg extractions. The edge's autonomous probe crawl reads that table
// (provider_account_busy) and yields the account's single connection slot — this reporter is the
// signal WRITER for web Live TV, whose per-user session signals go dark ~4 min into viewing.
// Additive + fail-open: nothing in the media path depends on it; a failed POST is just logged
// once per hour. Disable with ACCOUNT_ACTIVITY_REPORT_MS=0.
// The edge base URL is PINNED to NORVA_EDGE_CALLBACK_BASE (e.g.
// https://<ref>.supabase.co/functions/v1/norva-playback). It is NOT learned from job callbackUrls:
// that would (a) leave the reporter inert after every redeploy until an unrelated job happens to
// run, and (b) let a callbackUrl steer where the GATEWAY_TOKEN-bearing POST goes. Env-only removes
// both. If unset, the reporter stays idle (logged at startup) and the lock degrades gracefully to
// the edge-side session/event/history writers.
const ACCOUNT_ACTIVITY_REPORT_MS = clampInt(process.env.ACCOUNT_ACTIVITY_REPORT_MS, 60_000, 0, 300_000);
const edgeCallbackBase = (process.env.NORVA_EDGE_CALLBACK_BASE || '').replace(/\/+$/, '');
// The account activity key is host + '/' + username. proxyKeyFromUrl keeps the username
// percent-ENCODED (it is the raw path segment) so the sticky proxy pool key is stable; but the
// edge stores the DECODED username (provider_account_touch_by_source writes config_hint.username
// raw). Decode the username part before reporting so all producers converge on the decoded form.
function decodeAccountKey(key) {
    const s = String(key || '');
    const i = s.indexOf('/');
    if (i < 0) return s;
    let user = s.slice(i + 1);
    try { user = decodeURIComponent(user); } catch { /* keep raw on malformed % */ }
    return s.slice(0, i) + '/' + user;
}
function activeProviderAccountKeys() {
    const keys = new Set();
    for (const s of sessions.values()) {
        if (s && s.sourceUrl && isSessionBlockingProviderSlot(s)) keys.add(proxyKeyFromUrl(s.sourceUrl));
    }
    for (const p of rawPumps) { if (p && p.proxyKey) keys.add(p.proxyKey); }
    for (const [key, entries] of accountExtractions) {
        if ([...entries].some((entry) => entry.reportActivity !== false)) keys.add(key);
    }
    keys.delete('');
    return [...keys].map(decodeAccountKey).slice(0, 64);
}
let _accountActivityLastErrorAt = 0;
async function reportAccountActivity() {
    if (!ACCOUNT_ACTIVITY_REPORT_MS || !GATEWAY_TOKEN || !edgeCallbackBase) return;
    const keys = activeProviderAccountKeys();
    if (!keys.length) return;
    try {
        const res = await fetch(`${edgeCallbackBase}/account-activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ keys, kind: 'gateway' }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok && Date.now() - _accountActivityLastErrorAt > 60 * 60 * 1000) {
            _accountActivityLastErrorAt = Date.now();
            console.warn(`[media-gateway] account-activity report failed: HTTP ${res.status}`);
        }
    } catch (err) {
        if (Date.now() - _accountActivityLastErrorAt > 60 * 60 * 1000) {
            _accountActivityLastErrorAt = Date.now();
            console.warn('[media-gateway] account-activity report failed:', (err && err.message) || err);
        }
    }
}
if (ACCOUNT_ACTIVITY_REPORT_MS > 0) {
    if (edgeCallbackBase) {
        console.log(`[media-gateway] account-activity reporter ON (every ${ACCOUNT_ACTIVITY_REPORT_MS}ms → ${edgeCallbackBase}/account-activity)`);
    } else {
        console.warn('[media-gateway] account-activity reporter IDLE — set NORVA_EDGE_CALLBACK_BASE to enable (busy-lock falls back to edge-side session/event/history writers)');
    }
    setInterval(() => { reportAccountActivity(); }, ACCOUNT_ACTIVITY_REPORT_MS).unref();
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
