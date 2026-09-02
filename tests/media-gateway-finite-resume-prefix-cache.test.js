'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FiniteMkvResumePrefixCache,
} = require('../services/media-gateway/src/finiteMkvResumePrefixCache');

const validator = { kind: 'etag', header: 'If-Range', value: '"resume-v1"' };
const identity = 'a'.repeat(64);

test('finite MKV resume prefix cache is exact-source, bounded and rejects weak ETags', () => {
  let now = 1_000;
  const cache = new FiniteMkvResumePrefixCache({
    maxBytes: 16,
    maxEntryBytes: 8,
    ttlMs: 100,
    now: () => now,
  });
  const payload = Buffer.from('12345678');

  assert.equal(cache.put({
    sourceUrl: 'https://provider.test/movie/account/one/1.mkv',
    fileSizeBytes: 64,
    validator,
    effectiveUrlIdentitySha256: identity,
    payload,
  }), true);
  const hit = cache.get({
    sourceUrl: 'https://provider.test/movie/account/one/1.mkv',
    fileSizeBytes: 64,
  });
  assert.deepEqual(hit.payload, payload);
  assert.equal(cache.get({
    sourceUrl: 'https://provider.test/movie/account/two/1.mkv',
    fileSizeBytes: 64,
  }), null);
  assert.equal(cache.put({
    sourceUrl: 'https://provider.test/movie/account/one/2.mkv',
    fileSizeBytes: 64,
    validator: { ...validator, value: 'W/"resume-v1"' },
    effectiveUrlIdentitySha256: identity,
    payload,
  }), false);

  for (const item of [2, 3]) {
    assert.equal(cache.put({
      sourceUrl: `https://provider.test/movie/account/one/${item}.mkv`,
      fileSizeBytes: 64,
      validator: { ...validator, value: `"resume-v${item}"` },
      effectiveUrlIdentitySha256: identity,
      payload,
    }), true);
  }
  assert.equal(cache.get({
    sourceUrl: 'https://provider.test/movie/account/one/1.mkv',
    fileSizeBytes: 64,
  }), null);
  assert.equal(cache.publicStatus().bytes, 16);

  now += 101;
  cache.prune();
  const status = cache.publicStatus();
  assert.equal(status.entries, 0);
  assert.equal(status.bytes, 0);
  assert.equal(status.stats.expired, 2);
  assert.equal(status.stats.rejected, 1);

  assert.equal(cache.put({
    sourceUrl: 'https://provider.test/movie/account/one/4.mkv',
    fileSizeBytes: 64,
    validator: null,
    effectiveUrlIdentitySha256: identity,
    payload,
  }), true);
  assert.equal(cache.get({
    sourceUrl: 'https://provider.test/movie/account/one/4.mkv',
    fileSizeBytes: 64,
  }).validator, null);
});
