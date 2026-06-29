# Identité fournisseur & dédup cross-user (provider_key)

**Statut : audit fait + design validé + A & B implémentés sur la branche (rien en prod).**
**Reste : merge → appliquer la migration RPC → backfill C (cf. « Rollout » §5).**
**Décision produit (2026-06-29) : identité AUTOMATIQUE (empreinte) + label d'affichage optionnel.**

## 1. L'audit — l'URL ne détermine PAS le fournisseur

Le revendeur a fourni **22+ URLs pour un seul compte** chez « Strong IPTV 8K » (panel Xtream).
Vérifié avec les **mêmes identifiants** sur une douzaine d'URLs :

| Test (Xtream `player_api.php`) | Résultat |
|---|---|
| `user_info` (6 domaines variés) | **identiques** : `message:"Welcome to World 8K"`, mêmes `created_at` / `exp_date` / `max_connections:1`, **même `timestamp_now` à la seconde** → une seule horloge serveur |
| `get_vod_streams` (3 hôtes) | **171 813 films, même md5** `f52012ce…`, mêmes `stream_id` (`2024998`, `941570`…) |
| `get_series` (6 hôtes) | **45 618 séries, même md5** `81959da3…` |
| `get_series_info` (3 hôtes) | même `series_id` (47683) **et mêmes `id` d'épisodes** (2046320/21/22) |
| `get_*_categories` (5 hôtes) | **1722 catégories, fingerprint identique** `5d11549e…` |

**Conclusion** : les 22+ URLs sont des **miroirs** (alias DNS / reverse-proxy) d'**un seul panel**,
un seul catalogue, un seul espace d'ID. Domaines audités (tous = même backend) :
`super8k.top`, `boost8k.top`, `hyper8k.top`, `speed8k.top`, `0815-cdn.com`,
`tv.business-cdn-8k.com`, `pro.me-tv.cloud`, `pro.strongtv.club`, `pro.topott.co`,
`pro.albfrtv.com`, `pro.8k-ksa.com`, `pro.amjadottstore.com`, `cf.satiran.cc`, `cf.jvri.art`,
`pro.nurarihyon.cc`, `cf.humari.xyz`, `cf.shazmer.com`, `pro.taden-premium.cc`,
`pro.wondershop.cc`, `pro.ysqdms.cc`, `pro.worldmag.cfd`, `gold.api-cdn.cloud`,
+ backups `cf.sweet67.xyz`, `cf.jump2025.xyz`.

> NB : `max_connections:1` est par **compte** (pas par URL) → les miroirs donnent de la
> **résilience** (bascule si l'URL active tombe), **pas** de concurrence supplémentaire.

## 2. Le problème dans Norva

Les caches **cross-user** sont keyés par le **hostname** :
- `catalog_file_tracks` PK `(server_host, item_type, external_id)` — `server_host = hostFromUrl(url) = new URL(url).hostname` (`norva-playback/index.ts:1955`).
- `catalog_media_items` keyé par `server_host` aussi.
- La RPC `fanout_file_tracks_to_users` joint sur `s.config_hint->>'serverHost' = p_server_host`.

Donc deux users du **même panel** via deux URLs différentes (`super8k.top` vs `boost8k.top`)
→ **deux caches séparés** → l'enrichissement cross-user « instantané » est cassé, on re-sonde
du contenu identique, et sur mono-slot ça **gaspille le slot unique**.

> Aujourd'hui il n'y a **pas** de fragmentation active (owner sur `super8k.top`, frère sur
> `apdxes.xyz`, chacun une URL). C'est **préventif** : ça casse dès qu'un nouvel inscrit entre
> un miroir différent du même panel. D'où : on peut le faire proprement, sans urgence.

## 3. Le design — `provider_key` automatique

**Clé d'identité** (mirror-invariante, stable dans le temps, distincte entre panels) —
telle qu'**implémentée** (`providerKeyFromCategoryMaps` dans `norva-source-sync`) :

```
providerKey = "x:" + sha256( sorted_unique( lowercase(trim(category_name)) sur live+vod+series ).join("\n") )[:24]
```

**Pourquoi les NOMS de catégories, et pas le `idsHash` complet ni l'id de catégorie :**
- `idsHash` (per-title, `finalizeSig`) est mirror-invariant MAIS **dérive** à chaque ajout de
  contenu → mauvaise clé stable. Et il faut la liste VOD complète (~70 Mo).
- Les **catégories** sont minuscules (3 petits appels, déjà faits par la sync), **mirror-invariantes**
  (prouvé) et **stables** (la taxonomie bouge rarement, contrairement au catalogue).
- On hash les **noms** (pas les `category_id`) car un panel peut renuméroter ses ids ; le nom est
  la taxonomie humaine, plus stable. Set unique + trié → déterministe → **même clé sur tous les
  miroirs** quelle que soit la casse/l'ordre d'entrée.
- Vérifié empiriquement (noms seuls) : `x:c45055afc8aa774631c13e59` identique sur `super8k.top` /
  `boost8k.top` / `cf.satiran.cc`. (Valeur indicative — le tri JS des noms non-ASCII peut donner
  une valeur légèrement différente du calcul bash ; ce qui compte = l'edge est interne-cohérent.)
- **Hypothèse / risque résiduel** : deux panels DIFFÉRENTS avec une taxonomie de catégories
  *byte-identique* (mêmes ~1700 noms) partageraient une clé → fan-out croisé erroné. Négligeable
  (la taxonomie complète d'un panel est très distinctive ; une collision = quasi-certainement le
  même backend). Si jamais ça mord à grande échelle, ajouter un ancrage de contenu à la clé.

**Disponible tôt** : les catégories sont récupérées dès l'ajout/validation de la source (avant la
grosse sync) → on peut détecter « ce panel est déjà enrichi » **immédiatement** et éviter de
re-sonder → instantané pour le nouvel inscrit.

**Label d'affichage** : `config_hint.displayLabel` (optionnel, saisi par l'user, **cosmétique** —
jamais utilisé comme clé). Si absent → on affiche le `message` du panel ou le hostname.

## 4. Implémentation — état réel (branche `claude/webm-block-additions-error-pj16xm`)

**Incrément A — calcul & stockage de l'identité ✅ FAIT (additif, INERTE)**
- `norva-source-sync` : helper `providerKeyFromCategoryMaps()`. `providerKey` calculé (a) en fin de
  sync complète (`driveXtreamSyncToReady`, depuis `nameMaps` déjà en scope) et (b) à chaque détection
  (`detectXtreamChange` → persisté via `patchSourceConfigHint`, donc **les sources existantes
  acquièrent la clé au prochain tick `refresh-due` sans re-sync complète**). N'écrase jamais une clé
  par une valeur vide. Purement additif à `config_hint` → rien ne le lit tant que B n'est pas mergé.

**Incrément B — re-clé du cache `catalog_file_tracks` sur `providerKey` ✅ FAIT (défensif)**
- `norva-playback` : helpers `resolveSourceIdentity()` (cache in-isolate de `{host, key}` où
  `key = providerKey || serverHost`) + `resolveFileTracksKey(...)` (fallback `hostFromUrl(url)`).
  Les 4 sites du cache file-tracks (engine ~332 → read/share/whisper ; `persistOrderedAudioForTitle`
  ~1904 ; whisper-backfill ~2269 ; audio-backfill cron ~2449) utilisent désormais cette clé.
- Migration `20260629121000_fanout_file_tracks_provider_key.sql` : `fanout_file_tracks_to_users`
  joint sur `coalesce(s.config_hint->>'providerKey', s.config_hint->>'serverHost') = p_server_host`.
  Corps UPDATE identique à l'original. `upsert_catalog_file_tracks` inchangé (stocke la clé reçue).
- **Rétro-compatible / no-op aujourd'hui** : 0 source n'a de `providerKey` → `coalesce`=`serverHost`.
  Dry-run lecture seule sur 200 lignes réelles : owners OLD == NEW (200=200, 0 diff). Prouvé inerte.
- **Hors scope (suit)** : `catalog_media_items` reste keyé par hostname (son writer écrit pendant
  l'import, avant que la clé soit finalisée ; et ses lectures retombent toujours sur le per-user →
  un mauvais key = simple miss, jamais une casse). Re-clé = follow-up dédié.

**Incrément C — backfill one-shot 🔜 POST-MERGE (préparé, NON appliqué)**
Une fois `providerKey` peuplé sur les sources existantes (prochain tick `refresh-due`), basculer les
lignes file-tracks existantes du hostname vers la clé canonique (sinon : simple cache-miss + re-sonde,
non bloquant). Lit la **vraie** clé depuis `config_hint` (jamais une valeur calculée hors-edge) :
```sql
with mapping as (
  select distinct config_hint->>'serverHost' as host, config_hint->>'providerKey' as pk
  from public.cloud_sources
  where config_hint->>'providerKey' is not null and config_hint->>'serverHost' is not null
)
-- 1) copie les lignes host-keyed vers la clé providerKey (ignore si déjà présente)
insert into public.catalog_file_tracks
  (server_host, item_type, external_id, audio_tracks, subtitle_tracks, audio_probed_at, subtitle_probed_at, updated_at)
select m.pk, c.item_type, c.external_id, c.audio_tracks, c.subtitle_tracks, c.audio_probed_at, c.subtitle_probed_at, c.updated_at
from public.catalog_file_tracks c join mapping m on c.server_host = m.host
on conflict (server_host, item_type, external_id) do nothing;
-- 2) supprime les anciennes lignes host-keyed
with mapping as (
  select distinct config_hint->>'serverHost' as host, config_hint->>'providerKey' as pk
  from public.cloud_sources
  where config_hint->>'providerKey' is not null and config_hint->>'serverHost' is not null
)
delete from public.catalog_file_tracks c using mapping m where c.server_host = m.host;
```

**Incrément D — label d'affichage ✅ DÉJÀ COUVERT (pas de nouveau code)**
La création de source (`norva-cloud/createSource`) **exige déjà** un `display_name` saisi par l'user
à l'onboarding → c'est le label cosmétique optionnel. On a délibérément **évité** d'ajouter un champ
« nom du fournisseur » servant d'IDENTITÉ (c'est l'auto-`providerKey` qui s'en charge). Les spreads
`config_hint` préservent `providerKey` à chaque update/sync. Rien à ajouter.

**Incrément E (bonus, non fait) — failover miroirs**
Stocker la liste des miroirs par `providerKey` ; basculer sur un backup si l'URL active tombe.

## 5. Rollout & risque

- A + B + migration sont sur la branche. Les edge functions ne déploient **que sur merge `main`**
  (`deploy-supabase-functions.yml`) → branche inerte en prod. **Rien appliqué à la prod.**
- **Ordre post-merge :** (1) appliquer la migration `20260629121000…` (RPC `coalesce`, prouvée no-op)
  — à faire **avec/juste après** le merge, sinon la fanout (ancienne, join `serverHost` seul)
  renverra 0 pour les sources keyed → cache rempli mais pas de push cross-user (dégradé, pas cassé) ;
  (2) attendre que `refresh-due` peuple `providerKey` sur les 2 sources (ou forcer un detect) ;
  (3) lancer le backfill C ; (4) vérifier un hit cross-miroir.
- **Risque principal** : `fanout_file_tracks_to_users` sert l'enrichissement LIVE du frère. Le
  `coalesce` la rend no-op tant qu'aucun `providerKey` n'existe → pas de régression (dry-run prouvé).
- **Rollback** : retirer `providerKey` de `config_hint` → tout retombe sur `serverHost`.

## 6. Vérifié dans cet environnement
- Audit miroirs : 100 % concluant (md5 identiques, IDs identiques films/séries/épisodes).
- Fingerprint `providerKey` : identique sur les miroirs testés (calcul hors-ligne).
- `node`/esbuild transpile OK sur `norva-source-sync` + `norva-playback` édités.
- Migration RPC : dry-run lecture seule prouve OLD == NEW (no-op) tant que `providerKey` absent.
- ⚠️ Non testable ici : runtime RPC/edge (pas de provider/MSE/ffmpeg) → valider en prod post-merge.
