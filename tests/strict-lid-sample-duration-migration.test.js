'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const baseline = read('supabase/migrations/20260816105918_async_vod_language_validation_jobs.sql');
const migration = read('supabase/migrations/20260816194558_strict_lid_sample_duration_20_seconds.sql');

const signature = [
  'public.finalize_catalog_file_audio_validation_job(',
  '  uuid, text, text, timestamptz, bigint, integer[]',
  ')',
].join('\n');

function functionDefinition(source) {
  const start = source.indexOf(
    'create or replace function public.finalize_catalog_file_audio_validation_job(',
  );
  assert.notEqual(start, -1, 'missing finalize function definition');
  const end = source.indexOf('\n$function$;', start);
  assert.notEqual(end, -1, 'missing finalize function terminator');
  return source.slice(start, end + '\n$function$;'.length);
}

test('strict LID provenance records the requested 20-second samples and never 30 seconds', () => {
  const finalize = functionDefinition(migration);
  assert.equal((finalize.match(/'sampleDurationSeconds'/g) || []).length, 1);
  assert.match(finalize, /'sampleDurationSeconds', 20,/);
  assert.doesNotMatch(finalize, /'sampleDurationSeconds', 30,/);
});

test('the replacement preserves the applied finalize function except for sample duration', () => {
  const oldFinalize = functionDefinition(baseline);
  const newFinalize = functionDefinition(migration);
  assert.equal(
    newFinalize,
    oldFinalize.replace("'sampleDurationSeconds', 30,", "'sampleDurationSeconds', 20,"),
  );
  assert.match(newFinalize, /security definer\nset search_path = ''/);
  assert.match(newFinalize, /pg_advisory_xact_lock/);
  assert.match(newFinalize, /v_job\.state <> 'finalizing'/);
  assert.match(newFinalize, /v_job\.lease_owner is distinct from btrim\(p_lease_owner\)/);
  assert.match(newFinalize, /vod_language_profile_snapshot\(v_profile\) is distinct from v_job\.profile_snapshot/);
  assert.match(newFinalize, /catalog_audio_track_indexes\(v_cache\.audio_tracks\)/);
  assert.match(newFinalize, /upsert_catalog_file_validated_tracks/);
  assert.match(newFinalize, /record_catalog_file_audio_verification/);
  assert.match(newFinalize, /set state = 'verified'/);
});

test('the migration keeps finalize private to service_role and reloads PostgREST schema', () => {
  assert.match(
    migration,
    new RegExp(`revoke all on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from public, anon, authenticated;`),
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to service_role;`),
  );
  assert.doesNotMatch(migration, /\bto\s+(?:public|anon|authenticated)\b/i);
  assert.match(migration, /notify pgrst, 'reload schema';/);
  assert.equal(
    (migration.match(/create or replace function public\./g) || []).length,
    1,
    'the migration must replace only the finalize RPC',
  );
});
