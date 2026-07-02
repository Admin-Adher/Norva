# Audit & optimisation des crons — 2026-07-02

**Statut : TERMINÉ, tout en production.** Trace complète de l'audit des 35 jobs pg_cron, de la
méthode, des findings (confirmés/réfutés), des 4 lots livrés + la vague de suivi, et de l'alignement
du dashboard admin. PRs : #55 (Lot 1), #56 (Lot 2), #57 (Lot 3), #58 (Lot 4), #59 (suivi), #60
(alignement dashboard).

---

## 1. Méthode

Workflow multi-agents (31 agents, 419 appels outillés) : 5 agents d'analyse (un par famille de crons
— point chaud dashboard, crons bavards, flotte d'enrichissement, sync/maintenance, hygiène pg_cron)
avec accès lecture seule à la DB live (EXPLAIN ANALYZE) et au repo ; puis **vérification
adversariale** de chaque proposition (un vérificateur par finding, chargé de la RÉFUTER contre le
code réel + la DB). Résultat : **26 findings → 25 confirmés (dont plusieurs corrigés par le
vérificateur), 1 réfuté**. Contrainte non négociable transmise à tous les agents : 1 connexion
provider par host par compte (`user_multi_ip`) — aucune optimisation ne devait toucher la charge
provider.

## 2. Lot 1 — SQL pur (PR #55)

| Fix | Avant → Après (mesuré) |
|---|---|
| **`refresh_admin_dashboard` réécrite** : le blob `sources` (89 % du coût) recalculait 4 sous-requêtes corrélées PAR source (jusqu'à 16 hash joins 558k×707k/run, ~218 Mo de spill disque). → CTE une-passe (`tc`/`vc`/`mc`/`tt`) + LEFT JOIN + **COALESCE obligatoire** (source VOD à 0 variant ⇒ `incomplete=true`, pas NULL) + `set local work_mem='64MB'` | 31-37 s (max 65,7) → **7,9 s à chaud**, blob `sources` **byte-identique** (validé par égalité jsonb avant/après) |
| **Cadence** `*/5` → **`2-57/10`** (décalée hors des minutes :00/:30 où 8-10 jobs partent ensemble — cause de l'incident « job startup timeout » du 28/06) | Temps DB : ~2 h 58/j → **~19 min/j (~9×)** |
| **Gardes SQL** (pattern origlang `WHERE EXISTS`) sur `resume-stuck-sync` (1 440 POST/j), `import-notify-digest` (720/j), `auto-refresh-detect` — 100 % no-ops mesurés en régime calme. Variantes anti-drift choisies (miroir exact du filtre du handler) | **~2 160 invocations edge/j supprimées** ; ~0,1 ms de SQL local par tick idle |
| **Rétention historique cron** : `norva-cron-history-prune` (hebdo, > 7 j) — aucune rétention n'existait. L'index `(jobid,start_time)` prévu est **impossible** (table appartenant à `supabase_admin`) ; la taille bornée le rend inutile | Table bornée ~30k lignes à vie |
| **Index enrichissement** (créés `CONCURRENTLY`) : `idx_cloud_titles_whisper_pending` (partiel sur le prédicat exact `@>`) et `idx_cloud_titles_audio_sweep` | Candidats whisper : 140k lignes scannées pour 4 → **3,9 s → ~1 ms** ; sweeps account-wide : ~200k buffers/tick → centaines |
| Reaper `*/30` → horaire (filet de sécurité, table de 8 lignes) | −24 runs/j |

## 3. Lot 2 — le bug TMDB (PR #56) 🐛

**Bug fonctionnel découvert par l'audit** : `backfill-years` / `revalidate` / `search-match` étaient
des **no-ops permanents** — le curseur keyset se verrouillait au max id après la 1ʳᵉ passe, jamais
réinitialisé. 100 % du backlog (22 691 titres sans année, 94 633 unverified/weak, 462 655 unmatched)
invisible pour toujours ; ~99,9994 % des nouveaux titres (UUIDv4) naissent sous le curseur.

Fix (corrections obligatoires du vérificateur intégrées) :
- **Curseur cyclique** : `last_id → null` en fin de passe (les 2 branches).
- **`done` LATCHÉ** : ne repasse jamais à false — `norva-catalog` lit `searchDone && revalDone` pour
  le flag `settled` de la barre d'onboarding ; un wrap ne doit pas la dé-settler (~771 j).
- **Marqueurs de convergence** : colonnes `year_backfill/revalidate/search_match_attempted_at` sur
  `cloud_titles` (pattern `whisper_attempted_at`, PAS metadata jsonb) + retry 90 j + index partiels
  par backlog. Chaque passe converge sur le neuf/retryable.
- **Limits montées** (TMDB ≠ host IPTV) : backfill-years 200→1000, search-match 50→300, revalidate 80→500.

**Preuve live** : run 1 → `wrapped:true` ; run 2 → `scanned:1000, found:977, updated:1118` (98 % de
hit TMDB). Backlog années : 22 691 → 21 573 en un run → **drainé en ~20 runs quotidiens**.

## 4. Lot 3 — memo `loadSourceConfig` (PR #57)

Les sweeps résolvaient la config source **par titre** : 1 SELECT + 1 déchiffrement AES-GCM ×
~45k/jour. Memo module-level TTL 60 s (`userId:sourceId`, pattern `runtimeConfigCache`) → **1 lookup
par tick au lieu de 25**. Call sites vérifiés read-only ; erreurs non cachées ; map bornée 500.

## 5. Lot 4 — décisions (PR #58)

- **`norva-series-info-prewarm` UNSCHEDULED** : pausé ET cassé (sourceId codé en dur inexistant,
  planning dévié du off-peak documenté). Ré-activation = re-pointage + off-peak + coordination avec
  les crons nuit par host (`user_multi_ip`). Le read-through alimente le cache entre-temps.
- **`series-info-cache-prune`** : rétention 30 j → 90 j.
- **Split jeremy DIFFÉRÉ** (conditions consignées dans la migration `20260702120000`) : apdxes.xyz est
  **live-only** (0 VOD → gain nul). Si import VOD un jour : vérifier identité ≠ km4ever (résolveur
  exige ≥32 items), **REMPLACER** les crons account-wide (pas dupliquer — sinon 2 connexions même
  compte même host), limits réduits (historique `endpoint_abuse` d'AtlasPro).

## 6. Vague de suivi (PR #59)

- **Court-circuit dimensions épuisées** (finding #11, **proposition initiale réfutée**) : le sentinel
  `'{und}'` ne réparait rien (le scan variant-driven visite TOUTES les variants du panel, résolues
  comprises) et cassait `fill_user_audio_from_catalog` + le badge audio UI. Fix corrigé : table
  **`enrichment_exhausted`** — une (source, dimension) qui retourne 0 candidat est sautée pendant
  **30 min** (TTL aligné sur l'auto-refresh → nouveau contenu repris en ≤ 1 cycle) ; un tick productif
  efface la marque. Câblé dans `runAudioBackfill` (single-dim + chaîne fallthrough, 6 clés en 1
  lecture) ; les modes ciblés (titleIds/catalog/transcribe) jamais court-circuités ; fail-open.
  **Prouvé live** : tick 2 → `{"type":"movie","kind":"probe","skipped":"exhausted"}` puis séries
  traitées. Un tick à sec = ~2 requêtes PK au lieu de 6 scans de panel (46k-500k buffers).
- **Autovacuum** `cloud_media_items`/`cloud_title_variants` : `scale_factor 0.02` **+
  `insert_scale_factor 0.05`** (correction du vérificateur — le churn de sync est du delete+insert
  massif que les réglages par défaut comptent à peine ; ~130k heap fetches/refresh). Gain attendu
  2-5 s/refresh, progressif.
- **Finding réfuté** (garde deadline dans la boucle probe) : structurellement vrai, occurrence
  réfutée avec les limites actuelles (25×~2 s ≪ timeouts). Aucune action.

## 7. Alignement du dashboard admin (PR #60)

Audit des datas visibles après tous ces changements :
- **Déjà juste** : `Crons en pause = 0` (réel), nouveaux jobs présents, `2-57/10` rendu « toutes les
  10 min », ETAs/couverture pilotés par les vraies données (sémantique intacte), « auto 10 min ».
- **Corrigé** : kinds des crons — `reaper` était classé « sous-titres » et `series-info-cache-prune`
  « séries » (ordre des règles regex) → **maintenance** ; nouveau kind **« sync »** pour
  `auto-refresh-detect`/`resume-stuck-sync` (étaient « autre »).
- **Ajouté** : bloc **« 🎯 Matching TMDB »** sur la page Moteur — 3 compteurs (`Années manquantes`,
  `Non matchés TMDB`, `À revalider`) lus depuis l'overview (counts bon marché via les index partiels
  du Lot 2). **Ils doivent baisser de jour en jour** : c'est le signal de santé des crons ressuscités.

## 8. Bilan chiffré

| Métrique | Avant | Après |
|---|---|---|
| Refresh dashboard | ~31-37 s × 288/j (~2 h 58) | **~8 s × 144/j (~19 min)**, −2-5 s à venir (autovacuum) |
| Invocations edge à vide | ~2 160/j | **~0** |
| Crons TMDB | no-ops permanents | 1 118 années réparées au 1ᵉʳ run ; 3 backlogs visibles au dashboard |
| Tick à vide (panel épuisé) | jusqu'à 6 scans, 46k-500k buffers | **~2 requêtes PK** |
| Lookups config/tick | 25 | **1** |
| Historique cron / events | illimité | 7 j / 180 j |

## 9. Ce qui n'a PAS été fait (choix documentés)

- Index `(jobid,start_time)` sur `cron.job_run_details` : **impossible** (owner `supabase_admin`) —
  compensé par la rétention 7 j.
- Sentinel `'{und}'` : **réfuté** (voir §6) — ne pas re-proposer sans relire la réfutation.
- Split jeremy : **conditionnel** (voir §5).
- Réutiliser `tc` pour les KPIs titres de l'overview : écarté — reposait sur l'invariant
  « variant_count>0 ⇒ default_variant_id valide » ; un scan dédié `tt` garde la sémantique exacte
  pour ~320 ms.

## 10. Addendum 2026-07-02 — fix du sondage séries (Ninja/Ferran)

Révélé par le badge « ⏸ à l'arrêt » du dashboard post-alignement : **Ninja 5/37 999 et Ferran
7/10 676 séries sondées depuis toujours**, alors que leurs crons nuit tournaient chaque nuit
(Promax, créé identiquement, tourne à ~616/24 h). Cause : `resolveSeriesEpisodeUrl` appelait
`get_series_info` **en direct depuis l'edge** (IP datacenter) — ces deux panels la rejettent →
`noTarget` sur chaque candidat → `audio_probed_at` jamais posé → les mêmes 15 titres re-tentés
chaque tick sans progression possible.

Fix (norva-playback) — cascade de résolution d'épisode :
1. **`cloud_series_info_cache`** (PK `server_host`+`series_id`) — zéro hit provider ;
2. **gateway `/xtream/series-info`** (IP résidentielle que le panel accepte déjà — le chemin du
   prewarm fiches ; UA VLC, timeout 12 s) ;
3. **appel direct historique** en fallback (gateway down / non configuré).

Discipline mono-connexion inchangée (appels strictement séquentiels, concurrency 1). Débloque
~48 700 séries structurellement insondables. À noter : « à l'arrêt » sur KING365/Opplex séries
reste NORMAL (design films-d'abord sur slot unique ; reprise auto par fallthrough).

**Second fix révélé par le test live (PR #62)** : sur Airysat, les 13 candidats `noTarget`
résiduels étaient la cascade qui fonctionnait — la fiche du panel (gateway, mise en cache par le
prewarm de test : payload `info`+`seasons`, zéro clé `episodes`) contient **aucun épisode**. Des
coquilles vides côté provider. Or `noTarget` ne posait jamais `audio_probed_at` → re-résolution
éternelle à chaque tick, et sur le chemin per-source (RPC sans curseur) elles occupent la tête de
file en permanence — risque de blocage total de la progression si les N premiers candidats d'un
panel sont vides. Fix :
- `resolveSeriesEpisode` retourne `{url, emptySeries}` ; `emptySeries=true` UNIQUEMENT sur un 200
  gateway portant un objet `info` sans épisode (autoritaire — les erreurs d'auth Xtream portent
  `user_info`). Jamais inféré du chemin direct (Ninja/Ferran y renvoient du junk) ni du cache
  (peut être périmé) : un échec transitoire reste un retry.
- Coquille vide → `markProbed` audio **+ sous-titres** (miroir du précédent `relayEmpty`),
  fenêtre 180 j pour re-vérifier ; compteur `diag.emptySeries` ; appel direct sauté quand le
  gateway a répondu (1 hit provider économisé).
- `episodeUrlFrom` durci : accepte `episodes` en objet clé-saison, tableau de saisons ou tableau
  plat (les formes tableau étaient lues « vide » → auraient été mal marquées 180 j).

**Preuve live (Airysat)** : tick avant fix `noTarget:13` ; après déploiement
`{"emptySeries":13, "noTarget":0}` puis `audio_backfill_candidates → 0` — file séries **drainée à
100 %** (333 sondées + 13 coquilles marquées). Preuve définitive Ninja/Ferran : demain matin,
`Sondé 24h > 0` sur leurs lignes séries après les crons nuit (0-5 UTC).
