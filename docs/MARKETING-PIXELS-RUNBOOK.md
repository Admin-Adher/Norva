# Norva marketing pixels runbook

## Objectif

Ce runbook centralise la configuration des tags publicitaires et analytics Norva : Google Analytics 4, Google Ads conversions et Meta Pixel. Le code est prêt côté front, mais reste désactivé tant que les IDs publics ne sont pas posés.

## Fichiers à modifier

- `public/js/marketing-config.js` : IDs et labels de conversion.
- `public/js/marketing.js` : chargeur commun, événements automatiques et API `window.NorvaMarketing.track()`.
- Toutes les pages HTML publiques chargent ces deux fichiers avant `</head>`.

## Mise en production des IDs

1. Remplacer `enabled: false` par `enabled: true` dans `public/js/marketing-config.js`.
2. Renseigner :
   - `googleAnalytics.measurementId` avec l'ID GA4 `G-…`.
   - `googleAds.conversionId` avec `AW-…`.
   - `googleAds.conversions.signup`, `beginCheckout`, `trialStart`, `purchase` avec les labels fournis par Google Ads.
   - `meta.pixelId` avec l'ID Meta Pixel.
3. Déployer, puis vérifier en navigation privée avec :
   - Google Tag Assistant.
   - Meta Pixel Helper.
   - `?norva_marketing_debug=1` pour activer les logs console `[NorvaMarketing]`.

## Événements déjà câblés

- `select_content` : clic sur CTA (`data-cta`, `data-auth-action`, boutons d'achat).
- `begin_checkout` : clic sur un bouton `.buy` de sélection d'offre.
- API disponible pour les parcours serveur/front :
  - `NorvaMarketing.track('sign_up', { method: 'email' })`
  - `NorvaMarketing.track('start_trial', { currency: 'USD', value: 4.99, plan: 'plus' })`
  - `NorvaMarketing.track('purchase', { currency: 'USD', value: 4.99, transaction_id: '...' })`

## Consentement

Le chargeur ne contacte aucun fournisseur tant que `enabled` est `false` ou que `NorvaMarketing.setConsent('denied')` a été appelé. Si une CMP est ajoutée plus tard, elle doit appeler :

```js
NorvaMarketing.setConsent(userAcceptedMarketing ? 'granted' : 'denied');
```
