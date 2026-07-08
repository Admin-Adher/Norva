# Miroir catalogue global (Phase 2) — runbook d'activation

> **But** : la procédure **ordonnée, exécutable, réversible** pour basculer le catalogue brut
> (`catalog_media_items` & jumelles) du mode _construit-mais-dormant_ vers _partagé cross-user_.
> Ce doc est le **« comment activer »** ; l'inventaire du **« quoi est construit »** et le chiffrage
> vivent dans [`phase2-dedup-execution.md`](./phase2-dedup-execution.md) et
> [`dedup-plan.md`](./dedup-plan.md). Design de fond :
> [`global-title-cache-design.md`](./global-title-cache-design.md).
>
> Projet : `oupsceccxsonaalhueff` · _Rien ici n'est à exécuter tant que le recoupement multi-user
> n'est pas matériel (voir §« Quand basculer »)._

---

## TL;DR — l'état en une image

Il y a **deux couches de dédup indépendantes** :

| Couche | Tables globales | Écriture | Lecture | Rows aujourd'hui |
|---|---|---|---|---|
| **A — métadonnées titres** (TMDB : titre, poster, i18n, pistes audio) | `catalog_titles`, `catalog_file_tracks` | ✅ **ON** (writers best-effort inconditionnels + cron `cloud_enrich_titles_from_catalog` /5 min) | ⏸️ OFF (`NORVA_CATALOG_READ_SOURCE`=`cloud_titles`) | ~91,8k / ~91,7k |
| **B — catalogue brut** (les ~600k lignes/provider) | `catalog_media_items`, `catalog_title_variants`, `catalog_live_variants`, `catalog_live_logical_channels` | ⏸️ **OFF** (GUC `app.norva_catalog_dual_write`, jamais mis) | ⏸️ OFF (`NORVA_CATALOG_MEDIA_READ_SOURCE`) | **0 / 0 / 0 / 0** |

La couche B ne possède **aucun writer edge** : son seul écrivain est le trigger Postgres
`trg_cloud_source_mirror_on_ready` (sur `sync_status → 'ready'`) qui appelle
`sync_source_to_catalog(source_id)` — **uniquement si** `app.norva_catalog_dual_write = '1'`.
Ce GUC n'a jamais été posé ⇒ trigger no-op ⇒ tables vides. **Aucun code à écrire : write, read,
verify et thin sont tous présents et dormants.** Activer = 5 leviers d'ops/config, pas du code.

C'est la couche B qui porte le vrai gain de stockage à l'échelle (chaque nouvel owner d'un même
provider ne réécrit plus ~600k lignes). La couche A évite juste de refaire l'enrichissement TMDB.

> **Vue complète des couches partagées (déjà actives) : [`shared-cache-layers.md`](./shared-cache-layers.md)**
> — pistes audio/sous-titres (`catalog_file_tracks`, 117k, prouvé), titres TMDB (`catalog_titles`, ~92k),
> sous-titres IA (`catalog_generated_subtitles`, 49, latent), + le **mécanisme on-play** (immédiat, sans
> seuil, indépendant des crons) et le **caveat mode-dépendant** (scan on-play seulement sur le chemin engine).

---

## Les leviers exacts (référence code)

| # | Levier | Où | Défaut | Réversible ? |
|---|---|---|---|---|
| 1 | Backfill global depuis le per-user | `backfill_catalog_from_cloud()` / `sync_source_to_catalog(id)` (mig. `20260627160000` / `20260627170000`) | tables vides | ✅ `truncate` (rien ne lit) |
| 2 | **Écriture** (dual-write au sync) | GUC `app.norva_catalog_dual_write` (trigger mig. `20260627180000`) | **OFF** | ✅ `reset` → trigger no-op |
| 3 | **Vérifier** la fidélité raw-media | RPC `catalog_media_mirror_diff(source_id)` (mig. `20260627190000`) · route HTTP `POST /catalog-media-mirror-verify` (`norva-playback`) | — | lecture seule |
| 3′ | Go/No-Go qualité à l'échelle | RPC `catalog_flip_readiness(min_overlap)` (mig. `20260628130000`) | — | lecture seule |
| 4 | **Lecture** globale | env `NORVA_CATALOG_MEDIA_READ_SOURCE=catalog_media_items` sur `norva-catalog` + `norva-playback` | **OFF** | ✅ re-flip → per-user + fallback intégré |
| 5 | Amincir le per-user | `thin_source_media_items(source_id)` (mig. `20260627200000`) | non exécuté | ⚠️ **point de non-retour** (un-thin SQL en §Réversibilité) |

---

## Procédure d'activation (ordre strict)

Chaque étape est réversible **sauf l'étape 5**. Ne jamais amincir avant que la lecture globale ait
tourné stable sur une fenêtre d'observation.

### 1. Backfill — seeder le global depuis les `cloud_*` existants
```sql
select public.backfill_catalog_from_cloud();     -- toutes sources, idempotent
-- ou une seule source :  select public.sync_source_to_catalog('<source-uuid>');
select * from public.catalog_dedup_report();      -- vérifier dup_factor (monte avec le nb d'owners/provider)
```
_Réversible :_ `truncate catalog_media_items, catalog_title_variants, catalog_live_variants, catalog_live_logical_channels;` — personne ne lit encore ces tables.

### 2. Activer l'écriture — dual-write automatique au sync
```sql
alter role authenticator set app.norva_catalog_dual_write = '1';
```
À partir de là, chaque source qui repasse `ready` (onboarding, re-sync, cron finalize) se mirror
automatiquement via le trigger. _Réversible :_ `alter role authenticator reset app.norva_catalog_dual_write;` → le trigger redevient un check de setting no-op.

### 3. Vérifier la fidélité — le gate avant toute bascule de lecture
Nouvelle route HTTP (jumelle de `/catalog-mirror-verify` qui, elle, ne couvre que les **titres**) :
```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/norva-playback/catalog-media-mirror-verify" \
  -H "Authorization: Bearer $NORVA_BACKFILL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_id":"<source-uuid>"}'
# => { ok, clean, diff:{ compared, cloud_only, mismatch_playback_hint, mismatch_metadata, global_weaker_* } }
```
**Gate `clean` = TRUE** requiert : `cloud_only = 0` (tout item per-user est mirroré),
`mismatch_playback_hint = 0` (le playback résout à l'identique depuis le global),
`global_weaker_title = 0` **et** `global_weaker_poster = 0` (le global n'est jamais plus vide que
le per-user). Un `mismatch_metadata > 0` est **toléré** à l'échelle multi-user (keep-best peut
légitimement garder la ligne la plus riche de deux owners).

_Appel SQL direct équivalent (sans passer par l'edge) :_
`select * from public.catalog_media_mirror_diff('<source-uuid>');`

### 3′. Go/No-Go de qualité à l'échelle
`catalog_media_mirror_diff` prouve la fidélité **par source**. Pour décider si la bascule vaut le
coup **globalement**, `catalog_flip_readiness(p_min_overlap)` est le verdict : `flip_ready` =
`strict_worse = 0` **ET** `overlap_ratio >= 3.0` (chaque titre partagé par ≥3 owners en moyenne).
En dessous du recoupement, la bascule n'apporte ~rien.

### 4. Basculer la lecture — poser l'env sur les deux fonctions
```
NORVA_CATALOG_MEDIA_READ_SOURCE=catalog_media_items   # sur norva-catalog ET norva-playback
```
- `norva-playback` (`resolvePlaybackTarget`) lit `playback_hint`/`metadata` depuis le global, avec
  **fallback per-user** (`if (!item)` relit `cloud_media_items`) → un miss global ne casse jamais un
  playback.
- `norva-catalog` superpose poster/backdrop/metadata via `applyMediaCatalogOverlay` /
  `applyLiveCatalogOverlay` : la requête per-user garde membership/tri/pagination, l'overlay ne
  remplit que si le global a une valeur.

_Réversible instantanément :_ retirer/vider l'env → lecture per-user comme aujourd'hui.

### 5. Amincir le per-user — le seul pas irréversible
```sql
select public.thin_source_media_items('<source-uuid>');   -- vide poster/backdrop/metadata/playback_hint là où le global les détient
```
⚠️ **Point de non-retour** : une fois `cloud_media_items` aminci, re-basculer la lecture vers le
per-user laisserait des trous. À ne faire **qu'après** que l'étape 4 ait tourné stable sur une
fenêtre d'observation, et **seulement à l'échelle** (à 1 owner, global + per-user aminci coûte
_plus_ qu'une ligne per-user pleine). Un-thin (refill depuis le global) en §Réversibilité.

---

## Quand basculer

**Pas maintenant.** À ~1 owner réel, l'overlap est nul → gain ≈ 0, et on ajoute de la surface
(backfill, trigger à chaque sync). Le code lui-même pose le seuil : `catalog_flip_readiness` ne dit
**GO** qu'à `overlap_ratio >= 3.0`. Déclencheur naturel = plusieurs owners du **même** provider.

Projection (mesurée sur apdxes, cf. tracker) : à **10 owners, 190 → 78 MB (−59%)** ; asymptote
**~−68% (÷3,1)**. Doctrine : **on construit maintenant** (calme, réversible), **on bascule plus tard**.

**Pourquoi surtout PAS l'allumer « pour prendre de l'avance » à 1 owner** (piège tentant — la couche
paraît premium) :
1. **Gain de stockage ≈ 0** — rien à mutualiser tant qu'il n'y a pas de recoupement cross-user.
2. Le seul pas qui économise vraiment (le **thin**, étape 5) est **irréversible** et **coûte _plus_
   cher à 1 owner** : copie globale + copie per-user amincie > une seule ligne per-user pleine.
3. Le **dual-write** (étape 2) pose un trigger de mirror **à chaque sync** → charge en plus (backfill,
   trigger), pour zéro bénéfice tant que l'overlap n'est pas matériel — à éviter d'autant plus quand la
   base est déjà sous tension.

Le bon signal n'est pas une intuition, c'est un **verdict chiffré** : `catalog_flip_readiness(3.0)`
passe **GO** (≥ plusieurs owners du même provider). → Idéalement **câbler une alerte** sur ce verdict
pour activer le jour exact où ça devient rentable, ni avant ni après.

---

## Suppression d'une source : ce qui est perdu vs conservé (⚠️ question fréquente)

> « Si je supprime un provider et qu'aucun autre user ne l'a en actif, on perd tout, ou on garde des
> données mutualisées pour les futurs users ? » → **On ne perd pas l'essentiel. L'enrichissement
> (couche A) survit ; seule la projection per-user brute est purgée. Et le « premium instantané » que
> tu attends de la couche B est, pour la partie enrichissement, _déjà actif_ via la couche A.**

Trois familles de données se croisent à la suppression :

| | Couche A — enrichissement | Couche B — catalogue brut | Per-user (`cloud_*`) |
|---|---|---|---|
| Tables | `catalog_titles`, `catalog_file_tracks`, `catalog_generated_subtitles` | `catalog_media_items` & jumelles | `cloud_media_items`, `cloud_*_variants`, … |
| Clé | identité de contenu (TMDB / pistes) | `server_host`+`external_id` — **credential-free** (aucun `user_id`/`source_id`/identifiant) | `user_id`+`source_id` |
| État aujourd'hui | ✅ ON — peuplé (~92k / ~111k) | ⏸️ dormant (0 ligne) | source de vérité actuelle |
| **Le reaper y touche ?** | **NON** | **NON** | **OUI** — et uniquement `deleted_at IS NOT NULL` |

`reap_deleted_sources()` ne supprime QUE des lignes `cloud_*` d'une source **soft-deleted**. Il ne
touche **aucune** table `catalog_*` (garantie structurelle, par sa clause `where deleted_at is not
null`). Donc :

- **Ce qui SURVIT** à la suppression d'un provider : tout l'enrichissement mutualisé (titres
  canoniques TMDB, posters, pistes audio/sous-titres, sous-titres générés). C'est le travail coûteux —
  il reste, partagé, permanent.
- **Ce qui est PURGÉ** : la projection per-user du **listing de flux** de cette source (lignes
  `cloud_*`). C'est la partie légère, ré-obtenue en **un import** depuis l'API du provider.
- **Pour un futur owner du même provider** : il ré-importe le listing (rapide) et le système le
  **re-matche** contre les titres canoniques déjà enrichis → catalogue premium quasi-instant, **sans
  refaire TMDB**. Il ne repart pas de zéro.

> **À retenir** : le « premium » de la couche B dormante est un gain de **COÛT de stockage à
> l'échelle**, pas une fonctionnalité manquante. La fonctionnalité (réutiliser l'enrichissement pour un
> futur owner) **tourne déjà** via la couche A. La couche B ne fait qu'éviter de **stocker N fois** les
> ~600k lignes brutes quand N owners partagent un provider — d'où son gate `overlap ≥ 3.0`.

---

## Réversibilité (résumé)

- **Étapes 1–4 : entièrement réversibles, sans perte** (write OFF = no-op ; read OFF = per-user ;
  le fallback per-user couvre les gaps même en couverture globale partielle).
- **Étape 5 : irréversible en pratique** — à isoler derrière une fenêtre d'observation + le gate 3′.
- Annulation totale de la Phase 2 (n'importe quand tant que les flags sont OFF) :
  `drop table catalog_media_items, catalog_title_variants, catalog_live_logical_channels, catalog_live_variants cascade;` — le per-user reste la source de vérité.

```sql
-- un-thin (réversibilité étape 5) : refill les champs amincis depuis le global
update cloud_media_items m set
  poster_url   = coalesce(nullif(m.poster_url,''), g.poster_url),
  backdrop_url = coalesce(nullif(m.backdrop_url,''), g.backdrop_url),
  metadata      = case when m.metadata='{}'::jsonb then g.metadata else m.metadata end,
  playback_hint = case when m.playback_hint='{}'::jsonb then g.playback_hint else m.playback_hint end
from catalog_media_items g
where g.server_host=(select config_hint->>'serverHost' from cloud_sources where id=m.source_id)
  and g.item_type=m.item_type and g.external_id=m.external_id and m.source_id='<source>';
```

---

## Reprise rapide (commandes)

```sql
select * from public.catalog_dedup_report();        -- multiplicateur de dédup (monte avec nb owners/provider)
select * from public.catalog_flip_readiness(3.0);   -- verdict GO / NO-GO
select public.backfill_catalog_from_cloud();        -- (re)peupler le global
select * from public.catalog_media_mirror_diff('<source-uuid>');  -- gate fidélité par source
```
```bash
# vérif fidélité via l'edge (dormant tant que la bascule n'est pas décidée)
curl -sS -X POST "$SUPABASE_URL/functions/v1/norva-playback/catalog-media-mirror-verify" \
  -H "Authorization: Bearer $NORVA_BACKFILL_TOKEN" -d '{"source_id":"<source-uuid>"}'
```

> **Note de déploiement** : la route `/catalog-media-mirror-verify` est ajoutée dans le code de
> `norva-playback` mais n'est **live qu'après un redéploiement** de la fonction. Read-only,
> service-role (`NORVA_BACKFILL_TOKEN`) — dormante et sans risque tant qu'elle n'est pas appelée.
