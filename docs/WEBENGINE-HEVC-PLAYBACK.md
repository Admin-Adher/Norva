# Norva — Moteur web : lecture HEVC & erreur `CHUNK_DEMUXER_ERROR_APPEND_FAILED`

> **But de ce fichier** : expliquer pourquoi des médias (HEVC) cassaient en
> lecture web avec `code=3 … CHUNK_DEMUXER_ERROR_APPEND_FAILED`, l'enquête qui a
> écarté les fausses pistes, la **cause racine** (fourcc `hev1` vs `hvc1`), le
> correctif, et comment le vérifier / éviter une régression.
>
> _Dernière mise à jour : 2026-06-28._

---

## TL;DR

- **Symptôme** : `[NorvaEngine] failed {stage:'mediaerror', message:'code=3
  PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED … append_window_end=inf'}` —
  Chromium **refuse le segment fMP4** poussé à MediaSource (`appendBuffer`).
- **Cause** : pour le HEVC, le muxeur MP4 produit un sample-entry **`hev1`**, mais
  le moteur **annonce à MediaSource le mime `hvc1.*`**. `hev1` sous une
  SourceBuffer `hvc1` ⇒ Chromium rejette ⇒ append échoue. (Le chemin ffmpeg de
  `index.html` forçait déjà `-tag:v hvc1` ; le moteur libav, lui, l'oubliait.)
- **Correctif** : forcer le codec_tag de sortie à **`hvc1`** (aligné sur le mime
  annoncé) juste après `ff_init_muxer`, avant `avformat_write_header`. H.264
  (`avc1`) n'a besoin de rien.
- **Pas causé par le travail de logs** : prouvé — la sortie fMP4 est
  **octet-identique** avec/sans le filtre de glue et le niveau de log.
- **Vérifier** : `node scripts/check-webengine-mux-tags.mjs`.

---

## 1. L'enquête (et les fausses pistes écartées)

1. **« C'est le correctif de logs ? »** → **Non.** Remux d'un clip de test via la
   glue **patchée @ ERROR** (après mes changements) vs la glue **pristine @ INFO**
   (avant) : sortie fMP4 **octet-identique** (même SHA). Le niveau de log et le
   filtre de glue ne touchent **pas** les octets muxés. Écarté.
2. **« Les BlockAdditions muxées cassent le fMP4 ? »** → **Non.** Le démuxeur
   matroska attache bien les BlockAdditions comme side-data `type 15`
   (`AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL`) sur chaque paquet, **mais** le muxeur
   MP4 de FFmpeg 8.0 (`movenc.c`) **ne lit jamais ce type** (0 occurrence ; il ne
   consomme que `PRFT` et `NEW_EXTRADATA`). Les stripper n'a **aucun effet** sur
   la sortie. Écarté.
3. **La vraie piste** : inspection du fourcc de sortie pour le HEVC.

---

## 2. La cause racine

Remux des clips de test via la vraie WASM, scan des atomes de sortie :

| Entrée | Sample-entry produit | Mime annoncé par le moteur |
|---|---|---|
| H.264 | `avc1` (+ `avcC`) | `avc1.*` ✅ cohérent |
| **HEVC** | **`hev1`** (+ `hvcC`) | **`hvc1.*`** ❌ **incohérent** |

- `hevcCodecString()` (norvaEngine.js) génère `hvc1.…` et `_chooseMime()` essaie
  `hvc1.*` **en premier** → la SourceBuffer est créée en `hvc1`.
- Mais `ff_init_muxer` fait `avcodec_parameters_copy(...)` **puis remet
  `codec_tag = 0`** ; `movenc` choisit alors par défaut **`hev1`** pour le HEVC.
- **`hev1` (init) sous `hvc1` (SourceBuffer)** ⇒ Chromium rejette le segment ⇒
  `CHUNK_DEMUXER_ERROR_APPEND_FAILED`.

`hvc1` (paramètres hors-bande, dans `hvcC`) est aussi le tag exigé par Safari et
le plus compatible MSE — c'est pourquoi le chemin ffmpeg de `index.html` force
déjà `-tag:v hvc1`. Le moteur libav ne le faisait pas.

---

## 3. Le correctif

Dans `_initMuxer` (norvaEngine.js) et le banc `stream.html`, juste après
`ff_init_muxer` et **avant** `avformat_write_header`, on force le tag de la piste
vidéo de **sortie** (la vidéo est la piste 0) à matcher le mime annoncé :

```js
const muxRet = await lib.ff_init_muxer({ format_name:'mp4', … , codecpars:true }, streamCtxs);
this.oc = muxRet[0];
if (this.vS && this.vName === 'hevc') {
  const tag = (this.mime && this.mime.includes('hev1')) ? 0x31766568 /* 'hev1' */
                                                        : 0x31637668 /* 'hvc1' */;
  const vcp = await lib.AVStream_codecpar(muxRet[3][0]); // muxRet[3] = streams de sortie
  await lib.AVCodecParameters_codec_tag_s(vcp, tag);
}
await lib.av_opt_set(this.oc, 'movflags', '…', lib.AV_OPT_SEARCH_CHILDREN);
await lib.avformat_write_header(this.oc, 0);
```

- Il faut le poser sur la codecpar de **sortie** (`muxRet[3][0]`), pas d'entrée :
  `ff_init_muxer` écrase le tag à 0 lors de la copie.
- Aligné sur le mime réellement choisi (par défaut `hvc1`). H.264 intouché.

`MKTAG('h','v','c','1') = 0x31637668` · `MKTAG('h','e','v','1') = 0x31766568`.

---

## 4. Vérification

- **Mécanique** : après le correctif, le remux HEVC produit `hvc1` + `hvcC` et se
  re-démuxe proprement ; H.264 reste `avc1`. Garde de non-régression :
  `node scripts/check-webengine-mux-tags.mjs` (PASS h264→avc1, hevc→hvc1).
- **Non-régression de mes changements de logs** : sortie fMP4 octet-identique
  (même SHA) glue patchée@ERROR vs pristine@INFO.
- **Limite honnête** : impossible de valider l'`appendBuffer` en navigateur **ici**
  — le Chromium headless de l'environnement est la build open-source **sans codecs
  propriétaires** (`isTypeSupported` = false pour `avc1`/`hvc1`/`hev1`). La preuve
  repose donc sur l'alignement fourcc↔mime, le précédent `-tag:v hvc1` de
  `index.html`, et le comportement Chromium documenté. **À confirmer sur le contenu
  réel** dans un Chrome/Edge avec HEVC.

---

## 5. Runbook & fichiers

- Vérifier les tags après tout bump de libav ou changement du mux :
  `node scripts/check-webengine-mux-tags.mjs` (exit ≠ 0 si un tag dérive).
- Si un jour le moteur annonce `hev1` (navigateur ne supportant que `hev1`), le
  code force déjà `hev1` pour rester cohérent.

| Fichier | Rôle |
|---|---|
| `public/js/norvaEngine.js` | `_initMuxer` force le tag HEVC = mime annoncé. |
| `public/webengine/stream.html` | Idem (banc) — force `hvc1`. |
| `scripts/check-webengine-mux-tags.mjs` | Garde de non-régression (hevc→hvc1, h264→avc1). |

## 6. Références

- FFmpeg 8.0 `libavformat/movenc.c` (n'utilise pas `MATROSKA_BLOCKADDITIONAL`).
- `libavcodec/packet.h` : `AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL = 15`.
- Chromium MSE : `hev1`/`hvc1` distincts ; mismatch init↔SourceBuffer ⇒
  `CHUNK_DEMUXER_ERROR_APPEND_FAILED`.
