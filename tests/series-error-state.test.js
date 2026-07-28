const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'SeriesPage.js'),
  'utf8'
);

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const context = {
  window: {},
  navigator: { onLine: true },
  document: { getElementById: () => null },
  MediaUtils: { escapeHtml },
  console: { warn() {}, error() {}, log() {} },
  requestAnimationFrame: (callback) => callback(),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.runInNewContext(source, context, { filename: 'SeriesPage.js' });
const SeriesPage = context.window.SeriesPage;

function makePage({ alternate = true } = {}) {
  const page = Object.create(SeriesPage.prototype);
  page.currentSeries = { sourceId: 'source-a', series_id: 'series-7' };
  page.currentSeriesGroup = {
    items: [
      page.currentSeries,
      ...(alternate ? [{ sourceId: 'source-b', series_id: 'series-8' }] : []),
    ],
  };
  page.seasonsContainer = {
    innerHTML: '',
    querySelector: () => null,
  };
  return page;
}

const observedRelayPayload = {
  message: 'IPTV provider request failed',
  upstreamStatus: 429,
  payload: {
    error: 'Relay refused the series-info request',
    details: 'Relay refused the series-info request [object Object] Relay refused the series-info request — {"ok":false,"code":429,"reason":"account_sharing:3cc","version":"3 dragonfly"} IPTV provider request failed',
    account: 'viewer@example.com',
  },
};

test('the exact observed account-sharing payload becomes a safe account-busy state', () => {
  const page = makePage();
  const state = page.getSeriesInfoError(observedRelayPayload);

  assert.equal(state.kind, 'account-busy');
  assert.equal(state.title, 'This TV service is already in use');
  assert.equal(state.action, 'retry');
  assert.equal(state.detail, undefined);
  assert.equal(state.friendly, undefined);

  page.renderSeriesInfoError(state);
  assert.match(page.seasonsContainer.innerHTML, /role="status"/);
  assert.match(page.seasonsContainer.innerHTML, /aria-live="polite"/);
  assert.match(page.seasonsContainer.innerHTML, /data-series-info-action="retry"/);
  assert.match(page.seasonsContainer.innerHTML, /data-series-info-action="versions"/);
  assert.doesNotMatch(
    page.seasonsContainer.innerHTML,
    /429|account_sharing|dragonfly|viewer@example|object Object|\{"ok"|Relay refused|IPTV provider request failed/i
  );
});

test('series error classification covers every editorial state without echoing provider data', () => {
  const page = makePage();
  const cases = [
    [{ payload: { reason: 'UPSTREAM_RATE_LIMIT' }, status: 429 }, 'rate-limited'],
    [{ payload: { code: 'AUTH_EXPIRED', details: 'https://demo:secret@example.test/series/a/b/7' }, status: 401 }, 'authentication'],
    [{ payload: { reason: 'circuit_open', debug: { email: 'ops@example.test' } } }, 'circuit-open'],
    [{ payload: { reason: 'provider_type_not_supported', version: 'private-build-9' } }, 'unsupported'],
    [{ message: 'Relay refused the series-info request', status: 503 }, 'provider-unavailable'],
    [{ payload: { error: {}, details: '[object Object]' } }, 'generic'],
  ];

  for (const [raw, expected] of cases) {
    const state = page.getSeriesInfoError(raw);
    assert.equal(state.kind, expected);
    page.renderSeriesInfoError(state);
    assert.doesNotMatch(
      page.seasonsContainer.innerHTML,
      /401|429|503|AUTH_EXPIRED|circuit_open|provider_type|private-build|ops@example|demo:secret|object Object|Relay refused/i
    );
    assert.match(page.seasonsContainer.innerHTML, /data-series-info-action=/);
  }
});

test('offline takes precedence over a transport payload and recommends one safe retry', () => {
  const page = makePage();
  context.navigator.onLine = false;
  try {
    const state = page.getSeriesInfoError({
      status: 503,
      payload: { details: 'gateway timeout for customer@example.test' },
    });
    assert.equal(state.kind, 'offline');
    assert.equal(state.action, 'retry');
    assert.equal(state.allowVersionChoice, false);

    page.renderSeriesInfoError(state);
    assert.match(page.seasonsContainer.innerHTML, /You&#39;re offline/);
    assert.equal(
      (page.seasonsContainer.innerHTML.match(/data-series-info-action=/g) || []).length,
      1
    );
    assert.doesNotMatch(page.seasonsContainer.innerHTML, /503|gateway|customer@example/i);
  } finally {
    context.navigator.onLine = true;
  }
});

test('unsupported single-version titles return safely to Series', () => {
  const page = makePage({ alternate: false });
  const state = page.getSeriesInfoError({ code: 'UNSUPPORTED_PROVIDER' });

  assert.equal(state.kind, 'unsupported');
  assert.equal(state.action, 'back');
  assert.equal(state.actionLabel, 'Back to Series');
  page.renderSeriesInfoError(state);
  assert.match(page.seasonsContainer.innerHTML, /data-series-info-action="back"/);
  assert.doesNotMatch(page.seasonsContainer.innerHTML, /UNSUPPORTED_PROVIDER/);
});

test('retry keeps the current series and asks the next failure to restore action focus', async () => {
  const page = makePage();
  const calls = [];
  page.showSeriesDetailsV2 = async (...args) => calls.push(args);

  await page.retryCurrentSeriesInfo();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], page.currentSeries);
  assert.equal(calls[0][1], page.currentSeriesGroup);
  assert.equal(calls[0][2].isVersionSwitch, true);
  assert.equal(calls[0][2].manualPick, true);
  assert.equal(calls[0][2].focusStatusAction, true);
});
