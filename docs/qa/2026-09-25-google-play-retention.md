# Promotions de retour Google Play — état et parcours proposé

## Vérifications du 25 septembre

- Application Play `tv.norva.phone`, produits `norva_plus` et `norva_family`.
- Chaque produit possède deux plans actifs (`monthly`, `annual`), disponibles dans 174 pays/régions, et les offres actives `freetrial-monthly` et `freetrial-annual`.
- L’offre mensuelle Plus contrôlée propose sept jours gratuits et cible les personnes n’ayant jamais eu d’abonnement dans cette application.
- Aucune offre de retour payante n’est configurée sur ces deux produits.
- RevenueCat Android 9.23.1 est déjà intégré. Le contrat natif actuel refuse les phases payantes introductives et achète le package par défaut, sans sélectionner une offre de retour précise.
- Le remplacement utilise actuellement `WITH_TIME_PRORATION`. Ce mode ne convient pas au changement d’option dans le même produit ; la conservation de la prochaine échéance doit être testée avec le mode adapté.
- L’entrée Google Play des paramètres reste limitée à un compte de test. Ce constat concerne cette entrée, pas une preuve d’indisponibilité de toutes les autres entrées du paywall.
- La projection des droits de production ne contient actuellement aucune ligne `provider=google_play`. Cela ne constitue pas un inventaire exhaustif des commandes Google Play ni une validation des webhooks.

## Séparation corrigée dans cette modification

L’ancienne campagne générique `winback` est activée sur les deux serveurs Edge. Son template ouvre `/subscribe` sur le web et sa sélection ne distinguait pas le fournisseur de paiement. Aucune preuve d’envoi erroné à un abonné Play n’a été constatée.

Le correctif limite cette ancienne campagne au canal Revolut, et seulement lorsque la campagne personnelle web est explicitement désactivée. Une politique absente ou illisible n’autorise aucun envoi générique.

La même condition est contrôlée à la mise en file et dans les deux contrôles de livraison, dont Postal. Un message déjà en attente devient donc interdit si le compte passe à Google Play. Aucun consentement n’est ajouté et aucune campagne mobile n’est activée par cette correction.

Validation : 21 tests Node réussis ; test SQL dans une copie du schéma sans données clients, en conteneur PostgreSQL sans réseau. Le scénario vérifie un message web autorisé puis bloqué à la mise en file et avant livraison pour Google Play, App Store, RevenueCat non identifié et accès système. L’activation de la campagne personnelle bloque aussi l’ancienne relance web déjà en attente. Les données synthétiques sont annulées à la fin.

## Parcours mobile à réaliser

| Moment | Expérience |
| --- | --- |
| Résiliation | Ouvrir la gestion Google Play, confirmer la date de fin après retour et synchronisation. L’offre ne retarde pas la résiliation. |
| J−3 avant la fin d’accès | Carte compacte dans le compte avec montant local exact, durée, prochaine échéance et prix suivant ; conserver le renouvellement désactivé tant que l’utilisateur n’a pas accepté. |
| Acceptation | Sélection explicite de l’offre dans le SDK, puis écran de confirmation Google Play. Aucune acceptation depuis un simple lien d’e-mail. |
| Après expiration | Un rappel au plus à J+3 ; proposition valable jusqu’à J+7, puis arrêt. |
| Refus ou motif technique | Arrêter les rappels ; pour un problème de lecture, ouvrir l’assistance et ne pas substituer une remise à la résolution. |

Barèmes proposés, reprenant ceux validés pour le web :

- Mensuel : réduction de 20 % pendant trois échéances, puis tarif normal Google Play.
- Annuel : réduction de 10 % sur une année, puis tarif normal Google Play.
- Prix et devise provenant des phases Google Play, sans réutiliser les montants USD du web. Les arrondis et minimums régionaux doivent être contrôlés dans la Console.
- Même niveau d’accès ; ne pas imposer un passage de Plus à Famille ou du mensuel à l’annuel.
- Pas de nouvel essai gratuit ni de remise cumulée avec une phase promotionnelle déjà active.

## E-mails et notifications

- Facturation Google Play : offre, liens, modèle et identifiant de campagne dédiés à Google Play. Un compte Revolut reste rattaché à son offre web même s’il utilise Android.
- Le bouton d’une communication mobile ouvre l’offre dans l’application. Sans application compatible, présenter une explication et un lien d’installation/gestion Google Play, sans basculer vers Revolut.
- E-mail commercial soumis au consentement marketing ; push soumis à la permission Android et à la préférence commerciale correspondante. Une permission système ne vaut pas consentement à toutes les promotions.
- Un plafond commun doit éviter un e-mail et un push promotionnels pour la même étape. Au plus une sollicitation à J−3 et une après expiration ; refus, réabonnement ou changement de canal annulent les envois en attente.
- Aucun montant personnalisé dans une notification si les prix Google Play applicables au compte ne sont pas connus avec certitude. L’écran de l’offre reste l’autorité pour le tarif local.

## Protection contre les abus

- Éligibilité authentifiée côté serveur : abonnement Play réellement annulé/expiré, fenêtre temporelle, produit et période connus, absence d’offre déjà consommée dans les douze mois.
- Conserver l’historique par identifiant Norva et rattachement vérifié de l’achat, pas par adresse e-mail modifiable. Utiliser aussi l’historique des offres web pour éviter deux remises successives après changement de canal, sans mélanger leurs moteurs de facturation.
- Réserver une seule tentative concurrente ; un échec ou abandon n’est pas une consommation. Marquer l’utilisation sur réception d’un achat confirmé, avec traitement idempotent des événements et de leur ordre d’arrivée.
- Recontrôler juste avant l’ouverture de l’achat et avant toute communication. Les prix et identifiants fournis par la WebView ne sont pas une autorité.
- Taguer les offres Google Play `rc-ignore-offer` et les sélectionner explicitement, afin que le catalogue normal ne les propose pas automatiquement à tous.
- Limite à communiquer honnêtement : Google ne vérifie pas l’éligibilité personnalisée des offres « déterminée par le développeur ». Une sélection côté interface seule ne constitue donc pas une garantie antifraude. Ne pas promettre une identité unique derrière plusieurs comptes.

## Ordre d’implémentation et vérification

1. Déployer la séparation des relances génériques décrite ci-dessus.
2. Implémenter le contrat natif d’offre précise, le contrôle serveur, l’historique et la confirmation par événement de paiement vérifié.
3. Ajouter l’UI compacte et accessible avec l’échéancier local, une gestion d’abonnement Play claire, ainsi que les destinations e-mail/push.
4. Préparer quatre offres Play (Plus/Famille × mensuel/annuel) avec exclusion des offres par défaut, puis les vérifier sur un compte de test Play autorisé.
5. Rejouer annulation pendant l’essai et pendant une période payée, J−3, expiration, abandon, refus, achat en attente, double clic, répétition d’événement, changement de compte/canal et restitution après erreur. Vérifier l’absence de paiement anticipé et les échéances réelles sur l’écran Google.
6. Publier une nouvelle version Android et ouvrir les campagnes uniquement une fois ce parcours vérifié. La version 1.3.23 (36) déjà envoyée en examen ne contient pas ce futur parcours promotionnel.

Ce document décrit une stratégie réalisable et les travaux nécessaires. Les remises Google Play ne sont pas actives et aucun achat n’a été effectué pendant cet audit.

## Références officielles consultées

- [Google Play — gestion et reconquête des abonnés](https://developer.android.com/google/play/billing/subscriptions)
- [Google Play Console — création des offres](https://support.google.com/googleplay/android-developer/answer/140504?hl=en)
- [RevenueCat — offres Google Play et sélection automatique](https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers)
- [RevenueCat — modes de remplacement](https://www.revenuecat.com/docs/subscription-guidance/managing-subscriptions)
- [RevenueCat — offres Customer Center](https://www.revenuecat.com/docs/tools/customer-center/customer-center-promo-offers-google) : solution existante, mais son déclenchement lors de l’intention de résilier ne réalise pas à lui seul le parcours J−3 retenu pour Norva.

## Implémentation après accord du propriétaire — 25 septembre

PR 416 implémente le parcours approuvé. La politique et les communications mobiles sont initialement désactivées ; ce réglage ne change pas la campagne Revolut publiée.

- Contrat natif 1.3.24 (37), prix et devise lus dans Google Play, offre précise `rc-ignore-offer`, comparaison du produit, du forfait, du renouvellement désactivé et du prix avant confirmation. `WITHOUT_PRORATION` demandé avant expiration pour préserver l’échéance. L’effet réel sur l’échéancier reste à contrôler dans Google Play.
- Offre autorisée par l’API authentifiée, J−3 à J+7, un rappel au plus après J+3. Réservation concurrente de dix minutes ; limite glissante de douze mois partagée avec le web ; achat confirmé seul consommateur de la remise, y compris après une livraison tardive du webhook ou un refus intervenu pendant l’achat.
- Carte en haut du compte ; gestion dans Google Play, refus, erreur et attente explicites. Montants Google Play affichés avec le tarif suivant. Préférence commerciale push distincte de la permission Android.
- Une livraison par étape, push sur un appareil récent autorisé ou e-mail consenti. Pas de repli e-mail après une tentative FCM ambiguë. Consentement recontrôlé à la mise en file et dans les contrôles de livraison, dont Postal.
- Quatre offres enregistrées en **brouillon** et relues par l’API officielle : Plus et Family, mensuel P1M × 3 à −20 %, annuel P1Y × 1 à −10 %. Éligibilité déterminée par Norva ; tag `rc-ignore-offer`. Exemples France : Plus 3,99 €/mois au lieu de 4,99 €, annuel 39,59 € au lieu de 43,99 € ; Family 7,59 €/mois au lieu de 9,49 €, annuel 71,99 € au lieu de 79,99 €.

### Preuves disponibles

- Suite de régression : 5 135 réussites, zéro échec (5 155 cas au total, reste ignoré), workflow Build 36139148991.
- Android : 43 tests instrumentés réussis dans chaque mode de navigation, API 35 ; TV API 34 réussi, workflow 36139149017. Le nouveau scénario couvre la carte à 360 × 800, textes 100/130 %, prix, action visible, cibles tactiles, erreur/reprise, confirmation en attente, refus/focus et exclusion de Revolut. Un ancien test de clavier intermittent a échoué sur deux exécutions précédentes puis réussi dans les deux modes ; aucun changement des filtres n’a été effectué ici.
- SQL : clone du schéma dans un conteneur sans réseau, données synthétiques annulées. Propriété, consentement, contrôle Postal, choix push/e-mail, tentative push unique, double clic, séparation des canaux, provenance du webhook, achat tardif après refus et horloge des renouvellements vérifiés.
- AAB signé 37 compilé au commit `8b232380161f0fb9538394a27af32d5c929b0e53`, workflow Release 36139477538. Archive vérifiée SHA-256 `6f2ed8811d4b59b403ee56c50b7dcfc38fdc4029b33b1dd58b5ab654e43e42fa`.

### Limites de validation

Les tests utilisent des réponses simulées pour l’UI et des événements synthétiques pour SQL. Ils ne prouvent pas encore un achat Google Play, l’absence de débit anticipé, les trois échéances réelles, ni la présence de `offer_code` dans le webhook réel de ce remplacement. Aucun achat ni envoi commercial n’a été déclenché par ces tests. Le téléphone connecté porte encore 1.3.22 (35) au contrôle.

L’éligibilité des offres Google Play « choix du développeur » n’est pas vérifiée par le Store. Le serveur contrôle le parcours Norva officiel ; cela ne doit pas être présenté comme une garantie absolue contre une application modifiée ou plusieurs identités. Toute activation doit conserver cette limite explicite et vérifier les événements réels.
