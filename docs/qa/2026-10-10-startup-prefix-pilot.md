# Préchargement privé de la première minute

## Demande et périmètre

Implémenter sur le pilote une préparation des 60 premières secondes lorsque le
compte fournisseur est libre, avec priorité à toute lecture utilisateur.
Extension du Gateway et du cache de reprise déployés ; aucun AVPlayer/libmedia,
aucune interface ou application native modifiée.

## Code

- Entrée opérateur Edge authentifiée, coordonnées du catalogue uniquement.
- Résolution hors réseau de fichiers Xtream détenus, profil exact complet et
  revalidation de visibilité, génération, révision et droits.
- Présence/activité récente bloque la préparation ; deux verrous distribués
  existants protègent le compte et la sonde fournisseur.
- Même parcours FFmpeg que la lecture ordinaire, budget de 110 secondes,
  contrôle toutes les deux secondes, une préparation au maximum.
- Préemption utilisateur raccordée aux deux routes de drainage existantes.
  Exclusion conservée si fermeture non confirmée.
- Préfixe séparé de la reprise, dans son budget mémoire actuel ; aucune éviction
  d'une reprise pour réserver de la mémoire au travail de fond.
- 60 secondes finalisées depuis zéro, identité et sous-titres vérifiés. Un fichier
  partiel n'est jamais publié comme un film terminé. TTL et revalidation existants.
- Runner serialisé sur une file privée de huit fichiers maximum, refresh borné,
  arrêt propre et journaux sans identifiants ni accès fournisseur.

## Validation locale

28 tests dédiés au préfixe, admission Edge et runner réussis. La suite ciblée
inclut aussi le cache de reprise, les sous-titres, l'annulation des préparations
et les règles de préemption existantes. Les contrôles de syntaxe passent.

Une première suite locale globale sans dépendances a échoué pour modules absents.
Les dépendances ont ensuite été installées sans scripts d'installation. Trois
harnesses de la suite globale nécessitaient le nouveau coordinateur lors de
l'extraction des routes : corrigés, leurs six essais réussissent.
La validation globale est exécutée par la CI Linux.

La suite dédiée et les contrats de préemption, de cache et de sous-titres comptent
désormais **89 tests réussis**. Le test HTTP du cache complet passe (2,8 s).
La première CI a révélé quatre problèmes de harness : une extraction de fonction
englobait la nouvelle route, et trois tests de fermeture omettaient le nouveau
callback. Les harnesses sont corrigés ; les dix tests concernés passent.
Les contrats CI du commit `13ebc744a71071348c551432ac0f4d62cd4d905e` réussissent.
Les contrats du commit `1b9c5b3ed1e8cc03d3c3b11d4bd25e54fab7ae10`
réussissent aussi : **6 332 tests réussis, 35 ignorés**, région et syntaxe
validées. Les deux paquets Android passent ; Windows encore en construction au
contrôle. Le dernier renforcement des verrous (`3162cc1bd92fb76cdb166e79e9a8373b8fbf118a`)
passe aussi : **6 334 tests réussis, 35 ignorés**, contrats, région et syntaxe
validés ; les paquets Phone, TV et Windows réussissent.

La suite Windows avec les dépendances Gateway passe 6 277 tests, mais onze
contrôles échouent pour runtime ou outils absents (`miniflare`, bash, etc.).
Ce résultat n'est pas présenté comme une validation globale réussie.

## Essais réels, canary isolé

Les essais utilisent l'entrée opérateur Edge complète, la base actuelle et des
copies réelles du catalogue. Gateway et Edge temporaires privés, mêmes moteurs
et paramètres de production ; aucun routage utilisateur modifié.

- **Vice-versa 2** : profil `gateway_inband` avec inventaire incomplet
  (`metadataComplete=false`) ; préparation refusée avant connexion fournisseur.
- **Conclave** : une synchronisation du catalogue récente reporte la préparation.
  Aucun événement de lecture récent, aucune session utilisateur active. Ce signal
  d'activité ne signifie pas que l'utilisateur regarde un film.
- **Abduct** : tentative clôturée en 57,3 s, capture refusée
  (`asset-unavailable-or-budget`). Pompes, encodeurs, sessions et réservations
  mémoire à zéro après clôture. Le motif doit être précisé avant activation.
- **Abduct, recontrôle instrumenté** : 62,187 s de vidéo finalisée, mais les huit
  playlists de sous-titres restent des bootstraps. Aucun cache publié ; arrêt au
  budget de 110 s et connexion/encodeur libérés. Les graphes incomplets, non
  extractables ou dépassant la limite de pistes sont désormais refusés avant
  connexion, plutôt que de préparer un préfixe inutilisable.
- **Conclave** : premier rejet `subtitle-coverage-or-revoked`, puis attente de la
  couverture avant fermeture. Budget de 110 s atteint ; aucune publication.
- **Lost on a Mountain in Maine**, copie anglaise Matroska à une piste audio et
  sans sous-titres : **60 s acceptées**, 4 708 836 octets conservés, identité par
  quatre échantillons récents. Nouvelle préparation de fond réussie en **24,1 s** ;
  pompes, encodeur et sessions à zéro. Ce délai est une préparation de fond,
  pas un délai de démarrage utilisateur.

Le parcours authentifié de consommation a révélé un défaut propre au prototype :
la validation du préfixe à zéro passait par le broker de plages, puis revenait au
chemin linéaire, réservé jusque-là aux démarrages à zéro. Ce second trajet pouvait
obtenir une autre adresse de livraison et déclencher `VOD_CHANGED`. Le broker
validé reste maintenant utilisé à zéro, y compris après refus d'un ancien préfixe.
Le départ ordinaire sans candidat reste inchangé. Test de régression réussi.

Après correction du broker et de l'identifiant de route du banc Edge, la
consommation authentifiée de **Lost** réutilise les quatre échantillons et le
préfixe de 60 s. Session prête en **10,371 s**, dont **7,381 s** de revalidation.
Le lecteur FFmpeg reçoit et décode **140,003 s** : réception réelle au-delà du
préfixe. Des avertissements de continuité TS et DTS sont relevés au raccord ; le
contrôle navigateur doit établir leur effet. Cette disponibilité serveur ne
constitue pas une mesure de première image ni une validation de fluidité/écoute.
Expiration ordinaire confirmée, sessions/pompes/encodeurs à zéro.

Une préparation réelle de **Conclave** a ensuite été interrompue par la demande
authentifiée de **Lost**. Le coordinateur rapporte une préemption, aucune capture
partielle et aucun échec de drainage ; pompes, encodeurs et sessions de fond à
zéro avant l'admission utilisateur. Nouvelle session prête en **5,875 s** sans
préfixe disponible. Le premier banc navigateur refusait l'URL à cause d'une
assertion de chemin trop étroite : correction du banc uniquement, sans changement
du Gateway.

Le garde de préchargement utilise le RPC strict des tâches de fond pour la source
exacte, qui bloque sur erreur de lecture. Le renouvellement exige aussi les deux
verrous encore présents et valables : un verrou de sonde révoqué ne peut pas être
recréé par le contrôle. Deux régressions supplémentaires réussissent.

### Navigateur, copie Matroska réelle

Après une nouvelle préparation réussie en **23,904 s**, le lecteur de contrôle
HLS.js ouvre Lost depuis zéro : session prête en **9,109 s**, premier événement
`playing` en **9,936 s** depuis le clic, puis **245,912 s de vidéo** parcourues.
Deux attentes de **280 ms** et **522 ms** surviennent vers 30 et 35 s ; aucune
attente supplémentaire après le raccord à 60 s jusqu'à la fermeture volontaire.
Écart maximal de callback de frame : 430 ms. Aucun défaut fatal ni erreur de
la balise vidéo. Les événements non fatals de trou initial et de buffer sont
consignés, pas ignorés.

Ce lecteur utilise le parcours Edge authentifié et les mêmes moteurs de
production dans le canary privé. Il n'est pas la WatchPage complète. Aucun
compteur de frames perdues exploitable ni validation à l'écoute n'est revendiqué.
La copie démarrait déjà rapidement sans préfixe : ces positions et essais ne
démontrent pas un gain comparatif de démarrage.

### Extension aux formats réels

Les formats sont identifiés par les profils exacts de copies détenues, jamais
par l'extension annoncée. Les requêtes de sélection restent en lecture seule,
bouclées sur les sources du compte ; aucun fichier synthétique n'est utilisé.

- **KU - Jolt (2021), Strng, MP4 H.264/AAC** : tentative de préparation clôturée
  en **19,801 s**, sans préfixe. L'analyse MP4 dépasse le délai de sonde en lisant
  les métadonnées de fin ; le broker a reçu l'en-tête et commencé plusieurs Mio
  de la fin du fichier. Aucune publication partielle ni ressource active restante.
- **MA - Kumari (2022), Dino, MPEG-TS H.264/AAC** : minute de fond préparée en
  **20,485 s**, **4 040 496 octets** acceptés, quatre échantillons d'identité.
  L'ouverture suivante démarre en **12,306 s** et parcourt **136,446 s**, mais
  **ne réutilise pas le préfixe** : validation fraîche indisponible. Aucun gain de
  cache TS n'est revendiqué. Une coupure de callback de frame de 10 s apparaît
  malgré une progression temporelle régulière ; la fluidité n'est pas certifiée.
  Après cette lecture, le profil exact visible est passé de `gateway_probe` à
  `gateway_inband` avec `metadataComplete=false` : le préchargement suivant est
  reporté. Le contrôle n'a ni inventé cette complétude ni effacé les présences.

### Délai malgré un préfixe présent

La revalidation récente utilisait quatre transports successifs. Le changement
`f0412db29` conserve une seule connexion privée pour les quatre réponses exactes
entièrement consommées ; son transport reste fermé avant l'admission du décodeur.
Les sondes de langue non liées à cette validation gardent leur règle antérieure.
Les contrôles de taille, cible, quatre échantillons, droits et TTL sont conservés.
La CI de ce commit est réussie, paquets Phone, TV et Windows inclus.

Un nouvel essai Lost avec préfixe confirmé montre : **9,291 s** jusqu'à `playing`,
session en **8,797 s**, quatre lectures en **926/400/385/289 ms**, mais validation
totale **4,504 s**. Le cache est réellement accepté, puis **163,556 s** de vidéo
parcourues sans événement d'attente ni erreur. Il ne suffit donc pas de mesurer
le coût des quatre lectures pour expliquer le démarrage complet.

Cause supplémentaire trouvée : le démarrage zéro ouvrait une réponse froide
avant la validation du préfixe, puis la fermait et attendait sa libération. Le
prototype essaie maintenant le préfixe **avant cette ouverture**, pour un profil
Matroska complet, une seule piste audio et aucun sous-titre. En cas de refus ou
d'expiration, le broker est drainé avant la préparation ordinaire. Les graphes
plus complexes conservent leur enrichissement habituel. Gain réel encore à mesurer.

Les suites ciblées du transport/cache/Edge/runner passent **206 tests**, cinq
ignorés. Après la correction de l'ouverture préalable, les contrôles du préfixe,
des refus fournisseur et de la pompe MKV passent **175 tests**, un ignoré. Ces
suites se recouvrent ; leurs nombres ne sont pas additionnés.

Les MP4 H.264/AAC compatibles ont un parcours natif distinct du cache HLS. Le
banc temporaire employait une base publique HTTP, incompatible avec la politique
HTTPS de cette route : corrigé dans la configuration du banc uniquement, sans
affaiblir la politique ou modifier une route de production. Leur contrôle suit
la voie native ; une préparation HLS forcée ne prouverait pas leur comportement.

L'image candidate privée porte la révision `3162cc1`, empreinte
`sha256:657b9bd60059cbe48114e9dff9099fd4123da44badc09b9f7fc55a56df904958`.
Les fichiers de base Gateway, cache et Edge correspondent aux fichiers déployés
avant les deltas de cette PR. L'image n'est pas déployée en production.

Après les essais de consommation, le signal `session` du compte reste récent
pendant cinq minutes : il provient de ces essais, même lorsque leurs claims sont
déjà terminés. Le préchargement respecte cette période ; aucun signal de présence
ni verrou n'a été effacé pour forcer les tests.

Les traces privées et les réponses agrégées sont dans
`.codex-artifacts/startup-cache-20261010/`, hors Git. Aucun accès fournisseur
ni identifiant de compte n'est inclus dans ce rapport.

## État et critères d'activation

**Non activé en production. Aucun gain de démarrage réel annoncé.**
Avant activation : réussite de la CI, capture réelle d'un préfixe, revalidation
et consommation depuis zéro, réception au-delà du raccord, pistes et sous-titres
préservés, puis interruption d'un travail de fond par une lecture réelle avec
preuve de fermeture de la connexion précédente.

Le pilote ne précharge pas tout le catalogue. Le budget mémoire et les TTL
existants imposent une sélection bornée. Une source durablement trop lente
épuisera le préfixe ; cette préparation ne multiplie pas son débit réseau.

Runbook : `ops/hetzner/media/startup-cache.md`.
