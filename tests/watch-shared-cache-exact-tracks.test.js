'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watchSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
  'utf8',
);

function fakeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    style: {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
    textContent: '',
    innerHTML: '',
  };
}

function loadWatchPage() {
  const forbidden = () => { throw new Error('unexpected network operation'); };
  const context = {
    window: { location: { href: 'https://norva.tv/app', protocol: 'https:' } },
    document: {
      getElementById() { return fakeElement(); },
      querySelector() { return fakeElement(); },
      createElement() { return fakeElement(); },
      documentElement: fakeElement(),
      body: fakeElement(),
    },
    navigator: {},
    location: { origin: 'https://norva.tv' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { ...console, log() {}, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    fetch: forbidden,
    API: {},
    MediaUtils: {},
  };
  vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}

test('private cache metadata preserves the exact subtitle contract end-to-end', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const subtitleRenditions = [{ hlsIndex: 0, streamIndex: 7 }];
  const exactSubtitleHls = {
    protocol: 1,
    enabled: true,
    cacheEligible: true,
    reason: 'enabled',
    sourceTrackCount: 1,
    preparedTrackCount: 1,
  };
  const result = page.playbackMetadataFromResult({
    playback: { subtitleRenditions, exactSubtitleHls },
  });
  assert.equal(result.subtitleRenditions, subtitleRenditions);
  assert.equal(result.exactSubtitleHls, exactSubtitleHls);
  assert.equal(page.isExactHlsSubtitleTopology(exactSubtitleHls), true);
  assert.equal(page.isExactHlsSubtitleTopology({ ...exactSubtitleHls, preparedTrackCount: 0 }), false);
  assert.match(watchSource, /subtitleRenditions:\s*playbackMetadata\.subtitleRenditions/);
  assert.match(watchSource, /exactSubtitleHls:\s*playbackMetadata\.exactSubtitleHls/);
});

test('a prior probe preference maps to the immutable HLS source stream index', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const audioTracks = [
    { name: 'English', lang: 'eng', attrs: { 'X-NORVA-STREAM-INDEX': '2' } },
    { name: 'Français', lang: 'fra', attrs: { 'X-NORVA-STREAM-INDEX': '5' } },
  ];
  const subtitleTracks = [
    { name: 'English', lang: 'eng', attrs: { 'X-NORVA-STREAM-INDEX': '4' } },
    { name: 'Français', lang: 'fra', attrs: { 'X-NORVA-STREAM-INDEX': '7' } },
  ];
  Object.assign(page, {
    _privateMediaCacheAccess: { objectKey: 'objects/example' },
    _hlsOwnsExactSubtitles: true,
    _pendingAudioPreferenceApplied: false,
    _pendingSubtitlePreferenceApplied: false,
    pendingPlaybackPreferences: {
      audio: { source: 'probe', streamIndex: 5, language: 'fra' },
      subtitle: { source: 'probe', streamIndex: 7, language: 'fra' },
    },
    hls: {
      audioTracks,
      audioTrack: 0,
      subtitleTracks,
      subtitleTrack: -1,
      subtitleDisplay: false,
    },
    subtitleTracks: [{ index: 7, language: 'fra', extractable: true, subtitleType: 'text', codec: 'ass' }],
    selectedSubtitleStreamIndex: null,
    selectedSubtitleTrackUserChoice: false,
  });

  assert.equal(page.restorePendingAudioPreference(), true);
  assert.equal(page.hls.audioTrack, 1);
  assert.equal(page.restorePendingSubtitlePreference(), true);
  assert.equal(page.hls.subtitleTrack, 1);
  assert.equal(page.hls.subtitleDisplay, true);
  assert.equal(page.selectedSubtitleStreamIndex, null, 'the cached HLS graph owns selection');
  assert.equal(page.hlsTrackSourceStreamIndex(audioTracks[1]), 5);
});

test('exact HLS subtitle rows replace stale probe rows in the captions menu', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const captionsList = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  Object.assign(page, {
    captionsList,
    video: { textTracks: [] },
    hls: {
      subtitleTrack: 1,
      subtitleTracks: [
        { name: 'English', lang: 'eng', attrs: { 'X-NORVA-STREAM-INDEX': '4' } },
        { name: 'Français', lang: 'fra', attrs: { 'X-NORVA-STREAM-INDEX': '7' } },
      ],
    },
    _hlsOwnsExactSubtitles: true,
    subtitleTracks: [
      { index: 99, title: 'Stale probe row', language: 'und', codec: 'subrip', subtitleType: 'text', extractable: true },
    ],
    selectedSubtitleStreamIndex: 99,
    _canRequestAiSubtitles: () => false,
    burnedSubtitleIntel: () => null,
    getOcrableSubtitleTracks: () => [],
    getBurnedSubtitleMessage: () => 'No subtitles',
    getSubtitleStyle: () => ({ scale: 1, bgLabel: 'Dark', colorLabel: 'White' }),
  });

  page.updateCaptionsTracks();
  assert.match(captionsList.innerHTML, /data-source="hls" data-index="0" data-stream-index="4">English/);
  assert.match(captionsList.innerHTML, /data-source="hls" data-index="1" data-stream-index="7">Français/);
  assert.doesNotMatch(captionsList.innerHTML, /Stale probe row|data-source="probe"/);
});

test('cache and exact Gateway playback never attach probe subtitles and enable native HLS text rendering', () => {
  assert.match(
    watchSource,
    /if \(!this\._hlsOwnsExactSubtitles\) \{\s*this\.attachProbeSubtitles\(url, this\.subtitleTracks, startOffset\);\s*\}/,
  );
  assert.match(watchSource, /nativeHlsSubtitles:\s*this\._hlsOwnsExactSubtitles/);
  assert.match(watchSource, /renderTextTracksNatively:\s*options\.nativeHlsSubtitles === true/);
  assert.doesNotMatch(
    watchSource,
    /privateMediaCache[\s\S]{0,250}attachProbeSubtitles\(url, this\.subtitleTracks, startOffset\)/,
  );
});
