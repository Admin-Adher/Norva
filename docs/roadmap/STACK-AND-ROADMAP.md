# Norva — Stack & Roadmap (SOURCE DE VÉRITÉ)

> **Le doc à ouvrir en premier pour ne pas se tromper sur notre stack et l'ordre de travail.**
> Mets-le à jour si une décision change. Détails chiffrés → `scaling-cost-hetzner-plan.md` ;
> runbook pas-à-pas → `2026-07-07-migration-master-checklist.md` + `ops/hetzner/GO-LIVE.md`.
> Dernière mise à jour : 2026-07-07.

---

## 1. La stack — maintenant → plus tard

| Étage | AUJOURD'HUI (pré-lancement) | NEAR-TERM (le socle) | BIEN PLUS TARD (échelle) |
|---|---|---|---|
| **DB / backend** | Supabase managé (2 Go, IO-bound) | **Hetzner AX42** (64 Go) + **PgBouncer** | AX102 (128 Go ECC) + **read replica** + **HA** |
| **Média / transcode** | **Railway** (Hobby→**Pro**) | **Railway Pro + Cloudflare fan-out** (+ single-flight) | **GEX44** (NVENC) + Cloudflare, flotte selon chaînes |
| **Egress viewer** | Cloudflare relay (VOD) / Railway (live) | **Cloudflare CDN** (fan-out) devant Railway | Cloudflare CDN devant GEX44 (egress flat) |
| **Stockage/backups** | Supabase managé | **R2** (backups pgBackRest + segments) | R2 + WAL archiving offsite |

**Décisions figées :**
- DB : **AX42 d'abord** (interim), **AX102 plus tard** via réplica streaming → promotion (quasi 0 downtime).
- Média : **garder Railway (Pro) + Cloudflare fan-out** ; **GEX44 = bien plus tard**, seulement quand Railway pique.
- **Ne JAMAIS co-localiser** DB + transcode (contention port 1 Gbit/s).
- **Localisation** : Falkenstein (Allemagne) — central pour l'audience FR, même région que le futur GEX44.

---

## 2. L'ordre de travail priorisé (ne pas se tromper de séquence)

🟩 = moi (code/SQL) · 🟦 = toi (infra, je te guide).

### 🥇 LE SOCLE — fait ~80 % du boulot, à faire pour être serein
1. **Migrer la DB sur AX42** 🟦 — LE levier : tue timeouts + imports lents + strain + crons en échec (tous = le box 2 Go trop petit). *À soi seul → plusieurs centaines d'users sereinement.*
2. **Pooler PgBouncer dès J1** 🟦 — prérequis connexions (sans lui, un box meurt à 300-500 connexions directes). Template `ops/hetzner/postgres/pgbouncer.ini.example`.
3. **Backups pgBackRest → R2 + PITR testé** 🟦 — en quittant le managé, tu possèdes l'ops. Backup non testé = pas de backup.
4. **Monitoring** 🟦 (Netdata/Grafana).

### 🥈 DÉCOUPLER le coût du nombre d'users
5. **Activer + valider le dedup couche B** 🟩 — prérequis au sizing sublinéaire (÷2-3 **stockage**). Inutile à 10 users, **vital à 50-100**. **NE PAS l'allumer avant le gate chiffré `catalog_flip_readiness(3.0)` = GO** (≈ plusieurs owners d'un même provider) : à 1 owner le gain ≈ 0 et le pas « thin » irréversible coûte _plus_ cher. ⚠️ Ne pas confondre avec la **couche A (enrichissement TMDB/pistes) qui est DÉJÀ ON** — c'est elle qui donne « le catalogue premium instantané réutilisé par un futur owner » ; la couche B n'ajoute que l'économie de **stockage** à l'échelle, et le reaper de suppression ne touche jamais les tables `catalog_*`. Cycle de vie à la suppression + « pourquoi pas maintenant » détaillés dans (`phase2-dedup-activation-runbook.md`.)
6. **Fermer le gap de reproductibilité** 🟩 — formaliser en **migration** les fixes appliqués à la main (admin coverage…). Propreté + débloque tout futur HA.

### 🥉 ÉTAGE MÉDIA (Railway) — le garder pas cher + repousser le mur
7. **Single-flight** 🟩 (code, testé au pré-vol) — 1 transcode par **flux unique** au lieu de 1/viewer. (`ops/hetzner/media/CODE-PATCHES.md` #1.)
8. **Cloudflare fan-out DEVANT Railway** 🟦 (Cache Rule `.ts` sur l'origine) — l'egress est servi par le CDN (cheap) ; **fait passer Railway de ~100-300 à ~500-1000 users**.
9. **relay-hls opt-in par-provider** 🟩/🟦 — live éligible sur Cloudflare (quasi-gratuit) au lieu du transcode Railway métré.

### 📊 PILOTER (sinon on vole à l'aveugle)
10. **Instrumenter la télémétrie** 🟩 — part **navigateur vs natif**, **mix codec**, **% transcode**. Les 3 inconnues qui décident capacité + facture réelles.

### 🔧 DÉTAIL (5 min, plus tard)
11. **Monter `admitHeavyImport`** 🟩 sur AX42 (3 → ~8-12) — remplace l'import-throttling (obsolété par la puissance de l'AX42).

**Séquence :**
```
MAINTENANT : 1 AX42 → 2 Pooler → 3 Backups → 4 Monitoring   (→ plusieurs centaines d'users sereins)
QUAND PLUSIEURS USERS : 5 Dedup couche B (validé) + 6 Repro-gap
QUAND LE LIVE-NAVIGATEUR MONTE : 7 Single-flight + 8 Cloudflare fan-out + 9 relay-hls   (→ Railway cheap jusqu'à ~500-1000)
EN CONTINU : 10 Télémétrie + 4 Monitoring
```

---

## 3. Quand le GEX44 (et le multi-nœuds) entre en jeu — ⏳ BIEN PLUS TARD

**NE PAS acheter tôt.** Déclencheurs (l'un OU l'autre) :
- Le **vCPU transcode software de Railway** ou sa **facture egress** dépasse durablement **~€184/mo** (le prix d'un GEX44), **ou**
- Tu heurtes le **throttle fair-use Railway** (>~100 Go/mo métré non-caché), **ou**
- **Low hundreds de viewers live-navigateur concurrents.**

Ce qui vient alors, dans l'ordre (Phase 7bis → 8 de la checklist) :
1. **GEX44** (NVENC, flag déjà codé OFF) — remplace le transcode software de Railway. Box séparée.
2. **AX42 → AX102** (128 Go ECC) via réplica streaming.
3. **Read replica** (SELECT → replica, écritures → primary).
4. **Flotte GEX44** dimensionnée au nb de **chaînes live distinctes** (avec single-flight, 1 GEX44 ≈ 20-40 chaînes → des milliers de viewers via CDN).
5. **HA** (auto-promotion Patroni + poolers redondants) — avant d'avoir des milliers de payants.
6. Éventuellement **EX131/AX162** (EPYC/Xeon 256 Go ECC reg) si memory-bandwidth-bound à de vrais milliers (AX162 standard ≈ €612/mo, pas €319 = SKU LTD).

### Polish post-migration (historique — fait le 2026-07-08)
- **TMDB re-enrichment des titres à préfixe** (~138k titres `unmatched` matchant le regex de préfixe) :
  ✅ **LANCÉ le 2026-07-08** (plus tôt que prévu : inutile d'attendre AX42, il suffisait que le reap de
  l'ancien Ninja soit fini et la box calme). Reset des 138 331 marqueurs `search_match_attempted_at`
  **par batches de 30k** (pour éviter le timeout MCP 60s), puis `norva_search_match_state` remis à
  `done=false, last_id=null`. Le cron `norva-enrich-search-match` (*/3) draine sur quelques heures
  (~74% de match dès le 1er batch). Requête de référence si à refaire :
  `update cloud_titles set search_match_attempted_at=null where match_status='unmatched' and title ~ '^([A-Z]{2}[A-Z0-9]{0,3}|4K|8K|2160P|1440P|1080P|720P|480P|360P)(-[A-Z0-9+]{1,6})* [-–—▎▏▍▌│┃┆┊｜|] ';` puis `update norva_search_match_state set last_id=null, done=false where id=1;` (le head admet aussi les préfixes qualité digit-led "4K-AR - "/"8K - " du panel Strng IPTV 8K)
- **Avant le dump de migration** : ✅ **le reap est complet** (0 source soft-deleted au 2026-07-08 —
  l'ancien Ninja `976e7bbd` entièrement drainé, ~763k lignes de doublon supprimées). Le dump AX42 ne
  transportera pas le doublon. Reaper repassé de `* * * * *` à `*/10` (drain fini → no-op fréquent inutile).
- **Instrumenter** est FAIT (télémétrie mode/codec/surface live depuis 2026-07-07) → lire
  `/telemetry/summary` (`decisionSignals.meteredRequestShare` etc.) pour sizer la flotte média sur du réel.

---

## 4. Capacité & coût par palier (rappel §10)

| Stack | Tient jusqu'à | Coût ~/mois |
|---|---|---|
| Supabase managé + Railway (aujourd'hui) | ~50 users | ~$85-135 |
| **AX42 + Railway Pro** (sans fan-out) | **~100-300 users** | **~€240-290** |
| **AX42 + Railway Pro + Cloudflare fan-out** | **~500-1000 users** | **~€300-500** |
| AX42/AX102 + **GEX44** + Cloudflare | ~1000-1500 users | ~€350-550 |
| AX102 + replica + flotte GEX44 + HA | milliers | ~€1-2k+ |

> Le coût **DB reste quasi-plat** ; c'est le **média/egress** qui décide, et **Cloudflare + Railway/GEX44**
> le gardent bas. La marge s'améliore avec l'échelle (coût fixe amorti) : ~62 % à 100 users → ~90 % à 1000.

---

## 5. Où est quoi (les autres docs)

| Doc | Rôle |
|---|---|
| **`STACK-AND-ROADMAP.md`** (ce fichier) | source de vérité : stack + ordre de travail |
| `scaling-cost-hetzner-plan.md` §7-§10 | chiffrage détaillé, box, capacité, marge |
| `2026-07-07-migration-master-checklist.md` | runbook 0→100 % (Phases 0-8) |
| `2026-07-07-scaling-migration-session-log.md` | handoff de la session |
| `ops/hetzner/PROVISION-AX42.md` | provisionner l'AX42 pas-à-pas (débutant) |
| `ops/hetzner/README.md` + `GO-LIVE.md` | runbook migration DB + jour-J |
| `ops/hetzner/media/` | kit média (single-flight, Cloudflare, Dockerfile GEX44) |
| `phase2-dedup-activation-runbook.md` | activation dedup couche B |
| `shared-cache-layers.md` | **couches partagées (mutualisées)** : pistes/titres/sous-titres IA — ce qui profite à tous les users du même provider + caveat mode-dépendant (audit code 2026-07-08) |
