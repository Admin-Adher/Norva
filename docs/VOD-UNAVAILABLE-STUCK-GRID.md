# VOD « unavailable » / grille figée sur vide — incident, causes racines & runbook

**Incident du 2026-07-14** — compte `adrien.hernandez@outlook.com` (self-hosted, box `norva-db`).
**Statut : résolu (UI + infra).** Fix UI de fond (`918e542`, fallback rails→grille plate) + retrait du filtre « Hide unavailable » VOD (PR #187, `28b26f7` + `12c5909`) + **fix du finalize gelé** (`0cd204b`, worker edge tué avant l'auto-invocation). Voir §7.

> À lire avant de rejouer ce genre de diagnostic : **la moitié du temps a été perdue sur de fausses pistes**. Ce document liste explicitement ce que ce n'était **PAS**, pour ne pas les refaire.

---

## 1. Symptôme

Sur le compte cloud d'adrien, **toute la bibliothèque VOD s'affichait comme indisponible** :
- **Films** : d'abord la page entière verrouillée (« Préparation… »), puis OK après intervention, mais le bouton « Hide unavailable » semblait inerte.
- **Séries** : grille vide **« No shows to show yet. »** persistante, alors que *Continue Watching* montrait bien des séries.

Le contenu était **parfaitement lisible** en réalité — d'où le « alors que c'est faux ».

---

## 2. Ce que ce n'était PAS (pistes écartées, avec preuve)

| Hypothèse | Écartée par |
|---|---|
| Le flag `cloud_media_items.available = false` | La colonne est `not null default true` (`20260613150937_cloud_core_playback.sql:80`) et **aucun code ne la met jamais à `false`** (grep exhaustif = 0). Live check : `available_false = 0` sur les 275k items. |
| Une purge de lignes (prune / reaper de source soft-deletée) | Live check : `movie=173571, series=46085, live=55821` bien présents. |
| Le filtre « Hide unavailable » (`hideBroken` / `isBrokenItem`) | **En mode cloud c'est inerte** : `cloud_media_items` n'a **pas** de colonne `playback_status`, et `PlaybackHealth` est stub à `[]` (`api.js`, branche cloud du handler `/playback-status`). Live check : `hiddenCats=0`, `survive_categoryFilter=60`, et la grille est passée de 0 → 120 **avec `hideBroken=true`**. |
| Le watchdog de sync cassé / crons pointant vers le projet Supabase hébergé mort | Les crons pointent bien vers `https://api.norva.tv/...` (la box) et `norva-resume-stuck-sync` tourne chaque minute et **réussit**. |
| Un timeout live du RPC de grille | Le RPC `list_media_items_deduped(..., 'series', ...)` renvoie 60 items en **6,8 ms** (superuser). Data + perf OK. |
| Le gate `catalogCategoryAvailable('movies'/'series')` (comptes de santé) | `config_hint.syncProgress.counts` contenait bien `movies/series > 0` → le gate ne masquait pas. |

**Leçon** : sur un compte **cloud** (self-hosted Supabase = box), `available` et `playback_status`/`PlaybackHealth` ne sont **pas** les leviers. Vérifier d'abord le **mode** (cloud vs box legacy) : adrien a une `norva-cloud-session` → mode cloud → la box legacy SQLite (`server/routes/playbackStatus.js`, `playlist_items`) n'est pas en jeu.

---

## 3. Causes racines (la chaîne réelle)

### 3a. Un resync s'est figé en pleine matérialisation
La source avait `sync_status` coincé hors `ready`, avec `config_hint.syncProgress = { stage: materializing → building_live_channels → building_titles, percent: 78→100 }` **gelé** (heartbeat figé), sans curseur de reprise `syncCursor` mais avec un `finalizeCursor`/`finalizeLease` résiduel.

- Conséquence data : matérialisation dédup **incomplète** — `cloud_titles` séries ~27,5k (dont 22,4k avec variantes), `dedup_key` NULL sur ~50% des `cloud_media_items`. **Utilisable mais partiel.**
- Le `lastSync.syncedAt` était resté à un run précédent (13/07) → au départ, `hasCompletedCatalog()` tenait quand même le catalogue « ready+refreshing » pour les films.

Le finalize **reprenait** dès qu'on remettait `sync_status='syncing'` (le watchdog 1-min le rattrape ; `hasCompletedCatalog=true` évite de re-verrouiller l'UI), mais **re-calait systématiquement sur `building_titles`** — signature d'un **batch trop lourd pour ce catalogue de 275k** (voir §7).

### 3b. Le VRAI bug UI : `renderGenreRails` ne retombait pas sur la grille plate quand les rails étaient vides
C'est **la cause du blocage séries** et le fix de fond de cet incident.

- Sur **web/mobile**, les pages Movies/Series affichent des **rails par genre** (`renderGenreRails` → `API.media.genreRails({type})`), **pas** la grille plate `API.media.page({type})`. Les rails lisent la table **matérialisée** `cloud_titles` (filtrée `variant_count > 0`) ; la grille plate lit `cloud_media_items` bruts via le RPC `list_media_items_deduped` (fast-path `is_dedup_primary`).
- Le fallback vers la grille plate ne se déclenchait que si `rails.length === 0`. Or une matérialisation incomplète renvoie **des rails aux buckets VIDES** (`rails.length > 0`, `.items` vides). `GenreRails.render` (`utils/GenreRails.js:147`, `usable = rails.filter(r => r.items?.length)`) peignait alors un **« No shows to show yet. » définitif** **et** estampillait `_viewRenderedAt = Date.now()`.
- Ce marqueur « warm view » fait que `show()` **court-circuite le re-fetch** pendant 5 min → même le watch d'auto-refresh (`_armCatalogRefreshWatch`, re-check 15 s × ~10 min) appelait `show()` qui ne re-chargeait pas → **grille figée**.
- **Asymétrie films/séries** : les films étaient matérialisés en premier → rails films peuplés → OK. Les séries (matérialisées après, gelées à 78%) → rails vides → figées.

### 3c. « Hide unavailable » : un leurre (mais retiré quand même)
Le bouton n'a jamais masqué quoi que ce soit en cloud (§2). Il a été **retiré des VOD** (Movies + Series) par ailleurs — décision produit (TiViMate & co n'en ont pas, il crée une mauvaise UX sur des VOD saines). **Live TV garde** son « Hide unavailable » (les chaînes meurent réellement ; le health-scan y est légitime).

---

## 4. Les fixes

| Fix | Commit(s) | Fichiers |
|---|---|---|
| **Résilience grille** : fallback vers la grille plate dès que les rails genre ne portent **aucun** item (`rails.some(r => r.items?.length)`), pas seulement quand `rails.length===0`. Le `return` se fait **avant** l'estampille warm → plus jamais de « No shows » définitif quand le catalogue existe. | `918e542` | `pages/MoviesPage.js`, `pages/SeriesPage.js` (`renderGenreRails`), `app.html` (v47/v46) |
| **Retrait du filtre « Hide unavailable » VOD** (bouton + `hideBroken`/`isBrokenItem`-filter + chips + persistance, Movies+Series ; Live TV conservé) | `28b26f7`, `12c5909` (PR #187) | `pages/MoviesPage.js`, `pages/SeriesPage.js`, `app.js` (mobile sheet), `app.html` |
| Remédiation data ad hoc (compte adrien) : `sync_status='ready'` pour débloquer l'affichage ; forçage de re-fetch (`loadCloudSeries({reset:true})`) → grille de 0 à 120. | (SQL/console, pas de commit) | — |

---

## 5. Runbook de diagnostic (copier-coller)

Postgres self-hosté = conteneur **`norva-db`**. Toutes les requêtes :
```bash
docker exec -i norva-db psql -U supabase_admin -d postgres <<'SQL'
... 
SQL
```

**(1) La data existe-t-elle, et est-elle « available » ?**
```sql
SELECT cmi.item_type, count(*) AS total,
       count(*) FILTER (WHERE cmi.available) AS available_true,
       count(*) FILTER (WHERE NOT cmi.available) AS available_false
FROM cloud_media_items cmi JOIN auth.users u ON u.id = cmi.user_id
WHERE lower(u.email)='<email>' GROUP BY cmi.item_type;
```
`total=0` → catalogue purgé (voir source `deleted_at` / reaper). `available_false>0` → anomalie (ne devrait jamais arriver).

**(2) État de synchro de la source (le gate + le finalize gelé)**
```sql
SELECT cs.sync_status, cs.config_hint ? 'lastSync' AS has_lastsync,
       cs.config_hint->'lastSync'->>'syncedAt'  AS lastsync,
       cs.config_hint->'syncProgress'->>'stage'    AS stage,
       cs.config_hint->'syncProgress'->>'percent'  AS pct,
       cs.config_hint->'syncProgress'->>'updatedAt' AS heartbeat, now() AS db_now,
       cs.config_hint ? 'finalizeCursor' AS has_finalize_cursor
FROM cloud_sources cs JOIN auth.users u ON u.id = cs.user_id
WHERE lower(u.email)='<email>';
```
`heartbeat` figé loin de `db_now` + `stage=building_titles` → finalize calé (§7).

**(3) Matérialisation dédup (rails vs grille plate)**
```sql
SELECT ct.item_type, count(*) AS titles,
       count(*) FILTER (WHERE ct.variant_count>0) AS with_variants
FROM cloud_titles ct JOIN auth.users u ON u.id = ct.user_id
WHERE lower(u.email)='<email>' GROUP BY ct.item_type;
```

**(4) Le RPC de grille renvoie-t-il des lignes ? (indépendant du client)**
```sql
WITH u AS (SELECT id FROM auth.users WHERE lower(email)='<email>')
SELECT t, jsonb_array_length(j->'items') AS items FROM (
  SELECT 'series' t, list_media_items_deduped(p_user:=(SELECT id FROM u), p_item_type:='series') j
  UNION ALL SELECT 'movie', list_media_items_deduped(p_user:=(SELECT id FROM u), p_item_type:='movie')
) x;
```
Renvoie 60 mais la page reste vide → **problème client** (rails vides non-fallback = ce bug ; ou état périmé).

**(5) Côté client (console navigateur, page concernée)** — localise fetch vs mapping vs filtre :
```js
(async () => {
  const s = window.app.pages.series;               // ou .movies
  let f='n/a', ferr='';
  try { const p = await API.media.page({type:'series', limit:60, offset:0}); f = p.items?.length; }
  catch(e){ ferr = e?.message||String(e); }
  alert(`seriesList=${s.seriesList.length}\nfilteredCards=${s.filteredCards?.length}\nFETCH_items=${f}\nerr=${ferr}`);
})();
```
`FETCH_items>0` mais `seriesList=0` → mapping/état client (relancer `s.loadCloudSeries({reset:true})`). Note : les `console.log` async sont souvent ratés au copier-coller — préférer `alert()` ou `copy()`.

**(6) Les crons de sync tournent-ils ?**
```sql
SELECT jobname, schedule, active, left(command,90) FROM cron.job
WHERE command ILIKE '%norva-source-sync%' ORDER BY jobname;
SELECT j.jobname, r.status, r.start_time FROM cron.job_run_details r
JOIN cron.job j ON j.jobid=r.jobid
WHERE r.start_time > now()-interval '20 min' AND j.jobname ILIKE '%sync%'
ORDER BY r.start_time DESC LIMIT 15;
```
Les commandes doivent pointer vers `https://api.norva.tv/...` (pas le projet hébergé).

---

## 6. Remédiations data (compte-scopées)

- **Débloquer l'affichage tout de suite** (data déjà complète, on arrête de dépendre du finalize) :
  ```sql
  UPDATE cloud_sources SET sync_status='ready'
  WHERE user_id=(SELECT id FROM auth.users WHERE lower(email)='<email>') AND deleted_at IS NULL;
  ```
  Puis hard-reload de l'app. (`hasCompletedCatalog=true` via un `lastSync` existant garde l'UI débloquée.)
- **Relancer le finalize** (le watchdog le reprend ; ne re-verrouille pas l'UI si `lastSync` existe) :
  ```sql
  UPDATE cloud_sources SET sync_status='syncing'
  WHERE user_id=(SELECT id FROM auth.users WHERE lower(email)='<email>') AND deleted_at IS NULL;
  ```
  Surveiller `syncProgress.percent`/`heartbeat` (§5-2). S'il recale sur `building_titles` → §7.

---

## 7. Le finalize gelé sur `building_titles` — cause réelle & fix (`0cd204b`)

Sur ce catalogue de 275k, le finalize progressait (`materializing`→`building_live_channels`→`building_titles`) puis **gelait** sur `building_titles`, ré-relancé en boucle par le watchdog sans avancer.

**Ce n'était PAS un `statement_timeout` Postgres.** Les logs edge (`docker logs norva-edge-functions`) crachaient, chaque minute :
```
wall clock duration warning: isolate: <id>
```
→ c'est le **budget wall-clock du worker edge-runtime** qui est dépassé, pas la DB.

**Cause racine (mismatch de config, séquelle de cutover) :**
- Le routeur `main` (`supabase/functions/main/index.ts`) créait chaque worker avec `workerTimeoutMs = 1*60*1000` = **60 s**.
- Le moteur de sync a un budget de travail **par isolate de 90 s** : `SYNC_DRIVE_BUDGET_MS` (discovery, `_shared/xtream-sync.ts:57`) et le `deadline = Date.now()+90_000` de la boucle finalize (`norva-source-sync/index.ts:1188`). Ces boucles font ~90 s de travail **puis** s'auto-invoquent pour passer le curseur `{phase,offset}` à l'isolate suivant.
- `60 s < 90 s` → le worker était **recyclé avant l'auto-invocation** → la chaîne discover/finalize se cassait → le watchdog 1-min rejouait **le même slice** indéfiniment. D'où le gel sur `building_titles`.

**Fix (`0cd204b`) :** `workerTimeoutMs = 3*60*1000` = **180 s** (90 s de budget + marge pour un dernier batch lent + le fetch d'auto-invocation). Ne borne que la durée MAX d'un worker → aucun impact sur les requêtes rapides normales.

**Déploiement — IMPORTANT :** `main/index.ts` est le **routeur** long-vécu, pas une fonction user rechargée à chaque requête. Il faut **recréer le conteneur** :
```
cd ~/norva && git pull
docker compose -f ops/hetzner/docker-compose.supabase.yml up -d --force-recreate functions
# (ou ops/hetzner/scripts/04-deploy-edge-functions.sh s'il force-recreate le conteneur)
```
Puis re-armer le finalize d'adrien (`UPDATE cloud_sources SET sync_status='syncing' …`) et vérifier que `syncProgress.percent`/`heartbeat` avancent jusqu'à `sync_status='ready'` + un `lastSync.syncedAt` frais.

**Points connexes (non bloquants, à surveiller) :**
- `service_role` n'a pas de `statement_timeout` (vs `authenticated`/`authenticator` = 8 s). Non impliqué dans ce gel (c'était le wall-clock), mais à garder en tête si un batch DB devient le facteur limitant après ce fix.
- `dedup_key` restait ~50 % NULL (matérialisation dédup incomplète). Une fois le finalize mené à 100 %, il se complète ; sinon vérifier qu'un cron **reconcile** (`norva_reconcile_catalog` / `norva_backfill_media_identity`) est schedulé sur la box.

Container edge : `norva-edge-functions`. Diag : `docker logs --since 8m norva-edge-functions 2>&1 | grep -iE 'wall clock|finaliz|building_titles|killed|memory'`.

---

## 8. Références

- **Mode client** : `_shouldUseCloud()` (`public/js/api.js`) — cloud dès qu'une `norva-cloud-session` existe et `norva-api-mode != 'local'`.
- **Grille plate** : `API.media.page` → route `media-items` → RPC `list_media_items_deduped` (`migrations/20260704271000_list_media_items_deduped_primary.sql`, fast-path `is_dedup_primary`).
- **Rails genre** : `API.media.genreRails` → `cloud_titles` (`variant_count>0`) ; rendu `utils/GenreRails.js` (`render()` → `usable = rails.filter(r => r.items?.length)`).
- **Gate de santé** : `app.js` `isCatalogReady` / `catalogCategoryAvailable` ; classifieur `utils/sourceHealth.js` (`hasCompletedCatalog` s'appuie sur `config_hint.lastSync.syncedAt` ou `catalog_version>1` ou `syncProgress.usable`).
- **Warm-view** : `_viewRenderedAt` (Movies/Series `filterAndRender` : `cards.length ? Date.now() : 0`) + `_armCatalogRefreshWatch` (re-check 15 s, borné ~10 min).
- **Finalize / watchdog** : `supabase/functions/_shared/xtream-sync.ts` (finalize, `finalizeLease`, prune gardé), `supabase/functions/norva-source-sync/` (crons `resume-stuck`, `refresh-due`, sélection `sync_status IN ('syncing','error')`).
- **Box legacy (non concernée en cloud)** : `server/routes/playbackStatus.js`, table SQLite `playlist_items.playback_status`.
- **Tables** : `cloud_media_items` (par-user, `available not null default true`, pas de `playback_status`), `cloud_titles`/`cloud_title_variants` (dédup matérialisé), `cloud_sources` (`sync_status`, `config_hint`).
