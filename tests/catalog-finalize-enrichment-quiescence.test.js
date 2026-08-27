'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(
  ROOT,
  'supabase/migrations/20260826213000_catalog_finalize_enrichment_quiescence_v1.sql',
), 'utf8').replace(/\r\n?/g, '\n');
const sourceSync = fs.readFileSync(path.join(
  ROOT,
  'supabase/functions/norva-source-sync/index.ts',
), 'utf8').replace(/\r\n?/g, '\n');

function functionBody(name) {
  const marker = `create or replace function public.${name}`;
  const start = migration.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be defined`);
  const end = migration.indexOf('\n$function$;', start);
  assert.notEqual(end, -1, `${name} must have a complete body`);
  return migration.slice(start, end + '\n$function$;'.length);
}

test('finalizer claim serializes against dynamic enrichment and cannot resurrect stale leases', () => {
  const claim = functionBody('norva_claim_source_finalize_lease');
  const renew = functionBody('norva_renew_source_finalize_lease');
  const epochLock = claim.indexOf('from public.cloud_user_catalog_visibility_epochs epoch');
  const dispatchCheck = claim.indexOf('from public.catalog_enrichment_dispatch_leases lease');
  const leaseInsert = claim.indexOf('insert into public.cloud_source_finalize_leases as lease');

  assert.match(migration, /cloud_source_finalize_leases_user_until_idx/);
  assert.ok(epochLock >= 0 && epochLock < dispatchCheck && dispatchCheck < leaseInsert);
  assert.match(claim, /for update;/);
  assert.match(claim, /lease\.expires_at > statement_timestamp\(\)/);
  assert.match(renew, /lease\.lease_until > statement_timestamp\(\)/);
  assert.ok(
    renew.indexOf('for update;') < renew.indexOf('update public.cloud_source_finalize_leases lease'),
  );
});

test('legacy and dynamic enrichers recheck the finalizer lease under the user epoch mutex', () => {
  const legacy = functionBody('cloud_enrich_titles_from_catalog');
  const dynamic = functionBody('claim_catalog_enrichment_sources');

  assert.match(legacy, /for v_user_id in/);
  assert.ok(legacy.indexOf('for update;') < legacy.indexOf('with batch as ('));
  assert.ok(
    legacy.lastIndexOf('from public.cloud_source_finalize_leases lease')
      < legacy.indexOf('with batch as ('),
  );
  assert.match(legacy, /for update of title skip locked/);

  const dynamicMutex = dynamic.indexOf('from public.cloud_user_catalog_visibility_epochs epoch');
  const dynamicRecheck = dynamic.lastIndexOf('from public.cloud_source_finalize_leases finalize');
  const dispatchInsert = dynamic.indexOf('insert into public.catalog_enrichment_dispatch_leases as lease');
  assert.ok(dynamicMutex >= 0 && dynamicMutex < dynamicRecheck && dynamicRecheck < dispatchInsert);
  assert.match(dynamic, /for update;/);
});

test('owner snapshot selection skips the fenced account and stale inflight pages are invalidated', () => {
  const due = functionBody('norva_catalog_background_owner_due_rows');
  const claim = functionBody('norva_claim_catalog_title_background_mode');

  assert.equal(
    (due.match(/from public\.cloud_source_finalize_leases lease/g) || []).length,
    3,
  );
  assert.match(claim, /inflight_items = '\[\]'::jsonb/);
  assert.match(claim, /lease_owner = null/);
  assert.match(claim, /lease_until = null/);
  assert.ok(
    claim.indexOf('from public.cloud_source_finalize_leases lease')
      < claim.indexOf("if v_checkpoint.state = 'processing'"),
  );
});

test('background outcome writer is fenced atomically while retaining the proven v3 core', () => {
  const writer = functionBody('norva_apply_catalog_title_background_result');

  assert.match(migration, /rename to norva_apply_catalog_title_background_result_core_v3/);
  assert.match(migration, /revoke all on function public\.norva_apply_catalog_title_background_result_core_v3/);
  assert.match(writer, /for update;/);
  assert.ok(
    writer.indexOf('from public.cloud_user_catalog_visibility_epochs epoch')
      < writer.indexOf('from public.cloud_source_finalize_leases lease'),
  );
  assert.match(writer, /errcode = '40001', detail = 'reason=catalog_finalize_active'/);
  assert.match(writer, /v_result := public\.norva_apply_catalog_title_background_result_core_v3\(/);
  assert.match(writer, /return v_result;/);
  assert.match(writer, /v_movie_summary public\.cloud_catalog_facet_summary%rowtype/);
  assert.match(writer, /v_series_summary public\.cloud_catalog_facet_summary%rowtype/);
  assert.equal(
    (writer.match(/insert into public\.cloud_catalog_facet_summary/g) || []).length,
    2,
  );
  assert.match(writer, /genre_rail_visibility_epoch := v_result_epoch/);

  assert.match(sourceSync, /isStaleDatabaseConflict\(error\)/);
  assert.match(sourceSync, /if \(isCatalogBackgroundCasConflict\(error\)\) return null/);
});

test('facet summaries refresh ahead of expiry and include the fallback bucket', () => {
  const refresh = functionBody('cloud_refresh_facet_summary');
  const scheduler = functionBody('cloud_refresh_all_facet_summaries');
  const language = functionBody('cloud_exact_language_counts');

  assert.match(refresh, /coalesce\(title\.genre_buckets, array\['autres'\]\)/);
  assert.doesNotMatch(refresh, /bucket <> 'autres'/);
  assert.match(scheduler, /refreshed_at < now\(\) - interval '20 minutes'/);
  assert.match(language, /refreshed_at >= now\(\) - interval '60 minutes'/);
});

test('migration preserves least privilege for the public RPC and its private core', () => {
  assert.match(migration, /grant execute on function public\.norva_apply_catalog_title_background_result\([\s\S]*?\) to service_role/);
  assert.match(migration, /has_function_privilege\([\s\S]*?'authenticated'[\s\S]*?'public\.claim_catalog_enrichment_sources\(integer,integer\)'/);
  assert.match(migration, /commit;\s*$/);
});
