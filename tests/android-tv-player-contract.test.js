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

/**
 * Extract a Java method without depending on which method follows it. The
 * lightweight scanner ignores braces in strings and comments, which keeps
 * these contracts stable when implementation details are rearranged.
 */
function javaMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing Java method: ${signature}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing method body: ${signature}`);

  let depth = 0;
  let state = 'code';
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'string' && char === '"')
        || (state === 'character' && char === "'")
      ) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (char === '"') {
      state = 'string';
      continue;
    }
    if (char === "'") {
      state = 'character';
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unterminated Java method: ${signature}`);
}

function assertAppearsBefore(source, first, second, message) {
  const firstAt = source.search(first);
  const secondAt = source.search(second);
  assert.ok(firstAt >= 0, `missing first operation for ordering contract: ${first}`);
  assert.ok(secondAt >= 0, `missing second operation for ordering contract: ${second}`);
  assert.ok(firstAt < secondAt, message);
}

const mainPath = 'clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java';
const playerPath = 'clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java';
const main = read(mainPath);
const player = read(playerPath);

test('Android TV transports exact track metadata and scoped preferences end to end', () => {
  for (const key of ['trackMetadata', 'preferenceScope', 'playbackPreferences']) {
    assert.match(
      main,
      new RegExp(`optJSONObject\\("${key}"\\)`),
      `the native bridge must parse ${key}`,
    );
    assert.match(
      main,
      new RegExp(`putExtra\\([^\\n]*${key}|putExtra\\([^\\n]*EXTRA_${key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()}`),
      `the TV player intent must transport ${key}`,
    );
    assert.match(
      player,
      new RegExp(`getStringExtra\\([\\s\\S]{0,120}(?:${key}|EXTRA_${key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()})`),
      `PlayerActivity must consume ${key}`,
    );
  }

  assert.match(player, /readTrackMetadata\(/);
  assert.match(player, /new PlaybackPreferenceStore\(/);
  assert.match(player, /TrackSelectionResolver\.resolve\(/);
  assert.match(player, /TrackSelectionResolver\.fallbackStableId\(/);
  assert.match(
    player,
    /saveTrackPreference\([\s\S]*PlaybackPreferenceStore/,
    'a TV selection must persist through the same scoped preference model as mobile',
  );
});

test('Android TV refreshes an expired VOD stream in place after closing the old socket', () => {
  const request = javaMethod(player, 'private void requestFreshStream(String reason)');

  assert.match(player, /ACTION_REQUEST_FRESH_STREAM/);
  assert.match(player, /ACTION_(?:APPLY|FRESH_STREAM_RESPONSE|RECEIVE)_FRESH_STREAM/);
  assert.match(player, /new BroadcastReceiver\(\)/);
  assert.match(player, /applyFreshStreamPayload\(/);
  assert.match(main, /new BroadcastReceiver\(\)/);
  assert.match(main, /PlayerActivity\.ACTION_REQUEST_FRESH_STREAM/);
  assert.match(main, /window\.__norvaNative[\s\S]{0,120}\.retryPlayback\(/);
  assert.match(main, /PlayerActivity\.ACTION_APPLY_FRESH_STREAM/);
  assert.match(main, /\.setPackage\(getPackageName\(\)\)/);
  assert.match(main, /sendBroadcast\(response\)/);
  assert.match(request, /sendBroadcast\(/);
  assert.doesNotMatch(
    request,
    /\bfinish\s*\(/,
    'fresh VOD resolution must not close PlayerActivity or flash the catalog',
  );
  assertAppearsBefore(
    request,
    /player\s*\.\s*stop\s*\(/,
    /sendBroadcast\s*\(/,
    'the provider socket must be stopped before asking the WebView for a new URL',
  );
});

test('Android TV retires stale recovery tokens on timeout, Back and lifecycle teardown', () => {
  const timeoutStart = player.indexOf('private final Runnable freshStreamTimeout');
  const timeoutEnd = player.indexOf('protected void onCreate', timeoutStart);
  assert.ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, 'missing fresh-stream timeout');
  const timeout = player.slice(timeoutStart, timeoutEnd);
  const clear = javaMethod(player, 'private void clearFreshStreamRequest(boolean notifyHost)');
  const finishWithoutRecovery = javaMethod(player, 'private void finishWithoutRecovery()');
  const finish = javaMethod(player, 'public void finish()');
  const destroy = javaMethod(player, 'protected void onDestroy()');
  const bridge = javaMethod(main, 'private void registerPlayerRecoveryBridge()');
  const deliver = javaMethod(main, 'private boolean deliverRecoveredStreamToPlayer(');
  const result = javaMethod(main, 'protected void onActivityResult(');

  assert.match(timeout, /clearFreshStreamRequest\(true\)/);
  assert.match(finishWithoutRecovery, /clearFreshStreamRequest\(true\)/);
  assert.match(finish, /clearFreshStreamRequest\(true\)/);
  assert.match(destroy, /clearFreshStreamRequest\(true\)/);
  assert.match(clear, /ACTION_CANCEL_FRESH_STREAM/);
  assert.match(clear, /\.putExtra\(EXTRA_RECOVERY_TOKEN,\s*token\)/);

  assert.match(bridge, /ACTION_CANCEL_FRESH_STREAM/);
  assert.match(bridge, /clearPendingPlayerRecovery\(token\)/);
  assert.match(bridge, /pendingPlayerRecoveryExpiresAtElapsedMs\s*=/);
  assert.match(
    bridge,
    /window\.__norvaNative\.retryPlayback\([\s\S]{0,240}jsStr\(token\)/,
    'the native recovery token must cross into the web resolver',
  );
  assert.match(deliver, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(deliver, /optString\("recoveryToken"\)/);
  assert.match(deliver, /if \(responseToken == null\) return false;/);
  assert.match(
    deliver,
    /if \(token == null \|\| expectedKey == null\) return true;/,
    'a stale recovery response must be consumed instead of opening a new player',
  );
  assert.match(
    deliver,
    /if \(!token\.equals\(responseToken\)\) return true;/,
    'a late response from recovery A must not satisfy recovery B for the same item',
  );
  assert.match(deliver, /clearPendingPlayerRecovery\(token\);\s*return true;/);
  assert.match(
    deliver,
    /if \(!expectedKey\.equals\(recoveryKey\([\s\S]{0,120}\)\)\) return true;/,
    'a token-bound response with mismatching media must be dropped',
  );
  assert.match(result, /getStringExtra\(PlayerActivity\.EXTRA_RECOVERY_TOKEN\)/);
  assert.match(result, /clearPendingPlayerRecovery\(returnedRecoveryToken\)/);
});

test('Android TV recovery callbacks obey foreground, PiP and viewer play intent', () => {
  const build = javaMethod(player, 'private void buildPlayer(String url)');
  const recover = javaMethod(player, 'private void recoverPlayback(final String reason)');
  const reconnect = javaMethod(player, 'private void scheduleLiveReconnect(final String reason)');
  const fresh = javaMethod(player, 'private void applyFreshStreamPayload(String payloadJson)');
  const fallback = javaMethod(player, 'private void switchToFallback()');
  const gate = javaMethod(player, 'private void applyPlaybackIntent()');
  const onStart = javaMethod(player, 'protected void onStart()');
  const onResume = javaMethod(player, 'protected void onResume()');
  const onPause = javaMethod(player, 'protected void onPause()');
  const onStop = javaMethod(player, 'protected void onStop()');
  const onPip = javaMethod(player, 'public void onPictureInPictureModeChanged(');
  const lifecycleCallbacks = [build, recover, reconnect, fresh, fallback];

  for (const callback of lifecycleCallbacks) {
    assert.doesNotMatch(
      callback,
      /setPlayWhenReady\(true\)/,
      'startup/recovery must not force autoplay outside the lifecycle gate',
    );
    assert.match(callback, /applyPlaybackIntent\(\)/);
  }
  assert.match(
    gate,
    /userWantsPlayback\s*&&\s*canPlayInCurrentLifecycle\(\)/,
    'playback must require both viewer intent and a foreground/PiP lifecycle',
  );
  assert.match(gate, /player\.setPlayWhenReady\(shouldPlay\)/);
  for (const foreground of [onStart, onResume]) {
    assertAppearsBefore(
      foreground,
      /activityForeground\s*=\s*true/,
      /applyPlaybackIntent\(\)/,
      'foreground must be recorded before playback intent is applied',
    );
  }
  for (const background of [onPause, onStop]) {
    assertAppearsBefore(
      background,
      /activityForeground\s*=\s*false/,
      /applyPlaybackIntent\(\)/,
      'background must be recorded before any delayed callback can resume playback',
    );
    assert.doesNotMatch(background, /player\.pause\(\)/);
  }
  assert.match(onPip, /applyPlaybackIntent\(\)/);
  const mediaSessionIntent = javaMethod(
    player,
    'public void onPlayWhenReadyChanged(boolean playWhenReady, int reason)',
  );
  assert.match(mediaSessionIntent, /userWantsPlayback\s*=\s*playWhenReady/);
  assert.match(mediaSessionIntent, /applyPlaybackIntent\(\)/);
  assert.doesNotMatch(
    mediaSessionIntent,
    /canPlayInCurrentLifecycle\(\)\s*\|\|\s*playWhenReady/,
    'a background hardware Play must not bypass the foreground/PiP gate',
  );
  assertAppearsBefore(
    mediaSessionIntent,
    /userWantsPlayback\s*=\s*playWhenReady/,
    /applyPlaybackIntent\(\)/,
    'hardware intent must be recorded before the lifecycle gate is reapplied',
  );
  assert.match(player, /applyingLifecyclePlaybackState/);
});

test('Android TV accepts cloud track preferences as launch authority and restores Retry focus', () => {
  const create = javaMethod(player, 'protected void onCreate(Bundle savedInstanceState)');
  const fresh = javaMethod(player, 'private void applyFreshStreamPayload(String payloadJson)');
  const initialize = javaMethod(
    player,
    'private void initializePlaybackPreferences(boolean cloudAuthoritative)',
  );
  const persist = javaMethod(
    player,
    'private void persistAuthoritativeCloudPreferences(',
  );
  const retry = javaMethod(player, 'private void retryPlayback()');

  assert.match(create, /initializePlaybackPreferences\(true\)/);
  assert.match(fresh, /initializePlaybackPreferences\(false\)/);
  assert.match(initialize, /cloudAuthoritative\s*&&\s*cloud != null\s*&&\s*!cloud\.isEmpty\(\)/);
  assert.match(initialize, /persistAuthoritativeCloudPreferences\(cloud\)/);
  assert.match(persist, /saveExactAudio\(/);
  assert.match(persist, /saveProfileAudio\(/);
  assert.match(persist, /saveExactSubtitle\(/);
  assert.match(persist, /saveProfileSubtitle\(/);
  assert.match(retry, /restoreControlsFocus/);
  assert.match(retry, /showControls\(playPauseBtn\)/);
  assert.match(retry, /playPauseBtn\.requestFocus\(\)/);
});

test('Android TV syncs only track types explicitly changed by the viewer', () => {
  const tracksChanged = javaMethod(player, 'private void confirmPendingTrackSelection(Tracks tracks)');
  const save = javaMethod(player, 'private void saveTrackPreference(');
  const dirty = javaMethod(player, 'private String dirtyTrackPreferencesJson()');
  const finish = javaMethod(player, 'public void finish()');

  assert.doesNotMatch(
    tracksChanged,
    /captureCurrentTrackPreferences/,
    'Media3 automatic/default selections must never become user preferences',
  );
  assert.match(save, /audioPreferenceDirty\s*=\s*true/);
  assert.match(save, /subtitlePreferenceDirty\s*=\s*true/);
  assert.match(
    dirty,
    /audioPreferenceDirty\s*\?\s*resolvedTrackPreferences\.getAudio\(\)\s*:\s*null/,
  );
  assert.match(
    dirty,
    /subtitlePreferenceDirty\s*\?\s*resolvedTrackPreferences\.getSubtitle\(\)\s*:\s*null/,
  );
  assert.match(finish, /String dirtyTrackPreferences = dirtyTrackPreferencesJson\(\)/);
  assert.doesNotMatch(player, /private void captureCurrentTrackPreferences\(/);
});

test('Android TV serializes JSON recovery delivery onto the main thread', () => {
  const playFromJson = javaMethod(main, 'private void playFromJson(final String json)');

  assert.match(
    playFromJson,
    /Looper\.myLooper\(\)\s*!=\s*android\.os\.Looper\.getMainLooper\(\)/,
  );
  assert.match(playFromJson, /runOnUiThread\(new Runnable\(\)/);
  assertAppearsBefore(
    playFromJson,
    /Looper\.myLooper\(\)/,
    /deliverRecoveredStreamToPlayer\(o\)/,
    'the WebView bridge must marshal to main before reading recovery state',
  );
});

test('Android TV remains direct-first and only activates Gateway as fallback', () => {
  const create = javaMethod(player, 'protected void onCreate(Bundle savedInstanceState)');
  const build = javaMethod(player, 'private void buildPlayer(String url)');
  const fallback = javaMethod(player, 'private void switchToFallback()');

  assert.match(create, /originalUrl\s*=\s*url/);
  assert.match(build, /setMediaItem\(MediaItem\.fromUri\(url\)\)/);
  assert.doesNotMatch(
    build,
    /setMediaItem\(MediaItem\.fromUri\(fallbackUrl\)\)/,
    'the initial media item must be the residential/provider URL',
  );
  assert.match(fallback, /fallbackTried\s*=\s*true/);
  assert.match(fallback, /MediaItem\.fromUri\(fallbackUrl\)/);
  assert.match(
    player,
    /!everReady\s*&&\s*!fallbackTried[\s\S]{0,240}switchToFallback\(\)/,
    'Gateway should be entered only after the direct startup lane fails',
  );
});

test('Android TV D-pad reveals hidden controls without pausing and preserves system volume keys', () => {
  const dispatch = javaMethod(player, 'public boolean dispatchKeyEvent(KeyEvent event)');

  const hiddenStart = dispatch.indexOf('if (!controlsVisible)');
  const visibleStart = dispatch.indexOf('// --- OSD visible', hiddenStart);
  assert.ok(hiddenStart >= 0 && visibleStart > hiddenStart, 'missing hidden-OSD key branch');
  const hiddenKeys = dispatch.slice(hiddenStart, visibleStart);
  const okStart = hiddenKeys.indexOf('case KeyEvent.KEYCODE_DPAD_CENTER');
  const okEnd = hiddenKeys.indexOf('return true', okStart);
  assert.ok(okStart >= 0 && okEnd > okStart, 'hidden OK/Enter must be handled');
  const hiddenOk = hiddenKeys.slice(okStart, okEnd);
  assert.match(hiddenOk, /showControls\(/);
  assert.doesNotMatch(
    hiddenOk,
    /togglePlay\(/,
    'the first OK/Enter press while hidden must only reveal the OSD',
  );
  assert.match(
    dispatch,
    /KEYCODE_VOLUME_UP[\s\S]{0,300}KEYCODE_VOLUME_DOWN[\s\S]{0,300}KEYCODE_VOLUME_MUTE/,
    'volume up, down and mute must be recognized as system-owned keys',
  );
  assert.match(
    dispatch,
    /KEYCODE_VOLUME_MUTE[\s\S]{0,300}return super\.dispatchKeyEvent\(event\)/,
    'TV volume/mute keys must reach Android instead of being consumed by Norva',
  );
  assert.match(
    dispatch,
    /KEYCODE_MEDIA_PLAY \|\| code == KeyEvent\.KEYCODE_MEDIA_PAUSE[\s\S]{0,180}userWantsPlayback\s*=\s*code == KeyEvent\.KEYCODE_MEDIA_PLAY[\s\S]{0,180}applyPlaybackIntent\(\)/,
    'dedicated Play and Pause keys must be idempotent instead of toggling state',
  );
});

test('Android TV pauses outside PiP and delegates complete subtitle cue rendering to Media3 UI', () => {
  const onPause = javaMethod(player, 'protected void onPause()');
  const onStop = javaMethod(player, 'protected void onStop()');
  const lifecycle = `${onPause}\n${onStop}`;
  const gradle = read('clients/android-tv/app/build.gradle');

  assert.match(gradle, /androidx\.media3:media3-ui:1\.5\.1/);
  assert.match(player, /import androidx\.media3\.ui\.SubtitleView;/);
  assert.match(player, /private SubtitleView subtitleView;/);
  assert.match(player, /subtitleView\.setCues\(/);
  assert.doesNotMatch(player, /private TextView subtitleView;/);
  assert.match(
    lifecycle,
    /applyPlaybackIntent\(\)/,
    'lifecycle pause must route through the foreground/PiP intent gate',
  );
  assert.match(
    player,
    /return activityForeground \|\| isActuallyInPictureInPicture\(\);/,
    'the lifecycle gate must recognize the real PiP state',
  );
});

test('Android TV exposes stable safe-area controls with Audio, CC, Aspect and More in the primary row', () => {
  const ids = resourceNames(
    read('clients/android-tv/app/src/main/res/values/ids.xml'),
    'item',
  );
  const requiredIds = [
    'norva_tv_player_root',
    'norva_tv_player_surface',
    'norva_tv_player_subtitles',
    'norva_tv_player_top_bar',
    'norva_tv_player_back_button',
    'norva_tv_player_title',
    'norva_tv_player_clock',
    'norva_tv_player_controls',
    'norva_tv_player_seek_bar',
    'norva_tv_player_time',
    'norva_tv_player_transport',
    'norva_tv_player_rewind_button',
    'norva_tv_player_play_pause_button',
    'norva_tv_player_forward_button',
    'norva_tv_player_primary_controls',
    'norva_tv_player_audio_button',
    'norva_tv_player_subtitle_button',
    'norva_tv_player_aspect_button',
    'norva_tv_player_more_button',
    'norva_tv_player_options_panel',
    'norva_tv_player_next_episode_button',
    'norva_tv_player_episodes_button',
    'norva_tv_player_error_panel',
    'norva_tv_player_retry_button',
    'norva_tv_player_error_back_button',
  ];
  assert.deepEqual(
    requiredIds.filter((name) => !ids.has(name)),
    [],
    'a stable TV focus/automation ID is missing',
  );
  assert.deepEqual(
    requiredIds.filter((name) => !player.includes(`R.id.${name}`)),
    [],
    'PlayerActivity must assign every stable TV focus/automation ID',
  );

  const dimens = read('clients/android-tv/app/src/main/res/values/dimens.xml');
  for (const name of ['norva_tv_player_safe_margin', 'norva_tv_player_control_min_size']) {
    const match = dimens.match(new RegExp(
      `<dimen\\s+name="${name}">([0-9]+)dp</dimen>`,
    ));
    assert.ok(match, `missing TV dimension: ${name}`);
    assert.ok(Number(match[1]) >= 48, `${name} must be at least 48dp`);
  }
  assert.match(player, /R\.dimen\.norva_tv_player_safe_margin/);
  assert.match(
    player,
    /(?:dp\(48\)|R\.dimen\.norva_tv_player_control_min_size)/,
    'every primary remote target must have a 48dp minimum implementation',
  );

  assert.match(player, /LinearLayout\s+primary(?:Controls|Actions)/);
  const overlay = javaMethod(player, 'private void buildOverlay(String title)');
  const primaryStart = overlay.search(/primary(?:Controls|Actions)\s*=\s*new LinearLayout/);
  const overflowStart = overlay.search(/buildSecondBar\(/);
  assert.ok(primaryStart >= 0 && overflowStart > primaryStart);
  for (const id of [
    'norva_tv_player_audio_button',
    'norva_tv_player_subtitle_button',
    'norva_tv_player_aspect_button',
    'norva_tv_player_more_button',
  ]) {
    const idAt = overlay.indexOf(`R.id.${id}`);
    assert.ok(
      idAt > primaryStart && idAt < overflowStart,
      `${id} must be reachable directly in the primary row`,
    );
  }
});

test('Android TV offers Fit/Zoom only and keeps playback speed out of Live TV', () => {
  const resources = read('clients/android-tv/app/src/main/res/values/strings.xml');

  assert.match(resources, /name="player_resize_fit"/);
  assert.match(resources, /name="player_resize_zoom"/);
  assert.doesNotMatch(player, /\bStretch\b/i);
  assert.doesNotMatch(resources, />\s*Stretch\s*</i);
  assert.match(
    player,
    /aspectMode\s*=\s*\(aspectMode\s*\+\s*1\)\s*%\s*2/,
    'picture sizing must cycle between exactly Fit and Zoom',
  );
  assert.match(
    player,
    /if\s*\(\s*!isLiveContent\(\)\s*\)[\s\S]{0,600}(?:speedButton|norva_tv_player_speed_button|cycleSpeed)/,
    'speed must only be created or exposed for on-demand playback',
  );
});

test('Android TV has complete EN/FR viewer copy and actionable Retry/Back errors', () => {
  const englishXml = read('clients/android-tv/app/src/main/res/values/strings.xml');
  const frenchXml = read('clients/android-tv/app/src/main/res/values-fr/strings.xml');
  const english = resourceNames(englishXml, 'string');
  const french = resourceNames(frenchXml, 'string');

  assert.deepEqual(
    [...english].filter((name) => !french.has(name)).sort(),
    [],
    'French TV resources are missing one or more source strings',
  );
  assert.deepEqual(
    [...french].filter((name) => !english.has(name)).sort(),
    [],
    'French TV resources contain a key absent from the English source',
  );
  for (const name of [
    'player_back',
    'player_rewind_10',
    'player_play',
    'player_pause',
    'player_forward_10',
    'player_audio_button',
    'player_cc_button',
    'player_aspect_button',
    'player_more_options',
    'player_resize_fit',
    'player_resize_zoom',
    'player_error_title',
    'player_retry',
    'player_error_back',
  ]) {
    assert.ok(english.has(name), `missing English TV string: ${name}`);
    assert.ok(french.has(name), `missing French TV string: ${name}`);
  }

  for (const id of [
    'norva_tv_player_error_panel',
    'norva_tv_player_error_title',
    'norva_tv_player_error_message',
    'norva_tv_player_retry_button',
    'norva_tv_player_error_back_button',
  ]) {
    assert.match(player, new RegExp(`R\\.id\\.${id}`), `error UI must assign ${id}`);
  }
  assert.match(player, /R\.string\.player_retry/);
  assert.match(player, /R\.string\.player_error_back/);
  const errorPanel = javaMethod(player, 'private void buildActionableErrorPanel()');
  const errorAction = javaMethod(player, 'private TextView errorAction(');
  assert.match(errorPanel, /R\.id\.norva_tv_player_retry_button[\s\S]{0,240}retryPlayback\(\)/);
  assert.match(errorPanel, /R\.id\.norva_tv_player_error_back_button[\s\S]{0,240}finishWithoutRecovery\(\)/);
  assert.match(errorAction, /makeFocusable\(/);
  assert.match(errorAction, /\.setOnClickListener\(/);
});
