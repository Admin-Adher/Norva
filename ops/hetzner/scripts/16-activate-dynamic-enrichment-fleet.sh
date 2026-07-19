#!/usr/bin/env bash
set -euo pipefail

# Guarded cutover from UUID-pinned audio/subtitle crons to the dynamic fleet.
# Run from ~/norva/ops/hetzner after:
#   1. pulling/restarting the edge functions with norva-source-sync v10;
#   2. applying migrations through
#      20260719190000_provider_overview_crawler.sql.
#
# The migration intentionally leaves the new cron inactive. This script proves
# the deployed edge sees its token + queue schema, then switches old -> new in a
# single database transaction. Explicit subtitle pre-generation jobs
# (transcribe-whitelist) and the exact legacy series-language job stay active
# until the dynamic fleet can safely identify exact episode files.

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${NORVA_ENV_FILE:-$HERE/.env}"
API_BASE="${NORVA_API_BASE:-https://api.norva.tv}"
DYNAMIC_CRON_URL="$API_BASE/functions/v1/norva-source-sync/cron/enrichment-fleet?limit=8"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${NORVA_CRON_SHARED_SECRET:?NORVA_CRON_SHARED_SECRET is required}"

health="$(
  curl --fail --silent --show-error --max-time 15 \
    "$API_BASE/functions/v1/norva-source-sync/health"
)"
case "$health" in
  *'"version":10'*'"dynamicEnrichmentFleet":true'*) ;;
  *)
    echo "Edge preflight failed: norva-source-sync v10 dynamic fleet is not live" >&2
    exit 1
    ;;
esac

preflight="$(
  curl --fail --silent --show-error --max-time 20 \
    -X POST \
    -H "Authorization: Bearer $NORVA_CRON_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    "$API_BASE/functions/v1/norva-source-sync/cron/enrichment-fleet?dryRun=1"
)"
case "$preflight" in
  *'"ok":true'*'"dryRun":true'*) ;;
  *)
    echo "Dispatcher preflight failed: token, RPC, or scheduler schema is unavailable" >&2
    exit 1
    ;;
esac
case "$preflight" in
  *'"schemaVersion":3'*) ;;
  *)
    echo "Dispatcher preflight failed: enrichment schema v3 is not live" >&2
    exit 1
    ;;
esac
case "$preflight" in
  *'"providerOverviewReady":true'*) ;;
  *)
    echo "Dispatcher preflight failed: provider synopsis crawler is unavailable" >&2
    exit 1
    ;;
esac

docker exec -i norva-db psql \
  -v ON_ERROR_STOP=1 \
  -v "dynamic_cron_url=$DYNAMIC_CRON_URL" \
  -v "cron_shared_secret=$NORVA_CRON_SHARED_SECRET" \
  -U supabase_admin \
  -d postgres <<'SQL'
begin;

-- Keep the shell secret that passed HTTP preflight out of logs while making it
-- available to the transactional Vault equality guard below. INSERT reports
-- only its row count; unlike set_config(), it never prints the secret value.
create temporary table norva_cutover_context (
  cron_secret text not null
) on commit drop;
insert into norva_cutover_context (cron_secret)
values (:'cron_shared_secret');

do $guard$
declare
  vault_secret text;
begin
  select decrypted_secret
    into vault_secret
    from vault.decrypted_secrets
   where name = 'norva_cron_shared_secret';
  if nullif(vault_secret, '') is null then
    raise exception 'Vault norva_cron_shared_secret is missing or empty';
  end if;
  if vault_secret is distinct from (
    select cron_secret from norva_cutover_context
  ) then
    raise exception 'environment and Vault cron secrets differ';
  end if;
  if to_regprocedure('public.claim_catalog_enrichment_sources(integer,integer)') is null
     or to_regprocedure('public.finish_catalog_enrichment_source(uuid,uuid,boolean,integer,boolean,jsonb)') is null
     or to_regprocedure('public.catalog_enrichment_fleet_preflight()') is null
     or to_regprocedure('public.claim_provider_overview_candidates(uuid,uuid,integer)') is null
     or to_regprocedure('public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb)') is null then
    raise exception 'dynamic enrichment RPCs are missing';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'norva-dynamic-enrichment-fleet'
  ) then
    raise exception 'norva-dynamic-enrichment-fleet cron is missing';
  end if;
end
$guard$;

update cron.job
   set active = false
 where command like '%/norva-playback/audio-backfill%'
   and command not like '%transcribe-whitelist%'
   and jobname <> 'norva-whisper-airo-king365-series'
   and command !~* $series_pattern$('type'\s*,\s*'series'|"type"\s*:\s*"series")$series_pattern$;

-- Keep test/staging overrides and the actual scheduled destination identical
-- to the URL that passed the HTTP preflight above.
update cron.job
   set command = format(
     $command$
       select net.http_post(
         url := %L,
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'Authorization', 'Bearer ' || (
             select decrypted_secret
             from vault.decrypted_secrets
             where name = 'norva_cron_shared_secret'
           )
         ),
         body := '{}'::jsonb,
         timeout_milliseconds := 10000
       );
     $command$,
     :'dynamic_cron_url'
   )
 where jobname = 'norva-dynamic-enrichment-fleet';

update cron.job
   set active = true
 where jobname = 'norva-dynamic-enrichment-fleet';

-- Fail closed and roll back the whole cutover if any legacy movie detector
-- remains or the dynamic job is not uniquely active. The series job is
-- intentionally excluded because the replacement is movie-only.
do $post_cutover$
declare
  active_legacy_movies integer;
  active_dynamic integer;
begin
  select count(*)
    into active_legacy_movies
    from cron.job
   where active
     and command like '%/norva-playback/audio-backfill%'
     and command not like '%transcribe-whitelist%'
     and jobname <> 'norva-whisper-airo-king365-series'
     and command !~* $series_pattern$('type'\s*,\s*'series'|"type"\s*:\s*"series")$series_pattern$;

  select count(*)
    into active_dynamic
    from cron.job
   where active
     and jobname = 'norva-dynamic-enrichment-fleet';

  if active_legacy_movies <> 0 or active_dynamic <> 1 then
    raise exception
      'unsafe enrichment cutover: legacy movie jobs %, dynamic jobs %',
      active_legacy_movies,
      active_dynamic;
  end if;
end
$post_cutover$;

commit;

select
  count(*) filter (
    where active
      and command like '%/norva-playback/audio-backfill%'
      and command not like '%transcribe-whitelist%'
      and jobname <> 'norva-whisper-airo-king365-series'
      and command !~* $series_pattern$('type'\s*,\s*'series'|"type"\s*:\s*"series")$series_pattern$
  ) as legacy_movie_detection_jobs_still_active,
  count(*) filter (
    where active
      and command like '%/norva-playback/audio-backfill%'
      and (
        jobname = 'norva-whisper-airo-king365-series'
        or command ~* $series_pattern$('type'\s*,\s*'series'|"type"\s*:\s*"series")$series_pattern$
      )
  ) as preserved_legacy_series_jobs_active,
  count(*) filter (
    where active and jobname = 'norva-dynamic-enrichment-fleet'
  ) as dynamic_jobs_active
from cron.job;
SQL

echo "Dynamic enrichment fleet activated."
