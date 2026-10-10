'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMp4CoverageIndex: parse, indexedByteCoverage: coverage } = require('../services/media-gateway/src/mp4-indexed-byte-coverage');
const words = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return b; };
const box = (name, ...parts) => { const body = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(name, 4); return Buffer.concat([head, body]); };
function fixture({ multipleAudio = false, fragmented = false, edit = 0, size = 10, co64 = false } = {}) {
    function track(kind, offset) {
        const hdlr = Buffer.alloc(12); hdlr.write(kind, 8);
        let chunks = words(0, 1, offset);
        if (co64) { chunks = Buffer.alloc(16); chunks.writeUInt32BE(1, 4); chunks.writeBigUInt64BE(BigInt(offset), 8); }
        return box('trak', ...(edit ? [box('edts', box('elst', words(0, 1, 4000, edit, 65536)))] : []),
            box('mdia', box('mdhd', words(0, 0, 0, 1000, 4000)), box('hdlr', hdlr),
                box('minf', box('stbl', box('stts', words(0, 1, 4, 1000)), box('stsz', words(0, size, 4)),
                    box(co64 ? 'co64' : 'stco', chunks), box('stsc', words(0, 1, 1, 4, 1)),
                    ...(kind === 'vide' ? [box('stss', words(0, 2, 1, 3))] : [])))));
    }
    return box('moov', track('vide', 100), track('soun', 200), ...(multipleAudio ? [track('soun', 300)] : []), ...(fragmented ? [box('mvex')] : []));
}
test('requires complete bytes for both tracks, includes preceding video sync sample', () => {
    const index = parse(fixture(), 1000);
    const proof = coverage(index, [{ start: 100, end: 139 }, { start: 200, end: 239 }], 1.5);
    assert.equal(proof.secondsAhead, 2.5);
    assert.equal(proof.tracks[0].coveredFrom, 0);
    assert.equal(proof.evidence, 'indexed-dts-bytes-only');
});
test('partial sample and a missing audio byte stop coverage', () => {
    const index = parse(fixture(), 1000);
    assert.equal(coverage(index, [{ start: 100, end: 139 }, { start: 210, end: 238 }], 1.5).secondsAhead, 1.5);
    assert.equal(coverage(index, [{ start: 110, end: 139 }, { start: 200, end: 239 }], 1.5).secondsAhead, 0);
});
test('adjacent ranges merge but holes remain holes', () => {
    const index = parse(fixture(), 1000);
    assert.equal(coverage(index, [{ start: 100, end: 119 }, { start: 120, end: 139 }, { start: 200, end: 239 }], 1.5).secondsAhead, 2.5);
    assert.equal(coverage(index, [{ start: 100, end: 119 }, { start: 121, end: 139 }, { start: 200, end: 239 }], 1.5).secondsAhead, 0.5);
});
test('single normal edit shifts media time and 64-bit offsets are accepted', () => {
    const index = parse(fixture({ edit: 1000, co64: true }), 1000);
    assert.equal(coverage(index, [{ start: 100, end: 239 }], 0.5).secondsAhead, 2.5);
});
test('ambiguous tracks, fragments, truncation and out-of-file samples fail closed', () => {
    assert.equal(parse(fixture({ multipleAudio: true }), 1000), null);
    assert.equal(parse(fixture({ fragmented: true }), 1000), null);
    assert.equal(parse(fixture().subarray(0, -1), 1000), null);
    assert.equal(parse(fixture({ size: 300 }), 1000), null);
});
test('invalid ranges and target do not produce evidence', () => {
    const index = parse(fixture(), 1000);
    assert.equal(coverage(index, [{ start: 0, end: 1000 }], 0), null);
    assert.equal(coverage(index, [], -1), null);
    assert.equal(coverage(index, [null], 0), null);
    assert.equal(coverage(null, [], 0), null);
});
test('malicious table counts and duplicate required boxes fail closed', () => {
    const bytes = fixture();
    const bad = Buffer.from(bytes), at = bad.indexOf(Buffer.from('stts'));
    bad.writeUInt32BE(0xffffffff, at + 8);
    assert.equal(parse(bad, 1000), null);
    const trak = box('trak', box('mdia', box('hdlr', words(0, 0, 0)), box('hdlr', words(0, 0, 0))));
    assert.equal(parse(box('moov', trak), 1000), null);
});
