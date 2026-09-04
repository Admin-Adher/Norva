-- Retire only the superseded one-window cascade. Never weaken strict evidence.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
do $guard$
begin
  if not exists (select 1 from pg_proc where proname='persist_catalog_audio_lid_outcome'
    and position('strict-multi-window-required' in pg_get_functiondef(oid)) > 0) then
    raise exception 'Strict publication fence must be deployed first';
  end if;
end
$guard$;
update public.admin_feature_flags set enabled=false, updated_at=now()
where key in ('lid_cascade_shadow_enabled','lid_cascade_canary_enabled',
  'lid_cascade_primary_enabled','lid_cascade_tagged_writes_enabled',
  'lid_detect_only_shadow_enabled','lid_detect_only_production_enabled') and enabled;

create or replace function public.reject_retired_lid_flags()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.enabled and new.key in ('lid_cascade_shadow_enabled','lid_cascade_canary_enabled',
    'lid_cascade_primary_enabled','lid_cascade_tagged_writes_enabled',
    'lid_detect_only_shadow_enabled','lid_detect_only_production_enabled') then
    raise exception 'Legacy LID retired; strict multi-window certification is required' using errcode='55000';
  end if;
  return new;
end
$fn$;
revoke all on function public.reject_retired_lid_flags() from public,anon,authenticated,service_role;
create trigger reject_retired_lid_flags before insert or update on public.admin_feature_flags
for each row execute function public.reject_retired_lid_flags();

create or replace function public.strict_lid_runtime_health()
returns jsonb language sql stable security definer set search_path = '' as $fn$
select jsonb_build_object(
  'contract','strict-lid-runtime:v1',
  'audioEnabled',coalesce((select enabled from public.admin_feature_flags where key='audio_lid_enabled'),false),
  'legacyEnabled',exists(select 1 from public.admin_feature_flags where enabled and key in (
    'lid_cascade_shadow_enabled','lid_cascade_canary_enabled','lid_cascade_primary_enabled',
    'lid_cascade_tagged_writes_enabled','lid_detect_only_shadow_enabled','lid_detect_only_production_enabled')),
  'workerHealthy',exists(select 1 from cron.job j
    join lateral (select status,end_time from cron.job_run_details d where d.jobid=j.jobid
      and d.end_time is not null order by d.runid desc limit 1) last_run on true
    where j.jobname='norva-playback-language-validation-worker' and j.active
      and last_run.status='succeeded' and last_run.end_time>now()-interval '5 minutes'),
  'activeJobs',(select count(*) from public.catalog_file_audio_validation_jobs
    where state in ('running','finalizing')),
  'staleJobs',(select count(*) from public.catalog_file_audio_validation_jobs
    where state in ('running','finalizing') and lease_expires_at<now()-interval '15 minutes'),
  'checkedAt',now()
);
$fn$;
revoke all on function public.strict_lid_runtime_health() from public,anon,authenticated;
grant execute on function public.strict_lid_runtime_health() to service_role;
notify pgrst,'reload schema';
commit;
