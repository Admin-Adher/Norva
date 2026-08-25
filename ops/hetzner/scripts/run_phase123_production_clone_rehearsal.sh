#!/usr/bin/env bash
# Rehearses the complete Phase 1-3 database rollout against a consistent,
# disposable logical clone of the current production database. Production is
# read only: the sole production operation is pg_dump plus baseline queries.
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  run_phase123_production_clone_rehearsal.sh \
    --workspace /home/adrien/norva-phase3-proof/source-SHA \
    --run-id a

The run id must contain only lowercase ASCII letters, digits, or hyphens. The
script refuses an existing target container, data directory, or artifact
directory. It never publishes a port and never connects the clone to the
production Docker network.
EOF
}

WORKSPACE=""
RUN_ID=""
PRODUCTION_CONTAINER="norva-db"
PROOF_ROOT="/var/lib/norva-phase3-proof"
PROOF_HOME="/home/adrien/norva-phase3-proof"
PROOF_NETWORK="norva-phase3-proof-net"
DB_CONFIG_VOLUME="norva-phase3-proof-db-config"
IMAGE="supabase/postgres:17.6.1.136"

while (($#)); do
  case "$1" in
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --production-container) PRODUCTION_CONTAINER="${2:-}"; shift 2 ;;
    --proof-root) PROOF_ROOT="${2:-}"; shift 2 ;;
    --proof-home) PROOF_HOME="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done

fail() { printf 'PHASE123_PRODUCTION_CLONE_REHEARSAL_FAIL: %s\n' "$*" >&2; exit 1; }

test -n "$WORKSPACE" || { usage >&2; exit 64; }
case "$RUN_ID" in
  ''|*[!a-z0-9-]*) usage >&2; exit 64 ;;
esac
case "$WORKSPACE" in
  "$PROOF_HOME"/source-*) ;;
  *) fail "workspace is outside the frozen proof area" ;;
esac
case "$PROOF_ROOT" in
  /var/lib/norva-phase3-proof) ;;
  *) fail "proof root must be /var/lib/norva-phase3-proof" ;;
esac
test "$PRODUCTION_CONTAINER" = "norva-db" || fail "unexpected production container"
test "$(git -C "$WORKSPACE" rev-parse --is-inside-work-tree 2>/dev/null)" = true \
  || fail "workspace is not a Git checkout"
test -z "$(git -C "$WORKSPACE" status --porcelain --untracked-files=all)" || fail "workspace is not clean"
docker inspect "$PRODUCTION_CONTAINER" >/dev/null 2>&1 || fail "production database container is unavailable"
test "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_CONTAINER")" = true || fail "production database is not running"
docker network inspect "$PROOF_NETWORK" >/dev/null 2>&1 || fail "proof network is missing"
docker volume inspect "$DB_CONFIG_VOLUME" >/dev/null 2>&1 || fail "proof DB config volume is missing"

TARGET_CONTAINER="norva-phase123-prod-clone-${RUN_ID}-db"
DATA_ROOT="$PROOF_ROOT/prod-clone-${RUN_ID}"
DATA_DIR="$DATA_ROOT/db"
REPORT_DIR="$PROOF_HOME/artifacts/prod-clone-${RUN_ID}"
DUMP_DIR="$PROOF_HOME/private-dumps"
DUMP_FILE="$DUMP_DIR/production-phase123-${RUN_ID}.dump"
OPS_DB="$PROOF_HOME/ops/hetzner/volumes/db"

case "$TARGET_CONTAINER" in norva-phase123-prod-clone-*-db) ;; *) fail "unsafe target container name" ;; esac
test "$TARGET_CONTAINER" != "$PRODUCTION_CONTAINER" || fail "target aliases production"
test -z "$(docker ps -aq --filter "name=^/${TARGET_CONTAINER}$")" || fail "target container already exists"
test ! -e "$DATA_ROOT" || fail "target data directory already exists"
test ! -e "$REPORT_DIR" || fail "target report directory already exists"
test ! -e "$DUMP_FILE" || fail "target dump already exists"
for file in jwt.sql webhooks.sql roles.sql _supabase.sql logs.sql pooler.sql realtime.sql; do
  test -f "$OPS_DB/$file" || fail "missing proof bootstrap file $file"
done

umask 077
mkdir -p "$REPORT_DIR" "$DUMP_DIR"
chmod 700 "$REPORT_DIR" "$DUMP_DIR"

HEAD="$(git -C "$WORKSPACE" rev-parse HEAD)"
MIGRATION_TREE_SHA="$(find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
PROD_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PRODUCTION_CONTAINER")"
PROD_DATA_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$PRODUCTION_CONTAINER")"
test "$PROD_IMAGE" = "$IMAGE" || fail "production image differs from rehearsal image"
test "$PROD_DATA_MOUNT" = "/var/lib/norva/db" || fail "production data mount identity is unexpected"

cat >"$REPORT_DIR/manifest.txt" <<EOF
proof_commit=$HEAD
migration_tree_sha256=$MIGRATION_TREE_SHA
production_container=$PRODUCTION_CONTAINER
production_image=$PROD_IMAGE
production_data_mount=$PROD_DATA_MOUNT
target_container=$TARGET_CONTAINER
target_data_root=$DATA_ROOT
first_phase123_migration=20260822220000_cloud_sources_owner_index_online.sql
pre_contraction_head=20260823179920_catalog_generation_flag_gate.sql
contraction_definition=20260823180000_provider_catalog_generation_online_rollout.sql
online_index_head=20260823182700_series_inventory_generation_parent_natural_fk.sql
phase3_database_head=20260823194000_replacement_promotion_proof_account_delete.sql
cache_epoch_head=20260824100000_catalog_cache_epoch_v2.sql
previous_provider_access_head=20260824174000_legal_billing_archive_acl_hardening.sql
current_provider_access_head=20260825001459_provider_access_notification_cron_v1.sql
EOF

baseline_sql() {
  cat <<'SQL'
select 'server_version',current_setting('server_version');
select 'database_size_bytes',pg_database_size(current_database());
select 'auth_users',count(*) from auth.users;
select 'cloud_sources',count(*) from public.cloud_sources;
select 'cloud_media_items',count(*) from public.cloud_media_items;
select 'cloud_titles',count(*) from public.cloud_titles;
select 'cloud_title_variants',count(*) from public.cloud_title_variants;
select 'cloud_live_logical_channels',count(*) from public.cloud_live_logical_channels;
select 'cloud_live_variants',count(*) from public.cloud_live_variants;
select 'catalog_series_episode_memberships',count(*) from public.catalog_series_episode_memberships;
select 'catalog_series_inventory_state',count(*) from public.catalog_series_inventory_state;
select 'phase123_objects',count(*) from pg_class where relnamespace='public'::regnamespace and relname in ('cloud_global_catalog_visibility_epoch','cloud_catalog_generation_rollout','cloud_source_catalog_generations','cloud_source_credential_candidates');
select 'phase123_flags',count(*),count(*) filter(where enabled) from public.admin_feature_flags where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');
SQL
}

baseline_sql | docker exec -i "$PRODUCTION_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -U supabase_admin -d postgres >"$REPORT_DIR/production-baseline.tsv"
phase123_object_count="$(awk -F '\t' '$1=="phase123_objects"{print $2}' "$REPORT_DIR/production-baseline.tsv")"
case "$phase123_object_count" in
  0) REHEARSAL_MODE="bootstrap" ;;
  ''|*[!0-9]*) fail "production Phase 1-3 object count is invalid" ;;
  *) REHEARSAL_MODE="incremental" ;;
esac
printf 'rehearsal_mode=%s\n' "$REHEARSAL_MODE" >>"$REPORT_DIR/manifest.txt"
if test "$REHEARSAL_MODE" = incremental; then
  docker exec -i "$PRODUCTION_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres <<'SQL' >"$REPORT_DIR/production-incremental-preconditions.tsv"
select 'previous_cache_gate',to_regprocedure('public.norva_complete_catalog_cache_epoch_v2_rollout(text,text)') is not null;
select 'legal_policy_v2',to_regprocedure('public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text)') is not null;
select 'legal_access_v1',to_regprocedure('public.norva_read_legal_billing_archive(text,text,text,text)') is not null;
select 'notification_cron_v1',to_regprocedure('public.norva_install_provider_access_notification_cron()') is not null;
select 'policy_rows',count(*) from public.legal_billing_archive_retention_policy;
select 'archive_rows',count(*) from public.legal_billing_archive;
SQL
  grep -qx $'previous_cache_gate\tt' "$REPORT_DIR/production-incremental-preconditions.tsv" \
    || fail "production does not match the required cache-observation head"
  grep -qx $'legal_policy_v2\tt' "$REPORT_DIR/production-incremental-preconditions.tsv" \
    || fail "legal policy v2 is missing from the required incremental boundary"
  grep -qx $'legal_access_v1\tt' "$REPORT_DIR/production-incremental-preconditions.tsv" \
    || fail "legal archive access v1 is missing from the required incremental boundary"
  grep -qx $'notification_cron_v1\tf' "$REPORT_DIR/production-incremental-preconditions.tsv" \
    || fail "notification cron v1 is already present; choose a new incremental rehearsal boundary"
fi

printf 'DUMP_BEGIN %s\n' "$(date -u +%FT%TZ)" | tee "$REPORT_DIR/timeline.log"
PARTIAL_DUMP="$DUMP_FILE.partial"
trap 'rm -f -- "$PARTIAL_DUMP"' EXIT
docker exec "$PRODUCTION_CONTAINER" pg_dump \
  -U supabase_admin -d postgres -Fc --no-owner >"$PARTIAL_DUMP"
test -s "$PARTIAL_DUMP" || fail "production dump is empty"
mv "$PARTIAL_DUMP" "$DUMP_FILE"
chmod 600 "$DUMP_FILE"
trap - EXIT
sha256sum "$DUMP_FILE" >"$REPORT_DIR/production-dump.sha256"
printf 'DUMP_COMPLETE %s bytes=%s\n' "$(date -u +%FT%TZ)" "$(stat -c %s "$DUMP_FILE")" | tee -a "$REPORT_DIR/timeline.log"

password="norva_phase123_prod_clone_${RUN_ID}_only"
docker run -d \
  --name "$TARGET_CONTAINER" \
  --network "$PROOF_NETWORK" \
  --label norva.phase123.production-clone=true \
  --label "norva.phase123.run=$RUN_ID" \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER=supabase_admin \
  -e POSTGRES_PASSWORD="$password" \
  -e JWT_SECRET="norva_phase123_prod_clone_${RUN_ID}_jwt_only" \
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
  -v "$DB_CONFIG_VOLUME":/etc/postgresql-custom:ro \
  "$IMAGE" postgres \
    -c config_file=/etc/postgresql/postgresql.conf \
    -c shared_buffers=1GB -c effective_cache_size=4GB -c work_mem=16MB \
    -c maintenance_work_mem=1GB -c max_connections=75 -c max_wal_size=8GB \
    -c archive_mode=off >"$REPORT_DIR/container-id.txt"

for _ in $(seq 1 90); do
  if docker logs "$TARGET_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up.' \
     && docker exec "$TARGET_CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$TARGET_CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null || fail "clone database did not become ready"

# A logical production dump includes pg_cron jobs.  Disable the scheduler at
# cluster level before restore so no restored job can race the proof or emit an
# external effect.  The disposable clone must be inert unless this harness
# invokes work explicitly.
docker exec "$TARGET_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 \
  -U supabase_admin -d postgres \
  -c "alter system set cron.launch_active_jobs='off'" \
  >"$REPORT_DIR/cron-disable.log" 2>&1
docker exec "$TARGET_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 \
  -U supabase_admin -d postgres -c "select pg_reload_conf()" \
  >>"$REPORT_DIR/cron-disable.log" 2>&1
test "$(docker exec "$TARGET_CONTAINER" psql -X -At -U supabase_admin -d postgres -c 'show cron.launch_active_jobs')" = off \
  || fail "pg_cron launch could not be disabled before restore"

# A database-format dump contains ACLs but not cluster roles. Mirror any
# production-only role identity before restore so ACL replay is exact. Passwords
# and role-level secrets are intentionally never copied into the disposable
# clone. Standard roles already created by the Supabase bootstrap are left as-is.
ROLE_SQL="select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit from pg_roles order by rolname;"
docker exec "$PRODUCTION_CONTAINER" psql -X -At -U supabase_admin -d postgres -c "$ROLE_SQL" >"$REPORT_DIR/production-roles.tsv"
docker exec "$TARGET_CONTAINER" psql -X -At -U supabase_admin -d postgres -c "$ROLE_SQL" >"$REPORT_DIR/clone-roles-before.tsv"
while IFS='|' read -r role super inherit create_role create_db login replication bypass_rls conn_limit; do
  case "$role" in pg_*) continue ;; esac
  case "$role" in ''|*[!a-zA-Z0-9_]*) fail "unsafe production role name $role" ;; esac
  grep -q "^${role}|" "$REPORT_DIR/clone-roles-before.tsv" && continue
  options=""
  test "$super" = t && options+=" SUPERUSER" || options+=" NOSUPERUSER"
  test "$inherit" = t && options+=" INHERIT" || options+=" NOINHERIT"
  test "$create_role" = t && options+=" CREATEROLE" || options+=" NOCREATEROLE"
  test "$create_db" = t && options+=" CREATEDB" || options+=" NOCREATEDB"
  test "$login" = t && options+=" LOGIN" || options+=" NOLOGIN"
  test "$replication" = t && options+=" REPLICATION" || options+=" NOREPLICATION"
  test "$bypass_rls" = t && options+=" BYPASSRLS" || options+=" NOBYPASSRLS"
  case "$conn_limit" in -1|[0-9]*) ;; *) fail "unsafe connection limit for role $role" ;; esac
  docker exec "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
    -c "create role \"$role\" with$options connection limit $conn_limit" >>"$REPORT_DIR/role-sync.log" 2>&1
done <"$REPORT_DIR/production-roles.tsv"
docker exec "$TARGET_CONTAINER" psql -X -At -U supabase_admin -d postgres -c "$ROLE_SQL" >"$REPORT_DIR/clone-roles-after.tsv"
while IFS='|' read -r role _; do
  case "$role" in pg_*) continue ;; esac
  grep -q "^${role}|" "$REPORT_DIR/clone-roles-after.tsv" || fail "production role $role is missing from clone"
done <"$REPORT_DIR/production-roles.tsv"

printf 'RESTORE_BEGIN %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"
docker exec -i "$TARGET_CONTAINER" pg_restore \
  -U supabase_admin -d postgres --clean --if-exists --no-owner --exit-on-error \
  <"$DUMP_FILE" >"$REPORT_DIR/restore.log" 2>&1
printf 'RESTORE_COMPLETE %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"

# Preserve the restored schedule as data evidence while making every job
# explicitly inactive as a second fence.  The original production database is
# never modified.
docker exec "$TARGET_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 \
  -U supabase_admin -d postgres \
  -c "update cron.job set active=false where active; select count(*) filter(where active) from cron.job" \
  >"$REPORT_DIR/clone-active-cron-jobs.txt" 2>&1
grep -qx '0' "$REPORT_DIR/clone-active-cron-jobs.txt" || fail "restored clone still has active cron jobs"

baseline_sql | docker exec -i "$TARGET_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -U supabase_admin -d postgres >"$REPORT_DIR/clone-baseline.tsv"
diff -u <(grep -v '^database_size_bytes' "$REPORT_DIR/production-baseline.tsv") <(grep -v '^database_size_bytes' "$REPORT_DIR/clone-baseline.tsv") >"$REPORT_DIR/baseline-diff.txt" || fail "clone row-count baseline differs from production"
docker exec "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -c 'vacuum analyze' >"$REPORT_DIR/vacuum-analyze.log" 2>&1

apply_range() {
  local lower="$1" upper="$2" label="$3"
  local list="$REPORT_DIR/migrations-${label}.txt" log="$REPORT_DIR/migrations-${label}.log"
  find "$WORKSPACE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort |
    awk -v lower="$lower" -v upper="$upper" '$0 > lower && $0 <= upper' >"$list"
  grep -qx "$upper" "$list" || fail "migration range $label does not reach $upper"
  while IFS= read -r migration; do
    local started finished
    started="$(date +%s)"
    printf 'APPLY %s %s\n' "$(date -u +%FT%TZ)" "$migration" | tee -a "$log"
    if grep -Eiq '^[[:space:]]*(create|drop)[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently' "$WORKSPACE/supabase/migrations/$migration"; then
      docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <"$WORKSPACE/supabase/migrations/$migration" >>"$log" 2>&1
    else
      docker exec -i "$TARGET_CONTAINER" psql -X -1 -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <"$WORKSPACE/supabase/migrations/$migration" >>"$log" 2>&1
    fi
    finished="$(date +%s)"
    printf 'APPLIED %s duration_seconds=%s\n' "$migration" "$((finished-started))" | tee -a "$log"
  done <"$list"
}

FIRST="20260822220000_cloud_sources_owner_index_online.sql"
PRE_HEAD="20260823179920_catalog_generation_flag_gate.sql"
CONTRACTION="20260823180000_provider_catalog_generation_online_rollout.sql"
ONLINE_HEAD="20260823182700_series_inventory_generation_parent_natural_fk.sql"
CURRENT_HEAD="20260823194000_replacement_promotion_proof_account_delete.sql"
PREVIOUS_PROVIDER_ACCESS_HEAD="20260824174000_legal_billing_archive_acl_hardening.sql"
CURRENT_PROVIDER_ACCESS_HEAD="20260825001459_provider_access_notification_cron_v1.sql"

if test "$REHEARSAL_MODE" = incremental; then
  apply_range "$PREVIOUS_PROVIDER_ACCESS_HEAD" "$CURRENT_PROVIDER_ACCESS_HEAD" provider-cron-incremental

  for test_name in \
    provider_access_notification_cron.sql
  do
    output="$REPORT_DIR/test-${test_name%.sql}.log"
    printf 'TEST %s %s\n' "$(date -u +%FT%TZ)" "$test_name" | tee -a "$REPORT_DIR/timeline.log"
    docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
      -U supabase_admin -d postgres \
      <"$WORKSPACE/supabase/tests/$test_name" >"$output" 2>&1
  done

  docker exec -i "$TARGET_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres <<'SQL' >"$REPORT_DIR/final-invariants.tsv"
select 'policy_v2',to_regprocedure('public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text)') is not null;
select 'access_v1',to_regprocedure('public.norva_read_legal_billing_archive(text,text,text,text)') is not null;
select 'notification_cron_v1',to_regprocedure('public.norva_install_provider_access_notification_cron()') is not null;
select 'provider_crons',count(*) from cron.job where jobname in ('norva-provider-access-notifications','norva-provider-access-checks');
select 'policy_rows',count(*) from public.legal_billing_archive_retention_policy;
select 'archive_rows',count(*) from public.legal_billing_archive;
select 'access_grants',count(*) from public.legal_billing_archive_access_grants;
select 'access_events',count(*) from public.legal_billing_archive_access_events;
select 'grant_events',count(*) from public.legal_billing_archive_access_grant_events;
select 'rollout',stage,revision from public.cloud_provider_access_rollout where singleton;
select 'flags',count(*),count(*) filter(where enabled) from public.admin_feature_flags where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);
select 'cache_epoch',phase,completed_at is not null from public.cloud_catalog_cache_epoch_v2_rollout where singleton;
SQL
  grep -qx $'policy_v2\tt' "$REPORT_DIR/final-invariants.tsv" || fail "legal policy v2 is missing"
  grep -qx $'access_v1\tt' "$REPORT_DIR/final-invariants.tsv" || fail "legal archive access v1 is missing"
  grep -qx $'notification_cron_v1\tt' "$REPORT_DIR/final-invariants.tsv" || fail "notification cron v1 is missing"
  grep -qx $'provider_crons\t0' "$REPORT_DIR/final-invariants.tsv" || fail "rehearsal persisted a Provider Access cron"
  grep -qx $'access_grants\t0' "$REPORT_DIR/final-invariants.tsv" || fail "rehearsal persisted a legal-reader grant"
  grep -qx $'access_events\t0' "$REPORT_DIR/final-invariants.tsv" || fail "rehearsal persisted an access event"
  grep -qx $'grant_events\t0' "$REPORT_DIR/final-invariants.tsv" || fail "rehearsal persisted a grant event"
  grep -qx $'flags\t9\t0' "$REPORT_DIR/final-invariants.tsv" || fail "Provider Access flags are not all OFF"
  grep -Eq $'^rollout\toff\t[0-9]+$' "$REPORT_DIR/final-invariants.tsv" || fail "Provider Access rollout is not OFF"
  grep -qx $'cache_epoch\tinstalled\tf' "$REPORT_DIR/final-invariants.tsv" || fail "cache epoch observation gate changed"
  before_policy="$(awk -F '\t' '$1=="policy_rows"{print $2}' "$REPORT_DIR/production-incremental-preconditions.tsv")"
  before_archive="$(awk -F '\t' '$1=="archive_rows"{print $2}' "$REPORT_DIR/production-incremental-preconditions.tsv")"
  after_policy="$(awk -F '\t' '$1=="policy_rows"{print $2}' "$REPORT_DIR/final-invariants.tsv")"
  after_archive="$(awk -F '\t' '$1=="archive_rows"{print $2}' "$REPORT_DIR/final-invariants.tsv")"
  test "$before_policy" = "$after_policy" || fail "policy row count changed: $before_policy -> $after_policy"
  test "$before_archive" = "$after_archive" || fail "archive row count changed: $before_archive -> $after_archive"

  sha256sum "$REPORT_DIR"/*.tsv "$REPORT_DIR"/*.txt "$REPORT_DIR"/*.log >"$REPORT_DIR/artifact-sha256.txt"
  printf 'REHEARSAL_COMPLETE %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"
  printf 'PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS\nmode=%s\ncommit=%s\ncontainer=%s\nreport=%s\n' \
    "$REHEARSAL_MODE" "$HEAD" "$TARGET_CONTAINER" "$REPORT_DIR"
  exit 0
fi

apply_range "20260822219999" "$PRE_HEAD" pre-contraction
apply_range "$PRE_HEAD" "$CONTRACTION" contraction-definition
apply_range "$CONTRACTION" "$ONLINE_HEAD" online-indexes

printf 'BACKFILL_BEGIN %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"
psql_scalar() {
  local sql="$1"
  docker exec \
    -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
    "$TARGET_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres -c "$sql"
}

psql_contract_scalar() {
  local sql="$1"
  docker exec \
    -e PGOPTIONS='-c statement_timeout=300000 -c lock_timeout=5000' \
    "$TARGET_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres -c "$sql"
}

psql_service_scalar() {
  local sql="$1"
  docker exec \
    -e PGOPTIONS='-c statement_timeout=1800000 -c lock_timeout=5000' \
    "$TARGET_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres \
    -c "set role service_role; $sql"
}

# Every operator RPC is its own autocommit transaction. A crash therefore
# loses at most one bounded batch and restart reconstructs progress from the
# durable rollout/queue rows, matching the production execution contract.
foundation_complete=f
for iteration in $(seq 1 256); do
  foundation_complete="$(psql_scalar "select coalesce((public.norva_backfill_provider_access_foundation(500)->>'complete')::boolean,false)")"
  printf 'FOUNDATION iteration=%s complete=%s\n' "$iteration" "$foundation_complete" >>"$REPORT_DIR/contraction.log"
  test "$foundation_complete" = t && break
done
test "$foundation_complete" = t || fail "provider access foundation did not converge"

# Provider-account affinity is an independent pre-activation rollout.  Source
# affinities must be durable before the short-lived legacy heartbeat ledger is
# rewritten to opaque keys; the validation RPC then makes that invariant a
# validated PostgreSQL constraint.  Every call is a bounded autocommit unit.
affinity_complete=f
for iteration in $(seq 1 256); do
  affinity_complete="$(psql_service_scalar "select coalesce((public.norva_backfill_source_provider_account_affinities(500)->>'complete')::boolean,false)")"
  printf 'AFFINITY iteration=%s complete=%s\n' "$iteration" "$affinity_complete" >>"$REPORT_DIR/contraction.log"
  test "$affinity_complete" = t && break
done
test "$affinity_complete" = t || fail "provider account affinity backfill did not converge"

activity_complete=f
for iteration in $(seq 1 8192); do
  activity_complete="$(psql_service_scalar "select coalesce((public.norva_migrate_provider_account_activity_affinities(500)->>'complete')::boolean,false)")"
  printf 'ACTIVITY_AFFINITY iteration=%s complete=%s\n' "$iteration" "$activity_complete" >>"$REPORT_DIR/contraction.log"
  test "$activity_complete" = t && break
done
test "$activity_complete" = t || fail "provider account activity affinity migration did not converge"
psql_service_scalar "select public.norva_validate_provider_account_activity_affinities()" >>"$REPORT_DIR/contraction.log"

discovery_complete=f
for iteration in $(seq 1 256); do
  discovery_complete="$(psql_scalar "select coalesce((public.norva_discover_catalog_generation_backfill_sources(100)->>'discoveryComplete')::boolean,false)")"
  printf 'DISCOVERY iteration=%s complete=%s\n' "$iteration" "$discovery_complete" >>"$REPORT_DIR/contraction.log"
  test "$discovery_complete" = t && break
done
test "$discovery_complete" = t || fail "catalog generation discovery did not converge"

# Exercise the production SKIP LOCKED/advisory-lock contract with four real
# concurrent workers.  A worker may legitimately observe no claim while the
# remaining sources are owned by its peers; the durable queue postcondition is
# authoritative after every worker exits.
backfill_worker() {
  local worker="$1" iteration claimed=t queue_state response
  local deadlock_retries=0
  for iteration in $(seq 1 8192); do
    if ! response="$(psql_scalar "select coalesce((public.norva_backfill_catalog_generation_batch('production-clone-rehearsal-${worker}',500,120)->>'claimed')::boolean,false)" 2>&1)"; then
      if grep -q 'deadlock detected' <<<"$response"; then
        deadlock_retries=$((deadlock_retries+1))
        printf 'BACKFILL worker=%s iteration=%s transient=deadlock retry=%s\n' \
          "$worker" "$iteration" "$deadlock_retries" \
          >>"$REPORT_DIR/contraction-worker-${worker}.log"
        sleep 0.25
        continue
      fi
      printf 'BACKFILL worker=%s iteration=%s fatal=%s\n' \
        "$worker" "$iteration" "$response" \
        >>"$REPORT_DIR/contraction-worker-${worker}.log"
      return 1
    fi
    claimed="$response"
    case "$claimed" in t|f) ;; *) return 1 ;; esac
    if ((iteration % 250 == 0)) || test "$claimed" = f; then
      queue_state="$(psql_scalar "select coalesce(string_agg(state||'='||count,',' order by state),'none') from (select state,count(*)::text from public.cloud_catalog_generation_backfill_sources group by state) state_count")"
      printf 'BACKFILL worker=%s iteration=%s claimed=%s queue=%s\n' \
        "$worker" "$iteration" "$claimed" "$queue_state" \
        >>"$REPORT_DIR/contraction-worker-${worker}.log"
    fi
    test "$claimed" = f && return 0
  done
  return 1
}

backfill_pids=()
for worker in 1 2 3 4; do
  backfill_worker "$worker" &
  backfill_pids+=("$!")
done
for pid in "${backfill_pids[@]}"; do
  wait "$pid" || fail "catalog generation backfill worker failed"
done
test "$(psql_scalar "select count(*) from public.cloud_catalog_generation_backfill_sources where state <> 'complete'")" = 0 || fail "catalog generation backfill did not converge"

remaining=1
for iteration in $(seq 1 256); do
  remaining="$(psql_scalar "select coalesce((public.norva_validate_catalog_generation_constraints(2)->>'remaining')::integer,1)")"
  printf 'VALIDATION iteration=%s remaining=%s\n' "$iteration" "$remaining" >>"$REPORT_DIR/contraction.log"
  test "$remaining" = 0 && break
done
test "$remaining" = 0 || fail "catalog generation validation did not converge"

psql_contract_scalar "select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch')" >>"$REPORT_DIR/contraction.log"
psql_contract_scalar "select public.norva_contract_catalog_generation_rollout('catalog-generation-writer-v2-live-clear-batch')" >>"$REPORT_DIR/contraction.log"
printf 'BACKFILL_CONTRACTION_COMPLETE %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"

apply_range "$ONLINE_HEAD" "$CURRENT_HEAD" phase3-head
apply_range "$CURRENT_HEAD" "$CURRENT_PROVIDER_ACCESS_HEAD" current-provider-access

# Concurrency matrices open synchronized PostgreSQL sessions through dblink;
# SQL acceptance suites use pgTAP.  Both extensions are proof instrumentation
# on the disposable clone only, never production migrations or runtime state.
psql_scalar "create extension if not exists dblink; create extension if not exists pgtap with schema extensions"

run_test() {
  local test_name="$1"
  local output="$REPORT_DIR/test-${test_name%.sql}.log"
  printf 'TEST %s %s\n' "$(date -u +%FT%TZ)" "$test_name" | tee -a "$REPORT_DIR/timeline.log"
  docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
    <"$WORKSPACE/supabase/tests/$test_name" >"$output" 2>&1
  grep -Eq '(^|[[:space:]])not ok([[:space:]]|$)' "$output" && fail "pgTAP failure in $test_name"
  return 0
}

TESTS=(
  provider_credential_transition.sql
  catalog_background_owner_snapshot_concurrency_smoke.sql
  catalog_background_owner_workflow_smoke.sql
  provider_account_delete_concurrency_smoke.sql
  provider_account_delete_prepare_smoke.sql
  account_deletion_workflow_claim_concurrency_smoke.sql
  account_deletion_transport_stop_concurrency_smoke.sql
  account_deletion_product_reaper_smoke.sql
  account_deletion_finalization_concurrency_smoke.sql
  account_deletion_legal_billing_retention_smoke.sql
  legal_billing_archive_access_smoke.sql
  provider_access_notification_cron.sql
  account_deletion_paywall_analytics_smoke.sql
  provider_credential_promotion_cancel_concurrency.sql
  provider_credential_swap_account_delete_concurrency.sql
  provider_credential_rollback_account_delete_concurrency.sql
  provider_replacement_candidate_builder.sql
)
for test_name in "${TESTS[@]}"; do run_test "$test_name"; done

# First prove the cache v2 installation and fail-closed activation contract in
# a rolled-back acceptance transaction.  Only then persist the exact runtime
# manifest on the clone and exercise Phase 2 visibility with that prerequisite
# durably complete.
run_test catalog_cache_epoch_v2.sql
psql_scalar "update public.cloud_catalog_cache_epoch_v2_rollout set installed_at=installed_at-interval '8 days' where singleton and phase='installed' returning installed_at" \
  >"$ARTIFACT_DIR/cache-epoch-v2-proof-backdate.txt"
psql_service_scalar "select public.norva_complete_catalog_cache_epoch_v2_rollout('catalog-cache-epoch-v2','23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3')" \
  >>"$REPORT_DIR/cache-epoch-v2-completion.log"
run_test provider_access_expiry_visibility.sql

# The transaction crash matrix deliberately consumes a committed pre-switch
# fixture.  Build that fixture through the production credential contract, then
# let the matrix terminate real PostgreSQL backends at each transaction fence.
crash_fixture_output="$REPORT_DIR/test-provider-credential-transition-crash-fixture.log"
printf 'TEST %s %s\n' "$(date -u +%FT%TZ)" 'provider_credential_transition.sql (crash fixture)' | tee -a "$REPORT_DIR/timeline.log"
docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -v phase3_prepare_pre_ready_crash_fixture=1 \
  -U supabase_admin -d postgres \
  <"$WORKSPACE/supabase/tests/provider_credential_transition.sql" \
  >"$crash_fixture_output" 2>&1
grep -Eq '(^|[[:space:]])not ok([[:space:]]|$)' "$crash_fixture_output" \
  && fail "pgTAP failure while preparing transaction crash fixture"
run_test provider_credential_transaction_crash_matrix.sql

# The prepared worker owns a real finite lease.  Let that authority expire,
# proving account deletion cannot bypass a live worker, then converge the
# synthetic account through the production deletion state machine.
crash_lease_live=1
for iteration in $(seq 1 180); do
  crash_lease_live="$(psql_scalar "select count(*) from public.cloud_source_credential_transition_jobs where user_id='93000000-0000-4000-8000-000000000001'::uuid and state='processing' and lease_until>clock_timestamp()")"
  test "$crash_lease_live" = 0 && break
  if ((iteration % 15 == 0)); then
    printf 'CRASH_FIXTURE_DRAIN iteration=%s live_leases=%s\n' "$iteration" "$crash_lease_live" | tee -a "$REPORT_DIR/timeline.log"
  fi
  sleep 1
done
test "$crash_lease_live" = 0 || fail "crash fixture provider lease did not expire"
docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U supabase_admin -d postgres \
  <"$WORKSPACE/ops/hetzner/scripts/phase123-proof-cleanup-crash-fixture.sql" \
  >"$REPORT_DIR/test-crash-fixture-account-deletion.log" 2>&1

docker exec -i "$TARGET_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <<'SQL' >"$REPORT_DIR/final-invariants.tsv"
select 'rollout',phase,contracted_at is not null,discovery_complete,discovered_sources,completed_sources,validation_completed_count from public.cloud_catalog_generation_rollout where singleton;
select 'flags',count(*),count(*) filter(where enabled) from public.admin_feature_flags where key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');
select 'global_epoch_rows',count(*) from public.cloud_global_catalog_visibility_epoch;
select 'cache_epoch_rollout',phase,manifest_sha256 from public.cloud_catalog_cache_epoch_v2_rollout where singleton;
select 'affinity_rollout',phase,completed_at is not null from public.cloud_source_provider_account_affinity_rollout where singleton;
select 'raw_provider_account_activity',count(*) from public.provider_account_activity where account_key !~ '^[0-9a-f]{64}$';
select 'opaque_activity_constraint',convalidated from pg_catalog.pg_constraint where conrelid='public.provider_account_activity'::regclass and conname='provider_account_activity_opaque_key_ck';
select 'missing_media_generation',count(*) from public.cloud_media_items where generation_id is null;
select 'missing_title_variant_generation',count(*) from public.cloud_title_variants where generation_id is null;
select 'missing_live_logical_generation',count(*) from public.cloud_live_logical_channels where generation_id is null;
select 'missing_live_variant_generation',count(*) from public.cloud_live_variants where generation_id is null;
select 'missing_membership_generation',count(*) from public.catalog_series_episode_memberships where generation_id is null;
select 'missing_inventory_generation',count(*) from public.catalog_series_inventory_state where generation_id is null;
select 'nonterminal_transitions',count(*) from public.cloud_source_transitions where state not in ('completed','failed','cancelled');
select 'nonterminal_credential_jobs',count(*) from public.cloud_source_credential_transition_jobs where state in ('pending','processing');
select 'open_generations',count(*) from public.cloud_source_catalog_generations where state in ('building','ready','purging');
select 'catalog_cache_epoch',public.norva_catalog_cache_epoch_v2(null);
SQL

grep -qx $'flags\t6\t0' "$REPORT_DIR/final-invariants.tsv" || fail "provider-access flags are not all OFF"
grep -qx $'global_epoch_rows\t1' "$REPORT_DIR/final-invariants.tsv" || fail "global cache epoch singleton is missing"
grep -qx $'cache_epoch_rollout\tcomplete\t23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3' "$REPORT_DIR/final-invariants.tsv" || fail "global cache epoch v2 rollout is incomplete"
grep -qx $'affinity_rollout\tcomplete\tt' "$REPORT_DIR/final-invariants.tsv" || fail "provider account affinity rollout is incomplete"
grep -qx $'raw_provider_account_activity\t0' "$REPORT_DIR/final-invariants.tsv" || fail "raw provider account activity remains"
grep -qx $'opaque_activity_constraint\tt' "$REPORT_DIR/final-invariants.tsv" || fail "provider account activity opaque constraint is not validated"
grep -Eq $'^rollout\tcontracted\tt\t' "$REPORT_DIR/final-invariants.tsv" || fail "catalog generation rollout is not contracted"
for invariant in missing_media_generation missing_title_variant_generation missing_live_logical_generation missing_live_variant_generation missing_membership_generation missing_inventory_generation nonterminal_transitions nonterminal_credential_jobs open_generations; do
  grep -qx "$invariant"$'\t0' "$REPORT_DIR/final-invariants.tsv" || fail "$invariant is non-zero"
done

baseline_sql | docker exec -i "$TARGET_CONTAINER" psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -U supabase_admin -d postgres >"$REPORT_DIR/clone-final-counts.tsv"
for relation in auth_users cloud_sources cloud_media_items cloud_titles cloud_title_variants cloud_live_logical_channels cloud_live_variants catalog_series_episode_memberships catalog_series_inventory_state; do
  before="$(awk -F '\t' -v key="$relation" '$1==key{print $2}' "$REPORT_DIR/clone-baseline.tsv")"
  after="$(awk -F '\t' -v key="$relation" '$1==key{print $2}' "$REPORT_DIR/clone-final-counts.tsv")"
  test "$before" = "$after" || fail "row count changed for $relation: $before -> $after"
done

sha256sum "$REPORT_DIR"/*.tsv "$REPORT_DIR"/*.txt "$REPORT_DIR"/*.log >"$REPORT_DIR/artifact-sha256.txt"
printf 'REHEARSAL_COMPLETE %s\n' "$(date -u +%FT%TZ)" | tee -a "$REPORT_DIR/timeline.log"
printf 'PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS\ncommit=%s\ncontainer=%s\nreport=%s\n' "$HEAD" "$TARGET_CONTAINER" "$REPORT_DIR"
