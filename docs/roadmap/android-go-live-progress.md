# Norva — Mise en prod Android (Google login + paiements) — Journal de progression

> **But de ce fichier** : la **trace vivante** de la mise en production des 2 apps
> Android (`tv.norva.phone`, `tv.norva.tv`) pour la **connexion Google** et les
> **paiements natifs (RevenueCat / Play Billing)**. On note ici, dans l'ordre, ce
> qui est **fait / en attente / à faire**, avec les identifiants utiles.
>
> **Aucun secret n'est écrit ici** (clés `goog_…`, secret webhook, clé privée du
> Service Account) : ils vivent uniquement dans les secrets GitHub Actions, dans
> `.env` sur la box, ou dans RevenueCat.
>
> - **Procédure détaillée** (runbook pas-à-pas) → [`play-console-setup.md`](./play-console-setup.md)
> - **RevenueCat / produits / webhook** → [`billing-setup.md`](./billing-setup.md) §3-4, §6-7
> - **Bascule des flags** → [`billing-status.md`](./billing-status.md)
>
> ⚠️ **Note d'obsolescence** : `billing-status.md` et `billing-setup.md` gardent
> des couches historiques (Stripe → Gumroad → …). Le **rail web actuel est
> Revolut** (voir `docs/BILLING-REVOLUT-MIGRATION.md`), et le **rail mobile est
> RevenueCat / Play Billing**. Les deux écrivent dans la **même**
> `cloud_entitlement_projection` (agnostique de la source).
>
> _Créé : 2026-07-12._

---

## Architecture (rappel court)

- **Apps Android = coquilles WebView** chargeant `https://norva.tv/app.html`
  (phone) / `norva.tv/cloud-pair.html` (TV), avec des ponts natifs.
- **Connexion Google (phone)** = **native** (Credential Manager
  `GetSignInWithGoogleOption`) → `id_token` envoyé à
  `https://api.norva.tv/auth/v1/token`. On **n'utilise pas** le login Google dans
  la WebView (bloqué par Google : `disallowed_useragent`).
- **Connexion Google (TV)** = **inexistante par design** (appairage d'appareil via
  la page web ; les boutons sociaux sont masqués sur la coquille TV).
- **Paiements (les 2 apps)** = **natifs** via `NorvaBilling.java` + SDK RevenueCat
  `com.revenuecat.purchases:purchases:8.25.0`. `billing.js` choisit
  `hasNativeBilling() → callNative` **en premier** sur Android (conforme aux
  règles Play — **jamais Revolut sur Android**). L'App User ID RevenueCat = l'id
  utilisateur Supabase (via `billingLogin`).
- **Backend** = Supabase OSS auto-hébergé sur `https://api.norva.tv`. Le webhook
  RevenueCat écrit dans `cloud_entitlement_projection`
  (`provider = google_play | apple_app_store | revolut | system | manual`).

---

## Les 9 points — tableau d'avancement (2026-07-12)

| # | Point | État |
|---|---|---|
| 1 | RevenueCat : projet + 2 apps Play + 2 clés SDK `goog_…` → secrets CI | ✅ **Fait** |
| 2 | RevenueCat : webhook → backend + `NORVA_REVENUECAT_WEBHOOK_AUTH` (test 200) | ✅ **Fait** |
| 3 | Play Console (phone) : abonnements `norva_plus` + `norva_family` (base plans + offre essai 7 j) | ✅ **Fait (phone)** |
| 4 | Service Account Play → RevenueCat (JSON + droits Play + API activée) | 🟡 **En attente de propagation Google (24-36 h)** |
| 5 | RevenueCat : entitlement `pro` + offering `default` + 4 packages + import produits | ⏳ **En cours** |
| 6 | RTDN (Real-time Developer Notifications) → topic Pub/Sub | ⏳ à faire (dépend du #4 vert) |
| 7 | App TV : créer dans Play Console + upload AAB + répliquer produits + même JSON SA | ⏳ à faire |
| 8 | Testeurs de licence + **achat sandbox** (phone + TV) → projection `provider=google_play` | ⏳ à faire |
| 9 | Connexion Google (phone) : provider GoTrue + client OAuth Android + test device + redirect web | ⏳ à faire |

**Bloqueurs transverses**
- ⚠️ **D-U-N-S / suppression du compte Play le 9 août 2026** (bandeau rouge).
  Faux positif probable (D-U-N-S `268494859`, org *Hernandez*, adresse *270 rue de
  Vaugirard 75015 Paris* — tout **correspond** entre D&B et Play). **Appel déposé.**
  **À résoudre avant le 9 août** sous peine de suppression du profil + apps. Non
  bloquant pour la config en parallèle, mais **bloquant pour la prod finale**.

---

## Détail par domaine

### RevenueCat

| Élément | Valeur / état |
|---|---|
| Projet | `Norva` |
| App phone | **Norva Phone** créée ✅ |
| App TV | **Norva TV** créée ✅ |
| Clés SDK publiques Android (`goog_…`) | 2 obtenues ✅ → posées en secrets CI `REVENUECAT_API_KEY_PHONE` / `REVENUECAT_API_KEY_TV` |
| Webhook | URL `https://api.norva.tv/functions/v1/norva-billing-webhook` ; header `Authorization` = secret long → recopié dans `.env` box (`NORVA_REVENUECAT_WEBHOOK_AUTH`). **Test webhook → 200** ✅ |
| Service Account (app Norva Phone) | JSON uploadé ✅ ; **validation « Credentials need attention »** = attente de propagation Google (pas d'erreur de config) |
| Entitlement `pro` | ⏳ en cours de création |
| Offering `default` + 4 packages | ⏳ à faire |
| Import produits (depuis Play) | ⏳ à faire (nécessite #4 vert) |

**Structure catalogue cible** (à créer aux #5) :
- **Entitlement** unique : `pro` (c'est ce que lit le backend pour donner l'accès).
- **Offering** `default`, 4 packages (IDs = ce que lit l'app) :
  - `$rc_monthly` → `norva_plus:monthly`
  - `$rc_annual` → `norva_plus:annual`
  - `family_monthly` → `norva_family:monthly`
  - `family_annual` → `norva_family:annual`
- Les 4 produits attachés à l'entitlement `pro` (c'est le **produit** qui décide du
  tier / nb de streams, pas l'entitlement).

### Google Cloud

| Élément | Valeur |
|---|---|
| Projet GCP | `norva-ecosystem` |
| Service Account | `revenuecat-play@norva-ecosystem.iam.gserviceaccount.com` |
| API « Google Play Android Developer API » | ✅ **Activée** (`androidpublisher.googleapis.com`) |
| Clé JSON active dans RevenueCat | Private Key ID commence par `608dbda74e…` (1er fichier). Un 2ᵉ fichier `165d76b38719` a été ré-uploadé mais **non enregistré** — **sans importance** (même compte de service). **Ne pas recréer d'autres clés.** |

> **Diagnostic du « Credentials need attention »** : le « View details » RevenueCat
> montre `Project ID = norva-ecosystem` + `Client Email = revenuecat-play@…` →
> **credentials corrects**. L'avertissement **sans message d'erreur** = l'appel de
> test RevenueCat reçoit un « droits pas encore actifs » côté Google. **C'est la
> propagation** (Google met jusqu'à **24-36 h** après l'invitation d'un SA). Ça
> passera **vert tout seul**. Rien à corriger.

### Play Console

| Élément | État |
|---|---|
| Compte developer | ✅ obtenu (2026-07-03) |
| App phone `tv.norva.phone` | ✅ créée, **test interne** en place |
| App TV `tv.norva.tv` | ⏳ **rien fait encore** (à créer au #7) |
| Abonnements (phone) | ✅ `norva_plus` (mensuel 4,99 / annuel 41,99) + `norva_family` (mensuel 8,99 / annuel 75,99), base plans `monthly` (P1M) / `annual` (P1Y), **offre essai 7 j** (P7D, *new customers*) |
| Abonnements (TV) | ⏳ à répliquer au #7 |
| Droits Service Account (Users & permissions) | ✅ invité + « Afficher les données financières… » + « Gérer les commandes et les abonnements » **enregistrés** |
| D-U-N-S / suppression 9 août | ⚠️ **appel en cours** (voir bloqueurs) |

### Code des apps Android (déjà en repo, audité — RAS)

- Login Google **natif** (phone) via Credential Manager → `api.norva.tv/auth/v1/token`.
- Billing **natif** via `NorvaBilling.java` + RevenueCat SDK **8.25.0** (épinglé).
- `app/build.gradle` (phone `:27`, TV `:24`) lit
  `project.findProperty('REVENUECAT_API_KEY')` → clé vide = **billing inerte**
  (l'app compile et tourne sans clé).
- `.github/workflows/android-release.yml` injecte les clés via
  `ORG_GRADLE_PROJECT_REVENUECAT_API_KEY` (phone ← `REVENUECAT_API_KEY_PHONE`,
  TV ← `REVENUECAT_API_KEY_TV`).
- Aucune référence au projet Supabase managé (décommissionné) dans le code natif.

### Backend (box `api.norva.tv`)

- `norva-billing-webhook` : `verify_jwt=false`, `verifyAuth` compare en temps
  constant à `NORVA_REVENUECAT_WEBHOOK_AUTH`, mappe `PLAY_STORE → google_play`,
  `APP_STORE → apple_app_store`. **Vérifié : événement test → 200.**
- `cloud_entitlement_projection` agnostique de la source → l'accès reste unifié par
  compte (web Revolut + mobile Play convergent).

---

## Point #9 — connexion Google (à faire, résumé)

1. **Vérifier le provider Google de GoTrue sur la box** : accepte-t-il l'audience
   du client Android (`973428500788-deum…apps.googleusercontent.com`) ? GoTrue doit
   accepter l'`id_token` émis côté natif.
2. **Créer un client OAuth Android** dans Google Cloud pour `tv.norva.phone` +
   l'empreinte **SHA-256 de la clé de signature Play** (celle générée par Google,
   pas l'upload).
3. **Tester « Continue with Google »** sur un device réel (le flux natif).
4. **Repointer le client OAuth WEB** : redirect → `https://api.norva.tv/auth/v1/callback`
   (déjà corrigé dans `docs/GOOGLE-LOGIN-SETUP.md`).

---

## Prochaines actions (immédiat)

1. **#5 RevenueCat — Product catalog** :
   - Créer l'**entitlement** `pro` (Identifier `pro`, minuscules).
   - Créer l'**offering** `default`.
   - Ajouter les **4 packages** (mapping ci-dessus).
2. **#4** : laisser Google propager (24-36 h), **ne pas recréer de clé** ; revérifier
   le vert dans RevenueCat avant le test d'achat (#8).
3. **#6 RTDN** dès que #4 est vert (bouton « Connect to Google » dans RevenueCat crée
   le topic).
4. **#7** : créer l'app TV, uploader l'AAB, répliquer les abonnements, ré-uploader le
   **même** JSON SA.
5. **En parallèle** : suivre l'**appel D-U-N-S** (deadline 9 août).

> **Règle d'or** : ne **jamais** flipper `NORVA_BILLING_MODE=revenuecat` /
> `NORVA_ENTITLEMENTS_MODE=enforce` avant qu'un **achat sandbox** Play marche de bout
> en bout et écrive une projection `trialing`/`active` (`provider=google_play`).

---

## Identifiants de référence (non secrets)

| Clé | Valeur |
|---|---|
| Package phone | `tv.norva.phone` |
| Package TV | `tv.norva.tv` |
| Projet GCP | `norva-ecosystem` |
| Service Account | `revenuecat-play@norva-ecosystem.iam.gserviceaccount.com` |
| Entitlement | `pro` |
| Offering | `default` |
| Produits Play | `norva_plus` (4,99 / 41,99) · `norva_family` (8,99 / 75,99) |
| Base plans | `monthly` (P1M) · `annual` (P1Y) + offre `free-trial` (P7D, new customers) |
| Packages | `$rc_monthly`, `$rc_annual`, `family_monthly`, `family_annual` |
| Webhook RevenueCat | `https://api.norva.tv/functions/v1/norva-billing-webhook` |
| Secret webhook (box) | `NORVA_REVENUECAT_WEBHOOK_AUTH` (valeur en `.env` uniquement) |
| Clés SDK (CI) | `REVENUECAT_API_KEY_PHONE` · `REVENUECAT_API_KEY_TV` (secrets GitHub) |
| Client OAuth Google (audience) | `973428500788-deum…apps.googleusercontent.com` |
| D-U-N-S | `268494859` (org *Hernandez*, 270 rue de Vaugirard 75015 Paris) |
