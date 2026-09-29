create function pg_temp.check_dispatch(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED %',label; end if;
raise notice 'PASS %',label; end $$;
insert into public.fixture_modes values(md5('1')::uuid,md5('1')::uuid,false),(md5('2')::uuid,md5('2')::uuid,false);
insert into public.catalog_file_audio_validation_jobs(id,requested_by,source_id,identity_key,request_origin,created_at,state)
select md5(('job'||i)::text)::uuid,md5(i::text)::uuid,md5(i::text)::uuid,'shared','automatic',now()-interval '1 minute','queued'
from generate_series(1,2) i;
select pg_temp.check_dispatch((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(4)),'legacy identity scheduling preserved');
update public.fixture_modes set enabled=true;
select pg_temp.check_dispatch((select count(*)=2 from public.list_due_catalog_file_audio_validation_jobs(4)),'scoped sources dispatch independently with global flag off');
update public.catalog_file_audio_validation_jobs set state='running',lease_expires_at=now()+interval '1 minute' where source_id=md5('1')::uuid;
select pg_temp.check_dispatch((select array_agg(job_id)=array[md5('job2')::uuid] from public.list_due_catalog_file_audio_validation_jobs(4)),'another scoped source can run');
update public.fixture_modes set enabled=false where source_id=md5('1')::uuid;
select pg_temp.check_dispatch(not exists(select 1 from public.list_due_catalog_file_audio_validation_jobs(4)),'active legacy source blocks scoped peer');
update public.fixture_modes set enabled=(source_id=md5('1')::uuid);
select pg_temp.check_dispatch(not exists(select 1 from public.list_due_catalog_file_audio_validation_jobs(4)),'active scoped source blocks legacy peer');
update public.fixture_legacy set enabled=true;
select pg_temp.check_dispatch((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(4)),'legacy global activation retains original behavior');
update public.fixture_legacy set enabled=false;
update public.fixture_modes set enabled=true;
update public.catalog_file_audio_validation_jobs set state='queued',lease_expires_at=null;
insert into public.catalog_file_audio_validation_jobs select md5('job3')::uuid,requested_by,source_id,identity_key,'manual',null,null,now(),'queued',null from public.catalog_file_audio_validation_jobs where id=md5('job1')::uuid;
select pg_temp.check_dispatch((select array_agg(job_id)=array[md5('job3')::uuid] from public.list_due_catalog_file_audio_validation_jobs(1)),'manual priority and limit preserved');
update public.catalog_file_audio_validation_jobs set quarantined_at=now() where id=md5('job3')::uuid;
select pg_temp.check_dispatch(not exists(select 1 from public.list_due_catalog_file_audio_validation_jobs(4) where job_id=md5('job3')::uuid),'quarantine excluded');
update public.catalog_file_audio_validation_jobs set state='retry_wait',retry_at=now()+interval '1 hour' where id=md5('job2')::uuid;
select pg_temp.check_dispatch((select array_agg(job_id)=array[md5('job1')::uuid] from public.list_due_catalog_file_audio_validation_jobs(4)),'future retry excluded');
update public.catalog_file_audio_validation_jobs set state='queued',retry_at=null where id=md5('job2')::uuid;
update public.fixture_modes set enabled=false;
select pg_temp.check_dispatch((select count(*)=1 from public.list_due_catalog_file_audio_validation_jobs(4)),'rollback restores identity grouping');
