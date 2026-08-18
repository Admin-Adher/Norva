// Production media-gateway contract for sequential playback on single-slot IPTV accounts.
// Run: node --test tests/media-gateway-sequential-handoff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'),
  'utf8',
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('gateway health revision identifies the combined production handoff build', () => {
  assert.match(source, /const GATEWAY_VERSION = 112;/);
});

test('/raw waits for released provider holders before opening the replacement stream', () => {
  const route = section("app.get('/raw/:token'", '// Tee the leading bytes');

  assert.match(route, /let abortedForHandoff = abortRawPumps/);
  assert.match(route, /abortedForHandoff \+= preemptAccountExtractions/);
  assert.doesNotMatch(route, /abortedForHandoff \+= preemptAccountBackgroundWhispers/);
  assert.match(route, /if \(abortedForHandoff > 0 && PROVIDER_SLOT_RELEASE_DELAY_MS > 0\)/);
  assert.match(route, /waitForRawBackoff\(PROVIDER_SLOT_RELEASE_DELAY_MS/);

  const wait = route.indexOf('if (abortedForHandoff > 0 && PROVIDER_SLOT_RELEASE_DELAY_MS > 0)');
  const loop = route.indexOf('for (let attempt = 1; attempt <= maxAttempts; attempt += 1)');
  assert.ok(wait >= 0 && wait < loop, 'provider slot wait must happen before the replacement fetch loop');
});

test('a provider extraction grants handoff eligibility exactly once while cleanup is pending', () => {
  const helper = section(
    'function preemptExtractionEntry(entry)',
    '// Provider extraction and Whisper inference',
  );
  let killCount = 0;
  const entry = { preempted: false, child: { kill() { killCount += 1; } } };
  const context = {
    accountExtractions: new Map([['provider/account', new Set([entry])]]),
    console: { log() {} },
    results: null,
  };

  vm.runInNewContext(
    `${helper}\nresults = [\n`
      + `  preemptAccountExtractions('provider/account', 'first'),\n`
      + `  preemptAccountExtractions('provider/account', 'second'),\n`
      + `];`,
    context,
  );

  assert.deepEqual(Array.from(context.results), [1, 0]);
  assert.equal(killCount, 1);
});

test('global viewer QoS preempts only background-classified extractions outside its account', () => {
  const helper = section(
    'function preemptExtractionEntry(entry)',
    '// Provider extraction and Whisper inference',
  );
  const background = { preempted: false, globalPreemptible: true, child: { killSignals: [], kill(signal) { this.killSignals.push(signal); } } };
  const viewer = { preempted: false, globalPreemptible: false, child: { killSignals: [], kill(signal) { this.killSignals.push(signal); } } };
  const sameAccount = { preempted: false, globalPreemptible: true, child: { killSignals: [], kill(signal) { this.killSignals.push(signal); } } };
  const context = {
    accountExtractions: new Map([
      ['provider/background', new Set([background, viewer])],
      ['provider/current-viewer', new Set([sameAccount])],
    ]),
    console: { log() {} },
    results: null,
  };

  vm.runInNewContext(
    `${helper}\nresults = [\n`
      + `  preemptBackgroundExtractionsGlobally('provider/current-viewer', 'viewer start'),\n`
      + `  preemptBackgroundExtractionsGlobally('provider/current-viewer', 'parallel range'),\n`
      + `];`,
    context,
  );

  assert.deepEqual(Array.from(context.results), [1, 0]);
  assert.deepEqual(background.child.killSignals, ['SIGKILL']);
  assert.deepEqual(viewer.child.killSignals, []);
  assert.deepEqual(sameAccount.child.killSignals, []);
});

test('/raw permits one self-handoff 458 retry without making 458 generally retryable', () => {
  const route = section("app.get('/raw/:token'", '// Tee the leading bytes');

  assert.match(route, /let rawHandoffRetryUsed = false/);
  assert.match(
    route,
    /const maxAttempts = 1 \+ RAW_PROVIDER_RETRY_LIMIT \+ RAW_NO_DATA_RETRY_LIMIT\s*\+ \(abortedForHandoff > 0 \? 1 : 0\)/,
  );
  assert.equal((route.match(/rawHandoffRetryUsed = true/g) || []).length, 1);
  assert.match(route, /!rawHandoffRetryUsed[\s\S]{0,180}abortedForHandoff > 0/);
  assert.match(route, /upstream\.status === 458/);
  assert.match(route, /abandonRawAttempt\(attemptGuard, upstream\.body, 'raw_handoff_slot_busy'\)/);
  assert.match(route, /preemptBackgroundWorkGlobally\(pumpProxyKey, rawPlaybackReason\)/);
  assert.doesNotMatch(
    route,
    /abortedForHandoff\s*\+=\s*preemptBackgroundWorkGlobally/,
    'cross-account QoS preemption must not earn a provider-slot 458 retry',
  );

  const genericRetry = route.indexOf('const retryable = shouldRetryProviderStatus(upstream.status)');
  assert.ok(genericRetry > route.indexOf('rawHandoffRetryUsed = true'));
  assert.doesNotMatch(route.slice(genericRetry, genericRetry + 360), /458/);
});
