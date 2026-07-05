# Stancer — Go-live runbook & situation (consolidée)

> **Snapshot : 2026-07-05.** Le rail de paiement web **Stancer** est **codé,
> testé E2E, déployé en prod, et INERTE côté argent** (clé `stest_`, mode `test`).
> Vérifié en direct : `GET …/norva-stancer/health` → `{"configured":true,"mode":"test","test_key":true}`.
>
> **⏸️ EN PAUSE** — on reprend ici. Ce doc consolide `docs/PAYMENTS-STATUS.md`
> + `docs/STANCER-BILLING.md` + un recoupement base live. Les 2 docs sources
> restent la référence détaillée ; celui-ci est le **runbook actionnable**.

---

## TL;DR — passer en prod = 2 secrets, pas de code

| Secret Supabase (Edge Functions → Secrets) | Test (actuel) | Prod |
|---|---|---|
| `STANCER_SECRET_KEY` | `stest_…` | **`sprod_…`** (clé live du dashboard Stancer) |
| `NORVA_STANCER_MODE` | `test` | **`live`** |

Le flag front `billing-config.stancer.enabled` est **déjà `true`** → **aucun
redeploy front**. Test vs live est décidé **uniquement** par le préfixe de la clé
edge (`stest_` → sandbox, `sprod_` → réel) ; `NORVA_STANCER_MODE=live` est le
**garde-fou obligatoire** (sinon `/selftest` accepterait de tourner sur une clé
live). La même URL API `https://api.stancer.com` sert test ET live.

> ⚠️ Les secrets contiennent la **clé live** + le **token Supabase** → à poser
> **par l'owner** (Dashboard Supabase ou terminal). **Ne jamais les coller en chat.**

---

## Architecture (pourquoi c'est fait comme ça)

- **Web = Stancer** (PSP français, accepte le high-risk là où Stripe/Paddle/Lemon
  Squeezy refusent l'IPTV). **Mobile = Google Play Billing / RevenueCat** (codé,
  **inerte**). Les deux rails écrivent dans **une seule table**
  `cloud_entitlement_projection` (source de vérité unique, `provider` agnostique).
- **Stancer n'a pas d'objet abonnement/essai natif** → Norva orchestre lui-même :
  1. Checkout : **empreinte carte 0,50 € (autorisation `capture:false`, non débitée)**
     pour valider + tokeniser la carte (PCI SAQ-A, carte jamais vue par Norva).
  2. **Débit du plan (4,99 $ / 8,99 $) à J+7 puis à chaque renouvellement** par le
     cron `norva-stancer-billing` (jobid 82, `23 * * * *`, actif) via le token.
  3. **Nuance devise** : charges en **USD**, empreinte de validation en **EUR** —
     car l'auth-only USD est actuellement **refusée** sur le compte (voir Blocages).
- **Parcours** : `subscribe.html` → `checkout.html` (**iframe** Stancer) →
  `checkout-done.html` → `norva-stancer/confirm` (**autoritatif, pas besoin de
  webhook**). Le webhook `norva-stancer-webhook` est un **filet optionnel**
  (litiges/remboursements async).

## État live vérifié (2026-07-05)

- Fonctions déployées (via CI GitHub Actions sur push `main`) :
  `norva-stancer` **v25**, `norva-stancer-webhook` **v2**, `norva-stancer-billing`
  **v7**, `norva-lifecycle` **v6**, `norva-admin` **v10**. Toutes `verify_jwt=false`
  (chaque fonction vérifie son propre appelant).
- **Migrations : toutes appliquées** (2 posées hors historique — vérifier par
  existence des tables `cloud_stancer_customers` / `cloud_stancer_payments`, pas
  par l'historique de migration).
- Enforcement = `observe` (aucun paywall forcé), billing mode = `legacy`
  (essai auto sans carte). `NORVA_LIFECYCLE_BILLING_LIVE` off (relances/reçus).

---

## Runbook go-live (ordonné)

> Rester en **clé test** jusqu'à l'étape 6 ; ne basculer la clé live qu'à la fin.

0. **Pré-vol** : `curl …/functions/v1/norva-stancer/health` → attendre `mode:test`.
1. **Dashboard Stancer** : récupérer la clé live `sprod_…`. Relancer le support
   pour activer les **autorisations USD (auth-only)** + Apple/Google Pay. (Option)
   configurer l'URL webhook : `…/norva-stancer-webhook?t=<STANCER_WEBHOOK_TOKEN>`.
2. **Secrets non-clé (encore en test)** : `NORVA_LIFECYCLE_BILLING_LIVE=true`
   (relances J-2 / dunning / win-back / reçus) ; option `STANCER_WEBHOOK_TOKEN`
   (`openssl rand -hex 24`).
3. **Déployer seulement si le code a changé** (sinon rien, déjà en CI) :
   `supabase-go functions deploy norva-stancer norva-stancer-webhook norva-stancer-billing norva-lifecycle norva-admin --project-ref oupsceccxsonaalhueff`
4. **Migrations** : vérifier (ne pas ré-appliquer) —
   `select to_regclass('public.cloud_stancer_customers'), to_regclass('public.cloud_stancer_payments');`
   + cron : `select jobid, active from cron.job where jobname='norva-stancer-billing';`
5. **Test réel EN MODE TEST** : `/selftest` (matrice EUR/USD, marche **uniquement**
   sur clé test) + parcours navigateur avec carte test `4000000000000077` →
   vérifier `status=trialing, provider=stancer, plan_code, trial_ends_at=+7d, card_token`
   dans `cloud_entitlement_projection`. Tester aussi l'échec `4000000000009995`
   → `past_due`, et `/cancel` + `/resume`.
6. **Bascule LIVE (secrets, pas de redeploy)** :
   `STANCER_SECRET_KEY=sprod_…` + `NORVA_STANCER_MODE=live`.
7. **Post-bascule** : `/health` → `mode:live, test_key:false` ; `/selftest` doit
   **refuser** (HTTP 400 — garde-fou) ; **1 vraie carte** E2E (empreinte 0,50 €
   réelle, relâchée) ; surveiller les logs du cron `norva-stancer-billing`.
8. **Enforcement réel** (après avoir vu un cycle complet) : sortir de
   `NORVA_BILLING_MODE=legacy` + `NORVA_ENTITLEMENTS_MODE=enforce`. Enregistrer
   les comptes owner/test dans `admin_internal_accounts` (migration
   `20260704010000`) pour ne pas polluer les métriques finance.

**Rollback** : remettre `STANCER_SECRET_KEY` en `stest_…` (ou le retirer) →
`/health` `configured:false`, checkout/webhook renvoient `inert`, cron no-op.
Aucune perte de données ; rien ne débite sans clé.

---

## Blocages / vigilance (à traiter avant d'encaisser)

1. **USD auth-only refusée (seul vrai blocage fonctionnel)** : sur ce compte
   Stancer, `capture:false` en USD est refusé (« not ready for authorization ») ;
   seuls EUR auth + USD captures marchent → bricolage empreinte **0,50 € EUR** +
   débit plan **USD**. **Action owner** : faire activer les autorisations USD par
   Stancer (mail envoyé le 03/07), puis flip `eur`→`usd` (1 ligne,
   `norva-stancer/index.ts:273`).
2. **KYC / validation compte live Stancer** : aucune doc ne confirme que c'est
   finalisé. À valider avant de poser la clé `sprod_`.
3. **Angle mort opérationnel (audit CRM)** : aucune alerte si un débit échoue, si
   le cron plante, ou si des `past_due` s'accumulent ; le CRM ne voit pas l'état
   billing ; `norva-admin/health` ne ping ni Stancer ni Resend. **Recommandé de
   durcir l'observabilité billing AVANT le go-live.**
4. `STANCER_WEBHOOK_TOKEN` non posé — **non bloquant** (rail auto-suffisant via
   `/confirm` + cron). Config webhook pas dans « Développeurs » du dashboard
   Stancer → « Mon Compte » ou support.
5. Remboursements non câblés (« à câbler quand clé live »).

## Ce qui peut être fait en repo pour dé-risquer (côté Claude)

- **A.** Durcir la visibilité billing : `norva-admin/health` qui ping Stancer +
  Resend ; alertes sur échecs de débit / cron KO / `past_due` ; afficher les 4
  flags billing dans le CRM. → couvre le blocage n°3.
- **B.** Flip empreinte **EUR→USD** (prêt dès que Stancer active l'USD).
- **C.** Câbler `STANCER_WEBHOOK_TOKEN` + remboursements.

## Références fichiers

- Front checkout : `public/subscribe.html`, `public/checkout.html`,
  `public/checkout-done.html`, `public/subscription.html`
- Client : `public/js/billing.js`, `public/js/billing-config.js` (`stancer:` bloc)
- Edge : `supabase/functions/norva-stancer/index.ts`
  (`/health`:126, `/selftest`:134, `/checkout`:187, `/confirm`:309),
  `…/norva-stancer-webhook/index.ts`, `…/norva-stancer-billing/index.ts`,
  `…/norva-lifecycle/index.ts`, `…/norva-admin/index.ts`
- Config : `supabase/config.toml` (`[functions.*]` verify_jwt=false)
- CI : `.github/workflows/deploy-supabase-functions.yml`
- Docs sources : `docs/PAYMENTS-STATUS.md`, `docs/STANCER-BILLING.md`,
  `docs/NORVA-WORK-STATUS.md`, `docs/audits/ADMIN-CRM-AUDIT.md`

**Coordonnées** : Supabase ref `oupsceccxsonaalhueff` (eu-central-1) · packages
Android `tv.norva.phone` / `tv.norva.tv` · plans `plus` (2 streams) / `family`
(5 streams) · prix Plus 4,99/mo · 41,99/an — Family 8,99/mo · 75,99/an.
