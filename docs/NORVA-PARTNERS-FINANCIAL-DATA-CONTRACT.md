# Norva Partners — contrat de données financières P0

**Version :** 30 juillet 2026
**État :** shadow, fail-closed, aucun versement réel

Ce contrat relie les événements de paiement autoritatifs au schéma privé
`affiliate_private`. Il ne change ni les droits d'accès Norva ni le comportement
des paiements existants. Son unique responsabilité est de réduire une
observation provider en fait financier immuable, puis de laisser PostgreSQL
décider si ce fait est suffisamment complet pour créer une commission.

## Principes non négociables

- Un identifiant provider brut ne traverse pas la RPC : transaction, parent et
  source économique sont hachés en SHA-256 hexadécimal minuscule.
- Le payload provider n'est pas copié dans Partners. Seuls les champs
  financiers normalisés et un hash de payload sont conservés.
- Aucun exposant de devise, taxe, remise, frais, net ou montant éligible n'est
  déduit d'un prix catalogue, d'un pourcentage estimé ou d'une convention
  « deux décimales ».
- Un champ inconnu reste `NULL`. Le fait devient `incomplete` et aucun job de
  commission n'est créé : ce blocage n'est jamais remplacé par un zéro.
- USD est la devise commerciale, de comparaison et de seuil de référence du
  programme (`10,00 USD`, soit `1000` unités mineures). Elle ne remplace jamais
  le champ `currency` autoritatif d'un paiement, d'une commission ou d'un
  règlement. Les transactions Google Play localisées et les règlements SEPA
  conservent notamment leur devise et leur exposant exacts.
- Le code ISO et l'exposant d'une devise configurée sont immuables. Une
  observation FX n'est recevable que pour la paire, la direction, les exposants
  et la fenêtre de validité exacts. L'éligibilité autoritative compare toujours
  le solde et son seuil figé dans la même devise ; sa valorisation USD reste une
  observation de pilotage et ne peut ni créer un lot ni déplacer un ledger.
- Les frais de payout facturés à Norva par le provider ou la banque émettrice
  sont des charges de plateforme distinctes. Le lot conserve le montant exact de
  commission à verser ; ces frais ne sont ni soustraits de ce montant ni injectés
  dans le ledger de commission.
- Un événement financier `transfer` est toujours `quarantined` et ne crée
  jamais de commission. La continuité d'entitlement RevenueCat suit une machine
  d'états séparée, sans déplacer de fait financier ni de ledger Partners.
- L'environnement `sandbox` peut être observé, mais ne crée jamais de
  commission.
- Les faits et écritures sont append-only. Toute correction financière future
  est un nouvel événement relié, jamais une mutation silencieuse.

## Producteurs et réduction

| Producteur | Événement autoritatif | Type Partners | Identité / parent | Montants explicitement utilisables |
|---|---|---|---|---|
| RevenueCat → Google Play Orders | `INITIAL_PURCHASE`, `NON_RENEWING_PURCHASE` | `capture` | order id RevenueCat, vérifié par `orders.get` | `total` payé après remises, `tax`, devise et exposant configuré |
| RevenueCat → Google Play Orders | `RENEWAL` | `renewal` | order id RevenueCat, vérifié par `orders.get` | `total` payé après remises, `tax`, devise et exposant configuré |
| RevenueCat → Google Play Orders | `CANCELLATION` avec `CUSTOMER_SUPPORT` | `refund` ou `chargeback` | événement RevenueCat / order id d'origine | remboursement complet, ou unique remboursement partiel traité, et sa taxe |
| RevenueCat | `TRANSFER`, `PURCHASE_REDEEMED` | `transfer` | `event.id` stable ; aucun parent transaction fourni par `TRANSFER` | aucun montant supposé ; quarantaine |
| Revolut webhook | ordre `refund` en état `COMPLETED` | `refund` | ordre refund / `related_order_id` | `amount` minor explicite + devise ; composants inconnus `NULL` |
| Revolut webhook | ordre `chargeback` en état `COMPLETED` | `chargeback` | ordre chargeback / `related_order_id` | `amount` minor explicite + devise ; composants inconnus `NULL` |
| Revolut webhook | `DISPUTE_LOST`, puis GET serveur du dispute `lost` | `chargeback` | `dispute.id` / `payment.order_id` | `amount` minor explicite + devise ; composants inconnus `NULL` |
| Revolut webhook | `DISPUTE_WON`, puis GET serveur du dispute `won` | `chargeback_reversal` | `dispute.id` / chargeback autoritatif précédent | même montant minor et devise que le chargeback exact ; contre-correction uniquement |
| Revolut webhook | ordre abonnement en état `COMPLETED` | `capture` ou `renewal` | `order_id` | `amount` minor explicite + devise ; composants inconnus `NULL` |
| Revolut billing | capture récurrente confirmée `COMPLETED` | `capture` ou `renewal` | le même `order_id` que le webhook | montant débité minor explicite + devise ; composants inconnus `NULL` |

Les événements de validation de carte (`trial_setup`, `plan_change`,
`card_update`) ne sont pas des captures et ne produisent aucun fait. Les
événements non réglés (`PENDING`, `PROCESSING`, `AUTHORISED`) ne produisent
aucun fait. `REFUND_REVERSED` reste hors du vocabulaire P0 et doit faire l'objet
d'un type de correction explicite avant ingestion. `DISPUTE_WON` possède en
revanche le type append-only `chargeback_reversal` : il ne recrée pas une vente,
mais rattache une unique écriture `reinstatement` au chargeback et à sa
`reversal` exacts. Toute divergence de propriétaire, attribution, montant,
devise, chronologie ou lineage est mise en conflit ou en dead-letter, jamais
acquittée comme un succès.

`TRANSFER` utilise son `event.id` stable comme identité d'observation. RevenueCat
ne fournit volontairement aucun `transaction_id` dans ce groupe d'événements :
le parent reste donc `NULL`, sans être reconstruit depuis les identifiants de
compte. Le fait financier demeure en quarantaine et n'alimente jamais le
ledger. En parallèle, le receiver authentifie le webhook RevenueCat sur le corps
brut, relit `CustomerInfo` côté serveur et confie la projection d'entitlement à
un worker borné. Une source déjà expirée est résolue, un état actif strictement
postérieur au transfert est préservé comme nouvel achat, et une égalité ambiguë
reste partielle avec alerte. Cette projection n'invente ni montant, ni taxe,
ni commission.

RevenueCat reste le signal de cycle de vie et d'identité économique, mais ses
prix/taxes estimés ne sont jamais utilisés pour une commission. Pour un
utilisateur réellement attribué, un événement Google Play de production est
enrichi côté serveur par `orders.get`, avec un compte de service dédié et le
package exact. `Order.total` est le montant final réellement payé après remises,
taxes incluses ; `Order.tax` est la taxe réellement incluse. Ils sont convertis
en minor units uniquement si `currency_exponent` est actif dans la base et si
les nanos se convertissent sans aucun arrondi.

Le champ `discount_minor` est un contexte facultatif. Google ne fournit pas une
remise top-level autoritative séparée de `total` ; l'adaptateur conserve donc
`NULL` au lieu de la reconstruire depuis le prix catalogue. La base éligible
canonique est :

```text
gross_minor = montant final payé après remises, taxes incluses
eligible_minor = gross_minor - tax_minor
```

Une remise ne doit jamais être soustraite une seconde fois. Le fait reste
`incomplete` si le service Google n'est pas configuré, si le compte n'est pas
attribué, si la devise est inactive, si le produit/order ne correspond pas, ou
si la réponse n'est pas autoritative. Les réponses Google brutes
(`purchaseToken`, `buyerAddress`, titres localisés) ne sont ni journalisées ni
persistées ; seul le sous-ensemble financier normalisé atteint la RPC.

Pour un remboursement complet, `orderHistory.refundEvent.refundDetails` fournit
montant et taxe. Un remboursement partiel n'est utilisable que s'il existe
exactement un `partialRefundEvent` en état `PROCESSED_SUCCESSFULLY`; plusieurs
événements partiels ne peuvent pas être corrélés de façon certaine au signal
RevenueCat et restent donc `incomplete`. Un remboursement complet dont la raison
Google est `CHARGEBACK` devient explicitement un `chargeback`.

Le rail Web/Revolut reste volontairement `incomplete`. Revolut garantit
`order.amount` en unité mineure, mais Norva n'a pas encore de moteur fiscal ni
de ventilation taxe/remise autoritative versionnée pour ce rail. En particulier,
`tax_minor=0` n'est jamais supposé. Aucun fait Web ne devient commissionnable
avant livraison de ce contrat fiscal.

Pour `DISPUTE_LOST`, le body webhook signé ne constitue qu'un signal. Le handler
charge l'objet autoritatif via `GET /api/disputes/{dispute_id}` (API version
`2026-04-20`), exige `state=lost`, `payment.order_id`, un propriétaire local
unique, un montant minor positif et une devise cohérente, puis ingère seulement
le fait normalisé. Les événements de dispute sont disponibles uniquement en
production.

`DISPUTE_WON` suit la même lecture serveur, exige `state=won`, un timestamp
provider valide et le chargeback `DISPUTE_LOST` exact. La contre-correction
restaure uniquement ce qui avait été automatiquement reversé : dans
`partner_commission_pending` si aucune maturation n'avait libéré l'accrual, ou
dans `partner_commission_available` lorsqu'un `release` existe déjà. Un solde
de recovery est réduit avant tout crédit positif. L'idempotence autorise une
seule `reinstatement` par `reversal`, y compris si `WON` arrive avant `LOST`.

Références provider :

- RevenueCat, Event Types and Fields :
  <https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields>
- Google Play Developer API, Orders :
  <https://developers.google.com/android-publisher/api-ref/rest/v3/orders>
- Google Play Developer API, `orders.get` :
  <https://developers.google.com/android-publisher/api-ref/rest/v3/orders/get>
- Google Play Developer API, `Money` :
  <https://developers.google.com/android-publisher/api-ref/rest/v3/Money>
- Revolut, Merchant API — Disputes :
  <https://developer.revolut.com/docs/api/merchant>
- Revolut, Refund payments :
  <https://developer.revolut.com/docs/guides/merchant/operations/refunds>

## Identité économique et replays

La clé d'observation économique est :

```text
(environment, rail, event_type, sha256(economic_id))
```

`economic_id` est le `transaction_id`/`order_id` provider pour un mouvement
monétaire et le `event.id` RevenueCat pour `TRANSFER`. La source canonique
partagée par les deux observateurs Revolut est :

```text
sha256(
  "billing:economic:v1:" +
  environment + ":" +
  rail + ":" +
  event_type + ":" +
  sha256(economic_id)
)
```

Le timestamp de transport ne participe ni à la clé ni au hash de payload.
Ainsi, le cron de facturation et le webhook peuvent observer le même ordre à
des instants différents sans créer une deuxième commission. Une observation
identique est un replay. Une différence de propriétaire, parent, devise ou
montant sur la même clé produit atomiquement `conflict=true`, une observation
de conflit sanitisée, un fait `quarantined` et un éventuel job
`dead_letter`. Le paiement et les droits de l'utilisateur ne sont pas annulés
par ce conflit Partners. `P0003` reste réservé à une collision d'identité/hash
impossible à rattacher à cet événement économique ; elle demeure une erreur
opérationnelle, pas un succès simulé.

## Ordre des écritures

Pour une capture ou un remboursement autoritatif :

1. le journal de paiement Norva existant est écrit de manière idempotente ;
2. le fait Partners est ingéré ;
3. la projection de droits poursuit sa logique existante ;
4. le marqueur provider « processed » est écrit en dernier.

Une panne transitoire Partners laisse donc le webhook rejouable. Les écritures
de paiement et de droits déjà existantes étant idempotentes, un retry ne
redébite pas l'utilisateur. Un conflit immuable retourné avec `conflict=true`,
déjà mis en quarantaine par la base, est terminal et ne bloque pas les droits.

## Worker financier

`norva-partners-worker/cron/run` :

- accepte uniquement `POST` avec le secret cron Norva vérifié par
  `norva_verify_cron_secret` ;
- lease au plus 50 jobs par lot et au plus huit lots configurés ;
- complète les accruals/réversals dans les RPC DB qui figent le taux de 20 % et
  écrivent les postings équilibrés ;
- lease uniquement les maturations déclarées disponibles par la DB
  (programme P0 : J+45), sans recalculer la date dans Edge ;
- classe les erreurs de contrat/ressource en dead-letter, les erreurs
  transitoires en retry et laisse expirer un lease perdu ; la DB borne les
  retries à 12 leases puis bascule en dead-letter, avec backoff plafonné à 1 h ;
- exécute une réconciliation shadow `dry_run=true` sur une fenêtre bornée ;
- publie des heartbeats sanitisés distincts pour `commission`, `correction`,
  `maturation` et `reconciliation`, y compris un état `degraded` en cas
  d'échec ;
- ne contacte aucune autre Edge Function ni aucun provider de versement.

Le worker RevenueCat TRANSFER possède son propre heartbeat
`revenuecat_transfer`, un budget global inférieur au timeout du cron et des
compteurs bornés pour partiels, quarantaines et dead-letters. Sous Revolut
Business Basic, aucun worker provider n'exécute les versements : Finance les
saisit manuellement avec la référence Norva, puis le relevé officiel devient la
preuve autoritaire. Une confirmation de saisie seule ne fabrique jamais un
settlement.

Le cron du worker financier Norva n'est pas seedé par migration. L'URL de
production et son secret n'étant pas des constantes de schéma, l'opérateur
l'enregistre seulement après déploiement et smoke test. L'ancien cron de
versement générique et le futur cron Revolut API doivent au contraire être
absents ou inactifs sous Basic ; leur absence est l'état attendu, pas
`not_configured`.

## Activation et enrichissement

L'ordre de déploiement est : migration DB, tests jetables/Advisors, fonctions
productrices, workers, puis enregistrement manuel des crons. Les devises restent
désactivées tant que Finance n'a pas configuré explicitement code ISO et
exposant. Seuls les corridors `revolut_manual` peuvent être actifs au pilote.
`revolut_api` reste inerte tant que sa gate, son flag DB et son kill switch
Edge sont faux.

L'activation de USD comme devise de référence ne désactive pas EUR ni les autres
devises autoritatives. Chaque corridor reste un couple pays/devise explicite et
chaque seuil hors USD est une valeur versionnée ; aucune conversion FX n'est
effectuée pendant la création du lot. Les frais de transfert réellement payés
par Norva doivent rester observables et rapprochables comme coûts de plateforme,
sans modifier le montant partenaire attendu.

Pour rendre un événement commissionnable, la source doit fournir de façon
autoritative et cohérente :

```text
currency
currency_exponent
gross_minor
discount_minor             # contexte facultatif, peut rester NULL
tax_minor
eligible_minor = gross_minor - tax_minor
```

L'enrichissement Google Play a lieu avant la première ingestion du fait. Un fait
déjà ingéré comme `incomplete` n'est pas modifié : un backfill futur exige un
type de correction append-only versionné et une source Orders autoritative.

Même complet, un fait ne crée un job que si l'attribution et le compte
partenaire sont éligibles, l'environnement est `production`, le mode shadow
(ou payouts live) est activé et la release gate
`financial_data_contract_approved` est satisfaite. Ces conditions restent
indépendantes du simple déploiement du code.

## Ce qui empêche encore un statut 100 % live

- Les migrations, producteurs et workers doivent être déployés dans l'ordre,
  puis les crons doivent être enregistrés manuellement.
- `REVOLUT_API_BASE` doit pointer sur le bon environnement ; les secrets
  RevenueCat/Revolut existants doivent être actifs et leurs webhooks vérifiés.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` doit contenir le JSON du compte de service
  dédié ayant accès en lecture aux commandes du package exact
  `GOOGLE_PLAY_PACKAGE_NAME=tv.norva.phone`. Une configuration partielle ou une
  erreur OAuth reste un incident visible ; les deux variables absentes gardent
  simplement les faits incomplets.
- La table de métadonnées devise démarre vide et la release gate financière
  n'est jamais approuvée automatiquement.
- Google Play peut produire un fait complet après enrichissement Orders. Le rail
  Web/Revolut reste incomplet tant qu'aucun moteur fiscal et aucune ventilation
  taxe/remise autoritative ne sont configurés.
- Les événements provider déjà marqués `processed` avant ce déploiement ne sont
  pas rejoués automatiquement. Un backfill historique ne pourra être lancé que
  depuis une source financière autoritative, jamais depuis un prix reconstitué.
- Le monitoring doit alerter sur conflit, incomplete, plus vieux job prêt,
  retry, dead-letter, lease expiré, TRANSFER partiel/ancien et mismatch shadow
  avant le pilote.
- Le rail Revolut manuel exige un registre bénéficiaire HMAC versionné, une
  route devise/pays explicitement approuvée et un relevé réel dont le format a
  été validé hors ligne. L'export brut est traité en mémoire ; Norva ne conserve
  que les observations minimisées et leur empreinte.
- La complétude est un invariant transactionnel : référence, montant mineur et
  devise correspondent exactement. Une référence inconnue, un montant/devise
  différent, un doublon ou un paiement tardif crée un incident append-only et
  ne déplace aucune somme sans résolution maker-checker.
- Les jobs `norva-partners-payout` et `norva-partners-revolut-api` doivent
  être absents ou inactifs sous Basic. Leur désactivation fait partie de la
  preuve de release.
- Un settlement exige une revue Finance puis une décision d'un second acteur
  Finance distinct. `partners_payouts_live=false`, l'absence de corridor réel et
  l'absence de deux cycles supervisés empêchent tout statut live.
- Les profils fiscaux réels et la ventilation Web HT/taxe autoritative restent
  nécessaires avant de commissionner le rail Web ou de payer un partenaire.
