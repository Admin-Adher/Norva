'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SharedMediaCacheIdentityError,
  buildSharedMediaCacheIdentity,
} = require('../services/media-gateway/src/sharedMediaCacheIdentity');
const { deriveGlobalMediaCacheObjectKey } = require('../services/media-gateway/src/mediaCacheIdentity');

function exactProfile() {
  return {
    metadataComplete: true,
    fileSizeBytes: 987654321,
    durationSeconds: 5421.375,
    videoStreamIndex: 0,
    videoCodec: 'h264',
    videoProfile: 'High',
    videoLevel: 40,
    videoWidth: 1920,
    videoHeight: 1080,
    videoPixelFormat: 'yuv420p',
    videoFrameRateNumerator: 24000,
    videoFrameRateDenominator: 1001,
    audioTracks: [
      { index: 1, codec: 'aac', language: 'fra', channels: 2, sampleRate: 48000, title: 'Français', default: true, forced: false },
      { index: 2, codec: 'aac', language: 'eng', channels: 6, sampleRate: 48000, title: 'English', default: false, forced: false },
    ],
    subtitles: [
      { index: 3, codec: 'subrip', language: 'fra', title: 'Français', default: true, forced: false, hearingImpaired: false },
      { index: 4, codec: 'subrip', language: 'eng', title: 'English SDH', default: false, forced: false, hearingImpaired: true },
    ],
  };
}

const base = {
  contentSha256: 'a'.repeat(64),
  codecProfile: exactProfile(),
  pipelineBuild: 'mkv-complete-hls-mpegts-v4:video-copy:audio-multi-aac-2:target-2',
  segmenterBuild: 'ffmpeg-hls-mpegts-v1',
};

test('shared identity captures full bytes, video timing and every exact track', () => {
  const identity = buildSharedMediaCacheIdentity(base);
  assert.equal(identity.contentSha256, 'a'.repeat(64));
  assert.equal(identity.fileSizeBytes, 987654321);
  assert.equal(identity.durationMilliseconds, 5421375);
  assert.deepEqual(identity.videoProfile, {
    streamIndex: 0,
    codec: 'h264',
    profile: 'high',
    level: 40,
    width: 1920,
    height: 1080,
    pixelFormat: 'yuv420p',
    frameRateNumerator: 24000,
    frameRateDenominator: 1001,
  });
  assert.deepEqual(identity.audioTopology.map((track) => [track.streamIndex, track.language]), [[1, 'fra'], [2, 'eng']]);
  assert.deepEqual(identity.subtitleTopology.map((track) => [track.streamIndex, track.language, track.hearingImpaired]), [
    [3, 'fra', false],
    [4, 'eng', true],
  ]);
});

test('tenant, provider, title, URL and catalogue labels cannot enter the global key', () => {
  const first = deriveGlobalMediaCacheObjectKey(buildSharedMediaCacheIdentity(base));
  const second = deriveGlobalMediaCacheObjectKey(buildSharedMediaCacheIdentity({
    ...base,
    tenantId: 'other-user',
    providerName: 'unknown-provider',
    title: 'MULTI FHD',
    targetUrl: 'https://provider.invalid/secret',
  }));
  assert.equal(first.key, second.key);
  assert.equal(JSON.stringify(first).includes('other-user'), false);
  assert.equal(JSON.stringify(first).includes('provider.invalid'), false);
});

test('missing exact profile fields fail closed before any publication', () => {
  for (const mutate of [
    (profile) => { delete profile.metadataComplete; },
    (profile) => { delete profile.videoFrameRateNumerator; },
    (profile) => { delete profile.subtitles; },
    (profile) => { profile.audioTracks[0].sampleRate = null; },
  ]) {
    const profile = structuredClone(exactProfile());
    mutate(profile);
    assert.throws(
      () => buildSharedMediaCacheIdentity({ ...base, codecProfile: profile }),
      (error) => error instanceof SharedMediaCacheIdentityError &&
        ['SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE', 'SHARED_MEDIA_CACHE_PROFILE_INVALID'].includes(error.code),
    );
  }
});

test('absent or malformed language tags stay explicit and cannot poison identity syntax', () => {
  const profile = exactProfile();
  profile.audioTracks[0].language = null;
  profile.subtitles[0].language = 'not a valid language tag!';
  const identity = buildSharedMediaCacheIdentity({ ...base, codecProfile: profile });
  assert.equal(identity.audioTopology[0].language, 'und');
  assert.equal(identity.subtitleTopology[0].language, 'und');
});
