# Push mobile FCM — état + guide de mise en service (owner)

> Notifications push natives « Your catalog is ready 🎬 » délivrées **app fermée**. Tout le code (backend +
> Android + web) est **codé, mergé sur `main`, déployé**. Il ne reste que **3 étapes côté owner** (Firebase +
> secret + release Play Store) — aucune ligne de code à écrire. Ce document est la trace durable.

---

## 1. État actuel (au 2026-07-01)

**Tout est sur `main` et déployé.** Vérifié fichier par fichier + contenu :

| Couche | Élément | Où |
|---|---|---|
| Backend – route | `POST /push-token` → `registerPushToken` (upsert du token) | `supabase/functions/norva-cloud/index.ts` |
| Backend – envoi | `sendPushForGroup` + `sendFcmPush` (FCM HTTP v1, OAuth service-account) | `supabase/functions/norva-import-notify/index.ts`, `_shared/fcm.ts` |
| Backend – table | `cloud_push_tokens` (token PK, user_id, platform) — **appliquée live** | `supabase/migrations/20260630230000_push_tokens.sql` |
| Web | `registerPushToken()` lit `window.NorvaTVCloud.getPushToken()` → POST `/push-token` | `public/js/app.js` |
| Android – service | `NorvaMessagingService` (cache token + notif), déclaré au manifest (`MESSAGING_EVENT`) | `clients/android-phone/app/src/main/java/tv/norva/phone/NorvaMessagingService.java` + `AndroidManifest.xml` |
| Android – token | `setupPush()` (permission + token) + `CloudBridge.getPushToken()` | `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java` |
| Android – build | `firebase-bom:33.7.0` + `firebase-messaging` ; plugin `google-services` **conditionnel** | `clients/android-phone/app/build.gradle`, `build.gradle` |

**Ce qui est LIVE aujourd'hui** : edge functions déployées, table créée, cron digest `norva-import-notify-digest`
tourne (`*/2 * * * *`, vérifié : 235 firings / 0 échec / HTTP 200). La push est simplement **inerte** :
`fcmConfigured()` renvoie `false` tant que le secret `FCM_SERVICE_ACCOUNT` n'existe pas → l'envoyeur saute la
push et envoie l'email seul. **Rien ne casse.** Les 3 étapes ci-dessous activent la push.

**Le flux complet une fois activé** :
token FCM (Android) → cache prefs → `NorvaTVCloud.getPushToken()` → `app.js` POST `/push-token` →
`cloud_push_tokens` → le cron digest, après avoir marqué l'email `sent` (import_completed / import_failed),
**envoie aussi la push** via FCM HTTP v1 à tous les tokens de l'user (et purge les tokens `UNREGISTERED`).

---

## 2. Les 3 étapes (côté owner)

### Étape 1 — Projet Firebase + `google-services.json` (via secret GitHub)
1. Aller sur **https://console.firebase.google.com** → **Créer un projet** (nom : `Norva`). Google Analytics
   optionnel (peut être désactivé). *(Projet réel : `norva-ecosystem`.)*
2. Dans le projet → icône Android (« Ajouter une app ») → **Nom du package** : `tv.norva.phone` (exactement —
   c'est l'`applicationId` du wrapper). Surnom optionnel. **SHA-1 non requis** pour FCM (laisser vide).
3. **Télécharger `google-services.json`**.
4. **NE PAS le commiter** dans le repo (public + le *secret scanning* de GitHub **bloque** le push à cause de
   la clé API Google). À la place, le déposer en **secret GitHub** :
   - GitHub → **Settings → Secrets and variables → Actions → New repository secret**
   - Nom : **`GOOGLE_SERVICES_JSON`**
   - Valeur : **coller tout le contenu** du fichier `google-services.json` (ouvre-le dans un éditeur, copie tout).
   - Le workflow de build **écrit le fichier depuis ce secret** avant Gradle (`.github/workflows/android-release.yml`
     + `build.yml`). Le fichier reste `.gitignore` → jamais dans l'historique.
   - ✅ Distinction : la clé API dans `google-services.json` est de la config client (embarquée dans l'APK), mais
     on la garde hors du repo par propreté + pour ne pas déclencher le secret scanning. La **vraie** clé secrète
     (service account, étape 2) ne va JAMAIS dans le repo non plus — elle vit dans le secret **edge Supabase**.

*Résultat* : les builds Android (debug CI + release) matérialisent le fichier depuis le secret → le plugin
s'applique → Firebase est initialisé. Sans le secret, le plugin reste off et le build compile quand même.

### Étape 2 — Secret `FCM_SERVICE_ACCOUNT` (Supabase)
1. Firebase Console → **Paramètres du projet** (roue crantée) → onglet **Comptes de service**.
2. **Générer une nouvelle clé privée** → confirme → télécharge un fichier **JSON** (contient `client_email`,
   `private_key`, `project_id`…). **C'est un secret** — ne le commite jamais.
3. Supabase Dashboard → projet `oupsceccxsonaalhueff` → **Edge Functions → Secrets** (ou *Project Settings →
   Edge Functions*) → **Add secret** :
   - Nom : **`FCM_SERVICE_ACCOUNT`**
   - Valeur : **coller le contenu JSON complet** du fichier (tel quel, avec les `\n` de la private_key).
4. Sauvegarder. **Aucun redéploiement requis** — `fcm.ts` lit `Deno.env.get("FCM_SERVICE_ACCOUNT")` à l'exécution.

*Résultat* : `fcmConfigured()` passe à `true` → le prochain cycle du cron digest envoie les push. C'est **la
seule étape nécessaire pour que l'envoi backend fonctionne** (l'app mobile n'est requise que pour produire des
tokens à envoyer — cf. test §3).

### Étape 3 — Release Play Store (nouveau build du wrapper)
Le bridge JS (`getPushToken`) et le service FCM n'existent que dans un build **contenant** ce code → il faut
publier une nouvelle version signée.
1. Pré-requis keystore (une fois) : secrets repo `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — **voir `clients/PLAY_STORE.md`** (guide keystore + upload).
2. Incrémenter `versionCode` / `versionName` dans `clients/android-phone/app/build.gradle` (Play refuse un
   `versionCode` déjà publié).
3. Déclencher `android-release.yml` : soit **Actions → « Android Release (AAB) » → Run workflow**, soit pousser
   un **tag `vX.Y.Z`** (`git tag v1.1.0 && git push origin v1.1.0`).
4. Télécharger l'artifact **`Norva-AndroidPhone-release-aab`** (l'`.aab`) → l'uploader sur **Google Play Console**
   (piste interne/test d'abord, puis production).

*Résultat* : à l'installation, l'app récupère un token FCM, le pousse au backend, et reçoit les push app fermée.

---

## 3. Tester / vérifier

- **Sans attendre le mobile** (test backend pur) : une fois l'étape 2 faite, tu peux insérer un token de test et
  déclencher un import completed. Mais un vrai token FCM ne se génère que depuis un appareil avec l'app (étapes
  1 + 3). Le plus simple = tester end-to-end après la release.
- **Vérifier l'enregistrement des tokens** : `select count(*), platform from cloud_push_tokens group by platform;`
  (une ligne apparaît quand un appareil ouvre l'app releasée et se connecte).
- **Vérifier l'envoi** : logs de la fonction `norva-import-notify` (Supabase → Edge Functions → Logs) au moment
  d'un `import_completed` — chercher les appels `sendFcmPush`. Un token mort renvoie `unregistered` → purgé auto.
- **Déclencher un import completed** : ajouter (ou re-sync) un provider ; à la complétion, l'email part + (si le
  secret est posé + un token existe) la push part dans la fenêtre du cron (≤ 2 min).

## 4. Ordre recommandé
1. **Étape 2** (secret) — active l'envoi backend, indépendant du mobile.
2. **Étape 1** (`google-services.json` commité) — débloque le build Android FCM.
3. **Étape 3** (release) — met le bridge sur les appareils → les tokens commencent à arriver → push end-to-end.

> Réf. complémentaire : `docs/IMPORT-NOTIFICATIONS.md` §6bis (architecture Phase 2) · `clients/PLAY_STORE.md`
> (keystore + upload Play). Rien à recoder : tout est sur `main` et déployé.
