---
language: "fr"
source_slug: "handoff-mirroring-or-casting-know-which-workflow-you-need"
source_sha256: "b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e"
title: "Transfert de session, recopie d’écran ou casting : quel parcours choisir ?"
seo_title: "Transfert, recopie d’écran ou casting : que choisir ?"
meta_description: "Choisissez entre session autonome, copie de l’écran et lecture sur récepteur. Comparez commandes, confidentialité, accès et vérifications des appareils."
excerpt: "Déterminez si vous avez besoin d’une application autonome, d’une copie de votre écran ou d’une lecture sur récepteur pilotée par téléphone, puis vérifiez les exigences de ce parcours."
topic_cluster: "Transfert entre appareils"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Transfert de session, recopie d’écran ou casting : quel parcours choisir ?

> **En bref :** Utilisez le transfert de session pour continuer de manière autonome dans l’application de l’appareil cible. Utilisez la recopie d’écran pour reproduire votre écran sur un autre affichage. Utilisez le casting vers un récepteur pour sélectionner un média sur un appareil et piloter sa lecture sur un autre. Choisissez selon le comportement recherché, puis vérifiez les exigences de l’application, du récepteur, du réseau et de la source ; le mot « cast » seul n’identifie pas le parcours.

« Afficher ceci sur la TV » peut signifier trois choses : transférer votre progression de visionnage, copier votre interface actuelle ou utiliser votre téléphone comme télécommande. Une connexion réussie peut tout de même être le mauvais parcours si elle ne fait pas ce que vous attendiez.

Ici, **appareil source** désigne le téléphone ou l’ordinateur de départ ; **source multimédia** désigne le service ou les fichiers qui fournissent les médias que vous êtes autorisé à utiliser. Ces notions ne sont pas interchangeables.

## Comparer les trois parcours

| Parcours | Origine de l’expérience visible | Appareil source après le démarrage | Vérification principale |
| --- | --- | --- | --- |
| Transfert de session | Application ouverte indépendamment sur la cible | Pas nécessaire au rendu de la session cible | Compte, profil, source, élément, version, progression |
| Recopie d’écran | Reproduction de l’écran source partagé | Continue à fournir l’écran affiché | Compatibilité du système et de l’affichage ; contenu partagé |
| Casting vers un récepteur | Média lu par un récepteur, choisi depuis un émetteur | Fournit les commandes de session ; la dépendance envers l’émetteur varie | Compatibilité de l’émetteur, du récepteur, du média, du réseau et des droits |

Ce sont des catégories pratiques, pas des noms rigides de protocoles. Google documente à la fois [la diffusion d’un onglet ou d’un écran Chrome](https://support.google.com/chromecast/answer/3228332?hl=en) et [la lecture sur récepteur pilotée par un émetteur](https://developers.google.com/cast/docs/overview). Ce guide utilise « casting vers un récepteur » pour la seconde, afin de distinguer le comportement voulu avant de suivre des instructions de configuration.

## Choisir le transfert pour la continuité

Le transfert convient lorsque l’objectif est de « finir cet élément dans l’application TV » ou de « passer de la tablette au web ». La [page publique des fonctionnalités](https://norva.tv/#features) de Norva décrit une progression, des favoris, un historique et des préférences de profil qui vous suivent sur les écrans pris en charge. C’est une continuité du contexte de visionnage, pas une copie du premier écran.

La cible a toujours besoin de son propre mode d’accès Norva pris en charge et d’un accès à la source multimédia compatible. Mettez la première session en pause, confirmez le profil voulu et la version de l’élément sur la cible, puis vérifiez le point de reprise avant la lecture. Le [guide du transfert état par état](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) couvre cette séquence. Une affiche identique ne suffit pas à identifier le même épisode ou la même édition.

**Choisissez ce parcours si :** vous voulez que la cible devienne l’écran principal sans reproduire l’affichage source.

## Choisir la recopie pour une copie exacte de l’écran

La recopie d’écran reproduit un affichage partagé au lieu d’ouvrir une copie indépendante de l’application cible. Le partage de tout l’écran peut révéler la navigation, des notifications, des détails de compte ou d’autres activités affichées. Partager un onglet ou une seule application limite davantage le périmètre lorsque la plateforme le propose ; ne supposez pas que ces modes exposent les mêmes choses.

Vérifiez le périmètre de partage avant de commencer et fermez les contenus privés qui pourraient y apparaître. Vérifiez l’image et le son : les instructions Chrome de Google distinguent la diffusion d’un onglet de celle de tout l’écran et précisent que le son de la recopie d’écran peut rester sur l’ordinateur. Une image visible ne prouve pas que le son a été transféré aussi.

**Choisissez ce parcours si :** le besoin réel est de montrer la même interface ou un écran autre qu’un média à d’autres spectateurs, et si la recopie est prise en charge de façon vérifiée.

## Choisir la lecture distante pour un parcours avec récepteur

Dans le modèle Cast de Google, un émetteur démarre et pilote la session tandis qu’un récepteur gère la lecture du média. Le récepteur n’est pas simplement une seconde copie de tout ce qui apparaît sur le téléphone. La survie de la session à la fermeture de l’émetteur ou à la perte de sa connexion dépend de l’implémentation réelle ; vérifiez au lieu de supposer une indépendance vis-à-vis du téléphone.

Un parcours avec récepteur nécessite des capacités compatibles côté émetteur et récepteur. La page d’accueil publique de Norva mentionne **Google Cast**, séparément de son application Android TV et de la continuité entre écrans. Cette disponibilité publiée n’est pas un test de votre récepteur, de votre format multimédia, de votre piste de sous-titres ou de votre réseau. Cet article ne rapporte pas de test de casting Norva achevé.

Le [projet d’API Remote Playback du W3C](https://www.w3.org/TR/remote-playback/) décrit une famille plus large de mécanismes de lecture distante, dont des cas où la source assure encore le rendu ou le relais des médias. Le [projet d’API Presentation](https://www.w3.org/TR/presentation-api/) concerne la présentation de contenus web sur un autre affichage. Aucune de ces spécifications ne prouve qu’une application implémente une API particulière ou que tous les récepteurs sont compatibles.

**Choisissez ce parcours si :** la cible est conçue pour recevoir la lecture et si l’émetteur, le récepteur, le média, le réseau, les droits de la source et la documentation produit actuels permettent tous ce parcours.

## Poser d’abord les questions sur l’objectif

Demandez-vous :

1. Est-ce que je veux que la cible exécute sa propre application après la transition ?
2. Dois-je partager tout l’écran, une seule application ou uniquement le média ?
3. Est-ce que je veux continuer à piloter la lecture depuis l’appareil source ?
4. Quelles informations privées se trouvent dans le périmètre de partage choisi ?
5. Le parcours sélectionné peut-il accéder à la source multimédia autorisée ?
6. Cette fonction est-elle documentée pour ces appareils et ces versions d’application ?
7. Les conditions actuelles de l’offre logicielle et de la source multimédia permettent-elles l’usage prévu ?

Si les réponses se contredisent, n’activez pas des icônes de connexion au hasard. Clarifiez d’abord l’objectif.

## Élément original : une fiche de sélection

La fiche complétée suivante est une **illustration rédigée pour ce guide**, pas un compte rendu de tests produit. Les personnes, le titre et le point de pause sont fictifs. Chaque choix découle de l’objectif indiqué ; la dernière colonne décrit le travail restant, pas une vérification réussie.

| Situation indiquée | Parcours choisi | Pourquoi il convient | Vérification avant utilisation |
| --- | --- | --- | --- |
| Maya a mis le film fictif Harbour Walk en pause à 18:40 sur son téléphone et veut le terminer dans l’application TV avec la télécommande du téléviseur | Transfert de session | La TV doit exécuter une session autonome avec le bon contexte enregistré | Même profil, source autorisée, version exacte et point de reprise dans l’application TV prise en charge |
| Jules veut montrer à une autre personne le panneau de filtres ouvert sur un ordinateur portable | Recopie ou mode pris en charge de partage d’application ou de fenêtre | L’interface elle-même, pas seulement une vidéo, doit apparaître sur l’affichage | Périmètre exact de partage, compatibilité de l’affichage et absence de contenu privé |
| Sam veut choisir un film sur un téléphone et continuer à utiliser ses commandes de lecture pour le récepteur du salon | Casting vers un récepteur | L’émetteur pilote la lecture du récepteur sans partager toute l’interface du téléphone | Émetteur et récepteur pris en charge, média accessible, usage autorisé et pistes audio/de sous-titres nécessaires |

Les décisions diffèrent même si les trois personnes disent « mets-le sur le grand écran ». Réutilisez les quatre colonnes avec votre propre situation. Si la dernière vérification reste inconnue, le choix est provisoire ; un libellé de fonctionnalité attrayant ne la remplace pas.

## Vérifier avant d’agir

Pour une TV partagée, convenez de la personne dont la progression et les préférences doivent changer. Le [guide de choix entre profils séparés et partagés](/blog/separate-profiles-or-one-shared-profile-a-decision-framework/) aide à résoudre cette question avant la lecture. Pour un parcours avec récepteur, consultez les indications actuelles de Norva et du fabricant de l’appareil ; ne déduisez pas une compatibilité de la forme d’une icône, d’un ancien tutoriel ou d’une autre application.

Vérifiez aussi la disponibilité de l’audio et des sous-titres à destination. Une image correcte ne prouve pas que chaque [piste de sous-titres intégrée ou séparée](/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/) y est parvenue. Notez la version de l’application, le modèle de récepteur, la version de l’élément choisi et le résultat visible si vous avez besoin d’aide ; ne partagez pas les informations de connexion de la source.

## Limites et erreurs courantes

Les termes varient selon les plateformes. Certains produits réunissent la découverte, le pilotage et l’affichage sous un seul libellé. Cet article fournit un cadre de décision, pas des instructions de configuration propres à chaque appareil.

Les erreurs courantes consistent à assimiler transfert et recopie, supposer que toute application TV est un récepteur, exposer des notifications pendant la recopie, confondre nombre de profils et autorisation d’usage simultané, et attendre des pistes identiques sur tous les parcours. Norva est un logiciel de lecture multimédia ; aucun contenu ni abonnement TV n’est inclus. Un mode de connexion n’accorde pas de droits sur les médias et ne remplace pas les conditions d’accès d’une source.

## Questions fréquentes

### La synchronisation de Norva entre appareils signifie-t-elle qu’il prend en charge le casting ?

La synchronisation seule ne démontre pas la prise en charge du casting. Norva mentionne séparément Google Cast sur sa page d’accueil publique. Vérifiez l’émetteur, le récepteur, la source et les médias pris en charge pour le parcours prévu ; ce guide n’a pas testé cette combinaison d’appareils.

### La recopie est-elle la meilleure solution pour la vidéo ?

Pas dans tous les cas. Elle peut reproduire tout l’écran source et maintenir cet appareil impliqué. Choisissez selon l’objectif réel et le parcours pris en charge.

### Peut-on utiliser ces termes indifféremment ?

Évitez de le faire. Nommez le comportement attendu de la source et de la cible pour que l’assistance et les membres du foyer comprennent le parcours.

## Votre prochaine étape

Choisissez une ligne de la fiche de sélection, puis [examinez les fonctionnalités de Norva entre appareils](https://norva.tv/#features) au regard de cet objectif. Gardez explicites les vérifications restantes des appareils et de la source avant de déplacer une session.

## Sources

- [Google Cast : aperçu des émetteurs et récepteurs](https://developers.google.com/cast/docs/overview)
- [Assistance Google : diffuser un onglet ou un écran Chrome sur une TV](https://support.google.com/chromecast/answer/3228332?hl=en)
- [Projet d’API Remote Playback du W3C](https://www.w3.org/TR/remote-playback/)
- [Projet d’API Presentation du W3C](https://www.w3.org/TR/presentation-api/)
- [Fonctionnalités de Norva](https://norva.tv/#features)
