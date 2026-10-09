'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { LinearResumeSamples, LINEAR_SAMPLE_WINDOW_BYTES: W, SAMPLE_BYTES: S,
    sampleProof, samplesMatch } = require('../services/media-gateway/src/recent-resume-samples');
const target = 'a'.repeat(64), size = 8 * W;
const finish = collector => collector.finish({ graceful: true, fileSizeBytes: size, target });

test('arbitrary decoder chunks preserve exact first and latest completed window samples, bounded in memory', () => {
    const input = crypto.randomBytes(3 * W + S);
    const collector = new LinearResumeSamples(size, target);
    for (let at = 0; at < input.length; at += 7931) collector.append(at, input.subarray(at, at + 7931));
    assert.equal(collector.window.length, W);
    assert.equal(collector.samples.reduce((sum, s) => sum + s.payload.length, 0), 4 * S);
    const samples = finish(collector);
    assert.equal(samples.length, 4);
    assert.equal(samples[1].start, 2 * W);
    for (const sample of samples) assert.deepEqual(sample.payload, input.subarray(sample.start, sample.start + S));
    assert.ok(sampleProof(samples, size, target));
    input.fill(0);
    assert.notEqual(samples[0].payload.compare(Buffer.alloc(S)), 0, 'samples must own their buffers');
    assert.equal(collector.window, null);
    assert.equal(finish(collector), null, 'evidence is consumed once');
});

for (const length of [0, 4 * S, W - 1]) test(`incomplete local window (${length} bytes) provides no evidence`, () => {
    const c = new LinearResumeSamples(size, target); c.append(0, Buffer.alloc(length));
    assert.equal(finish(c), null);
});

for (const change of ['gap', 'overlap', 'overrun', 'invalidated', 'size', 'target', 'ungraceful']) {
    test(`${change} fails closed even after enough data was observed`, () => {
        const c = new LinearResumeSamples(size, target); c.append(0, Buffer.alloc(W));
        if (change === 'gap') c.append(W + 1, Buffer.alloc(S));
        if (change === 'overlap') c.append(W - 1, Buffer.alloc(S));
        if (change === 'overrun') c.append(W, Buffer.alloc(size));
        if (change === 'invalidated') c.invalidate();
        assert.equal(c.finish({ graceful: change !== 'ungraceful',
            fileSizeBytes: change === 'size' ? size + 1 : size,
            target: change === 'target' ? 'b'.repeat(64) : target }), null);
        assert.equal(c.window, null);
    });
}

test('fresh samples still reject changed bytes; a prefix never attests the whole file', () => {
    const c = new LinearResumeSamples(size, target); c.append(0, crypto.randomBytes(W));
    const samples = finish(c), proof = sampleProof(samples, size, target);
    assert.equal(proof.kind, 'sampled-recent-v1');
    assert.ok(samplesMatch(proof, samples, size, target));
    samples[2].payload[0] ^= 1;
    assert.equal(samplesMatch(proof, samples, size, target), false);
    assert.equal(c.inputWindows, undefined);
});

const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
const stopSource = source.slice(source.indexOf('async function stopBoundedMkvInputPump('),
    source.indexOf('\nfunction finiteMkvLinearSeekBridgePlanForSession('));
function stopHarness(overrides = {}) {
    const session = { status: 'stopping', ownerKey: 'owner', privateResumeStopPosition: 4,
        fileSizeBytes: size, vodInputEffectiveUrlSha256: target };
    const evidence = new LinearResumeSamples(size, target); evidence.append(0, Buffer.alloc(W));
    session.linearResumeEvidence = { samples: evidence, targetUrl: 'http://example.test/media', routeKey: 'same' };
    let drain;
    session.inputPump = { controller: { abort() {} }, promise: new Promise(resolve => { drain = resolve; }) };
    const stop = vm.runInNewContext(`(${stopSource})`, {
        canUsePrivateResumeCache: () => true, canUseRecentResumeSamples: () => true,
        recentDeliveryRouteKey: () => 'same', fileSizeBytesForSession: s => s.fileSizeBytes,
        retainRecentDeliveryTarget: () => ({}), FFMPEG_USER_AGENT: 'test', ...overrides,
    });
    return { stop, session, drain, evidence };
}
test('actual pump teardown waits for transport drain and does not turn samples into input-cache bytes', async () => {
    const { stop, session, drain } = stopHarness(); const pending = stop(session);
    await Promise.resolve(); assert.equal(session.privateResumeSamples, undefined);
    drain(); await pending;
    assert.equal(session.privateResumeSamples.length, 4);
    assert.equal(session.privateResumeInputWindows, undefined);
    assert.equal(session.inputPump, null); assert.equal(session.linearResumeEvidence, null);
});
for (const reason of ['error', 'timeout', 'revocation', 'no-position', 'route', 'owner']) {
    test(`pump teardown refuses ${reason}`, async () => {
        const h = stopHarness(reason === 'route' ? { recentDeliveryRouteKey: () => 'other' }
            : reason === 'owner' ? { canUseRecentResumeSamples: () => false } : {});
        if (reason === 'error') h.session.lastError = 'failed';
        if (reason === 'timeout') h.session.inputPump.error = { code: 'TIMEOUT' };
        if (reason === 'revocation') h.session.status = 'failed';
        if (reason === 'no-position') h.session.privateResumeStopPosition = 0;
        h.drain(); await h.stop(h.session);
        assert.equal(h.session.privateResumeSamples, undefined);
        assert.equal(h.evidence.window, null);
    });
}
