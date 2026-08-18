'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const pageSource = fs.readFileSync(path.join(root, 'public/js/pages/MkvStrategyLabPage.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public/css/mkv-strategy-lab.css'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const appHtmlSource = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');

function loadLab() {
  const window = {};
  const context = vm.createContext({ window, console, Date, Map, Object, Promise, AbortController, setTimeout, clearTimeout });
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/MkvStrategyLabPage.js' });
  return window.MkvStrategyLabPage;
}

function fakeRoot() {
  const listeners = new Map();
  const classes = new Set();
  return {
    innerHTML: '',
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    contains() { return true; },
    listeners,
  };
}

function canonicalHash(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(source).digest('hex');
}

function rawHash(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function loadAdminPage(documentOverride, windowOverride) {
  const window = windowOverride || {};
  const document = documentOverride || {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    window,
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { hash: '#admin/mkv-lab' },
    history: { state: null, replaceState() {} },
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Map,
    Set,
    Promise,
  });
  window.window = window;
  vm.runInContext(adminSource, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

test('MKV lab exposes a bounded fixture corpus with no provider-controlled input', () => {
  const Lab = loadLab();
  const fixtures = Lab.fixtures;
  const serialized = JSON.stringify(fixtures);

  assert.equal(Lab.protocol, 1);
  assert.equal(fixtures.length, 11);
  assert.equal(new Set(fixtures.map((item) => item.id)).size, fixtures.length);
  assert.match(serialized, /h264-closed-aac/);
  assert.match(serialized, /h264-open-gop/);
  assert.match(serialized, /hevc-eac3-cold/);
  assert.match(serialized, /h264-multi-audio/);
  assert.match(serialized, /h264-bad-timestamps/);
  assert.match(serialized, /h264-pgs/);
  assert.match(serialized, /provider-458/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /providerUrl|sourceId|accountKey|credential|token/i);
});

test('automatic strategy matches every declared fixture expectation', () => {
  const Lab = loadLab();
  for (const fixture of Lab.fixtures) {
    const actual = Lab.evaluateFixture(fixture.id, 'auto');
    assert.equal(actual.pipeline, fixture.expected.pipeline, fixture.id);
    assert.equal(actual.reason, fixture.expected.reason, fixture.id);
    assert.equal(actual.expectedUnder10Seconds, fixture.expected.under10, fixture.id);
    assert.ok(actual.providerGets <= 2, fixture.id);
    assert.ok(actual.ffmpegSpawns <= 1, fixture.id);
  }
});

test('fast-path is allowed only for the strict H264 envelope', () => {
  const Lab = loadLab();
  const safe = Lab.evaluateFixture('h264-closed-aac', 'h264-fast');
  const ac3 = Lab.evaluateFixture('h264-closed-ac3', 'audio-only');
  const open = Lab.evaluateFixture('h264-open-gop', 'h264-fast');
  const timestamps = Lab.evaluateFixture('h264-bad-timestamps', 'h264-fast');
  const weakIdentity = Lab.evaluateFixture('h264-no-etag', 'h264-fast');
  const extreme = Lab.evaluateFixture('h264-level52', 'h264-fast');
  const multiAudio = Lab.evaluateFixture('h264-multi-audio', 'h264-fast');
  const hevc = Lab.evaluateFixture('hevc-eac3-cold', 'h264-fast');

  assert.equal(safe.pipeline, 'video-copy-audio-copy');
  assert.equal(safe.targetBufferSeconds, 6);
  assert.equal(safe.providerGets, 2);
  assert.equal(ac3.pipeline, 'video-copy-audio-transcode');
  assert.equal(open.reason, 'open-gop');
  assert.equal(timestamps.reason, 'invalid-timestamps');
  assert.equal(weakIdentity.reason, 'strong-etag-required');
  assert.equal(extreme.reason, 'web-compatibility');
  assert.equal(multiAudio.reason, 'multi-audio');
  assert.equal(hevc.reason, 'video-codec');
  for (const fallback of [open, timestamps, weakIdentity, extreme, multiAudio, hevc]) {
    assert.equal(fallback.pipeline, 'video-transcode');
    assert.equal(fallback.targetBufferSeconds, 6);
    assert.equal(fallback.expectedUnder10Seconds, true);
  }
  const legacy = Lab.evaluateFixture('h264-open-gop', 'legacy');
  assert.equal(legacy.targetBufferSeconds, 96);
  assert.equal(legacy.expectedUnder10Seconds, false);
});

test('full cache hit opens neither provider nor FFmpeg', () => {
  const Lab = loadLab();
  const hit = Lab.evaluateFixture('hevc-full-cache', 'full-cache');
  const miss = Lab.evaluateFixture('hevc-eac3-cold', 'full-cache');

  assert.deepEqual(
    { pipeline: hit.pipeline, providerGets: hit.providerGets, ffmpegSpawns: hit.ffmpegSpawns, target: hit.targetBufferSeconds },
    { pipeline: 'cache-hit', providerGets: 0, ffmpegSpawns: 0, target: 4 },
  );
  assert.equal(miss.pipeline, 'video-transcode');
  assert.equal(miss.reason, 'complete-cache-miss');
  assert.equal(miss.targetBufferSeconds, 6);
  assert.equal(miss.expectedUnder10Seconds, true);
});

test('first HTTP 458 remains terminal for every strategy', () => {
  const Lab = loadLab();
  for (const strategy of Lab.strategies) {
    const result = Lab.evaluateFixture('provider-458', strategy.id);
    assert.equal(result.pipeline, 'terminal-458', strategy.id);
    assert.equal(result.reason, 'provider-busy-terminal', strategy.id);
    assert.equal(result.retriesAfter458, 0, strategy.id);
    assert.equal(result.ffmpegSpawns, 0, strategy.id);
  }
});

test('runtime result projection is allowlisted and bounded', () => {
  const Lab = loadLab();
  const projected = Lab.sanitizeRuntimeResult({
    protocol: 1,
    status: 'pass',
    pipeline: 'video-copy-audio-transcode',
    reason: 'mkv-h264-copy-ready',
    ttffMs: 6300,
    manifestReadyMs: 2200,
    firstSegmentMs: 2800,
    bufferedAheadSeconds: 6.25,
    productionRateX: 3.4,
    browserBufferRateX: 2.7,
    rebufferCount: 0,
    rebufferMs: 0,
    providerGets: 2,
    maximumConcurrentProviderGets: 1,
    ffmpegSpawns: 1,
    analyzerSpawns: 0,
    http458: 0,
    retriesAfter458: 0,
    seekPassed: true,
    audioPassed: true,
    cleanupPassed: true,
    url: 'https://provider.invalid/movie/secret.mkv',
    sourceId: '11111111-1111-4111-8111-111111111111',
    stack: 'secret stack',
    token: 'secret token',
    raw: { credentials: true },
  });

  assert.equal(projected.ttffMs, 6300);
  assert.equal(projected.maximumConcurrentProviderGets, 1);
  assert.deepEqual(
    Object.keys(projected).filter((key) => ['url', 'sourceId', 'stack', 'token', 'raw'].includes(key)),
    [],
  );
  assert.doesNotMatch(JSON.stringify(projected), /provider\.invalid|11111111|secret/i);
  assert.throws(
    () => Lab.sanitizeRuntimeResult({ protocol: 1, status: 'pass', pipeline: 'cache-hit', reason: 'https://leak.invalid' }),
    /INVALID_RUNTIME_RESULT/,
  );
  assert.throws(
    () => Lab.sanitizeRuntimeResult({ protocol: 2, status: 'pass', pipeline: 'cache-hit', reason: 'complete-cache-hit' }),
    /INVALID_RUNTIME_RESULT/,
  );
  assert.throws(
    () => Lab.sanitizeRuntimeResult({ protocol: '1', status: 'pass', pipeline: 'cache-hit', reason: 'complete-cache-hit' }),
    /INVALID_RUNTIME_RESULT/,
  );
  for (const invalidMetrics of [
    { providerGets: 999 },
    { maximumConcurrentProviderGets: -1 },
    { providerGets: 1.9 },
    { providerGets: '0' },
    { ttffMs: Number.NaN },
    { productionRateX: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => Lab.sanitizeRuntimeResult({
        protocol: 1, status: 'pass', pipeline: 'cache-hit', reason: 'complete-cache-hit',
        ...invalidMetrics,
      }),
      /INVALID_RUNTIME_RESULT/,
      JSON.stringify(invalidMetrics),
    );
  }
  assert.equal(
    Lab.sanitizeRuntimeResult({
      protocol: 1, status: 'blocked', pipeline: 'cache-hit', reason: 'runner-busy',
    }).providerGets,
    null,
  );
});

test('runtime boundary rejects every non-corpus fixture before invoking the adapter', async () => {
  const Lab = loadLab();
  let calls = 0;
  let request = null;
  let control = null;
  const runtime = {
    protocol: 1,
    async runCase(receivedRequest, receivedControl) {
      calls += 1;
      request = receivedRequest;
      control = receivedControl;
      return {
        protocol: 1, status: 'blocked', pipeline: 'video-copy-audio-copy', reason: 'runner-busy',
      };
    },
  };
  const lab = new Lab({ runtime });
  const hostile = 'https://provider.invalid/secret.mkv';

  await assert.rejects(lab.runMediaFixture(hostile, new AbortController().signal), /UNKNOWN_LAB_CASE/);
  await assert.rejects(lab.runFixtures([hostile]), /UNKNOWN_LAB_CASE/);
  assert.equal(calls, 0);

  const signal = new AbortController().signal;
  const state = await lab.runMediaFixture('h264-closed-aac', signal);
  assert.equal(state.status, 'blocked');
  assert.deepEqual(Object.keys(request), ['protocol', 'fixtureId']);
  assert.equal(request.fixtureId, 'h264-closed-aac');
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(Object.keys(control), ['signal']);
  assert.equal(control.signal, signal);
  assert.equal(Object.isFrozen(control), true);

  runtime.protocol = '1';
  await assert.rejects(lab.runMediaFixture('h264-closed-aac', signal), /RUNTIME_UNAVAILABLE/);
  assert.equal(calls, 1);
});

test('offline campaign renders explicit simulation state and passes its contract', async () => {
  const Lab = loadLab();
  const lab = new Lab();
  const rootElement = fakeRoot();
  lab.mount(rootElement);

  assert.equal(rootElement.classList.contains('mkv-lab-host'), true);
  assert.match(rootElement.innerHTML, /Laboratoire de démarrage MKV/);
  assert.match(rootElement.innerHTML, /Contrat hors ligne/);
  assert.match(rootElement.innerHTML, /Mesure média verrouillée/);
  assert.match(rootElement.innerHTML, /disabled/);
  assert.doesNotMatch(rootElement.innerHTML, /type="url"|textarea/i);

  await lab.runFixtures(['h264-closed-aac']);

  assert.equal(lab.results.get('h264-closed-aac').status, 'passed');
  assert.match(rootElement.innerHTML, /Validé/);
  assert.match(rootElement.innerHTML, /Copie vidéo \+ audio/);
  lab.unmount();
  assert.equal(rootElement.classList.contains('mkv-lab-host'), false);
});

test('media mode renders allowlisted metrics and fails closed on latency, concurrency or cleanup drift', async () => {
  const Lab = loadLab();
  const base = {
    protocol: 1,
    status: 'pass',
    pipeline: 'video-copy-audio-copy',
    reason: 'mkv-h264-copy-ready',
    ttffMs: 8200,
    manifestReadyMs: 2100,
    firstSegmentMs: 2900,
    bufferedAheadSeconds: 6.2,
    productionRateX: 2.4,
    browserBufferRateX: 1.9,
    rebufferCount: 0,
    rebufferMs: 0,
    providerGets: 2,
    maximumConcurrentProviderGets: 1,
    ffmpegSpawns: 1,
    analyzerSpawns: 0,
    http458: 0,
    retriesAfter458: 0,
    seekPassed: true,
    audioPassed: true,
    cleanupPassed: true,
  };
  const runtime = { protocol: 1, async runCase() { return base; } };
  const lab = new Lab({ runtime });
  const rootElement = fakeRoot();
  lab.mount(rootElement);
  lab.mode = 'media';
  await lab.runFixtures(['h264-closed-aac']);

  assert.equal(lab.results.get('h264-closed-aac').status, 'passed');
  assert.match(rootElement.innerHTML, /Mesures média réelles/);
  assert.match(rootElement.innerHTML, /8200 ms/);
  assert.match(rootElement.innerHTML, /2\.40×/);
  assert.doesNotMatch(rootElement.innerHTML, /providerUrl|sourceId|stack|token/i);

  for (const drift of [
    { ttffMs: 10001 },
    { maximumConcurrentProviderGets: 2 },
    { maximumConcurrentProviderGets: 0 },
    { providerGets: 1 },
    { ffmpegSpawns: 0 },
    { reason: 'legacy-safe-fallback' },
    { seekPassed: false },
    { audioPassed: false },
    { rebufferCount: 1 },
    { rebufferMs: 1 },
    { cleanupPassed: false },
  ]) {
    const failingLab = new Lab({ protocol: 1, runtime: { protocol: 1, async runCase() { return { ...base, ...drift }; } } });
    const state = await failingLab.runMediaFixture('h264-closed-aac', new AbortController().signal);
    assert.equal(state.status, 'failed', JSON.stringify(drift));
    assert.equal(state.reason, 'media-drift', JSON.stringify(drift));
  }
});

test('media cache hit passes only with zero provider and zero FFmpeg work', async () => {
  const Lab = loadLab();
  const baseline = {
    protocol: 1, status: 'pass', pipeline: 'cache-hit', reason: 'complete-cache-hit',
    ttffMs: 2200, providerGets: 0, maximumConcurrentProviderGets: 0,
    ffmpegSpawns: 0, analyzerSpawns: 0, http458: 0, retriesAfter458: 0,
    rebufferCount: 0, rebufferMs: 0, seekPassed: true, audioPassed: true, cleanupPassed: true,
  };
  const run = async (patch) => {
    const lab = new Lab({ runtime: { protocol: 1, async runCase() { return { ...baseline, ...patch }; } } });
    return lab.runMediaFixture('hevc-full-cache', new AbortController().signal);
  };

  assert.equal((await run({})).status, 'passed');
  assert.equal((await run({ providerGets: 1, maximumConcurrentProviderGets: 1 })).status, 'failed');
  assert.equal((await run({ ffmpegSpawns: 1 })).status, 'failed');
});

test('media mode treats one HTTP 458 as a successful terminal fixture with zero retry', async () => {
  const Lab = loadLab();
  const lab = new Lab({
    runtime: {
      protocol: 1,
      async runCase() {
        return {
          protocol: 1, status: 'pass', pipeline: 'terminal-458', reason: 'provider-busy-terminal',
          providerGets: 1, maximumConcurrentProviderGets: 1, ffmpegSpawns: 0, analyzerSpawns: 0,
          http458: 1, retriesAfter458: 0, cleanupPassed: true,
        };
      },
    },
  });
  const state = await lab.runMediaFixture('provider-458', new AbortController().signal);
  assert.equal(state.status, 'passed');
  assert.equal(state.observed.http458, 1);
  assert.equal(state.observed.retriesAfter458, 0);
});

test('runner blocked and cancelled outcomes remain distinct from contract failures', async () => {
  const Lab = loadLab();
  const result = (status, reason) => ({
    protocol: 1,
    status,
    pipeline: 'video-copy-audio-copy',
    reason,
  });
  const blockedLab = new Lab({
    runtime: { protocol: 1, async runCase() { return result('blocked', 'runner-busy'); } },
  });
  const blockedRoot = fakeRoot();
  blockedLab.mount(blockedRoot);
  blockedLab.mode = 'media';
  await blockedLab.runFixtures(['h264-closed-aac']);
  assert.equal(blockedLab.results.get('h264-closed-aac').status, 'blocked');
  assert.match(blockedRoot.innerHTML, /Bloqué/);
  assert.match(blockedRoot.innerHTML, /1 bloqué/);

  let calls = 0;
  const cancelledLab = new Lab({
    runtime: {
      protocol: 1,
      async runCase() {
        calls += 1;
        return result('cancelled', 'operator-cancelled');
      },
    },
  });
  const cancelledRoot = fakeRoot();
  cancelledLab.mount(cancelledRoot);
  cancelledLab.mode = 'media';
  await cancelledLab.runFixtures(['h264-closed-aac', 'h264-closed-ac3']);
  assert.equal(calls, 1);
  assert.equal(cancelledLab.results.get('h264-closed-aac').status, 'cancelled');
  assert.equal(cancelledLab.results.get('h264-closed-ac3').status, 'cancelled');
  assert.match(cancelledRoot.innerHTML, /2 annulés/);
});

test('cancellation is immediate and a stale runtime completion cannot overwrite a remounted campaign', async () => {
  const Lab = loadLab();
  let resolveFirst;
  let calls = 0;
  const observed = {
    protocol: 1, status: 'pass', pipeline: 'video-copy-audio-copy', reason: 'mkv-h264-copy-ready',
    ttffMs: 7000, providerGets: 2, maximumConcurrentProviderGets: 1,
    ffmpegSpawns: 1, analyzerSpawns: 0, http458: 0, retriesAfter458: 0,
    rebufferCount: 0, rebufferMs: 0, seekPassed: true, audioPassed: true, cleanupPassed: true,
  };
  const lab = new Lab({
    runtime: {
      protocol: 1,
      runCase() {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return Promise.resolve(observed);
      },
    },
  });
  const firstRoot = fakeRoot();
  lab.mount(firstRoot);
  lab.mode = 'media';
  const firstRun = lab.runFixtures(['h264-closed-aac']);
  await Promise.resolve();
  assert.equal(typeof resolveFirst, 'function');

  lab.unmount();
  await firstRun;
  assert.equal(lab.results.get('h264-closed-aac').status, 'cancelled');

  const secondRoot = fakeRoot();
  lab.mount(secondRoot);
  lab.mode = 'media';
  await lab.runFixtures(['h264-closed-aac']);
  assert.equal(lab.results.get('h264-closed-aac').status, 'failed');
  assert.equal(calls, 1);

  const drain = lab.runtimeDrainPromise;
  resolveFirst(observed);
  await drain;
  assert.equal(lab.runtimeDrainPromise, null);
  await lab.runFixtures(['h264-closed-aac']);
  assert.equal(lab.results.get('h264-closed-aac').status, 'passed');
  assert.equal(lab.running, false);
});

test('lab stylesheet uses Norva tokens, responsive structure and accessible targets', () => {
  assert.doesNotMatch(cssSource, /#[0-9a-f]{3,8}\b/i);
  assert.match(cssSource, /var\(--color-bg-secondary\)/);
  assert.match(cssSource, /var\(--color-accent-action\)/);
  assert.match(cssSource, /min-height:\s*44px/);
  assert.match(cssSource, /@media \(max-width: 820px\)/);
  assert.match(cssSource, /@media \(max-width: 560px\)/);
  assert.match(cssSource, /prefers-reduced-motion/);
  assert.equal(fs.existsSync(path.join(root, 'public/img/icons/norva-movies.svg')), true);
  assert.match(pageSource, /data-lab-heading tabindex="-1"/);
  assert.doesNotMatch(pageSource, /<main\b/);
  assert.match(pageSource, /mkv-lab__table-wrap" data-lab-scroll="strategies" tabindex="0" role="region"/);
  assert.match(pageSource, /aria-busy="\$\{this\.running\}"/);
  assert.match(pageSource, /<button type="button" class="mkv-lab__fixture/);
  assert.match(cssSource, /mkv-lab__run-state\.is-blocked/);
  assert.match(cssSource, /mkv-lab__run-state\.is-cancelled/);
  assert.match(cssSource, /mkv-lab__fixture:not\(:disabled\):hover/);
});

test('rerenders restore focus to the replacement control and disable fixtures during a run', async () => {
  const Lab = loadLab();
  const lab = new Lab();
  const rootElement = fakeRoot();
  const focused = [];
  rootElement.querySelector = (selector) => ({ focus() { focused.push(selector); } });
  lab.mount(rootElement);

  const fixtureAction = { dataset: { labAction: 'select', fixtureId: 'h264-open-gop' } };
  lab.handleClick({ target: { closest() { return fixtureAction; } } });
  assert.equal(focused.at(-1), '[data-lab-action="select"][data-fixture-id="h264-open-gop"]');

  const running = lab.runFixtures(['h264-open-gop']);
  assert.match(rootElement.innerHTML, /data-lab-action="select"[^>]*disabled/);
  assert.equal(focused.at(-1), '[data-lab-action="cancel"]');
  await running;
  assert.equal(focused.at(-1), '[data-lab-action="run-one"]');
});

test('rerenders preserve the fixture and strategy scroll positions', () => {
  const Lab = loadLab();
  const lab = new Lab();
  const rootElement = fakeRoot();
  const scroll = {
    fixtures: { scrollTop: 145 },
    strategies: { scrollLeft: 280 },
  };
  rootElement.querySelector = (selector) => {
    if (selector === '[data-lab-scroll="fixtures"]') return scroll.fixtures;
    if (selector === '[data-lab-scroll="strategies"]') return scroll.strategies;
    return null;
  };
  lab.mount(rootElement);

  scroll.fixtures.scrollTop = 145;
  scroll.strategies.scrollLeft = 280;
  lab.render();
  assert.equal(scroll.fixtures.scrollTop, 145);
  assert.equal(scroll.strategies.scrollLeft, 280);
});

test('Admin route lazy-loads the exact lab assets and mounts only on the current route', async () => {
  const scriptHash = canonicalHash('public/js/pages/MkvStrategyLabPage.js').slice(0, 10);
  const runtimeHash = canonicalHash('public/js/utils/MkvStrategyLabRuntime.js').slice(0, 10);
  const styleHash = canonicalHash('public/css/mkv-strategy-lab.css').slice(0, 10);
  const adminHash = canonicalHash('public/js/pages/AdminPage.js').slice(0, 10);
  const appHash = rawHash('public/js/app.js').slice(0, 10);
  assert.match(adminSource, new RegExp(`MkvStrategyLabPage\\.js\\?v=${scriptHash}`));
  assert.match(adminSource, new RegExp(`MkvStrategyLabRuntime\\.js\\?v=${runtimeHash}`));
  assert.match(adminSource, new RegExp(`mkv-strategy-lab\\.css\\?v=${styleHash}`));
  assert.match(appSource, new RegExp(`AdminPage\\.js\\?v=${adminHash}`));
  assert.match(appHtmlSource, new RegExp(`app\\.js\\?v=${appHash}`));
  assert.match(adminSource, /'mkv-lab'/);
  assert.match(adminSource, /label: 'Lab VOD'/);
  assert.match(adminSource, /norva-movies\.svg/);

  const view = { innerHTML: '' };
  const mounted = [];
  class FakeLab {
    constructor(options) { this.options = options; }
    mount(target) { mounted.push({ target, options: this.options }); }
  }
  const fakeRuntime = { runCase() {} };
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  Object.assign(page, {
    app: { mkvStrategyLabRuntime: fakeRuntime },
    _nav: 7,
    _route: 'mkv-lab',
    _setCrumb(value) { this.crumb = value; },
    _view() { return view; },
    async _ensureMkvStrategyLabAssets() { return FakeLab; },
  });

  await page._pageMkvStrategyLab();
  assert.equal(page.crumb, 'Lab VOD');
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].target, view);
  assert.equal(mounted[0].options.runtime, fakeRuntime);

  const stale = Object.create(AdminPage.prototype);
  Object.assign(stale, {
    app: { mkvStrategyLabRuntime: fakeRuntime }, _nav: 2, _route: 'mkv-lab',
    _setCrumb() {}, _view() { return view; },
    async _ensureMkvStrategyLabAssets() { this._route = 'systeme'; return FakeLab; },
  });
  await stale._pageMkvStrategyLab();
  assert.equal(mounted.length, 1);

  let releaseAssets;
  const hidden = Object.create(AdminPage.prototype);
  Object.assign(hidden, {
    app: { mkvStrategyLabRuntime: fakeRuntime }, _nav: 3, _route: 'mkv-lab', _isVisible: true,
    _setCrumb() {}, _view() { return view; },
    _ensureMkvStrategyLabAssets() { return new Promise((resolve) => { releaseAssets = () => resolve(FakeLab); }); },
  });
  const pending = hidden._pageMkvStrategyLab();
  hidden._isVisible = false;
  releaseAssets();
  await pending;
  assert.equal(mounted.length, 1);
});

test('Admin lab asset loader removes failed nodes so an operator retry can start cleanly', async () => {
  const elements = [];
  function element(tagName) {
    const listeners = new Map();
    return {
      tagName, dataset: {}, sheet: null, removed: false,
      addEventListener(type, handler) { listeners.set(type, handler); },
      emit(type) { listeners.get(type)?.(); },
      remove() { this.removed = true; },
    };
  }
  const document = {
    getElementById() { return null; },
    querySelector(selector) {
      const kind = selector.startsWith('link') ? 'link' : 'script';
      const asset = selector.includes('mkv-strategy-lab-runtime') ? 'mkv-strategy-lab-runtime' : 'mkv-strategy-lab';
      return elements.find((entry) => entry.tagName === kind && !entry.removed && entry.dataset.norvaAsset === asset) || null;
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return element(tagName); },
    head: { appendChild(entry) { elements.push(entry); } },
  };
  const runtimeWindow = {};
  const AdminPage = loadAdminPage(document, runtimeWindow);
  const page = Object.create(AdminPage.prototype);

  const first = page._ensureMkvStrategyLabAssets();
  const firstLink = elements.find((entry) => entry.tagName === 'link');
  const firstScript = elements.find((entry) => entry.tagName === 'script' && entry.dataset.norvaAsset === 'mkv-strategy-lab');
  const firstRuntimeScript = elements.find((entry) => entry.tagName === 'script' && entry.dataset.norvaAsset === 'mkv-strategy-lab-runtime');
  runtimeWindow.MkvStrategyLabPage = class FakeLab {};
  runtimeWindow.MkvStrategyLabRuntime = class FakeRuntime {};
  firstScript.emit('load');
  firstRuntimeScript.emit('load');
  firstLink.emit('error');
  await assert.rejects(first, /MKV_LAB_STYLES_FAILED/);
  assert.equal(firstLink.removed, true);
  assert.equal(firstScript.removed, false);

  const second = page._ensureMkvStrategyLabAssets();
  const active = elements.filter((entry) => !entry.removed);
  assert.equal(active.length, 3);
  const retryLink = active.find((entry) => entry.tagName === 'link');
  retryLink.sheet = {};
  retryLink.emit('load');
  assert.equal(await second, runtimeWindow.MkvStrategyLabPage);

  retryLink.remove();
  const third = page._ensureMkvStrategyLabAssets();
  const replacementLink = elements.find((entry) => entry.tagName === 'link' && !entry.removed);
  assert.notEqual(replacementLink, retryLink);
  replacementLink.sheet = {};
  replacementLink.emit('load');
  assert.equal(await third, runtimeWindow.MkvStrategyLabPage);
});

test('Admin lab asset loader keeps a ready stylesheet when only the script fails', async () => {
  const elements = [];
  function element(tagName) {
    const listeners = new Map();
    return {
      tagName, dataset: {}, sheet: null, removed: false,
      addEventListener(type, handler) { listeners.set(type, handler); },
      emit(type) { listeners.get(type)?.(); },
      remove() { this.removed = true; },
    };
  }
  const document = {
    getElementById() { return null; },
    querySelector(selector) {
      const kind = selector.startsWith('link') ? 'link' : 'script';
      const asset = selector.includes('mkv-strategy-lab-runtime') ? 'mkv-strategy-lab-runtime' : 'mkv-strategy-lab';
      return elements.find((entry) => entry.tagName === kind && !entry.removed && entry.dataset.norvaAsset === asset) || null;
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return element(tagName); },
    head: { appendChild(entry) { elements.push(entry); } },
  };
  const runtimeWindow = {};
  const AdminPage = loadAdminPage(document, runtimeWindow);
  const page = Object.create(AdminPage.prototype);

  const first = page._ensureMkvStrategyLabAssets();
  const stylesheet = elements.find((entry) => entry.tagName === 'link');
  const failedScript = elements.find((entry) => entry.tagName === 'script' && entry.dataset.norvaAsset === 'mkv-strategy-lab');
  const runtimeScript = elements.find((entry) => entry.tagName === 'script' && entry.dataset.norvaAsset === 'mkv-strategy-lab-runtime');
  stylesheet.sheet = {};
  stylesheet.emit('load');
  runtimeWindow.MkvStrategyLabRuntime = class FakeRuntime {};
  runtimeScript.emit('load');
  failedScript.emit('error');
  await assert.rejects(first, /MKV_LAB_SCRIPT_FAILED/);
  assert.equal(stylesheet.removed, false);
  assert.equal(failedScript.removed, true);

  const second = page._ensureMkvStrategyLabAssets();
  const retryScript = elements.find((entry) => entry.tagName === 'script' && !entry.removed && entry.dataset.norvaAsset === 'mkv-strategy-lab');
  runtimeWindow.MkvStrategyLabPage = class FakeLab {};
  retryScript.emit('load');
  assert.equal(await second, runtimeWindow.MkvStrategyLabPage);
});
