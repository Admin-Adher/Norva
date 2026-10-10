'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { createPrivateStartupCache } = require('../services/media-gateway/src/private-startup-cache');
const { StartupCachePreparation } = require('../services/media-gateway/src/startup-cache-preparation');
const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://provider.invalid/movie/x/y/1.mkv',
    sourceId: 'source', sourceRevision: '1', fileSizeBytes: 10_000_000, profile: 'audio-1' });
const observed = { fileSizeBytes: 10_000_000, validator: { kind: 'etag', value: '"v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) };
const playlist = (seconds = 64) => '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:0\n'
    + Array(seconds / 4).fill(4).map((n,i) => `#EXTINF:${n},\nsegment-${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n';
const args = extra => ({ binding, observed, actualStartOffset: 0, playlist: playlist(),
    readAsset: async () => Buffer.alloc(188, 0x47), ...extra });

test('startup and resume coexist under the original budget, with no false end of film', async () => {
    const cache = new PrivateResumeHlsCache(), startup = createPrivateStartupCache(cache);
    assert.equal(await cache.capture({ ...args(), position: 5 }), true);
    assert.equal(await startup.capture(args()), true);
    assert.equal(cache.publicStatus().entries, 2);
    const resume = cache.acquire(binding, 5, observed), prefix = startup.acquire(binding, 0, observed);
    assert.ok(resume); assert.ok(prefix);
    assert.equal(prefix.start, 0); assert.equal(prefix.end, 60); assert.equal(prefix.ended, false);
    assert.doesNotMatch(prefix.playlist(), /ENDLIST/);
    assert.equal(startup.acquire(binding, 5, observed), null);
    resume.release(); prefix.release();
});

for (const [name, extra] of [
    ['short prefix', { playlist: playlist(56) }],
    ['slid prefix', { playlist: playlist().replace('SEQUENCE:0', 'SEQUENCE:1') }],
    ['nonzero video origin', { actualStartOffset: 0.1 }],
    ['missing identity', { observed: { fileSizeBytes: 10_000_000 } }],
    ['missing segment', { readAsset: async () => null }],
    ['cancelled during capture', { isCurrent: () => false }],
]) test(`startup rejects ${name}`, async () => {
    const cache = new PrivateResumeHlsCache(), startup = createPrivateStartupCache(cache);
    assert.equal(await startup.capture(args(extra)), false);
    assert.equal(cache.publicStatus().entries, 0);
    assert.equal(cache.publicStatus().reservedBytes, 0);
});

test('cancellation arriving during asset reads leaves no startup entry', async () => {
    const cache = new PrivateResumeHlsCache(), startup = createPrivateStartupCache(cache);
    let live = true;
    assert.equal(await startup.capture(args({ isCurrent: () => live, readAsset: async () => {
        live = false; return Buffer.alloc(188, 0x47);
    } })), false);
    assert.equal(cache.publicStatus().entries, 0);
});

test('background startup capture never evicts a recent viewer resume to reserve memory', async () => {
    const cache = new PrivateResumeHlsCache({ maxBytes: 128 * 1024 * 1024, perFileBytes: 64 * 1024 * 1024 }), startup = createPrivateStartupCache(cache);
    assert.equal(await cache.capture({ ...args(), position: 5 }), true);
    assert.equal(await startup.capture(args()), false);
    assert.equal(cache.hasCandidate(binding, 5), true);
    assert.equal(cache.publicStatus().evictions, 0);
});

test('an unexpired prefix skips media acquisition and reports when to revisit it', async () => {
    const h = preparation({ remainingSeconds: () => 350 });
    const result = await h.manager.prepare(h);
    assert.equal(result.prepared, true); assert.equal(result.refreshAfterSeconds, 230);
    assert.equal(h.stats().created, 0); assert.equal(h.stats().stops, 0);
});

test('startup refuses missing subtitle coverage without falling back to header-only bytes', async () => {
    const cache = new PrivateResumeHlsCache(), startup = createPrivateStartupCache(cache);
    assert.equal(await startup.capture(args({ subtitleRenditions: [{ streamIndex: 2, playlistName: 'subtitle_2.m3u8' }],
        readAsset: async name => name.endsWith('.ts') ? Buffer.alloc(188, 0x47) : null })), false);
    assert.equal(cache.publicStatus().entries, 0);
});

test('startup obeys identity, track isolation, expiry and owner revocation', async () => {
    let now = 0; const cache = new PrivateResumeHlsCache({ now: () => now, ttlMs: 1000 });
    const startup = createPrivateStartupCache(cache);
    assert.equal(await startup.capture(args()), true);
    assert.equal(startup.hasCandidate({ ...binding, ownerKey: 'c'.repeat(64) }, 0), false);
    assert.equal(startup.hasCandidate({ ...binding, profileHash: 'd'.repeat(64) }, 0), false);
    assert.equal(startup.acquire(binding, 0, { ...observed, validator: { kind: 'etag', value: '"v2"' } }), null);
    assert.equal(await startup.capture(args()), true); now = 1001;
    assert.equal(startup.hasCandidate(binding, 0), false); now = 0;
    assert.equal(await startup.capture(args()), true);
    const lease = startup.acquire(binding, 0, observed); cache.revokeOwner(binding.ownerKey);
    assert.throws(lease.assertValid, /REVOKED/); lease.release();
});

function preparation(options = {}) {
    let current = true, covered = false, stored = false, stops = 0, created = 0;
    const session = { id: 'session', status: 'ready' };
    const manager = new StartupCachePreparation({ durationMs: 2000, pollMs: 2, recheckMs: 2,
        allowsOwner: () => true, canStart: () => true, authorize: async () => current,
        sessionForId: () => session, covered: async () => covered,
        stop: async (s, job) => { stops++; if (options.drainFailure) throw Error('unconfirmed');
            s.startupCacheStored = job.complete && !job.signal.aborted; stored = s.startupCacheStored; },
        ...options });
    manager.bindSessionCreate(async (req, res) => { created++; req.startupCacheJob.session = session;
        res.status(201).json({ id: session.id }); });
    return { manager, ownerKey: binding.ownerKey, accountKey: 'private-account', body: {},
        setCurrent: value => { current = value; }, setCovered: value => { covered = value; },
        stats: () => ({ stored, stops, created }) };
}

test('preparation stores only after sixty-second proof and transport drain', async () => {
    const h = preparation(); h.setCovered(true);
    const result = await h.manager.prepare(h);
    assert.equal(result.prepared, true); assert.equal(result.seconds, 60);
    assert.equal(result.providerDrained, true); assert.equal(h.manager.status().active, 0);
    assert.equal(h.stats().stops, 1);
});

test('an occupied account or disabled owner opens no media session', async () => {
    for (const option of [{ canStart: () => false }, { allowsOwner: () => false }]) {
        const h = preparation(option), result = await h.manager.prepare(h);
        assert.equal(result.prepared, false); assert.equal(h.stats().created, 0);
    }
});

test('viewer preemption drains one preparation and never stores a short prefix', async () => {
    const h = preparation(), preparing = h.manager.prepare(h);
    await new Promise(resolve => setTimeout(resolve, 10));
    const other = await h.manager.prepare(h); assert.equal(other.prepared, false);
    const drained = await h.manager.preempt(job => job.accountKey === h.accountKey);
    assert.equal(drained.providerDrained, true); assert.equal(drained.stopped, 1);
    assert.equal((await preparing).prepared, false); assert.equal(h.stats().stored, false);
});

test('source revocation cancels preparation and an uncertain drain retains exclusion', async () => {
    const h = preparation({ drainFailure: true }), preparing = h.manager.prepare(h);
    await new Promise(resolve => setTimeout(resolve, 8)); h.setCurrent(false);
    const result = await preparing;
    assert.equal(result.prepared, false); assert.equal(result.providerDrained, false);
    assert.equal(h.manager.status().active, 1);
    assert.equal((await h.manager.preempt(() => true)).providerDrained, false);
    assert.equal((await h.manager.prepare(h)).reason, 'not-admitted');
});
