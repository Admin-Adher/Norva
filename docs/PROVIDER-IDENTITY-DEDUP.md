# Identité fournisseur & dédup cross-user (provider_key)

**Statut : audit fait + design validé + A & B implémentés sur la branche (rien en prod).**
**Reste : merge → appliquer la migration RPC → backfill C (cf. « Rollout » §5).**
**Décision produit (2026-06-29) : identité AUTOMATIQUE (empreinte) + label d'affichage optionnel.**

> **⚠️ MISE À JOUR MAJEURE (2026-07-01) — voir §8.** Le providerKey basé sur la **taxonomie de catégories**
> (§3) s'est révélé volatile et incorrect : il a **raté un miroir à 100 %** (Opplex & Ferran partagent
> 40 555/40 555 stream IDs mais ont eu 2 clés différentes car leurs catégories diffèrent d'une seule). Le
> §8 décrit le **redesign long terme livré** : empreinte sur les **stream IDs** + couche d'**identité
> canonique** (`provider_identities`). Les §1–7 restent l'historique de l'approche taxonomie.

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

## 7. Registre d'identités provider (`catalog_provider_identities`) — pour le DASHBOARD ADMIN
Table qui **nomme** chaque empreinte (`providerKey` → nom humain). C'est la **source de vérité** du futur
dashboard admin et elle **survit à la suppression** d'une source/compte (les caches de sonde persistent,
keyés par `providerKey` ou `server_host`). Migration `20260630220000_provider_identity_registry.sql`.

Schéma : `provider_key (PK), display_name, status ('active'|'deleted'), notes, first_seen, last_seen`.
Service-only (RLS). **Vue dashboard** : JOIN à `catalog_file_tracks` (group by `server_host`) pour le
**footprint live** (nb de sondes en cache, dernière sonde) ; à `cloud_sources` pour les sources actives ;
à `catalog_generated_subtitles` (col `provider_key`) pour les sous-titres IA générés.

**Peuplement** :
- **Actifs** : auto-dérivés de `cloud_sources` (`config_hint->>'providerKey'`). ⚠️ **TODO** : faire
  **upsert par le moteur** dès qu'il calcule un `providerKey` (à câbler dans `_shared/xtream-sync.ts`
  après la dédup — cf. `SYNC-ENGINE-DEDUP.md`), pour que le registre reste à jour sans seed manuel.
- **Supprimés/historiques** : labels manuels (connaissance produit durable), seedés dans la migration.

**Mappings connus au 30/06** (empreinte → nom) :

| `providerKey` | Nom | Statut | Sondes en cache |
|---|---|---|---|
| `x:f5be3bb7a67f79041f4e5174` | **AtlasPro** (apdxes.xyz) | 🔴 supprimé (abuse 27/06) | 24 965 |
| `x:0066336cbe4f603a40eaf27a` | Strng IPTV 8K | 🟢 actif | 3 741 |
| `x:045daa5715a90bba3bfcfcae` | IPTV Ninja Premium Plus | 🟢 actif | 399 |
| `x:5aaacb35239991f93835f575` | Airysat | 🟢 actif | 159 |
| `x:e75e064649e5f9c80b14b681` | Promax 4K OTT | 🟢 actif | 58 |
| `x:c75fcba6cfe532e66b0f9c86` | IPTV Ferran | 🟢 actif | 0 (sonde à démarrer) |
| `x:dd3cbe0e7b11336eaca2ddf9` | KING365 | 🟢 actif | 0 (empreinte fraîche) |
| `x:93d4de80882a2a475524545a` | *non identifié* | 🔴 supprimé | 4 215 |
| `x:2cb272cba2117a8ffe1d8b33` | *non identifié* | 🔴 supprimé | 1 991 |
| `x:65e5aaaf9fabb424ea1f5557` | *non identifié* | 🔴 supprimé | 1 100 |
| `fun-fun2026.lol` | *non identifié (host legacy)* | 🔴 supprimé | 22 |

> **AtlasPro = `x:f5be3bb7…`** : identification par footprint (plus gros cache orphelin, fin de sonde le
> 27/06 = suppression, volume ≈ 34 % de son catalogue, cohérent avec l'historique). Le hash étant à sens
> unique, ce n'est pas une preuve cryptographique mais l'empreinte est sans ambiguïté. **Opplex** n'a pas
> encore d'empreinte (arrive au prochain tick de détection) → pas encore au registre.
>
> **Payoff** : re-brancher AtlasPro (n'importe quelle URL) recalcule `x:f5be3bb7…` → hérite des 24 965
> sondes instantanément. **Ne JAMAIS purger les caches orphelins.**

## 8. Redesign long terme (2026-07-01) — empreinte STREAM-ID + identité canonique

### 8.1 Pourquoi la taxonomie était le mauvais signal (preuve live)
Le providerKey de §3 hache les **noms de catégories**. Or les catégories sont **cosmétiques** (chaque
revendeur les renomme ; elles dérivent). Constaté en prod :
- **Opplex** et **Ferran** partagent **40 555 / 40 555 stream IDs de films (100 %)** — même panel, deux
  revendeurs — MAIS ont eu **deux providerKeys différents** (`x:8170c3bd` vs `x:999dec89`) parce que
  leurs listes de catégories diffèrent d'**une seule** (397 vs 396 catégories live). → **miroir raté.**
- La clé de **Ferran a muté toute seule** (`x:c75fcba6` → `x:999dec89`) en 8 h par simple dérive de
  taxonomie. → **empreinte volatile** : caches orphelins + identité fragmentée.

**Coût réel** : miroirs non fusionnés = 2× le travail cross-user (sous-titres whisper générés deux fois,
probing deux fois) ; et chaque dérive orpheline les caches keyés par providerKey (dont
`catalog_generated_subtitles`, cher à régénérer).

### 8.2 Le design — 2 couches
1. **Empreinte sur le CONTENU stable = les stream IDs (`external_id`).** Les miroirs les partagent à
   l'identique ; les renommages de catégories n'y touchent pas. On garde par identité un **échantillon
   bottom-256 par md5** des stream IDs films+séries (un *bottom-k MinHash sketch* : déterministe, réparti
   sur toute la plage d'IDs — pas de collision sur les petits entiers) et on **matche par recouvrement de
   Jaccard** (seuil 0.5 ; miroirs ≈ 1.0, panels distincts ≈ 0).
2. **Identité canonique `provider_identities`** (UUID) vers laquelle **plusieurs empreintes résolvent**
   (plusieurs → une). C'est l'**entité du dashboard admin** et la **clé stable** sur laquelle les caches
   cross-user migreront (Phase B) — pour survivre à la dérive, aux miroirs, aux changements de schéma.

### 8.3 Ce qui est LIVRÉ (Phase A — appliqué en prod + hook déployé)
- Migration `20260701000000_provider_identity_resolution.sql` (**appliquée live**) :
  - table `provider_identities` (entité canonique + `stream_sample text[]` + GIN index) ;
  - `catalog_provider_identities.identity_id` (FK) + statut élargi (`superseded`) ;
  - **RPC `norva_resolve_provider_identity(source_id, provider_key, display_name)`** : calcule
    l'échantillon depuis `cloud_media_items`, tient à jour le registre nom↔empreinte, **résout-ou-crée**
    l'identité par recouvrement Jaccard, sous **`pg_advisory_xact_lock`** (pas de doublon d'identité en
    concurrence). Défensif : < 32 items → diffère la résolution (garde le registre à jour quand même) ;
  - vue **`admin_provider_overview`** (1 ligne/identité + ses empreintes + `fingerprint_count`).
- Hook `recordProviderIdentity` (`_shared/xtream-sync.ts`) **rebranché sur la RPC** — déployé.
- **Backfill des 7 sources** exécuté → **6 identités** ; **Opplex + Ferran fusionnés** en une identité
  (`94c49af9…`, « IPTV Ferran ») portant **4 empreintes** (2 miroirs actifs + l'ancienne clé Ferran +
  le host legacy `fun-fun2026.lol`, ces 2 en `superseded`).

### 8.4 Phase B — re-clé des caches cross-user sur `identity_id` (✅ LIVRÉE)
Les deux caches cross-user passent de la clé-empreinte (volatile) à l'`identity_id` (stable). **Point de
levier unique** : `resolveSourceIdentity` dans `norva-playback` — c'est le seul endroit qui dérive la clé,
donc le changer re-clé d'un coup `catalog_file_tracks` (lecture/écriture/fanout) **et** toutes les ops
`catalog_generated_subtitles` (transcript/ocr/translation).

**Implémenté :**
1. `resolveSourceIdentity` renvoie `key = identity_id` (résolu via `catalog_provider_identities`), fallback
   `providerKey` → `host` si pas d'identité (source non résolue / provider supprimé = comportement d'avant).
   Ajoute `fingerprint` (le providerKey brut) au retour, mémoïsé in-isolate.
2. `getGeneratedSubtitle` : **fallback lecture** sur le `fingerprint` brut si l'identité rate → un VTT généré
   avant la re-clé reste servi pendant la transition (pas de régénération).
3. `fanout_file_tracks_to_users` : join sur l'identité — **rétro-compatible** (match `identity_id` OU
   `providerKey`/host), donc sûr à appliquer avant le déploiement. Migration `20260701010000`.
4. **Backfill de fusion** (migration `20260701020000`, à lancer APRÈS le déploiement) : fusionne les lignes
   éparpillées d'un panel (les 4 clés Opplex/Ferran) sous l'`identity_id`, garde la ligne la plus complète,
   supprime les anciennes. Idempotent. Les lignes keyées par hostname (sous-cache tmdb/imdb de
   `vod-title-projection`) restent — c'est le follow-up **Phase B.2**.

> **Sécurité** : ces caches **dégradent proprement** — un miss = on re-sonde (chemin normal), jamais une
> casse playback. Le fallback fingerprint + le join rétro-compatible rendent la transition sans régression.
> **Le gain** : Opplex 38→387 fichiers lisibles (×10), Ferran 123→387 (×3), 228 sondes orphelines
> récupérées, et les 2 crons deviennent 2 ouvriers parallèles sur un seul catalogue (≈2× plus vite, 0 re-sonde).

### 8.5 Suite optionnelle
- **Empreintes supprimées sans items** (AtlasPro + 3 non-identifiés) : restent des lignes registre sans
  identité canonique (aucun item pour les fingerprinter). On peut leur créer des *identity shells* si le
  dashboard veut les afficher comme entités.
- **Phase C** : retirer le providerKey-taxonomie au profit de l'empreinte stream-ID comme unique signal.

### 8.6 Vérifié (2026-07-01)
- Overlap Opplex∩Ferran = **40 555/40 555 (100 %)** — même panel prouvé par stream IDs.
- Migration appliquée ✅ ; backfill → Opplex & Ferran **même `identity_id`** ✅ ; 6 identités pour 7 sources.
- `esbuild` parse + sweep anti-duplication sur le moteur partagé ✅.
