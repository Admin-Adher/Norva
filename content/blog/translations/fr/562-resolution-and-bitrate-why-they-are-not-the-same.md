---
language: "fr"
source_slug: "resolution-and-bitrate-why-they-are-not-the-same"
source_sha256: "f01136e764e04cac55c20c14d3c6d393d827a51ecc5bf37cce8da07de71596be"
title: "Résolution et débit : pourquoi ce sont deux choses différentes"
seo_title: "Résolution et débit : 1080p, Mbps et qualité vidéo"
meta_description: "Comparez deux exemples 1080p à 4 et 8 Mbps, calculez les données utilisées et découvrez ce que résolution et débit indiquent ou non sur la qualité d’image."
excerpt: "Une comparaison contrôlée des dimensions d’image et du débit, tenant compte du codec, de la source, de la complexité des scènes, du mouvement et de l’acheminement."
topic_cluster: "Comprendre la qualité vidéo"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Résolution et débit : pourquoi ce sont deux choses différentes

> **En bref :** La résolution décrit la largeur et la hauteur de chaque image vidéo en échantillons ou pixels. Le débit décrit la quantité de données encodées utilisée au fil du temps, généralement exprimée par unité de temps. Ces propriétés sont indépendantes : deux vidéos peuvent avoir la même résolution et des débits différents, ou des résolutions différentes et des débits proches. Aucune valeur ne garantit seule la qualité visible.

La résolution répond à « combien d’échantillons spatiaux composent l’image ? ». Le débit répond à « quelle quantité de données encodées est allouée au fil du temps ? ». Le codec, les réglages d’encodage, la source, la fréquence d’images, le mouvement, le bruit et la complexité des scènes déterminent l’efficacité avec laquelle ces données représentent l’image.

## Exemple chiffré : deux vidéos 1080p, des débits différents

Imaginez deux pistes vidéo de **1920 × 1080 pixels par image**. Chacune compte 2 073 600 pixels dans chaque image. Attribuez à la version A un débit vidéo moyen de 4 Mbps et à la version B une moyenne de 8 Mbps. Les dimensions restent identiques ; la seconde piste utilise deux fois plus de bits vidéo encodés sur la même durée.

![Les deux images illustratives mesurent 1920 par 1080. Avec des débits vidéo moyens supposés de 4 et 8 Mbps, une seconde utilise respectivement 4 et 8 mégabits ; aucun de ces nombres n’est un score de qualité d’image.](/assets/blog/resolution-bitrate-worked-example.svg "Illustration arithmétique originale, pas une capture Norva ni un test de vidéo encodée. Les grilles sont schématiques et ne représentent pas des pixels individuels.")

Pour dix minutes, le calcul limité à la vidéo est :

| Débit vidéo moyen supposé | Calcul pour 600 secondes | Données vidéo, Mo décimaux |
|---|---|---|
| 4 Mbps | 4 × 600 ÷ 8 | 300 Mo |
| 8 Mbps | 8 × 600 ÷ 8 | 600 Mo |

Ici, Mbps signifie millions de **bits** par seconde ; Mo signifie millions d’**octets** (« MB » dans l’illustration anglaise), avec huit bits par octet. Ces exemples excluent l’audio, les sous-titres, le surcoût du conteneur, le chiffrement et le surcoût réseau. Pour ce calcul, une piste à débit variable nécessite sa moyenne sur la durée, pas une valeur de pointe. Le résultat ne promet ni une taille de téléchargement Norva ni une vitesse de connexion requise.

Que peut-on conclure ? La version B transporte deux fois plus de données vidéo dans cet exemple. On ne peut pas en conclure qu’elle contient deux fois plus de détails, paraît deux fois meilleure ou sera lue sans saccades sur un appareil donné. Ces questions exigent de comparer l’image et la lecture.

## Comprendre ce qu’indique la résolution

Les dimensions fixent une grille spatiale maximale pour l’image encodée. Elles ne révèlent pas si la source contenait le niveau de détail correspondant, si elle avait déjà été compressée ou si la mise à l’échelle et le filtrage l’ont adoucie.

Une image plus grande issue d’une source plus petite ou dégradée garde les limites de cette source. [Le guide complet de la qualité](/blog/the-complete-guide-to-understanding-video-quality/) distingue les niveaux source, encodage, acheminement, décodage et affichage.

## Comprendre ce qu’indique le débit

Le débit indique les données au fil du temps, mais la valeur affichée peut être une cible, une moyenne, une pointe, un débit de segment mesuré ou une information au niveau du conteneur. Un encodage variable peut allouer des quantités différentes selon les moments. Notez toujours ce que représente le nombre et comment il a été obtenu.

Davantage de données peut laisser plus de marge à l’encodeur, mais comparer le débit seul entre différents codecs, profils, sources, résolutions, fréquences d’images et implémentations d’encodeur ne constitue pas un test de qualité contrôlé.

## Inclure la complexité des scènes

Un plan calme sur un fond propre peut être plus facile à représenter que des mouvements rapides, des textures fines, du grain de film, de l’eau, de la fumée, des confettis ou de brusques changements d’éclairage. Le même encodage peut donc paraître convaincant dans une scène et révéler des artefacts dans une autre.

Décrivez ce que vous voyez : blocs carrés, halos autour des contours, paliers visibles dans un dégradé ou détails fins qui disparaissent en mouvement. Ces observations sont plus utiles que dire simplement « ce n’est pas du 1080p » ; aucune n’identifie seule la cause.

## Inclure le contexte du codec et de l’encodeur

Une spécification de codec définit un format de décodage et des outils ; elle ne rend pas toutes les sorties d’encodeur aussi efficaces. Les décisions d’encodage, le profil, la profondeur de couleur, le format chromatique, la structure des images clés et d’autres paramètres peuvent compter. Notez uniquement les propriétés vérifiables.

N’affirmez pas qu’un codec offre toujours une meilleure image à un débit donné, quel que soit le contenu.

## Copier cette fiche de comparaison pour vos médias

| Champ | Version A | Version B | Contrôlé ? |
|---|---|---|---|
| Origine et transformations de la source | Connues/inconnues | Connues/inconnues | Oui/non |
| Dimensions | Valeur vérifiée | Valeur vérifiée | Oui/non |
| Type/valeur du débit | Contexte vérifié | Contexte vérifié | Oui/non |
| Codec/profil/fréquence d’images | Vérifiés/inconnus | Vérifiés/inconnus | Oui/non |
| Scène/repère temporel | Identique | Identique | Oui |
| Artefacts observés | Description | Description | Sans objet |
| Acheminement/appareil/affichage | Contexte | Contexte | Oui/non |

Si l’origine de la source ou les réglages d’encodage diffèrent, décrivez la comparaison comme une observation plutôt que comme la preuve de l’effet d’une variable.

## Réaliser une comparaison équitable pour le spectateur

Fixez l’appareil, la sortie, le mode d’affichage, la place et la scène. Confirmez que les deux versions utilisent l’état de lecture prévu et se sont stabilisées après tout changement automatique de qualité. Comparez détails fins, contours, dégradés, zones sombres et mouvement aux mêmes repères temporels.

Utilisez plusieurs scènes : un visage immobile, des détails fins en mouvement et un dégradé sombre révèlent des problèmes différents. Notez les repères exacts pour qu’une autre personne puisse reproduire l’observation. Si l’image s’arrête au lieu d’être simplement peu nette, utilisez [le guide de la mise en mémoire tampon au démarrage ou en cours de lecture](/blog/startup-buffering-or-mid-playback-buffering-separate-the-cases/) pour décrire ce symptôme distinct.

## Éviter les calculs trompeurs

Les ratios de type « bits par pixel » peuvent soutenir une analyse technique lorsque dimensions, fréquence d’images, définition du débit, codec et contenu sont contrôlés, mais ils ne deviennent pas un score perceptif universel. Les moyennes peuvent masquer les moments difficiles et l’allocation variable.

N’assimilez pas le débit du média à la capacité utile de votre connexion. [Bande passante, débit effectif, latence et gigue](/blog/bandwidth-throughput-latency-and-jitter-explained/) décrivent différents aspects de l’acheminement, notamment la différence entre capacité annoncée et données réellement transférées.

## Lire les libellés de l’interface avec prudence

Un badge de résolution peut décrire une représentation disponible ou une propriété du média plutôt que les pixels exacts arrivant actuellement à l’écran. Le débit peut ne pas être affiché du tout. Confirmez les badges et le comportement de lecture actuels de Norva à partir des informations officielles du produit au lieu d’inventer une valeur.

Norva organise et lit des sources compatibles que les utilisateurs possèdent ou sont autorisés à utiliser ; il ne doit pas être présenté comme un fournisseur de catalogue.

## Signaler la différence

Incluez les versions sans identifiants de connexion, les dimensions vérifiées, le type de débit et sa source, le codec et la fréquence d’images lorsqu’ils sont connus, la scène et le repère temporel, l’appareil, l’état de l’acheminement, la chaîne d’affichage et les artefacts observés. Signalez explicitement les inconnues.

## Questions fréquentes

### Une résolution supérieure implique-t-elle un débit supérieur ?

Pas nécessairement. Ce sont des propriétés choisies indépendamment, même si représenter davantage de détails spatiaux peut modifier les besoins d’encodage.

### Un débit supérieur donne-t-il toujours une meilleure image visible ?

Pas lorsque codecs, sources, réglages, scènes et appareils ne sont pas contrôlés. Comparez des contextes équivalents plutôt qu’un seul nombre.

### Deux débits identiques peuvent-ils donner des images différentes ?

Oui. Résolution, codec, décisions d’encodage, source, fréquence d’images et complexité des scènes peuvent différer.

## Votre prochaine étape

Si un problème de qualité d’image persiste, envoyez la fiche de comparaison remplie à l’[assistance Norva](https://norva.tv/support). Incluez l’appareil, le symptôme exact et les repères temporels, mais omettez les identifiants de source et les URL privées des médias. Norva est un lecteur logiciel pour une source compatible que vous possédez ou êtes autorisé à utiliser ; il ne fournit pas le catalogue multimédia.

## Sources

- [UIT-R BT.2020 : paramètres des systèmes UHDTV](https://www.itu.int/rec/R-REC-BT.2020/en)
- [W3C : capacités multimédias](https://www.w3.org/TR/media-capabilities/)
- [Alliance for Open Media : spécification AV1](https://aomedia.org/specifications/av1/)
- [Fonctionnalités de Norva](https://norva.tv/#features)
