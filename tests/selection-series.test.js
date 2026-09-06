const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const movie = (title, group = 'Movies / Telugu / 2024') => ({ title, tvgId: title, group, logo: '',
  url: 'https://movierulz.babuperumana.workers.dev/proxy?url=https%3A%2F%2Fhls2.vcdnx.com%2Fhls%2FABCDEFGH1234%2Fmanifest&ext=.mp4' });
const playlist = async url => ({ headerDetected: true, truncated: false, response: { ok: true },
  items: url.includes('Babuperumana') ? [movie('1000 Babies Season 1'), movie('1000 Babies Season 2 Part 1', 'Movies / Telugu / 2026'),
    movie('1000 Babies Season 2 Part 2', 'Movies / Telugu / 2026'), movie('3 Roses Season 1 2'), movie('Happiest Season'), movie('Season Of Love Ask Mevsimi')] : [] });

test('numbered seasons become a parent series with actual files, retaining stable playback identities', async () => {
  const { fetchSelectionVod, selectionVodIdentity, selectionVodExternalId } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { items } = await fetchSelectionVod({ fetchPlaylist: playlist });
  const rows = items.map(row => row.fields);
  assert.equal(rows.filter(row => row.item_type === 'series').length, 2);
  assert.equal(rows.filter(row => row.item_type === 'movie').length, 2);
  assert.equal(rows.filter(row => row.item_type === 'episode').length, 4);
  const parent = rows.find(row => row.title === '1000 Babies');
  assert.equal(parent.metadata.year, undefined);
  assert.equal(parent.playback_hint.targetUrl, undefined);
  const files = rows.filter(row => row.parent_external_id === parent.external_id);
  assert.equal(files.length, 3);
  assert.deepEqual(files.map(row => row.metadata.selectionUnit.kind), ['season','part','part']);
  assert.equal(files[0].external_id, selectionVodExternalId(await selectionVodIdentity('babuperumana-vod', movie('1000 Babies Season 1'))));
  assert.deepEqual(rows.find(row => row.title === '3 Roses Season 1 2').metadata.selectionUnit.seasons, [1,2]);
});

function database(rows) {
  return { from(table) {
    assert.equal(table, 'cloud_catalog_visible_media_items');
    let selected = rows;
    const query = {
      select() { return query; }, eq(key, value) { selected = selected.filter(row => row[key] === value); return query; },
      order() { return query; }, limit(n) { selected = selected.slice(0, n); return query; },
      async maybeSingle() { assert.ok(selected.length <= 1); return { data: selected[0] || null, error: null }; },
      then(resolve, reject) { return Promise.resolve({ data: selected, error: null }).then(resolve, reject); }
    };
    return query;
  } };
}

test('series details expose real units without URLs; playback enforces owner, parent and generation', async () => {
  const { fetchSelectionVod, resolveSelectionVodDelivery, shouldUseSelectionVodRelay } = await import('../supabase/functions/_shared/selection-vod.mjs');
  const { loadSelectionSeriesInfo, resolveOwnedSelectionEpisode } = await import('../supabase/functions/_shared/selection-series-info.mjs');
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const sourceId = await discoverySourceId('owner');
  const rows = (await fetchSelectionVod({ fetchPlaylist: playlist })).items.map(({ fields }, index) =>
    ({ ...fields, id: String(index), user_id: 'owner', source_id: sourceId, generation_id: 'current', available: true }));
  const parent = rows.find(row => row.title === '1000 Babies');
  const args = { db: database(rows), userId: 'owner', sourceId, seriesId: parent.external_id, generationId: 'current' };
  const info = await loadSelectionSeriesInfo(args);
  assert.equal(info.episodes[1].length, 1);
  assert.equal(info.episodes[2].length, 2);
  assert.equal(info.episodes[1][0].episode_num, null);
  assert.deepEqual(info.episodes[1][0].providerAudioLanguages, ['te']);
  assert.equal(info.episodes[1][0].providerAudioLanguageStatus, 'provider_declared');
  assert.equal(info.episodes[1][0].audioLanguages, undefined);
  assert.equal(info.episodes[1][0].audioTracks, undefined);
  assert.ok(!JSON.stringify(info).includes('workers.dev'));
  await assert.rejects(loadSelectionSeriesInfo({ ...args, generationId: 'old' }));
  assert.equal(await loadSelectionSeriesInfo({ ...args, userId: 'other' }), null);
  const fileArgs = { ...args, itemId: info.episodes[1][0].id, parentId: parent.external_id };
  const file = await resolveOwnedSelectionEpisode(fileArgs);
  assert.ok(file);
  assert.equal(await resolveOwnedSelectionEpisode({ ...fileArgs, parentId: 'another-series' }), null);
  assert.equal(await resolveOwnedSelectionEpisode({ ...fileArgs, db: database(rows.map(row => row === parent ? { ...row, generation_id: 'old' } : row)) }), null);
  const delivery = await resolveSelectionVodDelivery({ sourceId, expectedSourceId: sourceId, itemType: 'series', itemId: fileArgs.itemId,
    ownedItem: file, targetUrl: file.playback_hint.targetUrl });
  assert.ok(delivery);
  assert.equal(shouldUseSelectionVodRelay({ delivery, targetUrl: file.playback_hint.targetUrl, itemType: 'series', clientMode: 'direct', body: {} }), true);
});

test('selection bundles have honest translated labels and never receive TMDB episode overlays', async () => {
  const context = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('public/js/utils/mediaUtils.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('public/js/pages/SeriesPage.js', 'utf8'), context);
  const page = Object.create(context.window.SeriesPage.prototype);
  const { selectionSeriesUnit } = await import('../supabase/functions/_shared/selection-series.mjs');
  const episode = { id: 'physical-file', selectionUnit: selectionSeriesUnit('3 Roses Season 1 2'), episode_num: null };
  assert.equal(page.cleanEpisodeTitle(episode, '1'), 'Seasons 1–2');
  assert.equal(page.selectionUnitAction({ episode }), 'Play Seasons 1–2');
  const flat = page.flattenEpisodes({ episodes: { 1: [episode] } });
  assert.equal(flat[0].episodeNum, null);
  const part = { selectionUnit: selectionSeriesUnit('Show Season 2 Episode 3 Part 1') };
  assert.equal(page.selectionUnitLabel(part), 'Season 2 · Episode 3 · Part 1');
  page.currentSeriesInfo = { seriesDelivery: 'selection' };
  page.seasonsContainer = {};
  Object.defineProperty(page, 'currentSeries', { get() { throw Error('bundle must not request TMDB episode data'); } });
  await page.enrichSeasonWithTmdb('1');
});

test('the player identifies season bundles by file id and can select and advance between parts', () => {
  const context = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('public/js/utils/mediaUtils.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('public/js/pages/WatchPage.js', 'utf8'), context);
  const page = Object.create(context.window.WatchPage.prototype);
  const a = { id: 'file-a', episode_num: null, selectionUnit: { kind: 'part', seasons: [1], part: 1 } };
  const b = { id: 'file-b', episode_num: null, selectionUnit: { kind: 'part', seasons: [1], part: 2 } };
  const c = { id: 'file-c', episode_num: null, selectionUnit: { kind: 'season', seasons: [2] } };
  page.seriesInfo = { seriesDelivery: 'selection', episodes: { 1: [a, b], 2: [c] } };
  page.content = { id: 'file-a' };
  page.currentSeason = '1'; page.currentEpisode = null;
  assert.equal(page.isCurrentEpisode(a, '1'), true);
  assert.equal(page.isCurrentEpisode(b, '1'), false);
  assert.equal(page.getNextEpisode().id, 'file-b');
  assert.equal(page.getPreviousEpisode(), null);
  page.content.id = 'file-b';
  assert.equal(page.getNextEpisode().id, 'file-c');
  assert.equal(page.getPreviousEpisode().id, 'file-a');
  assert.equal(page.episodePlaybackSubtitle(b, '1'), 'Season 1 · Part 2');

  page.seasonsContainer = { innerHTML: '', querySelectorAll: () => [] };
  page.renderEpisodes();
  assert.doesNotMatch(page.seasonsContainer.innerHTML, /Enull|Eundefined|Episode null|2 episodes/);
  assert.match(page.seasonsContainer.innerHTML, /2 videos/);
  const btn = { dataset: { season: '1', ep: '', episodeId: 'file-b' }, addEventListener(_, fn) { this.click = fn; } };
  page.episodesNavList = { innerHTML: '', querySelectorAll: () => [btn], querySelector: () => null };
  page.closeEpisodesMenu = () => {};
  let selected;
  page.playEpisode = ep => { selected = ep; };
  page.renderEpisodesMenu();
  btn.click();
  assert.equal(selected.id, 'file-b');
  assert.equal(page.episodePlaybackSubtitle({ episode_num: 3, title: 'Arrival' }, 1), 'S1 E3 - Arrival');
});
