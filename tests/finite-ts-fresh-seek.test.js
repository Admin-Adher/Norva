'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { crc32 } = require('../services/media-gateway/src/finite-ts-landmarks');
const { TsSeekHints, scanTsWindow, findFreshTsSeek } = require('../services/media-gateway/src/finite-ts-fresh-seek');

function fixture({ noIdr = false, audioGap = false, clockJump = false, audioLagSeconds = 0 } = {}) {
    const packets = [], cc = new Map();
    const packet = (pid, payload) => {
        const b = Buffer.alloc(188, 255);
        b[0] = 71; b[1] = 64 | (pid >> 8); b[2] = pid & 255; b[3] = 16 | (cc.get(pid) || 0);
        cc.set(pid, ((cc.get(pid) || 0) + 1) & 15); payload.copy(b, 4); packets.push(b);
    };
    const psi = raw => {
        const b = Buffer.concat([Buffer.from(raw), Buffer.alloc(4)]);
        b.writeUInt32BE(crc32(b.subarray(0, -4)), b.length - 4); return Buffer.concat([Buffer.from([0]), b]);
    };
    const pat = psi([0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0]);
    const pmt = psi([2,0xb0,23,0,1,0xc1,0,0,0xe1,0,0xf0,0,0x1b,0xe1,0,0xf0,0,15,0xe1,1,0xf0,0]);
    for (let frame = 0; frame < 1200; frame++) {
        const pts = 126000 + frame * 9000 + (clockJump && frame >= 650 ? 1800000 : 0);
        const timestamp = value => Buffer.from([0x21 | (Math.floor(value / 2 ** 30) << 1), Math.floor(value / 2 ** 22) & 255,
            ((Math.floor(value / 2 ** 15) & 127) << 1) | 1, Math.floor(value / 128) & 255, ((value & 127) << 1) | 1]);
        const stamp = timestamp(pts);
        packet(0, pat); packet(4096, pmt);
        const idr = !noIdr && frame % 20 === 0;
        packet(256, Buffer.concat([Buffer.from([0,0,1,0xe0,0,0,0x80,0x80,5]), stamp,
            Buffer.from(idr ? [0,0,1,0x67,9,0,0,1,0x68,9,0,0,1,0x65,9] : [0,0,1,0x41,9])]));
        packet(audioGap && frame >= 500 && frame < 1100 ? 8191 : 257,
            Buffer.concat([Buffer.from([0,0,1,0xc0,0,0,0x80,0x80,5]), timestamp(pts + audioLagSeconds * 90000)]));
        for (let j = 0; j < 20; j++) packet(8191, Buffer.alloc(0));
    }
    return Buffer.concat(packets);
}
const origin = async () => ({ startSeconds: 1.4, videoPid: 256, audioPid: 257 });
const scope = size => ({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://private.invalid/file', fileSizeBytes: size });
async function seek(data, options = {}) {
    const ranges = [];
    const result = await findFreshTsSeek({ seconds: 80, durationSeconds: 120, fileSizeBytes: data.length,
        probeOrigin: origin, read: async (a, b) => { ranges.push([a, b]); return data.subarray(a, b + 1); }, ...options });
    return { result, ranges };
}
test('fresh complete windows prove an IDR, both audio sides and the requested absolute clock', async () => {
    const data = fixture(), { result, ranges } = await seek(data);
    assert.equal(result.reason, 'fresh-point'); assert.ok(result.point);
    assert.equal(result.point.absoluteSeconds, 81.4);
    assert.ok(result.point.absoluteSeconds - result.point.pts / 90000 >= 2);
    assert.equal(ranges.length, 3); assert.equal(ranges[0][0], 0);
    assert.equal(data[result.point.byteOffset], 71);
    assert.ok(result.bytes <= 3 * 1024 * 1024);
});
test('a misleading historical hint is corrected from fresh clocks, never accepted as playback evidence', async () => {
    const data = fixture(), { result, ranges } = await seek(data, { hints: { estimate: () => 500000 } });
    assert.equal(ranges.length, 4); assert.equal(result.reason, 'fresh-point');
    assert.ok(result.point.pts / 90000 > 60);
});
test('a short sample without a complete program header is retried at the same position', async () => {
    const data = fixture(), ranges = [];
    const { result } = await seek(data, { read: async (a, b) => {
        ranges.push([a, b]);
        return ranges.length === 3 ? Buffer.alloc(b - a + 1) : data.subarray(a, b + 1);
    } });
    assert.equal(result.reason, 'fresh-point');
    assert.equal(ranges[2][0], ranges[3][0]);
    assert.ok(ranges[3][1] - ranges[3][0] > ranges[2][1] - ranges[2][0]);
});
test('one-second preroll is limited to freshly identified AAC with clean A/V around the IDR', async () => {
    const data = fixture();
    const run = codec => seek(data, { seconds: 81.3, hints: { estimate: () => Math.floor(data.length * 79 / 120 / 188) * 188 },
        probeOrigin: async () => ({ ...await origin(), audioCodec: codec }) });
    const aac = (await run('aac')).result, mp3 = (await run('mp3')).result;
    assert.equal(aac.reason, 'fresh-point');
    assert.ok(aac.point.absoluteSeconds - aac.point.pts / 90000 >= 1);
    assert.ok(aac.point.absoluteSeconds - aac.point.pts / 90000 < 2);
    assert.ok(mp3.point.absoluteSeconds - mp3.point.pts / 90000 >= 2);
});
test('fresh AAC shortly after the IDR is valid only when decoded audio precedes the trim target', async () => {
    const run = lag => {
        const data = fixture({ audioLagSeconds: lag });
        return seek(data, { seconds: 78.3, hints: { pointHint: () => 760 * 24 * 188 },
            probeOrigin: async () => ({ ...await origin(), audioCodec: 'aac' }) });
    };
    const near = (await run(0.2)).result, late = (await run(0.6)).result;
    assert.equal(near.reason, 'fresh-point');
    assert.equal(near.point.pts / 90000, 77.4);
    assert.ok(!late.point || late.point.pts < near.point.pts, 'a 600ms audio gap cannot authorize this point');
});
test('complete assembled reads retain temporal hints and admit only nearby future searches', async () => {
    const data = fixture(), store = new TsSeekHints(), handle = store.begin(scope(data.length));
    assert.equal(handle.hasNearby(80), false);
    await seek(data, { hints: handle });
    assert.equal(handle.hasNearby(80), true);
    assert.equal(handle.hasNearby(1000), false);
    assert.ok(handle.pointHint(81.4) > 0);
});
test('the exact old point is rediscovered in current bytes without a duration-search tail read', async () => {
    const data = fixture(), store = new TsSeekHints(), handle = store.begin(scope(data.length));
    handle.observe({ start: 0, bytes: data.subarray(0, 262144) });
    const at = 740 * 24 * 188;
    handle.observe({ start: at, bytes: data.subarray(at, at + 2 * 1024 * 1024) });
    const { result, ranges } = await seek(data, { hints: handle });
    assert.equal(result.reason, 'fresh-witness'); assert.ok(result.point);
    assert.equal(ranges.length, 2);
    assert.ok(ranges.every(([a]) => a < data.length - 262144));
    assert.equal(result.point.packetOffset, handle.pointWitness(81.4).packetOffset);
});
test('a changed historical IDR clock and incomplete fresh window cannot authorize the witness', async () => {
    const data = fixture(), store = new TsSeekHints(), handle = store.begin(scope(data.length));
    handle.observe({ start: 0, bytes: data.subarray(0, 262144) });
    const at = 740 * 24 * 188;
    handle.observe({ start: at, bytes: data.subarray(at, at + 2 * 1024 * 1024) });
    const witness = handle.pointWitness(81.4); assert.ok(witness);
    const changed = await seek(data, { hints: { pointWitness: () => ({ ...witness, pts: witness.pts + 1 }) } });
    assert.equal(changed.result.reason, 'witness-unverified'); assert.equal(changed.result.point, null);
    const partial = await seek(data, { hints: handle, read: async (a, b) => data.subarray(a, b + 1 - (a ? 1 : 0)) });
    assert.equal(partial.result.point, null); assert.equal(partial.result.reason, 'witness-unverified');
});
test('bounded frame-clock thinning does not hide an intact nearby IDR witness', () => {
    const data = fixture(), store = new TsSeekHints(), handle = store.begin(scope(data.length));
    handle.observe({ start: 0, bytes: data.subarray(0, 262144) });
    const at = 740 * 24 * 188;
    handle.observe({ start: at, bytes: data.subarray(at, at + 2 * 1024 * 1024) });
    const entry = [...store.entries.values()][0];
    entry.clocks = entry.clocks.filter(c => Math.abs(c.pts / 90000 - entry.originHint - 80) > 30);
    assert.ok(handle.pointWitness(81.4)); assert.equal(handle.hasNearby(80), true);
    assert.ok(handle.describe(80).nearestSeconds < 5);
    entry.points = []; assert.equal(handle.hasNearby(80), false);
});
test('unsupported clocks, missing audio and missing IDRs retain ordinary seeking', async () => {
    for (const data of [fixture({ audioGap: true }), fixture({ noIdr: true }), fixture({ clockJump: true })]) {
        const { result } = await seek(data); assert.equal(result.point, null);
    }
    const { result } = await seek(fixture(), { durationSeconds: 150 });
    assert.equal(result.reason, 'duration-unverified'); assert.equal(result.point, null);
});
test('wrong current graph, malformed transport and incomplete windows cannot authorize a point', async () => {
    const data = fixture();
    for (const defect of ['partial', 'corrupt', 'wrong-pid']) {
        const { result } = await seek(data, {
            ...(defect === 'wrong-pid' ? { probeOrigin: async () => ({ startSeconds: 1.4, videoPid: 42, audioPid: 257 }) } : {}),
            read: async (a, b) => {
                const bytes = Buffer.from(data.subarray(a, b + 1));
                if (a > 300000 && defect === 'partial') return bytes.subarray(0, -1);
                if (a > 300000 && defect === 'corrupt') bytes.fill(0, 2000, 3000);
                return bytes;
            },
        });
        assert.equal(result.point, null, defect);
    }
});
test('cancellation propagates and elapsed budget prevents more position reads', async () => {
    const data = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(seek(data, { signal: controller.signal }), { name: 'AbortError' });
    let clock = 0;
    const { result } = await seek(data, { maxMs: 6500, now: () => clock, read: async (a, b) => { clock += 4000; return data.subarray(a, b + 1); } });
    assert.equal(result.point, null); assert.equal(result.reason, 'budget'); assert.equal(result.reads, 2);
});
test('hints contain metadata only and remain bounded, private to the account and short lived', () => {
    const data = fixture(); let clock = 0;
    const store = new TsSeekHints({ now: () => clock }), handle = store.begin(scope(data.length));
    handle.observe({ start: 0, bytes: data.subarray(0, 2 * 1024 * 1024) });
    assert.ok(handle.estimate(25, data.length / 120) > 0);
    assert.ok(handle.pointHint(25) > 0);
    assert.equal(handle.hasNearby(25), true);
    assert.equal(store.begin({ ...scope(data.length), ownerKey: 'b'.repeat(64) }).estimate(25, 10000), null);
    assert.equal(store.begin({ ...scope(data.length), sourceUrl: 'https://other.invalid/file' }).estimate(25, 10000), null);
    for (let i = 0; i < 30; i++) store.begin({ ...scope(data.length), sourceUrl: String(i) })
        .observe({ start: 0, bytes: data.subarray(0, 262144) });
    assert.ok(store.entries.size <= 16);
    assert.ok(!JSON.stringify([...store.entries]).includes('private.invalid'));
    clock = 600001; assert.equal(handle.estimate(25, 10000), null);
    assert.equal(handle.pointHint(25), null);
    assert.equal(handle.hasNearby(25), false);
    assert.equal(scanTsWindow(0, Buffer.alloc(100)), null);
});
