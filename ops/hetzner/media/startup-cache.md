# Cache privé des 60 premières secondes — pilote

## Périmètre

Extension du cache HLS de reprise du Gateway. Désactivée par défaut : Edge et
Gateway doivent tous deux recevoir `PRIVATE_STARTUP_CACHE_ENABLED=true` et
`PRIVATE_STARTUP_CACHE_OWNER_HASHES`, une liste explicite de SHA256 des propriétaires.
Une liste vide ne généralise pas le pilote.

Le pilote traite une file privée de 1 à 8 fichiers du catalogue, un seul à la fois.
Il couvre les fichiers Xtream actuellement détenus, avec profil exact complet,
taille connue et pistes identifiées. Un épisode doit posséder sa propre ligne,
son parent et son profil : un profil de série ne suffit pas. Les autres fichiers
sont reportés. Pas de parcours automatique de tout le catalogue.
Les graphes de sous-titres doivent être exacts et entièrement cacheables dans la
limite configurée ; un bootstrap vide ne certifie jamais leur couverture.

## Admission et priorité

- `POST /norva-playback/startup-cache/prepare` exige `NORVA_BACKFILL_TOKEN`.
  Entrée : `userId`, `sourceId`, `itemType`, `itemId` uniquement. Aucune URL ni
  description de codecs ne peut être fournie par le demandeur.
- Résolution du fichier strictement en base, sans livraison Discovery ni appel
  fournisseur avant admission. Vérification des droits, visibilité, génération,
  révision, profil et circuit. Présence récente, activité catalogue, lecture et
  préparation de sous-titres suspendent le travail.
- Réservation atomique du compte fournisseur et du sémaphore de sonde existants.
  Renouvellement/revalidation toutes les deux secondes. Budget média de 110 s.
- La lecture utilisateur préempte le travail sur les deux Gateways via le chemin
  de drainage existant. La nouvelle connexion attend la fermeture effective de
  l'ancienne. Une fermeture incertaine conserve l'exclusion jusqu'à expiration ;
  un échec local de drainage bloque les nouvelles préparations de ce processus.
- Le préchargement ne crée ni lecture utilisateur, ni progression, ni historique.
  Il est exclu des rapports d'activité de lecture pour ne pas se bloquer lui-même.

## Conservation et lecture

Les 60 secondes doivent être finalisées depuis zéro, avec un graphe audio/vidéo
et des sous-titres couverts. Un téléchargement partiel ou interrompu est refusé.
La fermeture FFmpeg n'est jamais interprétée comme une fin de film.

Le préfixe partage le budget du cache de reprise : 256 Mio par processus et
64 Mio par fichier dans la configuration actuelle. La capture réserve aussi ses
copies temporaires. Elle n'évince jamais une reprise existante pour faire place
à un préchargement. Elle est privée au propriétaire, à la source, à sa révision,
au fichier et aux pistes. Aucune redistribution entre comptes.

Au démarrage à zéro, la lecture utilise les contrôles de revalidation et de
raccord existants, puis poursuit la réception. À une autre position, elle utilise
le cache de reprise habituel. Une identité différente invalide la réutilisation.
Après validation d'un préfixe MKV à zéro, le même broker sérialisé sert le raccord
ou le repli : la lecture ne crée pas une seconde adresse de livraison.
Pour un profil Matroska complet à une piste audio sans sous-titres, le préfixe
est vérifié avant l'ouverture d'une réponse de démarrage froide. Les autres
graphes gardent l'enrichissement ordinaire ; un refus d'identité ferme le broker
de validation avant le repli. Les MP4 natifs ont une voie distincte du cache HLS.
TTL existant : 30 min avec identité forte, 10 min avec échantillons récents.
Le runner évite de télécharger à nouveau un préfixe encore valable.

Ce stockage mémoire borné ne conserve pas une minute de chaque titre d'un grand
catalogue. Une minute ne compense pas un débit durablement inférieur au débit
du film. Les gains et le raccord doivent être mesurés sur les copies réelles.

## Runner opérateur

`startup-cache-worker.mjs` peut être lancé une fois (`--once`) ou en boucle.
La file JSON privée contient uniquement les quatre coordonnées autorisées.
Ne pas la committer. Configuration privée du service :

- `NORVA_STARTUP_CACHE_TARGETS_FILE` : chemin absolu de la file privée ;
- `NORVA_STARTUP_CACHE_ENDPOINT` : URL interne Edge finissant par
  `/norva-playback/startup-cache/prepare` ;
- `NORVA_BACKFILL_TOKEN` : jeton opérateur existant.

Le modèle `norva-startup-cache.service` attend le code dans
`/opt/norva-startup-cache` et la configuration dans `/etc/norva/startup-cache.env`.
Ne pas l'activer avant validation du pilote. Sur SIGTERM il termine l'essai
déjà envoyé et laisse confirmer le drainage ; aucun nouveau fichier n'est lancé.
Les journaux donnent seulement l'ordinal et un statut fixe, sans accès fournisseur.

## Retour arrière

Arrêter le runner et attendre la fin de son essai ; retirer le drapeau Edge puis
Gateway, après vérification que `privateStartupHlsCache.preparation.active`, les
pompes d'entrée et les encodeurs sont à zéro. Le cache de reprise existant reste
configuré. Ne jamais effacer une réservation incertaine sans preuve de fermeture.
