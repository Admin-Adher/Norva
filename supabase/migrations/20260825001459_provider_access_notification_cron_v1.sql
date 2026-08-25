-- Explicit Provider Access notification cron lifecycle.
--
-- This migration never schedules network work. The service-only installer is
-- callable only after the cohort/core notification flag is active and the
-- cache rollout is complete. The scheduled command re-checks the flag before
-- every pg_net call, so emergency OFF makes the dormant job inert immediately.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.norva_install_provider_access_notification_cron()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job_id bigint;
begin
  perform public.norva_provider_access_service_role_required();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:provider-access-notification-cron:v1', 0)
  );
  if not coalesce(
    public.feature_flag('provider_access_notifications_v1_enabled'),false
  ) then
    raise exception 'Provider Access notification capability disabled'
      using errcode='55000', detail='reason=feature_disabled';
  end if;
  if not exists (
       select 1 from public.cloud_provider_access_rollout rollout
       where rollout.singleton and rollout.stage <> 'off'
         and rollout.legal_policy_approved_at is not null
         and rollout.operational_approved_at is not null
     )
     or not exists (
       select 1 from public.cloud_catalog_cache_epoch_v2_rollout cache
       where cache.singleton and cache.phase = 'complete'
     ) then
    raise exception 'Provider Access notification cron rollout prerequisites unavailable'
      using errcode='55000', detail='reason=rollout_prerequisites_unavailable';
  end if;
  perform public.norva_assert_provider_access_rollout_safe();
  if pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null
     or pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     or not exists (
       select 1 from vault.decrypted_secrets
       where name='norva_cron_shared_secret' and decrypted_secret <> ''
     ) then
    raise exception 'Provider Access notification cron infrastructure unavailable'
      using errcode='55000', detail='reason=cron_prerequisites_unavailable';
  end if;

  select jobid into v_job_id
  from cron.job
  where jobname='norva-provider-access-notifications';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  v_job_id := cron.schedule(
    'norva-provider-access-notifications',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-provider-access-notify/cron/drain',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || (
            select decrypted_secret from vault.decrypted_secrets
            where name='norva_cron_shared_secret' limit 1
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 180000
      )
      where coalesce(public.feature_flag('provider_access_notifications_v1_enabled'),false)
        and exists (
          select 1 from public.cloud_provider_access_rollout rollout
          where rollout.singleton and rollout.stage <> 'off'
        );
    $job$
  );
  return jsonb_build_object(
    'installed',true,
    'jobId',v_job_id,
    'jobName','norva-provider-access-notifications',
    'schedule','* * * * *'
  );
end
$function$;

create or replace function public.norva_remove_provider_access_crons()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job record;
  v_removed text[] := array[]::text[];
begin
  perform public.norva_provider_access_service_role_required();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('norva:provider-access-notification-cron:v1', 0)
  );
  for v_job in
    select jobid,jobname from cron.job
    where jobname in (
      'norva-provider-access-notifications',
      'norva-provider-access-checks'
    )
    order by jobname
  loop
    perform cron.unschedule(v_job.jobid);
    v_removed := pg_catalog.array_append(v_removed,v_job.jobname);
  end loop;
  return jsonb_build_object('removed',v_removed,'count',coalesce(array_length(v_removed,1),0));
end
$function$;

revoke all on function public.norva_install_provider_access_notification_cron(),
  public.norva_remove_provider_access_crons()
from public, anon, authenticated;
grant execute on function public.norva_install_provider_access_notification_cron(),
  public.norva_remove_provider_access_crons()
to service_role;

comment on function public.norva_install_provider_access_notification_cron()
is 'Explicit fail-closed Provider Access notification cron installer; migration installation itself remains dormant.';
comment on function public.norva_remove_provider_access_crons()
is 'Emergency/idempotent removal of the two Provider Access network cron jobs.';

commit;
