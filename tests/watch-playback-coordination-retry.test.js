'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/pages/WatchPage.js'), 'utf8').replace(/\r\n/g, '\n');
const edgeErrors = fs.readFileSync(
  path.join(root, 'supabase/functions/_shared/catalog-visibility-response.mjs'),
  'utf8',
).replace(/\r\n/g, '\n');

function loadWatchPage() {
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    Promise,
    AbortController,
  };
  vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}

test('only the two exact HTTP 425 coordination outcomes receive a bounded retry', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const producer = {
    status: 425,
    payload: { details: { code: 'MEDIA_CACHE_PRODUCER_ACTIVE', retryAfterSeconds: 2 } },
  };
  const drain = {
    status: 425,
    payload: { details: { code: 'MEDIA_CACHE_BACKGROUND_DRAINING', retryAfterSeconds: 1 } },
  };

  assert.equal(page.playbackCoordinationRetryDelayMs(producer, 0, 0), 2_000);
  assert.equal(page.playbackCoordinationRetryDelayMs(drain, 0, 0), 1_000);
  assert.equal(page.playbackCoordinationRetryDelayMs(producer, 0, 89_500), 500);
  assert.equal(page.playbackCoordinationRetryDelayMs(producer, 6, 0), null);
  assert.equal(page.playbackCoordinationRetryDelayMs(producer, 0, 90_000), null);
  assert.equal(page.playbackCoordinationRetryDelayMs({ ...producer, status: 458 }, 0, 0), null);
  assert.equal(page.playbackCoordinationRetryDelayMs({
    status: 425,
    payload: { details: { code: 'PROVIDER_ACCOUNT_BUSY', retryAfterSeconds: 1 } },
  }, 0, 0), null);
});

test('coordination wait is cancelled immediately by Back or a newer playback attempt', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = page.waitForPlaybackCoordinationRetry(10_000, controller.signal);
  controller.abort();

  assert.equal(await waiting, false);
  assert.ok(Date.now() - startedAt < 1_000, 'abort must not wait for the retry timer');
});

test('initial playback keeps loading through coordination but terminal failures remain user-driven', () => {
  const start = source.indexOf('async play(content, streamUrl, playback = {})');
  const end = source.indexOf('\n    async ', start + 1);
  const play = source.slice(start, end);
  const resolver = play.indexOf('resolved = await streamUrlResolver({');
  const classify = play.indexOf('this.playbackCoordinationRetryDelayMs(', resolver);
  const wait = play.indexOf('await this.waitForPlaybackCoordinationRetry(', classify);
  const terminal = play.indexOf('this.showPlaybackError(errorText, {', wait);

  assert.ok(resolver >= 0 && classify > resolver && wait > classify && terminal > wait);
  assert.match(play.slice(classify, terminal), /continue;/);
  assert.match(play.slice(terminal, terminal + 260), /allowAutomaticRetry:\s*false/);
  assert.doesNotMatch(play.slice(classify, terminal), /showPlaybackError/);
});

test('public Edge envelope exposes only allowlisted coordination codes and bounded retry hints', async () => {
  assert.match(edgeErrors, /"MEDIA_CACHE_PRODUCER_ACTIVE"/);
  assert.match(edgeErrors, /"MEDIA_CACHE_BACKGROUND_DRAINING"/);
  assert.match(edgeErrors, /publicRetryAfterSeconds\(rawDetails\.retryAfterSeconds\)/);
  assert.match(edgeErrors, /seconds < 1 \|\| seconds > 300/);
  const moduleUrl = pathToFileURL(path.join(
    root,
    'supabase/functions/_shared/catalog-visibility-response.mjs',
  )).href;
  const api = await import(moduleUrl);
  const payload = api.publicEdgeErrorPayload(Object.assign(new Error('still preparing'), {
    details: {
      code: 'MEDIA_CACHE_PRODUCER_ACTIVE',
      retryAfterSeconds: 2,
      providerPassword: 'must-never-leak',
    },
  }), 425);
  assert.deepEqual(payload, {
    error: 'still preparing',
    details: { code: 'MEDIA_CACHE_PRODUCER_ACTIVE', retryAfterSeconds: 2 },
  });
});
