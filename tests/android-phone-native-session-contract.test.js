'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method: ${signature}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing body: ${signature}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated method: ${signature}`);
}

const main = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
const player = read('clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java');
const telemetry = read(
  'clients/android-phone/app/src/main/java/tv/norva/phone/NativePlaybackTelemetry.java',
);
const closePolicy = read(
  'clients/android-phone/app/src/main/java/tv/norva/phone/NativePlaybackClosePolicy.java',
);

test('phone transports the server-owned playback session into native playback and recovery', () => {
  const jsonBridge = method(main, 'public void playVideoJson(final String json)');
  const recovered = method(player, 'private void applyFreshStreamPayload(String payloadJson)');

  assert.match(player, /EXTRA_PLAYBACK_SESSION_ID\s*=\s*"playbackSessionId"/);
  assert.match(jsonBridge, /emptyToNull\(o\.optString\("sessionId"\)\)/);
  assert.match(main, /putExtra\(PlayerActivity\.EXTRA_PLAYBACK_SESSION_ID, playbackSessionId\)/);
  assert.match(player, /playbackSessionId\s*=\s*NativePlaybackTelemetry\.boundedSessionId\([\s\S]{0,100}EXTRA_PLAYBACK_SESSION_ID/);
  assert.match(
    recovered,
    /playbackSessionId\s*=\s*NativePlaybackTelemetry\.boundedSessionId\([\s\S]{0,100}payload\.optString\("sessionId", ""\)\)/,
    'a replacement stream must replace, rather than reuse, the previous cloud session',
  );
});

test('phone posts a lightweight authenticated heartbeat only during rendered active playback', () => {
  const heartbeatPolicy = method(player, 'private boolean shouldRunPlaybackHeartbeat()');
  const heartbeatUpdate = method(player, 'private void updatePlaybackHeartbeat()');
  const heartbeatRunnable = method(
    player,
    'private final Runnable playbackHeartbeat = new Runnable()',
  );
  const background = method(player, 'private void deactivatePlaybackForBackground()');
  const destroy = method(player, 'protected void onDestroy()');
  const firstFrame = method(player, 'private void recordNativeFirstFrame()');

  assert.match(player, /HEARTBEAT_INTERVAL_MS\s*=\s*5_000L/);
  assert.match(heartbeatRunnable, /requestPlaybackHeartbeatAuth\(\)/);
  assert.doesNotMatch(
    heartbeatRunnable,
    /recordHeartbeat\(playbackAuthToken/,
    'a long playback must never reuse the launch-time bearer for a lease pulse',
  );
  assert.match(heartbeatPolicy, /firstFrameForCurrentRoute/);
  assert.match(heartbeatPolicy, /player\.isPlaying\(\)/);
  assert.match(heartbeatPolicy, /playbackActive \|\| isInPipMode\(\)/);
  assert.match(heartbeatPolicy, /!isLocal/);
  assert.match(
    heartbeatUpdate,
    /errHandler\.post\(playbackHeartbeat\)/,
    'the first lease pulse must start as soon as the first frame proves playback',
  );
  assert.match(heartbeatRunnable, /postDelayed\(this, HEARTBEAT_INTERVAL_MS\)/);
  assert.match(background, /stopPlaybackHeartbeat\(\)/);
  assert.match(destroy, /stopPlaybackHeartbeat\(\)/);
  assert.match(destroy, /playbackAuthToken = null;/);
  assert.match(
    firstFrame,
    /recordFirstFrame[\s\S]*playbackAuthToken\s*=\s*null/,
    'the launch bearer must be cleared once first-frame truth has captured it',
  );
  assert.match(firstFrame, /firstFrameTelemetrySent/);

  assert.match(
    telemetry,
    /PLAYBACK_SESSIONS_URL[\s\S]*"https:\/\/api\.norva\.tv\/functions\/v1\/norva-playback\/playback\/sessions\/"/,
  );
  const heartbeat = method(
    telemetry,
    'static void recordHeartbeat(final String authToken, final String playbackSessionId,',
  );
  assert.match(heartbeat, /setRequestMethod\("POST"\)/);
  assert.match(heartbeat, /setFixedLengthStreamingMode\(0\)/);
  assert.match(heartbeat, /openConnection\([\s\S]{0,160}authToken\)/);
  const connection = method(
    telemetry,
    'private static HttpURLConnection openConnection(String url, String authToken)',
  );
  assert.match(connection, /"Authorization", "Bearer " \+ authToken/);
  assert.doesNotMatch(heartbeat, /JSONObject|sourceId|itemId|originalUrl|fallbackUrl/);
});

test('every native heartbeat obtains a current bearer through a nonce-scoped private channel', () => {
  const launch = method(main, 'private void launchPlayerWithEphemeralAuth(final Intent intent)');
  const activate = method(main, 'private void activatePlaybackAuthChannel(Intent intent)');
  const mainBridge = method(main, 'private void registerPlaybackAuthBridge()');
  const webRequest = method(
    main,
    'private void requestPlaybackAuthFromWeb(final String channelId, final String requestNonce)',
  );
  const deliver = method(
    main,
    'private void deliverPlaybackAuthToPlayer(String channelId, String requestNonce,',
  );
  const request = method(player, 'private boolean requestPlaybackAuth(String purpose)');
  const heartbeatRequest = method(player, 'private void requestPlaybackHeartbeatAuth()');
  const accept = method(player, 'private void acceptPlaybackAuth(Intent intent)');
  const timeout = method(
    player,
    'private final Runnable playbackAuthTimeout = new Runnable()',
  );
  const clearPlayerRequest = method(
    player,
    'private void clearPendingPlaybackAuthRequest()',
  );
  const destroy = method(player, 'protected void onDestroy()');

  assert.match(player, /ACTION_REQUEST_PLAYBACK_AUTH/);
  assert.match(player, /ACTION_APPLY_PLAYBACK_AUTH/);
  assert.match(player, /EXTRA_PLAYBACK_AUTH_CHANNEL_ID\s*=\s*"playbackAuthChannelId"/);
  assert.match(main, /PLAYBACK_AUTH_REQUEST_TTL_MS\s*=\s*5_000L/);
  assert.match(player, /PLAYBACK_AUTH_RESPONSE_TIMEOUT_MS\s*=\s*5_000L/);

  assert.match(launch, /activatePlaybackAuthChannel\(intent\)/);
  assert.match(activate, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(activate, /activePlaybackAuthChannelId\s*=\s*channelId/);
  assert.match(activate, /putExtra\(PlayerActivity\.EXTRA_PLAYBACK_AUTH_CHANNEL_ID, channelId\)/);

  assert.match(mainBridge, /ACTION_REQUEST_PLAYBACK_AUTH/);
  assert.match(mainBridge, /ContextCompat\.RECEIVER_NOT_EXPORTED/);
  assert.match(mainBridge, /activePlaybackAuthChannelId/);
  assert.match(mainBridge, /requestPlaybackAuthFromWeb\(channelId, requestNonce\)/);
  assert.match(webRequest, /norva-cloud-device-token/);
  assert.match(webRequest, /NorvaAuth\.getAccessToken/);
  assert.ok(
    webRequest.indexOf('norva-cloud-device-token') < webRequest.indexOf('NorvaAuth.getAccessToken'),
    'the stable paired-device token must be preferred before rotating a user JWT',
  );
  assert.doesNotMatch(webRequest, /refresh_token|norva-cloud-session/);

  assert.match(request, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(request, /ACTION_REQUEST_PLAYBACK_AUTH/);
  assert.match(request, /EXTRA_PLAYBACK_AUTH_CHANNEL_ID/);
  assert.match(request, /EXTRA_PLAYBACK_AUTH_REQUEST_NONCE/);
  assert.match(request, /setPackage\(getPackageName\(\)\)/);
  assert.match(
    request,
    /postDelayed\(\s*playbackAuthTimeout,\s*PLAYBACK_AUTH_RESPONSE_TIMEOUT_MS\s*\)/,
  );
  assert.match(heartbeatRequest, /requestPlaybackAuth\("heartbeat"\)/);

  assert.match(deliver, /pendingPlaybackAuthRequestNonce/);
  assert.match(deliver, /pendingPlaybackAuthExpiresAtElapsedMs/);
  assert.match(deliver, /NativePlaybackAuthPolicy\.isFreshBearer/);
  assert.match(deliver, /ACTION_APPLY_PLAYBACK_AUTH/);
  assert.match(deliver, /setPackage\(getPackageName\(\)\)/);
  assert.match(accept, /playbackAuthChannelId\.equals\(channelId\)/);
  assert.match(accept, /pendingPlaybackAuthRequestNonce\.equals\(requestNonce\)/);
  assert.match(accept, /removeExtra\(EXTRA_PLAYBACK_AUTH_TOKEN\)/);
  assert.match(
    accept,
    /NativePlaybackTelemetry\.recordHeartbeat\([\s\S]{0,100}bearer,[\s\S]{0,100}heartbeatSessionId/,
  );
  assert.match(accept, /ProviderPlaybackPolicy\.isPlaybackSuperseded\(resultCode\)/);
  assert.match(accept, /lastPlaybackHeartbeatElapsedMs\s*=\s*SystemClock\.elapsedRealtime\(\)/);
  assert.doesNotMatch(accept, /playbackAuthToken\s*=/);

  assert.match(timeout, /clearPendingPlaybackAuthRequest\(\)/);
  assert.match(clearPlayerRequest, /pendingPlaybackAuthRequestNonce\s*=\s*null/);
  assert.match(destroy, /pendingPlaybackAuthRequestNonce\s*=\s*null/);
  assert.match(destroy, /playbackAuthChannelId\s*=\s*null/);
});

test('stale player activities and stale nonce responses cannot receive a bearer', () => {
  const mainBridge = method(main, 'private void registerPlaybackAuthBridge()');
  const deliver = method(
    main,
    'private void deliverPlaybackAuthToPlayer(String channelId, String requestNonce,',
  );
  const clear = method(main, 'private void clearPlaybackAuthChannel(String channelId)');
  const result = method(main, 'protected void onActivityResult(');
  const accept = method(player, 'private void acceptPlaybackAuth(Intent intent)');

  assert.match(mainBridge, /!channelId\.equals\(activePlaybackAuthChannelId\)/);
  assert.match(mainBridge, /NativePlaybackAuthPolicy\.validNonce\(requestNonce\)/);
  assert.match(deliver, /!channelId\.equals\(activePlaybackAuthChannelId\)/);
  assert.match(deliver, /!requestNonce\.equals\(pendingPlaybackAuthRequestNonce\)/);
  assert.match(deliver, /SystemClock\.elapsedRealtime\(\)\s*>\s*pendingPlaybackAuthExpiresAtElapsedMs/);
  assert.match(clear, /!channelId\.equals\(activePlaybackAuthChannelId\)/);
  assert.match(result, /clearPlaybackAuthChannel/);
  assert.match(accept, /!playbackAuthChannelId\.equals\(channelId\)/);
  assert.match(accept, /!pendingPlaybackAuthRequestNonce\.equals\(requestNonce\)/);
});

test('phone stops heartbeat on pause, stop, natural end and terminal failure', () => {
  const listener = method(player, 'public void onPlaybackStateChanged(int state)');
  const playing = method(player, 'public void onIsPlayingChanged(boolean isPlaying)');
  const failure = method(player, 'boolean retryAllowed');
  const pause = method(player, 'protected void onPause()');
  const stop = method(player, 'protected void onStop()');
  const pip = method(player, 'public void onPictureInPictureModeChanged(');

  assert.match(listener, /STATE_ENDED[\s\S]{0,220}stopPlaybackHeartbeat\(\)/);
  assert.match(playing, /if \(isPlaying\)[\s\S]*updatePlaybackHeartbeat\(\)[\s\S]*else[\s\S]*stopPlaybackHeartbeat\(\)/);
  assert.match(failure, /stopPlaybackHeartbeat\(\)/);
  assert.match(pause, /stopPlaybackHeartbeat\(\)/);
  assert.match(stop, /stopPlaybackHeartbeat\(\)/);
  assert.match(
    pip,
    /if \(isInPip\)[\s\S]{0,180}updatePlaybackHeartbeat\(\)/,
    'Android 12 may report onPause before PiP becomes observable, so PiP must re-arm the lease',
  );
});

test('fresh-stream waiting budget covers the resolver worst case without another retry', () => {
  const timeout = method(player, 'private final Runnable freshStreamTimeout = new Runnable()');
  const request = method(player, 'private void requestFreshStream(String reason)');
  const foreground = method(player, 'private void resumePlaybackAfterForegroundReturn()');

  assert.match(player, /FRESH_STREAM_TIMEOUT_MS\s*=\s*60_000L/);
  assert.match(main, /PLAYER_RECOVERY_TTL_MS\s*=\s*65_000L/);
  assert.match(request, /postDelayed\(freshStreamTimeout, FRESH_STREAM_TIMEOUT_MS\)/);
  assert.match(foreground, /postDelayed\(freshStreamTimeout, FRESH_STREAM_TIMEOUT_MS\)/);
  assert.doesNotMatch(timeout, /requestFreshStream|recoverPlayback|switchToFallback|prepareMediaItem/);
});

test('phone keeps exact native close pending until an explicit trusted ACK', () => {
  const finish = method(player, 'public void finish()');
  const result = method(main, 'protected void onActivityResult(');
  const queue = method(main, 'private void queuePlaybackSessionClose(');
  const dispatch = method(main, 'private void dispatchPlaybackSessionClose(String sessionId)');
  const ack = method(main, 'private void acknowledgePlaybackSessionClosed(String rawSessionId)');
  const bridge = method(main, 'private class CloudBridge');

  assert.match(finish, /putExtra\(EXTRA_PLAYBACK_SESSION_ID, playbackSessionId\)/);
  assert.match(finish, /putExtra\(EXTRA_PLAYBACK_CLOSE_REASON, playbackCloseReason\(\)\)/);
  assert.match(result, /queuePlaybackSessionClose\([\s\S]{0,220}continuePlayerResult\(data\)/);
  assert.doesNotMatch(result, /selectedVariantStreamId|window\.__norvaNative\.onEnded/);
  assert.match(queue, /persistPendingPlaybackSessionClosesLocked\(\)/);
  assert.match(queue, /pendingPlaybackCloseContinuations\.put\(sessionId, continuation\)/);
  assert.match(dispatch, /window\.__norvaNative[\s\S]{0,160}n\.onPlaybackClosed/);
  assert.match(
    dispatch,
    /String status = "accepted"\.equals\(decodedStatus\)[\s\S]{0,80}\? "accepted" : "not_ready"/,
  );
  assert.doesNotMatch(
    dispatch,
    /completePlaybackCloseAcknowledgement\(sessionId\)/,
    'accepted only transfers JS delivery ownership; it must not release the next resolver before terminal ACK',
  );
  assert.match(dispatch, /schedulePlaybackCloseRetry\(sessionId, status\)/);
  assert.ok(
    dispatch.indexOf('schedulePlaybackCloseRetry(sessionId, "not_ready")')
      < dispatch.indexOf('webView.evaluateJavascript(js'),
    'a swallowed WebView callback must already have a bounded retry armed',
  );
  assert.doesNotMatch(dispatch, /pendingPlaybackSessionCloses\.remove/);

  assert.match(bridge, /ackPlaybackSessionClosed\(final String sessionId\)/);
  assert.match(bridge, /runOnUiThread\([\s\S]{0,160}acknowledgePlaybackSessionClosed\(sessionId\)/);
  assert.match(ack, /isTrustedPlaybackClosePage\(\)/);
  assert.match(ack, /NativePlaybackClosePolicy\.boundedSessionId\(rawSessionId\)/);
  assert.match(ack, /pendingPlaybackSessionCloses\.containsKey\(sessionId\)/);
  assert.match(ack, /pendingPlaybackSessionCloses\.remove\(sessionId\)/);
  assert.match(ack, /persistPendingPlaybackSessionClosesLocked\(\)/);
  assert.match(ack, /completePlaybackCloseAcknowledgement\(sessionId\)/);
  assert.doesNotMatch(ack, /url|bearer|credential|authorization/i);
});

test('phone continuation runs only after terminal ACK and remains at-most-once', () => {
  const result = method(main, 'protected void onActivityResult(');
  const immediateState = method(main, 'private void persistPlayerResultState(Intent data)');
  const resultContinuation = method(main, 'private void continuePlayerResult(Intent data)');
  const acknowledged = method(
    main,
    'private void completePlaybackCloseAcknowledgement(String sessionId)',
  );
  const dispatch = method(main, 'private void dispatchPlaybackSessionClose(String sessionId)');
  const ack = method(main, 'private void acknowledgePlaybackSessionClosed(String rawSessionId)');

  for (const marker of ['selectedVariantStreamId', 'retryPlayback', 'window.__norvaNative.onEnded']) {
    assert.match(resultContinuation, new RegExp(marker.replaceAll('.', '\\.'), 's'));
  }
  assert.ok(
    result.indexOf('persistPlayerResultState(data)')
      < result.indexOf('queuePlaybackSessionClose('),
    'progress and track preferences must leave PlayerActivity before exact close can wait or retry',
  );
  assert.match(immediateState, /window\.__norvaNative\.onTrackPreferences/);
  assert.match(immediateState, /window\.__norvaNative\.onProgress/);
  assert.doesNotMatch(
    resultContinuation,
    /onTrackPreferences|\.onProgress\(/,
    'only actions that can open a replacement playback session belong behind the close ACK',
  );
  assert.match(acknowledged, /acknowledgedPlaybackCloseSessionIds\.add\(sessionId\)/);
  assert.match(acknowledged, /pendingPlaybackCloseContinuations\.remove\(sessionId\)/);
  assert.match(acknowledged, /continuation\.run\(\)/);
  assert.match(ack, /completePlaybackCloseAcknowledgement\(sessionId\)/);
  assert.doesNotMatch(dispatch, /pendingPlaybackCloseContinuations\.remove|continuation\.run/);
  assert.doesNotMatch(dispatch, /continuePlayerResult/);
});

test('phone persists only bounded close identity plus age anchor and retries delivery finitely', () => {
  const queue = method(main, 'private void queuePlaybackSessionClose(');
  const load = method(main, 'private void loadPendingPlaybackSessionCloses()');
  const persist = method(main, 'private void persistPendingPlaybackSessionClosesLocked()');
  const retry = method(main, 'private void schedulePlaybackCloseRetry(String sessionId, String status)');
  const flush = method(main, 'private void flushPendingPlaybackSessionCloses(boolean resetAttempts)');
  const resume = method(main, 'protected void onResume()');
  const destroy = method(main, 'protected void onDestroy()');
  const pageFinished = method(main, 'public void onPageFinished(WebView view, String url)');
  const save = method(main, 'protected void onSaveInstanceState(Bundle outState)');

  assert.match(closePolicy, /MAX_ACKNOWLEDGED_CLOSES\s*=\s*64/);
  assert.match(closePolicy, /MAX_PENDING_CLOSES\s*=\s*64/);
  assert.match(closePolicy, /MAX_PENDING_AGE_MS\s*=\s*12L\s*\*\s*60L\s*\*\s*60L\s*\*\s*1_000L/);
  assert.match(closePolicy, /MAX_DELIVERY_ATTEMPTS\s*=\s*5/);
  assert.match(closePolicy, /encode\(String sessionId, String reason, long createdAtEpochMs\)/);
  assert.doesNotMatch(closePolicy, /url|bearer|credential|authorization|accessToken|refreshToken/i);
  assert.match(load, /getStringSet\(\s*PREF_PENDING_PLAYBACK_CLOSES/);
  assert.match(load, /NativePlaybackClosePolicy\.decode\(value, nowEpochMs\)/);
  assert.doesNotMatch(load, /pendingPlaybackSessionCloses\.remove/);
  assert.match(persist, /putStringSet\(\s*PREF_PENDING_PLAYBACK_CLOSES/);
  assert.match(persist, /NativePlaybackClosePolicy\.encode/);
  assert.doesNotMatch(persist, /Intent|Bundle|url|token|credential|authorization/i);
  assert.match(queue, /pruneExpiredPlaybackSessionClosesLocked\(nowEpochMs\)/);
  assert.match(queue, /evictOldestPlaybackSessionCloseLocked\(\)/);
  assert.match(queue, /MAX_PENDING_CLOSES/);
  assert.match(retry, /NativePlaybackClosePolicy\.retryDelayMs\(attempts, status\)/);
  assert.match(retry, /if \(delayMs < 0L\) return/);
  assert.match(flush, /playbackCloseDeliveryAttempts\.clear\(\)/);
  assert.match(flush, /pruneExpiredPlaybackSessionClosesLocked\(System\.currentTimeMillis\(\)\)/);
  assert.match(resume, /flushPendingPlaybackSessionCloses\(true\)/);
  assert.match(pageFinished, /flushPendingPlaybackSessionCloses\(true\)/);
  assert.match(destroy, /cancelPlaybackCloseRetryTimers\(\)/);
  assert.match(destroy, /playbackCloseDeliveryActive\s*=\s*false/);
  assert.match(retry, /!playbackCloseDeliveryActive/);
  assert.doesNotMatch(save, /PREF_PENDING_PLAYBACK_CLOSES|playbackSessionClose/i);
});

test('terminal telemetry is one-shot, bounded and never includes stream secrets', () => {
  const terminal = method(
    telemetry,
    'static void recordTerminal(final String authToken, final String playbackSessionId,',
  );
  const failure = method(player, 'boolean retryAllowed');

  assert.match(player, /sawLongStart/);
  assert.match(player, /lastRecoveryReason/);
  assert.match(player, /lastRecoveryRoute/);
  assert.match(player, /recoveryAttempt/);
  assert.match(failure, /terminalTelemetrySent/);
  assert.match(failure, /requestTerminalTelemetryAuth/);
  assert.doesNotMatch(
    failure,
    /recordTerminal\(\s*playbackAuthToken/,
    'terminal telemetry after a long playback must not reuse the launch-time JWT',
  );
  for (const field of [
    'clientSurface', 'sawLongStart', 'recoveryReason', 'recoveryRoute', 'recoveryAttempt',
  ]) {
    assert.match(terminal, new RegExp(`"${field}"`));
  }
  assert.match(telemetry, /boundedRecoveryReason/);
  assert.match(telemetry, /boundedRecoveryRoute/);
  assert.match(telemetry, /boundedTerminalCode/);
  assert.doesNotMatch(terminal, /originalUrl|fallbackUrl|streamHost|Authorization.*metadata/);
  assert.doesNotMatch(terminal, /errorMessage/);
});

test('terminal telemetry after a long playback uses the same fresh bounded bearer channel', () => {
  const request = method(player, 'private void requestTerminalTelemetryAuth(');
  const accept = method(player, 'private void acceptPlaybackAuth(Intent intent)');
  const clear = method(player, 'private void clearPendingPlaybackAuthRequest()');

  assert.match(request, /requestPlaybackAuth\("terminal"\)/);
  assert.ok(
    request.indexOf('clearPendingPlaybackAuthRequest()')
      < request.indexOf('requestPlaybackAuth("terminal")'),
    'terminal truth must preempt an in-flight heartbeat credential request',
  );
  assert.match(accept, /"terminal"\.equals\(purpose\)/);
  assert.match(accept, /NativePlaybackTelemetry\.recordTerminal\(\s*bearer/);
  assert.match(clear, /pendingTerminalTelemetryCode\s*=\s*null/);
  assert.doesNotMatch(accept, /recordTerminal\(\s*playbackAuthToken/);
});
