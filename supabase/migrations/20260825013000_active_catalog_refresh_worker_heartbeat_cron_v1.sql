-- Phase 3.2 active-catalog refresh worker heartbeat.
--
-- The worker capability expires after ten minutes. This installer is kept
-- explicit so applying migrations to proof/staging never schedules network
-- traffic. In production it is installed while rollout flags remain OFF: the
-- authenticated drain registers the v3 runtime before it attempts any claim,
-- while PostgreSQL continues to own feature and generation authorization.

create or replace function public.norva_install_active_catalog_refresh_worker_cron()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job_id bigint;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_active_catalog_refresh_sql_contract_ready()
     or pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null
     or pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     or not exists (
       select 1 from vault.decrypted_secrets
       where name = 'norva_cron_shared_secret' and decrypted_secret <> ''
     )
     or not exists (
       select 1 from vault.decrypted_secrets
       where name = 'norva_provider_access_worker_token' and decrypted_secret <> ''
     ) then
    raise exception 'active catalog refresh worker cron prerequisites unavailable'
      using errcode = '55000',
        detail = 'reason=active_catalog_refresh_worker_cron_prerequisites_unavailable';
  end if;

  select jobid into v_job_id
  from cron.job
  where jobname = 'norva-active-catalog-refresh-worker';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  v_job_id := cron.schedule(
    'norva-active-catalog-refresh-worker',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-provider-access/internal/worker/drain',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || (
            select decrypted_secret from vault.decrypted_secrets
            where name='norva_cron_shared_secret' limit 1
          ),
          'X-Norva-Worker-Token',(
            select decrypted_secret from vault.decrypted_secrets
            where name='norva_provider_access_worker_token' limit 1
          )
        ),
        body := '{"limit":1}'::jsonb,
        timeout_milliseconds := 180000
      );
    $job$
  );

  return jsonb_build_object(
    'installed',true,
    'jobId',v_job_id,
    'jobName','norva-active-catalog-refresh-worker',
    'schedule','* * * * *',
    'workerProtocol','credential-transition-worker-v3-active-catalog-refresh',
    'refreshContractId','active-catalog-refresh-checkpoint-prune-v1'
  );
end
$function$;

create or replace function public.norva_remove_active_catalog_refresh_worker_cron()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job_id bigint;
begin
  perform public.norva_credential_require_service_role();
  select jobid into v_job_id
  from cron.job
  where jobname = 'norva-active-catalog-refresh-worker';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  return jsonb_build_object(
    'removed',v_job_id is not null,
    'jobId',v_job_id,
    'jobName','norva-active-catalog-refresh-worker'
  );
end
$function$;

revoke all on function public.norva_install_active_catalog_refresh_worker_cron()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_remove_active_catalog_refresh_worker_cron()
  from public, anon, authenticated, service_role;
grant execute on function public.norva_install_active_catalog_refresh_worker_cron()
  to service_role;
grant execute on function public.norva_remove_active_catalog_refresh_worker_cron()
  to service_role;

do $assert$
begin
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.norva_install_active_catalog_refresh_worker_cron()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.norva_install_active_catalog_refresh_worker_cron()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.norva_remove_active_catalog_refresh_worker_cron()',
       'EXECUTE'
     ) then
    raise exception 'active catalog refresh worker cron ACL invariant failed';
  end if;
end
$assert$;
