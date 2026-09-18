# Cache de reprise — vérification et corrections, 16 septembre 2026

## État de production avant corrections

Activation conservée sur le compte pilote. Aucun déploiement pendant cet audit.
26 tests de `private-resume-cache.test.js` passent.

| Échantillon Promax | Première image | Fenêtre mesurée | Cache |
|---|---:|---|---|
| Cooking Up Love EXYU, annoncé MP4 / profil Matroska contradictoire | 7,643 s | 120,006 s lues / 120,006 s, aucune attente, 0 image perdue | Lecture directe, compteurs HLS inchangés ; ne certifie pas le conteneur |
| Le Jardinier PL, conteneur MPEG-TS confirmé | 54,375 s | 119,926 s / 120,248 s ; attente 0,170 s | Fermeture à 147 s : 15 680 892 octets HLS stockés |
| Le Jardinier PL, reprise à 147 s | 15,877 s ; playing 18,828 s | 83,884 s / 120,249 s ; attentes 0,081 s et 36,240 s | 2 097 152 octets bruts réutilisés, aucun hit HLS ; seconde sortie crée une seconde entrée |
| Atlas TA MP4, conteneur MP4 confirmé | 4,636 s | 120,238 s / 120,238 s ; aucune attente ; 1 image perdue sur 3318 au relevé | Lecture directe, aucun hit du cache Gateway |
| Atlas CZ/anglais MKV, sous-titres HLS | 11,158 s | 120,158 s / 120,249 s ; attente 0,063 s ; 5 images perdues sur 4048 au relevé | Explicitement exclu du cache HLS ; 8 pistes préparées sur 10 |

Sous-titres Atlas : 221 cues bulgares chargés ; passage au néerlandais, 145 cues chargés, mode showing, cue active et texte visible confirmés par capture. Synchronisation acoustique non certifiée.
Les nombres d'images perdues sont ceux du compteur cumulatif au relevé, pas strictement ceux de la seule fenêtre de 120 s.
Les événements error à position zéro proviennent du nettoyage préalable ; non comptés comme coupures après première image.

## Diagnostic

- MP4 : le relais historique utilisé par ces échantillons ne traverse pas le broker natif qui possède le cache privé d'octets. Il ne faut pas imposer un remux HLS aux fichiers compatibles pour obtenir un compteur de cache.
- Sous-titres : admission explicitement refusée par `privateResumeHlsBindingForSession`; stockage initial mono-playlist TS, pas de graphe WebVTT. Retirer seulement la garde perdrait les sous-titres.
- MPEG-TS : stockage réussi, puis aucun candidat réutilisé avant validation. Deux captures successives du même fichier produisent deux entrées : clé/binding à investiguer. Cause exacte du champ divergent non encore prouvée ; ne pas la présenter comme une défaillance fournisseur.

## Demande additionnelle

L'utilisateur demande désormais de corriger tous ces chemins pour bénéficier des caches. Travail isolé dans `codex/resume-cache-all-formats-20260916`, base `8d15f8be`. Les autres worktrees sont sales : ne pas reprendre leurs modifications non liées.
Pas d'élargissement au-delà du pilote avant preuve de stockage, réutilisation, sous-titres conservés et deux minutes de continuité.

## Corrections locales en cours — non déployées

- Routage MP4 natif admissible par hash propriétaire pilote, sans promotion globale du fournisseur ; preuve de compatibilité navigateur toujours requise. Variable `NORVA_NATIVE_MP4_GATEWAY_OWNER_HASHES` non activée.
- Profil de cache HLS canonique : les métadonnées intrinsèques enrichies ne changent plus la clé ; propriétaire, source/révision, identité forte et choix de pistes restent liés. Le champ responsable du miss MPEG-TS réel reste à isoler.
- Capture atomique vidéo + playlists/segments WebVTT, maintien de l'ancienne fenêtre si la capture échoue, révocation appliquée aussi aux fragments de sous-titres de continuation.
- Horloge WebVTT dérivée du premier PTS vidéo, au lieu d'un décalage nul implicite. Le premier essai présentait environ 1,4 s d'avance.
- Sérialisation de la construction des continuations ; publication limitée au préfixe couvert par toutes les pistes ; nouvelle tentative quand les sous-titres retardataires avancent ; marqueur de fin propagé.
- Pour la continuation indexée MKV/MP4 avec sous-titres, conservation des timestamps source et recherche de sortie absolue sur chaque sortie. L'entrée `-ss` seule conservait dans la fixture le texte SOURCE SECOND 64 à la reprise vidéo 68 ; `-copyts`, prélecture à 53 et trim à 68 produisent bien SOURCE SECOND 68 à 0,021 s.

### Preuves et limites

39 tests ciblés passent, syntaxe Gateway valide. La suite complète parallèle a échoué ; la relance séquentielle se termine avec 4 920 succès, 2 échecs et 24 ignorés. Les deux échecs concernent les preuves de démarrage/copie (`cold full EOF` et `startup policy protocol 2`, dont `stale-proof`). Ne pas annoncer une suite complète verte ; cette relance a commencé avant les dernières modifications de continuation.

Fixture sans fournisseur : source synthétique de 200 s, fenêtre conservée [16,68], 1 stockage + 1 hit, environ 1,55 Mo vidéo et sous-titres. Après correction de l'horloge, le texte SOURCE SECOND 40 commence à 24,021 s dans le lecteur (origine source 16).

Essai navigateur avec recherche de sortie précise : de 4,013 s à 128,100 s sans nouvelle attente après démarrage. Sous-titres initialement désactivés par le lecteur : ces deux minutes ne constituent PAS une validation des sous-titres. Sélection explicite puis recherche à 45 s : attente 46,8 ms liée à cette recherche ; après raccord, SOURCE SECOND 96 commence à 80,0528 s, SOURCE SECOND 100 à 84,0528 s. Pas encore deux minutes continues avec sous-titres actifs pour la dernière variante de commande.

Bloqueurs avant production : revue des routes intégrées et budgets de continuation pour les longues vidéos ; tests réels MP4/MPEG-TS avec stockage puis hit ; confirmation du champ divergent MPEG-TS ; continuité de deux minutes avec sous-titres actifs sur la commande finale ; réconciliation avec les modifications Gateway concurrentes sans les écraser. Aucune nouvelle activation ou modification du service de production dans ce travail ; seules des fixtures synthétiques ont été générées dans son répertoire temporaire.

## Reprise suivante : deux tests corrigés et préflight bloquant

Les deux échecs ont été isolés : les tests signaient une preuve du 17 août puis appelaient `freeze`/la politique de démarrage avec l'horloge réelle. Le TTL de 30 jours expirait. Injection d'une horloge déterministe dans ces deux tests uniquement ; aucune modification de la vérification d'expiration en production. Les deux tests et leur contrôle VAAPI passent (3/3).

La continuation des sous-titres ne conserve désormais que l'index des fragments, et rend un seul WebVTT demandé à la fois. Cela supprime le plafond cumulatif de 4 Mo qui aurait figé les sous-titres pendant les longs films. La révocation est vérifiée avant et après la génération asynchrone. Tests ajoutés : index stable, couverture commune partielle, retard de piste sans changement vidéo, et sérialisation concurrente. Total ciblé actuel : 41/41.

Nouvelle suite complète séquentielle lancée, journal `C:/Users/AdrienHernandez/.codex/tmp/resume-cache-all-formats-retest-20260916.log`.

Lecture fraîche de production : aucune session vidéo ni broker actif, mais `transcribeBusy=true`, `transcribeQueueDepth=3`, trois vignettes durables en attente. Le préflight officiel refuse le redémarrage (`active_or_absent:transcribeQueueDepth`). Demande d'autorisation de suspension propre et de restauration envoyée ; aucune interruption ou modification de production effectuée. Les tests réels du nouveau code restent en attente de ce déploiement contrôlé.

## Autorisation et essai borné de suspension

Autorisation reçue. Suite complète relancée : 4 949 tests, 4 925 succès, 0 échec, 24 ignorés. Le patch Gateway passe `git apply --check` sur une copie fraîche du code déployé, conservant les changements storyboard concurrents.

Les deux crons concernés (84 et 159) ont été enregistrés avec leurs empreintes et états, suspendus transactionnellement pendant un essai borné de 90 secondes, puis rétablis. Lecture indépendante finale : les deux sont actifs avec leurs empreintes initiales. Aucun autre cron modifié ; aucune tâche tuée ; aucun service redémarré.

Le script a rencontré une erreur à l'écriture du reçu final car le helper écrit en création exclusive. Cette erreur survenait APRÈS la restauration ; une lecture fraîche a confirmé les états restaurés. Le script local a été corrigé pour écrire un reçu final distinct, sans relancer la mutation.

La file ne s'est pas vidée : 3 travaux initialement différés puis 2 en attente et 1 opération active. Vérification réelle du magasin avec HMAC via la classe déployée : trois checkpoints durables non terminaux valides, positions `next` 44, 30 et 27. Cela ne prouve pas une interruption coordonnée de l'opération active ; le garde de redémarrage n'a pas été contourné. Le nouveau code n'est pas déployé, et ses reprises réelles ne sont pas testées. Il reste à organiser l'arrêt coordonné/vidange des tâches déjà admises, pas seulement l'arrêt des planifications.

## Verrou applicatif de maintenance — composant isolé

Ajout de `maintenance-fence.js` et cinq tests passants : barrière synchrone d'admission, comptage des admissions asynchrones en cours, vérification des empreintes exactes des jobs durables avant/après lecture du magasin, échéance courte avec annulation, et contrôle final synchrone avant fermeture de l'entrée. Une file sauvegardée peut être admissible ; une opération ou lecture active ne l'est pas.

IMPORTANT : ce composant n'est pas encore branché dans `index.js`. Aucun endpoint de maintenance ni hook d'admission n'a été activé. Il ne protège donc pas encore le Gateway réel. Le raccord doit englober les sélections asynchrones, les nouvelles requêtes de travail, la vérification HMAC du magasin et la fermeture atomique de l'admission. Ne pas assouplir le préflight existant sur la seule égalité des nombres de tâches et de sauvegardes.

## Raccordement local du verrou (étape suivante)

Le constat de composant isolé ci-dessus est désormais dépassé pour le code local, pas pour la production. `index.js` installe `maintenance-http.js` uniquement si `GATEWAY_MAINTENANCE_ENABLED=true` (désactivé par défaut). Les routes prepare/cancel/commit sont authentifiées et sans cache HTTP ; les nouvelles requêtes de travail sont clôturées par une barrière courte, et une nouvelle lecture annule une maintenance non encore engagée. La validation compare les empreintes des jobs en file aux checkpoints vérifiés par `storyboardStore.load()` ; les ensembles doivent correspondre exactement, pas seulement les comptes.

Les sélections asynchrones transcription/OCR, la traduction, les mesures de routes et la capture passive tiennent maintenant des réservations du verrou. La sélection refait le contrôle après l'attente du fournisseur. Le commit revalide le magasin puis ferme le listener dans la même section synchrone que le dernier contrôle. Les états en cours/lecteurs empêchent la validation. Expiration/annulation réveille les files.

74 tests ciblés passent (maintenance, HTTP réel, priorité viewer, activité différée et caches). Le test HTTP vérifie l'authentification, les refus temporaires, la priorité d'une lecture qui invalide le jeton précédent, le refus en cas d'opération active et la fermeture du listener. Ce n'est pas un test du processus de production. La dernière suite complète verte précède ce raccordement et ne doit pas être présentée comme une validation complète de celui-ci.

Aucun flag activé, endpoint déployé ou processus de production redémarré. L'installation initiale sur l'ancien Gateway, qui ne possède pas encore cette barrière, reste à organiser et valider ; ne pas prétendre que le nouveau protocole peut déjà y être appelé. La restauration effective des vignettes et les reprises des formats restent à mesurer après installation.

## Validation complète et candidat isolé

- Suite complète après raccordement : 4 955 tests, 4 931 succès, 0 échec, 24 ignorés, 362 s. Journal `C:/Users/AdrienHernandez/.codex/tmp/resume-cache-maintenance-full-20260916.log`.
- Deux tests supplémentaires du code réel des fonctions de snapshot passent séparément : réservations actives prises en compte, empreinte identique entre progression mémoire et checkpoint restauré, divergence détectée sans exposition des identifiants privés.
- Le patch a été réconcilié sur la copie de production. Le conflit de contexte au démarrage provenait du chargement des storyboards ajouté depuis la base ; cette restauration reste conservée. Syntaxe de l'index réconcilié validée avec le Node du Gateway.
- Image candidate construite depuis l'image actuellement déployée, avec seulement six fichiers remplacés/ajoutés : index, cache HLS privé, profil canonique, sous-titres privés, verrou et HTTP de maintenance. Tag `norva-media-gateway:resume-maintenance-candidate-20260916`. Ce tag n'est pas le service de production.
- Test du vrai processus candidat dans un conteneur jetable sans réseau, sans secrets ni volumes de production : checkpoint synthétique chargé, préparation et commit de maintenance acceptés, arrêt puis second démarrage, même tâche retrouvée. Deux cycles réussis. Cela ne prouve pas la reprise d'une extraction fournisseur ni l'achèvement d'un sprite.
- Vérification fraîche, en lecture seule, des checkpoints et images de production : trois tâches, respectivement 108/194, 95/195 et 76/195 images. Tous les JPEG attendus sont présents avec marqueurs complets ; aucune progression sauvegardée ne référence une image manquante. Ces nombres sont un instantané et continuent d'évoluer.

Le service actif n'a pas été arrêté, aucun cron changé dans cette reprise et aucun nouveau flag activé. Le préflight de l'ancien service refuse toujours sa file non vide. Le candidat vérifie le nouveau protocole, mais ne donne pas rétroactivement ce protocole à l'ancien processus : l'installation initiale coordonnée reste distincte de ces preuves. Les tests fournisseur stockage/hit/120 s avec sous-titres ne sont pas encore réalisés sur le nouveau code.

## Pilote réel — validation suivante du 16 septembre

Les paragraphes précédents sont chronologiques. Un Gateway distinct et deux répliques Edge ont depuis été activés pour le seul propriétaire pilote. Le Gateway principal est inchangé ; aucune généralisation. L'installation initiale et la restauration des tâches du Gateway principal ne sont pas validées par ces tests.

- MKV Atlas CZ Promax, sous-titres HLS : 135,487 s de lecture sans attente à froid ; stockage de 13 385 424 octets ; reprise avec hit, environ 49 s disponibles et préparation Gateway en 1,783 s. Plus de 137,8 s de lecture sans attente, sous-titres actifs (6 changements de cues), une image perdue. Un premier essai de réouverture a échoué avant le Gateway ; le nouvel essai a réussi, sans cause établie pour cet échec.
- MPEG-TS Le Jardinier PL Promax : première lecture à 17,974 s, 132,812 s lues en 132,842 s sans attente. Reprise avec hit et 48 s disponibles, préparation Gateway 2,335 s, première lecture 5,384 s. Transitions initiales brèves (attente ~0,034 s et pause ~0,56 s), puis 184,760 s lues sur 187,477 s sans nouvelle attente, aucune image perdue.
- Correction du diagnostic : Atlas ALB Promax est réellement MP4/H.264/AAC stéréo selon le profil exact. Le nom interne du broker `finiteMkvSeekBroker` ne prouve pas un conteneur Matroska. L'affirmation précédente de mauvais libellé était incorrecte pour cette variante.
- Deux blocages natifs corrigés : validation de l'URL signée compatible avec le préfixe HTTPS configuré du pilote (origine et chemin exacts, sans assouplissement global), et admission Gateway du hash propriétaire pilote, auparavant limitée à la route fournisseur historique. Les proxies ne sont pas modifiés.
- Ces deux correctifs sont déployés sur le pilote ; 15 tests natifs/transport et 45 tests cache/maintenance/visibilité passent après ces modifications. La suite complète verte citée plus haut précède ces deux derniers changements.
- Atlas ALB natif, cache froid : première lecture à 9,260 s à la position 179 s ; 195,266 s lues ensuite sans événement d'attente supplémentaire, 2 images perdues sur 4 787 au relevé.
- Réouverture de la même variante à 396 s : première lecture à 7,134 s ; compteur Gateway passé de zéro à 1 hit et 8 323 072 octets réutilisés, identité revalidée. Contrôle terminé : 145,956 s lues en 146,012 s après `playing`, sans nouvel événement waiting/stalled/seeking ; une image perdue sur 3 532. Lecture quittée normalement par Films. Les erreurs initiales viennent des éléments media remplacés avant la lecture native, pas d'une interruption pendant cette fenêtre.

Opplex : ne pas confondre les variantes `American Siege` et `American-Siege`. Le second profil est MP4 H.264/AAC six canaux et n'est pas éligible à la politique native stéréo stricte actuelle. La panne `PROVIDER_REQUEST_FAILED` du premier n'est pas déclarée corrigée par les succès Promax.

## Enquête Opplex après libération du compte

- American Siege FR/EN MKV : erreur 502 reproduite à la création de session. Un diagnostic interne strictement numérique a été ajouté au refus de préparation du flux (test passant pour valeurs valides et invalides, aucun URL ou identifiant ajouté). Déployé seulement sur le pilote avec maintenance prepare/commit, conteneur précédent conservé, Gateway principal inchangé.
- Nouvel essai exact : `upstreamStatus: 404, retryable: false`. Le fichier demandé est introuvable chez le fournisseur à cet instant. Ce résultat ne prouve pas le retrait définitif de son catalogue et ne justifie pas une suppression automatique sur un seul 404. Le 502 public masquait le statut amont ; le fichier distant n'est pas réparé par le diagnostic.
- American-Siege anglais MP4 : première lecture 21,700 s, préparation Gateway 5,814 s. 121,314 s lues après le premier playing, aucune attente supplémentaire et zéro image perdue sur 2 913. Profil AAC six canaux, chemin HLS. Identité fournisseur `weak-or-absent` : la réutilisation intersession du cache ne peut pas être certifiée pour ce fichier. Lecture fermée normalement avant la maintenance.
- Atlas anglais, groupe MultiSub, MKV Opplex : démarrage à froid 4,794 s ; préparation Gateway 2,940 s. Calage initial d'environ 19 ms puis 140,577 s lues, aucune nouvelle attente, zéro image perdue sur 3 381. Reprise demandée à 140 s, offset Gateway confirmé identique : premier playing 13,666 s, préparation Gateway 11,816 s. Aucun hit ni stockage HLS/bytes, rejet d'identité mesuré : `weak-or-absent`. Ne pas confondre cette reprise fonctionnelle avec une reprise depuis le nouveau cache.
- Validation locale après ajout du diagnostic : 43 tests ciblés passants, `git diff --check` sans erreur. Le diagnostic seul est ajouté au pilote ; aucune nouvelle règle de routage, aucun contournement de validation d'identité et aucune suppression du catalogue.
- Fin du contrôle Atlas repris : 155,248 s de média, aucune attente après le calage initial (~24 ms), zéro image perdue sur 3 733. Lecture fermée normalement. Les limites Opplex sont désormais distinguées : fichier FR/EN indisponible (404), MP4 lisible mais lent au départ, MKV rapide à froid mais reprise sans cache de segments certifié. Ne pas généraliser ces deux titres à tout le catalogue.

## Reprise Claude Code — vérification d'état et essais du 16 septembre (soir)

Reprise du relais `handoff-claude-vod-20260916.md`. Aucun redémarrage du Gateway principal, aucun changement de proxy, de compte, d'allowlist ou de flag. Cache toujours limité au pilote et au hash propriétaire.

### Contrôle avant toute action

- Worktree `codex/resume-cache-all-formats-20260916`, base `8d15f8be`, 36 entrées non commitées conformes au relais ; aucun travail perdu.
- Gateway principal : image `sha256:ecced97c…` identique au relais, `RestartCount=0`, démarré à 09:46:27Z. `mainUnchanged: true`. Le tag `norva-media-gateway:storyboard-compression-20260916` désigne cette même image ; ce n'est pas un redémarrage.
- Pilote `norva-resume-cache-pilot-20260916`, image `provider404-pilot-20260916`, `RestartCount=0`, routage pilote actif. Deux répliques Edge saines. Générations précédentes toujours conservées.
- Principal : `activeSessions 0`, `rawPumpCount 0`, `viewerPlaybackActiveLocally false`, file transcription 8, `transcribeBusy true`, un processus ffmpeg réel (vérifié via `/proc`, `ps` absent de l'image).
- Checkpoints storyboard : six tâches non terminales, 156/24/120/30/126/30 images, **sauvegardées == intactes** (486). Identique au relais.
- `storyboard-checkpoint-readonly.cjs` s'exécute correctement via Node stdin dans le conteneur déployé. Son échec générique antérieur ne se reproduit pas ; son `catch` masque toutefois toujours la cause réelle.
- Composition de la file (item 5 du relais) : `languageForegroundWork` donne `activeOperations 1`, `pendingPriorityJobs 1`, `deferredBackgroundJobs 7`, et `storyboardDurability.pending 6`. Les deux travaux non-storyboard sont donc **un différé de fond et un travail prioritaire non différable**, plus une opération en cours hors file. Ni l'un ni l'autre n'est couvert par les checkpoints storyboard : un redémarrage les perdrait. À traiter avant l'installation initiale du verrou.

### Royalteen — Espagnol · ES · Promax 4K OTT · MP4 (groupe 7 versions) — SECTION CORRIGÉE

> **AVERTISSEMENT — lire la section « Correction du 16 septembre (fin de soirée) » avant d utiliser ces chiffres.**
> L essai décrit ci-dessous n a PAS lu la variante annoncée : le bouton « Lire » retenu par le script de mesure
> était celui du héros de la page d accueil. Les mesures qui suivent appartiennent au titre du héros, pas à
> Royalteen ES, et la conclusion « contenu non conforme au titre » est retirée.

Variante sélectionnée explicitement, une seule entrée `active` vérifiée avant le clic. Le bouton est passé à « Lire » : **départ réel à zéro**, pas une reprise.

- Gateway : `mode remux`, `requestedSeekOffset 0`, `actualStartOffset 0`, `codecProfileSource null`, `inputProbeMode full`, `ffmpegReadyMs 5526`, `totalMs 20080`, 4 segments / 16 s, `sustainedMediaProductionRateX 20`, `stoppedConflictingSessions 0`.
- Navigateur : premier `playing` à **22,428 s**. Ensuite **239,331 s de média en 240,056 s d'horloge**, **aucun** événement waiting/stalled/seeking/error, **0 image perdue sur 5 747**. Fermeture normale à 265,119 s.
- Élément `video` caché avec `error 4` et src vide présent tout du long : ce n'est pas une coupure du lecteur actif.

**Cause racine du démarrage lent, mesurée.** Le journal pilote indique `codec probe skipped: Codec probe timeout`. `codecProfileMs` vaut 14 514 ms = `codecProbeTimeoutMs` (12 000) + `codecProfileProbeReleaseWaitMs` (2 500). `probeStats` : 2 tentatives, **0 succès, 2 échecs**, `lastFailure.detail = codec_probe_timeout` ; `codecProfileCacheSize 0` ; `fileSizeBytes null`. La sonde consomme donc tout son délai puis ne rend rien, à chaque démarrage, et le profil n'est jamais appris pour cette source. C'est ce qui force `remux`, écarte le chemin MP4 natif et produit `exactSubtitleHls.reason = profile-incomplete`. L'essai Codex de 19:03 montre la même valeur (14 519 ms) : le comportement est reproductible, pas ponctuel.

**Cache : aucun engagement.** Après fermeture normale, tous les compteurs restent à zéro, y compris `rejectedIdentity: 0` — le cache n'a pas été refusé, il n'a pas été atteint. Sans taille de fichier ni profil complet, la source n'a pas d'identité forte et la lecture se fait normalement sans cache. C'est le repli prévu et il ne doit pas être affaibli pour obtenir un hit.

**Contenu non conforme au titre.** La vidéo rendue n'est pas Royalteen : film d'époque, habillage `mk2 films`, incrustation de chaîne arabophone, scène de barque en mer. Après la session, « Continuer à regarder » fait apparaître **« Portrait de la jeune fille en feu »**. La source ES/Promax/MP4 rattachée au groupe Royalteen ne sert donc pas Royalteen. À traiter comme le 404 d'American Siege : constat documenté, **pas** de suppression automatique ; la correction passe par une vérification catalogue/source, source exacte par source exacte, pas par le groupe TMDB.

### Session ouverte par erreur — divulgation

Un clic sur la carte « Royalteen » de « Continuer à regarder » a démarré une session automatiquement au lieu d'ouvrir la fiche (`activeSessions 1`). Elle a été fermée immédiatement. Une lecture DOM faite pendant la transition a rapporté une variante erronée ; ne pas s'y fier. Cette session a néanmoins stocké 20 fenêtres / 25 427 968 octets avec `confirmed 1`. La carte de ce rail reprend en réalité la variante **Anglais · 24 ST · Multi · Opplex IPTV · MKV**.

### Reprise Opplex MKV — profil fourni par la requête

- Gateway : `requestedSeekOffset 23`, `actualStartOffset 23`, `codecProfileSource "request"`, `inputProbeMode "known-fast"`, **`codecProfileProbeRan false`, `codecProfileMs 0`**, `slotReleaseWaitMs 0`, `ffmpegReadyMs 6779`, **`totalMs 6835`** contre 20 080 ms pour la sonde expirée. L'écart d'environ 13,2 s vient de la sonde évitée, **pas** du nouveau cache.
- Navigateur : `loadedmetadata` 8,481 s, `canplay` 8,656 s, mais `play` seulement à 32,545 s. Cet écart d'environ 23,9 s est côté client alors que le Gateway était prêt à 6,835 s ; cause non établie, possiblement liée à l'automatisation. À ne pas présenter comme un temps de démarrage Gateway.
- Une attente réelle à 84,731 s (`ct` 51,732), durée environ 3 ms. Ensuite 102,998 s d'horloge pour 102,950 s de média, soit 1:1. Total 175,919 s de média à la fermeture, **73 images perdues sur 5 287** (~1,4 %), nettement au-dessus du run Promax MP4 ci-dessus.
- Compteurs finaux octets : `files 1`, `bytes 25 427 968`, **`storedWindows 54`, `evictions 49`, `confirmed 2`, `rejectedIdentity 0`, `hits 0`, `reusedBytes 0`**. Cache HLS entièrement à zéro.

**Lecture honnête de ce résultat.** Cette source Opplex a bien une identité forte et revalidée (`confirmed 2`, aucun rejet), contrairement aux deux titres Opplex du relais qui étaient `weak-or-absent` : le constat « Opplex sans identité fiable » ne se généralise pas. Mais 54 fenêtres stockées pour 49 évictions et **zéro hit, zéro octet réutilisé** : sur ces deux sessions, le cache d'octets a stocké puis évincé sans jamais servir de réutilisation. Aucune amélioration de démarrage ne peut lui être attribuée ici.

### État préservé après les essais

- Checkpoints storyboard inchangés et intacts : 156/24/120/30/126/30, `pending 6`.
- Gateway principal : même image `sha256:ecced97c…`, `RestartCount=0`. File transcription passée de 8 à 9 (admission normale).
- `activeSessions 0` sur le pilote, aucune lecture d'essai laissée active, `pilotRouted true`, `mainUnchanged true`.

### Ce que ces essais ne prouvent pas

- Aucun hit du nouveau cache n'a été obtenu dans cette session. Les hits antérieurs (Atlas ALB, Atlas CZ, Le Jardinier PL) restent les seules preuves de réutilisation, et elles ne couvrent pas les catalogues.
- Le seuil de 10 s reste prouvé uniquement sur Atlas ALB natif. Royalteen ES démarre en 22,4 s, et sa cause est identifiée mais non corrigée.
- L'installation initiale du verrou sur le Gateway principal n'est toujours pas faite ; les deux travaux non-storyboard identifiés ci-dessus doivent être traités avant.

## Correction du 16 septembre (fin de soirée) — erreur de sélection, concurrence fournisseur, évictions

Cette section corrige la précédente. Aucun redémarrage du Gateway principal, aucun changement de proxy, de compte ou de flag.

### 1. Erreur de mesure : le bouton « Lire » du héros

Le script de mesure choisissait le bouton de lecture ainsi :
`Array.from(document.querySelectorAll('button')).find(b => /^(Reprendre|Lire)$/i.test(...))`.
Sur `norva.tv/app#movies`, l'application ouvre en réalité la page **Accueil**, dont le héros est un carrousel
portant lui aussi un bouton « Lire », **premier dans l'ordre du document**. Le `find` retournait donc le bouton du
héros et non celui de la fiche. Les deux lectures « inattendues » s'expliquent entièrement ainsi :

- session de 19:23 → héros du moment = **Portrait de la jeune fille en feu** ;
- session de 19:58 → héros du moment = **Savaş Vadisi**, titre turc de **Hacksaw Ridge** (confirmé : en-tête du
  lecteur « Hacksaw Ridge », durée 2:19:04, `app.pages.watch.versions` contenant sept variantes Hacksaw Ridge dont
  « Tu ne tueras point (True FR) 2016 »).

**Conséquences.** La conclusion « la source ES/Promax/MP4 du groupe Royalteen ne sert pas Royalteen » est **retirée** :
elle reposait sur une erreur de sélection, pas sur le fournisseur. Les mesures 22,428 s / 239,3 s / sonde à 14 514 ms
appartiennent au titre du héros, **pas** à Royalteen ES. Aucun défaut de catalogue n'est établi pour ce titre.

**Vérification du mapping réel.** `app.pages.movies.currentMovieVersions` pour le groupe Royalteen contient sept
variantes toutes authentiquement Royalteen (`Royalteen`, `Royalteen (2022)`, `AR ▎ Royalteen`, `ES ▎ Royalteen`,
`SW ▎ Royalteen`, `TR ▎ Royalteen`). Le catalogue est correct.

**Primitive de traçage adoptée.** Les libellés sont mutables — la variante est passée de
« Espagnol · ES · Promax 4K OTT · MP4 » à « ES / NO · 1 ST · ES · Promax 4K OTT · MP4 » entre deux essais, par
enrichissement. Un essai se trace désormais par `rawTitle` + `streamId` + `sourceId` relevés dans
`app.pages.watch.versions[versionIndex]` **après** ouverture, et non par le libellé affiché.
`/debug/sessions` n'expose aucune URL fournisseur : la corrélation passe par l'hôte observé et l'identifiant de session.

### 2. Concurrence fournisseur principal/pilote — mesurée, pas supposée

Le relevé précédent n'avait pas établi le fournisseur du travail actif du principal avant de lancer Promax. C'est corrigé.

Un observateur en lecture seule a échantillonné toutes les 2 s les **noms d'hôtes** des processus fournisseur des
deux conteneurs, pendant 900 s (19:49 → 20:04, plus de 420 échantillons) :

- principal : `r656.dad` en continu, plus `super8k.top` sur 5 échantillons ;
- pilote : `line.4k-beast.top` pendant la phase ffprobe, puis des adresses de boucle locale ;
- **`OVERLAP` = 0 sur la totalité de la fenêtre.**

`line.4k-beast.top` est donc l'hôte de **Promax 4K OTT**, distinct des hôtes du principal. Aucune concurrence
fournisseur n'a eu lieu, ni pendant ces essais ni pendant ceux de la soirée sur Promax.

La comparaison porte sur l'hôte, pas sur le compte. Le code note qu'un hôte peut être partagé par plusieurs
locataires (`providerSlotKeyFromUrl` : hôte + utilisateur + mot de passe) : comparer les hôtes est donc **plus
conservateur** que comparer les comptes, et convient à la contrainte.

**Limite honnête de l'instrument.** Il lit les lignes de commande de `/proc`, donc il voit ffprobe et ffmpeg, mais
**pas** les sockets ouverts par le broker à l'intérieur du processus Node. La preuve est directe pour la phase de
sonde ; pour la phase broker elle reste indirecte. Une observation au niveau socket (`/proc/net/tcp`) serait
nécessaire pour la compléter.

### 3. Royalteen ES — essai réellement tracé

Identité vérifiée avant mesure : `rawTitle` **`ES ▎ Royalteen`**, conteneur **mp4**, `sourceId` **900001**
(Promax 4K OTT), `streamId` **1014841**. Session **`7125d64c-fc09-42b4-890f-eef293845043`**. Hôte observé
`line.4k-beast.top`. Sélection faite au vrai clic souris sur la variante puis sur `movies.primaryActionBtn`
(bouton de la fiche, jamais un `find` global).

- Gateway : `mode remux`, `requestedSeekOffset 198`, `actualStartOffset 198` (exact), `totalMs` **30 120 ms**,
  `ffmpegReadyMs` 30 070, `firstSegmentReadyMs` 22 084.
- **Aucune sonde** : `codecProfileProbeRan false`, `codecProfileMs 0`, `codecProfileSource "request"`,
  `inputProbeMode "known-fast"`. Le profil est fourni par la requête ; le coût de 14,5 s ne s'applique pas ici.
- Conteneur réel : AAC **6 canaux**, `audioMode transcode`, `videoEncoder vaapi`, `videoDecode software`.
- **`sustainedMediaProductionRateX` = 1,185** — la production dépasse à peine le temps réel, contre 20 pour le
  fichier du héros. C'est là qu'est le coût de ce titre, pas dans la sonde.
- Identité forte : `providerValidatorEvidence "strong-etag"`, `finiteMkvSeekProviderIdentityBound true`.
- Navigateur : `canplay` à 34,168 s mais `play` seulement à **82,373 s**, premier `playing` à **82,422 s**.
- Après `playing` : **184,341 s de média en 184,949 s d'horloge, aucun événement waiting/stalled/seeking/error,
  6 images perdues sur 5 535.** Les deux minutes de fluidité sont atteintes.

**Écart client récurrent.** L'intervalle `canplay` → `play` est apparu à 23,9 s puis 48,2 s sur deux titres
différents, alors que le Gateway était prêt. Cause non établie ; possiblement l'automatisation, possiblement une
politique de tampon de démarrage côté lecteur. À ne pas imputer au Gateway et à ne pas présenter comme un temps de
démarrage serveur. C'est la piste à instruire avant toute optimisation de démarrage.

### 4. Sonde de codecs — cause isolée, correctif non appliqué

Le timeout de 14,5 s n'est pas une propriété du fichier : il dépend du **mode de sonde**.

- En `inputProbeMode: "full"`, ffprobe reçoit **l'URL fournisseur brute** (`probeCodecProfileUncached`), avec
  `-probesize 2 000 000` et `-rw_timeout 8 000 000`. Le timeout externe est `CODEC_PROBE_TIMEOUT_MS` = 12 000 ;
  la mesure 14 514 ms = 12 000 + 2 500 de libération de slot.
- Le `rw_timeout` de 8 s n'a jamais été atteint : ffprobe **lisait** sans jamais conclure. Ce n'est donc pas un
  fournisseur muet.
- Le `windowTrace` du broker montre le motif décisif sur ce type de fichier : requête 1 sur les octets 0→262 143,
  puis requête 2 sur **2 319 372 676→2 319 450 111** d'un fichier de **2 324 844 149** octets. L'index est **en fin
  de fichier** (`moov` en queue pour un MP4). Une sonde limitée aux deux premiers mégaoctets ne peut pas le trouver.
- Le broker résout la redirection **une fois** (`providerRedirects: 1`, `resolvedTargetReuses: 17/22`) ; ffprobe en
  mode `full` ne bénéficie pas de cette cible résolue.

**Direction de correctif, non implémentée.** Faire porter la sonde sur le chemin déjà capable de plages et de
redirection résolue (broker/boucle locale, comme le fait `known-fast`) au lieu de l'URL fournisseur brute, ou lui
transmettre la cible résolue. Cela **n'affaiblit ni** l'analyse des codecs — ffprobe lit les mêmes octets réels —
**ni** la validation d'identité, qui reste `strong-etag` + taille. Aucune modification n'a été déployée ; à valider
d'abord sur un fichier reproduisant le timeout, ce qui suppose de retrouver un titre encore en mode `full`.

### 5. Les 123 stockages pour 109 évictions, et l'absence de réutilisation

Mécanisme lu dans le code déployé, `strict-lid-range-reuse.js`, fonction `trim()` :

```
while (entry.bytes > this.perFileBytes || entry.fragments.length > this.maxFragments) { ... evictions++ }
```

Les victimes sont triées par `a.priority - b.priority || a.used - b.used` : **les extraits intérieurs partent en
premier**, l'en-tête et l'index de queue sont préservés (commentaire explicite du code). Budgets en production
(`index.js`) : `perFileBytes` 32 MiB, `maxFragments` 64, `maxBytes` 128 MiB, `ttlMs` 30 min,
`maxRetainedWindowBytes` 8 MiB. `skippedSequentialWindows` = 0 : aucune fenêtre n'a dépassé 8 MiB.

État final : 2 fichiers, 52 055 670 octets, 123 fenêtres stockées, 109 évictions, `confirmed 4`,
`rejectedIdentity 0`, **`hits 0`, `reusedBytes 0`**.

La réutilisation dépend de `priorRanges`, capturé à `begin()` — les fragments **retenus par une session
antérieure** — et `read()` n'aboutit que si un fragment **couvre l'offset demandé** :

```
const prior = fragments.priorRanges.find(f => f.start <= start && f.end >= start);
```

Or les reprises mesurées visaient 23 s puis 198 s, c'est-à-dire des positions **intérieures**, précisément la classe
de fragments que `trim()` évince en premier. Stocker 123 fenêtres et n'en conserver que l'en-tête et la queue ne
produit donc aucun hit sur une reprise intérieure. **C'est une explication cohérente avec le code et les compteurs,
pas une démonstration** : les coordonnées réellement retenues n'ont pas pu être relevées, `/debug/` n'exposant ni
`priorRanges` ni les fragments. Une introspection en lecture seule des plages retenues est nécessaire pour trancher,
et reste à ajouter.

**Non démontré à ce stade :** une reprise réutilisant réellement les octets conservés. Zéro hit sur toutes les
sessions de la soirée. Les seuls hits connus restent ceux du relais (Atlas ALB, Atlas CZ, Le Jardinier PL).

### 6. Cache non engagé pour un fichier sans taille connue — preuve par le code

`FinitePlaybackRangeReuse.begin()` commence par :

```
if (!/^[a-f0-9]{64}$/.test(String(ownerKey || '')) || !sourceUrl
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1) return null;
```

Un `fileSizeBytes` inconnu renvoie donc `null` et le cache **n'est jamais construit** : cela explique des compteurs
entièrement à zéro, `rejectedIdentity` compris, sans qu'aucun refus d'identité n'ait eu lieu. Le repli en lecture
normale est le comportement voulu et n'a pas été affaibli.

### 7. État préservé

`activeSessions 0`, `pilotRouted true`, `mainUnchanged true`. Gateway principal : même image `sha256:ecced97c…`,
`RestartCount=0`, six checkpoints storyboard `pending 6`, `viewerPlaybackActiveLocally false`. File transcription
8 → 10 (admission normale). Aucune lecture d'essai laissée active.

## Suite du 16 septembre — délai `canplay → play`, réutilisation démontrée, limites de la surveillance

Aucun redémarrage du principal, aucune généralisation, activation toujours limitée au pilote.

### 1. Délai `canplay → play` : attente applicative délibérée, ni autoplay ni automatisation

`HTMLMediaElement.prototype.play` a été instrumenté **avant** toute lecture (horodatage, pile d'appel, promesse,
`visibilityState`, `document.hasFocus()`, `navigator.userActivation`). Essai tracé sur `ES ▎ Royalteen`
(`streamId 1014841`, `sourceId 900001`) :

| t (ms) | événement |
|---|---|
| 26 126 | `loadstart` (src posé) |
| 27 214 | `canplay` / `canplaythrough`, `readyState 4`, `buffEnd` **13,58** |
| 61 770 | **`play()` CALLED**, `buffEnd` **96,12**, `vis: visible`, `focus: true` |
| 61 773 | `play` |
| 61 908 | `playing` + **`play() RESOLVED`** |

Conclusions, chacune appuyée par une observation :

- **Ce n'est pas la politique d'autoplay** : `play()` est *resolved*, jamais *rejected*, et `handleAutoplayError`
  n'est pas atteint.
- **Ce n'est pas un artefact d'automatisation** : l'unique appel vient de l'application
  (`WatchPage.js:6413`), pas du script de mesure, et l'onglet est resté `visible` et *focused* du début à la fin.
- **C'est une attente applicative voulue.** `gatewayStartupBufferOptions()` renvoie, faute de politique de démarrage
  éligible : `{ minimumSeconds: 96, timeoutMs: 360000 }`, et `waitForGatewayStartupBuffer()` boucle tant que
  `bufferedAhead < minimumSeconds`. La lecture démarre à `buffEnd` 96,12 : le seuil de 96 s est atteint, à la
  seconde près. Le commentaire du code assume ce choix (« fast opening burst followed by sustained starvation,
  51s waiting in a 120s test »).

Côté Gateway pour cette session : `startupPolicy = { protocol: 2, eligible: false, pipeline: "audio-transcode",
targetBufferSeconds: null, minimumEncodeRateX: 1.5, observedEncodeRateX: 20, reason: "finite-mp4-buffer-observation" }`.
La politique est donc **inéligible** et `targetBufferSeconds` nul, ce qui force le repli profond. Le chemin
`adaptive` (admission anticipée sur croissance mesurée) ne s'applique pas : il exige
`reason === 'encode-rate-below-minimum'`, ce qui n'est pas le cas ici.

**Décomposition du démarrage** (essai tracé) : ~26,1 s application + Edge + création de session ;
`totalMs` Gateway 7 319 ms dans cette session ; ~1,1 s jusqu'à `canplay` ; puis **34,6 s de remplissage du
tampon imposé**. Le poste dominant n'est ni la sonde ni ffmpeg.

**Variabilité mesurée sur le même fichier** : `observedEncodeRateX` 1,185 puis 20, `totalMs` 30 120 puis 7 319.
Cette instabilité va dans le sens de la réserve prudente ; elle interdit de conclure qu'un seuil plus bas serait
sûr sur la seule base d'un essai rapide. Piste à instruire : émettre un `targetBufferSeconds` proportionné quand
l'observation soutient durablement un débit élevé, plutôt que le repli fixe à 96 s. **Non implémenté.**

### 2. Évictions : règle de priorité prouvée par le code

Dans `remember()` :

```
priority: offset < 256 * 1024 || until > fileSizeBytes - 1024 * 1024 ? 1 : 0
```

Seuls **les 256 premiers Kio et le dernier Mio** sont de priorité 1. Tout le reste est priorité 0. `trim()`, appelé
à chaque `remember()`, trie les victimes par `a.priority - b.priority || a.used - b.used` : **l'intérieur part
toujours en premier**. Avec `perFileBytes` = 32 Mio sur un fichier de 2 324 844 149 octets pour 6 534 s, la fenêtre
intérieure conservée ne couvre qu'environ **les 115 dernières secondes de média réellement lues**.

C'est l'explication complète des échecs précédents : `read()` exige un fragment **couvrant l'offset demandé**, et
les reprises visaient 23 s puis 198 s, hors de la fenêtre conservée. 233 fenêtres stockées pour 217 évictions
n'ont donc pu produire aucun hit.

### 3. Réutilisation réelle — démontrée

Prédiction tirée de la règle ci-dessus : une reprise **à l'endroit où la session précédente s'est arrêtée** tombe
dans la fenêtre conservée. Vérifié.

Position sauvegardée `900001:1014841` = **569 s**. Reprise au vrai clic sur le bouton de la fiche.
Session **`98b4b492-7b52-4b95-8f3f-2196c600a1ee`**, `requestedSeekOffset 569`, `actualStartOffset 562,633`
(recalage sur image-clé).

- Compteurs : **`hits` 0 → 1**, **`reusedBytes` 0 → 262 144**, `confirmed` 6, `rejectedIdentity` 0.
- Session : **`resumeRangeReusedBytes: 262144`**.
- `windowTrace`, preuve du mécanisme : fenêtre 1 = octets **0 → 65 535** (lecture courante de validation, 64 Kio),
  puis fenêtre 2 = octets **262 144** → 8 388 607. La requête fournisseur **reprend exactement à 262 144** : les
  256 Kio d'en-tête n'ont pas été redemandés, ils viennent du cache.

**Portée exacte, à ne pas surinterpréter.** Les octets réutilisés sont **l'en-tête protégé** (priorité 1), pas la
fenêtre intérieure de reprise : la cible de seek a tout de même exigé une lecture fournisseur fraîche
(fenêtre 4, à ~297 Mo). Le gain est donc de 256 Kio et d'une ouverture évitée, pas d'une reprise servie par le cache.
La validation d'identité n'est pas contournée : une lecture courante de 64 Kio est drainée **avant** toute
réutilisation, conformément au protocole.

**Fluidité après cette reprise** : **156,000 s de média en 156,000 s d'horloge, rapport 1,000, aucun événement
waiting/stalled/error, 7 images perdues sur 4 696** sur la fenêtre mesurée (20 perdues sur 7 199 au total).

### 4. Surveillance de la concurrence : améliorée, toujours pas une garantie

Un second observateur lit `/proc/net/tcp{,6}` dans les deux conteneurs et rapporte les connexions ESTABLISHED
sortantes (adresses et ports seulement). Il voit donc les sockets du broker Node, invisibles pour le scan de
lignes de commande.

Résultat : **22 échantillons de chevauchement**, par exemple `main=116.202.83.149 pilot=116.202.83.149`.

**Ce chevauchement ne prouve pas une concurrence fournisseur.** Tout le trafic fournisseur passe par le pool de
proxies (`providerProxy: true`, `providerProxyPool: 5`) : les adresses observées sont des **sorties de proxy**
partagées, pas des adresses de fournisseur. Deux fournisseurs différents peuvent emprunter la même sortie.

**Angle mort confirmé, et il est réel.** Pendant cette session, le principal présentait `transcribeBusy: true`,
file 10, **et aucun ffmpeg fournisseur** : il travaillait via son broker Node. Dans cet état, sa cible fournisseur
n'est observable ni par la ligne de commande ni par le socket (qui ne montre que le proxy). **L'absence de
concurrence fournisseur n'est donc établie que pour les phases où le travail du principal est visible en ffmpeg**
(`r656.dad`, `super8k.top`, distincts de Promax `line.4k-beast.top`). Pour les phases broker du principal, elle
n'est ni démontrée ni infirmée. La combler exigerait une introspection côté principal, donc un déploiement sur le
principal — hors périmètre.

### 5. Ce qui reste non fait

- **Comparaison des deux chemins de sonde sur le même fichier, à conditions égales** : non réalisée. Toutes les
  sessions récentes passent en `known-fast` ou reçoivent le profil par la requête ; aucun titre en mode `full`
  n'a été retrouvé pour reproduire le timeout. L'accès en fin de fichier et la redirection non résolue restent
  des éléments cohérents, **pas une démonstration complète** de la cause.
- **Conteneur réel** : le catalogue déclare `container: "mp4"` et le comportement du broker (index en fin de
  fichier) y est cohérent, mais `format_name` n'a pas été lu par ffprobe. AAC 6 canaux décrit l'audio, pas le
  conteneur ; la correction est prise en compte.
- **Introspection des plages par fragment** : non ajoutée. Les échecs et la réutilisation ont pu être expliqués
  par la règle de priorité du code et par le `windowTrace` déjà exposé, sans déployer de nouvel endpoint. Un
  relevé fragment par fragment reste souhaitable pour un audit complet.

## 17 septembre — exclusion par slot, introspection des fragments (prête, non déployée)

Aucun essai fournisseur lancé dans cette étape. Gateway principal non touché.

### 1. Correction : la sortie proxy identifie bien le compte fournisseur

La lecture précédente — « adresses partagées = simple infrastructure commune, donc pas de concurrence
fournisseur » — était **trop indulgente**. Le code dit le contraire :

- `providerAccountAffinityKey(url)` = `host` + `/` + `username` (utilisateur extrait du chemin après
  `movie`/`series`/`live`).
- `stableProxySlotIndex(accountKey, slotCount)` = FNV-1a du clé de compte **modulo** le nombre de slots :
  strictement déterministe.
- `providerRouteForKey` n'utilise une décision adaptative que si elle est *appliquée* ; or
  `providerAdaptiveRoute` rapporte `applied: 0`, `appliedAccounts: 0`, et les sessions portent
  `adaptiveRouteControlStatus: "fallback"`, `selectionReason: "shadow-mode"`. Le slot **statique** s'applique donc.

Le pool est Oxylabs, **cinq slots distingués par le port** : `disp.oxylabs.io:8001` … `:8005`.

Conséquence exploitable :

> **slot différent ⇒ compte fournisseur prouvé différent.**
> **slot identique ⇒ possiblement le même compte ⇒ à traiter comme non sûr.**

C'est une exclusion fiable qui ne demande ni identifiants, ni accès base, ni nom de compte.

Instrument : `/tmp/norva-slot-watch.py`, lecture seule de `/proc/net/tcp{,6}` dans les deux conteneurs,
n'émettant que des numéros de slot. Relevé de contrôle : le principal a été observé sur le **slot 2**, sinon sans
connexion proxy établie. Le pilote était au repos.

**Limite à ne pas masquer.** L'observateur socket précédent agrégeait les **adresses IP** et jetait les ports :
les 22 « chevauchements » alors relevés ne peuvent donc **pas** être relus rétroactivement comme un partage de
slot. Ils ne prouvent rien dans un sens ni dans l'autre. Seuls les relevés faits avec l'instrument par slot
comptent désormais.

### 2. Introspection privée des fragments — écrite et testée, **non déployée**

Ajout de `describe()` à `StrictLidRangeReuse` et à `FinitePlaybackRangeReuse`, plus une route
`GET /debug/resume-ranges` protégée par `requireGatewayAuth`, au même niveau que `/debug/sessions` et
`/debug/failures`. La route publique Caddy n'expose que `GET/HEAD/OPTIONS /sessions/*` : elle reste donc privée.

Contenu exposé, strictement : `start`, `end`, `bytes`, `priority`, `idleMs` par fragment ; `bytes`,
`fragments`, `expiresInMs`, `live` par entrée ; les budgets ; un `ref` de 12 caractères tronqué d'une empreinte
déjà hachée, suffisant pour corréler deux relevés, insuffisant pour reconstituer une source.

Jamais exposés : octets de charge utile, validateur ETag, identité d'URL effective, hash propriétaire,
identifiants, URL fournisseur.

Trois tests ajoutés (`tests/private-resume-range-introspection.test.js`) :
coordonnées et priorités exactes ; **absence de fuite** vérifiée en cherchant explicitement le hash propriétaire,
l'utilisateur, le mot de passe, l'hôte, le validateur, l'identité et l'identifiant de source dans la sortie
sérialisée ; et éviction de l'intérieur avant l'en-tête protégé.

Suite ciblée : **62 tests, 62 succès, 0 échec** (introspection, cache privé, profil, sous-titres, MP4 natif,
politique propriétaire, verrou de maintenance, HTTP de maintenance, diagnostic 404, transport fournisseur).

Release pilote écrite : `/tmp/norva-resume-ranges-pilot.py`, calquée sur le protocole éprouvé
(`opplex-diagnostic-pilot.py` → `provider404-pilot.py`) : reçu à usage unique, assertion de l'image
prédécesseur `provider404-pilot-20260916`, contrôle d'inactivité du pilote, extraction des trois fichiers
**depuis le conteneur en cours** puis patch ancré, image construite `FROM` l'image courante, `node --check` de
chaque fichier dans un conteneur sans réseau, clone vérifié, `/maintenance/prepare` puis `/maintenance/commit`,
bascule avec conservation en `-introspection-retained`, contrôle de santé, assertion `main_changed` et
rollback automatique sur toute exception. Préconditions vérifiées : image attendue, pilote inactif
(`activeSessions 0`, `rawPumpCount 0`, `transcribeQueueDepth 0`), répertoire de reçu absent.

**Le déploiement a été refusé par la politique d'exécution de l'environnement.** Il n'a pas été contourné.
L'introspection n'est donc pas active sur le pilote.

### 3. Correctif de conservation — délibérément non écrit à ce stade

La responsabilité des évictions dans les échecs de réutilisation reste une **hypothèse**, précisément parce que
les plages réellement conservées n'ont pas encore été relevées. Écrire maintenant un correctif de conservation
reviendrait à corriger une cause supposée, ce qui est l'erreur déjà commise plus haut dans ce rapport. L'ordre
retenu est donc : déployer l'introspection, relever les plages conservées face à la position réellement
sauvegardée, puis corriger la conservation avec une mesure à l'appui.

### 4. Reste non fait

- Démonstration d'une réutilisation de la **fenêtre de reprise** (et non du seul en-tête de 256 Kio).
- Politique de démarrage adaptative remplaçant le seuil fixe de 96 s, avec protection contre les coupures et
  comparaison de plusieurs essais sur les mêmes variantes.
- Comparaison des deux chemins de sonde sur le même fichier à conditions égales.
- `format_name` réel du conteneur par ffprobe.

## 17 septembre — introspection déployée, exclusion impossible à garantir, cause réelle de la non-réutilisation

### 0. Incident à traiter : identifiants proxy exposés

En comparant les configurations de routage, un filtre de sanitisation ne couvrait que les clés contenant
`PROXY_URLS` ; `PROVIDER_PROXY_SOCKS_URLS` est donc sorti en clair, avec l'utilisateur et le mot de passe Oxylabs.
**Ces identifiants doivent être révoqués et régénérés.** La variable n'a pas été relue depuis.

### 1. Introspection déployée sur le pilote

Image `norva-media-gateway:resume-ranges-introspection-20260917`, `RestartCount=0`, pilote sain.
Gateway principal **inchangé** (`sha256:ecced97c…`, `RestartCount=0`).

Retour arrière disponible : conteneur `norva-resume-cache-pilot-20260916-introspection-retained` portant
`provider404-pilot-20260916`, plus le reçu privé `0600` sous
`/home/adrien/.norva/resume-ranges-introspection-20260917/`. Protocole identique aux releases précédentes
(reçu à usage unique, assertion de l'image prédécesseur, contrôle d'inactivité, patch ancré sur les fichiers
extraits du conteneur en cours, `node --check` hors réseau, clone vérifié, `maintenance/prepare` + `commit`,
rollback automatique).

Contrôles après bascule : `GET /debug/resume-ranges` répond authentifié ; le préfixe public renvoie **HTTP 404**
(`media.norva.tv/resume-cache-pilot-20260916/debug/resume-ranges`), la route n'est donc pas publiée.
Le cache est vide après redémarrage : il est privé au processus.

### 2. Exclusion fournisseur : configurations identiques, mais aucun verrou

**Configurations de routage comparées, identiques sur les deux Gateway** : mêmes 5 slots dans le même ordre,
même liste SOCKS, `PROVIDER_PROXY_DEFAULT_NODE_TRANSPORT=http` des deux côtés, `PROVIDER_PROXY_SLOT_OVERRIDES`
**identiques** (même empreinte `cadfa6ae38dc`, même longueur), `PROVIDER_HTTP_FORWARD_ACCOUNTS` non défini des
deux côtés — donc aucune route de contournement configurée. La condition « configuration identique » est remplie.

**Mais il n'existe aucun verrou entre processus.** `accountKeyBusyLocally()` ne parcourt que les `sessions` et
`rawPumps` **du processus courant** — son nom le dit. Aucun Redis, aucun verrou consultatif, aucun registre
partagé dans le chemin d'admission.

Le mécanisme inter-processus qui existe est autre : `activeProviderAccountActivityGroups()` calcule les comptes
fournisseur que la boîte détient réellement — sessions, `rawPumps`, **`accountExtractions`** (le travail de fond,
exactement l'angle mort) et brokers LID — et les publie toutes les ~60 s vers l'Edge
(`POST /account-activity`, table `provider_account_busy`). Mais c'est **la campagne de sondes de l'Edge** qui lit
cette table et cède le slot : **le principal ne la consulte pas avant d'admettre ses propres travaux de fond**.

Conséquence : le principal peut démarrer une lecture fournisseur à tout instant, y compris entre deux
échantillons. L'observation par port reste un **détecteur a posteriori**, pas un verrou. **L'exclusion effective
ne peut pas être garantie ; aucun essai fournisseur n'a donc été lancé dans cette étape.**

Pour lever le blocage, deux voies seulement : autoriser une lecture ciblée de `provider_account_busy` (pour
connaître les comptes tenus par le principal), ou faire consulter ce registre au principal avant admission —
ce qui est une modification du principal, hors périmètre.

### 3. Cause réelle de la non-réutilisation : budget contre avance de lecture

Mesure sans fournisseur : rejeu du **code de stockage réellement déployé** avec les paramètres relevés sur des
sessions réelles (fichier 2 324 844 149 octets / 6 534 s, fenêtre séquentielle 8 Mio, warmup 256 Kio,
`perFileBytes` 32 Mio, `maxFragments` 64).

| scénario | fenêtre intérieure conservée | position sauvegardée | réutilisable |
|---|---|---|---|
| 188 s vus depuis 569 s | 1606 s – 1697 s | 757 s | non |
| 600 s vus depuis 0 s | 4715 s – 4800 s | 600 s | non |
| contrôle : 20 s vus, faible avance | 100 s – 140 s | 120 s | **oui** |

La fenêtre conservée suit donc la **frontière de téléchargement**, jamais le spectateur, parce que `trim()`
évince les priorités 0 par `used` : le fragment le plus récemment mémorisé est toujours celui de la frontière.

**Arithmétique décisive, à partir de données réelles.** Débit média = 355 807 o/s. Un budget de 32 Mio ne retient
donc que **94,3 s** de média. Or la trace `windowTrace` de la session réelle `98b4b492` montre une frontière à
l'octet 297 367 790 (soit 835,8 s de média) alors que le spectateur était à 562,6 s : une **avance de 273,1 s**.

Les octets situés autour de la position du spectateur sont donc récupérés environ 273 s **avant** qu'il n'y
arrive, et sont évincés bien avant la fermeture — **quel que soit l'ordre d'éviction**. Ce n'est pas seulement un
défaut d'ordre : c'est une inadéquation entre le budget (94 s) et l'avance de lecture (273 s).

### 4. Correctif partiel, honnêtement incomplet

Implémenté et testé : **ancre spectateur**. `anchorAt(byteOffset)` sur la poignée de réutilisation ; `trim()`
évince désormais, à priorité égale, le fragment **le plus éloigné de l'ancre** au lieu du moins récemment utilisé ;
l'ancre est exposée dans l'introspection. Elle n'admet aucun octet, ne relâche aucune validation et est ignorée
quand elle est absente (repli sur le comportement actuel).

Trois tests supplémentaires : sans ancre la fenêtre du spectateur est évincée et la frontière conservée ; avec
ancre l'inverse ; et `anchorAt` rejette les entrées invalides, refuse d'agir avant confirmation d'identité et ne
rend aucun octet lisible. Suite ciblée : **116 tests, 115 succès, 0 échec, 1 ignoré**.

**Ce correctif est nécessaire mais pas suffisant, et le rejeu le montre** : avec l'ancre, la fenêtre conservée se
rapproche du spectateur (scénario A : 1606–1697 s → 569–1697 s ; scénario D : 6446–6517 s → 1000–1071 s) mais la
position sauvegardée **reste non couverte** au rapport avance/budget réel. Il ne doit pas être présenté comme
résolvant la réutilisation.

Options pour compléter, à départager par la mesure :
- augmenter le budget par fichier pour couvrir avance + fenêtre utile (~273 s + ~90 s ≈ 123 Mio), incompatible
  avec le plafond global de 128 Mio validé en dur pour 32 fichiers ;
- borner l'avance de lecture du broker séquentiel ;
- amorcer la fenêtre de reprise à la fermeture par une seule lecture ciblée de quelques Mio à la position
  sauvegardée.

Le choix exige de mesurer la distribution réelle de l'avance avec l'introspection désormais déployée, donc des
essais fournisseur — actuellement bloqués par l'absence d'exclusion.

**Non déployé** : l'ancre reste dans le worktree ; le pilote ne porte que l'introspection.

### 5. Reste non fait

- Relevé des plages conservées sur une **session réelle** et démonstration d'une reprise réutilisant la fenêtre.
- Politique de démarrage adaptative remplaçant le seuil fixe de 96 s, et deux minutes de fluidité associées.
- Comparaison des deux chemins de sonde sur le même fichier ; `format_name` réel du conteneur.

## 17 septembre — rétractations, étude paramétrique de la conservation, conceptions d'exclusion

Rien de nouveau n'a été déployé. Le pilote ne porte toujours que l'introspection. Principal non modifié.
Aucune lecture fournisseur.

### 1. Rétractations

**(a) « Quel que soit l'ordre d'éviction » — retiré.** Cette formulation présentait une limite de
l'implémentation testée comme une impossibilité. L'étude paramétrique ci-dessous montre au contraire que la
réutilisation dépend du rapport entre l'avance de préchargement et la fenêtre conservée, et qu'elle fonctionne
en deçà d'un certain seuil.

**(b) « Avance de 273 s » — retiré, et la mesure était fausse à deux titres.**

- *Fichiers mélangés.* Le rejeu utilisait `FILE_SIZE = 2 324 844 149` octets, qui provient de la session
  `db4261bc` (**Hacksaw Ridge**, le héros joué par erreur), avec `DURATION = 6534 s`, qui provient de l'entrée
  de reprise de **Royalteen ES**. Deux fichiers différents.
- *Fenêtre mal interprétée.* La fenêtre à l'octet 297 367 790 de la session `98b4b492` n'était pas une frontière
  de préchargement : c'est **la cible du seek** pour `actualStartOffset = 562,633 s`. Aucune avance n'a donc
  jamais été mesurée.

Correspondances réellement connues, par fichier :

| fichier | point réel 1 | point réel 2 |
|---|---|---|
| Hacksaw Ridge (`db4261bc`) | 0 s ↔ 0 o | fin : 2 319 372 676 o, taille 2 324 844 149 o, durée 8 344 s |
| Royalteen ES (`98b4b492`) | 0 s ↔ 0 o | **562,633 s ↔ 297 367 790 o** |

Pour Royalteen ES, cela donne 528 529 o/s en moyenne **jusqu'à ce point**, contre 355 807 o/s si l'on avait
divisé une taille (erronée) par la durée : la conversion par débit moyen était bien trompeuse, comme signalé.
Aucune correspondance intérieure supplémentaire n'est disponible sans session réelle.

### 2. Étude paramétrique de la conservation (sans fournisseur)

Rejeu du code de stockage réel, position de départ 569 s, 188 s visionnées, budget 32 Mio, avance de
préchargement **balayée** au lieu d'être supposée. Deux modèles de correspondance temps↔octets, tous deux
calés sur le point réel mesuré : un modèle à débit constant et un modèle non linéaire.

| avance | référence | ancre seule | fenêtre protégée (−30 s/+90 s) |
|---|---|---|---|
| 15 s | réutilisable | réutilisable | réutilisable |
| 30 s | réutilisable | réutilisable | réutilisable |
| 60 s | non | non | non |
| 120 s | non | non | non, 189 fragments écartés, 0 intérieur retenu |
| 240 s | non | non | non, 189 écartés |
| 480 s | non | non | non, 189 écartés |

**Q1 — l'ancre suit-elle la progression du spectateur ?** **Oui.** Dans tous les essais ancrés, la valeur relue
par l'introspection est exactement l'octet du spectateur, et elle est monotone.

**Q2 — une fenêtre protégée est-elle présente avant chaque éviction ?** **Non.** Le compteur d'évictions
survenant alors qu'aucun fragment ne couvre le spectateur est non nul dès 30 à 60 s d'avance (25, puis 82, puis
143 évictions). C'est un **défaut réel de la politique**, et il n'avait pas été vérifié auparavant.

**Q3 — « petite fenêtre protégée + abandon du préchargement éloigné » produit-il de la réutilisation ?**
**Conditionnellement.** En deçà de ~30 s d'avance, oui. Au-delà de ~120 s, l'abandon libère bien le budget
(189 fragments écartés, 1,2 Mio retenus au lieu de 32) mais **plus rien d'intérieur n'est stocké** : tout ce qui
est récupéré se trouve hors fenêtre. L'abandon seul ne suffit donc pas ; il faut que l'avance reste comparable à
la fenêtre.

**Limite du contrôle de sensibilité.** Le modèle non linéaire donne des résultats identiques au modèle constant
parce que les positions utilisées (569–757 s) tombent toutes dans son premier segment. Ce contrôle est donc
dégénéré pour ce jeu de positions et ne prouve pas l'insensibilité au débit variable.

**Inconnue décisive restante :** l'avance de préchargement réelle en production, qui détermine dans quelle
colonne du tableau on se trouve. Elle se mesure avec l'introspection déjà déployée, lors d'une session réelle —
donc derrière le verrou fournisseur.

### 3. Correctif local, non déployé

Deux mécanismes, tous deux inactifs par défaut et sans effet tant qu'ils ne sont pas configurés :

- **ancre spectateur** (`anchorAt`) : éviction par distance au spectateur plutôt que par ancienneté ;
- **fenêtre protégée** (`retainBehindBytes` / `retainAheadBytes`) : un fragment entièrement hors
  `[ancre − arrière, ancre + avant]` n'est pas conservé, compté dans `droppedDistantPrefetch`, visible dans
  l'introspection. Aucun téléchargement supplémentaire à la fermeture.

Tests : sans fenêtre ni ancre le comportement antérieur est **inchangé** (vérifié explicitement) ; avec ancre la
fenêtre du spectateur survit et la frontière la plus éloignée est évincée ; `anchorAt` refuse les entrées
invalides, n'agit pas avant confirmation d'identité et ne rend aucun octet lisible. Suite ciblée :
**136 tests, 135 succès, 0 échec, 1 ignoré.**

### 4. Exclusion fournisseur — deux conceptions, aucune applicable sans toucher au principal

Lire `provider_account_busy` **ne verrouille rien** : entre la lecture et le démarrage il reste une course. Ce
registre est un signal consultatif, pas une réservation. Il ne doit pas servir à rouvrir les essais.

**Option A — suspension coordonnée, avec sauvegarde et restauration.**
Étendre la barrière de maintenance déjà écrite (`maintenance-fence.js`) en un mode « quiesce fournisseur » :
fermer l'admission de tout travail touchant un fournisseur ; demander aux extractions en vol de poser un
checkpoint et de s'arrêter ; attendre que `activeProviderAccountActivityGroups()` soit vide, avec délai borné ;
émettre un reçu listant ce qui a été suspendu ; un point de reprise restaure la file. Les six storyboards
possèdent déjà des checkpoints rechargeables (156/24/120/30/126/30, vérifiés intacts) ; **les deux travaux
non-storyboard n'en ont pas** et devraient être ré-enfilés explicitement, ce chemin devant être prouvé avant
usage. Propriété obtenue : pendant la fenêtre, le principal ne détient aucune connexion fournisseur —
exclusion par construction, pas par observation.

**Option B — réservation atomique partagée.**
Les deux Gateway atteignent déjà Postgres. Remplacer l'écriture consultative par un bail :
`provider_account_lease(account_key_hash PK, holder, expires_at)`, acquis par **une seule instruction atomique**
(`INSERT … ON CONFLICT … DO UPDATE … WHERE expires_at < now() RETURNING holder`, ou
`pg_try_advisory_lock(hashtext(account_key))`), renouvelé par battement, libéré en fin d'opération, l'expiration
bornant les pannes. Toute lecture fournisseur — y compris les phases broker — doit l'acquérir d'abord. Il n'y a
plus de fenêtre entre vérification et démarrage. À décider explicitement : le comportement si le magasin de baux
est injoignable (refus pour les essais, autorisation pour les lectures utilisateur, afin de ne pas créer une
dépendance dure).

Les deux exigent de modifier le chemin d'admission du **principal**, exclu pour l'instant. Les essais
fournisseur restent donc suspendus.

### 5. État

Pilote : `resume-ranges-introspection-20260917`, `RestartCount=0`, `activeSessions 0`, retour arrière conservé.
Principal : `sha256:ecced97c…`, `RestartCount=0`, six storyboards `pending`. Aucune session fournisseur depuis
le redémarrage du pilote (`sessionStartupStats.attempts 0`, `probeStats.attempts 0`).

## 17 septembre — rétractation de l'essai « fenêtre protégée », et procédure de suspension proposée

Rien déployé. Le pilote ne porte que l'introspection. Principal non modifié. Aucune lecture fournisseur.

### 1. Rétractation supplémentaire : l'essai Q3 était invalide

La fenêtre testée valait −30 s / +90 s, soit **120 s**. Au seul débit réellement mesuré sur ce fichier
(528 529 o/s jusqu'au point 562,633 s ↔ 297 367 790 o), cela représente **60,5 Mio**, alors que le budget
`perFileBytes` qu'elle devait respecter vaut **32 Mio**, soit **63,5 s** de média.

La configuration testée était donc **arithmétiquement insatisfiable** : la fenêtre ne pouvait jamais tenir dans
le budget. Le résultat « la fenêtre protégée ne produit pas de réutilisation au-delà de 60 s d'avance » ne teste
pas la politique, il teste une contrainte impossible. **Il est retiré.** Toute fenêtre candidate doit désormais
vérifier explicitement `fenêtre × débit ≤ perFileBytes`, donc au plus ~60 s au total sur ce fichier.

Par ailleurs, et c'est la limite principale : « l'ancre suit le spectateur » n'est démontré **que dans la
simulation**. Rien ne prouve que la position transmise au cache en production corresponde à la position réelle
du lecteur. Les simulations restent exploratoires ; elles n'établissent ni le suivi de position réel, ni la
cause des absences de cache.

**Décision retenue : gel de toute modification de politique de conservation** jusqu'à l'obtention d'une trace
réelle. L'ancre et la fenêtre restent locales, non déployées.

### 2. Procédure de suspension et restauration — proposée, non exécutée

Document : `docs/qa/provider-quiesce-runbook-20260917.md`.

Principe : n'utiliser que des comportements **déjà présents** dans l'image déployée du principal, sans aucune
modification de code.

- `POST /sessions` sur le principal appelle `preemptBackgroundWorkGlobally()` (index.js:11336), qui préempte
  extractions, inférences Whisper et travaux CPU de fond.
- Tant que la session vit, `viewerPlaybackActiveLocally()` est vrai, donc `backgroundJobBlockedByViewer()`
  **diffère** tout nouveau travail de fond, réinséré dans la file avec un battement `deferred`.
- Un travail différé n'échoue qu'après 240 × 60 s ≈ **4 h** ; la fenêtre proposée est plafonnée à **30 min**,
  très en deçà.

Relevé de l'état du principal au moment de la rédaction : `transcribeQueueDepth 9`, `transcribeBusy true`,
six storyboards `pending`, `activeSessions 0`, `rawPumpCount 0`, **aucun processus ffmpeg/ffprobe fournisseur**,
et `whisperInferenceActive 1`. L'unique opération active est donc une **inférence Whisper**, c'est-à-dire du
traitement local postérieur au téléchargement : à cet instant le principal ne tient **aucune** connexion
fournisseur.

**Travaux sauvegardés** : les six storyboards ont des checkpoints rechargeables, vérifiés intacts à plusieurs
reprises (156/24/120/30/126/30, `savedFrames == intactFrames`).

**Travaux non sauvegardés, traités explicitement** : l'inférence Whisper en cours n'a pas de checkpoint — une
préemption la tue et son avancement est perdu, le job étant réinséré et repris de zéro. Le travail prioritaire
non différable (`pendingPriorityJobs: 1`) n'est pas identifiable depuis les endpoints en lecture seule.
**Voie recommandée, sans perte** : attendre `transcribeBusy == false` et `whisperInferenceActive == 0` avant
d'ouvrir la fenêtre, plutôt que d'accepter la perte.

**Limite importante découverte à la rédaction** : **cinq** conteneurs de la famille Gateway tournent sur cette
machine (principal, canaris `v154` et `v155`, `media-lab-gateway`, `media-lab-runner`). Au relevé, les quatre
autres étaient au repos fournisseur (aucun hôte, zéro connexion établie), mais **la session de garde n'agit que
sur le processus du principal** : leur inactivité doit être vérifiée à l'ouverture et pendant toute la fenêtre.
Mes comparaisons précédentes ne portaient que sur deux conteneurs sur cinq.

La procédure détaille : relevé de référence, ouverture par session de garde sur un compte **distinct** de celui
de l'essai, vérification de quiescence, essai, fermeture, et critères de restauration (checkpoints non
régressés, aucun travail disparu, `RestartCount` inchangé, reprise du fond), plus les conditions d'abandon
immédiat.

### 3. Mesures exigées pendant la fenêtre

Sur une seule variante identifiée sans ambiguïté, recueillir **ensemble** : `rawTitle` / `streamId` /
`sourceId` et l'identifiant de session ; la position réelle du lecteur au fil du temps ; la position réellement
sauvegardée ; les plages **demandées** (`windowTrace`, `providerStart`/`providerEnd`) ; les plages
**conservées** et les évictions (`/debug/resume-ranges`) ; et la correspondance temps ↔ octets issue de
**l'index du fichier** — échantillonnage borné `ffprobe -show_packets -select_streams v -read_intervals`
donnant des couples (`pts_time`, `pos`) réels, dont celui de la position sauvegardée — et non un débit moyen.

Cette trace est la seule base admise pour reproduire le défaut localement, puis corriger et tester.

## 17 septembre — procédure v2 : ce qui manque réellement, et rotation non effective

Rien exécuté. Aucune session de garde. Pilote : introspection seule. Principal : non modifié. Zéro lecture
fournisseur.

### Rotation des identifiants exposés — **non effective**

L'environnement d'un conteneur est figé à sa création. Le principal a été créé le **2026-09-16T09:46:26Z**,
soit avant l'exposition, avec `RestartCount=0` : il n'a pas été recréé. Le pilote a été cloné depuis lui lors
du déploiement de l'introspection. Les empreintes SHA-256 des deux variables proxy sont **identiques** sur les
deux conteneurs. Les identifiants exposés sont donc toujours ceux en service.

Conséquence opérationnelle : les changer impose de **recréer les conteneurs**, donc un échange du principal —
la même opération que celle requise par la barrière d'admission ci-dessous. Les deux devraient être faites
ensemble pour n'imposer qu'un seul redémarrage.

### La « session de garde » est retirée

Trois défauts, tous fondés : elle détourne une lecture pour bloquer des traitements et consomme un compte ;
elle ne protège que le principal alors que quatre autres conteneurs Gateway tournent ; et attendre
l'inactivité puis créer la garde laisse une course où un travail redémarre et se fait tuer. S'y ajoutait un
`ffprobe` non séquencé, susceptible d'ouvrir une seconde connexion sur le même compte.

### Ce que le principal sait déjà faire — et ce qui manque

`POST /sessions/stop-provider-affinities` (authentifié) vide un compte précis — sessions, raw pumps,
extractions, validations de langue — et renvoie `providerDrained` **vérifié**, HTTP 409 sinon. Mais la lecture
du code (`stopProviderAffinities`, index.js:20663) montre qu'il **ne bloque pas la ré-admission** : la course
subsiste. `preemptBackgroundWorkGlobally()` et la porte `viewerPlaybackActiveLocally()` sont, elles, liées à
l'existence d'une lecture.

Il manque donc **une barrière d'admission explicite, à durée bornée et indépendante d'une lecture**. Le
principal n'en a pas ; le pilote la possède déjà (`maintenance-fence.js`, `maintenance-http.js`) et elle a servi
à chacune de ses bascules.

### Modification soumise à accord

Porter cette barrière sur le principal, avec un mode « quiesce fournisseur » qui refuse les nouvelles
admissions de fond, **expire seul** (20 min proposées), n'interrompt aucune opération en cours, et reste
désactivé par défaut. Trois fichiers, dérivés de l'image en service ; protocole de bascule identique à celui du
pilote, avec conteneur conservé et rollback automatique. Avant l'échange : attendre `transcribeBusy == false` et
`whisperInferenceActive == 0`, ce qui évite toute perte d'avancement non sauvegardé.

Sans cet accord, aucune exclusion effective n'est atteignable sur le principal et les essais restent suspendus.
Aucun contournement n'est proposé.

### Séquence corrigée

Barrière fermée sur le principal **puis** `docker pause` des quatre conteneurs secondaires (vérifié : Caddy ne
route que vers le principal ; les canaris n'écoutent que sur `18083`/`18084` sans route ; les `media-lab`
n'exposent aucun port) → laisser **terminer** les opérations non sauvegardées, sans rien tuer → drain du compte
testé avec `providerDrained: true` exigé → essai unique → restauration. La barrière expirant d'elle-même, la
restauration est garantie même si l'essai échoue.

Sonde et lecture sont **strictement successives**. La correspondance temps ↔ octets viendra d'abord des cibles
de seek de la session elle-même (`actualStartOffset` calculé sur l'index, `providerStart` publié par
`windowTrace`), donc sans aucune connexion supplémentaire ; un `ffprobe` complémentaire, s'il est nécessaire,
ne sera lancé qu'après fermeture et drain confirmé.

Procédure complète : `docs/qa/provider-quiesce-runbook-20260917.md`.

## 17 septembre — première fenêtre d'exclusion effective, et trace réelle du cache

### 1. La porte de mise en pause est installée sur le principal

Image `norva-media-gateway:provider-quiesce-20260917`, `RestartCount=0`. Bascule réussie : **six storyboards
rechargés**, checkpoints `savedFrames == intactFrames` identiques avant/après (156/24/120/30/126/30), file
inchangée (6 → 6), aucun travail perdu. Conteneur `norva-media-gateway-provider-quiesce-retained-20260917`
conservé pour le retour arrière.

La porte ne porte **que** l'admission des travaux de fond : elle ne refuse aucune requête HTTP, n'interrompt
rien en vol, est inerte sans bail, expire seule en 30 s et ne peut être tenue au-delà de 20 min. Aucune variable
de configuration n'a été ajoutée, le protocole de bascule exigeant une `Config` préservée à l'octet près.

Une première tentative a échoué sur `provider_process_final` : un travail de fond avait repris entre le contrôle
initial et la bascule. La sécurité a joué — rien n'a été touché — mais le contrôle était placé hors du bloc de
rollback et avait laissé un candidat et un reçu. Corrigé en v2 : nettoyage automatique des résidus, et **attente
active** d'une fenêtre de repos au lieu d'un échec immédiat.

### 2. Exclusion effective obtenue

Séquence : gel des quatre conteneurs Gateway secondaires (`docker pause`), prise du bail sur le principal, puis
**attente que le travail en cours se termine de lui-même** — rien n'est tué. Résultat sur la fenêtre :
bail tenu avec **46 renouvellements et 0 expiration**, **42 travaux de fond différés**, principal au repos
(`idleReason: null`) pendant tout l'essai, quatre secondaires gelés. Libération et dégel vérifiés ensuite.

### 3. Trace de l'essai unique

Variante identifiée **avant** lecture : `rawTitle` **`ES ▎ Royalteen`**, `streamId` **1014841**, `sourceId`
**900001** (Promax), conteneur annoncé mp4. Session Gateway **`95842286-c6e0-4954-b1b7-537fd8fadbb3`**.

- Reprise demandée 806 s, `actualStartOffset` **806 s** exact. Identité `strong-etag`, `confirmed: 1`.
- `codecProfileSource: request`, **aucune sonde** (`codecProfileMs: 0`).
- `ffmpegReadyMs` 48 851, `totalMs` **48 938**. `sustainedMediaProductionRateX` **0,661** — production plus
  lente que le temps réel.
- Première image à **128,0 s** : ~49 s de préparation Gateway, puis ~79 s à remplir la réserve de 96 s imposée
  par le lecteur (politique `eligible: false`, `targetBufferSeconds: null`).
- Lecture : **183,5 s de média en 183,9 s d'horloge**, rapport 1:1, **6 images perdues sur 5 508**, un seul
  `waiting` au tout premier instant. Les deux minutes de fluidité vidéo sont atteintes.
- Position réellement sauvegardée après fermeture : **989 s**.

### 4. Correspondances temps ↔ octets issues de l'index, pas d'un débit moyen

Deux cibles de seek réelles, calculées par le Gateway sur l'index du fichier :

| position média | octet fournisseur | source |
|---|---|---|
| 562,633 s | 297 367 790 | session `98b4b492` |
| 806 s | 399 555 243 | session `95842286` |

Débit **local mesuré entre ces deux points réels : 419 890 o/s.** Aucune connexion supplémentaire n'a été
nécessaire : ces couples viennent des seeks eux-mêmes.

### 5. Plages réellement conservées — la cause est établie

Relevé `GET /debug/resume-ranges` après fermeture normale, entrée `7c03e656d640`, 25 427 968 octets,
4 fragments, `storedWindows: 37`, `anchor: None` (la politique ancre/fenêtre n'est pas déployée) :

| plage conservée | priorité | position média |
|---|---|---|
| 0 – 262 143 | 1 | en-tête protégé |
| 654 311 424 – 679 477 247 (3 × 8 Mio) | 0 | **~1413 s – 1473 s** |

Position sauvegardée **989 s ≈ octet 476 395 175 : aucune plage ne la couvre.** Le cache conserve une fenêtre
située **environ 424 s plus loin** que l'endroit où le spectateur s'est arrêté.

**Mécanisme précis, désormais mesuré et non plus supposé.** Le spectateur a avancé de 806 s à 989 s (183 s de
média) pendant que la pompe d'entrée lisait jusqu'à ~1473 s, soit ~667 s de média en 184 s d'horloge : la
**lecture d'octets en amont tourne à environ 3,6× le temps réel**, alors que la *production de segments* n'est
qu'à 0,661×. Ce sont deux choses distinctes, et c'est la pompe d'entrée qui remplit le cache. La conservation
suit donc la pompe, jamais le spectateur.

Ordre de grandeur : budget 32 Mio ÷ 419 890 o/s ≈ **80 s de média conservables**, contre une avance de pompe
d'environ **484 s** à la fermeture. Tant que ce rapport tient, aucune politique d'éviction ne peut couvrir la
position sauvegardée — ce qu'il faut corriger est l'avance retenue, pas l'ordre des victimes.

### 6. Défaut audio constaté pendant l'essai

Audio signalé comme cassé par l'utilisateur pendant la lecture. Piste source : AAC **6 canaux**, espagnol
(`selectedAudioTrack.index 1`, `channels 6`). Le Gateway transcode en stéréo avec
`-c:a aac -ac 2 -b:a 160k -af aresample=48000:async=1:first_pts=0`. Deux causes plausibles et distinctes :
un `-ac 2` sans matrice de downmix explicite, qui sur du 5.1 produit classiquement un son creux ou très bas
par perte du canal central ; et un débit d'encodage à 0,661× qui ne tient pas le temps réel. À instruire
séparément du cache ; non corrigé.

### 7. État final

Principal : `provider-quiesce-20260917`, `RestartCount=0`, six storyboards intacts et sans régression, file 6,
fond redémarré. Quatre secondaires en marche. Pilote : `activeSessions 0`. Aucun redémarrage subi par le
principal en dehors de la bascule autorisée.

## 17 septembre — audio : hypothèse réfutée, et dimensionnement de la conservation

### Audio

**L'hypothèse « `-ac 2` sans matrice perd le dialogue » est réfutée par la mesure.** Reproduction hors ligne
dans l'image déployée, avec un fichier 5.1 synthétique et un seul canal sonore à la fois, puis les arguments de
production verbatim :

| canal actif | source 5.1 | sortie stéréo |
|---|---|---|
| FL / FR | −28,9 dB | −24,1 dB |
| **FC (dialogue)** | −28,9 dB | **−24,1 dB** |
| LFE | −69,1 dB | −91,0 dB |
| BL / BR | −28,9 dB | −27,1 dB |

Le canal central survit au même niveau que les frontaux, les surrounds sont atténués d'environ 3 dB et le LFE
est écarté : downmix correct et standard.

Défaut réel trouvé dans les journaux de la session `95842286` :
`Packet corrupt (stream = 1, dts = 65673192)` suivi de
`aac decode_band_types: Input buffer exhausted before END element found`. `stream = 1` est bien la piste audio
(`audioMap: "0:1"`). **Mais `dts 65673192` ÷ 48 000 = 1368,2 s de média, donc hors de la fenêtre réellement
écoutée (806 s → 989 s) :** une seule occurrence, dans la zone de préchargement. Elle n'explique donc pas ce
qui a été entendu. Cause non établie ; le symptôme exact (silence, grésillement, désynchronisation, hachures)
est nécessaire pour trancher entre sous-alimentation du pipeline à 0,661×, chemin `aresample=async=1:first_pts=0`
après seek, et paquets corrompus.

### Dimensionnement de la conservation, à partir de la trace réelle

- débit local mesuré entre deux points d'index réels : **419 890 o/s** ;
- budget actuel `perFileBytes` 32 Mio = **79,9 s de média** ;
- **vitesse de la pompe d'entrée : 3,63× le temps réel** (667 s de média lus en 184 s d'horloge) ;
- la pompe atteint la position 989 s au bout de 50 s, alors que le spectateur n'est qu'à 856 s :
  **avance de 133 s (≈ 55,6 Mo) au moment précis où les octets de la position sauvegardée sont lus.**

133 s > 79,9 s : ces octets sont donc évincés bien avant la fermeture. C'est cohérent avec le relevé, qui ne
conserve que ~1413–1473 s.

**Conséquence de conception, et elle est décisive.** L'avance au moment de la lecture vaut
`(P − début) × (1 − 1/3,63) ≈ 0,72 × (P − début)` : elle **croît linéairement avec la durée visionnée**. Pour
183 s regardées il faut ~133 s d'avance couverte (~77 Mio par fichier avec une fenêtre utile de 60 s, sous un
plafond global dur de 128 Mio) ; pour 30 minutes regardées il faudrait ~1300 s, soit plus de 500 Mo. Agrandir le
budget ne règle donc que les courtes sessions.

**Borner l'avance de la pompe est la seule correction qui passe à l'échelle** : pour tenir dans le budget actuel
avec une fenêtre utile de 60 s, il faudrait une avance inférieure à ~20 s, soit une pompe à moins de ~1,4×
pendant la lecture. L'ancre reste nécessaire pour que la conservation suive le spectateur, mais elle ne suffit
pas tant que l'avance dépasse le budget.
