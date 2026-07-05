# Norva — Audit du CRM Admin (dashboard) — état, infos périmées, manques vs CRM premium

> **Date : 2026-07-03 (soir).** Méthode : lecture exhaustive de `public/js/pages/AdminPage.js`
> (1 208 lignes), des **22 migrations** `admin_*`, de l'edge `norva-admin` (272 lignes), et
> **vérifications live en base** (crons réels, contenus des tables billing, kinds d'événements
> réellement journalisés). Contexte : le CRM a été construit le **1ᵉʳ juillet** ; depuis, le
> produit a changé de nature — **rail de paiement Stancer complet** (essai 7 j, charges USD,
> cancel flow + contre-offre, dunning, win-back, relances), **emails lifecycle**, **funnel
> analytics**, **push FCM**, **identités Phase A/B**. Le CRM, lui, n'a pas bougé : il pilote
> encore un produit gratuit de curation de catalogues.

**Verdict en une phrase : le CRM est un excellent outil d'ops catalogue/moteur, mais c'est un
CRM SANS le C de « commerce » — zéro donnée financière, zéro vue abonnement, zéro support
client — alors que toutes les données existent déjà en base.**

---

## Partie A — Inventaire de l'existant (ce qui est là, et ce qui est bien)

| Page | Contenu actuel | État |
|------|----------------|------|
| **Cockpit** | KPI clients (total/actifs 24h-7j/nouveaux 7-30j), providers & catalogue (sources, erreurs, sync incomplète, identités, films/séries), sous-titres IA, crons + alertes sources | 🟢 solide pour l'ops |
| **Clients** | Liste paginée serveur (recherche email/ID, tri, filtre segment, CSV 10 k), actions bulk sur segment | 🟢 scalable |
| **Fiche 360°** | Profil (rôle, pilote, email vérifié, suspendu, provider auth), actions (renvoyer confirmation, rôle, suspendre), sources + re-sync, enrichissement audio, tags, notes, timeline | 🟡 riche côté catalogue, vide côté business |
| **Providers** | Panels pilotes + sources en problème (borné 300) | 🟢 |
| **Identités** | Identités canoniques, détection miroir multi-marques | 🟢 |
| **Moteur** | Couverture enrichissement par panel (avec alarme « provider muet » post-incident Ninja), backlogs TMDB, table des crons | 🟢 |
| **Système** | Santé snapshot, ping infra (edge/DB/gateway/relay), feature flags CRUD, journal d'audit keyset | 🟢 |
| **Backend** | Snapshot cache 10 min (`refresh_admin_dashboard`), RPCs gated `is_admin()` server-side, `admin_audit_log` + `admin_events`, alerting proactif email (6 conditions, cooldown 6 h), edge `norva-admin` (health, ops-alert, resend-confirmation, rôle, suspend, anti self-lockout) | 🟢 architecture saine |

**À garder tel quel** : le modèle snapshot-cache (coût constant), le gating serveur, le keyset
pagination, l'anti self-lockout, l'alarme « provider muet ». Rien de ce qui suit ne remet en
cause l'architecture — il s'agit d'**ajouter les dimensions manquantes** dessus.

---

## Partie B — Ce qui est FAUX ou PÉRIMÉ aujourd'hui (vérifié en live)

### B1. L'angle mort billing : le CRM ignore ce que Norva vend désormais
Vérifié en base à l'instant : `cloud_entitlement_projection` contient **2 trialing + 1 active**
(providers `stancer`/`system`), `cloud_stancer_payments` contient **6 paiements** (2 authorized,
4 require_payment_method), `cloud_stancer_customers` porte plan/période/montant/carte, et la
projection porte 21 colonnes dont `plan_code`, `trial_ends_at`, `current_period_end`,
`dunning_stage`, `welcome_email_at`… **Aucune de ces données n'apparaît nulle part dans le CRM** :
ni KPI Cockpit, ni colonne dans Clients, ni panneau dans la fiche, ni export CSV. Un client peut
être en échec de paiement (dunning stage 3, expulsion imminente) et sa fiche 360° affiche
« email vérifié · 2 sources · dernière activité il y a 3 h ». **La page publique
`subscription.html` en dit plus à l'utilisateur que le CRM n'en dit à l'admin.**

### B2. Les crons les plus critiques du business sont mal classés
`admin_cron_health` classe par regex de nom et de schedule écrites le 1ᵉʳ juillet. Vérifié live :
`norva-stancer-billing` (`23 * * * *` — **celui qui débite les cartes**) et `norva-lifecycle`
(`*/15 * * * *` — **celui qui envoie tous les emails/push business**) tombent tous deux dans
`kind='autre'`, `window='—'`. La fenêtre est déduite du substring `6-23`/`0-5` du schedule — un
cron continu n'a pas de fenêtre et s'affiche comme non-classé. Résultat : dans la table Moteur,
les deux jobs dont dépend le revenu sont visuellement indistinguables d'un cron de vacuum.

### B3. L'alerting proactif est aveugle au billing
Conditions actuelles de `ops-alert` : `snapshot_stale, sources_error, sources_incomplete,
cron_fails_24h, gateway_down, relay_down`. Donc : si `norva-stancer-billing` échoue, c'est noyé
dans `cron_fails_24h` générique ; si les charges échouent en masse (carte refusée, clé Stancer
expirée, passage prod raté), si `past_due` s'accumule, si Resend tombe → **aucune alerte**. Le
moteur de revenu peut être en panne un week-end entier sans email.

### B4. La timeline client est quasi vide — et le restera
Kinds réellement présents dans `admin_events` (live) : `sync_started` (5), `sync_done` (5).
C'est tout. La timeline affiche signup (dérivé) + syncs + actions admin. **Aucun événement de
vie réelle du client n'y entre** : essai démarré, carte validée, paiement réussi/échoué,
annulation (+ raison !), contre-offre acceptée, changement de plan, win-back, emails envoyés.
Ces événements existent pourtant tous en base (`cloud_stancer_payments`, `cloud_cancel_feedback`,
stamps email de la projection) — personne ne les verse dans la timeline ni ne les lit à la volée.

### B5. « Actifs 24 h / 7 j » ne mesure pas l'activité
Les KPI Cockpit lisent `auth.users.last_sign_in_at`. Or les sessions Supabase persistent (refresh
token) : un utilisateur qui regarde Norva tous les soirs sans se re-loguer garde un
`last_sign_in_at` vieux de plusieurs semaines. Le chiffre **sous-compte structurellement** les
actifs réels. La vraie activité est dans `cloud_watch_history.updated_at` (et
`cloud_devices.last_seen` pour la TV). Libellé actuel trompeur : c'est « connexions », pas
« actifs ».

### B6. La résolution d'identité de la fiche utilise l'heuristique pré-Phase A
`admin_user_detail` / le snapshot joignent `catalog_provider_identities` **par display_name**
(`where cpi2.display_name = s.display_name`). Or la Phase A a précisément établi que le nom
d'affichage ne fiabilise rien (marques miroirs, renommages) — la résolution canonique passe par
l'empreinte de stream IDs. Une source renommée par son owner affiche « non résolue » (ou pire,
matche une autre marque homonyme) alors que le registre la connaît.

### B7. Le ping infra ignore les rails business
`norva-admin/health` teste edge, DB, gateway (Railway), relay. **Pas Stancer** (l'API qui
encaisse), **pas Resend** (les emails transactionnels), pas FCM. Le jour où la clé Stancer
expire, « Infra temps réel » est tout vert.

### B8. L'état des gates billing est invisible depuis le CRM
Le go-live paiements se pilote par secrets edge (`NORVA_STANCER_MODE` test/live,
`NORVA_BILLING_MODE` legacy, `NORVA_ENTITLEMENTS_MODE` observe/enforce,
`NORVA_LIFECYCLE_BILLING_LIVE`). La page Système affiche les feature flags Postgres — qui ne
gouvernent **aucun** de ces gates. L'admin ne peut ni voir « on est en test ou en prod ? »,
« l'enforcement est-il actif ? », ni vérifier `norva-stancer/health` (la route existe déjà et
expose exactement ces booléens non-secrets).

### B9. Détails additionnels périmés
- **Export CSV clients** : colonnes figées au 1ᵉʳ juillet — pas de plan/statut/valeur.
- **Le funnel `norva_funnel_daily` et `cloud_cancel_feedback`** (créés aujourd'hui) n'ont aucune
  surface d'affichage.
- **`cloud_import_notifications`** (14 lignes) et **`cloud_devices`** (12 appareils) : invisibles
  dans la fiche.
- Le footer sidebar dit « rôle app_metadata.role » mais la topbar n'affiche pas **qui** est
  connecté en admin (multi-admin = actions attribuées à l'aveugle avant de cliquer).

---

## Partie C — Ce qui MANQUE pour un CRM premium complet

Benchmark : ce que donnent Stripe Dashboard / Baremetrics / ChartMogul (finance), Zendesk /
Intercom / Crisp (support), et les back-offices SVOD internes.

### C1. 💶 Une page **Finance** (le manque n°1, demandé explicitement)
Toutes les données existent déjà — il ne manque QUE l'agrégation et l'affichage :
- **MRR / ARR** ventilés **par plan** (Plus/Family), **par période** (mensuel/annuel — l'annuel
  normalisé /12), **par rail** (`provider` : stancer web / play / system-manuel). Source :
  projection `status in (trialing,active,cancelled_at_period_end,past_due,grace)` ×
  `cloud_stancer_customers.amount_cents`.
- **Revenu encaissé** par jour/semaine/mois (charges `captured` de `cloud_stancer_payments`) +
  cumul du mois.
- **Compteurs par statut** : essais en cours (avec J-x), actifs, past_due (par stage de dunning),
  annulations programmées, expirés — chaque carte cliquable vers la liste Clients pré-filtrée.
- **Funnel de conversion** : la vue `norva_funnel_daily` (signup → source → lecture → checkout →
  essai → conversion → cancel/save/win-back) — elle tourne déjà, il suffit d'un graphe/table.
- **Churn & raisons** : taux de cancel, split des raisons (`cloud_cancel_feedback`), taux de save
  de la contre-offre 50 %.
- **Échéances** : renouvellements dus < 24 h / < 7 j (préviens les pics), essais finissant sous
  48 h (= charges imminentes).
- **Paiements récents** : table des 50 derniers PI/charges (statut, montant, kind, client
  cliquable) + **export CSV paiements**.

### C2. 🧾 Fiche client : panneau « Abonnement & paiements » + actions billing
- Panneau : statut (badge), plan + période + montant, carte `•••• 0077 · exp 12/30`, dates
  (essai/période), dunning stage, remise save-offer en attente, provider rail.
- **Historique des paiements** du client (tous les `cloud_stancer_payments`).
- **Actions admin billing** (chacune journalisée `admin_events` + `admin_audit_log`) :
  prolonger l'essai (+7 j), offrir un mois (comp), appliquer une remise one-shot, forcer un
  retry de charge (period_end → now), reset dunning, annuler l'abonnement, expirer. C'est le
  cœur du support : aujourd'hui répondre à « mon paiement a échoué mais j'ai payé » oblige à
  ouvrir psql.
- Événements billing versés dans la **timeline** (B4).

### C3. 🎫 Module **Tickets / Support** (demandé explicitement — inexistant : 0 table)
Aujourd'hui le support = `mailto:support@norva.tv`, boîte externe, zéro suivi, zéro lien fiche.
Minimum premium bespoke (cohérent avec le CRM existant) :
- Table `cloud_support_tickets` (id, user_id, subject, body, status `open/pending/closed`,
  priority, channel `in_app/email`, assigned_to, created/updated) + `cloud_support_messages`
  (fil de réponses, `from_admin`).
- **Côté client** : formulaire « Contact support » dans Settings + subscription.html (le cancel
  flow « Something isn't working » créerait un ticket au lieu d'un mailto → le motif technique
  devient traçable).
- **Côté CRM** : page Support (liste, filtres statut/priorité, âge du ticket), réponse depuis le
  CRM (envoi email via Resend + fil conservé), lien bidirectionnel fiche client, badge compteur
  « open » dans la sidebar, alerte ops si ticket > 24 h sans réponse.
- Notifications : email à l'admin à la création (rail ops-alert existant).

### C4. ✉️ Journal des communications par client
Les envois sont aujourd'hui des **stamps écrasables** (`welcome_email_at`,
`trial_reminder_email_at`, `dunning_stage`…) — pas d'historique. Ajouter un
`cloud_email_log` (user_id, kind, subject, sent_at, provider_id) alimenté par
`norva-lifecycle`/billing (1 insert best-effort à chaque envoi), affiché dans la fiche
(« Emails reçus ») + KPI d'envois 24 h/7 j par type dans Finance. Idem push FCM quand actif.

### C5. 📺 Devices & appairages dans la fiche
12 appareils en base (`cloud_devices`, `cloud_pairing_sessions`) — invisibles. Panneau fiche :
type, nom, dernière activité, + action « délier » (support multi-écrans = demandes fréquentes
en SVOD).

### C6. 📊 Engagement dans la fiche
`cloud_watch_history` existe : minutes vues 7 j/30 j, dernier contenu lu, top 3 — trois requêtes
bornées par user. C'est le contexte qu'il faut pour juger un ticket ou un risque de churn
(« n'a rien regardé depuis 12 j + essai finit demain » = candidat au save).

### C7. 🎯 Segments par statut d'abonnement dans Clients
Le filtre actuel = tags manuels. Ajouter : colonne **Plan/Statut** dans la liste + filtre
`trialing / active / past_due / cancelled / expired / free` (+ tri par valeur). Les listes
« past_due à rattraper » et « essais finissant cette semaine » sont les deux vues de travail
quotidiennes d'un CRM d'abonnement. Export CSV enrichi de ces colonnes.

### C8. 🚨 Alerting billing (extension d'ops-alert, même rail)
Nouvelles conditions : échec du job `norva-stancer-billing` (nommément), taux d'échec de charges
24 h > seuil, `past_due` total > seuil, `require_payment_method` > 2 h sur un kind `renewal`,
Stancer API down, Resend down, ticket support > 24 h sans réponse (C3).

### C9. 🛡️ Panneau « État billing » dans Système
Lecture seule : ping `norva-stancer/health` (configured/mode/test_key — la route existe),
affichage des modes (`observe/enforce`, `legacy`, `LIFECYCLE_BILLING_LIVE`) via une petite RPC
config, + ping Stancer/Resend dans « Infra temps réel » (B7). Le jour du go-live prod, la
checklist se vérifie depuis le CRM.

### C10. Divers premium (P2)
- **RGPD** : export des données d'un client + bouton suppression de compte depuis la fiche
  (`norva-account-delete` existe déjà — pas exposé).
- **Cohortes de rétention** simples (par mois d'inscription × actifs).
- **Recherche globale** (client/source/ticket) au clavier.
- **Remboursements** : à câbler quand Stancer sera en clé live (route refund + action fiche).
- Topbar : afficher l'email de l'admin connecté (multi-admin, B9).

---

## Partie D — Plan d'exécution priorisé

### P0 — « le CRM voit enfin le business » (1 lot)
| # | Chantier | Contenu |
|---|----------|---------|
| P0-1 | **Page Finance** | Nouvelle entrée sidebar 💶 ; RPC `admin_finance` (agrégats projection × mapping × payments — requêtes bornées, pattern snapshot si besoin) : MRR/ARR par plan/période/rail, statuts, encaissé 30 j, échéances, funnel (`norva_funnel_daily`), churn + raisons + saves, 50 derniers paiements, CSV |
| P0-2 | **Fiche : panneau Abonnement** | RPC `admin_user_billing(p_user_id)` : projection + mapping + historique paiements + emails stamps ; badges statut ; remise en attente |
| P0-3 | **Cockpit : groupe 💶 Revenus** | 5-6 cartes (MRR, essais actifs, past_due, conversions 7 j, encaissé 30 j) issues de `admin_finance` — cliquables vers Finance/Clients filtrés |
| P0-4 | **Clients : colonne + filtre statut d'abo** | `admin_users_page` +plan/statut (+ filtre `p_billing_status`), CSV enrichi |
| P0-5 | **Alerting billing** | ops-alert +4 conditions (cron billing, échecs de charge, past_due seuil, Stancer down) |
| P0-6 | **Correctifs périmés** | Crons : kind `billing`/`lifecycle` + fenêtre « continu » ; libellé « Connectés 7 j » ou bascule sur watch_history ; timeline : verser les événements billing (source `cloud_stancer_payments` + `cloud_cancel_feedback` lus à la volée dans `admin_client_crm`) |

### P1 — « le CRM travaille pour toi »
| # | Chantier |
|---|----------|
| P1-1 | **Module Tickets** complet (C3) : 2 tables + formulaire in-app + page Support + réponse Resend + compteur sidebar + alerte 24 h |
| P1-2 | **Actions billing admin** (C2) : extend trial / comp / remise / retry / reset dunning / cancel — routes `norva-admin` + boutons fiche, journalisées |
| P1-3 | **Journal emails** (C4) : `cloud_email_log` + panneau fiche + KPI envois |
| P1-4 | **Devices dans la fiche** (C5) + délier |
| P1-5 | **Panneau état billing** dans Système (C9) + pings Stancer/Resend |
| P1-6 | **Identité par empreinte** dans fiche/snapshot (B6) — réutiliser le résolveur Phase A |

### P2 — confort premium
Engagement fiche (C6) · cohortes · recherche globale · RGPD export/delete · refunds (clé live) ·
segments dynamiques sauvegardés · topbar identité admin.

### À ne PAS faire
- Ne pas passer au temps réel partout : le snapshot 10 min reste le bon modèle (la Finance peut
  être snapshotée pareil) ; seules la fiche et les paiements récents méritent du live borné.
- Ne pas dupliquer un Stripe : pas de graphiques exotiques tant qu'il y a < 1 000 abonnés — les
  compteurs + tables cliquables font le travail.
- Ne pas brancher un Zendesk externe : le volume ne le justifie pas et le CRM bespoke garde la
  fiche 360° unifiée (le module C3 suffit largement).

---

*Suite de `ONBOARDING-AUDIT-V4-DATA.md` (funnel & billing) — ce document couvre la face admin.
Voir `docs/PAYMENTS-STATUS.md` pour l'état du rail de paiement que la page Finance exposera.*

---

## Addendum — lot P0 livré (même jour)

Migration `20260703240000_admin_finance_p0.sql` (appliquée live) + `AdminPage.js` (v24) +
`norva-admin` :

- **P0-1 Page Finance 💶** : `admin_finance()` live — MRR/ARR (+ MRR-essai « à venir »,
  abos sans montant connu à part), abonnés par statut (cartes cliquables → Clients pré-filtrés),
  échéances (essais → prélèvement < 48 h, renouvellements < 7 j, remises 50 % en attente),
  MRR par plan × période × rail, funnel 30 j (libellés français), annulations / saves / taux de
  save / raisons, 50 derniers paiements (lignes cliquables → fiche) + export CSV.
- **P0-2 Fiche : panneau « 💳 Abonnement & paiements »** : `admin_user_billing(uuid)` — statut,
  plan facturé, carte, dates essai/période, dunning, remise en attente, stamps emails lifecycle,
  historique complet des paiements, feedback d'annulation.
- **P0-3 Cockpit : groupe « 💶 Revenus »** en tête (MRR, essais, actifs payants, échecs paiement,
  conversions 7 j, encaissé 30 j) depuis le snapshot.
- **P0-4 Clients** : colonne « Abonnement » (badge statut+plan), filtre par statut d'abo
  (`p_billing_status` : essai / actifs / échec paiement / annulation prévue / expirés / sans abo),
  export CSV enrichi (statut, plan, période, montant).
- **P0-5 Alerting billing** : ops-alert +3 conditions — `billing_cron_fails` (échecs des crons
  norva-stancer-billing / norva-lifecycle nommément), `billing_past_due` (≥ 3 simultanés),
  `stancer_down` (ping api.stancer.com).
- **P0-6 Correctifs périmés** : crons reclassés `billing`/`lifecycle` + fenêtre « ♾️ continu »
  (tri en tête de table) ; Cockpit « Actifs » → « **Connectés** 24 h/7 j » + nouvelle carte
  « **Regardent** 7 j » (`users_watching_*` sur watch_history) ; **timeline client** enrichie à la
  volée : checkout/carte validée/prélèvements/MAJ carte/changement plan/réabonnement
  (`cloud_stancer_payments`), essai démarré, annulation avec raison, contre-offre acceptée
  (`cloud_cancel_feedback`).

Vérifié live après application : snapshot expose `billing_*` + `users_watching_*`, les 2 crons
billing sont classés, `admin_finance` agrège correctement (MRR-essai 8,99 $, 1 essai < 48 h,
funnel 5 étapes). Restent P1 : tickets, actions billing admin, journal emails, devices, état des
gates billing dans Système, identité par empreinte.

## Addendum 2 — comptes internes + module Support (même jour, demande owner)

Migration `20260704010000_internal_accounts_support.sql` (appliquée live en 3 parties) +
`norva-support` (nouvelle edge function) + `public/support.html` + AdminPage v25 :

1. **Comptes internes / VIP** : les 3 comptes existants (owner + hernandez.jeremy@outlook.fr)
   étaient des comptes de test Stancer qui faussaient les datas. Nouveau registre
   `admin_internal_accounts` (backfillé avec les 3) : **exclu de TOUTES les métriques finance**
   (`admin_finance`, compteurs `billing_*` du snapshot, `norva_funnel_daily` — vérifié : funnel
   vide, MRR 0, compteurs 0 après application). Accès **VIP permanent** posé (system / active /
   family / fin 2099) sauf sur le rail stancer de test (conservé pour les E2E). Badge « interne »
   dans la liste Clients + état/toggle « ⭐ marquer interne » dans la fiche (journalisé) — tout
   futur compte de test s'exclut en un clic.
2. **Module Support complet** :
   - **Client** : `support.html` (anglais, brandé) — ouvrir un ticket, fils de discussion,
     réponse ; bouton « Contact support » dans Settings (web + APK) ; le cancel-flow
     « Something isn't working » pointe désormais sur la page support (motif tracé) au lieu d'un
     mailto.
   - **Emails** : chaque message client → email à **support@norva.tv** (reply-to = client) ;
     chaque réponse admin depuis le CRM → email brandé au client (« Open my support page »).
   - **CRM** : page **🎫 Support** sous Clients (onglets À répondre / Ouverts / En attente /
     Fermés / Tous, aperçu du dernier message, tri « à répondre » en tête), **vue ticket** (fil
     complet, réponse, fermer/rouvrir, lien fiche), **panneau « Tickets support » dans la fiche**
     (compact, ouverts d'abord, scalable — total affiché si > 10), **badge rouge sidebar** =
     tickets à répondre.
   - **Alerting** : ops-alert emaile si un ticket attend une réponse depuis **> 24 h**
     (`support_stale`), compteurs support dans le snapshot.

---

## Addendum 3 — Remédiation complète de l'audit design/UX/fonctionnalités (2026-07-05)

> Passe de correction **une par une** des 65 findings de l'audit design + UX + fonctionnalités
> (3 haute, 20 moyenne, 42 basse ; 17 bugs/sécurité). Répartie en 5 lots. Vérifiée live contre
> l'architecture réelle (RPCs `admin_*`, edge `norva-admin`, tables `admin_*`/`cloud_support_*`),
> aucune approximation.

### Lot 1 — Sécurité / backend (migration `20260705040000_admin_grants_hardening.sql` + edge `norva-admin`)
Défense en profondeur : aucun de ces points n'était exploitable seul (RPCs gated `is_admin()`,
tables RLS-sans-policy → 0 ligne), mais on retire les grants dormants pour que la sécurité ne
repose plus sur un seul contrôle.
- **`refresh_admin_dashboard()` (HAUTE)** : SECURITY DEFINER, sans gate `is_admin()`, agrégat
  full-DB 180 s/64 Mo, était **anon-callable → DoS scriptable non authentifié**. `revoke execute
  from anon, authenticated` (déjà révoqué live pendant l'audit, gravé ici pour survivre à toute
  recréation). Seuls pg_cron (postgres) + service_role en ont besoin.
- **4 RPCs de lecture cache** (`admin_overview/sources/cron_health/enrichment_coverage`) :
  `revoke from public, anon` + `grant to authenticated` (grant anon = grant mort, aligné sur le
  reste des `admin_*`).
- **11 tables** (`admin_dashboard_cache`, `admin_notes`, `admin_feature_flags`, `admin_tags`,
  `admin_client_tags`, `admin_internal_accounts`, `admin_events`, `admin_alert_state`,
  `admin_enrichment_accounts`, `cloud_support_tickets`, `cloud_support_messages`) :
  `revoke all from anon, authenticated` (les RPCs SECURITY DEFINER owned-by-postgres gardent
  l'accès ; rien d'autre ne doit toucher ces tables en direct).
- **Anti-lockout dernier admin** : `admin_count_active()` (service_role only) + garde côté edge
  `norva-admin` — refuse une action rôle→user / suspend qui ferait tomber le compte d'admins
  actifs à 0 (l'edge bloquait déjà l'auto-démotion ; deux admins pouvaient se démolir mutuellement).
- **`norva-admin` durci** : `timingSafeEqual` sur le token ops-alert (au lieu de `===`, fuite de
  timing) ; le probe santé DB capture désormais l'erreur (`{ error }`) au lieu de l'avaler.

### Lot 2 — Bugs frontend (races, escaping, health)
- **Race fiche client 360° (HAUTE)** : `_pageClientDetail` + ses 3 panneaux async
  (`_loadBilling`/`_loadCrm`/`_loadUserTickets`) écrivaient dans des IDs de panneaux identiques —
  ouvrir client A puis vite client B pouvait peindre les données de A dans la fiche de B. Garde
  `if (this._crmUser !== userId) return;` après **chaque** await ; `_renderBillingPanel` reçoit
  désormais `userId` explicitement (au lieu de lire le `_crmUser` mutable au moment du clic toggle).
- **Race navigation de page** : token monotone `this._nav` incrémenté à chaque `_navigate` ;
  `_pageCockpit` et `_pageTicket` bail si le token a changé pendant le fetch.
- **Race liste clients** : `_loadUsers` a un `seq` de garde (frappe rapide / clics pager
  enchaînés → seule la réponse la plus récente peint) + pager gelé pendant le fetch + placeholder
  « Chargement… » au 1ᵉʳ chargement.
- **Bug `client:undefined`** : les lignes de tickets Support portaient `.user-row` **et**
  `data-ticket-id` (sans `data-user-id`) — le handler délégué `.user-row` naviguait vers
  `client:undefined` en parallèle du listener de ticket. Scellé : le handler exige désormais
  `.user-row[data-user-id]`.
- **Escaping/HTML** : `resolved_pct` (fiche + moteur) coercé en `Number(x)||0` ; `s.status` de
  l'infra santé échappé ; label des services santé échappé.
- **Santé infra** : détail d'erreur (redigé côté serveur) affiché sur un service `down`.

### Lot 3 — UX (feedback non bloquant, états, CSV)
- **Primitives UX non bloquantes** : `_toast(msg,kind)`, `_confirm(message,opts)`,
  `_prompt(message,def)` (modale accessible, focus-piégé, Escape/Enter/backdrop, `role=dialog`
  `aria-modal`) remplacent **tous** les `window.alert/confirm/prompt` natifs (0 restant vérifié).
- **Boutons d'action** : close/reopen ticket, envoi réponse, toggle interne, resync → désactivés
  pendant la requête, label restauré + toast d'erreur en cas d'échec (avant : label figé sur
  l'erreur). Reply support exige ≥ 2 caractères. Resync auto-réarme après succès.
- **États vides** : crons, matching TMDB (placeholder + peint l'erreur si le fetch échoue),
  note/réponse vides → toast au lieu d'un retour silencieux.
- **Blast-radius bulk-tag** : la barre d'action segment n'affiche **plus** `_users.total`
  (trompeur : c'était le compte tag ∩ recherche ∩ billing, alors que le RPC agit sur TOUS les
  porteurs du tag) — libellé « tous les clients portant ce segment », le RPC rapporte le vrai
  compte après coup.
- **Filtre finance→clients** : cliquer une status-card réinitialise recherche + tag (le compte
  affiché correspond à la liste d'arrivée).
- **CSV (2 exports)** : garde anti-injection de formule — une valeur commençant par `= + - @`
  (email/tag hostile) est préfixée d'une apostrophe pour qu'Excel/Sheets ne l'évalue pas.

### Lot 4 — Design (tokens, contraste)
- Gris `#66707e` (sous le ratio WCAG AA sur fond sombre) → `#828ea1` partout (foot sidebar,
  entêtes de fil support).
- Badge `.gray` : contraste texte/fond relevé.
- Ellipsis fil d'ariane (email long ne pousse plus les contrôles topbar hors écran) ;
  `tl-sum` `min-width:0` pour ellipsis réelle ; correctifs mobile (nav centrée, inputs `min-width:0`).

### Lot 5 — Accessibilité (rôles, ARIA, clavier)
- **Nav clavier** : toutes les lignes/cartes cliquables (`.user-row`, `.alert-card`, `.audit-row`,
  `.tl-item[data-ticket-id]`, `.fin-status`, lignes identités/paiements/tickets) portent
  `role="button" tabindex="0"` + activation Enter/Espace (handler `keydown` délégué → `el.click()`).
- **Focus visible** : `:focus-visible` (outline) sur toutes ces cibles + nav + onglets + retour.
- **ARIA** : onglets Support `role="tab"`/`aria-selected` sous `role="tablist"` ; `aria-current`
  sur l'item de nav actif ; `aria-live=polite` sur le fil d'ariane ; `aria-label` sur nav (icône
  `aria-hidden`), refresh, switches de flags, boutons supprimer-flag ; `<main tabindex="-1">`
  reçoit le focus à la navigation (+ scroll reset).

**Validation** : `node --check` OK, suite `node --test tests/*.test.js` → 65/65 pass. AdminPage.js
n'est pas importé par les tests (classe navigateur) ; revue adversariale indépendante du diff en plus.
