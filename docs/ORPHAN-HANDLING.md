# Norva — Gestion des orphelins de catalogue (Couches 1 / 2 / 3)

Quand un média disparaît du catalogue d'un provider (retiré, ou provider qui rate-limit pendant
un sync), il ne doit **plus jamais** rester visible/cliquable côté user (sinon clic → 404 →
dégradation UX, le « cas Airysat »). Ce document décrit l'architecture complète, ce qui est livré,
et la mécanique exacte du correctif racine.

> **TL;DR** : Couche 1 (masquage immédiat dans la découverte) **LIVE** ; Couche 3 (le sync ne peut
> plus jamais vider le catalogue) **LIVE** ; Couche 2 (soft-delete) **non nécessaire** — la
> combinaison Couche 1 + Couche 3 couvre le besoin. Détails ci-dessous.

---

## 1. Le problème — comment naissent les orphelins

Deux modèles de catalogue coexistent :

| Table | Rôle | Clé |
|-------|------|-----|
| `cloud_media_items` | catalogue **brut** par source (ce que le provider liste) | `(source_id, item_type, external_id)` |
| `cloud_titles` (+ `cloud_title_variants`) | titres **dédupliqués** TMDB, avec `variant_count` | `(user_id, item_type, identity_key)` |

Un **orphelin** = un `cloud_titles` avec `variant_count = 0` (plus aucune version jouable). Cause
historique : `driveXtreamSyncToReady` faisait **delete-all-puis-réimport**. Or `fetchCatalog`
avalait les erreurs provider en `[]` (`.catch(() => [])`) — donc un compte rate-limité / expiré
renvoyait des catégories vides, la découverte « se terminait » avec un catalogue décimé (ou vide),
et la source passait quand même `ready`. Résultat : titres orphelins + browse vide.

C'est exactement ce qui a généré les **18 399 titres orphelins** du compte jeremy après qu'il ait
supprimé/réimporté ses providers (nettoyés manuellement le 30/06, cache de sonde préservé).

---

## 2. Couche 1 — masquer les orphelins dans la découverte (LIVE)

Objectif : aucune surface user ne montre un titre injouable.

**Déjà en place et vérifié** — toutes les surfaces titres filtrent `variant_count > 0` :
`norva-catalog/index.ts` lignes 148 (`titlesBase`), 640, 848, 939, 1061, et
`listVerifiedTitleCandidates` (1274, qui alimente les rails « genres » / « pour vous » /
« parce que vous avez regardé »). La grille principale `/media/page` lit `cloud_media_items`
(catalogue brut, donc uniquement des entrées réellement présentes) → pas d'orphelins non plus.
Le titre-ancre de « parce que vous avez regardé » n'est utilisé que pour ses genres, jamais affiché
comme poster cliquable.

**Le seul vrai trou — corrigé (commit `7ce2451`, edge `norva-cloud`)** : la rangée
**« Continue Watching »** se construit depuis l'**historique** (`cloud_watch_history`), pas depuis
les rails filtrés. Donc un film **retiré par un provider encore actif** restait en carte « en
cours » et **plantait au clic** (le vrai cas Airysat — 2 occurrences live au moment du fix).

Correctif dans `listHistory` (`supabase/functions/norva-cloud/index.ts`) :
- nouvelle fonction `listHistorySources` (expose `sync_status`) + `pruneUnavailableHistory`.
- on retire les lignes d'historique **films** dont le `external_id` n'existe plus dans
  `cloud_media_items`, **mais uniquement** si la source est **stablement synchronisée**
  (`sync_status` ∈ `ready`/`completed`) → jamais pendant un sync (fenêtre où le catalogue est
  temporairement vide) ;
- **non destructif** : la ligne d'historique est conservée → si le titre revient, la carte
  réapparaît seule ;
- **fail-safe** : la moindre erreur de lecture DB ⇒ on garde tout ;
- **films uniquement** : la clé série de l'historique n'est pas vérifiable (0 ligne série en base),
  laissée intacte pour zéro risque de régression.

> Pourquoi côté serveur : `/history` est le point de passage unique de toutes les pages
> (Movies/Series/Home) et de tous les appareils → un seul correctif couvre tout, zéro churn front.

---

## 3. Couche 3 — le sync ne peut plus jamais vider le catalogue (LIVE)

C'est la **correction racine** (commit `965c1c3`, edge `norva-source-sync` ;
migration `20260630160000_layer3_catalog_versioning.sql`).

### Principe : upsert-puis-prune (au lieu de delete-puis-réimport)

Un run **versionné** (`cursor.runVersion`, un `Date.now()` unique posé par `freshSyncCursor`) :

1. **Ne supprime plus rien en amont.** Il upsert sur le catalogue vivant.
2. **Marque chaque ligne re-vue** avec `catalog_version = runVersion`. Mécanique : insert
   `ON CONFLICT DO NOTHING` (les nouvelles lignes portent déjà la version), **puis un UPDATE ciblé
   d'une seule colonne** `catalog_version` sur les `external_id` du lot. ⚠️ Volontairement **pas**
   un `DO UPDATE` complet : ça écraserait le profil codec que `norva-playback` réécrit dans
   `metadata`/`playback_hint`. Le UPDATE ciblé **préserve l'enrichissement**.
3. **Compte les erreurs fetch** (`cursor.fetchErrors`) — `fetchCatalog` n'avale plus une erreur en
   `[]` silencieux, il l'incrémente.
4. **À la complétion, prune uniquement les lignes non re-vues** (`catalog_version is distinct from
   runVersion`, via RPC batché `prune_stale_source_items`) — **et seulement si la découverte est
   saine** :
   - `fetchErrors == 0`, **ET**
   - le prune retirerait **< 50 %** du catalogue (`PRUNE_MAX_REMOVE_FRACTION = 0.5`) — garde-fou
     anti « provider en panne qui renvoie une liste quasi vide ».
   - **Re-vérification single-flight juste avant le DELETE** : on relit `syncCursor.startedAt` et on
     bail si un re-sync forcé concurrent nous a supplantés (sinon on supprimerait ses lignes
     fraîches stampées d'une autre version).
5. **Si découverte non saine → on ne prune pas.** Le catalogue reste un **sur-ensemble** (ancien +
   nouveau) : la source sert toujours, la Couche 1 masque les éventuels orphelins-titres, et le
   **prochain run sain** nettoie.
6. **Cas « refresh qui re-voit 0 item »** (provider down) : on **garde l'ancien catalogue**, on
   repasse `ready` **sans toucher la signature**, sans erreur — ce qui **évite le re-hammer** du
   watchdog (le scénario `endpoint_abuse` auto-entretenu d'apdxes). Un premier sync réellement vide
   (aucun item antérieur) reste, lui, une vraie erreur 422.

### Migration `20260630160000_layer3_catalog_versioning.sql` (appliquée + commitée)
- `alter table cloud_media_items add column if not exists catalog_version bigint;` (nullable, ajout
  instantané, aucun rewrite).
- RPC `prune_stale_source_items(p_source, p_user, p_version, p_limit)` : delete batché par subquery
  LIMIT (pas de liste d'ids sur le fil), garde `if p_version is null then return 0` (fail-safe),
  `grant execute` au seul `service_role`.

### Rétro-compatibilité (déployable même en plein sync)
Les curseurs **legacy** (créés avant le déploiement, sans `runVersion`) gardent **partout**
l'ancien chemin : delete-gate → branche legacy (delete déjà fait = no-op) ; `appendSourceItems` →
`ignoreDuplicates:true` sans marquage ; complétion → pas de prune. Comportement **identique** à
l'avant-changement. Donc un sync déjà en vol au moment du déploiement finit en legacy, sans risque.

> **Observation prod (30/06 ~20:0x)** : KING365 (20:05) et Opplex (20:09) ont démarré **après** le
> déploiement (20:01:39) mais ont des curseurs **sans `runVersion`** → ils tournent en legacy. Cause :
> **latence de propagation des isolates « chauds »** d'Edge (leur requête de création a frappé un
> isolate encore sur l'ancien code). C'est le comportement rétro-compatible attendu (bénin : un
> premier sync n'a rien à supprimer). Le code déployé est confirmé correct (`freshSyncCursor`
> contient bien `runVersion: Date.now()`). **Le prochain provider ajouté empruntera le chemin
> versionné** — validation end-to-end à faire à ce moment-là (vérifier que `catalog_version` est
> tamponné et que le prune se comporte), **sans forcer de re-sync** (ça re-balaierait un panel).

### Revue adversariale — 2 trouvailles corrigées
La revue (6 points de risque audités, tous clean : typage bigint, accumulation `fetchErrors` entre
isolates, rétro-compat legacy, gestion des NULL, awaits, TS) a remonté 2 défauts, **corrigés** :
1. **(perte de données conditionnelle)** prune sans re-check single-flight → un re-sync **forcé**
   concurrent pouvait faire supprimer ses lignes fraîches. → ajout de la re-vérification
   `startedAt === myRun` **juste avant le DELETE**.
2. **(écrasement enrichissement)** le `DO UPDATE` écrasait le profil codec. → remplacé par insert
   `DO NOTHING` + UPDATE ciblé `catalog_version` seul. Vérifié sur table isolée (le `codecProfile`
   survit, la version avance bien).

### Validation mécanique DB (table temp isolée)
- DO-UPDATE / marquage : `created_at` et enrichissement **préservés**, ligne re-vue **stampée**.
- Prune `is distinct from version` : supprime **exactement** les lignes non re-vues, **y compris les
  lignes legacy `NULL`** ; conserve les lignes re-vues et les nouvelles.

---

## 4. Couche 2 — soft-delete (NON retenue)

Un flag `available boolean` existe déjà sur `cloud_media_items` (défaut `true`, non utilisé par le
prune). Une couche de soft-delete « confirmé orphelin » a été envisagée mais **non nécessaire** :
Couche 1 masque déjà côté découverte, Couche 3 supprime à la racine après un run sain. On garde la
porte ouverte (le flag existe) si un jour on veut un état intermédiaire « masqué mais pas supprimé ».

---

## 5. État des orphelins résiduels (30/06)

| Compte (user_id) | Orphelins titres | Surfacent en grille ? | Décision |
|---|---|---|---|
| airo `7bdab1df` | 221 (219 films + 2 séries) | **0** (plus de `cloud_media_items`) | invisibles partout → laissés, nettoyés par un futur run Couche 3 |
| super8k `c5be5ac4` | 156 (131 films + 25 séries) | 9 ont encore un `cloud_media_items` brut (potentiellement transitoires) | non supprimés (comptes vivants, risque de média qui « bug à l'instant T ») |

> Les 18 399 orphelins du compte **jeremy** (providers supprimés) ont été nettoyés manuellement le
> 30/06 — cache de sonde `catalog_file_tracks` (35 522 lignes) **préservé**, historique intact.

---

## 6. Mémoire opérationnelle (comptes, providers, crons)

### Mapping compte → user_id → providers (au 30/06)
| Surnom | Email | user_id | Providers |
|---|---|---|---|
| **jeremy** | hernandez.jeremy@outlook.fr | `0b971271-9fa1-4547-8dc6-ab64dcbb9d33` | **IPTV Ferran** (`ready`, 64 681 items) |
| **airo** | projethorizon2030@gmail.com | `7bdab1df-80e6-46f9-bcdf-84b6595819a8` | Airysat (`ready`, 14 381) · IPTV Ninja Premium Plus (288 957) · KING365 (22 435) · **Opplex IPTV** (le + récent) |
| **super8k** | — | `c5be5ac4-3700-4a25-9509-8eaf7771fdb6` | (cron subtitle-pregen-super8k) |

> ⚠️ Le compte que l'owner appelle « 2020 » est en réalité **`projethorizon2030@gmail.com`**.

### Crons = **par compte (`userId`), pas par source**
Le balayage `audio-backfill` couvre **tout le catalogue du compte, toutes sources confondues**. Donc
**un nouveau provider sur un compte déjà câblé est sondé automatiquement** — rien à créer. Ferran →
crons `*-jeremy` ; Ninja/KING365/Opplex/Airysat → crons `*-airo`.

### Garde-fou connexion (30/06) : tout en `concurrency:1`
Ferran étant un panel neuf de limite inconnue, **toutes** les crons jeremy sont passées en
`concurrency:1` (`audio-langs-jeremy` jobid 36 : 2 → 1 via `cron.alter_job`). airo idem. Les crons de
nuit sont **décalées** (offsets minute 0/3/6, cycle 9) → jamais deux accès simultanés au même panel,
même en cumulant les jobs. Évite le 429/`endpoint_abuse`.

---

## 7. Fichiers & commits

| Quoi | Où | Commit |
|---|---|---|
| Couche 1 (Continue Watching) | `supabase/functions/norva-cloud/index.ts` (`listHistory`, `listHistorySources`, `pruneUnavailableHistory`) | `7ce2451` |
| Couche 3 (upsert-puis-prune) | `supabase/functions/norva-source-sync/index.ts` (`freshSyncCursor`, `fetchCatalog`, delete-gate, `appendSourceItems`, complétion, helpers `countSeenByType`/`countSourceItems`/`pruneStaleSourceItems`) | `965c1c3` |
| Migration Couche 3 | `supabase/migrations/20260630160000_layer3_catalog_versioning.sql` | `0c179d8` (appliquée live) |
| Garde-fou cron | `cron.alter_job(36, …)` (live DB, pas de fichier) | — |

**Constantes clés** : `PRUNE_MAX_REMOVE_FRACTION = 0.5` ; `runVersion = Date.now()` ;
`IMPORT_BATCH_SIZE = 250` (taille du lot UPDATE, sous la limite d'URL).

---

## 8. Reste à faire

- [ ] **Valider la Couche 3 end-to-end** sur le prochain provider ajouté / re-sync naturel
  (vérifier `catalog_version` tamponné + comportement du prune). Ne **pas** forcer de re-sync (panel).
- [ ] (optionnel) Si jamais on veut purger les 377 orphelins résiduels avant un run Couche 3 :
  uniquement les `variant_count=0` **sans** `cloud_media_items` brut, jamais les transitoires.
