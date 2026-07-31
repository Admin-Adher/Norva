-- =============================================================================
-- Register the legacy Norva Partners Airwallex dispatch/reconciliation worker.
--
-- DO NOT run this file merely because the code was deployed. Run manually as
-- the cron owner only after:
--   1) the Airwallex sandbox credentials and signed webhook are configured;
--   2) the payout migration, Node/Deno tests and sandbox late-failure replay
--      have passed;
--   3) the provider country/currency route and every release gate are approved;
--   4) /cron/run has been smoke-tested while partners_payouts_live=false and
--      proved that no lease/provider transfer can be created;
--   5) Finance explicitly authorizes scheduling.
--
-- Registration is deliberately operational, not a migration. This file
-- activates no provider route and no feature flag.
--
-- Revolut Basic cutover note: the current Norva schema permits only Revolut
-- routes in production. This script therefore fails closed unless a future
-- migration deliberately restores an active Airwallex API route.
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
  if not exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key = 'partners_payouts_live'
  ) then
    raise exception 'partners_payouts_live flag is not installed';
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.provider = 'airwallex'
      and config.execution_adapter = 'airwallex_api'
      and config.status = 'active'
  ) then
    raise exception
      'no active Airwallex API payout route; legacy cron remains disabled';
  end if;
end
$preflight$;

select cron.schedule(
  'norva-partners-payout',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url :=
        'https://api.norva.tv/functions/v1/norva-partners-payout/cron/run',
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
where jobname = 'norva-partners-payout';
