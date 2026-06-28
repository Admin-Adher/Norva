# Norva — Moteur web (libav.js) : journalisation & spam matroska « BlockAdditions »

> **But de ce fichier** : expliquer pourquoi le moteur de lecture client
> (`public/webengine`, libav.js sur-mesure) crachait des milliers de lignes
> `Unexpected BlockAdditions … MaxBlockAdditionID is 0`, **pourquoi c'est bénin**,
> et l'**architecture du correctif en deux couches** (niveau de log à la source +
> filtre chirurgical de secours) — avec les **mesures**, le **runbook** pour le
> reproduire / le réappliquer après un rebuild de libav, et les compromis assumés.
>
> _Dernière mise à jour : 2026-06-28._

---

## TL;DR

- **Symptôme** : la console du navigateur est inondée, en lecture MKV, de
  `[matroska,webm @ …] Unexpected BlockAdditions found in a Block from Track with
  TrackNumber N where MaxBlockAdditionID is 0`, **une fois par bloc** (des
  milliers de lignes sur un film), toutes attribuées à
  `libav-6.8.8.0-norva.wasm.mjs:620`.
- **Cause** : message **`AV_LOG_WARNING`** du démuxeur matroska de FFmpeg 8.0. Il
  est **bénin** — en mode par défaut (non-strict) le démux continue et le paquet
  est produit. C'est du bruit, pas une panne.
- **Pourquoi ça coûte cher** : ce n'est pas que de l'affichage. À chaque bloc,
  FFmpeg **formate** la ligne (`vsnprintf`), l'écrit sur stderr, et le TTY
  Emscripten la réassemble **octet par octet** en JS — puis (en navigateur réel)
  le DevTools la **rend**. Sur un film, ça se chiffre en secondes de CPU gâché.
- **Correctif (2 couches)** :
  1. **Scalabilité — niveau de log à la source.** Les consommateurs appellent
     `av_log_set_level(AV_LOG_ERROR)` juste après la création de l'instance →
     FFmpeg **saute le travail à la racine** (mesuré **~2,3× plus rapide** sur les
     fichiers concernés). Les vraies erreurs remontent toujours.
  2. **Précision / debug — filtre-puits.** Dans le glue Emscripten, le puits
     `err` ne supprime **que** ce message précis (doit contenir
     `Unexpected BlockAdditions` **et** `MaxBlockAdditionID`) et transmet tout le
     reste. Sert de filet quand on remonte le niveau en VERBOSE pour déboguer.
     Un script post-build le réapplique à chaque rebuild de libav.
- **Vérifier** : `node scripts/bench-libav-matroska-log.mjs`.

---

## 1. Le contexte

`public/webengine` est le **moteur de lecture client** (« le navigateur devient
le serveur média ») : il lit un MKV par plages d'octets, le **démuxe** avec une
build libav.js sur-mesure (`vendor/libav/libav-6.8.8.0-norva.*`), copie la vidéo
et transcode l'audio si besoin, puis pousse du MP4 fragmenté à MediaSource.

Consommateurs de cette build :
- `public/js/norvaEngine.js` — le moteur de prod (classe `NorvaEngine`).
- `public/webengine/stream.html` — banc de test du moteur.

> `public/webengine/index.html` utilise `@ffmpeg/core` (externe, unpkg) — **rien
> à voir** avec ce spam. Et la build `vendor/libav/libav-6.8.8.0-webcodecs.*`
> n'est importée nulle part aujourd'hui.

Le navigateur charge libav en **mode worker** (le wrapper le choisit
automatiquement). Tous les logs de FFmpeg passent donc par le worker.

---

## 2. La cause racine (confirmée sur la source FFmpeg)

- **Mapping de version** : libav.js **6.8.8.0** embarque **FFmpeg 8.0**.
- **Code** : `libavformat/matroskadec.c`, fonction **`matroska_parse_frame()`** :

  ```c
  if (!matroska->is_webm && nb_blockmore && !track->max_block_additional_id) {
      int strict = matroska->ctx->strict_std_compliance >= FF_COMPLIANCE_STRICT;
      av_log(matroska->ctx, strict ? AV_LOG_ERROR : AV_LOG_WARNING,
             "Unexpected BlockAdditions found in a Block from Track with TrackNumber %"PRIu64" "
             "where MaxBlockAdditionID is 0\n", track->num);
      if (strict) {
          res = AVERROR_INVALIDDATA;
          goto fail;
      }
  }
  ```

- **Déclencheur** : fichier **MKV** (pas WebM) dont un bloc porte des
  **BlockAdditions** (`nb_blockmore`) alors que la piste **ne déclare pas**
  `MaxBlockAdditionID` (`max_block_additional_id == 0`). Beaucoup de MKV du monde
  réel sont dans ce cas (métadonnées de bloc écrites par certains muxeurs).
- **Niveau** : **`AV_LOG_WARNING` (24)** en mode par défaut. `AV_LOG_ERROR` +
  abandon **seulement** en mode strict (`strict_std_compliance >= STRICT`), que le
  moteur n'active pas.
- **Bénin** : en non-strict, on **n'entre pas** dans le `if (strict)`. Le code
  continue, parse les BlockAdditions en side-data et **produit le paquet**. La
  lecture n'est pas affectée.

### Pourquoi tout pointe vers `…wasm.mjs:620`

Le module Emscripten est **minifié sur une seule ligne** (la 620, ~242 Ko). libav
tourne dans un Web Worker et route `av_log` → stderr → `/dev/stderr` →
`/dev/tty1` → le puits `err` du glue (par défaut `console.error`). D'où
l'attribution unique à `libav-6.8.8.0-norva.wasm.mjs:620` pour **tous** les logs.

---

## 3. Le correctif — deux couches complémentaires

| Couche | Où | Rôle | Propriétés |
|---|---|---|---|
| **1. Niveau de log** | `norvaEngine.js`, `stream.html` | `av_log_set_level(AV_LOG_ERROR)` après création de l'instance | **Élimine le coût par-bloc à la racine**, survit aux rebuilds (code applicatif, API publique, proxy-fié dans le worker), indépendant du texte du message, sans toolchain. **Grossier** : masque tous les warnings/info libav. |
| **2. Filtre-puits** | `vendor/libav/*.wasm.mjs` (glue) + `scripts/patch-libav-logs.js` | Le puits `err` supprime **uniquement** ce message ; tout le reste passe | **Chirurgical** (ce message seul). Vit dans un artefact **généré** → réappliqué par le script post-build. Filet quand on debug en VERBOSE. |

**Pourquoi les deux et pas une seule ?** Elles ne se recouvrent pas :

- La **couche 1** fait le gros du travail (scalabilité) mais est grossière : en
  prod on accepte de taire les warnings libav (les *erreurs* passent toujours).
- La **couche 2** rattrape le cas debug : si un dev remonte le niveau en VERBOSE
  pour diagnostiquer, ce **seul** message bénin reste effondré pour ne pas noyer
  les diagnostics utiles.

### Pourquoi le filtre-puits seul ne suffisait pas

Le filtre agit au **dernier maillon** : FFmpeg a déjà tout fait (formatage +
écriture + assemblage TTY octet par octet) à chaque bloc ; on ne fait que jeter
le résultat avant `console.error`. Ça nettoie la console **mais ne supprime aucun
coût moteur**. Le **niveau** sort *avant* le `vsnprintf` (le callback par défaut
de FFmpeg fait `if (level > av_log_level) return;`) → tout le chemin est sauté.

### Bascule debug

```js
// norvaEngine.js : option du constructeur
new NorvaEngine(videoEl, { verbose: true });
// ou, globalement, avant la lecture :
window.NORVA_LIBAV_VERBOSE = true;   // → AV_LOG_VERBOSE ; le filtre-puits reste actif
```

---

## 4. Les preuves (mesuré sur la vraie WASM)

Banc reproductible : `scripts/bench-libav-matroska-log.mjs`. Il fabrique un MKV
synthétique **démuxable** (N blocs, chacun avec BlockAdditions, **sans**
MaxBlockAdditionID — les `.mkv` de test du repo, eux, ne déclenchent rien), puis
démuxe via la build vendor à deux niveaux de log.

```
$ node scripts/bench-libav-matroska-log.mjs 8000 8
  level=INFO  (libav default) :  ~107 ms/run
  level=ERROR (norva default) :   ~45 ms/run
  => ERROR ~2,3x plus rapide : saute le travail par-bloc à la source.
```

Matrice complète (8000 blocs/run, 2 essais, chemin wrapper→worker réel) :

| Configuration | Temps démux / run | Avertissements console |
|---|---|---|
| Glue **pristine** @ INFO (état d'origine) | ~106–137 ms | **8000** |
| Glue pristine @ **ERROR** | **~50–52 ms** | **0** |
| Glue **patchée** (filtre-puits) @ INFO | ~110–137 ms | 0 (console propre, **coût intact**) |
| Glue patchée @ **ERROR** (= prod) | **~45–72 ms** | 0 |

**Lecture** : passer le niveau à ERROR **divise ~par 2** le temps de démux sur ce
fichier pathologique. Le filtre-puits seul (ligne 3) nettoie la console mais reste
au coût d'origine. À l'échelle d'un film 2 h (~200k blocs) : plusieurs secondes de
CPU épargnées **et** des centaines de milliers de rendus console évités.

> Le banc utilise la glue **patchée** committée, donc les compteurs console y sont
> déjà à 0 aux deux niveaux : c'est le **timing** (CPU par bloc) qui est la
> métrique honnête ici. Le comptage brut (8000 → 0) vient de la matrice ci-dessus,
> mesurée contre la glue *pristine*.

---

## 5. Options écartées (et pourquoi)

- **Callback de log par-message** (`av_log_set_callback`) — la solution idéale
  (précise **et** sans coût). **Non exposée** par cette build libav.js → impossible
  sans recompiler.
- **Patcher `matroskadec.c` + recompiler la WASM** — « la vraie racine ». Mais une
  fois le niveau réglé à ERROR, le coût est **déjà** éliminé à la source ; le patch
  source n'apporterait plus qu'un gain marginal (garder ce *seul* warning visible
  en VERBOSE) au prix du toolchain FFmpeg/Emscripten **et** d'un re-patch à chaque
  build. Pas rentable. Si un jour on veut ce niveau, récupérer la config de build
  « norva » et dégrader le `av_log` en `AV_LOG_VERBOSE`.
- **`av_log_set_level(QUIET)`** — masquerait aussi les vraies erreurs. ERROR est le
  bon seuil : tait info+warnings, garde les erreurs actionnables.

---

## 6. Runbook

### Après un rebuild / une mise à jour de la build libav.js

La glue est un **artefact généré** : un nouveau build **écrase** le filtre-puits.

```bash
node scripts/patch-libav-logs.js     # réapplique le filtre (idempotent)
# ou, automatiquement, au déploiement :
npm run deploy:cloudflare            # → patch:libav puis hash:assets puis deploy
npm run build:desktop                # → patch:libav puis electron-builder
```

Le script saute les fichiers déjà patchés, **avertit fort (sans casser le build)**
si l'ancre Emscripten a changé (sortie générée différente → porter le filtre),
et échoue si l'ancre est ambiguë. La **couche 1** (niveau de log), elle, est du
code applicatif → **rien à refaire** après un rebuild.

### Vérifier que tout est en place

```bash
node scripts/bench-libav-matroska-log.mjs   # ERROR doit être ~2x plus rapide
node --check public/js/norvaEngine.js
npm test
grep -c "__norvaBlockAddWarned" public/webengine/vendor/libav/libav-6.8.8.0-norva.wasm.mjs  # => 1
```

### Déboguer un vrai problème de démux

Remettre les logs libav complets sans rebuild :

```js
window.NORVA_LIBAV_VERBOSE = true;  // avant de lancer la lecture
```

Le spam « BlockAdditions » reste effondré (filtre-puits) ; tout le reste
(warnings/verbose libav) s'affiche.

---

## 7. Fichiers concernés

| Fichier | Rôle |
|---|---|
| `public/js/norvaEngine.js` | Moteur de prod — appelle `av_log_set_level(ERROR)`, option `verbose`. |
| `public/webengine/stream.html` | Banc moteur — même appel, `window.NORVA_LIBAV_VERBOSE`. |
| `public/webengine/vendor/libav/libav-6.8.8.0-norva.wasm.mjs` | Glue Emscripten — puits `err` filtré (couche 2). |
| `scripts/patch-libav-logs.js` | Réapplique le filtre-puits après un rebuild (idempotent). |
| `scripts/bench-libav-matroska-log.mjs` | Banc reproductible (preuve du gain). |
| `package.json` | `patch:libav` câblé dans `deploy:cloudflare` et `build:desktop`. |

## 8. Références

- FFmpeg 8.0, `libavformat/matroskadec.c`, `matroska_parse_frame()` (tag `n8.0`).
- libav.js 6.8.8.0 (Yahweasel/libav.js) → FFmpeg 8.0.
- Sémantique du log : `av_log_default_callback` sort si `level > av_log_level`,
  **avant** formatage et écriture stderr.
