'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const source = edge.slice(edge.indexOf('async function coordinateColdMediaCachePlayback('),
  edge.indexOf('async function mediaCacheAccountFingerprintForPlayback('));
const hints = edge.slice(edge.indexOf('function gatewayPlaybackHints('),
  edge.indexOf('\nfunction ', edge.indexOf('function gatewayPlaybackHints(') + 1));

test('a cold resume never joins or waits for the producer at zero', async () => {
  const code = transformSync(`${hints}\n${source}`, { loader: 'ts', target: 'es2022' }).code;
  let workerLookups = 0;
  const coordinate = vm.runInNewContext(`${code}; coordinateColdMediaCachePlayback`, {
    Number,
    recordOrEmpty: (value) => value && typeof value === 'object' ? value : {},
    compactRecord: (value) => value,
    stringOrNull: (value) => typeof value === 'string' ? value : null,
    boundedNullableNumber: (value, min, max) => value == null || !Number.isFinite(Number(value))
      ? null : Math.min(max, Math.max(min, Number(value))),
    boundedNullableInt: () => null,
    mediaCachePlaybackWorkerUrl: () => { workerLookups += 1; throw new Error('cold coordination entered'); },
  });
  for (const name of ['seekOffset', 'seek_offset', 'startOffset', 'start_offset', 'resumeTime', 'resume_time']) {
    assert.equal(await coordinate({
      runtimeConfig: { mediaCacheSingleflightEnabled: true },
      playbackHint: { [name]: 300 },
    }), null, name);
  }
  assert.equal(workerLookups, 0);
  await assert.rejects(coordinate({
    runtimeConfig: { mediaCacheSingleflightEnabled: true }, playbackHint: { seekOffset: 0 },
  }), /cold coordination entered/);
  assert.equal(workerLookups, 1, 'a start at zero retains shared conversion eligibility');
});

test('complete cache lookup precedes the resume guard and provider seek remains available', () => {
  const core = edge.slice(edge.indexOf('async function createPlaybackSessionCore('),
    edge.indexOf('async function createPlaybackSession('));
  assert.ok(core.indexOf('tryCreateHotMediaCachePlayback') < core.indexOf('coordinateColdMediaCachePlayback'));
  assert.ok(core.indexOf('if (coordinatedPlayback) return coordinatedPlayback') < core.indexOf('claim_cloud_playback_session'));
});
