'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260911102129_strict_lid_completed_inconclusive_releases_queue.sql');
const operator = read('ops/hetzner/scripts/retire-prior-lid-pilot-20260911.py');

test('only a complete, live-owned, non-quarantined receipt set becomes terminal', () => {
  for (const guard of [
    "v_code = 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING'",
    'v_job.quarantined_at is null', 'v_job.verified_at is null',
    'v_job.lease_expires_at > v_now', 'v_job.strict_lid_window_protocol = 1',
    'v_job.strict_lid_window_count in (4, 6)',
    'v_job.strict_lid_window_position = v_job.strict_lid_window_count',
    'jsonb_array_length(v_job.strict_lid_window_tokens) = v_job.strict_lid_window_count',
    'public.strict_lid_window_tokens_are_valid(v_job.strict_lid_window_tokens)',
  ]) assert.ok(migration.includes(guard), guard);
  assert.match(migration, /p_terminal := true;[\s\S]*LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE/);
  assert.match(migration, /'status', case when coalesce\(p_terminal, false\) then 'failed' else 'pending' end/);
  assert.match(migration, /'jobId', v_job\.id/);
});

test('the migration is guarded and changes no historical data, grants or certification thresholds', () => {
  assert.match(migration, /pg_get_functiondef\(target\)/);
  assert.match(migration, /RAISE EXCEPTION 'Strict LID completed-outcome guard drifted'/);
  assert.match(migration, /position\(new_transition IN definition\).*position\(new_status IN definition\)/);
  assert.doesNotMatch(migration, /update public\.|delete from|truncate |grant |revoke |set state|verified_at =|tokens =/i);
  assert.match(migration, /SET LOCAL lock_timeout = '3s'/);
  assert.match(migration, /SET LOCAL statement_timeout = '20s'/);
});

test('historical cleanup is disjoint from the immutable pilot, atomic and owner-bound', () => {
  assert.match(operator, /len\(rows\) == 6/);
  assert.match(operator, /prior_job_overlaps_current_pilot/);
  assert.match(operator, /quarantined_at.*is None/);
  assert.match(operator, /md5\(to_jsonb\(j\)::text\) IS DISTINCT FROM/);
  assert.match(operator, /cancel_catalog_file_audio_validation_job\(j.id,j.requested_by/);
  assert.match(operator, /catalog-file-audio-validation-user:/);
  assert.ok(operator.indexOf('for user in sorted') < operator.indexOf('for item in plan[\'rows\']:', operator.indexOf('def retirement_sql')));
  assert.match(operator, /retainedReceiptSets/);
  const retirement = operator.slice(operator.indexOf('def retirement_sql(plan):'), operator.indexOf('def proof_retirement():'));
  assert.doesNotMatch(retirement, /reset_catalog_file_audio_validation|strict_lid_window_tokens\s*=|retry_at\s*=\s*now/);
});

test('old audio is allowlisted, hashed and moved into a private recoverable archive', () => {
  assert.match(operator, /len\(audio\) == 23/);
  assert.match(operator, /AUDIO.fullmatch\(relative\)/);
  assert.match(operator, /candidate.resolve\(\).is_relative_to\(base\)/);
  assert.match(operator, /not candidate.is_symlink\(\)/);
  assert.match(operator, /sha\(file.read_bytes\(\)\) == item\['sha256'\]/);
  assert.match(operator, /os.rename\(source, target\)/);
  assert.doesNotMatch(operator, /shutil\.rmtree|\.unlink\(|os\.remove\(/);
});
