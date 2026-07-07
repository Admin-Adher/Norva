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
