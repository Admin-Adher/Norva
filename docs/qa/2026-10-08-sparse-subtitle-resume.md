# Reprise récente et sous-titres espacés — 8 octobre 2026

## Conclusion et périmètre

Poursuite autorisée de l'optimisation de Normal après PR705. Le candidat qui utilise l'assembleur HLS natif pour certifier les intervalles sans sous-titre est **rejeté avant déploiement** : un sous-titre futur connu disparaît dans un rejeu synthétique avec saut. Aucun gain supplémentaire sur Normal n'est démontré. Le pilote reste limité au compte déjà autorisé.

Un correctif indépendant est **déployé à 10:44 Paris** : un `ENDLIST` écrit à l'arrêt d'un encodeur ne prouve pas une couverture de sous-titres au-delà de ses fragments finalisés. La capture du cache et la publication de sa continuation respectent désormais toutes deux cette borne. La normalisation du seul blanc final de l'en-tête WebVTT conserve aussi le même référentiel pour `WEBVTT\n` et un fragment avec réplique. Aucun changement de texte, de piste, de langue, de réserve, de durée de vie ou d'identité du fichier.

## Expériences isolées

Image de référence `sha256:6359a11315e1a778bdcc1ef6a6cfed8d63b7f75d15a408765995b47418ee63f8`, FFmpeg de production, utilisateur 1000, réseau `none`, fichiers synthétiques en tmpfs, conteneurs supprimés en fin d'essai. Aucune lecture fournisseur ou navigateur lancée pour ces expériences.

1. HLS natif sait produire des fragments WebVTT finalisés vides avant la première réplique forcée à 70 s. Un même muxeur refuse cependant deux pistes WebVTT. Le premier essai conserve cette erreur.
2. Distribution de la même vidéo à un muxeur HLS par sous-titre : un seul encodage et aucune entrée média supplémentaire. Le premier échappement tee était incorrect ; FFmpeg pouvait continuer la seule voie principale avec un code de sortie zéro. Un autre essai utilisait POST et recevait 501 sur le récepteur local. Ils ne constituent pas des réussites. La version corrigée PUT consomme 40 corps locaux, 1 333 296 octets, sans stockage de la vidéo dupliquée.
3. Le partage du writer séquentiel de production bloque les premiers WebVTT encore ouverts : aucune playlist vidéo avant la borne de 10 s. Arrêt du seul processus de preuve. Une sortie locale distincte enlève ce blocage dans le prototype, sans modifier le writer vidéo déployé.
4. Comparaison A/B/A contrôlée en ordre ancien/natif/natif/ancien, fichier synthétique 90 s à débit d'entrée fixé à huit fois le temps réel. Première playlist vidéo : ancien **2 563 / 2 578 ms**, natif **2 566 / 2 569 ms**. Ce sont des publications serveur synthétiques, pas des démarrages utilisateur ni une mesure sur Normal. Aucun gain démontré.
5. Une réplique 2,023–14,023 s n'existe que dans le premier fragment natif 0–4 s. Les fragments suivants sont vides. Le prototype de projection conserve donc les répliques entières au-delà de leur premier fragment ; un fragment vide isolé ne suffit pas à conclure à leur absence.

## Échec bloquant du candidat complet

Fixture de 240 s, une piste forcée et deux pistes ordinaires. La piste forcée contient notamment une réplique **150,021–155,021 s**, prouvée dans l'entrée. L'extraction depuis le début la retrouve. Après une reprise à **132 s**, avec prélecture à **117 s**, elle manque dans la sortie native alors que la réplique ordinaire à 190,021 s est conservée.

Une comparaison supplémentaire, sans tee ni encodeur vidéo pour la voie de contrôle des sous-titres, utilise `copyts`, une vidéo copiée, aucun seek de sortie sur cette voie et mesure ses PTS : origine vidéo **116,021 s**, durée couverte affichée **123,936 s**, piste forcée vide. L'extraction des paquets de l'entrée par ffprobe retrouve pourtant la réplique forcée à 150,021 s, y compris avec son propre intervalle de lecture démarrant à 117 s. Cela invalide la certification d'une absence par les seules listes HLS natives dans ce scénario. Cela ne prouve pas la cause interne précise du chemin de saut, ni que le fichier réel Normal présente exactement ce cas.

Autre limite retrouvée : un seek de sortie absolu à 60,5 s supprime une réplique débutant à 60,021 s et se prolongeant jusqu'à 110,021 s. Choisir un raccord hors d'une réplique connue évite cette coupure particulière ; cela ne répare pas la disparition de la réplique future à 150 s. Cette sélection et le candidat de muxage sont donc retirés du code livrable.

Le reçu `functional.safe.json` du prototype avait réussi ses assertions partielles (cache acquis, réplique traversante, décodage de courts extraits). **Il n'est pas une validation du candidat.** La revue de toutes les pistes a révélé la réplique manquante. Ce même premier script avait omis l'option 90 kHz déjà présente en production et émettait des diagnostics PTS/DTS : ils sont conservés, pas attribués au runtime déployé. L'expérience indépendante `absolute-clock-proof` conserve les horodatages 90 kHz et n'a pas ces diagnostics, mais reproduit la piste forcée manquante.

## Correctif retenu et vérifications

- `captureSubtitleWindow` refuse une fenêtre vidéo dépassant la dernière durée de sous-titres réellement annoncée, même avec `ENDLIST`.
- Le constructeur de continuation applique la même limite ; il ne publie pas la suite vidéo comme si la piste était entièrement couverte.
- En-tête WebVTT : seul le blanc final est normalisé ; les contrôles du timestamp map restent inchangés.
- **53 tests ciblés réussis** sur le code retenu : cache privé, horloge glissante, sous-titres ; trois nouveaux cas de non-régression. Les 80 tests intermédiaires du candidat retiré ne sont pas le décompte du code livré.
- Inventaire read-only à 08:34 UTC : les deux Gateways conservent les 89 fichiers et permissions de PR705 ; les deux Edge conservent leurs 194 fichiers. Aucun runtime ni environnement modifié à cet instant.

## État de livraison

PR706, code `170d99fc99524622c5a706a1afc858bc322643d3`. Les 53 tests ciblés ont été rejoués avec le cas de couverture partielle corrigé : sous-titres finalisés jusqu'à 12 s, vidéo demandée de 8 à 16 s. Ce cas échoue avec l'ancienne exemption `ENDLIST` et passe avec la borne conservée. Les cinq contrôles du code ont réussi : contrats cloud, commentaire de prévisualisation et paquets Android Phone, Android TV et Windows. Aucun client ni interface n'est modifié, aucune nouvelle validation émulateur revendiquée.

Canary réel à **08:42:47 UTC**, réseau `none`, utilisateur `1000:1000`, GPU réel, stockage temporaire séparé et aucun volume de production. Fixture FFmpeg de 600 s, fenêtre glissante conservée avec audio/vidéo/sous-titres, continuation de 280 s et décodage du raccord : test réussi. Le cas supplémentaire ferme prématurément la liste de sous-titres à 330 s alors que la fenêtre vidéo va de 316 à 368 s ; le cache refuse correctement cette capture partiellement couverte. Le test ne certifie pas les sous-titres du prototype rejeté. Fichiers synthétiques supprimés et canary arrêté/retiré. Aucun appel fournisseur.

Image déployée sur les deux Gateways : `sha256:efd3ae83ac95f4b8ecf563f4cc39e085e50db06550acb2664b9c94a43a36b2f9`. Arbre des sources : `f08af9afe7057991aab7349b6edfc4e784358e8665a550f40b153891218f230c`. Deux fichiers modifiés sur 89 ; 87 fichiers et leurs permissions conservés. Les Edge et leurs 194 fichiers restent inchangés. Environnement de production conservé, pilote toujours borné au propriétaire autorisé.

Pause des admissions de **08:43:29.323867 à 08:44:31.495559 UTC**, soit **62,171692 s**, dont attente naturelle de deux travaux loués puis d'un. Aucun bail forcé, aucun lecteur actif au préflight. Gateways démarrés à 08:44:27.201 / 08:44:29.776 UTC. À **08:44:49 UTC**, santé et 89 empreintes concordantes sur chaque replica, cron actif, admissions restaurées, worker en marche, dispatcher original conservé et marqueur de pause absent. Marqueur d'application consommé : ne pas rejouer l'opérateur.

Aucun candidat de muxage natif n'est activé. Aucun nouveau temps de reprise réel n'est revendiqué. Les résultats antérieurs Vice-versa 2 / Normal de PR705 restent distincts. La limite des sous-titres espacés de Normal reste ouverte : le correctif de couverture peut refuser davantage de caches incomplets, il n'est pas une accélération du film.

## Preuves

Reçus locaux sous `.codex-artifacts/sparse-subtitle-resume-20261008/` : `native-hls-proof.safe.json`, `tee-proof*.safe.json`, `admission-first.safe.json`, `admission-proof.safe.json`, `local-tee-proof.safe.json`, `startup-ab.safe.json`, `functional.safe.json`, erreurs synthétiques conservées, `absolute-clock-first.safe.json`, `absolute-clock-proof.safe.json`, `deployment-reference.safe.json`, `image.safe.json`, `canary.safe.json`, `functional-canary.safe.log`, `deployment.safe.json`, `post-deployment.safe.json` et `code-checks.safe.json`. Le code rejeté est conservé dans `rejected-candidate/`, exclu du runtime. L'attachement de PR706 au chat a été refusé à la limite de 100 pièces ; aucune pièce retirée.

## Reprise de l'investigation — cause du sous-titre manquant établie

Contrôles supplémentaires avec l'image PR706 et FFmpeg **5.1.9**, UID1000, réseau `none`, CPU borné à deux, mémoire 512 Mio, tmpfs 128 Mio, conteneur temporaire retiré après chaque expérience. Aucun appel fournisseur, aucune lecture navigateur et aucun changement de production. Les 53 tests précédents restent ceux du correctif PR706 ; ils ne sont pas présentés comme de nouveaux tests d'optimisation.

### La perte précède la conversion

Huit chemins comparés dans `seek-matrix.safe.json`. Depuis le début, la sortie WebVTT et la sortie HLS retrouvent les deux répliques 70,021–75,021 et 150,021–155,021 s. Après `-ss 117`, la copie directe SRT, la conversion WebVTT et HLS ne retrouvent aucune de ces deux répliques. `-noaccurate_seek` et `-seek_timestamp 1` ne réparent pas cette perte. Ce n'est donc pas un défaut propre au cache ou au muxeur HLS.

### Correction du contrôle ffprobe précédent

Le contrôle initial utilisait `-select_streams s`. Dans ffprobe, cette sélection désactive les autres flux **avant** le saut. Le flux choisi par défaut pour trouver une position devient alors un sous-titre. FFmpeg effectue son saut initial avant d'appliquer ses options de rejet des flux et choisit ici la vidéo. Les deux contrôles suivaient donc des index différents. Une première hypothèse de revue, selon laquelle FFmpeg désactiverait déjà les sous-titres avant le saut, est réfutée par l'ordre réel du code et n'est pas retenue. Sources primaires : [initialisation FFmpeg 5.1.9](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/fftools/ffmpeg_opt.c), [sélection ffprobe](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/fftools/ffprobe.c), [choix du flux par défaut](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/libavformat/avformat.c).

Le nouveau contrôle sans `-select_streams` retrouve exactement l'omission :

| Fait observé dans la fixture | Position |
| --- | --- |
| Réplique attendue à 150,021 s | octet **3 201 354** |
| Première vidéo après saut à 117 s | **116,021 s**, octet **5 314 388** |
| Réplique ordinaire à 190,021 s | octet **8 700 559**, conservée |

Le saut vidéo dépasse physiquement les octets de la réplique future. Le démultiplexeur ne les rencontre plus. La sélection `s` dans ffprobe repart au contraire des paquets de sous-titres à 60/70 s, et retrouve celui de 150 s. Les options `-discard:v all`, `-discard:a all` et `-seek2any 1` testées ne changent pas le résultat FFmpeg. Le [seek Matroska de cette version](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/libavformat/matroskadec.c) suit l'index du flux choisi. Cette preuve porte sur la fixture ; elle n'établit pas que Normal présente le même placement physique.

### Deux remèdes expérimentaux et leurs limites

1. **Repartir plus tôt** : demander 70 s mène à la vidéo 68,021 s, octet 3 110 066, et conserve les deux répliques encore nécessaires après 132 s. Le point de départ est donc 48 s de vidéo et 2 204 322 octets plus tôt que dans le saut défaillant. C'est une récupération prouvée sur ce fichier synthétique, pas un gain de délai réseau. Un recul fixe ne suffit pas pour tous les fichiers ou les longues répliques traversantes.
2. **Changer l'intercalage lors de la création de la fixture** : avec `-max_interleave_delta 0`, la même réplique à 150,021 s est écrite à l'octet 6 862 624. Le saut à 117 s la retrouve alors, ainsi que la réplique à 190 s. Cette comparaison établit la dépendance au placement des paquets dans le fichier de test. Le réglage appartient à sa création ; l'ajouter à la sortie Gateway ne déplace pas les octets d'un fichier fournisseur existant.

La piste nommée « forced » dans cette fixture ne porte pas de disposition forcée : aucune anomalie propre à ce drapeau n'est démontrée. Pour rendre une recherche antérieure fiable sur des fichiers réels, il faudrait une preuve de complétude des index de chaque piste et conserver les répliques chevauchantes. Matroska recommande les entrées d'index pour chaque sous-titre mais autorise des index sélectifs : une entrée absente ne prouve pas le silence. [Recommandations Cues](https://www.matroska.org/technical/cues.html), [index sélectifs](https://www.matroska.org/technical/diagram.html).

**Décision :** aucun nouveau correctif ni réglage déployé sur ces expériences. Le candidat reste rejeté, Normal n'est pas davantage accéléré. La cause de l'échec synthétique est désormais expliquée, et le contrôle d'acceptation devra comparer tous les flux après le même saut, avec un inventaire complet des répliques attendues. Reçus et scripts supplémentaires : `.codex-artifacts/subtitle-seek-cause-20261008/seek-matrix.*`, `seek-packet-path.*` et `backtrack-cost.*`.


## Prototype suivant — conserver les répliques déjà rencontrées

Nouvelle approche expérimentale, **non intégrée au produit et non déployée** : conserver les répliques entières déjà décodées, même si leur affichage est prévu après la fin de la vidéo actuellement préparée. Deux sorties WebVTT supplémentaires du même processus FFmpeg alimentent le registre ; aucune seconde entrée média ni nouvelle connexion fournisseur. Les expériences restent synthétiques, réseau `none`, sous l'image PR706 et les mêmes bornes d'isolation.

Dans la fixture, la réplique prévue à **150,021–155,021 s** arrive dans le pipe alors que la playlist vidéo n'atteint que **68 s**. L'arrêter vers 100 s puis repartir après ses octets ne la fait plus perdre si le nouveau producteur hérite de ce registre. La réplique **60,021–110,021 s**, qui traverse le raccord, est également conservée. Les voies de registre n'appliquent aucun seek de sortie qui couperait cette réplique. La réplique nouvelle à 190,021 s provient bien du second parcours. Le résultat conserve les trois répliques attendues après le raccord de cette fixture ; ce n'est pas une preuve exhaustive pour d'autres placements de paquets.

### Ressources et cycle de vie

Un helper expérimental vérifie l’égalité des identifiants fournis pour le fichier/profil, les pistes, l’époque du producteur et l’horloge déclarée ; il borne le texte et le nombre de répliques. Il ne valide pas lui-même l’identité réelle du fichier fournisseur. Il conserve les blocs complets, décode l'UTF-8 fragmenté, refuse les fins malformées ou non confirmées et attend le drainage de toutes les voies avant d'émettre un instantané. Après dépassement d'une borne, il invalide le registre tout en continuant à vider les pipes : fermer un pipe pourrait casser la lecture vidéo. Les instantanés sont immuables et révocables dans le même processus ; leur sérialisation JSON ne vaut pas preuve.

**21 tests du helper réussissent.** Les premiers essais de collecte et de navigateur utilisent le collecteur initial. Le raccordement du helper borné aux vrais pipes FFmpeg a d’abord échoué à leur fin : FFmpeg termine chaque dernière réplique par une seule LF, et le parseur en exigeait deux. Diagnostic conservé : queues de 38 et 33 octets, UTF-8 complet, fins des deux pipes observées, sortie contrôlée 255, aucune erreur FFmpeg. Le bloc final terminé par LF/CRLF est désormais conservé en attente puis intégré seulement après fermeture gracieuse et drainage de toutes les pistes ; une fermeture anormale, un bloc malformé ou un dépassement reste refusé. Une troncature textuelle restant syntaxiquement valide ne peut pas être détectée par ce registre.

Le rejeu isolé avec le helper corrigé réussit : quatre répliques parent ; après conservation à partir du raccord de 100,25 s, deux répliques héritées (future et traversante) ; trois répliques finales après la nouvelle réplique à 190 s. Les deux producteurs ferment leurs deux pipes, sans reste non analysé ni erreur FFmpeg. Ce résultat de collecte est distinct de la projection navigateur décrite plus bas. La revue a intercepté une allocation répétée d'instantanés et une libération prématurée de leur réservation par `prune` : le producteur fermé est désormais figé, l'instantané est mémorisé et sa réservation conservée. Le budget cumulé entre producteurs reste à intégrer au propriétaire réel du cache. Les blocs strictement identiques sont dédupliqués ; le helper ne certifie pas le nombre de paquets source et ne contient aucun champ affirmant une couverture ou un silence.

### Vérification avec le lecteur réel, sur média local synthétique

hls.js **1.7.3** est utilisé dans le navigateur Chromium sur une page locale, sans session Norva ni fichier fournisseur. Les fragments de cette preuve navigateur sont assemblés après la fin des deux producteurs synthétiques : ce contrôle ne valide ni leur publication en direct ni le délai utilisateur. Le premier assemblage incluait un dernier segment partiel et montrait deux copies d'une réplique avec un écart de fin de 635 ms. Sa cause précise n'est pas établie ; cet essai reste un échec conservé.

Le second assemblage utilise uniquement les segments complets du parent, aux bornes de playlist **64 à 96 s**, puis une continuation avec prélecture à 81 s et découpe vidéo à 96 s. Les répliques héritées réapparaissent, mais recopier leur durée entière dans les deux époques HLS crée encore un doublon : fins **46,021** et **46,063333 s**. Les horloges extraites des TS et celles du lecteur expliquent les **42,333 ms** : la nouvelle vidéo commence à 1,442333 s et son audio à 1,4 s ; hls.js choisit cette origine audio pour initialiser la nouvelle époque. Changer arbitrairement la map WebVTT pour supprimer l'écart avancerait aussi les répliques par rapport à la vidéo. Sources primaires : [remuxeur hls.js 1.7.3](https://github.com/video-dev/hls.js/blob/v1.7.3/src/remux/mp4-remuxer.ts), [parseur WebVTT](https://github.com/video-dev/hls.js/blob/v1.7.3/src/utils/webvtt-parser.ts).

Le prototype conserve donc le registre original entier et partitionne seulement sa projection à la frontière des deux époques. Observation DOM du lecteur :

| Contrôle | Résultat observé |
| --- | --- |
| Avant raccord, temps local 15,211 s | Une seule réplique, intervalle 0–32 s |
| Après raccord, temps local 37,261 s | Une seule réplique, intervalle 32,042333–46,063333 s |
| Réplique future, temps local 87,232 s | Réplique précédemment perdue visible, intervalle 86,063333–91,063333 s |

Les trois contrôles ont `readyState=4` et aucune erreur hls.js ; pause volontaire pour lire les états. **Le trou de 42,333 ms au raccord subsiste** et la frontière utilisée vient des durées de playlist, pas encore d'une mesure complète des PTS source. Ce test prouve la récupération et l'absence de doublon dans ces états ; il ne certifie pas un raccord parfaitement continu, l'audio à l'écoute, Android ou un film entier.

### Ce qui empêche encore l'intégration

L'avancement de la vidéo et le recouvrement de quinze secondes ne prouvent pas que tous les octets de sous-titres antérieurs au nouveau point d'entrée ont été conservés. Il manque un point de progression du démultiplexeur, validé après drainage, ou une preuve équivalente de parcours contigu sans trou, ainsi qu'une règle de publication qui ne déclare pas trop tôt un intervalle vide. Le maximum d'octets reçus par le broker, le PTS vidéo et `ENDLIST` ne suffisent pas.

Une piste réellement parcourue de l'origine jusqu'au vrai EOF naturel, sans seek omettant des paquets, sans troncature ni limite de durée, après conversion réussie et drainage complet, pourrait être réutilisée comme piste complète. Ce domaine est plus simple mais apporte peu aux reprises habituelles au milieu de Normal, avec la fenêtre vidéo actuelle. Il ne justifie pas de lire préventivement tout le film.

**Décision :** piste prometteuse prouvée sur les répliques connues, conservée comme prototype. Aucun gain de démarrage réel de Normal, aucune nouvelle lecture fournisseur, aucun changement de seuil, durée de vie, route ou concurrence. Le pilote de production reste restreint. Preuves : `.codex-artifacts/subtitle-ledger-20261008/`, scripts FFmpeg, registre et tests, reçus de collecte, horloges PES, états navigateur et capture `future-cue-browser.png`.

Contrôle final read-only à **2026-10-08 10:15:30 UTC** : les deux Gateways sont sains, même image PR706 et mêmes démarrages ; `owner-allowlist` conservé, dispatcher permanent actif et conteneur de preuve absent. Onglet synthétique fermé et serveur local arrêté. Aucun déploiement. Les cinq contrôles documentaires de PR707 sont désormais réussis, paquets compris.

## Horloges au raccord — expérimentation suivante, hors production

Les contrôles suivants utilisent encore une fixture locale de 240 s, H.264 24 images/s et AAC-LC stéréo 48 kHz, dans l'image PR706 isolée du réseau. Ils ne lisent aucune VOD fournisseur. La collecte emploie ici le premier collecteur expérimental, borné par assertion à 64 Kio dans cette fixture, et non une nouvelle intégration du helper de 21 tests.

### Conserver les répliques entières

La partition à la frontière de deux époques, testée précédemment, n'est pas retenue pour intégration. Un segment WebVTT HLS doit porter la durée complète de chaque réplique qui le chevauche ; scinder artificiellement une réplique au raccord n'est donc pas une solution générale conforme à cette règle. La nouvelle expérience conserve les blocs originaux entiers dans chaque fragment pertinent. Elle conserve également `EXT-X-DISCONTINUITY` entre les producteurs. [RFC 8216, sections 3.5 et 4.3.2.3](https://datatracker.ietf.org/doc/html/rfc8216).

### Un simple décalage ne suffit pas

Le premier essai ajoute 96 s aux timestamps de la continuation : sa première vidéo vaut **97,421 s**, au lieu de **97,442333 s** dans la continuation témoin du parent. Son audio commence à **97,378667 s**, alors que le dernier paquet parent finit vers **97,442667 s**. Le calcul initial de durée vidéo utilisait un champ absent de ffprobe et donnait `null` ; il n'est pas interprété comme un écart nul. Une lecture des paquets de la séquence parent continue fournit ensuite la référence réelle.

Une matrice distincte de six encodages synthétiques de 120 s compare parent, continuation sans décalage, décalage seul, `avoid_negative_ts=disabled`, `mpegts_copyts=1`, puis ces deux dernières options ensemble. Désactiver `avoid_negative_ts` ne résout pas le raccord. Préserver les timestamps MPEG-TS enlève le décalage de transport de 1,4 s, mais conserve le même décalage relatif audio/vidéo : ce n'est pas une correction suffisante.

Les empreintes d'extradata H.264 différaient aussi. Leur lecture montre les mêmes octets SPS/PPS affichés et un octet nul final supplémentaire côté parent. Cette seule différence d'empreinte ne prouve donc pas des paramètres de codec différents. Aucun contrôle de compatibilité de production n'est supprimé.

### Résultat positif, borné à cette fixture

Le candidat ajoute **96 + 1 024/48 000 s** et retire les **deux premiers paquets AAC** de la continuation, qui recouvrent ici l'audio déjà fourni. Ces valeurs sont déterminées pour cette expérience ; elles ne constituent pas une règle applicable à tous les fichiers, fréquences, codecs ou positions de reprise. Aucun paquet ni timestamp de production n'est modifié.

Après cet ajustement, la première vidéo de continuation est **97,442333 s**, identique à celle du parent poursuivi, et le premier audio est **97,442667 s**. La dernière vidéo parent vaut 97,400333 s : l'intervalle suivant est 42 ms, cohérent avec la cadence quantifiée de la fixture. L'écart audio calculé depuis les décimales ffprobe est 1 microseconde, en deçà d'un tick 90 kHz ; cela ne certifie pas l'identité des échantillons.

Comparaison dans Chromium avec hls.js 1.7.3, même page et mêmes segments parent complets 64–96 s, six secondes de lecture autour du raccord, sans modification du lecteur :

| Mesure | Témoin avec répliques entières | Candidat aligné avec répliques entières |
| --- | --- | --- |
| Répliques traversantes actives, 116 observations | Deux | Une |
| Fin de la réplique traversante | 46,021 et 46,063333 s | 46,021 s |
| Plus grand intervalle de `mediaTime` près du raccord | 85,334 ms | 42 ms |
| Origine hls.js des deux époques | Différentes | 5 889 810 ticks pour les deux |
| Erreurs hls.js / erreur média | Aucune | Aucune |

Le sous-titre futur est également visible après un saut local : intervalle **86,021–91,021 s**, une seule réplique active, `readyState=4`. Le marqueur de discontinuité HLS reste présent. L'absence de doublon résulte des horloges concordantes, sans raccourcir les répliques ni ajouter de déduplication approximative. Le parseur hls.js crée ses identifiants de répliques sans identifiant explicite à partir des temps ajustés et du texte. [Code du parseur 1.7.3](https://github.com/video-dev/hls.js/blob/v1.7.3/src/utils/webvtt-parser.ts).

### Limites d'acceptation

Ce résultat lève le décalage de 42 ms **sur cette fixture**, pas la preuve de couverture complète des sous-titres ni celle du point source exact d'une reprise réelle. Il utilise des segments assemblés après la fin des producteurs. Les mesures de première playlist avec entrée synthétique à vitesse 12 ne sont pas des délais utilisateur. Aucune validation Android, aucun nouvel essai sur Normal et aucun gain de démarrage réel ne sont revendiqués.

Une comparaison audio plus stricte décode deux segments autour du raccord et les compare au parent continu. Les deux sorties ont **384 000 échantillons par canal**. Sur 19 200 échantillons du canal gauche de la fenêtre de 0,4 s autour du raccord, l'écart maximal vaut **0,040373** et l'erreur RMS **0,002571** en PCM flottant ; aucune séquence de valeurs proches de zéro n'y est observée. Il s'agit d'une sinusoïde, sans acceptation à l'écoute. L'alignement des timestamps n'implique donc pas l'identité du signal ; cet écart entre deux encodages ne prouve pas non plus un défaut audible. Le démarrage d'un nouvel encodeur est une piste à approfondir, sans attribution causale complète à ce stade.

Les premières comparaisons par concaténation TS brute puis par playlist HLS avec discontinuité émettent aussi des diagnostics `Packet corrupt` sur la vidéo à la jonction. Ils sont conservés dans les reçus et ne sont pas attribués à Norva en production. La signalisation de cette jonction dans les paquets TS fait l'objet du contrôle complémentaire ci-dessous.

Ce contrôle ajoute `mpegts_flags=+initial_discontinuity` uniquement aux nouveaux segments synthétiques. Les diagnostics disparaissent dans le décodage HLS ; les timestamps et les mesures PCM restent identiques. Le drapeau du transport et le marqueur de playlist répondent donc ici à deux besoins distincts. Cette variation est validée par FFmpeg, pas rejouée dans Chromium ; les preuves navigateur précédentes portent sur le candidat sans ce drapeau. Aucun réglage MPEG-TS du produit n'est changé.

**Décision :** aucun déploiement. Les deux difficultés restantes sont la preuve de parcours complet des paquets de sous-titres et une règle de raccord audio/vidéo valable au-delà de la fixture. Le pilote reste borné au compte autorisé ; aucune réserve, garde, route, durée de vie ni concurrence modifiée. Preuves et scripts : `.codex-artifacts/subtitle-continuity-20261008/`, notamment `clock-options`, `aligned-clock`, les deux contrôles audio, les états navigateur et `aligned-future-browser.png`. Les cinq contrôles documentaires de PR708 ont maintenant réussi, paquets compris.

Contrôle final read-only à **2026-10-08T12:56:47.488035+00:00** : deux Gateways sains, image PR706 et démarrages inchangés, portée `owner-allowlist`, dispatcher permanent actif. Conteneur de preuve absent, onglet synthétique fermé et serveur local arrêté. Le raccord de la fixture est amélioré, mais aucune accélération supplémentaire de Normal n’est validée.


## Parcours des octets et généralisation audio — essais suivants, hors production

### Une preuve de préfixe physique, sans inférer le silence

Un nouveau helper expérimental suit les octets contigus depuis le début d'un MKV. Il n'avance son point de reprise qu'après un cluster complet et conserve tous les paquets de sous-titres rencontrés, y compris ceux dont l'affichage est prévu plus tard. Un trou, un changement d'identité déclarée, un CRC incorrect ou une structure non prise en charge invalide son reçu. Les paquets identiques à des positions distinctes restent distincts : le texte seul ne sert pas à compter les événements.

Le domaine accepté est volontairement limité : clusters de taille connue, sous-titres `S_TEXT/UTF8`, durées explicites, aucune compression/chiffrement, aucun changement de codec ou d'échelle de piste. Le calcul des timestamps tient compte du timestamp du cluster, du décalage signé du bloc et de l'échelle du segment ; les autres transformations sont refusées. [Éléments Matroska](https://www.matroska.org/technical/elements.html), [calcul des timestamps](https://www.matroska.org/technical/notes.html).

**27 tests réussissent**, notamment les trous et reprises de plages, les clusters incomplets, les CRC altérés, les formats non pris en charge, les limites de rétention, les reçus forgés par JSON et la révocation d'un parent. Les reçus restent locaux au processus. Le helper ne certifie ni l'identité réelle du fichier fournisseur, ni un intervalle temporel sans sous-titre, ni la complétude du film. Il exige encore les gardes actuelles du cache. Les métadonnées et structures ignorées ne font pas de lui un validateur général de fichiers Matroska.

### Comparaison indépendante sur le MKV généré par FFmpeg

La fixture de 240 s comporte deux pistes et cinq paquets de sous-titres. La référence est une lecture ffprobe complète, **sans saut et sur tous les flux**, avec empreintes SHA-256 des paquets. Le helper consomme les octets par morceaux de 64 Kio au maximum, dans le conteneur isolé du réseau.

| Contrôle | Résultat |
| --- | --- |
| Taille de la fixture | 10 988 142 octets |
| Dernier cluster entièrement prouvé avant la vidéo de 100 s | Fin à l'octet 4 577 010, timestamp de cluster 96 s |
| Paquets conservés dans ce préfixe | 4, dont la réplique future à 150,021 s |
| Continuation contiguë depuis cette borne | 5 paquets au total |
| Comparaison au témoin complet | Mêmes positions, timestamps, durées et empreintes pour les cinq paquets |
| Trou volontaire dans la continuation | Refus `noncontiguous-range` |
| Maximum du tampon de parcours observé | 216 454 octets ; ce n'est pas la mémoire totale du processus |

Les cinq paquets correspondent aux événements à **2,021 / 60,021 / 70,021 / 150,021 / 190,021 s**. Le saut FFmpeg ordinaire à 81 s omet toujours celui de 150 s ; le parcours contigu suivi du registre le conserve. Seuls 38 octets de texte sont retenus dans cette fixture, en plus des objets et empreintes. Les octets synthétiques complets sont utilisés ici pour la référence de comparaison ; cela n'autorise pas une lecture préventive complète des VOD.

Cette preuve est un progrès sur la couverture **physique des paquets de cette fixture**. Elle ne raccorde pas encore le broker réel au démultiplexeur : il faut imposer une continuation depuis une borne prouvée, avec la prélecture vidéo nécessaire et sans trou. Les fenêtres actuelles d'entrée peuvent être dispersées ; elles ne deviennent pas un préfixe complet par simple maximum d'offset. La conversion en répliques avec leur mise en forme et les budgets cumulés entre producteurs restent à intégrer.

### La règle audio fixe échoue à se généraliser

Six continuations synthétiques comparent le réglage précédent « décalage de 1 024/48 000 s et retrait de deux paquets AAC » au même parent poursuivi. Les sources sont AAC 48 kHz / vidéo 24 images/s, AAC 44,1 kHz / 25 images/s et MP3 48 kHz / 29,97 images/s, à deux positions chacune ; les sorties sont AAC-LC 48 kHz stéréo.

La première vidéo concorde dans les six essais. En revanche, **une seule des six continuations commence sur le même PTS audio que le parent témoin**. Les cinq autres écarts vont de −480 à −1 941 ticks à 90 kHz, soit environ −5,33 à −21,57 ms. Aucun diagnostic FFmpeg dans cette matrice, mais ce n'est pas une acceptation sonore. La mesure compare au premier paquet du segment parent suivant, afin de ne pas attribuer au candidat les petites quantifications déjà présentes dans le témoin. La règle fixe n'est donc pas intégrée.

### Identifier un recouvrement réel de l'audio

Une autre expérience emploie un bruit rose déterministe, pour éviter la répétition d'une sinusoïde. Elle cherche une correspondance unique de **48 paquets consécutifs**, 24 de chaque côté de la borne étudiée, entre parent et continuation avec huit secondes de prélecture demandée. Il s'agit d'environ une seconde au total ; la lecture témoin complète sert ici d'oracle.

- **AAC conservé sans réencodage : quatre correspondances uniques sur quatre**, aux deux fréquences 48/44,1 kHz et aux deux positions. Les empreintes et durées sont identiques. Les écarts de timestamps vont de −15 à +1 ticks selon les paquets, soit au plus 0,167 ms en valeur absolue ; un seul essai a tous les timestamps strictement identiques.
- **Nouvel encodage AAC : aucune correspondance exacte dans les six essais**, avec sources AAC 48 kHz, AAC 44,1 kHz et MP3. Cette absence ne démontre pas à elle seule une dégradation audible entre deux encodages ; elle empêche d'utiliser l'identité des paquets comme preuve de raccord dans ces cas.
- Le muxeur TS audio seul écrit `frame size not set` dans les journaux de cette seconde expérience. Ce diagnostic est conservé ; les essais ne sont pas présentés comme exempts d'avertissements.

La comparaison confirme une piste exploitable pour l'audio compatible conservé tel quel, mais n'autorise aucun décalage général ni changement de politique de codec. Il manque encore une horloge d'échantillons conservée et un raccord vérifié lorsque le réencodage est nécessaire. Aucune acceptation à l'écoute ni nouveau rejeu navigateur/Android dans cette phase.

### État de production et décision

**Aucun code de production, réglage ou déploiement modifié. Aucun appel fournisseur. Aucun gain supplémentaire sur Normal revendiqué.** Les essais sont terminés, le conteneur synthétique a été supprimé avec ses médias éphémères. Le pilote reste limité au compte autorisé.

Contrôle read-only à **2026-10-08T13:21:43.009446+00:00**, soit **15:21 Paris** : deux Gateways sains, même image PR706 et mêmes démarrages ; portée `owner-allowlist`, dispatcher permanent actif, conteneur de preuve absent. Les cinq contrôles documentaires de PR709 ont réussi, paquets compris.

Reçus et scripts : `.codex-artifacts/subtitle-coverage-20261008/`, notamment `byte-prefix-proof`, `real-prefix-proof`, `audio-clock-matrix`, `audio-overlap-proof`, `unit-tests.tap` et `runtime-check.safe.json`. Les 27 tests unitaires, les six essais de règle fixe et les dix essais de recouvrement sont trois groupes distincts ; ils ne constituent pas une certification de lecture sur toutes les VOD.


## Stockage réel du cache et grille audio — intégration isolée suivante

Cette phase utilise la **vraie classe `PrivateResumeHlsCache` de l'image déployée**, instanciée dans un conteneur de preuve réseau `none`. Elle ne branche pas encore le prototype sur les sessions de production. L'empreinte SHA-256 du module est `300d54c20cd120fbb7fc6c4eceeff70516841cb3f3ca12153cbd812afc864b7b`, concordante avec la source locale normalisée en LF. Aucune VOD fournisseur ni interface utilisateur n'est sollicitée.

### Cycle de vie et conservation après passage par le cache

Les **4 577 010 octets** du préfixe synthétique sont stockés par `captureInput`, puis récupérés uniquement après `acquireInput` et sa revalidation habituelle. Le helper de parcours reconstruit son reçu à partir des octets retournés par cette classe. Après continuation contiguë, les **cinq paquets** concordent à nouveau avec le témoin complet : positions, timestamps, durées et empreintes identiques. Les quatre paquets du préfixe, dont la réplique future, ont traversé le stockage et la relecture.

Les assertions vérifient aussi les copies détachées à l'entrée et à la sortie, l'isolation du propriétaire et de la révision, la révocation d'un bail, le refus d'un échantillon ou d'une cible changés et l'expiration. La fin de l'essai libère toutes les entrées, tous les octets et toutes les réservations de cette instance isolée. Ce sont des contrôles d'intégration distincts des **27 tests précédents**, qui ne sont pas recomptés comme nouveaux tests.

Un cache d'entrée contenant un trou est volontairement admis comme cache de plages ordinaire : le lecteur peut encore demander les octets manquants. En revanche, le helper refuse d'en tirer une preuve de parcours des sous-titres (`noncontiguous-range`). Une entrée d'octets ne devient pas un succès HLS : `hasCandidate` reste faux. Le test n'ajoute aucun contournement à l'admission vidéo existante.

**Limite :** cela valide le stockage et ses gardes, pas l'interception des lectures du broker réel ni le démultiplexeur en cours de lecture. La couverture physique ne prouve toujours pas qu'un intervalle temporel futur est vide de sous-titres. Les pistes dispersées et les fichiers initialement ouverts après un saut restent hors du domaine prouvé.

### Nouveau raccord audio : conserver une grille d'échantillons

La suite explore un parent et une continuation partageant une politique explicite de timestamps natifs. L'audio du second encodeur est préparé avant la frontière, sur une grille AAC-LC 48 kHz ; le nombre de paquets antérieurs à écarter est calculé à partir de la fin du dernier paquet **déjà conservé**, au lieu de retirer systématiquement deux paquets. La frontière vidéo vient de la fin du dernier segment conservé. La suite du parent sert seulement à vérifier le résultat final ; elle ne fournit plus de paramètre au candidat.

Les erreurs intermédiaires sont conservées :

- Le premier essai conservait encore un déplacement de muxage de 1 920 ticks vidéo. Le contrôle explicite des horloges de transport le supprime dans ces fixtures. Les premières différences PCM calculées par simple position dans le tableau mélangent aussi le signal et le positionnement : elles ne valent pas comparaison à temps égal.
- Le nouveau lecteur de PCM indexe les échantillons par leur timestamp décodé. Sa première exécution s'arrête sur des timestamps dupliqués. Le diagnostic suivant les compte explicitement et exclut les positions ambiguës de la comparaison ; il ne les considère pas comme réussies. Les deux essais à 44,1 kHz présentent encore des chevauchements et des diagnostics de timestamps non monotones. Imposer seulement la base de temps du filtre ne suffit pas.
- La sélection par nombre de paquets, calculé sur la grille du parent, aligne ensuite les six débuts audio et vidéo. Le signal reste cependant fortement décalé pour les sources à 44,1 kHz. Une recherche de corrélation sur un bruit rose déterministe retrouve environ 707 ms d'écart dans le premier de ces essais.
- La cause de ce dernier défaut **du prototype** est l'unité de `first_pts` : le calcul utilisait des échantillons à 48 kHz alors que le rééchantillonneur les interprète à la fréquence d'entrée. L'ancre est désormais convertie avec cette fréquence avant de construire la grille de sortie. La lecture du code FFmpeg 5.1.9 et le rejeu confirment la correction. Aucun défaut équivalent du réglage de production `first_pts=0` n'est déduit de cette expérience. [Rééchantillonneur FFmpeg](https://ffmpeg.org/ffmpeg-resampler.html), [implémentation 5.1.9](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n5.1.9/libswresample/swresample.c).

### Derniers résultats, avec la seule fin conservée comme ancre

Chaque source synthétique de 32 s est essayée à deux frontières. Les sorties sont toujours H.264 et **AAC-LC stéréo 48 kHz**. Les tests n'incluent pas HE-AAC, AC3, DTS, multicanal ou changement de piste.

| Source | Frontière vidéo | Écart du premier PTS audio / vidéo face au témoin | Décalage de signal estimé dans le diagnostic |
| --- | --- | --- | --- |
| AAC 48 kHz, vidéo 24 i/s | 16 s | 0 / 0 tick | 0 ms |
| AAC 48 kHz, vidéo 24 i/s | 20 s | 0 / 0 tick | +0,167 ms |
| AAC 44,1 kHz, vidéo 25 i/s | 16 s | 0 / 0 tick | −0,229 ms |
| AAC 44,1 kHz, vidéo 25 i/s | 20 s | 0 / 0 tick | −0,167 ms |
| MP3 48 kHz, vidéo 29,97 i/s | 16,016 s | 0 / 0 tick | 0 ms |
| MP3 48 kHz, vidéo 29,97 i/s | 20,020 s | 0 / 0 tick | 0 ms |

Dans les six derniers essais, le premier paquet audio commence à la fin du dernier paquet conservé. Les deux fenêtres de comparaison, de −0,2 à +0,2 s puis de +0,3 à +1 s autour de cette frontière, ne présentent aucun timestamp manquant ou ambigu, sur les deux canaux. Les nombres d'échantillons décodés correspondent au témoin ; aucun diagnostic d'encodage ou de décodage n'est relevé dans **cette dernière matrice**. Les erreurs des variantes précédentes restent conservées.

Le décalage de signal est une estimation par corrélation du canal gauche sur **200 ms** de bruit rose après le raccord ; ce n'est pas une correction appliquée ni un seuil d'acceptation. Les deux encodages AAC ne produisent pas un PCM identique : l'erreur RMS à temps égal autour du raccord vaut environ 0,0034 à 0,0219, et certaines corrélations après raccord restent affectées par ces petits décalages. **Aucune acceptation à l'écoute ou garantie perceptuelle n'est revendiquée.** La cause précise des écarts résiduels n'est pas attribuée.

La politique d'horloge est commune au parent et au second producteur de cette expérience. Le produit ne doit pas réutiliser ses anciennes fenêtres sous une autre politique sans liaison explicite du profil et de l'horloge. L'expérience n'ajoute aucune admission de cache HLS et ne valide pas encore l'assemblage simultané vidéo/audio/sous-titres dans le navigateur ou Android.

### Santé et limites opérationnelles

**Production inchangée par ce travail ; aucun déploiement, appel fournisseur ou gain supplémentaire sur Normal.** Les conteneurs de preuve sont supprimés, leurs médias étaient éphémères. Le pilote reste `owner-allowlist`. Les cinq contrôles documentaires de PR710 réussissent désormais.

Le contrôle du **8 octobre à 16:48 Paris** trouve les deux Gateways sains, avec la même image PR706. Leurs dates de démarrage ont toutefois changé : **14:25:21 UTC** pour les deux, puis 14:25:22 pour le dispatcher. Le contrôle read-only complémentaire situe le démarrage de l'hôte vers **14:24:57 UTC**. Les conteneurs ont leurs anciennes dates de création, `OOMKilled=false` et un compteur Docker de redémarrage à zéro ; leurs champs `FinishedAt` indiquent 13:28:30–31 UTC. Ces champs situent les événements mais ne constituent pas à eux seuls une mesure complète d'indisponibilité. **La raison de l'arrêt/redémarrage de l'hôte n'est pas établie** et n'est pas attribuée aux expériences isolées. Aucun redémarrage n'a été demandé pendant ce travail.

Reçus et scripts : `.codex-artifacts/subtitle-cache-integration-20261008/`. `cache-prefix-proof` porte sur la vraie classe de cache ; `audio-grid-retained-tail` est la dernière matrice ; `audio-grid-proof`, `audio-grid-clocked`, les diagnostics et variantes intermédiaires conservent les échecs. `summary.safe.json` sépare explicitement stockage, horloges, signal et admission de production.
