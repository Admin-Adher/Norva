# Media3 FFmpeg audio and MPEG-4 Part 2 decoding

Norva bundles the Media3 FFmpeg audio extension and a small MPEG-4 Part 2 video
adapter for Android phone and TV. Both decode locally. Downloaded files remain
byte-for-byte copies of the provider media; this module does not transcode or
open network connections.

`NativeRenderersFactory` keeps the platform audio decoder first, with FFmpeg as
fallback. For `video/mp4v-es`, Norva's `Mpeg4VideoRenderer` precedes MediaCodec:
the POCO tested with XVID Advanced Simple produced corrupted pictures despite
reporting successful decoding. Other video MIME types keep the normal platform
renderer. The official Media3 1.5.1 experimental FFmpeg video renderer is not used.

## Reproducible inputs

- Media3 1.5.1, commit `76088cd6af7f263aba238b7a48d64bd4f060cb8b`.
- FFmpeg `b4a62c32549b8295691a8e0ff2c9b82188923159`.
- Android NDK r26b, API 23; armeabi-v7a, arm64-v8a, x86, x86_64.
- Audio decoders: `flac alac pcm_mulaw pcm_alaw mp3 aac ac3 eac3 dca mlp truehd`.
- Video decoder: `mpeg4` only. No GPL/nonfree build option is enabled.
- Norva adapter: `norva_mpeg4_video_jni.cc`; Java renderer/decoder under
  `clients/android-common/src/main/java/tv/norva/playback/`.

The adapter accepts Media3 packets, preserves reordered timestamps and delayed
B-frames, and renders YUV420P output. It does not include a demuxer or network
client. Input sizes, dimensions and output buffers are bounded.

## Build and verify

Run `.github/workflows/android-ffmpeg-decoder.yml`, or
`ANDROID_NDK_HOME=<r26b> ./build-ffmpeg-decoder.sh` with the documented toolchain.
The artifact includes the AAR and a manifest of source revisions and SHA-256
digests. Commit the same AAR in both Android apps' `app/libs/` directories.
Media3 versions in both apps must match the decoder extension.

`Mpeg4VideoDecoderInstrumentedTest` compares every plane of every generated
Advanced Simple/QPEL/B-frame picture against an FFmpeg reference, including EOS
and seek flushing. `NativeVfwMpeg4InstrumentedTest` exercises the real player,
audio/video progress, seek and Back. Optional private real-file tests require
the clip and reference on the device; these files are not distributed in CI.

See `NOTICE-LGPL.md` for distribution facts and attribution/relink requirements.
A successful decoder build is not a legal compliance certification.
