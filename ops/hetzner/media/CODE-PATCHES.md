# Patchs code média — prêts à appliquer (flag-gated, OFF par défaut)

> **Non appliqués.** Ces changements touchent des services LIVE (`services/media-gateway`,
> `services/norva-relay`) qui **se redéploient sur chaque push `main`** (cf. README §CI). Ils sont
> donc conçus **flag-gated, OFF par défaut** : on peut les committer/déployer **sans changer** le
> comportement, puis les **activer** le jour du push. À implémenter + **tester** pendant une phase
> calme (idéalement pas pendant un gros import en cours).

Ordre de risque : #2 (trivial) < #3 (config) < #4 (args ffmpeg) < #1 (logique de session).

---

## Patch #1 — SINGLE-FLIGHT (le levier n°1 de capacité)

**Fichier** : `services/media-gateway/src/index.js`
**Repères** : `const sessions = new Map()` (~L358) ; `sourceSessionKey(sourceUrl)` (~L2136, L3057) ;
`createGatewaySession` mint un `id = crypto.randomUUID()` par lecture (~L2132) → **1 transcode/viewer**.
**Flag** : `MEDIA_GATEWAY_SINGLE_FLIGHT` (défaut OFF).

**Idée** : 1 ffmpeg par **flux unique** (`sourceKey` + profil transcode + audio), partagé entre viewers.

**Spec** :
1. Ajouter un index `const sessionsByKey = new Map(); // fanKey -> sessionId`.
   `fanKey = sourceKey + '|' + mode + '|' + videoCodecTarget + '|' + audioSelector` (tout ce qui
   change la SORTIE ffmpeg ; PAS le seekOffset — voir note live/VOD).
2. Dans `createGatewaySession`, **si `MEDIA_GATEWAY_SINGLE_FLIGHT`** : avant de spawner, chercher une
   session vivante (`status !== 'stopped'`, non expirée) pour ce `fanKey`. Si trouvée :
   - **réutiliser** : `session.viewers = (session.viewers||1) + 1`, renvoyer **le même** `playlistPath`
     / access (ou un token dérivé), **sans** spawner de ffmpeg.
3. Sinon : comportement actuel (spawn) + init `session.viewers = 1` + `sessionsByKey.set(fanKey, id)`.
4. À la fermeture d'un viewer (fin de session / TTL / `/stop`) : `session.viewers--` ; ne stopper le
   ffmpeg + nettoyer `sessionsByKey` que quand `viewers <= 0` **et** après un court **grace TTL**
   (ex. 15-30 s, pour absorber un zapping/refresh sans re-spawn).
5. **LIVE vs VOD** :
   - **LIVE** : pas de seek → le `fanKey` ignore l'offset → **partage total** (idéal, c'est là que
     sont les milliers de viewers sur peu de chaînes).
   - **VOD** : chaque viewer est à une position différente → **NE PAS** partager par offset (sinon on
     casserait le seek). En pratique la VOD touche peu le FFmpeg (relay/engine) → laisser la VOD en
     1 session/viewer, n'activer le single-flight que pour `mode live`. (Garder simple : brancher le
     partage uniquement quand `isLive`.)
6. **Anti-ban** : le single-flight **réduit** les connexions provider (1 pull par chaîne au lieu de N)
   → compatible avec `preemptAccountExtractions` (~L2125). Vérifier qu'on ne libère pas le slot
   provider tant que `viewers > 0`.

**Test** : 2 lectures simultanées de la même chaîne live → **1 seul** `ffmpeg` (`ps aux|grep ffmpeg`),
les 2 lisent. Couper 1 viewer → le ffmpeg continue tant que l'autre regarde ; couper le dernier →
ffmpeg s'arrête après le grace TTL.

---

## Patch #2 — RELAY FAN-OUT (cache des segments au edge) — trivial

**Fichier** : `services/norva-relay/src/index.js` (~L567 : `Cache-Control: private, max-age=30` sur le
chemin playback).
**Flag** : conditionner sur le **type de ressource** (segment vs manifest vs plage partielle), pas sur
un env (le Worker n'a pas d'env simple ici) — c'est intrinsèquement sûr car ça ne touche que les
segments cacheables.

**Spec** :
- Pour un **segment complet** HLS (`.ts` / `.m4s`, réponse **200** complète, pas une plage `206`) :
  → `Cache-Control: public, s-maxage=6, max-age=0` (live) ; VOD peut monter `s-maxage`.
  → et `ctx.waitUntil(caches.default.put(request, response.clone()))` si pas déjà en cache.
- **Manifest** `.m3u8` live : garder très court / `no-store` (change chaque segment).
- **Plages partielles** (`206`, seek/range) : **rester** `private, max-age=30` (non cacheable).
- ⚠️ Ne PAS cacher les réponses qui portent un token à usage unique dans le corps ; ici les segments
  sont des octets média → OK.

**Test** : 2 viewers même chaîne → 2ᵉ segment = `cf-cache-status: HIT`.

---

## Patch #3 — RELAY-HLS OPT-IN (pousser le LIVE sur Cloudflare) — config

**Fichier** : `public/js/api.js` (~L1398-1400 : opt-in `norva-live-hls-relay` **défaut OFF** → tout le
live browser tombe sur le transcode Railway/GEX44 métré).
**Nature** : c'est un **flag par-provider** (config), pas une réécriture. L'activer là où le provider
sert un HLS/TS relayable directement → ce live passe par le **relay Cloudflare** (quasi-gratuit) au
lieu du FFmpeg.

**Spec** : activer `norva-live-hls-relay` pour les providers compatibles (ceux dont le flux live est
relayable sans transcode). Laisser OFF pour ceux qui exigent un transcode (HEVC live, etc.).
**Prudence** : à valider provider par provider (certains 403 le relay Cloudflare → rester en
transcode). Commence par 1 provider, mesure, étends.

---

## Patch #4 — FLAG NVENC (HW transcode sur le GEX44)

**Fichier** : `services/media-gateway/src/index.js` — le **builder d'args de transcode** dans
`createGatewaySession` (~L2200-2379, spawn du ffmpeg de lecture).
**Flag** : `MEDIA_GATEWAY_NVENC` (défaut OFF → software `libx264`, identique à Railway).
**Prérequis** : tourne sur le GEX44 avec l'image `Dockerfile.gex44` (ffmpeg NVENC) + `--gpus all`.

**Spec** (quand `MEDIA_GATEWAY_NVENC` **et** GPU dispo) :
- **Décodage HW** (entrée) : `-hwaccel cuda -hwaccel_output_format cuda` (ffmpeg choisit `hevc_cuvid`/
  `h264_cuvid` pour décoder HEVC/h264 en hardware via NVDEC).
- **Encodage HW** (sortie) : remplacer `-c:v libx264 -preset ... ` par
  `-c:v h264_nvenc -preset ${NVENC_PRESET:-p4} -tune ${NVENC_TUNE:-ll} -rc vbr -b:v <bitrate> -maxrate <max> -bufsize <buf>`.
- **Audio / HLS** : inchangés (`-c:a aac` + segmentation HLS actuelle).
- **Fallback** : si le spawn NVENC échoue (GPU indispo / driver) → retomber sur `libx264` (garder le
  chemin software comme filet). Logguer clairement.
- **Résolution/bitrate** : NVENC 1080p ~20-40 sessions/GPU ; le 4K est bien plus lourd (moins de
  sessions) → prévoir un cap concurrent (`admitHeavyTranscode`) côté gateway si besoin.

**Test** : `ffmpeg -encoders | grep nvenc` OK dans le conteneur ; un transcode live via le GEX44 →
`nvidia-smi` montre l'usage NVENC ; lecture navigateur OK ; comparer le CPU (doit être ~0 vs software).

---

## Récap flags (tout OFF par défaut = déploiement neutre)

| Flag | Où | Effet quand ON |
|---|---|---|
| `MEDIA_GATEWAY_SINGLE_FLIGHT` | gateway env | 1 transcode/flux unique partagé (capacité ×N) |
| `MEDIA_GATEWAY_NVENC` | gateway env | transcode HW (GEX44), CPU ~0 |
| relay segment-cache (patch #2) | relay code | fan-out CDN des segments |
| `norva-live-hls-relay` | config par-provider | live éligible → relay Cloudflare (pas de transcode) |

→ On peut **committer + déployer** avec tout OFF (aucun changement), puis **activer** progressivement
le jour du push, provider par provider, en mesurant. C'est ce qui rend la bascule *réversible et sûre*.
