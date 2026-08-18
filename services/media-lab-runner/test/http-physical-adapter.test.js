'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { FIXTURES } = require('../src/fixture-registry');
const { HttpPhysicalAdapter, projectPhysicalEvidence } = require('../src/http-physical-adapter');
const { physicalAdapterFromEnvironment } = require('../src/server');

const TOKEN = 'physical-adapter-token-0123456789abcdef';

function evidence(overrides = {}) {
    return {
        protocol: 1,
        kind: 'norva-media-lab-physical-v1',
        status: 'pass',
        pipeline: 'video-copy-audio-copy',
        reason: 'mkv-h264-copy-ready',
        gatewayObserved: true,
        browserObserved: true,
        cleanupObserved: true,
        metrics: {
            ttffMs: 5_000,
            manifestReadyMs: 2_000,
            firstSegmentMs: 2_500,
            bufferedAheadSeconds: 8,
            productionRateX: 2,
            browserBufferRateX: 2,
            rebufferCount: 0,
            rebufferMs: 0,
            ffmpegSpawns: 1,
            analyzerSpawns: 0,
            seekPassed: true,
            audioPassed: true,
        },
        ...overrides,
    };
}

test('private adapter sends one exact server-only request and projects physical evidence without identities', async (t) => {
    let calls = 0;
    let received = null;
    const server = http.createServer(async (request, response) => {
        calls += 1;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/run');
        assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(evidence({
            sourceUrl: 'https://provider.invalid/secret.mkv',
            sessionId: 'must-not-cross',
        })));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const adapter = new HttpPhysicalAdapter({ url: origin, token: TOKEN });
    const fixture = FIXTURES[0];
    const result = await adapter.runPhysicalCase({
        protocol: 1,
        fixture,
        providerUrl: 'http://127.0.0.1/internal/capability/media.mkv',
        signal: new AbortController().signal,
    });
    assert.equal(calls, 1);
    assert.deepEqual(received, {
        protocol: 1,
        fixtureId: 'h264-closed-aac',
        providerUrl: 'http://127.0.0.1/internal/capability/media.mkv',
    });
    assert.equal(result.metrics.ttffMs, 5_000);
    assert.doesNotMatch(JSON.stringify(result), /provider\.invalid|secret|sessionId|must-not-cross/);
});

test('private adapter is optional, never retries a refusal, and rejects malformed evidence', async () => {
    assert.equal(physicalAdapterFromEnvironment({}), null);
    assert.throws(() => physicalAdapterFromEnvironment({
        MEDIA_LAB_PHYSICAL_ADAPTER_URL: 'https://adapter.invalid',
    }), /TOKEN_INVALID/);
    let calls = 0;
    const refused = new HttpPhysicalAdapter({
        url: 'https://adapter.invalid',
        token: TOKEN,
        fetchImpl: async () => {
            calls += 1;
            return new Response('{}', { status: 503 });
        },
    });
    await assert.rejects(refused.runPhysicalCase({
        protocol: 1,
        fixture: FIXTURES[0],
        providerUrl: null,
        signal: new AbortController().signal,
    }), /ADAPTER_REFUSED/);
    assert.equal(calls, 1);
    assert.throws(() => projectPhysicalEvidence(evidence({ metrics: { ...evidence().metrics, ttffMs: '5000' } })), /EVIDENCE_INVALID/);
});
