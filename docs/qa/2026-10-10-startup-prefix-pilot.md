# Préchargement privé de la première minute

## Demande et périmètre

Implémenter sur le pilote une préparation des 60 premières secondes lorsque le
compte fournisseur est libre, avec priorité à toute lecture utilisateur.
Prototype fondé sur le Gateway et le cache de reprise déjà déployés ; aucun AVPlayer/libmedia,
aucun nouveau lecteur externe ni application native modifiée. La dernière suite
corrige aussi le nettoyage de la ressource vidéo dans WatchPage.

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

## Mesure MP4 par index et octets — expérience du 10 octobre, 21:06 Paris

Le nouveau module isolé `mp4-indexed-byte-coverage.js` lit les tables de
paquets du `moov` : tailles, chunks 32/64 bits, durées, images de synchronisation,
offsets de composition et édition simple. Il calcule la couverture DTS continue
à partir du point vidéo de synchronisation précédent et des paquets audio près
de la cible. La couverture s'arrête au premier paquet dont les octets manquent.
Les fragments MP4, éditions complexes, pistes ambiguës, tables tronquées,
comptages excessifs et octets hors fichier sont refusés. **Sept tests ciblés
réussissent.** Le module n'est raccordé à aucune route ni décision de production.

Sur les 8 060 928 octets du contrôle précédent de Jolt, il retrouve
**26,629 secondes après la cible**, après application des éditions audio/vidéo.
Cette preuve situe les paquets ; elle ne garantit pas leur décodage, la
présentation des images réordonnées ni la fluidité future.

Un nouvel essai utilise Jolt et WatchPage réel avec claims ordinaires sur les
services isolés. L'index est capturé à nouveau dans cette même lecture ; le
banc mesure les octets reçus par son relais local, sans requête fournisseur
supplémentaire. Il attend 24 secondes selon l'index, plutôt que selon
`HTMLMediaElement.buffered`, puis demande `play()` seulement lorsque le saut
est terminé, la position correcte et `readyState >= 2`.

- Démarrage depuis zéro : **13,060 s**.
- Saut vers **1 082,206 s** : reprise automatique après **54,615 s**,
  sans pression manuelle sur Play. Couverture calculée au départ : **25,634 s**.
- L'indication native reste décalée pendant la pause. La reprise automatique
  dépasse néanmoins la condition qui bloquait le contrôle précédent.
- Après reprise : **142,945 secondes de vidéo sur 143,286 secondes réelles**,
  sans `waiting` ni grand intervalle entre images après la première seconde
  de reprise. Le dernier paquet initialement prouvé était vers 1 107,84 s ;
  la lecture atteint 1 225,151 s, avec réception de nouvelles données.
  Treize images perdues sur 4 138 dans l'essai entier ; une grande coupure
  couvre la pause volontaire, et un intervalle de 0,509 s précède le saut.
  L'erreur vidéo initiale à 8,5 ms précède l'attachement du média ; aucune
  nouvelle erreur n'est signalée pendant cette lecture.

**Ce délai reste trop long.** Il n'existe toujours pas de préfixe MP4 natif
réutilisable entre sessions. Le banc mesure des octets de transport, pas une
preuve exposée par le cache authentifié du broker ; ce raccord reste à réaliser.
Le seuil de 24 secondes reste expérimental et ne doit pas devenir un réglage
général. L'entrée publique, d'autres copies et l'écoute ne sont pas validées.
Les positions et conditions réseau diffèrent : aucun gain chiffré comparatif
de reprise n'est revendiqué.

Preuves : `jolt-indexed-coverage.safe.json`,
`indexed-path-{browser,transport,create}-6-1.safe.json`,
`indexed-validation-summary.safe.json`,
`mp4-indexed-automatic-continuation.png`.
Les claims sont expirés normalement ; le helper, son tunnel et les services
isolés sont arrêtés après drainage. Les deux Gateways de production sont sains
et inactifs : `indexed-final-health.safe.json`, `indexed-closure.safe.json`.

## Raccordement au cache réel et reprises sur quatre copies — 10 octobre, soirée

Le pilote conserve maintenant les plages MP4 complètes d'une lecture ordinaire
dans la vraie classe de cache privé, après fermeture du transport. Jusqu'à
32 Mio sont réinjectés après quatre échantillons frais, avec taille, cible,
propriétaire, source et révision vérifiés. Le budget existant et le TTL récent
de dix minutes restent applicables. Cela ne constitue pas une préparation
anticipée de la première minute MP4.

Deux défauts ont été trouvés et corrigés pendant ce raccordement : le nettoyage
des pompes précédait la distinction entre fermeture ordinaire et révocation,
et la nouvelle ouverture ne réutilisait pas l'indication opaque de livraison.
La fermeture photographie maintenant les seules plages complètes avant l'abort,
puis attend le drainage. Une révocation globale ne publie pas de nouveau cache.
Chaque vérification utilise un jeton de livraison à usage unique, sans prolonger
son expiration. Une lecture fraîche indisponible autorise seulement le repli
normal ; elle ne supprime pas un candidat encore dans son TTL.

La route authentifiée `native-coverage` consulte les plages encore présentes
dans le broker, sans ouverture fournisseur supplémentaire. L'index terminal
peut être partagé entre plusieurs réponses Range : seules leurs parties
complètes et adjacentes sont assemblées, sans trou ni réponse interrompue.
Les limites de l'analyse précédente restent applicables. La couverture DTS
ne constitue toujours pas une preuve de décodage ou de débit futur.

### Reprises réelles après fermeture

Quatre films de **trois sources**, avec WatchPage inchangé et claims ordinaires
sur Edge/Gateway isolés. Les chiffres mesurent `playing` depuis le clic de
réouverture, à la position effectivement conservée. Le banc transmet désormais
la position globale dans l'expiration, comme le lecteur Norva. Un ancien essai
MKV omettait cette position et repartait sans cache ; il est exclu des résultats
de réutilisation ci-dessous.

| Copie | Conteneur | Départ à froid | Reprise avec cache | Continuation |
| --- | --- | --- | --- | --- |
| Jolt | MP4 | 19,613 s | 8,419 s | 139,5 s, sans attente ni grande coupure après la première seconde |
| Vermines | MP4 | 17,200 s | 12,599 s | plus de 138 s de progression, avec un saut arrière ; deux attentes de 0,261 et 0,380 s |
| Lost | MKV | 9,747 s | 3,536 s | 142 s, sans attente ni image perdue |
| Minnal Murali | MPEG-TS | 12,326 s | 5,262 s | plus de 136 s, sans attente ni image perdue |

Les deux MP4 réinjectent réellement **22 889 562 et 10 747 904 octets**.
Les deux parcours HLS retrouvent environ **49 secondes de cache**, après
validation fraîche en **1,608 et 3,317 secondes**. Tous les contrôles de
continuation dépassent les octets/segments initialement réutilisés et reçoivent
de nouvelles données. Aucun nouvel événement d'erreur vidéo/HLS n'est signalé
après démarrage sur ces reprises. Les erreurs vidéo initiales précèdent le
chargement du nouveau média ; elles ne sont pas comptées comme succès ou échec
de lecture. Vermines perd 32 images sur 3 400 dans son essai ; sa fluidité n'est
donc pas déclarée parfaite.

Le départ froid de Vermines présente deux pauses de 2,915 et 1,546 secondes.
Les reprises ne sont pas réalisées aux mêmes positions que l'ancien saut Jolt
de 54,615 secondes : **aucun ratio de gain entre ces essais n'est revendiqué**.
Une tentative de préparation en fond a été différée par la présence récente
du compte ; aucune activité ni réservation n'a été effacée pour la forcer.

Un contrôle final de Jolt avec le code du raccordement d'index démarre à froid
en **15,384 secondes**, puis rouvre successivement en **6,621 et 5,894 secondes**.
La lecture de couverture authentifiée situe 24,037 secondes de paquets au-delà
de la cible de 20 secondes dans les seules plages complètes conservées. Une
autre consultation renvoie zéro lorsque les paquets nécessaires ne sont pas
entièrement présents : des octets annoncés par le navigateur ne deviennent pas
automatiquement une preuve de cache.

Ce contrôle final n'est toutefois **pas fluide sur les sauts**. Après presque
deux minutes de progression, le saut arrière de dix secondes provoque une
attente de **11,715 s**, puis 3,443 s ; le saut avant provoque **10,778 s**,
puis 1,999 s. La trace montre des relectures des plages à 48 594 944 et
61 571 072 octets : la fenêtre active de 32 Mio avait déjà évincé ces données
alors que le navigateur les annonçait encore chargées. Les réouvertures rapides
ne démontrent donc pas à elles seules des sauts rapides.

Un essai isolé avec une fenêtre active de 64 Mio reste **inconclusif** : Jolt
démarre en **70,577 s**, avec des attentes de 13,623 et 13,962 s, puis rouvre en
**28,527 s** avec de nouvelles attentes. Le premier parcours reçoit seulement
10 033 770 octets ; le second réinjecte réellement 6 407 258 octets. Aucune
éviction n'est mesurée dans ces deux parcours, qui n'atteignent pas les mêmes
positions que le témoin 32 Mio. Le banc comporte encore sa protection
expérimentale de réserve après saut ; cette attente n'est pas une mesure du
lecteur public seul. Il n'est donc pas possible d'attribuer un gain ou une
régression à la capacité doublée. Le réglage 64 Mio et son instrumentation
temporaire sont retirés du code à conserver ; limite active et capture privée
restent à 32 Mio. Production inchangée.

Preuves privées expurgées : `native-cache-accepted-{browser,transport,create}-6-*.safe.json`,
`broker-indexed-path-{browser,transport,create}-8-*.safe.json`,
`real-cache-lost-{browser,transport,create}-5-*.safe.json`,
`real-cache-ts-{browser,transport,create}-9-*.safe.json`,
`native-cache-transports*.safe.json`, `lost-stop-capture.safe.json`,
`native-cache-vermines-health.safe.json`, `native-cache-final-coverage.safe.json`,
`native-cache-second-coverage.safe.json`, `native-cache-final32-*-6-*.safe.json`,
`native-cache-probe64-*-6-*.safe.json`, `native64-transports-final.safe.json`
et `closure.safe.json`.

**253 tests ciblés réussis, cinq ignorés.** Les contrats CI du code `2df08fdc9`
réussissent : **6 368 tests, 35 ignorés**, avec région et syntaxe réussies
(run 38081043868). Les constructions Android Phone, TV et Windows réussissent.
Les contrôles supplémentaires passent : 29 tests d'index/réutilisation/accès,
puis 156 tests du broker, cinq ignorés. Aucun changement de WatchPage ni de
client Android n'est introduit par ce raccordement backend.

## Suite MP4 : sauts, fermeture et reprise réelle

Les commits `4ee31773c`, `9153f88e9`, `6da55dd90` et `e48a8e29b` prolongent
le raccordement au cache réel, sans déploiement en production.

### Corrections et périmètre

- Le lecteur fini MP4 reçoit seulement le trou avant une plage complète déjà
  en cache, puis réutilise son suffixe. Cette règle, auparavant conditionnée au
  recul TS, évite sa relecture. Le contrôle d'intégration vérifie les octets
  exacts et les seules plages fournisseur manquantes, sans interruption.
- Le broker actif du seul pilote `native-browser-mp4` conserve **64 Mio** au
  lieu de 32 Mio. La capture entre sessions reste à **32 Mio**, dans le budget
  global et le TTL privés existants. Les clients natifs gardent leurs limites.
- La base et le plafond séquentiels MP4 du pilote sont **2 Mio**, pour borner
  les transferts inachevés abandonnés lors d'un saut. La première plage reste
  256 Kio, la première continuation 1 Mio, l'index terminal explicite 4 Mio.
  Le premier réglage du seul plafond à 2 Mio était normalisé vers la base de
  8 Mio ; `e48a8e29b` corrige aussi la base. Les premiers fichiers de preuve
  nommés `mp4-2m-final-*` correspondent donc encore à **8 Mio**, sans prétendre
  mesurer le réglage final de 2 Mio.
- WatchPage retire l'attribut `src` à la fermeture. Assigner une chaîne vide
  pouvait sélectionner l'URL du document. Les erreurs d'une ressource encore
  détachée ou remplacée sont ignorées ; une erreur sur la ressource courante
  conserve son parcours de récupération. Tests des deux cas et du nettoyage.

### Fiabilité du banc

La protection expérimentale de réserve après saut a été retirée : les commandes
exécutent le WatchPage réel. Deux événements `waiting` imbriqués pouvaient aussi
laisser une ancienne attente ouverte dans le compteur ; `playing` termine
maintenant toutes les attentes ouvertes. Les anciens chiffres artificiellement
croissants ne sont pas des durées de gel validées. Les grandes pauses de
Vermines ci-dessous sont, elles, corroborées par les intervalles d'images.

Une fermeture puis réouverture immédiate du banc pouvait demander `/start`
avant la fin de son expiration `/stop`. Le helper renvoyait alors l'ancienne
capacité, refusée avec HTTP 410. La fermeture est désormais attendue avant la
création suivante, comme le fait la destruction des sessions dans WatchPage.
Il ne s'agissait pas d'une copie soudain devenue incompatible. Le contrôle
corrigé rouvre Jolt en **5,823 s**, sans erreur, avec sauts de **0,349 / 0,090 s**
et **128,36 s** de progression après le dernier saut. Cet essai utilise encore
les fenêtres de 8 Mio ; aucune réparation de ce défaut propre au banc n'est
attribuée à la production.

### Contrôles intermédiaires

Avec suffixes réutilisés et fenêtre active de 64 Mio, Jolt rouvre en **6,155 s**,
puis attend **0,464 / 0,212 s** sur les deux sauts. Il parcourt **124,90 s** après
le dernier saut sans nouvelle attente, avec cinq images perdues sur 5 298.
Le broker réinjecte **23 184 474 octets**, compte 466 accès au cache et reçoit
ensuite **105 754 085 nouveaux octets**. Cela prouve la continuation au-delà
du cache, et pas seulement la première image. Une reprise ultérieure rouvre en
5,823 s et confirme ce parcours comme indiqué ci-dessus.

Vermines, avec les mêmes fenêtres séquentielles de 8 Mio, reprend en **5,414 s**
et passe les premiers sauts en **0,063 / 0,055 s**, mais s'interrompt ensuite
**30,374 / 10,480 / 16,834 / 22,719 s**. Ce résultat défavorable reste conservé.
Un autre essai Jolt à 8 Mio comporte un saut de **9,269 s**. Ces essais ne
permettent pas de généraliser les premiers sauts rapides à toutes les positions.

### Contrôles du réglage final

Claims ordinaires Edge/Gateway isolés, fichiers MP4 H.264/AAC du catalogue,
cache réel de fermeture puis quatre échantillons frais à la réouverture.
Les positions et conditions diffèrent des essais historiques : aucun ratio
causal de gain entre ces séries n'est revendiqué.

| Copie MP4 | Départ froid | Réouverture | Saut arrière / avant | Progression après dernier saut |
| --- | --- | --- | --- | --- |
| Jolt, H.264/AAC | 11,150 s | **6,838 s** | **0,221 / 0,103 s** | **146,45 s**, aucune nouvelle attente ni grande coupure d'image mesurée |
| Vermines, H.264/AAC | 23,134 s | **5,241 s** | **0,179 / 0,790 s** | **146,09 s**, aucune nouvelle attente ni grande coupure d'image mesurée |

Jolt réinjecte **18 990 170 octets**, avec 354 accès au cache, puis reçoit
**82 597 076 nouveaux octets**. Vermines réinjecte **19 136 512 octets**, avec
472 accès au cache, puis reçoit **57 037 463 nouveaux octets**. Les fenêtres
séquentielles de **2 097 152 octets** sont constatées dans les journaux de
transport, pas seulement dans la configuration. Trois et deux transferts sont
interrompus respectivement, notamment lors des sauts/fermetures ; aucune réponse
incomplète n'est publiée comme plage valide. Les validations fraîches et la
capacité révoquée restent obligatoires.

Les deux dernières reprises ne signalent aucune erreur vidéo. Le départ froid
de Jolt comporte une attente de 0,564 s ; celui de Vermines 2,259 s. Au début
de la reprise de Vermines, un intervalle d'image de **1,024 s** est mesuré,
sans événement `waiting`, avec 0,405 s de traitement ; son origine exacte
n'est pas attribuée. Il précède les sauts. La trace contient aussi un callback
d'instrumentation de 75 ms, sans preuve qu'il explique l'intervalle entier.
Vermines compte **55 images perdues sur 4 700** ; Jolt **13 sur 5 103**, dont
une augmentation pendant la capture/inspection de clôture. Les commandes,
attentes, intervalles d'image et nouvelles données ont tous été observés :
**aucune fluidité parfaite ni garantie pour toutes les positions n'est revendiquée**.
L'écoute humaine n'a pas été réalisée.

Preuves expurgées : `mp4-base2m-final-{browser,transport,create,live}-{6,8}-{1,2}.safe.json`,
`mp4-base2m-final-native-close.safe.json`,
`mp4-base2m-vermines-native-close.safe.json`, `mp4-seek-final-summary.safe.json`,
`mp4-seek-recovery-summary.safe.json`, `mp4-final-jolt-continuation.png`,
`mp4-detached-final8m-*-6-{1,2}.safe.json`, `mp4-2m-final-*-6-3.safe.json`,
`mp4-seek64-*-{6,8}-*.safe.json`, `mp4-base2m-broker-tests.tap`,
`mp4-gap-native-tests.tap` et `mp4-queued-error-tests.tap`.
Les derniers fichiers de clôture prouvent expiration ordinaire, zéro session,
pompe et encodeur avant arrêt des deux canaries, et deux Gateways de production
sains, inactifs et inchangés. Aucune activité fournisseur n'est effacée pour
forcer un essai.

Les contrats CI `e48a8e29b` réussissent : **6 371 tests, 35 ignorés**, SQL,
locale générée, région et syntaxe réussis (run `38084700914`). Suite locale :
**157 tests du broker réussis, cinq ignorés**, 29 tests d'index/réutilisation/
accès et 16 tests de cycle de vie du lecteur réussis. Le commit intermédiaire
`9153f88e9` avait échoué au contrôle du manifeste généré, avant régression ;
le manifeste est régénéré dans `6da55dd90`, dont les contrats réussissent aussi.
Les paquets Android Phone, TV et Windows du code final réussissent. Ces constructions ne
constituent pas une validation de lecture Android en émulateur.

## État et critères avant l'autorisation de déploiement

**Non activé en production. Les deux reprises MP4 finales sont rapides (6,838
et 5,241 s), leurs deux sauts attendent moins d'une seconde et chacune progresse
plus de 146 secondes après le dernier saut, au-delà du cache réel. Les longues
attentes des précédents essais ne reviennent pas dans ces deux contrôles.
La fluidité parfaite n'est pas validée : Vermines conserve un ralentissement
initial d'image et des images perdues. Les positions diffèrent des témoins ;
la minute MP4 préparée en fond, le démarrage froid de Vermines (23,134 s) et
la validation catalogue/login publique restent ouverts. Aucun remplacement du
lecteur ni déploiement en production n'est effectué.**
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

## Activation autorisée et contrôles publics — 10 octobre, soir UTC

PR760 intégrée sous `5d146d4030fa05c5afc28b3a9f2345374394763b`.
Les contrats et les constructions Android Phone, TV et Windows réussissent.
Le propriétaire du pilote est celui des accès privés déjà validés ; les sessions
publiques et les copies testées ont été rapprochées en base sans exposer les
identifiants, liens de lecture ou accès fournisseur dans ce rapport.

Le Gateway pilote utilise l'image immuable
`sha256:45c5e46cf5d9d6aab0ccd011c0f89d5a8c9108c127a88b8695cc632e3518f8f4`.
Le Gateway principal conserve son image et ses paramètres. La préparation est
limitée à un propriétaire et à deux fichiers du catalogue : Lost (MKV) et
Minnal Murali (MPEG-TS). Les MP4 natifs réutilisent les données reçues pendant
la lecture ; aucune minute HLS inutile n'est préparée pour cette route.
Les budgets, droits, claims et priorité des lectures restent contrôlés.
Les conteneurs précédents sont conservés arrêtés pour un retour arrière.

### Déploiement initial incomplet, corrigé avant les rejeux

Le premier contrôle public a trouvé une omission opératoire : seul le premier
réplica Edge avait été aligné. Le second gardait l'ancien routage et le pilote
désactivé. Une création pouvait ainsi atteindre le Gateway pilote, puis un
heartbeat ou une fermeture atteindre le Gateway principal. Ce contrôle ne
validait ni la continuité des droits natifs ni la capture du cache.

Avant correction : Jolt démarre deux fois en 14,373 et 14,268 s, un premier
essai échoue à 92 s de vidéo avec une erreur de lecture et un statut HTTP 410.
La réouverture suivante attend 30,515 s ; les fermetures ne créent aucune entrée
de cache. Vermines utilise encore la route principale et attend 47,615 s.
Ces valeurs sont conservées comme échecs de déploiement, pas comme validation
du pilote final ni comme preuve de responsabilité du fournisseur.

À 21:26:50 UTC, `norva-edge-functions` **et** `norva-edge-functions-2` utilisent
le même code et les mêmes gates/routage. Les propriétaires canary préexistants
sont conservés ; un seul propriétaire peut utiliser cette optimisation.
Les deux réplicas sont sains. Le runbook impose désormais cette vérification.

### Cache MP4 public après alignement

Vermines / MAX OTT / variante AR, fichier MP4 exact :

- Première ouverture après alignement à 18 s : première image en 39,936 s,
  sans données réutilisables au départ. Ce démarrage froid reste lent.
- Fermeture normale : **17 039 360 octets conservés**, aucun rejet de capture.
- Réouverture à 47 s : première image télémétrée en **5,246 s** ; progression
  observée depuis le clic en **5,587 s**. Quatre échantillons frais sont acceptés.
- Saut arrière et avant de 10 s : état prêt à lire observé respectivement en
  **0,353 et 0,350 s**. Ce sont des bornes d'observation, pas des mesures image
  par image du raccord ni des sauts hors de la couverture conservée.
- Après le dernier saut, progression de 54,543 à **207,138 s** de vidéo.
  Des données nouvelles sont reçues ; la lecture dépasse le cache.
- **Une interruption est observée au-delà du cache** : readyState descend à 2
  et le temps vidéo reste inchangé pendant au moins 2,119 s dans une fenêtre
  échantillonnée. Entre 83,562 et 96,519 s de vidéo, 19,394 s de temps réel
  s'écoulent. Les fenêtres ultérieures 144–159 et 194–207 s progressent normalement.
  L'absence de gel durable sur le film entier n'est pas démontrée.
- Fermeture finale : 32 Mio conservés, deux captures, un cache hit et aucune
  invalidation ; transports revenus à zéro. Aucune écoute humaine revendiquée.

### Publication de l'application

La publication initiale et son rejeu Cloudflare ont téléchargé les assets,
mais leur contrôle final échoue : un asset renvoie parfois la page HTML,
puis `/app` ne correspond plus au manifeste d'empreintes. L'enquête trouve
la publication automatique du blog : elle publie le même `public/` sans
empreintes, sous un groupe de concurrence différent.

PR761 corrige les deux publishers : même groupe de publication, empreintes
immuables et contrôle des octets également pour le blog. Quatre tests locaux
de publication réussissent, contrats CI réussis avant intégration sous
`c7a8fc19fb17cb817028ab64ee834cf75939ec7a`.
Le succès d'upload seul n'est jamais présenté comme une publication vérifiée.

Les anciennes URL immuables restent contaminées dans certains chemins CDN par
la réponse HTML de la publication concurrente. PR762 conserve les octets et
les empreintes, mais publie sous un nouvel espace de noms `app-v2`. Intégration
sous `8b764e3c5713fdfc733ec17a8800ab10bc067d8f` ; publication Cloudflare
`38088624096` **réussie, y compris le contrôle des octets livrés**. Cinq tests
de publication réussissent. Les fenêtres de test suivantes sont rechargées.

### Préchargement hors présence

Le worker respecte l'activité du compte. Les premières tentatives rendent
`account-presence` et n'ouvrent aucun transport de préparation. La fonction
`provider_account_busy` utilise une fenêtre de cinq minutes ; aucune présence,
réservation ou lease n'est supprimée pour accélérer le test. La fermeture
normale du navigateur de test laisse cette fenêtre expirer.

Après expiration naturelle, les deux préfixes sont réellement préparés,
sans échec ni transport résiduel. Les premières ouvertures publiques exactes
n'enregistrent aucun hit du préfixe. Lost / MAX OTT reprend à **136 secondes**,
au-delà de la minute préparée ; son temps local à zéro n'est pas le début du
fichier. Minnal Murali / Dino démarre depuis zéro, mais après expiration de
l'ancien préfixe. Ces essais ne permettent pas de valider le préchargement.

### Raccord de l'identité catalogue

La préparation construisait l'identité VOD avec une variante nulle ; la lecture
ordinaire depuis le menu Versions inclut l'identifiant de la variante exacte.
Ces deux clés diffèrent même pour le même fichier. PR763 utilise la même
fonction d'identité, reprend la variante du profil possédé et vérifie encore
cette variante lors du renouvellement du permis. Un test couvre l'identité
commune, la différence avec l'ancienne clé nulle et le refus d'une autre
variante. **47 tests ciblés réussissent** après adaptation du contrat existant.
PR763 intégrée sous `b51e88fc107bef331ef1073628170f7924f11f82`, **6 374 tests
CI réussis, 35 ignorés**. Les deux réplicas Edge sont mis à jour à 21:54:57 UTC,
sans redémarrage du Gateway ni changement des autres fonctions. La nouvelle
publication Cloudflare `38089416640` réussit également.

### Témoins publics avant ce dernier raccord

- Lost / Strng / MKV (autre copie que celle préparée) : première image
  télémétrée en 4,368 s, progression jusqu'à 125,109 s. Ce n'est pas une preuve
  de préchargement ni une reprise validée.
- Lost / MAX OTT / MKV (copie préparée exacte) : reprise à 136 s, donc hors du
  préfixe zéro ; premières images à 16,624 puis 17,529 s. Préparation serveur
  de 16,318 s sur la deuxième ouverture ; le lecteur attend ensuite sa réserve.
  Aucune reprise rapide revendiquée sur ces deux ouvertures.
- Minnal Murali / Dino / TS (copie exacte) : lecture observée en 7,586 s,
  progression jusqu'à 175,678 s sans erreur vidéo observée. Deux déplacements
  de dix secondes, pendant une pause volontaire, sont prêts en 0,372/0,353 s.
  Ils ne constituent pas une mesure de raccord en lecture. La fenêtre continue
  échantillonnée de vingt secondes progresse normalement, readyState=4.

Les copies exactes sont rapprochées en base avec leur compte et leur source.
Les essais précédant ce raccord ne valident pas sa réutilisation publique.

Après le raccord, une nouvelle préparation reste différée sur Lost par la
présence fournisseur. Minnal Murali est refusé avec
`exact-file-evidence-unavailable` : le profil visible est désormais une
observation `gateway_inband`, `metadataComplete=false`, avec une piste audio
et aucun sous-titre, au lieu du profil complet de la préparation antérieure.
La taille reste connue. Cette observation partielle n'est pas promue en preuve
complète pour contourner le refus. La couverture du préchargement public
n'est donc pas annoncée comme validée sur tous les formats.

### Reprise MP4 supplémentaire après les corrections publiques

Jolt / Strng / copie KU exacte : première ouverture à 125 s, sans fenêtre
réutilisable, première image en **20,012 s**. Après progression jusqu'à
147,859 s et fermeture normale, une troisième capture MP4 est enregistrée.
Réouverture à 148 s : première image en **5,571 s**, progression observée
en **5,568 s**. Le compteur de cache input passe de un à deux hits ; la
validation fraîche accepte quatre échantillons, la même taille et la même
cible. Aucun droit périmé n'est utilisé.

Sauts de dix secondes **pendant la lecture** : arrière prêt et en progression
en **0,492 s**, avant en **0,349 s**. Les mesures sont des bornes d'observation
par appels UI/DOM, pas des mesures de chaque image. La lecture reste active.
Après le dernier saut à 155,070 s, elle progresse jusqu'à **313,071 s**, soit
**158 secondes de média supplémentaires**, au-delà des octets conservés.
Dans les fenêtres échantillonnées, aucune readyState inférieure à 3 ni erreur
vidéo n'est observée. Entre 169,774 et 313,071 s, 143,292 s de temps réel
s'écoulent pour 143,297 s de média. Ce contrôle n'est pas une écoute humaine ni
une certification de chaque image du film entier.

### Réouverture MPEG-TS : limite reproduite en production

Minnal Murali / Dino / même fichier à environ 176 s : la réouverture retrouve
une candidate, mais la lecture fraîche de validation est indisponible.
Le diagnostic est `fresh-read-unavailable`, zéro échantillon frais accepté,
un miss et une invalidation supplémentaires. Cela **ne démontre pas** que le
fichier fournisseur a changé. Aucune donnée non validée n'est publiée.
Le démarrage effectif via le parcours normal est observé en **49,371 s**.
La première image est télémétrée en 39,452 s ; elle précède la progression.
Une fenêtre ultérieure de 17,845 s progresse de 20,624 à 38,468 s localement,
readyState=4, sans erreur. La reprise rapide MPEG-TS n'est pas validée.

### Conclusion de la validation publique

Le pilote est déployé et reste limité au propriétaire autorisé. La réutilisation
de données MP4 est démontrée sur deux fichiers réels : **Vermines et Jolt**.
Les sauts courts restent rapides dans la couverture déjà chargée. Jolt dépasse
deux minutes après les sauts avec une progression régulière dans le contrôle ;
Vermines présente une interruption au-delà de la fenêtre conservée.

Lost / MAX OTT attend encore lors d'une reprise hors du préfixe zéro. Minnal
Murali démarre rapidement depuis zéro, mais sa reprise peut encore retomber sur
une préparation de 49 s. Le raccord d'identité catalogue est corrigé et déployé,
mais son préchargement zéro après nouvelle préparation publique reste à prouver.
Le worker respecte la présence et refuse les preuves de fichier incomplètes.
Il ne précharge que les deux cibles du pilote ; aucun catalogue général n'est
téléchargé et aucun compte supplémentaire n'est inscrit.

La validation **ne permet pas** de déclarer tous les formats rapides et fluides
ni de généraliser. Aucune attribution certaine au fournisseur ou au relais,
aucune écoute humaine et aucune mesure exhaustive des images perdues ne sont
revendiquées. Les ouvertures Android natives ne sont pas rejouées cette phase ;
leurs constructions CI ne sont pas présentées comme des tests de fluidité.

À la clôture vers 22:03 UTC : les deux Gateways et les deux réplicas Edge
répondent sainement ; zéro lecture publique active et zéro pompe brute sur
les deux Gateways. Les admissions de fond sont rétablies, le dispatcher et le
worker Selection continuent normalement. Aucune lease forcée. Le worker de
préchargement reste borné au pilote, sans préparation active à cet instant.

### Preuves locales de cette phase

Répertoire ignoré `.codex-artifacts/startup-cache-20261010/` :
`final-deployment.safe.json` (receipt distant),
`final-edge2-deployment.safe.json` (receipt distant),
`final-edge2-inventory.remote.py.safe.json`,
`final-routing.remote.py.safe.json`, `final-cache-status.remote.py.safe.json`,
`final-telemetry.safe.json`, `final-prefix-attempt.remote.py.safe.json` et
`final-presence-policy.remote.py.safe.json`.
Également : `final-identity-edge.safe.json`, `final-jolt-cache.safe.json`,
`final-profile.remote.py.safe.json` et `final-status.remote.py.safe.json`.
Les fichiers privés contenant la configuration complète ou des accès restent
hors Git et ne sont pas liés dans le rapport public.
