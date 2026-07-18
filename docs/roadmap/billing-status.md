# Norva Billing — État & reprise

> **But de ce fichier** : mémoriser tout ce qui a été mis en place et tout ce
> qu'il reste à faire, pour **reprendre sans rien re-découvrir** une fois les
> comptes externes (Play Console, Stripe, RevenueCat) disponibles.
>
> - **Où on en est** = ce fichier.
> - **Comment finir** (procédures détaillées) = [`docs/roadmap/billing-setup.md`](./billing-setup.md).
>
> _Dernière mise à jour : 2026-07-18 (tarification dynamique & promos — voir la
> mise à jour datée ci-dessous)._

---

## TL;DR — reprendre ici

Toute l'infra de facturation est **construite et déployée**, en **mode `legacy`**
(essai actuel sans carte → **aucun changement de comportement** tant qu'on ne
bascule pas). Pour passer en production :

1. Obtenir les comptes externes (entreprise validée → Play Console + Stripe → RevenueCat).
2. Suivre `docs/roadmap/billing-setup.md`.
3. Coller 3 tokens + déployer.
4. Basculer `NORVA_BILLING_MODE=revenuecat`.

Branche de dev : **`claude/eager-carson-2zlqwy`**.
Projet Supabase : **`oupsceccxsonaalhueff`**.

---

## 💵 MISE À JOUR 2026-07-18 — tarification dynamique, promos & durcissement upsell (LIVE)

> Détail complet : [`2026-07-18-session-log.md`](./2026-07-18-session-log.md).
> Tout est **déployé et vérifié** (box + Pages). À savoir pour ne pas re-découvrir :

- **Les prix web ne sont PLUS codés en dur** : source unique `billing_prices`
  (base + promo optionnelle avec événement → badge et échéance auto-désactivante),
  lue par les edge via `_shared/prices.ts` (cache 60 s, repli `DEFAULT_PRICES`)
  et par le front via `GET norva-revolut/prices` (public). Modifier un tarif ou
  lancer une promo = carte **« 💵 Tarifs web » de Finance** (2 clics). Les abonnés
  existants gardent leur prix souscrit (le cron débite le mapping, jamais le
  catalogue) ; `/checkout` stampe le montant dans les metadata de l'ordre
  (équité si la promo finit en cours de saisie). Visuel de campagne plein écran
  uploadable (bucket public `promo-assets`). Rail Play hors périmètre (promos
  dans la Play Console).
- **Durée des promos = « N premières périodes »** (décision produit) : champ 🔁
  sur chaque promo (conseillé 3 en mensuel, 1 en annuel ; vide = à vie, réservé
  early-bird). Le mapping client mémorise `base_amount_cents` +
  `promo_cycles_left` ; le cron décompte à chaque encaissement et rebascule au
  prix de base à épuisement. Disclosure légale « then $X » sur vente, checkout
  et landing. Les abonnés promo engagés avant restent à vie (pas de changement
  de termes rétroactif).
- **Upsell mensuel→annuel durci** (audit 26 agents, 21 constats confirmés) :
  plan_change commité uniquement à l'ordre PAYÉ, MRR annuel /12 partout,
  `PRODUCT_CHANGE` → ledger `plan_change` (exclu conversions/TVA), remplacement
  Play natif (`WITH_TIME_PRORATION`), textes UI honnêtes, grants manuels (VIP
  2099) inécrasables, plan courant marqué sur la page tarifs, upsell annuel avec
  économie réelle affichée.
- **Piège d'exploitation documenté** : un asset front « impossible à mettre à
  jour » chez un client = copie immutable-cachée sous une URL hashée (le fetch du
  service worker ignore Disable cache) → **modifier le fichier suffit** (nouveau
  hash = éviction universelle). Cf. épilogue du journal 2026-07-18.

## ⚠️ MISE À JOUR 2026-07-01 — réalité high-risk & pivot Gumroad (hybride)

> **À lire avant tout le reste de ce fichier.** Le plan « RevenueCat + Stripe/Web
> Billing » ci-dessous **reste valable pour la moitié MOBILE** (Play/Apple), mais
> le **rail WEB change** : Stripe n'est plus l'option, on passe par **Gumroad**.

**Norva est classé HIGH-RISK par les processeurs de paiement.** L'IPTV est
refusée par la quasi-totalité des acquéreurs « self-serve » :

- **Stripe** et **Paddle** refusent l'IPTV ([Paddle AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)).
- **Lemon Squeezy** le **bannit explicitement** ([produits interdits](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products)).
- **Seul Gumroad** accepte ce type de produit.

**Blocage architectural** : **RevenueCat n'intègre PAS Gumroad**. Les moteurs de
paiement web de RevenueCat = **Stripe + Paddle uniquement**
([RevenueCat payment integrations](https://www.revenuecat.com/docs/web/payment-integrations)).
Donc **« RevenueCat + Gumroad » est IMPOSSIBLE**.

### Nouvelle archi recommandée = HYBRIDE

- **MOBILE (Play / Apple)** → **RevenueCat** : pas de refus high-risk ici, ce sont
  **Google / Apple** qui encaissent. → toute l'infra RC existante (dormante)
  **reste valable** pour ce rail.
- **WEB** → **Gumroad DIRECT** (sans RevenueCat).
- Les **deux rails écrivent dans la MÊME table `cloud_entitlement_projection`**,
  déjà conçue **agnostique de la source** → aucune refonte du modèle d'entitlements.

### Analyse des frais Gumroad → annuel-first indispensable

Frais Gumroad ≈ **10 % + 0,50 $ + 2,9 % + 0,30 $** (soit ~**0,80 $ fixe** + ~12,9 %).
Les 0,80 $ fixes **tuent les petits mensuels** :

| Plan | Prix | Frais Gumroad estimés | Part des frais |
|---|---|---|---|
| Mensuel | 4,99 | ~1,44 (≈ 0,80 fixe + 12,9 %) | **~29 %** |
| Annuel | ~49,90 | ~7,2 (≈ 0,80 fixe + 12,9 %) | **~15 %** |

→ **Annuel-first indispensable** : les 0,80 $ fixes rendent les petits mensuels
non rentables ; il faut pousser l'abonnement annuel.

### Option : rail CRYPTO secondaire

Rail **crypto** possible (**BTCPay / NOWPayments**, ~**0,5–1 %**, **zéro
chargeback**) alimentant la **même projection** `cloud_entitlement_projection`.

### 📌 STATUT — EN PAUSE

Le billing est **EN PAUSE** en attente de la **décision processeur/frais de
l'owner** (Gumroad annuel-first ± crypto, ou une alternative). L'**infra RC
existante reste DORMANTE** (valable pour la moitié mobile) ; la **projection
d'entitlements est prête pour n'importe quelle source**.

---

## 🔒 DÉCISION 2026-07-06 — RevenueCat au lancement, in-house en option future

**Décision : on garde RevenueCat pour le rail MOBILE au lancement.** Pas de
réécriture maintenant — l'APK (SDK RevenueCat) + le webhook serveur
(`norva-billing-webhook`) sont déjà **100 % câblés**. Internaliser aujourd'hui
coûterait de l'ingénierie pour économiser **0 $** (RevenueCat est gratuit
jusqu'à ~2 500 $/mois de CA suivi — vérifier leur grille à jour).

### Pourquoi garder la porte ouverte (vision owner)
Le « tout en interne » a une vraie valeur long terme : marge (pas de % prélevé),
contrôle total des données de revenu, valorisation plus élevée (moins de
dépendance tierce en due diligence). Vision **légitime** → la migration reste un
objectif futur, pas un tabou.

### Nuances actées (pour trancher juste le jour venu)
- Le gros de la « taxe » mobile, c'est **Google (~15 % < 1 M$/an, 30 % au-delà)**,
  **pas RevenueCat (~1 %)**. Retirer RevenueCat économise ~1 %, pas 15-30 %.
- Le **cerveau** du billing est **déjà interne** (`_shared/entitlements.ts`,
  `cloud_entitlement_projection`, trial/limites). RevenueCat n'est qu'une couche
  de validation reçus + webhook → **pas de lock-in profond**, la projection est
  agnostique de la source.
- Le « tout maison » n'est **pas** un one-time : maintenance perpétuelle
  (changements d'API Google/Apple, RTDN, grâce, proration, retries, fraude,
  remboursements) — exactement ce que RevenueCat absorbe.
- Cohérence : le rail **WEB est déjà hors RevenueCat** (Stancer / cf. pivot
  Gumroad ci-dessus) → internaliser le mobile plus tard est cohérent avec la
  vision, pas un virage.

### 🎯 Déclencheur de bascule (quand ré-ouvrir le sujet)
Ré-évaluer l'internalisation **mobile** quand **les deux** sont vrais :
1. **Économique** — le coût annuel RevenueCat dépasse durablement le coût
   (build + maintenance/an) du rail interne. Proxy : CA mobile suivi
   **> ~25-50 k$/mois de façon stable** (→ RevenueCat ~250-500 $/mo ; à ce
   niveau le ~1 % commence à justifier l'effort).
2. **Capacité** — bande passante d'ingénierie réelle pour porter la maintenance
   perpétuelle (pas seulement le build).

Tant qu'**un** des deux manque → **on reste sur RevenueCat**.

### Portée de l'internalisation (pour chiffrage au moment du déclencheur)
- **Android** : remplacer le SDK RevenueCat dans `NorvaBilling.java` (×2 apps) par
  **Google Play Billing Library** brute ; remplacer `norva-billing-webhook` par un
  **consommateur RTDN (Google Cloud Pub/Sub)** + **validation Play Developer API**
  (Service Account). La projection ne change pas.
- **iOS (plus tard)** : App Store Server API + App Store Server Notifications v2.
- **Web** : déjà interne (Stancer).

_Chiffrage détaillé (fichiers, effort, risques) à produire le jour du déclencheur._

---

## Modèle d'abonnement (décidé 2026-06-22)

- **Essai 7 j avec carte** (Play : moyen de paiement du compte Google ; Web : carte via RC Web Billing/Stripe). Conversion auto sauf annulation. **Pas de palier gratuit permanent payant** — mais un palier `free` de navigation (voir ci-dessous).
- **Soft wall** : signup (sans carte) → onboarding « connecte ta source » → browse libre → **au 1er play** → écran subscribe (plan + période + carte) → essai. **Aucun aperçu gratuit** (play = mur).
- **Palier `free`** (décision *calculée*, jamais stockée en base) : browse + 1 source, `concurrent_streams: 0`. Sans abo / essai expiré / abo expiré → `free` (browse), **pas** bloqué → l'utilisateur retombe en browse libre à l'expiration.
- **Garde-fous** : tout ça est **dormant** tant que `NORVA_ENTITLEMENTS_MODE != enforce` OU `NORVA_BILLING_MODE != revenuecat`. Bascule = clés AVANT le flip (runbook §10).

### Phase 1 (socle soft wall) — FAIT (commité, dormant)
- `_shared/entitlements.ts` : palier `free` + `softDeny`/`freeBrowseDecision` (refus doux → `free` en mode revenuecat ; blocages durs fraude/revoked/billing_unverified inchangés).
- `public/js/api.js` : 402 lecture/capacité → `subscribe.html` (helper `routeToSubscribeWall` + wrap de `createSession`, car le play bypasse `API.request`).
- `public/js/pages/Settings.js` : bouton plan → `subscribe.html` (web + natif).
- `public/subscribe.html` : message contextuel quand on arrive du mur.
- Bumps cache app.html : api.js v52, Settings.js v13, cloudApi.js v24.
- **Pas de migration** (le palier `free` n'est jamais écrit → contrainte `plan_code` inchangée).
- ⏳ Pas encore déployé ; nécessitera un redéploiement `norva-cloud` + `norva-playback`.

### Phase 2 (essai : confirmation + compteur) — FAIT (dormant, conditionné à `enforced`)
- `subscribe.html` : panneau **« essai démarré »** au succès (accès complet, pas de débit avant la fin, annulable) au lieu d'un auto-redirect → anti-surprise/chargeback.
- `app.js` : `maybeShowTrialBanner()` → bandeau **« J-N restants »** dismissable, **uniquement si l'essai est enforced** (dormant en observe).
- `Settings.js` : carte d'accès montre **jours restants + date de renouvellement** en essai enforced.
- Bumps : app.js v18, Settings.js v14.

### Phase 3 (polish TV) — FAIT
- `subscribe.html` : classe `html.tv` (UA Android TV) → cibles agrandies (toggle, boutons, cartes) + **focus ring D-pad** (`:focus-visible`, `card:focus-within`).

### Phase 4 (gestion d'abo + anti-churn) — FAIT (dormant, conditionné à `enforced`)
- **`public/subscription.html`** (NOUVEL écran) : gestion de l'abo par statut — essai (J-N), actif, **annulé** (finit le DATE / Resume), **paiement échoué/grâce** (Update payment), aucun/expiré (**Resubscribe / win-back**). Bouton Manage/cancel = deep-link **Google Play** (natif) ou **portail web** (`NorvaBilling.manageUrl` → `webCustomerPortalUrl`).
- `subscribe.html` : garde **« déjà abonné »** (raccourci vers `subscription.html`, évite le double achat) + **message du mur contextuel** (essai terminé / abo expiré / limite de flux / 1ᵉʳ abonnement).
- `app.js` : **bannière « paiement échoué »** (jumelle du compteur d'essai) → `subscription.html`, dormant en observe.
- `Settings.js` : « Manage plan » → `subscription.html` si abo actif, sinon `subscribe.html`.
- Bumps : app.js v20, Settings.js v17, billing*.js v2, `subscription.html` (nouveau). **Déployé** (web).
- ⚠️ **Manque connu non bloquant** : webhook `TRANSFER` (fusion de comptes) non géré ; pas de splash marketing plein écran « essai terminé » (couvert par l'écran de plans contextuel).

### #5 Onboarding « connecte ta source » — DÉJÀ EXISTANT (pas de build)
- `HomePage.js` a un *setup gate* (`shouldShowSetupGate` → `renderSetupConnectionGate`) qui affiche déjà, pour un nouveau compte sans source, un écran « Norva setup » + formulaire de connexion (lien Xtream/M3U). Le 1ᵉʳ audit (« home vide ») était inexact.

### Reste pour plus tard
- Au moment de la bascule billing : pass de copy soft-wall sur le setup gate (« browse libre / essai pour regarder ») + test e2e du compteur/confirmation avec RevenueCat branché.

### Phase 5 (UI billing — audit P1/P2/P3 tablette + Android TV) — 2026-07-06 — FAIT & DÉPLOYÉ (web)
> 4 pages billing publiques (`subscribe.html`, `checkout.html`, `subscription.html`,
> `paywall.html`). Tout vérifié en headless (Chromium — CSS calculée + vrais IIFE des
> pages avec billing stubé + vrai encodeur QR) puis live-confirmé sur `norva.tv`.

- **P1** — modale d'annulation accessible (focus-trap / restore focus / Escape / backdrop,
  re-focus après re-render) **remplaçant `window.confirm()`** ; clarté devise ($ affiché
  vs hold « $0.50 » qui « peut apparaître dans ta devise locale ») ; **« Restore purchases »
  masqué** sur le rail Stancer web (restore n'a de sens que natif Play / RC Web).
- **P2 mobile** — annulation en **bottom-sheet** sur téléphone (dock bas, coins arrondis,
  barre d'actions sticky, `sheet-up`) ; **timeline de facturation** au checkout (Today $0.00
  card check only / After 7-day trial <prix> / Cancel anytime — nothing charged) + **bouton
  fallback** pleine page proéminent.
- **P2 tablette** — checkout : breakpoint relevé 760→900px (formulaire carte pleine largeur
  sur tablette portrait) + **logos Visa/Mastercard** honnêtes ; subscription : **carte statut
  + rail d'actions côte à côte** à ≥760px (wrap 560→860px) ; subscribe : bandeau **« Why
  Family? »** (2 vs 5 flux) + logos paiement (Stancer web only).
- **P3 Android TV** — checkout : **iframe carte → QR « finir sur ton téléphone »** (réutilise
  `js/vendor/qrcode.js`, SVG inline CSP-safe) + **polling `/confirm`** (l'essai démarre sur la
  TV dès que le paiement téléphone aboutit) + échappatoire « payer sur cette TV » ; Play
  Billing reste **prioritaire** (subscribe route déjà le natif vers Google) ; subscription :
  **annulation simplifiée** (confirm unique, plus de radios multi-étapes / contre-offre au
  D-pad — flux complet préservé sur web/mobile, past-due préservé) ; styles TV explicites
  (paywall + checkout + modale) + détection TV ajoutée à checkout/paywall.
- **Commits** (branche `main`) : `f0bb53f` (P2 mobile), `4608f46` (P2 tablette + P3 TV) ;
  P1 + P2 checkout breakdown poussés plus tôt dans la même session.
- ⏳ **Reste dépendant du matériel** (ne se confirme pas en headless) : scan-to-pay réel du QR
  sur un téléphone → essai qui démarre sur la vraie Android TV ; Play Billing de bout en bout.
  → à valider avec une **vraie Android TV + compte Stancer/Play réel** (cf. `play-console-setup.md`).

---

## 🎬 Plan d'activation (jour J — allumer le billing)

> Tout le code du tunnel est **dormant** derrière 2 flags. « La bascule » = les
> passer de dormant à actif. **Rien à coder** ce jour-là : poser les clés,
> flipper, redéployer, tester.

### Les 2 interrupteurs (secrets Supabase)
| Flag | Dormant (auj.) | Actif | Effet |
|---|---|---|---|
| `NORVA_ENTITLEMENTS_MODE` | `observe` | `enforce` | observe = **rien n'est bloqué** (accès complet pour tous, limites ignorées). enforce = limites appliquées (palier `free` bloque le play, compteur d'essai, expiration). |
| `NORVA_BILLING_MODE` | `legacy` | `revenuecat` | legacy = essai auto **sans carte**. revenuecat = plus d'auto-trial ; sans abo → `free` (browse) ; essais/abos via RevenueCat. |

### ⚠️ Règle d'or — l'ORDRE est critique
**Ne jamais flipper les flags avant que les achats marchent ET soient testés.**
Sinon un nouvel user tombe en `free` → veut lire → mur subscribe → « billing non
configuré » → **coincé** (browse mais jamais lire, et ne peut pas s'abonner).
→ Clés + produits RevenueCat/Play/Stripe **prêts et testés en sandbox AVANT** le flip.

### Étapes (dans l'ordre)
1. **Prérequis** : RevenueCat + produits Play + Stripe en place ; secrets posés :
   `NORVA_REVENUECAT_WEBHOOK_AUTH`, (`NORVA_RC_PRODUCT_MAP`), `REVENUECAT_API_KEY`
   (Android), clé Web Billing **+ `webCustomerPortalUrl`** dans `billing-config.js`. Cf. `billing-setup.md` §3-8.
2. **Redéployer** `norva-cloud` + `norva-playback` (ils portent le code soft-wall
   pas encore déployé) :
   `supabase-go functions deploy norva-cloud norva-playback --project-ref oupsceccxsonaalhueff`
3. **Tester en sandbox PENDANT qu'on est encore en `observe`** (vrais users non
   impactés) : achat test Play + web → le webhook écrit la projection
   (`cloud_entitlement_events` + `cloud_entitlement_projection`), bouton Subscribe OK.
4. **Flipper** (secrets Supabase) : `NORVA_BILLING_MODE=revenuecat` **puis**
   `NORVA_ENTITLEMENTS_MODE=enforce`, et **redéployer** norva-cloud/playback pour
   recharger l'env.
5. **Test e2e prod** (compte test) : signup → connecte source → browse → 1er play
   → mur subscribe → essai → écran « essai démarré » → compteur J-7 → conversion
   auto / annulation → retour `free`. Tester aussi restore + double-essai bloqué,
   l'écran **gestion d'abo** (`subscription.html`) et le **win-back** (compte expiré
   → Resubscribe).
6. **Pass de copy soft-wall** : setup gate Home (« browse libre / essai pour
   regarder ») + cohérence des messages une fois `enforce` actif.

### 🧑‍🤝‍🧑 Décision rollout (à prendre le jour J)
Au flip `enforce`, **les utilisateurs actuels** (accès complet gratuit en observe)
basculent vers leur vrai droit → sans abo = `free` (browse, plus de lecture).
Choisir :
- **Grandfather** : leur offrir un essai/grâce de courtoisie (ex. insérer une
  projection `trialing` à +N j pour les comptes existants), ou
- **Communiquer** : bandeau « ton essai démarre » / « abonne-toi pour continuer ».

### Rollback
En cas de souci : repasser `NORVA_ENTITLEMENTS_MODE=observe` (réouvre tout
immédiatement) + redeploy. Le code soft-wall redevient dormant sans rien casser.

---

## ✅ Fait & DÉPLOYÉ sur le live

### Base de données (Supabase `oupsceccxsonaalhueff`)
- [x] Migration `trial_consumed_at` sur `cloud_entitlement_projection` (appliquée,
  colonne `timestamptz` confirmée). Anti-abus cross-rail keyé au compte.

### Edge functions (déployées)
- [x] **`norva-billing-webhook`** v1 — `verify_jwt=false`, idempotent, mappe les
  events RevenueCat → projection. Renvoie **401 tant que le secret n'est pas mis**
  (c'est voulu). URL :
  `https://api.norva.tv/functions/v1/norva-billing-webhook`
- [x] **`norva-cloud`** v38 — endpoint `GET /billing/trial-eligibility`, flag
  `NORVA_BILLING_MODE` (défaut `legacy`), `billingMode` dans `/health`.
- [x] **`norva-playback`** v36 — redéployé (partage `_shared/entitlements.ts`).

> Vérifié : `GET /functions/v1/norva-cloud/health` → `"billingMode":"legacy"`.

### Code (commité + poussé sur `claude/eager-carson-2zlqwy`)
| Commit | Contenu |
|---|---|
| `c8ec882` | Pricing 2 plans parité + toggle mensuel/annuel −30% (landing + index) |
| `e94cc6d` | Webhook (squelette) + migration `trial_consumed_at` |
| `056d41b` | Runbook + endpoint trial-eligibility + flag billing-mode |
| `fc46729` | Client web `billing.js` + `subscribe.html` + entrée Settings |
| `ba1dc9f` | Natif Android (phone + TV) : SDK RevenueCat + bridge Play Billing |
| `99c54cc` | Webhook autonome (`limits:{}` normalisé à la lecture) |

---

## 🟡 Prêt dans le repo mais INERTE jusqu'aux tokens

Ces morceaux sont en place mais ne s'activent qu'une fois les clés fournies
(tout est **gardé** → rien ne casse en attendant) :

- **Mode legacy** : `NORVA_BILLING_MODE` non défini = `legacy` → l'essai 7 j
  **sans carte** auto-démarre comme avant. Bascule en `revenuecat` à la toute fin.
- **Web** : `public/js/billing.js` (abstraction) + `public/js/billing-config.js`
  (clé vide → web billing désactivé) + `public/subscribe.html` (écran d'achat).
- **Natif** : `NorvaBilling.java` + `NorvaApplication.java` + méthodes bridge
  (`billingLogin`/`purchase`/`restore`) dans les 2 apps. SDK non initialisé tant
  que `REVENUECAT_API_KEY` est vide → l'app tourne, billing « indisponible ».
- **Settings** : le bouton devient « Subscribe » en natif **uniquement** quand
  l'APK expose le bridge `purchase` (sinon masqué comme aujourd'hui).

---

## 📋 Checklist de reprise (ordonnée)

> ⚠️ **Depuis le pivot du 2026-07-01** : cette checklist concerne désormais
> surtout le **rail MOBILE (RevenueCat / Play)**. Le **rail WEB passe par
> Gumroad** (pas RevenueCat) — à documenter séparément une fois la décision de
> l'owner prise (cf. section « MISE À JOUR 2026-07-01 » en haut).

> Réfs `§` = sections de `docs/roadmap/billing-setup.md`.

### Phase 1 — Comptes externes (entreprise validée)
- [ ] Créer le compte **Google Play Console** + 2 apps : `tv.norva.phone`, `tv.norva.tv`
- [ ] Créer les abonnements Play (§4.2) :
  - [ ] `norva_plus` → base plans `monthly` (4,99) + `annual` (41,99) + offre essai 7 j
  - [ ] `norva_family` → base plans `monthly` (8,99) + `annual` (75,99) + offre essai 7 j
- [ ] **Service Account JSON** Play (§4.3)
- [ ] Compléter **Stripe** (infos entreprise/bancaires)

### Phase 2 — RevenueCat (§3)
- [ ] Créer le projet : `Norva` / `Media & Video` / `Google Play` + `Web (RevenueCat Billing)`
- [ ] Ajouter les apps : 2× Play (`tv.norva.phone`, `tv.norva.tv`) + 1× Web Billing (connecter Stripe)
- [ ] Entitlement unique : **`pro`**
- [ ] Importer les produits → **attacher chacun à `pro`**
- [ ] Offering par défaut, 4 packages :
  - [ ] `$rc_monthly` → `norva_plus:monthly`
  - [ ] `$rc_annual` → `norva_plus:annual`
  - [ ] `family_monthly` → `norva_family:monthly`
  - [ ] `family_annual` → `norva_family:annual`
- [ ] Webhook : URL ci-dessus + header `Authorization` = un secret (à recopier en §3 ci-dessous)
- [ ] Récupérer les **clés publiques** : Android (Play) + Web Billing

### Phase 3 — Coller les tokens
- [ ] Supabase secret **`NORVA_REVENUECAT_WEBHOOK_AUTH`** = le secret du webhook
- [ ] (optionnel) Supabase secret **`NORVA_RC_PRODUCT_MAP`** =
      `{"norva_plus:monthly":"plus","norva_plus:annual":"plus","norva_family:monthly":"family","norva_family:annual":"family"}`
- [ ] Android : **`REVENUECAT_API_KEY`** dans `clients/android-phone/gradle.properties`
      + `clients/android-tv/gradle.properties` (ou secret CI) (§7)
- [ ] Web : éditer **`public/js/billing-config.js`** → `revenueCatWebPublicKey` + `webBillingEnabled: true` (§8)
- [ ] Web : **`webCustomerPortalUrl`** dans `billing-config.js` = lien portail client
      (RevenueCat customer center / Stripe billing portal) → fait marcher le bouton
      « Manage/cancel » de `subscription.html` sur le web. (Android = deep-link Play, déjà câblé.)

### Phase 4 — Tester
- [ ] RevenueCat → **Send test event** → doit passer `200 OK` (ligne dans `cloud_entitlement_events`)
- [ ] Achat **sandbox Play** (compte testeur) → accès débloqué
- [ ] Achat **web** (carte test Stripe) → même compte, accès partout
- [ ] **Restore purchases** (réinstall APK) → accès retrouvé
- [ ] **Double essai bloqué** (essai Play puis tentative web) → refusé
- [ ] **Gestion d'abo** (`subscription.html`) : états essai / actif / annulé / paiement
      échoué / expiré ; bouton Manage ouvre Play (natif) ou le portail (web) ; bannière
      « paiement échoué » s'affiche en `past_due`
- [x] **Version du SDK RevenueCat Android épinglée** → `8.25.0` (dernière v8) dans les 2 `build.gradle` (2026-07-06)
- [ ] Vérifier les signatures SDK natif (v8) + web `purchases-js` au 1er vrai build (cf. caveats)

### Phase 5 — Passage en production
- [ ] `supabase secrets set NORVA_BILLING_MODE=revenuecat`
- [ ] Redéployer `norva-cloud` + `norva-playback` (voir « Déployer » plus bas)
- [ ] Vérifier `/health` → `"billingMode":"revenuecat"`

---

## 🧭 Coordonnées clés (pour ne rien re-chercher)

| Élément | Valeur |
|---|---|
| Branche dev | `claude/eager-carson-2zlqwy` |
| Projet Supabase (ref) | `oupsceccxsonaalhueff` (région eu-central-1) |
| URL webhook | `https://api.norva.tv/functions/v1/norva-billing-webhook` |
| Packages Android | `tv.norva.phone` (phone/tablette) · `tv.norva.tv` (TV) |
| Plan codes serveur | `plus` (2 streams) · `family` (5 streams) — parité sinon |
| Prix | Plus 4,99/mo · 41,99/an — Family 8,99/mo · 75,99/an |
| Catalogue limites | `supabase/functions/_shared/entitlements.ts` (`PLAN_LIMITS`) |
| Package ids (offering) | `$rc_monthly`, `$rc_annual`, `family_monthly`, `family_annual` |

### Où va chaque token
| Token | Emplacement |
|---|---|
| Webhook Authorization secret | RevenueCat **et** Supabase `NORVA_REVENUECAT_WEBHOOK_AUTH` |
| Clé publique Android | `clients/android-*/gradle.properties` → `REVENUECAT_API_KEY` (ou CI) |
| Clé publique Web Billing | `public/js/billing-config.js` → `revenueCatWebPublicKey` |
| Lien portail client web | `public/js/billing-config.js` → `webCustomerPortalUrl` |
| Service Account JSON (Play) | RevenueCat (app Play) |
| Product map (option) | Supabase `NORVA_RC_PRODUCT_MAP` |

---

## 🚀 Déployer (rappel)

Il n'y a **pas** de workflow CI Supabase ; les functions se déploient au CLI
depuis la racine du repo. Le CLI v2 livre 2 binaires (`supabase` shim +
`supabase-go`) ; **le shim peut planter — appeler `supabase-go` directement**.

```bash
# Installer le CLI (binaire officiel)
curl -sL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
  | tar -xz -C /usr/local/bin supabase supabase-go    # garder les 2 co-localisés

# Déployer (token = Personal Access Token Supabase)
SUPABASE_ACCESS_TOKEN=sbp_xxx supabase-go functions deploy norva-cloud norva-playback \
  --project-ref oupsceccxsonaalhueff

# Secrets
SUPABASE_ACCESS_TOKEN=sbp_xxx supabase-go secrets set NORVA_REVENUECAT_WEBHOOK_AUTH=... \
  --project-ref oupsceccxsonaalhueff
```

`config.toml` fixe déjà `verify_jwt=false` pour `norva-billing-webhook` (et les
autres). La migration s'applique via `supabase-go db push` ou l'intégration.

---

## ⚠️ Caveats / à finir

- **SDK natif RevenueCat (v8)** et **web `purchases-js`** : écrits au plus près de
  la doc mais **non compilés/testés** ici. Isolés dans `NorvaBilling.java` (par app)
  et `public/js/billing.js`. À vérifier au 1er build réel avec la clé.
- ~~**Version SDK Android en `8.+`** → épingler une version testée avant release.~~
  ✅ Fait (2026-07-06) : épinglé à `8.25.0` (dernière v8 sur Maven Central, = ce que `8.+`
  résolvait) dans les 2 `build.gradle`. POM + AAR vérifiés publiés.
- **Arbitrage produit non confirmé** : profils 5 / trusted devices 10 / sources 5
  (parité). Triviaux à changer dans `PLAN_LIMITS` si tu veux différencier.
- **`norva-cloud`/`norva-playback`** : déployés en legacy (v38/v36). À redéployer
  après avoir basculé `NORVA_BILLING_MODE=revenuecat`.
- 🔐 **Token Supabase partagé en chat le 2026-06-22 → à révoquer/régénérer**
  (Dashboard → Account → Access Tokens).

---

## Fichiers de référence

| Sujet | Fichier |
|---|---|
| Catalogue / limites / mode / trial | `supabase/functions/_shared/entitlements.ts` |
| Webhook RevenueCat | `supabase/functions/norva-billing-webhook/index.ts` |
| Endpoint trial-eligibility | `supabase/functions/norva-cloud/index.ts` |
| Migration | `supabase/migrations/20260622130000_billing_trial_consumed.sql` |
| Abstraction billing web | `public/js/billing.js` + `public/js/billing-config.js` |
| Écran d'achat in-app | `public/subscribe.html` |
| Écran de gestion d'abo | `public/subscription.html` |
| Bridge natif | `clients/android-{phone,tv}/app/src/main/java/tv/norva/*/NorvaBilling.java` |
| Pricing landing | `public/landing.html` + `public/index.html` + `public/css/landing.css` |
| Runbook complet (RevenueCat + produits) | `docs/roadmap/billing-setup.md` |
| **Walkthrough Play Console (créer les apps + tout config)** | **`docs/roadmap/play-console-setup.md`** |
