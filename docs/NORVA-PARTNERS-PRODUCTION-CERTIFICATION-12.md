# Norva Partners — certification de production en 12 points

Date de décision : 5 août 2026
Périmètre : adhésion individuelle et crédit Norva publics, cash France sur
allowlist, Didit individuel et Revolut Business manuel
Référence de release : manifeste immuable à enregistrer contre le SHA Git et le
SHA de déploiement réellement publiés

## Règle de lecture

Cette certification sépare trois réalités qui ne doivent jamais être confondues :

- **finalisé dans la release** : code, schéma, contrat, UI et tests sont livrés ;
- **à certifier sur le runtime** : la preuve dépend du commit réellement déployé,
  de secrets ou d'un fournisseur ;
- **preuve réelle non simulable** : identité humaine, virement, rapprochement ou
  temps écoulé. Une fixture ne peut pas remplacer cette preuve.

Un point n'est déclaré « production certifiée » que lorsque ses deux premières
colonnes sont vraies et que toute preuve réelle applicable est archivée dans le
package de release.

## Matrice des 12 points

| # | Contrôle | Décision et état de la release | Preuve de production exigée |
|---|---|---|---|
| 1 | Règles économiques et Conditions | **Finalisé.** Individuel uniquement, 20 % des paiements éligibles hors taxes, attribution 30 jours, maturation minimale J+45, pas de sous-affiliation, disclosure obligatoire, corrections append-only et Conditions durables versionnées. | URLs juridiques directes HTTP 200 et empreintes identiques au package approuvé. |
| 2 | Position juridique et fiscale | **Finalisé comme décision interne du responsable Norva, pas comme avis professionnel.** La décision est limitée à 90 jours, expose `external_professional_review_obtained=false`, documente le risque et ne peut pas être présentée comme une consultation d'avocat ou de fiscaliste. | Gate `legal_and_tax_approved` AAL2 liée au document interne, à la policy fiscale, aux Conditions et à l'acceptation de risque du propriétaire. |
| 3 | Manifeste, gates et séparation des pouvoirs | **Finalisé.** Manifeste et packages immuables, empreintes, expiration, approbation AAL2, capacités Admin/Risk/Finance et invalidation sur dérive. | SHA Git/déploiement réels, Admin AAL2, package courant et opérateurs distincts pour tout lot cash. |
| 4 | Faits financiers autoritatifs | **Finalisé techniquement.** Google Play conserve devise/exposant/nanos exacts ; RevenueCat est vérifié par HMAC ; le Web France/USD utilise une policy fiscale versionnée et échoue fermé hors périmètre ; refunds, chargebacks, `TRANSFER` et `DISPUTE_WON` gardent leur lignage. | Événements réels ou sandbox fournisseur signés, rejoués et rapprochés sans fait `incomplete` éligible à une commission. |
| 5 | Parcours sans KYC | **Finalisé.** Tout compte confirmé peut adhérer, obtenir son lien/QR, attribuer, gagner, maturer et convertir un solde disponible en accès Norva sans Didit, profil fiscal cash ou banque. Les quotes débitent exactement la devise source avec snapshot FX immuable et prix de référence USD. | Programme/catalogue actifs, gates Membership courantes, flags membre/earnings/crédit actifs et E2E contre le runtime publié. |
| 6 | Didit réservé au cash | **Finalisé techniquement et isolé du membership.** Consentement dédié, session hébergée, webhook signé, anti-replay, revue humaine, retrait du consentement, purge provider, heartbeat et dead-letter n'affectent ni lien, ni earnings, ni crédit. | Une certification sandbox puis une session live contrôlée avec une vraie personne consentante ; suppression `204|404`, heartbeat frais et zéro dead-letter. |
| 7 | Cohorte cash France | **Finalisé techniquement, fail-closed.** Seules la France, une policy active, une allowlist, un KYC individuel valide, un profil fiscal revu, un bénéficiaire tokenisé et une route active peuvent rendre le cash éligible. | Policy France et corridor testés, membres pilotes explicitement allowlistés et snapshot Admin sanitisé. |
| 8 | Revolut Business manuel | **Finalisé techniquement.** `revolut_manual` produit un lot exact et une référence Norva unique ; le règlement n'est comptabilisé qu'après import et rapprochement du relevé. `revolut_api` reste doublement désactivé et aucun secret API n'est requis sous Basic. | Deux opérateurs Finance humains AAL2 distincts, un virement réel, son relevé et son rapprochement exact ; `partners_payouts_live` vrai uniquement pendant la fenêtre supervisée. |
| 9 | Workers, crons et observabilité | **Finalisé dans le code.** Claims bornés, leases, retry/backoff, idempotence, heartbeats, alertes et états `incomplete`/dead-letter sont séparés par worker. | Crons réellement installés, secret Vault vérifié, deux replicas Edge en parité, heartbeats frais et cycle alerte/rétablissement observé. |
| 10 | Web, Android mobile et TV | **Finalisé au niveau des contrats et UI modifiés.** Web gère chargement, erreur, retry, focus et partage ; mobile respecte safe areas/Back ; TV ne collecte ni fiscalité ni banque et relaie vers un appareil de confiance. | E2E Web contre production, AAB Google Play signée pour `/r/*`, replay émulateur mobile et TV/D-pad sur le build réellement publié. |
| 11 | Sauvegarde, restauration et sécurité | **Finalisé dans la release.** Les trois migrations sont atomiques ; la répétition physique vérifie 30 marqueurs, 162 routines, 19 relations et 109 assertions pgTAP ; les états sensibles doivent rester identiques. | Prédeploy vert sur restauration isolée, backup logique chiffré, base-backup post-migration, postdeploy vert et Advisors/lint du même SHA. |
| 12 | Généralisation | **Contractuellement définie, jamais pré-validée par simulation.** L'ouverture cash hors cohorte reste interdite tant que les observations réelles ne satisfont pas la politique. | Au moins 45 jours observés, deux cycles cash supervisés et rapprochés, aucune anomalie critique, puis nouvelle décision pays/devise et nouveau package. |

## Décision interne sur le point 2

Le responsable Norva choisit de lancer sans revue externe qualifiée. La release
encode donc une **acceptation de risque propriétaire**, et non la mention
mensongère d'un avis professionnel. Pour le périmètre France :

- les gains en argent et avantages issus d'une promotion sont traités comme
  potentiellement imposables et déclarables dès le premier euro ;
- les commissions et avantages mis à disposition sont agrégés par bénéficiaire,
  année et devise ; le seuil déclaratif français applicable à l'article 240 du
  CGI est surveillé ;
- l'acceptation électronique versionnée constitue un écrit, et Norva doit
  recueillir les informations contractuelles complémentaires requises avant de
  poursuivre la mise à disposition au-delà d'un seuil légal applicable ;
- le crédit Norva est fermé, personnel, non transférable et non remboursable en
  espèces, mais reste suivi comme avantage valorisé ;
- aucune conclusion France/UE n'est extrapolée comme validation pays par pays.

Sources officielles retenues : ministère de l'Économie sur l'influence
commerciale et les revenus/avantages, décret n° 2025-1137 sur le contrat écrit à
partir de 1 000 EUR HT par année et objectif promotionnel, et BOFiP
BOI-BIC-DECLA-30-70-20 sur les commissions mises à disposition et le seuil
annuel de déclaration.

## Verdict de release

Le lot peut être déclaré **candidat techniquement complet** lorsque CI, pgTAP,
lint, Edge, Web et builds Android sont verts. Il devient **production certifiée
pour l'adhésion et le crédit** seulement après déploiement, package AAL2, flags
et smoke tests réels. Le **cash** devient fonctionnel uniquement pour les
comptes France allowlistés ayant terminé Didit, fiscalité et bénéficiaire, puis
pendant une fenêtre Revolut manuelle supervisée. La généralisation du cash ne
peut pas être déclarée terminée avant les preuves réelles du point 12.
