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
  assert.equal(page.isExactHlsSubtitleTopology({
    ...exactSubtitleHls,
    cacheEligible: false,
    reason: 'enabled-partial',
    sourceTrackCount: 12,
    preparedTrackCount: 8,
  }), true, 'a bounded live cohort is exact even though it is not a complete cache graph');
  assert.equal(page.isExactHlsSubtitleTopology({
    ...exactSubtitleHls,
    cacheEligible: false,
    reason: 'enabled-full-noncacheable',
    sourceTrackCount: 32,
    preparedTrackCount: 32,
  }), true, 'a complete subtitle-heavy playback graph is exact without being cacheable');
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

test('partial exact HLS keeps every exact source row selectable while marking on-demand lanes', () => {
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
    _exactSubtitleHlsTopology: {
      protocol: 1,
      enabled: true,
      cacheEligible: false,
      reason: 'enabled-partial',
      sourceTrackCount: 3,
      preparedTrackCount: 2,
    },
    subtitleTracks: [
      { index: 4, title: 'English', language: 'eng', codec: 'subrip', subtitleType: 'text', extractable: true },
      { index: 7, title: 'Français', language: 'fra', codec: 'subrip', subtitleType: 'text', extractable: true },
      { index: 9, title: 'Español', language: 'spa', codec: 'subrip', subtitleType: 'text', extractable: true },
    ],
    selectedSubtitleStreamIndex: null,
    _canRequestAiSubtitles: () => false,
    burnedSubtitleIntel: () => null,
    getOcrableSubtitleTracks: () => [],
    getBurnedSubtitleMessage: () => 'No subtitles',
    getSubtitleStyle: () => ({ scale: 1, bgLabel: 'Dark', colorLabel: 'White' }),
  });

  page.updateCaptionsTracks();
  assert.match(captionsList.innerHTML, /data-source="hls" data-index="0" data-stream-index="4">English/);
  assert.match(captionsList.innerHTML, /data-source="hls" data-index="1" data-stream-index="7">Français/);
  assert.match(captionsList.innerHTML, /class="captions-option loadable"[^>]+data-source="unprepared-hls"[^>]+data-stream-index="9"[^>]+title="Loads at the current position"[^>]*>Spanish - Español · Load/);
  assert.doesNotMatch(captionsList.innerHTML, /disabled|Unavailable this playback/);
  assert.doesNotMatch(captionsList.innerHTML, /data-source="probe"/);
});

test('a truthful unprepared exact row restarts one bounded lane at the same stream identity', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let restartCalls = 0;
  let restartPreference = null;
  Object.assign(page, {
    video: { textTracks: [], currentTime: 87, readyState: 4 },
    hls: {
      subtitleDisplay: true,
      subtitleTrack: 0,
      subtitleTracks: [
        { name: 'English', attrs: { 'X-NORVA-STREAM-INDEX': '4' } },
      ],
      audioTrack: -1,
      audioTracks: [],
    },
    _hlsOwnsExactSubtitles: true,
    _exactSubtitleHlsTopology: {
      protocol: 1,
      enabled: true,
      cacheEligible: false,
      reason: 'enabled-partial',
      sourceTrackCount: 2,
      preparedTrackCount: 1,
    },
    currentPlaybackMode: 'gateway-session',
    content: {
      id: 'movie-unprepared-subtitle',
      sourceId: 'source-one',
      playbackPreferences: { subtitle: { source: 'hls', streamIndex: 4 } },
    },
    pendingPlaybackPreferences: null,
    selectedSubtitleStreamIndex: null,
    selectedSubtitleTrackUserChoice: true,
    selectedAudioTrackUserChoice: false,
    _pendingSubtitlePreferenceApplied: true,
    _pendingAudioPreferenceApplied: true,
    getExtractableSubtitleTracks() {
      return [
        { index: 4, language: 'eng', title: 'English', extractable: true, subtitleType: 'text', codec: 'subrip' },
        { index: 9, language: 'spa', title: 'Español', extractable: true, subtitleType: 'text', codec: 'subrip' },
      ];
    },
    queueSelectedSubtitleTrackRestart(preference) {
      restartCalls += 1;
      restartPreference = preference;
      return Promise.resolve(true);
    },
    setSubtitleSwitchFeedback() {},
    updateCaptionsTracks() {},
    closeCaptionsMenu() {},
    saveResumeSnapshotThrottled() {},
    saveProgress() {},
  });

  await page.selectCaptionTrack('unprepared-hls', 1, 9);

  assert.equal(restartCalls, 1);
  assert.equal(page.hls.subtitleDisplay, false);
  assert.equal(page.hls.subtitleTrack, -1);
  assert.equal(restartPreference.source, 'probe');
  assert.equal(restartPreference.streamIndex, 9);
  assert.equal(page.video.currentTime, 87);
});

test('an unprepared or stale Gateway subtitle choice cannot mutate or restart active playback', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let restartCalls = 0;
  let feedback = null;
  Object.assign(page, {
    video: { textTracks: [], currentTime: 87, readyState: 4 },
    hls: {
      subtitleDisplay: true,
      subtitleTrack: 0,
      subtitleTracks: [
        { name: 'English', attrs: { 'X-NORVA-STREAM-INDEX': '4' } },
      ],
    },
    _hlsOwnsExactSubtitles: true,
    currentPlaybackMode: 'gateway-session',
    selectedSubtitleStreamIndex: null,
    queueSelectedSubtitleTrackRestart() { restartCalls += 1; },
    setSubtitleSwitchFeedback(state, label) { feedback = { state, label }; },
    updateCaptionsTracks() {},
    getExtractableSubtitleTracks() {
      return [{ index: 9, language: 'spa', title: 'Español', extractable: true, codec: 'subrip' }];
    },
  });

  assert.equal(await page.selectCaptionTrack('probe', 0, 9), false);
  assert.equal(page.hls.subtitleDisplay, true);
  assert.equal(page.hls.subtitleTrack, 0);
  assert.equal(restartCalls, 0);
  assert.deepEqual(feedback, { state: 'deferred', label: 'Spanish - Español' });
});

test('a prepared HLS subtitle switches in place without restarting or moving the movie', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  let restartCalls = 0;
  let savedProgressCalls = 0;
  let feedback = null;
  Object.assign(page, {
    video: { textTracks: [], currentTime: 87, readyState: 4 },
    hls: {
      subtitleDisplay: false,
      subtitleTrack: -1,
      subtitleTracks: [
        { name: 'English', lang: 'eng', attrs: { 'X-NORVA-STREAM-INDEX': '4' } },
        { name: 'Français', lang: 'fra', attrs: { 'X-NORVA-STREAM-INDEX': '7' } },
      ],
      audioTrack: -1,
      audioTracks: [],
    },
    _hlsOwnsExactSubtitles: true,
    currentPlaybackMode: 'gateway-session',
    content: {
      id: 'movie-prepared-subtitle',
      playbackPreferences: { subtitle: { source: 'off', mode: 'off' } },
    },
    pendingPlaybackPreferences: null,
    selectedSubtitleStreamIndex: null,
    selectedSubtitleTrackUserChoice: true,
    selectedAudioTrackUserChoice: false,
    _pendingSubtitlePreferenceApplied: true,
    _pendingAudioPreferenceApplied: true,
    queueSelectedSubtitleTrackRestart() { restartCalls += 1; },
    setSubtitleSwitchFeedback(state, label) { feedback = { state, label }; },
    updateCaptionsTracks() {},
    closeCaptionsMenu() {},
    saveResumeSnapshotThrottled() {},
    saveProgress() { savedProgressCalls += 1; },
  });

  await page.selectCaptionTrack('hls', 1, 7);

  assert.equal(page.hls.subtitleDisplay, true);
  assert.equal(page.hls.subtitleTrack, 1);
  assert.equal(page.video.currentTime, 87);
  assert.equal(restartCalls, 0);
  assert.equal(savedProgressCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.content.playbackPreferences.subtitle)), {
    source: 'hls',
    index: 1,
    streamIndex: 7,
    label: 'Français',
    language: 'fra',
  });
  assert.deepEqual(feedback, { state: 'ready', label: 'Français' });
});

test('pending HLS subtitle restoration waits for the immutable rendition map', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  Object.assign(page, {
    _hlsOwnsExactSubtitles: true,
    _pendingSubtitlePreferenceApplied: false,
    pendingPlaybackPreferences: { subtitle: { source: 'probe', streamIndex: 7, language: 'fra' } },
    subtitleTracks: [{ index: 7, language: 'fra', extractable: true, subtitleType: 'text', codec: 'subrip' }],
    selectedSubtitleStreamIndex: null,
    selectedSubtitleTrackUserChoice: false,
    hls: { subtitleTracks: [], subtitleTrack: -1, subtitleDisplay: false },
  });

  assert.equal(page.restorePendingSubtitlePreference(), false);
  assert.equal(page._pendingSubtitlePreferenceApplied, false);
  assert.equal(page.selectedSubtitleStreamIndex, null);

  page.hls.subtitleTracks = [{ name: 'Français', lang: 'fra', attrs: { 'X-NORVA-STREAM-INDEX': '7' } }];
  assert.equal(page.restorePendingSubtitlePreference(), true);
  assert.equal(page.hls.subtitleTrack, 0);
  assert.equal(page.hls.subtitleDisplay, true);
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
