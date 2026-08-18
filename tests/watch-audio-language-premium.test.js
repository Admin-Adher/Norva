'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public/js/pages/WatchPage.js'), 'utf8');
const mediaUtilsSource = fs.readFileSync(path.join(ROOT, 'public/js/utils/mediaUtils.js'), 'utf8');

function loadWatchPage() {
  const window = {};
  const context = { window, console, Intl, setTimeout, clearTimeout, Promise, URL };
  vm.runInNewContext(mediaUtilsSource, context, { filename: 'mediaUtils.js' });
  vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
  return { WatchPage: window.WatchPage, window };
}

test('unknown speech never renders a pending placeholder and preserves honest technical detail', () => {
  const { WatchPage } = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.content = { rawTitle: 'ES ▎ Amar', title: 'Amar' };
  page.audioLanguageValidationStatus = 'pending';
  page.audioTracks = [{ index: 1, codec: 'ac3', channels: 6, channelLayout: '5.1(side)' }];

  assert.equal(
    page.getProbeAudioTracks()[0].label,
    'Spanish · Provider label · AC3 · 5.1',
  );
  assert.doesNotMatch(source, /Audio language pending/);

  page.content.rawTitle = 'Amar';
  assert.equal(page.getProbeAudioTracks()[0].label, 'Audio track · AC3 · 5.1');
});

test('an exact embedded tag remains stronger than a provider filename hint', () => {
  const { WatchPage } = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  page.content = { rawTitle: 'ES ▎ Amar', title: 'Amar' };
  page.audioLanguageValidationStatus = 'probed';
  page.audioTracks = [{ index: 1, language: 'fr', codec: 'aac', channels: 2 }];

  assert.equal(page.getProbeAudioTracks()[0].label, 'French · AAC · Stereo');
});

test('a rendered movie records one exact-file Whisper intent and submits it only through the server route', async () => {
  const { WatchPage, window } = loadWatchPage();
  const queued = [];
  window.NorvaCloud = {
    playback: {
      queueLanguageValidation: async body => { queued.push(body); return { protocol: 2, status: 'pending' }; },
    },
  };
  const page = Object.create(WatchPage.prototype);
  page.contentType = 'movie';
  page.content = {
    type: 'movie',
    id: '1014297',
    cloudSourceId: '3eb5999e-117b-4196-aaaf-4304e80a48ff',
  };
  page.audioLanguageValidationStatus = 'pending';
  page.audioTracks = [{ index: 1 }, { index: 2 }];
  page.currentStreamInfo = { audioTracks: [{ index: 2 }, { index: 1 }] };
  page._playbackAttemptId = 7;
  page.isStalePlaybackAttempt = () => false;
  page.getContentAudioTracks = () => [];

  const intent = page.rememberWatchedLanguageValidationIntent(7);
  await page.queueWatchedLanguageValidation(intent);

  assert.deepEqual(JSON.parse(JSON.stringify(queued)), [{
    sourceId: '3eb5999e-117b-4196-aaaf-4304e80a48ff',
    itemType: 'movie',
    itemId: '1014297',
    expectedAudioIndices: [1, 2],
  }]);
  const stopBody = source.slice(source.indexOf('    stop({ enqueueStoryboard'), source.indexOf('\n    // === Playback Controls ==='));
  assert.match(stopBody, /sessionTeardown\.then\(\(\) => this\.queueWatchedLanguageValidation/);
});

test('watched-file Whisper enqueue retries only bounded transient failures', async () => {
  const { WatchPage, window } = loadWatchPage();
  const attempts = [];
  window.NorvaCloud = {
    playback: {
      queueLanguageValidation: async body => {
        attempts.push(body);
        if (attempts.length === 1) {
          const error = new Error('temporary upstream timeout');
          error.status = 500;
          throw error;
        }
        return { protocol: 2, status: 'pending' };
      },
    },
  };
  const page = Object.create(WatchPage.prototype);
  const delays = [];
  page.delayWatchedLanguageValidationRetry = async delayMs => { delays.push(delayMs); };
  const intent = {
    sourceId: '3eb5999e-117b-4196-aaaf-4304e80a48ff',
    itemId: '1014297',
    expectedAudioIndices: [1],
  };

  const result = await page.queueWatchedLanguageValidation(intent);

  assert.equal(result.status, 'pending');
  assert.equal(attempts.length, 2);
  assert.deepEqual(delays, [5000]);
});

test('HTTP 458 remains terminal for watched-file Whisper enqueue', async () => {
  const { WatchPage, window } = loadWatchPage();
  let attempts = 0;
  window.NorvaCloud = {
    playback: {
      queueLanguageValidation: async () => {
        attempts += 1;
        const error = new Error('provider circuit open');
        error.status = 458;
        throw error;
      },
    },
  };
  const page = Object.create(WatchPage.prototype);
  page.delayWatchedLanguageValidationRetry = async () => {
    throw new Error('HTTP 458 must never be retried');
  };
  const intent = {
    sourceId: '3eb5999e-117b-4196-aaaf-4304e80a48ff',
    itemId: '1014297',
    expectedAudioIndices: [1],
  };

  await assert.rejects(() => page.queueWatchedLanguageValidation(intent), /provider circuit open/);
  assert.equal(attempts, 1);
});
