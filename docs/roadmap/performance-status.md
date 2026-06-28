# Norva — Performance & charge DB : état & runbook

> **But de ce fichier** : garder trace de **ce qui a été optimisé** côté fluidité
> (démarrage de l'app, endpoints norva-cloud), de **l'état des jobs de fond**, du
> **backlog honnête** (« est-ce optimisé au max ? »), et — le plus précieux en
> opération — du **runbook anti-saturation DB** (diagnostic + commandes de relief
> exactes + les pièges à ne jamais refaire).
>
> _Dernière mise à jour : 2026-06-28._

---

## TL;DR

- **Le chemin de démarrage est optimisé** : les ~7 appels norva-cloud par
  chargement sont collapsés en **1 seul** (`GET /boot`) + caches client courts.
  Déployé (norva-cloud **v77**).
- **Le goulot restant n'est PAS le code de boot** : c'est la **base Postgres
  partagée saturée** par les backfills de fond (origlang, search-match) + la
  finalisation du gros provider de test (super8k) tournant **pendant les heures
  d'usage**. Quand le pool de connexions s'épuise, **tout** rame (catalog *et*
  cloud) → 500/504.
- **A1 fait** : crons `26` (origlang) + `12` (search-match) **déplacés en heures
  creuses** (3-4 h UTC, comme les crawls audio) et réactivés là → le backlog
  progresse la nuit, **zéro charge en journée**. Pool vérifié calme en journée
  (18 conns, 1 requête longue, finalize seul). Runbook plus bas si une saturation
  revient.
- **« Optimisé au max ? » → non.** Le boot l'est, A1 enlève la charge de fond en
  journée ; le levier suivant reste **structurel** : la **dédup provider-global**
  (cf. `dedup-plan.md`) pour enlever super8k de la base partagée à la racine.

---

## 1. Ce qui a été fait — optimisation du démarrage

### 1.1 `GET /boot` — agrégation cold-start (7 appels → 1)

Un chargement à froid tirait ~7 appels norva-cloud **séparés** (`profile`,
`profiles`, `entitlements`, `sources`, `trial-eligibility`, …), chacun payant son
**cold-start d'isolat + une auth**. Sous charge, ça saturait le pool d'isolats de
la fonction → chaque lecture de boot timeoutait à 35–75 s, **alors que
norva-catalog (même DB) restait rapide** → c'était bien spécifique à norva-cloud
(nombre d'appels concurrents + auth par appel), pas une lenteur DB pure.

`GET /functions/v1/norva-cloud/boot` répond `profile + profiles + entitlements +
sources + trial-eligibility` depuis **un seul isolat et une seule auth**, les 5
sections en parallèle (`Promise.allSettled`, **best-effort par section** : une
section qui échoue renvoie `null`, le client retombe sur son fetch individuel).

- **Code** : `supabase/functions/norva-cloud/index.ts`, route `scope === "boot"`
  (juste après `requireUser`).

### 1.2 Cache client + amorçage (`NorvaCloud.boot()`)

`public/js/cloudApi.js` :
- `boot()` : un seul appel `/boot` qui **pré-réserve** les slots in-flight et
  **amorce** les caches par section. Les getters tirés pendant le démarrage
  **dédupliquent** dessus au lieu de refaire le réseau. **Pur gain** : si `/boot`
  échoue ou qu'une section est `null`, le fetch individuel prend le relais.
- Wrap `cachedGet` sur `entitlements` (30 s), `profiles` (60 s), `profile` (60 s),
  `trial-eligibility` (60 s). **Invalidation à l'écriture** : `profiles` sur
  create/update/remove ; `profile` sur save.

`public/js/app.js` : `boot()` est tiré **juste après l'auth** (`checkAuth`), avant
le fan-out (`checkCloudAccess` / `ensureSelected` / `refreshSourceHealth` /
bannière d'essai). Sessions **user** uniquement (les écrans appairés utilisent le
device-token).

### 1.3 Cache edge — uniquement là où c'est sûr

`jsonCached()` + champ optionnel `cache` (secondes) sur le retour de `route()` →
`Cache-Control: private, max-age, stale-while-revalidate` + `Vary: Authorization,
x-norva-profile-id`.

- ✅ Appliqué : **`/billing/trial-eligibility`** (60 s) — lecture pure côté client.
- ❌ **Volontairement PAS** sur `/profiles` ni `/profile` : ils sont **modifiés**
  par le client, et un cache navigateur masquerait un profil qu'on vient de créer /
  un nom qu'on vient d'enregistrer. Le cache **client** (invalidé à l'écriture) est
  la bonne couche pour ces ressources. (Le catalogue était cachable en edge car
  **lecture seule** ; ces endpoints-là ne le sont pas — ne pas confondre.)

> **Pourquoi ça marche même à 1 user** : le cache client (in-memory) meurt à chaque
> rechargement complet ; `/boot` collapse le fan-out à froid ; le cache edge
> (navigateur, `private`) survit aux rechargements dans la TTL. Les trois sont
> complémentaires.

---

## 2. État des jobs de fond / crons (`cron.job`)

| jobid | rôle | cadence | actif ? | note |
|---|---|---|---|---|
| 1 | auto-refresh-detect | `*/30` | ✅ | léger |
| 12 | search-match (TMDB) | `6,16,…,56 3,4 * * *` | ✅ **off-peak** | **A1** : backfill, nuit seulement (était horaire toute la journée) |
| 13 | enrich-revalidate | `5 */6` | ✅ | toutes les 6 h (touche les heures pleines) — **candidat off-peak** si la charge de jour revient |
| 14 | enrich-backfill-years | `30 3` | ✅ | déjà off-peak |
| 26 | origlang-backfill | `1,11,…,51 3,4 * * *` | ✅ **off-peak** | **A1** : tournait 94–127 s en journée (`*/30`) → déplacé nuit |
| 27 | resume-stuck (watchdog finalize) | `*/1` | ✅ | relance les sources `syncing`/`error` à curseur ; **laisser actif** (filet pour les vrais blocages) |

> **A1 appliqué** : 26 et 12 sont entrelacés à 5 min d'écart dans la fenêtre 3-4 h
> UTC (chaque run 94–127 s < l'écart → pas de chevauchement avec soi-même), nuit
> sans users. En journée il ne reste que la finalisation super8k (pacée par
> `NORVA_FINALIZE_THROTTLE_MS`, finie à ~89 %), qui **seule** ne sature pas le pool.

> ⚠️ `cron.job` n'est **pas** modifiable en `UPDATE` direct (propriété superuser :
> `permission denied for table job`). Utiliser les fonctions :
> `select cron.alter_job(<id>, active := false);` / `cron.alter_job(<id>, schedule := '...')`.

**super8k** (gros provider de test, `1aaeb703-6202-47eb-b697-949697b22bc1`,
user `c5be5ac4-3700-4a25-9509-8eaf7771fdb6`) : ~272k items, finalisation ~89 %.
Sa finalisation se **ré-arme toute seule** (chaîne self-invoke + watchdog 27) :
mettre `sync_status='idle'` + retirer `finalizeCursor` est **écrasé en quelques
secondes** par le run en vol qui checkpoint. Pour réellement l'arrêter il faut
casser la chaîne self-invoke **et** neutraliser le curseur (cf. runbook). À 89 %
et charge légère (une fois origlang en pause), on **le laisse finir** plutôt que
de lutter contre la course.

---

## 3. « C'est optimisé au maximum ? » — backlog honnête (priorisé)

**Non.** Le **boot** l'est. Le reste, par ordre d'impact réel :

### Tier A — le vrai goulot : charge DB de fond vs capacité (STRUCTUREL)
1. ✅ **FAIT (A1) — backfills d'enrichissement hors heures pleines.** origlang (26)
   + search-match (12) déplacés en 3-4 h UTC et réactivés là (cf. tableau §2).
   Reste de cette ligne : **finalize** super8k — laissé finir (89 %, pacé, ne
   sature pas seul) ; **revalidate** (jobid 13, `*/6h`) à passer off-peak si une
   charge de jour réapparaît.
2. **Dédup provider-global (Phase 2).** super8k (272k items) sur une DB 8 Go
   partagée est l'éléphant. Le cache global (`catalog_titles`) + le read-cutover
   (cf. `scaling-playbook.md` étape 3, `dedup-plan.md`) divise stockage &
   enrichissement par 10-100 → enlève la pression à la racine. **Flag prêt, OFF.**
3. **Dimensionnement compute.** Si la saturation revient même backfills à l'arrêt,
   la taille de l'instance Postgres (add-on compute Pro) est sous-dimensionnée pour
   `fond + premier-plan` simultanés. Lever = right-size le compute.

### Tier B — norva-cloud par-requête
4. **Cacher l'auth/session.** Chaque lecture fait encore un `getUser()`
   (round-trip GoTrue) + requêtes DB. `/boot` collapse le **nombre** d'appels mais
   chaque section touche la DB. Cacher la résolution de session par token réduirait
   le coût par requête.
5. **Pooler (pgbouncer) transaction-mode.** L'épuisement de connexions suggère que
   le mode/池 n'est pas optimal pour des isolats nombreux et courts. À auditer.

### Tier C — frontend (différé, pas le goulot actuel)
6. Code-splitting, service worker, split CSS, minify/bundle. Aident le **premier
   paint** mais ne sont **pas** la cause des 504 (c'est la DB). À faire après Tier A.

---

## 4. 🚑 RUNBOOK — saturation DB (pool de connexions épuisé)

> Symptôme vécu **deux fois**. Repérer vite, relâcher vite, **sans** le DDL qui a
> causé la panne PGRST002 (cf. §5).

### Symptômes
- L'app « pas utilisable » : norva-catalog renvoie **500/504** sur `media-items`,
  `home/rails`, `media-genre-*` (≈ 128–150 s).
- Même un `SELECT 1` via MCP **timeout au niveau connexion** (`Connection
  terminated due to connection timeout`) → le pool n'a **plus de slot libre**.
- Edge logs : `norva-tmdb-origlang` à 94–127 s répétés, `resume-stuck` long,
  `search-match` 504 @ 151 s — des jobs de fond qui **tiennent des connexions**
  longtemps et se chevauchent.

### Diagnostic (lecture seule)
```sql
-- Qui tient des connexions / requêtes longues
select coalesce(left(query,46),'(idle)') q, state, count(*) n,
       round(max(extract(epoch from now()-query_start))::numeric,1) max_age_s
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
group by 1,2 order by max_age_s desc nulls last limit 12;

-- État super8k + crons
select sync_status, (config_hint ? 'finalizeCursor') has_cursor
from cloud_sources where id='1aaeb703-6202-47eb-b697-949697b22bc1';
select jobid, active, schedule from cron.job where jobid in (1,12,26,27) order by jobid;
```
> Si la connexion elle-même timeout : **réessayer** (intermittent — flakiness proxy
> + charge). Un slot se libère entre deux batches ; saisir ce moment pour le relief.

### Relief (DML léger — SÛR ; ce n'est PAS du DDL)
```sql
-- 1) Couper les backfills d'enrichissement (non essentiels) qui tiennent les
--    connexions longues. cron.job n'est PAS modifiable en UPDATE direct → alter_job.
select cron.alter_job(26, active := false);  -- origlang
select cron.alter_job(12, active := false);  -- search-match

-- 2) (si besoin) neutraliser la finalisation super8k — voir la note course ci-dessous
update cloud_sources
   set sync_status='idle', config_hint = (config_hint - 'finalizeCursor')
 where id='1aaeb703-6202-47eb-b697-949697b22bc1';
```
- Couper **26 (origlang)** est le plus gros gain seul (c'était le hog
  toutes-les-quelques-minutes).
- **Course super8k** : le `update` ci-dessus est ré-écrit en quelques secondes par
  le run de finalisation en vol (il re-checkpoint `syncing`+curseur). Pour
  réellement l'arrêter : couper la chaîne self-invoke (et éventuellement
  `cron.alter_job(27, active:=false)` temporairement) **puis** neutraliser. En
  pratique : à 89 % et charge légère une fois origlang coupé, **le laisser finir**.
- **Vérifier la reprise** : ré-exécuter le diagnostic — `max_age_s` retombe, plus
  de requête origlang/finalize longue, `LISTEN "pgrst"` reste (normal).

### Réactivation propre = la planif off-peak A1 (déjà en place)
Si tu as coupé 26/12 en urgence (relief), voici la planif **off-peak A1** à
restaurer — c'est l'état nominal depuis A1, à NE PAS remettre en `*/30` / horaire
pendant les heures d'usage :
```sql
select cron.alter_job(26, schedule := '1,11,21,31,41,51 3,4 * * *', active := true);  -- origlang
select cron.alter_job(12, schedule := '6,16,26,36,46,56 3,4 * * *', active := true);  -- search-match
```

---

## 5. ⛔ À ne JAMAIS refaire (leçons coûteuses)

- **Ne pas poser `statement_timeout` sur le rôle `authenticator`.** Un `8s` y a tué
  la requête d'introspection de PostgREST (24 s à cause de stats `pg_catalog`
  périmées) → **panne totale PGRST002 / 500**. Remède appliqué :
  `ALTER ROLE authenticator RESET statement_timeout, lock_timeout` + terminer les
  connexions PostgREST + `ANALYZE pg_catalog.*` + `NOTIFY pgrst,'reload schema'`.
  Timeouts par rôle voulus : anon 3 s, authenticated 8 s, service_role `null`.
- **Ne pas enchaîner du DDL/DML agressif sur la prod sous charge.** Le DDL force un
  reload de schéma → tempête d'introspection. La saturation pool se règle en
  **coupant des jobs** (DML léger via `cron.alter_job`), pas en touchant le schéma.
- **Watchdog : ne pas descendre sous `*/1`.** Un cron `*/30 s` a déclenché des « job
  startup timeout » pg_cron → revenu à `*/1`.
- **Cache edge : seulement les ressources lecture-seule-client.** Cacher
  `/profiles` masquerait un profil tout juste créé. (cf. §1.3.)

---

## Liens
- [`scaling-playbook.md`](./scaling-playbook.md) — séquence Jour J multi-users.
- [`dedup-plan.md`](./dedup-plan.md) / [`phase2-dedup-execution.md`](./phase2-dedup-execution.md) — dédup provider-global (le levier structurel Tier A #2).
- [`../ARCHITECTURE-RELIABILITY.md`](../ARCHITECTURE-RELIABILITY.md) — architecture de fiabilité.
