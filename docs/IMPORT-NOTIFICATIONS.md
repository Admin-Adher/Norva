# Norva — Notifications de cycle de vie d'import (email + push) — WIP

> Prévenir l'user, de façon **premium**, quand l'import d'un provider **démarre** et quand il est **terminé**
> (et en cas d'**échec persistant**) — pour qu'il puisse fermer l'app et être rappelé. **Anglais uniquement**
> (Norva est English-only, pas d'i18n en roadmap).
>
> **État au 30/06** : design validé. **Phase 1 livrée** (table + templates + cron digest + hooks + UX), en
> **branche/held**. **Phase 2 (push FCM natif) codée** côté Norva (table tokens + envoi FCM + bridge Android +
> web), **held** ; reste le **setup Firebase** + la **release Play Store** (côté owner). Déploiement groupé une
> fois la dédup validée.

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

## 5. Les hooks de cycle de vie (À FAIRE — dans le moteur partagé)
À insérer dans `_shared/xtream-sync.ts` (**après** la dédup — cf. `SYNC-ENGINE-DEDUP.md`) pour exister **une
seule fois** :
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

## 6bis. Phase 2 — Push FCM natif (✅ codé côté Norva, held ; setup Firebase + release = owner)
Objectif : notifier l'appareil **app fermée** (« Your Promax catalog is ready 🎬 »). Pipeline complet :

**Flux** : Android wrapper récupère le **token FCM** → le cache en prefs → **bridge JS** `NorvaTVCloud.getPushToken()`
→ le web (`app.js registerPushToken`) **POST `/push-token`** → backend stocke dans `cloud_push_tokens` →
le **cron digest** (`norva-import-notify`), après avoir marqué l'email `sent`, **envoie aussi la push** via
**FCM HTTP v1** (OAuth service-account) à tous les tokens de l'user (supprime les tokens `UNREGISTERED`).

**Ce qui est codé (branche, held)** :
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

**⚠️ Étapes manuelles (owner) avant que la push fonctionne** :
1. **Firebase Console** → créer le projet → ajouter l'app Android `tv.norva.phone` → télécharger
   **`google-services.json`** → le déposer dans `clients/android-phone/app/`. Le plugin `google-services`
   est appliqué **conditionnellement** (seulement si ce fichier existe) : sans lui, les builds CI/debug
   compilent quand même (push inerte) ; la release Play Store l'applique et active le vrai FCM.
2. **Service account** (Firebase → Paramètres → Comptes de service → générer une clé privée JSON) → poser le
   JSON **complet** dans le secret edge **`FCM_SERVICE_ACCOUNT`** (Supabase → Edge Functions → Secrets).
3. **Release Play Store** d'une nouvelle version du wrapper (le bridge + le service n'existent que dans ce build).
> Tant que ces 3 étapes ne sont pas faites, **rien ne casse** : pas de `FCM_SERVICE_ACCOUNT` → l'envoyeur saute
> la push (email seul) ; pas de `google-services.json` → le plugin reste désactivé, **les builds CI/debug
> compilent quand même** (push inerte). L'email Phase 1 reste pleinement fonctionnel sans Firebase.

## 7. Statut des tâches
| # | Tâche | État |
|---|---|---|
| 37 | Table + **cron digest** (envoyeur) | ✅ table (live) · ✅ fonction `norva-import-notify` (branche, **non déployée**) · ⏳ `cron.schedule` à enregistrer AU déploiement |
| 38 | Hooks lifecycle dans le moteur partagé | ✅ dans `_shared/xtream-sync.ts` (branche, non déployé) |
| 39 | Templates email anglais brandés | ✅ `_shared/import-email.ts` |
| 40 | UX ajout + bannière in-app | ✅ `app.js` (message ajout + watcher in-app) (branche) |
| 41 | **Phase 2** push FCM natif (mobile app-fermée) | ✅ codé côté Norva (branche, held) · ⏳ setup Firebase + release Play Store (owner) |
| 42 | Auto-peuplement registre providerKey→nom | ✅ `recordProviderIdentity` dans le moteur (branche) |

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
