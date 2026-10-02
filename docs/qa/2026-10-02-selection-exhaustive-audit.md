# Norva Selection — audit de toutes les fiches VOD

Date : 2 octobre 2026. Inventaire initial figé à 19 h 15 UTC ; données finales relues à 21 h 32 UTC après application et contrôle du rafraîchissement en arrière-plan.

## Résultat

**Les 6 432 fiches ont été examinées : 6 159 films et 273 séries. Aucune fiche n'a été exclue parce qu'elle avait déjà une affiche, un synopsis ou un identifiant TMDB.**

**292 fiches distinctes ont reçu une correction en production : 262 corrections éditoriales confirmées et 30 restaurations d'affiches après un rafraîchissement dégradant.** Ces restaurations ne certifient pas les deux identités encore incertaines qu'elles comprennent. L'audit complet conserve les cas non établis ; le catalogue demeure incomplet et ses 6 432 identités ne sont pas toutes certifiées.

- 157 fiches corrigées lors de la réconciliation des identités et des métadonnées.
- **98 identifiants existants corrigés et 5 identifiants rétablis ou ajoutés**, soit 103 associations nouvelles ou différentes.
- **145 affiches existantes remplacées**, 2 affiches ajoutées et 2 affiches d'un autre contenu retirées sans substitution incertaine.
- **108 synopsis officiels supplémentaires dans leurs langues réelles**, sur 106 fiches : 31 français, 40 espagnols, 9 portugais et 28 arabes. Une fiche participe aux deux corrections ; le nombre de fiches distinctes reste 262.
- Quatre réassociations précédemment rejetées ont une preuve indépendante supplémentaire et conservent leur historique.
- Le nombre public de saisons de Game of Thrones, retiré par l'ancienne liste de champs autorisés, a été rétabli et son maintien est maintenant couvert par le contrat SQL.
- **30 affiches TMDB contrôlées ont été rétablies** : une maintenance du cache les avait remplacées par des images fournisseur malgré un identifiant inchangé. La préférence d'image conserve maintenant l'affiche officielle existante lorsque le cache propose une image fournisseur. Les deux changements supplémentaires vers une nouvelle image TMDB ont été contrôlés et conservés.
- Trois fiches déjà corrigées avaient aussi reçu des champs différents d'un cache ultérieur, dont l'affiche de **O Terno de Dois Bilhães de Dólares**. Elles ont été restaurées après un rollback QA complet. La maintenance préserve désormais les champs remplis des fiches explicitement réexaminées, tout en remplissant les nouveaux champs vides.

## Inventaire complet et détails des corrections

Fichiers versionnés dans `docs/qa/` :

- `2026-10-02-selection-exhaustive-inventory.json` : **6 432 lignes**, avec titre fournisseur, type, clé stable, ancien et nouvel identifiants, état de la preuve, raison restante, contrôle de l'affiche, présence du synopsis et couverture linguistique. Aucun identifiant de compte, accès fournisseur ou URL de lecture privée n'y figure.
- `2026-10-02-selection-exhaustive-corrections.json` : toutes les actions des plans appliqués, y compris les associations erronées déjà renseignées, les traductions récupérées et les restaurations d'affiches sans changement d'identité.

L'inventaire a été relu après application depuis la base de production. Les identifiants, affiches et champs éditoriaux attendus de chaque correction ont été comparés avec les données réellement enregistrées.

## État mesuré du catalogue après correction

| Mesure | Avant | Après |
| --- | ---: | ---: |
| Films sans affiche | 144 | **142** |
| Séries sans affiche | 0 | **2** |
| Films sans synopsis de secours | 615 | **609** |
| Séries sans synopsis de secours | 40 | **40** |
| Films sans identifiant TMDB | 578 | **573** |
| Séries sans identifiant TMDB | 40 | **40** |

Les deux nouvelles absences d'affiche concernent **Besharam** et **Sona** : leur ancienne affiche appartenait à un autre contenu, et aucune affiche officielle utilisable n'a été obtenue pour la série confirmée. Elles ne sont pas remplacées par une image d'un homonyme.

### Affiches déjà présentes

Les **6 025 URL distinctes présentes dans l'inventaire initial** ont été contrôlées par requête HTTP, type de contenu et signature d'image. Les images proposées par les corrections ont reçu le même contrôle.

Après correction, à l'échelle des fiches :

| État de l'URL d'affiche | Fiches |
| --- | ---: |
| Réponse image HTTP 200/206 et signature reconnue | 6 280 |
| Champ d'affiche absent | 144 |
| URL confirmée absente, HTTP 404/410 | 4 |
| Accès refusé, HTTP 403 | 1 |
| Résultat réseau non établi après nouvelles tentatives | 3 |

Les quatre URL absentes appartiennent à **Lilo e Stitch 2**, **Uru**, **Nede Vidudala** et **Hunter**. L'accès à **Green** est refusé ; **The Trial**, **Rango** et **Kerala Crime Files** restent indéterminés sur ce contrôle réseau. Un refus ou un délai réseau ne prouve pas une fausse identité.

Une URL qui sert une image ne certifie pas, à elle seule, que cette image appartient au bon film : le résultat d'identité de chaque fiche reste indiqué séparément.

### Identités et correspondances encore non établies

| Résultat de la revue | Fiches |
| --- | ---: |
| Identité existante confirmée | 4 589 |
| Identité différente ou nouvellement établie | 103 |
| Identité non certifiée | **1 740** |
| Total examiné | **6 432** |

Les 1 740 cas non certifiés comprennent des fiches déjà renseignées. Ils ne correspondent pas au nombre de synopsis ou d'affiches manquants.

| Motif restant | Fiches |
| --- | ---: |
| Plusieurs homonymes compatibles | 616 |
| Aucun alias officiel confirmé avec les éléments disponibles | 582 |
| Preuve indépendante du média insuffisante | 185 |
| Recherches encore tronquées, dont 30 après recherche par année | 136 |
| Conflit d'identité, d'année, de libellé ou d'image avec le manifeste original | 193 |
| Candidat trop court ou vide nécessitant une preuve du fichier | 26 |
| Plusieurs films distincts dans un même groupe de variantes | 2 |

Les deux derniers groupes de variantes concernés sont **A Múmia** et **Mortal Kombat**. Les durées qualifiées des fichiers indiquent des identités différentes au sein du groupe. Une fiche unique ne doit pas être imposée à tous ces fichiers ; leur séparation nécessite une correction du regroupement et de ses liens de reprise.

Les **29 films dont l'identité est confirmée mais qui restent sans synopsis de secours** n'ont pas reçu de texte inventé. L'absence d'alias confirmé ou de synopsis exploitable dans cette revue ne constitue pas une preuve d'absence du film dans TMDB.

## Vérification des dix langues

Le contrôle porte sur `fr`, `en`, `pt`, `es`, `hi`, `tr`, `bn`, `ar`, `id` et `tl` ; le code d'interface filipino `fil` correspond à `tl` dans TMDB.

Un défaut réel a été découvert dans la fusion des traductions régionales : une traduction française canadienne vide, par exemple, pouvait masquer une traduction française française remplie. La sélection tient maintenant compte des régions préférées et conserve les champs remplis d'une autre région quand la région préférée ne les fournit pas. Les synopsis récupérés restent dans leur langue officielle.

**Aucune traduction officielle disponible dans les dix langues contrôlées ne reste manquante pour les 4 692 identités confirmées.** La présence de champs dans les autres fiches ne certifie pas leur association. Les traductions déjà remplies ont été conservées lors du rattrapage ; aucune traduction automatique n'a été créée.

| Langue du synopsis enregistré | Fiches dans l'inventaire complet |
| --- | ---: |
| Français | 3 033 |
| Anglais | 5 720 |
| Portugais | 3 240 |
| Espagnol | 3 055 |
| Hindi | 505 |
| Turc | 2 551 |
| Bengali | 4 |
| Arabe | 2 009 |
| Indonésien | 903 |
| Filipino / tagalog | 202 |

Ces nombres mesurent la présence d'un synopsis par langue, pas la langue audio de la vidéo. **Aucune fiche de cet inventaire ne possède les dix synopsis.** L'application utilise les textes de secours disponibles lorsqu'une langue manque ; cela ne rend pas le texte traduit dans cette langue.

## Méthode et portée

1. Snapshot de toutes les fiches de la release publiée, avec leurs variantes et les métadonnées originales du manifeste.
2. Recherche officielle sur titres originaux, traduits et alternatifs, confrontation avec les identifiants existants et les alias exacts. Les numéros et marqueurs de suites sont conservés.
3. Vérification des années et groupes originaux ; pour les séries, comparaison avec les dates des saisons concernées.
4. Utilisation des durées déjà mesurées uniquement avec le reçu de sondage, son horodatage et l'empreinte du fichier exact. Toutes les variantes doivent soutenir la même identité. Une durée inconnue ou plusieurs candidats compatibles maintiennent l'incertitude.
5. **598 recherches complémentaires par années sources**, après examen de toutes les fiches. Les requêtes couvrent les années compatibles et trois langues. Les recherches générales ont un budget de 24 candidats et trois pages ; les recherches par année, dix pages et 100 candidats pertinents. Un résultat dépassant ces budgets reste signalé comme tronqué.
6. Contrôle HTTP des affiches ; confrontation des synopsis, genres, identifiants éditoriaux, liens parasites et traductions officielles disponibles. Aucun problème de lien parasite ou d'identifiant contradictoire dans les champs éditoriaux contrôlés ne subsiste dans le relevé final.
7. Application de tous les changements confirmés, en transactions courtes. La taille des transactions ne limite pas le nombre de fiches de la revue.
8. Relecture complète depuis la production, propagation aux catalogues propriétaires et contrôle des fiches dans l'interface réelle.

La recherche TMDB est une découverte de candidats, jamais une preuve suffisante de ressemblance approximative. [Référence officielle de recherche](https://developer.themoviedb.org/reference/search-movie). Le rythme est plafonné à 24 requêtes par seconde dans la passe complète ; une réponse 429 entraîne un ralentissement global et respecte `Retry-After`. [Limites de l'API](https://developer.themoviedb.org/docs/rate-limiting).

## Production, comptes et isolation

Les données communes ont été corrigées dans la release **`b5bd1b07-3692-421a-bd8a-40c64a29b4ec`**. Le changement est global et ne dépend pas d'un statut interne ou d'une admission pilote.

Migrations installées et comparées aux définitions de la base QA isolée :

- `20261002203000_selection_independent_reassessment.sql` : réexamen explicite avec preuve supplémentaire, CAS du rejet antérieur et conservation de son historique.
- `20261002205000_selection_owned_reassessment.sql` : transmission de ce réexamen aux anciens catalogues propriétaires ; les autres rejets restent actifs.
- `20261002210000_selection_public_season_count.sql` : maintien du nombre public de saisons, avec rejet des valeurs non numériques, négatives, fractionnaires ou supérieures à 1 000.
- `20261002220000_selection_preserve_official_artwork.sql` : préférence d'une image officielle existante lorsque le rafraîchissement propose une image fournisseur ; maintien du repli fournisseur en absence d'image officielle. Comparaison et écriture utilisent la même règle pour éviter les écritures répétées.
- `20261002221000_selection_preserve_reviewed_editorial.sql` : conservation de l'image officielle existante et des champs éditoriaux explicitement réexaminés ; les nouveaux champs ou langues peuvent encore compléter les champs vides. Une nouvelle correction éditoriale explicite reste possible par le writer contrôlé.

Les gardes existantes restent actives : writer réservé au service, manifeste exact, CAS des métadonnées, preuve du fichier, propriétaire et génération, exclusions manuelles et privées. Les données de lecture et les préférences privées ne deviennent pas des données communes.

Le périmètre propriétaire comporte **47 sources canoniques avec une génération**, dont **38 visibles et 9 masquées**. La clôture finale a contrôlé chaque source visible individuellement, jusqu'à **deux reprises consécutives sans écriture par source**, soit **76 visites sans écriture**. Elle a réalisé 416 rattrapages éditoriaux. Les neuf sources masquées ont été exclues de l'écriture et l'empreinte de leurs fiches est restée identique : `651c36e44b9f0309e2d37e96ec8bc8ab`.

Rattrapages enregistrés, comptés comme opérations et non comme fiches uniques : 5 208 opérations propriétaires pour les premières corrections, 3 354 pour les traductions et 35 pour le nombre de saisons.

**113 transactions de contrôle ont comparé les lignes complètes des médias et variantes avant et après chaque RPC, dans le même snapshot PostgreSQL `REPEATABLE READ` : aucune de ces opérations éditoriales ne les a modifiées.** Les inventaires comptent toujours **374 953 médias et 348 114 variantes** ; le périmètre, les identifiants de fichiers et leurs URL sont identiques avant et après la clôture finale. Empreintes de ces identifiants et URL : médias `9e3f12020e7d29a1bfe7d55e8179cf0d`, variantes `ffedbdb9b6a812184fe77824f31d516e`. Les fichiers publics, variantes et propriétés de la release sont également inchangés pendant les applications.

La comparaison de toutes les colonnes sur une fenêtre longue a cependant relevé des mutations de variantes entre deux snapshots : `d0beac80202ee0fd82e6b36e21e383d4` puis `4e2baf0c543a94857b959d131255c21c`. Cette empreinte inclut notamment la liaison à la fiche, les métadonnées auxiliaires et les horodatages. Leur attribution exacte n'est pas établie dans ce relevé ; **l'absence de mutation concurrente de toutes les colonnes n'est pas revendiquée**. Le contrôle transactionnel ci-dessus distingue ce constat des effets des RPC éditoriaux et de l'inventaire des fichiers.

La comparaison antérieure qui additionnait les visites masquées à la couverture des sources visibles a été corrigée. Le reçu final distingue explicitement ces deux populations.

## Tests et vérification dans l'application

- **33 tests Python ciblés réussis**, comprenant homonymes, suites, preuves contradictoires, données sources, délais réseau, ralentissement sur 429, reçus périmés, fusion des traductions régionales et liens parasites dans chacune des dix langues.
- Cinq contrats PostgreSQL isolés, avec rollback : writer éditorial et propriétaires, années/saisons/durées, réexamen indépendant, nombre public de saisons et rafraîchissement éditorial avec préférence d'affiche. Les trois warnings lifecycle du montage synthétique préexistant restent documentés ; ces contrats ont réussi.
- **Les 106 changements de traduction ont également été rejoués en entier sur la base QA avec rollback**, après adaptation de l'identifiant de release au montage isolé. Aucun achat ni droit client n'a été utilisé pour cette preuve.
- **Les 30 restaurations d'affiche ont également été rejouées en entier avec rollback**, puis appliquées par comparaison exacte du titre, de l'identifiant, de l'affiche et des métadonnées. Aucun identifiant n'a été réassocié par cette opération.
- Les trois restaurations de champs revus ont également réussi en QA avec rollback. Le contrat de maintenance vérifie que l'ancienne fiche cache ne remplace ni le synopsis ni le chemin d'affiche revus et qu'une nouvelle traduction peut encore être ajoutée.
- Compte QA **non interne**, interface web de production :
  - **A Mascara de Ferro** affiche désormais **Le masque de fer, 2019, 121 min**, son affiche, son synopsis français et ses genres. Le contrôle initial montrait une fiche ancienne incompatible ; le relevé commun comportait l'identifiant 79761, remplacé par 428045.
  - **New Year Blues, 2021, 114 min** : réassociation protégée maintenant visible, affiche et synopsis français.
  - **Red Light, 2024** : bonne série, affiche, synopsis officiel anglais de secours, genres, distribution et bouton de sa partie disponible. La fiche homonyme néerlandaise de 2020 n'est plus utilisée pour cette identité.
  - **A Família Buscapé** : le synopsis français récupéré apparaît dans **Les Péquenots de Beverly Hills, 1993**.
  - **Capitão America Vingador** : affiche TMDB restaurée, synopsis français, genres et distribution affichés dans la fiche **Capitaine America : Le premier vengeur, 2011**.

Captures locales conservées dans le dossier d'artefacts de ce worktree :

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-mask-before.png`

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-mask-after.png`

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-new-year-blues.png`

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-red-light.png`

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-french-synopsis.png`

`C:/Users/Adrien/.codex/worktrees/commercial-closeout-20261002/Norva repo/.codex-artifacts/selection-exhaustive-official-artwork-restored.png`

Aucun lecteur natif ni écran WebView n'a été modifié. La portée de ces essais est la fiche de catalogue et sa propagation ; ils ne constituent pas une nouvelle certification de lecture vidéo ou de FPS Android.

## Référence et empreintes

Intégration : [PR 584](https://github.com/Admin-Adher/Norva/pull/584), contenant les opérateurs, migrations, tests et cet inventaire complet. Les opérations de catalogue ont leurs reçus séparés des contrôles CI.

| Élément | SHA-256 |
| --- | --- |
| Inventaire d'entrée | `81c83490f911c534fe76dfad2cf42adef5e885a0dcd5f899873e4fd8ebae2647` |
| Manifeste publié | `ee5524f0da23e54dcc4dc88a5f47a9455215f56ed4926a0cf9990484ca775680` |
| Preuves originales du manifeste | `cdd2680398f5bc2a9213bfb9e4cdcfdc1e37acaefc6467f46966e01f5330f4da` |
| Premier plan appliqué | `11e74835cd86cd5441829a971cac2b56b7d2c5e65e7e6a8f115075cb1d879533` |
| Plan des traductions | `4d58c4181aabe2ffacf24cff06ece32a4b844592c53495013dfcc9f2ecbbd977` |
| Plan de restauration des affiches | `c6a4bc2fb49b47995e77dbe6053ad9f3ced91f9ca5b4c2fb0f2cf9dee9bca4a5` |
| Restauration des trois champs revus | `1cc717864eed9ec6281e7092056eaf1c4a86d1b4fd2f65500f19d92a71364772` |
| Inventaire public final | `733f17a66327f45bdf7e50798282675e70ba8194aa72c12a535f1ec62e2bf455` |
| Données finales relues | `15d3aef977873db7ae9e8689d8dc6e2b898bf162965d3b556b3b77b43f096671` |
| Writer installé | `33afc4714c89ec1a4e7f9651bff3bdee2bef6e406b41842e6657dd97e88ec87e` |
| Rafraîchissement propriétaire installé | `fe4aad3169fdcc58ecf6f31eef09e8c2caaadef0ef83601d5fce0bbf57ea11b1` |
| Projection publique des métadonnées | `1240b32fe4d5922fd9cfe00f55777316b53eac0a72aa6d1830d49ebe51ed53de` |
| Préférence d'affiche installée | `571520c67ce0e354c435cf60cd1b4f550e803b19288f12b9dfa4f2830eb1132d` |
| Fusion des champs installée | `f0c0b9a5c5736777df0cc9b8c6e5ddcc6d9a612abb85058c9242c4bc56cf8ed1` |
| Fusion des métadonnées revue installée | `8942ccdb3de16f6b6a56c352e317ecb54fa1f15fdd753721c7a3ab6eb869cb06` |
| Rafraîchissement commun installé | `7f2f6715b8238021545689354d0b55e60cbf699265e71f2ef0848873d29f5566` |
| Maintenance du cache installée | `519ddce0095364bc9b2179e55d109e13759e09bf5a478c66e9731a3971ad020c` |

Les snapshots complets, réponses officielles, reçus individuels, sauvegardes ciblées et preuves SQL sont conservés sur l'hôte dans `/home/adrien/.norva/selection-tmdb-audit-20261002/exhaustive/`. Les fichiers propriétaires restent privés. Les plans précédents sont conservés et ne sont pas remplacés par une nouvelle interprétation.

**L'audit de l'inventaire entier est clos. Les manques et correspondances non établies restent visibles dans l'inventaire ; le catalogue n'est pas déclaré complet.**
