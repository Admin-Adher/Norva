# Norva Partners — avis juridico-fiscal interne et acceptation de risque

Version : `partners-internal-legal-tax-review-global-frcash-p0-v2`
Date : 5 août 2026
Décideur responsable : propriétaire et responsable de traitement Norva
Périmètre : adhésion individuelle mondiale sans KYC, crédit d'accès Norva,
cash France sur allowlist avec Didit et Revolut manuel

## Portée et nature

Ce document est l'avis interne retenu par Norva pour son lancement. Il est
fondé sur les sources officielles listées ci-dessous, mais n'est ni une
consultation d'avocat ou de fiscaliste, ni une garantie d'absence de risque.
Le propriétaire a explicitement décidé de ne pas commander d'avis externe et
accepte personnellement le risque résiduel. Cette absence reste encodée dans le
package de preuve par `external_professional_review_obtained=false`.

## Décision

**APPROUVÉ EN INTERNE AVEC ACCEPTATION EXPLICITE DU RISQUE PROPRIÉTAIRE**, pour
une durée maximale de 90 jours et pour le périmètre exact suivant :

- personnes physiques uniquement ; aucune société, aucun KYB ;
- adhésion, lien, attribution, commission, J+45 et crédit d'accès sans KYC ;
- commission directe de 20 % du paiement éligible hors taxes, sans réseau,
  droit d'entrée, achat obligatoire ni rémunération du recrutement seul ;
- cash limité à la France, à l'allowlist, aux majeurs/capables vérifiés par
  Didit, au profil fiscal, au bénéficiaire tokenisé et à `revolut_manual` ;
- seuil cash de référence `USD 10.00`, frais d'envoi absorbés par Norva ;
- ledger et catalogue d'accès en USD, sans conversion silencieuse ;
- toute nouvelle ouverture cash ou modification économique exige une nouvelle
  décision versionnée.

## Réponses validées aux dix sujets

### 1. Programme individuel et absence de KYB

Validé. L'adhésion est réservée à une personne physique qui accepte les
Conditions et atteste l'âge et la capacité requis localement. Norva ne prétend
pas que l'absence de KYB dispense une entreprise de ses obligations : une
entreprise est simplement hors du programme P0. Didit est requis uniquement
avant un virement cash, lorsque l'identité, l'âge, le pays et la capacité
doivent devenir des faits vérifiés.

### 2. Commission récurrente de 20 %

Validé. La rémunération dépend exclusivement des paiements réels et éligibles
d'un client directement attribué. Elle ne dépend jamais d'un recrutement en
chaîne. Le taux, la base hors taxes, les exclusions, la durée et la version du
programme sont affichés et figés. Aucun revenu ni maintien à vie n'est garanti.

### 3. Attribution 30 jours et maturation J+45

Validé. Ces durées sont contractuelles, versionnées et exécutées côté serveur.
J+45 est une date minimale de disponibilité, soumise aux remboursements,
litiges, faits financiers autoritatifs, contrôles de fraude et obligations
légales ; ce n'est pas une promesse de versement à date fixe.

### 4. Remboursements, chargebacks et contre-écritures

Validé. Le ledger est append-only. `REFUND`, `CHARGEBACK`, `DISPUTE_WON`,
`TRANSFER`, retour et correction produisent des écritures liées et idempotentes.
Un solde négatif n'autorise aucun prélèvement sur la carte ou l'abonnement du
partenaire ; il est compensé seulement par de futures commissions valides,
sous réserve du droit applicable.

### 5. Crédit d'accès Norva

Validé sous traitement fiscal conservateur. Le crédit est fermé, personnel,
non transférable, non remboursable en cash et utilisable uniquement pour un
accès Norva. Norva ne le présente ni comme monnaie électronique ni comme
fiscalement neutre. La commission est considérée mise à disposition lorsqu'elle
devient disponible ; la conversion est suivie comme l'utilisation de cette
rémunération contre un avantage Norva valorisé au quote serveur exact. Cette
position évite de soustraire l'avantage au suivi fiscal sans prétendre produire
une qualification opposable à l'administration.

### 6. Seuil, devise et frais

Validé. Le programme utilise USD comme référence et `USD 10.00` comme seuil
cash mondial de référence. Chaque fait financier conserve sa devise et son
exposant autoritatifs. Chaque corridor fixe une devise et un seuil exacts ; il
n'existe aucune conversion implicite. Norva absorbe ses frais d'envoi, sans
garantir qu'une banque tierce ne prélèvera jamais ses propres frais.

### 7. Fiscalité et reporting

Validé sous méthode prudente. Les revenus et avantages de promotion sont
présentés comme potentiellement imposables et déclarables dès le premier euro.
Norva conserve les agrégats annuels par bénéficiaire, devise, date de mise à
disposition, cash, avantage et contre-écriture. Pour la France, l'article 240
du CGI et la doctrine BOFiP sont traités comme applicables aux commissions : la
déclaration annuelle est préparée lorsque le champ et le seuil supérieur à
2 400 EUR par bénéficiaire sont atteints. L'inscription au crédit du compte
Norva est traitée comme mise à disposition ; le virement ultérieur n'est pas
compté une seconde fois. Le partenaire reste responsable de ses formalités,
cotisations, factures, TVA et déclarations personnelles.

Pour le canal Web France/USD, la policy P0 traite le montant Revolut comme hors
taxe uniquement parce que Norva applique actuellement la franchise en base de
TVA. Cette décision expire avec la policy ; une option TVA ou une perte de la
franchise impose d'abord `partners_earnings_enabled=false`, puis une nouvelle
policy. Elle ne constitue pas un taux de TVA nul permanent attaché au produit.

### 8. Pays, sanctions et ouverture mondiale

Validé par acceptation explicite d'un risque résiduel, pas par une prétendue
revue pays par pays. L'adhésion mondiale n'autorise pas automatiquement le cash.
Norva peut fermer une juridiction ou un compte pour une règle, sanction ou
restriction documentée. La géolocalisation IP n'est jamais une preuve de pays
légal. Le cash reste France jusqu'à une nouvelle policy approuvée. Le
propriétaire accepte que les règles locales de promotion et de fiscalité hors
France puissent imposer des formalités supplémentaires au membre et à Norva.

### 9. Conditions, privacy et disclosure

Validé pour les versions scellées. Les Conditions identifient les parties, la
mission, la rémunération, la durée, les droits, le droit applicable, le crédit,
Didit, Revolut manuel, les corrections et le contact. Une copie durable est
téléchargeable. Le partage inclut une mention explicite dans la langue de
l'audience ; les versions anglaise et française sont fournies. Le programme
interdit sous-affiliation, multiniveau, achat obligatoire et rémunération du
seul recrutement.

### 10. Séparation sans KYC / cash avec KYC

Validé. Le contrat, l'API et l'interface séparent deux capacités :

1. adhérer, partager, gagner et convertir en accès sans biométrie ;
2. demander un virement seulement après admission cash, information dédiée,
   consentement biométrique, Didit, profil fiscal, bénéficiaire, corridor et
   maker-checker.

Le retrait du consentement Didit bloque les nouveaux contrôles et virements,
mais ne ferme ni l'adhésion, ni le lien, ni le ledger, ni le crédit d'accès.

## Contrôles obligatoires associés

- package immuable lié au commit et au déploiement réels ;
- renouvellement de l'avis dans 90 jours ou avant tout changement matériel ;
- enregistrement séparé de l'acceptation de risque propriétaire ;
- preuve Membership Privacy avant l'adhésion publique ;
- AIPD/Privacy Didit et policy France avant le cash ;
- deux opérateurs Finance MFA avant tout lot ;
- aucun cron ni appel Revolut API sous Business Basic ;
- `partners_payouts_live=false` hors fenêtre supervisée ;
- arrêt automatique si les faits financiers exacts ou les preuves deviennent
  périmés.

## Sources officielles principales

- Ministère de l'Économie, influence commerciale, fiscalité, avantages en
  nature, mineurs et contenu du contrat :
  https://www.economie.gouv.fr/suis-je-influenceur-demarches
- BOFiP, déclaration des commissions, seuil annuel et mise à disposition par
  inscription au crédit d'un compte :
  https://bofip.impots.gouv.fr/bofip/8661-PGP.html/identifiant=BOI-BIC-DECLA-30-70-20-20250212
- Code général des impôts, article 240 :
  https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000030751913/2026-01-01
- Directive (UE) 2016/1065 relative au traitement TVA des bons :
  https://eur-lex.europa.eu/eli/dir/2016/1065/oj
- Directive 2009/110/CE relative à la monnaie électronique :
  https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32009L0110

## Conclusion de gate

Pour le périmètre scellé et sous les contrôles ci-dessus, les onze checks du
package `legal_and_tax` peuvent être marqués vrais par le propriétaire. Le nom
historique de la gate reste `legal_and_tax_approved`, mais l'interface et les
preuves doivent continuer d'afficher « position juridique/fiscale et risque
propriétaire », `reviewer_role=accountable_owner` et
`external_professional_review_obtained=false`.
