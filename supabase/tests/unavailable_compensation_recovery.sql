-- Operator integration regression against a supplied failed rollback fixture.
-- Execute with psql -v transition_id=<uuid>; all mutations are rolled back.
begin;
select set_config('norva.test_transition_id', :'transition_id', true);
set local request.jwt.claim.role = 'service_role';
do $test$
declare
 t public.cloud_source_transitions%rowtype;
 j public.cloud_source_credential_transition_jobs%rowtype;
 h public.cloud_source_catalog_heads%rowtype;
 before_config text;
 result jsonb;
 before_job jsonb;
begin
 select * into strict t from public.cloud_source_transitions
 where id=current_setting('norva.test_transition_id')::uuid;
 select * into strict j from public.cloud_source_credential_transition_jobs
 where transition_id=t.id and job_kind='rollback_refresh' and state='dead';
 select * into strict h from public.cloud_source_catalog_heads where source_id=t.old_source_id;
 select config_ciphertext into before_config from public.cloud_sources where id=t.old_source_id;
 before_job=to_jsonb(j);
 if has_function_privilege('authenticated','public.norva_fail_unavailable_credential_compensation(uuid,uuid,uuid,bigint,bigint,text)','EXECUTE')
 or has_function_privilege('anon','public.norva_fail_unavailable_credential_compensation(uuid,uuid,uuid,bigint,bigint,text)','EXECUTE') then
   raise exception 'public access to operator recovery';
 end if;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,j.id,null,h.head_revision,'test');
  raise exception 'null revision accepted';
 exception when sqlstate '22004' then null; end;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,j.id,t.revision+1,h.head_revision,'test');
  raise exception 'stale transition accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,j.id,t.revision,h.head_revision+1,'test');
  raise exception 'stale head accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,(select id from auth.users where id<>t.user_id limit 1),j.id,t.revision,h.head_revision,'test');
  raise exception 'other owner accepted';
 exception when sqlstate 'P0002' then null; end;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,gen_random_uuid(),t.revision,h.head_revision,'test');
  raise exception 'missing job accepted';
 exception when sqlstate 'PT409' then null; end;
 result=public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,j.id,t.revision,h.head_revision,'operator-regression');
 if not exists(select 1 from public.cloud_source_transitions where id=t.id and state='failed' and failure_code='rollback_unavailable') then
   raise exception 'failure not recorded';
 end if;
 if (select config_ciphertext from public.cloud_sources where id=t.old_source_id) is distinct from before_config
 or (select to_jsonb(x) from public.cloud_source_catalog_heads x where source_id=t.old_source_id) is distinct from to_jsonb(h)
 or (select to_jsonb(x) from public.cloud_source_credential_transition_jobs x where id=j.id) is distinct from before_job then
   raise exception 'active source/head or immutable failed job changed';
 end if;
 if exists(select 1 from public.cloud_source_transition_secrets where transition_id=t.id and (rollback_refresh_proof_id is not null or rollback_refresh_healthy_at is not null or cleared_at is null)) then
   raise exception 'fabricated healthy proof or uncleared secrets';
 end if;
 begin
  perform public.norva_fail_unavailable_credential_compensation(t.id,t.user_id,j.id,t.revision,h.head_revision,'test');
  raise exception 'terminal replay accepted';
 exception when sqlstate 'PT409' then null; end;
 raise notice 'Recovery regression passed: ACL, owner, revision, head, terminal immutability, source preservation, truthful failure';
end
$test$;
rollback;