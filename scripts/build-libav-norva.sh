#!/usr/bin/env bash
#
# Build the custom "norva" libav.js WASM variant — the in-browser demux/remux engine.
#
# This reproduces the lean component set the engine needs (audio decoders + AAC encode +
# mkv/mp4 demux + fMP4 mux, NO video decoders since video is stream-copied) and ADDS the
# MPEG-TS demuxer + the parsers it needs, so .ts VOD can be remuxed in the browser (fast)
# instead of falling back to the gateway transcode (slow).
#
# Requires Emscripten (emcc/emconfigure on PATH) — runs in CI (.github/workflows/build-libav-wasm.yml)
# because this sandbox's egress proxy truncates the ~1 GB Emscripten toolchain download.
#
# Output: public/webengine/vendor/libav/libav-<VER>-norva.{wasm.wasm,wasm.mjs,mjs} (drop-in;
# same filenames the engine already loads), with the BlockAdditions log filter re-applied.
set -euo pipefail

VER="${LIBAVJS_VERSION:-6.8.8.0}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/public/webengine/vendor/libav"
WORK="$(mktemp -d)"

# The norva component set (enumerated from the shipped WASM) + MPEG-TS. Fragments follow libav.js's
# predictable naming (format-*/demuxer-*/decoder-*/encoder-*/codec-*/parser-*). codec-* = decoder
# AND encoder; format-* = demuxer AND muxer. Video is COPIED (no video decoder), but TS carries no
# extradata, so the H.264/HEVC parsers are required for the mp4 muxer to build avcC/hvcC.
FRAGMENTS='[
  "avformat","avcodec","avfilter","swresample","audio-filters","avfcbridge",
  "format-webm","format-mp4","demuxer-ogg","format-flac","parser-flac","codec-flac","format-wav",
  "demuxer-mpegts",
  "codec-aac","parser-aac",
  "decoder-ac3","decoder-eac3",
  "decoder-mp2","decoder-mp3","parser-mpegaudio",
  "decoder-vorbis","decoder-alac","decoder-truehd","decoder-mlp",
  "decoder-pcm_s16be",
  "codec-libopus",
  "parser-h264","parser-hevc","parser-mpeg4video","parser-mpegvideo"
]'

echo "### fetching libav.js $VER source"
curl -sSL --retry 4 -o "$WORK/libavjs.tgz" "https://codeload.github.com/Yahweasel/libav.js/tar.gz/refs/tags/v$VER"
tar xzf "$WORK/libavjs.tgz" -C "$WORK"
cd "$WORK/libav.js-$VER"

echo "### generating 'norva' config"
( cd configs && node mkconfig.js norva "$(echo "$FRAGMENTS" | tr -d '\n ')" )
echo "ffmpeg-config.txt:"; cat configs/configs/norva/ffmpeg-config.txt

echo "### building variant (downloads ffmpeg/opus/zlib, compiles to WASM)"
make -j"$(nproc)" build-norva

echo "### copying artifacts into the repo"
for f in "libav-$VER-norva.wasm.wasm" "libav-$VER-norva.wasm.mjs" "libav-$VER-norva.mjs"; do
  cp -v "dist/$f" "$DEST/$f"
done

echo "### re-applying the BlockAdditions log filter"
cd "$REPO_ROOT"
node scripts/patch-libav-logs.js

echo "### verifying mpegts demuxer is registered in the new build"
cat > "$WORK/verify.mjs" <<JS
const DIR='$DEST';
const mod=await import(DIR+'/libav-norva.mjs');
const LibAV=mod.LibAV||mod.default?.LibAV||mod.default;
const lib=await LibAV({base:DIR, nolibavworker:true});
const need=['mpegts','matroska,webm','mov,mp4,m4a,3gp,3g2,mj2'];
let ok=true;
for(const n of need){const p=await lib.av_find_input_format(n);console.log(n,'=',p, p?'OK':'MISSING'); if(!p) ok=false;}
process.exit(ok?0:1);
JS
node "$WORK/verify.mjs"
echo "### DONE — libav norva variant with mpegts built + verified"
