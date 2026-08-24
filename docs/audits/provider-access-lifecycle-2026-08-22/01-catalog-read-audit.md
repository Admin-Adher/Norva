# Audit Phase 0 — lectures catalogue et isolation Provider Access

Date : 2026-08-22  
Statut : audit statique, lecture seule  
Décision : **NO-GO pour le remplacement sécurisé A → B sur l’architecture actuelle**

## 1. Périmètre et niveau de preuve

Racine auditée :

    C:\Users\AdrienHernandez\Documents\Norva repo

Tous les chemins fichier:ligne de ce document sont relatifs à cette racine et se résolvent donc en chemins absolus sous celle-ci.

L’audit couvre :

- la SPA web et WebView : adaptateurs API, Home, Live, Movies, Series, recherche, recommandations, favoris, historique et lecteur ;
- les routes user et device des Edge Functions ;
- le catalogue matérialisé, les RPC SQL et les lectures directes de tables ;
- Android phone : WebView, lecteur natif et téléchargements ;
- Android TV : WebView cloud, lecteur natif, Watch Next et serveur standalone ;
- EPG, choix de source, aliases, filtres et caches persistants ;
- Settings, onboarding et vues d’administration ;
- synchronisation, finalisation, enrichissement et cleanup en arrière-plan ;
- les contrats de tests existants et les trous de couverture.

Niveau de preuve :

- **confirmé statiquement** pour les chemins de code et les requêtes cités ;
- **non vérifié en runtime** pour le rendu, TalkBack, D-pad, les caches réellement présents sur un appareil et le schéma Supabase effectivement déployé ;
- aucune capture d’écran ni manipulation d’un compte réel n’a été réalisée pendant cette phase ;
- aucun fichier produit, client Android ou migration n’a été modifié.

## 2. Verdict exécutif

L’option « ajouter un état staging/hidden à cloud_sources puis filtrer partout » n’est pas démontrable avec le code actuel.

Trois constats rendent le remplacement non sûr :

1. De nombreuses lectures utilisateur interrogent directement cloud_media_items, cloud_titles, cloud_title_variants ou les tables Live sans joindre cloud_sources.
2. La vérification commune assertOwnedSource ne prouve que la propriété, jamais la visibilité catalogue.
3. Les caches et références locales peuvent repeindre ou relancer une ancienne source après un masquage ou une promotion.

Le défaut est déjà visible sur la désactivation actuelle : le backend indique que le client doit filtrer les sources disabled (supabase/functions/norva-cloud/index.ts:1434-1445), mais l’adaptateur remplace le vrai champ enabled par source.revoked !== true (public/js/api.js:300-328). Une source cloud avec enabled=false est donc généralement normalisée comme active.

En conséquence :

- **État actuel : NO-GO.** Ajouter seulement un état `staging/hidden` à `cloud_sources` ne ferme aucun des contournements inventoriés.
- **Option A retenue conditionnellement par l’ADR** : elle ne devient admissible qu’après création d’une abstraction DB centrale fail-closed de visibilité, retrait des lectures/grants directs, migration des lecteurs `service_role`, correction des projections partagées et preuve exhaustive de non-fuite.
- **Option B est uniquement le fallback** si l’inventaire ne peut pas être fermé ou si au moins une lecture/projection critique ne peut pas être routée par ce contrat central ; elle utilise alors une isolation physique ou générationnelle et une promotion par pointeur.
- Dans les deux options, le masquage d’une source active après expiration confirmée exige le même contrat central de visibilité côté lectures utilisateur et dérivations.

## 3. Topologie des contrats client

La SPA expose deux familles de lecture :

- norva-cloud pour les sources, favoris, historique, EPG et état de compte ;
- norva-catalog pour les grilles, rails, facettes, recherche et Live matérialisé.

Preuves :

- sources, EPG, favoris, historique et playback : public/js/cloudApi.js:4303-4437 ;
- mêmes surfaces avec device token : public/js/cloudApi.js:4453-4536 ;
- media-items, Live, Home, genre et langue routés vers norva-catalog : public/js/cloudApi.js:4323-4352, public/js/cloudApi.js:4475-4489 ;
- dispatcher norva-catalog user/device sans résolution initiale d’un ensemble de sources visibles : supabase/functions/norva-catalog/index.ts:52-162 ;
- routes user/device de norva-cloud : supabase/functions/norva-cloud/index.ts:378-524, supabase/functions/norva-cloud/index.ts:682-801.

Cette séparation multiplie les points à verrouiller : filtrer uniquement GET /sources ne protège ni norva-catalog, ni un appel direct EPG/playback avec un sourceId connu.

## 4. Matrice exhaustive des surfaces

Légende :

- **Absent** : aucune jointure ou vérification lifecycle/visibility.
- **Partiel** : une source est consultée, mais seulement pour propriété, sync ou enabled.
- **Gestion** : la source doit rester visible dans Settings, tandis que son contenu doit rester invisible.

| Surface | Entrée client et lecture serveur | Contrôle actuel | Risque Phase 0 | Verdict |
|---|---|---|---|---|
| Home — rails éditoriaux | public/js/pages/HomePage.js:505-584 ; public/js/cloudApi.js:4346-4352 ; supabase/functions/norva-catalog/index.ts:1091-1162 | Absent | Rails issus de titres/variantes non filtrés ; le cache Home peut être repeint. | Bloquant |
| Home — gate de première source | public/js/pages/HomePage.js:693-708, public/js/pages/HomePage.js:828-899 | Santé/sync seulement | Le gate ne constitue pas une barrière de visibilité ; les requêtes Home partent avant sa décision. | Bloquant |
| Movies — grille/pagination | public/js/pages/MoviesPage.js:1219-1312 ; supabase/functions/norva-catalog/index.ts:658-755 | Absent | RPC direct cloud_media_items. | Bloquant |
| Series — grille/pagination | public/js/pages/SeriesPage.js:1260-1320 ; supabase/functions/norva-catalog/index.ts:658-755 | Absent | Même contrat que Movies ; choix de variante persistant par source. | Bloquant |
| Recherche globale | public/js/app.js:2681-2684, public/js/app.js:2817-2896 ; supabase/functions/norva-catalog/index.ts:688-724 | Absent | Un résultat hidden/staging peut apparaître et être ouvert. | Bloquant |
| RPC de recherche | supabase/migrations/20260711140000_search_media_dedup.sql:30-82 | Absent | Lecture directe cloud_media_items par user/type/query. | Bloquant |
| RPC de grille dédupliquée | supabase/migrations/20260704271000_list_media_items_deduped_primary.sql:16-158 | Absent | Aucun join cloud_sources ni prédicat visible. | Bloquant |
| Catégories | supabase/functions/norva-catalog/index.ts:1000-1039 | Absent | cloud_media_items est interrogée directement. | Bloquant |
| Genre summary | supabase/functions/norva-catalog/index.ts:1220-1330 ; supabase/migrations/20260705080000_genre_bucket_guard_raise.sql:13-40 | Absent | Facettes et comptes peuvent révéler B avant les cartes. | Bloquant |
| Genre rails | supabase/functions/norva-catalog/index.ts:1342-1471 | Absent | cloud_titles et variantes directes. | Bloquant |
| Genre items | supabase/functions/norva-catalog/index.ts:1627-1777 | Absent | Le sourceId optionnel restreint une variante, mais ne valide pas son lifecycle. | Bloquant |
| Facettes langue | supabase/functions/norva-catalog/index.ts:1842-2044 | Absent | Comptes et filtres exposent le dataset staging/hidden. | Bloquant |
| Recommandations / title rails | supabase/functions/norva-catalog/index.ts:2122-2514 | Absent | Titres, variantes et historique lus sans source visible centrale. | Bloquant |
| Continue Watching | public/js/pages/HomePage.js:2142-2145 ; supabase/functions/norva-cloud/index.ts:3376-3420 | Partiel | La liste de sources ne filtre ni lifecycle, ni enabled, ni explicitement deleted_at. | Bloquant |
| Historique ciblé / resume | supabase/functions/norva-cloud/index.ts:3337-3373 ; public/js/pages/WatchPage.js:1104-1110 | Absent | Un tuple source/item hidden peut rester résolvable. | Bloquant |
| Favoris — lecture | supabase/functions/norva-cloud/index.ts:2743-2759 | Absent | Les métadonnées d’un favori peuvent produire une carte staging/hidden. | Bloquant |
| Favoris — écriture | supabase/functions/norva-cloud/index.ts:2762-2801 | Propriété seulement | Une source non visible reste favorisable. | Bloquant |
| Live — logical channels | supabase/functions/norva-catalog/index.ts:3367-3494 | Absent | Matérialisation Live sans prédicat lifecycle. | Bloquant |
| Live — variantes | supabase/functions/norva-catalog/index.ts:3501-3703 | Absent | Tables cloud_live_* directes ; le batch de variantes dépend des channel IDs reçus. | Bloquant |
| Live — fallback brut | supabase/functions/norva-catalog/index.ts:3808-3829 | Absent | Retour direct à cloud_media_items available=true. | Bloquant |
| Source picker Movies | public/js/pages/MoviesPage.js:1054-1070 | Frontend, défectueux | Filtre s.enabled après normalisation erronée. | Bloquant |
| Source picker Live | public/js/components/ChannelList.js:2031-2063, public/js/components/ChannelList.js:2150-2175 | Frontend, défectueux | « All Sources » itère toutes les sources normalisées actives. | Bloquant |
| Recherche Live | public/js/components/ChannelList.js:1530-1564 | Frontend, défectueux | Itération multi-source sans barrière serveur commune. | Bloquant |
| EPG court | supabase/functions/norva-cloud/index.ts:2482-2521 | Propriété seulement | assertOwnedSource puis déchiffrement des credentials. | Bloquant |
| EPG complet | supabase/functions/norva-cloud/index.ts:2537-2588 | Propriété seulement | Lecture cloud_sources par id/user, sans enabled/deleted/lifecycle ; cache edge par user/source. | Bloquant |
| Series info | supabase/functions/norva-cloud/index.ts:2443-2479 | Propriété seulement | Accès direct au provider depuis une source non visible. | Bloquant |
| Création de session playback | supabase/functions/norva-playback/index.ts:735-802 | Propriété seulement | Toute source possédée peut créer une session et résoudre une cible. | Bloquant |
| Résolution/config playback | supabase/functions/norva-playback/index.ts:6112-6141 | Propriété seulement | Le cache de config conserve les credentials 60 s et ignore visibility. | Bloquant |
| Android phone — catalogue | clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java:1118-1188 | Hérité web/backend | Le WebView charge la SPA cloud ; aucun second filtre natif. | Bloquant en amont |
| Android phone — lecteur natif | clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java:1277-1343, clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java:2297-2318 | Hérité playback | Le bridge accepte URL/sourceId/sessionId fournis par le web. | Bloquant en amont |
| Android phone — downloads | clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java:2048-2154 | Absent | Manifeste durable sourceId:itemId et URL ancienne ; aucune invalidation/remap. | Bloquant |
| Android TV — catalogue cloud | clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java:980-1110 | Hérité web/backend | Même SPA et mêmes contrats device. | Bloquant en amont |
| Android TV — lecteur natif | clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java:1293-1430 | Hérité playback | URL et variantes reçues du web, sans contrôle lifecycle natif. | Bloquant en amont |
| Android TV — Watch Next | clients/android-tv/app/src/main/java/tv/norva/tv/WatchNextHelper.java:16-20, clients/android-tv/app/src/main/java/tv/norva/tv/WatchNextHelper.java:29-82 | Absent | Carte launcher et deep link persistent avec A. | Bloquant |
| Android TV standalone — sources | clients/android-tv/app/src/main/java/tv/norva/tv/LocalServer.java:198-365 | enabled partiel | GET /sources rend tout ; PUT modifie la même ligne JSON. | Périmètre à décider |
| Android TV standalone — proxy | clients/android-tv/app/src/main/java/tv/norva/tv/LocalServer.java:373-425, clients/android-tv/app/src/main/java/tv/norva/tv/LocalServer.java:496-503 | Existence seulement | Une source disabled reste utilisable si son id est connu. | Bloquant si fonctionnalité globale |
| Settings — carte source | public/js/components/SourceManager.js:207-268 | Gestion | La source doit rester visible, mais aucun statut Provider Access/lifecycle séparé. | À refondre |
| Settings — gestion du contenu | public/js/components/SourceManager.js:2145-2191, public/js/components/SourceManager.js:2442-2509 | Gestion sans isolation | Si B est renvoyé par GET /sources, ses chaînes/genres peuvent être parcourus avant promotion. | Bloquant |
| Admin — fiche utilisateur | public/js/pages/AdminPage.js:4677-4782 ; supabase/migrations/20260701170000_admin_user_detail_banned.sql:28-53 | Absent | Sources et comptes catalogue incluent tous les états, sans deleted/lifecycle. | Bloquant |
| Admin — alertes source | supabase/functions/norva-admin/index.ts:254-290 | deleted uniquement | Staging/error peut être traité comme incident client normal. | À séparer |
| Auto-refresh | supabase/functions/norva-source-sync/index.ts:1771-1832 | enabled/deleted seulement | B pourrait entrer dans le refresh normal au lieu d’un orchestrateur replacement. | Bloquant |
| Watchdog sync/finalize | supabase/functions/norva-source-sync/index.ts:1864-1927, supabase/functions/norva-source-sync/index.ts:1935-1944 | Partiel | Reprise par sync_status/id, sans rôle staging/replacement. | Bloquant |
| Enrichment fleet | supabase/migrations/20260720180000_series_episode_audio_foundation.sql:2895-2955 | ready/enabled/deleted seulement | B peut rejoindre les files et structures partagées avant commit. | Bloquant |
| Finalisation | supabase/functions/norva-source-sync/index.ts:2113-2151, supabase/functions/norva-source-sync/index.ts:2324-2356 | Propriété/id seulement | Passe une source à ready sans état de promotion distinct. | Bloquant |
| Soft-delete / reaper | supabase/functions/norva-cloud/index.ts:4916-4933 ; supabase/migrations/20260707180000_reap_reliable_timeout_via_cron_command.sql:24-73 | deleted_at seulement | Cleanup détruit les favoris et finit par supprimer A. | Incompatible remplacement |

## 5. Pourquoi le catalogue peut mélanger A et B aujourd’hui

Le refresh Xtream « Layer 3 » est conçu pour préserver un catalogue existant pendant une resynchronisation normale. Cette propriété est saine pour un refresh du même provider, mais dangereuse quand Edit login change de catalogue :

- aucun delete initial ; les nouvelles lignes sont upsertées dans les tables live : supabase/functions/_shared/xtream-sync.ts:296-338, supabase/functions/_shared/xtream-sync.ts:651-668 ;
- les anciennes lignes ne sont prunées qu’après une discovery complète : supabase/functions/_shared/xtream-sync.ts:767-823 ;
- si B retourne zéro ligne, A est conservé et la source repasse ready : supabase/functions/_shared/xtream-sync.ts:775-800 ;
- si plus de 50 % des lignes disparaîtraient, le prune est refusé et la table reste un superset ancien+nouveau : supabase/functions/_shared/xtream-sync.ts:67, supabase/functions/_shared/xtream-sync.ts:805-830.

Comme Settings remplace les credentials sur la même ligne source avant de lancer cette sync (public/js/components/SourceManager.js:1554-1579 ; supabase/functions/norva-cloud/index.ts:1357-1417), ce comportement peut temporairement ou durablement associer sous le même sourceId :

- les anciennes lignes A ;
- les nouvelles lignes B ;
- une config provider déjà passée à B ;
- des caches playback encore sur A pendant jusqu’à 60 secondes.

Ce mécanisme interdit de traiter l’actuel PATCH /sources/:id comme un remplacement sûr.

## 6. Inventaire des aliases, références et caches

| État | Clé / portée | Preuve | Risque A → B |
|---|---|---|---|
| Alias cloud UUID → id local numérique | localStorage norva-cloud-source-aliases | public/js/api.js:247-275 | A reste adressable ; B reçoit un autre alias sans remap. |
| Cache sources en mémoire | sourcesCache | public/js/api.js:247-254, public/js/api.js:331-345 | Valeur enabled/lifecycle obsolète. |
| Caches media/page/Live/Home | Maps en mémoire, TTL page 120 s | public/js/api.js:249-254, public/js/api.js:348-352 | Cartes A ou B staging déjà hydratées. |
| Signature catalogue | max catalog_version des sources chargées | public/js/api.js:2288-2303 | Une bascule de visibilité n’invalide pas nécessairement le cache. |
| Cache source cloud | 30 s | public/js/cloudApi.js:642-653 | Settings/pickers peuvent garder l’ancienne projection. |
| Cache favoris/historique | 30 s / 20 s | public/js/cloudApi.js:626-644, public/js/cloudApi.js:4355-4384 | Cartes anciennes après commit. |
| Cache SWR première page | localStorage norva-cc:*, jusqu’à 7 jours | public/js/utils/catalogCache.js:13-72 | Peint avant revalidation ; versionné seulement par catalog_version. |
| Filtres Movies/Series | norva-filters-v2-user/device-page | public/js/utils/mediaUtils.js:1143-1180 ; public/js/pages/MoviesPage.js:233-284 | selected source continue de pointer vers A. |
| Cache Live | IndexedDB norva-live-cache, clé norva-live:type:id:v5 | public/js/components/ChannelList.js:2267-2380 | Non user-scoped et non visibility-versioned ; peinture directe. |
| Récents Live | localStorage norva-recent-channels | public/js/components/ChannelList.js:1348-1431 | A reste classé et relançable. |
| Dernière chaîne | localStorage LAST_LIVE_CHANNEL_KEY | public/js/components/ChannelList.js:2451-2481 | Reprise vers A. |
| Groupe guide Live | norva_live_guide_group | public/js/components/LiveGuideFusion.js:8-35 | Sélection locale potentiellement orpheline. |
| Choix de version série | norva.series.versionChoice | public/js/pages/SeriesPage.js:2564-2592 | Couple sourceId/series_id A persistant. |
| Snapshot/reprise lecteur | sessionStorage et localStorage indexés sourceId | public/js/pages/WatchPage.js:1019-1101 | Reprise ou retry sur A. |
| Offset sous-titres | clé source/item/track | public/js/pages/WatchPage.js:8989-9014 | Référence physique A persistante. |
| Backoff cloud VOD | norva-cloud-blocked-sources-v1, 30 min | public/js/api.js:28-59 | État A peut polluer/remplacer le comportement B. |
| Backoff Live | norva-live-blocked-sources-v1, 60 s | public/js/api.js:87-108 | Même risque. |
| Cache EPG edge | userId:sourceId:fenêtre | supabase/functions/norva-cloud/index.ts:2537-2588 | Données A encore servies si la route reste accessible. |
| Cache config playback | userId:sourceId, 60 s | supabase/functions/norva-playback/index.ts:6104-6129 | Des isolates peuvent utiliser A après l’update vers B. |
| Downloads Android | DownloadStore, id sourceId:itemId, URL stockée | clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java:2050-2107 | Fichier/queue A n’est ni remappé ni invalidé. |
| Android TV Watch Next | provider id source:type:item | clients/android-tv/app/src/main/java/tv/norva/tv/WatchNextHelper.java:29-82 | Carte launcher A hors SPA. |

Contrat client minimal requis :

    replaceSourceReferences(oldSourceId, newSourceId, visibilityEpoch)

Il doit être idempotent et :

- supprimer ou remapper les aliases physiques ;
- remettre les filtres invalides sur All Sources ;
- purger les caches mémoire, SWR, IndexedDB, EPG et backoff ;
- revalider les choix de version, récents, dernière chaîne et préférences playback ;
- supprimer/mettre à jour Watch Next ;
- définir explicitement le sort des downloads déjà terminés et des queues actives.

Une solution plus robuste consiste à exposer au client une identité de chaîne stable dérivée de `replacement_root_id` et à garder les ids physiques A/B exclusivement côté serveur.

## 7. Historique, favoris et cleanup

L’exigence de conservation non destructive n’est pas satisfaite par le delete actuel :

- cloud_favorites référence cloud_sources avec ON DELETE CASCADE : supabase/migrations/20260613150937_cloud_core_playback.sql:86-95 ;
- cloud_watch_history utilise ON DELETE SET NULL : supabase/migrations/20260613150937_cloud_core_playback.sql:98-112 ;
- le reaper supprime explicitement cloud_favorites avant de supprimer la source : supabase/migrations/20260707180000_reap_reliable_timeout_via_cron_command.sql:62-70.

Conséquences :

- utiliser DELETE /sources/A après la promotion détruirait les favoris A ;
- l’historique survivrait, mais perdrait source_id et donc une partie de sa capacité de résolution ;
- il n’existe pas de remap transactionnel par identité titre/TMDB vers B ;
- la fréquence actuelle du reaper est toutes les dix minutes : supabase/migrations/20260708093000_reap_frequency_10min.sql:9-16.

Le remplacement doit donc avoir son propre cleanup, distinct du delete utilisateur actuel.

## 8. Tests existants et couverture manquante

### Contrats adjacents présents

| Sujet | Preuves |
|---|---|
| Santé source et Settings | tests/source-health-contract.test.js:32-395 |
| Onboarding, focus et modal | tests/onboarding-ui-contract.test.js:18-82 |
| Filtres persistants | tests/catalog-filter-persistence.test.js:595-789 |
| Cache facettes langue | tests/catalog-language-facet-cache.test.js:77-170 |
| Identité historique | tests/catalog-history-identity.test.js:129-249 |
| Ordre causal historique | tests/watch-history-causal.test.js:9-75 |
| Sessions playback/gateway | tests/playback-gateway-session-lifecycle.test.js:23-145 |
| Recovery native | tests/native-playback-recovery.test.js:189-1548 |
| Downloads et accessibilité Android | tests/android-phone-downloads-contract.test.js:78-201 |
| Mémoire Live Android TV | tests/android-tv-live-memory-contract.test.js:159-236 |
| États Home/Live mobile | tests/mobile-home-live-movies-premium-contract.test.js:20-86 |

### Absences bloquantes

La recherche dépôt n’a trouvé aucun contrat catalogue pertinent pour :

- source_lifecycle_state ;
- catalog_visibility ;
- replaces_source_id / replaced_by_source_id ;
- provider_access_status ;
- replaceSourceReferences ;
- invisibilité staging/hidden sur toutes les surfaces.

Avant GO, il faut au minimum :

1. tests SQL/RPC prouvant que chaque lecture exclut staging et hidden ;
2. tests user JWT et device token pour chaque ligne de la matrice ;
3. tests avec sourceId explicite, sans sourceId et mode All Sources ;
4. tests cache préchauffé puis masquage/commit avant first paint ;
5. tests player, retry/recovery, EPG, downloads et Watch Next ;
6. tests A seul visible, B seul visible après commit, jamais A+B ;
7. tests cancel, rollback, refresh navigateur, fermeture/réouverture app et commit concurrent ;
8. tests historique/favoris conservés, remappés ou temporairement non rendus sans carte injouable ;
9. tests crons, enrichment, admin et cleanup ;
10. tests clavier, TalkBack, D-pad, Android Back et restauration du focus.

## 9. Implications UX et accessibilité

### Primitives réutilisables

- SourceManager dispose déjà d’un menu nommé et d’un Escape/GoBack : public/js/components/SourceManager.js:256-319.
- Le modal d’édition installe l’hygiène NorvaModal : public/js/components/SourceManager.js:371-396.
- La progression de catalogue utilise status/alert, aria-live et progressbar : public/js/components/SourceManager.js:1024-1056.
- Le formulaire onboarding expose aria-describedby, aria-invalid, focus sur erreur et aria-busy : public/js/pages/HomePage.js:1079-1127, public/js/pages/HomePage.js:1179-1211, public/js/pages/HomePage.js:1289-1299.
- La recherche globale possède un dialogue modal et une gestion de focus : public/js/app.js:2686-2777.

### Risques structurants

- sourceHealth confond toujours erreur technique et « abonnement terminé » : public/js/utils/sourceHealth.js:145-200.
- Le CTA d’une source expired/auth_failed ouvre directement Edit login : public/js/utils/sourceHealth.js:607-648.
- La carte Settings ne présente qu’un badge santé : public/js/components/SourceManager.js:220-250.
- L’onboarding ne propose aucune date Provider Access ni consentement de rappel : public/js/pages/HomePage.js:1079-1127.
- Le nouveau workflow aura des états longs et asynchrones ; un simple toast ne suffit pas pour TalkBack, D-pad ou reprise après fermeture.

Exigences de conception :

- séparer visuellement et sémantiquement Technical status et Provider access ;
- ne jamais appeler l’accès provider « Norva subscription » ;
- conserver Settings accessible même lorsque le seul catalogue est masqué ;
- déplacer et confiner le focus à l’ouverture des modals/sheets, fermer avec Back avant navigation, restaurer le trigger ;
- annoncer les changements importants sans annoncer chaque incrément de progression ;
- conserver des cibles de 44 CSS px dans le WebView et 48 dp en natif ;
- tester police Android 1,3, navigation gestuelle et trois boutons ;
- ne jamais exposer config, username, id interne, payload provider ou erreur brute.

## 10. Contrat serveur recommandé

### Projection de visibilité

Une vue/RPC/helper DB unique doit imposer :

    source_lifecycle_state = active
    catalog_visibility = visible
    enabled = true
    deleted_at IS NULL

Toutes les lectures catalogue, y compris les RPC SQL, doivent partir de cet ensemble ou recevoir une liste de source IDs visible calculée côté serveur. Le client ne peut pas fournir includeHidden sur une route user/device.

### Deux projections de sources

- **Management projection** : Settings peut voir tous les états de source (`active`, `staging`, `replaced`, `purge_pending`, `purged`), la visibilité, la transition et Provider Access.
- **Catalog projection** : SPA, devices, playback, EPG et background de consommation ne voient que `active/visible`.

### Codes et génération

Les routes playback/EPG/series-info/favorites/history doivent refuser une source non visible avec un code stable, par exemple SOURCE_CATALOG_NOT_VISIBLE. Un `visibility_epoch` monotone doit :

- être renvoyée par bootstrap et réponses catalogue ;
- participer aux clés de cache ;
- être incrémentée dans la même transaction que la promotion ;
- provoquer l’abandon des requêtes et rendus partis sous une génération antérieure.

## 11. Angles morts

Ces points restent à décider ou prouver :

1. Le schéma et les fonctions réellement déployés peuvent différer du dépôt ; aucune introspection live n’a été réalisée.
2. La politique pour une lecture déjà active au moment du masquage/commit n’est pas définie : terminaison immédiate, grâce bornée ou maintien jusqu’à la fin.
3. Le sort des downloads A déjà terminés et des queues actives n’est pas défini.
4. Le périmètre Provider Access du mode Android TV standalone n’est pas explicite.
5. L’administration doit-elle voir les métadonnées staging, les comptes staging, ou aucun contenu staging ? Le niveau d’accès n’est pas défini.
6. Les structures globales/provider identities et la fan-out cross-account de l’enrichment n’ont pas été prouvées isolées d’un dataset staging.
7. Les notifications/email Provider Access, leur consentement, supersession et idempotence n’existent pas encore dans le périmètre observé.
8. Les caches CDN/service worker et d’éventuels consommateurs externes non présents dans le dépôt ne sont pas couverts.
9. Aucune vérification physique TalkBack, D-pad, IME, police 1,3 ou navigation Android n’a été exécutée.
10. Le comportement de rollback après une promotion partiellement committée n’existe pas encore et ne peut donc pas être testé.

## 12. Critères de sortie du NO-GO

Le remplacement ne devient GO que si les preuves suivantes existent simultanément :

- B ne peut être lu par aucune surface avant promotion ;
- A reste intact jusqu’à validation complète de B ;
- la promotion est une transaction unique et produit un nouveau `visibility_epoch` ;
- aucune fenêtre ne rend A+B ;
- rollback et cancel sont idempotents ;
- les limites de plan ne comptent pas B staging comme une seconde source active ;
- favoris, historique et progression ne sont pas détruits ;
- le cleanup est durable et distinct du delete actuel ;
- toutes les références/caches clients sont remappés ou invalidés avant rendu ;
- Settings reste opérable et expose des états compréhensibles et accessibles ;
- la matrice automatisée user/device/web/phone/TV/admin/background est verte.
