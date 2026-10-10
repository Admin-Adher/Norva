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

La correction ne modifie aucun fichier WebView partagé, aucun APK ni le site publié. Les vérifications Android de rendu ne sont pas requises pour ces changements limités au processus principal Electron.

## Vérification

**47 tests ciblés réussis**, zéro échec : démarrage cloud à profil vierge, reproduction de la barrière hébergée réelle avant la landing, retour à Home sans boucle, session hydratée expirée avec refresh conservée, callbacks, navigation externe, fermeture pendant une redirection et contrôles natifs de transport/IPC/drainage.

Le contrôle runtime à profil isolé, la construction CI et l'inspection du portable sont en cours. Aucun login utilisateur n'est automatisé. La version native.3 n'est pas encore publiée à ce relevé.
