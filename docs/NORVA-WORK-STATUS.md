# Norva — journal de travail & suivi (audio / sous-titres « intelligence »)

État de tout ce qui a été livré, où ça vit, si c'est **actif** ou **derrière un flag**, et comment
l'activer. Mis à jour au fil des sessions.

## Surfaces de déploiement (toutes auto-déployées sur push `main`)

| Surface | Quoi | Déploiement |
|---------|------|-------------|
| Web / client (`public/js/**`) | Cloudflare Pages | `deploy-cloudflare.yml` (push main) |
| Edge functions (`supabase/functions/**`) | Supabase (bundle CLI) | `deploy-supabase-functions.yml` (push main) |
| Relais (`services/norva-relay`) | Cloudflare Worker | `deploy-relay.yml` (push main) |
| Media gateway (`services/media-gateway`) | Railway | auto-build depuis `main` (pas de GH Action, Railway est branché au repo) |

→ **Un push sur `main` déploie les 4.** ⚠️ Edge functions = **uniquement via la CLI Supabase** (le bundle
résout les imports `../_shared`). Ne jamais déployer une edge function via un outil qui n'agrège pas
(ça plante au boot — cf. incident résolu). Toujours `curl` l'endpoint après déploiement.

## Ce qui est LIVE (actif, sans rien à faire)

| Domaine | Correctif | Fichiers |
|--------|-----------|----------|
| Moteur web | Spam log `BlockAdditions` filtré + `av_log` au niveau ERROR | `public/webengine/vendor/libav/*`, `norvaEngine.js`, `scripts/patch-libav-logs.js` |
| Moteur web | HEVC tagué `hvc1`/`hev1` selon le mime (fixe `CHUNK_DEMUXER_ERROR_APPEND_FAILED`) | `norvaEngine.js`, `stream.html` |
| Moteur web | Drop des B-frames open-GOP au resume/seek (fixe l'erreur en boucle à la reprise) | `norvaEngine.js` |
| Moteur web | **Trailer MP4 (`mfra`/`mfro`) plus jamais ajouté au SourceBuffer** (fixe `CHUNK_DEMUXER_ERROR_APPEND_FAILED` quand la lecture s'arrête tôt — provider mono-slot qui coupe). Cause trouvée via le snapshot de diag. | `norvaEngine.js` (ENGINE_VERSION 17) |
| Moteur web | **Sortie muxer NON-seekable** (`mkstreamwriterdev` + `device:false`) → movenc écrit en streaming pur (tailles calculées à l'avance, pas de seek arrière qui corrompait le flux en ordre d'append) → **fixe le `CHUNK_DEMUXER` à l'ouverture/reprise du mkv** | `norvaEngine.js` (ENGINE_VERSION 22) |
| Moteur web | **Libération du slot à la fermeture** : `destroy()` abort tous les fetch en vol → l'ancienne connexion provider tombe tout de suite (plus de zombie tenant le slot → fixe le spinner infini) ; + retry 458 côté player avec backoff visible | `norvaEngine.js` (v20), `WatchPage.js` (`playWithEngine`) |
| Gateway | **Proxy résidentiel optionnel** (`PROVIDER_PROXY_URL`) → tout le trafic provider sort par une IP résidentielle → **contourne le blocage `458` des IP datacenter Railway** (mkv qui ne démarrait pas alors que les mp4 `direct` jouaient). undici ProxyAgent + `http_proxy` pour ffmpeg. | `services/media-gateway` (GATEWAY_VERSION 51), env `PROVIDER_PROXY_URL` |
| Moteur web | **Diagnostics profonds** sur échec moteur : `engineSnapshot()` (mime/codecs, boîtes fMP4, 1er paquet keyframe, trace des écritures muxer + seeks, raison de sortie du pump, état SB/MS/video) → console + télémétrie `playback_error` (lisible direct en base `cloud_playback_events`) | `norvaEngine.js`, `WatchPage.js` (`reportEngineFailure`) |
| **Phase 1** | Langue audio **déduite** (label/catégorie/région/orig-lang) en fallback ; sous-titres **incrustés** → entrée « 🔒 verrouillée » au lieu de « Off » | `mediaUtils.js`, `WatchPage.js`, `tests/trackIntel.test.js` |
| Catalogue | Badge de langue qui clignotait « une fois sur deux » au rechargement → ligne la plus riche gardée ; auto-guérison des langues 3 lettres (fas/kur/sqi/ell) | `supabase/functions/norva-catalog/index.ts` |
| Gateway | **Cache du profil ffprobe** par URL (moins de sondes répétées → moins de 458) | `services/media-gateway/src/index.js` (v48) |

## Ce qui est DÉPLOYÉ mais derrière un FLAG (à activer pour en profiter)

| Fonctionnalité | Flag / activation | Défaut | Reco |
|----------------|-------------------|--------|------|
| **Sous-titres texte in-band** (le moteur lit ses propres paquets, zéro 2ᵉ connexion → fixe « rien ne s'affiche » sur mono-slot) | `localStorage.setItem('norvaInbandSubs','1')` dans le navigateur (par appareil) | off | Tu l'as testé OK. À passer **on par défaut** dans `WatchPage._inbandSubsEnabled()` quand tu es confiant (sinon chaque appareil doit poser le flag). |
| **Phase 2 — détection langue audio, inline** (à la lecture, en arrière-plan) | `NORVA_WHISPER_DETECT=true` (voir ci-dessous) | off | ⚠️ **Pas pour mono-slot** (super8k) : l'extraction = 2ᵉ connexion → peut 458 pendant le stream. Préfère le backfill. |
| **Phase 2 — détection langue audio, backfill hors-ligne** | `POST /audio-backfill {"mode":"whisper"}` + `NORVA_BACKFILL_TOKEN` | n/a | ✅ **Recommandé mono-slot** : à lancer quand rien ne joue. |
| Gateway **in-band header parse** (récupère les langues audio depuis l'entête déjà streamée, optimisation mono-slot) | env gateway `INBAND_HEADER_PARSE=true` | off | Optionnel ; active si l'audio mono-slot reste capricieux. |

### Où mettre `NORVA_WHISPER_DETECT`
Lu par `getRuntimeConfig`, depuis l'une OU l'autre source (env l'emporte) :
- **Secret edge** : `supabase secrets set NORVA_WHISPER_DETECT=true` (puis redéploie l'edge).
- **Ligne en base** `cloud_runtime_config` (pris en compte en ~30 s, pas de redéploiement) :
  ```sql
  insert into cloud_runtime_config (key, value) values ('NORVA_WHISPER_DETECT','true')
  on conflict (key) do update set value = excluded.value;
  ```
Ce flag ne gère QUE l'inline. Le backfill l'ignore (il lui faut juste `NORVA_BACKFILL_TOKEN`).

### Lancer le backfill Phase 2 (recommandé)
```bash
curl -X POST "$EDGE/norva-playback/audio-backfill" \
  -H "Authorization: Bearer $NORVA_BACKFILL_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"whisper","userId":"<ton-uuid>","type":"movie","limit":100,"concurrency":1}'
# → { processed, candidates, detected, lastId, hasMore } ; pagine avec afterId=lastId tant que hasMore
```

## Roadmap des 4 phases

| Phase | Cible | Description | État |
|------|-------|-------------|------|
| 1 | audio + sous-titres incrustés | langue audio déduite + UI sous-titres incrustés verrouillés | ✅ **fait, live** |
| 2 | audio | whisper.cpp détecte la vraie langue d'une piste non taguée (self-hosted, gratuit) | ✅ **fait, déployé** (à activer : flag ou backfill) |
| 3 | sous-titres | **sous-titres auto** : Whisper transcrit l'audio → VTT quand aucun sous-titre texte ; + **traduction Argos** vers ta langue | ❌ à faire |
| 4 | sous-titres | **OCR (Tesseract)** : sous-titres image (PGS/VOBSUB) → texte ; potentiellement incrustés dans l'image | ❌ à faire |

Hors-plan (correctifs livrés en cours de route) : extraction sous-titres texte in-band (ci-dessus),
fix flicker catalogue, cache de profil gateway, fixes moteur (BlockAdditions/HEVC/open-GOP).

**Note Phase 3 :** réutilise l'infra Phase 2 (whisper.cpp + extraction audio déjà sur la gateway) —
il « suffit » d'une transcription complète horodatée (au lieu d'un clip de 20 s) + Argos pour traduire.

## Vérifié / non vérifiable dans l'environnement de dev

- ✅ `node --check` (gateway, relais, client), transpile esbuild (edge TS), détecteur de langue **10/10**,
  gateway prod `/health` = v48 `languageDetect:true`, `norva-playback` sain (404) après déploiement.
- ⚠️ Non testable ici (pas de navigateur MSE, pas de provider, pas de ffmpeg/whisper runtime) :
  le rendu réel des sous-titres, l'extraction audio contre le provider, la transcription whisper.cpp.
  → à valider côté prod.

## Réf. docs détaillées
- `docs/WEBENGINE-LIBAV-LOGGING.md` — fix du spam log libav
- `docs/WEBENGINE-HEVC-PLAYBACK.md` — tag hvc1/hev1
- `docs/WEBENGINE-GATEWAY-INBAND-PROBE.md` — cache + in-band header parse (audio)
- `docs/WEBENGINE-INBAND-SUBTITLES.md` — sous-titres texte in-band
- `docs/WHISPER-AUDIO-LANGUAGE-DETECTION.md` — Phase 2 (whisper.cpp self-hosted)
