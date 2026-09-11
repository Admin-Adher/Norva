-- Synthetic rows only, run by the networkless PostgreSQL proof harness.
create table public.metadata_proof_checks(label text primary key);
create function public.metadata_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'metadata_fixture_%',label; end if;
  insert into public.metadata_proof_checks values(label);
end $$;

do $$
declare token uuid:=gen_random_uuid(); v_external text:='norva-selection:movie:'||repeat('a',64); url_hash text:=repeat('b',64);
begin
 insert into public.catalog_selection_audio_jobs(external_id,url_sha256,state,lease_token,lease_until,attempt_count,profile,progress)
   values(v_external,url_hash,'running',token,clock_timestamp()+interval '5 minutes',7,'{"fixture":true}', '{"receipts":["fixture"]}');
 perform public.metadata_assert(not public.defer_selection_audio_admission(v_external,url_hash,gen_random_uuid()),'selection_defer_wrong_token');
 perform public.metadata_assert(public.defer_selection_audio_admission(v_external,url_hash,token),'selection_local_defer');
 perform public.metadata_assert((select attempt_count=6 and state='retry_wait' and lease_token is null
    and profile='{"fixture":true}'::jsonb and progress='{"receipts":["fixture"]}'::jsonb
    from public.catalog_selection_audio_jobs j where j.external_id=v_external and j.url_sha256=url_hash),'selection_progress_and_real_retry_budget_preserved');
 perform public.metadata_assert(not public.defer_selection_audio_admission(v_external,url_hash,token),'selection_defer_not_replayable');
 update public.catalog_selection_audio_jobs set state='failed',completed_at=clock_timestamp(),attempt_count=8 where url_sha256=url_hash;
 perform public.metadata_assert(not public.defer_selection_audio_admission(v_external,url_hash,token),'selection_terminal_failure_not_revived');
end $$;
select public.metadata_assert(not has_function_privilege('authenticated','public.defer_selection_audio_admission(text,text,uuid)','EXECUTE'),'selection_defer_private');

select public.metadata_assert(not public.catalog_language_metadata_lane_enabled(),'default_disabled');
select public.metadata_assert(not public.catalog_language_metadata_available(),'missing_capacity_fails_closed');
select public.metadata_assert(not public.report_catalog_language_metadata_capacity(3,'capacity-available',clock_timestamp()),'no_unsigned_ceiling_increase');
select public.metadata_assert(not public.report_catalog_language_metadata_capacity(2,'capacity-available',clock_timestamp()-interval '1 minute'),'stale_report_rejected');
select public.metadata_assert(not public.report_catalog_language_metadata_capacity(2,'capacity-available',clock_timestamp()+interval '1 minute'),'future_report_rejected');
select public.metadata_assert(not public.report_catalog_language_metadata_capacity(2,'unsafe-provider-text',clock_timestamp()),'closed_reason_vocabulary');
select public.metadata_assert(public.report_catalog_language_metadata_capacity(2,'capacity-available',clock_timestamp()),'fresh_report');
select public.metadata_assert(public.report_catalog_language_metadata_capacity(2,'capacity-available',(select observed_at from public.catalog_language_metadata_capacity)),'idempotent_report');
select public.metadata_assert(not public.report_catalog_language_metadata_capacity(0,'viewer-priority',(select observed_at-interval '1 millisecond' from public.catalog_language_metadata_capacity)),'old_report_cannot_replace_fresh');

do $$
declare u uuid:='00000000-0000-0000-0000-000000000001'; s uuid; g uuid; v uuid; k uuid; t uuid; n int;
begin
 for n in 91..96 loop
  s:=('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  g:=('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  v:=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  k:=('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  t:=('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
  insert into public.cloud_sources(id,user_id,enabled,sync_status,source_type) values(s,u,true,'ready','xtream');
  insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id) values(s,u,g);
  insert into public.cloud_source_lifecycle(source_id,user_id,config_revision,visibility_epoch) values(s,u,1,1);
  insert into public.catalog_source_provider_identities(source_id,user_id,identity_id,verified_at) values(s,u,k,clock_timestamp());
  insert into public.cloud_titles(id,user_id,item_type) values(t,u,'movie');
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,item_type,external_id,title_id)
    values(v,u,s,g,'movie',n::text,t);
 end loop;
end $$;

do $$
declare u uuid:='00000000-0000-0000-0000-000000000001'; q jsonb; first_claim jsonb; before_expiry timestamptz;
begin
 perform public.report_catalog_language_capacity(0,'background-occupied',clock_timestamp());
 q:=public.claim_catalog_vod_language_file(u,'10000000-0000-0000-0000-000000000091');
 perform public.metadata_assert(q->>'skipped'='server-capacity','flag_off_preserves_legacy_admission');
 update public.admin_feature_flags set enabled=true where key='language_metadata_lane_enabled';
 -- Strict work remains full, with both two active workers and a full buffer.
 update public.catalog_file_audio_validation_jobs set state='running',lease_owner='fixture-busy',lease_expires_at=now()+interval '10 minutes'
   where external_id in ('55','56');
 insert into public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,state,request_origin)
 select gen_random_uuid(),u,'full-buffer-'||n,'movie','full-buffer-'||n,'retry_wait','automatic' from generate_series(1,32) n;
 perform public.metadata_assert(not public.catalog_language_queue_available('another-provider'),'strict_buffer_full');
 perform public.metadata_assert(not public.catalog_language_execution_available(),'strict_workers_full');
 first_claim:=public.claim_catalog_vod_language_file(u,'10000000-0000-0000-0000-000000000091');
 perform public.metadata_assert(first_claim->>'variantId' is not null,'metadata_survives_strict_buffer_and_cpu_backpressure');
 q:=public.claim_catalog_vod_language_file(u,'10000000-0000-0000-0000-000000000092');
 perform public.metadata_assert(q->>'variantId' is not null,'second_metadata_slot');
 q:=public.claim_catalog_vod_language_file(u,'10000000-0000-0000-0000-000000000093');
 perform public.metadata_assert(q->>'skipped'='metadata-capacity','third_metadata_slot_rejected');
 perform public.metadata_assert(not exists(select 1 from public.catalog_vod_language_intake where external_id='93'),'no_retry_spent_on_capacity');
 perform public.metadata_assert(public.finish_catalog_vod_language_file(u,'10000000-0000-0000-0000-000000000091',
   (first_claim->>'variantId')::uuid,(first_claim->>'leaseToken')::uuid,'identified','declared-track-languages',true),'normal_finish_releases_metadata_claim');
 perform public.metadata_assert(public.catalog_language_metadata_available(),'finished_claim_restores_lane');
 perform public.report_catalog_language_metadata_capacity(0,'viewer-priority',clock_timestamp());
 perform public.metadata_assert(not public.catalog_language_metadata_available(),'viewer_stops_new_metadata');
 select expires_at into before_expiry from public.catalog_language_metadata_capacity;
 perform public.report_catalog_language_metadata_capacity(0,'viewer-priority',(select observed_at from public.catalog_language_metadata_capacity));
 perform public.metadata_assert((select expires_at=before_expiry from public.catalog_language_metadata_capacity),'replay_never_extends_freshness');
 update public.catalog_language_metadata_capacity set expires_at=now()-interval '1 second';
 perform public.metadata_assert(not public.catalog_language_metadata_available(),'expired_report');
 update public.catalog_vod_language_intake set state='deferred',lease_until=null,lease_token=null,next_attempt_at=now()+interval '1 hour';
 -- Leave four fresh sources for real concurrent claims in the harness.
end $$;

select public.metadata_assert((select relrowsecurity from pg_class where oid='public.catalog_language_metadata_capacity'::regclass),'new_table_rls');
select public.metadata_assert(not has_table_privilege('anon','public.catalog_language_metadata_capacity','SELECT') and
 not has_table_privilege('authenticated','public.catalog_language_metadata_capacity','INSERT'),'capacity_not_public');
select public.metadata_assert(not has_function_privilege('anon','public.catalog_language_metadata_available()','EXECUTE') and
 not has_function_privilege('authenticated','public.catalog_language_metadata_lane_enabled()','EXECUTE'),'lane_functions_private');
select public.metadata_assert(not has_function_privilege('authenticated','public.report_catalog_language_metadata_capacity(integer,text,timestamptz)','EXECUTE'),'client_cannot_report_capacity');
select public.metadata_assert(has_function_privilege('service_role','public.report_catalog_language_metadata_capacity(integer,text,timestamptz)','EXECUTE'),'service_can_report_capacity');

do $$
declare j uuid; token uuid:=gen_random_uuid(); result jsonb;
begin
 select id into j from public.catalog_file_audio_validation_jobs where external_id='55';
 update public.catalog_file_audio_validation_jobs set provider_attempt_token=token,provider_attempt_started_at=now(),
   consecutive_provider_no_progress_count=3 where id=j;
 result:=public.finish_catalog_file_audio_validation_provider_attempt(j,'wrong-owner',token,'admission_deferred',4);
 perform public.metadata_assert(result is null,'deferred_attempt_owner_cas');
 result:=public.finish_catalog_file_audio_validation_provider_attempt(j,'fixture-busy',gen_random_uuid(),'admission_deferred',4);
 perform public.metadata_assert(result is null,'deferred_attempt_token_cas');
 result:=public.finish_catalog_file_audio_validation_provider_attempt(j,'fixture-busy',token,'admission_deferred',4);
 perform public.metadata_assert(result->>'admissionDeferred'='true' and result->>'viewerPreempted'='false','capacity_not_misreported_as_viewer');
 perform public.metadata_assert((select consecutive_provider_no_progress_count=2 and provider_attempt_token is null
   from public.catalog_file_audio_validation_jobs where id=j),'only_current_no_io_strike_returned');
 perform public.metadata_assert(public.finish_catalog_file_audio_validation_provider_attempt(j,'fixture-busy',token,'admission_deferred',4) is null,'settlement_not_replayable');
 perform public.metadata_assert((select quarantined_at is not null from public.catalog_file_audio_validation_jobs where external_id='58'),'quarantine_unchanged');
end $$;
