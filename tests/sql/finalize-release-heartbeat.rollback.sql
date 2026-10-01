-- Run inside BEGIN after the migration, with owner_a = authorized QA owner.
select set_config('test.selection.owner_a', :'owner_a', true);
do $test$
declare u uuid:=current_setting('test.selection.owner_a')::uuid; s uuid;
  first_token uuid:=gen_random_uuid(); next_token uuid:=gen_random_uuid(); before_hint jsonb;
begin
  assert not has_function_privilege('authenticated','public.norva_active_source_finalize_lease_count()','EXECUTE');
  assert not has_function_privilege('anon','public.norva_release_source_finalize_lease(uuid,uuid,uuid)','EXECUTE');
  select id into strict s from public.cloud_sources where user_id=u and deleted_at is null
    and public.norva_selection_source_identity_valid(id,user_id) limit 1;
  assert not exists(select 1 from public.cloud_source_finalize_leases where source_id=s and lease_until>clock_timestamp()),
    'wait for the real QA import before this rollback fixture';
  before_hint:=jsonb_build_object('syncProgress',jsonb_build_object('stage','building_titles'),
    'finalizeCursor',jsonb_build_object('offset',500),'finalizeLease',jsonb_build_object('until',clock_timestamp()+interval '4 minutes'));
  update public.cloud_sources set config_hint=before_hint where id=s;
  delete from public.cloud_source_finalize_leases where source_id=s;
  insert into public.cloud_source_finalize_leases(source_id,user_id,lease_token,lease_until)
    values(s,u,first_token,clock_timestamp()+interval '4 minutes');
  perform set_config('role','service_role',true);
  assert not public.norva_release_source_finalize_lease(s,u,next_token);
  assert (select config_hint=before_hint from public.cloud_sources where id=s);
  assert public.norva_release_source_finalize_lease(s,u,first_token);
  assert (select config_hint=before_hint-'finalizeLease' from public.cloud_sources where id=s);
  perform set_config('role','supabase_admin',true);
  update public.cloud_sources set config_hint=before_hint where id=s;
  insert into public.cloud_source_finalize_leases(source_id,user_id,lease_token,lease_until)
    values(s,u,next_token,clock_timestamp()+interval '4 minutes');
  perform set_config('role','service_role',true);
  assert not public.norva_release_source_finalize_lease(s,u,first_token);
  assert (select config_hint=before_hint from public.cloud_sources where id=s), 'late release damaged successor';
  assert public.norva_release_source_finalize_lease(s,u,next_token);
  raise notice 'Exact lease release, preserved progress, successor protection and service ACL passed';
end $test$;
rollback;
