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

## Patch #2 — FAN-OUT : ⚠️ PAS via le cache du Worker relay — via single-flight + Cache Rule CDN

> **Correction importante après lecture du code relay.** L'idée naïve « cacher les segments dans le
> Worker (`caches.default`) » **NE fan-out PAS** : `rewriteHlsPlaylist` (`norva-relay/src/index.js`
> ~L588-597) **re-signe chaque URI de segment avec le token PAR VIEWER**, donc 2 viewers d'une même
> chaîne ont des **URLs de segment différentes** → clés de cache différentes → **aucun partage**.
> Cacher par URL tokenisée ne sert à rien ; cacher par URL cible (custom cache key) est du
> cache-key surgery risqué sur le chemin critique. → **Ne PAS faire ça.**

**Le VRAI fan-out** (config, pas de code Worker) :
1. **Single-flight (patch #1)** fait que tous les viewers d'une chaîne partagent **le même
   `session.id`** → l'origine (GEX44) sert les **mêmes** URLs `/sessions/<id-partagé>/seg_N.ts`
   pour tous.
2. Ces URLs d'origine étant **identiques** entre viewers, une **Cloudflare Cache Rule sur le domaine
   d'origine** (`.ts` → Edge TTL ~durée de segment) les cache au edge → le 2ᵉ viewer prend le
   segment au CDN, l'origine ne sert que le cache-fill. **C'est là qu'est le fan-out.**
   → Voir `cloudflare-cdn.md` **Option B** (domaine média proxifié + Cache Rule). **Config, pas code.**

**Donc** : pas de patch Worker relay pour le fan-out. Le fan-out = **#1 (single-flight) + Cache Rule
CDN sur l'origine**. Le chemin relay Cloudflare reste utile pour la **VOD propre** (egress
non-métré) et pour le **live-hls relayable** (#3), mais ce n'est pas le mécanisme de fan-out du
transcode.

**Test** : avec single-flight ON + Cache Rule, 2 viewers même chaîne → 2ᵉ segment
`cf-cache-status: HIT` **et** un seul `session.id` (donc un seul ffmpeg).

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

## Patch #5 — CRAWL CÈDE AUX VIEWERS (anti-458 slot provider)

> **Problème** : le compte IPTV a peu de connexions simultanées (souvent 1). Le **crawl audio de
> fond** sonde le provider via le **relay Cloudflare** (`norva-playback/index.ts:~3980` →
> `norva-relay/src/index.js:992`) — une couche qui **ne partage aucun état** ni avec la préemption
> du media-gateway (`preemptAccountExtractions`, `media-gateway/src/index.js:113`, qui ne tue que des
> ffmpeg d'**extraction** enregistrés — le crawl n'en est PAS un) ni avec les tables viewer de l'edge.
> Donc quand le crawl tient le slot et qu'un humain lit/télécharge → **HTTP 458**. Le seul garde
> actuel = `userHasLiveSession` **par-user, une fois en entrée de tick** (`index.ts:3788`) → rate les
> viewers qui démarrent en cours de tick ET les téléchargements (invisibles côté serveur).

### (A) — ✅ IMPLÉMENTÉ (flag OFF) — le crawl cède aux VIEWERS
**Fichier** : `supabase/functions/norva-playback/index.ts` (`userHasLiveSession` + boucle de
`runOneDimension` `~:4080`). **Flags** : `NORVA_CRAWL_YIELD_TO_VIEWERS` (défaut OFF) +
`NORVA_CRAWL_VIEWER_GRACE_MS` (`boundedInt`, défaut 300000, min 60000, max 900000).
Effet ON : (1) fenêtre « actif récemment » élargie à la grâce (couvre les ~8s de libération lente du
slot + le churn de reconnexion) ; (2) **re-check mi-tick** (~toutes les 8 batches) → si un viewer
démarre pendant un tick de ~100s, le crawl **abandonne le reste du tick** et reprend au curseur. OFF
= byte-identique. **À activer + tester** : longueur de grâce vs libération réelle du slot ; coût des
lectures indexées supplémentaires au volume du crawl. Neutre en prod tant que OFF.

### (B) — ⏳ SPEC — le TÉLÉCHARGEMENT préempte le crawl
Le download résout l'URL provider directe et **l'appareil télécharge en direct** (bridge natif APK,
IP résidentielle) — **aucune trace serveur** (`MoviesPage.js:~1811-1840` `startMovieDownload` →
`api.proxy.xtream.getStreamUrl` qui ne fait que **construire l'URL**, `server/routes/proxy.js:565`).
Donc rien à quoi le crawl puisse céder. **Fix** (flag `NORVA_DOWNLOAD_YIELD`) :
1. **Client** (`MoviesPage.js` + `SeriesPage.js`) : avant `bridge.downloadMedia(...)`, POST
   `playback/download-begin { sourceId, itemId, itemType, ttlSeconds }`.
2. **Edge** (`norva-playback/index.ts`, nouvelle route près de `:112-141`) : écrire une **balise
   d'activité courte** que le check (A) lit (option simple : table dédiée `provider_activity_beacon
   (identity_key, expires_at)` via migration + RPC `provider_identity_active(identity_key, grace_ms)`,
   pour ne PAS consommer un slot de stream d'entitlement) ; résoudre l'identité via
   `resolveSourceIdentity` (`:1120`) et **POSTer le gateway** pour préempter ses extractions de fond.
3. **Gateway** (`media-gateway/src/index.js`, route `POST /account-preempt` près de `/probe-audio`
   `:778`) : `preemptAccountExtractions(proxyKeyFromUrl(url), 'download start')` + si qqch stoppé et
   `PROVIDER_SLOT_RELEASE_DELAY_MS>0`, `await sleep(...)` avant 200 pour que le client attende la
   libération du slot avant le fetch natif.
**Non-testable ici** : le bridge de download natif APK n'est pas exécutable → beacon client + attente
native à **tester sur appareil** ; TTL/nettoyage de la balise (un download raté ne doit pas bloquer
le crawl → TTL court + `download-end`).

### (C) — ⏳ SPEC — budget de connexion (comptes 1-connexion) — RISQUE LE PLUS HAUT
`max_connections`/`active_cons` viennent du `user_info` Xtream, aujourd'hui lus **seulement en
diagnostic** (`norva-series-prewarm/index.ts:108-142`), **non persistés**. **Fix** (flag
`NORVA_CRAWL_CONNECTION_BUDGET`, à livrer EN DERNIER) : (1) capturer `max_connections` dans
`cloud_sources.config_hint` à la validation du compte (`norva-cloud/index.ts:~1196`) ; (2) étendre
`provider_footprint_policy` (`migrations/20260703140000`) + RPC budget ; (3) dans `runOneDimension`
(près du gate footprint `:3890`), si identité 1-connexion → exiger le signal viewer (A)+(B) clair et
traiter le crawl comme budget-0 dès qu'une activité humaine est fraîche. **Non-testable ici** :
fiabilité du `max_connections` rapporté (échantillonné, pas connu en continu) → tester sur l'identité
Ninja/`barfik` déjà seedée low_footprint.

---

## Récap flags (tout OFF par défaut = déploiement neutre)

| Levier | Où | Type | Effet quand ON | État |
|---|---|---|---|---|
| `MEDIA_GATEWAY_NVENC` | gateway env | **code** | transcode HW (GEX44), CPU ~0 | ✅ **implémenté** (flag OFF) |
| `MEDIA_GATEWAY_SINGLE_FLIGHT` | gateway env | **code** | 1 transcode/flux unique partagé (capacité ×N) | ⏳ à implémenter **avec test** (pré-vol) |
| Cache Rule `.ts` sur l'origine | Cloudflare | **config** | fan-out CDN (dépend du single-flight) | ⏳ config au pré-vol (`cloudflare-cdn.md` Option B) |
| `norva-live-hls-relay` | par-provider | **config** | live éligible → relay Cloudflare (pas de transcode) | ⏳ config au pré-vol, provider par provider |
| `NORVA_CRAWL_YIELD_TO_VIEWERS` (+`_GRACE_MS`) | edge env | **code** | crawl cède le slot aux viewers (grâce + re-check mi-tick) → anti-458 | ✅ **implémenté** (flag OFF), patch #5(A) |
| `NORVA_DOWNLOAD_YIELD` | edge+client | **code** | le téléchargement préempte le crawl (balise + préemption gateway) | ⏳ spec patch #5(B), test **device** |
| `NORVA_CRAWL_CONNECTION_BUDGET` | edge env | **code** | budget réservé aux humains sur comptes 1-connexion | ⏳ spec patch #5(C), en dernier |

**Pourquoi single-flight n'est PAS implémenté à l'aveugle ici** : c'est de la **logique de cycle de
vie distribuée** (refcount viewers à travers create `/sessions` + `DELETE /sessions/:id` + le sweep
d'expiration + `stopSession`), sur le **chemin critique de lecture live**, **non testable** dans cet
environnement. Un bug subtil (session coupée sous un viewer, fuite qui garde un slot provider → ban,
mauvaise `fanKey` qui mélange les pistes audio de 2 viewers) est **grave et plausible**. → On
l'implémente **pendant le pré-vol avec un test de charge réel** (spec précise dans le patch #1
ci-dessus). Le NVENC, lui, est un **simple échange d'args localisé** (OFF = `libx264` à l'identique),
donc sûr à livrer maintenant, flag OFF.

→ Le NVENC est **committé/déployé neutre** (flag OFF). Les 3 autres leviers s'**activent au pré-vol**
avec test, provider par provider, en mesurant. C'est ce qui rend la bascule *réversible et sûre*.
