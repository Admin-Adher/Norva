# Windows : première connexion et retour à Accueil

## Signalement et causes

Adrien voit à la première ouverture une inscription d'administrateur de hub, puis une landing après sa connexion Norva. Le problème n'est plus visible dans sa session déjà ouverte ; sa session n'est pas déconnectée pour le reproduire.

Le paquet native.2 démarre par défaut à `http://127.0.0.1:<port>/app`. Sans configuration ni compte local, `app.js.checkAuth()` mène à `login.html`, dont le premier état propose de créer l'administrateur du hub. Les essais précédents utilisaient une entrée cloud explicite et ne couvraient pas cette première installation.

Une seconde erreur existe à l'entrée cloud : la barrière de session de `app.html` reconnaît les shells Android, mais pas Electron, et renvoie une installation sans session à `/`. En outre, un retour explicite vers `/` après connexion mène à la landing. L'application Windows doit entrer dans le catalogue et utiliser Norva Account pour l'authentification.

## Correction native.3

- Entrée cloud par défaut : `https://norva.tv/app#home`. Le serveur intégré continue à fournir le service de transport. Une entrée de hub auto-hébergé reste une configuration explicite `NORVA_DESKTOP_URL`.
- La navigation principale Windows intercepte la landing et l'ancien login de l'origine cloud exacte et ouvre Norva Account dans la même fenêtre, avec un retour explicite à `/app#home`.
- Un retour absent, vers la landing/le login/l'account lui-même ou hors origine est remplacé par Home. Les destinations intentionnelles de catalogue, d'abonnement et de pairing restent conservées.
- Les paramètres de récupération, de gestion du compte, d'OTP et les fragments OAuth restent intacts. Le host ne lit ni ne copie les identifiants de session. Un iframe ne redirige pas la fenêtre principale.
- Navigation externe et IPC conservent la limite de l'origine exacte. Aucun changement du lecteur, du transport média, des pistes, du cache ou des comptes fournisseur.

La correction ne modifie aucun fichier WebView partagé, aucun APK ni le site publié. Les vérifications Android de rendu ne sont pas requises pour ces changements de démarrage Windows.

## Incident du banc : port déjà occupé

Pendant la vérification isolée, une erreur réelle `EADDRINUSE :::3002` apparaît. Adrien fournit aussi sa capture. `findFreePort()` vérifiait l'adresse IPv4 `127.0.0.1`, alors que le serveur ouvrait ensuite une écoute générique IPv6/dual-stack. Les deux vérifications ne portaient pas sur la même adresse ; le port pouvait donc être disponible au contrôle et occupé au démarrage.

Le processus Windows impose maintenant `NORVA_SERVER_HOST=127.0.0.1` avant de charger le serveur ; `server/index.js` utilise cette adresse lorsqu'elle est explicitement configurée. Le serveur autonome conserve son écoute par défaut. Le test exécute le démarrage Electron avec des dépendances bornées et vérifie la concordance probe/serveur ; le test de la route réelle du serveur contrôle aussi l'adresse passée à Express. Aucun port d'un autre processus n'est libéré de force. Le premier démarrage avec un simple argument Chromium de profil n'est pas accepté comme preuve de profil vierge : le wrapper de contrôle fixe explicitement `userData` et `sessionData` avant le lancement.

## Vérification

**49 tests ciblés réussis**, zéro échec : démarrage cloud à profil vierge, reproduction de la barrière hébergée réelle avant la landing, retour à Home sans boucle, session hydratée expirée avec refresh conservée, callbacks, navigation externe, fermeture pendant une redirection, adresse serveur et contrôles natifs de transport/IPC/drainage. Les événements modernes Electron portant l'URL dans leurs détails et les anciens arguments séparés sont couverts. Les chemins sans extension `/account`, `/login` et `/index` sont aussi normalisés, puisque le serveur publié redirige les chemins `.html` vers ces chemins.

Le wrapper de contrôle fixe explicitement `userData` et `sessionData` dans un répertoire isolé. Le reçu constate `/app#home`, puis `/account`, puis `/app#home` entre 10:35:02 et 10:35:21 UTC. Aucun identifiant n'est saisi par l'agent et ces routes seules ne démontrent pas un parcours complet d'authentification automatisé. Le banc de développement signale une dépendance SQLite native absente et un nom mDNS déjà utilisé ; sa validation ne remplace pas le contrôle du portable construit en CI.

La CI finale du code `f5865b393602e356bb5021197c3d6c6b9698e69f` est réussie : 6 300 tests, 34 ignorés, contrats et paquets Phone/TV/Windows. Le portable x64 final mesure 239 575 482 octets ; SHA256 `3614569b4726cf4c10c00a4dec4cd08f0c3974319a8ae06a6998d64ef29e7786`. Huit sources embarquées correspondent au commit, les DLL LibVLC, polices, icônes et licences sont présentes ; artefacts QA et données de session exclus.

Adrien a ouvert ce portable. Le processus réel et son ASAR sont vérifiés en version native.3, avec entrée cloud par défaut. Sa session existante ouvre le catalogue Séries ; le bouton Accueil conduit à `/app#home`. Les affiches signalées (Farming Life, Isekai Farming, Last Bullet, California King, Breaking Bad), le hero et l'avatar se chargent dans cette fenêtre. Cette inspection conserve la session ; elle ne revendique pas une inscription ou une connexion réelle automatisée à profil vierge. Capture : `.codex-artifacts/windows-login-20261010/native3-home.png`.

PR758 intégrée par `b612d1016f07dc98b3401d09c7c4966585660a43`. [Native.3 publiée](https://github.com/Admin-Adher/Norva/releases/tag/v2.1.5-native.3) à 11:13:52 UTC. Le digest GitHub du portable correspond au SHA256 inspecté ; sources VideoLAN et sommes de contrôle jointes. Préversion portable non signée. Aucun nouvel essai de fluidité ni de qualité à l'écoute.

## Filtres Séries : diagnostic et correction du 10 octobre

Le menu vide ne vient pas du moteur LibVLC. L'API `media-language-facets` renvoie 500 après environ huit secondes sur les deux réplicas Edge pour Séries, alors que Films répond. La requête des déclarations audio propres au compte dépasse le budget. Les sous-titres ne sont alors pas projetés dans le menu, malgré une requête de sous-titres isolée fonctionnelle.

Migration `20261010111000_series_declared_language_facets` : candidats Séries regroupés, codes distincts canonicalisés une seule fois et réglage du plan limité au nouveau helper. Appartenance exacte, compte/source/génération, identité fournisseur, fingerprint, visibilité et précédence des observations sont conservés. La branche Films garde le corps SQL antérieur. Les appels restent restreints au service role, sans élargissement d'accès utilisateur.

Comparaison réelle des anciennes et nouvelles requêtes sur les quatre sources, Films et Séries : zéro différence dans les huit comparaisons. Fixture PGlite exécutant la migration : rejets d'appartenance, observations prioritaires, visibilité, lifecycle, isolement et branche Films vérifiés. Les 41 contrôles SQL obligatoires de CI réussissent. Le premier contrôle CI suivant échoue uniquement sur le manifeste d'assets i18n périmé ; celui-ci est régénéré dans le commit suivant.

Validation temporaire par session, sans modifier les fonctions publiques : audio et inconnus passent en 3,96–6,69 secondes. Migration appliquée atomiquement par son rôle propriétaire à 11:17:30 UTC ; définition précédente sauvegardée. Deux premières tentatives s'arrêtent sans changement durable (différences de fins de ligne dans la garde puis rôle non propriétaire). La stack n'a pas de registre applicatif de migrations ; le reçu d'état effectif est conservé.

Contrôle API après application, deux réplicas : six réponses 200. Toutes sources Séries : 43 langues audio et 34 langues de sous-titres, 6,28/7,19 secondes ; source Strng : 35/16 options, 3,75/3,95 secondes. Films : 75/50 options, 5,36/5,91 secondes. Aucun média fournisseur demandé. Dans native.3, les deux menus Séries sont ouverts et contiennent de nouveau leurs langues et compteurs ; captures `native3-series-audio.png` et `native3-series-subtitles.png`.

Ces timings sont des mesures ponctuelles, proches du budget pour toutes sources ; ils ne garantissent pas chaque charge future. Reçus : `declarations-compare.safe.json`, `facets-temporary-validation.safe.json`, `facets-deployed.safe.json` et `facet-runtime.safe.json`, dans `.codex-artifacts/windows-login-20261010/`.

## Recherche mobile

La projection phone partagée retire Search de la barre du bas et garde l'action du header. Web mobile : cinq destinations ; shell Phone : six avec Téléchargements. Le bouton du header a une zone de 44 × 44 CSS px sur mobile. Contrats du modèle et inspection navigateur à 480 CSS px réussis : un seul bouton Search, zéro Search en bas, focus du champ après clic et aucun débordement horizontal.

Le replay Android utilise le vrai header, le modèle, l'adapter et la feuille de style dans un System WebView visible, sans compte ou média fournisseur. Un premier échec révèle le header de 40px ; corrigé. Un second échec montre que le focus JavaScript ne prouve pas l'ouverture du clavier : le banc utilise maintenant une vraie touche sur le champ et exige `WindowInsets.Type.ime()` visible avant le contrôle. La validation finale à navigation gestes/trois boutons et échelles 1/1,3 reste en cours à ce relevé. PR759 en brouillon ; le retrait mobile n'est pas encore publié.
