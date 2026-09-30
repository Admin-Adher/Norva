import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260930151000_source_reaper_enabled_import_guard.sql', import.meta.url), 'utf8');
const fixture = fs.readFileSync(new URL('../supabase/tests/source_reaper_enabled_import_guard.sql', import.meta.url), 'utf8');

test('reaper patch is exact, idempotent and rejects ambiguous drift', () => {
  assert.match(migration, /v_old_count = 0 and v_new_count = 1/);
  assert.match(migration, /v_old_count <> 1 or v_new_count <> 0/);
  assert.match(migration, /using errcode = '55000'/);
  assert.match(migration, /deleted_at is null and enabled/);
  assert.match(migration, /execute replace\(v_definition,v_old,v_new\)/);
  assert.doesNotMatch(migration, /\b(call|grant|delete|update)\s+(public\.|from|on|execute)/i);
});

test('PostgreSQL proof refuses the production database and checks real activity guards', () => {
  assert.match(fixture, /current_database\(\) <> 'norva_source_reaper_proof'/);
  assert.match(fixture, /norva\.disposable_reaper_proof/);
  for (const evidence of ['enabled syncing source still defers', 'active provider permit', 'active fallback lease', 'active playback', 'active gateway session', 'exact due cleanup job', '5000-row budget']) {
    assert.ok(fixture.includes(evidence), evidence);
  }
  assert.match(fixture, /rollback;\s*$/);
});
