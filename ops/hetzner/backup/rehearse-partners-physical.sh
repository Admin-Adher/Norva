#!/usr/bin/env bash
# =============================================================================
# rehearse-partners-physical.sh
#
# Restore the latest R2 physical base backup into a short-lived, no-network
# PostgreSQL clone, apply the two pending Partners migrations atomically, then
# run the restore verifier and the complete Partners pgTAP suite.
#
# This script is intentionally root-only because /etc/norva-backup.env is
# root-owned. The live container is inspected and receives one read-only SHOW
# query; no live table, service configuration or checkout is mutated.
# Raw command output stays in the private temporary directory and is deleted.
# The durable proof contains only controlled identifiers, aggregate counters
# and pass/fail summaries.
#
# Usage:
#   sudo bash ops/hetzner/backup/rehearse-partners-physical.sh <40-char-sha>
# =============================================================================

set -Eeuo pipefail
umask 077

readonly SCRIPT_NAME="rehearse-partners-physical"
readonly CONTAINER_PREFIX="norva-partners-physical-rehearsal-"
readonly WORKDIR_PREFIX="partners-physical-rehearsal."

if [[ "${EUID}" -ne 0 ]]; then
  printf 'ERROR: %s must run as root (use sudo bash).\n' "$SCRIPT_NAME" >&2
  exit 1
fi

for required_command in \
  awk chown date docker find flock git grep install mktemp rclone realpath \
  sha256sum sort stat tail tar timeout tr; do
  command -v "$required_command" >/dev/null 2>&1 || {
    printf 'ERROR: required command is missing: %s\n' "$required_command" >&2
    exit 1
  }
done

exec 9>/run/lock/norva-partners-physical-rehearsal.lock
if ! flock -n 9; then
  printf 'ERROR: another Partners physical rehearsal is already running.\n' >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd -P)"

# lib.sh loads the protected R2 and PostgreSQL configuration. Nothing from it
# is echoed, placed on a command line, or copied to the durable proof.
# shellcheck disable=SC1091
source "$HERE/lib.sh"

CONFIGURED_OPS_DIR="$(realpath -e "$NORVA_OPS_DIR")"
if [[ ! -f "$CONFIGURED_OPS_DIR/.env" ]]; then
  printf 'ERROR: the configured live stack environment is unavailable.\n' >&2
  exit 1
fi

TARGET_SHA="${1:-}"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'ERROR: pass the exact 40-character lowercase candidate commit SHA.\n' >&2
  exit 1
fi
GIT=(git -c "safe.directory=$REPO_ROOT" -C "$REPO_ROOT")
if ! "${GIT[@]}" cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  printf 'ERROR: candidate commit is not present in this checkout. Fetch it first.\n' >&2
  exit 1
fi
if [[ "$("${GIT[@]}" rev-parse "${TARGET_SHA}^{commit}")" != "$TARGET_SHA" ]]; then
  printf 'ERROR: candidate SHA does not resolve to the exact requested commit.\n' >&2
  exit 1
fi

if [[ ! "$DB_CONTAINER" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  printf 'ERROR: invalid live database container name in protected config.\n' >&2
  exit 1
fi

readonly MIGRATION_ONE="supabase/migrations/20260803082211_partners_admin_operator_capabilities.sql"
readonly MIGRATION_TWO="supabase/migrations/20260803084051_partners_access_request_decision_email.sql"
readonly VERIFIER="ops/hetzner/backup/verify-partners-restore.sql"
readonly -a PGTAP_FILES=(
  "supabase/tests/affiliate_p0.sql"
  "supabase/tests/affiliate_access_requests.sql"
  "supabase/tests/affiliate_dispute_won.sql"
  "supabase/tests/affiliate_fiscal_payout_onboarding.sql"
  "supabase/tests/affiliate_member_write_rate_limits.sql"
  "supabase/tests/affiliate_revolut_manual_hybrid.sql"
  "supabase/tests/revenuecat_transfer.sql"
)
readonly -a CANDIDATE_FILES=(
  "$MIGRATION_ONE"
  "$MIGRATION_TWO"
  "$VERIFIER"
  "${PGTAP_FILES[@]}"
)

STAGE_ROOT="${PARTNERS_REHEARSAL_STAGE_DIR:-${BACKUP_STAGE_DIR:-/var/lib/norva/backups}}"
if [[ ! -d "$STAGE_ROOT" ]]; then
  install -d -m 0700 "$STAGE_ROOT"
fi
STAGE_ROOT="$(realpath -e "$STAGE_ROOT")"
WORKDIR="$(mktemp -d "$STAGE_ROOT/${WORKDIR_PREFIX}XXXXXXXX")"
WORKDIR="$(realpath -e "$WORKDIR")"
readonly WORKDIR
readonly SAFE_WORKDIR_PREFIX="$STAGE_ROOT/$WORKDIR_PREFIX"
case "$WORKDIR" in
  "$SAFE_WORKDIR_PREFIX"*) ;;
  *)
    printf 'ERROR: mktemp returned an unsafe rehearsal path.\n' >&2
    exit 1
    ;;
esac

REPO_PARENT="$(dirname "$REPO_ROOT")"
PROOF_ROOT="${PARTNERS_REHEARSAL_PROOF_ROOT:-$REPO_PARENT/norva-deploy-backups}"
PROOF_ROOT_CREATED=false
if [[ ! -d "$PROOF_ROOT" ]]; then
  install -d -m 0700 "$PROOF_ROOT"
  PROOF_ROOT_CREATED=true
fi
PROOF_ROOT="$(realpath -e "$PROOF_ROOT")"
if [[ "$PROOF_ROOT_CREATED" == true ]]; then
  chown "$(stat -c '%u:%g' "$REPO_ROOT")" "$PROOF_ROOT"
fi
PROOF_DIR="$(mktemp -d "$PROOF_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${TARGET_SHA:0:12}-physical.XXXXXX")"
PROOF_DIR="$(realpath -e "$PROOF_DIR")"
readonly PROOF_DIR
PROOF_LOG="$PROOF_DIR/rehearsal-proof.log"
PROOF_SHA_FILE="$PROOF_DIR/rehearsal-proof.log.sha256"
readonly PROOF_LOG PROOF_SHA_FILE
: > "$PROOF_LOG"
chmod 0600 "$PROOF_LOG"

CONTAINER_NAME="${CONTAINER_PREFIX}${TARGET_SHA:0:8}-$$"
readonly CONTAINER_NAME
if [[ ! "$CONTAINER_NAME" =~ ^norva-partners-physical-rehearsal-[0-9a-f]{8}-[0-9]+$ ]]; then
  printf 'ERROR: generated an unsafe rehearsal container name.\n' >&2
  exit 1
fi

CURRENT_STEP="initialization"
RESULT="failed"
CONTAINER_CREATED=false
LIVE_CONTAINER_ID=""
LIVE_STARTED_AT=""
LIVE_RESTART_COUNT=""
LIVE_HEALTH=""
CLONE_PRELOADS=""

proof_line() {
  # Callers pass only controlled labels, validated hashes, timestamps and
  # numeric aggregates. Never pass command output or environment values here.
  printf '%s\n' "$1" >> "$PROOF_LOG"
}

fail() {
  printf 'ERROR: Partners physical rehearsal failed at step: %s.\n' \
    "$CURRENT_STEP" >&2
  exit 1
}

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  local proof_digest=""
  trap - EXIT INT TERM HUP
  set +e

  if [[ "$CONTAINER_CREATED" == true ]]; then
    if [[ "$CONTAINER_NAME" =~ ^norva-partners-physical-rehearsal-[0-9a-f]{8}-[0-9]+$ ]]; then
      docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  fi

  if [[ -n "${WORKDIR:-}" && -d "$WORKDIR" ]]; then
    case "$(realpath -e "$WORKDIR" 2>/dev/null)" in
      "$SAFE_WORKDIR_PREFIX"*) rm -rf -- "$WORKDIR" || cleanup_failed=1 ;;
      *) cleanup_failed=1 ;;
    esac
  fi

  if [[ "$cleanup_failed" -ne 0 && "$exit_code" -eq 0 ]]; then
    exit_code=1
    RESULT="failed"
    CURRENT_STEP="safe cleanup"
  fi

  if [[ "$exit_code" -eq 0 && "$RESULT" == "passed" ]]; then
    proof_line "result=passed"
  else
    proof_line "result=failed"
    proof_line "failed_step=$CURRENT_STEP"
    proof_line "raw_output_retained=false"
  fi
  proof_line "finished_at=$(date -u +%FT%TZ)"

  chmod 0600 "$PROOF_LOG"
  proof_digest="$(sha256sum "$PROOF_LOG" | awk '{print $1}')"
  printf '%s  %s\n' "$proof_digest" "$(basename "$PROOF_LOG")" \
    > "$PROOF_SHA_FILE"
  chmod 0600 "$PROOF_SHA_FILE"

  # Return ownership to the checkout owner so the non-root operator can retain
  # the proof. Modes remain private even when the repository is group-readable.
  chown "$(stat -c '%u:%g' "$REPO_ROOT")" "$PROOF_DIR" \
    "$PROOF_LOG" "$PROOF_SHA_FILE" 2>/dev/null || true

  printf 'Partners physical rehearsal proof: %s\n' "$PROOF_LOG"
  printf 'SHA256: %s\n' "$proof_digest"
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

proof_line "format=norva-partners-physical-rehearsal-v1"
proof_line "candidate_sha=$TARGET_SHA"
proof_line "started_at=$(date -u +%FT%TZ)"
proof_line "network_mode=none"
proof_line "raw_output_retained=false"

RAW_DIR="$WORKDIR/raw"
CANDIDATE_DIR="$WORKDIR/candidate"
BASE_DIR="$WORKDIR/base"
DATA_DIR="$WORKDIR/data"
install -d -m 0700 "$RAW_DIR" "$CANDIDATE_DIR" "$BASE_DIR" "$DATA_DIR"

CURRENT_STEP="candidate materialization"
for candidate_file in "${CANDIDATE_FILES[@]}"; do
  destination="$CANDIDATE_DIR/$candidate_file"
  install -d -m 0700 "$(dirname "$destination")"
  if ! "${GIT[@]}" show "$TARGET_SHA:$candidate_file" \
      > "$destination" 2> "$RAW_DIR/git-show.log"; then
    fail
  fi
  chmod 0600 "$destination"
done
proof_line "candidate_files=${#CANDIDATE_FILES[@]}"
proof_line "migration_one_sha256=$(sha256sum "$CANDIDATE_DIR/$MIGRATION_ONE" | awk '{print $1}')"
proof_line "migration_two_sha256=$(sha256sum "$CANDIDATE_DIR/$MIGRATION_TWO" | awk '{print $1}')"

CURRENT_STEP="exact PostgreSQL image verification"
if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  fail
fi
LIVE_CONTAINER_ID="$(docker inspect --format '{{.Id}}' "$DB_CONTAINER")"
LIVE_STARTED_AT="$(docker inspect --format '{{.State.StartedAt}}' "$DB_CONTAINER")"
LIVE_RESTART_COUNT="$(docker inspect --format '{{.RestartCount}}' "$DB_CONTAINER")"
LIVE_RUNNING="$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER")"
LIVE_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$DB_CONTAINER")"
LIVE_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$DB_CONTAINER")"
PINNED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PG_IMAGE" 2>/dev/null)" || fail
if [[ "$LIVE_RUNNING" != "true" || "$LIVE_HEALTH" != "healthy" \
    || ! "$LIVE_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ \
    || "$LIVE_IMAGE_ID" != "$PINNED_IMAGE_ID" ]]; then
  fail
fi
proof_line "postgres_image_id=$PINNED_IMAGE_ID"
proof_line "live_health_before=healthy"

CURRENT_STEP="safe preload derivation"
# Preserve every production preload needed by the restored schema, but remove
# the only two background/network-capable modules. This is a read-only SHOW on
# the live instance; all subsequent SQL targets the isolated clone.
LIVE_PRELOADS_RAW="$(docker exec -u postgres "$DB_CONTAINER" \
  psql -X -A -t -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -c 'show shared_preload_libraries;' \
  2> "$RAW_DIR/live-preloads.log")" || fail
LIVE_PRELOADS_RAW="${LIVE_PRELOADS_RAW//$'\r'/}"
LIVE_PRELOADS_RAW="${LIVE_PRELOADS_RAW//$'\n'/}"
if [[ ! "$LIVE_PRELOADS_RAW" =~ ^[a-zA-Z0-9_,[:space:]]+$ ]]; then
  fail
fi
IFS=',' read -r -a LIVE_PRELOAD_ARRAY <<< "$LIVE_PRELOADS_RAW"
SAW_PG_CRON=false
SAW_PG_NET=false
for preload_library in "${LIVE_PRELOAD_ARRAY[@]}"; do
  preload_library="${preload_library//[[:space:]]/}"
  if [[ ! "$preload_library" =~ ^[a-zA-Z0-9_]+$ ]]; then
    fail
  fi
  case "$preload_library" in
    pg_cron)
      SAW_PG_CRON=true
      ;;
    pg_net)
      SAW_PG_NET=true
      ;;
    *)
      if [[ -n "$CLONE_PRELOADS" ]]; then
        CLONE_PRELOADS+=","
      fi
      CLONE_PRELOADS+="$preload_library"
      ;;
  esac
done
if [[ "$SAW_PG_CRON" != true || "$SAW_PG_NET" != true \
    || -z "$CLONE_PRELOADS" \
    || "$CLONE_PRELOADS" == *pg_cron* || "$CLONE_PRELOADS" == *pg_net* ]]; then
  fail
fi
proof_line "live_preloads_sha256=$(printf '%s' "$LIVE_PRELOADS_RAW" | sha256sum | awk '{print $1}')"
proof_line "clone_preloads=$CLONE_PRELOADS"

CURRENT_STEP="latest R2 base backup selection"
RCLONE_TIMEOUT_SECONDS="${PARTNERS_REHEARSAL_RCLONE_TIMEOUT_SECONDS:-7200}"
if [[ ! "$RCLONE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{2,5}$ ]]; then
  fail
fi
if ! timeout --signal=TERM --kill-after=30s "$RCLONE_TIMEOUT_SECONDS" \
    rclone lsf "r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/" --dirs-only \
    > "$RAW_DIR/base-list.txt" 2> "$RAW_DIR/rclone-list.log"; then
  fail
fi
LAST_BASE="$(LC_ALL=C sort "$RAW_DIR/base-list.txt" | tail -n 1 | tr -d '\r')"
if [[ ! "$LAST_BASE" =~ ^base-[0-9]{8}-[0-9]{6}/?$ ]]; then
  fail
fi
LAST_BASE="${LAST_BASE%/}"
proof_line "base_backup=$LAST_BASE"

CURRENT_STEP="R2 base backup download"
if ! timeout --signal=TERM --kill-after=30s "$RCLONE_TIMEOUT_SECONDS" \
    rclone copy \
      "r2:${R2_BUCKET}/${R2_PREFIX_BASE%/}/$LAST_BASE" \
      "$BASE_DIR" --retries 4 --checkers 4 --transfers 2 \
      > "$RAW_DIR/rclone-copy.log" 2>&1; then
  fail
fi
if [[ ! -f "$BASE_DIR/base.tar.gz" || -L "$BASE_DIR/base.tar.gz" ]]; then
  fail
fi
proof_line "base_archive_sha256=$(sha256sum "$BASE_DIR/base.tar.gz" | awk '{print $1}')"

validate_tar_archive() {
  local archive_path="$1"
  local label="$2"
  local member=""
  local member_normalized=""
  local listing="$RAW_DIR/$label-members.txt"
  local verbose_listing="$RAW_DIR/$label-members-verbose.txt"

  if ! tar -tzf "$archive_path" > "$listing" 2> "$RAW_DIR/$label-tar-list.log"; then
    return 1
  fi
  while IFS= read -r member; do
    member_normalized="${member#./}"
    if [[ -z "$member_normalized" \
        || "$member_normalized" == /* \
        || "$member_normalized" == ".." \
        || "$member_normalized" == ../* \
        || "$member_normalized" == */../* \
        || "$member_normalized" == */.. ]]; then
      return 1
    fi
  done < "$listing"

  if ! tar -tvzf "$archive_path" > "$verbose_listing" \
      2> "$RAW_DIR/$label-tar-verbose.log"; then
    return 1
  fi
  # A PostgreSQL base backup without external tablespaces needs only regular
  # files and directories. Reject links so extraction as root cannot escape.
  if awk '$1 ~ /^[lh]/ { found = 1 } END { exit found ? 0 : 1 }' \
      "$verbose_listing"; then
    return 1
  fi
}

CURRENT_STEP="base archive validation and extraction"
validate_tar_archive "$BASE_DIR/base.tar.gz" "base" || fail
if ! tar -xzf "$BASE_DIR/base.tar.gz" --no-same-owner --no-same-permissions \
    -C "$DATA_DIR" > "$RAW_DIR/base-extract.log" 2>&1; then
  fail
fi
if [[ -f "$BASE_DIR/pg_wal.tar.gz" ]]; then
  if [[ -L "$BASE_DIR/pg_wal.tar.gz" ]]; then
    fail
  fi
  validate_tar_archive "$BASE_DIR/pg_wal.tar.gz" "pg-wal" || fail
  install -d -m 0700 "$DATA_DIR/pg_wal"
  if ! tar -xzf "$BASE_DIR/pg_wal.tar.gz" --no-same-owner \
      --no-same-permissions -C "$DATA_DIR/pg_wal" \
      > "$RAW_DIR/pg-wal-extract.log" 2>&1; then
    fail
  fi
  proof_line "pg_wal_archive_sha256=$(sha256sum "$BASE_DIR/pg_wal.tar.gz" | awk '{print $1}')"
fi
if [[ ! -f "$DATA_DIR/PG_VERSION" || -L "$DATA_DIR/PG_VERSION" \
    || -e "$DATA_DIR/standby.signal" || -e "$DATA_DIR/recovery.signal" ]]; then
  fail
fi
PG_MAJOR="$(tr -d '[:space:]' < "$DATA_DIR/PG_VERSION")"
if [[ ! "$PG_MAJOR" =~ ^[0-9]{2}$ ]]; then
  fail
fi
proof_line "postgres_major=$PG_MAJOR"

CURRENT_STEP="clone ownership preparation"
PG_UID_GID="$(docker run --rm --network none --entrypoint sh "$PG_IMAGE" \
  -c 'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"' \
  2> "$RAW_DIR/image-id.log")" || fail
if [[ ! "$PG_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
  fail
fi
chown -R "$PG_UID_GID" "$DATA_DIR"
chown -R "$PG_UID_GID" "$CANDIDATE_DIR"
find "$CANDIDATE_DIR" -type d -exec chmod 0500 {} +
find "$CANDIDATE_DIR" -type f -exec chmod 0400 {} +

CURRENT_STEP="isolated clone startup"
if ! docker run -d \
    --name "$CONTAINER_NAME" \
    --network none \
    --label "tv.norva.purpose=partners-physical-rehearsal" \
    --label "tv.norva.candidate=$TARGET_SHA" \
    -v "$DATA_DIR:/var/lib/postgresql/data" \
    -v "$CANDIDATE_DIR:/candidate:ro" \
    -e POSTGRES_PASSWORD=rehearsal-only-not-a-secret \
    "$PG_IMAGE" postgres \
      -c "shared_preload_libraries=$CLONE_PRELOADS" \
      -c cron.database_name=__norva_rehearsal_disabled__ \
      -c archive_mode=off \
      -c listen_addresses= \
    > "$RAW_DIR/docker-run.log" 2>&1; then
  fail
fi
CONTAINER_CREATED=true
if [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$CONTAINER_NAME")" != "none" ]]; then
  fail
fi

STARTUP_TIMEOUT_SECONDS="${PARTNERS_REHEARSAL_STARTUP_TIMEOUT_SECONDS:-300}"
if [[ ! "$STARTUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{1,3}$ ]]; then
  fail
fi
clone_ready=false
for (( elapsed=0; elapsed<STARTUP_TIMEOUT_SECONDS; elapsed+=2 )); do
  if docker exec "$CONTAINER_NAME" pg_isready -q -U postgres -d postgres \
      >/dev/null 2>&1; then
    clone_ready=true
    break
  fi
  sleep 2
done
if [[ "$clone_ready" != true ]]; then
  fail
fi
proof_line "clone_ready=true"

clone_psql() {
  docker exec -i -u "$PG_UID_GID" "$CONTAINER_NAME" \
    psql -X -U supabase_admin -d postgres "$@"
}

CURRENT_STEP="cron neutralization"
ACTUAL_CLONE_PRELOADS="$(clone_psql -At -v ON_ERROR_STOP=1 \
  -c 'show shared_preload_libraries;' \
  2> "$RAW_DIR/clone-preloads.log")" || fail
ACTUAL_CLONE_PRELOADS="${ACTUAL_CLONE_PRELOADS//[[:space:]]/}"
if [[ "$ACTUAL_CLONE_PRELOADS" != "$CLONE_PRELOADS" ]]; then
  fail
fi
if ! clone_psql -v ON_ERROR_STOP=1 > "$RAW_DIR/cron-neutralization.log" 2>&1 <<'SQL'
begin;
do $cron_rehearsal_guard$
begin
  if string_to_array(
    replace(current_setting('shared_preload_libraries'), ' ', ''),
    ','
  ) && array['pg_cron', 'pg_net'] then
    raise exception 'rehearsal background preloads are not disabled';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_stat_activity
    where backend_type ilike '%cron%'
  ) then
    raise exception 'a cron worker started in the rehearsal clone';
  end if;
  if to_regclass('cron.job') is null then
    raise exception 'restored clone omitted cron.job';
  end if;
end;
$cron_rehearsal_guard$;
update cron.job set active = false where active;
do $cron_rehearsal_zero$
begin
  if exists (select 1 from cron.job where active) then
    raise exception 'an active cron remained in the rehearsal clone';
  end if;
end;
$cron_rehearsal_zero$;
commit;
SQL
then
  fail
fi
proof_line "cron_network_preloads=disabled"
proof_line "active_crons=0"

CURRENT_STEP="baseline aggregate capture"
BASELINE_COUNTS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (select count(*) from auth.users)::text || '|' || (select count(*) from affiliate_private.affiliate_accounts)::text || '|' || (select count(*) from affiliate_private.affiliate_events)::text;" \
  2> "$RAW_DIR/baseline-counts.log")" || fail
if [[ ! "$BASELINE_COUNTS" =~ ^[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  fail
fi
IFS='|' read -r BASELINE_USERS BASELINE_ACCOUNTS BASELINE_EVENTS \
  <<< "$BASELINE_COUNTS"
proof_line "baseline_auth_users=$BASELINE_USERS"
proof_line "baseline_partner_accounts=$BASELINE_ACCOUNTS"
proof_line "baseline_partner_events=$BASELINE_EVENTS"

CURRENT_STEP="pending migration precondition"
MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_capability_operators()') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_access_decision_email_enqueue()') is not null)::int::text;" \
  2> "$RAW_DIR/migration-precondition.log")" || fail
if [[ "$MIGRATION_MARKERS" != "0|0" ]]; then
  fail
fi

CURRENT_STEP="atomic Partners migration application"
PSQL_TIMEOUT_SECONDS="${PARTNERS_REHEARSAL_PSQL_TIMEOUT_SECONDS:-3600}"
if [[ ! "$PSQL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{2,5}$ ]]; then
  fail
fi
if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
    docker exec -i -u "$PG_UID_GID" "$CONTAINER_NAME" \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
        --single-transaction \
        -f "/candidate/$MIGRATION_ONE" \
        -f "/candidate/$MIGRATION_TWO" \
      > "$RAW_DIR/migrations.log" 2>&1; then
  fail
fi
MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_capability_operators()') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_access_decision_email_enqueue()') is not null)::int::text;" \
  2> "$RAW_DIR/migration-postcondition.log")" || fail
if [[ "$MIGRATION_MARKERS" != "1|1" ]]; then
  fail
fi
ROUTINE_OWNER_CHECK="$(clone_psql -At -v ON_ERROR_STOP=1 \
  2> "$RAW_DIR/routine-owner-postcondition.log" <<'SQL'
with expected(schema_name, routine_name) as (
  values
    ('affiliate_private', 'partners_actor_is_live_admin'),
    ('affiliate_private', 'partners_has_capability'),
    ('affiliate_private', 'partners_can_manage_capabilities'),
    ('affiliate_private', 'partners_is_release_manager'),
    ('affiliate_private', 'partners_require_aal2'),
    ('affiliate_private', 'partners_admin_operator_key'),
    ('affiliate_private', 'admin_partners_capability_operators'),
    ('affiliate_private', 'admin_partners_capability_set_by_operator_key'),
    ('affiliate_private', 'admin_partners_capability_set'),
    ('public', 'admin_partners_capability_operators'),
    ('public', 'admin_partners_capability_set_by_operator_key'),
    ('affiliate_private', 'partners_access_decision_email_enqueue')
)
select count(*)::text || '|' || count(*) filter (
  where not exists (
    select 1
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = expected.schema_name
      and routine.proname = expected.routine_name
      and pg_catalog.pg_get_userbyid(routine.proowner) = 'supabase_admin'
  )
  or exists (
    select 1
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = expected.schema_name
      and routine.proname = expected.routine_name
      and pg_catalog.pg_get_userbyid(routine.proowner) <> 'supabase_admin'
  )
)::text
from expected;
SQL
)" || fail
if [[ "$ROUTINE_OWNER_CHECK" != "12|0" ]]; then
  fail
fi
proof_line "migrations_applied=2"
proof_line "migrations_atomic=true"
proof_line "migration_routine_owner=supabase_admin"

CURRENT_STEP="Partners restore verifier"
if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
    docker exec -i -u "$PG_UID_GID" "$CONTAINER_NAME" \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
        -f "/candidate/$VERIFIER" \
      > "$RAW_DIR/restore-verifier.log" 2>&1; then
  fail
fi
proof_line "restore_verifier=passed"

run_pgtap_file() {
  local relative_path="$1"
  local safe_name=""
  local output_path=""
  local plan_line=""
  local expected_tests=""
  local passed_tests=""
  local first_statement=""
  local last_statement=""

  safe_name="$(basename "$relative_path" .sql)"
  output_path="$RAW_DIR/pgtap-$safe_name.log"
  first_statement="$(awk 'NF { print tolower($0); exit }' \
    "$CANDIDATE_DIR/$relative_path")"
  last_statement="$(awk 'NF { line=tolower($0) } END { print line }' \
    "$CANDIDATE_DIR/$relative_path")"
  if [[ "$first_statement" != "begin;" || "$last_statement" != "rollback;" ]]; then
    return 1
  fi
  if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
      docker exec -i -u "$PG_UID_GID" "$CONTAINER_NAME" \
        psql -X -A -t -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
          -f "/candidate/$relative_path" \
        > "$output_path" 2>&1; then
    return 1
  fi
  if grep -Eq '^(not ok|Bail out!)' "$output_path"; then
    return 1
  fi
  plan_line="$(grep -E '^1\.\.[0-9]+$' "$output_path" | tail -n 1)"
  if [[ ! "$plan_line" =~ ^1\.\.[0-9]+$ ]]; then
    return 1
  fi
  expected_tests="${plan_line#1..}"
  passed_tests="$(grep -Ec '^ok( |$)' "$output_path" || true)"
  if [[ "$passed_tests" != "$expected_tests" ]]; then
    return 1
  fi
  proof_line "pgtap_${safe_name}=passed:$passed_tests"
}

for pgtap_file in "${PGTAP_FILES[@]}"; do
  CURRENT_STEP="pgTAP $(basename "$pgtap_file")"
  run_pgtap_file "$pgtap_file" || fail
done
proof_line "pgtap_files=${#PGTAP_FILES[@]}"
proof_line "pgtap_transaction_guards=true"

CURRENT_STEP="post-test invariant verification"
if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
    docker exec -i -u "$PG_UID_GID" "$CONTAINER_NAME" \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
        -f "/candidate/$VERIFIER" \
      > "$RAW_DIR/post-test-verifier.log" 2>&1; then
  fail
fi
FINAL_COUNTS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (select count(*) from auth.users)::text || '|' || (select count(*) from affiliate_private.affiliate_accounts)::text || '|' || (select count(*) from affiliate_private.affiliate_events)::text || '|' || (select count(*) from cron.job where active)::text || '|' || (select count(*) from pg_catalog.pg_stat_activity where backend_type ilike '%cron%')::text;" \
  2> "$RAW_DIR/final-counts.log")" || fail
if [[ "$FINAL_COUNTS" != "$BASELINE_COUNTS|0|0" ]]; then
  fail
fi
proof_line "post_test_restore_verifier=passed"
proof_line "test_transactions_rolled_back=true"

CURRENT_STEP="live container non-mutation check"
LIVE_PRELOADS_AFTER="$(docker exec -u postgres "$DB_CONTAINER" \
  psql -X -A -t -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -c 'show shared_preload_libraries;' \
  2> "$RAW_DIR/live-preloads-after.log")" || fail
LIVE_PRELOADS_AFTER="${LIVE_PRELOADS_AFTER//$'\r'/}"
LIVE_PRELOADS_AFTER="${LIVE_PRELOADS_AFTER//$'\n'/}"
if [[ "$(docker inspect --format '{{.Id}}' "$DB_CONTAINER")" != "$LIVE_CONTAINER_ID" \
    || "$(docker inspect --format '{{.State.StartedAt}}' "$DB_CONTAINER")" != "$LIVE_STARTED_AT" \
    || "$(docker inspect --format '{{.RestartCount}}' "$DB_CONTAINER")" != "$LIVE_RESTART_COUNT" \
    || "$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER")" != "true" \
    || "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$DB_CONTAINER")" != "healthy" \
    || "$LIVE_PRELOADS_AFTER" != "$LIVE_PRELOADS_RAW" ]]; then
  fail
fi
proof_line "live_container_unchanged=true"
proof_line "live_health_after=healthy"

CURRENT_STEP="complete"
RESULT="passed"
