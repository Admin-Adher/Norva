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

Les quatre tâches CI du commit intermédiaire c9d0746 sont réussies (contrats, Phone, TV et Windows). Le paquet final doit inclure le dernier traitement des événements Electron et des chemins sans extension. Sa construction et son inspection restent à terminer ; native.3 n'est pas encore publiée à ce relevé.
