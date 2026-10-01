'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.env.NORVA_QA_BASH || (process.platform === 'win32' ? 'bash.exe' : 'bash');
const bashProbe = spawnSync(bash, ['-c', 'printf ready'], { encoding: 'utf8' });
const shellOptions = { skip: process.platform === 'win32' && bashProbe.status !== 0
    ? 'Bash unavailable on this Windows host; the Linux emulator CI runs this shell contract' : false };
const source = fs.readFileSync(path.join(__dirname, '../scripts/qa/run-android-emulator-tests.sh'), 'utf8');
const functionStart = source.indexOf('wait_for_phone_home() {');
const functionEnd = source.indexOf('if [[ "$platform" == phone ]]', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'Use the actual QA readiness function');
const actualFunction = source.slice(functionStart, functionEnd);
const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;

function replay(mode, fixture = 'gesture10', expectedStatus = 0, expectedCycles = 3) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-home-ready-'));
    try {
        const counter = path.join(root, 'cycles');
        fs.writeFileSync(counter, '0');
        fs.writeFileSync(path.join(root, 'launches'), '0');
        const script = `set -euo pipefail
diagnostic_dir=${quote(root)}
fixture=${quote(path.join(__dirname, 'fixtures/android-home-readiness', fixture + '.txt'))}
counter=${quote(counter)}
mode=${quote(mode)}
timeout() { shift; "$@"; }
# Advance a controlled monotonic clock; never wait on a real device or sleep.
sleep() { SECONDS=$((SECONDS + 8)); }
adb() {
  printf '%s\\n' "$*" >> "$diagnostic_dir/commands.txt"
  local cycle
  cycle=$(<"$counter")
  case "$*" in
    *'am start'*)
      local launches
      launches=$(<"$diagnostic_dir/launches"); launches=$((launches+1)); printf '%s' "$launches" > "$diagnostic_dir/launches"
      if [[ "$mode" == offline-always || ( "$mode" == offline-once && "$launches" -eq 1 ) ]]; then echo 'adb: device offline' >&2; return 255; fi ;;
    *logcat*)
      cycle=$((cycle + 1)); printf '%s' "$cycle" > "$counter"
      if [[ "$mode" == offline-observation && "$cycle" -eq 1 ]]; then echo 'adb: device offline' >&2; return 255; fi
      if [[ "$mode" == anr-events ]]; then echo '09-30 13:24:51.788 I am_anr: launcher'; fi ;;
    *'dumpsys window')
      if [[ "$mode" == other-app ]]; then
        sed 's#mCurrentFocus=.*#mCurrentFocus=Window{123 u0 com.android.settings/.Settings}#' "$fixture"
      elif [[ "$mode" == unfocused ]]; then
        sed 's#mCurrentFocus=.*#mCurrentFocus=null#' "$fixture"
      elif [[ "$mode" == anr-window ]]; then
        sed 's#mCurrentFocus=.*#mCurrentFocus=Window{123 u0 Application Not Responding: launcher}#' "$fixture"
      elif [[ "$mode" == switch-target && "$cycle" -ge 3 ]]; then
        sed 's#com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity#com.android.launcher3/com.android.launcher3.Launcher#' "$fixture"
      else cat "$fixture"; fi ;;
    *'settings get secure user_setup_complete')
      if [[ "$mode" == setup || ( "$mode" == transition && "$cycle" -eq 1 ) ]]; then echo 0; else echo 1; fi ;;
    *'settings get global device_provisioned')
      if [[ "$mode" == provision ]]; then echo 0; else echo 1; fi ;;
    *resolve-activity*)
      if [[ "$mode" == unresolved ]]; then echo 'No activity found';
      elif [[ "$mode" == transition && "$cycle" -eq 1 ]]; then echo 'com.google.android.googlesdksetup/.DefaultActivity';
      elif [[ "$mode" == switch-target && "$cycle" -ge 3 ]]; then echo 'com.android.launcher3/.Launcher';
      elif [[ "$mode" == long-resolver ]]; then echo 'com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity';
      else echo 'com.google.android.apps.nexuslauncher/.NexusLauncherActivity'; fi ;;
    *'exec-out screencap'*) : ;;
    *) echo "Unexpected adb operation: $*" >&2; return 3 ;;
  esac
}
${actualFunction}
wait_for_phone_home
`;
        const scriptPath = path.join(root, 'replay.sh');
        fs.writeFileSync(scriptPath, script);
        const result = spawnSync(bash, [scriptPath], { encoding: 'utf8', timeout: 20000 });
        const output = result.stdout + result.stderr;
        assert.equal(result.status, expectedStatus, output || result.error?.message);
        const cycles = Number(fs.readFileSync(counter, 'utf8'));
        if (expectedCycles != null) assert.equal(cycles, expectedCycles, output);
        const commands = fs.readFileSync(path.join(root, 'commands.txt'), 'utf8');
        assert.doesNotMatch(commands, /settings put|input keyevent|logcat.* -c|force-stop/);
        if (expectedStatus === 0) assert.match(output, /HOME has stable window focus/);
        else if (mode.startsWith('anr')) assert.match(output, /emulator ANR before instrumentation/);
        else assert.match(output, /before the readiness deadline/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

for (const fixture of ['gesture10', 'gesture13', 'three10', 'three13']) {
    test(`actual ${fixture} dump accepts the focused HOME after setup`, shellOptions, () => replay('ready', fixture));
    test(`actual ${fixture} dump survives setup HOME replacement`, shellOptions, () => replay('transition', fixture, 0, 4));
}
test('full resolver component matches the captured full window component', shellOptions, () => replay('long-resolver'));
test('changing the focused HOME resets the three-observation counter', shellOptions, () => replay('switch-target', 'gesture10', 0, 5));
test('a transient ADB disconnect before HOME does not skip the three readiness observations', shellOptions, () => replay('offline-once'));
test('a disconnect during observation restarts the stability counter within the original deadline', shellOptions, () => replay('offline-observation', 'gesture10', 0, 4));
test('persistent ADB failure cannot pass readiness or extend its deadline', shellOptions, () => replay('offline-always', 'gesture10', 1, 0));
for (const mode of ['setup', 'provision', 'other-app', 'unfocused', 'unresolved', 'anr-events', 'anr-window']) {
    test(`${mode} cannot pass readiness`, shellOptions, () => replay(mode, 'gesture10', 1, null));
}

test('diagnostic commands preserve failures and stderr without replacing the test exit status', shellOptions, () => {
    const start = source.indexOf('record_diagnostic() {');
    const end = source.indexOf('collect_captures() {', start);
    assert.ok(start >= 0 && end > start);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-adb-diagnostics-'));
    try {
        const script = `set -euo pipefail
diagnostic_dir=${quote(root)}
timeout() { if [[ "$1" == --kill-after=* ]]; then shift; fi; shift; "$@"; }
successful_command() { printf 'device\\n'; }
failed_command() { printf 'adb: device offline\\n' >&2; return 7; }
${source.slice(start, end)}
record_diagnostic healthy successful_command
record_diagnostic disconnected failed_command
exit 42
`;
        const file = path.join(root, 'replay.sh');
        fs.writeFileSync(file, script);
        const result = spawnSync(bash, [file], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 42, result.stderr);
        assert.match(fs.readFileSync(path.join(root, 'healthy.txt'), 'utf8'), /device\nexit_code=0/);
        assert.match(fs.readFileSync(path.join(root, 'disconnected.txt'), 'utf8'), /adb: device offline\nexit_code=7/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
