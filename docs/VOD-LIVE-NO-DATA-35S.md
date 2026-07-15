# VOD / Live TV — « No data received (35s timeout) » (récupération du watchdog + fallback live)

**Statut : corrigé** (branche `claude/vod-live-tv-error-c7xasm`, commits `1c5800d`
+ `53cff50`). Clients natifs : nécessite un **build des APK** (TV + téléphone) pour
prendre effet ; le volet live nécessite aussi un **déploiement web**.

---

## 1. Symptôme

En plein visionnage d'une **VOD** ou d'un **live TV**, le lecteur natif Android TV
(et téléphone) affiche, sur écran noir à 00:00 :

> **No data received (35s timeout).**
> The provider accepts the connection but sends no playable stream.
> Host: super8k.top

Critique : cul-de-sac, aucune récupération automatique.

## 2. Cause immédiate — le watchdog client

Le message est peint **côté client** par un watchdog de 35 s, pas par le serveur.

- `clients/android-tv/…/PlayerActivity.java:148` → `BUFFER_TIMEOUT_MS = 35_000L`
- `…:215-224` → le `Runnable bufferWatchdog` (texte exact)
- `…:313-321` → armé quand ExoPlayer entre en `STATE_BUFFERING`, annulé sur tout
  autre état / erreur.

Il se déclenche donc quand le flux **connecte mais n'atteint jamais `STATE_READY`
en 35 s**, **sans lever `onPlayerError`**. `Host: super8k.top` = l'URL **directe** du
provider (`EXTRA_URL`).

## 3. Cause prochaine + racines

Le résolveur (`supabase/functions/norva-playback/index.ts:2094-2099`) choisit le mode
**`direct`** par défaut pour VOD **et** live natif (`public/js/api.js:1527-1534`), et
renvoie l'URL Xtream brute (`index.ts:346`). Le provider `super8k.top` accepte la
connexion TCP/HTTP mais ne délivre pas d'octets démuxables.

Causes racines (classées) :

1. **Contention du slot unique** super8k (`max_connections:1`, 22+ miroirs partagent
   un slot) — sondes de fond en journée, connexion zombie du titre précédent, zapping
   avant la « traîne de libération ~8 s », 2ᵉ appareil, download.
   Réf. `docs/LIVE-TV-458-SLOT-CONTENTION.md`.
2. Bytes **non-média** dans un faux HTTP 206 (lien expiré/mort, mur géo/auth, mp4
   moov-at-end) — ExoPlayer reste en BUFFERING sans erreur.
3. Blocage IP-datacenter / UA-navigateur sur un chemin mal routé (tarpit silencieux).
4. Reprise lointaine (Range ouvert ignoré → relecture depuis 0 → time-to-first-frame
   > 35 s).

## 4. Le défaut d'architecture (le cœur)

Le fallback passerelle (`switchToFallback`), **conçu pour ce cas**, n'était atteignable
que depuis `onPlayerError` sur erreur IO. Un stall **silencieux** ne lève aucune
`onPlayerError` → le `bufferWatchdog` (sans aucune récupération) était l'état terminal.
Aggravé par : le **live n'avait aucun fallback** (`ChannelList.js` passait une simple
chaîne → `fallbackUrl=null`), et le watchdog ne remontait pas `broken` en télémétrie.

## 5. Correctif

### Levier 1 — récupération dans le watchdog (commits `1c5800d`, `53cff50`)
`clients/android-tv/…/PlayerActivity.java` + `clients/android-phone/…/PlayerActivity.java` :
au lieu de seulement afficher l'erreur, le watchdog exécute désormais l'**échelle de
récupération** : (1) bascule vers le `fallbackUrl` passerelle (une fois) ; (2) sinon une
re-préparation différée (le provider libère son slot ~8 s après la connexion précédente) ;
(3) sinon affiche l'erreur **et** remonte `reportPlaybackStatus("broken", …)`.

- TV : budget de re-prépa via `playRetries` (déjà remis à 0 sur `STATE_READY`).
- Téléphone : nouveau garde `watchdogRetried`, remis à `false` sur `STATE_READY`
  (`53cff50`, symétrie avec le TV — sinon un 2ᵉ stall dans la même session sautait la
  récupération).

### Levier 2 — propagation du fallback au live (commit `1c5800d`)
- `public/js/components/ChannelList.js` : passer le payload résolveur (`result`) en 3ᵉ
  argument de `player.play(channel, streamUrl, playbackPayload)`.
- `public/js/utils/standalone.js` : l'override `VideoPlayer.prototype.play(channel,
  streamUrl, playback)` lit `playback.fallbackUrl` (comme la VOD).

Vérifié : le live natif est bien en `mode='direct'` (le chemin relay-HLS est gated
`!hasNativeOrLocal`, `api.js:1436`), donc l'edge attache un `fallbackUrl` byte-pipe, et
le handler `/raw` de la gateway streame un `.ts` live en passthrough progressif.

### Levier 3 — activer le verrou « account-busy » (commit `1c5800d`)
Câblage repo de `NORVA_EDGE_CALLBACK_BASE` (lu par `services/media-gateway/src/index.js:3611`) :
- `ops/hetzner/media/docker-compose.media.yml` : `NORVA_EDGE_CALLBACK_BASE: ${NORVA_EDGE_CALLBACK_BASE:-}`
- `.env.example` : documenté.

⚠️ **Action ops restante** : poser la **valeur** (URL de la fonction `norva-playback`,
ex. `https://api.norva.tv/functions/v1/norva-playback`) dans l'env du gateway (Railway
dashboard ou `.env.media`) + redéployer. Sans elle, le rapporteur reste inerte
(`account-activity reporter IDLE …`). Cf. `docs/LIVE-TV-458-SLOT-CONTENTION.md`.

## 6. Comportement après correctif

Au pire (fallback aussi en échec) l'écran d'erreur apparaît après ~105 s au lieu de
35 s, mais avec de **vraies tentatives de récupération** entre-temps (fallback → re-prépa)
au lieu d'un cul-de-sac immédiat. La plupart des cas récupèrent dès le fallback.

## 7. Déploiement

- Leviers 1 & 2 : **builder les APK** Android TV + téléphone (code natif) ; levier 2
  nécessite aussi le **déploiement web** (`public/`).
- Levier 3 : poser `NORVA_EDGE_CALLBACK_BASE` + redéployer le gateway (action ops).
