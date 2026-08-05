# Norva Partners — politique juridico-fiscale opérationnelle P0

Version : `partners-tax-operating-policy-global-frcash-p0-v2`
Périmètre : adhésion individuelle publique dans les pays où Norva rend le
programme disponible, commission directe de 20 %, attribution 30 jours,
maturation minimale J+45, crédit Norva optionnel et cash France Revolut manuel
sur allowlist.

## Nature de la décision

Cette politique est une position interne conservatrice acceptée par le
propriétaire de Norva. Elle n'est ni une consultation juridique ou fiscale, ni
une signature de professionnel. L'absence d'avis externe doit rester visible
dans le package `legal_and_tax_approved` grâce aux preuves distinctes
`legal_tax_review` et `owner_risk_acceptance`.

La politique autorise une adhésion individuelle mondiale et un crédit Norva
sans KYC sous acceptation explicite du risque propriétaire. Elle ne prétend pas
constituer une validation professionnelle pays par pays. L'utilisateur doit
respecter les règles de capacité, d'activité, de publicité, de fiscalité et de
protection du consommateur de sa juridiction. Norva conserve un pouvoir de
restriction géographique et de suspension lorsqu'une règle ou une sanction
l'exige. Les sociétés partenaires, le KYB et l'ouverture publique du cash
restent exclus. Le cash demeure limité à la France, à une allowlist et à une
politique pays versionnée.

## Traitement opérationnel prudent

1. Norva traite toute commission devenue disponible après maturation comme une
   rémunération mise à la disposition du partenaire dans sa devise
   autoritative. Le ledger append-only conserve la date, la devise, l'exposant,
   le montant, la source et les contre-écritures.
2. Une conversion en accès Norva n'est jamais présentée comme fiscalement
   neutre. Norva la traite, pour ses contrôles et le relevé utilisateur, comme
   l'utilisation d'une rémunération disponible contre un avantage Norva évalué
   au montant exact du quote serveur.
3. Un virement cash ne crée pas une seconde rémunération : il règle un montant
   disponible déjà tracé. La réconciliation évite le double comptage.
4. Les remboursements, chargebacks, `TRANSFER`, `DISPUTE_WON`, retours de
   virement et erreurs fournisseur produisent des contre-écritures, jamais une
   modification silencieuse de l'historique.
5. Les devises ne sont jamais converties silencieusement. P0 utilise `USD`
   comme devise de référence et du catalogue d'accès ; chaque corridor cash
   conserve sa devise de règlement exacte.
6. Les frais d'envoi pris en charge par Norva ne réduisent pas la commission
   affichée. Une déduction imprévue d'une banque intermédiaire reste un écart à
   rapprocher.

## Contrat fiscal Web France/USD

Au 5 août 2026, Norva est exploité par un entrepreneur individuel français qui
applique la franchise en base de TVA aux prestations Web concernées. Pour le
seul couple `FR/USD` avec exposant 2, le montant Revolut autoritatif est donc
traité par la policy `wtp_fr_usd_owner_v1` comme montant hors taxe :
`gross_minor = eligible_minor` et `tax_minor = 0`. Cette règle ne signifie pas
qu'un abonnement numérique est exoné par nature ; elle dépend du régime de
franchise effectivement applicable à Norva.

La policy est bornée à 90 jours et échoue fermée si le pays carte est absent,
si le pays n'est pas `FR`, si la devise ou l'exposant diffèrent, si la période
est expirée ou si le lignage d'un remboursement/chargeback est incomplet. Le
responsable doit placer immédiatement `partners_earnings_enabled=false`, puis
la remplacer avant toute option volontaire pour la TVA, perte de la franchise,
modification du canal d'encaissement ou extension pays/devise. Les seuils 2026
de prestations de services suivis sont
37 500 EUR pour le seuil de base et 41 250 EUR pour le seuil majoré ; la
surveillance de Norva doit alerter suffisamment tôt pour qu'aucun événement
postérieur à une sortie de franchise ne soit traité avec `tax_minor = 0`.

## Déclarations et pièces

- Le partenaire est informé dès l'adhésion que les espèces et avantages en
  nature issus d'une promotion peuvent être imposables dès le premier euro.
- Norva conserve les agrégats annuels par bénéficiaire et devise nécessaires à
  ses propres obligations, notamment l'article 240 du CGI lorsque son champ et
  son seuil sont atteints. Les sommes créditées et les avantages en nature ne
  sont pas exclus par principe.
- L'inscription, le lien, l'attribution et la maturation ne demandent aucune
  biométrie. Une déclaration fiscale légère peut être demandée quand une règle
  déclarative l'exige ; elle ne vaut pas KYC.
- Didit reste réservé au choix d'un virement cash. Un payout exige en plus le
  profil fiscal vérifié, le corridor, le bénéficiaire tokenisé et les contrôles
  maker-checker.
- Le partenaire doit accomplir les formalités professionnelles, sociales,
  fiscales, de facturation et de TVA qui s'appliquent à son activité. Norva
  suspend la mise à disposition de nouvelles rémunérations si les informations
  légalement requises pour le contrat ou une déclaration restent incomplètes.

## Qualification du crédit Norva

Le crédit est fermé : il est émis uniquement en contrepartie d'une commission
déjà disponible, utilisable seulement pour un accès Norva, non transférable,
non payable à un tiers et non remboursable en espèces. Cette configuration
réduit le risque de qualification comme monnaie électronique, sans prétendre
trancher juridiquement la question. Pour l'exploitation P0, sa valeur est
néanmoins incluse dans le suivi des rémunérations et avantages.

La TVA de l'abonnement Norva sous-jacent continue de suivre les règles du canal
de vente et du lieu de la prestation. Le ledger conserve les faits nécessaires
à une correction future sans réécrire les événements historiques.

## Contrat et promotion

- Le partage utilise une mention claire dans la langue de l'audience et reste
  proche du lien. Pour la France, elle commence par `Publicité — lien
  partenaire Norva`. L'interface fournit aussi `Advertising — Norva partner
  link` pour une audience anglophone ; ces exemples ne dispensent jamais le
  partenaire d'une exigence locale plus stricte.
- Le programme interdit sous-affiliés, downline, multi-niveaux, rémunération du
  recrutement seul, droit d'entrée et achat obligatoire.
- L'acceptation électronique versionnée, la copie durable et la trace serveur
  constituent le contrat écrit. Norva demande toute information complémentaire
  requise avant de dépasser un seuil légal de rémunération ou d'avantage.

## Réévaluation obligatoire

Réévaluer avant tout changement de taux, durée, devise, catalogue d'accès,
fournisseur, structure juridique, fiscalité, pays, cash public, franchissement
d'un seuil déclaratif ou constat d'une position contraire de l'administration.
L'acceptation interne expire au plus tard après 90 jours et doit alors être
renouvelée contre le commit et les surfaces réellement déployés.

## Décision interne du propriétaire

Le propriétaire accepte expressément le risque résiduel suivant pour la couche
mondiale sans cash : l'analyse officielle détaillée ci-dessus est centrée sur
la France et l'Union européenne, et ne tranche pas chaque droit national. Ce
risque est compensé opérationnellement par l'absence de droit d'entrée, de
sous-affiliation et de promesse de revenu, par la transparence obligatoire,
par le ledger exact, par la possibilité de fermer immédiatement un pays et par
l'absence de KYC, coordonnées bancaires et versement cash hors du pilote
France. Cette acceptation ne vaut pas déclaration que le risque est nul.

## Sources officielles principales

- Ministère de l'Économie, activité d'influence commerciale et avantages en
  nature : https://www.economie.gouv.fr/suis-je-influenceur-demarches
- BOFiP, article 240 et sommes mises à disposition :
  https://bofip.impots.gouv.fr/bofip/8661-PGP.html/identifiant=BOI-BIC-DECLA-30-70-20-20250212
- Décret n° 2025-1137 du 28 novembre 2025 :
  https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052950561
- Directive (UE) 2016/1065 relative aux bons :
  https://eur-lex.europa.eu/eli/dir/2016/1065/oj
- Directive 2009/110/CE relative à la monnaie électronique :
  https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32009L0110
