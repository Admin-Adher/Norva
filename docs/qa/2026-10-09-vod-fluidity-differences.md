# VOD fluides et lentes : fichiers et réception, 9 octobre 2026

## Demande et résultat

Comparer les copies fluides et lentes de Severance S1E1, puis corriger une cause
Norva démontrée. Suite de PR738/739 et de
[la comparaison des versions](2026-10-09-severance-version-comparison.md).

**Les copies lentes restent non réparées.** Les nouveaux essais distinguent deux
facteurs : leur volume est beaucoup plus élevé et leur réception est souvent
insuffisante, y compris sans lecteur, cache, JavaScript média ou FFmpeg. Un
transfert ponctuellement rapide ne se maintient pas dans le contrôle suivant.
Aucune nouvelle modification applicative ou de production n'est justifiée par
ces essais. Le pilote précédent reste limité au même propriétaire.

Ce relevé n'est pas une nouvelle lecture publique ni une validation à l'écoute.
Les lectures publiques précédentes restent décrites dans leurs rapports.

## Comparaison des fichiers exacts

Les coordonnées des trois copies proviennent de leurs sessions publiques
antérieures. Chaque claim vérifie l'empreinte de la cible initiale. Les réponses
206 donnent la taille totale exacte ; FFprobe analyse seulement les octets déjà
reçus, après expiration du claim, dans un conteneur UID1000 sans réseau.

| Copie S1E1 | Taille décimale | Durée | Moyenne du fichier entier | Vidéo source | Audio source / sous-titres |
| --- | ---: | ---: | ---: | --- | --- |
| EN Strng, témoin fluide précédent | 475 790 063 octets | 3 434,773 s | 1,108 Mbit/s | H.264 Main, 1918×802, 23,976 i/s | AAC-LC 5.1, une piste ASS |
| FR 4K Strng | 3 480 858 589 octets | 3 434,816 s | 8,107 Mbit/s | H.264 High, 3840×2160, 30 i/s | Deux pistes AAC-LC 7.1, aucun sous-titre |
| MAX OTT, choix précédemment libellé français | 4 679 005 577 octets | 3 434,752 s | 10,898 Mbit/s | H.264 High, 1918×802, 23,976 i/s | E-AC-3 5.1, 42 pistes SRT |

La copie MAX a la même résolution que le témoin anglais et près de dix fois
son volume. La seule résolution ou le nom H.264 ne permettent donc pas de
prévoir le besoin de réception. Les moyennes ci-dessus incluent le conteneur et
toutes les pistes ; elles ne sont pas un besoin instantané mesuré de la vidéo.
Les formats audio des copies lentes diffèrent : ces attentes de réception ne
constituent pas une nouvelle preuve de régression AAC.

**Limite du libellé MAX :** l'unique piste audio de l'en-tête porte le tag `eng`,
alors que le choix du catalogue était libellé français. Ce relevé technique ne
vaut pas confirmation audible et ne publie aucune langue. Les anciens tableaux
FR/EN identifiaient les choix du catalogue. Aucun changement de variante ou de
piste n'est effectué en réponse à cette divergence.

## Méthode de transfert indépendante

Onze lectures nouvelles, séquentielles, entre **14:11 et 14:32 Paris** (UTC+2),
avec un seul compte fournisseur utilisé à la fois. API ordinaire `mode:direct`,
heartbeat indépendant toutes les 0,5 s avec timeout 1 s et arrêt en cas d'échec,
grâce de takeover vérifiée, expiration ordinaire à la fin. Aucun bail forcé.
Les demandes utilisent le même proxy configuré, slot HTTP 1, port inchangé,
sans rotation d'IP. Les tâches de fond restent actives sous leurs gardes.

Les lectures courtes demandent les octets 0–16 777 215, plafond 16 Mio et 90 s.
Un essai HTTP forward retire seulement CONNECT dans l'invocation de diagnostic,
sans modifier la configuration Norva. Deux lectures continues demandent le
fichier entier mais leur consommateur local est borné à 16 puis 64 Mio et 90 s.
Atteindre 16 Mio provoque une fermeture intentionnelle, pas une fin de fichier.
Aucun film entier n'est téléchargé ni conservé.

Le premier opérateur hérité utilisait `Mozilla/5.0` en l'absence d'environnement
explicite. Ce fallback diffère de celui du Gateway, qui utilise Chrome126/Norva1.0.
Les trois premières mesures ne sont donc pas des reproductions exactes des
en-têtes par défaut du produit. Ce défaut du banc est identifié et les contrôles
suivants utilisent le défaut réellement présent dans le code déployé. Une
mesure anglaise minimale supplémentaire conserve la comparaison. Le réglage
visible du navigateur est « Navigateur (par défaut) » ; il n'est pas modifié.

| Début Paris | Copie / requête | Agent HTTP | Reçu | Durée | Débit moyen observé |
| --- | --- | --- | ---: | ---: | ---: |
| 14:11:26 | EN Strng, plage courte CONNECT | Minimal hérité | 4 476 504 o, partiel | 90,000 s | 0,398 Mbit/s |
| 14:13:06 | FR 4K Strng, plage courte CONNECT | Minimal hérité | 4 176 038 o, partiel | 90,013 s | 0,371 Mbit/s |
| 14:15:00 | MAX, plage courte CONNECT | Minimal hérité | 7 827 353 o, partiel | 90,009 s | 0,696 Mbit/s |
| 14:17:25 | EN Strng, plage courte CONNECT | Défaut Gateway | 16 Mio | 12,560 s | 10,686 Mbit/s |
| 14:19:25 | EN Strng, plage courte CONNECT | Minimal hérité | 16 Mio | 34,122 s | 3,934 Mbit/s |
| 14:20:20 | FR 4K Strng, plage courte CONNECT | Défaut Gateway | 16 Mio | 49,608 s | 2,706 Mbit/s |
| 14:21:45 | MAX, plage courte CONNECT | Défaut Gateway | 13 050 585 o, partiel | 90,068 s | 1,159 Mbit/s |
| 14:24:07 | MAX, plage courte forward | Défaut Gateway | 16 Mio | 68,794 s | 1,951 Mbit/s |
| 14:28:22 | MAX, requête continue / cap 16 Mio | Défaut Gateway | 16 Mio, arrêt volontaire | 4,609 s | 29,118 Mbit/s |
| 14:29:24 | MAX, contrôle plage courte CONNECT | Défaut Gateway | 15 539 737 o, partiel | 90,024 s | 1,381 Mbit/s |
| 14:31:14 | MAX, requête continue / cap 64 Mio | Défaut Gateway | 20 965 173 o, partiel | 90,021 s | 1,863 Mbit/s |

Tous les essais atteignent HTTP206. Les lectures partielles se terminent au
budget de 90 s (curl28) : ne pas les présenter comme des plages complètes.
L'arrêt volontaire de la lecture continue de 16 Mio retourne SIGTERM après
atteinte du plafond local ; son JSON le distingue d'un timeout.

### Ce que permettent les comparaisons

- Les deux plages anglaises complètes ont les mêmes octets, SHA-256
  `3fd2e498446f9328b00ea27d919ce663d85da4fa589226fb1589fbb06644bdc8`.
  L'agent et l'heure changent ensemble ; cela ne prouve pas que l'agent explique
  le gain. L'agent minimal lui-même passe de 90 s partielles à 34,1 s complètes.
- Les 16 Mio MAX complets en forward et en lecture continue ont le même SHA-256
  `77c00910bd2b2c4b2ba6d57d145fb853540006a701991618c884075a43437f94`.
  Les préfixes partiels comparables concordent également.
- La pointe de 29,1 Mbit/s ne valide pas une amélioration durable. Le contrôle
  continu suivant atteint les 16 Mio seulement vers 61 s. Entre deux relevés
  à 61,067 et 89,738 s, 4 042 752 octets arrivent, soit **1,128 Mbit/s**.
- Le contrôle court et le dernier contrôle continu redirigent vers le même
  nom d'hôte (comparaison d'empreintes). Leurs URL complètes diffèrent ; aucun
  serveur physique, motif de régulation ou cause interne n'est attribué.
- Le code Norva utilise déjà une réponse continue pour le MKV depuis zéro
  (`openBoundedVodInputAttempt`). Remplacer ses requêtes par cette forme n'est
  donc pas un correctif manquant démontré. Le test long ne valide pas non plus
  un changement de mode du proxy ou d'agent HTTP.

Les lectures sont successives, à des heures différentes, et ne forment pas un
A/B aléatoire isolant un seul facteur. Les retours de débit restent variables.
Les échantillons noyau relèvent des files de réception nulles aux instants
contrôlés des premières lectures et peu de CPU curl ; ils ne prouvent pas
l'état permanent du réseau ni la cause distante. FFprobe ne décode pas tout
le média et ne valide ni l'écoute ni la continuité d'un épisode.

## Contrôle public du trajet et support

À **14:16:58 Paris**, une cible publique de 10 000 000 octets donne 0,334 s
en direct et 3,574 s via le proxy configuré, soit 239,84 et 22,38 Mbit/s.
Aucune lecture VOD concurrente n'est présente dans le snapshot préalable.
Ce résultat montre que le trajet via le relais peut dépasser le débit moyen
des copies lourdes vers cette cible à cet instant. Il ne mesure pas sa capacité
vers les destinations VOD et ne départage pas livraison et routage/relais.

Console NodeMaven consultée sans mutation : relais actif, dernier complément
du 8 octobre vu, aucune nouvelle cause ou intervention technique confirmée.
Aucun nouveau message de support, achat, remplacement d'IP ou changement de
port n'est envoyé pendant ce contrôle.

## Compression évoquée par l'utilisateur

Réencoder côté serveur peut diminuer le volume envoyé au lecteur. Le parcours
Norva le fait déjà dans certains cas, mais doit recevoir les octets originaux
auparavant : cela ne corrige pas une entrée trop lente. Conserver une version
compressée préparée à l'avance pourrait aider les lectures suivantes, avec
stockage, traitement et rattachement exact au fichier, aux pistes et aux droits
courants. Aucun tel prétraitement global n'est lancé ; aucun gain de ce type
n'est revendiqué dans ce relevé.

## Clôture et suite

À **14:33:42 Paris**, les deux Gateways sont sains, zéro session/pompe et pool
0/8, zéro claim vivant du propriétaire. Image PR738
`sha256:ea9594c68c27ded59edd2c1748893f758820705ab74eb521add99411ad702c40`,
environnements et dates de démarrage inchangés. Admissions ouvertes, cron,
worker et dispatcher permanents actifs. Chaque opérateur a fermé son claim,
aucun heartbeat n'a échoué, zéro fichier média/header/log curl temporaire reste.
Les conteneurs FFprobe isolés sont retirés à leur sortie.

Les onglets temporaires sont fermés, filtre Strng restauré, aucune nouvelle
lecture navigateur lancée. Les cinq checks de PR739 sont désormais réussis,
paquets compris. Ce changement ajoute uniquement les preuves ; aucun test
applicatif nouveau, déploiement, seuil, codec, limite ou garde modifié.

Le besoin de réception des copies lourdes et sa variabilité sont mieux établis.
La cause interne de cette variabilité reste ouverte. Le défaut Norva de
qualification de rafale déjà corrigé n'augmente pas le débit source ; son coût
sur le démarrage sain reste documenté. Aucun nouveau correctif fiable ni
lecture rapide et continue des copies lentes n'est déclaré.

Reçus sous `.codex-artifacts/vod-fluidity-difference-20261009/`, synthèse sûre
dans le JSON associé. Les marqueurs opérateur sont consommés et ne doivent pas
être rejoués automatiquement.
