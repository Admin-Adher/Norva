# Norva — Audit lecture VOD : crash « Hls is not defined » & cascade 458

> **Date : 2026-07-03.** Déclencheur : échec de lecture réel en production —
> `ReferenceError: Hls is not defined` (VideoPlayer.init) suivi d'une boucle
> `slot busy (458) → retry ×3 → « engine cannot demux » → transcode → 4XX → retry…`.
> Méthode : 4 lecteurs profonds en parallèle (chargement hls.js, arbre de décision
> WatchPage, cycle de vie des slots du relay, lane transcode du gateway) + recensement
> live des formats en base + suite de tests de régression automatisée.

## 1. La matrice réelle des formats VOD (recensement base, 763 140 variantes)

| Conteneur | Variantes | Chemin de lecture | Rail |
|-----------|-----------|-------------------|------|
| mkv | 387 330 (50,7 %) | Moteur WASM (demux/remux → MediaSource) | engine |
| mp4 | 366 618 (48,0 %) | Direct (h264+AAC stéréo) sinon moteur (HEVC/AC3/DTS) | relay / engine |
| avi | 5 613 | Transcode gateway (ffmpeg → HLS) | transcode |
| ts | 3 289 | Moteur WASM (variante mpegts, avcC synthétisé) | engine |
| m4v | 272 | Famille mp4 | relay / engine |
| wmv | 7 | Transcode gateway | transcode |
| flv | 1 | Transcode gateway | transcode |
| m3u8 (live + **sortie du transcode**) | — | **Hls.js** | hls |

Tiers de compatibilité posés par le sync : `direct` 361 853 · `remux` 371 090 ·
`video_transcode` 21 007 · `unknown` 9 180.

**Constat structurant** : la sortie du transcode gateway est du HLS consommé par Hls.js —
donc un runtime hls.js manquant ne casse pas « juste » les m3u8 : il casse **le rail de
fallback de tous les formats** (avi/wmv/flv d'office, et tout mkv/ts dont le moteur échoue)
plus toute la TV live.

## 2. Causes racines (vérifiées ligne à ligne)

1. **hls.js chargé uniquement depuis le CDN jsdelivr** (`app/index.html:48`, balise
   synchrone, zéro fallback). Adblocker, DNS d'opérateur, proxy d'entreprise ou panne
   CDN ⇒ `window.Hls` n'existe pas pour toute la session.
2. **`VideoPlayer.init()` déréférence `Hls` sans garde** (`Hls.isSupported()` l.1135) ⇒
   `ReferenceError` non rattrapé. Effets collatéraux : les raccourcis clavier (câblés
   APRÈS le bloc, l.1285) meurent aussi, et **le pipeline précédent n'est pas nettoyé —
   sa connexion provider reste ouverte, c'est elle qui occupe le slot et déclenche le 458
   de l'étape suivante.** 9 sites de déréférencement non gardés au total (VideoPlayer
   1135/1571/1690/1798/2345/2460, WatchPage 3544/3594) ; le fallback natif Safari
   (canPlayType, l.1751) était inatteignable car le crash arrivait avant.
3. **Bug regex décisif : `\b458\b` ne matche JAMAIS `BLOCK_HTTP_458`** (l'underscore est
   un caractère de mot en JS). Le message clair « one stream at a time » (l.2542) et la
   suppression de l'auto-refresh 2 s (l.5091) existaient déjà… mais ne s'activaient
   jamais pour le code réellement émis par le moteur ⇒ l'utilisateur voyait « Playback
   failed. » + retry automatique 2 s.
4. **458 traité comme « cannot demux »** : après les 3 retries slot-busy (2 s/4 s/6 s —
   tous DANS la fenêtre de libération ~8 s du provider), l'échec tombait dans le chemin
   générique ; `sourceHead` étant null (zéro octet téléchargé), le prédicat
   « realMediaDemuxFail » validait à tort le **fallback transcode = une connexion amont
   de plus sur un slot déjà saturé**.
5. **ffmpeg déguise le 458** en `"Server returned 4XX Client Error, but not one of
   40{0,1,3,4}"` (libavformat http.c — le nombre 458 n'apparaît jamais). Le classificateur
   de concurrence du gateway ne connaissait ni 458, ni 429, ni ce catch-all ⇒ **zéro
   retry** sur la lane transcode (contre une échelle 2 s/6 s/9 s sur la lane /raw) ⇒ 502
   opaque. Le hub local classait la même chaîne `UPSTREAM_REFUSED terminal:true`.
6. **Relay** : le 458 du provider était proxifié tel quel (ni `Retry-After`, ni corps
   structuré), et la fetch amont n'avait **pas d'AbortController** — une déconnexion
   client renvoyait la connexion provider au pool keepalive au lieu de la fermer,
   prolongeant l'occupation du slot.

## 3. Correctifs livrés (tous rails)

| Rail | Fix |
|------|-----|
| **Entrées HTML** (les 2) | hls.js **vendoré localement** (`public/js/vendor/hls-1.5.7.min.js`, 412 Ko, version épinglée identique) + `window.ensureHls()` promise-based : local d'abord, CDN en secours, cache, warm au boot. Plus aucune balise CDN sèche. |
| **VideoPlayer** | Bloc HLS d'init extrait en `setupHlsRuntime()` re-invocable quand ensureHls résout ; gardes `typeof Hls` sur les 6 sites ; `playHls()` : charge-puis-retente, sinon HLS natif (Safari), sinon erreur typée `HLS_RUNTIME_UNAVAILABLE` ; `await ensureHls()` en tête du chemin live ; le bloc forceVideoTranscode n'abandonne plus sa session au fallthrough. |
| **WatchPage** | Classificateur partagé `isProviderBusyError` (`(?:\b|_)458\b`) réutilisé partout (fix du bug regex dans `isConnectionLimitError` + `getFriendlyPlaybackError`) ; **branche terminale 458** : plus jamais de fallback transcode sur slot occupé — message clair + **UN** retry programmé à 15 s (au-delà de la fenêtre de libération, garde 1/min) ; cadence des retries in-line 4 s/8 s/12 s + drain du pipe entre tentatives ; `retryPlaybackInPlace` ne recharge plus la page sur un slot occupé ; `await ensureHls()` avant le routage HLS + garde sur son `playHls`. |
| **Gateway** (media-gateway) | `isProviderSlotBusyFailure` reconnaît 458/429/« max connection »/**le catch-all 4XX de ffmpeg** ; échelle de retry dédiée 2 s/6 s/9 s sur la lane transcode (l'auth garde son fast-fail) ; réponse **typée 503 `PROVIDER_BUSY` + `Retry-After: 8`** avec le token « (HTTP 458 max connections) » dans details (les classificateurs texte du client matchent) ; clause 458 dans `classifyProviderFailure` (xtream/probe). |
| **Hub local** | `upstreamError.js` : clause `UPSTREAM_PROVIDER_BUSY` (458, terminal:false) AVANT le catch-all terminal ; `transcode.js` : code retryable + échelle 2 s/6 s/9 s (l'ancienne 1,8 s+3,5 s plafonnait à 5,3 s — toujours dans la fenêtre) + `Retry-After`. |
| **Relay** (Cloudflare) | `AbortController` sur la fetch amont + `abortOnCancel()` : une déconnexion client **ferme** la connexion provider au lieu de la rendre au pool keepalive ; passthrough 458 : `Retry-After: 8` + corps JSON structuré `{code:'PROVIDER_BUSY', retryAfterMs}` ; `retry-after` exposé au navigateur (CORS). |

## 4. Tests

`tests/vod-playback-matrix.test.js` (11 tests, `node --test`) verrouille :
- chaque format de la matrice de production a un chemin de lecture défini (aucun trou) ;
- mkv/mp4/m4v/ts/webm/mov → moteur ; avi/wmv/flv → transcode (jamais le moteur) ;
- `isProviderBusyError` matche `BLOCK_HTTP_458`/`PROBE_HTTP_458`/« max connections »/le
  détail typé du gateway — et ne matche PAS les vraies erreurs demux
  (SOURCE_UNSUPPORTED_CONTAINER, DEMUX_OPEN, 404, « v45.8 »…) ;
- `isConnectionLimitError` matche désormais `BLOCK_HTTP_458` (régression du bug `\b`) ;
- le déguisement ffmpeg-458 classe `UPSTREAM_PROVIDER_BUSY` retryable (et un 404 reste
  terminal) ;
- hls.js vendoré présent, > 300 Ko, parse ; les 2 entrées ont le loader local-d'abord et
  plus aucune balise CDN-seule ; **plus aucun `Hls.isSupported()` non gardé** dans
  VideoPlayer/WatchPage (scan de source).
`tests/upstreamError.test.js` (existant) reste vert.

## 5. Comportement résultant, format par format

- **mkv/ts/mp4-HEVC (moteur)** : échec demux réel → transcode (inchangé) ; **slot occupé
  → message clair + retry unique 15 s** (fini la tempête de connexions).
- **avi/wmv/flv (transcode d'office)** : slot occupé au démarrage ffmpeg → 3 retries
  serveur espacés 2 s/6 s/9 s ; échec final → 503 typé + Retry-After (plus de 502 opaque).
- **m3u8 / sortie transcode / live (Hls.js)** : le runtime est local — un adblocker ou
  une panne CDN ne casse plus rien ; à défaut absolu, HLS natif Safari, sinon erreur
  typée qui route vers le ladder au lieu d'un crash.
- **Session fantôme** : la connexion amont du relay se ferme dès que le client décroche —
  le slot se libère réellement au lieu de traîner dans le pool keepalive.

## 6. Lot P1 — ledger de slots raw↔transcode (LIVRÉ, 2ᵉ passe même jour)

Le design retenu évite tout coût sur le hot path des chunks : la comptabilité se fait
**au resolve** (une fois par titre) et **en mémoire du gateway** (zéro round-trip réseau
par range request).

- **Gateway — ledger de pumps** (`rawPumps`) : chaque pipe `/raw` est enregistrée avec
  son `sid` (session de lecture) + `proxyKey` (host+username provider) + `ownerHash`
  (sha256 du userId). Règles :
  1. une **nouvelle session** de lecture aborte les pumps de la session PRÉCÉDENTE sur
     le même compte (le déclencheur exact du bug : un crash/retry moteur laissait
     l'ancienne pump drainer le slot) — les lectures range **concurrentes de la même
     session sont épargnées** (`keepSid`) ;
  2. un **démarrage transcode** (`POST /sessions`) aborte les pumps raw du même compte
     avant de lancer ffmpeg (comptées dans le sleep de libération) ;
  3. **`DELETE /raw-pumps?ownerKey=<sha256>`** : kill-switch cross-device pour le
     coordinateur (jamais d'identifiants bruts — hash uniquement).
- **Coordinateur DO (relay)** :
  - `loadState` **fauche réellement** les enregistrements expirés (avant : drop
    silencieux pendant que le ffmpeg/pump zombie tenait le slot) — DELETE gateway pour
    les sessions transcode, `/raw-pumps` pour la lane raw ;
  - **`alarm()`** : reaping sans trafic, armé par `saveState` sur la prochaine expiration ;
  - `start()` fauche aussi les conflits qu'il écartait silencieusement ; `end()` aborte
    les pumps de la session terminée ;
  - **waitMs proportionné** : 8 s seulement si un ffmpeg gateway a été évincé ; 1,5 s si
    seulement une pump raw (l'abort coupe le TCP immédiatement) ; 0 sinon — fini le
    stall aveugle.
- **Edge (norva-playback)** : le mode `enginePipe` (raw) passe par le MÊME
  prepare→wait→commit que le transcode (`lane:"raw"`), donc : démarrer le moteur évince
  un transcode fantôme (DELETE réel → slot libéré), démarrer un transcode évince la pipe
  d'un autre appareil. Coordinateur indisponible → comportement identique à avant
  (best-effort).
- **Erreurs typées** : chaîne vérifiée de bout en bout — gateway `503 {code:PROVIDER_BUSY,
  details:"…(HTTP 458 max connections)"}` → edge `HttpError.details` → client
  `error.payload` + message (les classificateurs matchent sans string-scraping fragile).
- Tests : +4 tests de câblage (`tests/vod-playback-matrix.test.js`, 26/26 verts au total)
  verrouillent le ledger, le keepSid, le kill-switch, l'alarm et la lane raw.

Sonde bytes=0-0 du relay Cloudflare sous contention : non traitée (le chemin moteur ne
passe pas par le relay CF ; impact résiduel négligeable).
