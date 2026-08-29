const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns');
const net = require('net');
const { PassThrough } = require('stream');
const { TextDecoder } = require('util');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { Agent, ProxyAgent, request: undiciRequest } = require('undici');
const { parseWhisperLid, runWhisperDetectOnly } = require('./whisper-lid');
const {
    buildStrictLidExtractionObservability,
    buildStrictLidUnverifiedObservability,
    cleanupStrictLidFiles,
    evaluateStrictTranscriptEvidence,
    resolveStrictLidConsensus,
    runWhisperBatchProcess,
    normalizeStrictLidTimelineDurationSeconds,
    strictLidBatchFailureResponse,
    strictLidBatchOutcome,
    strictLidTimelineOffsets,
} = require('./strict-lid-batch');
const {
    STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
    STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
    STRICT_LID_WINDOW_METHOD,
    StrictLidWindowCheckpointError,
    createStrictLidWindowReceipt,
    openStrictLidWindowReceipt,
    validateStrictLidWindowReceiptsInput,
} = require('./strict-lid-window-checkpoint');
const {
    classifyProviderFetchFailure,
    classifyProviderResponseFailure,
    isProxyAuthenticationFailure,
    shouldRetryProviderStatus,
} = require('./providerFailure');
const {
    parseProviderProxyUrls,
    parseProviderProxySlotOverrides,
    providerAccountAffinityKey,
    providerAccountAffinityKeyFromCredentials,
    proxySlotIndexForAccount,
} = require('./providerProxyPool');
const {
    CompleteMkvHlsCache,
    MkvHlsCacheError,
} = require('./mkv-hls-cache');
const {
    preflightVideoEncoder,
    publicVideoEncoderStatus,
    resolveVideoEncoderConfig,
    videoEncoderInputArgs,
    videoEncoderOutputArgs,
} = require('./video-encoder');

const app = express();

// Residential proxy POOL for ALL outbound provider traffic. Some IPTV providers
// 458/block datacenter IPs (e.g. Railway) while serving residential IPs fine; routing
// the gateway's provider requests through residential proxies makes the provider see a
// residential exit IP.
//
//   PROVIDER_PROXY_URLS  comma/space/newline-separated list of proxy URLs
//                        (e.g. http://user:pass@host:port). Used as a POOL.
//   PROVIDER_PROXY_URL   single URL (back-compat fallback when the plural is absent).
//   PROVIDER_PROXY_SLOT_OVERRIDES  optional service-only JSON map whose keys are
//                        sha256(provider-account) and whose values are slots 1..5.
//                        Used only for bounded operator A/B and emergency egress repair.
//
// Each provider ACCOUNT is pinned to ONE pool IP (sticky by the canonical provider
// host+username identity). The Norva user id is deliberately never part of proxy affinity:
// the same provider credentials must use the same egress on raw, metadata and FFmpeg lanes.
// Stickiness matters: a single account
// hitting from many IPs looks like a proxy and gets flagged; one stable residential IP
// per account looks normal. Across many users the pool spreads load over the IPs (less
// density per IP, more aggregate bandwidth). undici is only loaded when a proxy is set.
// Secrets live in env only — never commit them.
const providerProxyUrls = parseProviderProxyUrls(
    process.env.PROVIDER_PROXY_URLS || process.env.PROVIDER_PROXY_URL || '',
);
const providerProxySlotOverrides = parseProviderProxySlotOverrides(
    process.env.PROVIDER_PROXY_SLOT_OVERRIDES || '',
    providerProxyUrls.length,
);
let providerProxyAgents = [];
if (providerProxyUrls.length) {
    try {
        providerProxyAgents = providerProxyUrls.map((u) => new ProxyAgent(u));
        // Fetch receives an explicit dispatcher and every provider-connected child receives
        // an explicit env. There is intentionally no process-wide "slot 1" fallback: it would
        // silently break account affinity whenever a provider spawn forgot its routing key.
        console.log(`[media-gateway] provider proxy ENABLED — pool of ${providerProxyAgents.length} residential IP(s), sticky per account`);
    } catch (err) {
        // Fail closed. Falling back to Railway's direct datacenter IP after a proxy
        // configuration error can trigger provider bans and makes a 407 look like a 458.
        const failureKind = String((err && (err.code || err.name)) || 'unknown');
        throw new Error(`Provider proxy pool could not be initialised (${failureKind})`);
    }
}
// FNV-1a hash → stable index into the pool for a given key (same key → same IP).
function poolIndexForKey(key) {
    if (providerProxyAgents.length <= 1) return 0;
    return proxySlotIndexForAccount(key, providerProxyAgents.length, providerProxySlotOverrides);
}
// Per-account sticky key from a provider stream URL: host + the username path segment
// (Xtream: /movie|series|live/USER/PASS/ID.ext → USER), falling back to the host.
function proxyKeyFromUrl(url) {
    return providerAccountAffinityKey(url);
}
// Sticky proxy affinity is not, by itself, a safe destructive account identity:
// host + username can be imitated by an opaque M3U URL and different tenants can
// legitimately share that host. A cross-owner slot is therefore recognized only
// from the complete Xtream capability (host + username + password), held as a
// one-way hash. Every other URL is scoped by the Edge-derived owner hash.
function providerSlotKeyFromUrl(url, ownerKey = '') {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        return `source:${sha256Hex(String(url || ''))}`;
    }
    const host = parsed.host.toLowerCase();
    let username = String(parsed.searchParams.get('username') || '');
    let password = String(parsed.searchParams.get('password') || '');
    if (!username.trim() || !password.length) {
        const segments = parsed.pathname.split('/').filter(Boolean);
        const streamTypeIndex = segments.findIndex((segment) =>
            ['movie', 'series', 'live'].includes(String(segment || '').toLowerCase()));
        if (streamTypeIndex >= 0 && segments[streamTypeIndex + 1] && segments[streamTypeIndex + 2]) {
            const decoded = (value) => {
                try { return decodeURIComponent(value); } catch (_) { return String(value || ''); }
            };
            username = decoded(segments[streamTypeIndex + 1]);
            password = decoded(segments[streamTypeIndex + 2]);
        }
    }
    if (host && username.trim() && password.length) {
        return `account:${sha256Hex(`${host}\0${username}\0${password}`)}`;
    }
    const normalizedOwnerKey = normalizeSessionKey(ownerKey);
    if (normalizedOwnerKey) return `owner:${normalizedOwnerKey}/${host}`;
    return `source:${sha256Hex(String(url || ''))}`;
}
function providerAccountKeyFromCredentials(serverUrl, username) {
    return providerAccountAffinityKeyFromCredentials(serverUrl, username);
}
// ── Raw byte-pipe ledger ─────────────────────────────────────────────────────
// One playback session per provider account: pumps are tagged with their playback
// session id (claims.sid). A NEW session's first /raw aborts pumps left by a PRIOR
// session on the same account (an engine crash/retry leaves the old pump draining —
// exactly what keeps a single-slot provider answering 458), a conflicting transcode
// start aborts them all, and the relay's session coordinator can evict them
// cross-device via DELETE /raw-pumps (keyed by sha256(userId) — no credentials).
const rawPumps = new Set(); // { ac, sid, proxyKey, providerSlotKey, ownerHash }
// A transcode request performs asynchronous teardown and codec probing before it can
// register its session. Reserve viewer priority across that whole window so a
// service/pregen job cannot win the spawn race and consume the single replica's CPU.
const viewerStartupReservations = new Set();
// Viewer session creation itself is serialized per provider account. Without
// this short lock, two concurrent POST /sessions calls can both finish teardown
// and open their size/codec probes before either has inserted a session.
const viewerSessionStartupLocks = new Map(); // key -> { held, waiters[] }
const viewerSessionStartupAdmissions = new Set();
const viewerSessionStartupAdmissionCounts = new Map();
const viewerSessionStartupAdmissionStats = {
    accepted: 0,
    rejected: 0,
    aborted: 0,
};
function reserveViewerStartup() {
    const token = Symbol('viewer-startup');
    viewerStartupReservations.add(token);
    return token;
}
function releaseViewerStartup(token) {
    if (!token || !viewerStartupReservations.delete(token)) return;
    wakePlaybackBlockedQueues();
}
function viewerSessionStartupError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function tryAdmitViewerSessionStartup(ownerKey, providerKey) {
    const keys = [
        providerKey ? `provider:${providerKey}` : '',
        ownerKey ? `owner:${ownerKey}` : '',
    ].filter(Boolean);
    if (
        viewerSessionStartupAdmissions.size >= MAX_VIEWER_SESSION_STARTUP_ADMISSIONS
        || keys.some((key) => (
            Number(viewerSessionStartupAdmissionCounts.get(key) || 0)
            >= MAX_VIEWER_SESSION_STARTUPS_PER_KEY
        ))
    ) {
        viewerSessionStartupAdmissionStats.rejected += 1;
        return null;
    }
    const token = { keys, released: false };
    viewerSessionStartupAdmissions.add(token);
    for (const key of keys) {
        viewerSessionStartupAdmissionCounts.set(
            key,
            Number(viewerSessionStartupAdmissionCounts.get(key) || 0) + 1,
        );
    }
    viewerSessionStartupAdmissionStats.accepted += 1;
    return token;
}
function releaseViewerSessionStartupAdmission(token) {
    if (!token || token.released) return;
    token.released = true;
    viewerSessionStartupAdmissions.delete(token);
    for (const key of token.keys || []) {
        const next = Math.max(0, Number(viewerSessionStartupAdmissionCounts.get(key) || 0) - 1);
        if (next) viewerSessionStartupAdmissionCounts.set(key, next);
        else viewerSessionStartupAdmissionCounts.delete(key);
    }
}
function createViewerSessionStartupLockRelease(key, state) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = state.waiters.shift();
        if (next) {
            next.detach();
            next.resolve(createViewerSessionStartupLockRelease(key, state));
            return;
        }
        state.held = false;
        if (viewerSessionStartupLocks.get(key) === state) viewerSessionStartupLocks.delete(key);
    };
}
function acquireViewerSessionStartupLock(key, signal = null) {
    if (!key) return Promise.resolve(() => {});
    if (signal?.aborted) {
        return Promise.reject(viewerSessionStartupError(
            'VIEWER_STARTUP_ABORTED',
            'Viewer session startup was aborted while waiting for admission',
        ));
    }
    let state = viewerSessionStartupLocks.get(key);
    if (!state) {
        state = { held: true, waiters: [] };
        // This synchronous map insertion is the /raw exclusion boundary.
        viewerSessionStartupLocks.set(key, state);
        return Promise.resolve(createViewerSessionStartupLockRelease(key, state));
    }
    if (state.waiters.length >= MAX_VIEWER_SESSION_STARTUPS_PER_KEY - 1) {
        return Promise.reject(viewerSessionStartupError(
            'VIEWER_STARTUP_BUSY',
            'Viewer session startup queue is full',
        ));
    }
    return new Promise((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
            onAbort: null,
            detach() {
                signal?.removeEventListener?.('abort', waiter.onAbort);
            },
        };
        waiter.onAbort = () => {
            const index = state.waiters.indexOf(waiter);
            if (index >= 0) state.waiters.splice(index, 1);
            waiter.detach();
            viewerSessionStartupAdmissionStats.aborted += 1;
            reject(viewerSessionStartupError(
                'VIEWER_STARTUP_ABORTED',
                'Viewer session startup was aborted while waiting for a lock',
            ));
        };
        state.waiters.push(waiter);
        signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
    });
}
async function acquireViewerSessionStartupLocks(ownerKey, providerKey, signal = null) {
    const releases = [];
    try {
        // Reserve the provider synchronously before the first await. /raw checks
        // this map before opening its socket, so an owner-lock wait must not leave
        // a gap in which the old Engine lane can reclaim the mono-account slot.
        // Every caller uses the same provider -> owner order, so the two-key
        // serialization cannot form a lock cycle.
        const providerRelease = providerKey
            ? acquireViewerSessionStartupLock(`provider:${providerKey}`, signal)
            : null;
        if (providerRelease) releases.push(await providerRelease);
        if (ownerKey) releases.push(await acquireViewerSessionStartupLock(`owner:${ownerKey}`, signal));
    } catch (error) {
        for (const release of releases.reverse()) release();
        throw error;
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        for (const release of releases.reverse()) release();
    };
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
const activeViewerSubtitleOperations = new Set(); // provider-account keys
const activeViewerSubtitlePrincipals = new Set(); // hashed uid (one active operation across sources)
const queuedViewerSubtitlePrincipals = new Set(); // hashed uid (one bounded waiter per subscriber)
const viewerSubtitleWaitQueue = []; // FIFO waiters; oldest eligible principal wins
const viewerSubtitleRateWindows = new Map(); // hashed uid -> recent admitted request timestamps
function viewerSubtitlePrincipalKey(claims) {
    // Current playback capabilities always carry uid. Collapse legacy/malformed
    // signed capabilities into one conservative bucket instead of letting a
    // missing uid create unlimited per-source principals.
    return sha256Hex(`viewer-subtitle|${String(claims?.uid || 'legacy')}`);
}
function createViewerSubtitleOperation(proxyKey, principalKey) {
    activeViewerSubtitleOperations.add(proxyKey);
    activeViewerSubtitlePrincipals.add(principalKey);
    let released = false;
    return {
        ok: true,
        proxyKey,
        principalKey,
        release() {
            if (released) return;
            released = true;
            activeViewerSubtitleOperations.delete(proxyKey);
            activeViewerSubtitlePrincipals.delete(principalKey);
            drainViewerSubtitleWaitQueue();
        },
    };
}
function viewerSubtitleSlotAvailable(proxyKey, principalKey) {
    return (
        activeViewerSubtitleOperations.size < MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS
        && !activeViewerSubtitleOperations.has(proxyKey)
        && !activeViewerSubtitlePrincipals.has(principalKey)
    );
}
function drainViewerSubtitleWaitQueue() {
    while (
        viewerSubtitleWaitQueue.length
        && activeViewerSubtitleOperations.size < MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS
    ) {
        const index = viewerSubtitleWaitQueue.findIndex((waiter) =>
            viewerSubtitleSlotAvailable(waiter.proxyKey, waiter.principalKey));
        if (index < 0) return;
        const waiter = viewerSubtitleWaitQueue[index];
        waiter.finish(createViewerSubtitleOperation(waiter.proxyKey, waiter.principalKey));
    }
}
async function reserveViewerSubtitleOperation(claims, response) {
    const proxyKey = proxyKeyFromUrl(claims?.url || '');
    if (!proxyKey) return { ok: false, reason: 'invalid_source' };
    const principalKey = viewerSubtitlePrincipalKey(claims);
    const now = Date.now();
    const cutoff = now - 60_000;
    if (viewerSubtitleRateWindows.size > 1_000) {
        for (const [key, timestamps] of viewerSubtitleRateWindows) {
            const fresh = timestamps.filter((value) => value >= cutoff);
            if (fresh.length) viewerSubtitleRateWindows.set(key, fresh);
            else viewerSubtitleRateWindows.delete(key);
        }
    }
    const timestamps = (viewerSubtitleRateWindows.get(principalKey) || [])
        .filter((value) => value >= cutoff);
    if (timestamps.length >= MAX_VIEWER_SUBTITLE_REQUESTS_PER_MINUTE) {
        viewerSubtitleRateWindows.set(principalKey, timestamps);
        return { ok: false, reason: 'rate_limited' };
    }
    if (activeViewerSubtitlePrincipals.has(principalKey) || queuedViewerSubtitlePrincipals.has(principalKey)) {
        return { ok: false, reason: 'busy' };
    }
    timestamps.push(now);
    viewerSubtitleRateWindows.set(principalKey, timestamps);
    if (!viewerSubtitleWaitQueue.length && viewerSubtitleSlotAvailable(proxyKey, principalKey)) {
        return createViewerSubtitleOperation(proxyKey, principalKey);
    }
    if (viewerSubtitleWaitQueue.length >= MAX_PENDING_VIEWER_SUBTITLE_OPERATIONS) {
        return { ok: false, reason: 'busy' };
    }
    return await new Promise((resolve) => {
        let settled = false;
        const waiter = {
            proxyKey,
            principalKey,
            timer: null,
            onClose: null,
            finish(result) {
                if (settled) return;
                settled = true;
                if (waiter.timer) clearTimeout(waiter.timer);
                if (waiter.onClose) response?.removeListener?.('close', waiter.onClose);
                const index = viewerSubtitleWaitQueue.indexOf(waiter);
                if (index >= 0) viewerSubtitleWaitQueue.splice(index, 1);
                queuedViewerSubtitlePrincipals.delete(principalKey);
                resolve(result);
            },
        };
        waiter.onClose = () => {
            if (!response?.writableEnded) waiter.finish({ ok: false, reason: 'client_closed' });
        };
        waiter.timer = setTimeout(
            () => waiter.finish({ ok: false, reason: 'busy' }),
            VIEWER_SUBTITLE_QUEUE_WAIT_MS,
        );
        queuedViewerSubtitlePrincipals.add(principalKey);
        viewerSubtitleWaitQueue.push(waiter);
        response?.once?.('close', waiter.onClose);
        // Capacity may have become available between the earlier check and the
        // enqueue. Drain after registration to close that lost-wake window.
        drainViewerSubtitleWaitQueue();
    });
}
function registerRawPump(entry) {
    rawPumps.add(entry);
    return entry;
}
function releaseRawPump(entry) {
    rawPumps.delete(entry);
    wakePlaybackBlockedQueues();
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
const accountExtractions = new Map(); // proxyKey -> Set<{ child, preempted, reportActivity, activityKind, globalPreemptible }>
const ACCOUNT_ACTIVITY_KIND_GATEWAY = 'gateway';
const ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION = 'language-validation';
const ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH = 'catalog-refresh';
function groupProviderAccountActivities(candidates, maxKeys = 64) {
    const boundedMaxKeys = Math.max(0, Math.min(64, Number.parseInt(maxKeys, 10) || 0));
    const byKey = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const key = typeof candidate?.key === 'string' ? candidate.key : '';
        if (!key) continue;
        const kind = candidate?.kind === ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
            ? ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
            : (candidate?.kind === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                ? ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                : ACCOUNT_ACTIVITY_KIND_GATEWAY);
        const existing = byKey.get(key);
        if (existing === ACCOUNT_ACTIVITY_KIND_GATEWAY) continue;
        if (existing === ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION) {
            if (kind === ACCOUNT_ACTIVITY_KIND_GATEWAY) byKey.set(key, kind);
            continue;
        }
        if (existing === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH) {
            if (kind !== ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH) byKey.set(key, kind);
            continue;
        }
        if (byKey.size >= boundedMaxKeys) continue;
        byKey.set(key, kind);
    }
    const gateway = [];
    const languageValidation = [];
    const catalogRefresh = [];
    for (const [key, kind] of byKey) {
        if (kind === ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION) languageValidation.push(key);
        else if (kind === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH) catalogRefresh.push(key);
        else gateway.push(key);
    }
    return { gateway, languageValidation, catalogRefresh };
}
function preemptExtractionEntry(entry) {
    if (!entry || entry.preempted) return 0;
    entry.preempted = true;
    try { entry.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    return 1;
}
function registerAccountExtraction(proxyKey, child, reportActivity = true, globalPreemptible = true) {
    // Keep this normalization self-contained: the probe-preemption contract
    // evaluates the registration ledger in isolation from the HTTP reporter.
    const activityKind = reportActivity === false
        ? null
        : (reportActivity === ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
            ? ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
            : (reportActivity === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                ? ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                : ACCOUNT_ACTIVITY_KIND_GATEWAY));
    const entry = {
        child,
        preempted: false,
        reportActivity: activityKind !== null,
        activityKind,
        globalPreemptible: globalPreemptible !== false,
    };
    if (!proxyKey) return entry;
    let set = accountExtractions.get(proxyKey);
    if (!set) { set = new Set(); accountExtractions.set(proxyKey, set); }
    set.add(entry);
    entry.release = () => { set.delete(entry); if (!set.size) accountExtractions.delete(proxyKey); };
    // Short catalogue calls routinely finish before the periodic 60-second
    // reporter. Publish the just-registered holder at the next microtask so the
    // Edge can preserve a provider drain after the child exits. Function
    // declarations are hoisted in production; the typeof guard keeps the
    // isolated ledger contract harness self-contained.
    if (entry.reportActivity && typeof reportAccountActivity === 'function') {
        Promise.resolve().then(() => reportAccountActivity()).catch(() => {});
    }
    // The queue may have selected this job immediately before a viewer reserved
    // startup. Registration is the last synchronous boundary before provider I/O;
    // close that ordering without affecting explicit viewer-origin jobs.
    if (entry.globalPreemptible && viewerPlaybackActiveLocally()) {
        if (preemptExtractionEntry(entry)) {
            viewerQosStats.globalExtractionPreemptions += 1;
            console.log('[media-gateway] preempted background extraction — viewer playback won spawn race');
        }
    }
    return entry;
}
function preemptAccountExtractions(proxyKey, reason) {
    const set = accountExtractions.get(proxyKey);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const entry of [...set]) {
        n += preemptExtractionEntry(entry);
    }
    if (n) console.log(`[media-gateway] preempted ${n} background extraction(s) — ${reason}`);
    return n;
}
function activeCatalogRefreshExtractionCount(proxyKey) {
    const set = accountExtractions.get(proxyKey);
    if (!set || !set.size) return 0;
    let count = 0;
    for (const entry of set) {
        if (!entry.preempted && entry.activityKind === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH) {
            count += 1;
        }
    }
    return count;
}
function preemptBackgroundExtractionsGlobally(exceptProxyKey, reason) {
    let n = 0;
    for (const [proxyKey, set] of accountExtractions) {
        if (exceptProxyKey && proxyKey === exceptProxyKey) continue;
        for (const entry of [...set]) {
            if (entry.globalPreemptible === false) continue;
            n += preemptExtractionEntry(entry);
        }
    }
    if (n) console.log(`[media-gateway] preempted ${n} global background extraction(s) — ${reason}`);
    return n;
}

// Provider extraction and Whisper inference are two distinct resource holders: once ffmpeg has
// produced a WAV chunk it may exit (or be killed by playback), while whisper.cpp keeps consuming
// the shared CPU for up to several minutes. Track ONLY catalogue LID and service/pregen subtitle
// inference here. A viewer-origin subtitle request is deliberately absent from this ledger, so
// opening /raw cannot kill the subtitle generation the viewer explicitly requested.
const accountBackgroundWhispers = new Map(); // proxyKey -> Set<{ child, preempted }>
let backgroundWhisperPreemptions = 0;
function registerAccountBackgroundWhisper(proxyKey, child) {
    const entry = { child, preempted: false };
    if (!proxyKey || !child) return entry;
    let set = accountBackgroundWhispers.get(proxyKey);
    if (!set) { set = new Set(); accountBackgroundWhispers.set(proxyKey, set); }
    set.add(entry);
    entry.release = () => {
        set.delete(entry);
        if (!set.size) accountBackgroundWhispers.delete(proxyKey);
    };
    return entry;
}
function preemptAccountBackgroundWhispers(proxyKey, reason) {
    const set = accountBackgroundWhispers.get(proxyKey);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const entry of [...set]) {
        if (entry.preempted) continue;
        entry.preempted = true;
        try { entry.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        n += 1;
    }
    if (n) {
        backgroundWhisperPreemptions += n;
        console.log(`[media-gateway] preempted ${n} background whisper inference(s) — ${reason}`);
    }
    return n;
}
function preemptBackgroundWhispersGlobally(exceptProxyKey, reason) {
    let n = 0;
    for (const [proxyKey, set] of accountBackgroundWhispers) {
        if (exceptProxyKey && proxyKey === exceptProxyKey) continue;
        for (const entry of [...set]) {
            if (entry.preempted) continue;
            entry.preempted = true;
            try { entry.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
            n += 1;
        }
    }
    if (n) {
        backgroundWhisperPreemptions += n;
        console.log(`[media-gateway] preempted ${n} global background whisper inference(s) — ${reason}`);
    }
    return n;
}
const viewerQosStats = {
    globalExtractionPreemptions: 0,
    globalWhisperPreemptions: 0,
    globalCpuPreemptions: 0,
};
const backgroundCpuProcesses = new Set(); // service/pregen OCR subprocesses
function killBackgroundProcessTree(child) {
    if (!child) return;
    if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        try {
            process.kill(-child.pid, 'SIGKILL');
            return;
        } catch (_) { /* fall back to the direct child */ }
    }
    try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
}
function preemptBackgroundCpuEntry(entry) {
    if (!entry || entry.preempted || entry.globalPreemptible === false) return 0;
    entry.preempted = true;
    killBackgroundProcessTree(entry.child);
    return 1;
}
function registerBackgroundCpuProcess(child, globalPreemptible = true) {
    const entry = { child, preempted: false, globalPreemptible: globalPreemptible !== false };
    if (!child || entry.globalPreemptible === false) return entry;
    backgroundCpuProcesses.add(entry);
    entry.release = () => backgroundCpuProcesses.delete(entry);
    if (viewerPlaybackActiveLocally()) {
        if (preemptBackgroundCpuEntry(entry)) viewerQosStats.globalCpuPreemptions += 1;
    } else {
        lowerBackgroundProcessPriority(child);
    }
    return entry;
}
function preemptBackgroundCpuGlobally(reason) {
    let n = 0;
    for (const entry of [...backgroundCpuProcesses]) n += preemptBackgroundCpuEntry(entry);
    if (n) console.log(`[media-gateway] preempted ${n} global background CPU process(es) — ${reason}`);
    return n;
}
function preemptBackgroundWorkGlobally(exceptProxyKey, reason) {
    const extractions = preemptBackgroundExtractionsGlobally(exceptProxyKey, reason);
    const whispers = preemptBackgroundWhispersGlobally(exceptProxyKey, reason);
    const cpu = preemptBackgroundCpuGlobally(reason);
    viewerQosStats.globalExtractionPreemptions += extractions;
    viewerQosStats.globalWhisperPreemptions += whispers;
    viewerQosStats.globalCpuPreemptions += cpu;
    return { extractions, whispers, cpu };
}
function backgroundWhisperCount() {
    let count = 0;
    for (const set of accountBackgroundWhispers.values()) count += set.size;
    return count;
}
function lowerBackgroundProcessPriority(child) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
    try {
        os.setPriority(child.pid, os.constants?.priority?.PRIORITY_LOW ?? 19);
        return true;
    } catch (_) {
        // Railway/container kernels may deny setpriority. QoS remains correct because viewer
        // playback still preempts same-account background inference; niceness is an extra guard.
        return false;
    }
}
function registerPreemptibleBackgroundWhisper(proxyKey, child) {
    const registration = registerAccountBackgroundWhisper(proxyKey, child);
    // Register first, then re-check synchronously. This closes both orderings around spawn:
    // playback may already have preempted before it could see this child, or it may start later
    // and find the child in the registry during its normal preemption pass.
    if (proxyKey && viewerPlaybackActiveLocally()) {
        const preempted = preemptAccountBackgroundWhispers(proxyKey, 'viewer playback won whisper spawn race');
        viewerQosStats.globalWhisperPreemptions += preempted;
        return registration;
    }
    lowerBackgroundProcessPriority(child);
    return registration;
}
// True while THIS box holds the account's provider slot for a viewer: a live transcode session
// or an engine /raw byte-pump. Checked before the edge pregen-gate — it is instant, and it sees
// what the edge can't (a paused viewer whose ffmpeg is still transcoding, a mid-film raw pump).
function accountKeyBusyLocally(key) {
    if (!key) return false;
    for (const s of sessions.values()) {
        if (s && s.sourceUrl && proxyKeyFromUrl(s.sourceUrl) === key && isSessionBlockingProviderSlot(s)) return true;
    }
    for (const p of rawPumps) { if (p && p.proxyKey === key) return true; }
    return false;
}
function accountSlotBusyLocally(url, ownerKey = '') {
    const providerSlotKey = providerSlotKeyFromUrl(url || '', ownerKey);
    if (providerSlotKey && viewerSessionStartupLocks.has(`provider:${providerSlotKey}`)) return true;
    return accountKeyBusyLocally(proxyKeyFromUrl(url || ''));
}
function providerSlotKeyForSession(session) {
    if (!session) return '';
    return session.providerSlotKey
        || providerSlotKeyFromUrl(session.sourceUrl || '', session.ownerKey || '');
}
function providerSessionBlocksRawOpening(providerSlotKey) {
    if (!providerSlotKey) return false;
    if (viewerSessionStartupLocks.has(`provider:${providerSlotKey}`)) return true;
    return Array.from(sessions.values()).some((session) => (
        session?.sourceUrl &&
        providerSlotKeyForSession(session) === providerSlotKey &&
        isSessionBlockingProviderSlot(session)
    ));
}
function viewerPlaybackActiveLocally() {
    return viewerStartupReservations.size > 0
        || rawPumps.size > 0
        || Array.from(sessions.values()).some((session) => isSessionBlockingProviderSlot(session));
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
// A strict LID ffmpeg reads only the private 127.0.0.1 broker. Explicitly remove every
// inherited proxy variable so libav cannot send that loopback capability through a
// residential proxy. The broker itself owns the provider's sticky dispatcher.
function loopbackOnlyEnv() {
    const env = { ...process.env };
    for (const key of [
        'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
        'all_proxy', 'ALL_PROXY',
    ]) delete env[key];
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
    return env;
}
function redactStrictLidLoopback(value) {
    return String(value || '')
        .replace(
            /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/strict-lid\/[A-Za-z0-9_-]+/gi,
            '[strict-lid-loopback]',
        )
        .replace(
            /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/finite-mkv-seek\/[A-Za-z0-9_-]+/gi,
            '[finite-mkv-seek-loopback]',
        );
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
const VIDEO_ENCODER_CONFIG = resolveVideoEncoderConfig(process.env, fs);
const VIDEO_ENCODER_PREFLIGHT = preflightVideoEncoder(VIDEO_ENCODER_CONFIG, {
    ffmpegPath: FFMPEG_PATH,
    spawnSync,
});
const DEFAULT_TTL_SECONDS = clampInt(process.env.SESSION_TTL_SECONDS, 30 * 60, 60, 12 * 60 * 60);
// A transport token may legitimately outlive the short database entitlement so a
// movie can play to completion. It must not, however, keep FFmpeg and a
// mono-account provider socket alive when the browser/WebView disappears without
// sending DELETE. Every authenticated HLS asset read renews this local liveness
// timestamp; an idle session is reaped independently of its long transport TTL.
const VIEWER_SESSION_IDLE_TIMEOUT_MS = clampInt(
    process.env.VIEWER_SESSION_IDLE_TIMEOUT_SECONDS,
    2 * 60,
    30,
    30 * 60,
) * 1000;
// Startup remains bounded even though finite MKV resumes now use the private
// serialized range broker; the same deadline also covers ordinary provider
// startup and the fail-safe legacy non-seekable paths.
const STARTUP_TIMEOUT_MS = clampInt(process.env.STARTUP_TIMEOUT_MS, 60_000, 5_000, 180_000);
const PLAYLIST_REQUEST_TIMEOUT_MS = clampInt(process.env.PLAYLIST_REQUEST_TIMEOUT_MS, 45_000, 5_000, 180_000);
// This cap is independent from startup admission: it follows the actual video
// encoder child for its whole lifetime. Copy/remux and complete-cache sessions
// consume no slot. A dedicated media host can set a conservative value (4 on
// the shared Hetzner box) while the historical deployment keeps ample headroom.
const MAX_ACTIVE_VIDEO_ENCODER_SESSIONS = clampInt(
    process.env.MAX_ACTIVE_VIDEO_ENCODER_SESSIONS,
    16,
    1,
    64,
);
// Bound startup work before allocating provider/owner lock waiters. The global
// ceiling protects the shared replica even when one owner fans out across many
// source hosts; the per-key ceiling bounds one mono-account handoff chain.
const MAX_VIEWER_SESSION_STARTUP_ADMISSIONS = clampInt(
    process.env.MAX_VIEWER_SESSION_STARTUP_ADMISSIONS,
    32,
    1,
    256,
);
const MAX_VIEWER_SESSION_STARTUPS_PER_KEY = clampInt(
    process.env.MAX_VIEWER_SESSION_STARTUPS_PER_KEY,
    4,
    1,
    32,
);
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
// The finite-MKV pump is already the sole provider socket and can safely tee its
// prefix. Keep this independent from the older /raw experiment so exact playback
// metadata works by default without enabling capture on every raw byte-pipe.
const BOUNDED_MKV_HEADER_PARSE = (process.env.BOUNDED_MKV_HEADER_PARSE || 'true') !== 'false';
const INBAND_HEADER_BYTES = clampInt(process.env.INBAND_HEADER_BYTES, 4_000_000, 256_000, 32_000_000);
// A valid Matroska file normally exposes Info and Tracks within a handful of
// top-level Segment elements. Bound the synchronous structural walk so a file
// padded with millions of tiny Void elements cannot monopolize the Node event
// loop before the local ffprobe result is accepted.
const MAX_MATROSKA_METADATA_ELEMENTS = 4_096;
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
// Production detect-only is capability-gated twice: a signed Edge scope selects the mode
// for one exact request, while this environment switch can disable the new runtime on every
// gateway replica without trusting a browser-controlled query parameter. The signed scope is
// OFF by default in the database; strict validation never enters this path.
const WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE =
    (process.env.WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE || 'true') === 'true';
const WHISPER_DETECT_ONLY_TIMEOUT_MS = clampInt(
    process.env.WHISPER_DETECT_ONLY_TIMEOUT_MS,
    15_000,
    5_000,
    60_000,
);
const WHISPER_DETECT_ONLY_MIN_PROBABILITY = Math.min(
    0.999,
    Math.max(0.95, Number(process.env.WHISPER_DETECT_ONLY_MIN_PROBABILITY) || 0.95),
);
const LID_DETECT_ONLY_SCOPE = 'lid-production-detect-only';
const LID_SHADOW_SCOPE = 'lid-shadow';
const LID_LEGACY_FULL_SCOPE = 'lid-legacy-full';
const LID_CAPABILITY_HEADER = 'x-norva-byte-pipe-token';
const LID_ROUTE_SCOPES = new Set([
    LID_DETECT_ONLY_SCOPE,
    LID_SHADOW_SCOPE,
    LID_LEGACY_FULL_SCOPE,
]);
const LID_CASCADE_WAV_SCOPES = new Set([
    'lid-cascade-shadow-v1',
    'lid-cascade-untagged-canary-v1',
    'lid-cascade-untagged-primary-v1',
]);
const LID_BENCHMARK_INSTANCE = process.env.RAILWAY_REPLICA_ID || crypto.randomUUID();
// Operator-only capture ceiling. A 30s 16 kHz mono PCM WAV is ~0.92 MiB raw
// and ~1.22 MiB in base64, so one 1.5 MiB ceiling safely fits the expected
// sample while failing closed on a format/configuration regression.
const LID_BENCHMARK_WAV_MAX_BYTES = 1536 * 1024;
const LID_BENCHMARK_WAV_BASE64_MAX_CHARS = 1536 * 1024;
const LID_LANGUAGE_WAV_MAX_BYTES = 1536 * 1024;
let lidBenchmarkBusy = false;
let lidLanguageWavActive = 0;
let whisperInferenceActive = 0;
let argosInferenceActive = 0;
const lidLanguageWavStats = {
    requests: 0,
    attempts: 0,
    successes: 0,
    invalidTokens: 0,
    invalidRequests: 0,
    busyRejections: 0,
    extractionFailures: 0,
    validationFailures: 0,
    oversized: 0,
    responseAborts: 0,
    bytesServed: 0,
    totalExtractMs: 0,
    last: null,
};
const lidDetectOnlyStats = {
    primaryAttempts: 0,
    primaryAccepted: 0,
    primaryFallbacks: 0,
    shadowAttempts: 0,
    shadowEligible: 0,
    shadowAgreements: 0,
    shadowDisagreements: 0,
    shadowNoFullVerdict: 0,
    failures: 0,
    timeouts: 0,
    totalFastMs: 0,
    shadowFullRuns: 0,
    shadowFullMs: 0,
    fallbackFullRuns: 0,
    fallbackFullMs: 0,
    last: null,
};
// Bounded mid-film sweep for language detection: a film opens with logos/silence/music, so
// sampling at offset 0 detects nothing. Try these offsets (seconds) in order and stop at the
// first clip with real speech; a clip past the file's end yields no WAV and is skipped. Bounded
// (≤ length) so it never hammers a single-connection provider. Override via WHISPER_SWEEP_OFFSETS.
const WHISPER_SWEEP_OFFSETS = (process.env.WHISPER_SWEEP_OFFSETS || '600,1500,300')
    .split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
// A language shown as verified in Norva is held to a materially stronger contract than the
// best-effort LID endpoint used during development. Four separated, information-rich speech
// windows must agree unanimously. Strict offsets are derived only from the exact signed media
// duration below, so neither a request query nor replica-local environment can bias the proof.
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
// Keep the complete strict Gateway request (sequential extraction, one Whisper batch, broker
// drain and response) inside the cross-service deadline. The work deadline below still removes
// a separate drain/response reserve. Operators may lower this ceiling, never raise it.
const STRICT_LID_REQUEST_BUDGET_MS = clampInt(
    process.env.STRICT_LID_REQUEST_BUDGET_MS,
    225_000,
    60_000,
    225_000,
);
// Strict extraction must leave a full inference window inside the existing work deadline.
// A 20 s speech window is long enough for LID while the additional 25 s covers remote seek,
// demux probing and WAV finalization. The per-window timer is further bounded by the remaining
// extraction budget, so provider work can never consume Whisper's reserved 50 s window.
const STRICT_LID_SAMPLE_DURATION_CAP_SECONDS = 20;
const STRICT_LID_EXTRACTION_STARTUP_MARGIN_MS = 25_000;
const STRICT_LID_WHISPER_RESERVE_MS = 50_000;
// A resumable v103 request owns exactly one signed timeline window, so it may use the complete
// extraction slice that v102 had to share across all windows. Whisper and provider drain retain
// their unchanged, independent reserves inside the same 225 s request ceiling.
const STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS = 165_000;

function strictLidSampleDurationSeconds(rawDuration, strict) {
    const parsed = Number.parseFloat(rawDuration);
    const fallback = strict ? STRICT_LID_SAMPLE_DURATION_CAP_SECONDS : 20;
    // Preserve the legacy non-strict `parsed || 20` semantics (including ?dur=0) while applying
    // the new 20 s ceiling only to strict certification.
    const requested = parsed || fallback;
    return Math.min(Math.max(requested, 4), strict ? STRICT_LID_SAMPLE_DURATION_CAP_SECONDS : 60);
}

function strictLidMediaExtractionTimeoutMs(durationSeconds) {
    const boundedDuration = Math.min(
        Math.max(Number(durationSeconds) || 4, 4),
        STRICT_LID_SAMPLE_DURATION_CAP_SECONDS,
    );
    return boundedDuration * 1_000 + STRICT_LID_EXTRACTION_STARTUP_MARGIN_MS;
}

function strictLidExtractionBudget(durationSeconds, workDeadlineAt, nowMs = Date.now()) {
    const mediaTimeoutMs = strictLidMediaExtractionTimeoutMs(durationSeconds);
    const rawAvailableMs = Number(workDeadlineAt) - Number(nowMs) - STRICT_LID_WHISPER_RESERVE_MS;
    const availableMs = Number.isFinite(rawAvailableMs)
        ? Math.max(0, Math.floor(rawAvailableMs))
        : 0;
    return {
        mediaTimeoutMs,
        availableMs,
        timeoutMs: Math.min(mediaTimeoutMs, availableMs),
    };
}

function strictLidWindowExtractionBudget(workDeadlineAt, nowMs = Date.now()) {
    const rawAvailableMs = Number(workDeadlineAt) - Number(nowMs) - STRICT_LID_WHISPER_RESERVE_MS;
    const availableMs = Number.isFinite(rawAvailableMs)
        ? Math.max(0, Math.floor(rawAvailableMs))
        : 0;
    return {
        mediaTimeoutMs: STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS,
        availableMs,
        timeoutMs: Math.min(STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS, availableMs),
    };
}

function strictLidWhisperBatchTimeoutMs(workDeadlineAt, checkpointWindow, nowMs = Date.now()) {
    const rawAvailableMs = Number(workDeadlineAt) - Number(nowMs);
    const availableMs = Number.isFinite(rawAvailableMs)
        ? Math.max(0, Math.floor(rawAvailableMs))
        : 0;
    return checkpointWindow
        ? Math.min(STRICT_LID_WHISPER_RESERVE_MS, availableMs)
        : availableMs;
}

function strictLidPostExtractionFailure({
    terminalError = null,
    extractionTimedOut = false,
    workBudgetExpired = false,
} = {}) {
    // A broker-observed terminal response, especially the first provider 458, always wins over
    // local timers. Callers must open the terminal circuit rather than treating it as retryable.
    if (terminalError) {
        return {
            status: Number.isInteger(terminalError.status) ? terminalError.status : 502,
            payload: {
                error: terminalError.message,
                code: terminalError.code,
                ...(Number.isInteger(terminalError.upstreamStatus)
                    ? { upstreamStatus: terminalError.upstreamStatus }
                    : {}),
            },
        };
    }
    // Once any transport window times out, already-extracted samples are unusable for strict
    // certification: neither a pending nor a verified response may conceal incomplete evidence.
    if (extractionTimedOut) {
        return {
            status: 504,
            retryAfterSeconds: 30,
            payload: {
                error: 'Strict language audio extraction timed out',
                code: 'strict_lid_extraction_timeout',
                retryable: true,
            },
        };
    }
    if (workBudgetExpired) {
        return {
            status: 504,
            payload: {
                error: 'Strict language validation exceeded its request budget',
                code: 'strict_lid_request_timeout',
                retryable: true,
            },
        };
    }
    return null;
}
function strictLanguageSampleDisposition({
    enoughWords,
    whisperConfident,
    transcriptDisagrees,
}) {
    if (!enoughWords) return 'insufficient';
    if (!whisperConfident) return 'weak';
    if (transcriptDisagrees) return 'conflict';
    return 'accepted';
}
function strictLanguageBatchSampleResult(whisper, offset) {
    const det = detectLanguageFromText(whisper?.text || '');
    const whisperLang = String(whisper?.lang || '').toLowerCase() || null;
    const whisperProbability = Number(whisper?.prob || 0);
    const transcriptEvidence = evaluateStrictTranscriptEvidence({
        text: whisper?.text || '',
        wordCount: det.words,
        minWords: WHISPER_STRICT_MIN_WORDS,
        minUniqueWords: WHISPER_STRICT_MIN_UNIQUE_WORDS,
        whisperLanguage: whisperLang,
        transcriptLanguage: det.lang,
        transcriptConfident: det.confident,
    });
    const transcriptDisagrees = det.confident === true
        && Boolean(det.lang)
        && det.lang !== whisperLang;
    const whisperConfident = Boolean(whisperLang)
        && whisperProbability >= WHISPER_STRICT_MIN_PROBABILITY;
    const enoughWords = transcriptEvidence.enough;
    const disposition = strictLanguageSampleDisposition({
        enoughWords,
        whisperConfident,
        transcriptDisagrees,
    });
    const accepted = disposition === 'accepted';
    return {
        disposition,
        diversity: {
            fingerprint: transcriptEvidence.diversityFingerprint,
            shingles: transcriptEvidence.diversityShingles,
        },
        result: {
            language: accepted ? whisperLang : null,
            candidate: whisperLang,
            confidence: whisperProbability,
            confident: accepted,
            verified: false,
            validationStatus: 'pending',
            method: 'whisper-strict-consensus-v4',
            consensus: 0,
            whisperLang,
            transcriptLang: det.confident ? det.lang : null,
            transcriptAgrees: det.confident ? det.lang === whisperLang : null,
            minProbability: WHISPER_STRICT_MIN_PROBABILITY,
            // The legacy Edge contract still gates on wordCount/uniqueWordCount. For a CJK
            // transcript that passed the stronger character/bigram proof, expose deterministic
            // evidence-unit equivalents; never raise these compatibility fields on a failed proof.
            wordCount: transcriptEvidence.compatibleWordCount,
            uniqueWordCount: transcriptEvidence.compatibleUniqueWordCount,
            transcriptEvidenceBasis: transcriptEvidence.basis,
            scriptCharacterCount: transcriptEvidence.scriptCharacterCount,
            uniqueScriptCharacterCount: transcriptEvidence.uniqueScriptCharacterCount,
            uniqueScriptBigramCount: transcriptEvidence.uniqueScriptBigramCount,
            scriptDensity: transcriptEvidence.scriptDensity,
            sample: String(whisper?.text || '').slice(0, 160),
            offset,
        },
    };
}

function strictLidWindowRuntimeBinding() {
    const modelDigest = String(WHISPER_MODEL_SHA256 || WHISPER_MODEL_BUILD_SHA256 || '').toLowerCase();
    const binaryDigest = String(WHISPER_BIN_SHA256 || WHISPER_BIN_BUILD_SHA256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(modelDigest) || !/^[a-f0-9]{64}$/.test(binaryDigest)) return null;
    const configDigest = crypto.createHash('sha256').update(JSON.stringify({
        windowCheckpointProtocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
        windowEvidenceEnvelopeProtocol: STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
        method: STRICT_LID_WINDOW_METHOD,
        modelDigest,
        binaryDigest,
        whisperCommit: String(WHISPER_CPP_COMMIT || ''),
        consensus: WHISPER_STRICT_CONSENSUS,
        minimumProbability: WHISPER_STRICT_MIN_PROBABILITY,
        minimumWords: WHISPER_STRICT_MIN_WORDS,
        minimumUniqueWords: WHISPER_STRICT_MIN_UNIQUE_WORDS,
        sampleDurationSeconds: STRICT_LID_SAMPLE_DURATION_CAP_SECONDS,
        transcriptDiversityProtocol: 1,
        cjkEvidenceProtocol: 1,
    })).digest('hex');
    return Object.freeze({ modelDigest, configDigest });
}

function strictLidWindowClaimContext(claims, trackIndex, { finalize = false } = {}) {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    if (claims.windowCheckpointProtocol !== STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL) return null;
    if (finalize ? claims.windowFinalize !== true : (
        Object.prototype.hasOwnProperty.call(claims, 'windowFinalize')
        && claims.windowFinalize !== false
    )) return null;
    if (finalize && Object.prototype.hasOwnProperty.call(claims, 'windowOrdinal')) return null;
    const jobId = String(claims.jobId || '').toLowerCase();
    const profileFingerprint = String(claims.profileFingerprint || '').toLowerCase();
    const userId = String(claims.uid || '');
    const windowCount = claims.windowCount;
    const windowOrdinal = finalize ? null : claims.windowOrdinal;
    const fileSizeBytes = normalizeStrictLidFileSize(claims.fileSizeBytes);
    const durationSeconds = normalizeStrictLidTimelineDurationSeconds(claims.durationSeconds);
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jobId)
        || !/^[a-f0-9]{64}$/.test(profileFingerprint)
        || !userId || userId.length > 256
        || !Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 1024
        || ![4, 6].includes(windowCount)
        || (!finalize && (!Number.isInteger(windowOrdinal) || windowOrdinal < 1 || windowOrdinal > windowCount))
        || !fileSizeBytes
        || durationSeconds === null
    ) {
        return null;
    }
    const offsets = strictLidTimelineOffsets(durationSeconds, STRICT_LID_SAMPLE_DURATION_CAP_SECONDS);
    const runtime = strictLidWindowRuntimeBinding();
    if (!offsets || offsets.length !== windowCount || !runtime) return null;
    return Object.freeze({
        jobId,
        profileFingerprint,
        userId,
        trackIndex,
        fileSizeBytes,
        durationSeconds,
        windowOrdinal,
        windowCount,
        offsets,
        modelDigest: runtime.modelDigest,
        configDigest: runtime.configDigest,
    });
}

function strictLidWindowReceiptBinding(context, windowOrdinal) {
    const offset = context.offsets[windowOrdinal - 1];
    return {
        jobId: context.jobId,
        profileFingerprint: context.profileFingerprint,
        userId: context.userId,
        trackIndex: context.trackIndex,
        fileSizeBytes: context.fileSizeBytes,
        durationSeconds: context.durationSeconds,
        windowOrdinal,
        windowCount: context.windowCount,
        offsetMilliseconds: Math.round(offset * 1000),
        method: STRICT_LID_WINDOW_METHOD,
        configDigest: context.configDigest,
        modelDigest: context.modelDigest,
    };
}

function strictLidWindowConsensusPayload(summary, expectedWindowCount, consensusNeeded) {
    const evaluatedWindowCount = Number(summary?.evaluatedSampleCount || 0);
    if (evaluatedWindowCount !== expectedWindowCount) return null;
    const acceptedSamples = Array.isArray(summary.acceptedSamples) ? summary.acceptedSamples : [];
    const votes = summary.votes instanceof Map ? summary.votes : new Map();
    if (
        summary.verified === true
        && summary.bestAccepted
        && acceptedSamples.length >= consensusNeeded
        && votes.size === 1
        && summary.rejectedSpeechSampleCount === 0
    ) {
        const language = acceptedSamples[0].language;
        return {
            ...summary.bestAccepted,
            sample: '',
            language,
            candidate: language,
            confident: true,
            verified: true,
            validationStatus: 'verified',
            method: STRICT_LID_WINDOW_METHOD,
            consensus: acceptedSamples.length,
            samples: acceptedSamples,
            sampleCount: acceptedSamples.length,
            evaluatedWindowCount,
            rejectedSpeechSampleCount: 0,
            ignoredWeakSpeechSampleCount: summary.ignoredWeakSpeechSampleCount,
            repeatedSpeechSampleCount: summary.repeatedSpeechSampleCount,
            missingDiversitySampleCount: summary.missingDiversitySampleCount,
            minSampleProbability: Math.min(...acceptedSamples.map((sample) => sample.probability)),
            minSampleWordCount: Math.min(...acceptedSamples.map((sample) => sample.wordCount)),
            minSampleUniqueWordCount: Math.min(...acceptedSamples.map((sample) => sample.uniqueWordCount)),
        };
    }
    const best = summary.best ? {
        ...summary.best,
        sample: '',
        language: null,
        confident: false,
        verified: false,
        validationStatus: 'pending',
        method: STRICT_LID_WINDOW_METHOD,
        consensus: Math.max(0, ...votes.values()),
        samples: acceptedSamples,
        sampleCount: acceptedSamples.length,
        evaluatedWindowCount,
        rejectedSpeechSampleCount: summary.rejectedSpeechSampleCount,
        ignoredWeakSpeechSampleCount: summary.ignoredWeakSpeechSampleCount,
        repeatedSpeechSampleCount: summary.repeatedSpeechSampleCount,
        missingDiversitySampleCount: summary.missingDiversitySampleCount,
    } : null;
    return best || {
        language: null,
        candidate: null,
        confidence: 0,
        confident: false,
        verified: false,
        validationStatus: 'pending',
        method: STRICT_LID_WINDOW_METHOD,
        consensus: 0,
        whisperLang: null,
        transcriptLang: null,
        wordCount: 0,
        samples: [],
        sampleCount: 0,
        evaluatedWindowCount,
        rejectedSpeechSampleCount: summary.rejectedSpeechSampleCount,
        ignoredWeakSpeechSampleCount: summary.ignoredWeakSpeechSampleCount,
        repeatedSpeechSampleCount: summary.repeatedSpeechSampleCount,
        missingDiversitySampleCount: summary.missingDiversitySampleCount,
        sample: '',
    };
}
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
// Once an exact VOD profile is already known (from the catalogue or the
// gateway's own ffprobe just above session startup), asking FFmpeg to analyse
// another 8 seconds / 8 MB delays the first segment without discovering
// anything useful. Keep the conservative budget for unknown/partial files and
// use the same bounded footprint that produced the exact profile for the
// known-file fast path.
const KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED =
    (process.env.KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED || 'true') !== 'false';
const KNOWN_VOD_INPUT_ANALYZE_DURATION_US = clampInt(process.env.KNOWN_VOD_INPUT_ANALYZE_DURATION_US, 2_000_000, 250_000, 8_000_000);
const KNOWN_VOD_INPUT_PROBE_SIZE_BYTES = clampInt(process.env.KNOWN_VOD_INPUT_PROBE_SIZE_BYTES, 2_000_000, 64_000, 8_000_000);
// A playlist file can be created before it contains enough media to advance a
// browser. In particular, a short leading fragment (~100 ms) can produce an
// invalid/near-zero HLS target duration and leave hls.js at readyState=1. Do
// not advertise a session until the playlist references a finalized segment
// with enough finalized media to absorb the provider reconnect windows observed
// in production. With the normal 4 s target this requires three full segments.
// A slow one-vCPU encode must be allowed to materialize a proof-sized VOD
// window before the browser starts consuming it. The production default stays
// quick, while deployments that need deterministic long-window playback can
// opt into a deeper buffer without changing the session or provider socket.
const MIN_HLS_STARTUP_BUFFER_SECONDS = clampInt(process.env.MIN_HLS_STARTUP_BUFFER_SECONDS, 10, 1, 180);
const MIN_HLS_STARTUP_SEGMENTS = clampInt(process.env.MIN_HLS_STARTUP_SEGMENTS, 3, 1, 10);
const MAX_SUBTITLE_TRACKS = clampInt(process.env.MAX_SUBTITLE_TRACKS, 32, 1, 64);
const MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS = clampInt(process.env.MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS, 1, 1, 4);
const MAX_VIEWER_SUBTITLE_REQUESTS_PER_MINUTE = clampInt(process.env.MAX_VIEWER_SUBTITLE_REQUESTS_PER_MINUTE, 30, 1, 120);
const MAX_PENDING_VIEWER_SUBTITLE_OPERATIONS = clampInt(process.env.MAX_PENDING_VIEWER_SUBTITLE_OPERATIONS, 8, 1, 32);
const VIEWER_SUBTITLE_QUEUE_WAIT_MS = clampInt(process.env.VIEWER_SUBTITLE_QUEUE_WAIT_MS, 75_000, 5_000, 180_000);
const PROVIDER_SLOT_RELEASE_DELAY_MS = clampInt(process.env.PROVIDER_SLOT_RELEASE_DELAY_MS, 2_500, 0, 15_000);
const PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS = clampInt(
    process.env.PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS,
    45_000,
    0,
    120_000,
);
// Stop provider/CPU work before the public request deadline. The reserve includes the provider
// panel's logical socket-release grace plus bounded Node response overhead.
const STRICT_LID_DRAIN_RESPONSE_RESERVE_MS = Math.min(
    30_000,
    Math.max(10_000, PROVIDER_SLOT_RELEASE_DELAY_MS + 5_000),
);
const STRICT_LID_EXTRACTION_AGGREGATE_BUDGET_MS = Math.max(
    0,
    STRICT_LID_REQUEST_BUDGET_MS
        - STRICT_LID_DRAIN_RESPONSE_RESERVE_MS
        - STRICT_LID_WHISPER_RESERVE_MS,
);
// The broker's provider-range deadline has two independent phases. Headers or a continuously
// flowing body must not consume the "open" timer forever: the first byte has its own deadline,
// then every non-empty chunk rearms a shorter inactivity deadline. The outer 45 s ffmpeg timer
// and the 165 s aggregate extraction budget remain the authoritative total-work bounds.
const STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS = clampInt(
    process.env.STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS,
    30_000,
    5_000,
    30_000,
);
const STRICT_LID_BROKER_IDLE_TIMEOUT_MS = clampInt(
    process.env.STRICT_LID_BROKER_IDLE_TIMEOUT_MS,
    15_000,
    5_000,
    30_000,
);
// libav must never abandon the private loopback before either the broker deadline or the outer
// extraction deadline. This is microseconds (`-rw_timeout`) and intentionally exceeds 45 s.
const STRICT_LID_FFMPEG_RW_TIMEOUT_US = 50_000_000;
// The checkpoint route has a 165 s outer extraction timer. Keep libav's per-I/O guard beyond that
// outer timer so the authoritative request controller wins, while the broker still enforces its
// independent 30 s first-byte and 15 s idle deadlines.
const STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US = 170_000_000;
// The finite-MKV input pump discovers an unknown terminal byte from the
// Content-Range of the same bounded GET that is retained for playback. The
// explicit end remains below Number.MAX_SAFE_INTEGER while being far beyond any
// supported media object, so a cold file never needs a 0-0 size probe followed
// by a second provider socket.
const VOD_INPUT_DISCOVERY_RANGE_END = Number.MAX_SAFE_INTEGER - 1;
const VOD_INPUT_FULL_BODY_MAX_BYTES = clampInt(
    process.env.VOD_INPUT_FULL_BODY_MAX_BYTES,
    128 * 1024 * 1024 * 1024,
    1024 * 1024,
    Number.MAX_SAFE_INTEGER - 1,
);
const VOD_FILE_SIZE_PROBE_TIMEOUT_MS = clampInt(process.env.VOD_FILE_SIZE_PROBE_TIMEOUT_MS, 8_000, 1_000, 20_000);
const VOD_INPUT_OPEN_TIMEOUT_MS = clampInt(process.env.VOD_INPUT_OPEN_TIMEOUT_MS, 15_000, 2_000, 30_000);
const VOD_INPUT_IDLE_TIMEOUT_MS = clampInt(process.env.VOD_INPUT_IDLE_TIMEOUT_MS, 8_000, 2_000, 30_000);
const VOD_INPUT_RETRY_LIMIT = clampInt(process.env.VOD_INPUT_RETRY_LIMIT, 3, 0, 8);
const VOD_INPUT_MAX_RECONNECTS = clampInt(process.env.VOD_INPUT_MAX_RECONNECTS, 1_024, 1, 4_096);
const VOD_INPUT_RETRY_DELAYS_MS = [0, 250, 1_000, 2_500, 5_000, 5_000, 5_000, 5_000];
const STOP_CONFLICTING_SOURCE_SESSIONS = (process.env.STOP_CONFLICTING_SOURCE_SESSIONS || 'true') !== 'false';
const STOP_CONFLICTING_OWNER_SESSIONS = (process.env.STOP_CONFLICTING_OWNER_SESSIONS || 'true') !== 'false';
// The in-browser byte-pipe may retry transient transport/server failures within a
// single gateway route. Provider/account 4xx responses, including 458, are never
// retried and never switch to direct playback.
const RAW_PROVIDER_RETRY_LIMIT = clampInt(process.env.RAW_PROVIDER_RETRY_LIMIT, 3, 0, 8);
const RAW_PROVIDER_RETRY_DELAYS_MS = [1500, 5000, 9000, 9000, 9000, 9000, 9000, 9000];
// Some providers accept HTTP and return 200/206 headers but never produce a
// single byte. Validate first-byte delivery before committing response headers,
// then close a stream that later goes truly idle so the player can reconnect.
const RAW_FIRST_BYTE_TIMEOUT_MS = clampInt(process.env.RAW_FIRST_BYTE_TIMEOUT_MS, 5_000, 1_000, 15_000);
// The native clients give the complete startup roughly 35s. This deadline is
// authoritative across DNS/connect/headers, prefix sniffing and every backoff;
// the 7s margin leaves time for the 504 to reach the player and arm its fallback.
const RAW_STARTUP_DEADLINE_MS = clampInt(process.env.RAW_STARTUP_DEADLINE_MS, 27_000, 5_000, 28_000);
const RAW_NO_DATA_RETRY_LIMIT = clampInt(process.env.RAW_NO_DATA_RETRY_LIMIT, 2, 0, 3);
const RAW_IDLE_TIMEOUT_MS = clampInt(process.env.RAW_IDLE_TIMEOUT_MS, 20_000, 5_000, 60_000);
const RAW_PREFIX_SNIFF_BYTES = 512;
const FFMPEG_USER_AGENT = process.env.FFMPEG_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Norva/1.0';
const MAX_LOG_TAIL = 12000;
const EXACT_MATROSKA_H264_HLS_TARGET_SECONDS = 2;
const EXACT_MATROSKA_H264_MAX_WIDTH = 1920;
const EXACT_MATROSKA_H264_MAX_HEIGHT = 1080;
const EXACT_MATROSKA_H264_MAX_PIXELS = EXACT_MATROSKA_H264_MAX_WIDTH * EXACT_MATROSKA_H264_MAX_HEIGHT;
const MKV_H264_FAST_START_PROTOCOL = 2;
// Stable proof-graph version. This changes only when the packet validator or
// FFmpeg copy graph semantics change, not on unrelated Gateway releases.
const MKV_H264_FAST_START_PROOF_BUILD = 2;
// Video copy is admitted only after the full-file packet timeline and an
// independent H264 type-5 (IDR) bitstream timeline agree. Recovery-point/open
// GOP files therefore remain on the encode path.
const MKV_H264_FAST_START_COPY_ACTIVATION_READY = true;
// Dedicated signing material is mandatory. The general Gateway bearer token is
// deliberately not a fallback: proof minting/verification must be independently
// rotatable and an absent/short key keeps every finite MKV on the encode path.
function decodeMkvH264FastStartProofKey(value) {
    const encoded = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(encoded) ? Buffer.from(encoded, 'hex') : null;
}
function mkvH264FastStartProofKeyId(key) {
    return key
        ? crypto.createHash('sha256')
            .update('NORVA/MKV-H264-FASTSTART/V2/KID\0')
            .update(key)
            .digest('hex')
        : null;
}
const MKV_H264_FAST_START_PROOF_CURRENT_KEY = decodeMkvH264FastStartProofKey(
    process.env.MKV_H264_FAST_START_PROOF_HMAC_KEY,
);
const MKV_H264_FAST_START_PROOF_PREVIOUS_KEY = decodeMkvH264FastStartProofKey(
    process.env.MKV_H264_FAST_START_PROOF_HMAC_PREVIOUS_KEY,
);
const MKV_H264_FAST_START_PROOF_VERIFICATION_KEYS = [
    MKV_H264_FAST_START_PROOF_CURRENT_KEY,
    MKV_H264_FAST_START_PROOF_PREVIOUS_KEY,
].filter((key, index, keys) => key && keys.findIndex((candidate) => candidate?.equals(key)) === index)
    .map((key) => ({ key, kid: mkvH264FastStartProofKeyId(key) }));
const MKV_H264_FAST_START_PROOF_MAX_AGE_MS = clampInt(
    process.env.MKV_H264_FAST_START_PROOF_MAX_AGE_MS,
    30 * 24 * 60 * 60 * 1_000,
    5 * 60 * 1_000,
    90 * 24 * 60 * 60 * 1_000,
);
const MKV_H264_FAST_START_PROOF_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MKV_H264_FAST_START_MAX_GOP_SECONDS = EXACT_MATROSKA_H264_HLS_TARGET_SECONDS;
const MKV_H264_FAST_START_MIN_KEYFRAMES = 3;
const MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES = clampInt(
    process.env.MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES,
    8 * 1024 * 1024,
    256 * 1024,
    32 * 1024 * 1024,
);
const MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS = clampInt(
    process.env.MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS,
    1_000,
    100,
    5_000,
);
const MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES = 4 * 1024;
const MKV_H264_FAST_START_ANALYZER_MAX_TIMELINE_RECORDS = 100_000;
const MKV_H264_FAST_START_BUFFER_SECONDS = 6;
const MKV_H264_FAST_START_MIN_SEGMENTS = 3;
const MKV_H264_FAST_START_MIN_ENCODE_RATE_X = 1.15;
// The dedicated VAAPI host can safely release a cold video transcode at the
// same small browser gate only after the real HLS graph has produced media at
// least twice as fast as playback. Software encodes and slower/unknown VAAPI
// runs retain the legacy 96-second browser buffer.
const VAAPI_VOD_FAST_START_BUFFER_SECONDS = 6;
const VAAPI_VOD_FAST_START_MIN_ENCODE_RATE_X = 2;
// Local HLS cache v1. Entries live only on this Gateway replica and expire from
// their original promotion time; reads never extend the deadline. A published
// entry is usable only after the same provider pump has completed the entire
// source and the closed HLS graph has been validated. The first 24 seconds may
// then be retained as a bounded prefix, or the whole graph when quotas permit.
const MKV_H264_HLS_CACHE_PROTOCOL = 1;
// Kept dark until exact file identity and prefix continuation complete review.
const MKV_H264_HLS_CACHE_ACTIVATION_READY = false;
const MKV_H264_HLS_CACHE_PREFIX_SEGMENTS = 12;
const MKV_H264_HLS_CACHE_PREFIX_SECONDS = 24;
const MKV_H264_HLS_CACHE_MIN_PRODUCTION_RATE_X = 1.5;
const MKV_H264_HLS_CACHE_TTL_MS = clampInt(
    process.env.MKV_H264_HLS_CACHE_TTL_MS,
    60 * 60 * 1_000,
    60 * 1_000,
    60 * 60 * 1_000,
);
const MKV_H264_HLS_CACHE_MAX_ENTRIES = clampInt(
    process.env.MKV_H264_HLS_CACHE_MAX_ENTRIES,
    16,
    1,
    128,
);
const MKV_H264_HLS_CACHE_MAX_BYTES = clampInt(
    process.env.MKV_H264_HLS_CACHE_MAX_BYTES,
    512 * 1024 * 1024,
    32 * 1024 * 1024,
    2 * 1024 * 1024 * 1024,
);
const MKV_H264_HLS_CACHE_MAX_COMPLETE_BYTES = clampInt(
    process.env.MKV_H264_HLS_CACHE_MAX_COMPLETE_BYTES,
    256 * 1024 * 1024,
    16 * 1024 * 1024,
    MKV_H264_HLS_CACHE_MAX_BYTES,
);
const MKV_H264_HLS_CACHE_MAX_FILES = clampInt(
    process.env.MKV_H264_HLS_CACHE_MAX_FILES,
    10_000,
    MKV_H264_HLS_CACHE_PREFIX_SEGMENTS,
    50_000,
);
const MKV_H264_HLS_CACHE_SCAN_TIMEOUT_MS = clampInt(
    process.env.MKV_H264_HLS_CACHE_SCAN_TIMEOUT_MS,
    5 * 60 * 1_000,
    30 * 1_000,
    10 * 60 * 1_000,
);
const MKV_H264_HLS_CACHE_ROOT = path.resolve(
    process.env.MKV_H264_HLS_CACHE_DIR || path.join(OUTPUT_DIR, '.mkv-h264-hls-cache-v1'),
);
const MKV_H264_HLS_CACHE_SECRET = decodeMkvH264FastStartProofKey(
    process.env.MKV_H264_HLS_CACHE_HMAC_KEY,
);
// Complete-HLS cache v2. This is the only cache implementation allowed to
// serve playback. It is disabled by default and additionally requires an
// explicit single-process/local-disk attestation because its leases, LRU and
// publication serialization are process-local. The older inline prefix cache
// above remains permanently dark while this implementation is integrated.
const MKV_COMPLETE_HLS_CACHE_PROTOCOL = 2;
const MKV_COMPLETE_HLS_CACHE_ACTIVATION_READY = true;
const MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD = 'mkv-complete-hls-mpegts-v4';
const MKV_COMPLETE_HLS_CACHE_LOCATOR_BUILD = 2;
// The cache locator is an opaque, signed capability to address one immutable
// complete HLS rendition before any provider GET. It deliberately shares only
// the cache manifest's dedicated 32-byte key and uses a separate HMAC domain;
// the general Gateway bearer token is never accepted as signing material.
const MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY = decodeMkvH264FastStartProofKey(
    process.env.MKV_COMPLETE_HLS_CACHE_MANIFEST_HMAC_KEY,
);
const MKV_COMPLETE_HLS_CACHE_COORDINATION_MODE = String(
    process.env.MKV_CACHE_COORDINATION_MODE || 'local',
).trim().toLowerCase();
const MKV_COMPLETE_HLS_CACHE_SINGLE_INSTANCE_ATTESTED =
    process.env.MKV_CACHE_SINGLE_INSTANCE_ATTESTED === 'true';
const MKV_COMPLETE_HLS_CACHE_REQUESTED = process.env.MKV_COMPLETE_HLS_CACHE_ENABLED === 'true';
const MKV_COMPLETE_HLS_CACHE_ROOT = path.resolve(
    process.env.MKV_COMPLETE_HLS_CACHE_ROOT || path.join(OUTPUT_DIR, '.mkv-complete-hls-cache-v2'),
);
const MKV_COMPLETE_HLS_CACHE_TTL_MS = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_TTL_MS,
    7 * 24 * 60 * 60 * 1_000,
    5 * 60 * 1_000,
    90 * 24 * 60 * 60 * 1_000,
);
const MKV_COMPLETE_HLS_CACHE_MAX_BYTES = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_MAX_BYTES,
    64 * 1024 * 1024 * 1024,
    128 * 1024 * 1024,
    1024 * 1024 * 1024 * 1024,
);
const MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES,
    2 * 1024 * 1024 * 1024,
    0,
    1024 * 1024 * 1024 * 1024,
);
const MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES,
    32 * 1024 * 1024 * 1024,
    16 * 1024 * 1024,
    512 * 1024 * 1024 * 1024,
);
const MKV_COMPLETE_HLS_CACHE_MAX_FILES = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_MAX_FILES,
    20_000,
    4,
    100_000,
);
const MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES,
    8 * 1024 * 1024,
    1_024,
    64 * 1024 * 1024,
);
// Profiles are received as JSON and later returned to the trusted Edge cleanup
// path. Snapshot the exact JSON representation used to sign a cache locator so
// a concurrent in-band enrichment can never pair an old fingerprint with a new
// profile. The normal Express JSON body limit is smaller; this also bounds
// Gateway-generated annotations before duplicating them for publication.
const MKV_COMPLETE_HLS_CACHE_PROFILE_SNAPSHOT_MAX_BYTES = 256 * 1024;
const MKV_COMPLETE_HLS_CACHE_PRUNE_INTERVAL_MS = clampInt(
    process.env.MKV_COMPLETE_HLS_CACHE_PRUNE_INTERVAL_MS,
    15 * 60 * 1_000,
    60 * 1_000,
    24 * 60 * 60 * 1_000,
);
const MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_REQUESTED =
    process.env.MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_ENABLED === 'true';
const MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_MAX_MS = clampInt(
    process.env.MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_MAX_MS,
    30 * 60 * 1_000,
    60 * 1_000,
    2 * 60 * 60 * 1_000,
);
const MKV_COMPLETE_HLS_BACKGROUND_CALLBACK_TIMEOUT_MS = clampInt(
    process.env.MKV_COMPLETE_HLS_BACKGROUND_CALLBACK_TIMEOUT_MS,
    10_000,
    1_000,
    30_000,
);
const mkvCompleteHlsCacheStats = {
    hits: 0,
    misses: 0,
    invalidProofs: 0,
    corruptions: 0,
    promotions: 0,
    promotionFailures: 0,
    activeLeases: 0,
    prunedEntries: 0,
    prunedBytes: 0,
    continuationsStarted: 0,
    continuationsCompleted: 0,
    continuationsPreempted: 0,
    continuationsTimedOut: 0,
    continuationsFailed: 0,
    continuationCallbackFailures: 0,
};
let mkvCompleteHlsCache = null;
let mkvCompleteHlsCacheStatus = MKV_COMPLETE_HLS_CACHE_REQUESTED ? 'disabled' : 'not-requested';
if (
    MKV_COMPLETE_HLS_CACHE_REQUESTED &&
    MKV_COMPLETE_HLS_CACHE_ACTIVATION_READY &&
    MKV_COMPLETE_HLS_CACHE_COORDINATION_MODE === 'local' &&
    MKV_COMPLETE_HLS_CACHE_SINGLE_INSTANCE_ATTESTED
) {
    try {
        mkvCompleteHlsCache = new CompleteMkvHlsCache({
            root: MKV_COMPLETE_HLS_CACHE_ROOT,
            manifestHmacKey: process.env.MKV_COMPLETE_HLS_CACHE_MANIFEST_HMAC_KEY,
            maxBytes: MKV_COMPLETE_HLS_CACHE_MAX_BYTES,
            minFreeBytes: MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES,
            ttlMs: MKV_COMPLETE_HLS_CACHE_TTL_MS,
            maxEntryBytes: MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES,
            maxFiles: MKV_COMPLETE_HLS_CACHE_MAX_FILES,
            maxPlaylistBytes: MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES,
        });
        mkvCompleteHlsCacheStatus = 'enabled-local-single-instance';
    } catch (error) {
        mkvCompleteHlsCacheStatus = error instanceof MkvHlsCacheError
            ? String(error.code || 'invalid-config').toLowerCase()
            : 'invalid-config';
    }
} else if (MKV_COMPLETE_HLS_CACHE_REQUESTED) {
    mkvCompleteHlsCacheStatus = MKV_COMPLETE_HLS_CACHE_COORDINATION_MODE !== 'local'
        ? 'shared-coordination-unavailable'
        : (MKV_COMPLETE_HLS_CACHE_SINGLE_INSTANCE_ATTESTED ? 'activation-unavailable' : 'single-instance-not-attested');
}
const MULTI_AUDIO_HLS_PROTOCOL = 1;
const MAX_MULTI_AUDIO_RENDITIONS = 8;
const GATEWAY_VERSION = 117;

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
const activeVideoEncoderAdmissions = new Set();
function reserveVideoEncoderAdmission(session) {
    if (videoModeForSession(session) !== 'encode') return true;
    if (session.videoEncoderAdmissionHeld === true) return true;
    if (activeVideoEncoderAdmissions.size >= MAX_ACTIVE_VIDEO_ENCODER_SESSIONS) return false;
    activeVideoEncoderAdmissions.add(session.id);
    session.videoEncoderAdmissionHeld = true;
    return true;
}
function releaseVideoEncoderAdmission(session) {
    if (!session || session.videoEncoderAdmissionHeld !== true) return;
    session.videoEncoderAdmissionHeld = false;
    activeVideoEncoderAdmissions.delete(session.id);
}
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
const rawStreamStats = {
    requests: 0,
    firstByteTimeouts: 0,
    prefixTimeouts: 0,
    startupTimeouts: 0,
    firstByteReadErrors: 0,
    emptyBodies: 0,
    nonMediaBodies: 0,
    providerRetries: 0,
    idleTimeouts: 0,
    lastFailure: null
};
const sessionStartupStats = {
    attempts: 0,
    successes: 0,
    totalMs: 0,
    liveInputProbeAttempts: 0,
    fastInputProbeAttempts: 0,
    fullInputProbeAttempts: 0,
    fastInputProbeSuccesses: 0,
    fastInputProbeFallbacks: 0,
    last: null
};
const vodInputPumpStats = {
    starts: 0,
    reconnects: 0,
    completed: 0,
    failures: 0,
    bytesForwarded: 0,
    validatorEvidence: {
        strongEtag: 0,
        lastModified: 0,
        weakOrAbsent: 0,
    },
    last: null,
};
const mkvH264FullFileAnalyzers = new Set();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors);

app.options('*', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        providerCircuitProtocol: 1,
        vodContainerSelfHealProtocol: 1,
        codecProbe: true,
        codecProbeTimeoutMs: CODEC_PROBE_TIMEOUT_MS,
        codecProbeAnalyzeDurationUs: CODEC_PROBE_ANALYZE_DURATION_US,
        codecProbeSizeBytes: CODEC_PROBE_SIZE_BYTES,
        knownVodInputProbeFastPathEnabled: KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED,
        knownVodInputAnalyzeDurationUs: KNOWN_VOD_INPUT_ANALYZE_DURATION_US,
        knownVodInputProbeSizeBytes: KNOWN_VOD_INPUT_PROBE_SIZE_BYTES,
        finiteMkvFullBodyAtZeroFallback: true,
        finiteMkvFullBodyKnownSizeExactEof: true,
        finiteMkvFullBodyUnknownSizeEof: true,
        finiteMkvFullBodyMaximumBytes: VOD_INPUT_FULL_BODY_MAX_BYTES,
        exactFileCodecProfileProtocol: 1,
        exactMatroskaH264ReencodeProtocol: 1,
        exactMatroskaH264HlsTargetSeconds: EXACT_MATROSKA_H264_HLS_TARGET_SECONDS,
        exactMatroskaH264MaxWidth: EXACT_MATROSKA_H264_MAX_WIDTH,
        exactMatroskaH264MaxHeight: EXACT_MATROSKA_H264_MAX_HEIGHT,
        exactMatroskaH264MaxPixels: EXACT_MATROSKA_H264_MAX_PIXELS,
        videoEncoder: publicVideoEncoderStatus(VIDEO_ENCODER_CONFIG, VIDEO_ENCODER_PREFLIGHT),
        videoEncoderCapacity: {
            protocol: 1,
            active: activeVideoEncoderAdmissions.size,
            maxActive: MAX_ACTIVE_VIDEO_ENCODER_SESSIONS,
        },
        vaapiVodFastStart: {
            protocol: 1,
            enabled: VIDEO_ENCODER_CONFIG.backend === 'vaapi' && VIDEO_ENCODER_PREFLIGHT.ready === true,
            targetBufferSeconds: VAAPI_VOD_FAST_START_BUFFER_SECONDS,
            minimumEncodeRateX: VAAPI_VOD_FAST_START_MIN_ENCODE_RATE_X,
        },
        mkvH264FastStart: {
            protocol: MKV_H264_FAST_START_PROTOCOL,
            proofBuild: MKV_H264_FAST_START_PROOF_BUILD,
            copyActivationReady: MKV_H264_FAST_START_COPY_ACTIVATION_READY,
            closedGopProof: 'full-file-keyframe-idr-match',
            proofRequiresFullEof: true,
            fullFileProofSigningConfigured: Boolean(MKV_H264_FAST_START_PROOF_CURRENT_KEY),
            fullFileProofPreviousKeyConfigured: Boolean(MKV_H264_FAST_START_PROOF_PREVIOUS_KEY),
            proofMaxAgeMs: MKV_H264_FAST_START_PROOF_MAX_AGE_MS,
            proofScope: 'full-file',
            maxGopSeconds: MKV_H264_FAST_START_MAX_GOP_SECONDS,
            minKeyframes: MKV_H264_FAST_START_MIN_KEYFRAMES,
            hlsTargetSeconds: EXACT_MATROSKA_H264_HLS_TARGET_SECONDS,
            targetBufferSeconds: MKV_H264_FAST_START_BUFFER_SECONDS,
            minSegments: MKV_H264_FAST_START_MIN_SEGMENTS,
            minimumEncodeRateX: MKV_H264_FAST_START_MIN_ENCODE_RATE_X,
            activeAnalyzers: mkvH264FullFileAnalyzers.size,
        },
        mkvH264HlsCache: {
            protocol: MKV_H264_HLS_CACHE_PROTOCOL,
            enabled: mkvH264HlsCacheEnabled(),
            scope: 'local-replica',
            prefixSegments: MKV_H264_HLS_CACHE_PREFIX_SEGMENTS,
            prefixSeconds: MKV_H264_HLS_CACHE_PREFIX_SECONDS,
            minimumProductionRateX: MKV_H264_HLS_CACHE_MIN_PRODUCTION_RATE_X,
            ttlMs: MKV_H264_HLS_CACHE_TTL_MS,
            maxEntries: MKV_H264_HLS_CACHE_MAX_ENTRIES,
            maxBytes: MKV_H264_HLS_CACHE_MAX_BYTES,
            maxCompleteBytes: MKV_H264_HLS_CACHE_MAX_COMPLETE_BYTES,
            stats: { ...mkvH264HlsCacheStats },
        },
        mkvCompleteHlsCache: {
            protocol: MKV_COMPLETE_HLS_CACHE_PROTOCOL,
            activationReady: MKV_COMPLETE_HLS_CACHE_ACTIVATION_READY,
            requested: MKV_COMPLETE_HLS_CACHE_REQUESTED,
            enabled: Boolean(mkvCompleteHlsCache),
            status: mkvCompleteHlsCacheStatus,
            coordinationMode: MKV_COMPLETE_HLS_CACHE_COORDINATION_MODE,
            singleInstanceAttested: MKV_COMPLETE_HLS_CACHE_SINGLE_INSTANCE_ATTESTED,
            scope: 'local-private-complete-hls-only',
            pipelineBuild: MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD,
            locatorBuild: MKV_COMPLETE_HLS_CACHE_LOCATOR_BUILD,
            locatorSigningReady: Boolean(MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY),
            genericSingleAudio: true,
            genericMultiAudio: true,
            subtitleAssets: false,
            backgroundContinuation: {
                protocol: 1,
                requested: MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_REQUESTED,
                enabled: mkvCompleteHlsBackgroundContinuationEnabled(),
                maxMs: MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_MAX_MS,
                active: Array.from(sessions.values()).filter((session) => (
                    session?.backgroundCacheContinuation === true && !session?.stoppingPromise
                )).length,
            },
            ttlMs: MKV_COMPLETE_HLS_CACHE_TTL_MS,
            maxBytes: MKV_COMPLETE_HLS_CACHE_MAX_BYTES,
            minFreeBytes: MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES,
            maxEntryBytes: MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES,
            stats: { ...mkvCompleteHlsCacheStats },
        },
        multiAudioHls: {
            protocol: MULTI_AUDIO_HLS_PROTOCOL,
            maxAudioRenditions: MAX_MULTI_AUDIO_RENDITIONS,
            active: Array.from(sessions.values()).filter((session) => (
                session?.multiAudioHls?.enabled === true
            )).length,
        },
        boundedMkvInputPumpProtocol: 1,
        finiteMkvSeekBroker: {
            protocol: 1,
            active: Array.from(sessions.values()).filter((session) => (
                Boolean(session?.finiteMkvSeekBroker)
            )).length,
            providerConnectionsSerialized: true,
            exactRangeDrainReopensImmediately: true,
            plannedSupersessionReopensImmediately: true,
            identityPreflightRange: 'bytes=0-0',
            interruptedRangeReleaseDelayMs: PROVIDER_SLOT_RELEASE_DELAY_MS,
            effectiveUrlPinned: true,
            validatorPinnedWhenAvailable: true,
        },
        vodFileSizeProbeTimeoutMs: VOD_FILE_SIZE_PROBE_TIMEOUT_MS,
        vodInputPump: {
            ...vodInputPumpStats,
            active: Array.from(sessions.values()).filter((session) => (
                session?.inputPump && session.inputPump.completed !== true
            )).length,
            openTimeoutMs: VOD_INPUT_OPEN_TIMEOUT_MS,
            idleTimeoutMs: VOD_INPUT_IDLE_TIMEOUT_MS,
            retryLimit: VOD_INPUT_RETRY_LIMIT,
            maxReconnects: VOD_INPUT_MAX_RECONNECTS,
        },
        minHlsStartupBufferSeconds: MIN_HLS_STARTUP_BUFFER_SECONDS,
        minHlsStartupSegments: MIN_HLS_STARTUP_SEGMENTS,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        maxSubtitleTracks: MAX_SUBTITLE_TRACKS,
        activeViewerSubtitleOperations: activeViewerSubtitleOperations.size,
        maxActiveViewerSubtitleOperations: MAX_ACTIVE_VIEWER_SUBTITLE_OPERATIONS,
        pendingViewerSubtitleOperations: viewerSubtitleWaitQueue.length,
        maxPendingViewerSubtitleOperations: MAX_PENDING_VIEWER_SUBTITLE_OPERATIONS,
        viewerSubtitleQueueWaitMs: VIEWER_SUBTITLE_QUEUE_WAIT_MS,
        probeStats,
        rawStreamHealth: {
            ...rawStreamStats,
            firstByteTimeoutMs: RAW_FIRST_BYTE_TIMEOUT_MS,
            startupDeadlineMs: RAW_STARTUP_DEADLINE_MS,
            noDataRetryLimit: RAW_NO_DATA_RETRY_LIMIT,
            idleTimeoutMs: RAW_IDLE_TIMEOUT_MS
        },
        sessionStartupStats: {
            ...sessionStartupStats,
            averageMs: sessionStartupStats.successes > 0
                ? Math.round(sessionStartupStats.totalMs / sessionStartupStats.successes)
                : null
        },
        codecProfileCacheSize: codecProfileCache.size,
        languageDetect: Boolean(WHISPER_BIN && WHISPER_MODEL),
        strictLidLoopbackBrokerProtocol: 1,
        strictLidFileSizeClaim: 'fileSizeBytes',
        strictLidHeaderCapabilityProtocol: 2,
        strictLidProviderDrainProtocol: 1,
        strictLidWeakFallbackProtocol: 1,
        strictLidBatchProtocol: 1,
        strictLidActivityKindProtocol: 1,
        strictLidCjkEvidenceProtocol: 1,
        strictLidTranscriptDiversityProtocol: 1,
        strictLidExtractionTimeoutProtocol: 4,
        strictLidBudgetRebalanceProtocol: 1,
        strictLidWindowCheckpointProtocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
        strictLidWindowEvidenceEnvelopeProtocol: STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
        strictLidWindowFinalizeObservabilityProtocol: 1,
        strictLidBatchFailureProtocol: 1,
        strictLidTimelineSamplingProtocol: 1,
        strictLidRangeTimeoutProtocol: 2,
        strictLidRangeFirstByteTimeoutMs: STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS,
        strictLidRangeIdleTimeoutMs: STRICT_LID_BROKER_IDLE_TIMEOUT_MS,
        strictLidFfmpegRwTimeoutUs: STRICT_LID_FFMPEG_RW_TIMEOUT_US,
        strictLidCheckpointFfmpegRwTimeoutUs: STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US,
        strictLidSampleDurationCapSeconds: STRICT_LID_SAMPLE_DURATION_CAP_SECONDS,
        strictLidWhisperReserveMs: STRICT_LID_WHISPER_RESERVE_MS,
        strictLidExtractionStartupMarginMs: STRICT_LID_EXTRACTION_STARTUP_MARGIN_MS,
        strictLidExtractionAggregateBudgetMs: STRICT_LID_EXTRACTION_AGGREGATE_BUDGET_MS,
        strictLidWindowExtractionBudgetMs: STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS,
        strictLidRequestBudgetMs: STRICT_LID_REQUEST_BUDGET_MS,
        strictLidCapabilityHeader: 'X-Norva-Byte-Pipe-Token',
        strictLidCapabilityMethod: 'POST',
        strictLidServiceAuthRequired: true,
        strictLidRequiredScope: LID_LEGACY_FULL_SCOPE,
        strictLidProviderSlotReleaseDelayMs: PROVIDER_SLOT_RELEASE_DELAY_MS,
        languageDetectEngine: WHISPER_BIN && WHISPER_MODEL ? {
            family: 'whisper.cpp',
            model: WHISPER_MODEL_NAME,
            commit: WHISPER_CPP_COMMIT,
            binarySha256: WHISPER_BIN_SHA256,
            modelSha256: WHISPER_MODEL_SHA256,
            runtimeVerified: WHISPER_RUNTIME_VERIFIED,
            detectOnlyBenchmark: true,
            detectOnlyProductionAvailable: WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE,
            detectOnlyMinProbability: WHISPER_DETECT_ONLY_MIN_PROBABILITY,
            detectOnlyTimeoutMs: WHISPER_DETECT_ONLY_TIMEOUT_MS,
        } : null,
        lidDetectOnlyStats: {
            ...lidDetectOnlyStats,
            instance: LID_BENCHMARK_INSTANCE,
            averageFastMs: (
                lidDetectOnlyStats.primaryAttempts + lidDetectOnlyStats.shadowAttempts
            ) > 0
                ? Math.round(
                    lidDetectOnlyStats.totalFastMs /
                    (lidDetectOnlyStats.primaryAttempts + lidDetectOnlyStats.shadowAttempts),
                )
                : null,
            averageShadowFullMs: lidDetectOnlyStats.shadowFullRuns > 0
                ? Math.round(lidDetectOnlyStats.shadowFullMs / lidDetectOnlyStats.shadowFullRuns)
                : null,
            averageFallbackFullMs: lidDetectOnlyStats.fallbackFullRuns > 0
                ? Math.round(lidDetectOnlyStats.fallbackFullMs / lidDetectOnlyStats.fallbackFullRuns)
                : null,
            shadowComparable: lidDetectOnlyStats.shadowAgreements +
                lidDetectOnlyStats.shadowDisagreements,
            shadowAgreementRate: (
                lidDetectOnlyStats.shadowAgreements + lidDetectOnlyStats.shadowDisagreements
            ) > 0
                ? Number((
                    lidDetectOnlyStats.shadowAgreements /
                    (lidDetectOnlyStats.shadowAgreements + lidDetectOnlyStats.shadowDisagreements)
                ).toFixed(4))
                : null,
            primaryAcceptanceRate: lidDetectOnlyStats.primaryAttempts > 0
                ? Number((
                    lidDetectOnlyStats.primaryAccepted / lidDetectOnlyStats.primaryAttempts
                ).toFixed(4))
                : null,
        },
        languageWavExtraction: {
            available: true,
            scopes: [...LID_CASCADE_WAV_SCOPES],
            maxBytes: LID_LANGUAGE_WAV_MAX_BYTES,
            format: {
                container: 'RIFF/WAVE',
                codec: 'pcm_s16le',
                sampleRate: 16000,
                channels: 1,
                bitsPerSample: 16,
            },
            limits: {
                maxTrackIndex: 1024,
                maxStartSeconds: 21600,
                minDurationSeconds: 8,
                maxDurationSeconds: 30,
            },
            active: lidLanguageWavActive,
        },
        languageWavExtractionStats: {
            ...lidLanguageWavStats,
            averageExtractMs: lidLanguageWavStats.attempts > 0
                ? Math.round((lidLanguageWavStats.totalExtractMs / lidLanguageWavStats.attempts) * 100) / 100
                : null,
        },
        translate: ARGOS_ENABLED,
        translateTargets: ARGOS_ENABLED ? argosTargets() : [],
        ocr: OCR_ENABLED,
        ocrLangs: OCR_ENABLED ? OCR_LANGS : '',
        providerProxy: providerProxyAgents.length > 0,
        providerProxyPool: providerProxyAgents.length,
        providerProxyAffinityProtocol: 1,
        providerProxyAffinityKey: 'provider-account',
        providerProxySlotOverrideProtocol: 1,
        providerProxySlotOverrideConfigured: providerProxySlotOverrides.size > 0,
        transcribeQueueDepth: transcribeQueue.length,
        transcribeBusy,
        ocrQueueDepth: ocrQueue.length,
        ocrBusy,
        translateQueueDepth: translateQueue.length,
        translateBusy,
        rawPumpCount: rawPumps.size,
        viewerStartupReservations: viewerStartupReservations.size,
        viewerSessionStartupAdmissions: viewerSessionStartupAdmissions.size,
        viewerSessionStartupLockCount: viewerSessionStartupLocks.size,
        viewerSessionStartupWaiters: Array.from(viewerSessionStartupLocks.values())
            .reduce((sum, state) => sum + Number(state?.waiters?.length || 0), 0),
        viewerSessionStartupAdmissionLimits: {
            global: MAX_VIEWER_SESSION_STARTUP_ADMISSIONS,
            perKey: MAX_VIEWER_SESSION_STARTUPS_PER_KEY,
        },
        viewerSessionStartupAdmissionStats: { ...viewerSessionStartupAdmissionStats },
        viewerPlaybackActiveLocally: viewerPlaybackActiveLocally(),
        viewerSessionIdleTimeoutMs: VIEWER_SESSION_IDLE_TIMEOUT_MS,
        viewerQosStats: { ...viewerQosStats },
        providerSlotReleaseDelayMs: PROVIDER_SLOT_RELEASE_DELAY_MS,
        providerCatalogRefreshSlotReleaseDelayMs: PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS,
        backgroundCpuProcessCount: backgroundCpuProcesses.size,
        whisperInferenceActive,
        backgroundWhisperInferenceActive: backgroundWhisperCount(),
        backgroundWhisperPreemptions,
        argosInferenceActive,
        lidBenchmarkBusy,
        inbandHeaderParse: INBAND_HEADER_PARSE,
        boundedMkvHeaderParse: BOUNDED_MKV_HEADER_PARSE,
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

app.post('/sessions/stop-provider-affinities', requireGatewayAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const values = Array.isArray(req.body?.affinityHashes) ? req.body.affinityHashes : [];
    const affinityHashes = [...new Set(values.map((value) => String(value || '').trim().toLowerCase()))];
    if (!affinityHashes.length || affinityHashes.length > 64
        || affinityHashes.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
        return res.status(400).json({ error: 'affinityHashes must contain 1-64 SHA-256 values' });
    }
    const outcome = await stopProviderAffinities(affinityHashes);
    if (!outcome.providerDrained) {
        return res.status(409).json({ error: 'Provider transport remains active', providerDrained: false });
    }
    return res.status(200).json({
        ok: true, protocol: 1, providerDrained: true,
        stoppedSessions: outcome.stoppedSessions,
        abortedRawPumps: outcome.abortedRawPumps,
        stoppedExtractions: outcome.stoppedExtractions,
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
        const payload = await fetchProviderJson(
            url,
            sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT,
            XTREAM_REQUEST_TIMEOUT_MS,
            { backgroundAccountKey: providerAccountKeyFromCredentials(serverUrl, username) },
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
        const payload = await fetchProviderJson(
            url,
            sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT,
            XTREAM_REQUEST_TIMEOUT_MS,
            { backgroundAccountKey: providerAccountKeyFromCredentials(serverUrl, username) },
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
const XTREAM_ACCOUNT_INFO_MAX_BYTES = clampInt(
    process.env.XTREAM_ACCOUNT_INFO_MAX_BYTES,
    256 * 1024,
    64 * 1024,
    1024 * 1024,
);

// Credential transitions consume catalogue arrays through a disk-backed page
// contract.  The provider response is streamed exactly once into bounded page
// files; later durable worker claims resume with an opaque HMAC cursor instead
// of downloading (and buffering) the same category again.  Account validation
// remains on /xtream/metadata because that response is a small object.
const XTREAM_CATALOG_PAGE_ACTIONS = new Set([
    'get_live_streams', 'get_vod_streams', 'get_series',
    'get_live_categories', 'get_vod_categories', 'get_series_categories',
]);
const XTREAM_CATALOG_STREAM_ACTIONS = new Set([
    'get_live_streams', 'get_vod_streams', 'get_series',
]);
const XTREAM_CATALOG_SPOOL_DIR = path.resolve(
    process.env.XTREAM_CATALOG_SPOOL_DIR || path.join(OUTPUT_DIR, 'credential-catalog-spools'),
);
// Private panels are never enabled by an API request. An operator may opt in
// exact hostnames/IPs for a controlled deployment; wildcards and CIDRs are not
// accepted, and the resolved destination is still pinned for the request.
const XTREAM_PRIVATE_EGRESS_ALLOWLIST = configuredXtreamPrivateEgressAllowlist(
    process.env.XTREAM_PRIVATE_EGRESS_ALLOWLIST || '',
);
const XTREAM_CATALOG_SPOOL_TTL_MS = clampInt(
    process.env.XTREAM_CATALOG_SPOOL_TTL_MS,
    // At the enforced 1,000,000-item/spool maximum, 250 items/page and eight
    // bounded pages per one-minute worker claim need 500 claims (~8h20m).
    // Sixteen hours is the operational default; the twelve-hour floor keeps a
    // >40% expiry margin while still bounding encrypted disk retention. Each
    // action spool is created just-in-time, so this bound applies per action.
    16 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
);
const XTREAM_CATALOG_BUILD_TIMEOUT_MS = clampInt(
    process.env.XTREAM_CATALOG_BUILD_TIMEOUT_MS,
    20 * 60 * 1000,
    60 * 1000,
    60 * 60 * 1000,
);
const XTREAM_CATALOG_FAILURE_RETRY_MS = clampInt(
    process.env.XTREAM_CATALOG_FAILURE_RETRY_MS,
    30 * 1000,
    1000,
    15 * 60 * 1000,
);
const XTREAM_CATALOG_PAGE_MAX_ITEMS = clampInt(
    process.env.XTREAM_CATALOG_PAGE_MAX_ITEMS,
    250,
    1,
    500,
);
const XTREAM_CATALOG_PAGE_MAX_BYTES = clampInt(
    process.env.XTREAM_CATALOG_PAGE_MAX_BYTES,
    4 * 1024 * 1024,
    64 * 1024,
    8 * 1024 * 1024,
);
const XTREAM_CATALOG_ITEM_MAX_BYTES = clampInt(
    process.env.XTREAM_CATALOG_ITEM_MAX_BYTES,
    512 * 1024,
    16 * 1024,
    XTREAM_CATALOG_PAGE_MAX_BYTES,
);
const XTREAM_CATALOG_SPOOL_MAX_BYTES = clampInt(
    process.env.XTREAM_CATALOG_SPOOL_MAX_BYTES,
    512 * 1024 * 1024,
    XTREAM_CATALOG_PAGE_MAX_BYTES,
    1024 * 1024 * 1024,
);
const XTREAM_CATALOG_SPOOL_MAX_ITEMS = clampInt(
    process.env.XTREAM_CATALOG_SPOOL_MAX_ITEMS,
    1_000_000,
    1,
    2_000_000,
);

app.post('/xtream/metadata-page', requireGatewayAuth, async (req, res) => {
    try {
        const {
            serverUrl, username, password, action, params, userAgent,
            cursor, spoolToken, spoolKey, maxItems,
        } = req.body || {};
        const normalizedAction = String(action || '');
        const requestedMaxItems = Number(maxItems || XTREAM_CATALOG_PAGE_MAX_ITEMS);
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password
            || !XTREAM_CATALOG_PAGE_ACTIONS.has(normalizedAction)
            || !Number.isInteger(requestedMaxItems)
            || requestedMaxItems < 1 || requestedMaxItems > XTREAM_CATALOG_PAGE_MAX_ITEMS
            || typeof spoolKey !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(spoolKey)) {
            return res.status(400).json({ error: 'Invalid bounded catalogue page request' });
        }
        await assertXtreamEgressTarget(serverUrl);
        const categoryId = normalizeXtreamCatalogCategoryParam(normalizedAction, params);
        const request = {
            serverUrl,
            username,
            password,
            action: normalizedAction,
            categoryId,
            maxItems: requestedMaxItems,
            spoolKey,
        };
        const page = await readXtreamCatalogPage({
            request,
            cursor: typeof cursor === 'string' && cursor ? cursor : null,
            spoolToken: typeof spoolToken === 'string' && spoolToken ? spoolToken : null,
            userAgent: sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json(page);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        if (status === 202 || err.retryAfterSeconds) {
            res.setHeader('Retry-After', String(err.retryAfterSeconds || 2));
        }
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            code: err.code || undefined,
            cursor: status === 202 ? err.cursor : undefined,
            spoolToken: status === 202 ? err.spoolToken : undefined,
            retryAfterSeconds: status === 202 ? (err.retryAfterSeconds || 2) : undefined,
        });
    }
});

app.post('/xtream/metadata', requireGatewayAuth, async (req, res) => {
    try {
        const { serverUrl, username, password, action, params, userAgent } = req.body || {};
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password || !action) {
            return res.status(400).json({ error: 'serverUrl, username, password and action are required' });
        }
        await assertXtreamEgressTarget(serverUrl);
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
            {
                backgroundAccountKey: providerAccountKeyFromCredentials(serverUrl, username),
                activityKind: ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH,
                maxResponseBytes: isAccountInfo ? XTREAM_ACCOUNT_INFO_MAX_BYTES : undefined,
            },
        );
        res.json(payload);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        const accountValidation = String(req.body?.action || '') === 'account_info';
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            // Credential validation callers receive only the gateway's typed
            // code. Raw provider bodies may contain account ids, usernames,
            // URLs, tokens, or free-form messages and never cross this route.
            details: accountValidation ? undefined : (err.details || undefined),
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
// Textual content-types are inspected for provider error pages; recognized HLS,
// DASH and Smooth Streaming manifests remain valid stream payloads.
const NON_MEDIA_CONTENT_TYPE_RE = /^\s*(?:text\/|application\/(?:json|xml|[\w.-]+\+(?:json|xml)))/i;

function rawStartupRemainingMs(deadlineAt) {
    return Math.max(0, Number(deadlineAt || 0) - Date.now());
}

// Each provider attempt owns a controller linked to the client request. Its
// timer is the route-wide deadline, not a fresh per-attempt allowance. A chosen
// response clears only that timer and remains linked to the client for streaming.
function createRawAttemptGuard(parentSignal, deadlineAt) {
    const controller = new AbortController();
    let deadlineTimer = null;
    let deadlineExpired = false;
    const onParentAbort = () => {
        try { controller.abort(parentSignal && parentSignal.reason); } catch (_) {}
    };
    if (parentSignal) {
        if (parentSignal.aborted) onParentAbort();
        else {
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
            if (parentSignal.aborted) onParentAbort();
        }
    }
    const remaining = rawStartupRemainingMs(deadlineAt);
    if (!controller.signal.aborted) {
        if (remaining <= 0) {
            deadlineExpired = true;
            try { controller.abort(new Error('raw_startup_deadline')); } catch (_) {}
        } else {
            deadlineTimer = setTimeout(() => {
                deadlineExpired = true;
                try { controller.abort(new Error('raw_startup_deadline')); } catch (_) {}
            }, remaining);
            if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        }
    }
    const clearDeadline = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = null;
    };
    return {
        controller,
        signal: controller.signal,
        get deadlineExpired() { return deadlineExpired; },
        abort(reason = 'raw_attempt_abandoned') {
            try { controller.abort(new Error(reason)); } catch (_) {}
        },
        completeStartup: clearDeadline,
        dispose() {
            clearDeadline();
            if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
        },
    };
}

// Cancellation is deliberately fire-and-forget: a broken provider must not be
// able to keep the HTTP handler alive by never resolving ReadableStream.cancel().
function cancelRawBodyBestEffort(cancelable) {
    if (!cancelable || typeof cancelable.cancel !== 'function') return;
    const release = () => {
        if (typeof cancelable.releaseLock === 'function') {
            try { cancelable.releaseLock(); } catch (_) {}
        }
    };
    try {
        Promise.resolve(cancelable.cancel()).catch(() => {}).finally(release);
    } catch (_) {
        release();
    }
}

function abandonRawAttempt(guard, cancelable, reason) {
    if (guard) guard.abort(reason);
    cancelRawBodyBestEffort(cancelable);
    if (guard) guard.dispose();
}

function waitForRawBackoff(delayMs, deadlineAt, signal) {
    if (signal && signal.aborted) return Promise.resolve('aborted');
    const remaining = rawStartupRemainingMs(deadlineAt);
    if (remaining <= 0) return Promise.resolve('deadline');
    const requested = Math.max(0, Number(delayMs) || 0);
    const waitMs = Math.min(requested, remaining);
    const reachesDeadline = requested >= remaining;
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => finish('aborted');
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }
        if (!settled) timer = setTimeout(() => finish(reachesDeadline ? 'deadline' : 'complete'), waitMs);
    });
}

function readRawPrefixChunk(reader, signal, timeoutMs) {
    if (signal && signal.aborted) return Promise.resolve({ aborted: true });
    let timer = null;
    let onAbort = null;
    const read = reader.read()
        .then(({ value, done }) => ({ value, done, timedOut: false, aborted: false }))
        .catch((error) => ({ error, done: false, timedOut: false, aborted: false }));
    const stop = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, done: false, aborted: false }), Math.max(1, timeoutMs));
        if (signal) {
            onAbort = () => resolve({ aborted: true, done: false, timedOut: false });
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }
    });
    return Promise.race([read, stop]).finally(() => {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    });
}

// Text-shaped provider errors can be split over several network chunks. Read a
// bounded prefix, while retaining every consumed byte for replay into the pipe.
// If an ambiguous prefix stalls after at least one byte, it fails open; the idle
// watchdog remains responsible for a provider that stops mid-stream.
async function sniffLeadingBytes(webBody, signal, timeoutMs, inspectPrefix) {
    let reader = null;
    try {
        reader = webBody.getReader();
    } catch (error) {
        return { chunk: Buffer.alloc(0), reader, timedOut: false, error };
    }
    const chunks = [];
    let totalBytes = 0;
    let classification = 'need-more';
    const sniffDeadlineAt = Date.now() + Math.max(1, timeoutMs || RAW_FIRST_BYTE_TIMEOUT_MS);
    while (totalBytes < RAW_PREFIX_SNIFF_BYTES) {
        const remaining = rawStartupRemainingMs(sniffDeadlineAt);
        if (remaining <= 0) {
            return {
                chunk: chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0),
                reader,
                timedOut: totalBytes === 0,
                prefixTimedOut: totalBytes > 0,
                classification,
            };
        }
        const next = await readRawPrefixChunk(reader, signal, remaining);
        if (next.aborted) {
            return {
                chunk: chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0),
                reader,
                timedOut: false,
                aborted: true,
                classification,
            };
        }
        if (next.timedOut) {
            return {
                chunk: chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0),
                reader,
                timedOut: totalBytes === 0,
                prefixTimedOut: totalBytes > 0,
                classification,
            };
        }
        if (next.error) {
            if (!(signal && signal.aborted)) {
                console.warn('[media-gateway] /raw prefix read failed:', redactCreds(String((next.error && next.error.message) || next.error)));
            }
            return {
                chunk: chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0),
                reader,
                timedOut: false,
                error: next.error,
                classification,
            };
        }
        if (next.value && next.value.length) {
            const value = Buffer.from(next.value);
            chunks.push(value);
            totalBytes += value.length;
        }
        const leading = chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0);
        const sample = leading.subarray(0, RAW_PREFIX_SNIFF_BYTES);
        classification = typeof inspectPrefix === 'function'
            ? inspectPrefix(sample, Boolean(next.done))
            : (sample.length ? 'media' : 'need-more');
        if (next.done || classification !== 'need-more' || sample.length >= RAW_PREFIX_SNIFF_BYTES) {
            return { chunk: leading, reader, timedOut: false, classification };
        }
    }
    return {
        chunk: chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0),
        reader,
        timedOut: false,
        classification,
    };
}

// Container magics of the binary formats /raw commonly pipes. Text manifests
// are classified separately so BOMs and split network chunks remain valid.
function hasKnownRawMediaMagic(buf) {
    if (!buf || buf.length === 0) return false;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 16));
    if (buf.length >= 8 && head.slice(4, 8) === 'ftyp') return true; // mp4 / mov
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // mkv/webm (EBML)
    if (head.startsWith('FLV')) return true;
    if (buf.length >= 189 && buf[0] === 0x47 && buf[188] === 0x47) return true; // MPEG-TS packet sync bytes
    if (head.startsWith('RIFF')) return true; // avi / wav
    if (head.startsWith('OggS') || head.startsWith('fLaC')) return true;
    return head.startsWith('ID3') || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0); // mp3 / ADTS
}

// "Text-shaped": printable UTF-8 + whitespace across the bounded sample
// (optional UTF-8 BOM). Fatal decoding keeps arbitrary binary fail-open, while
// streaming decode tolerates a multi-byte character split at the sample edge.
function looksLikeTextStart(buf) {
    let i = 0;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
    const n = Math.min(buf.length, RAW_PREFIX_SNIFF_BYTES);
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(i, n), { stream: true });
    } catch (_) {
        return false;
    }
    for (const char of text) {
        const cp = char.codePointAt(0);
        const printable = cp === 0x09 || cp === 0x0a || cp === 0x0d
            || (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f));
        if (!printable) return false;
    }
    return true;
}

function normalizedRawTextPrefix(buf) {
    return buf.toString('utf8', 0, Math.min(buf.length, RAW_PREFIX_SNIFF_BYTES))
        .replace(/^\uFEFF/, '')
        .replace(/^\s+/, '');
}

function isRawTextManifest(text) {
    if (/^#EXTM3U(?:[\r\n]|$)/i.test(text)) return true;
    return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:MPD|SmoothStreamingMedia)\b/i.test(text);
}

function isExplicitRawProviderError(text) {
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text)) return true;
    if (/^[{[]/.test(text) && /["'](?:error|message|detail|status)["']\s*:/i.test(text)) return true;
    return /\b(?:user_multi_ip|maximum?\s+connections?|max[_ -]?connections?|too\s+many\s+connections?|account\s+(?:is\s+)?(?:expired|disabled|blocked)|unauthori[sz]ed|access\s+denied|forbidden|provider\s+busy)\b/i.test(text);
}

function isProviderBusyText(text) {
    return /\b(?:user_multi_ip|maximum?\s+connections?|max[_ -]?connections?|too\s+many\s+connections?|provider[_ -]+busy)\b/i.test(String(text || ''));
}

// Returns need-more only while a short textual prefix might still become a
// known manifest or an explicit provider error. Unknown complete text from an
// octet-stream remains fail-open; unknown text under a textual MIME is refused.
function classifyRawPrefix(buf, contentType, startsAtZero, complete = false) {
    if (!buf || buf.length === 0) return 'need-more';
    if (hasKnownRawMediaMagic(buf)) return 'media';
    const text = normalizedRawTextPrefix(buf);
    if (isRawTextManifest(text)) return 'media';
    const textualType = NON_MEDIA_CONTENT_TYPE_RE.test(String(contentType || ''));
    if ((textualType || startsAtZero) && isExplicitRawProviderError(text)) return 'non-media';
    if (!looksLikeTextStart(buf)) return 'media';
    if (textualType && (complete || buf.length >= RAW_PREFIX_SNIFF_BYTES)) return 'non-media';
    if (complete || buf.length >= RAW_PREFIX_SNIFF_BYTES) return 'media';
    return 'need-more';
}

function rawResponseStartsAtZero(upstream) {
    if (upstream.status === 200) return true; // provider ignored Range: bytes begin at zero
    return /^bytes\s+0-/i.test(String(upstream.headers.get('content-range') || ''));
}

function isDeclaredEmptyRawResponse(upstream) {
    if (!upstream.body || upstream.status === 204 || upstream.status === 205) return true;
    const contentLength = String(upstream.headers.get('content-length') || '').trim();
    return /^0+$/.test(contentLength);
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
                if (done) {
                    try { reader.releaseLock(); } catch (_) {}
                    this.push(null);
                }
                else this.push(Buffer.from(value));
            }).catch((err) => {
                try { reader.releaseLock(); } catch (_) {}
                this.destroy(err);
            });
        },
        destroy(err, cb) {
            cancelRawBodyBestEffort(reader);
            cb(err);
        },
    });
}

function rememberRawFailure(kind, upstreamStatus = null) {
    rawStreamStats.lastFailure = {
        kind,
        upstreamStatus: Number.isInteger(upstreamStatus) ? upstreamStatus : null,
        at: new Date().toISOString()
    };
}

function sendRawStartupTimeout(res, upstreamStatus = null) {
    rawStreamStats.startupTimeouts += 1;
    rememberRawFailure('startup_deadline', upstreamStatus);
    if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
        return;
    }
    res.status(504).json({
        error: 'Provider stream startup exceeded the gateway deadline',
        code: 'PROVIDER_STARTUP_TIMEOUT',
        upstreamStatus: Number.isInteger(upstreamStatus) ? upstreamStatus : null,
    });
}

// Stop an already-started response when the provider goes silent. Pauses caused
// by downstream backpressure suspend the timer, so a slow/paused client is not
// mistaken for a dead upstream connection.
function attachRawIdleWatchdog(nodeStream, res, ac) {
    let timer = null;
    const clear = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    const arm = () => {
        clear();
        if (res.writableNeedDrain || nodeStream.readableFlowing === false) return;
        timer = setTimeout(() => {
            rawStreamStats.idleTimeouts += 1;
            rememberRawFailure('upstream_idle_timeout');
            console.warn(`[media-gateway] /raw upstream idle for ${RAW_IDLE_TIMEOUT_MS}ms; closing so the player can reconnect`);
            try { ac.abort(); } catch (_) {}
            try { nodeStream.destroy(new Error('provider_no_data_idle_timeout')); } catch (_) {}
            try { res.destroy(); } catch (_) {}
        }, RAW_IDLE_TIMEOUT_MS);
    };
    nodeStream.on('data', arm);
    nodeStream.on('resume', arm);
    nodeStream.on('pause', clear);
    nodeStream.on('end', clear);
    nodeStream.on('close', clear);
    nodeStream.on('error', clear);
    res.on('drain', arm);
    res.on('close', clear);
    arm();
}

app.get('/raw/:token', async (req, res) => {
    rawStreamStats.requests += 1;
    const claims = verifyRawToken(req.params.token, GATEWAY_TOKEN);
    if (!claims) return res.status(401).json({ error: 'Invalid byte-pipe token' });
    if (Number(claims.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Byte-pipe token expired' });

    const pumpProxyKey = proxyKeyFromUrl(claims.url);
    const pumpOwnerHash = claims.uid ? sha256Hex(claims.uid) : null;
    const pumpProviderSlotKey = providerSlotKeyFromUrl(claims.url, pumpOwnerHash);
    // Check and register synchronously before the first await. If a transcode
    // startup already owns this provider account, an old Engine /raw request
    // must not reopen the slot between its teardown and FFmpeg spawn.
    if (providerSessionBlocksRawOpening(pumpProviderSlotKey)) {
        return res.status(409).json({
            error: 'This playback request was superseded by a newer session.',
            code: 'PLAYBACK_SUPERSEDED',
        });
    }
    const ac = new AbortController();
    let activeAttemptGuard = null;
    // Supersede any pump left by a PREVIOUS playback session on this account —
    // same-session concurrency (parallel range reads) is spared via claims.sid.
    const pump = registerRawPump({
        ac,
        sid: claims.sid || null,
        proxyKey: pumpProxyKey,
        providerSlotKey: pumpProviderSlotKey,
        ownerHash: pumpOwnerHash,
    });
    let abortedForHandoff = abortRawPumps(
        (p) => p !== pump && p.providerSlotKey === pumpProviderSlotKey,
        claims.sid || null,
        `superseded by playback ${String(claims.sid || 'unknown').slice(0, 8)}`);
    // Same rule as the transcode lane: a viewer's byte-pump outranks any background extraction
    // or CPU inference for this account (the job re-queues as deferred and resumes after the
    // viewing). Viewer-origin subtitle inference is intentionally not in the background ledger.
    const rawPlaybackReason = `raw playback ${String(claims.sid || 'unknown').slice(0, 8)}`;
    abortedForHandoff += preemptAccountExtractions(pumpProxyKey, rawPlaybackReason);
    // CPU preemption does not hold a provider connection and must not trigger the provider
    // slot-release delay below.
    preemptAccountBackgroundWhispers(pumpProxyKey, rawPlaybackReason);
    // This replica has one vCPU: service/pregen work from OTHER accounts can
    // still starve the viewer even though it does not hold this provider slot.
    // Keep explicit viewer-origin jobs, but preempt every registered background
    // extraction/inference and let its queue re-run it after playback.
    preemptBackgroundWorkGlobally(pumpProxyKey, rawPlaybackReason);
    res.on('close', () => {
        ac.abort();
        if (activeAttemptGuard) activeAttemptGuard.dispose();
        releaseRawPump(pump);
    });
    const headers = { 'user-agent': claims.ua || FFMPEG_USER_AGENT };
    if (req.headers.range) headers.range = req.headers.range;
    if (req.headers.accept) headers.accept = req.headers.accept;
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const startupDeadlineAt = Date.now() + RAW_STARTUP_DEADLINE_MS;
    // Resolve once for the whole byte-pipe request. Retries keep the same static
    // egress and can never rotate this provider account to another IP.
    const rawProxyAgent = pickProxyAgent(pumpProxyKey);

    // Retry only transient network/server failures and empty responses. Every 4xx,
    // especially the provider's single-account 458, is terminal on its first response
    // so the playback edge can open the account circuit without creating a request
    // cascade. Exception: one handoff retry after we ourselves aborted the previous
    // holder. All attempts still consume the same hard wall-clock deadline.
    const maxAttempts = 1 + RAW_PROVIDER_RETRY_LIMIT + RAW_NO_DATA_RETRY_LIMIT
        + (abortedForHandoff > 0 ? 1 : 0);
    let upstream = null;
    let sniffedBody = null; // { chunk, reader } validated before response headers are committed
    let noDataAttempts = 0;
    let providerRetryAttempts = 0;
    let rawHandoffRetryUsed = false;
    const waitForRetry = async (attempt, upstreamStatus = null) => {
        const delayMs = RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000;
        const outcome = await waitForRawBackoff(delayMs, startupDeadlineAt, ac.signal);
        if (outcome === 'complete') return true;
        if (outcome === 'aborted' || ac.signal.aborted) {
            try { res.end(); } catch (_) {}
            return false;
        }
        sendRawStartupTimeout(res, upstreamStatus);
        return false;
    };
    if (abortedForHandoff > 0 && PROVIDER_SLOT_RELEASE_DELAY_MS > 0) {
        console.log(`[media-gateway] waiting ${PROVIDER_SLOT_RELEASE_DELAY_MS}ms for provider slot release after aborting ${abortedForHandoff} raw holder(s)`);
        const outcome = await waitForRawBackoff(PROVIDER_SLOT_RELEASE_DELAY_MS, startupDeadlineAt, ac.signal);
        if (outcome === 'aborted' || ac.signal.aborted) {
            try { res.end(); } catch (_) {}
            return;
        }
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (rawStartupRemainingMs(startupDeadlineAt) <= 0) {
            sendRawStartupTimeout(res, upstream && upstream.status);
            return;
        }
        const attemptGuard = createRawAttemptGuard(ac.signal, startupDeadlineAt);
        upstream = null;
        try {
            upstream = await fetch(claims.url, { method, headers, redirect: 'follow', signal: attemptGuard.signal, dispatcher: rawProxyAgent || undefined });
        } catch (err) {
            const hitDeadline = attemptGuard.deadlineExpired || rawStartupRemainingMs(startupDeadlineAt) <= 0;
            abandonRawAttempt(attemptGuard, null, 'raw_fetch_failed');
            if (ac.signal.aborted) { try { res.end(); } catch (_) {} return; }
            if (hitDeadline) { sendRawStartupTimeout(res); return; }
            const networkFailure = classifyProviderFetchFailure(err);
            if (networkFailure.code === 'PROXY_AUTH_FAILED') {
                rememberRawFailure(networkFailure.category);
                return res.status(502).json({
                    error: 'The media service is temporarily unavailable.',
                    code: networkFailure.code,
                    networkCause: networkFailure.category,
                });
            }
            if (providerRetryAttempts >= RAW_PROVIDER_RETRY_LIMIT || attempt >= maxAttempts) {
                rememberRawFailure(networkFailure.category);
                return res.status(502).json({
                    error: 'Unable to reach the media provider',
                    code: networkFailure.code,
                    networkCause: networkFailure.category,
                });
            }
            providerRetryAttempts += 1;
            rawStreamStats.providerRetries += 1;
            if (!await waitForRetry(attempt)) return;
            continue;
        }
        if (ac.signal.aborted) {
            abandonRawAttempt(attemptGuard, upstream.body, 'raw_client_aborted');
            try { res.end(); } catch (_) {}
            return;
        }
        if (attemptGuard.deadlineExpired || rawStartupRemainingMs(startupDeadlineAt) <= 0) {
            const status = upstream.status;
            abandonRawAttempt(attemptGuard, upstream.body, 'raw_startup_deadline');
            sendRawStartupTimeout(res, status);
            return;
        }
        if (upstream.status === 407 && providerProxyAgents.length) {
            const failure = classifyProviderResponseFailure(
                upstream.status,
                {},
                { proxyConfigured: true },
            );
            abandonRawAttempt(attemptGuard, upstream.body, 'proxy_auth_failed');
            rememberRawFailure('proxy_auth', upstream.status);
            return res.status(failure.status).json({
                error: failure.publicMessage,
                code: failure.code,
                networkCause: 'proxy_auth',
            });
        }
        if (
            !rawHandoffRetryUsed
            && abortedForHandoff > 0
            && (
                upstream.status === 458
                || classifyProviderResponseFailure(upstream.status, {}).code === 'PROVIDER_BUSY'
            )
        ) {
            rawHandoffRetryUsed = true;
            const waitMs = PROVIDER_SLOT_RELEASE_DELAY_MS || 2500;
            abandonRawAttempt(attemptGuard, upstream.body, 'raw_handoff_slot_busy');
            console.warn(`[media-gateway] /raw provider 458 after aborting ${abortedForHandoff} holder(s); waiting ${waitMs}ms for slot release before one handoff retry`);
            const outcome = await waitForRawBackoff(waitMs, startupDeadlineAt, ac.signal);
            if (outcome === 'aborted' || ac.signal.aborted) {
                try { res.end(); } catch (_) {}
                return;
            }
            continue;
        }
        const retryable = shouldRetryProviderStatus(upstream.status);
        if (retryable && providerRetryAttempts < RAW_PROVIDER_RETRY_LIMIT && attempt < maxAttempts) {
            providerRetryAttempts += 1;
            rawStreamStats.providerRetries += 1;
            const status = upstream.status;
            abandonRawAttempt(attemptGuard, upstream.body, 'raw_retryable_provider_status');
            console.warn(`[media-gateway] /raw provider transient ${status} (attempt ${attempt}/${maxAttempts}); retrying in ${RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000}ms`);
            if (!await waitForRetry(attempt, status)) return;
            continue;
        }
        // A single-slot panel refusing a connection often answers with an HTML/JSON
        // "busy"/ban page on HTTP 200 (2026-07-18 mobile VOD incident). Piped through,
        // those bytes reach the native player as an unparseable "container"
        // (ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) — a dead-end its recovery ladder
        // used to ignore, whereas a real HTTP error arms fallback/retry. Textual MIME
        // bodies and explicit provider-error signatures are suspected, while unknown
        // octet-stream/binary prefixes fail open because panels mislabel real media.
        // Junk retries like a 458: same slot-release window, same backoff.
        if (method === 'GET' && upstream.ok) {
            const contentType = String(upstream.headers.get('content-type') || '');
            const startsAtZero = rawResponseStartsAtZero(upstream);
            let probe = null;
            let noDataKind = null;
            if (isDeclaredEmptyRawResponse(upstream)) {
                noDataKind = 'empty_body';
            } else {
                const sniffTimeoutMs = Math.min(RAW_FIRST_BYTE_TIMEOUT_MS, rawStartupRemainingMs(startupDeadlineAt));
                if (sniffTimeoutMs <= 0) {
                    const status = upstream.status;
                    abandonRawAttempt(attemptGuard, upstream.body, 'raw_startup_deadline');
                    sendRawStartupTimeout(res, status);
                    return;
                }
                probe = await sniffLeadingBytes(
                    upstream.body,
                    attemptGuard.signal,
                    sniffTimeoutMs,
                    (prefix, complete) => classifyRawPrefix(prefix, contentType, startsAtZero, complete),
                );
                if (ac.signal.aborted) {
                    abandonRawAttempt(attemptGuard, probe.reader, 'raw_client_aborted');
                    try { res.end(); } catch (_) {}
                    return;
                }
                if (attemptGuard.deadlineExpired || rawStartupRemainingMs(startupDeadlineAt) <= 0) {
                    const status = upstream.status;
                    abandonRawAttempt(attemptGuard, probe.reader, 'raw_startup_deadline');
                    sendRawStartupTimeout(res, status);
                    return;
                }
                if (probe.error) noDataKind = 'first_byte_read_error';
                else if (probe.timedOut) noDataKind = 'first_byte_timeout';
                else if (probe.prefixTimedOut) noDataKind = 'prefix_timeout';
                else if (!probe.chunk.length) noDataKind = 'empty_body';
            }
            if (noDataKind) {
                noDataAttempts += 1;
                if (noDataKind === 'first_byte_timeout') rawStreamStats.firstByteTimeouts += 1;
                else if (noDataKind === 'prefix_timeout') rawStreamStats.prefixTimeouts += 1;
                else if (noDataKind === 'first_byte_read_error') rawStreamStats.firstByteReadErrors += 1;
                else rawStreamStats.emptyBodies += 1;
                rememberRawFailure(noDataKind, upstream.status);
                const status = upstream.status;
                abandonRawAttempt(attemptGuard, probe ? probe.reader : upstream.body, `raw_${noDataKind}`);
                if (noDataAttempts <= RAW_NO_DATA_RETRY_LIMIT && attempt < maxAttempts) {
                    rawStreamStats.providerRetries += 1;
                    console.warn(`[media-gateway] /raw provider sent no playable bytes (${noDataKind}, status ${status}, attempt ${noDataAttempts}/${1 + RAW_NO_DATA_RETRY_LIMIT}); retrying in ${RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000}ms`);
                    if (!await waitForRetry(attempt, status)) return;
                    continue;
                }
                return res.status(504).json({
                    error: 'Provider accepted the connection but sent no stream bytes',
                    code: 'PROVIDER_NO_DATA',
                    upstreamStatus: upstream.status,
                });
            }
            const nonMediaBody = probe.classification === 'non-media';
            if (!nonMediaBody) {
                sniffedBody = probe;
                activeAttemptGuard = attemptGuard;
                break;
            }
            rawStreamStats.nonMediaBodies += 1;
            rememberRawFailure('non_media_body', upstream.status);
            const status = upstream.status;
            abandonRawAttempt(attemptGuard, probe.reader, 'raw_non_media_body');
            if (providerRetryAttempts < RAW_PROVIDER_RETRY_LIMIT && attempt < maxAttempts) {
                providerRetryAttempts += 1;
                rawStreamStats.providerRetries += 1;
                console.warn(`[media-gateway] /raw provider sent a non-media body (status ${status}, attempt ${attempt}/${maxAttempts}); retrying in ${RAW_PROVIDER_RETRY_DELAYS_MS[attempt - 1] || 4000}ms`);
                if (!await waitForRetry(attempt, status)) return;
                continue;
            }
            console.warn(`[media-gateway] /raw provider kept sending a non-media body (status ${status}); refusing to pipe it as a stream`);
            return res.status(502).json({
                error: 'Provider returned a non-media body (busy/ban page) instead of stream bytes',
                code: 'PROVIDER_NON_MEDIA_BODY',
                upstreamStatus: status,
                contentType: contentType || null,
            });
        }
        activeAttemptGuard = attemptGuard;
        break;
    }
    if (ac.signal.aborted) { try { res.end(); } catch (_) {} return; }
    if (!upstream || !activeAttemptGuard || activeAttemptGuard.deadlineExpired || rawStartupRemainingMs(startupDeadlineAt) <= 0) {
        const status = upstream && upstream.status;
        const cancelable = sniffedBody ? sniffedBody.reader : upstream && upstream.body;
        if (activeAttemptGuard) abandonRawAttempt(activeAttemptGuard, cancelable, 'raw_startup_deadline');
        activeAttemptGuard = null;
        sendRawStartupTimeout(res, status);
        return;
    }
    activeAttemptGuard.completeStartup();

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=30');
    if (method === 'HEAD' || !upstream.body) {
        activeAttemptGuard.dispose();
        activeAttemptGuard = null;
        res.end();
        return;
    }
    const nodeStream = sniffedBody
        ? readableFromSniffedBody(sniffedBody)
        : require('stream').Readable.fromWeb(upstream.body);
    attachRawIdleWatchdog(nodeStream, res, ac);
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
    // Do not wait for the first body chunk to commit the response. In particular,
    // a final/non-retryable provider error may have useful HTTP status headers but
    // a body that never arrives; flushing lets the player react and disconnect now
    // instead of holding the provider slot until the post-start idle watchdog fires.
    res.flushHeaders();
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
        const operation = await reserveViewerSubtitleOperation(claims, res);
        if (!operation.ok) {
            if (operation.reason === 'client_closed' || res.destroyed) return;
            res.setHeader('Retry-After', operation.reason === 'rate_limited' ? '60' : '2');
            return res.status(429).json({ error: 'Subtitle service is busy' });
        }
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
        } finally {
            operation.release();
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
    const operation = await reserveViewerSubtitleOperation(claims, res);
    if (!operation.ok) {
        if (operation.reason === 'client_closed' || res.destroyed) return;
        res.setHeader('Retry-After', operation.reason === 'rate_limited' ? '60' : '2');
        return res.status(429).json({ error: 'Subtitle service is busy' });
    }

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
    try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(claims.url)) }); }
    catch (_) { operation.release(); return res.status(500).json({ error: 'Subtitle extraction failed' }); }
    const extractionRegistration = registerAccountExtraction(operation.proxyKey, child, true, false);
    const releaseOperation = () => {
        extractionRegistration.release?.();
        operation.release();
    };
    let stderr = '';
    let clientClosed = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30_000);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    res.on('close', () => { if (!res.writableEnded) { clientClosed = true; try { child.kill('SIGKILL'); } catch (_) {} } });
    child.on('error', () => { clearTimeout(timer); releaseOperation(); if (!res.headersSent) res.status(500).end(); });
    child.on('close', async (code) => {
        clearTimeout(timer);
        releaseOperation();
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
        if (accountSlotBusyLocally(url)) {
            return res.status(409).json({ error: 'Account busy (active playback)', code: 'account_busy' });
        }
        if (probeKey && accountExtractions.get(probeKey)?.size) {
            return res.status(429).json({ error: 'Account busy (background extraction)', code: 'background_busy' });
        }
        // Register the provider-connected ffprobe in the same preemption ledger
        // as LID/transcription. A viewer pressing Play can therefore kill this
        // short background probe immediately instead of waiting for its timeout.
        const profile = await probeCodecProfile(url, ua, { background: true });
        const audioTracks = Array.isArray(profile?.audioTracks) ? profile.audioTracks : [];
        const subtitles = Array.isArray(profile?.subtitles) ? profile.subtitles : [];
        const audioLanguages = [];
        let audioDefaultLanguage = null;
        for (const t of audioTracks) {
            if (t.language && !audioLanguages.includes(t.language)) audioLanguages.push(t.language);
            if (t.default && !audioDefaultLanguage) audioDefaultLanguage = t.language || null;
        }
        res.json({
            audioLanguages,
            audioTracks,
            audioDefaultLanguage,
            subtitles,
            codecProfile: publicMkvCodecProfile(profile),
        });
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({ error: err.publicMessage || 'Audio probe failed', code: err.code || undefined });
    }
});

// ── Strict LID loopback broker (mono-account provider barrier) ───────────────
// Strict multi-window language validation must seek through one finite file several times.
// Letting ffmpeg open the signed provider URL directly makes libav issue its own HEAD/range
// reconnects, which can overlap on a provider account that permits exactly one socket. This
// private loopback broker is the only provider-facing reader for the strict lane:
//
//   ffmpeg -> random http://127.0.0.1 handle -> one exact provider byte range
//
// HEAD is answered entirely locally. GETs are serialized, the prior body is synchronously
// aborted/cancelled, and the provider-slot release delay elapses before a successor opens.
// The random handle never leaves this process (not in the route response or logs).
function normalizeStrictLidFileSize(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseStrictLidRange(value, fileSizeBytes) {
    const size = normalizeStrictLidFileSize(fileSizeBytes);
    const text = String(value || '').trim();
    if (!size || !text || text.includes(',')) return null;
    const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
    if (!match || (!match[1] && !match[2])) return null;
    const parseOffset = (raw) => {
        if (!/^\d+$/.test(String(raw || ''))) return null;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    if (!match[1]) {
        const suffixLength = parseOffset(match[2]);
        if (!suffixLength) return null;
        return {
            start: Math.max(0, size - suffixLength),
            end: size - 1,
            total: size,
        };
    }
    const start = parseOffset(match[1]);
    if (start === null || start >= size) return null;
    const requestedEnd = match[2] ? parseOffset(match[2]) : size - 1;
    if (requestedEnd === null || requestedEnd < start) return null;
    return { start, end: Math.min(requestedEnd, size - 1), total: size };
}

function strictLidContentRange(response, expectedRange) {
    if (Number(response?.status) !== 206 || !expectedRange) return null;
    const raw = String(response?.headers?.get?.('content-range') || '').trim();
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(raw);
    if (!match) return null;
    const [start, end, total] = match.slice(1).map((part) => Number(part));
    if (
        ![start, end, total].every(Number.isSafeInteger)
        || start !== expectedRange.start
        || end !== expectedRange.end
        || total !== expectedRange.total
    ) return null;
    const expectedLength = end - start + 1;
    const declaredLength = String(response?.headers?.get?.('content-length') || '').trim();
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedLength) return null;
    return { start, end, total, length: expectedLength };
}

function strictLidResponseValidator(response) {
    const etag = String(response?.headers?.get?.('etag') || '').trim();
    if (etag && !/^W\//i.test(etag)) return { header: 'If-Range', value: etag, kind: 'etag' };
    const lastModified = String(response?.headers?.get?.('last-modified') || '').trim();
    if (lastModified && Number.isFinite(Date.parse(lastModified))) {
        return { header: 'If-Range', value: lastModified, kind: 'last-modified' };
    }
    return null;
}

function normalizeStrictLidExpectedValidator(value) {
    if (!value || typeof value !== 'object') return null;
    const header = String(value.header || '');
    const kind = String(value.kind || '');
    const validatorValue = String(value.value || '').trim();
    if (
        header !== 'If-Range' ||
        !['etag', 'last-modified'].includes(kind) ||
        !validatorValue || validatorValue.length > 512
    ) return null;
    if (kind === 'etag' && (/^W\//i.test(validatorValue) || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(validatorValue))) {
        return null;
    }
    if (kind === 'last-modified' && !Number.isFinite(Date.parse(validatorValue))) return null;
    return { header, value: validatorValue, kind };
}

function strictLidEffectiveUrlSha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function strictLidEffectiveUrlIdentitySha256(value) {
    try {
        const parsed = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        // Provider CDNs commonly rotate signed query values between two exact
        // byte-range requests. Keep host, path and the query *shape* pinned,
        // while excluding credentials and volatile signature values.
        const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
        const identity = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
            + (queryKeys.length ? `?${queryKeys.join('&')}` : '');
        return crypto.createHash('sha256').update(identity).digest('hex');
    } catch (_) {
        return null;
    }
}

function strictLidBrokerError(code, message, options = {}) {
    const error = new Error(message);
    error.code = code;
    error.status = Number.isInteger(options.status) ? options.status : 502;
    error.upstreamStatus = Number.isInteger(options.upstreamStatus) ? options.upstreamStatus : null;
    return error;
}

// WHATWG fetch intentionally rejects a 407 before exposing its status. The lower-level
// undici request API preserves that status, which is required to distinguish residential
// proxy authentication failure from a provider's mono-account 458 response.
function strictLidNodeBodyAdapter(nodeBody) {
    let locked = false;
    const awaitDestroyed = () => {
        if (!nodeBody || nodeBody.destroyed || nodeBody.readableEnded) return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                nodeBody.off('close', finish);
                nodeBody.off('end', finish);
                nodeBody.off('error', finish);
                resolve();
            };
            nodeBody.once('close', finish);
            nodeBody.once('end', finish);
            nodeBody.once('error', finish);
            try { nodeBody.destroy(); } catch (_) { finish(); }
            if (nodeBody.destroyed || nodeBody.readableEnded) finish();
        });
    };
    return {
        get locked() { return locked; },
        getReader() {
            if (locked) throw new Error('Strict LID provider body is already locked');
            locked = true;
            const iterator = nodeBody[Symbol.asyncIterator]();
            let cancelled = false;
            return {
                async read() {
                    if (cancelled) return { value: undefined, done: true };
                    const next = await iterator.next();
                    return {
                        value: next.value === undefined ? undefined : Buffer.from(next.value),
                        done: next.done === true,
                    };
                },
                async cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    try { await iterator.return?.(); } catch (_) {}
                    await awaitDestroyed();
                },
                releaseLock() { locked = false; },
            };
        },
        async cancel() {
            if (locked) return;
            await awaitDestroyed();
        },
    };
}

async function strictLidProviderRequest(sourceUrl, options = {}) {
    const response = await undiciRequest(sourceUrl, {
        method: options.method || 'GET',
        headers: options.headers || {},
        maxRedirections: 5,
        signal: options.signal,
        dispatcher: options.dispatcher || undefined,
        throwOnError: false,
    });
    const rawHeaders = response.headers || {};
    const redirectHistory = Array.isArray(response.context?.history)
        ? response.context.history
        : [];
    const effectiveUrl = String(redirectHistory.at(-1)?.href || sourceUrl);
    const headers = {
        get(name) {
            const value = rawHeaders[String(name || '').toLowerCase()];
            if (Array.isArray(value)) return value.join(', ');
            return value === undefined || value === null ? null : String(value);
        },
    };
    return {
        status: Number(response.statusCode),
        url: effectiveUrl,
        headers,
        body: response.body ? strictLidNodeBodyAdapter(response.body) : null,
    };
}

function markStrictLidTerminal(context, error) {
    if (!context.terminalError && error) context.terminalError = error;
    return context.terminalError;
}

function strictLidLooksTextual(buffer) {
    if (!buffer?.length) return false;
    let controls = 0;
    for (const byte of buffer.subarray(0, 512)) {
        if (byte === 0) return false;
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) controls++;
    }
    return controls <= 2;
}

async function strictLidResponseHasBusyPrefix(response, signal = null, onProgress = null) {
    if (!response?.body || typeof response.body.getReader !== 'function') return false;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const aborted = (fallback = null) => (
        signal?.reason instanceof Error
            ? signal.reason
            : (fallback instanceof Error ? fallback : new Error('strict LID provider read stopped'))
    );
    try {
        while (total < 4096) {
            if (signal?.aborted) throw aborted();
            const { value, done } = await reader.read();
            if (value?.length) {
                onProgress?.();
                const part = Buffer.from(value).subarray(0, 4096 - total);
                chunks.push(part);
                total += part.length;
                const prefix = Buffer.concat(chunks, total);
                if (!strictLidLooksTextual(prefix)) return false;
                if (/\b(?:user_multi_ip|maximum?\s+connections?|max[_ -]?connections?|too\s+many\s+connections?|provider[_ -]+busy)\b/i.test(prefix.toString('utf8'))) {
                    return true;
                }
            }
            if (done) break;
        }
        return false;
    } catch (error) {
        if (signal?.aborted) throw aborted(error);
        return false;
    } finally {
        try { await reader.cancel(); } catch (_) {}
        try { reader.releaseLock(); } catch (_) {}
    }
}

function sendStrictLidBrokerError(res, error) {
    if (!res || res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
        return;
    }
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const body = Buffer.from(JSON.stringify({
        error: String(error?.message || 'Strict language media broker failed'),
        code: String(error?.code || 'STRICT_LID_BROKER_FAILED'),
        ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    }));
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
}

function waitForStrictLidBrokerSlot(context) {
    const remaining = Math.max(0, Number(context.nextOpenAt || 0) - Date.now());
    if (!remaining) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (error) => {
            if (timer) clearTimeout(timer);
            context.controller.signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
        };
        const onAbort = () => finish(strictLidBrokerError('STRICT_LID_ABORTED', 'Strict language media broker stopped', { status: 499 }));
        context.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (context.controller.signal.aborted) return onAbort();
        timer = setTimeout(() => finish(), remaining);
        timer.unref?.();
    });
}

function waitForStrictLidDrain(res, signal) {
    if (signal?.aborted || res.destroyed) return Promise.reject(new Error('local reader closed'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            res.off('drain', onDrain);
            res.off('close', onClose);
            res.off('error', onError);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const onDrain = () => finish();
        const onClose = () => finish(new Error('local reader closed'));
        const onError = (error) => finish(error || new Error('local reader failed'));
        const onAbort = () => finish(new Error('provider read stopped'));
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted || res.destroyed) onAbort();
    });
}

function createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs,
    idleTimeoutMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    let timer = null;
    let closed = false;
    let timedOut = false;
    let timeoutKind = null;
    const clear = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
    const expire = (kind) => {
        if (closed || timedOut) return;
        timedOut = true;
        timeoutKind = kind;
        clear();
        try { controller.abort(new Error(`strict LID provider ${kind} timeout`)); } catch (_) {}
    };
    const arm = (kind, timeoutMs) => {
        if (closed || timedOut) return;
        clear();
        timer = setTimer(() => expire(kind), Math.max(1, Number(timeoutMs) || 1));
        timer?.unref?.();
    };
    arm('first-byte', firstByteTimeoutMs);
    return {
        progress() { arm('idle', idleTimeoutMs); },
        close() {
            if (closed) return;
            closed = true;
            clear();
        },
        get timedOut() { return timedOut; },
        get timeoutKind() { return timeoutKind; },
    };
}

async function closeStrictLidBrokerAttempt(context, attempt, reason = 'completed') {
    if (!attempt) return;
    if (!attempt.closePromise) {
        attempt.closePromise = (async () => {
            attempt.stopReason = reason;
            attempt.deadline?.close?.();
            attempt.signalParent?.removeEventListener?.('abort', attempt.onParentAbort);
            try { attempt.controller.abort(new Error(reason)); } catch (_) {}
            if (attempt.reader) {
                try { await attempt.reader.cancel(); } catch (_) {}
                try { attempt.reader.releaseLock(); } catch (_) {}
            } else if (attempt.response?.body && !attempt.response.body.locked) {
                try { await attempt.response.body.cancel(); } catch (_) {}
            }
            if (reason !== 'completed' && attempt.localResponse && !attempt.localResponse.writableEnded) {
                try { attempt.localResponse.destroy(); } catch (_) {}
            }
            if (context.activeAttempt === attempt) context.activeAttempt = null;
            if (attempt.fetchStarted) {
                const releaseDelayMs = attempt.completedExactRange === true
                    ? context.completedReleaseDelayMs
                    : (attempt.stopReason === 'superseded'
                        ? context.supersededReleaseDelayMs
                        : context.releaseDelayMs);
                if (attempt.completedExactRange === true) context.completedProviderFetches++;
                else context.interruptedProviderFetches++;
                if (releaseDelayMs > 0) {
                    context.nextOpenAt = Math.max(
                        Number(context.nextOpenAt || 0),
                        Date.now() + releaseDelayMs,
                    );
                }
            }
        })();
    }
    await attempt.closePromise;
}

async function serveStrictLidBrokerRange(context, req, res, range, requestId) {
    if (context.closed || requestId !== context.latestRequestId) {
        return sendStrictLidBrokerError(res, strictLidBrokerError('STRICT_LID_SUPERSEDED', 'Strict language media request was superseded', { status: 409 }));
    }
    if (context.terminalError) return sendStrictLidBrokerError(res, context.terminalError);
    await waitForStrictLidBrokerSlot(context);
    if (context.closed || requestId !== context.latestRequestId) {
        return sendStrictLidBrokerError(res, strictLidBrokerError('STRICT_LID_SUPERSEDED', 'Strict language media request was superseded', { status: 409 }));
    }

    const controller = new AbortController();
    const attempt = {
        controller,
        response: null,
        reader: null,
        localResponse: res,
        signalParent: context.controller.signal,
        onParentAbort: null,
        deadline: null,
        fetchStarted: false,
        localClosed: false,
        closePromise: null,
        stopReason: null,
        completedExactRange: false,
    };
    attempt.onParentAbort = () => {
        try { controller.abort(context.controller.signal.reason); } catch (_) {}
    };
    context.controller.signal.addEventListener('abort', attempt.onParentAbort, { once: true });
    if (context.controller.signal.aborted) attempt.onParentAbort();
    const onLocalClose = () => {
        if (!res.writableEnded) {
            attempt.localClosed = true;
            try { controller.abort(new Error('local reader closed')); } catch (_) {}
        }
    };
    res.once('close', onLocalClose);
    context.activeAttempt = attempt;
    attempt.deadline = createStrictLidRangeDeadline({
        controller,
        firstByteTimeoutMs: context.firstByteTimeoutMs,
        idleTimeoutMs: context.idleTimeoutMs,
        setTimer: context.setTimer,
        clearTimer: context.clearTimer,
    });

    try {
        const headers = {
            Range: `bytes=${range.start}-${range.end}`,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'User-Agent': context.userAgent,
            Connection: 'close',
        };
        if (context.validator) headers[context.validator.header] = context.validator.value;
        attempt.fetchStarted = true;
        context.providerFetches++;
        attempt.response = await context.fetchImpl(context.sourceUrl, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: controller.signal,
            dispatcher: context.dispatcher || undefined,
        });
        const upstreamStatus = Number(attempt.response.status);
        if (upstreamStatus === 458) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'PROVIDER_BUSY',
                'This TV service is busy. Wait a few seconds, then try again.',
                { status: 458, upstreamStatus },
            ));
        }
        if (upstreamStatus === 407) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'PROXY_AUTH_FAILED',
                'The media service is temporarily unavailable.',
                { status: 502, upstreamStatus },
            ));
        }
        const observedEffectiveUrlSha256 = strictLidEffectiveUrlSha256(
            attempt.response?.url || context.sourceUrl,
        );
        if (upstreamStatus === 200) {
            const busy = await strictLidResponseHasBusyPrefix(
                attempt.response,
                controller.signal,
                () => attempt.deadline.progress(),
            );
            if (busy) {
                throw markStrictLidTerminal(context, strictLidBrokerError(
                    'PROVIDER_BUSY',
                    'This TV service is busy. Wait a few seconds, then try again.',
                    { status: 458, upstreamStatus },
                ));
            }
            if (controller.signal.aborted) {
                throw controller.signal.reason || new Error('strict LID provider read stopped');
            }
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'RANGE_UNSUPPORTED',
                'Provider ignored the exact language-validation byte range.',
                { status: 502, upstreamStatus },
            ));
        }
        if (upstreamStatus !== 206) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'PROVIDER_REQUEST_FAILED',
                'Provider rejected the language-validation byte range.',
                { status: 502, upstreamStatus },
            ));
        }
        const contentEncoding = String(attempt.response.headers?.get?.('content-encoding') || '').trim().toLowerCase();
        if (contentEncoding && contentEncoding !== 'identity') {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'RANGE_UNSUPPORTED',
                'Provider encoded the language-validation byte range.',
                { status: 502, upstreamStatus },
            ));
        }
        const exactRange = strictLidContentRange(attempt.response, range);
        if (!exactRange) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'RANGE_UNSUPPORTED',
                'Provider returned an invalid language-validation byte range.',
                { status: 502, upstreamStatus },
            ));
        }
        const observedValidator = strictLidResponseValidator(attempt.response);
        if (
            context.validator
            && (
                !observedValidator
                || observedValidator.kind !== context.validator.kind
                || observedValidator.value !== context.validator.value
            )
        ) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'VOD_CHANGED',
                'The media file changed during language validation.',
                { status: 502, upstreamStatus },
            ));
        }
        if (!context.validator && observedValidator) context.validator = observedValidator;
        const observedEffectiveUrlIdentitySha256 = strictLidEffectiveUrlIdentitySha256(
            attempt.response?.url || context.sourceUrl,
        );
        if (
            context.effectiveUrlSha256
            && observedEffectiveUrlSha256 !== context.effectiveUrlSha256
            && !(
                context.pathPrefix === 'finite-mkv-seek'
                && context.effectiveUrlIdentitySha256
                && observedEffectiveUrlIdentitySha256 === context.effectiveUrlIdentitySha256
            )
        ) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'VOD_CHANGED',
                'The media provider target changed during the byte-range session.',
                { status: 502, upstreamStatus },
            ));
        }
        if (!context.effectiveUrlSha256) context.effectiveUrlSha256 = observedEffectiveUrlSha256;
        if (!context.effectiveUrlIdentitySha256) {
            context.effectiveUrlIdentitySha256 = observedEffectiveUrlIdentitySha256;
        }
        if (!attempt.response.body || typeof attempt.response.body.getReader !== 'function') {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'PROVIDER_EMPTY_RESPONSE',
                'Provider returned no language-validation media body.',
                { status: 502, upstreamStatus },
            ));
        }
        attempt.reader = attempt.response.body.getReader();
        res.statusCode = 206;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${range.total}`);
        res.setHeader('Content-Length', String(exactRange.length));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (observedValidator?.kind === 'etag') res.setHeader('ETag', observedValidator.value);
        if (observedValidator?.kind === 'last-modified') res.setHeader('Last-Modified', observedValidator.value);

        let forwarded = 0;
        while (!controller.signal.aborted) {
            const { value, done } = await attempt.reader.read();
            if (done) break;
            const chunk = Buffer.from(value || []);
            if (!chunk.length) continue;
            attempt.deadline.progress();
            if (forwarded + chunk.length > exactRange.length) {
                throw markStrictLidTerminal(context, strictLidBrokerError(
                    'RANGE_LENGTH_MISMATCH',
                    'Provider exceeded the exact language-validation byte range.',
                    { status: 502, upstreamStatus },
                ));
            }
            forwarded += chunk.length;
            if (!res.write(chunk)) await waitForStrictLidDrain(res, controller.signal);
        }
        if (controller.signal.aborted) throw controller.signal.reason || new Error('strict LID provider read stopped');
        if (forwarded !== exactRange.length) {
            throw markStrictLidTerminal(context, strictLidBrokerError(
                'RANGE_LENGTH_MISMATCH',
                'Provider truncated the exact language-validation byte range.',
                { status: 502, upstreamStatus },
            ));
        }
        // The provider body has been consumed to the exact terminal byte. Its
        // account slot is drained, so finite-MKV seek may safely open the next
        // serialized demux range without the abort-only grace delay.
        attempt.completedExactRange = true;
        res.end();
    } catch (error) {
        const intentionallyStopped = context.closed
            || attempt.localClosed
            || attempt.stopReason === 'superseded'
            || attempt.stopReason === 'broker_closed';
        if (!intentionallyStopped) {
            let publicError = context.terminalError;
            if (!publicError && isProxyAuthenticationFailure(error)) {
                publicError = markStrictLidTerminal(context, strictLidBrokerError(
                    'PROXY_AUTH_FAILED',
                    'The media service is temporarily unavailable.',
                    { status: 502, upstreamStatus: 407 },
                ));
            }
            if (!publicError && attempt.deadline?.timeoutKind === 'first-byte') {
                publicError = markStrictLidTerminal(context, strictLidBrokerError(
                    'PROVIDER_FIRST_BYTE_TIMEOUT',
                    'Provider did not start the language-validation byte range in time.',
                    { status: 504 },
                ));
            }
            if (!publicError && attempt.deadline?.timeoutKind === 'idle') {
                publicError = markStrictLidTerminal(context, strictLidBrokerError(
                    'PROVIDER_IDLE_TIMEOUT',
                    'Provider stopped the language-validation byte range.',
                    { status: 504 },
                ));
            }
            if (!publicError) {
                publicError = markStrictLidTerminal(context, strictLidBrokerError(
                    'PROVIDER_FETCH_FAILED',
                    'Provider media request failed during language validation.',
                    { status: 502 },
                ));
            }
            sendStrictLidBrokerError(res, publicError);
        }
    } finally {
        res.off('close', onLocalClose);
        await closeStrictLidBrokerAttempt(context, attempt, 'completed');
    }
}

function handleStrictLidBrokerRequest(context, expectedPath, req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch (_) { pathname = ''; }
    if (pathname !== expectedPath) {
        res.statusCode = 404;
        return res.end();
    }
    if (context.closed) {
        return sendStrictLidBrokerError(res, strictLidBrokerError('STRICT_LID_ABORTED', 'Strict language media broker stopped', { status: 503 }));
    }
    if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(context.fileSizeBytes));
        return res.end();
    }
    if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'HEAD, GET');
        return res.end();
    }
    const range = parseStrictLidRange(req.headers.range, context.fileSizeBytes);
    if (!range) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${context.fileSizeBytes}`);
        return res.end();
    }

    const requestId = ++context.latestRequestId;
    const active = context.activeAttempt;
    if (active) void closeStrictLidBrokerAttempt(context, active, 'superseded').catch(() => {});
    const work = context.queue
        .catch(() => {})
        .then(() => serveStrictLidBrokerRange(context, req, res, range, requestId));
    context.queue = work.catch((error) => {
        if (!context.closed) sendStrictLidBrokerError(res, error);
    });
}

async function createStrictLidBroker(options = {}) {
    const sourceUrl = String(options.sourceUrl || '');
    const fileSizeBytes = normalizeStrictLidFileSize(options.fileSizeBytes);
    if (!isHttpUrl(sourceUrl)) throw strictLidBrokerError('INVALID_SOURCE', 'Strict language media source is invalid', { status: 400 });
    if (!fileSizeBytes) throw strictLidBrokerError('EXACT_FILE_SIZE_REQUIRED', 'Exact media file size is required', { status: 400 });
    const handle = crypto.randomBytes(32).toString('base64url');
    const pathPrefix = options.pathPrefix === 'finite-mkv-seek' ? 'finite-mkv-seek' : 'strict-lid';
    const expectedPath = `/${pathPrefix}/${handle}`;
    const expectedValidator = normalizeStrictLidExpectedValidator(options.expectedValidator);
    const expectedEffectiveUrlSha256 = /^[a-f0-9]{64}$/.test(String(options.effectiveUrlSha256 || '').toLowerCase())
        ? String(options.effectiveUrlSha256).toLowerCase()
        : null;
    const expectedEffectiveUrlIdentitySha256 = /^[a-f0-9]{64}$/.test(String(options.effectiveUrlIdentitySha256 || '').toLowerCase())
        ? String(options.effectiveUrlIdentitySha256).toLowerCase()
        : null;
    const controller = new AbortController();
    const context = {
        sourceUrl,
        fileSizeBytes,
        userAgent: String(options.userAgent || FFMPEG_USER_AGENT),
        dispatcher: Object.prototype.hasOwnProperty.call(options, 'dispatcher')
            ? options.dispatcher
            : (pickProxyAgent(proxyKeyFromUrl(sourceUrl)) || null),
        fetchImpl: options.fetchImpl || strictLidProviderRequest,
        releaseDelayMs: Number.isFinite(Number(options.releaseDelayMs))
            ? Math.max(0, Number(options.releaseDelayMs))
            : PROVIDER_SLOT_RELEASE_DELAY_MS,
        completedReleaseDelayMs: Number.isFinite(Number(options.completedReleaseDelayMs))
            ? Math.max(0, Number(options.completedReleaseDelayMs))
            : (Number.isFinite(Number(options.releaseDelayMs))
                ? Math.max(0, Number(options.releaseDelayMs))
                : PROVIDER_SLOT_RELEASE_DELAY_MS),
        supersededReleaseDelayMs: Number.isFinite(Number(options.supersededReleaseDelayMs))
            ? Math.max(0, Number(options.supersededReleaseDelayMs))
            : (Number.isFinite(Number(options.releaseDelayMs))
                ? Math.max(0, Number(options.releaseDelayMs))
                : PROVIDER_SLOT_RELEASE_DELAY_MS),
        // `openTimeoutMs` remains a test/backward-compatibility alias for callers that predate
        // protocol 2. Production uses the explicit first-byte and inactivity deadlines.
        firstByteTimeoutMs: Number.isFinite(Number(options.firstByteTimeoutMs))
            ? Math.max(100, Number(options.firstByteTimeoutMs))
            : (Number.isFinite(Number(options.openTimeoutMs))
                ? Math.max(100, Number(options.openTimeoutMs))
                : STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS),
        idleTimeoutMs: Number.isFinite(Number(options.idleTimeoutMs))
            ? Math.max(100, Number(options.idleTimeoutMs))
            : STRICT_LID_BROKER_IDLE_TIMEOUT_MS,
        setTimer: typeof options.setTimer === 'function' ? options.setTimer : setTimeout,
        clearTimer: typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout,
        controller,
        activeAttempt: null,
        queue: Promise.resolve(),
        nextOpenAt: 0,
        latestRequestId: 0,
        validator: expectedValidator,
        pathPrefix,
        effectiveUrlSha256: expectedEffectiveUrlSha256,
        effectiveUrlIdentitySha256: expectedEffectiveUrlIdentitySha256,
        terminalError: null,
        providerFetches: 0,
        completedProviderFetches: 0,
        interruptedProviderFetches: 0,
        closed: false,
    };
    const server = http.createServer((req, res) => {
        handleStrictLidBrokerRequest(context, expectedPath, req, res);
    });
    server.on('clientError', (_error, socket) => {
        try { socket.destroy(); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
    });
    server.unref?.();
    const address = server.address();
    let closePromise = null;
    const broker = {
        inputUrl: `http://127.0.0.1:${address.port}${expectedPath}`,
        get terminalError() { return context.terminalError; },
        get providerFetches() { return context.providerFetches; },
        get completedProviderFetches() { return context.completedProviderFetches; },
        get interruptedProviderFetches() { return context.interruptedProviderFetches; },
        async close() {
            if (closePromise) return closePromise;
            closePromise = (async () => {
                context.closed = true;
                context.latestRequestId++;
                try { controller.abort(new Error('strict LID broker closed')); } catch (_) {}
                await closeStrictLidBrokerAttempt(context, context.activeAttempt, 'broker_closed');
                try { await context.queue; } catch (_) {}
                // `closeStrictLidBrokerAttempt` records the provider panel's
                // logical slot-release deadline. Do not attest a drained
                // provider until both the socket and that grace period have
                // completed; otherwise Edge may hand the mono-account lease
                // to playback while the panel still counts the old request.
                const releaseDelayRemaining = Math.max(
                    0,
                    Number(context.nextOpenAt || 0) - Date.now(),
                );
                if (releaseDelayRemaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, releaseDelayRemaining));
                }
                const closed = new Promise((resolve) => {
                    try { server.close(() => resolve()); } catch (_) { resolve(); }
                });
                try { server.closeAllConnections?.(); } catch (_) {}
                await closed;
                options.abortSignal?.removeEventListener?.('abort', onAbort);
            })();
            return closePromise;
        },
    };
    const onAbort = () => { void broker.close(); };
    options.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();
    return broker;
}
// ── End strict LID loopback broker ───────────────────────────────────────────

// Phase 2: detect the language of ONE audio track, fully self-hosted (no paid API). ffmpeg
// extracts a short mono/16 kHz WAV of the track, whisper.cpp identifies the spoken language,
// and a transcript-based detector resolves script-family ambiguities (Persian/Kurdish/Urdu vs
// Arabic, Ukrainian/Serbian vs Russian). Same byte-pipe token as /raw. Used only for untagged
// tracks and cached upstream, so this 2nd provider connection runs at most once per file.
function validateDetectLanguageCapability(capabilityToken, requiredScope = null) {
    const claims = verifyRawToken(capabilityToken, GATEWAY_TOKEN);
    if (!claims) return { claims: null, status: 401, error: 'Invalid byte-pipe token' };
    if (Number(claims.exp) * 1000 < Date.now()) {
        return { claims: null, status: 401, error: 'Byte-pipe token expired' };
    }
    const scope = String(claims.scope || '');
    if (requiredScope && scope !== requiredScope) {
        return {
            claims: null,
            status: 403,
            error: 'Byte-pipe token is not authorized for this language route',
        };
    }
    if (!LID_ROUTE_SCOPES.has(scope)) {
        return {
            claims: null,
            status: 403,
            error: 'Byte-pipe token is not authorized for language detection',
        };
    }
    return { claims, status: 200, error: null };
}

function detectLanguageRequestPolicy(req, options = {}) {
    const strict = ['1', 'true', 'yes'].includes(String(req?.query?.strict || '').toLowerCase());
    return {
        strict,
        // The service-only header route always supplies the exact required
        // scope. The legacy path independently receives the same requirement
        // for every strict request, closing any raw-token scope downgrade.
        requiredScope: options.requiredScope || (strict ? LID_LEGACY_FULL_SCOPE : null),
    };
}

async function handleDetectLanguageRequest(req, res, capabilityToken, options = {}) {
    const policy = detectLanguageRequestPolicy(req, options);
    const validation = validateDetectLanguageCapability(capabilityToken, policy.requiredScope);
    if (!validation.claims) {
        return res.status(validation.status).json({ error: validation.error });
    }
    const claims = validation.claims;
    const strict = policy.strict;
    const hasStrictWindowMarker = Object.prototype.hasOwnProperty.call(
        claims,
        'windowCheckpointProtocol',
    );
    const strictWindowRequested = strict
        && claims.windowCheckpointProtocol === STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL;
    if (
        hasStrictWindowMarker
        && (!strict || claims.windowCheckpointProtocol !== STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL)
    ) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({
            error: 'Strict language window claims are invalid',
            code: 'strict_lid_window_claims_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const strictRequestStartedAt = strict ? Date.now() : 0;
    const strictRequestDeadlineAt = strict
        ? strictRequestStartedAt + STRICT_LID_REQUEST_BUDGET_MS
        : 0;
    const strictWorkDeadlineAt = strict
        ? strictRequestDeadlineAt - STRICT_LID_DRAIN_RESPONSE_RESERVE_MS
        : 0;
    const strictFileSizeBytes = strict ? normalizeStrictLidFileSize(claims.fileSizeBytes) : null;
    if (strict && !strictFileSizeBytes) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({
            error: 'Strict language validation requires an exact signed file size',
            code: 'exact_file_size_required',
        });
    }
    const strictDurationSeconds = strict
        ? normalizeStrictLidTimelineDurationSeconds(claims.durationSeconds)
        : null;
    if (strict && strictDurationSeconds === null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({
            error: 'Strict language validation requires an exact signed duration',
            code: 'exact_duration_required',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    if (!WHISPER_BIN || !WHISPER_MODEL) return res.status(503).json({ error: 'Language detection not configured' });
    if (rejectWhileLidBenchmarkRuns(res)) return;
    const ua = claims.ua || FFMPEG_USER_AGENT;

    const trackIndex = Number.parseInt(req.query.index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).json({ error: 'Invalid audio index' });
    if (
        strictWindowRequested
        && !/^(?:0|[1-9][0-9]{0,3})$/.test(String(req.query.index ?? ''))
    ) {
        return res.status(400).json({
            error: 'Strict language window claims are invalid',
            code: 'strict_lid_window_claims_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const detectOnlyMode = !strict && WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE
        ? (
            claims.scope === LID_DETECT_ONLY_SCOPE
                ? 'primary'
                : (claims.scope === LID_SHADOW_SCOPE ? 'shadow' : 'off')
        )
        : 'off';
    const dur = strict
        ? STRICT_LID_SAMPLE_DURATION_CAP_SECONDS
        : strictLidSampleDurationSeconds(req.query.dur, false);
    const strictTimelineOffsets = strict
        ? strictLidTimelineOffsets(strictDurationSeconds, dur)
        : null;
    if (strict && !strictTimelineOffsets) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(422).json({
            error: 'Strict language validation requires four complete audio windows',
            code: 'strict_lid_duration_too_short',
            retryable: false,
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    // An explicit ?start pins a single offset (caller knows where speech is); otherwise sweep the
    // bounded mid-film offsets and stop at the first clip that actually contains speech.
    const explicitStart = Number.parseFloat(req.query.start);
    if (strict && Number.isFinite(explicitStart)) {
        return res.status(400).json({ error: 'Strict language validation requires separated samples' });
    }
    const strictWindowContext = strictWindowRequested
        ? strictLidWindowClaimContext(claims, trackIndex)
        : null;
    if (strictWindowRequested && !strictWindowContext) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({
            error: 'Strict language window claims are invalid',
            code: 'strict_lid_window_claims_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const offsets = (Number.isFinite(explicitStart) && explicitStart >= 0)
        ? [explicitStart]
        : (strict
            ? (strictWindowContext
                ? [strictWindowContext.offsets[strictWindowContext.windowOrdinal - 1]]
                : strictTimelineOffsets)
            : WHISPER_SWEEP_OFFSETS);
    const consensusNeeded = strict
        ? WHISPER_STRICT_CONSENSUS
        : Math.max(1, Math.min(3, Number.parseInt(req.query.consensus, 10) || 1));
    if (strict && !strictWindowContext && offsets.length < consensusNeeded) {
        return res.status(503).json({ error: 'Strict language validation needs at least four configured offsets' });
    }

    const requestController = new AbortController();
    let strictWorkBudgetExpired = false;
    let strictWorkBudgetTimer = null;
    const expireStrictWorkBudget = () => {
        if (!strict || strictWorkBudgetExpired) return;
        strictWorkBudgetExpired = true;
        try { requestController.abort(new Error('strict language request budget exhausted')); } catch (_) {}
    };
    if (strict) {
        strictWorkBudgetTimer = setTimeout(
            expireStrictWorkBudget,
            Math.max(1, strictWorkDeadlineAt - Date.now()),
        );
        strictWorkBudgetTimer.unref?.();
    }
    const onRequestClose = () => {
        if (!res.writableEnded) {
            try { requestController.abort(new Error('language validation caller closed')); } catch (_) {}
        }
    };
    res.once('close', onRequestClose);
    let strictBroker = null;
    let strictBrokerDrained = false;
    const strictWavSamples = [];
    const closeStrictBrokerForResponse = async () => {
        if (!strict || strictBrokerDrained) return;
        if (strictWorkBudgetTimer !== null) {
            clearTimeout(strictWorkBudgetTimer);
            strictWorkBudgetTimer = null;
        }
        if (strictBroker) {
            const remainingMs = Math.max(0, strictRequestDeadlineAt - Date.now());
            if (!remainingMs) throw new Error('strict language provider drain exceeded request budget');
            let drainTimer = null;
            try {
                await Promise.race([
                    strictBroker.close(),
                    new Promise((_, reject) => {
                        drainTimer = setTimeout(
                            () => reject(new Error('strict language provider drain exceeded request budget')),
                            remainingMs,
                        );
                        drainTimer.unref?.();
                    }),
                ]);
            } finally {
                if (drainTimer !== null) clearTimeout(drainTimer);
            }
        }
        // A missing broker means validation failed before any provider I/O;
        // that state is also safe to hand off. Once a broker existed, close()
        // above is the sole authority for socket + release-grace completion.
        strictBrokerDrained = true;
    };
    const sendDetectionJson = async (status, payload) => {
        await closeStrictBrokerForResponse();
        if (res.writableEnded || res.destroyed) return;
        const responsePayload = strict
            ? {
                ...payload,
                providerDrained: true,
                providerDrainProtocol: 1,
            }
            : payload;
        return res.status(status).json(responsePayload);
    };
    try {
        if (strict) {
            strictBroker = await createStrictLidBroker({
                sourceUrl: claims.url,
                fileSizeBytes: strictFileSizeBytes,
                userAgent: ua,
                abortSignal: requestController.signal,
            });
        }
        let best = null;          // best partial result across offsets (most words), as a fallback
        let extractions = 0;      // bound the provider connections
        let lastExtractErr = '';  // surfaced when EVERY offset failed (was an opaque constant string)
        const votes = new Map();
        const strictSamples = [];
        let bestStrictAccepted = null;
        let strictRejectedSpeechSamples = 0;
        let strictIgnoredWeakSpeechSamples = 0;
        let strictRepeatedSpeechSamples = 0;
        let strictMissingDiversitySamples = 0;
        let strictInsufficientSpeechSamples = 0;
        let strictEvaluatedWindowCount = 0;
        let strictConsensusVerified = false;
        let strictBatchOutcome = 'not-run';
        let strictBatchFailure = null;
        let strictExtractionTimedOut = false;
        let inferencePreempted = false;
        const lockKey = accountJobKey(claims.uid, claims.url);
        // This endpoint is the catalogue/background LID route. Viewer-requested subtitle jobs
        // use /transcribe-async?origin=viewer and never receive these preemptible options.
        const lidBackgroundOptions = {
            backgroundKey: proxyKeyFromUrl(claims.url),
            preemptibleBackground: true,
        };
        const logStrictExtractionWindow = (input) => {
            if (!strict) return;
            console.info(JSON.stringify(buildStrictLidExtractionObservability(input)));
        };
        for (const [offsetIndex, off] of offsets.entries()) {
            const observedWindowOrdinal = strictWindowContext?.windowOrdinal || offsetIndex + 1;
            let wavPath = null;
            try {
                const extractionBudget = strict
                    ? (strictWindowContext
                        ? strictLidWindowExtractionBudget(strictWorkDeadlineAt)
                        : strictLidExtractionBudget(dur, strictWorkDeadlineAt))
                    : null;
                if (strict && extractionBudget.timeoutMs <= 0) {
                    logStrictExtractionWindow({
                        windowOrdinal: observedWindowOrdinal,
                        elapsedMs: 0,
                        timeoutMs: 0,
                        providerFetches: 0,
                        outcome: 'budget-exhausted',
                    });
                    strictExtractionTimedOut = true;
                    lastExtractErr = 'Strict audio extraction budget exhausted';
                    break;
                }
                // Fast-fail rather than queue behind a long extraction: the edge caller has its own
                // HTTP timeout — waiting minutes here would spend a provider hit after it hung up.
                if (isAccountJobBusy(lockKey)) { lastExtractErr = 'account provider slot busy (background job in progress)'; break; }
                // Same fast-fail when a VIEWER holds the slot on this box — the edge gate is checked
                // at tick entry only, and a viewer can start mid-sweep.
                if (accountSlotBusyLocally(claims.url, claims.uid ? sha256Hex(claims.uid) : '')) { lastExtractErr = 'account provider slot busy (viewer playback)'; break; }
                const extractionUrl = strictBroker ? strictBroker.inputUrl : claims.url;
                const extractionStartedAt = strict ? Date.now() : 0;
                const providerFetchesBefore = strict ? Number(strictBroker?.providerFetches || 0) : 0;
                const ex = await withAccountJobLock(lockKey, () =>
                    extractAudioWav(
                        extractionUrl,
                        ua,
                        trackIndex,
                        off > 0 ? off : 0,
                        dur,
                        strict ? extractionBudget.timeoutMs : 30_000,
                        claims.uid,
                        true,
                        requestController.signal,
                        true,
                        strictBroker ? {
                            strictLoopback: true,
                            providerSourceUrl: claims.url,
                            ...(strictWindowContext ? { checkpointWindow: true } : {}),
                        } : null,
                    ));
                if (strict) {
                    logStrictExtractionWindow({
                        windowOrdinal: observedWindowOrdinal,
                        elapsedMs: Math.max(0, Date.now() - extractionStartedAt),
                        timeoutMs: extractionBudget.timeoutMs,
                        providerFetches: Math.max(
                            0,
                            Number(strictBroker?.providerFetches || 0) - providerFetchesBefore,
                        ),
                        outcome: ex.ok === true
                            ? 'succeeded'
                            : (ex.timedOut === true || [
                                'PROVIDER_FIRST_BYTE_TIMEOUT',
                                'PROVIDER_IDLE_TIMEOUT',
                            ].includes(strictBroker?.terminalError?.code)
                                ? 'timed-out'
                                : (ex.preempted === true
                                    ? 'preempted'
                                    : (ex.aborted === true ? 'aborted' : 'failed'))),
                    });
                }
                if (!ex.ok) {
                    lastExtractErr = strictBroker ? 'Strict audio extraction failed' : ex.error;
                    if (ex.preempted) inferencePreempted = true;
                    if (strict && ex.timedOut) {
                        strictExtractionTimedOut = true;
                        break;
                    }
                    if (ex.preempted || ex.aborted || strictBroker?.terminalError) break;
                    continue;
                }   // failed or offset past the file's end → next offset
                wavPath = ex.path;
                extractions++;
                if (strict) {
                    // Provider access stays sequential through the mono-socket broker. Keep all
                    // completed WAVs locally, then load Whisper once for the complete ordered
                    // batch after provider extraction has finished.
                    strictWavSamples.push({ offset: off, path: wavPath });
                    wavPath = null;
                    continue;
                }
                let fast = null;
                let fastEligible = false;
                let result = null;
                if (detectOnlyMode !== 'off') {
                    fast = await runProductionWhisperDetectOnly(
                        wavPath,
                        detectOnlyMode,
                        lidBackgroundOptions,
                    );
                    if (fast.preempted) {
                        inferencePreempted = true;
                        break;
                    }
                    fastEligible = fast.ok === true
                        && /^[a-z]{2,3}$/.test(String(fast.lang || ''))
                        && Number(fast.prob || 0) >= WHISPER_DETECT_ONLY_MIN_PROBABILITY;
                    if (detectOnlyMode === 'primary' && fastEligible) {
                        lidDetectOnlyStats.primaryAccepted++;
                        lidDetectOnlyStats.last = {
                            at: new Date().toISOString(),
                            mode: detectOnlyMode,
                            outcome: 'accepted',
                            probability: Number(fast.prob || 0),
                            elapsedMs: fast.elapsedMs,
                        };
                        // Detect-only supplies no transcript. Never fabricate wordCount and never
                        // turn this basic catalogue evidence into strict language certification.
                        result = {
                            language: fast.lang,
                            candidate: fast.lang,
                            confidence: fast.prob,
                            confident: true,
                            verified: false,
                            validationStatus: 'pending',
                            method: 'whisper-detect-only-v1',
                            evidence: 'lid-only-high-confidence',
                            acceptanceBasis: 'whisper-lid-probability',
                            fastPathAccepted: true,
                            fallbackUsed: false,
                            consensus: 0,
                            whisperLang: fast.lang,
                            transcriptLang: null,
                            transcriptAgrees: null,
                            minProbability: WHISPER_DETECT_ONLY_MIN_PROBABILITY,
                            wordCount: 0,
                            uniqueWordCount: 0,
                            sample: '',
                            offset: off,
                        };
                    }
                }
                if (!result) {
                    if (detectOnlyMode === 'primary') lidDetectOnlyStats.primaryFallbacks++;
                    const fullStartedAt = Date.now();
                    const whisper = await runWhisperDetect(wavPath, lidBackgroundOptions);
                    const fullElapsedMs = Date.now() - fullStartedAt;
                    if (whisper.preempted) {
                        inferencePreempted = true;
                        break;
                    }
                    if (detectOnlyMode === 'shadow') {
                        lidDetectOnlyStats.shadowFullRuns++;
                        lidDetectOnlyStats.shadowFullMs += fullElapsedMs;
                    } else if (detectOnlyMode === 'primary') {
                        lidDetectOnlyStats.fallbackFullRuns++;
                        lidDetectOnlyStats.fallbackFullMs += fullElapsedMs;
                    }
                    const det = detectLanguageFromText(whisper.text);
                    // Strict validation never promotes a single-model guess. Whisper must be
                    // highly confident on each window; when the independent transcript detector
                    // has enough evidence, it must agree. Any accepted-language disagreement
                    // leaves the file pending rather than choosing a majority.
                    const whisperLang = String(whisper.lang || '').toLowerCase() || null;
                    const whisperProbability = Number(whisper.prob || 0);
                    const rawUniqueWordCount = new Set(
                        String(whisper.text || '').toLowerCase().match(/\p{L}+/gu) || [],
                    ).size;
                    const transcriptEvidence = strict
                        ? evaluateStrictTranscriptEvidence({
                            text: whisper.text || '',
                            wordCount: det.words,
                            minWords: WHISPER_STRICT_MIN_WORDS,
                            minUniqueWords: WHISPER_STRICT_MIN_UNIQUE_WORDS,
                            whisperLanguage: whisperLang,
                            transcriptLanguage: det.lang,
                            transcriptConfident: det.confident,
                        })
                        : null;
                    const transcriptDisagrees = det.confident === true
                        && Boolean(det.lang)
                        && det.lang !== whisperLang;
                    const whisperConfident = Boolean(whisperLang) && whisperProbability >= (
                        strict ? WHISPER_STRICT_MIN_PROBABILITY : 0.75
                    );
                    const enoughWords = Number(det.words || 0) >= 4;
                    const enoughTranscriptEvidence = strict ? transcriptEvidence.enough : enoughWords;
                    const strictDisposition = strict
                        ? strictLanguageSampleDisposition({
                            enoughWords: enoughTranscriptEvidence,
                            whisperConfident,
                            transcriptDisagrees,
                        })
                        : null;
                    const strictAccepted = strictDisposition === 'accepted';
                    if (strictDisposition === 'conflict') strictRejectedSpeechSamples++;
                    if (strictDisposition === 'weak') strictIgnoredWeakSpeechSamples++;
                    const confident = strict
                        ? strictAccepted
                        : (det.confident === true || whisperConfident);
                    const candidate = strict
                        ? whisperLang
                        : (det.confident ? det.lang : (whisperLang || det.lang || null));
                    const language = confident ? candidate : null;
                    result = {
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
                        wordCount: strict ? transcriptEvidence.compatibleWordCount : det.words,
                        uniqueWordCount: strict
                            ? transcriptEvidence.compatibleUniqueWordCount
                            : rawUniqueWordCount,
                        ...(strict ? {
                            transcriptEvidenceBasis: transcriptEvidence.basis,
                            scriptCharacterCount: transcriptEvidence.scriptCharacterCount,
                            uniqueScriptCharacterCount: transcriptEvidence.uniqueScriptCharacterCount,
                            uniqueScriptBigramCount: transcriptEvidence.uniqueScriptBigramCount,
                            scriptDensity: transcriptEvidence.scriptDensity,
                        } : {}),
                        sample: String(whisper.text || '').slice(0, 160),
                        offset: off,
                        ...(detectOnlyMode === 'primary' ? { fallbackUsed: true } : {}),
                    };
                    if (detectOnlyMode === 'shadow' && fast) {
                        // Compare only against a verdict the historical Edge would really
                        // persist. Whisper can emit a language on silence/music, but without
                        // four transcript words the legacy contract is still pending.
                        const fullLanguage = result.confident === true
                            && Number(result.wordCount || 0) >= 4
                            ? (result.language || null)
                            : null;
                        if (fastEligible) {
                            lidDetectOnlyStats.shadowEligible++;
                            if (!fullLanguage) {
                                lidDetectOnlyStats.shadowNoFullVerdict++;
                            } else if (fullLanguage === fast.lang) {
                                lidDetectOnlyStats.shadowAgreements++;
                            } else {
                                lidDetectOnlyStats.shadowDisagreements++;
                            }
                        }
                        const shadowOutcome = !fast.ok
                            ? 'fast-failed'
                            : (!fastEligible
                                ? 'below-threshold'
                                : (!fullLanguage
                                    ? 'full-pending'
                                    : (fullLanguage === fast.lang ? 'agree' : 'disagree')));
                        lidDetectOnlyStats.last = {
                            at: new Date().toISOString(),
                            mode: detectOnlyMode,
                            outcome: shadowOutcome,
                            probability: Number(fast.prob || 0),
                            elapsedMs: fast.elapsedMs,
                        };
                        // Diagnostic only: the language/method/wordCount returned above remain
                        // entirely those of the historical transcription path.
                        result.detectOnlyShadow = {
                            candidate: fast.ok ? fast.lang : null,
                            confidence: Number(fast.prob || 0),
                            eligible: fastEligible,
                            agreesWithFull: fastEligible && fullLanguage
                                ? fast.lang === fullLanguage
                                : null,
                            elapsedMs: fast.elapsedMs,
                            fullElapsedMs,
                        };
                    } else if (detectOnlyMode === 'primary') {
                        lidDetectOnlyStats.last = {
                            at: new Date().toISOString(),
                            mode: detectOnlyMode,
                            outcome: 'fallback',
                            probability: Number(fast?.prob || 0),
                            elapsedMs: fast?.elapsedMs ?? null,
                        };
                    }
                }
                const language = result.language;
                // "Good" = a clear transcript with a language → real speech. Stop sweeping. A
                // silent/music clip yields ~no words → keep the best partial and try the next offset.
                if (
                    language &&
                    (result.fastPathAccepted === true || Number(result.wordCount || 0) >= 4)
                ) {
                    const voteCount = (votes.get(language) || 0) + 1;
                    votes.set(language, voteCount);
                    result.consensus = voteCount;
                    if (strict) {
                        strictSamples.push({
                            offset: off,
                            language,
                            probability: Number(result.confidence || 0),
                            wordCount: Number(result.wordCount || 0),
                            uniqueWordCount: Number(result.uniqueWordCount || 0),
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
                        return sendDetectionJson(200, result);
                    }
                }
                if (!best || result.wordCount > best.wordCount) best = result;
            } catch (_) { /* try the next offset */ }
            finally { if (wavPath) fsp.unlink(wavPath).catch(() => {}); }
        }
        const strictPostExtractionFailure = strict
            ? strictLidPostExtractionFailure({
                terminalError: strictBroker?.terminalError,
                extractionTimedOut: strictExtractionTimedOut,
                workBudgetExpired: strictWorkBudgetExpired,
            })
            : null;
        if (strictPostExtractionFailure) {
            res.setHeader('Cache-Control', 'no-store');
            if (strictPostExtractionFailure.retryAfterSeconds) {
                res.setHeader('Retry-After', String(strictPostExtractionFailure.retryAfterSeconds));
            }
            return sendDetectionJson(
                strictPostExtractionFailure.status,
                strictPostExtractionFailure.payload,
            );
        }
        if (requestController.signal.aborted && !res.writableEnded) return;
        if (strict && strictWavSamples.length > 0) {
            const batchTimeoutMs = strictLidWhisperBatchTimeoutMs(
                strictWorkDeadlineAt,
                Boolean(strictWindowContext),
            );
            if (batchTimeoutMs <= 0) {
                expireStrictWorkBudget();
            } else {
                const batch = await runStrictWhisperBatch(
                    strictWavSamples.map((sample) => sample.path),
                    {
                        ...lidBackgroundOptions,
                        timeoutMs: batchTimeoutMs,
                        abortSignal: requestController.signal,
                    },
                );
                strictBatchOutcome = strictLidBatchOutcome(batch);
                if (batch.preempted) {
                    inferencePreempted = true;
                } else if (batch.timedOut || (batch.aborted && strictWorkBudgetExpired)) {
                    expireStrictWorkBudget();
                } else if (batch.ok !== true) {
                    strictBatchFailure = strictLidBatchFailureResponse(batch);
                } else if (!batch.aborted) {
                    const evaluated = strictWavSamples.map((sample, index) => (
                        strictLanguageBatchSampleResult(batch.samples[index], sample.offset)
                    ));
                    if (strictWindowContext) {
                        if (evaluated.length !== 1) {
                            throw new Error('strict window inference returned an invalid sample count');
                        }
                        const receipt = createStrictLidWindowReceipt({
                            secret: GATEWAY_TOKEN,
                            binding: strictLidWindowReceiptBinding(
                                strictWindowContext,
                                strictWindowContext.windowOrdinal,
                            ),
                            evidence: evaluated[0],
                        });
                        res.setHeader('Cache-Control', 'no-store');
                        return sendDetectionJson(200, {
                            windowCheckpointProtocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
                            windowOrdinal: strictWindowContext.windowOrdinal,
                            windowCount: strictWindowContext.windowCount,
                            receipt,
                        });
                    }
                    strictEvaluatedWindowCount = evaluated.length;
                    const summary = resolveStrictLidConsensus(evaluated, consensusNeeded);
                    strictSamples.push(...summary.acceptedSamples);
                    bestStrictAccepted = summary.bestAccepted;
                    best = summary.best;
                    strictRejectedSpeechSamples = summary.rejectedSpeechSampleCount;
                    strictIgnoredWeakSpeechSamples = summary.ignoredWeakSpeechSampleCount;
                    strictRepeatedSpeechSamples = summary.repeatedSpeechSampleCount;
                    strictMissingDiversitySamples = summary.missingDiversitySampleCount;
                    strictInsufficientSpeechSamples = summary.insufficientSpeechSampleCount;
                    strictConsensusVerified = summary.verified;
                    for (const [language, count] of summary.votes) votes.set(language, count);
                }
            }
        }
        if (strictWorkBudgetExpired) {
            res.setHeader('Cache-Control', 'no-store');
            return sendDetectionJson(504, {
                error: 'Strict language validation exceeded its request budget',
                code: 'strict_lid_request_timeout',
                retryable: true,
            });
        }
        if (requestController.signal.aborted && !res.writableEnded) return;
        if (inferencePreempted) {
            // A transport-shaped non-2xx response is essential: both Edge callers already leave
            // their exact-file cursor untouched on !res.ok, so the cron retries later and cannot
            // persist an empty/pending sample as if Whisper had actually analysed it.
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Retry-After', '30');
            return sendDetectionJson(409, {
                error: 'Language detection preempted by viewer playback',
                code: 'viewer_preempted',
                retryable: true,
            });
        }
        const logStrictLidUnverified = () => console.info(JSON.stringify(
            buildStrictLidUnverifiedObservability({
                extractedWindowCount: extractions,
                evaluatedWindowCount: strictEvaluatedWindowCount,
                acceptedSampleCount: strictSamples.length,
                acceptedLanguageCount: votes.size,
                maxConsensus: Math.max(0, ...votes.values()),
                rejectedConflictCount: strictRejectedSpeechSamples,
                ignoredWeakCount: strictIgnoredWeakSpeechSamples,
                repeatedCount: strictRepeatedSpeechSamples,
                missingDiversityCount: strictMissingDiversitySamples,
                insufficientSpeechSampleCount: strictInsufficientSpeechSamples,
                batchOutcome: strictBatchOutcome,
            }),
        ));
        if (strictBatchFailure) {
            logStrictLidUnverified();
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Retry-After', String(strictBatchFailure.retryAfterSeconds));
            return sendDetectionJson(strictBatchFailure.status, strictBatchFailure.payload);
        }
        if (extractions === 0) return sendDetectionJson(502, { error: 'Audio extraction failed', details: lastExtractErr });
        if (
            strict &&
            strictConsensusVerified &&
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
                ignoredWeakSpeechSampleCount: strictIgnoredWeakSpeechSamples,
                repeatedSpeechSampleCount: strictRepeatedSpeechSamples,
                missingDiversitySampleCount: strictMissingDiversitySamples,
                minSampleProbability: Math.min(...strictSamples.map((sample) => sample.probability)),
                minSampleWordCount: Math.min(...strictSamples.map((sample) => sample.wordCount)),
                minSampleUniqueWordCount: Math.min(
                    ...strictSamples.map((sample) => sample.uniqueWordCount),
                ),
            };
            res.setHeader('Cache-Control', 'private, max-age=3600');
            return sendDetectionJson(200, verified);
        }
        if (strict) logStrictLidUnverified();
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
                ignoredWeakSpeechSampleCount: strict ? strictIgnoredWeakSpeechSamples : undefined,
                repeatedSpeechSampleCount: strict ? strictRepeatedSpeechSamples : undefined,
                missingDiversitySampleCount: strict ? strictMissingDiversitySamples : undefined,
                samples: strict ? strictSamples : undefined,
            };
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return sendDetectionJson(200, best || {
            language: null, candidate: null, confidence: 0, confident: false,
            verified: false, validationStatus: 'pending',
            method: strict ? 'whisper-strict-consensus-v4' : 'pending',
            consensus: 0, whisperLang: null, transcriptLang: null,
            wordCount: 0, sampleCount: 0,
            rejectedSpeechSampleCount: strict ? strictRejectedSpeechSamples : undefined,
            ignoredWeakSpeechSampleCount: strict ? strictIgnoredWeakSpeechSamples : undefined,
            repeatedSpeechSampleCount: strict ? strictRepeatedSpeechSamples : undefined,
            missingDiversitySampleCount: strict ? strictMissingDiversitySamples : undefined,
            sample: '',
        });
    } catch (err) {
        if (res.writableEnded || res.destroyed) return;
        if (strict) {
            if (!strictBrokerDrained && strictBroker) {
                // A close failure must never be turned into a positive drain
                // attestation. Edge will keep its crash-safe account lease.
                return res.status(502).json({
                    error: 'Language detection provider cleanup failed',
                    code: 'strict_lid_drain_failed',
                });
            }
            return sendDetectionJson(Number.isInteger(err?.status) ? err.status : 502, {
                error: 'Language detection failed',
                code: String(err?.code || 'strict_lid_failed'),
            });
        }
        return res.status(502).json({ error: 'Language detection failed', details: String((err && err.message) || err) });
    } finally {
        res.off('close', onRequestClose);
        if (strictWorkBudgetTimer !== null) {
            clearTimeout(strictWorkBudgetTimer);
            strictWorkBudgetTimer = null;
        }
        if (strictBroker && !strictBrokerDrained) {
            try { await strictBroker.close(); } catch (_) { /* Edge retains the TTL lease */ }
        }
        if (strictWavSamples.length > 0) {
            await cleanupStrictLidFiles(strictWavSamples.map((sample) => sample.path));
        }
    }
}

function buildStrictLidWindowFinalizePendingObservability(summary, extractedWindowCount) {
    const source = summary && typeof summary === 'object' && !Array.isArray(summary)
        ? summary
        : {};
    const read = (key) => {
        try { return source[key]; } catch (_) { return undefined; }
    };
    const acceptedSamples = read('acceptedSamples');
    const votes = read('votes');
    let acceptedSampleCount = 0;
    let acceptedLanguageCount = 0;
    let maxConsensus = 0;
    try {
        acceptedSampleCount = Array.isArray(acceptedSamples) ? acceptedSamples.length : 0;
    } catch (_) { /* fail closed to zero */ }
    if (votes instanceof Map) {
        try {
            const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get;
            acceptedLanguageCount = typeof mapSize === 'function' ? mapSize.call(votes) : 0;
            Map.prototype.forEach.call(votes, (count) => {
                if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
                    maxConsensus = Math.max(maxConsensus, count);
                }
            });
        } catch (_) {
            acceptedLanguageCount = 0;
            maxConsensus = 0;
        }
    }
    return buildStrictLidUnverifiedObservability({
        extractedWindowCount,
        evaluatedWindowCount: read('evaluatedSampleCount'),
        acceptedSampleCount,
        acceptedLanguageCount,
        maxConsensus,
        rejectedConflictCount: read('rejectedSpeechSampleCount'),
        ignoredWeakCount: read('ignoredWeakSpeechSampleCount'),
        repeatedCount: read('repeatedSpeechSampleCount'),
        missingDiversityCount: read('missingDiversitySampleCount'),
        insufficientSpeechSampleCount: read('insufficientSpeechSampleCount'),
        batchOutcome: 'succeeded',
    });
}

async function handleFinalizeStrictLidWindows(req, res, capabilityToken) {
    const validation = validateDetectLanguageCapability(capabilityToken, LID_LEGACY_FULL_SCOPE);
    if (!validation.claims) {
        return res.status(validation.status).json({
            error: validation.error,
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const rawTrackIndex = String(req?.query?.index ?? '');
    if (!/^(?:0|[1-9][0-9]{0,3})$/.test(rawTrackIndex)) {
        return res.status(400).json({
            error: 'Strict language window claims are invalid',
            code: 'strict_lid_window_claims_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const trackIndex = Number(rawTrackIndex);
    const context = strictLidWindowClaimContext(validation.claims, trackIndex, { finalize: true });
    if (!context) {
        return res.status(400).json({
            error: 'Strict language window claims are invalid',
            code: 'strict_lid_window_claims_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const body = req.body;
    if (
        !body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !Array.isArray(body.receipts)
    ) {
        return res.status(400).json({
            error: 'Strict language window receipts are invalid',
            code: 'strict_lid_receipts_invalid',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    let receipts;
    let evaluated;
    try {
        receipts = validateStrictLidWindowReceiptsInput(body.receipts, context.windowCount);
        evaluated = receipts.map((receipt, index) => openStrictLidWindowReceipt({
            secret: GATEWAY_TOKEN,
            receipt,
            binding: strictLidWindowReceiptBinding(context, index + 1),
        }));
    } catch (error) {
        if (!(error instanceof StrictLidWindowCheckpointError)) throw error;
        return res.status(409).json({
            error: 'Strict language window checkpoints must be reset',
            code: 'strict_lid_checkpoint_reset_required',
            retryable: true,
            resetRequired: true,
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    const summary = resolveStrictLidConsensus(evaluated, WHISPER_STRICT_CONSENSUS);
    const payload = strictLidWindowConsensusPayload(
        summary,
        context.windowCount,
        WHISPER_STRICT_CONSENSUS,
    );
    if (!payload) {
        return res.status(409).json({
            error: 'Strict language window checkpoints must be reset',
            code: 'strict_lid_checkpoint_reset_required',
            retryable: true,
            resetRequired: true,
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    if (payload.verified !== true) {
        console.info(JSON.stringify(
            buildStrictLidWindowFinalizePendingObservability(summary, evaluated.length),
        ));
    }
    return res.status(200).json({
        ...payload,
        providerDrained: true,
        providerDrainProtocol: 1,
    });
}

function detectLanguageCapabilityFromHeader(req) {
    const token = String(req?.get?.(LID_CAPABILITY_HEADER) || '').trim();
    if (!token || token.length > 8192) return null;
    // Reject malformed values before signature parsing without echoing or
    // logging the capability. The signed payload may contain an Xtream URL.
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

function setDetectLanguageSecurityHeaders(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
}

// Preferred service-only route: the signed capability stays out of URL paths,
// bodies, access logs, Referer propagation and error traces. Security headers
// run before Bearer authentication so even rejected calls are non-cacheable.
// Never log the Authorization/capability headers or their values.
app.post('/detect-language', setDetectLanguageSecurityHeaders, requireGatewayAuth, async (req, res) => {
    const capabilityToken = detectLanguageCapabilityFromHeader(req);
    if (!capabilityToken) {
        return res.status(401).json({ error: 'Invalid byte-pipe token' });
    }
    return handleDetectLanguageRequest(req, res, capabilityToken, {
        requiredScope: LID_LEGACY_FULL_SCOPE,
    });
});

app.post('/detect-language/finalize', setDetectLanguageSecurityHeaders, requireGatewayAuth, async (req, res) => {
    const capabilityToken = detectLanguageCapabilityFromHeader(req);
    if (!capabilityToken) {
        return res.status(401).json({
            error: 'Invalid byte-pipe token',
            providerDrained: true,
            providerDrainProtocol: 1,
        });
    }
    return handleFinalizeStrictLidWindows(req, res, capabilityToken);
});

// Temporary compatibility route for already-issued clients. New callers must
// use the header route above because this path can be captured by access logs.
app.get('/detect-language/:token', async (req, res) => (
    handleDetectLanguageRequest(req, res, String(req.params.token || ''))
));

// Service-only production handoff for the isolated LID cascade. The gateway is responsible
// only for the provider-connected phase: extract one exact audio track/window and return a
// bounded canonical WAV. ECAPA, sherpa, VAD and Whisper cascade decisions happen outside this
// streaming process. Both gateway Bearer auth and a narrowly scoped HMAC assertion are
// required. Keep the assertion out of the URL: its signed (but not encrypted) payload contains
// the provider URL and must not be copied into proxy/access-log paths.
app.post('/extract-language-wav', requireGatewayAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    lidLanguageWavStats.requests++;

    const assertion = String(req.get('x-norva-lid-assertion') || '');
    if (!assertion || assertion.length > 8192) {
        lidLanguageWavStats.invalidTokens++;
        return res.status(401).json({ error: 'Invalid language WAV assertion' });
    }
    const claims = verifyRawToken(assertion, GATEWAY_TOKEN);
    if (!claims || !LID_CASCADE_WAV_SCOPES.has(String(claims.scope || ''))) {
        lidLanguageWavStats.invalidTokens++;
        lidLanguageWavStats.last = {
            at: new Date().toISOString(),
            outcome: 'invalid-token',
        };
        return res.status(401).json({ error: 'Invalid language WAV token' });
    }
    const expiresAtSeconds = Number(claims.exp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
        !Number.isSafeInteger(expiresAtSeconds) ||
        expiresAtSeconds <= nowSeconds ||
        expiresAtSeconds > nowSeconds + 15 * 60
    ) {
        lidLanguageWavStats.invalidTokens++;
        lidLanguageWavStats.last = {
            at: new Date().toISOString(),
            outcome: 'expired-token',
        };
        return res.status(401).json({ error: 'Language WAV token expired' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    const trackIndex = body.index;
    const startOffset = body.start;
    const hasDurationSeconds = Object.prototype.hasOwnProperty.call(body, 'durationSeconds');
    const hasLegacyDuration = Object.prototype.hasOwnProperty.call(body, 'dur');
    if (
        hasDurationSeconds &&
        hasLegacyDuration &&
        body.durationSeconds !== body.dur
    ) {
        lidLanguageWavStats.invalidRequests++;
        return res.status(400).json({ error: 'Conflicting duration fields' });
    }
    const duration = hasDurationSeconds ? body.durationSeconds : body.dur;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 1024) {
        lidLanguageWavStats.invalidRequests++;
        return res.status(400).json({ error: 'Invalid audio index' });
    }
    if (typeof startOffset !== 'number' || !Number.isFinite(startOffset) || startOffset < 0 || startOffset > 21600) {
        lidLanguageWavStats.invalidRequests++;
        return res.status(400).json({ error: 'Invalid language WAV offset' });
    }
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 8 || duration > 30) {
        lidLanguageWavStats.invalidRequests++;
        return res.status(400).json({ error: 'Language WAV duration must be between 8 and 30 seconds' });
    }

    if (
        lidLanguageWavActive > 0 ||
        lidBenchmarkBusy ||
        lidProductionCpuBusy()
    ) {
        lidLanguageWavStats.busyRejections++;
        lidLanguageWavStats.last = {
            at: new Date().toISOString(),
            outcome: 'gateway-busy',
            scope: claims.scope,
        };
        res.setHeader('Retry-After', '30');
        return res.status(429).json({ error: 'Language WAV extraction requires an idle gateway' });
    }

    const lockKey = accountJobKey(claims.uid, claims.url);
    if (isAccountJobBusy(lockKey) || accountSlotBusyLocally(claims.url, claims.uid ? sha256Hex(claims.uid) : '')) {
        lidLanguageWavStats.busyRejections++;
        lidLanguageWavStats.last = {
            at: new Date().toISOString(),
            outcome: 'provider-busy',
            scope: claims.scope,
        };
        res.setHeader('Retry-After', '30');
        return res.status(429).json({ error: 'Provider account is busy' });
    }

    lidLanguageWavActive++;
    lidLanguageWavStats.attempts++;
    let wavPath = null;
    let wavBuffer = null;
    let extractMs = 0;
    const clientAbort = new AbortController();
    const abortExtraction = () => {
        if (!res.writableFinished) clientAbort.abort();
    };
    req.once('aborted', abortExtraction);
    res.once('close', abortExtraction);
    try {
        const extractStartedAt = performance.now();
        const ex = await withAccountJobLock(lockKey, () =>
            extractAudioWav(
                claims.url,
                sanitizeUserAgent(claims.ua) || FFMPEG_USER_AGENT,
                trackIndex,
                startOffset,
                duration,
                45_000,
                claims.uid,
                true,
                clientAbort.signal,
            ));
        extractMs = Math.round((performance.now() - extractStartedAt) * 100) / 100;
        lidLanguageWavStats.totalExtractMs += extractMs;
        if (!ex.ok) {
            if (ex.aborted) {
                lidLanguageWavStats.responseAborts++;
                lidLanguageWavStats.last = {
                    at: new Date().toISOString(),
                    outcome: 'client-aborted',
                    scope: claims.scope,
                    extractMs,
                };
                if (!res.headersSent && !res.destroyed) {
                    return res.status(499).json({ error: 'Language WAV request was aborted' });
                }
                return undefined;
            }
            if (ex.preempted) {
                lidLanguageWavStats.busyRejections++;
                lidLanguageWavStats.last = {
                    at: new Date().toISOString(),
                    outcome: 'provider-preempted',
                    scope: claims.scope,
                    extractMs,
                };
                res.setHeader('Retry-After', '30');
                return res.status(409).json({ error: 'Provider became busy during extraction' });
            }
            lidLanguageWavStats.extractionFailures++;
            const detail = sanitizeLanguageWavError(ex.error, claims.url);
            lidLanguageWavStats.last = {
                at: new Date().toISOString(),
                outcome: 'extract-failed',
                scope: claims.scope,
                extractMs,
                detail,
            };
            return res.status(502).json({ error: 'Audio extraction failed', details: detail });
        }
        wavPath = ex.path;

        const stat = await fsp.stat(wavPath);
        const wavBytes = stat.size;
        if (!Number.isSafeInteger(wavBytes) || wavBytes < 44) {
            lidLanguageWavStats.validationFailures++;
            return res.status(502).json({ error: 'Extracted WAV is invalid' });
        }
        if (wavBytes > LID_LANGUAGE_WAV_MAX_BYTES) {
            lidLanguageWavStats.oversized++;
            return res.status(413).json({ error: 'Extracted WAV exceeds the language sample limit' });
        }

        wavBuffer = await fsp.readFile(wavPath);
        if (wavBuffer.length !== wavBytes) {
            lidLanguageWavStats.validationFailures++;
            return res.status(502).json({ error: 'Extracted WAV changed during validation' });
        }
        let wavInfo;
        try {
            wavInfo = inspectLanguageWavBuffer(wavBuffer);
        } catch (error) {
            lidLanguageWavStats.validationFailures++;
            const detail = sanitizeLanguageWavError(error, claims.url);
            lidLanguageWavStats.last = {
                at: new Date().toISOString(),
                outcome: 'invalid-wav',
                scope: claims.scope,
                extractMs,
                detail,
            };
            return res.status(502).json({ error: 'Extracted WAV format is invalid', details: detail });
        }

        const digest = crypto.createHash('sha256').update(wavBuffer).digest('hex');
        const audioSeconds = Math.round(wavInfo.audioSeconds * 1000) / 1000;
        res.status(200);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(wavBytes));
        res.setHeader('X-Norva-Sample-Sha256', digest);
        res.setHeader('X-Norva-Audio-Sha256', digest);
        res.setHeader('X-Content-Sha256', digest);
        res.setHeader('X-Norva-Sample-Bytes', String(wavBytes));
        res.setHeader('X-Norva-Audio-Seconds', String(audioSeconds));
        res.setHeader('X-Norva-Extract-Ms', String(extractMs));
        const completed = await endLanguageWavResponse(res, wavBuffer);
        if (completed) {
            lidLanguageWavStats.successes++;
            lidLanguageWavStats.bytesServed += wavBytes;
            lidLanguageWavStats.last = {
                at: new Date().toISOString(),
                outcome: 'served',
                scope: claims.scope,
                wavBytes,
                audioSeconds,
                extractMs,
            };
        } else {
            lidLanguageWavStats.responseAborts++;
            lidLanguageWavStats.last = {
                at: new Date().toISOString(),
                outcome: 'response-aborted',
                scope: claims.scope,
                wavBytes,
                extractMs,
            };
        }
        return undefined;
    } catch (error) {
        lidLanguageWavStats.extractionFailures++;
        const detail = sanitizeLanguageWavError(error, claims.url);
        lidLanguageWavStats.last = {
            at: new Date().toISOString(),
            outcome: 'failed',
            scope: claims.scope,
            extractMs,
            detail,
        };
        if (!res.headersSent) {
            return res.status(502).json({ error: 'Language WAV extraction failed', details: detail });
        }
        return undefined;
    } finally {
        req.off('aborted', abortExtraction);
        res.off('close', abortExtraction);
        if (wavBuffer) wavBuffer.fill(0);
        if (wavPath) await fsp.unlink(wavPath).catch(() => {});
        lidLanguageWavActive = Math.max(0, lidLanguageWavActive - 1);
    }
});

// Service-only A/B benchmark. A signed scope keeps browser-visible byte-pipe tokens from
// enabling the double CPU work, while gateway Bearer auth keeps the route off the public path.
// The provider is touched exactly once: both Whisper modes consume the same temporary WAV and
// nothing is persisted here or by the edge benchmark caller.
app.post('/benchmark-language/:token', requireGatewayAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
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
    const includeWav = body.includeWav === true;
    const lockKey = accountJobKey(claims.uid, claims.url);
    if (isAccountJobBusy(lockKey) || accountSlotBusyLocally(claims.url, claims.uid ? sha256Hex(claims.uid) : '')) {
        res.setHeader('Retry-After', '30');
        return res.status(429).json({ error: 'Provider account is busy' });
    }

    lidBenchmarkBusy = true;
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
        if (!Number.isSafeInteger(wavBytes) || wavBytes < 44) {
            return res.status(502).json({ error: 'Extracted WAV is invalid' });
        }
        if (includeWav && wavBytes > LID_BENCHMARK_WAV_MAX_BYTES) {
            return res.status(413).json({ error: 'Benchmark WAV capture exceeds the operator limit' });
        }
        const wavBuffer = await fsp.readFile(wavPath);
        if (wavBuffer.length !== wavBytes) {
            return res.status(502).json({ error: 'Extracted WAV changed during benchmark setup' });
        }
        const audioSec = Math.max(0, (wavBytes - 44) / (16000 * 2));
        const sampleDigest = crypto.createHash('sha256')
            .update(wavBuffer)
            .digest('hex');
        let wavCapture = null;
        if (includeWav) {
            if (
                wavBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
                wavBuffer.subarray(8, 12).toString('ascii') !== 'WAVE'
            ) {
                return res.status(502).json({ error: 'Extracted WAV header is invalid' });
            }
            const base64 = wavBuffer.toString('base64');
            if (base64.length > LID_BENCHMARK_WAV_BASE64_MAX_CHARS) {
                return res.status(413).json({ error: 'Benchmark WAV base64 exceeds the operator limit' });
            }
            wavCapture = {
                contentType: 'audio/wav',
                encoding: 'base64',
                bytes: wavBytes,
                digest: sampleDigest,
                base64,
            };
        }

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
                gatewayVersion: GATEWAY_VERSION,
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
            ...(wavCapture ? { wavCapture } : {}),
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
    if (!bytePipeAllowsPurpose(claims, 'transcribe-bench')) {
        return res.status(403).json({ error: 'Byte-pipe token is not authorized for transcription' });
    }
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
            extractAudioWav(
                claims.url,
                ua,
                trackIndex,
                startOffset,
                dur,
                AUDIO_EXTRACT_TIMEOUT_MS,
                claims.uid,
                true,
                null,
                false,
            ));
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
    if (!bytePipeAllowsPurpose(claims, 'transcribe-job')) {
        return res.status(403).json({ error: 'Byte-pipe token is not authorized for transcription jobs' });
    }
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
    if (!bytePipeAllowsPurpose(claims, 'ocr-job')) {
        return res.status(403).json({ error: 'Byte-pipe token is not authorized for OCR jobs' });
    }
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
    // Backward-compatible rollout: legacy Edge builds omitted OCR origin and
    // those requests were viewer-facing. New Edge builds always send an
    // explicit viewer/service/pregen class, so background work remains gated.
    const prio = JOB_PRIORITY[String(req.query.origin || '')] ?? JOB_PRIORITY.viewer;
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
    if (!bytePipeAllowsPurpose(claims, 'storyboard-job')) {
        return res.status(403).json({ error: 'Byte-pipe token is not authorized for storyboard jobs' });
    }
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

// Validate the exact wire contract consumed by the isolated production LID worker.
// Do not assume a 44-byte WAV header: ffmpeg may add harmless metadata chunks, so
// walk RIFF chunks while still failing closed on truncation, overflow or format drift.
function inspectLanguageWavBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > LID_LANGUAGE_WAV_MAX_BYTES) {
        throw new Error('WAV byte length is outside the allowed bounds');
    }
    if (
        buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
    ) {
        throw new Error('WAV must use the RIFF/WAVE container');
    }
    const riffBytes = buffer.readUInt32LE(4) + 8;
    if (!Number.isSafeInteger(riffBytes) || riffBytes !== buffer.length || riffBytes < 44) {
        throw new Error('WAV RIFF size is invalid');
    }

    let format = null;
    let dataBytes = null;
    for (let offset = 12; offset + 8 <= riffBytes;) {
        const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
        const chunkBytes = buffer.readUInt32LE(offset + 4);
        const bodyOffset = offset + 8;
        const bodyEnd = bodyOffset + chunkBytes;
        if (!Number.isSafeInteger(bodyEnd) || bodyEnd > riffBytes || bodyEnd < bodyOffset) {
            throw new Error('WAV chunk exceeds the RIFF boundary');
        }
        if (chunkId === 'fmt ') {
            if (chunkBytes < 16) throw new Error('WAV fmt chunk is too short');
            format = {
                audioFormat: buffer.readUInt16LE(bodyOffset),
                channels: buffer.readUInt16LE(bodyOffset + 2),
                sampleRate: buffer.readUInt32LE(bodyOffset + 4),
                byteRate: buffer.readUInt32LE(bodyOffset + 8),
                blockAlign: buffer.readUInt16LE(bodyOffset + 12),
                bitsPerSample: buffer.readUInt16LE(bodyOffset + 14),
            };
        } else if (chunkId === 'data') {
            dataBytes = chunkBytes;
        }
        const next = bodyEnd + (chunkBytes % 2);
        if (next <= offset || next > riffBytes) throw new Error('WAV chunk size is invalid');
        offset = next;
    }
    if (!format || dataBytes === null || dataBytes <= 0) {
        throw new Error('WAV is missing a valid fmt or data chunk');
    }
    if (
        format.audioFormat !== 1 ||
        format.channels !== 1 ||
        format.sampleRate !== 16000 ||
        format.byteRate !== 32000 ||
        format.blockAlign !== 2 ||
        format.bitsPerSample !== 16
    ) {
        throw new Error('WAV must be mono 16 kHz PCM signed 16-bit');
    }
    const audioSeconds = dataBytes / format.byteRate;
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0 || audioSeconds > 30.1) {
        throw new Error('WAV audio duration is invalid');
    }
    return {
        audioSeconds,
        dataBytes,
        ...format,
    };
}

// Keep the response buffer alive until Node has flushed or abandoned the response. The route's
// finally block can then wipe it without racing the socket write.
function endLanguageWavResponse(res, buffer) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (completed, error = null) => {
            if (settled) return;
            settled = true;
            res.off('finish', onFinish);
            res.off('close', onClose);
            if (error) reject(error);
            else resolve(completed);
        };
        const onFinish = () => finish(true);
        const onClose = () => finish(res.writableFinished === true);
        res.once('finish', onFinish);
        res.once('close', onClose);
        try {
            res.end(buffer);
        } catch (error) {
            finish(false, error);
        }
    });
}

function sanitizeLanguageWavError(error, sourceUrl) {
    return sanitizeLog(
        redactCreds(String(error?.message || error || 'language WAV operation failed')),
        sourceUrl,
    )
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 320) || 'language WAV operation failed';
}

// Extract a mono/16 kHz pcm_s16le WAV of one audio track to a temp file. Resolves
// { ok:true, path, timedOut:false, signal:null } or an equally typed failure — the error carries
// the REAL cause (ffmpeg stderr
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
    abortSignal = null,
    globalPreemptible = true,
    inputOptions = null,
) {
    return new Promise((resolve) => {
        if (globalPreemptible && viewerPlaybackActiveLocally()) {
            return resolve({
                ok: false,
                preempted: true,
                timedOut: false,
                signal: null,
                error: 'preempted by viewer playback before extraction spawn',
            });
        }
        const outputPath = path.join(os.tmpdir(), `norva-audio-${Date.now()}-${crypto.randomUUID()}.wav`);
        const strictLoopback = inputOptions?.strictLoopback === true;
        const strictCheckpointWindow = strictLoopback && inputOptions?.checkpointWindow === true;
        const providerSourceUrl = strictLoopback && isHttpUrl(inputOptions?.providerSourceUrl)
            ? String(inputOptions.providerSourceUrl)
            : url;
        const providerAccountKey = proxyKeyFromUrl(providerSourceUrl);
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            // Mid-stream drop resilience, copied from the playback ffmpeg: without these, a
            // whole-film extraction dies on the FIRST connection reset (a 3s relay probe
            // releasing the slot was enough). Deliberately NO -reconnect_on_http_error — on a
            // single-slot panel, retrying an HTTP error HOLDS the failing connect and hammers
            // the slot into more 429s; the job-level retry below re-attempts cleanly instead.
            ...(!strictLoopback ? [
                '-reconnect', '1', '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
            ] : []),
            '-rw_timeout', strictLoopback
                ? String(strictCheckpointWindow
                    ? STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US
                    : STRICT_LID_FFMPEG_RW_TIMEOUT_US)
                : '15000000',
            '-headers', strictLoopback
                ? 'Accept: */*\r\nConnection: close\r\n'
                : 'Accept: */*\r\nConnection: keep-alive\r\n',
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
        try {
            child = spawn(FFMPEG_PATH, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                env: strictLoopback ? loopbackOnlyEnv() : proxyEnvFor(providerAccountKey),
            });
        }
        catch (e) {
            return resolve({
                ok: false,
                timedOut: false,
                signal: null,
                error: 'spawn failed: ' + String((e && e.message) || e),
            });
        }
        const reg = registerAccountExtraction(
            providerAccountKey,
            child,
            strictLoopback ? ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION : reportActivity,
            globalPreemptible,
        );
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let requestedSignal = null;
        const abort = () => {
            aborted = true;
            requestedSignal = 'SIGKILL';
            try { child.kill('SIGKILL'); } catch (_) {}
        };
        const removeAbortListener = () => abortSignal?.removeEventListener?.('abort', abort);
        if (abortSignal?.aborted) abort();
        else abortSignal?.addEventListener?.('abort', abort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            requestedSignal = 'SIGKILL';
            try { child.kill('SIGKILL'); } catch (_) {}
        }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            removeAbortListener();
            reg.release?.();
            fsp.unlink(outputPath).catch(() => {});
            resolve({
                ok: false,
                aborted,
                timedOut,
                signal: requestedSignal,
                error: aborted
                    ? 'extraction request aborted'
                    : 'ffmpeg error: ' + String((e && e.message) || e),
            });
        });
        child.on('close', async (code, signal) => {
            clearTimeout(timer);
            removeAbortListener();
            reg.release?.();
            const safeStderr = strictLoopback ? redactStrictLidLoopback(stderr) : stderr;
            const tail = redactCreds(safeStderr.trim().split('\n').filter(Boolean).pop() || 'no stderr');
            if (aborted) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({
                    ok: false,
                    aborted: true,
                    timedOut,
                    signal: signal || requestedSignal,
                    error: 'extraction request aborted',
                });
            }
            if (reg.preempted) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({
                    ok: false,
                    preempted: true,
                    timedOut,
                    signal: signal || requestedSignal,
                    error: 'preempted by viewer playback on this account',
                });
            }
            if (code !== 0) {
                console.warn(`[media-gateway] audio-extract ffmpeg exit ${code} signal ${signal || 'none'}: ${redactCreds(safeStderr.slice(-300))}`);
                fsp.unlink(outputPath).catch(() => {});
                return resolve({
                    ok: false,
                    timedOut,
                    signal: signal || requestedSignal,
                    error: timedOut
                        ? `extract timeout after ${Math.round(timeoutMs / 1000)}s: ${tail}`
                        : `ffmpeg exit ${code}: ${tail}`,
                });
            }
            let size = 0;
            try { size = (await fsp.stat(outputPath)).size; } catch (_) { size = 0; }
            if (size <= 4000) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({
                    ok: false,
                    timedOut: false,
                    signal: signal || null,
                    error: `empty/tiny WAV (${size}B) — no audio decoded (${tail})`,
                });
            }
            resolve({ ok: true, path: outputPath, timedOut: false, signal: signal || null });
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
function extractAudioWavChunks(url, ua, trackIndex, timeoutMs, proxyKey, chunkSec, dir, globalPreemptible = true) {
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
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child, true, globalPreemptible);
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

// Run whisper.cpp's language-only mode under the same CPU activity guard as full
// transcription. The helper always settles after the child is closed, so a timeout cannot
// overlap the fallback process on the same replica.
async function runProductionWhisperDetectOnly(wavPath, mode, options = {}) {
    if (mode === 'primary') lidDetectOnlyStats.primaryAttempts++;
    else lidDetectOnlyStats.shadowAttempts++;
    const backgroundKey = String(options.backgroundKey || '');
    const preemptibleBackground = options.preemptibleBackground === true && Boolean(backgroundKey);
    if (preemptibleBackground && viewerPlaybackActiveLocally()) {
        return {
            ok: false,
            lang: null,
            prob: 0,
            timedOut: false,
            preempted: true,
            error: 'whisper preempted by viewer playback on this account',
            elapsedMs: 0,
        };
    }
    whisperInferenceActive += 1;
    const startedAt = Date.now();
    let backgroundRegistration = null;
    try {
        const value = await runWhisperDetectOnly({
            bin: WHISPER_BIN,
            model: WHISPER_MODEL,
            wavPath,
            threads: WHISPER_THREADS,
            timeoutMs: WHISPER_DETECT_ONLY_TIMEOUT_MS,
            onSpawn: (child) => {
                if (!preemptibleBackground) return;
                backgroundRegistration = registerPreemptibleBackgroundWhisper(backgroundKey, child);
            },
        });
        const elapsedMs = Date.now() - startedAt;
        lidDetectOnlyStats.totalFastMs += elapsedMs;
        if (backgroundRegistration?.preempted === true) {
            return {
                ...value,
                ok: false,
                lang: null,
                prob: 0,
                preempted: true,
                error: 'whisper preempted by viewer playback on this account',
                elapsedMs,
            };
        }
        if (value.ok !== true) lidDetectOnlyStats.failures++;
        if (value.timedOut === true) lidDetectOnlyStats.timeouts++;
        return { ...value, elapsedMs };
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        lidDetectOnlyStats.totalFastMs += elapsedMs;
        lidDetectOnlyStats.failures++;
        return {
            ok: false,
            lang: null,
            prob: 0,
            timedOut: false,
            error: String(error?.message || error),
            elapsedMs,
        };
    } finally {
        backgroundRegistration?.release?.();
        whisperInferenceActive = Math.max(0, whisperInferenceActive - 1);
    }
}

// Strict LID consumes every successfully extracted window in one whisper-cli process. The
// pinned whisper.cpp build accepts ordered repeated -f/-of arguments, so model initialization
// happens once while each transcript and LID line remains mapped to its own offset.
async function runStrictWhisperBatch(wavPaths, options = {}) {
    const backgroundKey = String(options.backgroundKey || '');
    const preemptibleBackground = options.preemptibleBackground === true && Boolean(backgroundKey);
    if (preemptibleBackground && viewerPlaybackActiveLocally()) {
        return {
            ok: false,
            samples: wavPaths.map(() => ({ text: '', lang: null, prob: 0 })),
            timedOut: false,
            aborted: false,
            preempted: true,
            error: 'whisper preempted by viewer playback on this account',
        };
    }
    whisperInferenceActive += 1;
    let backgroundRegistration = null;
    try {
        const value = await runWhisperBatchProcess({
            bin: WHISPER_BIN,
            model: WHISPER_MODEL,
            wavPaths,
            threads: WHISPER_THREADS,
            timeoutMs: Math.max(1, Number(options.timeoutMs) || 1),
            abortSignal: options.abortSignal || null,
            onSpawn: (child) => {
                if (!preemptibleBackground) return;
                backgroundRegistration = registerPreemptibleBackgroundWhisper(backgroundKey, child);
            },
            isPreempted: () => backgroundRegistration?.preempted === true,
        });
        if (backgroundRegistration?.preempted === true) {
            return {
                ...value,
                ok: false,
                samples: wavPaths.map(() => ({ text: '', lang: null, prob: 0 })),
                preempted: true,
                error: 'whisper preempted by viewer playback on this account',
            };
        }
        return value;
    } finally {
        backgroundRegistration?.release?.();
        whisperInferenceActive = Math.max(0, whisperInferenceActive - 1);
    }
}

// Run whisper.cpp on a WAV: auto-detect language + transcribe. Resolves { text, lang, prob };
// best-effort (empties on failure). `lang`/`prob` are parsed from whisper's own LID line.
function runWhisperDetect(wavPath, options = {}) {
    return new Promise((resolve) => {
        const backgroundKey = String(options.backgroundKey || '');
        const preemptibleBackground = options.preemptibleBackground === true && Boolean(backgroundKey);
        if (preemptibleBackground && viewerPlaybackActiveLocally()) {
            return resolve({
                text: '', lang: null, prob: 0, preempted: true,
                error: 'whisper preempted by viewer playback on this account',
            });
        }
        whisperInferenceActive += 1;
        let inferenceReleased = false;
        let backgroundRegistration = null;
        const releaseInference = () => {
            if (inferenceReleased) return;
            inferenceReleased = true;
            backgroundRegistration?.release?.();
            whisperInferenceActive = Math.max(0, whisperInferenceActive - 1);
        };
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            releaseInference();
            resolve(value);
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
            return finish({ text: '', lang: null, prob: 0 });
        }
        if (preemptibleBackground) {
            backgroundRegistration = registerPreemptibleBackgroundWhisper(backgroundKey, child);
        }
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, WHISPER_TIMEOUT_MS);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => {
            clearTimeout(timer);
            const preempted = backgroundRegistration?.preempted === true;
            finish({
                text: '', lang: null, prob: 0,
                ...(preempted
                    ? {
                        preempted: true,
                        error: 'whisper preempted by viewer playback on this account',
                    }
                    : {}),
            });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            if (settled) return;
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : null;
            const prob = m ? (Number(m[2]) || 0) : 0;
            let text = '';
            try { text = await fsp.readFile(outPrefix + '.txt', 'utf8'); } catch (_) { text = ''; }
            fsp.unlink(outPrefix + '.txt').catch(() => {});
            if (backgroundRegistration?.preempted === true) {
                return finish({
                    text: '', lang: null, prob: 0, preempted: true,
                    error: 'whisper preempted by viewer playback on this account',
                });
            }
            if (code !== 0 && !text && !lang) console.warn(`[media-gateway] whisper exit ${code}: ${stderr.slice(-300)}`);
            finish({ text: String(text || '').trim(), lang, prob });
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
function runWhisperVtt(wavPath, forceLang, timeoutMs = WHISPER_TRANSCRIBE_TIMEOUT_MS, options = {}) {
    return new Promise((resolve) => {
        const backgroundKey = String(options.backgroundKey || '');
        const preemptibleBackground = options.preemptibleBackground === true && Boolean(backgroundKey);
        // Close the extraction→inference race: playback may have started after the job's WAV was
        // produced but before whisper.cpp was spawned.
        if (preemptibleBackground && viewerPlaybackActiveLocally()) {
            return resolve({
                vtt: '', lang: null, prob: 0, ms: 0, preempted: true,
                failReason: 'whisper preempted by viewer playback on this account',
            });
        }
        whisperInferenceActive += 1;
        let inferenceReleased = false;
        let backgroundRegistration = null;
        const releaseInference = () => {
            if (inferenceReleased) return;
            inferenceReleased = true;
            backgroundRegistration?.release?.();
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
        if (preemptibleBackground) {
            backgroundRegistration = registerPreemptibleBackgroundWhisper(backgroundKey, child);
        }
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            releaseInference();
            resolve(value);
        };
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            const preempted = backgroundRegistration?.preempted === true;
            finish({
                vtt: '', lang: null, prob: 0, ms: Date.now() - t0,
                ...(preempted ? { preempted: true } : {}),
                failReason: preempted
                    ? 'whisper preempted by viewer playback on this account'
                    : 'whisper error: ' + String((e && e.message) || e),
            });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            if (settled) return;
            const m = stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
            const lang = m ? m[1].toLowerCase() : (forceLang || null);
            const prob = m ? (Number(m[2]) || 0) : 0;
            let vtt = '';
            try { vtt = await fsp.readFile(outPrefix + '.vtt', 'utf8'); } catch (_) { vtt = ''; }
            fsp.unlink(outPrefix + '.vtt').catch(() => {});
            if (backgroundRegistration?.preempted === true) {
                return finish({
                    vtt: '', lang: null, prob: 0, ms: Date.now() - t0, preempted: true,
                    failReason: 'whisper preempted by viewer playback on this account',
                });
            }
            if (code !== 0 && !vtt) console.warn(`[media-gateway] whisper-vtt exit ${code}: ${stderr.slice(-300)}`);
            const failReason = vtt ? null
                : timedOut ? `whisper killed by timeout after ${Math.round((Date.now() - t0) / 1000)}s (no partial VTT is written)`
                : `whisper exit ${code} wrote no VTT: ${stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr'}`;
            finish({ vtt: cleanVtt(String(vtt || '').trim()), lang, prob, ms: Date.now() - t0, failReason });
        });
    });
}

// ONE provider-touching background ffmpeg per account at a time, ACROSS lanes (fix #2 of the
// subtitle-failures audit). The transcribe, OCR and detect-language lanes each serialize
// internally, but nothing stopped two lanes from opening two simultaneous connections on the
// same single-slot panel account (pregen extraction + whisper-LID sweep → instant user_multi_ip
// refusal — the 02/07 super8k failures). Keyed by the same canonical provider-account
// identity as proxy affinity, regardless of which Norva user owns the source. The lock wraps only the
// provider-connected phase (ffmpeg extraction) — whisper/tesseract are pure CPU and run outside
// it. Viewer-interactive paths (/raw, /subtitle, playback) are NOT serialized here: they have
// their own slot-eviction machinery and must never wait behind a long extraction.
const accountJobLocks = new Map(); // key -> tail promise of the wait chain
function accountJobKey(_uid, url) { return proxyKeyFromUrl(url); }
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
const JOB_DEFER_HEARTBEAT_MIN_INTERVAL_MS = 60_000;
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
function backgroundJobBlockedByViewer(job) {
    return jobPrio(job) !== JOB_PRIORITY.viewer && viewerPlaybackActiveLocally();
}
function whisperOptionsForJob(job) {
    if (jobPrio(job) === JOB_PRIORITY.viewer) return {};
    return {
        backgroundKey: proxyKeyFromUrl(job?.url || ''),
        preemptibleBackground: true,
    };
}
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
    if (stage === 'deferred') {
        const now = Date.now();
        if (now - Number(job?.lastDeferredHeartbeatAt || 0) < JOB_DEFER_HEARTBEAT_MIN_INTERVAL_MS) return;
        job.lastDeferredHeartbeatAt = now;
    }
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
        // Service/pregen enrichment is globally background work on this one-vCPU
        // replica. A viewer-origin request keeps its interactive priority, but
        // every other job waits while any local playback is starting or active.
        const backgroundBlockedByViewer = backgroundJobBlockedByViewer(job);
        if (backgroundBlockedByViewer) {
            // Active viewing is not a provider/job failure and must not consume
            // the bounded edge-gate deferral budget, even during a long film.
            postJobHeartbeat(job, 'deferred');
            deferred.push(job);
            continue;
        }
        // Local slot check FIRST: this box knows instantly when a viewer session or raw pump
        // holds the job's provider account — no round-trip, and it sees what the edge gate
        // can't (a paused viewer whose transcode ffmpeg still runs). Then the edge gate for
        // relay-side signals (live sessions on other lanes, enrichment ticks).
        const localViewerSlotBusy = accountSlotBusyLocally(job.url, job.uid ? sha256Hex(job.uid) : '');
        if (localViewerSlotBusy) {
            // Same-account viewer auxiliary work cannot coexist with a
            // single-slot playback, but that viewing time is not a job failure.
            postJobHeartbeat(job, 'deferred');
            deferred.push(job);
            continue;
        }
        const locallyDeferred = storyboardCoolingDown(job)
            || transcribeCoolingDown(job);
        const edgeDeferred = locallyDeferred ? false : await shouldDeferJob(job);
        // shouldDeferJob may wait up to 10 s. Re-check the global reservation
        // after that await before granting the job a provider/CPU slot.
        const viewerWonGateRace = backgroundJobBlockedByViewer(job);
        if (!locallyDeferred && !edgeDeferred && !viewerWonGateRace) {
            job.gateDeferrals = 0;
            picked = job;
            break;
        }
        if (viewerWonGateRace) {
            postJobHeartbeat(job, 'deferred');
            deferred.push(job);
            continue;
        }
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
function createQueueWakeState() { return { waiter: null, version: 0 }; }
function wakeQueueDrain(state) {
    if (!state) return;
    state.version = Number(state.version || 0) + 1;
    const waiter = state?.waiter;
    if (typeof waiter === 'function') waiter();
}
function waitForQueueWake(state, timeoutMs, observedVersion = Number(state?.version || 0)) {
    return new Promise((resolve) => {
        if (Number(state?.version || 0) !== observedVersion) {
            resolve();
            return;
        }
        let settled = false;
        let timer = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (state.waiter === finish) state.waiter = null;
            resolve();
        };
        state.waiter = finish;
        timer = setTimeout(finish, timeoutMs);
    });
}
const transcribeWakeState = createQueueWakeState();
function wakePlaybackBlockedQueues() {
    wakeQueueDrain(transcribeWakeState);
    wakeQueueDrain(ocrWakeState);
}
const MAX_TRANSCRIBE_QUEUE = clampInt(process.env.MAX_TRANSCRIBE_QUEUE, 50, 1, 500);

function enqueueTranscribe(job) {
    if (transcribeQueue.length >= MAX_TRANSCRIBE_QUEUE) return false;
    insertByPriority(transcribeQueue, job); // viewer clicks jump ahead of the nightly pregen batch
    postJobHeartbeat(job, 'queued');
    wakeQueueDrain(transcribeWakeState);
    queueMicrotask(drainTranscribeQueue);
    return true;
}
async function drainTranscribeQueue() {
    if (transcribeBusy) return;
    transcribeBusy = true;
    try {
        while (transcribeQueue.length) {
            const wakeVersion = transcribeWakeState.version;
            const job = await nextRunnableJob(transcribeQueue, 'transcribe');
            if (!job) {
                await waitForQueueWake(
                    transcribeWakeState,
                    JOB_GATE_POLL_MS,
                    wakeVersion,
                );
                continue;
            }
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
                    backgroundJobBlockedByViewer(job)
                        ? { ok: false, preempted: true, error: 'preempted by viewer playback before extraction' }
                        : extractAudioWav(
                        url,
                        ua,
                        index,
                        start,
                        dur,
                        AUDIO_EXTRACT_TIMEOUT_MS,
                        uid,
                        true,
                        null,
                        jobPrio(job) !== JOB_PRIORITY.viewer,
                    ));
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
                const w = await runWhisperVtt(
                    wavPath,
                    '',
                    whisperBudgetMs(audioSec),
                    whisperOptionsForJob(job),
                );
                if (w.preempted) {
                    payload = { requeue: true };
                } else {
                    const segments = (w.vtt.match(/-->/g) || []).length;
                    payload = w.vtt
                        ? { jobId, ok: true, vtt: w.vtt, sourceLang: w.lang, audioSec, segments }
                        : { jobId, ok: false, error: ('Transcription produced no output: ' + (w.failReason || 'unknown')).slice(0, 300) };
                }
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

function extractStoryboardSprite(
    url,
    ua,
    intervalSec,
    cols,
    rows,
    outputPath,
    timeoutMs,
    proxyKey = '',
    globalPreemptible = true,
) {
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
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child, true, globalPreemptible);
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
            backgroundJobBlockedByViewer(job)
                ? { ok: false, preempted: true, error: 'preempted by viewer playback before storyboard extraction' }
                : extractStoryboardSprite(
                url,
                ua,
                intervalSec,
                STORYBOARD_COLS,
                rows,
                outputPath,
                timeoutMs,
                uid,
                jobPrio(job) !== JOB_PRIORITY.viewer,
            ));
        if (!r.preempted) markStoryboardRun(url); // only a real provider read starts the cooldown
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
                if (backgroundJobBlockedByViewer(job)) {
                    ex = { ok: false, preempted: true, error: 'preempted by viewer playback before chunk extraction' };
                    break;
                }
                ex = await extractAudioWavChunks(
                    url,
                    ua,
                    index,
                    AUDIO_EXTRACT_TIMEOUT_MS,
                    uid,
                    TRANSCRIBE_CHUNK_SEC,
                    dir,
                    jobPrio(job) !== JOB_PRIORITY.viewer,
                );
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
            // The extraction ledger is preempted first. Do not spend another CPU-heavy Whisper
            // pass on an already-produced chunk while that viewer is now reading the same VOD.
            if (
                jobPrio(job) !== JOB_PRIORITY.viewer &&
                extractionSettled &&
                extractionResult.preempted
            ) {
                await extractionDone;
                return { jobId, requeue: true };
            }
            if (!announcedTranscribing) { announcedTranscribing = true; postJobHeartbeat(job, 'transcribing'); }
            try { totalAudioSec += (await fsp.stat(p)).size / (16000 * 2); } catch (_) { /* best-effort */ }
            const w = await runWhisperVtt(
                p,
                lang,
                CHUNK_WHISPER_TIMEOUT_MS,
                whisperOptionsForJob(job),
            );
            fsp.unlink(p).catch(() => {});
            if (w.preempted) {
                // /raw also kills the provider extraction for this account, so this settles
                // promptly. Re-queue without a failure callback; the gate resumes it later.
                await extractionDone;
                return { jobId, requeue: true };
            }
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
const ocrWakeState = createQueueWakeState();
function enqueueOcr(job) {
    if (ocrQueue.length >= MAX_OCR_QUEUE) return false;
    insertByPriority(ocrQueue, job);
    postJobHeartbeat(job, 'queued');
    wakeQueueDrain(ocrWakeState);
    queueMicrotask(drainOcrQueue);
    return true;
}
async function drainOcrQueue() {
    if (ocrBusy) return;
    ocrBusy = true;
    try {
        while (ocrQueue.length) {
            const wakeVersion = ocrWakeState.version;
            const job = await nextRunnableJob(ocrQueue, 'ocr');
            if (!job) {
                await waitForQueueWake(
                    ocrWakeState,
                    JOB_GATE_POLL_MS,
                    wakeVersion,
                );
                continue;
            }
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
function extractSubtitleSup(
    url,
    ua,
    trackIndex,
    timeoutMs = SUP_EXTRACT_TIMEOUT_MS,
    proxyKey = '',
    globalPreemptible = true,
) {
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
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child, true, globalPreemptible);
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            reg.release?.();
            resolve(reg.preempted
                ? { ok: false, preempted: true, error: 'preempted by viewer playback' }
                : { ok: false, error: String((e && e.message) || e) });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            reg.release?.();
            if (reg.preempted) {
                fsp.unlink(outputPath).catch(() => {});
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback' });
            }
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
function runOcrPython(supPath, lang, globalPreemptible = true) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(OCR_PYTHON_BIN, [OCR_SCRIPT], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
                detached: process.platform !== 'win32',
            });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const registration = registerBackgroundCpuProcess(child, globalPreemptible);
        let out = '', err = '';
        const timer = setTimeout(() => killBackgroundProcessTree(child), OCR_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            registration.release?.();
            resolve(registration.preempted
                ? { ok: false, preempted: true, error: 'preempted by viewer playback' }
                : { ok: false, error: String((e && e.message) || e) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            registration.release?.();
            if (registration.preempted) {
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback' });
            }
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
function extractSubtitleFrames(
    url,
    ua,
    trackIndex,
    timeoutMs = SUP_EXTRACT_TIMEOUT_MS,
    proxyKey = '',
    globalPreemptible = true,
) {
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
        try { child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], env: proxyEnvFor(proxyKeyFromUrl(url)) }); }
        catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const reg = registerAccountExtraction(proxyKeyFromUrl(url), child, true, globalPreemptible);
        let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        // showinfo is verbose (one line/frame) — keep the tail bounded but enough for a long film.
        child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 24_000_000) stderr = stderr.slice(-16_000_000); });
        child.on('error', (e) => {
            clearTimeout(timer);
            reg.release?.();
            resolve(reg.preempted
                ? { ok: false, preempted: true, error: 'preempted by viewer playback', dir }
                : { ok: false, error: String((e && e.message) || e), dir });
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            reg.release?.();
            if (reg.preempted) {
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback', dir });
            }
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
function runOcrImgsubPython(frameDir, lang, globalPreemptible = true) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(OCR_PYTHON_BIN, [OCR_SCRIPT_IMGSUB], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
                cwd: __dirname,
                detached: process.platform !== 'win32',
            });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + String((e && e.message) || e) }); }
        const registration = registerBackgroundCpuProcess(child, globalPreemptible);
        let out = '', err = '';
        const timer = setTimeout(() => killBackgroundProcessTree(child), OCR_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            registration.release?.();
            resolve(registration.preempted
                ? { ok: false, preempted: true, error: 'preempted by viewer playback' }
                : { ok: false, error: String((e && e.message) || e) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            registration.release?.();
            if (registration.preempted) {
                return resolve({ ok: false, preempted: true, error: 'preempted by viewer playback' });
            }
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
    const globalPreemptible = jobPrio(job) !== JOB_PRIORITY.viewer;
    let supPath = null, frameDir = null, payload;
    try {
        postJobHeartbeat(job, 'extracting');
        let ex = { ok: false, error: 'not attempted' };
        for (let attempt = 0; attempt <= OCR_EXTRACT_RETRIES; attempt++) {
            // Account lock per ATTEMPT (not around the loop): the 30/60 s backoff sleeps must not
            // hold the account's slot — another lane may legitimately use it between our tries.
            ex = await withAccountJobLock(accountJobKey(uid, url), () =>
                backgroundJobBlockedByViewer(job)
                    ? { ok: false, preempted: true, error: 'preempted by viewer playback before OCR extraction' }
                    : (useFrames
                        ? extractSubtitleFrames(url, ua, index, SUP_EXTRACT_TIMEOUT_MS, uid, globalPreemptible)
                        : extractSubtitleSup(url, ua, index, SUP_EXTRACT_TIMEOUT_MS, uid, globalPreemptible)));
            if (ex.ok) break;
            if (ex.dir) { fsp.rm(ex.dir, { recursive: true, force: true }).catch(() => {}); ex.dir = null; } // drop partial dir
            if (ex.preempted) break;
            if (/\b(401|403)\b|Unauthorized|Forbidden/i.test(ex.error || '')) break; // abuse/auth block — do not hammer
            if (attempt < OCR_EXTRACT_RETRIES) await sleep(OCR_EXTRACT_BACKOFF_MS * (attempt + 1)); // 30s, 60s — spaced, not a burst
        }
        // OCR demuxes the whole input too (`-c:s copy` walks the file) — same per-provider
        // cooldown as a transcription once the attempts are done.
        if (!ex.preempted) markTranscribeRun(url);
        if (ex.preempted) {
            payload = { requeue: true };
        } else if (!ex.ok) {
            payload = { jobId, ok: false, error: ('Subtitle extraction failed: ' + ex.error).slice(0, 300) };
        } else {
            let r;
            if (useFrames) {
                frameDir = ex.dir;
                r = await runOcrImgsubPython(frameDir, lang || OCR_LANGS, globalPreemptible);
            } else {
                supPath = ex.path;
                r = await runOcrPython(supPath, lang || OCR_LANGS, globalPreemptible);
            }
            if (r.preempted) {
                payload = { requeue: true };
            } else {
                const segments = r.ok ? (r.vtt.match(/-->/g) || []).length : 0;
                payload = (r.ok && segments > 0)
                    ? { jobId, ok: true, vtt: r.vtt, segments, sourceLang: null }
                    : { jobId, ok: false, error: String(r.error || 'OCR produced no cues').slice(0, 300) };
            }
        }
    } catch (e) {
        payload = { jobId, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    } finally {
        if (supPath) fsp.unlink(supPath).catch(() => {});
        if (frameDir) fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    }
    if (payload?.requeue) {
        console.log(`[media-gateway] ocr job ${jobId} preempted by viewer — re-queued`);
        postJobHeartbeat(job, 'deferred');
        insertByPriority(ocrQueue, job);
        return;
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
    const sessionCreateStartedAt = Date.now();
    sessionStartupStats.attempts += 1;
    let viewerStartupReservation = null;
    let viewerSessionStartupAdmission = null;
    let releaseViewerSessionStartupLock = null;
    let createdSession = null;
    let pendingOutputDir = null;
    let pendingMkvCompleteHlsCacheLease = null;
    let sessionRequestAbortController = null;
    let detachSessionRequestAbort = null;
    try {
        const {
            sourceUrl,
            playbackSessionId,
            ownerKey,
            mode = 'remux',
            expiresAt,
            userAgent,
            playbackHint,
            playbackIdentity,
            sourceContainerAuthority,
            codecProfile,
            audioCodec,
            audioProfile,
            audioChannels,
            audioStreamIndex,
            audio_stream_index,
            audioMode,
            videoCodec,
            clientAudioPassthrough,
            completeHlsCachePolicy,
            seekOffset,
            startOffset,
            resumeTime
        } = req.body || {};
        if (!sourceUrl || !isHttpUrl(sourceUrl)) {
            return res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
        }
        const normalizedSourceContainerAuthority = normalizeSourceContainerAuthority(
            sourceContainerAuthority,
            sourceUrl,
        );
        if (sourceContainerAuthority !== undefined && !normalizedSourceContainerAuthority) {
            return res.status(400).json({
                error: 'sourceContainerAuthority is invalid',
                code: 'SOURCE_CONTAINER_AUTHORITY_INVALID',
            });
        }

        const normalizedOwnerKey = normalizeSessionKey(ownerKey);
        const playbackProxyKey = proxyKeyFromUrl(sourceUrl);
        const playbackProviderSlotKey = providerSlotKeyFromUrl(sourceUrl, normalizedOwnerKey);
        // Observe abandonment before admission or lock allocation. A queued
        // browser navigation must release immediately rather than wait behind a
        // previous startup and keep shared QoS elevated.
        sessionRequestAbortController = new AbortController();
        const abortSessionRequest = () => {
            try { sessionRequestAbortController.abort(); } catch (_) {}
            if (createdSession) stopSession(createdSession).catch(() => {});
        };
        const onResponseClose = () => {
            if (!res.writableEnded) abortSessionRequest();
        };
        req.once('aborted', abortSessionRequest);
        res.once('close', onResponseClose);
        detachSessionRequestAbort = () => {
            req.off('aborted', abortSessionRequest);
            res.off('close', onResponseClose);
        };
        if (req.aborted || req.destroyed || res.destroyed || res.writableEnded) {
            abortSessionRequest();
            return;
        }
        viewerSessionStartupAdmission = tryAdmitViewerSessionStartup(
            normalizedOwnerKey,
            playbackProviderSlotKey,
        );
        if (!viewerSessionStartupAdmission) {
            res.setHeader('Retry-After', '2');
            return res.status(503).json({
                error: 'The media service is handling another playback startup. Try again shortly.',
                code: 'GATEWAY_STARTUP_BUSY',
            });
        }
        releaseViewerSessionStartupLock = await acquireViewerSessionStartupLocks(
            normalizedOwnerKey,
            playbackProviderSlotKey,
            sessionRequestAbortController.signal,
        );
        if (sessionRequestAbortController.signal.aborted) return;
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
        const normalizedCompleteHlsCachePolicy = completeHlsCachePolicy === 'bypass'
            ? 'bypass'
            : 'default';
        let normalizedCodecProfile = asRecord(codecProfile || normalizedPlaybackHint.codecProfile || normalizedPlaybackHint.codec_profile);
        let codecProfileSource = hasUsefulCodecProfile(normalizedCodecProfile) ? 'request' : '';
        const signedGatewayCachedProfile = cachedSignedMkvH264FastStartProfile(sourceUrl);
        if (signedGatewayCachedProfile) {
            normalizedCodecProfile = mergeCodecProfiles(normalizedCodecProfile, signedGatewayCachedProfile);
            codecProfileSource = codecProfileSource
                ? `${codecProfileSource}+gateway_signed_cache`
                : 'gateway_signed_cache';
        }
        const cacheLookupSession = {
            sourceUrl,
            ownerKey: normalizedOwnerKey,
            providerSlotKey: playbackProviderSlotKey,
            mode: mode === 'transcode' ? 'transcode' : 'remux',
            playbackHint: normalizedPlaybackHint,
            playbackIdentity: asRecord(playbackIdentity),
            seekOffset: normalizedSeekOffset,
            codecProfile: normalizedCodecProfile,
            codecProfileSource,
            audioCodec: stringOrNull(audioCodec) || stringOrNull(normalizedPlaybackHint.audioCodec) || stringOrNull(normalizedPlaybackHint.audio_codec) || stringOrNull(normalizedCodecProfile.audioCodec) || stringOrNull(normalizedCodecProfile.audio_codec) || stringOrNull(normalizedCodecProfile.audio),
            audioProfile: stringOrNull(audioProfile) || stringOrNull(normalizedPlaybackHint.audioProfile) || stringOrNull(normalizedPlaybackHint.audio_profile) || stringOrNull(normalizedCodecProfile.audioProfile) || stringOrNull(normalizedCodecProfile.audio_profile),
            audioChannels: nullableInt(audioChannels ?? normalizedPlaybackHint.audioChannels ?? normalizedPlaybackHint.audio_channels ?? normalizedCodecProfile.audioChannels ?? normalizedCodecProfile.audio_channels ?? normalizedCodecProfile.channels),
            audioStreamIndex: normalizeAudioStreamIndex(audioStreamIndex ?? audio_stream_index ?? normalizedPlaybackHint.audioStreamIndex ?? normalizedPlaybackHint.audio_stream_index),
            audioMode: stringOrNull(audioMode) || stringOrNull(normalizedPlaybackHint.audioMode) || stringOrNull(normalizedPlaybackHint.audio_mode),
            clientAudioPassthrough: clientAudioPassthrough === false || normalizedPlaybackHint.clientAudioPassthrough === false || normalizedPlaybackHint.client_audio_passthrough === false ? false : true,
            completeHlsCachePolicy: normalizedCompleteHlsCachePolicy,
        };
        // Authenticate and validate an immutable local hit before touching any
        // provider holder or background worker. A complete cache session owns
        // no provider socket and must not evict one merely to discover that hit.
        const completeHlsCacheLookup = await tryAcquireMkvCompleteHlsCache(cacheLookupSession);
        if (completeHlsCacheLookup.terminal === true) {
            return res.status(503).json({
                error: 'The cached media copy failed its integrity check.',
                code: 'COMPLETE_HLS_CACHE_INVALID',
            });
        }
        if (completeHlsCacheLookup.hit) {
            pendingMkvCompleteHlsCacheLease = completeHlsCacheLookup.lease;
        }
        if (sessionRequestAbortController.signal.aborted) throw new Error('Session request aborted');

        const cleanupStartedAt = Date.now();
        let stoppedConflictingSessions = 0;
        let globalBackgroundPreemptions = { extractions: 0, whispers: 0, cpu: 0 };
        let slotReleaseWaitMs = 0;
        if (!completeHlsCacheLookup.hit) {
            // Only a startup that will open provider/FFmpeg work reserves viewer
            // QoS and preempts the previous provider holder. Local cache playback
            // is deliberately invisible to those resource ledgers.
            viewerStartupReservation = reserveViewerStartup();
            // Stale engine byte-pipes on the same account hold the same provider slot as
            // the transcode about to start (the engine just failed over here) — abort them
            // like any other conflicting session so ffmpeg doesn't open against a 458.
            stoppedConflictingSessions += abortRawPumps(
                (p) => p.providerSlotKey === playbackProviderSlotKey,
                null,
                'transcode session start',
            );
            // A background extraction (whisper/storyboard) mid-film on this account would fight the
            // viewer for the single slot for MINUTES. Its already-produced WAV must not leave a
            // service/pregen Whisper process fighting the viewer for CPU either.
            const catalogRefreshExtractions = activeCatalogRefreshExtractionCount(playbackProxyKey);
            stoppedConflictingSessions += preemptAccountExtractions(playbackProxyKey, 'transcode session start');
            // CPU preemption does not hold a provider connection and must not trigger the provider
            // slot-release delay below.
            preemptAccountBackgroundWhispers(playbackProxyKey, 'transcode session start');
            globalBackgroundPreemptions = preemptBackgroundWorkGlobally(
                playbackProxyKey,
                'transcode session start',
            );

            // Different titles from the same credentials have different source URLs
            // but share one physical provider slot. Stop the previous account holder,
            // including its input pump, before any new provider I/O.
            stoppedConflictingSessions += await stopConflictingProviderSessions(playbackProviderSlotKey);

            if (STOP_CONFLICTING_OWNER_SESSIONS && normalizedOwnerKey) {
                stoppedConflictingSessions += await stopConflictingOwnerSessions(normalizedOwnerKey);
            }

            if (STOP_CONFLICTING_SOURCE_SESSIONS) {
                stoppedConflictingSessions += await stopConflictingSourceSessions(
                    sourceUrl,
                    playbackProviderSlotKey,
                );
            }

            const providerSlotReleaseDelayMs = catalogRefreshExtractions > 0
                ? Math.max(
                    PROVIDER_SLOT_RELEASE_DELAY_MS,
                    PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS,
                )
                : PROVIDER_SLOT_RELEASE_DELAY_MS;
            if (stoppedConflictingSessions > 0 && providerSlotReleaseDelayMs > 0) {
                console.log(`[media-gateway] waiting ${providerSlotReleaseDelayMs}ms for provider slot release after stopping ${stoppedConflictingSessions} session(s)`);
                slotReleaseWaitMs = providerSlotReleaseDelayMs;
                await sleep(providerSlotReleaseDelayMs);
            }
        }
        const cleanupMs = Math.max(0, Date.now() - cleanupStartedAt);

        const id = crypto.randomUUID();
        const accessToken = randomToken();
        const outputDir = resolveSessionDir(id);
        pendingOutputDir = outputDir;
        await fsp.mkdir(outputDir, { recursive: true });
        const sourceKey = sourceSessionKey(sourceUrl);

        const expiresAtDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
        const requestCodecProfileReliable = hasReliableVodCodecProfile(normalizedCodecProfile);
        // Freeze the long-GOP-safe route from the authenticated exact-file profile
        // before ffprobe or FFmpeg can open a provider connection. Profiles discovered
        // only by the Gateway probe are deliberately ineligible: switching after that
        // probe would spend a second provider connection on single-slot accounts.
        const forceExactMatroskaH264Reencode = shouldReencodeExactMatroskaH264({
            sourceUrl,
            codecProfile: normalizedCodecProfile,
            codecProfileSource,
            playbackHint: normalizedPlaybackHint,
        });
        const finiteMkvPlaybackAtRequest = isFiniteMkvVodSession({
            sourceUrl,
            playbackHint: normalizedPlaybackHint,
            codecProfile: normalizedCodecProfile,
            sourceContainerAuthority: normalizedSourceContainerAuthority,
        });
        let finiteMkvPlayback = finiteMkvPlaybackAtRequest;
        const shouldProbe = shouldProbeCodecProfile(normalizedPlaybackHint, sourceUrl);
        const shouldCompleteProfile = shouldProbe && shouldProbeMissingSubtitleTracks(normalizedCodecProfile, normalizedPlaybackHint, sourceUrl);
        const codecProfileStartedAt = Date.now();
        let codecProfileProbeRan = false;
        let codecProfileProbeReleaseWaitMs = 0;
        if (!completeHlsCacheLookup.hit && (!codecProfileSource || !requestCodecProfileReliable || shouldCompleteProfile) && shouldProbe) {
            codecProfileProbeRan = true;
            try {
                // A direct ffprobe on seekable Matroska can open a replacement
                // HTTP connection before closing the old one while following
                // SeekHead entries. On a mono-slot account that is itself a 458.
                // The playback lane therefore accepts only cache/in-band probe
                // data here; FFmpeg discovers any missing tracks from pipe:0.
                const probedCodecProfile = await probeCodecProfile(
                    sourceUrl,
                    sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT,
                    { localOnly: finiteMkvPlaybackAtRequest },
                );
                if (hasUsefulCodecProfile(probedCodecProfile)) {
                    normalizedCodecProfile = mergeCodecProfiles(normalizedCodecProfile, probedCodecProfile);
                    codecProfileSource = codecProfileSource ? `${codecProfileSource}+gateway_probe` : 'gateway_probe';
                }
            } catch (err) {
                rememberProbeFailure(err.message || String(err), sourceUrl);
                if (err?.status === 458 || err?.code === 'PROVIDER_BUSY') {
                    await removeSessionDir(outputDir).catch(() => {});
                    return res.status(458).json({
                        error: 'This TV service is busy. Wait a few seconds, then try again.',
                        code: 'PROVIDER_BUSY',
                        upstreamStatus: 458,
                    });
                }
                if (err?.code === 'PROXY_AUTH_FAILED') {
                    await removeSessionDir(outputDir).catch(() => {});
                    return res.status(502).json({
                        error: 'The media service is temporarily unavailable.',
                        code: 'PROXY_AUTH_FAILED',
                        networkCause: 'proxy_auth',
                    });
                }
                console.warn('[media-gateway] codec probe skipped:', sanitizeLog(err.message || String(err), sourceUrl));
            }
        }
        // Cache/in-band probing can be the first place an extensionless URL is
        // identified as Matroska. Re-evaluate the lane after merging that local
        // evidence so resume, video mode and the bounded input pump all make the
        // same decision. Requests that already declare MKV never run a seekable
        // provider ffprobe (`localOnly` above).
        finiteMkvPlayback = isFiniteMkvVodSession({
            sourceUrl,
            playbackHint: normalizedPlaybackHint,
            codecProfile: normalizedCodecProfile,
            sourceContainerAuthority: normalizedSourceContainerAuthority,
        });
        // probeCodecProfile may have used the exact provider URL (rather than its
        // cache or the in-band prefix). Waiting conservatively on every invocation
        // costs only startup latency and guarantees the panel has released its
        // logical mono-account slot before the size preflight or input pump opens.
        if (codecProfileProbeRan && !finiteMkvPlaybackAtRequest && PROVIDER_SLOT_RELEASE_DELAY_MS > 0) {
            await sleep(PROVIDER_SLOT_RELEASE_DELAY_MS);
            codecProfileProbeReleaseWaitMs = PROVIDER_SLOT_RELEASE_DELAY_MS;
            slotReleaseWaitMs += PROVIDER_SLOT_RELEASE_DELAY_MS;
        }
        if (sessionRequestAbortController.signal.aborted) throw new Error('Session request aborted');
        const codecProfileMs = Math.max(0, Date.now() - codecProfileStartedAt);
        const session = {
            id,
            playbackSessionId: playbackSessionId || null,
            sourceUrl,
            sourceKey,
            ownerKey: normalizedOwnerKey,
            providerSlotKey: playbackProviderSlotKey,
            mode: mode === 'transcode' ? 'transcode' : 'remux',
            userAgent: sanitizeUserAgent(userAgent),
            playbackHint: normalizedPlaybackHint,
            playbackIdentity: asRecord(playbackIdentity),
            sourceContainerAuthority: normalizedSourceContainerAuthority,
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
            completeHlsCachePolicy: normalizedCompleteHlsCachePolicy,
            forceExactMatroskaH264Reencode,
            mkvH264FastStart: null,
            startupPolicy: null,
            videoMode: null,
            videoModeReason: null,
            hlsTargetSeconds: forceExactMatroskaH264Reencode
                ? EXACT_MATROSKA_H264_HLS_TARGET_SECONDS
                : 4,
            minHlsStartupBufferSeconds: MIN_HLS_STARTUP_BUFFER_SECONDS,
            minHlsStartupSegments: MIN_HLS_STARTUP_SEGMENTS,
            status: 'starting',
            outputDir,
            playlistPath: path.join(outputDir, 'playlist.m3u8'),
            accessToken,
            createdAt: new Date(),
            lastClientAccessAtMs: Date.now(),
            expiresAt: expiresAtDate,
            ffmpeg: null,
            inputPump: null,
            finiteMkvSeekBroker: null,
            inputFailure: null,
            vodInputValidator: null,
            completeHlsCacheLease: completeHlsCacheLookup.hit ? completeHlsCacheLookup.lease : null,
            completeHlsCacheBinding: completeHlsCacheLookup.hit ? completeHlsCacheLookup.assessment.binding : null,
            completeHlsCacheRootPlaylist: completeHlsCacheLookup.hit ? completeHlsCacheLookup.lease.rootPlaylist : null,
            completeHlsCachePromotionPromise: null,
            completeHlsCacheMediaReady: false,
            completeHlsCacheProfileReady: false,
            completeHlsCacheFfmpegCompletedCleanly: false,
            mkvCompleteHlsCacheProofFinalized: false,
            backgroundCacheContinuation: false,
            backgroundCacheContinuationStartedAtMs: null,
            backgroundCacheContinuationDeadlineMs: null,
            backgroundCacheContinuationTimer: null,
            backgroundCacheContinuationPromise: null,
            backgroundCacheContinuationOutcome: null,
            backgroundCacheContinuationProviderDrained: false,
            assetSource: completeHlsCacheLookup.hit ? 'complete-hls-cache' : 'session-output',
            lastError: null,
            logTail: '',
            startupTimings: {
                cleanupMs,
                slotReleaseWaitMs,
                stoppedConflictingSessions,
                globalBackgroundExtractionPreemptions: globalBackgroundPreemptions.extractions,
                globalBackgroundWhisperPreemptions: globalBackgroundPreemptions.whispers,
                globalBackgroundCpuPreemptions: globalBackgroundPreemptions.cpu,
                codecProfileMs,
                codecProfileProbeRan,
                codecProfileProbeReleaseWaitMs,
                boundedMkvInputPump: false,
                fileSizeBytes: null,
                fileSizeProbeRan: false,
                fileSizeProbeMs: 0,
                fileSizeProbeReleaseWaitMs: 0,
                ffmpegReadyMs: null,
                playlistSegmentCount: 0,
                playlistBufferSeconds: 0,
                firstSegmentBytes: 0,
                playlistSegmentBytes: 0,
                startOffsetProbeMs: null,
                totalMs: null,
                ffmpegSpawnCount: 0,
                analyzerSpawnCount: 0
            }
        };

        if (completeHlsCacheLookup.hit) {
            createdSession = session;
            pendingMkvCompleteHlsCacheLease = null;
            const h264ProofMetrics = asRecord(completeHlsCacheLookup.assessment.proof?.metrics);
            session.mkvH264FastStart = completeHlsCacheLookup.assessment.proof?.scope === 'full-file'
                ? {
                    protocol: MKV_H264_FAST_START_PROTOCOL,
                    eligible: true,
                    reason: 'full-file-proof-accepted',
                    proof: {
                        protocol: MKV_H264_FAST_START_PROTOCOL,
                        scope: 'full-file',
                        profileFingerprint: completeHlsCacheLookup.assessment.context.profileFingerprint,
                        fileSizeBytes: completeHlsCacheLookup.assessment.context.fileSizeBytes,
                        coverageSeconds: h264ProofMetrics.coverageSeconds,
                        maxKeyframeGapSeconds: h264ProofMetrics.maxKeyframeGapSeconds,
                        idrCount: h264ProofMetrics.idrCount,
                        closedGopIdrVerified: true,
                        timestampsSafe: true,
                    },
                }
                : {
                    protocol: MKV_H264_FAST_START_PROTOCOL,
                    eligible: false,
                    reason: 'complete-hls-cache-hit',
                    proof: null,
                };
            session.mkvH264FastStartAudioAuthority = true;
            session.forceMkvH264FastStartAudioTranscode = false;
            freezeMultiAudioHlsTopology(session);
            session.videoMode = 'copy';
            session.videoModeReason = 'complete_hls_cache_hit';
            // The cached playlist covers the complete movie from t=0. Expose
            // the requested resume as a local HLS seek instead of pretending
            // this zero-provider session was transcoded from that offset.
            session.actualStartOffset = 0;
            session.localSeekTarget = Math.max(0, Number(session.seekOffset) || 0);
            session.sourceTimestamps = session.localSeekTarget > 0;
            session.status = 'ready';
            session.startupTimings.fileSizeBytes = completeHlsCacheLookup.assessment.context.fileSizeBytes;
            session.startupTimings.ffmpegReadyMs = 0;
            session.startupTimings.mediaProductionRateX = 20;
            session.startupTimings.completeHlsCacheHit = true;
            session.startupTimings.completeHlsCacheLocalSeek = session.localSeekTarget > 0;
            session.startupTimings.providerGetCount = 0;
            session.startupTimings.ffmpegSpawnCount = 0;
            session.startupTimings.totalMs = Math.max(0, Date.now() - sessionCreateStartedAt);
            session.startupPolicy = {
                protocol: MKV_H264_FAST_START_PROTOCOL,
                eligible: true,
                pipeline: 'copy',
                targetBufferSeconds: MKV_H264_FAST_START_BUFFER_SECONDS,
                minimumEncodeRateX: MKV_H264_FAST_START_MIN_ENCODE_RATE_X,
                observedEncodeRateX: 20,
                reason: 'complete-hls-cache-hit',
            };
            sessions.set(id, session);
            sessionStartupStats.successes += 1;
            sessionStartupStats.totalMs += session.startupTimings.totalMs;
            sessionStartupStats.last = {
                ...session.startupTimings,
                codecProfileSource: session.codecProfileSource || null,
                seek: false,
                at: new Date().toISOString(),
            };
            return res.status(201).json(gatewayCreatedSessionPayload(req, session));
        }

        // This panel accepts only bounded ranges (`bytes=N-M`). Resolve the exact
        // terminal byte before the single-socket input pump is allowed to feed
        // FFmpeg. FFmpeg itself never sees the provider URL on this lane.
        try {
            await ensureBoundedMkvInputPump(session, sessionRequestAbortController.signal);
        } catch (err) {
            if (sessionRequestAbortController.signal.aborted) throw err;
            await removeSessionDir(outputDir).catch(() => {});
            if (err?.status === 458 || err?.code === 'PROVIDER_BUSY') {
                return res.status(458).json({
                    error: 'This TV service is busy. Wait a few seconds, then try again.',
                    code: 'PROVIDER_BUSY',
                    upstreamStatus: 458,
                });
            }
            if (err?.code === 'PROXY_AUTH_FAILED') {
                return res.status(502).json({
                    error: 'The media service is temporarily unavailable.',
                    code: 'PROXY_AUTH_FAILED',
                    networkCause: 'proxy_auth',
                });
            }
            if (err?.code === 'SOURCE_CONTAINER_MISMATCH' && err?.details?.protocol === 1) {
                return res.status(409).json(err.details);
            }
            console.warn('[media-gateway] unable to bound finite MKV input:', sanitizeLog(err?.message || String(err), sourceUrl));
            return res.status(502).json({
                error: 'Unable to prepare this media file for reliable playback.',
                code: err?.code || 'VOD_SIZE_UNAVAILABLE',
            });
        }
        // From this point the session owns an open provider body even though it
        // is not yet published in `sessions`. Outer error handling must stop it
        // if topology freezing or FFmpeg setup throws.
        createdSession = session;

        if (finiteMkvPlayback && normalizedSeekOffset > 0) {
            await prepareFiniteMkvSeekBroker(
                session,
                sessionRequestAbortController.signal,
            );
        }

        // The exact size preflight above is provider I/O, but it neither starts
        // the byte pump nor spawns FFmpeg. Freeze the rendition graph only now:
        // ensureBoundedMkvInputPump has attached the exact fileSizeBytes to an
        // otherwise complete request/cached profile, making the normal Norva
        // exact-profile path reachable without ever mutating a running graph.
        freezeMultiAudioHlsTopology(session);
        const fastStartAssessment = freezeMkvH264FastStart(session);

        const finiteMkvH264RequiresProof = Boolean(
            finiteMkvPlayback && shouldCopyVideo(session) && fastStartAssessment.eligible !== true
        );
        session.videoMode = (
            session.forceAlignedMultiAudioVideoEncode === true ||
            finiteMkvH264RequiresProof ||
            session.mode === 'transcode' ||
            !shouldCopyVideo(session) ||
            (finiteMkvPlayback && normalizedSeekOffset > 0)
        ) ? 'encode' : 'copy';
        session.videoModeReason = session.forceAlignedMultiAudioVideoEncode === true
            ? 'multi_audio_aligned_hls'
            : (fastStartAssessment.eligible === true
                ? 'mkv_h264_fast_start_copy'
            : (finiteMkvH264RequiresProof
                ? 'finite_mkv_h264_requires_full_proof'
            : (session.mode === 'transcode'
                ? 'requested_transcode'
                : (finiteMkvPlayback && normalizedSeekOffset > 0
                    ? 'seekable_matroska_resume'
                    : (session.videoMode === 'encode' ? 'unsafe_or_unknown_video' : 'copy')))));
        session.hlsCacheDescriptor = session.videoMode === 'copy'
            ? mkvH264HlsCacheDescriptorForSession(session)
            : null;

        sessions.set(id, session);

        const ffmpegStartedAt = Date.now();
        session.hlsCacheProductionStartedAtMs = ffmpegStartedAt;
        const started = await startSessionWithProviderRetry(
            session,
            sessionRequestAbortController.signal,
        );
        if (sessionRequestAbortController.signal.aborted) throw new Error('Session request aborted');
        session.startupTimings.ffmpegReadyMs = Math.max(0, Date.now() - ffmpegStartedAt);
        session.startupTimings.mediaProductionRateX = observedMediaProductionRateX(session);
        if (!started) {
            const detail = session.lastError || 'Playlist was not generated';
            rememberFailure(session, detail);
            await stopSession(session);
            // A proxy 407 is infrastructure authentication failure, never evidence that
            // the IPTV account is active elsewhere. Keep it out of the provider 458 circuit.
            if (session.inputFailure?.code === 'PROXY_AUTH_FAILED' || isProxyAuthenticationFailure(session)) {
                return res.status(502).json({
                    error: 'The media service is temporarily unavailable.',
                    code: 'PROXY_AUTH_FAILED',
                    networkCause: 'proxy_auth',
                });
            }
            // Slot-busy upstream is terminal. Preserve the exact 458 so callers open
            // the account circuit instead of treating it as a retryable gateway 503.
            if (session.inputFailure?.code === 'PROVIDER_BUSY' || isProviderSlotBusyFailure(session)) {
                return res.status(458).json({
                    error: 'This TV service is busy. Wait a few seconds, then try again.',
                    code: 'PROVIDER_BUSY',
                    upstreamStatus: 458,
                });
            }
            return res.status(502).json({
                error: 'Failed to start media session',
                details: detail
            });
        }
        // The pump has already forwarded several megabytes by the time the HLS
        // readiness buffer exists. Parse that local prefix now, while retaining
        // the same provider socket, so the 201 response carries duration and all
        // audio tracks even on a cold exact-file cache.
        await enrichSessionCodecProfileFromBoundedHeader(
            session,
            sessionRequestAbortController.signal,
        );
        if (sessionRequestAbortController.signal.aborted) throw new Error('Session request aborted');
        const startOffsetProbeStartedAt = Date.now();
        await observeSessionStartOffset(session);
        if (sessionRequestAbortController.signal.aborted) throw new Error('Session request aborted');
        session.startupTimings.startOffsetProbeMs = Math.max(0, Date.now() - startOffsetProbeStartedAt);
        session.startupTimings.totalMs = Math.max(0, Date.now() - sessionCreateStartedAt);
        session.startupTimings.inputProbeMode = session.fastInputProbe === true ? 'known-fast' : 'full';
        session.startupTimings.fastInputProbeFallbacks = Number(session.fastInputProbeFallbacks || 0);
        session.startupPolicy = startupPolicyForSession(session);
        // Cache publication is a two-barrier operation. A short source can
        // finish on VAAPI before the local header probe above has replaced the
        // request profile. Never sign the pre-enrichment profile in that race.
        session.completeHlsCacheProfileReady = true;
        scheduleMkvCompleteHlsCachePromotion(session);
        sessionStartupStats.successes += 1;
        sessionStartupStats.totalMs += session.startupTimings.totalMs;
        if (session.fastInputProbe === true) sessionStartupStats.fastInputProbeSuccesses += 1;
        sessionStartupStats.last = {
            ...session.startupTimings,
            codecProfileSource: session.codecProfileSource || null,
            seek: Number(session.seekOffset) > 0,
            at: new Date().toISOString()
        };
        console.log(`[media-gateway] session ${id} ready`, JSON.stringify(sessionStartupStats.last));

        res.status(201).json(gatewayCreatedSessionPayload(req, session));
    } catch (err) {
        pendingMkvCompleteHlsCacheLease?.release?.();
        pendingMkvCompleteHlsCacheLease = null;
        if (sessionRequestAbortController?.signal.aborted) {
            if (createdSession) {
                await stopSession(createdSession).catch(() => {});
            } else if (pendingOutputDir) {
                await removeSessionDir(pendingOutputDir).catch(() => {});
            }
            return;
        }
        if (err?.code === 'VIEWER_STARTUP_BUSY') {
            res.setHeader('Retry-After', '2');
            if (!res.headersSent) {
                res.status(503).json({
                    error: 'The media service is handling another playback startup. Try again shortly.',
                    code: 'GATEWAY_STARTUP_BUSY',
                });
            }
            return;
        }
        if (err?.code === 'VIDEO_ENCODER_CAPACITY_BUSY') {
            if (createdSession) {
                await stopSession(createdSession).catch(() => {});
            } else if (pendingOutputDir) {
                await removeSessionDir(pendingOutputDir).catch(() => {});
            }
            res.setHeader('Retry-After', '5');
            if (!res.headersSent) {
                res.status(503).json({
                    error: 'The media service is at its safe video conversion capacity. Try again shortly.',
                    code: 'VIDEO_ENCODER_CAPACITY_BUSY',
                });
            }
            return;
        }
        console.error('[media-gateway] create session failed:', err);
        if (createdSession) {
            await stopSession(createdSession).catch(() => {});
        } else if (pendingOutputDir) {
            await removeSessionDir(pendingOutputDir).catch(() => {});
        }
        if (!res.headersSent) res.status(500).json({ error: 'Failed to create media session' });
    } finally {
        detachSessionRequestAbort?.();
        releaseViewerSessionStartupLock?.();
        releaseViewerSessionStartupAdmission(viewerSessionStartupAdmission);
        releaseViewerStartup(viewerStartupReservation);
    }
});

function gatewayCreatedSessionPayload(req, session) {
    return {
        id: session.id,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        videoMode: videoModeForSession(session),
        videoModeReason: session.videoModeReason,
        hlsTargetSeconds: session.hlsTargetSeconds,
        audioStreamIndex: mappedAudioStreamIndexForSession(session),
        audioRenditions: audioRenditionsForSession(session),
        multiAudioHls: multiAudioHlsDiagnosticsForSession(session),
        requestedSeekOffset: session.seekOffset || 0,
        actualStartOffset: session.actualStartOffset || 0,
        localSeekTarget: session.localSeekTarget || 0,
        sourceTimestamps: session.sourceTimestamps === true,
        codecProfile: publicMkvCodecProfile(session.codecProfile),
        codecProfileSource: session.codecProfileSource || null,
        startupPolicy: session.startupPolicy,
        startupTimings: session.startupTimings,
        hlsUrl: publicUrl(req, `/sessions/${session.id}/playlist.m3u8?token=${encodeURIComponent(session.accessToken)}`),
        expiresAt: session.expiresAt.toISOString(),
    };
}

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

function privateFinalCodecProfileForSession(session) {
    const finalEnvelope = mkvH264FastStartProofForProfile(session?.codecProfile);
    const finalProofAccepted = session?.mkvH264FastStartProofFinalized === true &&
        finalEnvelope && openMkvH264FastStartProof(finalEnvelope);
    const finalCacheEnvelope = mkvCompleteHlsCacheProofForProfile(session?.codecProfile);
    const finalCacheProofAccepted = session?.mkvCompleteHlsCacheProofFinalized === true &&
        finalCacheEnvelope && openMkvCompleteHlsCacheProof(finalCacheEnvelope);
    if (!hasUsefulCodecProfile(session?.codecProfile)) return null;
    return (finalProofAccepted || finalCacheProofAccepted)
        ? session.codecProfile
        : publicMkvCodecProfile(session.codecProfile);
}

app.delete('/sessions/:id', requireGatewayAuth, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await session.completeHlsCachePromotionPromise?.catch(() => null);
    const finalCodecProfile = privateFinalCodecProfileForSession(session);
    const continuationRequested = String(
        req.query?.completeCache ?? req.query?.complete_cache ?? '',
    ).trim().toLowerCase() === 'continue';
    if (!finalCodecProfile?.mkvCompleteHlsCacheProof && continuationRequested) {
        const continuation = startMkvCompleteHlsBackgroundContinuation(session);
        if (continuation.started === true) {
            return res.status(202).json({
                success: true,
                finalCodecProfile: null,
                completeCacheContinuation: {
                    protocol: 1,
                    state: 'running',
                    deadlineAt: continuation.deadlineAt,
                },
            });
        }
    }
    await stopSession(session);
    res.json(compactRecord({ success: true, finalCodecProfile }));
});

app.get('/sessions/:id/playlist.m3u8', requirePlaybackToken, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    touchViewerSessionClientAccess(session);

    try {
        if (session.lastError) throw new Error(session.lastError);
        if (session.status === 'starting') {
            await waitForPlaylist(session, PLAYLIST_REQUEST_TIMEOUT_MS);
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        let playlist;
        if (session.completeHlsCacheLease) {
            const handle = await session.completeHlsCacheLease.openAsset(
                session.completeHlsCacheRootPlaylist || 'playlist.m3u8',
            );
            try {
                playlist = await handle.readFile('utf8');
            } finally {
                await handle.close().catch(() => {});
            }
        } else {
            playlist = await fsp.readFile(session.playlistPath, 'utf8');
        }
        res.send(rewritePlaylistSegments(playlist, session.accessToken, session));
    } catch (err) {
        if (session.completeHlsCacheLease) {
            failMkvCompleteHlsCacheSession(session, err);
        }
        const status = session.inputFailure?.status === 458
            ? 458
            : (session.lastError ? 502 : 202);
        res.status(status).send(session.lastError || 'Playlist is not ready yet');
    }
});

app.get('/sessions/:id/:file', requirePlaybackToken, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    touchViewerSessionClientAccess(session);

    const requested = safeSessionArtifactName(req.params.file);
    if (!requested) return res.status(400).send('Invalid segment path');
    if (requested.toLowerCase().endsWith('.m3u8') && !isAllowedSessionPlaylistName(session, requested)) {
        return res.status(404).send('Segment not found');
    }
    try {
        res.setHeader('Content-Type', segmentContentType(requested));
        if (session.completeHlsCacheLease) {
            const handle = await session.completeHlsCacheLease.openAsset(requested);
            if (requested.toLowerCase().endsWith('.m3u8')) {
                try {
                    const playlist = await handle.readFile('utf8');
                    res.setHeader('Cache-Control', 'no-store');
                    return res.send(rewritePlaylistSegments(playlist, session.accessToken, session));
                } finally {
                    await handle.close().catch(() => {});
                }
            }
            res.setHeader('Cache-Control', 'private, max-age=30');
            const stream = handle.createReadStream({ autoClose: true });
            stream.once('error', (error) => {
                failMkvCompleteHlsCacheSession(session, error);
                if (!res.headersSent) res.status(502).send('Cached media is unavailable');
                else res.destroy(error);
            });
            res.once('close', () => {
                if (!stream.destroyed) stream.destroy();
            });
            stream.pipe(res);
            return;
        }
        const filePath = path.resolve(session.outputDir, requested);
        if (!isWithin(session.outputDir, filePath)) return res.status(400).send('Invalid segment path');
        if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');
        if (requested.toLowerCase().endsWith('.m3u8')) {
            // Every child playlist is an authenticated resource graph. Rewrite
            // its media/segment URIs exactly like the master; serving it raw
            // would drop the playback token on the very next hls.js request.
            const playlist = await fsp.readFile(filePath, 'utf8');
            res.setHeader('Cache-Control', 'no-store');
            return res.send(rewritePlaylistSegments(playlist, session.accessToken, session));
        }
        res.setHeader('Cache-Control', 'private, max-age=30');
        return res.sendFile(filePath);
    } catch (error) {
        if (session.completeHlsCacheLease) {
            failMkvCompleteHlsCacheSession(session, error);
            return res.status(502).send('Cached media is unavailable');
        }
        return res.status(404).send('Segment not found');
    }
});

function failMkvCompleteHlsCacheSession(session, error) {
    if (!session?.completeHlsCacheLease || session.completeHlsCacheFailed === true) return;
    session.completeHlsCacheFailed = true;
    session.lastError = 'COMPLETE_HLS_CACHE_ASSET_INVALID';
    mkvCompleteHlsCacheStats.corruptions += 1;
    try {
        mkvCompleteHlsCache?.quarantine(session.completeHlsCacheLease.key).catch(() => {});
    } catch (_) {}
    const code = String(error?.code || 'invalid-asset').slice(0, 80);
    console.warn(`[media-gateway] complete HLS cache session ${session.id} terminated (${code})`);
    setImmediate(() => stopSession(session).catch(() => {}));
}

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
    if (isProxyAuthenticationFailure(session)) return false;
    if (session?.inputFailure?.code) return session.inputFailure.code === 'PROVIDER_BUSY';
    const text = String((session && session.lastError) || '').toLowerCase();
    if (!text) return false;
    return text.includes('458')
        || text.includes('max connection')
        || text.includes('429')
        || text.includes('too many requests')
        || text.includes('4xx client error, but not one of');
}

// Start FFmpeg and wait for the first playlist. Provider/account failures are
// terminal. The only second attempt is a local demux probe-budget correction for
// an already-known file profile; it is not a gateway/direct or account retry.
async function startSessionWithProviderRetry(session, abortSignal = null) {
    // A known-profile probe fallback is a local demux retry, not a provider
    // concurrency failure. Give it one separate attempt so it cannot consume
    // a provider/account retry budget.
    const maxTotalAttempts = 2;
    for (let totalAttempt = 1; totalAttempt <= maxTotalAttempts; totalAttempt += 1) {
        if (abortSignal?.aborted) throw abortedVodInputPumpError();
        if (totalAttempt > 1) {
            const stoppedProviderPump = Boolean(session.inputPump);
            await stopBoundedMkvInputPump(session).catch(() => {});
            await stopChildProcess(session.ffmpeg).catch(() => {});
            session.ffmpeg = null;
            if (stoppedProviderPump && PROVIDER_SLOT_RELEASE_DELAY_MS > 0) {
                if (!await waitForVodInputRetry(PROVIDER_SLOT_RELEASE_DELAY_MS, abortSignal)) {
                    throw abortedVodInputPumpError();
                }
                session.startupTimings.inputProbeFallbackReleaseWaitMs = PROVIDER_SLOT_RELEASE_DELAY_MS;
                session.startupTimings.slotReleaseWaitMs = Number(session.startupTimings.slotReleaseWaitMs || 0)
                    + PROVIDER_SLOT_RELEASE_DELAY_MS;
            }
            await removeSessionDir(session.outputDir).catch(() => {});
            await fsp.mkdir(session.outputDir, { recursive: true }).catch(() => {});
            session.status = 'starting';
            session.lastError = null;
            session.inputFailure = null;
            session.logTail = '';
        }
        if (abortSignal?.aborted) throw abortedVodInputPumpError();
        session.ffmpeg = startFfmpeg(session);
        try {
            await waitForPlaylist(session, STARTUP_TIMEOUT_MS, abortSignal);
            if (session.status === 'starting') session.status = 'ready';
            return true;
        } catch (err) {
            if (abortSignal?.aborted) throw abortedVodInputPumpError();
            applyFiniteMkvSeekBrokerFailure(session);
            if (
                !session.inputFailure
                &&
                session.fastInputProbe === true
                && session.forceFullInputProbe !== true
                && isInsufficientInputProbeFailure(session)
            ) {
                session.forceFullInputProbe = true;
                session.fastInputProbeFallbacks = Number(session.fastInputProbeFallbacks || 0) + 1;
                sessionStartupStats.fastInputProbeFallbacks += 1;
                console.warn(`[media-gateway] known-profile input probe was insufficient for ${session.id}; retrying once with the full VOD probe budget`);
                continue;
            }
            return false;
        }
    }
    return false;
}

function normalizeFileSizeBytes(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function fileSizeBytesForSession(session) {
    const profile = asRecord(session?.codecProfile);
    for (const candidate of [
        session?.fileSizeBytes,
        profile.fileSizeBytes,
        profile.file_size_bytes,
        profile.formatSizeBytes,
        profile.format_size_bytes,
    ]) {
        const normalized = normalizeFileSizeBytes(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function normalizeSourceContainerAuthority(value, sourceUrl) {
    const record = asRecord(value);
    if (!exactRecordKeys(record, [
        'protocol',
        'container',
        'sourceUrlSha256',
        'evidenceKind',
        'prefixSha256',
    ])) return null;
    const container = normalizeCodecToken(record.container);
    if (!['mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg'].includes(container)) return null;
    const sourceUrlSha256 = String(record.sourceUrlSha256 || '').trim().toLowerCase();
    const prefixSha256 = String(record.prefixSha256 || '').trim().toLowerCase();
    const evidenceKind = String(record.evidenceKind || '').trim();
    const expectedEvidenceKind = {
        mkv: 'ebml-v1',
        mp4: 'iso-bmff-ftyp-v1',
        mov: 'iso-bmff-ftyp-v1',
        avi: 'riff-avi-v1',
        ogg: 'ogg-v1',
        flv: 'flv-v1',
        mpg: 'mpeg-ps-v1',
        mpeg: 'mpeg-ps-v1',
    }[container];
    if (
        record.protocol !== 1 ||
        !/^[0-9a-f]{64}$/.test(sourceUrlSha256) ||
        sourceUrlSha256 !== sha256Hex(String(sourceUrl || '')) ||
        !/^[0-9a-f]{64}$/.test(prefixSha256) ||
        evidenceKind !== expectedEvidenceKind
    ) return null;
    return { protocol: 1, container, sourceUrlSha256, evidenceKind, prefixSha256 };
}

function isFiniteMkvVodSession(session) {
    if (!session || isLiveSession(session)) return false;
    const sourceContainerAuthority = asRecord(session.sourceContainerAuthority);
    const authoritativeContainer = normalizeCodecToken(sourceContainerAuthority.container);
    if (authoritativeContainer) {
        return authoritativeContainer === 'mkv' || authoritativeContainer.includes('matroska');
    }
    const hint = asRecord(session.playbackHint);
    const profile = asRecord(session.codecProfile);
    const containers = [hint.container, profile.container].map(normalizeCodecToken);
    if (containers.some((container) => container === 'mkv' || container.includes('matroska'))) return true;
    try {
        return path.extname(new URL(session.sourceUrl).pathname).toLowerCase() === '.mkv';
    } catch (_) {
        return false;
    }
}

function parseProviderFileSize(response) {
    const contentRange = String(response?.headers?.get?.('content-range') || '').trim();
    // A 200/Content-Length is intentionally rejected: it proves this origin
    // ignored the bounded request, so exact-offset pumping would not be safe.
    if (Number(response?.status) !== 206) return null;
    const rangeMatch = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange);
    return normalizeFileSizeBytes(rangeMatch?.[1]);
}

// Some panels report the single-slot "busy" state as HTTP 200 HTML/JSON.
// Inspect only a tiny text-shaped prefix, then synchronously cancel/release the
// reader so classification can never leave a provider socket overlapping the
// next attempt. Binary prefixes are never interpreted as provider errors.
async function responseHasProviderBusyPrefix(response, signal = null, timeoutMs = VOD_INPUT_IDLE_TIMEOUT_MS) {
    if (!response?.body || typeof response.body.getReader !== 'function') return false;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || VOD_INPUT_IDLE_TIMEOUT_MS);
    try {
        while (total < RAW_PREFIX_SNIFF_BYTES) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            const next = await readRawPrefixChunk(reader, signal, remainingMs);
            if (next.aborted || signal?.aborted) throw abortedVodInputPumpError();
            if (next.timedOut || next.error || next.done) break;
            const value = next.value;
            const available = Number(value?.byteLength || value?.length || 0);
            if (!available) continue;
            const take = Math.min(available, RAW_PREFIX_SNIFF_BYTES - total);
            let part;
            if (ArrayBuffer.isView(value)) {
                part = Buffer.from(value.buffer, value.byteOffset, take);
            } else {
                part = Buffer.from(value).subarray(0, take);
            }
            chunks.push(Buffer.from(part));
            total += take;
            const prefix = Buffer.concat(chunks, total);
            if (looksLikeTextStart(prefix) && isProviderBusyText(normalizedRawTextPrefix(prefix))) {
                return true;
            }
        }
        return false;
    } finally {
        try { await reader.cancel(); } catch (_) {}
        try { reader.releaseLock(); } catch (_) {}
    }
}

async function responseBodyIsExactlyOneByte(response) {
    if (!response?.body || typeof response.body.getReader !== 'function') return false;
    const reader = response.body.getReader();
    let total = 0;
    try {
        while (total <= 1) {
            const { value, done } = await reader.read();
            if (done) return total === 1;
            total += Number(value?.byteLength || value?.length || 0);
            if (total > 1) return false;
        }
        return false;
    } finally {
        // This is a mono-slot barrier, not best-effort cleanup: wait until the
        // one-byte reader is cancelled/released before another provider request.
        try { await reader.cancel(); } catch (_) {}
        try { reader.releaseLock(); } catch (_) {}
    }
}

async function probeProviderFileSize(sourceUrl, userAgent, parentSignal = null) {
    const controller = new AbortController();
    const onParentAbort = () => {
        try { controller.abort(parentSignal?.reason); } catch (_) {}
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal?.aborted) onParentAbort();
    const timer = setTimeout(() => controller.abort(), VOD_FILE_SIZE_PROBE_TIMEOUT_MS);
    let response = null;
    try {
        response = await fetch(sourceUrl, {
            method: 'GET',
            headers: {
                Range: 'bytes=0-0',
                Accept: '*/*',
                'Accept-Encoding': 'identity',
                'User-Agent': userAgent || FFMPEG_USER_AGENT,
                Connection: 'close',
            },
            redirect: 'follow',
            signal: controller.signal,
            dispatcher: pickProxyAgent(proxyKeyFromUrl(sourceUrl)) || undefined,
        });
        if (!response.ok) {
            const failure = classifyProviderResponseFailure(response.status, {}, {
                proxyConfigured: providerProxyAgents.length > 0,
            });
            const error = new Error(failure.publicMessage);
            error.status = failure.status;
            error.code = failure.code;
            error.upstreamStatus = response.status;
            throw error;
        }
        const fileSizeBytes = parseProviderFileSize(response);
        if (!fileSizeBytes) {
            if (await responseHasProviderBusyPrefix(
                response,
                controller.signal,
                VOD_FILE_SIZE_PROBE_TIMEOUT_MS,
            )) {
                throw providerBusyVodInputError(response.status);
            }
            const error = new Error('Provider did not honor the exact bounded file-size request');
            error.status = 502;
            error.code = 'RANGE_UNSUPPORTED';
            throw error;
        }
        if (!await responseBodyIsExactlyOneByte(response)) {
            const error = new Error('Provider returned an invalid bounded file-size response body');
            error.status = 502;
            error.code = 'RANGE_UNSUPPORTED';
            throw error;
        }
        return fileSizeBytes;
    } catch (err) {
        if (err?.status || err?.code === 'VOD_SIZE_UNAVAILABLE' || err?.code === 'RANGE_UNSUPPORTED') throw err;
        const failure = classifyProviderFetchFailure(err);
        const error = new Error('Unable to resolve the media file size');
        error.status = err?.name === 'AbortError' ? 504 : 502;
        error.code = failure.code;
        error.networkCause = failure.category;
        throw error;
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onParentAbort);
        // Fetch resolves on headers. Abort and await body cancellation before
        // returning so the input pump cannot overlap this preflight socket.
        try { controller.abort(); } catch (_) {}
        if (response?.body && !response.body.locked) {
            try { await response.body.cancel(); } catch (_) {}
        }
    }
}

async function ensureBoundedMkvInputPump(session, parentSignal = null) {
    if (!isFiniteMkvVodSession(session)) return;
    if (parentSignal?.aborted) throw abortedVodInputPumpError();
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.boundedMkvInputPump = true;
    // Normal playback retains one full-file response for the pump. A seek only
    // needs an authoritative file identity before FFmpeg starts issuing ranges,
    // so drain bytes=0-0 instead of opening then cancelling a full-file body.
    // This proves size, effective URL and validator without an artificial slot
    // handoff delay or overlapping the first broker request.
    const preopenStartedAt = Date.now();
    const hadExactFileSize = Boolean(fileSizeBytesForSession(session));
    await preopenBoundedMkvInputPump(session, parentSignal, {
        drainExactRange: Number(session?.seekOffset || 0) > 0,
    });
    const fileSizeBytes = fileSizeBytesForSession(session);
    const unknownLengthFullBody = session.preopenedVodInputAttempt?.range?.fullBodyUnknownSize === true;
    if (!fileSizeBytes && !unknownLengthFullBody) {
        await closePreopenedBoundedMkvInput(session);
        throw vodInputPumpError('VOD_SIZE_UNAVAILABLE', 'Finite MKV input size is unavailable', { status: 502 });
    }
    session.startupTimings.fileSizeBytes = fileSizeBytes || null;
    session.startupTimings.fileSizeProbeRan = false;
    session.startupTimings.fileSizeProbeMs = 0;
    session.startupTimings.fileSizeProbeReleaseWaitMs = 0;
    session.startupTimings.fileSizeDiscoveredFromPlaybackGet = !hadExactFileSize && Boolean(fileSizeBytes);
    session.startupTimings.fileSizePendingFullBodyEof = unknownLengthFullBody;
    session.startupTimings.providerGetPreopenMs = Math.max(0, Date.now() - preopenStartedAt);
}

function parseBoundedProviderContentRange(response, expectedStart, maximumRequestedEnd) {
    if (Number(response?.status) !== 206) return null;
    const contentRange = String(response?.headers?.get?.('content-range') || '').trim();
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
    const strictOffset = (value) => {
        if (!/^\d+$/.test(String(value || ''))) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    const start = strictOffset(match?.[1]);
    const end = strictOffset(match?.[2]);
    const total = normalizeFileSizeBytes(match?.[3]);
    const normalizedExpectedStart = Number(expectedStart);
    const normalizedMaximumRequestedEnd = Number(maximumRequestedEnd);
    if (
        !Number.isSafeInteger(normalizedExpectedStart) || normalizedExpectedStart < 0 ||
        !Number.isSafeInteger(normalizedMaximumRequestedEnd) || normalizedMaximumRequestedEnd < normalizedExpectedStart ||
        start !== normalizedExpectedStart ||
        !Number.isSafeInteger(end) || end < start || end >= total ||
        end > normalizedMaximumRequestedEnd
    ) return null;
    const declaredLength = String(response?.headers?.get?.('content-length') || '').trim();
    if (declaredLength) {
        const normalizedLength = normalizeFileSizeBytes(declaredLength);
        if (!normalizedLength || normalizedLength !== (end - start + 1)) return null;
    }
    return { start, end, total };
}

// A minority of VOD panels ignore Range but still return one exact, finite
// object. That response is safe to retain only for byte zero: Content-Length
// becomes the immutable boundary and the pump verifies exact EOF. It must never
// be used for a seek/reconnect because HTTP 200 provides no offset authority.
function parseFullBodyProviderResponse(response, expectedTotal = null) {
    if (Number(response?.status) !== 200) return null;
    if (String(response?.headers?.get?.('content-range') || '').trim()) return null;
    const declaredLength = String(response?.headers?.get?.('content-length') || '').trim();
    const normalizedExpectedTotal = normalizeFileSizeBytes(expectedTotal);
    if (declaredLength && !/^\d+$/.test(declaredLength)) return null;
    const declaredTotal = declaredLength ? normalizeFileSizeBytes(declaredLength) : null;
    const total = declaredTotal || normalizedExpectedTotal;
    if (total && total < 4) return null;
    const contentEncoding = String(response?.headers?.get?.('content-encoding') || '').trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') return null;
    if (!total) {
        return {
            start: 0,
            end: VOD_INPUT_FULL_BODY_MAX_BYTES - 1,
            total: null,
            fullBody: true,
            fullBodyBoundary: 'stream-eof',
            fullBodyUnknownSize: true,
            fullBodyRequiresExactEof: false,
        };
    }
    return {
        start: 0,
        end: total - 1,
        total,
        fullBody: true,
        fullBodyBoundary: declaredTotal ? 'content-length' : 'known-size-exact-eof',
        fullBodyRequiresExactEof: !declaredTotal,
    };
}

async function requireFullBodyExactEof(attempt, parentSignal) {
    while (true) {
        const next = await readRawPrefixChunk(
            attempt.reader,
            parentSignal,
            VOD_INPUT_IDLE_TIMEOUT_MS,
        );
        if (next.aborted || parentSignal?.aborted) throw abortedVodInputPumpError();
        if (next.timedOut) {
            throw vodInputPumpError(
                'PROVIDER_IDLE_TIMEOUT',
                'Provider did not finish the MKV response at its exact known size.',
                { status: 504, retryable: true },
            );
        }
        if (next.error) throw classifyVodInputFetchError(next.error, false);
        if (next.done) return;
        if (Number(next.value?.byteLength || next.value?.length || 0) > 0) {
            throw vodInputPumpError(
                'RANGE_UNSUPPORTED',
                'Provider exceeded the exact known MKV file size.',
                { status: 502 },
            );
        }
    }
}

function classifyMediaContainerPrefix(value) {
    const prefix = Buffer.from(value || []);
    if (
        prefix.length >= 4 &&
        prefix[0] === 0x1a && prefix[1] === 0x45 &&
        prefix[2] === 0xdf && prefix[3] === 0xa3
    ) {
        return { container: 'mkv', evidenceKind: 'ebml-v1' };
    }
    if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF') {
        const riffType = prefix.subarray(8, 12).toString('ascii');
        if (riffType === 'AVI ') return { container: 'avi', evidenceKind: 'riff-avi-v1' };
    }
    if (prefix.length >= 8 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
        const majorBrand = prefix.length >= 12 ? prefix.subarray(8, 12).toString('ascii') : '';
        return {
            container: majorBrand === 'qt  ' ? 'mov' : 'mp4',
            evidenceKind: 'iso-bmff-ftyp-v1',
        };
    }
    if (prefix.length >= 4 && prefix.subarray(0, 4).toString('ascii') === 'OggS') {
        return { container: 'ogg', evidenceKind: 'ogg-v1' };
    }
    if (prefix.length >= 3 && prefix.subarray(0, 3).toString('ascii') === 'FLV') {
        return { container: 'flv', evidenceKind: 'flv-v1' };
    }
    if (
        prefix.length >= 4 &&
        prefix[0] === 0x00 && prefix[1] === 0x00 && prefix[2] === 0x01 && prefix[3] === 0xba
    ) {
        return { container: 'mpg', evidenceKind: 'mpeg-ps-v1' };
    }
    return null;
}

function sourceContainerMismatchError(attempt, session, range, inspectionPrefix, observed) {
    const validator = boundedVodResponseValidator(attempt?.response);
    const validatorSha256 = validator?.value
        ? sha256Hex(validator.value)
        : null;
    const prefixSha256 = crypto.createHash('sha256')
        .update(Buffer.from(inspectionPrefix || []))
        .digest('hex');
    return vodInputPumpError(
        'SOURCE_CONTAINER_MISMATCH',
        'Provider metadata does not match the media file container.',
        {
            status: 409,
            details: {
                protocol: 1,
                code: 'SOURCE_CONTAINER_MISMATCH',
                declaredContainer: 'mkv',
                observedContainer: observed.container,
                evidence: {
                    kind: observed.evidenceKind,
                    prefixSha256,
                    sourceUrlSha256: sha256Hex(String(session?.sourceUrl || '')),
                    effectiveUrlSha256: sha256Hex(String(
                        attempt?.response?.url || session?.sourceUrl || '',
                    )),
                    validatorKind: validator?.kind || 'none',
                    validatorSha256,
                    fileSizeBytes: normalizeFileSizeBytes(range?.total),
                },
            },
        },
    );
}

async function primeFullBodyMatroskaAttempt(attempt, parentSignal, session = null, range = null) {
    if (!attempt?.response?.body || typeof attempt.response.body.getReader !== 'function') {
        throw vodInputPumpError('PROVIDER_EMPTY_RESPONSE', 'Provider returned no MKV response body', {
            status: 502,
            retryable: true,
        });
    }
    attempt.reader = attempt.response.body.getReader();
    attempt.preloadedChunks = [];
    let inspectionPrefix = Buffer.alloc(0);
    const readAndRetain = async () => {
        const next = await readRawPrefixChunk(
            attempt.reader,
            parentSignal,
            VOD_INPUT_IDLE_TIMEOUT_MS,
        );
        if (next.aborted || parentSignal?.aborted) throw abortedVodInputPumpError();
        if (next.timedOut) {
            throw vodInputPumpError(
                'PROVIDER_IDLE_TIMEOUT',
                'Provider did not start the MKV response in time.',
                { status: 504, retryable: true },
            );
        }
        if (next.error) throw classifyVodInputFetchError(next.error, false);
        if (next.done) return false;
        const chunk = Buffer.from(next.value || []);
        if (!chunk.length) return true;
        attempt.preloadedChunks.push(chunk);
        const remainingInspectionBytes = RAW_PREFIX_SNIFF_BYTES - inspectionPrefix.length;
        if (remainingInspectionBytes > 0) {
            const part = chunk.subarray(0, remainingInspectionBytes);
            inspectionPrefix = inspectionPrefix.length
                ? Buffer.concat([inspectionPrefix, part])
                : Buffer.from(part);
        }
        return true;
    };
    while (inspectionPrefix.length < 12) {
        if (!await readAndRetain()) break;
        const observed = classifyMediaContainerPrefix(inspectionPrefix);
        if (observed?.container === 'mkv') return;
        if (observed && observed.container !== 'mkv') {
            throw sourceContainerMismatchError(attempt, session, range, inspectionPrefix, observed);
        }
    }
    const observed = classifyMediaContainerPrefix(inspectionPrefix);
    if (observed?.container === 'mkv') return;
    if (observed && observed.container !== 'mkv') {
        throw sourceContainerMismatchError(attempt, session, range, inspectionPrefix, observed);
    }
    if (inspectionPrefix.length && looksLikeTextStart(inspectionPrefix)) {
        while (true) {
            if (isProviderBusyText(normalizedRawTextPrefix(inspectionPrefix))) {
                throw providerBusyVodInputError(attempt.response.status);
            }
            if (inspectionPrefix.length >= RAW_PREFIX_SNIFF_BYTES) break;
            if (!await readAndRetain()) break;
        }
        if (isProviderBusyText(normalizedRawTextPrefix(inspectionPrefix))) {
            throw providerBusyVodInputError(attempt.response.status);
        }
        throw vodInputPumpError(
            'RANGE_UNSUPPORTED',
            'Provider ignored the exact bounded MKV byte range.',
            { status: 502 },
        );
    }
    throw vodInputPumpError('INVALID_MKV_INPUT', 'Provider response is not a Matroska file.', { status: 502 });
}

function boundedVodResponseValidator(response) {
    const etag = String(response?.headers?.get?.('etag') || '').trim();
    if (etag && !/^W\//i.test(etag)) return { header: 'If-Range', value: etag, kind: 'etag' };
    const lastModified = String(response?.headers?.get?.('last-modified') || '').trim();
    if (lastModified && Number.isFinite(Date.parse(lastModified))) {
        return { header: 'If-Range', value: lastModified, kind: 'last-modified' };
    }
    return null;
}

function vodInputPumpError(code, message, options = {}) {
    const error = new Error(message);
    error.vodInputPumpError = true;
    error.code = code;
    if (Number.isInteger(options.status)) error.status = options.status;
    if (Number.isInteger(options.upstreamStatus)) error.upstreamStatus = options.upstreamStatus;
    if (options.networkCause) error.networkCause = options.networkCause;
    if (options.details && typeof options.details === 'object') error.details = options.details;
    error.retryable = options.retryable === true;
    return error;
}

function providerBusyVodInputError(upstreamStatus = null) {
    const normalizedUpstreamStatus = upstreamStatus === null || upstreamStatus === undefined
        ? null
        : Number(upstreamStatus);
    return vodInputPumpError(
        'PROVIDER_BUSY',
        'This TV service is busy. Wait a few seconds, then try again.',
        {
            status: 458,
            upstreamStatus: Number.isInteger(normalizedUpstreamStatus) ? normalizedUpstreamStatus : null,
        },
    );
}

function abortedVodInputPumpError() {
    const error = vodInputPumpError('VOD_INPUT_ABORTED', 'Finite MKV input pump was stopped');
    error.name = 'AbortError';
    return error;
}

function classifyVodInputResponse(response) {
    const status = Number(response?.status);
    const failure = classifyProviderResponseFailure(status, {}, {
        proxyConfigured: providerProxyAgents.length > 0,
    });
    return vodInputPumpError(failure.code, failure.publicMessage, {
        status: failure.status,
        upstreamStatus: status,
        retryable: shouldRetryProviderStatus(status),
    });
}

function classifyVodInputFetchError(error, timedOut = false) {
    if (error?.vodInputPumpError === true) return error;
    const failure = classifyProviderFetchFailure(
        timedOut ? Object.assign(new Error('Finite MKV provider read timed out'), { name: 'AbortError' }) : error,
    );
    return vodInputPumpError(failure.code, 'The media provider connection was interrupted.', {
        status: failure.category === 'timeout' ? 504 : 502,
        networkCause: failure.category,
        retryable: failure.code !== 'PROXY_AUTH_FAILED',
    });
}

function waitForVodInputRetry(delayMs, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        let timer = null;
        const finish = (completed) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(completed);
        };
        const onAbort = () => finish(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(true), Math.max(0, Number(delayMs) || 0));
        if (signal?.aborted) onAbort();
    });
}

function writeVodInputChunk(writable, chunk, signal) {
    if (signal?.aborted) return Promise.reject(abortedVodInputPumpError());
    if (!writable || writable.destroyed || writable.writableEnded) {
        return Promise.reject(vodInputPumpError('FFMPEG_INPUT_CLOSED', 'FFmpeg input closed before the VOD completed'));
    }
    let accepted;
    try {
        accepted = writable.write(chunk);
    } catch (error) {
        return Promise.reject(vodInputPumpError('FFMPEG_INPUT_CLOSED', 'FFmpeg rejected the VOD input', {
            networkCause: error?.code || error?.name,
        }));
    }
    if (accepted) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            writable.off('drain', onDrain);
            writable.off('error', onError);
            writable.off('close', onClose);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const onDrain = () => finish();
        const onError = () => finish(vodInputPumpError('FFMPEG_INPUT_CLOSED', 'FFmpeg rejected the VOD input'));
        const onClose = () => finish(vodInputPumpError('FFMPEG_INPUT_CLOSED', 'FFmpeg input closed before the VOD completed'));
        const onAbort = () => finish(abortedVodInputPumpError());
        writable.once('drain', onDrain);
        writable.once('error', onError);
        writable.once('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function finishVodInput(writable, signal) {
    if (signal?.aborted) return Promise.reject(abortedVodInputPumpError());
    const inputClosedError = (error) => vodInputPumpError(
        'FFMPEG_INPUT_CLOSED',
        'FFmpeg rejected the completed VOD input',
        { networkCause: error?.code || error?.name },
    );
    if (!writable) return Promise.reject(inputClosedError());
    if (writable.writableFinished) return Promise.resolve();
    if (writable.destroyed || writable.writableEnded) return Promise.reject(inputClosedError(writable.errored));
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            writable.off('error', onError);
            writable.off('close', onClose);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const onError = (error) => finish(inputClosedError(error));
        const onClose = () => finish(writable.writableFinished ? undefined : inputClosedError(writable.errored));
        const onAbort = () => finish(abortedVodInputPumpError());
        writable.once('error', onError);
        writable.once('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            writable.end((error) => finish(error ? inputClosedError(error) : undefined));
        } catch (error) {
            finish(inputClosedError(error));
        }
        if (signal?.aborted) onAbort();
    });
}

async function closeVodInputAttempt(attempt) {
    if (!attempt) return;
    if (attempt.openTimer) clearTimeout(attempt.openTimer);
    attempt.signal?.removeEventListener?.('abort', attempt.onParentAbort);
    try { attempt.controller?.abort(); } catch (_) {}
    if (attempt.reader) {
        try { await attempt.reader.cancel(); } catch (_) {}
        try { attempt.reader.releaseLock(); } catch (_) {}
    } else if (attempt.response?.body) {
        try { await attempt.response.body.cancel(); } catch (_) {}
    }
}

// The finite-MKV lane already owns a single, strictly sequential provider
// socket. Reuse its leading bytes for a LOCAL ffprobe instead of opening the
// source URL again: this gives the browser an exact duration and complete track
// map without violating mono-account providers. The cache is shared with the
// historical /raw tee and keeps the same bounded memory/entry limits.
function captureBoundedMkvHeaderBytes(session, byteOffset, chunk) {
    if (!BOUNDED_MKV_HEADER_PARSE || INBAND_HEADER_BYTES <= 0 || INBAND_HEADER_CACHE_MAX <= 0) return;
    const currentHeaderAuthorityRequired = needsMkvH264CurrentHeaderAuthority(session);
    if (hasCompleteMkvPlaybackProfile(session?.codecProfile) && !currentHeaderAuthorityRequired) return;
    const sourceUrl = String(session?.sourceUrl || '');
    const offset = Number(byteOffset);
    if (!sourceUrl || !Number.isSafeInteger(offset) || offset < 0 || !chunk?.length) return;

    let entry = headerByteCache.get(sourceUrl);
    const captureOwner = String(session?.id || sourceUrl);
    // A stopped/failed startup can leave an incomplete prefix behind. The
    // provider lease guarantees that a new finite-MKV pump is the sole holder,
    // so byte zero from a different session is authoritative and must replace
    // that stale evidence instead of silently disabling metadata discovery.
    if (entry && offset === 0 && entry.captureOwner !== captureOwner) {
        headerByteCache.delete(sourceUrl);
        entry = null;
    }
    if (!entry) {
        if (offset !== 0) return;
        while (headerByteCache.size >= INBAND_HEADER_CACHE_MAX) {
            const oldest = headerByteCache.keys().next().value;
            if (oldest === undefined) return;
            headerByteCache.delete(oldest);
        }
        entry = {
            chunks: [],
            len: 0,
            done: false,
            capturing: true,
            captureOwner,
            limitBytes: INBAND_HEADER_BYTES,
            updatedAt: Date.now(),
        };
        headerByteCache.set(sourceUrl, entry);
    }
    if (entry.done) return;
    // Never interleave a /raw capture, another session, or a resumed range.
    if (entry.captureOwner !== captureOwner || offset !== entry.len) return;

    const captureLimitBytes = Number.isSafeInteger(entry.limitBytes) && entry.limitBytes > 0
        ? entry.limitBytes
        : INBAND_HEADER_BYTES;
    const available = captureLimitBytes - entry.len;
    if (available <= 0) {
        entry.done = true;
        entry.capturing = false;
        return;
    }
    const take = Math.min(available, chunk.length);
    if (take <= 0) return;
    entry.chunks.push(Buffer.from(chunk.subarray(0, take)));
    entry.len += take;
    entry.updatedAt = Date.now();
    if (entry.len >= captureLimitBytes) {
        entry.done = true;
        entry.capturing = false;
    }
}

async function openBoundedVodInputAttempt(session, offset, parentSignal, dispatcher, options = {}) {
    const fileSizeBytes = fileSizeBytesForSession(session);
    if (offset > 0 && !fileSizeBytes) {
        throw vodInputPumpError('VOD_SIZE_UNAVAILABLE', 'Finite MKV input size is unavailable', { status: 502 });
    }
    const requestedEndOverride = Number(options.requestEnd);
    const requestEnd = Number.isSafeInteger(requestedEndOverride) && requestedEndOverride >= offset
        ? Math.min(requestedEndOverride, fileSizeBytes ? fileSizeBytes - 1 : requestedEndOverride)
        : (fileSizeBytes ? fileSizeBytes - 1 : VOD_INPUT_DISCOVERY_RANGE_END);
    const controller = new AbortController();
    const attempt = {
        controller,
        response: null,
        reader: null,
        preloadedChunks: [],
        openTimer: null,
        signal: parentSignal,
        onParentAbort: null,
    };
    attempt.onParentAbort = () => {
        try { controller.abort(parentSignal?.reason); } catch (_) {}
    };
    parentSignal?.addEventListener('abort', attempt.onParentAbort, { once: true });
    if (parentSignal?.aborted) attempt.onParentAbort();
    attempt.openTimer = setTimeout(() => controller.abort(), VOD_INPUT_OPEN_TIMEOUT_MS);
    attempt.openTimer.unref?.();
    try {
        const headers = {
            Range: `bytes=${offset}-${requestEnd}`,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'User-Agent': session.userAgent || FFMPEG_USER_AGENT,
            Connection: 'close',
        };
        if (offset > 0 && session.vodInputValidator?.value) {
            headers[session.vodInputValidator.header] = session.vodInputValidator.value;
        }
        attempt.response = await fetch(session.sourceUrl, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: controller.signal,
            dispatcher: dispatcher || undefined,
        });
        clearTimeout(attempt.openTimer);
        attempt.openTimer = null;
        if (parentSignal?.aborted) throw abortedVodInputPumpError();
        const allowFullBodyAtZero = options.allowFullBodyAtZero === true && offset === 0;
        let range = allowFullBodyAtZero
            ? parseFullBodyProviderResponse(attempt.response, fileSizeBytes)
            : null;
        if (attempt.response.status !== 206 && !range) {
            if (
                attempt.response.status === 200
                && await responseHasProviderBusyPrefix(attempt.response, controller.signal)
            ) {
                throw providerBusyVodInputError(attempt.response.status);
            }
            if (attempt.response.status === 416) {
                throw vodInputPumpError('VOD_CHANGED', 'The MKV file changed while it was playing.', { status: 502 });
            }
            if (attempt.response.status === 200) {
                throw vodInputPumpError(
                    offset > 0 && session.vodInputValidator ? 'VOD_CHANGED' : 'RANGE_UNSUPPORTED',
                    offset > 0 && session.vodInputValidator
                        ? 'The MKV file changed while it was playing.'
                        : 'Provider ignored the exact bounded MKV byte range.',
                    { status: 502 },
                );
            }
            throw classifyVodInputResponse(attempt.response);
        }
        const contentEncoding = String(attempt.response.headers?.get?.('content-encoding') || '').trim().toLowerCase();
        if (contentEncoding && contentEncoding !== 'identity') {
            throw vodInputPumpError('RANGE_UNSUPPORTED', 'Provider encoded the bounded MKV byte range.', { status: 502 });
        }
        if (!range) range = parseBoundedProviderContentRange(attempt.response, offset, requestEnd);
        if (!range) {
            if (await responseHasProviderBusyPrefix(attempt.response, controller.signal)) {
                throw providerBusyVodInputError(attempt.response.status);
            }
            throw vodInputPumpError(
                'RANGE_UNSUPPORTED',
                'Provider did not honor the exact bounded MKV byte range.',
                { status: 502 },
            );
        }
        const responseByteCount = range.end - range.start + 1;
        if (offset === 0 && (range.fullBody === true || responseByteCount >= 8)) {
            await primeFullBodyMatroskaAttempt(attempt, parentSignal, session, range);
        }
        if (fileSizeBytes && range.total !== fileSizeBytes) {
            throw vodInputPumpError('VOD_CHANGED', 'The MKV file changed while it was playing.', { status: 502 });
        }
        const effectiveUrlSha256 = sha256Hex(String(attempt.response?.url || session.sourceUrl || ''));
        if (
            session.vodInputEffectiveUrlSha256 &&
            effectiveUrlSha256 !== session.vodInputEffectiveUrlSha256
        ) {
            throw vodInputPumpError('VOD_CHANGED', 'The MKV provider target changed while it was playing.', { status: 502 });
        }
        const observedValidator = boundedVodResponseValidator(attempt.response);
        if (offset > 0 && !session.vodInputValidator) {
            throw vodInputPumpError('VOD_CHANGED', 'The MKV file cannot be resumed without a stable validator.', { status: 502 });
        }
        if (session.vodInputValidator && (
            !observedValidator ||
            observedValidator.kind !== session.vodInputValidator.kind ||
            observedValidator.value !== session.vodInputValidator.value
        )) {
            // If-Range is an integrity boundary, not merely an optimization. A
            // resumed 206 without the same validator could splice two versions
            // of the file and must never produce a proof or cache entry.
            throw vodInputPumpError('VOD_CHANGED', 'The MKV file changed while it was playing.', { status: 502 });
        }
        if (!session.vodInputValidator && observedValidator) session.vodInputValidator = observedValidator;
        if (!attempt.response.body || typeof attempt.response.body.getReader !== 'function') {
            throw vodInputPumpError('PROVIDER_EMPTY_RESPONSE', 'Provider returned no MKV response body', {
                status: 502,
                retryable: true,
            });
        }
        if (!attempt.reader) attempt.reader = attempt.response.body.getReader();
        return { attempt, range };
    } catch (error) {
        const timedOut = controller.signal.aborted && !parentSignal?.aborted;
        await closeVodInputAttempt(attempt);
        if (parentSignal?.aborted || error?.code === 'VOD_INPUT_ABORTED') throw abortedVodInputPumpError();
        if (error?.vodInputPumpError === true) throw error;
        throw classifyVodInputFetchError(error, timedOut);
    }
}

async function preopenBoundedMkvInputPump(session, parentSignal = null, options = {}) {
    if (!isFiniteMkvVodSession(session) || session.preopenedVodInputAttempt) return;
    const dispatcher = pickProxyAgent(proxyKeyFromUrl(session.sourceUrl)) || null;
    const drainExactRange = options.drainExactRange === true;
    const opened = await openBoundedVodInputAttempt(
        session,
        0,
        parentSignal,
        dispatcher,
        drainExactRange ? { requestEnd: 0 } : { allowFullBodyAtZero: true },
    );
    let retained = false;
    try {
        const existingFileSizeBytes = fileSizeBytesForSession(session);
        if (existingFileSizeBytes && opened.range.total !== existingFileSizeBytes) {
            throw vodInputPumpError('VOD_CHANGED', 'The MKV file changed before playback started.', { status: 502 });
        }
        if (opened.range.total) {
            session.fileSizeBytes = opened.range.total;
            session.codecProfile = compactRecord({
                ...asRecord(session.codecProfile),
                fileSizeBytes: opened.range.total,
            });
        }
        const strongValidator = strongBoundedVodResponseValidator(opened.attempt.response);
        const validatorEvidence = strongValidator
            ? 'strong-etag'
            : (boundedVodResponseValidator(opened.attempt.response)?.kind === 'last-modified'
                ? 'last-modified'
                : 'weak-or-absent');
        if (validatorEvidence === 'strong-etag') vodInputPumpStats.validatorEvidence.strongEtag += 1;
        else if (validatorEvidence === 'last-modified') vodInputPumpStats.validatorEvidence.lastModified += 1;
        else vodInputPumpStats.validatorEvidence.weakOrAbsent += 1;
        session.vodInputStrongValidator = strongValidator;
        session.vodInputEffectiveUrlSha256 = sha256Hex(String(
            opened.attempt.response?.url || session.sourceUrl || '',
        ));
        session.vodInputEffectiveUrlIdentitySha256 = strictLidEffectiveUrlIdentitySha256(
            opened.attempt.response?.url || session.sourceUrl || '',
        );
        session.startupTimings = asRecord(session.startupTimings);
        session.startupTimings.providerValidatorEvidence = validatorEvidence;
        session.startupTimings.providerFullBodyAtZero = opened.range.fullBody === true;
        session.startupTimings.providerFullBodyBoundary = opened.range.fullBodyBoundary || null;

        if (drainExactRange) {
            const expectedBytes = opened.range.end - opened.range.start + 1;
            let drainedBytes = 0;
            while (true) {
                const next = await readRawPrefixChunk(
                    opened.attempt.reader,
                    parentSignal,
                    VOD_INPUT_IDLE_TIMEOUT_MS,
                );
                if (next.aborted || parentSignal?.aborted) throw abortedVodInputPumpError();
                if (next.timedOut) {
                    throw vodInputPumpError(
                        'PROVIDER_IDLE_TIMEOUT',
                        'Provider did not finish the MKV identity range in time.',
                        { status: 504 },
                    );
                }
                if (next.error) throw classifyVodInputFetchError(next.error, false);
                if (next.done) break;
                drainedBytes += Buffer.from(next.value || []).length;
                if (drainedBytes > expectedBytes) {
                    throw vodInputPumpError(
                        'RANGE_LENGTH_MISMATCH',
                        'Provider exceeded the exact MKV identity range.',
                        { status: 502 },
                    );
                }
            }
            if (drainedBytes !== expectedBytes) {
                throw vodInputPumpError(
                    'RANGE_LENGTH_MISMATCH',
                    'Provider truncated the exact MKV identity range.',
                    { status: 502 },
                );
            }
            session.startupTimings.providerGetPreopened = false;
            session.startupTimings.providerSeekIdentityPreflight = true;
            session.startupTimings.providerSeekIdentityPreflightBytes = drainedBytes;
            return;
        }

        session.preopenedVodInputAttempt = {
            ...opened,
            dispatcher,
        };
        session.startupTimings.providerGetPreopened = true;
        retained = true;
    } finally {
        if (!retained) await closeVodInputAttempt(opened.attempt).catch(() => {});
    }
}

async function closePreopenedBoundedMkvInput(session) {
    const opened = session?.preopenedVodInputAttempt;
    if (!opened) return;
    session.preopenedVodInputAttempt = null;
    await closeVodInputAttempt(opened.attempt).catch(() => {});
}

function usesFiniteMkvSeekBroker(session) {
    return Boolean(
        isFiniteMkvVodSession(session) &&
        Number(session?.seekOffset || 0) > 0 &&
        session?.finiteMkvSeekBroker?.inputUrl
    );
}

async function prepareFiniteMkvSeekBroker(session, parentSignal = null) {
    if (!isFiniteMkvVodSession(session) || Number(session?.seekOffset || 0) <= 0) return null;
    if (session.finiteMkvSeekBroker) return session.finiteMkvSeekBroker;
    const fileSizeBytes = fileSizeBytesForSession(session);
    if (!fileSizeBytes) {
        throw vodInputPumpError('VOD_SIZE_UNAVAILABLE', 'Finite MKV seek requires an exact file size.', { status: 502 });
    }

    // The size/identity preopen owns the provider's single socket. Drain it
    // completely before the seek broker is allowed to issue FFmpeg-directed
    // ranges; otherwise a legitimate jump can look like account sharing/458.
    const hadPreopenedProvider = Boolean(session.preopenedVodInputAttempt);
    await closePreopenedBoundedMkvInput(session);
    if (hadPreopenedProvider && PROVIDER_SLOT_RELEASE_DELAY_MS > 0) {
        if (!await waitForVodInputRetry(PROVIDER_SLOT_RELEASE_DELAY_MS, parentSignal)) {
            throw abortedVodInputPumpError();
        }
        session.startupTimings = asRecord(session.startupTimings);
        session.startupTimings.slotReleaseWaitMs = Number(session.startupTimings.slotReleaseWaitMs || 0)
            + PROVIDER_SLOT_RELEASE_DELAY_MS;
        session.startupTimings.mkvSeekPreopenReleaseWaitMs = PROVIDER_SLOT_RELEASE_DELAY_MS;
    }
    if (parentSignal?.aborted) throw abortedVodInputPumpError();

    const broker = await createStrictLidBroker({
        sourceUrl: session.sourceUrl,
        fileSizeBytes,
        userAgent: session.userAgent || FFMPEG_USER_AGENT,
        expectedValidator: session.vodInputValidator,
        effectiveUrlSha256: session.vodInputEffectiveUrlSha256,
        effectiveUrlIdentitySha256: session.vodInputEffectiveUrlIdentitySha256,
        pathPrefix: 'finite-mkv-seek',
        // Exact responses are fully drained and the broker remains strictly
        // serialized, so no provider-slot grace is needed between them. A
        // planned FFmpeg supersession also waits for cancellation/socket close
        // before the next GET. Shutdown, timeout and error paths retain the
        // conservative global release delay for safe external handoff.
        completedReleaseDelayMs: 0,
        supersededReleaseDelayMs: 0,
        abortSignal: parentSignal,
    });
    session.finiteMkvSeekBroker = broker;
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.boundedMkvInputPump = false;
    session.startupTimings.finiteMkvSeekBroker = true;
    session.startupTimings.finiteMkvSeekProviderFetches = 0;
    return broker;
}

function applyFiniteMkvSeekBrokerFailure(session) {
    const broker = session?.finiteMkvSeekBroker;
    const error = broker?.terminalError;
    if (!error) return false;
    session.inputFailure = {
        status: Number.isInteger(error.status) ? error.status : 502,
        code: error.code || 'VOD_INPUT_FAILED',
        upstreamStatus: Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : null,
        networkCause: error.networkCause || null,
    };
    const safeMessage = sanitizeLog(error.message || 'Finite MKV seek input failed', session.sourceUrl);
    session.lastError = `${session.inputFailure.code}: ${safeMessage}`;
    appendLogTail(session, session.lastError);
    return true;
}

async function closeFiniteMkvSeekBroker(session) {
    const broker = session?.finiteMkvSeekBroker;
    if (!broker) return;
    session.finiteMkvSeekBroker = null;
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.finiteMkvSeekProviderFetches = Number(broker.providerFetches || 0);
    session.startupTimings.finiteMkvSeekCompletedProviderFetches = Number(
        broker.completedProviderFetches || 0,
    );
    session.startupTimings.finiteMkvSeekInterruptedProviderFetches = Number(
        broker.interruptedProviderFetches || 0,
    );
    await broker.close().catch(() => {});
}

function strictMkvAnalyzerInteger(value) {
    const encoded = String(value ?? '');
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(encoded)) return null;
    const parsed = Number(encoded);
    return Number.isSafeInteger(parsed) && !Object.is(parsed, -0) ? parsed : null;
}

function strictMkvAnalyzerRational(value) {
    const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(value || ''));
    if (!match) return null;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (
        !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
        numerator > 1_000_000_000 || denominator > 1_000_000_000
    ) return null;
    let left = numerator;
    let right = denominator;
    while (right) {
        const remainder = left % right;
        left = right;
        right = remainder;
    }
    return { numerator: numerator / left, denominator: denominator / left };
}

function sameMkvAnalyzerRational(left, right) {
    return Boolean(
        left && right && left.numerator === right.numerator && left.denominator === right.denominator,
    );
}

function parseMkvAnalyzerCompactLine(line, prefix) {
    const parts = String(line || '').split('|');
    if (parts.shift() !== prefix || parts.length === 0) return null;
    const fields = {};
    for (const part of parts) {
        const splitAt = part.indexOf('=');
        if (splitAt <= 0) return null;
        const key = part.slice(0, splitAt);
        if (!/^[A-Za-z0-9_:]+$/.test(key) || Object.hasOwn(fields, key)) return null;
        fields[key] = part.slice(splitAt + 1);
    }
    return fields;
}

function mkvAnalyzerTicksToMicroseconds(ticks, timeBase) {
    if (!Number.isSafeInteger(ticks) || !timeBase) return null;
    const scaled = BigInt(ticks) * BigInt(timeBase.numerator) * 1_000_000n;
    const divisor = BigInt(timeBase.denominator);
    const rounded = scaled >= 0n
        ? (scaled + divisor / 2n) / divisor
        : -((-scaled + divisor / 2n) / divisor);
    return rounded.toString();
}

function mkvAnalyzerTimelineDigest(records, timeBase) {
    if (!Array.isArray(records) || records.length < MKV_H264_FAST_START_MIN_KEYFRAMES || !timeBase) return null;
    // Matroska commonly omits DTS for the leading B-frame reorder window. Both
    // timelines therefore use key/IDR #1 as their relative DTS anchor while PTS
    // always uses key/IDR #0. Every later DTS remains mandatory and ordered.
    const firstPts = records[0]?.pts;
    const dtsAnchor = records[1]?.dts;
    if (!Number.isSafeInteger(firstPts) || !Number.isSafeInteger(dtsAnchor)) return null;
    const hash = crypto.createHash('sha256').update('NORVA/MKV-H264-IDR-TIMELINE/V2\0');
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (
            !record || !Number.isSafeInteger(record.pts) || !Number.isSafeInteger(record.duration) ||
            record.duration <= 0 || (index > 0 && !Number.isSafeInteger(record.dts))
        ) return null;
        const ptsDelta = record.pts - firstPts;
        const dtsDelta = index === 0 ? 0 : record.dts - dtsAnchor;
        if (!Number.isSafeInteger(ptsDelta) || !Number.isSafeInteger(dtsDelta) || ptsDelta < 0 || dtsDelta < 0) return null;
        const ptsUs = mkvAnalyzerTicksToMicroseconds(ptsDelta, timeBase);
        const dtsUs = mkvAnalyzerTicksToMicroseconds(dtsDelta, timeBase);
        const durationUs = mkvAnalyzerTicksToMicroseconds(record.duration, timeBase);
        if (ptsUs === null || dtsUs === null || durationUs === null) return null;
        hash.update(`${index}:${ptsUs}:${dtsUs}:${durationUs}\n`);
    }
    return hash.digest('hex');
}

function createMkvH264FullFilePacketAnalyzer(session) {
    if (!shouldCreateMkvH264FullFilePacketAnalyzer(session)) return null;
    let packetChild;
    let idrChild;
    try {
        packetChild = spawn(FFPROBE_PATH, [
            '-v', 'error',
            // Match the exact stream selected by the playback graph. Uppercase
            // `V` excludes attached pictures/cover art; lowercase `v` does not.
            '-select_streams', 'V:0',
            '-show_packets',
            '-show_streams',
            '-show_entries', [
                'packet=stream_index,pts,dts,duration,flags',
                'stream=index,time_base,profile,level,refs,r_frame_rate,avg_frame_rate,pix_fmt,width,height',
            ].join(':'),
            '-of', 'compact=p=1:nk=0',
            '-i', 'pipe:0',
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: loopbackOnlyEnv(),
        });
        session.startupTimings = asRecord(session.startupTimings);
        session.startupTimings.analyzerSpawnCount = Number(session.startupTimings.analyzerSpawnCount || 0) + 1;
        idrChild = spawn(FFMPEG_PATH, [
            '-v', 'error',
            '-nostdin',
            '-copyts',
            '-copytb', '1',
            '-avoid_negative_ts', 'disabled',
            '-i', 'pipe:0',
            '-map', '0:V:0',
            '-c:v', 'copy',
            '-bsf:v', 'h264_mp4toannexb,filter_units=pass_types=5',
            '-f', 'framecrc',
            'pipe:1',
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: loopbackOnlyEnv(),
        });
        session.startupTimings.analyzerSpawnCount = Number(session.startupTimings.analyzerSpawnCount || 0) + 1;
    } catch (_) {
        try { packetChild?.kill('SIGTERM'); } catch (_) {}
        try { idrChild?.kill('SIGTERM'); } catch (_) {}
        return null;
    }
    const packetTee = new PassThrough({ highWaterMark: MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES });
    const idrTee = new PassThrough({ highWaterMark: MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES });
    packetTee.pipe(packetChild.stdin);
    idrTee.pipe(idrChild.stdin);
    packetChild.stdin.on('error', () => {});
    idrChild.stdin.on('error', () => {});
    const analyzer = {
        packetChild,
        idrChild,
        packetTee,
        idrTee,
        bytesAnalyzed: 0,
        packetCount: 0,
        packetStreamIndex: null,
        keyframeCount: 0,
        idrCount: 0,
        firstPacketKeyframe: false,
        firstPtsTicks: null,
        firstDtsTicks: null,
        lastDtsTicks: null,
        maximumTimestampTicks: 0,
        lastKeyframePtsTicks: null,
        maxKeyframeGapTicks: 0,
        maxDtsGapTicks: 0,
        maxPtsDtsSkewTicks: 0,
        leadingMissingDtsCount: 0,
        seenPresentDts: false,
        negativeTimestampCount: 0,
        timestampDiscontinuityCount: 0,
        keyTimeline: [],
        idrTimeline: [],
        packetTimeBase: null,
        idrTimeBase: null,
        streamMetadata: null,
        packetPending: '',
        idrPending: '',
        packetStderr: '',
        idrStderr: '',
        failed: false,
        droppedChunks: 0,
        packetExited: false,
        idrExited: false,
        packetExitCode: null,
        idrExitCode: null,
        exitPromise: null,
        finalizing: false,
        abandonedReason: null,
        stopRequested: false,
    };
    mkvH264FullFileAnalyzers.add(analyzer);

    const fail = (reason) => {
        analyzer.failed = true;
        analyzer.abandonedReason ||= reason;
        abandonMkvH264FullFileAnalyzer(analyzer, reason);
    };
    const consumePacketLine = (line) => {
        if (!line) return;
        if (Buffer.byteLength(line) > MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES) return fail('packet-line-too-long');
        if (line.startsWith('stream|')) {
            if (analyzer.streamMetadata) return fail('duplicate-video-stream');
            const fields = parseMkvAnalyzerCompactLine(line, 'stream');
            const index = strictMkvAnalyzerInteger(fields?.index);
            const level = strictMkvAnalyzerInteger(fields?.level);
            const refs = strictMkvAnalyzerInteger(fields?.refs);
            const width = strictMkvAnalyzerInteger(fields?.width);
            const height = strictMkvAnalyzerInteger(fields?.height);
            const timeBase = strictMkvAnalyzerRational(fields?.time_base);
            const rFrameRate = strictMkvAnalyzerRational(fields?.r_frame_rate);
            const avgFrameRate = strictMkvAnalyzerRational(fields?.avg_frame_rate);
            if (
                !fields || !Number.isInteger(index) || index < 0 || index > 1_024 ||
                analyzer.packetStreamIndex === null || index !== analyzer.packetStreamIndex ||
                !timeBase || !rFrameRate || !avgFrameRate ||
                !Number.isInteger(level) || level <= 0 || !Number.isInteger(refs) || refs <= 0 ||
                !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 ||
                !String(fields.profile || '').trim() || !String(fields.pix_fmt || '').trim()
            ) return fail('invalid-video-stream-metadata');
            analyzer.packetTimeBase = timeBase;
            analyzer.streamMetadata = {
                index,
                profile: String(fields.profile).trim(),
                level,
                refs,
                width,
                height,
                pixelFormat: String(fields.pix_fmt).trim(),
                rFrameRate,
                avgFrameRate,
            };
            return;
        }
        if (!line.startsWith('packet|')) return fail('unexpected-ffprobe-line');
        const fields = parseMkvAnalyzerCompactLine(line, 'packet');
        if (!fields || !exactRecordKeys(fields, ['stream_index', 'pts', 'dts', 'duration', 'flags'])) {
            return fail('invalid-packet-fields');
        }
        const streamIndex = strictMkvAnalyzerInteger(fields.stream_index);
        const pts = strictMkvAnalyzerInteger(fields.pts);
        const duration = strictMkvAnalyzerInteger(fields.duration);
        const dtsMissing = fields.dts === 'N/A';
        const dts = dtsMissing ? null : strictMkvAnalyzerInteger(fields.dts);
        const flags = String(fields.flags || '');
        if (
            !Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 1_024 ||
            !Number.isSafeInteger(pts) || !Number.isSafeInteger(duration) || duration <= 0 ||
            // FFprobe 5.x emits the canonical two-column form (`K_` / `__`),
            // while newer builds may append additional flag columns (`K__`).
            // Keep the alphabet and upper bound strict, but accept both stable
            // layouts before applying the corrupt/discard denylist below.
            (!dtsMissing && !Number.isSafeInteger(dts)) || !/^[A-Z_]{2,8}$/.test(flags) ||
            flags.includes('C') || flags.includes('D')
        ) return fail('invalid-packet');
        if (analyzer.packetStreamIndex === null) analyzer.packetStreamIndex = streamIndex;
        else if (analyzer.packetStreamIndex !== streamIndex) return fail('packet-stream-changed');
        if (dtsMissing) {
            if (analyzer.seenPresentDts || analyzer.leadingMissingDtsCount >= 4) return fail('missing-packet-dts');
            analyzer.leadingMissingDtsCount += 1;
        } else {
            analyzer.seenPresentDts = true;
            if (analyzer.firstDtsTicks === null) analyzer.firstDtsTicks = dts;
            if (analyzer.lastDtsTicks !== null) {
                if (dts < analyzer.lastDtsTicks) analyzer.timestampDiscontinuityCount += 1;
                analyzer.maxDtsGapTicks = Math.max(analyzer.maxDtsGapTicks, dts - analyzer.lastDtsTicks);
            }
            analyzer.lastDtsTicks = dts;
            analyzer.maxPtsDtsSkewTicks = Math.max(analyzer.maxPtsDtsSkewTicks, Math.abs(pts - dts));
        }
        if (analyzer.packetCount === 0) {
            analyzer.firstPtsTicks = pts;
            analyzer.firstPacketKeyframe = flags.includes('K');
        }
        if (pts < 0 || (dts !== null && dts < 0)) analyzer.negativeTimestampCount += 1;
        analyzer.maximumTimestampTicks = Math.max(analyzer.maximumTimestampTicks, pts, dts ?? pts) + 0;
        analyzer.maximumTimestampTicks = Math.max(analyzer.maximumTimestampTicks, Math.max(pts, dts ?? pts) + duration);
        if (flags.includes('K')) {
            if (analyzer.keyTimeline.length >= MKV_H264_FAST_START_ANALYZER_MAX_TIMELINE_RECORDS) {
                return fail('keyframe-timeline-limit');
            }
            if (analyzer.lastKeyframePtsTicks !== null) {
                if (pts <= analyzer.lastKeyframePtsTicks) return fail('non-increasing-keyframe-pts');
                analyzer.maxKeyframeGapTicks = Math.max(
                    analyzer.maxKeyframeGapTicks,
                    pts - analyzer.lastKeyframePtsTicks,
                );
            }
            analyzer.lastKeyframePtsTicks = pts;
            analyzer.keyTimeline.push({ pts, dts, duration });
            analyzer.keyframeCount += 1;
        }
        analyzer.packetCount += 1;
        if (analyzer.packetCount > 20_000_000) return fail('packet-count-limit');
    };
    const consumeIdrLine = (line) => {
        if (!line) return;
        if (Buffer.byteLength(line) > MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES) return fail('idr-line-too-long');
        if (line.startsWith('#')) {
            if (line.startsWith('#tb')) {
                const match = /^#tb 0: ([1-9][0-9]*\/[1-9][0-9]*)$/.exec(line);
                if (!match || analyzer.idrTimeBase) return fail('invalid-idr-time-base');
                analyzer.idrTimeBase = strictMkvAnalyzerRational(match[1]);
                if (!analyzer.idrTimeBase) return fail('invalid-idr-time-base');
            }
            return;
        }
        if (!analyzer.idrTimeBase) return fail('idr-data-before-time-base');
        const fields = line.split(',').map((field) => field.trim());
        if (fields.length !== 6) return fail('invalid-idr-fields');
        const streamIndex = strictMkvAnalyzerInteger(fields[0]);
        const dts = strictMkvAnalyzerInteger(fields[1]);
        const pts = strictMkvAnalyzerInteger(fields[2]);
        const duration = strictMkvAnalyzerInteger(fields[3]);
        const size = strictMkvAnalyzerInteger(fields[4]);
        if (
            streamIndex !== 0 || !Number.isSafeInteger(dts) || !Number.isSafeInteger(pts) ||
            !Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(size) || size <= 0 ||
            !/^(?:0x)?[A-Fa-f0-9]+$/.test(fields[5])
        ) return fail('invalid-idr-record');
        if (analyzer.idrTimeline.length >= MKV_H264_FAST_START_ANALYZER_MAX_TIMELINE_RECORDS) {
            return fail('idr-timeline-limit');
        }
        analyzer.idrTimeline.push({ pts, dts, duration });
        analyzer.idrCount += 1;
    };
    const consumeOutput = (kind, chunk) => {
        const pendingKey = kind === 'packet' ? 'packetPending' : 'idrPending';
        const combined = analyzer[pendingKey] + chunk.toString('utf8');
        const lines = combined.split(/\r?\n/);
        analyzer[pendingKey] = lines.pop() || '';
        if (Buffer.byteLength(analyzer[pendingKey]) > MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES) {
            return fail(`${kind}-unterminated-line`);
        }
        for (const line of lines) {
            if (kind === 'packet') consumePacketLine(line);
            else consumeIdrLine(line);
            if (analyzer.failed) break;
        }
    };
    packetChild.stdout.on('data', (chunk) => consumeOutput('packet', chunk));
    idrChild.stdout.on('data', (chunk) => consumeOutput('idr', chunk));
    packetChild.stderr.on('data', (chunk) => {
        analyzer.packetStderr += sanitizeLog(chunk.toString(), session.sourceUrl);
        if (analyzer.packetStderr.length > 8_000) analyzer.packetStderr = analyzer.packetStderr.slice(-8_000);
    });
    idrChild.stderr.on('data', (chunk) => {
        analyzer.idrStderr += sanitizeLog(chunk.toString(), session.sourceUrl);
        if (analyzer.idrStderr.length > 8_000) analyzer.idrStderr = analyzer.idrStderr.slice(-8_000);
    });
    packetTee.on('error', () => fail('packet-tee-error'));
    idrTee.on('error', () => fail('idr-tee-error'));

    const observeExit = (kind, child) => new Promise((resolve) => {
        const exitedKey = kind === 'packet' ? 'packetExited' : 'idrExited';
        const exitCodeKey = kind === 'packet' ? 'packetExitCode' : 'idrExitCode';
        const finish = (code) => {
            if (analyzer[exitedKey]) return;
            analyzer[exitedKey] = true;
            analyzer[exitCodeKey] = code;
            const pendingKey = kind === 'packet' ? 'packetPending' : 'idrPending';
            const pending = analyzer[pendingKey];
            analyzer[pendingKey] = '';
            if (pending) {
                if (kind === 'packet') consumePacketLine(pending);
                else consumeIdrLine(pending);
            }
            if (!analyzer.finalizing) {
                analyzer.failed = true;
                analyzer.abandonedReason ||= `${kind}-analyzer-exited-early`;
                try { (kind === 'packet' ? idrChild : packetChild).kill('SIGTERM'); } catch (_) {}
            }
            resolve();
        };
        child.once('error', () => {
            analyzer.failed = true;
            finish(-1);
        });
        // `close` is later than `exit` and guarantees stdout/stderr pipes have
        // drained. A proof must never finalize against a truncated tail that is
        // still buffered in the parent process.
        child.once('close', (code) => finish(code));
    });
    analyzer.exitPromise = Promise.all([
        observeExit('packet', packetChild),
        observeExit('idr', idrChild),
    ]).then(() => {
        mkvH264FullFileAnalyzers.delete(analyzer);
    });
    return analyzer;
}

function shouldCreateMkvH264FullFilePacketAnalyzer(session) {
    if (
        !MKV_H264_FAST_START_COPY_ACTIVATION_READY ||
        !MKV_H264_FAST_START_PROOF_CURRENT_KEY ||
        !isFiniteMkvVodSession(session) ||
        Number(session?.seekOffset || 0) > 0 ||
        session?.forceAlignedMultiAudioVideoEncode === true ||
        session?.mode === 'transcode' ||
        asRecord(session?.mkvH264FastStart).eligible === true ||
        !mkvH264FastStartIdentityContext(session)
    ) return false;
    const profile = asRecord(session?.codecProfile);
    const videoCodec = normalizeCodecToken(profile.videoCodec ?? profile.video_codec ?? profile.video);
    if (videoCodec && !(videoCodec.includes('h264') || videoCodec.includes('avc'))) return false;
    const videoWidth = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const videoHeight = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    if (
        (Number.isFinite(videoWidth) && (videoWidth <= 0 || videoWidth > EXACT_MATROSKA_H264_MAX_WIDTH)) ||
        (Number.isFinite(videoHeight) && (videoHeight <= 0 || videoHeight > EXACT_MATROSKA_H264_MAX_HEIGHT)) ||
        (Number.isFinite(videoWidth) && Number.isFinite(videoHeight) && videoWidth * videoHeight > EXACT_MATROSKA_H264_MAX_PIXELS)
    ) return false;
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : null);
    if (audioTracks && audioTracks.length !== 1) return false;
    return true;
}

function abandonMkvH264FullFileAnalyzer(analyzer, reason = 'abandoned') {
    if (!analyzer || analyzer.stopRequested) return;
    analyzer.stopRequested = true;
    analyzer.failed = true;
    analyzer.abandonedReason ||= reason;
    analyzer.droppedChunks += 1;
    for (const [tee, child, exited] of [
        [analyzer.packetTee, analyzer.packetChild, analyzer.packetExited],
        [analyzer.idrTee, analyzer.idrChild, analyzer.idrExited],
    ]) {
        try {
            tee?.unpipe(child?.stdin);
            tee?.destroy();
        } catch (_) {}
        try { child?.stdin?.destroy(); } catch (_) {}
        if (!exited) {
            try { child?.kill('SIGTERM'); } catch (_) {}
        }
    }
}

function writeMkvH264FullFileAnalyzerChunk(analyzer, chunk) {
    if (!analyzer || analyzer.failed || analyzer.packetExited || analyzer.idrExited || !chunk?.length) return false;
    let packetAccepted = false;
    let idrAccepted = false;
    try {
        packetAccepted = analyzer.packetTee.write(chunk);
        idrAccepted = analyzer.idrTee.write(chunk);
    } catch (_) {
        abandonMkvH264FullFileAnalyzer(analyzer, 'tee-write-error');
        return false;
    }
    if (!packetAccepted || !idrAccepted) {
        abandonMkvH264FullFileAnalyzer(analyzer, 'tee-backpressure');
        return false;
    }
    analyzer.bytesAnalyzed += chunk.length;
    return true;
}

async function waitForMkvH264FullFileAnalyzerExit(analyzer) {
    if (!analyzer || (analyzer.packetExited && analyzer.idrExited)) return;
    await waitForMkvH264AnalyzerDeadline(
        analyzer.exitPromise,
        MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS,
    );
    if (!analyzer.packetExited || !analyzer.idrExited) {
        if (!analyzer.packetExited) try { analyzer.packetChild.kill('SIGKILL'); } catch (_) {}
        if (!analyzer.idrExited) try { analyzer.idrChild.kill('SIGKILL'); } catch (_) {}
        await waitForMkvH264AnalyzerDeadline(
            analyzer.exitPromise,
            MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS,
        );
    }
}

async function waitForMkvH264AnalyzerDeadline(promise, timeoutMs) {
    let timer = null;
    try {
        await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
                // This deadline is part of an awaited child-reaping contract.
                // Keeping it referenced guarantees a stalled optional analyzer
                // is killed even when no unrelated event-loop handle remains.
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function stopMkvH264FullFileAnalyzer(analyzer, reason = 'pump-incomplete') {
    if (!analyzer) return;
    abandonMkvH264FullFileAnalyzer(analyzer, reason);
    await waitForMkvH264FullFileAnalyzerExit(analyzer);
}

async function finishMkvH264FullFileAnalyzer(analyzer) {
    if (!analyzer) return null;
    if (!analyzer.failed && !analyzer.packetExited && !analyzer.idrExited) {
        analyzer.finalizing = true;
        try {
            analyzer.packetTee.end();
            analyzer.idrTee.end();
        } catch (_) {
            abandonMkvH264FullFileAnalyzer(analyzer, 'tee-finish-error');
        }
    }
    if (analyzer.failed && (!analyzer.packetExited || !analyzer.idrExited)) {
        abandonMkvH264FullFileAnalyzer(analyzer, analyzer.abandonedReason || 'analyzer-failed');
    }
    await waitForMkvH264AnalyzerDeadline(analyzer.exitPromise, CODEC_PROBE_TIMEOUT_MS);
    if (!analyzer.packetExited || !analyzer.idrExited) {
        analyzer.failed = true;
        abandonMkvH264FullFileAnalyzer(analyzer, 'analyzer-timeout');
        await waitForMkvH264FullFileAnalyzerExit(analyzer);
    }
    const keyTimelineSha256 = mkvAnalyzerTimelineDigest(analyzer.keyTimeline, analyzer.packetTimeBase);
    const idrTimelineSha256 = mkvAnalyzerTimelineDigest(analyzer.idrTimeline, analyzer.idrTimeBase);
    const streamMetadata = analyzer.streamMetadata;
    if (
        analyzer.failed || analyzer.packetExitCode !== 0 || analyzer.idrExitCode !== 0 ||
        analyzer.packetStderr.trim() || analyzer.idrStderr.trim() ||
        analyzer.droppedChunks !== 0 || analyzer.packetCount < MKV_H264_FAST_START_MIN_KEYFRAMES ||
        analyzer.keyframeCount < MKV_H264_FAST_START_MIN_KEYFRAMES ||
        analyzer.keyframeCount !== analyzer.idrCount ||
        analyzer.firstPacketKeyframe !== true || analyzer.lastKeyframePtsTicks === null ||
        !sameMkvAnalyzerRational(analyzer.packetTimeBase, analyzer.idrTimeBase) ||
        !keyTimelineSha256 || keyTimelineSha256 !== idrTimelineSha256 ||
        !streamMetadata || !sameMkvAnalyzerRational(streamMetadata.rFrameRate, streamMetadata.avgFrameRate)
    ) return null;
    analyzer.maxKeyframeGapTicks = Math.max(
        analyzer.maxKeyframeGapTicks,
        analyzer.maximumTimestampTicks - analyzer.lastKeyframePtsTicks,
    );
    const timeBaseSeconds = analyzer.packetTimeBase.numerator / analyzer.packetTimeBase.denominator;
    const firstPtsSeconds = analyzer.firstPtsTicks * timeBaseSeconds;
    const firstDtsSeconds = analyzer.firstDtsTicks * timeBaseSeconds;
    const maxPtsDtsSkewSeconds = analyzer.maxPtsDtsSkewTicks * timeBaseSeconds;
    const maxDtsGapSeconds = analyzer.maxDtsGapTicks * timeBaseSeconds;
    return {
        bytesAnalyzed: analyzer.bytesAnalyzed,
        packetCount: analyzer.packetCount,
        videoStreamIndex: streamMetadata.index,
        keyframeCount: analyzer.keyframeCount,
        idrCount: analyzer.idrCount,
        keyTimelineSha256,
        idrTimelineSha256,
        closedGopIdrVerified: true,
        firstPacketKeyframe: true,
        coverageSeconds: Number((analyzer.maximumTimestampTicks * timeBaseSeconds).toFixed(3)),
        maxKeyframeGapSeconds: Number((analyzer.maxKeyframeGapTicks * timeBaseSeconds).toFixed(6)),
        ptsPresent: true,
        dtsPresent: analyzer.seenPresentDts === true,
        dtsMonotonic: analyzer.timestampDiscontinuityCount === 0 && maxDtsGapSeconds <= EXACT_MATROSKA_H264_HLS_TARGET_SECONDS + 1,
        muxTimestampsSafe: Boolean(
            analyzer.negativeTimestampCount === 0 &&
            analyzer.timestampDiscontinuityCount === 0 &&
            analyzer.leadingMissingDtsCount <= 4 &&
            firstPtsSeconds >= 0 && firstPtsSeconds <= 1 &&
            firstDtsSeconds >= 0 && firstDtsSeconds <= 1 &&
            maxPtsDtsSkewSeconds <= 2 &&
            maxDtsGapSeconds <= EXACT_MATROSKA_H264_HLS_TARGET_SECONDS + 1
        ),
        leadingMissingDtsCount: analyzer.leadingMissingDtsCount,
        negativeTimestampCount: analyzer.negativeTimestampCount,
        timestampDiscontinuityCount: analyzer.timestampDiscontinuityCount,
        firstPtsSeconds: Number(firstPtsSeconds.toFixed(6)),
        firstDtsSeconds: Number(firstDtsSeconds.toFixed(6)),
        maxPtsDtsSkewSeconds: Number(maxPtsDtsSkewSeconds.toFixed(6)),
        streamTimeBaseNumerator: analyzer.packetTimeBase.numerator,
        streamTimeBaseDenominator: analyzer.packetTimeBase.denominator,
        videoProfile: streamMetadata.profile,
        videoLevel: streamMetadata.level,
        videoRefs: streamMetadata.refs,
        videoFpsNumerator: streamMetadata.avgFrameRate.numerator,
        videoFpsDenominator: streamMetadata.avgFrameRate.denominator,
        videoWidth: streamMetadata.width,
        videoHeight: streamMetadata.height,
        videoPixelFormat: streamMetadata.pixelFormat,
        analyzerType: MKV_H264_FAST_START_ANALYZER_TYPE,
        analyzerDigest: MKV_H264_FAST_START_ANALYZER_DIGEST,
    };
}

async function runBoundedMkvInputPump(session, writable, signal, dispatcher) {
    let fileSizeBytes = fileSizeBytesForSession(session);
    const unknownLengthFullBody = Boolean(
        !fileSizeBytes && session.preopenedVodInputAttempt?.range?.fullBodyUnknownSize === true
    );
    if (!fileSizeBytes && !unknownLengthFullBody) {
        throw vodInputPumpError('VOD_SIZE_UNAVAILABLE', 'Finite MKV input size is unavailable', { status: 502 });
    }
    let offset = 0;
    let forwardedBytes = 0;
    let prefixBuffer = Buffer.alloc(0);
    let prefixValidated = false;
    let consecutiveNoProgressFailures = 0;
    let reconnects = 0;
    let unknownLengthFullBodyEof = false;
    const fullFileAnalyzer = createMkvH264FullFilePacketAnalyzer(session);
    let fullFileAnalyzerSettled = false;
    try {
    while (unknownLengthFullBody ? !unknownLengthFullBodyEof : offset < fileSizeBytes) {
        if (signal.aborted) throw abortedVodInputPumpError();
        const attemptOffset = offset;
        let attempt = null;
        let range = null;
        let failure = null;
        try {
            const opened = offset === 0 && session.preopenedVodInputAttempt
                ? (() => {
                    const preopened = session.preopenedVodInputAttempt;
                    session.preopenedVodInputAttempt = null;
                    return preopened;
                })()
                : await openBoundedVodInputAttempt(
                    session,
                    offset,
                    signal,
                    dispatcher,
                    offset === 0 && forwardedBytes === 0 ? { allowFullBodyAtZero: true } : {},
                );
            attempt = opened.attempt;
            range = opened.range;
            while (offset <= range.end) {
                const next = Array.isArray(attempt.preloadedChunks) && attempt.preloadedChunks.length
                    ? {
                        value: attempt.preloadedChunks.shift(),
                        done: false,
                        timedOut: false,
                        aborted: false,
                    }
                    : await readRawPrefixChunk(attempt.reader, signal, VOD_INPUT_IDLE_TIMEOUT_MS);
                if (next.aborted || signal.aborted) throw abortedVodInputPumpError();
                if (next.timedOut) {
                    try { attempt.controller.abort(); } catch (_) {}
                    throw classifyVodInputFetchError(new Error('Finite MKV provider read timed out'), true);
                }
                if (next.error) throw classifyVodInputFetchError(next.error);
                if (next.done) {
                    if (range.fullBodyUnknownSize === true) unknownLengthFullBodyEof = true;
                    break;
                }
                let chunk = Buffer.from(next.value || []);
                if (!chunk.length) continue;
                if (
                    offset + chunk.length > range.end + 1 ||
                    (fileSizeBytes && offset + chunk.length > fileSizeBytes)
                ) {
                    throw vodInputPumpError('RANGE_UNSUPPORTED', 'Provider exceeded the declared MKV byte range', { status: 502 });
                }
                captureBoundedMkvHeaderBytes(session, offset, chunk);
                if (!prefixValidated) {
                    const needed = Math.max(0, 4 - prefixBuffer.length);
                    const prefixPart = chunk.subarray(0, needed);
                    prefixBuffer = prefixBuffer.length
                        ? Buffer.concat([prefixBuffer, prefixPart])
                        : Buffer.from(prefixPart);
                    offset += prefixPart.length;
                    chunk = chunk.subarray(prefixPart.length);
                    if (prefixBuffer.length < 4) continue;
                    if (
                        prefixBuffer[0] !== 0x1a || prefixBuffer[1] !== 0x45 ||
                        prefixBuffer[2] !== 0xdf || prefixBuffer[3] !== 0xa3
                    ) {
                        throw vodInputPumpError('INVALID_MKV_INPUT', 'Provider response is not a Matroska file.', { status: 502 });
                    }
                    await writeVodInputChunk(writable, prefixBuffer, signal);
                    writeMkvH264FullFileAnalyzerChunk(fullFileAnalyzer, prefixBuffer);
                    forwardedBytes += prefixBuffer.length;
                    vodInputPumpStats.bytesForwarded += prefixBuffer.length;
                    prefixBuffer = Buffer.alloc(0);
                    prefixValidated = true;
                }
                if (chunk.length) {
                    await writeVodInputChunk(writable, chunk, signal);
                    writeMkvH264FullFileAnalyzerChunk(fullFileAnalyzer, chunk);
                    offset += chunk.length;
                    forwardedBytes += chunk.length;
                    vodInputPumpStats.bytesForwarded += chunk.length;
                }
            }
            if (range.fullBodyUnknownSize === true) {
                if (!unknownLengthFullBodyEof) {
                    failure = vodInputPumpError(
                        'PROVIDER_CONNECTION_RESET',
                        'Provider ended the unknown-size MKV body unexpectedly.',
                        { status: 502, networkCause: 'premature_eof', retryable: false },
                    );
                } else if (offset < 4) {
                    failure = vodInputPumpError(
                        'INVALID_MKV_INPUT',
                        'Provider response is not a complete Matroska file.',
                        { status: 502 },
                    );
                } else {
                    fileSizeBytes = offset;
                    session.fileSizeBytes = offset;
                    session.codecProfile = compactRecord({
                        ...asRecord(session.codecProfile),
                        fileSizeBytes: offset,
                    });
                    session.startupTimings = asRecord(session.startupTimings);
                    session.startupTimings.fileSizeBytes = offset;
                    session.startupTimings.fileSizeDiscoveredFromPlaybackGet = true;
                    session.startupTimings.fileSizePendingFullBodyEof = false;
                }
            } else if (offset < range.end + 1) {
                failure = vodInputPumpError(
                    'PROVIDER_CONNECTION_RESET',
                    'Provider ended the MKV byte range before its declared boundary.',
                    { status: 502, networkCause: 'premature_eof', retryable: true },
                );
            } else if (range.fullBodyRequiresExactEof === true) {
                await requireFullBodyExactEof(attempt, signal);
            }
        } catch (error) {
            failure = error;
        } finally {
            await closeVodInputAttempt(attempt);
        }

        if (signal.aborted || failure?.code === 'VOD_INPUT_ABORTED') throw abortedVodInputPumpError();
        // Exact-EOF validation happens after the final expected byte. Never let
        // the size-complete branch swallow an overrun, timeout, or read error.
        if (failure && fileSizeBytes && offset >= fileSizeBytes) throw failure;
        if (unknownLengthFullBodyEof) {
            if (failure) throw failure;
            break;
        }
        if (fileSizeBytes && offset >= fileSizeBytes) break;
        if (failure && failure.retryable !== true) throw failure;

        const progressBytes = offset - attemptOffset;
        // A provider may legally satisfy one large bounded request through many
        // smaller Content-Range responses. Any durable byte progress resets the
        // no-progress budget; the independent absolute reconnect cap still keeps
        // a pathological sequence bounded.
        consecutiveNoProgressFailures = progressBytes > 0
            ? 0
            : consecutiveNoProgressFailures + 1;
        if (consecutiveNoProgressFailures > VOD_INPUT_RETRY_LIMIT) {
            throw failure || vodInputPumpError(
                'PROVIDER_RECONNECT_EXHAUSTED',
                'Provider repeatedly returned no MKV data.',
                { status: 502 },
            );
        }
        reconnects += 1;
        if (reconnects > VOD_INPUT_MAX_RECONNECTS) {
            throw vodInputPumpError(
                'PROVIDER_RECONNECT_EXHAUSTED',
                'The MKV provider connection was interrupted too many times.',
                { status: 502 },
            );
        }
        vodInputPumpStats.reconnects += 1;
        const retryDelayMs = VOD_INPUT_RETRY_DELAYS_MS[Math.max(0, consecutiveNoProgressFailures - 1)] || 0;
        const requiresProviderReleaseWait = failure?.networkCause === 'timeout'
            || [502, 503, 504].includes(Number(failure?.upstreamStatus));
        const delayMs = requiresProviderReleaseWait
            ? Math.max(retryDelayMs, PROVIDER_SLOT_RELEASE_DELAY_MS)
            : retryDelayMs;
        if (!await waitForVodInputRetry(delayMs, signal)) throw abortedVodInputPumpError();
    }
    if (!prefixValidated || !fileSizeBytes || forwardedBytes !== fileSizeBytes) {
        throw vodInputPumpError('INVALID_MKV_INPUT', 'The bounded provider response did not contain one complete Matroska file.', { status: 502 });
    }
    await finishVodInput(writable, signal);
    const fullFilePacketMetrics = await finishMkvH264FullFileAnalyzer(fullFileAnalyzer);
    fullFileAnalyzerSettled = true;
    session.mkvH264FullFilePacketMetrics = fullFilePacketMetrics;
    maybeFinalizeMkvH264FastStartProof(session);
    return { bytesForwarded: forwardedBytes, reconnects, fullFilePacketProof: Boolean(session.mkvH264FastStartProofFinalized) };
    } finally {
        if (!fullFileAnalyzerSettled) {
            // Never replace the provider/primary/abort error with optional proof
            // cleanup. stopMkv... is bounded and deliberately non-throwing.
            await stopMkvH264FullFileAnalyzer(fullFileAnalyzer, 'pump-incomplete').catch(() => {});
        }
    }
}

function startBoundedMkvInputPump(session, writable) {
    const controller = new AbortController();
    const dispatcher = pickProxyAgent(proxyKeyFromUrl(session.sourceUrl)) || null;
    const pump = {
        controller,
        dispatcher,
        promise: null,
        completed: false,
        result: null,
        error: null,
    };
    vodInputPumpStats.starts += 1;
    pump.promise = runBoundedMkvInputPump(session, writable, controller.signal, dispatcher)
        .then((result) => {
            pump.result = result;
            vodInputPumpStats.completed += 1;
            vodInputPumpStats.last = { ok: true, ...result, at: new Date().toISOString() };
            return result;
        })
        .catch((error) => {
            pump.error = error;
            const captured = headerByteCache.get(session.sourceUrl);
            if (captured?.captureOwner === String(session?.id || session.sourceUrl)) {
                headerByteCache.delete(session.sourceUrl);
            }
            if (error?.code !== 'VOD_INPUT_ABORTED') {
                vodInputPumpStats.failures += 1;
                vodInputPumpStats.last = {
                    ok: false,
                    code: error?.code || 'VOD_INPUT_FAILED',
                    at: new Date().toISOString(),
                };
            }
            throw error;
        })
        .finally(() => { pump.completed = true; });
    session.inputPump = pump;
    return pump;
}

async function enrichSessionCodecProfileFromBoundedHeader(session, signal = null) {
    if (!BOUNDED_MKV_HEADER_PARSE || !isFiniteMkvVodSession(session)) return false;
    const currentHeaderAuthorityRequired = needsMkvH264CurrentHeaderAuthority(session);
    if (hasCompleteMkvPlaybackProfile(session?.codecProfile) && !currentHeaderAuthorityRequired) {
        const captured = headerByteCache.get(session.sourceUrl);
        if (captured?.captureOwner === String(session?.id || session.sourceUrl)) {
            headerByteCache.delete(session.sourceUrl);
        }
        return true;
    }

    const startedAt = Date.now();
    const capturedEntry = headerByteCache.get(session.sourceUrl);
    let local = null;
    try {
        // Bypass the general cache: a useful-but-partial historical entry must
        // not hide the fuller prefix captured by this exact playback.
        local = await probeFromHeaderBytes(session.sourceUrl, {
            signal,
            fileSizeBytes: fileSizeBytesForSession(session),
        });
    } finally {
        // The prefix is per-startup evidence. Release its bounded memory even
        // when a malformed/truncated header cannot be parsed.
        if (headerByteCache.get(session.sourceUrl) === capturedEntry) {
            headerByteCache.delete(session.sourceUrl);
        }
    }
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.inbandCodecProfileMs = Math.max(0, Date.now() - startedAt);
    if (!hasCompleteMkvPlaybackProfile(local)) {
        session.startupTimings.inbandCodecProfileApplied = false;
        session.startupTimings.inbandCodecProfileComplete = false;
        return false;
    }
    // The local ffprobe prefix cannot know the full source size, but the
    // bounded startup preflight already proved it exactly. Join both pieces of
    // evidence before caching/serializing so the next request has one complete
    // pre-spawn profile and can safely freeze a multi-audio graph.
    const exactLocal = compactRecord({
        ...local,
        fileSizeBytes: fileSizeBytesForSession(session),
    });
    cacheCodecProfile(session.sourceUrl, exactLocal);
    session.codecProfile = mergeCodecProfiles(session.codecProfile, exactLocal);
    session.mkvH264CurrentHeaderAuthority = {
        source: 'gateway-inband-current',
        captureOwner: String(session.id || ''),
        profileFingerprint: mkvH264FastStartProfileFingerprint(
            session.codecProfile,
            fileSizeBytesForSession(session),
        ),
    };
    if (
        !Number.isInteger(normalizeAudioStreamIndex(session.actualMappedAudioStreamIndex)) &&
        String(session.actualAudioMap || '').startsWith('0:a:0')
    ) {
        // `0:a:0` means the first audio stream in file order. Freeze that
        // actual index now that the local header supplied the exact map; never
        // relabel the already-running HLS as a later requested/default track.
        const tracks = Array.isArray(session.codecProfile?.audioTracks)
            ? session.codecProfile.audioTracks
            : [];
        const firstIndex = normalizeAudioStreamIndex(tracks[0]?.index);
        session.actualMappedAudioStreamIndex = Number.isInteger(firstIndex) ? firstIndex : null;
    }
    session.codecProfileSource = session.codecProfileSource
        ? `${session.codecProfileSource}+gateway_inband`
        : 'gateway_inband';
    const complete = hasCompleteMkvPlaybackProfile(session.codecProfile);
    session.startupTimings.inbandCodecProfileApplied = complete;
    session.startupTimings.inbandCodecProfileComplete = complete;
    // Finalization has two independent barriers: complete local metadata and
    // full-file packet metrics. Calling it here and at pump EOF makes either
    // completion order work without ever signing a prefix-only observation.
    maybeFinalizeMkvH264FastStartProof(session);
    session.startupTimings.mkvH264FastStartProofProduced = Boolean(
        session.mkvH264FastStartProofFinalized,
    );
    return complete;
}

function strongBoundedVodResponseValidator(response) {
    const etag = String(response?.headers?.get?.('etag') || '').trim();
    // RFC 9110 strong entity-tag: a quoted opaque tag, no weak prefix, control
    // bytes, embedded quote, or unbounded attacker-controlled header value.
    if (
        !etag || etag.length > 512 || /^W\//i.test(etag) ||
        !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)
    ) return null;
    return {
        type: 'etag-sha256',
        digest: crypto.createHash('sha256').update(etag).digest('hex'),
    };
}

async function stopBoundedMkvInputPump(session) {
    const pump = session?.inputPump;
    if (!pump) return;
    try { pump.controller.abort(); } catch (_) {}
    await pump.promise.catch(() => {});
    if (session.inputPump === pump) session.inputPump = null;
}

function startFfmpeg(session) {
    const multiAudioPlan = multiAudioHlsEnabled(session) ? session.multiAudioHls : null;
    const segmentPattern = path.join(
        session.outputDir,
        multiAudioPlan ? '%v-%05d.ts' : 'segment-%05d.ts',
    );
    const inputProbeArgs = inputProbeArgsForSession(session);
    // During the bounded fast path, require the already-known video/audio maps.
    // Otherwise FFmpeg's optional `?` can silently emit a video-only playlist
    // when the reduced probe misses a stream, making the fallback unreachable.
    // Keep the maps strict on the full-budget fallback too. That retry only
    // exists for a session previously judged exact; making its maps optional
    // could turn a stale track index into a silently video-only playlist.
    const requireKnownStreams =
        session.fastInputProbe === true ||
        session.forceFullInputProbe === true;
    const copyAudio = multiAudioPlan ? false : shouldCopyAudio(session);
    const audioArgs = audioArgsForSession(session, copyAudio);
    const audioMap = multiAudioPlan
        ? `0:${multiAudioPlan.defaultStreamIndex}`
        : audioMapForSession(session, requireKnownStreams);
    session.actualAudioMap = audioMap;
    const explicitAudioMap = /^0:(\d+)\??$/.exec(audioMap);
    session.actualMappedAudioStreamIndex = explicitAudioMap
        ? normalizeAudioStreamIndex(explicitAudioMap[1])
        : null;
    const encodeVideo = videoModeForSession(session) === 'encode';
    if (encodeVideo && !reserveVideoEncoderAdmission(session)) {
        const error = new Error('Video encoder capacity is busy');
        error.code = 'VIDEO_ENCODER_CAPACITY_BUSY';
        throw error;
    }
    const forceAlignedHlsVideoEncode = (
        session.forceExactMatroskaH264Reencode === true ||
        session.forceAlignedMultiAudioVideoEncode === true
    );
    const seekableMkvInput = usesFiniteMkvSeekBroker(session);
    const pumpedMkvInput = isFiniteMkvVodSession(session) && !seekableMkvInput;
    const preserveCopySeekTimestamps = usesSourceTimestampedCopySeek(session, encodeVideo, copyAudio);
    const { preInputSeek, postInputSeek } = seekArgsForSession(session, encodeVideo);
    const providerHttpInputArgs = pumpedMkvInput ? [] : (seekableMkvInput ? [
        '-seekable', '1',
        '-rw_timeout', '15000000',
    ] : [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        // Deliberately no -reconnect_on_http_error: provider/account 4xx is
        // terminal and must never create a retry cascade on a mono-slot account.
        '-reconnect_delay_max', '5',
        '-rw_timeout', '15000000',
        '-user_agent', session.userAgent || FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
    ]);
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-y',
        ...videoEncoderInputArgs(VIDEO_ENCODER_CONFIG, encodeVideo),
        ...providerHttpInputArgs,
        '-fflags', '+genpts',
        ...(preserveCopySeekTimestamps ? ['-copyts'] : []),
        ...inputProbeArgs,
        ...preInputSeek,
        '-i', pumpedMkvInput
            ? 'pipe:0'
            : (seekableMkvInput ? session.finiteMkvSeekBroker.inputUrl : session.sourceUrl),
        ...postInputSeek,
        // Uppercase V excludes attached pictures. A cover-art stream must
        // never become the playable video lane or a second HLS video stream.
        '-map', (requireKnownStreams || multiAudioPlan) ? '0:V:0' : '0:V:0?',
        ...(multiAudioPlan
            ? multiAudioPlan.audioRenditions.flatMap((rendition) => [
                '-map', `0:${rendition.streamIndex}`,
            ])
            : ['-map', audioMap]),
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
            ...videoEncoderOutputArgs(VIDEO_ENCODER_CONFIG, {
                forceAligned: forceAlignedHlsVideoEncode,
                targetSeconds: session.hlsTargetSeconds || 4,
            }),
            ...audioArgs
        );
    } else {
        args.push(
            '-c:v', 'copy',
            ...audioArgs
        );
    }

    const hlsOutputArgs = [
        '-fps_mode', 'passthrough',
        ...(preserveCopySeekTimestamps
            ? ['-avoid_negative_ts', 'disabled', '-mpegts_copyts', '1', '-muxpreload', '0', '-muxdelay', '0']
            : []),
        '-f', 'hls',
        '-hls_time', String(session.hlsTargetSeconds || 4),
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
        ...(multiAudioPlan
            ? [
                '-master_pl_name', multiAudioPlan.masterPlaylistName,
                '-var_stream_map', multiAudioPlan.varStreamMap,
                path.join(session.outputDir, '%v.m3u8'),
            ]
            : [session.playlistPath])
    ];
    args.push(...hlsOutputArgs);

    appendSubtitleOutputs(args, session, postInputSeek);

    let child;
    try {
        child = spawn(FFMPEG_PATH, args, {
            stdio: [pumpedMkvInput ? 'pipe' : 'ignore', 'ignore', 'pipe'],
            env: pumpedMkvInput
                ? undefined
                : (seekableMkvInput
                    ? loopbackOnlyEnv()
                    : proxyEnvFor(proxyKeyFromUrl(session.sourceUrl))),
        });
    } catch (error) {
        releaseVideoEncoderAdmission(session);
        throw error;
    }
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.ffmpegSpawnCount = Number(session.startupTimings.ffmpegSpawnCount || 0) + 1;
    session.startupTimings.videoEncoder = VIDEO_ENCODER_CONFIG.backend;
    session.status = 'starting';
    let inputPump = null;

    child.stderr.on('data', (chunk) => {
        const text = sanitizeLog(chunk.toString(), session.sourceUrl);
        appendLogTail(session, text);
        if (text.trim()) console.warn(`[ffmpeg:${session.id}] ${text.trim()}`);
    });

    child.on('error', (err) => {
        try { inputPump?.controller.abort(); } catch (_) {}
        const brokerFailure = applyFiniteMkvSeekBrokerFailure(session);
        releaseVideoEncoderAdmission(session);
        session.status = 'failed';
        if (!brokerFailure) session.lastError = err.message;
        console.error(`[ffmpeg:${session.id}] failed to start:`, err.message);
        wakePlaybackBlockedQueues();
        if (session.backgroundCacheContinuation === true) {
            setImmediate(() => stopSession(session, { reason: 'background-failed' }).catch(() => {}));
        }
    });

    child.on('exit', (code, signal) => {
        releaseVideoEncoderAdmission(session);
        applyFiniteMkvSeekBrokerFailure(session);
        const inputEndedEarly = pumpedMkvInput && inputPump && inputPump.completed !== true;
        const completedCleanly = code === 0 && !inputEndedEarly && !session.inputFailure && !session.lastError;
        session.completeHlsCacheFfmpegCompletedCleanly = completedCleanly;
        try { inputPump?.controller.abort(); } catch (_) {}
        if (session.status !== 'ended' && (code !== 0 || inputEndedEarly)) {
            session.status = 'failed';
            if (!session.inputFailure) {
                const reason = lastNonEmptyLine(session.logTail);
                session.lastError = `FFmpeg exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${reason ? `: ${reason}` : ''}`;
            }
        } else if (session.status !== 'failed') {
            session.status = 'ended';
        }
        wakePlaybackBlockedQueues();
    });

    child.on('close', () => {
        // `close` follows process exit and stdio drainage. Only then are every
        // playlist and segment immutable enough for complete-cache collection.
        if (session.completeHlsCacheFfmpegCompletedCleanly === true) {
            session.completeHlsCacheMediaReady = true;
            scheduleMkvCompleteHlsCachePromotion(session);
            if (session.backgroundCacheContinuation === true) {
                setImmediate(() => finishMkvCompleteHlsBackgroundContinuation(session));
            }
        } else if (session.backgroundCacheContinuation === true) {
            setImmediate(() => stopSession(session, { reason: 'background-failed' }).catch(() => {}));
        }
    });

    if (pumpedMkvInput) {
        // Prevent an EPIPE emitted during an explicit stop from becoming an
        // unhandled stream error; the pump's write/drain races own classification.
        child.stdin.on('error', () => {});
        inputPump = startBoundedMkvInputPump(session, child.stdin);
        inputPump.promise.catch(async (error) => {
            if (
                error?.code === 'VOD_INPUT_ABORTED' ||
                session.status === 'stopping' ||
                session.status === 'ended'
            ) return;
            session.inputFailure = {
                status: Number.isInteger(error?.status) ? error.status : 502,
                code: error?.code || 'VOD_INPUT_FAILED',
                upstreamStatus: Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : null,
                networkCause: error?.networkCause || null,
            };
            const safeMessage = sanitizeLog(error?.message || 'Finite MKV input failed', session.sourceUrl);
            session.lastError = `${session.inputFailure.code}: ${safeMessage}`;
            appendLogTail(session, session.lastError);
            session.status = 'stopping';
            try { child.stdin.destroy(); } catch (_) {}
            await stopChildProcess(child).catch(() => {});
            if (session.status === 'stopping') session.status = 'failed';
            wakePlaybackBlockedQueues();
        });
    }

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
    // A resumed finite MKV is exposed to FFmpeg only through the private,
    // serialized loopback range broker. Input seeking can therefore use the
    // Matroska cue index without revealing the provider URL or opening two
    // provider sockets concurrently. Resumed MKV sessions remain forced to
    // encode so the exact requested output boundary stays frame-accurate.
    if (isFiniteMkvVodSession(session)) {
        if (usesFiniteMkvSeekBroker(session)) {
            return { preInputSeek: ['-ss', String(seekOffset)], postInputSeek: [] };
        }
        // Fail-safe fallback for incomplete setup/tests: a finite MKV without
        // its broker retains the historical linear post-input seek.
        return { preInputSeek: [], postInputSeek: ['-ss', String(seekOffset)] };
    }
    // Copy mode can't decode, so it must input-seek. That's fine: copy is only
    // used for browser-safe MP4, which carries a real index and seeks cleanly.
    if (!encodeVideo) {
        return { preInputSeek: ['-ss', String(seekOffset)], postInputSeek: [] };
    }
    // Legacy encode inputs retain their proven linear-read fallback.
    return {
        preInputSeek: ['-seekable', '0'],
        postInputSeek: ['-ss', String(seekOffset)],
    };
}

function usesSourceTimestampedCopySeek(session, encodeVideo = videoModeForSession(session) === 'encode', copyAudio = shouldCopyAudio(session)) {
    // `-copyts` must cover every A/V output on the same clock. When video is
    // copied but audio is encoded (for example H.264 + E-AC-3 -> AAC), FFmpeg
    // preserves the video's absolute source PTS while the audio encoder starts
    // at zero. The resulting HLS segment advertises two incompatible timelines:
    // Chromium waits outside the playable intersection and appears to jump far
    // beyond the requested resume point. Let FFmpeg rebase both tracks together
    // in that mixed copy/encode case. Source-timestamp measurement remains useful
    // only when both selected A/V streams are copied unchanged.
    return !encodeVideo && copyAudio && Number(session.seekOffset) > 0;
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
    const knownFast = !live && knownVodInputProbeEligible(session);
    session.fastInputProbe = knownFast;
    if (live) sessionStartupStats.liveInputProbeAttempts += 1;
    else if (knownFast) sessionStartupStats.fastInputProbeAttempts += 1;
    else sessionStartupStats.fullInputProbeAttempts += 1;
    return [
        '-analyzeduration', String(
            live
                ? LIVE_INPUT_ANALYZE_DURATION_US
                : knownFast
                    ? KNOWN_VOD_INPUT_ANALYZE_DURATION_US
                    : VOD_INPUT_ANALYZE_DURATION_US
        ),
        '-probesize', String(
            live
                ? LIVE_INPUT_PROBE_SIZE_BYTES
                : knownFast
                    ? KNOWN_VOD_INPUT_PROBE_SIZE_BYTES
                    : VOD_INPUT_PROBE_SIZE_BYTES
        )
    ];
}

function knownVodInputProbeEligible(session) {
    if (
        !KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED ||
        !session ||
        session.forceFullInputProbe === true
    ) return false;
    const hint = asRecord(session.playbackHint);
    const profile = asRecord(session.codecProfile);
    const profileSource = String(session.codecProfileSource || '').toLowerCase();
    // Flattened transport hints are useful routing evidence but are not a full
    // demux map. Only a detailed catalogue profile or a completed gateway probe
    // may unlock the reduced FFmpeg discovery budget.
    const detailedProfileSource = profileSource === 'request'
        || profileSource.includes('gateway_probe');
    if (!detailedProfileSource) return false;
    const container = normalizeCodecToken(hint.container || profile.container).split(',')[0];
    // This is a VOD demux optimization, never a live-stream shortcut. Restrict
    // it to finite file containers for which the full-budget fallback below is
    // safe when an allegedly exact profile turns out to be stale.
    if (!['mp4', 'm4v', 'mov', 'mkv', 'matroska', 'webm', 'avi'].includes(container)) return false;

    const videoCodec = stringOrNull(
        session.videoCodec ||
        profile.videoCodec ||
        profile.video_codec ||
        profile.video
    );
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : []);
    const requestedAudioIndex = nullableInt(session.audioStreamIndex);
    if (
        Number.isInteger(requestedAudioIndex) &&
        audioTracks.length > 0 &&
        !audioTracks.some((track) => nullableInt(track?.index) === requestedAudioIndex)
    ) return false;
    const selectedAudio = selectedAudioTrackForSession(session);
    const selectedAudioIndex = nullableInt(
        requestedAudioIndex ?? selectedAudio?.index
    );
    const audioCodec = stringOrNull(
        selectedAudio?.codec ||
        session.audioCodec ||
        profile.audioCodec ||
        profile.audio_codec ||
        profile.audio
    );
    // An explicit/default absolute map is ideal. When the exact profile proves
    // an audio codec but carries no track array, strict `0:a:0` is still a
    // deterministic map and avoids discovering the same MP4 twice.
    const deterministicAudioMap = Number.isInteger(selectedAudioIndex) || (
        audioTracks.length === 0 && Boolean(audioCodec)
    );
    return Boolean(videoCodec && audioCodec && deterministicAudioMap);
}

function isInsufficientInputProbeFailure(session) {
    // FFmpeg's exit callback can reduce lastError to the terminal
    // "Conversion failed!" line while the actionable map/codec diagnostic is
    // still present a few lines earlier in logTail.
    const text = `${String(session?.lastError || '')}\n${String(session?.logTail || '')}`.toLowerCase();
    return text.includes('matches no streams')
        || text.includes('could not find codec parameters')
        || text.includes('does not contain any stream')
        || text.includes('invalid data found when processing input');
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

// An H.264 stream can be browser-decodable yet still be unsuitable for copied
// HLS when its source GOP is longer than the startup budget. The exact-file
// profile does not currently expose GOP length, so the safe deployable boundary
// is the complete, dated Matroska profile received with the authenticated session
// request. Unknown/partial profiles, profiles learned only after Gateway ffprobe,
// MP4 and live inputs retain their existing route.
function shouldReencodeExactMatroskaH264(session) {
    if (isLiveSession(session)) return false;
    if (String(session.codecProfileSource || '').toLowerCase() !== 'request') return false;

    const profile = asRecord(session.codecProfile);
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : null);
    const subtitles = Array.isArray(profile.subtitles)
        ? profile.subtitles
        : (Array.isArray(profile.subtitleTracks)
            ? profile.subtitleTracks
            : (Array.isArray(profile.subtitle_tracks) ? profile.subtitle_tracks : null));
    if (!audioTracks || !subtitles) return false;

    const probeSource = normalizeCodecToken(profile.probeSource ?? profile.probe_source);
    if (!['gatewayprobe', 'exactfileprobe', 'exactfilecodecprobe'].includes(probeSource)) return false;
    const probedAt = Date.parse(String(profile.probedAt ?? profile.probed_at ?? ''));
    if (!Number.isFinite(probedAt)) return false;

    const durationSeconds = Number(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;

    // The one-thread 1080p fixture is proven comfortably realtime. 4K has no
    // equivalent capacity proof on the production replica, so dimensions are a
    // hard fail-closed boundary rather than an invitation to saturate the box.
    const videoWidth = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const videoHeight = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    if (!Number.isInteger(videoWidth) || !Number.isInteger(videoHeight) || videoWidth <= 0 || videoHeight <= 0) return false;
    if (
        videoWidth > EXACT_MATROSKA_H264_MAX_WIDTH ||
        videoHeight > EXACT_MATROSKA_H264_MAX_HEIGHT ||
        videoWidth * videoHeight > EXACT_MATROSKA_H264_MAX_PIXELS
    ) return false;

    const container = normalizeCodecToken(profile.container);
    if (!(container.includes('matroska') || container === 'mkv')) return false;
    const videoCodec = normalizeCodecToken(profile.videoCodec ?? profile.video_codec ?? profile.video);
    return videoCodec.includes('h264') || videoCodec.includes('avc');
}

function mkvH264FastStartProofForProfile(profile) {
    const record = asRecord(profile);
    const envelope = record.mkvH264FastStartProof;
    return typeof envelope === 'string' && envelope.length > 0 && envelope.length <= 16_384
        ? envelope
        : null;
}

function mkvH264FastStartProfileFingerprint(profile, fileSizeOverride = null) {
    const record = asRecord(profile);
    const fileSizeBytes = Number(
        fileSizeOverride ??
        record.fileSizeBytes ??
        record.file_size_bytes
    );
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) return null;
    const audioTracks = (Array.isArray(record.audioTracks)
        ? record.audioTracks
        : (Array.isArray(record.audio_tracks) ? record.audio_tracks : []))
        .map((track) => ({
            index: Number(track?.index),
            codec: normalizeCodecToken(track?.codec),
            profile: normalizeCodecToken(track?.profile),
            channels: Number(track?.channels),
            sampleRate: Number(track?.sampleRate ?? track?.sample_rate),
            channelLayout: normalizeCodecToken(track?.channelLayout ?? track?.channel_layout),
            default: track?.default === true,
        }))
        .sort((left, right) => left.index - right.index);
    const subtitles = (Array.isArray(record.subtitles)
        ? record.subtitles
        : (Array.isArray(record.subtitleTracks)
            ? record.subtitleTracks
            : (Array.isArray(record.subtitle_tracks) ? record.subtitle_tracks : [])))
        .map((track) => ({
            index: Number(track?.index),
            codec: normalizeCodecToken(track?.codec),
        }))
        .sort((left, right) => left.index - right.index);
    const material = {
        protocol: MKV_H264_FAST_START_PROTOCOL,
        metadataComplete: record.metadataComplete === true || record.metadata_complete === true,
        fileSizeBytes,
        container: normalizeCodecToken(record.container),
        durationSeconds: Number(record.durationSeconds ?? record.duration_seconds ?? record.duration),
        videoStreamIndex: Number(record.videoStreamIndex ?? record.video_stream_index),
        videoCodec: normalizeCodecToken(record.videoCodec ?? record.video_codec ?? record.video),
        videoProfile: normalizeCodecToken(record.videoProfile ?? record.video_profile),
        videoPixelFormat: normalizeCodecToken(record.videoPixelFormat ?? record.video_pixel_format ?? record.pix_fmt),
        videoWidth: Number(record.videoWidth ?? record.video_width ?? record.width),
        videoHeight: Number(record.videoHeight ?? record.video_height ?? record.height),
        audioCodec: normalizeCodecToken(record.audioCodec ?? record.audio_codec ?? record.audio),
        audioProfile: normalizeCodecToken(record.audioProfile ?? record.audio_profile),
        audioChannels: Number(record.audioChannels ?? record.audio_channels ?? record.channels),
        audioSampleRate: Number(record.audioSampleRate ?? record.audio_sample_rate),
        audioChannelLayout: normalizeCodecToken(record.audioChannelLayout ?? record.audio_channel_layout),
        audioTracks,
        subtitles,
    };
    return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

const MKV_H264_FAST_START_PROOF_DOMAIN = Buffer.from('NORVA/MKV-H264-FASTSTART/V2\0', 'utf8');
const MKV_H264_FAST_START_ANALYZER_TYPE = 'ffprobe-key-packets-plus-ffmpeg-idr-framecrc-v2';
const MKV_H264_FAST_START_ANALYZER_DIGEST = crypto.createHash('sha256')
    .update([
        'ffprobe-key-packets-plus-ffmpeg-idr-framecrc-v2',
        'stream-select:ffprobe=V:0,ffmpeg=0:V:0',
        'ffprobe:packet=stream_index,pts,dts,duration,flags',
        'ffprobe:stream=index,time_base,profile,level,refs,r_frame_rate,avg_frame_rate,pix_fmt,width,height',
        'ffmpeg:-copyts,-copytb=1,-avoid_negative_ts=disabled',
        'bsf:h264_mp4toannexb,filter_units=pass_types=5',
        'timeline:relative-pts0,dts1,duration,time-base-microseconds',
    ].join('|'))
    .digest('hex');

function exactRecordKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalBase64urlBytes(value, maximumBytes) {
    const encoded = String(value || '');
    if (!encoded || encoded.includes('=') || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    let decoded;
    try { decoded = Buffer.from(encoded, 'base64url'); } catch (_) { return null; }
    if (!decoded.length || decoded.length > maximumBytes || decoded.toString('base64url') !== encoded) return null;
    return decoded;
}

function mkvH264FastStartProofMac(payloadBytes, key) {
    return crypto.createHmac('sha256', key)
        .update(MKV_H264_FAST_START_PROOF_DOMAIN)
        .update(payloadBytes)
        .digest();
}

function sealMkvH264FastStartProof(payload) {
    if (!MKV_H264_FAST_START_PROOF_CURRENT_KEY) return null;
    const canonical = Buffer.from(stableJson(payload), 'utf8');
    const mac = mkvH264FastStartProofMac(canonical, MKV_H264_FAST_START_PROOF_CURRENT_KEY);
    return `${canonical.toString('base64url')}.${mac.toString('base64url')}`;
}

function openMkvH264FastStartProof(envelope) {
    if (typeof envelope !== 'string' || envelope.length > 16_384) return null;
    const parts = envelope.split('.');
    if (parts.length !== 2) return null;
    const payloadBytes = canonicalBase64urlBytes(parts[0], 12_000);
    const suppliedMac = canonicalBase64urlBytes(parts[1], 32);
    if (!payloadBytes || !suppliedMac || suppliedMac.length !== 32) return null;

    // Calculate every configured MAC before parsing attacker-controlled JSON.
    // This keeps current/previous-key rotation from becoming a parse oracle.
    const matches = MKV_H264_FAST_START_PROOF_VERIFICATION_KEYS.map(({ key, kid }) => ({
        kid,
        matched: crypto.timingSafeEqual(mkvH264FastStartProofMac(payloadBytes, key), suppliedMac),
    }));
    const matched = matches.find((entry) => entry.matched);
    if (!matched) return null;

    let payloadText;
    let payload;
    try {
        payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
        payload = JSON.parse(payloadText);
    } catch (_) {
        return null;
    }
    if (stableJson(payload) !== payloadText) return null;
    if (!exactRecordKeys(payload, [
        'protocol', 'kid', 'scope', 'sourceUrlSha256', 'effectiveUrlSha256',
        'providerScopeSha256', 'tenantScopeSha256', 'itemScopeSha256',
        'fileSizeBytes', 'profileFingerprint', 'validator', 'metrics', 'analyzer',
        'issuedAtMs', 'expiresAtMs', 'build',
    ])) return null;
    if (!exactRecordKeys(payload.validator, ['type', 'digest'])) return null;
    if (!exactRecordKeys(payload.analyzer, ['type', 'digest'])) return null;
    if (!exactRecordKeys(payload.metrics, [
        'bytesAnalyzed', 'packetCount', 'videoStreamIndex', 'keyframeCount', 'firstPacketKeyframe',
        'idrCount', 'keyTimelineSha256', 'idrTimelineSha256', 'closedGopIdrVerified',
        'coverageSeconds', 'maxKeyframeGapSeconds', 'ptsPresent', 'dtsPresent',
        'dtsMonotonic', 'muxTimestampsSafe', 'negativeTimestampCount',
        'timestampDiscontinuityCount', 'firstPtsSeconds', 'firstDtsSeconds',
        'maxPtsDtsSkewSeconds', 'leadingMissingDtsCount',
        'streamTimeBaseNumerator', 'streamTimeBaseDenominator',
        'videoProfile', 'videoLevel', 'videoRefs',
        'videoFpsNumerator', 'videoFpsDenominator',
        'videoWidth', 'videoHeight', 'videoPixelFormat',
    ])) return null;
    if (payload.kid !== matched.kid) return null;
    return payload;
}

const MKV_COMPLETE_HLS_CACHE_LOCATOR_DOMAIN = Buffer.from(
    'NORVA/MKV-COMPLETE-HLS-CACHE/LOCATOR/V1\0',
    'utf8',
);

function mkvCompleteHlsCacheLocatorKeyId(key) {
    return key
        ? crypto.createHash('sha256')
            .update('NORVA/MKV-COMPLETE-HLS-CACHE/LOCATOR/V1/KID\0')
            .update(key)
            .digest('hex')
        : null;
}

function mkvCompleteHlsCacheProofForProfile(profile) {
    const record = asRecord(profile);
    const envelope = record.mkvCompleteHlsCacheProof;
    return typeof envelope === 'string' && envelope.length > 0 && envelope.length <= 8_192
        ? envelope
        : null;
}

function mkvCompleteHlsCacheLocatorMac(payloadBytes) {
    if (!MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY) return null;
    return crypto.createHmac('sha256', MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY)
        .update(MKV_COMPLETE_HLS_CACHE_LOCATOR_DOMAIN)
        .update(payloadBytes)
        .digest();
}

function sealMkvCompleteHlsCacheProof(payload) {
    const canonical = Buffer.from(stableJson(payload), 'utf8');
    const mac = mkvCompleteHlsCacheLocatorMac(canonical);
    return mac ? `${canonical.toString('base64url')}.${mac.toString('base64url')}` : null;
}

function openMkvCompleteHlsCacheProof(envelope) {
    if (!MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY || typeof envelope !== 'string' || envelope.length > 8_192) return null;
    const parts = envelope.split('.');
    if (parts.length !== 2) return null;
    const payloadBytes = canonicalBase64urlBytes(parts[0], 6_000);
    const suppliedMac = canonicalBase64urlBytes(parts[1], 32);
    if (!payloadBytes || !suppliedMac || suppliedMac.length !== 32) return null;
    const expectedMac = mkvCompleteHlsCacheLocatorMac(payloadBytes);
    if (!expectedMac || !crypto.timingSafeEqual(expectedMac, suppliedMac)) return null;
    let payloadText;
    let payload;
    try {
        payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
        payload = JSON.parse(payloadText);
    } catch (_) {
        return null;
    }
    if (stableJson(payload) !== payloadText || !exactRecordKeys(payload, [
        'protocol', 'kid', 'scope', 'sourceUrlSha256', 'effectiveUrlSha256',
        'providerScopeSha256', 'tenantScopeSha256', 'itemScopeSha256',
        'strongEtagSha256', 'fileSizeBytes', 'profileFingerprint',
        'pipelineBuild', 'issuedAtMs', 'expiresAtMs', 'build',
    ])) return null;
    if (payload.kid !== mkvCompleteHlsCacheLocatorKeyId(MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY)) return null;
    return payload;
}

function mkvCompleteHlsCacheAudioTopology(session, audioTracks) {
    const reject = (reason) => ({ eligible: false, reason });
    if (!Array.isArray(audioTracks) || audioTracks.length < 1) return reject('missing-audio');
    if (audioTracks.length > MAX_MULTI_AUDIO_RENDITIONS) return reject('audio-track-cap-exceeded');

    if (audioTracks.length === 1) {
        const onlyTrack = asRecord(audioTracks[0]);
        const requestedStreamIndex = normalizeAudioStreamIndex(session?.audioStreamIndex);
        const sourceStreamIndex = normalizeAudioStreamIndex(onlyTrack.index);
        if (!Number.isInteger(sourceStreamIndex)) return reject('invalid-audio-stream-index');
        if (Number.isInteger(requestedStreamIndex) && requestedStreamIndex !== sourceStreamIndex) {
            return reject('selected-audio-stream-mismatch');
        }
        return {
            eligible: true,
            reason: 'single-audio',
            topology: {
                kind: 'single-audio',
                streamIndex: sourceStreamIndex,
                requestedStreamIndex,
                audioModeHint: normalizeCodecToken(session?.audioMode),
                clientAudioPassthrough: session?.clientAudioPassthrough !== false,
            },
        };
    }

    const plan = buildMultiAudioHlsPlan(session);
    if (plan.enabled !== true) return reject(`multi-audio-${String(plan.reason || 'ineligible')}`);
    if (!Array.isArray(plan.audioRenditions) || plan.audioRenditions.length !== audioTracks.length) {
        return reject('multi-audio-topology-drift');
    }
    return {
        eligible: true,
        reason: 'multi-audio',
        topology: {
            kind: 'multi-audio',
            protocol: MULTI_AUDIO_HLS_PROTOCOL,
            defaultHlsIndex: plan.defaultHlsIndex,
            defaultStreamIndex: plan.defaultStreamIndex,
            videoPlaylistName: plan.videoPlaylistName,
            audioRenditions: plan.audioRenditions.map((rendition) => ({
                hlsIndex: rendition.hlsIndex,
                streamIndex: rendition.streamIndex,
                language: rendition.language,
                title: rendition.title,
                sourceChannels: rendition.sourceChannels,
                outputChannels: rendition.outputChannels,
                codec: rendition.codec,
            })),
        },
    };
}

function mkvCompleteHlsCacheStaticContext(session) {
    const reject = (reason) => ({ eligible: false, reason });
    if (session?.completeHlsCachePolicy === 'bypass') return reject('cache-bypass');
    if (!isFiniteMkvVodSession(session) || isLiveSession(session)) return reject('not-finite-mkv');
    if (Number(session?.seekOffset || 0) > 0) return reject('seek');
    const identity = mkvH264FastStartIdentityContext(session);
    if (!identity) return reject('missing-server-identity');
    const profile = asRecord(session?.codecProfile);
    if (profile.metadataComplete !== true && profile.metadata_complete !== true) return reject('incomplete-profile');
    const fileSizeBytes = Number(
        profile.fileSizeBytes ?? profile.file_size_bytes ?? session?.startupTimings?.fileSizeBytes,
    );
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) return reject('unknown-file-size');
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : []);
    const subtitles = Array.isArray(profile.subtitles)
        ? profile.subtitles
        : (Array.isArray(profile.subtitleTracks)
            ? profile.subtitleTracks
            : (Array.isArray(profile.subtitle_tracks) ? profile.subtitle_tracks : []));
    // Detached subtitle assets are not part of the authenticated HLS graph yet.
    // Audio, however, is safe for both one rendition and the exact bounded
    // multi-audio master graph because every output playlist/segment is walked
    // and hashed by collectCompleteHlsSessionAssets before publication.
    if (subtitles.length > 0) return reject('subtitle-assets-not-cacheable');
    const audioTopology = mkvCompleteHlsCacheAudioTopology(session, audioTracks);
    if (!audioTopology.eligible) return reject(audioTopology.reason);
    const structuralProfile = mkvH264FastStartProfileFingerprint(profile, fileSizeBytes);
    if (!structuralProfile) return reject('profile-fingerprint-unavailable');
    const profileFingerprint = sha256Hex(stableJson({
        schema: 'mkv-complete-hls-profile-v2',
        structuralProfile,
        requestedMode: session?.mode === 'transcode' ? 'transcode' : 'remux',
        audioTopology: audioTopology.topology,
    }));
    return {
        eligible: true,
        reason: 'complete-cache-profile-accepted',
        identity,
        profile,
        fileSizeBytes,
        profileFingerprint,
        audioTopology: audioTopology.topology,
    };
}

function cloneMkvCompleteHlsCacheProfile(profile) {
    try {
        const serialized = JSON.stringify(asRecord(profile));
        if (
            !serialized ||
            Buffer.byteLength(serialized, 'utf8') > MKV_COMPLETE_HLS_CACHE_PROFILE_SNAPSHOT_MAX_BYTES
        ) return null;
        const cloned = JSON.parse(serialized);
        return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : null;
    } catch (_) {
        return null;
    }
}

function mkvCompleteHlsCachePipelineBuildForSession(session, staticContext = null) {
    const context = staticContext?.eligible === true
        ? staticContext
        : mkvCompleteHlsCacheStaticContext(session);
    if (!context?.eligible) return null;
    const multiAudio = context.audioTopology?.kind === 'multi-audio';
    const videoMode = multiAudio ? 'encode' : videoModeForSession(session);
    const audioMode = multiAudio
        ? `multi-aac-${context.audioTopology.audioRenditions.length}`
        : audioModeForSession(session);
    // A lookup is evaluated before the live session object exists, so it does
    // not carry the later `freezeMultiAudioHlsTopology` mutation. Multi-audio
    // always uses the exact aligned two-second target; derive that value from
    // the authenticated topology on both publish and lookup instead of relying
    // on an internal session field that is absent on zero-provider cache hits.
    const targetSeconds = multiAudio
        ? EXACT_MATROSKA_H264_HLS_TARGET_SECONDS
        : Number(session?.hlsTargetSeconds || 4);
    if (!['copy', 'encode'].includes(videoMode)) return null;
    if (!multiAudio && !['copy', 'transcode'].includes(audioMode)) return null;
    if (!Number.isInteger(targetSeconds) || targetSeconds < 1 || targetSeconds > 30) return null;
    return `${MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD}:video-${videoMode}:audio-${audioMode}:target-${targetSeconds}`;
}

function buildMkvCompleteHlsCacheLocator(session, nowMs = Date.now()) {
    const codecProfileSnapshot = cloneMkvCompleteHlsCacheProfile(session?.codecProfile);
    if (!codecProfileSnapshot) return null;
    // Fingerprint the serializable snapshot that will be returned on cleanup,
    // not a live object that another async phase may enrich during publication.
    const context = mkvCompleteHlsCacheStaticContext({
        ...session,
        codecProfile: codecProfileSnapshot,
    });
    const validator = asRecord(session?.vodInputStrongValidator);
    const pipelineBuild = mkvCompleteHlsCachePipelineBuildForSession(session, context);
    if (
        !mkvCompleteHlsCache || !MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY || !context.eligible || !pipelineBuild ||
        session?.inputPump?.completed !== true || session?.inputFailure || session?.lastError ||
        validator.type !== 'etag-sha256' || !/^[a-f0-9]{64}$/.test(String(validator.digest || '')) ||
        !/^[a-f0-9]{64}$/.test(String(session?.vodInputEffectiveUrlSha256 || ''))
    ) return null;
    const payload = {
        protocol: MKV_COMPLETE_HLS_CACHE_PROTOCOL,
        kid: mkvCompleteHlsCacheLocatorKeyId(MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY),
        scope: 'complete-hls',
        sourceUrlSha256: sha256Hex(String(session.sourceUrl || '')),
        effectiveUrlSha256: String(session.vodInputEffectiveUrlSha256),
        providerScopeSha256: sha256Hex(String(session.providerSlotKey || '')),
        tenantScopeSha256: context.identity.tenantScopeSha256,
        itemScopeSha256: context.identity.itemScopeSha256,
        strongEtagSha256: validator.digest,
        fileSizeBytes: context.fileSizeBytes,
        profileFingerprint: context.profileFingerprint,
        pipelineBuild,
        issuedAtMs: Number(nowMs),
        expiresAtMs: Number(nowMs) + MKV_COMPLETE_HLS_CACHE_TTL_MS,
        build: MKV_COMPLETE_HLS_CACHE_LOCATOR_BUILD,
    };
    if (!Number.isSafeInteger(payload.issuedAtMs) || payload.issuedAtMs <= 0 ||
        !Number.isSafeInteger(payload.expiresAtMs) || payload.expiresAtMs <= payload.issuedAtMs) return null;
    const envelope = sealMkvCompleteHlsCacheProof(payload);
    if (!envelope) return null;
    return {
        envelope,
        payload,
        context,
        codecProfileSnapshot,
        binding: {
            tenantScopeSha256: payload.tenantScopeSha256,
            providerScopeSha256: payload.providerScopeSha256,
            itemScopeSha256: payload.itemScopeSha256,
            sourceUrlSha256: payload.sourceUrlSha256,
            effectiveUrlSha256: payload.effectiveUrlSha256,
            strongEtagSha256: payload.strongEtagSha256,
            profileFingerprint: payload.profileFingerprint,
            fileSizeBytes: payload.fileSizeBytes,
            pipelineBuild: payload.pipelineBuild,
            proofBuild: payload.build,
        },
    };
}

function verifiedGenericMkvCompleteCacheBinding(session, nowMs = Date.now()) {
    const reject = (reason, hasProof = false) => ({ eligible: false, reason, hasProof });
    if (!mkvCompleteHlsCache) return reject('cache-disabled');
    // A complete local HLS snapshot is the seekable rendition itself. The
    // requested playback offset must not invalidate its immutable identity:
    // cache admission still binds source/provider/tenant/item/profile/graph,
    // while the player seeks inside the already-complete playlist locally.
    // Keep the strict `seek` rejection in mkvCompleteHlsCacheStaticContext for
    // publication/training paths; relax it only for this verified lookup.
    const cacheLookupSession = Number(session?.seekOffset || 0) > 0
        ? { ...session, seekOffset: 0 }
        : session;
    const context = mkvCompleteHlsCacheStaticContext(cacheLookupSession);
    if (!context.eligible) return reject(context.reason);
    const envelope = mkvCompleteHlsCacheProofForProfile(context.profile);
    if (!envelope) return reject('missing-cache-proof');
    const proof = openMkvCompleteHlsCacheProof(envelope);
    if (!proof) return reject('invalid-cache-proof', true);
    const expectedPipelineBuild = mkvCompleteHlsCachePipelineBuildForSession(cacheLookupSession, context);
    if (
        proof.protocol !== MKV_COMPLETE_HLS_CACHE_PROTOCOL || proof.scope !== 'complete-hls' ||
        proof.build !== MKV_COMPLETE_HLS_CACHE_LOCATOR_BUILD ||
        !Number.isSafeInteger(proof.issuedAtMs) || proof.issuedAtMs <= 0 ||
        !Number.isSafeInteger(proof.expiresAtMs) || proof.expiresAtMs <= proof.issuedAtMs ||
        proof.expiresAtMs - proof.issuedAtMs > MKV_COMPLETE_HLS_CACHE_TTL_MS ||
        proof.issuedAtMs > Number(nowMs) + MKV_H264_FAST_START_PROOF_FUTURE_SKEW_MS ||
        Number(nowMs) > proof.expiresAtMs ||
        typeof proof.pipelineBuild !== 'string' ||
        proof.pipelineBuild !== expectedPipelineBuild
    ) return reject('stale-or-unsupported-cache-proof', true);
    if (proof.sourceUrlSha256 !== sha256Hex(String(session.sourceUrl || ''))) return reject('cache-proof-source-mismatch', true);
    if (proof.providerScopeSha256 !== sha256Hex(String(session.providerSlotKey || ''))) return reject('cache-proof-provider-mismatch', true);
    if (proof.tenantScopeSha256 !== context.identity.tenantScopeSha256) return reject('cache-proof-tenant-mismatch', true);
    if (proof.itemScopeSha256 !== context.identity.itemScopeSha256) return reject('cache-proof-item-mismatch', true);
    if (proof.fileSizeBytes !== context.fileSizeBytes) return reject('cache-proof-file-mismatch', true);
    if (proof.profileFingerprint !== context.profileFingerprint) return reject('cache-proof-profile-mismatch', true);
    if (
        !/^[a-f0-9]{64}$/.test(String(proof.effectiveUrlSha256 || '')) ||
        !/^[a-f0-9]{64}$/.test(String(proof.strongEtagSha256 || ''))
    ) return reject('cache-proof-validator-invalid', true);
    return {
        eligible: true,
        reason: 'verified-generic-complete-cache-binding',
        hasProof: true,
        proof,
        context,
        audioMode: 'copy',
        binding: {
            tenantScopeSha256: proof.tenantScopeSha256,
            providerScopeSha256: proof.providerScopeSha256,
            itemScopeSha256: proof.itemScopeSha256,
            sourceUrlSha256: proof.sourceUrlSha256,
            effectiveUrlSha256: proof.effectiveUrlSha256,
            strongEtagSha256: proof.strongEtagSha256,
            profileFingerprint: proof.profileFingerprint,
            fileSizeBytes: proof.fileSizeBytes,
            pipelineBuild: proof.pipelineBuild,
            proofBuild: proof.build,
        },
    };
}

function mkvH264FastStartStaticContext(session) {
    const fail = (reason) => ({ ok: false, reason });
    if (!isFiniteMkvVodSession(session) || isLiveSession(session)) return fail('not-finite-mkv');
    if (Number(session?.seekOffset || 0) > 0) return fail('seek');
    if (session?.forceAlignedMultiAudioVideoEncode === true) return fail('multi-audio');
    const profile = asRecord(session?.codecProfile);
    const container = normalizeCodecToken(profile.container);
    const videoCodec = normalizeCodecToken(profile.videoCodec ?? profile.video_codec ?? profile.video);
    if (!(container === 'mkv' || container.includes('matroska'))) return fail('not-matroska');
    if (!(videoCodec.includes('h264') || videoCodec.includes('avc'))) return fail('video-transcode');
    if (profile.metadataComplete !== true && profile.metadata_complete !== true) return fail('incomplete-profile');
    const videoStreamIndex = Number(profile.videoStreamIndex ?? profile.video_stream_index);
    const videoWidth = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const videoHeight = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    if (
        !Number.isInteger(videoStreamIndex) || videoStreamIndex < 0 || videoStreamIndex > 1_024 ||
        !Number.isInteger(videoWidth) || !Number.isInteger(videoHeight) || videoWidth <= 0 || videoHeight <= 0 ||
        videoWidth > EXACT_MATROSKA_H264_MAX_WIDTH || videoHeight > EXACT_MATROSKA_H264_MAX_HEIGHT ||
        videoWidth * videoHeight > EXACT_MATROSKA_H264_MAX_PIXELS
    ) return fail('unsafe-video-dimensions');
    const videoProfile = normalizeCodecToken(profile.videoProfile ?? profile.video_profile);
    const videoPixelFormat = normalizeCodecToken(profile.videoPixelFormat ?? profile.video_pixel_format ?? profile.pix_fmt);
    if (!['baseline', 'constrainedbaseline', 'main', 'high'].includes(videoProfile)) return fail('unsafe-h264-profile');
    if (!['yuv420p', 'yuvj420p'].includes(videoPixelFormat)) return fail('unsafe-h264-pixel-format');
    const durationSeconds = Number(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration);
    const fileSizeBytes = Number(profile.fileSizeBytes ?? profile.file_size_bytes);
    const profileProbedAt = Date.parse(String(profile.probedAt ?? profile.probed_at ?? ''));
    const probeSource = normalizeCodecToken(profile.probeSource ?? profile.probe_source);
    if (
        !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0 ||
        !Number.isFinite(profileProbedAt) ||
        !['gatewayinband', 'gatewayprobe', 'exactfileprobe', 'exactfilecodecprobe'].includes(probeSource)
    ) return fail('incomplete-profile');
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : null);
    const subtitles = Array.isArray(profile.subtitles)
        ? profile.subtitles
        : (Array.isArray(profile.subtitleTracks)
            ? profile.subtitleTracks
            : (Array.isArray(profile.subtitle_tracks) ? profile.subtitle_tracks : null));
    if (!audioTracks || !subtitles) return fail('incomplete-profile');
    if (audioTracks.length !== 1) return fail(audioTracks.length > 1 ? 'multi-audio' : 'missing-audio');
    const onlyAudioTrack = asRecord(audioTracks[0]);
    if (
        !Number.isInteger(Number(onlyAudioTrack.index)) || Number(onlyAudioTrack.index) < 0 ||
        !normalizeCodecToken(onlyAudioTrack.codec) ||
        !Number.isInteger(Number(onlyAudioTrack.channels)) || Number(onlyAudioTrack.channels) <= 0
    ) return fail('incomplete-audio-profile');
    const profileFingerprint = mkvH264FastStartProfileFingerprint(profile, fileSizeBytes);
    if (!profileFingerprint) return fail('profile-fingerprint-unavailable');
    return { ok: true, profile, durationSeconds, fileSizeBytes, profileFingerprint };
}

function mkvH264FastStartIdentityContext(session) {
    const identity = asRecord(session?.playbackIdentity);
    const ownerKey = normalizeSessionKey(session?.ownerKey);
    const sourceId = String(identity.sourceId || '').trim();
    const itemType = normalizeCodecToken(identity.itemType);
    const itemId = String(identity.itemId || '').trim();
    const variantId = String(identity.variantId || '').trim();
    if (!ownerKey || !sourceId || itemType !== 'movie' || !itemId) return null;
    if ([sourceId, itemId, variantId].some((value) => value.length > 512)) return null;
    return {
        tenantScopeSha256: sha256Hex(ownerKey),
        itemScopeSha256: sha256Hex(stableJson({ sourceId, itemType, itemId, variantId })),
    };
}

const MKV_H264_LEVEL_LIMITS = Object.freeze({
    10: { maxFs: 99, maxMbps: 1_485, maxDpbMbs: 396 },
    11: { maxFs: 396, maxMbps: 3_000, maxDpbMbs: 900 },
    12: { maxFs: 396, maxMbps: 6_000, maxDpbMbs: 2_376 },
    13: { maxFs: 396, maxMbps: 11_880, maxDpbMbs: 2_376 },
    20: { maxFs: 396, maxMbps: 11_880, maxDpbMbs: 2_376 },
    21: { maxFs: 792, maxMbps: 19_800, maxDpbMbs: 4_752 },
    22: { maxFs: 1_620, maxMbps: 20_250, maxDpbMbs: 8_100 },
    30: { maxFs: 1_620, maxMbps: 40_500, maxDpbMbs: 8_100 },
    31: { maxFs: 3_600, maxMbps: 108_000, maxDpbMbs: 18_000 },
    32: { maxFs: 5_120, maxMbps: 216_000, maxDpbMbs: 20_480 },
    40: { maxFs: 8_192, maxMbps: 245_760, maxDpbMbs: 32_768 },
    41: { maxFs: 8_192, maxMbps: 245_760, maxDpbMbs: 32_768 },
    42: { maxFs: 8_704, maxMbps: 522_240, maxDpbMbs: 34_816 },
});

function validMkvH264FastStartVideoCompatibility(metrics, profile) {
    const record = asRecord(metrics);
    const codecProfile = asRecord(profile);
    const videoProfile = normalizeCodecToken(record.videoProfile);
    const expectedProfile = normalizeCodecToken(codecProfile.videoProfile ?? codecProfile.video_profile);
    const pixelFormat = normalizeCodecToken(record.videoPixelFormat);
    const expectedPixelFormat = normalizeCodecToken(
        codecProfile.videoPixelFormat ?? codecProfile.video_pixel_format ?? codecProfile.pix_fmt,
    );
    const level = Number(record.videoLevel);
    const refs = Number(record.videoRefs);
    const width = Number(record.videoWidth);
    const height = Number(record.videoHeight);
    const fpsNumerator = Number(record.videoFpsNumerator);
    const fpsDenominator = Number(record.videoFpsDenominator);
    const timeBaseNumerator = Number(record.streamTimeBaseNumerator);
    const timeBaseDenominator = Number(record.streamTimeBaseDenominator);
    const videoStreamIndex = Number(record.videoStreamIndex);
    const expectedVideoStreamIndex = Number(
        codecProfile.videoStreamIndex ?? codecProfile.video_stream_index,
    );
    const limits = MKV_H264_LEVEL_LIMITS[level];
    if (
        !['baseline', 'constrainedbaseline', 'main', 'high'].includes(videoProfile) ||
        videoProfile !== expectedProfile || !['yuv420p', 'yuvj420p'].includes(pixelFormat) ||
        pixelFormat !== expectedPixelFormat || !limits ||
        !Number.isInteger(videoStreamIndex) || videoStreamIndex < 0 || videoStreamIndex > 1_024 ||
        videoStreamIndex !== expectedVideoStreamIndex ||
        !Number.isInteger(refs) || refs < 1 || refs > 16 ||
        !Number.isInteger(width) || !Number.isInteger(height) ||
        width !== Number(codecProfile.videoWidth ?? codecProfile.video_width ?? codecProfile.width) ||
        height !== Number(codecProfile.videoHeight ?? codecProfile.video_height ?? codecProfile.height) ||
        !Number.isSafeInteger(fpsNumerator) || !Number.isSafeInteger(fpsDenominator) ||
        fpsNumerator <= 0 || fpsDenominator <= 0 || fpsNumerator > 60 * fpsDenominator ||
        !Number.isSafeInteger(timeBaseNumerator) || !Number.isSafeInteger(timeBaseDenominator) ||
        timeBaseNumerator <= 0 || timeBaseDenominator <= 0 || timeBaseNumerator > timeBaseDenominator ||
        timeBaseDenominator > 1_000_000_000
    ) return false;
    const macroblocksPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
    return Boolean(
        macroblocksPerFrame <= limits.maxFs &&
        macroblocksPerFrame * fpsNumerator <= limits.maxMbps * fpsDenominator &&
        refs * macroblocksPerFrame <= limits.maxDpbMbs
    );
}

function validMkvH264FastStartFullFileMetrics(metrics, fileSizeBytes, durationSeconds, profile) {
    const record = asRecord(metrics);
    const coverageSeconds = Number(record.coverageSeconds);
    const coverageToleranceSeconds = Math.max(2, durationSeconds * 0.005);
    const maxKeyframeGapSeconds = Number(record.maxKeyframeGapSeconds);
    const firstPtsSeconds = Number(record.firstPtsSeconds);
    const firstDtsSeconds = Number(record.firstDtsSeconds);
    const maxPtsDtsSkewSeconds = Number(record.maxPtsDtsSkewSeconds);
    return Boolean(
        Number.isSafeInteger(record.bytesAnalyzed) && record.bytesAnalyzed === fileSizeBytes &&
        Number.isInteger(record.packetCount) && record.packetCount >= MKV_H264_FAST_START_MIN_KEYFRAMES && record.packetCount <= 20_000_000 &&
        Number.isInteger(record.keyframeCount) && record.keyframeCount >= MKV_H264_FAST_START_MIN_KEYFRAMES && record.keyframeCount <= record.packetCount &&
        Number.isInteger(record.idrCount) && record.idrCount === record.keyframeCount &&
        record.closedGopIdrVerified === true &&
        /^[a-f0-9]{64}$/.test(String(record.keyTimelineSha256 || '')) &&
        record.idrTimelineSha256 === record.keyTimelineSha256 &&
        record.firstPacketKeyframe === true &&
        Number.isFinite(coverageSeconds) && !Object.is(coverageSeconds, -0) &&
        Math.abs(coverageSeconds - durationSeconds) <= coverageToleranceSeconds &&
        Number.isFinite(maxKeyframeGapSeconds) && !Object.is(maxKeyframeGapSeconds, -0) &&
        maxKeyframeGapSeconds > 0 && maxKeyframeGapSeconds <= MKV_H264_FAST_START_MAX_GOP_SECONDS &&
        record.ptsPresent === true && record.dtsPresent === true && record.dtsMonotonic === true &&
        record.muxTimestampsSafe === true && record.negativeTimestampCount === 0 &&
        record.timestampDiscontinuityCount === 0 &&
        Number.isInteger(record.leadingMissingDtsCount) && record.leadingMissingDtsCount >= 0 && record.leadingMissingDtsCount <= 4 &&
        Number.isFinite(firstPtsSeconds) && firstPtsSeconds >= 0 && firstPtsSeconds <= 1 &&
        Number.isFinite(firstDtsSeconds) && firstDtsSeconds >= 0 && firstDtsSeconds <= 1 &&
        Number.isFinite(maxPtsDtsSkewSeconds) && maxPtsDtsSkewSeconds >= 0 && maxPtsDtsSkewSeconds <= 2 &&
        validMkvH264FastStartVideoCompatibility(record, profile)
    );
}

function maybeFinalizeMkvH264FastStartProof(session, nowMs = Date.now()) {
    if (!MKV_H264_FAST_START_COPY_ACTIVATION_READY) return null;
    if (session?.mkvH264FastStartProofFinalized === true) {
        return mkvH264FastStartProofForProfile(session.codecProfile);
    }
    session.mkvH264FastStartProofFinalized = false;
    const context = mkvH264FastStartStaticContext(session);
    const identity = mkvH264FastStartIdentityContext(session);
    const currentHeaderAuthority = asRecord(session?.mkvH264CurrentHeaderAuthority);
    const validator = asRecord(session?.vodInputStrongValidator);
    const metrics = asRecord(session?.mkvH264FullFilePacketMetrics);
    if (
        !MKV_H264_FAST_START_PROOF_CURRENT_KEY || !context.ok || !identity ||
        currentHeaderAuthority.source !== 'gateway-inband-current' ||
        currentHeaderAuthority.captureOwner !== String(session?.id || '') ||
        currentHeaderAuthority.profileFingerprint !== context.profileFingerprint ||
        validator.type !== 'etag-sha256' || !/^[a-f0-9]{64}$/.test(String(validator.digest || '')) ||
        metrics.analyzerType !== MKV_H264_FAST_START_ANALYZER_TYPE ||
        metrics.analyzerDigest !== MKV_H264_FAST_START_ANALYZER_DIGEST ||
        !validMkvH264FastStartFullFileMetrics(metrics, context.fileSizeBytes, context.durationSeconds, context.profile)
    ) return null;
    const payload = {
        protocol: MKV_H264_FAST_START_PROTOCOL,
        kid: mkvH264FastStartProofKeyId(MKV_H264_FAST_START_PROOF_CURRENT_KEY),
        scope: 'full-file',
        sourceUrlSha256: sha256Hex(String(session.sourceUrl || '')),
        effectiveUrlSha256: String(session.vodInputEffectiveUrlSha256 || ''),
        providerScopeSha256: sha256Hex(String(session.providerSlotKey || '')),
        tenantScopeSha256: identity.tenantScopeSha256,
        itemScopeSha256: identity.itemScopeSha256,
        fileSizeBytes: context.fileSizeBytes,
        profileFingerprint: context.profileFingerprint,
        validator: { type: validator.type, digest: validator.digest },
        metrics: {
            bytesAnalyzed: metrics.bytesAnalyzed,
            packetCount: metrics.packetCount,
            videoStreamIndex: metrics.videoStreamIndex,
            keyframeCount: metrics.keyframeCount,
            idrCount: metrics.idrCount,
            keyTimelineSha256: metrics.keyTimelineSha256,
            idrTimelineSha256: metrics.idrTimelineSha256,
            closedGopIdrVerified: true,
            firstPacketKeyframe: true,
            coverageSeconds: metrics.coverageSeconds,
            maxKeyframeGapSeconds: metrics.maxKeyframeGapSeconds,
            ptsPresent: true,
            dtsPresent: true,
            dtsMonotonic: true,
            muxTimestampsSafe: true,
            negativeTimestampCount: 0,
            timestampDiscontinuityCount: 0,
            leadingMissingDtsCount: metrics.leadingMissingDtsCount,
            firstPtsSeconds: metrics.firstPtsSeconds,
            firstDtsSeconds: metrics.firstDtsSeconds,
            maxPtsDtsSkewSeconds: metrics.maxPtsDtsSkewSeconds,
            streamTimeBaseNumerator: metrics.streamTimeBaseNumerator,
            streamTimeBaseDenominator: metrics.streamTimeBaseDenominator,
            videoProfile: metrics.videoProfile,
            videoLevel: metrics.videoLevel,
            videoRefs: metrics.videoRefs,
            videoFpsNumerator: metrics.videoFpsNumerator,
            videoFpsDenominator: metrics.videoFpsDenominator,
            videoWidth: metrics.videoWidth,
            videoHeight: metrics.videoHeight,
            videoPixelFormat: metrics.videoPixelFormat,
        },
        analyzer: { type: metrics.analyzerType, digest: metrics.analyzerDigest },
        issuedAtMs: Number(nowMs),
        expiresAtMs: Number(nowMs) + MKV_H264_FAST_START_PROOF_MAX_AGE_MS,
        build: MKV_H264_FAST_START_PROOF_BUILD,
    };
    if (
        !/^[a-f0-9]{64}$/.test(payload.effectiveUrlSha256) ||
        !Number.isSafeInteger(payload.issuedAtMs) || payload.issuedAtMs <= 0 ||
        !Number.isSafeInteger(payload.expiresAtMs) || payload.expiresAtMs <= payload.issuedAtMs
    ) return null;
    const envelope = sealMkvH264FastStartProof(payload);
    if (!envelope) return null;
    session.codecProfile = compactRecord({ ...context.profile, mkvH264FastStartProof: envelope });
    cacheCodecProfile(session.sourceUrl, session.codecProfile);
    session.mkvH264FastStartProofFinalized = true;
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.mkvH264FastStartProofProduced = true;
    return envelope;
}

function assessMkvH264FastStart(session, nowMs = Date.now()) {
    const reject = (reason) => ({ protocol: MKV_H264_FAST_START_PROTOCOL, eligible: false, reason, proof: null });
    if (session?.mode === 'transcode') return reject('requested-transcode');
    if (!MKV_H264_FAST_START_COPY_ACTIVATION_READY) return reject('closed-gop-proof-unavailable');
    if (!MKV_H264_FAST_START_PROOF_CURRENT_KEY) return reject('proof-signing-unavailable');
    const context = mkvH264FastStartStaticContext(session);
    const identity = mkvH264FastStartIdentityContext(session);
    if (!context.ok) return reject(context.reason);
    if (!identity) return reject('missing-server-identity');
    const envelope = mkvH264FastStartProofForProfile(context.profile);
    if (!envelope) return reject('missing-proof');
    const proof = openMkvH264FastStartProof(envelope);
    if (!proof) return reject('invalid-proof');
    if (
        proof.protocol !== MKV_H264_FAST_START_PROTOCOL || proof.scope !== 'full-file' ||
        proof.build !== MKV_H264_FAST_START_PROOF_BUILD || !Number.isSafeInteger(proof.issuedAtMs) || proof.issuedAtMs <= 0 ||
        !Number.isSafeInteger(proof.expiresAtMs) || proof.expiresAtMs <= proof.issuedAtMs ||
        proof.expiresAtMs - proof.issuedAtMs > MKV_H264_FAST_START_PROOF_MAX_AGE_MS
    ) return reject('unsupported-proof');
    if (
        proof.issuedAtMs > Number(nowMs) + MKV_H264_FAST_START_PROOF_FUTURE_SKEW_MS ||
        Number(nowMs) > proof.expiresAtMs
    ) return reject('stale-proof');
    if (proof.sourceUrlSha256 !== sha256Hex(String(session.sourceUrl || ''))) return reject('proof-source-mismatch');
    if (proof.effectiveUrlSha256 !== String(session.vodInputEffectiveUrlSha256 || '')) return reject('proof-effective-url-mismatch');
    if (proof.providerScopeSha256 !== sha256Hex(String(session.providerSlotKey || ''))) return reject('proof-provider-mismatch');
    if (proof.tenantScopeSha256 !== identity.tenantScopeSha256) return reject('proof-tenant-mismatch');
    if (proof.itemScopeSha256 !== identity.itemScopeSha256) return reject('proof-item-mismatch');
    if (proof.fileSizeBytes !== context.fileSizeBytes) return reject('proof-file-mismatch');
    if (proof.profileFingerprint !== context.profileFingerprint) return reject('profile-fingerprint-mismatch');
    const validator = asRecord(session?.vodInputStrongValidator);
    if (validator.type !== 'etag-sha256' || !/^[a-f0-9]{64}$/.test(String(validator.digest || ''))) {
        return reject('strong-validator-required');
    }
    if (proof.validator.type !== validator.type || proof.validator.digest !== validator.digest) {
        return reject('validator-mismatch');
    }
    if (
        proof.analyzer.type !== MKV_H264_FAST_START_ANALYZER_TYPE ||
        proof.analyzer.digest !== MKV_H264_FAST_START_ANALYZER_DIGEST ||
        !validMkvH264FastStartFullFileMetrics(proof.metrics, context.fileSizeBytes, context.durationSeconds, context.profile)
    ) return reject('invalid-full-file-proof');
    return {
        protocol: MKV_H264_FAST_START_PROTOCOL,
        eligible: true,
        reason: 'full-file-proof-accepted',
        proof: {
            protocol: MKV_H264_FAST_START_PROTOCOL,
            scope: 'full-file',
            profileFingerprint: context.profileFingerprint,
            fileSizeBytes: context.fileSizeBytes,
            coverageSeconds: proof.metrics.coverageSeconds,
            maxKeyframeGapSeconds: proof.metrics.maxKeyframeGapSeconds,
            idrCount: proof.metrics.idrCount,
            closedGopIdrVerified: true,
            timestampsSafe: true,
        },
    };
}

// Validate only the immutable, signed authorities needed to locate a complete
// local HLS snapshot. Unlike assessMkvH264FastStart(), this deliberately does
// not require a new provider GET to rediscover the current ETag/effective URL:
// those digests identify the cached snapshot itself. Freshness is bounded by
// both the signed proof expiry and the cache manifest TTL/item binding.
function verifiedMkvH264CompleteCacheBinding(session, nowMs = Date.now()) {
    const reject = (reason) => ({ eligible: false, reason, binding: null, proof: null });
    if (!mkvCompleteHlsCache) return reject('cache-disabled');
    if (session?.mode === 'transcode') return reject('requested-transcode');
    if (!MKV_H264_FAST_START_COPY_ACTIVATION_READY || !MKV_H264_FAST_START_PROOF_CURRENT_KEY) {
        return reject('proof-signing-unavailable');
    }
    // Full HLS cache reads are locally seekable. Validate the proof against the
    // canonical zero-offset graph, then retain the caller's requested offset on
    // the published cache-backed session.
    const cacheLookupSession = Number(session?.seekOffset || 0) > 0
        ? { ...session, seekOffset: 0 }
        : session;
    const context = mkvH264FastStartStaticContext(cacheLookupSession);
    const identity = mkvH264FastStartIdentityContext(cacheLookupSession);
    if (!context.ok) return reject(context.reason);
    if (!identity) return reject('missing-server-identity');
    const envelope = mkvH264FastStartProofForProfile(context.profile);
    if (!envelope) return reject('missing-proof');
    const proof = openMkvH264FastStartProof(envelope);
    if (!proof) return reject('invalid-proof');
    if (
        proof.protocol !== MKV_H264_FAST_START_PROTOCOL || proof.scope !== 'full-file' ||
        proof.build !== MKV_H264_FAST_START_PROOF_BUILD ||
        !Number.isSafeInteger(proof.issuedAtMs) || proof.issuedAtMs <= 0 ||
        !Number.isSafeInteger(proof.expiresAtMs) || proof.expiresAtMs <= proof.issuedAtMs ||
        proof.expiresAtMs - proof.issuedAtMs > MKV_H264_FAST_START_PROOF_MAX_AGE_MS ||
        proof.issuedAtMs > Number(nowMs) + MKV_H264_FAST_START_PROOF_FUTURE_SKEW_MS ||
        Number(nowMs) > proof.expiresAtMs
    ) return reject('stale-or-unsupported-proof');
    if (proof.sourceUrlSha256 !== sha256Hex(String(session.sourceUrl || ''))) return reject('proof-source-mismatch');
    if (proof.providerScopeSha256 !== sha256Hex(String(session.providerSlotKey || ''))) return reject('proof-provider-mismatch');
    if (proof.tenantScopeSha256 !== identity.tenantScopeSha256) return reject('proof-tenant-mismatch');
    if (proof.itemScopeSha256 !== identity.itemScopeSha256) return reject('proof-item-mismatch');
    if (proof.fileSizeBytes !== context.fileSizeBytes) return reject('proof-file-mismatch');
    if (proof.profileFingerprint !== context.profileFingerprint) return reject('profile-fingerprint-mismatch');
    if (
        proof.validator?.type !== 'etag-sha256' ||
        !/^[a-f0-9]{64}$/.test(String(proof.validator?.digest || '')) ||
        !/^[a-f0-9]{64}$/.test(String(proof.effectiveUrlSha256 || '')) ||
        proof.analyzer?.type !== MKV_H264_FAST_START_ANALYZER_TYPE ||
        proof.analyzer?.digest !== MKV_H264_FAST_START_ANALYZER_DIGEST ||
        !validMkvH264FastStartFullFileMetrics(
            proof.metrics,
            context.fileSizeBytes,
            context.durationSeconds,
            context.profile,
        )
    ) return reject('invalid-full-file-proof');

    const proofBoundSession = {
        ...cacheLookupSession,
        mkvH264FastStart: { eligible: true },
        mkvH264FastStartAudioAuthority: true,
    };
    if (subtitleTracksForSession(proofBoundSession).length > 0) {
        return reject('subtitle-assets-not-cacheable');
    }
    const audioMode = shouldCopyAudio(proofBoundSession) ? 'copy' : 'transcode';
    const pipelineBuild = `${MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD}:video-copy:audio-${audioMode}`;
    return {
        eligible: true,
        reason: 'verified-complete-cache-binding',
        proof,
        context,
        audioMode,
        pipelineBuild,
        binding: {
            tenantScopeSha256: proof.tenantScopeSha256,
            providerScopeSha256: proof.providerScopeSha256,
            itemScopeSha256: proof.itemScopeSha256,
            sourceUrlSha256: proof.sourceUrlSha256,
            effectiveUrlSha256: proof.effectiveUrlSha256,
            strongEtagSha256: proof.validator.digest,
            profileFingerprint: proof.profileFingerprint,
            fileSizeBytes: proof.fileSizeBytes,
            pipelineBuild,
            proofBuild: proof.build,
        },
    };
}

function verifiedMkvCompleteCacheBinding(session, nowMs = Date.now()) {
    if (session?.completeHlsCachePolicy === 'bypass') {
        return { eligible: false, reason: 'cache-bypass', hasProof: false };
    }
    const generic = verifiedGenericMkvCompleteCacheBinding(session, nowMs);
    if (generic.eligible || generic.hasProof) return generic;
    return verifiedMkvH264CompleteCacheBinding(session, nowMs);
}

async function tryAcquireMkvCompleteHlsCache(session, nowMs = Date.now()) {
    const assessment = verifiedMkvCompleteCacheBinding(session, nowMs);
    if (!assessment.eligible) {
        if (
            (mkvH264FastStartProofForProfile(session?.codecProfile) ||
                mkvCompleteHlsCacheProofForProfile(session?.codecProfile)) &&
            assessment.reason !== 'cache-disabled' && assessment.reason !== 'cache-bypass'
        ) {
            mkvCompleteHlsCacheStats.invalidProofs += 1;
        }
        return { hit: false, reason: assessment.reason, assessment };
    }
    try {
        const lease = await mkvCompleteHlsCache.acquireVerified(assessment.binding);
        if (!lease.hit) {
            if (lease.reason === 'invalid' || lease.reason === 'quarantined') {
                mkvCompleteHlsCacheStats.corruptions += 1;
                return {
                    hit: false,
                    reason: lease.reason,
                    assessment,
                    terminal: true,
                };
            }
            mkvCompleteHlsCacheStats.misses += 1;
            return { hit: false, reason: lease.reason || 'miss', assessment };
        }
        mkvCompleteHlsCacheStats.hits += 1;
        mkvCompleteHlsCacheStats.activeLeases += 1;
        let released = false;
        const release = lease.release;
        lease.release = () => {
            if (released) return;
            released = true;
            release();
            mkvCompleteHlsCacheStats.activeLeases = Math.max(0, mkvCompleteHlsCacheStats.activeLeases - 1);
        };
        return { hit: true, reason: 'complete-hls-cache-hit', assessment, lease };
    } catch (error) {
        mkvCompleteHlsCacheStats.corruptions += 1;
        return {
            hit: false,
            reason: String(error?.code || 'cache-read-failed').slice(0, 80),
            assessment,
            terminal: true,
        };
    }
}

function flatCompleteHlsReferences(text, playlistName) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('CACHE_PLAYLIST_INVALID');
    if (lines.some((line) => /^#EXT-X-(?:PREFETCH|PRELOAD-HINT|RENDITION-REPORT|SKIP|DISCONTINUITY)(?::|$)/.test(line))) {
        throw new Error('CACHE_PLAYLIST_NOT_STABLE');
    }
    const hasMedia = lines.some((line) => line.startsWith('#EXTINF:'));
    if (hasMedia && !lines.includes('#EXT-X-ENDLIST')) throw new Error('CACHE_PLAYLIST_INCOMPLETE');
    const refs = [];
    for (const line of lines) {
        if (!line.startsWith('#')) refs.push(line);
        for (const match of line.matchAll(/(?:^|[:,])URI="([^"]+)"/g)) refs.push(match[1]);
        if (/URI=/.test(line) && !/(?:^|[:,])URI="([^"]+)"/.test(line)) {
            throw new Error('CACHE_PLAYLIST_URI_INVALID');
        }
    }
    return refs.map((reference) => {
        const name = safeSessionArtifactName(reference);
        if (!name || name !== reference || reference.includes('/') || reference.includes('\\')) {
            throw new Error(`CACHE_PLAYLIST_REFERENCE_INVALID:${playlistName}`);
        }
        return name;
    });
}

async function collectCompleteHlsSessionAssets(session) {
    if (!session?.outputDir || !session?.playlistPath || !isWithin(session.outputDir, session.playlistPath)) {
        throw new Error('CACHE_OUTPUT_ROOT_INVALID');
    }
    const rootPlaylist = path.basename(session.playlistPath);
    if (rootPlaylist !== 'playlist.m3u8') throw new Error('CACHE_ROOT_PLAYLIST_INVALID');
    const queue = [rootPlaylist];
    const files = new Set();
    let mediaPlaylists = 0;
    while (queue.length) {
        if (files.size >= MKV_COMPLETE_HLS_CACHE_MAX_FILES || queue.length > MKV_COMPLETE_HLS_CACHE_MAX_FILES) {
            throw new Error('CACHE_GRAPH_TOO_LARGE');
        }
        const name = queue.shift();
        if (files.has(name)) continue;
        files.add(name);
        const filePath = path.resolve(session.outputDir, name);
        if (!isWithin(session.outputDir, filePath)) throw new Error('CACHE_ASSET_ESCAPED');
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('CACHE_ASSET_INVALID');
        if (!name.toLowerCase().endsWith('.m3u8')) continue;
        if (stat.size > MKV_COMPLETE_HLS_CACHE_MAX_PLAYLIST_BYTES) throw new Error('CACHE_PLAYLIST_TOO_LARGE');
        const text = await fsp.readFile(filePath, 'utf8');
        if (text.includes('#EXTINF:')) mediaPlaylists += 1;
        for (const reference of flatCompleteHlsReferences(text, name)) {
            if (!files.has(reference) && files.size + queue.length >= MKV_COMPLETE_HLS_CACHE_MAX_FILES) {
                throw new Error('CACHE_GRAPH_TOO_LARGE');
            }
            if (reference.toLowerCase().endsWith('.m3u8')) queue.push(reference);
            else files.add(reference);
        }
    }
    if (mediaPlaylists === 0) throw new Error('CACHE_MEDIA_PLAYLIST_MISSING');
    for (const name of files) {
        const filePath = path.resolve(session.outputDir, name);
        if (!isWithin(session.outputDir, filePath)) throw new Error('CACHE_ASSET_ESCAPED');
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('CACHE_ASSET_INVALID');
    }
    return { rootPlaylist, files: Array.from(files).sort() };
}

async function maybePublishMkvCompleteHlsCache(session) {
    if (!mkvCompleteHlsCache || session?.assetSource === 'complete-hls-cache') return null;
    if (
        session?.inputFailure || session?.lastError ||
        session?.inputPump?.completed !== true
    ) return null;
    const locator = buildMkvCompleteHlsCacheLocator(session);
    if (!locator) return null;
    const graph = await collectCompleteHlsSessionAssets(session);
    try {
        const result = await mkvCompleteHlsCache.publishCompleteVerified({
            binding: locator.binding,
            sourceDirectory: session.outputDir,
            rootPlaylist: graph.rootPlaylist,
            files: graph.files,
            completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
        });
        if (!['published', 'already-exists'].includes(result?.status)) return result;
        const previousCodecProfile = session.codecProfile;
        session.codecProfile = compactRecord({
            ...locator.codecProfileSnapshot,
            mkvCompleteHlsCacheProof: locator.envelope,
        });
        const selfAssessment = verifiedGenericMkvCompleteCacheBinding(session);
        if (
            selfAssessment.eligible !== true ||
            stableJson(selfAssessment.binding) !== stableJson(locator.binding)
        ) {
            session.codecProfile = previousCodecProfile;
            session.completeHlsCacheBinding = null;
            session.mkvCompleteHlsCacheProofFinalized = false;
            if (result.status === 'published' && /^[a-f0-9]{64}$/.test(String(result.key || ''))) {
                await mkvCompleteHlsCache.quarantine(result.key).catch(() => {});
            }
            const error = new Error('complete HLS cache profile binding drifted during publication');
            error.code = 'CACHE_PROFILE_BINDING_DRIFT';
            throw error;
        }
        if (result.status === 'published') mkvCompleteHlsCacheStats.promotions += 1;
        session.completeHlsCacheBinding = locator.binding;
        cacheCodecProfile(session.sourceUrl, session.codecProfile);
        session.mkvCompleteHlsCacheProofFinalized = true;
        session.startupTimings = asRecord(session.startupTimings);
        session.startupTimings.completeHlsCachePublished = result.status === 'published';
        return result;
    } catch (error) {
        mkvCompleteHlsCacheStats.promotionFailures += 1;
        throw error;
    }
}

function scheduleMkvCompleteHlsCachePromotion(session) {
    if (!session || session.assetSource === 'complete-hls-cache') return null;
    if (session.completeHlsCachePromotionPromise) return session.completeHlsCachePromotionPromise;
    if (
        session.completeHlsCacheMediaReady !== true ||
        session.completeHlsCacheProfileReady !== true
    ) return null;
    const promotion = Promise.resolve()
        .then(() => maybePublishMkvCompleteHlsCache(session))
        .catch((error) => {
            console.warn(`[media-gateway] complete HLS cache promotion skipped for ${session.id}: ${String(error?.code || error?.message || 'validation_failed').slice(0, 120)}`);
            return null;
        });
    session.completeHlsCachePromotionPromise = promotion;
    return promotion;
}

function mkvCompleteHlsBackgroundContinuationEnabled() {
    return Boolean(
        MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_REQUESTED &&
        mkvCompleteHlsCache &&
        MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY &&
        GATEWAY_TOKEN &&
        edgeCallbackBase
    );
}

function assessMkvCompleteHlsBackgroundContinuation(session) {
    const reject = (reason) => ({ eligible: false, reason });
    if (!mkvCompleteHlsBackgroundContinuationEnabled()) return reject('continuation-disabled');
    if (!session || session.stoppingPromise) return reject('session-stopping');
    if (session.backgroundCacheContinuation === true) return reject('already-running');
    if (session.assetSource === 'complete-hls-cache') return reject('already-cached');
    if (!session.playbackSessionId || !session.id) return reject('missing-session-identity');
    if (session.inputFailure || session.lastError) return reject('media-failed');
    if (session.completeHlsCacheProfileReady !== true) return reject('profile-not-ready');
    if (session.mkvCompleteHlsCacheProofFinalized === true) return reject('proof-already-finalized');
    const validator = asRecord(session.vodInputStrongValidator);
    if (
        validator.type !== 'etag-sha256' ||
        !/^[a-f0-9]{64}$/.test(String(validator.digest || '')) ||
        !/^[a-f0-9]{64}$/.test(String(session.vodInputEffectiveUrlSha256 || ''))
    ) return reject('strong-validator-required');
    const context = mkvCompleteHlsCacheStaticContext(session);
    if (!context.eligible) return reject(context.reason);
    const child = session.ffmpeg;
    if (!child) return reject('ffmpeg-missing');
    const childRunning = child.exitCode === null && !child.signalCode;
    if (!childRunning && session.completeHlsCacheFfmpegCompletedCleanly !== true) {
        return reject('ffmpeg-not-running');
    }
    const pump = session.inputPump;
    if (!pump && session.completeHlsCacheMediaReady !== true) return reject('input-pump-missing');
    return { eligible: true, reason: 'eligible', context };
}

function settleMkvCompleteHlsBackgroundContinuation(session, outcome) {
    if (!session?.backgroundCacheContinuation || session.backgroundCacheContinuationOutcome) return;
    session.backgroundCacheContinuationOutcome = outcome;
    if (outcome === 'completed') mkvCompleteHlsCacheStats.continuationsCompleted += 1;
    else if (outcome === 'preempted') mkvCompleteHlsCacheStats.continuationsPreempted += 1;
    else if (outcome === 'timeout') mkvCompleteHlsCacheStats.continuationsTimedOut += 1;
    else mkvCompleteHlsCacheStats.continuationsFailed += 1;
}

async function reportMkvCompleteHlsBackgroundContinuation(session, finalCodecProfile) {
    if (!edgeCallbackBase || !GATEWAY_TOKEN || !session?.playbackSessionId || !session?.id) return false;
    const payload = JSON.stringify({
        protocol: 1,
        playbackSessionId: session.playbackSessionId,
        gatewaySessionId: session.id,
        status: 'completed',
        finalCodecProfile,
    });
    const delays = [0, 1_000, 5_000, 15_000];
    for (const delayMs of delays) {
        if (delayMs > 0) await sleep(delayMs);
        try {
            const response = await fetch(`${edgeCallbackBase}/complete-cache-callback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${GATEWAY_TOKEN}`,
                },
                body: payload,
                signal: AbortSignal.timeout(MKV_COMPLETE_HLS_BACKGROUND_CALLBACK_TIMEOUT_MS),
            });
            if (response.ok) return true;
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                return false;
            }
        } catch (_) {
            // Retry is bounded below; never expose the callback URL, token or profile.
        }
    }
    return false;
}

function finishMkvCompleteHlsBackgroundContinuation(session) {
    if (!session?.backgroundCacheContinuation) return null;
    if (session.backgroundCacheContinuationPromise) return session.backgroundCacheContinuationPromise;
    const completion = (async () => {
        await scheduleMkvCompleteHlsCachePromotion(session);
        const finalCodecProfile = privateFinalCodecProfileForSession(session);
        const cacheProof = mkvCompleteHlsCacheProofForProfile(finalCodecProfile);
        if (!cacheProof || session.mkvCompleteHlsCacheProofFinalized !== true) {
            settleMkvCompleteHlsBackgroundContinuation(session, 'failed');
            await stopSession(session, { reason: 'background-failed' });
            return false;
        }
        // EOF and cache publication prove that the provider body and FFmpeg
        // graph are fully drained. Keep the detached session only for the
        // bounded Edge callback; it must no longer block the provider lane.
        session.backgroundCacheContinuationProviderDrained = true;
        session.status = 'background-callback';
        wakePlaybackBlockedQueues();
        const callbackDelivered = await reportMkvCompleteHlsBackgroundContinuation(
            session,
            finalCodecProfile,
        );
        if (!callbackDelivered) mkvCompleteHlsCacheStats.continuationCallbackFailures += 1;
        settleMkvCompleteHlsBackgroundContinuation(session, 'completed');
        await stopSession(session, { reason: 'background-completed' });
        return true;
    })().catch(async () => {
        settleMkvCompleteHlsBackgroundContinuation(session, 'failed');
        await stopSession(session, { reason: 'background-failed' }).catch(() => {});
        return false;
    });
    session.backgroundCacheContinuationPromise = completion;
    return completion;
}

function startMkvCompleteHlsBackgroundContinuation(session, nowMs = Date.now()) {
    const assessment = assessMkvCompleteHlsBackgroundContinuation(session);
    if (!assessment.eligible) return { started: false, reason: assessment.reason };
    const originalExpiryMs = session.expiresAt instanceof Date
        ? session.expiresAt.getTime()
        : Number.POSITIVE_INFINITY;
    const deadlineMs = Math.min(
        Number.isFinite(originalExpiryMs) ? originalExpiryMs : Number.POSITIVE_INFINITY,
        Number(nowMs) + MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_MAX_MS,
    );
    if (!Number.isFinite(deadlineMs) || deadlineMs <= Number(nowMs)) {
        return { started: false, reason: 'continuation-expired' };
    }
    session.backgroundCacheContinuation = true;
    session.backgroundCacheContinuationStartedAtMs = Number(nowMs);
    session.backgroundCacheContinuationDeadlineMs = deadlineMs;
    session.backgroundCacheContinuationProviderDrained = false;
    session.status = 'background-cache';
    // Revoke every browser URL immediately. The trusted callback carries only
    // the finalized private profile; no player can keep reading this session.
    session.accessToken = randomToken();
    session.expiresAt = new Date(deadlineMs);
    mkvCompleteHlsCacheStats.continuationsStarted += 1;
    const timer = setTimeout(() => {
        settleMkvCompleteHlsBackgroundContinuation(session, 'timeout');
        stopSession(session, { reason: 'background-timeout' }).catch(() => {});
    }, Math.max(1, deadlineMs - Number(nowMs)));
    timer.unref?.();
    session.backgroundCacheContinuationTimer = timer;
    if (
        session.completeHlsCacheMediaReady === true &&
        session.completeHlsCacheProfileReady === true
    ) {
        setImmediate(() => finishMkvCompleteHlsBackgroundContinuation(session));
    }
    return { started: true, reason: 'started', deadlineAt: new Date(deadlineMs).toISOString() };
}

function needsMkvH264CurrentHeaderAuthority(session) {
    if (
        !MKV_H264_FAST_START_PROOF_CURRENT_KEY ||
        !isFiniteMkvVodSession(session) ||
        Number(session?.seekOffset || 0) > 0 ||
        session?.forceAlignedMultiAudioVideoEncode === true ||
        !mkvH264FastStartIdentityContext(session)
    ) return false;
    return asRecord(session?.mkvH264FastStart).eligible !== true;
}

function freezeMkvH264FastStart(session) {
    const assessment = assessMkvH264FastStart(session);
    session.mkvH264FastStart = assessment;
    if (assessment.eligible) {
        // The signed profile fingerprint covers the only audio track, including
        // codec, profile, channels, sample rate and layout. The audio decision
        // must therefore use that exact track and never mutable flat request
        // hints. Browser-safe AAC-LC may be copied; every other track keeps the
        // existing AAC normalization path.
        session.mkvH264FastStartAudioAuthority = true;
        session.forceMkvH264FastStartAudioTranscode = false;
        session.hlsTargetSeconds = EXACT_MATROSKA_H264_HLS_TARGET_SECONDS;
        session.minHlsStartupBufferSeconds = MKV_H264_FAST_START_BUFFER_SECONDS;
        session.minHlsStartupSegments = MKV_H264_FAST_START_MIN_SEGMENTS;
    }
    return assessment;
}

function observedMediaProductionRateX(session) {
    const timings = asRecord(session?.startupTimings);
    const bufferSeconds = Number(timings.playlistBufferSeconds);
    const elapsedMs = Number(timings.ffmpegReadyMs);
    if (!Number.isFinite(bufferSeconds) || bufferSeconds <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        return null;
    }
    const rate = bufferSeconds / (elapsedMs / 1_000);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return Number(Math.min(rate, 20).toFixed(3));
}

function startupPolicyForSession(session) {
    const videoMode = videoModeForSession(session);
    const audioMode = audioModeForSession(session);
    const pipeline = videoMode === 'encode'
        ? 'video-transcode'
        : (audioMode === 'copy' ? 'copy' : 'audio-transcode');
    const assessment = asRecord(session?.mkvH264FastStart);
    const observedEncodeRateX = observedMediaProductionRateX(session);
    const copySelected = assessment.eligible === true && videoMode === 'copy';
    const vaapiTranscodeSelected = videoMode === 'encode' &&
        !isLiveSession(session) &&
        VIDEO_ENCODER_CONFIG.backend === 'vaapi' &&
        VIDEO_ENCODER_PREFLIGHT.ready === true &&
        asRecord(session?.startupTimings).videoEncoder === 'vaapi';
    const selected = copySelected || vaapiTranscodeSelected;
    const minimumEncodeRateX = vaapiTranscodeSelected
        ? VAAPI_VOD_FAST_START_MIN_ENCODE_RATE_X
        : MKV_H264_FAST_START_MIN_ENCODE_RATE_X;
    const targetBufferSeconds = vaapiTranscodeSelected
        ? VAAPI_VOD_FAST_START_BUFFER_SECONDS
        : MKV_H264_FAST_START_BUFFER_SECONDS;
    const eligible = selected &&
        observedEncodeRateX !== null &&
        observedEncodeRateX >= minimumEncodeRateX;
    const reason = eligible
        ? (vaapiTranscodeSelected ? 'vaapi-transcode-ready' : 'mkv-h264-copy-ready')
        : (selected
            ? (observedEncodeRateX === null ? 'encode-rate-unavailable' : 'encode-rate-below-minimum')
            : (stringOrNull(assessment.reason) || (videoMode === 'encode' ? 'video-transcode' : 'missing-proof')));
    return {
        protocol: MKV_H264_FAST_START_PROTOCOL,
        eligible,
        pipeline,
        targetBufferSeconds: eligible ? targetBufferSeconds : null,
        minimumEncodeRateX,
        observedEncodeRateX,
        reason,
    };
}

const mkvH264HlsCacheStats = {
    hits: 0,
    misses: 0,
    corruptions: 0,
    promotions: 0,
    prefixPromotions: 0,
    completePromotions: 0,
    evictions: 0,
};
const mkvH264HlsCachePromotionLocks = new Map();

function mkvH264HlsCacheEnabled() {
    return Boolean(
        MKV_H264_HLS_CACHE_ACTIVATION_READY &&
        process.env.MKV_H264_HLS_CACHE_ENABLED === 'true' &&
        MKV_H264_HLS_CACHE_SECRET &&
        MKV_H264_HLS_CACHE_TTL_MS > 0 &&
        MKV_H264_HLS_CACHE_MAX_ENTRIES > 0 &&
        MKV_H264_HLS_CACHE_MAX_BYTES > 0 &&
        isWithin(OUTPUT_DIR, MKV_H264_HLS_CACHE_ROOT) &&
        MKV_H264_HLS_CACHE_ROOT !== OUTPUT_DIR
    );
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value;
        return `{${Object.keys(record).sort().map((key) => (
            `${JSON.stringify(key)}:${stableJson(record[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hmacMkvH264HlsCache(value) {
    if (!MKV_H264_HLS_CACHE_SECRET) return null;
    return crypto.createHmac('sha256', MKV_H264_HLS_CACHE_SECRET)
        .update(typeof value === 'string' ? value : stableJson(value))
        .digest('hex');
}

function signedMkvH264HlsCacheRecord(value) {
    const body = { ...asRecord(value) };
    delete body.signature;
    return {
        ...body,
        signature: hmacMkvH264HlsCache(body),
    };
}

function verifyMkvH264HlsCacheRecord(value) {
    const record = asRecord(value);
    const signature = String(record.signature || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(signature)) return null;
    const body = { ...record };
    delete body.signature;
    const expected = hmacMkvH264HlsCache(body);
    if (!expected || !timingSafeEqual(signature, expected)) return null;
    return body;
}

function mkvH264HlsCacheDescriptorForSession(session) {
    if (!mkvH264HlsCacheEnabled()) return null;
    const hint = asRecord(session?.playbackHint);
    const itemType = normalizeCodecToken(hint.itemType ?? hint.item_type ?? hint.streamType ?? hint.stream_type);
    if (itemType !== 'movie') return null;
    if (!normalizeSessionKey(session?.ownerKey)) return null;
    if (!/^[a-f0-9]{64}$/.test(String(session?.providerSlotKey || ''))) return null;
    if (!/^[a-f0-9]{64}$/.test(String(session?.sourceKey || ''))) return null;
    if (Number(session?.seekOffset || 0) !== 0 || session?.forceAlignedMultiAudioVideoEncode === true) return null;

    const assessment = assessMkvH264FastStart(session);
    if (assessment.eligible !== true) return null;
    const profile = asRecord(session?.codecProfile);
    const audioTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : []);
    if (audioTracks.length !== 1) return null;
    const pipeline = shouldCopyAudio(session) ? 'copy' : 'audio-transcode';
    const profileFingerprint = String(assessment?.proof?.profileFingerprint || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(profileFingerprint)) return null;
    const audioTrack = asRecord(audioTracks[0]);
    const keyMaterial = {
        protocol: MKV_H264_HLS_CACHE_PROTOCOL,
        tenant: String(session.ownerKey),
        provider: String(session.providerSlotKey),
        file: String(session.sourceKey),
        profile: profileFingerprint,
        pipeline,
        audio: {
            index: Number(audioTrack.index),
            codec: normalizeCodecToken(audioTrack.codec),
            channels: Number(audioTrack.channels),
        },
        build: GATEWAY_VERSION,
    };
    const cacheKey = hmacMkvH264HlsCache(keyMaterial);
    if (!cacheKey) return null;
    return {
        protocol: MKV_H264_HLS_CACHE_PROTOCOL,
        cacheKey,
        profileFingerprint,
        pipeline,
        build: GATEWAY_VERSION,
    };
}

function inspectMkvH264HlsCachePlaylist(playlist) {
    const rawLines = String(playlist || '').split(/\r?\n/);
    const segments = [];
    let pendingDuration = null;
    let complete = false;
    let independent = false;
    let discontinuityCount = 0;
    let unsafeReference = false;
    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line === '#EXT-X-ENDLIST') {
            complete = true;
            continue;
        }
        if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
            independent = true;
            continue;
        }
        if (line === '#EXT-X-DISCONTINUITY') {
            discontinuityCount += 1;
            continue;
        }
        if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-MAP:') || /\bURI=/i.test(line)) {
            unsafeReference = true;
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            const duration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
            pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
            continue;
        }
        if (line.startsWith('#')) continue;
        const name = safeSessionArtifactName(String(line).split(/[?#]/, 1)[0]);
        if (!name || pendingDuration === null || !/^segment-\d{5}\.ts$/.test(name)) {
            unsafeReference = true;
            pendingDuration = null;
            continue;
        }
        segments.push({ name, durationSeconds: Number(pendingDuration.toFixed(6)) });
        pendingDuration = null;
    }
    const sequential = segments.every((segment, index) => (
        segment.name === `segment-${String(index).padStart(5, '0')}.ts`
    ));
    const durationSeconds = Number(segments.reduce(
        (sum, segment) => sum + segment.durationSeconds,
        0,
    ).toFixed(3));
    const maxSegmentDurationSeconds = segments.reduce(
        (maximum, segment) => Math.max(maximum, segment.durationSeconds),
        0,
    );
    return {
        complete,
        independent,
        discontinuityCount,
        unsafeReference,
        sequential,
        segments,
        durationSeconds,
        maxSegmentDurationSeconds: Number(maxSegmentDurationSeconds.toFixed(6)),
    };
}

function renderMkvH264HlsPrefixPlaylist(inspection) {
    const segments = Array.isArray(inspection?.segments)
        ? inspection.segments.slice(0, MKV_H264_HLS_CACHE_PREFIX_SEGMENTS)
        : [];
    if (segments.length !== MKV_H264_HLS_CACHE_PREFIX_SEGMENTS) return null;
    const targetDuration = Math.max(1, Math.ceil(segments.reduce(
        (maximum, segment) => Math.max(maximum, Number(segment.durationSeconds) || 0),
        0,
    )));
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        ...segments.flatMap((segment) => [
            `#EXTINF:${Number(segment.durationSeconds).toFixed(6)},`,
            segment.name,
        ]),
        '',
    ].join('\n');
}

async function scanLocalMkvH264HlsPackets(playlistPath, expectedDurationSeconds) {
    const resolvedPlaylist = path.resolve(playlistPath);
    const parent = path.dirname(resolvedPlaylist);
    if (!isWithin(OUTPUT_DIR, resolvedPlaylist) || !fs.existsSync(resolvedPlaylist)) return null;
    return new Promise((resolve) => {
        const child = spawn(FFPROBE_PATH, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_packets',
            '-show_entries', 'packet=pts_time,dts_time,flags',
            '-of', 'csv=p=0',
            resolvedPlaylist,
        ], {
            cwd: parent,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: loopbackOnlyEnv(),
        });
        let pending = '';
        let stderr = '';
        let packetCount = 0;
        let firstPacketKeyframe = false;
        let firstPtsSeconds = null;
        let firstDtsSeconds = null;
        let lastDtsSeconds = null;
        let maximumTimestampSeconds = 0;
        let maxPtsDtsSkewSeconds = 0;
        let negativeTimestampCount = 0;
        let timestampDiscontinuityCount = 0;
        let invalid = false;
        let settled = false;
        const consume = (line) => {
            const fields = String(line || '').trim().split(',');
            if (fields.length < 3) return;
            const pts = Number(fields[0]);
            const dts = Number(fields[1]);
            const flags = fields.slice(2).join(',');
            if (!Number.isFinite(pts) || !Number.isFinite(dts)) {
                invalid = true;
                return;
            }
            if (packetCount === 0) {
                firstPtsSeconds = pts;
                firstDtsSeconds = dts;
                firstPacketKeyframe = flags.includes('K');
            }
            if (lastDtsSeconds !== null && (
                dts + 0.000_001 < lastDtsSeconds ||
                dts - lastDtsSeconds > EXACT_MATROSKA_H264_HLS_TARGET_SECONDS + 1
            )) timestampDiscontinuityCount += 1;
            if (pts < 0 || dts < 0) negativeTimestampCount += 1;
            lastDtsSeconds = dts;
            maximumTimestampSeconds = Math.max(maximumTimestampSeconds, pts, dts);
            maxPtsDtsSkewSeconds = Math.max(maxPtsDtsSkewSeconds, Math.abs(pts - dts));
            packetCount += 1;
            if (packetCount > 20_000_000) invalid = true;
        };
        child.stdout.on('data', (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) consume(line);
            if (invalid) {
                try { child.kill('SIGTERM'); } catch (_) {}
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
        });
        const timer = setTimeout(() => {
            invalid = true;
            try { child.kill('SIGKILL'); } catch (_) {}
        }, MKV_H264_HLS_CACHE_SCAN_TIMEOUT_MS);
        timer.unref?.();
        const finish = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (pending.trim()) consume(pending);
            const duration = Number(expectedDurationSeconds);
            const coverageTolerance = Math.max(6, Number.isFinite(duration) ? duration * 0.02 : 0);
            if (
                code !== 0 || invalid || stderr.trim() ||
                packetCount < MKV_H264_HLS_CACHE_PREFIX_SEGMENTS ||
                firstPacketKeyframe !== true ||
                firstPtsSeconds === null || firstDtsSeconds === null ||
                firstPtsSeconds < 0 || firstPtsSeconds > 2 ||
                firstDtsSeconds < 0 || firstDtsSeconds > 2 ||
                negativeTimestampCount !== 0 ||
                timestampDiscontinuityCount !== 0 ||
                maxPtsDtsSkewSeconds > 2 ||
                !Number.isFinite(duration) || duration <= 0 ||
                Math.abs(maximumTimestampSeconds - duration) > coverageTolerance
            ) {
                resolve(null);
                return;
            }
            resolve({
                source: 'gateway-local-hls-packet-scan',
                packetCount,
                firstPacketKeyframe,
                firstPtsSeconds: Number(firstPtsSeconds.toFixed(6)),
                firstDtsSeconds: Number(firstDtsSeconds.toFixed(6)),
                maximumTimestampSeconds: Number(maximumTimestampSeconds.toFixed(3)),
                maxPtsDtsSkewSeconds: Number(maxPtsDtsSkewSeconds.toFixed(6)),
                negativeTimestampCount,
                timestampDiscontinuityCount,
                dtsMonotonic: true,
                timelineComplete: true,
            });
        };
        child.once('error', () => finish(-1));
        child.once('exit', (code) => finish(code));
    });
}

function buildMkvH264HlsFullFileProof(playlist, descriptor, profileDurationSeconds, packetScan) {
    const inspection = inspectMkvH264HlsCachePlaylist(playlist);
    const duration = Number(profileDurationSeconds);
    const durationTolerance = Math.max(6, Number.isFinite(duration) ? duration * 0.02 : 0);
    if (
        !inspection.complete ||
        !inspection.independent ||
        inspection.discontinuityCount !== 0 ||
        inspection.unsafeReference ||
        !inspection.sequential ||
        inspection.segments.length < MKV_H264_HLS_CACHE_PREFIX_SEGMENTS ||
        inspection.segments.length > MKV_H264_HLS_CACHE_MAX_FILES ||
        inspection.maxSegmentDurationSeconds > EXACT_MATROSKA_H264_HLS_TARGET_SECONDS + 0.25 ||
        !Number.isFinite(duration) || duration <= 0 ||
        Math.abs(inspection.durationSeconds - duration) > durationTolerance ||
        packetScan?.source !== 'gateway-local-hls-packet-scan' ||
        packetScan?.timelineComplete !== true ||
        packetScan?.dtsMonotonic !== true ||
        packetScan?.firstPacketKeyframe !== true ||
        Number(packetScan?.negativeTimestampCount) !== 0 ||
        Number(packetScan?.timestampDiscontinuityCount) !== 0
    ) return null;
    return {
        protocol: MKV_H264_HLS_CACHE_PROTOCOL,
        source: 'gateway-hls-complete',
        profileFingerprint: descriptor.profileFingerprint,
        segmentCount: inspection.segments.length,
        durationSeconds: inspection.durationSeconds,
        maxSegmentDurationSeconds: inspection.maxSegmentDurationSeconds,
        independentSegments: true,
        discontinuityCount: 0,
        timelineComplete: true,
        packetScan: {
            source: 'gateway-local-hls-packet-scan',
            packetCount: Number(packetScan.packetCount),
            firstPacketKeyframe: true,
            firstPtsSeconds: Number(packetScan.firstPtsSeconds),
            firstDtsSeconds: Number(packetScan.firstDtsSeconds),
            maximumTimestampSeconds: Number(packetScan.maximumTimestampSeconds),
            maxPtsDtsSkewSeconds: Number(packetScan.maxPtsDtsSkewSeconds),
            negativeTimestampCount: 0,
            timestampDiscontinuityCount: 0,
            dtsMonotonic: true,
            timelineComplete: true,
        },
    };
}

function validateMkvH264HlsFullFileProof(value, descriptor) {
    const proof = asRecord(value);
    const packetScan = asRecord(proof.packetScan);
    return Boolean(
        Number(proof.protocol) === MKV_H264_HLS_CACHE_PROTOCOL &&
        proof.source === 'gateway-hls-complete' &&
        proof.profileFingerprint === descriptor.profileFingerprint &&
        Number.isInteger(proof.segmentCount) &&
        proof.segmentCount >= MKV_H264_HLS_CACHE_PREFIX_SEGMENTS &&
        proof.segmentCount <= MKV_H264_HLS_CACHE_MAX_FILES &&
        Number.isFinite(Number(proof.durationSeconds)) && Number(proof.durationSeconds) >= MKV_H264_HLS_CACHE_PREFIX_SECONDS &&
        Number.isFinite(Number(proof.maxSegmentDurationSeconds)) &&
        Number(proof.maxSegmentDurationSeconds) <= EXACT_MATROSKA_H264_HLS_TARGET_SECONDS + 0.25 &&
        proof.independentSegments === true &&
        Number(proof.discontinuityCount) === 0 &&
        proof.timelineComplete === true &&
        packetScan.source === 'gateway-local-hls-packet-scan' &&
        Number.isInteger(packetScan.packetCount) && packetScan.packetCount >= MKV_H264_HLS_CACHE_PREFIX_SEGMENTS &&
        packetScan.firstPacketKeyframe === true &&
        packetScan.dtsMonotonic === true &&
        packetScan.timelineComplete === true &&
        Number(packetScan.negativeTimestampCount) === 0 &&
        Number(packetScan.timestampDiscontinuityCount) === 0 &&
        Number.isFinite(Number(packetScan.maxPtsDtsSkewSeconds)) && Number(packetScan.maxPtsDtsSkewSeconds) <= 2
    );
}

function mkvH264HlsCachePaths(cacheKey, generation = null) {
    if (!/^[a-f0-9]{64}$/.test(String(cacheKey || ''))) return null;
    const refsDir = path.resolve(MKV_H264_HLS_CACHE_ROOT, 'refs');
    const entriesDir = path.resolve(MKV_H264_HLS_CACHE_ROOT, 'entries');
    const keyDir = path.resolve(entriesDir, cacheKey);
    if (![refsDir, entriesDir, keyDir].every((candidate) => isWithin(MKV_H264_HLS_CACHE_ROOT, candidate))) return null;
    const base = {
        refsDir,
        entriesDir,
        keyDir,
        refPath: path.resolve(refsDir, `${cacheKey}.json`),
    };
    if (generation === null) return base;
    if (!/^[a-f0-9-]{16,80}$/.test(String(generation || ''))) return null;
    const generationDir = path.resolve(keyDir, generation);
    if (!isWithin(keyDir, generationDir)) return null;
    return {
        ...base,
        generationDir,
        manifestPath: path.resolve(generationDir, 'manifest.json'),
        playlistPath: path.resolve(generationDir, 'playlist.m3u8'),
    };
}

async function readBoundedJsonFile(filePath, maxBytes = 8 * 1024 * 1024) {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 1 || stat.size > maxBytes) throw new Error('cache_json_size_invalid');
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function hashMkvH264HlsCacheFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.once('error', reject);
        stream.once('end', () => resolve(hash.digest('hex')));
    });
}

async function atomicWriteMkvH264HlsCacheJson(filePath, value) {
    const parent = path.dirname(filePath);
    await fsp.mkdir(parent, { recursive: true });
    const temporary = path.resolve(parent, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
    if (!isWithin(parent, temporary)) throw new Error('cache_temp_path_invalid');
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fsp.rename(temporary, filePath);
}

async function removeMkvH264HlsCachePath(target) {
    const resolved = path.resolve(target);
    if (!isWithin(MKV_H264_HLS_CACHE_ROOT, resolved) || resolved === MKV_H264_HLS_CACHE_ROOT) return;
    await fsp.rm(resolved, { recursive: true, force: true });
}

async function invalidateMkvH264HlsCacheEntry(cacheKey, generation = null) {
    const paths = mkvH264HlsCachePaths(cacheKey, generation);
    if (!paths) return;
    await removeMkvH264HlsCachePath(paths.refPath).catch(() => {});
    if (generation) await removeMkvH264HlsCachePath(paths.generationDir).catch(() => {});
}

async function validateMkvH264HlsCacheFiles(paths, manifest) {
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length || files.length > MKV_H264_HLS_CACHE_MAX_FILES + 1) return false;
    const names = new Set();
    for (const entry of files) {
        const record = asRecord(entry);
        const name = safeSessionArtifactName(record.name);
        const size = Number(record.size);
        const digest = String(record.sha256 || '').toLowerCase();
        if (
            !name || names.has(name) ||
            !/^(?:playlist\.m3u8|segment-\d{5}\.ts)$/.test(name) ||
            !Number.isSafeInteger(size) || size <= 0 ||
            !/^[a-f0-9]{64}$/.test(digest)
        ) return false;
        names.add(name);
        const filePath = path.resolve(paths.generationDir, name);
        if (!isWithin(paths.generationDir, filePath)) return false;
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat?.isFile() || stat.size !== size) return false;
        if (await hashMkvH264HlsCacheFile(filePath) !== digest) return false;
    }
    return names.has('playlist.m3u8');
}

async function readMkvH264HlsCacheEntry(descriptor, nowMs = Date.now()) {
    if (!descriptor || !mkvH264HlsCacheEnabled()) return null;
    const basePaths = mkvH264HlsCachePaths(descriptor.cacheKey);
    if (!basePaths) return null;
    let generation = null;
    try {
        const ref = verifyMkvH264HlsCacheRecord(await readBoundedJsonFile(basePaths.refPath, 16 * 1024));
        generation = String(ref?.generation || '');
        if (
            Number(ref?.protocol) !== MKV_H264_HLS_CACHE_PROTOCOL ||
            ref?.cacheKey !== descriptor.cacheKey ||
            !/^[a-f0-9-]{16,80}$/.test(generation)
        ) throw new Error('cache_ref_invalid');
        const paths = mkvH264HlsCachePaths(descriptor.cacheKey, generation);
        if (!paths) throw new Error('cache_paths_invalid');
        const manifest = verifyMkvH264HlsCacheRecord(await readBoundedJsonFile(paths.manifestPath));
        const createdAtMs = Date.parse(String(manifest?.createdAt || ''));
        const expiresAtMs = Date.parse(String(manifest?.expiresAt || ''));
        if (
            Number(manifest?.protocol) !== MKV_H264_HLS_CACHE_PROTOCOL ||
            manifest?.cacheKey !== descriptor.cacheKey ||
            manifest?.generation !== generation ||
            manifest?.profileFingerprint !== descriptor.profileFingerprint ||
            manifest?.pipeline !== descriptor.pipeline ||
            Number(manifest?.build) !== descriptor.build ||
            !['prefix', 'complete'].includes(manifest?.state) ||
            !Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) ||
            expiresAtMs <= createdAtMs ||
            expiresAtMs - createdAtMs > MKV_H264_HLS_CACHE_TTL_MS ||
            Number(nowMs) >= expiresAtMs ||
            !validateMkvH264HlsFullFileProof(manifest?.fullFileProof, descriptor) ||
            !await validateMkvH264HlsCacheFiles(paths, manifest)
        ) throw new Error('cache_manifest_invalid');
        const playlist = await fsp.readFile(paths.playlistPath, 'utf8');
        const inspection = inspectMkvH264HlsCachePlaylist(playlist);
        const expectedSegments = manifest.state === 'prefix'
            ? MKV_H264_HLS_CACHE_PREFIX_SEGMENTS
            : Number(manifest.fullFileProof.segmentCount);
        if (
            inspection.unsafeReference || !inspection.independent || !inspection.sequential ||
            inspection.discontinuityCount !== 0 ||
            inspection.segments.length !== expectedSegments ||
            (manifest.state === 'prefix' && inspection.complete) ||
            (manifest.state === 'complete' && !inspection.complete)
        ) throw new Error('cache_playlist_invalid');
        mkvH264HlsCacheStats.hits += 1;
        return { descriptor, generation, paths, manifest, inspection };
    } catch (_) {
        mkvH264HlsCacheStats.misses += 1;
        if (generation) {
            mkvH264HlsCacheStats.corruptions += 1;
            await invalidateMkvH264HlsCacheEntry(descriptor.cacheKey, generation).catch(() => {});
        }
        return null;
    }
}

async function withMkvH264HlsCachePromotionLock(cacheKey, operation) {
    const prior = mkvH264HlsCachePromotionLocks.get(cacheKey) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    mkvH264HlsCachePromotionLocks.set(cacheKey, next);
    try {
        return await next;
    } finally {
        if (mkvH264HlsCachePromotionLocks.get(cacheKey) === next) {
            mkvH264HlsCachePromotionLocks.delete(cacheKey);
        }
    }
}

async function listMkvH264HlsCacheMetadata(nowMs = Date.now()) {
    if (!mkvH264HlsCacheEnabled()) return [];
    const rootPaths = mkvH264HlsCachePaths('0'.repeat(64));
    if (!rootPaths) return [];
    await fsp.mkdir(rootPaths.refsDir, { recursive: true });
    await fsp.mkdir(rootPaths.entriesDir, { recursive: true });
    const names = (await fsp.readdir(rootPaths.refsDir).catch(() => []))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .slice(0, MKV_H264_HLS_CACHE_MAX_ENTRIES * 4);
    const metadata = [];
    for (const name of names) {
        const cacheKey = name.slice(0, -5);
        let generation = null;
        try {
            const paths = mkvH264HlsCachePaths(cacheKey);
            const ref = verifyMkvH264HlsCacheRecord(await readBoundedJsonFile(paths.refPath, 16 * 1024));
            generation = String(ref?.generation || '');
            const generationPaths = mkvH264HlsCachePaths(cacheKey, generation);
            if (
                Number(ref?.protocol) !== MKV_H264_HLS_CACHE_PROTOCOL ||
                ref?.cacheKey !== cacheKey ||
                !generationPaths
            ) throw new Error('cache_ref_invalid');
            const manifest = verifyMkvH264HlsCacheRecord(await readBoundedJsonFile(generationPaths.manifestPath));
            const createdAtMs = Date.parse(String(manifest?.createdAt || ''));
            const expiresAtMs = Date.parse(String(manifest?.expiresAt || ''));
            const totalBytes = Number(manifest?.totalBytes);
            if (
                manifest?.cacheKey !== cacheKey ||
                manifest?.generation !== generation ||
                !Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) ||
                !Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
                Number(nowMs) >= expiresAtMs
            ) throw new Error('cache_metadata_invalid');
            metadata.push({ cacheKey, generation, paths: generationPaths, manifest, createdAtMs, expiresAtMs, totalBytes });
        } catch (_) {
            await invalidateMkvH264HlsCacheEntry(cacheKey, generation).catch(() => {});
        }
    }
    return metadata;
}

async function enforceMkvH264HlsCacheQuotas(incomingBytes, replacingKey = null) {
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes <= 0 || incomingBytes > MKV_H264_HLS_CACHE_MAX_BYTES) {
        return false;
    }
    const metadata = await listMkvH264HlsCacheMetadata();
    const retained = metadata.filter((entry) => entry.cacheKey !== replacingKey);
    retained.sort((left, right) => left.createdAtMs - right.createdAtMs);
    let totalBytes = retained.reduce((sum, entry) => sum + entry.totalBytes, 0);
    while (
        retained.length >= MKV_H264_HLS_CACHE_MAX_ENTRIES ||
        totalBytes + incomingBytes > MKV_H264_HLS_CACHE_MAX_BYTES
    ) {
        const evicted = retained.shift();
        if (!evicted) return false;
        totalBytes -= evicted.totalBytes;
        await invalidateMkvH264HlsCacheEntry(evicted.cacheKey, evicted.generation).catch(() => {});
        mkvH264HlsCacheStats.evictions += 1;
    }
    return totalBytes + incomingBytes <= MKV_H264_HLS_CACHE_MAX_BYTES;
}

async function promoteMkvH264HlsCacheFromCompletedSession(session) {
    const descriptor = session?.hlsCacheDescriptor || mkvH264HlsCacheDescriptorForSession(session);
    if (
        !descriptor ||
        videoModeForSession(session) !== 'copy' ||
        session?.inputFailure || session?.lastError ||
        !session?.playlistPath || !isWithin(session.outputDir, session.playlistPath)
    ) return null;
    const startedAtMs = Number(session?.hlsCacheProductionStartedAtMs);
    const elapsedSeconds = (Date.now() - startedAtMs) / 1_000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
    const playlist = await fsp.readFile(session.playlistPath, 'utf8').catch(() => null);
    if (!playlist) return null;
    const inspection = inspectMkvH264HlsCachePlaylist(playlist);
    const productionRateX = inspection.durationSeconds / elapsedSeconds;
    if (!Number.isFinite(productionRateX) || productionRateX < MKV_H264_HLS_CACHE_MIN_PRODUCTION_RATE_X) return null;
    const profile = asRecord(session.codecProfile);
    const profileDurationSeconds = Number(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration);
    const packetScan = await scanLocalMkvH264HlsPackets(session.playlistPath, inspection.durationSeconds);
    const fullFileProof = buildMkvH264HlsFullFileProof(
        playlist,
        descriptor,
        profileDurationSeconds,
        packetScan,
    );
    if (!fullFileProof) return null;

    const segmentSources = [];
    let allSegmentBytes = 0;
    for (const segment of inspection.segments) {
        const sourcePath = path.resolve(session.outputDir, segment.name);
        if (!isWithin(session.outputDir, sourcePath)) return null;
        const stat = await fsp.stat(sourcePath).catch(() => null);
        if (!stat?.isFile() || stat.size <= 0) return null;
        allSegmentBytes += stat.size;
        segmentSources.push({ ...segment, sourcePath, size: stat.size });
    }
    const completeBytes = Buffer.byteLength(playlist) + allSegmentBytes;
    const state = completeBytes <= MKV_H264_HLS_CACHE_MAX_COMPLETE_BYTES ? 'complete' : 'prefix';
    const selectedSegments = state === 'complete'
        ? segmentSources
        : segmentSources.slice(0, MKV_H264_HLS_CACHE_PREFIX_SEGMENTS);
    if (selectedSegments.length < MKV_H264_HLS_CACHE_PREFIX_SEGMENTS) return null;
    const publishedPlaylist = state === 'complete'
        ? playlist
        : renderMkvH264HlsPrefixPlaylist(inspection);
    if (!publishedPlaylist) return null;
    const mediaBytes = Buffer.byteLength(publishedPlaylist) + selectedSegments.reduce(
        (sum, segment) => sum + segment.size,
        0,
    );
    // Reserve a conservative signed-manifest allowance in the quota. This
    // intentionally over-counts rather than allowing metadata to escape the
    // bounded media-byte budget on entries with thousands of segments.
    const totalBytes = mediaBytes + Math.min(
        8 * 1024 * 1024,
        4_096 + ((selectedSegments.length + 1) * 256),
    );

    return withMkvH264HlsCachePromotionLock('__global__', async () => {
        if (!await enforceMkvH264HlsCacheQuotas(totalBytes, descriptor.cacheKey)) return null;
        const prior = (await listMkvH264HlsCacheMetadata())
            .find((entry) => entry.cacheKey === descriptor.cacheKey) || null;
        const createdAtMs = prior?.createdAtMs || Date.now();
        const expiresAtMs = prior?.expiresAtMs || (createdAtMs + MKV_H264_HLS_CACHE_TTL_MS);
        if (Date.now() >= expiresAtMs) return null;
        const generation = `${Date.now().toString(16)}-${crypto.randomUUID()}`.toLowerCase();
        const paths = mkvH264HlsCachePaths(descriptor.cacheKey, generation);
        if (!paths) return null;
        const stagingDir = path.resolve(paths.keyDir, `.${generation}.tmp`);
        if (!isWithin(paths.keyDir, stagingDir)) return null;
        let published = false;
        try {
            await fsp.mkdir(paths.keyDir, { recursive: true });
            await fsp.mkdir(stagingDir, { recursive: false });
            const files = [];
            const stagingPlaylistPath = path.resolve(stagingDir, 'playlist.m3u8');
            await fsp.writeFile(stagingPlaylistPath, publishedPlaylist, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            files.push({
                name: 'playlist.m3u8',
                size: Buffer.byteLength(publishedPlaylist),
                sha256: await hashMkvH264HlsCacheFile(stagingPlaylistPath),
            });
            for (const segment of selectedSegments) {
                const destination = path.resolve(stagingDir, segment.name);
                if (!isWithin(stagingDir, destination)) throw new Error('cache_segment_path_invalid');
                await fsp.copyFile(segment.sourcePath, destination, fs.constants.COPYFILE_EXCL);
                files.push({
                    name: segment.name,
                    size: segment.size,
                    sha256: await hashMkvH264HlsCacheFile(destination),
                });
            }
            const manifest = signedMkvH264HlsCacheRecord({
                protocol: MKV_H264_HLS_CACHE_PROTOCOL,
                cacheKey: descriptor.cacheKey,
                generation,
                state,
                profileFingerprint: descriptor.profileFingerprint,
                pipeline: descriptor.pipeline,
                build: descriptor.build,
                createdAt: new Date(createdAtMs).toISOString(),
                expiresAt: new Date(expiresAtMs).toISOString(),
                productionRateX: Number(productionRateX.toFixed(3)),
                totalBytes,
                fullFileProof,
                files,
            });
            await atomicWriteMkvH264HlsCacheJson(path.resolve(stagingDir, 'manifest.json'), manifest);
            await fsp.rename(stagingDir, paths.generationDir);
            await atomicWriteMkvH264HlsCacheJson(paths.refPath, signedMkvH264HlsCacheRecord({
                protocol: MKV_H264_HLS_CACHE_PROTOCOL,
                cacheKey: descriptor.cacheKey,
                generation,
            }));
            published = true;
            if (prior?.generation && prior.generation !== generation) {
                await removeMkvH264HlsCachePath(prior.paths.generationDir).catch(() => {});
            }
            mkvH264HlsCacheStats.promotions += 1;
            if (state === 'complete') mkvH264HlsCacheStats.completePromotions += 1;
            else mkvH264HlsCacheStats.prefixPromotions += 1;
            return { descriptor, generation, paths, manifest, inspection };
        } finally {
            if (!published) {
                await removeMkvH264HlsCachePath(stagingDir).catch(() => {});
                await removeMkvH264HlsCachePath(paths.generationDir).catch(() => {});
            }
        }
    });
}

function multiAudioProfileAssessment(session) {
    if (!isFiniteMkvVodSession(session)) {
        return { eligible: false, reason: 'not_finite_mkv', sourceTrackCount: 0, tracks: [] };
    }

    const profile = asRecord(session?.codecProfile);
    const profileSource = String(session?.codecProfileSource || '').trim().toLowerCase();
    if (!profileSource || profileSource === 'request_flat') {
        return { eligible: false, reason: 'profile_source_untrusted', sourceTrackCount: 0, tracks: [] };
    }

    const container = normalizeCodecToken(profile.container);
    const durationSeconds = Number(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration);
    const fileSizeBytes = Number(profile.fileSizeBytes ?? profile.file_size_bytes ?? profile.sizeBytes);
    const videoWidth = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const videoHeight = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    const subtitles = Array.isArray(profile.subtitles)
        ? profile.subtitles
        : (Array.isArray(profile.subtitleTracks)
            ? profile.subtitleTracks
            : (Array.isArray(profile.subtitle_tracks) ? profile.subtitle_tracks : null));
    const sourceTracks = Array.isArray(profile.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : []);
    const probeSource = normalizeCodecToken(profile.probeSource ?? profile.probe_source);
    const exactProbeSources = new Set([
        'gatewayinband',
        'gatewayprobe',
        'exactfileprobe',
        'exactfilecodecprobe',
    ]);
    const subtitleIndexes = subtitles?.map((track) => Number(track?.index)) || [];
    const completeProfile = Boolean(
        (container === 'mkv' || container.includes('matroska')) &&
        (profile.metadataComplete === true || profile.metadata_complete === true) &&
        Number.isFinite(durationSeconds) && durationSeconds > 0 &&
        Number.isSafeInteger(fileSizeBytes) && fileSizeBytes > 0 &&
        stringOrNull(profile.videoCodec ?? profile.video_codec ?? profile.video) &&
        subtitles &&
        subtitleIndexes.every((index) => Number.isInteger(index) && index >= 0 && index <= 1024) &&
        new Set(subtitleIndexes).size === subtitleIndexes.length &&
        exactProbeSources.has(probeSource) &&
        Number.isFinite(Date.parse(String(profile.probedAt ?? profile.probed_at ?? '')))
    );
    if (!completeProfile) {
        return {
            eligible: false,
            reason: 'profile_incomplete',
            sourceTrackCount: sourceTracks.length,
            tracks: [],
        };
    }

    // Every multi-audio graph is video-encoded to align its two-second HLS
    // boundaries with every audio rendition. Keep the production v92 capacity
    // ceiling fail-closed; an oversized or dimensionless source falls back to
    // the unchanged single-audio path instead of risking a stalled replica.
    if (
        !Number.isInteger(videoWidth) || !Number.isInteger(videoHeight) ||
        videoWidth <= 0 || videoHeight <= 0 ||
        videoWidth > EXACT_MATROSKA_H264_MAX_WIDTH ||
        videoHeight > EXACT_MATROSKA_H264_MAX_HEIGHT ||
        videoWidth * videoHeight > EXACT_MATROSKA_H264_MAX_PIXELS
    ) {
        return {
            eligible: false,
            reason: 'video_dimensions_out_of_capacity',
            sourceTrackCount: sourceTracks.length,
            tracks: [],
        };
    }

    if (sourceTracks.length < 2) {
        return {
            eligible: false,
            reason: 'audio_track_count_below_minimum',
            sourceTrackCount: sourceTracks.length,
            tracks: [],
        };
    }
    if (sourceTracks.length > MAX_MULTI_AUDIO_RENDITIONS) {
        return {
            eligible: false,
            reason: 'audio_track_cap_exceeded',
            sourceTrackCount: sourceTracks.length,
            tracks: [],
        };
    }

    const tracks = sourceTracks.map((track, hlsIndex) => {
        const streamIndex = Number(track?.index);
        const sourceChannels = Number(track?.channels);
        const sourceCodec = stringOrNull(track?.codec);
        return {
            hlsIndex,
            streamIndex,
            language: normalizeHlsAudioLanguage(track?.language),
            title: sanitizeAudioRenditionTitle(track?.title, hlsIndex),
            sourceChannels,
            sourceCodec,
            sourceDefault: track?.default === true,
        };
    });
    const streamIndexes = tracks.map((track) => track.streamIndex);
    if (
        tracks.some((track) => (
            !Number.isInteger(track.streamIndex) || track.streamIndex < 0 || track.streamIndex > 1024 ||
            !Number.isInteger(track.sourceChannels) || track.sourceChannels <= 0 || track.sourceChannels > 64 ||
            !track.sourceCodec
        )) ||
        new Set(streamIndexes).size !== streamIndexes.length
    ) {
        return {
            eligible: false,
            reason: 'invalid_audio_tracks',
            sourceTrackCount: sourceTracks.length,
            tracks: [],
        };
    }

    return {
        eligible: true,
        reason: 'eligible',
        sourceTrackCount: tracks.length,
        tracks,
    };
}

function normalizeHlsAudioLanguage(value) {
    const normalized = String(value || '').trim().replace(/_/g, '-').toLowerCase();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : 'und';
}

function sanitizeAudioRenditionTitle(value, hlsIndex) {
    const cleaned = String(value || '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || `Audio ${hlsIndex + 1}`).slice(0, 96);
}

function buildMultiAudioHlsPlan(session) {
    const assessment = multiAudioProfileAssessment(session);
    const base = {
        protocol: MULTI_AUDIO_HLS_PROTOCOL,
        enabled: false,
        reason: assessment.reason,
        maxAudioRenditions: MAX_MULTI_AUDIO_RENDITIONS,
        sourceTrackCount: assessment.sourceTrackCount,
        masterPlaylistName: 'playlist.m3u8',
        videoPlaylistName: null,
        defaultHlsIndex: null,
        defaultStreamIndex: null,
        audioRenditions: [],
    };
    if (!assessment.eligible) return base;

    const requestedStreamIndex = normalizeAudioStreamIndex(session?.audioStreamIndex);
    let defaultHlsIndex = Number.isInteger(requestedStreamIndex)
        ? assessment.tracks.findIndex((track) => track.streamIndex === requestedStreamIndex)
        : -1;
    if (defaultHlsIndex < 0) {
        defaultHlsIndex = assessment.tracks.findIndex((track) => track.sourceDefault === true);
    }
    if (defaultHlsIndex < 0) defaultHlsIndex = 0;

    const audioRenditions = assessment.tracks.map((track) => ({
        hlsIndex: track.hlsIndex,
        streamIndex: track.streamIndex,
        language: track.language,
        title: track.title,
        sourceChannels: track.sourceChannels,
        outputChannels: 2,
        codec: 'aac',
    }));
    const varStreamMap = [
        ...audioRenditions.map((rendition) => (
            `a:${rendition.hlsIndex},agroup:audio,language:${rendition.language},` +
            `default:${rendition.hlsIndex === defaultHlsIndex ? 'yes' : 'no'},name:audio_${rendition.hlsIndex}`
        )),
        'v:0,agroup:audio,name:video',
    ].join(' ');

    return {
        ...base,
        enabled: true,
        reason: 'enabled',
        videoPlaylistName: 'video.m3u8',
        defaultHlsIndex,
        defaultStreamIndex: audioRenditions[defaultHlsIndex].streamIndex,
        audioRenditions,
        varStreamMap,
    };
}

function multiAudioHlsEnabled(session) {
    return session?.multiAudioHls?.enabled === true;
}

function audioRenditionsForSession(session) {
    if (!multiAudioHlsEnabled(session)) return [];
    return session.multiAudioHls.audioRenditions.map((rendition) => ({ ...rendition }));
}

function multiAudioHlsDiagnosticsForSession(session) {
    const plan = asRecord(session?.multiAudioHls);
    return {
        protocol: MULTI_AUDIO_HLS_PROTOCOL,
        enabled: plan.enabled === true,
        reason: stringOrNull(plan.reason) || 'not_evaluated',
        maxAudioRenditions: MAX_MULTI_AUDIO_RENDITIONS,
        sourceTrackCount: Number.isInteger(plan.sourceTrackCount) ? plan.sourceTrackCount : 0,
        masterPlaylist: 'playlist.m3u8',
        videoPlaylist: plan.enabled === true ? plan.videoPlaylistName : 'playlist.m3u8',
        defaultHlsIndex: Number.isInteger(plan.defaultHlsIndex) ? plan.defaultHlsIndex : null,
        defaultStreamIndex: Number.isInteger(plan.defaultStreamIndex) ? plan.defaultStreamIndex : null,
    };
}

function freezeMultiAudioHlsTopology(session) {
    const plan = buildMultiAudioHlsPlan(session);
    session.multiAudioHls = plan;
    session.videoPlaylistPath = plan.enabled
        ? path.join(session.outputDir, plan.videoPlaylistName)
        : session.playlistPath;
    session.forceAlignedMultiAudioVideoEncode = plan.enabled === true;
    if (plan.enabled) session.hlsTargetSeconds = EXACT_MATROSKA_H264_HLS_TARGET_SECONDS;
    session.startupTimings = asRecord(session.startupTimings);
    session.startupTimings.multiAudioHls = multiAudioHlsDiagnosticsForSession(session);
    return plan;
}

function audioArgsForSession(session, copyAudio = shouldCopyAudio(session)) {
    return copyAudio ? ['-c:a', 'copy'] : TRANSCODE_AUDIO_ARGS;
}

function audioModeForSession(session) {
    if (session?.assetSource === 'complete-hls-cache') return 'copy';
    return shouldCopyAudio(session) ? 'copy' : 'transcode';
}

function videoModeForSession(session) {
    if (session.videoMode === 'encode' || session.videoMode === 'copy') return session.videoMode;
    return (
        session.forceAlignedMultiAudioVideoEncode === true ||
        session.forceExactMatroskaH264Reencode === true ||
        session.mode === 'transcode' ||
        !shouldCopyVideo(session)
    ) ? 'encode' : 'copy';
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
    // Multi-rendition HLS has one normalized contract for every source track:
    // AAC-LC, 48 kHz, stereo. Never copy a subset or advertise source 5.1.
    if (multiAudioHlsEnabled(session) || session.forceMkvH264FastStartAudioTranscode === true) return false;
    const requestedMode = normalizeCodecToken(session.audioMode);
    if (requestedMode === 'transcode' || requestedMode === 'encode') return false;
    if (session.clientAudioPassthrough === false) return false;

    const selectedTrack = selectedAudioTrackForSession(session);
    const proofBoundFastStartAudio = session.mkvH264FastStart?.eligible === true &&
        session.mkvH264FastStartAudioAuthority === true;
    if (proofBoundFastStartAudio && !selectedTrack) return false;
    const codec = normalizeCodecToken(
        selectedTrack?.codec ||
        (proofBoundFastStartAudio ? '' : (
            session.audioCodec ||
            session.codecProfile?.audioCodec ||
            session.codecProfile?.audio_codec ||
            session.codecProfile?.audio
        ))
    );
    const profile = normalizeCodecToken(
        selectedTrack?.profile ||
        (proofBoundFastStartAudio ? '' : (
            session.audioProfile ||
            session.codecProfile?.audioProfile ||
            session.codecProfile?.audio_profile
        ))
    );
    const channels = nullableInt(selectedTrack?.channels ?? (proofBoundFastStartAudio
        ? null
        : (session.audioChannels ?? session.codecProfile?.audioChannels ?? session.codecProfile?.audio_channels ?? session.codecProfile?.channels)));

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
    // Live streams deliberately avoid a second provider connection for codec
    // discovery. Finite VOD has already gone through the bounded probe, so an
    // unknown codec must fail safe to encoding instead of copying an undecodable
    // MKV stream into an otherwise valid-looking browser HLS playlist.
    if (!codec) return isLiveSession(session);
    return isKnownBrowserSafeVideo(codec);
}

function isKnownBrowserSafeVideo(codec) {
    const normalized = normalizeCodecToken(codec);
    return normalized.includes('h264') || normalized.includes('avc');
}

function audioMapForSession(session, required = false) {
    const optionalSuffix = required ? '' : '?';
    const selectedTrack = selectedAudioTrackForSession(session);
    const selectedIndex = normalizeAudioStreamIndex(selectedTrack?.index);
    if (Number.isInteger(selectedIndex)) return `0:${selectedIndex}${optionalSuffix}`;
    // An unproven absolute stream index can point at video, subtitles, or an
    // attachment. Fall back by media type unless the exact-file profile
    // proves that the requested index belongs to an audio track.
    return `0:a:0${optionalSuffix}`;
}

function audioTracksForSession(session) {
    return Array.isArray(session?.codecProfile?.audioTracks)
        ? session.codecProfile.audioTracks
        : (Array.isArray(session?.codecProfile?.audio_tracks) ? session.codecProfile.audio_tracks : []);
}

function selectedAudioTrackForSession(session) {
    const tracks = Array.isArray(session.codecProfile?.audioTracks)
        ? session.codecProfile.audioTracks
        : (Array.isArray(session.codecProfile?.audio_tracks) ? session.codecProfile.audio_tracks : []);
    if (!tracks.length) return null;
    const requestedIndex = normalizeAudioStreamIndex(session.audioStreamIndex);
    if (Number.isInteger(requestedIndex)) {
        const selected = tracks.find((track) => normalizeAudioStreamIndex(track?.index) === requestedIndex);
        if (selected) return selected;
    }
    return tracks.find((track) => track?.default === true) || tracks[0] || null;
}

function mappedAudioStreamIndexForSession(session) {
    if (Object.prototype.hasOwnProperty.call(asRecord(session), 'actualMappedAudioStreamIndex')) {
        const actualIndex = normalizeAudioStreamIndex(session.actualMappedAudioStreamIndex);
        return Number.isInteger(actualIndex) ? actualIndex : null;
    }
    const selectedIndex = normalizeAudioStreamIndex(selectedAudioTrackForSession(session)?.index);
    return Number.isInteger(selectedIndex) ? selectedIndex : null;
}

function isKnownBrowserSafeAudio(codec, profile) {
    const joined = `${codec} ${profile}`;
    if (hasHeAacMarker(joined)) return false;
    // This predicate is for the Gateway's MPEG-TS HLS output, not for a
    // browser opening the original MP4 directly. Chrome/hls.js can accept MP3,
    // Opus or Vorbis in other containers yet fail to append that copied audio
    // from MPEG-TS, leaving the video at HAVE_METADATA (~0.1 s). AAC-LC stereo
    // is the only copy path we can advertise reliably here; every other codec
    // is normalized to the AAC-LC fallback above.
    return codec.includes('aac') || codec.includes('mp4a.40.2');
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
    // This must stay aligned with FFmpeg's `0:V:0` playback map. In
    // particular, cover art and thumbnail streams can precede the actual movie
    // video in ffprobe JSON but uppercase `V` excludes them from playback.
    const video = streams.find((stream) => (
        stream?.codec_type === 'video' &&
        Number(stream?.disposition?.attached_pic || 0) !== 1 &&
        Number(stream?.disposition?.timed_thumbnails || 0) !== 1 &&
        Number(stream?.disposition?.still_image || 0) !== 1
    )) || {};
    const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
    const subtitleStreams = streams.filter((stream) => stream?.codec_type === 'subtitle');
    const audio = audioStreams[0] || {};
    const format = asRecord(payload.format);
    return compactRecord({
        videoStreamIndex: nullableInt(video.index),
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
            profile: stringOrNull(stream.profile),
            channels: nullableInt(stream.channels),
            sampleRate: nullableInt(stream.sample_rate),
            channelLayout: stringOrNull(stream.channel_layout),
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
        // The in-band probe runs against a bounded local header cache file;
        // its format.size is that temporary prefix, never the source VOD size.
        fileSizeBytes: probeSource === 'gateway_inband'
            ? null
            : normalizeFileSizeBytes(format.size),
        // MPEG-TS (and other stream containers) carry no global duration, so ffprobe leaves
        // format.duration empty even when it knows the overall bit rate and file size. Fall back to
        // size*8/bitrate (CBR estimate — plenty accurate to draw a seek bar) so an on-the-fly TS
        // transcode still gets a timeline instead of a duration-less, unseekable player.
        // A local in-band probe sees a bounded temporary prefix, not the source
        // file size. Estimating duration from prefix-size/bitrate would create a
        // plausible but severely truncated timeline. Only a duration declared
        // by Matroska Info is authoritative on this lane.
        durationSeconds: nullableFloat(format.duration) || (
            probeSource === 'gateway_inband' ? null : estimateDurationFromFormat(format)
        ),
        // Like format.size, ffprobe derives format.bit_rate for the temporary
        // prefix rather than the full source. Omit it so a truthful request
        // profile bitrate survives the merge.
        bitRate: probeSource === 'gateway_inband' ? null : nullableInt(format.bit_rate),
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

function cachedSignedMkvH264FastStartProfile(sourceUrl) {
    if (CODEC_PROFILE_CACHE_TTL_MS <= 0 || !sourceUrl) return null;
    const hit = codecProfileCache.get(sourceUrl);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        codecProfileCache.delete(sourceUrl);
        return null;
    }
    const profile = asRecord(hit.profile);
    // Do not treat arbitrary cached metadata as authorization. Only carry a
    // v2-shaped opaque envelope forward; the current source, provider, profile,
    // size and pre-opened ETag are still verified after the one provider GET.
    return (mkvH264FastStartProofForProfile(profile) || mkvCompleteHlsCacheProofForProfile(profile))
        ? profile
        : null;
}

// Run ffprobe on the in-band-captured leading bytes (a local temp file) so we learn the
// track languages WITHOUT a provider connection. Returns a useful profile or null (caller
// then falls back to the provider probe — e.g. an MP4 whose moov sits at the end, so the
// leading bytes don't parse). Best-effort; never throws.
function readEbmlElementSize(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || offset < 0 || offset >= buffer.length) return null;
    const first = buffer[offset];
    let width = 1;
    let marker = 0x80;
    while (width <= 8 && (first & marker) === 0) {
        width += 1;
        marker >>= 1;
    }
    if (width > 8 || offset + width > buffer.length) return null;
    let value = BigInt(first & (marker - 1));
    let allOnes = (first & (marker - 1)) === (marker - 1);
    for (let index = 1; index < width; index += 1) {
        value = (value << 8n) | BigInt(buffer[offset + index]);
        allOnes = allOnes && buffer[offset + index] === 0xff;
    }
    if (allOnes) return { width, value: null, unknown: true };
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { width, value: Number(value), unknown: false };
}

function readEbmlElementHeader(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || offset < 0 || offset >= buffer.length) return null;
    const first = buffer[offset];
    let idWidth = 1;
    let marker = 0x80;
    while (idWidth <= 4 && (first & marker) === 0) {
        idWidth += 1;
        marker >>= 1;
    }
    if (idWidth > 4 || offset + idWidth > buffer.length) return null;
    let id = 0n;
    for (let index = 0; index < idWidth; index += 1) {
        id = (id << 8n) | BigInt(buffer[offset + index]);
    }
    const size = readEbmlElementSize(buffer, offset + idWidth);
    if (!size) return null;
    const payloadStart = offset + idWidth + size.width;
    const payloadEnd = size.unknown ? null : payloadStart + size.value;
    return { id, payloadStart, payloadEnd, unknownSize: size.unknown };
}

function hasCompleteMatroskaMetadataPrefix(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
    const ebml = readEbmlElementHeader(buffer, 0);
    if (!ebml || ebml.id !== 0x1a45dfa3n || ebml.payloadEnd === null || ebml.payloadEnd > buffer.length) return false;
    const segment = readEbmlElementHeader(buffer, ebml.payloadEnd);
    if (!segment || segment.id !== 0x18538067n || segment.payloadStart > buffer.length) return false;

    let foundInfo = false;
    let foundTracks = false;
    let inspectedElements = 0;
    let cursor = segment.payloadStart;
    const segmentEnd = segment.payloadEnd === null
        ? buffer.length
        : Math.min(buffer.length, segment.payloadEnd);
    while (cursor < segmentEnd) {
        if (inspectedElements >= MAX_MATROSKA_METADATA_ELEMENTS) return false;
        inspectedElements += 1;
        const element = readEbmlElementHeader(buffer, cursor);
        if (!element || element.payloadEnd === null || element.payloadEnd > segmentEnd) return false;
        if (element.id === 0x1549a966n) foundInfo = true;
        if (element.id === 0x1654ae6bn) foundTracks = true;
        if (foundInfo && foundTracks) return true;
        cursor = element.payloadEnd;
    }
    return false;
}

async function probeFromHeaderBytes(sourceUrl, options = {}) {
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
            // The capture is already strictly bounded (default 4 MB). Let the
            // local probe inspect all retained bytes so a large EBML header
            // cannot hide Tracks between the legacy 2 MB probe cap and the end
            // of the safe local prefix.
            '-probesize', String(buf.length),
            '-show_streams',
            '-show_format',
            '-print_format', 'json',
            tmpFile
        ];
        const payload = await runFfprobe(args, CODEC_PROBE_TIMEOUT_MS, sourceUrl, {
            signal: options?.signal || null,
        });
        const profile = {
            ...buildCodecProfile(payload, startedAt, 'gateway_inband'),
            fileSizeBytes: normalizeFileSizeBytes(options?.fileSizeBytes),
            metadataComplete: hasCompleteMatroskaMetadataPrefix(buf),
        };
        return hasUsefulCodecProfile(profile) ? profile : null;
    } catch (_) {
        return null;
    } finally {
        await fsp.unlink(tmpFile).catch(() => {});
    }
}

// Cached front for probeCodecProfileUncached. Resolution order, cheapest first:
//   1. codec-profile cache (memory, no work)              -> probeStats.cacheHits
//   2. in-band header bytes tee'd from /raw (local probe) -> probeStats.inbandHits, ZERO provider conn
//   3. provider probe (opens a connection)                -> probeStats.successes
// A successful profile for a source URL is reused for CODEC_PROFILE_CACHE_TTL_MS. Failures
// and empty profiles are NOT cached, so a transient refusal retries on the next call.
async function probeCodecProfile(sourceUrl, userAgent, options = {}) {
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
    if ((INBAND_HEADER_PARSE || BOUNDED_MKV_HEADER_PARSE) && sourceUrl) {
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
    if (options.localOnly === true) return {};
    const profile = await probeCodecProfileUncached(sourceUrl, userAgent, options);
    cacheCodecProfile(sourceUrl, profile);
    return profile;
}

async function probeCodecProfileUncached(sourceUrl, userAgent, options = {}) {
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

    const payload = await runFfprobe(args, CODEC_PROBE_TIMEOUT_MS, sourceUrl, options);
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

function backgroundProbeError(status, code, publicMessage) {
    const error = new Error(publicMessage);
    error.status = status;
    error.code = code;
    error.publicMessage = publicMessage;
    return error;
}

function isFfprobeProviderBusyFailure(value) {
    if (isProxyAuthenticationFailure(value)) return false;
    const message = `${String(value?.message || value || '')}\n${String(value?.ffprobeLog || '')}`.toLowerCase();
    return message.includes('http 458')
        || message.includes('status 458')
        || message.includes('max connection');
}

function runFfprobe(args, timeoutMs, sourceUrl, options = {}) {
    return new Promise((resolve, reject) => {
        const abortSignal = options?.signal || null;
        const abortedError = () => {
            const error = new Error('Codec probe aborted');
            error.code = 'VOD_INPUT_ABORTED';
            return error;
        };
        if (abortSignal?.aborted) {
            reject(abortedError());
            return;
        }
        const backgroundKey = options.background === true ? proxyKeyFromUrl(sourceUrl) : '';
        // The route-level guard is intentionally repeated at the exact spawn boundary.
        // probeCodecProfile may await a local-header probe first; without this atomic
        // check, a viewer can start in the meantime or two background requests can both
        // pass the HTTP guard and open provider connections.
        if (backgroundKey && viewerPlaybackActiveLocally()) {
            reject(backgroundProbeError(
                409,
                'account_busy',
                'Account busy (active playback)',
            ));
            return;
        }
        if (backgroundKey && accountExtractions.get(backgroundKey)?.size) {
            reject(backgroundProbeError(
                429,
                'background_busy',
                'Account busy (background extraction)',
            ));
            return;
        }
        const child = spawn(FFPROBE_PATH, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: proxyEnvFor(proxyKeyFromUrl(sourceUrl)),
        });
        const registration = options.background === true
            ? registerAccountExtraction(backgroundKey, child)
            : null;
        const releaseRegistration = () => registration?.release?.();
        const terminalError = (fallback) => {
            if (registration?.preempted) {
                return backgroundProbeError(
                    409,
                    'viewer_preempted',
                    'Codec probe preempted by active playback',
                );
            }
            if (isProxyAuthenticationFailure(fallback)) {
                return backgroundProbeError(
                    502,
                    'PROXY_AUTH_FAILED',
                    'The media service is temporarily unavailable.',
                );
            }
            if (isFfprobeProviderBusyFailure(fallback)) {
                return backgroundProbeError(
                    458,
                    'PROVIDER_BUSY',
                    'This TV service is busy. Wait a few seconds, then try again.',
                );
            }
            return fallback;
        };
        let stdout = '';
        let stderr = '';
        let finished = false;
        let terminatingError = null;
        let forceKillTimer = null;
        const clearTimers = () => {
            clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            abortSignal?.removeEventListener?.('abort', onAbort);
        };
        const beginTermination = (error, signal = 'SIGTERM') => {
            if (finished || terminatingError) return;
            terminatingError = error;
            try { child.kill(signal); } catch (_) {}
            forceKillTimer = setTimeout(() => {
                if (!finished) {
                    try { child.kill('SIGKILL'); } catch (_) {}
                }
            }, 1_000);
            forceKillTimer.unref?.();
        };
        const onAbort = () => beginTermination(abortedError());
        const timer = setTimeout(() => {
            if (finished || terminatingError) return;
            const timeoutError = new Error('Codec probe timeout');
            // ffprobe can print the decisive HTTP status and then hang. Preserve
            // that evidence so a first 458/407 remains typed even when timeout
            // wins the process-event race.
            timeoutError.ffprobeLog = stderr;
            timeoutError.logTail = stderr;
            // Do not resolve/reject until the child has actually exited. The
            // caller may open the single-slot provider immediately afterwards.
            beginTermination(
                terminalError(timeoutError),
                registration?.preempted ? 'SIGKILL' : 'SIGTERM',
            );
        }, timeoutMs);
        abortSignal?.addEventListener?.('abort', onAbort, { once: true });

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
            clearTimers();
            releaseRegistration();
            reject(terminatingError || terminalError(err));
        });
        child.on('exit', (code, signal) => {
            if (finished) return;
            finished = true;
            clearTimers();
            releaseRegistration();
            if (terminatingError) {
                reject(terminatingError);
                return;
            }
            if (code !== 0) {
                const failure = new Error(
                    `Codec probe exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${stderr ? `: ${lastNonEmptyLine(stderr)}` : ''}`,
                );
                failure.ffprobeLog = stderr;
                failure.logTail = stderr;
                reject(terminalError(failure));
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

function hasReliableVodCodecProfile(profile) {
    const record = asRecord(profile);
    const videoCodec = stringOrNull(
        record.videoCodec || record.video_codec || record.video
    );
    const audioTracks = Array.isArray(record.audioTracks)
        ? record.audioTracks
        : (Array.isArray(record.audio_tracks) ? record.audio_tracks : []);
    const audioCodec = stringOrNull(
        record.audioCodec ||
        record.audio_codec ||
        record.audio ||
        audioTracks.find((track) => stringOrNull(track?.codec))?.codec
    );
    return Boolean(videoCodec && audioCodec);
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

// A local Matroska prefix is authoritative only when ffprobe saw every
// structural family needed by playback. In particular, an empty subtitles
// array is meaningful (no subtitle tracks), while a missing array means the
// header was truncated before ffprobe could enumerate the family.
function hasCompleteMkvPlaybackProfile(profile) {
    const record = asRecord(profile);
    const container = normalizeCodecToken(record.container);
    if (!(container === 'mkv' || container.includes('matroska'))) return false;
    if (record.metadataComplete !== true && record.metadata_complete !== true) return false;

    const durationSeconds = Number(
        record.durationSeconds ?? record.duration_seconds ?? record.duration,
    );
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
    if (!stringOrNull(record.videoCodec ?? record.video_codec ?? record.video)) return false;

    const audioTracks = Array.isArray(record.audioTracks)
        ? record.audioTracks
        : (Array.isArray(record.audio_tracks) ? record.audio_tracks : null);
    if (!audioTracks?.length) return false;
    const audioIndexes = audioTracks.map((track) => normalizeAudioStreamIndex(track?.index));
    if (
        audioIndexes.some((index) => !Number.isInteger(index)) ||
        new Set(audioIndexes).size !== audioIndexes.length
    ) return false;

    const subtitles = Array.isArray(record.subtitles)
        ? record.subtitles
        : (Array.isArray(record.subtitleTracks)
            ? record.subtitleTracks
            : (Array.isArray(record.subtitle_tracks) ? record.subtitle_tracks : null));
    if (!subtitles) return false;
    const subtitleIndexes = subtitles.map((track) => normalizeAudioStreamIndex(track?.index));
    if (
        subtitleIndexes.some((index) => !Number.isInteger(index)) ||
        new Set(subtitleIndexes).size !== subtitleIndexes.length
    ) return false;

    if (normalizeCodecToken(record.probeSource ?? record.probe_source) !== 'gatewayinband') return false;
    return Number.isFinite(Date.parse(String(record.probedAt ?? record.probed_at ?? '')));
}

function mergeCodecProfiles(baseProfile, probeProfile) {
    const base = asRecord(baseProfile);
    const probe = asRecord(probeProfile);
    const probedAudioTracks = Array.isArray(probe.audioTracks)
        ? probe.audioTracks
        : (Array.isArray(probe.audio_tracks) ? probe.audio_tracks : undefined);
    const probedSubtitles = Array.isArray(probe.subtitles)
        ? probe.subtitles
        : (Array.isArray(probe.subtitleTracks)
            ? probe.subtitleTracks
            : (Array.isArray(probe.subtitle_tracks) ? probe.subtitle_tracks : undefined));
    return compactRecord({
        ...base,
        ...probe,
        // A fresh ffprobe result is authoritative even when a track family is
        // empty. Falling back on length would resurrect stale stream indexes.
        audioTracks: probedAudioTracks !== undefined ? probedAudioTracks : base.audioTracks,
        subtitles: probedSubtitles !== undefined ? probedSubtitles : base.subtitles,
    });
}

function shouldProbeMissingSubtitleTracks(profile, playbackHint, sourceUrl) {
    const record = asRecord(profile);
    const subtitleMaps = [record.subtitles, record.subtitleTracks, record.subtitle_tracks];
    const hasEnumeratedSubtitles = subtitleMaps.some((value) => Array.isArray(value) && value.length > 0);
    const hasSubtitleMap = subtitleMaps.some((value) => Array.isArray(value));
    const hasExactProbeProvenance = Boolean(
        stringOrNull(record.probeSource ?? record.probe_source) &&
        stringOrNull(record.probedAt ?? record.probed_at)
    );
    // Non-empty indexes are useful evidence on their own. An empty map is
    // authoritative only when it came from a completed, dated exact-file
    // probe: Edge normalization also creates [] for legacy partial profiles.
    if (hasEnumeratedSubtitles || (hasSubtitleMap && hasExactProbeProvenance)) return false;

    const hint = asRecord(playbackHint);
    // An exact zero is authoritative: there are no subtitle indexes to discover.
    // A positive count is NOT sufficient here because the session needs every
    // absolute stream index to produce the selectable WebVTT files. Keep the
    // probe when the compact hint says subtitles exist but does not enumerate
    // them, otherwise the speed-up would silently remove captions.
    const exactSubtitleTrackCount = nullableInt(
        hint.subtitleTrackCount ?? hint.subtitle_track_count
    );
    if (exactSubtitleTrackCount === 0) {
        return false;
    }
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

function parseHlsAttributeList(line) {
    const separator = String(line || '').indexOf(':');
    if (separator < 0) return {};
    const attributes = {};
    const body = String(line).slice(separator + 1);
    const matcher = /(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let match;
    while ((match = matcher.exec(body)) !== null) {
        const rawValue = match[2];
        attributes[match[1].toUpperCase()] = rawValue.startsWith('"')
            ? rawValue.slice(1, -1)
            : rawValue;
    }
    return attributes;
}

function controlledLocalPlaylistName(value) {
    const raw = String(value || '').split(/[?#]/, 1)[0];
    if (!raw || raw !== path.basename(raw) || raw.includes('/') || raw.includes('\\')) return null;
    return /^[a-z0-9][a-z0-9_-]*\.m3u8$/i.test(raw) ? raw : null;
}

function inspectMultiAudioMasterPlaylist(playlist, plan) {
    if (!plan?.enabled || !Array.isArray(plan.audioRenditions)) {
        return { ready: false, reason: 'multi_audio_plan_disabled' };
    }
    const lines = String(playlist || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') return { ready: false, reason: 'invalid_master_header' };

    const audioMedia = lines
        .filter((line) => line.startsWith('#EXT-X-MEDIA:'))
        .map(parseHlsAttributeList)
        .filter((attributes) => String(attributes.TYPE || '').toUpperCase() === 'AUDIO');
    if (audioMedia.length !== plan.audioRenditions.length) {
        return { ready: false, reason: 'audio_rendition_count_mismatch' };
    }

    const groupIds = new Set();
    let defaultCount = 0;
    for (let hlsIndex = 0; hlsIndex < audioMedia.length; hlsIndex += 1) {
        const attributes = audioMedia[hlsIndex];
        const rendition = plan.audioRenditions[hlsIndex];
        const expectedName = `audio_${hlsIndex}`;
        const expectedUri = `${expectedName}.m3u8`;
        const uri = controlledLocalPlaylistName(attributes.URI);
        const isDefault = String(attributes.DEFAULT || '').toUpperCase() === 'YES';
        if (
            attributes.NAME !== expectedName ||
            uri !== expectedUri ||
            normalizeHlsAudioLanguage(attributes.LANGUAGE) !== rendition.language ||
            !attributes['GROUP-ID']
        ) {
            return { ready: false, reason: 'audio_rendition_contract_mismatch' };
        }
        groupIds.add(attributes['GROUP-ID']);
        if (isDefault) defaultCount += 1;
        if (isDefault !== (hlsIndex === plan.defaultHlsIndex)) {
            return { ready: false, reason: 'audio_default_mismatch' };
        }
    }
    if (groupIds.size !== 1 || defaultCount !== 1) {
        return { ready: false, reason: 'audio_group_or_default_incomplete' };
    }

    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
        const attributes = parseHlsAttributeList(lines[index]);
        let uri = null;
        for (let next = index + 1; next < lines.length; next += 1) {
            if (lines[next].startsWith('#')) continue;
            uri = controlledLocalPlaylistName(lines[next]);
            break;
        }
        variants.push({ attributes, uri });
    }
    const onlyVariant = variants[0];
    if (
        variants.length !== 1 ||
        onlyVariant?.uri !== plan.videoPlaylistName ||
        onlyVariant?.attributes?.AUDIO !== Array.from(groupIds)[0]
    ) {
        return { ready: false, reason: 'video_variant_contract_mismatch' };
    }

    return {
        ready: true,
        reason: 'ready',
        audioRenditionCount: audioMedia.length,
        videoRenditionCount: 1,
    };
}

function hlsMediaPlaylistTargetsForSession(session) {
    if (!multiAudioHlsEnabled(session)) {
        return [{
            kind: 'single',
            hlsIndex: null,
            streamIndex: mappedAudioStreamIndexForSession(session),
            playlistName: path.basename(session.playlistPath),
            playlistPath: session.playlistPath,
        }];
    }
    const plan = session.multiAudioHls;
    return [
        {
            kind: 'video',
            hlsIndex: null,
            streamIndex: null,
            playlistName: plan.videoPlaylistName,
            playlistPath: session.videoPlaylistPath || path.resolve(session.outputDir, plan.videoPlaylistName),
        },
        ...plan.audioRenditions.map((rendition) => ({
            kind: 'audio',
            hlsIndex: rendition.hlsIndex,
            streamIndex: rendition.streamIndex,
            playlistName: `audio_${rendition.hlsIndex}.m3u8`,
            playlistPath: path.resolve(session.outputDir, `audio_${rendition.hlsIndex}.m3u8`),
        })),
    ];
}

async function inspectHlsMediaPlaylistArtifact(session, target) {
    if (!isWithin(session.outputDir, target.playlistPath)) return null;
    const playlist = await fsp.readFile(target.playlistPath, 'utf8');
    const inspection = inspectHlsStartupPlaylist(playlist, {
        minBufferSeconds: session?.minHlsStartupBufferSeconds,
        minSegments: session?.minHlsStartupSegments,
    });
    if (!inspection.ready) return null;
    const segmentPaths = inspection.segmentFiles.map((segment) => path.resolve(session.outputDir, segment));
    if (
        segmentPaths.length === 0 ||
        !segmentPaths.every((segmentPath) => isWithin(session.outputDir, segmentPath))
    ) return null;
    const stats = await Promise.all(segmentPaths.map((segmentPath) => fsp.stat(segmentPath)));
    if (!stats.every((stat) => stat.isFile() && stat.size > 0)) return null;
    return {
        ...target,
        inspection,
        firstSegmentBytes: stats[0].size,
        playlistSegmentBytes: stats.reduce((sum, stat) => sum + stat.size, 0),
    };
}

function inspectHlsStartupPlaylist(playlist, requirements = {}) {
    const requestedMinBufferSeconds = Number(requirements?.minBufferSeconds);
    const requestedMinSegments = Number(requirements?.minSegments);
    const minBufferSeconds = Number.isFinite(requestedMinBufferSeconds) && requestedMinBufferSeconds > 0
        ? requestedMinBufferSeconds
        : MIN_HLS_STARTUP_BUFFER_SECONDS;
    const minSegments = Number.isInteger(requestedMinSegments) && requestedMinSegments > 0
        ? requestedMinSegments
        : MIN_HLS_STARTUP_SEGMENTS;
    const lines = String(playlist || '').split(/\r?\n/);
    let durationSeconds = 0;
    let segmentCount = 0;
    let firstSegment = null;
    const segmentFiles = [];
    let pendingDuration = null;
    let completePlaylist = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line === '#EXT-X-ENDLIST') {
            completePlaylist = true;
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            const duration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
            pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
            continue;
        }
        if (line.startsWith('#') || pendingDuration === null) continue;
        const rawSegment = String(line || '').split(/[?#]/, 1)[0];
        const segment = (
            rawSegment &&
            rawSegment === path.basename(rawSegment) &&
            !rawSegment.includes('/') &&
            !rawSegment.includes('\\') &&
            /^[a-z0-9][a-z0-9._-]*\.(?:ts|m4s|mp4|aac)$/i.test(rawSegment)
        ) ? rawSegment : null;
        if (!segment) {
            pendingDuration = null;
            continue;
        }
        if (!firstSegment) firstSegment = segment;
        segmentFiles.push(segment);
        segmentCount += 1;
        durationSeconds += pendingDuration;
        pendingDuration = null;
    }

    const measuredDurationSeconds = durationSeconds;
    durationSeconds = Number(measuredDurationSeconds.toFixed(3));
    if (!segmentCount || !firstSegment) {
        return { ready: false, reason: 'no_segments', segmentCount: 0, durationSeconds: 0, firstSegment: null, segmentFiles: [] };
    }
    if (!completePlaylist && segmentCount < minSegments) {
        return { ready: false, reason: 'insufficient_segments', segmentCount, durationSeconds, firstSegment, segmentFiles };
    }
    if (!completePlaylist && measuredDurationSeconds < minBufferSeconds) {
        return { ready: false, reason: 'insufficient_duration', segmentCount, durationSeconds, firstSegment, segmentFiles };
    }
    return { ready: true, reason: 'ready', segmentCount, durationSeconds, firstSegment, segmentFiles };
}

async function waitForPlaylist(session, timeoutMs, abortSignal = null) {
    if (abortSignal?.aborted) throw abortedVodInputPumpError();
    if (session.status === 'ready') return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (abortSignal?.aborted) throw abortedVodInputPumpError();
        if (session.lastError) throw new Error(session.lastError);
        if (fs.existsSync(session.playlistPath)) {
            try {
                const masterPlaylist = await fsp.readFile(session.playlistPath, 'utf8');
                if (multiAudioHlsEnabled(session)) {
                    const masterInspection = inspectMultiAudioMasterPlaylist(
                        masterPlaylist,
                        session.multiAudioHls,
                    );
                    if (!masterInspection.ready) throw new Error(masterInspection.reason);
                }

                const targets = hlsMediaPlaylistTargetsForSession(session);
                const inspected = await Promise.all(
                    targets.map((target) => inspectHlsMediaPlaylistArtifact(session, target)),
                );
                if (inspected.some((result) => !result)) throw new Error('media_playlist_not_ready');

                const video = multiAudioHlsEnabled(session)
                    ? inspected.find((result) => result.kind === 'video')
                    : inspected[0];
                if (!video) throw new Error('video_playlist_not_ready');
                session.startupTimings = session.startupTimings || {};
                session.startupTimings.playlistSegmentCount = video.inspection.segmentCount;
                session.startupTimings.playlistBufferSeconds = video.inspection.durationSeconds;
                session.startupTimings.firstSegmentBytes = video.firstSegmentBytes;
                session.startupTimings.playlistSegmentBytes = video.playlistSegmentBytes;
                if (multiAudioHlsEnabled(session)) {
                    session.startupTimings.multiAudioHls = {
                        ...multiAudioHlsDiagnosticsForSession(session),
                        ready: true,
                        video: {
                            segmentCount: video.inspection.segmentCount,
                            bufferSeconds: video.inspection.durationSeconds,
                            firstSegmentBytes: video.firstSegmentBytes,
                            playlistSegmentBytes: video.playlistSegmentBytes,
                        },
                        audio: inspected
                            .filter((result) => result.kind === 'audio')
                            .map((result) => ({
                                hlsIndex: result.hlsIndex,
                                streamIndex: result.streamIndex,
                                segmentCount: result.inspection.segmentCount,
                                bufferSeconds: result.inspection.durationSeconds,
                                firstSegmentBytes: result.firstSegmentBytes,
                                playlistSegmentBytes: result.playlistSegmentBytes,
                            })),
                    };
                }
                return;
            } catch (error) {
                // FFmpeg updates HLS artifacts atomically. A rename/read/stat
                // race means "not ready yet", not a terminal provider failure.
            }
        }
        const remainingMs = Math.max(1, deadline - Date.now());
        if (!await waitForVodInputRetry(Math.min(250, remainingMs), abortSignal)) {
            throw abortedVodInputPumpError();
        }
    }
    throw new Error('Playlist timeout');
}

async function stopSession(session, options = {}) {
    if (session.stoppingPromise) return session.stoppingPromise;

    const stopReason = String(options?.reason || 'stopped');
    if (session.backgroundCacheContinuation === true && !session.backgroundCacheContinuationOutcome) {
        settleMkvCompleteHlsBackgroundContinuation(
            session,
            stopReason === 'viewer-preempted'
                ? 'preempted'
                : (stopReason === 'background-timeout' || stopReason === 'session-expired'
                    ? 'timeout'
                    : 'failed'),
        );
    }
    if (session.backgroundCacheContinuationTimer) {
        clearTimeout(session.backgroundCacheContinuationTimer);
        session.backgroundCacheContinuationTimer = null;
    }
    session.status = 'stopping';
    session.stoppingPromise = (async () => {
        const completeHlsCacheLease = session.completeHlsCacheLease;
        session.completeHlsCacheLease = null;
        completeHlsCacheLease?.release?.();
        const child = session.ffmpeg;
        session.ffmpeg = null;
        // The provider socket belongs to the pump, not FFmpeg. Abort and await
        // that exact owner first so a subsequent title cannot open until the old
        // mono-account connection has fully settled.
        await closePreopenedBoundedMkvInput(session);
        await stopBoundedMkvInputPump(session);
        await closeFiniteMkvSeekBroker(session);
        await stopChildProcess(child);
        releaseVideoEncoderAdmission(session);
        await session.completeHlsCachePromotionPromise?.catch(() => null);
        session.status = 'ended';
        sessions.delete(session.id);
        wakePlaybackBlockedQueues();
        await removeSessionDir(session.outputDir);
    })();

    return session.stoppingPromise;
}

function touchViewerSessionClientAccess(session, nowMs = Date.now()) {
    if (!session || session.backgroundCacheContinuation === true) return;
    session.lastClientAccessAtMs = Number(nowMs);
}

function viewerSessionIdleExpired(session, nowMs = Date.now()) {
    if (!session || session.backgroundCacheContinuation === true) return false;
    const createdAtMs = session.createdAt instanceof Date
        ? session.createdAt.getTime()
        : Date.parse(String(session.createdAt || ''));
    const lastClientAccessAtMs = Number(session.lastClientAccessAtMs || createdAtMs || 0);
    return Number.isFinite(lastClientAccessAtMs)
        && lastClientAccessAtMs > 0
        && Number(nowMs) - lastClientAccessAtMs >= VIEWER_SESSION_IDLE_TIMEOUT_MS;
}

function providerAffinityHashForGatewayKey(key) {
    return key ? sha256Hex(String(key)) : '';
}

async function stopProviderAffinities(affinityHashes) {
    const requested = new Set(affinityHashes);
    const matches = (key) => requested.has(providerAffinityHashForGatewayKey(key));
    const sessionsToStop = Array.from(sessions.values()).filter((session) => (
        matches(proxyKeyFromUrl(session?.sourceUrl || '')) && isSessionBlockingProviderSlot(session)
    ));
    await Promise.allSettled(sessionsToStop.map((session) => (
        stopSession(session, { reason: 'account-deletion' })
    )));
    const rawPumpsAborted = abortRawPumps((pump) => matches(pump?.proxyKey || ''), null, 'account deletion');
    let extractionsStopped = 0;
    const extractionStops = [];
    for (const [proxyKey, entries] of accountExtractions) {
        if (!matches(proxyKey)) continue;
        for (const entry of [...entries]) {
            if (entry?.preempted) continue;
            entry.preempted = true;
            extractionsStopped += 1;
            extractionStops.push(stopChildProcess(entry.child));
        }
    }
    await Promise.allSettled(extractionStops);
    const remaining = Array.from(sessions.values()).some((session) => (
        matches(proxyKeyFromUrl(session?.sourceUrl || '')) && isSessionBlockingProviderSlot(session)
    )) || Array.from(rawPumps).some((pump) => matches(pump?.proxyKey || ''))
      || Array.from(accountExtractions).some(([proxyKey, entries]) => (
        matches(proxyKey) && Array.from(entries).some((entry) => !entry?.preempted)
    ));
    return {
        stoppedSessions: sessionsToStop.length,
        abortedRawPumps: rawPumpsAborted,
        stoppedExtractions: extractionsStopped,
        providerDrained: !remaining,
    };
}

async function stopConflictingSourceSessions(sourceUrl, providerSlotKey) {
    const sourceKey = sourceSessionKey(sourceUrl);
    if (!sourceKey || !providerSlotKey) return 0;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.sourceKey !== sourceKey) return false;
        if (providerSlotKeyForSession(session) !== providerSlotKey) return false;
        return isSessionBlockingProviderSlot(session);
    });

    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same source: ${session.id}`);
        await stopSession(session, { reason: 'viewer-preempted' });
    }));
    return conflicts.length;
}

async function stopConflictingProviderSessions(providerSlotKey) {
    if (!providerSlotKey) return 0;
    const conflicts = Array.from(sessions.values()).filter((session) => (
        session?.sourceUrl &&
        providerSlotKeyForSession(session) === providerSlotKey &&
        isSessionBlockingProviderSlot(session)
    ));
    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same provider account: ${session.id}`);
        await stopSession(session, { reason: 'viewer-preempted' });
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
        await stopSession(session, { reason: 'viewer-preempted' });
    }));
    return conflicts.length;
}

function activeSessionCount() {
    return Array.from(sessions.values())
        .filter((session) => session.status === 'starting' || session.status === 'ready')
        .length;
}

function isSessionBlockingProviderSlot(session) {
    if (session?.assetSource === 'complete-hls-cache') return false;
    if (session?.backgroundCacheContinuation === true && !session?.stoppingPromise) {
        return session?.backgroundCacheContinuationProviderDrained !== true;
    }
    return session?.status === 'starting' ||
        session?.status === 'ready' ||
        session?.status === 'stopping' ||
        Boolean(session?.inputPump && session.inputPump.completed !== true);
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
    if (session.backgroundCacheContinuation === true) {
        return res.status(410).send('Session detached');
    }
    if (session.expiresAt.getTime() < Date.now()) {
        stopSession(session, { reason: 'session-expired' })
            .catch((err) => console.error('[media-gateway] cleanup failed:', err));
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

function publicMkvCodecProfile(profile) {
    const publicProfile = { ...asRecord(profile) };
    delete publicProfile.mkvH264FastStartProof;
    delete publicProfile.mkv_h264_fast_start_proof;
    delete publicProfile.mkvCompleteHlsCacheProof;
    delete publicProfile.mkv_complete_hls_cache_proof;
    return compactRecord(publicProfile);
}

function serializeSession(req, session) {
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: mappedAudioStreamIndexForSession(session),
        audioRenditions: audioRenditionsForSession(session),
        multiAudioHls: multiAudioHlsDiagnosticsForSession(session),
        requestedSeekOffset: session.seekOffset || 0,
        actualStartOffset: session.actualStartOffset || 0,
        localSeekTarget: session.localSeekTarget || 0,
        sourceTimestamps: session.sourceTimestamps === true,
        codecProfile: publicMkvCodecProfile(session.codecProfile),
        codecProfileSource: session.codecProfileSource || null,
        startupPolicy: session.startupPolicy || startupPolicyForSession(session),
        startupTimings: session.startupTimings || null,
        hlsUrl: publicUrl(req, `/sessions/${session.id}/playlist.m3u8?token=${encodeURIComponent(session.accessToken)}`),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: session.logTail
    };
}

function debugSession(session) {
    const mappedIndex = mappedAudioStreamIndexForSession(session);
    const exactTracks = audioTracksForSession(session);
    const selectedTrack = Number.isInteger(mappedIndex)
        ? exactTracks.find((track) => normalizeAudioStreamIndex(track?.index) === mappedIndex) || null
        : selectedAudioTrackForSession(session);
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: mappedAudioStreamIndexForSession(session),
        audioRenditions: audioRenditionsForSession(session),
        multiAudioHls: multiAudioHlsDiagnosticsForSession(session),
        requestedSeekOffset: session.seekOffset || 0,
        actualStartOffset: session.actualStartOffset || 0,
        localSeekTarget: session.localSeekTarget || 0,
        sourceTimestamps: session.sourceTimestamps === true,
        audioMap: session.actualAudioMap || audioMapForSession(session),
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
        startupPolicy: session.startupPolicy || startupPolicyForSession(session),
        startupTimings: session.startupTimings || null,
        inputProbeMode: session.fastInputProbe === true ? 'known-fast' : 'full',
        fastInputProbeFallbacks: Number(session.fastInputProbeFallbacks || 0),
        createdAt: session.createdAt.toISOString(),
        lastClientAccessAt: Number.isFinite(Number(session.lastClientAccessAtMs))
            ? new Date(Number(session.lastClientAccessAtMs)).toISOString()
            : null,
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

// `sid` is part of the HMAC-signed byte-pipe payload. Treat the fixed internal
// job identifiers as capabilities: a browser-visible playback /raw token has a
// per-session sid and therefore cannot be replayed against heavy worker routes
// or use their unsigned query parameters (origin, callback, jobId) to claim
// viewer priority and consume the replica's provider/CPU queues.
function bytePipeAllowsPurpose(claims, expectedPurpose) {
    return Boolean(claims && String(claims.sid || '') === String(expectedPurpose || ''));
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function configuredXtreamPrivateEgressAllowlist(value) {
    const entries = String(value || '').split(/[\s,]+/).map(normalizeXtreamEgressHostname).filter(Boolean);
    return new Set(entries.filter((entry) => {
        if (entry.length > 253 || entry.includes('/') || entry.includes('@')
            || (entry.includes(':') && net.isIP(entry) !== 6)) return false;
        return net.isIP(entry) > 0 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(entry);
    }));
}

function normalizeXtreamEgressHostname(value) {
    return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function ipv4Octets(address) {
    const parts = String(address || '').split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return null;
    const values = parts.map(Number);
    return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

function ipv6Words(address) {
    let value = normalizeXtreamEgressHostname(address).split('%')[0];
    if (!value || value.indexOf('::') !== value.lastIndexOf('::')) return null;
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const octets = ipv4Octets(value.slice(lastColon + 1));
        if (!octets) return null;
        value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const sides = value.split('::');
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
    if (sides.length === 1 && left.length !== 8) return null;
    const missing = 8 - left.length - right.length;
    if (missing < (sides.length === 2 ? 1 : 0)) return null;
    const words = [...left, ...Array(missing).fill('0'), ...right];
    if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
    return words.map((word) => Number.parseInt(word, 16));
}

function isPublicXtreamEgressAddress(address) {
    const normalizedAddress = normalizeXtreamEgressHostname(address);
    const family = net.isIP(normalizedAddress);
    if (family === 4) {
        const octets = ipv4Octets(normalizedAddress);
        if (!octets) return false;
        const [a, b, c] = octets;
        return !(
            a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && c === 0) ||
            (a === 192 && b === 0 && c === 2) ||
            (a === 192 && b === 88 && c === 99) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113) ||
            a >= 224
        );
    }
    if (family !== 6) return false;
    const words = ipv6Words(normalizedAddress);
    if (!words) return false;
    // IPv4-mapped IPv6 inherits the IPv4 decision.
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
        const mapped = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
        return isPublicXtreamEgressAddress(mapped);
    }
    // Admit only global unicast 2000::/3, excluding documentation and 6to4
    // transition addresses that can alias a non-public IPv4 destination.
    if ((words[0] & 0xe000) !== 0x2000) return false;
    if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
    if (words[0] === 0x2002) return false;
    return true;
}

async function resolveXtreamEgressTarget(value) {
    let endpoint;
    try {
        endpoint = new URL(String(value));
    } catch (_) {
        throw backgroundProbeError(400, 'invalid_egress_target', 'Provider endpoint is not allowed');
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw backgroundProbeError(400, 'invalid_egress_target', 'Provider endpoint is not allowed');
    }
    const hostname = normalizeXtreamEgressHostname(endpoint.hostname);
    const allowPrivate = XTREAM_PRIVATE_EGRESS_ALLOWLIST.has(hostname);
    let addresses;
    try {
        const literalFamily = net.isIP(hostname);
        addresses = literalFamily
            ? [{ address: hostname, family: literalFamily }]
            : await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (_) {
        throw backgroundProbeError(502, 'PROVIDER_DNS_FAILURE', 'Unable to resolve IPTV provider');
    }
    const normalized = Array.isArray(addresses)
        ? addresses.filter((entry) => entry && net.isIP(normalizeXtreamEgressHostname(entry.address)) > 0)
        : [];
    if (!hostname || normalized.length === 0
        || (!allowPrivate && normalized.some((entry) => !isPublicXtreamEgressAddress(entry.address)))) {
        throw backgroundProbeError(400, 'invalid_egress_target', 'Provider endpoint is not allowed');
    }
    const selected = normalized[0];
    const selectedAddress = normalizeXtreamEgressHostname(selected.address);
    const pinned = new URL(endpoint.href);
    pinned.hostname = Number(selected.family) === 6 ? `[${selectedAddress}]` : selectedAddress;
    return {
        pinnedUrl: pinned.href,
        hostname,
        authority: endpoint.host,
        protocol: endpoint.protocol,
        address: selectedAddress,
        family: Number(selected.family),
    };
}

async function assertXtreamEgressTarget(value) {
    await resolveXtreamEgressTarget(value);
}

async function openXtreamProviderResponse(url, options = {}) {
    const target = await resolveXtreamEgressTarget(url);
    const proxyIndex = providerProxyUrls.length ? poolIndexForKey(proxyKeyFromUrl(url)) : -1;
    const dispatcher = proxyIndex >= 0
        ? new ProxyAgent({
            uri: providerProxyUrls[proxyIndex],
            requestTls: target.protocol === 'https:' ? { servername: target.hostname } : undefined,
        })
        : new Agent({
            connect: target.protocol === 'https:' ? { servername: target.hostname } : undefined,
        });
    try {
        const response = await undiciRequest(target.pinnedUrl, {
            method: 'GET',
            signal: options.signal,
            dispatcher,
            maxRedirections: 0,
            headers: {
                ...(options.headers || {}),
                host: target.authority,
            },
        });
        return {
            status: response.statusCode,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            headers: response.headers,
            body: response.body,
            text: () => response.body.text(),
            close: () => dispatcher.close(),
        };
    } catch (error) {
        await dispatcher.close().catch(() => {});
        throw error;
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

function providerResponseTooLargeError() {
    return catalogSpoolError(
        502,
        'PROVIDER_RESPONSE_TOO_LARGE',
        'IPTV provider response exceeds its safety limit',
    );
}

async function readBoundedProviderText(response, maxBytes) {
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw catalogSpoolError(500, 'invalid_response_limit', 'Invalid provider response limit');
    }
    const declared = Number(
        response?.headers?.['content-length']
        ?? response?.headers?.['Content-Length']
        ?? 0,
    );
    if (Number.isFinite(declared) && declared > limit) {
        response?.body?.destroy?.();
        throw providerResponseTooLargeError();
    }
    if (!response?.body) {
        throw catalogSpoolError(502, 'invalid_payload', 'Invalid IPTV provider response');
    }
    const chunks = [];
    let total = 0;
    try {
        for await (const rawChunk of response.body) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            total += chunk.byteLength;
            if (total > limit) throw providerResponseTooLargeError();
            chunks.push(chunk);
        }
    } catch (error) {
        if (total > limit || error?.code === 'PROVIDER_RESPONSE_TOO_LARGE') {
            response.body.destroy?.();
        }
        throw error;
    }
    return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchProviderJson(url, userAgent, timeoutMs = XTREAM_REQUEST_TIMEOUT_MS, options = {}) {
    const controller = new AbortController();
    const backgroundKey = String(options.backgroundAccountKey || '');
    if (backgroundKey && viewerPlaybackActiveLocally()) {
        throw backgroundProbeError(409, 'account_busy', 'Account busy (active playback)');
    }
    if (backgroundKey && accountExtractions.get(backgroundKey)?.size) {
        throw backgroundProbeError(429, 'background_busy', 'Account busy (background request)');
    }
    // Register before the first await. A viewer that starts after the local
    // guard atomically aborts this metadata fetch and takes the provider slot.
    const registration = backgroundKey
        ? registerAccountExtraction(
            backgroundKey,
            { kill: () => controller.abort() },
            options.activityKind || true,
        )
        : null;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    try {
        response = await openXtreamProviderResponse(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json,text/plain,*/*',
                'User-Agent': userAgent
            }
        });
        const maxResponseBytes = Number(options.maxResponseBytes);
        const text = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0
            ? await readBoundedProviderText(response, maxResponseBytes)
            : await response.text();
        const payload = text ? safeJson(text) : {};
        if (!response.ok) {
            const failure = classifyProviderResponseFailure(response.status, payload, {
                proxyConfigured: providerProxyAgents.length > 0,
            });
            const error = new Error(failure.publicMessage);
            error.status = failure.status;
            error.publicMessage = failure.publicMessage;
            error.code = failure.code;
            throw error;
        }
        return payload;
    } catch (err) {
        if (registration?.preempted) {
            throw backgroundProbeError(
                409,
                'viewer_preempted',
                'Provider metadata request preempted by active playback',
            );
        }
        if (err.status) throw err;
        const networkFailure = classifyProviderFetchFailure(err);
        const error = new Error('Unable to reach IPTV provider');
        error.status = err.name === 'AbortError' ? 504 : 502;
        error.publicMessage = 'Unable to reach IPTV provider';
        error.code = networkFailure.code;
        error.details = { networkCause: networkFailure.category };
        throw error;
    } finally {
        clearTimeout(timer);
        await response?.close?.().catch(() => {});
        registration?.release?.();
    }
}

function normalizeXtreamCatalogCategoryParam(action, params) {
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const keys = Object.keys(values).filter((key) => values[key] !== undefined && values[key] !== null);
    if (keys.some((key) => key !== 'category_id')) {
        throw catalogSpoolError(400, 'invalid_catalog_params', 'Invalid catalogue page parameters');
    }
    const categoryId = values.category_id === undefined || values.category_id === null
        ? ''
        : String(values.category_id).normalize('NFC').trim();
    if (categoryId.length > 256 || /[\u0000-\u001f\u007f]/u.test(categoryId)) {
        throw catalogSpoolError(400, 'invalid_catalog_params', 'Invalid catalogue page parameters');
    }
    if (!XTREAM_CATALOG_STREAM_ACTIONS.has(action) && categoryId) {
        throw catalogSpoolError(400, 'invalid_catalog_params', 'Category listings do not accept a category filter');
    }
    return categoryId;
}

function catalogSpoolError(status, code, publicMessage) {
    const error = new Error(publicMessage);
    error.status = status;
    error.code = code;
    error.publicMessage = publicMessage;
    return error;
}

function xtreamCatalogRequestBinding(request) {
    const endpoint = new URL(String(request.serverUrl));
    endpoint.hash = '';
    endpoint.search = '';
    endpoint.username = '';
    endpoint.password = '';
    const canonical = JSON.stringify({
        endpoint: endpoint.href.replace(/\/+$/, ''),
        username: String(request.username),
        password: String(request.password),
        action: String(request.action),
        categoryId: String(request.categoryId || ''),
        maxItems: Number(request.maxItems),
        spoolKey: String(request.spoolKey),
    });
    return crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-binding-v1\0')
        .update(canonical)
        .digest('hex');
}

function xtreamCatalogSpoolId(binding, spoolKey) {
    return crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-spool-id-v1\0')
        .update(String(spoolKey))
        .update('\0')
        .update(binding)
        .digest('hex')
        .slice(0, 48);
}

function signXtreamCatalogCursor({
    spoolId, pageIndex, expiresAt, binding, buildId = null, contentDigest = null,
}) {
    const payload = Buffer.from(JSON.stringify({
        v: 2,
        s: spoolId,
        p: pageIndex,
        e: Math.floor(expiresAt / 1000),
        b: binding,
        g: buildId,
        d: contentDigest,
    }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-cursor-v1\0')
        .update(payload)
        .digest('base64url');
    return `${payload}.${signature}`;
}

function verifyXtreamCatalogCursor(cursor) {
    try {
        const [payload, signature, extra] = String(cursor || '').split('.');
        if (!payload || !signature || extra) return null;
        const expected = crypto.createHmac('sha256', GATEWAY_TOKEN)
            .update('xtream-catalog-cursor-v1\0')
            .update(payload)
            .digest('base64url');
        if (!timingSafeEqual(signature, expected)) return null;
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!claims || claims.v !== 2
            || !/^[a-f0-9]{48}$/.test(String(claims.s || ''))
            || !Number.isSafeInteger(claims.p) || claims.p < 0
            || !Number.isSafeInteger(claims.e) || claims.e * 1000 <= Date.now()
            || !/^[a-f0-9]{64}$/.test(String(claims.b || ''))
            || !(claims.g === null || /^[a-f0-9]{32}$/.test(String(claims.g || '')))
            || !(claims.d === null || /^[a-f0-9]{64}$/.test(String(claims.d || '')))
            || ((claims.g === null) !== (claims.d === null))
            || (claims.p > 0 && (!claims.g || !claims.d))) return null;
        return {
            spoolId: claims.s,
            pageIndex: claims.p,
            expiresAt: claims.e * 1000,
            binding: claims.b,
            buildId: claims.g,
            contentDigest: claims.d,
        };
    } catch (_) {
        return null;
    }
}

function xtreamCatalogSpoolPath(spoolId, suffix = '') {
    const target = path.resolve(XTREAM_CATALOG_SPOOL_DIR, `${spoolId}${suffix}`);
    if (!isWithin(XTREAM_CATALOG_SPOOL_DIR, target) || target === XTREAM_CATALOG_SPOOL_DIR) {
        throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
    }
    return target;
}

function xtreamCatalogPagePath(spoolDir, pageIndex) {
    const target = path.resolve(spoolDir, `page-${String(pageIndex).padStart(8, '0')}.bin`);
    if (!isWithin(spoolDir, target) || target === spoolDir) {
        throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
    }
    return target;
}

function signXtreamCatalogFailure(metadata) {
    const canonical = JSON.stringify({
        v: metadata.v,
        spoolId: metadata.spoolId,
        binding: metadata.binding,
        attempt: metadata.attempt,
        retryAt: metadata.retryAt,
        code: metadata.code,
    });
    return crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-failure-v1\0')
        .update(canonical)
        .digest('base64url');
}

async function readXtreamCatalogBuildFailure(spoolId, binding) {
    const failurePath = xtreamCatalogSpoolPath(spoolId, '.failure.json');
    try {
        const stat = await fsp.stat(failurePath);
        if (!stat.isFile() || stat.size > 4096) return null;
        const value = JSON.parse(await fsp.readFile(failurePath, 'utf8'));
        if (!value || value.v !== 1 || value.spoolId !== spoolId || value.binding !== binding
            || value.code !== 'catalog_spool_build_failed'
            || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 1000
            || !Number.isSafeInteger(value.retryAt)
            || typeof value.signature !== 'string'
            || !timingSafeEqual(value.signature, signXtreamCatalogFailure(value))) return null;
        return value;
    } catch (_) {
        return null;
    }
}

async function persistXtreamCatalogBuildFailure(spoolId, binding) {
    const previous = await readXtreamCatalogBuildFailure(spoolId, binding);
    const failure = {
        v: 1,
        spoolId,
        binding,
        attempt: Math.min(1000, Number(previous?.attempt || 0) + 1),
        retryAt: Date.now() + Math.min(
            15 * 60 * 1000,
            XTREAM_CATALOG_FAILURE_RETRY_MS * (2 ** Math.min(5, Number(previous?.attempt || 0))),
        ),
        code: 'catalog_spool_build_failed',
    };
    failure.signature = signXtreamCatalogFailure(failure);
    const failurePath = xtreamCatalogSpoolPath(spoolId, '.failure.json');
    const temporary = xtreamCatalogSpoolPath(spoolId, `.${crypto.randomUUID()}.failure.partial`);
    await fsp.writeFile(temporary, JSON.stringify(failure), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.unlink(failurePath).catch(() => {});
    await fsp.rename(temporary, failurePath);
}

async function clearXtreamCatalogBuildFailure(spoolId) {
    await fsp.unlink(xtreamCatalogSpoolPath(spoolId, '.failure.json')).catch(() => {});
}

function xtreamCatalogPendingError(spoolId, binding) {
    const pending = catalogSpoolError(202, 'catalog_spool_building', 'Catalogue page is being prepared');
    pending.retryAfterSeconds = 2;
    pending.cursor = signXtreamCatalogCursor({
        spoolId,
        pageIndex: 0,
        expiresAt: Date.now() + XTREAM_CATALOG_SPOOL_TTL_MS,
        binding,
        buildId: null,
        contentDigest: null,
    });
    pending.spoolToken = pending.cursor;
    return pending;
}

function assertXtreamCatalogCursorMatchesManifest(claims, metadata) {
    if (!claims) return;
    // A page-zero pending token is issued before a build identity exists and is
    // safe against any completed build because no earlier page was consumed.
    if (!claims.buildId && !claims.contentDigest && claims.pageIndex === 0) return;
    // A rebuilt spool may resume an old page cursor only when the exact provider
    // response bytes match. This prevents a generation from combining prefix A
    // with suffix B after a corrupt/missing page triggers reconstruction.
    if (claims.contentDigest !== metadata.contentDigest) {
        throw catalogSpoolError(409, 'catalog_cursor_stale', 'Catalogue changed while paging');
    }
}

function assertXtreamCatalogCursorPair(cursorClaims, spoolClaims) {
    if (!cursorClaims || !spoolClaims) return;
    if (spoolClaims.pageIndex !== 0
        || cursorClaims.spoolId !== spoolClaims.spoolId
        || cursorClaims.binding !== spoolClaims.binding
        || cursorClaims.buildId !== spoolClaims.buildId
        || cursorClaims.contentDigest !== spoolClaims.contentDigest) {
        throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
    }
}

async function readXtreamCatalogPage({ request, cursor, spoolToken, userAgent }) {
    const binding = xtreamCatalogRequestBinding(request);
    const spoolId = xtreamCatalogSpoolId(binding, request.spoolKey);
    let pageIndex = 0;
    let cursorClaims = null;
    if (cursor) {
        cursorClaims = verifyXtreamCatalogCursor(cursor);
        if (!cursorClaims || cursorClaims.spoolId !== spoolId || cursorClaims.binding !== binding) {
            throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
        }
        pageIndex = cursorClaims.pageIndex;
    }
    const spoolClaims = spoolToken ? verifyXtreamCatalogCursor(spoolToken) : null;
    if (spoolToken && (!spoolClaims || spoolClaims.spoolId !== spoolId || spoolClaims.binding !== binding)) {
        throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
    }
    assertXtreamCatalogCursorPair(cursorClaims, spoolClaims);

    await fsp.mkdir(XTREAM_CATALOG_SPOOL_DIR, { recursive: true });
    scheduleXtreamCatalogSpoolPrune();
    const spoolDir = xtreamCatalogSpoolPath(spoolId);
    let metadata = await readXtreamCatalogSpoolMetadata(spoolDir);
    if (!metadata) {
        const failure = await readXtreamCatalogBuildFailure(spoolId, binding);
        if (failure && failure.retryAt > Date.now()) {
            const failed = catalogSpoolError(503, failure.code, 'Catalogue page preparation failed');
            failed.retryAfterSeconds = Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000));
            throw failed;
        }
        if (failure) await clearXtreamCatalogBuildFailure(spoolId);
        // Construction is intentionally detached from this request. A large
        // provider array can take minutes; Edge receives an authenticated poll
        // cursor and checkpoints the durable DB job instead of holding memory
        // or an invocation open until the spool is complete.
        void createXtreamCatalogSpool({
            request,
            binding,
            spoolId,
            userAgent,
        }).catch(() => {});
        throw xtreamCatalogPendingError(spoolId, binding);
    }
    assertXtreamCatalogSpoolMetadata(metadata, { binding, spoolId, maxItems: request.maxItems });
    assertXtreamCatalogCursorMatchesManifest(cursorClaims, metadata);
    assertXtreamCatalogCursorMatchesManifest(spoolClaims, metadata);
    if (metadata.expiresAt <= Date.now()) {
        void removeXtreamCatalogSpool(spoolDir);
        throw catalogSpoolError(410, 'catalog_cursor_expired', 'Catalogue cursor expired');
    }
    if (pageIndex >= metadata.pageCount) {
        throw catalogSpoolError(400, 'invalid_catalog_cursor', 'Invalid catalogue cursor');
    }

    const pagePath = xtreamCatalogPagePath(spoolDir, pageIndex);
    const stat = await fsp.stat(pagePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > XTREAM_CATALOG_PAGE_MAX_BYTES + 64) {
        return restartCorruptXtreamCatalogSpool({ request, binding, spoolId, userAgent });
    }
    let items;
    try {
        const encrypted = await fsp.readFile(pagePath);
        const plaintext = decryptXtreamCatalogPage(encrypted, {
            spoolId,
            binding,
            buildId: metadata.buildId,
            pageIndex,
        });
        items = JSON.parse(plaintext.toString('utf8'));
    } catch (_) {
        return restartCorruptXtreamCatalogSpool({ request, binding, spoolId, userAgent });
    }
    if (!Array.isArray(items) || items.length > request.maxItems
        || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        return restartCorruptXtreamCatalogSpool({ request, binding, spoolId, userAgent });
    }
    const done = pageIndex + 1 >= metadata.pageCount;
    return {
        items,
        nextCursor: done ? null : signXtreamCatalogCursor({
            spoolId,
            pageIndex: pageIndex + 1,
            expiresAt: metadata.expiresAt,
            binding,
            buildId: metadata.buildId,
            contentDigest: metadata.contentDigest,
        }),
        done,
        spoolToken: signXtreamCatalogCursor({
            spoolId,
            pageIndex: 0,
            expiresAt: metadata.expiresAt,
            binding,
            buildId: metadata.buildId,
            contentDigest: metadata.contentDigest,
        }),
    };
}

function signXtreamCatalogSpoolMetadata(metadata) {
    const canonical = JSON.stringify({
        v: metadata.v,
        spoolId: metadata.spoolId,
        binding: metadata.binding,
        buildId: metadata.buildId,
        contentDigest: metadata.contentDigest,
        maxItems: metadata.maxItems,
        pageCount: metadata.pageCount,
        itemCount: metadata.itemCount,
        expiresAt: metadata.expiresAt,
    });
    return crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-manifest-v2\0')
        .update(canonical)
        .digest('base64url');
}

function assertXtreamCatalogSpoolMetadata(metadata, expected) {
    if (!metadata || metadata.v !== 2
        || metadata.spoolId !== expected.spoolId
        || metadata.binding !== expected.binding
        || !/^[a-f0-9]{32}$/.test(String(metadata.buildId || ''))
        || !/^[a-f0-9]{64}$/.test(String(metadata.contentDigest || ''))
        || metadata.maxItems !== expected.maxItems
        || !Number.isSafeInteger(metadata.pageCount) || metadata.pageCount < 1
        || !Number.isSafeInteger(metadata.itemCount) || metadata.itemCount < 0
        || metadata.itemCount > XTREAM_CATALOG_SPOOL_MAX_ITEMS
        || !Number.isSafeInteger(metadata.expiresAt)
        || typeof metadata.signature !== 'string'
        || !timingSafeEqual(metadata.signature, signXtreamCatalogSpoolMetadata(metadata))) {
        throw catalogSpoolError(502, 'catalog_spool_invalid', 'Catalogue page is unavailable');
    }
}

async function readXtreamCatalogSpoolMetadata(spoolDir) {
    try {
        const stat = await fsp.stat(path.join(spoolDir, 'manifest.json'));
        if (!stat.isFile() || stat.size > 16 * 1024) return null;
        const metadata = JSON.parse(await fsp.readFile(path.join(spoolDir, 'manifest.json'), 'utf8'));
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
            || typeof metadata.signature !== 'string'
            || !timingSafeEqual(metadata.signature, signXtreamCatalogSpoolMetadata(metadata))) return null;
        return metadata;
    } catch (_) {
        return null;
    }
}

async function createXtreamCatalogSpool({ request, binding, spoolId, userAgent }) {
    const spoolDir = xtreamCatalogSpoolPath(spoolId);
    const lockPath = xtreamCatalogSpoolPath(spoolId, '.lock');
    let lock = null;
    try {
        lock = await fsp.open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw catalogSpoolError(409, 'catalog_spool_busy', 'Catalogue page is being prepared');
        }
        throw catalogSpoolError(503, 'catalog_spool_unavailable', 'Catalogue page is unavailable');
    }

    const partialDir = xtreamCatalogSpoolPath(spoolId, `.${crypto.randomUUID()}.partial`);
    try {
        // Another request may have completed between the initial lookup and
        // acquiring the deterministic lock.
        const existing = await readXtreamCatalogSpoolMetadata(spoolDir);
        if (existing) return existing;
        // A crash may leave a final-looking directory without a valid signed
        // manifest. Under the deterministic build lock it is safe to remove;
        // otherwise rename(partial, existing) would poll forever.
        await removeXtreamCatalogSpool(spoolDir);
        await fsp.mkdir(partialDir, { recursive: false });
        const buildId = crypto.randomBytes(16).toString('hex');
        const url = xtreamPlayerApiUrl({
            serverUrl: request.serverUrl,
            username: request.username,
            password: request.password,
            action: request.action,
            params: request.categoryId ? { category_id: request.categoryId } : undefined,
        });
        const result = await fetchProviderArrayToXtreamCatalogSpool({
            url,
            userAgent,
            backgroundAccountKey: providerAccountKeyFromCredentials(request.serverUrl, request.username),
            spoolDir: partialDir,
            maxItems: request.maxItems,
            spoolId,
            binding,
            buildId,
        });
        const metadata = {
            v: 2,
            spoolId,
            binding,
            buildId,
            contentDigest: result.contentDigest,
            maxItems: request.maxItems,
            pageCount: result.pageCount,
            itemCount: result.itemCount,
            expiresAt: Date.now() + XTREAM_CATALOG_SPOOL_TTL_MS,
        };
        metadata.signature = signXtreamCatalogSpoolMetadata(metadata);
        await fsp.writeFile(path.join(partialDir, 'manifest.json'), JSON.stringify(metadata), {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        await fsp.rename(partialDir, spoolDir);
        await clearXtreamCatalogBuildFailure(spoolId);
        return metadata;
    } catch (error) {
        await removeXtreamCatalogSpool(partialDir);
        await persistXtreamCatalogBuildFailure(spoolId, binding).catch(() => {});
        throw error;
    } finally {
        await lock?.close().catch(() => {});
        await fsp.unlink(lockPath).catch(() => {});
    }
}

async function invalidateXtreamCatalogSpool(spoolId, binding) {
    const spoolDir = xtreamCatalogSpoolPath(spoolId);
    const lockPath = xtreamCatalogSpoolPath(spoolId, '.lock');
    let lock;
    try {
        lock = await fsp.open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw catalogSpoolError(503, 'catalog_spool_unavailable', 'Catalogue page is unavailable');
    }
    try {
        const metadata = await readXtreamCatalogSpoolMetadata(spoolDir);
        if (!metadata || (metadata.spoolId === spoolId && metadata.binding === binding)) {
            await removeXtreamCatalogSpool(spoolDir);
        }
        await clearXtreamCatalogBuildFailure(spoolId);
        return true;
    } finally {
        await lock.close().catch(() => {});
        await fsp.unlink(lockPath).catch(() => {});
    }
}

async function restartCorruptXtreamCatalogSpool({ request, binding, spoolId, userAgent }) {
    await invalidateXtreamCatalogSpool(spoolId, binding);
    void createXtreamCatalogSpool({ request, binding, spoolId, userAgent }).catch(() => {});
    throw xtreamCatalogPendingError(spoolId, binding);
}

async function fetchProviderArrayToXtreamCatalogSpool({
    url, userAgent, backgroundAccountKey, spoolDir, maxItems, spoolId, binding, buildId,
}) {
    const controller = new AbortController();
    const backgroundKey = String(backgroundAccountKey || '');
    if (backgroundKey && viewerPlaybackActiveLocally()) {
        throw backgroundProbeError(409, 'account_busy', 'Account busy (active playback)');
    }
    if (backgroundKey && accountExtractions.get(backgroundKey)?.size) {
        throw backgroundProbeError(429, 'background_busy', 'Account busy (background request)');
    }
    const registration = backgroundKey
        ? registerAccountExtraction(
            backgroundKey,
            { kill: () => controller.abort() },
            ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH,
        )
        : null;
    const timer = setTimeout(() => controller.abort(), XTREAM_CATALOG_BUILD_TIMEOUT_MS);
    let response = null;
    try {
        response = await openXtreamProviderResponse(url, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json,text/plain,*/*',
                'User-Agent': userAgent,
            },
        });
        if (!response.ok) {
            const text = await readBoundedProviderErrorBody(response.body, 64 * 1024);
            const payload = text ? safeJson(text) : {};
            const failure = classifyProviderResponseFailure(response.status, payload, {
                proxyConfigured: providerProxyAgents.length > 0,
            });
            throw catalogSpoolError(failure.status, failure.code, failure.publicMessage);
        }
        if (!response.body) {
            throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
        }
        return await spoolTopLevelJsonObjectArray(
            response.body,
            spoolDir,
            maxItems,
            { spoolId, binding, buildId },
        );
    } catch (err) {
        if (registration?.preempted) {
            throw backgroundProbeError(409, 'viewer_preempted', 'Provider metadata request preempted by active playback');
        }
        if (err.status) throw err;
        const networkFailure = classifyProviderFetchFailure(err);
        throw catalogSpoolError(
            err?.name === 'AbortError' ? 504 : 502,
            networkFailure.code,
            'Unable to reach IPTV provider',
        );
    } finally {
        clearTimeout(timer);
        await response?.close?.().catch(() => {});
        registration?.release?.();
    }
}

async function readBoundedProviderErrorBody(body, maxBytes) {
    if (!body) return '';
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for await (const chunk of body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) break;
        text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
}

function xtreamCatalogPageEncryptionKey(spoolId) {
    return crypto.createHmac('sha256', GATEWAY_TOKEN)
        .update('xtream-catalog-page-key-v2\0')
        .update(String(spoolId))
        .digest();
}

function xtreamCatalogPageAad({ spoolId, binding, buildId, pageIndex }) {
    return Buffer.from(`xtream-catalog-page-v2\0${spoolId}\0${binding}\0${buildId}\0${pageIndex}`, 'utf8');
}

function encryptXtreamCatalogPage(plaintext, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', xtreamCatalogPageEncryptionKey(context.spoolId), iv);
    cipher.setAAD(xtreamCatalogPageAad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from('NCSP2', 'ascii'), iv, tag, ciphertext]);
}

function decryptXtreamCatalogPage(encrypted, context) {
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 34
        || encrypted.subarray(0, 5).toString('ascii') !== 'NCSP2') {
        throw catalogSpoolError(502, 'catalog_spool_invalid', 'Catalogue page is unavailable');
    }
    try {
        const iv = encrypted.subarray(5, 17);
        const tag = encrypted.subarray(17, 33);
        const ciphertext = encrypted.subarray(33);
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            xtreamCatalogPageEncryptionKey(context.spoolId),
            iv,
        );
        decipher.setAAD(xtreamCatalogPageAad(context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (_) {
        throw catalogSpoolError(502, 'catalog_spool_invalid', 'Catalogue page is unavailable');
    }
}

async function spoolTopLevelJsonObjectArray(body, spoolDir, maxItems, encryptionContext) {
    const decoder = new TextDecoder();
    const contentHash = crypto.createHash('sha256');
    let mode = 'before-array';
    let current = '';
    let currentBytes = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let allowArrayEnd = true;
    let responseBytes = 0;
    let itemCount = 0;
    let pageIndex = 0;
    let pageItems = [];
    let pageBytes = 2;

    const flushPage = async () => {
        const payload = JSON.stringify(pageItems);
        if (Buffer.byteLength(payload, 'utf8') > XTREAM_CATALOG_PAGE_MAX_BYTES) {
            throw catalogSpoolError(502, 'catalog_page_too_large', 'Catalogue page exceeds its safety limit');
        }
        const encrypted = encryptXtreamCatalogPage(Buffer.from(payload, 'utf8'), {
            ...encryptionContext,
            pageIndex,
        });
        await fsp.writeFile(xtreamCatalogPagePath(spoolDir, pageIndex), encrypted, {
            mode: 0o600,
            flag: 'wx',
        });
        pageIndex += 1;
        pageItems = [];
        pageBytes = 2;
    };

    const acceptItem = async () => {
        let item;
        try {
            item = JSON.parse(current);
        } catch (_) {
            throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
        }
        const serialized = JSON.stringify(item);
        const serializedBytes = Buffer.byteLength(serialized, 'utf8');
        if (serializedBytes > XTREAM_CATALOG_ITEM_MAX_BYTES) {
            throw catalogSpoolError(502, 'catalog_item_too_large', 'Catalogue item exceeds its safety limit');
        }
        if (pageItems.length > 0
            && (pageItems.length >= maxItems
                || pageBytes + serializedBytes + 1 > XTREAM_CATALOG_PAGE_MAX_BYTES)) {
            await flushPage();
        }
        pageItems.push(item);
        pageBytes += serializedBytes + (pageItems.length > 1 ? 1 : 0);
        itemCount += 1;
        if (itemCount > XTREAM_CATALOG_SPOOL_MAX_ITEMS) {
            throw catalogSpoolError(502, 'catalog_too_many_items', 'Catalogue exceeds its safety limit');
        }
        current = '';
        currentBytes = 0;
    };

    const consume = async (text) => {
        for (const char of text) {
            if (mode === 'before-array') {
                if (/\s/u.test(char) || char === '\uFEFF') continue;
                if (char !== '[') throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
                mode = 'before-value';
                continue;
            }
            if (mode === 'before-value') {
                if (/\s/u.test(char)) continue;
                if (char === ']') {
                    if (!allowArrayEnd) {
                        throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
                    }
                    mode = 'done';
                    continue;
                }
                if (char !== '{') throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
                mode = 'in-value';
                current = char;
                currentBytes = 1;
                depth = 1;
                inString = false;
                escaped = false;
                continue;
            }
            if (mode === 'after-value') {
                if (/\s/u.test(char)) continue;
                if (char === ',') {
                    mode = 'before-value';
                    allowArrayEnd = false;
                    continue;
                }
                if (char === ']') {
                    mode = 'done';
                    continue;
                }
                throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
            }
            if (mode === 'done') {
                if (!/\s/u.test(char)) throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
                continue;
            }

            current += char;
            currentBytes += Buffer.byteLength(char, 'utf8');
            if (currentBytes > XTREAM_CATALOG_ITEM_MAX_BYTES) {
                throw catalogSpoolError(502, 'catalog_item_too_large', 'Catalogue item exceeds its safety limit');
            }
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
            } else if (char === '{' || char === '[') {
                depth += 1;
            } else if (char === '}' || char === ']') {
                depth -= 1;
                if (depth < 0) throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
                if (depth === 0) {
                    await acceptItem();
                    mode = 'after-value';
                }
            }
        }
    };

    for await (const chunk of body) {
        contentHash.update(chunk);
        responseBytes += chunk.byteLength;
        if (responseBytes > XTREAM_CATALOG_SPOOL_MAX_BYTES) {
            throw catalogSpoolError(502, 'catalog_too_large', 'Catalogue exceeds its safety limit');
        }
        await consume(decoder.decode(chunk, { stream: true }));
    }
    await consume(decoder.decode());
    if (mode !== 'done') throw catalogSpoolError(502, 'invalid_payload', 'Invalid catalogue response');
    if (pageItems.length > 0 || pageIndex === 0) await flushPage();
    return { pageCount: pageIndex, itemCount, contentDigest: contentHash.digest('hex') };
}

async function removeXtreamCatalogSpool(spoolDir) {
    const resolved = path.resolve(spoolDir);
    if (!isWithin(XTREAM_CATALOG_SPOOL_DIR, resolved) || resolved === XTREAM_CATALOG_SPOOL_DIR) return;
    await fsp.rm(resolved, { recursive: true, force: true });
}

let xtreamCatalogSpoolPruneDueAt = 0;
function scheduleXtreamCatalogSpoolPrune() {
    const now = Date.now();
    if (xtreamCatalogSpoolPruneDueAt > now) return;
    xtreamCatalogSpoolPruneDueAt = now + 60 * 1000;
    setImmediate(async () => {
        try {
            const entries = await fsp.readdir(XTREAM_CATALOG_SPOOL_DIR, { withFileTypes: true });
            let inspected = 0;
            for (const entry of entries) {
                if (inspected >= 100) break;
                inspected += 1;
                const target = path.resolve(XTREAM_CATALOG_SPOOL_DIR, entry.name);
                if (!isWithin(XTREAM_CATALOG_SPOOL_DIR, target) || target === XTREAM_CATALOG_SPOOL_DIR) continue;
                const stat = await fsp.stat(target).catch(() => null);
                const staleAfterMs = entry.name.endsWith('.lock') || entry.name.endsWith('.partial')
                    ? XTREAM_CATALOG_BUILD_TIMEOUT_MS + 60 * 1000
                    : XTREAM_CATALOG_SPOOL_TTL_MS;
                if (!stat || stat.mtimeMs + staleAfterMs > now) continue;
                if (entry.isDirectory()) await removeXtreamCatalogSpool(target);
                else if (entry.isFile() && (
                    entry.name.endsWith('.lock')
                    || entry.name.endsWith('.partial')
                    || entry.name.endsWith('.failure.json')
                )) await fsp.unlink(target).catch(() => {});
            }
        } catch (_) {
            // Pruning is best effort. Read-time expiry remains authoritative.
        }
    });
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return { raw: String(text || '').slice(0, 2000) };
    }
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

function safeSessionArtifactName(value) {
    const raw = String(value || '');
    if (
        !raw ||
        raw !== path.basename(raw) ||
        raw.includes('/') ||
        raw.includes('\\') ||
        raw.includes('\0') ||
        raw.length > 128
    ) return null;
    return /^[a-z0-9][a-z0-9._-]*$/i.test(raw) ? raw : null;
}

function isAllowedSessionPlaylistName(session, value) {
    const requested = safeSessionArtifactName(value);
    if (!requested || !requested.toLowerCase().endsWith('.m3u8')) return false;
    const allowed = new Set(['playlist.m3u8']);
    if (multiAudioHlsEnabled(session)) {
        allowed.add(session.multiAudioHls.videoPlaylistName);
        for (const rendition of session.multiAudioHls.audioRenditions) {
            allowed.add(`audio_${rendition.hlsIndex}.m3u8`);
        }
    }
    return allowed.has(requested);
}

function segmentContentType(file) {
    if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl; charset=utf-8';
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

function controlledAudioRenditionName(plan, rendition) {
    const language = normalizeHlsAudioLanguage(rendition?.language).toUpperCase();
    if (language === 'UND') return `Audio ${Number(rendition?.hlsIndex) + 1}`;
    const priorWithLanguage = plan.audioRenditions
        .slice(0, rendition.hlsIndex)
        .filter((candidate) => normalizeHlsAudioLanguage(candidate.language).toUpperCase() === language)
        .length;
    return priorWithLanguage > 0 ? `${language} ${priorWithLanguage + 1}` : language;
}

function rewriteMultiAudioMasterNames(playlist, session) {
    if (!multiAudioHlsEnabled(session)) return String(playlist || '');
    const plan = session.multiAudioHls;
    return String(playlist || '')
        .split(/\r?\n/)
        .map((line) => {
            if (!line.trim().startsWith('#EXT-X-MEDIA:')) return line;
            const attributes = parseHlsAttributeList(line);
            if (String(attributes.TYPE || '').toUpperCase() !== 'AUDIO') return line;
            const uri = controlledLocalPlaylistName(attributes.URI);
            const match = /^audio_(\d+)\.m3u8$/i.exec(String(uri || ''));
            if (!match) return line;
            const hlsIndex = Number(match[1]);
            const rendition = plan.audioRenditions[hlsIndex];
            if (!rendition || rendition.hlsIndex !== hlsIndex) return line;
            const generatedName = controlledAudioRenditionName(plan, rendition);
            return line.replace(/NAME="audio_\d+"/i, `NAME="${generatedName}"`);
        })
        .join('\n');
}

function rewritePlaylistSegments(playlist, token, session = null) {
    const encodedToken = encodeURIComponent(token);
    return rewriteMultiAudioMasterNames(playlist, session)
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
                // Master audio renditions and media init maps both carry URIs
                // inside tag attributes. Tokenize every URI attribute so new
                // HLS tags cannot accidentally create an unauthenticated edge.
                return line.replace(/URI="([^"]+)"/gi, (_match, uri) => (
                    `URI="${appendToken(uri, encodedToken)}"`
                ));
            }
            if (/^https?:\/\//i.test(trimmed)) return appendToken(trimmed, encodedToken);
            return appendToken(trimmed, encodedToken);
        })
        .join('\n');
}

function appendToken(uri, encodedToken) {
    const raw = String(uri || '');
    const localName = raw.split(/[?#]/, 1)[0];
    // FFmpeg's HLS graph consists exclusively of controlled flat names. Refuse
    // every absolute, scheme-relative or traversing URI before considering an
    // existing query token, so a malformed playlist cannot exfiltrate the
    // session bearer to another origin.
    if (
        !localName || localName !== path.basename(localName) ||
        localName.includes('/') || localName.includes('\\') ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(localName)
    ) return raw;
    if (/[?&]token=/.test(raw)) return raw;
    const fragmentIndex = raw.indexOf('#');
    const base = fragmentIndex >= 0 ? raw.slice(0, fragmentIndex) : raw;
    const fragment = fragmentIndex >= 0 ? raw.slice(fragmentIndex) : '';
    return `${base}${base.includes('?') ? '&' : '?'}token=${encodedToken}${fragment}`;
}

function sanitizeLog(text, sourceUrl) {
    let safe = redactStrictLidLoopback(text);
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
// The account activity key is already the canonical host + '/' + logical username used by
// proxy affinity, provider locks and the Edge. Never decode it again here: a literal `%2B`,
// `%20` or `%2F` in a provider username must stay literal across every producer.
function activeProviderAccountActivityGroups() {
    const candidates = [];
    for (const s of sessions.values()) {
        if (s && s.sourceUrl && isSessionBlockingProviderSlot(s)) {
            candidates.push({
                key: proxyKeyFromUrl(s.sourceUrl),
                kind: ACCOUNT_ACTIVITY_KIND_GATEWAY,
            });
        }
    }
    for (const p of rawPumps) {
        if (p && p.proxyKey) {
            candidates.push({ key: p.proxyKey, kind: ACCOUNT_ACTIVITY_KIND_GATEWAY });
        }
    }
    for (const [key, entries] of accountExtractions) {
        for (const entry of entries) {
            if (entry.preempted || entry.reportActivity === false) continue;
            candidates.push({
                key,
                kind: entry.activityKind === ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
                    ? ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION
                    : (entry.activityKind === ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                        ? ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH
                        : ACCOUNT_ACTIVITY_KIND_GATEWAY),
            });
        }
    }
    return groupProviderAccountActivities(candidates, 64);
}
let _accountActivityLastErrorAt = 0;
async function reportAccountActivityKind(keys, kind) {
    if (!keys.length) return;
    try {
        const res = await fetch(`${edgeCallbackBase}/account-activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: JSON.stringify({ keys, kind }),
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
async function reportAccountActivity() {
    if (!ACCOUNT_ACTIVITY_REPORT_MS || !GATEWAY_TOKEN || !edgeCallbackBase) return;
    const groups = activeProviderAccountActivityGroups();
    await Promise.all([
        reportAccountActivityKind(groups.gateway, ACCOUNT_ACTIVITY_KIND_GATEWAY),
        reportAccountActivityKind(
            groups.languageValidation,
            ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION,
        ),
        reportAccountActivityKind(
            groups.catalogRefresh,
            ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH,
        ),
    ]);
}
if (ACCOUNT_ACTIVITY_REPORT_MS > 0) {
    if (edgeCallbackBase) {
        console.log(`[media-gateway] account-activity reporter ON (every ${ACCOUNT_ACTIVITY_REPORT_MS}ms → ${edgeCallbackBase}/account-activity)`);
    } else {
        console.warn('[media-gateway] account-activity reporter IDLE — set NORVA_EDGE_CALLBACK_BASE to enable (busy-lock falls back to edge-side session/event/history writers)');
    }
    setInterval(() => { reportAccountActivity(); }, ACCOUNT_ACTIVITY_REPORT_MS).unref();
}

if (mkvCompleteHlsCache) {
    const pruneCompleteHlsCache = async () => {
        try {
            const result = await mkvCompleteHlsCache.prune();
            mkvCompleteHlsCacheStats.prunedEntries += Number(result?.removedEntries || 0);
            mkvCompleteHlsCacheStats.prunedBytes += Number(result?.removedBytes || 0);
        } catch (error) {
            console.warn(`[media-gateway] complete HLS cache prune skipped (${String(error?.code || 'prune-failed').slice(0, 80)})`);
        }
    };
    setImmediate(pruneCompleteHlsCache);
    setInterval(pruneCompleteHlsCache, MKV_COMPLETE_HLS_CACHE_PRUNE_INTERVAL_MS).unref();
}

setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
        if (session.expiresAt.getTime() < now) {
            stopSession(session, { reason: 'session-expired' })
                .catch((err) => console.error('[media-gateway] cleanup failed:', err));
        } else if (viewerSessionIdleExpired(session, now)) {
            stopSession(session, { reason: 'viewer-idle' })
                .catch((err) => console.error('[media-gateway] idle cleanup failed:', err));
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
