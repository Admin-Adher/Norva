# Migration vers la production

## Objectif

Remplacer l'onboarding/authentification et l'habillage des profils par le candidat L sans remplacer les contrats de session, de securite, de profils ni les modeles d'interaction propres au web, au telephone et a la TV.

## Architecture cible

### Authentification

- Point d'entree actuel : `public/account.html`.
- Transport/session : `public/js/authApi.js`.
- Donnees, attribution et post-auth : logique actuelle de `public/account.html` et `public/js/cloudApi.js`.
- Cible recommandee : extraire l'habillage et la machine d'etats dans `public/css/account.css` et `public/js/account.js` au lieu d'ajouter une seconde page concurrente.

Le futur composant visuel doit appeler les fonctions existantes plutot que reimplementer Supabase :

- `NorvaAuth.signInWithOtp(...)` pour le lien securise actuel ;
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

## Travail restant avant activation

### 1. Choisir le contrat email

Option A, moins risquee : conserver le lien securise actuel et adapter le visuel du prototype en un ecran `Check your email` sans cases numeriques.

Option B, plus fluide en WebView : ajouter un vrai code email cote Supabase/serveur, puis une methode `verifyEmailOtp({ email, token, type })` qui POSTe vers `/auth/v1/verify`. Cette option doit preserver :

- la neutralite des messages pour ne pas reveler si un compte existe ;
- la creation explicite ou non du compte selon le contexte ;
- le rate limiting, l'expiration et la protection contre le rejeu ;
- le retour Android, la reprise apres mise en arriere-plan et le resend borne ;
- l'attribution signup seulement apres une authentification valide.

Tant que ce choix n'est pas implemente et teste, les quatre cases OTP restent purement illustratives.

### 2. Extraire le code inline de `account.html`

La page contient aujourd'hui styles et logique inline. Avant le remplacement visuel :

1. extraire sans changement fonctionnel les styles vers un fichier dedie ;
2. extraire la logique vers un module dedie ;
3. garder les IDs/semantiques couverts par les tests existants ;
4. seulement ensuite remplacer les renderers par les etats du candidat L.

Cette sequence permet de separer une refactorisation neutre d'un changement UX et rend les regressions plus faciles a localiser.

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
4. Eventuellement `feat(auth): add verified numeric email otp` dans un commit backend/frontend separe.
5. `test(auth): add responsive, accessibility and platform contracts`.

Ces commits peuvent rester dans ce worktree jusqu'au gate de production. Ils ne doivent pas etre melanges avec une migration SQL ou une publication Google Play sans audit de release explicite.
