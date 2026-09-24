'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  publishSharedMediaCacheSession,
  publishSharedMediaCacheSessionWithRetry,
} = require('../services/media-gateway/src/sharedMediaCachePublication');

const playbackSessionId = '11111111-1111-4111-8111-111111111111';
const gatewaySessionId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';

function profile() {
  return {
    metadataComplete: true,
    fileSizeBytes: 1000000,
    durationSeconds: 90,
    videoStreamIndex: 0,
    videoCodec: 'h264',
    videoProfile: 'high',
    videoLevel: 40,
    videoWidth: 1280,
    videoHeight: 720,
    videoPixelFormat: 'yuv420p',
    videoFrameRateNumerator: 25,
    videoFrameRateDenominator: 1,
    audioTracks: [{ index: 1, codec: 'aac', language: 'fra', channels: 2, sampleRate: 48000, title: 'Français', default: true, forced: false }],
    subtitles: [],
  };
}

function session() {
  return {
    id: gatewaySessionId,
    playbackSessionId,
    codecProfile: profile(),
    fileSizeBytes: 1000000,
    vodInputContentSha256: 'a'.repeat(64),
    inputPump: { completed: true },
    completeHlsCacheFfmpegCompletedCleanly: true,
    inputFailure: null,
    lastError: null,
  };
}

test('EOF-complete Gateway output is uploaded before one authority-only callback', async () => {
  const calls = [];
  const publisher = {
    async publish(input) {
      calls.push(['publish', input]);
      return {
        status: 'published',
        objectKey: 'b'.repeat(64),
        objectPrefix: `media-cache/v1/bb/${'b'.repeat(64)}/`,
        manifestSha256: 'c'.repeat(64),
        components: { video: 'd'.repeat(64), audio: 'e'.repeat(64), subtitles: 'f'.repeat(64) },
        totalBytes: 500000,
        fileCount: 5,
        expiresAtMs: Date.now() + 86400000,
      };
    },
  };
  const result = await publishSharedMediaCacheSession({
    session: session(),
    publisher,
    pipelineBuild: 'pipeline-v1',
    segmenterBuild: 'segmenter-v1',
    sourceDirectory: 'C:/tmp/session',
    rootPlaylist: 'playlist.m3u8',
    files: ['playlist.m3u8', 'segment-000.ts'],
    ttlMs: 1_209_600_000,
    async registerPublication(payload) {
      calls.push(['register', payload]);
      return { ok: true, objectKey: payload.object.objectKey, bindingId };
    },
  });
  assert.deepEqual(calls.map(([kind]) => kind), ['publish', 'register']);
  assert.equal(calls[0][1].ttlMs, 1_209_600_000);
  const payload = calls[1][1];
  assert.deepEqual(Object.keys(payload).sort(), [
    'gatewaySessionId', 'object', 'playbackSessionId', 'protocol', 'status',
  ]);
  assert.equal(payload.object.contentSha256, 'a'.repeat(64));
  assert.equal(payload.object.storageBackend, 'r2');
  assert.equal(JSON.stringify(payload).includes('sourceUrl'), false);
  assert.equal(JSON.stringify(payload).includes('provider'), false);
  assert.equal(result.bindingId, bindingId);
});

test('partial source, FFmpeg failure and callback mismatch all fail closed', async () => {
  const publisher = {
    async publish() {
      return {
        status: 'published', objectKey: 'b'.repeat(64), objectPrefix: `media-cache/v1/bb/${'b'.repeat(64)}/`,
        manifestSha256: 'c'.repeat(64), components: { video: 'd'.repeat(64), audio: 'e'.repeat(64), subtitles: 'f'.repeat(64) },
        totalBytes: 1, fileCount: 1, expiresAtMs: Date.now() + 60000,
      };
    },
  };
  for (const broken of [
    { inputPump: { completed: false } },
    { completeHlsCacheFfmpegCompletedCleanly: false },
    { inputFailure: { code: 'PROVIDER_RESET' } },
  ]) {
    await assert.rejects(() => publishSharedMediaCacheSession({
      session: { ...session(), ...broken }, publisher, pipelineBuild: 'p', segmenterBuild: 's',
      sourceDirectory: 'C:/tmp/session', rootPlaylist: 'playlist.m3u8', files: ['playlist.m3u8'],
      registerPublication: async () => ({ ok: true, objectKey: 'b'.repeat(64), bindingId }),
    }), /only one clean EOF-complete Gateway session/);
  }
  await assert.rejects(() => publishSharedMediaCacheSession({
    session: session(), publisher, pipelineBuild: 'p', segmenterBuild: 's',
    sourceDirectory: 'C:/tmp/session', rootPlaylist: 'playlist.m3u8', files: ['playlist.m3u8'],
    registerPublication: async () => ({ ok: true, objectKey: '9'.repeat(64), bindingId }),
  }), /could not be bound/);
});

test('transient Worker loss retries the immutable upload and registers once', async () => {
  const calls = [];
  let attempts = 0;
  const result = await publishSharedMediaCacheSessionWithRetry({
    session: session(), pipelineBuild: 'p', segmenterBuild: 's',
    sourceDirectory: 'C:/tmp/session', rootPlaylist: 'playlist.m3u8', files: ['playlist.m3u8'],
    retryDelaysMs: [5, 20],
    wait: async (delay) => { calls.push(`wait:${delay}`); },
    beforeRetry: async (attempt) => { calls.push(`pulse:${attempt}`); },
    publisher: {
      async publish() {
        attempts += 1;
        calls.push(`publish:${attempts}`);
        if (attempts === 1) {
          throw Object.assign(new Error('Worker unavailable'), {
            code: 'MEDIA_CACHE_WORKER_UNAVAILABLE', retryable: true,
          });
        }
        return {
          status: 'published', objectKey: 'b'.repeat(64),
          objectPrefix: `media-cache/v1/bb/${'b'.repeat(64)}/`,
          manifestSha256: 'c'.repeat(64),
          components: { video: 'd'.repeat(64), audio: 'e'.repeat(64), subtitles: 'f'.repeat(64) },
          totalBytes: 1, fileCount: 1, expiresAtMs: Date.now() + 60000,
        };
      },
    },
    async registerPublication(payload) {
      calls.push('register');
      return { ok: true, objectKey: payload.object.objectKey, bindingId };
    },
  });
  assert.equal(result.status, 'published');
  assert.deepEqual(calls, ['publish:1', 'wait:5', 'pulse:1', 'publish:2', 'register']);
});

test('terminal upload rejection does not retry or register', async () => {
  let attempts = 0;
  await assert.rejects(() => publishSharedMediaCacheSessionWithRetry({
    session: session(), pipelineBuild: 'p', segmenterBuild: 's',
    sourceDirectory: 'C:/tmp/session', rootPlaylist: 'playlist.m3u8', files: ['playlist.m3u8'],
    retryDelaysMs: [0], wait: async () => { throw new Error('unexpected retry'); },
    publisher: { async publish() {
      attempts += 1;
      throw Object.assign(new Error('immutable conflict'), {
        code: 'MEDIA_CACHE_IMMUTABLE_CONFLICT', retryable: false,
      });
    } },
    registerPublication: async () => { throw new Error('unexpected callback'); },
  }), /immutable conflict/);
  assert.equal(attempts, 1);
});

test('lost producer lease prevents retrying a transient upload', async () => {
  let attempts = 0;
  await assert.rejects(() => publishSharedMediaCacheSessionWithRetry({
    session: session(), pipelineBuild: 'p', segmenterBuild: 's',
    sourceDirectory: 'C:/tmp/session', rootPlaylist: 'playlist.m3u8', files: ['playlist.m3u8'],
    retryDelaysMs: [0], wait: async () => {},
    beforeRetry: async () => { throw new Error('lease lost'); },
    publisher: { async publish() {
      attempts += 1;
      throw Object.assign(new Error('Worker unavailable'), {
        code: 'MEDIA_CACHE_WORKER_UNAVAILABLE', retryable: true,
      });
    } },
    registerPublication: async () => { throw new Error('unexpected callback'); },
  }), /lease lost/);
  assert.equal(attempts, 1);
});
