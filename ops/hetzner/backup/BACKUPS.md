# Backups du self-host (box = prod) — architecture + installation

> ✅ **Opérationnel depuis le 2026-07-11** : 4 timers armés, premiers backups sur R2
> (dump 637 M, WAL, base 987 M). **Drill de restauration RÉUSSI le 2026-07-11** : base
> backup R2 → conteneur jetable → `consistent recovery state reached`, `cloud_media_items=906087`,
> `auth_users=6`. Refaire ce drill (idéalement + le replay WAL de `RESTORE.md §2`) chaque trimestre.
> **Rejoué le 2026-08-21** sur un base backup **streamé** : reprise consistante,
> comptes identiques à la prod, `pg_verifybackup` OK. Prochain dû : novembre 2026.

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
# install-timers.sh crée aussi /etc/norva-gc.env depuis des valeurs sans secret;
# le personnaliser seulement si les bornes de preuve/cache doivent changer.
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
| GC des clones de preuve jetables | toutes les 6 h | `norva-proof-gc` |
| Veille capacité + débit WAL | toutes les 6 h | `norva-capacity-check` |
| GC Docker borné | 01:35 UTC | `norva-docker-gc` |
| GC des déploiements/candidats inactifs | 02:05 UTC | `norva-deployment-gc` |
| Réindexation | 1er du mois, 01:00 UTC | `norva-reindex` |

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
- **Vérification bornée du WAL local.** Après l'upload, `wal-sync` charge une seule
  fois l'inventaire plat du préfixe R2, calcule localement l'intersection avec les
  segments expirés, puis ne supprime que les noms présents des deux côtés. Il ne
  lance jamais un `rclone lsf` par segment. `wal-sync` et `wal-prune-r2` partagent
  en plus un verrou `flock`, afin que la rétention distante ne puisse pas courir
  entre la preuve de présence et la suppression locale. L'unité est bornée à
  30 minutes et 1 Gio de mémoire : un dépassement devient un échec explicite.
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
- **Cycle de vie des preuves jetables.** Une répétition réussie conserve les
  rapports et leurs sommes de contrôle, puis retire par défaut son conteneur,
  son répertoire `prod-clone-*` et son dump privé. `--keep-clone-hours N`
  ouvre une fenêtre de diagnostic bornée. Les exécutions échouées expirent au
  bout de 72 h. `proof-gc.sh` exige simultanément le label Docker jetable, le
  préfixe de conteneur, l'identité exacte du bind mount, aucun port publié,
  aucune session SQL cliente et les chemins canoniques sous
  `/var/lib/norva-phase3-proof` avant de supprimer. Il ne touche jamais à
  `/var/lib/norva/db`, aux sources ou aux rapports.
- **GC Docker borné.** `docker-gc.sh` applique d'abord la limite BuildKit de
  12 GB avec 8 GB réservés, puis traite séparément la réserve de 120 GB libres.
  Le passage échoue explicitement si le cache reste au-dessus de 12 GB. Pour
  les images média non référencées, il conserve deux images de rollback et une
  grâce de 48 h; Whisper reste à sept jours. Les images utilisées par un
  conteneur ou portant `norva.retention=protected` sont exclues.
  Cette séparation évite qu'une réserve disque déjà satisfaite transforme la
  limitation BuildKit en no-op silencieux. La politique est réappliquée après
  la suppression des images et jusqu'à six passes, car BuildKit libère parfois
  ses couches en cascade; elle s'arrête immédiatement si aucune passe ne
  progresse. Si des enregistrements récupérables restent néanmoins au-dessus
  de 12 GB, un unique rattrapage toujours borné à 4 GB avec 2 GB réservés est
  exécuté; aucun prune BuildKit non borné n'est utilisé.
- **GC des sources de déploiement.** `deployment-gc.sh` ne considère que les
  répertoires de premier niveau sous `norva-deployments`,
  `norva-media-deployments` et `norva-candidates`. Il conserve les deux plus
  récents de chaque racine, applique 7 jours aux déploiements et 72 h aux
  candidats, puis exclut tout chemin monté, toute source de bind Docker, tout
  worktree Git modifié, les noms `backup`/`proof`/`evidence` et tout répertoire
  portant `.norva-retain`. Un worktree
  Git est retiré avec `git worktree remove`, jamais par suppression aveugle.
  Le mode par défaut des trois scripts GC est `--dry-run`; systemd est le seul
  appelant configuré avec `--apply`.
- **Surveillance sans privilèges.** `storage-watch.sh` contrôle toutes les six
  heures le disque, les preuves, BuildKit et les images récupérables. Il peut
  être lancé par le cron de l'opérateur quand l'installation des unités
  systemd attend encore une authentification root; les alertes utilisent le
  même bot Telegram que le watchdog complet.
- **Veille capacité (`capacity-check.sh`).** Six seuils, réglables dans
  `/etc/norva-backup.env` : débit de WAL (GiB/jour, calculé sur le delta de
  `pg_current_wal_lsn()` depuis la veille), coût par utilisateur porteur de
  catalogue, place disque face aux 2x que réclame le staging du base backup,
  taille des preuves jetables, cache BuildKit, images Docker récupérables,
  croissance quotidienne du disque et variation du préfixe WAL sur R2. Cette
  dernière mesure fait un inventaire borné du préfixe avec `rclone --fast-list`
  afin de détecter aussi une rétention distante bloquée.
  Dépassement → message Telegram (même bot que Netdata, identifiants lus dans le
  `.env` de la stack) **et** sortie non nulle, donc unité en `failed`. Le premier
  run ne fait qu'amorcer son fichier d'état et reste muet.
- **La bonne unite de capacite, c'est le titre.** Audit 2026-08-27 : après le
  schéma Phase 3 et une réindexation concurrente mesurée, les tables `cloud_*`
  occupent ~10 109 octets par titre. Le seuil d'alerte est 12 000 ; il signale
  une croissance à diagnostiquer avec `pgstattuple`/`pgstatindex`, pas une preuve
  automatique de bloat. Le nombre
  d'utilisateurs ne dit rien — un seul compte portait 523 050 titres (67 % du
  total) et 11 inscrits sur 16 n'avaient importe aucun catalogue. La couche
  `catalog_*` (1,1 GB) est un cout fixe qui sature : ne pas l'inclure dans le
  cout marginal. Plafond de la box : ~31 M de titres avec un base backup en flux,
  ~20 M avec le staging local actuel.
- **Santé des unités.** `capacity-check.sh` interroge systemd sur les quatre autres
  unités (`ActiveState`, heure de démarrage, `Result` et ancienneté du dernier run)
  et alerte si l'une a échoué, n'a jamais tourné, tourne depuis trop longtemps,
  ou n'a pas tourné depuis trop longtemps. Seuils dans
  `CAPACITY_UNIT_CHECKS`. C'est ce qui rend enfin vrai le commentaire de
  `wal-sync.sh` (« non-zero so systemd marks the unit failed, visible in
  monitoring ») : rien ne regardait, le `go.d` de Netdata n'ayant pas de
  collecteur `systemdunits` et en ajouter un supposant d'ouvrir le D-Bus hôte
  au conteneur.
- **Réindexation.** `cloud_titles` tourne à ~14 % de HOT, donc chaque mise à jour
  non-HOT ajoute une entrée dans **tous** ses index : le ballonnement revient en
  régime permanent. Audit 2026-08-21 : un seul index était ballonné à 69 %
  (199 → 62 MB). Le passage du 2026-08-27 sur `cloud_titles`,
  `cloud_media_items` et `cloud_title_variants` a rendu ~1,85 GB sans index
  invalide. `catalog_titles` est dominé par son TOAST et reste hors de cette
  opération. Automatisé : `norva-reindex.timer`, le 1er de chaque
  mois. `REINDEX TABLE CONCURRENTLY` ne pose pas de verrou exclusif mais construit
  le nouvel index à côté de l'ancien, donc il faut la place du plus gros index en
  cours de reconstruction. Un échec laisse un index INVALID qui consomme les
  écritures sans servir les lectures : le script sort en non-zéro et rappelle la
  requête pour les débusquer.
- **Base backup en flux (`BASEBACKUP_STREAM`).** Par defaut `false` : `pg_basebackup`
  ecrit une copie physique complete dans `BACKUP_STAGE_DIR` avant l'envoi, donc la
  box a besoin de ~2x la taille de la base en disque libre. C'est **cette exigence**
  qui pose le plafond de capacite : ~20 M de titres avec staging, ~31 M en flux.
  En `true`, `pg_basebackup -D - | rclone rcat` supprime la copie locale.
  L'artefact est equivalent (`base.tar.gz`, WAL de consistance embarque) donc
  `RESTORE.md` est inchange. **Une seule difference, verifiee le 2026-08-21** : en
  mode stage `backup_manifest` est un fichier a cote du tar, en mode flux il est
  *dans* le tar (un seul flux de sortie possible). Rien n'est perdu — il faut juste
  l'extraire pour s'en servir. Ce qui donne la validation la moins couteuse d'un
  artefact streame, sans monter d'instance :

  ```bash
  r2 cat r2:$R2_BUCKET/selfhost/base/<stamp>/base.tar.gz | sudo tar -xzf - -C /var/lib/norva/verify
  docker run --rm -v /var/lib/norva/verify:/data $PG_IMAGE pg_verifybackup /data
  ``` Contrepartie : un flux **ne se rejoue pas** — une
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
## Cible à 7 M de titres : passer au physique incrémental (pgBackRest)

> **Décision prise le 2026-08-21, à appliquer plus tard.** Écrite maintenant pour ne
> pas refaire le raisonnement le jour où le seuil tombe. **Ne rien migrer avant.**

Le facteur limitant de la box n'est ni le disque ni le coût R2, c'est de
**réexpédier la base entière chaque nuit**. Mesuré le 2026-08-21 : 5 719 octets par
titre et 18 Mo/s d'upload vers R2. La colonne « imports » ci-dessous est dérivée
d'une hypothèse de 78 000 titres par import — voir l'encadré après le tableau.

| Titres | Imports à 78 k (hypothèse) | Base | Upload quotidien | Fenêtre |
|---|---|---|---|---|
| 0,78 M (aujourd'hui) | 5 | 5,5 GB | 1,8 GB | 100 s |
| 11,7 M | 150 | 67 GB | 67 GB | ~1 h |
| 31 M | 400 | 178 GB | 178 GB | **2 h 45** |

**Déclencheur : 7 millions de titres** (~40 GB de base). `capacity-check.sh` compte
les titres tous les matins — c'est le seuil à surveiller, pas un nombre d'imports.

> **Pourquoi en titres et pas en imports.** Le nombre de titres qu'apporte un import
> est la grande inconnue de toute cette projection, et elle est mesurée sur **un**
> compte externe. Au 2026-08-21 : `yildirim68kamil` porte 77 800 titres,
> `projethorizon2030` en porte **523 050** — un facteur **6,7**. Selon lequel des deux
> profils domine, 7 M de titres arrivent à 90 imports ou à 13. Le tableau ci-dessus
> retiennent 78 000 titres/import : c'est une hypothèse de travail, pas une mesure.
> Le seuil en titres, lui, reste juste dans les deux cas.
>
> À surveiller au fil des inscriptions, pour trancher :
>
> ```sql
> select user_id, count(*) titres from public.cloud_titles group by 1 order by 2 desc;
> ```

**Cible : pgBackRest.** Full hebdomadaire + incrémental quotidien : l'upload
quotidien tombe aux blocs modifiés, soit ~5-10 GB au lieu de 178. Support S3 natif
vers R2, compression et upload parallèles, rétention et `pgbackrest verify`
intégrés. Il remplace **trois** scripts : `basebackup-weekly.sh`, `wal-sync.sh` et
`wal-prune-r2.sh` (via `archive_command = pgbackrest archive-push`).

L'argument décisif est la **restauration** : `pgbackrest restore` reconstruit
directement depuis S3 dans le répertoire cible. Le drill trimestriel n'a plus
besoin des ~2x la taille de la base en local — ce qui, à 178 GB, l'empêcherait de
tenir sur cette box. Le `pg_basebackup --incremental` natif de PG17 est plus
élégant (zéro dépendance, on est déjà en 17.6) mais `pg_combinebackup` exige le full
**et** tous les incrémentaux en local pour reconstruire : le problème du 2x revient,
aggravé. À écarter pour cette raison précise.

**Second poste : le dump logique nightly.** À 178 GB, `pg_dump` prend des heures
pour ~22 GB. Le passer en **hebdomadaire** : le physique + WAL couvrent déjà le PITR
à la minute, le dump n'existe que comme format portable et comme assurance contre
une corruption du physique. Une fois par semaine remplit ces deux rôles.

**À revalider après migration**, sans exception : un drill complet `RESTORE.md`
sur un artefact pgBackRest, plus un test de restauration à un point dans le temps.
On remplacerait trois scripts éprouvés par une configuration neuve.

Plafond après migration : ~47 M de titres, borné par le disque et non plus par la
fenêtre de backup. Au-delà, c'est un achat de matériel.

- **Drill trimestriel** : dérouler `RESTORE.md` (les deux sections) sur la box ou
  une machine jetable. Un backup non testé n'existe pas.
