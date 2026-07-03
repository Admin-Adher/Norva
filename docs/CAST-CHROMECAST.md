# Cast Chromecast (web sender) — architecture & Lot A (2026-07-03)

Casting du player VOD web vers un Chromecast / Google TV. Sender Google Cast monté
sur le **Default Media Receiver** de Google (pas de récepteur custom → pas
d'enregistrement Google Cast Developer Console). Actif sur Chromium uniquement,
jamais dans les APK natifs (`NorvaTV-Android` → no-op, ils ont leur propre cast).

Livré en 1 commit (branche `claude/webm-block-additions-error-pj16xm`).

---

## 1. Carte du code

| Fichier | Rôle |
|---|---|
| `public/js/utils/castSender.js` (`window.NorvaCast`) | Wrapper SDK Cast : injection paresseuse, découverte, `castMedia`, transport (seek/pause/position/duration), fin de session. |
| `public/js/pages/WatchPage.js` | Intégration player : bouton, résolution d'URL castable, sous-titres, barre de contrôle, sync de progression, épisode suivant. |
| `public/app.html` | `#watch-cast` dans la barre de contrôle (près de PiP/plein écran). |
| `public/css/main.css` | `.watch-cast-bar*` (barre enrichie), `.watch-btn.is-casting`. |

### Flux
1. `setupCastIntegration()` (au montage) : injecte le SDK, câble `#watch-cast`,
   pilote la visibilité du bouton via `CAST_STATE_CHANGED`.
2. `startCasting()` : calcule l'URL castable, ouvre le sélecteur (`requestSession`),
   `loadMedia`, libère le slot fournisseur local, ouvre la barre, démarre la sync.
3. Le récepteur récupère lui-même l'URL (HLS gateway / MP4 relais / playlist
   transcode). Le blob MSE du moteur WASM n'est **pas** castable → re-résolu en
   transcode gateway avant cast.

---

## 2. Lot A — quick-wins (Default Media Receiver)

### 2.1 Annuler ≠ erreur
`ctx.requestSession()` rejette avec `cancel` (string) ou `err.code === 'cancel'`
quand on ferme le sélecteur. `castSender.isCancel()` le détecte, `castMedia` relève
une erreur `.code='cancel'`, et `startCasting()` la traite **en silence** (fini le
toast « Cast unavailable » et le `[WatchPage] Cast failed: cancel` en console). La
lecture locale reprend là où elle était (`retryPlaybackInPlace(position)` si le
pipeline avait été démonté, sinon `video.play()`).

### 2.2 Sous-titres au cast
`castMedia({ subtitles })` monte les VTT en `chrome.cast.media.Track` (TEXT /
SUBTITLES) et pose `activeTrackIds`. Le récepteur récupère chaque `trackContentId`
lui-même → il faut une **URL absolue ou une `data:` URI**.

`WatchPage.getCastSubtitles(castUrl)` résout :
- **Piste embarquée sélectionnée** (`getSelectedSubtitleTrack`) → sidecar
  `sub_<index>.vtt` (dérivé de la playlist gateway/HLS, ou `gatewaySubtitleUrlForTrack`).
  **URL HTTP fiable.**
- **Sinon** sous-titres IA/traduits actifs (texte en mémoire, `_aiActiveVtt` posé par
  `attachGeneratedSubtitleTrack`, nettoyé par `clearExternalSubtitleTracks`) →
  `data:text/vtt;base64,…` (garde-fou taille < 700 ko b64). **Best-effort.**
- **Sinon** `[]` → cast sans sous-titres.

**Sécurité** : si le récepteur refuse la piste, `castMedia` **retente `loadMedia`
sans piste** → les sous-titres ne peuvent jamais casser la lecture.

### 2.3 Garde-fou formats
`isCastSafeDirectUrl(url)` : mkv / ts / avi / mov / m2ts / mpg… → `false`. Ces
conteneurs (et le HEVC dans un mux legacy) ne partent plus **en direct** au Default
Receiver (échec opaque) : ils passent par le **transcode gateway** comme les titres
moteur. Extensions sûres (m3u8 / mp4 / webm) ou chemin de session sans extension →
direct.

### 2.4 Progression pendant le cast
Le player local est éteint pendant le cast → `startCastProgressSync()` sauvegarde la
position (`remotePosition() + _castBaseOffset`) via `POST /history` **toutes les 10 s**
et **flush sur `pagehide` / onglet caché**. Continue Watching reste à jour même si
l'onglet se ferme. `saveCastProgress()` reprend le même payload que `saveProgress`
(titre/épisode/durée), sans dépendre de `<video>`.

### 2.5 Barre de cast enrichie
`showCastBar()` : affiche + titre, **barre de seek scrubbable** + temps courant/total,
**−10 s / play-pause / +10 s**, **épisode suivant** (`castNextEpisode` : recharge sur
la **même session**, sans nouveau sélecteur), Stop. Rafraîchie 1×/s (`updateCastBar`).
`_castBaseOffset` gère l'offset des playlists transcode-depuis-position : temps absolu
= `_castBaseOffset + temps récepteur`.
Auto-nettoyage : si `isCasting()` repasse à faux après confirmation
(`_castConfirmed`), la session a été coupée depuis la TV → `stopCasting()`.

### 2.6 Découvrabilité
`#watch-cast` vit dans la barre de contrôle (markup, plus de bouton flottant),
`.hidden` par défaut, révélé par `updateCastButton()` dès qu'un device est découvert
(events `CAST_STATE_CHANGED` + quelques ticks courts, **fin du trou aveugle de 4 s**).
Accent `.is-casting` quand une session est active.

---

## 3. Contraintes & limites assumées

- **Blob MSE non castable** : le moteur WASM transcode en MPEG-TS côté navigateur ; le
  récepteur ne peut pas l'exécuter → re-résolution transcode gateway obligatoire
  (coûte une reconnexion fournisseur, gérée par `releasePlaybackPipelineForRetry` +
  `waitForProviderSlotRelease`).
- **Compte fournisseur mono-connexion** : le récepteur prend le slot ; on libère le
  local **avant** de rendre la main. Timing (800 ms) = point fragile connu.
- **Sous-titres IA en `data:` URI** : best-effort ; le retry-sans-piste garantit la
  non-régression, mais l'affichage réel dépend du récepteur. Les sous-titres
  embarqués (sidecar HTTP) sont fiables.
- **HEVC dans un `.mp4`** : décodage dépendant du modèle de Chromecast, non détectable
  via l'URL → c'est le chemin d'erreur (message clair) qui prend le relais.
- **Splash générique Google** sur la TV (pas de branding Norva) — limite du Default
  Receiver, levée par le Lot B.

---

## 4. Reste chantier — Lot B (récepteur CAF custom)

Nécessite un **app ID enregistré** (Google Cast Developer Console) + une **page
récepteur hébergée**. Débloque :
- Branding Norva sur la TV (splash + artwork).
- Rendu natif des sous-titres + **sélecteur de piste audio** sur le récepteur.
- **File d'attente** d'épisodes (autoplay côté récepteur).
- Contrôleur étendu riche.

Hors récepteur, restent aussi : **cast depuis les fiches / le catalogue** (pas
seulement depuis le player), **AirPlay iOS** (Safari n'a pas le Cast SDK), **cast du
live TV** (`live:false` en dur aujourd'hui).
