-- Synthetic rows and actual installed identity/owner/service guard functions.
-- The common visibility view remains a documented fixture simplification.
select public.metadata_assert(not public.selection_audio_capture_pipeline_enabled(),'selection_capture_default_off');
select public.metadata_assert(not has_table_privilege('authenticated','public.catalog_selection_audio_captures','SELECT')
  and not has_table_privilege('anon','public.catalog_selection_audio_captures','INSERT'),'selection_capture_private');
select public.metadata_assert(not has_function_privilege('authenticated',
  'public.checkpoint_selection_audio_capture(text,text,uuid,integer,integer,text,text,timestamptz)','EXECUTE')
  and not has_function_privilege('anon','public.defer_selection_audio_capture(text,text,uuid)','EXECUTE'),'selection_capture_service_only');
select public.metadata_assert((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='public.catalog_selection_audio_captures'::regclass),'selection_capture_forced_rls');

create function public.selection_capture_fixture(token uuid,idx integer default 1,ord integer default 1,
  fp text default repeat('c',64),expiry timestamptz default clock_timestamp()+interval '30 minutes',
  url_digest text default encode(sha256(convert_to('https://fixture.invalid/a.mkv','UTF8')),'hex'))
returns uuid language sql as $$
 select public.checkpoint_selection_audio_capture('norva-selection:movie:'||repeat('4',64),url_digest,token,idx,ord,fp,repeat('d',64),expiry)
$$;

do $$
declare u uuid:='00000000-0000-0000-0000-000000000001'; s uuid; g uuid:=gen_random_uuid(); m uuid:=gen_random_uuid();
  job uuid; token uuid:=gen_random_uuid(); saved uuid; h text; ext text:='norva-selection:movie:'||repeat('4',64);
  url text:='https://fixture.invalid/a.mkv'; url_digest text; track_progress jsonb; deferred boolean;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  h:=encode(sha256(convert_to('norva-selection-curated-v1:'||u::text,'UTF8')),'hex');
  s:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;
  url_digest:=encode(sha256(convert_to(url,'UTF8')),'hex');
  insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,attempt_count,lease_token,lease_until,profile,progress)
  values(ext,url_digest,'running',3,token,clock_timestamp()+interval '5 minutes',
    jsonb_build_object('fingerprint',repeat('c',64),'externalId',ext,'urlSha256',url_digest,'durationSeconds',600,
      'audioTracks',jsonb_build_array(jsonb_build_object('index',1))),
    '{"trackPosition":0,"receipts":[],"tracks":[],"evidence":[]}'::jsonb) returning id into job;
  perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_flag_enforced');
  update public.admin_feature_flags set enabled=true where key='selection_capture_pipeline_enabled';
  perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_requires_current_owner');
  insert into public.cloud_sources(id,user_id,enabled,sync_status,source_type) values(s,u,true,'ready','m3u');
  insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id) values(s,u,g);
  insert into public.cloud_media_items(id,user_id,source_id,generation_id,item_type,available,playback_hint)
    values(m,u,s,g,'movie',true,jsonb_build_object('targetUrl',url));
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,media_item_id,item_type,external_id,playback_hint)
    values(gen_random_uuid(),u,s,g,m,'movie',ext,jsonb_build_object('targetUrl',url));
  perform public.metadata_assert(public.selection_capture_fixture(gen_random_uuid()) is null,'selection_capture_lease_cas');
  perform public.metadata_assert(public.selection_capture_fixture(token,2) is null,'selection_capture_track_cursor');
  perform public.metadata_assert(public.selection_capture_fixture(token,1,2) is null,'selection_capture_window_cursor');
  perform public.metadata_assert(public.selection_capture_fixture(token,1,1,repeat('f',64)) is null,'selection_capture_profile_fence');
  perform public.metadata_assert(public.selection_capture_fixture(token,1,1,repeat('c',64),clock_timestamp()-interval '1 second') is null,'selection_capture_expiry');
  perform public.metadata_assert(public.selection_capture_fixture(token,1,1,repeat('c',64),clock_timestamp()+interval '3 hours') is null,'selection_capture_retention_ceiling');
  perform public.metadata_assert(public.selection_capture_fixture(token,1,1,repeat('c',64),clock_timestamp()+interval '1 minute',repeat('0',64)) is null,'selection_capture_exact_url');
  saved:=public.selection_capture_fixture(token);
  perform public.metadata_assert(saved is not null,'selection_capture_committed');
  perform public.metadata_assert(public.selection_capture_fixture(token)=saved,'selection_capture_idempotent_resume');
  select progress into track_progress from public.catalog_selection_audio_jobs where id=job;
  perform public.metadata_assert((select state='running' and lease_token=token and attempt_count=3
    and progress=track_progress from public.catalog_selection_audio_jobs where id=job),'selection_capture_retains_work_lease_not_audio_vote');
  update public.cloud_media_items set available=false where id=m;
  perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_removed_media_owner');
  update public.cloud_media_items set available=true,generation_id=gen_random_uuid() where id=m;
  perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_generation_mismatch');
  update public.cloud_media_items set generation_id=g where id=m;
  update public.catalog_selection_audio_jobs set lease_until=clock_timestamp()-interval '1 second' where id=job;
  perform public.metadata_assert(public.selection_capture_fixture(token) is null,'selection_capture_expired_work_lease');
  update public.catalog_selection_audio_jobs set lease_until=clock_timestamp()+interval '1 minute' where id=job;
  perform public.metadata_assert(not public.defer_selection_audio_capture(ext,url_digest,gen_random_uuid()),'selection_capture_defer_cas');
  perform public.metadata_assert(public.defer_selection_audio_capture(ext,url_digest,token),'selection_capture_local_retry');
  perform public.metadata_assert((select state='retry_wait' and attempt_count=3 and progress=track_progress
    and next_attempt_at between clock_timestamp()+interval '20 seconds' and clock_timestamp()+interval '40 seconds'
    and lease_token is null from public.catalog_selection_audio_jobs where id=job),'selection_capture_retry_retains_progress_and_budget');
  update public.catalog_selection_audio_jobs set state='running',attempt_count=8,lease_token=token,lease_until=clock_timestamp()+interval '1 minute' where id=job;
  deferred:=public.defer_selection_audio_capture(ext,url_digest,token);
  perform public.metadata_assert(deferred
    and (select state='failed' and completed_at is not null and attempt_count=8 from public.catalog_selection_audio_jobs where id=job),'selection_capture_preserves_attempt_ceiling');
  perform public.metadata_assert(public.selection_capture_fixture(token) is null
    and not public.defer_selection_audio_capture(ext,url_digest,token),'selection_capture_terminal_not_revived');
  delete from public.catalog_selection_audio_jobs where id=job;
  perform public.metadata_assert(not exists(select 1 from public.catalog_selection_audio_captures where job_id=job),'selection_capture_job_cleanup');
end $$;
