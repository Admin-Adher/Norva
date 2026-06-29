# Identité fournisseur & dédup cross-user (provider_key)

**Statut : audit fait + design validé. Implémentation à dérouler (cf. « Rollout » en bas).**
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

**Clé d'identité** (mirror-invariante, stable dans le temps, distincte entre panels) :

```
providerKey = "x:" + sha256( normalize(user_info.message) + "|" +
                             sorted( "{category_id}:{category_name}" sur vod+series+live ) )[:24]
```

**Pourquoi les catégories + message, et pas le `idsHash` complet :**
- `idsHash` (déjà calculé par `computeContentSignature`) est mirror-invariant MAIS **dérive** à
  chaque ajout de contenu → mauvaise clé stable. Et il faut la liste VOD complète (~70 Mo).
- Les **catégories** sont minuscules (3 petits appels), **mirror-invariantes** (prouvé : même
  fingerprint sur 5 miroirs) et **stables** (la taxonomie change rarement, contrairement au
  catalogue). Le `message` ajoute la marque du panel et désambiguïse les taxonomies génériques.
- Vérifié empiriquement : `5d11549e…` identique sur `super8k.top` / `boost8k.top` / `cf.satiran.cc`
  / `pro.amjadottstore.com` / `gold.api-cdn.cloud`.

**Disponible tôt** : les catégories sont récupérées dès l'ajout/validation de la source (avant la
grosse sync) → on peut détecter « ce panel est déjà enrichi » **immédiatement** et éviter de
re-sonder → instantané pour le nouvel inscrit.

**Label d'affichage** : `config_hint.displayLabel` (optionnel, saisi par l'user, **cosmétique** —
jamais utilisé comme clé). Si absent → on affiche le `message` du panel ou le hostname.

## 4. Implémentation (par incréments, défensive)

**Incrément A — calcul & stockage de l'identité (additif, INERTE, zéro risque)**
- `norva-source-sync` : à l'ajout/validation ET en fin de sync, calculer `providerKey` (message +
  catégories) et écrire `config_hint.providerKey`, `config_hint.providerMessage`. Passer/garder
  `config_hint.displayLabel`. Purement additif à un blob jsonb → rien ne le lit encore.

**Incrément B — re-clé des caches sur `providerKey` (cutover, défensif)**
- Migration : `fanout_file_tracks_to_users` joint sur
  `coalesce(s.config_hint->>'providerKey', s.config_hint->>'serverHost') = p_server_host`.
  → **rétro-compatible** : sans `providerKey`, c'est exactement le comportement actuel (no-op).
- `norva-playback` : la clé de cache devient `providerKeyForSource(source) ?? hostFromUrl(url)`
  (sites : ~332, 406, 413, 1904, 2055, 2269, 2449). Idem `catalog_media_items` côté
  `norva-catalog` / `norva-series-info`.
- L'`upsert_catalog_file_tracks` ne change PAS (il stocke la clé qu'on lui passe).

**Incrément C — backfill one-shot (post-merge, quand les providerKey existent)**
- Pour chaque provider connu : `update catalog_file_tracks set server_host = <providerKey>
  where server_host = <hostname>` (idem `catalog_media_items`), pour que les ~25k lignes
  existantes basculent sous la clé canonique (sinon simple cache-miss → re-sonde, non bloquant).

**Incrément D — UI**
- Onboarding : champ « nom de ton fournisseur » (optionnel) → `displayLabel`. Affichage du label
  (ou message panel) à la place du hostname dans la gestion des sources.

**Incrément E (bonus) — failover miroirs**
- Stocker la liste des miroirs par `providerKey` ; basculer sur un backup si l'URL active tombe.

## 5. Rollout & risque

- A/B/C/D sont sur la branche `claude/webm-block-additions-error-pj16xm`. Les edge functions ne
  déploient **que sur merge `main`** (`deploy-supabase-functions.yml`) → la branche est inerte en prod.
- **Ne RIEN appliquer à la prod en avance du code** (la migration B est rétro-compatible, mais on
  garde code+SQL synchrones). Ordre : merge (A+B+D) → vérifier que la sync écrit `providerKey` →
  lancer le backfill C → vérifier un hit cross-miroir.
- **Risque principal** : la RPC `fanout_file_tracks_to_users` sert l'enrichissement LIVE du frère.
  Le `coalesce` la rend no-op tant qu'aucun `providerKey` n'existe → pas de régression. À
  dry-run en lecture seule (reproduire le JOIN) avant déploiement.
- **Rollback** : retirer `providerKey` de `config_hint` → tout retombe sur `serverHost`.

## 6. Vérifié dans cet environnement
- Audit miroirs : 100 % concluant (md5 identiques, IDs identiques films/séries/épisodes).
- Fingerprint `providerKey` (message + catégories) : identique sur 5 miroirs, calculé hors-ligne.
- ⚠️ Non testable ici : le comportement runtime des RPC/edge (pas de provider/MSE/ffmpeg) → à
  valider en prod après merge, en lecture seule d'abord.
