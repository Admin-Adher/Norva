'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const playback = read('supabase/functions/norva-playback/index.ts');
const mainRouter = read('supabase/functions/main/index.ts');
const migration = read('supabase/migrations/20260816105918_async_vod_language_validation_jobs.sql');
const presenceMigration = read('supabase/migrations/20260816141150_provider_account_foreground_presence.sql');
const activityMigration = read('supabase/migrations/20260816171003_provider_account_language_validation_activity.sql');
const edgeDeploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('POST starts quickly and GET polls one caller-owned durable job', () => {
  const routes = between(
    playback,
    'segments[1] === "language-validation"',
    'if (req.method === "POST" && segments[0] === "playback" && segments[1] === "events")',
  );
  const start = between(
    playback,
    'async function startPlaybackLanguageValidation(',
    '\nfunction exactLanguageValidationIndices(',
  );
  const poll = between(
    playback,
    'async function getPlaybackLanguageValidation(',
    '\nfunction requireLanguageValidationWaitUntil(',
  );

  assert.match(routes, /!segments\[2\][\s\S]*requireIdentity\(req, supabase\)/);
  assert.match(routes, /req\.method === "GET"[\s\S]*segments\[2\][\s\S]*requireIdentity\(req, supabase\)/);
  assert.match(start, /new Set\(\["sourceId", "itemType", "itemId", "expectedAudioIndices"\]\)/);
  assert.match(start, /assertOwnedSource\(sourceId, userId, db\)/);
  assert.match(start, /requireLanguageValidationEntitlement\(userId, db\)/);
  assert.match(start, /sameIntegerSet\(expectedAudioIndices, exactAudioIndices\)/);
  assert.match(start, /"start_catalog_file_audio_validation_job"/);
  assert.match(start, /scheduleLanguageValidationJob\(waitUntil, db, jobId\)/);
  assert.match(start, /status: 202/);
  assert.match(poll, /eq\("requested_by", userId\)/);
  assert.match(poll, /assertOwnedSource\(sourceId, userId, db\)/);
  assert.match(poll, /requireLanguageValidationEntitlement\(userId, db\)/);
  assert.match(poll, /scheduleLanguageValidationJob\(waitUntil, db, jobId\)/);
});

test('foreground validation ignores presence intent but still blocks real provider activity', () => {
  const idle = between(
    playback,
    'async function assertLanguageValidationIdle(',
    '\nfunction strictLanguageValidationEvidence(',
  );
  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationJob(',
  );
  const create = between(
    playback,
    'async function createPlaybackSession(',
    '\nasync function getPlaybackSession(',
  );

  assert.match(idle, /from\("cloud_playback_sessions"\)[\s\S]*eq\("user_id", userId\)/);
  assert.match(idle, /from\("cloud_playback_sessions"\)[\s\S]*eq\("provider_account_hash", providerAccountHash\)/);
  assert.match(idle, /rpc\(\s*"provider_account_busy_for_foreground_validation"/);
  assert.match(idle, /providerBusy !== false/);
  assert.doesNotMatch(idle, /from\("provider_account_activity"\)/);
  assert.doesNotMatch(idle, /rpc\(\s*"provider_account_busy"/);
  assert.equal((worker.match(/await assertLanguageValidationIdle\(/g) || []).length, 2);
  assert.ok(worker.indexOf('await assertLanguageValidationIdle(') < worker.indexOf('"claim_provider_file_probe"'));
  assert.ok(worker.lastIndexOf('await assertLanguageValidationIdle(') > worker.indexOf('"claim_provider_file_probe"'));
  assert.ok(
    worker.indexOf('"claim_provider_account_language_validation"')
      < worker.indexOf('"claim_provider_file_probe"'),
  );
  assert.match(worker, /release_provider_account_language_validation/);
  assert.match(playback, /LANGUAGE_VALIDATION_ACCOUNT_LEASE_SECONDS = LANGUAGE_VALIDATION_LEASE_SECONDS/);
  assert.match(playback, /const LANGUAGE_VALIDATION_TASK_BUDGET_MS = 270_000/);
  assert.match(playback, /const LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS = 30_000/);
  assert.match(playback, /const LANGUAGE_VALIDATION_JOB_LEASE_SECONDS = 300/);
  assert.match(playback, /const LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS = 20/);
  const taskBudgetMs = Number(
    playback.match(/const LANGUAGE_VALIDATION_TASK_BUDGET_MS = ([\d_]+)/)?.[1].replaceAll('_', ''),
  );
  const fetchTimeoutMs = Number(
    playback.match(/const LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS = ([\d_]+)/)?.[1].replaceAll('_', ''),
  );
  const postFetchReserveMs = Number(
    playback.match(/const LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS = ([\d_]+)/)?.[1].replaceAll('_', ''),
  );
  const jobLeaseSeconds = Number(
    playback.match(/const LANGUAGE_VALIDATION_JOB_LEASE_SECONDS = (\d+)/)?.[1],
  );
  const providerLeaseSeconds = Number(
    playback.match(/const LANGUAGE_VALIDATION_LEASE_SECONDS = (\d+)/)?.[1],
  );
  assert.ok(
    fetchTimeoutMs + postFetchReserveMs <= taskBudgetMs
      && taskBudgetMs / 1000 < jobLeaseSeconds
      && jobLeaseSeconds < providerLeaseSeconds,
    'fetch, cleanup reserve, task, durable claim and provider lease must remain strictly nested',
  );
  assert.match(worker, /const taskDeadlineAt = Date\.now\(\) \+ LANGUAGE_VALIDATION_TASK_BUDGET_MS/);
  assert.match(worker, /languageValidationFetchBudgetMs\(taskDeadlineAt\)/);
  assert.equal(
    (worker.match(/"claim_catalog_file_audio_validation_job"/g) || []).length,
    2,
    'the same-owner durable claim is renewed immediately before provider leasing',
  );
  assert.match(worker, /const \{ data: renewed, error: renewError \}[\s\S]*p_lease_owner: leaseOwner[\s\S]*renewedClaim\.trackIndex[\s\S]*renewedClaim\.profileFingerprint/);
  assert.ok(
    worker.indexOf('const { data: renewed, error: renewError }')
      < worker.indexOf('"claim_provider_account_language_validation"'),
    'stale job ownership must fail before claiming the provider account',
  );
  assert.match(worker, /AbortSignal\.timeout\(fetchBudgetMs\)/);
  assert.match(worker, /LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED[\s\S]*retryAt:/);
  assert.match(worker, /LANGUAGE_VALIDATION_GATEWAY_TIMEOUT[\s\S]*LANGUAGE_VALIDATION_GATEWAY_TRANSPORT[\s\S]*retryAt:/);
  assert.match(
    worker,
    /providerAccountLeaseReleaseSafe = false[\s\S]*await fetch[\s\S]*await response\.text\(\)[\s\S]*JSON\.parse\(responseText\)[\s\S]*providerAccountLeaseReleaseSafe = strictLanguageProviderDrainAttested\(payload\)/,
  );
  assert.doesNotMatch(
    worker.slice(worker.indexOf('await response.text()'), worker.indexOf('const payload = recordOrEmpty(responsePayload)')),
    /providerAccountLeaseReleaseSafe = true/,
    'transport EOF alone must not release the provider account lease',
  );
  assert.match(worker, /providerAccountLeaseClaimed[\s\S]*providerAccountLeaseReleaseSafe[\s\S]*release_provider_account_language_validation/);
  assert.match(create, /claimError\.code[\s\S]*55P03[\s\S]*provider language validation in progress[\s\S]*LANGUAGE_VALIDATION_IN_PROGRESS/);
  assert.match(playback, /version: 50[\s\S]*languageValidationPresenceIntentProtocol: 1[\s\S]*languageValidationPlaybackLeaseProtocol: 1[\s\S]*languageValidationActivityProtocol: 1[\s\S]*languageValidationTaskBudgetMs: LANGUAGE_VALIDATION_TASK_BUDGET_MS[\s\S]*languageValidationFetchTimeoutMs: LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS[\s\S]*languageValidationPostFetchReserveMs: LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS[\s\S]*languageValidationJobLeaseSeconds: LANGUAGE_VALIDATION_JOB_LEASE_SECONDS[\s\S]*languageValidationSampleDurationSeconds: LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS/);
  assert.match(playback, /const LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS = 240_000/);
  assert.match(edgeDeploy, /EXPECTED_PLAYBACK_VERSION=50/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_TASK_BUDGET_MS=270000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS=240000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS=30000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_JOB_LEASE_SECONDS=300/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS=20/);
  assert.match(edgeDeploy, /languageValidationSampleDurationSeconds\\\":\$EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PRESENCE_INTENT_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PLAYBACK_LEASE_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_ACTIVITY_PROTOCOL=1/);
  assert.match(mainRouter, /'norva-playback': 20 \* 60 \* 1000/);
  assert.match(edgeDeploy, /main_path="\/home\/deno\/functions\/main\/index\.ts"/);
  assert.match(edgeDeploy, /main router source digest mismatch/);
});

test('language validation fetch budget preserves cleanup time inside the worker deadline', () => {
  let helper = between(
    playback,
    'function languageValidationFetchBudgetMs(',
    '\nasync function processOneLanguageValidationTrack(',
  );
  helper = helper
    .replace('taskDeadlineAt: number', 'taskDeadlineAt')
    .replace('nowMs = Date.now()', 'nowMs = Date.now()');
  const context = {
    Math,
    Date,
    LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS: 240_000,
    LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS: 30_000,
  };
  vm.runInNewContext(`${helper}; this.budget = languageValidationFetchBudgetMs;`, context);

  assert.equal(context.budget(270_000, 0), 240_000);
  assert.equal(context.budget(270_000, 29_000), 211_000);
  assert.equal(context.budget(270_000, 240_000), 0);
  assert.equal(context.budget(270_000, 270_001), 0);
});

test('strict Gateway 5xx retries in 30 seconds while proxy auth and non-5xx keep the long policy', () => {
  let helper = between(
    playback,
    'function languageValidationGatewayRetryAt(',
    '\nfunction strictLanguageValidationEvidence(',
  );
  helper = helper
    .replace('responseStatus: number', 'responseStatus')
    .replace('gatewayCode: string', 'gatewayCode')
    .replace('upstreamStatus: number | null', 'upstreamStatus');
  const context = { Number, Date };
  vm.runInNewContext(`${helper}; this.retryAt = languageValidationGatewayRetryAt;`, context);
  const now = Date.parse('2026-08-16T17:00:00.000Z');

  assert.equal(context.retryAt(500, 'STRICT_LID_FAILED', null, now), '2026-08-16T17:00:30.000Z');
  assert.equal(context.retryAt(504, 'strict_lid_request_timeout', null, now), '2026-08-16T17:00:30.000Z');
  assert.equal(context.retryAt(502, 'PROXY_AUTH_FAILED', 407, now), null);
  assert.equal(context.retryAt(502, 'proxy_auth_failed', null, now), null);
  assert.equal(context.retryAt(407, 'PROXY_AUTH_FAILED', 407, now), null);
  assert.equal(context.retryAt(458, 'PROVIDER_BUSY', 458, now), null);
  assert.equal(context.retryAt(409, 'VIEWER_PREEMPTED', null, now), null);

  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationJob(',
  );
  assert.match(worker, /if \(!response\.ok\)[\s\S]*retryAt: languageValidationGatewayRetryAt\([\s\S]*response\.status,[\s\S]*gatewayCode,[\s\S]*upstreamStatus/);
});

test('provider account lease release requires the exact Gateway drain attestation', () => {
  let helper = between(
    playback,
    'function strictLanguageProviderDrainAttested(',
    '\nfunction languageValidationFetchBudgetMs(',
  );
  helper = helper.replace('payload: JsonRecord', 'payload');
  const context = { Number };
  vm.runInNewContext(`${helper}; this.attested = strictLanguageProviderDrainAttested;`, context);
  assert.equal(context.attested({ providerDrained: true, providerDrainProtocol: 1 }), true);
  for (const payload of [
    {},
    { providerDrained: true },
    { providerDrained: false, providerDrainProtocol: 1 },
    { providerDrained: true, providerDrainProtocol: 0 },
    { providerDrained: 'true', providerDrainProtocol: 1 },
    { providerDrained: true, providerDrainProtocol: '1' },
    { providerDrained: true, providerDrainProtocol: true },
    { providerDrained: true, providerDrainProtocol: [1] },
  ]) {
    assert.equal(context.attested(payload), false);
  }
});

test('presence intent cannot hide fresh provider activity and the foreground RPC is service-only', () => {
  assert.match(
    presenceMigration,
    /create or replace function public\.provider_account_touch_by_user\(p_user uuid, p_kind text\)/i,
  );
  assert.match(
    presenceMigration,
    /insert into public\.provider_account_activity as activity[\s\S]*on conflict \(account_key\) do update[\s\S]*where excluded\.kind is distinct from 'presence'[\s\S]*activity\.kind = 'presence'[\s\S]*activity\.last_seen_at <= excluded\.last_seen_at - interval '5 minutes'/i,
  );
  assert.match(
    presenceMigration,
    /create or replace function public\.provider_account_busy_for_foreground_validation\(p_key text\)[\s\S]*last_seen_at > statement_timestamp\(\) - interval '5 minutes'[\s\S]*kind is distinct from 'presence'/i,
  );
  assert.match(
    presenceMigration,
    /revoke all on function public\.provider_account_busy_for_foreground_validation\(text\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    presenceMigration,
    /grant execute on function public\.provider_account_busy_for_foreground_validation\(text\)[\s\S]*to service_role/i,
  );
  assert.match(
    presenceMigration,
    /create table if not exists public\.provider_account_language_validation_leases[\s\S]*enable row level security[\s\S]*revoke all on table[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    presenceMigration,
    /create or replace function public\.claim_provider_account_language_validation[\s\S]*pg_advisory_xact_lock[\s\S]*'provider-session:' \|\| p_provider_account_hash[\s\S]*cloud_playback_sessions/i,
  );
  assert.match(
    presenceMigration,
    /create or replace function public\.claim_cloud_playback_session[\s\S]*pg_advisory_xact_lock[\s\S]*provider_account_language_validation_leases[\s\S]*errcode = '55P03'/i,
  );
  assert.equal(
    (presenceMigration.match(/hashtextextended\('provider-session:' \|\| p_provider_account_hash, 0\)/g) || []).length,
    3,
  );
  assert.match(presenceMigration, /notify pgrst, 'reload schema'/i);
  assert.match(playback, /LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR[\s\S]*Date\.now\(\) \+ 30_000/);
});

test('language-validation activity yields to real activity but remains busy for background work', () => {
  assert.match(
    activityMigration,
    /create or replace function public\.provider_account_touch_many\(p_keys text\[\], p_kind text\)[\s\S]*security definer[\s\S]*set search_path = ''/i,
  );
  assert.match(
    activityMigration,
    /on conflict \(account_key\) do update[\s\S]*excluded\.kind is distinct from 'language-validation'[\s\S]*activity\.kind in \('presence', 'language-validation'\)[\s\S]*activity\.last_seen_at <= excluded\.last_seen_at - interval '5 minutes'/i,
  );
  assert.match(
    activityMigration,
    /provider_account_busy_for_foreground_validation\(p_key text\)[\s\S]*kind is distinct from 'presence'[\s\S]*kind is distinct from 'language-validation'/i,
  );
  assert.match(
    activityMigration,
    /revoke all on function public\.provider_account_touch_many\(text\[\], text\)[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function public\.provider_account_touch_many\(text\[\], text\)[\s\S]*to service_role/i,
  );
  assert.match(
    activityMigration,
    /revoke all on function public\.provider_account_busy_for_foreground_validation\(text\)[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function public\.provider_account_busy_for_foreground_validation\(text\)[\s\S]*to service_role/i,
  );
  assert.match(activityMigration, /notify pgrst, 'reload schema'/i);
  assert.doesNotMatch(activityMigration, /alter table|drop table|create table/i);
});

test('exact gateway-inband MKV profile, signed size and index fingerprint fail closed', () => {
  const profile = between(
    playback,
    'async function loadExactLanguageValidationProfile(',
    '\nasync function loadLanguageValidationIdentity(',
  );
  const exact = between(
    playback,
    'function hasExactGatewayInbandMkvProfile(',
    '\nasync function loadLanguageValidationIdentity(',
  );
  const revalidate = between(
    playback,
    'async function revalidateLanguageValidationClaim(',
    '\nasync function processOneLanguageValidationTrack(',
  );
  const bytePipe = between(
    playback,
    'async function createBytePipeCapability(',
    '\nasync function createGatewaySession(',
  );
  const strictCache = between(
    playback,
    'function cachedStrictLanguageValidation(',
    '\nasync function assertLanguageValidationIdle(',
  );

  assert.match(profile, /from\("cloud_title_variants"\)/);
  assert.match(profile, /eq\("user_id", userId\)/);
  assert.match(profile, /eq\("source_id", sourceId\)/);
  assert.match(profile, /eq\("external_id", itemId\)/);
  assert.match(exact, /profile\.metadataComplete === true/);
  assert.match(exact, /container === "mkv" \|\| container\.includes\("matroska"\)/);
  assert.match(exact, /Number\.isSafeInteger\(fileSizeBytes\)/);
  assert.match(exact, /normalizeCodecToken\(profile\.probeSource\) === "gatewayinband"/);
  assert.match(revalidate, /languageValidationProfileFingerprint/);
  assert.match(revalidate, /exactProfile\.fileSizeBytes !== expectedFileSizeBytes/);
  assert.match(revalidate, /loadLanguageValidationIdentity/);
  assert.match(revalidate, /exactCachedAudioTracks/);
  assert.match(strictCache, /provenance\.profileFingerprint/);
  assert.match(strictCache, /provenance\.fileSizeBytes/);
  assert.match(strictCache, /provenance\.profileProbedAt/);
  assert.match(bytePipe, /\? \{ fileSizeBytes \}/);
  assert.match(bytePipe, /capability/);
  assert.doesNotMatch(startBody(playback), /body\.(?:url|targetUrl|providerUrl|token|password)/);
});

test('stale unverified track maps are repaired only from the exact profile without provider I/O', () => {
  const start = startBody(playback);
  const mismatchAt = start.indexOf('let cachedAudioTracks = exactCachedAudioTracks');
  const repairAt = start.indexOf('await shareFileTracks(', mismatchAt);
  const providerAt = start.indexOf('start_catalog_file_audio_validation_job');
  assert.ok(mismatchAt >= 0);
  assert.ok(repairAt > mismatchAt);
  assert.ok(providerAt > repairAt);
  assert.match(start, /hasActiveLanguageValidationJob\(db, identityKey, itemId\)/);
  assert.match(start, /cacheStatus === "validating"/);
  assert.doesNotMatch(start.slice(mismatchAt, providerAt), /resolvePlaybackTarget|createBytePipeCapability|createBytePipeAccess|await fetch/);
});

function startBody(source) {
  return between(
    source,
    'async function startPlaybackLanguageValidation(',
    '\nfunction exactLanguageValidationIndices(',
  );
}

test('missing EdgeRuntime.waitUntil returns 503 and has no fire-and-forget fallback', () => {
  const required = between(
    playback,
    'function requireLanguageValidationWaitUntil(',
    '\nfunction scheduleLanguageValidationJob(',
  );
  const schedule = between(
    playback,
    'function scheduleLanguageValidationJob(',
    '\nasync function languageValidationProfileFingerprint(',
  );
  assert.match(required, /typeof edgeRuntime\.waitUntil !== "function"/);
  assert.match(required, /new HttpError\(503/);
  assert.match(required, /LANGUAGE_VALIDATION_BACKGROUND_UNAVAILABLE/);
  assert.match(schedule, /waitUntil\(task\)/);
  assert.doesNotMatch(schedule, /fire-and-forget|runBackground/);
});

test('in-process scheduling coalesces concurrent polls for the same durable job', async () => {
  let source = between(
    playback,
    'function scheduleLanguageValidationJob(',
    '\nfunction languageValidationJobScheduleDue(',
  );
  source = source
    .replace(
      /function scheduleLanguageValidationJob\([\s\S]*?\n\) \{/,
      'function scheduleLanguageValidationJob(waitUntil, db, jobId) {',
    )
    .replace('let task: Promise<void>;', 'let task;');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let workerCalls = 0;
  const registered = [];
  const context = {
    languageValidationTasks: new Map(),
    processOneLanguageValidationTrack: async () => {
      workerCalls += 1;
      await gate;
    },
    HttpError: class HttpError extends Error {},
    Promise,
    console: { warn() {} },
  };
  vm.runInNewContext(`${source}; this.schedule = scheduleLanguageValidationJob;`, context);
  const waitUntil = (task) => registered.push(task);

  assert.equal(context.schedule(waitUntil, {}, 'job-a'), true);
  assert.equal(context.schedule(waitUntil, {}, 'job-a'), false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(workerCalls, 1);
  assert.equal(registered.length, 1);
  release();
  await registered[0];
  await Promise.resolve();
  assert.equal(context.languageValidationTasks.size, 0);
});

test('poll scheduling accepts only queued, due retry, or expired lease states', () => {
  let source = between(
    playback,
    'function languageValidationJobScheduleDue(',
    '\nasync function languageValidationProfileFingerprint(',
  );
  source = source.replace(
    'function languageValidationJobScheduleDue(job: JsonRecord, nowMs = Date.now())',
    'function languageValidationJobScheduleDue(job, nowMs = Date.now())',
  );
  const context = {
    Date,
    Number,
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
  };
  vm.runInNewContext(`${source}; this.due = languageValidationJobScheduleDue;`, context);
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  assert.equal(context.due({ state: 'queued' }, now), true);
  assert.equal(context.due({ state: 'retry_wait', retry_at: '2026-08-16T11:59:59Z' }, now), true);
  assert.equal(context.due({ state: 'retry_wait', retry_at: '2026-08-16T12:00:01Z' }, now), false);
  assert.equal(context.due({ state: 'running', lease_expires_at: '2026-08-16T11:59:59Z' }, now), true);
  assert.equal(context.due({ state: 'finalizing', lease_expires_at: '2026-08-16T12:00:01Z' }, now), false);
  assert.equal(context.due({ state: 'verified' }, now), false);
});

test('language validation protocol 2 is constant across health, fingerprint, cache and responses', () => {
  assert.match(playback, /const LANGUAGE_VALIDATION_PROTOCOL = 2;/);
  assert.match(playback, /languageValidationProtocol: LANGUAGE_VALIDATION_PROTOCOL/);
  assert.match(playback, /languageValidationGatewayMethod: "POST"/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PROTOCOL=2/);
  assert.match(edgeDeploy, /languageValidationProtocol\\\":\$EXPECTED_LANGUAGE_VALIDATION_PROTOCOL/);
  const fingerprint = between(
    playback,
    'async function languageValidationProfileFingerprint(',
    '\nasync function revalidateLanguageValidationClaim(',
  );
  assert.match(fingerprint, /protocol: LANGUAGE_VALIDATION_PROTOCOL/);
  const cache = between(
    playback,
    'function cachedStrictLanguageValidation(',
    '\nasync function assertLanguageValidationIdle(',
  );
  assert.match(cache, /Number\(provenance\.protocol\) !== LANGUAGE_VALIDATION_PROTOCOL/);
  for (const helper of [
    'languageValidationPendingResponse',
    'languageValidationFailedResponse',
    'languageValidationRejectedResponse',
    'languageValidationResponse',
  ]) {
    const start = playback.indexOf(`function ${helper}(`);
    assert.notEqual(start, -1);
    assert.match(playback.slice(start, start + 1400), /protocol: LANGUAGE_VALIDATION_PROTOCOL/);
  }
});

test('one waitUntil task handles at most one provider track and first 458 is terminal', () => {
  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationJob(',
  );
  assert.match(worker, /"claim_catalog_file_audio_validation_job"/);
  assert.match(worker, /"claim_provider_file_probe"/);
  assert.match(worker, /p_ttl_seconds: LANGUAGE_VALIDATION_LEASE_SECONDS/);
  assert.match(worker, /LANGUAGE_VALIDATION_SCOPE,[\s\S]*exactAfterLease\.exactProfile\.fileSizeBytes/);
  assert.match(worker, /\?index=\$\{trackIndex\}&strict=1&dur=\$\{LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS\}/);
  assert.match(worker, /method: "POST"/);
  assert.match(worker, /Authorization: `Bearer \$\{detectionAccess\.serviceToken\}`/);
  assert.match(worker, /"X-Norva-Byte-Pipe-Token": detectionAccess\.capability/);
  assert.doesNotMatch(worker, /detect-language\//);
  assert.doesNotMatch(worker, /body:\s*(?:JSON\.stringify|detectionAccess\.capability)/);
  assert.equal((worker.match(/await fetch\(/g) || []).length, 1);
  assert.doesNotMatch(worker, /for\s*\(|while\s*\(|Promise\.all/);
  assert.ok(worker.indexOf('isProviderBusyFailure') < worker.indexOf('if (!response.ok)'));
  assert.match(worker, /openProviderPlaybackCircuit\(providerAccountHash, db, true\)/);
  assert.match(worker, /errorCode: "PROVIDER_ACCOUNT_BUSY"[\s\S]*terminal: true/);
  assert.match(worker, /"checkpoint_catalog_file_audio_validation_job"/);
  assert.match(worker, /releaseProviderFileProbe\(db, identityKey, providerLeaseOwner\)/);
});

test('durable SQL journal is RLS/private and every state transition is service-role CAS', () => {
  assert.match(migration, /create table public\.catalog_file_audio_validation_jobs/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table public\.catalog_file_audio_validation_jobs[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /catalog_file_audio_validation_jobs_one_active_file_idx/);
  assert.match(migration, /profile_snapshot jsonb not null/);
  assert.match(migration, /vod_language_profile_snapshot\(v_profile\)/);
  for (const rpc of [
    'start_catalog_file_audio_validation_job',
    'claim_catalog_file_audio_validation_job',
    'checkpoint_catalog_file_audio_validation_job',
    'fail_catalog_file_audio_validation_job',
    'cancel_catalog_file_audio_validation_job',
    'finalize_catalog_file_audio_validation_job',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${rpc}`));
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*?from public, anon, authenticated`));
  }
  assert.match(migration, /for update/);
  assert.match(migration, /lease_owner is distinct from btrim\(p_lease_owner\)/);
  assert.match(migration, /next_track_position = next_track_position \+ 1/);
  assert.match(migration, /evidence = evidence \|\| jsonb_build_array\(v_safe_evidence\)/);
});

test('SQL start quotas are atomic and abandoned queues, cancellation and retention are bounded', () => {
  const start = between(
    migration,
    'create or replace function public.start_catalog_file_audio_validation_job(',
    '\ncreate or replace function public.claim_catalog_file_audio_validation_job(',
  );
  const claim = between(
    migration,
    'create or replace function public.claim_catalog_file_audio_validation_job(',
    '\ncreate or replace function public.checkpoint_catalog_file_audio_validation_job(',
  );
  const cancel = between(
    migration,
    'create or replace function public.cancel_catalog_file_audio_validation_job(',
    '\ncreate or replace function public.finalize_catalog_file_audio_validation_job(',
  );

  const userLock = start.indexOf("'catalog-file-audio-validation-user:'");
  const fileLock = start.indexOf("'catalog-file-audio-validation:'");
  const insert = start.indexOf('insert into public.catalog_file_audio_validation_jobs');
  assert.ok(userLock >= 0 && fileLock > userLock && insert > fileLock);
  assert.match(start, /v_active_count >= 2/);
  assert.match(start, /v_starts_24h >= 20/);
  assert.match(start, /LANGUAGE_VALIDATION_CONCURRENCY_LIMIT/);
  assert.match(start, /LANGUAGE_VALIDATION_RATE_LIMITED/);
  assert.match(start, /job\.created_at > v_now - interval '24 hours'/);
  assert.match(start, /state = 'expired'[\s\S]*queue_expires_at = null/);
  assert.match(start, /v_now \+ interval '15 minutes'/);
  assert.match(start, /limit 100[\s\S]*for update skip locked/);
  assert.match(start, /purge_after <= v_now/);
  assert.match(claim, /v_job\.queue_expires_at <= v_now[\s\S]*state = 'expired'/);
  assert.match(claim, /v_job\.attempt_count >= 64[\s\S]*LANGUAGE_VALIDATION_ATTEMPT_LIMIT/);
  assert.match(cancel, /state = 'cancelled'/);
  assert.match(cancel, /p_requested_by/);
  assert.match(cancel, /purge_after = v_now \+ interval '7 days'/);
  assert.match(migration, /catalog_file_audio_validation_jobs_retention_idx/);
  assert.match(migration, /grant execute on function public\.cancel_catalog_file_audio_validation_job[\s\S]*to service_role/);
});

test('checkpoint stores aggregate evidence only and finalization revalidates + commits atomically', () => {
  const checkpoint = between(
    migration,
    'create or replace function public.checkpoint_catalog_file_audio_validation_job(',
    '\ncreate or replace function public.fail_catalog_file_audio_validation_job(',
  );
  const finalize = between(
    migration,
    'create or replace function public.finalize_catalog_file_audio_validation_job(',
    '\nrevoke all on function public.start_catalog_file_audio_validation_job(',
  );
  assert.match(checkpoint, /v_safe_evidence := jsonb_build_object/);
  assert.doesNotMatch(checkpoint, /'url'|'token'|'transcript'|'samples'/i);
  assert.match(finalize, /select variant\.codec_profile[\s\S]*for update of variant/);
  assert.match(finalize, /vod_language_profile_is_exact/);
  assert.match(finalize, /vod_language_profile_file_size_bytes/);
  assert.match(finalize, /vod_language_profile_snapshot\(v_profile\) is distinct from v_job\.profile_snapshot/);
  assert.match(finalize, /catalog_audio_track_indexes\(v_cache\.audio_tracks\)/);
  assert.match(finalize, /'profileFingerprint', v_job\.profile_fingerprint/);
  assert.match(finalize, /'profileProbedAt', v_job\.profile_probed_at/);
  assert.match(finalize, /'fileSizeBytes', v_job\.file_size_bytes/);
  assert.match(finalize, /upsert_catalog_file_validated_tracks/);
  assert.match(finalize, /record_catalog_file_audio_verification/);
  assert.ok(
    finalize.indexOf('upsert_catalog_file_validated_tracks')
      < finalize.indexOf('record_catalog_file_audio_verification'),
  );
  assert.match(finalize, /set state = 'verified'/);
});

test('only unanimous strict aggregate evidence can advance the durable cursor', () => {
  const evidence = between(
    playback,
    'function strictLanguageValidationEvidence(',
    '\nfunction languageValidationResponse(',
  );
  for (const contract of [
    'payload.verified !== true',
    'validationStatus',
    'LANGUAGE_VALIDATION_METHOD',
    'sampleCount < LANGUAGE_VALIDATION_MIN_SAMPLES',
    'rejectedSpeechSampleCount !== 0',
    'minSampleProbability < LANGUAGE_VALIDATION_MIN_PROBABILITY',
    'minSampleWordCount < LANGUAGE_VALIDATION_MIN_WORDS',
    'minSampleUniqueWordCount < LANGUAGE_VALIDATION_MIN_UNIQUE_WORDS',
    'samples.length !== sampleCount',
  ]) {
    assert.ok(evidence.includes(contract), `missing strict contract: ${contract}`);
  }
  const returned = evidence.slice(evidence.indexOf('return {'));
  assert.doesNotMatch(returned, /samples[,\s:]/);
});

test('public job responses contain no provider capability, URL or transcript', () => {
  const pending = between(
    playback,
    'function languageValidationPendingResponse(',
    '\nfunction languageValidationFailedResponse(',
  );
  const failed = between(
    playback,
    'function languageValidationFailedResponse(',
    '\nasync function requireLanguageValidationEntitlement(',
  );
  const verified = between(
    playback,
    'function languageValidationResponse(',
    '\nasync function getPlaybackSession(',
  );
  for (const response of [pending, failed, verified]) {
    assert.doesNotMatch(response, /providerUrl|targetUrl|token|transcript|samples/i);
  }
  assert.match(pending, /jobId: options\.jobId/);
  assert.match(pending, /retryAfter/);
  assert.match(verified, /audioTracks: options\.audioTracks/);
});

test('Edge still verifies the gateway-reported audio index instead of trusting the request', () => {
  const gateway = between(
    playback,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  assert.match(gateway, /const requestedAudioStreamIndex = boundedNullableInt/);
  assert.match(gateway, /audioStreamIndex !== requestedAudioStreamIndex/);
  assert.match(gateway, /AUDIO_STREAM_MAP_MISMATCH/);
  assert.match(gateway, /method: "DELETE"/);
});
