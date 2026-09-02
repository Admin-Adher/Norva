'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadRuntime() {
  return import('../supabase/functions/_shared/media-cache-singleflight.mjs');
}

const KEY = '6b'.repeat(32);
const LEASE_TOKEN = '11111111-1111-4111-8111-111111111111';

test('coordination identity is account-and-asset exact without provider names', async () => {
  const { deriveMediaCacheCoordinationFingerprints } = await loadRuntime();
  const base = {
    key: KEY,
    targetUrl: 'https://video.example:8443/movie/alice/p%40ss%2Bword/98765.mkv',
    itemType: 'movie',
    itemId: '98765',
    container: 'mkv',
    ownerInstanceId: 'edge-isolate-a',
  };
  const first = await deriveMediaCacheCoordinationFingerprints(base);
  const same = await deriveMediaCacheCoordinationFingerprints({ ...base });
  const otherAsset = await deriveMediaCacheCoordinationFingerprints({ ...base, itemId: '98766', targetUrl: base.targetUrl.replace('98765', '98766') });
  const otherPassword = await deriveMediaCacheCoordinationFingerprints({ ...base, targetUrl: base.targetUrl.replace('p%40ss%2Bword', 'another') });

  assert.deepEqual(first, same);
  assert.match(first.accountFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.workFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.ownerInstanceFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(first.workFingerprint, otherAsset.workFingerprint);
  assert.notEqual(first.accountFingerprint, otherPassword.accountFingerprint);
  assert.notEqual(first.workFingerprint, otherPassword.workFingerprint);
  assert.equal(JSON.stringify(first).includes('alice'), false);
  assert.equal(JSON.stringify(first).includes('word'), false);
});

test('opaque playlists stay isolated by explicit owned source scope', async () => {
  const { deriveMediaCacheCoordinationFingerprints } = await loadRuntime();
  const options = {
    key: KEY,
    targetUrl: 'https://opaque.example/media/file.mkv?token=secret',
    itemType: 'movie',
    itemId: 'movie-1',
    container: 'mkv',
    ownerInstanceId: 'edge-isolate-a',
  };
  const first = await deriveMediaCacheCoordinationFingerprints({ ...options, providerAccountScope: 'user-source:u1:s1' });
  const second = await deriveMediaCacheCoordinationFingerprints({ ...options, providerAccountScope: 'user-source:u2:s2' });
  assert.notEqual(first.accountFingerprint, second.accountFingerprint);
  assert.notEqual(first.workFingerprint, second.workFingerprint);
});

test('coordination key accepts exact 32-byte hex/base64 and rejects weak keys', async () => {
  const { mediaCacheCoordinationKeyBytes, mediaCacheCoordinationKeyIsValid } = await loadRuntime();
  const base64 = Buffer.from('k'.repeat(32)).toString('base64');
  assert.equal(mediaCacheCoordinationKeyBytes(KEY).byteLength, 32);
  assert.equal(mediaCacheCoordinationKeyBytes(`base64:${base64}`).byteLength, 32);
  assert.equal(mediaCacheCoordinationKeyIsValid('too-short'), false);
  assert.throws(() => mediaCacheCoordinationKeyBytes('too-short'));
});

test('ten concurrent cold requests elect one producer and nine ready followers', async () => {
  const { awaitMediaCacheSingleflight } = await loadRuntime();
  let leaderActive = false;
  let ready = false;
  let producerCount = 0;
  let followerCount = 0;
  let leaveCount = 0;
  const objectKey = 'a5'.repeat(32);
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

  const claim = async () => {
    if (ready) return { claim_role: 'ready', object_key: objectKey };
    if (!leaderActive) {
      leaderActive = true;
      producerCount += 1;
      return { claim_role: 'leader', lease_token: LEASE_TOKEN, lease_expires_at: leaseExpiresAt };
    }
    followerCount += 1;
    return { claim_role: 'follower', lease_expires_at: leaseExpiresAt };
  };
  const resolve = async () => ready
    ? { work_state: 'ready', object_key: objectKey }
    : { work_state: 'producing', producer_stage: 'producing', lease_expires_at: leaseExpiresAt };

  const requests = Array.from({ length: 10 }, () => awaitMediaCacheSingleflight({
    claim,
    resolve,
    leave: async () => { leaveCount += 1; return true; },
    timeoutMs: 2_000,
    pollMs: 5,
  }));
  const leader = await requests[0];
  assert.equal(leader.role, 'leader');
  setTimeout(() => { ready = true; }, 20);
  const outcomes = [leader, ...(await Promise.all(requests.slice(1)))];

  assert.equal(producerCount, 1);
  assert.equal(followerCount, 9);
  assert.equal(outcomes.filter((outcome) => outcome.role === 'leader').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.role === 'ready').length, 9);
  assert.equal(leaveCount, 9);
});

test('a vanished producer can be replaced once and a timed-out follower always leaves', async () => {
  const { awaitMediaCacheSingleflight } = await loadRuntime();
  let nowMs = Date.now();
  let claims = 0;
  let leaves = 0;
  const promoted = await awaitMediaCacheSingleflight({
    claim: async () => {
      claims += 1;
      return claims === 1
        ? { claim_role: 'follower', lease_expires_at: new Date(nowMs + 10).toISOString() }
        : { claim_role: 'leader', lease_token: LEASE_TOKEN, lease_expires_at: new Date(nowMs + 60_000).toISOString() };
    },
    resolve: async () => null,
    leave: async () => { leaves += 1; return true; },
    now: () => nowMs,
    sleep: async (delay) => { nowMs += delay; },
    timeoutMs: 100,
    pollMs: 25,
  });
  assert.equal(promoted.role, 'leader');
  assert.equal(claims, 2);
  assert.equal(leaves, 1);

  nowMs = Date.now();
  leaves = 0;
  const pending = await awaitMediaCacheSingleflight({
    claim: async () => ({ claim_role: 'follower', lease_expires_at: new Date(nowMs + 60_000).toISOString() }),
    resolve: async () => ({ work_state: 'producing', producer_stage: 'producing', lease_expires_at: new Date(nowMs + 60_000).toISOString() }),
    leave: async () => { leaves += 1; return true; },
    now: () => nowMs,
    sleep: async (delay) => { nowMs += delay; },
    timeoutMs: 75,
    pollMs: 25,
  });
  assert.equal(pending.role, 'pending');
  assert.equal(leaves, 1);
});
