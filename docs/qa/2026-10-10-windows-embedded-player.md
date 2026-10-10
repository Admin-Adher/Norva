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

## Optimisation des plages natives : comparaison à position constante

Le propriétaire demande d'accélérer la préparation Windows. Après son arrêt explicite des lectures, deux essais séquentiels de la même copie Last Bullet / MAX OTT utilisent la même position 965 s, le même lecteur et le même trajet. Les claims, heartbeats, expiration et drainage ordinaires sont conservés. Le banc temporaire ne remplace pas la vérification du portable distribué.

La mesure distingue headers, premier octet, corps complet, fin du corps et fermeture du ClientRequest. Les plages de 2 Mio reçoivent leur premier octet en 41–128 ms, mais terminent en 5,091–5,173 s ; fin du corps et fermeture sont presque immédiates après le dernier octet. Il n'y a donc pas cinq secondes de rétention après réception par le transport Electron. Le témoin local pleinement cadré répond également en quelques millisecondes sous Node24 et sous le vrai Node22 d'Electron39. Norva attend cependant chaque plage complète avant de la fournir à LibVLC, y compris pour une petite lecture d'en-têtes.

| Last Bullet, reprise 965 s | Grandes plages 2 Mio | Plages 256 Kio |
| --- | --- | --- |
| Premier compteur d'image depuis entrée native | 44,287 s | 4,858 s |
| Lecture ensuite | Témoin court | 153,624 s de progression observée |
| Octets livrés par requête complète | 2 Mio | 256 Kio |
| Connexions source en vol au maximum | 1 | 1 |
| Connexions après fermeture | 0 | 0 |

Les 64 derniers reçus de l'essai court montrent des plages complètes de 256 Kio en environ 113–143 ms dans les premières lignes conservées ; ce n'est pas une certification de toutes les plages antérieures, ni une attribution du ralentissement au fournisseur ou au relais. Le compteur `lostPictures` reste nul, l'audio est décodé, et la progression temporelle est observée ; la qualité à l'écoute reste non acceptée. Expiration HTTP200. L'essai A/B de 256 Kio conservait encore huit entrées (2 Mio) ; le code retenu conserve désormais jusqu'à 64 entrées, avec la même borne de **16 Mio** qu'avant.

Correction Windows : petites plages complètes de 256 Kio, cache de session LRU limité à 64 entrées et 16 Mio, et statistiques temporelles numériques sans donnée de connexion. Aucun octet partiel admis, aucune requête supplémentaire en parallèle, ni modification des claims, du Gateway, de l'Edge ou du relais. Les deux nouveaux tests couvrent la réduction du surchargement d'en-têtes, la conservation et l'éviction à 16 Mio, et les configurations excédant la borne. **35 tests ciblés réussissent** sur contrôleur/IPC/transport/assets. La suite CI et le portable de cette nouvelle correction restent à vérifier ; le paquet `80c0367ad` inspecté correspond seulement à la correction de lancement précédente.

Suite du banc sur le code `a8c39550d0ebed850c67dc01cdfc2f17fd30d492` : **6289 contrats CI réussis, 34 ignorés, zéro échec**, run 38040089877 ; cinq checks réussis, paquets Windows et Android compris. Les temps depuis le clic incluent l'entrée cloud : Last Bullet **45,116 s → 5,767 s** à 965 s. Le catalogue demandait 979 s après le témoin ; le banc comparatif remplace explicitement cette position par 965 s, uniquement dans le fixture QA. Le JSON conserve cette distinction.

California King, reprise 163 s : premier compteur en **8,301 s depuis le clic / 7,397 s depuis l'entrée native** ; saut réel vers 19:15, pause puis reprise, progression jusqu'à 1234,720 s. Deux expirations HTTP200, cache pic exact 16 Mio, une requête en vol et zéro après fermeture. Les sous-titres français réellement affichés restent ceux de la préférence conservée par l'essai précédent ; aucune piste audio remplacée. Le temps de saut ne constitue pas une mesure fine de la première image, plusieurs gestes de pause/reprise étant intervenus.

Peaky Blinders S1E2, copie de l'historique contrôlé : reprise 1049 s, premier compteur en **6,905 s clic / 6,000 s entrée native**. Bouton Recommencer puis Lire : première progression depuis zéro échantillonnée en **0,980 s après Lire**, jusqu'à 123,521 s avant l'arrêt du banc. Ce zéro est une reprise dans la session déjà ouverte, pas une première lecture à cache vide. Une expiration HTTP200, seize hits du cache, 16 Mio maximum, une requête en vol et zéro après drainage. `lostPictures=0` pour ces essais, sans certification de chaque frame ni validation à l'écoute. Tous les essais temporaires sont arrêtés.

Reçus locaux ignorés par Git : `.codex-artifacts/windows-embedded-20261010/` (`diverse-baseline.safe.json`, `california-controls.safe.json`, `peaky-controls.safe.json`, `package-inspection.safe.json`, `phase-app.safe.json`, `small-window-app.safe.json`, `phases-node.safe.json`, `phases-electron.safe.json`, tests et contrôles CI). Aucune donnée de connexion ne fait partie du rapport ou du paquet. L'attachement PR757 a été refusé à la limite de 100 ; aucune pièce jointe retirée.

## Portable optimisé inspecté

Artifact CI **11664884914**, code `a8c39550d0ebed850c67dc01cdfc2f17fd30d492`. Archive SHA256 `1537f370f8b9b6fce377a69f7e5c83c63a4fb3ea2ea0e8e2a21e676992b548b9`. EXE 239 558 491 octets, SHA256 `bbcb0d10eaed6c6f668777893239d9d633c100de89f4477d33091b90b05a95e3`. Six points d’entrée ASAR concordent avec le code ; runtime LibVLC x64, manifeste moderne, glyphes, police et licences présents. La configuration portable utilise un répertoire d’extraction unique. QA, secrets et reçu debug exclus. Le contrôle UI de ce binaire exact reste distinct de cette inspection et sera consigné avant publication.

Le portable final est copié dans Téléchargements sous le nom **Norva-Windows-2.1.5-native.2-x64.exe**, avec la même empreinte. Le premier lancement manuel observé utilisait encore l'ancien paquet : empreinte ASAR `0ad63c3e372e28f12ea6168ff5bc05da39a7b70c154f5c0237e21c78c3351aeb`, distincte de celle du paquet final. Cette fenêtre est fermée normalement, sans nouvelle lecture d'essai. Aucune fenêtre Norva n'est ouverte au dernier contrôle. Le lancement automatique ayant été refusé par le contrôle d'approbation, une ouverture manuelle du fichier final reste demandée ; les essais précédents ne sont pas présentés comme un contrôle de cet EXE exact.

La release `v2.1.5-native.2` est **préparée en brouillon, non publiée**. EXE, sources VLC 3.0.24 et LibVLCSharp 3.10.1, ainsi que SHA256SUMS sont téléversés ; tailles et digests retournés par GitHub concordent. Aucun lien de téléchargement public de cette version n'est revendiqué. PR757 reste en brouillon en attendant le contrôle final du portable et la publication autorisée.

## Ouverture manuelle du dernier portable : contrôle terminé

La suite ci-dessous remplace l'attente décrite dans les deux paragraphes précédents. Adrien ouvre le dernier fichier ; son répertoire d'extraction est indépendant, et son ASAR SHA256 `1544a7ba05ca5929b26286b376b3f1aa47990fac5a4f8c8ccfdda75d18f4c495` est identique à l'ASAR du paquet CI inspecté. Le runtime natif est présent. **Le contrôle UI de cet EXE exact est désormais effectué**, sans modification de son code ou de ses ressources.

Depuis l'historique, **Last Bullet affiche réellement la vidéo avec LibVLC intégré dans la fenêtre Norva**. Pause/reprise, menu audio (Track 1 — English sélectionnée), menu de sous-titres, navigation clavier Tab, plein écran et sortie par Échap inspectés. Le test ne change aucune piste. Un saut par la timeline vers **33:53** est suivi d'une reprise réelle et d'une progression jusqu'à **36:01**, soit environ **128 secondes après la cible**. Une intervention utilisateur ultérieure laisse la lecture en pause à 36:46 ; elle ne sert pas à certifier une séquence ininterrompue supplémentaire.

Le premier clic sur la carte et le second clic au centre du lecteur ont aussi mis la lecture en pause. Les états UI sont échantillonnés et peuvent refléter tardivement ces actions : ce relevé ne fournit **pas une nouvelle mesure précise du délai de première image**. Les mesures de 45,116 / 5,767 s restent celles du banc comparatif précédent. L'affichage et la progression ne certifient pas chaque intervalle vidéo, ni la qualité à l'écoute.

Retour au catalogue effectué ; une transition noire est observée immédiatement après la fermeture, puis le catalogue reparaît au contrôle suivant et l'historique contient la position actualisée. **Zéro processus natif de ce paquet reste après le retour**, et ASAR/exécutable natif sont toujours présents. Cela ne constitue pas une mesure indépendante de tous les claims fournisseur. Les essais sont arrêtés ; la fenêtre catalogue est laissée à Adrien. Reçus `final-portable.safe.json`, captures de lecture/plein écran/retour dans le répertoire local de preuve.

Les **cinq checks de `34e9bba22` réussissent**, Windows et Android compris. Le nouveau complément ne modifie que ce rapport et le JSON ; code du portable toujours `a8c39550d`. Le test final nécessaire à la publication est accompli. Le brouillon de release sera rendu public après intégration de PR757 ; l'état public sera vérifié séparément et consigné dans les reçus.
