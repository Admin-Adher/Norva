'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveGlobalMediaCacheObjectKey,
  deriveMediaCacheBindingKey,
  normalizeGlobalMediaObjectIdentity,
} = require('../services/media-gateway/src/mediaCacheIdentity');

function globalIdentity(overrides = {}) {
  return {
    contentSha256: '11'.repeat(32),
    fileSizeBytes: 12_345_678,
    videoProfile: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'high',
      level: 41,
      width: 1920,
      height: 1080,
      pixelFormat: 'yuv420p',
      frameRateNumerator: 24_000,
      frameRateDenominator: 1_001,
    },
    audioTopology: [
      { streamIndex: 2, codec: 'aac', language: 'fra', channels: 2, sampleRate: 48_000, title: 'French', default: false, forced: false },
      { streamIndex: 1, codec: 'aac', language: 'eng', channels: 2, sampleRate: 48_000, title: 'English', default: true, forced: false },
    ],
    subtitleTopology: [
      { streamIndex: 3, codec: 'webvtt', language: 'fra', title: null, default: false, forced: false, hearingImpaired: false },
    ],
    durationMilliseconds: 7_201_234,
    pipelineBuild: 'mkv-h264-hls-fmp4-v3',
    segmenterBuild: 'ffmpeg-8.0-norva-4',
    ...overrides,
  };
}

function bindingIdentity(overrides = {}) {
  return {
    tenantScopeSha256: 'aa'.repeat(32),
    sourceScopeSha256: 'bb'.repeat(32),
    mediaItemScopeSha256: 'cc'.repeat(32),
    variantScopeSha256: 'dd'.repeat(32),
    itemType: 'movie',
    targetUrlSha256: 'ee'.repeat(32),
    ...overrides,
  };
}

test('global object identity is content and topology only, independent from any tenant or catalog label', () => {
  const first = deriveGlobalMediaCacheObjectKey(globalIdentity());
  const second = deriveGlobalMediaCacheObjectKey({
    ...globalIdentity(),
    audioTopology: [...globalIdentity().audioTopology].reverse(),
  });
  assert.equal(first.key, second.key, 'stream indexes make provider track ordering canonical');
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(first.components).sort(), [
    'audio', 'content', 'duration', 'pipeline', 'segmenter', 'size', 'subtitles', 'video',
  ]);
  const serialized = JSON.stringify(first);
  for (const forbidden of ['tenant', 'provider', 'tmdb', 'multi', 'movie title', 'https://']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('every byte/topology/playback-output dimension changes the global object key', () => {
  const baseline = deriveGlobalMediaCacheObjectKey(globalIdentity()).key;
  const mutations = [
    { contentSha256: '22'.repeat(32) },
    { fileSizeBytes: 12_345_679 },
    { videoProfile: { ...globalIdentity().videoProfile, width: 1280 } },
    { audioTopology: [{ ...globalIdentity().audioTopology[0], streamIndex: 1, language: 'deu' }] },
    { subtitleTopology: [] },
    { durationMilliseconds: 7_201_235 },
    { pipelineBuild: 'mkv-h264-hls-fmp4-v4' },
    { segmenterBuild: 'ffmpeg-8.0-norva-5' },
  ];
  for (const mutation of mutations) {
    assert.notEqual(deriveGlobalMediaCacheObjectKey(globalIdentity(mutation)).key, baseline, Object.keys(mutation)[0]);
  }
});

test('global media schemas reject extra fields, malformed tracks and duplicate stream indexes', () => {
  assert.throws(
    () => normalizeGlobalMediaObjectIdentity({ ...globalIdentity(), title: 'must never enter object identity' }),
    (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY',
  );
  assert.throws(
    () => normalizeGlobalMediaObjectIdentity({
      ...globalIdentity(),
      audioTopology: [
        globalIdentity().audioTopology[0],
        { ...globalIdentity().audioTopology[1], streamIndex: globalIdentity().audioTopology[0].streamIndex },
      ],
    }),
    (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY',
  );
  assert.throws(
    () => normalizeGlobalMediaObjectIdentity({
      ...globalIdentity(),
      subtitleTopology: [{ ...globalIdentity().subtitleTopology[0], language: 'unknown language' }],
    }),
    (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY',
  );
});

test('bindings vary per authority while leaving the global object key unchanged', () => {
  const object = deriveGlobalMediaCacheObjectKey(globalIdentity());
  const first = deriveMediaCacheBindingKey(bindingIdentity(), object.key);
  const second = deriveMediaCacheBindingKey(bindingIdentity({
    tenantScopeSha256: '12'.repeat(32),
    sourceScopeSha256: '34'.repeat(32),
    mediaItemScopeSha256: '56'.repeat(32),
    variantScopeSha256: null,
    targetUrlSha256: '78'.repeat(32),
  }), object.key);
  assert.notEqual(first.key, second.key);
  assert.equal(first.objectKey, object.key);
  assert.equal(second.objectKey, object.key);
  assert.equal(deriveGlobalMediaCacheObjectKey(globalIdentity()).key, object.key);
});

test('binding schemas reject missing authority, unsupported item types and raw identifiers', () => {
  const objectKey = deriveGlobalMediaCacheObjectKey(globalIdentity()).key;
  const missing = bindingIdentity();
  delete missing.sourceScopeSha256;
  assert.throws(() => deriveMediaCacheBindingKey(missing, objectKey), (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY');
  assert.throws(
    () => deriveMediaCacheBindingKey(bindingIdentity({ itemType: 'live' }), objectKey),
    (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY',
  );
  assert.throws(
    () => deriveMediaCacheBindingKey({ ...bindingIdentity(), providerName: 'KING365' }, objectKey),
    (error) => error.code === 'INVALID_MEDIA_CACHE_IDENTITY',
  );
});
