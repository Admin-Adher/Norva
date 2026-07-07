# Norva — Scaling, coût & migration Hetzner (plan détaillé)

> Réponse chiffrée à : « 10/50/100 users qui importent, ça casse ? quelle compute ? peut-on
> externaliser (Hetzner) pour casser le coût Supabase ? » — basé sur la **conso réelle mesurée**
> en prod le 2026-07-07 (projet `oupsceccxsonaalhueff`), pas de la théorie.

---

## 0. TL;DR — les décisions

| Chantier | Quoi | Quand | Coût |
|---|---|---|---|
| **Dedup couche B** | ÷2-3 le stockage à l'échelle (découple le coût du nb de users) | À activer avant ~50 users | 0 € (déjà construit) |
| **Import throttling load-aware** | Empêche 3 imports simultanés de casser le service | **Maintenant** | 0 € (dev) |
| **Read-replica** | Browsing → replica, écritures → primary | Si on **reste** Supabase | ~+1 compute |
| **Crawl audio 2-phases** | Matchés/browsables d'abord dans le budget anti-ban | Quand DB calme | 0 € (dev) |
| **Hetzner self-host** | ~€60/mois vs $400-1000/mois managé | À ~100 users **OU maintenant si tu assumes l'ops** | €54-80/mois + ton temps |

⚠️ **Read-replica et Hetzner sont exclusifs** : l'un = rester sur Supabase managé ; l'autre = tout self-héberger.

---

## 1. Baseline mesurée (2026-07-07, 3 users réels)

- **Instance** : Small compute — **~2 Go RAM** (`shared_buffers` 512 Mo, `effective_cache_size` 1,5 Go), `max_parallel_workers = 2`.
- **Data** : **5,16 Go**. `cloud_media_items` 1,9 Go (1,15 M lignes, **~1,7 Ko/ligne**), `cloud_titles` 947 Mo, `cloud_title_variants` 888 Mo, `cloud_live_*` 813 Mo.
- **Unité de coût mesurée : ~390 Mo par 100k items de catalogue** (media + titres + variantes ; live en plus).
- **Le bottleneck, prouvé** : tables chaudes **2,9 Go > cache RAM 1,5 Go** → Postgres lit en continu sur **disque** (`DataFileRead`) → tous les timeouts observés (dashboards, genre-rails, même un `count`). **Avec seulement 3 users et 1-2 imports.**

**Conclusion baseline** : l'instance actuelle est **IO-bound par manque de RAM**. C'est LA cause, pas des bugs (échecs crons : ~250/24h pendant l'import → 5/30min une fois l'import fini).

---

## 2. Modèle de sizing (10 / 50 / 100 users)

**Hypothèse** : panel IPTV moyen ≈ 100-150k items ≈ **~0,4-0,6 Go/user-provider** (sans dedup). À l'échelle, les users se regroupent sur **~10-15 panels populaires** (pas N uniques) → le catalogue global est mutualisable.

### Stockage
| Users | Sans dedup `O(users×catalogue)` | Avec dedup couche B (providers partagés) |
|---|---|---|
| 10 | ~5-6 Go | ~6 Go *(dedup ~inutile à faible recoupement)* |
| 50 | **~20 Go** | **~12 Go** |
| 100 | **~40 Go** | **~18 Go** *(÷2,2)* |

→ Le dedup **ne sert quasi rien à 10 users** (peu de recoupement) mais **devient vital à 50-100**. C'est pourquoi il est gaté sur `catalog_flip_readiness` (overlap ≥ 3).

### RAM / compute (la RAM doit contenir le working set chaud = index + catalogue partagé actif)
| Users | DB (dedup on) | RAM à viser | Palier Supabase (~/mois, 2026, à revérifier) |
|---|---|---|---|
| 10 | ~6 Go | **4-8 Go** | Medium (4GB) ~$60 → Large (8GB) ~$110 |
| 50 | ~12 Go | **8-16 Go** | Large ~$110 → XL (16GB) ~$210 |
| 100 | ~18 Go | **16-32 Go** | XL ~$210 → 2XL (32GB) ~$410 |

+ stockage (~$0,125/Go > 8 Go) + egress. **À 100 users ≈ $400-700/mois** managé.

> ⚠️ La RAM réelle dépend surtout de la **concurrence** (imports + browsing simultanés), pas du stockage brut. Le throttling import + read-replica **réduisent** la compute nécessaire.

---

## 3. Coût : Supabase managé vs Hetzner self-host

| | Supabase managé | Hetzner self-host (stack Supabase OSS) |
|---|---|---|
| 10-50 users | Pro $25 + compute $60-110 = **~$85-135/mois** | AX52 (64 Go, 2×1TB NVMe) **~€54/mois** OU CCX23 (16 Go) ~€40 |
| 100 users | ~**$400-700/mois** | même box ~€54-80/mois |
| Ops (backups, HA, sécu, patchs, monitoring) | ✅ inclus/géré | ❌ **à ta charge** |
| Edge functions, auth, realtime, RLS, pg_cron | ✅ managé, mûr | ⚠️ self-host (edge-runtime moins mûr) |
| RGPD / souveraineté | US par défaut (EU en option payante) | ✅ EU natif |

**Le calcul honnête** : à 10-50 users, l'écart managé↔Hetzner est ~$50-100/mois — **modeste**. Le gros écart apparaît à **100+ users** ($400-700 → €60). Donc l'externalisation se **rentabilise à l'échelle**, pas à 10 users.

---

## 4. Les 5 chantiers en détail

### 4.1 Dedup couche B — le levier coût (déjà construit, dormant)
- Runbook complet : [`phase2-dedup-activation-runbook.md`](./phase2-dedup-activation-runbook.md).
- 5 leviers : backfill → GUC `app.norva_catalog_dual_write='1'` → verify (`catalog_media_mirror_diff` / route `/catalog-media-mirror-verify`) → flip lecture (`NORVA_CATALOG_MEDIA_READ_SOURCE`) → thin.
- **Gaté sur le recoupement multi-user** (`catalog_flip_readiness` overlap ≥ 3.0). La commercialisation crée ce recoupement → activer **quand plusieurs users partagent des panels**.
- Effet : per-user media 19 Mo → 6 Mo + 1 copie globale partagée (÷~3 asymptotique).

### 4.2 Import throttling load-aware — À FAIRE MAINTENANT (gratuit)
Aujourd'hui `admitHeavyImport` = max 3 imports xtream lourds concurrents (les autres font la queue). Mais **2-3 concurrents saturent déjà** la petite compute. Améliorations (edge `norva-source-sync`) :
- **Baisser la concurrence** à 2 (ou 1 sur petite compute).
- **Finalize conscient de la charge** : lots plus petits, pause si la charge de lecture (ou `pg_stat_activity` actif) dépasse un seuil — même mécanisme que la pause facet-refresh qu'on a utilisée.
- **Off-peak** : reléguer le finalize lourd aux heures creuses.
- Fichiers : `admitHeavyImport` (~norva-source-sync:1157), finalize batch loop.

### 4.3 Read-replica (si on RESTE Supabase — exclusif avec Hetzner)
- Feature Supabase Pro : une réplica en lecture. Router les SELECT (browsing/grids) → replica, les écritures (import/sync) → primary.
- Effet : un gros import ne timeout plus les lecteurs (charges séparées).
- Coût : ~une compute de plus (mais chacune peut être plus petite).
- Côté app : un 2ᵉ client PostgREST/edge pointant la replica pour les lectures catalogue.

### 4.4 Crawl audio deux-phases (dev restant, ban-sensible)
- **Pourquoi pas un simple `ORDER BY`** : le crawl avance par **curseur `id`** (progression garantie + anti-blocage — un titre qui échoue toujours ne pose jamais `audio_probed_at`, le curseur passe au-delà). Trier par pertinence sans curseur → un titre populaire mais mort bloque le budget 40/h en tête.
- **Design sûr** : curseur à **2 phases** — Phase 1 = `provider_tmdb_id is not null` (matchés/browsables) par curseur id ; Phase 2 = longue traîne. Champ `phase` dans l'état du crawl.
- À faire **hors charge d'import** (ban-sensible). Détails : `docs/roadmap/2026-07-07-playback-scaling-session.md` §Crawl.

### 4.5 Migration Hetzner (self-host stack Supabase OSS) — LE PLAN
> Puisque tu veux y aller : voici ce que ça implique **réellement**, étape par étape.

**Cible** : Hetzner dédié **AX52** (Ryzen 7, 64 Go RAM, 2×1TB NVMe RAID1, ~€54/mois) ou cloud **CCX33** (32 Go, ~€65/mois). EU (Falkenstein/Helsinki).

**La stack Supabase OSS** (docker-compose, `github.com/supabase/supabase/docker`) : Postgres + GoTrue (auth) + PostgREST + Realtime + Storage + Kong (gateway) + **edge-runtime (Deno)** + Studio + pg_meta. Extensions : pg_cron, pgvault, pg_net, pg_trgm, etc.

**Étapes** :
1. **Serveur** : provisionner, Ubuntu LTS, Docker+compose, firewall (ufw), fail2ban, domaine + DNS, **TLS** (Caddy/nginx + Let's Encrypt), RAID1/NVMe.
2. **Déployer la stack** : cloner le docker-compose Supabase, générer les secrets (**JWT secret, DB password, anon/service keys, SMTP**), configurer les URLs. Vérifier les extensions requises (pg_cron, vault, net, trgm) présentes dans l'image Postgres.
3. **Migrer la DB** : `pg_dump` (schéma + data + RLS + fonctions + triggers) depuis Supabase → restore sur Hetzner. **Attention** : les jobs `pg_cron` (recréer via `cron.schedule`), les **secrets `vault`** (à ré-injecter), les extensions, les rôles (`authenticator`, `anon`, `authenticated`, `service_role`), les GUC de rôle (ex. `app.norva_catalog_dual_write`).
4. **Migrer le Storage** : les buckets (storyboards, sous-titres générés…) → storage self-host (local ou S3/R2 compatible). Repointer les URLs.
5. **Migrer les Edge Functions** : les ~19 fonctions `norva-*` → déployées sur l'**edge-runtime self-host** (Deno). Adapter le CI (`deploy-supabase-functions.yml` cible aujourd'hui le projet managé → cibler le runtime Hetzner). ⚠️ Le gateway média (Railway) et le relay (Cloudflare) restent externes — juste repointer les URLs/secrets.
6. **Repointer l'app** : `cloudApi.js` base URL + clés → endpoint Hetzner. Les webhooks (Stancer/billing) → nouveaux endpoints.
7. **Ops (le vrai coût)** :
   - **Backups** : `pg_dump` automatisé + WAL archiving → offsite (R2/S3). Tester la **restauration** (un backup non testé = pas de backup).
   - **Monitoring** : Netdata/Grafana+Prometheus, alertes (disque, RAM, connexions, réplication).
   - **HA** : une seule box = **pas de failover**. Pour de la HA → 2ᵉ box + réplication streaming + failover (Patroni) — complexe. Sinon, accepter un RTO de restauration.
   - **Sécurité** : firewall strict, pas de Postgres exposé publiquement, updates réguliers, rotation des secrets.
   - **Upgrades** : Postgres majeur + stack Supabase = migrations à gérer toi-même.

**Timeline réaliste** : **1-2 semaines** pour une migration soignée + hardening (si tu maîtrises Docker/Linux/Postgres ops). Plus si apprentissage.

**Risques** : perte de données (backups fragiles), downtime (single box), exposition sécu (mauvaise conf), edge-runtime self-host moins mûr que managé.

---

## 5. Recommandation phasée (avis d'ingénieur honnête)

1. **Maintenant** :
   - ✅ **Import throttling load-aware** (gratuit, protège le service) — je peux le coder.
   - ✅ **Monter la compute Supabase à Medium** (le levier immédiat contre les timeouts observés) — 1 slider.
   - ✅ **Crawl 2-phases** (quand la DB est calme).
2. **Avant ~50 users** : **activer le dedup couche B** (découple le coût du nb de users).
3. **~50 users, si tu restes managé** : **read-replica** (séparer lecture/import).
4. **~100 users OU quand la facture pique** : **migrer Hetzner** (le plan §4.5). À cette échelle, $400-700 → €60/mois **justifie** l'ops.

**Le point d'honnêteté sur « Hetzner dès maintenant »** : c'est **faisable** (plan ci-dessus), mais pour un solo dev **pré-commercialisation**, ça veut dire **1-2 semaines d'infra + de l'ops permanente** (backups, HA, sécu, patchs) au lieu de produit, pour économiser **~$50-100/mois** à faible échelle. Le **gros** gain est à 100+ users. **Le dedup + une compute Medium bien dimensionnée te portent jusqu'à ~50 users pour ~$85-135/mois**, sans ops. → Mon conseil : **prépare la portabilité maintenant** (tu utilises du Postgres standard + les APIs Supabase, donc c'est faisable), **mais migre Hetzner quand le volume le justifie**, pas avant. Si tu tiens quand même à y aller now (souveraineté, contrôle, tu aimes l'ops), le plan §4.5 est complet et je peux t'accompagner étape par étape.

---

## 6. Ce que je peux faire, moi (code) vs toi (infra)
- **Moi (code, dans le repo)** : import throttling load-aware, crawl 2-phases, activation dedup (SQL/flags), adapter le CI pour cibler un endpoint self-host, scripts de migration (`pg_dump`/restore, recréation des crons/vault).
- **Toi (infra, hors repo)** : provisionner Hetzner, DNS/TLS, secrets, ops (backups/monitoring/HA), le slider compute Supabase, activer le read-replica.

Dis-moi l'ordre dans lequel tu veux attaquer.

---

## 7. Scaler jusqu'à des **milliers d'users** — quel CPU / quelle box Hetzner ?

> Réponse à : « quel est le top du CPU et les autres stats Hetzner pour scaler sans problème
> jusqu'à des milliers d'user ? ». Chiffré à partir de la baseline mesurée + recherche du
> catalogue Hetzner 2026 + analyse d'archi, avec **contre-vérification adverse** (les 3 analyses
> se sont mutuellement corrigées ; les corrections sont dans §7.4, à lire).

### 7.1 Réponse directe — le CPU « top »

- **Le CPU le plus haut du catalogue Hetzner robot pour un Postgres self-host = AMD EPYC 9454P (48c/96t, Zen4, 12 canaux DDR5)**, sur la box **AX162-S**. C'est le plafond à *nommer*.
- **MAIS pour le problème réel de Norva (timeouts `DataFileRead`), l'EPYC est sur-dimensionné pour la DB seule.** Le bottleneck est **bande passante mémoire / cache RAM**, PAS le cache L3. Donc :
  - Le **7950X3D** (AX102) et son gros V-cache 128 Mo est **overstated** : il ne cache que ~0,1 % d'un hot set de 15-115 Go. Ses **2 canaux DDR5** sont le vrai plafond.
  - **EPYC 9454P (12 canaux)** ou **Xeon Gold 6731P / EX131 (8 canaux, ECC registered)** donnent la **bande passante mémoire** qui sert réellement le working set chaud. → pour ce workload *read-bound*, EPYC/Xeon > desktop 7950X3D.

### 7.2 La box à viser (DB primary)

| Choix | Box | CPU | RAM | Disque | ~€/mois net (2026) | Couvre |
|---|---|---|---|---|---|---|
| **Recommandé scale** | **AX162-S** | EPYC 9454P 48c/96t, 12 canaux | **256 Go** DDR5 ECC reg | 2×3,84 To NVMe DC **RAID1** | ~702 + upgrade RAM | milliers d'users dédupés |
| **Alt ECC registered** | **EX131** | Xeon Gold 6731P 32c, 8 canaux | 128→**256 Go** ECC reg | 2×1,92→4×7,68 To NVMe | ~639 | 1k-3k |
| **Pragmatique (suffit vraiment)** | **AX102** | 7950X3D 16c/32t | 128 Go ECC | 2×1,92 To NVMe RAID1 | ~519 | **1k-10k users dédupés** pour le pb timeout |
| **Guérir les timeouts aujourd'hui** | AX42 / Serverbörse | Ryzen 7 / Xeon 64 Go | 64 Go | 2×NVMe | ~67-216 | échelle actuelle |

**⚠️ Ne PAS acheter 512 Go de RAM.** Le hot set **dédupé** ne fait que **~15-115 Go** → 128 Go est le *sweet spot*, 256 Go la marge. 512 Go ne serait jamais utilisé (et le DRAM 2026 est cher). *Cette correction annule la reco « 256-512 Go » de la première passe.*

**Stats non-négociables** (c'est pour ça que « la box » n'est pas *une* box) :
- **NVMe DC-Edition** (endurance, imports write-heavy) — jamais SATA/HDD (workload random-read).
- **ECC** (AX102+ / EX63+), **mdadm RAID1** (ou RAID10 à 4 disques) — jamais RAID0.
- Vérifier **Serverbörse / Server Radar** : une box 128-256 Go ECC NVMe reconditionnée = **-30 à -50 %** vs liste.

### 7.3 Sizing corrigé 1k / 5k / 10k users (dedup **activé**)

| Métrique | 1 000 | 5 000 | 10 000 |
|---|---|---|---|
| DB **sans** dedup | ~500 Go *(voie sans issue)* | ~2,5 To *(non-starter)* | ~5 To *(à ne pas faire)* |
| DB **avec** dedup (+ overlay live/EPG corrigé) | ~35-60 Go | ~90-160 Go | ~150-320 Go |
| Hot working set (catalogue partagé + index chauds) | ~15-25 Go | ~20-35 Go | ~25-45 Go |
| **RAM à viser** | **64 Go** | **128 Go** | **128 Go** (256 si live élevé) |
| Cores/threads | 8c/16t (AX52) | 16c/32t (AX102) | 32-48t (AX102 ou EPYC/Xeon pour burst imports) |
| Postgres **real backends** (`max_connections`) | ~100-150 | ~200 | ~300 (**jamais 10k**) |
| Pooler (Supavisor/PgBouncer txn) | pool ~25, max_client ~2k | pool ~40, max_client ~10k | pool ~50-64, max_client 10k+ |
| Heavy imports concurrents (`admitHeavyImport`) | 3-4 | 6-8 | 8-12 (~1 / 3-4 cores) |

→ **La RAM n'a besoin de monter à 512 Go nulle part.** Le hot set dédupé est borné par ~10-25 panels. **Le stockage est un problème résolu** dès que le dedup est ON à chaque palier.

### 7.4 Corrections honnêtes (le premier chiffrage était trop optimiste)

1. **« Une box » est la mauvaise unité à des milliers d'users.** Un seul gros box (AX102/EX131/AX162 + pooler) est un **primary viable** pour les *low-thousands* et **guérit bien les timeouts `DataFileRead`** (une fois le dedup ON, le hot set devient O(panels) et rentre en RAM). Mais **« milliers d'users sans timeout » est intrinsèquement multi-nœuds.**
2. **Pooler (Supavisor/PgBouncer, transaction mode) = prérequis, pas option.** Sans lui, le box **meurt à 300-500 connexions directes**, quel que soit le CPU. Des milliers d'users applicatifs **ne doivent jamais** devenir des milliers de backends Postgres.
3. **Le dedup couche B est DORMANT — c'est LA dépendance critique.** Le ÷3 est **mesuré** ; le ÷20-45 est une **extrapolation** qui ne tient QUE si (a) couche B est activée, (b) les users se regroupent vraiment sur 10-20 panels, (c) l'overlay/user reste petit. **À valider sur données réelles AVANT d'acheter du matériel.**
4. **Le vrai mur à des milliers de viewers = le gateway média/transcode, PAS Postgres.** ~5 Gbps d'egress par 1 000 viewers concurrents ; transcode HEVC→h264 CPU/GPU-lourd. → **flotte GPU/NVENC séparée**, autoscalée, **hors du box DB**, derrière le relay Cloudflare. Préférer relay/remux au transcode dès que browser-safe. **C'est là que va l'argent**, pas dans le CPU DB. Budgéter **5-25+ Gbps** d'egress explicitement (Railway pas rentable à ce niveau).
5. **Read replica** : router les SELECT (grids/rails/dashboards) → replica, écritures/imports → primary, pour qu'un gros `building_titles`/TMDB-match **ne timeoute jamais** un viewer.
6. **Live/EPG sous-estimé** : `cloud_live_*` = 0,81 Go à 3 users (~270 Mo/user aujourd'hui) et l'unité mesurée **exclut** le live. → mes tailles DB corrigées sont **1,5-3×** le premier chiffrage. **À instrumenter** avant de croire l'overlay 10 Mo/user.
7. **HA** : un seul box = **zéro failover** = inacceptable pour des milliers d'users payants. Requiert primary + streaming replica + auto-promotion (Patroni/etcd ou repmgr) + IP flottante + poolers redondants + **WAL archiving offsite (pgBackRest/WAL-G) avec un PITR restore RÉGULIÈREMENT TESTÉ**.
8. **Blocker HA — le gap de reproductibilité** : plusieurs fixes prod (index, circuit-breaker, soft-delete, admin grouping) ont été **appliqués à la main, jamais captés en migration**. Un failover vers une replica qui ne les a pas **reproduit l'outage**. → **À fermer avant toute HA** (voir §7.5 et `2026-07-07-playback-scaling-session.md`).

### 7.5 Architecture cible « milliers d'users » (multi-nœuds)

```
                    ┌─────────────────────────────────────────┐
   users (10k+) ──▶ │  LB / Kong / Caddy  (TLS, N+1)           │
                    └───────────────┬─────────────────────────┘
                        ┌───────────┼───────────────┐
                        ▼           ▼               ▼
                  app/edge     Realtime WS     GPU transcode fleet
                  (PostgREST,   (nœuds          (NVENC, autoscale,
                   GoTrue,       dédiés)          egress 5-25 Gbps)
                   edge-runtime)     │                 │  ← LE vrai mur
                        │            │            relay Cloudflare (externe)
                        ▼            ▼
               ┌─────────────────────────────┐
               │ Supavisor / PgBouncer (txn)  │  ← prérequis, 2+ derrière VIP
               │  ~50-200 real backends       │
               └──────┬───────────────┬───────┘
             writes/  │               │  reads (grids, rails, dashboards)
             imports  ▼               ▼
              ┌─────────────┐   ┌──────────────┐
              │  PRIMARY DB  │──▶│ READ REPLICA │   streaming + auto-failover
              │ EPYC/Xeon    │   │ (2ᵉ box)     │   (Patroni/etcd), IP flottante
              │ 128-256 Go   │   └──────────────┘
              └──────┬───────┘
                     ▼  WAL archiving continu (pgBackRest/WAL-G) → R2/S3 offsite
                  PITR testé régulièrement
```

**À budgéter réellement** : primary + replica (2 gros box) + paire de poolers + nœuds app/edge + **flotte GPU transcode** dimensionnée au **pic de viewers concurrents**, pas au nb d'users. Le CPU de la DB n'est PAS ce que « scaler à des milliers » coûte vraiment.

### 7.6 Ordre d'exécution recommandé pour cette cible

1. **Fermer le gap de reproductibilité** (formaliser en migrations les fixes prod appliqués à la main) — bloque toute HA.
2. **Activer + valider le dedup couche B** sur données réelles (mesurer clustering panel + overlay incluant live/EPG) — bloque tout le sizing sublinéaire.
3. **Mettre un pooler** (Supavisor/PgBouncer txn) devant tout — prérequis connexions.
4. **Migrer le primary sur Hetzner** (scripts §8 / `ops/hetzner/`), box AX102 d'abord (couvre 1k-10k dédupés), passer EPYC/Xeon EX131/AX162 pour burst-imports + 256 Go + ECC registered.
5. **Ajouter la read replica** (séparer lecture/import).
6. **Sortir la flotte transcode** (GPU/NVENC autoscale) — le vrai mur des viewers concurrents.
7. **HA** (auto-failover primary→replica, poolers redondants, PITR testé).

---

## 8. Scripts de migration Hetzner (le code)

Les scripts de migration self-host sont dans **[`ops/hetzner/`](../../ops/hetzner/)** (préparés, pas exécutés — l'infra reste ton domaine). Voir [`ops/hetzner/README.md`](../../ops/hetzner/README.md) pour le runbook pas-à-pas. Contenu :

- `README.md` — runbook complet (partitionnement disque SSD=DB / HDD=backups+storage, ordre d'exécution, parité post-migration).
- `.env.hetzner.example` — template des secrets de la stack self-host.
- `docker-compose.supabase.yml` — stack Supabase OSS (Postgres + GoTrue + PostgREST + Realtime + Storage + Kong + edge-runtime + Studio + pg_meta).
- `postgres/postgresql.tuning.conf` — tuning Postgres par palier (grounded sur la baseline mesurée + le sizing §7).
- `postgres/pgbouncer.ini.example` — pooler transaction-mode (prérequis §7.4).
- `scripts/01-dump-prod.sh` — dump depuis Supabase managé (rôles + schéma + data ; note vault/cron).
- `scripts/02-restore-hetzner.sh` — restore dans la stack self-host.
- `scripts/03-recreate-cron-guc.sql` — recréer les GUC (`app.norva_*`), vérifier les 47 crons, ré-injecter les 3 secrets vault.
- `scripts/04-deploy-edge-functions.sh` — déployer les 19 fonctions `norva-*` sur l'edge-runtime self-host.
- `scripts/05-verify-parity.sh` — parité post-migration (counts, extensions, crons, RLS).

> État prod au moment de la rédaction (2026-07-07, `oupsceccxsonaalhueff`) : DB **5,15 Go**, extensions `pg_cron 1.6.4 / pg_net 0.20.3 / supabase_vault 0.3.1 / pg_trgm / pgcrypto / http / unaccent / uuid-ossp / pgstattuple / pg_stat_statements`, **47 crons (46 actifs)**, **3 secrets vault**. Les scripts sont grounded sur cet inventaire.

---

## 9. Railway (gateway média) : garder / upgrader / remplacer ? + path box réel

> Réponse à : « AX42→AX102→AX162 ? Railway ça remplace ou pas ? j'upgrade Railway ou je remplace
> par Hetzner ? » — basé sur l'**analyse du flux média dans le code** (citations file:function) + prix
> **réels** Railway/Hetzner 2026.

### 9.1 La découverte qui change tout : où passent réellement les octets vidéo

**Deux étages distincts** : `ops/hetzner` remplace **Supabase (la DB)**, **PAS Railway (le gateway média/transcode)**. Et surtout, l'egress n'est le coût de Norva **que pour les viewers navigateur** :

| Mode (`api.js:1494-1501`) | Octets via infra Norva ? | Quand | Qui paie l'egress |
|---|---|---|---|
| **direct** | **NON** — l'edge renvoie l'URL provider brute (`norva-playback:319-334`) | Apps natives (Android TV / NorvaTVCloud / desktop) | **Provider — 0 € pour Norva** |
| **relay** | OUI, **full** via Cloudflare (`norva-relay:565-597`) | VOD browser-safe mp4/H.264/AAC (défaut web VOD propre) | **Norva via Cloudflare — bande passante quasi non-facturée (cheap)** |
| **engine** | OUI, full via **Railway `/raw`** mais **0 CPU** (`media-gateway:556-641`) | VOD HEVC/MKV/AC3, transcode WASM côté client | **Norva via Railway — egress mesuré ~$0.05-0.10/Go, pas de CPU** |
| **transcode** | OUI, full via **Railway FFmpeg** + CPU (`media-gateway:2281-2379`) | **LIVE browser (défaut)** + VOD exotique (avi/wmv/flv/vob) | **Norva via Railway — egress mesuré + CPU (le plus cher)** |

- **Apps natives = direct = 0 € d'egress** (comportement type TiviMate). Le browser **jamais direct** (UA-gate + CORS + block datacenter).
- **VOD propre browser → Cloudflare relay = quasi gratuit.** **HEVC/MKV VOD → Railway raw (egress mesuré, pas de CPU).** **LIVE browser → Railway FFmpeg (egress + CPU = le vrai centre de coût).**
- → **L'exposition egress dépend de : part-navigateur × mix-codec, et dans le navigateur, surtout du LIVE.** Beaucoup de natif/VOD → facture Railway faible. Beaucoup de live-navigateur → facture Railway qui explose.

### 9.2 Le coût Railway à l'échelle (et pourquoi upgrader le plan ne sert à rien)

Railway 2026 : egress **$0.05/Go** (Metal) à **$0.10/Go**, **aucun quota gratuit**, **pas de GPU** (transcode software = vCPU cher). Modèle (1 viewer HD 4 Mbps = 1,8 Go/h, 4h/j) **pour la part transcodée** :

| Concurrent (transcodé) | TB/mois | **Railway egress $/mois** | Sur Hetzner (flat) |
|---|---|---|---|
| 500 | 108 | **~$5 400** | ~2-3 box AX flat + 1 GEX44 |
| 2 000 | 432 | **~$21 600** | ~8-10 box AX + fleet GEX44 |
| 5 000 | 1 080 | **~$54 000** | ~20-25 box AX / CDN + GEX44 |

⚠️ **Ne PAS upgrader le plan Railway** (Hobby $5 → Pro $20/siège) : ça change les plafonds et le crédit inclus, **pas le tarif $/Go d'egress**. Ça ne fait que repousser la douleur.

### 9.3 Hetzner pour le média : flat, ~100-200× moins cher, mais capé à 1 Gbit/s par box

- **Trafic AX = illimité/flat à 1 Gbit/s, 0 €/Go.** Une box saturée = ~**324 To/mois pour 0 €** de trafic.
- **MAIS 1 Gbit/s cape UNE box à ~200-250 viewers HD.** → fleet horizontale : 500 → 2-3 box · 2 000 → 8-10 · 5 000 → 20-25 (ou **CDN devant** un origin Hetzner).
- **Transcode = GEX44** (RTX 4000 SFF Ada, **NVENC/NVDEC HW HEVC→h264**, ~€184/mo, **~20-40 transcodes 1080p temps-réel/GPU**, pas de cap de sessions). Scaler le transcode = ajouter des GEX44 ; scaler l'egress = ajouter des AX flat / CDN.
- Egress : Railway 500 To ≈ **$25 000/mo** vs Hetzner **~€120-200 flat** + GEX44. **~100-200× d'écart.**

### 9.4 ⚠️ Correction prix AX162 (capture)

Les prix capture **AX41 €59 / AX42 €99 / AX102 €259 collent** au configurateur (juin 2026). **MAIS `AX162 €319` = le SKU LIMITÉ (`AX162-1-LTD`)** ; le **standard AX162-1 = ~€612/mo** (+€304 setup). La ligne mélange le mensuel LTD et le setup standard. → si tu prévois l'AX162, **table sur ~€612/mo** (ou attrape le LTD tant qu'il est dispo).

### 9.5 Recommandations (décisives)

**Q1 — Path box DB** : `AX42→AX102→AX162` est *directionnellement* juste mais **front-loaded**. Pour un Postgres 5 Go IO-bound, **même AX42 (64 Go) est déjà énorme**. Le saut qui compte = **AX102** (ECC 128 Go + NVMe DC — l'ECC compte pour une DB ; l'AX42 non-ECC est le maillon faible).
→ **Puisque tu scales vite et veux éviter une re-migration : DÉMARRE direct en AX102** (€259/mo). AX42 = interim budget seulement. **Saute l'AX162 pour la DB** (48 cœurs EPYC = overkill DB, et le vrai prix ≈ €612). Le 1 Gbit/s de la box DB est large pour du SQL.

**Q2 — Railway** :
1. **Hetzner-DB ≠ remplacer Railway** (étages différents). **N'upgrade pas** le plan Railway.
2. **Garde Railway maintenant** (concurrence triviale = cheap/pratique).
3. **AVANT la poussée marketing : sors le transcode de Railway → GEX44 (GPU/NVENC) + fais transiter TOUT l'egress viewer par le CDN/relay Cloudflare** que tu as déjà, pour que l'origin mesuré ne serve que le cache-fill, pas chaque viewer.
4. **Le levier gratuit issu du code** : pousse un max de lecture vers **Cloudflare relay (non-mesuré)** et **apps natives (direct = 0 €)** ; active l'opt-in `norva-live-hls-relay` là où les providers l'autorisent ; réserve Railway/GEX44 FFmpeg au minorité **HEVC-live** inévitable.

### 9.6 Coût infra mensuel indicatif

| Users | DB | Média | Total infra |
|---|---|---|---|
| ~100 | AX102 €259 (ou reste Supabase Medium interim) | Railway (cheap) + Cloudflare | **~€260-350** |
| ~1 000 | AX102 €259 + pooler | GEX44 €184 + Cloudflare relay (+1-2 AX egress) | **~€500-750** |
| ~5 000 | AX102/AX162 + replica | fleet GEX44 (dimensionné au live concurrent) + CDN Cloudflare | **~€1-2k** (vs Railway seul $54k/mo d'egress) |

### 9.7 Checklist « prêt pour scaler vite sans re-migration »

1. **DB : démarre AX102** (ECC, NVMe DC) — buy-once, pas de re-migration précoce. **PgBouncer/Supavisor dès J1.**
2. **Active + valide le dedup couche B** avant la poussée (÷3 stockage, borne le hot set).
3. **Média : bascule le transcode sur GEX44 + route l'egress via Cloudflare** avant le marketing ; active relay-hls où possible ; pousse l'usage apps natives (direct = gratuit).
4. **Ne bump PAS Railway** (ne corrige pas l'egress) — interim seulement.
5. **Backups pgBackRest PITR testé + monitoring**, puis **replica/HA** aux milliers.
6. **Table sur ~€612 pour l'AX162** (le €319 est le LTD promo).

### 9.8 Précisions de la synthèse (cross-check adverse des 3 analyses)

- **Points de bascule Railway précis** (par *viewers navigateur concurrents sur le chemin métré* transcode/raw-pipe) :
  - **< ~50** (ou < ~2-5 To/mois egress métré) → **garde Railway tel quel** (pratique, pas cher).
  - **~50-200** (ou dès que la facture egress Railway dépasse le prix d'un GEX44 ~€184) → **provisionne la flotte Hetzner (GEX44) + fan-out Cloudflare**. **C'est ta fenêtre « avant le push ».**
  - **> ~200** → **Railway hors du chemin critique** (tout l'egress viewer via Cloudflare, origine Hetzner ; Railway en fallback/overflow seulement).
  - Tu scales vite → tu franchis ces seuils vite : **construis la flotte média AVANT le marketing, ne l'attends pas.**
- **Le CDN dissout le mur 1 Gbit/s.** « 1 box = ~200 viewers » n'est vrai qu'en *direct-serve*. Avec **Cloudflare devant**, l'origine ne sert que le **cache-fill + les flux uniques** → **petite flotte origine (1-2 AX41) + CDN sert des milliers**, pas 20-25 box.
- **Dimensionne le transcode aux FLUX UNIQUES concurrents, pas aux viewers.** Avec **single-flight/dedup** (1 transcode par flux identique → fan-out CDN), un GEX44 (~20-40 flux 1080p) couvre bien plus que 20-40 viewers. Sans dedup, le coût GPU explose.
- **Les chiffres Railway ($10,8k/$54k) sont des BORNES SUPÉRIEURES pire-cas** (= 100 % transcodé-via-Norva). Le code montre que la réalité = beaucoup de **Cloudflare relay (cheap) / natif direct (gratuit) / raw-pipe (egress sans CPU)** → la tranche métrée réelle est plus proche de **$5-20k/mo à des milliers concurrents** — ce qui **justifie quand même** de sortir de Railway (+ throttle fair-use Railway > ~100 Go/mois).
- **Caveat Cloudflare** : Workers n'a pas de frais/Go, mais streamer des **Po** de vidéo peut heurter les **TOS Cloudflare §2.8** (restriction vidéo/gros fichiers) → possible conversation fair-use ou passage à **Cloudflare Stream (métré)**. Reste radicalement moins cher que Railway, mais pas littéralement gratuit-infini.
- **Télémétrie manquante (à instrumenter) :** part **browser-vs-natif**, **mix codec**, **% qui touche le FFmpeg Railway**, **taille live/EPG**. Sans ça on **vole à l'aveugle** sur le « monde egress » exact — mesure-le pour dimensionner la flotte média juste. (Décision de planification : provisionne l'egress-flat Hetzner+CDN **maintenant** au lieu de parier sur le monde favorable.)
- **Convergence des 3 analyses + repo** : le vrai mur = **média/transcode+egress**, pas Postgres (coût DB quasi-plat €259-900 à tous les paliers). **N'oublie pas les 2 prérequis repo-spécifiques** : **dedup couche B (dormant → active+valide avant d'acheter)** et **gap de reproductibilité (fixes prod à la main → formaliser en migration avant toute HA)**.

---

## 10. Économie unitaire & capacité par palier (« ça tient jusqu'à combien d'users ? »)

> Réponse à : « AX42 + GEX44 ≈ €350/mo, avec ~$4 net/user, ça tient jusqu'à combien d'users, il y a
> un problème ? ». **Prix confirmés (net HT)** : AX42 **€99** + GEX44 **€184** (+€79 setup, inchangé au
> 15 juin 2026) + Cloudflare ~$20-50 ≈ **~€350/mo tout compris**.

### 10.1 Le point clé : le coût est FIXE, pas linéaire

Le €350/mo ne monte **pas** avec le nb d'users (jusqu'à saturation d'un tier). Donc la **marge explose** avec l'échelle. Corollaire : **c'est une config de SCALE, pas de démarrage.**

### 10.2 ⚠️ À 100 users, NE PAS prendre le box dédié

| | Revenus (~$4 net/user) | Coût | Marge |
|---|---|---|---|
| 100 users sur **managé** (Supabase Medium + Railway) | ~$400 | **~$100-150** | correcte, **0 ops** |
| 100 users sur **AX42+GEX44** (€350) | ~$400 | ~$380 | **quasi break-even ❌** |

→ Le box dédié devient rentable **à partir de ~300 users**. En dessous, **reste managé** (moins cher + zéro ops).

### 10.3 Capacité de AX42 + GEX44 — dépend du single-flight

Le mur n'est **pas la DB** (AX42/64 Go tient large avec dedup+pooler) mais le **GEX44 (~20-40 transcodes 1080p)**. Sa capacité en *users inscrits* dépend entièrement du **patch single-flight** :

| | Sans single-flight (code actuel) | Avec single-flight + fan-out CDN |
|---|---|---|
| GEX44 = | ~20-40 viewers **browser-live** concurrents | ~20-40 **chaînes uniques** → milliers de viewers |
| **→ tient jusqu'à** | **~300-500 users inscrits** | **~1000-1500 users inscrits** |

**Hypothèses** (à confirmer par télémétrie) : ~15-20 % de concurrence au pic, ~50 % du viewing sur navigateur, seul le **live-browser** touche le GPU (VOD → Cloudflare relay / engine raw-pipe = 0 GPU ; apps natives → direct = 0 GPU). C'est **le** rôle du single-flight (§9.8) : sans lui le GEX44 sature vers ~300-500 ; avec, le même box tient ~1000-1500.

### 10.4 Marge par palier (le coût fixe amortit)

| Users | Revenus (~$4 net) | Coût infra | Marge | % |
|---|---|---|---|---|
| 100 | $400 | ~$150 (**managé**, pas le box) | ~$250 | 62 % |
| 500 | $2 000 | €350 (~$380) | ~$1 620 | **81 %** |
| **1 000** | **$4 000** | **€350 (~$380)** | **~$3 620** | **90 %** |
| 2 000 | $8 000 | ~€510 (AX102 + 2× GEX44) | ~$7 450 | 93 % |

### 10.5 Réponse en une phrase + le « problème »

**AX42 + GEX44 (~€350/mo) tient ~1 000-1 500 users inscrits** — **à condition** d'avoir activé **single-flight + fan-out Cloudflare + dedup couche B + pooler** (prérequis Phase 0 de la checklist maître). Sans single-flight → plafond **~300-500**. **Ne provisionne le box qu'à partir de ~300 users** (avant = le managé est plus rentable). À 1 000 users la marge est ~90 % → **l'économie est excellente, pas problématique.**

### 10.6 ⚠️ 3 inconnues qui déplacent tout — à instrumenter

Les chiffres reposent sur : **(a) % de concurrence au pic**, **(b) % navigateur-vs-natif**, **(c) % live-vs-VOD**. Elles ne sont **pas mesurées** aujourd'hui (aucun compteur télémétrie lisible). → **Dès les premiers vrais users, instrumenter** ces 3 ratios pour recalculer la capacité réelle au lieu d'estimer. C'est le même « télémétrie manquante » que §9.8.
