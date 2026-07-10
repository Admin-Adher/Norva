# LGPL compliance — bundled FFmpeg (audio decoder)

Norva's Android app bundles a self-built copy of **FFmpeg** (audio decoders only)
via the media3 `decoder_ffmpeg` extension. FFmpeg is used here under the **GNU
Lesser General Public License, version 2.1 or later (LGPL-2.1+)**. To stay
LGPL-clean (and therefore usable in a future proprietary/closed-source build), the
build in `build-ffmpeg-decoder.sh`:

- does **NOT** pass `--enable-gpl` (no GPL-only FFmpeg components), and
- enables only LGPL-clean **audio** decoders: `flac alac pcm_mulaw pcm_alaw mp3
  aac ac3 eac3 dca mlp truehd`.

## Obligations to satisfy before shipping publicly (LGPL-2.1 §6)

1. **Attribution / license text in-app.** Add an "Open-source licenses" (or
   "Legal") entry that states the app uses **FFmpeg** under the **LGPL-2.1+** and
   includes the full LGPL-2.1 text. (TODO: wire this into the app's Settings →
   About/Legal; today the web app links Privacy/Terms only.)
2. **Offer the FFmpeg source.** Make available the exact FFmpeg source used
   (version `release/6.0` + the `configure` flags from `build_ffmpeg.sh` — no
   `--enable-gpl`, the decoder set above). A public link to the pinned FFmpeg ref
   plus this build script satisfies this. Keep it reachable even after the Norva
   repo goes private (e.g. host `build-ffmpeg-decoder.sh` + the FFmpeg ref on a
   public page, or point to git.ffmpeg.org's `release/6.0`).
3. **Allow relinking.** FFmpeg ships as dynamic shared objects (`libavcodec.so`
   etc.) inside the AAR/APK, so a user can replace them with a modified FFmpeg —
   this is the standard way to meet the LGPL relink requirement for `.so`
   libraries. Do **not** statically link FFmpeg into another `.so` in a way that
   prevents relinking.
4. **No trademarks.** "Dolby", "Dolby Digital", "DTS", "DTS-HD" are **trademarks**.
   Decoding is a patent/copyright matter (see below); using the marks in the store
   listing or UI is a separate trademark matter — **don't**. Describe support
   generically ("supports common surround audio tracks").

## Patents (informational, not legal advice)

Core-codec patents for the enabled decoders are expired as of mid-2026: **AC-3**
(2017), **DTS core** (2016), **E-AC-3** (last essential US patent expired
2026-01-30). Still-patented extensions (**AC-4, DTS:X, Dolby Atmos/JOC**) are not
enabled and FFmpeg does not decode them here. A brief counsel review before public
release is recommended as validation.
