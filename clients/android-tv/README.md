# Android TV / Google TV autonomous app

This is a standalone Android TV IPTV app for Norva.

It does not require the Windows/Norva desktop server for normal playback.
On first launch, add either:

- Xtream Codes server URL, username, and password
- M3U playlist URL

The app stores the synced catalog locally on the TV with SQLite and plays
streams directly with Android Media3/ExoPlayer.

Included:

- Live TV, Movies, Series, and episode loading for Xtream
- M3U playlist import
- Local search
- Favorites via long press / long OK
- Native Android TV playback with audio/subtitle controls when the device
  exposes compatible tracks

Important limitation:

This Android TV build plays streams directly on the TV. It does not run the
full Node/ffmpeg backend and does not transcode incompatible streams. For rare
formats/codecs that a TV cannot decode, use another stream version or the
Windows desktop server build.

Build:

1. Install Android Studio, JDK 17+, and Android SDK platform 35+.
2. Open this `clients/android-tv` folder.
3. Let Gradle sync.
4. Build `app-debug.apk` or a signed release APK.
5. Install it on Android TV / Google TV with ADB or a USB sideload tool.

The remote Menu key opens the source setup screen again.
