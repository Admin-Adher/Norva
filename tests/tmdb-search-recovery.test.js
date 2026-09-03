const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Promax market prefixes are removed without damaging real titles', async () => {
  const policy = await import('../supabase/functions/_shared/tmdb-search-policy.mjs');

  assert.equal(policy.cleanTmdbSearchQuery('ALB ▎ A Better Life'), 'A Better Life');
  assert.equal(policy.cleanTmdbSearchQuery('EXYU ▎ The Shadows Edge 4K'), 'The Shadows Edge');
  assert.equal(policy.cleanTmdbSearchQuery('MULTI ▎ Members Only: Palm Beach'), 'Members Only Palm Beach');
  assert.equal(policy.cleanTmdbSearchQuery('4K-AR - La Bête 2160p'), 'La Bête');
  assert.equal(policy.cleanTmdbSearchQuery('8 Mile'), '8 Mile');
  assert.equal(policy.cleanTmdbSearchQuery('X-Men'), 'X Men');
});

test('TMDB search locale ordering follows the provider title then bounded fallbacks', async () => {
  const policy = await import('../supabase/functions/_shared/tmdb-search-policy.mjs');

  assert.deepEqual(policy.tmdbSearchLocalesForTitle('ES ▎ El monje y el rifle', 'fr-FR'), ['es-ES', 'fr-FR', 'en-US']);
  assert.deepEqual(policy.tmdbSearchLocalesForTitle('ALB ▎ Firebird', 'fr-FR'), ['sq-AL', 'fr-FR', 'en-US']);
  assert.deepEqual(policy.tmdbSearchLocalesForTitle('SRB ▎ Firebird', 'fr-FR'), ['sr-RS', 'fr-FR', 'en-US']);
  assert.deepEqual(policy.tmdbSearchLocalesForTitle('FR ▎ Le Samouraï', 'fr-FR'), ['fr-FR', 'en-US']);
  assert.deepEqual(policy.tmdbSearchLocalesForTitle('Plain title', 'fr-FR'), ['fr-FR', 'en-US']);
});

test('TMDB transport errors stay inflight instead of becoming definitive misses', () => {
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  const start = projection.indexOf('async function tmdbSearchResults(');
  const end = projection.indexOf('// A provider poster is often TMDB', start);
  const block = projection.slice(start, end);

  assert.match(block, /fetchTmdbJsonWithRetry/);
  assert.doesNotMatch(block, /\.catch\(\(\) => null\)/);
  assert.match(projection, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(projection, /only a real HTTP 200 with results:\[\] may be stamped as a definitive miss/);
  assert.match(projection, /function normalizeMatchTitle[\s\S]*stripProviderSearchPrefix[\s\S]*replace\(\/\[’'\]\//);

  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  assert.match(sourceSync, /let tmdbFailureHalted = false/);
  assert.match(sourceSync, /while \(!tmdbFailureHalted && next < rows\.length\)/);
  assert.match(sourceSync, /catch \(_\) \{[\s\S]*tmdbFailureHalted = true/);
  assert.match(sourceSync, /tmdbFailureHalted,/);
});

test('source requeue is bounded, service-role only and serialized with the durable checkpoint', () => {
  const migration = read('supabase/migrations/20260901082000_tmdb_source_search_recovery_v1.sql');

  assert.match(migration, /norva_credential_require_service_role\(\)/);
  assert.match(migration, /p_limit < 1 or p_limit > 5000/);
  assert.match(migration, /where checkpoint\.mode = 'search_pending'\s+for update/);
  assert.match(migration, /reason=search_worker_active/);
  assert.match(migration, /variant\.source_id = p_source_id/);
  assert.match(migration, /pointer\.active_snapshot_id/);
  assert.match(migration, /search_match_attempted_at = null/);
  assert.match(migration, /'snapshotRowsReady', v_snapshot_rows_ready/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
});

test('source-sync health proves the exact TMDB policy deployed by every replica', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

  assert.match(sourceSync, /version: 18/);
  assert.match(sourceSync, /tmdbSearchPolicy: TMDB_SEARCH_POLICY_VERSION/);
  assert.match(deploy, /EXPECTED_TMDB_SEARCH_POLICY=promax-multilang-v2/);
  assert.match(deploy, /tmdbSearchPolicy/);
});
