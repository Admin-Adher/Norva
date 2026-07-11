# Monitoring du self-host (box = prod) — Netdata

> Un agent **Netdata** unique surveille la box : host (CPU/RAM/disque/réseau),
> tous les conteneurs Docker de la stack, et **PostgreSQL** (connexions,
> transactions, réplication, taille des bases, cache hit ratio…). Dashboard
> **loopback-only** — jamais de port public, on y accède par **tunnel SSH**.
> ufw (22/80/443) reste le pare-feu extérieur ; le bind `127.0.0.1` est la
> défense en profondeur.

## Ce qui est surveillé

| Domaine | Source | Exemples de métriques / alarmes par défaut |
|---|---|---|
| **Host** | `/proc`, `/sys`, `/host/root` | CPU, charge, RAM/swap, **disque `/var/lib/norva` qui se remplit**, I/O, réseau |
| **Docker** | `docker.sock` (RO) + cgroups | CPU/RAM/état par conteneur (`norva-db`, `kong`, `auth`, …) |
| **PostgreSQL** | collector `go.d/postgres` | connexions vs `max_connections=200`, deadlocks, cache hit, taille DB, WAL, réplication (si future), requêtes longues |

Netdata embarque ses **alarmes de santé par défaut** (disque > 80/90 %, RAM,
conteneur mort, PG proche de la saturation des connexions…) : elles s'affichent
sur le dashboard sans configuration. Le branchement d'un **canal de notification**
(email/Discord/Telegram) est une étape optionnelle (voir plus bas).

## Architecture (pourquoi ces choix)

- **Projet compose séparé** (`docker-compose.monitoring.yml`, projet
  `norva-monitoring`) : le monitoring redémarre / se met à jour / tombe **sans
  toucher** au plan de données. On ne mélange pas les deux `docker compose`.
- **`network_mode: host` + `pid: host`** : setup officiel Netdata pour un agent.
  Métriques host et par-processus fidèles, et il joint Postgres exactement comme
  `psql` sur la box (`127.0.0.1:5432`, port publié en loopback).
- **Rôle DB dédié `netdata`** (`pg_monitor`, read-only) : aucune écriture, aucune
  donnée applicative lue — que des stats/settings. Mot de passe injecté par
  l'environnement (`NETDATA_PG_PASSWORD`), **jamais** commité (`go.d` interpole
  `${VAR}` au chargement).
- **`bind to = 127.0.0.1:19999`** (`netdata.conf`) : dashboard inaccessible hors
  de la box.

## Installation (box, une fois)

```bash
cd ~/norva && git pull origin main && cd ops/hetzner

# 1) rôle DB read-only pour le collector (génère + enregistre le mot de passe)
NETDATA_PG_PASSWORD=$(openssl rand -hex 24)
echo "NETDATA_PG_PASSWORD=$NETDATA_PG_PASSWORD" >> .env
dpsql -v pw="$NETDATA_PG_PASSWORD" -f - < monitoring/setup-netdata-pg-role.sql
#   → doit afficher: netdata | f | t | f   (login, pas superuser)

# 2) démarrer Netdata (projet compose séparé)
docker compose --env-file .env -f docker-compose.monitoring.yml up -d
docker compose --env-file .env -f docker-compose.monitoring.yml ps   # → running

# 3) vérifs locales (sur la box)
curl -s http://127.0.0.1:19999/api/v1/info | head -c 400 ; echo
# collector postgres bien chargé + sans erreur d'auth :
docker exec norva-netdata \
  bash -c 'grep -i postgres /var/log/netdata/collectors/*.log 2>/dev/null | tail -5' || true
```

> `dpsql` = le helper psql-en-conteneur (défini dans `CUTOVER-LOG-2026-07-11.md`
> §7). Sans lui :
> `docker run --rm -i --network host -e PGPASSWORD="$PW" -v "$PWD:/work" -w /work
> supabase/postgres:17.6.1.136 psql -h 127.0.0.1 -U supabase_admin -d postgres
> -v pw="$NETDATA_PG_PASSWORD" -f - < monitoring/setup-netdata-pg-role.sql`.

## Accès au dashboard (tunnel SSH, depuis ton laptop)

```bash
ssh -N -L 19999:127.0.0.1:19999 adrien@157.180.96.159
# puis ouvre  http://127.0.0.1:19999  dans le navigateur (laisse le ssh ouvert)
```

Rien n'est exposé publiquement : le tunnel mappe ton `localhost:19999` vers le
`127.0.0.1:19999` de la box. Ferme le `ssh` → plus d'accès.

## Alarme critique à ne pas rater : remplissage du disque

Le risque opérationnel n°1 sur cette box est `/var/lib/norva` qui se remplit
(WAL qui n'est plus uploadé → `pg_wal` grossit ; ou `db`/`storage`). Deux
filets déjà en place se complètent :

1. `norva-wal-sync` **échoue exprès** (unit systemd failed) au-delà de 500
   segments WAL locaux (voir `backup/BACKUPS.md`).
2. Netdata lève l'alarme **`disk_space_usage`** sur le montage de
   `/var/lib/norva` à 80 % (warning) / 90 % (critical), visible au dashboard.

Pour être *prévenu* (et pas seulement le voir) → configurer une notification.

## Notifications (optionnel, recommandé) — à brancher quand tu veux

Netdata pousse les alarmes vers un canal via
`/etc/netdata/health_alarm_notify.conf`. Le plus simple sans infra e-mail :
un webhook **Discord** ou **Telegram**.

```bash
docker exec -it norva-netdata bash
./edit-config health_alarm_notify.conf
#   Discord : SEND_DISCORD="YES" + DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"
#   Telegram: SEND_TELEGRAM="YES" + TELEGRAM_BOT_TOKEN + DEFAULT_RECIPIENT_TELEGRAM
exit
docker exec norva-netdata bash -c '/usr/libexec/netdata/plugins.d/alarm-notify.sh test'
docker compose --env-file .env -f docker-compose.monitoring.yml restart netdata
```

> `edit-config` copie le stock dans `/etc/netdata` (volume `netdata-lib`) →
> **persistant** entre redémarrages, mais **hors git**. Dis-moi le canal
> souhaité et je te donne les 2 lignes exactes.

## Opérations

```bash
# état / logs
docker compose --env-file .env -f docker-compose.monitoring.yml ps
docker logs --tail 50 norva-netdata

# mise à jour (tag `stable`)
docker compose --env-file .env -f docker-compose.monitoring.yml pull
docker compose --env-file .env -f docker-compose.monitoring.yml up -d

# rotation du mot de passe du rôle netdata
NEW=$(openssl rand -hex 24)
sed -i "s/^NETDATA_PG_PASSWORD=.*/NETDATA_PG_PASSWORD=$NEW/" .env
dpsql -v pw="$NEW" -f - < monitoring/setup-netdata-pg-role.sql
docker compose --env-file .env -f docker-compose.monitoring.yml up -d --force-recreate netdata
```

## Notes

- **Empreinte** : Netdata garde son historique dans le volume `netdata-lib`
  (dbengine, quelques centaines de Mo, rétention par défaut de plusieurs jours).
  Rien n'est écrit dans l'arbo du repo.
- **Pin de version** : on suit le tag `stable` (correctifs de sécurité au
  `pull`). Épingler une version précise si tu veux une repro stricte.
- **Pas de claim Netdata Cloud** : aucun token → l'agent ne téléphone nulle part
  (`DO_NOT_TRACK=1` en plus). 100 % self-host.
