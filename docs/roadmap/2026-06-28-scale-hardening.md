# Durcissement multi-users — 2026-06-28

> **But** : rendre Norva prête à de nombreux users **important leur provider en même
> temps**, sans rejouer la panne login. Déclencheur : disque Supabase à **1,55 / 2 Go**
> avec ~1-2 users → preuve que le modèle ne passe pas l'échelle tel quel. Audit complet
> + 4 lots de correctifs (B1-B4), tous déployés. À lire avec
> [`2026-06-28-session-log.md`](./2026-06-28-session-log.md) (la panne login du matin) et
> [`scaling-status.md`](./scaling-status.md) (la dédup Phase 2).

---

## 0. TL;DR

| # | Problème | Fix | Mesuré |
|---|---|---|---|
| **B1** | 30 Mo d'index **jamais scanné** sur la table catalogue par-user | drop `idx_cmi_sort_rating` | −30 Mo immédiat |
| **B2** | **Aucun cap global qui bloque** → 10 imports = saturation = login KO | admission control global (découverte **+** finalize), fail-closed | 10 imports → file d'attente propre (3 à la fois) |
| **B3** | Curseur de découverte mort (**~13 Ko**) ré-écrit à chaque battement de finalize + gardé à vie | drop au handoff découverte→finalize | super8k `config_hint` **7028 → 1228 o (−82 %)** |
| **B4** | Dédup (le vrai levier stockage) : prête ? sûre ? | gate qualité **pristine** + `catalog_flip_readiness()` ; **PAS de flip** (overlap 1,17 < 3) | NO-GO correct, auto-signal quand l'overlap montera |

**Constat de fond** : à faible overlap (users sur des providers **différents**), le
stockage est **intrinsèquement O(N users × catalogue)** — un gros provider ≈ **0,7 Go**,
donc ~10 gros users ≈ 7 Go (plafond inclus = 8 Go). La dédup résout ça **uniquement
quand de vrais users partagent un provider** (overlap ≫ 1). Le disque **auto-scale**
jusqu'à 8 Go d'ici là. La **concurrence** (B2/B3), elle, est réglée **maintenant**.

---

## 1. L'audit — les 2 murs + la cause aggravante

**Mesures (à l'instant, 2 sources : super8k 272k items + apdxes 40k) :**
- `cloud_media_items` **338 Mo** (168 data + **170 d'index**), `cloud_title_variants` 202 Mo,
  `cloud_live_logical_channels` 160 Mo, `cloud_titles` 77 Mo, `catalog_titles` 52 Mo.
- **WAL 672 Mo / 0 replication slot** → **pas une fuite** : c'est le plancher configuré
  (`min_wal_size=1GB`, `max_wal_size=4GB`) + le churn d'écriture. Sur 2 Go de disque, le
  plancher WAL mange la moitié. Il **grossit avec le volume d'écriture** (donc empire sous
  charge concurrente — d'où B3).

**Mur n°1 — Stockage O(N×catalogue).** Modèle **par-user** : `cloud_media_items` clé
`(source_id,…)`, `cloud_titles` clé `(user_id,…)`. 10 users × un provider 270k =
~2,7 M lignes. La dédup globale (`catalog_titles`/`catalog_media_items`) **existe** mais
le **read cutover est OFF** (gaté sur l'overlap) → aujourd'hui elle **ajoute** du stockage.

**Mur n°2 — Concurrence sans frein bloquant.** Le cap `NORVA_MAX_CONCURRENT_FINALIZE=3`
existant était **trompeur** : finalize-seulement, **diffère au lieu de bloquer**, et
**fail-open** (sous charge son COUNT time-out → laisse tout passer). La découverte était
**non capée**. Le single-flight est **par-source** → 10 sources = 10 workers. ⇒ 10 imports
simultanés = exactement le mode qui a causé la **panne login 504** du matin, cette fois
déclenché par du **trafic légitime**.

**Cause aggravante — amplification d'écriture `config_hint`.** Gros jsonb ré-écrit
(read-modify-write) à chaque battement (~2,5 s/source) sur la table que le login/`/boot`
lisent. Dont un `syncCursor` **mort de ~13 Ko** trimballé pendant tout le finalize.

---

## 2. Les correctifs

### B1 — Disque : drop de l'index mort
`idx_cmi_sort_rating` (30 Mo, **0 scan** sur toute la vie des stats — le tri grille « par
note » n'est jamais utilisé) droppé `CONCURRENTLY`. Les 3 autres tris (added/year/title)
sont **gardés** (utilisés ; ils déménageront sur `catalog_media_items` au flip dédup).
Migration idempotente `20260628120000_scale_drop_dead_sort_index.sql`.

### B2 — Admission control global (le fix central de « 10 imports à la fois »)
Nouveau `admitHeavyImport()` dans **les deux moteurs** (`norva-source-sync` ET
`norva-cloud`), gate **découverte + finalize** :
- **Budget global partagé** : `NORVA_MAX_CONCURRENT_IMPORTS` (défaut **3**), repli legacy
  `NORVA_MAX_CONCURRENT_FINALIZE`.
- **Priorité déterministe par `created_at`** : on n'admet que si **moins de N** sources
  xtream `syncing` **plus anciennes** tournent devant → les N plus vieux avancent toujours
  (pas d'interblocage), les plus récents **font la file**.
- **Fail CLOSED** : si le COUNT échoue (timeout sous charge) → on **diffère** (reculer est
  le bon réflexe sous saturation ; le watchdog réessaie). L'ancien fail-open faisait
  l'inverse.
- **Reprise de la file** : le watchdog (jobid 27) scanne désormais **du plus ancien au plus
  récent** → les ≤5 re-kicks remplissent les slots par l'avant de la file. Un import frais
  différé garde le curseur `discover` actif que `syncCloudSource` écrit déjà → sa branche
  watchdog existante le reprend dès qu'un slot se libère (heartbeat périmé après ~2 min).
- `norva-cloud` délègue le **finalize** à `norva-source-sync` (`cron/finalize`), donc gater
  la découverte de `norva-cloud` + tout le `source-sync` suffit à borner **tout** le travail
  lourd.

**Effet** : 10 imports simultanés → **3 traités, 7 en file**, repris à mesure. Plus de
saturation CPU/pool → le login ne retombe plus.

### B3 — Couper l'amplification d'écriture
À la fin de la découverte (`cursor.active=false`, signature promue en `contentSignature`),
le `syncCursor` (cats + maps `sig`, ~13 Ko) est **mort**. Il est maintenant **droppé** :
- au handoff découverte→finalize (`norva-source-sync`),
- défensivement à chaque battement de finalize (couvre les imports `norva-cloud` + les
  sources déjà en vol),
- nettoyage one-shot SQL des sources déjà `ready`.

**Mesuré** : super8k `config_hint` **7028 → 1228 octets (−82 %)**. Chaque battement de
finalize écrit ~6× moins, et les sources `ready` ne trimballent plus le curseur mort dans
la ligne que le login lit. Couplé à B2 (concurrence ÷3), l'amplification chute ~5-6×.

> _Choix d'ingénierie_ : on a **évité** le refactor « table de progression séparée »
> (gros risque sur le hot-path des 2 moteurs) car B2 (cap à 3) + le drop du curseur mort
> captent l'essentiel du gain pour une fraction du risque. `cloud_sources` reste minuscule
> (664 Ko) ; ce n'était pas un problème de stockage mais de churn sur la ligne du login.

### B4 — Dédup : prête + auto-gatée, **sans flip prématuré**
La dédup (read cutover `NORVA_CATALOG_READ_SOURCE` / `NORVA_CATALOG_MEDIA_READ_SOURCE`,
défaut **OFF**) est le vrai levier stockage **mais ne paie qu'à overlap ≫ 1**. État vérifié :

- **Gate qualité PRISTINE.** `catalog_titles_quality_gate()` mesure la seule chose qui
  compte : *le cache servirait-il PIRE que la ligne per-user ?* Résultat après un petit
  heal (55 années + 78 backdrops comblés) : **title/poster/enrich/identity = 0 worse**,
  **year/backdrop = 0**. La divergence brute de ~37 % (vue via l'**obsolète**
  `catalog_mirror_diff`) est **normale et voulue** : deux providers nomment le même
  `tmdb_id` différemment (« EN - The Crash » vs « L'Accident »). C'est la **qualité**, pas
  l'égalité octet, qui gate.
- **Overlap = 1,17** (< 3) → la dédup n'apporterait **~0 bénéfice** (les 2 sources sont des
  providers **différents**). Insight clé : la divergence est **haute justement parce que**
  les users ne partagent pas de provider ; avec de vrais users **même provider**, les
  titres sont identiques → overlap **monte** ET divergence **tombe** → le flip devient à la
  fois **utile et sûr**.
- **Nouveau garde-fou** : `catalog_flip_readiness()` (migration
  `20260628130000_catalog_flip_readiness.sql`) — **une requête, un verdict** combinant les
  deux gates. Aujourd'hui :
  > `NO-GO: overlap 1.17 < 3.0 — too few shared titles for dedup to pay; flip provides ~0 benefit. Mechanism is ready; wait for real same-provider users.`

  Il passera **GO** automatiquement quand l'overlap franchira 3 avec un cache propre.

**Pourquoi pas de flip maintenant** : à overlap 1,17, flipper changerait ~40 % des titres
affichés pour la variante d'un autre provider (régression visible) **pour 0 gain stockage**.
Le design dit explicitement que c'est net-négatif sous le seuil. On a donc tout rendu
**prêt et auto-signalé**, pas flippé.

---

## 3. Les manettes (env, sans redéploiement)

| Env | Défaut | Rôle |
|---|---|---|
| `NORVA_MAX_CONCURRENT_IMPORTS` | `3` | imports lourds simultanés (découverte+finalize). `0` = désactive le cap. |
| `NORVA_MAX_CONCURRENT_FINALIZE` | — | repli legacy si le précédent n'est pas posé. |
| `NORVA_FINALIZE_THROTTLE_MS` | `2500` | pause entre lots de finalize (par-source). |
| `NORVA_FINALIZE_LEASE_TTL_MS` | `240000` | TTL du bail single-flight. |
| `NORVA_CATALOG_READ_SOURCE` | `cloud_titles` | **OFF**. `catalog_titles` = sert les métadonnées depuis le cache global (le flip). |
| `NORVA_CATALOG_MEDIA_READ_SOURCE` | OFF | **OFF**. read cutover du catalogue brut (Phase 2). |

Sur SMALL (2 cœurs), **3** imports lourds simultanés est un plafond raisonnable. Monter ce
chiffre = plus de débit d'import mais moins de marge pour le trafic foreground.

---

## 4. Comment tester « 10 imports simultanés »

1. **Vérifier le cap** : lancer/simuler ≥4 imports xtream. Attendu : au plus
   `NORVA_MAX_CONCURRENT_IMPORTS` (3) en `syncing` actif à la fois ; les autres restent
   `syncing` mais **sans worker** (curseur `discover` actif, pas de progrès), repris par le
   watchdog dans l'ordre `created_at`.
   ```sql
   -- combien tournent vraiment vs en file ?
   select count(*) filter (where sync_status='syncing') syncing,
          count(*) filter (where (config_hint->'finalizeLease'->>'until')::timestamptz > now()) active_finalize
   from cloud_sources where source_type='xtream';
   ```
2. **Le login reste OK** pendant la rafale (`get_logs service=auth` → 200, pas de 504).
3. **Le pool ne sature pas** :
   ```sql
   select count(*) total, count(*) filter (where state='active') active from pg_stat_activity;
   ```

---

## 5. Le jour du flip dédup (procédure gardée)

1. `select * from catalog_flip_readiness();` → attendre **`flip_ready = true`** (overlap ≥ 3
   ET `strict_worse = 0`). C'est l'auto-signal.
2. Poser `NORVA_CATALOG_READ_SOURCE=catalog_titles` sur `norva-catalog`. Surveiller la
   grille / les fiches (les titres se servent du cache global).
3. Une fois stable, **amincir** `cloud_titles` / `cloud_media_items`
   (`thin_source_media_items()`, déjà construite + validée, 100 % réversible) → stockage
   **O(providers)** au lieu de O(N×users). Gain projeté ~**68 % à 100+ users** (cf.
   `phase2-dedup-execution.md`).

---

## 6. Réversibilité

- **B1** : recréer l'index (DDL en commentaire dans la migration).
- **B2** : `NORVA_MAX_CONCURRENT_IMPORTS=0` désactive le cap (retour au comportement
  d'avant). Le code defer→file est additif.
- **B3** : additif (drop d'un champ mort). Un re-sync réécrit un `syncCursor` neuf.
- **B4** : `catalog_flip_readiness()` est read-only ; rien n'est flippé.

---

## 7. Limites honnêtes / ce qui reste

- À **overlap bas** (providers différents par user), **aucun gain dédup** possible — c'est
  mathématique. La réponse court terme = **disque auto-scale** (gp3 jusqu'à 8 Go), puis
  forfait supérieur au-delà.
- Le WAL gros est un **symptôme d'écriture**, pas une fuite ; il retombe quand l'import
  finit. B2/B3 réduisent le churn ; le reste vient des écritures de données (titres/variants),
  inhérentes à un gros import.
- **P2 « dédup à l'import »** (ne pas re-stocker un fichier provider déjà importé par un
  autre user, file par `serverHost`) reste le levier structurel le plus profond — non fait
  (refonte). Pertinent seulement quand le partage de providers sera réel ; tracé dans
  `dedup-plan.md`.
