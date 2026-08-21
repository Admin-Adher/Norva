# Backups du self-host (box = prod) — architecture + installation

> ✅ **Opérationnel depuis le 2026-07-11** : 4 timers armés, premiers backups sur R2
> (dump 637 M, WAL, base 987 M). **Drill de restauration RÉUSSI le 2026-07-11** : base
> backup R2 → conteneur jetable → `consistent recovery state reached`, `cloud_media_items=906087`,
> `auth_users=6`. Refaire ce drill (idéalement + le replay WAL de `RESTORE.md §2`) chaque trimestre.

> Deux couches, complémentaires :
> 1. **Dump logique nightly → R2** (03:40 UTC) : `norva-selfhost-<stamp>.tar.gz.age`
>    (globals + `public` + `affiliate_private` schéma/data + **auth** + storage +
>    crons rejouables + manifest), chiffré avec le destinataire public `age` avant
>    envoi. La clé privée de restauration reste hors du serveur.
>    Simple, portable, restauration prouvée (c'est le format du cutover). RPO ≤ 24 h.
> 2. **PITR** : archivage **WAL** (15 min max, `archive_timeout=900`) syncé sur R2
>    + **base backup physique quotidien** (04:10 UTC). RPO ≈ 15 min,
>    restauration à n'importe quel instant. → `RESTORE.md`.
>
> ~~Le workflow GitHub `backup-db-to-r2.yml` continue de sauvegarder le **managé
> dormant** (préfixe `db/`) pendant la fenêtre de rollback — le désactiver quand
> le managé sera résilié.~~ **Fait** : managé supprimé + workflow retiré (`c0b9b55`).
> Le préfixe `db/` sur R2 est donc figé (dumps d'avant le cutover du 11/07) — garder
> le plus récent en archive historique, le reste est supprimable :
> `rclone lsf r2:$R2_BUCKET/db/ | sort | head -n -1 | rclone delete r2:$R2_BUCKET/db/ --files-from - --dry-run`
> (retirer `--dry-run` après vérification de la liste).

## Layout R2 (bucket unique)

```
db/                    ← dumps du managé (workflow GitHub, période rollback)
selfhost/dumps/        ← dumps logiques nightly chiffrés .tar.gz.age (rétention 14 j)
selfhost/base/base-*/  ← base backups quotidiens (rétention KEEP_BASE_COUNT=3)
selfhost/wal/          ← segments WAL (rétention KEEP_WAL_DAYS=3 ≥ KEEP_BASE_COUNT)
```

## Installation (box, une fois)

```bash
cd ~/norva && git pull origin main && cd ops/hetzner

# 1) rclone + age
sudo apt install -y rclone age

# 2) settings + credentials R2 (mêmes clés que les secrets GitHub R2_*)
sudo cp backup/norva-backup.env.example /etc/norva-backup.env
sudo chmod 600 /etc/norva-backup.env
sudo nano /etc/norva-backup.env          # remplir R2_*, BACKUP_AGE_RECIPIENT, vérifier NORVA_OPS_DIR
# Conserver BACKUP_ENCRYPTION_REQUIRED=true en production. Le destinataire
# age1... est public ; ne jamais copier la clé privée de déchiffrement sur la box.

# 3) dossiers + droits (le postgres du conteneur doit écrire le WAL archive)
sudo mkdir -p /var/lib/norva/wal-archive /var/lib/norva/backups
PGUID=$(docker exec norva-db id -u postgres); PGGID=$(docker exec norva-db id -g postgres)
sudo chown "$PGUID:$PGGID" /var/lib/norva/wal-archive

# 4) activer l'archivage WAL (recrée le conteneur db — ~15 s d'indispo API)
docker compose --env-file .env -f docker-compose.supabase.yml up -d db
docker compose --env-file .env -f docker-compose.supabase.yml ps db   # → healthy

# 5) vérifier l'archivage
dpsql -Atc "show archive_mode; show archive_command;"
dpsql -Atc "select pg_switch_wal();" >/dev/null
sleep 3 && ls -la /var/lib/norva/wal-archive | tail -3   # → un segment 000000010000…

# 6) timers systemd
sudo bash backup/install-timers.sh

# 7) premiers runs manuels + vérif R2
sudo systemctl start norva-wal-sync.service
sudo systemctl start norva-backup-nightly.service
sudo journalctl -u norva-backup-nightly.service -n 20 --no-pager
sudo systemctl start norva-basebackup.service
sudo journalctl -u norva-basebackup.service -n 20 --no-pager
```

## Opérations

| Quoi | Quand | Unité |
|---|---|---|
| Dump logique → R2 | 03:40 UTC | `norva-backup-nightly` |
| WAL → R2 | toutes les 5 min | `norva-wal-sync` |
| Base backup → R2 | 04:10 UTC | `norva-basebackup` |
| Rétention WAL sur R2 | 02:20 UTC | `norva-wal-prune-r2` |
| Veille capacité + débit WAL | 06:40 UTC | `norva-capacity-check` |

- État : `systemctl list-timers 'norva-*'` · logs : `journalctl -u <unité> -n 30`.
- **Réplication pg_hba** : `pg_basebackup` a besoin d'une règle `host replication …` dans le
  `pg_hba.conf` de l'image (`/etc/postgresql/pg_hba.conf`, *dans* le conteneur → réinitialisé
  à chaque recréation du conteneur `db`). `basebackup-weekly.sh` **la ré-ajoute tout seul**
  (étape `[0/3]`) avant chaque run — rien à faire à la main, même sur une box neuve.
- **rclone ↔ R2** : les uploads logguent parfois `NotImplemented (501)` au 1ᵉʳ essai puis
  `Attempt 2 succeeded` — quirk connu (R2 refuse un en-tête de checksum que rclone tente),
  auto-réparé par le retry, données intègres. Pour le supprimer : `rclone` ≥ 1.66
  (`curl https://rclone.org/install.sh | sudo bash`) détecte le provider Cloudflare et n'envoie
  plus ce checksum.
- Si l'envoi ou sa vérification de taille échoue après création de l'archive, le script
  conserve le répertoire privé `nightly-work.<stamp>.*` sous `BACKUP_STAGE_DIR` et journalise
  son chemin. Ne le supprimer qu'après avoir récupéré l'archive ou relancé un envoi vérifié.
- `wal-sync` **échoue exprès** (unit failed) si >100 segments dépassent
  `KEEP_LOCAL_WAL_MINUTES` sans être partis, ou si >2000 fichiers s'accumulent en local
  → archivage/upload en panne → vérifier réseau/R2 AVANT que `pg_wal` remplisse
  le disque.
- **Volume de WAL — audit 2026-08-20.** Le bucket était à 183 GB, dont 122 GiB de
  `selfhost/wal/` (79 %) pour seulement 3 jours de rétention : la base produisait
  ~27 GiB de WAL par jour. Cause amont : `checkpoint_timeout` était resté au défaut
  de 5 min (11761 checkpoints horaires contre 89 forcés par le volume), donc chaque
  page touchée était réécrite entière dans le WAL toutes les 5 minutes. Corrigé à
  `30min` dans `docker-compose.supabase.yml`. **La rétention n'était pas le problème**
  — elle fonctionnait correctement sur les quatre préfixes. Avant de toucher à
  `KEEP_*`, vérifier `pg_stat_checkpointer` et `wal_fpi` dans `pg_stat_statements`.
- **Coût R2 en opérations.** `rclone` fait un HEAD par objet pour lire son propre
  `X-Amz-Meta-Mtime` : sur un préfixe de ~8k segments c'est ~8k opérations classe B
  par passage. D'où `--use-server-modtime` dans `wal-prune-r2.sh` et `--no-traverse`
  dans `wal-sync.sh`. Ces deux flags valent 15 M d'opérations classe B par mois.
- **Veille capacité (`capacity-check.sh`).** Trois seuils, réglables dans
  `/etc/norva-backup.env` : débit de WAL (GiB/jour, calculé sur le delta de
  `pg_current_wal_lsn()` depuis la veille), coût par utilisateur porteur de
  catalogue, et place disque face aux 2x que réclame le staging du base backup.
  Dépassement → message Telegram (même bot que Netdata, identifiants lus dans le
  `.env` de la stack) **et** sortie non nulle, donc unité en `failed`. Le premier
  run ne fait qu'amorcer son fichier d'état et reste muet.
- **La bonne unite de capacite, c'est le titre.** Audit 2026-08-21 : 777 160 titres
  pour 4 238 MB de tables `cloud_*`, soit ~5 719 octets par titre. Le nombre
  d'utilisateurs ne dit rien — un seul compte portait 523 050 titres (67 % du
  total) et 11 inscrits sur 16 n'avaient importe aucun catalogue. La couche
  `catalog_*` (1,1 GB) est un cout fixe qui sature : ne pas l'inclure dans le
  cout marginal. Plafond de la box : ~31 M de titres avec un base backup en flux,
  ~20 M avec le staging local actuel.
- **Ce que la veille ne couvre pas encore.** Rien ne surveille l'échec des unités
  elles-mêmes : si `norva-backup-nightly` échoue, aucune alerte ne part. Le
  `go.d` de Netdata n'a pas de collecteur `systemdunits`. À ajouter.
- **Réindexation.** `cloud_titles` tourne à ~14 % de HOT, donc chaque mise à jour
  non-HOT ajoute une entrée dans **tous** ses index : le ballonnement revient en
  régime permanent. Audit 2026-08-21 : un seul index était ballonné à 69 %
  (199 → 62 MB), et un `REINDEX TABLE CONCURRENTLY` sur les quatre grosses tables
  a rendu 1,1 GB sur 6,8. À refaire mensuellement.
- **Base backup en flux (`BASEBACKUP_STREAM`).** Par defaut `false` : `pg_basebackup`
  ecrit une copie physique complete dans `BACKUP_STAGE_DIR` avant l'envoi, donc la
  box a besoin de ~2x la taille de la base en disque libre. C'est **cette exigence**
  qui pose le plafond de capacite : ~20 M de titres avec staging, ~31 M en flux.
  En `true`, `pg_basebackup -D - | rclone rcat` supprime la copie locale.
  L'artefact est identique (`base.tar.gz`, WAL de consistance embarque) donc
  `RESTORE.md` est inchange. Contrepartie : un flux **ne se rejoue pas** — une
  coupure reseau perd le run, le suivant le rattrape. Un flux interrompu laisse un
  objet tronque que `rcat` signale comme reussi : le script verifie donc le code de
  chaque etage du pipe puis un plancher de taille, et purge l'objet partiel.
  **Procedure de bascule** (ne pas basculer sur la foi d'un run reussi) :

  ```bash
  # 1) un run en flux, sans toucher a la retention
  sudo env BASEBACKUP_STREAM=true NORVA_SKIP_BASE_RETENTION=true \
    bash ~/norva/ops/hetzner/backup/basebackup-weekly.sh
  # 2) comparer la taille au dernier base backup stage
  rclone lsf r2:$R2_BUCKET/selfhost/base/ --dirs-only
  # 3) DEROULER RESTORE.md section 2 sur l'artefact streame -- obligatoire
  # 4) seulement alors : BASEBACKUP_STREAM=true dans /etc/norva-backup.env
  ```
- **Drill trimestriel** : dérouler `RESTORE.md` (les deux sections) sur la box ou
  une machine jetable. Un backup non testé n'existe pas.
