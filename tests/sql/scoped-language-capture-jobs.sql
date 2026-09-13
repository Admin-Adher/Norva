-- Synthetic fixture only, with the installed handoff and service-role helper.
create table public.scoped_capture_checks(label text primary key);
create function public.scoped_capture_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'scoped_capture_%',label; end if;
  insert into public.scoped_capture_checks values(label);
end $$;
insert into public.admin_feature_flags(key,enabled) values('language_capture_pipeline_enabled',false);
insert into auth.users(id) values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.admin_internal_accounts(user_id) values('00000000-0000-4000-8000-000000000001');
insert into public.cloud_sources(id,user_id,enabled,sync_status)
 values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,'ready'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',true,'ready');
insert into public.catalog_file_audio_validation_jobs(id,requested_by,source_id,identity_key,item_type,external_id,
 profile_fingerprint,state,expected_audio_indices,next_track_position,strict_lid_window_position,
 strict_lid_window_count,strict_lid_window_protocol,strict_lid_window_tokens)
 select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 'scoped-fixture','movie','scoped-'||n,repeat('a',64),'queued',array[1],0,0,6,1,'[]'::jsonb from generate_series(1,45)n;

select public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled(),'global_flag_unchanged_false');
select public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000001'),'default_no_approval');
select public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(null),'null_job_disabled');
select public.scoped_capture_assert((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.catalog_language_capture_job_pilots'::regclass),'forced_rls');
select public.scoped_capture_assert(not has_table_privilege('anon','public.catalog_language_capture_job_pilots','SELECT')
 and not has_table_privilege('authenticated','public.catalog_language_capture_job_pilots','SELECT'),'no_client_reads');
select public.scoped_capture_assert(not has_table_privilege('service_role','public.catalog_language_capture_job_pilots','INSERT')
 and not has_table_privilege('service_role','public.catalog_language_capture_job_pilots','UPDATE'),'no_direct_service_writes');
select public.scoped_capture_assert(not has_function_privilege('authenticated','public.catalog_language_capture_pipeline_enabled_for_job(uuid)','EXECUTE')
 and not has_function_privilege('anon','public.authorize_catalog_language_capture_job(uuid,text,timestamptz)','EXECUTE')
 and not has_function_privilege('authenticated','public.revoke_catalog_language_capture_job(uuid,text,timestamptz)','EXECUTE'),'service_only_rpcs');

do $$
declare j uuid:='20000000-0000-4000-8000-000000000001'; expiry timestamptz:=clock_timestamp()+interval '40 minutes';
begin
 begin
   perform public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry);
   raise exception 'missing_service_check';
 exception when insufficient_privilege then
   perform public.scoped_capture_assert(true,'runtime_role_enforced');
 end;
end $$;
set request.jwt.claim.role='service_role';

do $$
declare j uuid:='20000000-0000-4000-8000-000000000001'; expiry timestamptz:=clock_timestamp()+interval '40 minutes';
 before_job jsonb; release uuid;
begin
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(gen_random_uuid(),repeat('a',64),expiry),'unknown_job_rejected');
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('b',64),expiry),'wrong_profile_rejected');
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),clock_timestamp()-interval '1 second'),'expired_request_rejected');
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),clock_timestamp()+interval '61 minutes'),'approval_ttl_ceiling');
 update public.catalog_file_audio_validation_jobs set requested_by='00000000-0000-4000-8000-000000000002',source_id='10000000-0000-4000-8000-000000000002' where id=j;
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'non_internal_account_rejected');
 update public.catalog_file_audio_validation_jobs set requested_by='00000000-0000-4000-8000-000000000001',source_id='10000000-0000-4000-8000-000000000001' where id=j;
 update public.cloud_sources set enabled=false;
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'disabled_source_rejected');
 update public.cloud_sources set enabled=true;
 update auth.users set banned_until=clock_timestamp()+interval '1 day';
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'banned_user_rejected');
 update auth.users set banned_until=null;
 select to_jsonb(r) into before_job from public.catalog_file_audio_validation_jobs r where id=j;
 perform public.scoped_capture_assert(public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'exact_job_approved');
 perform public.scoped_capture_assert(public.catalog_language_capture_pipeline_enabled_for_job(j),'approved_job_enabled_without_global');
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000002'),'neighbor_job_stays_legacy');
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled(),'approval_does_not_flip_global');
 perform public.scoped_capture_assert((select to_jsonb(r)=before_job from public.catalog_file_audio_validation_jobs r where id=j),'approval_does_not_mutate_job');
 perform public.scoped_capture_assert(public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'same_approval_idempotent');
 perform public.scoped_capture_assert(not public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry+interval '1 minute'),'replay_cannot_extend_ttl');
 update public.catalog_file_audio_validation_jobs set profile_fingerprint=repeat('b',64) where id=j;
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'profile_drift_suspends_approval');
 update public.catalog_file_audio_validation_jobs set profile_fingerprint=repeat('a',64),quarantined_at=clock_timestamp() where id=j;
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j)
   and not public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry),'quarantine_not_revived');
 update public.catalog_file_audio_validation_jobs set quarantined_at=null,state='verified' where id=j;
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'terminal_job_not_reopened');
 update public.catalog_file_audio_validation_jobs set state='running',queue_expires_at=null,lease_owner='fixture-owner',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=j;
 update public.cloud_sources set deleted_at=clock_timestamp();
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'source_removal_suspends_approval');
 update public.cloud_sources set deleted_at=null;
 update auth.users set deleted_at=clock_timestamp();
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'user_removal_suspends_approval');
 update auth.users set deleted_at=null;
 perform public.scoped_capture_assert(public.checkpoint_catalog_file_audio_capture(j,'wrong-owner',1,1,repeat('a',64),repeat('b',64),repeat('c',64),expiry,null,null,null) is null,'handoff_owner_guard_preserved');
 release:=public.checkpoint_catalog_file_audio_capture(j,'fixture-owner',1,1,repeat('a',64),repeat('b',64),repeat('c',64),expiry,null,null,null);
 perform public.scoped_capture_assert(release is not null,'real_handoff_accepts_only_scoped_approval');
 perform public.scoped_capture_assert((select strict_lid_window_position=0 and strict_lid_window_tokens='[]'::jsonb from public.catalog_file_audio_validation_jobs where id=j),'handoff_not_a_language_vote');
 perform public.scoped_capture_assert(not public.revoke_catalog_language_capture_job(j,repeat('b',64),expiry),'revoke_wrong_profile_cannot_remove');
 perform public.scoped_capture_assert(not public.revoke_catalog_language_capture_job(j,repeat('a',64),expiry+interval '1 second'),'revoke_wrong_expiry_cannot_remove');
 perform public.scoped_capture_assert(public.revoke_catalog_language_capture_job(j,repeat('a',64),expiry),'exact_approval_revoked');
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'revoked_job_returns_to_legacy');
 perform public.scoped_capture_assert((select state='running' and lease_owner='fixture-owner' from public.catalog_file_audio_validation_jobs where id=j),'revoke_preserves_real_job_and_lease');
 update public.admin_feature_flags set enabled=true where key='language_capture_pipeline_enabled';
 perform public.scoped_capture_assert(public.catalog_language_capture_pipeline_enabled_for_job(j),'existing_global_mode_preserved');
 update public.admin_feature_flags set enabled=false where key='language_capture_pipeline_enabled';
 -- A short valid approval is made stale only in this synthetic fixture.
 perform public.authorize_catalog_language_capture_job(j,repeat('a',64),expiry);
 update public.catalog_language_capture_job_pilots set created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' where job_id=j;
 perform public.scoped_capture_assert(not public.catalog_language_capture_pipeline_enabled_for_job(j),'expired_approval_fails_closed');
 delete from public.catalog_language_capture_job_pilots where job_id=j;
end $$;

-- Leave forty real synthetic jobs for the harness's concurrent approval race.
create table public.scoped_capture_race(expiry timestamptz not null);
insert into public.scoped_capture_race values(clock_timestamp()+interval '40 minutes');
