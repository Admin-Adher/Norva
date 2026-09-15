'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20260915002500_catalog_merge_playback_lock_budget.sql'), 'utf8');
const discovery = sql.slice(sql.indexOf('create function public.norva_queue_validated'),
  sql.indexOf('create function public.norva_process_one'));
const worker = sql.slice(sql.indexOf('create function public.norva_process_one'),
  sql.indexOf('-- pg_cron'));
const ownerSafe = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20260915003500_catalog_merge_cron_owner_safe.sql'), 'utf8');

test('discovery queues only validated same-year visible title groups without source locks', () => {
  assert.match(discovery, /cloud_catalog_visible_title_variants/);
  assert.match(discovery, /count\(distinct t.release_year\)<=1/);
  assert.match(discovery, /bool_and\(t.match_status='provider_verified'/);
  assert.match(discovery, /tmdbValidation,valid/);
  assert.doesNotMatch(discovery, /perform.*norva_merge_validated|:=.*norva_merge_validated/i);
  assert.doesNotMatch(discovery.replace(/--[^\n]*/g, ''), /for (share|update)/i);
  assert.match(discovery, /where q.user_id is null or q.state='done'/);
});

test('one worker uses the original validated merge and releases its locks on timeout', () => {
  assert.match(worker, /limit 1 for update skip locked/);
  assert.match(worker, /begin\s+v_result:=public.norva_merge_validated_tmdb_group/);
  assert.match(worker, /exception when query_canceled then/);
  assert.match(worker, /v_state:='timeout'; v_sqlstate:='57014'/);
  assert.match(worker, /end;\s+update public.norva_catalog_tmdb_merge_queue/);
  assert.match(worker, /now\(\)\+interval '5 minutes'/);
  assert.doesNotMatch(sql, /create or replace function public.(claim_cloud_playback_session|norva_assert_source_catalog_visible_locked)/);
});

test('the real statement timer is set by cron before SELECT, not inside the merge', () => {
  assert.match(worker, /current_setting\('statement_timeout'\)::interval/);
  assert.match(worker, /v_budget>interval '3 seconds'/);
  assert.match(sql, /'norva-catalog-tmdb-merge-one','10 seconds',[\s\S]*set statement_timeout='3s'; select public.norva_process_one_tmdb_merge\(\)/);
  assert.match(sql, /'norva-catalog-tmdb-merge','7-59\/10 \* \* \* \*',[\s\S]*set statement_timeout='90s'; select public.norva_queue_validated_tmdb_merges\(300\)/);
  assert.doesNotMatch(worker, /set_config\('statement_timeout'/);
});

test('queue and maintenance entry points stay admin-only and security invoker', () => {
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public.norva_catalog_tmdb_merge_queue from public,anon,authenticated,service_role/);
  assert.equal((sql.match(/language plpgsql security invoker/g) || []).length, 2);
  for (const name of ['norva_queue_validated_tmdb_merges', 'norva_process_one_tmdb_merge']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}[^;]*from public,anon,authenticated,service_role`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}[^;]*to postgres,supabase_admin`));
  }
});

test('cron replacement targets job IDs across owners and deactivates duplicates without deletion', () => {
  assert.match(ownerSafe, /select min\(jobid\).*where jobname='norva-catalog-tmdb-merge'/);
  assert.match(ownerSafe, /cron.alter_job\(v_job.jobid/);
  assert.match(ownerSafe, /active=>\(v_job.jobid=v_keep\)/);
  assert.match(ownerSafe, /count\(\*\).*jobname='norva-catalog-tmdb-merge' and active\)<>1/);
  assert.doesNotMatch(ownerSafe.replace(/--[^\n]*/g, ''), /delete from|cron.unschedule|cron.schedule\(/i);
});
