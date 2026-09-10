---
language: "fr"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Pistes de sous-titres intégrées et séparées : ce qu’il faut savoir"
seo_title: "Sous-titres intégrés, externes et incrustés : les différences"
meta_description: "Comparez pistes intégrées, fichiers de sous-titres externes et texte incrusté. Découvrez ce que le conteneur, le sélecteur et la désactivation révèlent réellement."
excerpt: "Une piste intégrée n’est pas du texte incrusté. Comparez les modes de stockage avec un exemple complet, puis distinguez ce que prouve le sélecteur de ce qui reste inconnu."
topic_cluster: "Gestion des sous-titres"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Pistes de sous-titres intégrées et séparées : ce qu’il faut savoir

> **En bref :** Les données de sous-titres intégrées sont stockées dans le conteneur multimédia ; les sous-titres externes sont stockés séparément et associés au média. Les deux peuvent devenir une piste sélectionnable lorsqu’ils sont pris en charge. Les sous-titres incrustés font déjà partie de l’image vidéo et ne peuvent pas être désactivés comme une piste. Un sélecteur de sous-titres qui fonctionne prouve le fonctionnement d’une commande, pas l’endroit où les données sont stockées.

Le terme « intégré » est souvent utilisé aussi bien pour une piste contenue dans le média que pour du texte rendu définitivement dans l’image. Cette ambiguïté compte : l’un peut être sélectionnable, tandis que l’autre fait partie de l’image elle-même. Commencez par le mode de stockage du média, puis vérifiez ce que ce lecteur expose pour la version choisie.

## Définir les trois catégories pratiques

- **Piste intégrée sélectionnable :** données de sous-titres contenues dans le conteneur multimédia, distinctes des images vidéo et proposées comme choix lorsqu’elles sont prises en charge.
- **Piste associée séparée :** données de sous-titres stockées à part du média et liées par la source ou le contexte de lecture. Un fichier séparé est parfois appelé fichier d’accompagnement, ou sidecar.
- **Texte incrusté :** pixels déjà présents dans l’image vidéo ; aucun sélecteur ne peut les désactiver indépendamment.

Un **conteneur**, tel que MKV ou MP4, regroupe des flux multimédias et des métadonnées. Ce n’est ni une piste de sous-titres en soi ni une garantie de compatibilité du décodeur. Le [guide des conteneurs de MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) distingue le conteneur des codecs qu’il contient. Une extension MKV seule ne vous dit donc ni quels sous-titres existent ni si un lecteur particulier les proposera.

Les données de sous-titres ne sont pas toujours du texte brut. La [spécification des sous-titres Matroska](https://www.matroska.org/technical/subtitles.html) décrit les sous-titres textuels et les formats à base d’images tels que VobSub. Une piste de sous-titres à base d’images reste distincte de l’image vidéo ; « à base d’images » ne signifie pas « incrusté ». Ces catégories décrivent le stockage, pas la qualité de traduction ni l’exhaustivité de l’accessibilité.

## Identifier la catégorie par le comportement

Ouvrez le sélecteur de sous-titres pour l’élément et la version exacts et notez ses entrées avant toute modification. Choisissez une piste, notez son libellé et examinez une scène contenant un sous-titre. Si une commande de désactivation est disponible, utilisez-la et revenez au même moment ; comparer deux moments différents peut simplement revenir à comparer un sous-titre et une pause sans texte.

Si le texte sélectionné disparaît, cela établit qu’il était contrôlable dans ce contexte. Cela **ne distingue pas** une piste intégrée d’une piste externe. Si le texte reste, l’incrustation est une possibilité, mais vérifiez la présence d’une autre couche de sous-titrage active ou d’une fonction de sous-titrage de l’appareil avant de conclure qu’il fait partie de la vidéo. Confirmez le stockage à partir d’informations sur le média fourni, pas du seul style visuel.

## Considérer la prise en charge des pistes séparées comme conditionnelle

Une ressource séparée doit être associée au bon élément et utiliser un format pris en charge par le contexte de lecture. L’[élément HTML track](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track), par exemple, pointe explicitement vers une ressource externe et peut fournir une langue et un libellé. Le [projet de spécification WebVTT](https://www.w3.org/TR/webvtt1/) définit un format de texte synchronisé utilisé à cette fin. C’est un exemple de plateforme web, pas une description des commandes d’importation de Norva.

Un fichier placé à côté d’une vidéo ne lui est pas automatiquement associé dans tous les lecteurs. Vérifiez la procédure documentée pour l’appareil et la source utilisés. L’existence de pistes de sous-titres externes n’établit pas, à elle seule, l’importation libre de fichiers locaux, l’association automatique par nom de fichier ou une compatibilité universelle des formats dans Norva.

## Élément original : une fiche des modes de stockage

Cette **illustration rédigée pour ce guide** utilise une séquence fictive, Harbour Gate, avec la réplique « The gate is open » (« Le portail est ouvert ») à 00:18. Il n’y a ni fichiers d’exemple à télécharger ni observations de lecture de Norva. Les lignes A–C définissent différentes façons dont un propriétaire pourrait préparer cette séquence ; le comportement des commandes suppose un lecteur compatible avec la ressource indiquée.

| Version | Informations de stockage fournies dans l’exemple | Comportement attendu des commandes | Conclusion justifiée |
| --- | --- | --- | --- |
| A | Un conteneur MKV contient de la vidéo, de l’audio et une piste de sous-titres anglais distincte à l’intérieur | Sélectionner l’anglais affiche la réplique ; désactiver cette piste la masque | Piste de sous-titres intégrée, car son stockage est explicitement connu |
| B | Une vidéo MP4 est explicitement associée à un fichier WebVTT anglais séparé contenant la réplique | Sélectionner l’anglais affiche la réplique ; désactiver cette piste la masque | Ressource de sous-titres externe, car l’association et le stockage séparé sont connus |
| C | Le propriétaire a rendu la réplique anglaise dans les images vidéo ; aucune piste de sous-titres n’est fournie | Une commande de désactivation des sous-titres ne peut pas retirer ces pixels | Texte incrusté, car la vidéo fournie est définie ainsi |
| D | Seule une entrée du lecteur libellée Anglais est connue ; elle peut afficher et masquer la réplique | La bascule fonctionne, comme dans A et B | Piste de sous-titres sélectionnable ; son stockage intégré ou externe reste non confirmé |

Les lignes A et B peuvent paraître identiques dans le lecteur. La ligne D représente la limite importante : un test de désactivation ne permet pas de les distinguer. Un élément réel peut aussi associer du texte incrusté à une traduction sélectionnable : plusieurs catégories peuvent donc s’appliquer à différentes lignes visibles.

Pour réutiliser la fiche, notez l’élément et sa version, la liste complète du sélecteur, le libellé sélectionné, le moment du sous-titre, le résultat à l’état désactivé et la source de toute information de stockage. Inscrivez « non confirmé » partout où la source multimédia ne fournit pas assez de détails.

## Comparer les versions avec soin

Une version peut stocker les sous-titres différemment ou en proposer un autre ensemble. Gardez l’appareil, le profil et la source multimédia fixes lorsque vous comparez les versions et relevez chaque liste complète de pistes. Vérifiez l’édition et la durée ainsi que le titre : une ressource de sous-titres synchronisée pour un autre montage peut ne pas correspondre au film du même nom.

Une piste manquante après un changement de version ne prouve pas l’échec du chargement d’une ressource séparée.

## Diagnostiquer une piste séparée manquante

Établissez d’abord pourquoi vous attendez cette piste. Un libellé de catalogue, un fichier fourni par le propriétaire et une piste réellement listée pour cette version constituent des preuves différentes. Demandez si le propriétaire de la source confirme la ressource et son association avec la version choisie.

Notez la langue et le rôle attendus, l’appareil, la version de l’application ou du navigateur, la connectivité et le sélecteur complet. Distinguez « non listée », « listée mais impossible à sélectionner » et « sélectionnée mais aucun sous-titre visible au moment vérifié ». Ces observations orientent vers des questions différentes ; aucune ne prouve à elle seule un défaut du lecteur. Préservez ces éléments avant de renommer des fichiers, déplacer des ressources, retirer la source, effacer des données ou réinstaller.

## Comprendre les différences de fonctionnalités

Les pistes intégrées et externes peuvent toutes deux fournir des sous-titres utiles. Les options de style dépendent du format et du moteur de rendu ; les ressources textuelles et à base d’images ne proposent pas nécessairement les mêmes commandes. Un sélecteur de sous-titres ne permet pas de modifier indépendamment le style du texte incrusté ni de le désactiver. Les [indications du W3C sur le sous-titrage](https://www.w3.org/WAI/media/av/captions/) distinguent également les sous-titres que les spectateurs peuvent masquer du sous-titrage ouvert qui reste affiché.

Le [guide complet de gestion des sous-titres](/blog/the-complete-guide-to-managing-subtitle-tracks/) explique les vérifications de langue, de rôle, de synchronisation, d’état et d’appareil qui s’appliquent une fois une piste trouvée.

Évaluez ensuite ce que contient la piste : [le sous-titrage d’accessibilité et les sous-titres de dialogue peuvent répondre à des besoins d’information différents](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). Si des sous-titres sont présents mais difficiles à lire, distinguez [la visibilité des caractères de la facilité de lecture](/blog/legibility-and-readability-two-different-viewing-problems/) au lieu d’accuser le mode de stockage.

## Protéger les droits sur les sources et la confidentialité

Utilisez des médias et des ressources de sous-titres qui vous appartiennent ou auxquels vous êtes autorisé à accéder. Norva est un lecteur multimédia, sans contenu ni abonnement TV inclus ; connecter une ressource ne vous accorde pas de droits sur celle-ci. N’envoyez pas de médias ou de fichiers de sous-titres à l’assistance sans l’autorisation nécessaire. Commencez un signalement avec des libellés non sensibles, les étapes et les repères temporels ; vérifiez l’absence d’adresses privées de source ou de détails de compte dans les captures avant de les partager.

## Erreurs courantes et limites

Évitez d’appeler le texte incrusté une piste intégrée sélectionnable, de promettre une association automatique, de supposer tous les formats compatibles et de modifier les fichiers sources avant de préserver les éléments observés.

Le mode de stockage peut rester opaque lorsque la source n’expose qu’une option de lecture. Décrivez le comportement observé du sélecteur au lieu de deviner la méthode de stockage.

## Questions fréquentes

### Peut-on désactiver les sous-titres incrustés ?

Pas comme une piste séparée, car le texte fait partie de l’image. Une autre version du média peut être différente, mais vérifiez sa disponibilité.

### Les pistes de sous-titres séparées sont-elles toujours des fichiers texte ?

Non. WebVTT et SubRip sont des exemples textuels, mais les ressources de sous-titres peuvent aussi être à base d’images, comme VobSub. « Séparé » décrit l’emplacement de la ressource par rapport au média, pas l’encodage de ses sous-titres. Vérifiez le format réel et la compatibilité documentée.

### Une piste séparée manquante signifie-t-elle que le lecteur est défectueux ?

Non. Vérifiez l’association, l’élément et sa version, les métadonnées de la source, la compatibilité du format et le sélecteur avant d’attribuer une cause.

## Votre prochaine étape

Si la source confirme une ressource de sous-titres mais que le résultat reste incertain, présentez votre fiche de stockage complétée à l’[assistance Norva](https://norva.tv/support). Précisez ce que vous avez observé et ce qui reste non confirmé ; n’incluez pas les fichiers multimédias ni les détails privés de connexion dans le premier signalement.

## Sources

- [MDN : conteneurs multimédias et codecs qu’ils contiennent](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska : codecs de sous-titres, dont les pistes textuelles et à base d’images](https://www.matroska.org/technical/subtitles.html)
- [MDN : élément HTML track et ressources externes](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C : projet de spécification WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C : sous-titrage, sous-titres et présentation ouverte ou fermée](https://www.w3.org/WAI/media/av/captions/)
- [Norva : fonctionnalités et exigences des sources compatibles](https://norva.tv/#features)
