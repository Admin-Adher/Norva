'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

function section(start, end) {
  const from = edge.indexOf(start);
  const to = edge.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section missing`);
  return edge.slice(from, to);
}

test('cold demand is scored and recorded before a producer is claimed', () => {
  const coordinate = section(
    'async function coordinateColdMediaCachePlayback',
    'async function mediaCacheAccountFingerprintForPlayback',
  );
  const demand = coordinate.indexOf('norva_record_media_cache_demand');
  const claim = coordinate.indexOf('norva_claim_media_cache_producer');
  assert.ok(demand >= 0 && claim > demand);
  assert.match(coordinate, /p_work_fingerprint: fingerprints\.workFingerprint/);
  assert.match(coordinate, /p_account_fingerprint: fingerprints\.accountFingerprint/);
  assert.match(coordinate, /publication disabled/);
  assert.doesNotMatch(coordinate, /providerName|username|password|ticket/i);
});

test('cost admission is passed only to cold coordination, never to the hot lookup', () => {
  const create = section(
    'async function createPlaybackSessionCore',
    'async function createPlaybackSession(',
  );
  const hotStart = create.indexOf('tryCreateHotMediaCachePlayback({');
  const hotEnd = create.indexOf('});', hotStart);
  const coldStart = create.indexOf('coordinateColdMediaCachePlayback({');
  const coldEnd = create.indexOf('});', coldStart);
  assert.ok(hotStart >= 0 && hotEnd > hotStart && coldStart > hotEnd && coldEnd > coldStart);
  assert.doesNotMatch(create.slice(hotStart, hotEnd), /costScore:/);
  assert.match(create.slice(coldStart, coldEnd), /costScore: mediaCacheDemandCostScore\(/);
});

test('authorized cache playlist is preflighted and rolls back to a new provider session', () => {
  const complete = section(
    'async function preflightAuthorizedMediaCachePlayback',
    'async function tryCreateHotMediaCachePlayback',
  );
  assert.match(complete, /Authorization: `Bearer \$\{ticket\}`/);
  assert.match(complete, /AbortSignal\.timeout\(3_000\)/);
  assert.match(complete, /MEDIA_CACHE_DELIVERY_UNAVAILABLE/);
  assert.match(complete, /expirePlaybackSession/);
  assert.match(complete, /norva_enqueue_media_cache_purge/);
  assert.match(edge, /sessionId = crypto\.randomUUID\(\);[\s\S]*coordinateColdMediaCachePlayback/);
  assert.match(edge, /if \(coordinatedPlayback\) return coordinatedPlayback;[\s\S]*sessionId = crypto\.randomUUID\(\)/);
});

test('one-shot delivery fallback bypasses both shared reads and cold coordination', () => {
  const create = section(
    'async function createPlaybackSessionCore',
    'async function createPlaybackSession(',
  );
  assert.match(create, /mediaCacheReadPolicy/);
  assert.match(create, /mediaCacheReadPolicy !== "default" && mediaCacheReadPolicy !== "bypass-once"/);
  assert.match(create, /if \(mediaCacheReadBypassOnce\)[\s\S]*cache_fallback/);
  assert.match(create, /mediaCacheRuntimeConfig && !mediaCacheReadBypassOnce/);
  assert.match(create, /mediaCacheLifecycle\.producer,[\s\S]*mediaCacheReadBypassOnce/);
  assert.match(edge, /bypassCompleteHlsCache \? \{ completeHlsCachePolicy: "bypass" \}/);
});

test('purge maintenance is sequential, DB-leased and service authenticated', () => {
  const maintenance = section(
    'async function runMediaCacheMaintenanceCore',
    'async function runMediaCacheRecovery',
  );
  assert.match(edge, /segments\[0\] === "media-cache" && segments\[1\] === "maintenance"/);
  assert.match(maintenance, /norva_claim_media_cache_purge/);
  assert.match(maintenance, /for \(let index = 0; index < batch; index \+= 1\)/);
  assert.match(maintenance, /x-norva-purge-reason/);
  assert.match(maintenance, /norva_complete_media_cache_purge/);
  assert.match(maintenance, /p_reason: reason/);
  assert.match(maintenance, /norva_enqueue_media_cache_purge/);
  assert.match(maintenance, /r2_inventory_cursor/);
  assert.match(maintenance, /orphan_candidate/);
  assert.match(maintenance, /manifestCandidates/);
  assert.match(maintenance, /\[\.\.\.partialCandidates, \.\.\.manifestCandidates\]/);
  assert.match(maintenance, /24 \* 60 \* 60 \* 1_000/);
  const endpoint = section(
    'async function runMediaCacheMaintenance(',
    'async function runMediaCacheRecovery',
  );
  assert.match(endpoint, /requireConfiguredMediaGatewayCallback/);
});

test('operator purge is service-only, reason-scoped and immediately fenced', () => {
  const purge = section(
    'async function runMediaCachePurge',
    'async function runMediaCacheRecovery',
  );
  assert.match(edge, /segments\[0\] === "media-cache" && segments\[1\] === "purge"/);
  assert.match(edge, /runMediaCachePurge\(req, supabase\), 202/);
  assert.match(purge, /requireConfiguredMediaGatewayCallback/);
  assert.match(purge, /exactJsonKeys\(body, \["objectKey", "protocol", "reason"\]\)/);
  assert.match(purge, /\["corruption", "legal", "security"\]\.includes\(reason\)/);
  assert.doesNotMatch(purge, /\["eviction"|"orphan"/);
  assert.match(purge, /norva_enqueue_media_cache_purge/);
  assert.match(purge, /runMediaCacheMaintenanceCore\(db, runtimeConfig, 1, false\)/);
  assert.match(purge, /MEDIA_CACHE_PURGE_OBJECT_NOT_FOUND/);
  assert.match(purge, /state: maintenance\.completed === 1 \? "completed" : "queued"/);
});

test('applied adaptive routes emit only non-secret slot, protocol, score and confidence', () => {
  const resolve = section(
    'async function runProviderRouteResolve',
    'const PROVIDER_ROUTE_FINGERPRINT_PATTERN',
  );
  assert.match(resolve, /p_metric: "route_score"/);
  assert.match(resolve, /p_metric: "route_confidence"/);
  assert.match(resolve, /p_route_slot: `slot-\$\{routeSlot\}`/);
  assert.match(resolve, /p_route_protocol: routeProtocol/);
  assert.doesNotMatch(resolve, /providerUrl|username|password|ticket/i);
});

test('recovery keeps quarantine through DB verification and finalizes in a second phase', () => {
  const recovery = section(
    'async function runMediaCacheRecovery',
    'async function runMediaCachePublicationCallback',
  );
  assert.match(recovery, /\/internal\/v1\/recoveries\//);
  assert.match(recovery, /"x-norva-recovery-phase": "verify"/);
  assert.match(recovery, /norva_recover_media_cache_object/);
  assert.match(recovery, /exactJsonKeys\(components, MEDIA_CACHE_IDENTITY_COMPONENT_KEYS\)/);
  assert.match(recovery, /derivedObjectKey === objectKey/);
  assert.match(recovery, /p_content_sha256: contentSha256/);
  assert.match(recovery, /p_video_profile_sha256: videoSha256/);
  assert.match(recovery, /p_audio_topology_sha256: audioSha256/);
  assert.match(recovery, /p_subtitle_topology_sha256: subtitleSha256/);
  assert.match(recovery, /p_root_playlist: rootPlaylist/);
  assert.match(recovery, /"x-norva-recovery-phase": "commit"/);
  assert.match(recovery, /MEDIA_CACHE_RECOVERY_FINALIZE_FAILED/);
  assert.match(recovery, /norva_enqueue_media_cache_purge/);
  assert.doesNotMatch(recovery, /x-norva-quarantine-reason/);
});

test('a manifest whose authority callback is rejected is fenced as a delayed orphan', () => {
  const publication = section(
    'async function runMediaCachePublicationCallback',
    'async function runCompleteHlsCacheCallback',
  );
  assert.match(publication, /MEDIA_CACHE_PUBLICATION_REJECTED/);
  assert.match(publication, /norva_enqueue_media_cache_purge/);
  assert.match(publication, /p_reason: "orphan"/);
});

test('first-frame and avoided-FFmpeg metrics are emitted only for a live cache grant', () => {
  const event = section(
    'async function recordPlaybackEvent',
    'async function recordPlaybackSessionFailure',
  );
  assert.match(event, /media_cache_playback_grants/);
  assert.match(event, /first_image_ms/);
  assert.match(event, /ffmpeg_bytes_avoided/);
  assert.match(event, /ffmpeg_seconds_avoided/);
  assert.doesNotMatch(event, /console\.(?:log|warn|error)\([^\n]*(?:objectKey|ticket|sourceUrl)/);
});
