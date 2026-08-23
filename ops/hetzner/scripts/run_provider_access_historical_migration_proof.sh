#!/usr/bin/env bash
# Runs one disposable, DB-only Phase 3 historical migration proof.  Execute on
# the proof host, never against production.  It refuses a reused volume.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run_provider_access_historical_migration_proof.sh --run a|b --workspace /clean/source [--proof-root /var/lib/norva-phase3-proof]
  run_provider_access_historical_migration_proof.sh --compare --proof-root /var/lib/norva-phase3-proof

The workspace must be a clean checkout of the frozen proof commit.  The script
creates no published port and only touches norva-phase3-proof-{a,b}-db.
EOF
}

RUN=""
WORKSPACE=""
PROOF_ROOT="/var/lib/norva-phase3-proof"
PROOF_HOME="/home/adrien/norva-phase3-proof"
IMAGE="supabase/postgres:17.6.1.136"
COMPARE=false

while (($#)); do
  case "$1" in
    --run) RUN="${2:-}"; shift 2 ;;
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --proof-root) PROOF_ROOT="${2:-}"; shift 2 ;;
    --proof-home) PROOF_HOME="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --compare) COMPARE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done

if "$COMPARE"; then
  test -z "$RUN" && test -z "$WORKSPACE" || { usage >&2; exit 64; }
  A="$PROOF_HOME/artifacts/run-a/final-semantic.tsv"
  B="$PROOF_HOME/artifacts/run-b/final-semantic.tsv"
  test -s "$A" && test -s "$B"
  diff -u "$A" "$B"
  sha256sum "$A" "$B"
  exit 0
fi

case "$RUN" in a|b) ;; *) usage >&2; exit 64;; esac
test -n "$WORKSPACE" && test -d "$WORKSPACE"
test -z "$(git -C "$WORKSPACE" status --porcelain --untracked-files=all)"

CONTAINER="norva-phase3-proof-${RUN}-db"
DATA_ROOT="$PROOF_ROOT/run-${RUN}"
DATA_DIR="$DATA_ROOT/db"
REPORT_DIR="$PROOF_HOME/artifacts/run-${RUN}"
OPS_DB="$PROOF_HOME/ops/hetzner/volumes/db"
CONFIG_VOLUME="norva-phase3-proof-db-config"

test -z "$(docker ps -aq --filter "name=^/${CONTAINER}$")" || {
  echo "refusing existing proof container ${CONTAINER}" >&2; exit 65;
}
test ! -e "$DATA_ROOT" || {
  echo "refusing non-fresh proof directory ${DATA_ROOT}" >&2; exit 65;
}
test -d "$OPS_DB" && test -d "$PROOF_HOME"
mkdir -p "$REPORT_DIR"

{
  printf 'frozen_commit=%s\n' "$(git -C "$WORKSPACE" rev-parse HEAD)"
  printf 'migration_tree_sha256=%s\n' "$(find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  printf 'raw_fixture_sha256=%s\n' "$(sha256sum "$WORKSPACE/supabase/tests/fixtures/provider_catalog_generation_online_legacy_seed.sql" | awk '{print $1}')"
  printf 'pre_contraction_harness_sha256=%s\n' "$(sha256sum "$WORKSPACE/supabase/tests/provider_access_lifecycle_pre_contraction.sql" | awk '{print $1}')"
  printf 'post_contraction_harness_sha256=%s\n' "$(sha256sum "$WORKSPACE/supabase/tests/provider_access_lifecycle_post_contraction.sql" | awk '{print $1}')"
  printf 'last_pre_contraction_migration=%s\n' '20260823179920_catalog_generation_flag_gate.sql'
  printf 'first_contraction_migration=%s\n' '20260823180000_provider_catalog_generation_online_rollout.sql'
  printf 'current_phase3_head=%s\n' '20260823194000_replacement_promotion_proof_account_delete.sql'
} > "$REPORT_DIR/manifest.txt"

password="norva_phase3_proof_${RUN}_only"
docker run -d \
  --name "$CONTAINER" \
  --network norva-phase3-proof-net \
  --label norva.phase3.proof=true \
  --label "norva.phase3.run=${RUN}" \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER=supabase_admin \
  -e POSTGRES_PASSWORD="$password" \
  -e JWT_SECRET="norva_phase3_proof_jwt_${RUN}_only" \
  -e JWT_EXP=3600 \
  -v "$DATA_DIR":/var/lib/postgresql/data \
  -v "$WORKSPACE":/workspace:ro \
  -v "$OPS_DB/jwt.sql":/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro \
  -v "$OPS_DB/webhooks.sql":/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql:ro \
  -v "$OPS_DB/roles.sql":/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro \
  -v "$OPS_DB/_supabase.sql":/docker-entrypoint-initdb.d/migrations/97-_supabase.sql:ro \
  -v "$OPS_DB/logs.sql":/docker-entrypoint-initdb.d/migrations/99-logs.sql:ro \
  -v "$OPS_DB/pooler.sql":/docker-entrypoint-initdb.d/migrations/99-pooler.sql:ro \
  -v "$OPS_DB/realtime.sql":/docker-entrypoint-initdb.d/migrations/99-realtime.sql:ro \
  -v "$CONFIG_VOLUME":/etc/postgresql-custom:ro \
  "$IMAGE" postgres \
    -c config_file=/etc/postgresql/postgresql.conf \
    -c shared_buffers=512MB -c effective_cache_size=2GB -c work_mem=8MB \
    -c maintenance_work_mem=256MB -c max_connections=75 -c max_wal_size=2GB \
    -c archive_mode=off > "$REPORT_DIR/container-id.txt"

for attempt in {1..30}; do
  docker exec "$CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null

psql_file() {
  local file="$1" output="$2"
  docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$file" > "$output" 2>&1
}

psql_file "$WORKSPACE/ops/hetzner/scripts/phase3-proof-bootstrap-compat.sql" "$REPORT_DIR/bootstrap.txt"

apply_range() {
  local lower="$1"
  local upper="$2"
  local log="$REPORT_DIR/migrations-${upper}.log"
  local list="$REPORT_DIR/migrations-${upper}.txt"
  find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort |
    awk -v lower="$lower" -v upper="$upper" '$0 > lower && $0 <= upper' > "$list"
  grep -qx "$upper" "$list"
  while IFS= read -r migration; do
    printf 'APPLY %s\n' "$migration" | tee -a "$log"
    if grep -Eiq '^[[:space:]]*(create|drop)[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently' "$WORKSPACE/supabase/migrations/$migration"; then
      docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$WORKSPACE/supabase/migrations/$migration" >> "$log" 2>&1
    else
      docker exec -i "$CONTAINER" psql -X -1 -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$WORKSPACE/supabase/migrations/$migration" >> "$log" 2>&1
    fi
  done < "$list"
  printf 'APPLY_RANGE_OK lower=%s upper=%s count=%s\n' "$lower" "$upper" "$(wc -l < "$list")" | tee -a "$log"
}

PRE_FIXTURE_HEAD="20260823110700_cloud_titles_candidate_shell_guard.sql"
PRE_HEAD="20260823179920_catalog_generation_flag_gate.sql"
CONTRACTION="20260823180000_provider_catalog_generation_online_rollout.sql"
ONLINE_HEAD="20260823182700_series_inventory_generation_parent_natural_fk.sql"
CURRENT_HEAD="20260823194000_replacement_promotion_proof_account_delete.sql"

apply_range "00000000000000" "$PRE_FIXTURE_HEAD"
psql_file "$WORKSPACE/supabase/tests/fixtures/provider_catalog_generation_online_legacy_seed.sql" "$REPORT_DIR/legacy-fixture.txt"
apply_range "$PRE_FIXTURE_HEAD" "$PRE_HEAD"
psql_file "$WORKSPACE/supabase/tests/provider_access_lifecycle_pre_contraction.sql" "$REPORT_DIR/pre-harness.txt"

docker exec -i "$CONTAINER" psql -X -At -U supabase_admin -d postgres <<'SQL' > "$REPORT_DIR/pre-semantic.tsv"
select 'fixture_counts',
 (select count(*) from public.cloud_sources where id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_media_items where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_title_variants where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_live_variants where source_id='22222222-2222-2222-2222-222222222222');
select 'generations',count(*) from public.cloud_source_catalog_generations where source_id='22222222-2222-2222-2222-222222222222';
select 'heads',count(*) from public.cloud_source_catalog_heads where source_id='22222222-2222-2222-2222-222222222222';
SQL

apply_range "$PRE_HEAD" "$CONTRACTION"
docker exec -i "$CONTAINER" psql -X -At -U supabase_admin -d postgres <<'SQL' > "$REPORT_DIR/contraction-defined.tsv"
select to_regprocedure('public.norva_contract_catalog_generation_rollout(text)') is not null,
       contracted_at is null
from public.cloud_catalog_generation_rollout where singleton;
SQL
grep -qx 't|t' "$REPORT_DIR/contraction-defined.tsv"
apply_range "$CONTRACTION" "$ONLINE_HEAD"

docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <<'SQL' > "$REPORT_DIR/contraction.txt"
set statement_timeout = '5min';
set lock_timeout = '2s';
do $discovery$
declare result jsonb;
begin
  for iteration in 1..64 loop
    result := public.norva_discover_catalog_generation_backfill_sources(100);
    exit when coalesce((result ->> 'discoveryComplete')::boolean,false);
  end loop;
  if not coalesce((result ->> 'discoveryComplete')::boolean,false) then raise exception 'discovery did not converge'; end if;
end $discovery$;
do $backfill$
declare result jsonb;
begin
  for iteration in 1..128 loop
    result := public.norva_backfill_catalog_generation_batch('historical-proof',500,120);
    exit when not coalesce((result ->> 'claimed')::boolean,false);
  end loop;
  if exists (select 1 from public.cloud_catalog_generation_backfill_sources where state <> 'complete') then raise exception 'backfill did not converge'; end if;
end $backfill$;
do $validation$
declare result jsonb;
begin
  for iteration in 1..64 loop
    result := public.norva_validate_catalog_generation_constraints(2);
    exit when coalesce((result ->> 'remaining')::integer,1) = 0;
  end loop;
  if coalesce((result ->> 'remaining')::integer,1) <> 0 then raise exception 'validation did not converge'; end if;
end $validation$;
select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch');
select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch');
SQL

apply_range "$ONLINE_HEAD" "$CURRENT_HEAD"
psql_file "$WORKSPACE/supabase/tests/provider_access_lifecycle_post_contraction.sql" "$REPORT_DIR/post-harness.txt"
psql_file "$WORKSPACE/supabase/tests/provider_credential_transition.sql" "$REPORT_DIR/credential-transition.txt"
psql_file "$WORKSPACE/supabase/tests/catalog_background_owner_snapshot_concurrency_smoke.sql" "$REPORT_DIR/snapshot-owner.txt"
psql_file "$WORKSPACE/supabase/tests/provider_account_delete_concurrency_smoke.sql" "$REPORT_DIR/provider-account-delete.txt"
psql_file "$WORKSPACE/supabase/tests/account_deletion_workflow_claim_concurrency_smoke.sql" "$REPORT_DIR/account-delete-claims.txt"
psql_file "$WORKSPACE/supabase/tests/account_deletion_product_reaper_smoke.sql" "$REPORT_DIR/account-delete-reaper.txt"

docker exec -i "$CONTAINER" psql -X -At -U supabase_admin -d postgres <<'SQL' > "$REPORT_DIR/final-semantic.tsv"
select 'fixture_counts',
 (select count(*) from public.cloud_sources where id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_media_items where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_title_variants where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_live_logical_channels where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.cloud_live_variants where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.catalog_series_episode_memberships where source_id='22222222-2222-2222-2222-222222222222'),
 (select count(*) from public.catalog_series_inventory_state where source_id='22222222-2222-2222-2222-222222222222');
select 'fixture_generation',state,count(*) from public.cloud_source_catalog_generations where source_id='22222222-2222-2222-2222-222222222222' group by state order by state;
select 'fixture_head',head.head_revision,generation.state from public.cloud_source_catalog_heads head join public.cloud_source_catalog_generations generation on generation.id=head.active_generation_id where head.source_id='22222222-2222-2222-2222-222222222222';
select 'fixture_backfill',state,count(*) from public.cloud_catalog_generation_backfill_sources where source_id='22222222-2222-2222-2222-222222222222' group by state order by state;
select 'rollout',phase,contracted_at is not null,discovery_complete,discovered_sources,completed_sources,validation_completed_count from public.cloud_catalog_generation_rollout where singleton;
select 'fence_columns',count(*) from pg_attribute where attrelid in ('public.cloud_media_items'::regclass,'public.cloud_title_variants'::regclass,'public.cloud_live_logical_channels'::regclass,'public.cloud_live_variants'::regclass,'public.catalog_series_episode_memberships'::regclass,'public.catalog_series_inventory_state'::regclass) and attname='generation_id' and attnotnull;
select 'flags',count(*) filter (where enabled),count(*) from public.admin_feature_flags where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');
select 'dblink',exists(select 1 from pg_extension where extname='dblink');
SQL

grep -qx '1..72' <(grep '^ 1\.\.72\|^1\.\.72' "$REPORT_DIR/credential-transition.txt" | tr -d ' ')
sha256sum "$REPORT_DIR/final-semantic.tsv" > "$REPORT_DIR/final-semantic.sha256"
echo "PROOF_RUN_${RUN}_OK"
