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

# Keep diagnostics outside Gradle's results directory while UTP owns it.
diagnostic_dir="$(mktemp -d)"
record_diagnostic() {
  local name="$1" result=0
  shift
  {
    printf 'utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    timeout --kill-after=2s 10s "$@" || result=$?
    printf 'exit_code=%s\n' "$result"
  } >> "$diagnostic_dir/$name.txt" 2>&1
}
collect_captures() {
  mkdir -p app/build/outputs/androidTest-results/connected/captures
  printf 'platform=%s\nnavigation=%s\nrequested_font_scale=%s\nactual_font_scale=%s\ntest_class_scope=%s\n' \
    "$platform" "$navigation" "$font_scale" "$actual_font_scale" "${NORVA_ANDROID_TEST_CLASS:-full}" \
    > app/build/outputs/androidTest-results/connected/captures/qa-environment.txt
  record_diagnostic adb-state adb get-state
  record_diagnostic adb-devices adb devices -l
  record_diagnostic app-pid adb shell pidof "tv.norva.${platform}"
  record_diagnostic emulator-process pgrep -af 'qemu-system|emulator.*-avd'
  record_diagnostic host-memory free -m
  record_diagnostic host-process-memory ps -eo pid,comm,rss,vsz --sort=-rss
  record_diagnostic capture-pull adb pull "/sdcard/Android/data/tv.norva.${platform}/files/." app/build/outputs/androidTest-results/connected/captures/
}
# UTP can remove the test application and its external files at teardown.
# Copy while instrumentation is running, before those files disappear.
(while true; do collect_captures; sleep 5; done) &
capture_pid=$!
# Per-test logcat can stop before the crash that terminates instrumentation.
adb logcat -b all -v threadtime > "$diagnostic_dir/device-logcat.txt" 2>&1 &
logcat_pid=$!
finish_captures() {
  local test_status=$?
  kill "$capture_pid" 2>/dev/null || true
  wait "$capture_pid" 2>/dev/null || true
  collect_captures
  record_diagnostic process-exit-info adb shell dumpsys activity exit-info "tv.norva.${platform}"
  record_diagnostic host-kernel sudo dmesg --ctime
  local logcat_stopped_by_harness=0 logcat_status=0
  if kill -0 "$logcat_pid" 2>/dev/null; then
    logcat_stopped_by_harness=1
    kill "$logcat_pid" 2>/dev/null || true
    for ((attempt=0; attempt<10; attempt++)); do
      kill -0 "$logcat_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$logcat_pid" 2>/dev/null; then
      kill -KILL "$logcat_pid" 2>/dev/null || true
    fi
  fi
  wait "$logcat_pid" 2>/dev/null || logcat_status=$?
  printf 'utc=%s exit_code=%s stopped_by_harness=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$logcat_status" "$logcat_stopped_by_harness" \
    > "$diagnostic_dir/logcat-exit.txt"
  mkdir -p app/build/outputs/androidTest-results/connected/diagnostics
  cp "$diagnostic_dir/"* app/build/outputs/androidTest-results/connected/diagnostics/ || true
  return "$test_status"
}
trap finish_captures EXIT

wait_for_phone_home() {
  local home_component home_package home_activity home_full home_short window_state anr_events
  local setup_complete device_provisioned previous_home=''
  local deadline=$((SECONDS + 45))
  local stable_focus=0 home_started=0
  while (( SECONDS < deadline )); do
    # Font/navigation configuration can briefly disconnect the emulator after
    # sys.boot_completed. Retry readiness observations within the SAME deadline;
    # never reboot, clear an ANR, or retry an actual instrumentation failure.
    if (( home_started == 0 )); then
      if ! timeout 5s adb shell am start -W -a android.intent.action.MAIN \
        -c android.intent.category.HOME >> "$diagnostic_dir/readiness-launch.txt" 2>&1; then
        sleep 2
        continue
      fi
      home_started=1
    fi
    # API 35 prints mCurrentFocus under DisplayContent, outside the "windows"
    # subsection. Include that section so a healthy HOME is not rejected.
    if ! anr_events="$(timeout 5s adb logcat -b events -d -s am_anr:I '*:S')" \
      || ! window_state="$(timeout 5s adb shell dumpsys window | tr -d '\r')"; then
      stable_focus=0
      home_started=0
      sleep 2
      continue
    fi
    if grep -q 'am_anr' <<< "$anr_events" \
      || grep -q 'Application Not Responding' <<< "$window_state"; then
      printf '%s\n' "$anr_events" > "$diagnostic_dir/readiness-anr.txt"
      printf '%s\n' "$window_state" > "$diagnostic_dir/readiness-windows.txt"
      timeout 5s adb exec-out screencap -p > "$diagnostic_dir/readiness-screen.png" || true
      echo "Android QA readiness failed: emulator ANR before instrumentation; dialogue left intact" >&2
      return 1
    fi
    # The first boot replaces its temporary setup HOME with the launcher.
    # Resolve again after every observation instead of retaining the setup target.
    if ! setup_complete="$(timeout 5s adb shell settings get secure user_setup_complete | tr -d '\r')" \
      || ! device_provisioned="$(timeout 5s adb shell settings get global device_provisioned | tr -d '\r')" \
      || ! home_component="$(timeout 5s adb shell cmd package resolve-activity --brief --user 0 \
        -a android.intent.action.MAIN -c android.intent.category.HOME | tr -d '\r' | tail -n 1)"; then
      stable_focus=0
      home_started=0
      sleep 2
      continue
    fi
    home_full=''
    home_short=''
    if [[ "$home_component" =~ ^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$ ]]; then
      home_package="${home_component%%/*}"
      home_activity="${home_component#*/}"
      if [[ "$home_activity" == .* ]]; then
        home_activity="${home_package}${home_activity}"
      fi
      home_full="${home_package}/${home_activity}"
      home_short="${home_package}/${home_activity#"$home_package"}"
    fi
    printf 'setup_complete=%s device_provisioned=%s resolved_home=%s\n' \
      "$setup_complete" "$device_provisioned" "$home_component" >> "$diagnostic_dir/readiness-state.txt"
    if [[ "$setup_complete" == 1 && "$device_provisioned" == 1 && -n "$home_full" ]] \
      && grep 'mCurrentFocus=' <<< "$window_state" | grep -Fq -e "$home_full}" -e "$home_short}"; then
      if [[ "$home_full" == "$previous_home" ]]; then
        stable_focus=$((stable_focus + 1))
      else
        previous_home="$home_full"
        stable_focus=1
      fi
      if (( stable_focus >= 3 )); then
        echo "Android QA readiness: HOME has stable window focus"
        return 0
      fi
    else
      stable_focus=0
      previous_home=''
    fi
    sleep 2
  done
  printf '%s\n' "${window_state:-transport unavailable}" > "$diagnostic_dir/readiness-windows.txt"
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
