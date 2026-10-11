# Cache privé durable : première minute et fenêtres de reprise

## État et autorisation

L'utilisateur demande la préparation **sans activer de stockage R2 payant**.
La PR786 reste en brouillon. Aucun bucket, secret, déploiement Cloudflare,
migration en production ou transfert vers un vrai R2 n'a été réalisé.
La file opérateur déployée contient toujours deux fichiers. Le code est
raccordé dans la branche, avec les options désactivées par défaut.

Le [rapport d'intégration](../../../docs/qa/2026-10-11-private-cache-r2-integration.md)
décrit les tests et limites. Le [chiffrage](../../../docs/qa/2026-10-11-startup-cache-storage-estimate.md)
distingue copies de catalogue, œuvres et fenêtres de reprise.

## Transport, compression et quotas

`StartupCacheDiskStore` prépare une archive bornée. Gzip niveau 6 est essayé
sur chaque capture ; il est conservé s'il économise au moins 3 %, sinon les
mêmes octets sont stockés sans recompression. Aucun réencodage audio/vidéo
supplémentaire, suppression de piste ou de cue. Décompression bornée et
vérification SHA-256 de chaque bloc restitué.

`StartupCacheR2Store` transmet média et manifeste signé, en deux objets. Le
Worker privé `workers/startup-cache` publie le manifeste après le média.
Aucune URL fournisseur, mot de passe ou indication opaque de livraison dans
les archives. Le navigateur n'accède pas directement au bucket : claims
Norva, contrôle de propriété et revalidation du fichier restent nécessaires.

Un Durable Object commun aux deux Gateways réserve transactionnellement les
octets et objets, incluant manifestes et écritures en cours. Quotas globaux
et par propriétaire positifs et explicites ; l'exemple les fixe à zéro.
Le nettoyage libère le quota après suppression R2 confirmée. Une opération
d'écriture dont la fin est inconnue conserve son quota ; une récupération
opérateur peut être nécessaire après interruption. Une erreur R2 n'autorise
pas de repli vers un ancien staging local potentiellement révoqué ailleurs.

Le staging local est supprimé après publication R2. Par défaut : 32 Gio / 2 Gio
par propriétaire pour les préfixes, 1 Gio / 128 Mio par propriétaire pour les
reprises, avec une réserve de 32 Gio libres dans les vérifications disque.
Les limites locales s'additionnent ; le quota R2 est commun. Les snapshots en
transit restent réservés dans le budget mémoire existant, sans copie illimitée.

## Conservation et revalidation

Rétention facultative jusqu'à sept jours, distincte de la validité de la preuve.
Une archive portant ETag fort, taille exacte et identité de livraison peut
redevenir candidate après redémarrage ; une lease exige encore une vérification
actuelle concordante. La candidature provisoire est bornée à 30 secondes.

La preuve par quatre échantillons conserve sa validité de dix minutes. Elle
n'est pas une empreinte du fichier entier et ne certifie pas une réutilisation
sur plusieurs jours. Une telle archive ancienne reste refusée. Les fournisseurs
sans ETag fort ou taille fiable limitent donc la couverture réelle.

## File globale de première minute

La migration `20261011203000_startup_prefix_global_queue.sql` ajoute des
curseurs durables par source et une file bornée à 8 192 coordonnées. Films et
épisodes exacts de tous les comptes visibles sont énumérés par pages de 64,
avec reprise après redémarrage. Sources supprimées, invisibles ou générations
obsolètes sont refusées. Le curseur ne repart pas du début de l'année récente
chaque fois qu'une classe ancienne est en cours de parcours.

Quatre pages concernent l'année actuelle, une l'année précédente et une les
dates anciennes/inconnues. L'année canonique prime ; `metadata.year` n'est
utilisé pour un film qu'en son absence. Une date de diffusion explicite date
un épisode : année de série et date d'import ne la remplacent pas. Comptes
et sources alternent ; les catalogues anciens restent parcourus.

L'Edge de service et le worker opérateur réutilisent `startup-cache/prepare` :
présence, activité, admissions fournisseur atomiques, profil exact et droits
actuels. Une lecture utilisateur préempte le travail ; son démarrage attend
le drainage positif du transport. Le travail n'est acquitté qu'après ce
même drainage. Une réponse ambiguë suspend la boucle et laisse expirer sa
réservation ; aucune autre acquisition n'est lancée à l'aveugle. Aucun
historique de visionnage n'est écrit.

## Reprises : A → B et fin de VOD

`PrivateResumePersistence` raccorde les captures HLS ordinaires au même
stockage, dans un espace distinct, avec une option propre. Données déjà lues
uniquement : aucune deuxième connexion fournisseur ni deuxième décodage complet.

- Sans avancée de position, A reste disponible.
- Une position authentifiée ayant avancé retire A des reprises futures et du
  stockage. La lease locale déjà utilisée continue à servir ses segments :
  la suppression ne coupe pas la lecture.
- À l'arrêt explicite, B est capturé après drainage de la source et de l'encodeur.
  Son archivage est asynchrone ; la fermeture de session et le slot fournisseur
  n'attendent pas l'upload R2.
- À **90 % ou plus** de la durée serveur connue, aucune nouvelle fenêtre n'est
  archivée et l'ancienne est supprimée. La première minute reste distincte.
- Une seule fenêtre durable par propriétaire et fichier ; un changement de
  piste remplace l'ancien snapshot. Les pistes restent exactement conservées.
- Une barrière durable refuse la republication tardive de A après suppression.
  Le quota n'est libéré qu'après confirmation de la suppression physique.
- Durée inconnue : pas de nouvel archivage long de reprise. Le cache mémoire
  ordinaire conserve ses règles lorsque ce raccord est désactivé.

## Configuration inactive

Voir `startup-cache-storage.env.example` et `workers/startup-cache/wrangler.example.toml`.
Ne pas les utiliser pour déployer maintenant.

- Gateway : `PRIVATE_STARTUP_CACHE_R2_ENABLED` et
  `PRIVATE_STARTUP_CACHE_R2_ACTIVATION_APPROVED`, URL privée, bearer dédié,
  clé HMAC dédiée, staging et rétention explicitement configurés.
- Reprises : `PRIVATE_RESUME_CACHE_PERSISTENCE_ENABLED`, dossier distinct et
  `PRIVATE_RESUME_CACHE_RETENTION_SECONDS`, avec le contrôle du propriétaire actuel.
- Worker : deux options d'activation, quotas positifs, bucket privé et DO dédiés.
  Ne pas réutiliser le bucket de sauvegarde, ses secrets ni ses budgets.
- File : `NORVA_STARTUP_CACHE_GLOBAL_QUEUE_ENABLED` dans Edge et worker,
  préchargement et tous les propriétaires authentifiés explicitement autorisés
  côté Edge/Gateway. Par défaut, file locale historique.

## Avant une activation ultérieure

1. Budget accepté incluant R2, requêtes, Worker/DO, préparation et staging.
2. CI du commit exact et canary public isolé avec claims réels. Les tests locaux
   Miniflare/PGlite ne valident ni la configuration Cloudflare ni la charge réelle.
3. MKV, MPEG-TS et MP4 sur route HLS : départ, reprise, sauts, pistes, continuation
   au-delà du cache, suppression à 90 %, redémarrage et révocation.
4. La route **MP4 native par plages d'octets** et les caches conservant seulement
   l'input ne sont pas raccordés à ces archives HLS : travail distinct nécessaire.
5. Invalidations de source et de compte, livraison changeante, durée absente et
   preuves échantillonnées à valider sur copies réelles.
6. Écoute et sous-titres réels. L'égalité des octets prouve la transparence de gzip,
   pas la qualité du lecteur ou d'un encodage précédent.

La minute préparée absorbe une variation temporaire de débit ; elle ne compense
pas durablement une livraison inférieure au débit nécessaire à la vidéo.
