'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase/migrations/20260825110000_catalog_facet_summary_snapshot_refresh.sql',
  ),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('facet refresh aggregates the durable active snapshot without per-title visibility calls', () => {
  const refresh = between(
    migration,
    'create or replace function public.cloud_refresh_facet_summary(',
    '\ncreate or replace function public.cloud_refresh_all_facet_summaries(',
  );

  assert.match(refresh, /cloud_catalog_background_owner_pointers pointer/);
  assert.match(refresh, /cloud_catalog_background_owner_snapshot_rows owner_row/);
  assert.match(refresh, /cloud_catalog_background_owner_snapshot_sources owner_source/);
  assert.match(refresh, /variant\.generation_id = owner_source\.generation_id/);
  assert.match(refresh, /owner_row\.is_present/);
  assert.match(refresh, /observation\.audio_observed/);
  assert.match(refresh, /observation\.subtitle_observed/);
  assert.match(refresh, /count\(distinct variant\.title_id\)::bigint/);
  assert.doesNotMatch(refresh, /cloud_catalog_visible_titles/);
  assert.doesNotMatch(refresh, /norva_visible_catalog_title_runtime/);
});

test('global refresh selector is snapshot-bounded and preserves the cron identity', () => {
  const refreshAll = between(
    migration,
    'create or replace function public.cloud_refresh_all_facet_summaries(',
    '\nrevoke all on function public.cloud_refresh_facet_summary',
  );

  assert.match(refreshAll, /cloud_catalog_background_owner_pointers pointer/);
  assert.match(refreshAll, /cloud_catalog_background_owner_snapshot_rows owner_row/);
  assert.match(refreshAll, /owner_row\.is_present/);
  assert.doesNotMatch(refreshAll, /cloud_catalog_visible_titles/);
  assert.match(migration, /'norva-facet-summary-refresh'/);
  assert.match(migration, /7-59\/15 \* \* \* \*/);
  assert.match(migration, /statement_timeout='300s'/);
});

test('facet refresh RPCs remain service-role only and self-check their installed definitions', () => {
  assert.match(migration, /revoke all on function public\.cloud_refresh_facet_summary\(uuid, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.cloud_refresh_facet_summary\(uuid, text\)[\s\S]*to service_role/);
  assert.match(migration, /pg_get_functiondef/);
  assert.match(migration, /catalog facet summary refresh is not snapshot-set based/);
  assert.match(migration, /catalog facet summary selector is not snapshot-set based/);
});
