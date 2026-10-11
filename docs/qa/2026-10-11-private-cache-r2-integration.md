# Cache privé R2, file globale et durée de vie des reprises

## Résultat et périmètre

La branche `codex/global-startup-durable-20261011` / PR786 prépare le transport
R2 privé et la file globale des premières minutes, avec compression sans perte.
Elle raccorde aussi les captures **HLS et MP4 natif web de reprise** et la règle demandée A → B,
avec suppression à partir de 90 % de la durée connue.

**Production inchangée, R2 payant désactivé.** Aucun bucket Cloudflare payant,
migration de production ou changement du relais fournisseur. Les tests de
stockage utilisent Miniflare local ; la migration SQL tourne dans PGlite isolé.
La première phase ci-dessous utilise des données isolées. La campagne du
12 octobre, documentée en fin de rapport, ouvre ensuite des copies réelles
autorisées, avec des claims Edge réels et le stockage local persistant.

Le MP4 natif web utilise une archive de plages originales, distincte du graphe
HLS. Les fenêtres natives Android/Windows sont également raccordées et rejouées
en isolation dans la suite de ce rapport. Les profils incomplets restent
refusés. Ces preuves ne constituent pas un déploiement public ni une validation
générale de fluidité.

## Première minute et file globale

- Publication atomique du média puis du manifeste signé ; objets privés,
  checksums, tailles et décompression bornés, sans URL fournisseur ni accès dans
  les manifestes. Deux objets par capture, plutôt qu'un objet par segment.
- Quotas partagés via un Durable Object SQLite, distincts des limites locales
  de staging et de mémoire. Deux instances Gateway ne peuvent pas dépasser le
  plafond partagé dans le test concurrent.
- Une écriture d'état incertain garde son quota. Suppression confirmée seule
  autorise sa libération ; révocation et retirement durable interdisent une
  republication tardive. Les barrières de progression périmées après la durée
  maximale des archives sont nettoyées par pages bornées.
- Rétention facultative jusqu'à sept jours pour le stockage. Une identité forte
  actuelle concordante est indispensable avant toute lease d'une archive âgée.
  Quatre échantillons gardent leur validité de dix minutes : pas de promotion
  en preuve complète du fichier.
- Curseurs SQL durables, file limitée à 8 192 coordonnées, pages de 64,
  alternance entre comptes/sources. Priorité aux dates récentes avec une part
  pour les anciens et les dates inconnues. Les épisodes ne prennent pas l'année
  de leur série comme date de diffusion ; l'import ne sert pas de date de sortie.
- Les contrôles actuels de présence, activité, droits, profil et admission
  fournisseur restent utilisés. La lecture préempte la préparation ; acquittement
  de la file seulement après drainage positif. Une réponse ambiguë arrête la boucle.

## Durée de vie d'une reprise

Le parcours de fermeture de session capture les données après drainage du
transport fournisseur et de l'encodeur. La compression et l'upload R2 sont
asynchrones : ils ne prolongent pas la réservation fournisseur et ne sont pas
attendus dans le passage à la lecture suivante. Les snapshots en attente restent
comptabilisés dans le budget mémoire ; au plus quatre jobs de média par processus.

1. A reste en stockage tant que la position de reprise n'a pas avancé.
2. La position de lecture authentifiée retire A. Les téléchargements de segments
   ne valent pas position réellement affichée. Les tokens obsolètes, viewers
   secondaires, sessions expirées et horloges non interprétables ne peuvent pas
   provoquer cette suppression.
3. Le lecteur peut continuer à utiliser sa lease locale de A. Une future reprise
   ne peut plus l'acquérir, même depuis un autre Gateway portant une copie mémoire.
4. À l'arrêt explicite avant 90 %, les segments finalisés de B sont capturés avec
   la position absolue, les pistes exactes et les sous-titres couverts. Un changement
   de piste remplace le snapshot durable du même fichier au lieu d'accumuler des variantes.
5. À **90 % exactement, entre 90 et 100 %, ou à la fin**, l'ancienne reprise est
   retirée et aucun nouveau B n'est archivé. La première minute reste présente.
6. Durée inconnue : le seuil ne peut pas être calculé ; l'archivage long est refusé.
   Les mécanismes courts ordinaires restent inchangés quand l'option est désactivée.

Une suppression R2 incertaine ne libère pas artificiellement son quota. Sa
barrière empêche la lecture de A ; sa suppression physique est retentée par le
nettoyage. B n'est pas publié par un job dont la suppression précédente a échoué.

## Vérifications réalisées

**209 tests ciblés réussis, aucun ignoré**, avec les runtimes Worker/R2 et SQL
effectivement chargés (Node 24 local). **157 tests réussis, aucun ignoré**, dans
l'image Gateway déployée sous Node 20, sans réseau ni connexion fournisseur.
La concurrence du banc est limitée à deux workers de test : un premier passage
avait atteint sa limite de 64 processus/threads avec dix fichiers simultanés.
Seul le conteneur de test a été arrêté ; le passage borné a ensuite réussi.

`tests/startup-cache-r2.test.js` exécute le vrai Worker, son Durable Object SQLite
et son stockage R2 dans Miniflare local :

- activation et authentification refusées sans écriture ;
- publication après média, disparition du staging, redémarrage ;
- archive de deux jours avec vérification fraîche et rejet d'un fichier modifié ;
- preuve échantillonnée expirée et corruption de payload rejetées ;
- révocation pendant la lecture et absence de repli vers l'ancien staging ;
- quota concurrent entre deux Gateways et quota d'une écriture non drainée ;
- restauration d'une reprise vers 610 secondes, cues traversants et futurs préservés ;
- A physiquement supprimé après progression, B restauré après redémarrage,
  changement de piste, suppression finale, refus de la republication de A et
  conservation indépendante du préfixe de démarrage ;
- un deuxième Gateway ayant déjà hydraté A ne peut pas le réutiliser après son retrait.

`tests/startup-prefix-global-queue-sql.test.js` exécute réellement la migration :
service-role, équité, priorités, pagination de plus de 64 lignes, curseur conservé,
révisions/visibilité/générations, leases, refus des acquittements périmés et cascade
de suppression. PGlite n'est pas une preuve de débit ou de concurrence d'un
PostgreSQL de production ; le verrou SQL protège l'énumération et sa limite globale.

`tests/private-resume-persistence.test.js` rejoue le captureur et le retour de
position du Gateway, avec le vrai cache : seuil de 90 %, durée inconnue, refus
des positions non autorisées, mémoire réservée, upload lent, révocation pendant
hydratation et suppression incertaine. Les autres tests couvrent l'admission,
les sous-titres, les connexions et le transfert du décodeur existants.

La suite complète locale a initialement détecté deux harness de transfert à
actualiser pour le nouveau retour de position ; ils ont été corrigés. Quatre
autres échecs locaux proviennent des chemins Git/bash fixes absents de cette
machine Windows. La CI Linux sur le commit exact reste le contrôle complet à
consulter dans PR786 ; aucun succès global n'est déduit de ce run local.

## Compression réelle sans nouvelle lecture fournisseur

L'extrait TS déjà conservé, H.264/AAC, a été compressé et restauré dans une
instance isolée de l'image Gateway déployée, réseau coupé, un CPU et 384 Mio.

| Contrôle | Résultat |
| --- | ---: |
| Original | 599 908 octets |
| Gzip niveau 6 | 527 028 octets |
| Économie | **12,15 %** |
| Compression | 9,59 ms |
| Restauration | 1,79 ms |
| Octets restitués | identiques |
| Frames vidéo et audio décodé | empreintes identiques, aucun échec de décodage |

Les threads du décodeur ont été explicitement limités pour le banc CPU/pids.
Un premier contrôle avait échoué dans les deux décodages ; deux sorties échouées
n'ont pas été comptées comme validation. La preuve finale vérifie la réussite
des deux décodeurs et l'égalité de leurs sorties. Ce contrôle ne remplace pas
l'écoute du lecteur réel. Aucune économie générale de 12 % n'est extrapolée.

## Preuves et activation ultérieure

Preuves expurgées, hors Git, dans `.codex-artifacts/startup-cache-20261010/` :

- `durable-final-focused.local.log` ;
- `startup-durable-linux.safe.json` ;
- `resume-lossless-real.remote.py.safe.json` ;
- `durable-v2-status.remote.py.safe.json` ;
- `durable-startup-pr.safe.json` ;
- `durable-global-full.local.log` (run local initial, non entièrement réussi).

Le plan et les variables inactives sont dans
[`ops/hetzner/media/startup-cache-durable-plan.md`](../../ops/hetzner/media/startup-cache-durable-plan.md).
Le [chiffrage de stockage](2026-10-11-startup-cache-storage-estimate.md) ne vaut
pas autorisation d'achat. Restent avant activation : budget accepté, vrai canary
Cloudflare/claims/lecteur avec les routes MP4 natives, diversité des fichiers et des
invalidations, écoute, débit durable, coûts d'opérations et charge du catalogue.

## Suite : persistance MP4 natif web

Le raccord prépare maintenant la persistance des fenêtres d'entrée utilisées
par la route `native-browser-mp4`. Il réutilise les plafonds, la compression,
la signature, les quotas et la barrière de retrait du même transport privé.
Les options R2 et persistance restent toutes désactivées.

- Format explicite `native-mp4-input-v1` : aucune playlist HLS ni durée de vidéo
  disponible inventée à partir d'un nombre d'octets. En-tête complet et quatre
  échantillons requis ; plages déjà complètes et reçues, avec budget actuel
  jusqu'à 32 Mio. Aucun téléchargement complémentaire à la fermeture.
- Le heartbeat de WatchPage rapporte le temps de la balise média, uniquement
  pour son propre URL/session MP4, lorsque la vidéo est chargée et hors saut.
  Le serveur vérifie utilisateur, session active et droits avant transmission.
  Un heartbeat n'ouvre aucun média. La fermeture transmet aussi la position.
- La progression supprime A du stockage et des reprises futures. La copie
  locale déjà utilisée poursuit la lecture. B est capturé après drainage et
  son upload ne retarde pas la libération du slot fournisseur.
- À 90 %, fin, position absente/zéro ou durée inconnue : aucun nouvel archivage.
  Le préfixe initial reste indépendant. Une révocation du propriétaire interdit
  B ; une révocation d'un autre compte ne le supprime pas. La table de stamps
  est bornée ; sa saturation provoque des refus, jamais une réutilisation indue.
- Après redémarrage, une archive faible garde la limite de dix minutes. Une
  archive native avec ETag fort peut être révalidée plus tard : identité forte
  **et quatre échantillons frais** doivent tous concorder avant le lease. La
  durée doit correspondre à celle du profil serveur signé actuel.

Le test Miniflare rejoue A → suppression physique → B → redémarrage → 90 %
avec le vrai Worker, SQLite et R2 locaux ; il vérifie les octets restitués,
le quota partagé, le refus d'une ancienne A déjà hydratée sur un autre Gateway
et la conservation distincte de la première minute. Le test du parcours de
fermeture utilise le vrai code Gateway avec transport isolé : drainage,
upload lent, position finale et révocations du même/autre compte.

**270 tests ciblés réussis, aucun ignoré**, avec Miniflare et la migration SQL
réellement chargés. **191 tests réussis, aucun ignoré**, dans l'image Gateway
Node 20 déployée, réseau coupé, un CPU, 384 Mio et deux workers de test.
Ces contrôles couvrent aussi les règles HLS et les chemins historiques.
Le contrôle CI complet du commit exact reste distinct de ces suites ciblées.

Un extrait réel déjà conservé a été remuxé en MP4 **sans réencodage**, hors réseau :
H.264 High / AAC-LC, 12,075 secondes. La vraie classe de cache le conserve,
le recharge après redémarrage, puis vérifie ses octets et sa sortie décodée.

| Contrôle MP4 | Résultat |
| --- | ---: |
| Original | 541 677 octets |
| Stockage gzip | 516 902 octets |
| Économie sur cet extrait | **4,57 %** |
| Octets après restauration | identiques |
| Sorties vidéo et audio décodées | identiques, aucun échec ni erreur de décodage |

Ce résultat ne prouve ni une reprise rapide dans le lecteur public, ni une
économie de 4,57 % sur le catalogue entier, ni la qualité à l'écoute. Le cache
ne garantit pas que les plages conservées couvrent une minute autour de tout
saut. Les premiers préchargements MP4 natifs restent distincts du préfixe HLS.

Preuves de cette suite sous `.codex-artifacts/startup-cache-20261010/` :
`native-durable-regression.local.log`, `native-durable-linux.safe.json`,
`native-resume-real.remote.py.safe.json`. PR786 reste en brouillon, sans
migration ni déploiement de production, ni connexion fournisseur supplémentaire.

## Suite : lecteurs natifs Android et Windows, route Gateway

Le raccord préparé s'étend à `native-vod-recovery`, uniquement lorsque cette
route est déjà utilisée par le lecteur natif et que la persistance est activée
en environnement isolé. Format `native-file-input-v1` distinct du MP4 web :
plages originales complètes, en-tête et quatre échantillons frais, durée signée,
quotas et compression sans perte identiques. Les lectures natives directes ne
sont pas couvertes : le serveur Norva ne reçoit pas leurs octets.

- Android téléphone/TV : après une première image réellement rendue, le
  heartbeat transmet la position Media3. La fermeture stocke sa position
  bornée avec l'UUID, le motif et l'âge absolu du close en attente ; les réessais
  après rechargement gardent la même position et la même expiration.
- Windows : le bridge utilise les statistiques de décodage et une position
  récente de la session exacte. Le processus principal conserve la position
  de fermeture jusqu'à l'ACK, y compris si le renderer est rechargé. Aucune
  position du DOM vidéo n'est utilisée pour un lecteur LibVLC.
- Compatibilité Windows : le canal protocole 1 `pending-closes` garde sa liste
  d'UUID pour les anciens renderers. Le détail de position utilise un canal
  distinct, protégé par le même contrôle de fenêtre/frame/origine. Le nouveau
  renderer revient à l'ancienne liste si le preload ne fournit pas le détail.
  **98 tests ciblés réussis**, sans ignoré, après cette correction, incluant
  accusés de fermeture, isolation de session et admission du cache natif.
- Le replay du vrai bloc Gateway teste les scopes MP4 web et récupération
  native, le drainage avant upload, les révocations et le seuil de 90 %.
  Lorsque l'option native est désactivée, aucun snapshot ni revalidation
  supplémentaire n'est ouvert. Les lectures de préchargement ne sont pas
  assimilées à la progression d'un spectateur.

**149 tests ciblés réussis, aucun ignoré**, dont le cycle A/B/redémarrage/retrait
à 90 % des deux formats avec le vrai Worker/SQLite/R2 local Miniflare.
Preuve : `native-recovery-focused.local.log`. Les assertions de runtime ajoutées
contrôlent une position non décodée refusée, la première image Media3 et une
horloge utilisable après saut puis pause.

La PR reste en brouillon. Aucun nouveau gain de lecture public, validation à
l'écoute ou déploiement de production n'est annoncé. R2 payant reste désactivé.

### Contrôle de WatchPage et du stockage persistant local

Le banc charge les vrais `WatchPage`, `cloudApi`, gestionnaire de sessions MP4,
bloc de création Gateway, broker d'entrée et classes de cache. Le Worker,
SQLite et R2 sont exécutés par Miniflare sur le disque local. L'entrée est le
même extrait H.264/AAC déjà conservé, remuxé sans réencodage (12,075 secondes,
541 677 octets). Les API d'authentification et d'admission restent des fixtures
locales : ce contrôle ne vaut pas parcours public Edge/Cloudflare déployé.

| Étape | Observation |
| --- | --- |
| Arrêt normal du lecteur | Position finale reçue, transport drainé, une fenêtre publiée |
| Redémarrage du banc et de Miniflare | RAM recréée, fichiers R2/SQLite conservés |
| Réouverture après redémarrage | Quatre échantillons frais concordants ; lease accepté |
| Données d'entrée réutilisées | **541 677 octets** ; aucun nouvel octet de média téléchargé par le broker de lecture |
| Deux reprises mesurées depuis le clic | **0,37 / 0,38 s** sur ce banc local |
| Progression | Retrait de l'ancienne archive sans interrompre le lease de lecture |
| Nouvel arrêt à 6,408 s | Nouvelle fenêtre publiée après drainage de 4 ms |
| Continuation jusqu'à 12,075 s | Aucune attente signalée ni image perdue sur ce replay court |
| Fin et clôture | Aucun nouvel archivage, cache vide, aucune connexion source active |

Les quatre requêtes de vérification sont nécessaires avant l'utilisation des
octets conservés : « zéro nouvel octet de média » ne signifie pas zéro requête
source. Maximum observé : une connexion à l'origine locale. Les replays courts
ne valident ni plusieurs minutes de continuité, ni le débit des fournisseurs,
ni les sauts hors cache, ni la qualité à l'écoute. Le premier replay du banc
a ouvert la lecture avant la fin du redémarrage asynchrone : erreur de séquencement
du banc, corrigée dans le protocole par l'attente de son ACK de fin. Les résultats
positifs ci-dessus proviennent des réouvertures après cet ACK.

Preuves locales sous `.codex-artifacts/startup-cache-20261010/` :
`native-player-restart-B.safe.json`, `native-player-stop-C.safe.json`,
`native-player-completed.safe.json` et `native-player-restart.png`. Banc arrêté
et onglet temporaire fermé après les contrôles.

### CI et émulateurs du raccord natif

Sur le commit de code `e54da030cc028687c3539c03d6b5667b43db3923`,
[Build Norva 38171302353](https://github.com/Admin-Adher/Norva/actions/runs/38171302353)
réussit : **6 539 tests réussis, 39 ignorés**, contrôles SQL imposés **50/50**,
Worker/SQLite/R2 local imposé **15/15**, locales/region/syntaxe et construction
des trois paquets Android téléphone, TV et Windows.

La [première matrice Android 38171302372](https://github.com/Admin-Adher/Norva/actions/runs/38171302372)
réussit sur TV aux deux tailles de police et téléphone gestes/police 1,3.
Les trois autres configurations échouent : deux rejouent une nouvelle assertion
de cache trop tôt, au callback de première image avant l'état READY ; les autres
échecs concernent les limites existantes de délai de refus HTML et le retour Back.
Le test attend désormais READY/ENDED après la première image, dans une fenêtre
bornée de cinq secondes, puis vérifie la position. Le code conserve son refus
d'une position encore non décodée ou en attente ; aucune protection de lecture
n'est assouplie. Correction de test : `1866ede730b448e63bd5c7cdfd80cf6acd2c67d8`.
La dernière matrice et son statut exact sont publiés dans la [PR786](https://github.com/Admin-Adher/Norva/pull/786).

La préparation reste désactivée en production. Le portable final, les comptes
réels, l'entrée authentifiée publique et la validation à l'écoute restent des
contrôles distincts avant activation ; les lectures natives directes restent
hors du périmètre de stockage serveur.

### Clôture des contrôles du code natif préparé

Le commit de code `88f6dbd0a4da497fe81edc33be7ce9e615a94185` réussit
[Build Norva 38173429309](https://github.com/Admin-Adher/Norva/actions/runs/38173429309) :
**6 540 tests réussis, 39 ignorés**, SQL imposé **50/50**, Worker/SQLite/R2 local
imposé **15/15**, et les trois constructions Android téléphone, TV et Windows.

La [matrice Android 38173429334](https://github.com/Admin-Adher/Norva/actions/runs/38173429334)
termine avec **cinq configurations réussies sur six** : les deux TV, téléphone
gestes aux deux tailles de police, et trois boutons/police 1,3. Trois boutons/
police 1,0 échoue dans `ownedHttp460RecoversWithoutRepeatingTheRefusedRequest` :
arrivée au resolver en **1 718 ms**, pour un seuil existant strict de **1 500 ms**.
Le seuil et la politique de lecture ne sont pas assouplis. Les nouvelles
assertions de position rendue ne sont pas en échec dans cette matrice.

Le passage précédent, sur des sources Android identiques
(`1866ede730b448e63bd5c7cdfd80cf6acd2c67d8`, matrice 38172756139), réussissait
sur trois boutons/police 1,0 mais échouait sur police 1,3 au refus HTML
(2 219 ms). Ce rejeu contraire ne transforme pas le dernier échec en réussite
et ne suffit pas à attribuer sa cause : la qualification du délai de récupération
reste ouverte. Les contrats, constructions et tests de cache ne certifient pas
à eux seuls une lecture native publique fluide.

Ces résultats clôturent la préparation locale, sans activation. La PR786 reste
en brouillon, R2 payant désactivé, sans déploiement, migration ou nouveaux essais
sur les connexions fournisseur. Les derniers changements de rapport et les
commentaires de l'exemple d'environnement ne modifient pas le code testé.

## Reprise du 12 octobre : émulateur Android et copies réelles

Cette nouvelle campagne est autorisée sur les fichiers des catalogues du
compte de test. Elle reste **isolée de la production** : vrai code Edge/Gateway,
claims signés et admission de la source actuelle, mais endpoints de test privés.
Le Worker de stockage s'exécute sous **Miniflare, avec SQLite/R2 sur disque local**.
Aucun bucket Cloudflare payant, abonnement ou routage de production n'est activé.
Les titres sont lus séquentiellement ; chaque clôture draine le transport avant
la lecture suivante. La préparation globale en fond est désactivée dans ce banc.

### Corrections démontrées

- La revalidation native refusait une adresse de livraison dont le **chemin**
  était renouvelé. Elle réutilise maintenant la politique de renouvellement
  existante : même propriétaire/source/profil, même taille exacte, même hôte et
  forme de requête, preuve encore valide et **quatre échantillons frais identiques**.
  Changement d'hôte ou d'octets et option désactivée restent des refus.
- La mesure du refus HTML Android comptait le démarrage à froid de l'Activity.
  Le test mesure maintenant la limite au début réel de la réponse concernée.
  Le délai de 2 000 ms, le refus sans nouvelle tentative automatique, la reprise
  manuelle unique et le retour Back sont conservés.
- Le test TS lance son horloge de lecture après la première Surface réellement
  rendue. Les tolérances de PTS et de raccord restent inchangées.
- Le test de consentement TV attend le focus réel du renderer WebView avant
  d'envoyer les touches D-pad. L'idle du processus natif seul ne vidait pas cette
  file d'entrée. Consentement explicite, refus, touche maintenue et Back restent
  vérifiés.
- Un remplacement natif A → B pouvait échouer avec `reservation-budget` même
  pour une petite fenêtre, car il réservait deux fois le **maximum configuré**.
  Il planifie désormais les intervalles complets sans copie et réserve deux fois
  leur **taille sélectionnée réelle** avant toute copie. Le plafond global,
  l'interdiction de remplacer une entrée utilisée et le refus si la réservation
  réelle dépasse ce plafond sont inchangés. **56 tests ciblés réussis**.
- La campagne web révèle ensuite une double réservation dans la capture HLS :
  le maximum des segments et celui des intervalles source étaient additionnés,
  alors que l'archive hydratée doit respecter un plafond par fichier unique.
  Vidéo, sous-titres et intervalles source partagent désormais ce plafond ; les
  intervalles sont planifiés avant copie, la mémoire temporaire reste réservée
  deux fois, et une archive combinée trop grande est refusée. **95 tests ciblés
  réussis**, dont relecture après hydratation et refus d'un dépassement combiné.
  Ce défaut refusait B après la longue continuation de Lost et Minnal ; il ne
  rendait pas leurs premières reprises défaillantes.

### CI Android réparée

Sur `320f4dae1e915bedd4a41a25dc94cdd81008905e`,
[la matrice Android 38179180517](https://github.com/Admin-Adher/Norva/actions/runs/38179180517)
réussit dans **les six configurations** : téléphone API 35, gestes et trois
boutons, polices 1,0/1,3 ; TV API 34, polices 1,0/1,3.
[Le contrôle de consentement TV 38179180532](https://github.com/Admin-Adher/Norva/actions/runs/38179180532)
réussit aux deux tailles de police.
[Build Norva 38179180606](https://github.com/Admin-Adher/Norva/actions/runs/38179180606)
réussit : **6 544 tests, 39 ignorés**, SQL 50/50, Worker/SQLite/R2 local 15/15
et les trois paquets Android/Windows. Ces résultats remplacent le blocage
Android précédent ; ils ne valent pas validation sur un appareil physique.
La correction ultérieure de réservation est testée sur le commit
`48735863f54a3e8bf81b73f22988853b4b780ce8` ; sa CI reste distincte de cette matrice.

### Replays Android des catalogues réels

Émulateur Pixel 7 API 35 x86_64, WHPX, Surface Media3 native. Le runner opt-in
charge le vrai PlayerActivity, relaie heartbeat/claims vers le vrai Edge isolé,
vérifie la position décodée, effectue les sauts, puis Back et clôture explicite.
L'intégration du catalogue WebView et de son drain de closes en attente n'est
pas remplacée par une affirmation de validation : cette partie est distincte.

| Copie réelle | Départ / reprise, première image | Saut arrière / avant | Continuation après le dernier saut |
| --- | --- | --- | --- |
| Jolt — MP4 | 27,5 / 12,4 s | 3,3 / 6,9 s | 143,5 s de vidéo sur 150 s d'observation ; **4 relevés de buffering** |
| Minnal Murali — MPEG-TS | 7,7 / 17,3 s | 16,5 / 7,5 s | 148,3 s avancées ; aucun buffering échantillonné |
| Lost on a Mountain in Maine — MKV | 7,7 / 6,7 s | 2,4 / 6,0 s | 149,2 s avancées ; aucun buffering échantillonné |
| Between Father and Son [MULTI-SUB] — épisode MP4 | 12,6 / 12,9 s | 8,0 / 19,5 s | 131,8 s avancées sur environ 148 s ; aucun buffering échantillonné, mais progression inférieure au temps écoulé |

Les trois reprises ont utilisé les fenêtres natives conservées. Les codecs
observés par Media3 sont AVC/H.264 et audio AAC (`audio/mp4a-latm`). Aucune erreur
Media3 n'est relevée ; des images perdues subsistent. Les échantillons à une
seconde ne prouvent pas l'absence de toute micro-pause, ni la fluidité matérielle
d'un téléphone physique, ni la qualité à l'écoute. Les lectures dépassent
largement la fenêtre de reprise de 48 secondes.

Le rejeu supplémentaire de l'épisode utilise le dernier runner opt-in, avec
le protocole natif du client (`privateMediaCacheProtocol: 0`) et le parent série
réel. **Un test instrumenté réussi, 257,45 s**. La continuation dépasse
120 secondes de position vidéo après le dernier saut ; elle n'est pas annoncée
parfaitement fluide : 23 images perdues et un écart entre horloge et progression
restent présents. Preuve : `android-real-episode.log` et
`durable-real-events.safe.json`.

### Preuve web après redémarrage

Le vrai WatchPage, cloudApi et le gestionnaire de session lisent Jolt MP4 avec
les claims Edge isolés. Première lecture : **13,9 s**, sauts de **0,42 / 3,13 s**,
puis plusieurs attentes, dont une de **6,48 s**. Ce premier essai reste défavorable.

Après clôture et archivage B, le Gateway et le Worker local sont réellement
redémarrés : RAM vide, SQLite/R2 conservés. Reprise vers 317 secondes :
**6,95 s jusqu'à la première image**, puis **150,8 secondes de vidéo avancées**
en environ 157 secondes depuis le clic, **sans événement waiting ni erreur**.
Le compteur de réutilisation vaut un ; les quatre échantillons concordent
malgré le chemin de livraison renouvelé (`accepted-path-renewal`). L'archive A
est retirée pendant la progression sans interrompre le lease de lecture.

Ce rejeu démontre la persistance et le correctif de renouvellement sur cette
copie ; il ne transforme pas le premier essai avec pauses en essai fluide et
ne démontre pas une garantie sur tous les fournisseurs. Le banc ne reproduit
pas toute l'interface publique d'authentification et de catalogue.

### Web MKV : reprise persistée et sauts

Lost donne une première image en **4,59 s** lors de la lecture froide, mais
la lecture effective attend **98,67 s** pour constituer sa réserve. Il serait
incorrect de publier le seul délai de première image comme délai de démarrage.
Cette réserve n'est pas réduite pour faire passer le banc.

Après arrêt vers **41,74 s**, archivage et redémarrage du Gateway et du Worker,
la RAM HLS est vide et le cache durable est retrouvé : `hits: 1`,
`sampledHits: 1`, quatre échantillons concordants. Première image en **4,27 s**,
lecture effective en **4,89 s**. Les sauts vers 46,32 puis 303,42 s demandent
**0,022 / 0,113 s** ; les deux événements waiting associés valent
0,019 / 0,109 s. Après le dernier saut, la vidéo progresse jusqu'à **432,47 s**,
soit plus de **129 secondes** de continuation, sans nouvelle attente ni erreur.
Le compteur navigateur indique **zéro image perdue** sur cette ouverture.
Le saut avant quitte la fenêtre archivée initiale ; les données préparées
depuis la source pendant la lecture restent également disponibles.

Trois tentatives antérieures du banc étaient refusées avant création de
session. Le code d'erreur isolé était `MEDIA_CACHE_PRODUCER_CONTROL_UNAVAILABLE` :
la configuration héritée demandait un producteur de cache partagé, absent du
Gateway privé. Le banc Edge a été corrigé pour désactiver **ce cache partagé
uniquement**, déjà hors du périmètre de cette preuve. Cache privé de reprise,
claims, revalidation et admission restent actifs. Aucun réglage de production
n'est changé ; ces tentatives ne prouvent pas une panne du service public.

### Web MPEG-TS : cache persistant, continuation encore imparfaite

Minnal Murali : départ à zéro, première image **3,94 s**, lecture effective
**10,13 s**, puis arrêt vers **68,76 s** et archivage. Après redémarrage
Gateway/Worker avec RAM vide : première image **5,21 s**, lecture effective
**5,82 s**. La position reprend correctement, à la différence du rejeu Windows.

Sauts vers 87,09 puis 224,65 s en **0,030 / 0,011 s**. Les attentes associées
sont de 0,026 / 0,008 s, mais une nouvelle attente de **5,55 s** survient environ
douze secondes après le saut avant. La lecture atteint ensuite **408,13 s**,
soit plus de **183 secondes de progression** depuis cette cible, sans erreur
ni image perdue dans le compteur navigateur. Ce cas valide la réutilisation
persistante et le franchissement du cache ; il ne valide pas une continuité
sans interruption.

Preuves de la campagne sous `.codex-artifacts/startup-cache-20261010/` :
`durable-real-android-web-before.safe.json`, `durable-real-web-jolt.safe.json`,
`android-real-mkv-ts.log`, `android-tv-consent-focus.log`,
`native-B-budget.local.log` et `durable-replays-summary.safe.json`.

Les validations supplémentaires Windows, web MKV/TS et épisode sont consignées
dans la suite de cette section. La PR786 reste en brouillon et R2 payant désactivé.

### Windows natif : preuves et refus de validation MPEG-TS

Le banc utilise l'exécutable natif du paquet CI de `c60b118b`, avec les vrais
modules IPC/controller/input de la branche, une fenêtre vidéo LibVLC intégrée
et les claims Edge réels isolés. Il ne remplace pas la validation du catalogue
et du login du portable distribué. Les pauses provoquées pour afficher les
commandes sont exclues des fenêtres de continuation indiquées ci-dessous.

| Copie | Départ / reprise, première image affichée | Résultat après manipulation |
| --- | --- | --- |
| Jolt — MP4 | 47,64 / 13,34 s | Après le saut vers 214,8 s, seulement 56,7 s de vidéo avancent pendant 149,3 s sans intervention ; 64 images perdues supplémentaires. **Non fluide.** |
| Lost — MKV | 12,63 / 7,92 s | Reprise réelle vers 40,3 s après redémarrage Gateway/Worker, saut arrière puis avant vers 231,7 s ; plus de 203 s de continuation, aucune image perdue dans les compteurs. |
| Minnal — MPEG-TS | 5,70 / 7,20 s | Le cache est retrouvé après redémarrage, mais la seconde lecture repart à zéro au lieu de 84,5 s. Durée LibVLC nulle ; le bouton avant revient également à zéro. **Reprise et sauts non validés.** |

La distinction est essentielle : un `inputHit` ne prouve pas que le lecteur
applique correctement la position de reprise. Sur Minnal, le chemin de
livraison renouvelé passe les quatre échantillons, mais le défaut de position
est en aval. Le code natif applique initialement la reprise sur un événement
Playing lorsque `IsSeekable` est vrai, puis la remet à zéro ; les commandes
bornent leur cible à `player.Length - 500`. Avec une longueur nulle, cette
dernière borne devient zéro. Ces observations sont conservées, sans prétendre
avoir réparé la recherche temporelle de LibVLC sur cette copie.

L'essai d'agrégation des lectures natives est écarté : Jolt reste à environ
67 s et sa continuité n'est pas meilleure. `desktop/native-input.js` et son
test sont rétablis au code existant ; aucun réglage expérimental de transport
n'est conservé dans la PR. La correction de réservation B reste indépendante.

Preuves : `durable-windows-baseline.safe.json`, `durable-windows.safe.json` et,
pour l'expérience écartée seulement, `durable-windows-coalesced.safe.json`.
Le signal de première image de Jolt est calculé sur `displayedPictures > 0`,
pas sur son premier paquet vidéo décodé à 11,32 s.

### Nouvelle archive HLS B : créée et réutilisée, fluidité non validée

Après le correctif du plafond combiné, Lost repart sans l'ancienne archive B,
qui avait été refusée : première image **13,95 s**, lecture effective **113,78 s**.
Il avance jusqu'à environ 518 s, puis la fermeture conserve **15 703 500 octets**,
avec un stockage réussi et **aucun rejet de réservation**. Le Gateway et le
Worker local sont arrêtés/redémarrés, la RAM passant d'une entrée à zéro.

Cette nouvelle archive est retrouvée : `hits: 1`, `sampledHits: 1`, taille et
cible identiques, quatre échantillons frais concordants. Première image en
**6,61 s**, lecture effective en **7,30 s**. Le cache A est retiré de la RAM
pendant la progression, sans interrompre son lease.

Ce rejeu révèle cependant **44,32 s d'attente**, puis une autre attente de
**21,51 s** clôturée par le saut arrière. Ce dernier demande **0,075 s** ;
le saut avant hors des données disponibles demande **78,64 s**. Le correctif
de stockage ne valide donc pas une continuation fluide, ni des sauts rapides
hors cache. Ces résultats restent dans le bilan, même si les essais précédents
de Lost étaient meilleurs. Aucun seuil de réserve n'est abaissé pour masquer
ces attentes. Preuve : tentative web 9 dans `durable-real-events.safe.json`.

Après cette longue préparation, la continuation dépasse **164 secondes de
position vidéo** depuis la cible du saut avant, sans nouvelle attente ni erreur
dans les relevés. À la fermeture, une nouvelle B de **24 723 552 octets** est
conservée, avec zéro rejet de capture. Le problème de renouvellement de l'archive
est donc corrigé sur ce rejeu ; ses pauses et son saut long restent des échecs
de performance.

### Suite des contrôles Android et diagnostics CI

Le contrôle du bouton Back natif après retour au premier plan attend désormais
le **focus réel de la fenêtre** avant d'envoyer le vrai Back. La fermeture doit
toujours intervenir dans les trois secondes ; le test ne remplace pas Back
par un appel direct au code de fermeture. Rejeu local : **1 test réussi**.

La matrice du commit `db61106d` comporte ensuite deux interruptions du runner
téléphone : seulement **11/88** et **22/88** tests reçus, sans assertion d'échec.
Le flux logcat ADB se termine avec le code 255 alors que l'émulateur reste vivant.
Les traces disponibles n'établissent pas la cause de cette interruption.
Le script conserve maintenant aussi le buffer logcat du guest par une nouvelle
commande à la sortie en échec. Il conserve le statut d'échec original, sans
relancer les tests ni transformer une interruption en réussite.

Sur `41169195`, [Build Norva 38183036642](https://github.com/Admin-Adher/Norva/actions/runs/38183036642)
réussit : **6 547 tests, 39 ignorés**, SQL 50/50, Worker SQLite/R2 local 15/15,
et paquets Android/Windows. Le contrôle TV séparé échoue à police 1,3 sur le
focus du bouton d'acceptation après ouverture du consentement de pairing.
Le même test attend maintenant l'application des touches Right/Left par le
renderer avant l'assertion ; assertions de focus, choix explicite et Back
restent identiques. Rejeu local initial : **1 test réussi en 15,52 s**.
Second rejeu local à police **1,3 : 1 test réussi en 15,70 s**, puis police
remise à 1,0 sur cet émulateur de test.
La matrice Android et la validation de cette dernière modification restent
suivies séparément des résultats du build.

La matrice Android `38183036595` termine finalement avec **cinq configurations
réussies et un échec** : téléphone à trois boutons, police 1,0, sur le contrôle
Back de `advancedSimpleQpelBFramesRenderAndResume`. La mise au premier plan et le
focus ne suffisent donc pas à qualifier la voie d'injection précédente. La
vidéo redémarre avant la fin des transitions du lanceur observées dans logcat.

Le test emploie ensuite `UiAutomation.injectInputEvent` pour injecter une seule
paire réelle Back down/up. Cette API synchronise les animations de fenêtre et
les opérations de Surface avant l'entrée, contrairement à la voie précédente.
Les deux injections doivent réussir et la fermeture garde son délai de trois
secondes ; aucun appel direct à `finish` ou au callback Back ne remplace ce
contrôle. [Contrat Android de cette API](https://developer.android.com/reference/android/app/UiAutomation#injectInputEvent(android.view.InputEvent,%20boolean)).
L'échec initial reste conservé dans l'artefact `11718901875` et dans le bilan.
Premier rejeu local après redémarrage de l'émulateur : refus avant injection,
car le tutoriel système `ImmersiveModeConfirmation` prend le focus. Le banc
local est remis dans la même configuration que la CI (`immersive_mode_confirmations`
déjà confirmé), sans changement du produit. **Trois boutons / police 1,0 :
1 test réussi en 11,27 s**, avec background/retour, vidéo fraîche et vrai Back.
Preuves : `android-back-input-three10.logcat` (refus initial) et
`android-back-input-three10-confirmed.log` (rejeu configuré).
**Gestes / police 1,3 : 1 test réussi en 9,47 s** avec le même parcours et la
même injection, puis arrêt de l'émulateur de test. Les contrôles de consentement
TV du commit `9868c56c` réussissent aussi aux deux polices en CI :
[38184228832](https://github.com/Admin-Adher/Norva/actions/runs/38184228832).
La correction Back suivante requiert son propre passage de la matrice complète.

### Clôture de la campagne réelle

Les **18 sessions** du dernier banc ont toutes un accusé de clôture. À l'arrêt
final, Gateway privé : zéro session, zéro transport brut et zéro job durable.
Les trois conteneurs créés pour cette preuve sont arrêtés, les fichiers de
diagnostic temporaires sont remplacés par leurs sources normales, et les données
SQLite/R2 locales sont conservées. Le bridge, sa connexion SSH et l'émulateur
`norva-real-35` sont fermés ; aucune fenêtre de test Windows ne reste ouverte.

Contrôle du **12 octobre à 01:23 Paris** : les deux Gateways répondent `ok`, avec
zéro session et transport brut ; les deux Edges ont un healthcheck sain. Les
deux paramètres d'activation R2 sont faux sur les deux Gateways publics.
Preuve : `durable-real-cleanup.safe.json`. Production inchangée, **R2 payant
désactivé**, PR786 en brouillon. Les refus et défauts de lecture restants empêchent
de conclure que le cache est validé uniformément sur web, Android et Windows.
