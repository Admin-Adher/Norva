# Session log — Scaling & migration Hetzner (2026-07-07)

> Trace de tout ce qui a été fait dans la session « scaling / coût / migration Hetzner+Railway »,
> jusqu'au point d'arrêt. Handoff : où on en est, ce qui est prêt, ce qui reste, l'état live.

---

## 1. Périmètre de la session

Répondre à : **combien ça coûte de scaler**, **quel matériel Hetzner** (jusqu'à des milliers
d'users), **Railway remplacé ou pas**, **capacité/marge**, et **préparer la migration** (DB +
média) pour qu'elle soit *turnkey* le jour du push. **Livrable = analyse + préparation** (docs +
scripts + kit), **pas** de déploiement en prod (l'infra reste au founder).

---

## 2. Décisions du founder (figées)

- **DB** : 1ʳᵉ migration sur **Hetzner AX42** (interim budget), montée **AX102** plus tard via
  **réplica streaming → promotion** (quasi 0 downtime).
- **Média** : sortir de **Railway** → **GEX44** (RTX 4000 SFF Ada, NVENC, **€184/mo net** confirmé)
  + **fan-out Cloudflare**. **Jamais co-localiser** DB + transcode (contention port 1 Gbit/s).
- **Timing** : provisionner le box **à partir de ~300 users** ; média **avant le push marketing**.
- **Capacité** cible : **AX42 + GEX44 ≈ €350/mo → ~1000-1500 users** *avec single-flight* (~300-500
  sans).
- **Ne PAS acheter 512 Go RAM** (hot set dédupé 15-115 Go → 128 Go = sweet spot).
- **Prix** : AX41 €59 / AX42 €99 / AX102 €259 confirmés ; **AX162 €319 = SKU LTD promo**, standard
  ≈ €612/mo.

---

## 3. Analyses produites (méthode : 2 workflows multi-agents + lecture du code)

- **Sizing « milliers d'users »** (workflow `wf_ca9d5a5c`) : box, RAM, cores, pooling, HA. Verdict :
  le vrai mur = **média/egress**, pas Postgres ; « une box » est la mauvaise unité à des milliers
  (pooler + dedup + replica + flotte GPU + HA prérequis).
- **Railway vs Hetzner + flux média** (workflow `wf_ee457127`) : trace du **flux média dans le
  code** (direct/relay/engine/transcode), pricing Railway ($0.05-0.10/Go egress, pas de GPU) vs
  Hetzner (trafic flat illimité 1 Gbit/s). Verdict : Hetzner **~100-200× moins cher** sur l'egress.
- **Découverte clé (code)** : l'egress n'est le coût de Norva que pour les **viewers navigateur** ;
  apps natives = **direct = 0€** ; VOD propre = Cloudflare relay (cheap) ; HEVC/MKV = Railway raw
  (egress sans CPU) ; **LIVE navigateur = Railway FFmpeg** (le vrai centre de coût).
- **« 20-40 transcodes/GPU »** = 20-40 **flux uniques** (pas viewers) → avec **single-flight** = des
  milliers de viewers ; **sans**, ~20-40. Aujourd'hui le code = 1 transcode/viewer (pas de partage).

---

## 4. Artefacts créés / commits

### `main` (documentation + kit DB + kit média — déploie RIEN, `ops/` non surveillé par la CI)

| Commit | Contenu |
|---|---|
| `cf53441` | `docs+ops`: sizing milliers d'users (§7) + **scripts migration DB** `ops/hetzner/` |
| `f0a12e3` | `docs §9`: Railway vs Hetzner média + path box réel |
| `7f4260f` | `docs §9.8`: cross-check synthèse (trigger points Railway, fan-out CDN) |
| `d5ee0d8` | **checklist maître** `2026-07-07-migration-master-checklist.md` (8 phases) |
| `55e82b5` | `docs §10`: **économie unitaire & capacité** (€350/mo → 1000-1500 users, marges) |
| `8890ab9` | **kit média** `ops/hetzner/media/` (Dockerfile NVENC, compose, Cloudflare, patchs) + `GO-LIVE.md` |
| `01b8efc` | `docs média`: correction fan-out (single-flight + Cache Rule CDN, pas cache Worker) |

### Branche `claude/language-filter-media-grid-ymd19s` (unmerged, déploie RIEN)

| Commit | Contenu |
|---|---|
| `f5aa22a` | **NVENC implémenté** (flag `MEDIA_GATEWAY_NVENC` **OFF** par défaut) dans `services/media-gateway/src/index.js` + docs corrigées |

### Fichiers de référence

- `docs/roadmap/scaling-cost-hetzner-plan.md` — **le doc de référence** : §7 sizing milliers, §8
  index scripts DB, §9/§9.8 Railway vs Hetzner, §10 capacité/marge.
- `docs/roadmap/2026-07-07-migration-master-checklist.md` — runbook 0→100 % en 8 phases.
- `ops/hetzner/` — kit DB (dump/restore/cron-guc/parity, compose Supabase OSS, tuning, pgbouncer).
- `ops/hetzner/media/` — kit média (Dockerfile.gex44 NVENC, compose, cloudflare-cdn, CODE-PATCHES).
- `ops/hetzner/GO-LIVE.md` — runbook jour-J ordonné (DB ~45-70 min + média sans downtime + rollback).

---

## 5. Le code (patchs média) — état exact

Les 4 « patchs » se sont clarifiés en lisant le code :

| Levier | Type | État |
|---|---|---|
| **NVENC** (`MEDIA_GATEWAY_NVENC`) | **code** | ✅ **implémenté**, flag OFF (OFF = `libx264` à l'octet près), `node --check` OK, **branche f5aa22a unmerged** |
| **Single-flight** (`MEDIA_GATEWAY_SINGLE_FLIGHT`) | **code** | ⏳ **PAS implémenté à l'aveugle** — logique de cycle de vie distribuée (refcount viewers) sur le chemin critique live, non testable ici. **Spec précise prête** dans `CODE-PATCHES.md` patch #1. À faire **avec test de charge au pré-vol**. |
| **Fan-out** | **config** | ⏳ `rewriteHlsPlaylist` re-signe chaque segment avec un **token par viewer** → cache Worker inutile. Vrai fan-out = single-flight (session-id partagé) + **Cloudflare Cache Rule sur l'origine**. `cloudflare-cdn.md` Option B. |
| **relay-hls opt-in** (`norva-live-hls-relay`) | **config** | ⏳ flag par-provider, à activer au pré-vol, provider par provider |

**NVENC — emplacement exact** : `services/media-gateway/src/index.js` — const flag ~L164-170
(`MEDIA_GATEWAY_NVENC`, `NVENC_PRESET=p4`, `NVENC_TUNE=ll`) ; branche d'encodage ~L2431 (ternaire
`MEDIA_GATEWAY_NVENC ? [h264_nvenc…] : [libx264…]`). Encode-only ; **NVDEC hwaccel volontairement
non activé** (interagit avec pix_fmt/seek) → à ajouter au pré-vol avec test.

**Contrainte CI** : `deploy-relay.yml` + `deploy-cloudflare.yml` déploient sur **chaque push `main`** ;
le media-gateway déploie via l'intégration git Railway (watch `main`). → tout le code média a été
gardé **sur la branche feature** (déploie rien) ; merge → main + test au pré-vol.

---

## 6. Ce qui reste (au pré-vol J-14→J-2, avec le GEX44 + un test)

1. **Merger la branche → main** (déploie NVENC flag OFF, neutre) + **tester NVENC** sur le GEX44.
2. **Implémenter single-flight** (spec prête) + **test de charge**.
3. **Config Cloudflare** : Cache Rule `.ts` sur l'origine (fan-out) + relay-hls par-provider.
4. Suivre `GO-LIVE.md` pour la bascule.

## 7. Dette de session (indépendante de la migration, à faire quand la DB est calme)

- **(a)** Import-throttling load-aware + crawl audio 2-phases — **gatés sur super8k fini** (ne pas
  déployer sous charge). Prochain move proposé au founder.
- **(b)** Formaliser en **migration** la modif admin coverage-by-identity (appliquée à la main = gap
  de reproductibilité, **bloqueur HA**).
- **(c)** Repointer les crons probe Ninja **79/80** (ancien identity `976e7bbd` → `346a7f5b`).

---

## 8. État opérationnel au point d'arrêt (~2026-07-07 ~12:00Z)

- **super8k.top** (272k, `1aaeb703`) : encore en `building_titles`, **~79 %** (offset ~171 900),
  cadence variable mais avance (pas bloqué). Import DB lourd en cours.
- **facet-refresh (cron 92)** : **EN PAUSE** (réactivé auto par le watchdog quand `still_syncing=0`).
- **ancien Ninja** `976e7bbd` : soft-deleted, **pas encore reapé** (`soft_deleted_pending=1`) → le
  re-enrichissement TMDB reste gaté.
- **Ninja actif** `346a7f5b` : `ready`. **modif coverage admin** (group by identité) : appliquée.
- **Watchdog consolidé** : armé via `send_later` (dernier fire ~12:35Z, cadence 30 min ; retry court
  5 min si le canal MCP `execute_sql` flappe). Il enchaînera à `still_syncing=0` : réactiver facet →
  re-enrich TMDB (si ancien Ninja drainé) → refresh admin → rappeler la dette (a)(b)(c) au founder.
- **Incident récurrent** : canal MCP `execute_sql` (Supabase) flappe (« permission stream closed »),
  se rétablit au retry. Pattern géré par le watchdog.

## 9. Git — résumé

- `main` = `01b8efc` (docs + kits, aucun changement de comportement prod).
- `claude/language-filter-media-grid-ymd19s` = `f5aa22a` (= main + **code NVENC flag OFF**), **1
  commit devant main, unmerged**. ⚠️ Ne PAS force-sync cette branche sur main (elle porte du travail
  non mergé) — merger normalement au pré-vol.
