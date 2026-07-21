-- =============================================================================
-- 03-recreate-cron-guc.sql — GUCs + vault secrets + pg_cron jobs (self-host)
-- =============================================================================
-- Run against the self-host Postgres AFTER 02-restore-hetzner.sh:
--
--   psql "postgresql://postgres:PWD@127.0.0.1:5432/postgres" \
--     -v FUNCTIONS_BASE_URL="https://api.norva.example/functions/v1" \
--     -v NORVA_BACKFILL_TOKEN="..." \
--     -v NORVA_CRON_SHARED_SECRET="..." \
--     -f scripts/03-recreate-cron-guc.sql
--
-- These 2 secret values live in your secret store, NEVER in git. The placeholders
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
-- 3. Re-inject the 2 DB vault secrets (encrypted at rest; cannot be dumped).
-- Resend is intentionally Edge/ops-only; never put either Resend key in DB Vault.
-- ---------------------------------------------------------------------------
select vault.create_secret(:'NORVA_BACKFILL_TOKEN',     'norva_backfill_token',     'Norva backfill/service token');
select vault.create_secret(:'NORVA_CRON_SHARED_SECRET', 'norva_cron_shared_secret', 'Shared secret cron jobs send to edge functions');

-- ---------------------------------------------------------------------------
-- 4. Recreate the pg_cron jobs, rewriting the managed functions URL to the
--    self-host endpoint. NOT done here: cron commands are MULTI-LINE, so the
--    old `\copy from ref-cron-jobs.tsv` import was corrupt (286 lines for 49
--    jobs at the 2026-07-11 cutover). Use dump/ref-cron-jobs.sql from
--    01-dump-prod.sh instead — replayable `cron.schedule(%L,…)` statements:
--
--      sed 's#https://oupsceccxsonaalhueff.supabase.co/functions/v1#https://api.norva.tv/functions/v1#g' \
--        dump/ref-cron-jobs.sql | psql "$TARGET" -v ON_ERROR_STOP=0 -f -
--
--    (Or regenerate live from the managed DB — see CUTOVER-LOG-2026-07-11.md §9.)
--    Jobs come back ACTIVE; stage them if the flip isn't now:
--      update cron.job set active = false;
--    At the flip, mirror prod's inactive set:
--      update cron.job set active =
--        (jobname not in ('norva-audio-airo-ninja','norva-audio-airo-ninja-series'));
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Sanity: expected 47 jobs (46 active) as of 2026-07-07.
-- ---------------------------------------------------------------------------
select count(*) as total_jobs,
       count(*) filter (where active) as active_jobs
from cron.job;

\echo 'Done. Verify against prod with scripts/05-verify-parity.sh'
