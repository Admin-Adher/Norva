-- Bounded extra wakeups for ready work; the existing minute heartbeat remains.
-- Installation is explicit so test/staging migrations never schedule traffic.
create or replace function public.norva_install_credential_continuation_cron()
returns bigint language plpgsql security definer set search_path = ''
as $function$
declare v_id bigint;
begin
 perform public.norva_credential_require_service_role();
 if not public.norva_active_catalog_refresh_sql_contract_ready() then
  raise exception 'credential continuation prerequisites unavailable' using errcode='55000';
 end if;
 v_id := cron.schedule('norva-credential-ready-continuation','10 seconds',$job$
 select net.http_post(
  url := 'https://api.norva.tv/functions/v1/norva-provider-access/internal/worker/drain',
  headers := jsonb_build_object(
   'Content-Type','application/json',
   'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret' limit 1),
   'X-Norva-Worker-Token',(select decrypted_secret from vault.decrypted_secrets where name='norva_provider_access_worker_token' limit 1)
  ), body := '{"limit":1}'::jsonb, timeout_milliseconds := 180000
 ) where (select count(*) from public.cloud_source_credential_transition_jobs
           where state='processing' and lease_until>clock_timestamp()) < 2
   and exists(select 1 from public.cloud_source_credential_transition_jobs
              where state='pending' and available_at<=clock_timestamp());
 $job$);
 return v_id;
end
$function$;
revoke all on function public.norva_install_credential_continuation_cron() from public,anon,authenticated;
grant execute on function public.norva_install_credential_continuation_cron() to service_role;