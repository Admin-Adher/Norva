# Windows : lecture intégrée et contrôles Norva

## Demande et périmètre

Le propriétaire signale plusieurs VOD sans démarrage dans la préversion Windows et demande une vidéo dans la fenêtre Norva, avec le design du lecteur web. Il demande aussi des films et épisodes variés, depuis zéro et en reprise. Suivi de PR749/751 ; PR757 contient les corrections Windows. Le prototype web PR756 reste indépendant.

## Contrat visuel

Référence : lecteur réel de `public/app.html` et tokens de `public/css/main.css`, ainsi que les captures du lecteur web fournies dans cette conversation. Titre/retour en haut ; timeline, temps courant et durée, reprise depuis le début, ±10 s et lecture/pause en bas à gauche ; volume, audio, sous-titres, vitesse et plein écran à droite. Les chemins SVG sont extraits des vrais boutons WatchPage au build. Inter 4.1 et sa licence OFL sont inclus. La vidéo est toujours décodée par LibVLC, avec sortie Direct3D11.

Les commandes disparaissent pendant la lecture et restent visibles pendant une pause, une manipulation de timeline ou un menu. Clavier, focus visible et noms accessibles sont conservés ; les menus reviennent au bouton qui les a ouverts. Les surfaces utilisent les tokens Norva, sans autre palette. La réalisation native reprend la hiérarchie et les icônes du web ; elle ne certifie pas une identité pixel par pixel ni une conformité WCAG complète.

## Corrections

- Un vrai enfant HWND est rattaché à la fenêtre Electron, via une surface native en couche. Le manifeste Windows moderne est nécessaire à son rendu ; les premiers essais sans ce manifeste masquaient les commandes. Les anciennes sorties séparées et fenêtres désactivées sont remplacées par `BaseWindow`/`WebContentsView`, masquée seulement pendant la lecture native. Les heartbeats et l'historique restent actifs. Retour après sortie du processus et drainage du transport.
- Le handle et le PID viennent uniquement du processus principal, jamais d'une requête renderer. L'origine et le frame IPC restent contrôlés. Aucun URL média n'est mis dans les arguments du processus.
- Le plein écran est accusé immédiatement au lecteur natif, puis synchronisé avec les événements de la fenêtre. Échap quitte d'abord le plein écran ; fermeture ordinaire ensuite.
- Les relectures d'en-têtes/index alternés sont mises en cache dans la session : huit fenêtres complètes de 2 Mio au maximum, soit 16 Mio. Le premier essai Last Bullet relisait 0–6 Mio après avoir lu l'index ; chaque plage prenait 5–6 s. Les données partielles ne sont jamais admises, les fenêtres sont évincées par LRU, vidées à la fermeture et révoquées si taille/validateur change. Ce cache n'est ni persistant ni mutualisé. Une seule requête fournisseur reste en vol.
- Un reçu local limité aux statistiques techniques aide à diagnostiquer les échecs. Il ne contient ni identifiants, URL, headers, stderr natif ni octets vidéo ; un échec d'écriture ne bloque pas le drainage.

## Premiers essais authentifiés

Vrai catalogue Norva → preload/IPC → création et heartbeats cloud ordinaires → LibVLC → historique et expiration. Session QA temporaire sans refresh. Aucune sonde média opérateur en parallèle. Le premier compteur `displayedPictures > 0` est un échantillon toutes les 1–1,5 s ; les temps ci-dessous partent de l'ouverture native, **pas du clic**, et ne sont pas une mesure de la première image visible à la milliseconde. L'événement `playing` à lui seul n'est pas compté comme démarrage.

| Copie | Parcours | Premier compteur d'image | Observation |
| --- | --- | --- | --- |
| Conclave / Dino | Reprise 1747 s, puis saut vers 47 min | 5,968 s | Progression au-delà de 3 min après saut ; `lostPictures=0` |
| Proie / MAX OTT | Reprise 1520 s, puis saut à zéro | 40,453 s | Image réelle, puis progression à 14,568 s après saut ; observation courte |
| Last Bullet MULTI-SUB / MAX OTT | Première ouverture depuis zéro | 45,764 s | Progression jusqu'à 59,216 s ; relectures d'en-têtes mises en évidence avant le nouveau cache |
| Breaking Bad S1E3 / Dino | Reprise 2037 s | 50,389 s | Progression jusqu'à 2131,488 s ; préférence E-AC-3 5.1, ne pas présenter comme AAC |
| California King MULTI-SUB / MAX OTT | Reprise 75 s, cache de session nouveau | 20,173 s | Pause/reprise, sous-titres EN→FR, affichage français réel, F11/Échap et retour ; position finale 163,358 s |
| Peaky Blinders S1E2 / Dino, MP4 | Première ouverture à zéro, puis saut vers 16:09 | 3,410 s | 3,970 s depuis le clic ; saut suivi à 1,149 s, progression jusqu'à 1049,360 s |
| Peaky Blinders S1E2 / Strng, MP4 | Première ouverture à zéro | Aucun | Deux réponses HTTP460 avant tout octet ; échec et retour au catalogue |

California King : clic repéré à 1791586500971, premier compteur d'image à 1791586528218, soit **27,247 s clic→échantillon d'image**, incluant l'entrée cloud. Reçu : `california-controls.safe.json`. Huit accès au cache, pic exact 16 Mio, une requête fournisseur maximale, zéro requête après drainage. Les deux expirations observées retournent HTTP200. Le compteur d'images perdues nul ne prouve pas chaque intervalle de rendu ni une acceptation à l'écoute.

Peaky Blinders/Dino : clic à 1791587149336, premier compteur d'image à 1791587153306. Saut à 1791587190811, première position cible échantillonnée à 1791587191960. Environ 80 s de progression après cette cible, avec décodage audio et vidéo, `lostPictures=0`. Menu natif sombre des pistes, coche bleue, fermeture par Échap et retour du focus inspectés. Quatorze hits du cache, 16 Mio maximum, une requête source maximale et zéro requête après drainage ; les expirations relues sont HTTP200. L'absence d'images perdues n'est pas une mesure exhaustive de la fluidité.

Strng : deux GET séquentiels HTTP460, zéro octet et zéro image. La cause interne du refus n'est pas établie ; la copie n'est pas réparée. Ni proxy, IP, extension, version choisie ni credential n'ont été changés. Un lancement supplémentaire très bref de S1E3 apparaît ensuite dans le reçu avant la fermeture du banc ; ce lancement n'est pas utilisé comme essai de reprise ni preuve de fluidité et a été drainé normalement.

## Vérifications et limites en cours

39 tests ciblés réussissent : accès, remplacement après drainage et expiration, serialisation des plages, réponses partielles/timeout, invalidation, LRU borné et export des glyphes réels. Build natif réussi. La suite locale complète antérieure a quatre échecs d'environnement Git/Bash, conservés dans les reçus. Sur le code `26ca61dec14129621e36fbef8335b417aadfcb71`, contrats CI Linux : **6286 réussis, 34 ignorés, zéro échec** ; cinq checks réussis, paquets Windows et Android compris, run 38002037177.

Paquet Windows téléchargé de la CI, artifact 11649238426. Archive SHA256 `a20825f52a5e61e61d140fa2a04c76d25e924aabf15670e187a3f3529a7c8aed`. Portable `Norva 2.1.5-native.2.exe`, 239572276 octets, SHA256 `a40e8a0e058a7e1967bdd8d715081dd828b3b10dcf5f2f04adda6bb2b66dca04`. Extraction en lecture seule réussie ; six fichiers d'entrée Electron/preload/IPC/transport correspondent au commit, manifeste Windows moderne et runtime x64 présents, onze glyphes, police et licences présents, QA/secrets/debug exclus. L'inspection initiale avait deux assertions de script incorrectes (nom du JSON et nombre de glyphes), corrigées au périmètre réel ; la licence texte ne diffère que par les fins de ligne du checkout Windows, TTF identique octet pour octet.

Le contrôle automatique a refusé le lancement du portable avec le profil QA isolé, sans motif détaillé. Confirmation humaine demandée ; **le contrôle UI du portable distribué et la publication restent en attente**. Ce refus n'invalide pas les essais de la vraie classe IPC et du lecteur natif déjà compilé, mais ces essais ne remplacent pas celui du portable final. Aucun contournement du refus exécuté.

Le portable final reste à vérifier avant publication. Les copies lentes et le signalement initial « aucune ne démarre » ne sont pas déclarés globalement résolus. La qualité audio à l'écoute reste à confirmer ; des compteurs audio croissants ne sont pas une acceptation sonore. Aucun changement Gateway, Edge, relais, seuil audio ou concurrence fournisseur. Les parcours Windows natifs sont vérifiés sur Windows ; aucune preuve de décodeur Android/TV n'est déduite de ces essais.

## Ouverture manuelle du portable final : ressources disparues

Le propriétaire ouvre lui-même le portable après les refus de lancement automatique. La fenêtre affiche Last Bullet. L'ASAR exécuté annonce `2.1.5-native.2` et correspond octet pour octet au paquet CI (SHA256 `0ad63c3e372e28f12ea6168ff5bc05da39a7b70c154f5c0237e21c78c3351aeb`). Cependant, son répertoire `resources/native-player` est absent : clic Reprendre, retour au catalogue sans lecteur ; reçu local `ready=false`, zéro requête média et zéro octet. Le contenu extrait pour l'inspection du même paquet possède ce runtime. Il s'agit d'une défaillance de disponibilité des ressources, avant les problèmes de réception fournisseur.

Le lanceur portable NSIS de la dépendance réellement installée, app-builder-lib 26.15.2, utilise par défaut un dossier TEMP fixé par build. Il supprime ce dossier avant l'extraction et après la sortie du processus lancé. Une deuxième ouverture qui abandonne le verrou Electron peut donc effacer les ressources de l'instance restée ouverte ; seuls les fichiers verrouillés par celle-ci demeurent. L'inventaire observé est compatible avec ce mécanisme, mais aucun historique des clics du propriétaire ne prouve à lui seul quelle ouverture a effectué le nettoyage.

Correction : `build.portable.unpackDirName=true` dans la version 26 utilisée omet le define `UNPACK_DIR_NAME` et laisse `$PLUGINSDIR/app`, unique par ouverture. Attention : les descriptions publiées de cette option indiquent `false`, mais le générateur 26.15.2 installé crée encore un nom partagé lorsque la valeur est fausse ; le code réellement utilisé fait foi. Une seconde ouverture revient au premier écran grâce à l'événement `second-instance`. Un contrôle d'existence du lecteur refuse un runtime absent avant la création du transport, et utilise le chemin d'erreur déjà présent pour fermer le claim cloud et informer l'utilisateur. Aucune copie fournisseur n'est changée.

35 tests contrôleur/IPC/transport/assets réussissent sur cette correction, dont l'absence du runtime et l'annulation pendant une ouverture. Le premier test d'annulation attendait encore l'ancienne séquence sans précontrôle ; sa synchronisation attend maintenant l'entrée réelle dans `openInput`. Le nouveau paquet et sa résistance à une seconde ouverture restent à vérifier avant publication. Le portable inspecté précédemment ne sera pas publié.

Reçus locaux ignorés par Git : `.codex-artifacts/windows-embedded-20261010/` (`diverse-baseline.safe.json`, `california-controls.safe.json`, `peaky-controls.safe.json`, `package-inspection.safe.json`, tests et contrôles CI). Aucune donnée de connexion ne fait partie du rapport ou du paquet. L'attachement PR757 a été refusé à la limite de 100 ; aucune pièce jointe retirée.
