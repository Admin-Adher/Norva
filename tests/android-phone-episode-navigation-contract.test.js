const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method: ${signature}`);
  const opening = source.indexOf('{', start + signature.length);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated method: ${signature}`);
}

test('phone native episode buttons replace Media3 single-item navigation', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );
  const install = method(player, 'private void installEpisodeNavigationControls()');
  const request = method(player, 'private void requestEpisodeNavigation(String rawDirection)');

  assert.match(install, /R\.id\.exo_prev/);
  assert.match(install, /R\.id\.exo_next/);
  assert.match(install, /norva_player_previous_episode_button/);
  assert.match(install, /norva_player_next_episode_button/);
  assert.match(player, /new LinearLayout\.LayoutParams\(dp\(48\), dp\(48\)\)/);
  assert.match(request, /pendingEpisodeNavigationDirection = direction/);
  assert.match(request, /player\.pause\(\)/);
  assert.match(request, /finish\(\)/);
  assert.doesNotMatch(
    request,
    /setMediaItem|prepareMediaItem|getStreamUrl|previousUrl|nextUrl/,
    'native controls must not preload or swap to an adjacent provider stream',
  );
});

test('manual episode hand-off waits behind the exact session-close ACK', () => {
  const main = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java',
  );
  const result = method(
    main,
    'protected void onActivityResult(int requestCode, int resultCode, Intent data)',
  );
  const continuation = method(main, 'private void continuePlayerResult(Intent data)');
  const persistence = method(main, 'private void persistPlayerResultState(Intent data)');

  assert.match(result, /queuePlaybackSessionClose\([\s\S]*continuePlayerResult\(data\)/);
  assert.match(continuation, /EXTRA_EPISODE_NAVIGATION_DIRECTION/);
  assert.match(continuation, /window\.__norvaNative\.onEpisodeNavigation/);
  assert.doesNotMatch(persistence, /onEpisodeNavigation/);
  assert.ok(
    continuation.indexOf('onEpisodeNavigation') < continuation.indexOf('onEnded'),
    'manual navigation must be consumed before natural-end autoplay',
  );
});

test('WebView transports labels only and resolves the adjacent episode after hand-off', () => {
  const standalone = read('public/js/utils/standalone.js');
  const series = read('public/js/pages/SeriesPage.js');
  const nativeNavigation = method(
    standalone,
    'window.__norvaNative.onEpisodeNavigation = (sourceId, itemType, itemId, direction) =>',
  );
  const seriesNavigation = method(
    series,
    'onNativeEpisodeNavigation(detail = {})',
  );

  assert.match(standalone, /previousTitle: extras\?\.previousTitle \|\| ''/);
  assert.match(standalone, /nextTitle: extras\?\.nextTitle \|\| ''/);
  assert.doesNotMatch(standalone, /previousEpisodeUrl|nextEpisodeUrl/);
  assert.match(nativeNavigation, /direction === 'previous' \|\| direction === 'next'/);
  assert.match(nativeNavigation, /norva-native-episode-navigation/);
  assert.match(seriesNavigation, /this\.app\?\.currentPage !== 'series'/);
  assert.match(seriesNavigation, /String\(el\.dataset\.episodeId\) === String\(detail\.itemId\)/);
  assert.match(seriesNavigation, /detail\.direction === 'previous' \? -1 : 1/);
  assert.match(seriesNavigation, /this\.playEpisode\(target\)/);
  assert.match(series, /previousEpisodeLabel/);
  assert.match(series, /nextEpisodeLabel/);
});

test('Series native hand-off selects the real previous and next episode elements', async () => {
  const source = `${read('public/js/pages/SeriesPage.js')}\n;globalThis.__SeriesPage = SeriesPage;`;
  const context = vm.createContext({ console, window: { addEventListener() {} } });
  vm.runInContext(source, context);
  const SeriesPage = context.__SeriesPage;
  const page = Object.create(SeriesPage.prototype);
  const episodes = ['s3e10', 's4e1', 's4e2'].map((id) => ({
    dataset: { episodeId: id, sourceId: '42' },
  }));
  const played = [];
  page.app = { currentPage: 'series' };
  page.currentSeriesInfo = { episodes: {} };
  page.seasonsContainer = { querySelectorAll: () => episodes };
  page.detailsPanel = { classList: { contains: () => false } };
  page.cancelNextEpisodePrompt = () => {};
  page.playEpisode = async (episode) => { played.push(episode.dataset.episodeId); };

  page.onNativeEpisodeNavigation({
    itemType: 'episode', itemId: 's4e1', sourceId: '42', direction: 'previous',
  });
  await new Promise((resolve) => setImmediate(resolve));
  page.onNativeEpisodeNavigation({
    itemType: 'episode', itemId: 's4e1', sourceId: '42', direction: 'next',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(played, ['s3e10', 's4e2']);
});

test('phone video fills the display by default and persists the viewer override', () => {
  const player = read(
    'clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java',
  );
  const stored = method(player, 'private void applyStoredVideoResizeMode()');
  const setter = method(
    player,
    'private void setVideoResizeMode(int resizeMode, boolean persist, boolean feedback)',
  );
  const controllerSurface = method(player, 'private void styleMedia3ControllerSurface()');
  const edgeToEdge = method(player, 'private void configureEdgeToEdgeWindow()');

  assert.match(stored, /getString\(PREF_VIDEO_RESIZE_MODE, VIDEO_RESIZE_MODE_FILL\)/);
  assert.match(stored, /AspectRatioFrameLayout\.RESIZE_MODE_ZOOM/);
  assert.match(setter, /putString\(PREF_VIDEO_RESIZE_MODE/);
  assert.match(player, /MATCH_PARENT, FrameLayout\.LayoutParams\.MATCH_PARENT/);
  assert.doesNotMatch(player, /playerView\.setPadding\(/);
  assert.match(player, /getInsetsIgnoringVisibility\([\s\S]*navigationBars\(\)/);
  assert.match(controllerSurface, /R\.id\.exo_controls_background/);
  assert.match(controllerSurface, /R\.id\.exo_bottom_bar/);
  assert.match(controllerSurface, /Color\.TRANSPARENT/);
  assert.match(edgeToEdge, /setDecorFitsSystemWindows\(false\)/);
  assert.match(edgeToEdge, /setAttributes\(attributes\)/);
  assert.match(player, /playerView\.setBackgroundColor\(Color\.BLACK\)/);
});
