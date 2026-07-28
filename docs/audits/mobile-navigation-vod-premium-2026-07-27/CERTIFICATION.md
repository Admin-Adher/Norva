# Certification après correction — 12 parcours premium

Date de certification : 27 juillet 2026<br>
Référence de conception : [canvas Superdesign P0](https://superdesign.dev/teams/235f8bb0-73fd-4f0f-affc-7debc947fe7e/projects/2ec1ee02-daee-43eb-a616-f6ef87bea620)

Ce document complète l’audit initial sans en réécrire les observations. La santé ci-dessous décrit le produit corrigé dans le worktree certifié, tandis que le rapport initial reste la preuve de l’état observé avant correction.

## Verdict

| Santé produit après correction | Nombre |
|---|---:|
| Premium-ready | 12 |
| Fragile | 0 |
| Mauvaise | 0 |
| Critique | 0 |

`Premium-ready` signifie ici : aucun P0/P1 produit connu dans la revue finale, états et interactions critiques couverts par des contrats automatisés, compilation/lint des deux clients Android réussis, et gates natives déterministes rejouées sur émulateur. Les validations qui exigent un fournisseur réel, un catalogue volumineux, Cast ou un réseau dégradé restent des gates d’exploitation distincts ; elles ne sont pas transformées en succès implicites.

## Matrice des 12 parcours

| # | Parcours | Santé | Contrat premium livré | Preuve principale |
|---:|---|---|---|---|
| 1 | Lancement, session, liens profonds | Premium-ready | Profil, route, scroll, filtres et fiche restaurés avec token de navigation ; App Links `/t/*` canonicalisés | Contrats continuité Android et invalidation des callbacks différés |
| 2 | Authentification et récupération | Premium-ready | Onglets ARIA complets, navigation clavier, statuts live, erreurs sanitisées, déconnexion cancel-first | Contrats Account et erreurs grand public |
| 3 | Profils | Premium-ready | Dialog modal isolé, focus confiné/restauré, échec de chargement explicite avec Retry, suppression fail-closed | Contrats profils/accessibilité |
| 4 | Sources et synchronisation | Premium-ready | Erreurs bornées, modales Add/Edit/Warning isolées, confirmation sûre et récupération actionnable | Contrats SourceManager/NorvaModal |
| 5 | Home | Premium-ready | États chargement/vide/erreur stables, module écosystème entièrement accessible au-dessus des barres système | Contrats Home mobile |
| 6 | Navigation, recherche, Account | Premium-ready | Bottom nav adaptatif, recherche accent-insensible, outage distinct de zéro résultat, focus/inert/Retry | Contrats navigation premium |
| 7 | Live TV | Premium-ready | Navigation D-pad déterministe, équité `All Sources`, chargements tardifs invalidés, sélection favorite tokenisée | Contrats Live/concurrence |
| 8 | Movies | Premium-ready | `All Sources ↔ All Categories` réversible, sheet sans IME automatique, sémantique desktop restaurée, titres/notes nettoyés | Contrats filtres mobile et D-pad TV |
| 9 | Series | Premium-ready | Même grammaire de filtres que Movies, erreurs fournisseur fermées et sanitisées, notes zéro et métadonnées audio transitoires masquées, Retry/changement de source | Contrats Series/error state |
| 10 | Lecteur VOD | Premium-ready | Poster jusqu’à la première image, états exclusifs tokenisés, watchdog initial/rebuffer distinct, erreurs sans contrôles sous-jacents, PiP moderne | Fixture réelle H.264/AAC + contrats Player |
| 11 | Downloads/hors ligne | Premium-ready | Calculs et décodage hors UI, snapshots anti-stale, actions sémantiques, insets, copie EN/FR entièrement resource-backed | Instrumentation Downloads + contrats 8/8 |
| 12 | Settings, support, suppression | Premium-ready | Tabs/tabpanels clavier, scroll réinitialisé, statuts live, erreurs bornées, modales et actions destructives sûres | Contrats Settings/consumer errors |

## Gates exécutées

- Suite Node globale : **909/909**.
- Android phone : `compileDebugJavaWithJavac`, `assembleDebug`, `assembleDebugAndroidTest`, `lintDebug` réussis.
- Android TV : `assembleDebug` et `lintDebug` réussis.
- Contrat JVM du lecteur Android phone : **PASS**.
- Instrumentation émulateur Android phone :
  - première image réelle H.264/AAC : **1/1** ;
  - sémantique Downloads et dégagement de la navigation système : **1/1**.
- Contrats ciblés Account/Profils/Settings/Modales/Navigation : **34/34**.
- Contrats D-pad TV ciblés : navigation Movies/Series, filtres, rail, Settings, modales, mémoire de focus et recovery couverts dans la suite globale.
- Émulateur Android TV, bundle final :
  - `All Sources → All Categories → All Sources` exécuté au D-pad sur Series ;
  - ouverture de `All Categories`, focus initial sur `All`, puis Back avec restauration exacte du bouton et fermeture complète (`aria-expanded=false`, panneau masqué, `aria-hidden=true`, `inert=true`) ;
  - 24 cartes Series inspectées sans `Audio pending`, `Identifying audio` ni note zéro visible ;
  - aucun crash, ANR ou arrêt du renderer WebView dans le log propre de la passe finale ;
  - [capture Series finale](../tv-premium-validation-2026-07-27/113-series-final.png).

## Gates d’exploitation conservées

Ces essais restent requis avant une promotion de release à grande échelle, car ils dépendent d’un environnement externe ou d’un volume de données non hermétique :

- première image et recovery sur la matrice réelle des fournisseurs Live/VOD ;
- Cast vers un appareil physique et PiP pendant une lecture fournisseur réelle ;
- sélection audio/sous-titres et changement de version sur plusieurs conteneurs/codecs ;
- bibliothèque Downloads de 25–100 titres, stockage contraint et lecture réellement hors ligne ;
- pairing neuf, suppression réelle et récupération d’authentification sur un compte de test ;
- TalkBack/Switch Access assistés et soak de 30 minutes avec mesure séparée du renderer WebView.

Ces gates sont suivies comme validation d’exploitation, pas comme défauts P0/P1 connus du produit corrigé.
