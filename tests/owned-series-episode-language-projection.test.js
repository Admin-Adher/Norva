const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260914001822_owned_series_episode_language_projection.sql'), 'utf8');
const xtream = sql.split('-- The enrolment verifier')[0];
const selection = sql.split('-- The enrolment verifier')[1].split('create or replace function public.cloud_catalog_effective_audio_languages')[0];
const effective = sql.split('create or replace function public.cloud_catalog_effective_audio_languages')[1];

test('Xtream episode evidence is exact, owned, active and canonically provider-scoped', () => {
  for (const proof of [
    'variant.user_id=observation.user_id and variant.title_id=observation.title_id',
    "variant.id=observation.variant_id and variant.item_type='series'",
    'head.active_generation_id=variant.generation_id', 'title.user_id=variant.user_id',
    'visible_source.id=variant.source_id and visible_source.user_id=variant.user_id',
    'parent_item.id=variant.media_item_id', 'parent_item.source_id=variant.source_id',
    'parent_item.generation_id=variant.generation_id', 'parent_item.available',
    'membership.user_id=variant.user_id and membership.source_id=variant.source_id',
    'membership.generation_id=variant.generation_id',
    'membership.parent_title_id=variant.title_id and membership.parent_variant_id=variant.id',
    "membership.parent_series_id=variant.external_id and membership.parent_item_type='series'",
    'membership.episode_id=observation.file_external_id',
    'identity.identity_id=membership.provider_identity_id and identity.verified_at is not null',
    'cache.server_host=membership.provider_identity_id::text',
    "cache.item_type='episode' and cache.external_id=membership.episode_id"
  ]) assert.ok(xtream.includes(proof), `missing proof: ${proof}`);
  assert.doesNotMatch(xtream, /config_hint|tmdb_id|providerKey|serverHost/);
});

test('Episode IDs shared with another active verified parent fail closed across owners', () => {
  for (const proof of [
    'other_parent.id=conflicting.parent_variant_id', 'other_parent.user_id=conflicting.user_id',
    'other_parent.source_id=conflicting.source_id', 'other_parent.generation_id=conflicting.generation_id',
    'other_parent.title_id=conflicting.parent_title_id', 'other_parent.external_id=conflicting.parent_series_id',
    'other_source.id=other_parent.source_id and other_source.user_id=other_parent.user_id',
    'other_head.active_generation_id=other_parent.generation_id',
    'other_identity.identity_id=conflicting.provider_identity_id', 'other_identity.verified_at is not null',
    'conflicting.provider_identity_id=file.provider_identity_id',
    'conflicting.episode_id=file.episode_id',
    'conflicting.parent_series_id is distinct from file.parent_series_id'
  ]) assert.ok(xtream.includes(proof), `missing ambiguity guard: ${proof}`);
});

test('Observed episode languages require complete concordant cache and current supplied profile', () => {
  for (const proof of [
    'cache.audio_probed_at is not null', 'isfinite(cache.audio_probed_at)',
    'selection_audio_tracks_complete(raw.track_map_text::jsonb)', 'file.observation_codes=file.cache_codes',
    'vod_language_profile_audio_indices(file.observed_profile_snapshot)',
    "file.audio_lang_verification->>'profileFingerprint'=file.observed_profile_fingerprint",
    'file.audio_lang_verified_at>=file.observed_profile_probed_at',
    "file.audio_verification->>'profileFingerprint'=file.observed_profile_fingerprint",
    "else '{}'::text[] end as languages"
  ]) assert.ok(xtream.includes(proof), `missing audio guard: ${proof}`);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from)\s+public\./i);
  assert.ok(xtream.includes('select distinct file.audio_tracks::text collate "C" as track_map_text'));
  assert.ok(xtream.includes('file.observation_complete'));
});

test('Selection re-enrolment reuses the identity verifier and preserves file-level proof', () => {
  assert.ok(selection.includes('norva_selection_source_identity_valid(source.id,p_user_id)'));
  assert.doesNotMatch(selection, /norva-selection-curated-v1:|substr\(digest/);
  for (const proof of [
    'source.user_id=p_user_id', 'head.active_generation_id=variant.generation_id',
    "variant.metadata->>'selectionRevision'='selection-vod-20260906-v1'",
    'episode.source_id=parent.source_id and episode.generation_id=parent.generation_id',
    'episode.user_id=parent.user_id and episode.available', 'episode.parent_external_id=parent.external_id',
    "episode.metadata->>'selectionParentId'=parent.external_id",
    "episode.metadata->>'discoveryFeed'=parent.metadata->>'discoveryFeed'",
    'containerMetadataCheckedAt', "sha256(convert_to(episode.playback_hint->>'targetUrl','UTF8'))",
    'selection_audio_tracks_complete(file.audio_tracks)', 'selection_audio_tracks_complete(file.cache_audio_tracks)',
    'file.cache_url_hash=file.current_url_hash', 'file.cache_codes=file.observation_codes',
    'catalog_audio_track_indexes(file.cache_audio_tracks)=public.catalog_audio_track_indexes(file.audio_tracks)'
  ]) assert.ok(selection.includes(proof), `missing Selection guard: ${proof}`);
});

test('Only complete unfiltered observed evidence overrides declarations; unknowns do not disprove hints', () => {
  const evidence = effective.split('series_observed as materialized')[1].split('select effective.*')[0];
  assert.ok(evidence.includes('cloud_catalog_selection_series_episode_audio_evidence'));
  assert.ok(evidence.includes('cloud_catalog_xtream_series_episode_audio_evidence'));
  assert.doesNotMatch(evidence, /p_language|language is not null/);
  assert.ok(effective.includes('observed.language is not null and (p_language is null or observed.language=p_language)'));
  assert.ok(effective.includes('left join series_observed_variants observed'));
  assert.ok(effective.includes('direct.variant_id is null and observed.variant_id is null'));
  assert.ok(effective.includes('direct_observed as materialized'), 'exact-file collision and precedence are evaluated once');
  const direct = effective.split('direct_observed as materialized')[1].split('direct_observed_variants as materialized')[0];
  assert.doesNotMatch(direct, /p_language/, 'direct evidence veto must also remain unfiltered');
  assert.ok(effective.includes('variant.external_id=observation.file_external_id'), 'existing movie branch stays exact-file');
  assert.ok(effective.includes('observed.title_id=variant.title_id and observed.variant_id=variant.id'),
    'coincident parent/episode IDs cannot bypass authoritative episode evidence');
  assert.ok(effective.includes('membership.episode_id=observation.file_external_id'),
    'incomplete colliding episode cannot masquerade as a parent file');
  assert.doesNotMatch(sql, /array\[null::text\]/i);
});

test('All four projection helpers are read-only invokers, service-only, and schema-qualified', () => {
  assert.equal((sql.match(/language sql stable security invoker set search_path=''/g) || []).length, 4);
  for (const signature of [
    'cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid)',
    'cloud_catalog_selection_series_episode_audio_evidence(uuid,uuid)',
    'cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)',
    'cloud_catalog_effective_audio_languages(uuid,text,uuid,text)'
  ]) {
    assert.ok(sql.includes(`revoke all on function public.${signature} from public,anon,authenticated;`));
    assert.ok(sql.includes(`grant execute on function public.${signature} to service_role;`));
  }
  assert.doesNotMatch(sql, /security definer/i);
});
