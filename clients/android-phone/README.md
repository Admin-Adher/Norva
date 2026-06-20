# Norva — Android Phone / Tablet App

A **native player** app for phones and tablets. It opens the Norva cloud web app
(`https://norva.tv/app.html?mobile=1`) for browsing, account and cross-device
sync (resume / history / favorites), but hands actual **playback to a native
ExoPlayer (media3)**. So movies play with the device's hardware decoders
(MKV / HEVC / AC3…) straight from your **home network (residential IP)** — the
IPTV provider never sees the cloud datacenter, which it blocks.

This mirrors the Android TV client: the web app detects the native bridge
(`window.NorvaTVCloud`), resolves a **direct** provider URL via the cloud, and
plays it natively. The player reports its final position back, which is saved to
the cloud history — so a title stopped on the phone resumes on the TV / another
device, and vice-versa.

The local connector (advanced) and `norva://pair` deep links still work.

## Prerequisites

- Android Studio (or the Android command-line SDK tools) + JDK 17
- Android SDK platform 35
- A device/emulator running Android 6.0+ (API 23+)

## Build the APK

This is a standard Gradle project (same setup as `clients/android-tv`).

```bash
cd clients/android-phone
gradle :app:assembleDebug      # output: app/build/outputs/apk/debug/app-debug.apk
```

Or open `clients/android-phone/` in Android Studio → **Build → Build APK(s)**.

CI also builds it on every push to `main`: download the **Norva-AndroidPhone**
artifact from the *Build Norva* workflow run.

## Install on device

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

Sign in with your **Norva cloud account** so the app runs in cloud mode (catalog
+ resume sync). Playback then uses the native player from your home network.

## How playback works (residential, no datacenter)

1. The WebView loads the cloud app and injects `window.NorvaTVCloud`.
2. On play, the web resolves the **direct provider URL** via the cloud and calls
   `playVideoResumable(url, title, sourceId, itemType, itemId, resumeSeconds)`.
3. `PlayerActivity` (ExoPlayer) plays it from the device's residential IP,
   seeking to `resumeSeconds`.
4. On exit it returns the final position → `window.__norvaNative.onProgress(...)`
   → saved to the cloud history for cross-device resume.

`playVideoResumable` is feature-detected by the web, so older app builds keep
working (playback without resume).

## How the deep link works

A `norva://pair?hub=<url>&code=<code>` URI (from a QR scan) opens this app:
`MainActivity` extracts `hub` + `code`, saves the hub URL, and loads
`<hub>/pair-approve.html?code=<code>` to approve pairing.

## Manual local connector

From the setup panel, enter a connector address (e.g. `http://192.168.1.20:3000`)
and tap **Connect local connector**. Press the device **MENU** key to change it.

## Permissions

| Permission | Reason |
|---|---|
| `INTERNET` | Connect to Norva |
| `CAMERA` | QR code scanning inside the WebView |

Camera hardware is `required="false"` so the app installs on devices without one.

## Cleartext traffic

`android:usesCleartextTraffic="true"` + `network_security_config.xml` allow plain
HTTP to local-network IPs (e.g. `http://192.168.x.x`). HTTPS works unchanged.
