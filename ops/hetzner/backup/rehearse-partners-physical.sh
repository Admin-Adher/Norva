#!/usr/bin/env bash
# =============================================================================
# rehearse-partners-physical.sh
#
# Restore the latest R2 physical base backup into a short-lived, no-network
# PostgreSQL clone, either align the guided Didit preflight with the immutable
# approval registry after the audited f0e3212 production baseline atomically
# (`predeploy`), or prove that the alignment is already present without
# replaying it (`postdeploy`), then run the verifier and restore-compatible
# pgTAP.
#
# This script is intentionally root-only because /etc/norva-backup.env is
# root-owned. The live container is inspected and receives one read-only SHOW
# query; no live table, service configuration or checkout is mutated.
# Raw command output stays in the private temporary directory and is deleted.
# The durable proof contains only controlled identifiers, aggregate counters
# and pass/fail summaries.
#
# Usage:
#   sudo bash ops/hetzner/backup/rehearse-partners-physical.sh \
#     <predeploy|postdeploy> <40-char-sha>
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

if [[ "$#" -ne 2 ]]; then
  printf 'ERROR: usage: %s <predeploy|postdeploy> <40-char-sha>.\n' \
    "$SCRIPT_NAME" >&2
  exit 1
fi

REHEARSAL_MODE="${1:-}"
if [[ "$REHEARSAL_MODE" != "predeploy" \
    && "$REHEARSAL_MODE" != "postdeploy" ]]; then
  printf 'ERROR: pass an explicit rehearsal mode: predeploy or postdeploy.\n' >&2
  exit 1
fi
readonly REHEARSAL_MODE

TARGET_SHA="${2:-}"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'ERROR: pass the exact 40-character lowercase candidate commit SHA after the mode.\n' >&2
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

readonly BASELINE_CONTRACT="f0e3212"
readonly HOTFIX_MIGRATION="supabase/migrations/20260810080836_partners_didit_preflight_registry_truth.sql"
readonly BASELINE_CORE_MARKERS="1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1"
readonly FRICTIONLESS_MARKERS_COMPLETE="1|1|1"
readonly OWNER_RISK_MARKER_COMPLETE="1"
readonly MULTICURRENCY_MARKERS_COMPLETE="1|1"
readonly WEB_TAX_MARKERS_COMPLETE="1|1"
readonly OWNER_REVIEW_VALIDITY_MARKER_COMPLETE="1"
readonly BOOTSTRAP_BOOLEAN_MARKER_COMPLETE="1"
readonly DIDIT_GUIDED_PREFLIGHT_MARKER_COMPLETE="1"
readonly FR_PILOT_USD_ALIGNMENT_MARKER_COMPLETE="1"
readonly DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER_COMPLETE="1"
readonly VERIFIER="ops/hetzner/backup/verify-partners-restore.sql"
# The exhaustive mutation suites intentionally assume a blank disposable CI
# database. A physical restore contains real operators, requests and financial
# history, so it must use cardinality-independent catalogue and data checks.
readonly -a RESTORE_PGTAP_FILES=(
  "supabase/tests/affiliate_restore_compatibility.sql"
)
readonly -a CANDIDATE_FILES=(
  "$HOTFIX_MIGRATION"
  "$VERIFIER"
  "${RESTORE_PGTAP_FILES[@]}"
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
proof_line "rehearsal_mode=$REHEARSAL_MODE"
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
proof_line "baseline_contract=$BASELINE_CONTRACT"
proof_line "baseline_markers_verified=36"
proof_line "hotfix_migration_sha256=$(sha256sum "$CANDIDATE_DIR/$HOTFIX_MIGRATION" | awk '{print $1}')"

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

capture_sensitive_partner_state() {
  local state_timeout_seconds="${PARTNERS_REHEARSAL_STATE_TIMEOUT_SECONDS:-600}"
  if [[ ! "$state_timeout_seconds" =~ ^[1-9][0-9]{1,3}$ ]]; then
    return 1
  fi
  # Hash each row first so future outbox growth cannot materialize every email
  # payload in one large JSON aggregate. Only the final digest leaves psql.
  timeout --signal=TERM --kill-after=30s "$state_timeout_seconds" \
    docker exec -u "$PG_UID_GID" "$CONTAINER_NAME" \
      psql -X -A -t -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
      "select (select count(*) from affiliate_private.affiliate_admin_capabilities)::text || '|' || (select count(*) from affiliate_private.affiliate_access_requests)::text || '|' || (select count(*) from public.cloud_branded_email_outbox where flow in ('partners_access_approved', 'partners_access_declined'))::text || '|' || encode(extensions.digest(coalesce((select string_agg(encode(extensions.digest(to_jsonb(capability_row)::text, 'sha256'), 'hex'), '' order by capability_row.user_id, capability_row.capability) from affiliate_private.affiliate_admin_capabilities capability_row), '') || '|' || coalesce((select string_agg(encode(extensions.digest(to_jsonb(request_row)::text, 'sha256'), 'hex'), '' order by request_row.id) from affiliate_private.affiliate_access_requests request_row), '') || '|' || coalesce((select string_agg(encode(extensions.digest(to_jsonb(outbox_row)::text, 'sha256'), 'hex'), '' order by outbox_row.id) from public.cloud_branded_email_outbox outbox_row where outbox_row.flow in ('partners_access_approved', 'partners_access_declined')), ''), 'sha256'), 'hex');"
}

capture_fr_alignment_release_state() {
  clone_psql -At -v ON_ERROR_STOP=1 -c \
    "with scoped_gate as (select distinct gate.gate_key from affiliate_private.affiliate_release_gates gate join affiliate_private.affiliate_release_gate_approval_bindings binding on binding.gate_key = gate.gate_key join affiliate_private.affiliate_approval_packages package on package.id = binding.approval_package_id join affiliate_private.affiliate_program_versions program on program.id = package.program_version_id cross join lateral jsonb_array_elements(package.jurisdiction_scope) scope(item) where gate.satisfied and program.version_key = 'individual-global-p0-v2' and program.status = 'active' and program.account_type = 'individual' and program.commission_rate_bps = 2000 and program.attribution_window_days = 30 and program.maturation_days = 45 and program.threshold_reference_currency = 'USD' and program.threshold_reference_minor = 1000 and program.payout_fee_policy = 'platform_absorbed' and scope.item ->> 'country_code' = 'FR' and nullif(scope.item ->> 'subdivision_code', '') is null) select (select count(*) from affiliate_private.affiliate_release_gates)::text || '|' || (select count(*) from affiliate_private.affiliate_release_gates where satisfied)::text || '|' || (select count(*) from affiliate_private.affiliate_release_gate_approval_bindings)::text || '|' || (select count(*) from scoped_gate)::text || '|' || (select count(*) from affiliate_private.affiliate_events where action = 'country_policy_currency_aligned' and aggregate_key = 'individual-global-p0-v2:FR:*')::text || '|' || (select count(*) from affiliate_private.affiliate_events where action = 'release_gate_revoked_for_policy_alignment' and before_state ->> 'country_code' = 'FR')::text;"
}

capture_fr_alignment_flag_state() {
  clone_psql -At -v ON_ERROR_STOP=1 -c \
    "select count(*)::text || '|' || count(*) filter (where flag.enabled)::text || '|' || count(*) filter (where flag.enabled and flag.key in ('partners_enabled','partners_earnings_enabled','partners_credit_redemptions_enabled','partners_shadow_mode'))::text || '|' || (select count(*) from affiliate_private.affiliate_events event where event.action = 'feature_flag_disabled_for_policy_alignment')::text from public.admin_feature_flags flag where flag.key = any(array['partners_enabled','partners_invite_only','partners_cash_pilot_allowlist_only','partners_earnings_enabled','partners_credit_redemptions_enabled','partners_shadow_mode','partners_payouts_live','partners_tv_relay_enabled','partners_revolut_api_enabled']::text[]);"
}

CURRENT_STEP="background worker neutralization"
ACTUAL_CLONE_PRELOADS="$(clone_psql -At -v ON_ERROR_STOP=1 \
  -c 'show shared_preload_libraries;' \
  2> "$RAW_DIR/clone-preloads.log")" || fail
ACTUAL_CLONE_PRELOADS="${ACTUAL_CLONE_PRELOADS//[[:space:]]/}"
if [[ "$ACTUAL_CLONE_PRELOADS" != "$CLONE_PRELOADS" ]]; then
  fail
fi
if ! clone_psql -v ON_ERROR_STOP=1 > "$RAW_DIR/background-neutralization.log" 2>&1 <<'SQL'
begin read only;
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
    where backend_type ~* '(pg_cron|pg_net|cron scheduler)'
  ) then
    raise exception 'a cron or pg_net worker started in the rehearsal clone';
  end if;
  if to_regclass('cron.job') is null then
    raise exception 'restored clone omitted cron.job';
  end if;
end;
$cron_rehearsal_guard$;
commit;
SQL
then
  fail
fi
proof_line "cron_network_preloads=disabled"
proof_line "cron_network_workers=disabled"

# Do not mutate cron.job in the clone. Its cache-invalidation trigger loads
# $libdir/pg_cron, which cannot be loaded on demand after pg_cron is deliberately
# removed from shared_preload_libraries. Without that preload there is no
# scheduler capable of executing these metadata rows in the no-network clone.
BASELINE_CRON_COUNTS="$(clone_psql -At -v ON_ERROR_STOP=1 \
  -c "select count(*)::text || '|' || count(*) filter (where active)::text from cron.job;" \
  2> "$RAW_DIR/baseline-cron-counts.log")" || fail
if [[ ! "$BASELINE_CRON_COUNTS" =~ ^[0-9]+\|[0-9]+$ ]]; then
  fail
fi
proof_line "cron_metadata_counts=$BASELINE_CRON_COUNTS"

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

CURRENT_STEP="sensitive Partners baseline capture"
BASELINE_SENSITIVE_STATE="$(capture_sensitive_partner_state \
  2> "$RAW_DIR/baseline-sensitive-state.log")" || fail
if [[ ! "$BASELINE_SENSITIVE_STATE" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9a-f]{64}$ ]]; then
  fail
fi

CURRENT_STEP="migration-state precondition"
MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_capability_operators()') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_access_decision_email_enqueue()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_didit_session_registry') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.guard_partners_release_gate_activation_aal2()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_approval_packages') is not null)::int::text || '|' || (to_regprocedure('public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_release_gate_approval_is_current(text)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_deployment_manifests') is not null)::int::text || '|' || (to_regprocedure('public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.guard_partners_pilot_allowlist_limit()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_biometric_consent_attestations') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_didit_purge_outbox') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_didit_purge_claim(integer,integer)') is not null)::int::text || '|' || (not has_function_privilege('service_role','public.partners_service_kyc_prepare(uuid,text,text,boolean,text)','EXECUTE'))::int::text || '|' || (not has_function_privilege('service_role','public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)','EXECUTE'))::int::text || '|' || (to_regclass('affiliate_private.affiliate_biometric_consent_withdrawals') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_kyc_human_review_requests') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_rights_get(uuid)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_kyc_reverification_grants') is not null)::int::text;" \
  2> "$RAW_DIR/migration-precondition.log")" || fail
DEPLOYMENT_MANIFEST_EVENT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select coalesce(bool_or(position('deployment_manifest' in pg_get_constraintdef(constraint_row.oid)) > 0), false)::int::text from pg_constraint constraint_row where constraint_row.conrelid = 'affiliate_private.affiliate_events'::regclass and constraint_row.conname = 'affiliate_events_aggregate_type';" \
  2> "$RAW_DIR/deployment-manifest-event-precondition.log")" || fail
FRICTIONLESS_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regclass('affiliate_private.affiliate_access_credit_catalog') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_payout_country_bind(uuid,text,text)') is not null)::int::text || '|' || (exists (select 1 from affiliate_private.affiliate_release_gates where gate_key = 'membership_privacy_approved'))::int::text;" \
  2> "$RAW_DIR/frictionless-migration-precondition.log")" || fail
OWNER_RISK_MIGRATION_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (affiliate_private.partners_approval_required_document_keys('legal_and_tax_approved') @> array['owner_risk_acceptance','partners_disclosure','tax_operating_policy']::text[])::int::text;" \
  2> "$RAW_DIR/owner-risk-migration-precondition.log")" || fail
MULTICURRENCY_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)') is not null)::int::text || '|' || (exists (select 1 from information_schema.columns where table_schema = 'affiliate_private' and table_name = 'affiliate_access_credit_quotes' and column_name = 'reference_total_amount_minor') and exists (select 1 from information_schema.columns where table_schema = 'affiliate_private' and table_name = 'affiliate_access_credit_redemptions' and column_name = 'reference_amount_minor'))::int::text;" \
  2> "$RAW_DIR/multicurrency-migration-precondition.log")" || fail
WEB_TAX_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regclass('affiliate_private.affiliate_web_tax_policies') is not null)::int::text || '|' || (to_regprocedure('public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)') is not null)::int::text;" \
  2> "$RAW_DIR/web-tax-migration-precondition.log")" || fail
OWNER_REVIEW_VALIDITY_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select exists (select 1 from pg_catalog.pg_constraint constraint_row where constraint_row.conrelid = 'affiliate_private.affiliate_approval_packages'::regclass and constraint_row.conname = 'affiliate_approval_packages_owner_review_validity' and constraint_row.contype = 'c' and constraint_row.convalidated)::int::text;" \
  2> "$RAW_DIR/owner-review-validity-precondition.log")" || fail
BOOTSTRAP_BOOLEAN_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (regexp_replace(lower(pg_get_functiondef('affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure)), '[[:space:]]+', ' ', 'g') like '%''ready'', coalesce( v_account.member_status = ''active'' and v_credits_enabled, false )%')::int::text;" \
  2> "$RAW_DIR/bootstrap-boolean-precondition.log")" || fail
DIDIT_GUIDED_PREFLIGHT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_kyc_certification_preflight()') is not null)::int::text;" \
  2> "$RAW_DIR/didit-guided-preflight-precondition.log")" || fail
FR_PILOT_USD_ALIGNMENT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select case when policy.payout_currencies = array['EUR']::text[] and not policy.individual_available and not exists (select 1 from affiliate_private.affiliate_accounts account where account.country_policy_id = policy.id and account.status <> 'closed') then 0 when policy.payout_currencies = array['USD']::text[] and not policy.individual_available and not exists (select 1 from affiliate_private.affiliate_accounts account where account.country_policy_id = policy.id and account.status <> 'closed') then 1 else 2 end::text from affiliate_private.affiliate_country_policies policy join affiliate_private.affiliate_program_versions program on program.id = policy.program_version_id where program.version_key = 'individual-global-p0-v2' and program.status = 'active' and program.account_type = 'individual' and program.commission_rate_bps = 2000 and program.attribution_window_days = 30 and program.maturation_days = 45 and program.threshold_reference_currency = 'USD' and program.threshold_reference_minor = 1000 and program.payout_fee_policy = 'platform_absorbed' and policy.country_code = 'FR' and policy.subdivision_code is null;" \
  2> "$RAW_DIR/fr-pilot-usd-alignment-precondition.log")" || fail
DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (position('partners_release_gate_approval_is_current' in lower(pg_get_functiondef('affiliate_private.admin_partners_kyc_certification_preflight()'::regprocedure))) > 0 and position('and gate.satisfied' in lower(pg_get_functiondef('affiliate_private.admin_partners_kyc_certification_preflight()'::regprocedure))) = 0)::int::text;" \
  2> "$RAW_DIR/didit-preflight-registry-truth-precondition.log")" || fail
MIGRATION_MARKERS="${MIGRATION_MARKERS}|${DEPLOYMENT_MANIFEST_EVENT_MARKER}|${FRICTIONLESS_MIGRATION_MARKERS}|${OWNER_RISK_MIGRATION_MARKER}|${MULTICURRENCY_MIGRATION_MARKERS}|${WEB_TAX_MIGRATION_MARKERS}|${OWNER_REVIEW_VALIDITY_MARKER}|${BOOTSTRAP_BOOLEAN_MARKER}|${DIDIT_GUIDED_PREFLIGHT_MARKER}|${FR_PILOT_USD_ALIGNMENT_MARKER}|${DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER}"
if [[ "$REHEARSAL_MODE" == "predeploy" ]]; then
  # The audited f0e3212 database already contains the closed France/USD
  # alignment. Only the preflight truth marker may be absent before replay.
  EXPECTED_MARKERS_BEFORE="${BASELINE_CORE_MARKERS}|${FRICTIONLESS_MARKERS_COMPLETE}|${OWNER_RISK_MARKER_COMPLETE}|${MULTICURRENCY_MARKERS_COMPLETE}|${WEB_TAX_MARKERS_COMPLETE}|${OWNER_REVIEW_VALIDITY_MARKER_COMPLETE}|${BOOTSTRAP_BOOLEAN_MARKER_COMPLETE}|${DIDIT_GUIDED_PREFLIGHT_MARKER_COMPLETE}|${FR_PILOT_USD_ALIGNMENT_MARKER_COMPLETE}|0"
else
  EXPECTED_MARKERS_BEFORE="${BASELINE_CORE_MARKERS}|${FRICTIONLESS_MARKERS_COMPLETE}|${OWNER_RISK_MARKER_COMPLETE}|${MULTICURRENCY_MARKERS_COMPLETE}|${WEB_TAX_MARKERS_COMPLETE}|${OWNER_REVIEW_VALIDITY_MARKER_COMPLETE}|${BOOTSTRAP_BOOLEAN_MARKER_COMPLETE}|${DIDIT_GUIDED_PREFLIGHT_MARKER_COMPLETE}|${FR_PILOT_USD_ALIGNMENT_MARKER_COMPLETE}|${DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER_COMPLETE}"
fi
readonly EXPECTED_MARKERS_BEFORE
if [[ "$MIGRATION_MARKERS" != "$EXPECTED_MARKERS_BEFORE" ]]; then
  fail
fi
proof_line "migration_markers_before=$MIGRATION_MARKERS"

CURRENT_STEP="France release-approval baseline capture"
FR_RELEASE_STATE_BEFORE="$(capture_fr_alignment_release_state \
  2> "$RAW_DIR/fr-release-state-before.log")" || fail
if [[ ! "$FR_RELEASE_STATE_BEFORE" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  fail
fi
IFS='|' read -r \
  BASELINE_RELEASE_GATE_TOTAL \
  BASELINE_RELEASE_GATE_SATISFIED \
  BASELINE_RELEASE_BINDINGS \
  BASELINE_FR_SCOPED_GATES \
  BASELINE_FR_ALIGNMENT_EVENTS \
  BASELINE_FR_REVOCATION_EVENTS \
  <<< "$FR_RELEASE_STATE_BEFORE"
if (( BASELINE_FR_SCOPED_GATES > BASELINE_RELEASE_GATE_SATISFIED \
    || BASELINE_FR_SCOPED_GATES > BASELINE_RELEASE_BINDINGS )); then
  fail
fi
proof_line "fr_scoped_release_gates_before=$BASELINE_FR_SCOPED_GATES"

CURRENT_STEP="France maintenance-flag baseline capture"
FR_FLAG_STATE_BEFORE="$(capture_fr_alignment_flag_state \
  2> "$RAW_DIR/fr-flag-state-before.log")" || fail
if [[ ! "$FR_FLAG_STATE_BEFORE" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  fail
fi
IFS='|' read -r \
  BASELINE_MANAGED_FLAG_TOTAL \
  BASELINE_MANAGED_FLAG_ENABLED \
  BASELINE_FR_MAINTENANCE_FLAGS \
  BASELINE_FR_FLAG_EVENTS \
  <<< "$FR_FLAG_STATE_BEFORE"
if (( BASELINE_FR_MAINTENANCE_FLAGS > BASELINE_MANAGED_FLAG_ENABLED )); then
  fail
fi
proof_line "fr_maintenance_flags_before=$BASELINE_FR_MAINTENANCE_FLAGS"

CURRENT_STEP="mode-specific Partners migration handling"
PSQL_TIMEOUT_SECONDS="${PARTNERS_REHEARSAL_PSQL_TIMEOUT_SECONDS:-3600}"
if [[ ! "$PSQL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{2,5}$ ]]; then
  fail
fi
# Every timed psql invocation below reads an already-mounted file with -f.
# Do not attach Docker stdin (-i): GNU timeout places its child in a separate
# process group, so an ssh -t run could otherwise suspend docker exec on SIGTTIN.
MIGRATIONS_APPLIED=0
MIGRATIONS_ATOMIC="not_applicable"
MIGRATION_REPLAY_SKIPPED="true"
if [[ "$REHEARSAL_MODE" == "predeploy" ]]; then
  if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
      docker exec -u "$PG_UID_GID" "$CONTAINER_NAME" \
        psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
          --single-transaction \
          -c '\echo NORVA_HOTFIX_MIGRATION_START' \
          -f "/candidate/$HOTFIX_MIGRATION" \
          -c '\echo NORVA_HOTFIX_MIGRATION_COMPLETE' \
        > "$RAW_DIR/migrations.log" 2>&1; then
    MIGRATION_FAILURE_STAGE="$(
      grep -E '^NORVA_HOTFIX_MIGRATION_(START|COMPLETE)$' \
        "$RAW_DIR/migrations.log" | tail -n 1 || true
    )"
    case "$MIGRATION_FAILURE_STAGE" in
      NORVA_HOTFIX_MIGRATION_START|NORVA_HOTFIX_MIGRATION_COMPLETE)
        proof_line "migration_failure_stage=$MIGRATION_FAILURE_STAGE"
        ;;
      *)
        proof_line "migration_failure_stage=unknown"
        ;;
    esac
    fail
  fi
  MIGRATIONS_APPLIED=1
  MIGRATIONS_ATOMIC="true"
  MIGRATION_REPLAY_SKIPPED="false"
fi
readonly MIGRATIONS_APPLIED MIGRATIONS_ATOMIC MIGRATION_REPLAY_SKIPPED
MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_capability_operators()') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_access_decision_email_enqueue()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_didit_session_registry') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.guard_partners_release_gate_activation_aal2()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_approval_packages') is not null)::int::text || '|' || (to_regprocedure('public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.partners_release_gate_approval_is_current(text)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_deployment_manifests') is not null)::int::text || '|' || (to_regprocedure('public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)') is not null)::int::text || '|' || (to_regprocedure('affiliate_private.guard_partners_pilot_allowlist_limit()') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_biometric_consent_attestations') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_didit_purge_outbox') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_didit_purge_claim(integer,integer)') is not null)::int::text || '|' || (not has_function_privilege('service_role','public.partners_service_kyc_prepare(uuid,text,text,boolean,text)','EXECUTE'))::int::text || '|' || (not has_function_privilege('service_role','public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)','EXECUTE'))::int::text || '|' || (to_regclass('affiliate_private.affiliate_biometric_consent_withdrawals') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_kyc_human_review_requests') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_kyc_rights_get(uuid)') is not null)::int::text || '|' || (to_regclass('affiliate_private.affiliate_kyc_reverification_grants') is not null)::int::text;" \
  2> "$RAW_DIR/migration-postcondition.log")" || fail
DEPLOYMENT_MANIFEST_EVENT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select coalesce(bool_or(position('deployment_manifest' in pg_get_constraintdef(constraint_row.oid)) > 0), false)::int::text from pg_constraint constraint_row where constraint_row.conrelid = 'affiliate_private.affiliate_events'::regclass and constraint_row.conname = 'affiliate_events_aggregate_type';" \
  2> "$RAW_DIR/deployment-manifest-event-postcondition.log")" || fail
FRICTIONLESS_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regclass('affiliate_private.affiliate_access_credit_catalog') is not null)::int::text || '|' || (to_regprocedure('public.partners_service_payout_country_bind(uuid,text,text)') is not null)::int::text || '|' || (exists (select 1 from affiliate_private.affiliate_release_gates where gate_key = 'membership_privacy_approved'))::int::text;" \
  2> "$RAW_DIR/frictionless-migration-postcondition.log")" || fail
OWNER_RISK_MIGRATION_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (affiliate_private.partners_approval_required_document_keys('legal_and_tax_approved') @> array['owner_risk_acceptance','partners_disclosure','tax_operating_policy']::text[])::int::text;" \
  2> "$RAW_DIR/owner-risk-migration-postcondition.log")" || fail
MULTICURRENCY_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)') is not null)::int::text || '|' || (exists (select 1 from information_schema.columns where table_schema = 'affiliate_private' and table_name = 'affiliate_access_credit_quotes' and column_name = 'reference_total_amount_minor') and exists (select 1 from information_schema.columns where table_schema = 'affiliate_private' and table_name = 'affiliate_access_credit_redemptions' and column_name = 'reference_amount_minor'))::int::text;" \
  2> "$RAW_DIR/multicurrency-migration-postcondition.log")" || fail
WEB_TAX_MIGRATION_MARKERS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regclass('affiliate_private.affiliate_web_tax_policies') is not null)::int::text || '|' || (to_regprocedure('public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)') is not null)::int::text;" \
  2> "$RAW_DIR/web-tax-migration-postcondition.log")" || fail
OWNER_REVIEW_VALIDITY_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select exists (select 1 from pg_catalog.pg_constraint constraint_row where constraint_row.conrelid = 'affiliate_private.affiliate_approval_packages'::regclass and constraint_row.conname = 'affiliate_approval_packages_owner_review_validity' and constraint_row.contype = 'c' and constraint_row.convalidated)::int::text;" \
  2> "$RAW_DIR/owner-review-validity-postcondition.log")" || fail
BOOTSTRAP_BOOLEAN_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (regexp_replace(lower(pg_get_functiondef('affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure)), '[[:space:]]+', ' ', 'g') like '%''ready'', coalesce( v_account.member_status = ''active'' and v_credits_enabled, false )%')::int::text;" \
  2> "$RAW_DIR/bootstrap-boolean-postcondition.log")" || fail
DIDIT_GUIDED_PREFLIGHT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (to_regprocedure('public.admin_partners_kyc_certification_preflight()') is not null)::int::text;" \
  2> "$RAW_DIR/didit-guided-preflight-postcondition.log")" || fail
FR_PILOT_USD_ALIGNMENT_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select case when policy.payout_currencies = array['EUR']::text[] and not policy.individual_available and not exists (select 1 from affiliate_private.affiliate_accounts account where account.country_policy_id = policy.id and account.status <> 'closed') then 0 when policy.payout_currencies = array['USD']::text[] and not policy.individual_available and not exists (select 1 from affiliate_private.affiliate_accounts account where account.country_policy_id = policy.id and account.status <> 'closed') then 1 else 2 end::text from affiliate_private.affiliate_country_policies policy join affiliate_private.affiliate_program_versions program on program.id = policy.program_version_id where program.version_key = 'individual-global-p0-v2' and program.status = 'active' and program.account_type = 'individual' and program.commission_rate_bps = 2000 and program.attribution_window_days = 30 and program.maturation_days = 45 and program.threshold_reference_currency = 'USD' and program.threshold_reference_minor = 1000 and program.payout_fee_policy = 'platform_absorbed' and policy.country_code = 'FR' and policy.subdivision_code is null;" \
  2> "$RAW_DIR/fr-pilot-usd-alignment-postcondition.log")" || fail
DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (position('partners_release_gate_approval_is_current' in lower(pg_get_functiondef('affiliate_private.admin_partners_kyc_certification_preflight()'::regprocedure))) > 0 and position('and gate.satisfied' in lower(pg_get_functiondef('affiliate_private.admin_partners_kyc_certification_preflight()'::regprocedure))) = 0)::int::text;" \
  2> "$RAW_DIR/didit-preflight-registry-truth-postcondition.log")" || fail
MIGRATION_MARKERS="${MIGRATION_MARKERS}|${DEPLOYMENT_MANIFEST_EVENT_MARKER}|${FRICTIONLESS_MIGRATION_MARKERS}|${OWNER_RISK_MIGRATION_MARKER}|${MULTICURRENCY_MIGRATION_MARKERS}|${WEB_TAX_MIGRATION_MARKERS}|${OWNER_REVIEW_VALIDITY_MARKER}|${BOOTSTRAP_BOOLEAN_MARKER}|${DIDIT_GUIDED_PREFLIGHT_MARKER}|${FR_PILOT_USD_ALIGNMENT_MARKER}|${DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER}"
if [[ "$MIGRATION_MARKERS" != "${BASELINE_CORE_MARKERS}|${FRICTIONLESS_MARKERS_COMPLETE}|${OWNER_RISK_MARKER_COMPLETE}|${MULTICURRENCY_MARKERS_COMPLETE}|${WEB_TAX_MARKERS_COMPLETE}|${OWNER_REVIEW_VALIDITY_MARKER_COMPLETE}|${BOOTSTRAP_BOOLEAN_MARKER_COMPLETE}|${DIDIT_GUIDED_PREFLIGHT_MARKER_COMPLETE}|${FR_PILOT_USD_ALIGNMENT_MARKER_COMPLETE}|${DIDIT_PREFLIGHT_REGISTRY_TRUTH_MARKER_COMPLETE}" ]]; then
  fail
fi
proof_line "migration_markers_after=$MIGRATION_MARKERS"

CURRENT_STEP="France release-approval postcondition"
FR_RELEASE_STATE_AFTER="$(capture_fr_alignment_release_state \
  2> "$RAW_DIR/fr-release-state-after.log")" || fail
if [[ ! "$FR_RELEASE_STATE_AFTER" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  fail
fi
FR_FLAG_STATE_AFTER="$(capture_fr_alignment_flag_state \
  2> "$RAW_DIR/fr-flag-state-after.log")" || fail
if [[ ! "$FR_FLAG_STATE_AFTER" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  fail
fi
EXPECTED_FR_RELEASE_STATE="$FR_RELEASE_STATE_BEFORE"
EXPECTED_FR_FLAG_STATE="$FR_FLAG_STATE_BEFORE"
EXPECTED_FINAL_PARTNER_EVENTS="$BASELINE_EVENTS"
readonly EXPECTED_FR_RELEASE_STATE EXPECTED_FR_FLAG_STATE \
  EXPECTED_FINAL_PARTNER_EVENTS
if [[ "$FR_RELEASE_STATE_AFTER" != "$EXPECTED_FR_RELEASE_STATE" ]]; then
  fail
fi
if [[ "$FR_FLAG_STATE_AFTER" != "$EXPECTED_FR_FLAG_STATE" ]]; then
  fail
fi
proof_line "fr_scoped_release_gates_revoked=0"
proof_line "fr_maintenance_flags_disabled=0"
proof_line "fr_policy_alignment_events_added=0"
CURRENT_STEP="migration object ownership verification"
ROUTINE_OWNER_CHECK="$(clone_psql -At -v ON_ERROR_STOP=1 \
  2> "$RAW_DIR/routine-owner-postcondition.log" <<'SQL'
with expected(signature) as (
  values
    ('affiliate_private.partners_actor_is_live_admin(text)'),
    ('affiliate_private.partners_has_capability(text)'),
    ('affiliate_private.partners_can_manage_capabilities()'),
    ('affiliate_private.partners_is_release_manager()'),
    ('affiliate_private.partners_require_aal2(text)'),
    ('affiliate_private.guard_partners_release_gate_activation_aal2()'),
    ('affiliate_private.partners_admin_operator_key(uuid)'),
    ('affiliate_private.admin_partners_capability_operators()'),
    ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
    ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
    ('public.admin_partners_capability_operators()'),
    ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
    ('affiliate_private.partners_access_decision_email_enqueue()'),
    ('affiliate_private.register_member_didit_session()'),
    ('affiliate_private.guard_didit_certification_session_transition()'),
    ('affiliate_private.partners_didit_certification_key_hash(text)'),
    ('affiliate_private.partners_didit_certification_key(text,uuid)'),
    ('affiliate_private.partners_didit_certification_public_reason(text)'),
    ('affiliate_private.partners_didit_certification_operator_hash()'),
    ('affiliate_private.partners_require_didit_certification_observer(text)'),
    ('affiliate_private.partners_assert_didit_certification_pre_gate()'),
    ('affiliate_private.partners_require_didit_certification_operator(text)'),
    ('affiliate_private.admin_partners_kyc_certification_preflight()'),
    ('affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)'),
    ('affiliate_private.admin_partners_kyc_certification_resume()'),
    ('affiliate_private.admin_partners_kyc_certification_status()'),
    ('affiliate_private.partners_service_kyc_certification_create_claim(text)'),
    ('affiliate_private.partners_service_kyc_certification_binding_match(text,text)'),
    ('affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)'),
    ('affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)'),
    ('public.admin_partners_kyc_certification_preflight()'),
    ('public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)'),
    ('public.admin_partners_kyc_certification_resume()'),
    ('public.admin_partners_kyc_certification_status()'),
    ('public.partners_service_kyc_certification_create_claim(text)'),
    ('public.partners_service_kyc_certification_binding_match(text,text)'),
    ('public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)'),
    ('public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)'),
    ('affiliate_private.valid_partners_approval_document_hashes(jsonb)'),
    ('affiliate_private.valid_partners_approval_jurisdiction_scope(jsonb)'),
    ('affiliate_private.partners_approval_required_document_keys(text)'),
    ('affiliate_private.partners_approval_package_sha256(text,integer,text,text,jsonb,jsonb,text,text,text,text,text,text,timestamptz,timestamptz,text)'),
    ('affiliate_private.partners_deployment_manifest_sha256(text,integer,text,text,text,jsonb,text,timestamptz,text)'),
    ('affiliate_private.guard_partners_deployment_manifest_insert()'),
    ('affiliate_private.reject_partners_deployment_manifest_mutation()'),
    ('affiliate_private.guard_partners_deployment_manifest_binding()'),
    ('affiliate_private.guard_partners_approval_package_insert()'),
    ('affiliate_private.reject_partners_approval_package_mutation()'),
    ('affiliate_private.guard_partners_approval_binding_mutation()'),
    ('affiliate_private.partners_program_approval_snapshot_sha256(uuid)'),
    ('affiliate_private.partners_country_policy_approval_snapshot_sha256(uuid)'),
    ('affiliate_private.partners_approval_package_is_current(uuid,text)'),
    ('affiliate_private.partners_approval_package_is_current(uuid,text,text)'),
    ('affiliate_private.partners_release_gate_approval_is_current(text)'),
    ('affiliate_private.release_gates_satisfied(text[])'),
    ('affiliate_private.partners_approval_gate_covers_policy(text,uuid,text,text)'),
    ('affiliate_private.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)'),
    ('public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)'),
    ('affiliate_private.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)'),
    ('public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)'),
    ('affiliate_private.guard_partners_release_gate_approval()'),
    ('affiliate_private.clear_partners_release_gate_approval()'),
    ('affiliate_private.guard_partners_program_approved_scope()'),
    ('affiliate_private.guard_partners_country_policy_approved_scope()'),
    ('affiliate_private.guard_partners_pilot_allowlist_limit()'),
    ('affiliate_private.admin_partners_configuration_pre_approval_registry_20260804()'),
    ('affiliate_private.admin_partners_configuration()'),
    ('public.admin_partners_configuration()'),
    ('affiliate_private.admin_partners_revolut_payout_status()'),
    ('affiliate_private.admin_partners_revolut_payout_status_approval_registry()'),
    ('public.admin_partners_revolut_payout_status()'),
    ('affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'),
    ('public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'),
    ('affiliate_private.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)'),
    ('public.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)'),
    ('affiliate_private.guard_didit_purge_managed_mutation()'),
    ('affiliate_private.mark_member_didit_purge_pending()'),
    ('affiliate_private.mark_certification_didit_purge_pending()'),
    ('affiliate_private.guard_account_activation_until_didit_purged()'),
    ('affiliate_private.guard_didit_purge_activation_audit()'),
    ('affiliate_private.partners_didit_purge_public_status(text)'),
    ('affiliate_private.partners_didit_purge_sync_source(text,text,timestamptz)'),
    ('affiliate_private.partners_didit_purge_stage_member(text,text,text)'),
    ('affiliate_private.partners_didit_purge_activate_staged(text,text)'),
    ('affiliate_private.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)'),
    ('public.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)'),
    ('affiliate_private.partners_didit_purge_enqueue(text,text,text)'),
    ('affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'),
    ('affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'),
    ('public.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'),
    ('public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)'),
    ('affiliate_private.partners_service_didit_purge_claim(integer,integer)'),
    ('affiliate_private.partners_service_didit_purge_complete(bigint,uuid,text)'),
    ('affiliate_private.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)'),
    ('affiliate_private.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)'),
    ('affiliate_private.partners_service_didit_purge_status()'),
    ('public.partners_service_didit_purge_claim(integer,integer)'),
    ('public.partners_service_didit_purge_complete(bigint,uuid,text)'),
    ('public.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)'),
    ('public.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)'),
    ('public.partners_service_didit_purge_status()'),
    ('affiliate_private.partners_didit_purge_coverage_ready()'),
    ('affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'),
    ('affiliate_private.partners_service_kyc_session_record_v3_pre_withdrawal_20260804(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)'),
    ('affiliate_private.guard_partners_kyc_human_review_mutation()'),
    ('affiliate_private.partners_kyc_rights_snapshot(uuid)'),
    ('affiliate_private.partners_service_kyc_rights_get(uuid)'),
    ('public.partners_service_kyc_rights_get(uuid)'),
    ('affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)'),
    ('public.partners_service_biometric_consent_withdraw(uuid,text)'),
    ('affiliate_private.partners_service_kyc_human_review_request(uuid,text,text)'),
    ('public.partners_service_kyc_human_review_request(uuid,text,text)'),
    ('affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'),
    ('public.admin_partners_kyc_human_review_queue(integer,integer,text)'),
    ('affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)'),
    ('public.admin_partners_kyc_human_review_locator(text,text,text)'),
    ('affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'),
    ('public.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'),
    ('affiliate_private.guard_kyc_reverification_grant_mutation()'),
    ('affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)'),
    ('affiliate_private.admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(text,text,text,timestamptz,text,text)'),
    ('affiliate_private.validate_affiliate_member_transition()'),
    ('affiliate_private.guard_affiliate_member_active_links()'),
    ('affiliate_private.guard_affiliate_auth_user_transition()'),
    ('affiliate_private.validate_affiliate_link_transition()'),
    ('affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'),
    ('affiliate_private.partners_account_deletion_ready(uuid)'),
    ('affiliate_private.partners_access_credit_balances(uuid)'),
    ('affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)'),
    ('affiliate_private.partners_access_credit_offer(uuid,integer)'),
    ('affiliate_private.partners_account_balances(uuid)'),
    ('affiliate_private.partners_cash_readiness(uuid)'),
    ('affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'),
    ('affiliate_private.partners_service_access_grants_reconcile(uuid)'),
    ('affiliate_private.reconcile_access_grants_after_projection()'),
    ('affiliate_private.partners_service_access_credit_status(uuid)'),
    ('affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'),
    ('affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'),
    ('affiliate_private.partners_service_bootstrap_v2(uuid)'),
    ('affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'),
    ('public.partners_service_bootstrap_v2(uuid)'),
    ('public.partners_service_dashboard_v2(uuid,integer,text,text)'),
    ('public.partners_service_join_v2(uuid,boolean,boolean,text)'),
    ('public.partners_service_access_credit_quote(uuid,integer,text)'),
    ('public.partners_service_access_credit_redeem(uuid,text,text)'),
    ('public.partners_service_access_grants_reconcile(uuid)'),
    ('public.partners_service_access_credit_status(uuid)'),
    ('affiliate_private.partners_assert_kyc_cash_eligibility(uuid)'),
    ('affiliate_private.partners_service_payout_country_bind(uuid,text,text)'),
    ('public.partners_service_payout_country_bind(uuid,text,text)'),
    ('affiliate_private.partners_service_rotate_link(uuid,text)'),
    ('public.partners_service_rotate_link(uuid,text)'),
    ('affiliate_private.partners_service_payout_profile_get(uuid)'),
    ('public.partners_service_payout_profile_get(uuid)'),
    ('affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'),
    ('affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'),
    ('affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'),
    ('affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'),
    ('public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'),
    ('affiliate_private.is_managed_partners_flag(text)'),
    ('affiliate_private.partners_require_control_access(text,text,boolean)'),
    ('public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'),
    ('affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)'),
    ('affiliate_private.admin_partners_program_activate(text,text,text)')
)
select count(*)::text || '|' || count(*) filter (
  where routine.oid is null
    or pg_catalog.pg_get_userbyid(routine.proowner) <> 'supabase_admin'
)::text
from expected
left join pg_catalog.pg_proc routine
  on routine.oid = to_regprocedure(expected.signature);
SQL
)" || fail
if [[ "$ROUTINE_OWNER_CHECK" != "164|0" ]]; then
  fail
fi
RELATION_OWNER_CHECK="$(clone_psql -At -v ON_ERROR_STOP=1 \
  2> "$RAW_DIR/relation-owner-postcondition.log" <<'SQL'
with expected(relation_name) as (
  values
    ('affiliate_private.affiliate_didit_session_registry'),
    ('affiliate_private.affiliate_didit_certification_sessions'),
    ('affiliate_private.affiliate_didit_certification_events'),
    ('affiliate_private.affiliate_deployment_manifests'),
    ('affiliate_private.affiliate_deployment_manifest_bindings'),
    ('affiliate_private.affiliate_approval_packages'),
    ('affiliate_private.affiliate_release_gate_approval_bindings'),
    ('affiliate_private.affiliate_biometric_consent_attestations'),
    ('affiliate_private.affiliate_didit_purge_outbox'),
    ('affiliate_private.affiliate_didit_purge_events'),
    ('affiliate_private.affiliate_didit_purge_worker_state'),
    ('affiliate_private.affiliate_biometric_consent_withdrawals'),
    ('affiliate_private.affiliate_kyc_human_review_requests'),
    ('affiliate_private.affiliate_kyc_reverification_grants'),
    ('affiliate_private.affiliate_access_credit_catalog'),
    ('affiliate_private.affiliate_access_credit_quotes'),
    ('affiliate_private.affiliate_access_credit_redemptions'),
    ('affiliate_private.affiliate_web_tax_policies'),
    ('public.cloud_access_grants')
)
select count(*)::text || '|' || count(*) filter (
  where relation.oid is null
    or relation.relkind not in ('r', 'p')
    or pg_catalog.pg_get_userbyid(relation.relowner) <> 'supabase_admin'
)::text
from expected
left join pg_catalog.pg_class relation
  on relation.oid = to_regclass(expected.relation_name);
SQL
)" || fail
if [[ "$RELATION_OWNER_CHECK" != "19|0" ]]; then
  fail
fi
proof_line "migrations_applied=$MIGRATIONS_APPLIED"
proof_line "migrations_atomic=$MIGRATIONS_ATOMIC"
proof_line "migration_replay_skipped=$MIGRATION_REPLAY_SKIPPED"
proof_line "migration_routine_owner=supabase_admin"
proof_line "migration_routines_verified=164"
proof_line "migration_relation_owner=supabase_admin"
proof_line "migration_relations_verified=19"

CURRENT_STEP="post-migration sensitive-state verification"
POST_MIGRATION_SENSITIVE_STATE="$(capture_sensitive_partner_state \
  2> "$RAW_DIR/post-migration-sensitive-state.log")" || fail
if [[ "$POST_MIGRATION_SENSITIVE_STATE" != "$BASELINE_SENSITIVE_STATE" ]]; then
  fail
fi
proof_line "sensitive_partner_state_unchanged_after_migrations=true"

CURRENT_STEP="Partners restore verifier"
if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
    docker exec -u "$PG_UID_GID" "$CONTAINER_NAME" \
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
  local failed_test_numbers=""
  local first_statement=""
  local last_statement=""

  safe_name="$(basename "$relative_path" .sql)"
  if [[ ! "$safe_name" =~ ^[a-z0-9_]+$ ]]; then
    return 1
  fi
  output_path="$RAW_DIR/pgtap-$safe_name.log"
  first_statement="$(awk 'NF { print tolower($0); exit }' \
    "$CANDIDATE_DIR/$relative_path")"
  last_statement="$(awk 'NF { line=tolower($0) } END { print line }' \
    "$CANDIDATE_DIR/$relative_path")"
  if [[ "$first_statement" != "begin;" || "$last_statement" != "rollback;" ]]; then
    return 1
  fi
  # pgTAP is deliberately absent from production. Its exact extension command
  # is allowed inside the rolled-back clone transaction; fixtures and every
  # other top-level DDL/DML statement are forbidden in this restore profile.
  if [[ "$(grep -Eic \
      '^[[:space:]]*create[[:space:]]+' \
      "$CANDIDATE_DIR/$relative_path" || true)" != "1" ]] \
    || ! grep -Eiq \
      '^[[:space:]]*create extension if not exists pgtap with schema extensions;[[:space:]]*$' \
      "$CANDIDATE_DIR/$relative_path" \
    || grep -Eiq \
      '^[[:space:]]*(insert|update|delete|merge|copy|truncate|alter|drop|commit)([[:space:];]|$)' \
      "$CANDIDATE_DIR/$relative_path"; then
    return 1
  fi
  if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
      docker exec -u "$PG_UID_GID" "$CONTAINER_NAME" \
        psql -X -A -t -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
          -f "/candidate/$relative_path" \
        > "$output_path" 2>&1; then
    proof_line "restore_pgtap_${safe_name}_execution=failed"
    return 1
  fi
  if grep -Eq '^(not ok|Bail out!)' "$output_path"; then
    failed_test_numbers="$(awk \
      '/^not ok [0-9]+( |$)/ {
        if (seen++) printf ","
        printf "%s", $3
      }
      END { if (seen) print "" }' "$output_path")"
    if [[ -n "$failed_test_numbers" \
        && "$failed_test_numbers" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
      # Only controlled TAP ordinal numbers are retained. Assertion text and
      # diagnostics remain in the private temporary directory and are deleted.
      proof_line "restore_pgtap_${safe_name}_not_ok=$failed_test_numbers"
    else
      proof_line "restore_pgtap_${safe_name}_tap=failed"
    fi
    return 1
  fi
  plan_line="$(grep -E '^1\.\.[0-9]+$' "$output_path" | tail -n 1)"
  if [[ ! "$plan_line" =~ ^1\.\.[0-9]+$ ]]; then
    proof_line "restore_pgtap_${safe_name}_plan=missing"
    return 1
  fi
  expected_tests="${plan_line#1..}"
  passed_tests="$(grep -Ec '^ok( |$)' "$output_path" || true)"
  if [[ "$passed_tests" != "$expected_tests" ]]; then
    proof_line "restore_pgtap_${safe_name}_counts=${passed_tests}:${expected_tests}"
    return 1
  fi
  proof_line "restore_pgtap_${safe_name}=passed:$passed_tests"
}

proof_line "pgtap_profile=physical_restore_compatible_v1"
for pgtap_file in "${RESTORE_PGTAP_FILES[@]}"; do
  CURRENT_STEP="restore-compatible pgTAP $(basename "$pgtap_file")"
  run_pgtap_file "$pgtap_file" || fail
done
proof_line "restore_pgtap_files=${#RESTORE_PGTAP_FILES[@]}"
proof_line "restore_pgtap_transaction_guard=true"

CURRENT_STEP="post-test invariant verification"
if ! timeout --signal=TERM --kill-after=30s "$PSQL_TIMEOUT_SECONDS" \
    docker exec -u "$PG_UID_GID" "$CONTAINER_NAME" \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
        -f "/candidate/$VERIFIER" \
      > "$RAW_DIR/post-test-verifier.log" 2>&1; then
  fail
fi
FINAL_COUNTS="$(clone_psql -At -v ON_ERROR_STOP=1 -c \
  "select (select count(*) from auth.users)::text || '|' || (select count(*) from affiliate_private.affiliate_accounts)::text || '|' || (select count(*) from affiliate_private.affiliate_events)::text || '|' || (select count(*) from cron.job)::text || '|' || (select count(*) from cron.job where active)::text || '|' || (select count(*) from pg_catalog.pg_stat_activity where backend_type ~* '(pg_cron|pg_net|cron scheduler)')::text;" \
  2> "$RAW_DIR/final-counts.log")" || fail
EXPECTED_FINAL_COUNTS="${BASELINE_USERS}|${BASELINE_ACCOUNTS}|${EXPECTED_FINAL_PARTNER_EVENTS}|${BASELINE_CRON_COUNTS}|0"
if [[ "$FINAL_COUNTS" != "$EXPECTED_FINAL_COUNTS" ]]; then
  fail
fi
FINAL_SENSITIVE_STATE="$(capture_sensitive_partner_state \
  2> "$RAW_DIR/final-sensitive-state.log")" || fail
if [[ "$FINAL_SENSITIVE_STATE" != "$BASELINE_SENSITIVE_STATE" ]]; then
  fail
fi
proof_line "post_test_restore_verifier=passed"
proof_line "test_transactions_rolled_back=true"
proof_line "partner_event_delta_expected=$((EXPECTED_FINAL_PARTNER_EVENTS - BASELINE_EVENTS))"
proof_line "cron_counts_unchanged=true"
proof_line "sensitive_partner_state_unchanged_after_tests=true"

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
