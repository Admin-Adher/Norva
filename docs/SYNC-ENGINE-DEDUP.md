# Norva — Dédup du moteur de sync Xtream (WIP) + post-mortem incident 503

> **État au 30/06** : **NON terminé.** La Couche 3 (orphelins) est live dans `norva-source-sync` mais
> **dormante en pratique** parce que le moteur de sync est **dupliqué** et que le chemin d'ajout de
> provider passe par la copie `norva-cloud` (ancien code). Le refactor de déduplication a été **commencé
> puis annulé** suite à un incident (un déploiement Couche 3 a fait tomber `norva-source-sync` en 503).
> Ce doc = état exact + plan de reprise + leçon de l'incident.

---

## 1. Le problème : DEUX copies du moteur de sync

`freshSyncCursor` ET `driveXtreamSyncToReady` (+ tous leurs helpers) existent **en double** :
- `supabase/functions/norva-source-sync/index.ts` ← **canonical** (a reçu la Couche 3 : upsert-puis-prune)
- `supabase/functions/norva-cloud/index.ts` ← **plus ancien** (pas de Couche 3, `deleteSourceItems` bugué
  via SELECT-ids→`.in`, `freshSyncCursor` sans `sig` ni `runVersion`)

**L'ajout d'un provider passe par `norva-cloud`** (`createSource` → `syncCloudSource` → `driveXtreamSyncToReady`
de norva-cloud, lignes ~1219-1280). Donc tout nouveau sync prend l'**ancien chemin**, le curseur n'obtient
jamais `runVersion`, et la Couche 3 ne s'active pas.

**Comment on l'a découvert** : le provider « Promax 4K OTT » ajouté après le déploiement Couche 3 avait un
curseur **sans `runVersion` ni `sig`** — la signature exacte de `norva-cloud`'s `freshSyncCursor` (1365),
pas celle de norva-source-sync.

---

## 2. La carte d'extraction (résultat de l'audit)

| Symbole | norva-source-sync (A) | norva-cloud (B) | Statut |
|---|---|---|---|
| `driveXtreamSyncToReady` | canonical (Couche 3) | ancien | **DIVERGÉ majeur** |
| `freshSyncCursor` | + `sig`/`runVersion`/`fetchErrors` | minimal | DIVERGÉ |
| `appendSourceItems` | runVersion + marquage | void | DIVERGÉ |
| `deleteSourceItems` | RPC batché (correct) | SELECT→`.in` (bugué) | DIVERGÉ |
| `xtreamRows`, `categoryMap`, `dedupeByConflictKey` | = | = | identiques |
| `selfInvokeSyncStep` | → norva-source-sync | → norva-cloud | **DIVERGÉ (routing)** |
| `selfInvokeFinalize` | → norva-source-sync `(id,country)` | → norva-source-sync `(id)` | DIVERGÉ (signature) |
| Couche 3 (`countSeenByType`, `pruneStaleSourceItems`, `emptySig/updateSig/finalizeSig`, `maybeRecordContentEvent`, `providerKeyFromCategoryMaps`, `detectXtreamChange`, constantes) | présent | **absent** | A-only |

**Côté finalize + crons** (`driveFinalizeToReady`, `cronResumeStuck` watchdog, `cronRefreshDue`,
`cronFinalizeSource`) → **uniquement dans A**, pas dupliqué. B's `selfInvokeFinalize` cross-invoque déjà
la route finalize de A. Donc A est déjà le « hub » du finalize + watchdog.

---

## 3. Plan de dédup retenu (à exécuter)

**Créer `supabase/functions/_shared/xtream-sync.ts`** = moteur canonical de A, **autonome** (copies privées
de ses utils + helpers provider : `getRuntimeConfig`/`decryptSourceConfig`/`fetchProviderMetadata`/
`normalizeBaseUrl` + `compactRecord`/`recordOrEmpty`/`stringOr`/`throwDb`/`HttpError`/`withDbRetry`…),
exportant `driveXtreamSyncToReady`, `freshSyncCursor`, `detectXtreamChange`.

**Décision clé — consolider tous les self-invoke sur `norva-source-sync`** : `selfInvokeSyncStep` et
`selfInvokeFinalize` du module partagé pointent **en dur** sur `norva-source-sync` (qui possède déjà
finalize + watchdog). Résultat : **plus aucun paramètre `functionName`** à propager (le module est 100%
autonome), et le watchdog/finalize de A couvre uniformément les syncs lancés par B. Les continuations de
B's add-flow s'exécutent donc dans A — robustesse en bonus.

**Rewiring** : A et B importent les 3 entrées depuis `_shared/xtream-sync.ts` et **suppriment** leurs copies
du moteur (garder dans chaque index les utils utilisés par le code non-moteur — duplication d'utils stables
acceptable ; c'est le MOTEUR complexe qui devient single-source).

**Garde-fou OBLIGATOIRE avant déploiement** (cf. incident §4) : balayer le fichier pour **tout nom de
fonction/const top-level dupliqué** — esbuild ne le détecte PAS, Deno le rejette au boot.

```bash
grep -oE "^(async function|function|const|class) [A-Za-z0-9_]+" FILE \
  | sed -E 's/^(async function|function|const|class) //' | sort | uniq -d
```

---

## 4. Post-mortem incident 503 (30/06, ~20:01-20:45)

**Symptôme** : après le déploiement Couche 3 (commit `965c1c3`, edge v83), `norva-source-sync` a renvoyé
**503 sur TOUTES ses routes** (y compris OPTIONS) → finalize + continuation + watchdog HS → **les 4 imports
en cours se sont figés** (Promax bloqué `connecting`, Opplex/KING365 `materializing`, Ninja `building_titles`).

**Cause racine** : l'édition Couche 3 a ajouté une **2ᵉ fonction top-level `countSourceItems`**, en collision
avec la `countSourceItems(…, progress)` existante (côté finalize). **Un nom de fonction top-level dupliqué
est une SyntaxError dans un module ES Deno** → le module ne boote pas → 503 partout. **esbuild (transpile
permissif) ne l'a PAS signalé** ; seul le parseur strict de Deno le rejette — d'où le passage entre les
mailles (revue + esbuild OK, mais boot KO).

**Correctif** (commit `6826ff8`) : renommé le helper Couche 3 en **`countSourceItemsTotal`** (+ ses 2 appels),
balayé le fichier (aucun autre doublon), redéployé. `norva-source-sync` est revenu en **HTTP 200**, le
watchdog a relancé les chaînes, les 4 syncs ont repris (l'admission control a réadmis Promax dès qu'un slot
s'est libéré). Aucune perte de données (les premiers syncs n'ont rien à supprimer en amont).

**Leçons / prévention** :
1. **esbuild ≠ Deno** pour la validation d'un module edge → toujours faire le **sweep anti-doublon top-level**
   ci-dessus avant de déployer (ajouté au process).
2. Un déploiement de `norva-source-sync` **redémarre les isolates de sync en cours** → préférer déployer le
   moteur **hors fenêtre de gros imports**, ou accepter le hiccup (le watchdog récupère).
3. La dédup (§3) **élimine la classe de bug** « éditer une copie, oublier l'autre » qui a causé le dormancy.

---

## 5. État exact des fichiers (au 30/06)

- ✅ **Live (main `6826ff8`)** : Couche 3 dans `norva-source-sync` + hotfix `countSourceItemsTotal`.
  Migration `20260630160000_layer3_catalog_versioning.sql` appliquée.
- ⏸️ **Annulé / à refaire** : `_shared/xtream-sync.ts` (le subagent l'avait commencé, j'ai `git checkout`
  la copie partielle pour traiter l'incident sur base propre). **À reconstruire** selon §3.
- 🔴 **Dormant** : la Couche 3 ne s'active QUE quand le curseur a `runVersion`, ce qui n'arrive pas tant que
  `norva-cloud` (add-flow) tourne l'ancien `freshSyncCursor`. **La dédup est ce qui l'activera partout.**

## 6. Reprise (ordre)
1. Attendre que les 4 syncs en cours passent `ready` (éviter le hiccup de redéploiement).
2. Reconstruire `_shared/xtream-sync.ts` (§3) **avec le sweep anti-doublon** + esbuild + revue adversariale.
3. Déployer **étagé** : A d'abord (comportement inchangé → valide le module), puis B (l'add-flow gagne la
   Couche 3). Vérifier qu'un nouveau provider stamp bien `catalog_version` (Couche 3 active).
4. Brancher ensuite les hooks de notification (cf. `IMPORT-NOTIFICATIONS.md`) **une seule fois** dans le module.
