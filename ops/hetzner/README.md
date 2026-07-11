# Norva — Migration Hetzner (stack Supabase OSS self-host)

> **Statut : scripts PRÉPARÉS, pas exécutés.** L'infra (provisioning, DNS, TLS, secrets réels,
> ops) reste ton domaine. Ce dossier est le *code* de migration : dump/restore, recréation des
> crons/vault/GUC, déploiement des edge functions, vérif de parité. Grounded sur l'inventaire
> prod réel du **2026-07-07** (projet managé `oupsceccxsonaalhueff`).
>
> Le **pourquoi / le sizing / quelle box** : voir
> [`../../docs/roadmap/scaling-cost-hetzner-plan.md`](../../docs/roadmap/scaling-cost-hetzner-plan.md)
> (§7 milliers d'users, §8 index de ces scripts).

---

## Inventaire prod capturé (2026-07-07)

| Élément | Valeur |
|---|---|
| DB size | **5,15 Go** |
| Extensions | `pg_cron 1.6.4`, `pg_net 0.20.3`, `supabase_vault 0.3.1`, `pg_trgm 1.6`, `pgcrypto 1.3`, `http 1.6`, `unaccent 1.1`, `uuid-ossp 1.1`, `pgstattuple 1.5`, `pg_stat_statements 1.11`, `plpgsql` |
| pg_cron | **47 jobs (46 actifs)** — appellent les edge functions via `pg_net` (URLs à réécrire) |
| Vault | **3 secrets** : `norva_backfill_token`, `norva_cron_shared_secret`, `resend_api_key` |
| Role GUCs | `anon: statement_timeout=3s`, `authenticated: statement_timeout=8s` |
| Edge functions | **19** `norva-*` (voir `supabase/config.toml` pour `verify_jwt`) |

⚠️ **Ce qui ne se dump PAS et doit être recréé à la main :**
- **Vault secrets** — chiffrés côté managé, on ne peut pas les exfiltrer en clair. On les **ré-injecte** depuis la source de vérité (ton gestionnaire de secrets / `.env`). Voir `scripts/03-recreate-cron-guc.sql`.
- **pg_cron jobs** — leurs commandes contiennent l'**URL du projet managé** (`https://oupsceccxsonaalhueff.supabase.co/functions/v1/...`). À **réécrire** vers l'endpoint self-host. `pg_dump` ne dumpe pas fiablement `cron.job` de manière rejouable → on recrée via `cron.schedule`.
- **Role-level GUCs** (`ALTER ROLE anon SET statement_timeout='3s'`, etc.) — inclus dans `pg_dumpall --globals` mais on les remet explicitement pour être sûr.
- **Edge functions** — code applicatif, déployé séparément (`scripts/04-deploy-edge-functions.sh`).
- **Storage buckets** — un seul bucket `norva-storyboards` (sprites de scrubbing), objets à
  re-syncer si non recréables. Les **sous-titres NE sont PAS** dans un bucket : le VTT est stocké
  en colonne (`public.catalog_generated_subtitles.vtt`), donc migré avec le schéma `public`.

---

## Cible matérielle (rappel §7)

- **Guérir les timeouts aujourd'hui** : n'importe quel box **64 Go RAM NVMe** (AX42 / Serverbörse) — la RAM > hot set (2,9 Go) tue les `DataFileRead`.
- **1k-10k users dédupés** : **AX102** (Ryzen 9 7950X3D, 16c/32t, **128 Go ECC**, 2×1,92 To NVMe RAID1).
- **Milliers + ECC registered + burst-imports** : **EX131** (Xeon Gold 6731P, 32c) ou **AX162-S** (EPYC 9454P, 48c/96t) avec **256 Go** DDR5 ECC reg.
- **Ne PAS acheter 512 Go** (hot set dédupé = 15-115 Go ; 128 Go = sweet spot).
- **Prérequis** : NVMe DC-Edition, **ECC**, **mdadm RAID1** (pas RAID0), pooler PgBouncer/Supavisor devant.

### Partitionnement disque conseillé

Sur un box type 2×NVMe (SSD) + éventuellement 2×HDD (ex. le box i7-7700 / 64 Go / 2×512 Go SSD + 2×6 To HDD que tu regardais) :

| Montage | Support | Rôle |
|---|---|---|
| `/` + `/var/lib/postgresql` | **SSD/NVMe RAID1** | OS + **données Postgres** (random-read → NVMe obligatoire) |
| `/var/lib/norva/storage` | **SSD** ou HDD | bucket Storage `norva-storyboards` (sprites) — séquentiel, HDD OK |
| `/var/backups/norva` | **HDD RAID1** | dumps + **WAL archiving** (pgBackRest/WAL-G) — séquentiel, gros volume |
| `/var/lib/norva/pg_wal` (option) | SSD séparé | WAL sur disque dédié = moins de contention checkpoint sous imports |

> Le box i7-7700 / 64 Go que tu montrais **guérit les timeouts actuels** et tient confortablement
> **~100 users** (cf. §2 du plan). Il ne vise PAS « milliers d'users » — pour ça, EX131/AX162 + multi-nœuds (§7.5).

---

## Ordre d'exécution (runbook)

> Estimation : **1-2 semaines** pour une migration soignée + hardening. Prévois une **fenêtre de
> maintenance** (freeze imports) pour le dump/restore final. Fais un **dry-run complet** sur un
> box de test avant le vrai basculement.

### Phase 0 — Préparer le serveur (toi, hors repo)
1. Provisionner le box (Ubuntu LTS), `mdadm` RAID1 sur les NVMe, partitions ci-dessus.
2. `docker` + `docker compose`, `ufw` (n'exposer que 80/443 + SSH), `fail2ban`, mises à jour auto.
3. Domaine + DNS + **TLS** (Caddy ou nginx + Let's Encrypt) devant Kong.
4. **Fermer le gap de reproductibilité** (§7.4.8) : t'assurer que le schéma dumpé contient bien
   les fixes appliqués à la main en prod (index dedup, circuit-breaker, admin grouping…). Le dump
   les capture puisqu'ils sont *dans* la DB — mais vérifie via `05-verify-parity.sh`.

### Phase 1 — Stack self-host (PostgreSQL 17)
5. `cp .env.hetzner.example .env` et remplir **tous** les secrets. Réutiliser le `JWT_SECRET` +
   `ANON_KEY`/`SERVICE_ROLE_KEY` du projet managé ; générer les **deux nouveaux** secrets PG17 :
   `PG_META_CRYPTO_KEY` (`openssl rand -hex 16`) et `SECRET_KEY_BASE` (`openssl rand -base64 64 | tr -d '\n'`).
6. Créer les dossiers d'état hors repo : `sudo mkdir -p /var/lib/norva/db /var/lib/norva/storage`.
7. Bring-up **db d'abord**, vérifier qu'il devient healthy (le bootstrap crée `supabase_admin`,
   les rôles, `pg_cron`/`pg_net`/`pgsodium`), puis le reste :
   ```
   docker compose --env-file .env -f docker-compose.supabase.yml up -d db
   docker compose --env-file .env -f docker-compose.supabase.yml ps   # db = healthy
   docker compose --env-file .env -f docker-compose.supabase.yml up -d
   ```
   Le tuning 64 Go est déjà appliqué (overrides `-c` dans le compose ; `config_file` reste celui
   de l'image supabase/postgres, qui préchargent les extensions). Pas de montage de conf séparé.

### Phase 2 — Migrer la DB (fenêtre de maintenance)
8. **Freeze les imports** (désactiver les crons de sync côté managé, ou mettre les sources en pause).
9. `scripts/01-dump-prod.sh` — dump globals (rôles + GUC) + schéma + data depuis le managé.
10. `scripts/02-restore-hetzner.sh` — restore dans la stack self-host, dans le bon ordre
    (extensions → globals → schéma → data).
11. `psql -f scripts/03-recreate-cron-guc.sql` — recréer les GUC `app.norva_*`, **ré-injecter les 3
    secrets vault** (édite le fichier avec les vraies valeurs, ne commit jamais les valeurs), et
    **réécrire+recréer les 47 crons** vers l'endpoint self-host.

### Phase 3 — App + edge + storage
12. `scripts/04-deploy-edge-functions.sh` — déployer les 19 fonctions sur l'edge-runtime self-host.
13. Migrer les buckets Storage (rsync/`supabase storage` ou re-générables).
14. **Repointer l'app** : base URL + clés dans `public/js/cloudApi.js` (et webhooks Stancer/billing).
    Le **gateway média (Railway)** et le **relay (Cloudflare)** restent externes → juste repointer URLs/secrets.

### Phase 4 — Vérifier + basculer
15. `scripts/05-verify-parity.sh` — parité counts / extensions / crons / RLS / GUC entre managé et self-host.
16. Bascule DNS. Surveiller. **Garder le projet managé en lecture seule quelques jours** (rollback rapide).

### Phase 5 — Ops (le vrai coût continu)
17. **Backups** : pgBackRest ou WAL-G → **offsite** (R2/S3/Storage Box), **PITR testé régulièrement**.
18. **Monitoring** : Netdata ou Prometheus+Grafana (disque, RAM, connexions, réplication, lag).
19. **Pooler** : PgBouncer transaction-mode devant Postgres (voir `postgres/pgbouncer.ini.example`) —
    prérequis dès qu'on dépasse quelques centaines de users.
20. **HA (milliers d'users)** : 2ᵉ box replica streaming + auto-promotion (Patroni/etcd), poolers
    redondants derrière VIP. Cf. §7.5.

---

## Garde-fous

- **Rien ici ne s'exécute automatiquement.** Chaque script attend des variables d'env explicites
  (hosts, mots de passe) et refuse de tourner sans.
- **Ne commit jamais de secret réel.** `.env.hetzner.example` et `03-recreate-cron-guc.sql`
  contiennent des **placeholders** — les valeurs vivent hors du repo.
- **Dry-run d'abord.** Teste le cycle dump→restore→verify sur un box jetable avant le vrai basculement.
- **Le dedup couche B et le pooler sont des prérequis au sizing sublinéaire** (§7.4) — active-les et
  valide-les sur données réelles *avant* d'acheter le gros box.
