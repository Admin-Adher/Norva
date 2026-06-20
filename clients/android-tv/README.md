# Android TV / Google TV autonomous app

This is the Android TV / Google TV app for Norva.

The recommended first-run flow is to pair the TV with a Norva Account. The TV
does not ask users to type an email and password with the remote as the primary
path: it shows a pairing code, the user signs in or creates the account on a
phone/computer, approves the code, then the TV opens Norva Watch.

After pairing, the TV is a trusted Norva screen. It can browse the cloud app and
receive cloud playback commands, while playback is handed to the native Android
player with the media metadata attached when the cloud command provides it.

Advanced local modes remain available from the TV menu:

- Local connector: connect to a PC/server running Norva.
- Standalone: add Xtream or M3U directly on the TV.

The app plays streams with Android Media3/ExoPlayer.

Included:

- Live TV, Movies, Series, and episode loading for Xtream
- M3U playlist import
- Local search
- Favorites via long press / long OK
- Native Android TV playback with audio/subtitle controls when the device
  exposes compatible tracks

The cloud mode opens the canonical Norva Web app at
`https://norva.tv/app.html`, so account, catalog pagination, Relay/Gateway
playback sessions and UI improvements are inherited automatically.

The standalone APK build copies the root `public/` web app into
`app/src/main/assets/www` during Gradle `preBuild`. Rebuild the APK after web UI
changes to embed the latest Movies, Series, Watch and Cloud assets.

Important limitation:

This Android TV build plays streams directly on the TV. It does not run the
full Node/ffmpeg backend and does not transcode incompatible streams locally.
Norva Gateway is the cloud path for difficult streams once deployed.

Build:

1. Install Android Studio, JDK 17+, and Android SDK platform 35+.
2. Open this `clients/android-tv` folder.
3. Let Gradle sync.
4. Build `app-debug.apk` or a signed release APK.
5. Install it on Android TV / Google TV with ADB or a USB sideload tool.

The remote Menu key opens the source setup screen again.
