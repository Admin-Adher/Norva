# Norva — Configuration Google Play Console (walkthrough complet)

> **But** : un seul fil conducteur, **dans l'ordre**, pour créer les 2 apps
> (`tv.norva.phone`, `tv.norva.tv`) et **tout configurer** dans la Play Console —
> upload, App Signing, fiche magasin, classification, Data Safety, abonnements,
> RevenueCat, pistes de test, mise en prod.
>
> Ce doc **consolide** et **ordonne** ce qui était éparpillé. Les procédures déjà
> détaillées ailleurs sont **référencées**, pas recopiées :
> - Signing / keystore / build AAB → `clients/PLAY_STORE.md` §1 + `clients/PLAY_STORE_RELEASE_STATUS.md` §1-2
> - RevenueCat + produits → `docs/roadmap/billing-setup.md` §3-4
> - Bascule billing (flags) → `docs/roadmap/billing-status.md`
>
> _Créé : 2026-07-06._

---

## ⚠️ Correction importante vs les anciens docs — le rail WEB a changé

`billing-setup.md` §5 et §8 parlent de **Stripe / RevenueCat Web Billing** pour le
web. **Ce n'est plus le cas** : le rail web de Norva est désormais **Stancer**
(hosted checkout, orchestré côté serveur — `docs/STANCER-BILLING.md`). Conséquences
pour cette config :

- Dans **RevenueCat**, tu n'ajoutes **QUE les 2 apps Google Play**. **Pas** d'app
  « Web Billing », **pas** de connexion Stripe.
- La clé « Web Billing » (`revenueCatWebPublicKey`) n'est **pas** nécessaire.
  `billing-config.js` a déjà `stancer.enabled: true`.
- RevenueCat sert **uniquement le rail mobile** (Play). Le web (Stancer) écrit dans
  **la même** `cloud_entitlement_projection` → l'accès reste unifié par compte.

Le reste de `billing-setup.md` (entitlement `pro`, produits `norva_plus` /
`norva_family`, webhook, Service Account) **reste valable tel quel**.

---

## Où on en est (2026-07-06)

| Étape | État |
|---|---|
| Compte Play Console developer | ✅ obtenu (2026-07-03) |
| Keystore + secrets GitHub + build AAB signés | ✅ fait (run #3 vert) |
| Pages légales (privacy / terms / delete-account) en ligne | ✅ |
| E-mail de support `support@norva.tv` | ✅ |
| **Créer les 2 apps + uploader les AAB** | ⏳ **à faire (toi, maintenant)** |
| SHA-256 → `assetlinks.json` | ⏳ bloqué par l'upload |
| Fiche magasin + classification + Data Safety | ⏳ à faire |
| Abonnements Play + RevenueCat | ⏳ à faire |
| Bascule prod (`NORVA_BILLING_MODE=revenuecat`) | ⏳ tout à la fin |

**Les 2 AAB signés** sont produits par le workflow **`android-release.yml`**
(Actions → Run workflow → `main`). Ils expirent 14 j après le build → si besoin,
relance le workflow (pense à **bumper `versionCode`** avant tout nouvel upload,
un versionCode ne se réutilise jamais).

| Artéfact | Package | Version |
|---|---|---|
| `Norva-AndroidPhone-release-aab` (~9,3 Mo) | `tv.norva.phone` | 1.2.0 / vc 3 |
| `Norva-AndroidTV-release-aab` (~19,9 Mo) | `tv.norva.tv` | 3.8.0 / vc 13 |

---

## Ordre global (vue d'ensemble)

```
1. App phone : créer → upload AAB (Test interne) → accepter Play App Signing
2. App TV    : créer → form factor Android TV → upload AAB
3. SHA-256 (clé de signature Google) → assetlinks.json → commit → deploy
4. Fiche magasin (phone + TV) : titre/desc/assets  ← contenu prêt à coller ci-dessous
5. Classification du contenu (IARC)
6. Sécurité des données (Data Safety)
7. Contenu de l'app : App access (compte démo), Foreground service, public cible
8. Abonnements Play : norva_plus + norva_family (+ offre essai 7 j)
9. Service Account Play → RevenueCat + RTDN
10. RevenueCat : projet + 2 apps Play + entitlement `pro` + produits + offering + webhook
11. Clé publique RevenueCat Android → gradle.properties / secret CI → rebuild AAB
12. Pistes de test : Interne → Fermée → Production
13. Bascule prod : flip des flags Supabase (ordre critique)
```

> **Dépendance en boucle** : le SHA-256 de l'étape 3 n'existe **qu'après** le 1er
> upload (étape 1/2) + activation de Play App Signing. Ne cherche pas à remplir
> `assetlinks.json` avant d'avoir uploadé.

---

## 1. App phone — créer + uploader

1. Play Console → **Créer une application**.
   - Nom de l'app : **`Norva`** · Langue par défaut : **Français (France)** (tu
     ajouteras l'anglais comme langue de fiche ensuite).
   - Type : **Application** · **Gratuite**.
   - Coche les déclarations (règles développeur, lois export US).
2. Dans l'app → **Test et publication → Tests → Tests internes → Créer une release**.
3. **1er upload = accepter Play App Signing** (« Utiliser une clé générée par
   Google »). C'est ce qui génère la **clé de signature** dont tu auras besoin en §3.
4. Glisse `Norva-AndroidPhone-release-aab` (package `tv.norva.phone`). **Enregistrer**.
   - Pas besoin de « déployer » la release tout de suite — l'**upload** suffit à
     générer la clé de signature Google.

## 2. App TV — créer + form factor + uploader

1. **Créer une application** (2ᵉ app) : nom **`Norva`** (même nom accepté, package
   différent), Gratuite.
2. **Form factor Android TV** : Play Console classe l'app comme TV **si** l'AAB
   déclare `LEANBACK_LAUNCHER` + `uses-feature android.software.leanback` — **déjà
   le cas** dans le manifest TV. Après upload, va dans **Grow → Store presence →
   Devices / Android TV** (selon l'UI) pour **opt-in Android TV** et soumettre la
   fiche TV à la revue TV (bannière + captures TV requises, voir §4).
3. **Test interne → Créer une release** → upload `Norva-AndroidTV-release-aab`
   (package `tv.norva.tv`). Play App Signing : accepter (clé propre à cette app).

> La revue Android TV vérifie la **navigation D-pad** (tout doit être atteignable
> à la télécommande) et l'absence de gestes tactiles obligatoires. Le web app
> embarqué gère déjà le focus D-pad (classe `html.tv`).

## 3. `assetlinks.json` — empreinte SHA-256 (après upload)

- Fichier : `public/.well-known/assetlinks.json`. Il ne liste **que**
  `tv.norva.phone` (seule app avec des App Links https `norva.tv` ; la TV utilise
  le schéma `norva://open` → aucune entrée).
- Récupère l'empreinte : Play Console → **app phone → Test et publication →
  Configuration → Intégrité de l'app → Clé de signature de l'application → SHA-256**.
- ⚠️ **La clé de SIGNATURE (générée par Google), PAS la clé d'upload.** Piège
  classique : le SHA-256 que `keytool -list` affiche est celui de l'upload → faux.
- Remplace `REPLACE_WITH_RELEASE_SIGNING_SHA256_FROM_PLAY_CONSOLE` → commit → push
  → déploiement Cloudflare Pages. Les liens `norva.tv` ouvriront alors l'app sans
  la boîte de dialogue Android.

## 4. Fiche magasin — contenu prêt à coller (EN)

> La fiche magasin publique est en **anglais** (app publique = anglais). Ajoute
> l'anglais comme langue de fiche et colle ce qui suit. **Positionnement anti-rejet
> (§8 de `PLAY_STORE.md`)** : Norva est un **lecteur/organiseur sans aucun
> contenu** ; l'utilisateur connecte **sa propre source compatible qu'il possède
> et est autorisé à utiliser**. **Jamais** les mots IPTV / free channels / free
> movies / sports / le nom d'un service tiers.

**App name** (≤ 30) : `Norva — Media Player`

**Short description** (≤ 80) :
```
Your media on every screen. Connect your own source and play it anywhere.
```

**Full description** (≤ 4000) — phone :
```
Norva is a personal media player and organizer for the screens you already own —
phone, tablet, and TV. Norva includes no content of its own: you connect a
compatible media source that you own and are authorized to use, and Norva turns it
into a clean, fast, modern experience.

WHAT NORVA DOES
• One tidy library across all your devices — movies, series, and live channels
  from your own source, organized with posters, seasons, and episodes.
• Smart playback with hardware decoding (MKV, HEVC, EAC3) for smooth, high-quality
  video straight from your home network.
• Continue watching, watch history, favorites, and progress that sync across
  every screen tied to your account.
• Up to 5 profiles so everyone in the home gets their own space.
• Offline mode on supported devices for watching without a connection.
• Built for the living room too: full D-pad navigation and a 10-foot layout on
  Android TV.

BRING YOUR OWN SOURCE
Norva does not sell, host, or provide any channels, movies, or live TV. It is a
player: you add your own compatible source (the streaming service or media library
you already subscribe to and are entitled to use), and Norva plays it beautifully.
Your source stays yours.

PLANS
Start with a 7-day free trial, then keep everything on a single plan. Plans differ
only by how many screens can stream at the same time — Norva (2 streams) and Norva
Family (5 streams). Every feature is included on both. Cancel anytime.

Norva is a media player only. No content or TV subscription is included; the
content you watch stays provided by your own source.
```

**Full description** — TV (variante living-room, remplace le 1er paragraphe) :
```
Norva turns your Android TV into a clean, fast home for the media you already own.
Norva includes no content: connect a compatible source you own and are authorized
to use, and browse it with a 10-foot layout built for the remote — big posters,
smooth D-pad navigation, and instant playback with hardware decoding.
```
(garder les sections BRING YOUR OWN SOURCE / PLANS / disclaimer à l'identique.)

**Assets requis** (§11 `PLAY_STORE.md`) :
- Icône **512×512** (PNG 32-bit).
- Feature graphic **1024×500**.
- Captures **phone** (≥ 2, format portrait/paysage).
- **Bannière TV 1280×720** (le manifest TV déclare `android:banner`) + **captures
  TV 1920×1080** (≥ 1) — obligatoires pour la fiche Android TV.
- Screenshots dispo : `public/screenshots/` (UI réelle Norva déjà capturée).

**URLs à renseigner** :
- Politique de confidentialité : `https://norva.tv/privacy.html`
- (Data Safety) Suppression de compte : `https://norva.tv/delete-account.html`
- E-mail de contact : `support@norva.tv`

## 5. Classification du contenu (IARC)

Questionnaire → catégorie **Divertissement / lecteur multimédia**. Réponds
**honnêtement** :
- Contenu violent / sexuel / haineux / drogue / jeux d'argent **fourni par l'app**
  : **Non** (l'app ne fournit aucun contenu).
- « L'app donne-t-elle accès à du **contenu internet non filtré / fourni par
  l'utilisateur** ? » : **Oui** (l'utilisateur connecte sa propre source). Cette
  réponse est importante et honnête — elle ajoute un descripteur « contenu non
  contrôlé par l'éditeur », ce qui est **normal** pour un lecteur.
- Partage de localisation / infos perso entre utilisateurs : **Non**.

Résultat attendu : une classification type PEGI 3 / Everyone **avec** un
descripteur « accès à du contenu en ligne non filtré ». Ne prétends **jamais** que
l'app n'a aucun contenu internet — ce serait faux et rejetable.

## 6. Sécurité des données (Data Safety)

Réponses complètes dans `clients/PLAY_STORE_RELEASE_STATUS.md` §5. Résumé :
- Collecte : **Oui** · Chiffré en transit : **Oui** · Suppression possible :
  **Oui** (+ URL §4) · Données vendues : **Non** · Pub tierce : **Non**.
- Types : e-mail + nom (compte) ; identifiants de source média saisis
  (fonctionnalité) ; historique/progression/favoris/préférences (fonctionnalité,
  perso) ; logs de crash/diagnostics (fonctionnalité) ; statut d'abonnement
  (compte, **aucun n° de carte stocké** — les cartes vivent chez Stancer / Google).

## 7. Contenu de l'app — déclarations qui font rejeter si oubliées

1. **App access** → fournir un **compte démo avec abonnement valide** pour la revue
   Google (sinon « login wall, can't test » = rejet). Cf. §9 `PLAY_STORE.md`.
2. **Foreground service** (app phone, téléchargements) → formulaire à remplir :
   « téléchargement média **initié par l'utilisateur** avec notification de
   progression visible ». Cf. §6 `PLAY_STORE.md`.
3. **Public cible & contenu** : public **13+** (pas destiné aux enfants → évite
   Families Policy) · pas de pub · pas d'achat destiné aux enfants.
4. **Permissions** : CAMERA (phone) = scan du QR d'appairage uniquement (rationale
   in-app) ; POST_NOTIFICATIONS = progression de téléchargement.

## 8. Abonnements Play — `norva_plus` + `norva_family`

Pour **chaque app** (phone ET TV) : **Monetize → Products → Subscriptions →
Create subscription**. (Détail : `billing-setup.md` §4.2.)

| Subscription product ID | Base plans | Prix |
|---|---|---|
| `norva_plus` | `monthly` (P1M) · `annual` (P1Y) | 4,99 $ · 41,99 $ |
| `norva_family` | `monthly` (P1M) · `annual` (P1Y) | 8,99 $ · 75,99 $ |

- Sur **chaque base plan**, ajoute une **Offer** « free trial » **7 jours** (P7D),
  éligibilité **New customers**. C'est l'essai carte-requise.
- Active les **prix locaux** (Play convertit automatiquement — le hold « $0.50 »
  du web n'existe pas ici, Play prélève 0 pendant l'essai).
- ⚠️ Garde `plus` / `family` dans les IDs : le webhook a une heuristique de secours
  (`norva_family:annual → family`) même sans config explicite.

## 9. Service Account Play → RevenueCat + RTDN

Pour que RevenueCat lise/valide les achats Play (billing-setup §4.3) :
1. Play Console → **Setup → API access** → lier un projet Google Cloud.
2. Créer un **Service Account** avec l'accès financier/abonnements, générer une
   **clé JSON** → uploader dans RevenueCat (pour **chaque** app Play).
3. Activer les **Real-time Developer Notifications (RTDN)** vers le topic Pub/Sub
   fourni par RevenueCat.

## 10. RevenueCat (rail mobile uniquement)

Suivre `billing-setup.md` §3 **avec la correction du haut** (pas de Web Billing / Stripe) :
- **Projet** `Norva`, catégorie Media & Video, plateforme **Google Play Store**
  (pas de Web).
- **Apps** : 2× Play (`tv.norva.phone`, `tv.norva.tv`). Fournir le Service Account
  JSON (§9) pour chacune.
- **Entitlement** unique : **`pro`** → attacher les 2 produits (`norva_plus`,
  `norva_family`). C'est le **produit** qui décide du tier (nb de streams), pas
  l'entitlement.
- **Offering** par défaut, 4 packages (mêmes IDs que lit l'app) :
  `$rc_monthly → norva_plus:monthly`, `$rc_annual → norva_plus:annual`,
  `family_monthly → norva_family:monthly`, `family_annual → norva_family:annual`.
- **Webhook** → `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-billing-webhook`,
  header `Authorization` = un secret long → recopier dans Supabase
  `NORVA_REVENUECAT_WEBHOOK_AUTH`.
- **Clé publique Android** (Project settings → API keys) → §11.

## 11. Clé RevenueCat dans les apps Android → rebuild

- Poser la clé publique Android (`goog_…`) : soit `clients/android-phone/gradle.properties`
  + `clients/android-tv/gradle.properties` (`REVENUECAT_API_KEY=goog_…`), soit un
  secret CI `REVENUECAT_API_KEY` passé au build (`-PREVENUECAT_API_KEY=…`).
- ✅ **Version du SDK épinglée** : `com.revenuecat.purchases:purchases:8.25.0` (dernière
  v8, = ce que `8.+` résolvait) dans les 2 `app/build.gradle` — reproductible, pas de
  saut v9/v10 involontaire. À bumper volontairement pour tester une v8 plus récente.
- **Rebuild** les AAB (bump `versionCode`) → réuploader en Test interne.

> Sans clé, l'app compile et tourne (SDK non initialisé, paywall natif =
> « facturation indisponible ») → utile pour publier la coquille avant d'allumer.

## 12. Pistes de test — Interne → Fermée → Production

1. **Test interne** (déjà uploadé) : ajoute ton compte + testeurs (e-mails), envoie
   le lien d'opt-in, installe depuis le Play Store de test.
2. **Test fermé** : requis pour lever certaines exigences (les nouveaux comptes
   perso doivent souvent faire tester **20 testeurs pendant 14 j** avant Production
   — vérifier la politique en vigueur sur le compte). Faire tester **l'achat
   sandbox** (compte testeur de licence).
3. **Production** : soumettre après revue OK des pistes test.

Ajoute tes comptes de test dans **Setup → License testing** pour des achats
**sandbox** (pas de vrai débit) validant tout le tunnel.

## 13. Bascule prod — flip des flags (ordre critique)

Ne **jamais** flipper avant que l'achat sandbox marche de bout en bout
(`billing-status.md` « règle d'or »). Quand tout est vert :
1. `supabase secrets set NORVA_BILLING_MODE=revenuecat`
2. puis `NORVA_ENTITLEMENTS_MODE=enforce`
3. Redéployer `norva-cloud` + `norva-playback` (recharge l'env).
4. Vérifier `/functions/v1/norva-cloud/health` → `"billingMode":"revenuecat"`.
5. Rollback si souci : repasser `NORVA_ENTITLEMENTS_MODE=observe` (réouvre tout) + redeploy.

---

## Checklist finale (ordonnée, cochable)

- [ ] App phone créée + AAB uploadé (Test interne) + **Play App Signing accepté**
- [ ] App TV créée + **form factor Android TV** activé + AAB uploadé
- [ ] SHA-256 (clé de **signature** Google) → `assetlinks.json` → commit + deploy
- [ ] Fiche magasin phone (EN) : titre + short + full + icône + feature graphic + captures
- [ ] Fiche magasin TV : bannière 1280×720 + captures TV 1920×1080
- [ ] Classification du contenu (IARC) — « contenu internet non filtré » = **Oui**
- [ ] Data Safety rempli (résumé §6)
- [ ] App access : **compte démo abonné** fourni à la revue
- [ ] Foreground service justifié (app phone)
- [ ] Abonnements Play `norva_plus` + `norva_family` (base plans + offre essai 7 j) — sur les 2 apps
- [ ] Service Account JSON + RTDN → RevenueCat
- [ ] RevenueCat : 2 apps Play + entitlement `pro` + 4 packages + webhook + clé Android
- [ ] Clé `REVENUECAT_API_KEY` posée + SDK épinglé + AAB rebuild/réupload
- [ ] Achat **sandbox** Play OK (compte testeur) → projection `trialing`/`active`
- [ ] Piste de test fermée validée (exigence testeurs si compte perso)
- [ ] Flip `NORVA_BILLING_MODE=revenuecat` → `NORVA_ENTITLEMENTS_MODE=enforce` → redeploy
- [ ] Soumettre en Production

---

## Fichiers de référence

| Sujet | Fichier |
|---|---|
| Signing / keystore / build AAB | `clients/PLAY_STORE.md` §1 · `clients/PLAY_STORE_RELEASE_STATUS.md` §1-2 |
| Readiness policy (data safety, permissions, IP positioning) | `clients/PLAY_STORE.md` §3-11 |
| RevenueCat + produits + webhook | `docs/roadmap/billing-setup.md` §3-4, §6-7 |
| Bascule des flags + rollout | `docs/roadmap/billing-status.md` |
| Rail web Stancer (séparé) | `docs/STANCER-BILLING.md` · `docs/STANCER-GO-LIVE-RUNBOOK.md` |
| Écrans d'achat/gestion (UI, déjà en prod) | `public/subscribe.html` · `public/checkout.html` · `public/subscription.html` · `public/paywall.html` |
