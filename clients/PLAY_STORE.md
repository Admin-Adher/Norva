# Google Play readiness — Norva (Android phone + TV)

Practical checklist to get both apps accepted on Google Play. Items marked
**[repo]** are handled in this repository; **[console]** are actions you do in the
Play Console / outside the repo.

## 1. Build & signing — **[repo + you provide secrets]**

Play requires a **signed release App Bundle (.aab)**, not a debug APK.

- `app/build.gradle` (both apps) now has a `release` build type and a
  `signingConfigs.release` that reads the keystore from env. Debug builds are
  unaffected (still `assembleDebug`).
- The `.github/workflows/android-release.yml` workflow builds the signed AABs.
  Run it from the **Actions** tab ("Run workflow") or by pushing a `v*` tag.

Create an **upload keystore** once and add it as repo secrets:

```bash
keytool -genkey -v -keystore norva-upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias norva
base64 -w0 norva-upload.jks   # value for ANDROID_KEYSTORE_BASE64
```

Repository → Settings → Secrets and variables → Actions → add:
| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of `norva-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `norva` (or your alias) |
| `ANDROID_KEY_PASSWORD` | key password |

Keep the keystore safe (back it up). With **Play App Signing** (recommended,
default), this is your *upload* key; Google holds the app signing key.

## 2. App identity — **[repo, done]**

- Application IDs (immutable after first publish): `tv.norva.phone`, `tv.norva.tv`.
- Target/compile SDK 35, min SDK 23. ✅ (meets Play's API-35 requirement.)
- **Android App Links** (`public/.well-known/assetlinks.json`): only the phone
  app declares `autoVerify` https links to `norva.tv` (`/app.html`, `/t/`), so
  the file lists **only** `tv.norva.phone` — the TV app uses the `norva://open`
  custom scheme and needs no entry. ⚠️ **Last repo blocker:** replace
  `REPLACE_WITH_RELEASE_SIGNING_SHA256_FROM_PLAY_CONSOLE` with the **App signing
  key** SHA-256 from Play Console → (phone app) → Test and release → App
  integrity → App signing key certificate, then commit + deploy.

## 3. Privacy policy — **[repo, done] + [console]**

- Hosted at `https://norva.tv/privacy.html` and `…/terms.html`, linked in-app
  (login screen + Settings → Account) and in the web footer.
- **[console]** Paste the privacy policy URL in the Play Console store listing.
- ✅ Operator/legal entity filled in with real data (Adrien Hernandez EI,
  RCS Paris 824 852 081) across `privacy.html`, `terms.html` and
  `mentions-legales.html`; French governing law + consumer mediator (CM2C) set.

## 4. Account deletion — **[repo, done] + [console]**

Required for any app offering account creation.

- In-app: Settings → Account → **Delete account** (cloud accounts).
- Web (no install needed): `https://norva.tv/delete-account.html`.
- Backed by the Supabase edge function `norva-account-delete` (service-role
  deletion of the auth user + their rows).
- **[console]** Provide the web deletion URL in the Data safety form.

## 5. Data safety form — **[console]**

Declare what the apps collect (see `public/privacy.html` for the full list):
- Personal: **email**, **name**. Purpose: account, app functionality.
- App activity: **watch history / progress / favorites**. Purpose: app functionality.
- App info & performance: **crash logs / diagnostics**.
- Device/identifiers: **IP address** (used for streaming/security).
- "User can request data deletion" → **yes**, with the URL from §4.
- Data encrypted in transit → **yes**. No data sold. No third-party ads.
- Note: media-source credentials you enter are stored to connect to *your*
  source; declare under "app functionality".

## 6. Permissions & foreground service — **[console declarations]**

- **CAMERA** (phone): used only to scan a QR pairing code. Add a prominent
  in-flow rationale; declare the use in the listing. `uses-feature camera
  required="false"` is already set so non-camera devices can install.
- **POST_NOTIFICATIONS** (phone): download progress notifications (runtime
  permission on Android 13+).
- **Foreground service `dataSync`** (phone, downloads): Android 14+ requires the
  type (set) and Play requires the **Foreground Service** declaration form —
  justify as "user-initiated media download with a visible progress
  notification". Keep sessions short/user-initiated.

## 7. Cleartext traffic — **[repo note]**

`usesCleartextTraffic="true"` + a permissive `network_security_config.xml` are
intentional: many IPTV sources and the LAN self-hosted hub serve over plain
HTTP, so scoping cleartext would break playback. This is a pre-launch *warning*,
not a rejection. If you later restrict it, allow-list the hub subnet and known
source hosts rather than disabling globally.

## 8. Content & IP positioning — **[console, important]**

This is the top rejection risk for media-player/IPTV apps. Keep the listing
unambiguous:
- Describe Norva as a **player/organizer that includes no content**; the user
  connects a **compatible source they own and are authorized to use**.
- Do **not** mention IPTV resale, free channels/movies/sports, or name
  third-party services.
- The in-app disclaimer (login + Settings) reinforces this.

## 9. Review access — **[console]**

Google reviews behind the login. Provide **demo credentials** (a test cloud
account with a valid entitlement) in App content → "App access", or the review
may be rejected as "login wall, can't test".

## 10. Native libraries / 16 KB — **[verify]**

Apps targeting API 35 must support 16 KB memory pages. `media3 1.5.1` ships
16 KB-aligned native libs; if a pre-launch report flags alignment, bump media3
to the latest 1.x.

## 11. Store assets — **[console]**

Icon (512×512), feature graphic (1024×500), phone screenshots, **TV banner +
TV screenshots** (the TV app declares `android:banner`), short/full description,
content rating questionnaire, target audience.
