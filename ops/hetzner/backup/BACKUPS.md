# Backups du self-host (box = prod) — architecture + installation

> ✅ **Opérationnel depuis le 2026-07-11** : 3 timers armés, premiers backups sur R2
> (dump 637 M, WAL, base 987 M). **Drill de restauration RÉUSSI le 2026-07-11** : base
> backup R2 → conteneur jetable → `consistent recovery state reached`, `cloud_media_items=906087`,
> `auth_users=6`. Refaire ce drill (idéalement + le replay WAL de `RESTORE.md §2`) chaque trimestre.

> Deux couches, complémentaires :
> 1. **Dump logique nightly → R2** (03:40 UTC) : `norva-selfhost-<stamp>.tar.gz`
>    (globals + public schéma/data + **auth** + storage + crons rejouables + manifest).
>    Simple, portable, restauration prouvée (c'est le format du cutover). RPO ≤ 24 h.
> 2. **PITR** : archivage **WAL** (5 min max, `archive_timeout=300`) syncé sur R2
>    + **base backup physique hebdo** (dimanche 04:10 UTC). RPO ≈ 5 min,
>    restauration à n'importe quel instant. → `RESTORE.md`.
>
> Le workflow GitHub `backup-db-to-r2.yml` continue de sauvegarder le **managé
> dormant** (préfixe `db/`) pendant la fenêtre de rollback — le désactiver quand
> le managé sera résilié.

## Layout R2 (bucket unique)

```
db/                    ← dumps du managé (workflow GitHub, période rollback)
selfhost/dumps/        ← dumps logiques nightly (rétention 14 j)
selfhost/base/base-*/  ← base backups hebdo (rétention 8)
selfhost/wal/          ← segments WAL (rétention 35 j ≥ plus vieux base backup)
```

## Installation (box, une fois)

```bash
cd ~/norva && git pull origin main && cd ops/hetzner

# 1) rclone
sudo apt install -y rclone

# 2) settings + credentials R2 (mêmes clés que les secrets GitHub R2_*)
sudo cp backup/norva-backup.env.example /etc/norva-backup.env
sudo chmod 600 /etc/norva-backup.env
sudo nano /etc/norva-backup.env          # remplir R2_*, vérifier NORVA_OPS_DIR

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
| Base backup → R2 | dim. 04:10 UTC | `norva-basebackup` |

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
- `wal-sync` **échoue exprès** (unit failed) si >500 segments s'accumulent en local
  → archivage/upload en panne → vérifier réseau/R2 AVANT que `pg_wal` remplisse
  le disque.
- **Drill trimestriel** : dérouler `RESTORE.md` (les deux sections) sur la box ou
  une machine jetable. Un backup non testé n'existe pas.
