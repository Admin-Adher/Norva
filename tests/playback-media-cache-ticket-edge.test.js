'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');
const grantMigration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901220000_media_cache_exact_playback_grants_v1.sql',
), 'utf8');

test('Edge v76 exposes one authenticated renewable media-cache ticket route', () => {
  assert.match(edge, /version: 76,[\s\S]*privateMediaCacheTicketProtocol: 1/);
  assert.match(edge, /segments\[3\] === "media-cache-ticket"[\s\S]*issueMediaCachePlaybackTicket/);
  assert.match(edge, /const identity = await requireIdentity\(req, supabase\)/);
  assert.match(edge, /import \{ createMediaCacheTicket \} from "\.\.\/_shared\/media-cache-ticket\.ts"/);
});

test('ticket request accepts only protocol and object key while SQL derives every authority coordinate', () => {
  const issue = edge.slice(
    edge.indexOf('async function issueMediaCachePlaybackTicket'),
    edge.indexOf('async function revokeMediaCachePlaybackGrant'),
  );
  assert.match(issue, /exactJsonKeys\(body, \["objectKey", "protocol"\]\)/);
  assert.match(issue, /norva_authorize_media_cache_playback/);
  assert.match(issue, /p_playback_session_id: playbackSessionId/);
  assert.match(issue, /p_user_id: userId/);
  assert.match(issue, /p_object_key: objectKey/);
  assert.doesNotMatch(issue, /body\.(sourceId|itemType|itemId|variantId|targetUrl|targetUrlSha256|bindingId|userId)/);
});

test('ticket stays in the Authorization header contract and is never placed in a URL', () => {
  const issue = edge.slice(
    edge.indexOf('async function createAuthorizedMediaCachePlayback'),
    edge.indexOf('async function revokeMediaCachePlaybackGrant'),
  );
  assert.match(issue, /createMediaCacheTicket\([\s\S]*objectKey,[\s\S]*bindingId,[\s\S]*playbackSessionId/);
  assert.match(issue, /authorization: \{ scheme: "Bearer", token: ticket \}/);
  assert.match(issue, /playlistUrl: mediaCacheAssetUrl\(workerUrl, objectKey, rootPlaylist\)/);
  assert.doesNotMatch(issue, /searchParams/);
  assert.doesNotMatch(issue, /mediaCacheAssetUrl\([^)]*ticket/);
  assert.match(issue, /refreshAfter:/);
  assert.match(issue, /hardExpiresAt/);
});

test('session expiry revokes the database grant and the Worker marker without deleting shared bytes', () => {
  const authorize = grantMigration.slice(
    grantMigration.indexOf('create function public.norva_authorize_media_cache_playback'),
    grantMigration.indexOf('create function public.norva_revoke_media_cache_playback_grant'),
  );
  assert.match(authorize, /v_session\.expires_at <= v_now/);

  const revoke = edge.slice(
    edge.indexOf('async function revokeMediaCachePlaybackGrant'),
    edge.indexOf('async function getPlaybackSession'),
  );
  assert.match(revoke, /norva_revoke_media_cache_playback_grant/);
  assert.match(revoke, /\/internal\/v1\/revocations\//);
  assert.match(revoke, /Authorization: `Bearer \$\{runtimeConfig\.mediaCacheWorkerToken\}`/);
  assert.match(revoke, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.doesNotMatch(revoke, /DELETE|media_cache_objects/);

  const expire = edge.slice(
    edge.indexOf('async function expirePlaybackSession'),
    edge.indexOf('async function recordPlaybackEvent'),
  );
  assert.match(expire, /revokeMediaCachePlaybackGrant\(id, userId, db, runtimeConfig\)/);
  assert.ok(
    expire.indexOf('revokeMediaCachePlaybackGrant') < expire.indexOf('completeCache", "continue"'),
    'browser ticket must be revoked before a continuation can detach',
  );
  assert.match(expire, /mediaCacheWorkerRevoked/);
  assert.match(expire, /mediaCacheErrors/);
});

test('health reveals readiness only and never returns cache secrets', () => {
  const health = edge.slice(edge.indexOf('if (req.method === "GET" && segments[0] === "health")'), edge.indexOf('if (req.method === "GET" && segments[0] === "telemetry"'));
  assert.match(health, /workerConfigured:/);
  assert.match(health, /ticketKeyConfigured:/);
  assert.doesNotMatch(health, /mediaCacheWorkerToken[,}]|mediaCacheTicketHmacKey[,}]/);
});
