'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { PROTOCOL } = require('./fixture-registry');

const MAX_GATEWAY_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_SESSION_TIMEOUT_MS = 180_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 12_000;
function strictOrigin(value, code) {
    let url;
    try { url = new URL(String(value || '')); } catch (_) { url = null; }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== '/') throw new Error(code);
    return url.toString().replace(/\/+$/, '');
}

function boundedToken(value) {
    const token = String(value || '');
    if (token.length < 32 || token.length > 8_192 || /\s/.test(token)) {
        throw new Error('MEDIA_LAB_GATEWAY_TOKEN_INVALID');
    }
    return token;
}

function boundedTimeout(value, fallback, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1_000 && number <= maximum ? number : fallback;
}

function abortError() {
    return Object.assign(new Error('MEDIA_LAB_PHYSICAL_ABORTED'), { code: 'ABORT_ERR' });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

async function boundedJson(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_GATEWAY_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error('MEDIA_LAB_GATEWAY_RESPONSE_TOO_LARGE');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_GATEWAY_RESPONSE_BYTES) throw new Error('MEDIA_LAB_GATEWAY_RESPONSE_TOO_LARGE');
    if (bytes.length === 0) return null;
    try { return JSON.parse(bytes.toString('utf8')); } catch (_) {
        throw new Error('MEDIA_LAB_GATEWAY_RESPONSE_INVALID');
    }
}

function emptyMetrics(overrides = {}) {
    return {
        ttffMs: 0,
        manifestReadyMs: 0,
        firstSegmentMs: 0,
        bufferedAheadSeconds: 0,
        productionRateX: 0,
        browserBufferRateX: 0,
        rebufferCount: 0,
        rebufferMs: 0,
        ffmpegSpawns: 0,
        analyzerSpawns: 0,
        seekPassed: false,
        audioPassed: false,
        ...overrides,
    };
}

function evidence({ status, pipeline, reason, gatewayObserved, browserObserved, cleanupObserved, metrics }) {
    return Object.freeze({
        protocol: PROTOCOL,
        kind: 'norva-media-lab-physical-v1',
        status,
        pipeline,
        reason,
        gatewayObserved: gatewayObserved === true,
        browserObserved: browserObserved === true,
        cleanupObserved: cleanupObserved === true,
        metrics: Object.freeze(metrics || emptyMetrics()),
    });
}

function pipelineForGatewaySession(session) {
    if (session?.startupTimings?.completeHlsCacheHit === true) return 'cache-hit';
    if (session?.videoMode === 'copy') {
        return session?.audioMode === 'copy'
            ? 'video-copy-audio-copy'
            : 'video-copy-audio-transcode';
    }
    return 'video-transcode';
}

function profileForMeasuredReplay(profile, { keepCompleteCacheProof = false } = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || keepCompleteCacheProof) {
        return profile;
    }
    const measuredProfile = { ...profile };
    delete measuredProfile.mkvCompleteHlsCacheProof;
    delete measuredProfile.mkv_complete_hls_cache_proof;
    return Object.freeze(measuredProfile);
}

function finiteMetric(value, fallback = 0, maximum = 600_000) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(number, maximum) : fallback;
}

function integerMetric(value, fallback = 0, maximum = 1_000) {
    return Math.round(finiteMetric(value, fallback, maximum));
}

class ChromiumHlsPlaybackHarness {
    constructor({ hlsJsPath, chromiumExecutablePath = null, chromium = null } = {}) {
        this.hlsJsPath = path.resolve(String(hlsJsPath || ''));
        if (!fs.statSync(this.hlsJsPath, { throwIfNoEntry: false })?.isFile()) {
            throw new Error('MEDIA_LAB_HLS_JS_PATH_INVALID');
        }
        this.chromiumExecutablePath = chromiumExecutablePath ? path.resolve(chromiumExecutablePath) : null;
        if (this.chromiumExecutablePath
            && !fs.statSync(this.chromiumExecutablePath, { throwIfNoEntry: false })?.isFile()) {
            throw new Error('MEDIA_LAB_CHROMIUM_PATH_INVALID');
        }
        this.chromium = chromium;
    }

    async play({ gatewayOrigin, hlsUrl, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS, signal }) {
        throwIfAborted(signal);
        const expectedOrigin = new URL(gatewayOrigin).origin;
        const mediaUrl = new URL(hlsUrl);
        if (mediaUrl.origin !== expectedOrigin || !mediaUrl.pathname.startsWith('/sessions/')) {
            throw new Error('MEDIA_LAB_HLS_URL_INVALID');
        }
        const chromium = this.chromium || require('playwright-core').chromium;
        let browser = null;
        let context = null;
        let page = null;
        const onAbort = () => {
            browser?.close().catch(() => {});
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            browser = await chromium.launch({
                headless: true,
                executablePath: this.chromiumExecutablePath || undefined,
                args: [
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-background-networking',
                    '--disable-component-update',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                ],
            });
            throwIfAborted(signal);
            context = await browser.newContext({ serviceWorkers: 'block' });
            page = await context.newPage();
            await page.goto(`${expectedOrigin}/health`, {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(15_000, timeoutMs),
            });
            await page.setContent('<!doctype html><meta charset="utf-8"><video playsinline preload="auto"></video>');
            await page.addScriptTag({ path: this.hlsJsPath });
            const result = await page.evaluate(async ({ sourceUrl, deadlineMs }) => {
                const startedAt = performance.now();
                const video = document.querySelector('video');
                const HlsCtor = globalThis.Hls;
                if (!video || typeof HlsCtor !== 'function' || !HlsCtor.isSupported()) {
                    throw new Error('HLS_UNSUPPORTED');
                }
                const waitUntil = async (predicate, code, limitMs = deadlineMs) => {
                    while (!predicate()) {
                        if (performance.now() - startedAt > limitMs) throw new Error(code);
                        await new Promise((resolve) => setTimeout(resolve, 25));
                    }
                };
                const hls = new HlsCtor({
                    autoStartLoad: true,
                    startFragPrefetch: true,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                    enableWorker: false,
                });
                let fatalError = null;
                let manifestAt = null;
                let firstFragmentAt = null;
                let firstFrameAt = null;
                let firstPlaying = false;
                let seeking = false;
                let waitingAt = null;
                let waitingMediaTime = null;
                let rebufferCount = 0;
                let rebufferMs = 0;
                const minimumRebufferMs = 100;
                let maximumBufferedAhead = 0;
                let audioObserved = false;
                const waitForRenderedFrameAtOrAfter = async (minimumMediaTime, code) => {
                    if (typeof video.requestVideoFrameCallback !== 'function') {
                        await waitUntil(
                            () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                                && video.currentTime >= minimumMediaTime,
                            code,
                        );
                        return;
                    }
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error(code)),
                            Math.min(deadlineMs, 8_000),
                        );
                        const observe = (_now, metadata) => {
                            if (Number(metadata?.mediaTime) >= minimumMediaTime) {
                                clearTimeout(timer);
                                resolve();
                                return;
                            }
                            video.requestVideoFrameCallback(observe);
                        };
                        video.requestVideoFrameCallback(observe);
                    });
                };
                hls.on(HlsCtor.Events.ERROR, (_event, data) => {
                    if (data?.fatal) fatalError = String(data.type || 'fatal');
                });
                hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
                    if (manifestAt === null) manifestAt = performance.now() - startedAt;
                });
                hls.on(HlsCtor.Events.FRAG_BUFFERED, () => {
                    if (firstFragmentAt === null) firstFragmentAt = performance.now() - startedAt;
                });
                const updateBuffered = () => {
                    if (!video.buffered.length) return;
                    const ahead = Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
                    maximumBufferedAhead = Math.max(maximumBufferedAhead, ahead);
                };
                video.addEventListener('progress', updateBuffered);
                video.addEventListener('timeupdate', updateBuffered);
                const finishWaiting = () => {
                    if (waitingAt === null) return;
                    const durationMs = performance.now() - waitingAt;
                    const mediaAdvanceMs = waitingMediaTime === null
                        ? 0
                        : Math.max(0, (video.currentTime - waitingMediaTime) * 1_000);
                    const stalledMs = Math.max(0, durationMs - mediaAdvanceMs);
                    if (!seeking && !video.ended && stalledMs >= minimumRebufferMs) {
                        rebufferCount += 1;
                        rebufferMs += stalledMs;
                    }
                    waitingAt = null;
                    waitingMediaTime = null;
                };
                video.addEventListener('waiting', () => {
                    if (!firstPlaying || seeking || waitingAt !== null || video.paused || video.ended
                        || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
                    waitingAt = performance.now();
                    waitingMediaTime = video.currentTime;
                });
                video.addEventListener('stalled', () => {
                    if (!firstPlaying || seeking || waitingAt !== null || video.paused || video.ended
                        || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
                    waitingAt = performance.now();
                    waitingMediaTime = video.currentTime;
                });
                video.addEventListener('playing', () => {
                    firstPlaying = true;
                    finishWaiting();
                });
                const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
                if (!AudioContextCtor) throw new Error('AUDIO_CONTEXT_UNAVAILABLE');
                const audioContext = new AudioContextCtor();
                const source = audioContext.createMediaElementSource(video);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 256;
                const gain = audioContext.createGain();
                gain.gain.value = 0;
                source.connect(analyser);
                analyser.connect(gain);
                gain.connect(audioContext.destination);
                const frequency = new Uint8Array(analyser.frequencyBinCount);
                const sampleAudio = () => {
                    analyser.getByteFrequencyData(frequency);
                    if (frequency.some((value) => value > 0)) audioObserved = true;
                };
                const audioTimer = setInterval(sampleAudio, 40);
                try {
                    hls.attachMedia(video);
                    hls.once(HlsCtor.Events.MEDIA_ATTACHED, () => hls.loadSource(sourceUrl));
                    await waitUntil(() => fatalError !== null || manifestAt !== null, 'MANIFEST_TIMEOUT');
                    if (fatalError) throw new Error('HLS_FATAL');
                    await audioContext.resume();
                    await video.play();
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error('FIRST_FRAME_TIMEOUT')), deadlineMs);
                        const done = () => {
                            clearTimeout(timer);
                            firstFrameAt = performance.now() - startedAt;
                            resolve();
                        };
                        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(done);
                        else {
                            const onTime = () => {
                                if (video.readyState < 2 || video.currentTime <= 0) return;
                                video.removeEventListener('timeupdate', onTime);
                                done();
                            };
                            video.addEventListener('timeupdate', onTime);
                        }
                    });
                    await waitUntil(() => fatalError !== null || video.currentTime >= 0.2 || video.ended, 'PLAYBACK_DID_NOT_ADVANCE');
                    if (fatalError) throw new Error('HLS_FATAL');
                    updateBuffered();
                    const duration = Number(video.duration);
                    let seekPassed = false;
                    if (Number.isFinite(duration) && duration >= 1.25) {
                        const target = Math.min(duration - 0.35, Math.max(0.55, duration * 0.55));
                        seeking = true;
                        waitingAt = null;
                        waitingMediaTime = null;
                        try {
                            video.currentTime = target;
                            await waitUntil(() => !video.seeking && Math.abs(video.currentTime - target) < 0.4, 'SEEK_TIMEOUT');
                            // `seeked` and `currentTime` can advance before the
                            // decoder has presented the first frame at the new
                            // position. Keep seek recovery outside continuous
                            // playback rebuffer accounting until that frame is
                            // actually rendered, then require forward progress.
                            await waitForRenderedFrameAtOrAfter(Math.max(0, target - 0.4), 'SEEK_FRAME_TIMEOUT');
                            const advancedFrom = video.currentTime;
                            seeking = false;
                            await waitUntil(() => video.currentTime >= advancedFrom + 0.1 || video.ended, 'SEEK_PLAYBACK_TIMEOUT');
                            seekPassed = true;
                        } finally {
                            seeking = false;
                        }
                    }
                    await waitUntil(() => audioObserved || video.ended, 'AUDIO_DECODE_TIMEOUT', Math.min(deadlineMs, 8_000));
                    sampleAudio();
                    updateBuffered();
                    finishWaiting();
                    const segmentMs = firstFragmentAt ?? manifestAt ?? firstFrameAt;
                    return {
                        manifestMs: manifestAt ?? 0,
                        firstSegmentMs: segmentMs ?? 0,
                        firstFrameMs: firstFrameAt ?? 0,
                        bufferedAheadSeconds: maximumBufferedAhead,
                        browserBufferRateX: segmentMs > 0
                            ? Math.min(100, maximumBufferedAhead / (segmentMs / 1_000))
                            : 0,
                        rebufferCount,
                        rebufferMs,
                        seekPassed,
                        audioPassed: audioObserved,
                    };
                } finally {
                    clearInterval(audioTimer);
                    try { hls.destroy(); } catch (_) {}
                    try { await audioContext.close(); } catch (_) {}
                }
            }, { sourceUrl: mediaUrl.toString(), deadlineMs: timeoutMs });
            return Object.freeze(result);
        } finally {
            signal?.removeEventListener('abort', onAbort);
            await page?.close({ runBeforeUnload: false }).catch(() => {});
            await context?.close().catch(() => {});
            await browser?.close().catch(() => {});
            throwIfAborted(signal);
        }
    }
}

class GatewayChromiumPhysicalAdapter {
    constructor({
        gatewayUrl,
        gatewayToken,
        hlsJsPath,
        chromiumExecutablePath = null,
        fetchImpl = globalThis.fetch,
        browserHarness = null,
        sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
        browserTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
    } = {}) {
        this.gatewayOrigin = strictOrigin(gatewayUrl, 'MEDIA_LAB_GATEWAY_URL_INVALID');
        this.gatewayToken = boundedToken(gatewayToken);
        if (typeof fetchImpl !== 'function') throw new Error('MEDIA_LAB_GATEWAY_FETCH_INVALID');
        this.fetchImpl = fetchImpl;
        this.sessionTimeoutMs = boundedTimeout(sessionTimeoutMs, DEFAULT_SESSION_TIMEOUT_MS, 600_000);
        this.browserTimeoutMs = boundedTimeout(browserTimeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, 180_000);
        this.browserHarness = browserHarness || new ChromiumHlsPlaybackHarness({
            hlsJsPath,
            chromiumExecutablePath,
        });
    }

    async #request(pathname, { method = 'GET', body = null, signal } = {}) {
        throwIfAborted(signal);
        const response = await this.fetchImpl(`${this.gatewayOrigin}${pathname}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.gatewayToken}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'error',
            signal,
        });
        const payload = response.status === 204 ? null : await boundedJson(response);
        return Object.freeze({ status: response.status, ok: response.ok, payload });
    }

    #sessionBody(fixture, providerUrl, codecProfile = null) {
        const ownerKey = crypto.createHash('sha256').update('norva/media-lab/dedicated-owner/v1').digest('hex');
        return {
            sourceUrl: providerUrl,
            playbackSessionId: crypto.randomUUID(),
            ownerKey,
            mode: 'remux',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            userAgent: 'Norva-Media-Lab/1',
            playbackHint: { container: 'mkv', itemType: 'movie' },
            playbackIdentity: {
                sourceId: 'norva-media-lab',
                itemType: 'movie',
                itemId: fixture.id,
                variantId: 'fixture-v1',
            },
            codecProfile: codecProfile || undefined,
            ...(fixture.id === 'hevc-full-cache' ? {} : { completeHlsCachePolicy: 'bypass' }),
            seekOffset: 0,
        };
    }

    async #createSession(fixture, providerUrl, codecProfile, signal) {
        const startedAt = Date.now();
        const response = await this.#request('/sessions', {
            method: 'POST',
            body: this.#sessionBody(fixture, providerUrl, codecProfile),
            signal,
        });
        return Object.freeze({ ...response, elapsedMs: Date.now() - startedAt });
    }

    async #waitForSessionEnd(sessionId, signal) {
        const deadline = Date.now() + this.sessionTimeoutMs;
        while (Date.now() < deadline) {
            throwIfAborted(signal);
            const current = await this.#request(`/sessions/${encodeURIComponent(sessionId)}`, { signal });
            if (current.status === 404) throw new Error('MEDIA_LAB_SESSION_DISAPPEARED');
            if (!current.ok) throw new Error('MEDIA_LAB_SESSION_POLL_FAILED');
            const status = String(current.payload?.status || '');
            if (status === 'ended') return current.payload;
            if (status === 'failed') throw new Error('MEDIA_LAB_SESSION_FAILED');
            await delay(50, undefined, { signal }).catch((error) => {
                if (signal?.aborted) throw abortError();
                throw error;
            });
        }
        throw new Error('MEDIA_LAB_SESSION_END_TIMEOUT');
    }

    async #deleteAndVerify(sessionId, signal) {
        const encoded = encodeURIComponent(sessionId);
        const removed = await this.#request(`/sessions/${encoded}`, { method: 'DELETE', signal });
        if (!removed.ok) return Object.freeze({ cleanupObserved: false, finalCodecProfile: null });
        const readback = await this.#request(`/sessions/${encoded}`, { signal });
        return Object.freeze({
            cleanupObserved: readback.status === 404,
            finalCodecProfile: removed.payload?.finalCodecProfile || null,
        });
    }

    async #cleanupSession(sessionId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_CLEANUP_TIMEOUT_MS);
        timeout.unref?.();
        try {
            return await this.#deleteAndVerify(sessionId, controller.signal);
        } finally {
            clearTimeout(timeout);
        }
    }

    async #trainFixture(fixture, providerUrl, signal) {
        const created = await this.#createSession(fixture, providerUrl, null, signal);
        if (created.status !== 201 || !created.payload?.id) {
            return Object.freeze({ profile: null, cleanupObserved: true, create: created });
        }
        let cleanup = null;
        try {
            await this.#waitForSessionEnd(created.payload.id, signal);
        } finally {
            cleanup = await this.#cleanupSession(created.payload.id).catch(() => ({
                cleanupObserved: false,
                finalCodecProfile: null,
            }));
        }
        return Object.freeze({
            profile: cleanup.finalCodecProfile,
            cleanupObserved: cleanup.cleanupObserved,
            create: created,
        });
    }

    async runPhysicalCase({ protocol, fixture, providerUrl, resetProviderCounters = null, signal }) {
        if (protocol !== PROTOCOL || !fixture?.id || (providerUrl !== null && typeof providerUrl !== 'string')) {
            throw new Error('MEDIA_LAB_PHYSICAL_REQUEST_INVALID');
        }
        throwIfAborted(signal);
        if (fixture.id === 'provider-458') {
            const created = await this.#createSession(fixture, providerUrl, null, signal);
            const terminal = created.status === 458 && created.payload?.code === 'PROVIDER_BUSY';
            return evidence({
                status: terminal ? 'pass' : 'fail',
                pipeline: 'terminal-458',
                reason: terminal ? 'provider-busy-terminal' : 'provider-458-contract-failed',
                gatewayObserved: true,
                browserObserved: false,
                cleanupObserved: true,
                metrics: emptyMetrics({ ttffMs: created.elapsedMs }),
            });
        }

        let trainedProfile = null;
        let trainingCleanup = true;
        const seedsCompleteCache = fixture.id === 'hevc-full-cache';
        if (fixture.provider.trainingRequired || seedsCompleteCache) {
            if (seedsCompleteCache && typeof resetProviderCounters !== 'function') {
                return evidence({
                    status: 'blocked',
                    pipeline: fixture.expected.pipeline,
                    reason: 'provider-counter-reset-unavailable',
                    gatewayObserved: false,
                    browserObserved: false,
                    cleanupObserved: true,
                    metrics: emptyMetrics(),
                });
            }
            const trained = await this.#trainFixture(fixture, providerUrl, signal);
            trainedProfile = profileForMeasuredReplay(trained.profile, {
                keepCompleteCacheProof: seedsCompleteCache,
            });
            trainingCleanup = trained.cleanupObserved;
            if (trained.create.status !== 201) {
                return evidence({
                    status: 'fail',
                    pipeline: fixture.expected.pipeline,
                    reason: 'training-session-failed',
                    gatewayObserved: true,
                    browserObserved: false,
                    cleanupObserved: trainingCleanup,
                    metrics: emptyMetrics({ manifestReadyMs: trained.create.elapsedMs }),
                });
            }
            if (seedsCompleteCache) {
                if (typeof trainedProfile?.mkvCompleteHlsCacheProof !== 'string') {
                    return evidence({
                        status: 'fail',
                        pipeline: fixture.expected.pipeline,
                        reason: 'complete-cache-seed-proof-missing',
                        gatewayObserved: true,
                        browserObserved: false,
                        cleanupObserved: trainingCleanup,
                        metrics: emptyMetrics({ manifestReadyMs: trained.create.elapsedMs }),
                    });
                }
                if (resetProviderCounters() !== true) {
                    return evidence({
                        status: 'fail',
                        pipeline: fixture.expected.pipeline,
                        reason: 'provider-counter-reset-failed',
                        gatewayObserved: true,
                        browserObserved: false,
                        cleanupObserved: trainingCleanup,
                        metrics: emptyMetrics({ manifestReadyMs: trained.create.elapsedMs }),
                    });
                }
            }
        }

        let measuredSessionId = null;
        let cleanupObserved = false;
        let session = null;
        let createElapsedMs = 0;
        let pendingEvidence = null;
        try {
            const created = await this.#createSession(fixture, providerUrl, trainedProfile, signal);
            createElapsedMs = created.elapsedMs;
            if (created.status !== 201 || !created.payload?.id || !created.payload?.hlsUrl) {
                pendingEvidence = {
                    status: 'fail',
                    pipeline: fixture.expected.pipeline,
                    reason: 'gateway-session-failed',
                    gatewayObserved: true,
                    browserObserved: false,
                    metrics: emptyMetrics({ manifestReadyMs: createElapsedMs }),
                };
            } else {
                session = created.payload;
                measuredSessionId = session.id;
                const playback = await this.browserHarness.play({
                    gatewayOrigin: this.gatewayOrigin,
                    hlsUrl: session.hlsUrl,
                    timeoutMs: this.browserTimeoutMs,
                    signal,
                });
                const pipeline = pipelineForGatewaySession(session);
                const startup = session.startupTimings || {};
                const actualReason = String(session.startupPolicy?.reason || 'startup-policy-reason-missing');
                pendingEvidence = {
                    status: 'pass',
                    pipeline,
                    reason: actualReason,
                    gatewayObserved: true,
                    browserObserved: true,
                    metrics: emptyMetrics({
                        ttffMs: createElapsedMs + finiteMetric(playback.firstFrameMs),
                        manifestReadyMs: createElapsedMs,
                        firstSegmentMs: createElapsedMs + finiteMetric(playback.firstSegmentMs),
                        bufferedAheadSeconds: finiteMetric(playback.bufferedAheadSeconds, 0, 3_600),
                        productionRateX: finiteMetric(
                            session.startupPolicy?.observedEncodeRateX ?? startup.mediaProductionRateX,
                            0,
                            100,
                        ),
                        browserBufferRateX: finiteMetric(playback.browserBufferRateX, 0, 100),
                        rebufferCount: integerMetric(playback.rebufferCount),
                        rebufferMs: finiteMetric(playback.rebufferMs),
                        ffmpegSpawns: integerMetric(startup.ffmpegSpawnCount, pipeline === 'cache-hit' ? 0 : 1, 8),
                        analyzerSpawns: integerMetric(startup.analyzerSpawnCount, 0, 8),
                        seekPassed: playback.seekPassed === true,
                        audioPassed: playback.audioPassed === true,
                    }),
                };
            }
        } catch (error) {
            if (signal?.aborted || error?.code === 'ABORT_ERR') throw abortError();
            pendingEvidence = {
                status: 'fail',
                pipeline: session ? pipelineForGatewaySession(session) : fixture.expected.pipeline,
                reason: 'browser-playback-failed',
                gatewayObserved: session !== null,
                browserObserved: false,
                metrics: emptyMetrics({ manifestReadyMs: createElapsedMs }),
            };
        } finally {
            if (measuredSessionId) {
                cleanupObserved = (await this.#cleanupSession(measuredSessionId).catch(() => ({
                    cleanupObserved: false,
                }))).cleanupObserved;
            }
        }
        return evidence({
            ...pendingEvidence,
            cleanupObserved: trainingCleanup && (!measuredSessionId || cleanupObserved),
        });
    }
}

module.exports = Object.freeze({
    GatewayChromiumPhysicalAdapter,
    ChromiumHlsPlaybackHarness,
    pipelineForGatewaySession,
    profileForMeasuredReplay,
    evidence,
});
