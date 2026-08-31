'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('genre-items ORs every selected curated category', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /bucketParam\.split\(","\)/);
  assert.match(src, /requestedBuckets\.some\(\(bucket\) => !BUCKET_ORDER\.includes\(bucket\)\)/);
  assert.match(src, /out\.overlaps\("genre_buckets", buckets\)/);
});

test('genre-items keeps title and returned versions scoped to the selected source', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /\.from\("cloud_catalog_visible_titles"\)/);
  assert.match(src, /out = out\.contains\("visible_source_ids", \[sourceId\]\)/);
  assert.match(src, /db\.rpc\("cloud_catalog_visible_title_language_page"/);
  assert.match(src, /p_source_id: options\.sourceId/);
  assert.match(src, /audio: options\.audioIso/);
  assert.match(src, /subtitle: options\.subtitleIso/);
  assert.match(src, /if \(sourceId && needsSourceLanguageEvidence\)/);
  assert.match(src, /visibleTitlePageBySourceLanguages\(\{/);
  assert.match(src, /listVariantsByTitleIds\([\s\S]*audioIso,[\s\S]*sourceId/);
  assert.doesNotMatch(src, /sourceLanguageTitleIds/);
  assert.doesNotMatch(src, /cloud_title_variants!inner/);
  assert.match(src, /if \(sourceId\) query = query\.eq\("source_id", sourceId\)/);

  const migration = read('supabase/migrations/20260721100000_genre_items_source_index.sql');
  assert.match(migration, /cloud_title_variants \(source_id, title_id\)/);
});

test('source-language pagination stays bounded and service-role only', () => {
  const migration = read('supabase/migrations/20260831175207_catalog_language_filter_page_v1.sql');
  assert.match(migration, /create or replace function public\.cloud_catalog_visible_title_language_page/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /cloud_catalog_visible_title_ids_by_source_languages/);
  assert.match(migration, /display_owners as materialized/);
  assert.match(migration, /limit \(select parameter\.page_limit/);
  assert.match(migration, /offset \(select parameter\.page_offset/);
  assert.match(migration, /'titleIds'/);
  assert.match(migration, /'count'/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

test('genre summary exposes Other and excludes hidden categories', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /if \(!counts\.has\("autres"\)\)/);
  assert.match(src, /if \(hidden\.size\)[\s\S]*\.not\("genre_buckets", "ov"/);
  assert.match(src, /!hidden\.has\(bucketId\)/);
  assert.doesNotMatch(src, /bucketId !== "autres" && n > 0/);
});

test('sync repairs blank category names from verified provider mirrors only', () => {
  const migration = read('supabase/migrations/20260721102000_hydrate_mirror_category_names.sql');
  assert.match(migration, /catalog_source_provider_identities/);
  assert.match(migration, /donor_link\.identity_id = identity\.identity_id/);
  assert.match(migration, /nullif\(btrim\(item\.subtitle\), ''\) is null/);
  assert.match(migration, /donor\.external_id = target\.external_id/);
  assert.doesNotMatch(migration, /fallback_raw/);
  assert.doesNotMatch(migration, /donor\.parent_external_id is not distinct from target\.parent_external_id/);
  assert.match(migration, /order by item\.id\s+limit p_limit/);
  assert.match(migration, /set_config\('statement_timeout', '20s', true\)/);
  assert.match(migration, /count\(distinct btrim\(donor\.subtitle\)\)/);
  assert.match(migration, /variant\.media_item_id = updated\.id/);
  assert.match(migration, /title\.default_variant_id = updated\.id/);
  assert.match(migration, /nullif\(btrim\(title\.genre_category\), ''\) is null/);
  assert.match(migration, /revoke all on function public\.norva_hydrate_source_category_names/);

  const sync = read('supabase/functions/_shared/xtream-sync.ts');
  assert.match(sync, /await recordProviderIdentity\(db, sourceId, userId, providerKey\);[\s\S]*await assertCatalogSnapshotCurrent\(db, sourceId, userId, accessSnapshot\);[\s\S]*runCategoryHydrationInBackground\(hydrateMirrorCategoryNames\(db, sourceId, userId, accessSnapshot\)\);/);
  assert.match(sync, /EdgeRuntime\?: \{ waitUntil\?:/);
  assert.doesNotMatch(sync, /await hydrateMirrorCategoryNames\(db, sourceId, userId, accessSnapshot\)/);
  assert.match(sync, /p_limit: 2000/);
});
