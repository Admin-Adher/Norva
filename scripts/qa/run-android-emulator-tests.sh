#!/usr/bin/env bash
set -euo pipefail

platform="${1:?phone or tv required}"
case "$platform" in
  phone)
    navigation="${2:?gesture or three-button required}"
    adb shell settings put system font_scale 1.3
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
    cd clients/android-tv
    ;;
  *)
    echo "Unsupported platform: $platform" >&2
    exit 2
    ;;
esac

collect_captures() {
  mkdir -p app/build/outputs/androidTest-results/connected/captures
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
