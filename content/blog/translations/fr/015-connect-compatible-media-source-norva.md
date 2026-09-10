---
language: "fr"
source_slug: "connect-compatible-media-source-norva"
source_sha256: "8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659"
title: "Comment connecter une source multimédia compatible à Norva"
seo_title: "Connecter une source multimédia compatible à Norva"
meta_description: "Préparez, connectez et vérifiez une source compatible autorisée dans Norva en protégeant ses identifiants et en consignant clairement les observations utiles."
excerpt: "Connectez une source compatible autorisée par le parcours actuel de Norva, protégez ses paramètres, attendez le chargement du catalogue et vérifiez un élément connu avant d’ajouter d’autres sources."
topic_cluster: "Configuration et compte Norva"
sources_heading: "Sources"
next_step_heading: "Votre prochaine étape"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Comment connecter une source multimédia compatible à Norva

> **En bref :** Sur le Web, ouvrez le menu du compte, puis Settings (Paramètres) et TV service (Service TV). Choisissez M3U link pour une URL complète de liste de lecture, ou Xtream login pour des informations de fournisseur compatibles. Connectez uniquement une source que vous possédez ou êtes autorisé à utiliser, gardez ses identifiants privés et vérifiez un élément connu avant d’ajouter d’autres sources. Norva est un lecteur ; il ne fournit ni la source ni les médias.

**Ce qui a été vérifié :** le 10 septembre 2026, nous avons utilisé un compte de test connecté dans l’application Web en production pour inspecter les formulaires et soumettre un accès Xtream de test fourni par l’utilisateur. Une vérification ultérieure a confirmé l’état **Ready** (Prête), le filtrage linguistique propre à la source et une recherche ouvrant un titre à douze versions. Les captures Web sont directes, non modifiées et ne montrent aucune information de connexion privée. Aucun import M3U ni parcours natif téléphone/TV n’a été testé ; une lecture réussie reste à vérifier séparément.

## Avant de commencer

Confirmez ces quatre conditions :

- Vous contrôlez le compte Norva.
- La source vous appartient ou vous avez l’autorisation de l’utiliser.
- Les conditions de la source permettent la connexion envisagée.
- Norva prend actuellement en charge la méthode de connexion de la source.

Préparez les informations officielles directement auprès du propriétaire de la source ou depuis sa page de compte. N’utilisez pas de paramètres transmis sans origine claire.

Consultez [Que préparer avant d’ajouter votre source multimédia](/blog/prepare-media-source-setup/) pour une fiche préparatoire.

## Étape 1 : utiliser un accès officiel à Norva

Ouvrez Norva depuis son site officiel ou son application installée. Vérifiez l’adresse ou l’identité de l’application avant de saisir des informations de compte ou de source.

Connectez-vous au compte et au profil prévus. Sur un appareil partagé ou emprunté, n’enregistrez pas d’identifiants privés sauf si l’appareil est de confiance et si les conditions de la source le permettent.

**Résultat observable :** le compte s’ouvre normalement et vous pouvez accéder aux commandes de gestion des sources.

## Étape 2 : trouver la gestion des sources

Sur le Web, ouvrez le menu du compte, choisissez **Settings** (Paramètres), puis l’onglet **TV Service** (Service TV). Ces libellés anglais sont traduits lorsqu’une autre langue d’interface est sélectionnée. Si l’application s’ouvre sur l’accueil, suivez ce chemin de menu ; ne supposez pas qu’un lien enregistré vers les paramètres de source a ouvert le bon panneau.

Choisissez **Add playlist** (Ajouter une liste de lecture) ou **Add provider** (Ajouter un fournisseur) pour ouvrir la fenêtre **Add TV service** (Ajouter un service TV). Ses onglets **M3U link** (Lien M3U) et **Xtream login** (Connexion Xtream) adaptent le formulaire aux informations réellement reçues.

Avant toute saisie, vérifiez si une autre source existe déjà. Ajouter deux fois la même source peut produire des catégories apparemment dupliquées et compliquer le diagnostic ultérieur.

**Résultat observable :** un formulaire d’ajout ou un choix de connexion pris en charge est visible.

## Étape 3 : sélectionner une méthode compatible documentée

Faites cette distinction avant de coller quoi que ce soit :

| Ce dont vous disposez | Choix dans Norva | Première vérification |
| --- | --- | --- |
| Une adresse complète de liste de lecture | M3U link | L’URL complète provient de votre source autorisée, pas d’une page de téléchargement d’application. |
| Une adresse de serveur et des identifiants compatibles, ou un lien Xtream complet | Xtream login | Le propriétaire confirme ce format et votre autorisation de connexion. |
| Uniquement un nom d’utilisateur et un mot de passe pour une autre application | My provider only gave me an app login | Demandez un format de source compatible ; ne devinez pas une adresse de serveur. |

![Formulaire de source M3U de Norva avec un champ Playlist URL, un nom de service facultatif et le bouton Add.](/assets/blog/source-m3u-live-web-20260910.jpg "Formulaire Web M3U en production, le 10 septembre 2026. Les champs sont vides ; cette image ne prouve pas qu’un import M3U a été effectué.")

Pour **M3U link**, saisissez l’adresse complète dans **Playlist URL**. Le formulaire de Norva décrit une adresse `http` ou `https` et donne `.m3u`, `.m3u8` et `get.php` comme indices courants, sans en faire une preuve d’autorisation ou de compatibilité. **Service name** (Nom du service) est facultatif : un surnom neutre aide à distinguer les sources sans exposer leurs identifiants.

![Formulaire de connexion Xtream de Norva montrant la première étape et les options de lien complet ou de saisie manuelle du serveur.](/assets/blog/source-xtream-live-web-20260910.jpg "Étape d’entrée Xtream en production, capturée avant la saisie de l’accès de test. Continue mène au choix de période d’accès, pas directement à un import terminé.")

Pour **Xtream login**, le parcours actuel commence à **Connect provider** (Connecter le fournisseur). Utilisez **Provider URL or complete Xtream link** (URL du fournisseur ou lien Xtream complet), ou développez **Enter server login manually** (Saisir manuellement les identifiants du serveur) si c’est le format reçu. Examinez chaque étape suivante à l’écran au lieu de considérer **Continue** (Continuer) comme la confirmation d’une source déjà connectée.

Faites correspondre chaque valeur demandée aux informations officielles de la source. Évitez d’ajouter des espaces, de changer la casse ou de « corriger » une adresse sauf indication de sa documentation.

La politique de confidentialité de Norva indique que les paramètres de source servent à connecter le service à la source pour le compte de l’utilisateur. Consultez-la avant d’envoyer des paramètres sensibles.

### Si vous n’avez que des identifiants d’application

Sélectionnez **My provider only gave me an app login** (Mon fournisseur m’a seulement donné des identifiants d’application). Le panneau d’aide explique pourquoi les identifiants d’une application distincte ne peuvent pas simplement être importés comme source Norva et fournit un message demandant un lien M3U compatible ou des informations de serveur Xtream. Contactez le propriétaire par son canal officiel ; ne collez pas de mots de passe dans des publications d’assistance publiques.

![Panneau d’aide Norva expliquant que des identifiants d’application nécessitent des informations de source compatibles avant la connexion.](/assets/blog/source-app-login-help-live-web-20260910.jpg "Aide Web en production pour les identifiants limités à une application ; aucun compte fournisseur ni lien privé n’est affiché.")

## Étape 4 : saisir les paramètres en privé

Utilisez le copier-coller lorsque c’est pratique, puis vérifiez le début et la fin de chaque valeur non secrète. Gardez les mots de passe, liens privés, noms d’utilisateur et jetons hors des :

- captures d’écran ;
- enregistrements d’écran ;
- discussions d’assistance publiques ;
- notes d’analyse ;
- documents partagés ;
- outils d’historique du presse-papiers auxquels vous ne faites pas confiance.

Si la saisie sécurisée est difficile sur un téléviseur, utilisez le parcours documenté d’association ou de compte plutôt que d’exposer les identifiants à l’écran.

**Résultat observable :** les champs obligatoires sont remplis sans secret exposé.

## Étape 5 : enregistrer une fois et laisser le premier chargement se faire

Dans le formulaire M3U, utilisez **Add** (Ajouter) une seule fois après vérification de l’URL. Pour Xtream, **Continue** ouvre **Provider access period** (Période d’accès au fournisseur). Les choix visibles sont **Duration bought** (Durée achetée), **Start and end dates** (Dates de début et de fin) et **Add this later** (Ajouter plus tard). Enregistrez uniquement les conditions que vous connaissez réellement ; elles sont distinctes de votre formule Norva.

Dans notre test, aucune date d’accès n’avait été fournie. Nous avons donc sélectionné **Add this later**, puis **Continue**, vérifié **Add later / No new dates** (Ajouter plus tard / Aucune nouvelle date) et utilisé **Finish without dates** (Terminer sans dates) une fois. Le compteur est passé de cinq étapes à trois pour ce parcours plus court. N’inventez pas de dates pour terminer la configuration.

![Choix de période d’accès Norva avec Add this later sélectionné et un compteur à l’étape deux sur trois.](/assets/blog/source-access-period-live-web-20260910.jpg "Parcours réellement testé : continuer sans enregistrer de période d’accès. Aucun achat, renouvellement ni rappel n’a été configuré dans ce parcours.")

Norva a ensuite ouvert **Preparing your catalog** (Préparation de votre catalogue), affiché **Importing** (Importation en cours) et marqué le contrôle de connexion **Done** (Terminé). Le nombre de titres détectés a commencé à augmenter alors que la préparation continuait. Ce sont des observations distinctes : des identifiants acceptés ne signifient pas que chaque titre est déjà prêt à être lu.

![Panneau de préparation du catalogue Norva pour une source de test au nom neutre, avec Importing et des étapes distinctes de connexion et de catalogue.](/assets/blog/source-importing-live-web-20260910.jpg "Un véritable état intermédiaire d’import, pas un catalogue terminé. Les nombres et la progression reflètent cette source de test au moment de la capture ; ils ne promettent ni vitesse ni capacité.")

Le lecteur peut avoir besoin de temps pour récupérer les catégories, les informations du catalogue ou les données du guide. Ne soumettez pas ou ne retirez pas la source à répétition pendant un chargement normal.

Aucun temps de chargement universel ne peut être promis. La taille de la source, la connexion et l’appareil peuvent influencer le premier résultat.

**Résultat observable :** Norva accepte les paramètres ou présente une erreur précise que vous pouvez consigner.

## Étape 6 : vérifier un élément connu

Lorsque la bibliothèque atteint un état stable :

1. vérifiez la grande rubrique attendue ;
2. ouvrez une catégorie attendue ;
3. recherchez un élément connu ;
4. vérifiez son titre, son année ou l’identité de l’épisode lorsque ces informations existent ;
5. examinez les informations linguistiques ou de sous-titres fournies par la source ;
6. ne supposez pas que l’absence de métadonnées facultatives signifie l’échec de toute la connexion.

Choisissez, par exemple, un titre dont le propriétaire confirme la présence. Si sa catégorie charge mais que le titre n’apparaît pas, notez ce résultat précis. S’il apparaît mais ne se lit pas, le chargement du catalogue a réussi ; la lecture nécessite encore une vérification distincte. Aucune de ces observations ne prouve que toute la source fonctionne ou est défaillante.

**Observé lors du suivi :** la même source était marquée **Ready** dans **Settings → TV Service**. Nous avons ouvert **Movies**, sélectionné **Blog walkthrough test** dans **Source**, puis utilisé **Audio language → Albanian** (Langue audio → Albanais). Les fiches renvoyées affichaient **Albanian**. Après **Clear all** (Tout effacer), la recherche d’un titre connu a ouvert ses détails avec douze versions, une année et un résumé. Aucune source dupliquée ni nouvelle soumission manuelle n’a été nécessaire.

![Filtres des films Norva avec la source de test et l’audio albanais sélectionnés, ainsi que des contrôles distincts pour les catégories et les sous-titres.](/assets/blog/catalog-audio-filter-live-web-20260910.jpg "Suivi après le passage de la source à Ready, le 10 septembre 2026. Le nombre affiché est un instantané de la source de test de cet utilisateur, pas une promesse sur le contenu de Norva ou sa capacité de catalogue.")

### Ne pas confondre un libellé de source avec une piste audio vérifiée

Le filtre audio actuel réunit dans une même commande de navigation les libellés linguistiques reconnus et les informations de pistes détectées dans les fichiers. Un libellé de source peut donc aider à trouver une version, mais un pays, un nom de collection ou un préfixe de titre ne devient pas pour autant une preuve des pistes contenues dans ce fichier. Lorsque des informations réelles sur les pistes sont disponibles, utilisez-les pour choisir la version. Une indication régionale comme **Nordic languages** (Langues nordiques) n’identifie pas une langue parlée précise.

Vérifiez chaque niveau séparément :

| Résultat visible | Ce qu’il établit | Ce qui reste à vérifier |
|---|---|---|
| La source affiche Ready | Norva signale que le catalogue est prêt | Les métadonnées et la compatibilité de lecture de chaque élément |
| Un titre apparaît sous la source sélectionnée | L’élément est trouvable dans le catalogue actuel | Les autres éléments et la version sélectionnée |
| Une catégorie de source apparaît | Un libellé de regroupement a été reçu | La disponibilité d’un genre cinématographique vérifié |
| Un filtre de langue renvoie une version | Les informations linguistiques disponibles correspondent au filtre | Les pistes réellement sélectionnables dans ce fichier et ce lecteur |
| Language unidentified (Langue non identifiée) | Aucun résultat de langue audio exploitable n’est affiché | La disponibilité réelle des pistes et l’état de l’analyse |
| La page du lecteur s’ouvre | La navigation vers le lecteur fonctionne | Les images vidéo, l’avancement de la lecture et un audio utilisable |

Le dernier suivi a testé la navigation du catalogue, pas la lecture vidéo. Une tentative antérieure pendant la configuration a ouvert le lecteur sans établir que la vidéo avançait avant le retour par **Back** (Retour). Nous ne présentons donc pas l’état Ready, les badges de langue ou les visuels comme la preuve d’une session de visionnage réussie.

## Étape 7 : tester une action du compte

Ajoutez un favori ou enregistrez une petite progression de lecture. Revenez à la bibliothèque et confirmez l’état visible.

Cela teste la distinction entre les données de source et le contexte du compte. Cela ne prouve pas la compatibilité de tous les éléments, formats ou appareils.

Notre favori de test était présent à une réouverture ultérieure du catalogue. Nous l’avons ensuite retiré et avons rechargé pour confirmer l’état initial. Le retour immédiat depuis la fiche n’avait pas montré l’état actualisé : cette observation valide donc la persistance de cet élément, pas un retour visuel instantané ni la synchronisation entre appareils.

Le plan plus large de première session figure dans [Bien démarrer avec Norva](/blog/norva-getting-started/).

## Si la connexion est partielle

Un résultat partiel est plus instructif que « ça ne fonctionne pas ». Notez le niveau qui a réussi :

- Les paramètres ont-ils été acceptés ?
- Des catégories sont-elles apparues ?
- Les titres ont-ils chargé, mais pas les visuels ?
- Les informations du catalogue ont-elles chargé alors que les données du guide restent vides ?
- Un élément connu s’est-il ouvert ?
- La lecture a-t-elle échoué sur un seul appareil ?

Modifiez une variable à la fois. Revérifiez les informations de source avant de réinstaller l’application. Conservez une capture expurgée de l’erreur uniquement après avoir confirmé qu’elle ne contient aucun identifiant de connexion.

## Sécurité et nettoyage du compte

Après une configuration réussie :

- examinez les appareils de confiance ;
- retirez ceux que vous ne contrôlez plus ;
- gardez les informations de source privées ;
- notez où consulter l’autorisation et les conditions ;
- déconnectez la source si l’autorisation prend fin ;
- modifiez les identifiants exposés par la procédure officielle du propriétaire.

Les pages de confidentialité et de suppression de compte de Norva décrivent les contrôles disponibles pour les données du compte Norva.

## Limites

Une connexion réussie ne signifie pas que tous les champs de source sont complets, que tous les formats multimédias fonctionnent sur tous les appareils ou que l’accès hors connexion est disponible. Les langues et sous-titres dépendent de la source et du média. L’usage hors connexion dépend de l’appareil, de la source et des droits associés.

Les éléments de preuve couvrent les commandes Web actuelles, un envoi Xtream, un état Ready ultérieur, le filtrage audio propre à la source, la recherche et les détails d’un titre, ainsi que la persistance et le retrait d’un favori après réouverture. Ils n’établissent pas que chaque fiche du catalogue est complète ou lisible. La lecture réussie et le retour visuel immédiat des favoris n’ont pas été validés. Ce test Web n’a validé aucun import M3U, parcours natif téléphone/TV, usage hors connexion ni continuité entre appareils.

## Questions fréquentes

### Pourquoi n’ajouter qu’une seule source au départ ?

Cela fournit une référence claire. Si une catégorie, un titre ou une erreur apparaît, vous savez quelle source en est à l’origine.

### Faut-il partager une capture de connexion avec l’assistance ?

Uniquement après avoir masqué chaque mot de passe, lien privé, nom d’utilisateur, jeton et identifiant personnel. Utilisez le canal officiel d’assistance Norva.

### Que faire si Norva accepte les paramètres mais que rien n’apparaît ?

Attendez le chargement initial normal, puis vérifiez les informations et la connexion. Notez si le résultat est entièrement vide ou partiellement chargé avant de contacter l’assistance.

## Votre prochaine étape

[Ouvrir Norva et connecter votre source](https://norva.tv/app)

Après connexion, utilisez le menu du compte, **Settings**, puis **TV Service**, comme indiqué ci-dessus.

## Sources

- [Fonctionnement de Norva](https://norva.tv/#how-it-works)
- [Conditions d’utilisation de Norva](https://norva.tv/terms)
- [Politique de confidentialité de Norva](https://norva.tv/privacy)
- [Assistance Norva](https://norva.tv/support)
