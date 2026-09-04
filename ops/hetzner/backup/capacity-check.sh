#!/usr/bin/env bash
# =============================================================================
# capacity-check.sh — daily WAL-rate and growth watchdog
# =============================================================================
# Audit 2026-08-20 found a 4.6x WAL regression that had been running for forty
# days and was discovered on the Cloudflare invoice, not by an alert. Nothing
# watched the rate. This closes that hole.
#
# Three checks, each with a threshold overridable in /etc/norva-backup.env:
#   1. WAL produced since the previous run, normalised to GiB/day. The retention
#      window bounds R2 storage at (rate x KEEP_WAL_DAYS), so the rate IS the
#      cost. A jump means an upstream regression — checkpoint_timeout, a new
#      high-frequency write path, or a catalogue import.
#   2. Database size and cost per catalogue-bearing user. ~848 MiB/user as of
#      2026-08-21. Drift upward means bloat returning or a schema regression.
#   3. Free disk against what a base backup needs. basebackup-weekly.sh stages a
#      full physical copy locally before upload, so it needs ~2x the database
#      size free. This is the constraint that caps the box, not R2 cost.
#
# Alerts to Telegram (same bot as the Netdata channel, credentials read from the
# stack .env) and exits non-zero so `systemctl status` shows the unit failed.
# Run by norva-capacity-check.timer. First run only seeds state and stays quiet.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

STATE="${CAPACITY_STATE_FILE:-/var/lib/norva/capacity-check.state}"
WAL_WARN_GIB="${CAPACITY_WAL_WARN_GIB:-15}"
USER_WARN_MIB="${CAPACITY_USER_WARN_MIB:-1200}"
# Marginal cost of one catalogue title across the per-user cloud_* tables.
# 10,109 bytes at 2026-08-27 after the Phase-3 schema and a concurrent reindex
# pass. The former 7,000-byte threshold predated durable owner snapshots, live
# catalogue indexes and projection queues, so it became a permanent false
# positive even on freshly rebuilt indexes. Keep roughly 19% headroom over the
# current compact baseline; this remains a growth signal, not a bloat estimate.
TITLE_WARN_BYTES="${CAPACITY_TITLE_WARN_BYTES:-12000}"
DISK_WARN_PCT="${CAPACITY_DISK_WARN_PCT:-70}"
PROOF_WARN_GIB="${CAPACITY_PROOF_WARN_GIB:-25}"
BUILD_CACHE_WARN_GIB="${CAPACITY_BUILD_CACHE_WARN_GIB:-20}"
IMAGE_RECLAIMABLE_WARN_GIB="${CAPACITY_IMAGE_RECLAIMABLE_WARN_GIB:-15}"
DISK_GROWTH_WARN_GIB_DAY="${CAPACITY_DISK_GROWTH_WARN_GIB_DAY:-15}"
R2_WAL_GROWTH_WARN_GIB_DAY="${CAPACITY_R2_WAL_GROWTH_WARN_GIB_DAY:-15}"
PROOF_ROOT="${PROOF_GC_ROOT:-/var/lib/norva-phase3-proof}"

q() { docker exec "$DB_CONTAINER" psql -U postgres -Atc "$1"; }

metric_to_bytes() {
  local value="$1"
  value="${value/B/}"
  numfmt --from=si "$value"
}

telegram() {
  local token chat env_file="$NORVA_OPS_DIR/.env"
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "WARN: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID absent from $env_file — alert not sent"
    return 0
  fi
  curl -sS -m 20 -o /dev/null \
    --data-urlencode "chat_id=$chat" \
    --data-urlencode "text=$1" \
    "https://api.telegram.org/bot${token}/sendMessage" \
    || log "WARN: Telegram send failed (alert still non-zero for systemd)"
}

NOW_EPOCH="$(date -u +%s)"
NOW_LSN="$(q 'select pg_current_wal_lsn();')"
ELAPSED=0

# ---- 1. WAL rate ------------------------------------------------------------
WAL_LINE="rate: no baseline yet (first run)"
WAL_GIB_DAY=""
# Only re-seed the baseline when we actually measured. A manual run inside the
# hour must not shove the baseline forward and suppress the scheduled check --
# that is exactly when someone is poking at the box during an incident.
SEED=1
if [ -r "$STATE" ]; then
  # shellcheck disable=SC1090
  . "$STATE"
  ELAPSED=$((NOW_EPOCH - ${PREV_EPOCH:-$NOW_EPOCH}))
  if [ "$ELAPSED" -ge 3600 ] && [ -n "${PREV_LSN:-}" ]; then
    BYTES="$(q "select pg_wal_lsn_diff('$NOW_LSN'::pg_lsn, '$PREV_LSN'::pg_lsn);")"
    WAL_GIB_DAY="$(awk -v b="$BYTES" -v s="$ELAPSED" 'BEGIN{printf "%.2f", b/1073741824*86400/s}')"
    WAL_LINE="rate: ${WAL_GIB_DAY} GiB/day (seuil ${WAL_WARN_GIB})"
  else
    WAL_LINE="rate: window too short (${ELAPSED}s) — baseline kept"
    SEED=0
  fi
fi
# ---- 2. size per catalogue-bearing user -------------------------------------
DB_BYTES="$(q "select pg_database_size('postgres');")"
USERS="$(q 'select greatest(count(distinct user_id),1) from public.cloud_titles;')"
CLOUD_BYTES="$(q "select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'cloud%';")"
PER_USER_MIB="$(awk -v b="$CLOUD_BYTES" -v u="$USERS" 'BEGIN{printf "%.0f", b/1048576/u}')"
DB_GIB="$(awk -v b="$DB_BYTES" 'BEGIN{printf "%.2f", b/1073741824}')"
TITLES="$(q 'select greatest(count(*),1) from public.cloud_titles;')"
BYTES_PER_TITLE="$(awk -v b="$CLOUD_BYTES" -v t="$TITLES" 'BEGIN{printf "%.0f", b/t}')"

# ---- 3. disk headroom for the base backup staging ---------------------------
AVAIL_BYTES="$(df --output=avail -B1 / | tail -1 | tr -d ' ')"
USED_BYTES="$(df --output=used -B1 / | tail -1 | tr -d ' ')"
USE_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
NEEDED_BYTES=$((DB_BYTES * 2))
AVAIL_GIB="$(awk -v b="$AVAIL_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
NEEDED_GIB="$(awk -v b="$NEEDED_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
DISK_GROWTH_GIB_DAY=""
if [ "$ELAPSED" -ge 3600 ] && [ -n "${PREV_USED_BYTES:-}" ]; then
  DISK_DELTA_BYTES=$((USED_BYTES - PREV_USED_BYTES))
  DISK_GROWTH_GIB_DAY="$(awk -v b="$DISK_DELTA_BYTES" -v s="$ELAPSED" 'BEGIN{printf "%.2f", b/1073741824*86400/s}')"
fi

# ---- 4. R2 WAL footprint -----------------------------------------------------
# Measure the remote prefix itself: generation rate alone cannot reveal a
# retention failure. --fast-list performs one bounded prefix inventory.
R2_WAL_BYTES=""
R2_WAL_COUNT=""
R2_WAL_GROWTH_GIB_DAY=""
if R2_WAL_JSON="$(rclone size "r2:${R2_BUCKET}/${R2_PREFIX_WAL%/}" --json --fast-list 2>/dev/null)"; then
  R2_WAL_BYTES="$(sed -n 's/.*"bytes"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' <<<"$R2_WAL_JSON")"
  R2_WAL_COUNT="$(sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' <<<"$R2_WAL_JSON")"
  R2_ELAPSED=$((NOW_EPOCH - ${PREV_R2_WAL_EPOCH:-${PREV_EPOCH:-$NOW_EPOCH}}))
  if [ "$R2_ELAPSED" -ge 3600 ] && [ -n "$R2_WAL_BYTES" ] && [ -n "${PREV_R2_WAL_BYTES:-}" ]; then
    R2_WAL_DELTA_BYTES=$((R2_WAL_BYTES - PREV_R2_WAL_BYTES))
    R2_WAL_GROWTH_GIB_DAY="$(awk -v b="$R2_WAL_DELTA_BYTES" -v s="$R2_ELAPSED" 'BEGIN{printf "%.2f", b/1073741824*86400/s}')"
  fi
fi

# Update the combined baseline atomically only after all measurements. Existing
# two-field state files remain compatible and simply seed the new metrics once.
if [ "$SEED" -eq 1 ]; then
  state_tmp="${STATE}.tmp.$$"
  umask 077
  {
    printf 'PREV_LSN=%s\nPREV_EPOCH=%s\n' "$NOW_LSN" "$NOW_EPOCH"
    printf 'PREV_USED_BYTES=%s\n' "$USED_BYTES"
    if [ -n "$R2_WAL_BYTES" ]; then
      printf 'PREV_R2_WAL_BYTES=%s\nPREV_R2_WAL_EPOCH=%s\n' "$R2_WAL_BYTES" "$NOW_EPOCH"
    elif [ -n "${PREV_R2_WAL_BYTES:-}" ]; then
      printf 'PREV_R2_WAL_BYTES=%s\nPREV_R2_WAL_EPOCH=%s\n' \
        "$PREV_R2_WAL_BYTES" "${PREV_R2_WAL_EPOCH:-${PREV_EPOCH:-$NOW_EPOCH}}"
    fi
  } > "$state_tmp"
  mv -f "$state_tmp" "$STATE"
fi

log "WAL $WAL_LINE"
log "db ${DB_GIB} GiB · ${USERS} users avec catalogue · ${PER_USER_MIB} MiB/user"
log "catalogue ${TITLES} titres · ${BYTES_PER_TITLE} o/titre (seuil ${TITLE_WARN_BYTES})"
log "disk ${USE_PCT}% used · ${AVAIL_GIB} GiB free · base backup needs ${NEEDED_GIB} GiB"
if [ -n "$DISK_GROWTH_GIB_DAY" ]; then
  log "disk growth ${DISK_GROWTH_GIB_DAY} GiB/day (seuil ${DISK_GROWTH_WARN_GIB_DAY})"
else
  log "disk growth: no baseline yet"
fi
if [ -n "$R2_WAL_BYTES" ]; then
  R2_WAL_GIB="$(awk -v b="$R2_WAL_BYTES" 'BEGIN{printf "%.2f", b/1073741824}')"
  log "R2 WAL ${R2_WAL_GIB} GiB · ${R2_WAL_COUNT:-?} objets · growth ${R2_WAL_GROWTH_GIB_DAY:-no baseline} GiB/day (seuil ${R2_WAL_GROWTH_WARN_GIB_DAY})"
else
  log "WARN: R2 WAL size unavailable"
fi

# ---- 5. disposable proof and Docker growth ---------------------------------
# These are independent of PostgreSQL growth and were the source of the
# 2026-08-31 disk incident. Alert on the producer, before aggregate disk usage
# becomes critical.
PROOF_BYTES="$(du -sb "$PROOF_ROOT" 2>/dev/null | awk '{print $1}' || printf '0')"
PROOF_GIB="$(awk -v b="$PROOF_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
DOCKER_DF="$(docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}')"
BUILD_CACHE_HUMAN="$(awk -F '|' '$1=="Build Cache"{print $2}' <<<"$DOCKER_DF")"
IMAGE_RECLAIMABLE_HUMAN="$(awk -F '|' '$1=="Images"{split($3,a," "); print a[1]}' <<<"$DOCKER_DF")"
BUILD_CACHE_BYTES="$(metric_to_bytes "${BUILD_CACHE_HUMAN:-0B}")"
IMAGE_RECLAIMABLE_BYTES="$(metric_to_bytes "${IMAGE_RECLAIMABLE_HUMAN:-0B}")"
BUILD_CACHE_GIB="$(awk -v b="$BUILD_CACHE_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
IMAGE_RECLAIMABLE_GIB="$(awk -v b="$IMAGE_RECLAIMABLE_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
log "temp proof ${PROOF_GIB} GiB (seuil ${PROOF_WARN_GIB}) · build cache ${BUILD_CACHE_GIB} GiB (seuil ${BUILD_CACHE_WARN_GIB}) · images recuperables ${IMAGE_RECLAIMABLE_GIB} GiB (seuil ${IMAGE_RECLAIMABLE_WARN_GIB})"


# ---- 6. the other backup units: failed, or silently not running --------------
# Nothing watched these until now. wal-sync.sh has exited non-zero "so systemd
# marks the unit failed (visible in monitoring)" since day one, but nothing was
# actually looking: Netdata's go.d here has no systemdunits collector, and adding
# one means granting the container host D-Bus. This script runs every six hours
# as root and already has a Telegram channel, so it asks systemd directly.
# Format: "unit:max_hours_since_last_run".
UNIT_CHECKS="${CAPACITY_UNIT_CHECKS:-norva-backup-nightly:36 norva-basebackup:36 norva-wal-prune-r2:36 norva-wal-sync:1}"
if systemctl cat norva-proof-gc.service >/dev/null 2>&1; then
  case " $UNIT_CHECKS " in *" norva-proof-gc:"*) ;; *) UNIT_CHECKS="$UNIT_CHECKS norva-proof-gc:8" ;; esac
fi
if systemctl cat norva-docker-gc.service >/dev/null 2>&1; then
  case " $UNIT_CHECKS " in *" norva-docker-gc:"*) ;; *) UNIT_CHECKS="$UNIT_CHECKS norva-docker-gc:36" ;; esac
fi
if systemctl cat norva-deployment-gc.service >/dev/null 2>&1; then
  case " $UNIT_CHECKS " in *" norva-deployment-gc:"*) ;; *) UNIT_CHECKS="$UNIT_CHECKS norva-deployment-gc:36" ;; esac
fi
UNIT_PROBLEMS=""
for spec in $UNIT_CHECKS; do
  u="${spec%%:*}"; max_h="${spec##*:}"
  active_state="$(systemctl show "$u.service" -p ActiveState --value 2>/dev/null || true)"
  started="$(systemctl show "$u.service" -p ExecMainStartTimestamp --value 2>/dev/null || true)"
  result="$(systemctl show "$u.service" -p Result --value 2>/dev/null || true)"
  ts="$(systemctl show "$u.service" -p ExecMainExitTimestamp --value 2>/dev/null || true)"

  # A Type=oneshot service has no exit timestamp while it is still running.
  # Treating that as "never executed" hid the actual incident: a WAL sync can
  # be alive for hours while consuming memory and blocking its timer. Report a
  # long-running unit explicitly, while allowing a normal in-flight run.
  if [ "$active_state" = "activating" ] || [ "$active_state" = "active" ]; then
    started_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
    if [ "$started_epoch" -eq 0 ]; then
      UNIT_PROBLEMS="$UNIT_PROBLEMS $u=en-cours-date-illisible"
      continue
    fi
    running_seconds=$((NOW_EPOCH - started_epoch))
    if [ "$running_seconds" -ge $((max_h * 3600)) ]; then
      running_minutes=$((running_seconds / 60))
      UNIT_PROBLEMS="$UNIT_PROBLEMS $u=en-cours-${running_minutes}min"
    fi
    continue
  fi

  if [ -n "$result" ] && [ "$result" != "success" ]; then
    UNIT_PROBLEMS="$UNIT_PROBLEMS $u=$result"
    continue
  fi
  # A unit that never ran is as bad as one that failed, and looks healthier.
  if [ -z "$ts" ] || [ "$ts" = "n/a" ]; then
    UNIT_PROBLEMS="$UNIT_PROBLEMS $u=jamais-execute"
    continue
  fi
  ts_epoch="$(date -d "$ts" +%s 2>/dev/null || echo 0)"
  if [ "$ts_epoch" -eq 0 ]; then
    UNIT_PROBLEMS="$UNIT_PROBLEMS $u=date-illisible"
    continue
  fi
  age_h=$(( (NOW_EPOCH - ts_epoch) / 3600 ))
  if [ "$age_h" -gt "$max_h" ]; then
    UNIT_PROBLEMS="$UNIT_PROBLEMS $u=${age_h}h-sans-run"
  fi
done
log "unites:${UNIT_PROBLEMS:- toutes OK}"

# ---- verdict ----------------------------------------------------------------
ALERTS=()
if [ -n "$WAL_GIB_DAY" ] && awk -v v="$WAL_GIB_DAY" -v t="$WAL_WARN_GIB" 'BEGIN{exit !(v>t)}'; then
  ALERTS+=("WAL ${WAL_GIB_DAY} GiB/jour depasse le seuil de ${WAL_WARN_GIB}. Verifier checkpoint_timeout, pg_stat_checkpointer et wal_fpi dans pg_stat_statements avant de toucher a KEEP_WAL_DAYS.")
fi
if [ -n "$DISK_GROWTH_GIB_DAY" ] && awk -v v="$DISK_GROWTH_GIB_DAY" -v t="$DISK_GROWTH_WARN_GIB_DAY" 'BEGIN{exit !(v>t)}'; then
  ALERTS+=("Croissance disque ${DISK_GROWTH_GIB_DAY} GiB/jour depasse le seuil de ${DISK_GROWTH_WARN_GIB_DAY}. Examiner BuildKit, images et worktrees avant nettoyage.")
fi
if [ -n "$R2_WAL_GROWTH_GIB_DAY" ] && awk -v v="$R2_WAL_GROWTH_GIB_DAY" -v t="$R2_WAL_GROWTH_WARN_GIB_DAY" 'BEGIN{exit !(v>t)}'; then
  ALERTS+=("Croissance du prefixe WAL R2 ${R2_WAL_GROWTH_GIB_DAY} GiB/jour depasse le seuil de ${R2_WAL_GROWTH_WARN_GIB_DAY}. Verifier le debit WAL et le dernier norva-wal-prune-r2.")
fi
if [ "$BYTES_PER_TITLE" -gt "$TITLE_WARN_BYTES" ]; then
  ALERTS+=("Cout ${BYTES_PER_TITLE} octets par titre (seuil ${TITLE_WARN_BYTES}). Croissance anormale possible — mesurer pgstattuple/pgstatindex avant REINDEX TABLE CONCURRENTLY sur cloud_titles, cloud_media_items et cloud_title_variants.")
fi
if [ -n "$UNIT_PROBLEMS" ]; then
  ALERTS+=("Unites de backup en defaut:$UNIT_PROBLEMS. Diagnostic: systemctl status <unite>.service et journalctl -u <unite>.service -n 50.")
fi
if [ "$AVAIL_BYTES" -lt "$NEEDED_BYTES" ]; then
  ALERTS+=("Disque insuffisant pour le base backup: ${AVAIL_GIB} GiB libres, ${NEEDED_GIB} GiB necessaires (staging = 2x la base). Le prochain norva-basebackup echouera.")
elif [ "$USE_PCT" -gt "$DISK_WARN_PCT" ]; then
  ALERTS+=("Disque a ${USE_PCT}% (seuil ${DISK_WARN_PCT}%). ${AVAIL_GIB} GiB libres.")
fi
if [ "$PROOF_BYTES" -gt $((PROOF_WARN_GIB * 1073741824)) ]; then
  ALERTS+=("Preuves jetables a ${PROOF_GIB} GiB (seuil ${PROOF_WARN_GIB}). Verifier norva-proof-gc avant toute suppression manuelle.")
fi
if [ "$BUILD_CACHE_BYTES" -gt $((BUILD_CACHE_WARN_GIB * 1073741824)) ]; then
  ALERTS+=("Cache BuildKit a ${BUILD_CACHE_GIB} GiB (seuil ${BUILD_CACHE_WARN_GIB}). Verifier norva-docker-gc.")
fi
if [ "$IMAGE_RECLAIMABLE_BYTES" -gt $((IMAGE_RECLAIMABLE_WARN_GIB * 1073741824)) ]; then
  ALERTS+=("Images Docker recuperables: ${IMAGE_RECLAIMABLE_GIB} GiB (seuil ${IMAGE_RECLAIMABLE_WARN_GIB}). Verifier les images actives et de rollback avant purge.")
fi

if [ "${#ALERTS[@]}" -eq 0 ]; then
  log "OK"
  exit 0
fi

MSG="[norva-db] capacity-check"
for a in "${ALERTS[@]}"; do MSG="$MSG"$'\n\n'"- $a"; done
MSG="$MSG"$'\n\n'"db ${DB_GIB} GiB · ${PER_USER_MIB} MiB/user · disque ${USE_PCT}% · ${AVAIL_GIB} GiB libres"
telegram "$MSG"
echo "$MSG" >&2
exit 1
