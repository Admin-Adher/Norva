# Journal de session — 2026-06-28

> **But de ce document** : permettre de revenir sur cette journée *un autre jour*
> et tout recomprendre sans re-creuser. Trois problèmes enchaînés ont été résolus
> (panne login → refresh ultra-lent → onboarding bloqué à 94 %), plus un upgrade
> compute Supabase. Tout est déployé. Les détails SQL d'urgence vivent dans
> [`performance-status.md`](./performance-status.md) §4 (runbook) et §Incident ;
> ce journal raconte **le fil complet** et y renvoie.

---

## 0. TL;DR — état final (vérifié)

| Sujet | Avant | Après |
|---|---|---|
| **Login** (`auth/v1/token`) | 504 (impossible de se connecter) | **instantané** ✅ |
| **Refresh d'une page** | **616 s** (timeline mesurée) | **1,71 s** ✅ |
| **Onboarding** | bloqué « à 94 % » (tâche de fond visible) | **100 % dès que c'est utilisable**, le reste en fond invisible ✅ |
| **Compute Supabase** | MICRO (1 GB) — pool 60, CPU saturable | **SMALL (2 GB / 2 cœurs ARM)** ✅ |
| **super8k** (gros provider) | parké pendant la panne | **reprend en fond** (titles, offset ~148k/272k, `usable=true`) ✅ |
| **Connexions DB** | 60/60 (pool épuisé) | **19/60, 1 active** (sain) ✅ |

**Cause profonde commune des deux pannes** : **épuisement du pool de connexions
Postgres** (60 max sur MICRO), pas du *bloat* de table comme cru au départ (voir §3.2,
la correction de diagnostic la plus importante de la journée).

---

## 1. Le fil de la journée (chronologie)

1. **Panne login** — `auth/v1/token` renvoie 504, GoTrue n'arrive plus à joindre
   Postgres. → §2.
2. Une fois le login revenu, **chaque refresh est ultra-lent** (jusqu'à 616 s).
   On instrumente la console pour comprendre. → §3.
3. **Onboarding** : l'utilisateur reste « à 94 % » sur une étape de fond
   (« Finalize Norva — Preparing Home, Live TV and details »). On redéfinit le
   « 100 % » = « utilisable ». → §4.
4. **super8k** (272 780 items) avait été parké pour soulager la DB pendant la
   panne ; on le **relance** en fond. → §5.
5. On rend le **traceur console opt-in** (silencieux par défaut). → §3.5.

---

## 2. Problème A — Panne login (auth 504)

**Symptôme** : `auth/v1/token` (password *et* refresh_token) en **504** ;
logs GoTrue : `dial tcp [::1]:5432: i/o timeout`. La DB n'était **pas** saturée en
*nombre* de connexions (15/60) mais en **CPU/IO** : Postgres n'arrivait plus à
*forker* un backend pour GoTrue.

**3 causes racines empilées** (détail complet + SQL dans `performance-status.md`
§Incident 2026-06-28) :

1. **Troupeau de finalize** (`norva-source-sync`). Le watchdog (cron jobid 27,
   chaque minute) considérait un finalize « mort » si son dernier progrès datait de
   > 60 s. Sous charge, un lot de titres dépasse 60 s → le worker vivant *paraît*
   mort → le watchdog lance un **doublon** → lots plus lents → encore plus de faux
   re-kicks → **6-12 workers concurrents** martelant `cloud_titles`.
   **Fix** : *single-flight lease* — `config_hint.finalizeLease.until = now + TTL`
   (défaut 240 s, env `NORVA_FINALIZE_LEASE_TTL_MS`) posé **avant chaque lot** ; le
   watchdog **saute** toute source dont le bail est encore frais. → commit `d76053f`.

2. **`getEnrichmentProgress` en `COUNT(exact)`** (`norva-catalog`). 2× `count(exact)`
   sur ~68k lignes `cloud_titles`, qui prenaient **80-100 s pièce** sur une table
   fraîchement churnée (post-troupeau). La barre d'enrichissement *pollait toutes les
   ~2 s* → empilement plus vite que ça ne finit → 504. **C'est ce qui faisait flapper
   le login même après l'arrêt du troupeau.**
   **Fix** : `count:"estimated"` (estimation planner, ~ms) + cache in-isolate 30 s/user.
   → commit `0c5e9a9`.

3. **Inondation de polls côté client** (amplificateur). Le navigateur relançait les
   barres de progression / enrichissement en boucle serrée. **Fix** : voir §3.3
   (`e0dfb90`) — gardes anti-réentrance + arrêt propre des intervalles.

**Durable** : le single-flight (#1) empêche structurellement le troupeau de
revenir ; le `count:estimated` (#2) rend le hot-path indépendant de l'état de la table.

---

## 3. Problème B — Refresh ultra-lent (616 s → 1,71 s)

> « On a mis plein d'optimisations en cache dans la BD pourtant, pour que ce soit
> instantané ? » — la bonne question, qui a mené à la vraie cause.

### 3.1 Ce qu'on a mesuré (le traceur)

On a ajouté un **traceur de refresh** dans la console (`NorvaTrace`, dans
`public/js/cloudApi.js`) qui horodate chaque round-trip réseau, chaque cache
HIT/MISS, le handshake auth et les phases de boot — en ms depuis le début de
navigation. La timeline réelle (« 135 events over 616.26s ») montrait :
`/sources` 122 s, `/health` 125 s, `/media-items` 283 s, etc. — **tout** était lent,
pas une requête en particulier.

**Enseignement du traceur** (écrit dans le code) : un **hard refresh re-paie le
réseau pour tout**, car les caches *client* sont en mémoire (`new Map()`, effacés au
reload) — « caché dans la DB » accélère la *réponse serveur*, mais le navigateur
refait quand même tous les allers-retours à chaque reload.

### 3.2 ⚠️ La correction de diagnostic la plus importante de la journée

**Fausse piste** : j'ai d'abord cru à du **bloat** sur `cloud_titles` (churn massif
du finalize) et lancé du VACUUM (même planifié côté serveur via `cron.schedule` pour
contourner la limite 60 s du MCP).

**Mesure réelle** (`pg_stat_user_tables`) : `cloud_titles` = **61 MB / 87 565 lignes
vivantes / 9 903 mortes (11 %)** → **table SAINE, pas ballonnée**. Le VACUUM était
inutile (cron `norva_vacuum_cloud_titles` ensuite **dé-planifié**).

**Vraie cause** : **épuisement du pool de connexions** (60 max sur MICRO) provoqué par
l'**inondation de polls client** + des requêtes qui pendaient jusqu'à la limite
*wall-clock* de 150 s des edge functions. Quand les 60 slots sont pris, **toute**
nouvelle requête attend → tout paraît lent.

### 3.3 Les deux correctifs *code*

- **`e0dfb90` — stopper l'inondation de polls client.** Dans `public/js/app.js` :
  `startEnrichmentProgressPoll` gagne une garde anti-réentrance
  (`this._enrichInFlight`, try/finally), un **arrêt propre** (`this._stopEnrichPoll`)
  quand c'est *settled*/stalled/vide, un compteur d'échecs (3 → on coupe), et
  l'intervalle passe **45 s → 60 s**. Dans `public/js/cloudApi.js` : `warmUp` ne
  pingue plus `/media-items` (un `/health` suffit).

- **`a3eea41` — paralléliser `/home/rails`.** Dans `norva-catalog/index.ts`,
  `listHomeRails` faisait **6 awaits séquentiels** ; réécrit en **un seul
  `Promise.all`** (helper `when(cond, fn)`), rails assemblés dans l'ordre d'affichage
  puis filtrés (non-vides). Le mur d'attente passe de la *somme* au *max*.

### 3.4 L'upgrade SMALL — le facteur décisif

L'utilisateur a **upgradé le compute Supabase MICRO → SMALL** (2 GB / 2 cœurs ARM).
Combiné aux deux correctifs, le refresh est passé de **616 s à 1,71 s** (confirmé par
l'utilisateur : « c'est instantané »). Le pool de 60 connexions n'est plus le mur :
en régime nominal on mesure **19 connexions / 1 active**.

> **Si ça redevient lent un jour** : ce n'est presque jamais du bloat. Vérifier le
> **pool** d'abord (`pg_stat_activity`, voir §6) et chercher un **job de fond qui
> tient des connexions longtemps** (runbook `performance-status.md` §4).

### 3.5 Le traceur console (désormais **opt-in**)

Rendu **silencieux par défaut** (zéro bruit, zéro overhead en prod). Pour le
réactiver un jour de debug :

```js
// Dans la console du navigateur, sur app.norva.tv :
localStorage.norva_trace = "1";   // puis recharger la page
// La timeline s'imprime ; NorvaTrace.summary() pour le tableau récap.
localStorage.removeItem("norva_trace");  // puis recharger → re-silence
```

Implémentation : IIFE `NorvaTrace` en tête de `public/js/cloudApi.js`. Le drapeau est
lu **une fois** au chargement (`localStorage.getItem('norva_trace') === '1'`) ; si
absent, `log()` sort immédiatement (aucune trace stockée ni imprimée). Cache-bust :
`cloudApi.js?v=41` dans `public/app.html`.

---

## 4. Problème C — Onboarding « utilisable » (le 100 % redéfini)

**Demande** : l'utilisateur restait « à 94 % » sur l'étape de fond *Finalize Norva —
Preparing Home, Live TV and details*. Décision (confirmée) : **le 100 % = quand Norva
est utilisable** (Live TV + le 1er bloc de films/séries), le reste devenant une
**tâche de fond invisible** ; un **petit indicateur discret dans Réglages** signale
que ça se complète encore.

**Implémentation** (commit `76f3258`) :

- **Serveur** (`norva-source-sync/index.ts`, phase *titles*) : émet `usable=true` dès
  que l'offset des titres ≥ `min(totalVod, 2000)` (env
  `NORVA_USABLE_TITLE_THRESHOLD`, défaut 2000). Le pourcentage *affiché à
  l'utilisateur* vise ce seuil et passe à **100 %** dès `usable`.
- **Client** :
  - `utils/sourceHealth.js` (`classifySource`) : `progress.usable === true` ⇒ état
    `ready` + `refreshing=true` (on débloque l'UI).
  - `components/SourceManager.js` (`sourceSyncState`) : `usable === true` ⇒
    `phase:'ready'` + `backgrounding:true` → la liste affiche un **point pulsé
    discret** (`.source-backgrounding` dans `main.css`, respecte
    `prefers-reduced-motion`).

> Concrètement : l'utilisateur n'attend plus la fin du remplissage complet d'un gros
> catalogue pour se servir de Norva ; le top-up continue tout seul, sans barre
> anxiogène.

---

## 5. super8k — parké pendant la panne, **relancé** en fond

`super8k` (id `1aaeb703-6202-47eb-b697-949697b22bc1`, **272 780** items / **55 509**
live / 171 693 films / 45 578 séries) avait été **parké** (sync_status mis hors
`syncing`) pour soulager la DB pendant la panne. Relancé en fin de session :

```sql
update cloud_sources
   set sync_status = 'syncing', sync_error = null,
       config_hint = jsonb_set(config_hint, '{syncProgress,usable}', 'true'::jsonb)
 where id = '1aaeb703-6202-47eb-b697-949697b22bc1';
```

Le curseur de finalisation était **intact** (`finalizeCursor: {phase:'titles',
offset:129900, …}`), donc la reprise repart d'où elle s'était arrêtée — pas de
re-scan. **Vérifié** : le watchdog l'a repris, l'offset **avance** (129 900 → 147 600
en quelques minutes), `usable=true`, **un seul** bail frais (single-flight tient, pas
de troupeau). Il finira seul ; aucune action requise.

---

## 6. Comment vérifier que tout va bien (SQL lecture seule)

```sql
-- (a) super8k progresse et le single-flight tient (1 source / 1 bail frais) ?
select sync_status, sync_error,
       config_hint->'syncProgress'->>'usable'          as usable,
       config_hint->'finalizeCursor'->>'offset'        as offset,
       (config_hint->'finalizeLease'->>'until')::timestamptz > now() as lease_fresh
from cloud_sources where id='1aaeb703-6202-47eb-b697-949697b22bc1';

-- (b) Pool sain ? (était 60/60 pendant la panne ; nominal ≈ < 25, peu d'active)
select count(*) total, count(*) filter (where state='active') active,
       count(*) filter (where usename='authenticator') authenticator
from pg_stat_activity;

-- (c) Pas de troupeau ? (doit être : 1 syncing ⇒ exactement 1 bail frais)
select count(*) filter (where sync_status='syncing')                            syncing,
       count(*) filter (where (config_hint->'finalizeLease'->>'until')::timestamptz > now()) fresh_leases
from cloud_sources;
```

Snapshot de fin de session (2026-06-28 ~15:46 UTC) : `syncing=1, fresh_leases=1,
error=0` ; pool `19 total / 1 active`. ✅

---

## 7. Récap des commits (cette session, branche `claude/eager-carson-2zlqwy`)

> Déployés en prod par cherry-pick sur `main` (CI : `deploy-cloudflare.yml` pour le
> web, `deploy-supabase-functions.yml` pour les edge functions). Les hashes `main`
> diffèrent (le cherry-pick recrée le commit).

| Hash (dev) | Sujet |
|---|---|
| `d76053f` | fix(sync): single-flight finalize lease — stoppe le troupeau watchdog (cause #1) |
| `0c5e9a9` | fix(catalog): counts *estimated* + cache pour la progression d'enrichissement (cause #2) |
| `2f4f8e7` | docs(perf): incident login + runbook de relief |
| `d449419` | fix(onboarding): lot d'audit L3 (cible CTA, course client/driver, locale, progression) |
| `76f3258` | feat(onboarding): fin à « utilisable » (Live + 1er bloc), reste en fond |
| `d216622` | feat(web): traceur console de timeline + cache-bust des scripts périmés |
| `a3eea41` | perf(catalog): paralléliser `/home/rails` (6 awaits → 1 batch concurrent) |
| `e0dfb90` | perf(web): stopper l'inondation de polls qui épuise le pool de connexions |
| `42ed175` | fix(a11y): `autocomplete="off"` sur les champs mot de passe provider |
| *(ce commit)* | docs + traceur **opt-in** (`cloudApi.js?v=41`) + ce journal |

A11y login annexe : champ username caché (`sr-only`) ajouté au `password-form` de
`account.html` (warning « Password forms should have username fields ») — déjà inclus
dans `d76053f`.

---

## 8. Leviers d'urgence (renvois)

- **`performance-status.md` §4** — RUNBOOK saturation pool (diagnostic + relief DML
  léger : `cron.alter_job(26/12, active:=false)` pour couper les backfills, boucle qui
  tue les requêtes `authenticator` longues, réactivation off-peak A1).
- **`performance-status.md` §5** — ⛔ À ne JAMAIS refaire : **pas de
  `statement_timeout` sur le rôle `authenticator`** (a déjà causé une panne PGRST002) ;
  pas de DDL agressif sous charge ; watchdog jamais sous `*/1`.
- **`performance-status.md` §Incident 2026-06-28** — le détail des 3 causes + la
  boucle de relief d'urgence (forcer l'état + `pg_terminate_backend` des requêtes
  clientes longues quand même un `UPDATE` time out).

**Pièges retenus** : `UPDATE cron.job` direct = *permission denied* → passer par
`cron.alter_job(...)`. Le MCP `execute_sql` a une **limite dure de 60 s** → pour le
long (VACUUM/ANALYZE) passer par `cron.schedule` côté serveur. Tout changement de
fichier *servi au navigateur* doit **bumper son `?v=`** (sinon le CDN immuable sert le
périmé).
