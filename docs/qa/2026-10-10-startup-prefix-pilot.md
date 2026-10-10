# Préchargement privé de la première minute

## Demande et périmètre

Implémenter sur le pilote une préparation des 60 premières secondes lorsque le
compte fournisseur est libre, avec priorité à toute lecture utilisateur.
Prototype fondé sur le Gateway et le cache de reprise déjà déployés ; aucun AVPlayer/libmedia,
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
plus complexes conservent leur enrichissement habituel.

Sur la même copie Lost, depuis zéro, la révision `b4553956f` donne ensuite
**3,325 s** jusqu'à `playing`, contre **9,291 s** avant cette correction :
session en **2,734 s**, Gateway en **2 091 ms**, dont **2 089 ms** de validation
fraîche. Les quatre échantillons prennent **894/431/436/324 ms**. Les diagnostics
confirment `privateStartupBeforePreopen=true`, `privateStartupWindowHit=true`
et 60 secondes locales. **231,109 s** de vidéo sont parcourues, aucun événement
d'attente ; intervalle maximal de callback de frame de **151,7 ms**. Une correction
non fatale HLS `bufferSeekOverHole` est signalée au début. Ce contrôle valide un
gain sur cette copie et ce chemin, pas sur l'ensemble du catalogue.

Une seconde ouverture du même préfixe démarre en **3,561 s**, puis se bloque vers
**2,496 s** de vidéo. L'événement d'attente dure **17,860 s**, mais la trace de
progression et les callbacks révèlent une interruption plus longue, d'environ
**34 s**. La lecture reprend et atteint **169,280 s**, sans nouvelle attente
après la première minute. Deux avertissements HLS `bufferStalledError`, non
fatals, restent consignés. La fluidité répétée n'est donc pas validée.

Pendant ce second contrôle, les six premiers segments immuables sont relus par
la route du Gateway existante, sans nouvelle connexion fournisseur : environ
**1 ms** par segment, décodage FFmpeg sans erreur. Les paquets audio ont un
écart PTS maximal de **21,334 ms**, ceux de vidéo **34 ms**. Cela écarte un trou
de plusieurs secondes dans ces paquets, mais ne prouve pas le comportement
du transport navigateur lors du gel. Sa cause reste ouverte.

Preuves privées : `browser-5-before-early.safe.json`,
`browser-create-5-before-early.safe.json`, `browser-5-after-early.safe.json`,
`browser-create-5-after-early.safe.json`, `browser-5-after-early-repeat.safe.json`,
`browser-create-5-after-early-repeat.safe.json`, `first-cached-assets.safe.json`
et `first-cached-clocks.safe.json`.

Les suites ciblées du transport/cache/Edge/runner passent **206 tests**, cinq
ignorés. Après la correction de l'ouverture préalable, les contrôles du préfixe,
des refus fournisseur et de la pompe MKV passent **175 tests**, un ignoré. Ces
suites se recouvrent ; leurs nombres ne sont pas additionnés.
La suite élargie locale donne **859 réussis, dix ignorés et un échec** :
`media-gateway-video-encoder.test.js` ne trouve pas `js-yaml` dans cet environnement.
La CI Linux de `b4553956f` réussit **6 338 tests, 35 ignorés**, sans échec ; région,
syntaxe et constructions Phone, TV et Windows réussissent également.

Les MP4 H.264/AAC compatibles ont un parcours natif distinct du cache HLS. Le
banc temporaire employait une base publique HTTP, incompatible avec la politique
HTTPS de cette route : corrigé dans la configuration du banc uniquement, sans
affaiblir la politique ou modifier une route de production. Leur contrôle suit
la voie native ; une préparation HLS forcée ne prouverait pas leur comportement.
Jolt crée effectivement sa session native en **1,094 s**, mais la première image
arrive en **25,323 s**. Aucun préfixe HLS n'est utilisé. Cette mesure concerne
les données et métadonnées attendues par le navigateur, pas un démarrage depuis
une minute vidéo HLS en cache.
Le premier essai parcourt **147,386 s**, sans événement d'attente ni erreur
vidéo, mais avec un intervalle maximal de callback de **2 018,5 ms**. Le second
démarre en **29,274 s**, session native en **0,625 s**, puis parcourt **58,414 s**
sans événement d'attente ni erreur (callback maximal **72,7 ms**). Ces durées
n'autorisent pas à certifier les films entiers ni la qualité sonore.

Le cache privé d'octets natif reste à **zéro fichier, zéro octet réutilisé** :
ses quatre observations d'identité sont refusées pour `missingValidator`.
Les réponses ne fournissent donc pas le validateur fort requis par ce cache.
Le cache HLS récent avec échantillons est un mécanisme distinct, non consommé
par cette route MP4 ; sa réussite sur Lost ne couvre pas Jolt.
Preuves : `browser-6-first.safe.json`, `browser-6.safe.json`,
`browser-create-6.safe.json`, `health.safe.json`. Le premier temps de création
(1,094 s) a été lu dans le retour de diagnostic avant écrasement du reçu par
la seconde création ; il n'est pas attribué au reçu du second essai.

L'image candidate privée de ce premier contrôle porte la révision `b4553956f`, empreinte
`sha256:5bebe7f6ca86e9f28bcb5df6f2f81fb89d8536687413fd075989a5f7a4e60210`,
arbre source `b6d3a38666c226f8ba440127c09a972e298c846c1a5e22f318f117a18f22f57e`.
Les fichiers de base Gateway, cache et Edge correspondent aux fichiers déployés
avant les deltas de cette PR. L'image n'est pas déployée en production.

Après les essais de consommation, le signal `session` du compte reste récent
pendant cinq minutes : il provient de ces essais, même lorsque leurs claims sont
déjà terminés. Le préchargement respecte cette période ; aucun signal de présence
ni verrou n'a été effacé pour forcer les tests.

Les traces privées et les réponses agrégées sont dans
`.codex-artifacts/startup-cache-20261010/`, hors Git. Aucun accès fournisseur
ni identifiant de compte n'est inclus dans ce rapport.

## Rejeu instrumenté : livraison des segments et chemin MPEG-TS

Le canary isolé est redémarré pour ces contrôles, sans modifier les routes de
production. Lost prépare de nouveau 60 secondes en **8,281 s**, puis démarre en
**2,887 s** (création authentifiée **2,281 s**, validation fraîche **1 671 ms**).
Les quatre lectures prennent **873/270/257/267 ms**. La consommation est un hit
du cache de démarrage ; **191,677 s** sont parcourues sans événement `waiting`
ni erreur HLS. Les 60 secondes sont déjà dans `video.buffered` vers 10,8 s après
le clic ; le premier segment de continuation est chargé vers 34,9 s. Le préfixe
ne disparaît pas de la playlist pendant ce démarrage : séquence zéro, puis une
seule discontinuité au raccord. Aucun refus HTTP n'apparaît parmi les 111
requêtes de cette trace.

La réouverture confirme un second hit : **4,398 s**, création **3,172 s**,
validation **2 546 ms** (échantillons **1 669/278/287/306 ms**). Le dernier état
lisible du lecteur atteint **95,329 s**, sans `waiting`, avec seulement la
correction initiale non fatale `bufferSeekOverHole`. Le contrôle CDP devient
intermittent ; la session est donc expirée par l'API ordinaire et l'onglet fermé.
La preuve de cette seconde lecture est explicitement limitée au dernier résumé
visible, et non présentée comme une trace exhaustive jusqu'à sa clôture.

Le banc affichait tout l'historique détaillé à chaque seconde. L'affichage est
réduit à un résumé et les données sont conservées séparément. Les callbacks
de frames du premier essai sont trop espacés pour certifier la cadence visuelle,
malgré une horloge de lecture continue et 35 images perdues sur 5 750 : ce point
est distinct d'un épuisement de la réserve. Le gel antérieur de 34 secondes reste
un résultat négatif valide, non reproduit dans ces deux essais ; sa cause n'est
pas déduite de leur seule réussite.

Une autre copie réelle, **Minnal Murali (2021), MPEG-TS**, prépare 60 secondes en
**22,102 s** (environ 7,55 Mio). Pourtant sa consommation démarre en **13,510 s**
sans hit : la vérification fraîche reçoit une erreur locale 502,
`PROVIDER_REQUEST_FAILED`, avant le premier échantillon, après **6 560 ms**.
La voie ordinaire reprend ensuite ; **92,937 s** sont parcourues, sans événement
d'attente ni erreur HLS, zéro image perdue parmi 2 214. Cela démontre un refus
du cache et son coût, sans attribuer cette réponse au fournisseur ou au relais.

La révision `b5231dd23` élargit l'essai avant ouverture froide à un **profil
MPEG-TS fini issu d'un probe serveur daté**, avec une seule piste audio connue
et aucun sous-titre. Les profils partiels `gateway_inband`, le direct, une taille
inconnue ou un autre graphe restent exclus ; `metadataComplete` n'est jamais
inventé. Les refus drainent toujours le broker avant la préparation ordinaire.
La suite ciblée passe **60 tests**, un contrôle FFmpeg optionnel ignoré.
Après rafraîchissement du profil exact par l'API de sonde ordinaire, le même
MPEG-TS prépare de nouveau 60 secondes en **54,012 s**. Sa consommation démarre
en **4,310 s**, création authentifiée **3,860 s**, avec un hit de 60,017 secondes.
Les quatre échantillons prennent **786/858/777/812 ms**, validation **3 240 ms**.
La lecture parcourt **132,803 s**, reçoit des segments au-delà du préfixe et
conserve une réserve. Une attente de **12,6 ms** à 27,392 secondes et un
`bufferStalledError` non fatal sont signalés, outre la correction initiale
`bufferSeekOverHole`. Sept images sont perdues parmi 3 160. Ce n'est pas une
certification de cadence ou de qualité à l'écoute ; le réseau et la préparation
varient entre les deux mesures.

La réouverture suivante échoue avant la première image et la préparation froide
est refusée. Le compteur indique `fresh-read-unavailable`, puis l'invalidation
du préfixe. Ce libellé agrégé ne distingue pas une lecture indisponible d'une
cible rejetée avant acquisition ; il ne prouve donc pas l'absence de données.
Le banc n'a pas enregistré de durée fiable pour cette création échouée : aucune
valeur n'est inventée. Le contrôle constate aussi temporairement une session
enregistrée sans pompe ni encodeur ; elle a disparu au contrôle suivant. Le claim
ordinaire est déjà `failed`, sans lecture active.

La révision `ca43b60f6` corrige deux points de ce chemin :

- Un refus de l'entrée froide ferme la session et ses ressources avant la réponse,
  au lieu de supprimer uniquement son répertoire. Cela couvre aussi une session
  déjà enregistrée par l'essai précoce du cache.
- Une vérification réseau indisponible conserve le préfixe **sans lease et sans
  lecture**, dans son TTL original. La même création ne retente pas cette
  vérification pendant son repli. Une identité différente reste invalidante ;
  les délais, la révocation et les plafonds mémoire sont inchangés. Un prochain
  essai doit réussir une nouvelle vérification complète.

Ces deux chemins passent les tests de refus, d'ordre de drainage et de contrôle
d'identité : **72 tests ciblés réussis**, un contrôle FFmpeg optionnel ignoré.
La CI de `b5231dd23` a passé **6 339 tests**, 35 ignorés, et construit les trois
paquets Phone/TV/Windows. La CI de `f0eb2acc862f9189eff336fc7b95a40fd278ff3a`
passe ensuite **6 341 tests**, 35 ignorés, et les trois paquets. Les huit échecs
intermédiaires étaient des mocks sans `stopSession`, corrigés avec le cas où
le drainage échoue. Le diagnostic de `716add371` conserve le résultat du contrôle
anticipé même si la création échoue ensuite, sans URL ni identifiant ; contrats
CI : 6 342 tests réussis, 35 ignorés.

L'image candidate `ca43b60f6` est construite, syntaxe vérifiée : empreinte
`sha256:3ba161111cf227eabd9db88f22e50aec14b263cdb45ceef4853548054ad41494`,
arbre source `a8b75f97c9315e1107b8ccf76b28d19b1f08444b7d6e25b13bd47e77131b34ce`,
94 fichiers. Elle n'est pas déployée en production.

Preuves privées : `instrumented-browser-5-1.safe.json`,
`instrumented-create-5-1.safe.json`, `instrumented-transport-5-1.safe.json`,
`instrumented-browser-5-2.safe.json` (résumé limité),
`instrumented-create-5-2.safe.json`, `instrumented-transport-5-2.safe.json`,
`instrumented-browser-9-before.safe.json`, `instrumented-create-9-before.safe.json`
et `instrumented-transport-9-before.safe.json`,
`instrumented-browser-9-early.safe.json`, `instrumented-create-9-early.safe.json`,
`instrumented-transport-9-early.safe.json`, `ts-reopen-cleanup.safe.json`,
`profile-refresh-9.safe.json` et `image-ca43.safe.json`.

## Attente navigateur et réouvertures du même préfixe

Après le correctif de drainage, Minnal prépare un préfixe en **14,142 s**.
La session est prête en **4,157 s**, validation fraîche **3 311 ms**, mais la
première lecture attend **44,564 s**. Le premier fragment est signalé reçu à
**17,479 s**, puis analysé à **44,479 s** ; le compteur d'analyse mesure
**27,206 s**. Les segments en cache sont servis en environ 0,2 s chacun.
La lecture parcourt ensuite **142,180 s**, sans `waiting` ni erreur HLS, trois
images perdues sur 3 385. L'ordonnancement du navigateur et du worker fait partie
de cette attente ; ce n'est pas une preuve de 27 secondes de calcul de décodage.
L'essai sans worker échoue avant le lecteur, en **3,391 s** (HTTP 502) : ce n'est
pas un comparatif valide. Session, pompe et encodeur reviennent à zéro.

Preuves : `instrumented-browser-9-cleanup-worker-on.safe.json`,
`instrumented-create-9-cleanup-worker-on.safe.json`,
`instrumented-transport-9-cleanup-worker-on.safe.json`, `failed-create-9-1.safe.json`.

Un nouveau préfixe est préparé en **6,660 s**. Trois lectures séquentielles
utilisent ensuite la même session authentifiée :

| Essai | Depuis le clic | Partie lecteur après création | Progression observée |
| --- | ---: | ---: | ---: |
| Worker, ouverture complète | 5,480 s | 1,520 s | 90,089 s, aucun `waiting` |
| Sans worker, même session | 0,334 s | 0,327 s | 68,051 s, aucun `waiting` |
| Worker, même session | 0,574 s | 0,549 s | 115,154 s dans la trace |

Le troisième essai signale deux attentes de **5,3 et 47,7 ms** et deux
`bufferStalledError` non fatals. Le dernier état visible compte neuf images
perdues. Son résumé final est écrasé après fermeture ; les compteurs remis à
zéro ne constituent pas une mesure. Aucun essai ne reproduit les 27 secondes
d'analyse. L'ordre, la chauffe et les données déjà prêtes diffèrent : aucune
suppression générale du worker n'est validée.
Preuves : `ab-browser-9-{1,2,3}.safe.json`, `ab-create-9-1.safe.json`,
`ab-transport-9-{1,2,3}.safe.json`, `worker-ab-summary.safe.json`.

### Cause du refus à la deuxième ouverture et correction

Après expiration ordinaire de cette session, une vraie nouvelle création échoue
en **3,172 s**. Le diagnostic indique **`target-changed`**, après une plage reçue.
Aucun encodeur ni lecteur source ne subsiste. Le code rendait au validateur
l'indication de livraison à usage unique détenue par le préfixe : le premier
contrôle la consommait ; le suivant repartait de l'URL catalogue, susceptible
de générer une nouvelle cible et de faire refuser le cache. La régression isolée
reproduit cette perte au deuxième contrôle.

La révision `261d2181618167ddc7b302d844e198dc6471bcd5` conserve l'indication
privée du préfixe et émet un jeton à usage unique par validation. Chaque jeton
garde sa date d'origine et ne peut pas produire d'autre jeton. Les contrôles
propriétaire/source/route/taille/User-Agent, les quatre lectures fraîches,
l'identité, les droits et l'expiration restent obligatoires. Le cache de reprise
ordinaire conserve son comportement précédent. **83 tests ciblés réussis**, un
ignoré ; la suite supplémentaire cache de reprise/transfert frais passe **88
tests** (recouvrement, nombres non additionnés). Couverture : données fraîches
absentes, mauvaise identité, révocation, expiration non renouvelable.

Après une seule préparation en **4,705 s**, trois créations authentifiées
distinctes réutilisent les mêmes 60,017 secondes (7 921 944 octets) :

| Ouverture | Première lecture | Création authentifiée | Validation fraîche | Position atteinte |
| --- | ---: | ---: | ---: | ---: |
| 1 | 5,403 s | 4,562 s | 3,783 s | 29,910 s |
| 2 | 4,452 s | 3,687 s | 3,247 s | 126,867 s |
| 3 | 5,216 s | 4,625 s | 3,891 s | 37,713 s |

Les trois contrôles lisent quatre plages fraîches et réutilisent la cible retenue.
Compteur final : **une capture, trois hits, zéro invalidation**, puis zéro session,
pompe et encodeur. La deuxième lecture reçoit des données au-delà du cache,
avec une attente de **243,4 ms** vers 31,344 s. Les première et troisième traces
n'en signalent pas. Le troisième essai compte zéro image perdue sur 899.
Les deux premiers résumés sont écrasés après fermeture : leurs positions viennent
des traces, leurs compteurs de qualité remis à zéro sont exclus. Le dernier état
visible de la deuxième lecture, à 123,854 s, comptait quatre images perdues sur
2 949. Le banc fige désormais sa preuve avant destruction du lecteur et arrête
son échantillonnage à la fermeture.

Contrats CI de `261d2181618167ddc7b302d844e198dc6471bcd5` : **6 344 tests réussis,
35 ignorés**, région, syntaxe et constructions Phone/TV/Windows réussies. Image candidate privée :
`sha256:fffb0092073ffc31930f89f787f44ac3e4b09c3bf09a9f9b4a6457b6978bc149`,
arbre `2bd3b1cdc88bf01e5f56825639dcb5d463e3f6dc0d6530c8f88a6bdf552a705f`.

Preuves : `target-change-reopen.safe.json`, `before-route-refresh-failure.safe.json`,
`route-repeat-browser-9-{1,2,3}.safe.json`, `route-repeat-create-9-{1,2,3}.safe.json`,
`route-repeat-summary-9.safe.json`, `route-repeat-health-9-2.safe.json`,
`route-repeat-drain-9-final.safe.json`, `targeted-route-fork.tap`,
`resume-regression-route.tap`, `image-261d.safe.json`.

### Contrôle MKV avec le même correctif

Le préchargement de Lost est d'abord suspendu pour activité catalogue récente.
Après expiration normale du signal, sans effacement de présence ni de verrou,
il prépare 60 secondes en **18,109 s** (4 708 836 octets). Deux ouvertures
authentifiées distinctes utilisent ensuite ce même préfixe :

| Ouverture | Première lecture | Création authentifiée | Validation fraîche | Position atteinte |
| --- | ---: | ---: | ---: | ---: |
| 1 | 5,017 s | 4,125 s | 3,559 s | 64,050 s |
| 2 | 3,178 s | 2,437 s | 1,783 s | 135,254 s |

Les deux contrôles valident quatre plages et le même fichier ; la continuation
dépasse la minute conservée. Une attente de **418 ms** survient à 16,174 s dans
le premier essai, avec un `bufferStalledError` non fatal et huit images perdues
sur 1 923. Le second présente une attente de **74,6 ms** à 78,086 s, aucune erreur
HLS et cinq images perdues sur 4 059. Les deux preuves finales sont figées avant
destruction du lecteur. Ces pauses brèves restent à expliquer ; le gel antérieur
de 34 secondes n'est pas reproduit, sans que sa cause soit établie.

Les essais emploient le Gateway et l'Edge réels dans le canary privé, des claims
ordinaires et HLS.js dans le navigateur. Ils ne constituent pas encore une
mesure du parcours public complet dans WatchPage. La voie MP4 native reste
distincte et n'a pas bénéficié du préfixe HLS dans les essais précédents.
Aucune écoute humaine ni garantie sur la totalité des films n'est revendiquée.

Preuves : `route-repeat-browser-5-{1,2}.safe.json`,
`route-repeat-create-5-{1,2}.safe.json`, `route-repeat-summary-5.safe.json`,
`route-repeat-drain-final.safe.json`, `closure.safe.json`.

## Contrôle avec WatchPage et comparaison MP4 natif

Révisions `a8581f85218568399b939296f8de562fe776897f` et
`eeb38b20971eca6c62e7b3e78f148a6137f8da7c` ; toujours dans les deux services
isolés, sans déploiement de production. Le banc charge maintenant le module
`WatchPage` réel, son `loadVideo`, ses commandes et sa politique de réserve.
L'Edge résout les vraies coordonnées catalogue, émet les claims ordinaires,
et reçoit les heartbeats puis l'expiration. L'entrée catalogue/login complète
du site public n'est pas reproduite. Le banc ne crée pas de progression métier.

Le délai de référence est désormais l'événement **`playing`**, depuis le clic,
et non la première image, qui peut être affichée pendant la préparation.
Les mesures incluent les lectures fraîches obligatoires. Le banc relève aussi
la progression de l'horloge vidéo par rapport au temps écoulé : l'absence
de `waiting` ne suffit pas à conclure à une lecture continue.

### Lost, MKV : préfixe retrouvé, démarrage rapide non systématique

Une préparation en **5,726 s** conserve les 60 secondes, 4 708 836 octets.
Deux sessions authentifiées distinctes utilisent ensuite le même préfixe :

| Essai WatchPage | Lecture effective | Première image | Création | Validation fraîche | Position finale |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 17,786 s | 11,059 s | 2,687 s | 1,852 s | 140,371 s |
| 2 | 4,224 s | 3,823 s | 3,031 s | 2,128 s | 143,414 s |

Les quatre plages correspondent au même fichier dans chaque essai. Le second
reçoit le premier fragment à 3,497 s, le met en buffer à 3,811 s et atteint sa
réserve de six secondes avant la lecture. Les segments du préfixe arrivent en
environ 0,1 à 0,2 seconde chacun. Le premier essai avait un contexte de contenu
incomplet dans le banc, corrigé pour le second ; l'écart de démarrage ne constitue
donc pas un A/B valide d'un correctif de production.

**La fluidité n'est pas validée.** Aucun `waiting` n'est émis, mais le premier
essai avance de 2,857 s de vidéo sur un intervalle de 8,135 s ; le second avance
de seulement **1,047 s sur 12,639 s**, à la position 80,760 s. Dans ce dernier
intervalle, `readyState=4` et le buffer couvre déjà 50,068 à 148,108 s. Une tâche
JavaScript de 1,470 s est mesurée, sans expliquer la totalité du décalage. Les
mesures ne permettent pas encore de départager l'ordonnancement du navigateur,
la machine et le lecteur. Compteurs : 1/4 215 puis 17/4 307 images perdues.
Il ne faut pas attribuer ce phénomène à une absence de données serveur.

Le code vidéo 4 relevé à quelques millisecondes du clic, avant l'attachement du
média, vient de la remise à zéro du banc ; il n'est pas compté comme un échec
de décodage de la copie. Aucune modification du lecteur de production n'a été
effectuée pour masquer ces observations.

Preuves : `watch-first-{browser,create,transport}-5.safe.json`,
`watch-path-{browser,create,transport}-5-1.safe.json`,
`watch-validation-summary.safe.json`.

### Minnal Murali, MPEG-TS : raccord contrôlé avec WatchPage

Une préparation en **6,104 s** conserve 60,017 secondes (7 921 944 octets).
La création authentifiée prend **5,984 s**, dont **4,947 s** de validation
fraîche : quatre plages en 887, 837, 2 390 et 826 ms. Le préfixe est vérifié
avant l'ouverture froide et réutilise sa cible privée retenue.

Première image en **6,560 s**, lecture effective en **7,030 s**, position finale
**192,813 s** à 202,152 s depuis le clic. La progression dépasse donc réellement
le préfixe d'environ **133 secondes**. Aucun `waiting`, aucune erreur HLS,
trois images perdues sur 4 594. Les échantillons ne montrent aucun intervalle
avec `readyState=4` et un retard de progression supérieur à une seconde,
ni tâche JavaScript supérieure à 500 ms. Cela ne certifie pas chaque image ou
la qualité à l'écoute. Le buffer final couvre 162,218 à 316,229 s.

L'onglet se déclare visible lors du contrôle DOM, bien que créé sans mise en
avant demandée. Cette observation ne permet pas d'attribuer les écarts des
autres essais à un onglet masqué. Après expiration ordinaire : zéro session,
transport natif, pompe, encodeur et octet réservé ; un préfixe, un hit,
zéro invalidation. Preuves : `warm-9.safe.json`,
`watch-path-{browser,create,transport}-9-1.safe.json`,
`watch-validation-summary.safe.json`, `watch-final-health.safe.json`.

### MP4 natif : éviter une préparation inutilisable

La voie native transmet le fichier MP4 au navigateur ; elle ne consomme pas le
préfixe HLS préparé par le nouveau worker. Le prototype pouvait donc prendre
une réservation fournisseur pour une minute qui ne serait pas utilisée.
La préparation s'arrête désormais **avant réservation et ouverture fournisseur**
quand la même autorité serveur que la lecture automatique choisit le MP4 natif.
Elle retourne `native-mp4-prefix-unavailable`. Les corrections de conteneur,
livraisons de sélection et MP4 nécessitant encore HLS conservent leur voie.

Sur **KU - Jolt (2021)**, le refus attendu prend **0,390 s** ; compteurs de
préparation, cache, session, pompe et encodeur à zéro. Ce correctif évite du
travail inutile ; **il n'implémente pas de préfixe MP4 natif**. Cinquante tests
ciblés réussissent, notamment l'absence de réservation après résolution de la
cible et le maintien des autres voies. Preuves : `warm-6.safe.json`,
`native-admission-tests.tap`.

### Jolt, MP4 : index tardif et essai de plages plus grandes

Le fichier fait 1 488 405 594 octets, avec un index en fin de fichier d'environ
3,8 Mo. Le navigateur doit le recevoir avant sa première image. Le transport
lisait cette zone en nombreuses plages de 256 Kio, chacune payant à nouveau
un délai de réponse. Les premiers délais d'en-têtes vont d'environ 0,5 à 1,9 s.

Le prototype conserve la petite première lecture et essaie ensuite **1 Mio**
par plage initiale, uniquement pour `native-browser-mp4` et le propriétaire
autorisé au pilote. La connexion fournisseur reste sérialisée, la croissance
vers 8 Mio reste bornée, et les validateurs ne changent pas. Le cache brut
persistant reste refusé sur ce fichier faute de validateur fort ; aucun ETag
n'est inventé. Les clients natifs Windows/Android sont inchangés.

Trois créations distinctes, depuis zéro, dans l'ordre A/B/A :

| Réglage | Lecture effective | Observation avant saut |
| --- | ---: | --- |
| A, 256 Kio | 52,011 s | Trois attentes et des écarts d'horloge ; non fluide |
| B, 1 Mio | 19,309 s | 114 s de progression, aucun `waiting`, zéro image perdue |
| A, retour à 256 Kio | 31,769 s | Quatre attentes avant le saut |

L'index est livré en moins d'allers-retours avec B. Le retour A montre néanmoins
une variation réseau importante : **un seul essai B ne garantit pas ce gain**.
La configuration B est restaurée sur le canary après le témoin A ; la production
n'a pas été modifiée.

Le saut vers **1 093,137 s (18:13)** reste non satisfaisant : attente initiale
de 6,805 s avec B, puis 0,682 et **20,596 s** ; cette dernière coïncide avec une
tâche JavaScript de **18,111 s**. Avec A, l'attente initiale est de 6,823 s, suivie
notamment d'attentes de **12,418 et 9,656 s**, sans grande tâche JavaScript
mesurée. Les traces mélangent donc réception insuffisante et pauses du
navigateur ; le seul changement de taille de plage ne corrige pas le saut.

Preuves : `watch-native-before.safe.json`, `watch-native-larger.safe.json`,
`watch-native-control.safe.json`, leurs fichiers `*-transport.safe.json`,
`native-ab-{256,1024}.safe.json`, `native-window-tests.tap`.
Suite broker/plages/MP4 : **173 réussis, cinq ignorés**, avec recouvrement de la
suite de 50 tests (ne pas additionner). Contrats CI de `eeb38b209` :
**6 345 réussis, 35 ignorés**, syntaxe, région et constructions Phone, TV et
Windows réussies (run `38074827454`).

Les précédents parcours de 126,867 et 135,254 secondes dépassaient le cache
d'environ 67 et 75 secondes : ils ne prouvaient pas deux minutes supplémentaires
au-delà de la première minute. Toutes les durées du présent rapport distinguent
la position atteinte de la durée passée après le cache.

## Relecture instrumentée et index MP4 borné

Révision `a409f6f37ca2f24212d6b4479152a22e4b96c348`, toujours dans les services
isolés. Aucun code WatchPage de production n'est modifié pour ces essais.
Le banc ajoute des mesures de durée des méthodes du lecteur, des événements
de lecture/saut et des intervalles entre images. Le broker relève séparément
l'attente de sa connexion fournisseur et la durée de réception de chaque plage.
Ses journaux restent bornés aux douze premières et douze dernières plages,
sans URL, jeton, identifiant de compte ou de session.

### Lost : gel précédent non reproduit, sans réparation revendiquée

Une nouvelle préparation prend **12,392 s** et conserve 60 secondes,
4 708 836 octets. La création suivante prend 2,765 s, dont **1,547 s** pour les
quatre lectures de revalidation. Première image en **3,813 s**, lecture en
**4,132 s**, puis position finale **186,906 s** à 195,711 s depuis le clic.
Le parcours dépasse donc le préfixe d'environ **127 secondes**.

Aucun `waiting`, aucune image perdue sur 5 612, aucune méthode instrumentée
supérieure à 25 ms ni tâche supérieure à 500 ms. Aucun intervalle entre images
ne satisfait le détecteur de gel (plus de 500 ms réels et plus de 400 ms de
progression manquante). Le buffer final couvre 155,309 à 308,108 s.
L'horloge avance cependant d'environ 4,7 secondes de moins que le temps écoulé
après démarrage. Ces mesures ne certifient donc pas chaque image. **Le gel
précédent de douze secondes n'est pas reproduit ; sa cause reste ouverte.**

Preuves : `clock-path-{browser,create,transport}-5-1.safe.json`,
`index-replay-summary.safe.json`, `browser-host-cpu.safe.jsonl`.

### Jolt : le coût de l'index est réduit, le saut reste variable

Le témoin conserve les plages initiales de 1 Mio. Il démarre en **20,995 s**.
Sa demande de fin de fichier reçoit 3 785 818 octets en **16,781 s**.
Au saut vers 1 093,137 s, la première lecture fournisseur attend seulement
**811 ms** la connexion ; l'attente du lecteur dure **9,238 s**. Les plages
suivantes de 8 Mio prennent notamment **4,809 à 34,209 s**, sans attente
supplémentaire du verrou. La lecture progresse ensuite de 92,588 secondes
sans autre `waiting`. Cet essai ne démontre pas un blocage du verrou Norva.

Le correctif regroupe uniquement une demande explicite vers la fin exacte du
fichier, de taille **au plus 4 Mio**, après le sondage initial. Le navigateur
peut ainsi obtenir le petit index de fin en une réponse, au lieu de répéter
les délais de requête. Une seule connexion fournisseur reste autorisée ; les
validations, l'expiration, la publication exclusive de plages complètes et
le budget mémoire sont inchangés. Les demandes plus grandes, ne finissant
pas à EOF, depuis zéro, et hors pilote gardent leur découpage ordinaire.

| Essai | Lecture effective depuis le clic | Réception de la fin du fichier | Suite observée |
| --- | ---: | ---: | --- |
| Témoin, 1 Mio | 20,995 s | 16,781 s | Saut en 9,238 s, puis 92,588 s de progression |
| Fin regroupée, première création | 12,104 s | 7,015 s | Saut en 6,777 s, puis quatre interruptions |
| Fin regroupée, seconde création | 11,292 s | 6,297 s | 84,987 s parcourues depuis zéro, aucun `waiting` |

Les deux créations corrigées sont distinctes et relisent effectivement la fin
du fichier ; aucun cache intersession n'est déclaré réutilisé. Les traces
Gateway confirment une seule plage fournisseur de 3 785 818 octets pour cet
index, livrée en 6,847 puis 6,087 s. **Le gain de démarrage se répète ici,
mais trois essais successifs ne neutralisent pas la variabilité réseau.**

Dans le premier essai corrigé, les quatre interruptions après le saut durent
**2,024 / 3,751 / 3,693 / 5,819 s**. Une plage de 8 Mio prend alors **38,219 s**,
avec 0 ms d'attente de verrou. La position atteint 1 264,888 s, soit environ
172 secondes après la cible, mais ce parcours n'est pas continu. Les intervalles
entre images confirment les arrêts. Une image d'animation de 827 ms sans script
mesuré est également relevée : la réception variable n'autorise pas à attribuer
tous les phénomènes à un acteur réseau précis. Compteurs : zéro image perdue
sur 5 988, ce qui ne signifie pas absence de gels.

La seconde création ne comporte pas de saut ; elle compte dix images perdues
sur 2 042, sans grand intervalle d'image détecté. Le code vidéo 4 à 17 ms est
émis pendant la remise à zéro du banc, avant que la nouvelle création réseau
de 547 ms ait répondu. `currentSrc` contient encore l'ancienne source à cet
instant : le champ `mediaAttached` seul ne distingue pas les deux lectures.
Aucune erreur média n'est relevée après attachement de la nouvelle réponse.

L'index a aussi été analysé à partir des octets déjà reçus, sans nouvelle
connexion fournisseur. `moov` commence à l'octet 1 484 647 221 et mesure
3 758 373 octets. Pour la cible 1 093,137 s, le repère vidéo précédent est à
**1 092,619 s**, dans l'octet 318 931 589, et l'échantillon AAC correspondant
à **1 093,120 s**, dans l'octet 319 172 062. Cela ne montre pas de décalage
structurel de 78 secondes entre les pistes. Le début temporaire de `buffered`
ne suffit pas à diagnostiquer un tel défaut. **Aucune écoute humaine ou
validation sonore complète n'est revendiquée.**

Preuves : `clock-path-{browser,create,transport}-6-1.safe.json`,
`clock-native-transport.safe.json`, `index-path-{browser,create,transport}-6-{1,2}.safe.json`,
`index-native-transport-{1,2}.safe.json`, `jolt-index-layout.safe.json`,
`index-replay-summary.safe.json`, `jolt-tail-repeat.jpg`.

### Contrôles et clôture de cette étape

Cinq tests couvrent les demandes éligibles, l'option désactivée, une fin trop
grande, une plage ne finissant pas à EOF et un fichier entier. Ils comparent
les octets réels, la réutilisation d'une plage complète et le maximum d'une
connexion simultanée. Suite broker/plages/MP4 : **178 réussis, cinq ignorés**.
Contrats CI du code `a409f6f37` : **6 350 réussis, 35 ignorés**, région et syntaxe
réussies (run `38076926009`). Les paquets Android/Windows étaient encore en
construction lors de ce relevé ; aucune publication n'est effectuée.

Lectures expirées normalement, helper et deux services temporaires arrêtés.
Zéro session, pompe, encodeur, préparation et octet réservé avant arrêt.
Deux Gateways de production sains. Preuves : `tail-broker-regression.tap`,
`index-final-health.safe.json`, `index-closure.safe.json`.

## Réserve MP4 après saut : expérience refusée

Le lecteur MP4 direct reprend ordinairement dès que le navigateur autorise
la lecture. Pour vérifier une réserve après saut, le banc seul enveloppe
`seekToTime` : pause, saut réel à 1 093,137 s, puis reprise attendue lorsque
le buffer à cette position couvre 24 secondes. Les sauts déjà suffisamment
chargés gardent leur voie immédiate ; interruption et nouvel essai annulent
l'attente. **Aucun code du lecteur de production n'est modifié.**

Une simulation sur la trace précédente, avec arrivée des données supposée
identique, situe le seuil de 24 secondes à environ 39,5 secondes après le
saut, et laisse au moins 18,4 secondes sur les deux minutes suivantes. Douze
secondes auraient encore épuisé la réserve. Ce calcul ne prouve pas le
comportement du navigateur en pause ; les essais suivants montrent justement
pourquoi il ne suffit pas.

### Pause seule et préchargement explicite

- Sans préchargement explicite, Jolt démarre en **11,980 s**. Après le saut,
  la lecture HTTP du navigateur est interrompue après **1 245 184 octets**.
  Le buffer utile reste bloqué à environ 2,5 secondes. L'essai est arrêté
  volontairement après environ 73 secondes de préparation, sans reprise.
- Avec l'attribut `preload="auto"`, confirmé dans le DOM, Jolt démarre en
  **12,538 s**. La réponse atteint **8 060 928 octets** pendant la pause.
  Cependant, le contrôle expire après 90 secondes : le navigateur annonce
  toujours 1 092,619–1 095,616 s autour de la cible et une autre plage,
  séparée, 1 171,170–1 192,107 s.

L'index déjà reçu situe les paquets contenus dans ces 8 060 928 octets à
**1 092,619–1 119,808 s pour la vidéo** et **1 092,544–1 119,787 s pour l'AAC**
(horloges de décodage, avant les petits ajustements d'édition). Environ
26 secondes sont donc reçues autour de la cible ; la plage éloignée annoncée
par `buffered` ne décrit pas leur emplacement dans ce contrôle en pause.
Cela établit un désaccord mesuré, pas sa cause interne dans Chromium.

### Reprise manuelle et conséquence

Après expiration de la barrière, une pression réelle sur Play/Pause reprend
le film à 183,455 s depuis le clic initial. Il parcourt ensuite **171,582 s**
sur 174,180 secondes réelles, **sans `waiting` ni grand intervalle entre images
après le début de cette reprise**. Quatorze images perdues sur 4 721 au total.
L'intervalle d'image de 139 secondes couvre la pause volontaire ; il ne doit
pas être compté comme un gel de la lecture après reprise. Aucun gain de délai
après saut n'est revendiqué : l'attente imposée a au contraire été trop longue.

**La barrière fondée uniquement sur `HTMLMediaElement.buffered` est écartée.**
La rendre générale pourrait bloquer un MP4 qui possède déjà des données.
Il faut une preuve de couverture issue de l'index et des octets préparés,
ou une voie de préparation dont le lecteur maîtrise le buffer, avant de
retester une réserve automatique. `preload="auto"` seul ne valide pas cette
protection. Aucune optimisation générale ni écoute humaine n'est revendiquée.

Preuves : `reserve-counterfactual.safe.json`,
`reserve-path-{browser,transport}-6-1.safe.json`,
`reserve-auto-path-{browser,transport}-6-1.safe.json`,
`reserve-auto-before-manual.safe.json`, `jolt-paused-byte-coverage.safe.json`,
`reserve-validation-summary.safe.json`, `mp4-reserve-manual-continuation.jpg`.

Les contrats CI et les constructions Phone, TV et Windows de `c502f1bfd` sont
réussis (run `38077136675`). Les essais expirent normalement ; helper et
services temporaires arrêtés, compteurs et réservations à zéro, deux Gateways
de production sains : `reserve-final-health.safe.json`,
`reserve-closure.safe.json`. Le support NodeMaven n'a pas encore répondu à
la dernière demande de trajet distinct lors du contrôle en lecture seule.
PR760 reste en brouillon, sans déploiement.

## État et critères d'activation

**Non activé en production. Le module WatchPage réutilise le préfixe sur les
copies MKV et MPEG-TS, mais l'ancien gel de Lost reste inexpliqué. Le démarrage
MP4 est accéléré sur Jolt ; il n'a toujours pas de préfixe réutilisable et ses
sauts restent non satisfaisants.**
PR760 conservée en brouillon. Les essais sont arrêtés par expiration ordinaire
de leurs claims ; sessions, transports natifs, pompes et encodeurs du canary
reviennent à zéro. Les deux Gateways de production restent sains et inactifs.
La capture réelle, les validations fraîches répétées, la continuation et le
drainage sont démontrés sur les deux copies ci-dessus ; la préemption réelle a
été contrôlée auparavant. Avant activation : entrée catalogue/login publique,
irrégularités du navigateur, sauts et couverture du MP4 natif à traiter. Aucune
écoute humaine n'est revendiquée. Les graphes multiples ou sous-titres non
couverts restent inéligibles.

Le pilote ne précharge pas tout le catalogue. Le budget mémoire et les TTL
existants imposent une sélection bornée. Une source durablement trop lente
épuisera le préfixe ; cette préparation ne multiplie pas son débit réseau.

Runbook : `ops/hetzner/media/startup-cache.md`.
