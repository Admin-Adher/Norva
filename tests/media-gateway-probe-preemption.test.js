'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  'function registerAccountExtraction',
  '// True while THIS box holds',
);
const probeRoute = sourceBetween(
  "app.post('/probe-audio'",
  '// Phase 2: detect the language',
);
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
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }
}

function makeHarness() {
  const children = [];
  const spawnCalls = [];
  let viewerBusy = false;
  const context = {
    Error,
    JSON,
    Map,
    Set,
    clearTimeout,
    setTimeout,
    FFPROBE_PATH: '/fake/ffprobe',
    lastNonEmptyLine(value) {
      return String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
    },
    proxyKeyFromUrl(url) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return `${parsed.host}/${segments[1] || ''}`;
    },
    sanitizeLog(value) {
      return String(value || '');
    },
    accountSlotBusyLocally() {
      return viewerBusy;
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
        preemptAccountExtractions,
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

test('background ffprobe is released on child error and timeout', async (t) => {
  await t.test('child error', async () => {
    const harness = makeHarness();
    const pending = harness.runFfprobe([], 1_000, providerUrl, { background: true });

    harness.children[0].emit('error', new Error('spawn failed'));

    await assert.rejects(pending, /spawn failed/);
    assert.equal(harness.accountExtractions.has(providerKey), false);
  });

  await t.test('timeout', async () => {
    const harness = makeHarness();
    const pending = harness.runFfprobe([], 10, providerUrl, { background: true });

    await assert.rejects(pending, /Codec probe timeout/);
    assert.deepEqual(harness.children[0].killSignals, ['SIGTERM']);
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
    /probeCodecProfile\(url, ua, \{ background: true \}\)/,
  );
  assert.match(
    probeRoute,
    /Number\.isInteger\(err\.status\) \? err\.status : 502/,
  );
  assert.match(
    probeRoute,
    /code: err\.code \|\| undefined/,
  );
});

test('metadata uses the same decoded provider-account key and is viewer-preemptible', () => {
  const keyHelpers = sourceBetween(
    'function proxyKeyFromUrl',
    '// \u2500\u2500 Raw byte-pipe ledger',
  );
  const helpers = vm.runInNewContext(
    `(() => { ${keyHelpers}; return { proxyKeyFromUrl, providerAccountKeyFromCredentials }; })()`,
    { URL },
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
    /registerAccountExtraction\(backgroundKey, \{ kill: \(\) => controller\.abort\(\) \}\)/,
  );
  assert.match(
    gateway,
    /if \(registration\?\.preempted\)[\s\S]*'viewer_preempted'/,
  );
});
