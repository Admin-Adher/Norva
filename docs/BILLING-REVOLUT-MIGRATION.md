# Refonte paiement — Stancer → Revolut Merchant API

> Plan de migration. Remplace Stancer par la **Revolut Merchant API (Subscriptions)**,
> puis bascule `NORVA_ENTITLEMENTS_MODE` de `observe` à `enforce`.
> Audit complet du billing existant : voir la section « Seam » ci-dessous.

## Décisions produit (verrouillées le 2026-07-11)

| Décision | Choix |
|---|---|
| Collecte de carte / essai | **Carte à l'ouverture** — widget RevolutCheckout + `savePaymentMethodForMerchant`, abonnement natif Revolut avec **phase d'essai 7 j** puis débit auto. Reproduit l'UX footprint 0,50 € de Stancer. |
| Devise de facturation | **USD ($)** |
| Bypass admin en `enforce` | **Oui** — `app_metadata.role='admin'` = accès complet sans abonnement (exemption dans `getEntitlementDecision`). |
| Plans / prix | **Norva** 4,99 / 41,99 (2 flux simultanés) · **Norva Family** 8,99 / 75,99 (5 flux). Annuel ≈ −30 %. |

## Le seam — pourquoi c'est chirurgical

La couche entitlements est **agnostique du provider**. `_shared/entitlements.ts` ne
mentionne ni Stancer ni aucun rail : chaque décision d'accès lit **une seule table**,
`cloud_entitlement_projection` (colonnes `provider/status/plan_code/current_period_end/
trial_ends_at/limits`). Cette table a déjà **3 écrivains** (Stancer, webhook RevenueCat,
auto-trial système). Revolut = **un 4ᵉ écrivain**, rien de plus côté lecture.

- **Lecture inchangée** : `entitlements.ts`, le read-path (`norva-cloud /entitlements`),
  l'enforcement des flux simultanés (`norva-playback:221`), le `checkCloudAccess` client.
- **Différence clé vs Stancer** : Stancer n'a **pas** d'abonnement natif → Norva rejoue
  à la main essai→débit→renouvellement dans un cron (`norva-stancer-billing`). Revolut a
  des **abonnements natifs** → on **supprime** ce cron ; Revolut possède le cycle de vie,
  on ne fait que **projeter ses webhooks**. Le meilleur modèle à copier est le webhook
  **RevenueCat** (`norva-billing-webhook`), pas les fonctions Stancer.

## Modèle Revolut (référence)

- **Hiérarchie** : `Plan` → `Variations` (mensuel/annuel) → `Phases` (essai 7 j → facturation)
  → `Subscription items` (montant + devise). `customer_id` requis.
- **Carte** : widget **RevolutCheckout.js** avec `savePaymentMethodForMerchant: true` →
  carte tokenisée liée au client, réutilisable **sans le client présent** (renouvellements =
  merchant-initiated transactions). On reste sur norva.tv (embarqué).
- **Webhooks** (HMAC-SHA256, header `Revolut-Request-Timestamp`, tolérance 5 min ;
  signature = HMAC de `version.timestamp.payload_brut`) :
  `SUBSCRIPTION_INITIATED` · `SUBSCRIPTION_FINISHED` · `SUBSCRIPTION_CANCELLED` ·
  `SUBSCRIPTION_OVERDUE` · `ORDER_COMPLETED` · `ORDER_PAYMENT_DECLINED` · `ORDER_PAYMENT_FAILED`.

## Mapping webhooks Revolut → `cloud_entitlement_projection`

À affiner avec les payloads sandbox réels, mais l'intention :

| Event Revolut | `status` projection |
|---|---|
| `SUBSCRIPTION_INITIATED` (phase d'essai) | `trialing` (+ `trial_ends_at`) |
| `ORDER_COMPLETED` (1ᵉʳ débit après essai / renouvellement) | `active` (+ `current_period_end`) |
| `SUBSCRIPTION_OVERDUE` / `ORDER_PAYMENT_FAILED` | `past_due` (+ `fail_open_until`) |
| `SUBSCRIPTION_CANCELLED` (fin de période) | `cancelled_at_period_end` |
| `SUBSCRIPTION_FINISHED` (période écoulée) | `expired` |
| litige/chargeback | `fraud` (hard-block) |

## Plan de migration (phases)

0. **Prérequis (toi)** : compte **Revolut Business/Merchant** + clés **sandbox** (API key
   secrète + **webhook signing secret**). Me les fournir comme secrets de fonction
   (jamais en clair dans le repo).
1. **Plans Revolut** (sandbox) : créer Norva (2 flux) + Norva Family (5 flux), variations
   mensuel/annuel, phase d'essai 7 j, en USD. Noter les `plan_id`/`variation_id`.
2. **`norva-revolut-webhook`** : vérif signature HMAC-SHA256 + mapping ci-dessus →
   `cloud_entitlement_projection` (`provider:"revolut"`), idempotence via
   `cloud_entitlement_events`. Testable en sandbox sans toucher la prod.
3. **`norva-revolut`** (checkout) : initie l'ordre/abonnement Revolut, renvoie le contexte
   du widget RevolutCheckout ; brancher `billing.js` / `checkout.html`.
4. **Généraliser les fuites Stancer** (voir liste) + ajouter `'revolut'` au CHECK `provider`.
5. **Bypass admin** dans `getEntitlementDecision` (exemption `role='admin'`, seulement utile
   en `enforce`).
6. **Retrait Stancer** (fonctions + tables si inutilisées), validation sandbox de bout en
   bout, puis **`NORVA_ENTITLEMENTS_MODE=enforce`** + `NORVA_BILLING_MODE=revenuecat`
   (soft-wall) ou un nouveau mode `revolut` — à décider en phase 6.

## Fuites Stancer à généraliser/retirer (au-delà de `norva-stancer*`)

1. Tables `cloud_stancer_customers` / `cloud_stancer_payments` (cette dernière = **ledger
   cross-rail**, colonne `provider` — la réutiliser rail-taggée).
2. CHECK `provider` sur `cloud_entitlement_projection` (`…20260703170000`) → ajouter `'revolut'`.
3. `norva-stancer-billing` (cron de débit) → **supprimé** (Revolut natif).
4. `norva-lifecycle` — scans dunning/abandon filtrés `provider="stancer"` → brancher Revolut.
5. `norva-admin` — pings santé `api.stancer.com`, go-live gate, alertes `stancer_down`,
   roll-up finance par `provider` → généraliser.
6. `/admin/refund` (`norva-stancer/index.ts:241`) — `provider === "stancer"` en dur →
   route de remboursement Revolut.
7. Client : `billing.js` (méthodes `stancer*`), `billing-config.js`, `checkout.html` /
   `checkout-done.html` / `subscribe.html` / `subscription.html`, gating `isStancerWeb`.
8. `norva-stancer-webhook` (réconciliateur) → remplacé par `norva-revolut-webhook`.

## Prérequis pour démarrer le code (bloquant)

- [ ] Compte Revolut Merchant + accès **sandbox**.
- [ ] `REVOLUT_SECRET_KEY` (sandbox) + `REVOLUT_WEBHOOK_SIGNING_SECRET` → secrets de fonction.
- [ ] Endpoint webhook déclaré côté Revolut : `https://api.norva.tv/functions/v1/norva-revolut-webhook`.
- [ ] Payloads sandbox réels (subscription + order) pour figer le mapping exact.

## Sources

Revolut : [Subscriptions](https://developer.revolut.com/docs/merchant/subscriptions) ·
[Gestion d'abonnement (guide)](https://developer.revolut.com/docs/guides/merchant/optimise-checkout/save-payment-methods/subscription-management/) ·
[Webhooks](https://developer.revolut.com/docs/merchant/webhooks) ·
[Vérifier la signature](https://developer.revolut.com/docs/guides/merchant/monitor-and-observe/webhooks/verify-the-payload-signature).
