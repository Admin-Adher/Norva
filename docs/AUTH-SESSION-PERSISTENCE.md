# Sessions — fin des « déconnexions après inactivité » (2026-07-10)

> Exigence du fondateur : **« la seule chose qui doit nous déconnecter, c'est le
> bouton de déconnexion »**. Audit en profondeur par workflow adversarial
> (10 agents : 5 lectures — web, courses de rotation, serveur/logs, natif,
> account.html — 4 vérifications, 1 synthèse), puis correctifs vérifiés par
> harnais Node (20/20 scénarios) et déployés.

## 1. Verdict serveur : Supabase n'expire RIEN tout seul

Vérifié en prod (`auth.sessions`, `auth.refresh_tokens`, logs auth) :
- `not_after` **NULL sur toutes les sessions** → pas de time-box dashboard.
- Un refresh a **réussi après 18 h 17 d'inactivité** → pas d'inactivity-timeout
  aux échelles du bug (~1 h).
- Un refresh token de **62 h, jamais tourné, toujours valide** → pas de TTL.
→ **Aucun réglage dashboard à changer.** Les suppressions de sessions
observées (4 re-logins du compte propriétaire le seul 10-07) étaient
déclenchées **par le client**.

## 2. Les 5 causes (toutes côté client, toutes corrigées)

| # | Cause | Correctif |
|---|---|---|
| 1 | **Portes de boot expiry-gated** : `app.html`/`index.html`/`app.js hasCloudSession`/`landing.js` exigeaient `expires_at > now+30` → tout chargement à froid >1 h après le dernier renvoyait une session **encore valide** vers login/landing | Les 4 portes (+ copies mobile-pwa) acceptent `access_token && refresh_token && user.id` **sans condition d'expiration** — le refresh de boot tourne le jeton |
| 2 | **Échecs transitoires avalés** : `refreshSession().catch(()=>null)` → une panne réseau au réveil = « déconnecté » ; `checkAuth` redirigeait sur **toute** exception ; `account.html boot()` montrait le formulaire sur tout échec | **Classification** : seul un **400/401 de POST /token portant sur le jeton encore stocké** est définitif (`err.definitive`, session effacée). Réseau/5xx/429 = transitoire (`err.transient`) : session **conservée**, retry ~1,5 s, `checkAuth` continue avec l'utilisateur en cache, `account.html` re-bounce au lieu du formulaire |
| 3 | **Course de rotation** (refresh token à usage unique, 0 verrou) : 2 onglets qui se réveillent → réutilisation détectée par GoTrue → **révocation de toute la famille** = vraie déconnexion serveur | `refreshSession` = **single-flight par onglet + verrou inter-onglets** (`navigator.locks`, repli lease localStorage) + relecture sous verrou (adopte la rotation d'un autre onglet) + le retry ~1,5 s récupère un « jeton brûlé » dans l'intervalle de réutilisation ~10 s |
| 4 | **Logout GLOBAL** : `/auth/v1/logout` sans scope → le bouton d'UN appareil révoquait les sessions de **tous** les appareils du foyer (qui semblaient ensuite « déconnectés après inactivité ») | `POST /auth/v1/logout?scope=local` — le bouton ne déconnecte **que cet appareil** |
| 5 | Annexe : `api.js _hasCloudUserSession` expiry-aware → onglet ouvert >1 h : favoris vides, playback routé « device », bascule vers l'ancien `/api` | Expiry-agnostique (aligné sur `_hasCloudUserAccount`) — le 401→refresh de `requestToBase` guérit en cours de session |

Plus : **refresh proactif** (`app.js startSessionKeepFresh` — timer 60 s +
`visibilitychange`, rotation ~2 min avant expiration, jamais sur les écrans
device-token) et **fast-path TV** (`cloud-pair.html` réutilise le
device-token stocké et ne ré-appaire que sur 401/403 — plus de re-pairing
systématique).

## 3. Vérifications

- Harnais Node (mock GoTrue), **20/20** sur les deux branches de verrou
  (web-locks + fallback) : refresh OK / single-flight (2 appels concurrents →
  1 POST) / transitoire-puis-OK / transitoire persistant (session gardée,
  jeton périmé rendu) / définitif (session effacée + flag) / **jeton brûlé
  récupéré** / getUser 5xx & panne réseau jamais définitifs / signOut
  `scope=local` / sans session zéro POST.
- `node --check` sur tous les JS modifiés ; plus aucune clause d'expiration
  dans les portes (grep).

## 4. Ce qui peut ENCORE déconnecter (assumé, hors de portée client)

- Changement/réinit de mot de passe, suppression de compte, révocation
  manuelle des sessions (dashboard) — voulu par GoTrue.
- Android qui efface les données de l'app (« Effacer le stockage »,
  réinstallation, éviction WebView sous pression de stockage).
- Navigation privée / purge des données de site par le navigateur (ITP Safari).
- Les appareils déjà révoqués par un ancien logout **global** (avant ce fix)
  devront se reconnecter une dernière fois.
- Panne réseau **prolongée** au réveil : après épuisement des retries,
  `account.html` peut montrer le formulaire, mais la session reste en
  localStorage — le chargement suivant re-bounce (dégradation, plus une
  déconnexion).

## 5. Suivi post-déploiement

Surveiller quelques jours : la cadence de créations de sessions du compte
propriétaire doit retomber à ~0 hors logins volontaires
(`select count(*) from auth.sessions where user_id = …`), et les trous d'ids
dans `auth.refresh_tokens` (résidus de kills de famille) doivent cesser de
croître.

Fichiers touchés : `public/js/authApi.js` (cœur), `public/js/app.js`,
`public/js/api.js`, `public/app.html`, `public/index.html`,
`public/js/landing.js`, `public/account.html`, `public/cloud-pair.html`,
`clients/mobile-pwa/{authApi.js,index.html}`.
