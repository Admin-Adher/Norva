# Norva — Lecture moteur web : débogage, correctifs & runbook

> Doc d'ingénierie consolidée de la campagne de fiabilisation de la **lecture
> mkv côté navigateur** (NorvaEngine → MediaSource), incl. le contournement du
> blocage d'IP datacenter par proxy résidentiel et l'infra de diagnostic.
>
> Lis aussi : `ARCHITECTURE-RELIABILITY.md` (ADR datacenter-IP, plan stratégique),
> `WEBENGINE-HEVC-PLAYBACK.md`, `WEBENGINE-GATEWAY-INBAND-PROBE.md`,
> `NORVA-WORK-STATUS.md` (tracker court).

## 0. Rappel du pipeline de lecture

```
Navigateur (NorvaEngine, libav.js WASM)
   │  byte-range GET /raw/:token
   ▼
media-gateway (Railway)  ──►  Fournisseur IPTV (provider)
   │
NorvaEngine remuxe MKV → fMP4 (ftyp+moov init, puis moof+mdat) → MediaSource/SourceBuffer
```

- **`direct`** : le navigateur lit l'URL nativement (mp4) → connexion **navigateur → provider** (IP **résidentielle** de l'utilisateur). Pas de moteur, pas de gateway.
- **`engine`** : NorvaEngine tire les octets via `/raw` sur la gateway → connexion **gateway → provider** (IP **datacenter** Railway). Nécessaire pour mkv/HEVC/AC-3… que le navigateur ne lit pas nativement.
- `CHUNK_DEMUXER_ERROR_APPEND_FAILED` (`MediaError.code === 3`) = Chromium refuse les octets `appendBuffer`és (init ou fragment mal formé / incohérent).

## 1. Surfaces de déploiement (toutes auto-déployées sur push `main`)

| Surface | Quoi | Déploiement | Vérif version |
|---|---|---|---|
| Client (`public/js/**`) | Cloudflare Pages | `deploy-cloudflare.yml` (hash `?v=` auto) | `ENGINE_VERSION` dans le log `timings` |
| Edge functions | Supabase (bundle CLI) | `deploy-supabase-functions.yml` | `curl $EDGE/...` |
| Relais | Cloudflare Worker | `deploy-relay.yml` | — |
| media-gateway | Railway (Dockerfile) | auto-build sur `main` | `GET /health` → `version` |

⚠️ Edge functions : **uniquement via la CLI Supabase** (bundle des imports `../_shared`). Jamais via un outil MCP qui n'agrège pas (plante au boot).

## 2. Infra de diagnostic (la clé de toute la campagne)

Le `CHUNK_DEMUXER` ne disait que « code=3 ». On a ajouté un **snapshot complet** du moteur au moment de l'échec, loggé en console ET persisté en télémétrie.

### `engineSnapshot()` (`public/js/norvaEngine.js`)
Renvoie, en lecture seule :
- **Codec/mime** : `mime`, `videoCodecString`, `videoCands`, `audioTag`, `vName`, `aName`, `copyAudio`, `durationSec`.
- **Sortie muxer** : `initBoxes`/`initBytes` (segment d'init), `firstMediaBoxes`/`firstMediaHex` (1er fragment), `boxSeq`/`boxHex` (séquence de boîtes top-level reconstituée), `moofCount`/`moovCount`/`ftypCount`, `firstVideoPkt` (keyframe ? PTS/DTS), `droppedOpenGop`.
- **Écritures muxer** : `writes` (trace `{pos,len,seek,hex}` des 40 premières), `seekWrites` (nb d'écritures en **arrière** = muxer non-séquentiel), `firstSeek`, `writeHighWater`.
- **Append MSE** : `appendCount`/`appendBytes`, `recentAppends` (ring), `appendErrors`, `sbErrorEvents`, `trailerBytesDropped`, `queueLen`.
- **Sortie du pump** : `pumpExitReason` (`eof`/`readerr`/`stop`), `pumpExitRes`, `lastReadError`, `exitFetchMB`.
- **État live** : `sb` (buffered ranges, updating, timestampOffset), `ms` (readyState, duration), `video` (readyState, networkState, `error.code`, paused).

Câblé dans `WatchPage.reportEngineFailure()` : groupe console + champs clés dans la télémétrie `playback_error`.

> ⚠️ **Piège résolu** : libav.js passe `data` (onwrite) en **`Int8Array` signé**
> (HEAP Emscripten). Lire `octet<<24` sur du signé corrompt les calculs (0xA1 → 0xFFFFFFA1).
> Le moteur copie désormais en `Uint8Array` non-signé avant tout diagnostic
> (les octets envoyés à MSE sont identiques — c'était un bug de **diagnostic**, pas de lecture).

### Lire la télémétrie sans copier-coller (Supabase)
Les events partent dans `cloud_playback_events` ; le snapshot complet est dans `metadata.engineSnapshot`.

```sql
-- derniers échecs avec le détail moteur
select created_at, error_code, playback_mode,
       metadata->'engineSnapshot'->>'engineVersion' as ev,
       metadata->'engineSnapshot'->>'seekWrites'    as seeks,
       metadata->'engineSnapshot'->>'boxSeq'        as boxes,
       left(error_message, 120) as err
from cloud_playback_events
where event_type = 'playback_error'
order by created_at desc limit 10;

-- succès vs échecs en mode engine, par source
select e.event_type, e.playback_mode, s.display_name,
       count(*) , max(e.created_at)
from cloud_playback_events e
left join cloud_sources s on s.id = e.source_id
where e.created_at > now() - interval '1 hour'
group by 1,2,3 order by max(e.created_at) desc;
```
`first_frame` / `play_started` en `playback_mode='engine'` = la lecture mkv marche.

## 3. Bugs trouvés & corrigés (chronologie)

### Bug #1 — crash ~7 s : trailer MP4 appendé (ENGINE_VERSION 17)
- **Symptôme** : la lecture jouait quelques secondes puis `CHUNK_DEMUXER`.
- **Cause** : à la fin (ou sur arrêt anticipé de lecture), `av_write_trailer` écrit la boîte `mfra`/`mfro` (index de seek **fichier**). Elle était mise en file et `appendBuffer`ée → Chromium ne sait pas parser un `mfra` comme segment média.
- **Fix** : flag `_dropWrites` autour de `av_write_trailer` → les octets du trailer ne sont **jamais** envoyés à MSE. `endOfStream()` finalise proprement.

### Bug #2 — `CHUNK_DEMUXER` à l'ouverture/reprise mkv : muxer seekable (ENGINE_VERSION 22) ✅ racine
- **Symptôme** : reprise (`startTime>0`) → buffer construit ~7 s → `CHUNK_DEMUXER`.
- **Diagnostic** : `seekWrites=3`, `firstSeek {pos:2883604,len:4, highWater:2883632}` → le muxer **revient en arrière** écrire des champs de taille de 4 octets (movenc finalise un fragment).
- **Cause** : `ff_init_muxer({device:true})` installe un writer **seekable** (`mkwriterdev`). Sur sortie seekable, movenc patche les tailles par **seek arrière**. Le moteur transmettait les chunks onwrite à MSE **dans l'ordre des appels** → ces patches tardifs atterrissaient au mauvais offset → flux corrompu.
- **Fix** : créer la sortie en **writer NON-seekable** (`lib.mkstreamwriterdev('output')`) puis `ff_init_muxer({device:false, open:true})`. movenc bascule en **streaming pur** : tailles calculées à l'avance (`frag_keyframe` bufferise le fragment), écriture **strictement en avant**, zéro patch. C'est le contrat fMP4-pour-MSE. → `seekWrites=0`.

### Bug #3 — spinner infini / 458 au démarrage : zombie de connexion (ENGINE_VERSION 20)
- **Symptôme** : `PROBE_HTTP_458` au premier octet, UI bloquée sur le spinner.
- **Cause** : à la fermeture, `destroy()` ne coupait **pas** les fetch en vol → l'ancienne connexion provider traînait jusqu'à son timeout (30-60 s), tenant le slot unique → le titre suivant `458`.
- **Fix** :
  - `destroy()` déclenche un `AbortController` moteur (`this._ac`) qui annule **tous** les fetch (`_probeSize`, `_fetchRange`) → la connexion tombe tout de suite, slot libéré en ~8 s.
  - `playWithEngine` **retente** une charge `458` (3 essais, backoff 2/4/6 s) avec statut visible « Flux occupé, reconnexion… » au lieu d'échouer sur un spinner.
  - Engine : sur blocage `401/403/429/458` au prefetch, **ne pas ouvrir une 2ᵉ connexion** pour re-sonder la taille (évite de doubler la charge sur un mono-slot).
  - Gateway (`GATEWAY_VERSION 50`) : moins de retries `458`, espacés plus large (3 essais, gaps 1,5/5/9 s) → laisse le provider « respirer » pour libérer le slot.

### Bug #5 — `DEMUX_OPEN:Could not open source file` (reprise) : octets non-média servis en 206 (ENGINE_VERSION 24)
- **Symptôme** : à la reprise (`restoreFromResumeSnapshot`), échec immédiat `stage:'load'` avec
  `message:'DEMUX_OPEN:Could not open source file'`. **`size` connu** (ex. 863 MB), **`lastReadError:null`**,
  `0 fetch`, aucune piste détectée (`mime:null`).
- **Diagnostic** : la reprise re-résout pourtant une URL **fraîche** (`getStreamUrl`, token valide) — la
  1ʳᵉ fenêtre se télécharge (d'où la taille), donc **pas** un souci d'auth/expiration. libav reçoit des
  octets authentifiés qu'il **ne sait pas ouvrir**, sans erreur de read → soit le provider/proxy a renvoyé
  une **page d'erreur (HTML) / un JSON** en **206** (lien expiré côté provider, flux hors-ligne, mur
  géo/auth sur le fichier), soit un mp4 **moov-at-end** dont le provider falsifie les Range de queue.
- **Fix (diagnostic + message clair, sans risque sur le happy-path)** : `_openInput` capture la **tête de
  la source** (`_captureSourceHead`, lecture **cache-only**, 64 o) et la classe : un 1ᵉʳ octet imprimable
  `<` → HTML, `{`/`[` → JSON (un vrai conteneur démarre par une taille de box / magie EBML **non
  imprimable** → zéro faux positif). Si non-média → on lève **`SOURCE_NOT_MEDIA:<kind>:<extrait>`** au lieu
  du `DEMUX_OPEN` générique ; sinon on garde `DEMUX_OPEN` (conteneur réellement illisible). La tête est
  exposée dans `engineSnapshot().sourceHead` (loggée + télémétrie), donc la prochaine occurrence dit
  **exactement** quoi. `getFriendlyPlaybackError` mappe `SOURCE_NOT_MEDIA` (« le provider a renvoyé une page
  d'erreur au lieu de la vidéo ») et `DEMUX_OPEN` (« ouvre dans l'app »).
- **Cause confirmée (ENGINE_VERSION 25)** : `sourceHead` a renvoyé `kind:media` avec **1ᵉʳ octet 0x47**
  (`'G'`) = **octet de sync MPEG-TS**. Le build libav custom (`libav-6.8.8.0-norva.wasm`) n'embarque que
  les démuxeurs **Matroska/WebM + QuickTime/MOV (mp4)** — **pas** MPEG-TS/PS, AVI, WMV/ASF, FLV. Donc un
  film servi en **`.ts`** (fréquent côté IPTV) routé vers le moteur → `DEMUX_OPEN`. Or la décision
  d'éligibilité moteur (`api.js`, `engineVod`) ne prenait **que** « non browser-safe », donc TS/avi/wmv/
  flv/mpeg/vob partaient au moteur incapable.
- **Fix (3 couches, ENGINE_VERSION 25)** :
  1. **`api.js`** — `engineVod` exige désormais `engineCanPlayContainer(container)` (allowlist
     mkv/webm/mp4/mov/…). Un conteneur connu non-démuxable part directement au **gateway transcode**.
  2. **Moteur** — `_sourceLooksLikeMpegTs()` (sync 0x47 au stride 188 / M2TS 192) lève
     `SOURCE_UNSUPPORTED_CONTAINER:mpegts` **avant** d'attaquer libav (cas d'un conteneur mal-étiqueté
     `mp4` qui est en fait du TS — typique d'une reprise).
  3. **Player** — `fallbackEngineToTranscode()` : sur un échec moteur **média réel** (signal explicite,
     ou `DEMUX_OPEN` dont `sourceHead.notMedia !== true`), re-résout en `mode:'transcode'` et joue le
     gateway-session. Ne tourne **qu'après** un échec moteur → zéro régression sur un titre qui marche.
     Une tête **non-média** (page d'erreur provider) n'est **pas** retentée (le transcode re-tomberait
     sur la même erreur).
- **Suite — barre de progression sur un transcode TS (GATEWAY_VERSION 57)** : le TS rejoue bien via le
  gateway transcode, mais **sans timeline** : le MPEG-TS n'a pas de durée globale → `ffprobe`
  `format.duration` vide → `codecProfile.durationSeconds` nul → pas de `durationHint` → pas de seek bar
  (et le transcode à la volée est une playlist HLS qui grandit, sans `#EXT-X-ENDLIST`). Toute la
  plomberie durée existe déjà (gateway `codecProfile.durationSeconds` → edge → client `durationHint`) ;
  seul **le chiffre** manquait. Fix : `estimateDurationFromFormat()` (gateway) = `size*8/bitrate`
  (estimation CBR) quand `format.duration` est absent → remplit `durationSeconds` → seek bar. Ne touche
  rien quand `ffprobe` donne déjà une durée.
  - **Vraie racine (GATEWAY_VERSION 58)** : l'estimation v57 ne tournait jamais car la **sonde codec
    était purement et simplement désactivée pour le TS** ! `shouldProbeCodecProfile()` faisait
    `if (container === 'm3u8' || container === 'ts') return false;`. Or le live est déjà exclu plus haut
    (`streamType==='live'`), donc cette ligne ne bloquait que le **TS VOD**. Résultat : aucun
    `codecProfile` → aucune durée. Cross-check DB : `cloud_media_items.playback_hint.codecProfile` pour
    le titre = `durationSeconds`/`bitRate`/`probedAt` **tous nuls**. Fix : ne plus exclure `ts` (ni
    `m2ts`/`mts`) pour la VOD — seul `m3u8` (playlist, pas un fichier) et le live restent exclus. La
    sonde s'exécute avant le transcode (séquentiel → pas de 2ᵉ connexion concurrente sur un mono-slot),
    est cachée, et un échec est mémorisé (dégradation propre). Logs de diag ajoutés côté player
    (`[WatchPage] timeline diag`) : `codecProfilePresent`, `codecProfileDurationSeconds`, `durationHint`.

### ❓ Pourquoi les VOD `.ts` passent par le gateway (et pourquoi c'est plus lent à charger)
**La cause en une ligne : le moteur in-browser ne sait pas démuxer le MPEG-TS.** Le moteur
(`NorvaEngine`) est un **libav compilé en WASM** (`libav-6.8.8.0-norva.wasm`), volontairement **léger** :
il n'embarque QUE les démuxeurs **Matroska/WebM + QuickTime/MOV (mp4)**. Pas de démuxeur **MPEG-TS**.
Donc un fichier `.ts` ne peut **physiquement pas** être ouvert/remuxé dans le navigateur (`DEMUX_OPEN`),
et l'éligibilité moteur (`api.js` → `engineCanPlayContainer`, allowlist `mkv/webm/mp4/mov/…`) l'écarte
d'office → il part au **gateway transcode**.

**Pourquoi le gateway est plus lent que le moteur :**
- Moteur (mkv/mp4) = **remux stream-copy en local**, dans le navigateur, directement depuis le byte-pipe.
  Pas de ré-encodage, pas de saut serveur → démarrage quasi instantané.
- Gateway (ts) = **ré-encodage serveur complet** (ffmpeg) → HLS segmenté → re-télécharge à travers le
  proxy résidentiel. On force le **transcode complet** (pas un simple remux-copy) car un copy TS→HLS est
  peu fiable (discontinuités PCR/timestamps → `manifestLoadError`). Ré-encoder = CPU + latence de
  démarrage (il faut transcoder en avance avant de servir les segments). D'où le « ça marche mais c'est
  plus long ».

**✅ FAIT (ENGINE_VERSION 26) — TS lisible en navigateur.** Le WASM a été **recompilé avec le démuxeur
`mpegts`** (+ parsers h264/hevc/aac/mpeg). Le moteur remuxe maintenant le `.ts` **en local** comme un
mkv (rapide, sans gateway) pour le cas courant **H.264/HEVC + AAC/AC3** (transcode audio client si AC3).
- **Build** : impossible dans le sandbox de dev (le proxy tronque la chaîne Emscripten ~1 Go, `git clone`
  externe bloqué) → workflow **GitHub Actions `build-libav-wasm`** + `scripts/build-libav-norva.sh` qui
  reconstruit la config exacte (énumérée depuis le WASM livré : démux mkv/mp4 + mux fMP4 + décodeurs
  audio + encodeur AAC, **aucun décodeur vidéo**) **+ `demuxer-mpegts`**, build sur runner propre, recommit
  du WASM. Config validée en local d'abord (`mkconfig`), `mpegts` vérifié enregistré après build
  (`av_find_input_format('mpegts')≠0`).
- **Routage** (`api.js`) : `ts/mpegts/m2ts/mts` ajoutés à `ENGINE_DEMUXABLE_CONTAINERS` → le `.ts` part
  au moteur. Il reste dans le set « conteneur unsafe » → repli gateway transcode conservé.
- **Garde-fou** (`WatchPage.onError`) : un TS que le moteur démuxe mais que le **navigateur ne sait pas
  décoder** (MPEG-2 vidéo, HEVC sans support navigateur) échoue à l'append après un load propre →
  **repli gateway transcode** (via `engineSnapshot().looksLikeMpegTs`) au lieu d'une bannière. Donc au
  pire = comportement d'avant (gateway), au mieux = moteur rapide.
- Le WASM est servi en `cache-control: max-age=0, must-revalidate` → les navigateurs revalident et
  récupèrent le nouveau build au rechargement (pas de cache périmé).

#### Remux TS in-browser — couches de remise en forme pour MSE (ENGINE_VERSION 27→36)
Le démuxeur `mpegts` ne suffit pas : un `.ts` ne porte **rien** de ce que le mp4/MSE exige dans l'en-tête
de conteneur. Il a fallu reconstruire, côté JS, ce que le conteneur ne fournit pas. Chaque couche a été
un `CHUNK_DEMUXER_ERROR_APPEND_FAILED` distinct (diagnostiqués sur snapshots console réels) :
1. **Seek sur non-keyframe (v27)** — un seek approximatif (le TS n'a pas d'index keyframe) tombe en plein
   GOP ; MSE exige une keyframe en 1ʳᵉ frame de segment. → **garde keyframe** (drop des frames non-IDR
   avant d'ancrer `vBase`).
2. **avcC vide (v28)** — H.264 en TS porte SPS/PPS **in-band** (annexb), pas dans l'en-tête → le moov
   sortait avec un avcC vide. → **on lit SPS/PPS de la 1ʳᵉ keyframe et on synthétise l'avcC**, injecté
   dans le codecpar **avant** l'init du muxer.
3. **mdat en annexb (v29)** — movenc **copie** la vidéo TS telle quelle ; le mdat restait en annexb
   (start codes) alors que MSE lit un préfixe de longueur. → **annexb→AVCC** (longueur 4 o) par access
   unit, + drop des NAL AUD(9)/SPS(7)/PPS(8) du mdat (les params vivent dans l'avcC).
4. **Extension avcC High-profile (v30)** — un avcC High profile (`avc1.64xxxx`) **doit** porter
   `chroma_format_idc` + bit-depths ; absents pour Main (`avc1.4d40xx`), d'où « marche en Main, casse en
   High ». → `spsHighExt()` (Exp-Golomb du SPS) ajoute l'extension quand le profil l'exige.
5. **AAC ADTS → ASC (v31) — la racine audio, longtemps masquée.** Le TS porte l'**AAC en ADTS** (en-tête
   7/9 o par frame) **sans esds** ; le muxer mp4 sortait un **esds vide** ET des samples mdat encore
   **ADTS** → MSE rejette l'**audio**, **quel que soit le profil vidéo** (donc « High-profile » était un
   leurre — *tous* les `.ts` cassaient). C'est la transform standard `aac_adtstoasc`, faite en JS (pas de
   rebuild WASM) : `adtsToAsc()` synthétise l'ASC (AOT/sample-rate/canaux) injecté en extradata audio, et
   `stripAdts()` retire les en-têtes ADTS de chaque paquet (raw AAC). Gardé sur **AAC stream-copy sans
   extradata conteneur** = TS uniquement ; mkv/mp4 (AAC raw) intouchés.
6. **Reprise : curseur dans un trou (v33→v36) — la racine de « calé »/écran noir.** Sur une **reprise**
   (resume à T), le seek approximatif TS tombe sur la keyframe la plus proche, souvent **APRÈS** T : les
   données se bufferisent à partir de la keyframe (ex. 636s) mais `video.currentTime` reste à T (625s) →
   **11s de trou sans données au curseur** → gel permanent (le navigateur ne saute jamais dans le trou),
   puis sur-buffering « dans le vide » → `code=3`. Diagnostiqué **uniquement** via le snapshot Supabase
   (`currentTime:625` vs `buffered:[[636,805]]`). Sous-bugs successifs : (a) le seek ignorait l'**epoch
   PTS** du TS (premier PTS ≠ 0) → ajouté à la cible de seek + soustrait de l'ancre (`_ptsEpoch`, v33) ;
   (b) le vrai correctif (**v36**) : une fois les 1ʳᵉˢ données bufferisées, **recaler `currentTime` sur le
   début réel du buffer** (`bufferedStart+0.05`). Piège qui a coûté une itération : ne **pas** garder sur
   `!video.seeking` — à la reprise l'élément est *coincé* en seek vers une position sans données, donc
   `seeking` reste vrai et la garde bloquait le recalage censé le débloquer. La cible étant dans le buffer,
   `_handleSeeking` l'ignore (pas de re-démux). One-shot par reprise/seek ; démarrage frais intouché.

**Outillage de diagnostic (incontournable pour ces couches)** : (a) **oracle MSE local impossible** pour
H.264 (Chromium open-source du sandbox sans codecs proprio) → validation locale = re-démux libav (trop
tolérant) ; le vrai oracle = le **navigateur de l'user + télémétrie Supabase**. (b) Les snapshots d'échec
**ne persistaient pas** : le retry moteur fermait la session, et l'edge **404-ait** tout event portant une
session morte (« Playback session not found ») → snapshot perdu pile quand il faut. Corrigé : event d'échec
envoyé **sans `playbackSessionId`** (client) + edge enregistre **non-lié** au lieu de 404 (norva-playback
v21). Snapshot moteur **compacté** (sans les gros tableaux boxHex/writes) pour rester sous la limite de
payload, avec **plages bufferisées (`sb`/`video`) + `currentTime`** = ce qui a permis de voir le trou.

⚠️ **Limite de validation locale.** Le Chromium du sandbox est le **build open-source** (Playwright) :
`MediaSource.isTypeSupported` renvoie **false pour avc1/mp4a/hvc1** (codecs propriétaires absents) — donc
**pas d'oracle MSE H.264/AAC en local** (vérifié via CDP : seuls vp8/vp9/vorbis passent). La seule
validation locale possible = **re-démux libav de la sortie du moteur** (trop tolérant : il a laissé passer
le Main alors que MSE strict aurait calé). Les couches 1-4 ont donc été des hypothèses validées au
re-démux puis confirmées/infirmées sur le **navigateur réel de l'user** (chaque tour = un rechargement +
un snapshot console). La couche 5 (audio), elle, est **prouvée au niveau octet en local** (la sortie porte
l'ASC injecté dans l'esds et le 1ᵉʳ sample audio est du raw AAC sans sync `0xFFF`) — défaut certain, pas
une supposition. Le garde-fou `onError`→gateway fait que **la lecture n'est jamais cassée** entre-temps.

### Bug #4 — mkv ne démarre pas alors que mp4 oui : IP datacenter bloquée (GATEWAY_VERSION 51) ✅ racine
- **Symptôme** : sur le **même provider**, les mp4 (`direct`) jouaient mais les mkv (`engine`/`relay`) `458`aient, **au même instant**.
- **Diagnostic** (télémétrie) : `playback_mode='direct'` → `first_frame` OK ; `playback_mode='engine'` → `BLOCK_HTTP_458`. Donc le slot n'est pas saturé : le provider **458 spécifiquement l'IP datacenter** (Railway), pas l'IP résidentielle du navigateur. (La rafale de retries pendant le debug avait probablement fait flaguer l'IP.)
- **Fix** : **proxy résidentiel optionnel** sur la gateway (voir §4).

## 4. Proxy résidentiel (contournement du blocage datacenter)

### Pourquoi
Les fournisseurs IPTV bloquent les plages d'IP datacenter (anti-revente). Le navigateur en `direct` sort par l'IP résidentielle de l'utilisateur → OK. Le moteur passe par la gateway (IP Railway) → bloqué. Router le trafic provider de la gateway via un **proxy résidentiel** fait voir au provider une IP résidentielle.

### Implémentation (`services/media-gateway/src/index.js`, GATEWAY_VERSION ≥ 52 — **pool**)
- Env **`PROVIDER_PROXY_URLS`** = liste (séparée par virgule/espace/retour-ligne) d'URLs proxy → **pool**. `PROVIDER_PROXY_URL` (singulier) marche toujours (fusionné, pool de 1 = comportement identique). Vide → aucun changement.
- Chaque **compte provider** est épinglé à **UNE** IP du pool (hash FNV-1a d'une clé stable : `uid` Norva sur les routes tokenisées, sinon `host+username` extrait de l'URL). **Sticky** = un compte = toujours la même IP (anti-flag) ; sur N users la charge se répartit ~uniformément sur les IPs.
- `dispatcher: pickProxyAgent(key)` sur les `fetch` (`/raw` + Xtream JSON) ; `env: proxyEnvFor(key)` (http_proxy/https_proxy) par-spawn pour les **ffmpeg/ffprobe** (sous-titres, extraction audio whisper, transcode), avec une IP par défaut (1ʳᵉ du pool) en filet. Le `fetch` Node ignore ces env → Supabase/interne reste direct.
- `undici` en dépendance (chargé seulement si le proxy est configuré).
- `GET /health` → `providerProxy: true/false` + `providerProxyPool: <taille>`.

**Config Railway (pool de 5)** : `PROVIDER_PROXY_URLS` = les 5 URLs Evomi (une par IP — le mot de passe Evomi encode l'IP cible : `user:<IP>_<secret>`), séparées par des virgules ou des retours-ligne. Vérifier `GET /health` → `providerProxyPool:5`.

### Configurer (Railway)
1. Acheter une **Static Residential** dédiée (chez Evomi : « Private IPs », ~$2.50/IP, **bande passante illimitée**). **Pas** de résidentiel rotatif **au Go** (vidéo = facture ruineuse), **pas** de datacenter (même blocage). Couper l'option « High Concurrency » (inutile en mono-ligne).
2. Format Evomi `host:port:user:pass` → URL `http://user:pass@host:port`.
3. Railway → service media-gateway → Variables → `PROVIDER_PROXY_URL = http://…`. Le redéploiement est auto.
4. Vérifier : `GET /health` → `"version":51, "providerProxy":true`, puis lancer un mkv.
5. 🔐 Les identifiants proxy = **secret** : uniquement dans l'env Railway, jamais dans le code/git. Régénérer si exposés.

### ⚠️ Limites (ne pas confondre les deux contraintes)
| Contrainte | Réglée par le proxy ? |
|---|---|
| Blocage **IP datacenter** | ✅ oui (IP résidentielle) |
| **Slot unique** par compte provider (1 stream à la fois) | ❌ non — limite par **compte**, pas par IP |

**Échelle.** Un proxy résidentiel statique = bon pour **toi / petite échelle**. Pour des **milliers d'users**, faire sortir tout le monde par 1 (ou quelques) IP statique = densité de comptes anormale → l'IP se fait flaguer comme proxy + goulot de bande passante. La vraie archi mondiale = **chaque user sort par SA propre IP résidentielle** : **app native** (TV/mobile, IP de l'appareil) ou **hub local** (agent sur le réseau de l'user). Cf. `ARCHITECTURE-RELIABILITY.md`. La ligne de partage n'est pas desktop/mobile mais **navigateur vs natif** (le navigateur impose CORS/mixed-content/HTTPS qui compliquent le hub local).

## 5. État final (vérifié en prod)
- mkv via moteur : `first_frame` + `play_started` + resume/pause/seek en `playback_mode='engine'`, **plus aucun `CHUNK_DEMUXER`**.
- Combinaison gagnante = **proxy résidentiel** (octets circulent) + **muxer non-seekable** (octets valides).
- Versions : `ENGINE_VERSION 36` (**TS démuxé/remuxé en navigateur** via le WASM `+mpegts`, **lecture
  fraîche ET reprise OK** ; remise en forme MSE en 6 couches — garde keyframe, avcC synthétisé + extension
  High-profile, annexb→AVCC, **AAC ADTS→ASC + strip**, **recalage curseur reprise (epoch + nudge)** ;
  auto-retry moteur sur SOURCEOPEN/mediaerror ; repli gateway si le navigateur ne décode pas le codec ;
  `sourceHead` sur échec d'ouverture), `norva-playback v21` (event d'échec enregistré même session morte),
  `GATEWAY_VERSION 59` (Argos translate ; sonde codec TS VOD + estimation de durée → seek bar).
- ⏳ Reste optionnel : le repli gateway de secours (`fallbackEngineToTranscode`) peut encore 404
  (« Gateway session not found ») — rarement atteint depuis que l'auto-retry moteur récupère les hoquets ;
  à durcir (session fraîche) si la télémétrie montre qu'on y tombe.

## 6. Runbook — « un mkv ne se lance plus »
1. `GET https://norva-production.up.railway.app/health` → vérifier `version` et `providerProxy`.
2. Requête SQL §2 sur `cloud_playback_events` (20 dernières min) : regarder `playback_mode`, `error_message`, `engineSnapshot`.
3. Lecture du verdict :
   - `PROBE_HTTP_458` / `BLOCK_HTTP_458` **uniquement en `engine`** + `direct` OK → IP datacenter/slot. Vérifier le proxy (`providerProxy:true`), l'IP non flaguée, le slot libre (rien d'autre connecté au compte).
   - `seekWrites>0` → régression du writer non-seekable (vérifier `mkstreamwriterdev` / `device:false`).
   - `CHUNK_DEMUXER` avec `seekWrites=0` + `boxSeq` propre → regarder le `hex` des petites écritures de queue (fragment incomplet ?).
   - `CHUNK_DEMUXER` sur un **`.ts`** (`looksLikeMpegTs:true`) → vérifier dans le snapshot : `injectedExtradata>0`
     (avcC vidéo synthétisé), `injectedAudioAsc>0` + `stripAdts:true` (esds/ADTS audio). Si un `.ts` casse
     avec `injectedAudioAsc:0`, l'AAC n'a pas été reconfiguré (esds vide = rejet audio). Cf. couches TS ci-dessus.
   - `pumpExitReason='readerr'` + `lastReadError` → coupure réseau/proxy en cours de stream.
   - `DEMUX_OPEN` / `SOURCE_NOT_MEDIA` avec `lastReadError=null` + `size` connu → octets non-média servis
     en 206. Lire `engineSnapshot().sourceHead` : `kind:'html'/'json'` → page d'erreur provider (flux
     hors-ligne / lien expiré côté provider) ; `kind:null` → vraies données, conteneur illisible par
     libav-wasm (candidat au repli transcode). Cf. Bug #5.
4. Le snapshot complet est dans `metadata->'engineSnapshot'` (lisible direct, pas besoin de la console du user).

## 7. Reste à faire (mineur / suite)
- 🔐 Régénérer le mot de passe Evomi exposé en chat, le remettre dans `PROVIDER_PROXY_URL`.
- Optionnel : durcir le pump contre les hoquets réseau du proxy (`TypeError: Failed to fetch` transitoire → retry au lieu de remonter l'erreur).
- Optionnel : alléger les diagnostics (walker + hex) une fois la stabilité confirmée.
- Roadmap produit : Phase 3 (sous-titres auto Whisper + Argos), Phase 4 (OCR PGS/VOBSUB) — cf. `NORVA-WORK-STATUS.md`.
