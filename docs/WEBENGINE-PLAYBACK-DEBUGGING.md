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

### Bug #4 — mkv ne démarre pas alors que mp4 oui : IP datacenter bloquée (GATEWAY_VERSION 51) ✅ racine
- **Symptôme** : sur le **même provider**, les mp4 (`direct`) jouaient mais les mkv (`engine`/`relay`) `458`aient, **au même instant**.
- **Diagnostic** (télémétrie) : `playback_mode='direct'` → `first_frame` OK ; `playback_mode='engine'` → `BLOCK_HTTP_458`. Donc le slot n'est pas saturé : le provider **458 spécifiquement l'IP datacenter** (Railway), pas l'IP résidentielle du navigateur. (La rafale de retries pendant le debug avait probablement fait flaguer l'IP.)
- **Fix** : **proxy résidentiel optionnel** sur la gateway (voir §4).

## 4. Proxy résidentiel (contournement du blocage datacenter)

### Pourquoi
Les fournisseurs IPTV bloquent les plages d'IP datacenter (anti-revente). Le navigateur en `direct` sort par l'IP résidentielle de l'utilisateur → OK. Le moteur passe par la gateway (IP Railway) → bloqué. Router le trafic provider de la gateway via un **proxy résidentiel** fait voir au provider une IP résidentielle.

### Implémentation (`services/media-gateway/src/index.js`, GATEWAY_VERSION 51)
- Env **`PROVIDER_PROXY_URL`** (ex. `http://user:pass@host:port`). Vide → aucun changement.
- Si défini : un **undici `ProxyAgent`** sert de `dispatcher` aux deux `fetch` provider (`/raw` + l'API Xtream JSON), et `http_proxy`/`https_proxy` sont exportés pour que les **ffmpeg/ffprobe** spawnés sortent aussi par le proxy. (Le `fetch` Node ignore ces env → les appels Supabase/internes restent directs.)
- `undici` ajouté en dépendance (chargé seulement si le proxy est configuré).
- `GET /health` → `providerProxy: true/false`.

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
- Versions : `ENGINE_VERSION 23`, `GATEWAY_VERSION 51`.

## 6. Runbook — « un mkv ne se lance plus »
1. `GET https://norva-production.up.railway.app/health` → vérifier `version` et `providerProxy`.
2. Requête SQL §2 sur `cloud_playback_events` (20 dernières min) : regarder `playback_mode`, `error_message`, `engineSnapshot`.
3. Lecture du verdict :
   - `PROBE_HTTP_458` / `BLOCK_HTTP_458` **uniquement en `engine`** + `direct` OK → IP datacenter/slot. Vérifier le proxy (`providerProxy:true`), l'IP non flaguée, le slot libre (rien d'autre connecté au compte).
   - `seekWrites>0` → régression du writer non-seekable (vérifier `mkstreamwriterdev` / `device:false`).
   - `CHUNK_DEMUXER` avec `seekWrites=0` + `boxSeq` propre → regarder le `hex` des petites écritures de queue (fragment incomplet ?).
   - `pumpExitReason='readerr'` + `lastReadError` → coupure réseau/proxy en cours de stream.
4. Le snapshot complet est dans `metadata->'engineSnapshot'` (lisible direct, pas besoin de la console du user).

## 7. Reste à faire (mineur / suite)
- 🔐 Régénérer le mot de passe Evomi exposé en chat, le remettre dans `PROVIDER_PROXY_URL`.
- Optionnel : durcir le pump contre les hoquets réseau du proxy (`TypeError: Failed to fetch` transitoire → retry au lieu de remonter l'erreur).
- Optionnel : alléger les diagnostics (walker + hex) une fois la stabilité confirmée.
- Roadmap produit : Phase 3 (sous-titres auto Whisper + Argos), Phase 4 (OCR PGS/VOBSUB) — cf. `NORVA-WORK-STATUS.md`.
