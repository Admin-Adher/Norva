#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the androidx.media3 FFmpeg AUDIO decoder extension as a self-built .aar,
# with an LGPL-clean FFmpeg (audio decoders only, NO --enable-gpl). This lets the
# Norva phone app play OFFLINE downloads whose audio track is AC-3 / E-AC-3 / DTS /
# TrueHD on devices whose hardware MediaCodec lacks those decoders (the #1 cause
# of "downloaded but won't play" today).
#
# WHY self-build (not the prebuilt Jellyfin/NextLib AARs): those artifacts are
# packaged GPL-3.0. The founder intends to close the source at commercialization,
# so we build the OFFICIAL media3 module ourselves = Apache-2.0 wrapper + FFmpeg
# under LGPL-2.1+ (we do NOT pass --enable-gpl and enable only LGPL-clean
# decoders), which stays compatible with a future proprietary distribution.
# See NOTICE-LGPL.md in this folder for the compliance checklist.
#
# Pinned to the SAME media3 version the apps ship (1.5.1) so the renderer's ABI
# matches app/build.gradle. Bump MEDIA3_TAG here AND in the apps together.
#
# Meant to run in CI (see .github/workflows/android-ffmpeg-decoder.yml). It CANNOT
# be validated in the Norva agent sandbox (no NDK / long native build) — the first
# CI run is the real test.
#
# Requires: git, JDK 17, Android SDK, Android NDK r26b (26.1.10909125), nasm, make.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MEDIA3_TAG="${MEDIA3_TAG:-1.5.1}"
FFMPEG_REF="${FFMPEG_REF:-release/6.0}"   # media3 1.5.x recommends FFmpeg 6.0
API_LEVEL="${API_LEVEL:-23}"              # matches the apps' minSdk 23
HOST_PLATFORM="${HOST_PLATFORM:-linux-x86_64}"   # darwin-x86_64 on macOS

# LGPL-clean audio decoders (identical to Jellyfin's set; none needs --enable-gpl).
# Covers the offline gaps: Dolby AC-3 / E-AC-3, DTS + DTS-HD core (dca), Dolby
# TrueHD (mlp/truehd), plus common lossless/lossy audio so nothing regresses.
ENABLED_DECODERS=(flac alac pcm_mulaw pcm_alaw mp3 aac ac3 eac3 dca mlp truehd)

NDK_PATH="${1:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
if [ -z "$NDK_PATH" ] || [ ! -d "$NDK_PATH" ]; then
  echo "::error:: Android NDK not found. Pass its path as arg 1 or set ANDROID_NDK_HOME (need r26b / 26.1.10909125)."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="${ROOT}/.build"
OUT_DIR="${ROOT}/out"
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT_DIR"
cd "$WORK"

echo ">> [1/4] Cloning androidx/media @ ${MEDIA3_TAG}"
git clone --depth 1 --branch "${MEDIA3_TAG}" https://github.com/androidx/media.git media

FFMPEG_MODULE_PATH="${WORK}/media/libraries/decoder_ffmpeg/src/main"

echo ">> [2/4] Cloning FFmpeg @ ${FFMPEG_REF} (LGPL build — audio only)"
git clone --depth 1 --branch "${FFMPEG_REF}" https://git.ffmpeg.org/ffmpeg.git ffmpeg
ln -sf "${WORK}/ffmpeg" "${FFMPEG_MODULE_PATH}/jni/ffmpeg"

echo ">> [3/4] Building FFmpeg for all ABIs — decoders: ${ENABLED_DECODERS[*]}"
# build_ffmpeg.sh iterates the 4 supported ABIs internally; the API level is arg 4.
# It configures FFmpeg WITHOUT --enable-gpl (LGPL default) and enables only the
# decoders passed here.
"${FFMPEG_MODULE_PATH}/jni/build_ffmpeg.sh" \
  "${FFMPEG_MODULE_PATH}" "${NDK_PATH}" "${HOST_PLATFORM}" "${API_LEVEL}" \
  "${ENABLED_DECODERS[@]}"

echo ">> [4/4] Assembling the decoder_ffmpeg .aar (:lib-decoder-ffmpeg:assembleRelease)"
cd "${WORK}/media"
./gradlew :lib-decoder-ffmpeg:assembleRelease --no-daemon

AAR="$(find libraries/decoder_ffmpeg -path '*/outputs/aar/*.aar' | head -1 || true)"
if [ -z "$AAR" ]; then
  echo "::error:: AAR not produced — check the :lib-decoder-ffmpeg:assembleRelease output above."
  exit 1
fi
DEST="${OUT_DIR}/media3-decoder-ffmpeg-${MEDIA3_TAG}-lgpl-audio.aar"
cp "$AAR" "$DEST"
echo ">> Done: ${DEST}"
echo ">> Next: commit it to clients/android-phone/app/libs/ (and android-tv if desired), then run the normal Android Release workflow."
