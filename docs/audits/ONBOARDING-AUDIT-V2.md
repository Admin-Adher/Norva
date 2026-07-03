# Norva — Audit onboarding & tunnel de conversion **V2** (post-implémentation)

> Suite de `ONBOARDING-CONVERSION-AUDIT.md` (V1, l'état « avant »). Ce document (1) **journalise
> tout ce qui a été fait/refait** dans le lot « onboarding », puis (2) **refait l'audit complet**
> — parcours web / Android TV / mobile, du premier atterrissage à l'activation complète, benchmark
> mondial, positionnement, modèle d'abonnement, logique multi-appareils, tunnel de conversion, et
> focus sur l'essai 7 jours → paiement automatique.
>
> **Date : 2026-07-03.** Ancré dans le code (refs `fichier:ligne`) + les changements livrés
> (PR #78, merge `3dc7f80`). Les constats sur les parties **non modifiées** (mobile natif, TV
> « consume », backend billing) restent ceux de l'audit V1, revérifiés.

---

## Partie A — Journal d'implémentation (ce qui a été fait / refait)

Lot livré via **PR #78** (squash `3dc7f80`, mergé sur `main`), déployé (Cloudflare Pages pour le
front, Supabase functions #103 vert pour l'edge). 7 chantiers issus des « manques » de l'audit V1 :

| # | Chantier | Fichiers | État |
|---|----------|----------|------|
| 1 | **Preuve sociale honnête** | `index.html`, `landing.html` | 🟢 **Live**. Faux avatars stock retirés ; section « Built on trust » (6 piliers vrais : annulation, EU/RGPD, chiffrement, paiement sécurisé, opérateur RCS Paris 824 852 081 + médiateur CM2C, transparence) placée **avant le prix** ; gabarit de témoignages commenté (à remplir avec du réel — **aucun faux chiffre**). |
| 2 | **Login social Google/Apple** | `js/authApi.js` (`signInWithOAuth`), `account.html` | 🟡 **Wiring complet, dormant**. Retour OAuth capté par `captureSessionFromUrl()`. Boutons révélés seulement via `OAUTH_PROVIDERS` après config Supabase (Auth → Providers + URL allow-list). Aucun bouton cassé en prod tant que non configuré. |
| 3 | **Assistant d'activation** | `js/pages/HomePage.js` | 🟢 **Live** (existait déjà — l'audit V1 l'avait sous-estimé ; enrichi). Momentum « Account created ✓ · One step to watch », titre bénéfice, réassurance « pas de carte pour connecter ». |
| 4 | **QR sign-in TV** | `cloud-pair.html`, `js/vendor/qrcode.js` (MIT vendorisé) | 🟢 **Live**. La TV affiche un QR scannable (SVG inline CSP-safe) au lieu de la recopie code+URL ; code+URL restent en fallback. |
| 5 | **E-mail de bienvenue** | `_shared/lifecycle-email.ts`, `norva-lifecycle`, migration `20260703160000` | 🟢 **Live + vérifié**. Cron `norva-lifecycle` (jobid 81, `*/15 * * * *`, active) ; run de test **HTTP 200** `{"ok":true,"billing_live":false,"welcome":0}`. Nouveaux comptes accueillis sous 15 min ; base existante (> 72 h) volontairement non spammée. |
| 6 | **Rappel J-2 avant prélèvement** | `_shared/lifecycle-email.ts`, `norva-lifecycle` | 🟠 **Construit, gaté** derrière `NORVA_LIFECYCLE_BILLING_LIVE`. Scanne les essais expirant à ~48 h. Off tant que l'essai n'est pas à carte auto-convertie (sinon « on te prélève » serait faux). |
| 7 | **Dunning + win-back** | `_shared/lifecycle-email.ts`, `norva-lifecycle` | 🟠 **Construits, gatés** (même flag). Dunning 3 paliers/24 h sur `past_due` ; win-back J+3–30 après expiration/annulation. |

**Données** : migration additive `20260703160000_lifecycle_email_tracking.sql` (5 colonnes de
marqueurs d'envoi + 2 index partiels) — **appliquée en live**. `config.toml` enregistre
`norva-lifecycle` (`verify_jwt=false`).

**Templates e-mail prêts mais non branchés** : `renderReceipt` (reçu de paiement) existe dans
`_shared/lifecycle-email.ts` mais n'est pas encore appelé — il doit l'être par
`norva-billing-webhook` sur `INITIAL_PURCHASE`/`RENEWAL` (non modifié : webhook inerte + critique,
à câbler quand le rail paiement sera actif).

**Ce que le lot ne change PAS** (hors périmètre, dépend du rail paiement) : le backend reste en
mode **`legacy`** (essai sans carte qui ne convertit pas) + enforcement **`observe`** (rien n'est
bloqué) ; **aucun prestataire de paiement live** ; **Stancer toujours absent du code**.

---

## Partie B — Audit complet (état post-lot)

### 1. Positionnement, secteur, modèle — le cadre

- **Secteur / positionnement** : lecteur multimédia **BYOC** (*bring-your-own-content*). Norva ne
  vend **aucun** contenu ; l'utilisateur connecte sa propre source Xtream/M3U autorisée. C'est un
  **logiciel par abonnement**, pas un service de contenu — ça change tout l'onboarding : le moment
  d'activation (« aha ») n'est pas « regarder un catalogue prêt » mais **« connecter sa source +
  première lecture réussie »**. C'est le goulot n°1.
- **Modèle d'abonnement** : plans **Norva 4,99 €/mois** (2 flux) et **Norva Family 8,99 €/mois**
  (5 flux), toggle **annuel −30 %** (41,99 € / 75,99 €), **essai gratuit 7 jours** avec passage
  automatique au paiement (cible). Un entitlement, un compte.
- **Multi-appareils** : **entitlement unifié** (`cloud_entitlement_projection`, 1 ligne/user, lue
  par web/TV/mobile via `_shared/entitlements.ts`). Un achat sur n'importe quel appareil ouvre
  l'accès partout. ✅ C'est un vrai atout structurel, déjà en place.
- **Conséquence stratégique** : l'onboarding doit (a) faire atteindre l'« aha » vite (activation),
  (b) déclencher le paywall **après** l'aha (pas avant), (c) vendre là où c'est le plus rentable
  (**web = Stancer sans taxe store** ; **natif = Play Billing obligatoire**), (d) rassurer sur
  l'essai→paiement (rappel, annulation facile) pour limiter churn et litiges.

### 2. Parcours réel par support (post-lot)

#### 2.1 Web — de l'atterrissage à l'activation
- **Atterrissage** (`index.html` racine + `landing.html`) : hero, value prop, pricing (7 j
  d'essai), FAQ, et désormais **preuve sociale honnête** (piliers de confiance avant le prix).
  CTA unique « Create my space » → `/account.html`.
- **Inscription** (`account.html` + `authApi.js`, Supabase) : e-mail + mot de passe (`minlength=6`),
  reset password, vérification e-mail (réglage Supabase). **Login social Google/Apple câblé**
  (dormant jusqu'à config). Manque encore : indicateur de force du mot de passe.
- **Premier lancement** (`app.js` init) : profil (« who's watching ») puis Home. Enforcement
  `observe` → passe tout droit (aucun paywall aujourd'hui).
- **Activation (aha)** (`HomePage.js` setup gate) : compte neuf → **formulaire de connexion inline
  sur Home** (auto-parse du lien Xtream) + **panneau de progression 3 étapes** (Connecter →
  Préparer → Regarder), désormais avec **copy à momentum**. Import en fond → déverrouille
  Live/Movies/Series. C'est un **vrai assistant d'activation** (contrairement à ce que V1 laissait
  entendre).
- **Paywall / abonnement** (`paywall.html`, `subscribe.html`, `subscription.html`, `billing.js`) :
  UI complète (plans, toggle annuel, essai, réassurance « cancel anytime », restore) **mais
  dormante** (`observe`) et **le checkout web ne peut aboutir** (`webBillingEnabled:false`,
  `billing-config.js:12-14`). 🔴 Point de blocage business.
- **Cycle de vie e-mail** : **bienvenue live** ; J-2/dunning/win-back prêts (gatés). Reçu de
  paiement : template prêt, à brancher sur le webhook.

#### 2.2 Android mobile — coquille WebView
- **Wrapper WebView** : splash → **web** `account.html` → gate de connexion **web**. Pas d'écran de
  valeur natif, pas de login natif, pas de paywall natif (`MainActivity.java`).
- **Billing** : code **RevenueCat + Play réel mais inerte** (pas de `REVENUECAT_API_KEY`,
  `NorvaApplication.java:22-26`). Essai 7 j = *free-trial offer* Play (config, pas code).
- **Anti-patterns non corrigés** (hors lot, backlog) : permission **notifications demandée dès le
  1ᵉʳ lancement** ; **CAMERA déclarée mais jamais demandée au runtime** (QR mobile) ; **pas de
  bouton restore natif** ; activité **portrait-lock** sur tablette.
- **Force** : mode hors-ligne natif soigné.
- **Bénéfice du lot pour le mobile** : la preuve sociale, l'activation enrichie et la bienvenue
  passent par la couche web que la WebView charge → **le mobile en hérite gratuitement**. Le QR TV
  ne le concerne pas.

#### 2.3 Android TV — « consume » + QR (nouveau)
- **Appairage** : compte neuf → `cloud-pair.html`. **Nouveau : QR scannable** (fini la recopie
  manuelle) + code/URL en fallback. C'est le principal gain UX du lot côté TV.
- **Entitlement** : la TV **consomme** l'abonnement/essai du compte (acheté sur web/mobile) via la
  SPA partagée. ✅ Synchro multi-appareils réelle.
- **Vente on-device** : câblée (Play/RevenueCat) mais inerte ; `subscribe.html`/`paywall.html` **non
  durcis pour le D-pad** (n'chargent pas `tvNavigation.js`) → à améliorer.
- **Sécurité** : `onReceivedSslError → proceed()` inconditionnel (backlog).

#### 2.4 Backend abonnement / essai / entitlement
- **Source de vérité unique** (`cloud_entitlement_projection`) lue par toutes les plateformes ✅.
- **Mode `legacy`** : essai 7 j **sans carte** auto-accordé qui **ne convertit pas** → expire en
  **mur** (`_shared/entitlements.ts`). **Enforcement `observe`** → rien n'est bloqué.
- **RevenueCat webhook** implémenté mais **inerte** (secret non posé). **Stancer : 0 référence.**
- **Nouveau (lot)** : marqueurs de cycle + fonction `norva-lifecycle` (bienvenue live ; J-2/dunning/
  win-back gatés `NORVA_LIFECYCLE_BILLING_LIVE`).

### 3. Tunnel de conversion (before → after)

| Étape | Avant lot | Après lot | Reste |
|---|---|---|---|
| Landing → inscription | pas de preuve sociale | **piliers de confiance** avant le prix | témoignages réels ; démo |
| Inscription | e-mail/mdp seul | **OAuth câblé** (dormant) | activer OAuth ; force mdp |
| Activation (source) | gate existant (sous-estimé) | **copy à momentum** | — (déjà solide) |
| Bienvenue | aucun e-mail | **e-mail de bienvenue live** | — |
| 1ʳᵉ lecture (aha) | soft-wall 402 câblé, off | inchangé (off en observe) | brancher après paiement |
| Paywall | dormant | dormant | **rail paiement (Stancer)** |
| Essai 7 j | sans carte → mur, aucun rappel | **rappel J-2 construit** (gaté) | essai à carte + activer |
| Conversion | aucun provider live | inchangé | **Stancer / Play live** |
| Churn (relances) | rien | **dunning + win-back construits** (gatés) | activer + reçu webhook |
| Sign-in TV | recopie code+URL | **QR scannable** | durcir D-pad subscribe |

**Lecture** : le lot a comblé **l'acquisition/activation/rétention côté UX & e-mail**. Le
**cœur monétisation** (paywall actif, essai→paiement réel, conversion) reste **bloqué par l'absence
de rail de paiement live** — c'est le prochain jalon (Stancer).

### 4. Benchmark mondial (rafraîchi)

Confronté aux meilleurs (Netflix, Disney+, Spotify, Amazon Prime, Duolingo, Calm/Headspace, data
RevenueCat *State of Subscription Apps*) :

| Pratique best-in-class | Réf | Norva **avant** | Norva **après lot** |
|---|---|---|---|
| Preuve sociale (confiance) | Tous | ❌ avatars stock | 🟢 piliers vrais (témoignages réels à venir) |
| Login social 1-tap | Tous | ❌ | 🟡 câblé (dormant) |
| Assistant d'activation | Slack, Duolingo | 🟠 (sous-estimé) | 🟢 gate + momentum |
| E-mail de bienvenue | Tous | ❌ | 🟢 live |
| Sign-in TV par QR | Netflix, YouTube, Disney+ | ❌ | 🟢 QR |
| Rappel essai J-2 avant débit | **Calm/Headspace (réf)**, requis Apple/Google | ❌ | 🟠 construit (gaté) |
| Dunning (récupère 20-40 % des échecs) | Netflix, Spotify | ❌ | 🟠 construit (gaté) |
| Win-back / réactivation | Netflix | 🟠 UI inerte | 🟠 e-mail construit (gaté) |
| Reçu / confirmation paiement | Tous | ❌ | 🟡 template prêt (à brancher webhook) |
| « Aha » avant paywall | Duolingo, Calm | 🟠 soft-wall câblé | 🟠 inchangé (off) |
| Plan annuel (économie) | Disney+, YT | 🟢 | 🟢 |
| Cancel-anytime rassurant | Tous | 🟢 | 🟢 |
| Compteur d'essai in-app | Duolingo, Calm | 🟠 dormant | 🟠 dormant (dépend enforce) |
| Valeur avant compte / démo | Duolingo, Spotify | ❌ | ❌ (backlog) |

**Toujours devant Norva sur** : la démo/valeur-avant-compte, l'onboarding **natif** mobile, le
durcissement TV, et surtout **la conversion réelle** (aucun paiement live).

### 5. Focus — essai 7 jours → paiement automatique

Critères demandés : **clair, fluide, rassurant, optimisé conversion, limitant annulations &
frustration.**

| Critère | État après lot | Verdict |
|---|---|---|
| **Clair** | Copie « essai 7 j… converti sauf annulation… on t'envoie un rappel avant » sur landing + subscribe ; jour-restant calculé | 🟢 sur le fond (dormant tant que paywall off) |
| **Fluide** | Activation guidée + entitlement unifié multi-appareils ; checkout web **non abouti** | 🟠 bloqué par le rail paiement |
| **Rassurant** | « cancel anytime » partout + **rappel J-2 construit** + opérateur/médiateur affichés | 🟢 dès activation du rail |
| **Optimisé conversion** | Décision structurante à trancher : **essai AVEC carte** (recommandé, permet le prélèvement auto) vs sans carte (legacy actuel, ne convertit pas) | 🔴 à décider + brancher |
| **Limite annulations/frustration** | Rappel J-2 (anti-surprise, **obligation Apple/Google**, attendu UE/DGCCRF) + annulation à brancher (`webCustomerPortalUrl` vide) | 🟠 construit, à activer |

**Conclusion essai** : la **mécanique anti-frustration est maintenant écrite** (rappel J-2, dunning,
copie honnête, médiateur). Il manque **l'essentiel** : (1) un **essai à carte** (mode cible), (2) un
**rail de paiement live** pour que le prélèvement auto existe vraiment, (3) l'**activation du flag**
`NORVA_LIFECYCLE_BILLING_LIVE` + le **portail d'annulation** web. Sans (1)+(2), l'essai actuel
reste un cul-de-sac (legacy sans carte → mur).

### 6. Écart résiduel & priorités

**P0 — débloquer la monétisation (bloquant business)**
- Brancher un **rail de paiement web live = Stancer** (checkout + webhook → projection).
- Trancher **essai AVEC carte** + sortir du mode `legacy`.
- **Ne passer `enforce`** qu'une fois un paiement live sur chaque surface.

**P1 — activer l'existant (déjà construit, il suffit d'allumer)**
- `NORVA_LIFECYCLE_BILLING_LIVE=true` → J-2 + dunning + win-back.
- Brancher `renderReceipt` sur `norva-billing-webhook` (reçu/renouvellement).
- Brancher `webCustomerPortalUrl` → bouton « Gérer/Annuler » web.
- Activer **OAuth** (config Supabase + `OAUTH_PROVIDERS`).
- Remplir la section **témoignages** avec du réel.

**P2 — polish & natif**
- Durcir `subscribe.html`/`paywall.html` pour le **D-pad TV**.
- Mobile : **timing notifications** (amorce au bon moment), **fix CAMERA runtime**, **bouton restore
  natif**, lever le **portrait-lock** tablette.
- Restreindre le **SSL bypass** au LAN.
- **Démo/valeur avant compte** (réduire la friction du « compte d'emblée »).

### 7. Scorecards (before → after)

| Surface | Avant lot | Après lot |
|---|---|---|
| **Web** | acquisition OK, monétisation à zéro, activation non « vendue » | + preuve sociale, + OAuth câblé, + bienvenue, activation à momentum ; monétisation toujours bloquée (paiement) |
| **Mobile** | coquille WebView, 0 onboarding natif | hérite du web (social proof/bienvenue/activation) ; natif inchangé |
| **TV** | recopie code+URL | **QR** ; « consume » inchangé ; D-pad subscribe à durcir |
| **Backend** | source unique ✅, legacy/observe, 0 paiement | + cron cycle de vie (bienvenue live, reste gaté) ; legacy/observe/0 paiement inchangés |

---

## Partie C — Prochaine étape : Stancer (le déblocage)

Tout le reste est prêt ou construit ; **le seul verrou est le rail de paiement**. Stancer
(prestataire français, SEPA/CB, conforme UE, **0 taxe store sur le web**) débloque en cascade :
essai→paiement réel, paywall actif, J-2/dunning/reçus, portail d'annulation.

**Architecture cible** : **Web = Stancer** (checkout propre, marge max) ; **Android mobile/TV =
Google Play Billing** (obligation) ; **consolidation = `cloud_entitlement_projection`** (déjà là).

**Séquence** : Stancer web (essai à carte + rappel J-2) → tester un cycle complet → clé RevenueCat +
produits Play → `NORVA_LIFECYCLE_BILLING_LIVE=true` + `enforce` → brancher reçu webhook + portail
d'annulation.

*(Détail architecture/roadmap : `ONBOARDING-CONVERSION-AUDIT.md` §7-§8.)*
