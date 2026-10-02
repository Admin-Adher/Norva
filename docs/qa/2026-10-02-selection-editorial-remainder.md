# Norva Selection — complément de correction des fiches

## Résultat en production

Catalogue commun publié `b5bd1b07-3692-421a-bd8a-40c64a29b4ec`, 6 159 films et 273 séries. Cette passe complète [l'audit initial](2026-10-02-selection-tmdb-audit.md), sans certifier les autres fournisseurs ni l'objectif commercial complet.

Mesure du **2 octobre 2026 à 17:57:54 UTC** :

| Manque | Avant cette passe | Après |
| --- | ---: | ---: |
| Films sans affiche | 189 | **153** |
| Films sans synopsis de secours | 697 | **646** |
| Séries sans synopsis de secours | 43 | **43** |
| Films sans identifiant TMDB | 650 | **603** |
| URL TMDB d'affiche malformée | 0 | **0** |

**55 fiches corrigées**, dont 51 associations nouvelles ou remplacées et 36 affiches récupérées. La baisse nette des synopsis manquants est de 51. Les comptes ordinaires utilisent ces données communes ; aucune liste de comptes pilotes n'a été ajoutée.

Le contrôle des titres courts, des suites et des homonymes a interrogé les alias officiels, les noms publics complets des fichiers et les noms des images du fournisseur. **66 sondes de durée**, toutes exploitables, ont permis de résoudre 25 identités. Une durée proche ne suffit pas seule : il faut aussi un alias compatible ou un préfixe conservant les mots et les numéros de suite. Une durée inconnue chez un concurrent ou plusieurs durées compatibles maintiennent l'ambiguïté.

Les images supplémentaires ont été recherchées par l'API officielle sans filtre de langue. Pour les identités déjà connues, aucune affiche supplémentaire récupérable n'a été trouvée. Les synopsis officiels disponibles seulement dans une autre langue restent des textes de secours : aucune traduction française ou dans les dix langues de Norva n'a été inventée.

## Corrections représentatives

| Libellé fournisseur | Identité retenue | Preuve complémentaire |
| --- | --- | --- |
| A Bela Adormecida | Dragon Ball: Sleeping Princess in Devil's Castle, 39145 | Nom public complet du fichier : Dragon Ball et château du diable ; le court métrage homonyme est écarté |
| Dupla Jornada | Day Shift, 755566 | Nom du fichier avec année 2022 |
| Ligacões Perigosas | Dangerous Liaisons, 968739 | Nom du fichier avec année 2022 |
| A Pequena Sereia | The Little Mermaid, 447277 | Nom du fichier avec année 2023, distinct de l'animation de 1989 |
| A Hora do Pesadelo 4 | A Nightmare on Elm Street 4, 10131 | Alias avec numéro de suite et durée réelle 5 595,053 s, contre 93 min sur TMDB |
| Arimapatti Sakthive | Arimapatti Sakthivel, 1330530 | Nom de l'image source complet et alias officiel ; libellé fournisseur tronqué |

## Déploiement, isolation et reprises

- Migration `20261002183000_selection_image_filename_evidence.sql` appliquée sur la base de production. Elle conserve les contrôles service-only, manifeste, génération, identité, métadonnées attendues, refus des identifiants rejetés et exclusions privées/manuelles du writer existant.
- Le nouveau type de preuve par image exige l'URL exacte de cette image dans le manifeste de ce titre. Le nouveau type par préfixe exige une durée bornée et l'URL de lecture exacte dans ce même manifeste. Un utilisateur authentifié ne peut appeler ce writer.
- Trois lots : 25, 25 et 5 fiches. Les empreintes des médias, variantes publiques et versions de release sont identiques avant/après.
- **2 217 fiches propriétaires existantes actualisées**, via le rafraîchissement canonique déjà installé. 47 sources actives examinées ; les sources masquées restent exclues. Deux tours complets sans nouvelle écriture ont été obtenus (100 visites sans écriture pour 47 sources).
- Inventaires physiques inchangés : **374 953 médias**, empreinte `03fd07134ab90a6359d3d0edc53d0210` ; **348 114 variantes**, empreinte `f60f0b16d34e8b513471ba2514d5f1ea`.
- Aucun changement de code du lecteur, du web, des Gateways ou des applications Android n'est nécessaire à cette correction de données commune. Les routes utilisent la même base de catalogue.
- Sauvegardes privées et reçus séparés dans `/home/adrien/.norva/selection-tmdb-audit-20261002/remainder/`. Les sauvegardes antérieures ne sont pas remplacées.

## Vérifications

- **14 tests Python réussis** : titres numériques, apostrophes, suites, homonymes, omission portugaise, conflit d'année, nom complet versus titre générique, image opaque, rejet d'image générique, secours linguistique et garde sur les durées inconnues ou proches.
- Test réel PostgreSQL sur `norva_selection_editorial_gap_qa_20261002`, terminé par rollback : preuves positives image/durée, refus d'URL étrangère, données attendues périmées, manifeste modifié, doublons, confiance faible, comptes différents, données privées/manuelles, droits et inventaires. Les trois warnings de projection lifecycle des comptes synthétiques restent ceux du montage QA ; le test du catalogue réussit.
- **Compte QA ordinaire dans le navigateur de production** : recherche « A Bela Adormecida », ouverture de la fiche correcte Dragon Ball, affiche réelle visible, synopsis français, année 1987, durée 45 min et genres. **Le même résultat reste affiché après rechargement complet.**
- Aucune nouvelle mesure FPS ni relecture Android vidéo n'est revendiquée pour cette passe de métadonnées.

## Limites réelles

Les 752 entrées de départ ne sont pas toutes réparables automatiquement. Après les contrôles, le plan laisse :

- 490 cas sans alias officiel confirmé par cette recherche ; cela **ne prouve pas** leur absence de TMDB ;
- 102 identités nécessitant encore une preuve indépendante suffisante ;
- 83 ambiguïtés non résolues ;
- 7 conflits entre le titre et le nom de l'image ;
- 13 identités confirmées dont les données officielles recherchées restent absentes ;
- 2 identifiants précédemment rejetés, qui nécessitent une revue distincte avant réassociation.

Cette répartition concerne les candidats du plan, pas une somme de synopsis/affiches manquants : une fiche peut cumuler plusieurs manques. Les 43 séries restent sans synopsis de secours. Plusieurs titres fournisseurs sont incomplets ou absents des résultats officiels contrôlés. Il n'est pas établi que toutes les autres associations du catalogue sont correctes.

Le chiffre d'affiches mesure un champ exploitable et sa structure. Il ne certifie pas la disponibilité HTTP future de toutes les anciennes images. Les traductions disponibles restent incomplètes dans les dix langues.

## Empreintes des preuves

- Entrée figée : `0af4c72ed222482d6dfebac365b93853b2549e3ec59b6931916bd9c4cab36307`.
- Plan appliqué : `bcc820d3595c73314a9870c3d84e2d5ce344dd5cf272283ce8df7bcc2c3ca8a2`.
- Catalogue public après correction : `972ac5842ece3d04f7f4b28d0da79bbe3626ef1e9bc3cef7f5373e79a13beb97`.
- Reçus : `applied.safe.json`, `owners.safe.json`, `final.safe.json`, `closure.safe.json` dans le dossier de preuve hôte ; copies locales sûres dans `.codex-artifacts/selection-remainder-*`.
