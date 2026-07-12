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

## ⚠️ RÉFÉRENCE — DEUX projets Google Cloud (piège récurrent)

Norva utilise **deux** projets Google Cloud **distincts**. C'est **normal / voulu**,
mais ça piège : ne pas chercher le login Google dans le projet Firebase, ni l'inverse.

| Projet GCP | N° projet | Sert à | Ce qu'on y trouve |
|---|---|---|---|
| **`norva-501719`** | `973428500788` | **Connexion Google (OAuth)** | Client OAuth **Web** `973428500788-deum…` + Client OAuth **Android** `973428500788-eut6…` (package `tv.norva.phone`, SHA-1 = signature Play). Écran de consentement OAuth. |
| **`norva-ecosystem`** | *(≠ 973428500788)* | **Firebase/FCM + RevenueCat + RTDN** | Firebase (push, `google-services.json`), clés API Firebase, **Service Account RevenueCat** `revenuecat-play@norva-ecosystem.iam.gserviceaccount.com`, **topic Pub/Sub RTDN** (`norva-rtdn`). |

**Règles à retenir :**
- Le **n° de projet = préfixe des client IDs OAuth** → `973428500788-…` ⇒ projet
  **norva-501719** (login). Si un client OAuth n'apparaît pas dans un projet,
  c'est qu'il est dans l'**autre**.
- **Login Google** (Web + Android OAuth) → **norva-501719** UNIQUEMENT. Web + Android
  doivent être dans **le même** projet (sinon Google n'émet pas le token).
- **RevenueCat / Play / Firebase / RTDN** → **norva-ecosystem**. Le Service Account,
  l'API Play Android Developer, le topic Pub/Sub y vivent.
- Les deux projets sont **indépendants** : le login et les paiements n'ont PAS besoin
  d'être dans le même projet.

---

## Les 9 points — tableau d'avancement (2026-07-12)

| # | Point | État |
|---|---|---|
| 1 | RevenueCat : projet + 2 apps Play + 2 clés SDK `goog_…` → secrets CI | ✅ **Fait** |
| 2 | RevenueCat : webhook → backend + `NORVA_REVENUECAT_WEBHOOK_AUTH` (test 200) | ✅ **Fait** |
| 3 | Play Console (phone) : abonnements `norva_plus` + `norva_family` (base plans + offre essai 7 j) | ✅ **Fait (phone)** |
| 4 | Service Account Play → RevenueCat (JSON + droits Play + API activée) | 🟡 **En attente de propagation Google (24-36 h)** |
| 5 | RevenueCat : entitlement `pro` + offering `default` + 4 packages | ✅ **Fait** — entitlement `pro` ✅, 4 produits créés + attachés ✅, offering `default` + 4 packages mappés ✅ (validation produits « Could not check » → verte quand #4 propage) |
| 6 | RTDN (Real-time Developer Notifications) → topic Pub/Sub | ✅ **Fait** — topic `norva-rtdn` (projet `norva-ecosystem`) + SA rôle **Pub/Sub Admin** (⚠️ pas « Lite ») → RevenueCat « Connected to Google » |
| 7 | App TV (app **GRATUITE**, pas d'IAP — modèle Netflix) | 🟢 **Validé fonctionnellement** — app `tv.norva.tv` créée + AAB vc14 keyé en test interne ✅ ; **la TV appairée HÉRITE de l'abo `google_play`** du compte (essai 19 juil vérifié à l'écran) ✅ ; read-only (pas de vente sur TV). **Pas besoin** de produits RevenueCat TV ni d'abonnements Play TV. **Reste (publication)** : testeurs, form factor Android TV, fiche magasin. |
| 8 | Testeurs de licence + **achat sandbox** → projection `provider=google_play` | ✅ **Fait (phone)** — achat sandbox → `google_play/plus/trialing/19 juil` écrit + lu. TV = pas d'achat (hérite). |
| 9 | Connexion Google (phone) : provider GoTrue + client OAuth Android + test device | ✅ **FAIT & validé sur device** — login natif → compte connecté dans Norva (« Signed in as … — Norva Cloud account ») |

**Bloqueurs transverses**
- ⚠️ **D-U-N-S / suppression du compte Play le 9 août 2026** (bandeau rouge).
  **Faux positif confirmé par preuve externe** (2026-07-12) : le D-U-N-S `268494859`
  n'a **PAS** changé — vérifié sur **D&B UPIK** (`Hernandez, 270 RUE DE VAUGIRARD
  PARIS 75015`) **et** sur **Verif** (`Hernandez`, EI, SIRET `82485208100036`,
  statut **Active**). Nom + adresse **identiques** à ceux du profil de paiement Play
  (validé le 9 juil.). Cause probable : le matcher auto Google s'est emmêlé entre
  les **multiples enregistrements « Hernandez »** de D&B (268494859, 275154083,
  287170261, 264513034…) lors d'une re-vérification.
  **Appel déposé** : ticket `5-1384000041027` (envoyé le 12 juil. 11:18 par
  adrienhernandez20@gmail.com ; e-mail supplémentaire adrien.hernandez@outlook.com ;
  langue EN ; décision sous 7 j). Ne **PAS** modifier le D-U-N-S dans le profil (il
  est correct). Preuves (captures D&B UPIK + Verif) à conserver pour l'appel.
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
| Service Account (app Norva Phone) | JSON uploadé ✅ ; **validation « Credentials need attention »** = attente de propagation Google (message exact : *« Your Google Service Account credentials do not have permissions to access the needed Google resources »* → propagation, pas d'erreur de config) |
| Entitlement `pro` | ✅ **Créé** (REST API id `entl9f680380c4`, display « Norva Pro access ») |
| Produits (Norva Phone) | ✅ **4 créés + attachés à `pro`** : `norva_plus:monthly`, `norva_plus:annual`, `norva_family:monthly`, `norva_family:annual` (« Backwards compatible » décoché → identifiers `sub:baseplan`). Statut « Could not check » = attente SA vert (normal). Créés manuellement car l'import auto exige le SA vert. |
| Offering `default` + 4 packages | ✅ **Fait** (REST id `ofrngedec7b8faa`). Mapping (produit Norva Phone) : `$rc_monthly`→`norva_plus:monthly`, `$rc_annual`→`norva_plus:annual`, `family_monthly`→`norva_family:monthly`, `family_annual`→`norva_family:annual`. Produits TV à ajouter aux mêmes packages au #7. |
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
| App phone `tv.norva.phone` | ✅ créée, **test interne** en place (vc10 → à remplacer par **vc11 keyé**, build #15) |
| App TV `tv.norva.tv` | ✅ **créée**, AAB **vc14 keyé** uploadé en **test interne** (build #15). Reste : testeurs + abonnements TV + form factor Android TV |
| Abonnements (phone) | ✅ `norva_plus` (mensuel 4,99 / annuel 41,99) + `norva_family` (mensuel 8,99 / annuel 75,99), base plans **`monthly`** / **`annual`** (IDs confirmés dans Play, identiques pour les 2 subs), **offre essai 7 j** (`freetrial-monthly` / `freetrial-annual`) |
| ⚠️ Offres d'essai `norva_plus` | 🟡 **En `Brouillon` (Draft) — à ACTIVER** (`freetrial-monthly` + `freetrial-annual`). Sur `norva_family` elles sont déjà `Actif`. Sinon les abonnés **Plus n'auront pas les 7 j gratuits**. Action : Play → `norva_plus` → chaque offre → ⋮ → Activer. |
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

**⚠️ Deux projets Google Cloud (par design, pas un bug) :**
- **`norva-501719`** (n° `973428500788`) = **login Google** : clients OAuth **Web**
  (`973428500788-deum…`) + **Android** (`973428500788-eut6…`). C'est le projet dont
  le n° préfixe les client IDs.
- **`norva-ecosystem`** = **Firebase/FCM** (google-services.json) + **Service Account
  RevenueCat** (`revenuecat-play@…`). Indépendant du login — normal.

**Config login Google — FAITE ✅ :**
1. Client OAuth **Android** `973428500788-eut6…` (projet `norva-501719`) : package
   `tv.norva.phone` ✅, **SHA-1 = signature Play** ✅ (vérifié identique :
   `C4:C7:69:6C:AB:17:16:88:51:70:C4:A8:D3:6F:49:FE:32:9B:CF:C7`).
2. Client **Web** `973428500788-deum…` présent, **déjà accepté par GoTrue** (le login
   web fonctionne → l'audience du token natif = ce client web, donc rien à ajouter).
3. Code natif prêt (`GetSignInWithGoogleOption.Builder(webClientId)`, `strings.xml`
   renseigné).

**Reste :**
- **Tester « Continue with Google »** sur un device réel (build vc11 installé depuis
  le test interne).

---

## Ce qui est FAIT (récap)

- **#1 #2 #3 #5** : RevenueCat entièrement configuré (2 apps, 2 clés SDK→CI, webhook
  testé 200, entitlement `pro`, 4 produits, offering `default` + 4 packages mappés).
- **#4** : Service Account créé + droits Play + API activée + JSON uploadé →
  **en attente de propagation Google** (validation passera verte seule).
- **#7 (partiel)** : app TV `tv.norva.tv` créée + **AAB vc14 keyé** en test interne.
- **#9 ✅ FAIT** : connexion Google native validée sur device — login → compte
  connecté dans Norva (« Signed in as … — Norva Cloud account »).
- **Build #15** (commit `19d7dc5`) : AABs phone **vc11** + TV **vc14** avec la clé
  RevenueCat, réussi.
- **Play (phone)** : offres d'essai `norva_plus` activées (Brouillon→Actif).

## Ce qui RESTE à faire

> **Le rail technique est 100 % validé** : #1-#9 faits. SA vert, RTDN connecté,
> achat sandbox → projection `google_play | plus | trialing | 2026-07-19` lue par
> l'app + héritée par la TV. Il ne reste que la **config de publication Play Console**
> (déclarations « Contenu de l'app » + fiches), le **flip prod**, et l'**appel D-U-N-S**.

### 🟢 Config publication Play Console — EN COURS (phase A)
**App PHONE — déclarations FAITES (2026-07-12)** :
- ✅ Règles de confidentialité (`norva.tv/privacy.html`)
- ✅ Informations de connexion / App access (Oui restreint + compte démo
  `adrienhernandez20@gmail.com`, accès Pro durable — l'owner laisse l'abonnement se
  convertir en paiement réel sur ce compte)
- ✅ Annonces (Non) · ✅ Classification IARC (contenu-non-filtré=Oui, achats-num=Oui,
  loot=Non) · ✅ Public cible (13+/16+/18+) · ✅ Sécurité des données · ✅ Financières
  (aucune) · ✅ Catégorie (Lecteurs vidéo) + coordonnées · ✅ Fiche Play Store
- ⬜ Reste phone : Service au premier plan (téléchargements) si demandé.

**App TV `tv.norva.tv` — déclarations FAITES (2026-07-12)** : mêmes 9 déclarations
que phone, avec les spécificités TV appliquées — Data Safety → « ne permet pas de
créer un compte » (appairage) + comptes créés hors-app = « Autre » + 3 types
seulement (interactions/plantages/ID) ; App access → instructions d'appairage TV (EN,
≤500 car.).
- ⬜ **Reste TV** : opt-in form factor Android TV + **assets fiche TV**
  (bannière **1280×720** + ≥1 capture **1920×1080**) — le point visuel encore ouvert.

### 🔴 En DERNIER (rail validé — quand la publication est prête)
- **Bascule prod** : `NORVA_BILLING_MODE=revenuecat` → `NORVA_ENTITLEMENTS_MODE=enforce`
  → redeploy (voir §13 de `play-console-setup.md`). Non urgent.

### ⚠️ Transverse (en parallèle, deadline 9 août)
- Résoudre l'**appel D-U-N-S** (ticket `5-1384000041027`) — faux positif prouvé
  (voir « Bloqueurs transverses »). Sinon suppression du compte Play le 9 août.

> **Règle d'or** : ne **jamais** flipper `NORVA_BILLING_MODE=revenuecat` /
> `NORVA_ENTITLEMENTS_MODE=enforce` avant qu'un **achat sandbox** Play marche de bout
> en bout et écrive une projection `trialing`/`active` (`provider=google_play`). ✅ fait.

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
| Projet GCP — login Google | `norva-501719` (n° `973428500788`) — clients OAuth Web+Android |
| Client OAuth **Web** (audience token) | `973428500788-deum…apps.googleusercontent.com` |
| Client OAuth **Android** | `973428500788-eut6…apps.googleusercontent.com` (package `tv.norva.phone`) |
| SHA-1 signature Play (phone) | `C4:C7:69:6C:AB:17:16:88:51:70:C4:A8:D3:6F:49:FE:32:9B:CF:C7` |
| SHA-256 signature Play (phone) | `30:D3:3F:CA:53:A9:14:76:4E:89:EE:BE:F6:B8:B2:37:E0:AD:A2:C1:3A:57:7A:A0:22:E7:30:F5:10:DF:F8:73` |
| D-U-N-S | `268494859` (org *Hernandez*, 270 rue de Vaugirard 75015 Paris) |

---

## Journal chronologique

- **2026-07-12** — Session de config go-live (pas-à-pas) :
  - #1 clés SDK phone/TV → secrets CI ; #2 webhook + secret box (test 200).
  - #3 abonnements phone `norva_plus` + `norva_family` créés (base plans `monthly`/`annual`).
  - #4 Service Account créé (`revenuecat-play@norva-ecosystem`), API androidpublisher
    activée, droits Play accordés/enregistrés, JSON uploadé → **en attente de
    propagation Google** (import produits refusé : *credentials do not have
    permissions* = propagation).
  - #5 entitlement `pro` créé (`entl9f680380c4`) ; **4 produits créés manuellement**
    (`norva_plus:{monthly,annual}`, `norva_family:{monthly,annual}`) + **attachés à
    `pro`** ; statut « Could not check » (attente SA). **Reste** : offering `default`
    + 4 packages.
  - **Repéré** : offres d'essai `norva_plus` en `Brouillon` → à activer.
  - #5 **terminé** : offering `default` (`ofrngedec7b8faa`) + 4 packages mappés
    (`$rc_monthly`/`$rc_annual` → Plus, `family_monthly`/`family_annual` → Family).
    Piège corrigé en cours de route : `$rc_annual` pointait par erreur sur
    `norva_family:annual` → remis sur `norva_plus:annual`.
  - Docs : création de ce journal + correction rail web Stancer→Revolut dans
    `play-console-setup.md`.
  - **Aparté Revolut Business (KYB)** : demande de preuve de propriété de `norva.tv`.
    Registrar identifié = **Cloudflare** (RDAP, enregistré 2026-06-18, exp. 2027-06-18)
    → reçu d'achat + capture dashboard Cloudflare à fournir.
  - #9 **config login Google terminée** : découverte de 2 projets GCP (`norva-501719`
    = login, `norva-ecosystem` = Firebase/RevenueCat). Client OAuth Android déjà créé
    (`973428500788-eut6…`), SHA-1 vérifié = **signature Play** (match exact). Reste le
    test device après build vc11.
  - #7 **Piste B lancée** : bump versionCodes (phone vc11 / TV vc14, commit `19d7dc5`),
    rebuild CI **run #15 réussi** (AABs phone vc11 + TV vc14 keyés).
  - #7 **app TV créée** (`tv.norva.tv`) + **AAB vc14 uploadé en test interne** (accessible
    aux testeurs, sortie 14:35). Reste : testeurs, form factor TV, abonnements TV,
    produits RevenueCat TV (gaté #4).
  - #9 **test device** : le **sélecteur de compte Google natif s'affiche** dans l'app
    phone (vc11) → toute la config OAuth Android + SHA-1 Play est validée. Login
    complet **confirmé** (compte connecté dans Norva).
  - **Bugs TV corrigés (testing)** :
    1. **Logout TV → formulaire e-mail/mdp** au lieu du QR. Fix web (déploie via
       Pages) : `Settings.js` redirige le shell TV vers `cloud-pair.html` ; garde
       défensive dans `account.html` (tout shell TV non-authentifié → appairage).
       Détection stricte par UA `NorvaTV-AndroidTV` (zéro impact phone/web).
    2. **Logout TV → QR flashe puis reconnecte** le même compte (le device-token
       local persistait → `cloud-pair` reprenait la session). Fix : nouvel endpoint
       serveur `DELETE /device/me` (auto-unpair, `revoked=true`, authentifié par
       device-token) + le device-token/id local est effacé et l'unpair appelé au
       logout. **⚠️ nécessite un déploiement edge sur la box.**
    4. **Boutons manage/subscribe rendus provider-aware** (`subscription.html`) :
       avant, natif = « Manage on Google Play » / web = Revolut, **sans regarder le
       vrai provider**. Un abo **Revolut (web)** ouvert sur Android affichait à tort
       « Manage on Google Play ». Désormais le bouton suit le **provider de
       l'entitlement** (`revolut`/`google_play`/`apple`) ; les subs « gérés
       ailleurs » affichent une **note info** (pas de bouton de gestion trompeur, ni
       lien paiement web sur Android = conforme Play) et « Change plan » est masqué
       pour éviter un double abonnement.
    5. **Essai « fantôme » expliqué** (pas un bug) : en `NORVA_BILLING_MODE=legacy`,
       le serveur auto-crée un essai 7 j **sans carte** (`provider=system`,
       `startTrialProjection`). Disparaît à la bascule prod (`=revenuecat`).
    7. **Achat Play → pas de projection `google_play`.** Le login RevenueCat
       (App User ID = id GoTrue) n'était appelé que dans `subscribe.html`, en
       **fire-and-forget juste avant `purchase()`** (race : `logIn` async pas
       attendu) et **jamais au boot** → l'achat partait sous un App User ID
       **anonyme** → le webhook ne pouvait pas le rattacher à l'utilisateur → pas
       de projection. Fix (web) : `app.html` charge `billing.js` et `app.js`
       appelle `NorvaBilling.login(user.id)` **au boot** (dès la session prête) →
       identité correcte avant tout achat + **ré-association** de l'achat anonyme
       à la réouverture. (S'ajoute : achat resté « à confirmer » car acheté pendant
       la propagation du SA → réouvrir l'app pour l'acquitter.)
    6. **« Restore purchases » fermait l'app TV.** Play Billing crashe (niveau natif,
       non rattrapable par le try/catch Java) sur les box TV sans Play Services
       fiable. Design correct : **la TV appairée ne fait PAS de billing en propre**
       (l'abo du compte web/phone s'applique déjà). Fix (web) : `billing.js`
       `hasNativeBilling()` = **false sur TV** (plus aucun appel natif) + `isTvShell`
       exposé ; `subscription.html` **read-only sur TV** (pas de Restore / Change
       plan / Subscribe, note « gérer sur norva.tv ou l'app téléphone »).
       ⚠️ **Piège** : il y a **2 boutons logout** — `Settings.js signOut()` ET le
       **« Logout » de la barre du haut** (`app.js addLogoutButton()`, le chemin
       réellement utilisé sur la TV). Le même correctif TV a été appliqué **aux
       deux**. Déploiement web via Pages ; **penser à vider le cache WebView TV**
       (fermer/rouvrir l'app) pour charger le nouveau `app.js`.
    3. **Révocation à distance → TV bloquée sur écran vide.** Quand on révoque le
       device depuis le compte (téléphone), le device-token de la TV devient
       invalide mais l'app restait sur sa coquille. Fix (web) : `cloudApi.js`
       `markInvalidDeviceToken` redirige le shell TV vers `cloud-pair.html` dès
       qu'un token invalide est détecté (garde anti-boucle, UA `NorvaTV-AndroidTV`).
       → révoquer une session = la TV repart sur le QR automatiquement.
