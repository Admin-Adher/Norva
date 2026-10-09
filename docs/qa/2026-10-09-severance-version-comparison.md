# Severance : comparaison des versions, 9 octobre 2026

## Périmètre et méthode

Demande : déterminer si la lenteur de la copie française Strng concerne aussi
les autres versions accessibles au même compte. Quatre essais publics nouveaux,
séquentiels, sur S1E1 depuis zéro, entre 12:48 et 13:00 Paris. Référence : essai
FR Strng de 12:31 Paris documenté dans `2026-10-09-zero-start-recovery.md`.

Les versions sont choisies explicitement dans le catalogue, puis lancées par
WatchPage avec ses claims ordinaires. Chaque session précédente est close et
son état `expired` vérifié avant le lancement suivant. Aucune réserve, limite,
route, langue, quarantaine ou configuration de production n'est modifiée. Les
tâches de fond ordinaires restent actives lors de ces quatre nouveaux essais.

La mesure « lecture » vient de `play_started` moins l'heure du clic ; la première
image est séparée. Le DOM vise le lecteur visible `#watch-video`. Les libellés
FR/EN et 4K identifient les versions proposées ; ce contrôle ne constitue pas
une nouvelle confirmation humaine de la langue audio. L'extension MP4 affichée
sur la carte de série n'est pas le format réel des épisodes : les quatre
lectures utilisent le chemin MKV borné du Gateway.

## Résultats

| Version S1E1 | Première image depuis clic | Lecture effective | Observation |
| --- | ---: | ---: | --- |
| Français Strng, référence précédente | 52,3 s | Pas commencée à 111,1 s | 14 s chargées |
| Français 4K Strng | 15,0 s | Pas commencée à 114,7 s | 26 s chargées |
| Anglais Strng | 4,9 s | 5,0 s | Plus de deux minutes continues observées |
| Français Dino | 7,5 s | Pas commencée à 117,6 s | 42 s chargées |
| Français MAX OTT | 5,4 s | 5,3 s | Interruption après environ 24 s de vidéo |

Il ne s'agit donc ni d'une seule copie touchée, ni de toutes les copies lentes.
L'alternative anglaise Strng est rapide dans cet essai. Les trois alternatives
françaises contrôlées présentent une attente excessive ou une interruption.
Les autres versions et les autres épisodes ne sont pas testés exhaustivement.

## Interprétation

Les quatre nouvelles cibles ont des identités de fichier distinctes de la
référence FR Strng. Elles utilisent le même Gateway secondaire, VAAPI et le même
slot HTTP de relais 1, avec zéro attente d'admission/verrou propriétaire relevée.
Les tailles sont 3 480 858 589 octets (FR 4K Strng), 475 790 063 (EN Strng),
1 436 474 944 (FR Dino) et 4 679 005 577 (FR MAX), contre 5 006 492 901 pour la
référence. Les besoins en débit et les caractéristiques des fichiers diffèrent ;
ce n'est pas un A/B isolant une cause unique.

L'anglais Strng avance de 23,995 à 136,576 s sur 112,560 s de temps mural,
paused=false, readyState=4, sans erreur aux quatre observations. Aucun événement
d'attente n'est présent dans la télémétrie conservée ; la pause finale à 147 s
est volontaire pour afficher les commandes et fermer la lecture. Ce contrôle
court ne certifie pas l'épisode entier ni la qualité à l'écoute.

Les pompes FR 4K Strng et FR Dino passent presque tout leur temps observé dans
`provider-read`, avec peu de temps en écriture aval. MAX démarre avec une
production initiale suffisante puis sa réserve se réduit. Ces observations ne
départagent toujours pas livraison fournisseur et relais ; elles ne justifient
pas un changement de codec, de réserve ou une substitution automatique.

## Preuves et clôture

Reçus locaux : `.codex-artifacts/severance-versions-20261009/`, notamment les
audits `*-start`, `*-progress`, `*-closed`, `browser-samples.safe.json`, les
captures et les contrôles de santé. Le JSON associé contient les temps précis,
les observations DOM et les événements agrégés, sans accès ou URL média privés.

Dernier relevé MAX à 12:59:19.271 Paris, 97,636 s après le clic : position
24,026666 s, paused=true/readyState=4/error=null, buffer [0, 32,031]. La position
est identique au relevé de 12:58:29.941, soit 49,330 s sans progression entre ces
deux mesures, sans action de pause opérateur. Le clic Retour clôt normalement
l'essai. Aucune relance automatique ou manuelle n'est ajoutée.

À 12:59:36.833 Paris, les quatre sessions sont `expired`, aucun claim vivant du
compte ; deux Gateways sains, zéro session/pompe, pool d'encodage 0/8. Images,
environnements et démarrages inchangés ; admission, cron, worker et dispatcher
actifs. Le pilote reste limité au même propriétaire. Le filtre Strng et la
copie FR Strng initiale sont restaurés, l'onglet de test est fermé, les onglets
utilisateur restent ouverts. Les lectures ont créé leur historique ordinaire.

Ce changement est documentaire uniquement. Aucun correctif applicatif ni
déploiement supplémentaire n'est revendiqué.
