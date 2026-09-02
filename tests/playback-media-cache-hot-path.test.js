'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

test('Edge v74 advertises the shared-cache hot playback protocol', () => {
  assert.match(edge, /version: 74,[\s\S]*sharedMediaCacheHotPlaybackProtocol: 1/);
});

test('exact MKV cache lookup runs before provider circuit, capacity query, and provider claim', () => {
  const create = edge.slice(
    edge.indexOf('async function createPlaybackSession'),
    edge.indexOf('type StrictLanguageValidationEvidence'),
  );
  assert.match(create, /authoritativeVodContainer === "mkv"/);
  assert.match(create, /tryCreateHotMediaCachePlayback/);
  assert.ok(create.indexOf('tryCreateHotMediaCachePlayback') < create.indexOf('assertProviderCircuitClosed'));
  assert.ok(create.indexOf('tryCreateHotMediaCachePlayback') < create.indexOf('claim_cloud_playback_session'));
  assert.match(create, /requirePlaybackCapacity\(userId, db, providerAccountHash, entitlement\)/);
});

test('hot claim is atomic and ambiguous errors cannot fall through to the provider', () => {
  const hot = edge.slice(
    edge.indexOf('async function completeClaimedMediaCachePlayback'),
    edge.indexOf('async function claimReadyMediaCacheWorkPlayback'),
  );
  assert.match(hot, /norva_claim_media_cache_playback/);
  assert.match(hot, /if \(error\) throwDb\(error, "Unable to claim shared media cache playback"\)/);
  assert.match(hot, /capacity_exceeded === true/);
  assert.match(hot, /releaseSupersededPlaybackSessions/);
  assert.match(hot, /expirePlaybackSession\(sessionId, userId, db\)/);
  assert.doesNotMatch(hot, /providerAccountHash|createGatewaySession|targetUrl[,)]/);
});

test('hot response returns only a private HLS contract and no provider URL', () => {
  const hot = edge.slice(
    edge.indexOf('async function completeClaimedMediaCachePlayback'),
    edge.indexOf('async function claimReadyMediaCacheWorkPlayback'),
  );
  assert.match(hot, /mode: "shared-cache"/);
  assert.match(hot, /url: mediaCache\.playlistUrl/);
  assert.match(hot, /transport: mediaCache\.transport/);
  assert.match(hot, /mediaCache,/);
  assert.match(hot, /gatewayRequired: false/);
});

test('first and renewed tickets share one Authorization-header-only builder', () => {
  const builder = edge.slice(
    edge.indexOf('async function createAuthorizedMediaCachePlayback'),
    edge.indexOf('async function issueMediaCachePlaybackTicket'),
  );
  assert.match(builder, /authorization: \{ scheme: "Bearer", token: ticket \}/);
  assert.match(builder, /playlistUrl: mediaCacheAssetUrl\(workerUrl, objectKey, rootPlaylist\)/);
  assert.doesNotMatch(builder, /searchParams/);
  assert.match(edge, /createAuthorizedMediaCachePlayback\(runtimeConfig, sessionId, claim\)/);
  assert.match(edge, /createAuthorizedMediaCachePlayback\(runtimeConfig, playbackSessionId, authorization\)/);
});
