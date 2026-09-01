'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const mediaWindow = {};
new Function('window', read('public/js/utils/mediaUtils.js'))(mediaWindow);

const context = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  MediaUtils: mediaWindow.MediaUtils,
};
vm.runInNewContext(read('public/js/pages/SeriesPage.js'), context, {
  filename: 'public/js/pages/SeriesPage.js',
});

const page = Object.create(context.window.SeriesPage.prototype);
page.currentSeries = {
  series_id: 'promax-3below',
  name: 'MULTI ▎ 3Below: Tales of Arcadia',
  title: '3Below: Tales of Arcadia',
};

test('provider-only Promax episode slugs become semantic fallbacks', () => {
  assert.equal(mediaWindow.MediaUtils.cleanEpisodeReleaseName(
    'NF-3Below-Tales-of-Arcadia-2018-US-S01-E01', 1
  ), 'Episode 1');
  assert.equal(page.cleanEpisodeTitle({
    title: 'NF-3Below-Tales-of-Arcadia-2018-US-S01-E01',
    episode_num: 1,
  }, 1), 'Episode 1');
  assert.equal(page.cleanEpisodeTitle({
    title: 'NF-50-Seconds-The-Fernando-Baez-Sosa-Case-2025-AR-S1E3',
    episode_num: 3,
  }, 1), 'Episode 3');
});

test('real episode titles survive while scene metadata is removed', () => {
  assert.equal(mediaWindow.MediaUtils.cleanEpisodeReleaseName(
    'Any.Series.S02E04.The-Big-Day.1080p.WEBRip.x264', 4
  ), 'The Big Day');
  assert.equal(page.cleanEpisodeTitle({
    title: '3Below.Tales.of.Arcadia.S01E02.Pilot.1080p.WEBRip.x264',
    episode_num: 2,
  }, 1), 'Pilot');
  assert.equal(page.cleanEpisodeTitle({
    title: '3Below-Tales-of-Arcadia-S01-E03-FRENCH-WEBRip',
    episode_num: 3,
  }, 1), 'Episode 3');
  assert.equal(page.cleanEpisodeTitle({ title: 'Mind over Matter', episode_num: 4 }, 1), 'Mind over Matter');
});

test('every episode surface gets one structured display label', () => {
  const format = mediaWindow.MediaUtils.formatEpisodeDisplayLabel;
  assert.equal(format(
    'S1 E1 - NF-Badly-in-Love-2025-JP-S1E1',
    { season: 1, episode: 1 }
  ), 'S1 · E1');
  assert.equal(format('S01E02 - Pilot', { season: '01', episode: '02' }), 'S1 · E2 · Pilot');
  assert.equal(format('Any.Series.S02E04.The-Big-Day.1080p.WEBRip.x264', {
    season: 2, episode: 4
  }), 'S2 · E4 · The Big Day');
});

test('episode rows expose season and episode coordinates to assistive technology', () => {
  const source = read('public/js/pages/SeriesPage.js');
  assert.match(source, /Season \$\{seasonNum\}, episode \$\{episodeNum\}/);
  assert.match(source, /aria-label="\$\{MediaUtils\.escapeHtml\(accessibleTitle\)\}"/);
  assert.match(source, /Season \$\{seasonNum\}, episode \$\{row\.dataset\.episodeNum\}: \$\{te\.name\}/);
});

test('episode metadata is reused in-browser and through the shared cloud cache', () => {
  const cloudApi = read('public/js/cloudApi.js');
  const catalogEdge = read('supabase/functions/norva-catalog/index.ts');
  const migration = read('supabase/migrations/20260705030000_catalog_episode_i18n.sql');

  assert.match(cloudApi, /const TMDB_EPISODES_TTL_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(cloudApi, /tmdb-episodes:\$\{tmdbId\}:\$\{season\}:\$\{lang\}/);
  assert.match(cloudApi, /cachedGet\(\s*cacheKey,\s*TMDB_EPISODES_TTL_MS/);
  assert.match(catalogEdge, /const EPISODE_I18N_TTL_MS = 14 \* 24 \* 3_600_000/);
  assert.match(catalogEdge, /readEpisodeI18n\(tmdbId, seasonNum, lang2\)/);
  assert.match(catalogEdge, /writeEpisodeI18n\(tmdbId, seasonNum, lang2, episodes\)/);
  assert.match(migration, /primary key \(provider_tmdb_id, season, lang\)/);
});

test('series, home, and watch history surfaces share the episode formatter', () => {
  for (const file of [
    'public/js/pages/SeriesPage.js',
    'public/js/pages/HomePage.js',
    'public/js/pages/WatchPage.js',
  ]) {
    assert.match(read(file), /MediaUtils\.formatEpisodeDisplayLabel\(/, file);
  }
  assert.match(read('public/js/pages/SeriesPage.js'), /cleanReleaseName\(h\.data\?\.title/);
});
