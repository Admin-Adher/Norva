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

test('ordinary close retains only complete local input intervals under the fixed header/tail bound', () => {
    const input = crypto.randomBytes(7 * W + S);
    const c = new LinearResumeSamples(size, target, { retainInput: true });
    for (let at = 0; at < input.length; at += 7931) c.append(at, input.subarray(at, at + 7931));
    const snapshot = c.finishSnapshot({ graceful: true, fileSizeBytes: size, target });
    assert.deepEqual(snapshot.inputWindows.map(w => [w.start, w.payload.length]),
        [[0,W],[W,W],[2*W,W],[3*W,W],[6*W,W]]);
    assert.equal(snapshot.inputWindows.reduce((n,w) => n+w.payload.length,0), 5*W);
    for (const w of snapshot.inputWindows) assert.deepEqual(w.payload,input.subarray(w.start,w.start+w.payload.length));
    input.fill(0);
    assert.notDeepEqual(snapshot.inputWindows[0].payload, Buffer.alloc(W));
    assert.equal(c.window,null); assert.equal(c.latestWindow,null); assert.equal(c.prefixWindows.length,0);
    assert.equal(c.finishSnapshot({ graceful:true,fileSizeBytes:size,target }),null);
});

for (const reason of ['interrupted','gap','overlap','size','target','overrun']) test(`input retention refuses ${reason} after complete intervals`,()=>{
    const c = new LinearResumeSamples(size,target,{retainInput:true}); c.append(0,Buffer.alloc(3*W));
    if (reason==='interrupted') c.invalidate();
    if (reason==='gap') c.append(3*W+1,Buffer.alloc(S));
    if (reason==='overlap') c.append(3*W-1,Buffer.alloc(S));
    if (reason==='overrun') c.append(3*W,Buffer.alloc(size));
    assert.equal(c.finishSnapshot({graceful:true,fileSizeBytes:reason==='size'?size+1:size,target:reason==='target'?'b'.repeat(64):target}),null);
    assert.equal(c.prefixWindows.length,0); assert.equal(c.latestWindow,null);
});

const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
const stopSource = source.slice(source.indexOf('async function stopBoundedMkvInputPump('),
    source.indexOf('\nfunction finiteMkvLinearSeekBridgePlanForSession('));
function stopHarness(overrides = {}, retainInput = false) {
    const session = { status: 'stopping', ownerKey: 'owner', privateResumeStopPosition: 4,
        fileSizeBytes: size, vodInputEffectiveUrlSha256: target };
    const evidence = new LinearResumeSamples(size, target, { retainInput }); evidence.append(0, Buffer.alloc(W));
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
test('drained ordinary close exposes bounded observed intervals for the subtitle input fallback', async () => {
    const h=stopHarness({},true), pending=h.stop(h.session);
    await Promise.resolve();assert.equal(h.session.privateResumeInputWindows,undefined);
    h.drain();await pending;
    assert.equal(h.session.privateResumeInputWindows.length,1);
    assert.equal(h.session.privateResumeInputWindows[0].payload.length,W);
});
for (const reason of ['error', 'timeout', 'revocation', 'no-position', 'route', 'owner']) {
    test(`pump teardown refuses ${reason}`, async () => {
        const h = stopHarness(reason === 'route' ? { recentDeliveryRouteKey: () => 'other' }
            : reason === 'owner' ? { canUseRecentResumeSamples: () => false } : {}, true);
        if (reason === 'error') h.session.lastError = 'failed';
        if (reason === 'timeout') h.session.inputPump.error = { code: 'TIMEOUT' };
        if (reason === 'revocation') h.session.status = 'failed';
        if (reason === 'no-position') h.session.privateResumeStopPosition = 0;
        h.drain(); await h.stop(h.session);
        assert.equal(h.session.privateResumeSamples, undefined);
        assert.equal(h.session.privateResumeInputWindows, undefined);
        assert.equal(h.evidence.prefixWindows.length, 0);
        assert.equal(h.evidence.window, null);
    });
}
