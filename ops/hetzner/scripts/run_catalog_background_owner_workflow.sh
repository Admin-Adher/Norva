#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:-norva-db}"
readonly ACTION="${1:-preflight}"
readonly MAX_SLICES="${MAX_SLICES:-10}"
readonly SLICE_LIMIT="${SLICE_LIMIT:-2000}"
readonly LEASE_SECONDS="${LEASE_SECONDS:-600}"

if [[ "$DB_CONTAINER" != 'norva-db' ]]; then
  if [[ "${CONFIRM_DISPOSABLE_PROOF_DB:-}" != 'ALLOW_NORVA_DISPOSABLE_CLONE' \
     || ! "$DB_CONTAINER" =~ ^norva-phase123-prod-clone-[a-z0-9-]+-db$ ]]; then
    echo "refusing unexpected production database container: $DB_CONTAINER" >&2
    exit 64
  fi
fi
if [[ "$ACTION" != 'preflight' && "$ACTION" != 'drain' ]]; then
  echo 'usage: run_catalog_background_owner_workflow.sh [preflight|drain]' >&2
  exit 64
fi
if [[ ! "$MAX_SLICES" =~ ^[0-9]+$ ]] || (( MAX_SLICES < 1 || MAX_SLICES > 500 )); then
  echo 'MAX_SLICES must be between 1 and 500' >&2
  exit 64
fi
if [[ ! "$SLICE_LIMIT" =~ ^[0-9]+$ ]] || (( SLICE_LIMIT < 100 || SLICE_LIMIT > 5000 )); then
  echo 'SLICE_LIMIT must be between 100 and 5000' >&2
  exit 64
fi
if [[ ! "$LEASE_SECONDS" =~ ^[0-9]+$ ]] || (( LEASE_SECONDS < 30 || LEASE_SECONDS > 600 )); then
  echo 'LEASE_SECONDS must be between 30 and 600' >&2
  exit 64
fi

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

snapshot() {
  psql_admin -Atq <<'SQL'
with population as (
  select distinct source.user_id
  from public.cloud_sources source
  where exists (
    select 1 from public.cloud_source_catalog_heads head
    where head.source_id=source.id and head.user_id=source.user_id
  )
)
select concat_ws('|',
  count(*)::text,
  count(*) filter (
    where public.norva_catalog_background_owner_baseline_current(user_id)
  )::text,
  (select count(*) from public.cloud_catalog_background_owner_pointers)::text,
  (select count(*) from public.cloud_catalog_background_owner_build_jobs
    where state not in ('completed','dead'))::text,
  (select count(*) from public.cloud_catalog_background_owner_build_jobs
    where state='dead')::text,
  (select count(*) from public.cloud_catalog_background_mode_checkpoints)::text
)
from population;
SQL
}

print_snapshot() {
  local value="$1"
  local population current pointers nonterminal dead checkpoints
  IFS='|' read -r population current pointers nonterminal dead checkpoints <<<"$value"
  printf 'owner_population=%s\ncurrent_owner_baselines=%s\nactive_owner_pointers=%s\n' \
    "$population" "$current" "$pointers"
  printf 'nonterminal_owner_jobs=%s\ndead_owner_jobs=%s\nbackground_mode_checkpoints=%s\n' \
    "$nonterminal" "$dead" "$checkpoints"
}

ready_snapshot() {
  local value="$1"
  local population current pointers nonterminal dead checkpoints
  IFS='|' read -r population current pointers nonterminal dead checkpoints <<<"$value"
  [[ "$population" == "$current" && "$population" == "$pointers" \
     && "$nonterminal" == '0' && "$dead" == '0' && "$checkpoints" == '3' ]]
}

readonly BEFORE="$(snapshot)"
print_snapshot "$BEFORE"
if [[ "$ACTION" == 'preflight' ]]; then
  if ready_snapshot "$BEFORE"; then
    echo 'status=OWNER_WORKFLOW_READY'
    exit 0
  fi
  echo 'status=WAIT_OWNER_WORKFLOW'
  exit 75
fi

if [[ "${CONFIRM_CATALOG_BACKGROUND_OWNER_WORKFLOW:-}" \
      != 'DRAIN_CATALOG_BACKGROUND_OWNER_WORKFLOW' ]]; then
  echo 'status=REFUSED_MISSING_EXPLICIT_OWNER_WORKFLOW_CONFIRMATION' >&2
  exit 64
fi

readonly WORKER="catalog-owner-bootstrap-$(date -u +%Y%m%dT%H%M%SZ)-$$"
slices=0
current_job=''
current_lease_sequence=''
current_checkpoint_revision=''

while (( slices < MAX_SLICES )); do
  CLAIM="$(psql_admin -Atq \
    -v worker="$WORKER" -v lease_seconds="$LEASE_SECONDS" <<'SQL'
begin;
set local role service_role;
select concat_ws('|',
  claim.job_id::text,
  claim.job_kind,
  claim.lease_sequence::text,
  claim.checkpoint_revision::text,
  claim.lease_until::text
)
from public.norva_claim_catalog_background_owner_build_jobs(
  :'worker',1,:'lease_seconds'::integer
) claim
limit 1;
commit;
SQL
)"
  if [[ -z "$CLAIM" ]]; then
    AFTER_EMPTY="$(snapshot)"
    print_snapshot "$AFTER_EMPTY"
    if ready_snapshot "$AFTER_EMPTY"; then
      echo "slices_run=$slices"
      echo 'status=OWNER_WORKFLOW_COMPLETED'
      exit 0
    fi
    echo 'status=REFUSED_OWNER_WORKFLOW_NO_CLAIM_WITH_INCOMPLETE_COVERAGE' >&2
    exit 70
  fi

  IFS='|' read -r current_job job_kind current_lease_sequence \
    current_checkpoint_revision lease_until <<<"$CLAIM"
  printf 'claimed_job=%s\njob_kind=%s\nlease_sequence=%s\nlease_until=%s\n' \
    "$current_job" "$job_kind" "$current_lease_sequence" "$lease_until"

  while (( slices < MAX_SLICES )); do
    STEP="$(psql_admin -Atq \
      -v job_id="$current_job" -v worker="$WORKER" \
      -v lease_sequence="$current_lease_sequence" \
      -v checkpoint_revision="$current_checkpoint_revision" \
      -v slice_limit="$SLICE_LIMIT" <<'SQL'
begin;
set local role service_role;
with step as (
  select public.norva_run_catalog_background_owner_build_job_slice(
    :'job_id'::uuid,:'worker',:'lease_sequence'::integer,
    :'checkpoint_revision'::bigint,:'slice_limit'::integer
  ) result
)
select concat_ws('|',
  result ->> 'state',
  result ->> 'checkpointRevision',
  coalesce(result ->> 'complete','false'),
  coalesce(result ->> 'leaseRetained','false'),
  coalesce(result ->> 'activationPending','false'),
  coalesce(result ->> 'finalizationPending','false')
)
from step;
commit;
SQL
)"
    IFS='|' read -r step_state current_checkpoint_revision complete \
      lease_retained activation_pending finalization_pending <<<"$STEP"
    slices=$((slices + 1))
    printf 'slice=%s\nstate=%s\ncheckpoint_revision=%s\ncomplete=%s\n' \
      "$slices" "$step_state" "$current_checkpoint_revision" "$complete"
    printf 'lease_retained=%s\nactivation_pending=%s\nfinalization_pending=%s\n' \
      "$lease_retained" "$activation_pending" "$finalization_pending"
    if [[ "$complete" == 'true' ]]; then
      current_job=''
      break
    fi
  done

  if [[ -n "$current_job" && $slices -ge $MAX_SLICES ]]; then
    psql_admin -Atq \
      -v job_id="$current_job" -v worker="$WORKER" \
      -v lease_sequence="$current_lease_sequence" \
      -v checkpoint_revision="$current_checkpoint_revision" <<'SQL'
begin;
set local role service_role;
select public.norva_checkpoint_catalog_background_owner_build_job(
  :'job_id'::uuid,:'worker',:'lease_sequence'::integer,
  :'checkpoint_revision'::bigint,0
);
commit;
SQL
  fi
done

readonly AFTER="$(snapshot)"
print_snapshot "$AFTER"
echo "slices_run=$slices"
if ready_snapshot "$AFTER"; then
  echo 'status=OWNER_WORKFLOW_COMPLETED'
  exit 0
fi
echo 'status=OWNER_WORKFLOW_PROGRESS_CHECKPOINTED'
exit 75
