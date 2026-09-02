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
const windowMigration = read('supabase/migrations/20260817001127_strict_lid_window_checkpoints.sql');
const presenceMigration = read('supabase/migrations/20260816141150_provider_account_foreground_presence.sql');
const activityMigration = read('supabase/migrations/20260816171003_provider_account_language_validation_activity.sql');
const profileParityMigration = read('supabase/migrations/20260818162200_vod_language_validation_profile_parity.sql');
const retryWorkerMigration = read('supabase/migrations/20260818165000_vod_language_validation_retry_worker.sql');
const preemptionMigration = read('supabase/migrations/20260831032956_provider_lid_viewer_preemption_quarantine_v1.sql');
const strictUndMigration = read('supabase/migrations/20260901143200_strict_und_audio_validation_v1.sql');
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
  assert.match(poll, /assertSourceCatalogVisible\(sourceId, userId, db\)/);
  assert.match(poll, /requireLanguageValidationEntitlement\(userId, db\)/);
  assert.match(poll, /scheduleLanguageValidationJob\(waitUntil, db, jobId\)/);
});

test('cron-authenticated retry worker schedules a bounded provider-distinct batch', () => {
  const route = between(
    playback,
    'segments[0] === "language-validation-worker"',
    'if (req.method === "POST" && segments[0] === "pregen-gate")',
  );
  const worker = between(
    playback,
    'async function runLanguageValidationRetryWorker(',
    '\nasync function revalidateLanguageValidationClaim(',
  );

  assert.match(route, /runLanguageValidationRetryWorker\(req, supabase\)[\s\S]*202/);
  assert.match(worker, /"norva_verify_cron_secret"/);
  assert.match(worker, /authorized !== true[\s\S]*HttpError\(403/);
  assert.match(worker, /"list_due_catalog_file_audio_validation_jobs"/);
  assert.match(worker, /LANGUAGE_VALIDATION_RETRY_WORKER_BATCH/);
  assert.match(worker, /scheduleLanguageValidationJob\(waitUntil, db, jobId\)/);
  assert.doesNotMatch(worker, /sourceId|itemId|identityKey|targetUrl/);

  assert.match(retryWorkerMigration, /row_number\(\) over \([\s\S]*partition by job\.identity_key/);
  assert.match(retryWorkerMigration, /job\.state = 'retry_wait'[\s\S]*job\.retry_at <= now\(\)/);
  assert.match(retryWorkerMigration, /job\.state in \('running', 'finalizing'\)[\s\S]*job\.lease_expires_at <= now\(\)/);
  assert.match(retryWorkerMigration, /limit greatest\(1, least\(coalesce\(p_limit, 2\), 4\)\)/);
  assert.match(retryWorkerMigration, /revoke all on function public\.list_due_catalog_file_audio_validation_jobs\(integer\)[\s\S]*from public, anon, authenticated/);
  assert.match(retryWorkerMigration, /grant execute on function public\.list_due_catalog_file_audio_validation_jobs\(integer\)[\s\S]*to service_role/);
  assert.match(retryWorkerMigration, /cron\.schedule\([\s\S]*norva-playback-language-validation-worker[\s\S]*'\* \* \* \* \*'/);
  assert.match(retryWorkerMigration, /norva-playback\/language-validation-worker/);
  assert.match(retryWorkerMigration, /norva_cron_shared_secret/);
});

test('foreground playback preempts background validation and requires an attested Gateway drain', () => {
  const idle = between(
    playback,
    'async function assertLanguageValidationIdle(',
    '\nfunction strictLanguageValidationEvidence(',
  );
  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  const create = between(
    playback,
    'async function createPlaybackSessionCore(',
    '\nasync function createPlaybackSession(',
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
    /providerAccountLeaseReleaseSafe = false[\s\S]*await fetch[\s\S]*readLanguageValidationGatewayResponse\(response\)[\s\S]*recordOrEmpty\(responseRead\.payload\)[\s\S]*providerAccountLeaseReleaseSafe = strictLanguageProviderDrainAttested\(payload\)/,
  );
  assert.doesNotMatch(
    worker.slice(
      worker.indexOf('readLanguageValidationGatewayResponse(response)'),
      worker.indexOf('const payload = recordOrEmpty(responseRead.payload)'),
    ),
    /providerAccountLeaseReleaseSafe = true/,
    'transport EOF alone must not release the provider account lease',
  );
  assert.match(worker, /providerAccountLeaseClaimed[\s\S]*providerAccountLeaseReleaseSafe[\s\S]*release_provider_account_language_validation/);
  assert.match(create, /"claim_cloud_playback_session"[\s\S]*preemptProviderLanguageValidationTransports\([\s\S]*LANGUAGE_VALIDATION_PREEMPTION_DRAIN_FAILED/);
  assert.match(playback, /async function preemptProviderLanguageValidationTransports[\s\S]*stop-provider-affinities[\s\S]*payload\.protocol !== 1[\s\S]*payload\.providerDrained !== true/);
  assert.match(playback, /version: 75[\s\S]*languageValidationPresenceIntentProtocol: 1[\s\S]*languageValidationPlaybackLeaseProtocol: 1[\s\S]*languageValidationActivityProtocol: 1[\s\S]*languageValidationDurationClaimProtocol: 1[\s\S]*languageValidationWindowCheckpointProtocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL[\s\S]*languageValidationTaskBudgetMs: LANGUAGE_VALIDATION_TASK_BUDGET_MS[\s\S]*languageValidationFetchTimeoutMs: LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS[\s\S]*languageValidationPostFetchReserveMs: LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS[\s\S]*languageValidationJobLeaseSeconds: LANGUAGE_VALIDATION_JOB_LEASE_SECONDS[\s\S]*languageValidationSampleDurationSeconds: LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS[\s\S]*languageValidationRetryWorkerProtocol: LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL[\s\S]*languageValidationRetryWorkerBatch: LANGUAGE_VALIDATION_RETRY_WORKER_BATCH[\s\S]*languageValidationProviderAttemptProtocol: 1[\s\S]*languageValidationViewerPreemptionProtocol: 1[\s\S]*languageValidationMaxConsecutiveProviderNoProgress:[\s\S]*LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS[\s\S]*languageValidationGatewayFailureRetrySeconds:[\s\S]*LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS \/ 1000/);
  assert.match(playback, /const LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS = 240_000/);
  assert.match(edgeDeploy, /EXPECTED_PLAYBACK_VERSION=68/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_TASK_BUDGET_MS=270000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS=240000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS=30000/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_JOB_LEASE_SECONDS=300/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS=20/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_BATCH=2/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_SECONDS=300/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_VIEWER_PREEMPTION_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS=4/);
  assert.match(edgeDeploy, /languageValidationSampleDurationSeconds\\\":\$EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS/);
  assert.match(edgeDeploy, /languageValidationRetryWorkerProtocol\\\":\$EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL/);
  assert.match(edgeDeploy, /languageValidationRetryWorkerBatch\\\":\$EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_BATCH/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PRESENCE_INTENT_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_PLAYBACK_LEASE_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_ACTIVITY_PROTOCOL=1/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_DURATION_CLAIM_PROTOCOL=1/);
  assert.match(edgeDeploy, /languageValidationDurationClaimProtocol\\\":\$EXPECTED_LANGUAGE_VALIDATION_DURATION_CLAIM_PROTOCOL/);
  assert.match(edgeDeploy, /EXPECTED_LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL=1/);
  assert.match(edgeDeploy, /languageValidationWindowCheckpointProtocol\\\":\$EXPECTED_LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL/);
  assert.match(mainRouter, /'norva-playback': 20 \* 60 \* 1000/);
  assert.match(edgeDeploy, /main_path="\/home\/deno\/functions\/main\/index\.ts"/);
  assert.match(edgeDeploy, /main router source digest mismatch/);
});

test('language validation fetch budget preserves cleanup time inside the worker deadline', () => {
  let helper = between(
    playback,
    'function languageValidationFetchBudgetMs(',
    '\ntype StrictLidWindowState =',
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

test('short exact VOD is terminal before job creation or provider work while boundary counts stay exact', () => {
  let helpers = between(
    playback,
    'function strictLidWindowCountForDuration(',
    '\nfunction strictLidWindowToken(',
  );
  helpers = helpers
    .replace(
      'function strictLidWindowCountForDuration(durationSeconds: number): 4 | 6 | null',
      'function strictLidWindowCountForDuration(durationSeconds)',
    )
    .replace(
      'function requireStrictLidWindowCount(durationSeconds: number): 4 | 6',
      'function requireStrictLidWindowCount(durationSeconds)',
    );
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  const context = {
    Number,
    HttpError,
    LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS: 20,
  };
  vm.runInNewContext(
    `${helpers}; this.count = strictLidWindowCountForDuration; this.requireCount = requireStrictLidWindowCount;`,
    context,
  );
  assert.equal(context.count(79.999), null);
  assert.equal(context.count(80), 4);
  assert.equal(context.count(119.999), 4);
  assert.equal(context.count(120), 6);
  let shortError = null;
  try {
    context.requireCount(79.999);
  } catch (error) {
    shortError = error;
  }
  assert.equal(shortError?.status, 422);
  assert.equal(shortError?.details?.code, 'LANGUAGE_VALIDATION_DURATION_TOO_SHORT');

  const start = startBody(playback);
  const startDurationGateAt = start.indexOf('requireStrictLidWindowCount(');
  const retryGateAt = start.indexOf('const retryAt = stringOrNull(cache.audio_lang_retry_at)');
  const startRpcAt = start.indexOf('"start_catalog_file_audio_validation_job"');
  assert.ok(startDurationGateAt >= 0 && startDurationGateAt < retryGateAt && retryGateAt < startRpcAt);
  assert.doesNotMatch(
    start.slice(startDurationGateAt, startRpcAt),
    /resolvePlaybackTarget|createBytePipeCapability|await fetch|scheduleLanguageValidationJob/,
  );

  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  const workerDurationGateAt = worker.indexOf('requireStrictLidWindowCount(initialDurationSeconds)');
  assert.ok(workerDurationGateAt >= 0 && workerDurationGateAt < worker.indexOf('resolvePlaybackTarget('));

  let terminal = between(
    playback,
    'function languageValidationTaskErrorIsTerminal(',
    '\nfunction languageValidationTaskRetryAt(',
  );
  terminal = terminal.replace('(error: unknown)', '(error)');
  const terminalContext = { Set, languageValidationTaskErrorCode: (code) => code };
  vm.runInNewContext(`${terminal}; this.isTerminal = languageValidationTaskErrorIsTerminal;`, terminalContext);
  assert.equal(terminalContext.isTerminal('LANGUAGE_VALIDATION_DURATION_TOO_SHORT'), true);
});

test('Gateway JSON is bounded in bytes before parse and overflow cancels without drain evidence', async () => {
  let helper = between(
    playback,
    'async function readLanguageValidationGatewayResponse(',
    '\nasync function processOneLanguageValidationTrack(',
  );
  helper = helper
    .replace(
      /async function readLanguageValidationGatewayResponse\([\s\S]*?\): Promise<LanguageValidationGatewayResponseRead> \{/,
      'async function readLanguageValidationGatewayResponse(response, maxBytes = LANGUAGE_VALIDATION_FINALIZE_BODY_MAX_BYTES) {',
    )
    .replaceAll('(): LanguageValidationGatewayResponseRead', '()')
    .replace('const chunks: Uint8Array[] = [];', 'const chunks = [];');
  const context = {
    JSON,
    Number,
    TextDecoder,
    Uint8Array,
    LANGUAGE_VALIDATION_FINALIZE_BODY_MAX_BYTES: 1_048_576,
  };
  vm.runInNewContext(`${helper}; this.readGateway = readLanguageValidationGatewayResponse;`, context);

  const makeResponse = ({ contentLength = null, chunks = [], readError = null }) => {
    const counters = { bodyCancel: 0, readerCancel: 0, readerReads: 0, release: 0 };
    let position = 0;
    const reader = {
      async read() {
        counters.readerReads += 1;
        if (readError) throw readError;
        if (position >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[position++] };
      },
      async cancel() { counters.readerCancel += 1; },
      releaseLock() { counters.release += 1; },
    };
    return {
      counters,
      response: {
        headers: { get: (name) => name === 'content-length' ? contentLength : null },
        body: {
          getReader: () => reader,
          async cancel() { counters.bodyCancel += 1; },
        },
      },
    };
  };
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode('{"providerDrained":true,"providerDrainProtocol":1}');
  const success = makeResponse({ chunks: [payloadBytes.subarray(0, 7), payloadBytes.subarray(7)] });
  const successResult = await context.readGateway(success.response, 64);
  assert.equal(successResult.ok, true);
  assert.equal(successResult.payload.providerDrained, true);

  const advertisedOverflow = makeResponse({ contentLength: '65', chunks: [payloadBytes] });
  const advertisedResult = await context.readGateway(advertisedOverflow.response, 64);
  assert.equal(advertisedResult.ok, false);
  assert.equal(advertisedResult.errorCode, 'LANGUAGE_VALIDATION_GATEWAY_RESPONSE_INVALID');
  assert.equal(advertisedOverflow.counters.bodyCancel, 1);
  assert.equal(advertisedOverflow.counters.readerReads, 0);
  assert.equal('payload' in advertisedResult, false);

  const streamedOverflow = makeResponse({
    chunks: [encoder.encode('{"provid'), encoder.encode('erDrained":true}')],
  });
  const streamedResult = await context.readGateway(streamedOverflow.response, 8);
  assert.equal(streamedResult.ok, false);
  assert.equal(streamedResult.errorCode, 'LANGUAGE_VALIDATION_GATEWAY_RESPONSE_INVALID');
  assert.equal(streamedOverflow.counters.readerCancel, 1);
  assert.equal(streamedOverflow.counters.release, 1);
  assert.equal('payload' in streamedResult, false);

  const broken = makeResponse({ readError: new Error('stream reset') });
  const brokenResult = await context.readGateway(broken.response, 64);
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.errorCode, 'LANGUAGE_VALIDATION_GATEWAY_TRANSPORT');
  assert.equal(broken.counters.readerCancel, 1);

  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  const finalize = between(
    playback,
    'async function finalizeLanguageValidationTrackWindows(',
    '\nasync function finalizeLanguageValidationJob(',
  );
  assert.equal((worker.match(/readLanguageValidationGatewayResponse\(response\)/g) || []).length, 1);
  assert.equal((finalize.match(/readLanguageValidationGatewayResponse\(response\)/g) || []).length, 1);
  assert.doesNotMatch(worker, /response\.text\(\)/);
  assert.doesNotMatch(finalize, /response\.text\(\)/);
  assert.ok(
    worker.indexOf('if (!responseRead.ok)')
      < worker.indexOf('providerAccountLeaseReleaseSafe = strictLanguageProviderDrainAttested(payload)'),
  );
});

test('strict Gateway 5xx backs off for five minutes while proxy auth and non-5xx keep the long policy', () => {
  let helper = between(
    playback,
    'function languageValidationGatewayRetryAt(',
    '\nfunction strictLanguageValidationEvidence(',
  );
  helper = helper
    .replace('responseStatus: number', 'responseStatus')
    .replace('gatewayCode: string', 'gatewayCode')
    .replace('upstreamStatus: number | null', 'upstreamStatus');
  const context = {
    Number,
    Date,
    LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS: 5 * 60 * 1000,
  };
  vm.runInNewContext(`${helper}; this.retryAt = languageValidationGatewayRetryAt;`, context);
  const now = Date.parse('2026-08-16T17:00:00.000Z');

  assert.equal(context.retryAt(500, 'STRICT_LID_FAILED', null, now), '2026-08-16T17:05:00.000Z');
  assert.equal(context.retryAt(504, 'strict_lid_request_timeout', null, now), '2026-08-16T17:05:00.000Z');
  assert.equal(context.retryAt(502, 'PROXY_AUTH_FAILED', 407, now), null);
  assert.equal(context.retryAt(502, 'proxy_auth_failed', null, now), null);
  assert.equal(context.retryAt(407, 'PROXY_AUTH_FAILED', 407, now), null);
  assert.equal(context.retryAt(458, 'PROVIDER_BUSY', 458, now), null);
  assert.equal(context.retryAt(409, 'VIEWER_PREEMPTED', null, now), null);

  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
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

test('foreground playback atomically parks validation work and records an opaque preemption audit', () => {
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
  assert.match(preemptionMigration, /create or replace function public\.claim_cloud_playback_session[\s\S]*pg_advisory_xact_lock[\s\S]*delete from public\.provider_account_language_validation_leases[\s\S]*LANGUAGE_VALIDATION_VIEWER_PREEMPTED[\s\S]*insert into public\.provider_account_language_validation_preemptions/i);
  assert.match(preemptionMigration, /validation_lease_owner_sha256[\s\S]*extensions\.digest\(v_validation_owner, 'sha256'\)/i);
  const strictQuarantine = between(
    strictUndMigration,
    'create or replace function public.norva_quarantine_audio_validation_provider_no_progress(',
    '\nrevoke all on function public.norva_quarantine_audio_validation_provider_no_progress(',
  );
  assert.doesNotMatch(strictQuarantine, /delete from public\.(?:provider_account_language_validation_leases|provider_file_probe_leases)/i);
  assert.match(strictQuarantine, /Keep both transport leases until the[\s\S]*attested release path deletes them, or until their TTL expires/i);
  assert.match(preemptionMigration, /revoke all on table public\.provider_account_language_validation_preemptions[\s\S]*from public, anon, authenticated/i);
  assert.match(preemptionMigration, /grant select, insert, update, delete[\s\S]*provider_account_language_validation_preemptions to service_role/i);
  assert.equal(
    (presenceMigration.match(/hashtextextended\('provider-session:' \|\| p_provider_account_hash, 0\)/g) || []).length,
    3,
  );
  assert.match(presenceMigration, /notify pgrst, 'reload schema'/i);
  assert.match(playback, /LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR[\s\S]*Date\.now\(\) \+ 30_000/);
});

test('real provider attempts are crash-safe, bounded and quarantined without deleting evidence', () => {
  assert.match(preemptionMigration, /add column if not exists provider_attempt_count integer not null default 0/i);
  assert.match(preemptionMigration, /add column if not exists consecutive_provider_no_progress_count integer not null default 0/i);
  assert.match(preemptionMigration, /create or replace function public\.begin_catalog_file_audio_validation_provider_attempt[\s\S]*p_max_consecutive_no_progress integer default 4[\s\S]*provider_attempt_count = provider_attempt_count \+ 1[\s\S]*consecutive_provider_no_progress_count = consecutive_provider_no_progress_count \+ 1/i);
  assert.match(preemptionMigration, /create or replace function public\.finish_catalog_file_audio_validation_provider_attempt[\s\S]*viewer_preempted[\s\S]*greatest\([\s\S]*0, consecutive_provider_no_progress_count - 1[\s\S]*LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED/i);
  assert.match(preemptionMigration, /norva_reset_audio_validation_provider_no_progress_on_checkpoint[\s\S]*new\.strict_lid_window_position > old\.strict_lid_window_position[\s\S]*new\.next_track_position > old\.next_track_position/i);
  assert.match(preemptionMigration, /v_job_id constant uuid := '5df2bccb-cae4-47fb-97f1-95c1efdc95b3'[\s\S]*state = 'failed'[\s\S]*quarantined_at = v_now/i);
  assert.doesNotMatch(preemptionMigration, /delete from public\.catalog_file_audio_validation_jobs/i);
  assert.match(playback, /begin_catalog_file_audio_validation_provider_attempt[\s\S]*LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS[\s\S]*fetch\([\s\S]*detectionAccess\.gatewayUrl/);
  assert.match(playback, /finish_catalog_file_audio_validation_provider_attempt[\s\S]*p_outcome: outcome/);
  assert.match(playback, /provider_account_language_validation_lease_is_current/);
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

test('exact Gateway VOD profile, signed size and index fingerprint fail closed', () => {
  const profile = between(
    playback,
    'async function loadExactLanguageValidationProfile(',
    '\nasync function loadLanguageValidationIdentity(',
  );
  const exact = between(
    playback,
    'function hasExactGatewayInbandVodProfile(',
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
  const rawBytePipe = between(
    playback,
    'async function createBytePipeAccess(',
    '\nasync function createGatewaySession(',
  );
  const strictCache = between(
    playback,
    'function cachedStrictLanguageValidation(',
    '\nasync function assertLanguageValidationIdle(',
  );

  assert.match(profile, /from\("cloud_catalog_visible_title_variants"\)/);
  assert.match(profile, /eq\("user_id", userId\)/);
  assert.match(profile, /eq\("source_id", sourceId\)/);
  assert.match(profile, /eq\("external_id", itemId\)/);
  assert.match(exact, /probeSource === "gatewayinband"[\s\S]*profile\.metadataComplete === true/);
  assert.match(exact, /probeSource === "gatewayprobe"/);
  assert.match(exact, /canonicalVodContainer\(profile\.container\)/);
  assert.match(exact, /container\.includes\("matroska"\)/);
  assert.match(exact, /Number\.isSafeInteger\(fileSizeBytes\)/);
  assert.match(revalidate, /languageValidationProfileFingerprint/);
  assert.match(revalidate, /exactProfile\.fileSizeBytes !== expectedFileSizeBytes/);
  assert.match(revalidate, /fingerprint !== stringOr\(claim\.profileFingerprint, ""\)/);
  assert.match(revalidate, /loadLanguageValidationIdentity/);
  assert.match(revalidate, /exactCachedAudioTracks/);
  assert.match(strictCache, /provenance\.profileFingerprint/);
  assert.match(strictCache, /provenance\.fileSizeBytes/);
  assert.match(strictCache, /provenance\.profileProbedAt/);
  assert.match(bytePipe, /\? \{ fileSizeBytes \}/);
  assert.match(bytePipe, /Number\.isFinite\(durationSeconds\)/);
  assert.match(bytePipe, /Number\(durationSeconds\) > 0/);
  assert.match(bytePipe, /Number\(durationSeconds\) <= 24 \* 60 \* 60/);
  assert.match(bytePipe, /\? \{ durationSeconds: Number\(durationSeconds\) \}/);
  assert.ok(bytePipe.indexOf('{ durationSeconds: Number(durationSeconds) }') < bytePipe.indexOf('hmacBase64Url'));
  assert.doesNotMatch(rawBytePipe, /durationSeconds/);
  assert.match(bytePipe, /capability/);
  assert.doesNotMatch(startBody(playback), /body\.(?:url|targetUrl|providerUrl|token|password)/);
});

test('strict language validation accepts exact AVI Gateway probes without accepting request hints', () => {
  const source = between(
    playback,
    'function hasExactGatewayInbandVodProfile(',
    '\nfunction gatewayProvesRequestedAudioFallback(',
  ).replace('value: unknown', 'value');
  const context = {
    recordOrEmpty: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    hasReliableVodCodecProfile: value => Boolean(value?.videoCodec && value?.audioCodec && value?.container),
    normalizeCodecProfile: value => value,
    normalizeCodecToken: value => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    canonicalVodContainer: value => {
      const token = String(value || '').toLowerCase();
      return ['mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg'].includes(token) ? token : null;
    },
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    Number,
    Date,
    Boolean,
  };
  vm.runInNewContext(`${source}; this.accepts = hasExactGatewayInbandVodProfile;`, context);
  const base = {
    metadataComplete: false,
    container: 'avi',
    videoCodec: 'mpeg4',
    audioCodec: 'ac3',
    audioTracks: [{ index: 1 }],
    subtitles: [],
    durationSeconds: 6215.904,
    fileSizeBytes: 3633791388,
    probedAt: '2026-08-18T11:48:43.623Z',
  };

  assert.equal(context.accepts({ ...base, probeSource: 'gateway_probe' }), true);
  assert.equal(context.accepts({ ...base, container: 'mkv', metadataComplete: true, probeSource: 'gateway_inband' }), true);
  assert.equal(context.accepts({ ...base, probeSource: 'request' }), false);
  assert.equal(context.accepts({ ...base, metadataComplete: false, probeSource: 'gateway_inband' }), false);
});

test('durable exact-profile gate accepts the same canonical Gateway probes as Edge', () => {
  assert.match(profileParityMigration, /normalized\.probe_token = 'gatewayprobe'/);
  assert.match(profileParityMigration, /normalized\.probe_token = 'gatewayinband'[\s\S]*metadataComplete/);
  for (const container of ['mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg']) {
    assert.match(profileParityMigration, new RegExp(`'${container}'`));
  }
  assert.match(profileParityMigration, /videoCodec[\s\S]*audioCodec/);
  assert.match(profileParityMigration, /jsonb_typeof\(p_profile->'subtitles'\) = 'array'/);
  assert.match(profileParityMigration, /vod_language_profile_file_size_bytes/);
  assert.match(profileParityMigration, /vod_language_profile_audio_indices/);
  assert.match(
    profileParityMigration,
    /grant execute on function public\.vod_language_profile_is_exact\(jsonb\) to service_role/,
  );
});

test('stale unverified track maps are repaired only from the exact profile without provider I/O', () => {
  const start = startBody(playback);
  const mismatchAt = start.indexOf('let cachedAudioTracks = exactCachedAudioTracks');
  const repairAt = start.indexOf('await shareFileTracks(', mismatchAt);
  const providerAt = start.indexOf('start_catalog_file_audio_validation_job');
  assert.ok(mismatchAt >= 0);
  assert.ok(repairAt > mismatchAt);
  assert.ok(providerAt > repairAt);
  assert.match(start, /hasActiveLanguageValidationJob\(db, identityKey, "movie", itemId\)/);
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
  assert.match(fingerprint, /durationSeconds: Number\(profile\.durationSeconds\)/);
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
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  assert.match(worker, /"claim_catalog_file_audio_validation_job"/);
  assert.match(worker, /"claim_provider_file_probe"/);
  assert.match(worker, /p_ttl_seconds: LANGUAGE_VALIDATION_LEASE_SECONDS/);
  assert.match(worker, /const exactDurationSeconds = Number\([\s\S]*exactAfterLease\.exactProfile\.profile\.durationSeconds/);
  assert.match(worker, /!Number\.isFinite\(exactDurationSeconds\)[\s\S]*exactDurationSeconds <= 0[\s\S]*exactDurationSeconds > 24 \* 60 \* 60/);
  assert.match(worker, /LANGUAGE_VALIDATION_DURATION_INVALID/);
  assert.match(playback, /"LANGUAGE_VALIDATION_DURATION_INVALID",[\s\S]*"LANGUAGE_VALIDATION_IDENTITY_REQUIRED"/);
  assert.match(worker, /LANGUAGE_VALIDATION_SCOPE,[\s\S]*exactAfterLease\.exactProfile\.fileSizeBytes,[\s\S]*exactDurationSeconds/);
  assert.match(worker, /\?index=\$\{trackIndex\}&strict=1&dur=\$\{LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS\}/);
  assert.doesNotMatch(worker, /[?&]durationSeconds=/);
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
  assert.match(worker, /"checkpoint_catalog_file_audio_validation_window"/);
  assert.match(worker, /providerLeaseClaimed[\s\S]*providerAccountLeaseReleaseSafe[\s\S]*releaseProviderFileProbe\(db, identityKey, providerLeaseOwner\)/);
});

test('Edge checkpoints exactly one signed window and never returns its opaque receipt', () => {
  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  assert.match(worker, /strictLidWindowStateFromClaim\(claim, initialDurationSeconds\)/);
  assert.match(worker, /windowState\.position === windowState\.count[\s\S]*finalizeLanguageValidationTrackWindows/);
  assert.match(worker, /windowCheckpointProtocol: LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL/);
  assert.match(worker, /profileFingerprint: exactAfterLease\.fingerprint/);
  assert.match(worker, /windowOrdinal,[\s\S]*windowCount: windowState\.count/);
  assert.match(worker, /strictLidWindowCheckpointFromGateway\([\s\S]*windowOrdinal,[\s\S]*windowState\.count/);
  assert.match(worker, /strictLanguageProviderDrainAttested\(payload\)/);
  assert.match(worker, /"checkpoint_catalog_file_audio_validation_window"/);
  assert.match(worker, /p_window_token: receipt/);
  assert.ok(worker.indexOf('if (!response.ok)') < worker.indexOf('checkpoint_catalog_file_audio_validation_window'));
  assert.doesNotMatch(worker, /languageValidationPendingResponse[\s\S]*receipt/);
});

test('finalize uses a dedicated no-provider capability and resets only the authenticated 409 contract', () => {
  const finalizeWindows = between(
    playback,
    'async function finalizeLanguageValidationTrackWindows(',
    '\nasync function finalizeLanguageValidationJob(',
  );
  assert.match(finalizeWindows, /windowFinalize: true/);
  assert.doesNotMatch(
    finalizeWindows.slice(finalizeWindows.indexOf('windowFinalize: true'), finalizeWindows.indexOf('let response: Response')),
    /windowOrdinal/,
  );
  assert.match(finalizeWindows, /\/detect-language\/finalize\?index=\$\{trackIndex\}/);
  assert.match(finalizeWindows, /body = JSON\.stringify\(\{ receipts: windowState\.tokens \}\)/);
  assert.match(finalizeWindows, /response\.status === 409/);
  assert.match(finalizeWindows, /gatewayCode === "strict_lid_checkpoint_reset_required"/);
  assert.match(finalizeWindows, /payload\.resetRequired === true/);
  assert.match(finalizeWindows, /providerDrained/);
  assert.match(finalizeWindows, /"reset_catalog_file_audio_validation_windows"/);
  assert.match(finalizeWindows, /"checkpoint_catalog_file_audio_validation_track"/);
  assert.ok(
    finalizeWindows.indexOf('strictLanguageValidationEvidence')
      < finalizeWindows.indexOf('checkpoint_catalog_file_audio_validation_track'),
  );
  assert.doesNotMatch(finalizeWindows, /claim_provider_account_language_validation|claim_provider_file_probe/);
});

test('window receipt grammar, cardinality and capability bindings are fail-closed', () => {
  assert.match(playback, /LANGUAGE_VALIDATION_WINDOW_RECEIPT_MAX_CHARS = 98_304/);
  assert.match(playback, /\^v1\\\.\[a-f0-9\]\{16\}\\\.\[A-Za-z0-9_-\]\{16\}\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\{22\}\$/);
  const state = between(
    playback,
    'function strictLidWindowStateFromClaim(',
    '\nfunction strictLidWindowCheckpointFromGateway(',
  );
  assert.match(state, /count !== expectedCount/);
  assert.match(state, /rawTokens\.length !== position/);
  assert.match(state, /new Set\(exactTokens\)\.size !== exactTokens\.length/);
  const capability = between(
    playback,
    'async function createBytePipeCapability(',
    '\nasync function createBytePipeAccess(',
  );
  assert.match(capability, /PLAYBACK_SESSION_UUID_PATTERN\.test\(strictLidWindowClaims\.jobId\)/);
  assert.match(capability, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(capability, /finalizing && strictLidWindowClaims\.windowOrdinal !== undefined/);
  assert.match(capability, /windowFinalize: true/);
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
    '\nconst MEDIA_CACHE_OBJECT_KEY_PATTERN',
  );
  for (const response of [pending, failed, verified]) {
    assert.doesNotMatch(response, /providerUrl|targetUrl|token|transcript|samples/i);
  }
  assert.match(pending, /jobId: options\.jobId/);
  assert.match(pending, /retryAfter/);
  assert.match(verified, /audioTracks: options\.audioTracks/);
});

test('Edge keeps real audio-map drift fail-closed but repairs a proven stale file-local preference', () => {
  const gateway = between(
    playback,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  assert.match(gateway, /const requestedAudioStreamIndex = boundedNullableInt/);
  assert.match(gateway, /const staleRequestedAudioFallback = gatewayProvesRequestedAudioFallback/);
  assert.match(gateway, /audioStreamIndex !== requestedAudioStreamIndex &&[\s\S]*!staleRequestedAudioFallback/);
  assert.match(gateway, /AUDIO_STREAM_MAP_MISMATCH/);
  assert.match(gateway, /const cleanup = await cleanupCreatedSession\(\)/);
});

test('audio fallback requires an exact current-file inventory that excludes the stale index', () => {
  const source = between(
    playback,
    'function hasExactGatewayInbandVodProfile(',
    '\nasync function loadLanguageValidationIdentity(',
  )
    .replaceAll(': unknown', '')
    .replaceAll(': number | null', '');
  const context = {
    recordOrEmpty: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    hasReliableVodCodecProfile: value => Boolean(value?.videoCodec && value?.audioCodec && value?.container),
    normalizeCodecProfile: value => value,
    normalizeCodecToken: value => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    canonicalVodContainer: value => {
      const token = String(value || '').toLowerCase();
      return ['mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg'].includes(token) ? token : null;
    },
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    Number,
    Date,
    Boolean,
    Set,
    Array,
  };
  vm.runInNewContext(
    `${source}; this.fallback = gatewayProvesRequestedAudioFallback;`,
    context,
  );
  const exact = {
    metadataComplete: true,
    container: 'mkv',
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioTracks: [{ index: 1 }, { index: 2 }],
    subtitles: [],
    durationSeconds: 3324,
    fileSizeBytes: 1801768324,
    probedAt: '2026-08-29T20:41:20.000Z',
    probeSource: 'gateway_inband',
  };

  assert.equal(context.fallback(exact, 0, 1), true);
  assert.equal(context.fallback(exact, 2, 1), false, 'a real requested audio track may not be replaced');
  assert.equal(context.fallback({ ...exact, metadataComplete: false }, 0, 1), false);
  assert.equal(context.fallback({ ...exact, audioTracks: [{ index: 1 }, { index: 1 }] }, 0, 1), false);
  assert.equal(context.fallback(exact, 0, 3), false, 'the mapped track must exist in the exact inventory');
});
