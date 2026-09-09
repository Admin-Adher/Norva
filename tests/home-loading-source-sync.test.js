'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = file => fs.readFileSync(file, 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const readySource = id => ({ id, enabled: true, sync_status: 'ready', configHint: { lastSync: { total: 12, syncedAt: '2026-09-09' } } });

function syncHarness() {
    const events = [], cleared = [], intervals = [];
    const document = { visibilityState: 'visible', dispatchEvent: event => events.push(event), addEventListener() {} };
    const window = {
        API: { sources: { getAll: async () => [] }, media: { clearCatalogCaches: () => cleared.push('memory') } },
        NorvaCatalogCache: { clearAll: () => cleared.push('disk') }
    };
    const context = vm.createContext({ window, document, AbortController, setTimeout, clearTimeout,
        setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; }, clearInterval() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        console, Date });
    vm.runInContext(read('public/js/utils/sourceHealth.js'), context);
    const source = read('public/js/app.js');
    vm.runInContext(source.slice(source.indexOf('class App {'), source.indexOf('// Admin dialogs are created')) + '\nwindow.App = App;', context);
    const app = Object.create(window.App.prototype);
    Object.assign(app, { currentUser: { id: 'owner-a' }, currentPage: 'home', pages: {},
        hasCloudSession: () => true,
        refreshSourceHealth: async ({ summary }) => { app.sourceHealthSummary = summary; },
        channelList: { clearLiveCatalogCache: async () => cleared.push('live') },
        sourceHealthSummary: window.NorvaSourceHealth.summarize([readySource('a')]) });
    app.startImportWatcher();
    return { app, window, document, events, cleared, intervals };
}

test('an open ready catalogue continues checking every five seconds and a remote deletion is authoritative', async () => {
    const h = syncHarness();
    assert.equal(h.intervals[0].ms, 5000);
    h.window.API.sources.getAll = async options => {
        assert.equal(options.fresh, true);
        assert.ok(options.signal);
        return [];
    };
    await h.app.pollCatalogChanges();
    assert.equal(h.app.sourceHealthSummary.state, 'not_configured');
    assert.deepEqual(h.cleared, ['memory', 'disk', 'live']);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail.remote, true);
    await h.app.pollCatalogChanges();
    assert.equal(h.events.length, 1, 'unchanged snapshots do not rebuild Home');
});

test('source ordering and progress-only changes do not repeatedly rebuild a usable catalogue', async () => {
    const h = syncHarness();
    const a = readySource('a'), b = readySource('b');
    h.app._sourceWatchSignature = h.app.sourceWatchSignature(h.window.NorvaSourceHealth.summarize([a, b]));
    h.window.API.sources.getAll = async () => [b, { ...a, syncProgress: { percent: 91 } }];
    await h.app.pollCatalogChanges();
    assert.equal(h.events.length, 0);
});

test('the first movie page refreshes Home despite a normalized attempt timestamp', async () => {
    const h = syncHarness();
    const source = { id: 'selection', enabled: true, sync_status: 'syncing', last_sync: '2026-09-09T12:00:00Z',
        configHint: { syncProgress: { status: 'syncing', percent: 86 } } };
    h.app._sourceWatchSignature = h.app.sourceWatchSignature(h.window.NorvaSourceHealth.summarize([source]));
    h.window.API.sources.getAll = async () => [{ ...source,
        configHint: { syncProgress: { ...source.configHint.syncProgress, moviesReady: true } } }];
    await h.app.pollCatalogChanges();
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail.remote, true);
    await h.app.pollCatalogChanges();
    assert.equal(h.events.length, 1, 'the same ready page does not repeatedly clear Home');
});

test('removing one source retains the other and invalidates warm browse pages', async () => {
    const h = syncHarness();
    const a = readySource('a'), b = readySource('b');
    h.app._sourceWatchSignature = h.app.sourceWatchSignature(h.window.NorvaSourceHealth.summarize([a, b]));
    h.app.pages.movies = { _viewRenderedAt: 123, cloudRequestId: 7, sources: [a, b] };
    h.window.API.sources.getAll = async () => [b];
    await h.app.pollCatalogChanges();
    assert.equal(h.app.sourceHealthSummary.state, 'ready');
    assert.equal(h.app.sourceHealthSummary.sources[0].source.id, 'b');
    assert.equal(h.app.pages.movies._viewRenderedAt, 0);
    assert.equal(h.app.pages.movies.cloudRequestId, 8);
    assert.equal(h.app.pages.movies.sources.length, 0);
});

test('outages and malformed snapshots never erase the last known catalogue and retries back off', async () => {
    const h = syncHarness();
    h.window.API.sources.getAll = async () => { throw Error('offline'); };
    await h.app.pollCatalogChanges();
    assert.equal(h.app.sourceHealthSummary.state, 'ready');
    assert.ok(h.app._catalogWatchRetryAt > Date.now());
    assert.equal(h.cleared.length, 0);
    h.app._catalogWatchRetryAt = 0;
    h.window.API.sources.getAll = async () => ({ error: 'invalid' });
    await h.app.pollCatalogChanges();
    assert.equal(h.events.length, 0);
});

test('polls skip hidden screens, coalesce overlap and discard a response after account change', async () => {
    const h = syncHarness(), pending = deferred();
    let calls = 0;
    h.window.API.sources.getAll = () => { calls++; return pending.promise; };
    h.document.visibilityState = 'hidden';
    await h.app.pollCatalogChanges();
    assert.equal(calls, 0);
    h.document.visibilityState = 'visible';
    const running = h.app.pollCatalogChanges();
    await h.app.pollCatalogChanges();
    assert.equal(calls, 1);
    h.app.currentUser = { id: 'owner-b' };
    pending.resolve([]);
    await running;
    assert.equal(h.events.length, 0);
});

test('stopping the source watcher cancels its in-flight read', async () => {
    const h = syncHarness(), pending = deferred();
    let signal;
    h.window.API.sources.getAll = options => { signal = options.signal; return pending.promise; };
    const running = h.app.pollCatalogChanges();
    h.app.stopImportWatcher();
    assert.equal(signal.aborted, true);
    pending.resolve([]);
    await running;
    assert.equal(h.events.length, 0);
});

function homeHarness(request, favorites = Promise.resolve()) {
    const paints = [], heroes = [];
    const document = { addEventListener() {}, getElementById: () => null };
    const window = { addEventListener() {}, setTimeout, clearTimeout, API: { request, settings: { get: async () => ({}) } } };
    vm.runInNewContext(read('public/js/pages/HomePage.js') + '\nwindow.HomePage = HomePage;', {
        window, document, AbortController, setTimeout, clearTimeout,
        console: { warn() {}, error() {} }
    });
    const page = new window.HomePage({ refreshSourceHealth: async () => ({ state: 'ready' }) });
    for (const method of ['setHomeLoadingState', 'setContentPreferences', 'renderServiceHealth', 'renderEcosystemCard',
        'clearSetupGate', 'renderImportRibbon', 'renderMyList', 'renderHistory', 'renderHomeLoadError', '_railsErrorNotice']) page[method] = () => {};
    page.shouldShowSetupGate = () => false;
    page.renderFavoriteChannels = () => favorites;
    page.renderCloudRails = data => { paints.push(data); page.railItems = data.rails; };
    page.renderHero = (_, rails) => heroes.push(rails);
    page.displayTitle = item => item.title;
    return { page, paints, heroes };
}
const rail = title => ({ rails: [{ id: title, items: [{ title }] }] });

test('the hero paints before slow history and favorites finish', async () => {
    const history = deferred(), favorites = deferred();
    const h = homeHarness(async (_, path) => path.startsWith('/history') ? history.promise : rail('available'), favorites.promise);
    const loading = h.page.loadDashboardData();
    await turn();
    assert.ok(h.heroes.length > 0);
    history.resolve([]); favorites.resolve();
    await loading;
});

test('a failed primary request cannot win the race against a useful fast rail', async () => {
    const fast = deferred();
    const h = homeHarness(async (_, path) => {
        if (path.startsWith('/home/rails')) throw Error('503');
        if (path.startsWith('/media/genre-rails')) return fast.promise;
        return [];
    });
    const loading = h.page.loadDashboardData();
    await turn();
    fast.resolve(rail('fast movie'));
    await loading;
    assert.equal(h.heroes.length, 1);
    assert.equal(h.paints[0].rails[0].items[0].title, 'fast movie');
});

test('an empty genre materialisation reads media directly without repeating personalized Home', async () => {
    const paths = [];
    const h = homeHarness(async (_, path, body, options) => {
        paths.push(path);
        if (path.startsWith('/home/rails')) throw Error('503');
        if (path.startsWith('/media/genre-rails')) return { rails: [] };
        if (path.startsWith('/channels/recent')) { assert.ok(options.signal); return [{ title: path.includes('movie') ? 'Movie' : 'Series' }]; }
        return [];
    });
    await h.page.loadDashboardData();
    assert.equal(paths.filter(path => path.startsWith('/home/rails')).length, 1);
    assert.equal(paths.filter(path => path.includes('direct=1')).length, 2);
    assert.equal(h.heroes.length, 1);
});

test('an empty live-only Home response waits for the first real fast rail and cannot erase it', async () => {
    const fast = deferred();
    const h = homeHarness(async (_, path) => {
        if (path.startsWith('/home/rails')) return { rails: [], liveOnly: true };
        if (path.startsWith('/media/genre-rails')) return fast.promise;
        return [];
    });
    const loading = h.page.loadDashboardData();
    await turn();
    assert.equal(h.heroes.length, 0);
    fast.resolve(rail('first movie'));
    await loading;
    assert.equal(h.heroes.length, 1);
    assert.equal(h.paints.at(-1).rails[0].items[0].title, 'first movie');
});

test('a late catalogue response cannot repaint after load cancellation', async () => {
    const pending = deferred();
    const h = homeHarness(async (_, path) => path.startsWith('/history') ? [] : pending.promise);
    const loading = h.page.loadDashboardData();
    await turn();
    h.page.cancelPendingLoad();
    pending.resolve(rail('old account'));
    await loading;
    assert.equal(h.paints.length, 0);
});

test('fresh source reads bypass both caches, join subsequent callers and preserve newer responses', async () => {
    const oldRead = deferred();
    let reads = 0;
    const values = new Map([['norva-cloud-token', 'test-token']]);
    const window = { location: { origin: 'https://norva.tv', search: '' } };
    const response = id => ({ ok: true, status: 200,
        headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null },
        json: async () => ({ sources: [{ id }], visibilityEpoch: 'v2.1.1' }) });
    vm.runInNewContext(read('public/js/cloudApi.js'), {
        window, document: { readyState: 'loading', addEventListener() {} },
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
        navigator: { userAgent: 'Mozilla/5.0', language: 'en', languages: ['en'] },
        fetch: async (url, options) => {
            reads++;
            assert.equal(options.cache, 'no-store');
            return reads === 1 ? oldRead.promise : response('new');
        },
        URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
        performance: { now: () => 0 }, console: { log() {}, warn() {}, debug() {}, error() {} }
    });
    const stale = window.NorvaCloud.sources.list();
    await turn();
    const fresh = window.NorvaCloud.sources.list({ fresh: true });
    assert.equal((await fresh).sources[0].id, 'new');
    oldRead.resolve(response('old'));
    await stale;
    assert.equal((await window.NorvaCloud.sources.list()).sources[0].id, 'new');
    assert.equal(reads, 2);
});
