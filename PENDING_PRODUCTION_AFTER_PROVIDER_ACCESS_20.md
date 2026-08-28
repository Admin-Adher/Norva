# Lot local en attente de production apres l'observation Provider Access 20 %

> ETAT : LOCAL UNIQUEMENT. Ne pas pousser, deployer, migrer ni publier ce lot tant que la fenetre Provider Access 20 % en cours doit rester intacte.

## Point de reprise

- Worktree : `C:\Users\AdrienHernandez\Documents\Norva-vod-player-fix`
- Branche : `codex/vod-episode-navigation-fullscreen`
- Base de production au moment de la consolidation : `15236f15ebb3b684448f3736c901a79082df068c`
- Correctif lecteur : `6641cf072ce1e58c13612600fc760d560b97fd72`
- Correctif liberation d'activite fournisseur : `7740a463852b93752b961cd329ca34be43785521`

Tous les changements encore locaux sont regroupes dans ce seul worktree. L'ancien worktree du correctif `playback-busy-release` reste une copie de recuperation, mais ce document et cette branche constituent le point de reprise canonique.

## Lot A - Lecteur VOD Android et navigation des episodes

- Navigation precedente/suivante sur de vrais episodes adjacents, avec passage de saison.
- Fermeture et liberation de la session native courante avant la resolution de l'episode adjacent, afin d'eviter deux flux simultanes chez un fournisseur mono-session.
- Reprise WebView/native durcie pour la navigation automatique et manuelle.
- Lecteur reellement bord a bord, fond video noir et mode `Zoom` par defaut.
- Mode `Fit` explicite et persiste pour conserver l'image complete lorsque souhaite.
- Commandes de transport centrees sur la surface physique de l'ecran, sans decalage lie au cutout.
- Insets conserves uniquement pour les commandes de bord et la barre de progression.
- Etats, libelles et contrats d'accessibilite ajustes.

## Lot B - Liberation de l'activite catalogue avant lecture

- Drain borne de l'activite fournisseur issue du catalogue avant l'ouverture d'une session de lecture.
- Marquage d'activite opaque cote base afin d'eviter de conserver artificiellement un slot fournisseur occupe.
- Coordination du gateway media et de `norva-playback` avec les nouveaux contrats.
- Migration locale en attente : `supabase/migrations/20260828193000_provider_activity_opaque_touch_and_catalog_drain_v1.sql`.
- Tests SQL et Node ajoutes pour le perimetre busy/catalogue et les handoffs sequentiels.

## Preuves locales deja obtenues

- Contrats Node Android phone : **55/55 PASS**.
- Tests Node du lot backend consolide : **241/241 PASS** avec les dependances du checkout principal reutilisees en lecture seule via `NODE_PATH`.
- Instrumentation Android : **4/4 PASS**.
- Contrat JVM du lecteur : **PASS**.
- Build et installation locale Android : **PASS**.
- Buffer de crash apres validation : **vide**.
- Capture font 1,3 + navigation par gestes : `C:\Users\AdrienHernandez\.codex\artifacts\norva-vod-player-fix-20260829\norva-player-centered-font130-gesture.png`
  - SHA-256 : `BA916E5A22850B92DC39F1DD4B8E005925F977E509EB4CEEA743487C02F855E8`
- Capture font 1,0 + navigation trois boutons : `C:\Users\AdrienHernandez\.codex\artifacts\norva-vod-player-fix-20260829\norva-player-centered-font100-threebutton.png`
  - SHA-256 : `465ECCE6B4B190F563AAD9ADFE4019FB7CDE61B1FD8C225FBAD9E4452D0937EA`
- Preuve locale : `C:\Users\AdrienHernandez\.codex\artifacts\norva-vod-player-fix-20260829\VOD-PLAYER-CENTERING-LOCAL-VALIDATION.txt`
  - SHA-256 : `DE45759338696CA7BC99DFA94E1DA33DD161C741E978AA89C2D088D8629A5582`

Ces preuves ne remplacent pas la validation de migration en base, le deploiement coordonne des deux replicas Edge/gateway, une nouvelle release Google Play ni la verification physique de cette future release.

## Ordre de sortie recommande

1. Laisser la fenetre Provider Access 20 % actuellement en cours se terminer sans mutation materielle.
2. Avant toute promotion 20 % vers 50 %, recuperer le dernier `origin/main`, rebaser cette branche et revoir les conflits eventuels.
3. Relancer tous les tests Android, WebView, gateway, Edge, SQL et les controles de securite applicables.
4. Appliquer la migration transactionnellement uniquement avec autorisation de production, puis deployer `norva-playback` sur les deux replicas et le gateway media de facon coherente.
5. Publier une nouvelle version Android phone uniquement apres confirmation explicite du clic public final Google Play.
6. Verifier physiquement un film et une serie, puis les boutons precedent/suivant, la fin naturelle, Retour, arriere-plan/retour, Zoom/Fit, gestes, navigation trois boutons et font 1,3.
7. Recontroler P0, owners/pointers, jobs non terminaux/dead, transitions, sources READY, cache/refresh, crons et canaux externes.
8. Traiter ce deploiement groupe comme un `MATERIAL_CHANGE_RESTART` : conserver rev16 a 20 % et lancer une nouvelle fenetre complete de 24 h avant toute promotion vers 50 %.

Le regroupement des lots A et B en un seul changement materiel permet de ne redemarrer qu'une seule fois l'observation 20 % apres leur mise en production.

## Interdictions de ce lot local

- Aucun `push` automatique.
- Aucun deploiement Cloudflare, Edge, gateway ou base de donnees automatique.
- Aucun envoi Google Play automatique.
- Aucune modification de l'observation Provider Access en cours depuis ce worktree.
- Aucun secret, identifiant fournisseur ou credential ne doit etre ajoute a cette branche.
