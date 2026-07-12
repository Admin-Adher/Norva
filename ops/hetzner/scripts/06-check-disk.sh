#!/usr/bin/env bash
# =============================================================================
# 06-check-disk.sh — one-shot disk & WAL health for the Norva self-host box.
# =============================================================================
# READ-ONLY. Diagnoses the usual space eaters on this box, in one run:
#   disk %, WAL local vs on R2, live WAL generation RATE, wal_compression,
#   table bloat, Docker images/logs, DB size.
# Run with sudo for full visibility (du on /var/lib/norva, docker logs, R2 env):
#   sudo ops/hetzner/scripts/06-check-disk.sh
# Nothing is deleted. To RECLAIM WAL space safely (copies are on R2), see the
# "Incident disque / WAL" section of docs/roadmap/2026-07-12-session-log.md.
# =============================================================================
set -uo pipefail

DBC="${DB_CONTAINER:-norva-db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql() { docker exec -i "$DBC" psql -U postgres -d postgres -tAc "$1" 2>/dev/null; }
section() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

section "Disque /"
df -h / | awk 'NR==1||/\/$/'

section "WAL local"
du -sh /var/lib/norva/wal-archive 2>/dev/null | awk '{print "archive : "$1}'
echo "segments: $(ls /var/lib/norva/wal-archive 2>/dev/null | wc -l | tr -d ' ')  (× ~16 Mo)"
du -sh /var/lib/norva/db/pg_wal 2>/dev/null | awk '{print "pg_wal interne : "$1"  (reprise sur crash — normal)"}'

section "WAL sur R2"
if [ -r /etc/norva-backup.env ] && [ -r "$SCRIPT_DIR/../backup/lib.sh" ]; then
  n=$(bash -c 'set -a; . /etc/norva-backup.env; . "'"$SCRIPT_DIR"'/../backup/lib.sh"; rclone lsf "r2:${R2_BUCKET}/${R2_PREFIX_WAL%/}/" 2>/dev/null | wc -l' 2>/dev/null | tail -1)
  echo "objets WAL sur R2 : ${n:-?}"
else
  echo "(lance en sudo pour lire /etc/norva-backup.env)"
fi

section "Débit WAL (échantillon 30 s)"
L1=$(psql "select pg_current_wal_lsn();"); A1=$(psql "select archived_count from pg_stat_archiver;")
sleep 30
L2=$(psql "select pg_current_wal_lsn();"); A2=$(psql "select archived_count from pg_stat_archiver;")
if [ -n "${L1:-}" ] && [ -n "${L2:-}" ]; then
  psql "select 'généré: '||pg_size_pretty(pg_wal_lsn_diff('$L2','$L1'))||' en 30s  (~'||pg_size_pretty(pg_wal_lsn_diff('$L2','$L1')*2880)||'/jour)';"
  echo "segments archivés en 30s : $(( ${A2:-0} - ${A1:-0} ))"
fi

section "wal_compression"
psql "show wal_compression;"

section "Bloat — top dead tuples"
psql "select rpad(relname,34)||' dead='||n_dead_tup||'  ('||coalesce(round(100.0*n_dead_tup/nullif(n_live_tup+n_dead_tup,0),1),0)||'%)' from pg_stat_user_tables where n_dead_tup>1000 order by n_dead_tup desc limit 8;"

section "Docker"
docker system df 2>/dev/null
echo "-- plus gros logs conteneurs --"
du -h /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -rh | head -5 || echo "(sudo requis)"

section "Taille DB"
psql "select pg_size_pretty(pg_database_size('postgres'));"
echo
