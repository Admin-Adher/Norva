-- Synthetic rows, schema-only networkless PostgreSQL; all changes roll back.
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
insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,queue_expires_at,retry_at,request_origin,created_at,purge_after)
 select pg_temp.uid(1000+n),pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(n),'lane-'||n,'movie',n::text,
 array[0],repeat('a',64),'{}','2026-10-03T10:00Z',1000000,'[{"index":0,"lang":null}]',
 'retry_wait',null,now()-interval '2 hours','automatic',now()-interval '3 hours',now()+interval '1 day'
 from generate_series(101,110)n;
update catalog_file_audio_validation_jobs set state='finalizing',retry_at=null,lease_owner='expired',lease_expires_at=now()-interval '1 minute',next_track_position=1,evidence='[{"language":"fr"}]' where external_id='102';
update catalog_file_audio_validation_jobs set identity_key='lane-102',retry_at=now()-interval '3 hours' where external_id='103';
update catalog_file_audio_validation_jobs set retry_at=now()+interval '1 hour' where external_id in ('104','105');
update catalog_file_audio_validation_jobs set state='failed',quarantined_at=now(),error_code='KEEP_QUARANTINE' where external_id='106';
update catalog_file_audio_validation_jobs set state='finalizing',retry_at=null,lease_owner='active',lease_expires_at=now()+interval '5 minutes',next_track_position=1,evidence='[{"language":"fr"}]' where external_id='107';
update catalog_file_audio_validation_jobs set identity_key='lane-107' where external_id='108';
update catalog_file_audio_validation_jobs set state='finalizing',retry_at=null,lease_owner='expired',lease_expires_at=now()-interval '20 minutes' where external_id='109';
update catalog_file_audio_validation_jobs set state='finalizing',retry_at=null,lease_owner='expired',lease_expires_at=now()-interval '10 minutes',next_track_position=1 where external_id='110';
create temp table jobs_before as select * from catalog_file_audio_validation_jobs;
do $test$
declare ids uuid[];
begin
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1102),'ready_finalizer_precedes_older_captures');
 perform pg_temp.ok(ids[2]=pg_temp.uid(1101),'capture_order_preserved_after_finalizer');
 perform pg_temp.ok(not pg_temp.uid(1103)=any(ids),'ready_finalizer_precedes_same_lane_capture');
 perform pg_temp.ok((select count(*)=4 from public.list_due_catalog_file_audio_validation_jobs(99)),'dispatch_maximum_four_unchanged');
 perform pg_temp.ok((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(0)),'dispatch_minimum_one_unchanged');
 perform pg_temp.ok((select count(*)=2 from public.list_due_catalog_file_audio_validation_jobs(null)),'null_limit_two_unchanged');
 perform pg_temp.ok((select count(*)=2 from public.list_due_catalog_file_audio_validation_jobs()),'default_limit_two_unchanged');
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(ids[3]=pg_temp.uid(1109),'partial_track_finalizer_not_promoted');
 perform pg_temp.ok(ids[4]=pg_temp.uid(1110),'missing_evidence_finalizer_not_promoted');
 perform pg_temp.ok(not pg_temp.uid(1105)=any(ids),'future_retry_excluded');
 perform pg_temp.ok(not pg_temp.uid(1106)=any(ids),'quarantine_excluded');
 perform pg_temp.ok(not pg_temp.uid(1107)=any(ids),'live_finalizer_lease_excluded');
 perform pg_temp.ok(not pg_temp.uid(1108)=any(ids),'active_lane_blocks_other_captures');
 perform pg_temp.ok(not exists(select 1 from catalog_file_audio_validation_jobs j full join jobs_before b using(id)
  where to_jsonb(j) is distinct from to_jsonb(b)),'selection_never_mutates_jobs_or_evidence');
 update catalog_file_audio_validation_jobs set request_origin='manual',retry_at=now()-interval '1 minute' where external_id='104';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1104) and ids[2]=pg_temp.uid(1102),'manual_precedes_finalizer_globally');
 update catalog_file_audio_validation_jobs set request_origin='manual' where external_id='103';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1103),'manual_precedes_finalizer_within_lane');
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'one_candidate_per_lane_preserved');
 perform pg_temp.ok(not has_function_privilege('authenticated','public.list_due_catalog_file_audio_validation_jobs(integer)','EXECUTE'),'authenticated_cannot_dispatch');
 perform pg_temp.ok(not has_function_privilege('anon','public.list_due_catalog_file_audio_validation_jobs(integer)','EXECUTE'),'anonymous_cannot_dispatch');
 perform pg_temp.ok(has_function_privilege('service_role','public.list_due_catalog_file_audio_validation_jobs(integer)','EXECUTE'),'service_role_can_dispatch');
 perform pg_temp.ok((select prosecdef and provolatile='s' and proconfig=array['search_path=""'] from pg_proc where oid='public.list_due_catalog_file_audio_validation_jobs(integer)'::regprocedure),'security_and_stability_preserved');
end $test$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
