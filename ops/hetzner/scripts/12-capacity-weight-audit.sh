#!/usr/bin/env bash
# =============================================================================
# 12-capacity-weight-audit.sh — poids de la box + capacité (audit 1000 users)
# =============================================================================
# READ-ONLY. Répond à deux questions en un run :
#   1) QU'EST-CE QUI PÈSE ? — disque, docker, R2 par préfixe, DB par schéma/table,
#      les « gros silencieux » (cron.job_run_details, net._http_response, cache VTT,
#      playback events, audit auth), et QUI GROSSIT (tuples insérés/maj).
#   2) ÇA TIENT 1000 USERS SIMULTANÉS ? — réglages PG, connexions par service,
#      pool PostgREST/GoTrue (le vrai plafond : l'edge passe par PostgREST),
#      cache hit ratio, checkpoints, échantillon de charge 60 s, bande passante.
# Complémentaire du 06 (WAL/débit) — relancer le 06 pour la partie WAL.
#   sudo bash ops/hetzner/scripts/12-capacity-weight-audit.sh
# Rien n'est modifié ni supprimé. Colle la sortie COMPLÈTE.
# =============================================================================
set -uo pipefail

DBC="${DB_CONTAINER:-norva-db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -tAc "$1" 2>/dev/null; }
psqlt() { docker exec -i "$DBC" psql -U postgres -d postgres -P pager=off -c "$1" 2>/dev/null; }
section() { printf '\n\033[1m================ %s ================\033[0m\n' "$1"; }

section "[1] MACHINE"
grep -m1 "model name" /proc/cpuinfo | sed 's/.*: /CPU     : /'
echo "coeurs  : $(nproc)"
free -h | awk 'NR==2{print "RAM     : total "$2"  used "$3"  dispo "$7} NR==3{print "swap    : total "$2"  used "$3}'
uptime | sed 's/^/charge  :/'
[ -r /proc/mdstat ] && grep -A1 "^md" /proc/mdstat | head -4

section "[2] DISQUE"
df -h / | awk 'NR==1||/\/$/'
echo "-- les gros répertoires (peut prendre ~30 s) --"
for d in /var/lib/docker /var/lib/norva /var/lib/norva/db /var/lib/norva/wal-archive /var/lib/norva/backups; do
  [ -d "$d" ] && du -sh "$d" 2>/dev/null
done

section "[3] DOCKER — CPU/RAM par conteneur (instantané)"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>/dev/null
echo "-- restarts (un service qui boucle se voit ici) --"
docker ps --format '{{.Names}}' | while read -r c; do
  rc=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)
  [ "${rc:-0}" != "0" ] && echo "  $c : $rc restarts"
done; echo "  (rien au-dessus = 0 restart partout)"
docker system df 2>/dev/null | head -5

section "[4] R2 — qui pèse dans les 51 GB (par préfixe)"
if [ -r /etc/norva-backup.env ]; then
  bash -c 'set -a; . /etc/norva-backup.env; set +a
    for p in db selfhost/dumps selfhost/base selfhost/wal; do
      printf "%-16s : " "$p"
      rclone size "r2:${R2_BUCKET}/$p" 2>/dev/null | tr "\n" "  " ; echo
    done' 2>/dev/null
else
  echo "(sudo requis pour lire /etc/norva-backup.env)"
fi
echo "-- timers backups (le base est-il devenu quotidien ?) --"
systemctl list-timers 'norva-*' --no-pager 2>/dev/null | head -8
for u in norva-basebackup norva-backup-nightly norva-wal-sync; do
  systemctl cat "${u}.timer" 2>/dev/null | grep -E "OnCalendar|OnUnitActiveSec" | sed "s/^/  ${u}: /"
done

section "[5] DB — taille totale + par schéma"
psql "select 'DB totale : '||pg_size_pretty(pg_database_size('postgres'));"
psqlt "select n.nspname as schema, pg_size_pretty(sum(pg_total_relation_size(c.oid))::bigint) as taille, count(*) as relations
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','m','t') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
group by 1 order by sum(pg_total_relation_size(c.oid)) desc;"

section "[6] DB — top 25 relations (heap / index / toast)"
psqlt "select n.nspname||'.'||c.relname as relation,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total,
  pg_size_pretty(pg_relation_size(c.oid)) as heap,
  pg_size_pretty(pg_indexes_size(c.oid)) as idx,
  pg_size_pretty(coalesce(pg_total_relation_size(c.reltoastrelid),0)) as toast,
  c.reltuples::bigint as est_rows
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema')
order by pg_total_relation_size(c.oid) desc limit 25;"

section "[7] DB — les gros silencieux (suspects explicites)"
psql "select 'cron.job_run_details : '||count(*)||' rows, '||pg_size_pretty(pg_total_relation_size('cron.job_run_details'))||', plus vieux: '||coalesce(min(start_time)::date::text,'-') from cron.job_run_details;" || echo "cron.job_run_details : (absent)"
psql "select 'net._http_response   : '||count(*)||' rows, '||pg_size_pretty(pg_total_relation_size('net._http_response')) from net._http_response;" || echo "net._http_response : (absent)"
psql "select 'net.http_request_queue: '||count(*)||' rows' from net.http_request_queue;" 2>/dev/null || true
psql "select 'auth.audit_log_entries: '||count(*)||' rows, '||pg_size_pretty(pg_total_relation_size('auth.audit_log_entries'))||', plus vieux: '||coalesce(min(created_at)::date::text,'-') from auth.audit_log_entries;" || true
psql "select 'cloud_playback_events : '||count(*)||' rows, '||pg_size_pretty(pg_total_relation_size('public.cloud_playback_events'))||', plus vieux: '||coalesce(min(created_at)::date::text,'-') from public.cloud_playback_events;" || true
echo "-- cache VTT (sous-titres IA) par kind/status --"
psqlt "select kind, status, count(*) as rows, pg_size_pretty(sum(coalesce(length(vtt),0))::bigint) as vtt_bytes
from public.catalog_generated_subtitles group by 1,2 order by sum(coalesce(length(vtt),0)) desc nulls last;" || true
psql "select 'generated_subtitle_requests : '||count(*)||' rows' from public.generated_subtitle_requests;" || true
psql "select 'subtitle_notifications      : '||count(*)||' rows ('||count(*) filter (where status='pending')||' pending)' from public.catalog_generated_subtitle_notifications;" || true

section "[8] DB — qui GROSSIT (écritures cumulées depuis le reset des stats)"
psql "select 'stats depuis : '||coalesce(stats_reset::text,'(jamais reset — depuis init)') from pg_stat_database where datname='postgres';"
psqlt "select schemaname||'.'||relname as table, n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes, n_live_tup as live, n_dead_tup as dead
from pg_stat_all_tables where schemaname not in ('pg_catalog','information_schema')
order by (n_tup_ins+n_tup_upd) desc limit 15;"
echo "-- autovacuum en retard ? --"
psqlt "select schemaname||'.'||relname as table, n_dead_tup, last_autovacuum::date
from pg_stat_all_tables where n_dead_tup > 10000 order by n_dead_tup desc limit 8;" || echo "  (aucune table >10k dead tuples)"

section "[9] CONNEXIONS & POOLS (le plafond réel des 1000 users)"
psql "select 'max_connections = '||setting from pg_settings where name='max_connections';"
echo "-- connexions actuelles par service --"
psqlt "select coalesce(nullif(application_name,''),usename) as service, state, count(*)
from pg_stat_activity where pid <> pg_backend_pid() group by 1,2 order by 3 desc;"
echo "-- pools configurés des services (env conteneurs) --"
for c in norva-rest norva-auth norva-storage realtime-dev.supabase-realtime; do
  echo "  [$c]"
  docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -Ei "POOL|MAX_CONN|DB_MAX" | sed 's/^/    /' || true
done
echo "  (PGRST_DB_POOL absent = défaut PostgREST : 10 connexions)"

section "[10] RÉGLAGES CAPACITÉ POSTGRES"
psqlt "select name, setting, unit from pg_settings where name in
('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem',
 'max_wal_size','checkpoint_timeout','wal_compression','random_page_cost',
 'max_parallel_workers','max_worker_processes','autovacuum_max_workers') order by name;"
echo "-- cache hit ratio (>=99% attendu avec 64 GB) --"
psql "select 'cache hit : '||round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2)||'%  (hit='||blks_hit||' read='||blks_read||')' from pg_stat_database where datname='postgres';"
echo "-- checkpoints (req >> timed = max_wal_size trop petit) --"
psqlt "select * from pg_stat_checkpointer;" 2>/dev/null || psqlt "select checkpoints_timed, checkpoints_req from pg_stat_bgwriter;" 2>/dev/null

section "[11] ÉCHANTILLON DE CHARGE — 60 s (6 mesures)"
X1=$(psql "select xact_commit from pg_stat_database where datname='postgres';")
T1=$(psql "select sum(tup_returned) from pg_stat_database;")
MAXC=0
for i in 1 2 3 4 5 6; do
  C=$(psql "select count(*) from pg_stat_activity where pid <> pg_backend_pid();")
  [ "${C:-0}" -gt "$MAXC" ] && MAXC=$C
  sleep 10
done
X2=$(psql "select xact_commit from pg_stat_database where datname='postgres';")
T2=$(psql "select sum(tup_returned) from pg_stat_database;")
echo "transactions/s (moy 60 s) : $(( (${X2:-0} - ${X1:-0}) / 60 ))"
echo "tuples lus/s   (moy 60 s) : $(( (${T2:-0} - ${T1:-0}) / 60 ))"
echo "pic connexions observé    : $MAXC / $(psql "select setting from pg_settings where name='max_connections';")"

section "[12] RÉSEAU"
awk 'NR>2 && $1 !~ /lo|docker|veth|br-/ {gsub(":","",$1); printf "  %-8s RX total: %.1f GB   TX total: %.1f GB\n", $1, $2/1e9, $10/1e9}' /proc/net/dev
command -v vnstat >/dev/null && vnstat --oneline 2>/dev/null | awk -F';' '{print "  vnstat aujourd hui: RX "$4"  TX "$5"   ce mois: RX "$9"  TX "$10}' || echo "  (vnstat non installé — totaux depuis boot ci-dessus)"

echo
echo "Fini. Pour le débit WAL détaillé, lancer aussi : sudo bash ops/hetzner/scripts/06-check-disk.sh"
echo "Colle-moi la sortie COMPLÈTE des deux."
