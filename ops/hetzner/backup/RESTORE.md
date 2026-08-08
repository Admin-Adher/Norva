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
# 1) récupérer le dernier dump chiffré
LATEST_DUMP="$(rclone lsf "r2:$R2_BUCKET/selfhost/dumps/" | grep '\.tar\.gz\.age$' | sort | tail -1)"
test -n "$LATEST_DUMP"
rclone copyto "r2:$R2_BUCKET/selfhost/dumps/$LATEST_DUMP" ./restore.tar.gz.age

# 2) déchiffrer localement avec l'identité privée conservée hors de la box.
#    BACKUP_AGE_IDENTITY_FILE désigne un fichier chmod 600 ; ne jamais coller
#    son contenu dans le terminal, un ticket ou les logs.
: "${BACKUP_AGE_IDENTITY_FILE:?Set BACKUP_AGE_IDENTITY_FILE to the private age identity file}"
test -r "$BACKUP_AGE_IDENTITY_FILE"
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" \
  --output ./restore.tar.gz ./restore.tar.gz.age
chmod 600 ./restore.tar.gz

# 3) extraire puis vérifier les checksums embarqués avant toute écriture DB
tar -xzf restore.tar.gz && cd norva-selfhost-<stamp>
sha256sum -c SHA256SUMS
# Refuser une ancienne archive qui a supprimé les ACL du dump de schéma.
# Utiliser alors le basebackup/PITR de la section 2, jamais une reconstruction
# manuelle des GRANT Partners.
test "$(grep -Ec '^(GRANT|REVOKE) ' 01-schema.sql)" -gt 0
grep -Eq '^schema_acl_statements=[1-9][0-9]*$' MANIFEST.txt

# 4) recharger, dans l'ordre (en supabase_admin — superuser requis pour
#    --disable-triggers ; les erreurs "reserved role" des globals sont bénignes)
dpsql -f - < 00-globals.sql        || true
dpsql -v ON_ERROR_STOP=0 -f - < 01-schema.sql
dpsql -v ON_ERROR_STOP=1 -f - < 02-data.sql
dpsql -v ON_ERROR_STOP=0 -f - < 03-auth-data.sql      # users/identities (conflits schema_migrations = OK)
dpsql -v ON_ERROR_STOP=0 -f - < 04-storage-data.sql
dpsql -c "vacuum analyze;"

# 5) crons (rejouables, URLs déjà self-host). Chaque instruction restaure son
#    état active exact ; le fichier finit aussi par la coupure fail-closed du
#    rail Revolut Business API dormant :
dpsql -v ON_ERROR_STOP=1 -f - < ref-cron-jobs.sql
dpsql -v ON_ERROR_STOP=1 -c \
  "update cron.job set active=false where jobname='norva-partners-revolut-api';"
dpsql -Atc \
  "select count(*) from cron.job where active and jobname='norva-partners-revolut-api';" \
  | grep -qx '0'

# 6) vérifier vs MANIFEST.txt et les invariants Partners
dpsql -Atc "select count(*) from public.cloud_media_items;"
dpsql -Atc "select count(*) from auth.users;"
dpsql -Atc "select count(*) from affiliate_private.affiliate_accounts;"
dpsql -Atc "select count(*) from affiliate_private.affiliate_events;"
dpsql -v ON_ERROR_STOP=1 \
  -f "$NORVA_OPS_DIR/backup/verify-partners-restore.sql"
```

Post-restore : GUCs + vault sont dans la DB restaurée (globals + data). Les
secrets **plateforme** (`.env`) viennent du gestionnaire de secrets, pas du backup.

Le vérificateur Partners est obligatoire avant toute remise en trafic. Il
échoue si le schéma ou une table critique manque, si RLS ou la frontière de
privilèges privés a régressé, si un trigger append-only est absent ou désactivé,
ou si une écriture du ledger n'est plus équilibrée. Sa sortie ne contient que
des compteurs agrégés.

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
PGPASSWORD="$PW_PROD_DB" docker run --rm --network host -e PGPASSWORD "$PG_IMAGE" \
  psql -h 127.0.0.1 -p 5433 -U supabase_admin -d postgres \
  -Atc "select now(), count(*) from public.cloud_media_items;"

# 6) nettoyage
docker rm -f norva-pitr && sudo rm -rf /tmp/pitr
```

Bascule réelle (si la prod est morte et qu'on promeut le clone) : arrêter le
conteneur `db` du compose, remplacer `/var/lib/norva/db` par le data restauré,
`docker compose up -d db`, puis relancer la stack. **Refaire immédiatement un
base backup** (la timeline a changé).

## 2bis. Restore STANDALONE (base seul, SANS WAL archivé) — ✅ validé 2026-07-12

Le plus simple + le plus robuste, et le test pertinent quand le WAL archivé a été purgé
(cf. session-log 2026-07-12 §5) : restaurer le dernier base-backup dans un conteneur
jetable, vérifier les compteurs, jeter. Les base-backups sont `pg_basebackup -X fetch`
→ **auto-suffisants** : le WAL de consistance est embarqué dans `base.tar.gz` (pas de
`pg_wal.tar.gz` séparé), donc **aucun WAL archivé requis** — c'est ce qui autorise sa
purge sur R2. Tout en **UN** `sudo bash` (évite les pièges de perms `/etc/norva-backup.env`
600-root et de `sudo -s` qui avale le collage) :

```bash
sudo bash <<'EOF'
set -a; . /etc/norva-backup.env; . "$NORVA_OPS_DIR/backup/lib.sh"; set +a
set +e
docker rm -f norva-pitr 2>/dev/null
LAST_BASE=$(rclone lsf "r2:$R2_BUCKET/selfhost/base/" --dirs-only | sort | tail -1); echo "base: $LAST_BASE"
rm -rf /tmp/pitr && mkdir -p /tmp/pitr/data
rclone copy "r2:$R2_BUCKET/selfhost/base/${LAST_BASE%/}" /tmp/pitr/base/
tar -xzf /tmp/pitr/base/base.tar.gz -C /tmp/pitr/data        # WAL de consistance inclus dedans
mkdir -p /tmp/pitr/data/pg_wal
[ -f /tmp/pitr/base/pg_wal.tar.gz ] && tar -xzf /tmp/pitr/base/pg_wal.tar.gz -C /tmp/pitr/data/pg_wal
PGUID=$(docker exec norva-db id -u postgres); PGGID=$(docker exec norva-db id -g postgres)
chown -R "$PGUID:$PGGID" /tmp/pitr/data
docker run -d --name norva-pitr --network host -v /tmp/pitr/data:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=throwaway "$PG_IMAGE" postgres -p 5433 -c archive_mode=off
sleep 8; docker logs norva-pitr 2>&1 | tail -20   # attendu: "consistent recovery state reached" + "ready to accept connections"
Q="select (select count(*) from public.cloud_media_items) media, (select count(*) from public.cloud_titles) titles, (select count(*) from auth.users) users;"
PGPASSWORD="$POSTGRES_PASSWORD" docker exec -e PGPASSWORD norva-pitr psql -h 127.0.0.1 -p 5433 -U supabase_admin -d postgres -c "$Q"
PGPASSWORD="$POSTGRES_PASSWORD" docker exec -e PGPASSWORD norva-db  psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -c "$Q"
docker rm -f norva-pitr; rm -rf /tmp/pitr        # nettoyage
EOF
```

> **Résultat 2026-07-12** : clone `healthy`, `consistent recovery state reached`, `database
> system is ready` ; 935 666 media / 719 944 titles / 7 users (≈ prod à 95 lignes près =
> snapshot au point du base-backup). **Preuve que les base-backups restaurent sans le WAL archivé.**

### Répétition physique Partners avant et après migration

Pour valider une release Partners sans modifier le checkout live, sans port
exposé et sans aucune connexion du clone au réseau, exécuter le script depuis
un checkout/worktree du candidat avec son SHA complet :

```bash
sudo bash ops/hetzner/backup/rehearse-partners-physical.sh \
  predeploy \
  <sha-git-complet-sur-40-caractères>
```

Après le déploiement biphasé, créer obligatoirement un nouveau base-backup R2.
Le contrôle one-shot ci-dessous préserve tous les anciens objets, même si la
rétention planifiée est plus courte :

```bash
sudo env NORVA_SKIP_BASE_RETENTION=true \
  bash ops/hetzner/backup/basebackup-weekly.sh
```

Vérifier que le nom `base-YYYYMMDD-HHMMSS` annoncé est postérieur au
déploiement. Le contrôle postdéploiement utilise ensuite obligatoirement le
même SHA et le mode opposé :

```bash
sudo bash ops/hetzner/backup/rehearse-partners-physical.sh \
  postdeploy \
  <sha-git-complet-sur-40-caractères>
```

Le script lit le dernier base-backup R2, matérialise les migrations, le
vérificateur et le pgTAP dédié à la restauration directement depuis l'objet Git
demandé, puis restaure le tout dans un conteneur unique en `--network none`.
Ce pgTAP est additif et indépendant du nombre de comptes, demandes et écritures
déjà présents. Les suites d'intégration exhaustives, qui créent leurs propres
fixtures et supposent une base vide, restent exécutées séparément par la CI dans
son PostgreSQL jetable. Les workers `pg_cron` et `pg_net` sont neutralisés dès
le démarrage en les retirant des préloads. Le script ne désactive pas les lignes
restaurées de `cron.job` : sans scheduler, elles restent inertes dans ce clone
isolé, et leurs nombres total et actif sont contrôlés avant et après la
répétition. Pour cette release, en `predeploy`, les 31 marqueurs de la baseline
auditée `eda071e` doivent tous être présents et le marqueur du contrat booléen
bootstrap doit être absent. Une seule migration est rejouée dans une
transaction unique :

1. `20260809090000_partners_bootstrap_nonmember_boolean.sql`.

En `postdeploy`, les 32 marqueurs doivent tous être présents : aucune migration
n'est rejouée, puis le vérificateur et le pgTAP sont exécutés sur l'état déjà
migré. Un état partiel est refusé dans les deux modes.
Le conteneur et le répertoire temporaire sont toujours supprimés par le trap de
sortie.

La seule sortie durable est un `rehearsal-proof.log` privé (mode `0600`) et son
fichier `.sha256` sous `norva-deploy-backups/`. Ils ne contiennent ni sortie SQL
brute, ni mot de passe, ni clé R2. Pour le même SHA candidat, le workflow CI
exhaustif doit être vert et la preuve physique doit contenir `result=passed`
ainsi que `pgtap_profile=physical_restore_compatible_v1` avant toute migration
de production.

La preuve `predeploy` du candidat actuel doit contenir
`baseline_contract=eda071e`, `baseline_markers_verified=31`,
`rehearsal_mode=predeploy`, `migrations_applied=1`,
`migrations_atomic=true`, `migration_replay_skipped=false`, les 31 marqueurs
de baseline à `1` puis le marqueur hotfix à `0` avant, et 32 marqueurs `1`
après. Elle doit
également contenir `migration_routines_verified=162` et
`migration_relations_verified=19`. La preuve `postdeploy` doit contenir
`baseline_contract=eda071e`, `rehearsal_mode=postdeploy`,
`migrations_applied=0`, `migration_replay_skipped=true`, et 32 marqueurs `1`
avant comme après, avec les mêmes 162 routines et 19 relations vérifiées.

## Signes que les backups sont sains (à regarder de temps en temps)

```bash
rclone lsf "r2:$R2_BUCKET/selfhost/dumps/" | tail -3     # un .tar.gz.age par nuit
rclone lsf "r2:$R2_BUCKET/selfhost/base/" --dirs-only    # un base-*/ par semaine
rclone lsf "r2:$R2_BUCKET/selfhost/wal/" | wc -l         # croît en continu
systemctl list-timers 'norva-*'                          # 3 timers armés
```
