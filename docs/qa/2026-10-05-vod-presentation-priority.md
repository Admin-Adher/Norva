# Priorité aux fiches VOD renseignées — 5 octobre 2026

## Règle
Les mises en avant favorisent les fiches réunissant affiche, synopsis et langue audio renseignée ; viennent ensuite les fiches avec deux, un ou aucun critère. Les trois critères pèsent chacun un point ; à égalité, les préférences et l'ordre précédent départagent. Une affiche de remplacement, un synopsis vide et une langue déduite du nom, du pays ou des sous-titres ne comptent pas. Les déclarations audio structurées du fournisseur, les observations acceptées et les confirmations humaines conservent leurs provenances distinctes.

Le classement ne change ni version sélectionnée, ni piste, ni langue, ni preuve. Tous les candidats restent disponibles. La présence d'une URL d'affiche ne garantit pas sa disponibilité réseau.

## Surfaces et bornes
- Accueil : suggestions réordonnées avant la limite d'affichage ; bandeau promotionnel choisi dans l'ensemble des candidats reçus avant la limite de six.
- Films et séries : rayons de genres, repli local des genres avant la limite de30, grilles par défaut et pages de genres par défaut.
- Reprise de lecture, Top10 fondé sur la popularité, Nouveautés, recherche et tris explicites gardent leur sens. Les critères de présentation ne départagent que les égalités d'un tri explicite.
- Le classement porte sur les candidats déjà autorisés et reçus. La pagination serveur, ses limites, les sources visibles et les contrôles de génération restent identiques. Il ne constitue pas un tri global de tous les fichiers non chargés et ne déclenche pas de scan supplémentaire ou d'appel fournisseur.

## Vérification
103 tests Node ciblés réussis : classement, inconnus, provenance humaine/fournisseur, absence de mutation, maintien des tris et recherche, rendu des rayons et filtres existants. La fixture Android catalogue utilise les véritables modules et vérifie aussi l'ordre des cartes après reclassement.

Une exécution locale du générateur général de hashes a modifié des références i18n non concernées ; contrôle i18n a détecté les références périmées. Toutes les modifications HTML de ce générateur ont été restaurées avant commit. La publication normale recalcule ses hashes. Le manifeste i18n des cinq fichiers applicatifs a ensuite été régénéré ; build et --check réussissent. Aucun changement de traduction ou de backend.

Navigateur local : véritable rendu GenreRails, ordre des langues connues, association carte/clic et dix badges vérifiés. Un ancien contrôle de fixture utilisait la position2 pour identifier le fichier arabe/français ; il utilise désormais son identité stable après tri. Ce défaut de test a été intercepté localement.

Deux matrices préparatoires ont été annulées :37276800767 (nom de méthode portrait incorrect dans la demande),37276849082 (fixture à corriger pour la nouvelle position). Matrice de référence37277001232, code applicatif inchangé, fixture corrigée078fcc9e5. Aucun échec produit n'est déduit de ces annulations.
