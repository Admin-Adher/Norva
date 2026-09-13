const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260913210116_selection_series_owned_episode_language_filters.sql'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, '../supabase/tests/selection_series_owned_episode_language_filters.sql'), 'utf8');
const helper = sql.split('create or replace function public.cloud_catalog_effective_audio_languages')[0];
const effective = sql.slice(helper.length);

test('Selection series read helper proves canonical ownership, active episode membership and audited current file', () => {
  for (const proof of [
    'norva-selection-curated-v1:', 'variant.source_id=p.source_id and variant.user_id=p_user_id',
    'head.active_generation_id=variant.generation_id', "title.item_type='series'",
    "variant.metadata->>'seriesDelivery'='selection'", "'selection-vod-20260906-v1'",
    'observation.user_id=parent.user_id and observation.title_id=parent.title_id',
    'observation.variant_id=parent.id and observation.audio_observed',
    'episode.source_id=parent.source_id and episode.generation_id=parent.generation_id',
    "episode.item_type='episode' and episode.external_id=observation.file_external_id",
    'episode.user_id=parent.user_id and episode.available', 'episode.parent_external_id=parent.external_id',
    'parent_item.id=parent.media_item_id', 'parent_item.generation_id=parent.generation_id',
    "episode.metadata->>'selectionRevision'=parent.metadata->>'selectionRevision'",
    "episode.metadata->>'discoveryFeed'=parent.metadata->>'discoveryFeed'",
    "episode.metadata->>'selectionParentId'=parent.external_id", 'containerMetadataCheckedAt',
    "sha256(convert_to(episode.playback_hint->>'targetUrl','UTF8'))",
    'catalog_audio_track_indexes(file.audio_tracks)', 'file.observation_codes=file.file_codes'
  ]) assert.ok(helper.includes(proof), `missing proof: ${proof}`);
  assert.doesNotMatch(helper, /(?:insert into|update|delete from)\s+public\./i);
});

test('Current episode cache disagreement and explicit mismatched URL digest fail closed', () => {
  for (const proof of [
    "cache.server_host='source:' || parent.source_id::text", "cache.item_type='episode'",
    'cache.external_id=observation.file_external_id', "cache.audio_lang_verification->>'urlSha256'",
    'file.cache_url_hash is null or file.cache_url_hash=file.current_url_hash',
    'file.cache_codes=file.observation_codes', 'catalog_audio_track_indexes(file.cache_audio_tracks)',
    'cache.audio_probed_at is not null or cache.audio_lang_verified_at is not null'
  ]) assert.ok(helper.includes(proof), `missing cache proof: ${proof}`);
});

test('Effective languages retain existing exact-file branch and use unfiltered Selection evidence to veto hints', () => {
  assert.ok(effective.includes('variant.external_id=observation.file_external_id'));
  assert.ok(effective.includes('selection_observed as materialized'));
  const selectionCte = effective.split('selection_observed as materialized')[1].split('select effective.*')[0];
  assert.ok(selectionCte.includes("where p_item_type='series'"));
  assert.ok(!selectionCte.includes('p_language='), 'language-filtered evidence would let conflicting hints revive');
  assert.ok(effective.includes('where p_language is null or observed.language=p_language'));
  assert.ok(effective.includes('not exists(select 1 from selection_observed observed'));
  assert.ok(effective.includes('observed.title_id=hint.title_id and observed.variant_id=hint.variant_id'));
});

test('Both helper APIs remain stable security-invoker and inaccessible directly to clients', () => {
  assert.equal((sql.match(/language sql stable security invoker/gi) || []).length, 2);
  for (const signature of [
    'cloud_catalog_selection_series_observed_audio_languages(uuid,uuid)',
    'cloud_catalog_effective_audio_languages(uuid,text,uuid,text)'
  ]) {
    assert.ok(sql.includes(`revoke all on function public.${signature} from public,anon,authenticated;`));
    assert.ok(sql.includes(`grant execute on function public.${signature} to service_role;`));
  }
  assert.doesNotMatch(sql, /security definer/i);
});

test('Runtime proof is confined to disposable DB, rolls back and exercises negative trust boundaries', () => {
  assert.ok(fixture.includes("current_database()<>'norva_language_remediation_test_20260913'"));
  assert.match(fixture.trim(), /rollback;$/);
  for (const label of [
    'wrong owner rejected', 'noncanonical source rejected', 'stale generation episode rejected',
    'stale generation parent rejected', 'wrong relational parent rejected', 'metadata alone is insufficient',
    'und observation is insufficient', 'same-language cache with wrong URL digest rejected',
    'current observed cache language disagreement rejected', 'unknown facet excludes qualified parent',
    'movie exact file only; unrelated file excluded', 'generic Xtream episode union unchanged',
    'ES observation vetoes conflicting FR hint even under FR filter'
  ]) assert.ok(fixture.includes(label), `missing runtime case: ${label}`);
});
