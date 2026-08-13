const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('relay playback claims fail closed for legacy viewers and keep service probes compatible', async () => {
  const policyUrl = pathToFileURL(path.join(
    root,
    'services/norva-relay/src/relayPlaybackSessionPolicy.mjs',
  )).href;
  const { classifyRelaySessionClaims } = await import(policyUrl);

  assert.equal(classifyRelaySessionClaims({
    v: 1,
    sid: 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb',
    uid: 'legacy-user',
  }).kind, 'legacy_playback');
  assert.equal(classifyRelaySessionClaims({
    v: 1,
    sid: 'provider-check',
    uid: 'service-user',
  }).kind, 'service');
  assert.equal(classifyRelaySessionClaims({
    v: 2,
    purpose: 'playback',
    sid: 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb',
    coord: 'A'.repeat(43),
  }).kind, 'playback');
  assert.equal(classifyRelaySessionClaims({
    v: 2,
    purpose: 'playback',
    sid: 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb',
    route: 'B'.repeat(95),
  }).kind, 'sealed_playback');
});

test('browser tokens use a randomized sealed route that both runtimes can open', async () => {
  const edgeRouteUrl = pathToFileURL(path.join(
    root,
    'supabase/functions/_shared/relay-coordinator-route.mjs',
  )).href;
  const workerRouteUrl = pathToFileURL(path.join(
    root,
    'services/norva-relay/src/relayCoordinatorRoute.mjs',
  )).href;
  const edgeRoute = await import(edgeRouteUrl);
  const workerRoute = await import(workerRouteUrl);
  const secret = 'test-only-relay-secret';
  const coord = 'A'.repeat(43);
  const first = await edgeRoute.sealRelayCoordinatorRoute(secret, coord);
  const second = await edgeRoute.sealRelayCoordinatorRoute(secret, coord);

  assert.notEqual(first, second, 'nonce must prevent cross-session correlation');
  assert.equal(first.length, 95);
  assert.equal(await workerRoute.openRelayCoordinatorRoute(secret, first), coord);
  assert.equal(await workerRoute.openRelayCoordinatorRoute(secret, second), coord);
  await assert.rejects(workerRoute.openRelayCoordinatorRoute('wrong-secret', first));
});

test('relay playback liveness requires the exact active relay generation', async () => {
  const policyUrl = pathToFileURL(path.join(
    root,
    'services/norva-relay/src/relayPlaybackSessionPolicy.mjs',
  )).href;
  const { relayPlaybackSessionIsActive } = await import(policyUrl);
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const claims = {
    v: 2,
    purpose: 'playback',
    sid: 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb',
    coord: 'A'.repeat(43),
  };
  const active = [{
    playbackSessionId: claims.sid,
    coord: claims.coord,
    lane: 'relay',
    expiresAt: '2026-08-13T12:15:00.000Z',
  }];

  assert.equal(relayPlaybackSessionIsActive(active, claims, now), true);
  assert.equal(relayPlaybackSessionIsActive([], claims, now), false);
  assert.equal(relayPlaybackSessionIsActive([{ ...active[0], lane: 'raw' }], claims, now), false);
  assert.equal(relayPlaybackSessionIsActive([{ ...active[0], playbackSessionId: crypto.randomUUID() }], claims, now), false);
  assert.equal(relayPlaybackSessionIsActive([{ ...active[0], expiresAt: '2026-08-13T11:59:59.000Z' }], claims, now), false);
});

test('relay generation ordering rejects a delayed older commit', async () => {
  const policyUrl = pathToFileURL(path.join(
    root,
    'services/norva-relay/src/relayPlaybackSessionPolicy.mjs',
  )).href;
  const { classifyRelayPlaybackGeneration } = await import(policyUrl);
  const olderId = 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb';
  const newerId = 'cc3b8aa1-a03e-4e21-8460-224fc977c434';
  const older = {
    playbackSessionId: olderId,
    playbackCreatedAt: '2026-08-13T12:00:00.000Z',
    supersededPlaybackSessionIds: [],
  };
  const newer = {
    playbackSessionId: newerId,
    playbackCreatedAt: '2026-08-13T12:00:00.010Z',
    supersededPlaybackSessionIds: [olderId],
  };

  assert.equal(classifyRelayPlaybackGeneration(older, newer), 'current_older');
  assert.equal(classifyRelayPlaybackGeneration(newer, older), 'current_newer');
  assert.equal(classifyRelayPlaybackGeneration(newer, { ...newer }), 'same');
  assert.equal(classifyRelayPlaybackGeneration(
    { playbackSessionId: olderId, playbackCreatedAt: older.playbackCreatedAt },
    { playbackSessionId: newerId, playbackCreatedAt: older.playbackCreatedAt },
  ), 'ambiguous');
});

test('takeover interrupts a progressive relay response that is already open', async () => {
  const policyUrl = pathToFileURL(path.join(
    root,
    'services/norva-relay/src/relayPlaybackSessionPolicy.mjs',
  )).href;
  const { createRevocableRelayStream } = await import(policyUrl);
  let scheduledCheck = null;
  let sourceCancelled = null;
  let upstreamAborted = false;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel(reason) {
      sourceCancelled = reason;
    },
  });
  const wrapped = createRevocableRelayStream(source, {
    isActive: async () => false,
    abort: () => { upstreamAborted = true; },
    schedule: (callback) => { scheduledCheck = callback; return 7; },
    unschedule: () => {},
  });
  const reader = wrapped.getReader();
  assert.deepEqual(Array.from((await reader.read()).value), [1, 2, 3]);
  assert.equal(typeof scheduledCheck, 'function');
  await scheduledCheck();
  await assert.rejects(reader.read(), /PLAYBACK_SUPERSEDED/);
  assert.equal(sourceCancelled, 'PLAYBACK_SUPERSEDED');
  assert.equal(upstreamAborted, true);
});

test('relay requests prove liveness and HLS descendants preserve the revocable identity', () => {
  const relay = read('services/norva-relay/src/index.js');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const cloudApi = read('public/js/cloudApi.js');
  const watch = read('public/js/pages/WatchPage.js');

  const relayRoute = relay.slice(
    relay.indexOf('if (url.pathname.startsWith("/relay/"))'),
    relay.indexOf('// Track metadata'),
  );
  assert.match(relayRoute, /assertRelayPlaybackSessionActive\(env, claims\)/);
  assert.ok(
    relayRoute.indexOf('assertRelayPlaybackSessionActive(env, claims)')
      < relayRoute.indexOf('proxyPlayback(request, env, claims, ctx)'),
  );
  assert.match(relay, /action === "active"/);
  assert.match(relay, /relayPlaybackSessionIsActive/);
  assert.match(relay, /classifyRelayPlaybackGeneration/);
  assert.match(relay, /Playback coordinator lock expired/);
  assert.match(relay, /RELAY_RELEASE_WAIT_MS/);
  assert.match(relay, /relaySessionRevocationProtocol:\s*1/);
  assert.match(relay, /purpose:\s*claims\.purpose/);
  assert.match(relay, /claims\.route \? \{ route: claims\.route \}/);
  assert.match(relay, /openRelayCoordinatorRoute\(secret, disposition\.route\)/);
  assert.doesNotMatch(relay, /coord:\s*claims\.coord/);
  assert.match(relay, /createRevocableRelayStream/);
  assert.match(relay, /relayPlaybackSessionActive\(env, claims\)/);
  for (const route of ['vod-info', 'series-info', 'probe-audio']) {
    assert.match(
      relay,
      new RegExp(`pathname\\.startsWith\\("/${route}/"\\)[\\s\\S]*?assertRelayPlaybackSessionActive\\(env, claims\\)`),
    );
  }

  const relayCreation = playback.slice(
    playback.indexOf('if (mode === "relay")'),
    playback.indexOf('let gateway;'),
  );
  assert.match(relayCreation, /const relayCoordination = await prepareEdgeSessionCoordinator/);
  assert.match(relayCreation, /const relayTransportExpiresAt = transportExpiresAt/);
  assert.match(relayCreation, /tokenExpiresAt:\s*relayTransportExpiresAt/);
  assert.match(relayCreation, /lane:\s*"relay"/);
  assert.match(relayCreation, /if \(!relayCommit\?\.ok\)/);
  assert.match(relayCreation, /if \(relayCommit\.waitMs\) await sleep\(relayCommit\.waitMs\)/);
  assert.match(playback, /v:\s*2/);
  assert.match(playback, /purpose:\s*"playback"/);
  assert.match(playback, /sealRelayCoordinatorRoute\(runtimeConfig\.relayTokenSecret, coord\)/);
  assert.match(playback, /route,/);
  assert.match(playback, /provider-account:\$\{options\.providerAccountHash\}/);

  assert.match(cloudApi, /heartbeatSession:\s*\(id\)\s*=>\s*playbackHeartbeatRequest\(id\)/);
  const heartbeat = cloudApi.slice(
    cloudApi.indexOf('function playbackHeartbeatRequest'),
    cloudApi.indexOf('// Pull the deepest upstream detail'),
  );
  assert.match(heartbeat, /requestToBase\([\s\S]*playbackBase\(\)[\s\S]*\/heartbeat/);
  assert.doesNotMatch(heartbeat, /return request\(/);

  assert.match(watch, /setInterval\(\(\) => \{ void pulse\(\); \}, 5000\)/);
  assert.match(watch, /isPlaybackSupersededError\(error\)/);
  assert.match(watch, /handlePlaybackSuperseded/);
  const busyClassifier = watch.slice(
    watch.indexOf('isProviderBusyError(message)'),
    watch.indexOf('playbackSupersededCopy()'),
  );
  assert.doesNotMatch(busyClassifier, /PLAYBACK_SUPERSEDED/);
  assert.match(watch, /Service déjà utilisé sur un autre appareil/);
});
