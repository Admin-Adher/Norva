# app/libs — local AARs

Drop the self-built **`media3-decoder-ffmpeg-<version>-lgpl-audio.aar`** here (from
the "Build media3 FFmpeg audio decoder (LGPL)" GitHub Action) and commit it.

`app/build.gradle` bundles any `*.aar` in this folder via
`implementation fileTree(dir: "libs", include: ["*.aar"])`. When empty, the app
builds normally with no FFmpeg software audio decoder (current behaviour).

See `clients/android-ffmpeg-decoder/README.md` for the full flow and the LGPL
obligations in `NOTICE-LGPL.md`.
