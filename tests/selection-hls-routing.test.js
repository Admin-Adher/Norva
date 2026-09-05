const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const api = read('public/js/api.js');
const watch = read('public/js/pages/WatchPage.js');

test('catalogue normalization retains the selected HLS variant container', () => {
  const start = api.indexOf('    function normalizeMediaItem(');
  const end = api.indexOf('    function categoriesFromMediaItems(', start);
  const normalize = vm.runInNewContext(`(${api.slice(start, end).trim()})`, {
    defaultProviderContainerForType: () => 'mp4',
    normalizeCategory: () => ({ category_name: 'Movies' }),
  });
  const item = { item_type: 'movie', external_id: 'vod-1', title: 'Public film',
    default_variant: { container_extension: 'm3u8' } };
  assert.equal(normalize(item, 'owned-source').container_extension, 'm3u8');
  assert.equal(normalize({ ...item, default_variant: null,
    container_extension: 'mkv' }, 'owned-source').container_extension, 'mkv');
  assert.equal(normalize({ item_type: 'movie', external_id: 'old-1' }, 'owned-source').container_extension, 'mp4');
});

for (const sample of [
  { name: 'opaque HLS relay', container: 'm3u8', url: 'https://relay.example.test/relay/opaque-signed-id', hls: true },
  { name: 'ordinary HLS manifest', container: 'mp4', url: 'https://video.example.test/master.m3u8', hls: true },
  { name: 'opaque MP4 relay', container: 'mp4', url: 'https://relay.example.test/relay/opaque-signed-id', hls: false },
]) {
  test(`${sample.name} reaches the correct media engine`, async () => {
    const context = { window: {}, console: { log() {}, warn() {} },
      Hls: { isSupported: () => true },
      API: { settings: { get: async () => ({}) } },
    };
    vm.runInNewContext(watch, context);
    const prototype = context.window.WatchPage.prototype;
    const calls = [];
    const video = { dataset: {}, play: async () => { calls.push('native'); } };
    const state = {
      _playbackAttemptId: 1, containerExtension: sample.container,
      content: { type: 'movie', containerExtension: sample.container }, video,
      isLikelyPlaybackUrl: () => true, isStalePlaybackAttempt: () => false,
      getCloudSafeSettings: value => value,
      resolvePlaybackAudioTracks: () => [],
      playHls: url => { assert.equal(url, sample.url); calls.push('hls'); },
    };
    const page = new Proxy(state, { get(target, key) {
      if (key in target) return target[key];
      if (typeof prototype[key] === 'function') return () => undefined;
      return undefined;
    } });
    await prototype.loadVideo.call(page, sample.url, { mode: 'relay', playbackAttemptId: 1 });
    assert.deepEqual(calls, sample.hls ? ['hls'] : ['native']);
    if (!sample.hls) assert.equal(video.src, sample.url);
  });
}
