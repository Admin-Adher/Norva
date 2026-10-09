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

## Barrière intégrée au broker, conservation de session encore désactivée — 8 octobre, 19:23 Paris

Les cinq contrôles de PR715 sont réussis. Cette étape ajoute la primitive de suspension au **code du broker**, avec `retained-input-barrier.js` et ses tests versionnés. L’option interne `retainedInputScope` n’est fournie par aucun appel de session en production. Aucun endpoint public, réglage de déploiement ou comportement utilisateur n’active cette conservation ; `stopSession` continue à fermer normalement le broker et FFmpeg.

### Une frontière sûre avant l’appel réseau

Le prototype précédent bloquait dans `fetchImpl`, alors que le chronomètre réseau avait déjà démarré. La nouvelle barrière attend **avant la file du verrou fournisseur et la création du délai réseau**. Après acquisition du verrou, elle relit son état : une pause arrivée pendant l’attente fait libérer le verrou et attendre de nouveau. La réponse déjà en cours se termine normalement ; la barrière compte cette opération jusqu’à sa libération.

La pause produit un jeton opaque à usage unique seulement après :

1. La fin des opérations fournisseur déjà entrées.
2. La destruction réussie du dispatcher privé, donc de son transport. Une erreur interdit le jeton ; la fermeture générale reste appelée.
3. Le délai ordinaire de libération déjà enregistré par le broker.

Un dispatcher partagé et la voie de reconnaissance stricte des langues sont refusés pour cette option. La reprise exige le même objet de périmètre, le vrai jeton, une validation asynchrone réussie et la reconstruction du transport par la même factory. La fermeture ou l’expiration interrompt également le signal transmis à la validation. Le jeton n’est jamais une preuve de claim SQL : ce claim et les faits du fichier/pistes/profil restent à vérifier par le futur propriétaire de session.

La rétention est bornée dès la demande de pause. L’expiration est contrôlée aussi lors des appels, même si le callback du timer a du retard ; un recul d’horloge refuse la reprise. Deux reprises concurrentes ne peuvent pas lancer deux validations. Aucun timeout fournisseur ou délai de libération n’est augmenté.

### Tests de concurrence et parcours FFmpeg

**21 nouveaux tests** couvrent la primitive : 14 tests du composant et sept cas HTTP du broker. La suite ciblée complète — broker, barrière, préemption, traitement des langues et fermeture des sessions Gateway — compte finalement **208 tests : 203 réussis, cinq ignorés, zéro échec**. Les cinq ignorés sont les cas natifs FFmpeg/GPU conditionnés par leurs options ; ils ne sont pas présentés comme validés par Windows. Ce groupe recoupe les relevés intermédiaires de 144 puis 202 réussites et ne s’y additionne pas.

La revue ajoute le nettoyage d’un dispatcher promis par une factory asynchrone refusée, pour éviter qu’il apparaisse après le rejet. Les six cas HTTP sont rejoués avec succès après ce durcissement et restent recoupés avec le groupe précédent. Les expériences FFmpeg suivantes sont également rejouées sur ce code final.

Une seconde course est traitée avant fusion : **fermer le broker conservé doit attendre aussi la fin du callback de revalidation fraîche**. Son signal était déjà interrompu, mais un simple abort ne prouvait pas la fermeture de l’autre broker. Le septième test HTTP retient ce nettoyage : la fermeture reste en attente avec un broker strict enregistré, puis s’achève seulement après drainage et désinscription. Ce contrat exige que le callback utilise et ferme son propre broker, sans attendre récursivement la fermeture du broker conservé. Les 208 tests et les deux expériences FFmpeg sont rejoués après ce correctif.

Les cas HTTP vérifient notamment une attente de **250 ms** en pause avec des délais réseau inchangés de **100 ms** : zéro nouvel appel, zéro timeout terminal, puis lecture exacte après reprise. Un autre test retient un corps HTTP actif : aucun jeton avant la fin du corps et la grâce ordinaire de 100 ms de cette fixture. Fermeture, expiration, validation refusée, mauvais périmètre et jeton forgé empêchent la poursuite.

Le code candidat du broker et le nouveau module sont ensuite chargés dans une VM au sein du conteneur Linux isolé, avec FFmpeg et le vrai cache. L’image de production fournit les dépendances inchangées ; il ne s’agit pas d’une nouvelle image déployée. Le parcours de PR715 est rejoué **sans override de `fetch` et sans ajout de `Connection: close` pour la lecture finie**. Le dispatcher Undici privé est réellement détruit, puis un nouveau est créé après les quatre contrôles frais.

Sur la fixture de 240 s :

- Zéro requête et zéro socket source pendant 1 500 ms d’observation de pause.
- Maximum une réponse et une connexion source actives sur le parcours ; 17 requêtes locales.
- 60 segments TS et les deux sorties WebVTT contenant cinq répliques identiques au témoin.
- PCM décodé complet identique, sans diagnostic de décodage dans le cas positif.
- Premier changement de playlist 30 ms après la validation lors du dernier replay, **toujours sans valeur de délai utilisateur ou gain sur Normal**.

Les trois contrôles FFmpeg négatifs sont aussi rejoués : expiration, source modifiée à taille/cible identiques et révocation. La barrière ferme le broker, aucun accès source de continuation n’est effectué, et le superviseur de preuve termine les processus restants et vide le cache. Le cas expiré montre un détail à conserver : **FFmpeg peut sortir avec le code zéro tout en signalant une entrée interrompue**. Ce n’est pas une lecture complète. Le futur gestionnaire doit déclarer le producteur interrompu avant nettoyage et ne jamais promouvoir ce résultat sur le seul code de sortie. Aucun fichier de cet essai n’entre dans le cache de production.

### Raccordement restant avant un pilote utilisateur

Le prochain niveau concerne la session authentifiée : révoquer l’ancien accès média, retirer son activité fournisseur seulement après drainage, conserver le processus sous un budget borné, puis acquérir le claim normal pour une nouvelle session avant ses contrôles frais. Les callbacks du processus et les réservations encodeur/disque doivent suivre cette propriété sans transformer une expiration en succès. Il faut aussi prouver les sous-titres progressifs dans le lecteur réel. **La primitive du broker ne réalise pas encore ce transfert.**

Le coût observé du seul processus reste d’environ 79 Mio sur la petite fixture, hors Node/cache. La portée reste une continuation sur la même timeline ; sauts arbitraires, reprise après perte du processus et preuve générale de couverture avant EOF ne sont pas résolus. Aucune acceptation sonore humaine ni nouvelle mesure sur Normal.

Reçus : `.codex-artifacts/retained-input-barrier-20261008/`. À **19:23:45 Paris**, les deux Gateways sont sains, image PR706 et démarrages inchangés, dispatcher actif, pilote `owner-allowlist`, conteneur de preuve absent. Aucun déploiement Gateway ni activation de conservation des sessions.

## Transfert de session raccordé, activation toujours désactivée — 8 octobre, soirée

Les cinq contrôles de PR716 sont désormais réussis, paquets inclus. Le code candidat raccorde la conservation au DELETE de la session primaire et au POST ordinaire de création, après authentification, admission, verrou propriétaire/fournisseur et nettoyage des détenteurs actifs. Le nouveau composant `retained-session-transfer.js` conserve au plus **un décodeur par Gateway**, pendant **dix secondes maximum à compter de la demande de pause**. Il garde les réservations existantes d’encodeur et de sortie ; il ne crée aucun nouveau claim SQL ni capacité de connexion.

L’activation exige séparément `PRIVATE_RETAINED_SESSION_ENABLED=true` et une liste explicite `PRIVATE_RETAINED_SESSION_OWNER_HASHES`, en plus de l’éligibilité aux deux politiques de cache existantes. Une liste vide ou invalide refuse tout propriétaire. Aucun fichier de déploiement n’est modifié et ces options ne sont pas activées sur les serveurs.

### Propriété et révocation

- La sortie explicite révoque immédiatement l’ancien jeton média, les attachements et les réponses HTTP déjà ouvertes. Le détenteur reste bloquant pour le fournisseur pendant le drainage ; seul l’état réellement garé libère cette activité.
- Une reprise doit retrouver les mêmes faits de requête : propriétaire, source/révision, identité, profil, pistes et réglages. Elle est limitée à la position de sortie, à 250 ms près, encore présente dans les segments préparés. Les sauts arbitraires, producteurs partagés, graphes multi-audio, entrées avec pompe/pont linéaire et brokers ayant changé de transport ne passent pas par cette voie.
- La nouvelle requête relit quatre échantillons par un broker distinct et sans cache. Taille, empreintes, identité et **adresse résolue complète hachée**, validateur et route doivent encore correspondre. Une adresse signée renouvelée est refusée même si les échantillons sont égaux : le décodeur conservé garde son ancienne cible de transport.
- Le changement d’identifiant et de jeton est synchrone, après validation et avant libération des lectures fournisseur. Le même objet de processus, les fichiers, l’origine de la timeline et les ressources suivent la nouvelle session. Les anciennes observations de débit ne sont pas réutilisées pour abaisser sa réserve de démarrage.
- L’expiration, l’annulation et la révocation attendent le drainage de la revalidation avant libération des ressources. Le marqueur d’interruption empêche une sortie FFmpeg de code zéro de devenir une preuve de fichier complet.

Deux courses sont couvertes : un DELETE ancien ayant attendu une opération asynchrone relit son identifiant avant toute action ; un callback d’expiration tardif est lié à la génération de pause et à son entrée, et ne peut fermer la session adoptée. Un DELETE dupliqué pendant le drainage attend sa fin. Une révocation de compte couvre aussi les décodeurs garés, même sans socket fournisseur.

### Vérifications et portée exacte

**22 nouveaux tests** de transfert et d’expiration, compris dans la suite finale de **235 tests : 230 réussis, cinq ignorés, zéro échec**. Les groupes intermédiaires se recoupent. Les cinq ignorés restent les tests natifs/GPU opt-in ; ils ne valent pas validation Windows. Le test du véritable handler DELETE a intercepté une première insertion dans la fermeture d’attachement au lieu de la fermeture primaire ; elle a été corrigée avant commit. Un sélecteur de test sensible au CRLF a aussi été normalisé. Les tests finaux couvrent la fermeture d’une vraie réponse HTTP, les anciens jetons, les refus de fichier/piste/route, la concurrence, le retour en arrière d’horloge, les anciennes expirations et le code de sortie zéro.

Le replay isolé utilise le code candidat des helpers de session, le vrai broker et FFmpeg dans un conteneur sans réseau externe, sans volume de production et sous UID 1000. Sur la fixture de 240 secondes : **60 segments TS, deux sorties WebVTT totalisant cinq répliques et le PCM décodé complet sont identiques au témoin continu**. L’ancien accès est révoqué, l’identifiant change et le même processus poursuit. Quatre prélèvements frais sont lus ; maximum une réponse et une socket source actives ; zéro requête et zéro socket source pendant les 1 500 ms d’observation de pause. La production locale peut encore avancer sur les octets déjà lus pendant cette pause. Le temps avant la nouvelle écriture de playlist figure dans le reçu et n’est pas un délai utilisateur.

**Cette preuve utilise des réservations et une autorisation de claim simulées autour des vrais helpers. Elle ne valide pas encore le parcours complet Edge → claim SQL → Gateway → lecteur réel, ni la restitution à l’écoute.** Avant activation, il reste à vérifier ce parcours, les sorties glissantes sous les vraies réservations et le repositionnement client avec sous-titres progressifs. La voie de cache durable garde ses exigences de couverture ; aucune preuve générale de couverture avant EOF n’est créée par ce transfert. Aucun gain supplémentaire sur Normal, aucune extension du pilote et aucun déploiement Gateway.

Reçus : `.codex-artifacts/retained-session-transfer-20261008/`, notamment `summary.safe.json`, `session-warm-proof.safe.json`, `tests-final.tap` et `runtime-check.safe.json`. La vérification finale de santé conserve l’image PR706, les démarrages antérieurs, le dispatcher actif et le périmètre `owner-allowlist` ; conteneur de preuve supprimé. Les incidents historiques, dont le redémarrage d’hôte de 16:25 Paris à cause non établie, restent ouverts dans l’historique.

## Serveur Gateway complet, claims synthétiques et navigateur — 8 octobre, 20:40 Paris

Les cinq contrôles de PR717 passent désormais, paquets inclus. Cette étape lance **tout le processus Gateway candidat**, ses vrais handlers HTTP, FFmpeg et ses réservations d’encodeur et de sortie. Elle remplace donc les réservations simulées du précédent essai. La conservation reste désactivée en production ; aucun déploiement, appel fournisseur externe ou mesure nouvelle sur Normal.

### Deux défauts d’intégration interceptés et corrigés

1. **Réservation d’encodeur restée liée à l’ancienne session.** Après adoption, la fermeture finale laissait une place active. L’identifiant change maintenant dans l’ensemble des admissions au même instant que dans la map des sessions, avant de libérer le broker. Une réservation déclarée mais absente refuse l’adoption. Le vrai handler de fermeture retrouve et libère la réservation.
2. **Socket de prélecture restée ouverte pendant la pause.** La réponse source était terminée et le broker correctement drainé, mais la connexion idle de la précédente lecture d’identité/en-tête appartenait au pool partagé. Pour cette voie de conservation seulement, cette prélecture finie utilise désormais un dispatcher privé, détruit dans le `finally`, y compris après refus amont. Un échec de destruction interdit le succès. Le broker de lecture conserve son propre transport privé et ses gardes ordinaires.

Les premiers échecs sont conservés dans les reçus. **Cinq nouveaux tests de régression**, compris dans la suite ciblée finale de **356 tests : 350 réussis, six ignorés, zéro échec**. Les ignorés restent les tests natifs/FFmpeg/GPU opt-in non exécutés dans cette suite Windows. Les groupes précédents ne s’ajoutent pas à ce total. La première fixture du nouveau test transport remplaçait un helper ensuite écrasé par son extraction ; la fixture a été corrigée pour injecter les dépendances réelles, sans autre changement produit.

### Portée de la preuve SQL et Edge

Le SQL réel `claim_cloud_playback_session` est exécuté par PGlite sur un schéma synthétique. L’assertion de visibilité/propriété de source est une implémentation de fixture. Les fonctions Edge réelles de fermeture et de préemption, transpillées depuis leur source, passent par un adaptateur DB vers ce SQL. La classe réelle du coordinateur utilise un stockage en mémoire ; sa classification des générations est simplifiée. **Ce n’est pas une preuve de contention distribuée, du catalogue authentifié ni du `createPlaybackSessionCore` complet de production.** Le POST Gateway de création est assemblé par le harnais.

La séquence vérifie : claim ordinaire → préparation du coordinateur → POST Gateway → enregistrement DB/coordinateur → fermeture Edge avec position → double DELETE du coordinateur → nouveau claim → quatre échantillons frais → adoption → fermeture finale. Les anciens accès sont refusés après la pause puis après le changement d’identifiant ; le PID du décodeur ne change pas. Un mauvais propriétaire est refusé à la fermeture et au claim synthétique. Les réservations d’encodeur et de sortie reviennent à zéro à la fin.

Le contrôle HTTP de 20:23:42 Paris relève sept requêtes source locales, maximum une réponse et une socket simultanées, zéro requête/socket durant les 300 ms d’observation de pause. Les 23 ms du handler de transfert, ou 54 ms autour du parcours du harnais, ne constituent pas un délai utilisateur.

### Reprise dans Chromium avec HLS.js 1.7.3

Deux essais utilisent un lecteur HTML de preuve, le HLS.js livré par Norva et les sorties du Gateway candidat. **Il ne s’agit pas de WatchPage, de son gate de démarrage ou d’un lecteur Android.** Le premier essai reprend en 1,227 s et poursuit environ 104 s ; le second sélectionne explicitement la piste forcée et reprend en **0,934 s**, depuis le clic incluant fermeture, claim et validation. Il poursuit jusqu’à la fin de la sortie : environ **172,69 secondes après la reprise**, 4 146 callbacks d’image, sans nouveau `waiting` après le chargement initial de cette reprise, sans erreur HLS ni intervalle de callback supérieur à 250 ms pendant cette phase.

Le second essai conserve deux intervalles de 545,6 et 654,5 ms pendant la **première lecture**, avant la fermeture. Leur cause n’est pas établie. Les diagnostics initiaux non fatals `aborted` et `bufferSeekOverHole` sont aussi conservés ; ils ne sont pas comptés comme des erreurs de reprise.

La source synthétique entière avait déjà été reçue avant la pause de ces essais navigateur. Les quatre nouvelles requêtes sont celles de revalidation, pas une continuation vers de nouveaux octets. **Cela ne prouve pas encore le passage du navigateur à une portion source non lue avant la pause.** La preuve antérieure du broker et du décodeur continu reste distincte. Les métriques ne sont pas un benchmark de Normal ou d’un réseau fournisseur.

Les métriques produites par la page confirment deux cues forcées chargées : `Forced` et `Forced second`. Leurs horaires dans le navigateur sont **38,623–43,623 s et 118,623–123,623 s**, contre **40,023–45,023 s et 120,023–125,023 s** dans les VTT servis. L’écart de **1,4 s** reste à expliquer et corriger avec l’origine temporelle vidéo ; il ne faut ni ajouter un offset constant sur cette seule fixture ni annoncer les sous-titres synchronisés. Une inspection DOM en lecture seule avait exposé des tableaux de cues vides, alors que la collecte native de la page en retrouve deux : aucune perte de sous-titre n’en est déduite. Les événements de fragments traités ne prouvent pas non plus une couverture exhaustive.

Le lecteur est muet pendant ces mesures : **aucune acceptation sonore humaine**. Les égalités PCM et WebVTT des expériences précédentes restent valides pour leurs fixtures, sans être attribuées à ce nouveau parcours. Il reste à traiter la synchronisation et l’affichage des sous-titres, le lecteur Norva complet, la continuation vers des octets non encore lus et les contrôles audio réels avant activation.

### Isolation et état de production

Le contrôle HTTP utilise `network none`. Le navigateur accède par tunnel SSH à un conteneur sur un réseau Docker **interne**, sans sortie vers un fournisseur. Source et proxy HTTP sont synthétiques et locaux. UID 1000, racine en lecture seule, mémoire 1 Gio, deux CPU, tmpfs éphémère de 384 Mio, aucun volume ni secret de production. Le premier tunnel ciblait un port non publié sur ce réseau interne et échouait ; le harnais a ensuite ciblé l’adresse du conteneur via SSH. Aucun réglage réseau de production n’a été modifié.

Reçus et scripts : `.codex-artifacts/retained-session-full-path-20261008/`, dont `summary.safe.json`, `http-proof.safe.json`, `browser-first.safe.json`, `browser-proof.safe.json`, `tests-final.tap` et `browser-result.png`. À **20:40:17 Paris**, les deux Gateways sont sains, image PR706 et démarrages de 16:25:21 inchangés, dispatcher actif, pilote `owner-allowlist`. Les options de conservation restent inactives. Le conteneur, son réseau isolé et le tunnel de preuve sont arrêtés/supprimés. **Aucun déploiement Gateway, gain supplémentaire sur Normal ou extension du pilote.**


## Horloge des sous-titres et fenêtre glissante — 8 octobre, 21:54 Paris

Le décalage de 1,4 seconde provient du muxer MPEG-TS imbriqué dans HLS, dont le délai par défaut ne s'applique pas à la sortie WebVTT. Le simple réglage du muxer extérieur à zéro laisse encore le décalage des DTS négatifs avec B-frames. Le candidat conserve la même horloge PES pour vidéo et sous-titres en réglant les deux muxers (`mpegts_copyts=1`, `avoid_negative_ts=disabled`, délais nuls), uniquement pour le producteur exact éligible à la conservation. Ce n'est pas l'ajout d'une constante aux répliques.

Les horloges sont comparées avec B-frames et AAC 44,1 kHz, au départ et à 2,375 secondes. Le premier essai de fixture avait omis `fps_mode=passthrough` avec une horloge 90 kHz et dépassé son temps : il est conservé, puis la fixture corrigée. Le cache privé porte une clé de profil distincte `source-pes-v1`; son découpage WebVTT garde les timestamps source sans ajouter l'amorçage audio. Le cache complet historique n'accepte pas ce producteur. Les autres producteurs gardent leurs arguments et leurs clés. La nouvelle horloge reste conditionnée à l'option de conservation **désactivée en production**.

### WatchPage et repositionnement

Le harnais utilise maintenant le DOM, le CSS, **WatchPage.loadVideo/stop, HLS.js 1.7.3 et le gate réels**. Les premiers harnais omettaient l'initialisation de la télémétrie de première image : la couverture de chargement restait affichée. Cela a été corrigé dans le harnais; aucun changement de WatchPage n'en découle. Une première image produite pendant que le gate garde la vidéo en pause n'est pas comptée comme le démarrage effectif.

Un défaut supplémentaire apparaît lors de la longue fixture : la playlist vidéo a glissé de 76 secondes, mais la réponse de reprise utilisait encore l'origine de la première session. Le navigateur reprenait donc trop loin. Le candidat relit maintenant l'origine durable après revalidation, refuse une position sortie de la fenêtre, conserve l'horloge du décodeur et expose une origine propre au nouveau lecteur. La première playlist est figée jusqu'à livraison d'un de ses segments vidéo; HEAD, les relectures de manifeste et les réponses interrompues ne consomment pas ce repère. Ce dernier durcissement est couvert par les tests de transfert et le replay HTTP complet après le replay navigateur.

Replay final **21:54:05 Paris**, sur une source synthétique de 720 secondes, 67 429 636 octets :

- Fermeture à la position source **144,333576 s**. Origine initiale 30 s; nouvelle origine de playlist 40 s; origine exposée au nouveau lecteur 70 s; cible locale **74,333576 s**. L'origine vidéo HLS passe de 0,023 à 40,023 s, ce qui concorde.
- Première image en **1,098 s**, puis lecture effective en **3,331 s**, réserve normale comprise. PID conservé, ancien accès révoqué.
- La lecture avance de **201,999424 s** après la cible de reprise. Trois nouvelles plages de 8 Mio sont réellement reçues après les quatre échantillons de revalidation : cette fois, la preuve dépasse les octets disponibles avant pause.
- Zéro requête/socket source pendant la pause observée, maximum une requête et une socket simultanées, treize requêtes synthétiques sur le parcours, ressources d'encodeur et de sortie libérées à la fin.

**La fluidité complète n'est pas validée.** Des intervalles de callbacks d'image persistent, dont 1,582 s après le démarrage, et un `bufferStalledError` non fatal. Le tableau `waiting` est vide; cela ne suffit pas à nier le diagnostic HLS ou les intervalles. Les abandons réseau non fatals sont conservés. Leur cause précise reste à départager entre alimentation du lecteur et ordonnancement du navigateur.

### Sous-titres progressifs : un blocage précis demeure

Le premier replay court, source entièrement reçue, remet les deux répliques forcées à **40–45 et 120–125 secondes dans le navigateur**, sans l'ancien décalage de 1,4 seconde. Il ne prouve pas leur disponibilité progressive sur un long fichier.

Sur la fixture de 720 secondes, la première réplique est publiée dans le premier VTT; la seconde est dans le segment suivant, encore ouvert. Ce fichier reste vide tant que FFmpeg ne vide pas son buffer. Une expérience séparée avec `flush_packets=1` rend la seconde réplique visible dans le fichier, **mais la playlist n'annonce toujours que le premier segment fermé**. Le navigateur ne reçoit donc pas cette réplique à temps. Le flush expérimental n'est pas inclus dans le produit. Aucun ENDLIST artificiel, plage vide prétendument complète ou relâchement des gardes de couverture n'est ajouté. Le dernier replay du candidat utilise ses sources réelles sans cette injection.

La collecte finale des cues natifs vides après passage de la réplique ne prouve pas à elle seule une perte; les fichiers et la playlist persistés établissent le défaut de publication du segment suivant. Il reste à raccorder un mécanisme de publication progressive qui préserve les répliques tardives et traversantes avant toute activation.

### Audio, tests et limites

Un extrait de douze secondes autour de la position de reprise (segments 27–29) contient **288 images H264 et 563 paquets AAC-LC stéréo 48 kHz**. Décodage sans erreur, pas vidéo de 41–42 ms et pas audio de 21,333–21,334 ms. Le même décodeur est conservé : aucun nouvel encodeur n'est lancé au transfert. Ces contrôles ne sont pas une acceptation à l'écoute; le navigateur de mesure était muet. Les anciennes égalités PCM restent propres à leurs fixtures.

Suite élargie : **275 tests, 272 réussis, trois ignorés, zéro échec**. Les trois ignorés sont conditionnés à leur environnement natif. Après durcissement du premier manifeste : **28 tests de transfert/horloge réussis**, inclus dans la portée précédente et non additionnés. Le replay HTTP du Gateway final à **21:56:21 Paris** conserve les claims synthétiques, l'ancien accès révoqué, le PID, une connexion maximum et la libération finale. Le premier groupe de tests avait rencontré un helper absent d'une VM d'extraction; seuls les harnais ont été complétés avant réussite.

Les claims SQL, la fermeture Edge et le coordinateur ont la portée synthétique décrite dans PR718. La création authentifiée complète de production, la contention distribuée, la restitution audible et les sources variées restent à valider. **Aucun déploiement Gateway, activation du décodeur conservé, nouvelle mesure sur Normal ou extension du pilote.** Reçus sous `.codex-artifacts/retained-watch-sliding-clock-20261008/` et les trois dossiers de replays intermédiaires référencés dans le JSON.

À **22:00:50 Paris**, les deux Gateways sont sains, image PR706 et démarrages du relevé précédent inchangés, dispatcher actif, conservation désactivée. Les cinq conteneurs de preuve sont absents; le tunnel isolé est arrêté.

Le contrôle Linux complet intercepte cinq échecs dans les cinq variantes du harnais de concurrence FFmpeg : il extrayait `startFfmpeg` sans importer le nouveau helper d’horloge. Les 6 142 tests de ce premier passage comportent 6 106 réussites, cinq échecs et 31 ignorés. Le harnais importe désormais le véritable helper; aucun seuil produit n’est modifié. Le groupe local de concurrence, transfert et horloge réussit ensuite. La revue finale protège aussi le premier manifeste contre un acquittement tardif provenant de l’ancien identifiant de session; le test prouve qu’il ne libère pas l’origine du nouveau lecteur.


## Publication progressive de paquets confirmés — 8 octobre, 22:33 Paris

Le contrôle final de PR720 a réussi : **6 142 tests, 6 111 réussis, 31 ignorés, zéro échec**. PR720 est intégrée par `9ef6323ee781b5d34849ec7d61994ae7e6ebe67c`; ses paquets Windows, téléphone et TV sont également réussis au contrôle de ce passage. Cela ne change pas les limites de la preuve précédente.

### Publication avant la fin du fichier

Un nouveau helper pur, `committed-subtitle-snapshot.js`, rapproche chaque réplique WebVTT de son journal FFmpeg `framecrc` : horodatage, durée, nombre d’octets UTF-8 et somme de contrôle. Les deux sorties viennent du même encodeur de sous-titres, par le muxer `tee`; la sortie VTT est vidée avant la sortie du journal. Il n’y a ni second accès fournisseur ni second décodage vidéo. Le journal confirme des **paquets observés**, pas l’absence d’autres paquets : `timeCoverage:false` et `complete:false` restent explicites. Aucun faux ENDLIST, certificat de silence ou assouplissement de l’admission HLS privée.

La lecture du journal précède celle du VTT : un ajout concurrent peut fournir des données supplémentaires, mais seules les lignes de journal terminées et leurs répliques concordantes sont publiées. Une réponse tronquée, un texte modifié, un horodatage, une durée, une taille ou une somme incorrecte sont refusés. Limites du helper : deux Mio par entrée, vingt mille répliques; les formes de side-data non prises en charge sont refusées. La somme de contrôle détecte une divergence de paquets locaux; ce n’est pas une authentification de fichier ou de propriétaire.

FFmpeg réel, réseau absent : à **deux secondes de collecte**, la réplique prévue à 9–12 s est déjà disponible, alors que le producteur n’a pas terminé. Le texte multiligne et les timestamps concordent. À dix secondes, trois paquets sont présents. Les **18 tests nouveaux** comprennent toutes les coupures octet par octet du VTT et du dernier enregistrement, UTF-8, simultanéité, réplique traversante, identifiants et réglages. Groupe publication/transfert/horloge : **46 réussites**, dont ces 18, sans additionner les groupes.

### Parcours expérimental avec WatchPage

Le générateur de preuve injecte les sorties tee et un lecteur de snapshots derrière le middleware de jeton du Gateway de test. Il branche le moteur WebVTT existant de WatchPage sur l’horloge réellement annoncée par HLS. **Ce branchement appartient uniquement au harnais** : le helper n’est appelé par aucun parcours produit, le contrat Edge/catalogue ne change pas, aucun code de WatchPage n’est modifié. Le premier essai avait laissé le moteur HLS natif et le moteur géré actifs en même temps; ses deux pistes affichées et ses diagnostics non fatals sont conservés. Le second configure un seul propriétaire de sous-titres.

Contrôle final terminé à **22:32:58 Paris**, source synthétique de 720 s / 67 429 636 octets :

- Départ effectif **9,324 s**; après fermeture et claim ordinaire, première image **1,186 s**, lecture effective **3,528 s**. Position source de reprise 123,225504 s, cible locale 73,225504 s après glissement de vingt secondes.
- La réplique future initialement à 120–125 s se trouve désormais à **100–105 s**, disponible avant son échéance et observée active après reprise. Une seule piste affiche les deux répliques, sans doublon. Le collecteur serveur conserve aussi la réplique traversante de l’autre piste, mais son affichage et le changement de piste ne sont pas testés dans ce second replay.
- Lecture avancée de **135,524496 s** après reprise. Deux nouvelles plages de huit Mio, soit **16 Mio**, reçues après revalidation, sans parcourir le fichier entier.
- Zéro erreur HLS et zéro événement `waiting` dans ce replay. Aucun intervalle de callback supérieur à 250 ms après la première seconde de lecture reprise. Les écarts entre première image et mise en lecture appartiennent au gate, qui garde alors la vidéo en pause; ils ne sont pas comptés comme gels après démarrage.
- Même PID de décodeur, ancien accès révoqué, zéro requête/socket source durant la pause observée, maximum une connexion. Réservations de sortie et d’encodeur libérées à la fermeture finale.

La télémétrie conserve séparément la réserve vidéo, les callbacks d’image, les événements HLS et les tâches longues du navigateur. L’affichage diagnostique a été allégé. L’absence de saccade dans ce nouveau replay **n’établit pas la cause des intervalles de 1,582 s du précédent** : plusieurs aspects du harnais ont changé; aucun A/B à variable unique ne permet de les attribuer au DOM, au réseau ou à l’ordonnancement.

Un extrait de sortie de douze secondes contient **288 images H264 et 563 paquets AAC-LC, stéréo 48 kHz**, décodés sans erreur. Il est distinct d’une validation à l’écoute et ne couvre pas le film entier. Le navigateur de mesure reste muet.

### Limites et état final

Le raccordement public doit encore définir et tester la sélection d’un seul moteur, les changements de piste, les métadonnées Edge, les lectures bornées des fichiers de publication, les clients natifs et la révocation pendant une réponse en vol. Les gardes de création ont la portée synthétique de PR718, avec véritable SQL de claim mais assertion de visibilité de fixture. Les sources variées et l’acceptation audible restent ouvertes. **Cette preuve ne permet pas d’activer la conservation en production. Aucun gain supplémentaire sur Normal.**

Les replays et scripts sont conservés sous `.codex-artifacts/retained-progressive-publish-20261008/` et `retained-progressive-publish-final-20261008/`. Les sources embarquées du prototype sont explicitement modifiées par le générateur de test; elles ne sont pas présentées comme un Gateway produit inchangé. Aucun appel média fournisseur, déploiement ou changement de concurrence. À **22:33:12 Paris**, les deux Gateways sont sains, image PR706 et démarrages inchangés; pilote `owner-allowlist`, conservation inactive, dispatcher actif. Les conteneurs de preuve, le réseau interne, le tunnel et l’onglet temporaire sont arrêtés. Aucun nouvel envoi Google Play : TV39 reste au dernier état observé « en cours d’examen », sans nouvelle vérification pendant ces tests.


## Publication authentifiée et changement de piste — 9 octobre, 00:37 Paris (PR722)

Le branchement de laboratoire de PR721 est remplacé par du code produit, **toujours inactif en production**. Le Gateway produit les snapshots WebVTT et le journal dans la même réservation de sortie bornée. Le lecteur de fichiers vérifie taille (deux Mio par fichier), descripteur ordinaire, absence de lien symbolique sur Linux, révocation avant/après chaque lecture et correspondance du journal. Les fichiers internes `committed_*` et `.commit` sont refusés dans la route publique. Seule une piste du plan exact peut être demandée par le jeton de la session. Pas de certificat de couverture complète ni de faux EOF.

Edge normalise le nouveau descripteur et les indices préparés; la capacité vient de l'appelant courant, jamais d'un ancien indice stocké. Un ancien client/natif qui ne l'annonce pas ne peut pas réserver de décodeur conservé. WatchPage n'affiche les cues qu'après réception de l'origine HLS `INIT_PTS_FOUND` du flux principal. Un seul moteur possède les sous-titres; les pistes préparées se changent sur place, et « Off » supprime le moteur et la piste. Les réponses arrivant après changement de piste, désactivation ou changement d'horloge ne peuvent pas restaurer des cues périmés. Les réglages WebVTT standards et identifiants sont conservés. Un silence prolongé n'est pas transformé en preuve de fin.

### Rejeu du code candidat, sans injection de logique média

Le Gateway, WatchPage et le normaliseur Edge sont les sources du candidat. Le harnais fournit le catalogue/visibilité synthétique, les appels ordinaires de claim SQL et l'expiration/coordinator déjà décrits; il ne constitue pas une validation de l'entrée authentifiée de production dans son intégralité. La préférence de piste est fournie comme métadonnée d'entrée, sans modifier ensuite l'état interne du lecteur.

Premier essai conservé : le profil de fixture omettait `extractable` et le type texte; le menu restait vide. Le profil synthétique et la piste demandée sont corrigés, aucune déduction de langue/profil client ajoutée pour contourner le défaut. Le second essai, terminé à **00:37:15 Paris**, donne :

- Première lecture effective **9,222 s**; reprise effective **3,657 s**, première image **1,320 s**. Position source 99,252181 s, cible locale 69,252181 s. L'origine HLS reste 0,023 s dans cet essai (pas de nouveau glissement); les tests de PR720/721 couvrent leur glissement propre.
- **144,747819 s de vidéo parcourues après reprise**, avec une pause volontaire à 101,367554 s pour tester le menu; la portion continue après retour en lecture mesure **112,585774 s**. Ne pas présenter le total comme une lecture ininterrompue.
- Deuxième piste sélectionnée par le menu réel : cues traversant/futur présents; puis Off, puis piste forcée. Une seule piste affichée au maximum. La réplique future est active à 120,413572 s, dans l'intervalle attendu 120–125 s, sans doublon.
- Nouvelles données source reçues après revalidation, même PID, ancien accès révoqué, maximum une requête/socket source; zéro pendant le stationnement. Réservations libérées à la clôture.
- Zéro erreur HLS et zéro événement `waiting`. Les seuls écarts de callbacks >250 ms sont aux gates de démarrage (7,766 s et 2,367 s); aucun après la première seconde de média reprise. La pause utilisateur est explicitement séparée.
- Extrait distinct de douze secondes, segments 53–55 : **288 paquets vidéo et 563 paquets AAC-LC stéréo 48 kHz**, décodés sans erreur. **Pas d'acceptation à l'écoute**, navigateur muet.

### Vérifications et limites

**137 tests ciblés réussis**, incluant les 99 premiers; ne pas les additionner. Les tests nouveaux couvrent publication tronquée, lecture bornée, révocation en vol, métadonnées contradictoires, horloge, réponses tardives et conservation des réglages. Une instrumentation Android utilise les vrais contrôles WatchPage et TextTracks avec cues synthétiques, sur navigation gestes/trois boutons et polices 1/1,3. Les six jobs ciblés **37854579339** passent sur `3776bfc70cb34b86e9334fbdde8f0dc3a5955e9d` : quatre téléphones et deux TV, ces deux derniers limités au consentement D-pad. Le test de menu est également passé dans Chromium.

Le premier contrôle CI a refusé le manifeste i18n généré devenu obsolète après modification des assets; il est régénéré, sans nouvelle traduction. La première matrice automatique complète a été annulée au profit de la matrice ciblée. Une matrice automatique ultérieure **37855104797** réussit cinq jobs; le sixième (TV police 1,0) échoue avant les tests, pendant l'installation de l'émulateur (`Error on ZipFile unknown archive`, puis ADB inaccessible), sans rapport de test. Aucun seuil ni assertion modifié et aucun rerun de ce job. Les échecs et tentatives restent dans les reçus.

La dernière revue `911f6c95f5ecf06b33b0280896b8aa51cee66036` refuse un indice de piste absent et conserve l'indication de chargement pour une piste non préparée; 14 tests locaux recoupés passent. Sa CI complète **37866613081**, étape contrats, réussit **6 141 tests, 31 ignorés, zéro échec**. À **03:01:33 Paris**, les **17 contrôles de cette tête sont réussis**, dont la matrice automatique complète **37866613079** (quatre téléphones, gestes/trois boutons et polices 1/1,3; deux TV), les contrats/typage Edge, la base isolée, les parcours, les tests JVM et les trois paquets. Le scénario de sous-titres est synthétique en WebView; aucun résultat ne certifie un décodeur TV conservé.

À **00:38:12 Paris**, deux Gateways sains, image PR706 et démarrages inchangés; `retainedEnabled=false`, cache récent limité au propriétaire, dispatcher actif. Conteneur, réseau de preuve et tunnel arrêtés. Aucun appel média fournisseur, déploiement Gateway ou gain supplémentaire sur Normal. Activation toujours exclue : qualité à l'écoute, sources variées et entrée authentifiée complète restent à valider. Aucune nouvelle vérification ou soumission Google Play pendant ce passage.

Reçus : `.codex-artifacts/retained-public-subtitles-20261009/`, dont `summary.safe.json`, `browser-proof-first.safe.json`, `browser-proof.safe.json`, `decode-and-subtitles.safe.json`, `expanded-tests.tap`, `runtime-check.safe.json` et `browser-result.jpg`. L'attachement PR722 a été refusé à la limite de cent pièces; aucune pièce retirée.

Dernière relecture serveur à **02:58:44 Paris** : deux Gateways toujours sains, mêmes images et démarrages, conservation désactivée, cache récent limité au propriétaire, dispatcher actif et tous les conteneurs de preuve absents. Reçus `runtime-final.safe.json` et `final-code-checks.safe.json`. La dernière mise à jour du rapport seule ne change pas le code testé.


## Parcours HTTP authentifié complet en environnement isolé — 9 octobre, 05:18 Paris

PR722 est intégrée par `e170a3bea30c632540d219b6a53d5eb753f7d3de`. Ce passage utilise son code applicatif sans modification. Il remplace les adaptateurs de création/expiration et l'assertion de visibilité synthétique des anciens essais par **le routeur et le handler Edge complets**, PostgREST, les fonctions PostgreSQL et leurs propriétaires/ACL restaurés depuis un export de structure uniquement. Aucune ligne client, clé de production, session utilisateur réelle ou donnée fournisseur n'est copiée.

### Périmètre et contrôles d'accès

Le réseau Docker de preuve est interne. Deux identités et une source locales sont créées; des JWT temporaires sont signés avec une clé propre au test. L'abonnement est contrôlé en mode `enforce`. Les lectures de visibilité, générations, profils, claims et reçus de fermeture passent par les RPC et tables réelles. Le singleton de visibilité est initialisé comme donnée de fixture. Le module complet du relais exécute ses contrôles et sa coordination; seul son stockage Durable Object est local et sérialisé, avec alarmes. L'import `cloudflare:sockets` est remplacé par un adaptateur qui refuse tout appel; aucun socket Cloudflare n'est utilisé.

Ce montage ne constitue pas un test du frontal Kong/TLS, de l'émetteur de sessions de production, de la contention Cloudflare ou d'un catalogue fournisseur. Un pont TCP local relie PostgREST au PostgreSQL isolé qui écoute sur loopback. La base conserve ses protections SQL; aucune fonction d'autorisation ni règle RLS n'est remplacée par un résultat forcé.

Contrôles négatifs par le même POST HTTP : **401** pour un jeton invalide, **404** pour une source d'un autre propriétaire, **409** pour une source désactivée, **404** pour un appareil révoqué, **402** pour un abonnement expiré. Zéro ouverture média pendant chacun de ces cinq essais. L'autre propriétaire ne peut pas fermer la session existante : **403**, décodeur toujours présent. Ces résultats ne sont pas additionnés aux suites unitaires historiques.

Le cycle HTTP sans navigateur termine à **05:07:25 Paris** : création en 660 ms, réponse de reprise en 140 ms. Ces durées ne sont pas des temps jusqu'à l'image. Même PID conservé, ancien jeton refusé pendant la pause (401), ancienne URL absente après transfert (404), piste VTT publique disponible et journal interne refusé (404). Les deux compteurs observés — requêtes et sockets source — sont nuls pendant le stationnement.

### WatchPage avec cette chaîne authentifiée

Une page de mesure monte le vrai WatchPage et HLS.js 1.7.3. Ses boutons transmettent la création et la fermeture à l'Edge complet avec le JWT de fixture. L'adaptateur expose la réponse publique au lecteur et réécrit seulement l'origine média vers le tunnel loopback; il n'injecte ni logique de décodeur, ni délai de démarrage, ni sous-titres. Les assets Gateway, Edge, relais et WatchPage correspondent au code de PR722; 239 fichiers source sont recensés dans le manifeste local.

- Lecture initiale effective **6,395 s**, première image **1,633 s**. Des données du cache de la fixture existent déjà : ce n'est pas une mesure à froid.
- Fermeture à la position source **68,156943 s**, origine 30 s, cible locale **38,156943 s**. Reprise effective **3,264 s**, première image **1,483 s**.
- **130,093057 s de média parcourues après la cible**, sans pause volontaire. Zéro erreur HLS et zéro événement `waiting`. Les deux seuls écarts de callbacks >250 ms sont les gates initial et de reprise, à 0,042 et 38,250 s; aucun après la première seconde suivant la cible. Cela reste une observation bornée, pas une certification du film entier.
- Les répliques attendues sont actives à **40,277055 s** et **120,277984 s**, dans leurs intervalles 40–45 et 120–125 s. Une piste affichée, aucun doublon observé. Le menu avait été couvert par PR722; il n'est pas compté comme un nouveau replay de changement de piste ici.
- Le même décodeur est conservé. L'ancien accès est révoqué, la connexion source est fermée pendant la pause, maximum une requête/socket simultanée. Une nouvelle plage **32–40 Mio** est reçue après les quatre échantillons de revalidation. Les requêtes de ce replay n'atteignent pas EOF; le fichier mesure 67 429 636 octets. Les essais précédents du même fichier sont exclus de cette borne temporelle et les bornes demandées ne sont pas présentées comme des octets effectivement livrés.

Deux extraits distincts de douze secondes, dont un englobant la position reprise (segments 9–11), sont décodés localement sans réseau. Chacun contient **288 paquets H264 et 563 paquets AAC-LC stéréo 48 kHz**, sans erreur FFprobe/FFmpeg. Autour de la reprise, pas maximal de timestamps : vidéo **42 ms**, audio **21,334 ms**. Le navigateur était muet : **aucune validation à l'écoute** n'est revendiquée.

### Incidents du harnais et clôture

Les erreurs de préparation restent distinctes des résultats produit : export initial incomplet de dépendances SQL; réseau PostgreSQL local et reconstruction des fixtures après redémarrage de son stockage volatil; préfixe de route normalement retiré par Kong; jeton Gateway de fixture trop court pour le routeur; assertion de statut 404 au lieu du 403 réel; snapshot de sous-titres demandé avant disponibilité (503 normal); confusion entre identifiant de ligne SQL Gateway et identifiant externe; URL relative de test refusée par WatchPage. Le premier arrêt du frontal de test utilisait un utilitaire absent; l'arrêt a ensuite ciblé son processus exact. Ces corrections concernent uniquement le montage de preuve. Les sources produit sont inchangées.

À **05:18:13 Paris**, zéro session SQL active, zéro encodeur réservé, zéro producteur HLS et zéro connexion source dans la preuve. Les cinq conteneurs, leur réseau et le tunnel sont arrêtés/retirés, les médias synthétiques et clés éphémères supprimés. Les deux Gateways de production restent sains, même image PR706 et mêmes démarrages du 8 octobre à 14:25 UTC, dispatcher actif; conservation du décodeur désactivée, cache récent limité au propriétaire. Aucune lecture fournisseur, modification ou déploiement de production, aucune nouvelle vérification Google Play.

**Ce passage valide la chaîne applicative authentifiée sur fixture.** Les fournisseurs et formats variés, la qualité à l'écoute, la contention distribuée et l'activation contrôlée restent à valider. Aucun nouveau gain sur Normal et aucune extension du pilote ne sont annoncés. Reçus : `.codex-artifacts/retained-authenticated-20261009/`, notamment `summary.safe.json`, `flow-proof.safe.json`, `negative-access.safe.json`, `browser-proof.safe.json`, `audio-boundary-check.safe.json`, `final-inspection.safe.json`, `cleanup.safe.json` et `browser-result.jpg`.

## Premiers contrôles sur sources réelles — 9 octobre, 06:19 Paris

Les cinq contrôles de PR723 passent désormais, paquets Android Phone/TV et Windows inclus. Ce nouveau passage utilise le code applicatif de PR722 dans un **Gateway temporaire**, sans remplacer les deux Gateways de production. La conservation du décodeur reste désactivée en production. Aucun code produit, seuil de réserve, délai de rétention, modèle, route ou niveau de concurrence n'est modifié.

### Périmètre et corrections du montage

Trois copies exactes du propriétaire déjà autorisé pour le pilote sont sélectionnées : **Normal** (Strng, MKV HEVC 4K, EAC3 et sous-titres forcés), **Abduct MULTI-SUB** (MAX OTT, MKV H264/AAC et nombreuses pistes texte), et **Vice-versa 2** (MAX OTT, MP4 H264/AAC). Les profils et la révision courante sont relus avant chaque admission. Les réservations natives passent par l'Edge réel avec jeton propriétaire temporaire; leurs heartbeats indépendants restent à 0,5 seconde, timeout une seconde, avec arrêt du seul candidat avant fermeture en cas d'échec. Les lectures sont séquentielles sur le relais épinglé. Neuf sessions natives au total, toutes clôturées : **ce nombre ne désigne pas les requêtes HTTP**, chaque lecture pouvant utiliser plusieurs plages.

WatchPage et HLS.js sont réels, mais l'adaptateur appelle directement le candidat après acquisition du claim natif. Ce n'est pas un nouveau test intégral de la route publique Edge → Gateway; cette route a été couverte sur fixture dans PR723. Le candidat possède ses sorties et ses caches temporaires; le cache partagé complet, les callbacks de fond et la sélection adaptative de route ne sont pas activés dans ce montage. Aucun élargissement aux autres propriétaires.

Plusieurs erreurs du harnais ont été corrigées avant la série finale, et restent conservées :

- La première durée de vie du candidat copiait l'échéance native initiale de deux minutes, sans bénéficier des heartbeats qui prolongeaient la ligne SQL. La première lecture Abduct atteint une image en **55,024 s**, puis joue en **74,324 s**, mais expire avant le transfert. Le candidat utilise ensuite une échéance de test bornée à dix minutes, sous les mêmes heartbeats natifs et arrêt fail-closed. Aucun TTL de production changé.
- Le premier candidat omettait le décodage matériel et les registres partagés d'admission. Le candidat suivant reprend le périphérique et le décodage de production, ainsi que les registres disque/encodeur. Les réglages de démarrage `VOD_STARTUP_SMALL_WINDOWS_*` et `RETAINED_FINITE_VOD_STARTUP_ENABLED` étaient également absents; ils sont explicitement alignés avant les trois derniers démarrages. Les échecs antérieurs ne sont pas une preuve de régression du produit; aucune comparaison temporelle entre ces montages n'est présentée comme causale.
- Le premier tunnel local s'est arrêté avant navigation, donnant une page d'erreur navigateur. Un tunnel persistant a ensuite été vérifié. Le rafraîchissement du panneau de mesure masque le texte d'erreur du harnais : les reçus HTTP sont conservés comme référence. Une erreur de page est comptée à la fermeture de Normal, sans détail préservé; elle n'est pas assimilée à une erreur AAC.

### Résultats de la série avec réglages de démarrage alignés

| Copie | Résultat observé | Conservation du décodeur |
| --- | --- | --- |
| Normal, position 900 s | Serveur prêt en **21,824 s**, première image en **23,550 s**; lecteur encore arrêté à 0 s. Seulement **52 s** de vidéo produites à 06:13:00 Paris, environ 215 s après admission. | Fermeture pendant cette attente, pas après une lecture fluide. État `retained-parking` observé, puis nouvelle session ordinaire. Pas de transfert réussi. La nouvelle préparation échoue HTTP 502 à 06:14:24 Paris. |
| Abduct, position 120 s | Préparation échouée HTTP 502 à 06:16:11 Paris, environ 62,6 s après création du candidat. | Non testée : pas de première image dans cette série. |
| Vice-versa 2 MP4, position 120 s | Préparation échouée HTTP 502 à 06:18:08 Paris, environ 62,5 s après création du candidat. | Non testée : pas de première image dans cette série. |

Normal n'a **jamais commencé la lecture effective** dans la série finale. La première image ne vaut ni reprise utilisable ni fluidité. Le navigateur attend sa réserve normale; aucun abaissement n'est appliqué. Les plages de huit Mio terminées avant la fermeture durent **1,536 à 94,807 secondes**. Les données reçues restent très irrégulières. Un contrôle du candidat donne zéro pause du producteur, zéro écriture HLS en attente, environ 31,7 Mo de sortie, sous sa réservation de 512 Mio : aucune saturation de cette réservation démontrée à cet instant. Cela ne départage pas la livraison fournisseur et le relais commun.

La conservation attend la fin de la plage active avant d'attester le drainage. Le code borne cet état à dix secondes. Les observations `retained-parking` puis nouvelle session sont compatibles avec cette expiration et le repli normal; **aucun reçu complet de stationnement n'a été enregistré pour cet essai**. La nouvelle session retrouve deux Mio d'en-tête, ce qui ne prouve pas une réutilisation du décodeur ou de la vidéo préparée. La suite utile est d'évaluer en isolation les fenêtres longues et leur fermeture sous transport lent, sans rallonger les délais, supprimer une validation ou ouvrir une deuxième connexion.

### Audio, vidéo et diagnostic matériel

Un extrait local de **six secondes de Normal**, segments 4–6 déjà produits, contient **144 paquets H264** et **281 paquets AAC-LC stéréo 48 kHz**. FFprobe et FFmpeg terminent sans erreur. Pas maximal des timestamps : vidéo 42 ms, audio 21,334 ms; aucun intervalle supérieur à 100 ms dans cet extrait. L'échantillon est supprimé après analyse. Il ne couvre pas une reprise réussie et **ne constitue pas une acceptation à l'écoute**; le navigateur est muet.

Le premier Abduct présente des diagnostics EBML/H264/AAC. Leur origine n'est pas établie par cette série. Sur le premier Normal matériel, une erreur de conversion de filtre apparaît dans le journal de fin; l'ordre exact ne prouve pas qu'elle ait causé l'attente initiale. Deux contrôles ultérieurs **sans réseau**, H264 puis HEVC 10 bits synthétiques, utilisent les fonctions de construction du produit, le GPU réel et le registre partagé d'encodeurs. Tous deux sortent avec code zéro, produisent **12,042 s** HLS et conservent la réplique future dans le journal WebVTT. L'avertissement du pilote AMD apparaît aussi sur ces réussites. Cette vérification ne reproduit pas l'échec de filtre; elle ne résout pas les fichiers réels et ne justifie aucun changement spéculatif du décodeur.

### Capacité disque et clôture

Une admission Normal à 05:49 Paris avait renvoyé HTTP 503 avant production média. Son corps n'a pas été conservé. Un relevé ultérieur trouve **131 298 189 312 octets libres**, sous la garde de **137 438 953 472 octets**; cela établit un manque de marge, mais pas le code exact du refus antérieur. À 05:56:37, l'espace remonte à **161 528 373 248 octets**, et une réservation représentative réussit puis est libérée. La cause de cette récupération n'est pas déterminée. Les deux tentatives préparées de nettoyage d'images ont été arrêtées par leur précondition avant toute suppression : **zéro ancienne image ou cache de production supprimé**.

À **06:18:57 Paris**, les neuf claims de test sont expirés par fermeture ordinaire, le candidat et le conteneur sans réseau sont absents, le serveur de contrôle est arrêté; les médias et clés éphémères sont supprimés. Le tunnel et l'onglet de lecture sont ensuite fermés. Les deux Gateways restent sains, même image PR706 et mêmes démarrages du 8 octobre à 14:25 UTC, zéro session active à ce relevé et zéro encodeur réservé dans le registre partagé. Dispatcher actif; **161 425 727 488 octets libres**. Conservation inactive et cache récent limité au propriétaire.

**Aucun nouveau gain sur Normal ni validation des reprises réelles n'est acquis.** Les résultats synthétiques précédents restent valables dans leur périmètre; ils ne suffisent pas à une activation. Aucun nouvel examen Google Play, déploiement Gateway ou replay Android n'est effectué. Reçus : `.codex-artifacts/retained-real-sources-20261009/`, notamment `summary.safe.json`, `startup-alignment.safe.json`, les observations horodatées, `normal-aligned-trace.safe.json`, les trois reçus d'échec finaux, `audio-041030.safe.json`, `hardware-offline.safe.json` et `cleanup.safe.json`.

## Fermeture d'une plage lente sans perdre le décodeur — 9 octobre, 06:35 Paris

Les cinq contrôles de PR724 passent désormais, paquets compris. La suite porte sur le blocage de drainage identifié dans le code, en réseau isolé, sans nouvel appel fournisseur. Elle ne réattribue pas rétroactivement l'échec de Normal : le reçu de stationnement manquant lors de cet essai reste manquant.

### Reproduction et correctif

Un serveur HTTP local renvoie un en-tête exact, puis 4 Kio, et ne termine jamais sa réponse. Avant correction, la barrière attend toute cette plage; le test expire sans capacité de conservation. Le délai de fixture est d'une seconde pour borner la reproduction; le plafond produit de dix secondes reste inchangé.

La barrière peut maintenant demander l'annulation de la seule requête amont active. Le mutex reste détenu jusqu'à son nettoyage. Le transport privé est ensuite détruit et la grâce normale de libération est attendue avant émission de la capacité. La connexion locale du décodeur conserve son `Content-Length` et reste ouverte. Aucune requête source ne repart avant revalidation et adoption ordinaires.

- Les octets déjà transmis au décodeur restent transmis; la requête suivante commence exactement après eux.
- Les petites plages MP4 traitées en bloc peuvent contenir des octets reçus mais pas encore transmis : ils sont abandonnés et relus, sans sauter ce préfixe.
- Aucun fragment de la réponse interrompue n'est publié comme fenêtre complète, conservé dans le cache de reprise ou joint à une nouvelle réponse pour former une fenêtre complète.
- Une erreur terminale, un timeout réseau, une révocation ou une fermeture de session ne sont pas convertis en pause réussie. L'annulation doit correspondre au signal interne de la conservation.
- Expiration, validation courante, identité de fichier, piste, propriétaire, route et connexion unique restent requis. L'annulation n'est pas comptée comme une panne/reconnexion fournisseur; la trace porte `retained-pause`.

Le changement ne s'applique qu'au broker privé déjà muni de la capacité de conservation; aucune activation, réduction de réserve, extension de TTL, modification de taille des plages ou de concurrence n'est ajoutée.

### Preuves du broker et du décodeur

**307 tests ciblés réussis, six ignorés**, zéro échec dans la série finale. Ils couvrent notamment la pause avant les en-têtes, pendant une réponse partielle diffusée, pendant une plage atomique, les demandes locales recoupées, le refus de revalidation, la révocation, l'expiration et les protections existantes des caches/claims/transferts. Le test de reproduction échouait avant correction. Une erreur de fixture intermédiaire appelait un accesseur inexistant `stats()`; elle a été corrigée en utilisant le compteur public `providerBytes`, sans changer le produit pour faire passer le test.

Un second essai utilise le vrai broker extrait du code courant et **un FFmpeg conservé**, dans un conteneur UID1000, réseau `none`, système de fichiers en lecture seule avec espace temporaire borné. Le serveur de fixture n'écoute qu'en loopback. Le fichier synthétique dure quatre minutes, avec vidéo H264, AAC stéréo et deux pistes de sous-titres. Une réponse est volontairement interrompue après 64 Kio, au-delà des quatre premiers Mio complets.

- Stationnement en **254 ms**, incluant la grâce de **250 ms configurée pour cette fixture**; ce n'est pas le délai de grâce ou un temps de reprise mesuré en production.
- Pendant 1,5 seconde observée : zéro requête et zéro socket source, même décodeur, playlist inchangée/non finale, zéro tick CPU supplémentaire observé.
- **Quatre échantillons frais** sont relus séquentiellement par le validateur réel avant réouverture. Maximum une requête/socket source sur l'ensemble de l'essai.
- Les **60 segments HLS** sont identiques octet par octet au témoin continu. Les deux fichiers WebVTT, cinq répliques au total dont la traversante et la future, sont identiques.
- L'audio décodé en PCM possède la même empreinte SHA-256 que le témoin continu; aucune erreur FFmpeg. Le premier nouveau segment apparaît 24 ms après revalidation sur loopback : ce n'est pas un délai clic-vers-lecture.

Cette preuve couvre l'interruption amont dans le broker avec le décodeur réel. Elle ne rejoue pas la chaîne authentifiée complète de PR723, les claims de production, le navigateur ou les fournisseurs. Aucune acceptation à l'écoute ni accélération de Normal n'est revendiquée.

### Clôture et limites

À **06:35:12 Paris**, le conteneur de preuve est absent; son stockage temporaire et les médias synthétiques sont détruits. Les deux Gateways sont sains, mêmes image PR706 et démarrages du 8 octobre à 14:25 UTC. Dispatcher actif, conservation du décodeur désactivée, cache récent limité au propriétaire. Aucun déploiement Gateway, lecture fournisseur, mutation de production, nouvel examen Play ou test Android dans ce passage backend.

Le correctif supprime la dépendance à la fin d'une plage lente pour stationner le décodeur en test isolé. Il n'améliore pas le débit reçu après la reprise. **La fluidité et le transfert sur les copies réelles restent à valider avant activation**, ainsi que la qualité à l'écoute. Les échecs Abduct/MP4 et l'attente initiale de Normal du relevé précédent restent ouverts.

Reçus : `.codex-artifacts/retained-slow-window-20261009/`, notamment `baseline-test.txt`, `expanded-final-tests.txt`, `slow-broker-proof.safe.json`, `runtime-check.safe.json` et `summary.safe.json`. Les sources du montage et les tests de non-régression sont conservés; aucun secret fournisseur n'y est nécessaire.

La première CI de ce changement échoue sur une observation du test de lecteurs recoupés : 6 148 réussis, un échec, 31 ignorés. Avec une grâce artificielle nulle, le test vérifiait le compteur du serveur avant que sa boucle ait reçu l'événement `close`, alors que le dispatcher client était fermé. Le test attend désormais explicitement cet événement et prouve aussi que le second lecteur est réellement arrivé; les fixtures atomiques utilisent la même observation. Aucun délai ni code de production n'est modifié pour cet ajustement. L'échec initial reste conservé dans `ci-failure.log`.


## Retour aux copies réelles et cible de livraison du décodeur — 9 octobre, 07:05 Paris

Les cinq contrôles de PR725 passent désormais, paquets compris. Nouveau banc temporaire : code courant, GPU réel, réservations disque/encodeur partagées avec la production, profils exacts courants, claims directs authentifiés ordinaires, heartbeat toutes les 0,5 s et arrêt fermé en cas d'échec. WatchPage et HLS.js 1.7.3 sont utilisés. Le chemin média passe par le Gateway candidat en loopback; ce n'est pas un déploiement ni une relecture de l'entrée Edge-to-Gateway de production. Un seul compte fournisseur est utilisé à la fois. Les marqueurs consommés précédents ne sont pas rejoués.

### Résultats avant le nouveau raccordement

- **Normal, position 900 s** : première image en **49,786 s**, mais aucun démarrage effectif de lecture; la réserve reste insuffisante. La fermeture conserve réellement le même processus FFmpeg en **2 506 ms**, avec **zéro socket source au relevé stationné**. C'est une validation réelle de la mise en pause corrigée par PR725. La requête suivante repart toutefois avec un nouveau décodeur et échoue au plafond de préparation de 60 s. Le motif précis de cette première non-réutilisation n'a pas été instrumenté : ne pas lui attribuer rétroactivement le diagnostic Abduct.
- **Abduct, position 120 s** : première image en **45,541 s**, sans lecture effective avant fermeture. Le décodeur est stationné; les diagnostics temporaires attestent même demande, position disponible, taille et route concordantes. Quatre échantillons frais reviennent en **5 845 ms**, mais l'URL de livraison exacte diffère, malgré un validateur identique. Le transfert est refusé à **9 606 ms** de conservation, avant le plafond de dix secondes. L'égalité des quatre empreintes de contenu n'a pas été journalisée séparément; ne pas la revendiquer. Le retour au chemin froid affiche une première image en **57,082 s depuis la fermeture/reprise**, toujours sans démarrage effectif avant clôture. Le processus a changé.

### Correctif du prototype et tests

La revalidation du décodeur repartait de l'adresse d'entrée, qui pouvait fournir une nouvelle cible temporaire. Le mécanisme d'adresse conservée existait pour le cache récent, mais n'était pas raccordé ici. Le broker peut maintenant produire le même indice opaque à usage unique après stationnement : capacité privée exacte, état `parked`/`validating`, zéro plage active et dispatcher détruit. Un input actif, encore en drainage, expiré ou présenté avec une capacité forgée ne satisfait pas ce nouveau chemin.

Le transfert transmet cet indice au validateur existant. La nouvelle réservation ordinaire garde la responsabilité du réseau. **Quatre échantillons frais, taille, identité, URL exacte et validateur restent requis**, ainsi que la position courante et toutes les gardes de demande. Une cible expirée, redirigée, modifiée ou invalide reste refusée; le retour normal conserve son rôle. Aucun TTL, seuil de réserve, route publique, parallélisme ou quota ne change. Le jeton n'est pas une preuve de contenu et n'est pas exposé au navigateur.

**Six tests de régression échouent avant correction.** Après correction : **217 tests ciblés réussis, cinq ignorés**, zéro échec. Les tests HTTP réels en loopback couvrent l'adresse inchangée, les octets modifiés, l'expiration, la redirection et la taille modifiée, pour un broker fermé et pour un broker stationné. Le test de transfert vérifie le raccordement du jeton au validateur. La CI du code `e6d6d5a30` réussit **6 155 tests, 31 ignorés**, zéro échec; les groupes se recoupent. Les traces diagnostiques ajoutées au seul candidat ne sont pas dans le code produit.

### Essais du candidat corrigé : activation toujours refusée

Abduct affiche une première image en **33,571 s** et démarre effectivement en **39,765 s**, mais des interruptions surviennent ensuite. Le journal d'entrée comporte des diagnostics EBML, et le lecteur approche la fin de la vidéo disponible. La fermeture ne conserve pas le décodeur (`closed`); l'opérateur arrête l'essai **sans nouvelle admission de reprise**. Le prédicat exact ayant refusé cette conservation n'a pas été capturé; sa proximité avec la fin du tampon ne suffit pas à en prouver la cause unique. L'origine des diagnostics d'entrée n'est pas départagée par cet essai.

Normal est ensuite réessayé sur le candidat corrigé, toujours à 900 s : HTTP 502 après le plafond ordinaire de **60 s**, **aucune première image**. Le transfert corrigé n'est pas atteint. Ces résultats ne prouvent donc aucun gain de reprise ni une fluidité durable. Vice-versa 2 n'est pas rejoué : la conservation du même décodeur reste bornée au chemin Matroska, et son échec MP4 précédent reste ouvert.

Un extrait de six secondes produit lors du retour froid Abduct est contrôlé hors réseau : **AAC-LC stéréo 48 kHz**, décodage sans diagnostic, intervalle audio maximal 21,334 ms. L'extrait vidéo comporte un intervalle de **1,209 s** entre deux timestamps : il ne certifie pas une vidéo fluide. Ce contrôle n'est ni un raccord du décodeur conservé ni une acceptation à l'écoute. L'échantillon temporaire est supprimé après analyse.

### Clôture

À **07:04:50 Paris**, les **six claims** de cette série sont expirés par le chemin ordinaire. Le candidat est supprimé, son serveur de contrôle arrêté, ses médias et clés temporaires supprimés. Le tunnel et l'onglet sont ensuite fermés. Les deux Gateways sont sains, même image PR706 `efd3ae83…`, mêmes démarrages du 8 octobre à 14:25 UTC, zéro session active à ce relevé et zéro encodeur réservé; dispatcher actif. Espace libre : **161 517 834 240 octets**. La conservation reste désactivée et le cache récent conserve son périmètre propriétaire. Aucun nouveau déploiement Gateway, examen Play, changement de garde ou replay Android.

**Le stationnement réel progresse et une cause de rejet est corrigée dans le prototype. Le transfert corrigé sur des sources réelles, la continuité et la qualité à l'écoute restent à valider. Aucun nouveau gain sur Normal.** PR726; attachement Codex refusé à la limite de 100, aucune pièce retirée. Reçus sous `.codex-artifacts/retained-real-drain-20261009/` : `summary.safe.json`, `delivery-baseline.txt`, `delivery-tests.txt`, `ci-contracts.log`, captures navigateur et `receipts/` (traces, diagnostics, audio et clôture). Les traces historiques et les échecs sont conservés séparément.


## Premier transfert réel corrigé et horloge des sous-titres — 9 octobre, 08:03 Paris

Les cinq contrôles de PR726 passent désormais, paquets compris. Ce passage utilise un nouveau Gateway temporaire, GPU et registres disque/encodeur partagés, avec les claims natifs ordinaires et le même relais épinglé. WatchPage et HLS.js 1.7.3 sont réels; l'adaptateur relie le claim de production au candidat loopback. Ce n'est pas un nouveau replay complet de l'entrée publique Edge → Gateway. Les réserves, délais, quotas, routes et protections de connexion unique restent inchangés.

**Conclave, copie française Dino MKV**, possède un profil courant complet : H264, AAC stéréo, deux pistes ASS (forcée et complète SDH), fichier de 3 093 967 019 octets. Sa visibilité et sa révision sont relues avant chaque admission. L'inventaire read-only de Silo trouve le rattachement d'épisode mais pas de profil courant exploitable : aucune sonde ou lecture supplémentaire n'est lancée sur cette série. **Normal n'est pas rejoué pendant ce passage.**

### Transfert réel avec le code de PR726

Premier démarrage à 600 s, le 9 octobre à 07:40 Paris : serveur prêt en **26,075 s**, première image en **28,531 s**, lecture effective en **50,564 s**. Fermeture après environ 2,8 s de média parcouru. Stationnement en **2 504 ms** et zéro socket source constaté; le même processus FFmpeg reste présent. L'ancien claim est clôturé normalement, puis un nouveau est admis.

À **07:41:15 Paris**, le transfert réussit : indice opaque de livraison utilisé, revalidation fraîche **3 820 ms**, temps total serveur **3 825 ms**, zéro nouveau FFmpeg ou analyseur. Les diagnostics attestent position disponible, validation réussie, cible et validateur identiques. La barrière reprend à 7 249 ms de conservation, dans son délai de dix secondes. Les quatre échantillons exigés par le validateur restent requis.

La première image revient **8,542 s après le bouton fermer/reprendre**, mais **la lecture effective n'arrive qu'à 124,447 s**. Ce n'est pas une reprise rapide validée. Après adoption, la politique serveur n'admet pas de démarrage adaptatif (`requested-transcode`, mesure de cadence absente); le lecteur reçoit ici une politique nulle et conserve sa réserve de repli de 96 s. Le banc ne réinterroge pas ensuite la route publique complète d'état. Aucune ancienne mesure de débit n'est promue en preuve fraîche et aucune réserve n'est réduite.

Une fois démarré, le lecteur parcourt **151,447782 s** après la cible locale, sans pause volontaire, sans événement `waiting` ni écart de callback d'image supérieur à 250 ms enregistré. Les données nouvelles dépassent la réserve présente au transfert. **Un timeout HLS non fatal `fragLoadTimeOut` est enregistré** : ne pas annoncer zéro erreur. La nouvelle plage amont complète de huit Mio prend notamment 35,459 s. Le relevé cgroup ne montre pas de saturation CPU ou mémoire : 8,648 s CPU cumulées, un throttling total de 94 ms, environ 199 Mo en mémoire, zéro OOM. Cela ne départage pas la livraison fournisseur et le relais et ne certifie pas le film entier.

Deux extraits distincts de six secondes, autour des timestamps locaux **26–32 s** puis **182–188 s**, contiennent chacun 144 paquets H264 et 282 paquets **AAC-LC stéréo 48 kHz**, sans erreur de décodage. Pas maximal vidéo 42 ms, audio 21,334 ms. Aucun extrait ne couvre exactement la position de transfert à 2,831218 s : le script nommé « boundary » a lu une playlist ayant déjà glissé. Navigateur muet, **aucune validation à l'écoute**.

### Sous-titres refusés et reproduction indépendante

Sur ce replay, le menu réel permet de sélectionner la piste SDH sans redémarrer la vidéo, mais le navigateur ne reçoit aucune réplique et le service de publication répond 503. Les fichiers WebVTT et journaux existent; leurs octets n'ont pas été conservés avant clôture. **La cause exacte de ces 503 réels n'est donc pas établie.**

Une reproduction synthétique sans réseau montre néanmoins un défaut concret du même graphe : un saut d'entrée à 9 s coupe une réplique 8–11 s. Sans conservation des horloges source, le journal porte −1–2 s tandis que le muxeur WebVTT déplace cette réplique vers 0–3 s; la réplique future est aussi décalée. Le lecteur strict de paquets refuse cette contradiction. SRT et ASS reproduisent le défaut; le contrôle sans saut passe. Désactiver seulement le déplacement des timestamps négatifs produit un WebVTT invalide et est écarté.

Le correctif **`22f2a8847`** applique `-copyts` à l'entrée du seul graphe admis de conservation avec sous-titres exacts. Vidéo, audio et journaux conservent ainsi la même horloge absolue. Les répliques synthétiques restent exactement à 8–11 s et 12–14 s et passent la vérification stricte. La clé du cache distingue désormais `subtitleInputClock=absolute-v1` pour empêcher de réutiliser une ancienne sortie construite avec une autre horloge. Aucun contrôle de paquets, d'identité ou d'accès n'est assoupli.

Deux assertions échouent avant correction. Après : **94 tests ciblés réussis, un ignoré**. Quatre contrôles matériels sans réseau combinent H264/HEVC 10 bits et sauts à 2/10 s; les sous-titres conservent leurs horodatages source, et les extraits AAC se décodent sans erreur. Les deux avertissements AMD déjà observés restent présents; sortie FFmpeg zéro. Les premières assertions de fixture supposaient à tort des timestamps entiers sans les 21 ms du mux source, puis excluaient une réplique expirée encore présente depuis le paquet antérieur au seek. Seules ces assertions de preuve sont corrigées; leurs échecs sont conservés. Pas de preuve perceptuelle ni de décalage A/V nul déduit de ces essais.

### Replays ultérieurs et limite d'activation

Deux nouveaux démarrages de Conclave à la même position échouent au plafond de préparation de 60 s, HTTP 502 : **07:49:44 Paris avant le correctif d'horloge**, puis **07:57:57 après le correctif**. Aucune première image ni transfert dans ces deux essais. La lecture bornée des journaux de sous-titres ne capture aucun paquet dans le dernier essai. Les messages d'erreur d'entrée et de filtre apparaissent dans la séquence de fermeture; cet ordre ne prouve pas leur responsabilité dans l'attente initiale. Le candidat finit arrêté par la procédure fail-closed, sans OOM.

Le premier transfert réel valide le raccordement corrigé par PR726 sur cette copie. **Il ne valide ni le nouveau correctif de sous-titres sur Conclave, ni un démarrage fiable, ni une accélération de Normal.** La suite devra recueillir les premiers paquets réels et la cadence courante après adoption, dans un essai borné où le démarrage aboutit. Répéter les mêmes admissions en rafale n'apporterait pas cette preuve.

### Vérifications et clôture

La CI du code PR727 réussit **6 155 tests, 31 ignorés, zéro échec**, groupes recoupés avec les tests ciblés; pas de modification UI ou nouveau replay Android. À **08:03:07 Paris**, les quatre claims de cette série sont expirés par le chemin ordinaire : trois démarrages et une reprise, pas quatre requêtes HTTP. Candidat supprimé, contrôleur et tunnel arrêtés, médias et clés temporaires supprimés; zéro fichier média de preuve restant. Deux Gateways sains, image PR706 `efd3ae83…`, démarrages du 8 octobre à 14:25 UTC inchangés, zéro session active et zéro encodeur réservé à ce relevé. Dispatcher actif; espace libre **161 289 465 856 octets**.

Le premier tunnel de cette série s'est arrêté avant la seconde navigation de diagnostic et a donné une page locale inaccessible; il a été recréé une fois avec heartbeat SSH. L'onglet final de lecture est fermé; la fermeture explicite de l'ancien onglet d'erreur est refusée par la politique d'URL de l'outil, sans accès réseau restant. Cet incident du montage ne constitue pas un échec média supplémentaire.

**Conservation du décodeur toujours désactivée en production, cache récent limité au propriétaire, aucun déploiement Gateway ou examen Google Play.** Le correctif intégré ne constitue pas une activation. Attachement PR727 refusé à la limite de cent pièces, aucune pièce retirée. Reçus : `.codex-artifacts/retained-real-window-20261009/`, notamment `summary.safe.json`, `clock-baseline.txt`, `clock-tests.txt`, `ci-contracts.log`, `conclave-clock-start-failed.jpg` et `receipts/` (premier résultat réel, deux échecs séparés, tests synthétiques, contrôles matériels, audio et clôture).


## 9 octobre, 08:12–08:36 Paris — origine AAC corrigée et sous-titres réels après transfert (PR728)

### Diagnostic sur la préparation

Un démarrage borné de Conclave avec le code PR727 échoue encore après le plafond de préparation de 60 s, à **08:21:50 Paris**, sans segment vidéo finalisé. Une instrumentation du seul candidat mesure le temps passé dans `reader.read()` : une plage de 2 Mio prend **15,939 s**, dont **15,653 s en attente du corps**; la suivante reçoit 1 897 876 octets avec 24,732 s cumulées dans cette attente. Cela confirme une contribution de la réception lente, sans départager livraison et relais, ni lui attribuer toute la préparation.

Le diagnostic de sous-titres initial comporte aussi une erreur de fixture : `readCommittedSubtitle` renvoie du texte WebVTT, pas un objet `cues`. L'erreur affichée après ce retour ne prouve donc pas un refus de publication. Le lecteur de diagnostic est corrigé, sans changer le lecteur strict du produit.

### Régression du prototype reproduite puis corrigée

L'entrée `-copyts` ajoutée en PR727 conserve l'horloge source, mais le vrai convertisseur AAC utilisait encore `aresample=48000:async=1:first_pts=0`. En isolation matérielle, après un saut à 10 s, l'audio commence à **−0,021333 s**, tandis que la vidéo commence à **10,041667 s**. À 2 s, le même écart d'origine apparaît. **La fixture matérielle de PR727 omettait ce filtre réel** et le test du graphe remplaçait le constructeur des arguments audio; leurs résultats précédents ne couvraient pas cette interaction.

Le correctif **`f9022e337`** retire seulement `first_pts=0` dans le graphe admis de conservation avec sous-titres exacts. Il conserve AAC-LC, 48 kHz, stéréo, 160 kbit/s et la compensation existante. Copie audio, graphes ordinaires, plusieurs pistes et cache complet gardent leurs paramètres. La clé `subtitleInputClock=absolute-v2` distingue les sorties précédentes. Aucun délai, réserve, quota, route ou contrôle d'identité n'est réduit.

Une régression échoue avant correction. Après correction : **191 tests ciblés réussis, deux ignorés**. Le test `startFfmpeg` utilise désormais la fonction audio réelle. Six contrôles matériels, réseau isolé et encodeur partagé réservé normalement, couvrent H264/HEVC 10 bits, AAC stéréo/E-AC3 5.1 et sauts à 2/10 s. L'audio commence à **9,978667 s** au saut de 10 s; l'écart avec le premier paquet vidéo reste au plus **63 ms**, pas zéro. Les répliques gardent exactement leurs temps source; décodage sans erreur. Deux avertissements AMD déjà connus subsistent dans chaque contrôle. Aucune validation perceptuelle déduite.

### Conclave : transfert réel et publication avant EOF

Un nouveau candidat temporaire, avec les sources corrigées, utilise les réservations Edge ordinaires et le même fichier exact. WatchPage et HLS.js 1.7.3 sont utilisés; ce n'est pas le chemin public de production Edge → Gateway.

| Mesure depuis l'action | Démarrage à 600 s | Reprise à 625,145431 s |
|---|---:|---:|
| Première image | 34,371 s | 8,285 s |
| Lecture effective | **137,179 s** | **58,006 s** |

La pause conserve le décodeur en **2,507 s**, avec **zéro connexion source** au relevé de pause. Une nouvelle réservation ordinaire revalide le fichier en **3,827 s**; transfert **3,832 s**, même PID FFmpeg, aucune nouvelle instance. Après reprise, la lecture avance de **149,170903 s**, sans événement `waiting` après reprise ni intervalle d'images supérieur à 250 ms mesuré. Deux `levelLoadTimeOut` non fatals sont conservés, un pendant chaque phase : ce n'est pas une lecture dépourvue de tout incident réseau.

La piste SDH est réellement sélectionnée dans le menu avant et après transfert. Le lecteur strict accepte ses paquets **avant EOF**; le navigateur reçoit jusqu'à **67 répliques**, avec huit relevés de répliques actives après reprise et aucun doublon d'horodatage dans le dernier ensemble. L'origine HLS reste identique après transfert, **599,957666667 s**. Une réplique source à 601,268 s correspond exactement au temps navigateur 1,310333333 s après soustraction de cette origine. Cela valide les répliques observées, pas toute la piste du film ni une appréciation à l'écoute. La piste forcée n'avait encore aucun paquet au premier contrôle : son état `SUBTITLE_SNAPSHOT_PENDING` n'est pas compté comme une corruption.

L'extrait au raccord couvre **622,038–628,032 s**, donc la position 625,145431 s, avec 144 paquets H264 et 281 paquets AAC-LC stéréo 48 kHz. Décodage sans erreur, aucun trou supérieur à 100 ms; pas maximal vidéo 42 ms et audio 21,334 ms. Un autre extrait de six secondes avant transfert passe également. Navigateur muet, **qualité à l'écoute toujours non validée**.

La préparation initiale mesurait une production de 0,455×. Après transfert, l'ancienne mesure n'est pas réutilisée et la réserve de repli reste 96 s. Les positions et conditions de réception diffèrent des essais précédents : **ni gain causal de 124 à 58 s, ni démarrage rapide fiable ne sont revendiqués**. Normal n'a pas été relu durant ce contrôle.

### CI et clôture

Les contrats CI du code réussissent **6 157 tests, 31 ignorés, zéro échec**, groupes recoupés avec les tests ciblés. Aucun changement UI ni nouveau replay Android. À **08:36:10 Paris**, les deux claims du candidat corrigé sont expirés normalement; le claim du premier candidat avait déjà été fermé à 08:21:50. Ce sont trois admissions, pas trois requêtes fournisseur. Aucun échec de heartbeat.

Les deux candidats, contrôleurs et le tunnel sont arrêtés/supprimés, médias et sous-titres privés temporaires effacés, zéro fichier média de preuve restant. Les deux Gateways sont sains, image et démarrages de production inchangés, zéro session et zéro encodeur réservé à la clôture; dispatcher actif, **161 219 747 840 octets** libres. Conservation du décodeur toujours désactivée, cache récent toujours limité au propriétaire. **Aucun déploiement Gateway ni nouveau gain sur Normal.** Attachement PR728 refusé à la limite de cent pièces, aucune pièce retirée.

Reçus : `.codex-artifacts/retained-preparation-20261009/` pour la reproduction et les contrôles matériels, puis `.codex-artifacts/retained-audio-fix-20261009/` pour le rejeu corrigé, `summary.safe.json`, `ci-contracts.log`, la capture `conclave-resumed` et les reçus de fermeture. La suite doit réduire l'attente sur une preuve fraîche de débit sans confondre données conservées et arrivée courante, puis valider d'autres copies et l'écoute avant activation.


## Attente initiale, livraison locale et fenêtre glissante — 9 octobre, 09:01 Paris

Les quatre contrôles de la tête documentaire de PR728 passent désormais, paquets Phone/TV/Windows compris. Ce passage conserve le code produit `f9022e337` : seule l'instrumentation temporaire du candidat et du banc change. Aucun correctif produit ni déploiement. Le candidat utilise les registres disque/encodeur partagés, les mêmes profils courants, un claim direct ordinaire et un heartbeat 0,5 s/timeout 1 s avec arrêt fermé. Une seule admission Conclave; aucun rejeu Normal et aucune admission de reprise après le refus.

### Démarrage variable et erreurs conservées

Conclave démarre à la position 600 s : première image **17,840 s**, lecture effective **19,459 s** après le clic. Le serveur mesurait une cadence initiale de **3,627×** sur ses premiers segments, suffisante pour sa politique existante. Le code est inchangé depuis PR728 : cette différence avec les 137 s précédentes ne constitue pas un gain causal d'un nouveau correctif.

Le navigateur parcourt environ **101,45 s** avant la fermeture. Un `levelLoadTimeOut` et quatre `bufferStalledError` non fatals sont enregistrés. Les callbacks présentent 63 intervalles supérieurs à 250 ms, maximum **5,018 s**. L'onglet de preuve était masqué : cette mesure mélange potentiellement ordonnanceur/rendu du navigateur et livraison, et ne prouve pas cinq secondes d'images manquantes dans le fichier. **Aucune fluidité durable ni nouvelle acceptation AAC à l'écoute n'est validée.**

Le proxy local du banc enregistre **92 réponses de playlists HTTP 200**, toutes livrées par le Gateway puis écrites au relais local en au plus **3 ms**; 111 segments HTTP 200, au plus **10 ms**. **30 requêtes de sous-titres HTTP 503** sont conservées pour la piste forcée sélectionnée. Les octets WebVTT et journaux ne sont plus présents après la fermeture ordinaire; la cause précise de ces 503 n'est pas établie, et l'absence supposée de réplique ne suffit pas à la déduire. La piste SDH n'a pas été sélectionnée dans cet essai.

Ces mesures locales concernent seulement les réponses dont l'écriture s'est achevée. L'instrumentation ne conserve ni les GET interrompus avant cette étape, ni un identifiant corrélant le timeout HLS à une requête locale. Elles **n'attribuent pas** le timeout au navigateur, au tunnel ou au Gateway; elles ne mesurent pas non plus le temps fournisseur de préparation des segments. Les hypothèses restent distinctes.

### Cause suffisante du refus de conservation : position hors playlist courante

À **08:54:25 Paris**, le dernier relevé de sortie indique une playlist de **64 segments**, séquence **78**, durée **128,003 s**, dont l'origine est **156,031 s** après le début du flux. Le dernier relevé navigateur est à **101,214496 s**, tampon `[70,087334 ; 222,072334]`, puis le dernier callback à 101,451334 s. La lecture regarde donc des données déjà reçues, situées **environ 55 s avant le début de la playlist courante du serveur**.

La fermeture retourne `closed` en **62 ms**. Le banc arrête le candidat et expire le claim, sans tentative froide masquée. Le prédicat produit `retainedSessionPositionAvailable` refuse explicitement une position antérieure à cette origine. Une reproduction sans réseau, utilisant ce prédicat exact et une playlist reconstruite à partir de **toutes les durées observées**, confirme deux refus à 701,214496/702 s absolues et un contrôle accepté à 760 s. **Trois assertions réussies**, pas trois nouvelles lectures. Les octets de la playlist originale ne sont pas revendiqués; la présence physique de segments plus anciens hors playlist n'a pas été attestée.

La garde est donc suffisante pour refuser cet état; les autres gardes n'ont pas été instrumentées individuellement, et une cause unique n'est pas revendiquée. La revue du code explique comment cet état devient possible : l'admission du producteur avance à la fin d'un téléchargement HTTP de segment, avec jusqu'à **64 s** d'avance côté serveur, tandis que le navigateur peut précharger **120 s** devant la position regardée. Un segment téléchargé n'est pas nécessairement déjà visionné. La fenêtre visible de 64 segments d'environ deux secondes peut ainsi glisser au-delà du playhead.

La correction à éprouver devra conserver une **fenêtre lisible bornée autour de la position réelle**, avec continuité jusqu'aux nouvelles données et protection contre l'éviction pendant le transfert. Réutiliser aveuglément un ancien manifeste ou augmenter seulement sa taille ne prouverait ni la présence des fichiers ni le respect du budget. Aucun seuil de démarrage, TTL, budget, garde d'accès ou avance producteur n'a été modifié dans ce passage. La réserve de repli de 96 s après transfert et la nécessité d'une preuve fraîche de cadence restent des sujets séparés.

### Clôture et limites

À **09:00:45 Paris**, le claim unique est expiré par la voie ordinaire (08:54:27 Paris), le candidat supprimé, le contrôleur arrêté et les médias/clés temporaires effacés. Le tunnel et l'onglet sont fermés. Les deux Gateways sont sains, même image et mêmes démarrages que PR728, zéro session/encodeur réservé au relevé; dispatcher actif, **160 934 293 504 octets** libres. La conservation du décodeur reste désactivée et le cache récent reste limité au propriétaire.

Une commande opérateur combinant tunnel en arrière-plan et observateur a été refusée avant exécution par la revue automatique. Le tunnel et l'observation en lecture seule ont ensuite été lancés dans des sessions gérées séparées. Ce refus n'est pas un échec média. L'observateur réalise 100 relevés bornés, sans erreur de fixture. Après le refus de conservation, un récepteur local de diagnostic a seulement sauvegardé les mesures déjà présentes dans le navigateur, sans nouvel appel média.

**Aucun nouveau gain sur Normal, aucun transfert réussi dans ce passage, aucune activation ou nouvelle garantie de fluidité.** La limite de fenêtre est maintenant reproduite et chiffrée; sa correction reste à implémenter et valider. Reçus : `.codex-artifacts/retained-startup-observation-20261009/summary.safe.json`, `reproduce-window.cjs`, puis `receipts/window-analysis.safe.json`, `window-predicate-reproduction.safe.json`, `http-local.safe.json`, `browser-failed.safe.json`, `delivery-observation.safe.json`, `cleanup.safe.json`. Les résultats précédents ne sont pas effacés.
