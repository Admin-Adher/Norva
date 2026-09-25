# Offres de retour après résiliation — web Revolut

## Règles validées par le propriétaire

- Résiliation immédiate ; accès restant conservé.
- Offre personnelle à partir de J−3 : −20 % sur trois paiements mensuels, ou −10 % sur le prochain paiement annuel.
- Confirmation explicite ; prix réduit, durée, tarif suivant et date de paiement affichés avant acceptation.
- Aucun paiement anticipé avant la fin d’accès. Après expiration, passage par le checkout existant et activation après paiement confirmé.
- Une utilisation sur douze mois, aucune combinaison avec une autre promotion ou un changement de forfait en attente.
- E-mail uniquement avec consentement commercial, vérifié à la sélection puis juste avant l’envoi. Un message avant expiration ; au plus un rappel à J+3, offre valable jusqu’à J+7. Un refus arrête les rappels.
- Motif technique : assistance proposée, sans remise.
- Google Play et les interfaces natives exclus. La stratégie mobile sera traitée séparément.

## Vérifications réalisées

- Tests API : identité authentifiée, absence d’action sur GET, refus des prix/propriétaires envoyés par le navigateur, erreurs sans détail technique.
- SQL exécuté sur une copie **du schéma uniquement**, dans un conteneur PostgreSQL sans réseau. Toutes les données sont fictives et annulées à la fin du test. Aucun paiement fournisseur n’est appelé.
- Moteur réel de renouvellement : trois cycles mensuels puis retour au tarif normal ; un cycle annuel puis retour au tarif normal ; répétition idempotente.
- Réabonnement expiré : paiement initial synthétique consommant un seul cycle, webhook répété sans nouvelle consommation, commande non payée ne consommant pas l’offre.
- Consentement, refus, compte interne, Google Play, changement de forfait, cumul promotionnel, limite temporelle, facturation en cours et reprise d’essai testés.
- Défaut préexistant corrigé : un événement de suivi commercial absent ne doit pas faire échouer la reprise d’un essai.
- Navigateur Codex sur fixture locale : erreur simulée, nouvelle tentative, réactivation, affichage des trois échéances réduites et du tarif suivant ; offre annuelle après expiration ; refus confirmé.
- Texte web traduit dans les dix langues du produit. E-mails français ou anglais selon la langue connue du compte.
- Test System WebView ajouté : français à 100 % et 130 %, arabe à 130 %, erreur/réessai, absence de débordement, taille des boutons et confirmation après rechargement.

## Déploiement

La migration crée une politique désactivée par défaut. Ordre : migration, API Revolut et lifecycle avec le nouveau template, web, contrôles, puis activation de `cloud_retention_policy`.

Le compte QA réellement annulé n’est pas réactivé pour les tests. Son échéance reste le 1 octobre 2026 ; aucune date n’est avancée pour forcer l’offre.

Les références de publication et résultats de CI seront ajoutés après exécution.

## Correction ergonomique et contrôle des abus (25 septembre)

L’offre remplace l’illustration dans le résumé de l’abonnement. Prix, durée, tarif suivant, date du premier paiement et renouvellement automatique restent visibles avant le bouton. La réactivation au tarif normal est masquée lorsqu’une offre valide est présentée, puis rétablie après refus ou indisponibilité. Les conditions secondaires sont dépliables. Sur la surface contrôlée de 1280 × 720 pixels CSS, le bouton termine à y=443 px. Le navigateur conserve un zoom hôte de 50 % : la dimension CSS réelle est mesurée, sans prétendre que le zoom a été réinitialisé. Le test WebView impose séparément 360 × 800 dp avec agrandissement du texte à 100 et 130 %.

Les tests SQL supplémentaires prouvent : nouveau motif/événement de résiliation et changement d’e-mail sans remise à zéro du délai ; ancienne acceptation rejouée sans restaurer les cycles consommés ; exclusion à onze mois et retour possible après treize ; refus des actions accept/checkout/decline d’un autre propriétaire ; rejet des prix et du nombre de mensualités modifiés. Les clients anonymes et authentifiés ne peuvent ni modifier la politique, ni effacer l’historique.

La règle des douze mois porte sur le compte Norva (UUID). Elle ne certifie pas l’identité d’une personne derrière plusieurs comptes. Aucune déduplication fondée sur les quatre derniers chiffres d’une carte ou une adresse IP n’est introduite : ces indices ne sont pas des identifiants fiables.

Concurrence réelle dans le conteneur de test sans réseau : huit connexions PostgreSQL acceptent la même offre simultanément. Résultat : une acceptation appliquée, sept répétitions idempotentes, une seule offre consommée, trois cycles restants et aucune commande de paiement créée. Ces fixtures persistées sont limitées à ce conteneur jetable, supprimé à la fin de la validation.

## E-mails et séparation des abonnements

Le template couvre les offres mensuelles et annuelles avant/après expiration, en français ou en anglais. Il précise les tarifs, la durée, la date de paiement, le renouvellement et la portée « abonnement souscrit sur norva.tv ». Le bouton ouvre l’offre sans l’accepter automatiquement. Le transport existant apporte le lien de désinscription et les en-têtes de désinscription en un clic.

Le scénario SQL de changement de canal est réussi : e-mail Revolut éligible en attente, puis passage de l’abonnement à Google Play ; la sélection, l’accès à l’offre et le contrôle Postal final refusent alors cette offre web. Les répétitions sont dédupliquées par offre et phase. La campagne personnalisée remplace les relances génériques Revolut lorsqu’elle est activée ; son producteur ne crée aucune notification push. Une future offre Google Play devra utiliser ses propres prix, éligibilité, campagne et contrôles d’envoi.
