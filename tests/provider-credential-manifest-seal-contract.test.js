'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  name,
), 'utf8').replace(/\r\n?/g, '\n');

const progress = read('20260823122100_catalog_manifest_seal_progress.sql');
const functions = read('20260823122110_catalog_manifest_seal_functions.sql');
const worker = read('20260823122111_catalog_manifest_seal_worker.sql');
const guards = read('20260823122112_catalog_manifest_seal_guards.sql');
const triggers = read('20260823122120_catalog_manifest_seal_trigger_install.sql');
const transition = read('20260823120000_provider_credential_transition_v1.sql');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('manifest pages retain one processing lease until the worker checkpoints', () => {
  assert.match(worker, /v_limit integer := 25000/);
  assert.match(worker, /set statement_timeout = '60s'/);
  const continuation = section(
    worker,
    'if not v_all_complete then',
    '\n  select progress.* into v_candidate_progress',
  );
  assert.match(continuation, /'leaseRetained',true/);
  assert.match(continuation, /'checkpointRevision',v_job\.checkpoint_revision/);
  assert.doesNotMatch(continuation, /set state='pending'/);

  const finalization = section(
    worker,
    "select progress.* into v_candidate_progress",
    '\nend\n$function$;',
  );
  assert.match(finalization, /set state='pending',lease_owner=null,lease_until=null/);
  assert.match(finalization, /'leaseRetained',false/);
});

test('BUILDING generation lookup is metadata-only and strong identity is bounded', () => {
  const getter = section(
    functions,
    'create or replace function public.norva_get_credential_catalog_generation(',
    '\ncreate or replace function public.norva_get_active_catalog_identity_evidence(',
  );
  assert.match(getter, /generation\.identity_evidence -> 'strongIdentity'/);
  assert.doesNotMatch(getter, /norva_credential_strong_identity_signals\(/);
  assert.doesNotMatch(getter, /from public\.cloud_media_items/);

  assert.match(progress, /strong_identity_sample text\[\]/);
  assert.match(progress, /cardinality\(strong_identity_sample\) <= 256/);
  assert.match(worker, /limit 256[\s\S]*v_page_strong_sample/);
  assert.match(worker, /octet_length\(page\.external_id\) <= 128/);
  assert.match(functions, /octet_length\(external_id\) <= 128/);
});

test('manifest scratch rows are private and removed on success or terminal state', () => {
  assert.match(progress, /enable row level security/);
  assert.match(
    progress,
    /revoke all on table public\.cloud_source_catalog_manifest_seal_progress[\s\S]*service_role/,
  );
  assert.match(
    worker,
    /delete from public\.cloud_source_catalog_manifest_seal_progress progress[\s\S]*v_fenced_generations <> 2/,
  );
  assert.match(
    guards,
    /new\.state in \('failed','cancelled','completed'\)[\s\S]*delete from public\.cloud_source_catalog_manifest_seal_progress/,
  );
});

test('candidate-title writers have before-row and after-statement seal fences', () => {
  assert.match(triggers, /trg_candidate_titles_manifest_seal_guard/);
  assert.match(
    triggers,
    /trg_candidate_titles_generation_revision_i[\s\S]*referencing new table as new_rows/,
  );
  assert.match(
    triggers,
    /trg_candidate_titles_generation_revision_u[\s\S]*referencing new table as new_rows/,
  );
  assert.match(
    triggers,
    /trg_candidate_titles_generation_revision_d[\s\S]*referencing old table as old_rows/,
  );
  assert.match(triggers, /candidate title transition-table trigger drift/);
});

test('after-statement fence rejects writers that resume after seal finalization', () => {
  const rowChanged = section(
    functions,
    'create or replace function public.norva_catalog_generation_row_changed()',
    '\ncommit;',
  );
  assert.match(rowChanged, /if not found then/g);
  assert.match(rowChanged, /reason=manifest_generation_changed/g);
  assert.match(rowChanged, /reason=manifest_sealing/g);
  assert.match(
    rowChanged,
    /current_setting\('norva\.catalog_purge_generation', true\)[\s\S]*generation\.state = 'purging'/,
  );
  assert.doesNotMatch(
    rowChanged,
    /if not found and exists \([\s\S]{0,240}state in \('building','active'\)/,
  );
  assert.match(
    rowChanged,
    /select distinct generation_id from old_rows where generation_id is not null/,
  );
  assert.match(
    rowChanged,
    /select distinct generation_id from new_rows where generation_id is not null/,
  );
});

test('terminal purge keeps its exact proof through candidate projection cleanup', () => {
  const purge = section(
    transition,
    'create or replace function public.norva_purge_cancelled_credential_generation_batch(',
    '\ncreate or replace function public.norva_claim_credential_transition_jobs(',
  );
  const projectionDelete = purge.indexOf(
    'delete from public.cloud_source_catalog_generation_candidate_titles projection',
  );
  const proofReset = purge.indexOf(
    "perform set_config('norva.catalog_purge_generation', '', true);",
  );
  assert.notEqual(projectionDelete, -1);
  assert.notEqual(proofReset, -1);
  assert.ok(proofReset > projectionDelete);
});
