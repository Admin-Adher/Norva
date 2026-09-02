'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watch = fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8');
const cloudApi = fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');

class FakeHls {
  static Events = {
    MEDIA_ATTACHED: 'media-attached',
    AUDIO_TRACKS_UPDATED: 'audio-tracks-updated',
    AUDIO_TRACK_SWITCHED: 'audio-track-switched',
    SUBTITLE_TRACKS_UPDATED: 'subtitle-tracks-updated',
    SUBTITLE_TRACK_SWITCH: 'subtitle-track-switch',
    MANIFEST_PARSED: 'manifest-parsed',
    ERROR: 'error',
  };

  static ErrorTypes = { MEDIA_ERROR: 'media-error', NETWORK_ERROR: 'network-error' };

  constructor(config) {
    this.config = config;
    this.handlers = new Map();
    this.audioTracks = [];
  }

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data) { return this.handlers.get(event)?.(event, data); }
  loadSource(url) { this.url = url; }
  attachMedia(media) { this.media = media; }
  destroy() {}
  startLoad() {}
  recoverMediaError() {}
  swapAudioCodec() {}
}

function loadWatchPage(cloud = {}) {
  const context = {
    window: {
      NorvaCloud: cloud,
      location: { href: 'https://norva.tv/app#watch' },
    },
    URL,
    Headers,
    Request,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Hls: FakeHls,
  };
  vm.runInNewContext(watch, context, { filename: 'WatchPage.js' });
  return context.window.WatchPage;
}

function cacheContract(overrides = {}) {
  const now = Date.now();
  const objectKey = 'a'.repeat(64);
  return {
    protocol: 1,
    transport: 'private-r2-hls',
    objectKey,
    playlistUrl: `https://cache.norva.tv/v1/hls/${objectKey}/playlist.m3u8`,
    authorization: { scheme: 'Bearer', token: 'mc1.payload.signature' },
    refreshAfter: new Date(now + 30_000).toISOString(),
    ticketExpiresAt: new Date(now + 60_000).toISOString(),
    hardExpiresAt: new Date(now + 3_600_000).toISOString(),
    ...overrides,
  };
}

test('renewal uses the security-sensitive playback edge with no legacy fallback', () => {
  const request = cloudApi.slice(
    cloudApi.indexOf('function playbackMediaCacheTicketRequest'),
    cloudApi.indexOf('// Pull the deepest upstream detail'),
  );
  assert.match(request, /requestToBase\([\s\S]*media-cache-ticket/);
  assert.doesNotMatch(request, /playbackSessionRequest|catch/);
  assert.match(cloudApi, /refreshMediaCacheTicket: \(id, objectKey\) => playbackMediaCacheTicketRequest/);
});

test('Watch forwards and validates the in-memory private cache contract', () => {
  assert.match(watch, /mediaCache: playbackMetadata\.mediaCache \|\| playbackMetadata\.media_cache \|\| null/);
  const normalize = watch.slice(
    watch.indexOf('normalizePrivateMediaCacheAccess'),
    watch.indexOf('clearPrivateMediaCacheAccess'),
  );
  assert.match(normalize, /access\?\.transport !== 'private-r2-hls'/);
  assert.match(normalize, /parsed\.protocol !== 'https:'/);
  assert.match(normalize, /parsed\.search \|\| parsed\.hash/);
  assert.match(normalize, /\/v1\/hls\/\$\{objectKey\}\//);
});

test('HLS attaches the ticket only to the pinned object path', () => {
  const auth = watch.slice(
    watch.indexOf('privateMediaCacheAuthorizationForUrl'),
    watch.indexOf('async handlePlaybackSuperseded'),
  );
  assert.match(auth, /parsed\.origin !== access\.origin/);
  assert.match(auth, /!parsed\.pathname\.startsWith\(access\.pathPrefix\)/);
  assert.match(auth, /return `Bearer \$\{access\.token\}`/);

  const hls = watch.slice(watch.indexOf('const hlsConfig = {'), watch.indexOf('const activeHls = this.hls'));
  assert.match(hls, /xhrSetup[\s\S]*setRequestHeader\('Authorization', authorization\)/);
  assert.match(hls, /fetchSetup[\s\S]*headers\.set\('Authorization', authorization\)/);
  assert.doesNotMatch(hls, /searchParams|[?&]token=/);
});

test('ticket renews proactively and retries an authenticated HLS request', () => {
  const refresh = watch.slice(
    watch.indexOf('schedulePrivateMediaCacheTicketRefresh'),
    watch.indexOf('privateMediaCacheAuthorizationForUrl'),
  );
  assert.match(refresh, /refreshMediaCacheTicket\(access\.sessionId, access\.objectKey\)/);
  assert.match(refresh, /this\.hls\?\.startLoad\(\)/);
  assert.match(watch, /\[401, 403\]\.includes\(responseStatus\)/);
  assert.match(watch, /refreshPrivateMediaCacheTicket\('http-auth'\)/);
  assert.match(watch, /responseStatus >= 400/);
  assert.match(watch, /!\[401, 403\]\.includes\(responseStatus\)/);
});

test('expired ticket renewal falls back to the provider before showing a terminal error', async () => {
  const cloud = {
    token: 'user-token',
    playback: {
      refreshMediaCacheTicket: async () => { throw new Error('worker unavailable'); },
    },
  };
  const WatchPage = loadWatchPage(cloud);
  const page = Object.create(WatchPage.prototype);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  page._privateMediaCacheTicketPromise = null;
  page._privateMediaCacheTicketGeneration = 4;
  page._privateMediaCacheTicketTimer = null;
  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  page._privateMediaCacheAccess.ticketExpiresAtMs = Date.now() - 1;
  page._playbackAttemptId = 12;
  page.isPlaybackSupersededError = () => false;
  page.isStalePlaybackAttempt = () => false;
  const fallbacks = [];
  const errors = [];
  page.fallbackPrivateMediaCacheToProvider = async (...args) => {
    fallbacks.push(args);
    return true;
  };
  page.showPlaybackError = (...args) => { errors.push(args); };

  assert.equal(await page.refreshPrivateMediaCacheTicket('scheduled'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fallbacks, [[12, 'authorization-expired']]);
  assert.deepEqual(errors, []);
});

test('private cache delivery failure bypasses exactly once per authorized cache session', async () => {
  assert.match(api, /mediaCacheReadPolicy:\s*'bypass-once'/);
  assert.match(watch, /privateCacheDeliveryFailure/);
  assert.match(watch, /fallbackPrivateMediaCacheToProvider/);
  assert.match(watch, /mediaCacheReadPolicy:\s*'bypass-once'/);

  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  page._privateMediaCacheTicketPromise = null;
  page._privateMediaCacheTicketGeneration = 1;
  page._privateMediaCacheTicketTimer = null;
  page._privateMediaCacheFallbackSessionIds = new Set();
  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  page.isStalePlaybackAttempt = () => false;
  page.getPlaybackPosition = () => 42.9;
  page.trackPlaybackPosition = () => {};
  page.saveResumeSnapshotThrottled = () => {};
  page.showLoading = () => {};
  page.captureVodPlaybackIdentity = () => ({ sourceId: 'source', itemId: 'item' });
  const restarts = [];
  page.restartCloudGatewayStreamAt = async (...args) => { restarts.push(args); };

  assert.equal(await page.fallbackPrivateMediaCacheToProvider(7, 'delivery-502'), true);
  assert.equal(page.resumeTime, 42);
  assert.equal(page._privateMediaCacheAccess, null);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0][0], 42);
  assert.equal(restarts[0][1].mediaCacheReadPolicy, 'bypass-once');

  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  assert.equal(await page.fallbackPrivateMediaCacheToProvider(7, 'delivery-502'), false);
  assert.ok(page._privateMediaCacheAccess);

  const nextSessionId = '22222222-2222-4222-8222-222222222222';
  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), nextSessionId);
  assert.equal(await page.fallbackPrivateMediaCacheToProvider(7, 'delivery-503'), true);
  assert.equal(restarts.length, 2);
});

test('cache-to-provider range retry preserves the one-shot cache bypass', () => {
  const restartStart = watch.indexOf('async restartCloudGatewayStreamAt');
  const restart = watch.slice(
    restartStart,
    watch.indexOf('\n    async ', restartStart + 1),
  );
  assert.match(restart, /isRangeSeekFailure[\s\S]*restartCloudGatewayStreamAt\(target,[\s\S]*mediaCacheReadPolicy === 'bypass-once'[\s\S]*mediaCacheReadPolicy: 'bypass-once'/);
});

test('fatal private-cache HTTP and transport outages enter the provider fallback path', async () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const sessionId = '33333333-3333-4333-8333-333333333333';
  Object.assign(page, {
    _playbackAttemptId: 21,
    _gatewayAudioRenditionRequired: false,
    _gatewayAudioRenditionStatus: 'absent',
    currentPlaybackMode: 'direct-hls',
    hls: null,
    video: { currentTime: 73.4, canPlayType: () => '', play: async () => {} },
    isGatewayPlaybackUrl: () => false,
    isStalePlaybackAttempt: () => false,
    cancelPendingHlsAudioSwitch() {},
    updateAudioTracks() {},
    updateCaptionsTracks() {},
    restorePendingAudioPreference() {},
    restorePendingSubtitlePreference() {},
    retryGatewaySeekAfterFatalPlayback: () => false,
    canUseLocalProxy: () => false,
    sendPlaybackEvent() {},
    handlePlaybackFailure: async () => {},
    showLoading() {},
    _reattachAiTrackIfActive() {},
  });
  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  const fallbacks = [];
  page.fallbackPrivateMediaCacheToProvider = async (...args) => {
    fallbacks.push(args);
    return true;
  };
  page.playHls(page._privateMediaCacheAccess.playlistUrl, {
    playbackAttemptId: 21,
    privateMediaCache: true,
    autoplay: false,
  });

  page.hls.emit(FakeHls.Events.ERROR, {
    fatal: true,
    type: FakeHls.ErrorTypes.NETWORK_ERROR,
    response: { status: 503 },
    details: 'fragLoadError',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fallbacks, [[21, 'delivery-503']]);

  fallbacks.length = 0;
  page._networkRecoveries = 1;
  page.hls.emit(FakeHls.Events.ERROR, {
    fatal: true,
    type: FakeHls.ErrorTypes.NETWORK_ERROR,
    response: { status: 0 },
    details: 'fragLoadError',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fallbacks, [[21, 'delivery-network']]);
});

test('private cache skips provider probing and is cleared on teardown', () => {
  assert.match(watch, /options\.mode !== 'engine' && !privateMediaCacheAccess/);
  assert.match(watch, /\(isGatewaySessionUrl \|\| privateMediaCacheAccess\)[\s\S]*await this\.probeStreamInfo/);
  const stop = watch.slice(watch.indexOf('stop({ enqueueStoryboard'), watch.indexOf('// === Playback Controls ==='));
  assert.match(stop, /clearPrivateMediaCacheAccess\(\)/);
});

test('runtime authorization never crosses the exact Worker origin and object prefix', () => {
  const WatchPage = loadWatchPage();
  const page = Object.create(WatchPage.prototype);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const normalized = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  assert.ok(normalized);
  page._privateMediaCacheAccess = normalized;

  assert.equal(
    page.privateMediaCacheAuthorizationForUrl(`${normalized.playlistUrl.replace('playlist.m3u8', 'segment-00001.ts')}`),
    'Bearer mc1.payload.signature',
  );
  assert.equal(page.privateMediaCacheAuthorizationForUrl('https://evil.example/v1/hls/' + normalized.objectKey + '/x.ts'), null);
  assert.equal(page.privateMediaCacheAuthorizationForUrl('https://cache.norva.tv/v1/hls/' + 'b'.repeat(64) + '/x.ts'), null);
});

test('runtime renewal atomically replaces the in-memory token and restarts HLS', async () => {
  const renewed = cacheContract({
    authorization: { scheme: 'Bearer', token: 'mc1.renewed.signature' },
    refreshAfter: new Date(Date.now() + 45_000).toISOString(),
    ticketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
  });
  const cloud = {
    token: 'user-token',
    playback: {
      refreshMediaCacheTicket: async () => renewed,
    },
  };
  const WatchPage = loadWatchPage(cloud);
  const page = Object.create(WatchPage.prototype);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  page._privateMediaCacheTicketPromise = null;
  page._privateMediaCacheTicketGeneration = 3;
  page._privateMediaCacheTicketTimer = null;
  page._privateMediaCacheAccess = page.normalizePrivateMediaCacheAccess(cacheContract(), sessionId);
  let scheduled = 0;
  let restarted = 0;
  page.schedulePrivateMediaCacheTicketRefresh = () => { scheduled += 1; };
  page.hls = { startLoad: () => { restarted += 1; } };

  assert.equal(await page.refreshPrivateMediaCacheTicket('http-auth'), true);
  assert.equal(page._privateMediaCacheAccess.token, 'mc1.renewed.signature');
  assert.equal(scheduled, 1);
  assert.equal(restarted, 1);
  assert.equal(page._privateMediaCacheTicketPromise, null);
});
