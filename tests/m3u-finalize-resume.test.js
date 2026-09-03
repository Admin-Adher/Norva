'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
const section = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
};

const worker = read('supabase/functions/norva-source-sync/index.ts');
const migration = read('supabase/migrations/20260903160000_m3u_finalize_resume_v1.sql');
const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

test('M3U raw import hands projection to the durable finalizer', () => {
  const m3u = section(worker, 'async function syncM3uSource(', '\nasync function replaceSourceItems(');

  assert.match(m3u, /replaceSourceItems\([\s\S]*stage:\s*"finalizing"[\s\S]*finalizePending:\s*true/);
  assert.match(m3u, /liveCatalog:\s*\{\s*rawLive:\s*savedRows\.length,\s*pending:\s*true\s*\}/);
  assert.doesNotMatch(m3u, /refreshMaterializedLiveCatalog/);
});

test('M3U handoff persists its cursor before releasing provider transport', () => {
  const sync = section(worker, 'async function syncCloudSource(', '\nasync function maybeRecordContentEvent(');
  const branch = section(
    sync,
    'if (source.source_type === "m3u" && resultRecord.finalizePending === true)',
    '\n    const syncedAt =',
  );

  const persistAt = branch.indexOf('persistM3uFinalizeHandoff(');
  const settleAt = branch.indexOf('settleM3uSyncLease(');
  const driveAt = branch.indexOf('driveFinalizeToReady(');
  assert.ok(persistAt >= 0 && settleAt > persistAt && driveAt > settleAt);
  assert.match(branch, /return \{ sourceId, status: "syncing", started: true/);

  const persist = section(worker, 'async function persistM3uFinalizeHandoff(', '\n// Forward-date the finalize');
  assert.match(persist, /finalizeCursor:\s*\{ phase: "live", offset: 0, afterId: "" \}/);
  assert.match(persist, /contentSignature:\s*input\.contentSignature/);
  assert.match(persist, /\.eq\("user_id", userId\)/);
});

test('watchdog resumes durable M3U finalization without claiming provider transport', () => {
  const watchdog = section(worker, 'async function cronResumeStuck(', '\nasync function cronFinalizeSource(');
  const m3u = section(watchdog, 'if (sourceType === "m3u")', '\n    // Resume discovery');

  assert.match(m3u, /importStep\.status === "done"/);
  assert.match(m3u, /Number\.isSafeInteger\(importedTotal\) && importedTotal > 0/);
  const directFinalizeAt = m3u.indexOf('driveFinalizeToReady(');
  const providerClaimAt = m3u.indexOf('claimM3uSyncLease(');
  assert.ok(directFinalizeAt >= 0 && providerClaimAt > directFinalizeAt);
  assert.match(m3u, /if \(inM3uFinalize\)[\s\S]*continue;[\s\S]*claimM3uSyncLease/);
});

test('migration repairs only completed raw M3U imports and clears quarantine', () => {
  assert.match(migration, /source\.source_type = 'm3u'/);
  assert.match(migration, /syncProgress'->'steps'->'import'->>'status' = 'done'/);
  assert.match(migration, /jsonb_typeof\(source\.config_hint->'syncProgress'->'counts'->'total'\) = 'number'/);
  assert.match(migration, /jsonb_build_object\('phase', 'live', 'offset', 0, 'afterId', ''\)/);
  assert.match(migration, /'updatedAt', '1970-01-01T00:00:00\.000Z'/);
  assert.match(migration, /on conflict \(source_id\) do update[\s\S]*state = 'idle'[\s\S]*attempt_count = 0/);
  assert.match(migration, /M3U finalization recovery invariant failed/);
  assert.doesNotMatch(migration, /@[a-z0-9.-]+|playlistUrl|config_ciphertext\s*=/i);
});

test('READY is a fail-safe settlement boundary for the M3U transport lease', () => {
  assert.match(migration, /create or replace function public\.norva_settle_m3u_transport_on_ready\(\)/i);
  assert.match(migration, /new\.source_type <> 'm3u'[\s\S]*new\.sync_status <> 'ready'/i);
  assert.match(migration, /update public\.cloud_source_m3u_sync_leases[\s\S]*state = 'idle'[\s\S]*attempt_count = 0/i);
  assert.match(migration, /before update of sync_status[\s\S]*execute function public\.norva_settle_m3u_transport_on_ready\(\)/i);
});

test('every Edge replica must prove the M3U finalization protocol', () => {
  assert.match(worker, /version:\s*18[\s\S]*m3uFinalizeResumeProtocol:\s*1/);
  assert.match(deploy, /EXPECTED_SOURCE_SYNC_VERSION=18/);
  assert.match(deploy, /EXPECTED_M3U_FINALIZE_RESUME_PROTOCOL=1/);
  assert.match(deploy, /m3uFinalizeResumeProtocol/);
});
