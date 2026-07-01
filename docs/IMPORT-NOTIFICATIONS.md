# Norva — Notifications de cycle de vie d'import (email + push) — WIP

> Prévenir l'user, de façon **premium**, quand l'import d'un provider **démarre** et quand il est **terminé**
> (et en cas d'**échec persistant**) — pour qu'il puisse fermer l'app et être rappelé. **Anglais uniquement**
> (Norva est English-only, pas d'i18n en roadmap).
>
> **État au 01/07** : **Phase 1 email = LIVE & déployée** (table + templates + cron digest `norva-import-notify-digest`
> `*/2` + hooks + UX ; 235 firings, 0 échec). **Phase 2 (push FCM natif) codée + déployée** côté Norva (backend
> + Android + web) et **armée** : l'owner a posé le service-account dans le secret Supabase `FCM_SERVICE_ACCOUNT`,
> le `google-services.json` est injecté au build via le **secret GitHub `GOOGLE_SERVICES_JSON`** (jamais commité —
> le secret scanning bloque la clé ; projet Firebase `norva-ecosystem`, app `tv.norva.phone`), et l'**AAB signé
> v1.1.0** (versionCode 2) est **buildé avec succès**. **Seul blocage restant** : l'owner **n'a pas encore de
> compte Google Play Console** (demande envoyée au support Google, en attente) → la release Test interne / upload
> de l'AAB reste **en attente de l'ouverture du compte**.

---

## 1. Décisions verrouillées (avec l'owner)
- **Push mobile** : **email d'abord** (Phase 1, tous appareils) ; la vraie push native (FCM) est **Phase 2**.
- **Anti-spam** : **digest groupé** — plusieurs imports qui démarrent/finissent dans une courte fenêtre = **un
  seul email** (« Your 5 catalogs are ready »).
- **Échec** : **oui**, notifier l'échec **persistant** (après retries), pas les ratés transitoires.
- **Langue** : **anglais only**.

## 2. Pourquoi le mobile est le point dur
Les apps (`clients/android-phone`, `android-tv`, `samsung-tizen`) sont des **wrappers WebView** qui chargent
`norva.tv/app.html` — **aucune infra push (FCM) aujourd'hui**. Donc :
- **Email** : marche partout, infra déjà là (Resend, cf. `norva-auth-email` + le précédent Phase 3 sous-titres).
- **Push app-fermée** : nécessite soit un **bridge FCM natif** (Firebase dans le wrapper Android → token → pont
  JS → backend → FCM HTTP v1 + **nouvelle release Play Store** ; iOS = APNs, pas d'app iOS native), soit du
  **Web Push** (peu fiable dans un WebView wrappé). → **Phase 2, bridge FCM natif** retenu.

## 3. Architecture (queue + cron digest)
Le moteur **n'envoie jamais d'email inline** — il **insère un event** dans une file ; un **cron digest** envoie.

**Table `cloud_import_notifications`** (migration `20260630210000`, **appliquée + commitée**) :
`id, user_id, source_id, kind ('import_started'|'import_completed'|'import_failed'), payload jsonb, status
('pending'|'sent'|'skipped'), created_at, sent_at`, **`unique(source_id, kind)`**.
- L'`unique(source_id, kind)` = **garde d'idempotence** : le moteur tourne en dizaines d'isolates → insert
  `ON CONFLICT DO NOTHING` → un event ne part **qu'une fois** par source par kind.
- Service-only (RLS, `service_role` seul).

**Cron digest** (~2 min) → route edge : balaie les `pending`, **groupe par `(user_id, kind)`** dans une
fenêtre, résout l'email depuis `auth.users`, **rend via `_shared/import-email.ts`**, envoie via **Resend**,
passe les lignes en `sent`. 1 provider → email simple ; N dans la fenêtre → **digest**.

## 4. Les emails (anglais, brandés, `_shared/import-email.ts` — **livré**)
Render functions pures, sans effet de bord, chacune prend un **tableau** de providers (1 = simple, N = digest) :
- `renderImportStarted` — *« Thanks for trusting Norva, Adrien — we're building your **Promax 4K OTT** catalog.
  Large providers can take a few minutes; we'll email you the moment it's ready. Feel free to close the app. »*
- `renderImportCompleted` — *« Your **Promax 4K OTT** catalog is ready — 36,000 movies · 12,000 series ·
  5,000 channels. [Open Norva] »* (deep-link `norva.tv/app.html`).
- `renderImportFailed` — *« We hit a snag importing **Promax 4K OTT** — we're on it, nothing to do on your
  side. [Contact support] »*.
- Style brandé identique à `norva-auth-email` (thème sombre, logo, CTA `#5b7cfa`).

## 5. Les hooks de cycle de vie (✅ FAIT — dans le moteur partagé)
Intégrés dans `_shared/xtream-sync.ts` (donc **une seule fois**, post-dédup) et **déployés** :
- `import_started` : à l'ajout, **1er sync seulement** (pas les refreshs). Insert `ON CONFLICT DO NOTHING`.
- `import_completed` : quand finalize passe `ready`, **1ère fois seulement**. payload = compteurs
  (movies/series/channels). À la complétion, **`skipped` un éventuel `import_failed` pending** de la même
  source (supersession, évite « échec » puis « succès » contradictoires).
- `import_failed` : sur **échec persistant** (erreur non-transitoire / budget de continuation épuisé), pas sur
  les 503 transitoires.
- **Refreshs auto = silencieux** (seulement les imports initiaux).

## 6. UX (✅ livré, branche)
- **Message à l'ajout** : lead email (fiable app-fermée) + « The mobile app will notify you too » (bannière
  in-app maintenant ; push native Phase 2). Cf. `app.js`.
- **Bannière/toast in-app** à la complétion si l'app est ouverte : `startImportWatcher()`/`stopImportWatcher()`
  (poller 30 s auto-stop, toast « 🎉 <provider> is ready to watch! » sur transition syncing→ready).

## 6bis. Phase 2 — Push FCM natif (✅ codé + déployé + armé ; ⏳ release en attente du compte Play Console)
Objectif : notifier l'appareil **app fermée** (« Your Promax catalog is ready 🎬 »). Pipeline complet :

**Flux** : Android wrapper récupère le **token FCM** → le cache en prefs → **bridge JS** `NorvaTVCloud.getPushToken()`
→ le web (`app.js registerPushToken`) **POST `/push-token`** → backend stocke dans `cloud_push_tokens` →
le **cron digest** (`norva-import-notify`), après avoir marqué l'email `sent`, **envoie aussi la push** via
**FCM HTTP v1** (OAuth service-account) à tous les tokens de l'user (supprime les tokens `UNREGISTERED`).

**Ce qui est codé + déployé** :
- **Table** `cloud_push_tokens` (migration `20260630230000`, **appliquée live**) : `token PK, user_id, platform
  ('android'|'ios'|'web'), created_at/updated_at/last_seen_at`, RLS service-only.
- **`_shared/fcm.ts`** : OAuth RS256 (JWT signé Web Crypto, scope `firebase.messaging`, token caché 1 h) +
  `sendFcmPush(token, {title, body, data})` → `…/messages:send`. `fcmConfigured()` lit l'env `FCM_SERVICE_ACCOUNT`.
- **`norva-import-notify`** : `sendPushForGroup` (lit `cloud_push_tokens`, envoie, purge UNREGISTERED), appelé
  après l'email pour `import_completed`/`import_failed`. Si `FCM_SERVICE_ACCOUNT` absent → no-op (email seul).
- **`norva-cloud`** : route `POST /push-token` → `registerPushToken` (upsert `onConflict: token`).
- **Web** `app.js` : `registerPushToken()` (lit `NorvaTVCloud.getPushToken`, retries, dédup, POST).
- **Android** : `firebase-messaging` (BoM 33.7.0) + plugin `google-services` ; `NorvaMessagingService`
  (onNewToken cache, onMessageReceived notif) ; `MainActivity.setupPush()` (perm POST_NOTIFICATIONS + cache token)
  + `CloudBridge.getPushToken()` ; service déclaré au manifest.

**Étapes manuelles (owner)** :
1. ✅ **FAIT** — **Firebase** : projet `norva-ecosystem` créé, app Android `tv.norva.phone` ajoutée,
   **`google-services.json`** obtenu. Il n'est **PAS commité** (le secret scanning bloque la clé) : il est
   déposé dans le **secret GitHub `GOOGLE_SERVICES_JSON`** et **injecté au build**. Le plugin `google-services`
   reste appliqué **conditionnellement** (seulement si le fichier est présent) : sans lui, les builds CI/debug
   compilent quand même (push inerte) ; le build de release l'injecte et active le vrai FCM.
2. ✅ **FAIT** — **Service account** (Firebase → Paramètres → Comptes de service → clé privée JSON) posé
   **complet** dans le secret edge **`FCM_SERVICE_ACCOUNT`** (Supabase → Edge Functions → Secrets). Backend armé.
3. ⏳ **EN ATTENTE** — **Release Play Store**. L'**AAB signé v1.1.0** (versionCode 2) est **buildé avec succès**
   (keystore `norva-upload.jks` + 4 secrets GitHub `ANDROID_KEYSTORE_*`), mais l'owner **n'a pas encore de compte
   Google Play Console** (demande au support Google, en attente). **Prochaine étape à l'ouverture du compte** :
   uploader l'AAB en **Test interne** → installer → tester la push.
> L'email Phase 1 est pleinement fonctionnel et déployé indépendamment de tout ça. Le backend push est **armé**
> (`FCM_SERVICE_ACCOUNT` posé) ; il ne délivrera réellement des notifications qu'une fois le wrapper contenant le
> bridge + le service installé sur l'appareil — d'où l'attente du compte Play Console pour la distribution.

## 7. Statut des tâches
| # | Tâche | État |
|---|---|---|
| 37 | Table + **cron digest** (envoyeur) | ✅ table (live) · ✅ fonction `norva-import-notify` **déployée** · ✅ cron `norva-import-notify-digest` `*/2` **enregistré** (235 firings, 0 échec) |
| 38 | Hooks lifecycle dans le moteur partagé | ✅ dans `_shared/xtream-sync.ts` **déployé** |
| 39 | Templates email anglais brandés | ✅ `_shared/import-email.ts` |
| 40 | UX ajout + bannière in-app | ✅ `app.js` (message ajout + watcher in-app) **déployé** |
| 41 | **Phase 2** push FCM natif (mobile app-fermée) | ✅ codé + **déployé** (backend + Android + web) · ✅ Firebase + `FCM_SERVICE_ACCOUNT` + `GOOGLE_SERVICES_JSON` posés · ✅ AAB signé v1.1.0 buildé · ⏳ release en attente du **compte Play Console** (owner) |
| 42 | Auto-peuplement registre providerKey→nom | ✅ `recordProviderIdentity` dans le moteur **déployé** |

## 8. Fichiers
- `supabase/migrations/20260630210000_import_lifecycle_notifications.sql` — table file (appliquée live).
- `supabase/functions/_shared/import-email.ts` — templates anglais brandés (render functions pures).
- `supabase/functions/_shared/xtream-sync.ts` — hooks `enqueueImportNotification` (started/completed/failed)
  + `recordProviderIdentity` (registre). `norva-source-sync` ajoute `import_completed`/`import_failed` au finalize.
- `supabase/functions/norva-import-notify/index.ts` — **l'envoyeur digest** : lit la file (events ≥ 60 s pour
  laisser un burst se tasser), groupe par `(user, kind)`, résout email (`auth.users`) + nom (`cloud_sources`)
  + compteurs (`cloud_media_items` pour completed), rend via les templates, envoie via Resend, passe en `sent`,
  **puis envoie la push FCM** (`sendPushForGroup`) pour completed/failed. Auth = `norva_verify_cron_secret`.
  **Cron à enregistrer au déploiement** (SQL dans l'en-tête du fichier, secret `norva_cron_shared_secret`).
- `supabase/migrations/20260630230000_push_tokens.sql` — table `cloud_push_tokens` (appliquée live).
- `supabase/functions/_shared/fcm.ts` — FCM HTTP v1 : OAuth service-account (JWT RS256 Web Crypto) +
  `sendFcmPush` + `fcmConfigured`.
- `supabase/functions/norva-cloud/index.ts` — route `POST /push-token` → `registerPushToken` (upsert token).
- `public/js/app.js` — `registerPushToken` (bridge `NorvaTVCloud.getPushToken` → POST `/push-token`).
- `clients/android-phone/` — `build.gradle` + `app/build.gradle` (plugin `google-services` + `firebase-messaging`
  BoM 33.7.0), `NorvaMessagingService.java` (token cache + notif), `MainActivity.java` (`setupPush` +
  `CloudBridge.getPushToken`), `AndroidManifest.xml` (déclaration du service).

> **Ordre de déploiement** (tout ensemble, une fois la dédup validée en profondeur) : push `main` (déploie
> moteur+hooks+`norva-import-notify`+route `/push-token`), PUIS `cron.schedule('norva-import-notify-digest',
> '*/2 * * * *', …)`. Ne PAS enregistrer le cron avant le déploiement (il taperait une fonction 404).
> La **push FCM** ne s'active que quand l'owner pose `FCM_SERVICE_ACCOUNT` + `google-services.json` + release
> Play Store (cf. §6bis) ; sans ça, l'email Phase 1 fonctionne seul, rien ne casse.
