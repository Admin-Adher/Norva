> **Audit multi-agents** — généré le 2026-06-28. 16 agents (1 cartographe + 7 auditeurs + 7 vérificateurs adversariaux + 1 synthèse).
> **44 findings vérifiés** (8 high · 27 medium · 9 low), 3 réfutés. ~1,2M tokens, ~23 min.
> Dimensions : pipeline · pourcentages · machine à états · modal/UI · résilience · exactitude compteurs · perf & échelle.

# Audit onboarding & import - rapport

## Resume executif

La sante globale de l'onboarding est preoccupante : le pipeline d'import est fonctionnel mais presente un decalage systemique entre ce qui est *affiche* a l'utilisateur et ce qui est reellement *importe et navigable*. Le probleme le plus grave est qu'un gros catalogue ("8K", ~272k VOD) prend des heures, voire des jours, a se materialiser et s'enrichir, alors que tout le langage et les indicateurs promettent "quelques minutes" et un catalogue "Terminé". Les pires problemes : (1) la presence de **deux moteurs de sync/finalize divergents** (norva-cloud vs norva-source-sync) qui corrompent silencieusement le catalogue lors d'un basculement, (2) des imports volumineux **bloques definitivement** par un budget d'isolates non reinitialise + un watchdog qui refuse de reprendre une decouverte en erreur, et (3) le client qui peut **forcer "ready" a 100%** sur un catalogue partiel. Le bug visible des **nombres coupes au milieu d'un chiffre** ("55,50"/"9", "171,69"/"3") est un defaut CSS (`overflow-wrap:anywhere`) qui casse la confiance des le premier ecran. Le copy **"a few minutes"** est faux pour la realite multi-heures/jours. Enfin, la question des compteurs **"found" vs "ready"** : les nombres affiches (55 509 chaines, 171 693 films) sont des totaux de *decouverte fournisseur*, pas des lignes materialisees/verifiees ; seuls ~2,5% des titres sont valides TMDB et reellement navigables, et l'ecart ne se comble jamais.

## Problemes par severite

### Critical / High

**Deux implementations finalize divergentes (keyset vs offset) corrompent la projection des titres au basculement** - `supabase/functions/norva-cloud/index.ts:1862` (+ `norva-source-sync/index.ts`)
Le client (`cloudApi.js:511`) appelle d'abord norva-source-sync, puis bascule sur norva-cloud en cas de 5xx/546. Le driver de fond persiste `finalizeCursor={phase,offset,afterId}` ou `offset` est un compteur **keyset** (ordonne par id). Mais norva-cloud `loadSourceItems` fonctionne en mode **offset positionnel** ordonne par `(item_type,external_id)` et **ignore `afterId`** (pas de branche keyset a `loadSourceItems:2083`). Appliquer un offset derive d'un keyset comme offset positionnel dans un ensemble ordonne differemment atterrit a des lignes arbitraires.
*Impact* : sur tout 5xx de source-sync, le co-pilotage client reprend les titres aux mauvaises lignes : certains films/series ne sont jamais projetes (absents de Movies/Series), d'autres dupliques. Catalogue silencieusement incomplet.
*Correctif* : faire deleguer norva-cloud finalize a l'implementation keyset de norva-source-sync (honorer `afterId`, semantique `rows.length<limit` identique), ou supprimer le doublon.

**Decouverte en erreur (ou plafond de budget) echouee de maniere permanente — le watchdog refuse de reprendre** - `supabase/functions/norva-source-sync/index.ts:886`
`driveXtreamSyncToReady` leve `HttpError(500,'exceeded its continuation budget')` au-dela de 160 tentatives (`:1733`). Le catch ne traite que `status===503` comme transitoire (`:1915`) ; un 500 passe `sync_status='error'` (`:1931`) mais ne met jamais `cursor.active=false`. Or `cronResumeStuck` calcule `inDiscovery = !isError && cursor.active===true` (`:886`) : une source en erreur en pleine decouverte est **ignoree**, et n'ayant pas de `finalizeCursor`, `inFinalize` est faux aussi.
*Impact* : un import volumineux/lent qui epuise le budget de 160 isolates, ou qui declenche **n'importe quelle** erreur non-503 (lecture DB 500, echec de dechiffrement, throw simple) meurt definitivement. L'utilisateur voit "Needs attention"/"Repair Login" alors que les identifiants sont valides.
*Correctif* : dans `cronResumeStuck`, reprendre la decouverte quand `cursor.active===true && phase==='discover'` **independamment de `isError`** (miroir de la branche finalize). Sur reprise, remettre `cursor.attempts` a 0.

**`cursor.attempts` monotone jamais reinitialise — un gros import legitime s'auto-avorte a 160 isolates** - `supabase/functions/norva-source-sync/index.ts:1732`
`cursor.attempts` est incremente a chaque isolate (`:1732`) et compare a `SYNC_MAX_CONTINUATIONS=160` (`:1733`), mais n'est **jamais** remis a 0 sur progression. Un catalogue 272k/55k-live (live en chunks de 4000 + titres en lots de 300 = des centaines d'auto-invocations) plus les reanimations du watchdog accumulent les `attempts` sans plancher.
*Impact* : la decouverte (et via le meme plafond le driver jumeau norva-cloud `:1548`) avorte un gros import qui progresse pourtant, puis l'echoue de maniere permanente (cf. probleme precedent). Le garde-fou anti-boucle-infinie tue aussi les gros imports sains.
*Correctif* : remettre `cursor.attempts` a 0 a chaque progression reelle (`typeIdx`/`catIdx` avance), pour que le budget ne se declenche que sur une boucle reellement bloquee (zero progres).

**Le client force la source en READY (100%) sur un blocage de la marche des titres — catalogue partiel declare complet** - `public/js/components/SourceManager.js:833`
La boucle de recuperation s'interrompt sur un blocage (`nextPhase===phase && nextOffset<=offset && nextAfterId===afterId && !done`, `:833`), puis appelle **inconditionnellement** `API.sources.finalize(sourceId,{phase:'complete'})` (`:840`). La phase 'complete' execute `heal_cloud_title_variants` et ecrit `sync_status='ready'` + `percent:100` quel que soit le nombre de titres reellement parcourus (ex. offset 127200/272780).
*Impact* : si la marche keyset pilotee par le client se bloque (statement-timeout repete), le modal saute directement a "complete", tamponnant la source ready a 100% avec une grande fraction des titres VOD jamais projetes — catalogue silencieusement incomplet presente comme termine.
*Correctif* : sur blocage, **ne pas** appeler `phase:'complete'` ; rendre la main au driver de fond + watchdog (qui reprennent depuis le curseur). Ne finaliser 'complete' que si le serveur a renvoye `done:true`.

**Une erreur de re-sync transitoire declasse un catalogue entierement construit** - `public/js/utils/sourceHealth.js:191`
L'ordre de `classifySource` : `syncingStates` (protege par `hasCompletedCatalog`) → `else if (error)` (`:191`) → `else if (readyStates||lastSync)` (`:193`). Le garde `hasCompletedCatalog` ne protege que la branche *syncing*. Un re-sync de fond qui echoue (serveur ecrit `sync_status='error'`, `index.ts:1931`) touche la branche erreur en premier : une source deja onboardee devient degraded/unreachable/auth_failed alors que son catalogue est intact et `lastSync.syncedAt` est defini.
*Impact* : un refresh automatique nocturne heurtant un 502/timeout fournisseur transitoire jette un foyer onboarde sur une carte bloquante "Needs attention/Update login" malgre un catalogue utilisable.
*Correctif* : proteger la branche erreur avec `hasCompletedCatalog` : si un catalogue complet existe, classer ready+refreshing (ou une note non-bloquante "refresh failed") au lieu de degraded.

**"Channels found — Done — 55,509" est tamponne a la decouverte, avant toute materialisation** - `supabase/functions/norva-source-sync/index.ts:1877`
A la fin de la decouverte, le handoff ecrit `steps.channels={status:"done",count:liveCount}` (`:1879`) alors que le stage est seulement "materializing", percent:74. Les chaines live sont materialisees **plus tard** dans la phase "live" du finalize (chunks de 4000, `:1099-1125`). La grille Live ne lit **que** `cloud_live_logical_channels` (`norva-catalog:1687`). Le meme schema vaut pour movies/series/import.
*Impact* : l'utilisateur voit l'etape Channels "Terminée" avec le compte complet alors que zero chaine est interrogeable ; ouvrir Live TV affiche une grille vide/en chargement.
*Correctif* : marquer l'etape "done" seulement apres la materialisation (phase live finalize terminee), ou re-libeller l'etape "found" vs un etat "ready" distinct.

**Les compteurs affiches sont des totaux de decouverte fournisseur, pas des lignes navigables — l'enrichissement plafonne ~2,5%** - `supabase/functions/norva-source-sync/index.ts:1875` (+ `norva-catalog/index.ts:139`)
`counts.{live,movies,series}` sont des tallies bruts d'upsert dans `cloud_media_items` (`:1828-1836`) ; le client prefere `progressCounts` (`SourceManager.js:566`). Mais les rails filtrent `match_status='provider_verified' AND variant_count>0` (`norva-catalog:1210`), et seul `validation.valid` produit `provider_verified` (`vod-title-projection.ts:332`). La validation TMDB inline est desactivee par defaut (`tmdbValidateLimit=0`, `index.ts:1156`). De plus `getEnrichmentProgress` ne compte que `provider_tmdb_id NOT NULL`, le cron est mono-passe et **plafonne ~2,5%** de maniere permanente (`norva-catalog:140-152`).
*Impact* : les cartes affichent "171,693 films / 45,578 series found" mais les rails verifies (Home/genre/because-you-watched) n'exposent qu'un petit sous-ensemble valide ; les compteurs ne se reconcilient jamais avec les grilles, meme apres "ready".
*Correctif* : libeller les cartes comme totaux "detectes par le fournisseur" et exposer un compteur distinct "prêt à regarder" (`provider_verified + variant_count>0`), ou elargir l'eligibilite des rails au-dela de `provider_verified`.

**Les onglets catalogue se deverrouillent sur les compteurs "found", pas sur les lignes materialisees** - `public/js/app.js:402`
`catalogCategoryAvailable` renvoie `Number(counts[category]) > 0` depuis `progress.counts` (upserts de decouverte, `index.ts:1828`). `guardCatalogPage` (`:395`) admet les deep-links et `applyCatalogAvailability` revele l'onglet sur le meme signal — bien avant que `cloud_live_logical_channels` soit peuple ou que les titres aient `variant_count>0`.
*Impact* : les onglets Movies/Series/Live se revelent et s'ouvrent alors que les grilles sont encore vides/clairsemees — "ready" expose des heures avant que le contenu soit reellement navigable (~272k).
*Correctif* : conditionner la revelation de chaque onglet a un signal de materialisation/finalize (etape finalize terminee, ou comptes materialises par categorie) plutot qu'aux compteurs de decouverte bruts.

**Le copy "a few minutes" pour un import qui prend des heures-à-jours** - `public/js/utils/sourceHealth.js:21`
`STATE_META.syncing.message = "Norva is importing channels, movies and series. This can take a few minutes."` (rendu sur la carte Home `cardHtml:322`, et corps du modal `SourceManager.js:728`). Realite : budget decouverte `SYNC_MAX_CONTINUATIONS=160 × 90s`, finalize titres 272k VOD a 300 lignes/lot + throttle 2500ms ≈ heures, enrichissement plafonne ~2,5%.
*Impact* : les utilisateurs attendent des minutes, obtiennent des heures/jours ; ils pensent l'import bloque/casse, relancent, ou churn pendant l'onboarding.
*Correctif* : adapter le message a la taille du catalogue (ex. "les grandes bibliothèques peuvent prendre un moment ; vous pouvez commencer à regarder à mesure que le contenu apparaît") ou retirer toute promesse de duree.

**Aucun plafond de concurrence global sur finalize/discovery — N gros imports simultanes saturent la DB partagee** - `supabase/functions/norva-source-sync/index.ts:942`
`driveFinalizeToReady` ne throttle que ses propres lots (`NORVA_FINALIZE_THROTTLE_MS`, defaut code uniquement, jamais defini en deploiement). Chaque source s'auto-invoque en chaine independante (`selfInvokeFinalize:989`, `selfInvokeSyncStep:1609`). `cronResumeStuck` reanime jusqu'a 5 sources/min (`:902`) sans conscience de charge DB.
*Impact* : plusieurs utilisateurs onboardant des catalogues 8K en meme temps lancent des upserts lourds (declencheurs) concurrents sur un seul Postgres sans coordination ; le browse au premier plan peut timeout.
*Correctif* : ajouter un plafond global d'imports lourds en vol (advisory lock ou table de slots reclamés), bornant le nombre total de chaines lourdes concurrentes.

**Les nombres de stat-cards se coupent au milieu d'un chiffre ("55,50"/"9") — `overflow-wrap:anywhere`** - `public/css/main.css:2889` (+ variante setup `:2570`)
`.source-sync-card strong { display:block; overflow-wrap:anywhere }` dans une grille 4 colonnes `minmax(0,1fr)` avec `min-width:0`. La variante setup-panel (`:2570`) est identique : `white-space:normal + overflow-wrap:anywhere`, police clamp jusqu'a 2.35rem. `anywhere` autorise une coupure **à l'intérieur** du nombre formate.
*Impact* : les grands comptes se scindent visiblement au milieu (55,509→"55,50"/"9" ; 171,693→"171,69"/"3"), rendant les chiffres phares illisibles/casses — defaut visible des le premier ecran, sape la confiance.
*Correctif* : sur les deux selecteurs `strong`, mettre `white-space:nowrap; overflow-wrap:normal; word-break:normal` (garder `tabular-nums`) ; ajouter `overflow:hidden;text-overflow:ellipsis` si besoin.

**Le CTA principal "View service" ouvre le modal Repair/Edit en plein import sain** - `public/js/utils/sourceHealth.js:326`
Le bouton primaire de la carte = `summary.action` = `STATE_META.syncing.action` "View service" (`:22`), cable sur `data-source-health-action=open-sources` → `openAction`. Pendant syncing, `summaryFrom` met `issues=syncing items` (`:242`), donc `openAction` trouve `primarySource` et appelle `manager.showEditModal(id,type)` (`:367`) — le formulaire de reparation de login — pas le modal de progression (seul le secondaire "View progress" l'ouvre, `:311`).
*Impact* : le CTA proeminent "View service" plonge l'utilisateur dans un formulaire "Repair Login" durant un import sain, suggerant un probleme.
*Correctif* : pendant syncing, router l'action primaire vers `openProgress` (le modal) ou la relibeller/rediriger vers la liste settings ; reserver le modal d'edition aux vrais etats d'erreur.

### Medium

**Phase titres marquee terminee prematurement quand `limit>=1000` (plafond PostgREST) — `/cron/finalize-step` defaut 1500 saute ~la moitie du VOD** - `supabase/functions/norva-source-sync/index.ts:1162`
`done = rows.length === 0 || rows.length < batchLimit`. La route `/cron/finalize-step` passe `limit=1500` par defaut (`:114`) directement a `finalizeCloudSource` ; le keyset fait `.limit(1500)` mais PostgREST plafonne a 1000, donc `rows.length=1000 < 1500 ⇒ done=true` apres un seul lot.
*Impact* : l'outil de boucle documente ("materialiser une grande source de maniere fiable") termine les titres apres ~1000 lignes sur des centaines de milliers, source marquee complete.
*Correctif* : borner `batchLimit` a <1000 (`min(limit,999)`), ou calculer `done` depuis `nextOffset>=totalVod` comme norva-cloud (`:1895`).

**norva-cloud finalize 'complete' saute le filet de securite `heal_cloud_title_variants`** - `supabase/functions/norva-cloud/index.ts:1915`
La phase complete de norva-source-sync appelle `heal_cloud_title_variants` avant de marquer ready (`:1194-1195`) ; norva-cloud va directement a `sync_status:'ready'` sans heal (`:1915-1934`).
*Impact* : si le co-pilotage client atteint complete via le fallback norva-cloud, les titres verifies sans variantes ne sont jamais reparés et disparaissent des rails de genre, alors que la source affiche "ready".
*Correctif* : appeler `heal_cloud_title_variants` aussi dans la phase complete de norva-cloud, ou router tout finalize via la seule implementation source-sync.

**La decouverte sur-compte les streams presents dans des categories traitees a des iterations differentes (`totalVod` gonfle)** - `supabase/functions/norva-source-sync/index.ts:1822`
Par iteration, seule la tranche courante (~14 categories) est dedupliquee : `batchRows=dedupeByConflictKey(rawRows)`, puis `movieCount/seriesCount/liveCount += batchRows.length`. Un stream liste en categorie #1 et #20 (iterations differentes) est compte deux fois, mais l'upsert (`ignoreDuplicates`) ne le stocke qu'une fois.
*Impact* : "films/series found" surestime la realite ; `totalVod` (denominateur des titres + check `nextOffset>=totalVod`) est gonfle, donc le pourcentage des titres n'atteint jamais le haut de sa bande et les comptes sont faux.
*Correctif* : dedupliquer les `external_id` par `item_type` sur toute la decouverte (un Set dans le curseur) avant d'incrementer, ou deriver les comptes finaux de `countRowsByType` au handoff.

**Le clamp monotone client peut figer la barre haut apres une regression finalize non-terminale** - `public/js/components/SourceManager.js:615`
`monotonicSyncProgress` cache le max% dans localStorage `norva-sync-progress:<id>:<startedAt>` et rend `max(previous,raw)` (`:615`). Le cache n'est vide qu'au statut terminal (`:618`) ; la reprise garde le meme `startedAt`. Si un run atteint un % eleve puis qu'un echec finalize non-terminal reprend a un % reel plus bas, le client continue d'afficher la valeur cachee plus haute.
*Impact* : la barre peut rester a 99% alors que le travail serveur a regressé/cale a la reprise ; faux "presque fini" qui n'aboutit jamais.
*Correctif* : lier le cache a une epoque/curseur finalize, ou autoriser une correction descendante controlee quand le serveur signale un stage materiellement inferieur.

**Co-pilotage client immediat (`requireStale:false`) en course avec le driver de fond sur les memes lots** - `public/js/components/SourceManager.js:914`
Le poll du modal lance `recoverCatalogFinalization` des que `shouldRecoverCatalogFinalization(current,{requireStale:false})` est vrai (`:914`), sans aucune barriere de fraîcheur, alors que `driveFinalizeToReady` pilote deja le meme curseur (`index.ts:927,:1910`). Pas de verrou single-flight pour finalize.
*Impact* : client + driver de fond declenchent des upserts de projection concurrents sur les memes lignes, doublant la charge des declencheurs keep-best/mirror que le lot de 300 + throttle visaient a eviter — augmentant le risque de statement-timeout et auto-perpetuant le blocage.
*Correctif* : conditionner le co-pilotage client a un seuil de fraîcheur (`updatedAt` > ~60s, deja supporte via `requireStale:true`).

**Detection de blocage sans borne superieure — `updatedAt` rafraîchi mais offset jamais avance = "frais" pour toujours** - `supabase/functions/norva-source-sync/index.ts:898`
`cronResumeStuck` ne re-lance que si `lastSeen <= staleIso` (`:898`, seuil 60s). Or `finalizeCloudSource` reecrit `progress.updatedAt` a chaque entree de lot (`:1034`), meme sur une re-marche qui re-projette des lignes deja construites. Comme le `percent` titres est la position de marche keyset, une chaine qui reprend, re-marche mais n'avance pas le curseur tamponne quand meme un `updatedAt` frais.
*Impact* : un finalize vivant-mais-non-progressant (chaque isolate timeout juste apres le premier `reportProgress`) semble sain au watchdog indefiniment ; la barre reste a ~92-94% "still preparing" pour toujours sans escalade.
*Correctif* : suivre un heartbeat d'avancement de curseur separe (temps de changement de `offset/afterId`), traiter "updatedAt frais mais curseur immobile depuis N minutes" comme bloque et escalader.

**Le pourcentage de progression surestime la disponibilite : 92% = position de marche keyset, pas titres materialises/verifies** - `supabase/functions/norva-source-sync/index.ts:1171` / `:1291`
`percent = titleFinalizePercent(nextOffset, totalVod)` ou `nextOffset` est l'offset keyset sur movie+series (`:1158`). Le commentaire (`:1163`) admet que `percent = position de marche / total`. 92% ⇒ ratio≈0.46, soit ~46% des items VOD parcourus, mais seulement ~2,5% verifies TMDB/navigables.
*Impact* : 92% implique presque-fini alors que moins de la moitie du VOD est meme projetee et bien moins verifiee ; fausse attente "presque fini".
*Correctif* : renommer la phase "Indexation des titres" (pas readiness), ou ponderer le % par lignes verifiees/materialisees ; plafonner la marche sous 100 jusqu'a ce que variantes/enrichissement arrivent.

**Deux moteurs finalize/percent divergents : bandes 86→99/complete 99 vs 86→95/complete 96** - `supabase/functions/norva-source-sync/index.ts:1298` (+ `norva-cloud:1985,1998`)
`titleFinalizePercent` source-sync = `max(86,min(99,round(86+ratio*13)))`, complete=99 ; copie norva-cloud = `max(86,min(95,round(86+ratio*9)))`, complete=96. Le moteur qui pilote determine le % mid-phase pour une progression identique. (Incoherence connexe : `percent:96` vs `99` sur la branche done, `norva-cloud:1898`.)
*Impact* : la meme progression physique affiche un % different selon le moteur ; "92%" est non-deterministe a travers les chemins finalize dupliques, et un fresh source pilote uniquement par norva-cloud plafonne a 96 avant complete.
*Correctif* : supprimer les helpers finalize/percent dupliques de norva-cloud et router tout via source-sync, ou extraire un module partage unique.

**Etapes tamponnees "Done" avec les comptes complets avant materialisation** - `supabase/functions/norva-source-sync/index.ts:1877`
Le handoff marque channels/movies/series/categories/import tous `status:"done"` avec les comptes de decouverte a percent:74, **avant** `materializeLiveChunk` (`:1111`) ou `refreshVodTitleProjection` (`:1137`). Le modal rend "Channels found — Done — 55,509" (`SourceManager.js:689,716`) alors que les chaines ne sont pas encore dans `cloud_live_logical_channels`.
*Impact* : l'utilisateur voit "Done" pour channels/movies/import alors que rien n'est navigable ; les comptes sont des totaux "found" fournisseur, pas des lignes importees.
*Correctif* : garder channels/live "running" jusqu'a la fin de `materializeLiveChunk` ; libeller les comptes "found" distinctement de "ready", ou ajouter une etape de materialisation separee.

**L'enrichissement plafonne en permanence et `settled` est un drapeau global (inter-utilisateurs)** - `supabase/functions/norva-catalog/index.ts:139`
`percent = total>0 ? round(enriched/total*100) : 100`, `enriched` ne compte que `provider_tmdb_id NOT NULL`. Les crons mono-passe laissent les titres non-matches en place (% plafonne ~2,5%). `settled = searchDone && revalDone` est lu depuis les etats **GLOBAUX** `norva_search_match_state/norva_revalidate_state id=1` (`:134,150`), partages entre tous les utilisateurs.
*Impact* : la barre d'enrichissement d'un nouvel utilisateur peut etre declaree "settled" (stop) a un plateau bas parce que le scan global d'un *autre* utilisateur a fini, alors que ses propres titres n'ont jamais ete enrichis.
*Correctif* : rendre `settled` par-utilisateur (curseur d'enrichissement user/source) et presenter le plateau comme "match partiel" plutot qu'une completion.

**Un refresh de disponibilite en arriere-plan peut bloquer l'utilisateur sur une page dont la categorie a disparu** - `public/js/app.js:329`
`maybeAutoRefreshSources` appelle `refreshSourceHealth?.()` sans args (`:329`). `refreshSourceHealth` ne redirige hors d'une page catalogue devenue indisponible que si `redirectIfBlocked=true` (`:364`), que seul le listener `norva:source-health-changed` passe (`:212`). `applyCatalogAvailability` ne fait que masquer la nav (`:423-426`), sans naviguer.
*Impact* : si un re-sync remet les comptes a zero ou qu'une categorie disparaît, la page Movies/Series/Live active reste ouverte et interactive alors que son onglet est masque — gating incoherent.
*Correctif* : passer `redirectIfBlocked:true` sur les chemins de refresh periodique/auto, ou faire que `applyCatalogAvailability` renvoie la page courante vers Home quand sa categorie n'est plus disponible.

**Le modal arrete le polling apres ~3 minutes, figeant la progression d'un import multi-heures** - `public/js/components/SourceManager.js:909`
`for (let attempt = 0; attempt < 90; attempt += 1) { ... await setTimeout(2000) }` → 180s. A la sortie, aucune phase terminale n'est posee, donc le modal reste fige sur le dernier poll (ex. 92%, "Run in Background"). Le finalize/materialize d'un 8K prend des heures.
*Impact* : un utilisateur qui garde le modal ouvert voit le pourcentage/compteurs s'arreter silencieusement apres 3 minutes, sans indication que le polling a cesse — ressemble a un plantage.
*Correctif* : continuer le polling a cadence reduite au-dela du plafond, ou afficher explicitement "toujours en préparation en arrière-plan — revenez plus tard" au lieu d'une barre figee qui semble live.

**Le lot finalize titres tourne pres du plafond statement-timeout et declenche plusieurs triggers lourds par 300 lignes** - `supabase/functions/norva-source-sync/index.ts:946`
Commentaires : upsert 500 lignes mesure ~6,4s sous charge vs 8s de `statement_timeout`, d'ou un lot abaisse a 300 (`:946-951`). Chaque lot declenche keep-best/mirror/genre (`:937-941`). Pour 272k VOD, ~900 lots consecutifs par source. `NORVA_FINALIZE_THROTTLE_MS` n'est jamais defini en deploiement (defaut code seulement).
*Impact* : pendant l'onboarding, le duty-cycle DB est domine par le travail de triggers ; les requetes de browse live (normalement des dizaines de ms) peuvent timeout — le throttle est la seule mitigation et n'est pas defini en prod.
*Correctif* : s'assurer que `NORVA_FINALIZE_THROTTLE_MS` est reellement defini en prod ; envisager un throttle adaptatif sur la latence foreground observee.

**La decouverte upsert tout le catalogue 8K dans `cloud_media_items` par-utilisateur sans plafond (272k lignes/source)** - `supabase/functions/norva-source-sync/index.ts:1577`
`appendSourceItems` ecrit chaque ligne decouverte en chunks de 250 (`IMPORT_BATCH_SIZE=250`) ; `driveXtreamSyncToReady` parcourt toutes les categories sans plafond total. Seul le M3U est borne (`.slice(0,20000)`, `:2145`) ; Xtream n'a pas d'equivalent.
*Impact* : une seule source 8K persiste ~272k lignes par-utilisateur (plus live/titres materialises), pression DB/egress ; non borne entre utilisateurs.
*Correctif* : envisager un plafond d'items par-source ou un dedup global fournisseur, pour qu'un gros fournisseur ne puisse pas ecrire des centaines de milliers de lignes par-utilisateur.

**Barre de progression non exposee a l'accessibilite (pas de `role=progressbar`/`valuenow`)** - `public/js/components/SourceManager.js:765`
`<div class="source-sync-progress" style="--source-sync-percent:92%" aria-label="...">` ; le % n'est qu'un `<small>` decoratif (`:768`). Pas de `role="progressbar"`, ni `aria-valuenow/min/max`, ni region `aria-live` annonçant les mises a jour du poll 2s.
*Impact* : les utilisateurs de lecteur d'ecran obtiennent une barre etiquetee mais sans valeur et n'entendent jamais l'avancement 0→100%.
*Correctif* : ajouter `role="progressbar" aria-valuemin/max/now` (ou `aria-live=polite` sur le %) et mettre a jour `aria-valuenow` a chaque rendu.

**Le modal n'a pas de semantique dialog, pas de gestion du focus, bouton de fermeture sans label** - `public/app.html:1792`
`#modal` sans `role="dialog"`/`aria-modal`/`aria-labelledby` ; fermeture = `<button class="modal-close">&times;</button>` (`:1796`, sans `aria-label`). `showCatalogPreparation` ne fait que basculer `.active` sans deplacer/piéger le focus.
*Impact* : les utilisateurs clavier/SR ne sont pas informes de l'ouverture, le focus reste derriere, et le bouton fermer n'annonce rien ("times").
*Correctif* : ajouter `role="dialog" aria-modal="true" aria-labelledby="modal-title"` ; donner `aria-label="Close"` ; deplacer le focus dans le modal a l'ouverture et le restaurer a la fermeture.

### Low

**Pourcentage done titres incoherent (96 vs 99) entre les deux copies finalize** - `supabase/functions/norva-cloud/index.ts:1898`
norva-cloud reporte `percent:96` (`:1898`), source-sync reporte `percent:99` (`:1171`). `mergeSyncProgress` max-clamp, donc un source pilote uniquement par norva-cloud plafonne a 96 avant complete.
*Correctif* : aligner via un helper de percent finalize partage.

**Saut decouverte→handoff 57→74 ; bandes live/variants en code mort** - `supabase/functions/norva-source-sync/index.ts:1841`
Decouverte plafonne a 57 (`:1841`), handoff hardcode 74 (`:1873`) = saut de 17pt. La phase live yield toujours `nextPhase:"live"`, jamais `live_channels/live_variants`, donc `liveFinalizePercent` 76→80/80→86 ne se declenche jamais ; le vrai % live est l'inline `max(76,min(85,...))`.
*Correctif* : lisser 57→74 (ou piloter le % depuis les comptes), et cabler ou supprimer les helpers bandes inutilises.

**Deux implementations `syncCloudSource` avec leurs propres drivers de decouverte — moteur duplique sujet a la derive** - `supabase/functions/norva-cloud/index.ts:1218`
norva-cloud a son propre `syncCloudSource` + `driveXtreamSyncToReady` + constantes, dupliquant source-sync. `createSource` declenche la version norva-cloud via `waitUntil` (`:909`) mais ses chaines `selfInvoke` sautent vers source-sync (`:1466,:1483`).
*Impact* : le premier isolate de chaque import onboarding tourne la copie norva-cloud ; tout tuning applique a un moteur ne s'applique pas a l'autre.
*Correctif* : consolider sur un seul moteur (faire que `createSource` declenche directement norva-source-sync).

**Comptes et dates en `en-US` quel que soit la locale** - `public/js/components/SourceManager.js:672`
`formatCatalogCount` renvoie `value.toLocaleString('en-US')` (`:672`) ; les jalons et "Last import" utilisent aussi `'en-US'` (`:700,:780`). L'app normalise FR→EN mais la locale nombre/date est figee a US.
*Correctif* : utiliser `toLocaleString()` avec la locale utilisateur/navigateur.

**Detail+statut du jalon joints par un trait d'union simple, lecture ambigue** - `public/js/components/SourceManager.js:716`
`<small>${detail} - ${statusLabel}</small>` → "Secure login check - Done". Le trait d'union sert de separateur de phrase ; pour les SR c'est un run-on, et visuellement on dirait une coquille.
*Correctif* : utiliser un tiret cadratin ou un markup/aria distinct (pastille de statut), avec un prefixe "statut :" visuellement masque.

## Liste d'actions priorisee (par impact/effort)

1. **Corriger le CSS des stat-cards** (`main.css:2570` et `:2889`) : `white-space:nowrap; overflow-wrap:normal`. Bug le plus visible, effort minimal, sape la confiance des le premier ecran.
2. **Reecrire le copy "a few minutes"** (`sourceHealth.js:21`) pour refleter la realite multi-heures sur gros catalogues. Effort trivial, gros impact sur l'attente/le churn.
3. **Reinitialiser `cursor.attempts` sur progression reelle** (`norva-source-sync:1732`). Empeche les gros imports legitimes de s'auto-avorter a 160 isolates. Effort faible, impact eleve.
4. **Faire reprendre la decouverte en erreur au watchdog** (`norva-source-sync:886`) independamment de `isError` quand `cursor.active && phase==='discover'`. Debloque les imports morts presentes comme "Repair Login". Effort faible-moyen.
5. **Ne pas forcer `phase:'complete'` sur blocage cote client** (`SourceManager.js:833`) ; rendre la main au driver de fond. Empeche de declarer "ready" un catalogue partiel. Effort faible.
6. **Proteger la branche erreur avec `hasCompletedCatalog`** (`sourceHealth.js:191`) pour qu'un re-sync transitoire ne declasse pas un catalogue intact. Effort faible, evite des cartes "Needs attention" injustifiees.
7. **Distinguer "found" de "ready"** dans l'UI (`SourceManager.js:566,745` + steps `:689,716`) : libeller les comptes "détectés par le fournisseur", marquer les etapes "Done" seulement apres materialisation, exposer un compteur "prêt à regarder". Effort moyen, corrige le mensonge central de l'onboarding.
8. **Consolider sur un seul moteur sync/finalize** (supprimer les doublons norva-cloud `:1218/:1498/:1862/:1915`, router via norva-source-sync) : elimine d'un coup la corruption de projection au basculement, le saut de heal, et les divergences de percent (96 vs 99). Effort moyen-eleve mais resout 4-5 findings a la fois.

Findings cles cites : `supabase/functions/norva-cloud/index.ts:1862`, `supabase/functions/norva-source-sync/index.ts:886`, `:1732`, `:1877`, `:946`, `public/js/components/SourceManager.js:833`, `:909`, `public/js/utils/sourceHealth.js:21`, `:191`, `public/css/main.css:2570`, `:2889`, `public/js/app.js:402`, `supabase/functions/norva-catalog/index.ts:139`.