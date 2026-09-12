'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FiniteTsSeekIndex, indexedTsInputUrl, proofHash } = require('../services/media-gateway/src/finite-ts-seek-index');
const { TsLandmarks, crc32 } = require('../services/media-gateway/src/finite-ts-landmarks');
const proof = size => ({ fileSizeBytes: size, validator: { kind: 'etag', value: '"v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) });
function fixture({ splitGraph = false, discontinuity = false } = {}) {
    const packets = [], counters = new Map();
    const packet = (pid, payload, flags = 0) => {
        const b = Buffer.alloc(188, 255), cc = counters.get(pid) || 0; counters.set(pid, (cc + 1) & 15);
        b[0] = 0x47; b[1] = 64 | (pid >> 8); b[2] = pid & 255; b[3] = 16 | cc;
        if (flags) { b[3] |= 32; b[4] = 1; b[5] = flags; }
        payload.copy(b, flags ? 6 : 4); packets.push(b);
    };
    const psi = input => { const b = Buffer.concat([Buffer.from(input), Buffer.alloc(4)]); b.writeUInt32BE(crc32(b.subarray(0, -4)), b.length - 4); return Buffer.concat([Buffer.from([0]), b]); };
    const pat = psi([0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0]);
    const pmt = psi([2,0xb0,23,0,1,0xc1,0,0,0xe1,0,0xf0,0,0x1b,0xe1,0,0xf0,0,15,0xe1,1,0xf0,0]);
    for (let second = 0; second <= 120; second++) {
        packet(0, pat); packet(4096, pmt);
        const pts = (second + 1.4) * 90000;
        const time = Buffer.from([0x21 | (Math.floor(pts / 2 ** 30) << 1),
            Math.floor(pts / 2 ** 22) & 255, ((Math.floor(pts / 2 ** 15) & 127) << 1) | 1,
            Math.floor(pts / 128) & 255, ((pts & 127) << 1) | 1]);
        const nal = second % 12 === 0 ? [0,0,1,0x67,9,0,0,1,0x68,9,0,0,1,0x65,9] : [0,0,1,0x41,9];
        packet(256, Buffer.concat([Buffer.from([0,0,1,0xe0,0,0,0x80,0x80,5]), time, Buffer.from(nal)]), discontinuity && second === 50 ? 128 : 0);
    }
    const data = Buffer.concat(packets);
    if (splitGraph) data[188 + 20] = 0; // break CRC, not a fake trusted alternate map
    return data;
}
const origin = async () => ({ startSeconds: 1.4, videoPid: 256, audioPid: 257 });
function scoped(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-seek-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return new FiniteTsSeekIndex({ root, probeOrigin: origin, ...options });
}
test('passive index records complete SPS/PPS/IDR points across arbitrarily split HTTP chunks', () => {
    const data = fixture(), points = [], invalid = [];
    const parser = new TsLandmarks({ onPoint: p => points.push(p), onInvalid: () => invalid.push(true) });
    for (let at = 0; at < data.length; at += 5003) parser.push(at, data.subarray(at, at + 5003));
    assert.equal(invalid.length, 0); assert.equal(points.length, 10);
    assert.equal(points[5].pts / 90000, 61.4); assert.ok(points.every(p => data[p.byteOffset] === 0x47));
});
test('initial playback prepares a first seek; metadata survives a new process and needs current proof', async t => {
    const data = fixture(), store = scoped(t), scope = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://private.invalid/u/p/file', fileSizeBytes: data.length };
    const observer = await store.begin(scope);
    observer.observe({ start: 0, bytes: data, proof: proof(data.length) }); await observer.close();
    assert.ok(observer.candidate(87));
    const restarted = new FiniteTsSeekIndex({ root: store.root, probeOrigin: origin });
    const next = await restarted.begin(scope);
    assert.equal(next.hasCandidate(87), true); assert.equal(next.candidate(87), null);
    next.observe({ start: 0, bytes: data.subarray(0, 188 * 30), proof: proof(data.length) });
    const point = next.candidate(87); assert.ok(point); assert.ok(point.absoluteSeconds - point.pts / 90000 >= 2);
    assert.equal(indexedTsInputUrl('http://127.0.0.1:9876/finite-mkv-seek/' + 'A'.repeat(43), point, data.length),
        `subfile,,start,${point.byteOffset},end,${data.length},,:http://127.0.0.1:9876/finite-mkv-seek/${'A'.repeat(43)}`);
    await next.close();
    const text = fs.readFileSync(path.join(store.root, fs.readdirSync(store.root)[0]), 'utf8');
    assert.ok(!text.includes('private.invalid') && !text.includes('u/p/') && !text.includes('"v1"'));
    assert.equal(store.status().mediaBytesPersisted, 0);
});
for (const defect of ['weak', 'changed', 'target', 'size', 'owner', 'source', 'expired', 'corrupt', 'symlink']) {
    test(`persistent navigation rejects ${defect} evidence`, async t => {
        const data = fixture(), store = scoped(t), scope = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://one.invalid/file', fileSizeBytes: data.length };
        const observer = await store.begin(scope); observer.observe({ start: 0, bytes: data, proof: proof(data.length) }); await observer.close();
        const file = path.join(store.root, fs.readdirSync(store.root)[0]);
        if (defect === 'corrupt') fs.appendFileSync(file, 'broken');
        if (defect === 'symlink') {
            try { fs.symlinkSync(file, path.join(store.root, 'test-link')); } catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error; }
            fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file);
        }
        const fresh = new FiniteTsSeekIndex({ root: store.root, probeOrigin: origin,
            now: defect === 'expired' ? () => Date.now() + 8 * 86400000 : Date.now });
        const nextScope = { ...scope, ...(defect === 'owner' ? { ownerKey: 'c'.repeat(64) } : {}),
            ...(defect === 'source' ? { sourceUrl: 'https://two.invalid/file' } : {}) };
        const next = await fresh.begin(nextScope), p = proof(data.length);
        if (defect === 'weak') p.validator.value = 'W/"v1"';
        if (defect === 'changed') p.validator.value = '"v2"';
        if (defect === 'target') p.effectiveUrlIdentitySha256 = 'c'.repeat(64);
        if (defect === 'size') p.fileSizeBytes++;
        next.observe({ start: 0, bytes: data.subarray(0, 188 * 30), proof: p });
        assert.equal(next.candidate(87), null); await next.close();
    });
}
test('unseen gaps, timestamp discontinuities and malformed PSI cannot become precise seek points', async t => {
    const data = fixture(), store = scoped(t), scope = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://one.invalid/file', fileSizeBytes: data.length };
    const observer = await store.begin(scope);
    observer.observe({ start: 0, bytes: data.subarray(0, 188 * 30), proof: proof(data.length) });
    observer.observe({ start: 188 * 120, bytes: data.subarray(188 * 120), proof: proof(data.length) });
    await observer.close(); assert.equal(observer.candidate(87), null);
    for (const bad of [fixture({ discontinuity: true }), fixture({ splitGraph: true })]) {
        const other = await store.begin({ ...scope, sourceUrl: scope.sourceUrl + Math.random() });
        other.observe({ start: 0, bytes: bad, proof: proof(bad.length) }); await other.close();
        assert.equal(other.candidate(87), null);
    }
});
test('index path is loopback-only and weak identity cannot authorize a byte slice', () => {
    assert.equal(proofHash(proof(123), 124), null);
    assert.equal(proofHash({ ...proof(123), validator: {kind:'last-modified',value:'today'} }, 123), null);
    const point = { byteOffset: 188, packetOffset: 376, pts: 1e6, dts: 1e6, signature: 'a'.repeat(64), videoPid: 1, audioPid: 2 };
    for (const url of ['http://evil.invalid/finite-mkv-seek/'+'A'.repeat(43), 'http://127.0.0.1/x', 'http://127.0.0.1/finite-mkv-seek/'+'A'.repeat(43)+'?secret=1']) {
        assert.equal(indexedTsInputUrl(url,point,1000), null);
    }
});

test('metadata writes stay bounded and cleanup never removes unrelated cache files', async t => {
    const data = fixture(), store = scoped(t), scope = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://one.invalid/file', fileSizeBytes: data.length };
    const observer = await store.begin(scope); observer.observe({ start: 0, bytes: data, proof: proof(data.length) }); await observer.close();
    const base = JSON.parse(fs.readFileSync(path.join(store.root, fs.readdirSync(store.root)[0]), 'utf8'));
    delete base.digest;
    const unrelated = path.join(store.root, 'viewer-media.ts'); fs.writeFileSync(unrelated, 'keep');
    await store.save({ ...base, key: '../outside' });
    assert.equal(fs.existsSync(path.join(store.root, '../outside.json')), false);
    for (let i = 0; i < 270; i++) await store.save({ ...base, key: i.toString(16).padStart(64, '0') });
    const files = fs.readdirSync(store.root).filter(f => f.endsWith('.json'));
    assert.ok(files.length <= 256);
    assert.ok(files.reduce((n, f) => n + fs.statSync(path.join(store.root, f)).size, 0) <= store.status().maxBytes);
    store.now = () => Date.now() + 8 * 86400000;
    await store.prune(); assert.deepEqual(fs.readdirSync(store.root), ['viewer-media.ts']);
});
