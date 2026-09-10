---
language: "fr"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Volume et sonie : pourquoi ce n’est pas la même chose"
seo_title: "Volume et sonie : comprendre la différence"
meta_description: "Un curseur de volume ne mesure pas la sonie. Comparez gain, sonie du programme, crêtes, dynamique et changements de sortie sans tirer de conclusions d’un seul chiffre."
excerpt: "Un même réglage de volume peut produire des niveaux d’écoute différents. Distinguez gain, sonie du programme, crêtes et chaîne de sortie avec un calcul détaillé et une liste de comparaison."
topic_cluster: "Comprendre la qualité audio"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Volume et sonie : pourquoi ce n’est pas la même chose

> **En bref :** Une commande de volume modifie le gain à un point de la chaîne de lecture. La sonie désigne la force perçue d’un son ; les mesures de sonie d’un programme l’estiment à partir du signal audio selon une méthode définie. L’enregistrement, le mixage et le traitement affectent ce signal, tandis que l’appareil de sortie et l’environnement d’écoute influencent aussi ce que vous entendez. Une même position du curseur ne garantit pas un même niveau d’écoute.

Si un film paraît beaucoup plus fort qu’un autre sans que vous ayez touché la télécommande, la commande de volume n’a pas nécessairement changé. Vous entendez peut-être un autre mixage, une autre piste ou un autre mode de traitement. Commencez par distinguer le réglage de la commande du signal audio sur lequel elle agit, au lieu de traiter le nombre affiché comme une mesure de l’expérience complète.

## Repérer chaque étage de gain

Le gain consiste à multiplier l’amplitude du signal à un étage précis. Un gain numérique simple multiplie chaque échantillon par une valeur ; [la documentation GainNode de MDN](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) présente ce principe. Un curseur grand public n’affiche pas nécessairement ce multiplicateur directement, et un réglage sur « 50 » n’est ni un niveau acoustique universel ni la garantie d’une sonie divisée par deux.

Notez les commandes qui s’appliquent réellement : volume du lecteur, niveau multimédia du système d’exploitation, niveau du téléviseur ou du récepteur, commandes du casque et éventuel réglage par piste. Certaines commandes peuvent être liées, tandis que d’autres étages peuvent être fixes ou contournés pour la chaîne choisie. Vérifiez quel appareil produit le son avant de modifier une commande à la fois.

## Comprendre la sonie du programme

La recommandation [UIT-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) définit des algorithmes de mesure de la sonie des programmes et des crêtes vraies. Une mesure de sonie d’un programme décrit un signal audio selon cette méthode ; elle ne mesure pas directement la pression acoustique à vos oreilles. La recommandation précise aussi que la sonie mesurée estime la perception avec une certaine incertitude selon les auditeurs, le contenu et les conditions d’écoute.

Vous pouvez rencontrer les **LUFS**, unités de sonie référencées à la pleine échelle numérique. Une mesure intégrée couvre le programme ou l’extrait analysé, tandis que les mesures à plus court terme décrivent une fenêtre plus petite. Précisez la méthode, les canaux, l’intervalle analysé et si la mesure a été faite avant ou après traitement. Ne présentez pas un court échantillon de dialogue comme le résultat d’un film entier.

La recommandation [EBU R 128](https://tech.ebu.ch/publications/r128) utilise les mesures de sonie dans un cadre de normalisation pour la diffusion et distingue la sonie du niveau maximal de crête vraie. Ce n’est pas une cible universelle pour toutes les applications grand public, et elle ne transforme pas un curseur de volume en appareil de mesure.

## Distinguer les crêtes et la plage dynamique

Les crêtes d’échantillons décrivent les plus grandes valeurs absolues des échantillons enregistrés ; la mesure de crête vraie estime les pics de la forme d’onde qui peuvent se produire entre les échantillons. Aucun de ces nombres n’indique à quel point le programme reste fort dans la durée. Un impact bref et un dialogue soutenu peuvent atteindre la même crête tout en présentant des niveaux d’écoute globaux différents.

La plage dynamique concerne le contraste entre les passages plus faibles et plus forts. Augmenter un réglage de volume fixe augmente les deux ; cela ne rapproche pas sélectivement les dialogues faibles des effets forts. Le traitement de la dynamique répond à un autre problème. Par exemple, [les indications officielles de Sony](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) décrivent des réglages qui modifient ce contraste sur certains téléviseurs et formats audio. C’est un exemple propre à des appareils, pas une affirmation selon laquelle Norva proposerait le même réglage.

## Élément original : une fiche gain-sonie

Il s’agit d’un **exemple de calcul construit**, pas de médias mesurés, d’un test d’écoute ou d’un réglage de volume de Norva. Supposons deux signaux numériques présentant les crêtes d’échantillons ci-dessous et un gain linéaire simple de 0.5. Les valeurs de crête sans unité sont des fractions de la pleine échelle numérique, pas des décibels ni des mesures de pression acoustique. Aucun autre traitement n’est inclus.

| Signal construit | Plus grande valeur absolue d’un échantillon d’entrée | Multiplicateur de gain | Crête d’échantillon de sortie calculée | Sonie du programme ou niveau aux oreilles |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Inconnu à partir de ces valeurs |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Inconnu à partir de ces valeurs |

Le même gain laisse des crêtes de sortie différentes, car les signaux d’entrée diffèrent. La crête d’échantillon calculée de B est trois fois celle de A, mais cela ne signifie **pas** que B semble trois fois plus fort. Nous n’avons précisé ni le reste de chaque signal, ni sa durée, ni le matériel de sortie, ni les conditions d’écoute.

Égaliser ces crêtes ne suffirait toujours pas à établir une sonie de programme identique. Cette fiche s’arrête délibérément à ce que prouve le calcul ; elle ne peut fournir ni mesure en LUFS, ni classement de qualité, ni niveau de casque sans risque. Un multiplicateur de 0.5 ne signifie pas non plus que le curseur d’un produit particulier doit être réglé sur 50 %.

## Comparer des pistes à niveau égalisé

Si vous cherchez à savoir quelle piste est la plus claire, évitez que le niveau soit une différence non contrôlée. Utilisez cette courte procédure de comparaison avec des médias que vous êtes autorisé à lire :

1. Identifiez les libellés et les rôles des deux pistes. Une piste de commentaires n’est pas le même mixage que la bande-son principale ; utilisez le [guide de la liste des pistes audio](/blog/how-to-read-an-audio-track-list-before-playback/) si les libellés sont peu clairs.
2. Choisissez le même passage dans les deux versions. Notez les repères temporels de début et de fin, et incluez du dialogue ainsi qu’un moment plus fort si c’est le problème étudié.
3. Gardez fixes l’appareil, la chaîne de sortie, la position d’écoute et l’état du traitement. Notez les réglages inconnus au lieu de supposer qu’ils sont désactivés.
4. Comparez à un niveau faible et confortable. Réduisez la piste qui paraît plus forte pour obtenir une égalisation approximative du niveau perçu ; n’augmentez pas la plus faible jusqu’à ce qu’un effet fort devienne inconfortable. Si vous utilisez un appareil de mesure de sonie valide, consignez séparément sa méthode et son périmètre.
5. Alternez l’ordre et notez une observation précise, par exemple « le dialogue reste difficile à suivre après une égalisation approximative du niveau ». Ne transformez pas une préférence informelle en affirmation de supériorité mesurée.

Une égalisation à l’oreille reste approximative ; ce n’est pas un résultat de conformité à une norme. Si le passage ne peut pas être comparé confortablement, arrêtez la comparaison.

## Prendre en compte la normalisation

La normalisation de sonie ajuste le gain du programme ou de la lecture pour atteindre une relation de sonie définie. La normalisation des crêtes utilise, elle, un critère de crête. Aucun de ces termes ne signifie, à lui seul, que les dialogues faibles et les effets forts sont rapprochés au sein d’un programme ; cela nécessiterait une modification de leurs niveaux relatifs.

Les cibles, le périmètre de mesure, la gestion des crêtes et les commandes utilisateur dépendent de l’implémentation. Consultez la documentation de l’application, du téléviseur, du récepteur ou du casque pour identifier toute normalisation ou tout traitement dynamique actif. Cet article n’établit pas de cible de normalisation de Norva et n’affirme pas que Norva applique EBU R 128.

## Prendre en compte la sensibilité de sortie et la pièce

Casques et enceintes peuvent produire des niveaux acoustiques différents à partir du même signal numérique ou du même réglage affiché. L’ajustement du casque, la distance, les réflexions de la pièce, le bruit de fond et le traitement de l’appareil affectent aussi l’écoute. Si vous changez de sortie, vous avez modifié la comparaison même si le nombre à l’écran reste identique.

Si les détails faibles sont masqués par le bruit de la pièce, examinez l’environnement ou utilisez une [couverture adaptée par sous-titrage](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) au lieu d’augmenter continuellement le volume. Les [conseils de l’OMS pour une écoute sans risque](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) soulignent l’importance du niveau sonore et de la durée d’exposition, recommandent des pauses et conseillent de réduire le besoin de monter le son dans les environnements bruyants. Le confort à lui seul n’est pas une mesure de l’exposition.

## Signaler une différence de niveau

Notez l’élément et sa version, les libellés exacts des pistes, les repères temporels de l’extrait, les commandes de volume applicables, l’état du traitement, la chaîne et l’appareil de sortie, les conditions de la pièce, la méthode de comparaison et le résultat. N’incluez des mesures valides que lorsqu’elles sont disponibles, avec leur périmètre. « Aucune mesure de sonie ; traitement du téléviseur inconnu » est plus utile qu’une estimation inventée de décibels à partir du curseur.

Le [guide complet de la qualité audio](/blog/the-complete-guide-to-understanding-audio-quality/) présente le reste de la chaîne.

## Erreurs courantes et limites

Évitez de comparer les nombres des curseurs entre appareils, d’assimiler l’égalisation des crêtes à celle de la sonie ou d’utiliser une mesure de niveau sonore non validée sur téléphone comme preuve étalonnée. Un microphone de téléphone près d’une enceinte n’est pas non plus une mesure directe du son à l’intérieur d’un casque. Une écoute informelle n’est ni un test formel de conformité de sonie, ni un examen de l’audition, ni une preuve qu’un codec ou un lecteur est meilleur.

## Vérifier le niveau après un changement de chaîne de sortie

Lorsque vous passez des enceintes à un casque ou à un récepteur, vérifiez le niveau de la destination avant de démarrer ou de reprendre la lecture, et commencez bas. Notez les étages de gain actifs au lieu de recopier le nombre précédent. Si vous avez changé simultanément de chaîne et de média, revenez à un passage connu à faible niveau avant de décider que la nouvelle piste est à l’origine de la différence.

## Questions fréquentes

### Le volume est-il identique à la sonie du programme ?

Non. La commande de volume règle le gain à un étage de la lecture. Une mesure de sonie du programme caractérise le signal selon une méthode précisée ; aucun des deux ne détermine à lui seul le niveau acoustique à vos oreilles.

### La même valeur de curseur produit-elle la même sonie sur deux appareils ?

Non. La structure de gain, l’amplificateur, la sensibilité de sortie, les enceintes ou le casque, la pièce et le traitement diffèrent.

### La normalisation des crêtes est-elle identique à la normalisation de sonie ?

Non. Les mesures de crête et de sonie décrivent des propriétés différentes et servent des méthodes de travail différentes.

## Votre prochaine étape

Avant de comparer une autre version, notez la piste et la chaîne de sortie réellement utilisées. Puis [découvrez les fonctionnalités de lecture de Norva](https://norva.tv/#features) sans supposer l’existence d’un mode de normalisation non documenté. Norva est un logiciel de lecture multimédia, sans contenu ni abonnement TV inclus ; vos médias doivent provenir d’une source compatible que vous êtes autorisé à utiliser.

## Sources

- [MDN : gain numérique et GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [UIT-R BS.1770 : sonie des programmes et crête vraie](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128 : normalisation de sonie](https://tech.ebu.ch/publications/r128)
- [Sony : réglages de dynamique et formats concernés](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [OMS : écoute sans risque, niveau et durée d’exposition](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Fonctionnalités de Norva](https://norva.tv/#features)
