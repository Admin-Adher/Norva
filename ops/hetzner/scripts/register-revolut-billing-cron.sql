-- =============================================================================
-- Register the Revolut recurring-billing cron on the self-host Postgres.
-- Run ONCE, AFTER validating norva-revolut-billing manually (see below):
--   dpsql < ~/norva/ops/hetzner/scripts/register-revolut-billing-cron.sql
-- Idempotent: cron.schedule replaces a job of the same name.
--
-- Manual validation before scheduling (charges the saved card in sandbox):
--   1) force a trial due:  update public.cloud_entitlement_projection
--        set trial_ends_at = now() - interval '1 min'
--        where user_id = '<uuid>' and provider = 'revolut' and status = 'trialing';
--   2) invoke once (cron secret from .env, never pasted):
--        curl -s -X POST https://api.norva.tv/functions/v1/norva-revolut-billing/cron/run \
--          -H "Authorization: Bearer $(grep -E '^NORVA_CRON_SHARED_SECRET=' ~/norva/ops/hetzner/.env | cut -d= -f2-)"
--   3) expect the projection → active (+ current_period_end ~ +1 period) and a
--      completed row in cloud_revolut_orders.
-- =============================================================================

select cron.schedule('norva-revolut-billing', '23 * * * *', $$
  select net.http_post(
    url := 'https://api.norva.tv/functions/v1/norva-revolut-billing/cron/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
$$);

select jobid, jobname, schedule, active from cron.job where jobname = 'norva-revolut-billing';
