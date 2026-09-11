-- This file runs only against the isolated synthetic PostgreSQL fixture.
select public.metadata_assert(not public.selection_audio_parallel_capture_enabled(),'selection_parallel_default_off');
select public.metadata_assert(not has_function_privilege('anon','public.selection_audio_parallel_capture_enabled()','EXECUTE')
  and not has_function_privilege('authenticated','public.selection_audio_parallel_capture_enabled()','EXECUTE'),'selection_parallel_private');

do $$
declare u uuid:='00000000-0000-0000-0000-000000000001'; s uuid; g uuid; m uuid; h text;
  ext text; url text; url_hash text; first_job jsonb; second_job jsonb; third_job jsonb; i integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  h:=encode(sha256(convert_to('norva-selection-curated-v1:'||u::text,'UTF8')),'hex');
  s:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;
  select active_generation_id into g from public.cloud_source_catalog_heads where source_id=s;
  for i in 1..10 loop
    ext:='norva-selection:movie:'||repeat('e',62)||lpad(i::text,2,'0');
    url:='https://fixture.invalid/parallel-'||i||'.mp4';
    url_hash:=encode(sha256(convert_to(url,'UTF8')),'hex'); m:=gen_random_uuid();
    insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,available,playback_hint)
      values(m,u,s,g,'movie',true,jsonb_build_object('targetUrl',url));
    insert into public.cloud_title_variants(id,user_id,source_id,generation_id,media_item_id,item_type,external_id,playback_hint)
      values(gen_random_uuid(),u,s,g,m,'movie',ext,jsonb_build_object('targetUrl',url));
    insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,priority,profile,progress)
      values(ext,url_hash,case when i=10 then 'failed' else 'queued' end,case when i=10 then 8 else 0 end,
        1000-i,'{"fingerprint":"retained-fixture-profile"}','{"trackPosition":1,"receipts":["retained"]}');
  end loop;
  first_job:=public.claim_selection_audio_job();
  perform public.metadata_assert(first_job is not null and first_job->'progress'->>'trackPosition'='1','selection_parallel_claim_preserves_cursor');
  perform public.metadata_assert(public.claim_selection_audio_job() is null,'selection_parallel_disabled_one_work_lease');
  update public.admin_feature_flags set enabled=true where key='selection_parallel_capture_enabled';
  perform public.metadata_assert(public.selection_audio_parallel_capture_enabled(),'selection_parallel_explicit_flags');
  second_job:=public.claim_selection_audio_job();
  perform public.metadata_assert(second_job is not null and second_job->>'id'<>first_job->>'id','selection_parallel_two_distinct_files');
  perform public.metadata_assert(public.claim_selection_audio_job() is null,'selection_parallel_hard_two_work_leases');
  update public.admin_feature_flags set enabled=false where key='language_capture_pipeline_enabled';
  perform public.metadata_assert(not public.selection_audio_parallel_capture_enabled(),'selection_parallel_requires_capture_runtime_flag');
  update public.admin_feature_flags set enabled=true where key='language_capture_pipeline_enabled';
  update public.catalog_selection_audio_jobs set lease_until=clock_timestamp()-interval '1 second',attempt_count=8
    where id=(first_job->>'id')::uuid;
  third_job:=public.claim_selection_audio_job();
  perform public.metadata_assert(third_job is not null and third_job->>'id'<>first_job->>'id','selection_parallel_expired_terminal_not_reclaimed');
  perform public.metadata_assert((select state='failed' and attempt_count=8 from public.catalog_selection_audio_jobs
    where id=(first_job->>'id')::uuid),'selection_parallel_terminal_ceiling_retained');
  perform public.metadata_assert((select state='running' and lease_token=(second_job->>'lease_token')::uuid
    from public.catalog_selection_audio_jobs where id=(second_job->>'id')::uuid),'selection_parallel_other_owner_lease_untouched');
  perform public.metadata_assert((select state='failed' and attempt_count=8 from public.catalog_selection_audio_jobs
    where external_id='norva-selection:movie:'||repeat('e',62)||'10'),'selection_parallel_old_failures_untouched');
  -- Release only these synthetic rows for the separate real concurrent-client
  -- race. Four queued synthetic files remain with real valid owner lookups.
  update public.catalog_selection_audio_jobs set state='completed',lease_token=null,lease_until=null
    where id in ((second_job->>'id')::uuid,(third_job->>'id')::uuid);
end $$;
