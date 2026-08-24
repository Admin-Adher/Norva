#!/usr/bin/env bash
# Install the additive Phase 1-3 database contract on the self-hosted production
# database. This intentionally stops before cache-v2 completion and before any
# Provider Access feature flag is enabled.
set -euo pipefail

WORKSPACE="${WORKSPACE:-}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
REPORT_DIR="${REPORT_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-norva-db}"

fail() { printf 'PHASE123_PRODUCTION_INSTALL_FAIL %s\n' "$*" >&2; exit 1; }
test -n "$WORKSPACE" || fail 'WORKSPACE is required'
test -n "$EXPECTED_COMMIT" || fail 'EXPECTED_COMMIT is required'
test -n "$REPORT_DIR" || fail 'REPORT_DIR is required'
case "$WORKSPACE" in /home/adrien/norva-deployments/phase123-*) ;; *) fail 'unexpected workspace' ;; esac
case "$REPORT_DIR" in /var/lib/norva-phase3-proof/production-deploy-*) ;; *) fail 'unexpected report directory' ;; esac
test "$DB_CONTAINER" = norva-db || fail 'unexpected database container'
test -d "$REPORT_DIR" || fail 'report directory is missing'
test ! -e "$REPORT_DIR/INSTALL_COMPLETE" || fail 'install already completed'

exec 9>"$REPORT_DIR/install.lock"
flock -n 9 || fail 'another production install owns the lock'
exec > >(tee -a "$REPORT_DIR/install.log") 2>&1

test "$(git -C "$WORKSPACE" rev-parse HEAD)" = "$EXPECTED_COMMIT" || fail 'workspace commit mismatch'
test -z "$(git -C "$WORKSPACE" status --porcelain)" || fail 'workspace is dirty'
git -C "$WORKSPACE" cat-file -e "${EXPECTED_COMMIT}^{commit}"
test "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER")" = true || fail 'database is not running'
test "$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")" = 'supabase/postgres:17.6.1.136' || fail 'database image mismatch'
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql/data\"}}{{.Source}}{{end}}{{end}}' "$DB_CONTAINER")" = '/var/lib/norva/db' || fail 'database mount mismatch'

psql_scalar() {
  docker exec -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
    "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -c "$1"
}
psql_contract_scalar() {
  docker exec -e PGOPTIONS='-c statement_timeout=300000 -c lock_timeout=5000' \
    "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -c "$1"
}
psql_service_scalar() {
  docker exec -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
    "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
    -c "set role service_role; $1"
}

baseline_sql="select count(*) from pg_class where relnamespace='public'::regnamespace and relname in ('cloud_global_catalog_visibility_epoch','cloud_catalog_generation_rollout','cloud_source_catalog_generations','cloud_source_credential_candidates');"
test "$(psql_scalar "$baseline_sql")" = 0 || fail 'Phase 1-3 objects already exist; refuse ambiguous replay'

{
  printf 'started_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'commit=%s\n' "$EXPECTED_COMMIT"
  printf 'migration_tree_sha256=%s\n' "$(find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  printf 'database_size_bytes=%s\n' "$(psql_scalar 'select pg_database_size(current_database())')"
  printf 'auth_users=%s\n' "$(psql_scalar 'select count(*) from auth.users')"
  printf 'cloud_sources=%s\n' "$(psql_scalar 'select count(*) from public.cloud_sources')"
  printf 'cloud_media_items=%s\n' "$(psql_scalar 'select count(*) from public.cloud_media_items')"
} >"$REPORT_DIR/install-manifest.txt"

apply_range() {
  local lower="$1" upper="$2" label="$3"
  local list="$REPORT_DIR/migrations-${label}.txt"
  find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort |
    awk -v lower="$lower" -v upper="$upper" '$0 > lower && $0 <= upper' >"$list"
  grep -qx "$upper" "$list" || fail "migration range $label does not reach $upper"
  while IFS= read -r migration; do
    printf 'APPLY %s %s\n' "$(date -u +%FT%TZ)" "$migration"
    if grep -Eiq '^[[:space:]]*(create|drop)[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently' "$WORKSPACE/supabase/migrations/$migration"; then
      docker exec -i -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
        "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        <"$WORKSPACE/supabase/migrations/$migration"
    else
      docker exec -i -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
        "$DB_CONTAINER" psql -X -1 -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        <"$WORKSPACE/supabase/migrations/$migration"
    fi
    printf 'APPLIED %s %s\n' "$(date -u +%FT%TZ)" "$migration"
  done <"$list"
}

PRE_HEAD=20260823179920_catalog_generation_flag_gate.sql
CONTRACTION=20260823180000_provider_catalog_generation_online_rollout.sql
ONLINE_HEAD=20260823182700_series_inventory_generation_parent_natural_fk.sql
CURRENT_HEAD=20260823194000_replacement_promotion_proof_account_delete.sql
CACHE_HEAD=20260824100000_catalog_cache_epoch_v2.sql

apply_range 20260822219999 "$PRE_HEAD" pre-contraction
apply_range "$PRE_HEAD" "$CONTRACTION" contraction-definition
apply_range "$CONTRACTION" "$ONLINE_HEAD" online-indexes

for iteration in $(seq 1 256); do
  complete="$(psql_scalar "select coalesce((public.norva_backfill_provider_access_foundation(500)->>'complete')::boolean,false)")"
  printf 'FOUNDATION iteration=%s complete=%s\n' "$iteration" "$complete"
  test "$complete" = t && break
done
test "${complete:-f}" = t || fail 'provider access foundation did not converge'

for iteration in $(seq 1 256); do
  complete="$(psql_service_scalar "select coalesce((public.norva_backfill_source_provider_account_affinities(500)->>'complete')::boolean,false)")"
  printf 'AFFINITY iteration=%s complete=%s\n' "$iteration" "$complete"
  test "$complete" = t && break
done
test "${complete:-f}" = t || fail 'provider account affinity did not converge'

for iteration in $(seq 1 8192); do
  complete="$(psql_service_scalar "select coalesce((public.norva_migrate_provider_account_activity_affinities(500)->>'complete')::boolean,false)")"
  printf 'ACTIVITY_AFFINITY iteration=%s complete=%s\n' "$iteration" "$complete"
  test "$complete" = t && break
done
test "${complete:-f}" = t || fail 'provider activity affinity did not converge'
psql_service_scalar 'select public.norva_validate_provider_account_activity_affinities()'

for iteration in $(seq 1 256); do
  complete="$(psql_scalar "select coalesce((public.norva_discover_catalog_generation_backfill_sources(100)->>'discoveryComplete')::boolean,false)")"
  printf 'DISCOVERY iteration=%s complete=%s\n' "$iteration" "$complete"
  test "$complete" = t && break
done
test "${complete:-f}" = t || fail 'catalog generation discovery did not converge'

backfill_worker() {
  local worker="$1" response retries=0
  for iteration in $(seq 1 8192); do
    if ! response="$(psql_scalar "select coalesce((public.norva_backfill_catalog_generation_batch('production-install-${worker}',500,120)->>'claimed')::boolean,false)" 2>&1)"; then
      if grep -q 'deadlock detected' <<<"$response"; then
        retries=$((retries+1)); printf 'BACKFILL worker=%s iteration=%s deadlock_retry=%s\n' "$worker" "$iteration" "$retries"; sleep 0.25; continue
      fi
      printf '%s\n' "$response" >&2; return 1
    fi
    test "$response" = f && return 0
    test "$response" = t || return 1
    (( iteration % 250 == 0 )) && printf 'BACKFILL worker=%s iteration=%s\n' "$worker" "$iteration"
  done
  return 1
}

pids=()
for worker in 1 2 3 4; do backfill_worker "$worker" & pids+=("$!"); done
for pid in "${pids[@]}"; do wait "$pid" || fail 'catalog generation backfill worker failed'; done
test "$(psql_scalar "select count(*) from public.cloud_catalog_generation_backfill_sources where state <> 'complete'")" = 0 || fail 'catalog generation queue is incomplete'

for iteration in $(seq 1 256); do
  remaining="$(psql_scalar "select coalesce((public.norva_validate_catalog_generation_constraints(2)->>'remaining')::integer,1)")"
  printf 'VALIDATION iteration=%s remaining=%s\n' "$iteration" "$remaining"
  test "$remaining" = 0 && break
done
test "${remaining:-1}" = 0 || fail 'catalog generation validation did not converge'

psql_contract_scalar "select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch')"
psql_contract_scalar "select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch')"
apply_range "$ONLINE_HEAD" "$CURRENT_HEAD" phase3-head
apply_range "$CURRENT_HEAD" "$CACHE_HEAD" cache-epoch-v2

flags="$(psql_scalar "select count(*)||':'||count(*) filter(where enabled) from public.admin_feature_flags where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')")"
test "$flags" = '6:0' || fail "feature flags are not six OFF rows: $flags"
test "$(psql_scalar "select count(*) from public.cloud_sources where catalog_generation is null")" = 0 || fail 'source generation missing'
test "$(psql_scalar "select count(*) from public.cloud_media_items where catalog_generation is null")" = 0 || fail 'media generation missing'
test "$(psql_scalar "select count(*) from public.cloud_series_memberships where catalog_generation is null")" = 0 || fail 'series membership generation missing'
test "$(psql_scalar "select count(*) from public.cloud_series_inventory where catalog_generation is null")" = 0 || fail 'series inventory generation missing'
test "$(psql_scalar "select count(*) from public.cloud_catalog_categories where catalog_generation is null")" = 0 || fail 'category generation missing'
test "$(psql_scalar "select count(*) from public.cloud_epg_programs where catalog_generation is null")" = 0 || fail 'EPG generation missing'
test "$(psql_scalar "select count(*) from public.cloud_catalog_generation_rollout where state='contracted' and discovery_complete")" = 1 || fail 'rollout is not contracted'
test "$(psql_scalar "select count(*) from public.cloud_catalog_cache_epoch_v2_rollout where completed_at is not null")" = 0 || fail 'cache rollout completed too early'

{
  printf 'completed_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'commit=%s\n' "$EXPECTED_COMMIT"
  printf 'flags=%s\n' "$flags"
  printf 'database_size_bytes=%s\n' "$(psql_scalar 'select pg_database_size(current_database())')"
} >"$REPORT_DIR/INSTALL_COMPLETE"
sha256sum "$REPORT_DIR"/*.txt "$REPORT_DIR/INSTALL_COMPLETE" >"$REPORT_DIR/install-artifacts.sha256"
printf 'PHASE123_PRODUCTION_INSTALL_PASS commit=%s\n' "$EXPECTED_COMMIT"
