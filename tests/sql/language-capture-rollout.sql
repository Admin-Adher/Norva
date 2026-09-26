select public.rollout_assert(not public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000010'),'installation_inert');
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job(null),'null_job_disabled');
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('ffffffff-ffff-ffff-ffff-ffffffffffff'),'missing_job_disabled');
select public.rollout_assert((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
 ('public.catalog_language_capture_rollout'::regclass,'public.catalog_language_capture_rollout_events'::regclass)),'forced_rls');
select public.rollout_assert(not has_table_privilege('authenticated','public.catalog_language_capture_rollout','SELECT')
 and not has_table_privilege('anon','public.catalog_language_capture_rollout_events','SELECT'),'no_client_reads');
select public.rollout_assert(not has_table_privilege('service_role','public.catalog_language_capture_rollout','UPDATE')
 and not has_table_privilege('service_role','public.catalog_language_capture_rollout_events','DELETE'),'no_direct_service_mutation');
select public.rollout_assert(not has_function_privilege('anon','public.set_catalog_language_capture_rollout(bigint,integer,text)','EXECUTE')
 and not has_function_privilege('authenticated','public.catalog_language_capture_rollout_enabled_for_job(uuid)','EXECUTE'),'service_only_rpcs');
do $$begin
 begin
  perform public.set_catalog_language_capture_rollout(0,100,'Synthetic first stage');
  raise exception 'missing runtime role check';
 exception when insufficient_privilege then perform public.rollout_assert(true,'runtime_role_guard'); end;
end$$;
set request.jwt.claim.role='service_role';
do $$begin
 begin perform public.set_catalog_language_capture_rollout(0,500,'Synthetic skipped stage');
  raise exception 'missing stage guard';
 exception when invalid_parameter_value then perform public.rollout_assert(true,'cannot_skip_stage'); end;
 begin perform public.set_catalog_language_capture_rollout(0,101,'Synthetic invalid stage');
  raise exception 'missing enum guard';
 exception when invalid_parameter_value then perform public.rollout_assert(true,'invalid_stage'); end;
 begin perform public.set_catalog_language_capture_rollout(0,100,'short');
  raise exception 'missing note guard';
 exception when invalid_parameter_value then perform public.rollout_assert(true,'audit_note_required'); end;
 begin perform public.set_catalog_language_capture_rollout(null,100,'Synthetic invalid revision');
  raise exception 'missing revision guard';
 exception when invalid_parameter_value then perform public.rollout_assert(true,'revision_required'); end;
end$$;
select public.rollout_assert(public.set_catalog_language_capture_rollout(0,100,'Synthetic first stage')=
 '{"revision":1,"basisPoints":100,"changed":true}'::jsonb,'first_stage_cas');
select public.rollout_assert(public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000010'),'ordinary_owner_included');
select public.rollout_assert(public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000011'),'same_owner_same_cohort');
select public.rollout_assert(not public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000001'),'other_cohort_legacy');
insert into public.fixture_internal values('00000000-0000-4000-8000-000000000001');
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000001'),'internal_status_no_bypass');
select public.rollout_assert(not public.catalog_language_capture_pipeline_enabled(),'global_flag_unchanged');
select public.rollout_assert(public.set_catalog_language_capture_rollout(1,100,'Synthetic identical stage')->>'changed'='false'
 and (select count(*)=1 from public.catalog_language_capture_rollout_events),'idempotent_no_duplicate_event');
do $$begin
 begin perform public.set_catalog_language_capture_rollout(0,500,'Synthetic stale operator');
  raise exception 'missing stale guard';
 exception when serialization_failure then perform public.rollout_assert(true,'stale_operator_rejected'); end;
end$$;
update auth.users set banned_until=now()+interval '1 hour' where id='00000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'banned_owner_refused');
update auth.users set banned_until=null,deleted_at=now() where id='00000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'deleted_owner_refused');
update auth.users set deleted_at=null;
update public.cloud_sources set enabled=false where id='10000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'disabled_source_refused');
update public.cloud_sources set enabled=true,deleted_at=now() where id='10000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'deleted_source_refused');
update public.cloud_sources set deleted_at=null,sync_status='importing' where id='10000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'unready_source_refused');
update public.cloud_sources set sync_status='ready',user_id='00000000-0000-4000-8000-000000000001' where id='10000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'owner_mismatch_refused');
update public.cloud_sources set user_id='00000000-0000-4000-8000-000000000010' where id='10000000-0000-4000-8000-000000000010';
update public.catalog_file_audio_validation_jobs set quarantined_at=now() where id='20000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'quarantine_not_revived');
update public.catalog_file_audio_validation_jobs set quarantined_at=null,state='verified' where id='20000000-0000-4000-8000-000000000010';
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'terminal_not_reopened');
update public.catalog_file_audio_validation_jobs set state='queued';
select public.set_catalog_language_capture_rollout(1,500,'Synthetic second stage');
select public.set_catalog_language_capture_rollout(2,2000,'Synthetic third stage');
select public.set_catalog_language_capture_rollout(3,5000,'Synthetic fourth stage');
select public.set_catalog_language_capture_rollout(4,10000,'Synthetic final stage');
select public.rollout_assert(public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000001'),'all_owners_at_100_percent');
select public.rollout_assert(public.set_catalog_language_capture_rollout(5,0,'Synthetic emergency rollback')->>'revision'='6','rollback_direct_to_zero');
select public.rollout_assert(not public.catalog_language_capture_rollout_enabled_for_job('20000000-0000-4000-8000-000000000010'),'rollback_stops_membership');
select public.rollout_assert((select previous_basis_points=10000 and basis_points=0 from public.catalog_language_capture_rollout_events where revision=6),'audit_records_rollback');
select public.rollout_assert(not exists((select * from public.catalog_file_audio_validation_jobs except select * from public.fixture_job_before)
 union all (select * from public.fixture_job_before except select * from public.catalog_file_audio_validation_jobs)),'no_job_mutation');
insert into public.fixture_pilot values('20000000-0000-4000-8000-000000000001');
select public.rollout_assert(public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000001'),'existing_pilot_preserved');
update public.fixture_global set enabled=true;
select public.rollout_assert(public.catalog_language_capture_pipeline_enabled_for_job('20000000-0000-4000-8000-000000000010'),'existing_global_preserved');
select json_build_object('checks',count(*)) from public.capture_rollout_checks;
