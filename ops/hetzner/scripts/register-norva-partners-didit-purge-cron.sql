-- Register the bounded Didit deletion worker only after its Edge smoke test,
-- keyring configuration and migration/restore verification have passed.
-- Rerunning this file replaces the named schedule idempotently.

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
  if to_regprocedure(
    'public.partners_service_didit_purge_claim(integer,integer)'
  ) is null then
    raise exception 'Didit purge migration is not installed';
  end if;
end
$preflight$;

select cron.schedule(
  'norva-partners-didit-purge-worker',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://api.norva.tv/functions/v1/norva-partners-didit-purge-worker/cron/run',
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
where jobname = 'norva-partners-didit-purge-worker';
