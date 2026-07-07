# Connexion Google (Supabase OAuth) — setup & plan

Ajout du « Se connecter avec Google » **en plus** de la connexion e-mail /
mot de passe existante. L'auth compte Norva passe par **Supabase GoTrue**
(`public/js/authApi.js`), donc Google est un simple **provider OAuth** à activer.

Items **[repo]** = faits dans ce dépôt. **[console]** = actions hors-repo
(Google Cloud Console / Supabase Dashboard) que **tu** réalises une fois.

---

## Où le code en est — étape 1 faite **[repo]**

Couvre **web (norva.tv)**, **PWA mobile** et **desktop (Electron)**.

- `public/js/authApi.js` : `signInWithOAuth()` est désormais **exporté** dans
  `window.NorvaAuth` (il était implémenté mais absent de l'objet public — le
  bouton aurait planté). Ajout aussi de `signInWithIdToken()` (primitif pour le
  Google Sign-In **natif** Android — étape 2).
- `public/account.html` : `OAUTH_PROVIDERS = ['google']`. Le bouton stylé
  « Continue with Google », le handler de clic et la capture de session au
  retour (`captureSessionFromUrl()`) existaient déjà.
- **PWA mobile** : `clients/mobile-pwa/account.html` **redirige** vers
  `https://norva.tv/account.html` → hérite du fix automatiquement. Rien à faire.
- **Electron** (`electron-main.js`) : les hôtes d'identité (Supabase, Google,
  Apple) sont autorisés à naviguer **dans la fenêtre** au lieu d'être renvoyés
  au navigateur système, pour que le redirect OAuth revienne bien à l'app.

> Le code reste **dormant** tant que l'étape 0 ci-dessous n'est pas faite :
> sans provider activé côté Supabase, le clic renverrait une erreur GoTrue.

---

## Étape 0 — Config à faire une fois **[console]**

### Google Cloud Console → APIs & Services → Credentials
1. **OAuth client « Web application »** → récupérer `client_id` + `client_secret`.
   - Authorized redirect URI :
     `https://oupsceccxsonaalhueff.supabase.co/auth/v1/callback`
2. (Étape 2 / Android natif) **OAuth client « Android »** :
   - Package name : `tv.norva.phone`
   - SHA-256 : **la clé de signature de l'application Play** (la *même* empreinte
     que celle attendue par `public/.well-known/assetlinks.json` — voir
     `clients/PLAY_STORE_RELEASE_STATUS.md` §4 ; **pas** la clé d'upload).

### Supabase Dashboard → Authentication
3. **Providers → Google → Enable** → coller `client_id` + `client_secret` du
   client **Web**. Pour l'Android natif, ajouter le `client_id` **Android** (et
   celui de la Web) dans **Authorized Client IDs**.
4. **URL Configuration → Redirect URLs** → allow-list :
   - `https://norva.tv/account.html`
   - `https://norva.tv/account.html?**`
   - dev : `http://localhost:*`

Après ça, « Continue with Google » est live sur web + PWA + desktop.

### Cas particulier — desktop Electron
Par défaut, l'app desktop sert l'UI depuis un serveur local sur un **port
aléatoire** (`http://127.0.0.1:3002-3999`, voir `electron-main.js`), donc le
`redirect_to` OAuth n'est pas stable. Deux options pour faire marcher Google
dans l'app desktop :
- **(recommandé)** lancer le build cloud : `NORVA_DESKTOP_URL=https://norva.tv/app.html`
  → l'origine est `https://norva.tv`, déjà allow-listée ci-dessus ;
- **sinon** allow-lister le wildcard port `http://127.0.0.1:*` dans les Redirect
  URLs Supabase **et** dans les origines JavaScript du client OAuth Web (Google
  Cloud). `electron-main.js` autorise déjà les hôtes d'identité à naviguer
  in-window pour que la session revienne à la fenêtre.

---

## Étape 2 — App Android phone : Google Sign-In **natif** (choisi)

L'app phone (`tv.norva.phone`) est un **WebView** natif qui charge
`norva.tv/account.html`. Google **bloque l'OAuth dans un WebView brut**
(`disallowed_useragent` / 403), donc on ne passe **pas** par le bouton web dans
l'app : on utilise le **sélecteur de compte natif** (UX « 1 tap »).

Flux cible :
1. `MainActivity` expose un bridge JS (ex. `window.__norvaNative.googleSignIn()`).
2. Le bouton Google, en contexte natif, appelle le bridge au lieu du redirect web.
3. Côté Java : **Credential Manager** (`androidx.credentials` +
   `com.google.android.libraries.identity.googleid`) ouvre le sélecteur de compte
   Google et renvoie un **ID token**.
4. Le token est réinjecté dans le WebView → `NorvaAuth.signInWithIdToken({
   provider: 'google', token })` (déjà implémenté) → session Norva posée.

Dépendances à ajouter dans `clients/android-phone/app/build.gradle` :
```gradle
implementation "androidx.credentials:credentials:1.3.0"
implementation "androidx.credentials:credentials-play-services-auth:1.3.0"
implementation "com.google.android.libraries.identity.googleid:googleid:1.1.1"
```

Pré-requis : client OAuth **Android** créé (étape 0.2) + `client_id` **Web**
(le `serverClientId` passé au Credential Manager est celui du client **Web**).

---

## Étape 3 — Android TV : appairage (inchangé) ✅

L'app TV (`tv.norva.tv`) fait déjà de l'**appairage** par défaut
(`cloud-pair.html`). Taper un login Google à la télécommande = mauvaise UX, et le
WebView TV bloquerait aussi l'OAuth. On **garde l'appairage** : l'utilisateur se
connecte avec Google sur son téléphone ou le web, puis appaire la TV via QR/code.
Rien à faire côté TV.

---

## Test rapide (après étape 0)

1. Ouvrir `https://norva.tv/account.html` → le bouton « Continue with Google »
   apparaît sous le formulaire.
2. Cliquer → consentement Google → retour sur `account.html#access_token=…` →
   redirection vers l'app, connecté.
3. Vérifier dans Supabase → Authentication → Users que l'identité Google est liée.
