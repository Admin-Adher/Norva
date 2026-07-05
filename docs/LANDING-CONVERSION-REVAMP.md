# Landing conversion + performance revamp (2026-07)

Refonte de la landing publique (`public/index.html`, `public/landing.html`) : perf
PageSpeed 100 %, éléments de conversion inspirés des meilleures landing SaaS
(bevel.health), et remplacement des illustrations abstraites par les **vrais**
mockups d'appareils Norva. Rien ne change côté offre/contenu — c'est de la
présentation et de la vitesse.

## 1. Performance PageSpeed (mobile + desktop)

| Problème PageSpeed | Correctif | Fichier |
|---|---|---|
| **Forced reflow** (starfield lit le layout au boot) | Init différée en `requestAnimationFrame` (`fit()/seed()/start()`) | `public/js/starfield.js` |
| **CSS render-blocking** + chaîne critique | `landing.css` **minifié puis inliné** dans le `<head>` au build (plus de requête bloquante) | `scripts/minify-css.js`, `scripts/inline-css.js` |
| **LCP** (héros) | `<link rel="preload">` sur l'image héros | `index.html` / `landing.html` |
| **Speed Index** (scintillement starfield au 1er paint) | Scintillement différé après le 1er rendu | `starfield.js` |
| **Init nav compacte** lit le layout tôt | Lecture différée à `load` + `requestIdleCallback` | `public/js/landing.js` |

### Pipeline de build (ordre important)
`scripts/minify-css.js` → `scripts/hash-asset-versions.js` → `scripts/inline-css.js`,
câblé dans `package.json` + `.github/workflows/deploy-cloudflare.yml`.
- **minify-css** : protège les chaînes et `url(...)`, préserve les espaces de
  `:is()`/`calc()`.
- **hash-asset-versions** : réécrit `?v=N` → hash de contenu **dans le HTML uniquement**
  (les `?v=N` dans les fichiers JS se bumpent à la main).
- **inline-css** : inline `landing.css` minifié (marqueur `data-inlined="landing.css"`),
  supprime le `<link>` bloquant.

## 2. Éléments de conversion (inspirés bevel.health/fr)

- **Pastilles de réassurance** dans le héros (`.hero-badges`) : garanties clés
  scannables au-dessus du CTA.
- **Barre « Bring your own source »** (`.compat-strip`) : formats/sources compatibles
  — on lit ses propres sources compatibles, Norva ne fournit aucun contenu.
- **Bloc QR cross-device** (`.get-app`, `assets/landing/norva-qr-web.svg`) : QR vers
  l'app web ; **sur mobile** le QR (redondant) est remplacé par un bouton direct
  **« Open Norva »**.
- **Pastilles de garantie près du prix** (`.pricing`) : réassurance au moment de la
  décision.

## 3. Vrais mockups d'appareils

Remplacement des illustrations SVG abstraites par les **captures réelles de l'UI
Norva** fournies par le propriétaire, sur 4 supports :
`public/img/devices/norva-device-{tv,tablet,phone,laptop}.webp` (optimisés,
transparents). Positionnés via `.hero-stage` (TV + téléphone) et `.sync-stage`
(laptop + tablette). Les anciennes captures obsolètes (`nodecast-tv`) ont été
supprimées.

## 4. Passe premium sur 4 sections

Neutralisation des placeholders au profit de **line-icons SVG cohérents avec la
trust-grid** + micro-visualisations sobres (aucune donnée inventée) :
- **Recommendation** : chips `.pref-field` + posters premium (grain via data-URI
  `feTurbulence`, vérifié : survit à la minification).
- **Features** : icônes SVG + `.scrubber` / `.bars` / `.dl-viz`.
- **Devices** : icônes SVG ligne.
- **Simpler-promo** : chrome de navigateur `.bm-*`.

## Vérification
Déploiement Cloudflare Pages sur push `main` ; live-check via l'URL hashée de
`landing.css`/`app.js` sur `norva.tv`. Captures headless (Chromium CDP) pour les
sections below-the-fold (avec forçage `scroll-reveal`/lazy pour les captures
statiques).
