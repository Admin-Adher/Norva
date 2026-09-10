---
language: "fr"
source_slug: "offline-storage-management-handbook"
source_sha256: "4ad5c1694f9825a417d72d6c7ab37dd5066001c03760f05a46f96604b116836a"
title: "Stockage vidéo hors connexion : libérer de l’espace sans réinitialiser l’application"
seo_title: "Stockage hors connexion : retirer les vidéos en sécurité"
meta_description: "Trop de téléchargements ? Rapprochez les totaux de l’app et de l’appareil, retirez les vidéos déjà regardées et préservez de l’espace grâce à un exemple détaillé."
excerpt: "Un exemple avant/après complet explique pourquoi les téléchargements et le stockage de l’application diffèrent, et comment récupérer de l’espace sans réinitialiser l’app ni effacer les réglages locaux."
topic_cluster: "Stockage hors connexion"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Stockage vidéo hors connexion : libérer de l’espace sans réinitialiser l’application

> **En bref :** Gérez le stockage hors connexion à partir de deux vues : la liste des éléments locaux dans l’application et le rapport de stockage du système d’exploitation. Mesurez des éléments représentatifs, protégez une réserve d’espace libre propre à l’appareil, attribuez un responsable et une date de révision à chaque lot, et retirez d’abord depuis l’application les éléments dont le visionnage est terminé. Examinez une croissance inexpliquée en changeant une seule chose à la fois ; ne supposez jamais que cache, données de l’application et médias hors connexion sont interchangeables.

Si votre téléphone indique qu’une application utilise 10 GB alors que sa liste de téléchargements totalise 8 GB, l’espace restant n’est pas automatiquement gaspillé. Le code de l’application, les réglages, les visuels et les données temporaires peuvent aussi compter. L’objectif est de retirer les copies locales inutiles tout en conservant le compte, les préférences et les médias dont vous avez encore besoin.

## Comprendre les couches de stockage

Norva indique que les médias hors connexion éligibles sont chiffrés et stockés sur l’appareil, pas téléversés vers Norva. Ces médias locaux gérés par l’application sont distincts :

- des métadonnées et visuels du catalogue ;
- de la progression de lecture et des préférences pouvant être synchronisées ;
- du cache ou des données temporaires de transfert ;
- des réglages et informations de connexion de l’application ;
- des fichiers sans rapport appartenant à d’autres applications.

La disponibilité locale est également distincte de l’éligibilité. Une entrée de téléchargement visible ne prouve pas que la version souhaitée et toutes les pistes nécessaires peuvent être lues sans connexion. Utilisez le [guide de lecture hors connexion](/blog/offline-playback-explained/) pour cette vérification séparée. La disponibilité dépend de la source, de l’autorisation, de l’appareil pris en charge et des conditions actuelles du produit ; cela ne promet pas que chaque plateforme Norva télécharge chaque élément.

## Établir un état de référence fiable

Ouvrez à la fois l’espace hors connexion de l’application et les réglages de stockage de l’appareil. Notez l’espace libre actuel, l’espace occupé annoncé par l’application et les éléments locaux que vous pouvez identifier. Apple et Android fournissent tous deux des informations de stockage, mais les noms de catégories et les méthodes de comptabilisation diffèrent.

Mesurez un élément éligible représentatif en notant le stockage avant et après sa préparation, sans autres transferts pendant la comparaison. Considérez le résultat comme une observation pour cet appareil, cet élément et cette version, pas comme une règle universelle de taille par heure. L’[estimation de stockage vidéo hors connexion](/blog/storage-for-offline-video/) aide à planifier un lot ; les tailles réelles restent la base de l’entretien.

## Préserver l’espace libre de fonctionnement

Choisissez une réserve avant d’ajouter des médias. L’appareil a besoin d’espace pour son activité normale, et votre usage personnel détermine la prudence de cette limite. Le [guide de réserve d’espace libre](/blog/set-free-space-reserve-offline-media/) s’appuie sur le comportement observé de l’appareil plutôt que sur un pourcentage unique pour tous.

Après quelques éléments, vérifiez à nouveau l’espace libre. Arrêtez-vous avant que l’élément suivant franchisse la limite, même s’il reste éligible.

## Donner un usage à chaque élément

Notez le spectateur, le profil, la session prévue, l’audio ou les sous-titres nécessaires, la taille mesurée, la date du test sans connexion et la date de nettoyage. Les éléments locaux sans usage nommé deviennent difficiles à distinguer de l’encombrement inutile.

Utilisez une rotation avec les états actif, secours, à retirer et à revérifier. Ne gardez qu’un élément de secours pour une alternative crédible, et ne conservez pas un élément échoué ou incomplet simplement parce que sa préparation a pris du temps.

## Libérer le stockage dans l’ordre le plus sûr

Commencez par les éléments dont le visionnage est terminé ou qui sont devenus inutiles, à l’intérieur de l’application. Confirmez l’élément exact et lisez le message de retrait. Attendez ensuite que l’affichage du stockage du système d’exploitation s’actualise.

Examinez ensuite les téléchargements d’autres applications et les fichiers locaux clairement inutilisés au moyen de leurs propres commandes. Évitez de supprimer les dossiers internes des applications. Sur Android, vider le cache retire les données temporaires, tandis qu’effacer le stockage retire les données de l’application ; sur les appareils Apple, décharger et supprimer une application ont des effets différents. Lisez les libellés actuels de la plateforme avant d’agir.

## Diagnostiquer une croissance inexpliquée

Si l’utilisation du stockage change de façon inattendue, relevez un nouvel état de référence et comparez une catégorie à la fois. Vérifiez si un transfert est encore actif, si une autre application a ajouté des fichiers et si les deux rapports de stockage se sont actualisés. Un écart croissant mérite une investigation, mais l’écart seul n’identifie ni fuite, ni cache, ni téléchargement en double.

Ne réinstallez pas l’application comme première étape de diagnostic. La politique de confidentialité de Norva indique que les médias téléchargés sont retirés lors de la désinstallation de l’application.

## Coordonner plusieurs appareils

Chaque appareil possède son propre stockage, sa batterie et son spectateur prévu. Ne dupliquez pas automatiquement tout le lot. Un téléphone pour le train et une tablette pour le soir peuvent nécessiter des éléments différents. Synchroniser la progression ou les préférences ne signifie pas que les octets des médias ont été copiés sur l’autre appareil ; vérifiez séparément leur disponibilité locale.

## Élément original : un registre de contrôle du stockage

Cet exemple complet utilise des **chiffres fictifs, pas un test de Norva sur appareil**. Un téléphone indique 12.0 GB libres et une occupation de 10.2 GB pour l’application. Celle-ci répertorie trois éléments locaux dont la préparation est terminée, totalisant 8.0 GB. Tous les nombres utilisent des GB décimaux et correspondent au même moment de relevé.

| Élément ou catégorie | Taille | Usage | Décision |
| --- | --- | --- | --- |
| Vidéo de voyage A déjà regardée | 3.0 GB | Voyage précédent terminé | Retirer uniquement cette copie locale depuis l’application |
| Vidéo B prévue | 4.0 GB | Visionnage du soir à venir | Conserver et tester hors connexion avant le départ |
| Court élément de secours C | 1.0 GB | Session de remplacement | Conserver jusqu’au trajet de retour |
| Occupation de l’application moins téléchargements répertoriés | 2.2 GB | Non détaillée par ces deux rapports | Ne pas y toucher ; ne pas appeler cache tout le solde |

Après le retrait de A et l’actualisation des rapports, ce téléphone illustratif indique **5.0 GB** de téléchargements répertoriés, **7.2 GB** occupés par l’application et **15.0 GB** libres. La réduction de 3.0 GB est cohérente avec le retrait choisi. L’écart restant de 2.2 GB est inchangé et toujours non classé.

Le foyer choisit une **réserve de 6.0 GB** pour les mises à jour et activités qu’il prévoit. Il reste donc 9.0 GB au-dessus de la réserve après le nettoyage, pas 15.0 GB à remplir. Cette réserve est un exemple, pas un minimum Android ou Norva ; l’espace temporaire de préparation et l’activité future de l’appareil comptent aussi.

Si l’augmentation réelle de votre espace libre diffère de la taille affichée de l’élément retiré, ne répétez pas aveuglément la suppression. Actualisez les deux vues, notez les autres changements et comparez des unités cohérentes. Demandez de l’aide si un écart inexpliqué reproductible persiste. Notez des surnoms d’éléments sans informations sensibles et des tailles arrondies, jamais des URL de source ou des informations de connexion.

## Erreurs courantes et limites

- Assimiler tout le stockage de l’application à des médias pouvant être lus hors connexion.
- Appliquer une estimation universelle de taille des fichiers.
- Remplir l’appareil jusqu’à sa limite affichée.
- Effacer tout le stockage de l’application pour retirer un seul élément.
- Manipuler manuellement les fichiers chiffrés gérés par l’application.
- Attendre une actualisation instantanée des rapports de stockage.
- Supposer qu’un transfert d’appareil conserve les médias locaux.
- Garder d’anciens lots sans dates de révision.

## Questions fréquentes

### Pourquoi les totaux de l’application et de l’appareil diffèrent-ils ?

L’appareil peut inclure le code de l’application, les réglages, le cache, les données temporaires et les médias locaux, tandis que l’application n’affiche que les éléments hors connexion dont la préparation est terminée. Le moment du relevé et les règles de catégories peuvent également différer.

### Vider le cache revient-il à retirer les médias hors connexion ?

Ne le supposez pas. Le cache désigne normalement des données temporaires, tandis qu’un média hors connexion est un élément local conservé volontairement. Utilisez d’abord le retrait individuel dans l’application.

### Effacer le stockage supprime-t-il mes réglages ou mes téléchargements ?

Android décrit « Effacer le stockage » comme la suppression de toutes les données de l’application. Ce n’est pas une commande de nettoyage réservée aux téléchargements. Ne l’utilisez pas pour retirer une seule vidéo. Lisez le message de retrait de l’application et conservez les informations de récupération du compte avant d’envisager une réinitialisation plus large selon les consignes officielles de l’assistance.

### Chaque appareil doit-il conserver le même lot ?

Non. Répartissez les éléments selon le spectateur prévu, le trajet, la batterie, le stockage et la fiabilité. Vérifiez chaque appareil indépendamment.

## Votre prochaine étape

[Vérifier comment fonctionne la lecture hors connexion](https://norva.tv/blog/offline-playback-explained/) avant votre prochain voyage. Commencez par un élément compatible que vous êtes autorisé à utiliser, vérifiez ses pistes nécessaires sur l’appareil prévu et fixez une date de révision pour sa copie locale. Norva est un lecteur multimédia, pas une bibliothèque de contenus fournie.

## Sources

- [Politique de confidentialité de Norva](https://norva.tv/privacy)
- [Apple : vérifier le stockage sur iPhone et iPad](https://support.apple.com/en-gb/108429)
- [Aide Android : libérer de l’espace de stockage](https://support.google.com/android/answer/7431795?hl=en)
- [Aide Android : gérer les applications inutilisées](https://support.google.com/android/answer/13627979?hl=en)
