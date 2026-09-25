const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = file => fs.readFileSync(file, 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const listeners = {}, timers = [], intervals = [];
    const document = { visibilityState: 'visible', readyState: 'loading', addEventListener(type, fn) { listeners[type] = fn; } };
    const window = { location: { origin: 'http://localhost', hostname: 'localhost', search: '' },
        addEventListener(type, fn) { listeners[type] = fn; },
        dispatchEvent(event) { listeners[event.type]?.(event); } };
    const context = vm.createContext({ window, document, localStorage: { getItem: () => null },
        URL, URLSearchParams, AbortController, console,
        CustomEvent: class { constructor(type) { this.type = type; } },
        setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { timers[id - 1] = null; },
        setInterval(fn, ms) { intervals.push({ fn, ms }); }, clearInterval() {},
        fetch: async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ success: true }) }) });
    vm.runInContext(read('public/js/api.js'), context);
    const source = read('public/js/app.js');
    vm.runInContext(source.slice(source.indexOf('class App {'), source.indexOf('// Admin dialogs are created')) + '\nwindow.App = App;', context);
    const app = Object.create(window.App.prototype);
    Object.assign(app, { currentUser: { id: 'a' }, currentPage: 'movies', pages: { home: { lastLoadedAt: 123 } } });
    app.installHistoryRefreshListeners();
    return { app, window, context, document, listeners, timers, intervals };
}

test('native-style history save and direct web save both refresh only the current history rail', async () => {
    const h = harness();
    let reads = 0, renders = 0;
    h.app.pages.movies = {
        async loadWatchState(options) { assert.equal(options.fresh, true); reads++; return true; },
        renderContinueWatching() { renders++; }
    };
    for (const save of [() => h.window.API.history.save({ id: '1' }),
        () => h.window.API.request('POST', '/history', { id: '2' })]) {
        await save();
        await h.timers.filter(Boolean).pop()(); await turn();
    }
    assert.equal(reads, 2); assert.equal(renders, 2);
    assert.equal(h.app.pages.home.lastLoadedAt, 0);
    assert.equal(h.intervals[0].ms, 30000);
});

test('history refresh skips hidden pages, playback and signed-out sessions; focus resumes it', async () => {
    const h = harness(); let reads = 0;
    h.app.pages.movies = { loadWatchState: async () => { reads++; return true; }, renderContinueWatching() {} };
    h.document.visibilityState = 'hidden'; await h.app.refreshVisibleHistory();
    h.document.visibilityState = 'visible'; h.app.currentPage = 'watch'; await h.app.refreshVisibleHistory();
    h.app.currentPage = 'movies'; h.app.currentUser = null; await h.app.refreshVisibleHistory();
    assert.equal(reads, 0);
    h.app.currentUser = { id: 'a' }; h.listeners.focus();
    await h.timers.filter(Boolean).pop()(); await turn();
    assert.equal(reads, 1);
});

test('failed history writes do not announce a successful save', async () => {
    const h = harness();
    h.context.fetch = async () => { throw Error('offline'); };
    await assert.rejects(h.window.API.history.save({ id: '1' }), /offline/);
    assert.equal(h.timers.length, 0);
});

for (const name of ['MoviesPage', 'SeriesPage']) {
    test(`${name} discards old requests and profile changes while retaining history on transient failure`, async () => {
        const h = harness(); let profile = 'a'; const pending = [];
        h.window.NorvaCloud = { profiles: { getActiveId: () => profile } };
        h.window.API.history.getAll = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
        vm.runInContext(read(`public/js/pages/${name}.js`), h.context);
        const page = Object.create(h.window[name].prototype);
        Object.assign(page, { sources: [{ id: '1' }], historyItems: [], _watchStateRequestId: 0 });
        const old = page.loadWatchState(), fresh = page.loadWatchState({ fresh: true });
        const row = { item_type: 'movie', source_id: '1', item_id: 'fresh', progress: 20, duration: 100 };
        pending[1].resolve([row]); await fresh; pending[0].resolve([]); await old;
        assert.equal(page.historyItems[0].item_id, 'fresh');
        const failed = page.loadWatchState({ fresh: true }); pending[2].reject(Error('offline')); await failed;
        assert.equal(page.historyItems[0].item_id, 'fresh');
        const switched = page.loadWatchState({ fresh: true }); profile = 'b'; pending[3].resolve([]);
        assert.equal(await switched, false);
        assert.equal(page.historyItems[0].item_id, 'fresh');
    });
}
