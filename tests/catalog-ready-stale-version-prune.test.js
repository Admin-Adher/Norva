const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260825080000_catalog_ready_stale_version_prune.sql',
), 'utf8');
const sourceSync = fs.readFileSync(path.join(
  root,
  'supabase/functions/norva-source-sync/index.ts',
), 'utf8');
const cloud = fs.readFileSync(path.join(
  root,
  'supabase/functions/norva-cloud/index.ts',
), 'utf8');
const xtream = fs.readFileSync(path.join(
  root,
  'supabase/functions/_shared/xtream-sync.ts',
), 'utf8');
const proofHarness = fs.readFileSync(path.join(
  root,
  'ops/hetzner/scripts/run_catalog_ready_prune_proof.sh',
), 'utf8');

test('ready prune is bounded, generation fenced and service-only', () => {
  assert.match(migration, /create index concurrently if not exists cloud_media_items_generation_catalog_version_id_idx/i);
  assert.match(migration, /catalog ready prune index homonym has noncanonical shape/i);
  assert.match(migration, /v_index\.indkey\[0\] <> v_source_attnum/i);
  assert.match(migration, /v_index\.indkey\[3\] <> v_id_attnum/i);
  assert.match(migration, /not v_index\.indisvalid or not v_index\.indisready/i);
  assert.match(migration, /perform public\.norva_credential_require_service_role\(\)/i);
  const epochLock = migration.indexOf('perform public.norva_lock_catalog_background_owner_epoch(p_user_id)');
  const sourceLock = migration.indexOf('select source.* into v_source');
  assert.ok(epochLock >= 0 && sourceLock > epochLock, 'account epoch must lock before the source row');
  assert.match(migration, /perform public\.norva_set_catalog_delete_proof\s*\(/i);
  assert.match(migration, /syncCursor,active/i);
  assert.match(migration, /syncProgress,catalogVersion/i);
  assert.match(migration, /syncProgress,counts,total/i);
  assert.match(migration, /if v_catalog_version is null or v_expected_total is null/i);
  assert.match(migration, /catalog version proof missing during ready prune/i);
  assert.match(migration, /v_current_rows is distinct from v_expected_total/i);
  assert.doesNotMatch(migration, /max\s*\(\s*item\.catalog_version\s*\)/i);
  assert.doesNotMatch(migration, /group by item\.catalog_version/i);
  assert.match(migration, /catalog_version is distinct from v_catalog_version/i);
  assert.match(migration, /limit p_limit\s+for update skip locked/i);
  assert.match(migration, /p_limit < 1 or p_limit > 500/i);
  assert.match(migration, /norva_get_catalog_write_snapshot\(p_source_id, p_user_id\)/i);
  assert.match(migration, /'writeSnapshot', v_write_snapshot/i);
  assert.match(migration, /revoke all on function public\.norva_prune_catalog_generation_before_ready[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.norva_prune_catalog_generation_before_ready[\s\S]*to service_role/i);
});

test('finalize defers stale-version prune until cinema and Live are built, then rechecks before ready', () => {
  for (const [name, engine] of [['source-sync', sourceSync], ['cloud', cloud]]) {
    const calls = engine.match(/pruneCatalogGenerationBeforeReady\s*\(/g) || [];
    assert.ok(calls.length >= 2, `${name}: helper plus the terminal ready fence must be present`);
    const titlesStart = engine.indexOf('if (phase === "titles")');
    const completeStart = engine.indexOf('if (phase !== "complete")', titlesStart);
    assert.ok(titlesStart >= 0 && completeStart > titlesStart, `${name}: title and complete phases must be ordered`);
    assert.doesNotMatch(
      engine.slice(titlesStart, completeStart),
      /pruneCatalogGenerationBeforeReady/,
      `${name}: stale rows must not be pruned before the Live-last phase`,
    );
    assert.match(engine.slice(completeStart), /if \(versionedCatalog\)[\s\S]*const readyPrune = await pruneCatalogGenerationBeforeReady/);
    assert.match(engine, /if \(phase !== "complete"\)[\s\S]*const readyPrune = await pruneCatalogGenerationBeforeReady/);
    assert.match(engine, /nextPhase: "complete"[\s\S]*readyPrune/);
    assert.match(engine, /generation\.userVisibilityEpoch = nextSnapshot\.userVisibilityEpoch/);
    assert.match(engine, /nextSnapshot\.sourceVisibilityEpoch !== generation\.sourceVisibilityEpoch/);
  }
});

test('discovery persists the exact version and delegates deletion to the durable ready gate', () => {
  assert.match(xtream, /catalogVersion: cursor\.runVersion \? Number\(cursor\.runVersion\) : undefined/);
  assert.match(xtream, /Layer3 deferred stale prune to ready gate/);
  assert.doesNotMatch(xtream, /async function pruneStaleSourceItems/);
  assert.doesNotMatch(xtream, /norva_prune_stale_catalog_generation_items/);
});

test('real PostgreSQL proof harness commits bounded batches from fresh snapshots', () => {
  assert.match(proofHarness, /for \(\(batch = 1; batch <= MAX_BATCHES; batch\+\+\)\)/);
  assert.match(proofHarness, /norva_get_catalog_write_snapshot/);
  assert.match(proofHarness, /norva_prune_catalog_generation_before_ready/);
  assert.match(proofHarness, /BATCH_LIMIT <= 500/);
  assert.match(proofHarness, /statement_timeout='8s'/);
  assert.match(proofHarness, /deleted == 0/);
  assert.match(proofHarness, /prune did not converge within MAX_BATCHES/);
});
