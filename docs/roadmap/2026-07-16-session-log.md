# Session 2026-07-16 — audit post-migration (Supabase → Hetzner) : CRM/finance Revolut-aware, alerting ops, comptes internes

**Statut : 7 commits livrés sur `main` (front auto-déployé Cloudflare Pages via GitHub Actions ; 4 migrations SQL + 2 déploiements edge appliqués sur la box ; opérations data faites en direct sur `norva-db`).**

Chantier unique cette session : **valider et durcir le dashboard admin après la grosse migration Supabase → Hetzner self-hosted**, pour laquelle aucun workflow de vérification n'avait été fait. En creusant, la migration s'est révélée **mécaniquement saine** (36/36 RPC, 49/49 crons, 0 résidu Stancer, 0 URL `supabase.co`, vault 3/3, GUC OK) mais **aveugle au rail de paiement Revolut** sur plusieurs chiffres finance, avec **2 bugs latents** qui auraient cassé la 1ʳᵉ vraie conversion. Corrigé + refonte de la logique d'alertes email (qui re-spammait toutes les 6 h sur un échec éphémère) + branchement Telegram (alertes ops + tickets support) + mise au propre des 2 comptes trial de test.

| # | Sujet | Commit `main` | Fichiers |
|---|---|---|---|
| 1 | Cron enrich anti-deadlock (`SKIP LOCKED`) | `10772bd` | `20260716120000_enrich_titles_skip_locked.sql` |
| 2 | Restore `AdminPage.js` (revert troncature accidentelle `abe1c16`) | `c7f6313` | `AdminPage.js` |
| 3 | Bump cache lazy-load `AdminPage.js?v=51` | `ade6aee` | `app.js` |
| 4 | Alertes ops recovery-aware + canal Telegram + healthcheck SQL | `7c59bce` | `norva-admin/index.ts`, `norva-support/index.ts`, `_shared/telegram.ts`, `07-selfhost-data-healthcheck.sql`, compose + env |
| 5 | Finance CRM rail-agnostic + journaling des charges Revolut (G2/G3) | `556bd05` | `20260716130000_dashboard_finance_revolut_rail.sql`, `norva-revolut-billing/index.ts` |
| 6 | Fiche + funnel Revolut-aware + route `/refund` (+ 2 bugs latents) | `234d8d0` | `20260716140000_fiche_funnel_revolut_rail.sql`, `norva-admin/index.ts`, `AdminPage.js`, `app.js` (`?v=52`), compose, healthcheck |
| 7 | Comptes internes = plan `family`, durée indéterminée (invariant VIP) | `1b14496` | `20260716150000_internal_accounts_family_vip.sql` |

Bump `?v=52` de `AdminPage.js` inclus dans le commit 6. (Le commit `22a9dab` / merge PR #206 « devices popover navbar » du même jour n'est **pas** de cette session.)

---

## Contexte technique (à relire avant toute retouche billing/CRM)

- **Rails de paiement.** **Revolut** = rail **web** actuel (tables `cloud_revolut_customers` / `cloud_revolut_orders` ; le prix récurrent + la cadence sont aussi projetés sur `cloud_entitlement_projection.mrr_cents` / `bill_period`). **RevenueCat** = rail **mobile** (Play/Apple). **Stancer** = **RETIRÉ / obsolète** (ne plus s'y référer pour de la donnée live).
- **Ledger cross-rail = `cloud_stancer_payments`.** Malgré son nom historique, cette table est le **journal de paiements cross-rail** (colonne `provider`). Les charges Revolut capturées y sont journalisées par `norva-revolut-billing`. ⚠️ **Le nom `stancer` est trompeur** — un renommage optionnel en `cloud_billing_ledger` via vue de compat reste à faire (voir « À NE PAS OUBLIER »).
- **Le cron `norva-revolut-billing` charge** : `provider='revolut' AND status='trialing' AND trial_ends_at ≤ now` → **first_charge** ; `provider='revolut' AND status='active' AND current_period_end ≤ now` → **renewal**. Casser une seule de ces conditions (ex. passer le rail à `system`) suffit à **empêcher un prélèvement**.
- **Comptes internes** (`admin_internal_accounts`) = comptes test du propriétaire. Traitement : **VIP permanent** (`status=active, plan_code=family, provider=system, current_period_end=2099-01-01`, trial vidé) **+ exclus de toutes les métriques finance**. Depuis cette session, marquer interne via la fiche **applique** ce traitement (avant : posait juste le tag).
- **`refresh_admin_dashboard` / `snapshot_admin_metrics`** lisent l'argent via **`cloud_entitlement_projection.mrr_cents`** (coalesce rail-agnostic), **pas** par lecture directe des tables Revolut → dans le healthcheck, `revolut_aware=f` sur ces deux fonctions est **NORMAL** (ce n'est pas un bug). `admin_finance` / `admin_user_billing` lisent `cloud_revolut_customers` en direct → `revolut_aware=t`.
- **Déploiement.**
  - **Web** : push sur `main` → **GitHub Actions** `.github/workflows/deploy-cloudflare.yml` → Cloudflare Pages `norva-web` (region-check, `node --check`, minify CSS, `hash:assets` réécrit les `?v=` en hash de contenu, inline CSS, `wrangler pages deploy`). **La box n'a pas wrangler — ce n'est pas le canal de déploiement.** `AdminPage.js` est lazy-loadé avec un `?v=NN` **manuel** dans `app.js` (`hash:assets` ne peut pas le réécrire).
  - **Edge** : sur la box, `cd ~/norva && git pull && ops/hetzner/scripts/04-deploy-edge-functions.sh` (restart du conteneur `norva-edge-functions`).
  - **Migrations SQL** : manuelles, `docker exec -i norva-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < <fichier>.sql`.
- **Vérification locale** : Postgres 16 jetable (`/tmp/pgstart.sh`, socket `/tmp/pgs`, port 5433, lancé en user `postgres`) + tables stub pour rejouer une migration ; `deno check --node-modules-dir=auto` (deno dans `/tmp/deno/bin`) pour les edge functions.

---

## 1. Cron `norva-enrich-titles-from-catalog` anti-deadlock (`10772bd`)

**Symptôme** : email d'alerte « cron en échec ». **Diagnostic** : sur 48 h, **1 seul deadlock** (2026-07-15 20:03), auto-résolu — les 8 derniers runs étaient OK. Correctif **préventif** : `cloud_enrich_titles_from_catalog` réécrit avec `order by ct.id … for update of ct skip locked` (deux workers ne se bloquent plus mutuellement). Vérifié sur PG jetable.

## 2. `AdminPage.js` tronqué en prod — P0 (`c7f6313`, `ade6aee`)

Le commit `abe1c16` (session précédente) avait **tronqué `AdminPage.js`** (3467 → 707 lignes → SyntaxError). La page admin ne rendait donc **rien sur un chargement neuf** depuis le 13/07 — masqué par le cache SPA en mémoire (les onglets déjà ouverts marchaient). **Restauré** depuis `136e3aa` (3467 lignes) + bump du `?v=` lazy-load. Le healthcheck de l'utilisateur a ensuite confirmé le dashboard fonctionnel.

## 3. Audit post-migration — healthcheck SQL (`7c59bce`)

`ops/hetzner/scripts/07-selfhost-data-healthcheck.sql` : audit **100 % read-only** de **chaque** source de données que le CRM lit (Cockpit, Finance, Clients, Support, Providers, Identités, Moteur, Système, Télémétrie). Sections A→H : snapshot cache, billing, **drift de définitions** (le check critique `revolut_aware`), 36 RPC, crons, GUC/vault, tables produit, smoke.

**Verdict** : migration **mécaniquement saine**. **Un** défaut structurel (pré-existant, pas causé par la migration) : les fonctions finance G2/G3 aveugles au rail Revolut → corrigé (§5). Bug non-bloquant du script (B2 : `payment_id` → `pi_id`) corrigé au §6.

## 4. Refonte des alertes ops + canal Telegram (`7c59bce`)

- **Bug email** : `runOpsAlertSweep()` déclenchait sur `cron_fails_24h > 0` — un **compteur glissant 24 h** qui gardait la clé d'alerte active **6 h après** un échec déjà réparé → re-spam. Remplacé par `failingNow = crons.filter(c => c.active !== false && c.last_status === 'failed')` (état **par job**, dernier run), + **notice de rétablissement** (« ✅ résolu ») quand un job repasse vert. La cooldown (`admin_alert_state`) se met à jour dès qu'**un** canal a délivré.
- **Telegram** (`_shared/telegram.ts`) : `sendTelegram(text)` + `tgEscape()`, lit `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, no-op si absent, ne throw jamais, truncate 4000 car., timeout 6 s, `parse_mode=HTML`. Branché sur : **alertes ops** (`norva-admin/ops-alert`) + **nouveaux tickets / réponses support** (`norva-support`). Ajout des deux secrets au template `.env.hetzner.example` + service `functions` du compose. Testé en direct (message reçu).

## 5. Finance CRM rail-agnostic + journaling Revolut — G2/G3 (`556bd05`)

- `refresh_admin_dashboard()` + `snapshot_admin_metrics()` : `billing_mrr_cents` / `mrr_cents` passent de `join cloud_stancer_customers` à `left join … + coalesce(c.amount_cents, projection.mrr_cents)` (idem période), et le filtre cron billing `'norva-stancer-billing'` → `'norva-revolut-billing'` (sinon les échecs du vrai cron billing seraient **invisibles** — G3). Re-emission verbatim avec assertions, appliquée (`CREATE FUNCTION ×2`).
- `norva-revolut-billing` : journalise chaque charge capturée (`first_charge` / `renewal`) dans `cloud_stancer_payments` (upsert `pi_id=rvl_<order>`, `provider='revolut'`), best-effort. **NB** : à ce stade le journaling échouait encore en silence — voir le bug (0) du §6.

## 6. Fiche + funnel Revolut-aware + route refund + 2 bugs latents (`234d8d0`)

Migration `20260716140000_fiche_funnel_revolut_rail.sql` :
- **(0) BUG LATENT** — la contrainte `cloud_stancer_payments_provider_check` **n'autorisait pas `'revolut'`** (seules `cloud_entitlement_projection` / `_events` avaient été whitelistées, pas le ledger). Le journaling du §5 **violait la contrainte et échouait en silence** (try/catch) → la 1ʳᵉ conversion aurait été perdue (`collected`/`funnel`/`conversions` à 0). **Whitelist ajoutée.**
- **(1) Point 1 — fiche** : `admin_user_billing.mapping` passe de `cloud_stancer_customers` à `coalesce(cloud_revolut_customers, stancer)` + `card_brand` → le plan + la carte Revolut (`MASTERCARD ••1492`) s'affichent enfin. **Re-ajoute `is_internal`** (perdu au `20260705110000` → le bouton « marquer interne » de la fiche affichait un état faux) + flag `refundable` précis (`revolut + captured + order_id`).
- **(2) Point 2 — funnel** : `norva_funnel_daily` gagne `checkout_open` depuis `cloud_revolut_orders` (`trial_setup` / `resubscribe`) — les checkouts web abandonnés (mine de conversion) étaient invisibles (seules les charges capturées touchent le ledger).
- **(3) BUG LATENT — régression** : `admin_finance` (live `20260705110000`) avait **perdu l'exclusion des comptes internes** ajoutée en `20260704010000` → la page Finance recomptait les comptes test. **Restaurée** + `paying`/`trialers`/`renewals` rendus rail-agnostiques (`coalesce revolut/stancer/projection`).

`norva-admin` — **route `/user/:id/refund`** (Point 3) : remboursement Revolut merchant-initiated, admin-gated, **idempotent** (une ligne refund par order → refuse un 2ᵉ remboursement), journalise une ligne `kind='refund'` + event timeline. Mirroir de l'appel Merchant API de `norva-revolut-billing` (`POST /api/orders/{id}/refund` + header `Revolut-Api-Version`). `AdminPage.js` : bouton activé sur les charges Revolut capturées (`refundable`), affiche la marque de carte, labels `refund`/`refunded`, `?v=52`. **archive_timeout 300 → 900** dans le compose (Point 4 — RPO 15 min ; Revolut est la source de vérité de l'argent, 300 s triplait la churn WAL à vide).

**Vérifié** : migration appliquée + smoke test fonctionnel sur PG16 jetable (interne exclu ; mapping/carte/refundable Revolut ; funnel `checkout_open`) ; `deno check` sur `norva-admin` OK.

⚠️ **La route refund n'a PAS pu être testée en live** (pas de sandbox Revolut ici). Comme il y a **0 charge capturée aujourd'hui**, le bouton n'apparaît pour personne → activation sans risque. À valider sur la **1ʳᵉ vraie charge**.

## 7. Comptes internes = family / durée indéterminée — invariant (`1b14496`)

Migration `20260716150000_internal_accounts_family_vip.sql` : (a) **backfill** de **tous** les `admin_internal_accounts` courants en `system/active/family/2099` (trial + mrr vidés) ; (b) **`admin_internal_toggle`** enrichi — marquer interne **accorde** désormais l'entitlement VIP family/indéterminé (rail `system` → le cron billing le skippe, annulant une conversion de trial en cours). Démarquer ne **rétrograde pas** (évite de couper l'accès par erreur). Vérifié sur PG16 (toggle ON revolut/trialing/499 → system/family/2099+tag ; toggle OFF → untag sans downgrade).

---

## Opérations faites en direct sur la box `norva-db` (hors commits)

- **Migrations appliquées** (docker exec psql) : `20260716120000`, `20260716130000`, `20260716140000`, `20260716150000`.
- **Edge redéployés** : `norva-admin` (route refund + alertes), `norva-revolut-billing` (journaling). Telegram câblé + testé (message reçu).
- **Les 2 trials Revolut identifiés = comptes test du propriétaire** :
  - `cventis.support@gmail.com` (`1af1dfa9-…`) — MASTERCARD ••1492, avait **20 `trial_setup` PENDING** (checkouts abandonnés) ;
  - `projethorizon2030@gmail.com` (`7bdab1df-…`) — VISA ••5863.
  - **Annulés + passés internes** : `provider=system, status=active, trial_ends_at=null` → **aucun prélèvement** le 19/20-07.
- **4 comptes internes** au total, tous vérifiés `family · system · active · 2099` : `adrien.hernandez@outlook.com`, `cventis.support@gmail.com`, `hernandez.jeremy@outlook.fr`, `projethorizon2030@gmail.com`.

---

## À NE PAS OUBLIER

1. **Route refund — valider en live** sur la 1ʳᵉ vraie charge Revolut : l'endpoint `POST /api/orders/{id}/refund` (+ `Revolut-Api-Version: 2024-09-01`) n'a pas été testé contre l'API réelle. Le reste (garde admin, idempotence, ledger) est sûr.
2. **Sécurité — roter le token bot Telegram** : le `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` ont été collés en clair dans la conversation (donc exposés dans l'historique + le shell). À régénérer via @BotFather, puis MAJ `ops/hetzner/.env` **et** `/etc/norva-netdata/health_alarm_notify.conf`.
3. **(Optionnel) Nettoyage des références « Stancer » obsolètes** : renommer le ledger `cloud_stancer_payments` → `cloud_billing_ledger` (via vue de compat pour ne rien casser) + purger docs/commentaires. Migration prudente à part.
4. **Fiche Revolut des 2 trials** : maintenant sur le rail `system`, leur fiche n'affiche plus de carte Revolut (c'est attendu — ils ont changé de rail).
5. **Web** : déployé **automatiquement** par la CI à chaque push `main` (runs `234d8d0` + `1b14496` = ✅ success). Ne pas chercher à lancer `wrangler` sur la box. Recharger le CRM dans un **nouvel onglet** pour récupérer `AdminPage.js?v=52`.
