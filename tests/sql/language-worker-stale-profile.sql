-- Schema-only networkless PostgreSQL; every synthetic row rolls back.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1));
insert into cloud_sources(id,user_id,source_type,sync_status,display_name) values(pg_temp.uid(2),pg_temp.uid(1),'xtream','ready','Synthetic');
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 values(pg_temp.uid(3),pg_temp.uid(1),'movie','fixture','normalized','Synthetic');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title)
 select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(3),pg_temp.uid(2),pg_temp.uid(4),'movie',n::text,'Synthetic' from generate_series(101,110)n;
insert into catalog_file_tracks(server_host,item_type,external_id,observed_profile_fingerprint,observed_profile_probed_at,observed_profile_snapshot)
 select 'fixture','movie',n::text,repeat('a',64),'2026-10-03T10:00Z',
 '{"durationSeconds":300,"fileSizeBytes":1000000,"audioTracks":[{"index":0,"lang":null}]}'::jsonb
 from generate_series(101,110)n;
insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,queue_expires_at,retry_at,request_origin,attempt_count,provider_attempt_count)
 select pg_temp.uid(1000+n),pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(n),'fixture','movie',n::text,
 array[0],repeat('a',64),'{"durationSeconds":300,"fileSizeBytes":1000000,"audioTracks":[{"index":0,"lang":null}]}'::jsonb,
 '2026-10-03T10:00Z',1000000,'[{"index":0,"lang":null}]','retry_wait',null,now()-interval '1 hour','automatic',4,2
 from generate_series(101,110)n;
-- Four independent mismatches; then stale live/future/terminal/expired rows.
update catalog_file_audio_validation_jobs set profile_fingerprint=repeat('b',64) where external_id in ('101','105','106','107','108','109');
update catalog_file_audio_validation_jobs set profile_probed_at='2026-10-03T09:00Z' where external_id='102';
update catalog_file_audio_validation_jobs set profile_snapshot=profile_snapshot||'{"durationSeconds":301}' where external_id='103';
update catalog_file_audio_validation_jobs set file_size_bytes=999999 where external_id='104';
update catalog_file_audio_validation_jobs set state='running',lease_owner='active',lease_expires_at=now()+interval '5 minutes',retry_at=null where external_id='105';
update catalog_file_audio_validation_jobs set retry_at=now()+interval '1 hour' where external_id='106';
update catalog_file_audio_validation_jobs set state='failed',quarantined_at=now(),error_code='KEEP_QUARANTINE' where external_id='107';
update catalog_file_audio_validation_jobs set state='finalizing',lease_owner='expired',lease_expires_at=now()-interval '1 minute',retry_at=null,next_track_position=1,evidence='[{"language":"fr"}]' where external_id='108';
update catalog_file_audio_validation_jobs set state='queued',queue_expires_at=now()+interval '10 minutes',retry_at=null where external_id='109';
set local session_replication_role=origin;
create temp table cache_before as select * from catalog_file_tracks;
create temp table jobs_before as select * from catalog_file_audio_validation_jobs;
do $test$
declare n int; r jsonb; threw boolean:=false;
begin
 perform public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp());
 for n in 101..104 loop
  r:=public.claim_catalog_file_audio_validation_job(pg_temp.uid(1000+n),'test',300);
  perform pg_temp.ok(r is null,'stale_claim_returns_null_'||n);
  perform pg_temp.ok((select state='failed' and error_code='PROFILE_CHANGED' and attempt_count=4 and provider_attempt_count=2
   and lease_owner is null and lease_expires_at is null from catalog_file_audio_validation_jobs where id=pg_temp.uid(1000+n)), 'stale_retired_without_attempt_'||n);
 end loop;
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1105),'other',300) is null,'live_lease_not_stolen');
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1106),'test',300) is null,'future_retry_preserved');
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1107),'test',300) is null,'quarantine_preserved');
 perform pg_temp.ok(not exists(select 1 from catalog_file_audio_validation_jobs j join jobs_before b using(id)
  where j.external_id in ('105','106','107') and to_jsonb(j) is distinct from to_jsonb(b)),'protected_jobs_unchanged');
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1108),'test',300) is null,'expired_finalizer_retires');
 perform pg_temp.ok((select state='failed' and evidence='[{"language":"fr"}]'::jsonb and next_track_position=1 and attempt_count=4
  from catalog_file_audio_validation_jobs where external_id='108'),'finalizer_evidence_preserved');
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1109),'test',300) is null,'obsolete_queued_retires');
 perform pg_temp.ok((select state='failed' and queue_expires_at is null from catalog_file_audio_validation_jobs where external_id='109'),'queued_constraints_preserved');
 delete from catalog_language_capacity;
 perform pg_temp.ok(public.claim_catalog_file_audio_validation_job(pg_temp.uid(1110),'test',300) is null,'valid_job_still_requires_capacity');
 perform pg_temp.ok((select state='retry_wait' and attempt_count=4 from catalog_file_audio_validation_jobs where external_id='110'),'capacity_does_not_consume_attempt');
 -- Release the synthetic active lease and provide one real capacity sample.
 update catalog_file_audio_validation_jobs set state='retry_wait',lease_owner=null,lease_expires_at=null,retry_at=now()+interval '1 hour' where external_id='105';
 perform public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp());
 r:=public.claim_catalog_file_audio_validation_job(pg_temp.uid(1110),'test',300);
 perform pg_temp.ok(r->>'jobId'=pg_temp.uid(1110)::text,'valid_job_claims_normally');
 perform pg_temp.ok((select state='running' and attempt_count=5 and provider_attempt_count=2 from catalog_file_audio_validation_jobs where external_id='110'),'valid_claim_accounting_preserved');
 perform pg_temp.ok(not exists(select 1 from catalog_file_tracks c full join cache_before b using(server_host,item_type,external_id)
  where to_jsonb(c) is distinct from to_jsonb(b)),'cache_and_certificate_never_modified');
 begin
  update catalog_file_audio_validation_jobs set state='running',lease_owner='bad',lease_expires_at=now()+interval '1 minute' where external_id='101';
 exception when sqlstate 'PT409' then threw:=true; end;
 perform pg_temp.ok(threw,'observed_profile_trigger_remains_enforced');
 perform pg_temp.ok(not has_function_privilege('authenticated','public.claim_catalog_file_audio_validation_job(uuid,text,integer)','EXECUTE'),'claim_not_public');
end $test$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
