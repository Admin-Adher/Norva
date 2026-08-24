# ADR Phase 0 — Isolation du catalogue de staging

Date : 2026-08-22  
Statut : **décision proposée, mise en œuvre NO-GO**  
Portée : Supabase/PostgreSQL, Edge Functions et lecteurs catalogue Norva  
Nature : audit et architecture uniquement ; ce document n'autorise ni migration ni changement de comportement en production.

Toutes les références `fichier:ligne` sont relatives à la racine absolue `C:\Users\AdrienHernandez\Documents\Norva repo`.

## Décision

Norva retient **l'Option A uniquement après la création d'une abstraction centrale fail-closed de visibilité**.

La source candidate B sera une vraie `cloud_source`, avec un cycle de vie `staging` et une visibilité `hidden`. Ses données pourront être importées dans les tables naturellement source-scopées, mais aucun lecteur utilisateur, projection partagée, cache, agrégat, crawler ou fleet ne devra les consommer avant promotion.

La promotion ne sera autorisée que lorsque :

1. tous les chemins de lecture sont routés par des vues/RPC de visibilité centrales ;
2. les accès directs aux tables de base sont retirés aux rôles utilisateurs ;
3. les chemins `service_role` qui produisent une réponse ou une projection utilisateur appliquent la même abstraction ;
4. les projections non source-scopées, en particulier `cloud_titles`, sont calculées exclusivement à partir de variants visibles ;
5. une campagne de tests prouve qu'une source `staging/hidden` ne modifie aucun écran, rail, recherche, facette, historique disponible, playback, cache ou traitement dérivé.

**État actuel : NO-GO.** Ajouter seulement une colonne `lifecycle_state` à `cloud_sources` ne suffit pas : plusieurs lecteurs ne joignent pas `cloud_sources`, la RLS ne teste que la propriété utilisateur, le rôle de service contourne la RLS, et les rollups partagés intègrent tous les variants.

Si l'inventaire ne peut pas être fermé et prouvé, la décision bascule vers **l'Option B**, sous forme de tables/partitions ou générations de staging physiquement séparées avec promotion par pointeur. Une copie massive de centaines de milliers de lignes dans la transaction de promotion est exclue.

## Contexte et exigence de sûreté

Le renouvellement d'accès fournisseur doit permettre d'importer et de valider B sans perturber A. Jusqu'au commit atomique :

- A reste l'unique source visible et jouable ;
- B reste invisible partout, y compris dans les projections et traitements asynchrones ;
- une erreur, une identité ambiguë ou une synchronisation partielle n'altère pas le catalogue courant ;
- l'accès fournisseur et la santé de synchronisation sont deux domaines distincts ;
- favoris, historique et progression ne sont ni supprimés ni remappés de manière irréversible ;
- le rollback reste possible pendant une fenêtre explicitement définie.

## État observé

### Cycle de vie de source insuffisant

`cloud_sources` contient `sync_status`, `catalog_version` et `last_synced_at`, mais aucun état de staging, visibilité, remplacement ou accès fournisseur : `supabase/migrations/20260613150937_cloud_core_playback.sql:49-64`.

Le soft-delete ajoute seulement `deleted_at` : `supabase/migrations/20260706190000_source_soft_delete.sql:12-17`. Le champ `enabled` est documenté comme un filtre client et laisse les données en place : `supabase/migrations/20260706210000_source_enabled.sql:1-10`.

Le reaper sélectionne toute source ayant `deleted_at`, supprime ses media, variants VOD, variants/live channels, overrides et favoris, puis la source : `supabase/migrations/20260707180000_reap_reliable_timeout_via_cron_command.sql:24-75`. Sa fréquence finale est de dix minutes : `supabase/migrations/20260708093000_reap_frequency_10min.sql:12-15`.

Conséquence : utiliser `deleted_at` au moment de la bascule rendrait le rollback destructif et temporellement fragile.

### RLS et grants ne portent pas la visibilité

Les politiques finales protègent l'appartenance à l'utilisateur, pas l'état actif de la source :

- `cloud_sources` : `supabase/migrations/20260628095500_rls_initplan_fix.sql:49` ;
- `cloud_media_items` : `supabase/migrations/20260628095500_rls_initplan_fix.sql:30-32` ;
- `cloud_titles` et `cloud_title_variants` : `supabase/migrations/20260628095500_rls_initplan_fix.sql:51-52` ;
- live channels et variants : `supabase/migrations/20260628095500_rls_initplan_fix.sql:28-29` ;
- favoris et historique : `supabase/migrations/20260628095500_rls_initplan_fix.sql:23-25,53-55`.

Les rôles authentifiés disposent encore d'un CRUD direct sur sources, media, favoris et historique : `supabase/migrations/20260613150937_cloud_core_playback.sql:402-422`. Ils disposent d'un `SELECT` direct sur les titres/variants : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:146-170`, et sur le catalogue live : `supabase/migrations/20260614120231_cloud_live_materialized_catalog.sql:82-108`.

La RLS ne protège pas les traitements `service_role`. Toute Edge Function, fonction SQL `SECURITY DEFINER`, cron ou fleet qui lit les tables de base doit donc adopter explicitement le contrat de visibilité.

### Fuite structurelle par `cloud_titles`

`cloud_titles` est une projection logique par utilisateur et identité, sans `source_id`, alors que `cloud_title_variants` est source-scopé : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:7-58`.

Le rollup choisit le meilleur variant et compte tous les variants du titre, sans joindre `cloud_sources` : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:86-124`. Le trigger le réexécute à chaque modification de variant : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:126-144,183-186`.

Une importation B dans `cloud_title_variants` peut donc modifier avant promotion :

- `cloud_titles.default_variant_id` ;
- `cloud_titles.variant_count` ;
- `cloud_titles.last_observed_ttff_ms` ;
- les rails et facettes qui dépendent de ces colonnes.

C'est un NO-GO indépendant de la qualité des filtres côté client.

## Inventaire des chemins de lecture et dérivation

| Surface | Lecture observée | Prédicat de source active démontré | Conclusion |
|---|---|---:|---|
| Liste média | `supabase/migrations/20260704271000_list_media_items_deduped_primary.sql:53-63,85-97,111-121` | Non | Lit directement `cloud_media_items` |
| Recherche média | `supabase/migrations/20260711140000_search_media_dedup.sql:30-90` | Non | Fonction `SECURITY DEFINER`, aucun join source |
| Home / récent / genres | `supabase/migrations/20260704260000_home_recent_rail_and_genre_guard.sql:22-48` | Non | Dépend de `cloud_titles` et de tous ses variants |
| Top viewed | `supabase/migrations/20260704221000_top_viewed_fast.sql:16-40` | Non | Historique → variant → titre, sans source active |
| Résumé de facettes | `supabase/migrations/20260705090000_catalog_facet_summary.sql:9-99` | Non | Cache persistant contaminable par B |
| Facettes langues | `supabase/migrations/20260706100000_cloud_language_facets_real_counts.sql:28-65,127-147` | Non | Lit `cloud_titles` |
| Facettes audio | `supabase/migrations/20260706110000_audio_facets_from_tracks.sql:31-59,126-137` | Non | Lit `cloud_titles` |
| Facettes langues par fournisseur | `supabase/migrations/20260724170000_provider_scoped_language_facets.sql:16-67` | Partiel | Filtre `enabled` et `deleted_at`, pas le futur lifecycle |
| Catalogue live | `supabase/migrations/20260614120231_cloud_live_materialized_catalog.sql:8-58,82-108` | Non | RLS propriétaire uniquement |
| Projection catalogue global | `supabase/migrations/20260623270000_catalog_titles_foundation.sql:42`; `supabase/migrations/20260624020000_catalog_mirror_diff.sql:23` | Non | Peut propager B vers les miroirs |
| Enrichissement dynamique | `supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql:255-927` | Non central | Plusieurs lectures directes de variants/titres |
| Crawl audio/fichier | `supabase/migrations/20260719170000_variant_file_audio_crawler.sql:202-869` | Non central | Peut lancer du travail sur B |
| Séries/épisodes | `supabase/migrations/20260720180000_series_episode_audio_foundation.sql:336-3171` | Non central | Projections et files partagées |
| Validation VOD asynchrone | `supabase/migrations/20260816105918_async_vod_language_validation_jobs.sql:393,989` | Non central | Candidats issus des variants de base |

Les Edge Functions ont également des accès directs : liste/recherche/rails/facettes/raw fallback dans `supabase/functions/norva-catalog/index.ts:680-724,1239-1455,1695-1777,2122-2220,3336-3364`, et live catalogue/variants dans `supabase/functions/norva-catalog/index.ts:3507-3703`.

Ce tableau ne constitue donc pas encore une preuve de fermeture ; il démontre au contraire que le prédicat est diffus et qu'une abstraction centrale est un prérequis.

## Contrat de visibilité retenu

Une ligne catalogue est visible si et seulement si toutes les conditions suivantes sont vraies :

1. elle appartient à l'utilisateur demandé ;
2. sa source existe et appartient au même utilisateur ;
3. la source est `lifecycle_state = active` ;
4. la source est `catalog_visibility = visible` ;
5. la source n'est pas supprimée et reste `enabled` ;
6. la ligne est disponible selon le contrat métier de sa table ;
7. aucune transition terminale ou incohérente ne la rend inéligible.

Le défaut est toujours caché. Un état inconnu, une source absente, une transition ambiguë ou une erreur de jointure ne doit jamais rendre une ligne visible.

Ce contrat doit être matérialisé dans des vues/RPC canoniques, par exemple :

- `cloud_visible_sources` ;
- `cloud_visible_media_items` ;
- `cloud_visible_title_variants` ;
- `cloud_visible_titles` ;
- `cloud_visible_live_logical_channels` ;
- `cloud_visible_live_variants`.

`cloud_visible_titles` ne peut pas être un simple filtre sur le `cloud_titles` actuel : son variant par défaut, son compteur et ses métadonnées dépendantes doivent être dérivés exclusivement de `cloud_visible_title_variants`.

Les projections partagées, caches et fleets doivent partir de ces ensembles visibles, ou appliquer un prédicat équivalent encapsulé et testé. Une exception ad hoc n'est pas acceptable.

## Promotion atomique

L'import, le fingerprint, la comparaison d'identité et les appels fournisseur se déroulent hors transaction. La transaction de promotion doit rester courte et ne faire que :

1. verrouiller la transition et les sources A/B dans un ordre déterministe ;
2. revalider utilisateur, états, readiness, identité et absence de transition concurrente ;
3. rendre B `active/visible` ;
4. rendre A `replaced/hidden` ;
5. enregistrer les liens de remplacement et la fenêtre de rollback ;
6. créer les événements/outbox et tâches de remap/invalidation dans la même transaction ;
7. commit.

La fonction de promotion devra être `SECURITY DEFINER`, avec `search_path` fixe, exécution révoquée à `PUBLIC`, paramètres non ambigus et contrôle explicite de l'appelant. Elle devra utiliser une clé d'idempotence et soit un advisory transaction lock par ancienne source, soit des row locks ordonnés A/B/transition.

La transaction ne doit effectuer ni I/O réseau, ni import, ni copie volumineuse, ni recomputation complète des titres/facettes.

## Conséquences de la décision

### Avantages

- promotion O(1) sur les lignes de contrôle ;
- les imports volumineux restent hors transaction ;
- les tables source-scopées et l'infrastructure de synchronisation existantes restent réutilisables ;
- la visibilité devient testable et auditable ;
- le même prédicat protège UI, RLS, RPC, service-role et traitements dérivés.

### Coûts

- refactor transversal obligatoire de tous les lecteurs ;
- recalcul ou redéfinition des projections `cloud_titles` et facettes ;
- révocation progressive des accès directs aux tables de base ;
- tests PostgreSQL réels et tests de non-contamination requis ;
- compatibilité transitoire à organiser pour les clients déployés.

## Conditions de GO pour l'Option A

L'Option A reste bloquée tant que l'un des points suivants manque :

- inventaire généré des dépendances SQL, RPC, vues, Edge Functions, crons, triggers et fleets ;
- zéro lecture utilisateur directe d'une table catalogue de base ;
- zéro projection partagée alimentée par une source `hidden` ;
- RLS et grants vérifiés sur une base réellement migrée, pas seulement par lecture des fichiers ;
- tests avec rôles `authenticated` et `service_role` ;
- test de concurrence de promotion et de plafond de sources ;
- test de rollback avant et après une synchronisation de rafraîchissement ;
- stratégie sûre pour favoris, historique, progression, alias locaux, EPG et caches ;
- reaper modifié conceptuellement pour respecter `purge_after` et un état terminal, sans utiliser immédiatement `deleted_at` ;
- flags de visibilité et promotion séparés, initialisés OFF.

## Déclencheur de fallback Option B

Adopter l'Option B si, après l'inventaire automatisé et le shadow testing, au moins un lecteur ou une projection critique ne peut pas être routé par le contrat central de visibilité.

Dans ce cas :

- écrire B dans un schéma/table/partition ou une génération physiquement isolée ;
- empêcher tout grant utilisateur sur cette zone ;
- faire consommer les fleets uniquement par la génération active ;
- promouvoir par changement atomique d'un identifiant de génération ;
- éviter toute copie bulk dans la transaction de promotion ;
- conserver A jusqu'à expiration explicite du rollback.

## Risques et angles morts

- Le schéma réellement déployé peut avoir dérivé des migrations auditées.
- Des lecteurs hors dépôt, du SQL dynamique ou des caches externes peuvent exister.
- Aucun schéma SQL EPG/XMLTV/programmes n'a été trouvé ; seule la valeur `source_type = epg` apparaît dans `supabase/migrations/20260613150937_cloud_core_playback.sql:49-54`.
- Les alias source sont locaux au navigateur, via `localStorage`, et ne participent pas à la transaction SQL : `public/js/api.js:247-275`.
- Les volumes, durées de lock et temps de rebuild des projections n'ont pas été mesurés sur production.
- Les tests existants couvrent les contrats d'outbox, pas l'isolation staging : `tests/import-notification-delivery.test.js:12-113,171-207` et `tests/branded-email-delivery.test.js:21-38,98-152`.

Ces angles morts maintiennent le statut **NO-GO** jusqu'à vérification live, sans autoriser de mutation de production pendant la Phase 0.
