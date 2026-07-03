# Norva — Paiements : état & récapitulatif

> Registre **de ce qui a été fait** pour les paiements. La conception détaillée est dans
> `STANCER-BILLING.md` ; ce document dit **où on en est**, ce qui est **déployé/testé**, et la
> marche à suivre pour **passer live**.
>
> **Dernière mise à jour : 2026-07-03 (soir — go-live test + validation navigateur réelle).**

## 0. En une phrase

Le **rail de paiement web = Stancer** est **codé, validé de bout en bout dans un vrai navigateur en
mode test, activé et déployé en prod** — et **INERT côté argent** (clé `stest_`, aucun prélèvement
réel tant que la clé prod + les interrupteurs ne sont pas basculés). Architecture multi-rail :
**web = Stancer**, **Android mobile/TV = Google Play Billing**, **consolidation =
`cloud_entitlement_projection`** (source de vérité unique, déjà en place).

> **Validation réelle 2026-07-03** : parcours complet exécuté depuis le navigateur — `subscribe.html`
> → page hébergée Stancer (empreinte **0,50 € EUR**) → carte `4000…0077` → retour `/confirm` →
> **essai `trialing` posé en base** (`provider=stancer, plan_code=plus, trial_ends_at=+7j,
> card_token stocké`) ; débit récurrent **USD** re-vérifié via sonde (`/v1/checkout` → `response 00`,
> `to_capture`). Voir le journal détaillé au **§11**.

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

> ✅ **Validé le 2026-07-03** au 1ᵉʳ vrai test navigateur : le retour `?stancer=done` → `/confirm`
> pose bien `trialing` (voir §11).

## 11. Journal go-live & validation navigateur (2026-07-03)

Chronologie de la mise en service et **de chaque bug trouvé au test réel + sa correction**. Chaque
ligne = une PR mergée sur `main` (déploie front + edge). À conserver comme mémoire du lot.

### 11.1 Demandes traitées (lot « checkout & go-live »)
- **Page légale → anglais** (`mentions-legales.html`) — Norva est full english. PR #81.
- **Réassurance checkout** — encart « No charge today… 0,50 € released… never debited », affiché
  uniquement sur le chemin **web Stancer** (le Play Billing natif n'a pas d'empreinte). PR #81, ajusté €.
- **Devise USD** pour les prélèvements + symbole `$` sur tous les prix (subscribe/landing/index),
  reçu en `$`, défaut de colonne `cloud_stancer_payments.currency='usd'` (migr. `20260703180000`). PR #81.
- **Activation** `billing-config.stancer.enabled=true` (+ cache-busters). PR #81.
- **Page hébergée Stancer** : **pas** brandable à 100 % en mode redirect (logo + nom du compte).

### 11.2 Bugs trouvés au test navigateur réel & corrections
1. **`Failed to fetch` au clic « Subscribe »** → CORS. `billing.js` envoie l'en-tête `apikey`, mais
   `norva-stancer` n'autorisait que `authorization, content-type`. Le preflight était rejeté avant
   d'atteindre la fonction. **Fix** : `Access-Control-Allow-Headers: authorization, x-client-info,
   apikey, content-type` (aligné sur norva-cloud/playback/catalog). PR #82. *(L'E2E côté serveur ne
   déclenche jamais de preflight → jamais vu avant.)*
2. **`Card payment paym_… is not ready for authorization`** sur la page Stancer (le formulaire carte
   ne s'affiche pas). Fausse piste : `auth:true` → **422 `extra fields not permitted`** sur
   `/v2/payment_intents/` (`auth` n'existe que sur l'ancienne API `/v2/payments`). Ce champ cassait
   la création du paiement (« Could not start checkout »). **Reverté**. PR #83 (tentative) → #84 (revert).
3. **Vraie cause du #2 = la devise.** Matrice de test (`/selftest {cases:[…]}` + tests hébergés
   manuels A/B) : **EUR `capture:false` OK**, **USD `capture:true` OK**, **USD `capture:false` →
   « not ready for authorization »**. ⇒ **l'autorisation seule (`capture:false`) en USD n'est pas
   activée sur le compte Stancer** ; les captures USD marchent. **Pont** : empreinte de validation
   **0,50 € EUR** (`capture:false`) + prélèvements plan **USD**. Débit token USD re-vérifié via sonde
   `/selftest {charge:{pi,currency:"usd"}}` → `response 00`, `to_capture`. PR #85. **Action owner** :
   demander au support Stancer l'activation des **autorisations USD**, puis repasser l'empreinte en
   `usd` (1 ligne dans `norva-stancer/checkout`).
4. **Settings → « Norva Access » figé sur « Full access »** (n'affichait pas l'état réel). Le
   `decision` porte pourtant le vrai `status`/`plan_code`/`projection` même en mode `observe`. **Fix** :
   `accessLabel`/`accessHint` affichent Trial / Active / Ending soon / Payment due / Payment retrying /
   Plan expired + dates ; « Full access » gardé seulement s'il n'y a **pas** d'abonnement réel. PR #86.
5. **`subscription.html` (retour) affichait le message générique** « Paid plans aren't switched on »
   malgré l'essai réel. Court-circuit observe-mode déplacé **après** la vérif d'un abonnement réel.
   PR #87.
6. **« Back to Norva » renvoyait dans l'app-home (perçu « norva.tv ») au lieu de Settings**, +
   **`Settings.js` chargé en `?v=12` par le vrai fichier app servi**. Découverte : `/app` sert
   `public/app/index.html` (et `/app.html` **308-redirige** vers `/app`) — donc le bump précédent sur
   `app.html` ne touchait pas les users. **Fix** : (a) `returnTo` **propagé** subscribe.html →
   `billing.js` → edge `/checkout` (validé same-site, anti open-redirect) → `return_url` → page de
   retour → bouton « Back » revient à l'origine (Settings) ; (b) cache-buster `Settings.js` bumpé sur
   **`app/index.html` (v12→v31)** — le fichier réellement servi ; billing.js v3→v4. PR #88.

### 11.3 Preuve de bout en bout (en base, mode test)
`cloud_entitlement_projection` pour le compte de test après le vrai checkout :
`status=trialing · provider=stancer · plan_code=plus · trial_ends_at=2026-07-10 · card_token=card_…adM7 ·
plan=plus · period=monthly · amount_cents=499`. Sonde débit : `POST /v1/checkout {currency:"usd",
amount:100}` → `response 00`, `status to_capture`, `fee 16`.

### 11.4 Peaufinages livrés dans la foulée
- **`card_last4` enrichi** (PR #89) : `/confirm` va chercher l'objet carte (`GET /v1/cards/{id}`) si
  le PI renvoie un token brut → stocke `card_last4` + `card_exp` ; nouvelle route user-authed
  `GET /profile` ; `subscription.html` affiche « Payment method — •••• 0077 · exp 12/30 » (rail web
  Stancer uniquement). Ligne d'essai existante backfillée en live.
- **Checkout premium embarqué (chantier « iframe », PR #90)** : le checkout web ne quitte plus
  norva.tv. `checkout.html` (brandé Norva : récap plan/prix, features, réassurance 0,50 €) embarque
  le **formulaire carte Stancer en iframe** (CSP Stancer vérifiée : `frame-ancestors 'self' https:`
  → framing autorisé ; PCI reste SAQ-A, les champs carte restent chez Stancer). Retour de paiement →
  page pont `checkout-done.html` (même origine) → `postMessage` au parent → `/confirm` → écran de
  succès Norva inline (fallback : ouverte top-level, la page pont renvoie vers
  `subscription.html?stancer=done`). Edge `/checkout` accepte `embed:true` (return_url → pont) ;
  `billing.js` : le chemin web Stancer navigue vers `checkout.html`, + `stancerCheckoutUrl()`
  (embed) ; lien secours « ouvrir la page de paiement dans un onglet ».

### 11.5 Lot P0 post-audit V3 (gestion post-paiement) — livré

Les 4 P0 de l'audit V3 (`docs/audits/ONBOARDING-AUDIT-V3.md` §E.2) :

1. **Annulation self-serve (P0-1)** : `POST /cancel` (trialing → `cancelled_at_period_end` avec
   `current_period_end = trial_ends_at` ; active → `cancelled_at_period_end` ; past_due/grace →
   `expired`) + `POST /resume` (annulation en attente → retour trialing/actif). Le cron ne débite
   que trialing/active → un abonné annulé n'est **jamais** débité. Sweep cron :
   `cancelled_at_period_end` échu → `expired` (le win-back peut se déclencher). UI
   `subscription.html` : boutons **Cancel plan** (confirm), **Resume plan** (API), rail web Stancer.
2. **Guard anti re-trial (P0-2)** : le **kind** du checkout est décidé **côté serveur** dans
   `/checkout` à partir de l'état réel du compte et figé dans `metadata.kind` du PI :
   `trial_setup` (essai jamais consommé — **seul** chemin qui accorde des jours d'essai) ·
   `plan_change` (essai consommé + entitlement vivant → swap plan/token, statut & dates
   préservés, nouveau montant au cycle suivant) · `resubscribe` (essai consommé + rien de vivant →
   `active` immédiat, 1ᵉʳ débit ramassé par le cron : `current_period_end = now`) ·
   `card_update`. `/confirm` honore le kind ; **garde anti-replay** : re-confirmer un vieux PI
   trial_setup ne re-crédite jamais 7 jours (`trial_consumed_at` vérifié).
3. **MAJ de carte (P0-3)** : `intent=update_card` → re-checkout étiqueté (empreinte 0,50 €,
   token remplacé, **statut/périodes intouchés** ; mapping plan/période préservé). Cas `past_due` :
   après le swap, retour `active` avec période due **maintenant** → le cron retente le débit sous
   l'heure sur la nouvelle carte (la boucle dunning est fermée). Boutons « Update payment
   method » (primaire sur Payment issue, secondaire sur trialing/active). `checkout.html` adapte
   toute sa copy au kind (Update / Change plan / Reactivate / Trial).
4. **E-mails legacy déprogrammés (P0-4)** : migration `20260703200000` (appliquée live) — triggers
   bienvenue-on-confirm, cron J-3 `norva-trial-ending`, trigger past_due, trigger status-change
   **supprimés** ; les triggers **sécurité** (mdp/e-mail/nouvel appareil) et
   `norva_send_branded_email` conservés. Un seul système : `norva-lifecycle`.

### 11.5bis Upsell sans friction — changement de plan en 1 clic (sans carte)

`POST /change-plan` (user-authé) : un abonné existant change de plan **sans re-saisir sa carte**
(le token est déjà en base). Sémantique protectrice du revenu : **upgrade** (prix ≥ actuel) →
appliqué **immédiatement** (limites débloquées), nouveau prix au prochain cycle, rien débité
aujourd'hui ; **downgrade** → **programmé au prochain cycle** (mapping mis à jour, `plan_code`
synchronisé par le cron au moment du débit — l'abonné garde ce qu'il a payé). Même plan → `unchanged`.
Fallback automatique vers le checkout (`no_live_sub` / `requires_card`). Câblage : `billing.js`
`stancerChangePlan` + court-circuit dans `stancerCheckout` ; `subscribe.html` affiche « Plan
updated » / « Plan change scheduled » / « You're already on this plan ». Le kind `plan_change` du
checkout (11.5-2) reste le fallback avec carte.

### 11.5ter Lot P1 post-audit (conversion & rétention) — livré (hors Play Store)

1. **Relance abandon checkout** : `norva-lifecycle/runAbandoned` (gated `NORVA_LIFECYCLE_BILLING_LIVE`)
   — un e-mail + push unique, 2–48 h après un checkout ouvert non complété (`require_payment_method`),
   deep-link retour dans `checkout.html` avec le plan choisi ; skip + stamp si complété ailleurs.
   Colonne `cloud_stancer_payments.reminder_sent_at` + index partiel (migr. `20260703210000`,
   appliquée live). Template `renderAbandonedCheckout`.
2. **Deep-links landing** : les CTA des cartes de prix portent **plan + période** (suivent le toggle
   annuel) → `/account.html?returnTo=/subscribe.html?plan=…&period=…` ; `subscribe.html` lit les
   params : période appliquée, carte choisie surlignée (`.preselected`). L'intention prix n'est plus
   perdue à l'inscription.
3. **Push billing (FCM)** : `pushUser` dans `norva-lifecycle` (infra `_shared/fcm.ts` +
   `cloud_push_tokens`, purge des tokens morts) — rappel J-2, échec de paiement (dunning), win-back
   et relance abandon partent désormais **e-mail + push**.
4. **`past_due` → `expired`** : `runExpirePastDue` — dunning épuisé (palier 3 + 7 j) ou bloqué 21 j →
   `expired` (provider stancer uniquement ; RevenueCat reste piloté par le webhook store). Le
   win-back peut enfin se déclencher.
5. **`paywall.html`** : l'état refusé propose **« See plans »** (→ picker) au lieu de « Manage
   account ».
6. **Bandeaux in-app sur le statut réel** : compte à rebours d'essai et incident de paiement
   s'affichent dès que le statut réel est `trialing`/`past_due` — plus besoin d'`enforce`.

*Restent P1 côté owner : activer OAuth (config Supabase), témoignages réels, support Stancer
(autorisations USD), et la **publication Play Store** (volontairement différée — « il faut qu'on
soit parfait »).*

### 11.6 Deux fichiers d'app en parallèle (dette repérée)
`public/app.html` **et** `public/app/index.html` coexistent ; **seul `app/index.html` est servi**
(`/app.html` → 308 → `/app`). Leurs numéros de version de scripts ont divergé (ex. `Settings.js`
était en v30 sur `app.html` mais v12 sur `app/index.html`). **À rationaliser** un jour (supprimer le
doublon ou générer l'un depuis l'autre) pour éviter de bumper le mauvais fichier.

## Voir aussi

- `STANCER-BILLING.md` — conception détaillée & architecture.
- `docs/audits/ONBOARDING-AUDIT-V2.md` — audit onboarding & tunnel de conversion.
