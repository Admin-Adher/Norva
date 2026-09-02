const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260901143000_source_reenable_enrichment_wake_v1.sql',
), 'utf8');
const selfHostedResumeCronMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260901181000_source_resume_stuck_selfhost_cron_v1.sql',
), 'utf8');
const cloud = fs.readFileSync(path.join(
  root,
  'supabase/functions/norva-cloud/index.ts',
), 'utf8');
const activeCandidates = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260901143100_file_audio_candidates_active_generation_v1.sql',
), 'utf8');
const autoRefreshM3uQuarantineMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260901143250_cloud_auto_refresh_m3u_quarantine_v1.sql',
), 'utf8');
const sourceSync = fs.readFileSync(path.join(
  root,
  'supabase/functions/norva-source-sync/index.ts',
), 'utf8');
const xtreamSync = fs.readFileSync(path.join(
  root,
  'supabase/functions/_shared/xtream-sync.ts',
), 'utf8');
const liveMaterialization = fs.readFileSync(path.join(
  root,
  'supabase/functions/_shared/live-materialization.ts',
), 'utf8');
const deployEdge = fs.readFileSync(path.join(
  root,
  'ops/hetzner/scripts/04-deploy-edge-functions.sh',
), 'utf8');
const sourcePublicView = fs.readFileSync(path.join(
  root,
  'supabase/functions/_shared/source-public-view.mjs',
), 'utf8');

test('source re-enable wake is tenant-bound, lane-zeroed and lease-safe', () => {
  assert.match(migration, /new\.user_id is distinct from old\.user_id/);
  assert.match(migration, /new\.sync_status <> 'ready'/);
  assert.match(migration, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.doesNotMatch(migration, /from public\.cloud_title_variants variant/);
  assert.match(migration, /variant\.source_id = new\.id/);
  assert.match(migration, /variant\.user_id = new\.user_id/);
  assert.match(migration, /schedule\.dispatch_count - mod\(schedule\.dispatch_count, 12\)/);
  assert.match(migration, /schedule\.lease_until is null or schedule\.lease_until <= v_now/);
  assert.match(migration, /new\.user_id::text \|\| ':' \|\| new\.id::text \|\| ':movie:probe'/);
  assert.match(migration, /new\.user_id::text \|\| ':' \|\| new\.id::text \|\| ':movie:whisper-untagged'/);
});

test('source re-enable durably schedules discovery/finalize/M3U before the CAS returns', () => {
  assert.match(migration, /create or replace function public\.norva_schedule_source_sync_resume_when_enabled\(\)/);
  assert.match(migration, /before update of enabled, sync_status, deleted_at/);
  assert.match(migration, /new\.user_id is distinct from old\.user_id/);
  assert.match(migration, /not coalesce\(new\.enabled, false\)[\s\S]*coalesce\(old\.enabled, false\)[\s\S]*new\.deleted_at is not null/);
  assert.match(migration, /v_cursor->>'active' = 'true'[\s\S]*v_cursor->>'phase' = 'discover'/);
  assert.match(migration, /jsonb_set\(v_cursor, '\{attempts\}', '0'::jsonb, true\)/);
  assert.match(migration, /jsonb_set\(v_cursor, '\{heartbeatAt\}', to_jsonb\(v_due_at\), true\)/);
  assert.match(migration, /v_finalize_resume[\s\S]*jsonb_set\(v_progress, '\{updatedAt\}', to_jsonb\(v_due_at\), true\)/);
  assert.match(migration, /new\.source_type = 'xtream'[\s\S]*'runVersion', floor\(extract\(epoch from v_now\) \* 1000\)::bigint/);
  assert.match(migration, /M3U imports are single-isolate[\s\S]*new\.sync_status := 'syncing'[\s\S]*'"queued"'::jsonb/);
  assert.match(migration, /jobname = 'norva-resume-stuck-sync'/);
  assert.match(migration, /source\.source_type in \('xtream', 'm3u'\)/);
  assert.match(migration, /cron\.schedule\([\s\S]*'norva-resume-stuck-sync'[\s\S]*'\* \* \* \* \*'/);
  assert.match(migration, /source\.enabled[\s\S]*source\.deleted_at is null/);
  assert.match(migration, /exactly one active norva-resume-stuck-sync job is required/);
  assert.match(migration, /exactly one non-empty norva_cron_shared_secret is required/);
});

test('source re-enable wake remains service-owned', () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.norva_wake_source_enrichment_when_ready\(\)[\s\S]*from public, anon, authenticated/);
});

test('re-enabling an interrupted source resumes its durable sync cursor', () => {
  const start = cloud.indexOf('async function setSourceEnabled(');
  const end = cloud.indexOf('async function testSourceConnection(', start);
  assert.ok(start >= 0 && end > start);
  const body = cloud.slice(start, end);
  assert.match(body, /hasDesiredState && typeof body\.enabled !== "boolean"/);
  assert.match(body, /select\("enabled,source_type,sync_status,deleted_at"\)/);
  assert.match(body, /\.is\("deleted_at", null\)/);
  assert.match(body, /\.eq\("enabled", current\)/);
  assert.match(body, /if \(current === desired\)/);
  assert.match(body, /const sourceType = stringOr/);
  assert.match(body, /const syncScheduled = desired && \(syncStatus !== "ready" \|\| sourceType === "m3u"\)/);
  assert.match(body, /const desired = hasDesiredState \? body\.enabled === true : !current/);
  assert.match(body, /legacyToggle,/);
  assert.match(body, /syncStarted: syncScheduled/);
  assert.match(body, /syncScheduled,/);
  assert.doesNotMatch(body, /waitUntil\(/);
  assert.doesNotMatch(body, /syncCloudSource\(/);
});

test('desired-state retry survives winner isolate loss and watchdog resumes exactly once', () => {
  const transition = (state, desired, expected) => {
    if (state.enabled !== expected) return false;
    state.enabled = desired;
    if (desired && state.syncStatus !== 'ready') {
      state.cursor.attempts = 0;
      state.cursor.heartbeatAt = '1970-01-01T00:00:00.000Z';
      state.durableDue = true;
    }
    return true;
  };
  const watchdog = (state) => {
    if (!state.enabled || !state.durableDue || state.workerActive) return false;
    state.workerActive = true;
    state.durableDue = false;
    state.resumeRuns += 1;
    return true;
  };
  const state = {
    enabled: false,
    syncStatus: 'syncing',
    cursor: { attempts: 37, heartbeatAt: '2026-09-01T00:00:00.000Z' },
    durableDue: false,
    workerActive: false,
    resumeRuns: 0,
  };
  assert.equal(transition(state, true, false), true);
  // The winning HTTP isolate disappears here: no in-memory callback runs.
  assert.equal(transition(state, true, false), false);
  assert.equal(state.cursor.attempts, 0);
  assert.equal(state.cursor.heartbeatAt, '1970-01-01T00:00:00.000Z');
  assert.equal(watchdog(state), true);
  assert.equal(watchdog(state), false);
  assert.equal(state.resumeRuns, 1);
  assert.match(cloud, /if \(!data\)[\s\S]*if \(\(latest as JsonRecord\)\.enabled !== desired\)[\s\S]*SOURCE_STATE_CONFLICT/);
});

test('durable watchdog resumes both Xtream cursors and bounded M3U imports', () => {
  const start = sourceSync.indexOf('async function cronResumeStuck(');
  const end = sourceSync.indexOf('// Service-authed entry point', start);
  assert.ok(start >= 0 && end > start);
  const body = sourceSync.slice(start, end);
  assert.match(body, /\.from\("cloud_catalog_visible_sources"\)/);
  assert.match(body, /\.select\("id,user_id,source_type,sync_status,config_hint"\)/);
  assert.match(body, /\.in\("source_type", \["xtream", "m3u"\]\)/);
  assert.match(body, /sourceType === "m3u"[\s\S]*runInBackground\(syncCloudSource\([\s\S]*rawOnly: false/);
  const m3uBranch = body.slice(body.indexOf('if (sourceType === "m3u")'), body.indexOf('// Resume discovery'));
  assert.ok(m3uBranch.indexOf('claimM3uSyncLease(') < m3uBranch.indexOf('runInBackground(syncCloudSource('));
  assert.ok(m3uBranch.indexOf('if (!claim.claimed) continue') < m3uBranch.indexOf('resumed.push('));
  assert.match(m3uBranch, /m3uLease:\s*\{[\s\S]*token: leaseToken[\s\S]*attemptCount: claim\.attemptCount/);
  assert.match(body, /resumed\.length >= 5/);
  const syncStart = sourceSync.indexOf('async function syncCloudSource(');
  const syncEnd = sourceSync.indexOf('// Run a promise to completion', syncStart);
  const sync = sourceSync.slice(syncStart, syncEnd);
  assert.ok(sync.indexOf('claimM3uSyncLease(') < sync.indexOf('decryptSourceConfig('));
  assert.doesNotMatch(sync, /source\.source_type === "m3u" && !opts\.rawOnly/);
  const rawOnlyStart = sync.indexOf('if (opts.rawOnly)');
  const fullProgressStart = sync.indexOf('let progress:', rawOnlyStart);
  const rawOnly = sync.slice(rawOnlyStart, fullProgressStart);
  assert.match(rawOnly, /assertM3uSyncLeaseCurrent\([\s\S]*settleM3uSyncLease\([\s\S]*"success"/);
  assert.match(rawOnly, /catch \(error\)[\s\S]*classifyM3uSyncFailure\([\s\S]*settleM3uSyncLease/);
  assert.match(sync, /assertM3uSyncLeaseCurrent\([\s\S]*syncM3uSource\(/);
  assert.match(sync, /settleM3uSyncLease\([\s\S]*"success"/);
});

test('M3U sync ownership is a service-only CAS lease with bounded recovery', () => {
  assert.match(migration, /create table if not exists public\.cloud_source_m3u_sync_leases/);
  assert.match(migration, /state in \('idle', 'running', 'retry_wait', 'quarantined'\)/);
  assert.match(migration, /attempt_count between 0 and 4/);
  assert.match(migration, /create or replace function public\.norva_claim_source_m3u_sync_lease/);
  assert.match(migration, /create or replace function public\.norva_claim_source_m3u_diagnostic_lease/);
  assert.match(migration, /for update;[\s\S]*v_lease\.state = 'running'[\s\S]*v_lease\.lease_until > v_now/);
  assert.match(migration, /when 1 then interval '1 minute'[\s\S]*when 2 then interval '5 minutes'[\s\S]*else interval '15 minutes'/);
  assert.match(migration, /p_outcome = 'permanent_error' or v_lease\.attempt_count >= 4[\s\S]*v_state := 'quarantined'/);
  assert.match(migration, /delete from public\.cloud_source_m3u_sync_leases lease[\s\S]*lease\.source_id = new\.id/);
  assert.match(migration, /create or replace function public\.norva_reset_m3u_sync_lease_after_config_change/);
  assert.match(migration, /new\.config_ciphertext is distinct from old\.config_ciphertext/);
  assert.match(migration, /reset_after_release = true[\s\S]*lease\.state = 'running'[\s\S]*lease\.lease_until > v_now/);
  assert.match(migration, /if new\.sync_status = 'ready' then[\s\S]*return new/);
  assert.match(migration, /v_reenabled_m3u boolean := new\.source_type = 'm3u'[\s\S]*not coalesce\(old\.enabled, false\)/);
  assert.match(migration, /before update of config_ciphertext, sync_status, enabled/);
  assert.match(migration, /when v_reenabled_m3u then 'source_reenabled'/);
  assert.match(migration, /when v_config_changed or v_reenabled_m3u then clock_timestamp\(\)/);
  assert.match(migration, /revoke all on table public\.cloud_source_m3u_sync_leases[\s\S]*service_role/);
  assert.match(migration, /grant execute on function public\.norva_claim_source_m3u_sync_lease[\s\S]*to service_role/);
  assert.match(migration, /revoke all on function public\.norva_claim_source_m3u_diagnostic_lease[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.norva_claim_source_m3u_diagnostic_lease[\s\S]*to service_role/);

  const renewStart = migration.indexOf('create or replace function public.norva_renew_source_m3u_sync_lease');
  const settleStart = migration.indexOf('create or replace function public.norva_settle_source_m3u_sync_lease');
  const grantsStart = migration.indexOf('revoke all on function public.norva_claim_source_m3u_sync_lease');
  const renew = migration.slice(renewStart, settleStart);
  const settle = migration.slice(settleStart, grantsStart);
  assert.ok(renew.indexOf('from public.cloud_sources source') < renew.indexOf('update public.cloud_source_m3u_sync_leases lease'));
  assert.ok(settle.indexOf('from public.cloud_sources source') < settle.indexOf('from public.cloud_source_m3u_sync_leases lease'));
});

test('every existing-source M3U provider read shares the durable lease', () => {
  const syncStart = cloud.indexOf('async function syncCloudSource(');
  const syncEnd = cloud.indexOf('type FinalizeCloudSourceOptions', syncStart);
  const legacySync = cloud.slice(syncStart, syncEnd);
  assert.ok(legacySync.indexOf('claimM3uSyncLease(') < legacySync.indexOf('decryptSourceConfig('));
  assert.match(legacySync, /assertM3uSyncLeaseCurrent\([\s\S]*syncM3uSource\(/);
  assert.match(legacySync, /settleM3uSyncLease\([\s\S]*"success"/);
  assert.match(legacySync, /M3U_SYNC_LEASE_LOST[\s\S]*"cancelled"[\s\S]*return/);
  assert.match(legacySync, /m3uLeaseNextHeartbeatAt[\s\S]*heartbeatM3uSyncLease/);

  const testStart = cloud.indexOf('async function testSourceConnection(');
  const testEnd = cloud.indexOf('// Per-source sync status', testStart);
  assert.match(cloud.slice(testStart, testEnd), /type === "m3u"[\s\S]*withM3uSourceLease/);

  const estimateStart = cloud.indexOf('async function estimateSource(');
  const estimateEnd = cloud.indexOf('async function estimateSourceByUrl(', estimateStart);
  assert.match(cloud.slice(estimateStart, estimateEnd), /withM3uSourceLease\([\s\S]*estimateM3uPlaylist/);

  assert.match(liveMaterialization, /heartbeat\?: \(\) => Promise<void>/);
  assert.match(liveMaterialization, /clearLiveMaterialization\([\s\S]*input\.heartbeat/);
  assert.match(liveMaterialization, /chunkSize: 10,[\s\S]*heartbeat/);
  assert.match(liveMaterialization, /for \(let index = 0; index < rows\.length; index \+= chunkSize\)[\s\S]*await options\.heartbeat\?\.\(\)/);
});

test('legacy M3U sync adapters restore pre-claim state only after bounded refusal', () => {
  const helperStart = cloud.indexOf('type LegacyM3uClaimRestore');
  const helperEnd = cloud.indexOf('async function syncExistingSource(', helperStart);
  const syncStart = cloud.indexOf('async function syncExistingSource(');
  const syncEnd = cloud.indexOf('async function setSourceEnabled(', syncStart);
  const hardStart = cloud.indexOf('async function hardSyncSource(');
  const hardEnd = cloud.indexOf('function buildSourceConfig(', hardStart);
  const workerStart = cloud.indexOf('async function syncCloudSource(');
  const workerEnd = cloud.indexOf('type FinalizeCloudSourceOptions', workerStart);
  const helper = cloud.slice(helperStart, helperEnd);
  const sync = cloud.slice(syncStart, syncEnd);
  const hard = cloud.slice(hardStart, hardEnd);
  const worker = cloud.slice(workerStart, workerEnd);
  assert.match(helper, /\.eq\("id", sourceId\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.eq\("source_type", "m3u"\)[\s\S]*\.eq\("sync_status", "syncing"\)[\s\S]*\.eq\("updated_at", restore\.expectedUpdatedAt\)/);
  assert.match(sync, /select\("source_type,sync_status,sync_error,updated_at"\)/);
  assert.match(sync, /\.eq\("updated_at", String\(prior\.updated_at\)\)[\s\S]*\.select\("id,updated_at"\)/);
  assert.match(sync, /patch:[\s\S]*sync_status: stringOr\(prior\.sync_status[\s\S]*sync_error:/);
  assert.match(hard, /const priorHint = recordOrEmpty/);
  assert.match(hard, /const hint = \{ \.\.\.priorHint \}/);
  assert.match(hard, /config_hint: priorHint/);
  assert.match(hard, /\.eq\("updated_at", String\(cur\.updated_at\)\)[\s\S]*\.select\("id,updated_at"\)/);
  assert.match(worker, /legacyRestore && \["backoff", "quarantined"\]\.includes\(claim\.reason\)/);
  assert.doesNotMatch(worker, /\["leased",\s*"backoff",\s*"quarantined"\]/);
  assert.ok(worker.indexOf('if (!claim.claimed)') < worker.indexOf('m3uLeaseToken = candidateToken'));
});

test('M3U refusal is never reported as a successful sync or auto-refresh', () => {
  const claimRefusalStart = sourceSync.indexOf('function m3uSyncClaimRefusal(');
  const claimRefusalEnd = sourceSync.indexOf('const M3U_SYNC_LEASE_TTL_SECONDS', claimRefusalStart);
  const workerStart = sourceSync.indexOf('async function syncCloudSource(');
  const workerEnd = sourceSync.indexOf('// Run a promise to completion', workerStart);
  const cronStart = sourceSync.indexOf('async function cronRefreshDue(');
  const cronEnd = sourceSync.indexOf('async function cronResumeStuck(', cronStart);
  const refusal = sourceSync.slice(claimRefusalStart, claimRefusalEnd);
  const worker = sourceSync.slice(workerStart, workerEnd);
  const cron = sourceSync.slice(cronStart, cronEnd);
  assert.match(refusal, /M3U_SYNC_BUSY/);
  assert.match(refusal, /M3U_SYNC_BACKOFF/);
  assert.match(refusal, /M3U_SYNC_QUARANTINED/);
  assert.match(refusal, /M3U_SYNC_UNAVAILABLE/);
  assert.match(worker, /if \(!claim\.claimed\) \{[\s\S]*throw m3uSyncClaimRefusal\(claim\)/);
  assert.match(sourceSync, /code === "M3U_SYNC_QUARANTINED"[\s\S]*outcome: "action_required"/);
  assert.match(sourceSync, /code === "M3U_SYNC_BUSY" \|\| code === "M3U_SYNC_BACKOFF"[\s\S]*outcome: "transient_failure"/);
  assert.match(cron, /await syncCloudSource\([\s\S]*rawOnly: true[\s\S]*await settleCloudAutoRefreshClaim\(db, job, worker, "success"\)[\s\S]*catch \(error\)/);
  for (const code of ['M3U_SYNC_BUSY', 'M3U_SYNC_BACKOFF', 'M3U_SYNC_QUARANTINED', 'M3U_SYNC_UNAVAILABLE']) {
    assert.match(sourceSync, new RegExp(`"${code}"`));
    assert.match(sourcePublicView, new RegExp(`"${code}"`));
  }
});

test('fair auto-refresh settles only the exact M3U quarantine action', () => {
  assert.match(autoRefreshM3uQuarantineMigration, /p_http_status = 409 and p_error_kind = 'm3u_quarantined'/);
  assert.match(autoRefreshM3uQuarantineMigration, /p_error_kind = 'm3u_quarantined' or v_terminal_count >= 2/);
  assert.match(autoRefreshM3uQuarantineMigration, /when p_error_kind = 'm3u_quarantined' then 'TOGGLE_SOURCE'/);
  assert.match(autoRefreshM3uQuarantineMigration, /auto_refresh_lease_owner = null[\s\S]*auto_refresh_lease_expires_at = null/);
  assert.match(autoRefreshM3uQuarantineMigration, /revoke all on function public\.norva_settle_cloud_auto_refresh_source[\s\S]*from public, anon, authenticated/);
  assert.match(autoRefreshM3uQuarantineMigration, /grant execute on function public\.norva_settle_cloud_auto_refresh_source[\s\S]*to service_role/);
  assert.doesNotMatch(autoRefreshM3uQuarantineMigration, /40001/);
  assert.match(autoRefreshM3uQuarantineMigration, /cloud auto refresh lease is stale'[\s\S]*errcode = 'PT409'/);
});

test('source resume watchdog is repaired onto the canonical self-hosted ingress', () => {
  assert.match(
    selfHostedResumeCronMigration,
    /https:\/\/api\.norva\.tv\/functions\/v1\/norva-source-sync\/cron\/resume-stuck/,
  );
  assert.doesNotMatch(
    selfHostedResumeCronMigration,
    /url := 'https:\/\/oupsceccxsonaalhueff\.supabase\.co/,
  );
  assert.match(selfHostedResumeCronMigration, /pg_advisory_xact_lock/);
  assert.match(selfHostedResumeCronMigration, /v_job_count > 1/);
  assert.match(
    selfHostedResumeCronMigration,
    /jobname in \('norva-resume-stuck-sync', 'norva-resume-stuck'\)[\s\S]*command like '%\/norva-source-sync\/cron\/resume-stuck%'/,
  );
  assert.match(selfHostedResumeCronMigration, /cron\.alter_job\([\s\S]*command => v_command[\s\S]*\);/);
  assert.doesNotMatch(
    selfHostedResumeCronMigration,
    /cron\.alter_job\([\s\S]*active => true[\s\S]*\);/,
  );
});

test('quiesced deploy proves the installed M3U quarantine settlement body, not only its legacy signature', () => {
  assert.match(deployEdge, /public\.norva_settle_cloud_auto_refresh_source\(uuid,uuid,text,bigint,text,timestamptz,integer,text\)/);
  assert.match(deployEdge, /pg_get_functiondef\(to_regprocedure\('public\.norva_settle_cloud_auto_refresh_source\(uuid,uuid,text,bigint,text,timestamptz,integer,text\)'\)\)/);
  assert.match(deployEdge, /position\('p_outcome is null' in definition\) > 0/);
  assert.match(deployEdge, /position\('p_http_status is null' in definition\) > 0/);
  assert.match(deployEdge, /position\('p_error_kind is null' in definition\) > 0/);
  assert.match(deployEdge, /position\('p_outcome = ''action_required''' in definition\) > 0/);
  assert.match(deployEdge, /position\('p_http_status = 409 and p_error_kind = ''m3u_quarantined''' in definition\) > 0/);
  assert.match(deployEdge, /position\('when p_error_kind = ''m3u_quarantined'' then ''toggle_source''' in definition\) > 0/);
  assert.match(deployEdge, /\[\[ "\$auto_refresh_settle_contract_ready" == "t" \]\]/);
});

test('scheduled syncs stop before provider I/O when enable/delete/visibility changes', () => {
  const helperStart = cloud.indexOf('async function sourceSyncIoAllowed(');
  const syncStart = cloud.indexOf('async function syncCloudSource(', helperStart);
  const syncEnd = cloud.indexOf('type FinalizeCloudSourceOptions', syncStart);
  assert.ok(helperStart >= 0 && syncStart > helperStart && syncEnd > syncStart);
  const helper = cloud.slice(helperStart, syncStart);
  const body = cloud.slice(syncStart, syncEnd);
  assert.match(helper, /\.from\("cloud_catalog_visible_sources"\)/);
  assert.match(helper, /\.eq\("id", sourceId\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.eq\("enabled", true\)[\s\S]*\.is\("deleted_at", null\)/);
  assert.ok(body.indexOf('sourceSyncIoAllowed(sourceId, userId, db)') < body.indexOf('decryptSourceConfig('));
  assert.ok(body.lastIndexOf('sourceSyncIoAllowed(sourceId, userId, db)', body.indexOf('const result =')) < body.indexOf('const result ='));
  assert.match(body, /\.from\("cloud_sources"\)[\s\S]*\.eq\("enabled", true\)[\s\S]*\.is\("deleted_at", null\)/);

  const sourceSyncStart = sourceSync.indexOf('async function syncCloudSource(');
  const sourceSyncEnd = sourceSync.indexOf('// Run a promise to completion', sourceSyncStart);
  const durableWorker = sourceSync.slice(sourceSyncStart, sourceSyncEnd);
  assert.match(durableWorker, /\.eq\("enabled", true\)[\s\S]*\.is\("deleted_at", null\)/);
  assert.match(durableWorker, /await assertCatalogVisible\(sourceId, userId, db\)/);

  const driverStart = xtreamSync.indexOf('export async function driveXtreamSyncToReady(');
  const driver = xtreamSync.slice(driverStart);
  assert.match(driver, /\.from\("cloud_sources"\)[\s\S]*\.eq\("enabled", true\)[\s\S]*\.is\("deleted_at", null\)/);
  const fetchCatalog = driver.indexOf('const fetchCatalog = async');
  const providerFetch = driver.indexOf('fetchProviderMetadata(', fetchCatalog);
  assert.ok(fetchCatalog >= 0 && providerFetch > fetchCatalog);
  assert.ok(driver.lastIndexOf('assertCatalogSnapshotCurrent(', providerFetch) < providerFetch);
});

test('file repair candidates come only from the tenant-visible active generation', () => {
  assert.match(activeCandidates, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.doesNotMatch(activeCandidates, /from public\.cloud_title_variants variant/);
  assert.match(activeCandidates, /variant\.user_id = p_user/);
  assert.match(activeCandidates, /p_source is null or variant\.source_id = p_source/);
  assert.match(activeCandidates, /head\.active_generation_id is not null[\s\S]*variant\.generation_id = head\.active_generation_id/);
  assert.match(activeCandidates, /head\.active_generation_id is null[\s\S]*variant\.generation_id is null/);
  assert.match(activeCandidates, /limit greatest\(1, least\(300, coalesce\(p_limit, 25\)\)\)/);
  assert.match(activeCandidates, /security definer/);
  assert.match(activeCandidates, /set search_path = ''/);
  assert.match(activeCandidates, /from public, anon, authenticated/);
  assert.match(activeCandidates, /to service_role/);
});

test('production health and deploy verification expose the source resume protocols', () => {
  assert.match(cloud, /version:\s*27/);
  assert.match(cloud, /sourceDesiredStateProtocol:\s*1/);
  assert.match(cloud, /legacySourceToggleBridge:\s*1/);
  assert.match(cloud, /m3uSyncLeaseProtocol:\s*2/);
  assert.match(sourceSync, /version:\s*17/);
  assert.match(sourceSync, /sourceReenableResumeProtocol:\s*1/);
  assert.match(sourceSync, /m3uSyncLeaseProtocol:\s*2/);
  assert.match(sourceSync, /fileAudioRepairCohortProtocol:\s*2/);
  assert.match(deployEdge, /EXPECTED_CLOUD_VERSION=27/);
  assert.match(deployEdge, /EXPECTED_SOURCE_SYNC_VERSION=17/);
  assert.match(deployEdge, /sourceDesiredStateProtocol/);
  assert.match(deployEdge, /legacySourceToggleBridge/);
  assert.match(deployEdge, /sourceReenableResumeProtocol/);
  assert.match(deployEdge, /m3uSyncLeaseProtocol/);
  assert.match(deployEdge, /fileAudioRepairCohortProtocol/);
  assert.match(deployEdge, /to_regprocedure\(signature\) is not null/);
  assert.match(deployEdge, /catalog_file_audio_repair_candidates\(uuid,uuid,integer\)/);
  assert.match(deployEdge, /norva_start_catalog_file_audio_repair_attempt\(uuid,uuid,uuid,uuid\)/);
  assert.match(deployEdge, /norva_defer_catalog_file_audio_repair_candidate\(uuid,uuid,uuid,uuid,text,integer\)/);
  assert.match(deployEdge, /start_automatic_catalog_file_audio_validation_job\(uuid,uuid,uuid,text,text,text,integer\[\],jsonb,text,timestamptz,bigint,jsonb,boolean\)/);
  assert.match(deployEdge, /required quiesced Edge deployment cannot run without Docker and the Compose file/);
});
