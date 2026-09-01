'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watch = fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8');
const cloudApi = fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8');

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
