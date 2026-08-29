# Lot groupe differe apres la fenetre Provider Access 20 %

> ETAT : LOCAL UNIQUEMENT. Ne pas pousser, deployer, migrer ni publier ce lot pendant une fenetre d'observation Provider Access active.

## Point de reprise canonique

- Worktree : `C:\Users\AdrienHernandez\Documents\Norva-post-provider-rollout-batch`
- Branche : `codex/post-provider-rollout-batch`
- Base de production au moment de la consolidation : `15236f15ebb3b684448f3736c901a79082df068c`
- Correctif lecteur : `6641cf072ce1e58c13612600fc760d560b97fd72`
- Correctif liberation d'activite fournisseur : `7740a463852b93752b961cd329ca34be43785521`
- Documentation initiale du lot : `ff3594ed`
- Dossier onboarding/auth/profils : `docs/product/auth-profile-redesign/`

Ce worktree est le seul point de reprise recommande pour les changements materiels volontairement gardes hors production. Le checkout principal, ses changements non lies et l'observation Provider Access active ne doivent pas etre modifies depuis cette branche.

## Lot A - Lecteur VOD Android et navigation des episodes

- Navigation precedente/suivante sur de vrais episodes adjacents, y compris le passage de saison.
- Fermeture et liberation de la session native courante avant la resolution de l'episode adjacent, afin d'eviter deux flux simultanes chez un fournisseur mono-session.
- Reprise WebView/native durcie pour la navigation automatique et manuelle.
- Lecteur bord a bord, fond video noir et mode `Zoom` par defaut.
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

## Lot C - Onboarding, authentification et profils

Le dossier `docs/product/auth-profile-redesign/` contient :

- l'archive complete des explorations A a L, des assets, des planches QA et des captures ;
- le candidat valide `l-premium-continuity.html` et le tableau interactif `profile-funnels.html` ;
- les parcours connexion, creation de compte, verification, mot de passe facultatif, choix/creation/edition de profil et choix d'avatar ;
- le choix produit explicite de ne proposer aucun profil Kids ;
- un manifeste de migration, une matrice etat-vers-contrat et une checklist de mise en production ;
- un validateur statique reproductible.

Le prototype reste volontairement inerte : il ne lance aucun OAuth, aucun email, aucune creation de compte et aucune mutation de profil. Son ecran de code a quatre chiffres est une direction UX, pas encore un contrat backend Norva. La production actuelle utilise un lien securise par email (`signInWithOtp` avec `token_hash`) ; activer une saisie de code necessite d'abord un contrat serveur verifiable, anti-enumeration et compatible WebView.

## Preuves locales du lot C

- Archive consolidee : **100 fichiers, 8 189 622 octets**.
- Validateur statique : **PASS**, 14 etats, 12 avatars, prototype inerte.
- Rendu Playwright : **22/22** combinaisons sans scroll nominal ni debordement a 390 x 844 et 844 x 390.
- Cibles interactives visibles : aucune sous **44 CSS px**.
- Reduced motion : animation poster desactivee.
- Contrats auth, responsive, profils, modales et analytics : **34/34 PASS**.
- Rapport : `docs/product/auth-profile-redesign/VALIDATION_REPORT.md`.

## Preuves locales deja obtenues pour les lots A et B

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

1. Ne rien publier depuis ce worktree pendant une observation Provider Access active.
2. Au gate autorise, recuperer le dernier `origin/main`, rebaser cette branche et revoir chaque conflit.
3. Relancer tous les tests Android, WebView, gateway, Edge, SQL, auth/profils et securite applicables.
4. Pour le lot C, choisir explicitement entre le lien securise existant et un nouveau code numerique. Ne jamais simuler le code numerique avec une validation uniquement cliente.
5. Appliquer la migration SQL transactionnellement uniquement avec autorisation de production, puis deployer `norva-playback` sur les deux replicas et le gateway media de facon coherente.
6. Integrer les ecrans auth/profils en preservant les contrats de session, anti-enumeration, OAuth, attribution, focus, Android Back, TalkBack et D-pad decrits dans la documentation du lot C.
7. Publier de nouvelles versions Android uniquement apres confirmation explicite du clic public final Google Play.
8. Verifier physiquement auth, profils, un film, une serie, precedent/suivant, fin naturelle, Retour, arriere-plan/retour, Zoom/Fit, gestes, navigation trois boutons et font 1,3.
9. Recontroler P0, owners/pointers, jobs non terminaux/dead, transitions, sources READY, cache/refresh, crons et canaux externes.
10. Traiter le deploiement groupe comme un changement materiel. L'operateur du rollout doit appliquer la procedure `MATERIAL_CHANGE_RESTART` exigee par le contrat Provider Access en vigueur avant toute promotion ulterieure.

## Interdictions de ce lot local

- Aucun `push` automatique.
- Aucun deploiement Cloudflare, Edge, gateway ou base de donnees automatique.
- Aucun envoi Google Play automatique.
- Aucune modification de l'observation Provider Access depuis ce worktree.
- Aucun secret, identifiant fournisseur ou credential dans cette branche.
- Aucun branchement du prototype statique directement sur les API de production.
