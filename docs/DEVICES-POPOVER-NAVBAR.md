# Popover « Appareils » dans la navbar desktop (2026-07)

Petit bouton icône dans la navbar web desktop (cluster de droite, entre la
recherche et la cloche) qui ouvre un popover **« Use Norva elsewhere »** :
une ligne par appareil (Mobile, TV) faisant la promotion des apps compagnon.
Surface de **découverte**, web-only : le web ne sait pas qu'il existe des apps
mobile/TV, donc on le lui dit — sans jamais s'afficher là où ça n'a pas de sens
(les shells natifs Android, la TV, le téléphone).

Les fiches de store n'étant pas encore publiées, chaque ligne affiche un badge
**« Coming soon »**. Le jour où un lien existe, on le colle dans une seule
config et la ligne bascule toute seule en bouton **Install** — exactement le
même principe « une valeur à renseigner = feature live » que le runbook des
pixels marketing.

## Fichiers

| Fichier | Rôle |
|---|---|
| `public/js/app.js` | La config `NORVA_DEVICE_APPS` (≈ ligne 11) **et** toute la logique : `setupDevicesButton()` (garde web-only + dot) et `toggleDevicesPopover()` (rendu + dismiss). |
| `public/app.html` | Le bouton `#nav-devices` dans la `<nav class="navbar">` (après la recherche, avant la cloche `#nav-bell`), avec son `#nav-devices-dot`. |
| `public/css/main.css` | Styles : `.nav-devices-btn` / `.nav-devices-dot` (mutualisés avec la cloche), le shell popover `.norva-devices-panel` (réutilise `.norva-notif-panel`), les lignes `.norva-device-*`, et les gardes de masquage. |

Tout tient dans le front statique. **Aucune** route serveur, aucune table, aucun
appel réseau.

## Aller en prod (brancher un lien de store) — la seule manip

1. Ouvrir `public/js/app.js`, en tête de fichier :

   ```js
   const NORVA_DEVICE_APPS = [
       { key: 'mobile', name: 'Mobile app', hint: 'For your phone or tablet',        storeUrl: '' },
       { key: 'tv',     name: 'TV app',     hint: 'For the big screen, remote-friendly', storeUrl: '' },
   ];
   ```

2. Renseigner le `storeUrl` de la ligne concernée (ex. la fiche Play Store) :

   ```js
   { key: 'mobile', name: 'Mobile app', hint: 'For your phone or tablet',
     storeUrl: 'https://play.google.com/store/apps/details?id=tv.norva.phone' },
   ```

3. Bumper le cache-buster : `public/app.html` → `app.js?v=44` devient `?v=45`.
4. Merger dans `main` → déploiement Cloudflare Pages automatique.

**Effet immédiat, sans autre changement de code :**
- La ligne dont le `storeUrl` est renseigné passe de « Coming soon » à un bouton
  **Install** (`target="_blank" rel="noopener noreferrer"`, ouvre un nouvel onglet).
- Les lignes restées vides gardent « Coming soon ».
- Un **point rouge** « nouveau » apparaît sur le bouton `#nav-devices` dès qu'au
  moins un lien est actif — il s'éteint définitivement à la première ouverture du
  popover (mémorisé dans `localStorage`, clé `norva-devices-seen`). Tant que tout
  est « Coming soon », **pas de point** (un teaser ne mérite pas de pastille).

Ajouter un nouvel appareil = ajouter une entrée au tableau (une icône est prévue
pour `mobile` et `tv` dans `toggleDevicesPopover()` ; un `key` inconnu retombe sur
l'icône mobile).

## Où / quand le bouton s'affiche (gardes de visibilité)

Volontairement une surface de découverte **web desktop uniquement** :

| Contexte | Visible ? | Mécanisme |
|---|---|---|
| Web desktop | ✅ | `setupDevicesButton()` retire `hidden` |
| Web mobile (≤ 640 px) | ❌ | `#nav-devices { display:none !important }` dans le breakpoint bottom-nav (`main.css`). Un téléphone **est** l'appareil mobile. |
| Mode TV (`?tv=1`, `NorvaTV-AndroidTV`) | ❌ | Garde JS (classe `tv-mode`) **+** filet CSS `html.tv / html.tv-mode .nav-devices-btn { display:none }` |
| Shells natifs (APK phone/TV, `?mobile=1`, ponts `NorvaTVCloud`/`NodeCastNative`) | ❌ | Garde JS `setupDevicesButton()` : détection UA/pont identique à `app.html` et `Settings.js` — on ne propose pas d'« installer » dans une app déjà installée. |

Le bouton part `hidden` dans le HTML et n'est révélé qu'après la garde JS ; il ne
peut donc pas « flasher » avant que le contexte soit connu.

## Fonctionnement (anatomie)

Le popover est un clone de la **cloche de notifications** (même code juste au-dessus
dans `app.js`), pour rester cohérent et éviter de réinventer un pattern déjà éprouvé :

- **Ouverture** : clic sur `#nav-devices` → `toggleDevicesPopover()` crée un
  `#norva-devices-panel` (`role="dialog"`, `aria-label="Use Norva elsewhere"`),
  l'ajoute au `body` et le positionne sous le bouton (`getBoundingClientRect`).
- **Contenu** : en-tête « Use Norva elsewhere » + une `.norva-device-row` par
  entrée (icône, nom, sous-titre, puis badge **Coming soon** *ou* lien **Install**
  selon `storeUrl`).
- **Fermeture** : re-clic sur le bouton (toggle), clic extérieur, `Escape`, ou clic
  sur **Install** (le nouvel onglet part, le popover se referme). `aria-expanded`
  suit l'état ouvert/fermé sur le bouton.
- **HTML échappé** : nom/sous-titre/URL passent par un `esc()` avant injection.

### Détail : la garde `[hidden]` (corrige un bug préexistant de la cloche)

`.nav-devices-btn` et `.nav-bell-btn` posent `display:inline-flex`, qui **écrase**
le `[hidden]` par défaut du navigateur (même piège que `.nav-profile` /
`.region-picker-pop` déjà gérés dans le repo). La règle
`.nav-bell-btn[hidden], .nav-devices-btn[hidden] { display:none }` restaure ce
comportement. Effet de bord bénéfique : sur une install **sans** cloud, la cloche
restait auparavant affichée en bouton mort — c'est corrigé pour les deux boutons
d'un coup.

## Vérification

Vérifié bout-en-bout dans un vrai Chromium (Playwright) contre le serveur local
`node server/index.js` (compte admin créé via le vrai formulaire de login) —
**23/23 checks**, dont :

- Desktop : bouton visible, popover s'ouvre avec les 2 lignes « Coming soon »,
  `aria-expanded` correct, en-tête « Use Norva elsewhere ».
- Fermeture : `Escape`, clic extérieur, double-clic (pas de panneau dupliqué).
- **Bascule live** : `storeUrl` injecté à chaud → la ligne devient un lien Install
  `target=_blank rel=noopener`, l'autre reste « Coming soon », le clic ouvre un
  onglet et referme le popover.
- Point « nouveau » : visible au boot dès qu'un lien est live, éteint après 1re
  ouverture, reste éteint après reload (`localStorage`).
- Masquages : 400 px → `display:none`, `?tv=1` → `display:none`, UA
  `NorvaTV-AndroidPhone` → caché.

La recette de lancement/drive (boot serveur, auth self-host, Playwright) est
capturée dans le skill de vérification du repo. Rappel de déploiement : le site
part **automatiquement** sur Cloudflare Pages à chaque push/merge sur `main`
(workflow `.github/workflows/deploy-cloudflare.yml`).

## Lien avec la publication des apps

Le blocage n'est pas l'UI mais les **liens de store** : à date, aucun lien Play
Store d'app n'existe dans le repo (les seuls `play.google.com` concernent la
gestion d'abonnement). L'état de la publication est suivi dans
`clients/PLAY_STORE_RELEASE_STATUS.md` (AAB signés ✅, upload + fiche magasin à
faire). Quand une fiche est live → renseigner `storeUrl` (section « Aller en
prod »), rien d'autre.
