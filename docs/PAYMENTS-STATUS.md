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

- **Essai 7 j (Option B — empreinte minimale)** : au checkout, autorisation **0,50 €** (EUR,
  `capture:false`) sur la page hébergée → **valide + tokenise** la carte sans débiter le plan
  (l'empreinte se libère seule). Le **vrai montant** (4,99 $ / 8,99 $, USD) est prélevé **à J+7**
  puis à chaque échéance par le cron, en réutilisant le token.
- **Devise = USD pour les prélèvements**, **EUR pour l'empreinte de validation**. Diagnostic
  2026-07-03 (matrice selftest + tests manuels) : sur ce compte Stancer, **l'autorisation seule
  (`capture:false`) en USD est refusée** — la page hébergée renvoie `Card payment paym_… is not
  ready for authorization` — alors que **les captures USD passent** et que **l'autorisation EUR
  passe**. Pont adopté : empreinte 0,50 € (EUR) + débits plan en `usd`. **Action** : demander au
  support Stancer (espace client) l'activation des **autorisations USD**, puis repasser l'empreinte
  en `usd` (1 ligne dans `norva-stancer/checkout`).
- **PCI** : page de paiement **hébergée** Stancer → Norva ne voit jamais le numéro de carte (SAQ-A) ;
  3DS automatique. La page hébergée n'est **pas** brandable à 100 % (mode redirect : logo + nom du
  compte seulement) ; la réassurance « 0,50 € non débité » est donc affichée sur **notre**
  `subscribe.html` avant la redirection.

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
- **Créer paiement (hébergé)** : `POST /v2/payment_intents/` `{amount(cents), currency:"usd",
  capture:false, methods_allowed:["card"] (tableau !), return_url, order_id (≤36 car.), customer,
  metadata}` → `{ id:"pi_…", url:"https://payment.stancer.com/[test_]pi_…", status, card }`.
  ⚠️ **PAS de champ `auth`** sur les payment_intents (422 `extra fields not permitted`, confirmé via
  selftest) ; le 3DS y est implicite (`threeds:"required"` dans la réponse). `auth` n'existe que sur
  l'ancienne API `/v2/payments`.
- **Relire un paiement** : `GET /v2/payment_intents/{pi_id}` (**pluriel**).
- **Débiter un token (récurrent)** : `POST /v1/checkout/` `{amount, currency:"usd", card:"card_…",
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

> ⚠️ L'E2E ci-dessus a tourné en **EUR**. Le passage en **USD** est un simple changement de champ
> (`currency:"usd"`) sur des appels au schéma identique — à **re-confirmer** lors du test réel en
> mode test du go-live (checklist §9).

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

`public/js/billing-config.js` → `stancer.enabled` : **`true`** ✅ (le checkout web route désormais
vers Stancer ; test/live piloté **uniquement** par la clé edge `STANCER_SECRET_KEY`). Cache-buster
`billing-config.js?v=4` sur `subscribe.html` + `subscription.html`.

## 7. Crons

- `norva-stancer-billing` — jobid **82**, `23 * * * *`, **actif**. No-op tant qu'aucun essai Stancer
  n'existe (checkout désactivé). Débitera à la fin d'essai/échéance une fois le rail live.

## 8. Cartes de test Stancer

- Succès : `4000000000000077` (auto-capturé), `4242424242424242`, `5555555555554444`.
- Échecs : `4000000000000002` (do not honor), `4000000000009995` (fonds insuffisants),
  `4000000000009979` (carte volée).
- 3DS : `4000000000003220`. (Exp : n'importe quelle date future, ex. `12/30` ; CVC `123`.)

## 9. Checklist go-live

**Ordre recommandé** — on reste en **mode test** jusqu'à la bascule (étape 5) : d'abord vérifier le
cycle complet avec une carte de test, **puis** seulement passer la clé prod. Tant que la clé est
`stest_…`, un vrai visiteur web verra un checkout de test (ses vraies cartes ne passeront pas) — sans
risque financier (enforcement = `observe`, aucun paywall forcé), mais gardez la fenêtre courte.

1. ☐ *(optionnel)* Poser `STANCER_WEBHOOK_TOKEN` + URL webhook — **non bloquant**, le rail est
   auto-suffisant via `/confirm` (voir §10).
2. ✅ `billing-config.stancer.enabled = true` — **fait** (déployé au merge du front).
3. ☐ `NORVA_LIFECYCLE_BILLING_LIVE = true` (allume rappel J-2 / dunning / reçus) — secret edge, côté owner.
4. ☐ **Test réel en mode test** : `subscribe.html` → carte `4000000000000077` → retour
   `/subscription.html?stancer=done` → `/confirm` pose `trialing` ; vérifier l'auto **0,50 €**
   (empreinte EUR, voir §1) + sonde selftest `{"charge":{pi,currency:"usd"}}` = débit token **USD**
   OK, + le cycle complet.
7. ☐ **Support Stancer** : demander l'activation des **autorisations USD** (auth-only) sur le compte,
   puis repasser l'empreinte de validation en `usd` (1 ligne, `norva-stancer/checkout`).
5. ☐ Bascule prod : `STANCER_SECRET_KEY = sprod_…` + `NORVA_STANCER_MODE = live` (secrets edge, côté
   owner — **aucun redeploy front nécessaire**, le flag `enabled` est déjà `true`).
6. ☐ Sortir du mode `legacy` (essai à carte) + enforcement `enforce` (`NORVA_BILLING_MODE` /
   `NORVA_ENTITLEMENTS_MODE`, secrets edge, côté owner).

## 10. Webhook OPTIONNEL — le rail est auto-suffisant (`/confirm`)

Le rail **ne dépend pas** du webhook Stancer pour fonctionner :

- **Fin de checkout** : la page de retour `/subscription.html?stancer=done` appelle
  `norva-stancer/confirm` (user-authé) qui **re-fetch** le paiement, capture le token et pose
  l'essai `trialing` — exactement la logique validée à l'E2E, mais côté navigateur (l'utilisateur
  est présent, plus fiable qu'un webhook). Sécurité : ne confirme que le paiement dont
  `metadata.user_id` == l'utilisateur authentifié.
- **Renouvellements** : pilotés par le **cron** `norva-stancer-billing`, pas par le webhook.

Le **webhook `norva-stancer-webhook` reste un filet de sécurité optionnel** (événements async :
litiges, remboursements). À brancher plus tard si besoin (voir §6). Son emplacement de config n'est
pas dans « Développeurs » du dashboard Stancer (clés d'API only) — regarder « Mon Compte » ou
demander au support Stancer. **Non bloquant pour le lancement.**

> À valider au 1ᵉʳ vrai test checkout : le retour `?stancer=done` → `/confirm` pose bien `trialing`
> (logique identique au sim E2E, chemin user-auth standard).

## Voir aussi

- `STANCER-BILLING.md` — conception détaillée & architecture.
- `docs/audits/ONBOARDING-AUDIT-V2.md` — audit onboarding & tunnel de conversion.
