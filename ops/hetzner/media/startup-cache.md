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
est vérifié avant l'ouverture d'une réponse de démarrage froide. Le même ordre
s'applique à un MPEG-TS fini dont le profil serveur daté atteste la taille,
la durée, H.264 et une unique piste audio connue, sans sous-titres. Un profil TS
partiel `gateway_inband` reste exclu. Les autres graphes gardent l'enrichissement
ordinaire ; un refus d'identité ferme le broker de validation avant le repli.
Les MP4 natifs ont une voie distincte du cache HLS. Quand la résolution serveur
sélectionne cette voie pour la lecture automatique, la préparation répond
`native-mp4-prefix-unavailable` avant réservation ou ouverture fournisseur.
Elle ne prépare plus une minute HLS que cette lecture ne pourrait pas utiliser.
Cela ne constitue pas un cache MP4 natif ; les MP4 qui exigent encore une
adaptation HLS conservent leur admission ordinaire.
Dans le seul pilote propriétaire du préchargement, le transport `native-browser-mp4`
essaie des plages séquentielles initiales de 1 Mio au lieu de 256 Kio, après
sa petite lecture de confirmation. Cela réduit les allers-retours nécessaires
aux index MP4 situés en fin de fichier. Le premier sondage, la sérialisation,
les contrôles d'identité restent inchangés. Les clients
natifs Windows/Android et les autres comptes gardent leur politique actuelle.
Dans ce même périmètre, une demande explicite de fin de fichier de 4 Mio au
plus peut être regroupée après le sondage initial, pour recevoir l'index MP4
sans plusieurs allers-retours. Le fichier entier, les plages plus grandes ou
ne finissant pas à EOF gardent le découpage ordinaire. Une seule connexion
fournisseur et la validation intégrale avant mise en cache restent obligatoires.
Ce réglage est expérimental : les sauts MP4 réels restent irréguliers, et il ne
crée pas de minute MP4 préchargée.

Dans ce même pilote, la fenêtre active du broker MP4 passe à **64 Mio** pour
conserver les images clés récentes lorsque la réception avance devant le lecteur.
La base et le plafond séquentiels passent à **2 Mio**, avec première plage de
256 Kio et première continuation de 1 Mio ; la fin d'index explicite reste bornée
à 4 Mio. La base doit aussi être réglée : un plafond inférieur à la base est
normalisé vers celle-ci par le broker. Cela borne les données abandonnées lors
d'un saut, au prix de davantage d'allers-retours. Le cache conservé après
fermeture reste à **32 Mio**, dans son budget global et TTL existants.
Les lecteurs finis, y compris MP4, ne relisent plus un suffixe complet déjà
présent : ils reçoivent seulement le trou puis réutilisent ce suffixe. Aucun
trou ni fragment interrompu n'est déclaré valide. Ces réglages ne garantissent
pas que le débit fournisseur reste suffisant pendant toute la lecture.

Dans le même pilote, une fermeture ordinaire de `native-browser-mp4` conserve
désormais jusqu'à 32 Mio de plages complètes dans le cache privé de reprise
existant, avec en-têtes et index terminal bornés. Le transport est fermé avant
publication. Le nettoyage distingue la fermeture du lecteur d'une révocation
globale ; cette dernière ne publie aucun nouvel élément. L'époque du cache
empêche aussi une publication tardive après invalidation.

Une réouverture obtient son claim ordinaire et vérifie quatre plages fraîches,
la taille, la cible et la liaison propriétaire/source/révision avant de réinjecter
les octets. L'indication opaque de livraison produit une copie à usage unique
pour chaque vérification, sans prolonger son âge. Une vérification indisponible
n'autorise aucune réutilisation et conserve seulement le candidat jusqu'à son
expiration initiale. Ce chemin partage le budget existant de 256 Mio et le TTL
récent de 10 minutes. Il ne prépare pas de préfixe MP4 en arrière-plan.

`GET /sessions/:id/native-coverage` exige la capacité opaque de la session active
et le périmètre du pilote. La route consulte seulement les plages complètes
encore présentes dans le broker ; elle n'ouvre pas de connexion fournisseur.
L'index MP4 peut être assemblé à partir de plages adjacentes complètes, jamais
d'une réponse partielle ou d'un trou. Son analyse est bornée à 8 Mio d'index et
un million de paquets au total. Cette preuve situe des octets DTS, sans garantir
leur décodage ni le débit futur. WatchPage n'utilise pas encore cette preuve
pour une politique générale de reprise ; le seuil de 24 secondes reste limité
au banc de comparaison.
Une vérification fraîche indisponible refuse la lecture du préfixe et conserve
seulement les données privées jusqu'à leur expiration initiale. La même création
ne retente pas la vérification pendant son repli ; le prochain essai doit réussir
les quatre lectures fraîches. Un changement d'identité invalide toujours le cache.
L'indication privée de livraison du préfixe délivre un jeton à usage unique
pour chaque nouvelle validation. Le premier démarrage ne consomme plus
l'indication nécessaire au suivant. Chaque jeton garde l'expiration d'origine,
et les mêmes contrôles de propriétaire, source, route, taille et User-Agent.
L'identité et les quatre échantillons restent vérifiés à chaque création.
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
