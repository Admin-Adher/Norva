begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Do not guess the origin of historical work, rewrite outcomes or touch audio.
-- Legacy rows retain the manual quota semantics until they age out naturally.
alter table public.catalog_file_audio_validation_jobs
  add column request_origin text not null default 'legacy'
  check(request_origin in ('legacy','manual','automatic'));
create index catalog_language_manual_daily_idx
  on public.catalog_file_audio_validation_jobs(requested_by,created_at desc)
  where request_origin<>'automatic';
create index catalog_language_outstanding_idx
  on public.catalog_file_audio_validation_jobs(identity_key,request_origin,state)
  include(lease_expires_at)
  where state in ('queued','running','retry_wait','finalizing');

create table public.catalog_language_capacity (
  singleton boolean primary key default true check(singleton),
  max_workers integer not null check(max_workers between 0 and 2),
  reason text not null check(reason in ('capacity-unavailable','viewer-priority','foreground-work',
    'resource-pressure','background-occupied','capacity-available')),
  observed_at timestamptz not null,
  expires_at timestamptz not null
);
alter table public.catalog_language_capacity enable row level security;
revoke all on public.catalog_language_capacity from public,anon,authenticated;
grant select on public.catalog_language_capacity to service_role;
insert into public.admin_feature_flags(key,enabled) values('adaptive_language_admission_enabled',false)
on conflict(key) do nothing;

create function public.report_catalog_language_capacity(p_max_workers integer,p_reason text,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
  if p_max_workers is null or p_max_workers not between 0 and 2
    or p_observed_at is null or p_observed_at<clock_timestamp()-interval '15 seconds'
    or p_observed_at>clock_timestamp()+interval '5 seconds'
    or p_reason is null or p_reason not in ('capacity-unavailable','viewer-priority','foreground-work',
      'resource-pressure','background-occupied','capacity-available') then return false; end if;
  insert into public.catalog_language_capacity(singleton,max_workers,reason,observed_at,expires_at)
    values(true,p_max_workers,p_reason,p_observed_at,least(clock_timestamp(),p_observed_at)+interval '10 seconds')
  on conflict(singleton) do update set max_workers=excluded.max_workers,reason=excluded.reason,
    observed_at=excluded.observed_at,expires_at=excluded.expires_at
  where excluded.observed_at>catalog_language_capacity.observed_at;
  -- Parallel health requests can share the same millisecond. Accept an exact
  -- replay without extending freshness or accepting an older permissive sample.
  return found or exists(select 1 from public.catalog_language_capacity
    where singleton and observed_at=p_observed_at and max_workers=p_max_workers
      and reason=p_reason and expires_at>clock_timestamp());
end $fn$;

-- Called under the common transaction admission lock by both intake and worker.
-- Queued/retry-wait jobs consume buffer space, NOT execution slots. A timed-out
-- process keeps its existing job/provider leases; none are shortened here.
create function public.catalog_language_execution_available()
returns boolean language sql volatile security definer set search_path='' as $fn$
  select coalesce((select c.expires_at>clock_timestamp() and c.max_workers>
    ((select count(*) from public.catalog_file_audio_validation_jobs j
       where j.state in ('running','finalizing') and j.lease_expires_at>clock_timestamp())+
     (select count(*) from public.catalog_vod_language_intake q
       where q.state='leased' and q.lease_until>clock_timestamp()))
    from public.catalog_language_capacity c where c.singleton),false)
$fn$;

-- Buffer bounds are not daily throughput targets. Four outstanding files per
-- provider identity and 32 globally prevent a large catalogue filling memory/
-- durable queues. The same exact-file deduplication still spans user accounts.
create function public.catalog_language_queue_available(p_identity_key text)
returns boolean language sql volatile security definer set search_path='' as $fn$
  select (select count(*) from public.catalog_file_audio_validation_jobs
    where state in ('queued','running','retry_wait','finalizing')
      and identity_key=p_identity_key)<4
  and (select count(*) from public.catalog_file_audio_validation_jobs
    where state in ('queued','running','retry_wait','finalizing') and request_origin<>'manual')<32
$fn$;

-- Guarded narrow edits preserve all current identity/profile/ownership,
-- quarantine, exact evidence and certificate-fanout fixes in the installed RPCs.
do $patch$
declare d text; old text; replacement text; target regprocedure; first_pos integer; last_pos integer;
begin
  target:='public.start_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,integer[],text,timestamptz,bigint,jsonb)'::regprocedure;
  d:=pg_get_functiondef(target);
  old:='where job.requested_by = p_requested_by';
  -- Two quota predicates plus three manual queue/retention maintenance paths.
  -- A manual request must not requeue or expire unrelated automatic work.
  if (length(d)-length(replace(d,old,'')))/length(old)<>5 then raise exception 'Manual quota predicates drifted'; end if;
  d:=replace(d,old,old||E'\n    and job.request_origin <> ''automatic''');
  old:=E'    file_size_bytes, cached_audio_tracks\n  ) values (';
  if position(old in d)=0 then raise exception 'Manual insert columns drifted'; end if;
  d:=replace(d,old,E'    file_size_bytes, cached_audio_tracks, request_origin\n  ) values (');
  old:=E'    p_file_size_bytes, p_cached_audio_tracks\n  ) returning * into v_job;';
  if position(old in d)=0 then raise exception 'Manual insert values drifted'; end if;
  execute replace(d,old,E'    p_file_size_bytes, p_cached_audio_tracks, ''manual''\n  ) returning * into v_job;');

  target:='public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure;
  d:=pg_get_functiondef(target);
  first_pos:=position('  -- Automatic certification shares the same bounded tenant budget' in d);
  last_pos:=position('  insert into public.catalog_file_audio_validation_jobs (' in d);
  if first_pos=0 or last_pos<=first_pos or position('if v_starts_24h >= 20' in d)=0 then
    raise exception 'Automatic quota block drifted'; end if;
  replacement:=$new$  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then
    return jsonb_build_object('limited',true,'code','LANGUAGE_AUTOMATIC_ADMISSION_PAUSED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
  if not public.catalog_language_queue_available(btrim(p_identity_key)) then
    return jsonb_build_object('limited',true,'code','LANGUAGE_AUTOMATIC_QUEUE_FULL',
      'retryAt',v_now+interval '1 minute','retryAfterSeconds',60);
  end if;

$new$;
  d:=substr(d,1,first_pos-1)||replacement||substr(d,last_pos);
  old:=E'    file_size_bytes, cached_audio_tracks, state, retry_at, queue_expires_at\n';
  if position(old in d)=0 then raise exception 'Automatic insert columns drifted'; end if;
  d:=replace(d,old,E'    file_size_bytes, cached_audio_tracks, state, retry_at, queue_expires_at, request_origin\n');
  old:=E'    ''retry_wait'', v_now, null\n  ) returning * into v_job;';
  if position(old in d)=0 then raise exception 'Automatic insert values drifted'; end if;
  execute replace(d,old,E'    ''retry_wait'', v_now, null, ''automatic''\n  ) returning * into v_job;');

  target:='public.claim_catalog_vod_language_file(uuid,uuid)'::regprocedure;
  d:=pg_get_functiondef(target);
  first_pos:=position('  -- Already queued strict jobs are never reset' in d);
  last_pos:=position('  -- Expired/deferred attempts get a fair turn' in d);
  if first_pos=0 or last_pos<=first_pos then raise exception 'Intake quota block drifted'; end if;
  replacement:=$new$  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then
    return jsonb_build_object('skipped','automatic-admission-paused','hasMore',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
  if not public.catalog_language_queue_available(v_identity) then
    return jsonb_build_object('skipped','automatic-queue-full','hasMore',true);
  end if;
  if not public.catalog_language_execution_available() then
    return jsonb_build_object('skipped','server-capacity','hasMore',true);
  end if;

$new$;
  execute substr(d,1,first_pos-1)||replacement||substr(d,last_pos);

  target:='public.claim_catalog_file_audio_validation_job(uuid,text,integer)'::regprocedure;
  d:=pg_get_functiondef(target);
  old:='  if not v_is_renewal and v_job.attempt_count >= 256 then';
  if position(old in d)=0 then raise exception 'Worker admission block drifted'; end if;
  replacement:=$new$  if not v_is_renewal then
    perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
    if not public.catalog_language_execution_available() then return null; end if;
  end if;
  if not v_is_renewal and v_job.attempt_count >= 256 then$new$;
  execute replace(d,old,replacement);
end $patch$;

-- Manual work goes first within each provider lane. Unexpired running jobs are
-- excluded before dispatch; account occupancy is rechecked at the network edge.
create or replace function public.list_due_catalog_file_audio_validation_jobs(p_limit integer default 2)
returns table(job_id uuid) language sql stable security definer set search_path='' as $fn$
  with due as (
    select j.id,j.identity_key,case when j.request_origin='manual' then 0 else 1 end as priority,
      coalesce(j.retry_at,j.lease_expires_at,j.created_at) as due_at,
      row_number() over(partition by j.identity_key order by
        case when j.request_origin='manual' then 0 else 1 end,
        coalesce(j.retry_at,j.lease_expires_at,j.created_at),j.id) as provider_rank
    from public.catalog_file_audio_validation_jobs j
    where j.quarantined_at is null and (j.state='queued'
      or (j.state='retry_wait' and (j.retry_at is null or j.retry_at<=now()))
      or (j.state in ('running','finalizing') and j.lease_expires_at<=now()))
      and not exists(select 1 from public.catalog_file_audio_validation_jobs active
        where active.identity_key=j.identity_key and active.state in ('running','finalizing') and active.lease_expires_at>now())
  ) select id from due where provider_rank=1 order by priority,due_at,id
    limit greatest(1,least(coalesce(p_limit,2),4))
$fn$;

revoke all on function public.report_catalog_language_capacity(integer,text,timestamptz),
  public.catalog_language_execution_available(),public.catalog_language_queue_available(text)
  from public,anon,authenticated;
grant execute on function public.report_catalog_language_capacity(integer,text,timestamptz),
  public.catalog_language_execution_available(),public.catalog_language_queue_available(text) to service_role;
-- CREATE OR REPLACE retains the existing service-only ACLs on modified RPCs.
commit;
