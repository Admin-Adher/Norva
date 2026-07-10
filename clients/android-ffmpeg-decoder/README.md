# media3 FFmpeg audio decoder — self-built, LGPL-clean

Norva's Android **offline downloads** are byte-for-byte copies of the provider's
VOD file, played back with media3/ExoPlayer using **the device's own decoders**.
Phones whose hardware lacks **Dolby (AC-3 / E-AC-3)**, **DTS**, or **TrueHD** audio
decoders therefore fail to play some downloads — the #1 real-world "downloaded but
won't play" cause (see `docs/OFFLINE-DOWNLOAD-CODECS.md`).

This module builds the **official** `androidx.media3` FFmpeg audio decoder
extension ourselves, so ExoPlayer can decode those audio codecs **in software** as
a fallback after the device's hardware.

## Why self-build instead of the prebuilt AARs

The convenient prebuilt artifacts — Jellyfin `org.jellyfin.media3:media3-ffmpeg-decoder`
and NextLib `io.github.anilbeesetti:nextlib-media3ext` — are packaged **GPL-3.0**.
Norva's repo is GPL-3.0 **today**, but the plan is to **go private/proprietary at
commercialization**. To stay compatible with that, we build the official media3
module ourselves:

- media3 wrapper code → **Apache-2.0**
- FFmpeg → **LGPL-2.1+** (we do **not** pass `--enable-gpl`, and enable only
  LGPL-clean decoders)

That combination is fine to ship in a closed-source app **as long as the LGPL
relink/attribution obligations are met** (see `NOTICE-LGPL.md`).

## What's enabled

Audio decoders only (identical to Jellyfin's set; none needs `--enable-gpl`):

```
flac alac pcm_mulaw pcm_alaw mp3 aac ac3 eac3 dca mlp truehd
```

`ac3`/`eac3` = Dolby Digital / Digital Plus · `dca` = DTS + DTS-HD **core** ·
`mlp`/`truehd` = Dolby TrueHD. No video decoders (HEVC etc. stay on device
hardware; the download UI guard handles the rare device that can't — see the docs).

> Patents: AC-3 (expired 2017), DTS core (expired 2016) and E-AC-3 (last essential
> US patent expired 2026-01-30) are clear as of mid-2026. Still off-limits: AC-4,
> DTS:X, Dolby Atmos/JOC (FFmpeg doesn't decode these anyway) and the **"Dolby" /
> "DTS" trademarks** — never use them in marketing/store copy. A counsel review
> before release is prudent as validation, not a blocker.

## How to produce and use the AAR

1. **Build it** (CI only — the native build can't run in the Norva agent sandbox):
   GitHub → Actions → **"Build media3 FFmpeg audio decoder (LGPL)"** → Run workflow.
   Download the `media3-decoder-ffmpeg-lgpl-aar` artifact.
   (Or locally: `ANDROID_NDK_HOME=<r26b> ./build-ffmpeg-decoder.sh`.)
2. **Drop it in** `clients/android-phone/app/libs/` (and `clients/android-tv/app/libs/`
   if you also want TV *streaming* to decode Dolby/DTS in software) and commit it.
3. **Rebuild** the app (Android Release workflow, bump `versionCode`). The app's
   `implementation fileTree("libs", …)` bundles it, and PlayerActivity's
   `DefaultRenderersFactory(...).setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON)`
   makes ExoPlayer use `FfmpegAudioRenderer` as a fallback after MediaCodec.
4. **Smoke-test on a real device** with real AC-3 / E-AC-3 / DTS / TrueHD samples
   before shipping — the native build is unverified until a real APK plays them.

The app builds and runs fine **without** the AAR (the renderer factory silently
skips the missing extension); nothing here is a hard build dependency.

## Version pinning

`MEDIA3_TAG` in `build-ffmpeg-decoder.sh` **must match** the `androidx.media3:*`
version in both apps' `app/build.gradle` (currently `1.5.1`). Bump them together.
