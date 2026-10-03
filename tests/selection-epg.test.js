const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = '../supabase/functions/_shared/selection-epg.mjs';
const window = { windowStartMs: Date.parse('2026-10-03T04:00:00Z'), windowEndMs: Date.parse('2026-10-03T14:00:00Z') };
const rakuten = items => ({ data: { id: 'action-rakuten-tv', numerical_id: 6068, live_programs: items } });
const movie = { title: 'Operator', starts_at: '2026-10-03T07:51:22.000+02:00', ends_at: '2026-10-03T09:28:40.000+02:00' };
const dw = slots => ({ data: { livestreamChannels: [{ id: 35555991, name: 'DW English',
  hlsVideoSrc: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8', nextTimeSlots: slots }] } });
const news = { startDate: '2026-10-03T06:02:00Z', endDate: '2026-10-03T06:15:00Z', program: { name: 'DW News' }, programElement: { name: 'News' } };

test('Rakuten programmes match the exact stream and preserve timezone', async () => {
  const { parseRakutenSelectionEpg } = await import(modulePath);
  const [item] = parseRakutenSelectionEpg(rakuten([movie]), window);
  assert.equal(item.channelId, 'norva-selection:rakuten-action-fr');
  assert.equal(item.start, '2026-10-03T05:51:22.000Z');
  assert.equal(item.stop, '2026-10-03T07:28:40.000Z');
  assert.equal(item.title, 'Operator');
  const wrong = rakuten([movie]); wrong.data.numerical_id = 6479;
  assert.throws(() => parseRakutenSelectionEpg(wrong, window), /identity mismatch/);
});

test('invalid, unzoned, expired, reversed and empty programmes are excluded', async () => {
  const { parseRakutenSelectionEpg } = await import(modulePath);
  const items = [movie, { ...movie, starts_at: '2026-10-03T06:00:00' }, { ...movie, title: '' },
    { ...movie, starts_at: 'invalid' }, { ...movie, ends_at: movie.starts_at },
    { ...movie, starts_at: '2026-10-02T06:00:00Z', ends_at: '2026-10-02T07:00:00Z' }];
  assert.equal(parseRakutenSelectionEpg(rakuten(items), window).length, 1);
});

test('DW only accepts the English feed actually used by Selection', async () => {
  const { parseDwSelectionEpg } = await import(modulePath);
  const [item] = parseDwSelectionEpg(dw([news]), window);
  assert.equal(item.channelId, 'norva-selection:dw-news');
  assert.equal(item.start, news.startDate.replace('Z', '.000Z'));
  const wrong = dw([news]); wrong.data.livestreamChannels[0].hlsVideoSrc = 'https://example.test/spanish.m3u8';
  assert.throws(() => parseDwSelectionEpg(wrong, window), /identity mismatch/);
});

test('requests use complete UTC hours, fixed official endpoints and no account data', async () => {
  const { fetchSelectionEpg } = await import(modulePath);
  const calls = [];
  const result = await fetchSelectionEpg({ ...window, windowStartMs: window.windowStartMs + 123456,
    windowEndMs: window.windowEndMs - 1000, fetchJson: async url => {
      calls.push(new URL(url)); return url.includes('rakuten') ? rakuten([movie]) : dw([news]);
    } });
  const r = calls.find(url => url.hostname === 'gizmo.rakuten.tv');
  assert.equal(r.searchParams.get('epg_starts_at'), '2026-10-03T04:00:00.000Z');
  assert.equal(r.searchParams.get('epg_ends_at'), '2026-10-03T14:00:00.000Z');
  assert.equal(calls.find(url => url.hostname === 'www.dw.com').pathname, '/graph-api/en/livestream/english');
  assert.equal(result.programmes.length, 2);
  assert.equal(result.channels.find(c => c.id === 'norva-selection:al24-news').guideStatus, 'not_provided');
  assert.equal(result.programmes.some(p => p.channelId === 'norva-selection:al24-news'), false);
});

test('one broadcaster failing cannot discard the other guide', async () => {
  const { fetchSelectionEpg } = await import(modulePath);
  const data = await fetchSelectionEpg({ ...window, fetchJson: async url => {
    if (url.includes('rakuten')) throw new Error('simulated timeout');
    return dw([news]);
  } });
  assert.equal(data.programmes.length, 1);
  assert.equal(data.channels.find(c => c.id.endsWith(':dw-news')).guideStatus, 'available');
  assert.equal(data.channels.find(c => c.id.endsWith(':rakuten-action-fr')).guideStatus, 'unavailable');
});

test('invalid windows cause no outbound requests', async () => {
  const { fetchSelectionEpg } = await import(modulePath);
  await assert.rejects(fetchSelectionEpg({ windowStartMs: NaN, windowEndMs: 1, fetchJson: () => assert.fail() }), /Invalid/);
});

test('WebView loads enabled M3U guides and indexes programme IDs for live preview', async () => {
  const calls = [];
  const API = { sources: { getAll: async () => [{ id: 12, type: 'm3u', enabled: true },
    { id: 13, type: 'xtream', enabled: false }, { id: 14, type: 'epg', enabled: true }] },
    proxy: { epg: { get: async id => { calls.push(id); return id === 12
      ? { channels: [{ id: 'norva-selection:dw-news', name: 'DW News' }], programmes: [{
        channelId: 'norva-selection:dw-news', title: 'DW News', start: news.startDate, stop: news.endDate }] }
      : { channels: [], programmes: [] }; } } }, favorites: { getAll: async () => [] } };
  const context = vm.createContext({ window: {}, API, console, Map, Set, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/EpgGuide.js'), 'utf8'), context);
  const guide = Object.create(context.window.EpgGuide.prototype);
  await guide.fetchEpgData();
  assert.deepEqual(calls, [12, 14]);
  assert.equal(guide.channelMap.get('norva-selection:dw-news').name, 'DW News');
  assert.equal(guide.getChannelProgrammes(guide.getEpgChannel('norva-selection:dw-news', '', 12).id)[0].title, 'DW News');
});

test('cloud guide authenticates the exact Selection source and rechecks visibility after fetching', () => {
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-cloud/index.ts'), 'utf8');
  const handler = source.slice(source.indexOf('async function getSourceEpg('), source.indexOf('function parseXmltvWindow('));
  assert.match(handler, /sourceType === "m3u" && sourceConfig.playlistUrl === DISCOVERY_PLAYLIST_URL &&\s+await isDiscoverySourceId\(sourceId, userId\)/);
  assert.ok(handler.indexOf('visibleSourceSnapshot(sourceId, userId, db)') < handler.indexOf('epgCache.get(cacheKey)'));
  const fetchAt = handler.indexOf('await fetchSelectionEpg(');
  const exposeAt = handler.indexOf('return data;', fetchAt);
  assert.match(handler.slice(fetchAt, exposeAt), /await assertVisibleSourceSnapshotCurrent\(sourceId, userId, visibleSource, db\)/);
});

test('the current LiveGuideFusion page fetches and refreshes EPG without retired grid markup', async () => {
  let calls = 0, renders = 0, refresh;
  const API = { sources: { getAll: async () => [{ id: 12, type: 'm3u', enabled: true }] },
    proxy: { epg: { get: async () => { calls++; return { channels: [{ id: 'norva-selection:dw-news', name: 'DW News' }],
      programmes: [{ channelId: 'norva-selection:dw-news', title: 'DW News', start: news.startDate, stop: news.endDate }] }; } } },
    favorites: { getAll: async () => [] } };
  const context = vm.createContext({ window: { app: { liveGuideFusion: { render: () => renders++ } } },
    document: { getElementById: () => null }, API, console, Map, Set, Date,
    setInterval: fn => { refresh = fn; return 1; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/EpgGuide.js'), 'utf8'), context);
  const guide = new context.window.EpgGuide();
  assert.equal(guide.isMounted, false);
  await guide.loadEpg();
  assert.equal(calls, 1);
  assert.equal(renders, 1);
  assert.equal(guide.programmes.length, 1);
  assert.equal(typeof refresh, 'function');
  await refresh();
  assert.equal(calls, 2);
  assert.equal(renders, 2);
});
