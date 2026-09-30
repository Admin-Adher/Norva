begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A one-time operator recovery after a documented repair, not an automatic
-- extension of the normal eight-attempt budget. Keep terminal history intact.
create table public.catalog_selection_audio_recoveries (
  external_id text not null,
  url_sha256 text not null,
  original_job_id uuid not null unique,
  replacement_job_id uuid not null unique,
  repair_revision text not null check(repair_revision ~ '^[a-f0-9]{40}$'),
  original_job jsonb not null check(jsonb_typeof(original_job)='object'),
  original_captures jsonb not null check(jsonb_typeof(original_captures)='array'),
  recovered_at timestamptz not null default clock_timestamp(),
  primary key(external_id,url_sha256)
);
alter table public.catalog_selection_audio_recoveries enable row level security;
alter table public.catalog_selection_audio_recoveries force row level security;
revoke all on public.catalog_selection_audio_recoveries from public,anon,authenticated,service_role;
grant select on public.catalog_selection_audio_recoveries to service_role;

create function public.recover_selection_audio_job(
  p_job_id uuid,p_completed_at timestamptz,p_repair_revision text
) returns uuid language plpgsql security definer set search_path='' as $f$
declare
  prior public.catalog_selection_audio_jobs%rowtype;
  captures jsonb;
  replacement uuid;
begin
  perform public.norva_credential_require_service_role();
  if p_job_id is null or p_completed_at is null or p_repair_revision is null
    or p_repair_revision !~ '^[a-f0-9]{40}$' then
    raise exception using errcode='22023',message='SELECTION_RECOVERY_ARGUMENTS_INVALID';
  end if;
  if public.selection_audio_capture_pipeline_enabled() is distinct from true then
    raise exception using errcode='55000',message='SELECTION_RECOVERY_CAPTURE_REQUIRED';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('selection-audio-global-worker-v1',0)) then
    raise exception using errcode='55P03',message='SELECTION_RECOVERY_BUSY';
  end if;
  select * into prior from public.catalog_selection_audio_jobs where id=p_job_id for update;
  if not found then
    -- Safe retry of a committed request after response loss. Do not enqueue again.
    select replacement_job_id into replacement from public.catalog_selection_audio_recoveries
      where original_job_id=p_job_id and repair_revision=p_repair_revision
        and (original_job->>'completed_at')::timestamptz=p_completed_at;
    if replacement is not null then return replacement; end if;
    raise exception using errcode='55000',message='SELECTION_RECOVERY_STALE_JOB';
  end if;
  if prior.state<>'failed' or prior.attempt_count<>8
    or prior.completed_at is distinct from p_completed_at
    or prior.completed_at>clock_timestamp()-interval '24 hours'
    or prior.error_code not in ('SELECTION_AUDIO_GATEWAY_REJECTED','ATTEMPT_LIMIT')
    or prior.error_code is null then
    raise exception using errcode='55000',message='SELECTION_RECOVERY_NOT_ELIGIBLE';
  end if;
  if exists(select 1 from public.catalog_selection_audio_recoveries
    where external_id=prior.external_id and url_sha256=prior.url_sha256) then
    raise exception using errcode='55000',message='SELECTION_RECOVERY_ALREADY_USED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into captures
    from public.catalog_selection_audio_captures c where c.job_id=prior.id;
  delete from public.catalog_selection_audio_jobs where id=prior.id;
  -- The canonical seeder rechecks current visible owners, generations, exact
  -- media URLs and incomplete audio. Failure rolls back deletion and captures.
  if public.seed_selection_audio_jobs(jsonb_build_array(jsonb_build_object(
    'externalId',prior.external_id,'urlSha256',prior.url_sha256,'priority',prior.priority)))<>1 then
    raise exception using errcode='55000',message='SELECTION_RECOVERY_NO_CURRENT_FILE';
  end if;
  select id into replacement from public.catalog_selection_audio_jobs
    where external_id=prior.external_id and url_sha256=prior.url_sha256
      and state='queued' and attempt_count=0 and profile='{}'::jsonb and progress='{}'::jsonb;
  if replacement is null or replacement=prior.id then
    raise exception using errcode='55000',message='SELECTION_RECOVERY_SEED_INVALID';
  end if;
  insert into public.catalog_selection_audio_recoveries
    (external_id,url_sha256,original_job_id,replacement_job_id,repair_revision,original_job,original_captures)
    values(prior.external_id,prior.url_sha256,prior.id,replacement,p_repair_revision,to_jsonb(prior),captures);
  return replacement;
end
$f$;
revoke all on function public.recover_selection_audio_job(uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.recover_selection_audio_job(uuid,timestamptz,text) to service_role;
commit;
