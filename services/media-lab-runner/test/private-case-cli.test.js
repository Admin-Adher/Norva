'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runPrivateCase } = require('../scripts/run-private-case');

const TOKEN = 'private-runner-test-token-0123456789abcdef';

function response(status, payload) {
    const bytes = payload == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    return {
        status,
        headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(bytes.length) : null; } },
        async arrayBuffer() { return bytes; },
    };
}

test('private case CLI sends one fixed fixture, polls, validates and always cleans up', async () => {
    const requests = [];
    const states = [
        response(202, { protocol: 1, state: 'running', fixtureId: 'h264-closed-aac' }),
        response(200, {
            protocol: 1,
            state: 'complete',
            fixtureId: 'h264-closed-aac',
            result: {
                protocol: 1,
                status: 'pass',
                pipeline: 'video-copy-audio-copy',
                reason: 'mkv-h264-copy-ready',
                ttffMs: 800,
                providerGets: 2,
                maximumConcurrentProviderGets: 1,
                ffmpegSpawns: 1,
                rebufferCount: 0,
                seekPassed: true,
                audioPassed: true,
                cleanupPassed: true,
            },
        }),
        response(204, null),
    ];
    const result = await runPrivateCase({
        fixtureId: 'h264-closed-aac',
        token: TOKEN,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return states.shift();
        },
    });
    assert.equal(result.result.status, 'pass');
    assert.deepEqual(requests.map((entry) => entry.options.method), ['POST', 'GET', 'DELETE']);
    assert.deepEqual(JSON.parse(requests[0].options.body), { protocol: 1, fixtureId: 'h264-closed-aac' });
    assert.match(requests[0].options.headers['X-Norva-Lab-Actor'], /^[A-Za-z0-9_-]{43}$/);
    assert.ok(requests.every((entry) => entry.url === 'http://127.0.0.1:8093/v1/current'));
});

test('private case CLI fails closed on a semantic mismatch and still deletes state', async () => {
    const methods = [];
    const states = [
        response(200, {
            protocol: 1,
            state: 'complete',
            fixtureId: 'hevc-eac3-cold',
            result: {
                protocol: 1,
                status: 'pass',
                pipeline: 'video-copy-audio-copy',
                reason: 'video-codec',
                cleanupPassed: true,
            },
        }),
        response(204, null),
    ];
    await assert.rejects(() => runPrivateCase({
        fixtureId: 'hevc-eac3-cold',
        token: TOKEN,
        fetchImpl: async (_url, options) => {
            methods.push(options.method);
            return states.shift();
        },
    }), (error) => {
        assert.match(error.message, /MEDIA_LAB_PRIVATE_CASE_FAILED/);
        assert.deepEqual(error.diagnostic, {
            status: 'pass',
            pipeline: 'video-copy-audio-copy',
            reason: 'video-codec',
            expectedPipeline: 'video-transcode',
            expectedReason: 'video-codec',
            ttffMs: null,
            providerGets: null,
            maximumConcurrentProviderGets: null,
            ffmpegSpawns: null,
            rebufferCount: null,
            rebufferMs: null,
            bufferedAheadSeconds: null,
            browserBufferRateX: null,
            seekPassed: false,
            audioPassed: false,
            cleanupPassed: true,
        });
        return true;
    });
    assert.deepEqual(methods, ['POST', 'DELETE']);
});
