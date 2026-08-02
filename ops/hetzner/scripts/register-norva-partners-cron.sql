-- =============================================================================
-- Register the Norva Partners commission/J+45/shadow worker.
--
-- Run manually as the cron owner only AFTER:
--   1) deploying norva-partners-worker;
--   2) applying all pending Partners migrations through
--      20260802135202_partners_sensitive_mutations_aal2.sql and passing pgTAP;
--   3) confirming the existing norva_cron_shared_secret in Vault;
--   4) invoking /cron/run once and reviewing fresh commission, correction,
--      maturation and reconciliation heartbeats.
--
-- The endpoint is intentionally not installed by a migration: a code deploy
-- must be smoke-tested before scheduling traffic. cron.schedule(jobname, ...)
-- updates the named job, so rerunning this file is idempotent.
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
  'norva-partners-worker',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://api.norva.tv/functions/v1/norva-partners-worker/cron/run',
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
where jobname = 'norva-partners-worker';
