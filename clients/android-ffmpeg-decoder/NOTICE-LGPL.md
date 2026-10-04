# Bundled FFmpeg: source and distribution information

The Android phone and TV apps bundle FFmpeg through Media3's audio extension
and Norva's MPEG-4 Part 2 adapter. Media3 is Apache-2.0; the selected FFmpeg
configuration uses LGPL-2.1-or-later components without `--enable-gpl` or
`--enable-nonfree`. The decoder list and exact revisions are in `README.md` and
`build-ffmpeg-decoder.sh`.

The build statically links the selected FFmpeg libraries into **libffmpegJNI.so**,
which is dynamically loaded by the app. It does **not** ship separate replaceable
`libavcodec.so` libraries. The previous description of this layout was incorrect.
The complete adapter sources and build recipe must remain available with the
corresponding FFmpeg source revision; retaining only a moving branch name is
insufficient for reproduction.

Distribution must retain the applicable license texts and attribution and provide
the materials needed to rebuild/relink the combined library. If repository access
or distribution terms change, preserve a publicly accessible corresponding source
and relinking route. This technical inventory does not certify that all distribution
obligations have been fulfilled; it also makes no blanket patent-expiration claim.
