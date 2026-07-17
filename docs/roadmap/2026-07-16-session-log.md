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
| 8 | Value-adds Telegram : ping conversion + alerte échec renouvellement + digest hebdo | `d2b9354` | `norva-revolut-billing/index.ts`, `norva-admin/index.ts`, `20260716160000_weekly_business_digest_cron.sql` |
| 9 | Rename ledger `cloud_stancer_payments` → `cloud_billing_ledger` (vue de compat) | `5721570` | `20260716170000_rename_ledger_cloud_billing.sql`, `norva-revolut-billing/index.ts`, `norva-admin/index.ts`, `norva-billing-webhook/index.ts`, healthcheck |
| 10 | Finance : cartes par rail (Revolut web vs stores mobiles) — vue canal complète | `3adf0fe` | `20260716180000_admin_finance_rail_cards.sql`, `AdminPage.js`, `app.js` (`?v=53`) |
| 11 | Tunnel support utilisateur : live-updates, TV, découverte, récupération session | `e08549c` | `support.html`, `norva-support/index.ts`, `landing.html`, blog |
| 12 | Support admin : compteurs exacts, pagination+recherche serveur, priorité, fil | `4de206f` | `20260716190000_support_admin_ux.sql`, `AdminPage.js` (`?v=54`) |
| 13 | Clients admin : hash routing deep-link/F5 + polish fiche | `52389b8` | `AdminPage.js` (`?v=55`), `app.js` |

Bump `?v=52` de `AdminPage.js` inclus dans le commit 6. (Le commit `22a9dab` / merge PR #206 « devices popover navbar » du même jour n'est **pas** de cette session.) Commits 8-9 ajoutés en fin de session (value-adds Telegram + nettoyage Stancer) — détail §8-9.

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

## 8. Value-adds Telegram (`d2b9354`)

Trois notifications proactives sur le même canal `sendTelegram()` :
- **🎉 Ping conversion** (`norva-revolut-billing`) : quand un VRAI client (non-interne) convertit son trial en 1ᵉʳ prélèvement → Telegram instantané (email + plan + montant). Les comptes internes sont skippés (check `admin_internal_accounts`).
- **💳 Alerte échec renouvellement** (`norva-revolut-billing`) : quand la charge d'un abonné réel est refusée → past_due, ping individuel (vs le seuil ≥3 du sweep ops). Les deux pings sont best-effort, ne bloquent jamais la facturation.
- **📊 Digest business hebdo** (`norva-admin/weekly-digest` + cron lundi 07:00 UTC) : croissance, revenu (MRR/ARR, payants, essais, conversions, encaissé), support — lu depuis le cache admin. Le cron **clone la commande du job `norva-ops-alert`** (déjà pointée sur l'URL box + token) et swappe le chemin → matche l'URL self-hosted automatiquement, sans hardcoder de `*.supabase.co`.

## 9. Rename du ledger : `cloud_stancer_payments` → `cloud_billing_ledger` (`5721570`)

Le rail Stancer est retiré ; le nom était trompeur (c'est le ledger CROSS-RAIL). Renommé avec une **vue de compat** `cloud_stancer_payments` → `cloud_billing_ledger` (auto-updatable). Les **écrivains** edge (upserts revolut-billing + billing-webhook, insert refund admin) sont repointés sur la table réelle ; les **lecteurs SQL** (admin_finance, refresh_admin_dashboard, snapshot_admin_metrics, norva_funnel_daily, admin_user_billing) + norva-lifecycle passent par la vue, sans ré-emission. Vérifié sur PG16 : rename, SELECT via vue, upsert (table ET vue — l'`ON CONFLICT` passe même via la vue auto-updatable en PG16, donc zéro risque de fenêtre au déploiement), contrainte provider sous le nouveau nom, index renommés. ⚠️ **Ordre** : appliquer la migration PUIS déployer les edge.

## 10. Finance : cartes par rail — vue canal complète (`3adf0fe`)

L'onglet Finance avait une table rail (MRR payants + encaissé) avec 4 angles morts : essais sans rail (page vide avant la 1ʳᵉ conversion), conversions globales seulement, remboursements ignorés, à-venir mélangeant les prélèvements du cron Norva (Revolut) et ceux gérés par Google. **SQL** (`20260716180000`, re-emission additive d'`admin_finance`) : `by_rail` + `trialing_n`/`mrr_trial_cents` (full outer join payants×essais), + `conversions_by_rail` (7 j), `collected_by_rail` + `refunded_cents`, + `upcoming_by_rail` (essais <48 h / renouvellements <7 j par provider), lectures basculées sur `cloud_billing_ledger`. **Front** (`?v=53`) : la table devient des **cartes rail** en section 2 — par canal : MRR + part %, **net estimé après commission** (constantes front : ~1 % Revolut, 15 % stores palier Small Business, tooltip « estimation »), payants + essais ($ potentiels), encaissé 30 j (− remboursé), conversions 7 j, à-venir, et note explicite « prélevé par NOTRE cron » vs « facturé par le store ». Vérifié : replay PG16 ordre prod (140000→170000→180000) + seed deux-rails (toutes les clés exactes, internes exclus, globaux inchangés) + **test de rendu headless Chromium** de `_renderFinance` avec ce payload exact (2 cartes, parts 50 %, lignes net, badge remboursement, ancienne table disparue).

## 11-13. Audit UX/UI complet des tunnels Support & Clients (3 explorations parallèles + contre-audit)

Audit à trois volets (tunnel support utilisateur / Support admin / Clients admin) : **7 P1 + 24 P2 relevés, TOUS corrigés** (commits 11-13). Les P1 : (1) `support.html` ne se rafraîchissait jamais (promesse « replies land right here » fausse) → polling 45 s + `visibilitychange`, sans jamais écraser un brouillon de réponse ; (2) inutilisable sur TV → classe `html.tv` pré-paint + `tvNavigation.js` + CSS 10-foot + focus initial ; (3) aucune entrée support sur la landing → lien footer (+ `returnTo` blog) ; (4) compteurs d'onglets Support ≠ contenu listé → `open_exact`/`pending_exact` + onglet « Actifs » (prédicats partagés) ; (5) cap silencieux à 100 tickets → pagination + recherche **serveur** (email/sujet/corps, `p_search`) ; (6) ticket introuvable rendait une coquille actionnable → garde « Ticket introuvable » ; (7) **zéro persistance d'URL du CRM** (F5 → Cockpit, `#admin` retombait même sur Home car la page lazy est `null` au boot) → routing `#admin/<route>` (validRoute whitelist UUID, stash avant réécriture du hash, replaceState sans toucher l'historique app). Parmi les P2 : bouton « Mark resolved » utilisateur (route `/close`), dédup `/create` (10 min), deep-link email `?ticket=`, récupération session expirée, priorité tickets (chip + sélecteur + RPC `admin_support_set_priority`), template Remboursement au présent (n'affirme plus un remboursement non émis), anti-double « Hi, », compteur 8000, Ctrl+Entrée, toasts, retour ticket→fiche (`_ticketReturn`), chips fiche en erreur, « VIP interne », badge `Stancer · retiré`, devise sur paiements, CSV warn 10 k, garde anti-self-lock-out, `open_total` fiche. Vérifié : 3 tests headless Chromium (14+15+11 assertions), test fonctionnel PG16 des 3 RPCs (9 assertions), `deno check`, `node --check`.

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
3. ~~Nettoyage des références « Stancer »~~ ✅ **FAIT** (`5721570`, §9) — ledger renommé en `cloud_billing_ledger` + vue de compat. `cloud_stancer_customers` (map carte Stancer morte) volontairement conservée (lue en coalesce par le CRM).
4. **Digest hebdo — à vérifier après apply** : le cron `norva-weekly-digest` se crée en clonant `norva-ops-alert`. Contrôler `select jobname, schedule from cron.job where jobname='norva-weekly-digest';` et forcer un test : `POST norva-admin/weekly-digest` (Bearer backfill token) → un message doit arriver.
5. **Fiche Revolut des 2 trials** : maintenant sur le rail `system`, leur fiche n'affiche plus de carte Revolut (c'est attendu — ils ont changé de rail).
6. **Sécurité — roter le token bot Telegram** (déjà #2) : reste la seule action « à faire » côté secret.
7. **Web** : déployé **automatiquement** par la CI à chaque push `main`. Ne pas chercher à lancer `wrangler` sur la box. Recharger le CRM dans un **nouvel onglet** pour récupérer `AdminPage.js?v=52`.

---

## §11 — Moteur d'enrichissement : diagnostic « 38 % » + 4 leviers (commits 14-15)

**Demande** : « 38 % c'est trop faible, vérifie pourquoi » → diagnostic complet, puis « applique
les 4 leviers ».

**Diagnostic** (`ops/hetzner/scripts/08-enrichment-audio-diag.sql`, read-only, sortie live du
16/07) — 412 559 titres des comptes pilotes : **38,3 % résolus · 40,7 % jamais sondés (167 980) ·
20,9 % sondés-sans-langue (86 392)**. Causes par impact :
1. **Fenêtre d'urgence 458** : depuis le 10/07 les crons films-audio tournaient en `1-4 UTC`
   → ~3-5k sondes/j au lieu de ~15-20k. Les protections durables (verrou compte-occupé,
   crawl-yield, breakers) étant actives, la fenêtre étroite était devenue le goulot n°1.
2. **Intake >> drain** : 177 257 nouveaux titres en 7 j (nouveaux panels IPTV Ferran ~60k,
   AtlasPro ~14,5k ; chiffre partiellement gonflé par la réparation dédup du 14/07) contre
   14 225 résolus → la couverture RECULAIT mécaniquement.
3. **Ninja** : 118 124 jamais sondés à ~80 sondes/j réelles (cap 40/h × fenêtre 4 h) → 3-4 ans.
4. **Trou noir « sondés sans langue »** : 86 388/86 392 sans AUCUNE piste stockée → invisibles de
   whisper (4 candidats !), gelés 180 j. Strng 8K 30 771 (43 % de ses films), Ferran 20 152 (45 %).
- Le « 1 cron KO » = `norva-enrich-titles-from-catalog`, un unique deadlock le 15/07 20:03,
  **déjà corrigé** le matin même par `20260716120000_enrich_titles_skip_locked.sql` (sort de la
  fenêtre 24 h tout seul). Flotte audio : 25 jobs actifs, 0 échec, 0 breaker ouvert.

**Leviers appliqués** :
- **A — fenêtres restaurées** : `ops/hetzner/scripts/09-reopen-probe-windows.sql` (runtime,
  alter par jobname) : films-audio retour `6-23 UTC`, **Ninja 24/7** (`4-59/12` films,
  `9-59/12` séries — le cap horaire régule, design « ré-activation domptée »). Nuit 0-5
  (séries/ST/whisper) inchangée. Préalable recommandé : `NORVA_EDGE_CALLBACK_BASE=`
  `https://api.norva.tv/functions/v1/norva-playback` dans `.env.media` gateway + up -d.
- **B — échantillonnage du trou noir** : `ops/hetzner/scripts/10-sample-reprobe-empty.sh` —
  re-sonde N titres (déf. 12) des 2 panels les plus touchés via le mode diag `titleIds`
  (langues vod + header-probe par titre), bilan « récupérables vs morts » automatique.
  À lancer à une heure creuse ; décidera d'un re-probe ciblé (reset `audio_probed_at`).
- **C — cap Ninja 40 → 60/h** (dans le script 09) ; observer 48 h avant d'envisager 80.
- **D — récents d'abord** : migration `20260716200000_audio_candidates_recent_first.sql`
  (RPC `audio_backfill_candidates` : `order by release_year desc nulls last, id`) + même ordre
  dans le chemin account-wide inline de `norva-playback` (préservé `order by id` quand un
  `afterId` de pagination manuelle est passé). Sans risque : les crons n'envoient jamais
  `afterId`, la progression repose sur le marquage. Testé sur PG16 jetable (ordre
  2026→2020→1994→NULL vérifié) ; `deno check` : 3 erreurs préexistantes inchangées, 0 nouvelle.

**Docs** : note « état live 2026-07-16 » dans `ENRICHMENT_CRON_SETUP.md` (+ ⛔ Ninja marqué
obsolète), §8 du doc 458 mis à jour (fenêtres soldées, valeur callback self-host, jobids 35/36).

**Attendu sous 24-48 h** (re-lancer le diag 08) : sondes/jour ×4-6, `jamais_sonde` en baisse
nette, Ninja `hits_24h` ~1 200-1 400 sans 401/ban. Si un re-ban Ninja se manifeste malgré tout :
rollback = re-poser `1-4` (état AVANT imprimé par le script 09) + cap 40.

### §11-bis — deux correctifs post-application

1. **Script 09 : `cron.alter_job` → UPDATE direct.** Sur la box, `cron.alter_job` a rejeté les
   8 alters (« Job N does not exist or you don't own it ») : sa garde `username = current_user`
   bloque même un superuser quand le job appartient à un autre rôle (jobs recréés à la
   restauration Hetzner). Le script passe en **UPDATE direct de `cron.job`** (une instruction,
   RETURNING, owner-agnostic) — sûr en self-host : le trigger `cron.job_cache_invalidate`
   (impression de contrôle intégrée) notifie le launcher. Seul le cap 60/h était passé au 1ᵉʳ
   run ; **le script corrigé doit être relancé**. Runbook amendé (la règle « jamais d'UPDATE
   direct » était un artefact de permissions du Supabase managé).
2. **Crons KO recovery-aware** (`20260716210000_cron_ko_recovery_aware.sql` + AdminPage v57) :
   le deadlock unique du 15/07, auto-réparé, affichait « 1 cron KO / À traiter / Attention »
   pendant 24 h. Nouveau champ `overview.cron_ko` = jobs ACTIFS dont le **dernier** run est
   `failed`. Front : Cockpit (état global + alerte rouge sur `cron_ko`, carte ambre « Récupéré »
   sinon, fallback pré-migration conservé), Moteur (carte/pilules KO vs récupérés, incident
   gris « Échec récupéré », tableau crons badge ambre + résumé). Testé : fonction exécutée sur
   PG16 stub (cron_ko=1/fails=2 sur le scénario mixte) + 17 assertions headless Chromium.

---

## §12 — Fiche série/film VIDE depuis My List & Continue Watching (commit ci-dessous)

**Symptôme** (captures) : « Outlander (US) » depuis la recherche Series = fiche riche (8 saisons,
98 épisodes, 15 versions, synopsis, casting) ; le MÊME titre depuis My List/Continue Watching =
fiche squelette (1 saison, 12 épisodes, « No summary available yet », poster générique).

**Cause racine** (workflow 6 agents, confiance haute, vérifiée sur code) : `renderMyList`
(HomePage.js) réduit chaque favori à 5 champs maigres `{item_id, source_id, item_type, title,
poster}` — ni `variants[]` ni `tmdb`. `navigateToSeries/Movie` → `buildHomeMediaGroup` ne fait
que refléter l'item → groupe MONO-variante sans métadonnées. Double famine : (a) pas de
tmdb/synopsis/saisons ; (b) `tryNextHealthyVersion` n'a AUCUNE version sœur vers laquelle
basculer quand la variante favorisée est partielle (ex. la source « (4K) » qui n'a que la S5).

**Fix (client only, confiné à HomePage.js)** : les items MAIGRES (sans `variants[]`) passent
désormais par `page.openByItem(...)` — le résolveur DÉJÀ utilisé par la recherche globale et la
restauration de fiche — qui re-cherche les versions sœurs par titre (RPC `search_media_items`,
trigram tolérant aux suffixes « (4K) ») et reconstruit le groupe canonique complet. Garde-fous :
les rails riches (porteurs de `variants[]`) gardent le chemin direct inchangé ; si `openByItem`
échoue/lève, fallback sur l'ancien comportement (fiche mono-version, jamais pire qu'avant).
HomePage v46. Testé : 7 assertions headless Chromium sur le vrai prototype (mapping series/movie,
fallback false + throw, rail riche intact).

---

## §13 — Audit mobile : contenu rogné en bas de page (VOD + Settings) — corrigé

**Symptôme** : sur le webview mobile, le bas de page est quasi systématiquement rogné (~60 à
140 px) — grilles VOD, settings, guide TV.

**3 causes racines trouvées** :
1. **`#app` : fallbacks de hauteur dans le MAUVAIS ordre** — `-webkit-fill-available` déclaré
   APRÈS `100dvh`, donc il gagnait partout (le dernier valide l'emporte) : l'app entière se
   dimensionnait sur le grand viewport Android → tout le bas passait derrière l'UI navigateur.
   Les commentaires du code croyaient l'inverse. → réordonné : `100vh` → `-webkit-fill-available`
   → **`100dvh` gagnant**.
2. **6 conteneurs dimensionnés en `calc(100vh - …)` sans paire `dvh`** : `.settings-container`
   (base + mobile), `.movies-grid`, `.series-grid` (base + mobile), `.epg-grid` (base + mobile),
   `.content-browser` → rognés par la barre d'URL dynamique.
3. **Aucun d'eux ne soustrayait la bottom-nav mobile (56 px + safe-area)** : la compensation
   n'existait que sur `.main-content` (padding), que ces conteneurs viewport-sized ignorent.

**Fix** : variable unique `--bottom-nav-h` (0 par défaut ; `calc(56px + env(safe-area-inset-bottom))`
dans le breakpoint ≤640px qui affiche la barre), soustraite partout + paires `100vh`/`100dvh`
sur les 6 conteneurs ; le padding de `.main-content` consomme la même variable (une seule
source de vérité). `support.html` : paire dvh sur `body{min-height}` (cosmétique). Fiches
Movies/Series : vérifiées SAINES (in-flow dans la chaîne de hauteur → héritent du padding).

**Vérifié** : harnais headless Chromium avec la vraie main.css — 390×844 (barre active) : les
5 conteneurs finissent ≤ ligne de barre, padding 56 px, `#app` = viewport exact ; 800×900
(sans barre) : var à 0, aucun sur-rognage. PASS complet.

**Versions Android pour build AAB** : TV `versionCode 17→18`, `versionName 3.8.4→3.8.5-hybrid`.
Phone DÉJÀ à `versionCode 14 / 1.3.1` (bump antérieur 8f0ddf8, non publié) — inchangé. Les deux
clients étant des webviews distants, les fixes CSS arrivent via le déploiement web sans rebuild ;
l'AAB ne sert que le versioning store.

### §13-bis — le rognage persistait dans l'APP : cause = edge-to-edge Android 15

Après réinstallation, le rognage persistait dans l'app (pas dans un navigateur mobile). Cause
manquée par le premier harnais (safe-areas à 0) : `targetSdk 35` → Android 15 force
l'**edge-to-edge** → le webview dessine sous la status-bar, la navbar se grandit de
`--safe-area-inset-top` (~33 px)… que les calc viewport ne soustrayaient PAS → tout débordait
d'exactement ~safe-top sous la barre. En plus : la barre fait 57 px (56 + border-top), pas 56.

Fix v2 : (a) `--topbar-h = navbar-height + safe-area-inset-top` soustrait par epg-grid,
grilles mobile, content-browser ; grilles base : `- var(--safe-area-inset-top)` ajouté à la
constante 120 ; (b) `--bottom-nav-h` 56→57 px ; (c) `.settings-container` passe carrément en
`height: 100%` (chaîné → immunisé par construction : navbar/safe-top/barre gérés par
#app→main-content→page). Vérifié avec safe-top simulé 33 px (edge-to-edge) ET 0 (navigateur)
ET desktop : les 5 conteneurs finissent ≤ ligne de barre ; Delete account (vrai app.html)
atteignable à 751/787.

### §14 — Assistant de dépannage : re-tap = annuler + synchro inverse (Settings v41)

Retour utilisateur : les options de l'assistant (« Black screen », « Provider blocks it »)
se cochent mais ne se décochent pas → doute sur leur fonctionnement. C'étaient des boutons
d'action one-shot (elles n'ALLUMAIENT que). Ajouts : (a) re-taper l'option active ANNULE le
remède (toggle éteint / selects restaurés à leur valeur pré-assistant via dataset.tcPrev,
message « Turned off » + toast info) ; (b) synchro inverse — éteindre manuellement le toggle
(ou bouger les selects) retire le surlignage et le message de l'assistant. Piège corrigé au
passage : la restauration des selects déclenchait syncFromControls en réentrance qui oubliait
tcPrev avant la fin de la boucle → dé-surligner AVANT de restaurer. Testé : 8 assertions
headless sur le vrai SettingsPage.prototype (apply/undo/sync/restore + persistance change).

---

## §15 — Sous-titres IA sur TOUS les VOD (workflow 11 agents + panel adversarial)

**Demande** : les ST IA n'étaient pas disponibles sur l'ensemble des catalogues VOD — audit
profond (workflow : 7 lecteurs, 1 architecte, 3 vérificateurs adversariaux, ~969k tokens) puis
implémentation « partout mais logiquement ».

**Causes racines confirmées** : (1) gate front FILMS-ONLY (`_aiSubtitleParams`, WatchPage) alors
que le backend gérait DÉJÀ les ids d'épisode (resolveVariantUrl, chemin « player-triggered ») ;
(2) option cachée dès qu'UNE piste texte existe, même dans une langue inutile au viewer (contredit
PHASE3 §1) ; (3) pregen minuscule par design (2 jobs/nuit/provider, whitelist restreinte) → la
couverture DOIT venir de l'on-demand, donc de la visibilité de l'option ; (4) budget nocturne
gaspillé : les séries de la whitelist faisaient transcrire le 1ᵉʳ épisode sous l'id SÉRIE, clé
jamais relue par le player ; (5) aucun cap anti-abus sur la route POST ; (6) cloud-only et pont
TMDB inter-panels : hors périmètre (architecture / Phase B.2).

**Implémenté (fixes du panel inclus)** :
- CLIENT (WatchPage v121) : épisodes éligibles depuis SeriesPage (`type:'series'`) ET Home
  (`type:'episode'`), itemType toujours 'series' envoyé (le clamp edge transformerait 'episode'
  en 'movie'), garde anti-id-série (jamais transcrire S1E1 pour S3E7), titleId non envoyé pour
  les épisodes ; option visible même avec pistes texte (section secondaire « more languages ») ;
  `_aiUserRequested` révoqué à la sélection d'une autre piste (les livraisons partielles ne
  volent plus la piste choisie) ; Off garde le polling d'un job en cours ; 429 du cap → état
  verrouillé honnête « Daily limit reached » (plus de « provider refused »/retry-mensonge) ;
  label email per-épisode.
- EDGE (norva-playback) : budget viewer par ÉVÉNEMENTS (table generated_subtitle_requests,
  1 row = 1 enqueue accepté par la gateway) — 10/24h/user + 15/24h/identité, transcript + OCR ;
  `force` neutralisé sur la route user (contournait cap + fast-path ready) ; refus low_footprint
  (Ninja) pour origin viewer (PROVIDER-ANTIBAN : whisper-sur-Ninja gaté par fenêtre
  d'observation) ; refus du chemin « fiche série → 1er épisode » pour origin viewer (défense en
  profondeur).
- GATEWAY (Railway, auto-déployée au push) : cooldown per-provider 12 min entre extractions
  full-file (transcribe + OCR, pattern lastStoryboardAt — un binge de 10 épisodes devient des
  lectures espacées, pas 3-4 h de download continu = le fingerprint du ban Ninja) ; pas de mark
  sur préemption viewer.
- MIGRATION 20260717120000 : table events + prune 7 j (cron guard sur pg_proc) + whitelist
  nocturne MOVIE-ONLY.

**Vérifié** : deno check (0 nouvelle erreur), node --check gateway, migration sur PG16 jetable
(série jouée exclue de la whitelist, events comptés), 14 assertions headless Chromium sur le vrai
WatchPage.prototype (params films/épisodes/gardes, mapping erreurs, menu contextuel, cap locked,
label épisode, révocation auto-attach, keepAiPolling).

**Hors périmètre assumé** : pont TMDB inter-panels (Phase B.2, vrai multiplicateur de couverture,
changement de modèle de données) ; pregen per-épisode ; mode local ; gating par abonnement.

### §16 — Trou noir « sondés sans langue » : verdict + re-probe Ferran (2026-07-17 matin)

Échantillonnage box (script 10) : **Strng 8K 0/12 récupérables** (vrais flux morts — perte
structurelle assumée, aucun re-probe de masse) ; **Ferran 5/12 récupérables, tous par
header-probe, 0 par vod** → mode vod aveugle sur ce panel. Opérations live : reset de
**15 518** marqueurs du bucket Ferran (script 11), cron per-source `norva-audio-ferran-probe`
(probe, jour 6-23), job 12 vod **scopé sur AtlasPro**. Détail dans ENRICHMENT_CRON_SETUP.md
§2026-07-17. Attendu : +6-7k titres résolus sur Ferran d'ici le week-end. Au passage : la
migration ST-IA (20260717120000) est appliquée et l'edge redéployé par Adrien à 06:15.

### §17 — Deux lots de fixes issus des audits ST-IA + synchro multi-appareils (2026-07-17)

> **Trace de référence complète (ancres `fichier:fonction`, migrations, FAQ)** :
> `docs/audits/AI-SUBTITLES-SYNC-FIXES-2026-07-17.md`.

Suite aux deux audits workflow du 17/07 (tunnel « Generate AI subtitles » chronométré, 8 agents ;
synchro web/mobile/TV, 9 agents), TOUTES les recommandations ont été appliquées d'un bloc.

**Lot A — tunnel sous-titres IA (notifications & réactivité)** :
- CLIENT (WatchPage v122) : feedback optimiste au clic — état `processing`/stage `checking`
  posé AVANT tout réseau (le seul trou d'UI du tunnel : ~0,3-1 s de silence) ; le choix
  poursuivre-ou-enqueue se décide sur le STATUS de la réponse cache (l'état optimiste aurait
  avalé l'enqueue) ; poll adaptatif 20 s (extraction/transcription — les partiels ne changent
  pas) / 60 s (deferred, queued pos>0) → ~2/3 de GET en moins sur les longues attentes, chaîne
  setTimeout + jeton de génération (un stop en plein tick ne se re-planifie pas).
- EDGE (norva-playback) : deep link email — le bouton devient « Watch with AI subtitles » et
  pointe `app.html#movies/open:src:id:titre` (ou `#series/open:src:seriesId:titre` — les
  épisodes sont cachés par id d'épisode mais la fiche s'ouvre par id de série, d'où la colonne
  series_id stockée à l'opt-in) ; opt-in ready-check — s'abonner sur un job déjà terminal
  répond MAINTENANT (ready+speech → email immédiat + cloche ; no-speech/failed → refus honnête,
  la chip se révoque) → ferme la race de la fenêtre de poll ET rattrape les orphelins ; les 4
  chemins d'échec d'enqueue (transcribe/ocr/translate/chaînage) résolvent désormais les pending
  via dispatch ; cloche in-app : `cloud_content_events` kind `subtitle_ready|empty|failed` par
  souscripteur, payload.watch = deep link (le bell d'app.js les rend cliquables, navigation
  in-app sans reload via openFicheFromRoute).
- APP.JS (v45) : route de deep link `#movies/open:…`/`#series/open:…` au boot (même resolver
  openByItem que la recherche globale — le titre voyage dans l'URL pour une fiche pleine).
- MIGRATION 20260717150000 : colonnes source_id/series_id sur les notifications ; reaper
  ré-émis — il résout les pending en `failed` + insère l'événement cloche (CTE reaped→resolved→
  insert, testé sur PG16 jetable : job vivant intact, morts résolus+cloche) ; purge 30 j
  (03:25).

**Lot B — synchro multi-appareils (les 4 P1 + P2/P3 de l'audit)** :
- P1 carte périmée : WatchPage consulte TOUJOURS la position serveur à l'ouverture (plus
  seulement offset=0) — un 0 RÉPONDU (fini/retiré ailleurs) redémarre honnêtement, un échec
  réseau garde l'offset de la carte (`_fetchServerResumeInfo` distingue les deux) ; les cibles
  de seek explicites (restore de session) restent prioritaires ; même fix dans l'override
  natif TV (standalone.js v8).
- P1 TV filet durable : `finish()` PERSISTE la position finale dans SharedPreferences au lieu
  de la purger ; le record n'est consommé qu'à la CONFIRMATION du save cloud (pont
  `onProgressSaved(token)` sur les deux bridges, `onProgress` confirme après le .then du save) ;
  pump retry 20×/1,5 s façon deep-link ; staleness 7 j. Ferme aussi le drop du retour variante.
- P1 webAppReady honnête : false sur onPageStarted, true seulement si l'URL finie EST le shell
  app (app.html / racine du serveur embarqué — cloud-pair.html et pages d'erreur ne comptent
  plus) — le flush ne consomme plus de position contre une page sans bridge.
- P1 heartbeat cloud TV : PlayerActivity relaie la position toutes les ~45 s vers la WebView de
  MainActivity (`relayNativeHeartbeat`, VOD only) → les autres appareils voient la TV avancer
  PENDANT le film. Lève la « limite actée » du 14/07. **TV versionCode 19 (3.8.6-hybrid) — AAB
  à rebuilder.**
- P2 garde temporelle serveur : les clients envoient `watchedAt` (capture du tick — la TV envoie
  celle de la persistance native) ; saveHistory n'écrase progress que si plus récent, force
  passe, clients legacy inchangés. Un paquet retardé ne régresse plus une position plus fraîche.
- P2 DELETE historique par clés : `DELETE /history?sourceId&itemId&itemType` (user + device,
  purge aussi les orphelins source_id=null du même titre), client api.js/cloudApi câblés,
  SeriesPage mark-unwatched keyed (l'ancien list-then-find sur cache 20 s « supprimait » dans le
  vide) ; mark-watched envoie désormais `completed:true` explicite.
- P2 récentes live : re-pull TTL 5 min + refocus + tick 10 min (plus une-fois-par-session) et
  MERGE par fraîcheur avec le miroir local (`at` sur chaque entrée) au lieu d'écraser.
- P2 parité data TV : le save natif porte playbackPreferences + nextEpisode (calculé du payload
  de lancement) → un binge TV alimente la carte « up next » des autres appareils ; durationHint
  jamais écrasé par 0 (régression timeframe fermée).
- P2 signal profil verrouillé : header `x-norva-profile-fallback: locked` (exposé CORS) + toast
  une-fois côté client — fini la désynchronisation silencieuse post-downgrade.
- P3 completed préservé : plus de reset à false par heartbeat ; un vrai re-watch (≥60 s)
  l'efface honnêtement, un clic accidentel (<60 s) non.
- P3 hub local self-hosted : history.js MERGE data + préserve duration (le delta-heartbeat web
  écrasait le blob riche par {} dès le 2e tick en mode hub).
- MIGRATION 20260717160000 : dédoublonnage des lignes source_id NULL (renouvellement de source)
  + index unique `NULLS NOT DISTINCT` — l'ON CONFLICT de saveHistory matche désormais les
  orphelins (upsert testé sur PG16 jetable).

**Vérifié** : deno check norva-playback/norva-cloud (0 nouvelle erreur — 3+3 pré-existantes
identiques sur l'arbre propre), node --check sur les 8 JS touchés, javac -proc:none (0 erreur de
syntaxe, bruit SDK Android seul), 2 migrations rejouées sur PG16 jetable avec fixtures, smoke
headless Chromium (optimiste→enqueue non avalé, label checking, cadences 60/20/60 s).

**Déploiement** : web auto (push main → Cloudflare) ; edge à redéployer sur la box + 2
migrations à appliquer ; TV = rebuild AAB v19.
