---
language: "fr"
source_slug: "cold-start-or-warm-start-measure-the-right-tv-launch"
source_sha256: "1d98978ab5f697cccbc66a8ab0cd8d60492abc5f7897a76ab52c9df291edcdcb"
title: "Démarrage à froid ou à chaud : pourquoi une application TV s’ouvre différemment"
seo_title: "Démarrage d’une application TV : comparer les temps de chargement"
meta_description: "Pourquoi une application TV s’ouvre-t-elle vite puis lentement ? Distinguez démarrage à froid, relance, première image et navigation utilisable avec un exemple chronométré."
excerpt: "Un retour depuis l’accueil n’est pas nécessairement un nouveau lancement. Comparez le même état initial et distinguez une image visible d’une navigation qui répond réellement."
topic_cluster: "Performances des Smart TV"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Démarrage à froid ou à chaud : pourquoi une application TV s’ouvre différemment

> **En bref :** Une application TV peut démarrer de zéro, reconstruire un écran à partir d’un état conservé ou revenir avec une grande partie de son interface encore en mémoire. Ce sont des tâches différentes. Comparez des conditions initiales identiques et chronométrez à la fois la première image de l’application et la navigation utilisable à la télécommande. Voir un logo ne prouve pas que le catalogue est prêt.

Ce guide s’adresse au spectateur qui cherche à décrire des temps d’ouverture irréguliers, pas à noter un téléviseur selon un objectif universel de rapidité. Les systèmes d’exploitation TV peuvent gérer les processus de façon invisible. Lorsque vous ne pouvez pas vérifier l’état interne, notez ce que vous avez fait au lieu d’inventer une qualification technique.

## Définir quatre états

Android documente les démarrages **cold**, **warm** et **hot**. Un démarrage cold crée l’application de zéro ; un démarrage warm effectue une partie du travail de démarrage à partir d’un état conservé ; un démarrage hot remet au premier plan une activité conservée. Revisiter un écran au sein de l’application est une observation distincte de navigation, pas une quatrième catégorie de démarrage Android.

Pour un journal TV pratique, distinguez ces quatre situations observables :

| Situation à noter | Ce qu’elle indique | Ce qui reste inconnu |
|---|---|---|
| Lancement après un redémarrage officiel du téléviseur | Le système a redémarré avant l’ouverture de l’application | Part du délai due à la disponibilité du système ou du réseau |
| Relance après avoir quitté avec Retour | L’application a été quittée avec sa commande normale | Conservation éventuelle de son processus ou de son écran |
| Retour après avoir appuyé sur Accueil et attendu 30 secondes | Une courte période en arrière-plan a eu lieu | Maintien éventuel de l’application en vie par le système |
| Retour à Films depuis un autre écran de l’application | La navigation est restée dans l’application | Ressources du catalogue ou visuels réutilisés |

Le [guide par couches](/blog/smart-tv-media-app-performance-a-layer-by-layer-guide/) distingue le cycle de vie du réseau et du rendu.

## Définir deux points d’arrivée

La première image visible peut apparaître avant que le focus fonctionne, que les visuels se chargent ou que la navigation réponde. Notez séparément « première image de l’application » et « écran utilisable ». Ajoutez « visuels stabilisés » uniquement si c’est la question étudiée. Les mesures TTID et TTFD d’Android distinguent l’affichage initial de la disponibilité complète, mais votre chronométrage manuel entre la télécommande et l’écran n’est pas automatiquement l’une de ces mesures instrumentées.

N’arrêtez pas le chronomètre au jalon le plus favorable.

## Fixer le contexte

Notez le modèle de téléviseur, le système d’exploitation, la version de l’application, la source d’entrée, l’état d’alimentation, la sortie, le trajet filaire ou Wi-Fi, l’heure, une description de session préservant la confidentialité du compte, la disponibilité de la source et l’activité en arrière-plan. Gardez des états du réseau et de la source comparables.

Un chronométrage manuel doit préciser l’incertitude liée au temps de réaction.

## Élément original : un protocole de lancement

Les valeurs suivantes sont des **exemples pédagogiques fictifs, pas des mesures de Norva**. Un spectateur utilise un téléviseur, une version d’application, un compte et un catalogue. Chaque essai commence à l’appui sur la télécommande qui ouvre l’application. « Utilisable » signifie que l’écran prévu est visible, qu’un déplacement à la croix directionnelle répond et qu’aucune surcouche bloquante ne subsiste. Les temps sont exprimés en secondes depuis ce même événement de départ.

| Essai | Préparation observée | Première image de l’application | Navigation utilisable | Visuels stabilisés |
|---|---|---|---|---|
| A | Redémarrage officiel ; accueil TV et réseau prêts | 1.8 s | 4.6 s | 6.2 s |
| B | Accueil, attente de 30 secondes, retour | 0.7 s | 1.2 s | 1.9 s |
| C | Même retour après une courte absence | 0.8 s | 1.4 s | 2.0 s |
| D | Répétition de la préparation utilisée pour A | 1.9 s | 4.4 s | 6.0 s |

Les deux observations après redémarrage atteignent une navigation utilisable en 4.4–4.6 secondes, tandis que les retours après une courte absence prennent 1.2–1.4 secondes. Cela suggère une différence reproductible entre ces préparations. Cela **n’établit pas** le temps gagné grâce à un cache particulier, ne prouve pas un état de processus warm ou hot et ne prédit pas le résultat d’un autre téléviseur.

L’observation utile pour l’assistance est l’écart entre la première image et la navigation réactive dans A et D. Dire que l’application est « prête en 1.8 seconde » masquerait cet écart. Le chronométrage manuel comprend aussi l’erreur de réaction de l’observateur : n’interprétez pas un dixième de seconde d’écart comme une amélioration de performance sans mesure plus précise.

## Établir un état à froid en sécurité

Utilisez uniquement les consignes officielles d’arrêt d’application, de redémarrage du téléviseur ou d’alimentation. Ne débranchez pas le courant, n’utilisez pas les menus de maintenance et n’effacez pas les données simplement pour créer un état à froid. Si la plateforme ne permet pas de vérifier que l’application ne tourne pas, appelez-le « lancement après redémarrage ».

La sécurité et l’intégrité de l’appareil priment sur la pureté de l’expérience.

## Établir un état de démarrage intermédiaire

Aucune séquence générique Accueil ou Retour ne garantit un état de processus warm. Si vous ne pouvez pas le vérifier avec l’instrumentation de la plateforme, notez un **retour après une courte absence** : atteignez le même écran, quittez avec la commande documentée, attendez un intervalle fixe et revenez. Notez si l’écran, le focus ou les visuels ont persisté sans attribuer de qualification non vérifiée au cycle de vie.

L’état conservé peut changer entre les essais : gardez donc les rechargements inattendus dans le relevé.

## Inverser l’ordre et laisser un temps de repos

Utilisez, lorsque c’est possible, l’ordre après redémarrage, retour court, retour court, après redémarrage, avec des intervalles de repos fixes. Inverser l’ordre peut révéler un schéma compatible avec des changements de cache, de température, de réseau ou de source ; cela n’identifie pas la cause. Ne réalisez pas des dizaines de lancements : définissez à l’avance un petit nombre d’essais.

L’instrumentation permet d’établir plus précisément l’état du processus et les limites du chronométrage, mais un spectateur n’a besoin ni du mode développeur ni de journaux privés pour signaler un délai visible reproductible.

## Interpréter les différences

Un démarrage warm plus rapide qu’un cold peut refléter un état conservé ou des ressources en cache, mais ne quantifie pas le rôle de chaque cache. Un warm se comportant comme un cold peut refléter un arrêt de l’application, une mise à jour, une pression mémoire ou un choix d’implémentation.

Notez les pertes répétées de position ou les rechargements inattendus comme des observations, pas comme la preuve que le téléviseur a besoin de plus de mémoire. Si seul le passage du visionnage entre écrans semble lent, identifiez d’abord le mécanisme dans le [guide du transfert de session, de la recopie d’écran et de la diffusion](/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/).

## Comparer après une modification

Après une mise à jour de l’application, répétez le même protocole en précisant le contexte de version. Conservez les notes avant/après au lieu de vous fier à votre mémoire. Ne comparez pas un ancien lancement après redémarrage à un nouveau retour après une courte absence.

Le démarrage de Norva sur TV dépend de l’appareil, de la version et de la source connectée. Norva est un lecteur pour des médias compatibles que vous êtes autorisé à utiliser, pas un catalogue inclus. Ces exemples ne certifient ni sa rapidité de lancement ni ses performances de lecture.

## Contrôler l’ordre des essais et la disponibilité

Les essais à froid ont souvent lieu en premier : la maintenance au démarrage, la reconnexion réseau ou la préparation de l’observateur peuvent donc les pénaliser injustement. Alternez l’ordre entre les sessions lorsque la plateforme permet un état documenté et attendez le même intervalle fixe avant chaque lancement. Notez si l’accueil, la télécommande, le réseau et la sortie étaient déjà prêts.

Définissez « utilisable » avant de chronométrer : par exemple, l’écran prévu est visible, le focus répond une fois et aucune surcouche bloquante ne subsiste. N’arrêtez pas la mesure à la seule apparition d’un logo. Ne rapportez la médiane qu’avec les valeurs individuelles et l’intervalle ; un résumé unique peut masquer un lancement bloqué ou échoué plus important qu’une petite différence moyenne.

## Questions fréquentes

### Allumer le téléviseur équivaut-il à un démarrage à froid de l’application ?

Non. Cela inclut le démarrage du système et peut restaurer différemment l’état de l’application.

### Combien d’essais faut-il ?

Utilisez plusieurs essais définis à l’avance, suffisamment pour montrer l’intervalle sans solliciter excessivement l’appareil ou la source.

### Le chargement complet des visuels doit-il définir la fin du lancement ?

Seulement si la disponibilité des visuels est la tâche étudiée ; gardez séparés la première image et le focus utilisable.

## Votre prochaine étape

[Obtenir de l’aide pour un problème de lancement TV reproductible](https://norva.tv/support). Indiquez le modèle de téléviseur, les versions du système et de l’application, les étapes de préparation, l’écran attendu et les deux jalons de temps. Excluez les identifiants de compte, adresses de source et informations de connexion des captures d’écran.

## Sources

- [Android Developers : temps de démarrage des applications](https://developer.android.com/topic/performance/vitals/launch-time)
- [Aide Google TV : corriger les lenteurs d’un appareil Google TV](https://support.google.com/googletv/answer/12364830?hl=en)
