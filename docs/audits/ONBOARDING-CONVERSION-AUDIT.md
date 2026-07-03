# Norva — Audit onboarding & tunnel de conversion (web · Android TV · mobile)

> Audit **ancré dans le code réel** (parcours tel qu'il est *câblé*, pas tel qu'il est *pensé*),
> benchmarké contre les meilleurs tunnels d'abonnement au monde, et assorti de recommandations
> priorisées et spécifiques au positionnement de Norva.
>
> **Date : 2026-07-03.** Méthode : 4 explorations parallèles du code (web `public/`,
> `clients/android-phone`, `clients/android-tv`, backend `supabase/functions`), chaque constat
> cité en `fichier:ligne`.

---

## 0. Résumé exécutif — le constat central

Norva a **deux tunnels superposés**, et ils ne sont pas dans le même état :

1. **Le tunnel d'acquisition + activation** (atterrissage → inscription Supabase → connexion d'une
   source Xtream/M3U → lecture) **fonctionne réellement**, mais **sans aucun accompagnement** :
   pas d'assistant de configuration, pas de checklist d'activation, pas d'e-mail de bienvenue, pas
   de CTA dans les états vides, pas de preuve sociale.
2. **Le tunnel de monétisation** (essai 7 j → paywall → paiement) est **entièrement designé dans
   l'UI mais totalement dormant** : aucun prestataire de paiement n'est branché en production,
   l'enforcement tourne en mode `observe` (rien n'est bloqué), et le « paiement automatique en fin
   d'essai » **n'existe pas encore** dans le mode réellement actif.

**L'écart entre le modèle voulu et le modèle câblé est le vrai sujet de cet audit.** Ce que tu
décris — « essai 7 j avec passage automatique au paiement » — est la **cible**, pas la réalité de
production. Aujourd'hui :

- Le backend tourne en mode **`legacy`** : un essai 7 j **sans carte** est auto-accordé côté
  serveur (`_shared/entitlements.ts:142-145, 331-345`), et **rien ne le convertit** — à
  expiration il se transforme en **mur** (`entitlements.ts:162-167, 273-276`). Aucune carte,
  aucun cron, aucun prélèvement.
- Le rail qui *ferait* le prélèvement automatique (**RevenueCat + Google Play** en natif, **Web
  Billing** sur le web) est **codé de bout en bout mais inerte** : clé RevenueCat absente
  (`NorvaApplication.java:22-26`), `webBillingEnabled:false` (`billing-config.js:12-14`), webhook
  qui renvoie 401 tant que son secret n'est pas posé (`norva-billing-webhook/index.ts:283-288`).
- **Stancer n'apparaît nulle part dans le code** (0 référence). **Gumroad** n'existe qu'en doc +
  4 tâches en attente. Le prestataire « approuvé » n'est donc pas encore un octet de code livré.

### Scorecard par surface (état actuel)

| Surface | Inscription | Activation (connexion source) | Essai/paywall | Paiement | Verdict |
|---|---|---|---|---|---|
| **Web** | ✅ email/mot de passe Supabase, **pas d'OAuth** | ⚠️ fonctionne mais **non guidée** (à découvrir seul dans Réglages) | 🟠 UI complète mais **dormante** (`observe`) | 🔴 **dead-end** (`webBillingEnabled:false`) | Acquisition OK, monétisation à zéro |
| **Mobile Android** | ⤴️ délègue au web (WebView) | ⤴️ délègue au web | 🔴 aucun paywall natif | 🟠 code RevenueCat/Play réel mais **inerte** (pas de clé) | Coquille technique, 0 onboarding natif |
| **Android TV** | ⤴️ appairage **code + URL à recopier** (pas de QR) | ⤴️ délègue au web | 🔴 non durci pour le D-pad | 🟠 vend en natif *possible* mais inerte | Consomme l'entitlement (OK), UX d'appairage datée |
| **Backend** | — | — | 🟠 essai legacy sans carte → **mur** | 🔴 aucun provider live | Source de vérité unique ✅, mais monétisation off |

**Bonne nouvelle :** l'architecture est saine (entitlement unifié multi-appareils, source de
vérité unique, code de paiement déjà écrit). **Le travail n'est pas de construire, mais de
brancher, séquencer et polir** — et de combler le trou béant de l'*activation guidée*.

---

## 1. Cartographie du parcours réel

### 1.1 Web (`public/`)

**Parcours :** `/` ou `/landing.html` → `/account.html` (inscription Supabase) → `/app#home`
(catalogue vide) → l'utilisateur doit **trouver seul** Réglages › TV Service pour ajouter une
source → paywall/abonnement *scaffoldé mais inerte*.

- **Atterrissage** (`landing.html`) : hero « Your catalog. Every screen. One experience. »
  (`landing.html:57-61`), CTA unique « Create my space » → `/account.html` (répété 8×). Pricing
  affiché : **Norva 4,99 €/mois** (2 flux) / **Norva Family 8,99 €/mois** (5 flux), toggle
  mensuel/annuel « Save 30 % » (41,99 € / 75,99 €) (`landing.html:238-256`, `landing.js:97-129`).
  Chaque CTA = « Start 7-day free trial ». **Preuve sociale = 4 avatars stock décoratifs**
  (`landing.html:67-78`) + badge « Most popular » **codé en dur** (`:248`). Aucune note, aucun
  nombre d'utilisateurs, aucun témoignage.
- **Inscription** (`account.html` + `authApi.js`, Supabase GoTrue) : nom (optionnel), e-mail,
  **mot de passe `minlength=6`** sans indicateur de force ni vérification de fuite
  (`account.html:375`). **Aucun login social (Google/Apple)** sur le tunnel web — le seul « SSO »
  vit sur la page hub legacy `login.html:199-207` que le tunnel n'atteint jamais. La vérification
  e-mail dépend d'un réglage Supabase ; pas d'écran « confirmation en attente » ni bouton renvoyer.
- **Premier lancement connecté** (`app.js:41-306`) : after signup → `/app#home`. `checkCloudAccess`
  lit `/entitlements`, mode `observe` ⇒ **passe tout droit, aucun paywall**, et **fail-open** en
  cas d'erreur (`app.js:751-784`). L'utilisateur arrive sur **Home aux rails vides** ;
  `body.catalog-locked` **masque les onglets Live/Movies/Series** tant qu'il n'y a pas ≥1 item
  (`app.js:551-565`). **Le seul indice** est un texte d'état vide « Add a source in Settings to get
  started » (`app.html:277-279`). **Aucun assistant, aucune checklist, aucun e-mail de bienvenue.**
- **Connexion de la source** (le vrai « aha », `SourceManager.js`) : Réglages › TV Service ›
  « Add provider » → coller un lien Xtream (auto-parsé `parseXtremeLink:477-517`) **ou** M3U →
  sync en fond (barre d'enrichissement `app.html:207`). **~3-4 clics + un collage — peu de friction
  une fois trouvé.** Le problème est la **découvrabilité** (onglet stylé « advanced »,
  `app.html:766`), pas le formulaire. Aucune source de démo pour atteindre l'« aha » sans ses
  propres identifiants.
- **Paywall & abonnement** (`paywall.html`, `subscribe.html`, `subscription.html`, `billing.js`) :
  déclenché seulement si le serveur renvoie `allowed===false` (`app.js:762-764`) — **jamais en
  `observe`**. Le « soft-wall » à la première lecture (HTTP 402) est câblé mais neutralisé
  (`cloudApi.js:766-784`). Le CTA « Start 7-day free trial » présent ~10× **ne peut aboutir à
  aucun achat dans un navigateur** : `isWebBillingConfigured()` est **false**
  (`billing.js:37-40`, `billing-config.js:12-14`) → message « Billing is not configured yet ».
  Pas de bouton « Gérer/annuler » web (`webCustomerPortalUrl:''`). Réassurance « cancel anytime »
  présente (`subscribe.html:154-156`) ✅.

### 1.2 Mobile Android (`clients/android-phone`)

- **C'est un wrapper WebView, pas un onboarding natif.** `MainActivity` construit un `WebView`
  et charge directement la page **web** `account.html` après un splash
  (`MainActivity.java:58,112-130,63`). **Aucun écran de valeur, aucun login natif, aucun paywall
  natif.**
- **Billing = code réel RevenueCat v8 (offerings/purchase/restore/logIn) mais inerte** : tout est
  gaté sur `Purchases.isConfigured()`, vrai seulement si `REVENUECAT_API_KEY` est injectée au
  build — elle ne l'est pas (`NorvaBilling.java:37-43,63-65`; `NorvaApplication.java:22-26`;
  `app/build.gradle:27`). Chaque appel renvoie `"billing_not_configured"`.
- **L'essai 7 j n'apparaît jamais dans l'APK** : c'est un *free-trial offer* P7D configuré
  côté Play/RevenueCat (`docs/roadmap/billing-setup.md:81-104`). L'app achète un `packageId`
  opaque que le web lui passe.
- **Deux anti-patterns notables** : (1) la permission **notifications est demandée dès le premier
  lancement**, sans amorce ni valeur préalable (`MainActivity.java:140,707-714`) ; (2) la
  permission **CAMERA est déclarée mais jamais demandée au runtime** → le scan QR intégré au
  WebView risque d'échouer sur Android 6+ (`AndroidManifest.xml:7`, `MainActivity.java:259-265`).
- **Restore purchases** : le pont existe mais **aucun bouton natif** ne l'expose
  (`MainActivity.java:526-530`). Activité **verrouillée en portrait** alors que la cible inclut
  les tablettes (`AndroidManifest.xml:31`). **SSL error → proceed()** inconditionnel
  (`MainActivity.java:284-288`).
- **Force réelle** : mode hors-ligne soigné (bibliothèque de téléchargements native + écran de
  reprise) (`MainActivity.java:132-136,867-953`).

### 1.3 Android TV (`clients/android-tv`)

- **Wrapper WebView** également ; l'appairage est le bon instinct pour la TV, **mais l'implémentation
  affiche un code + une URL en texte à recopier sur le téléphone — sans QR code**
  (`cloud-pair.html:159-163, 217-220`), alors qu'une **page QR existe déjà dans le repo**
  (`pair.html:86-102, 478-481`) et n'est simplement pas branchée sur la TV
  (la TV est hardcodée sur `cloud-pair.html`, `MainActivity.java:41`).
- **Consomme l'entitlement du compte** (le vrai modèle) : après appairage, la TV charge la même
  SPA `/app.html` liée au compte → **un abonnement/essai démarré sur web ou mobile est honoré
  automatiquement sur la TV** (`cloudApi.js:515-516,798-801`). ✅ Vraie synchro multi-appareils.
- **Aussi câblée pour vendre en natif** (Play Billing/RevenueCat via le pont WebView,
  `NorvaBilling.java:62-99`, `subscribe.html:244-257`) — mais inerte (pas de clé) et
  **`subscribe.html`/`paywall.html` ne chargent pas `tvNavigation.js`** → focus D-pad par défaut,
  non durci pour la télécommande.
- **Réglages accessibles seulement via touche MENU** (que beaucoup de télécommandes n'ont pas) ;
  seule porte garantie = BACK → dialogue de sortie (`MainActivity.java:851-871`). **SSL bypass**
  inconditionnel sur la page qui échange pourtant le device token (`MainActivity.java:197-201`).

### 1.4 Backend abonnement / essai / entitlement (`supabase/functions`)

- **Source de vérité unique** : table `cloud_entitlement_projection` (1 ligne / `user_id`), lue
  identiquement par toutes les plateformes via `_shared/entitlements.ts`. App User ID = user id
  Supabase → web/TV/mobile s'agrègent sur la même ligne. ✅ Architecture correcte.
- **Mode `legacy` (actif) : essai sans carte qui ne convertit jamais.** `startTrialProjection`
  insère `status:'trialing'`, `trial_ends_at = now + 7 j` (`entitlements.ts:331-345`) ; à
  expiration → `softDeny("trial_expired")` qui, en legacy, **durcit en blocage** sans chemin de
  paiement (`entitlements.ts:162-167, 273-276`). **Aucun cron de conversion.**
- **Enforcement en mode `observe`** (`entitlements.ts:309-329`) : chaque décision est réécrite en
  « autorisé » ⇒ **rien n'est réellement bloqué aujourd'hui.**
- **RevenueCat webhook** : seul point d'intégration paiement, complet (mapping événements →
  statut) mais **inerte** (401 tant que `NORVA_REVENUECAT_WEBHOOK_AUTH` absent,
  `index.ts:283-288`). Vérification par **secret partagé** (pas HMAC), idempotence par
  `(provider, provider_event_id)`.
- **Trous fonctionnels** : `TRANSFER` (fusion de compte) = TODO non géré (`index.ts:164-166`) ;
  **aucun REFUND/CHARGEBACK/REVOKE** → un remboursement arrive en `CANCELLATION` et l'accès
  continue jusqu'à la fin de période ; les statuts durs `revoked/refunded/fraud` ne sont jamais
  écrits.

---

## 2. Le tunnel de conversion, étape par étape (points de fuite)

```
Découverte → Landing → Inscription → [ACTIVATION: connecter une source → 1ʳᵉ lecture] → Paywall → Essai → Conversion payante → Rétention
```

| Étape | État Norva | Risque de fuite | Cause dans le code |
|---|---|---|---|
| Landing → inscription | CTA unique « créer un compte » | **Élevé** : on demande un compte *avant* toute valeur ; pas de démo, pas de preuve sociale | `landing.html` (8× le même CTA) |
| Inscription | e-mail + mot de passe, pas d'OAuth | **Moyen-élevé** : friction du mot de passe, pas de Google/Apple | `account.html:375` |
| **Activation (source)** | **Non guidée** | **Critique** : le cœur d'un lecteur BYOC, laissé sans assistant | `app.js:551-565`, `app.html:277-279` |
| 1ʳᵉ lecture (aha) | soft-wall 402 câblé mais off | n/a aujourd'hui | `cloudApi.js:766-784` |
| Paywall | dormant (`observe`) | **Blocage total à venir** : dès l'`enforce`, mur sans moyen de payer sur web | `app.js:762-764`, `billing-config.js:14` |
| Essai 7 j | legacy sans carte → mur | **Critique** : promesse marketing ≠ réalité ; 0 conversion possible | `entitlements.ts:162-167` |
| Conversion | aucun provider live | **Bloquant business** | Stancer absent, RC inerte |
| Rétention | mécaniques codées mais inertes | Manque relance pré-prélèvement, dunning, e-mails reçus | voir §4 |

---

## 3. Écart « modèle voulu » vs « modèle câblé »

| Élément | Modèle voulu (ta description) | Réalité câblée aujourd'hui |
|---|---|---|
| Essai 7 j | Avec carte, prélèvement auto en fin d'essai | **Sans carte**, aucune conversion, expire en mur (`entitlements.ts`) |
| Prestataire paiement | Stancer (approuvé) | **0 ligne Stancer** ; RevenueCat/Play câblé mais inerte ; Gumroad = doc |
| Paywall | Bloque les non-abonnés | Mode `observe` → **ne bloque personne** |
| Multi-appareils | Achat honoré partout | ✅ **réellement le cas** (entitlement unifié) |
| Relance avant prélèvement | Attendue | **Absente** (aucun cron « essais expirant », aucun e-mail pré-débit) |
| Annulation / gestion | Attendue | Web : **pas de bouton** (`webCustomerPortalUrl:''`) ; natif : deep-link Play OK |

> **Implication n°1 (à retenir absolument)** : ne **jamais** basculer l'enforcement en `enforce`
> tant qu'un chemin de paiement **live** n'existe pas sur chaque surface — sinon les utilisateurs
> heurtent un mur sans pouvoir payer. L'ordre d'allumage est : *brancher le paiement → tester →
> puis enforce*.

---

## 4. Benchmark des meilleurs tunnels au monde

Pratiques de référence (Netflix, Disney+, Spotify, Amazon Prime, Duolingo, Calm/Headspace,
données RevenueCat *State of Subscription Apps*) confrontées à Norva :

| Pratique best-in-class | Qui l'incarne | Norva aujourd'hui |
|---|---|---|
| **Valeur avant compte** (démo/onboarding avant signup) | Duolingo, Spotify (tier gratuit) | ❌ compte exigé d'emblée |
| **Login social** (Google/Apple, 1 tap) | Tous | ❌ web sans OAuth |
| **Assistant d'activation / checklist** | Slack, Notion, Duolingo | ❌ inexistant |
| **« Aha » avant paywall** (payer après avoir vu la valeur) | Duolingo, Calm | 🟠 soft-wall 402 câblé mais off |
| **Sélection du plan pendant l'inscription** | Netflix, Disney+ | 🟠 pricing en landing, mais tunnel cassé |
| **Essai avec rappel avant prélèvement** (J-2) | **Calm/Headspace (référence absolue)**, exigé par Apple/Google | ❌ absent |
| **Compteur d'essai in-app** | Duolingo Super, Calm | 🟠 pill dormante (`app.js:803`) |
| **Push annuel (économie mise en avant)** | Disney+, YouTube Premium | ✅ toggle « Save 30 % » présent |
| **Dunning / relances paiement échoué** | Netflix, Spotify (récupèrent 20-40 % des échecs) | ❌ 1 fenêtre grâce 72 h, pas de retries |
| **E-mails cycle de vie** (bienvenue, reçu, relance, win-back) | Tous | ❌ seuls les mails transactionnels Supabase |
| **Win-back / réactivation** | Netflix (le meilleur au monde) | 🟠 UI expiré/annulé présente mais inerte |
| **Sign-in TV par QR** | Netflix, YouTube, Disney+ | ❌ code + URL à recopier (QR pourtant dispo dans le repo) |
| **Timing des notifications** (au bon moment, avec amorce) | Duolingo | ❌ prompt notif dès le 1ᵉʳ lancement |
| **Preuve sociale** (notes, nb d'utilisateurs, témoignages) | Tous | ❌ avatars stock décoratifs |

**Ce que Norva fait déjà bien :** entitlement multi-appareils unifié, honoré partout ✅ ;
réassurance « cancel anytime » présente ✅ ; plan annuel avec remise ✅ ; parsing Xtream
low-friction (coller un lien) ✅ ; mode hors-ligne mobile soigné ✅.

---

## 5. Focus — l'essai 7 jours → paiement automatique

C'est le cœur de ta demande. Voici l'état + la cible.

**Clarté / réassurance (partiel) :** la copie « you won't be charged until your 7-day trial
ends — cancel anytime » existe (`subscribe.html:194-214`), et le jour-restant est calculé
(`subscription.html:222-230`). ✅ sur le fond, mais **tout est dormant** et **jamais rappelé par
e-mail**.

**Ce qui manque pour un essai → paiement « clair, fluide, rassurant, optimisé » :**

1. **Carte demandée à l'inscription à l'essai** (le mode voulu). Décision structurante :
   - *Sans carte* (mode legacy actuel) → **plus** de démarrages d'essai, **beaucoup moins** de
     conversions, et impose un « second acte » (remettre une carte à la fin) qui tue le taux.
   - *Avec carte* (recommandé pour un service de streaming) → moins de démarrages mais conversion
     bien supérieure, et prélèvement automatique réellement possible.
   → **Recommandation : essai *avec carte* + prélèvement auto**, aligné sur ta cible.
2. **Rappel avant prélèvement (J-2)** — *obligation* Google Play & App Store, et **fortement
   attendu en droit UE/DGCCRF** pour la reconduction. Aujourd'hui : **aucun cron, aucun e-mail**.
   C'est le **levier n°1 anti-frustration/anti-litige** et, contre-intuitivement, il **augmente**
   la LTV (moins de remboursements, moins de chargebacks, plus de confiance).
3. **Compteur d'essai visible + e-mails de cycle** : « essai démarré » (J0), « il te reste 2
   jours » (J5), « bienvenue en payant / reçu » (J7). Le socle DB existe
   (`trial_ends_at`), il manque le **cron « essais expirant »** + les templates Resend
   (Resend est déjà en place pour d'autres mails).
4. **Annulation en 1 clic depuis l'app** (web inclus) : brancher `webCustomerPortalUrl`
   (`billing-config.js:22`) — un chemin d'annulation *facile* réduit les chargebacks et améliore
   la note store.
5. **Conformité** : mentions pré-contractuelles claires (prix TTC, durée, reconduction, droit de
   rétractation déjà traité dans les CGU), double affichage du prix qui sera prélevé, case de
   consentement explicite à l'essai payant. Les pages légales (CM2C, mentions) sont déjà en place.

---

## 6. Recommandations priorisées

### P0 — Débloquer la monétisation (bloquant business)
- **P0.1 — Choisir et brancher l'architecture de facturation** (voir §7). Sans un provider **live**,
  tout le reste est théorique.
- **P0.2 — Ne pas activer `enforce` avant d'avoir un paiement live sur chaque surface.** Garder
  `observe` jusque-là (`entitlements.ts:24, 402-405`).
- **P0.3 — Décider carte/sans-carte pour l'essai** et aligner `NORVA_BILLING_MODE` en conséquence
  (legacy sans-carte = piège actuel).

### P1 — Quick-wins conversion/activation (fort ROI, faible effort)
- **P1.1 — Assistant d'activation post-inscription** : détecter « 0 source » et router vers un
  wizard « Connecte ta source (1/2/3) » au lieu des rails vides (`app.js:41-306` +
  `applyCatalogAvailability:551-565`). **Le plus gros levier d'activation.**
- **P1.2 — Bouton CTA dans les états vides** (« + Ajouter ma source ») au lieu d'un simple texte
  (`app.html:277-279`).
- **P1.3 — Login social Google/Apple** sur `account.html` (Supabase le supporte nativement).
- **P1.4 — QR sur l'onboarding TV** : brancher la capacité QR déjà présente (`pair.html:478-481`)
  sur le flux TV (`cloud-pair.html`) → suppression de la recopie manuelle.
- **P1.5 — E-mail de bienvenue** au signup (Resend déjà en place) avec le premier pas à faire.
- **P1.6 — Preuve sociale réelle** en landing (note, nombre d'utilisateurs, 2-3 témoignages) —
  remplacer les avatars décoratifs (`landing.html:67-78`).

### P2 — Rétention & réduction du churn
- **P2.1 — Cron « essais expirant » + e-mail J-2** (rappel pré-prélèvement) — obligation store +
  levier anti-churn. Socle `trial_ends_at` déjà là.
- **P2.2 — Dunning** : séquence de relance sur paiement échoué (au-delà des 72 h de grâce
  `entitlements.ts:19`) — récupère typiquement 20-40 % des échecs.
- **P2.3 — E-mails de cycle** : reçu de paiement, confirmation de conversion, renouvellement.
- **P2.4 — Gérer REFUND/CHARGEBACK → revoke** (trou actuel `index.ts:164-166`) et le `TRANSFER`.
- **P2.5 — Bouton « Gérer/Annuler » web** (`webCustomerPortalUrl`, `billing-config.js:22`).

### P3 — Optimisation LTV & polish
- **P3.1 — Compteur d'essai in-app** ré-activé et non-dismissible discret (`app.js:800-840`).
- **P3.2 — Durcir `subscribe.html`/`paywall.html` pour le D-pad TV** (charger `tvNavigation.js`).
- **P3.3 — Timing des notifications** (amorce contextuelle au lieu du prompt au 1ᵉʳ lancement,
  `MainActivity.java:140`).
- **P3.4 — Corriger la permission CAMERA runtime** (QR mobile) et le lock portrait tablette.
- **P3.5 — Écrans de valeur natifs** légers (le carrousel `account.html:305-326` existe déjà mais
  est masqué sur web — le réutiliser).
- **P3.6 — Restreindre le SSL bypass** au LAN uniquement (web/TV/mobile).

---

## 7. Architecture de facturation recommandée (Stancer + Play + RevenueCat)

Contrainte incontournable des stores : **sur Android, tout achat de contenu numérique consommé
dans l'app doit passer par Google Play Billing** (le « steering » vers un paiement externe reste
risqué même avec l'assouplissement DMA UE). Sur le **web**, tu es libre — et c'est là que Stancer
prend tout son sens (**pas de taxe store de 15-30 %**, prestataire français, SEPA/CB, conforme UE).

**Le découpage propre :**

| Surface | Rail de paiement | Pourquoi |
|---|---|---|
| **Web** (navigateur) | **Stancer** (ton propre checkout) | 0 taxe store, marge maximale, UX maîtrisée, conforme UE |
| **Android mobile/TV** (achat in-app) | **Google Play Billing** (via RevenueCat, déjà câblé) | Obligation Google ; l'infra native existe déjà |
| **Consolidation** | `cloud_entitlement_projection` (source de vérité unique, déjà en place) | Un achat, quel que soit le rail, ouvre l'accès partout |

> RevenueCat peut orchestrer **les deux** rails (Play + web) et alimenter la projection via un seul
> webhook — l'infra webhook existe déjà (`norva-billing-webhook`). **Alternative** : Stancer alimente
> directement la projection via un `norva-stancer-webhook` (à créer, calqué sur le webhook RC), et
> Play reste géré par RevenueCat. Le choix dépend de si tu veux garder RevenueCat au centre ou non.

**Séquence d'allumage recommandée :**
1. Brancher **Stancer sur le web** (checkout + webhook → projection), en `observe`.
2. Tester un cycle complet : inscription → essai avec carte → J-2 rappel → prélèvement → accès.
3. Poser la **clé RevenueCat** + créer les produits Play (essai P7D) pour le rail natif.
4. Basculer `NORVA_BILLING_MODE` hors legacy + passer l'enforcement en `enforce`.
5. Activer les crons (essais expirant, dunning) et les e-mails de cycle.

---

## 8. Séquencement conseillé (roadmap)

- **Sprint 1 (activation, sans paiement)** : P1.1 assistant d'activation, P1.2 CTA états vides,
  P1.3 OAuth, P1.5 e-mail bienvenue, P1.6 preuve sociale. → **augmente l'activation dès maintenant**,
  indépendamment du paiement.
- **Sprint 2 (paiement web live)** : P0 + §7 étapes 1-2 (Stancer web + essai avec carte + rappel
  J-2). → **première vraie conversion payante.**
- **Sprint 3 (natif + enforce)** : §7 étapes 3-4 (clé RC + produits Play), P3.2/P3.4 polish natif,
  bascule `enforce`.
- **Sprint 4 (rétention)** : P2.2 dunning, P2.3 e-mails cycle, P2.4 refund→revoke, P2.5 portail web,
  P1.4 QR TV.

---

## Annexe — Fichiers clés cités

- Web : `public/landing.html`, `public/account.html`, `public/js/app.js`,
  `public/js/components/SourceManager.js`, `public/subscribe.html`, `public/js/billing.js`,
  `public/js/billing-config.js`, `public/cloud-pair.html`, `public/pair.html`.
- Mobile : `clients/android-phone/app/src/main/java/tv/norva/phone/{MainActivity,NorvaBilling,NorvaApplication}.java`.
- TV : `clients/android-tv/app/src/main/java/tv/norva/tv/{MainActivity,NorvaBilling}.java`,
  `public/js/utils/tvNavigation.js`.
- Backend : `supabase/functions/_shared/entitlements.ts`,
  `supabase/functions/norva-billing-webhook/index.ts`, migrations
  `20260616122103_cloud_entitlements.sql`, `20260622130000_billing_trial_consumed.sql`.
- Docs internes : `docs/roadmap/billing-status.md`, `docs/roadmap/billing-setup.md`,
  `docs/NORVA-WORK-STATUS.md`.
