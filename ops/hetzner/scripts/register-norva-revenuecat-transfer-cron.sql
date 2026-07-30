-- =============================================================================
-- Register the RevenueCat TRANSFER replay and Partners outbox worker.
--
-- Run manually as the cron owner only AFTER:
--   1) deploying norva-revenuecat-transfer-worker;
--   2) applying the RevenueCat transfer migrations and passing pgTAP;
--   3) configuring the RevenueCat secret API key in the Edge runtime;
--   4) confirming norva_cron_shared_secret in Vault;
--   5) invoking /cron/run once and checking its bounded counters.
--
-- The schedule is intentionally outside migrations: code is deployed and
-- smoke-tested before pg_cron starts traffic. Re-running is idempotent because
-- cron.schedule(jobname, ...) updates the named job.
-- =============================================================================

\set ON_ERROR_STOP on

do $preflight$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'norva_cron_shared_secret'
      and length(secret.decrypted_secret) >= 32
  ) then
    raise exception
      'norva_cron_shared_secret is missing or invalid in Vault';
  end if;
end
$preflight$;

select cron.schedule(
  'norva-revenuecat-transfer-worker',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url := 'https://api.norva.tv/functions/v1/norva-revenuecat-transfer-worker/cron/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'norva_cron_shared_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

select jobid, jobname, schedule, active
from cron.job
where jobname = 'norva-revenuecat-transfer-worker';
