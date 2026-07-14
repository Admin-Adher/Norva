# Norva marketing pixels runbook

## Objectif

Ce runbook centralise la configuration des tags publicitaires et analytics Norva : Google Analytics 4, Google Ads conversions et Meta Pixel. Tous les tags sont désactivés tant que le consentement de l'utilisateur n'est pas accordé (RGPD).

> ⚠️ Les identifiants réels (GA4, Google Ads, libellés de conversion, Meta Pixel) **ne sont pas reproduits dans ce document**. Ils vivent uniquement dans `public/js/marketing-config.js`.

## Fichiers

- `public/js/marketing-config.js` : source unique des IDs et libellés de conversion, plus les drapeaux `enabled` / `consentMode`.
- `public/js/marketing.js` : chargeur commun, événements automatiques et API `window.NorvaMarketing.track()`.
- `public/js/consent-banner.js` : bandeau de consentement (le seul à pouvoir passer le consentement à `granted`).
- Toutes les pages HTML publiques chargent ces trois fichiers avant `</head>`.

## État actuel (mise à jour : 2026-07-14)

| Fournisseur | Champ dans `marketing-config.js` | État |
| --- | --- | --- |
| Google Analytics 4 | `googleAnalytics.measurementId` | ✅ renseigné |
| Google Ads | `googleAds.conversionId` | ✅ renseigné |
| Google Ads | `googleAds.conversions.signup` | ✅ renseigné |
| Google Ads | `googleAds.conversions.beginCheckout` | ✅ renseigné |
| Google Ads | `googleAds.conversions.trialStart` | ✅ renseigné |
| Google Ads | `googleAds.conversions.purchase` | ✅ renseigné |
| Meta | `meta.pixelId` | ⬜ à renseigner |
| Global | `enabled` | ✅ `true` (tracking activé) |
| Global | `consentMode` | `denied` par défaut (gate RGPD) |

## Consentement (bandeau)

- `consent-banner.js` affiche un bandeau tant que l'utilisateur n'a pas choisi. **Bandeau en anglais uniquement** (le site est en anglais ; la page admin en français ne charge pas le bandeau).
- **Accepter** → `NorvaMarketing.setConsent('granted')` → les balises se chargent et les événements partent.
- **Refuser** → rien ne se charge, aucun événement.
- Le choix est mémorisé dans `localStorage` (clé `norva_consent`) ; le bandeau ne réapparaît plus après un choix.
- Sécurité : `consentMode` vaut `denied` par défaut, donc **aucun tag ne peut se déclencher avant un consentement explicite**, même si `enabled` est `true`.
- Changer d'avis / ré-ouvrir le bandeau : un lien discret **« Manage cookies »** dans *Settings › Privacy & legal* (page `app.html`) appelle `NorvaConsent.open()`. Sont aussi exposés `NorvaConsent.reset()` (efface le choix et repasse en `denied`) et `NorvaConsent.get()` (renvoie `'granted'` / `'denied'` / `null`).

## Ajouter ou mettre à jour un ID

1. Éditer `public/js/marketing-config.js` (c'est le **seul** endroit à modifier).
2. Pour activer **Meta** : renseigner `meta.pixelId` avec l'ID du pixel.
3. Pour Google Ads, `conversionId` est du type `AW-…` et chaque libellé de conversion vient de la colonne « Conversion label » de l'action de conversion correspondante (onglet « Utiliser Google Tag Manager » de l'action — lire le libellé, sans installer GTM).
4. **Ne rien coller manuellement** dans le `<head>` des pages : `marketing.js` pose les balises tout seul quand le consentement est accordé.

## Vérification

- Accepter le bandeau, puis vérifier en navigation privée avec :
  - Google Tag Assistant (GA4 + Google Ads).
  - Meta Pixel Helper (une fois `meta.pixelId` renseigné).
  - `?norva_marketing_debug=1` pour activer les logs console `[NorvaMarketing]`.
- Côté Google Ads, les actions de conversion restent affichées « inactives » / « balise non installée » tant qu'il n'y a pas de trafic **consenti** réel — c'est normal.

## Événements déjà câblés

- `select_content` : clic sur CTA (`data-cta`, `data-auth-action`, boutons d'achat).
- `begin_checkout` : clic sur un bouton `.buy` de sélection d'offre, et à l'ouverture de la commande Revolut.
- `start_trial` / `purchase` : à la finalisation du paiement Revolut.
- API disponible pour les parcours serveur/front :
  - `NorvaMarketing.track('sign_up', { method: 'email' })`
  - `NorvaMarketing.track('start_trial', { currency: 'USD', value: 4.99, plan: 'plus' })`
  - `NorvaMarketing.track('purchase', { currency: 'USD', value: 4.99, transaction_id: '...' })`

## Hors périmètre de ce dépôt

- Le suivi analytics des **applications Android** (`tv.norva.phone` et l'app TV `tv.norva.tv`) passe par une intégration Firebase **dans le code des applis**, séparée de ce site web. Créer un flux GA4 « application » ne suffit pas : il faut intégrer le SDK Firebase côté app.
