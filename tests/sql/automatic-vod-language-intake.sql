-- Runs only against the operator's isolated, networkless PostgreSQL fixture.
-- Production function bodies are loaded by the proof operator; no real users,
-- provider credentials or media are copied into this fixture.
create table public.fleet_proof_checks(label text primary key);
create function public.fleet_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'fleet_fixture_%',label; end if;
  insert into public.fleet_proof_checks values(label);
end $$;

insert into auth.users(id) values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.cloud_sources(id,user_id,enabled,sync_status,source_type) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',true,'ready','m3u'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002',true,'ready','xtream');
insert into public.cloud_source_catalog_heads(source_id,user_id,active_generation_id) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');
insert into public.cloud_title_variants(id,user_id,source_id,generation_id,item_type,external_id)
 select ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','movie',n::text
 from generate_series(1,300) n;
insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at)
 select 'source:10000000-0000-0000-0000-000000000001','movie',n::text,'[{"index":0,"lang":"en"}]',now()
 from generate_series(1,270) n;
insert into public.admin_feature_flags(key,enabled) values('audio_lid_enabled',true),('enrichment_paused',false);

do $test$
declare
  u uuid:='00000000-0000-0000-0000-000000000001'; s uuid:='10000000-0000-0000-0000-000000000001';
  wrong uuid:='00000000-0000-0000-0000-000000000002'; r jsonb; r2 jsonb; v uuid; token uuid;
begin
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'skipped'='automatic-language-disabled','default_off');
  update public.admin_feature_flags set enabled=true where key='automatic_vod_language_fleet_enabled';
  r:=public.claim_catalog_vod_language_file(wrong,s);
  perform public.fleet_assert(r->>'skipped'='source-not-visible','wrong_owner_rejected');
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert((r->>'scanned')::int=256 and r->>'variantId' is null,'bounded_first_page');
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'itemId'='271','known_languages_skipped');
  perform public.fleet_assert(r->>'identityKey'='source:'||s::text,'unknown_provider_source_scope');
  v:=(r->>'variantId')::uuid; token:=(r->>'leaseToken')::uuid;
  r2:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r2->>'skipped'='intake-busy','single_active_intake');
  perform public.fleet_assert(not public.finish_catalog_vod_language_file(wrong,s,v,token,'identified','test',false),'wrong_ack_owner');
  perform public.fleet_assert(not public.finish_catalog_vod_language_file(u,s,v,gen_random_uuid(),'identified','test',false),'wrong_ack_token');
  perform public.fleet_assert(public.finish_catalog_vod_language_file(u,s,v,token,'identified','test',true),'correct_ack');
  perform public.fleet_assert(not public.finish_catalog_vod_language_file(u,s,v,token,'failed','test',true),'ack_not_repeatable');
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'itemId'='272','cursor_progresses');
  v:=(r->>'variantId')::uuid; token:=(r->>'leaseToken')::uuid;
  perform public.finish_catalog_vod_language_file(u,s,v,token,'failed','network-failure',true);
  perform public.fleet_assert((select state='deferred' and attempts=1 and next_attempt_at>now()+interval '59 minutes'
    from public.catalog_vod_language_intake where variant_id=v),'bounded_transport_backoff');
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'itemId'='273','failed_file_does_not_block_tail');
  v:=(r->>'variantId')::uuid;
  update public.catalog_vod_language_intake set lease_until=now()-interval '1 second',attempts=2 where variant_id=v;
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert((select state='failed' and attempts=3 from public.catalog_vod_language_intake where variant_id=v),'lost_lease_bounded');
  perform public.finish_catalog_vod_language_file(u,s,(r->>'variantId')::uuid,(r->>'leaseToken')::uuid,'queued','test',false);
  insert into public.catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,state,quarantined_at)
    values(gen_random_uuid(),u,s,'30000000-0000-0000-0000-000000000275','source:'||s::text,'movie','275','failed',now());
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'itemId'='276','quarantine_preserved');
  perform public.finish_catalog_vod_language_file(u,s,(r->>'variantId')::uuid,(r->>'leaseToken')::uuid,'queued','test',false);
  insert into public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,state)
    select gen_random_uuid(),u,'source:'||s::text,'movie','active-'||n,'running' from generate_series(1,2) n;
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'skipped'='language-quota','existing_active_budget_preserved');
  update public.catalog_file_audio_validation_jobs set state='verified' where state='running';
  update public.cloud_source_catalog_heads set active_generation_id='20000000-0000-0000-0000-000000000003' where source_id=s;
  insert into public.cloud_title_variants(id,user_id,source_id,generation_id,item_type,external_id) values
    ('30000000-0000-0000-0000-000000000901',u,s,'20000000-0000-0000-0000-000000000003','movie','future');
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'itemId'='future','future_import_discovered');
  perform public.finish_catalog_vod_language_file(u,s,(r->>'variantId')::uuid,(r->>'leaseToken')::uuid,'queued','test',false);
  update public.admin_feature_flags set enabled=true where key='enrichment_paused';
  r:=public.claim_catalog_vod_language_file(u,s);
  perform public.fleet_assert(r->>'skipped'='automatic-language-disabled','kill_switch_preserved');
end $test$;

-- An externally observed replacement is eligible again, but a clock tick on
-- unchanged bytes never resets an exhausted intake attempt.
do $test$
declare u uuid:='00000000-0000-0000-0000-000000000001'; s uuid:='10000000-0000-0000-0000-000000000001'; r jsonb;
begin
 update public.admin_feature_flags set enabled=false where key='enrichment_paused';
 update public.catalog_vod_language_intake set state='failed',attempts=3,profile_fingerprint=repeat('a',64)
 where external_id='future';
 insert into public.catalog_file_tracks(server_host,item_type,external_id,audio_tracks,audio_probed_at,observed_profile_fingerprint)
 values('source:'||s::text,'movie','future','[{"index":0,"lang":"und"}]',now(),repeat('a',64));
 update public.catalog_vod_language_sweeps set after_variant_id=null,next_scan_at=now() where source_id=s;
 r:=public.claim_catalog_vod_language_file(u,s);
 perform public.fleet_assert(r->>'variantId' is null,'unchanged_exhausted_file_not_retried');
 update public.catalog_file_tracks set observed_profile_fingerprint=repeat('b',64)
 where server_host='source:'||s::text and external_id='future';
 update public.catalog_vod_language_sweeps set after_variant_id=null,next_scan_at=now() where source_id=s;
 r:=public.claim_catalog_vod_language_file(u,s);
 perform public.fleet_assert(r->>'itemId'='future','replacement_with_unknown_language_reenters');
 perform public.fleet_assert((select attempts=0 from public.catalog_vod_language_intake where external_id='future'),'replacement_has_fresh_bounded_budget');
 perform public.finish_catalog_vod_language_file(u,s,(r->>'variantId')::uuid,(r->>'leaseToken')::uuid,'queued','test',false);
 delete from public.catalog_file_tracks where server_host='source:'||s::text and external_id='future';
end $test$;
select public.fleet_assert(not has_function_privilege('anon','public.claim_catalog_vod_language_file(uuid,uuid)','EXECUTE'),'anon_rpc_denied');
select public.fleet_assert(not has_function_privilege('authenticated','public.finish_catalog_vod_language_file(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE'),'authenticated_rpc_denied');
select public.fleet_assert(has_function_privilege('service_role','public.claim_catalog_vod_language_file(uuid,uuid)','EXECUTE'),'service_rpc_allowed');
select public.fleet_assert((select bool_and(relrowsecurity) from pg_class where relname in ('catalog_vod_language_sweeps','catalog_vod_language_intake')),'rls_enabled');
