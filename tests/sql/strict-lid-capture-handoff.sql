-- Synthetic data only. Run after the metadata fixture in a networkless DB.
select public.metadata_assert(not public.catalog_language_capture_pipeline_enabled(),'capture_disabled_default');
select public.metadata_assert(not has_table_privilege('authenticated','public.catalog_file_audio_captures','SELECT')
  and not has_table_privilege('anon','public.catalog_file_audio_captures','INSERT'),'capture_private_table');
select public.metadata_assert(not has_function_privilege('authenticated',
  'public.checkpoint_catalog_file_audio_capture(uuid,text,integer,integer,text,text,text,timestamptz,text,text,uuid)','EXECUTE'),'capture_private_rpc');
select public.metadata_assert((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='public.catalog_file_audio_captures'::regclass),'capture_forced_rls');

create function public.capture_fixture_call(j uuid,o text,idx integer,ord integer,token uuid,
  fingerprint text default repeat('a',64),expires timestamptz default clock_timestamp()+interval '30 minutes')
returns uuid language sql as $$
  select public.checkpoint_catalog_file_audio_capture(j,o,idx,ord,fingerprint,repeat('b',64),repeat('c',64),expires,
    case when token is null then null else repeat('d',64) end,
    case when token is null then null else 'capture-provider-owner' end,token)
$$;

do $$
declare j uuid; token uuid:=gen_random_uuid(); release uuid; original_count integer;
begin
 select id into j from public.catalog_file_audio_validation_jobs where external_id='55';
 update public.catalog_file_audio_validation_jobs set state='running',lease_owner='capture-job-owner',
  lease_expires_at=clock_timestamp()+interval '10 minutes',identity_key='capture-fixture',expected_audio_indices=array[1],next_track_position=0,
  strict_lid_window_position=0,strict_lid_window_count=6,strict_lid_window_protocol=1,strict_lid_window_tokens='[]',
  profile_fingerprint=repeat('a',64),provider_attempt_token=token,provider_attempt_started_at=clock_timestamp(),
  consecutive_provider_no_progress_count=3 where id=j;
 select provider_attempt_count into original_count from public.catalog_file_audio_validation_jobs where id=j;
 insert into public.provider_account_language_validation_leases(provider_account_hash,lease_owner,expires_at)
   values(repeat('d',64),'capture-provider-owner',clock_timestamp()+interval '5 minutes');
 insert into public.provider_file_probe_leases(identity_key,lease_owner,expires_at)
   values('capture-fixture','capture-provider-owner',clock_timestamp()+interval '5 minutes');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token) is null,'capture_flag_is_enforced');
 update public.admin_feature_flags set enabled=true where key='language_capture_pipeline_enabled';
 perform public.metadata_assert(public.capture_fixture_call(j,'old-owner',1,1,token) is null,'capture_wrong_owner');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',2,1,token) is null,'capture_wrong_track');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,2,token) is null,'capture_wrong_window');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,gen_random_uuid()) is null,'capture_wrong_attempt');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token,repeat('e',64)) is null,'capture_changed_profile');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token,repeat('a',64),clock_timestamp()-interval '1 second') is null,'capture_expired_buffer');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token,repeat('a',64),clock_timestamp()+interval '3 hours') is null,'capture_retention_ceiling');
 perform public.metadata_assert((select count(*)=1 from public.provider_account_language_validation_leases where provider_account_hash=repeat('d',64)),
   'capture_invalid_handoff_preserves_account_lease');
 update public.provider_account_language_validation_leases set lease_owner='viewer-took-over' where provider_account_hash=repeat('d',64);
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token) is null,'capture_viewer_preemption');
 update public.provider_account_language_validation_leases set lease_owner='capture-provider-owner' where provider_account_hash=repeat('d',64);
 release:=public.capture_fixture_call(j,'capture-job-owner',1,1,token);
 perform public.metadata_assert(release is not null,'capture_checkpoint_committed');
 perform public.metadata_assert(not exists(select 1 from public.provider_file_probe_leases where identity_key='capture-fixture')
   and not exists(select 1 from public.provider_account_language_validation_leases where provider_account_hash=repeat('d',64)),
   'capture_both_provider_leases_released_atomically');
 perform public.metadata_assert((select provider_attempt_token is null and consecutive_provider_no_progress_count=0
   and provider_attempt_count=original_count and strict_lid_window_position=0 and strict_lid_window_tokens='[]'::jsonb
   from public.catalog_file_audio_validation_jobs where id=j),'capture_is_progress_but_never_language_evidence');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,token) is null,'capture_old_attempt_not_replayable');
 -- A local resumed analysis neither acquires nor releases another worker's
 -- current account lease. Its exact capture release token stays idempotent.
 insert into public.provider_account_language_validation_leases(provider_account_hash,lease_owner,expires_at)
   values(repeat('d',64),'another-worker',clock_timestamp()+interval '5 minutes');
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,null)=release,'capture_local_retry_idempotent');
 perform public.metadata_assert((select lease_owner='another-worker' from public.provider_account_language_validation_leases
   where provider_account_hash=repeat('d',64)),'capture_local_retry_preserves_other_account_lease');
 update public.catalog_file_audio_validation_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j;
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,null) is null,'capture_expired_job_lease');
 update public.catalog_file_audio_validation_jobs set state='failed',quarantined_at=clock_timestamp(),lease_owner=null,lease_expires_at=null where id=j;
 perform public.metadata_assert(public.capture_fixture_call(j,'capture-job-owner',1,1,null) is null,'capture_cannot_revive_quarantine');
end $$;
