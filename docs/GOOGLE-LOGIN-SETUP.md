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

## Étape 2 — App Android phone : Google Sign-In **natif** — **CODÉ [repo]**

L'app phone (`tv.norva.phone`) est un **WebView** qui charge `norva.tv/account.html`.
Google **bloque l'OAuth dans un WebView brut** (`disallowed_useragent`), donc le
bouton « Continue with Google » en contexte natif appelle un **bridge natif**
(Credential Manager, sélecteur de compte Google) au lieu d'un redirect web.

Flux implémenté :
1. Web (`account.html`) : en natif, si le bridge `NorvaTVCloud.googleSignIn` existe,
   le bouton Google l'appelle. Rétrocompatible : sans bridge (ancien APK), le bouton
   reste masqué comme avant.
2. Java (`MainActivity`) : `googleSignIn()` → **Credential Manager**
   (`GetGoogleIdOption.setServerClientId(<WEB client id>)`) → **ID token** → renvoyé
   au web via `window.onNorvaGoogleIdToken(idToken, error)`.
3. Web : `NorvaAuth.signInWithIdToken({ provider:'google', token })` → session Norva.

Ce qui est déjà en place **[repo]** : deps `androidx.credentials` + `googleid` dans
`build.gradle` ; le bridge + `startGoogleSignIn()` dans `MainActivity.java` ; le
wiring web + callback dans `account.html`.

Ce qu'il reste à toi **[console + secret]** pour l'activer :
1. **Google Cloud** → OAuth client **« Android »** : package `tv.norva.phone` +
   **SHA-256 de la clé de signature Play** (disponible seulement **après** le 1ᵉʳ
   upload d'AAB — voir `clients/PLAY_STORE_RELEASE_STATUS.md` §4).
2. **Supabase** → Auth → Providers → Google → **Authorized Client IDs** : ajouter
   le client_id **Android** (en plus du **Web**).
3. Renseigner le **Web** client id dans `clients/android-phone/app/src/main/res/values/strings.xml`
   → `<string name="norva_google_web_client_id">…apps.googleusercontent.com</string>`
   (laissé vide = Google natif dormant, le bouton renvoie une erreur propre).
4. Rebuild + upload d'un nouvel AAB (bumper `versionCode`).

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
