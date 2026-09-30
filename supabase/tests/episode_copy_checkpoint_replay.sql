-- Run inside a caller-owned transaction and ROLLBACK. Uses a pending build
-- fixture already in episode_state_copy, without retaining fixture mutations.
set local request.jwt.claim.role = 'service_role';
do $test$
declare
  j public.cloud_source_credential_transition_jobs%rowtype;
  c public.cloud_source_catalog_generation_episode_copy%rowtype;
  r jsonb;
begin
  select job.* into strict j
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_catalog_generation_episode_copy copy
    on copy.generation_id=job.catalog_generation_id
  where job.state='pending' and job.job_kind='build_candidate_generation'
    and copy.state='pending' and copy.revision > 0
  order by job.created_at desc limit 1 for update of job skip locked;
  update public.cloud_source_credential_transition_jobs
  set state='processing',lease_owner='copy-replay-test',
    lease_sequence=lease_sequence+1,lease_until=now()+interval '1 minute'
  where id=j.id returning * into j;
  select * into strict c from public.cloud_source_catalog_generation_episode_copy
    where generation_id=j.catalog_generation_id;
  r:=public.norva_copy_credential_generation_episode_state(
    j.transition_id,j.user_id,j.catalog_generation_id,j.id,j.lease_owner,
    j.lease_sequence,c.revision-1,500);
  if r->>'replayed' <> 'true' or (r->>'copyRevision')::bigint<>c.revision
    or (r->>'membershipsProcessed')::integer<>0 then
    raise exception 'lost response did not recover without writes';
  end if;
  begin
    perform public.norva_copy_credential_generation_episode_state(
      j.transition_id,j.user_id,j.catalog_generation_id,j.id,'wrong-worker',
      j.lease_sequence,c.revision-1,500);
    raise exception 'wrong worker accepted';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.norva_copy_credential_generation_episode_state(
      j.transition_id,j.user_id,j.catalog_generation_id,j.id,j.lease_owner,
      j.lease_sequence,c.revision+1,500);
    raise exception 'future cursor accepted';
  exception when sqlstate 'PT409' then null;
  end;
  if (select revision from public.cloud_source_catalog_generation_episode_copy
      where generation_id=c.generation_id) <> c.revision then
    raise exception 'replay advanced the cursor';
  end if;
end
$test$;
