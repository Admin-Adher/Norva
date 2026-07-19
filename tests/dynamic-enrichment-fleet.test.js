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
  assert.match(route, /mode: speechVerification \? "whisper" : "probe"/);
  assert.match(route, /target: subtitleProbe \? "subtitle" : undefined/);
  assert.match(route, /fallthrough: false/);
  assert.match(route, /limit: speechVerification \? 2 : 4/);
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

test('speech-heavy lanes keep language detection from falling behind raw probes', () => {
  const isSpeech = (dispatchCount) => [1, 2, 4].includes(dispatchCount % 6);
  const isOverview = (dispatchCount) => dispatchCount % 6 === 5;
  assert.deepStrictEqual(
    Array.from({ length: 6 }, (_, lane) => isSpeech(lane)),
    [false, true, true, false, true, false],
  );
  assert.strictEqual(isSpeech(4), true);
  // finish_catalog_enrichment_source increments on every valid completion,
  // including an error with leases retained.
  assert.strictEqual(isSpeech(5), false);
  assert.strictEqual(isOverview(5), true);
  assert.strictEqual(isOverview(6), false);

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
  const migration = read('supabase/migrations/20260719190000_provider_overview_crawler.sql');
  const delay = between(
    sourceSync,
    'function enrichmentFleetNextDelay(',
    '\nasync function finishEnrichmentFleetClaim(',
  );
  assert.match(delay, /summary\.exhausted === true\) && lane < 5\) return 30/);
  assert.match(delay, /Number\(summary\.processed\) > 0\) return 30/);

  const nextDelay = (exhausted, lane) => exhausted && lane < 5 ? 30 : 6 * 60 * 60;
  assert.deepStrictEqual([0, 1, 2].map((lane) => nextDelay(true, lane)), [30, 30, 30]);
  assert.strictEqual(nextDelay(true, 4), 30);
  assert.strictEqual(nextDelay(true, 5), 6 * 60 * 60);

  // The database remembers that any of lanes 0-4 worked. Therefore an empty
  // synopsis lane 5 advances promptly instead of collapsing active throughput to one
  // bounded batch per six hours.
  assert.match(migration, /result_had_work := .*p_result->>'processed'/s);
  assert.match(migration, /current_lane = 5 and prior_cycle_had_work/);
  assert.match(migration, /delay_seconds := least\(delay_seconds, 30\)/);
  const finalLaneDelay = (priorLanesWorked) => priorLanesWorked ? 30 : 6 * 60 * 60;
  assert.strictEqual(finalLaneDelay([4, 4, 4, 4].some((processed) => processed > 0)), 30);
  assert.strictEqual(finalLaneDelay([0, 0, 0, 0].some((processed) => processed > 0)), 6 * 60 * 60);
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
  assert.match(route, /limit: speechVerification \? 2 : 4/);
  assert.match(route, /concurrency: 1/);
  assert.match(route, /speechVerification \? 540_000 : 105_000/);
  assert.match(route, /p_lease_seconds: 1200/);
  assert.doesNotMatch(activation, /delete from public\.catalog_enrichment_dispatch_leases/);
});

test('fleet audit metrics describe only the explicit row set actually attempted', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const summary = between(
    sourceSync,
    'function enrichmentFleetSummary(',
    '\nfunction enrichmentFleetNextDelay(',
  );
  assert.match(summary, /const processed = Math\.max\(0, Number\(body\.processed\) \|\| 0\)/);
  assert.match(summary, /lastId: processed > 0 \? stringOrNull\(body\.lastId\) : null/);
  assert.doesNotMatch(summary, /processedFromTried|body\.tried|nested\.processed|nested\.lastId/);
});
