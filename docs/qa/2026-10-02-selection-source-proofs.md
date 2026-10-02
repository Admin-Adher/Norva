# Norva Selection — années sources, saisons et correspondances ambiguës

## Résultat vérifié en production

Cette passe complète [le précédent rapport](2026-10-02-selection-editorial-remainder.md). Elle concerne le catalogue commun publié `b5bd1b07-3692-421a-bd8a-40c64a29b4ec` : **6 159 films et 273 séries**. Elle ne clôture pas l'objectif commercial complet.

**34 fiches supplémentaires corrigées globalement** : 31 associations nouvelles ou remplacées, 9 affiches récupérées et 34 synopsis de secours supplémentaires. La [liste des corrections](2026-10-02-selection-source-corrections.json) conserve les titres fournisseurs, les identités officielles et les types de preuves, sans données privées.

Mesure du **2 octobre 2026 à 18:39:28 UTC** :

| Manque | Avant | Après |
| --- | ---: | ---: |
| Films sans affiche | 153 | **144** |
| Films sans synopsis de secours | 646 | **615** |
| Séries sans synopsis de secours | 43 | **40** |
| Films sans identifiant TMDB | 603 | **578** |
| Séries sans identifiant TMDB | 42 | **40** |
| URL TMDB d'affiche malformée | 0 | **0** |

Le catalogue demeure incomplet. Les traductions dans les dix langues restent également incomplètes : une traduction officielle disponible dans une autre langue n'est jamais présentée comme une nouvelle traduction française.

## Causes et preuves supplémentaires

1. **Découverte de candidats trop limitée.** La recherche antérieure téléchargeait les fiches exactes et trois candidats supplémentaires ; elle pouvait s'arrêter au premier locale contenant une fiche homonyme vide. La nouvelle passe parcourt les locales, conserve jusqu'à 24 candidats pertinents et refuse de choisir dans un résultat tronqué. La ressemblance de titre sert uniquement à rechercher des candidats.
2. **Années brutes non exploitées.** 541 des 697 fiches candidates possèdent au moins une année dans le média source. Elle doit être égale à l'année du groupe original du fournisseur. Cette preuve n'utilise ni une année héritée d'un ancien enrichissement ni la date d'import.
3. **Année de saison différente de celle de la série.** La saison 2 de « Special Ops » provient du groupe 2025, alors que la série officielle commence en 2020. La comparaison avec la saison officielle 2, datée du 18 juillet 2025, départage la vraie série de la fiche homonyme vide.
4. **Ponctuation et fautes.** Les alias compacts restent exacts et conservent les caractères de suite. Pour une faute d'un seul caractère dans un titre suffisamment long, ou un sous-titre abrégé, une durée réelle supplémentaire est exigée. Les numéros et marqueurs romains sont conservés. Une durée absente ou plusieurs durées compatibles maintiennent l'incertitude.

| Titre fournisseur | Identité officielle | Preuve |
| --- | --- | --- |
| 192021 | 19.20.21, 1094599 | Alias compact et année source 2023 |
| 711 Pm | 7:11 PM, 1150089 | Alias compact et deux variantes sources de 2023 |
| As Aventuras de TimTim | The Adventures of Tintin, 17578 | Faute d'un caractère ; fichier mesuré à 6 411,822 s, contre 107 min officielles |
| Os Penguins de Madagascar | Penguins of Madagascar, 270946 | Alias compatible et fichier de 5 539,617 s, contre 92 min officielles |
| Pi Meena | P.I. Meena, 201089 | Alias compact, année source 2023 et saison 1 officielle |
| Chachi No1 | Chachi No.1, 237560 | Alias compact, deux parties de saison 1 et année source 2023 |
| Special Ops | Special Ops, 100612 | Alias, saison 2 et année 2025 ; remplace la fiche vide 52001 |

La recherche officielle utilise les titres originaux, traduits et alternatifs. Une passe complémentaire a interrogé les trois années compatibles pour 26 films dont les recherches étaient tronquées. [Référence de l'API TMDB](https://developer.themoviedb.org/reference/search-movie).

## Application, isolation et références

- Migration **`20261002193000_selection_source_unit_evidence.sql`** installée en production. Le writer reste réservé au service. Les nouvelles preuves vérifient le média source exact, son année, son groupe, sa saison et son appartenance à l'identité du manifeste. Les durées doivent correspondre au fichier public exact et à une durée officielle positive, à 90 secondes près.
- Les contrôles préexistants restent actifs : manifeste, CAS des métadonnées attendues, confiance, identifiants déjà rejetés, isolation et exclusions des fiches manuelles ou privées.
- Deux lots appliqués : **25 et 9 fiches**. Empreintes des médias publics, des variantes et de la release inchangées pendant l'application.
- **789 fiches propriétaires actualisées**, 47 sources actives couvertes, sources masquées exclues. Deux tours sans nouvelle écriture : 100 visites pour 47 sources. Le rafraîchissement sait maintenant attendre le verrou de maintenance et reprendre ses reçus sans remplacer la sauvegarde initiale.
- Inventaires propriétaires inchangés durant ce rafraîchissement : **374 953 médias**, empreinte `c215c5d6f0f70ff65dee9a2601e2ad0e` ; **348 114 variantes**, empreinte `f869c086bce37a4e525f3a024db5b5b3`. Ces empreintes certifient cette fenêtre, pas l'absence de toute activité de catalogue entre les rapports.
- Aucune modification du lecteur, du frontend ou des applications Android dans cette passe. Le contrat SQL et les données communes sont déjà actifs ; la correction ne dépend pas d'une prochaine version Android ni d'une admission pilote.

## Vérifications réussies

- **22 tests Python** : découverte sans arrêt sur une fiche vide, exactitude des alias, conflits d'années et de variantes, année de saison, suites numériques et romaines, garde sur les fautes et playlist HLS terminale sans téléchargement des segments.
- Deux essais PostgreSQL réels sur `norva_selection_editorial_gap_qa_20261002`, terminés par rollback : nouveau contrat année/saison/durée et régression complète du writer. Les URL et médias étrangers, dates et durées incompatibles sont refusés ; fichiers, variantes, droits, CAS et exclusions propriétaires sont conservés. Les trois warnings lifecycle du montage synthétique préexistant ne font pas échouer la régression.
- **33 URL d'affiches distinctes** des 34 fiches répondent HTTP 200 avec un type `image/*`.
- **Compte QA ordinaire, navigateur de production** : recherche du libellé fournisseur « TimTim », affichage de la bonne fiche Tintin, affiche, titre et synopsis français, année 2011, 107 min, genres. Capture `.codex-artifacts/selection-source-proof-tintin-compact.png`.
- « Special Ops » présente la bonne série, les genres, la distribution, le synopsis officiel de secours et le bouton **Lire Saison 2**. Capture `.codex-artifacts/selection-source-proof-special-ops.png`.
- Aucune certification de lecture vidéo, de FPS ou de performance Android supplémentaire n'est revendiquée pour ces contrôles de fiches.

## Ce qui demeure à revoir

Le plan initial de cette passe conserve 663 lignes sans modification : 428 sans alias confirmé, 143 sans année source vérifiée, 30 résultats tronqués, 27 conflits ou années sources insuffisantes, 1 homonymie encore ambiguë, 30 identités confirmées sans nouvelle donnée officielle et 4 identifiants déjà rejetés nécessitant une revue distincte. Ces catégories ne sont pas une somme d'affiches et de synopsis manquants.

Les 26 recherches ciblées par année ont produit deux candidats supplémentaires, **Accused** et **Undead**, qui **n'ont pas été appliqués**. Le premier a une date officielle différente du groupe source ; le second est un court métrage de dix minutes, insuffisamment confirmé par le libellé du fournisseur. Vingt contrôles complémentaires d'en-tête sur les liens intermédiaires Babuperumana n'ont fourni aucune durée exploitable. Une absence de durée ne prouve ni une fausse identité ni une panne durable de lecture dans l'application.

Les quatre réassociations protégées sont « Minha Mãe e Uma Peca 3 », « New Year Blue », « Now You See Me Now You Dont » et « Prisons ». L'historique des rejets est conservé ; aucun seuil de confiance n'a été abaissé pour remplir les fiches.

**L'absence d'alias confirmé ne prouve pas une absence de TMDB.** La portée de cette passe est une nouvelle réduction documentée des manques, avec maintien des cas non établis. Ni les 144 affiches ni les 655 synopsis encore manquants ne sont déclarés résolus.

## Empreintes et reçus

- Entrée de recherche : `d1150b3a15c0932e62a510c1f36ba15725635891b386b957993866818a685f41`.
- Entrée avec unités sources : `05c38bda1e9d19096c7c0186e1e36f5a6f66ef21f13b713f3adc53030fbfdf59`.
- Plan appliqué : `a6cea27c434e9d280958faf3f9c96fb7e45d0b1f7151c6c51798867010869424`.
- Catalogue après application : `e469ec19b52e4b9787ceec7d3be08df5cdd33752aaf00e9780c4787006d56e0f`.
- Writer installé : `dc3f8b2f54cfee3439ebb60940754f8f7f944682140cab543932e3eb0a1fb47a`.
- Hôte : `/home/adrien/.norva/selection-tmdb-audit-20261002/deeper-search/` ; sous-dossier `year-narrow/` distinct, aucun plan antérieur remplacé. Copies sûres locales : `.codex-artifacts/selection-source-proofs/`.
