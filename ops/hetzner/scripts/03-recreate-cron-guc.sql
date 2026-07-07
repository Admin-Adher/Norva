-- =============================================================================
-- 03-recreate-cron-guc.sql — GUCs + vault secrets + pg_cron jobs (self-host)
-- =============================================================================
-- Run against the self-host Postgres AFTER 02-restore-hetzner.sh:
--
--   psql "postgresql://postgres:PWD@127.0.0.1:5432/postgres" \
--     -v FUNCTIONS_BASE_URL="https://api.norva.example/functions/v1" \
--     -v NORVA_BACKFILL_TOKEN="..." \
--     -v NORVA_CRON_SHARED_SECRET="..." \
--     -v RESEND_API_KEY="..." \
--     -f scripts/03-recreate-cron-guc.sql
--
-- These 3 secret values live in your secret store, NEVER in git. The placeholders
-- below abort the run if you forget to pass them.
-- =============================================================================
\set ON_ERROR_STOP on

\if :{?FUNCTIONS_BASE_URL}
\else
  \echo 'ERROR: pass -v FUNCTIONS_BASE_URL=https://api.norva.example/functions/v1'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- 1. Role-level GUCs (matched to prod 2026-07-07)
-- ---------------------------------------------------------------------------
alter role anon          set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- ---------------------------------------------------------------------------
-- 2. App GUC — couche B dual-write stays DORMANT (÷3 storage, activated later)
--    Flip to '1' only when you activate the dedup mirror per the runbook:
--    docs/roadmap/phase2-dedup-activation-runbook.md
-- ---------------------------------------------------------------------------
alter database postgres set app.norva_catalog_dual_write = '0';

-- ---------------------------------------------------------------------------
-- 3. Re-inject the 3 vault secrets (encrypted at rest; cannot be dumped)
-- ---------------------------------------------------------------------------
select vault.create_secret(:'NORVA_BACKFILL_TOKEN',     'norva_backfill_token',     'Norva backfill/service token');
select vault.create_secret(:'NORVA_CRON_SHARED_SECRET', 'norva_cron_shared_secret', 'Shared secret cron jobs send to edge functions');
select vault.create_secret(:'RESEND_API_KEY',           'resend_api_key',           'Resend transactional email API key');

-- ---------------------------------------------------------------------------
-- 4. Recreate the 47 pg_cron jobs, rewriting the managed functions URL
--    to the self-host endpoint.
--    Source: dump/ref-cron-jobs.tsv produced by 01-dump-prod.sh
--    (jobid \t schedule \t jobname \t command).
-- ---------------------------------------------------------------------------
set norva.functions_base_url = :'FUNCTIONS_BASE_URL';

create temp table _cron_import(jobid bigint, schedule text, jobname text, command text);
\copy _cron_import from 'dump/ref-cron-jobs.tsv' with (format text, delimiter E'\t')

do $$
declare
  r record;
  new_cmd text;
  base text := current_setting('norva.functions_base_url');
  n int := 0;
begin
  for r in select * from _cron_import where jobname is not null and jobname <> '' loop
    -- Rewrite the managed project's functions host to the self-host base URL.
    new_cmd := replace(
      r.command,
      'https://oupsceccxsonaalhueff.supabase.co/functions/v1',
      base
    );
    -- cron.schedule(name, schedule, command) upserts by name.
    perform cron.schedule(r.jobname, r.schedule, new_cmd);
    n := n + 1;
  end loop;
  raise notice 'Recreated % cron jobs (rewrote functions URL -> %)', n, base;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Sanity: expected 47 jobs (46 active) as of 2026-07-07.
-- ---------------------------------------------------------------------------
select count(*) as total_jobs,
       count(*) filter (where active) as active_jobs
from cron.job;

\echo 'Done. Verify against prod with scripts/05-verify-parity.sh'
