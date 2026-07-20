'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260720180000_series_episode_audio_foundation.sql',
  ),
  'utf8',
);
const backlogPriorityMigration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260720183000_prioritize_exact_series_audio_backlog.sql',
  ),
  'utf8',
);
const seriesInfoSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-series-info', 'index.ts'),
  'utf8',
);
const playbackSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-playback', 'index.ts'),
  'utf8',
);
const cloudSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-cloud', 'index.ts'),
  'utf8',
);

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};

test('episode foundation is transactional, disabled by default, and installs no cron', () => {
  assert.match(migration, /\nbegin;\s*\n/);
  assert.match(migration, /commit;\s*$/);
  assert.match(
    migration,
    /'episode_audio_scan_enabled',\s*false,/,
  );
  assert.match(migration, /on conflict \(key\) do update set\s+enabled = false,/);
  assert.doesNotMatch(migration, /\bcron\s*\.\s*schedule\s*\(/i);
  assert.doesNotMatch(migration, /\bnet\s*\.\s*http_post\s*\(/i);
});

test('membership registry is service-role-only and proves exact provider episode ownership', () => {
  const table = between(
    migration,
    'create table if not exists public.catalog_series_episode_memberships (',
    '\n-- Retry state for the metadata-only series inventory lane.',
  );
  const guard = between(
    migration,
    'create or replace function public.guard_catalog_series_episode_membership()',
    '\nrevoke all on function public.guard_catalog_series_episode_membership()',
  );
  const register = between(
    migration,
    'create or replace function public.register_catalog_series_episodes(',
    '\nrevoke all on function public.register_catalog_series_episodes(',
  );
  const parser = between(
    migration,
    'create or replace function public.catalog_series_info_episode_rows(',
    '\nrevoke all on function public.catalog_series_info_episode_rows(jsonb)',
  );

  assert.ok(table.includes('provider_identity_id uuid not null'));
  assert.ok(table.includes('parent_variant_id uuid not null'));
  assert.ok(table.includes('parent_series_id text not null'));
  assert.ok(table.includes('episode_id text not null'));
  assert.ok(table.includes('container_extension text not null'));
  assert.ok(table.includes('season_number integer'));
  assert.ok(table.includes('episode_number integer'));
  assert.ok(table.includes('primary key (source_id, parent_series_id, episode_id)'));
  assert.ok(table.includes('alter table public.catalog_series_episode_memberships enable row level security'));
  assert.ok(table.includes('from public, anon, authenticated'));
  assert.ok(table.includes('to service_role'));

  assert.ok(guard.includes("'catalog-series-episode-provider:' || new.provider_identity_id::text"));
  assert.ok(guard.includes('catalog_source_provider_identities'));
  assert.ok(guard.includes("variant.item_type = 'series'"));
  assert.ok(guard.includes('existing.parent_series_id is distinct from new.parent_series_id'));

  assert.ok(register.includes('for key share of variant, source'));
  assert.ok(register.includes('catalog_series_info_episode_rows(p_payload)'));
  assert.ok(register.includes('v_episode_count = 0'));
  assert.ok(register.includes('on conflict (source_id, parent_series_id, episode_id)'));
  assert.ok(register.includes('delete from public.catalog_series_episode_memberships existing'));
  assert.ok(register.includes('existing.source_id = p_source_id'));
  assert.ok(register.includes('existing.parent_series_id = btrim(p_parent_series_id)'));
  assert.ok(parser.includes("jsonb_typeof(array_group.value) = 'object' as flat_array"));
  assert.ok(parser.includes('then extracted.group_key::integer'));
});

test('legacy host cache remains display-only and exact playback uses canonical coordinates', () => {
  assert.match(
    seriesInfoSource,
    /if \(seriesInfoResult\.exactInventorySafe\) \{\s*await registerSeriesEpisodes/,
  );
  assert.match(
    seriesInfoSource,
    /return \{ payload: cached\.payload, exactInventorySafe: false \}/g,
  );
  assert.match(seriesInfoSource, /return \{ payload, exactInventorySafe: true \}/);
  assert.match(
    seriesInfoSource,
    /Array\.isArray\(episodes\) && episodes\.length > 0/,
  );
  assert.match(
    playbackSource,
    /const serverHost = episodeCoordinates\s*\? stringOr\(episodeCoordinates\.server_host, ""\)/,
  );
  assert.match(
    playbackSource,
    /const resolved = episodeCoordinates\s*\? await resolveExactEpisodePlaybackTarget/,
  );
  assert.match(playbackSource, /"catalog_series_episode_coordinates_by_episode"/);
  assert.match(cloudSource, /"catalog_series_episode_coordinates_by_episode"/);
  assert.match(
    cloudSource,
    /if \(exactEpisodeCoordinates\) \{[\s\S]*streamId: stringOr\(exactEpisodeCoordinates\.episode_id, ""\)/,
  );
});

test('episode coordinates and queues use only canonical episode file coordinates', () => {
  const coordinates = between(
    migration,
    'create or replace function public.catalog_series_episode_coordinates(',
    '\nrevoke all on function public.catalog_series_episode_coordinates(',
  );
  const byEpisode = between(
    migration,
    'create or replace function public.catalog_series_episode_coordinates_by_episode(',
    '\nrevoke all on function public.catalog_series_episode_coordinates_by_episode(',
  );
  const probe = between(
    migration,
    'create or replace function public.catalog_episode_probe_candidates(',
    '\nrevoke all on function public.catalog_episode_probe_candidates(',
  );
  const lid = between(
    migration,
    'create or replace function public.catalog_episode_lid_candidates(',
    '\nrevoke all on function public.catalog_episode_lid_candidates(',
  );

  for (const body of [coordinates, byEpisode, probe, lid]) {
    assert.ok(body.includes('catalog_series_episode_memberships'));
    assert.ok(body.includes('catalog_source_provider_identities'));
    assert.ok(body.includes('membership.provider_identity_id'));
    assert.ok(!body.includes('config_hint'));
  }
  assert.ok(coordinates.includes('membership.provider_identity_id::text as server_host'));
  assert.ok(coordinates.includes('membership.parent_series_id = btrim(p_parent_series_id)'));
  assert.ok(coordinates.includes('membership.episode_id = btrim(p_episode_id)'));
  assert.ok(byEpisode.includes('membership.episode_id = btrim(p_episode_id)'));
  assert.ok(byEpisode.includes('conflicting.parent_series_id is distinct from membership.parent_series_id'));
  assert.ok(probe.includes("cache.item_type = 'episode'"));
  assert.ok(probe.includes('cache.external_id = membership.episode_id'));
  assert.ok(lid.includes("cache.item_type = 'episode'"));
  assert.ok(lid.includes('audio_whisper_retry_at'));
  assert.match(lid, /in\s*\(\s*'und',\s*'un',\s*'mis'/);
});

test('episode fanout re-reads canonical cache and never writes parent ordered maps', () => {
  const merge = between(
    migration,
    'create or replace function public.merge_catalog_episode_file_observation(',
    '\nrevoke all on function public.merge_catalog_episode_file_observation(',
  );
  const fanout = between(
    migration,
    'create or replace function public.fanout_episode_file_tracks_to_users(',
    '\nrevoke all on function public.fanout_episode_file_tracks_to_users(',
  );
  const hydrate = between(
    migration,
    'create or replace function public.hydrate_catalog_episode_file_tracks(',
    '\nrevoke all on function public.hydrate_catalog_episode_file_tracks(',
  );

  for (const body of [merge, fanout, hydrate]) {
    assert.ok(body.includes('catalog_series_episode_memberships'));
    assert.ok(body.includes("item_type = 'episode'"));
    assert.ok(!body.includes('config_hint'));
    assert.ok(!body.includes('update public.cloud_title_variants'));
    assert.ok(!body.includes('update public.cloud_titles'));
  }
  assert.ok(merge.includes('where cache.server_host = v_membership.provider_identity_id::text'));
  assert.ok(merge.includes('when observation.audio_verified_at is not null'));
  assert.ok(merge.includes('then observation.audio_languages'));
  assert.ok(merge.includes('observation.audio_verified_at is null'));
  assert.ok(fanout.includes('merge_catalog_episode_file_observation'));
  assert.ok(fanout.includes('recompute_cloud_title_file_languages'));
  assert.ok(!fanout.includes('merge_cloud_title_file_languages'));
});

test('series inventory queue is exact, retry-bounded, and service-role-only', () => {
  const table = between(
    migration,
    'create table if not exists public.catalog_series_inventory_state (',
    '\n-- Normalize the Xtream shapes observed in production:',
  );
  const candidates = between(
    migration,
    'create or replace function public.catalog_series_inventory_candidates(',
    '\nrevoke all on function public.catalog_series_inventory_candidates(',
  );
  const outcome = between(
    migration,
    'create or replace function public.record_catalog_series_inventory_outcome(',
    '\nrevoke all on function public.record_catalog_series_inventory_outcome(',
  );

  assert.ok(table.includes('consecutive_failures integer not null default 0'));
  assert.ok(table.includes('next_retry_at timestamptz not null default now()'));
  assert.ok(table.includes('primary key (source_id, parent_series_id)'));
  assert.ok(table.includes('enable row level security'));
  assert.ok(table.includes('from public, anon, authenticated'));
  assert.ok(table.includes('to service_role'));

  assert.ok(candidates.includes("source.source_type = 'xtream'"));
  assert.ok(candidates.includes("variant.item_type = 'series'"));
  assert.ok(candidates.includes('catalog_source_provider_identities'));
  assert.ok(candidates.includes('inventory.next_retry_at <= now()'));
  assert.ok(candidates.includes('case when inventory.source_id is null then 0 else 1 end'));
  assert.ok(candidates.includes('title.release_year desc nulls last'));
  assert.ok(!candidates.includes('config_hint'));
  assert.ok(!candidates.includes('cloud_series_info_cache'));

  assert.ok(outcome.includes('p_success and (p_episode_count is null or p_episode_count <= 0)'));
  assert.ok(outcome.includes('for key share of variant, source'));
  assert.ok(outcome.includes('catalog_source_provider_identities'));
  assert.ok(outcome.includes('v_registered_episode_count <> p_episode_count'));
  assert.ok(outcome.includes("v_now + interval '1 minute'"));
  assert.ok(outcome.includes("v_now + interval '30 days'"));
  assert.ok(outcome.includes("v_now + interval '24 hours'"));
  assert.ok(outcome.includes('least(12, inventory.consecutive_failures + 1)'));
  assert.ok(!outcome.includes('config_hint'));
});

test('legacy series rows only prioritize exact inventory and never populate episodes', () => {
  assert.match(backlogPriorityMigration, /\nbegin;\s*\n/);
  assert.match(backlogPriorityMigration, /commit;\s*$/);
  assert.match(
    backlogPriorityMigration,
    /legacy_parent\.server_host = identity\.identity_id::text/,
  );
  assert.match(backlogPriorityMigration, /legacy_parent\.item_type = 'series'/);
  assert.match(backlogPriorityMigration, /jsonb_array_elements\(/);
  assert.match(
    backlogPriorityMigration,
    /in \('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown'\)/,
  );
  assert.match(
    backlogPriorityMigration,
    /case when exists \([\s\S]*?\) then 0 else 1 end,\s*case when inventory\.source_id is null/,
  );
  assert.doesNotMatch(
    backlogPriorityMigration,
    /\b(insert|update)\s+(into\s+)?public\.catalog_series_episode_memberships/i,
  );
  assert.doesNotMatch(backlogPriorityMigration, /register_catalog_series_episodes/i);
  assert.doesNotMatch(backlogPriorityMigration, /cloud_series_info_cache/i);
  assert.match(
    backlogPriorityMigration,
    /revoke all on function public\.catalog_series_inventory_candidates\([\s\S]*?grant execute[\s\S]*?to service_role;/,
  );
});

test('cascade ledger dispatch accepts episodes without changing the movie transaction', () => {
  const episode = between(
    migration,
    'create or replace function public.persist_catalog_episode_audio_lid_outcome(',
    '\nrevoke all on function public.persist_catalog_episode_audio_lid_outcome(',
  );
  const dispatch = between(
    migration,
    'create or replace function public.persist_catalog_audio_lid_outcome(',
    '\nrevoke all on function public.persist_catalog_audio_lid_outcome(',
  );

  assert.ok(migration.includes('drop constraint if exists catalog_audio_lid_attempts_item_type_check'));
  assert.ok(migration.includes("check (item_type in ('movie', 'episode'))"));
  assert.ok(migration.includes('rename to persist_catalog_movie_audio_lid_outcome'));
  assert.match(
    migration,
    /persist_catalog_movie_audio_lid_outcome\([\s\S]*?\) from public, anon, authenticated, service_role;/,
  );
  assert.ok(dispatch.includes("if p_item_type = 'movie'"));
  assert.ok(dispatch.includes('persist_catalog_movie_audio_lid_outcome'));
  assert.ok(dispatch.includes("elsif p_item_type = 'episode'"));
  assert.ok(dispatch.includes('persist_catalog_episode_audio_lid_outcome'));

  assert.ok(episode.includes("p_item_type is distinct from 'episode'"));
  assert.ok(episode.includes("'catalog-series-episode-provider:' || btrim(p_server_host)"));
  assert.ok(episode.includes('count(distinct membership.parent_series_id)'));
  assert.ok(episode.includes('catalog_source_provider_identities'));
  assert.ok(episode.includes("cache.item_type = 'episode'"));
  assert.ok(episode.includes('v_cache.audio_probed_at is distinct from p_expected_audio_probed_at'));
  assert.ok(episode.includes("v_failure := 'strict-proof-wins'"));
  assert.ok(episode.includes('cache.audio_probed_at = p_expected_audio_probed_at'));
  assert.ok(episode.includes('fanout_episode_file_tracks_to_users'));
  assert.ok(!episode.includes('fanout_detected_file_tracks_to_users'));
  assert.ok(!episode.includes('update public.cloud_title_variants'));
  assert.ok(!episode.includes('update public.cloud_titles'));
});

test('legacy movie verification fanout is preserved while episode cursors require registry proof', () => {
  const coordinateGuard = between(
    migration,
    'create or replace function public.catalog_episode_file_coordinate_is_registered(',
    '\nrevoke all on function public.catalog_episode_file_coordinate_is_registered(',
  );
  const rawUpsert = between(
    migration,
    'create or replace function public.upsert_catalog_file_tracks(',
    '\nrevoke all on function public.upsert_catalog_file_tracks(',
  );
  const validatedUpsert = between(
    migration,
    'create or replace function public.upsert_catalog_file_validated_tracks(',
    '\nrevoke all on function public.upsert_catalog_file_validated_tracks(',
  );
  const detectedUpsert = between(
    migration,
    'create or replace function public.upsert_catalog_file_detected_tracks(',
    '\nrevoke all on function public.upsert_catalog_file_detected_tracks(',
  );
  const verification = between(
    migration,
    'create or replace function public.record_catalog_file_audio_verification(',
    '\nrevoke all on function public.record_catalog_file_audio_verification(',
  );
  const whisper = between(
    migration,
    'create or replace function public.record_catalog_file_audio_whisper_outcome(',
    '\nrevoke all on function public.record_catalog_file_audio_whisper_outcome(',
  );

  assert.ok(coordinateGuard.includes('catalog_series_episode_memberships'));
  assert.ok(coordinateGuard.includes('catalog_source_provider_identities'));
  assert.ok(coordinateGuard.includes("'catalog-series-episode-provider:' || p_server_host"));
  assert.ok(coordinateGuard.includes('count(distinct membership.parent_series_id)'));
  assert.ok(coordinateGuard.includes('v_parent_count > 1'));
  for (const upsert of [rawUpsert, validatedUpsert, detectedUpsert]) {
    assert.ok(upsert.includes("if p_item_type = 'episode'"));
    assert.ok(upsert.includes('catalog_episode_file_coordinate_is_registered'));
  }

  assert.ok(verification.includes("if p_item_type = 'movie' then"));
  assert.ok(verification.includes('merge_cloud_title_file_languages'));
  assert.ok(verification.includes('mark_cloud_title_file_audio_verification'));
  assert.ok(verification.includes('fanout_episode_file_tracks_to_users'));
  assert.ok(verification.includes('catalog_series_episode_memberships'));
  assert.ok(verification.includes('catalog_source_provider_identities'));
  assert.ok(!verification.includes('update public.cloud_titles'));
  assert.ok(!verification.includes('update public.cloud_title_variants'));
  assert.match(
    verification,
    /audio_lang_verified_at = case[\s\S]*?cache\.audio_probed_at is not null[\s\S]*?cardinality\(\s*public\.cloud_file_track_languages\(cache\.audio_tracks\)\s*\) > 0/,
  );
  assert.match(
    verification,
    /audio_lang_retry_at = case[\s\S]*?cache\.audio_probed_at is not null[\s\S]*?cardinality\(\s*public\.cloud_file_track_languages\(cache\.audio_tracks\)\s*\) > 0/,
  );

  assert.ok(whisper.includes('catalog_series_episode_memberships'));
  assert.ok(whisper.includes('catalog_source_provider_identities'));
  assert.ok(whisper.includes('audio_whisper_retry_at = p_retry_at'));
});

test('fleet accepts movie-or-series sources and closes only lane eleven', () => {
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

  assert.ok(claim.includes("variant.item_type in ('movie', 'series')"));
  assert.ok(claim.includes("eligible_variant.item_type in ('movie', 'series')"));
  assert.ok(!claim.includes("item_type = 'movie'"));
  assert.ok(claim.includes('for update of schedule skip locked'));
  assert.ok(claim.includes("'identity:' || verified_identity.identity_id::text"));

  assert.ok(finish.includes('mod(schedule.dispatch_count, 12)'));
  assert.ok(finish.includes('current_lane = 11 and prior_cycle_had_work'));
  assert.ok(finish.includes('when current_lane = 11 then false'));
  assert.ok(!finish.includes('mod(schedule.dispatch_count, 6)'));
  assert.ok(!finish.includes('current_lane = 5'));
});

test('backfill requires several independent identity proofs and skips unsafe payloads', () => {
  const backfill = between(
    migration,
    'do $episode_backfill$',
    '\ncommit;',
  );

  assert.ok(backfill.includes('catalog_source_provider_identities'));
  assert.ok(backfill.includes('catalog_provider_identities fingerprint'));
  assert.ok(backfill.includes('fingerprint.identity_id = verified_identity.identity_id'));
  assert.ok(backfill.includes('catalog_media_items canonical_parent'));
  assert.ok(backfill.includes("canonical_parent.item_type = 'series'"));
  assert.ok(backfill.includes('cloud_series_info_cache series_cache'));
  assert.ok(backfill.includes('series_cache.series_id = variant.external_id'));
  assert.ok(backfill.includes('register_catalog_series_episodes'));
  assert.ok(backfill.includes('when data_exception or integrity_constraint_violation'));
});
