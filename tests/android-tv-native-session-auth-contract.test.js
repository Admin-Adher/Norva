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

const main = read('clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java');
const player = read('clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java');

test('TV cloud playback cannot launch without a fresh nonce-bound bearer', () => {
  const launch = method(main, 'private void launchPlayerWithEphemeralAuth(');
  const request = method(
    main,
    'private void requestPlaybackAuthFromWeb(final String channelId, final String requestNonce)',
  );
  const deliver = method(
    main,
    'private void deliverPlaybackAuth(String channelId, String requestNonce,',
  );

  assert.match(launch, /boundedSessionId/);
  assert.match(launch, /beginAuthenticatedPlayerLaunch/);
  assert.doesNotMatch(launch, /postDelayed\([\s\S]*250L/);
  assert.doesNotMatch(
    launch,
    /startActivityForResult\(intent, REQ_PLAYER\)[\s\S]*isTrustedCloudUrl/,
    'a cloud session must not pass a fail-open branch before the trusted-origin gate',
  );
  assert.match(request, /norva-cloud-device-token/);
  assert.match(request, /NorvaAuth\.getAccessToken/);
  assert.doesNotMatch(request, /refresh_token|norva-cloud-session/);
  assert.match(deliver, /NativePlaybackAuthPolicy\.isFreshBearer/);
  assert.match(deliver, /pendingPlayerLaunchNonce/);
  assert.match(deliver, /startActivityForResult\(launchIntent, REQ_PLAYER\)/);
});

test('TV JIT auth channel is app-private, activity-scoped, nonce-scoped and one-shot', () => {
  const bridge = method(main, 'private void registerPlaybackAuthBridge()');
  const activate = method(main, 'private String activatePlaybackAuthChannel(');
  const playerRequest = method(player, 'private boolean requestPlaybackAuth(String purpose)');
  const playerAccept = method(player, 'private void acceptPlaybackAuth(Intent intent)');

  assert.match(bridge, /ContextCompat\.RECEIVER_NOT_EXPORTED/);
  assert.match(bridge, /activePlaybackAuthChannelId/);
  assert.match(bridge, /NativePlaybackAuthPolicy\.validNonce\(requestNonce\)/);
  assert.match(activate, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(playerRequest, /ACTION_REQUEST_PLAYBACK_AUTH/);
  assert.match(playerRequest, /setPackage\(getPackageName\(\)\)/);
  assert.match(playerRequest, /EXTRA_PLAYBACK_AUTH_REQUEST_NONCE/);
  assert.match(playerAccept, /playbackAuthChannelId\.equals\(channelId\)/);
  assert.match(playerAccept, /pendingPlaybackAuthRequestNonce\.equals\(requestNonce\)/);
  assert.match(playerAccept, /removeExtra\(EXTRA_PLAYBACK_AUTH_TOKEN\)/);
});

test('TV launch bearer is first-frame-only and every liveness call uses JIT auth', () => {
  const heartbeat = method(player, 'private final Runnable playbackHeartbeat = new Runnable()');
  const firstFrame = method(player, 'public void onRenderedFirstFrame()');
  const accept = method(player, 'private void acceptPlaybackAuth(Intent intent)');
  const providerFailure = method(player, 'private void reportProviderBusy()');
  const stopHeartbeat = method(player, 'private void stopPlaybackHeartbeat()');

  assert.match(firstFrame, /firstFrameBearer\s*=\s*playbackAuthToken/);
  assert.match(firstFrame, /playbackAuthToken\s*=\s*null/);
  assert.match(heartbeat, /requestPlaybackAuth\("heartbeat"\)/);
  assert.match(heartbeat, /!playbackHeartbeatRequestInFlight/);
  assert.doesNotMatch(heartbeat, /recordHeartbeat\(\s*playbackAuthToken/);
  assert.match(accept, /recordHeartbeat\([\s\S]{0,120}bearer/);
  assert.match(accept, /playbackHeartbeatRequestInFlight\s*=\s*true/);
  assert.match(accept, /playbackHeartbeatRequestInFlight\s*=\s*false/);
  assert.doesNotMatch(accept, /playbackAuthToken\s*=/);
  assert.match(providerFailure, /requestPlaybackAuth\("provider_failure"\)/);
  assert.match(
    stopHeartbeat,
    /!"provider_failure"\.equals\(pendingPlaybackAuthPurpose\)/,
    'Media3 stop callbacks must not cancel the one-shot 458 report auth request',
  );
});

test('TV liveness fails closed immediately for explicit invalidity but tolerates brief network loss', () => {
  const policy = read(
    'clients/android-tv/app/src/main/java/tv/norva/tv/PlaybackHeartbeatFailurePolicy.java',
  );
  const result = method(player, 'private void handlePlaybackHeartbeatResult(');
  const timeout = method(player, 'private final Runnable playbackAuthTimeout = new Runnable()');

  assert.match(policy, /MIN_TRANSIENT_FAILURE_WINDOW_MS\s*=\s*45_000L/);
  assert.match(policy, /MIN_TRANSIENT_FAILURE_COUNT\s*=\s*4/);
  assert.match(policy, /PLAYBACK_SUPERSEDED/);
  for (const status of ['400', '401', '403', '404', '409', '410', '422']) {
    assert.match(policy, new RegExp(`HTTP_${status}`));
  }
  assert.match(result, /STOP_SUPERSEDED/);
  assert.match(result, /STOP_SESSION_INVALID/);
  assert.match(result, /STOP_NETWORK_UNVERIFIED/);
  assert.match(timeout, /AUTH_UNAVAILABLE/);
});
