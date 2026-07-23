const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function resourceNames(xml, tagName) {
  const names = new Set();
  const matcher = new RegExp(
    `<${tagName}\\b[^>]*\\bname="([^"]+)"[^>]*(?:/>|>[\\s\\S]*?</${tagName}>)`,
    'g',
  );
  let match;
  while ((match = matcher.exec(xml)) !== null) names.add(match[1]);
  return names;
}

test('Android phone player exposes stable IDs for automation and accessibility focus', () => {
  const ids = resourceNames(
    read('clients/android-phone/app/src/main/res/values/ids.xml'),
    'item',
  );
  const requiredIds = [
    'norva_player_root',
    'norva_player_view',
    'norva_player_top_bar',
    'norva_player_back_button',
    'norva_player_title',
    'norva_player_controls',
    'norva_player_audio_button',
    'norva_player_subtitle_button',
    'norva_player_track_dialog',
    'norva_player_audio_section',
    'norva_player_subtitle_section',
    'norva_player_error_panel',
    'norva_player_error_title',
    'norva_player_error_message',
    'norva_player_retry_button',
    'norva_player_error_back_button',
    'norva_player_lock_button',
    'norva_player_unlock_button',
    'norva_player_variant_button',
    'norva_player_cast_button',
    'norva_player_cast_bar',
    'norva_player_cast_label',
    'norva_player_cast_pause_button',
    'norva_player_cast_stop_button',
    'norva_player_seek_feedback',
    'norva_player_resize_button',
    'norva_player_brightness_button',
  ];

  assert.deepEqual(
    requiredIds.filter((name) => !ids.has(name)),
    [],
    'a stable player ID is missing',
  );
});

test('Android phone French resources translate the complete player string contract', () => {
  const englishXml = read('clients/android-phone/app/src/main/res/values/strings.xml');
  const frenchXml = read('clients/android-phone/app/src/main/res/values-fr/strings.xml');
  const english = resourceNames(englishXml, 'string');
  const french = resourceNames(frenchXml, 'string');

  // OAuth configuration is deliberately global and non-translatable.
  english.delete('norva_google_web_client_id');

  assert.deepEqual(
    [...english].filter((name) => !french.has(name)).sort(),
    [],
    'French resources are missing one or more source strings',
  );
  assert.deepEqual(
    [...french].filter((name) => !english.has(name)).sort(),
    [],
    'French resources contain a key absent from the English source',
  );

  for (const key of [
    'player_tracks_button',
    'player_audio_button',
    'player_subtitles_button',
    'player_audio_selected_description',
    'player_subtitles_selected_description',
    'player_back_content_description',
    'player_subtitles_burned_in',
    'player_subtitles_burned_in_unknown',
    'player_subtitles_burned_in_detail',
    'player_lock',
    'player_unlock',
    'player_resize_fit',
    'player_resize_zoom',
    'player_resize_selected_description',
    'player_version_title',
    'player_cast_connected_to',
    'player_reconnecting',
    'player_reconnect_failed',
    'player_playback_speed_section',
    'player_playback_speed_normal',
    'player_error_network',
    'player_error_unsupported',
    'player_error_generic',
    'player_brightness_value',
    'player_volume_value',
  ]) {
    assert.ok(english.has(key), `missing English player resource: ${key}`);
    assert.ok(french.has(key), `missing French player resource: ${key}`);
  }
});

test('Android phone player keeps primary viewer-facing control copy in resources', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );
  const forbiddenLiterals = [
    /setText\("\\uD83D\\uDD12 Lock"\)/,
    /setText\("\\uD83D\\uDD13 Unlock"\)/,
    /setContentDescription\("Changer la version \(qualité\)"\)/,
    /\.setTitle\("Version"\)/,
    /setContentDescription\("Diffuser \(Chromecast\)"\)/,
    /setText\("Arrêter"\)/,
    /setText\("Diffusion sur " \+ deviceName\)/,
    /showSeekFeedback\("Zoom"\)/,
    /showSeekFeedback\("Fit"\)/,
    /showSeekFeedback\("🔆 " \+/,
    /showSeekFeedback\("🔊 " \+/,
  ];

  const violations = forbiddenLiterals
    .filter((pattern) => pattern.test(player))
    .map((pattern) => pattern.toString());
  assert.deepEqual(
    violations,
    [],
    `primary player copy must use R.string resources:\n${violations.join('\n')}`,
  );
});

test('Android phone player assigns stable IDs to the generated native views', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );
  const requiredAssignments = [
    'R.id.norva_player_root',
    'R.id.norva_player_view',
    'R.id.norva_player_top_bar',
    'R.id.norva_player_back_button',
    'R.id.norva_player_title',
    'R.id.norva_player_controls',
    'R.id.norva_player_audio_button',
    'R.id.norva_player_subtitle_button',
    'R.id.norva_player_track_dialog',
    'R.id.norva_player_audio_section',
    'R.id.norva_player_subtitle_section',
    'R.id.norva_player_error_panel',
    'R.id.norva_player_error_title',
    'R.id.norva_player_error_message',
    'R.id.norva_player_retry_button',
    'R.id.norva_player_error_back_button',
    'R.id.norva_player_lock_button',
    'R.id.norva_player_unlock_button',
    'R.id.norva_player_variant_button',
    'R.id.norva_player_cast_button',
    'R.id.norva_player_cast_bar',
    'R.id.norva_player_cast_label',
    'R.id.norva_player_cast_pause_button',
    'R.id.norva_player_cast_stop_button',
    'R.id.norva_player_seek_feedback',
    'R.id.norva_player_resize_button',
    'R.id.norva_player_brightness_button',
  ];

  assert.deepEqual(
    requiredAssignments.filter((id) => !player.includes(id)),
    [],
    'a declared stable ID is not assigned in PlayerActivity',
  );
});

test('Android phone player keeps compact actions inside the Media3 control row', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );

  assert.match(player, /private void installCompactBottomControls\(\)/);
  assert.match(player, /R\.id\.exo_basic_controls/);
  assert.match(player, /R\.id\.exo_extra_controls/);
  assert.match(player, /R\.drawable\.exo_ic_audiotrack/);
  assert.match(player, /R\.drawable\.exo_ic_subtitle_off/);
  assert.match(player, /new LinearLayout\.LayoutParams\(dp\(48\), dp\(48\)\)/);
  assert.match(player, /R\.id\.exo_overflow_hide/);
  assert.match(
    player,
    /media3Overflow\.addView\(brightnessButton, extraInsertAt\+\+[\s\S]*media3Overflow\.addView\(resizeButton, extraInsertAt,/,
  );
  assert.doesNotMatch(player, /installUtilityControls\(FrameLayout root\)/);
});

test('Android phone player offers explicit alternatives to gesture-only controls', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );

  assert.match(player, /private void installCompactBottomControls\(\)/);
  assert.match(player, /private void toggleResizeMode\(\)/);
  assert.match(player, /private void showBrightnessDialog\(\)/);
  assert.match(player, /new SeekBar\(this\)/);
  assert.match(player, /setAccessibilityLiveRegion\(View\.ACCESSIBILITY_LIVE_REGION_POLITE\)/);
  assert.match(player, /setAccessibilityHeading\(true\)/);
  assert.match(player, /focusSection\.requestFocus\(\)/);
  assert.match(player, /availableWidthDp >= 480/g);
});

test('Android phone player reserves system navigation and cutout insets', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );

  assert.match(player, /getInsetsIgnoringVisibility\([\s\S]*WindowInsets\.Type\.navigationBars\(\)/);
  assert.match(player, /findViewById\(androidx\.media3\.ui\.R\.id\.exo_controller\)/);
  assert.match(player, /controller\.setPadding\([\s\S]*safeInsetBottom/);
  assert.doesNotMatch(player, /playerView\.setPadding\(/);
  assert.match(player, /topBar\.addView\(variantButton, lp\)/);
  assert.match(player, /topBar\.addView\(castButton, btnLp\)/);
  assert.match(player, /castBar\.setPadding\([\s\S]*safeInsetRight/);
});

test('Android phone native player is landscape and uses modern immersive mode', () => {
  const manifest = read('clients/android-phone/app/src/main/AndroidManifest.xml');
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );

  assert.match(
    manifest,
    /android:name="\.PlayerActivity"[\s\S]*android:screenOrientation="sensorLandscape"/,
  );
  assert.match(player, /setDecorFitsSystemWindows\(false\)/);
  assert.match(player, /BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE/);
});

test('Android phone browsing shell also accounts for system bars', () => {
  const main = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java',
  );

  assert.match(main, /setDecorFitsSystemWindows\(false\)/);
  assert.match(
    main,
    /WindowInsets\.Type\.systemBars\(\)[\s\S]*WindowInsets\.Type\.displayCutout\(\)/,
  );
  assert.match(main, /v\.setPadding\(safe\.left, safe\.top, safe\.right, safe\.bottom\)/);
});

test('Android phone player UI telemetry is bounded and excludes provider payload', () => {
  const telemetry = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/NativePlayerUiTelemetry.java',
  );
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );

  for (const eventName of [
    'player_tracks_open',
    'player_track_select',
    'player_track_select_fail',
    'player_gesture',
    'player_error_action',
    'player_ui_summary',
  ]) {
    assert.match(telemetry, new RegExp(`"${eventName}"`));
    assert.match(player, new RegExp(`"${eventName}"`));
  }
  assert.match(telemetry, /replaceAll\("\[\^a-z0-9_.-\]\+"/);
  assert.match(telemetry, /normalized\.length\(\) > 40/);
  assert.doesNotMatch(telemetry, /url|host|provider|streamHost|originalUrl|fallbackUrl/i);
});
