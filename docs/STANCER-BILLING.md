# Norva × Stancer — rail de paiement web (design & intégration)

> ⛔ **RETIRÉ (2026-07-11).** Stancer n'a **jamais encaissé de vrai paiement en
> prod** et a été **remplacé par Revolut** (voir `BILLING-REVOLUT-MIGRATION.md`).
> Tout le code Stancer (functions, cron, front, config) a été supprimé ; les
> tables historiques `cloud_stancer_*` sont conservées (inertes). Ce document
> reste comme archive de conception.

> Rail de paiement **web** (navigateur) via **Stancer** (prestataire français, CB/SEPA, conforme UE,
> **0 taxe store**). Complète l'architecture multi-rail : **web = Stancer**, **Android mobile/TV =
> Google Play Billing**, **consolidation = `cloud_entitlement_projection`** (source de vérité unique,
> déjà en place). Ce document est la conception ; l'implémentation se fait **inerte d'abord** (comme
> les rails RevenueCat/Gumroad du repo) et ne prélève rien tant que les clés + le flag ne sont pas
> posés et testés.
>
> **Date : 2026-07-03.** Ancré dans l'API Stancer réelle (voir §2).

## 1. Décision structurante : Stancer ne gère PAS les abonnements

Contrairement à Stripe Billing, **Stancer n'a pas d'objet « subscription/plan/trial »**. Il fournit :
- des **paiements** (`payment_intents`) avec **page de paiement hébergée** (PCI : on ne voit jamais
  le PAN ; 3DS automatique) ;
- le **card-on-file** : le 1ᵉʳ paiement (marqué `tokenize`) renvoie un **token de carte** réutilisable
  pour les paiements suivants.

**Conséquence** : Norva **orchestre lui-même le récurrent et l'essai** :
1. À l'inscription à l'essai → on collecte la carte (page hébergée) + on crée un **token**, on stampe
   l'entitlement `trialing` (`trial_ends_at = now + 7 j`, `provider='stancer'`).
2. Un **cron** prélève le token **à la fin de l'essai** (1ᵉʳ débit) puis **à chaque échéance** (mensuel/annuel).
3. Le **webhook** confirme succès/échec de façon asynchrone et met à jour la projection.
4. Échec → **dunning** (déjà construit) ; carte expirée → relance de mise à jour (limite connue de Stancer).

## 2. API Stancer (faits confirmés)

- **Base URL** : `https://api.stancer.com`. **Auth** : HTTP Basic, la **clé API en username** (pas de
  mot de passe). Clés `sprod_xxx` (live) / `stest_xxx` (test).
- **Créer un paiement** : `POST /v2/payment_intents/` — champs `amount` (centimes), `currency`
  (`usd` — Stancer accepte USD, settlement EUR côté banque), `customer` (`cust_xxx`, optionnel),
  `capture`, `methods_allowed` (`"card"`/`"sepa"`),
  `return_url`. Réponse : `id` (`pi_xxx`) + **`url`** = page hébergée
  `https://payment.stancer.com/payment_intents/pi_xxx`.
- **Relire un paiement** : `GET /v2/payment_intent/<pi_id>` → `status`.
- **Client** : `POST /v2/customers/` (`name`, `email`) → `cust_xxx`.
- **Statuts** : `authorized`, `to_capture`, `captured`, `disputed`, `failed`, `refused`, `expired`.
- **Récurrent** : 1ᵉʳ paiement avec `tokenize` → **card token** ; les débits suivants réutilisent le
  token (paiement API sans redirection).

> ✅ **Schéma v2 CONFIRMÉ contre le sandbox test (2026-07-03, via `norva-stancer/selftest`)** :
> - `POST /v2/customers/` `{name,email}` → `{ id: "cust_…" }`.
> - `POST /v2/payment_intents/` `{ amount:<cents>, currency:"usd", capture, methods_allowed:["card"]
>   (⚠️ un tableau, pas une string), return_url, order_id, customer, metadata, description }` →
>   `{ id:"pi_…", url:"https://payment.stancer.com/[test_]pi_…" (page hébergée autonome, pas de clé
>   publique requise), status:"require_payment_method", card:null (renseigné après paiement),
>   threeds:"required" }`.
> - **Essai sans débit immédiat** : `capture:false` (autorisation) → valide + tokenise la carte sans
>   débiter. Le débit réel (fin d'essai + renouvellements) se fait dans le cron `norva-stancer-billing`
>   en réutilisant le `card` (`card_…`) renseigné sur le payment_intent après paiement. *(À valider en
>   slice B : récupération du `card_…` + requête de débit du token.)*

> ⚠️ **Vérification des webhooks** : le schéma de signature n'est pas publiquement documenté sur les
> pages concept. **Design retenu, robuste quel que soit le schéma** : à réception d'un webhook, on
> **NE fait PAS confiance au corps** — on **re-fetch le `payment_intent` par son ID** via l'API
> Stancer (Basic auth avec notre clé secrète) et on agit sur le **statut faisant autorité** renvoyé
> par l'API. Optionnellement, un **token secret dans l'URL** du webhook (`?t=<secret>`) filtre le
> bruit avant le re-fetch. À confirmer avec le Swagger Stancer (`docs.stancer.com/swagger.html`) si
> un header de signature existe → on l'ajoutera en défense supplémentaire.

## 3. Flux cible (essai 7 j → paiement auto)

```
Subscribe (web) ──POST /norva-stancer/checkout──▶ crée customer + payment_intent(tokenize, return_url)
      │                                            ├─ enregistre (user ↔ cust ↔ pi) inertement
      ▼                                            └─ renvoie url hébergée
Redirect vers payment.stancer.com  ──(carte + 3DS)──▶  retour return_url = /subscription.html?stancer=done
      │
      ▼
Webhook Stancer ──▶ norva-stancer-webhook ──(re-fetch pi)──▶ status authoritatif
      │                                                       ├─ authorized/captured (essai) → projection status='trialing'
      │                                                          + trial_ends_at = now+7j, provider='stancer', card token stocké
      ▼
Cron norva-stancer-billing (échéances) :
   • trial_ends_at atteint → débit du token (montant du plan) → captured → status='active', current_period_end=+1 période
   • current_period_end atteint → débit du token (renouvellement)
   • échec → status='past_due' → dunning (norva-lifecycle) ; 3 échecs → 'expired'
```

**Rappel J-2** : déjà construit (`norva-lifecycle`, gaté). Activé par `NORVA_LIFECYCLE_BILLING_LIVE=true`
une fois ce rail live → l'e-mail « on te prélève dans 2 jours » devient vrai.

## 4. Modèle de données

Réutilise `cloud_entitlement_projection` (source de vérité). Ajouts (slice checkout) :
- Table `cloud_stancer_customers` : `user_id` (uuid, PK), `stancer_customer_id` (`cust_xxx`),
  `card_token`, `card_last4`, `card_exp`, `created_at` — mapping + token pour le récurrent.
- Table `cloud_stancer_payments` : `pi_id` (PK), `user_id`, `kind` (`trial_setup`/`first_charge`/`renewal`),
  `amount`, `status`, `created_at` — journal + idempotence.
- Sur la projection : `provider='stancer'`, `provider_customer_id=cust_xxx`, `current_period_end`,
  `plan_code`, `status`. Colonnes de cycle e-mail déjà ajoutées (migration `20260703160000`).

## 5. Fonctions & fichiers (implémentation)

| Composant | Rôle | État prévu |
|---|---|---|
| `norva-stancer-webhook` (edge) | Reçoit les events, **re-fetch** le pi, mappe → projection | **Scaffold inerte livré** |
| `public/js/billing-config.js` | Bloc `stancer` (désactivé par défaut) | **Livré (inerte)** |
| `norva-stancer/checkout` (edge) | Crée customer + payment_intent(capture:false → tokenise), renvoie l'url hébergée | **Livré (slice A)** |
| `norva-stancer-billing` (cron) | Prélève le token à la fin d'essai + aux échéances ; échec → past_due | **Livré (slice B)** |
| `norva-stancer-webhook` | Re-fetch + capture du `card_…` + statut → projection (plan/essai posés) | **Livré** |
| Migration `cloud_stancer_*` | Mapping + journal | **Livré (slice A)**, appliquée live |
| `subscribe.html` / `billing.js` | Route web → `checkout` → redirect page hébergée | **Livré (slice C)** |
| `renderReceipt` → cron | Reçu de paiement sur débit capturé | **Livré (slice C)** (dans `norva-stancer-billing`) |

> ✅ **Débit du token CONFIRMÉ en test (2026-07-03)** : `POST /v1/checkout/`
> `{ amount, currency:"usd", card:"card_…", customer:"cust_…", unique_id }` → `status:"captured"`,
> `response:"00"`. `unique_id = "<user_id>:<cycle>"` rend le débit **idempotent** (aucun double-débit
> si le cron rejoue). Cartes de test : `4000000000000077` (auto-capturé), `4000000000009995`
> (fonds insuffisants), `4000000000000002` (refus). Reste à valider en E2E (slice C) : le parcours
> hébergé `capture:false` → apparition du `card_…` sur le payment_intent → débit par le cron.

## 6. Secrets & configuration (côté owner)

Edge function secrets (Supabase → Project Settings → Edge Functions) :
- `STANCER_SECRET_KEY` = clé `sprod_...` (live) ou `stest_...` (test). **Absente → tout le rail est
  inerte** (webhook renvoie « not configured », checkout refuse).
- `STANCER_WEBHOOK_TOKEN` (optionnel) = secret pour le filtre d'URL du webhook.
- `NORVA_STANCER_MODE` = `test` | `live` (défaut `test`).

Dashboard Stancer :
- Configurer l'URL de webhook : `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-stancer-webhook?t=<STANCER_WEBHOOK_TOKEN>`.
- Récupérer les clés test/live (Developers).

`public/js/billing-config.js` → bloc `stancer` : `enabled:false` par défaut ; passer `true` +
renseigner les libellés/prix quand le checkout est live.

## 7. Conformité (UE / DGCCRF / PCI)

- **PCI** : page de paiement **hébergée** Stancer → Norva ne manipule jamais le PAN (SAQ-A).
- **SCA/3DS** : automatique sur la page hébergée.
- **Essai → reconduction** : consentement explicite à l'essai payant + **prix TTC affiché** + rappel
  **J-2** (obligation stores, attendu UE) + **annulation facile** (portail à brancher) — cf. CGU
  (droit de rétractation déjà traité) + médiateur CM2C.
- **Franchise TVA** (art. 293 B) : montants sans TVA, mention déjà dans les mentions légales.

## 8. Séquence de mise en service

1. **[inerte, livré]** webhook + config Stancer scaffoldés (rien ne prélève).
2. Poser `STANCER_SECRET_KEY` **de test** (`stest_...`).
3. **[slices suivantes]** checkout + migration mapping + cron de prélèvement + câblage web.
4. Tester un cycle complet en **test** (carte de test Stancer) : essai → J-2 → débit → renouvellement → échec/dunning.
5. Basculer `STANCER_SECRET_KEY` en **live**, `NORVA_STANCER_MODE=live`, `billing-config.stancer.enabled=true`.
6. Sortir du mode `legacy` (essai à carte), `NORVA_LIFECYCLE_BILLING_LIVE=true`, enforcement `enforce`.
7. Brancher `renderReceipt` + le portail d'annulation web (`webCustomerPortalUrl`).

## 9. Risques & garde-fous

- **Idempotence** : `cloud_stancer_payments.pi_id` PK → un event rejoué ne double pas un débit ni une
  mutation. Le cron marque `charge_in_flight` avant de débiter.
- **Vérité = re-fetch** : jamais muter la projection sur le seul corps du webhook.
- **Carte expirée** (limite Stancer) : détecter `refused`/échec → dunning + e-mail « mets à jour ta carte ».
- **Double rail** : un user peut avoir Play (mobile) ET Stancer (web) — la projection reste **une**
  ligne ; règle : le dernier event faisant autorité gagne, on n'ouvre jamais deux abonnements payants
  (garde `provider` + `provider_customer_id`).
