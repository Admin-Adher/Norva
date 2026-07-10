# Offline downloads — codec support & the LGPL FFmpeg decoder plan

> How Norva's Android **offline download** feature handles VOD formats, why some
> downloads don't play, and the staged plan to reach "download = it always plays."
> _Created 2026-07-10._

## Audio & subtitle tracks in a download (verified via workflow, 2026-07-10)

A download is a **byte-exact copy of the ONE provider container file** — no demux,
no transcode, no track filtering (`DownloadService.downloadOne()` GETs `item.url`
and pipes it straight through AES/CTR into `{id}.enc`). Consequences:

- **ALL audio tracks and ALL subtitle tracks physically muxed into that file come
  along** (MKV/MP4/TS), byte-for-byte — nothing embedded is dropped.
- **Nothing that lived outside the file is included**: no sidecar `.srt`/`.vtt`, no
  provider subtitle API, and none of Norva's **web-only** subtitles (gateway
  FFmpeg extraction, Whisper transcripts, Argos translations, PGS OCR — all
  `norva-playback`/`WatchPage` features that never reach the device). Other
  language **"versions"** are separate provider `stream_id`s (separate files); only
  the version you clicked to download is fetched.
- **Offline track switching works** through the stock media3 controls: audio via
  the settings gear, subtitles via the CC button (`setShowSubtitleButton(true)`).
  The subtitle choice is **persisted per title** (SharedPreferences); audio choice
  is not (each play starts from media3's default until reselected).
- **No track metadata is stored** (`DownloadStore.Item` has no audio-language or
  subtitle-track fields) — the offline track list is whatever the extractor finds
  in the container at play time.
- The bundled **FFmpeg audio extension** matters exactly here: it makes embedded
  **AC-3 / E-AC-3 / DTS / TrueHD** audio tracks in a downloaded MKV decodable
  offline on devices whose hardware lacks those decoders (hardware first, FFmpeg
  fallback). A subtitle codec media3 can't decode (rare) would be present in the
  file but unselectable.

## How it works today (verified in code)

- **Download** (`clients/android-phone/app/.../DownloadService.java`): a single
  HTTP GET of the **raw** direct provider URL (never the cloud gateway, never
  transcoded), streamed byte-for-byte into one **AES/CTR-encrypted** local file.
  No manifest parsing → **HLS `.m3u8` cannot be downloaded** (only the playlist
  text would be saved). Movies + series episodes; **Live TV is not downloadable**.
- **Offline playback** (`PlayerActivity` `isLocal` branch): the same media3
  ExoPlayer, decrypting via `EncryptedFileDataSource`, decoded by **the device's
  own MediaCodec** decoders. **No offline transcode fallback** (downloads don't
  even carry the gateway `fallbackUrl`).
- **No format guard**: the "Download" button shows for every movie/episode, so a
  file whose codec the device can't decode downloads fully, then **fails only at
  playback** (`ERROR_CODE_DECODER_INIT_FAILED`), with no pre-warning.

**Consequence:** downloads play only for formats the phone decodes natively. The
dominant real-world failure is **audio** — AC-3 / E-AC-3 / DTS / TrueHD, which the
Android CDD never mandates and AOSP ships no decoder for — then **HEVC 10-bit**
video on budget SoCs.

## Corrections to earlier assumptions (adversarially verified, 2026-07)

1. **Dolby/DTS patent risk is largely OUTDATED.** AC-3 expired 2017, DTS core
   2016, E-AC-3's last essential US patent **2026-01-30**. Still protected: AC-4,
   DTS:X, Atmos/JOC (FFmpeg doesn't decode them) + the **trademarks** (never use
   "Dolby"/"DTS" in marketing).
2. **Software HEVC exists** (AOSP 8-bit; NextLib provides FFmpeg H.264/HEVC video
   for media3). The real residual video gap is **HEVC 10-bit** on 8-bit-only SoCs.
3. **Server transcode would NOT re-expose the datacenter IP** — the gateway
   already egresses ffmpeg via the residential proxy (`proxyEnvFor`). The real
   costs are the provider's single session slot, egress $, and UX.
4. **On-device transcode is possible** (FFmpeg SW), but loses on size/complexity/
   subtitles vs simply decoding at playback → rejected as the base fix.
5. **`codec_profile` is effectively empty** (3/586k movie variants; the crawl
   discards the audio codec) → a codec-based download guard must probe on demand
   until the crawl is fixed to persist `buildCodecProfile`.

## Chosen path: self-built **LGPL** FFmpeg **audio** decoder

The base fix = bundle the official media3 FFmpeg audio decoder so ExoPlayer decodes
AC-3/E-AC-3/DTS/TrueHD **in software** as a fallback after hardware. Built
**ourselves** (Apache-2.0 wrapper + LGPL FFmpeg, no `--enable-gpl`) rather than the
GPL-3.0 prebuilts (Jellyfin/NextLib), because the repo will **go private at
commercialization** — LGPL stays proprietary-compatible.

### Done in this change (safe, additive — no current build broken)

- `clients/android-ffmpeg-decoder/` — build script (`build-ffmpeg-decoder.sh`),
  `README.md`, `NOTICE-LGPL.md` (compliance checklist).
- `.github/workflows/android-ffmpeg-decoder.yml` — CI that produces the `.aar`
  artifact (run manually; not part of the release build).
- Phone app: `implementation fileTree("libs", "*.aar")` + `app/libs/` drop-zone;
  `PlayerActivity` sets `DefaultRenderersFactory(EXTENSION_RENDERER_MODE_ON)` —
  a **no-op until the `.aar` is present** (renderer loaded by reflection).
- Pinned to media3 **1.5.1** (current app version) → zero regression risk on the
  existing player; a media3 upgrade is decoupled and optional.

> ⚠️ The native FFmpeg build is **unverified in the agent sandbox** (no NDK). The
> first CI run of the decoder workflow is the real test, and the `.aar` must be
> **smoke-tested on a real device** with AC-3/E-AC-3/DTS/TrueHD samples before
> shipping. The fragile step is `:lib-decoder-ffmpeg:assembleRelease` from the
> media3 checkout — iterate there if the first run fails.

### Next stages (not done here)

1. **Ship the decoder**: run the workflow → commit the `.aar` to `app/libs/` →
   bump `versionCode` → release. Kills the #1 failure, offline, no server, ~no UI.
2. **Download capability guard**: at "Download", probe on demand (client
   `MediaCodecList` incl. `HEVCProfileMain10` + a light `ffprobe` via the existing
   `/probe-audio`) and warn/block condemned downloads. In parallel, **stop
   discarding the codec at crawl** (persist `buildCodecProfile`, ~2-3 d) so the
   guard becomes free.
3. **Emby-style UX for the residual**: per-title "Original (may not play here)" vs
   "Compatible version" (= opt-in gateway audio-remux via residential proxy, or the
   user's desktop hub) — **never silent** (Plex 2025 anti-pattern).
4. **Optional**: NextLib FFmpeg *video* (HEVC 10-bit) behind the guard — only after
   an HEVC-patent counsel review (video patents are still active) and if guard data
   shows Main10 failures matter.
5. **Optional**: media3 1.5.1 → 1.10.x (separate chore; rebuild the decoder from
   the matching tag).

### LGPL obligations before public release
See `clients/android-ffmpeg-decoder/NOTICE-LGPL.md`: in-app FFmpeg/LGPL attribution
+ license text, an offer of the FFmpeg source, dynamic `.so` relink provision, no
Dolby/DTS trademarks.
