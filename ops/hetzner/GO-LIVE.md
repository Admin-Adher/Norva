# Norva — GO-LIVE : runbook de bascule (jour J)

> **But** : le jour du push, la migration est *exécuter-des-étapes-dans-l'ordre*, pas réfléchir.
> Tout le reste (scripts, images, docs) est déjà prêt. Ce fichier = la séquence.
> DB → `ops/hetzner/` · Média → `ops/hetzner/media/` · Chiffrage → `docs/roadmap/scaling-cost-hetzner-plan.md`.
> Checklist détaillée par phase → `docs/roadmap/2026-07-07-migration-master-checklist.md`.

Légende : 🟦 TOI (infra) · 🟩 MOI (code) · ⏱️ durée indicative · 🚦 go/no-go.

---

## J-14 à J-2 — PRÉ-VOL (à froid, sans downtime)

Objectif : arriver au jour J avec **zéro inconnue**. Rien ici n'impacte la prod (flags OFF).

- [ ] 🟩 **Patchs Phase 0 mergés + déployés, flags OFF** : import-throttling, single-flight,
      relay fan-out, NVENC-flag, relay-hls opt-in (`ops/hetzner/media/CODE-PATCHES.md`). Déployés =
      neutres tant que non activés.
- [ ] 🟦 **DB** : provisionner l'AX42, monter la stack (`ops/hetzner/README.md` Phases 1-2), faire un
      **DRY-RUN complet** dump→restore→`05-verify-parity.sh` sur des données réelles. ⏱️ ½-1 j.
- [ ] 🟦 **Média** : provisionner le GEX44, installer NVIDIA driver + `nvidia-container-toolkit`,
      builder `Dockerfile.gex44`, vérifier `ffmpeg -encoders | grep nvenc`, faire **1 transcode live
      de test** GEX44 → lecture OK. ⏱️ ½ j.
- [ ] 🟦 **Cloudflare** : domaine média proxifié + Cache Rule segments (`media/cloudflare-cdn.md`),
      vérifier `cf-cache-status: HIT` sur un 2ᵉ viewer. ⏱️ 1-2 h.
- [ ] 🟦 **Backups** : pgBackRest/WAL-G → R2 configuré + **1 restore PITR testé**. ⏱️ ½ j.
- [ ] 🚦 **GO/NO-GO pré-vol** : parity ✓, transcode NVENC ✓, cache HIT ✓, PITR restauré ✓. Si un ✗ →
      NE PAS lancer le jour J.

---

## JOUR J — ÉTAGE DB (fenêtre de maintenance courte)

> La DB et le média sont indépendants ; tu peux faire la DB d'abord (Railway reste), média ensuite.

1. [ ] 🟦 **Freeze imports** (pause des sources / désactiver crons sync managé). ⏱️ 1 min.
2. [ ] 🟦 `scripts/01-dump-prod.sh` (dump globals+schéma+data). ⏱️ ~5-15 min (DB 5 Go).
3. [ ] 🟦 `scripts/02-restore-hetzner.sh` (restore). ⏱️ ~10-20 min.
4. [ ] 🟦 `psql -f scripts/03-recreate-cron-guc.sql` (GUC + 3 vault + 47 crons réécrits). ⏱️ ~2 min.
5. [ ] 🟦 `scripts/04-deploy-edge-functions.sh` + buckets → R2 + repoint app URLs/webhooks. ⏱️ ~15 min.
6. [ ] 🟦 `scripts/05-verify-parity.sh` → **tout ✓**. 🚦 Si ✗ → rester sur Supabase (rollback = ne pas
      basculer le DNS). ⏱️ ~5 min.
7. [ ] 🟦 **Bascule DNS** DB → Hetzner. Dégeler les imports. Garder **Supabase en lecture seule
      quelques jours** (rollback rapide). ⏱️ propagation.

**→ Étage DB migré. Total fenêtre ≈ 45-70 min.**

---

## JOUR J (ou J+n) — ÉTAGE MÉDIA (sans downtime, réversible)

> Aucune fenêtre de maintenance nécessaire : Railway reste en fallback pendant la bascule.

1. [ ] 🟦 GEX44 : `docker compose -f media/docker-compose.media.yml up -d --build` (flags ON dans
      l'image). ⏱️ build ~10 min.
2. [ ] 🟦 Cloudflare : activer le domaine média proxifié devant le GEX44.
3. [ ] 🟩🟦 **Repointer `NORVA_MEDIA_GATEWAY_URL`** (secret edge) vers le GEX44. Un sous-ensemble de
      lectures bascule.
4. [ ] 🟦 **Activer progressivement** : `MEDIA_GATEWAY_NVENC=1`, `MEDIA_GATEWAY_SINGLE_FLIGHT=1`, puis
      le relay-hls opt-in **provider par provider** (mesurer à chaque étape).
5. [ ] 🚦 **Vérifs live** : `nvidia-smi` (NVENC actif), `ps aux|grep ffmpeg` (1 process/chaîne unique),
      `cf-cache-status: HIT` (fan-out), lecture navigateur OK sur plusieurs providers.
6. [ ] 🟦 Laisser **Railway en fallback** ~quelques jours, puis réduire au minimum / couper.

**→ Étage média migré. Egress passe de « métré Railway » à « flat Hetzner + CDN ».**

---

## ROLLBACK (à chaque étape)

| Étage | Rollback |
|---|---|
| DB | Ne pas basculer le DNS (ou le re-pointer sur Supabase resté en lecture seule). |
| Média | Repointer `NORVA_MEDIA_GATEWAY_URL` sur Railway ; passer les flags à `0`. Instantané. |
| Flags | Tous OFF = comportement d'avant. Réversible sans redéploiement de code. |

---

## APRÈS LA BASCULE (semaines suivantes, quand les users montent)

- [ ] 🟦🟩 **Activer + valider le dedup couche B** (runbook `phase2-dedup-activation-runbook.md`).
- [ ] 🟦 **AX42 → AX102** en réplica streaming → promotion (quasi 0 downtime).
- [ ] 🟦 **Read replica** + **HA** (Patroni) avant d'avoir des milliers de payants.
- [ ] 🟦🟩 **Scaler la flotte GEX44** par nb de chaînes live distinctes (§10).
- [ ] 🟩 **Instrumenter la télémétrie** (part browser/natif, mix codec, % transcode) pour dimensionner juste.

---

## Récap : où est quoi

| Besoin | Fichier |
|---|---|
| Scripts DB (dump/restore/cron/parity) | `ops/hetzner/scripts/` |
| Stack DB + tuning + pooler | `ops/hetzner/docker-compose.supabase.yml`, `ops/hetzner/postgres/` |
| Image + compose média NVENC | `ops/hetzner/media/Dockerfile.gex44`, `media/docker-compose.media.yml` |
| Fan-out CDN | `ops/hetzner/media/cloudflare-cdn.md` |
| Patchs code (flags) | `ops/hetzner/media/CODE-PATCHES.md` |
| Chiffrage / capacité / marge | `docs/roadmap/scaling-cost-hetzner-plan.md` §7-§10 |
| Checklist par phase | `docs/roadmap/2026-07-07-migration-master-checklist.md` |
