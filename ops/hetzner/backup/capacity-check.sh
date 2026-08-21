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
# 5719 bytes at 2026-08-21 after the reindex pass; it was 7138 before it, so
# this doubles as the "time to REINDEX" signal. The canonical catalog_* layer
# is fixed overhead and is deliberately excluded — it saturates, titles do not.
TITLE_WARN_BYTES="${CAPACITY_TITLE_WARN_BYTES:-7000}"
DISK_WARN_PCT="${CAPACITY_DISK_WARN_PCT:-70}"

q() { docker exec "$DB_CONTAINER" psql -U postgres -Atc "$1"; }

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
[ "$SEED" -eq 1 ] && printf 'PREV_LSN=%s\nPREV_EPOCH=%s\n' "$NOW_LSN" "$NOW_EPOCH" > "$STATE"

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
USE_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
NEEDED_BYTES=$((DB_BYTES * 2))
AVAIL_GIB="$(awk -v b="$AVAIL_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"
NEEDED_GIB="$(awk -v b="$NEEDED_BYTES" 'BEGIN{printf "%.1f", b/1073741824}')"

log "WAL $WAL_LINE"
log "db ${DB_GIB} GiB · ${USERS} users avec catalogue · ${PER_USER_MIB} MiB/user"
log "catalogue ${TITLES} titres · ${BYTES_PER_TITLE} o/titre (seuil ${TITLE_WARN_BYTES})"
log "disk ${USE_PCT}% used · ${AVAIL_GIB} GiB free · base backup needs ${NEEDED_GIB} GiB"

# ---- verdict ----------------------------------------------------------------
ALERTS=()
if [ -n "$WAL_GIB_DAY" ] && awk -v v="$WAL_GIB_DAY" -v t="$WAL_WARN_GIB" 'BEGIN{exit !(v>t)}'; then
  ALERTS+=("WAL ${WAL_GIB_DAY} GiB/jour depasse le seuil de ${WAL_WARN_GIB}. Verifier checkpoint_timeout, pg_stat_checkpointer et wal_fpi dans pg_stat_statements avant de toucher a KEEP_WAL_DAYS.")
fi
if [ "$BYTES_PER_TITLE" -gt "$TITLE_WARN_BYTES" ]; then
  ALERTS+=("Cout ${BYTES_PER_TITLE} octets par titre (seuil ${TITLE_WARN_BYTES}). Ballonnement d'index probable — REINDEX TABLE CONCURRENTLY sur cloud_titles, cloud_media_items, cloud_title_variants, catalog_titles.")
fi
if [ "$AVAIL_BYTES" -lt "$NEEDED_BYTES" ]; then
  ALERTS+=("Disque insuffisant pour le base backup: ${AVAIL_GIB} GiB libres, ${NEEDED_GIB} GiB necessaires (staging = 2x la base). Le prochain norva-basebackup echouera.")
elif [ "$USE_PCT" -gt "$DISK_WARN_PCT" ]; then
  ALERTS+=("Disque a ${USE_PCT}% (seuil ${DISK_WARN_PCT}%). ${AVAIL_GIB} GiB libres.")
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
