# Relecture indépendante des nouveaux libellés du hub — FR, ES et PT-BR

Date : 10 septembre 2026.

Relecteur : agent Codex `/root/blog_indic_arabic_translations`, indépendant de l’agent auteur `/root/blog_latin_translations`.

Conclusion : **avis favorable, sans défaut éditorial non résolu**. Les 35 nouvelles clés `hub*` ont été lues intégralement en anglais et dans chacune des trois traductions, soit 105 valeurs traduites. Aucun correctif n’est demandé.

Il s’agit d’une relecture éditoriale assistée par IA, pas d’une certification humaine ou de locuteur natif. Elle ne vaut pas validation du rendu, de l’accessibilité, du comportement de recherche, du déploiement ou de la production.

## Périmètre et méthode

Racine examinée : `C:/Users/AdrienHernandez/.codex/worktrees/norva-blog-i18n-20260910`.

Fichiers examinés :

- `content/blog/i18n/ui/en.json` : lecture intégrale des 35 valeurs source `hub*`.
- `content/blog/i18n/ui/fr.json` : lecture intégrale des 35 nouvelles valeurs françaises.
- `content/blog/i18n/ui/es.json` : lecture intégrale des 35 nouvelles valeurs espagnoles.
- `content/blog/i18n/ui/pt-BR.json` : lecture intégrale des 35 nouvelles valeurs portugaises du Brésil.

La revue compare le sens, le naturel, la concision des libellés, la cohérence des actions et thèmes, les textes accessibles et les états sans contenu ou sans résultat. Les titres ont également été relus après remplacement de `{accent}` par `hubTitleAccent`.

La comparaison automatisée initiale des anciennes valeurs repose sur `git show origin/main:<chemin>`, en lecture seule. Référence figée : `4b410072465819070c9e3b5f1ed680bca9c217b2`, valeur de `origin/main` lors de cette première vérification. Le contrôle du delta final conserve explicitement cette référence immuable. Aucun `fetch`, changement de référence, commit ou autre écriture Git n’a été effectué par ce relecteur.

Le contrôle des clés et variables a été fait directement, puis confirmé avec `loadUi` du module `scripts/blog/lib/localization.js`.

## Constat linguistique et fidélité

Français : les libellés de navigation, recherche, filtres et catégories sont naturels. « Médiathèque » forme un fragment de titre cohérent avec « votre ». Les observations éditoriales, les états vides et les indications de tri gardent le sens de la source.

Espagnol : « biblioteca multimedia » s’intègre naturellement au grand titre. Les verbes d’action, les états de recherche et les thèmes restent cohérents. « Notas de campo » reprend l’expression éditoriale anglaise sans promettre de résultats produit supplémentaires.

Portugais du Brésil : « biblioteca de mídia » s’intègre naturellement au titre. La terminologie de lecture, recherche et accessibilité est claire ; les formulations d’action correspondent à l’usage brésilien.

Dans les trois langues, `hubCadence` décrit la configuration, l’organisation et la lecture. Aucun rythme de publication régulier n’est promis. Les états annonçant de nouveaux guides reprennent la seule attente formulée dans l’anglais, sans ajouter de fréquence ou de date.

Les descriptions restent centrées sur la bibliothèque personnelle, la lecture, les appareils et l’usage de Norva. Elles ne changent pas le positionnement du produit ni ne promettent de catalogue inclus. Les anciens avertissements restent identiques à la référence.

## Titres interpolés relus

| Langue | Titre après remplacement de l’accent |
|---|---|
| fr | Un guide pratique pour votre médiathèque |
| es | Un manual práctico para tu biblioteca multimedia |
| pt-BR | Um guia prático para sua biblioteca de mídia |

Chaque `hubTitle` conserve exactement un `{accent}`. Chaque `hubTitleAccent` fournit un fragment substantif adapté au titre complet.

## Variables et compteurs

Les ensembles de variables correspondent exactement à l’anglais pour chacune des 105 nouvelles valeurs :

- `{accent}` dans `hubTitle`.
- `{title}` dans `hubReadLatest`.
- `{count}` dans `hubCount`, `hubResults` et `hubRemaining`.

Aucune variable n’est supprimée, renommée, dupliquée ou introduite. Les interpolations de titre et d’intitulé du dernier guide ne laissent pas de variable non résolue.

Les trois compteurs de chaque langue ont été examinés après substitution de **0, 1 et 7**. Il s’agit d’étiquettes de catégories suivies d’un nombre, et non de phrases dont le nom situé après ce nombre devrait changer de nombre grammatical. Leur forme invariante est acceptable pour 0/1/n ; « plus récents d’abord » et ses équivalents sont des indications de tri.

| Langue | Publication | Résultats | Guides supplémentaires et ordre |
|---|---|---|---|
| fr | Guides publiés : {count} | Guides trouvés : {count} | Autres guides : {count} · plus récents d’abord |
| es | Guías publicadas: {count} | Guías encontradas: {count} | Más guías: {count} · más recientes primero |
| pt-BR | Guias publicados: {count} | Guias encontrados: {count} | Mais guias: {count} · mais recentes primeiro |

Exemples au singulier : « Guides publiés : 1 », « Guías publicadas: 1 » et « Guias publicados: 1 » restent des étiquettes de compteur, comme leurs formes à 0 et à 7.

## Anciennes chaînes et intégrité du périmètre

| Langue | Anciennes valeurs comparées | Anciennes valeurs modifiées | Nouvelles clés ajoutées | Total actuel |
|---|---|---|---|---|
| fr | 40 | 0 | 35 | 75 |
| es | 40 | 0 | 35 | 75 |
| pt-BR | 40 | 0 | 35 | 75 |

Résultat : **120 anciennes valeurs sur 120 sont strictement identiques** à celles de la référence `origin/main` indiquée plus haut. Les ajouts correspondent exactement aux 35 clés `hub*` anglaises, sans clé manquante ou supplémentaire. `loadUi` confirme 75 clés valides par langue et la conservation de toutes les variables.

Le relecteur n’a modifié aucun dictionnaire de traduction, article, code, registre de revue ou état publié. La seule écriture de cette relecture est le présent rapport.

## Liste exacte des nouvelles clés lues

- `hubTitle`
- `hubTitleAccent`
- `hubDescription`
- `hubCount`
- `hubCadence`
- `hubExplore`
- `hubLatest`
- `hubReadLatest`
- `hubImageAlt`
- `hubEmpty`
- `hubRecent`
- `hubRecentDescription`
- `hubLibrary`
- `hubLibraryDescription`
- `hubSearchLabel`
- `hubSearchPlaceholder`
- `hubSearchHint`
- `hubClear`
- `hubClearLabel`
- `hubFilterLabel`
- `hubAll`
- `hubReset`
- `hubResults`
- `hubRemaining`
- `hubNoResults`
- `hubNoResultsHint`
- `hubBrowseAll`
- `hubMore`
- `hubFallbackTopic`
- `hubStart`
- `hubOrganise`
- `hubAnywhere`
- `hubPlayback`
- `hubAccessibility`
- `hubPrivacy`

## Révision ciblée des exemples de recherche

À la demande du parent, l’exemple anglais a été remplacé par `Try “Norva”, “subtitles”, or “resolution”` : les anciens exemples TV et confidentialité ne garantissaient pas de résultat dans la sélection locale de sept cartes.

Le relecteur a ensuite lu et validé le seul delta `hubSearchPlaceholder` dans la source anglaise et les trois traductions :

- Français : `Essayez « Norva », « sous-titres » ou « résolution »`.
- Espagnol : `Prueba «Norva», «subtítulos» o «resolución»`.
- Portugais du Brésil : `Experimente “Norva”, “legendas” ou “resolução”`.

Les trois formulations sont naturelles, fidèles à la nouvelle source et dépourvues de variable dynamique. Les 34 autres nouvelles clés restent identiques à la première relecture ; les 40 anciennes valeurs restent identiques à la référence figée indiquée plus haut. Les 74 autres valeurs de chacun des quatre dictionnaires EN/FR/ES/PT-BR sont ainsi inchangées.

Le contrôle reprend la normalisation et la tokenisation lues dans `public/js/blog-index.js` : minuscules selon la langue, normalisation NFD, suppression des marques U+0300–U+036F, espaces extérieurs retirés, puis présence de chaque mot de la requête. Seuls les titres, extraits et thèmes des sept cartes sont utilisés ; aucun corps d’article n’entre dans cette vérification. Les champs ont été rapprochés du rendu des cartes dans `scripts/blog/lib/templates.js`.

| Langue | Exemple | Cartes correspondantes dans ces champs | Identifiants |
|---|---|---|---|
| en | Norva | 3 | 014, 015, 089 |
| en | subtitles | 1 | 522 |
| en | resolution | 1 | 562 |
| fr | Norva | 3 | 014, 015, 089 |
| fr | sous-titres | 1 | 522 |
| fr | résolution | 1 | 562 |
| es | Norva | 3 | 014, 015, 089 |
| es | subtítulos | 1 | 522 |
| es | resolución | 2 | 089, 562 |
| pt-BR | Norva | 3 | 014, 015, 089 |
| pt-BR | legendas | 1 | 522 |
| pt-BR | resolução | 1 | 562 |

Résultat : **12 exemples sur 12 retrouvent au moins une carte**, dont 9 exemples traduits sur 9. En espagnol, « resolución » correspond aussi au thème de dépannage du guide 089 ; le guide 562 attendu est également trouvé. Ce contrôle est une validation locale des exemples et du mécanisme de correspondance, pas un test navigateur ou une preuve de production.

Avis final après ce delta : **favorable, sans correctif restant**. Les empreintes ci-dessous ont été actualisées et couvrent ces derniers exemples.


## Empreintes des fichiers relus

SHA-256 des fichiers complets, avec les fins de ligne CRLF normalisées en LF. Les chemins sont relatifs à la racine du dépôt donnée plus haut.

| Fichier | SHA-256 normalisé LF |
|---|---|
| `content/blog/i18n/ui/en.json` | `f76bd921b22a194c15fd5e43f102bd20a854495e45318073917de80b11bc2ad5` |
| `content/blog/i18n/ui/fr.json` | `ed1c5332f3bc6441c287064006c9338e4b8435141666fd8e5f14ab064230da5c` |
| `content/blog/i18n/ui/es.json` | `501f0428e33fe9735def0f04b4833eee6e0d1ddd8643d20fadb77763d984bd17` |
| `content/blog/i18n/ui/pt-BR.json` | `19b3452d9681ec0cba964a82d005aba2267619922a2bf7424c4e8101d5df03e5` |

Ces empreintes identifient précisément le contenu couvert par cet avis. Une modification ultérieure des chaînes ou de la source anglaise exige une nouvelle vérification ciblée et la mise à jour du rapport ou un addendum. Le parent conserve la responsabilité des validations de rendu, du registre final et de la publication.
