'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startupFailureDiagnostics } = require('../services/media-gateway/src/startup-diagnostics');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');

test('failed startups retain bounded timing/range evidence, never provider credentials or arbitrary data', () => {
    const unsafe = 'http://user:secret@provider.invalid/movie/credential';
    const result = startupFailureDiagnostics({ startupFailureCode: 'PLAYLIST_TIMEOUT',
        startupTimings: { firstSegmentReadyMs: 1200, slotReleaseWaitMs: 2500,
            codecProfileMs: NaN, sourceUrl: unsafe, privateToken: unsafe },
        finiteMkvSeekBroker: { providerFetches: 12, sourceUrl: unsafe,
            windowTrace: Array.from({ length: 64 }, (_, i) => ({ providerStart: i * 1000,
                providerEnd: i * 1000 + 999, bytes: 900, responseHeadersMs: 30,
                firstByteMs: 31, durationMs: 45, outcome: unsafe, url: unsafe })) } });
    assert.equal(result.code, 'PLAYLIST_TIMEOUT');
    assert.equal(result.windows.length, 12);
    assert.equal(result.windows[0].providerStart, 52000);
    assert.equal(result.windows[0].outcome, 'other');
    assert.equal(result.timings.firstSegmentReadyMs, 1200);
    assert.equal(result.broker.providerFetches, 12);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('provider.invalid'), false);
    assert.deepEqual(startupFailureDiagnostics(null).timings, {});
});

test('private byte cache exposes rejection reasons without weakening revalidation or reporting false hits', () => {
    const cache = new FinitePlaybackRangeReuse();
    const binding = { ownerKey: 'a'.repeat(64), sourceUrl: 'http://provider.invalid/private',
        fileSizeBytes: 1000, sourceId: 'source', sourceRevision: '7' };
    const identity = { validator: { kind: 'etag', value: '"file-1"' },
        fileSizeBytes: 1000, effectiveUrlIdentitySha256: 'b'.repeat(64) };
    const weak = cache.begin(binding);
    assert.equal(weak.confirm({ ...identity, validator: { kind: 'etag', value: 'W/"weak"' } }), false);
    assert.equal(weak.remember(0, Buffer.alloc(100)), false);
    weak.confirm(identity); // one rejected session must not acquire authority later
    assert.equal(cache.publicStatus().validation.rejectedIdentity, 1);
    const first = cache.begin(binding);
    assert.equal(first.confirm(identity), true);
    assert.equal(first.remember(0, Buffer.alloc(100, 19)), true);
    const second = cache.begin(binding);
    assert.equal(second.hasPriorRanges, true);
    assert.equal(second.read(0, 99), null);
    assert.equal(second.confirm(identity), true);
    assert.deepEqual(second.read(0, 99), Buffer.alloc(100, 19));
    const changed = cache.begin(binding);
    assert.equal(changed.confirm({ ...identity, validator: { kind: 'etag', value: '"file-2"' } }), false);
    assert.equal(changed.read(0, 99), null);
    assert.deepEqual(cache.publicStatus().validation, { confirmed: 2, rejectedIdentity: 1,
        rejectedLifecycle: 0, changed: 1, storedWindows: 1 });
    assert.equal(cache.publicStatus().hits, 1);
});
