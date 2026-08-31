#!/usr/bin/env bash
# Garbage-collect disposable production-clone rehearsals without ever touching
# the production database, source worktrees, or retained proof reports.
set -Eeuo pipefail

MODE=dry-run
RUN_ID_FILTER=""
FORCE_COMPLETE=0

usage() {
  cat <<'EOF'
Usage: proof-gc.sh [--dry-run|--apply] [--run-id RUN_ID] [--force-complete]

The default is --dry-run. --force-complete is accepted only with --run-id and
only for a rehearsal whose timeline contains REHEARSAL_COMPLETE.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply) MODE=apply; shift ;;
    --run-id) RUN_ID_FILTER="${2:-}"; shift 2 ;;
    --force-complete) FORCE_COMPLETE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done

case "$RUN_ID_FILTER" in
  ''|*[!a-z0-9-]*)
    if [ -n "$RUN_ID_FILTER" ]; then
      echo "PROOF_GC_REFUSED: invalid run id" >&2
      exit 64
    fi
    ;;
esac
if [ "$FORCE_COMPLETE" -eq 1 ] && [ -z "$RUN_ID_FILTER" ]; then
  echo "PROOF_GC_REFUSED: --force-complete requires --run-id" >&2
  exit 64
fi

PROOF_ROOT="${PROOF_GC_ROOT:-/var/lib/norva-phase3-proof}"
PROOF_HOME="${PROOF_GC_HOME:-/home/adrien/norva-phase3-proof}"
FAILED_TTL_HOURS="${PROOF_GC_FAILED_TTL_HOURS:-72}"
SUCCESS_TTL_HOURS="${PROOF_GC_SUCCESS_TTL_HOURS:-0}"
LOCK_FILE="${PROOF_GC_LOCK_FILE:-/run/lock/norva-proof-gc.lock}"
CLEANUP_IMAGE="${PROOF_GC_IMAGE:-supabase/postgres:17.6.1.136}"

case "$FAILED_TTL_HOURS:$SUCCESS_TTL_HOURS" in
  *[!0-9:]*|:*|*:) echo "PROOF_GC_REFUSED: TTL values must be integers" >&2; exit 64 ;;
esac
[ "$PROOF_ROOT" = /var/lib/norva-phase3-proof ] \
  || { echo "PROOF_GC_REFUSED: unexpected proof root" >&2; exit 65; }
[ "$PROOF_HOME" = /home/adrien/norva-phase3-proof ] \
  || { echo "PROOF_GC_REFUSED: unexpected proof home" >&2; exit 65; }
[ "$(readlink -f -- "$PROOF_ROOT")" = "$PROOF_ROOT" ] \
  || { echo "PROOF_GC_REFUSED: proof root is not canonical" >&2; exit 65; }
[ "$(readlink -f -- "$PROOF_HOME")" = "$PROOF_HOME" ] \
  || { echo "PROOF_GC_REFUSED: proof home is not canonical" >&2; exit 65; }
docker image inspect "$CLEANUP_IMAGE" >/dev/null 2>&1 \
  || { echo "PROOF_GC_REFUSED: cleanup image is unavailable" >&2; exit 69; }

[ ! -L "$LOCK_FILE" ] || { echo "PROOF_GC_REFUSED: lock file is a symlink" >&2; exit 65; }
(umask 000; : >>"$LOCK_FILE")
chmod 0666 "$LOCK_FILE" 2>/dev/null || true
exec 9>>"$LOCK_FILE"
flock -n 9 || { echo "PROOF_GC_SKIPPED: another run owns $LOCK_FILE"; exit 0; }

now_epoch="$(date -u +%s)"
removed=0
skipped=0

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

expected_paths() {
  local run_id="$1"
  EXPECTED_CONTAINER="norva-phase123-prod-clone-${run_id}-db"
  EXPECTED_DATA_ROOT="$PROOF_ROOT/prod-clone-${run_id}"
  EXPECTED_REPORT_DIR="$PROOF_HOME/artifacts/prod-clone-${run_id}"
  EXPECTED_DUMP_FILE="$PROOF_HOME/private-dumps/production-phase123-${run_id}.dump"
}

validate_run_id() {
  case "$1" in ''|*[!a-z0-9-]*) return 1 ;; esac
}

report_is_complete() {
  local report_dir="$1"
  test -f "$report_dir/artifact-sha256.txt" \
    && test -f "$report_dir/timeline.log" \
    && grep -q '^REHEARSAL_COMPLETE ' "$report_dir/timeline.log"
}

remove_data_root() {
  local run_id="$1" expected="$PROOF_ROOT/prod-clone-${run_id}"
  [ -d "$expected" ] || return 0
  [ ! -L "$expected" ] \
    || { echo "PROOF_GC_REFUSED: data root is a symlink: $expected" >&2; return 1; }
  [ "$(readlink -f -- "$expected")" = "$expected" ] \
    || { echo "PROOF_GC_REFUSED: non-canonical data root: $expected" >&2; return 1; }
  if [ "$MODE" = dry-run ]; then
    log "DRY_RUN remove data $expected ($(du -sh "$expected" 2>/dev/null | awk '{print $1}'))"
    return 0
  fi
  docker run --rm --entrypoint /bin/sh \
    -v "$PROOF_ROOT:/proof-root:rw" \
    "$CLEANUP_IMAGE" -eu -c '
      relative="$1"
      case "$relative" in prod-clone-[a-z0-9-]*) ;; *) exit 70 ;; esac
      target="/proof-root/$relative"
      resolved="$(readlink -f -- "$target")"
      case "$resolved" in /proof-root/prod-clone-[a-z0-9-]*) ;; *) exit 71 ;; esac
      [ "$resolved" != /proof-root ] || exit 72
      rm -rf -- "$resolved"
      [ ! -e "$resolved" ]
    ' proof-gc "prod-clone-${run_id}"
}

remove_dump() {
  local dump_file="$1"
  case "$dump_file" in
    "$PROOF_HOME"/private-dumps/production-phase123-[a-z0-9-]*.dump) ;;
    *) echo "PROOF_GC_REFUSED: unsafe dump path: $dump_file" >&2; return 1 ;;
  esac
  [ -f "$dump_file" ] || return 0
  if [ "$MODE" = dry-run ]; then
    log "DRY_RUN remove dump $dump_file ($(du -h "$dump_file" | awk '{print $1}'))"
  else
    rm -f -- "$dump_file"
    [ ! -e "$dump_file" ]
  fi
}

container_client_sessions() {
  local container="$1"
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
    printf '0\n'
    return 0
  fi
  docker exec "$container" psql -X -At -U postgres -d postgres -c \
    "select count(*) from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid();" \
    2>/dev/null
}

cleanup_container() {
  local container="$1" run_id data_root report_dir dump_file created_epoch
  local complete=0 ttl_hours age_seconds sessions ports restart_policy label

  label="$(docker inspect -f '{{index .Config.Labels "norva.phase123.production-clone"}}' "$container")"
  [ "$label" = true ] || { log "SKIP $container: missing disposable-clone label"; skipped=$((skipped+1)); return; }
  run_id="$(docker inspect -f '{{index .Config.Labels "norva.phase123.run"}}' "$container")"
  validate_run_id "$run_id" || { log "SKIP $container: invalid run label"; skipped=$((skipped+1)); return; }
  [ -z "$RUN_ID_FILTER" ] || [ "$run_id" = "$RUN_ID_FILTER" ] || return 0
  expected_paths "$run_id"
  [ "$container" = "$EXPECTED_CONTAINER" ] \
    || { log "SKIP $container: name does not match run label"; skipped=$((skipped+1)); return; }

  data_root="$(docker inspect -f '{{index .Config.Labels "norva.phase123.data-root"}}' "$container")"
  report_dir="$(docker inspect -f '{{index .Config.Labels "norva.phase123.report-dir"}}' "$container")"
  dump_file="$(docker inspect -f '{{index .Config.Labels "norva.phase123.dump-file"}}' "$container")"
  [ "$data_root" = "$EXPECTED_DATA_ROOT" ] \
    || { log "SKIP $container: unexpected data-root label"; skipped=$((skipped+1)); return; }
  [ "$report_dir" = "$EXPECTED_REPORT_DIR" ] \
    || { log "SKIP $container: unexpected report-dir label"; skipped=$((skipped+1)); return; }
  [ "$dump_file" = "$EXPECTED_DUMP_FILE" ] \
    || { log "SKIP $container: unexpected dump-file label"; skipped=$((skipped+1)); return; }

  ports="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$container")"
  restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container")"
  [ "$ports" = '{}' ] || [ "$ports" = null ] \
    || { log "SKIP $container: host ports are published"; skipped=$((skipped+1)); return; }
  [ "$restart_policy" = no ] \
    || { log "SKIP $container: restart policy is $restart_policy"; skipped=$((skipped+1)); return; }
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$container" \
    | grep -Fxq "$EXPECTED_DATA_ROOT/db" \
    || { log "SKIP $container: database mount identity mismatch"; skipped=$((skipped+1)); return; }

  if report_is_complete "$report_dir"; then complete=1; fi
  if [ "$FORCE_COMPLETE" -eq 1 ]; then
    [ "$complete" -eq 1 ] \
      || { log "SKIP $container: forced cleanup requires completed artifacts"; skipped=$((skipped+1)); return; }
    ttl_hours=0
  elif [ "$complete" -eq 1 ]; then
    ttl_hours="$(docker inspect -f '{{index .Config.Labels "norva.phase123.success-ttl-hours"}}' "$container")"
    case "$ttl_hours" in ''|*[!0-9]*) ttl_hours="$SUCCESS_TTL_HOURS" ;; esac
  else
    ttl_hours="$(docker inspect -f '{{index .Config.Labels "norva.phase123.failed-ttl-hours"}}' "$container")"
    case "$ttl_hours" in ''|*[!0-9]*) ttl_hours="$FAILED_TTL_HOURS" ;; esac
  fi

  created_epoch="$(docker inspect -f '{{index .Config.Labels "norva.phase123.created-at-epoch"}}' "$container")"
  case "$created_epoch" in
    ''|*[!0-9]*) created_epoch="$(date -d "$(docker inspect -f '{{.Created}}' "$container")" +%s)" ;;
  esac
  age_seconds=$((now_epoch-created_epoch))
  if [ "$age_seconds" -lt $((ttl_hours*3600)) ]; then
    log "KEEP $container: age=$((age_seconds/3600))h ttl=${ttl_hours}h complete=$complete"
    return 0
  fi

  sessions="$(container_client_sessions "$container" || printf 'unknown')"
  [ "$sessions" = 0 ] \
    || { log "SKIP $container: client sessions=$sessions"; skipped=$((skipped+1)); return; }

  if [ "$MODE" = dry-run ]; then
    log "DRY_RUN remove container $container (age=$((age_seconds/3600))h complete=$complete)"
  else
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ]; then
      docker stop --timeout 30 "$container" >/dev/null
    fi
    docker rm "$container" >/dev/null
  fi
  remove_data_root "$run_id"
  remove_dump "$dump_file"
  if [ "$MODE" = apply ]; then
    printf 'gc_at=%s\nrun_id=%s\ncomplete=%s\n' \
      "$(date -u +%FT%TZ)" "$run_id" "$complete" >"$report_dir/gc.txt"
  fi
  removed=$((removed+1))
}

while IFS= read -r container; do
  [ -n "$container" ] || continue
  cleanup_container "$container"
done < <(docker ps -a --filter label=norva.phase123.production-clone=true --format '{{.Names}}')

# A crash can leave a validated dump or data root after its container was
# removed manually. Clean only exact paths backed by the rehearsal manifest.
while IFS= read -r data_root; do
  [ -d "$data_root" ] || continue
  run_id="${data_root##*/prod-clone-}"
  validate_run_id "$run_id" || continue
  [ -z "$RUN_ID_FILTER" ] || [ "$run_id" = "$RUN_ID_FILTER" ] || continue
  expected_paths "$run_id"
  [ -z "$(docker ps -aq --filter "name=^/${EXPECTED_CONTAINER}$")" ] || continue
  manifest="$EXPECTED_REPORT_DIR/manifest.txt"
  [ -f "$manifest" ] || { log "SKIP orphan $run_id: no manifest"; skipped=$((skipped+1)); continue; }
  grep -Fxq "target_container=$EXPECTED_CONTAINER" "$manifest" \
    || { log "SKIP orphan $run_id: manifest container mismatch"; skipped=$((skipped+1)); continue; }
  grep -Fxq "target_data_root=$EXPECTED_DATA_ROOT" "$manifest" \
    || { log "SKIP orphan $run_id: manifest path mismatch"; skipped=$((skipped+1)); continue; }
  age_seconds=$((now_epoch-$(stat -c %Y "$data_root")))
  complete=0; ttl_hours="$FAILED_TTL_HOURS"
  if report_is_complete "$EXPECTED_REPORT_DIR"; then complete=1; ttl_hours="$SUCCESS_TTL_HOURS"; fi
  [ "$FORCE_COMPLETE" -eq 0 ] || { [ "$complete" -eq 1 ] && ttl_hours=0; }
  [ "$age_seconds" -ge $((ttl_hours*3600)) ] || continue
  log "${MODE^^} orphan run=$run_id age=$((age_seconds/3600))h complete=$complete"
  remove_data_root "$run_id"
  remove_dump "$EXPECTED_DUMP_FILE"
  removed=$((removed+1))
done < <(find "$PROOF_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'prod-clone-*' -print 2>/dev/null)

# Dumps can survive a failure before Docker creates the clone. Their manifest
# and exact naming contract are both required before expiry-based removal.
while IFS= read -r dump_file; do
  [ -f "$dump_file" ] || continue
  run_id="${dump_file##*/production-phase123-}"; run_id="${run_id%.dump}"
  validate_run_id "$run_id" || continue
  [ -z "$RUN_ID_FILTER" ] || [ "$run_id" = "$RUN_ID_FILTER" ] || continue
  expected_paths "$run_id"
  [ -z "$(docker ps -aq --filter "name=^/${EXPECTED_CONTAINER}$")" ] || continue
  [ ! -e "$EXPECTED_DATA_ROOT" ] || continue
  manifest="$EXPECTED_REPORT_DIR/manifest.txt"
  [ -f "$manifest" ] || { log "SKIP orphan dump $run_id: no manifest"; skipped=$((skipped+1)); continue; }
  grep -Fxq "target_container=$EXPECTED_CONTAINER" "$manifest" || continue
  grep -Fxq "target_data_root=$EXPECTED_DATA_ROOT" "$manifest" || continue
  age_seconds=$((now_epoch-$(stat -c %Y "$dump_file")))
  complete=0; ttl_hours="$FAILED_TTL_HOURS"
  if report_is_complete "$EXPECTED_REPORT_DIR"; then complete=1; ttl_hours="$SUCCESS_TTL_HOURS"; fi
  [ "$FORCE_COMPLETE" -eq 0 ] || { [ "$complete" -eq 1 ] && ttl_hours=0; }
  [ "$age_seconds" -ge $((ttl_hours*3600)) ] || continue
  remove_dump "$dump_file"
  removed=$((removed+1))
done < <(find "$PROOF_HOME/private-dumps" -maxdepth 1 -type f -name 'production-phase123-*.dump' -print 2>/dev/null)

log "PROOF_GC_OK mode=$MODE removed=$removed skipped=$skipped"
