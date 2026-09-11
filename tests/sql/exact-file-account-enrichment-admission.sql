-- Isolated synthetic rows only; no provider network access or production writes.
select public.metadata_assert(not public.catalog_language_exact_file_admission_enabled(),'exact_admission_default_off');
select public.metadata_assert(not has_function_privilege('anon','public.claim_provider_exact_file_probe(text,text,text,text,text,integer)','EXECUTE')
  and not has_table_privilege('authenticated','public.provider_exact_file_probe_leases','SELECT')
  and not has_table_privilege('service_role','public.provider_exact_file_probe_leases','INSERT'),'exact_admission_service_rpc_only');
select public.metadata_assert((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='public.provider_exact_file_probe_leases'::regclass),'exact_admission_forced_rls');

do $$
declare a text:=repeat('1',64); b text:=repeat('2',64); c text:=repeat('3',64); d text:=repeat('4',64);
  j uuid:=gen_random_uuid(); one uuid:=gen_random_uuid(); two uuid:=gen_random_uuid(); token uuid:=gen_random_uuid();
  saved uuid; old_quarantine text; template jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.metadata_assert(public.claim_provider_account_language_validation(a,'exact-a',180),'exact_account_claim_a');
  perform public.metadata_assert(public.claim_provider_account_language_validation(b,'exact-b',180),'exact_account_claim_b');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','1',a,'exact-a',180),'exact_flag_enforced');
  update public.admin_feature_flags set enabled=true where key='language_exact_file_admission_enabled';
  perform public.metadata_assert(public.catalog_language_exact_file_admission_enabled(),'exact_flag_enabled');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','1',c,'not-owner',180),'exact_requires_owned_account');
  perform public.metadata_assert(public.claim_provider_file_probe('exact-fixture','legacy',180),'exact_legacy_can_claim_first');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','1',a,'exact-a',180),'exact_respects_legacy_lease');
  perform public.release_provider_file_probe('exact-fixture','legacy');
  perform public.metadata_assert(public.claim_provider_exact_file_probe('exact-fixture','movie','1',a,'exact-a',180),'exact_file_a_claim');
  perform public.metadata_assert(public.claim_provider_exact_file_probe('exact-fixture','movie','2',b,'exact-b',180),'exact_distinct_accounts_parallel');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','3',a,'exact-a',180),'exact_same_account_no_second_file');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','1',b,'exact-b',180),'exact_same_file_no_duplicate_across_accounts');
  perform public.metadata_assert(not public.claim_provider_file_probe('exact-fixture','older-worker',180),'exact_blocks_rolling_legacy_crawler');
  perform public.metadata_assert(not public.release_provider_exact_file_probe('exact-fixture','movie','1','wrong-owner'),'exact_release_cas');
  perform public.metadata_assert(public.claim_provider_exact_file_probe('exact-fixture','movie','1',a,'exact-a',180),'exact_owned_renewal');
  perform public.metadata_assert((select e.expires_at<=l.expires_at from public.provider_exact_file_probe_leases e
    join public.provider_account_language_validation_leases l using(provider_account_hash) where e.provider_account_hash=a),'exact_lifetime_bounded_by_account');
  update public.provider_account_language_validation_leases set lease_owner='new-account-owner' where provider_account_hash=a;
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','1',a,'exact-a',180),'exact_lost_account_cannot_renew');
  perform public.metadata_assert(not public.claim_provider_account_language_validation(b,'other-b',180),'exact_account_claim_still_mono');
  perform public.metadata_assert(public.claim_provider_account_language_validation(c,'exact-c',180),'exact_third_account_available');
  insert into public.cloud_playback_sessions(id,user_id,source_id,provider_account_hash,status,expires_at)
    values(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',c,'pending',clock_timestamp()+interval '10 minutes');
  perform public.metadata_assert(not public.claim_provider_exact_file_probe('exact-fixture','movie','3',c,'exact-c',180),'exact_pending_viewer_wins');
  perform public.metadata_assert(not public.claim_provider_account_language_validation(c,'viewer-race',180),'exact_real_account_gate_respects_viewer');

  select to_jsonb(job),md5(to_jsonb(job)::text) into template,old_quarantine from public.catalog_file_audio_validation_jobs job where external_id='55';
  insert into public.catalog_file_audio_validation_jobs select (jsonb_populate_record(null::public.catalog_file_audio_validation_jobs,
    template||jsonb_build_object('id',j,'identity_key','exact-fixture','external_id','handoff','state','running',
      'lease_owner','exact-job','lease_expires_at',clock_timestamp()+interval '5 minutes','quarantined_at',null,
      'provider_attempt_token',token,'provider_attempt_started_at',clock_timestamp()))).*;
  perform public.metadata_assert(public.claim_provider_account_language_validation(d,'exact-d',180),'exact_handoff_account_claim');
  perform public.metadata_assert(public.claim_provider_exact_file_probe('exact-fixture','movie','handoff',d,'exact-d',180),'exact_handoff_file_claim');
  saved:=public.checkpoint_catalog_file_audio_capture(j,'exact-job',1,1,repeat('a',64),repeat('b',64),repeat('c',64),
    clock_timestamp()+interval '30 minutes',d,'exact-d',token);
  perform public.metadata_assert(saved is not null,'exact_capture_atomic_handoff');
  perform public.metadata_assert(not exists(select 1 from public.provider_exact_file_probe_leases where external_id='handoff')
    and not exists(select 1 from public.provider_account_language_validation_leases where provider_account_hash=d),'exact_capture_releases_own_two_leases');
  perform public.metadata_assert((select count(*)=2 from public.provider_exact_file_probe_leases where identity_key='exact-fixture'),'exact_handoff_retains_other_files');
  perform public.metadata_assert((select md5(to_jsonb(job)::text)=old_quarantine from public.catalog_file_audio_validation_jobs job
    where external_id='55'),'exact_quarantined_job_unchanged');

  insert into public.catalog_file_audio_validation_jobs select (jsonb_populate_record(null::public.catalog_file_audio_validation_jobs,
    template||jsonb_build_object('id',one,'identity_key','exact-due-fixture','external_id','due-one','source_id','10000000-0000-0000-0000-000000000001',
      'state','queued','request_origin','manual','created_at','2000-01-01T00:00:00Z','retry_at','2000-01-01T00:00:00Z',
      'lease_owner',null,'lease_expires_at',null,'quarantined_at',null))).*;
  insert into public.catalog_file_audio_validation_jobs select (jsonb_populate_record(null::public.catalog_file_audio_validation_jobs,
    template||jsonb_build_object('id',two,'identity_key','exact-due-fixture','external_id','due-two','source_id','10000000-0000-0000-0000-000000000002',
      'state','queued','request_origin','manual','created_at','2000-01-01T00:00:00Z','retry_at','2000-01-01T00:00:00Z',
      'lease_owner',null,'lease_expires_at',null,'quarantined_at',null))).*;
  perform public.metadata_assert((select count(*)=2 from public.list_due_catalog_file_audio_validation_jobs(4) where job_id in (one,two)),'exact_dispatch_distinct_sources');
  update public.admin_feature_flags set enabled=false where key='language_exact_file_admission_enabled';
  perform public.metadata_assert((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(4) where job_id in (one,two)),'exact_dispatch_old_default_preserved');
  perform public.metadata_assert(not public.claim_provider_file_probe('exact-fixture','disabled-worker',180),'exact_disabled_flag_does_not_erase_live_leases');
  update public.admin_feature_flags set enabled=true where key='language_exact_file_admission_enabled';
  update public.catalog_file_audio_validation_jobs set state='running',lease_expires_at=clock_timestamp()+interval '1 minute' where id=one;
  perform public.metadata_assert((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(4) where job_id=two),'exact_dispatch_other_source_while_one_running');
  perform public.release_provider_exact_file_probe('exact-fixture','movie','1','exact-a');
  perform public.release_provider_exact_file_probe('exact-fixture','movie','2','exact-b');
  perform public.metadata_assert(public.claim_provider_file_probe('exact-fixture','after-drain',180),'exact_legacy_resumes_after_drain');
  perform public.release_provider_file_probe('exact-fixture','after-drain');
end $$;
