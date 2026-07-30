-- =============================================================================
-- Register the Norva Partners Airwallex Financial Reports worker.
--
-- This is an explicit operational action, never a migration. Do not run it
-- until all of the following are true:
--   1) AIRWALLEX_FINANCIAL_REPORTS_ENABLED=true is set outside Git;
--   2) the matching sandbox/production report contract has been approved by a
--      Finance actor with AAL2 after inspecting and hashing a real CSV;
--   3) /cron/reports passed a cron-authenticated smoke test;
--   4) the Admin report status exposes no exception/stale alert;
--   5) Finance authorizes scheduling.
--
-- Usage (the variable must match AIRWALLEX_ENVIRONMENT in Edge secrets):
--   psql "$DATABASE_URL" \
--     -v airwallex_environment=sandbox \
--     -f register-norva-partners-airwallex-reports-cron.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $preflight$
declare
  v_environment text := lower(btrim(:'airwallex_environment'));
begin
  if v_environment not in ('sandbox', 'production') then
    raise exception 'airwallex_environment must be sandbox or production';
  end if;
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
    from affiliate_private.affiliate_airwallex_report_contracts contract
    where contract.environment = v_environment
      and contract.status = 'approved'
      and contract.contract_version =
        'transaction_recon_csv_1_1_0_preamble_v1'
      and contract.api_version = '2024-04-30'
      and contract.report_version = '1.1.0'
      and contract.approved_evidence_hash ~ '^[0-9a-f]{64}$'
      and contract.approved_at is not null
  ) then
    raise exception
      'Airwallex report contract is not Finance-approved for %',
      v_environment;
  end if;
end
$preflight$;

select cron.schedule(
  'norva-partners-airwallex-reports',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url :=
        'https://api.norva.tv/functions/v1/norva-partners-payout/cron/reports',
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
where jobname = 'norva-partners-airwallex-reports';
