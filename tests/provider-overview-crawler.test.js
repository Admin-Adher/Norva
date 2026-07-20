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

test('overview candidates are exact-file, bounded, resumable, and identity verified', () => {
  const migration = read('supabase/migrations/20260719190000_provider_overview_crawler.sql');
  const claim = between(
    migration,
    'create or replace function public.claim_provider_overview_candidates(',
    '\nrevoke all on function public.claim_provider_overview_candidates(',
  );

  assert.match(claim, /catalog_source_provider_identities link/);
  assert.match(claim, /link\.source_id = source\.id/);
  assert.match(claim, /source\.source_type = 'xtream'/);
  assert.match(claim, /variant\.external_id/);
  assert.match(claim, /variant\.media_item_id/);
  assert.match(claim, /row_number\(\) over \(\s*partition by variant\.title_id/s);
  assert.match(claim, /cache\.overview_status in \('missing', 'retry'\)/);
  assert.match(claim, /cache\.overview_retry_at/);
  assert.match(claim, /limit greatest\(1, least\(8, coalesce\(p_limit, 4\)\)\)/);
  assert.match(claim, /catalog\.metadata #>> '\{tmdbValidation,valid\}' = 'true'/);
  assert.doesNotMatch(claim, /config_hint|providerKey|serverHost/);
  assert.doesNotMatch(claim, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('recording fans out only through canonical identity and never overwrites text', () => {
  const migration = read('supabase/migrations/20260719190000_provider_overview_crawler.sql');
  const record = between(
    migration,
    'create or replace function public.record_provider_overview_outcome(',
    '\nrevoke all on function public.record_provider_overview_outcome(',
  );

  assert.match(record, /select link\.identity_id\s+into canonical_identity/s);
  assert.match(record, /source has no server-verified provider identity/);
  assert.match(record, /canonical_identity::text/);
  assert.match(record, /on conflict \(server_host, item_type, external_id\) do update/);
  assert.match(record, /cache\.overview_status = 'resolved'/);
  assert.match(record, /from public\.catalog_source_provider_identities link/);
  assert.match(record, /where link\.identity_id = canonical_identity/);
  assert.match(record, /update public\.cloud_media_items media/);
  assert.match(record, /update public\.cloud_title_variants variant/);
  assert.match(record, /update public\.cloud_titles title/);
  assert.match(record, /metadata #>> '\{tmdb,overview\}'/);
  assert.match(migration, /grant execute on function public\.record_provider_overview_outcome\([\s\S]*?\)\s+to service_role/);
  assert.doesNotMatch(record, /config_hint|providerKey|serverHost/);
});

test('worker parses only known vod-info synopsis fields and uses conservative retries', () => {
  const worker = read('supabase/functions/_shared/provider-overview-backfill.ts');
  const parser = between(
    worker,
    'export function extractProviderOverview(',
    '\nfunction cleanProviderId(',
  );
  const backfill = between(
    worker,
    'export async function backfillProviderOverviews(',
    '\n}',
  );

  assert.match(parser, /info\.plot/);
  assert.match(parser, /movie\.description/);
  assert.match(parser, /root\.overview/);
  assert.doesNotMatch(parser, /title|category|message|error/);
  assert.match(worker, /Math\.min\(8, Number\(options\.limit\) \|\| 4\)/);
  assert.match(worker, /Math\.min\(2, Number\(options\.concurrency\) \|\| 2\)/);
  assert.match(worker, /status === 401 \|\| status === 403 \|\| status === 429/);
  assert.match(worker, /90 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /canonical-provider-cache/);
  assert.match(worker, /record_provider_overview_outcome/);
  assert.match(backfill, /claim_provider_overview_candidates/);
});

test('dynamic fleet keeps provider overview as the final twelfth lane', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const migration = read('supabase/migrations/20260719190000_provider_overview_crawler.sql');
  const latestFinish = latestMigrationContaining(
    'create or replace function public.finish_catalog_enrichment_source(',
  );
  const activation = read('ops/hetzner/scripts/16-activate-dynamic-enrichment-fleet.sh');
  const overviewLane = between(
    sourceSync,
    'async function runProviderOverviewFleetLane(',
    '\nasync function recordSeriesInventoryOutcome(',
  );
  const dispatcher = between(
    sourceSync,
    'async function runEnrichmentFleetClaim(',
    '\n// Claim a bounded, fair batch',
  );
  const finish = between(
    latestFinish.source,
    'create or replace function public.finish_catalog_enrichment_source(',
    '\nrevoke all on function public.finish_catalog_enrichment_source(',
  );

  assert.match(dispatcher, /dispatch_count\) \|\| 0\) % 12/);
  assert.match(dispatcher, /providerOverview = lane === 11/);
  assert.match(overviewLane, /backfillProviderOverviews/);
  assert.match(overviewLane, /action: "get_vod_info"/);
  assert.match(overviewLane, /params: \{ vod_id: externalId \}/);
  assert.match(overviewLane, /limit: 4/);
  assert.match(overviewLane, /concurrency: 2/);
  assert.match(overviewLane, /catalog_source_provider_identities/);
  assert.doesNotMatch(overviewLane, /config_hint|providerKey|serverHost/);
  assert.match(finish, /mod\(schedule\.dispatch_count, 12\)/);
  assert.match(finish, /current_lane = 11 and prior_cycle_had_work/);
  assert.match(finish, /when current_lane = 11 then false/);
  assert.match(migration, /'schemaVersion', 3/);
  assert.match(migration, /'providerOverviewReady'/);
  assert.match(activation, /"schemaVersion":3/);
  assert.match(activation, /"providerOverviewReady":true/);
  assert.match(activation, /claim_provider_overview_candidates\(uuid,uuid,integer\)/);
});
