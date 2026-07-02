# CRM Admin Norva (Cockpit · Clients · Providers · Moteur · Système)

**Statut : LIVE en production.** Admin cloud-only, visible uniquement pour les comptes dont le JWT
porte `app_metadata.role = 'admin'`.

> **Structure CRM (depuis v11).** Cliquer « Admin » entre dans un **shell CRM** dédié : sidebar gauche
> persistante + **routing interne** state-based (`this._route`) et une zone de contenu scrollable.
> Pages : **Cockpit** (KPIs + alertes), **Clients** (liste paginée → **fiche 360° pleine page**),
> **Providers** (sources), **Identités** (graphe des identités canoniques), **Moteur** (enrichissement
> + crons), **Système** (santé + infra + flags + journal d'audit). Chaque page
> requête sa propre RPC (server-cached) à la navigation ; un bouton « ↻ Rafraîchir » recharge la page
> courante. Les sections historiques ci-dessous sont maintenant réparties dans ces pages ; les RPCs et
> la sémantique sont inchangées.

> Repère rapide : la page est servie par `public/js/pages/AdminPage.js`, les données viennent de
> **RPCs PostgREST** appelées directement avec le JWT de l'admin (aucune edge function → marche même
> pendant une panne de déploiement edge). Chaque RPC est gatée **côté serveur** par `is_admin()`.

---

## 1. Accès & rôle

- **Rôle** : `app_metadata.role = 'admin'`, posé **côté serveur** dans `auth.users.raw_app_meta_data`
  (donc non falsifiable par le client — un user ne peut pas se l'auto-attribuer).
- **`is_admin()`** (SQL, invoker) : `coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)`.
  C'est la seule source de vérité d'autorisation. Toutes les RPCs admin la vérifient en première ligne.
- **Gating de navigation (UX only)** : dans `public/js/app.js`, le lien de nav `#nav-admin` est masqué
  par défaut et révélé si `AdminPage.isAdmin()` (qui appelle la RPC `is_admin`) renvoie `true`. Ce gating
  est **cosmétique** — la vraie barrière est côté serveur : un non-admin qui appelle une RPC reçoit
  « not authorized », quels que soient les artifices côté client.
- **Route guard** : `AdminPage.show()` vérifie `isAdmin()` et redirige vers `home` sinon.

> ⚠️ Note d'implémentation : la branche cloud de `checkAuth()` (app.js) force `role:'admin'` pour tous
> les users cloud **côté client uniquement** (héritage d'un ancien code). Ça n'a AUCUN effet sur
> l'autorisation réelle : `is_admin()` lit le claim JWT signé par Supabase, pas cet objet client. Le
> gating de nav s'appuie donc sur la RPC `is_admin`, pas sur cet objet.

---

## 2. Architecture des données — pourquoi un cache

Le rôle PostgREST `authenticated` a un **`statement_timeout` de 8 s**. Les agrégations Ops (compter
films/séries/variants sur des centaines de milliers de titres, par source) dépassaient ce budget
(erreur `57014 canceling statement due to statement timeout`). Solution :

- **`admin_dashboard_cache`** : table **une seule ligne** (`id = 1`) portant 4 blobs `jsonb`
  (`overview`, `sources`, `coverage`, `cron`) + `refreshed_at`.
- **`refresh_admin_dashboard()`** (SECURITY DEFINER, `set local statement_timeout = '180s'`) calcule les
  4 blobs et upsert la ligne. Le `180s` n'est possible que parce que la fonction tourne en definer.
- **pg_cron `admin-dashboard-refresh`** (`2-57/10 * * * *`) rappelle la fonction toutes les 10 minutes
  (décalé de +2 min pour éviter les minutes :00/:30 où 8-10 jobs partent ensemble). Réécrite en CTE
  une-passe (audit crons 2026-07-02) : ~31-37 s → **~8 s** par run, `work_mem 64MB` local (fin des
  spills disque ~218 Mo/run).
- Les RPCs Ops (`admin_overview`/`admin_sources`/`admin_enrichment_coverage`/`admin_cron_health`) ne
  font que **lire le blob** correspondant depuis la ligne cachée → réponse instantanée, jamais de timeout.

**Users** est l'exception : la liste est **live** (recherche / tri / pagination), donc `admin_users_page`
requête `auth.users` en direct — mais bornée à une page (voir §5), donc pas de timeout.

---

## 3. Scalabilité (des milliers d'users)

Le refresh scannait initialement TOUS les `cloud_titles` (O(titres totaux)) + 4 sous-comptages PAR
source sur TOUTES les sources (O(sources × titres)) — viable à 3 users / 557k titres, **fatal** à des
milliers d'users. Redesign (migration `…scale_driving_accounts`) :

- **Overview** : KPIs globaux, mais uniquement des `count(*)` bon marché (users, sources, titres,
  identités, crons) → reste global et rapide.
- **Enrichissement** : borné aux **comptes pilotes** (`admin_enrichment_accounts`). Les crons
  d'enrichissement ne tournent QUE pour ces comptes ; tous les autres users héritent via le cache
  cross-user (clé identité). Donc la couverture par panel n'a de sens que pour les pilotes.
- **Providers** : panels pilotes **+ sources en problème** (erreur de sync, ou VOD sans variants),
  plafonné à 300 lignes.
- **Users** : pagination + agrégation bornée par page (O(taille de page)).

> **Ajouter un compte pilote** : insérer une ligne dans `public.admin_enrichment_accounts (user_id,
> label)`. La source de vérité des `userId` reste les crons d'enrichissement.

---

## 4. Sections & données

### Cockpit (KPIs + alertes)
`admin_overview` → blob `overview`. Cartes santé + **croissance** : Users, Actifs 24 h / 7 j,
**Nouveaux 7 j / 30 j**, Sources, Sync incomplète, Sources en erreur, Films, Séries, Identités, Crons
actifs / pause / échecs 24 h, Sous-titres IA prêts / échoués. **Bloc Alertes** : dérive côté client les
sources en problème (erreur / sync incomplète) depuis `admin_sources` et les rend **cliquables → fiche
du client** (le blob `sources` porte désormais `user_id`). « Aucune alerte » si tout est sain.

### 👥 Users (live, paginé) — voir §5.

### 📡 Providers / Sources
`admin_sources` → blob `sources`. Groupé par compte. Colonnes : Compte, Provider, Statut (ready /
erreur / **sync incomplète**), Items, Variants, Films, Séries, Identité résolue, bouton **↻ re-sync**.
- **« sync incomplète »** = la source a des items VOD (`item_type in movie/series`) mais **0** variant
  (finalize bloqué). Un provider **live-only** (ex. AtlasPro : 10 843 chaînes live, 0 VOD) a
  légitimement 0 variant → **pas** flaggé (correctif `…incomplete_vod_only`).

### 🧬 Identités fournisseurs (page dédiée)
RPC `admin_identities()` → une carte par **identité canonique** (`provider_identities`, ≈ 1 par panel
amont réel) : statut, nb de clés provider, first/last seen, **marques** (chips ; > 1 marque = badge
**« miroir multi-marques »**, ex. Opplex ≡ Ferran) et les `cloud_sources` qui la portent (compte,
pilote, statut, dernier sync ; lignes cliquables → fiche client ; cap 50/identité). Mapping
source→identité par `display_name ∈ marques` (comme partout ailleurs — `cloud_sources` n'a pas de
colonne provider_key), servi par l'index `idx_cloud_sources_display_name`.

### ⚙️ Enrichissement par panel
`admin_enrichment_coverage` → blob `coverage`. Comptes pilotes uniquement. Par panel × type
(films/séries) : Total, **Audio résolu** (barre + %), **Jamais sondé**, **Sondé 24 h**,
**ETA 1er passage**, **ST trouvés**.
- **ETA** = `jamais_sondé / sondé_24h` (jours). Badge **✓ sondé** quand `jamais_sondé = 0` (1ʳᵉ passe
  finie — *tout* sondé au moins une fois, **≠ 100 % résolu** : le reste est `und` conteneur, résolvable
  seulement par whisper). Badge **⏸ à l'arrêt** si `sondé_24h = 0` et qu'il reste des titres.

### 🎯 Matching TMDB (bloc de la page Moteur)
Trois compteurs de l'overview — `tmdb_year_backlog` (années manquantes), `tmdb_unmatched`,
`tmdb_unverified` — counts bon marché via les index partiels du Lot 2 de l'audit crons. Drainés
chaque nuit par backfill-years (1000/j) / search-match (3 600/j) / revalidate (2 000/j) : **ils
doivent baisser de jour en jour** — c'est le signal de santé de ces crons (cf.
docs/CRON-OPTIMIZATION-AUDIT.md).

### ⏱️ Crons
`admin_cron_health` → blob `cron`. Groupé par fenêtre (☀️ jour 6-23 UTC / 🌙 nuit 0-5 UTC). Colonnes :
Fenêtre, Dimension (audio films / séries / sous-titres / whisper / tmdb / notif / sync / maintenance), Job,
**Cadence humaine** (`AdminPage.cronHuman` : `0-59/3 6-23 * * *` → « toutes les 3 min · 6h–23h »), État
(actif / pause / échecs), Dernier run, Échecs 24 h.
- **Échecs 24 h** compte `status = 'failed'` (pas `<> 'succeeded'`, qui attrapait à tort les jobs
  `running`/`starting` → correctif `…cron_fail_metric`).

---

## 5. Section Users (live, paginée)

**RPC `admin_users_page(p_limit=25, p_offset=0, p_search=null, p_sort='created_desc', p_tag_id=null)`**
→ `jsonb` `{ total, limit, offset, rows[], all_tags[] }`. SECURITY DEFINER, gatée `is_admin()`,
`grant execute` à `authenticated` uniquement (revoke public/anon).

Chaque row : `user_id, email, created_at, last_sign_in_at, email_confirmed, role, is_driver,
sources_count, tags[]` (segments du client). Tris : `created_desc | created_asc | active_desc |
email_asc`. Recherche : `email ilike`. **Filtre par segment** : `p_tag_id` restreint aux clients
portant ce tag ; `all_tags` alimente le sélecteur de filtre côté UI (colonne « Segments » dans la liste).

**Scalable — O(taille de page)** :
- `total` = un seul `count(*)` sur `auth.users` (+ filtre email éventuel).
- `rows` = page LIMIT/OFFSET ; les agrégations par ligne (`sources_count`, `tags`) sont des lookups
  indexés (`cloud_sources(user_id)`, `admin_client_tags(user_id)`), exécutés au plus `p_limit` (≤ 100)
  fois. **Jamais de full-scan.** La recherche accepte aussi un **UUID exact** (workflows support).
- Chaque row porte `banned` → badge « suspendu » visible dès la liste.

**Seuils de scale connus (documentés, pas bloquants au niveau « milliers d'users »)** :
- Recherche email : `ilike '%…%'` sans index trigram → linéaire sur `auth.users`. OK jusqu'à ~100k
  users ; au-delà, prévoir un profil public indexé pg_trgm (on n'indexe pas `auth.users`, schéma géré).
- Pagination OFFSET : coût croissant en profondeur extrême ; au-delà de ~100k users, passer en keyset
  (cursor `created_at,id`). Non nécessaire avant.

**UI** (`_loadUsers` / `_renderUsers`) : recherche debounced 300 ms, select de tri, pagination
← Précédent / Suivant → avec « X–Y sur N ». Badge bleu **pilote** si compte d'enrichissement, badge
rôle admin/user, activité en relatif (`timeAgo`, date exacte au survol). Chargée **indépendamment** du
snapshot caché : une section Ops en erreur ne bloque pas Users et inversement.

**⬇ Export CSV** : RPC `admin_users_export(p_search, p_tag_id, p_limit≤10000)` — mêmes filtres que la
liste ; CSV strict côté client (champs quotés, quotes doublées, CRLF, BOM Excel) →
`norva-clients-YYYYMMDD.csv`. Au-delà de 10k lignes exportées, passer à un export serveur par lots
(seuil documenté).

**Actions groupées par segment** : quand un segment est filtré, une barre propose **＋ appliquer un
autre tag à tous** et **− retirer ce tag de tous** (RPC `admin_tag_bulk(p_tag, 'apply'|'remove',
p_other)`) — une transaction, un `admin_events` par client affecté (« (groupé) »), confirmations UI
avec le compte total.

### Détail d'un user (au clic sur une ligne)
Chaque ligne est cliquable → ouvre une **modale** (`_openUserDetail` / `_renderUserDetail`, fermeture par
×, clic backdrop ou Échap). Données via **RPC `admin_user_detail(p_user_id uuid)`** → `jsonb`
`{ user, sources[], enrichment[] }` (SECURITY DEFINER, `is_admin()`, `set local statement_timeout='60s'`,
scopée à un seul `user_id`) :
- **user** : rôle, pilote, email vérifié, inscription, dernière activité, provider d'auth.
- **sources** : chaque provider du user — statut (ready / erreur / sync incomplète), items, variants,
  films, séries, identité résolue, dernier sync, + **bouton ↻ re-sync** (même route `/admin/resync/{id}`).
- **enrichment** : couverture audio **par panel × type** pour CE user (total, résolu %, jamais sondé,
  sondé 24 h, ETA, ST trouvés).

Perf : scopée à un `user_id` indexé — ~3,5 s sur le plus gros pilote (airo, 334k titres, plan parallèle),
< 1 s pour un user normal (index scan sur `cloud_titles(user_id, …)`). Aucune agrégation multi-tenant.

**Couche relationnelle (le cœur CRM).** La fiche porte 3 panneaux interactifs, alimentés par
**`admin_client_crm(p_user_id)`** → `{ tags, all_tags, notes, timeline }` :
- **🏷️ Tags & segments** — tables `admin_tags` (catalogue : VIP / À risque / Pilote / Nouveau /
  Support, couleur = classe de badge) + `admin_client_tags` (join client↔tag). Chips retirables +
  chips « + » pour appliquer un tag existant + « ＋ créer » (`admin_tag_create` puis auto-application).
  Ajout/retrait via `admin_tag_toggle(user, tag, on)`.
- **📝 Notes internes** — table `admin_notes` (body, auteur = email JWT, date). Ajout
  `admin_note_add(user, body)`, suppression `admin_note_delete(note_id)`.
- **🕑 Timeline** — `admin_events` (événements réels : note/tag/action admin) **UNION** d'événements
  **synthétiques** dérivés de l'existant (inscription depuis `auth.users`, provider ajouté & dernier
  sync depuis `cloud_sources`) → timeline utile immédiatement, sans attendre les hooks lifecycle.

Toutes les tables sont **RLS-on sans policy** → accessibles uniquement via les RPCs SECURITY DEFINER
`is_admin()`-gatées ci-dessus. Auteur d'une action = l'email du JWT admin.

---

## 6. Actions

### Re-sync d'une source (bouton ↻ dans Providers / fiche)
Route edge **`POST norva-source-sync/admin/resync/{sourceId}`**. Accepte **soit** le
`NORVA_BACKFILL_TOKEN` (service), **soit** un **JWT admin** (`supabase.auth.getUser(token)` puis
vérif `app_metadata.role === 'admin'`). Retrouve le propriétaire de la source et lance
`syncCloudSource(sourceId, ownerId, …, { force:true })` — qui kicke la chaîne
`driveXtreamSyncToReady` en arrière-plan et **répond immédiatement**. Côté UI : le bouton passe à
« ✓ lancé ».

### Actions client avancées (fiche → bloc ⚡ Actions)
Fonction edge dédiée **`norva-admin`** (service-role, `verify_jwt=false`, mais gate en-code :
`getUser(token)` → `app_metadata.role === 'admin'`). Chaque action écrit un `admin_events`
(`admin_action`) → visible dans la timeline. Routes POST :
- **`/user/:id/resend-confirmation`** — `auth.resend({type:'signup'})` (passe par le Send Email Hook
  `norva-auth-email` → template Resend). N'apparaît que si l'email n'est pas confirmé.
- **`/user/:id/role`** `{role:'admin'|'user'}` — `auth.admin.updateUserById(app_metadata.role)` (merge).
  Confirmation UI (opération sensible : accorde/retire l'accès admin).
- **`/user/:id/suspend`** `{suspend:bool}` — `auth.admin.updateUserById(ban_duration)` (bannit ~100 ans
  ou `none`). La fiche badge « suspendu » (`admin_user_detail.user.banned` = `banned_until > now()`).

**Anti auto-verrouillage** : `norva-admin` refuse à un admin de **se rétrograder** (`role→user`) ou de
**se suspendre** lui-même (`userId === actorId`) — évite de se verrouiller hors du panneau.

### 🛡️ Page Système — santé, infra, flags, audit
- **Snapshot** : bandeau santé dérivé de `admin_overview` (fraîcheur du snapshot, crons
  actifs/pause/échecs, sources en erreur, ST IA en cours/échoués).
- **Infra temps réel** : `POST norva-admin/health` (admin-gated) ping **côté serveur** gateway + relay
  (URLs = secrets, résolues via env → `cloud_runtime_config`) + un `select` DB. Réponse HTTP = « up »
  + latence ms ; timeout/erreur = « down ». L'edge est « up » implicitement (la fonction répond).
  Bouton ↻ pour re-ping. Rien n'est exposé au navigateur — seul le statut/latence remonte.
- **Feature flags** : `admin_feature_flags` (key/enabled/description) + RPCs `admin_flags_list` /
  `admin_flag_set` / `admin_flag_create` / `admin_flag_delete` (is_admin gated). Switches on/off,
  création, suppression. Reader SQL server-only `public.feature_flag(key)` (défaut false, révoqué
  d'anon/authenticated). **Flags câblés à de vrais consommateurs** :
  - **`enrichment_paused`** → `norva-playback/audio-backfill` (`runAudioBackfill`) court-circuite tout
    le backfill au prochain tick quand le flag est ON — **kill switch provider** (fail-open si le flag
    est illisible). Aucune connexion provider ouverte tant qu'il est actif.
  - **`maintenance_banner`** → lu par l'app via l'RPC **anon** `app_public_flags()` (whitelist :
    n'expose QUE ce flag) ; `public/js/maintenance-banner.js` pose une bannière fixe en bas pour tous
    les visiteurs (re-check toutes les 60 s). `signups_open` reste un exemple non câblé.
- **Journal d'audit** : `admin_audit_feed(p_limit, p_kind, p_before)` → derniers `admin_events`
  **globaux** (toutes actions admin, jointe à l'email du client) → liste cliquable → fiche.
  **Pagination keyset** : « ⌄ Charger plus » recharge des lots de 80 strictement plus anciens que le
  dernier chargé (curseur `created_at`, pas d'OFFSET). Servi par l'index global
  `idx_admin_events_created (created_at desc)`. **Rétention** : cron hebdo
  `norva-admin-events-prune` (dim. 04:15 UTC) supprime les événements > 180 jours — la table reste
  bornée à l'échelle (les événements sync sont déjà exactement-une-fois par source/kind).

### 🔔 Alerting proactif (email sans ouvrir le dashboard)
Cron **`norva-ops-alert`** (toutes les 15 min) → `POST norva-admin/ops-alert` (token backfill, ou JWT
admin pour un test manuel). La route vérifie : **snapshot_stale** (> 20 min → la machinerie cron est
en panne), **sources_error**, **sources_incomplete**, **cron_fails_24h** (compteurs lus depuis le
cache — gratuit) + **gateway_down** / **relay_down** (pings live). **Cooldown 6 h par clé** via
`admin_alert_state` (un incident continu = 4 emails/jour max) ; la ligne d'état est supprimée dès que
la condition guérit → une nouvelle occurrence alerte immédiatement. Email Resend (`RESEND_API_KEY`,
from `AUTH_EMAIL_FROM`) à tous les admins (`admin_alert_recipients()`, service-only — les emails
admins ne sont pas énumérables depuis le client). Échec d'envoi → pas de mise à jour d'état → retenté
au sweep suivant.

### Hooks timeline (événements lifecycle réels)
`enqueueImportNotification` (moteur de sync partagé) écrit désormais aussi un `admin_events`
(`sync_started` / `sync_done` / `sync_failed`) — **exactement une fois par source/kind** (le `.select()`
sur l'upsert `ignoreDuplicates` ne renvoie que les insertions neuves). Ces événements réels rejoignent
la timeline de la fiche et le journal d'audit, en plus des événements synthétiques (inscription,
provider ajouté, dernier sync).

---

## 7. Inventaire technique (fichiers & objets)

**Migrations** (`supabase/migrations/`, appliquées en live via MCP — non auto-appliquées par le déploiement) :
| Fichier | Contenu |
|---|---|
| `…040000_admin_dashboard_mvp.sql` | `is_admin()`, `admin_audit_log`, 4 RPCs Ops (definer, gate) |
| `…050000_admin_dashboard_cache.sql` | table `admin_dashboard_cache` + `refresh_admin_dashboard()` + RPCs recâblées sur le cache |
| `…060000_admin_dashboard_metrics.sql` | ETA / jamais sondé / % résolu + classification fenêtre/dimension des crons |
| `…070000_admin_cron_fail_metric.sql` | échecs cron = `status='failed'` |
| `…080000_admin_incomplete_vod_only.sql` | « sync incomplète » = VOD-only (pas live-only) |
| `…090000_admin_dashboard_scale_driving_accounts.sql` | `admin_enrichment_accounts` + scope Ops aux pilotes (cap 300) |
| `…110000_admin_users_page.sql` | RPC Users paginée |
| `…120000_admin_user_detail.sql` | RPC détail par user (profil + sources + enrichissement) |
| `…130000_admin_user_detail_volatile.sql` | hotfix : `admin_user_detail` VOLATILE (SET interdit en STABLE) |
| `…140000_admin_crm_relational.sql` | tables notes/tags/client_tags/events + RPCs CRM (read + mutations) |

**Objets DB** : `is_admin()`, `refresh_admin_dashboard()`, `admin_overview/_sources/_enrichment_coverage/_cron_health`, `admin_users_page(…)`, `admin_user_detail(uuid)`, `admin_client_crm(uuid)`, `admin_note_add/_note_delete/_tag_create/_tag_toggle`, tables `admin_dashboard_cache`, `admin_audit_log`, `admin_enrichment_accounts`, `admin_notes`, `admin_tags`, `admin_client_tags`, `admin_events`. Cron `admin-dashboard-refresh` (`2-57/10 * * * *`). Rétention historique cron : `norva-cron-history-prune` (7 j, hebdo).

**Edge** : route `/admin/resync/{sourceId}` dans `supabase/functions/norva-source-sync/index.ts`.

**Frontend** :
- `public/js/pages/AdminPage.js` — **shell CRM** autonome (RPC client `_rpc`, `isAdmin`, `show`,
  `_ensureLayout` [sidebar + topbar + `#crm-view`], routing `_navigate`, pages `_pageCockpit/
  _pageClients/_pageClientDetail/_pageProviders/_pageMoteur/_pageSysteme`, fiche `_renderFiche`,
  renderers `_renderOverview/_renderSources/_renderEnrich/_renderCron/_renderUsers`, `_loadUsers`,
  actions `_resync`, helpers `cronHuman/timeAgo/n/esc`). Chargé `?v=11`.
- `public/app.html` — lien nav caché `#nav-admin`, `<div id="page-admin" class="page">`, `<script>`.
- `public/js/app.js` — enregistrement `this.pages.admin`, gating de nav via `isAdmin()`.

**Comptes pilotes actuels** (`admin_enrichment_accounts`) : super8k (`c5be5ac4…`), apdxes/jeremy
(`0b971271…`), airo (`7bdab1df…`).

---

## 8. Déploiement

- **RPCs / migrations** : appliquées **manuellement** en live (`mcp apply_migration` / `execute_sql`) —
  elles ne sont PAS auto-appliquées par les workflows.
- **Frontend** (`AdminPage.js`, `app.html`) : déployé par **Cloudflare Pages** au push sur `main`.
  Toujours **bumper le cache-bust** `AdminPage.js?v=N` dans `app.html` à chaque changement JS.
- **Edge** (`norva-source-sync`) : déployé par le workflow au push sur `main`.
- Flux : commit sur la branche → PR → merge (squash) → déploiement.

---

## 9. Historique des correctifs notables

- **`admin_sources: 500` (57014)** : timeout 8 s sur agrégations par source → **résolu** par le cache
  précalculé + cron 10 min.
- **« 1 échec cron 24 h » fantôme** : le metric comptait `status <> 'succeeded'` (attrapait
  running/starting) → passé à `status = 'failed'`.
- **AtlasPro « sync incomplète » faux positif** : provider live-only (0 VOD) → détecteur restreint aux
  sources avec media VOD.
- **Scalabilité** : refresh O(sources × titres) → borné aux comptes pilotes + sources en problème.
- **Badge « ✓ complet » trompeur** (à côté de 61 %) → renommé **« ✓ sondé »** (1ʳᵉ passe ≠ 100 % résolu).
