'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { SAMPLE_BYTES: N, RECENT_TTL_MS } = require('../services/media-gateway/src/recent-resume-samples');
const { recentResumeTargetParts: parts, recentResumeTargetEligible, validateRecentResume } = require('../services/media-gateway/src/recent-resume-validation');
const size = 100 * N, oldTarget = 'b'.repeat(64), freshTarget = 'c'.repeat(64);
const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://entry.invalid/owned-file',
    sourceId: 'source', sourceRevision: '1', vodIdentityKey: 'd'.repeat(64), fileSizeBytes: size, profile: 'av=1' });
const samples = () => [0, 20*N, 40*N, 60*N].map((start, i) => ({ start, payload: Buffer.alloc(N, i+1) }));
const original = () => ({ fileSizeBytes: size, effectiveUrlIdentitySha256: oldTarget,
    targetParts: parts('https://cdn.invalid/signed/old'), samples: samples() });
const current = () => ({ ...original(), effectiveUrlIdentitySha256: freshTarget,
    targetParts: parts('https://cdn.invalid/signed/fresh') });
async function stored(options = {}) {
    const cache = new PrivateResumeHlsCache({ recentRevalidation: true, allowDeliveryPathRenewal: true, ...options });
    assert.equal(await cache.capture({ binding, observed: original(), position: 10, actualStartOffset: 0,
        playlist: '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' + Array.from({length: 20}, (_,i) => `#EXTINF:4,\nseg-${i}.ts\n`).join(''),
        inputWindows: [{start: 0, payload: Buffer.alloc(N, 1)}], readAsset: async () => Buffer.alloc(188, 0x47) }), true);
    return cache;
}
test('fresh path can reuse only the exact private window after four content matches', async () => {
    const cache = await stored(), plan = cache.revalidationPlan(binding, 10);
    assert.equal(recentResumeTargetEligible(plan, current()), true);
    const lease = cache.acquire(binding, 10, current());
    assert.ok(lease); assert.equal(cache.publicStatus().lastSampledValidation.outcome, 'accepted-path-renewal');
    assert.equal(lease.inputSnapshot().target, freshTarget, 'continuation pins the fresh target, never the expired path');
    lease.release();
});
for (const fault of ['disabled', 'missing-parts', 'host', 'protocol', 'query-shape', 'size', 'missing-sample', 'changed-sample', 'range', 'owner', 'source', 'profile', 'expired', 'revoked']) {
    test(`delivery renewal rejects ${fault}`, async () => {
        let now = 100; const cache = await stored({ now: () => now, allowDeliveryPathRenewal: fault !== 'disabled' });
        const observed = current(); let lookup = binding;
        if (fault === 'missing-parts') delete observed.targetParts;
        if (fault === 'host') observed.targetParts = parts('https://other.invalid/signed/fresh');
        if (fault === 'protocol') observed.targetParts = parts('http://cdn.invalid/signed/fresh');
        if (fault === 'query-shape') observed.targetParts = parts('https://cdn.invalid/signed/fresh?new=1');
        if (fault === 'size') observed.fileSizeBytes++;
        if (fault === 'missing-sample') observed.samples.pop();
        if (fault === 'changed-sample') observed.samples[2].payload[100]++;
        if (fault === 'range') observed.samples[2].start++;
        if (fault === 'owner') lookup = { ...binding, ownerKey: 'e'.repeat(64) };
        if (fault === 'source') lookup = { ...binding, sourceUrlHash: 'e'.repeat(64) };
        if (fault === 'profile') lookup = { ...binding, profileHash: 'e'.repeat(64) };
        if (fault === 'expired') now += RECENT_TTL_MS;
        if (fault === 'revoked') cache.revokeOwner(binding.ownerKey);
        assert.equal(cache.acquire(lookup, 10, observed), null);
    });
}
test('renewal does not extend the original expiry', async () => {
    let now = 100; const cache = await stored({now: () => now});
    now += RECENT_TTL_MS - 1; const lease = cache.acquire(binding, 10, current()); assert.ok(lease); lease.release();
    now++; assert.equal(cache.hasCandidate(binding, 10), false);
});
for (const fault of ['success', 'not-retained', 'other-status', 'second-refusal', 'drain-failed', 'aborted']) {
    test(`retained 509 refresh lifecycle: ${fault}`, async () => {
        const signal = new AbortController(); let opens = 0, drained = false, reads = 0, refusal = 0;
        const plan = {kind: 'sampled-recent-v1', ranges: samples().map(({start}) => ({start, length: N}))};
        const brokers = [];
        const result = await validateRecentResume({plan, signal: signal.signal, renewRefusedDelivery: true,
            onDeliveryRefused: () => refusal++,
            createBroker: async (_, {freshSource}) => {
                if (opens) { assert.equal(drained, true); assert.equal(freshSource, true); }
                const first = opens++ === 0;
                const broker = {inputUrl: first ? 'first' : 'fresh', recentDeliveryTargetUsed: first && fault !== 'not-retained',
                    terminalError: first || fault === 'second-refusal' ? {upstreamStatus: fault === 'other-status' ? 503 : 509} : null,
                    close: async () => { if (first && fault === 'drain-failed') throw Error('drain'); drained = true;
                        if (first && fault === 'aborted') signal.abort(); }};
                brokers.push(broker); return broker;
            }, fetchImpl: async url => { reads++; return url === 'first' || fault === 'second-refusal'
                ? {status: 502, body: {cancel: async () => {}}} : {status: 206, arrayBuffer: async () => Buffer.alloc(N)}; },
        }).catch(error => { if (fault !== 'drain-failed') throw error; assert.match(error.message, /^drain$/); return null; });
        if (fault === 'success') { assert.equal(result.length, 4); assert.equal(opens, 2); assert.equal(reads, 5); }
        else { assert.equal(result, null); assert.ok(opens <= 2); }
        assert.equal(refusal, ['success', 'second-refusal', 'aborted'].includes(fault) ? 1 : 0);
    });
}
