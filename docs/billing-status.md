# Norva Billing — État & reprise

> **But de ce fichier** : mémoriser tout ce qui a été mis en place et tout ce
> qu'il reste à faire, pour **reprendre sans rien re-découvrir** une fois les
> comptes externes (Play Console, Stripe, RevenueCat) disponibles.
>
> - **Où on en est** = ce fichier.
> - **Comment finir** (procédures détaillées) = [`docs/billing-setup.md`](./billing-setup.md).
>
> _Dernière mise à jour : 2026-06-22._

---

## TL;DR — reprendre ici

Toute l'infra de facturation est **construite et déployée**, en **mode `legacy`**
(essai actuel sans carte → **aucun changement de comportement** tant qu'on ne
bascule pas). Pour passer en production :

1. Obtenir les comptes externes (entreprise validée → Play Console + Stripe → RevenueCat).
2. Suivre `docs/billing-setup.md`.
3. Coller 3 tokens + déployer.
4. Basculer `NORVA_BILLING_MODE=revenuecat`.

Branche de dev : **`claude/eager-carson-2zlqwy`**.
Projet Supabase : **`oupsceccxsonaalhueff`**.

---

## ✅ Fait & DÉPLOYÉ sur le live

### Base de données (Supabase `oupsceccxsonaalhueff`)
- [x] Migration `trial_consumed_at` sur `cloud_entitlement_projection` (appliquée,
  colonne `timestamptz` confirmée). Anti-abus cross-rail keyé au compte.

### Edge functions (déployées)
- [x] **`norva-billing-webhook`** v1 — `verify_jwt=false`, idempotent, mappe les
  events RevenueCat → projection. Renvoie **401 tant que le secret n'est pas mis**
  (c'est voulu). URL :
  `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-billing-webhook`
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

> Réfs `§` = sections de `docs/billing-setup.md`.

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

### Phase 4 — Tester
- [ ] RevenueCat → **Send test event** → doit passer `200 OK` (ligne dans `cloud_entitlement_events`)
- [ ] Achat **sandbox Play** (compte testeur) → accès débloqué
- [ ] Achat **web** (carte test Stripe) → même compte, accès partout
- [ ] **Restore purchases** (réinstall APK) → accès retrouvé
- [ ] **Double essai bloqué** (essai Play puis tentative web) → refusé
- [ ] **Épingler la version du SDK RevenueCat** Android (`8.+` → version testée) dans les 2 `build.gradle`
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
| URL webhook | `https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-billing-webhook` |
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
| Clé publique Web Billing | `public/js/billing-config.js` |
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
- **Version SDK Android en `8.+`** → épingler une version testée avant release.
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
| Bridge natif | `clients/android-{phone,tv}/app/src/main/java/tv/norva/*/NorvaBilling.java` |
| Pricing landing | `public/landing.html` + `public/index.html` + `public/css/landing.css` |
| Runbook complet | `docs/billing-setup.md` |
