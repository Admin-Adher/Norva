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
- contribution : revenu éligible net moins commission partenaire nette. Elle
  devient `unavailable` si un fait financier attendu n'a pas encore son
  écriture. La vraie marge reste `unavailable`, car frais provider, change,
  infrastructure et autres coûts ne sont pas modélisés.
- premier versement : premier item et cycle tous deux `settled`. Les médianes
  partent de la première activation et du premier accrual. Toute la section
  reste `unavailable` tant que le provider, sa gate et
  `partners_payouts_live` ne prouvent pas un rail réel.
- rétention : `unavailable` tant que l'historique autoritatif des droits et de
  l'intervalle de facturation n'est pas modélisé.
- `TRANSFER` : le stock quarantiné est compté pour Risk/Finance, mais aucun
  entitlement n'est transféré sans contrat autoritatif.

## Alertes stables

`partners_ops_alert_snapshot` publie uniquement codes, sévérité et compteurs :

- dead-letter commission/maturation : critique dès la première ligne ;
- conflit de fait financier : critique dès la première ligne ;
- dernier rapprochement shadow en écart : critique ;
- heartbeat commission/maturation/reconciliation absent ou âgé de plus de
  15 minutes : critique ;
- quota Didit sur 30 jours : warning à 400/500, critique à 500/500, toujours
  informatif et non bloquant ;
- nouveau fait `TRANSFER` quarantiné créé dans les dernières 24 heures :
  warning `financial_transfer_quarantined_recent`.

La fenêtre de 24 heures évite une alerte éternelle sur un stock append-only.
Le stock total reste visible dans analytics pour le suivi Risk/Finance.
Aucun heartbeat payout n'est fabriqué avant l'existence du worker provider.

## Preuves runtime

Avant le pilote, conserver dans le journal de release :

1. un appel autorisé et un appel refusé pour chaque capacité ;
2. un cas `unavailable` rendu comme tel dans l'Admin, jamais comme zéro ;
3. un heartbeat frais puis périmé avec alerte et notification de rétablissement ;
4. les seuils KYC 400/500 et 500/500 sur données sandbox ;
5. un refund, un chargeback et un fait incomplet sans commission inventée ;
6. un `TRANSFER` quarantiné visible sans mutation d'entitlement ;
7. une réconciliation shadow propre.

Les événements UX facultatifs côté client ne sont pas une source financière et
ne sont pas déclarés actifs tant que leur instrumentation consentie et leur
validation runtime n'ont pas été livrées.
