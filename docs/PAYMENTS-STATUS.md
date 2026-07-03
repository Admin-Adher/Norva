# Norva — Paiements : état & récapitulatif

> Registre **de ce qui a été fait** pour les paiements. La conception détaillée est dans
> `STANCER-BILLING.md` ; ce document dit **où on en est**, ce qui est **déployé/testé**, et la
> marche à suivre pour **passer live**.
>
> **Dernière mise à jour : 2026-07-03.**

## 0. En une phrase

Le **rail de paiement web = Stancer** est **codé, testé end-to-end en mode test, déployé en prod, et
INERT** (rien ne prélève tant que les interrupteurs ne sont pas basculés). Architecture multi-rail :
**web = Stancer**, **Android mobile/TV = Google Play Billing**, **consolidation =
`cloud_entitlement_projection`** (source de vérité unique, déjà en place).

## 1. Modèle (rappel)

Stancer **n'a pas d'objet abonnement natif** → Norva **orchestre lui-même l'essai et le récurrent**
via un **token card-on-file** :

- **Essai 7 j (Option B — empreinte minimale)** : au checkout, autorisation **0,50 €**
  (`capture:false`) sur la page hébergée → **valide + tokenise** la carte sans débiter le plan
  (l'empreinte se libère seule). Le **vrai montant** (4,99 € / 8,99 €) est prélevé **à J+7** puis à
  chaque échéance par le cron, en réutilisant le token.
- **PCI** : page de paiement **hébergée** Stancer → Norva ne voit jamais le numéro de carte (SAQ-A) ;
  3DS automatique.

## 2. Ce qui est construit & déployé

| Composant | Rôle | État |
|---|---|---|
| `supabase/functions/norva-stancer` | `/health`, `/selftest` (diag test), **`/checkout`** (user-authed → crée customer + payment_intent 0,50 € tokenisant → URL hébergée ; stocke plan/période/montant) | ✅ déployé (v11) |
| `supabase/functions/norva-stancer-webhook` | Reçoit les events → **re-fetch** du payment_intent (jamais confiance au corps) → capture le `card_…` → projection `trialing` | ✅ déployé (v1) |
| `supabase/functions/norva-stancer-billing` | **Cron** : débit du token à la fin d'essai + renouvellements ; succès → `active`, échec → `past_due` → dunning ; idempotent (`unique_id`) | ✅ déployé (v1) + **cron planifié** (jobid 82, `23 * * * *`) |
| `_shared/lifecycle-email.ts` → `renderReceipt` | Reçu de paiement envoyé par le cron sur débit capturé | ✅ |
| `public/js/billing.js` | Chemin **Stancer** (web) → `POST /checkout` → redirect page hébergée ; RevenueCat/Play intacts | ✅ déployé |
| `public/js/billing-config.js` | Bloc `stancer` (**`enabled:false`** par défaut) | ✅ |
| `public/subscribe.html` | Garde-fou billing laisse passer Stancer | ✅ |
| Migration `20260703170000_stancer_billing.sql` | Tables `cloud_stancer_customers` / `cloud_stancer_payments` + colonnes plan/période/montant + `provider='stancer'` ajouté à la liste blanche | ✅ appliquée live |

## 3. Schéma API Stancer confirmé (contre le sandbox)

- Base : `https://api.stancer.com` · Auth : **HTTP Basic**, la clé API en username (`sprod_…`/`stest_…`).
- **Créer customer** : `POST /v2/customers/` `{name,email}` → `cust_…`.
- **Créer paiement (hébergé)** : `POST /v2/payment_intents/` `{amount(cents), currency:"eur",
  capture:false, methods_allowed:["card"] (tableau !), return_url, order_id (≤36 car.), customer,
  metadata}` → `{ id:"pi_…", url:"https://payment.stancer.com/[test_]pi_…", status, card }`.
- **Relire un paiement** : `GET /v2/payment_intents/{pi_id}` (**pluriel**).
- **Débiter un token (récurrent)** : `POST /v1/checkout/` `{amount, currency:"eur", card:"card_…",
  customer:"cust_…", unique_id (≤36 car.)}` → `{status:"captured"/"to_capture", response:"00"}`.
- Statuts : `require_payment_method` → `authorized` (capture:false) → `to_capture`/`captured`.

## 4. Validation E2E (2026-07-03, mode test)

Cycle complet exécuté avec de vraies ressources Stancer de test :

1. Checkout hébergé 0,50 € `capture:false` → **`authorized`** + **carte tokenisée** `card_…`.
2. Webhook (simulé par re-fetch) → projection **`trialing`**, token stocké.
3. Fin d'essai → cron → **débit 4,99 €** (`paym_…`, `response 00`, `to_capture`) → projection
   **`active`**, `current_period_end` = **+1 mois**.
4. Échec (`4000…9995`) → `past_due` → dunning (validé par construction).

**5 bugs trouvés & corrigés grâce à l'E2E** : `order_id`/`unique_id` > 36 car. → uuid sans tirets ;
GET du webhook en **pluriel** ; `card` est une **string** ; `plan_code` contraint (plan sur la
projection, période+montant sur `cloud_stancer_customers`) ; `provider='stancer'` absent de la liste
blanche.

## 5. Base de données

- `cloud_stancer_customers` : `user_id` (PK), `stancer_customer_id`, `card_token`, `card_last4`,
  `card_exp`, `plan`, `period`, `amount_cents`. (RLS service-role.)
- `cloud_stancer_payments` : `pi_id` (PK), `user_id`, `kind` (trial_setup/first_charge/renewal),
  `amount`, `currency`, `status`, `order_id`. (Journal + idempotence.)
- `cloud_entitlement_projection` : `provider='stancer'`, `plan_code` ∈ {plus,family}, `status`,
  `current_period_end`, `trial_ends_at`, colonnes de cycle e-mail.

## 6. Secrets & config (côté owner)

Edge function secrets (Supabase → Project Settings → Edge Functions → Secrets) :
- `STANCER_SECRET_KEY` — `stest_…` (test) puis `sprod_…` (live). **Absent → tout le rail est inert.** ✅ *posé (test)*
- `STANCER_WEBHOOK_TOKEN` — filtre d'URL du webhook (chaîne aléatoire **32–48 car.**, ex.
  `openssl rand -hex 24`). ☐ à poser
- `NORVA_STANCER_MODE` — `test` | `live`. ✅ *test*
- `RESEND_API_KEY` — déjà posé (reçus/e-mails).

Dashboard Stancer → Développeurs → Webhooks : URL =
`https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-stancer-webhook?t=<STANCER_WEBHOOK_TOKEN>`.

`public/js/billing-config.js` → `stancer.enabled` : `false` (à passer `true` au go-live).

## 7. Crons

- `norva-stancer-billing` — jobid **82**, `23 * * * *`, **actif**. No-op tant qu'aucun essai Stancer
  n'existe (checkout désactivé). Débitera à la fin d'essai/échéance une fois le rail live.

## 8. Cartes de test Stancer

- Succès : `4000000000000077` (auto-capturé), `4242424242424242`, `5555555555554444`.
- Échecs : `4000000000000002` (do not honor), `4000000000009995` (fonds insuffisants),
  `4000000000009979` (carte volée).
- 3DS : `4000000000003220`. (Exp : n'importe quelle date future, ex. `12/30` ; CVC `123`.)

## 9. Checklist go-live

1. ☐ Poser `STANCER_WEBHOOK_TOKEN` + configurer l'URL webhook dans Stancer.
2. ☐ `billing-config.stancer.enabled = true` (+ redeploy front).
3. ☐ `NORVA_LIFECYCLE_BILLING_LIVE = true` (allume rappel J-2 / dunning / reçus).
4. ☐ **Test réel en mode test** : achat via `subscribe.html` → vérifier webhook + cycle complet.
5. ☐ Bascule prod : `STANCER_SECRET_KEY = sprod_…` + `NORVA_STANCER_MODE = live`.
6. ☐ Sortir du mode `legacy` (essai à carte) + enforcement `enforce`.

## 10. À vérifier au 1ᵉʳ webhook réel

Le **format exact du payload** envoyé par Stancer n'a pas encore été observé (à l'E2E, le webhook a
été simulé par re-fetch direct). Le webhook extrait un id `pi_…`. **Si Stancer envoie un `paym_…`**
(l'id du paiement plutôt que du payment_intent), c'est un ajustement de ~2 lignes dans
`norva-stancer-webhook` (`extractPaymentIntentId` + un re-fetch `paym`). À valider dès le premier
webhook réel.

## Voir aussi

- `STANCER-BILLING.md` — conception détaillée & architecture.
- `docs/audits/ONBOARDING-AUDIT-V2.md` — audit onboarding & tunnel de conversion.
