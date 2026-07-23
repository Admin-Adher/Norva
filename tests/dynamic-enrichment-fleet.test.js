'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};
const latestMigrationContaining = (marker) => {
  const directory = path.join(ROOT, 'supabase/migrations');
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(directory, name), 'utf8'),
    }))
    .filter(({ source }) => source.includes(marker));
  assert.ok(candidates.length > 0, `no migration contains: ${marker}`);
  return candidates.at(-1);
};

test('enrichment queue reconciles active current and future provider sources', () => {
  const migration = read('supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql');
  const claim = between(
    migration,
    'create or replace function public.claim_catalog_enrichment_sources(',
    '\nrevoke all on function public.claim_catalog_enrichment_sources(',
  );

  assert.match(claim, /insert into public\.catalog_enrichment_source_schedule/);
  assert.match(claim, /from public\.cloud_sources source/);
  assert.match(claim, /source\.sync_status = 'ready'/);
  assert.match(claim, /source\.enabled = true/);
  assert.match(claim, /source\.deleted_at is null/);
  assert.match(claim, /exists \(\s*select 1\s*from public\.cloud_title_variants variant/);
  assert.match(claim, /on conflict on constraint catalog_enrichment_source_schedule_pkey do update/);
  assert.doesNotMatch(claim, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('claims are leased, fair, and bounded by user and provider identity', () => {
  const migration = read('supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql');
  const claim = between(
    migration,
    'create or replace function public.claim_catalog_enrichment_sources(',
    '\nrevoke all on function public.claim_catalog_enrichment_sources(',
  );
  const finish = between(
    migration,
    'create or replace function public.finish_catalog_enrichment_source(',
    '\nrevoke all on function public.finish_catalog_enrichment_source(',
  );

  assert.match(claim, /for update of schedule skip locked/);
  assert.match(claim, /candidate\.user_id = any\(claimed_users\)/);
  assert.match(claim, /candidate\.identity_key = any\(claimed_identities\)/);
  assert.match(claim, /catalog_enrichment_dispatch_leases/);
  assert.match(claim, /catalog_source_provider_identities verified_identity/);
  assert.match(claim, /'identity:' \|\| verified_identity\.identity_id::text/);
  assert.doesNotMatch(claim, /config_hint->>'(?:providerKey|serverHost)'/);
  assert.match(claim, /lease\.expires_at < clock_timestamp\(\) - interval '1 day'/);
  assert.match(claim, /claim_token = token/);
  assert.match(finish, /schedule\.claim_token = p_claim_token/);
  assert.match(finish, /p_release_leases/);
  assert.match(finish, /where lease\.claim_token = p_claim_token/);
});

test('source-sync dispatcher forwards claimed ownership, never static ids', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const route = between(
    sourceSync,
    'async function finishEnrichmentFleetClaim(',
    '\nasync function cronRefreshDue(',
  );

  assert.match(sourceSync, /segments\[1\] === "enrichment-fleet"/);
  assert.match(route, /db\.rpc\("claim_catalog_enrichment_sources"/);
  assert.match(route, /userId: claim\.user_id/);
  assert.match(route, /sourceId: claim\.source_id/);
  assert.match(route, /dispatch_count/);
  assert.match(route, /type: episodeProbe \|\| episodeSpeech \? "episode" : "movie"/);
  assert.match(route, /mode: speechVerification \|\| episodeSpeech \? "whisper" : "probe"/);
  assert.match(route, /target: subtitleProbe \? "subtitle" : undefined/);
  assert.match(route, /fallthrough: false/);
  assert.match(
    route,
    /limit: episodeProbe \? 4 : episodeSpeech \? 1 : speechVerification \? 2 : 4/,
  );
  assert.match(sourceSync, /boundedInt\(url\.searchParams\.get\("limit"\), 8, 1, 8\)/);
  assert.match(route, /fileScope: true/);
  assert.match(route, /concurrency: 1/);
  assert.match(route, /p_lease_seconds: 1200/);
  assert.match(route, /responseReceived/);
  assert.match(route, /db\.rpc\("catalog_enrichment_fleet_preflight"\)/);
  assert.match(route, /response\.status !== 400/);
  assert.match(route, /Missing userId/);
  assert.match(route, /runInBackground\(Promise\.all/);
  assert.match(route, /finish_catalog_enrichment_source/);
  assert.match(route, /throw new HttpError\(503, "NORVA_BACKFILL_TOKEN is not configured"\)/);
  assert.doesNotMatch(route, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('generic cron replaces movie detection jobs but preserves subtitle pregen and series coverage', () => {
  const migration = read('supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql');
  const tuning = read('supabase/migrations/20260719210000_fast_audio_language_detection.sql');
  const activate = read('ops/hetzner/scripts/16-activate-dynamic-enrichment-fleet.sh');
  assert.match(migration, /'norva-dynamic-enrichment-fleet'/);
  assert.match(migration, /\/norva-source-sync\/cron\/enrichment-fleet\?limit=4/);
  assert.doesNotMatch(tuning, /cron\.schedule\(/);
  assert.doesNotMatch(tuning, /cron\.alter_job/);
  assert.doesNotMatch(tuning, /update cron\.job/);
  assert.match(tuning, /operational state owned by postgres/);
  assert.match(activate, /enrichment-fleet\?limit=8/);
  assert.match(migration, /cron\.alter_job\(dynamic_job_id, active => false\)/);
  assert.match(activate, /command like '%\/norva-playback\/audio-backfill%'/);
  assert.match(activate, /command not like '%transcribe-whitelist%'/);
  assert.match(activate, /jobname <> 'norva-whisper-airo-king365-series'/);
  assert.match(activate, /command !~\* \$series_pattern\$/);
  assert.match(activate, /environment and Vault cron secrets differ/);
  assert.match(activate, /active_legacy_movies <> 0 or active_dynamic <> 1/);
  assert.match(activate, /set active = false/);
  assert.match(activate, /set active = true/);
  assert.match(activate, /enrichment-fleet\?dryRun=1/);
});

test('server sync owns the canonical cross-tenant provider link', () => {
  const sync = read('supabase/functions/_shared/xtream-sync.ts');
  const record = between(
    sync,
    'export async function recordProviderIdentity(',
    '\nexport function freshSyncCursor(',
  );
  assert.match(record, /db\.rpc\("norva_resolve_provider_identity"/);
  assert.match(record, /catalog_source_provider_identities/);
  assert.match(record, /identity_id: identityId/);
  assert.match(record, /provider_key: providerKey/);
  assert.match(record, /\[provider-identity\] scheduler link failed/);
});

test('stale completion tokens cannot release a newer lease', () => {
  const finish = (state, token, release) => {
    if (state.claimToken !== token) return false;
    state.dispatchCount += 1;
    if (release) {
      state.claimToken = null;
      state.leaseUntil = null;
    }
    return true;
  };
  const state = { claimToken: 'new', leaseUntil: 900, dispatchCount: 4 };
  assert.strictEqual(finish(state, 'old', true), false);
  assert.deepStrictEqual(state, { claimToken: 'new', leaseUntil: 900, dispatchCount: 4 });
  assert.strictEqual(finish(state, 'new', false), true);
  assert.deepStrictEqual(state, { claimToken: 'new', leaseUntil: 900, dispatchCount: 5 });
});

test('twelve-lane cycle doubles every exact-file series stage without raising provider concurrency', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const dispatcher = between(
    sourceSync,
    'async function runEnrichmentFleetClaim(',
    '\n// Claim a bounded, fair batch',
  );
  const isMovieSpeech = (dispatchCount) => [1, 4, 8].includes(dispatchCount % 12);
  const isSeriesInventory = (dispatchCount) => [5, 9].includes(dispatchCount % 12);
  const isEpisodeProbe = (dispatchCount) => [2, 7].includes(dispatchCount % 12);
  const isEpisodeSpeech = (dispatchCount) => [6, 10].includes(dispatchCount % 12);
  const isOverview = (dispatchCount) => dispatchCount % 12 === 11;
  assert.match(sourceSync, /seriesPriorityCycleV2: true/);
  assert.deepStrictEqual(
    Array.from({ length: 12 }, (_, lane) => isMovieSpeech(lane)),
    [false, true, false, false, true, false, false, false, true, false, false, false],
  );
  assert.strictEqual(
    Array.from({ length: 12 }, (_, lane) => isMovieSpeech(lane)).filter(Boolean).length,
    3,
    'movie Whisper keeps two tagged lanes and one untagged lane',
  );
  assert.deepStrictEqual(
    Array.from({ length: 12 }, (_, lane) => isSeriesInventory(lane))
      .map((enabled, lane) => enabled ? lane : null).filter((lane) => lane !== null),
    [5, 9],
  );
  assert.deepStrictEqual(
    Array.from({ length: 12 }, (_, lane) => isEpisodeProbe(lane))
      .map((enabled, lane) => enabled ? lane : null).filter((lane) => lane !== null),
    [2, 7],
  );
  assert.deepStrictEqual(
    Array.from({ length: 12 }, (_, lane) => isEpisodeSpeech(lane))
      .map((enabled, lane) => enabled ? lane : null).filter((lane) => lane !== null),
    [6, 10],
  );
  assert.match(dispatcher, /dispatch_count\) \|\| 0\) % 12/);
  assert.match(
    dispatcher,
    /const speechVerification = lane === 1 \|\| lane === 4 \|\| lane === 8/,
  );
  assert.match(dispatcher, /const seriesInventory = lane === 5 \|\| lane === 9/);
  assert.match(dispatcher, /const episodeProbe = lane === 2 \|\| lane === 7/);
  assert.match(dispatcher, /const episodeSpeech = lane === 6 \|\| lane === 10/);
  assert.match(dispatcher, /concurrency: 1/);
  // finish_catalog_enrichment_source increments on every valid completion,
  // including an error with leases retained.
  assert.strictEqual(isOverview(11), true);
  assert.strictEqual(isOverview(12), false);

  const migration = read('supabase/migrations/20260719190000_provider_overview_crawler.sql');
  const finish = between(
    migration,
    'create or replace function public.finish_catalog_enrichment_source(',
    '\nrevoke all on function public.finish_catalog_enrichment_source(',
  );
  assert.match(finish, /dispatch_count = schedule\.dispatch_count \+ 1/);
});

test('drained audio lanes rotate promptly to subtitles before the full sweep rests', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const latestFinish = latestMigrationContaining(
    'create or replace function public.finish_catalog_enrichment_source(',
  );
  const delay = between(
    sourceSync,
    'function enrichmentFleetNextDelay(',
    '\nasync function finishEnrichmentFleetClaim(',
  );
  const finish = between(
    latestFinish.source,
    'create or replace function public.finish_catalog_enrichment_source(',
    '\nrevoke all on function public.finish_catalog_enrichment_source(',
  );
  assert.match(delay, /summary\.exhausted === true\) && lane < 11\) return 30/);
  assert.match(delay, /Number\(summary\.processed\) > 0\) return 30/);

  const nextDelay = (exhausted, lane) => exhausted && lane < 11 ? 30 : 6 * 60 * 60;
  assert.deepStrictEqual([0, 1, 2].map((lane) => nextDelay(true, lane)), [30, 30, 30]);
  assert.strictEqual(nextDelay(true, 10), 30);
  assert.strictEqual(nextDelay(true, 11), 6 * 60 * 60);

  // The database remembers that any of lanes 0-10 worked. Therefore an empty
  // synopsis lane 11 advances promptly instead of collapsing active throughput.
  assert.match(finish, /mod\(schedule\.dispatch_count, 12\)/);
  assert.match(finish, /result_had_work := .*p_result->>'processed'/s);
  assert.match(finish, /current_lane = 11 and prior_cycle_had_work/);
  assert.match(finish, /delay_seconds := least\(delay_seconds, 30\)/);
  assert.match(finish, /when current_lane = 11 then false/);
  const finalLaneDelay = (priorLanesWorked) => priorLanesWorked ? 30 : 6 * 60 * 60;
  assert.strictEqual(finalLaneDelay(Array(11).fill(4).some((processed) => processed > 0)), 30);
  assert.strictEqual(finalLaneDelay(Array(11).fill(0).some((processed) => processed > 0)), 6 * 60 * 60);
});

test('throughput tuning raises the fleet ceiling and speech batch without intra-provider concurrency', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const activation = read('ops/hetzner/scripts/16-activate-dynamic-enrichment-fleet.sh');
  const route = between(
    sourceSync,
    'async function finishEnrichmentFleetClaim(',
    '\nasync function cronRefreshDue(',
  );

  // Real throughput also includes provider/extraction time and must be measured
  // after deployment. These are the structural ceilings: twice as many
  // independent claims and twice as many bounded files per speech claim.
  assert.match(sourceSync, /boundedInt\(url\.searchParams\.get\("limit"\), 8, 1, 8\)/);
  assert.match(activation, /enrichment-fleet\?limit=8/);
  assert.match(
    route,
    /limit: episodeProbe \? 4 : episodeSpeech \? 1 : speechVerification \? 2 : 4/,
  );
  assert.match(route, /concurrency: 1/);
  assert.match(
    route,
    /\(speechVerification \|\| episodeSpeech\) \? 540_000 : 105_000/,
  );
  assert.match(route, /p_lease_seconds: 1200/);
  assert.doesNotMatch(activation, /delete from public\.catalog_enrichment_dispatch_leases/);
});

test('episode lanes are exact, individually bounded, flag-gated, and fail closed', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const dispatcher = between(
    sourceSync,
    'async function runEnrichmentFleetClaim(',
    '\n// Claim a bounded, fair batch',
  );
  const exactWorker = between(
    playback,
    'async function claimProviderFileProbeStrict(',
    '\nasync function runOneDimension(',
  );

  assert.match(dispatcher, /const episodeProbe = lane === 2 \|\| lane === 7/);
  assert.match(dispatcher, /const episodeSpeech = lane === 6 \|\| lane === 10/);
  assert.match(dispatcher, /type: episodeProbe \|\| episodeSpeech \? "episode" : "movie"/);
  assert.match(dispatcher, /mode: speechVerification \|\| episodeSpeech \? "whisper" : "probe"/);
  assert.match(
    dispatcher,
    /limit: episodeProbe \? 4 : episodeSpeech \? 1 : speechVerification \? 2 : 4/,
  );

  const laneContract = (lane) => ({
    type: [2, 6, 7, 10].includes(lane) ? 'episode' : 'movie',
    mode: [1, 4, 6, 8, 10].includes(lane) ? 'whisper' : 'probe',
    limit: [2, 7].includes(lane) ? 4 : [6, 10].includes(lane) ? 1 : [1, 4, 8].includes(lane) ? 2 : 4,
  });
  assert.deepStrictEqual(laneContract(2), { type: 'episode', mode: 'probe', limit: 4 });
  assert.deepStrictEqual(laneContract(7), { type: 'episode', mode: 'probe', limit: 4 });
  assert.deepStrictEqual(laneContract(6), { type: 'episode', mode: 'whisper', limit: 1 });
  assert.deepStrictEqual(laneContract(10), { type: 'episode', mode: 'whisper', limit: 1 });

  assert.match(exactWorker, /p_key: "episode_audio_scan_enabled"/);
  assert.match(exactWorker, /if \(error \|\| enabled !== true\)/);
  assert.match(
    exactWorker,
    /catch \(_\) \{\s*return \{ mode, itemType: "episode", processed: 0, skipped: "episode-audio-scan-disabled" \}/,
  );
  assert.match(exactWorker, /return !error && data === true/);
  assert.match(exactWorker, /catch \(_\) \{\s*return false/);
  assert.match(exactWorker, /if \(eventsError\) return "viewer-guard-unavailable"/);
  assert.match(exactWorker, /if \(historyError\) return "viewer-guard-unavailable"/);
  assert.match(exactWorker, /if \(sessionsError\) return "viewer-guard-unavailable"/);
  assert.match(exactWorker, /if \(pregenError\) return "pregen-guard-unavailable"/);
  assert.match(exactWorker, /if \(busyError\) return "provider-guard-unavailable"/);
  assert.match(exactWorker, /return "background-guard-unavailable"/);
  assert.match(exactWorker, /\.select\("source_type"\)/);
  assert.match(exactWorker, /source_type, ""\) !== "xtream"/);
  assert.match(exactWorker, /skipped: "unsupported-source"/);
  assert.match(exactWorker, /sourceIdentity\.key\.startsWith\("source:"\)/);
  assert.match(exactWorker, /stringOr\(row\.user_id, ""\) === userId/);
  assert.match(exactWorker, /stringOr\(row\.source_id, ""\) === sourceId/);
  assert.match(exactWorker, /stringOr\(row\.server_host, ""\) === sourceIdentity\.key/);
  assert.match(exactWorker, /const beforeClaimBlock = await episodeBackgroundBlockReason/);
  assert.match(exactWorker, /const raceBlock = await episodeBackgroundBlockReason/);
  assert.match(exactWorker, /streamType: "series"/);
  assert.match(exactWorker, /sourceIdentity\.key,\s*"episode",\s*episodeId/);
  assert.match(exactWorker, /itemType: "episode"/);
  assert.match(exactWorker, /response\.status === 409 \|\| response\.status === 429/);
  assert.match(exactWorker, /\.select\("audio_tracks,audio_whisper_attempted_at,audio_whisper_retry_at"\)/);
  assert.match(exactWorker, /if \(cacheAdvanced\) \{\s*processed \+= 1;\s*persisted \+= 1/);
  assert.match(exactWorker, /deferred \+= 1/);
  assert.match(
    exactWorker,
    /finally \{\s*await releaseProviderFileProbe\(db, sourceIdentity\.key, leaseOwner\)/,
  );
});

test('series inventory lane is local, metadata-only, bounded, and fail closed', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const foundation = read('supabase/migrations/20260720180000_series_episode_audio_foundation.sql');
  const inventory = between(
    sourceSync,
    'async function recordSeriesInventoryOutcome(',
    '\nasync function runEnrichmentFleetClaim(',
  );
  const dispatcher = between(
    sourceSync,
    'async function runEnrichmentFleetClaim(',
    '\n// Claim a bounded, fair batch',
  );
  const candidates = between(
    foundation,
    'create or replace function public.catalog_series_inventory_candidates(',
    '\nrevoke all on function public.catalog_series_inventory_candidates(',
  );
  const outcome = between(
    foundation,
    'create or replace function public.record_catalog_series_inventory_outcome(',
    '\nrevoke all on function public.record_catalog_series_inventory_outcome(',
  );
  const transport = between(
    sourceSync,
    'async function fetchSeriesInventoryMetadata(',
    '\nasync function signSeriesInventoryRelayToken(',
  );

  assert.match(dispatcher, /const seriesInventory = lane === 5 \|\| lane === 9/);
  assert.match(
    dispatcher,
    /if \(seriesInventory\) \{\s*localLane = true;\s*const result = await runSeriesInventoryFleetLane/,
  );
  assert.match(foundation, /'episode_audio_scan_enabled',\s*false/);
  assert.match(inventory, /p_key: "episode_audio_scan_enabled"/);
  assert.match(inventory, /if \(error \|\| enabled !== true\)/);
  assert.match(
    inventory,
    /catch \(_\) \{\s*return \{\s*mode: "series-inventory",[\s\S]*skipped: "episode-audio-scan-disabled"/,
  );

  assert.match(inventory, /const limit = 2/);
  assert.match(inventory, /"catalog_series_inventory_candidates"/);
  assert.match(inventory, /p_user: claim\.user_id/);
  assert.match(inventory, /p_source: claim\.source_id/);
  assert.match(inventory, /p_limit: limit/);
  assert.match(inventory, /"record_catalog_series_inventory_outcome"/);
  assert.match(inventory, /"register_catalog_series_episodes"/);
  assert.match(inventory, /fetchSeriesInventoryMetadata\(/);
  assert.match(inventory, /parentSeriesId/);
  assert.match(inventory, /stripSeriesInventoryCredentials\(/);
  assert.doesNotMatch(inventory, /fetchProviderMetadata\(|fetchJson\(|xtreamApiUrl\(/);
  assert.ok(transport.indexOf('runtimeConfig.relayBaseUrl') < transport.indexOf('requestGatewayMetadata('));
  assert.match(transport, /action: "get_series_info"/);
  assert.match(transport, /params: \{ series_id: args\.parentSeriesId \}/);
  assert.match(sourceSync, /key\.toLowerCase\(\) === "direct_source"/);

  assert.match(inventory, /if \(error\) return "unavailable"/);
  assert.match(inventory, /catch \(_\) \{\s*return "unavailable"/);
  assert.match(inventory, /if \(initialAvailability !== "idle"\)/);
  assert.match(inventory, /const availability = await providerBusy\(\)/);
  assert.match(inventory, /if \(availability !== "idle"\)/);
  assert.match(
    inventory,
    /status === 401 \|\| status === 403 \|\| status === 429 \|\| status >= 500/,
  );

  assert.match(candidates, /variant\.user_id = p_user/);
  assert.match(candidates, /variant\.source_id = p_source/);
  assert.match(candidates, /variant\.item_type = 'series'/);
  assert.match(candidates, /source\.sync_status = 'ready'/);
  assert.match(candidates, /source\.source_type = 'xtream'/);
  assert.match(candidates, /catalog_source_provider_identities identity/);
  assert.match(candidates, /inventory\.next_retry_at <= now\(\)/);
  assert.doesNotMatch(candidates, /config_hint|providerKey|serverHost/);

  assert.match(outcome, /p_success and \(p_episode_count is null or p_episode_count <= 0\)/);
  assert.match(outcome, /v_registered_episode_count <> p_episode_count/);
  assert.match(outcome, /variant\.user_id = p_user/);
  assert.match(outcome, /variant\.source_id = p_source/);
  assert.match(outcome, /variant\.item_type = 'series'/);
  assert.match(outcome, /variant\.external_id = btrim\(p_parent_series_id\)/);
  assert.match(outcome, /catalog_source_provider_identities identity/);
  assert.match(outcome, /if not found then\s*return false/);
  assert.match(outcome, /pg_advisory_xact_lock/);
  assert.match(outcome, /on conflict \(source_id, parent_series_id\) do update/);
  assert.doesNotMatch(outcome, /config_hint|providerKey|serverHost/);
});

test('fleet audit metrics describe only the explicit row set actually attempted', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const summary = between(
    sourceSync,
    'function enrichmentFleetSummary(',
    '\nfunction enrichmentFleetNextDelay(',
  );
  assert.match(summary, /const processed = Math\.max\(0, Number\(body\.processed\) \|\| 0\)/);
  assert.match(summary, /attempted: Math\.max\(0, Number\(body\.attempted\) \|\| 0\)/);
  assert.match(summary, /resolved: Math\.max\(0, Number\(body\.resolved\) \|\| 0\)/);
  assert.match(summary, /deferred: Math\.max\(0, Number\(body\.deferred\) \|\| 0\)/);
  assert.match(summary, /lastId: processed > 0 \? stringOrNull\(body\.lastId\) : null/);
  assert.doesNotMatch(summary, /processedFromTried|body\.tried|nested\.processed|nested\.lastId/);
});
