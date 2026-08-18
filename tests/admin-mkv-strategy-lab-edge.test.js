'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'supabase/functions/_shared/media-lab-contract.mjs');
const EDGE = fs.readFileSync(path.join(ROOT, 'supabase/functions/norva-admin-media-lab/index.ts'), 'utf8');
const CONFIG = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');

test('media Lab boundary accepts only the fixed eleven fixture IDs and exact request shape', async () => {
  const contract = await import(pathToFileURL(CONTRACT_PATH).href);
  assert.equal(contract.MEDIA_LAB_PROTOCOL, 1);
  assert.equal(contract.MEDIA_LAB_FIXTURE_IDS.length, 11);
  assert.equal(new Set(contract.MEDIA_LAB_FIXTURE_IDS).size, 11);
  for (const fixtureId of contract.MEDIA_LAB_FIXTURE_IDS) {
    assert.deepEqual(contract.parseMediaLabRunRequest({ protocol: 1, fixtureId }), { protocol: 1, fixtureId });
  }
  for (const invalid of [
    null,
    {},
    { protocol: '1', fixtureId: 'h264-closed-aac' },
    { protocol: 1, fixtureId: 'https://provider.invalid/secret.mkv' },
    { protocol: 1, fixtureId: 'h264-closed-aac', sourceUrl: 'https://provider.invalid/secret.mkv' },
    { protocol: 1, fixtureId: 'h264-closed-aac', strategyId: 'auto' },
  ]) assert.equal(contract.parseMediaLabRunRequest(invalid), null);
});

test('runner projection strips every unknown identity and requires exact numeric evidence for pass/fail', async () => {
  const { projectMediaLabRunnerState } = await import(pathToFileURL(CONTRACT_PATH).href);
  const evidence = {
    protocol: 1,
    status: 'pass',
    pipeline: 'video-copy-audio-copy',
    reason: 'mkv-h264-copy-ready',
    ttffMs: 6500,
    manifestReadyMs: 900,
    firstSegmentMs: 1200,
    bufferedAheadSeconds: 7,
    productionRateX: 8,
    browserBufferRateX: 3,
    rebufferCount: 0,
    rebufferMs: 0,
    providerGets: 1,
    maximumConcurrentProviderGets: 1,
    ffmpegSpawns: 1,
    analyzerSpawns: 0,
    http458: 0,
    retriesAfter458: 0,
    seekPassed: true,
    audioPassed: true,
    cleanupPassed: true,
    sourceUrl: 'https://user:secret@provider.invalid/movie.mkv',
    token: 'must-not-cross',
    sessionId: 'must-not-cross',
  };
  const projected = projectMediaLabRunnerState({
    protocol: 1,
    state: 'complete',
    fixtureId: 'h264-closed-aac',
    result: evidence,
    actor: 'must-not-cross',
  });
  assert.equal(projected.state, 'complete');
  assert.equal(projected.result.ttffMs, 6500);
  const serialized = JSON.stringify(projected);
  for (const secret of ['provider.invalid', 'secret', 'must-not-cross', 'sessionId', 'sourceUrl']) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  assert.equal(projectMediaLabRunnerState({
    protocol: 1,
    state: 'complete',
    fixtureId: 'h264-closed-aac',
    result: { ...evidence, ttffMs: '6500' },
  }), null);

  const blocked = projectMediaLabRunnerState({
    protocol: 1,
    state: 'complete',
    fixtureId: 'hevc-full-cache',
    result: {
      protocol: 1,
      status: 'blocked',
      pipeline: 'cache-hit',
      reason: 'gateway-cache-read-disabled',
    },
  });
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.result.ttffMs, null);
});

test('admin Lab Edge revalidates admin JWT, derives an opaque actor and never accepts a media URL', () => {
  assert.match(EDGE, /admin\.auth\.getUser\(token\)/);
  assert.match(EDGE, /user\.app_metadata\?\.role !== "admin"/);
  assert.match(EDGE, /NORVA_MEDIA_LAB_ENABLED/);
  assert.match(EDGE, /NORVA_MEDIA_LAB_ACTOR_HMAC_KEY/);
  assert.match(EDGE, /norva-media-lab-actor-v1\\0/);
  assert.match(EDGE, /parsed\.hostname !== "norva-media-lab-runner"/);
  assert.match(EDGE, /parsed\.port !== "8093"/);
  assert.match(EDGE, /parseMediaLabRunRequest\(await strictJsonBody\(req\)\)/);
  assert.match(EDGE, /X-Norva-Lab-Actor/);
  assert.match(EDGE, /\/v1\/current/);
  assert.match(EDGE, /projectMediaLabRunnerState/);
  assert.doesNotMatch(EDGE, /sourceUrl\s*:/);
  assert.doesNotMatch(EDGE, /allowed\.includes\("\*"\)/);
  assert.match(CONFIG, /\[functions\.norva-admin-media-lab\]\s*\r?\nverify_jwt = false/);
});
