'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { ResumePlaylistClock } = require('../services/media-gateway/src/private-resume-playlist-clock');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { createHlsOutputAdmission } = require('../services/media-gateway/src/hls-output-admission');
const playlist = (sequence, durations, extra = '') => '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + `#EXT-X-MEDIA-SEQUENCE:${sequence}\n${extra}`
    + durations.map((d, i) => `#EXTINF:${d.toFixed(6)},\nsegment-${String(sequence + i).padStart(5, '0')}.ts\n`).join('');

test('rolling origin follows exact published durations, including variable segment lengths', () => {
    const clock = new ResumePlaylistClock();
    assert.equal(clock.observe('playlist.m3u8', playlist(0, [2.125, 3.75, 4])), true);
    const moved = playlist(1, [3.75, 4, 2.5]);
    assert.equal(clock.observe('playlist.m3u8', moved), true);
    assert.equal(clock.originFor('playlist.m3u8', moved), 2.125);
    const next = playlist(3, [2.5, 6]);
    assert.equal(clock.observe('playlist.m3u8', next), true);
    assert.equal(clock.originFor('playlist.m3u8', next), 9.875);
    assert.equal(clock.originFor('playlist.m3u8', moved), null, 'old or mismatching snapshot is not attested');
    assert.equal(clock.originFor('video.m3u8', next), null, 'other rendition clock is not interchangeable');
    assert.equal(clock.originFor('playlist.m3u8', next + '#EXT-X-ENDLIST\n'), 9.875);
});

test('an exactly adjacent window is anchored only when all intervening durations were published', () => {
    const clock = new ResumePlaylistClock();
    clock.observe('video.m3u8', playlist(0, [2.125, 3.75]));
    const next = playlist(2, [4, 5]);
    assert.equal(clock.observe('video.m3u8', next), true);
    assert.equal(clock.originFor('video.m3u8', next), 5.875);
});

for (const [reason, broken] of [
    ['gap', playlist(4, [2, 2])],
    ['changed overlap duration', playlist(1, [3, 2, 2])],
    ['changed overlap name', playlist(1, [2, 2, 2]).replace('segment-00001', 'video-00001')],
    ['truncation', playlist(0, [2])],
    ['discontinuity', playlist(1, [2, 2], '#EXT-X-DISCONTINUITY\n')],
    ['duplicate sequence', playlist(1, [2, 2], '#EXT-X-MEDIA-SEQUENCE:1\n')],
    ['invalid sequence', playlist(1, [2, 2]).replace('SEQUENCE:1', 'SEQUENCE:1e0')],
]) test(`clock rejects ${reason} and cannot recover on this producer`, () => {
    const clock = new ResumePlaylistClock();
    clock.observe('playlist.m3u8', playlist(0, [2, 2, 2]));
    assert.equal(clock.observe('playlist.m3u8', broken), false);
    assert.equal(clock.originFor('playlist.m3u8', broken), null);
    assert.equal(clock.observe('playlist.m3u8', playlist(0, [2, 2, 2])), false);
});

test('late attachment, rollback, oversized history and nonvideo names cannot invent a clock', () => {
    const late = new ResumePlaylistClock();
    assert.equal(late.observe('playlist.m3u8', playlist(100, [2, 2])), false);
    const clock = new ResumePlaylistClock();
    clock.observe('playlist.m3u8', playlist(0, [2, 2]));
    clock.observe('playlist.m3u8', playlist(1, [2, 2]));
    assert.equal(clock.observe('playlist.m3u8', playlist(0, [2, 2])), false);
    assert.equal(clock.observe('subtitle_0.m3u8', playlist(0, [2])), false);
    assert.equal(clock.observe('audio_0.m3u8', playlist(0, [2])), false);
    assert.equal(new ResumePlaylistClock().observe('playlist.m3u8', playlist(0, Array(513).fill(2))), false);
});

test('long playback retains a bounded clock and a new producer starts independently', () => {
    const clock = new ResumePlaylistClock();
    for (let i = 0; i < 2000; i++) assert.equal(clock.observe('video.m3u8', playlist(i, Array(4).fill(2.125))), true);
    assert.equal(clock.originFor('video.m3u8', playlist(1999, Array(4).fill(2.125))), 1999 * 2.125);
    assert.equal(clock.states.size, 1);
    assert.equal(clock.states.get('video.m3u8').segments.length, 4);
    assert.equal(new ResumePlaylistClock().originFor('video.m3u8', playlist(1999, Array(4).fill(2.125))), null);
});

const ownerKey = 'a'.repeat(64);
const binding = privateResumeBinding({ ownerKey, sourceUrl: 'https://provider.invalid/movie/fixture.mkv',
    sourceId: 'source-a', sourceRevision: '1', fileSizeBytes: 1_000_000, profile: 'audio=1' });
const observed = { fileSizeBytes: 1_000_000, validator: { kind: 'etag', value: '"fixture-v1"' },
    effectiveUrlIdentitySha256: 'b'.repeat(64) };

test('a captured rolling window resumes at the original source position and retains one splice', async () => {
    const cache = new PrivateResumeHlsCache(), clock = new ResumePlaylistClock();
    const initial = playlist(0, Array(20).fill(4)), current = playlist(10, Array(20).fill(4));
    clock.observe('playlist.m3u8', initial); clock.observe('playlist.m3u8', current);
    const args = { binding, observed, position: 154, actualStartOffset: 100, playlist: current,
        readAsset: async name => Buffer.from(name), playlistClock: clock };
    assert.equal(await cache.capture({ ...args, playlistClock: null }), false);
    assert.equal(cache.publicStatus().lastCaptureRejection, 'sliding-playlist-unbound-clock');
    assert.equal(await cache.capture(args), true);
    const lease = cache.acquire(binding, 154, observed);
    assert.equal(lease.start, 148); assert.equal(lease.end, 204);
    assert.equal(lease.asset('resume-0.ts').toString(), 'segment-00012.ts');
    assert.equal((lease.playlist(playlist(0, [2, 2])).match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
    lease.release();
    assert.equal(cache.acquire(binding, 154, { ...observed, validator: { kind: 'etag', value: '"changed"' } }), null);
});

function put(url, body, method = 'PUT') {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers: { Expect: '100-continue', 'Content-Length': Buffer.byteLength(body) } },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('continue', () => req.end(body)); req.on('error', reject); req.flushHeaders();
    });
}

test('optional resume files stay within both their allowance and the unchanged writer reservation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-retain-test-'));
    let admission;
    try {
        admission = await createHlsOutputAdmission({ root, maxBytes: 4096, resumeRetentionBytes: 1024,
            onFailure: () => assert.fail('retention must not break the ordinary writer') });
        for (let i=0;i<4;i++) {
            assert.equal(await put(admission.urlFor(`segment-${String(i).padStart(5,'0')}.ts`), Buffer.alloc(400)),200);
        }
        assert.equal(await put(admission.urlFor('playlist.m3u8'), playlist(0,[2,2,2,2])),200);
        assert.equal(await put(admission.urlFor('playlist.m3u8'), playlist(2,[2,2])),200);
        for (let i=0;i<2;i++) assert.equal(await put(admission.urlFor(`segment-${String(i).padStart(5,'0')}.ts`),'','DELETE'),200);
        assert.equal(admission.snapshot().resumeRetainedBytes,800);
        assert.equal((await fs.readFile(path.join(root,'segment-00000.ts'))).length,400);
        // This new current segment fits only if the optional old files are
        // evicted before writing its body. There is never a second disk budget.
        assert.equal(await put(admission.urlFor('segment-00004.ts'),Buffer.alloc(2800)),200);
        assert.equal(admission.snapshot().resumeRetainedBytes,0);
        assert.ok(admission.snapshot().bytes<=4096);
        assert.equal(admission.snapshot().stopped,false);
        await assert.rejects(fs.readFile(path.join(root,'segment-00000.ts')), {code:'ENOENT'});
    } finally {
        await admission?.stop(); assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
        await fs.rm(root,{recursive:true,force:true});
    }
});

test('real admitted writer attests only atomic publication and retains the clock after ordinary stop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-clock-test-'));
    let admission, published = 0;
    const io = { ...fs, rename: async (from, to) => {
        assert.equal(admission.resumePlaylistClock.originFor('playlist.m3u8', published === 0
            ? playlist(0, [2, 3, 4]) : playlist(1, [3, 4, 5])), null, 'not attested before rename');
        await fs.rename(from, to); published++;
    } };
    try {
        admission = await createHlsOutputAdmission({ root, io, onFailure: () => assert.fail('writer failed') });
        assert.equal(await put(admission.urlFor('playlist.m3u8'), playlist(0, [2, 3, 4])), 200);
        const current = playlist(1, [3, 4, 5]);
        assert.equal(await put(admission.urlFor('playlist.m3u8'), current), 200);
        assert.equal(admission.resumePlaylistClock.originFor('playlist.m3u8', await fs.readFile(path.join(root, 'playlist.m3u8'), 'utf8')), 2);
        await admission.stop();
        assert.equal(admission.resumePlaylistClock.originFor('playlist.m3u8', current), 2);
        assert.equal(published, 2);
    } finally {
        await admission?.stop();
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        await fs.rm(root, { recursive: true, force: true });
    }
});
