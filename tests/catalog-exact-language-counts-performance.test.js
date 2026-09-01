'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(
  ROOT,
  'supabase/migrations/20260901123500_catalog_exact_language_facets_index_first_v1.sql',
), 'utf8').replace(/\r\n?/g, '\n');

test('all-source exact language fallback bypasses the expensive compatibility view', () => {
  assert.match(migration, /create or replace function public\.cloud_exact_language_counts\(/);
  assert.match(migration, /cloud_catalog_visible_title_variants variant/);
  assert.match(migration, /cloud_title_file_language_observations observation/);
  assert.match(migration, /visible_variants as materialized/);
  assert.match(migration, /user_observations as materialized/);
  assert.match(migration, /variant\.user_id = p_user_id/);
  assert.match(migration, /observation\.user_id = p_user_id/);
  assert.match(migration, /observation\.user_id = variant\.user_id/);
  assert.match(migration, /observation\.title_id = variant\.title_id/);
  assert.match(migration, /observation\.variant_id = variant\.id/);
  assert.doesNotMatch(migration, /from public\.cloud_catalog_visible_titles title/);
});

test('fallback keeps audio and subtitles independently exact across visible title ids', () => {
  assert.match(migration, /where observation\.audio_observed/);
  assert.match(migration, /where observation\.subtitle_observed/);
  assert.match(migration, /'audio'::text as facet/);
  assert.match(migration, /'subtitles'::text as facet/);
  assert.match(migration, /count\(distinct title_id\)::bigint as title_count/);
  assert.match(migration, /facet = 'audio'/);
  assert.match(migration, /facet = 'subtitles'/);
});

test('fresh summaries remain the O(1) fast path and the RPC stays service-only', () => {
  const summaryRead = migration.indexOf('from public.cloud_catalog_facet_summary summary');
  const fallbackRead = migration.indexOf('with visible_variants as materialized');

  assert.ok(summaryRead >= 0 && summaryRead < fallbackRead);
  assert.match(migration, /refreshed_at >= now\(\) - interval '60 minutes'/);
  assert.match(migration, /if not found then/);
  assert.match(migration, /p_user_id is null or p_item_type not in \('movie', 'series'\)/);
  assert.match(migration, /revoke all on function public\.cloud_exact_language_counts\(uuid, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.cloud_exact_language_counts\(uuid, text\)[\s\S]*to service_role/);
});
