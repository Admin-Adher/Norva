const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const migration = read('supabase', 'migrations', '20260827143000_postgrest_application_conflict_sqlstate_v1.sql');
const helper = read('supabase', 'functions', '_shared', 'database-conflict.ts');
const providerAccess = read('supabase', 'functions', 'norva-provider-access', 'index.ts');
const sourceSync = read('supabase', 'functions', 'norva-source-sync', 'index.ts');
const accountDelete = read('supabase', 'functions', 'norva-account-delete', 'index.ts');
const edgeDeploy = read('ops', 'hetzner', 'scripts', '04-deploy-edge-functions.sh');

test('forward migration rewrites only application routines and reserves 40001 for PostgreSQL', () => {
  assert.match(migration, /n\.nspname in \('public', 'email_private', 'affiliate_private'\)/);
  assert.match(migration, /current_user <> 'supabase_admin'/);
  assert.match(migration, /dependency\.deptype = 'e'/);
  assert.match(migration, /replace\(v_definition, '40001', 'PT409'\)/);
  assert.match(migration, /if v_remaining <> 0 then/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('Edge workers recognize PT409 and legacy 40001 through one rolling-safe helper', () => {
  assert.match(helper, /code === "PT409" \|\| code === "40001"/);
  assert.match(providerAccess, /isStaleDatabaseConflict\(error\)/);
  assert.match(sourceSync, /isStaleDatabaseConflict\(error\)/);
  assert.match(accountDelete, /isStaleDatabaseConflict\(error\)/);
  assert.match(edgeDeploy, /shared database-conflict source digest mismatch/);
  assert.match(edgeDeploy, /norva-account-delete source digest mismatch/);
});

test('RPC error mapping exposes PT409 as the same safe revision mismatch contract', () => {
  assert.match(providerAccess, /sqlstate === "PT409" \|\| sqlstate === "40001"/);
  assert.match(providerAccess, /"ACCESS_REVISION_MISMATCH"/);
  assert.match(providerAccess, /"TRANSITION_REVISION_MISMATCH"/);
});

test('migrations after the conflict rewrite cannot reintroduce application-authored 40001', () => {
  const migrationDirectory = path.join(__dirname, '..', 'supabase', 'migrations');
  const laterMigrations = fs.readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql') && name > '20260827143000_postgrest_application_conflict_sqlstate_v1.sql');

  for (const name of laterMigrations) {
    const source = fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
    assert.doesNotMatch(source, /40001/, `${name} reintroduces a retryable application conflict`);
  }
});
