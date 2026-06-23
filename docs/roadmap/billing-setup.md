# Norva — Mise en place de la facturation (RevenueCat + Play Billing + Web Billing)

> Ce document est la **checklist complète** à suivre une fois ta création
> d'entreprise validée (donc une fois que tu auras accès à Google Play Console
> et que tu pourras compléter Stripe). Tout le code est déjà en place : il ne
> restera qu'à **créer les produits, coller les tokens, et déployer**.

---

## 1. Architecture (qui fait quoi)

```
                 ┌──────────────────────────────────────────────┐
                 │                 RevenueCat                    │
                 │  source de vérité des abonnements (tous rails)│
                 └───────────────┬──────────────────────────────┘
        achat Play Billing       │ webhook (events)
   (APK phone/tablette/TV) ──────┤
        achat Web Billing        │        ┌──────────────────────────────┐
   (navigateur, via Stripe) ─────┘───────▶│ norva-billing-webhook (Edge) │
                                          │  → cloud_entitlement_events   │
                                          │  → cloud_entitlement_projection│
                                          └───────────────┬──────────────┘
                                                          │ lit la projection
                                          ┌───────────────▼──────────────┐
                                          │  norva-cloud / norva-playback │
                                          │  (enforcement des accès)      │
                                          └──────────────────────────────┘
```

- **App User ID RevenueCat = `user.id` Supabase.** L'app appelle
  `Purchases.logIn(userId)` → tous les achats (phone, tablette, TV, web)
  s'agrègent sous **un seul compte**. L'accès suit le compte, pas l'appareil.
- **Trial** : 7 jours **avec moyen de paiement**, qui se convertit
  automatiquement. L'éligibilité est gardée côté serveur par
  `trial_consumed_at` (un trial par compte, tous rails confondus).
- **Limites** : `plus` = 2 streams simultanés, `family` = 5. Tout le reste est
  en parité (voir `supabase/functions/_shared/entitlements.ts`).

### Valeurs déjà fixées (à réutiliser tel quel)

| Élément | Valeur |
|---|---|
| Ref projet Supabase | `oupsceccxsonaalhueff` |
| URL du webhook | `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-billing-webhook` |
| Package APK téléphone/tablette | `tv.norva.phone` |
| Package APK Android TV | `tv.norva.tv` |
| Plan codes serveur | `plus`, `family` |
| Prix | Plus 4,99 $/mo · 41,99 $/an — Family 8,99 $/mo · 75,99 $/an |

---

## 2. Pré-requis (à débloquer avant de commencer)

1. ✅ Entreprise validée (en cours de ton côté).
2. ⬜ Compte **Google Play Console** (25 $ une fois) — nécessite l'entreprise.
3. ⬜ Compte **Stripe** complété (infos entreprise/bancaires).
4. ⬜ Compte **RevenueCat** (gratuit jusqu'à un certain CA).

---

## 3. RevenueCat — pas à pas

### 3.1 Créer le projet
- **Project name** : `Norva`
- **Category** : `Media & Video`
- **Platform(s)** : `Google Play Store` + `Web (RevenueCat Billing)`

### 3.2 Ajouter les apps
Dans le même projet (pour unifier les entitlements) :
1. **App Google Play — phone** : package `tv.norva.phone`.
2. **App Google Play — TV** : package `tv.norva.tv`.
   - Pour chaque app Play : fournir le **Service Account JSON** (voir §4.3).
3. **App Web Billing** : connecter **Stripe** (voir §5).

### 3.3 Créer l'entitlement
- Un seul entitlement, identifiant : **`pro`**.
- Les deux tiers (plus/family) débloquent `pro`. C'est le **produit** qui
  détermine le tier (nb de streams), pas l'entitlement.

### 3.4 Importer les produits
Crée d'abord les produits côté Play Console (§4) et Stripe (§5), puis dans
RevenueCat : **Products → +New**, et attache **chaque produit à l'entitlement
`pro`**. Utilise ces identifiants (le webhook les mappe automatiquement) :

| Produit (subscription id) | Base plan | → plan_code |
|---|---|---|
| `norva_plus` | `monthly` | `plus` |
| `norva_plus` | `annual` | `plus` |
| `norva_family` | `monthly` | `family` |
| `norva_family` | `annual` | `family` |

> ⚠️ Garde `plus`/`family` dans le nom des produits : le webhook a une
> heuristique de secours qui mappe `norva_family:annual` → `family` même sans
> configuration. Pour être 100 % explicite, renseigne aussi
> `NORVA_RC_PRODUCT_MAP` (voir §6).

### 3.5 Créer l'Offering
- **Offerings → Default offering**, ajoute 4 packages :
  - `$rc_monthly` → `norva_plus:monthly`
  - `$rc_annual` → `norva_plus:annual`
  - (custom) `family_monthly` → `norva_family:monthly`
  - (custom) `family_annual` → `norva_family:annual`
- C'est ce que l'app lit pour afficher le paywall.

### 3.6 Configurer le webhook
- **Integrations → Webhooks → + Add**
- **URL** : `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-billing-webhook`
- **Authorization header** : invente un secret long et aléatoire.
  → recopie-le dans le secret Supabase `NORVA_REVENUECAT_WEBHOOK_AUTH` (§6).
- **App version / environment** : laisse Production + Sandbox.

### 3.7 Récupérer les clés API publiques
- **Project settings → API keys** :
  - Clé publique **Google Play** (Android SDK) → ira dans les apps (§7).
  - Clé publique **Web Billing** → ira dans `billing-config.js` (§8).

---

## 4. Google Play Console — abonnements

### 4.1 Créer les apps
Crée deux apps : `tv.norva.phone` et `tv.norva.tv`.

### 4.2 Créer les abonnements
Pour chaque app : **Monetize → Subscriptions → Create subscription**.

| Subscription product ID | Base plans | Prix |
|---|---|---|
| `norva_plus` | `monthly` (P1M) · `annual` (P1Y) | 4,99 $ · 41,99 $ |
| `norva_family` | `monthly` (P1M) · `annual` (P1Y) | 8,99 $ · 75,99 $ |

- Sur **chaque base plan**, ajoute une **Offer** « free trial » de **7 jours**
  (P7D), éligibilité « New customers ». C'est l'essai carte-requise.
- Active les prix locaux (Play les convertit automatiquement).

### 4.3 Service Account (pour que RevenueCat lise les achats)
1. Play Console → **Setup → API access** → lie un projet Google Cloud.
2. Crée un **Service Account**, donne-lui le rôle d'accès financier/abonnements.
3. Génère une **clé JSON** → upload dans RevenueCat (app Play, §3.2).
4. Active les **Real-time Developer Notifications (RTDN)** vers le topic
   Pub/Sub fourni par RevenueCat.

---

## 5. Stripe (via RevenueCat Web Billing)
- Dans RevenueCat, app Web Billing → **Connect Stripe** (OAuth).
- RevenueCat crée/relie les prix Stripe à partir des produits. Tu n'as pas à
  recréer manuellement les prix côté Stripe si tu passes par Web Billing.
- Renseigne la page de checkout (logo, couleurs, mentions légales).

---

## 6. Secrets à mettre dans Supabase
**Dashboard Supabase → Edge Functions → Secrets** (ou `supabase secrets set`) :

| Secret | Valeur | Obligatoire |
|---|---|---|
| `NORVA_REVENUECAT_WEBHOOK_AUTH` | le secret du header Authorization du webhook (§3.6) | ✅ |
| `NORVA_RC_PRODUCT_MAP` | `{"norva_plus:monthly":"plus","norva_plus:annual":"plus","norva_family:monthly":"family","norva_family:annual":"family"}` | optionnel (heuristique sinon) |
| `NORVA_BILLING_MODE` | `revenuecat` (bascule finale, voir §10). Tant que vide = `legacy` | ⏳ à la fin |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` sont déjà configurés (autres functions).

---

## 7. Clé RevenueCat dans les apps Android
La clé publique Android (§3.7) est injectée via une **propriété Gradle**
`REVENUECAT_API_KEY` (lue dans `BuildConfig`). Deux façons :

- **Local** : ajoute dans `clients/android-phone/gradle.properties` (et
  `clients/android-tv/gradle.properties`) :
  ```properties
  REVENUECAT_API_KEY=goog_xxxxxxxxxxxxxxxxxxxx
  ```
- **CI (GitHub Actions)** : ajoute un secret repo `REVENUECAT_API_KEY` et
  passe-le au build avec `-PREVENUECAT_API_KEY=${{ secrets.REVENUECAT_API_KEY }}`
  (voir `.github/workflows/android-release.yml`).

Si la clé est absente, l'app **compile et tourne quand même** : le SDK n'est
juste pas initialisé et le paywall natif affichera « facturation indisponible ».

---

## 8. Clé Web Billing (navigateur)
Édite `public/js/billing-config.js` :
```js
window.NORVA_BILLING_CONFIG = {
  revenueCatWebPublicKey: 'rcb_xxxxxxxxxxxxxxxx', // clé Web Billing (§3.7)
  webBillingEnabled: true,
  offeringId: 'default',
};
```
(Ou sers ce fichier depuis une variable d'environnement au déploiement.)

---

## 9. Déploiement
```bash
# 1. Migration (ajoute trial_consumed_at)
supabase db push        # ou via l'intégration Supabase / MCP apply_migration

# 2. Edge function du webhook
supabase functions deploy norva-billing-webhook

# 3. Vérifier les secrets
supabase secrets list
```
Puis dans RevenueCat : **Webhooks → Send test event** → tu dois voir `200 OK`.

---

## 10. Bascule finale legacy → RevenueCat
Tant que `NORVA_BILLING_MODE` n'est pas `revenuecat`, l'app garde l'ancien
essai automatique **sans carte** (pour ne rien casser pendant la construction).

Quand tout est testé (achat sandbox Play OK, achat web OK, webhook OK) :
1. `supabase secrets set NORVA_BILLING_MODE=revenuecat`
2. Redeploy `norva-cloud` (pour recharger l'env).
3. Désormais : pas d'accès sans entitlement réel → le paywall pilote l'achat,
   l'essai 7 j passe par Play/Web avec carte, et `trial_consumed_at` empêche le
   double essai cross-rail.

---

## 11. Récap « où va chaque token »

| Token / clé | Où le coller |
|---|---|
| Webhook Authorization secret | RevenueCat (§3.6) **et** Supabase `NORVA_REVENUECAT_WEBHOOK_AUTH` |
| Clé publique Android | `gradle.properties` / CI `REVENUECAT_API_KEY` |
| Clé publique Web Billing | `public/js/billing-config.js` |
| Service Account JSON (Play) | RevenueCat (app Play) |
| Product map | Supabase `NORVA_RC_PRODUCT_MAP` (optionnel) |
| Bascule de mode | Supabase `NORVA_BILLING_MODE=revenuecat` |

---

## 12. Tests de bout en bout (checklist)
- [ ] `Send test event` RevenueCat → `200 OK`, ligne dans `cloud_entitlement_events`.
- [ ] Achat **sandbox** Play (compte testeur) → projection passe `trialing`/`active`,
      accès débloqué sur l'app.
- [ ] Achat **web** (carte test Stripe) → même compte, accès débloqué partout.
- [ ] Annulation → `cancelled_at_period_end`, accès maintenu jusqu'à la fin.
- [ ] Restore purchases (réinstallation APK) → accès retrouvé.
- [ ] Double essai bloqué (essai Play puis tentative essai web) → refusé.
