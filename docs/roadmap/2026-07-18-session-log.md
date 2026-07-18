# Session 2026-07-18 — audit upsell mensuel→annuel + 5 lots de correctifs

**Statut : 5 commits + 1 doc sur la branche `claude/client-location-revolut-playstore-p9nf74`, poussés sur `main`. Reste à déployer sur la box : 1 migration (`supabase_admin`, PAS de NOTIFY pgrst) + 4 edge functions (checklist en bas).**

Question d'origine : *« quelle est la logique quand un client paie en mensuel
3 mois puis passe en annuel ? »* — audit par workflow (26 agents : 5 lecteurs par
zone — checkout Revolut, cron de renouvellement, webhook RevenueCat, UI,
SQL finance — puis 21 vérifications adversariales sur pièces). 45 constats bruts,
21 confirmés, 5 lots de correctifs validés (« go tout »).

## La logique (telle que vérifiée, après correctifs)

- **Rail web (Revolut)** : pas de prorata, par design. Le passage en annuel ouvre
  un ordre de vérification carte 50¢ (capture MANUAL, annulé après). Rien n'est
  débité au moment du changement — le mois déjà payé court à son terme, puis le
  cron horaire `norva-revolut-billing` débite 41,99 $ (MIT) et pousse
  `current_period_end` de +1 an. La bascule réelle se fait donc **au
  renouvellement**, jamais au checkout.
- **Rail Play (RevenueCat)** : Google prorate lui-même le changement (mode de
  remplacement passé par l'app, voir lot 4). RC envoie `PRODUCT_CHANGE`
  (l'ancien produit dans `product_id`, le nouveau dans `new_product_id`), puis le
  cash annuel réel arrive au `RENEWAL` suivant.
- **TVA** : comptabilité d'encaissement — le montant annuel tombe entièrement dans
  le trimestre du débit, avec le pays carte du moment. Conforme au cockpit TVA.
- La charge d'upgrade web est un `kind='renewal'` → correctement **exclue** des
  stats de conversion essai→payant.

## Les 5 lots (commits)

| # | Lot | Commit | Fichiers |
|---|---|---|---|
| 1 | 🔴 Sécurité paiement : un plan_change abandonné armait un prélèvement annuel jamais validé (mapping écrit AVANT paiement, dès le chargement de la page ; aucun chemin de retour). Staging dans les metadata de l'ordre, commit au `/confirm` payé (+ filet webhook `ORDER_COMPLETED`) | `c04da1a` | `norva-revolut/index.ts`, `norva-revolut-webhook/index.ts` |
| 2 | 🔴 MRR ×12 : le cron ne stampait jamais `bill_period`, et cockpit/sparkline/MRR-par-pays ne joignaient que `cloud_stancer_customers` → un annuel lu 4199¢/mois (digest ARR ×12 par héritage). Cron corrigé + ré-émissions verbatim (diff scripté) avec le coalesce 3 sources d'`admin_finance` + rattrapage `bill_period` | `0056a21` | `norva-revolut-billing/index.ts`, `20260718100000_annual_upgrade_mrr_correctness.sql` |
| 3 | 🟠 Webhook RC : `PRODUCT_CHANGE` journalisé `first_charge` au prix catalogue plein (faux convert + faux montant) → `kind='plan_change'` exclu des agrégats ; plan/cadence dérivés du **nouveau** produit (`effectiveEvent()`) ; repli prix catalogue si l'événement est sans prix (sinon tarif mensuel figé jusqu'à 12 mois) | `34a8cf3` | `norva-billing-webhook/index.ts` |
| 4 | 🟠 Android : achat brut sans `oldProductId` (risque de double abonnement) → remplacement Play réel, `WITH_TIME_PRORATION` (seul mode valide dans les deux sens ; `CHARGE_PRORATED_PRICE` est refusé pour mensuel→annuel, prix/unité de temps en baisse). Compilé contre stubs RC v8 — à confirmer au 1ᵉʳ vrai build | `4d60c30` | `NorvaBilling.java` |
| 5 | 🟡 UI : promesse d'essai aux inéligibles (subscribe), « after your 7-day free trial » et « applies right away » en plan change (checkout), upgrade invisible après coup → ligne « Billing $XX / year » (subscription) | `06bbbfe` | `subscribe.html`, `checkout-revolut.html`, `subscription.html` |

## Nuances actées, non corrigées (volontaire)

- **Remise save-offer × annuel** : une remise de rétention en attente (50 % « sur
  le prochain prélèvement ») s'appliquerait au montant annuel plein si le client
  bascule ensuite en annuel. Chemin aujourd'hui mort (l'offre n'est proposée que
  dans le flux d'annulation) — à trancher si le cas devient réel : honorer (généreux)
  ou plafonner à l'équivalent mensuel.
- **Filet webhook limité à `ORDER_COMPLETED`** : un plan_change payé sur la page
  hébergée Revolut SANS retour `/confirm` et dont l'ordre reste `AUTHORISED` n'est
  pas commité → le client garde son ancien plan (échec **sûr** : jamais de
  prélèvement non validé ; le parcours normal repasse toujours par `/confirm`).
- **Historique MRR déjà écrit** : les snapshots quotidiens antérieurs surévalués ne
  sont pas réécrits (mesures datées) — la série redevient juste au prochain passage
  du cron de snapshot (07h07 UTC).
- **`mrr_cents` = montant remisé** pendant un cycle à remise save-offer (le cron
  stampe le montant réellement chargé) : sous-évaluation d'un seul cycle, hors
  périmètre de l'audit.

## Déploiement box (à faire)

```bash
cd ~/norva && git pull origin main
docker exec -i norva-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260718100000_annual_upgrade_mrr_correctness.sql
ops/hetzner/scripts/04-deploy-edge-functions.sh
```

> ⚠️ La checkout de la box est `~/norva` (PAS `/opt/norva` — première version de
> cette checklist erronée : le `cd` avait échoué, donc pull et migration sautés et
> edge redéployées depuis l'ancien code — toujours vérifier que le `git pull` a
> réellement affiché les nouveaux commits avant d'enchaîner).

- Migration en **`supabase_admin`** (règle maison) ; **pas de NOTIFY pgrst**
  (aucune signature ne change — `create or replace` seulement).
- Edge concernées : `norva-revolut`, `norva-revolut-webhook`,
  `norva-revolut-billing`, `norva-billing-webhook` (le script les redéploie toutes).
- Web : push `main` → GitHub Actions → Cloudflare Pages. **Pas de bump `?v=`**
  (AdminPage.js non touché — pages HTML top-level seulement).
- Recette : ouvrir un passage en annuel depuis un compte actif mensuel, fermer la
  page sans payer → `cloud_revolut_customers` doit rester `monthly/499` ; le récap
  checkout d'un plan change ne mentionne plus l'essai ; carte cockpit MRR inchangée
  après un test de bascule (division /12 via le mapping).

## À ne pas oublier

- Le ledger porte désormais un 3ᵉ kind monétaire **`plan_change`** (rail RC
  uniquement) : volontairement **hors** agrégats revenus/conversions/TVA (ils
  filtrent `first_charge`/`renewal`) ; visible dans les 50 derniers paiements
  (label « changement plan » déjà présent dans `KIND_LABELS`).
- `effectiveEvent()` (webhook RC) réécrit `product_id` ← `new_product_id` pour
  `PRODUCT_CHANGE` **avant** toute dérivation — si un jour on lit d'autres champs
  produit sur cet événement, passer par ce helper.
- Le prix catalogue mobile est dupliqué dans `norva-billing-webhook` ET
  `norva-revolut`/`norva-revolut-webhook`/`norva-revolut-billing` (`PRICES`) — un
  changement de prix se répercute aux **quatre** endroits.
