'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const providerFailure = require('../services/media-gateway/src/providerFailure.js');

const root = path.join(__dirname, '..');
const gateway = fs.readFileSync(
  path.join(root, 'services/media-gateway/src/index.js'),
  'utf8',
);

function sourceBetween(startMarker, endMarker) {
  const start = gateway.indexOf(startMarker);
  const end = gateway.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return gateway.slice(start, end).trim();
}

const registrationSource = sourceBetween(
  'function preemptExtractionEntry',
  '// True while THIS box holds',
);
const probeDrainSource = sourceBetween(
  'function createProviderProbeDrainState',
  '// Audio-language probe',
);
const probeHandlerSource = sourceBetween(
  'async function handleProbeAudioRequest',
  "app.post('/probe-audio'",
);
const probeRouteRegistration = sourceBetween(
  "app.post('/probe-audio'",
  '// ── Strict LID loopback broker',
);
const probeRoute = `${probeHandlerSource}\n${probeRouteRegistration}`;
const seriesMetadataRoutes = sourceBetween(
  "app.post('/xtream/series-info'",
  '// Raw byte-range passthrough',
);
const runnerSource = sourceBetween(
  'function backgroundProbeError',
  'function hasUsefulCodecProfile',
);

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }
}

function makeHarness({ globalViewerBusyChecks = null } = {}) {
  const children = [];
  const spawnCalls = [];
  let viewerBusy = false;
  let globalViewerBusy = false;
  const globalBusyChecks = Array.isArray(globalViewerBusyChecks)
    ? [...globalViewerBusyChecks]
    : null;
  const context = {
    Error,
    JSON,
    Map,
    Set,
    clearTimeout,
    setTimeout,
    ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION: 'language-validation',
    ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH: 'catalog-refresh',
    ACCOUNT_ACTIVITY_KIND_GATEWAY: 'gateway',
    FFPROBE_PATH: '/fake/ffprobe',
    lastNonEmptyLine(value) {
      return String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
    },
    proxyKeyFromUrl(url) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return `${parsed.host}/${segments[1] || ''}`;
    },
    proxyEnvFor() {
      return undefined;
    },
    isProxyAuthenticationFailure: providerFailure.isProxyAuthenticationFailure,
    sanitizeLog(value) {
      return String(value || '');
    },
    accountSlotBusyLocally() {
      return viewerBusy;
    },
    viewerPlaybackActiveLocally() {
      if (globalBusyChecks?.length) return globalBusyChecks.shift();
      return globalViewerBusy;
    },
    spawn(command, args, options) {
      const child = new FakeChild();
      children.push(child);
      spawnCalls.push({ command, args, options });
      return child;
    },
  };
  const harness = vm.runInNewContext(
    `(() => {
      const accountExtractions = new Map();
      ${registrationSource}
      ${runnerSource}
      return {
        accountExtractions,
        registerAccountExtraction,
        preemptAccountExtractions,
        preemptBackgroundExtractionsGlobally,
        viewerQosStats,
        runFfprobe,
      };
    })()`,
    context,
  );
  return {
    ...harness,
    children,
    spawnCalls,
    setViewerBusy(value) {
      viewerBusy = Boolean(value);
      globalViewerBusy = Boolean(value);
    },
  };
}

function makeProbeRouteHarness() {
  const children = [];
  const events = [];
  let releaseDelay = null;
  const context = {
    Error,
    JSON,
    Map,
    Set,
    URL,
    Buffer,
    events,
    clearTimeout,
    setTimeout,
    PROVIDER_SLOT_RELEASE_DELAY_MS: 2_500,
    ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION: 'language-validation',
    ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH: 'catalog-refresh',
    ACCOUNT_ACTIVITY_KIND_GATEWAY: 'gateway',
    FFPROBE_PATH: '/fake/ffprobe',
    lastNonEmptyLine(value) {
      return String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
    },
    proxyKeyFromUrl(url) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return `${parsed.host}/${segments[1] || ''}`;
    },
    proxyEnvFor() {
      return undefined;
    },
    isProxyAuthenticationFailure: providerFailure.isProxyAuthenticationFailure,
    sanitizeLog(value) {
      return String(value || '');
    },
    accountSlotBusyLocally() {
      return false;
    },
    viewerPlaybackActiveLocally() {
      return false;
    },
    isHttpUrl(value) {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch (_) {
        return false;
      }
    },
    sanitizeUserAgent(value) {
      return String(value || '');
    },
    normalizeCodecToken(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    },
    publicMkvCodecProfile(profile) {
      return profile;
    },
    sleep(ms) {
      events.push(`delay:${ms}`);
      return new Promise((resolve) => {
        releaseDelay = () => {
          events.push('delay-released');
          resolve();
        };
      });
    },
    spawn(command, args, options) {
      events.push('spawn');
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  };
  const harness = vm.runInNewContext(
    `(() => {
      const accountExtractions = new Map();
      ${registrationSource}
      const baseRegisterAccountExtraction = registerAccountExtraction;
      registerAccountExtraction = function (...args) {
        events.push('registration');
        const registration = baseRegisterAccountExtraction(...args);
        const baseRelease = registration.release;
        registration.release = () => {
          events.push('registration-release');
          baseRelease?.();
        };
        return registration;
      };
      ${probeDrainSource}
      ${runnerSource}
      function hasUsefulCodecProfile(profile) {
        return Array.isArray(profile?.audioTracks) && profile.audioTracks.length > 0;
      }
      function hasCompleteMkvPlaybackProfile() { return false; }
      function cacheCodecProfile() {}
      async function probeCodecProfile(url, userAgent, options) {
        await runFfprobe(['-show_streams'], 1_000, url, options);
        return {
          probeSource: 'gateway_probe',
          audioTracks: [{ index: 1, language: 'fr', default: true }],
          subtitles: [],
        };
      }
      async function probeCodecProfileUncached() {
        throw new Error('unexpected second provider probe');
      }
      ${probeHandlerSource}
      return {
        accountExtractions,
        preemptAccountExtractions,
        handleProbeAudioRequest,
      };
    })()`,
    context,
  );
  const response = {
    statusCode: 200,
    payload: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      events.push('response');
      this.payload = value;
      return value;
    },
  };
  return {
    ...harness,
    children,
    events,
    response,
    releaseDelay() {
      assert.equal(typeof releaseDelay, 'function', 'provider release delay has not started');
      const release = releaseDelay;
      releaseDelay = null;
      release();
    },
  };
}

const providerUrl = 'https://provider.test/movie/alice/secret/42.mkv';
const providerKey = 'provider.test/alice';

test('background ffprobe is registered and released after a successful exit', async () => {
  const harness = makeHarness();
  const pending = harness.runFfprobe(['-show_streams'], 1_000, providerUrl, {
    background: true,
  });

  assert.equal(harness.children.length, 1);
  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
  harness.children[0].stdout.emit('data', Buffer.from('{"streams":[]}'));
  harness.children[0].emit('exit', 0, null);

  assert.deepEqual(await pending, { streams: [] });
  assert.equal(harness.accountExtractions.has(providerKey), false);
});

test('background ffprobe distinguishes spawn failure from a live-child error', async (t) => {
  await t.test('spawn failure', async () => {
    const harness = makeHarness();
    const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    harness.children[0].pid = undefined;
    harness.children[0].emit('error', new Error('spawn failed'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false, 'spawn error alone is not a definitive child close');
    assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
    harness.children[0].emit('close', null, null);
    await assert.rejects(pending, /spawn failed/);
    assert.equal(harness.accountExtractions.has(providerKey), false);
  });

  await t.test('error after spawn retains the provider ledger until exit', async () => {
    const harness = makeHarness();
    const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    harness.children[0].emit('error', new Error('kill failed'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false, 'a live-child error is not a process-exit signal');
    assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
    assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);

    harness.children[0].emit('exit', null, 'SIGKILL');
    await assert.rejects(pending, /kill failed/);
    assert.equal(harness.accountExtractions.has(providerKey), false);
  });

  await t.test('timeout', async () => {
    const harness = makeHarness();
    const pending = harness.runFfprobe([], 10, providerUrl, { background: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.children[0].killSignals, ['SIGTERM']);
    assert.equal(harness.accountExtractions.get(providerKey)?.size, 1,
      'the provider ledger remains held until the timed-out child actually exits');
    harness.children[0].emit('exit', null, 'SIGTERM');
    await assert.rejects(pending, /Codec probe timeout/);
    assert.equal(harness.accountExtractions.has(providerKey), false);
  });
});

test('viewer preemption kills the background child and returns a stable 409 code', async () => {
  const harness = makeHarness();
  const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });
  const child = harness.children[0];

  assert.equal(harness.preemptAccountExtractions(providerKey, 'viewer play'), 1);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
  child.emit('exit', null, 'SIGKILL');

  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'viewer_preempted');
    assert.equal(error.publicMessage, 'Codec probe preempted by active playback');
    return true;
  });
  assert.equal(harness.accountExtractions.has(providerKey), false);
});

test('viewer preemption remains typed when child error wins the event race', async () => {
  const harness = makeHarness();
  const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });
  const child = harness.children[0];

  harness.preemptAccountExtractions(providerKey, 'viewer play');
  child.emit('error', new Error('killed'));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1,
    'child error alone must not release the provider reservation');
  child.emit('exit', null, 'SIGKILL');

  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'viewer_preempted');
    return true;
  });
  assert.equal(harness.accountExtractions.has(providerKey), false);
});

test('viewer preemption remains typed when timeout wins the event race', async () => {
  const harness = makeHarness();
  const pending = harness.runFfprobe([], 10, providerUrl, { background: true });

  harness.preemptAccountExtractions(providerKey, 'viewer play');
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.children[0].emit('exit', null, 'SIGKILL');

  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'viewer_preempted');
    return true;
  });
  assert.equal(harness.accountExtractions.has(providerKey), false);
});

test('the spawn boundary refuses a background probe if playback became active', async () => {
  const harness = makeHarness();
  harness.setViewerBusy(true);

  await assert.rejects(
    harness.runFfprobe([], 1_000, providerUrl, { background: true }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'account_busy');
      return true;
    },
  );
  assert.equal(harness.children.length, 0);
  assert.equal(harness.accountExtractions.size, 0);
});

test('the spawn boundary prevents concurrent background probes for one account', async () => {
  const harness = makeHarness();
  const first = harness.runFfprobe([], 1_000, providerUrl, { background: true });

  await assert.rejects(
    harness.runFfprobe([], 1_000, providerUrl, { background: true }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, 'background_busy');
      return true;
    },
  );
  assert.equal(harness.children.length, 1);

  harness.children[0].stdout.emit('data', Buffer.from('{}'));
  harness.children[0].emit('exit', 0, null);
  await first;
});

test('a global viewer winning the spawn race preempts and types a background probe', async () => {
  const harness = makeHarness({ globalViewerBusyChecks: [false, true] });
  const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });

  assert.equal(harness.children.length, 1);
  assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);
  assert.equal(harness.viewerQosStats.globalExtractionPreemptions, 1);
  harness.children[0].emit('exit', null, 'SIGKILL');

  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'viewer_preempted');
    return true;
  });
  assert.equal(harness.accountExtractions.size, 0);
});

test('ordinary ffprobes keep their original unregistered behavior', async () => {
  const harness = makeHarness();
  const pending = harness.runFfprobe(['-show_format'], 1_000, providerUrl);

  assert.equal(harness.accountExtractions.size, 0);
  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.spawnCalls[0].options)),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  harness.children[0].stdout.emit('data', Buffer.from('{"format":{"duration":"12"}}'));
  harness.children[0].emit('exit', 0, null);

  assert.deepEqual(
    JSON.parse(JSON.stringify(await pending)),
    { format: { duration: '12' } },
  );
  assert.equal(harness.accountExtractions.size, 0);
});

test('/probe-audio exposes the typed background backpressure contract', () => {
  assert.match(
    probeRoute,
    /probeCodecProfile\(url, ua, \{\s*background: true,\s*backgroundActivityKind: ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH,\s*providerDrainState,/,
  );
  assert.match(
    probeRoute,
    /Number\.isInteger\(err\.status\) \? err\.status : 502/,
  );
  assert.match(
    probeRoute,
    /code: err\.code \|\| undefined/,
  );
  assert.match(
    probeRoute,
    /const drainAttestation = await providerProbeDrainAttestation\(providerDrainState\);[\s\S]*\.\.\.drainAttestation/,
  );
});

test('/probe-audio keeps the shared provider reservation through the release delay', async () => {
  const harness = makeProbeRouteHarness();
  const pending = harness.handleProbeAudioRequest({
    body: { url: providerUrl, userAgent: 'Norva/Test' },
  }, harness.response);

  assert.equal(harness.children.length, 1);
  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
  assert.equal(
    [...harness.accountExtractions.get(providerKey)][0].activityKind,
    'catalog-refresh',
    '/probe-audio cooldown must be visible to the shared long-drain activity class',
  );
  assert.equal(harness.response.payload, null);

  harness.events.push('ffprobe-exit');
  harness.children[0].stdout.emit('data', Buffer.from('{"streams":[]}'));
  harness.children[0].emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1,
    'the cooldown remains visible to viewer and background admission guards');
  assert.deepEqual(harness.events, [
    'spawn',
    'registration',
    'ffprobe-exit',
    'delay:2500',
  ]);
  assert.equal(harness.response.payload, null,
    'no positive drain response is emitted while the release delay is pending');

  harness.releaseDelay();
  await pending;

  assert.equal(harness.response.statusCode, 200);
  assert.equal(harness.response.payload.providerDrained, true);
  assert.equal(harness.response.payload.providerDrainProtocol, 1);
  assert.deepEqual(harness.events, [
    'spawn',
    'registration',
    'ffprobe-exit',
    'delay:2500',
    'delay-released',
    'registration-release',
    'response',
  ]);
  assert.equal(harness.accountExtractions.has(providerKey), false);
});

test('a viewer starting during probe cooldown observes the holder and waits', async () => {
  const harness = makeProbeRouteHarness();
  const pending = harness.handleProbeAudioRequest({
    body: { url: providerUrl, userAgent: 'Norva/Test' },
  }, harness.response);

  harness.children[0].stdout.emit('data', Buffer.from('{"streams":[]}'));
  harness.children[0].emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  const stoppedForHandoff = harness.preemptAccountExtractions(providerKey, 'viewer play');
  assert.equal(stoppedForHandoff, 1,
    'the real viewer handoff counter must force its provider release delay');
  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
  const [cooldownHolder] = harness.accountExtractions.get(providerKey);
  assert.equal(cooldownHolder.providerCooldown, true);
  assert.equal(cooldownHolder.preempted, false,
    'cooldown remains reportable to the cross-replica account-activity ledger');
  assert.deepEqual(harness.children[0].killSignals, [],
    'viewer handoff must not signal an ffprobe child that already exited');
  assert.equal(harness.response.payload, null);

  harness.releaseDelay();
  await pending;
  assert.equal(harness.accountExtractions.has(providerKey), false);
  assert.equal(harness.response.payload.providerDrained, true);
});

test('/probe-audio keeps a failed ffprobe response safe and drain-attested', async () => {
  const harness = makeProbeRouteHarness();
  const pending = harness.handleProbeAudioRequest({
    body: { url: providerUrl, userAgent: 'Norva/Test' },
  }, harness.response);

  harness.children[0].stderr.emit('data', Buffer.from('provider refused request'));
  harness.events.push('ffprobe-exit');
  harness.children[0].emit('exit', 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.accountExtractions.get(providerKey)?.size, 1);
  assert.equal(harness.response.payload, null);
  assert.deepEqual(harness.events, [
    'spawn',
    'registration',
    'ffprobe-exit',
    'delay:2500',
  ]);

  harness.releaseDelay();
  await pending;

  assert.equal(harness.response.statusCode, 502);
  assert.equal(harness.response.payload.error, 'Audio probe failed');
  assert.equal(harness.response.payload.providerDrained, true);
  assert.equal(harness.response.payload.providerDrainProtocol, 1);
  assert.equal(JSON.stringify(harness.response.payload).includes(providerUrl), false);
  assert.equal(harness.accountExtractions.has(providerKey), false);
  assert.deepEqual(harness.events.at(-1), 'response');
});

test('metadata uses the same decoded provider-account key and is viewer-preemptible', () => {
  const affinity = require('../services/media-gateway/src/providerProxyPool.js');
  const keyHelpers = sourceBetween(
    'function proxyKeyFromUrl',
    '// \u2500\u2500 Raw byte-pipe ledger',
  );
  const helpers = vm.runInNewContext(
    `(() => { ${keyHelpers}; return { proxyKeyFromUrl, providerAccountKeyFromCredentials }; })()`,
    {
      URL,
      providerAccountAffinityKey: affinity.providerAccountAffinityKey,
      providerAccountAffinityKeyFromCredentials: affinity.providerAccountAffinityKeyFromCredentials,
    },
  );
  assert.equal(
    helpers.proxyKeyFromUrl(
      'https://provider.test/player_api.php?username=alice%2Btv&password=secret&action=get_series_info',
    ),
    'provider.test/alice+tv',
  );
  assert.equal(
    helpers.providerAccountKeyFromCredentials('https://provider.test', 'alice+tv'),
    'provider.test/alice+tv',
  );
  assert.match(
    seriesMetadataRoutes,
    /backgroundAccountKey: providerAccountKeyFromCredentials\(serverUrl, username\)/g,
  );
  assert.match(
    gateway,
    /registerAccountExtraction\([\s\S]{0,120}backgroundKey,[\s\S]{0,120}\{ kill: \(\) => controller\.abort\(\) \},[\s\S]{0,120}ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH/,
  );
  assert.match(
    gateway,
    /if \(registration\?\.preempted\)[\s\S]*'viewer_preempted'/,
  );
});
