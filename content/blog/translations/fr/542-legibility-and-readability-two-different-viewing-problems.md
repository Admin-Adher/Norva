---
language: "fr"
source_slug: "legibility-and-readability-two-different-viewing-problems"
source_sha256: "1b55217a33e5761ed80d94c9865abae96810f3ab7ef102102082a65f06d9dd9b"
title: "Lisibilité visuelle et facilité de lecture : deux problèmes distincts"
seo_title: "Lisibilité et compréhension : deux exemples multimédias illustrés"
meta_description: "Distinguez reconnaître un libellé et le comprendre. Deux exemples contrôlés et une tâche reproductible aident à décrire les obstacles sur téléphone ou TV."
excerpt: "Une distinction par les tâches entre reconnaître caractères et commandes, et comprendre efficacement mots, hiérarchie, libellés et disposition."
topic_cluster: "Confort visuel et accessibilité"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Lisibilité visuelle et facilité de lecture : deux problèmes distincts

> **En bref :** La lisibilité visuelle (« legibility ») concerne la reconnaissance des caractères individuels d’un texte. La facilité de lecture (« readability ») concerne l’aisance avec laquelle on lit et comprend ce texte. Dans une interface multimédia, cette distinction pratique sépare la reconnaissance des libellés et des états de commande de la compréhension de leur regroupement et de la tâche. Des lettres nettes ne garantissent pas une décision claire ; une disposition cohérente peut contenir du texte difficile à distinguer.

Un mauvais diagnostic mène à des corrections peu efficaces. Agrandir le texte peut améliorer sa reconnaissance, mais provoquer des coupures qui gênent la lecture ; simplifier les libellés peut faciliter le balayage sans corriger un contraste faible.

## Voir la différence avec les mêmes mots

Comparez d’abord les deux versions de **« Episode 18 »** (Épisode 18) ci-dessous. Les mots, la police, la taille et le fond sont identiques ; seul le contraste du texte change. La question est : « Puis-je identifier correctement le numéro ? ». Cela isole un obstacle possible à la reconnaissance. L’exemple ne mesure pas votre vitesse de lecture et ne reproduit pas un environnement réel de visionnage.

Comparez ensuite **« Audio English Subtitles Off »** (Audio Anglais Sous-titres Désactivés) aux mêmes mots disposés sur deux lignes. Chaque mot reste clair, mais le regroupement change. Demandez : « English désigne-t-il le réglage audio ou celui des sous-titres ? ». La tâche consiste désormais à associer des libellés à des valeurs, pas à reconnaître des lettres.

![Une paire de contraste répète Episode 18 en texte atténué puis lumineux. Une paire de regroupement montre Audio English Subtitles Off sur une ligne, puis Audio: English et Subtitles: Off avec les paires libellé-valeur alignées.](/assets/blog/legibility-readability-paired-example.svg "Exemples explicatifs originaux, pas des captures de l’interface Norva. Le texte est repris dans l’article pour que l’image ne soit pas le seul moyen de comprendre les exemples.")

La seconde disposition est une piste d’amélioration, pas une solution dont la supériorité a été mesurée. Une autre langue, une valeur plus longue ou un écran plus étroit peut changer le résultat. Les recommandations d’accessibilité cognitive du W3C encouragent des regroupements et espacements clairs ; appliquer ces principes demande toujours de tester la tâche réelle.

## Tester directement la lisibilité visuelle

Demandez au spectateur d’identifier :

- des lettres ou chiffres similaires ;
- le sens d’une icône avec son libellé ;
- une commande ayant le focus par rapport à une commande sélectionnée ;
- un état actif par rapport à un état indisponible ;
- les métadonnées à distance normale ;
- la ponctuation des sous-titres et les marques de locuteur.

Notez les erreurs et l’effort, pas seulement le fait que le spectateur finisse par répondre.

## Tester la facilité de lecture par des tâches

Demandez au spectateur de :

- parcourir une ligne et choisir un titre ;
- comprendre un groupe de filtres ;
- lire un résumé et des métadonnées ;
- comparer des versions ;
- parcourir une boîte de dialogue et confirmer l’action prévue ;
- revenir au contexte précédent.

Une tâche révèle les problèmes de hiérarchie, regroupement, formulation, densité et séquence.

## Utiliser cette fiche de diagnostic à deux niveaux

| Niveau | Test | Résultat | Obstacle | Variable candidate |
|---|---|---|---|---|
| Lisibilité visuelle | Identifier les caractères/l’état de commande | Réussite/problème | Taille, contraste, forme, focus | Un facteur |
| Facilité de lecture | Terminer la tâche de navigation/lecture | Réussite/problème | Densité, hiérarchie, formulation, redistribution du contenu | Un facteur |

Retestez une variable candidate à la fois.

## Facteurs courants de lisibilité visuelle

La taille des caractères, leur forme, leur graisse, l’espacement, le contraste, les reflets, la distance, le traitement des contours et le rendu de l’écran peuvent affecter la reconnaissance. Des états distingués uniquement par la couleur peuvent rendre les commandes indiscernables même si le texte se lit.

Utilisez l’environnement réel plutôt qu’une capture agrandie.

## Facteurs courants de facilité de lecture

Des libellés longs, des métadonnées répétées, des titres peu marqués, une terminologie incohérente, des commandes serrées, un mauvais regroupement, un ordre de focus inattendu et une redistribution défaillante peuvent rendre l’interface difficile à comprendre.

La facilité de lecture dépend de la langue et de la tâche. Faites participer des utilisateurs maîtrisant les langues pour les contenus multilingues.

## Tester leurs interactions

Augmentez la taille du texte d’un cran pris en charge. Si les caractères deviennent plus clairs mais que les commandes se chevauchent ou que du contenu disparaît, l’amélioration de la reconnaissance a révélé un obstacle de redistribution. Notez le réglage et l’élément manquant ou superposé plutôt que d’annuler le réglage de l’utilisateur et de déclarer le problème résolu.

Comparez avec le même titre, la même langue, la même tâche, la même fenêtre d’affichage et le même mode de saisie. Demandez d’abord d’identifier un libellé ou état précis, puis de l’utiliser pour terminer la tâche. Mesurez le temps d’identification seulement si cela est utile et associez-le à l’explication du spectateur. Une réponse devinée rapidement ne prouve pas que l’élément était clair. Si un changement améliore la reconnaissance mais augmente les erreurs de navigation, documentez les deux résultats plutôt que de les réduire à une seule réussite ou un seul échec.

Pour les icônes, testez d’abord le symbole avec son libellé visible, avant de juger l’icône seule. L’habitude peut rendre un symbole ambigu évident pour un évaluateur expérimenté. Un utilisateur débutant ou occasionnel peut s’appuyer sur le libellé, la position et la hiérarchie environnante.

## Inclure l’environnement

Reflets, distance, éclairage et angle de l’écran peuvent réduire la lisibilité apparente et accroître l’effort de lecture. Utilisez [le guide d’ergonomie des interfaces TV](/blog/tv-interface-ergonomics-guide/) pour intégrer distance de visionnage et méthode de saisie à la comparaison. Pour un focus peu clair, [la liste de contrôle télécommande et pavé directionnel](/blog/remote-dpad-navigation-qa/) aide à décrire son déplacement et ce qui s’est produit ensuite.

Le [guide complet du confort visuel](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/) relie ces observations au zoom, à la couleur, au focus et au mouvement.

## Éviter les conclusions médicales

Demandez ce que le spectateur peut identifier et accomplir. N’expliquez pas une difficulté par une affection supposée. Un obstacle reproductible dans une tâche permet d’agir sans diagnostic médical.

## Signaler avec précision

Indiquez le contexte, la distance, le zoom ou la mise à l’échelle, la tâche, l’élément exact, le résultat attendu, l’erreur observée, le contournement et une capture respectant la confidentialité. Remplacez « le texte est mauvais » par « l’année et la note sont indiscernables à la distance habituelle de la TV ».

Pour un signalement Norva concret, choisissez un élément d’une source compatible que vous possédez ou êtes autorisé à utiliser. Essayez de trouver son année, puis expliquez l’action prévue sur cet écran avant de la sélectionner. Signalez ce qui a échoué : identifier l’année, comprendre une action ou suivre le focus. Notez si le problème survient sur téléphone, TV ou Web. N’incluez pas d’identifiants de compte, d’identifiants de source ou de titres multimédias privés dans une capture partagée ; reproduisez avec un contenu non sensible lorsque c’est possible.

## Erreurs courantes et limites

Évitez d’utiliser les termes indifféremment, de tester à une distance anormalement courte, de modifier police et disposition ensemble ou de supposer qu’une plus grande taille résout tous les problèmes de lecture.

Cette distinction est un outil de diagnostic pratique, pas une évaluation médicale formelle. Les commandes actuelles du produit doivent toujours être vérifiées officiellement.

## Questions fréquentes

### Un texte peut-il être visuellement lisible mais difficile à lire ?

Oui. Les caractères peuvent être clairs alors qu’une formulation dense, une hiérarchie faible ou une mauvaise disposition rend la tâche difficile.

### Une disposition compréhensible peut-elle contenir des commandes illisibles ?

Oui. La séquence peut être logique alors qu’un petit texte, un contraste faible ou un focus peu clair masque certains éléments.

### Quel problème faut-il corriger en premier ?

Traitez les obstacles bloquants à la reconnaissance et à la tâche selon leur impact, puis retestez : modifier un niveau peut affecter l’autre.

## Votre prochaine étape

[Envoyez un signalement reproductible d’obstacle à la lecture à l’assistance Norva](https://norva.tv/support) avec la fiche à deux niveaux ci-dessus. Un écran précis, une tâche et une difficulté observée donnent à l’équipe une base d’investigation sans devoir deviner la cause.

## Sources

- [W3C : rendre le contenu utilisable pour les personnes ayant des troubles cognitifs ou de l’apprentissage](https://www.w3.org/TR/coga-usable/)
- [W3C : contraste minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [Fonctionnalités de Norva](https://norva.tv/#features)
