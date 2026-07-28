const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

const nativeTargets = [
  {
    name: 'Android TV',
    player: 'clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java',
    main: 'clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java',
  },
  {
    name: 'Android phone',
    player: 'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
    main: 'clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java',
  },
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

for (const target of nativeTargets) {
  test(`${target.name}: live and premature EOF enter recovery instead of ending`, () => {
    const source = read(target.player);
    const stateListener = section(
      source,
      'public void onPlaybackStateChanged(int state)',
      'public void onPlayerError(PlaybackException error)',
    );
    const eofPolicy = section(
      source,
      'private boolean isLiveContent()',
      'private long recoverPositionMs()',
    );

    assert.match(stateListener, /if \(state == Player\.STATE_ENDED\)/);
    assert.match(stateListener, /if \(isPrematureEnd\(\)\)/);
    assert.match(stateListener, /recoverPlayback\(/);
    assert.match(eofPolicy, /"channel"\.equals\(itemType\) \|\| "live"\.equals\(itemType\)/);
    assert.match(eofPolicy, /private boolean isPrematureEnd\(\)[\s\S]*?if \(isLiveContent\(\)\) return true;/);
  });

  test(`${target.name}: a natural VOD end requires a rendered frame and a near-duration position`, () => {
    const source = read(target.player);
    const eofPolicy = section(
      source,
      'private boolean isPrematureEnd()',
      'private long recoverPositionMs()',
    );

    assert.match(eofPolicy, /if \(!firstFrameRendered \|\| player == null\) return true;/);
    assert.match(eofPolicy, /long duration = player\.getDuration\(\);/);
    assert.match(eofPolicy, /long position = Math\.max\(0, player\.getCurrentPosition\(\)\);/);
    assert.match(eofPolicy, /if \(duration <= 0 \|\| duration == C\.TIME_UNSET\) return true;/);
    assert.match(
      eofPolicy,
      /return position < duration - 30_000L && position < Math\.round\(duration \* 0\.97d\);/,
    );
  });

  test(`${target.name}: exhausted recovery requests a fresh stream in place with exact metadata`, () => {
    const source = read(target.player);
    const freshRequest = section(
      source,
      'private void requestFreshStream(String reason)',
      target.name === 'Android TV'
        ? 'private void registerFreshStreamReceiver()'
        : 'private void switchToFallback()',
    );

    assert.match(freshRequest, /freshStreamRequested = true;/);
    assert.match(freshRequest, /freshStreamReason\s*=/);
    assert.match(freshRequest, /sendBroadcast\(request\);/);
    assert.match(
      freshRequest,
      target.name === 'Android phone'
        ? /errHandler\.postDelayed\(freshStreamTimeout, 25_000L\);/
        : /handler\.postDelayed\(freshStreamTimeout, 25_000L\);/,
    );
    assert.doesNotMatch(
      freshRequest,
      /finish\(\);/,
      'fresh resolution must stay in the native player instead of flashing the catalog',
    );
    for (const extra of [
      'EXTRA_SOURCE_ID',
      'EXTRA_ITEM_TYPE',
      'EXTRA_ITEM_ID',
      '"positionSeconds"',
      '"durationSeconds"',
      '"retryReason"',
    ]) {
      assert.match(
        freshRequest,
        new RegExp(`putExtra\\(${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `missing ${extra} recovery request extra`,
      );
    }
  });

  test(`${target.name}: MainActivity dispatches retryPlayback before any ended callback`, () => {
    const source = read(target.main);
    const resultFlow = section(
      source,
      'final String pickedVariant = data.getStringExtra("selectedVariantStreamId")',
      'protected void onResume()',
    );

    assert.match(resultFlow, /data\.getBooleanExtra\("retryPlayback", false\)/);
    const retryCall = resultFlow.indexOf('window.__norvaNative.retryPlayback');
    const endedCall = resultFlow.indexOf('window.__norvaNative.onEnded');
    assert.ok(endedCall >= 0, 'ended callback is missing');
    if (target.name === 'Android phone') {
      assert.doesNotMatch(
        resultFlow,
        /data\.getStringExtra\("retryReason"\)|window\.__norvaNative\.retryPlayback/,
        'phone recovery is token-bound and in-place; a closed player must not be relaunched',
      );
      assert.match(
        resultFlow,
        /if \(retryPlayback && sourceId != null && itemId != null\) \{[\s\S]*?return;/,
        'a closed phone retry is consumed as cancellation before onEnded',
      );
    } else {
      assert.match(resultFlow, /data\.getStringExtra\("retryReason"\)/);
      assert.ok(retryCall >= 0, 'retry callback is missing');
      assert.ok(retryCall < endedCall, 'retry must be handled before the natural-ended flow');
      assert.match(
        resultFlow.slice(retryCall, endedCall),
        /return;/,
        'retry branch must return before onEnded/autoplay handling',
      );
    }
  });

  test(`${target.name}: a newer recovery action invalidates an older delayed reconnect`, () => {
    const source = read(target.player);
    const recovery = section(
      source,
      'private void recoverPlayback(final String reason)',
      'private void requestFreshStream(String reason)',
    );

    assert.match(source, /private int recoveryGeneration = 0;/);
    assert.match(recovery, /final int scheduledGeneration = \+\+recoveryGeneration;/);
    if (target.name === 'Android phone') {
      assert.match(
        source,
        /private final Runnable delayedRecovery[\s\S]*?player == null \|\| freshStreamRequested\s*\|\| scheduledGeneration != recoveryGeneration/,
        'the route-bound delayed Runnable must reject a stale recovery generation',
      );
      assert.match(
        recovery,
        /scheduleDelayedRecovery\(item, position, scheduledGeneration\);/,
        'phone recovery must use the cancellable delayed-recovery task',
      );
    } else {
      assert.match(
        recovery,
        /player == null \|\| freshStreamRequested\s*\|\| scheduledGeneration != recoveryGeneration/,
        'the delayed Runnable must reject a stale recovery generation',
      );
    }
    assert.match(
      source,
      /private void requestFreshStream\(String reason\) \{[\s\S]*?recoveryGeneration\+\+;[\s\S]*?private void switchToFallback\(\)/,
      'requesting a fresh stream must invalidate any pending delayed reconnect',
    );
    assert.match(
      source,
      /private void switchToFallback\(\) \{\s*recoveryGeneration\+\+;/,
      'switching URL must invalidate any pending delayed reconnect',
    );
  });
}

test('Android phone backgrounding cancels recovery work and cannot restart playback', () => {
  const source = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const background = section(
    source,
    'private void deactivatePlaybackForBackground()',
    'private void resumePlaybackAfterForegroundReturn()',
  );
  const preparation = section(
    source,
    'private void prepareMediaItem(MediaItem item, long positionMs, PlaybackUiState state)',
    'private void showPlaybackFailure(',
  );
  const foreground = section(
    source,
    'private void resumePlaybackAfterForegroundReturn()',
    '@Override\n    protected void onResume()',
  );
  const pause = section(source, 'protected void onPause()', '// Picture-in-Picture:');

  assert.match(background, /playbackActive = false;/);
  assert.match(background, /recoveryGeneration\+\+;/);
  assert.match(background, /removeCallbacks\(bufferWatchdog\)/);
  assert.match(background, /removeCallbacks\(delayedRecovery\)/);
  assert.match(background, /removeCallbacks\(freshStreamTimeout\)/);
  assert.match(background, /player\.pause\(\);/);
  assert.match(pause, /deactivatePlaybackForBackground\(\);/);
  assert.match(preparation, /boolean mayPlay = shouldAllowPlayback\(playbackActive, isInPipMode\(\)\);/);
  assert.match(preparation, /player\.setPlayWhenReady\(mayPlay\);/);
  assert.match(preparation, /if \(!mayPlay\) resumePlaybackOnResume = true;/);
  assert.match(
    foreground,
    /else if \(freshStreamRequested\) \{[\s\S]*?resumePlaybackOnResume = false;[\s\S]*?\} else if \(resumePlaybackOnResume/,
    'foreground return must wait for the token-bound replacement instead of reopening a stopped stale URL',
  );
});

test('Android phone accepts first-frame evidence only for the active media route', () => {
  const source = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const preparation = section(
    source,
    'private void prepareMediaItem(MediaItem item, long positionMs, PlaybackUiState state)',
    'private void showPlaybackFailure(',
  );

  assert.match(source, /player\.addAnalyticsListener\(new AnalyticsListener\(\)/);
  assert.match(source, /String eventRouteId = routeIdForEvent\(eventTime\);/);
  assert.match(
    source,
    /isFirstFrameForActiveRoute\(\s*eventRouteId,\s*activePlaybackRouteId,\s*currentRouteId\)/,
  );
  assert.doesNotMatch(source, /public void onRenderedFirstFrame\(\)/);
  assert.match(preparation, /String routeId = "norva-route-" \+ \(\+\+playbackRouteGeneration\);/);
  assert.match(preparation, /\.setMediaId\(routeId\)\.build\(\);/);
});

test('Android phone instrumentation and PiP actions are API- and locale-safe', () => {
  const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
  const firstFrameTest = read(
    'clients/android-phone/app/src/androidTest/java/tv/norva/phone/FirstFrameFixtureInstrumentedTest.java',
  );
  const downloadsTest = read(
    'clients/android-phone/app/src/androidTest/java/tv/norva/phone/DownloadsActivityInstrumentedTest.java',
  );
  const english = read('clients/android-phone/app/src/main/res/values/strings.xml');
  const french = read('clients/android-phone/app/src/main/res/values-fr/strings.xml');

  assert.match(firstFrameTest, /ContextCompat\.registerReceiver\(/);
  assert.match(firstFrameTest, /ContextCompat\.RECEIVER_NOT_EXPORTED/);
  assert.doesNotMatch(firstFrameTest, /Context\.RECEIVER_NOT_EXPORTED/);
  assert.match(downloadsTest, /target\.getString\(R\.string\.downloads_clear_all\)/);
  assert.doesNotMatch(downloadsTest, /findText\(root, "Clear all"\)/);
  for (const name of ['player_pip_pause', 'player_pip_play', 'player_pip_play_pause']) {
    assert.match(english, new RegExp(`<string name="${name}">`));
    assert.match(french, new RegExp(`<string name="${name}">`));
  }
  assert.match(player, /R\.string\.player_pip_pause/);
  assert.match(player, /R\.string\.player_pip_play/);
  assert.match(player, /R\.string\.player_pip_play_pause/);
  assert.doesNotMatch(player, /new RemoteAction\(icon, playing \? "Pause" : "Play"/);
});

test('Android phone network Retry preserves the cloud native-player bridge', () => {
  const source = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  const errorPanel = section(
    source,
    'private void buildErrorPanel()',
    'private void showNetworkError(String detail)',
  );

  assert.match(
    errorPanel,
    /if \("cloud"\.equals\(prefs\(\)\.getString\(PREF_MODE, null\)\)\) \{\s*connectCloud\(lastLoadedUrl\);/,
    'Retrying a cloud shell must restore NorvaTVCloud before reloading the catalog',
  );
  assert.match(
    errorPanel,
    /else \{\s*connect\(lastLoadedUrl\);\s*\}/,
    'LAN/server retries must keep their non-cloud bridge path',
  );
});

test('native bridge bootstrap survives delayed WebView interface injection', () => {
  const source = read('public/js/utils/standalone.js');

  assert.match(source, /const bootNativeBridge = \(\) =>/);
  assert.match(source, /window\.__norvaStandaloneBooted/);
  assert.match(source, /document\.readyState !== 'complete'/);
  assert.doesNotMatch(source, /document\.readyState === 'loading'/);
  assert.match(source, /window\.setInterval\(\(\) =>/);
  assert.match(source, /bridgeAttempts >= 100/);
});

test('late native bridge injection installs player overrides after the document is complete', () => {
  let bridgeRetry = null;
  const location = {
    hash: '#movies',
    origin: 'https://norva.tv',
    search: '?mobile=1',
  };
  const document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { classList: { contains() { return false; } } },
  };
  const window = {
    location,
    history: { state: null, back() {} },
    app: {},
    addEventListener() {},
    dispatchEvent() {},
    setInterval(callback) {
      bridgeRetry = callback;
      return 1;
    },
    clearInterval() {},
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    location,
    navigator: { userAgent: 'NorvaTV-AndroidPhone/1.0' },
    URL,
    console,
    Date,
    Map,
    Set,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    setTimeout() { return 1; },
    clearTimeout() {},
  });

  vm.runInContext(read('public/js/utils/standalone.js'), context);
  assert.equal(typeof bridgeRetry, 'function', 'native shells must retry a bridge injected after script load');

  class VideoPlayer {}
  class WatchPage {}
  window.NorvaTVCloud = { playVideoJson() {} };
  window.VideoPlayer = VideoPlayer;
  window.WatchPage = WatchPage;
  context.VideoPlayer = VideoPlayer;
  context.WatchPage = WatchPage;
  bridgeRetry();

  assert.equal(window.__norvaStandaloneBooted, true);
  assert.equal(typeof WatchPage.prototype.play, 'function');
  assert.equal(typeof VideoPlayer.prototype.play, 'function');
});

test('standalone native recovery is item-scoped, with bounded VOD and persistent live recovery', () => {
  const source = read('public/js/utils/standalone.js');
  const recovery = section(
    source,
    'const nativeRecoveryLaunchers = new Map()',
    'const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl, extras)',
  );

  assert.match(recovery, /const nativeRecoveryAttempts = new Map\(\)/);
  assert.match(recovery, /const NATIVE_RECOVERY_WINDOW_MS = 5 \* 60 \* 1000/);
  assert.match(recovery, /const NATIVE_RECOVERY_MAX = 3/);
  assert.match(recovery, /const NATIVE_RECOVERY_DELAYS_MS = \[1200, 3500, 7000\]/);
  assert.match(recovery, /const NATIVE_LIVE_RECOVERY_DELAYS_MS = \[250, 1000, 2500, 5000, 8000, 12000, 15000\]/);
  assert.match(recovery, /const key = nativeProgressKey\(sourceId, itemType, itemId\)/);
  assert.match(recovery, /const isLiveRecovery = itemType === 'channel' \|\| itemType === 'live'/);
  assert.match(recovery, /if \(!isLiveRecovery && state\.count >= NATIVE_RECOVERY_MAX\)/);
  assert.match(recovery, /return 'exhausted'/);
  assert.match(recovery, /state\.count \+= 1/);
  assert.match(recovery, /await entry\.launcher\(resume,\s*recoveryToken\)/);
  assert.match(recovery, /nativeRecoveryLaunchers\.get\(key\) !== entry/);
  assert.match(recovery, /currentNativeRoute\(\) !== activeNativeIntentRoute/);
  assert.match(
    recovery,
    /window\.__norvaNative\.retryPlayback\([\s\S]{0,180}reason \|\| 'resolve_failed',[\s\S]{0,60}recoveryToken/,
  );
  assert.match(recovery, /NATIVE_RECOVERY_DELAYS_MS\[attempt\]/);
  assert.match(recovery, /NATIVE_LIVE_RECOVERY_DELAYS_MS\[attempt\]/);
});

test('Android TV keeps a dropped live socket inside the native player', () => {
  const source = read('clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java');
  const recovery = section(
    source,
    'private void recoverPlayback(final String reason)',
    'private void requestFreshStream(String reason)',
  );

  assert.match(source, /private static final long\[\] LIVE_RECONNECT_DELAYS_MS/);
  assert.match(source, /private int liveReconnectAttempts = 0/);
  assert.match(recovery, /if \(isLiveContent\(\)\) \{\s*scheduleLiveReconnect\(reason\);\s*return;/);
  assert.match(recovery, /private void scheduleLiveReconnect\(final String reason\)/);
  assert.match(recovery, /player\.setMediaItem\(MediaItem\.fromUri\(originalUrl\)\)/);
  assert.doesNotMatch(
    section(source, 'private void scheduleLiveReconnect(final String reason)', 'private void requestFreshStream(String reason)'),
    /finish\(\)/,
  );
});

test('Android TV keeps technical playback diagnostics out of the viewer UI', () => {
  const source = read('clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java');
  const errorFlow = section(
    source,
    'public void onPlayerError(PlaybackException error)',
    'public void onVideoSizeChanged(VideoSize videoSize)',
  );
  const friendlyCopy = section(source, 'private String friendlyError(int code)', '/** Compact, shareable technical detail');
  const freshRequest = section(source, 'private void requestFreshStream(String reason)', 'private void switchToFallback()');

  assert.match(errorFlow, /android\.util\.Log\.w\(TAG, diagnostic, error\)/);
  assert.match(errorFlow, /reportPlaybackStatus\("broken", error\.getErrorCodeName\(\)\)/);
  assert.match(
    errorFlow,
    /(?:errorView\.setText\(|showActionableError\([\s\S]{0,180})friendlyError\(code\)\)/,
    'the viewer UI must receive only the friendly error copy',
  );
  assert.doesNotMatch(errorFlow, /errorView\.setText\([^;]*diagnos/);
  assert.doesNotMatch(errorFlow, /errorView\.setText\([^;]*getErrorCodeName/);
  assert.doesNotMatch(errorFlow, /showActionableError\([^;]*diagnos/);
  assert.doesNotMatch(errorFlow, /showActionableError\([^;]*getErrorCodeName/);
  assert.doesNotMatch(errorFlow, /reportPlaybackStatus\("broken", diagnostic\)/);
  assert.match(friendlyCopy, /final boolean live = isLiveContent\(\)/);
  assert.doesNotMatch(friendlyCopy, /Host:|Playback failed \(|getErrorCodeName/);
  assert.doesNotMatch(freshRequest, /errorView\.setText\([^;]*streamHost/);
});

test('standalone VOD recovery resolves a fresh provider session at the saved timestamp', () => {
  const source = read('public/js/utils/standalone.js');
  const vodFlow = section(source, 'if (window.WatchPage)', 'if (window.VideoPlayer)');

  assert.match(
    vodFlow,
    /const launchResolved = async \(resumeAt, fresh = false, recoveryToken = ''\)/,
  );
  assert.match(vodFlow, /if \(fresh && meta && window\.API\?\.proxy\?\.xtream\?\.getStreamUrl\)/);
  assert.match(vodFlow, /await catalogPage\?\.prepareForPlaybackSession\?\.\(\)/);
  assert.match(
    vodFlow,
    /resolved = await window\.API\.proxy\.xtream\.getStreamUrl\([\s\S]*?content\.sourceId,[\s\S]*?content\.id,[\s\S]*?streamType,[\s\S]*?container,[\s\S]*?hint[\s\S]*?\);/,
  );
  assert.match(vodFlow, /nativePlay\(resolved\.url,[\s\S]*?resumeAt,[\s\S]*?fallbackUrl/);
  assert.match(
    vodFlow,
    /registerNativeRecovery\([\s\S]{0,100}\(resumeAt, recoveryToken\) => launchResolved\(resumeAt, true, recoveryToken\)/,
  );
});

test('standalone Live recovery re-resolves the channel instead of replaying a stale URL', () => {
  const source = read('public/js/utils/standalone.js');
  const liveFlow = section(source, 'if (window.VideoPlayer)', '// Logout makes no sense');

  assert.match(liveFlow, /const relaunchLive = async \(_resumeAt = 0, recoveryToken = ''\)/);
  assert.match(
    liveFlow,
    /fresh = await window\.API\.proxy\.xtream\.getStreamUrl\([\s\S]*?channel\.sourceId,[\s\S]*?liveStreamId,[\s\S]*?'live',[\s\S]*?providerContainer/,
  );
  assert.match(liveFlow, /if \(!fresh\?\.url\) throw new Error\('No fresh live stream URL returned'\)/);
  assert.match(liveFlow, /nativePlay\(fresh\.url,[\s\S]*?fresh\.fallbackUrl \|\| null/);
  assert.match(liveFlow, /registerNativeRecovery\(meta, relaunchLive\)/);
});

test('standalone rejects duplicate playback intent before asynchronous resolution', () => {
  const source = read('public/js/utils/standalone.js');
  const vodFlow = section(source, 'if (window.WatchPage)', 'if (window.VideoPlayer)');
  const liveFlow = section(source, 'if (window.VideoPlayer)', '// Logout makes no sense');

  const vodIntent = vodFlow.indexOf('beginNativePlaybackIntent(');
  const vodResolution = vodFlow.indexOf('_fetchServerResumeInfo');
  assert.ok(vodIntent >= 0 && vodIntent < vodResolution, 'VOD intent guard must run before resume/URL awaits');

  const liveIntent = liveFlow.indexOf('beginNativePlaybackIntent(');
  const liveResolution = liveFlow.indexOf('resolveStreamPayload(streamUrl)');
  assert.ok(liveIntent >= 0 && liveIntent < liveResolution, 'Live intent guard must run before native launch resolution');
});

test('ChannelList playback claim is consumed once and still launches VideoPlayer', async () => {
  const channelListSource = read('public/js/components/ChannelList.js');
  const selectFlow = section(
    channelListSource,
    'async selectChannel(dataset)',
    'async expireStaleCloudPlaybackSession(sessionId)',
  );
  assert.match(selectFlow, /const nativeIntentClaim = window\.__norvaNative\?\.beginPlaybackIntent/);
  assert.match(selectFlow, /Object\.defineProperty\(channel, '__norvaNativeIntentClaim'/);

  let onDomReady = null;
  const launches = [];
  class VideoPlayer {
    registerCloudPlaybackSession() {}
    async prepareLiveSwitch() {}
  }
  class WatchPage {}
  const location = { hash: '#live', origin: 'https://norva.tv' };
  const document = {
    readyState: 'interactive',
    addEventListener(type, callback) {
      if (type === 'DOMContentLoaded') onDomReady = callback;
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { classList: { contains() { return false; } } },
  };
  const window = {
    NodeCastNative: {
      playVideoJson(payload) { launches.push(JSON.parse(payload)); },
    },
    __norvaNative: {},
    location,
    history: { state: null, back() {} },
    app: { channelList: null },
    addEventListener() {},
    dispatchEvent() {},
  };
  const localStorage = {
    getItem() { return 'standalone'; },
    setItem() {},
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    location,
    URL,
    console,
    Date,
    Map,
    Set,
    Promise,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    setTimeout() { return 1; },
    clearTimeout() {},
  });

  vm.runInContext(read('public/js/utils/standalone.js'), context);
  assert.equal(typeof onDomReady, 'function', 'standalone must install its DOM-ready hook');
  assert.equal(VideoPlayer.prototype.play, undefined, 'deferred classes are not available yet');
  window.VideoPlayer = VideoPlayer;
  window.WatchPage = WatchPage;
  context.VideoPlayer = VideoPlayer;
  context.WatchPage = WatchPage;
  onDomReady();
  assert.equal(
    typeof VideoPlayer.prototype.play,
    'function',
    'interactive defer execution must wait until the player class exists',
  );

  const channel = {
    sourceId: 'provider-7',
    sourceType: 'xtream',
    id: 'channel-42',
    streamId: '42',
    name: 'Test channel',
  };
  const claim = window.__norvaNative.beginPlaybackIntent('provider-7', 'channel', '42');
  assert.equal(typeof claim, 'string');
  Object.defineProperty(channel, '__norvaNativeIntentClaim', {
    value: claim,
    configurable: true,
    writable: true,
  });

  const player = new VideoPlayer();
  await player.play(channel, 'https://provider.example/live/42.ts', {});

  assert.equal(launches.length, 1, 'the claimed ChannelList selection must reach the native player');
  assert.equal(launches[0].itemId, '42');
  assert.equal(channel.__norvaNativeIntentClaim, undefined, 'the forwarded claim must be one-shot');
  assert.equal(
    window.__norvaNative.beginPlaybackIntent('provider-7', 'channel', '42'),
    false,
    'an immediate duplicate selection must remain blocked',
  );
});

test('ChannelList clears a failed live selection instead of showing a ghost Playing state', () => {
  const source = read('public/js/components/ChannelList.js');
  const selectFlow = section(
    source,
    'async selectChannel(dataset)',
    'async expireStaleCloudPlaybackSession(sessionId)',
  );
  const failureFlow = section(
    selectFlow,
    'this._streamResolveQueue = resolveTask.catch((err) => {',
    'return this._streamResolveQueue;',
  );

  assert.match(
    failureFlow,
    /const isCurrentSelection = selectSeq === this\._selectRequestSeq;/,
    'a stale rejection must not clear a newer channel selection',
  );
  assert.match(failureFlow, /this\.currentChannel = null;/);
  assert.match(failureFlow, /classList\.remove\('active', 'nav-active'\)/);
  assert.match(failureFlow, /guide\?\.refreshPreview\?\./);
  assert.match(failureFlow, /guide\?\.updateHighlights\?\./);
  assert.match(
    failureFlow,
    /if \(isCurrentSelection && window\.app\?\.player\?\.showError\)/,
    'a stale rejection must not place an error over a newer successful zap',
  );
});

test('standalone cancels stale delayed recovery but keeps same-route Android restore valid', () => {
  const source = read('public/js/utils/standalone.js');
  const recovery = section(
    source,
    'const nativeRecoveryLaunchers = new Map()',
    'const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl, extras)',
  );

  assert.match(recovery, /const scheduledGeneration = nativeIntentGeneration/);
  assert.match(recovery, /scheduledGeneration !== nativeIntentGeneration/);
  assert.match(recovery, /activeNativeIntentKey !== key/);
  assert.match(recovery, /nativeRecoveryLaunchers\.get\(key\) !== entry/);
  assert.match(
    recovery,
    /if \(!activeNativeIntentKey \|\| currentNativeRoute\(\) === activeNativeIntentRoute\) return;/,
    'redundant same-route navigation must not invalidate Android recovery',
  );
});

test('standalone binds every recovered stream to the exact native recovery token', () => {
  const source = read('public/js/utils/standalone.js');
  const recovery = section(
    source,
    'window.__norvaNative.retryPlayback = (',
    '// Native track labels are fail-closed',
  );
  const nativeLaunch = section(
    source,
    'const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl, extras)',
    'const nativeTitle =',
  );
  const vodFlow = section(source, 'if (window.WatchPage)', 'if (window.VideoPlayer)');
  const liveFlow = section(source, 'if (window.VideoPlayer)', '// Logout makes no sense');

  assert.match(recovery, /recoveryToken\s*=\s*''/);
  assert.match(
    recovery,
    /if \(recoveryToken && previousRecoveryToken !== recoveryToken\)[\s\S]{0,180}nativeRecoveryAttempts\.delete\(key\)/,
    'a new native token must get a fresh bounded retry budget',
  );
  assert.match(recovery, /entry\.launcher\(resume,\s*recoveryToken\)/);
  assert.match(
    recovery,
    /retryPlayback\([\s\S]{0,240}reason \|\| 'resolve_failed',[\s\S]{0,80}recoveryToken/,
    'recursive retries must retain the original native token',
  );
  assert.match(
    nativeLaunch,
    /\.\.\.\(recoveryToken \? \{ recoveryToken \} : \{\}\)/,
    'playVideoJson must return a token only for native recovery responses',
  );
  assert.match(nativeLaunch, /activeNativeRecoveryTokens\.get\(key\) !== recoveryToken/);
  assert.match(vodFlow, /launchResolved = async \(resumeAt, fresh = false, recoveryToken = ''\)/);
  assert.match(
    vodFlow,
    /\(resumeAt, recoveryToken\) => launchResolved\(resumeAt, true, recoveryToken\)/,
  );
  assert.match(vodFlow, /playbackPreferences:[\s\S]{0,180}recoveryToken/);
  assert.match(liveFlow, /relaunchLive = async \(_resumeAt = 0, recoveryToken = ''\)/);
  assert.match(liveFlow, /activeStreamId:[\s\S]{0,140}recoveryToken/);
});

test('standalone Live recovery releases the previous cloud session before creating one replacement', () => {
  const source = read('public/js/utils/standalone.js');
  const liveFlow = section(source, 'if (window.VideoPlayer)', '// Logout makes no sense');
  const relaunch = section(
    liveFlow,
    "const relaunchLive = async (_resumeAt = 0, recoveryToken = '') =>",
    'registerNativeRecovery(meta, relaunchLive)',
  );
  const releaseAt = relaunch.indexOf('await releasePreviousLiveSession()');
  const resolveAt = relaunch.indexOf('fresh = await window.API.proxy.xtream.getStreamUrl(');
  const replacementResolutions = relaunch.match(/fresh = await window\.API\.proxy\.xtream\.getStreamUrl\(/g) || [];

  assert.ok(releaseAt >= 0, 'fresh Live recovery must release the previous session');
  assert.ok(resolveAt > releaseAt, 'previous Live session must be released before replacement resolution');
  assert.equal(replacementResolutions.length, 1, 'Live recovery must create exactly one replacement session');
  assert.match(liveFlow, /await this\.prepareLiveSwitch\(\)/);
  assert.match(liveFlow, /this\.registerCloudPlaybackSession\(channel\.cloudPlaybackSessionId\)/);
});
