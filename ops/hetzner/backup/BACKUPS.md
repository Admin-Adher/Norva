# Backups du self-host (box = prod) — architecture + installation

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
- `wal-sync` **échoue exprès** (unit failed) si >500 segments s'accumulent en local
  → archivage/upload en panne → vérifier réseau/R2 AVANT que `pg_wal` remplisse
  le disque.
- **Drill trimestriel** : dérouler `RESTORE.md` (les deux sections) sur la box ou
  une machine jetable. Un backup non testé n'existe pas.
