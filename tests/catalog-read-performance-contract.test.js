'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const catalog = read('supabase/functions/norva-catalog/index.ts');
const migration = read('supabase/migrations/20260826090000_catalog_genre_rail_read_model_v1.sql');
const migrationV2 = read('supabase/migrations/20260826090010_catalog_genre_rail_read_model_v2.sql');
const migrationV3 = read('supabase/migrations/20260826091244_catalog_genre_rail_refresh_isolation_v3.sql');
const migrationV4 = read('supabase/migrations/20260826104421_catalog_facet_refresh_index_first_v4.sql');
const migrationV5 = read('supabase/migrations/20260826110251_catalog_facet_refresh_cron_activation_v5.sql');
const home = read('public/js/pages/HomePage.js');
const app = read('public/js/app.js');
const api = read('public/js/api.js');
const cloudApi = read('public/js/cloudApi.js');
const live = read('public/js/components/LiveGuideFusion.js');
const appHtml = read('public/app.html');

test('genre rails use one generation-fenced read model and never restore the per-bucket fan-out', () => {
  const start = catalog.indexOf('async function listGenreRails');
  const end = catalog.indexOf('// Full, paged list', start);
  const block = catalog.slice(start, end);

  assert.match(block, /db\.rpc\(\s*"norva_get_genre_rail_candidates"/);
  assert.match(block, /p_expected_visibility_epoch:\s*visibilityEpoch/);
  assert.match(block, /catalogTitleVisibilityEpoch\(candidatePayload\.visibilityEpoch, visibilityEpoch\)/);
  assert.doesNotMatch(block, /Promise\.all\(candidateBuckets\.map/);
  assert.doesNotMatch(block, /from\("cloud_catalog_visible_titles"\)/);
});
test('the SQL read model is bounded, service-only and visibility-epoch fenced', () => {
  assert.match(migration, /bucket_rank <= 150/);
  assert.match(migration, /with visible as materialized/);
  assert.match(migration, /genre_rail_visibility_epoch/);
  assert.match(migration, /v_end_epoch <> v_start_epoch/);
  assert.match(migration, /reason=genre_rail_read_model_stale_or_missing/);
  assert.match(migration, /revoke all on function public\.norva_get_genre_rail_candidates[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.norva_get_genre_rail_candidates[\s\S]*to service_role/);
});

test('the production correction avoids the unbounded visible-title runtime spool', () => {
  assert.match(migrationV2, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.match(migrationV2, /left join public\.cloud_source_catalog_generation_candidate_titles projection/);
  assert.match(migrationV2, /select distinct on \(variant\.title_id\)/);
  assert.match(migrationV2, /bucket_rank <= 150/);
  assert.match(migrationV2, /v_end_epoch <> v_start_epoch/);
  assert.doesNotMatch(migrationV2, /with visible as materialized \([\s\S]*from public\.cloud_catalog_visible_titles/);
});

test('rail refresh is isolated from slow language facets and independently scheduled', () => {
  assert.match(migrationV3, /create or replace function public\.cloud_refresh_genre_rail_candidates/);
  assert.match(migrationV3, /create or replace function public\.cloud_refresh_all_genre_rail_candidates/);
  assert.match(migrationV3, /norva-genre-rail-candidate-refresh/);
  assert.match(migrationV3, /statement_timeout='120s'/);
  assert.match(migrationV3, /genre_rail_refreshed_at/);
  assert.match(migrationV3, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.match(migrationV3, /revoke all on function public\.cloud_refresh_genre_rail_candidates[\s\S]*from public, anon, authenticated/);
});

test('full facet refresh uses one generation-filtered variant spool and no hydrated title runtime view', () => {
  assert.match(migrationV4, /with visible_variants as materialized/);
  assert.match(migrationV4, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.match(migrationV4, /cloud_title_file_language_observations observation/);
  assert.match(migrationV4, /v_end_epoch <> v_start_epoch/);
  assert.match(migrationV4, /cloud_refresh_all_facet_summaries\(50\)/);
  assert.match(migrationV4, /revoke all on function public\.cloud_refresh_facet_summary[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(migrationV4, /from public\.cloud_catalog_visible_titles/);
});

test('a previously paused named facet cron is reactivated explicitly and verified exactly', () => {
  assert.match(migrationV5, /perform cron\.alter_job\(v_job_id, active => true\)/);
  assert.match(migrationV5, /job\.schedule = '7-59\/15 \* \* \* \*'/);
  assert.match(migrationV5, /cloud_refresh_all_facet_summaries\(50\)/);
  assert.match(migrationV5, /reason=cron_activation_mismatch/);
});

test('Home timeouts abort the underlying rails fetch and route cancellation drains controllers', () => {
  assert.match(home, /this\._homeAbortControllers = new Set\(\)/);
  assert.match(home, /controller\?\.abort\(\)/);
  assert.match(home, /for \(const controller of this\._homeAbortControllers\) controller\.abort\(\)/);
  assert.match(home, /\(signal\) => window\.API\.request\([\s\S]*\{ signal \}/);
  assert.match(api, /CloudAdapter\.request\(method, endpoint, data, options\)/);
  assert.match(cloudApi, /rails: \(params = \{\}, options = \{\}\) => catalogRequest\('\/home\/rails', params, options\)/);
});

test('an uncached Home progressively paints the generation-fenced genre read model', () => {
  assert.match(home, /\/media\/genre-rails\?type=movie&limit=12/);
  assert.match(home, /\/media\/genre-rails\?type=series&limit=12/);
  assert.match(home, /Promise\.race\(\[/);
  assert.match(home, /norva\.home\.fast-rails\.v1/);
  assert.match(home, /this\.renderCloudRails\(earlyRails\)/);
  assert.match(home, /this\.setHomeLoadingState\(false\)/);
  assert.match(app, /const shouldPrimeHome = \(!warmHashKey \|\| warmHashKey === 'home'\)/);
  assert.match(app, /Promise\.resolve\(this\.pages\.home\?\.show\?\.\(\)\)/);
  assert.match(home, /\['genre', 'genre_bucket'\]\.includes\(rail\.curation\?\.kind\)/);
});

test('Home and phone genre rails bound pre-paint catalogue hydration', () => {
  assert.match(home, /this\.homeRailDisplayLimit = 18/);
  assert.match(home, /this\.homeRailFetchLimit = 24/);
  assert.match(home, /\/history\?limit=60/);
  assert.match(home, /\/home\/rails\?limit=\$\{railFetchLimit\}/);
  assert.match(catalog, /const verifiedCandidateLimit = Math\.min\(200, Math\.max\(96, limit \* 4\)\)/);
  assert.match(catalog, /listVerifiedTitleCandidatePool\([\s\S]*verifiedCandidateLimit/);
  assert.match(catalog, /candidateLimit = 96/);
  assert.match(catalog, /const variantsPromise = listVariantsByTitleIds\(titleIds, userId\)/);
  assert.match(catalog, /await applyCatalogOverlay\(titles, itemType, lang\)/);
  assert.match(catalog, /variantsByTitle: await variantsPromise/);
  assert.match(read('public/js/pages/MoviesPage.js'), /limit: this\._isTvMode\(\) \? 18 : 12/);
  assert.match(read('public/js/pages/SeriesPage.js'), /limit: this\._isTvMode\(\) \? 18 : 12/);
  assert.match(appHtml, /MoviesPage\.js\?v=61/);
  assert.match(appHtml, /SeriesPage\.js\?v=60/);
});

test('Live bounds first paint and defers off-screen logo decoding without hiding the lineup', () => {
  assert.match(live, /this\.BASE_ROW_LIMIT = 48/);
  assert.match(live, /this\.TV_ROW_LIMIT = 60/);
  assert.match(live, /data-action="show-more"/);
  assert.match(live, /loading="lazy" decoding="async" fetchpriority="low"/);
  assert.match(appHtml, /cloudApi\.js\?v=71/);
  assert.match(appHtml, /api\.js\?v=93/);
  assert.match(appHtml, /LiveGuideFusion\.js\?v=30/);
  assert.match(appHtml, /HomePage\.js\?v=b98a873483/);
});
