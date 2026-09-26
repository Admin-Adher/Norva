#!/usr/bin/env bash
set -euo pipefail

platform="${1:?phone or tv required}"
case "$platform" in
  phone)
    navigation="${2:?gesture or three-button required}"
    font_scale="${3:-1.3}"
    case "$navigation" in
      gesture)
        overlay=com.android.internal.systemui.navbar.gestural
        ;;
      three-button)
        overlay=com.android.internal.systemui.navbar.threebutton
        ;;
      *)
        echo "Unsupported navigation mode: $navigation" >&2
        exit 2
        ;;
    esac
    adb shell cmd overlay enable --user 0 "$overlay"
    adb shell cmd overlay list | grep -F "[x] $overlay"
    # The first immersive player launch otherwise puts an Android tutorial over
    # the decoded frame and takes focus from WebView touch/IME verification.
    adb shell settings put secure immersive_mode_confirmations confirmed
    test "$(adb shell settings get secure immersive_mode_confirmations | tr -d '\r')" = confirmed
    cd clients/android-phone
    ;;
  tv)
    navigation=dpad
    font_scale="${2:-1.0}"
    cd clients/android-tv
    ;;
  *)
    echo "Unsupported platform: $platform" >&2
    exit 2
    ;;
esac

case "$font_scale" in
  1.0|1.3) ;;
  *)
    echo "Unsupported font scale: $font_scale (expected 1.0 or 1.3)" >&2
    exit 2
    ;;
esac
adb shell settings put system font_scale "$font_scale"
actual_font_scale="$(adb shell settings get system font_scale | tr -d '\r')"
if [[ "$actual_font_scale" != "$font_scale" ]]; then
  echo "Font scale mismatch: requested $font_scale, got $actual_font_scale" >&2
  exit 1
fi
echo "Android QA: platform=$platform navigation=$navigation font_scale=$actual_font_scale"

collect_captures() {
  mkdir -p app/build/outputs/androidTest-results/connected/captures
  printf 'platform=%s\nnavigation=%s\nrequested_font_scale=%s\nactual_font_scale=%s\n' \
    "$platform" "$navigation" "$font_scale" "$actual_font_scale" \
    > app/build/outputs/androidTest-results/connected/captures/qa-environment.txt
  adb pull "/sdcard/Android/data/tv.norva.${platform}/files/." app/build/outputs/androidTest-results/connected/captures/ >/dev/null 2>&1 || true
}
# UTP can remove the test application and its external files at teardown.
# Copy while instrumentation is running, before those files disappear.
(while true; do collect_captures; sleep 5; done) &
capture_pid=$!
finish_captures() {
  kill "$capture_pid" 2>/dev/null || true
  wait "$capture_pid" 2>/dev/null || true
  collect_captures
}
trap finish_captures EXIT
gradle :app:connectedDebugAndroidTest --no-daemon --stacktrace
