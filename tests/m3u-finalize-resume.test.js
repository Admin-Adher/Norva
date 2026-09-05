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
const completeVariantsMigration = read('supabase/migrations/20260903173000_m3u_complete_live_variants_v1.sql');
const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

test('M3U raw import hands projection to the durable finalizer', () => {
  const m3u = section(worker, 'async function syncM3uSource(', '\nasync function replaceSourceItems(');

  assert.match(m3u, /replaceSourceItems\([\s\S]*stage:\s*"finalizing"[\s\S]*finalizePending:\s*true/);
  assert.match(m3u, /liveCatalog:\s*\{\s*rawLive:\s*liveCount,\s*pending:\s*true\s*\}/);
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
  assert.match(persist, /finalizeCursor:\s*\{ phase: hasVod \? "titles" : "live", offset: 0, afterId: "" \}/);
  assert.match(persist, /const hasVod = Number\(counts.movies \|\| 0\) > 0 \|\| Number\(counts.series \|\| 0\) > 0/);
  assert.match(persist, /moviesReady: false, seriesReady: false, browseReady: false/);
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
  assert.match(worker, /version:\s*19[\s\S]*m3uFinalizeResumeProtocol:\s*1[\s\S]*m3uCompleteLiveVariantsProtocol:\s*1/);
  assert.match(deploy, /EXPECTED_SOURCE_SYNC_VERSION=19/);
  assert.match(deploy, /EXPECTED_M3U_FINALIZE_RESUME_PROTOCOL=1/);
  assert.match(deploy, /EXPECTED_M3U_COMPLETE_LIVE_VARIANTS_PROTOCOL=1/);
  assert.match(deploy, /m3uFinalizeResumeProtocol/);
  assert.match(deploy, /m3uCompleteLiveVariantsProtocol/);
  assert.match(deploy, /shared live-catalog source digest mismatch/);
});

test('variant repair requeues only READY M3U catalogues with a concrete-stream deficit', () => {
  assert.match(completeVariantsMigration, /source\.source_type = 'm3u'/);
  assert.match(completeVariantsMigration, /source\.sync_status = 'ready'/);
  assert.match(completeVariantsMigration, /raw_count\.value > variant_count\.value/);
  assert.match(completeVariantsMigration, /'finalizeCursor', jsonb_build_object\([\s\S]*'phase', 'live'[\s\S]*'offset', 0/);
  assert.match(completeVariantsMigration, /source\.sync_status <> 'syncing'/);
  assert.match(completeVariantsMigration, /M3U concrete live variant rebuild invariant failed/);
  assert.doesNotMatch(completeVariantsMigration, /@[a-z0-9.-]+|12917|config_ciphertext\s*=/i);
});
