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


## Parcours synthétique jusqu'au navigateur — 8 octobre, 17:07–17:12 Paris

Le test réunit désormais les éléments précédemment vérifiés séparément : **cache d'octets réel → reconstruction de l'entrée → nouveau producteur HLS → cache vidéo réel avec sous-titres → hls.js 1.7.3 dans Chromium**. Il s'agit d'un harnais isolé utilisant les classes de l'image PR706, pas du parcours de session Norva en production. Aucun appel média fournisseur.

### Ce qui traverse réellement le cache

La fixture de 240 s contient une vidéo H.264 à 24 i/s, un bruit rose AAC d'entrée à **44,1 kHz** et deux pistes UTF-8. Le cache conserve **4 570 316 octets** contigus, récupérés par `acquireInput` après les quatre échantillons de revalidation. Le helper reconstruit les quatre paquets de sous-titres du préfixe, puis suit le suffixe exact jusqu'à la fin connue de la fixture : les cinq paquets finaux concordent avec le témoin `ffprobe` sur positions, timestamps, durées et empreintes. L'entrée du second FFmpeg est réellement reconstruite avec les octets relus du cache ; son hash complet concorde.

Le cache HLS retient ensuite **64–96 s** avec les deux pistes de sous-titres. Sa capture et son acquisition ordinaires réussissent, sans désactiver la garde de couverture. Le graphe destiné au navigateur utilise `lease.playlist` et `lease.subtitlePlaylist`, les segments `resume-*` et VTT proviennent de `lease.asset`. Une seule discontinuité HLS sépare le cache et le second encodeur. Les ressources sont exportées en lecture seule pour ce test loopback ; le bail n'est donc pas un bail de session navigateur de production. Les instances de cache sont libérées à zéro entrée/octet/réservation.

**Limite déterminante :** les intervalles de sous-titres du harnais sont publiés seulement après avoir parcouru intégralement la source synthétique jusqu'à sa fin connue. Cette condition permet la comparaison exhaustive mais ne démontre pas une publication progressive rapide. Le helper de préfixe reste `timeCoverage:false` ; ni la dernière date de paquet ni un fichier VTT finalisé ne sont transformés en preuve de silence futur. Une intégration qui attendrait ce parcours entier pourrait annuler le gain recherché sur une VOD longue.

### Rejeu navigateur et sauts

Le saut local à 30 s précède de 2 s la frontière cache/continuation. La lecture se poursuit jusqu'à **48,023 s**, soit environ 18 s d'observation, puis le harnais la met volontairement en pause.

- **433 callbacks vidéo**, écart maximal de **42 ms** entre timestamps d'images, compatible avec les 24 i/s de cette fixture ; compteur navigateur **471 images / zéro image abandonnée** à la fin de cette séquence.
- Un événement `waiting` accompagne le saut initial ; aucun autre `waiting` ou `stalled` pendant le franchissement et la suite observée. Aucun `mediaError` ni erreur hls.js. Il s'agit d'assets locaux préchargés, pas d'un benchmark de démarrage réseau.
- Horloge `initPTS` identique avant et après la discontinuité : **5 888 070 ticks / 90 kHz**. Le `SourceBuffer` audio utilise **`mp4a.40.2`**, concordant avec l'AAC-LC 48 kHz stéréo des segments.
- **356 observations de sous-titres**, au plus une réplique active. La réplique traversante reste affichée de part et d'autre du raccord et disparaît à **46 s**. Son début antérieur à la fenêtre est ramené à zéro par le navigateur ; aucun doublon ni raccourcissement de sa fin observé.
- Sauts successifs et changements de piste : la réplique future `Forced second` apparaît à **86–91 s**, la dernière réplique à **126–131 s**, puis le retour avant raccord retrouve `Forced` à **6–11 s**. Ces trois vérifications n'ajoutent aucune erreur HLS.

Les coordonnées sont locales à la fenêtre débutant à 64 s. La réplique future correspond aux 150–155 s de la fixture ; elle était déjà présente dans le préfixe physique conservé et manquait dans le contrôle FFmpeg avec seek. La nouvelle chaîne la conserve jusqu'à l'affichage. Capture : `.codex-artifacts/subtitle-playback-chain-20261008/browser-future.png`.

### Audio : horloges exactes, signal encore différent

À la frontière 96 s de ce nouveau test, les premiers PTS audio et vidéo correspondent au témoin. Le premier paquet audio commence exactement après le dernier paquet conservé. Les deux fenêtres PCM à temps égal ne contiennent aucun timestamp manquant ou ambigu. Aucun diagnostic d'encodage/décodage. Le diagnostic par corrélation retrouve cependant **−13 échantillons (−0,271 ms)** sur le canal gauche ; l'erreur RMS vaut **0,02075** autour du raccord et **0,03097** après. Le signal n'est pas identique au témoin ; ce résultat ne prouve ni un défaut audible ni une équivalence perceptuelle.

Pour vérifier que la précédente duplication mono ne masquait pas un problème entre canaux, quatre raccords supplémentaires utilisent deux bruits roses indépendants, à deux frontières pour chaque fréquence d'entrée. La sortie reste AAC-LC stéréo 48 kHz.

| Source stéréo | Frontière | Écarts PTS audio / vidéo | Décalage estimé, canal gauche |
| --- | --- | --- | --- |
| AAC 48 kHz / 24 i/s | 16 s | 0 / 0 tick | 0 ms |
| AAC 48 kHz / 24 i/s | 20 s | 0 / 0 tick | +0,167 ms |
| AAC 44,1 kHz / 25 i/s | 16 s | 0 / 0 tick | −0,229 ms |
| AAC 44,1 kHz / 25 i/s | 20 s | 0 / 0 tick | −0,167 ms |

Les quatre raccords n'ont ni timestamp manquant/ambigu dans les fenêtres contrôlées, ni erreur de décodage. Sur les **600 ms** autour de chaque frontière, aucun échantillon saturé et aucune série d'échantillons proches de zéro (seuil diagnostic `1e-7`) ; les deux canaux restent distincts. Cela ne certifie pas la qualité sonore. La différence de variation de niveau avant/après, face au témoin, atteint **−0,620 dB** sur un canal du cas 48 kHz/20 s ; les différences de forme d'onde et de phase restent consignées. Aucun seuil perceptuel n'est inventé pour les déclarer acceptables. Le navigateur était muet ; aucune validation à l'écoute n'est revendiquée.

### État et prochaine condition d'intégration

**Aucun déploiement et aucun nouveau gain sur Normal.** Le premier parcours synthétique assemblé est fonctionnel, mais les gardes et le broker de session réels ne sont pas encore reliés au collecteur. Il faut établir une couverture progressive sûre des sous-titres sans lire tout le fichier à l'avance, puis valider le signal et le cycle de vie réel (révocation, interruption, changement de piste, reprise). La politique de timestamps doit rester liée au profil de cache : ces nouveaux résultats n'autorisent pas la réutilisation des anciennes fenêtres sous une autre horloge. Le format UTF-8 et le graphe à un audio sélectionné ne couvrent pas toutes les pistes/formats du catalogue. Aucun changement d'interface produit ni validation Android dans cette phase.

Les assertions des deux expériences et du récapitulatif passent ; les **27 tests du helper n'ont pas été recomptés**. Les cinq checks de PR711 passent désormais, paquets compris. Reçus reproductibles sous `.codex-artifacts/subtitle-playback-chain-20261008/` : `chain`, `stereo-grid`, les quatre lectures DOM et `summary.safe.json`.

Le contrôle read-only à **17:11:58 Paris** trouve les deux Gateways sains, l'image PR706 et leurs démarrages de 16:25:21 inchangés, le dispatcher actif et le pilote `owner-allowlist`. Le conteneur de preuve est absent, le serveur loopback est arrêté et l'onglet synthétique fermé. L'incident d'hôte signalé précédemment conserve sa cause inconnue ; ce contrôle de santé ne l'efface pas.


## Collecte progressive et origine du décalage audio — 8 octobre, 17:29–17:46 Paris

Cette phase reste un prototype isolé, sans appel fournisseur ni modification de production. Elle sépare la collecte des paquets de sous-titres, leur couverture temporelle et le signal audio. Les cinq contrôles de PR712 réussissent désormais, paquets compris.

### Collecter avant la fin du fichier

Le collecteur peut maintenant produire des instantanés immuables après chaque cluster complet sans fermer son entrée. Les observations suivantes restent possibles ; les reprises effectives conservent leur chaîne de révocation. Les deltas ne répètent pas les paquets hérités. Un trou d'octets, un rejeu, un changement de liaison ou le dépassement du budget invalide la preuve, y compris les instantanés déjà remis. La borne historique de 64 reprises ne devient plus une limite artificielle de 64 observations pendant une même lecture.

**39 tests passent : 27 antérieurs rejoués et 12 nouveaux.** Ils vérifient notamment 160 observations successives, le cluster incomplet, la reprise sans répétition, la révocation, le budget et le rejet d'une preuve JSON forgée.

Une fixture de 240 s, H.264/AAC 48 kHz et deux pistes UTF-8, est ensuite envoyée par morceaux de 32 Kio vers un vrai FFmpeg en stdin. Seule la taille est lue avant le flux, sans précharger le fichier entier. Le collecteur observe les mêmes octets au passage ; FFmpeg les démultiplexe en copie de flux vers une sortie nulle. Ce test n'est ni un nouveau contrôle de décodage vidéo ni le broker de session de production.

- **10 988 142 octets / 336 morceaux** parcourus ; les cinq paquets concordent avec un `ffprobe` indépendant sur position, timestamp, durée et empreinte.
- Premier sous-titre disponible après **196 608 octets**, soit **1,79 %** du fichier.
- Réplique future à **150,021 s** disponible après **3 211 264 octets**, soit **29,22 %** du fichier. Sa collecte n'attend donc plus la fin de cette fixture.
- Maximum du tampon du parseur : **217 947 octets** ; texte des cinq paquets conservés : 38 octets. Ces chiffres n'incluent pas toute la mémoire Node ni les instantanés que conserverait l'appelant.
- Aucune erreur FFmpeg dans l'essai final ; la révocation rend ensuite le reçu inutilisable.

Le premier harnais décodait vers une sortie nulle avec la politique de temps par défaut. Il a dépassé sa limite de stderr puis échoué sur une assertion dans le callback ; le détail initial du diagnostic n'a pas été conservé. Le harnais corrigé conserve un stderr borné et utilise la copie de flux pour isoler le démultiplexage. L'origine précise de ce premier stderr reste inconnue ; aucune réparation de décodeur de production n'en est déduite.

**Collecte progressive ne signifie pas couverture temporelle complète.** Un test conserve le même préfixe puis ajoute un paquet physique ultérieur dont la date est antérieure. Le collecteur reste `timeCoverage:false`. L'index Matroska référence certains clusters ; l'indexation de chaque sous-titre est recommandée, sans garantie d'exhaustivité. Ni `Cues`, ni la dernière date vidéo, ni `ENDLIST` ne suffisent ici pour ouvrir l'admission HLS. [Index Matroska](https://www.matroska.org/technical/cues.html), [ordre des éléments](https://www.matroska.org/technical/ordering.html).

### Le décalage peut précéder l'encodeur AAC

La comparaison emploie d'abord deux fichiers contenant **exactement les mêmes paquets audio PCM sans compression**, vérifiés par taille et SHA-256. Seul le conteneur diffère : NUT à horloge précise et Matroska à timestamps arrondis. Deux fréquences, 48 et 44,1 kHz, et deux frontières, 16 et 20 s, donnent huit comparaisons. Aucun encodeur audio avec perte n'intervient dans cette première expérience.

La précédente politique reproduit pourtant le décalage avec Matroska. Une ancre commune aux grilles d'entrée et de sortie corrige le cas NUT 44,1 kHz/20 s, mais ne suffit pas pour Matroska. L'essai suivant conserve un curseur d'échantillons d'entrée lié à une position déjà décodée avant la frontière. Une correction constante de l'origine du premier paquet élimine alors les différences à 48 kHz ; le redémarrage du rééchantillonneur garde une différence de phase à 44,1 kHz.

Le dernier candidat combine :

1. Une correspondance unique avec une trame antérieure conservée, par position et nombre d'échantillons ; la fixture garantit l'identité du fichier.
2. Une correction constante des timestamps d'entrée ; aucun décalage estimé par corrélation n'est appliqué.
3. Un début de préparation sur une phase commune : **147 échantillons à 44,1 kHz correspondent à 160 à 48 kHz**. La grille de sortie commune aux paquets AAC de 1 024 échantillons vaut ici 5 120 échantillons. Les 108–135 échantillons d'entrée écartés dans ces fixtures sont plusieurs secondes avant la frontière de lecture.

Les huit comparaisons PCM deviennent **strictement identiques** sur les deux canaux, dans la fenêtre **+0,3 à +1 s** après chaque frontière : erreur RMS et décalage nuls, aucun timestamp manquant. Cela ne certifie pas le film entier. Le curseur cumulé suppose ici une source continue, à fréquence constante et origine connue. Sa reconstruction sur un fichier à trous, avec origine non nulle, changement de fréquence ou règles de priming différentes reste à sécuriser ; ce n'est pas encore une politique générale de production.

### Contrôle AAC et nouveau raccord HLS

Avec des sources AAC, six comparaisons sur huit deviennent identiques avant l'encodeur de sortie. Les deux autres gardent une erreur RMS de **0,002929**, sans décalage mesuré. Le premier bloc décodé après saut diffère aussi du bloc historique : sa somme de contrôle PCM ne peut pas servir de preuve d'identité. La correspondance de cette expérience utilise le fichier fixe, la position physique et le nombre d'échantillons, puis plusieurs secondes de préparation avant le raccord.

Un contrôle désactive uniquement la substitution perceptuelle de bruit (PNS) lors de la fabrication des sources synthétiques : **huit comparaisons sur huit deviennent identiques**. Le code du décodeur emploie un état pseudo-aléatoire pour ces bandes. Ce résultat désigne la PNS comme contributeur plausible aux différences de signal de ces fixtures ; il n'attribue pas tous les écarts précédents à ce mécanisme et ne prouve aucune nuisance audible. L'option de production n'est pas modifiée. [Décodeur FFmpeg 5.1.9](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n5.1.9/libavcodec/aacdec_template.c), [option AAC PNS](https://ffmpeg.org/ffmpeg-codecs.html#aac_pns).

La nouvelle préparation est enfin appliquée à **quatre vrais raccords de segments HLS synthétiques**, AAC-LC stéréo 48 kHz en sortie, avec les mêmes sources stéréo et frontières que la matrice de PR712. PNS conserve ses valeurs par défaut dans cette matrice.

| Source / frontière | Ancien décalage de signal estimé | Nouveau décalage estimé | Nouvelle erreur RMS autour du raccord |
| --- | --- | --- | --- |
| AAC 48 kHz / 16 s | 0 ms | 0 ms | 0,00326 |
| AAC 48 kHz / 20 s | +0,167 ms | 0 ms | 0,00655 |
| AAC 44,1 kHz / 16 s | −0,229 ms | 0 ms | 0,01033 |
| AAC 44,1 kHz / 20 s | −0,167 ms | 0 ms | 0,01092 |

Les quatre horloges audio et vidéo concordent avec le témoin. Aucun trou ou doublon de timestamp dans les fenêtres PCM contrôlées ; aucun diagnostic d'encodage/décodage, saturation ou série de valeurs proches de zéro dans les 600 ms autour du raccord. La corrélation reste un diagnostic du canal gauche sur 200 ms. Après réencodage, le signal n'est toujours pas identique au témoin : l'erreur RMS après raccord vaut 0,00622–0,01538, et les variations de niveau restent documentées. **Aucune équivalence perceptuelle ni acceptation à l'écoute n'est revendiquée.** Aucun nouveau test navigateur ou Android dans cette phase.

### Ce qui reste avant une admission réelle

Il faut relier le collecteur aux gardes et au cycle de vie du broker réel, établir les périodes de sous-titres couvertes sans déclarer de silence à partir d'un préfixe incomplet, puis valider le curseur audio et le raccord sur des sources moins régulières. Les protections actuelles restent en place. **Aucun gain supplémentaire sur Normal et aucun déploiement.**

Reçus, scripts et résultats intermédiaires : `.codex-artifacts/subtitle-progressive-ledger-20261008/`. `summary.safe.json` vérifie les comptes et sépare collecte, couverture, horloges, signal et admission. Les six premières matrices audio servent au diagnostic ; elles ne sont pas additionnées aux 39 tests unitaires.

Le contrôle read-only du **8 octobre à 17:42:15 Paris** trouve les deux Gateways sains, même image PR706 et mêmes démarrages de 16:25:21. Dispatcher actif, pilote `owner-allowlist`, conteneur de preuve supprimé. Les médias synthétiques étaient éphémères. L'incident historique de redémarrage de l'hôte reste de cause inconnue.


## Broker réel, cache d’entrée et historique audio — 8 octobre, 17:59–18:31 Paris

Cette phase relie le collecteur au **code inchangé du broker de l’image PR706**, à la vraie classe `PrivateResumeHlsCache` et à FFmpeg, dans un conteneur isolé `network none`. Le harnais du dépôt extrait le broker dans une VM ; un serveur HTTP loopback joue le fournisseur à partir d’une fixture synthétique. Ce n’est pas encore une session Edge/API authentifiée, un claim fournisseur réel ni une admission HLS de production. Aucun appel externe, changement d’image, d’encodeur de production ou de garde. Les cinq contrôles de PR713 passent désormais, paquets compris.

### Les sous-titres suivent les octets validés du broker

L’adaptateur expérimental écoute le callback existant `onFiniteWindow`. Celui-ci reçoit la plage complète après validation et fermeture de la réponse amont. L’adaptateur vérifie liaison, taille, cible, validateur, limites et égalité des octets avant de réunir des plages. Il conserve les plages futures en attente d’un préfixe contigu, avec un budget borné. Il ne transforme jamais une absence d’octets en silence de sous-titres.

Le premier essai découvre un chevauchement entre les 64 Kio déjà lus à la fin du fichier pour les métadonnées et la dernière plage de lecture. Le collecteur le refusait, tandis que FFmpeg terminait sans erreur. Le prototype compare maintenant **tous les octets de l’intersection encore conservée** avant fusion. Une divergence ou un chevauchement avec des octets déjà jetés refuse toujours la preuve. Ce correctif concerne le nouveau collecteur isolé, pas un défaut de lecture de production.

**20 tests unitaires** vérifient contiguïté, trous, chevauchements, rejeux, divergence, budgets, changements de source/validateur, révocation et proposition bornée de lecture complémentaire. Ils sont distincts des 39 tests de PR713, qui ne sont pas rejoués ou ajoutés au total de cette phase.

La fixture de 240 s contient cinq paquets sur deux pistes UTF-8. Le parcours réel réalise :

1. Lecture d’un préfixe de 4 Mio et de 64 Kio de fin de fichier, puis capture par la classe de cache.
2. Fermeture de l’ancien broker et révocation de son reçu.
3. **Quatre échantillons frais** sur un nouveau broker, puis acquisition ordinaire du cache.
4. Réinjection de **4 259 840 octets**, reconstitution du collecteur et lecture FFmpeg.
5. Comparaison des cinq paquets avec un `ffprobe` indépendant : position, date, durée et empreinte identiques.

Le cas sans saut emploie 17 requêtes HTTP **locales**, dont le contrôle négatif de plage. Le reparsing du cache prend 36,27 ms dans ce seul environnement ; ce n’est pas un délai utilisateur ni une promesse de performance. Le collecteur stocke 38 octets de texte ; le maximum de son tampon de parseur atteint 250 715 octets. Les autres buffers du broker, du serveur de fixture, de FFmpeg et du cache sont exclus de ce chiffre.

### Un vrai saut révèle un trou physique de 200 522 octets

Avec un saut FFmpeg à 100 s, la nouvelle plage commence à l’octet 4 394 826, après un préfixe conservé de 4 194 304 octets. La vidéo est traitée sans erreur, mais le collecteur ne peut franchir les **200 522 octets manquants** : quatre paquets sont conservés, le cinquième n’est pas certifié.

Un second essai autorise **une seule lecture complémentaire**, plafonnée à 256 Kio dans le prototype, par le même broker et la même file sérialisée. Elle récupère exactement ce trou, sans modifier les gardes de taille/cible/plage. Les cinq paquets concordent alors avec le témoin. Le total passe à 18 requêtes locales, avec au maximum **une réponse fournisseur active** ; chaque callback de plage survient après son drainage. Aucun remplissage général de trous ni ce plafond expérimental n’est activé en production. L’effet d’une requête supplémentaire sur une source lente et sa politique de délai restent à valider.

Le premier harnais de ce test avait traité le retour vide de `lease.assertValid()` comme un booléen faux. L’assertion est corrigée pour utiliser le contrat réel : succès sans valeur, exception si invalide. Aucun changement du cache réel.

Le contrôle `Content-Range` incohérent termine en `RANGE_UNSUPPORTED` avec **zéro callback de collecte**. Un autre test interrompt une réponse après 16 Kio sur 1 Mio attendu : zéro callback complet, requête interrompue, bail de cache `RESUME_CACHE_REVOKED`, reçu invalidé et zéro connexion restante. Le cache est vide après nettoyage. Cela valide ce cycle de vie isolé ; les gardes d’authentification, de takeover et les interruptions de session Edge restent à intégrer.

### Raccord audio sur le même parcours de cache

Le test combiné produit un raccord HLS à 100 s après réutilisation du cache d’entrée. L’historique des trames audio vient maintenant des observations de **l’encodeur de la première lecture**, sans second décodage complet du fichier. Une courte lecture du point de reprise, via le broker réel, retrouve la position et le nombre d’échantillons d’une trame déjà observée. L’identité du fichier reste vérifiée séparément par le cache ; ni cette position ni une somme de contrôle PCM ne suffisent seules.

Les horloges audio/vidéo concordent avec le témoin, sans timestamp manquant, doublon ni diagnostic de décodage. Sur cette sinusoïde mono 48 kHz convertie en stéréo, la différence PCM est nulle sur 400 ms autour du raccord et vaut environ **2,25e-9 RMS** sur la fenêtre +0,3 à +1 s. Ce cas simple ne prouve aucune équivalence perceptuelle générale. La préparation audio lit naturellement le petit trou précédent ; aucune requête spécifique de comblement n’est nécessaire dans cet essai. Total : 17 requêtes locales, dont une pour l’ancre audio et une pour le contrôle négatif.

Une première version du harnais avait masqué la variable du collecteur initial par celle d’une trame audio ; erreur de portée corrigée dans le harnais uniquement. La preuve intermédiaire qui construisait l’historique par décodage séparé est conservée, distincte de la preuve finale sans ce décodage.

### Historique borné et huit raccords audio plus variés

Le nouveau helper expérimental conserve au maximum **2 048 descriptions de trames**, tout en continuant le compteur d’échantillons. Il conserve l’origine temporelle réelle, accepte seulement l’arrondi compatible avec l’échelle temporelle de la fixture et refuse les ruptures, changements de fréquence/canaux/format, positions ambiguës et liaisons divergentes. Une révocation invalide les ancres précédentes. Il n’authentifie pas la source et n’est pas encore persisté dans les entrées de cache de production.

**20 autres tests unitaires passent** : origine non nulle, arrondis 44,1/48 kHz, éviction des anciennes trames, trous/chevauchements audio, changements de profil et d’identité, bornes et reçus forgés. Les deux nouvelles suites totalisent **40 tests unitaires distincts** ; les expériences FFmpeg suivantes ne sont pas ajoutées à ce nombre.

La matrice utilise l’historique issu du premier encodeur et le raccord HLS réel. La sortie reste AAC-LC stéréo 48 kHz. Elle étend les quatre cas de bruit rose de PR713 à des sons de fréquence variable avec silence et à une source décalée de cinq secondes. Les huit cas sont rejoués avec le nouveau helper ; ce ne sont pas huit nouveaux films réels.

| Fixture | Frontières de reprise | Écart horloge audio / vidéo | Décalage de signal estimé |
| --- | --- | --- | --- |
| Bruits roses stéréo indépendants, 48 kHz | 16 / 20 s | 0 / 0 tick | 0 ms |
| Bruits roses stéréo indépendants, 44,1 kHz | 16 / 20 s | 0 / 0 tick | 0 ms |
| Sons stéréo variables avec silence, 48 kHz | 16 / 20 s | 0 / 0 tick | 0 ms |
| Origine de fichier décalée de 5 s, 48 kHz | 21 / 25 s | 0 / 0 tick | 0 ms |

Aucun timestamp manquant ou doublon dans les fenêtres PCM contrôlées, aucune saturation ou erreur d’encodage/décodage. Pour l’origine non nulle, le seek du prototype utilise explicitement les timestamps absolus ; aucun réglage global de seek n’est modifié. Le décalage effectif observé de la première trame tient compte des timestamps du fichier AAC ; il n’est pas remplacé arbitrairement par cinq secondes pile.

Après réencodage, des différences de signal subsistent : RMS maximale **0,01655** après raccord sur le bruit rose décalé. La différence de variation de niveau avant/après, par rapport au témoin, atteint **0,14715 dB**. Zéro décalage par corrélation ne signifie ni identité du signal ni qualité à l’écoute certifiée. Le cas avec silence ne permet pas de généraliser l’absence de silences aux autres bandes temporelles. Aucun test de parole, 5.1, changement réel de fréquence, navigateur ou Android supplémentaire dans cette phase.

Deux contrôles négatifs injectent un trou audio de **200 ms**. L’historique mesure 9 600 échantillons d’écart, rejette les deux ancres et ne lance pas l’encodeur de raccord. La quantification tolérée dans ces fichiers à timestamps milliseconde vaut au plus 48 échantillons à 48 kHz ; cette borne dérive du format testé et ne modifie aucun seuil de lecture ou de buffer. Une source à discontinuité demande une reconstruction de l’état du rééchantillonneur avant toute optimisation.

### Limite qui maintient le prototype hors production

Les cinq paquets de la fixture concordent **à la fin de l’essai**. Cela ne constitue toujours pas une preuve de couverture temporelle complète avant EOF. L’index peut être sélectif ; un préfixe seul ne prouve pas l’absence de répliques dans les octets non lus. Les timestamps des blocs sont relatifs au cluster et signés : ni la date du dernier cluster observé ni celle de la dernière image ne sont une borne sûre à elles seules. [Structure des blocs, RFC 9559](https://datatracker.ietf.org/doc/html/rfc9559#section-10), [index Matroska](https://www.matroska.org/technical/cues.html).

L’admission HLS reste fermée. Il faut encore une preuve de couverture exploitable sans scan complet coûteux, l’intégration et la persistance de l’historique dans la session réelle, puis une validation perceptuelle sur des sources plus variées. **Aucun nouveau gain sur Normal, aucun déploiement et aucune généralisation du pilote.**

Reçus et scripts : `.codex-artifacts/subtitle-broker-integration-20261008/` et `.codex-artifacts/subtitle-audio-history-20261008/`. Les deux `summary.safe.json` vérifient les métriques, conservent les échecs intermédiaires et distinguent les expériences locales des appels externes. À **18:31:24 Paris**, contrôle read-only : les deux Gateways sont sains, même image PR706, mêmes démarrages de 16:25:21, pilote `owner-allowlist` et dispatcher actif. Conteneur de preuve absent ; médias synthétiques éphémères supprimés avec celui-ci. L’incident historique de redémarrage d’hôte reste de cause inconnue.

## Conservation brève du même décodeur — 8 octobre, contrôle final à 18:56 Paris

Les cinq contrôles de PR714 passent désormais, paquets compris. Le chemin qui reconstruit un raccord depuis le cache reste soumis à la preuve de couverture des sous-titres décrite plus haut. Cette phase explore une autre possibilité pour une **reprise très récente sur la même timeline** : conserver brièvement le processus FFmpeg et son état de démultiplexage, de décodage, de rééchantillonnage et d’encodage. Cela pourrait éviter leur reconstruction, notamment l’état AAC et les sous-titres déjà lus mais destinés à plus tard.

Il s’agit d’un **prototype isolé**, utilisant le broker inchangé de l’image PR706, la vraie classe de cache et une source HTTP synthétique locale. Le conteneur emploie `network none`, l’utilisateur 1000, une racine en lecture seule, 512 Mio de mémoire et un tmpfs éphémère de 128 Mio. Aucun média fournisseur, session utilisateur ou déploiement. Le prototype ne publie aucune nouvelle entrée HLS de production et n’assouplit pas la garde des sous-titres.

### Fermeture amont, contrôle du fichier, puis poursuite du même processus

La fixture de 240 s utilise une vidéo H264 128 × 128 à 24 images/s, deux bruits roses stéréo indépendants à 44,1 kHz encodés en AAC et cinq paquets de sous-titres sur deux pistes. La sortie HLS est H264/AAC stéréo 48 kHz avec des segments de quatre secondes. Le témoin exécute les mêmes paramètres depuis le fichier local, sans pause.

Le prototype ferme la réponse amont après les quatre premiers Mio et bloque la requête suivante. L’override **`Connection: close` du harnais** ferme également la connexion TCP source ; il ne modifie pas le transport de production. Le processus FFmpeg et son accès HTTP loopback au broker restent conservés. Après 500 ms de stabilisation, une observation de **1 500 ms** constate zéro nouvelle requête et zéro connexion source. FFmpeg peut encore traiter les octets déjà en mémoire : sa playlist progresse durant cette pause. Il n’est donc pas suspendu et son coût local doit être borné séparément.

Avant de libérer la requête suivante, le parcours ordinaire de cache relit **quatre échantillons frais**, vérifie taille, cible et empreintes, puis acquiert le cache. Il s’agit du contrôle échantillonné existant, pas d’une comparaison exhaustive du fichier distant. Le même processus reprend ensuite sa lecture séquentielle. Sur tout l’essai, le maximum est une réponse source et une connexion source actives ; les 17 requêtes sont toutes locales.

Résultats comparés au témoin continu :

- **60 segments TS strictement identiques**, par SHA-256 individuel.
- Les deux fichiers WebVTT sont identiques octet par octet : deux répliques forcées à 70,023–75,023 et 150,023–155,023 s ; trois autres à 2,023–14,023, 60,023–110,023 et 190,023–195,023 s.
- L’audio PCM décodé sur la sortie complète de 240 s possède la même empreinte SHA-256. Aucun diagnostic d’encodage/décodage sur ce cas positif.
- Le premier changement de playlist après libération arrive en **33 ms**. C’est une mesure locale après validation ; elle n’inclut ni le clic, ni la validation, ni l’affichage navigateur et ne constitue pas un gain sur Normal.

Conserver le même encodeur supprime ici les différences de signal introduites par sa reconstruction. Cette égalité concerne uniquement la fixture testée. Elle ne constitue ni une acceptation à l’écoute sur des œuvres réelles, ni une preuve de couverture temporelle complète avant EOF pour le chemin de raccord du cache. Aucun nouveau replay navigateur ou Android dans cette phase.

### Expiration, modification du fichier et révocation

**12 tests unitaires** du nouveau verrou expérimental passent : fermeture seulement après drainage, reprise liée au même périmètre, validation obligatoire, absence de réponse amont concurrente, annulation, expiration, révocation et refus de prolonger la durée en répétant la pause. Les 40 tests de PR714 ne sont pas rejoués ou additionnés à ce total.

Trois contrôles supplémentaires utilisent le vrai broker et un processus FFmpeg dans le conteneur isolé :

| Situation | Résultat |
| --- | --- |
| Conservation expirée, borne expérimentale de 800 ms | Reprise refusée ; aucun nouvel appel source |
| Taille et cible identiques, mais octets modifiés | Quatre échantillons relus ; cache refusé avec `sample-changed`, zéro échantillon concordant ; aucune poursuite avec les données anciennes |
| Révocation du propriétaire simulée | Cache vidé, requête en attente rejetée et reprise impossible |

Le **superviseur du harnais** ferme explicitement le broker et arrête FFmpeg dans ces trois cas. Les diagnostics d’entrée interrompue sont attendus et conservés. Après nettoyage : zéro réponse active, zéro attente du verrou, cache vide et aucune nouvelle requête pendant le contrôle final. Les 454–456 ms consignées incluent 450 ms d’attente volontaire d’observation ; ce ne sont pas des temps d’arrêt produit. Le test ne prouve pas encore la révocation d’une session Edge authentifiée, ni une libération/reprise de claim fournisseur réel.

Le premier essai positif avait intercepté le `fetch` global de la VM, alors que le broker utilise son `fetchImpl` et Undici. Des requêtes continuaient donc à passer : l’assertion du harnais a échoué. Le test corrigé injecte son verrou dans l’option réelle `fetchImpl`. La première erreur est conservée ; aucun défaut du broker de production n’en est déduit. L’assertion de playlist immobile a également été remplacée par le contrôle du réseau : la préparation locale à partir des octets déjà reçus est attendue.

### Coût et limites d’intégration

Le processus FFmpeg observé consomme **80 652–80 692 Kio de RSS**, soit environ 79 Mio, pour cette petite fixture. Il effectue encore 31 ticks CPU pendant l’observation. Ces chiffres excluent le broker, le cache et leurs buffers ; ce n’est pas une borne pour des vidéos 1080p ou 4K. La conservation de cinq secondes du test positif est une limite de prototype, pas un nouveau TTL de production.

Avant tout pilote réel, il faut intégrer :

1. La fermeture explicite du transport et la libération ordinaire du claim fournisseur, puis sa réacquisition avant validation et poursuite, en gardant la route épinglée et la mono-connexion.
2. La liaison propriétaire/session/génération/fichier/pistes et l’arrêt immédiat en cas de changement, révocation, nouvelle lecture ou expiration.
3. Les quotas de processus, budgets mémoire et stockage local ainsi que leur nettoyage. Les sorties peuvent encore croître à partir des données déjà reçues.
4. La pause **hors** d’une tentative fournisseur déjà chronométrée : le verrou du harnais est actuellement à l’intérieur du cycle d’appel du broker. Il ne faut ni le déployer tel quel ni prolonger les timeouts pour le masquer.
5. Le raccordement au lecteur réel et aux sous-titres progressivement disponibles, puis des mesures sur des VOD réelles.

Cette piste couvre la poursuite du **même processus et de sa timeline existante**. Elle ne couvre pas les sauts arbitraires hors des segments conservés, la perte du processus ou la reprise ancienne à partir du seul disque. Le chemin de cache durable conserve donc ses blocages de couverture et d’intégration déjà décrits.

Reçus et scripts : `.codex-artifacts/warm-decoder-resume-20261008/`, dont `summary.safe.json`. À **18:56:09 Paris**, les deux Gateways restent sains, même image PR706 et mêmes démarrages de 16:25:21 ; dispatcher actif, pilote `owner-allowlist`, conteneur de preuve supprimé. **Aucun déploiement, gain supplémentaire sur Normal ou extension du pilote.**
