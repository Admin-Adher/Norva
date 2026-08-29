# Lot groupe de production - changement materiel Provider Access

> ETAT : CANDIDAT DE PRODUCTION AUTORISE LE 2026-08-29. La publication doit rester atomique, auditee et suivie d'un `MATERIAL_CHANGE_RESTART` de l'observation Provider Access 20 %.

## Point de reprise canonique

- Worktree : `C:\Users\AdrienHernandez\Documents\Norva-post-provider-rollout-batch`
- Branche : `codex/post-provider-rollout-batch`
- Base `origin/main` verifiee avant release : `56fdc9b0188407293f4d3a3a24e4b5d67f78f71c`
- Correctif lecteur : `f41acc92`
- Correctif liberation d'activite fournisseur : `fbb65587`
- Documentation initiale du lot : `ca653efe`
- Archive auth/profils initiale : `785dc2b3`
- Dossier onboarding/auth/profils : `docs/product/auth-profile-redesign/`

Ce worktree est le seul point de publication du lot. Le checkout principal et ses changements non lies restent intacts. La branche passe par PR et CI ; aucune publication directe depuis le checkout principal n'est autorisee.

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

L'archive de prototype reste inerte. Son parcours approuve est maintenant transpose dans la production web et Android phone : email unique, code GoTrue natif a six chiffres, lien `token_hash` de repli, mot de passe secondaire et Google conserve. La meme requete `signInWithOtp(create_user: true)` dessert compte existant et creation sans detection cliente de l'existence du compte. La verification reste exclusivement serveur via `/auth/v1/verify` et `type=email`. La TV conserve son parcours D-pad/pairing et ne charge pas le nouvel habillage profils.

## Preuves locales du lot C

- Archive consolidee : **100 fichiers, 8 189 622 octets**.
- Validateur statique : **PASS**, 14 etats, 12 avatars, prototype inerte.
- Rendu Playwright : **22/22** combinaisons sans scroll nominal ni debordement a 390 x 844 et 844 x 390.
- Cibles interactives visibles : aucune sous **44 CSS px**.
- Reduced motion : animation poster desactivee.
- Contrats auth, OTP, responsive, profils, modales et analytics : **68/68 PASS** lors du dernier gate local cible.
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

1. Figer le diff complet contre le dernier `origin/main`, relire les fichiers et executer le scan de securite diff.
2. Relancer les tests Android, WebView, gateway, Edge, SQL, auth/profils et les rendus responsive/reduced-motion.
3. Pousser la branche par staging explicite, ouvrir la PR, attendre la CI et fusionner sur `main` seulement si tous les gates sont verts.
4. Appliquer la migration SQL transactionnellement, puis deployer `norva-playback` et `norva-auth-email` sur les deux replicas ainsi que le gateway media de facon coherente.
5. Verifier le deploiement Cloudflare Pages/Relay issu de `main`, puis verifier physiquement auth, profils, film, serie, precedent/suivant, fin naturelle, Retour, arriere-plan/retour, Zoom/Fit, gestes, navigation trois boutons et font 1,3.
6. Construire, signer et publier Android phone `1.3.12 (25)` uniquement apres les validations precedentes. Aucun nouveau bundle TV n'est necessaire car le lot ne modifie pas le client TV.
7. Recontroler P0, owners/pointers, jobs non terminaux/dead, transitions, sources READY, cache/refresh, crons et canaux externes.
8. Marquer l'observation active precedente stale et demarrer atomiquement une nouvelle observation rev16 a 20 % de 86 400 secondes via la RPC de changement materiel existante.
9. Produire une preuve finale horodatee et hashee distinguant Git, CI, deploiements, Google Play, validation physique et nouvelle observation.

## Interdictions maintenues pendant la release

- Aucun push direct sur `main` et aucun staging global implicite.
- Aucun gate de test ou scan de securite contourne.
- Aucune modification manuelle des lignes d'observation ; utiliser uniquement la RPC CAS prevue.
- Aucun secret, identifiant fournisseur ou credential dans cette branche.
- Aucun branchement de l'archive prototype sur les API de production.
- Aucune publication Android TV sans changement TV et nouveau versionCode explicite.
