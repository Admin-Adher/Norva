# Phase 4 — OCR des sous-titres image (PGS / VOBSUB → texte)

**Statut (2026-06-30) : MVP PGS LIVRÉ — pipeline gateway + edge v24 + backoff 429 + UI player
on-demand, tous déployés ; parser prouvé (selftest) ; chaîne backend prouvée bout-en-bout. La
contrainte restante est la connexion provider (429/401), pas le code — atténuée par le backoff +
le modèle on-demand caché. Reste : validation sur vrai flux PGS quand une connexion est libre.
VOBSUB/DVB = après le PGS.**

But : les pistes de sous-titres **image** (PGS Blu-ray, VOBSUB DVD, DVB) ne sont pas extractibles en
texte (`extractable:false`, « burn-in requis »). La Phase 4 les **OCR** → WebVTT, **caché cross-user**
(comme la transcription/traduction Phase 3), et les sert au player comme une piste texte normale.

## 1. Architecture (miroir de la Phase 3)

```
player / cron ──► edge ocrEnqueue ──► gateway /ocr-async ──► ffmpeg -c:s copy -f sup (extract .sup)
                  (claim kind=ocr)      (queue dédiée)        └─► ocr_pgs.py (parse PGS + tesseract → VTT)
                       ▲                                              │
   GET generated-subtitle (kind=ocr) ◄── catalog_generated_subtitles ◄── transcribe-callback (par job_id)
```

- **Détection** : déjà en place (`server/routes/probe.js`) — `IMAGE_SUBTITLE_CODECS`
  (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `xsub`) → `subtitleType:'image'`,
  `extractable:false`. C'est la population cible : **509 titres PGS** + 95 VOBSUB au catalogue.
- **Gateway** (`services/media-gateway/src/index.js`, `src/ocr_pgs.py`) :
  - `POST /ocr-async/:token` → queue OCR **dédiée** (lane séparée, concurrence 1) → `runOcrJob`.
  - `extractSubtitleSup` : `ffmpeg -map 0:<idx> -c:s copy -f sup` → fichier `.sup` autonome.
  - `ocr_pgs.py` : parse le bitstream PGS en display sets (PTS exact par cue), RLE-décode chaque
    bitmap, rend en **luma sur fond noir** (la forme que tesseract lit le mieux), OCR par cue → VTT.
    Auto-test : `python3 ocr_pgs.py --selftest` (synthétise un `.sup` 2-cues et fait le round-trip).
  - Dockerfile : `tesseract-ocr` + packs `eng/fra/spa/deu/ita/por` ; `Pillow` dans le venv.
  - `/health` → `ocr:true`, `ocrLangs`.
- **Edge** (`supabase/functions/norva-playback/index.ts`, v24) :
  - `ocrEnqueue()` : résout titre → providerKey → claim `kind='ocr'`, `lang=<langue piste>` (LA clé
    de cache, donc 2 pistes image de langues ≠ → 2 lignes ≠) → POST `/ocr-async` avec l'index + un
    indice de langue tesseract. Le `transcribe-callback` (partagé, par `job_id`) écrit le VTT.
  - `GET/POST generated-subtitle` : acceptent `kind='ocr'`. Mode service `ocr-enqueue` (live-guardé).
- **Player** (`public/js/pages/WatchPage.js`) : ✅ **livré** — chaque piste PGS a une ligne
  « 🔤 OCR → text » dans le menu CC, machine à états par piste (idle → processing → ready | failed,
  clé = index de stream), même flux on-demand que les sous-titres IA (lecture cache → trigger → poll
  → `attachGeneratedSubtitleTrack`). Additif pur : aucune piste PGS → menu inchangé.

## 2. Vérifié (2026-06-30)

- `ocr_pgs.py --selftest` **PASS** : parse 2 cues, timings exacts (1.0→3.0, 4.0→6.5), OCR multi-ligne
  correct. (Qualité tesseract de-risquée à part : texte blanc/contour, multi-ligne, bas contraste lus
  quasi parfaitement ; erreurs résiduelles cosmétiques — apostrophes, I↔| — corrigées par un nettoyage.)
- Gateway déployé : `/health` → `ocr:true, ocrLangs:'eng+fra+spa+deu+ita+por'`.
- Edge **v24** déployé : `ocr-enqueue` réel → `200 {status:'processing', jobId, kind:'ocr', lang:'fr',
  gateway:{queued:true}}` → **chaîne backend prouvée** (claim → gateway → callback).

## 3. Le blocage restant : la connexion provider (PAS le code)

Sur un **vrai** flux PGS (jeremy/apdxes, *Benjamin Gates*, idx 6), l'extraction `.sup` a échoué :

```
ffmpeg exit 1: http://apdxes.xyz/.../18690.mkv: Server returned 4XX Client Error,
               but not one of 40{0,1,3,4}        ← 429-style (max-connections)
… puis après plusieurs essais rapprochés …
ffmpeg exit 1: … Server returned 401 Unauthorized ← l'anti-abus du panel a temporairement bloqué le compte
```

**Diagnostic** : refus **côté provider** à l'ouverture de connexion, pas un bug du pipeline.
- L'extraction de sous-titres image fait un **demux du fichier entier** (`-c:s copy` lit jusqu'à EOF
  car les paquets de sous-titres sont épars) → **connexion provider tenue longtemps** → très
  collision-prone avec la **limite 1-connexion** du panel.
- Le `userHasLiveSession` guard ne couvre QUE les users en lecture, **pas les crons d'enrichissement**
  du même provider (audio toutes les 3-5 min en journée) qui tiennent la connexion.
- **⚠️ Leçon** : ne **pas** marteler le provider de tentatives rapprochées. Un panel IPTV répond
  d'abord `429` (max-connections) puis **`401`** (blocage temporaire anti-abus) si on insiste. Les
  retries doivent être **espacés** (backoff long), jamais en rafale.

### Pistes pour rendre l'OCR exploitable (intégration restante)
1. **Off-peak strict + sérialisé** : un cron OCR nocturne, **un titre à la fois**, live-guardé, hors
   de la fenêtre des crons d'enrichissement de jour (idéalement avec un verrou provider global).
2. **Backoff sur 429/401** dans `extractSubtitleSup` : re-tenter quelques fois avec délai **long**
   (minutes), jamais en rafale. Abandonner proprement si l'abus-block (401) persiste.
3. **Piggyback lecture** (plus tard) : quand un user lit un titre à pistes PGS, le gateway a déjà le
   fichier ouvert → extraire le `.sup` sur la même connexion plutôt qu'en ouvrir une 2ᵉ.

## 4. Fait / reste à faire
- [x] **UI player** : bouton « OCR → text » par piste PGS + machine à états (cf. §1).
- [x] **Backoff provider-safe** : retry 429 espacé (30s/60s), pas de retry sur 401/403 (anti-abus) —
      `OCR_EXTRACT_RETRIES`/`OCR_EXTRACT_BACKOFF_MS` côté gateway (cf. §3).
- **Décision** : OCR **on-demand** (déclenché au player, caché cross-user) plutôt qu'un **pré-gen
  nocturne en masse**. Raison : extraire une piste image = **demux du fichier entier** (~tout le film
  téléchargé via la connexion provider) → trop coûteux pour 509 titres en bloc. En on-demand, le 1ᵉʳ
  spectateur d'un titre paie le coût (quelques min), tous les suivants l'ont gratis (cache). Un cron
  nocturne « réchauffe 1 titre le plus demandé » reste possible plus tard si utile.
- [ ] Validation sur vrai flux PGS quand une connexion provider est libre (le test du 2026-06-30 a été
      bloqué par un `429` puis `401` = anti-abus du panel ; ne pas marteler — cf. §3).
- [ ] Limitations MVP connues du parser : objet/ODS unique par cue (les très grands bitmaps multi-ODS
      seraient tronqués) ; une seule piste image par langue par titre (clé de cache). À étendre si besoin.
- [ ] Après PGS validé : **VOBSUB** (`.idx/.sub`) puis **DVB**.
