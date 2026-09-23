const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedEncoderSlots, encoderSlotWeight } = require('../services/media-gateway/src/shared-encoder-slots');
test('separate gateways share the same encoder budget; unknown leases are retained', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-encoder-test-'));
    try {
        const a = createSharedEncoderSlots(root, 2), b = createSharedEncoderSlots(root, 2);
        const first = a.acquire(), second = b.acquire();
        assert(first && second); assert.equal(a.acquire(), null); assert.equal(b.acquire(), null);
        first.release(); first.release(); const replacement = b.acquire(); assert(replacement);
        assert.equal(a.snapshot().occupied, 2); replacement.release(); second.release();
        fs.mkdirSync(path.join(root, 'slot-0')); fs.mkdirSync(path.join(root, 'slot-1'));
        assert.equal(a.acquire(), null);
    } finally { fs.rmSync(root, { force: true, recursive: true }); }
});
test('4K and high frame rates spend measured FHD capacity units; failed weighted admission releases its partial claim', () => {
    assert.equal(encoderSlotWeight({ videoWidth: 3840, videoHeight: 2160 }), 4);
    assert.equal(encoderSlotWeight({ videoWidth: 1920, videoHeight: 1080, videoFrameRateNumerator: 60, videoFrameRateDenominator: 1 }), 2);
    assert.equal(encoderSlotWeight({}), 4);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-encoder-weight-'));
    try {
        const pool = createSharedEncoderSlots(root, 8), hd = pool.acquire(1), uhd = pool.acquire(4);
        assert(hd && uhd); assert.equal(pool.acquire(4), null); assert.equal(pool.snapshot().occupied, 5);
        hd.release(); const secondUhd = pool.acquire(4); assert(secondUhd); uhd.release(); secondUhd.release();
        assert.equal(pool.snapshot().occupied, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
