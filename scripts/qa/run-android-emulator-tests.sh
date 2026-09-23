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
  adb pull "/sdcard/Android/data/tv.norva.${platform}/files/." app/build/outputs/androidTest-results/connected/captures/ || true
}
trap collect_captures EXIT
gradle :app:connectedDebugAndroidTest --no-daemon --stacktrace
