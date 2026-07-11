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
   (jamais en clair dans le repo). ✅ *fait — clés sandbox posées dans `.env` sur la box.*
1. ~~**Plans Revolut** natifs (Plan→Variation→Phase)~~ → **abandonné pour l'instant** au
   profit du modèle **ordre + carte sauvegardée (MIT)** — voir « Décision d'archi » plus bas.
2. **`norva-revolut-webhook`** : vérif signature HMAC-SHA256 + mapping → projection
   (`provider:"revolut"`), idempotence via `cloud_entitlement_events`. ✅ **validée bout en
   bout en sandbox le 2026-07-11** (paiement réel → signature vérifiée → re-fetch de l'ordre →
   projection écrite).
3. **`norva-revolut`** (checkout) : ouvre l'ordre trial-setup, renvoie le token du widget
   RevolutCheckout ; `/confirm` finalise sans webhook ; `/profile /cancel /resume` pour la
   page de gestion. Front : `checkout-revolut.html` (nouveau) + méthodes `billing.js`.
   ✅ **validée bout en bout en sandbox le 2026-07-11** — front self-host → client Revolut →
   ordre + `customer_id` → widget carte → paiement autorisé → carte sauvegardée `MERCHANT`
   → `/confirm` (projection) → carte capturée (`payment_method_id` + last4/brand/exp).
   Deux pièges rencontrés + réglés : (a) le front tapait encore l'ancien Supabase managé via
   un `authApi.js` en cache → cache-buster `?v=` (commit 70cc91c) ; (b) Revolut attache la
   carte **juste après** l'autorisation, donc la capturer dans `/confirm` dépassait la limite
   wall-clock de l'edge → **capture lazy sur `/profile`** (hors chemin critique).
4. **Moteur de renouvellement** `norva-revolut-billing` (cron) : à l'issue de l'essai/période,
   débit MIT via la carte sauvegardée. ✅ **validé en sandbox le 2026-07-11** — essai échu →
   `POST /api/1.0/orders` (create) puis `POST /api/orders/{id}/payments` (**nouvelle API**,
   header `Revolut-Api-Version`) avec `saved_payment_method{type:card,id,initiator:merchant}`
   → état `authorisation_passed` (= succès, capture AUTOMATIC) → projection `active` +
   `current_period_end += 1 période` + `mrr_cents`. Deux pièges réglés : le paiement est sur
   `/api/orders/…` (pas `/api/1.0/…` → 404) ; le succès = `authorisation_passed` (pas seulement
   `completed`). Cron à enregistrer : `ops/hetzner/scripts/register-revolut-billing-cron.sql`.
   **Reste** : généraliser les fuites Stancer (lifecycle/admin/refund) — cf. liste ci-dessous.
5. **Bypass admin** dans `getEntitlementDecision` (exemption `app_metadata.role='admin'`). ✅ **codé.**
   Filet de sécurité owner/staff : un admin n'est jamais soft-wallé (accès complet sans abonnement) ;
   les hard-blocks (revoked/refunded/fraud) restent bloqués. Vérifié **uniquement sur le chemin de
   refus** (rare) — et hors chemin chaud grâce à l'option `isAdmin` que les appelants portant le
   JWT passent (`norva-cloud` /boot + /entitlements) ; les autres appelants retombent sur un
   `getUserById` unique au refus. Sans effet en `observe` (déjà ouvert) → à valider en `enforce` (phase 6).
6. **Bascule production.** ✅ **effectuée le 2026-07-11.** Clés **prod** Revolut + webhook
   prod dans `.env` (`REVOLUT_API_BASE=https://merchant.revolut.com`) ; front basculé
   (`revolut.enabled:true` / `mode:prod`, `stancer.enabled:false`) ; **vrai paiement validé**
   (carte Mastercard réelle → ordre autorisé → client prod + carte tokenisée) ;
   **`NORVA_ENTITLEMENTS_MODE=enforce` + `NORVA_BILLING_MODE=revenuecat`** (soft-wall) actifs.
   Vérifié : **admin** `family/active` passe (`mode:enforce`), **non-abonné** → `free`
   (`concurrent_streams:0`, parcourt sans lire). Cron de renouvellement enregistré
   (`register-revolut-billing-cron.sql`).
   **Reste (nettoyage, non bloquant)** : retrait définitif des fonctions `norva-stancer*` après
   un cycle de facturation complet ; #41 (résilier le managé quand son trafic est à zéro).

## Sujet connexe (hors facturation) — Google OAuth self-host ✅ réglé le 2026-07-11
Le service `auth` (GoTrue) du self-host n'avait pas le provider Google → « Continue with
Google » renvoyait 400 `provider is not enabled`. Réglé : `GOTRUE_EXTERNAL_GOOGLE_*`
ajouté au compose (client **Norva Web** réutilisé), redirect `https://api.norva.tv/auth/v1/callback`
ajouté aux *Authorized redirect URIs* côté Google Cloud, `GOOGLE_CLIENT_ID`/`GOOGLE_SECRET`
+ `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true` dans `.env`. Vérifié : connexion Google complète OK.
(À noter aussi ce jour : une clé de service Firebase `FCM_SERVICE_ACCOUNT` a été exposée puis
**révoquée + régénérée**.)

## Décision d'archi — ordre + carte sauvegardée (MIT), pas d'abonnement natif (encore)

Le plan initial (§1) visait les **abonnements natifs Revolut** (Revolut possède le cycle de
vie → on supprime tout cron). En pratique ça exige de créer/valider des **Plans** côté Revolut
(dashboard + `plan_id`/`variation_id`), non faisable/testable de façon autonome cette session.
Le chemin **prouvé** en Phase 2 est l'**ordre** (`POST /api/1.0/orders`) + webhook. On construit
donc Phase 3 sur ce socle :

- **`/checkout`** ouvre un ordre `capture_mode:MANUAL` d'un petit montant de validation (0,50 $,
  jamais capturé, annulé au `/confirm`). Le widget **RevolutCheckout** (champ carte embarqué)
  autorise la carte et, avec `savePaymentMethodFor:"merchant"`, la **tokenise** contre un client
  Revolut → réutilisable en **MIT** (renouvellements). `metadata = {user_id, plan, period, kind}`.
- **`/confirm`** re-fetch l'ordre ; si `AUTHORISED/COMPLETED` → capture la carte sauvegardée,
  **annule le hold**, écrit la projection (`trialing` + `trial_ends_at = +7 j`). Garde-fou de
  rejeu sur `trial_consumed_at`, exactement comme Stancer.
- **Renouvellement** = un cron `norva-revolut-billing` (Phase 4) qui débite la carte sauvegardée à
  l'échéance. On **rebranchera** les abonnements natifs en Phase 6 si on veut supprimer ce cron.

Tables : `cloud_revolut_customers` (client + carte + plan/période/montant) et
`cloud_revolut_orders` (journal d'ordres, sert au `/confirm`). Migration
`20260711180000_revolut_billing.sql`.

## Activer + tester (sandbox, sur la box)

1. `git pull` sur la box, appliquer la migration `20260711180000_revolut_billing.sql`, recréer
   le conteneur `norva-edge-functions` (la nouvelle fonction `norva-revolut` est auto-dispatchée).
2. Vérifier `curl -s https://api.norva.tv/functions/v1/norva-revolut/health` →
   `{configured:true, sandbox:true, …}`.
3. Front : passer `revolut.enabled:true` dans `public/js/billing-config.js` (déjà `sandbox`), puis
   `subscribe.html` route le web vers `/checkout-revolut.html`. Payer avec une **carte test
   Revolut** (4929 4200 0000 0169, exp future, CVV quelconque). Le champ carte est embarqué.
4. Attendu : projection `revolut/…/trialing`, `trial_ends_at = +7 j`, carte sauvegardée dans
   `cloud_revolut_customers`. Les logs `[norva-revolut]` tracent tout échec API (champ inconnu →
   on ajuste, comme en Phase 2).

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

## Retrait de Stancer — effectué le 2026-07-11 (tâche #48)

Stancer **n'a jamais encaissé de vrai paiement en prod** (confirmé) → retrait
**complet** du code. Commits en 3 lots.

**Retiré** :
- Les 3 edge functions `norva-stancer`, `norva-stancer-billing`,
  `norva-stancer-webhook` (+ leurs blocs `config.toml`, l'env `STANCER_SECRET_KEY`
  dans le compose + `.env.example`).
- Le cron self-host : migration `20260711200000_retire_stancer_billing_cron.sql`
  (`cron.unschedule` gardé de tout job `norva-stancer%`).
- Front : méthodes `stancer*` de `billing.js`, bloc `stancer` de
  `billing-config.js`, pages `checkout.html` + `checkout-done.html` (Stancer-only),
  et le gating `isStancerEnabled`/`isStancerWeb` de `subscribe.html`/`subscription.html`.
- Fuites entremêlées **retargetées vers Revolut** (pas juste supprimées) :
  `norva-lifecycle` dunning-expiry (`provider='stancer'`→`'revolut'` — corrige au
  passage un past_due Revolut qui n'expirait jamais) ; `norva-admin` health-ping
  (`api.stancer.com`→`REVOLUT_API_BASE`), alerte `stancer_down`→`revolut_down`,
  cockpit `/health` (`stancer_*`→`revolut_*`) ; `AdminPage.js` cockpit go-live +
  labels de rail.

**Conservé** (intentionnel) : migrations historiques et les tables
`cloud_stancer_*` — c'est le **ledger cross-rail partagé** (colonne `provider`),
écrit par `norva-billing-webhook` (charges store) et lu par les RPC finance admin.
Renommer = migration risquée hors périmètre.

**Gaps révélés (à traiter séparément — la migration Revolut ne les avait pas
finis)** :
1. **Page de gestion web** (`subscription.html`) : rebranchée sur Revolut
   (cancel/resume/update-card/affichage carte) mais **jamais testée en direct** —
   à valider par un clic réel. La contre-offre « -50 % » (rétention) était
   Stancer-only et a été retirée (pas de backend Revolut).
2. **Relance de panier abandonné** (`norva-lifecycle runAbandoned`) : scanne le
   ledger `cloud_stancer_payments`, où le checkout Revolut **n'écrit pas** (il
   écrit `cloud_revolut_orders`) → inactive pour Revolut. À rebrancher.
3. **Remboursement admin** : la route `/admin/refund` vivait dans `norva-stancer`
   (supprimée) ; le bouton admin est désactivé. Pas de route de remboursement
   Revolut → à construire (`norva-revolut /admin/refund`).
