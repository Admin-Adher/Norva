# Reprise récente : conservation des entrées utiles (7 octobre 2026)

## Motivation et périmètre

Le pilote précédent est arrêté après première image à 5,618 s puis épuisement du cache à environ 52 s et échec. À la demande explicite de poursuivre, PR682 conserve jusqu'à 8 Mio d'entrées déjà reçues avec la fenêtre HLS privée. Même propriétaire/source/génération/fichier/profil/pistes, même preuve fraîche partielle (quatre prélèvements), même TTL dix minutes. Aucune identité forte inventée. Le total mémoire et les réservations incluent les octets supplémentaires. Les données du début sont conservées malgré l'éviction LRU du broker. Aucune lecture ajoutée à la sortie. Seul le broker neuf de continuation est alimenté, après acquisition de la preuve ; refus sur cible différente ou broker déjà utilisé.

Code 9e81e508cb040bcc75139b0a477ce7a9bfc14b53, PR682 fusion a657188ec37d50af4d37c346504ef6816c505ad4. Contrats cloud réussis avant fusion ; constructions de paquets encore en cours au relevé de fusion. 189 tests ciblés réussis / cinq ignorés, puis 17 tests relus après borne finale de 8 Mio (ensembles recoupés). Un test HTTP réel vérifie zéro nouvelle ouverture pour les plages conservées, lecture des zones manquantes et une connexion maximum. Canary réel sous UID1000/GPU/réseau none : treize tests réussis, zéro média fournisseur, arrêté et retiré.

Image candidate sha256:18d985dc3471474651559152df2affdea547c97dcab8f0a63d3c7cad8e51f8d2 ; arbre 5a599a07f72457f06a271f6206eb2419803530e0ce2f81009893bc947cf8d03d ; 83 fichiers conservés, trois changés, 86 au total. Aucun changement Edge/Web/Android supplémentaire.

## Incident opérateur conservé

Premier apply arrêté avant tout remplacement : collision du nom de sauvegarde avec le conteneur conservé lors de la désactivation pilote. Pause 22:17:47.984680–22:17:59.253003 UTC, restoration complète prouvée, aucun bail forcé. Le conteneur sauvegardé est conservé. Deuxième opérateur distinct, marqueur apply2, nom de sauvegarde unique ; ne pas rejouer apply ou apply2.

## Mesures réelles

Les heures ci-dessous sont UTC le 6 octobre (Paris : 7 octobre, UTC +2 h). Le pilote est actif uniquement pour Adrien ; ce n'est pas une généralisation à tous les comptes ou formats.

| Copie et parcours | Première image | Continuation et observation |
|---|---:|---|
| Le Robot Sauvage, MAX OTT MP4, reprise normale à 405 s | 34,651 s | Serveur 31,870 s, un FFmpeg ; capture à la sortie ordinaire |
| Même copie, reprise depuis cache à 444 s | **6,884 s** | Validation 4,781 s ; réserve 49 s ; continuation prête en 5,986 s ; progression jusqu'à 140,694 s relatives |
| Même copie, seconde reprise depuis cache à 581 s | **6,438 s** | Validation 4,094 s ; réserve 40 s ; continuation prête en 10,009 s ; progression jusqu'à 81,202 s relatives |
| Conclave, Dino MKV FR, reprise à 564 s | 24,484 s | Cache refusé pour cible différente ; démarrage normal réussi, progression jusqu'à 196,239 s relatives |

Les positions diffèrent : ce n'est pas un benchmark à position constante. Les deux reprises du Robot dépassent réellement le bord du cache, avec paused=false, readyState=4, erreur DOM nulle aux observations. Première reprise : 57,132 s après la frontière vers 51,989 s, puis 97,234 et 140,694 s. Deuxième : 53,540 puis 81,202 s après une frontière vers 42 s. Les compteurs d'images du navigateur ne sont pas disponibles ; ces observations ne prouvent pas l'absence de toute micro-saccade ou de tout défaut audible.

Chaque reprise du Robot réutilise **8 388 608 octets** d'entrée après les quatre prélèvements frais. Le premier GET de continuation du premier hit commence directement à l'octet 93 935 156 ; pas de relecture distante du début observée. Un seul FFmpeg par reprise, aucune bascule de transport. La source est toujours la même copie exacte, taille 1 118 403 839. AAC-LC stéréo 48 kHz et H264 High dans les sorties. Un segment local de deux secondes contient 48 images décodées, intervalle maximal 0,041667 s, zéro intervalle >100 ms et zéro diagnostic : preuve locale bornée, pas certification du film entier. Capture : `robot-after-splice.png`, à environ 97 s relatives.

### Conclave : rejet explicite et repli fonctionnel

Une capture complète a bien été conservée après 65,794 s de lecture, sous-titres compris. À la reprise, les quatre échantillons et la taille correspondent, mais l'empreinte normalisée de destination diffère (`target-changed`, validation 4,147 s). Le cache est invalidé puis le broker indexé normal fonctionne. PR680 est ainsi vérifiée aussi sur un rejet réel, sans l'ancien gateway_502. Le code de normalisation exclut déjà les valeurs de query et conserve schéma/hôte/chemin/noms de paramètres. Les seules empreintes conservées ne permettent pas d'attribuer le changement à une signature de chemin ou à un autre serveur. Aucun assouplissement de cette vérification n'a été appliqué.

### Série et saut hors cache

Breaking Bad S1 E3, MAX OTT MKV : trois pistes audio et deux sous-titres conservés. Première reprise normale à 150 s : TTFF 17,304 s, lecture à 22:31:32.727. Le profil courant a acquis 855 028 532 octets par le GET conservé (`fileSizeDiscoveredFromPlaybackGet=true`) ; aucune sonde supplémentaire de taille. Le graphe multipiste reste exclu du cache récent.

Saut important : session à 22:32:53.446, entrée 1435 s et position effective 1450 s après preroll. Première image à 22:33:13.572, TTFF 23,957 s ; lecture effective seulement à 22:33:35.103, soit 41,657 s après création de session. Ne pas confondre première image et départ. La réserve ordinaire attend une production suffisante, politique `encode-rate-below-minimum` avec mesure initiale 0,668x. Aucun seuil abaissé. Horloge ensuite 19,676 à 22:33:40.246, 68,667 à 22:34:29.237 et 124,395 à 22:35:24.965, readyState=4, paused=false, erreur nulle : environ 109 s de lecture progressive après le démarrage. Sortie normale vers Séries.

Sortie audio locale AAC-LC 48 kHz stéréo. Le premier diagnostic d'images sélectionnait le fichier audio et retournait zéro image : il ne constituait pas une preuve vidéo. Après sélection du segment vidéo séparé, 48 images, intervalle maximal 0,042 s, zéro intervalle >100 ms et zéro diagnostic. Toujours un segment de deux secondes seulement. Aucune acceptation sonore humaine nouvelle revendiquée.

### État final

Deuxième pause : 22:18:31.241491–22:18:52.126996 UTC, drainage naturel, aucun bail forcé. Gateways démarrés à 22:18:47.858896357 et 22:18:50.4228256. Santé, configuration et 86 empreintes vérifiées à 22:19:15.374984. Edge inchangés, admissions/cron/worker restaurés, dispatcher conservé. Les cinq checks finaux PR682 réussissent, paquets Android Phone/TV/Windows compris. Aucun nouveau changement WebView ou natif ; la matrice PR681 reste la preuve de ces chemins, pas une certification de décodage TV.

À 22:35:31.707 UTC, les deux Gateways sont sains et sans session active ; pilote restreint toujours actif. Pas de nouvelle lecture, admission de campagne, automatisation Codex ou changement de route. Le défaut de continuation observé est corrigé et deux passages réels du bord du cache réussissent. L'accélération demeure conditionnelle : Conclave ne bénéficie pas du hit et les multipistes restent en lecture normale, avec des délais encore mesurables. Aucune affirmation de réparation de toutes les VOD.

La taille manquante dans le profil reste récupérable via le GET ordinaire de lecture lorsqu'il livre une longueur exacte ; aucune estimation n'est utilisée. Le Robot avait déjà sa taille exacte : il ne prouve pas ce cas manquant. Multipistes audio et graphes incomplets restent exclus du cache récent. Les TTL, plafonds mémoire, gardes de lecture, liaisons et preuves partielles décrits au rapport précédent restent inchangés.

Reçus : `.codex-artifacts/recent-resume-input-20261007/` (CI, canary, deployment2, post-deployment2, capture, observations) et `.codex-artifacts/recent-resume-integration-20261006/input-*.safe.json` (audits de sessions, caches, sorties locales). Aucun accès, URL fournisseur, identifiant ou transcript publié.
