-- Synthetic rows only in a networkless, schema-only PostgreSQL. Always roll back.
begin;
set local statement_timeout='20s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.tokens(n int) returns jsonb language sql immutable as $$select jsonb_agg('v1.'||repeat('a',16)||'.'||repeat('b',16)||'.'||i::text||'.'||repeat('c',22)) from generate_series(1,n)i$$;
create temp table checks(label text primary key);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1));
insert into cloud_sources(id,user_id,source_type,sync_status,display_name) values(pg_temp.uid(2),pg_temp.uid(1),'xtream','ready','Synthetic');
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
 values(pg_temp.uid(3),pg_temp.uid(1),'movie','fixture','normalized','Synthetic');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title)
 select pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(3),pg_temp.uid(2),pg_temp.uid(4),'movie',n::text,'Synthetic' from generate_series(101,108)n;
insert into catalog_file_audio_validation_jobs(id,requested_by,source_id,variant_id,identity_key,item_type,external_id,
 expected_audio_indices,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes,cached_audio_tracks,
 state,queue_expires_at,retry_at,request_origin,created_at,purge_after)
 select pg_temp.uid(1000+n),pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(n),'lane-'||n,'movie',n::text,
 array[0],repeat('a',64),'{}','2026-10-03T10:00Z',1000000,'[{"index":0,"lang":null}]',
 'retry_wait',null,now()-interval '2 hours','automatic',now()-interval '3 hours',now()+interval '1 day'
 from generate_series(101,108)n;
update catalog_file_audio_validation_jobs set state='running',retry_at=null,lease_owner='expired',lease_expires_at=now()-interval '1 minute',
 strict_lid_window_count=6,strict_lid_window_position=6,strict_lid_window_protocol=1,
 strict_lid_window_tokens=pg_temp.tokens(6) where external_id='102';
update catalog_file_audio_validation_jobs set identity_key='lane-102',retry_at=now()-interval '3 hours' where external_id='103';
update catalog_file_audio_validation_jobs set retry_at=now()+interval '1 hour' where external_id in ('104','105','106','107','108');
create temp table jobs_before as select * from catalog_file_audio_validation_jobs;
do $test$
declare ids uuid[];
begin
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1102),'ready_window_consensus_precedes_older_captures');
 perform pg_temp.ok(ids[2]=pg_temp.uid(1101),'capture_order_preserved');
 perform pg_temp.ok(not pg_temp.uid(1103)=any(ids),'ready_windows_precede_same_lane_capture');
 perform pg_temp.ok(not exists(select 1 from catalog_file_audio_validation_jobs j full join jobs_before b using(id)
  where to_jsonb(j) is distinct from to_jsonb(b)),'selector_does_not_mutate_receipts_or_leases');
 update catalog_file_audio_validation_jobs set strict_lid_window_position=5,strict_lid_window_tokens=pg_temp.tokens(5) where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'incomplete_windows_not_prioritized');
 -- Cursor/evidence invariants are also guarded by table constraints. Disable
 -- only those constraints in this rolled-back fixture to exercise selection of
 -- historical/malformed rows without weakening the actual schema.
 alter table catalog_file_audio_validation_jobs drop constraint catalog_file_audio_validation_jobs_strict_lid_window_tokens_check;
 update catalog_file_audio_validation_jobs set strict_lid_window_position=6 where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'missing_receipt_not_prioritized');
 update catalog_file_audio_validation_jobs set strict_lid_window_count=4,strict_lid_window_position=4,strict_lid_window_tokens=pg_temp.tokens(4) where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1102),'four_window_consensus_prioritized');
 update catalog_file_audio_validation_jobs set state='retry_wait',lease_owner=null,lease_expires_at=null,retry_at=now()+interval '1 hour' where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'future_retry_preserved');
 update catalog_file_audio_validation_jobs set state='failed',retry_at=null,quarantined_at=now(),error_code='KEEP_QUARANTINE' where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'quarantine_preserved');
 update catalog_file_audio_validation_jobs set quarantined_at=null,state='running',error_code=null,retry_at=null,lease_owner='active',lease_expires_at=now()+interval '5 minutes' where external_id='102';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(not pg_temp.uid(1102)=any(ids),'active_lease_preserved');
 perform pg_temp.ok(not pg_temp.uid(1103)=any(ids),'occupied_source_lane_preserved');
 update catalog_file_audio_validation_jobs set lease_expires_at=now()-interval '1 minute' where external_id='102';
 update catalog_file_audio_validation_jobs set request_origin='manual',retry_at=now()-interval '1 minute' where external_id='104';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(2);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1104) and ids[2]=pg_temp.uid(1102),'manual_priority_preserved');
 update catalog_file_audio_validation_jobs set request_origin='manual' where external_id='103';
 select array_agg(job_id) into ids from public.list_due_catalog_file_audio_validation_jobs(4);
 perform pg_temp.ok(ids[1]=pg_temp.uid(1103) and not pg_temp.uid(1102)=any(ids),'manual_priority_within_lane_preserved');
end $test$;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
