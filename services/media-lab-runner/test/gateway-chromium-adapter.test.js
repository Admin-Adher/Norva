'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
    FIXTURES,
    PROTOCOL,
} = require('../src/fixture-registry');
const {
    GatewayChromiumPhysicalAdapter,
    pipelineForGatewaySession,
} = require('../src/gateway-chromium-adapter');
const { physicalAdapterFromEnvironment } = require('../src/server');

const TOKEN = 'gateway-lab-token-0123456789abcdef';
const PROVIDER_URL = 'http://127.0.0.1:9876/internal/provider/capability/media.mkv';

function fixture(id) {
    return FIXTURES.find((item) => item.id === id);
}

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function jsonBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, body) {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
}

test('physical adapter trains the exact H264 file, measures the replay and verifies both cleanups', async (t) => {
    const sessions = new Map();
    const requests = [];
    let postCount = 0;
    const gateway = await listen(async (request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
        requests.push(`${request.method} ${request.url}`);
        if (request.method === 'POST' && request.url === '/sessions') {
            const body = await jsonBody(request);
            assert.equal(body.sourceUrl, PROVIDER_URL);
            assert.equal(body.playbackIdentity.itemId, 'h264-closed-aac');
            assert.equal(body.completeHlsCachePolicy, 'bypass');
            postCount += 1;
            const id = postCount === 1 ? 'training-session' : 'measured-session';
            if (postCount === 1) assert.equal(body.codecProfile, undefined);
            else {
                assert.equal(body.codecProfile.mkvH264FastStartProof, 'opaque-proof');
                assert.equal(body.codecProfile.mkvCompleteHlsCacheProof, undefined);
            }
            const payload = {
                id,
                status: 'ready',
                videoMode: postCount === 1 ? 'encode' : 'copy',
                audioMode: 'copy',
                hlsUrl: `${gateway.origin}/sessions/${id}/playlist.m3u8?token=opaque`,
                startupPolicy: {
                    reason: postCount === 1 ? 'missing-proof' : 'mkv-h264-copy-ready',
                    observedEncodeRateX: 12,
                },
                startupTimings: {
                    ffmpegSpawnCount: 1,
                    analyzerSpawnCount: postCount === 1 ? 2 : 0,
                    mediaProductionRateX: 12,
                },
            };
            sessions.set(id, payload);
            json(response, 201, payload);
            return;
        }
        const match = /^\/sessions\/([^/]+)$/.exec(request.url);
        if (match && request.method === 'GET') {
            const session = sessions.get(match[1]);
            if (!session) return json(response, 404, { error: 'not-found' });
            return json(response, 200, { ...session, status: match[1] === 'training-session' ? 'ended' : 'ready' });
        }
        if (match && request.method === 'DELETE') {
            const existed = sessions.delete(match[1]);
            if (!existed) return json(response, 404, { error: 'not-found' });
            return json(response, 200, {
                success: true,
                finalCodecProfile: match[1] === 'training-session'
                    ? {
                        container: 'matroska',
                        mkvH264FastStartProof: 'opaque-proof',
                        mkvCompleteHlsCacheProof: 'opaque-cache-proof-that-must-not-mask-fast-copy',
                    }
                    : null,
            });
        }
        json(response, 404, { error: 'not-found' });
    });
    t.after(gateway.close);

    let browserCalls = 0;
    const adapter = new GatewayChromiumPhysicalAdapter({
        gatewayUrl: gateway.origin,
        gatewayToken: TOKEN,
        browserHarness: {
            async play(input) {
                browserCalls += 1;
                assert.equal(input.gatewayOrigin, gateway.origin);
                assert.match(input.hlsUrl, /measured-session/);
                return {
                    firstFrameMs: 180,
                    firstSegmentMs: 90,
                    bufferedAheadSeconds: 3.5,
                    browserBufferRateX: 20,
                    rebufferCount: 0,
                    rebufferMs: 0,
                    seekPassed: true,
                    audioPassed: true,
                };
            },
        },
    });
    const result = await adapter.runPhysicalCase({
        protocol: PROTOCOL,
        fixture: fixture('h264-closed-aac'),
        providerUrl: PROVIDER_URL,
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.pipeline, 'video-copy-audio-copy');
    assert.equal(result.reason, 'mkv-h264-copy-ready');
    assert.equal(result.gatewayObserved, true);
    assert.equal(result.browserObserved, true);
    assert.equal(result.cleanupObserved, true);
    assert.equal(result.metrics.ffmpegSpawns, 1);
    assert.equal(result.metrics.analyzerSpawns, 0);
    assert.equal(result.metrics.seekPassed, true);
    assert.equal(result.metrics.audioPassed, true);
    assert.equal(browserCalls, 1);
    assert.equal(postCount, 2);
    assert.equal(sessions.size, 0);
    assert.deepEqual(requests.filter((entry) => entry.startsWith('DELETE ')), [
        'DELETE /sessions/training-session',
        'DELETE /sessions/measured-session',
    ]);
});

test('a terminal provider 458 is observed once and never launches Chromium', async (t) => {
    let posts = 0;
    const gateway = await listen(async (request, response) => {
        if (request.method === 'POST' && request.url === '/sessions') {
            posts += 1;
            await jsonBody(request);
            return json(response, 458, { code: 'PROVIDER_BUSY' });
        }
        json(response, 404, { error: 'not-found' });
    });
    t.after(gateway.close);
    const adapter = new GatewayChromiumPhysicalAdapter({
        gatewayUrl: gateway.origin,
        gatewayToken: TOKEN,
        browserHarness: { play: async () => assert.fail('Chromium must not start after 458') },
    });
    const result = await adapter.runPhysicalCase({
        protocol: PROTOCOL,
        fixture: fixture('provider-458'),
        providerUrl: PROVIDER_URL,
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.pipeline, 'terminal-458');
    assert.equal(result.browserObserved, false);
    assert.equal(result.cleanupObserved, true);
    assert.equal(result.metrics.ffmpegSpawns, 0);
    assert.equal(posts, 1);
});

test('an aborted browser run still deletes and verifies its Gateway session with a fresh cleanup signal', async (t) => {
    const sessions = new Set();
    const requests = [];
    const gateway = await listen(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.method === 'POST' && request.url === '/sessions') {
            await jsonBody(request);
            sessions.add('aborted-session');
            return json(response, 201, {
                id: 'aborted-session',
                status: 'ready',
                videoMode: 'encode',
                audioMode: 'transcode',
                hlsUrl: `${gateway.origin}/sessions/aborted-session/playlist.m3u8?token=opaque`,
                startupTimings: { ffmpegSpawnCount: 1, analyzerSpawnCount: 0 },
            });
        }
        if (request.url === '/sessions/aborted-session' && request.method === 'DELETE') {
            sessions.delete('aborted-session');
            return json(response, 200, { success: true, finalCodecProfile: null });
        }
        if (request.url === '/sessions/aborted-session' && request.method === 'GET') {
            return sessions.has('aborted-session')
                ? json(response, 200, { id: 'aborted-session', status: 'ready' })
                : json(response, 404, { error: 'not-found' });
        }
        json(response, 404, { error: 'not-found' });
    });
    t.after(gateway.close);
    const controller = new AbortController();
    const adapter = new GatewayChromiumPhysicalAdapter({
        gatewayUrl: gateway.origin,
        gatewayToken: TOKEN,
        browserHarness: {
            async play() {
                controller.abort();
                throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
            },
        },
    });
    await assert.rejects(() => adapter.runPhysicalCase({
        protocol: PROTOCOL,
        fixture: fixture('hevc-eac3-cold'),
        providerUrl: PROVIDER_URL,
        signal: controller.signal,
    }), /MEDIA_LAB_PHYSICAL_ABORTED/);
    assert.equal(sessions.size, 0);
    assert.deepEqual(requests.slice(-2), [
        'DELETE /sessions/aborted-session',
        'GET /sessions/aborted-session',
    ]);
});

test('HEVC cache case seeds once, resets provider evidence, then measures a zero-FFmpeg cache hit', async (t) => {
    const sessions = new Map();
    let posts = 0;
    const gateway = await listen(async (request, response) => {
        if (request.method === 'POST' && request.url === '/sessions') {
            const body = await jsonBody(request);
            assert.equal(body.completeHlsCachePolicy, undefined);
            posts += 1;
            const id = posts === 1 ? 'hevc-seed' : 'hevc-cache-hit';
            if (posts === 1) assert.equal(body.codecProfile, undefined);
            else assert.equal(body.codecProfile.mkvCompleteHlsCacheProof, 'opaque-cache-proof');
            const payload = {
                id,
                status: 'ready',
                videoMode: posts === 1 ? 'encode' : 'copy',
                audioMode: posts === 1 ? 'transcode' : 'copy',
                videoModeReason: posts === 1 ? 'unsafe_or_unknown_video' : 'complete_hls_cache_hit',
                hlsUrl: `${gateway.origin}/sessions/${id}/playlist.m3u8?token=opaque`,
                startupPolicy: {
                    reason: posts === 1 ? 'video-transcode' : 'complete-hls-cache-hit',
                    observedEncodeRateX: posts === 1 ? 2 : 20,
                },
                startupTimings: {
                    completeHlsCacheHit: posts === 2,
                    providerGetCount: posts === 2 ? 0 : 1,
                    ffmpegSpawnCount: posts === 2 ? 0 : 1,
                    analyzerSpawnCount: 0,
                    mediaProductionRateX: posts === 1 ? 2 : 20,
                },
            };
            sessions.set(id, payload);
            return json(response, 201, payload);
        }
        const match = /^\/sessions\/([^/]+)$/.exec(request.url);
        if (match && request.method === 'GET') {
            const session = sessions.get(match[1]);
            if (!session) return json(response, 404, { error: 'not-found' });
            return json(response, 200, {
                ...session,
                status: match[1] === 'hevc-seed' ? 'ended' : 'ready',
            });
        }
        if (match && request.method === 'DELETE') {
            const existed = sessions.delete(match[1]);
            if (!existed) return json(response, 404, { error: 'not-found' });
            return json(response, 200, {
                success: true,
                finalCodecProfile: match[1] === 'hevc-seed'
                    ? { container: 'matroska', videoCodec: 'hevc', mkvCompleteHlsCacheProof: 'opaque-cache-proof' }
                    : null,
            });
        }
        json(response, 404, { error: 'not-found' });
    });
    t.after(gateway.close);

    let resets = 0;
    let browserCalls = 0;
    const adapter = new GatewayChromiumPhysicalAdapter({
        gatewayUrl: gateway.origin,
        gatewayToken: TOKEN,
        browserHarness: {
            async play({ hlsUrl }) {
                browserCalls += 1;
                assert.match(hlsUrl, /hevc-cache-hit/);
                return {
                    firstFrameMs: 120,
                    firstSegmentMs: 40,
                    bufferedAheadSeconds: 4,
                    browserBufferRateX: 50,
                    rebufferCount: 0,
                    rebufferMs: 0,
                    seekPassed: true,
                    audioPassed: true,
                };
            },
        },
    });
    const result = await adapter.runPhysicalCase({
        protocol: PROTOCOL,
        fixture: fixture('hevc-full-cache'),
        providerUrl: PROVIDER_URL,
        resetProviderCounters: () => { resets += 1; return true; },
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.pipeline, 'cache-hit');
    // The adapter must report the Gateway policy verbatim. The fixture's
    // semantic verdict is "complete-cache-hit", which deliberately differs.
    assert.equal(result.reason, 'complete-hls-cache-hit');
    assert.equal(result.metrics.ffmpegSpawns, 0);
    assert.equal(result.metrics.seekPassed, true);
    assert.equal(result.metrics.audioPassed, true);
    assert.equal(resets, 1);
    assert.equal(browserCalls, 1);
    assert.equal(posts, 2);
    assert.equal(sessions.size, 0);
});

test('pipeline projection is derived from Gateway output, never from fixture expectation', () => {
    assert.equal(pipelineForGatewaySession({ videoMode: 'copy', audioMode: 'copy' }), 'video-copy-audio-copy');
    assert.equal(pipelineForGatewaySession({ videoMode: 'copy', audioMode: 'transcode' }), 'video-copy-audio-transcode');
    assert.equal(pipelineForGatewaySession({ videoMode: 'encode', audioMode: 'copy' }), 'video-transcode');
    assert.equal(pipelineForGatewaySession({
        videoMode: 'copy',
        audioMode: 'copy',
        startupTimings: { completeHlsCacheHit: true },
    }), 'cache-hit');
});

test('environment selects exactly one physical adapter implementation', () => {
    const inline = physicalAdapterFromEnvironment({
        MEDIA_LAB_GATEWAY_URL: 'http://127.0.0.1:8092',
        MEDIA_LAB_GATEWAY_TOKEN: TOKEN,
        MEDIA_LAB_HLS_JS_PATH: __filename,
    });
    assert.ok(inline instanceof GatewayChromiumPhysicalAdapter);
    assert.throws(() => physicalAdapterFromEnvironment({
        MEDIA_LAB_GATEWAY_URL: 'http://127.0.0.1:8092',
        MEDIA_LAB_GATEWAY_TOKEN: TOKEN,
        MEDIA_LAB_HLS_JS_PATH: __filename,
        MEDIA_LAB_PHYSICAL_ADAPTER_URL: 'http://127.0.0.1:8094',
        MEDIA_LAB_PHYSICAL_ADAPTER_TOKEN: TOKEN,
    }), /MEDIA_LAB_PHYSICAL_ADAPTER_CONFLICT/);
});
