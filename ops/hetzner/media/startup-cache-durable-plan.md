# Première minute : préparation d'une conservation privée durable

## Périmètre et état

L'utilisateur a demandé de préparer la solution **sans activer de stockage R2
payant**. Aucun déploiement Cloudflare, achat, upload R2 ou secret nouveau n'est
autorisé par ce plan. La production et la file actuelle de deux fichiers restent
inchangées. Le chiffrage et les limites des dates sont dans
[`docs/qa/2026-10-11-startup-cache-storage-estimate.md`](../../../docs/qa/2026-10-11-startup-cache-storage-estimate.md).

La branche prépare un premier étage local : `StartupCacheDiskStore`, facultatif,
qui stocke les préfixes HLS déjà validés. Il est désactivé si
`PRIVATE_STARTUP_CACHE_DISK_DIR` est absent. Les manifestes ne conservent aucune
URL fournisseur, aucun mot de passe ni l'indication opaque de livraison.

Les limites par défaut sont 32 Gio de média et manifestes, 2 Gio par propriétaire,
64 Mio décodés par entrée, 8 192 entrées et 32 Gio de disque libre protégé.
`PRIVATE_STARTUP_CACHE_DISK_MAX_BYTES` et
`PRIVATE_STARTUP_CACHE_DISK_OWNER_BYTES` règlent les deux quotas de stockage.
Le dossier doit être un volume privé persistant, distinct des sorties FFmpeg
temporaires. Ne pas activer ce dossier dans les services actuels sur la seule
base de ce plan : un canary complet reste nécessaire.

Le média est écrit et synchronisé avant publication atomique du manifeste.
Les écritures incomplètes, les fichiers corrompus et les révocations sont
refusés. Les quotas sont appliqués aussi pendant la restauration du répertoire.
La compression gzip est conservée seulement si elle gagne au moins 3 % ; la
décompression est bornée et chaque bloc restitué vérifié par son digest.
Les pistes, paquets, cadence et horloges du média sont conservés exactement.

## Raccordement R2 à réaliser

1. Réutiliser les conventions de transport authentifié et de checksum du
   client `privateMediaCacheStoreClient.js` et du Worker `workers/media-cache`.
   **Le protocole de cache HLS complet ne peut pas être réutilisé tel quel** :
   il exige une preuve de fin de source. Une minute partielle ne doit jamais
   être publiée comme un film complet ou sous son identité globale partagée.
2. Ajouter un protocole distinct de préfixe privé : manifeste signé avec une
   clé dédiée, protocole/version explicites, propriétaire, révision de source,
   fichier, choix de pistes, durée couverte et taille décodée. Utiliser des
   clés opaques dérivées de ces liaisons et du contenu, sans accès fournisseur.
3. Regrouper le média et ses petits fichiers en un objet borné, puis publier
   le manifeste en dernier. Deux objets par capture évitent un upload par
   petit segment. Une écriture interrompue laisse un objet orphelin non lisible,
   à supprimer par un nettoyage borné et vérifiable.
4. Conserver un index privé durable et un journal transactionnel des réservations
   de quota, commun aux Gateways. Une limite locale à chaque processus ou les
   seuls compteurs du Worker ne constituent pas un plafond global de dépense.
   Compter média compressé, manifestes, variantes, écritures en cours et orphelins.
5. Utiliser un bucket média privé et des permissions dédiées. Ne pas utiliser
   `norva-db-backups`, ses clés, son budget ou ses politiques de sauvegarde.
   L'API interne reste inaccessible au navigateur ; les lectures passent par
   les claims Norva et les contrôles de propriété/révocation existants.
6. Lire R2 dans une réservation du budget mémoire existant, décompresser avec
   borne stricte, vérifier le manifeste et les blocs, puis revalider le fichier
   actuel avant toute autorisation de lecture. Un échec R2 est un cache manqué,
   avec un repli ordinaire borné et sans ouverture concurrente du fournisseur.
7. Raccorder la suppression du compte et de la source au retrait de l'index,
   aux tombstones et au nettoyage des objets. Une révocation interdit
   immédiatement la lecture ; la suppression physique peut être asynchrone
   mais reste suivie et comptabilisée dans le quota.

La rétention des objets et la validité de la preuve de fichier doivent être
distinctes avant un archivage de plusieurs jours. Le prototype conserve encore
la fenêtre initiale de 10 minutes pour les échantillons, ou 30 minutes pour une
identité forte. Un redémarrage ne la prolonge pas. Quatre échantillons ne sont
pas une empreinte du fichier entier ; une conservation longue exige une
politique de revalidation supplémentaire et sa validation sur copies changeantes.

## File globale et priorité à réaliser

- Parcourir les catalogues visibles par pages bornées. Les coordonnées sont
  propriétaire/source/type/identifiant ; elles ne désignent pas une œuvre unique.
  Persister curseur, génération, tentative et état d'acquittement pour pouvoir
  reprendre après redémarrage sans perdre ni dupliquer une acquisition.
- Prioriser les reprises demandées récemment, puis les films sortis cette année
  et les épisodes dont la diffusion récente est vérifiée, puis l'année précédente.
  Utiliser l'année canonique ; la métadonnée est un secours seulement en son absence.
  Une contradiction ne promeut pas la copie. La date d'import ne prouve aucune sortie.
- Une année de série ne suffit pas à dater un épisode. Conserver une classe
  « date inconnue » et prévoir une part du travail pour les œuvres anciennes ou
  mal documentées, afin qu'elles ne soient pas exclues indéfiniment.
- Alterner comptes et sources. Un compte occupé est reporté, puis un autre compte
  libre peut être examiné. Ne pas ajouter une connexion fournisseur pour compenser
  sa lenteur. Limiter aussi CPU, encodages, I/O et mémoire au niveau du serveur.
- Réutiliser `startup-cache/prepare` : droits actuels, génération, profil exact,
  présence, activité et admissions atomiques. Ne jamais contourner le contrôle
  de présence en supprimant les leases. L'utilisateur préempte le travail ; la
  nouvelle lecture attend le drainage positif de la connexion de préparation.
- Un fichier sans profil complet, un épisode sans ligne exacte ou la route MP4
  native sont reportés avec une raison fixe. Le préfixe HLS ne crée pas un cache
  MP4 natif. Ces cas doivent être raccordés avant de promettre « tous les formats ».
- Une capture complète est acquittée seulement après publication durable et
  confirmation du drainage. Une erreur de transport ne déclenche pas une autre
  acquisition à l'aveugle. Aucune progression ni historique de visionnage n'est écrit.

## Conditions avant activation ultérieure

- Choix explicite de quota et coût ; stockage et opérations inclus. Aucune
  activation automatique payante à partir d'une variable d'environnement seule.
- Contrôle CI sur le commit exact ; canary Gateway et Worker isolés ; restauration
  après redémarrage et coupure d'écriture ; révocation, source modifiée et quotas.
- Tests publics sur MKV, MPEG-TS et les routes MP4 réellement raccordées : départ
  à zéro, reprise, sauts, changements de pistes et plusieurs minutes au-delà du
  cache. Mesurer première image **et** progression effective, pauses et images perdues.
- Vérification à l'écoute et des sous-titres. Aucun réencodage avec perte au raccord
  avant validation sur des codecs, résolutions, cadences et pistes variés.
- Déploiement progressif avec arrêt réversible du préchargement. Conserver le
  chemin de lecture ordinaire et observer quotas, orphelins et priorité utilisateur.

Cette préparation ne promet pas un débit futur suffisant : la première minute
absorbe une variation temporaire, puis la livraison doit soutenir la lecture.
