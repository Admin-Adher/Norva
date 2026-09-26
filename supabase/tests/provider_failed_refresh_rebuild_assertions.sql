insert into phase3_ctx values('refresh-stop-after-vod','true'::jsonb);
select pg_temp.phase3_refresh_proof();
delete from phase3_ctx where key='refresh-stop-after-vod';
select public.norva_settle_credential_transition_job(
  (select (value->>'job_id')::uuid from phase3_ctx where key='postclaim2'),'phase3-post-2',
  (select (value->>'lease_sequence')::integer from phase3_ctx where key='postclaim2'),
  'dead','catalog_unhealthy',1);
reset role;
insert into phase3_ctx select 'rebuild-dead',to_jsonb(job)
  from public.cloud_source_credential_transition_jobs job
  where id=(select (value->>'job_id')::uuid from phase3_ctx where key='postclaim2');

create function pg_temp.rebuild_refresh(p_override jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare v jsonb;
begin
  select value into v from phase3_ctx where key='rebuild-dead';
  v:=jsonb_build_object('transitionId',v->>'transition_id','userId',v->>'user_id',
    'jobId',v->>'id','sourceRevision',v->'expected_source_revision',
    'checkpointRevision',v->'checkpoint_revision','runId',v->>'title_projection_refresh_run_id',
    'headRevision',1,'transitionRevision',(select revision from public.cloud_source_transitions
      where id=(v->>'transition_id')::uuid),
    'reason','Rebuild after repaired provider snapshot validation')||p_override;
  return public.norva_rebuild_failed_credential_refresh(
    (v->>'transitionId')::uuid,(v->>'userId')::uuid,(v->>'jobId')::uuid,
    (v->>'transitionRevision')::bigint,(v->>'sourceRevision')::bigint,
    (v->>'headRevision')::bigint,(v->>'checkpointRevision')::bigint,(v->>'runId')::uuid,v->>'reason');
end $$;

create function pg_temp.rebuild_preserved_rows() returns jsonb language sql as $$
  select jsonb_build_object(
    'job',(select to_jsonb(j) from public.cloud_source_credential_transition_jobs j
      where id=(select (value->>'id')::uuid from phase3_ctx where key='rebuild-dead')),
    'checkpoint',(select to_jsonb(c) from public.cloud_source_catalog_title_refresh_checkpoints c
      where job_id=(select (value->>'id')::uuid from phase3_ctx where key='rebuild-dead')),
    'actions',(select jsonb_agg(to_jsonb(a) order by action_kind)
      from public.cloud_source_catalog_title_refresh_actions a
      where job_id=(select (value->>'id')::uuid from phase3_ctx where key='rebuild-dead')),
    'media',(select jsonb_agg(to_jsonb(m) order by id) from public.cloud_media_items m
      where user_id='93000000-0000-4000-8000-000000000001'),
    'variants',(select jsonb_agg(to_jsonb(v) order by id) from public.cloud_title_variants v
      where user_id='93000000-0000-4000-8000-000000000001'),
    'titles',(select jsonb_agg(to_jsonb(t) order by id) from public.cloud_titles t
      where user_id='93000000-0000-4000-8000-000000000001'))
$$;
insert into phase3_ctx values('rebuild-before',pg_temp.rebuild_preserved_rows());
select extensions.ok((select (value->'checkpoint'->'progress'->>'processedItems')::integer>0
  and value->'checkpoint'->'progress'->>'action'='vod_streams'
  and value->'checkpoint'->'progress'->>'actionComplete'='true'
  from phase3_ctx where key='rebuild-before'), 'fixture has accepted VOD items and a completed inventory action');
set local role service_role;
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"transitionRevision":null}')$$,
  'PT409','refresh rebuild transition CAS failed','rebuild rejects null transition revision');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"sourceRevision":999}')$$,
  'PT409','refresh rebuild job CAS failed','rebuild rejects changed credentials');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"headRevision":999}')$$,
  'PT409','refresh rebuild snapshot CAS failed','rebuild rejects changed catalog head');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"checkpointRevision":1}')$$,
  'PT409','refresh rebuild job CAS failed','rebuild requires the exact partial checkpoint');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"runId":null}')$$,
  'PT409','refresh rebuild job CAS failed','rebuild rejects a missing old run');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"jobId":"93000000-0000-4000-8000-000000000999"}')$$,
  'PT409','refresh rebuild job CAS failed','rebuild rejects an unrelated job');
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"reason":"https://secret.invalid"}')$$,
  '22023','bounded operator reason required','rebuild rejects unsafe audit reasons');
reset role;
insert into auth.users(id,email,created_at) values('93000000-0000-4000-8000-000000000002','phase3-other@example.test',now())
  on conflict(id) do nothing;
set local role service_role;
select extensions.throws_ok($$select pg_temp.rebuild_refresh('{"userId":"93000000-0000-4000-8000-000000000002"}')$$,
  'PT409','refresh rebuild transition CAS failed','rebuild rejects another owner');
reset role;
-- Fixture-only privileged insert. The exception subtransaction rolls it back;
-- the assertion itself stays outside so pgTAP retains one monotonic plan.
create function pg_temp.rebuild_active_work_probe() returns text
language plpgsql security definer as $$
begin
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,expected_source_revision,job_kind
  ) select user_id,transition_id,source_id,catalog_generation_id,expected_source_revision,job_kind
    from public.cloud_source_credential_transition_jobs
    where id=(select (value->>'id')::uuid from phase3_ctx where key='rebuild-dead');
  perform pg_temp.rebuild_refresh();
  raise exception 'unexpected rebuild success';
exception when others then return sqlstate||': '||sqlerrm;
end $$;
set local role service_role;
select extensions.is(pg_temp.rebuild_active_work_probe(),
  'PT409: refresh rebuild already has active work','rebuild cannot race an existing verifier');
insert into phase3_ctx values('rebuild-new-job',to_jsonb(pg_temp.rebuild_refresh()));
reset role;
select extensions.is(pg_temp.rebuild_preserved_rows(),
  (select value from phase3_ctx where key='rebuild-before'),
  'rebuild preserves failed job, accepted ledger, media, variants and title shells byte for byte');
set local role service_role;
select extensions.is(to_jsonb(pg_temp.rebuild_refresh()),
  (select value from phase3_ctx where key='rebuild-new-job'), 'rebuild replay appends only one job');
reset role;
select extensions.ok((select job.state='pending' and job.checkpoint_revision=0
  and job.title_projection_refresh_run_id<>(select (value->>'title_projection_refresh_run_id')::uuid
    from phase3_ctx where key='rebuild-dead')
  and generation.title_projection_refresh_run_id=job.title_projection_refresh_run_id
  and generation.title_projection_refreshed_at is null
  and generation.title_projection_inventory_completed_at is null
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_catalog_generations generation on generation.id=job.catalog_generation_id
  where job.id=(select (value#>>'{}')::uuid from phase3_ctx where key='rebuild-new-job')),
  'rebuild allocates a distinct run without claiming inventory or completion');
select extensions.is((select count(*)::integer from public.cloud_source_lifecycle_events
  where event_kind='credential_refresh_rebuild_requested'
    and transition_id=(select (value->>'transition_id')::uuid from phase3_ctx where key='rebuild-dead')),
  1,'operator recovery has one durable audit event');
set local role service_role;
insert into phase3_ctx select 'postclaim2',to_jsonb(claim)
  from public.norva_claim_credential_transition_jobs('phase3-post-2',1,120,
    'credential-transition-worker-v3-active-catalog-refresh') claim
  on conflict(key) do update set value=excluded.value;
select extensions.throws_ok(format($sql$select public.norva_complete_credential_transition(
  %L,%L,%L,'phase3-post-2',%s,%s,1,%L)$sql$,
  (select value->>'transition_id' from phase3_ctx where key='rebuild-dead'),
  '93000000-0000-4000-8000-000000000001',
  (select value->>'job_id' from phase3_ctx where key='postclaim2'),
  (select value->>'lease_sequence' from phase3_ctx where key='postclaim2'),
  (select revision from public.cloud_source_transitions where id=
    (select (value->>'transition_id')::uuid from phase3_ctx where key='rebuild-dead')),
  (select value->>'title_projection_refresh_run_id' from phase3_ctx where key='rebuild-dead')),
  'PT409','healthy candidate completion CAS failed','old accepted run cannot complete the new job');
select extensions.ok(not has_function_privilege('authenticated',
  'public.norva_rebuild_failed_credential_refresh(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text)','execute')
  and not has_function_privilege('anon',
  'public.norva_rebuild_failed_credential_refresh(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text)','execute'),
  'rebuild is unavailable to ordinary clients');
-- The parent fixture now executes every ordinary writer from the beginning,
-- reconciles the new inventory, and completes only with the new run proof.
