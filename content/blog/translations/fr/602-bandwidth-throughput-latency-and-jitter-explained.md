---
language: "fr"
source_slug: "bandwidth-throughput-latency-and-jitter-explained"
source_sha256: "1187d6fb8fd3c55e3350243076646f12a474e161b0a321d197fcb55237b068da"
title: "Bande passante, débit utile, latence et gigue : les différences"
seo_title: "Bande passante, débit, latence et gigue : guide vidéo"
meta_description: "Comprenez bande passante, débit utile, latence et gigue avec un exemple réseau vidéo. Un score de débit ou un seuil universel de gigue peut induire en erreur."
excerpt: "Capacité, débit de transfert mesuré, délai et variation du délai répondent à des questions différentes. Interprétez une comparaison réseau complète avant d’attribuer les pauses à un seul chiffre."
topic_cluster: "Bases du réseau domestique pour la vidéo"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Bande passante, débit utile, latence et gigue : les différences

> **En bref :** La bande passante désigne une capacité disponible ou nominale ; le débit utile est le taux de transfert utile mesuré lors d’un test précis. La latence est un délai, tandis que la gigue décrit la variation de ce délai selon une méthode indiquée. La perte de paquets est encore une autre notion. La vidéo peut être affectée par un ou plusieurs de ces facteurs : notez donc la méthode et le trajet avant d’interpréter un nombre.

Chaque mesure offre une vue partielle. Deux tests utilisant la même unité peuvent tout de même mesurer des points de terminaison, protocoles, directions, durées, trajets ou conditions de trafic différents.

## La bande passante n’est pas un résultat de transmission

On utilise souvent la bande passante comme raccourci pour parler de vitesse, mais les indications de capacité ne disent pas quelle quantité de données applicatives est arrivée pendant un intervalle donné. Les liaisons partagées, le surcoût des protocoles, la congestion, les conditions radio, les limites de l’appareil et le point de terminaison distant peuvent réduire le débit utile observé.

Le débit annoncé d’une offre, le débit de liaison Wi-Fi, l’indication Ethernet et le débit utile d’une application sont donc des valeurs différentes. Notez celle qu’affiche un écran avant de la comparer à une autre.

## Le débit utile nécessite un contexte de test

Le débit utile est un taux de transfert mesuré. La RFC 6349 décrit un cadre de test du débit utile TCP et souligne l’importance de la méthode. Un résultat doit être accompagné du point de terminaison, de la direction, du protocole, de la durée, du nombre de connexions, de l’appareil, du trajet et de l’heure.

Le [guide des bases du réseau domestique](/blog/the-complete-guide-to-home-network-basics-for-video/) décrit le trajet entre l’appareil et la source. Un serveur de test proche ne reproduit pas tous les trajets vers les sources autorisées, et un pic bref ne doit pas être présenté comme une performance applicative soutenue.

## La latence est un délai écoulé

La latence décrit le temps que mettent des données ou une réponse à parcourir un trajet mesuré. Le délai aller simple nécessite une synchronisation des horloges et une prise en compte de l’incertitude temporelle selon la méthode de la RFC 7679 ; beaucoup d’outils grand public indiquent plutôt un aller-retour. Ces résultats ne sont pas interchangeables.

Le démarrage vidéo, les commandes, l’authentification et les requêtes de segments peuvent sembler réactifs ou retardés pour des raisons différentes. Un débit utile élevé ne signifie pas automatiquement une faible latence.

## La gigue est une variation, pas simplement de la lenteur

La RFC 3393 définit des mesures de variation du délai des paquets. Dans les outils courants, la « gigue » peut utiliser un calcul, une direction, un intervalle ou une statistique différents. Lisez la définition de l’outil avant de comparer les valeurs.

Une connexion peut avoir un débit utile moyen suffisant mais des arrivées de paquets irrégulières, ou un délai stable avec un débit soutenu insuffisant. Un aller-retour constant de 80 ms et un autre alternant entre 20 et 140 ms peuvent avoir la même moyenne tout en se comportant différemment. Cette illustration décrit la variation, pas une formule de gigue ni une limite acceptable.

## La perte de paquets est une autre dimension

La RFC 7680 définit une mesure de perte de paquets en aller simple avec une méthodologie explicite. Les résultats grand public peuvent plutôt déduire une perte de réponses manquantes, et certains appareils peuvent accorder moins de priorité au trafic de diagnostic. Un zéro affiché ne prouve pas que chaque paquet applicatif est arrivé ; un résultat non nul nécessite d’examiner sa récurrence et son périmètre.

Dans vos notes, distinguez les paquets manquants des paquets tardifs. Une pause de lecture est un symptôme visible, pas un diagnostic au niveau des paquets.

## Élément original : un dictionnaire des mesures

| Mesure | Question en langage courant | Contexte nécessaire | Ce qu’elle ne peut pas prouver seule |
|---|---|---|---|
| Bande passante/capacité | Que pourrait transporter cette liaison selon sa définition ? | Liaison, indication, direction | Transmission applicative |
| Débit utile | Quel taux de transfert utile a été mesuré ? | Point de terminaison, protocole, durée, trajet | Tous les trajets vers les sources |
| Latence | Quel délai la méthode a-t-elle observé ? | Aller simple/aller-retour, horloges, trajet | Capacité soutenue |
| Gigue | Comment le délai a-t-il varié ? | Formule, échantillon, statistique | Débit utile moyen |
| Perte | Quels paquets attendus étaient absents ? | Type de sonde, direction, intervalle | Cause exacte du problème de lecture |

Associez une unité à chaque valeur et conservez les résultats bruts lorsque la confidentialité le permet.

### Exemple détaillé : une offre rapide et une soirée irrégulière

Ce sont des **résultats pédagogiques fictifs**, pas un test de Norva ou d’une source. Un foyer dispose d’une offre annoncée à 100 Mbps. Il teste le même ordinateur portable au même emplacement Wi-Fi vers le même point de terminaison proche, avec des réglages de téléchargement identiques et trois essais de 30 secondes dans chaque période.

| Observation | Période calme | Période chargée | Interprétation |
|---|---|---|---|
| Débit utile descendant, trois essais | 82, 80, 84 Mbps | 28, 14, 31 Mbps | La médiane passe de 82 à 28 Mbps ; l’intervalle de la période chargée est de 14–31 Mbps |
| Délai aller-retour médian indiqué par l’outil, relevé dans la même condition de charge | 18 ms | 65 ms | Ce trajet de test répond plus lentement pendant la période chargée |
| Gigue affichée par l’outil, mêmes formule et réglages d’échantillonnage | 3 ms | 24 ms | Le délai varie davantage selon la définition de cet outil ; ce n’est pas une note de réussite ou d’échec |
| Vidéo autorisée pendant la période chargée | Non vérifiée | Deux pauses notées | Les pauses coïncident avec de moins bons résultats, mais le point de terminaison vidéo n’a pas été mesuré |

L’étape suivante raisonnable est de répéter à l’heure du symptôme, en ne changeant éventuellement que la connexion locale pour Ethernet si cela est pris en charge. Ce n’est **pas** d’acheter immédiatement une offre plus rapide. Même l’échantillon de 14 Mbps ne permet pas d’établir si la vidéo devrait être lue : les exigences réelles de la version, les baisses brèves, le trajet vers la source et le comportement de mise en mémoire tampon sont inconnus.

Distinguez Mbps, mégabits par seconde, de MB/s, mégaoctets par seconde : 8 Mbps équivalent à 1 MB/s avant de tenir compte de la définition du surcoût de la mesure. Les millisecondes décrivent un temps, pas un débit de données. Ces unités ne peuvent pas être comparées comme si un plus grand nombre signifiait toujours une meilleure connexion.

## Constituer un petit ensemble de mesures

Utilisez l’appareil concerné à son emplacement habituel. Notez trois échantillons espacés pendant une période calme et trois pendant la période du symptôme. Lorsque c’est sûr et pris en charge, répétez avec une autre liaison locale sans modifier le point de terminaison ni les réglages du test.

Comparez ensuite les médianes, les intervalles et la récurrence au lieu de sélectionner le meilleur nombre. Notez les téléversements simultanés, les changements du réseau maillé, l’état d’alimentation de l’appareil et la météo uniquement lorsqu’ils ont été directement observés ; n’inventez pas d’explications causales autour d’événements concomitants.

## Interpréter les combinaisons

Un faible débit utile soutenu peut vider la mémoire tampon de lecture. La variation du délai et les pertes peuvent perturber la transmission même lorsqu’un débit moyen sur une courte période paraît suffisant. Une latence élevée peut ralentir les séquences requête-réponse sans nécessairement limiter un long transfert. L’application, le comportement du transport, la conception de la mémoire tampon et la source déterminent l’impact visible.

Si la lecture continue mais que l’image est médiocre, utilisez la [comparaison de qualité d’image](/blog/the-complete-guide-to-understanding-video-quality/) au lieu de considérer le flou comme une preuve de lenteur du réseau. Norva lit des sources compatibles et autorisées ; il ne fournit pas de catalogue et ne contrôle ni votre routeur, ni le trajet vers la source, ni son encodage.

## Erreurs d’interprétation courantes

Ne comparez pas les bits aux octets, ne confondez pas débit de liaison et débit utile, ne qualifiez pas toute variation du délai de « perte de paquets » et ne traitez pas le résultat d’un seul serveur comme une garantie. Évitez de ne mesurer qu’après avoir changé simultanément de routeur, d’appareil et de source.

## Questions fréquentes

### Quelle mesure compte le plus pour la vidéo ?

Aucune mesure ne domine toujours. Le mode de transmission de la version, le trajet, l’appareil et le symptôme déterminent les mesures pertinentes.

### Le débit utile peut-il dépasser l’indication de l’offre ?

Les indications, le provisionnement, les méthodes de test, les unités et les définitions du surcoût varient. Vérifiez ce que représente chaque nombre avant de traiter une différence comme une erreur.

### Tous les outils mesurent-ils la gigue de la même façon ?

Non. Vérifiez la formule de l’outil, la direction, le type de sonde, la période d’échantillonnage et la statistique rapportée.

### Quelle gigue est acceptable pour la vidéo en streaming ?

Il n’existe pas de seuil universel en millisecondes qui certifie la lecture vidéo. La vidéo à la demande avec mémoire tampon et les appels interactifs tolèrent les délais différemment ; les outils calculent aussi la gigue différemment. Comparez des résultats répétés avec la même méthode au symptôme réel. Une limite publiée pour une application ou un protocole ne doit pas devenir une exigence générale pour Norva.

### Pourquoi la vidéo se met-elle en mémoire tampon après un bon test de débit ?

Le test peut utiliser un autre serveur, un autre trajet, un autre schéma de transfert ou une autre période. Il peut manquer des perturbations brèves, et la lecture dépend aussi de la source et de l’appareil. Notez si le délai survient avant la première image ou pendant la lecture avant de choisir le test suivant.

## Votre prochaine étape

[Associer votre symptôme de lecture à la prochaine vérification](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Dans une demande d’assistance, indiquez l’appareil, la période, la méthode de test et un symptôme reproductible, pas les identifiants de la source.

## Sources

- [RFC 6349 : test du débit utile TCP](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679 : mesure du délai aller simple](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393 : mesure de la variation du délai](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680 : mesure de perte de paquets en aller simple](https://www.rfc-editor.org/rfc/rfc7680)
