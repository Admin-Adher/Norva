'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMp4SizeEvidence } = require('../services/media-gateway/src/mp4-size-evidence');
function box(type, size, large = false) {
    const b = Buffer.alloc(large ? 16 : 8);
    b.writeUInt32BE(large ? 1 : size, 0); b.write(type, 4, 'ascii');
    if (large) b.writeBigUInt64BE(BigInt(size), 8);
    return b;
}
function fixture(declared = 80) {
    const b = Buffer.alloc(100);
    box('ftyp', 20).copy(b); box('mdat', declared).copy(b, 20);
    return b;
}
test('actual truncated layout: metadata can be skipped without retaining its payload', () => {
    const check = createMp4SizeEvidence(702299602);
    assert.equal(check.observe(0, box('ftyp', 32)), null);
    assert.equal(check.observe(32, box('moov', 7056781)), null);
    assert.equal(check.observe(7056813, box('free', 8)), null);
    assert.deepEqual(check.observe(7056821, box('mdat', 1374002438)), {
        code: 'MP4_DECLARED_MEDIA_EXCEEDS_FILE', fileSizeBytes: 702299602,
        boxOffsetBytes: 7056821, declaredEndBytes: '1381059259' });
});
test('fragmented transport headers detect the same defect', () => {
    const check = createMp4SizeEvidence(100), bytes = fixture(81);
    let result;
    for (let p = 0; p < bytes.length; p++) result = check.observe(p, bytes.subarray(p, p + 1));
    assert.equal(result.code, 'MP4_DECLARED_MEDIA_EXCEEDS_FILE');
});
test('valid, EOF-sized, and extended-sized media boxes are not rejected', () => {
    for (const size of [80, 0]) assert.equal(createMp4SizeEvidence(100).observe(0, fixture(size)), null);
    const bytes = fixture(); box('mdat', 80, true).copy(bytes, 20);
    assert.equal(createMp4SizeEvidence(100).observe(0, bytes), null);
});
test('extended size is compared without integer rounding', () => {
    const bytes = fixture(); box('mdat', 2n ** 60n, true).copy(bytes, 20);
    assert.equal(createMp4SizeEvidence(100).observe(0, bytes).declaredEndBytes, '1152921504606846996');
});
test('missing initial headers, payload signatures and other formats are inconclusive', () => {
    assert.equal(createMp4SizeEvidence(100).observe(20, box('mdat', 500)), null);
    const bytes = fixture(); box('mdat', 500).copy(bytes, 40);
    assert.equal(createMp4SizeEvidence(100).observe(0, bytes), null);
    bytes.write('RIFF', 4);
    assert.equal(createMp4SizeEvidence(100).observe(0, bytes), null);
});
test('incomplete and malformed boxes never become proof of truncation', () => {
    for (const bad of [4, 120]) {
        const bytes = fixture(); box('moov', bad).copy(bytes, 20);
        assert.equal(createMp4SizeEvidence(100).observe(0, bytes), null);
    }
    assert.equal(createMp4SizeEvidence(100).observe(0, fixture(81).subarray(0, 24)), null);
});

test('bounded top-level metadata boundary survives split headers without claiming completeness', () => {
    const check = createMp4SizeEvidence(1000);
    const bytes = Buffer.alloc(32);
    box('ftyp', 20).copy(bytes); box('moov', 300).copy(bytes, 20);
    check.observe(0, bytes.subarray(0, 24));
    assert.equal(check.metadataEnd(), null);
    assert.equal(check.observe(24, bytes.subarray(24)), null);
    assert.equal(check.metadataEnd(), 320);
});

test('payload signatures, missing headers and oversized metadata do not plan initial reads', () => {
    const missing = createMp4SizeEvidence(1000);
    missing.observe(20, box('moov', 300));
    assert.equal(missing.metadataEnd(), null);
    const big = createMp4SizeEvidence(20 * 1024 * 1024);
    big.observe(0, box('ftyp', 20)); big.observe(20, box('moov', 9 * 1024 * 1024));
    assert.equal(big.metadataEnd(), null);
    const payload = createMp4SizeEvidence(100);
    const bytes = fixture(); box('moov', 16).copy(bytes, 40);
    payload.observe(0, bytes);
    assert.equal(payload.metadataEnd(), null);
});
