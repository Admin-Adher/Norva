-- Networkless synthetic fixture; exact installed RPCs, no provider/model I/O.
create table public.quota_proof_checks(label text primary key);
create function public.quota_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'quota_fixture_%',label; end if;
  insert into public.quota_proof_checks values(label);
end $$;
insert into auth.users(id) values('00000000-0000-0000-0000-000000000001');
insert into public.cloud_user_catalog_visibility_epochs(user_id,visibility_epoch)
select id,1 from auth.users;
insert into public.admin_feature_flags(key,enabled) values('audio_lid_enabled',true),('enrichment_paused',false),('automatic_vod_language_fleet_enabled',true);
do $$
declare u uuid:='00000000-0000-0000-0000-000000000001'; s uuid; g uuid; v uuid; k uuid; t uuid; p jsonb; at timestamptz:=clock_timestamp(); n int;
begin
 for n in 1..5 loop
  s:=('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  g:=('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  k:=('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  insert into public.cloud_sources(id,user_id,enabled,sync_status,source_type) values(s,u,true,'ready','xtream');
  insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id) values(s,u,g);
  insert into public.cloud_source_lifecycle(source_id,user_id,config_revision,visibility_epoch) values(s,u,1,1);
  insert into public.catalog_source_provider_identities(source_id,user_id,identity_id,verified_at) values(s,u,k,at);
 end loop;
 for n in 1..65 loop
  s:=('10000000-0000-0000-0000-'||lpad((1+(n-1)%5)::text,12,'0'))::uuid;
  g:=('20000000-0000-0000-0000-'||lpad((1+(n-1)%5)::text,12,'0'))::uuid;
  v:=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  t:=('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  insert into public.cloud_titles(id,user_id,item_type) values(t,u,'movie');
  p:=jsonb_build_object('container','mp4','probeSource','gateway_probe','probedAt',at,
    'videoCodec','h264','audioCodec','aac',
    'metadataComplete',true,'durationSeconds',1200,'fileSizeBytes',1000000,
    'audioTracks','[{"index":0,"codec":"aac","lang":null}]'::jsonb,'subtitles','[]'::jsonb);
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,item_type,external_id,codec_profile,title_id)
    values(v,u,s,g,'movie',n::text,p,t);
  perform public.observe_catalog_file_profile(u,s,v,'movie',n::text,repeat('a',64),p,p->'audioTracks','[]',true,true);
 end loop;
end $$;
create function public.quota_start(n integer,manual boolean default false) returns jsonb language plpgsql as $$
declare v public.cloud_title_variants%rowtype; k text; p jsonb;
begin
 select * into strict v from public.cloud_title_variants where external_id=n::text;
 select identity_id::text into k from public.catalog_source_provider_identities where source_id=v.source_id;
 p:=v.codec_profile;
 if manual then return public.start_catalog_file_audio_validation_job(v.user_id,v.source_id,v.id,k,v.external_id,
    array[0],repeat('a',64),(p->>'probedAt')::timestamptz,1000000,p->'audioTracks'); end if;
 return public.start_automatic_catalog_file_audio_validation_job(v.user_id,v.source_id,v.id,k,'movie',v.external_id,
    array[0],p,repeat('a',64),(p->>'probedAt')::timestamptz,1000000,p->'audioTracks',false);
end $$;
do $$
declare n int;r jsonb;j uuid; before_attempt int; k text; q jsonb;
begin
 perform public.quota_assert((public.quota_start(1)->>'code')='LANGUAGE_AUTOMATIC_ADMISSION_PAUSED','automatic_default_paused');
 update public.admin_feature_flags set enabled=true where key='adaptive_language_admission_enabled';
 for n in 1..25 loop
  r:=public.quota_start(n); j:=(r->>'jobId')::uuid;
  if j is null then raise exception 'automatic_job_%_not_admitted',n; end if;
  update public.catalog_file_audio_validation_jobs set state='verified',retry_at=null where id=j;
 end loop;
 perform public.quota_assert((select count(*)=25 from public.catalog_file_audio_validation_jobs where request_origin='automatic'),'automatic_exceeds_twenty');
 r:=public.quota_start(26,true);j:=(r->>'jobId')::uuid;
 perform public.quota_assert(j is not null,'automatic_does_not_spend_manual_quota');
 perform public.quota_assert((select request_origin='manual' from public.catalog_file_audio_validation_jobs where id=j),'manual_origin_server_assigned');
 r:=public.quota_start(27);
 perform public.quota_assert(r->>'jobId' is not null,'automatic_pending_independent_of_manual');
 r:=public.quota_start(28,true);
 perform public.quota_assert(r->>'jobId' is not null,'two_manual_admissions');
 perform public.quota_assert((select state='retry_wait' from public.catalog_file_audio_validation_jobs where external_id='27'),'manual_does_not_reset_automatic_queue');
 perform public.quota_assert(public.quota_start(30,true)->>'code'='LANGUAGE_VALIDATION_CONCURRENCY_LIMIT','manual_active_quota_preserved');
 update public.catalog_file_audio_validation_jobs set state='verified' where request_origin='manual';
 insert into public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,state,request_origin)
 select gen_random_uuid(),'00000000-0000-0000-0000-000000000001','fixture-manual','movie','manual-history-'||gs.value,'failed','manual' from generate_series(1,18)gs(value);
 perform public.quota_assert(public.quota_start(30,true)->>'code'='LANGUAGE_VALIDATION_RATE_LIMITED','manual_daily_quota_preserved');
 perform public.quota_assert(public.quota_start(29)->>'jobId' is not null,'manual_twenty_does_not_block_automatic');
 k:='40000000-0000-0000-0000-000000000004';
 insert into public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,state,request_origin)
 select gen_random_uuid(),'00000000-0000-0000-0000-000000000001',k,'movie','pending-'||gs.value,'retry_wait','automatic' from generate_series(1,3)gs(value);
 perform public.quota_assert(not public.catalog_language_queue_available(k),'per_provider_buffer_bounded');
 perform public.quota_assert(public.catalog_language_queue_available('another-provider'),'other_provider_not_tenant_blocked');
 perform public.quota_assert(public.quota_start(34)->>'code'='LANGUAGE_AUTOMATIC_QUEUE_FULL','automatic_start_enforces_buffer');
 update public.catalog_file_audio_validation_jobs set state='verified' where state='retry_wait';
 insert into public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,state,request_origin)
 select gen_random_uuid(),'00000000-0000-0000-0000-000000000001','buffer-provider-'||gs.value,'movie','buffer-'||gs.value,'retry_wait','automatic' from generate_series(1,32)gs(value);
 perform public.quota_assert(not public.catalog_language_queue_available('fresh-provider'),'global_buffer_bounded');
 update public.catalog_file_audio_validation_jobs set state='verified' where state='retry_wait';

 r:=public.quota_start(49);j:=(r->>'jobId')::uuid;
 perform public.quota_assert(public.claim_catalog_file_audio_validation_job(j,'fixture',300) is null,'missing_capacity_fails_closed');
 perform public.quota_assert(public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp()),'fresh_capacity_accepted');
 perform public.quota_assert(public.report_catalog_language_capacity(2,'capacity-available',
   (select observed_at from public.catalog_language_capacity)),'identical_capacity_replay_idempotent');
 perform public.quota_assert(not public.report_catalog_language_capacity(2,'capacity-available',
   (select observed_at-interval '1 millisecond' from public.catalog_language_capacity)),'out_of_order_capacity_rejected');
 perform public.quota_assert(not public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp()-interval '1 minute'),'stale_capacity_rejected');
 perform public.quota_assert(not public.report_catalog_language_capacity(3,'capacity-available',clock_timestamp()),'ceiling_not_client_increasable');
 r:=public.claim_catalog_file_audio_validation_job(j,'fixture',300);
 perform public.quota_assert(r->>'jobId' is not null,'first_worker_claimed');
 q:=public.quota_start(50);
 perform public.quota_assert(public.claim_catalog_file_audio_validation_job((q->>'jobId')::uuid,'fixture2',300)->>'jobId' is not null,'second_worker_claimed');
 q:=public.quota_start(51);
 perform public.quota_assert(public.claim_catalog_file_audio_validation_job((q->>'jobId')::uuid,'fixture3',300) is null,'third_worker_deferred');
 perform public.quota_assert((select attempt_count=0 from public.catalog_file_audio_validation_jobs where id=(q->>'jobId')::uuid),'capacity_does_not_spend_attempt');
 perform public.quota_assert(not public.catalog_language_execution_available(),'running_jobs_consume_slots');
 perform public.report_catalog_language_capacity(0,'viewer-priority',clock_timestamp());
 perform public.quota_assert(public.claim_catalog_file_audio_validation_job(j,'fixture',300)->>'jobId' is not null,'current_lease_renewal_remains_possible');
 update public.catalog_file_audio_validation_jobs set state='retry_wait',lease_owner=null,lease_expires_at=null,retry_at=now()+interval '1 hour' where state='running';
 perform public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp());
 perform public.quota_assert(public.catalog_language_execution_available(),'retry_wait_does_not_consume_execution_slots');
 update public.catalog_language_capacity set expires_at=now()-interval '1 second';
 perform public.quota_assert(not public.catalog_language_execution_available(),'expired_sample_fails_closed');
 perform public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp());
 q:=public.claim_catalog_vod_language_file('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003');
 perform public.quota_assert(q->>'variantId' is not null,'intake_ignores_manual_daily_limit');
 update public.catalog_file_audio_validation_jobs set state='running',lease_owner='fixture',lease_expires_at=now()+interval '1 minute' where id=j;
 perform public.quota_assert(not public.catalog_language_execution_available(),'probe_and_strict_share_execution_ceiling');
 update public.catalog_vod_language_intake set state='deferred',lease_until=null,lease_token=null,next_attempt_at=now()+interval '1 hour';
 update public.catalog_file_audio_validation_jobs set state='verified',lease_owner=null,lease_expires_at=null where state in ('retry_wait','running');
 for n in 55..58 loop perform public.quota_start(n); end loop;
 -- A quarantined row must never be dispatched, even if an inconsistent state
 -- is injected into this synthetic database (production quarantine stays failed).
 update public.catalog_file_audio_validation_jobs set quarantined_at=now() where external_id='58';
 perform public.quota_assert(not exists(select 1 from public.list_due_catalog_file_audio_validation_jobs(4) d
   join public.catalog_file_audio_validation_jobs j on j.id=d.job_id where j.external_id='58'),'quarantine_not_dispatched');
 update public.catalog_file_audio_validation_jobs set state='failed' where external_id='58';
 perform public.quota_start(59);
end $$;

select public.quota_assert(not has_table_privilege('authenticated','public.catalog_language_capacity','SELECT'),'capacity_table_private');
select public.quota_assert(not has_function_privilege('anon','public.report_catalog_language_capacity(integer,text,timestamptz)','EXECUTE'),'capacity_report_not_anon');
select public.quota_assert(not has_function_privilege('authenticated','public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)','EXECUTE'),'automatic_start_service_only');
select public.quota_assert(has_function_privilege('service_role','public.report_catalog_language_capacity(integer,text,timestamptz)','EXECUTE'),'capacity_report_service_role');
