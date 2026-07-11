# Restauration — drills (à tester, pas seulement lire)

> Helpers : `PW`/`dpsql` (voir `CUTOVER-LOG-2026-07-11.md` §7). rclone est configuré
> par env via `backup/lib.sh` ; pour un shell interactif :
> `set -a; source /etc/norva-backup.env; set +a` puis exporter les
> `RCLONE_CONFIG_R2_*` comme dans `lib.sh` (ou copier son bloc).

## 1. Restauration LOGIQUE (dump nightly) — perte box totale, nouvelle machine

Cas d'usage : reconstruire from scratch (nouvelle box). C'est le chemin du
cutover 2026-07-11, prouvé en prod.

```bash
# 0) stack vide : suivre README.md Phase 1 (compose up db → healthy, puis up -d)
# 1) récupérer le dernier dump
rclone lsf "r2:$R2_BUCKET/selfhost/dumps/" | sort | tail -1        # → norva-selfhost-<stamp>.tar.gz
rclone copyto "r2:$R2_BUCKET/selfhost/dumps/<archive>" ./restore.tar.gz
tar -xzf restore.tar.gz && cd norva-selfhost-<stamp>
sha256sum -c SHA256SUMS

# 2) recharger, dans l'ordre (en supabase_admin — superuser requis pour
#    --disable-triggers ; les erreurs "reserved role" des globals sont bénignes)
dpsql -f - < 00-globals.sql        || true
dpsql -v ON_ERROR_STOP=0 -f - < 01-schema.sql
dpsql -v ON_ERROR_STOP=1 -f - < 02-data.sql
dpsql -v ON_ERROR_STOP=0 -f - < 03-auth-data.sql      # users/identities (conflits schema_migrations = OK)
dpsql -v ON_ERROR_STOP=0 -f - < 04-storage-data.sql
dpsql -c "vacuum analyze;"

# 3) crons (rejouables, URLs déjà self-host). cron.schedule les crée ACTIFS ;
#    remettre l'état actif/inactif d'origine en s'aidant de ref-cron-active.txt :
dpsql -v ON_ERROR_STOP=0 -f - < ref-cron-jobs.sql
grep 'active=f' ref-cron-active.txt   # → jobs à désactiver, puis :
dpsql -c "update cron.job set active=false where jobname in ('<jobs listés ci-dessus>');"

# 4) vérifier vs MANIFEST.txt
dpsql -Atc "select count(*) from public.cloud_media_items;"
dpsql -Atc "select count(*) from auth.users;"
```

Post-restore : GUCs + vault sont dans la DB restaurée (globals + data). Les
secrets **plateforme** (`.env`) viennent du gestionnaire de secrets, pas du backup.

## 2. Restauration PITR (base + WAL) — « remonter à 14:32, juste avant la bêtise »

S'entraîne SANS toucher la prod : on restaure dans un conteneur jetable sur le
port 5433, on vérifie, on jette.

```bash
set -a; source /etc/norva-backup.env; set +a
# (exporter les RCLONE_CONFIG_R2_* — voir note en tête)

# 1) matériel : dernier base backup + WAL
LAST_BASE=$(rclone lsf "r2:$R2_BUCKET/selfhost/base/" --dirs-only | sort | tail -1)
mkdir -p /tmp/pitr/{data,wal} && cd /tmp/pitr
rclone copy "r2:$R2_BUCKET/selfhost/base/${LAST_BASE%/}" ./base/
rclone copy "r2:$R2_BUCKET/selfhost/wal/" ./wal/        # (ou filtrer par date)

# 2) déballer le base backup dans data/
tar -xzf base/base.tar.gz -C data/
[ -f base/pg_wal.tar.gz ] && mkdir -p data/pg_wal && tar -xzf base/pg_wal.tar.gz -C data/pg_wal

# 3) config PITR : cible temporelle + restore_command depuis ./wal
cat > data/postgresql.auto.conf.add <<'EOF'
restore_command = 'cp /pitr-wal/%f %p'
recovery_target_time = '2026-07-11 14:32:00+00'   # ← ADAPTER
recovery_target_action = 'promote'
EOF
cat data/postgresql.auto.conf.add >> data/postgresql.auto.conf
touch data/recovery.signal
sudo chown -R 105:106 data wal   # uid/gid postgres de l'image (vérifier: docker exec norva-db id postgres)

# 4) démarrer le clone jetable sur 5433 (PAS de -c archive_mode → n'archive pas)
docker run -d --name norva-pitr --network host \
  -v /tmp/pitr/data:/var/lib/postgresql/data \
  -v /tmp/pitr/wal:/pitr-wal:ro \
  -e POSTGRES_PASSWORD=throwaway "$PG_IMAGE" postgres -p 5433
docker logs -f norva-pitr 2>&1 | grep -m1 -E 'consistent recovery state reached|database system is ready'

# 5) vérifier l'état AU point choisi
docker run --rm --network host -e PGPASSWORD="$PW_PROD_DB" "$PG_IMAGE" \
  psql -h 127.0.0.1 -p 5433 -U supabase_admin -d postgres \
  -Atc "select now(), count(*) from public.cloud_media_items;"

# 6) nettoyage
docker rm -f norva-pitr && sudo rm -rf /tmp/pitr
```

Bascule réelle (si la prod est morte et qu'on promeut le clone) : arrêter le
conteneur `db` du compose, remplacer `/var/lib/norva/db` par le data restauré,
`docker compose up -d db`, puis relancer la stack. **Refaire immédiatement un
base backup** (la timeline a changé).

## Signes que les backups sont sains (à regarder de temps en temps)

```bash
rclone lsf "r2:$R2_BUCKET/selfhost/dumps/" | tail -3     # un .tar.gz par nuit
rclone lsf "r2:$R2_BUCKET/selfhost/base/" --dirs-only    # un base-*/ par semaine
rclone lsf "r2:$R2_BUCKET/selfhost/wal/" | wc -l         # croît en continu
systemctl list-timers 'norva-*'                          # 3 timers armés
```
