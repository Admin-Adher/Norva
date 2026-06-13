# Norva TV Clients

These clients are TV launchers for Norva TV.

Important: the TV app is a client only. The Norva server must run on a PC,
NAS, mini-PC, or Docker host on the same network. The TV app then opens:

```text
http://YOUR_SERVER_IP:3000
```

If you use the Windows desktop EXE, the server port can be dynamic. For a TV,
the most reliable setup is to run the server with a fixed port:

```powershell
$env:PORT='3000'
npm start
```

Then open the app from the TV with:

```text
http://192.168.x.x:3000
```

## Android TV / Google TV

Folder: `clients/android-tv`

Build requirements:

- Android Studio
- JDK 17+
- Android SDK with platform 35+

Open `clients/android-tv` in Android Studio, then build `app-debug.apk` or a
signed release APK.

The app provides a TV-friendly setup screen where you enter the Norva server
URL. It then opens Norva in a WebView with JavaScript, local storage, media
playback, and HTTP LAN access enabled.

## Samsung Smart TV

Folder: `clients/samsung-tizen`

Build requirements:

- Tizen Studio with TV Extension
- Samsung/Tizen certificate profile
- A Samsung TV in developer mode for sideloading

Package the folder as a Tizen web app (`.wgt`) from Tizen Studio, then install
it on the TV. The app has a setup screen, stores the Norva server URL, and
loads the server inside a fullscreen TV wrapper.

## Current limitation

The TV clients do not embed ffmpeg, SQLite, or the IPTV sync backend. This is
intentional: Android TV and Samsung TV are not good places to run the full
Norva backend. Keep the backend on a machine with stable network, storage,
and transcoding support.
