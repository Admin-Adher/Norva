# Norva Selection — correspondances TMDB, cohérence des fiches et langues

**Complément postérieur :** les manques ont été réduits à 153 films sans affiche, 646 films et 43 séries sans synopsis de secours. Voir [la passe complémentaire](2026-10-02-selection-editorial-remainder.md). Les mesures ci-dessous conservent le résultat de l'audit initial.

## Périmètre et résultat

Contrôle du catalogue commun publié `b5bd1b07-3692-421a-bd8a-40c64a29b4ec` : **6 159 films et 273 séries**. Les nombres de cette note concernent Norva Selection ; ils ne certifient pas les autres catalogues fournisseurs ni l'objectif commercial complet.

Le bilan des 335 films sans affiche et des 925 films / 39 séries sans synopsis a été repris avec des preuves de correspondance. Les fichiers et les versions de lecture n'ont pas été reconstruits. Les réparations de métadonnées sont diffusées aux nouveaux comptes et aux comptes ayant importé Selection avant la mise en place du catalogue commun.

Mesure finale du 2 octobre 2026 à 17:18 UTC :

| Type | Titres | Sans affiche exploitable | Sans synopsis de secours | Sans identifiant TMDB |
| --- | ---: | ---: | ---: | ---: |
| Films | 6 159 | 189 | 697 | 650 |
| Séries | 273 | 0 | 43 | 42 |

« Synopsis de secours » signifie au moins un texte non vide parmi les traductions française/anglaise enregistrées, le texte TMDB principal et les champs fournisseur pris en charge. Cela ne signifie pas que le synopsis est traduit dans toutes les langues.

Les 43 séries sans synopsis, contre 39 auparavant, comprennent des fiches dont une correspondance erronée a été retirée. Une baisse artificielle des manques grâce à un mauvais synopsis ne constitue pas une amélioration.

La mesure distingue une URL d'affiche non vide d'une URL désignant une image. Après l'audit principal, 183 films avaient une URL vide ; le contrôle complémentaire a trouvé neuf URL TMDB réduites à leur taille, sans nom de fichier. Cinq identités ont été vérifiées, mais trois seulement disposaient d'une affiche récupérable. Les six URL encore sans image ont été normalisées en absence d'affiche : **189**, sans endpoint malformé restant. Les autres URL n'ont pas toutes été téléchargées ; le chiffre mesure les champs et leur structure, pas un taux exhaustif de réponses HTTP image réussies.

## Preuves de correspondance et limites

- 1 351 candidats de l'audit principal : 393 identités existantes vérifiées, 266 identités nouvelles/remplacées et 692 cas non résolus.
- 744 interventions bornées : 659 associations vérifiées et 85 identités erronées mises en quarantaine.
- API officielle TMDB : détails, titres alternatifs et vérification des titres courts/homonymes. 156 sondes de durée indépendantes, sans téléchargement complet des médias.
- Exemples confirmés : `A Baleia` → **The Whale**, TMDB 785084, durée 7 011,463 s ; `A Bailarina` → animation de 2016, TMDB 342473, durée 5 346,991 s ; `A Hora do Pesadelo` → film de 1984, TMDB 377, durée 5 474,308 s.
- Les 692 cas non résolus se répartissent en 552 absences de correspondance d'alias exacte, 60 ambiguïtés et 80 titres courts sans preuve indépendante suffisante. Ce sont des limites de cet audit ; ils n'établissent pas une absence du film dans TMDB.
- L'audit complémentaire des affiches a vérifié cinq identités. Les quatre fiches sans identité suffisante étaient `365 Dias 1`, `Crónicas de Navidad 1`, `Grim cutty: Asesino implacable` et `TNTS1`.
- Toutes les 6 432 correspondances n'ont pas été validées manuellement. Une validation antérieure stockée dans le catalogue ne vaut pas à elle seule une revue exhaustive.

Les écritures utilisent un manifeste publié, une comparaison de l'état attendu et une preuve de confiance. Les anciennes identités rejetées ne peuvent pas être réintroduites par la simple présence d'un drapeau historique « valide ».

## Cohérence des comptes et protection des données

La maintenance des anciens imports est limitée aux sources Selection canoniques, visibles, avec leur génération active et des fichiers correspondant exactement au catalogue commun. Les sources privées, les fiches manuelles et les groupes mélangeant des identités incompatibles sont exclus.

47 sources canoniques actives ont été examinées : 38 visibles étaient admissibles ; neuf sources masquées ont été ignorées. **25 001 fiches propres aux comptes ont été actualisées**, puis 149 lors du contrôle complémentaire des affiches. Deux tours complets ont retourné zéro écriture après ces étapes. Après la normalisation finale des URL, deux autres tours ont également retourné zéro écriture (22,381 s et 23,369 s).

Les préférences privées et les preuves audio propres aux fichiers sont conservées. Le contournement du miroir SQL n'existe qu'à l'intérieur de la maintenance contrôlée, avec propriétaire/source/génération vérifiés ; le contexte est restauré en sortie et après erreur. Le cache global ne reçoit pas les préférences d'un compte.

Les contrôles entourant chaque opération ont confirmé l'absence de modification des inventaires et des variantes par ces réparations. Les inventaires physiques contrôlés comptaient **374 953 entrées et 348 114 variantes**. Les tâches audio indépendantes peuvent actualiser leurs propres observations pendant un audit ; les empreintes de variantes prises à des heures différentes ne sont pas présentées comme une preuve d'immutabilité globale de toutes les activités du serveur.

Cron installé : `norva-selection-owned-editorial-refresh`, ID 190, toutes les quinze minutes à partir de la minute 7 ; 100 titres par source, 20 sources par invocation, délai SQL borné à 30 secondes et verrou empêchant deux reprises concurrentes. Le parcours d'activation ne reconstruit pas ces inventaires.

## Défaut réel de restauration d'une fiche

Dans le navigateur de production, le compte QA ordinaire affichait correctement The Whale après recherche de `A Baleia`. Un rechargement avec la fiche ouverte la rétablissait avec le titre seul : affiche, synopsis, année et langue disparaissaient.

La restauration gardait le titre traduit, puis effectuait une recherche parmi les noms fournisseur. La correction retrouve désormais le titre par **source + type + identifiant fournisseur exact**, à travers les variantes visibles du propriétaire et l'hydratation de la génération actuelle. Elle réutilise la même projection localisée que les rails. Les variantes retournées gardent leurs propres langues, conteneurs et identités ; une source étrangère portant le même identifiant ne peut pas être substituée.

Une identité disparue, masquée ou ambiguë ne réouvre pas une fiche homonyme. Une navigation plus récente invalide la requête en cours. Une panne de réseau ne restaure pas les anciennes affirmations audio enregistrées dans un état local.

La correction WebView est testée avec le véritable code des pages Films/Séries, une réponse réseau contrôlée et un titre traduit différent du nom retourné. Cette preuve vérifie le client ; elle ne remplace pas le contrôle de l'API et du compte ordinaires en production.

Le premier contrôle du nouveau parcours en production a révélé une seconde cause : le filtre de réponse supprimait la clé ajoutée pour transporter les fiches. Le contrat utilise désormais la clé `items` déjà autorisée. Un test applique le véritable `sanitizeCatalogMediaPayload` à la réponse exacte ; l'adaptateur client est testé avec des versions de fichiers portant des langues distinctes. Aucun élargissement de la liste de champs publics n'a été nécessaire.

Le contrôle authentifié du compte QA ordinaire a ensuite confirmé sur chacune des deux répliques : une fiche, une variante, une affiche, année 2022 et synopsis français de 138 caractères. Le jeton de vérification était de rôle `authenticated`, valable deux minutes ; ce test n'utilisait pas le rôle de service. Le reçu ne contient aucun jeton ni accès fournisseur.

La reprise de la fiche a également révélé une priorité incohérente entre le titre localisé et le nom brut fournisseur. L'adaptateur utilise désormais le titre projeté pour l'affichage, en gardant `name` et `raw_title` pour les libellés de versions et les tags de langue. Le test contient simultanément un titre traduit, un titre TMDB de base en anglais et un libellé brut préfixé ; les trois rôles ne sont pas confondus.

Dans la grille à plat, les composants historiques préfèrent `tmdb.title` quand aucun identifiant de titre logique n'est exposé. La projection éditoriale exacte fournit aussi le titre localisé dans ce champ, avec un test Films/Séries ; elle ne modifie pas les données TMDB persistées.

**Replay dans le navigateur de production, compte QA non interne : réussi.** Recherche `A Baleia` → carte **La baleine** → fiche → rechargement : même titre français, affiche, synopsis français, année 2022, durée 117 min, note 7,8, genre Drame et langue du fichier Portugais. `Peaky` → fiche **Peaky Blinders** → rechargement : synopsis français, affiche, année 2013, six saisons, 36 vidéos, note 8,5, genres et langue Espagnol conservés ; les épisodes et le bouton de reprise sont présents. Ce replay vérifie la restauration de métadonnées et la présence des commandes, pas un nouvel essai de lecture vidéo.

Captures conservées localement : `.codex-artifacts/selection-fiche-reloaded.jpg` et `.codex-artifacts/selection-series-fiche-reloaded.jpg`. Le test physique Android n'a pas été rejoué pendant ce contrôle ; la preuve mobile de cette note est le test WebView ciblé sur émulateur.

## Les dix langues : couverture effective des synopsis

Les dix langues d'interface Norva sont définies dans `i18n/locales.json`. Une interface traduite n'implique pas une traduction de chaque fiche VOD. Comptage des synopsis réellement enregistrés dans `metadata.i18n`, sans compter un texte affiché en secours comme une traduction :

| Langue | Films / 6 159 | Séries / 273 |
| --- | ---: | ---: |
| Anglais | 5 402 | 228 |
| Français | 2 861 | 54 |
| Portugais brésilien | 3 101 | 58 |
| Espagnol | 2 886 | 49 |
| Hindi | 473 | 21 |
| Turc | 2 436 | 35 |
| Bengali | 4 | 0 |
| Arabe | 1 874 | 29 |
| Indonésien | 857 | 19 |
| Filipino | 184 | 14 |

Les clés de contenu TMDB sont `pt` pour `pt-BR`, et `tl` pour `fil`. La langue de contenu est résolue par préférence de sous-titres, préférence audio, région, locale de l'appareil, puis anglais (`cloudApi.resolveLang` / `MediaUtils.resolveContentLanguage`). La langue de l'interface et cette préférence de contenu sont distinctes dans le code actuel.

**Conclusion : non, l'intégralité des synopsis n'est pas disponible dans les dix langues.** Les champs manquants peuvent utiliser un texte de secours. Aucune traduction automatique n'a été inventée pour compléter ces chiffres. Cet audit n'a pas interrogé TMDB pour chacune des dix langues de chacun des 6 432 titres ; les manques mesurés ne prouvent donc pas que TMDB n'a aucune traduction supplémentaire.

## Déploiement, références et contrôles

- PR 580 intégrée : référence `b2f9b2f8a439c6851378b39f12b90853fd26149e`.
- PR 581 : maintenance des anciens comptes, filtrage des images et restauration exacte des fiches.
- Deux répliques Edge recréées successivement, image et environnement conservés ; chacune a confirmé sa santé, version playback 85.
- Runtime actif : `/home/adrien/.norva/selection-tmdb-audit-20261002/runtime-fiche-functions-fiche-v3`.
- SHA-256 LF du catalogue Edge : `ef0dd9bdc43c1fdaf57a93ab1a3235513c9c6c6121fbe63a28d8c73c0cfbfb19`.
- SHA-256 LF de l'adaptateur web `api.js` : `4f5ce9f036b8bf59aa8a22cbe61723ecf79355957cec284e746fad739e64f953`.
- SHA-256 LF de `vod-title-projection.ts` : `d4a70b199f4179ae14c66e5f578977e7bebe44349132ef0f6bcff8f18bd7c17c`.
- Migration maintenance anciens comptes : `20261002173000_selection_owned_editorial_refresh.sql`, SHA-256 `ed22cc9c4b4bf2db6c7ada0dd643cb3dd13fbd51ccc9493effd29b9d5af589ce`.
- Migration protection images : `20261002180000_selection_editorial_artwork_guard.sql`, SHA-256 `e748deb4252a4ec9b930c8730ad3143601dcc48cde8a8bc001dce296a3fd6dfd`.
- Tests Node de correspondance, overlays, artwork, restauration, adaptation cloud et navigation : réussis sur les périmètres ciblés. Les tests de restauration couvrent aussi une source masquée, la collision d'identifiants et une navigation pendant le chargement. Dernier contrôle de projection/localisation/résolution : **21 tests réussis** ; le contrôle de restauration précédent comptait 20 succès, sur un périmètre différent.
- Deux suites SQL sur clone jetable, mutations annulées : `selection-editorial-audit-apply.sql` et `selection-shared-editorial-refresh.sql`. Le second contrôle inclut la conservation d'une vraie image malgré un endpoint malformé et l'absence d'écritures répétées.
- Android API 35 : [contrôle WebView dédié 37036583641](https://github.com/Admin-Adher/Norva/actions/runs/37036583641), **gestes et trois boutons réussis**, zoom texte 100/130. Les JavaScript de production testés sont identiques à ceux préparés pour le déploiement ; ce contrôle ne mesure ni FPS ni lecture vidéo native.
- [Suite d'intégration finale 37038763488](https://github.com/Admin-Adher/Norva/actions/runs/37038763488) : réussie sur la référence `17efc8cb43b88350a484309d32979bd71b3495f7` (contrats/type-check Edge, notifications, parcours simulé web/mobile, base jetable, compilation/tests téléphone et TV). Le contrôle de régression web/i18n du build 37038763651 a également réussi.
- [Publication web 37039744771](https://github.com/Admin-Adher/Norva/actions/runs/37039744771) : réussie sur `048834cccd135ca3d91701472bee07c6991c144a`, qui contient l'adaptateur `api.js` mesuré ci-dessus. Le complément de projection serveur est enregistré dans `bb5c1b76c49523ad82541480396fba84e92e1301` et a été appliqué sur les deux répliques avant le dernier replay film.
- Des échecs CI intermédiaires ont identifié le manifeste i18n à régénérer et un test statique incluant accidentellement la fonction suivante. Les corrections conservent les contrôles ; aucune assertion de protection n'a été retirée.

## Conservation des preuves

Artefacts serveur sous `/home/adrien/.norva/selection-tmdb-audit-20261002` : plans principaux et complémentaires, preuves API/durée, reçus d'application, sauvegardes avant modification, déploiements et mesures finales. Les sauvegardes contenant des données de compte ont des permissions privées 0600 ; leur contenu n'est pas publié dans le dépôt.

L'instantané public final porte l'empreinte SHA-256 `edc236f654200bb95d08e1b7dc5baaee7bcc7fe76587e5e6b4507ebada140e00`. Les reçus `fiche-owned-replay.safe.json`, `fiche-deployment.safe.json`, `fiche-exact-response.safe.json` et `artwork-guard.safe.json` distinguent la mise à jour des fiches, le runtime, la réponse publique authentifiée et les protections SQL.
