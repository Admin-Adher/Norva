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
# Keep diagnostics outside Gradle's results directory while UTP owns it.
# Per-test logcat can stop before the crash that terminates instrumentation.
diagnostic_dir="$(mktemp -d)"
adb logcat -b all -v threadtime > "$diagnostic_dir/device-logcat.txt" 2>&1 &
logcat_pid=$!
finish_captures() {
  local test_status=$?
  kill "$capture_pid" 2>/dev/null || true
  wait "$capture_pid" 2>/dev/null || true
  collect_captures
  adb shell dumpsys activity exit-info "tv.norva.${platform}" > "$diagnostic_dir/process-exit-info.txt" 2>&1 || true
  kill "$logcat_pid" 2>/dev/null || true
  wait "$logcat_pid" 2>/dev/null || true
  mkdir -p app/build/outputs/androidTest-results/connected/diagnostics
  cp "$diagnostic_dir/"* app/build/outputs/androidTest-results/connected/diagnostics/ || true
  return "$test_status"
}
trap finish_captures EXIT

wait_for_phone_home() {
  local home_component home_package home_activity home_full home_short window_state anr_events
  local deadline=$((SECONDS + 45))
  local stable_focus=0
  home_component="$(timeout 10s adb shell cmd package resolve-activity --brief --user 0 \
    -a android.intent.action.MAIN -c android.intent.category.HOME | tr -d '\r' | tail -n 1)"
  if [[ ! "$home_component" =~ ^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$ ]]; then
    echo "Android QA readiness: cannot resolve the HOME activity" >&2
    return 1
  fi
  home_package="${home_component%%/*}"
  home_activity="${home_component#*/}"
  if [[ "$home_activity" == .* ]]; then
    home_activity="${home_package}${home_activity}"
  fi
  home_full="${home_package}/${home_activity}"
  home_short="${home_package}/${home_activity#"$home_package"}"
  timeout 15s adb shell am start -W -a android.intent.action.MAIN \
    -c android.intent.category.HOME >/dev/null
  while (( SECONDS < deadline )); do
    anr_events="$(timeout 5s adb logcat -b events -d -s am_anr:I '*:S')"
    window_state="$(timeout 5s adb shell dumpsys window windows | tr -d '\r')"
    if grep -q 'am_anr' <<< "$anr_events" \
      || grep -q 'Application Not Responding' <<< "$window_state"; then
      printf '%s\n' "$anr_events" > "$diagnostic_dir/readiness-anr.txt"
      printf '%s\n' "$window_state" > "$diagnostic_dir/readiness-windows.txt"
      timeout 5s adb exec-out screencap -p > "$diagnostic_dir/readiness-screen.png" || true
      echo "Android QA readiness failed: emulator ANR before instrumentation; dialogue left intact" >&2
      return 1
    fi
    if grep 'mCurrentFocus=' <<< "$window_state" | grep -Fq -e "$home_full" -e "$home_short"; then
      stable_focus=$((stable_focus + 1))
      if (( stable_focus >= 3 )); then
        echo "Android QA readiness: HOME has stable window focus"
        return 0
      fi
    else
      stable_focus=0
    fi
    sleep 2
  done
  printf '%s\n' "$window_state" > "$diagnostic_dir/readiness-windows.txt"
  timeout 5s adb exec-out screencap -p > "$diagnostic_dir/readiness-screen.png" || true
  echo "Android QA readiness failed: HOME did not acquire stable window focus before the readiness deadline" >&2
  return 1
}
if [[ "$platform" == phone ]]; then
  wait_for_phone_home
fi

test_args=()
if [[ -n "${NORVA_ANDROID_TEST_CLASS:-}" ]]; then
  [[ "$NORVA_ANDROID_TEST_CLASS" =~ ^[A-Za-z0-9_.,#]+$ ]] || exit 2
  test_args+=("-Pandroid.testInstrumentationRunnerArguments.class=$NORVA_ANDROID_TEST_CLASS")
fi
gradle :app:connectedDebugAndroidTest --no-daemon --stacktrace "${test_args[@]}"
