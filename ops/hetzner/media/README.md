# Norva — Migration de l'étage MÉDIA (Railway → Hetzner GEX44 + Cloudflare)

> **Statut : PRÉPARÉ, rien déployé.** Ce kit rend la bascule média *turnkey* le jour du push.
> Il est le pendant de `ops/hetzner/` (étage DB). Le *pourquoi / le chiffrage* : voir
> `docs/roadmap/scaling-cost-hetzner-plan.md` §9-§10. Le runbook jour-J global (DB+média) :
> `ops/hetzner/GO-LIVE.md`.

## Rappel : c'est un étage SÉPARÉ de la DB

- **Étage DB** (Supabase → Hetzner AX42/AX102) = `ops/hetzner/`.
- **Étage média** (Railway → GEX44 + Cloudflare) = **ce dossier**.
- **Ne JAMAIS co-localiser** le transcode et Postgres sur la même box : l'egress vidéo sature le
  port 1 Gbit/s et affame la DB (cf. §9.5). GEX44 = box dédiée au transcode.

## Ce que fait ce kit

| Fichier | Rôle |
|---|---|
| `Dockerfile.gex44` | Image gateway avec **ffmpeg NVENC** (RTX 4000 Ada, HW HEVC→h264) |
| `docker-compose.media.yml` | Lance le gateway sur le GEX44 avec le runtime NVIDIA (`--gpus all`) |
| `cloudflare-cdn.md` | Config **fan-out CDN** : cache des segments HLS au edge (le mur 1 Gbit/s dissous) |
| `CODE-PATCHES.md` | Les changements de code à appliquer (**single-flight**, **relay fan-out**, **relay-hls opt-in**, **flag NVENC**), avec emplacements exacts — **prêts à appliquer, pas appliqués** |

## Les 3 leviers média (rappel §9.8)

1. **NVENC** (GEX44) : transcode HEVC→h264 en **hardware** (encodeur dédié, ≠ CUDA), ~20-40 flux 1080p/GPU.
2. **Single-flight** : **1 transcode par flux UNIQUE** partagé entre viewers (aujourd'hui 1 UUID/lecture = 1 transcode/viewer). Transforme « 20-40 transcodes = 20-40 viewers » en « = des milliers ». **C'est le levier n°1 de capacité.**
3. **Fan-out Cloudflare** : cache des segments `.ts` au edge → l'origine ne sert que le cache-fill, pas chaque viewer.

## Ordre de bascule (résumé — détail dans GO-LIVE.md)

1. **[calme, avant le push]** Appliquer + déployer les `CODE-PATCHES` (single-flight, fan-out, NVENC-flag) — **testés**, flags OFF par défaut → aucun changement de comportement tant que non activés.
2. **[TOI]** Commander le **GEX44**, installer NVIDIA driver + `nvidia-container-toolkit`.
3. **[TOI]** `docker compose -f docker-compose.media.yml up -d` (image NVENC), vérifier `ffmpeg -encoders | grep nvenc`.
4. **[TOI]** Config **Cloudflare** (`cloudflare-cdn.md`) : domaine média proxifié + règles de cache HLS.
5. **[TOI/MOI]** Repointer `NORVA_MEDIA_GATEWAY_URL` (secret edge) vers le GEX44, **activer** les flags (`MEDIA_GATEWAY_NVENC=1`, `MEDIA_GATEWAY_SINGLE_FLIGHT=1`, relay-hls opt-in).
6. **[TOI]** Garder **Railway en fallback** quelques jours, puis réduire/couper.

## ⚠️ Contrainte CI importante (pour le jour J)

`deploy-relay.yml` et `deploy-cloudflare.yml` se déclenchent sur **CHAQUE push sur `main`** (pas de filtre de chemin). Donc :
- Tout commit touchant `services/norva-relay/**` **redéploie le Worker relay** immédiatement.
- Tout commit touchant `public/js/**` **redéploie le web** (Pages).
- Le **media-gateway** (Railway) se déploie via l'intégration git de Railway (à repointer vers le GEX44 le jour J, ou build de l'image `Dockerfile.gex44` sur la box).

→ C'est pourquoi les patchs de `CODE-PATCHES.md` sont **flag-gated (OFF par défaut)** : on peut les committer/déployer **sans rien changer** au comportement live, puis les **activer** au moment voulu.

## Validation (avant de faire confiance en prod)

- [ ] `ffmpeg -hide_banner -encoders | grep -E 'h264_nvenc|hevc_nvenc'` sur le GEX44 (dans le conteneur).
- [ ] Un transcode live de test via le GEX44 → lecture OK dans un navigateur.
- [ ] Cloudflare : un 2ᵉ viewer de la même chaîne = **HIT** de cache (header `cf-cache-status: HIT`) → l'origine ne re-fetch pas.
- [ ] Single-flight : 2 lectures simultanées du même flux = **1 seul** process ffmpeg sur la box (`ps aux | grep ffmpeg`).
- [ ] Charge : monter en N viewers simultanés, vérifier que le GPU (`nvidia-smi`) et le port réseau tiennent.
