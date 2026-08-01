# Norva Partners — contrat analytics et supervision

## Principe

Une absence d'observation n'est jamais un zéro. Chaque section enrichie de
`admin_partners_analytics` retourne `status: available` avec une valeur
autoritative, ou `status: unavailable` avec une raison stable. Les métriques
restent agrégées et ne contiennent aucun nom, e-mail, UUID, code public,
référence KYC/paiement ou payload fournisseur.

La fenêtre demandée est comprise entre 1 et 365 jours et utilise un intervalle
UTC semi-ouvert `[start, end_exclusive)`.

## Capacités

- Support : volumes quotidiens, funnel de claims, attributions, premiers
  paiements et activations.
- Risk : KYC terminaux/bloqués, comptes et attributions held/blocked, faits
  financiers quarantinés.
- Finance : montants exacts par rail, devise et exposant, refunds, chargebacks,
  commissions, contribution et délai du premier versement.

Un Admin possédant au moins une capacité peut appeler la RPC, mais chaque
section étrangère à sa capacité retourne `unavailable`. Les montants ne sont
donc pas rendus visibles à Support par défaut.

## Définitions

- `claims_issued` : claims opaques émis pendant la fenêtre. Norva ne possède pas
  encore d'événement de clic distinct ; `clicks` reste `unavailable`.
- `attributions_created` : attributions reliées à la cohorte de claims émis
  pendant la fenêtre.
- `first_paid_referrals` : premier fait `capture` ou `renewal`, complet,
  production et attribué pour le filleul de la cohorte.
- activation : événements immuables `account_activated`, complétés par les
  sessions KYC dont `verified_at` appartient à la fenêtre.
- risk current : photographie actuelle des comptes/attributions held, blocked
  ou suspended ; les métriques dont le nom finit par `_in_window` utilisent la
  fenêtre UTC.
- finance : faits complets de production attribués, regroupés par
  `rail + currency + currency_exponent`. Les refunds et chargebacks sont
  soustraits du revenu éligible ; les contre-écritures sont soustraites de la
  commission nette.
- seuil de référence : le programme P0 contient obligatoirement
  `payout_thresholds.USD = 1000`, soit 10,00 USD. Cette valeur est une référence
  commerciale mondiale, pas une instruction de change. Chaque devise de
  règlement autorisée possède aussi son propre seuil entier, figé et affiché
  avant acceptation ; un client ne calcule jamais lui-même un équivalent FX.
- éligibilité au versement : une observation conserve la devise et le montant
  exacts du solde, le seuil exact de cette même devise et, lorsqu'une comparaison
  de référence est nécessaire, l'identifiant du snapshot de taux autoritatif.
  Une donnée de taux absente, périmée ou incohérente rend l'observation
  `unavailable` ; elle ne produit ni conversion implicite ni faux « éligible ».
- frais de versement : les coûts provider, banque émettrice et change sont des
  faits append-only séparés, toujours `borne_by = platform`. Ils ne débitent ni
  la commission ni le ledger du partenaire. Les frais restent ventilés par
  devise ; aucun total multi-devise n'est publié sans preuve FX autoritative.
- contribution : revenu éligible net moins commission partenaire nette. Elle
  devient `unavailable` si un fait financier attendu n'a pas encore son
  écriture. Une contribution après frais de versement n'est publiée que lorsque
  les faits de coût provider et change sont complets et autoritatifs. La marge
  finale reste `unavailable`, car fiscalité propre à Norva, infrastructure,
  support et autres coûts d'exploitation ne sont pas encore tous modélisés.
- premier versement : premier item et cycle tous deux `settled`. Les médianes
  partent de la première activation et du premier accrual. Toute la section
  reste `unavailable` tant que le provider, sa gate et
  `partners_payouts_live` ne prouvent pas un rail réel.
- rétention : `unavailable` tant que l'historique autoritatif des droits et de
  l'intervalle de facturation n'est pas modélisé.
- `TRANSFER` : le fait financier quarantiné est compté pour Risk/Finance et ne
  produit aucune commission. La projection d'entitlement RevenueCat est suivie
  séparément par états `pending`, `processing`, `partial`, `applied`,
  `quarantined` ou `dead_letter`.
- `DISPUTE_WON` : la correction `chargeback_reversal` et son
  `reinstatement` sont comptées séparément. Le net soustrait reversals et
  corrections manuelles, puis ajoute les reinstatements exacts.
- settlement Revolut Basic : la confirmation de saisie par référence ne
  constitue pas un règlement. Seule une ligne `COMPLETED` du relevé officiel,
  rattachée par référence Norva, montant et devise exacts, puis revue et
  confirmée par deux acteurs Finance distincts, rend l'item `settled`. Une
  quarantaine reste révisable ; une résolution financière est terminale et
  idempotente.

## Alertes stables

`partners_ops_alert_snapshot` publie uniquement codes, sévérité et compteurs :

- dead-letter commission/maturation/chargeback-reversal : critique dès la
  première ligne ;
- conflit de fait financier : critique dès la première ligne ;
- dernier rapprochement shadow en écart : critique ;
- heartbeat commission/correction/maturation/reconciliation/
  revenuecat_transfer attendu mais absent ou âgé de plus de 15 minutes :
  critique. Le heartbeat provider `payout` n'est jamais attendu sous Revolut
  Basic ;
- quota Didit sur 30 jours : warning à 400/500, critique à 500/500, toujours
  informatif et non bloquant ;
- nouveau fait `TRANSFER` quarantiné créé dans les dernières 24 heures :
  warning `financial_transfer_quarantined_recent` ;
- événement RevenueCat TRANSFER en `dead_letter` ou outbox Partners en échec :
  critique dès la première ligne ;
- événement TRANSFER `partial` vieillissant ou quarantaine ancienne : warning
  avec compte et âge bornés, sans identifiant ;
- incident Revolut manuel ouvert, quarantiné ou revu sans décision : warning ;
  montant/devise incorrects, référence inconnue, doublon `COMPLETED`, paiement
  tardif, retour ou contrôle de lot en attente : critique selon la nature et
  l'âge, sans identifiant bancaire brut ;
- tout job `norva-partners-payout` ou `norva-partners-revolut-api` actif sous
  Basic : critique de configuration. L'absence de ces crons est l'état sain
  attendu, pas un heartbeat manquant.

La fenêtre de 24 heures évite une alerte éternelle sur un stock append-only.
Le stock total reste visible dans analytics pour le suivi Risk/Finance. Un
heartbeat ne devient attendu qu'après déploiement/activation du worker
correspondant ; l'absence de configuration est `not_configured`, pas `healthy`.

La file Admin d'incidents expose séparément `total` pour le filtre courant et
`action_required` pour tout le stock ouvert/quarantiné. Elle est paginée avec
`limit`/`offset`, triée par statut, priorité puis ancienneté, et chaque ligne
porte `priority` et `observed_at` afin de calculer l'âge sans le confondre avec
le volume. Une RPC indisponible ou une enveloppe invalide s'affiche
`unavailable` ; elle ne devient jamais `0 incident`.

## Preuves runtime

Avant le pilote, conserver dans le journal de release :

1. un appel autorisé et un appel refusé pour chaque capacité ;
2. un cas `unavailable` rendu comme tel dans l'Admin, jamais comme zéro ;
3. un heartbeat frais puis périmé avec alerte et notification de rétablissement ;
4. les seuils KYC 400/500 et 500/500 sur données sandbox ;
5. un refund, un chargeback et un fait incomplet sans commission inventée ;
6. un `TRANSFER` financier quarantiné, puis les cas entitlement appliqué,
   source expirée, nouvel achat préservé, égalité partielle et dead-letter ;
7. `DISPUTE_LOST → maturation/release → DISPUTE_WON`, avec restauration exacte,
   replay et ordre inversé ;
8. une saisie Revolut confirmée sans identifiant bancaire client, puis son
   rattachement autoritaire par relevé et sa double validation ;
9. chaque incident manuel : référence inconnue remappée exactement,
   montant/devise incorrects libérés seulement après retour, quarantaine
   réouverte, doublon ou paiement tardif produisant hold et récupération ;
10. les trois crons provider/API absents ou inactifs sous Basic ;
11. `payout_thresholds.USD = 1000`, puis le refus de tout payload où cette
    référence dérive ou lorsqu'une devise de règlement n'a pas de seuil exact ;
12. un frais de versement absorbé par Norva, visible comme coût plateforme sans
    réduction du solde partenaire, puis un snapshot FX absent rendu
    `unavailable` ;
13. une réconciliation shadow propre.

Les événements UX facultatifs côté client ne sont pas une source financière et
ne sont pas déclarés actifs tant que leur instrumentation consentie et leur
validation runtime n'ont pas été livrées.
