begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Temporary internal rollout approvals, not audio, language evidence or a
-- provider/session exemption. The Gateway exact-file fence still applies.
create table public.catalog_language_capture_job_pilots (
  job_id uuid primary key references public.catalog_file_audio_validation_jobs(id) on delete cascade,
  profile_fingerprint text not null check(profile_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check(expires_at > created_at and expires_at <= created_at + interval '1 hour')
);
alter table public.catalog_language_capture_job_pilots enable row level security;
alter table public.catalog_language_capture_job_pilots force row level security;
revoke all on public.catalog_language_capture_job_pilots from public,anon,authenticated,service_role;
grant select on public.catalog_language_capture_job_pilots to service_role;
create index catalog_language_capture_job_pilots_expiry_idx
  on public.catalog_language_capture_job_pilots(expires_at);

create function public.catalog_language_capture_pipeline_enabled_for_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path='' as $f$
  select public.catalog_language_capture_pipeline_enabled() or exists (
    select 1 from public.catalog_language_capture_job_pilots p
    join public.catalog_file_audio_validation_jobs j on j.id=p.job_id
    join public.admin_internal_accounts internal on internal.user_id=j.requested_by
    join auth.users u on u.id=j.requested_by and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now())
    join public.cloud_sources s on s.id=j.source_id and s.user_id=j.requested_by
      and s.enabled and s.deleted_at is null and s.sync_status='ready'
    where p.job_id=p_job_id and p.expires_at>now()
      and p.profile_fingerprint=j.profile_fingerprint
      and j.state in ('queued','running','retry_wait','finalizing') and j.quarantined_at is null
  )
$f$;

create function public.authorize_catalog_language_capture_job(
  p_job_id uuid,p_profile_fingerprint text,p_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path='' as $f$
declare
  j public.catalog_file_audio_validation_jobs%rowtype;
  prior public.catalog_language_capture_job_pilots%rowtype;
  v_now timestamptz;
begin
  perform public.norva_credential_require_service_role();
  if p_job_id is null or coalesce(p_profile_fingerprint,'') !~ '^[a-f0-9]{64}$'
    or p_expires_at is null then return false; end if;
  -- Serialize only the small approval registry, never a provider connection.
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-capture-job-pilots',0));
  v_now:=clock_timestamp();
  if p_expires_at<=v_now or p_expires_at>v_now+interval '1 hour' then return false; end if;
  select * into j from public.catalog_file_audio_validation_jobs where id=p_job_id;
  if not found or j.profile_fingerprint is distinct from p_profile_fingerprint
    or j.state not in ('queued','running','retry_wait','finalizing') or j.quarantined_at is not null
    or not exists(select 1 from public.admin_internal_accounts a where a.user_id=j.requested_by)
    or not exists(select 1 from auth.users u where u.id=j.requested_by and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=v_now))
    or not exists(select 1 from public.cloud_sources s where s.id=j.source_id and s.user_id=j.requested_by
      and s.enabled and s.deleted_at is null and s.sync_status='ready') then return false; end if;
  select * into prior from public.catalog_language_capture_job_pilots where job_id=p_job_id;
  if found then
    -- Replaying an operator request cannot extend its original lifetime.
    return prior.profile_fingerprint=p_profile_fingerprint and prior.expires_at=p_expires_at
      and prior.expires_at>v_now;
  end if;
  if (select count(*) from public.catalog_language_capture_job_pilots where expires_at>v_now)>=20
    then return false; end if;
  insert into public.catalog_language_capture_job_pilots(job_id,profile_fingerprint,created_at,expires_at)
    values(j.id,p_profile_fingerprint,v_now,p_expires_at);
  return true;
end $f$;

create function public.revoke_catalog_language_capture_job(
  p_job_id uuid,p_profile_fingerprint text,p_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path='' as $f$
begin
  perform public.norva_credential_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-capture-job-pilots',0));
  delete from public.catalog_language_capture_job_pilots where job_id=p_job_id
    and profile_fingerprint=p_profile_fingerprint and expires_at=p_expires_at;
  return found;
end $f$;

-- Keep the existing atomic handoff, ownership, track/window/profile, expiry,
-- quarantine, provider-attempt and release checks. Only its rollout gate changes.
do $patch$
declare d text; old text;
begin
  d:=pg_get_functiondef('public.checkpoint_catalog_file_audio_capture(uuid,text,integer,integer,text,text,text,timestamptz,text,text,uuid)'::regprocedure);
  old:='if not public.catalog_language_capture_pipeline_enabled() then return null; end if;';
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'Capture rollout gate drifted'; end if;
  execute replace(d,old,'if not public.catalog_language_capture_pipeline_enabled_for_job(p_job_id) then return null; end if;');
end $patch$;

revoke all on function public.catalog_language_capture_pipeline_enabled_for_job(uuid),
  public.authorize_catalog_language_capture_job(uuid,text,timestamptz),
  public.revoke_catalog_language_capture_job(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.catalog_language_capture_pipeline_enabled_for_job(uuid),
  public.authorize_catalog_language_capture_job(uuid,text,timestamptz),
  public.revoke_catalog_language_capture_job(uuid,text,timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
