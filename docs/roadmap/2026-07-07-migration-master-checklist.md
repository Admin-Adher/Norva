# Norva — Checklist maître de migration (Supabase+Railway → Hetzner) — 0 → 100 %

> Récapitulatif de **toutes** les étapes, de maintenant jusqu'à une migration complète.
> Décision founder : **1ʳᵉ migration DB sur AX42** (interim budget), **montée AX102 plus tard**
> (via réplication streaming = quasi 0 downtime). Détail sizing : `scaling-cost-hetzner-plan.md`.
> Scripts DB : `ops/hetzner/`. Légende : **[MOI]** = code que je fais dans le repo · **[TOI]** =
> infra hors repo · **[GATE]** = condition de déclenchement.

**Les 2 étages, à ne jamais confondre :**
- **Étage DB** = Supabase (Postgres/auth/edge/cron) → **Hetzner AX42 puis AX102**.
- **Étage média** = Railway (transcode FFmpeg) + Cloudflare relay → **Railway (interim) puis GEX44 + Cloudflare CDN**.

---

## PHASE 0 — Prérequis code (maintenant, en parallèle, rend l'app « portable + prête »)

Indépendant de l'achat serveur. **[GATE]** ceux marqués « hors charge » attendent que super8k finisse (`still_syncing=0`).

- [ ] **[MOI]** Import-throttling load-aware (edge `norva-source-sync`) — plafonne les imports lourds concurrents pour qu'un afflux d'users ne timeout pas les viewers. **[GATE super8k fini]**
- [ ] **[MOI]** Crawl audio 2-phases (matchés d'abord, curseur) — **[GATE DB calme]**
- [ ] **[MOI]** Formaliser en **migration** la modif admin coverage-by-identity (appliquée à la main = *gap de reproductibilité*, bloqueur HA).
- [ ] **[MOI]** Repointer les crons probe Ninja 79/80 (ancien identity `976e7bbd` → `346a7f5b`).
- [ ] **[MOI]** **Patch relay fan-out** : passer les segments HLS de `private,max-age=30` → `public, s-maxage=<durée segment>` (`services/norva-relay`), pour que les viewers d'une même chaîne partagent le cache edge.
- [ ] **[MOI]** **Patch single-flight** gateway média : 1 transcode par flux UNIQUE (clé `sourceUrl`+profil) partagé entre viewers (aujourd'hui 1 UUID/lecture = 1 transcode/viewer). C'est ce qui transforme « 20-40 transcodes = 20-40 viewers » en « = des milliers ».
- [ ] **[MOI]** Vérifier le template **pooler** (`ops/hetzner/postgres/pgbouncer.ini.example`) prêt pour la Phase 2.

---

## PHASE 1 — Provisionner le serveur DB (AX42)

- [ ] **[TOI]** Commander **AX42** (Ryzen 7 PRO 8700GE, 64 Go DDR5, 2×512 Go NVMe), EU (Falkenstein/Helsinki).
- [ ] **[TOI]** Ubuntu LTS, **mdadm RAID1** sur les 2 NVMe, partitions (`/var/lib/postgresql` sur NVMe).
- [ ] **[TOI]** `docker` + `docker compose`, **ufw** (n'ouvrir que 80/443 + SSH), **fail2ban**, updates auto.
- [ ] **[TOI]** Domaine + DNS + **TLS** (Caddy/nginx + Let's Encrypt) devant Kong. **Ne jamais exposer Postgres (5432) publiquement.**

> ⚠️ Caveats AX42 (assumés comme interim) : **non-ECC** (risque corruption mémoire silencieuse — acceptable court terme), disque **2×512 Go** (~512 Go utile RAID1 — large pour une DB de 5 Go ; **envoyer les backups sur R2**, pas sur le disque local). Montée **AX102** en Phase 8.

---

## PHASE 2 — Déployer la stack Supabase OSS

- [ ] **[TOI]** `cp ops/hetzner/.env.hetzner.example .env` et remplir **tous** les secrets (générer JWT secret, DB password, anon/service keys, SMTP).
- [ ] **[TOI]** `docker compose --env-file .env -f ops/hetzner/docker-compose.supabase.yml up -d` → attendre Postgres healthy.
- [ ] **[TOI]** Appliquer le tuning **tier 64 Go** (`ops/hetzner/postgres/postgresql.tuning.conf`) → redémarrer `db`.
- [ ] **[TOI]** (Recommandé dès le début) **PgBouncer** devant Postgres (`pgbouncer.ini.example`, transaction mode).

---

## PHASE 3 — Migrer la DB (fenêtre de maintenance, imports gelés)

- [ ] **[TOI]** **Geler les imports** (pause des sources / désactiver les crons sync côté managé).
- [ ] **[TOI]** `ops/hetzner/scripts/01-dump-prod.sh` — dump globals + schéma + data depuis Supabase.
- [ ] **[TOI]** `ops/hetzner/scripts/02-restore-hetzner.sh` — restore dans la stack (extensions → globals → schéma → data).
- [ ] **[TOI]** `psql -f ops/hetzner/scripts/03-recreate-cron-guc.sql` (avec `-v FUNCTIONS_BASE_URL=... -v NORVA_BACKFILL_TOKEN=... -v NORVA_CRON_SHARED_SECRET=... -v RESEND_API_KEY=...`) — GUC (`app.norva_*`, statement_timeout anon/authenticated), **ré-injecter les 3 secrets vault**, **réécrire+recréer les 47 crons** vers l'endpoint self-host.

---

## PHASE 4 — App + edge functions + storage

- [ ] **[TOI]** `ops/hetzner/scripts/04-deploy-edge-functions.sh` — servir les 19 fonctions `norva-*` sur l'edge-runtime self-host.
- [ ] **[TOI]** Migrer les **buckets Storage** (storyboards, sous-titres) → self-host **ou R2** (repointer les URLs).
- [ ] **[MOI/TOI]** **Repointer l'app** : base URL + clés dans `public/js/cloudApi.js` ; webhooks (Stancer/billing/RevenueCat) → nouveaux endpoints.
- [ ] **[MOI]** Adapter le CI `deploy-supabase-functions.yml` (cible managé → déploiement self-host, cf. note dans le script 04).

---

## PHASE 5 — Vérifier + basculer

- [ ] **[TOI]** `ops/hetzner/scripts/05-verify-parity.sh` — parité counts / extensions / crons / RLS / GUC managé↔self-host. **Tout doit être ✓ avant de basculer.**
- [ ] **[TOI]** Bascule **DNS** vers Hetzner. Surveiller.
- [ ] **[TOI]** **Garder Supabase en lecture seule quelques jours** (rollback rapide si souci).
- [ ] **[TOI]** Dégeler les imports.

**→ À ce stade : étage DB migré à 100 % sur AX42. ✅**

---

## PHASE 6 — Ops continue (indispensable dès la bascule)

- [ ] **[TOI]** **Backups** : pgBackRest ou WAL-G → **R2 offsite** (egress gratuit), **PITR TESTÉ régulièrement** (un backup non testé = pas de backup).
- [ ] **[TOI]** **Monitoring** : Netdata ou Prometheus+Grafana (disque, RAM, connexions, egress). Alertes.
- [ ] **[TOI]** Rotation des secrets, patchs OS/Postgres/stack.

---

## PHASE 7 — Étage média : optimiser RAILWAY (garder Railway, PAS de GEX44 encore)

> **La stack média near-term = Railway Pro + Cloudflare fan-out.** On NE passe PAS au GEX44 ici —
> Railway optimisé porte ~500-1000 users. Le GEX44 = Phase 7bis, **bien plus tard** (voir ci-dessous).

**[GATE]** quand le live-navigateur commence à monter (avant le push marketing).

- [ ] **[MOI]** Single-flight déployé + validé (fait au pré-vol, spec `ops/hetzner/media/CODE-PATCHES.md` #1).
- [ ] **[TOI/MOI]** **Cloudflare fan-out DEVANT Railway** : origine HLS Railway derrière un domaine Cloudflare proxifié + **Cache Rule sur les `.ts`** → le CDN cache les segments (dépend du single-flight = session-id partagé), l'origine Railway ne sert que le cache-fill. (`media/cloudflare-cdn.md` Option B.)
- [ ] **[MOI/TOI]** **Activer `norva-live-hls-relay`** par-provider (défaut OFF) → live éligible sur le relay Cloudflare quasi-gratuit au lieu du transcode Railway métré.
- [ ] **[TOI]** **R2** pour backups + segments VOD réutilisables (zéro egress).

**→ À ce stade : Railway reste, mais l'egress est servi par Cloudflare (cheap) + le transcode est partagé (single-flight). Coût maîtrisé jusqu'à ~500-1000 users.**

---

## PHASE 7bis — Passer Railway → GEX44 (⏳ BIEN PLUS TARD dans l'aventure)

> **NE PAS faire tôt.** Déclencheur : quand **Railway + fan-out devient le mur** — c.-à-d. quand le
> **vCPU transcode software** de Railway ou sa **facture egress** dépasse durablement le prix d'un
> **GEX44 (~€184/mo net)**, OU un throttle fair-use Railway. En pratique : **low hundreds de viewers
> live-navigateur concurrents.** Avant ça, Railway+fan-out suffit — n'achète pas de GPU inutilisé.

- [ ] **[TOI]** Commander **GEX44** (RTX 4000 SFF Ada, NVENC/NVDEC HW). **Box séparée de la DB** (jamais co-localisée — contention port 1 Gbit/s).
- [ ] **[MOI]** Image `ops/hetzner/media/Dockerfile.gex44` : FFmpeg **NVENC** (flag `MEDIA_GATEWAY_NVENC` déjà implémenté, OFF → à flipper + tester) — remplace le FFmpeg software de Railway.
- [ ] **[TOI/MOI]** Repointer `NORVA_MEDIA_GATEWAY_URL` → GEX44 ; le même fan-out Cloudflare passe devant l'origine GEX44.
- [ ] **[TOI]** Garder **Railway en fallback** pendant la bascule, puis réduire/couper.

**→ À ce stade : egress flat Hetzner + transcode NVENC (CPU ~0). Nécessaire seulement à l'échelle où Railway pique.**

---

## PHASE 8 — Prêt pour l'échelle (quand les users arrivent vraiment)

- [ ] **[TOI/MOI]** **Activer + VALIDER le dedup couche B** sur données réelles (runbook `phase2-dedup-activation-runbook.md`) — **prérequis** au sizing sublinéaire (÷3 mesuré ; sans lui le stockage explose en O(users×catalogue)).
- [ ] **[TOI]** **Monter AX42 → AX102** (128 Go **ECC**, 2×1,92 To NVMe DC) : mettre l'AX102 en **réplica streaming** de l'AX42, puis **promouvoir** (bascule quasi 0 downtime — bien plus simple que la 1ʳᵉ migration).
- [ ] **[TOI]** **Read replica** (2ᵉ box) : router les SELECT (grids/rails) → replica, écritures/imports → primary.
- [ ] **[MOI/TOI]** **Scaler la flotte média** : ajouter des GEX44 selon le nb de **chaînes live distinctes** populaires (avec single-flight, 1 GEX44 ≈ 20-40 chaînes uniques → des milliers de viewers via CDN).
- [ ] **[TOI]** **HA** : auto-promotion primary→replica (Patroni/etcd ou repmgr) + IP flottante + poolers redondants derrière VIP. **[GATE]** avant d'avoir des milliers de payants.
- [ ] **[TOI]** Éventuellement **EX131 / AX162** (EPYC/Xeon, 256 Go ECC reg) si tu deviens memory-bandwidth-bound à de vrais milliers (rappel : l'AX162 standard ≈ €612/mo, pas €319 = SKU LTD).

---

## Récap « qui fait quoi »

| | MOI (code repo) | TOI (infra) |
|---|---|---|
| Prérequis | throttling, crawl 2-phases, migration admin, patch relay+single-flight, Dockerfile GEX44, CI | — |
| DB | scripts dump/restore/cron-guc/parity (faits) | serveur, DNS/TLS, exécuter les scripts, backups, monitoring |
| Média | single-flight, relay-hls opt-in, NVENC | GEX44, config Cloudflare CDN, R2 |
| Scale | (assistance) | AX102/replica/HA, activer dedup, flotte GEX44 |

## Ordre de dépendance (le chemin critique)
```
Phase 0 (code prêt) ─┬─► Phase 1-6 : DB sur AX42 (100% migrée) + pooler + backups
                     └─► Phase 7 : média RAILWAY optimisé (single-flight + Cloudflare fan-out)
                                        │
                          (bien plus tard, quand Railway pique)
                                        ▼
                                   Phase 7bis : Railway → GEX44 (NVENC)
                                        │
                                        ▼
                          Phase 8 : échelle (dedup, AX102, read replica, HA)
```
La DB (Phases 1-6) et le média (Phase 7) sont **indépendants**. **Stack near-term = AX42 + Railway
Pro + Cloudflare fan-out.** Le **GEX44 (Phase 7bis) = bien plus tard**, seulement quand Railway+fan-out
devient le mur. → Source de vérité de la stack + de l'ordre : **`STACK-AND-ROADMAP.md`**.
