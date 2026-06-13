# Norva TV — Android Phone App

A thin WebView wrapper for phones (portrait mode) that connects to your local Norva hub. It also handles `norva://pair` deep links so the OS automatically routes QR-scanned pairing URLs into this app.

## Prerequisites

- Android Studio (or the Android command-line SDK tools)
- Java 11+
- A device or emulator running Android 8.0+ (API 26+)

## Build the APK

This project uses the same manual (no Gradle) build process as the Android TV client. Steps:

```bash
# 1. Compile
javac -source 8 -target 8 \
  -classpath $ANDROID_SDK/platforms/android-34/android.jar \
  app/src/main/java/tv/nodecast/mobile/MainActivity.java \
  -d build/classes

# 2. Package resources
$ANDROID_SDK/build-tools/34.0.0/aapt package -f -m \
  -S app/src/main/res \
  -M app/src/main/AndroidManifest.xml \
  -I $ANDROID_SDK/platforms/android-34/android.jar \
  -J build/gen \
  -F build/norva-mobile-unsigned.apk

# 3. Add classes
dx --dex --output=build/classes.dex build/classes
zip -j build/norva-mobile-unsigned.apk build/classes.dex

# 4. Sign (debug)
apksigner sign --ks ~/.android/debug.keystore \
  --ks-pass pass:android \
  --out build/norva-mobile.apk \
  build/norva-mobile-unsigned.apk
```

Or open the `clients/android-phone/` folder in Android Studio and use **Build → Build Bundle(s)/APK(s) → Build APK(s)**.

## Install on device

```bash
adb install build/norva-mobile.apk
```

## How the deep link works

When a user scans a QR code that encodes a `norva://pair?hub=<url>&code=<code>` URI (from any camera app or QR reader), Android looks for an app that handles the `norva` scheme and `pair` host — that's this app.

The `MainActivity.onCreate` method:
1. Detects the `ACTION_VIEW` intent with `norva://pair` URI.
2. Extracts `hub` and `code` query parameters.
3. Saves the hub URL to `SharedPreferences`.
4. Loads `<hub>/pair-approve.html?code=<code>` in the WebView, where the user can approve pairing.

## Manual connection

On first launch (no saved hub URL), the app shows a setup panel with a URL field. Enter your hub's local address (e.g. `http://192.168.1.20:3000`) and tap **Connect**.

To change the hub later, press the device **MENU** key from inside the app — the setup panel reappears.

## Permissions

| Permission | Reason |
|---|---|
| `INTERNET` | Connect to the Norva hub |
| `CAMERA` | QR code scanning inside the WebView |

Camera hardware is marked `required="false"` so the app installs on devices without cameras.

## Cleartext traffic

`android:usesCleartextTraffic="true"` and the `network_security_config.xml` allow plain HTTP to local-network IPs (e.g. `http://192.168.x.x`). HTTPS hubs work without any changes.
