# Préparation VOD longue : choix explicite de récupération — 9 octobre 2026

## Périmètre

L'observation d'une préparation continue de 45 secondes affiche une proposition dans WatchPage : continuer à préparer cette copie ou ouvrir les autres versions. Ce délai est un choix d'interface, pas une preuve de débit insuffisant ni une attribution au fournisseur. Le traitement en cours et les réserves de démarrage restent inchangés. Le parcours couvre les films et épisodes du lecteur Web ; les lecteurs natifs Android ne sont pas modifiés.

Le choix de rester masque la proposition pour cette attente. Le choix des versions invalide d'abord la tentative et sa résolution tardive, ferme strictement la session et attend la libération ordinaire avant de lire les versions possédées. Aucune lecture alternative automatique. Pour une série, on retrouve la série exacte et choisit ensuite version et épisode ; aucun identifiant d'épisode, indice de piste ou point de reprise n'est transposé à une autre copie.

Navigation, changement de compte, déconnexion, nouveau saut et disponibilité de la lecture annulent la proposition. Une erreur de fermeture ou de recherche conserve une récupération explicite et ne marque pas le fichier comme refusé. Les observations ne sont pas enregistrées dans la santé fournisseur.

## Vérifications avant intégration

- 76 tests Node ciblés réussis, dont neuf nouveaux contrôlant attente, annulation, double clic, échec du drainage et appartenance de la série.
- Banc navigateur sans fournisseur : vrai HTML, CSS et WatchPage ; fermeture et réponse du catalogue simulées. Parcours exécuté à 360 × 800 et 844 × 390. Ce banc ne mesure aucun débit ni délai de lecture réel.
- Traductions des cinq messages dans les dix langues ; bundle et références générés par l'outil i18n habituel. Les changements des autres pages HTML sont exclusivement les empreintes du bundle i18n.
- Instrumentation WebView ajoutée : fenêtres visibles portrait/paysage, textes 100/130 %, français/arabe, films/séries, démarrage/rebuffering, fermeture avant transfert, Retour et changement de propriétaire. Matrice Android et CI restent à observer.

## Limites

Aucune réparation réseau revendiquée. Aucun nouveau relais configuré, aucune baisse des réserves, ni préchargement général. Les pilotes de cache restent dans leur périmètre actuel. Une préparation anticipée de fichiers lourds reste une piste à évaluer après comparaison des coûts de stockage, des pistes conservées et du bénéfice par rapport aux caches existants.

Le nouveau checkout isolé préserve les modifications éditoriales présentes dans le checkout historique. Son attachement Codex a été refusé à la limite de 100 ; aucune pièce supprimée.
