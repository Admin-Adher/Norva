-- Isolated database, or paused worker + enclosing rollback transaction only.
-- The temporary owner stand-in counts expensive checks and never opens media.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
create temporary table selection_audio_owner_checks(external_id text) on commit drop;
grant select on selection_audio_owner_checks to service_role;

create or replace function public.selection_audio_job_owners(p_external_id text,p_url_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
begin
  perform public.norva_credential_require_service_role();
  insert into pg_temp.selection_audio_owner_checks values(p_external_id);
  if p_external_id='norva-selection:movie:'||lpad(to_hex(17),64,'0') then
    return '[{"user_id":"99100000-0000-4000-8000-000000000017","source_id":"99100000-0000-4000-8000-000000000018"}]'::jsonb;
  end if;
  return '[]'::jsonb;
end
$function$;

insert into public.catalog_selection_audio_jobs(external_id,url_sha256,priority,next_attempt_at,created_at)
select 'norva-selection:movie:'||lpad(to_hex(ordinal),64,'0'),repeat('d',64),1000,
  '2000-01-01'::timestamptz,'2000-01-01'::timestamptz from generate_series(1,17) ordinal;
update public.catalog_selection_audio_jobs set state='running',attempt_count=3,
  lease_token='99100000-0000-4000-8000-000000000019',lease_until=clock_timestamp()-interval '1 second'
  where external_id='norva-selection:movie:'||lpad(to_hex(1),64,'0') and url_sha256=repeat('d',64);

set local role service_role;
select extensions.is(public.claim_selection_audio_job(),null::jsonb,
  'the first poll stops after its bounded orphan batch');
select extensions.is((select count(*)::integer from pg_temp.selection_audio_owner_checks),16,
  'only 16 owner checks run even when another due candidate exists');
select extensions.ok(not exists(select 1 from pg_temp.selection_audio_owner_checks
  where external_id='norva-selection:movie:'||lpad(to_hex(17),64,'0')),
  'ownership is not evaluated ahead of the candidate LIMIT');
select extensions.is((select count(*)::integer from public.catalog_selection_audio_jobs
  where external_id in(select external_id from pg_temp.selection_audio_owner_checks)
    and url_sha256=repeat('d',64) and state='retry_wait' and error_code='NO_ACTIVE_OWNER'
    and next_attempt_at>clock_timestamp()+interval '14 minutes' and lease_token is null),16,
  'all orphan candidates are deferred and release expired leases');
select extensions.is((select attempt_count from public.catalog_selection_audio_jobs
  where external_id='norva-selection:movie:'||lpad(to_hex(1),64,'0') and url_sha256=repeat('d',64)),3,
  'an expired orphan preserves its analysis-attempt budget');
select extensions.is((select sum(attempt_count)::integer from public.catalog_selection_audio_jobs
  where external_id in(select external_id from pg_temp.selection_audio_owner_checks) and url_sha256=repeat('d',64)),3,
  'ownership checks consume no new analysis attempts');

create temporary table selection_audio_claim_result as select public.claim_selection_audio_job() result;
select extensions.is((select result->>'external_id' from selection_audio_claim_result),
  'norva-selection:movie:'||lpad(to_hex(17),64,'0'),
  'the next poll advances beyond retired-source jobs and claims the live file');
select extensions.is((select count(*)::integer from pg_temp.selection_audio_owner_checks),17,
  'the second poll checks one new owner rather than rechecking 16 orphans');
select extensions.ok((select (result->>'attempt_count')::integer=1
  and result->>'lease_token' is not null and (result->>'lease_until')::timestamptz>clock_timestamp()+interval '4 minutes'
  from selection_audio_claim_result),'successful admission keeps the ordinary attempt and lease contract');
select extensions.is(public.claim_selection_audio_job(),null::jsonb,
  'global concurrency remains one after bounded admission');
select extensions.is((select count(*)::integer from pg_temp.selection_audio_owner_checks),17,
  'the concurrency guard runs before any further owner lookup');
reset role;

select extensions.ok(not has_function_privilege('anon','public.claim_selection_audio_job()','EXECUTE')
  and not has_function_privilege('authenticated','public.claim_selection_audio_job()','EXECUTE')
  and has_function_privilege('service_role','public.claim_selection_audio_job()','EXECUTE'),
  'bounded claim remains service-only');
select extensions.ok(pg_get_functiondef('public.seed_selection_audio_jobs(jsonb)'::regprocedure)
  like '%and (excluded.priority>job.priority or job.error_code=''NO_ACTIVE_OWNER'')%',
  'visible exact-file enrolment can revive a deferred ownerless job without resetting other retries');
select * from extensions.finish();
rollback;
