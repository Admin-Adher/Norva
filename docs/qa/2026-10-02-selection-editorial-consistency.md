# Cohérence éditoriale de Norva Selection — 2 octobre 2026

## Résultat

Le défaut de données communes anciennes est corrigé et déployé globalement. La
fiche de **Guerreiros da Virtude** affiche son poster chargé, son synopsis français,
son année, sa durée et ses genres sur le compte QA ordinaire. Son affiche est
également chargée dans **Continuer à regarder**. Un second film jamais lu,
**100 Coco**, est passé d'une image de remplacement et aucun résumé à sa fiche
**100% Coco**, avec affiche chargée, synopsis, année, durée et genres.

**5 086 fiches distinctes ont changé** : 4 847 films et 239 séries. Ce nombre est
une comparaison des champs éditoriaux avant/après, pas la somme des appels ni
un nombre de comptes. Les fichiers, URLs, identités de catalogue et générations
de lecture n'ont pas été reconstruits.

Ce contrôle ne certifie pas l'intégralité des correspondances TMDB ni tous les
fournisseurs. Des fiches incomplètes restent identifiées ci-dessous. La lecture
native du film et la distribution de 1.3.30 relèvent du rapport XVID séparé.

## Défaut reproduit et cause

- Une fiche restaurée de Guerreiros affichait « Aucun résumé disponible ».
  La réouverture depuis la grille affichait déjà sa fiche enrichie, avant cette
  correction : l'incohérence entre chemins est donc observée. Elle n'établit pas
  un défaut propre à un numéro de version Android.
- Le titre commun publié le 1er octobre était toujours sans TMDB, poster ni
  synopsis. Les anciens titres propriétaires et le cache public contenaient
  déjà la correspondance validée 49478, un poster et 556 caractères de synopsis
  français. L'API de titre propriétaire retournait déjà cette fiche riche.
- La publication partagée avait repris des recettes antérieures à certains
  enrichissements. La lecture des cartes communes et celle des titres déjà
  matérialisés pouvaient ainsi exposer des états éditoriaux différents.
- **100 Coco** reproduisait le défaut sur un titre non lu : image
  `/img/norva-media-placeholder.png`, aucun résumé, ni année ou genres TMDB.

## Correction

Référence intégrée : [PR 578](https://github.com/Admin-Adher/Norva/pull/578),
commit `9ffbe03563d61fd82798b446ce50723e60805533`.

- Migration `20261002150000_selection_shared_editorial_refresh.sql`, appliquée
  au PostgreSQL de production. SHA-256 normalisé LF :
  `c7d4e753c9ffb742d9ab0cee85af3c860ca8f2101dec0c8cbff0217f29dd852e`.
- Une association existante est réutilisable uniquement pour le même fichier
  public : type, identifiant externe, URL exacte et source/génération visibles.
  Pour une série, un épisode public identique est également exigé.
- La source témoin fournit une association déjà validée. Les textes et images
  viennent exclusivement de `catalog_titles`, avec liste blanche des champs
  publics. Aucun historique, préférence, secret ou résultat audio privé d'un
  autre propriétaire n'est copié.
- Les identités ambiguës et les IDs contradictoires ne sont pas réattribués.
  Trois sources appartenant aux comptes contrôlés ont été utilisées. Les reçus
  ont signalé respectivement 3, 41 et 6 contradictions : ce sont des tentatives
  par source, avec recouvrement possible, pas 50 films distincts certifiés faux.
- Les cartes non matérialisées et les titres déjà liés utilisent les mêmes
  champs publics actualisés. L'hydratation conserve les preuves de propriétaire,
  génération, variante, source et pistes du fichier.
- Chaque lot est borné à 500 identités maximum ; l'opérateur a utilisé 250.
  Les epochs et les résumés de facettes sont invalidés après un changement.
- Un rafraîchissement automatique des identités déjà validées est actif toutes
  les quinze minutes. Il n'invente pas de nouvelles correspondances et ne
  réécrit pas les fiches inchangées.

Le catalogue partagé est activé globalement (`selection_shared_rollout.enabled`
vaut `true`). La correction ne dépend pas du statut interne du lecteur et ne
nécessite ni nouveau bundle Android ni redémarrage des Gateways.

## Mesures sur le catalogue commun

Périmètre : 6 159 titres de films et 273 titres de séries, distincts des variantes
et des épisodes. Les URL vides sont ignorées pour les posters. Le synopsis est
considéré disponible s'il existe un texte non vide en français, en anglais, dans
TMDB ou dans le champ générique. Deux films avec texte anglais étaient auparavant
comptés à tort comme vides ; les chiffres ci-dessous corrigent cette définition.

| Mesure | Avant | Après | Récupéré |
| --- | ---: | ---: | ---: |
| Films sans URL d'affiche | 1 809 | 335 | 1 474 |
| Films sans synopsis disponible | 2 981 | 925 | 2 056 |
| Séries sans synopsis disponible | 266 | 39 | 227 |
| Films avec ID TMDB | 3 238 | 5 365 | 2 127 |
| Séries avec ID TMDB | 7 | 239 | 232 |
| Films classés uniquement « autres » | 3 163 | 1 144 | 2 019 |
| Séries classées uniquement « autres » | 266 | 74 | 192 |

Une URL stockée n'est pas une preuve que chaque image charge sur tous les réseaux.
Le chargement réel a été vérifié pour les deux fiches testées, avec une largeur
native de 500 pixels pour Guerreiros et 600 pixels pour 100% Coco.

## Vérifications

### PostgreSQL isolé

Migration exécutée sur `norva_selection_editorial_qa_20261002`, clone d'une base
QA contenant une source publique et un compte synthétique, sans identifiants de
fournisseur. Le scénario ajoute trois propriétaires synthétiques puis annule
toutes ses données par `ROLLBACK`.

Scénarios réussis : fichier identique, carte non lue et fichier lié, hydratation,
facettes, absence de copie de données privées, manifestes immuables, répétition
sans écriture, traduction publique ultérieure, refus d'un propriétaire étranger,
d'une génération obsolète, d'un manifeste changé, d'un ID contradictoire et d'une
maintenance sans borne ; permissions de service uniquement.

Les avertissements FK de projection comportementale viennent des profils
synthétiques absents de cette base isolée. Ils n'ont pas empêché les assertions
catalogue et ne concernent aucun compte de production.

### Contrats et intégration

- **32 tests Node ciblés réussis** : métadonnées possédées, détail localisé,
  historique, Continuer à regarder, activation partagée et hydratation/epoch.
- Compilation Python du script opérateur réussie.
- CI du code intégré : base Supabase jetable, contrats et typage Edge, parcours
  simulés, notifications, compilation/tests Android téléphone et TV réussis.
- Les previews Vercel étaient limitées par le quota de déploiements. Cette
  correction modifie le schéma et les données serveur ; aucun nouveau fichier
  web n'était nécessaire pour le rejeu réalisé sur `norva.tv`.

### Production et interface

- Rejeu depuis le profil **Test client**, compte QA non interne déjà connecté.
- Fiche 100 Coco avant/après : synopsis français de 176 caractères, 2017,
  88 minutes, note 6,3, Famille/Comédie, affiche réellement chargée.
- Guerreiros : 1997, 103 minutes, note 4,8, Fantastique/Famille/Action, PT/EN,
  synopsis français de 556 caractères et affiche réellement chargée.
- L'image de Continuer à regarder est chargée depuis le même poster TMDB. Son
  titre français « Magic warriors » correspond à l'ID 49478.
- Le compte QA conserve cinq fichiers liés dans une seule génération : aucune
  reconstruction de son inventaire pendant cette opération.
- Le rafraîchissement périodique a réellement réussi à 14:26 et 14:41 UTC.
  Un rejeu explicite a retourné zéro changement après stabilisation.
- Deux sondes ponctuelles, incluant démarrage de `docker exec`/`psql` :
  hydratation d'un titre 183 → 276 ms ; comptage visible 1 050 → 1 478 ms.
  Ce ne sont ni un benchmark utilisateur ni une mesure de FPS ou de démarrage.

## Conservation et reproductibilité

Script versionné : `ops/hetzner/scripts/refresh-selection-editorial-20261002.py`.
Les modes `schema`, `backfill`, `maintain` et `summary` contrôlent les contrats,
les générations attendues et les limites avant toute écriture.

Sauvegardes et reçus privés sur l'hôte :
`/home/adrien/.norva/selection-editorial-refresh-20261002/`.
Ils comprennent les définitions précédentes, les titres communs avant/après et
les reçus agrégés. Aucun inventaire privé, compte Auth ou mot de passe n'a été
exporté dans ces sauvegardes.

Empreintes avant/après identiques :

| Données immuables | MD5 |
| --- | --- |
| Média commun et fichiers | `7731c09ccf103579b34f9bcaadc7dbdc` |
| Variantes communes | `36c99c0683acc4a7eb36df867a9284e8` |
| Release, hors date éditoriale | `9b4b7350c380600af2bf608300d3ceea` |

Snapshot éditorial final public, SHA-256 :
`c5bb86163dfd091f376fa3230192b470461d592bf7f4dd96dc7b093b08ba44ed`.

## Limites restantes

- 335 films sans URL d'affiche ; 925 films et 39 séries sans synopsis utilisable
  selon la définition ci-dessus. Des ID TMDB existent encore sans texte en cache.
- Des titres courts ont des associations dont le cache affiche une confiance
  limitée, par exemple « A Baleia » / « A Baleia Mágica ». Ce contrôle n'a pas
  visionné ces fichiers pour décider de leur identité réelle. Le statut de
  validation stocké n'est pas une certification manuelle de chaque œuvre.
- Les correspondances contradictoires restent conservées, sans choix arbitraire
  d'un nouvel ID. Elles nécessitent une vérification distincte du contenu.
- Le téléphone n'était pas détecté par ADB lors de ce contrôle. Le rendu mobile
  de cette actualisation n'est donc pas déclaré rejoué ici.
- La campagne ne teste ni les 100 lecteurs, ni tous les fournisseurs, ni toutes
  les langues. Elle ne clôture pas à elle seule l'objectif commercial complet.
