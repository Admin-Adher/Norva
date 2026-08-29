# Migration vers la production

## Objectif

Remplacer l'onboarding/authentification et l'habillage des profils par le candidat L sans remplacer les contrats de session, de securite, de profils ni les modeles d'interaction propres au web, au telephone et a la TV.

## Architecture cible

### Authentification

- Point d'entree actuel : `public/account.html`.
- Transport/session : `public/js/authApi.js`.
- Donnees, attribution et post-auth : logique actuelle de `public/account.html` et `public/js/cloudApi.js`.
- Habillage de production : `public/css/account-premium.css`, charge par `public/account.html` sur web et Android phone uniquement.
- Machine d'etats : conservee dans `public/account.html` pour preserver l'ordre de boot, les retours OAuth/pairing et les contrats historiques pendant ce changement materiel. Une extraction JavaScript ulterieure devra etre strictement neutre et ne fait pas partie de cette release.

Le futur composant visuel doit appeler les fonctions existantes plutot que reimplementer Supabase :

- `NorvaAuth.signInWithOtp(...)` pour demander le code natif et conserver le lien securise de repli ;
- `NorvaAuth.verifyEmailOtp(...)` pour verifier les six chiffres cote GoTrue ;
- `NorvaAuth.signIn(...)` pour le mot de passe facultatif ;
- `NorvaAuth.signInWithOAuth(...)` sur le web ;
- `NorvaAuth.signInWithIdToken(...)` depuis le pont Android Google ;
- `ensureProfile()` puis la capture d'attribution avant redirection.

### Profils

- Vue et orchestration actuelles : `public/js/profiles.js`.
- API : `window.NorvaCloud.profiles` dans `public/js/cloudApi.js`.
- Cible recommandee : conserver toute la machine d'etats, les single-flights, les verrous de plan, les confirmations et les appels API, puis remplacer uniquement les renderers et styles.

Les contrats a conserver sont :

- `list`, `create`, `update`, `remove`, `setActiveId` ;
- auto-selection si un seul profil configure existe ;
- setup initial si `setup_completed` est faux ;
- chooser par session si plusieurs profils existent ;
- profil verrouille apres downgrade ;
- confirmation fail-closed avant suppression ;
- invalidation des caches lors d'un changement de profil.

## Travail preparatoire deja termine

- Sources et preuves visuelles archivees dans le depot.
- Etats auth et profils inventories.
- Assets locaux figes, sans dependance CDN ou Lottie distante.
- Animation poster avec fallback `prefers-reduced-motion`.
- Cibles 390 x 844, 375 x 667, 844 x 390 et font scale 1,3 deja representees dans les fixtures.
- Absence de mode Kids encodee dans le candidat.
- Validateur statique ajoute pour detecter les references manquantes, les appels reseau accidentels et les regressions structurelles.

## Etat du candidat de production

### 1. Contrat email retenu

Le candidat utilise le code email natif GoTrue a six chiffres, verifie par `verifyEmailOtp({ email, token })` sur `/auth/v1/verify` avec `type=email`. Le lien `token_hash` reste un repli securise dans le meme email. Le contrat preserve :

- la neutralite des messages pour ne pas reveler si un compte existe ;
- la creation explicite ou non du compte selon le contexte ;
- le rate limiting, l'expiration et la protection contre le rejeu ;
- le retour Android, la reprise apres mise en arriere-plan et le resend borne ;
- l'attribution signup seulement apres une authentification valide.

Le client appelle `signInWithOtp(createUser: true)` pour les adresses connues ou nouvelles sans branche cliente. Les messages restent neutres ; l'attribution n'est finalisee qu'apres session valide.

### 2. Integration de la page compte

Les styles premium sont extraits dans `public/css/account-premium.css`. Les IDs et semantiques historiques restent couverts par les tests. Le controleur demeure volontairement dans `account.html` pour cette release afin de ne pas melanger une extraction structurelle risquee avec le changement de parcours.

### 3. Adapter les tokens

Les valeurs du prototype doivent etre mappees sur les variables de `public/css/main.css` :

- surfaces vers `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary` ;
- actions vers `--color-accent`, `--color-accent-hover`, `--color-accent-secondary` ;
- texte vers `--color-text-primary` et `--color-text-secondary` ;
- rayons vers `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full` ;
- espacements vers le rythme 4/8/16/24/32/48 existant.

Aucune seconde palette indigo ne doit etre introduite dans les clients Android.

### 4. Adapter les interactions par plateforme

- Web : clavier complet, focus visible, historique Back/Forward et pointeur.
- Telephone : cibles de 44 CSS px minimum dans la WebView, gestes et barre trois boutons, IME visible, TalkBack et font scale 1,3.
- TV : focus D-pad explicite, aucune ouverture automatique de l'IME, Back ferme d'abord la surface active.

Le `no scroll` approuve concerne la composition nominale. En production, un fallback de reflow ou de scroll interne controle doit rester disponible pour IME, texte traduit exceptionnellement long ou tres grand texte, afin de ne jamais rendre une action inaccessible.

### 5. Instrumenter les funnels

Reutiliser `NorvaTrackProduct` avec des noms stables et sans PII :

- `auth_email_submitted` ;
- `auth_email_link_requested` ou `auth_email_code_requested` ;
- `auth_email_verified` ;
- `auth_password_fallback_opened` ;
- `auth_google_started/completed` ;
- `profile_picker_shown` ;
- `profile_selected` ;
- `profile_setup_started/completed` ;
- `profile_avatar_opened/selected`.

Ne jamais envoyer email, nom de profil, identifiant de compte, token ou code dans Clarity/analytics.

## Strategie de commits recommandee

1. `refactor(auth): extract account styles and controller` sans changement rendu.
2. `feat(auth): add unified email-first journey` avec transport existant.
3. `feat(profiles): apply approved profile journey visuals` sans changement API.
4. `feat(auth): add verified six-digit email otp` dans un commit backend/frontend separe.
5. `test(auth): add responsive, accessibility and platform contracts`.

Le lot groupe a recu l'autorisation explicite de production le 2026-08-29. Il reste soumis au scan de securite, a la CI, aux validations physiques et au redemarrage atomique de l'observation Provider Access.
