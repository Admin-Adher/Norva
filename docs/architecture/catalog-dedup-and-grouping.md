# Catalogue — dédup & regroupement des titres (référence)

> Écrit le 2026-07-14 après une investigation complète (workflow `wy6f7xbf7`, 3 traceurs
> client/serveur/asset + vérifs live). Objectif : que quiconque débogue « pourquoi ce film
> apparaît en N fiches » sache **quelle couche** regarder et **quel levier** actionner.
> Fichiers cités avec `path:ligne` — susceptibles de bouger, reréférencer si besoin.

## TL;DR

Il y a **DEUX systèmes de dédup indépendants**. Ne pas les confondre :

| Surface | Table lue | Clé de dédup | Maintenue par |
|---|---|---|---|
| **Recherche · rails · accueil** | `cloud_titles` (projection) | `identity_key` | projection + `norva_canonicalize_titles_for_user` |
| **Grille Movies / Series** | `cloud_media_items` (**BRUT**) | `is_dedup_primary` + `dedup_key` (colonnes) | `norva_reconcile_catalog` → `norva_backfill_media_identity` |

**Corollaire clé** : réparer `cloud_titles` (merge) NE répare PAS la grille. La grille se répare
quand `dedup_key = cloud_titles.identity_key` est repropagé sur les lignes brutes, via le
**reconcile** (cron `norva-catalog-reconcile`, 0–6 h).

---

## 1. La grille Movies/Series (couche BRUTE)

### Flux
`MoviesPage.loadCloudMovies()` (`public/js/pages/MoviesPage.js:997,1157`)
→ `API.media.page()` (`public/js/api.js:2250`)
→ `cloudApi catalogRequest('/media-items', …)` (`public/js/cloudApi.js:1047`, +`country`+`lang` `:733`)
→ `GET api.norva.tv/functions/v1/norva-catalog/media-items`
→ `listMediaItems()` (`supabase/functions/norva-catalog/index.ts:637`, route `:89`, wrap `jsonCached(…,30)`)
→ RPC **`list_media_items_deduped`**.

### Ce que la RPC renvoie (`20260704271000_list_media_items_deduped_primary.sql`)
- **Vue par défaut** (`p_source is null and p_category is null`, y compris avec recherche) :
  **fast-path** → `from cloud_media_items mi where … and mi.is_dedup_primary` → **UNE ligne
  représentante par groupe `(user,item_type,dedup_key)`** (`:48-74`). `total` = null.
- **Vue filtrée par source/catégorie** : **explose** — renvoie **toutes les lignes-versions**
  des films de la page (`join filtered f on f._dk = pf._dk`, `:111-156`). Le handler le note :
  « `items` are version rows … a film can contribute several rows » (`index.ts:712-714`).
- Grand compte filtré (>60k, `catalog_item_estimate`) : page d'index brute, **sans dédup** (`:80-108`).

### Forme d'une ligne reçue
`normalizeMediaItem` (`api.js:361-396`) fait `...item` (spread du row brut) + pose
`sourceId/name/title/rating(=metadata.rating||item.rating)/stream_id/…`. **Pas de `tmdb_id`
plat.** L'id TMDB brut vit sous **`metadata.providerTmdbId`** (lu partout : `index.ts:743,767,782,827`).
`attachMediaLanguages` stampe en plus `original_language` et `tmdb = { overview }` (pas d'`id`)
(`index.ts:874-878`). La ligne porte aussi **`dedup_key`**.

### Regroupement client
`MoviesPage.buildFilteredCards` appelle `MediaUtils.groupItems(items,{idField:'stream_id'})`
(`MoviesPage.js:1380`). Clé de groupe (`mediaUtils.js:964-969`, **v14**) :
`t:${tmdb_id||provider_tmdb_id||providerTmdbId||tmdb.id}` **sinon** `k:${dedup_key||computeDedupKey(name,year)||sourceId:id}`.
→ Sur les lignes de grille, l'id TMDB est sous `metadata.providerTmdbId` (que `groupItems` **ne lit
pas**), donc en pratique **la grille regroupe par `k:${dedup_key}`**. `dedup_key` = l'`identity_key`
du `cloud_title` (propagé par le reconcile). `versionCount = group.items.length` (`MoviesPage.js:1672`).

> Donc : sur la grille, **c'est `dedup_key` qui fait foi**. `groupItems` v14 (aliases tmdb) sert
> surtout aux items **recherche/accueil** qui, eux, portent `provider_tmdb_id`/`providerTmdbId` en
> haut niveau (cf. §2).

### Maintenance de `dedup_key` / `is_dedup_primary`
Colonnes sur `cloud_media_items` (`20260704200500_media_dedup_key.sql`, `20260704270000_media_dedup_primary.sql`).
- `is_dedup_primary` **défaut `true`** → avant backfill, la grille montre TOUT (jamais de contenu
  caché ; juste non-dédupliqué).
- `norva_backfill_media_identity(p_user, p_limit)` : `join media→cloud_title_variants→cloud_titles`,
  pose `dedup_key = ct.identity_key`, stampe `metadata.providerTmdbId`, copie le poster ; puis
  recompute `is_dedup_primary` (1 primary/groupe) sur les groupes touchés.
- `norva_recompute_dedup_primary(p_user, p_limit)` : réélit le primary d'un groupe (poster > tmdb >
  rating > external_id). Idempotent, borné.

---

## 2. Recherche / rails / accueil (couche PROJECTION)

Lisent **`cloud_titles`** (une ligne logique par film). Sérialisés par `titleRailItem`
(`norva-catalog/index.ts:1969-1970`) qui émet **`provider_tmdb_id` ET `providerTmdbId`** en haut
niveau (+ `tmdb_id` hoisté pour les home-rails, `api.js:840,958`). D'où : `groupItems` v14 regroupe
CES items par `t:${tmdb}` correctement.

### Modèle d'identité `cloud_titles` (`20260615122000_cloud_vod_titles_projection.sql`)
- `identity_key` : `tmdb:<id>` (source `provider_tmdb`) > `imdb:<id>` (`provider_imdb`) >
  `norm:<type>:<slug>:<year>` (`normalized`). `unique (user_id,item_type,identity_key)`.
- `normalizeTitle` déprefixe un préfixe pays/qualité **UNIQUEMENT s'il y a un séparateur**
  (`FR - `, `DK ▎ `, `4K-AR - `) — **pas** un préfixe « FR » + espace nu (exprès : ne pas bouffer les
  vrais titres « IT »/« US »/« LA »). Conséquence : les copies `FR Titre`/`EN Titre` forkent en
  `norm:` distincts tant qu'elles n'ont pas de tmdb (voir §5, souvent `variant_count=0`, fantômes).
- `cloud_title_variants.title_id → cloud_titles.id` (ON DELETE CASCADE) ; trigger
  `trg_cloud_title_variants_rollup` recompte `variant_count`/`default_variant_id` à chaque
  insert/update/delete de variante.

### Merge des doublons `cloud_titles`
`norva_canonicalize_titles_for_user(p_user, p_limit)` (`20260704220000_resilient_reconcile.sql:23`) :
groupe par `(user,item_type,provider_tmdb_id) having count(*)>1`, choisit le canonique (le plus
riche), déplace les variantes, remplit les trous, supprime les doublons, re-clé le survivant en
`tmdb:<id>`. **C'est le mécanisme officiel.** (⚠️ `dedupe_cloud_titles_by_tmdb`, ajouté puis retiré
cette session, le doublonnait — voir §5.)

---

## 3. Les pipelines & crons

### `norva_reconcile_catalog(p_user, p_limit=5000)` — LE drain de la grille
(`20260704220000_resilient_reconcile.sql:116`) — `pg_try_advisory_lock(4200042)` **non-bloquant**
(renvoie `{skipped:locked}` si contendu, pas d'empilement). Fait, chacun avec savepoint :
1. `norva_canonicalize_titles_for_user(p_user, 300)` — merge `cloud_titles`.
2. `norva_refresh_posters_from_catalog(p_user, p_limit)` — posters.
3. `norva_backfill_media_identity(p_user, p_limit)` — **propage `dedup_key`/`is_dedup_primary`** (la grille).

Renvoie `{titles_merged, posters_refreshed, media_rows_reconciled}`. `media_rows_reconciled = p_limit`
= **plafond atteint, relancer** (batch 5000 = calibré pour tenir sous `statement_timeout` 120 s).

**Cron `norva-catalog-reconcile`** : `3-59/20 0-6 * * *`, actif → ~21 passages/nuit ×5000 ≈
**105k lignes/nuit**. La grille se répare donc **toute seule chaque nuit**.

### `cronSearchMatch` — appariement TMDB (`norva-source-sync/index.ts:852`)
Route `POST /cron/search-match?user=<uuid>&limit=&conc=` (`:155`), auth = clé service **ou** secret
cron (`:83-92`). Cherche un tmdb pour les titres `match_status='unmatched'` **avec `variant_count>0`**
(`:876`) et pose `provider_tmdb_id` + `match_status='provider_verified'`. `matchLocalisé` OK
(score sur titre localisé + original + poster, revalidation multi-langue). **Mode focalisé**
`?user=` : re-enrichit un compte à la demande, hors curseur global.

> Chaîne complète d'un film localisé : **search-match** (donne un tmdb) → **canonicalize** (merge les
> `cloud_titles` qui partagent ce tmdb) → **backfill** (repropage `dedup_key` sur la grille). Les 2
> derniers sont dans le **reconcile nocturne**.

---

## 4. Diagnostic & playbook (box : `docker exec -i norva-db psql -U postgres -d postgres`)

```sql
-- État d'un film pour un compte (couche PROJECTION)
SELECT identity_key, provider_tmdb_id, match_status, variant_count, title
FROM cloud_titles WHERE user_id='<u>' AND item_type='movie' AND title ILIKE '%<film>%';

-- Retard de reconcile d'un compte (lignes brutes dont dedup_key ≠ identity du titre)
SELECT count(*) FROM cloud_media_items mi
  JOIN cloud_title_variants v ON v.media_item_id=mi.id
  JOIN cloud_titles ct ON ct.id=v.title_id
WHERE mi.user_id='<u>' AND mi.dedup_key IS DISTINCT FROM ct.identity_key;

-- Détecter une oscillation (media_item → plusieurs identity_key) : doit être 0
SELECT count(*) FROM (
  SELECT mi.id FROM cloud_media_items mi
    JOIN cloud_title_variants v ON v.media_item_id=mi.id
    JOIN cloud_titles ct ON ct.id=v.title_id
  WHERE mi.user_id='<u>' GROUP BY mi.id HAVING count(DISTINCT ct.identity_key)>1) x;
```

```bash
# Propager cloud_titles → grille pour UN compte (relancer tant que media_rows_reconciled=5000)
docker exec -i norva-db psql -U postgres -d postgres -tA \
  -c "SELECT norva_reconcile_catalog('<u>');"

# Drain GLOBAL (toutes files) — boucle jusqu'à < p_limit
for i in $(seq 1 400); do
  R=$(docker exec -i norva-db psql -U postgres -d postgres -tA -c "SELECT norva_reconcile_catalog(NULL, 5000);")
  echo "run $i: $R"; echo "$R" | grep -q '"media_rows_reconciled": 5000' || { echo DRAINED; break; }
done

# Re-enrich TMDB ciblé d'un compte (matche ses unmatched vers>0)
curl -sS -X POST "$FUNCTIONS_BASE_URL/norva-source-sync/cron/search-match?user=<u>&limit=1500&conc=15" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"

# Appliquer une migration SQL (host sans psql)
docker exec -i norva-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/<f>.sql
```

### Caches à connaître (norva-catalog)
1. **HTTP** `jsonCached(…,30)` → `private, max-age=30, stale-while-revalidate=60`, `Vary:
   Authorization, x-norva-profile-id` (`index.ts:2713`). Expire en 30 s.
2. **localStorage client** `NorvaCatalogCache` — **7 jours** (`catalogCache.js:14`), évincé **seulement**
   sur bump `catalog_version` (max des sources, `api.js:2105`), **pas** sur un merge de titres. Un
   merge peut donc rester invisible en navigateur normal jusqu'au refetch réseau (le fetch remplace
   le paint). **La navigation privée court-circuite ce cache** → teste toujours en privé.

---

## 5. Ce que la session 2026-07-14 a changé (et une erreur d'aiguillage)

- **Fix (1) client `mediaUtils.js` v14** (`4315891`) : `groupItems` lit tous les alias tmdb + garde
  `'0'`/`'tt0'`. **Utile pour recherche/accueil** (items à tmdb haut-niveau). Sur la grille, le tmdb
  est sous `metadata.providerTmdbId` → la grille regroupe de toute façon par `dedup_key`. Gardé.
- **Fix (2) `dedupe_cloud_titles_by_tmdb`** (`760f227`, `5854b8c`, migration `20260714120000`) :
  merge global one-shot `cloud_titles` = **54 298 repliés + 21 367 re-clés**. A **réparé
  recherche/rails**. MAIS : (a) il **doublonnait** `norva_canonicalize_titles_for_user` ; (b) il n'a
  **pas** touché la grille (couche brute) ; (c) le re-key global a **périmé les `dedup_key`** des
  lignes brutes partout → grosse **dette de reconcile** (ex. compte à 275k items : 82 507 lignes à
  repropager). **Retiré cette session** (migration de drop `20260714130000` + wiring `cronSearchMatch`
  reverté) — le pipeline reconcile existant fait déjà merge + propagation.
- **Bonne façon** : laisser `search-match` (donne les tmdb) et le **reconcile nocturne** (merge +
  backfill en lockstep) faire leur travail ; pour accélérer un compte précis, `norva_reconcile_catalog('<u>')`.

## 6. Pièges / leçons

- **La grille n'est pas `cloud_titles`.** Vérifier un regroupement de grille = requêter
  `cloud_media_items.dedup_key`/`is_dedup_primary`, pas `cloud_titles`.
- **`title ILIKE 'lilo%stitch%'` sur `cloud_media_items`** rate les titres à préfixe (« FR Lilo… »).
  Pour compter les lignes d'un film, passer par `metadata->>'providerTmdbId'` ou `dedup_key`.
- **Un merge global de titres crée une dette de reconcile** proportionnelle au nombre de lignes
  brutes concernées. Préférer le drain incrémental (le pipeline le fait déjà) à un one-shot massif.
- **Toujours vérifier sur la couche que voit l'utilisateur**, et **en navigation privée** (cache
  localStorage 7 j).
