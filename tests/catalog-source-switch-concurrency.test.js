'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function loadPage(relativePath, className) {
    const context = {
        window: {},
        document: { getElementById: () => null, querySelector: () => null },
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        MediaUtils: { saveFilters() {}, escapeHtml: (value) => String(value) },
        API: { media: { genreSummary: async () => ({ genres: [] }) } },
        MultiSelect: class { getSelected() { return new Set(); } },
        IntersectionObserver: class {}
    };
    vm.runInNewContext(read(relativePath), context, { filename: relativePath });
    return { Page: context.window[className], context };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function sourceChangeFixture(Page) {
    const page = Object.create(Page.prototype);
    const handlers = {};
    page.sourceSelect = {
        value: 'provider-a',
        addEventListener: (name, handler) => { handlers[name] = handler; }
    };
    page._isTvMode = () => false;
    page.applyFiltersToUI = () => {};
    page.restoreSavedCategories = () => {};
    page.persistFilters = () => {};
    page._retireCloudGridRequest = () => {};
    page.loadPlaybackStatuses = async () => {};
    page.loadCategories = async () => {};
    page.isLanguageFilterActive = () => false;
    page.init();
    return { page, change: () => handlers.change() };
}

for (const spec of [
    {
        name: 'MoviesPage',
        file: 'public/js/pages/MoviesPage.js',
        className: 'MoviesPage',
        type: 'movie'
    },
    {
        name: 'SeriesPage',
        file: 'public/js/pages/SeriesPage.js',
        className: 'SeriesPage',
        type: 'series'
    }
]) {
    test(`${spec.name} ignores a stale genre response after a provider switch`, async () => {
        const { Page, context } = loadPage(spec.file, spec.className);
        let selectedSource = 'provider-a';
        const first = deferred();
        const second = deferred();
        const requests = [];
        context.API.media.genreSummary = ({ type, source }) => {
            requests.push({ type, source });
            return requests.length === 1 ? first.promise : second.promise;
        };

        const optionsSeen = [];
        const page = Object.create(Page.prototype);
        page.selectedCloudSourceId = () => selectedSource;
        page.savedFilters = { categories: [] };
        page.categoryMulti = {
            setOptions: (options) => optionsSeen.push(options.map((option) => option.value)),
            getSelected: () => new Set()
        };
        page.restoreSavedCategories = () => {};

        const oldRequest = page.loadCloudCategories();
        selectedSource = 'provider-b';
        const currentRequest = page.loadCloudCategories();

        second.resolve({ genres: [{ bucket: 'current', label: 'Current', count: 1 }] });
        await currentRequest;
        first.resolve({ genres: [{ bucket: 'stale', label: 'Stale', count: 1 }] });
        await oldRequest;

        assert.deepEqual(requests, [
            { type: spec.type, source: 'provider-a' },
            { type: spec.type, source: 'provider-b' }
        ]);
        assert.deepEqual(optionsSeen, [['current']], 'only the selected provider may populate category options');
    });

    test(`${spec.name} loads the selected provider without waiting for cold language facets`, async () => {
        const { Page } = loadPage(spec.file, spec.className);
        const { page, change } = sourceChangeFixture(Page);
        const facets = deferred();
        const calls = [];
        page.populateLanguageFacets = () => facets.promise;
        page.loadMovies = page.loadSeries = async () => { calls.push(page.sourceSelect.value); };

        await change();
        assert.deepEqual(calls, ['provider-a'], 'the catalogue should refresh while language counts remain pending');
        facets.resolve();
    });

    test(`${spec.name} stops an obsolete source-change handler after its categories settle`, async () => {
        const { Page } = loadPage(spec.file, spec.className);
        const { page, change } = sourceChangeFixture(Page);
        const oldCategories = deferred();
        const calls = [];
        page.populateLanguageFacets = async () => {};
        page.loadCategories = () => page.sourceSelect.value === 'provider-a' ? oldCategories.promise : Promise.resolve();
        page.loadMovies = page.loadSeries = async () => { calls.push(page.sourceSelect.value); };

        const firstChange = change();
        page.sourceSelect.value = 'provider-b';
        await change();
        oldCategories.resolve();
        await firstChange;

        assert.deepEqual(calls, ['provider-b'], 'only one refresh should run, for the latest provider');
    });

    test(`${spec.name} retires an old grid append before waiting for provider categories`, async () => {
        const { Page, context } = loadPage(spec.file, spec.className);
        const { page, change } = sourceChangeFixture(Page);
        const categories = deferred();
        const oldPage = deferred();
        const requests = [];
        const paints = [];
        const listKey = spec.type === 'movie' ? 'movies' : 'seriesList';
        const itemKey = spec.type === 'movie' ? 'stream_id' : 'series_id';
        const load = () => spec.type === 'movie'
            ? page.loadCloudMovies({ reset: false })
            : page.loadCloudSeries({ reset: false });
        context.API.media.page = params => { requests.push(params); return oldPage.promise; };
        page._retireCloudGridRequest = Page.prototype._retireCloudGridRequest;
        Object.assign(page, {
            [listKey]: [{ sourceId: 'provider-a', [itemKey]: 'existing' }],
            cloudHasMore: true, cloudLoadingMore: false, isLoading: false,
            cloudOffset: 120, cloudRequestId: 1, filteredCards: [], currentBatch: 0, batchSize: 24,
            hiddenCategoryIds: new Set(),
            observer: { disconnect() {} },
            container: { querySelectorAll: () => [], querySelector: () => ({ style: {} }) },
        });
        page.isCloudPagedMode = () => true;
        page.shouldShowRails = () => false;
        page.cloudPageParams = offset => ({ sourceId: page.sourceSelect.value, offset });
        page.populateGenres = () => paints.push('genres');
        page.buildFilteredCards = () => [];
        page.updateResultChrome = () => paints.push('count');
        page.populateLanguageFacets = async () => {};
        page.loadCategories = () => categories.promise;
        const calls = [];
        page.loadMovies = page.loadSeries = async () => { calls.push(page.sourceSelect.value); };

        const append = load();
        page.sourceSelect.value = 'provider-b';
        const pending = change();
        Page.prototype.renderNextBatch.call(page); // a queued old IntersectionObserver callback
        assert.equal(requests.length, 1, 'an old sentinel cannot request the new source at the old offset');
        assert.deepEqual(calls, []);
        oldPage.resolve({ items: [{ sourceId: 'provider-a', [itemKey]: 'stale' }], hasMore: true, films: 1 });
        await append;
        assert.deepEqual(paints, [], 'the old response cannot repaint while the new categories remain pending');
        assert.equal(page[listKey].length, 1);
        categories.resolve();
        await pending;
        assert.deepEqual(calls, ['provider-b']);
    });

    test(`${spec.name} blocks the old bucket sentinel while new provider categories are pending`, async () => {
        const { Page, context } = loadPage(spec.file, spec.className);
        const { page, change } = sourceChangeFixture(Page);
        const categories = deferred();
        const oldPage = deferred();
        const requests = [];
        context.API.media.genreItems = params => {
            requests.push(params);
            return oldPage.promise;
        };
        page._retireCloudGridRequest = Page.prototype._retireCloudGridRequest;
        Object.assign(page, {
            cloudRequestId: 1, activeBucket: 'drama', bucketRequestId: 1,
            bucketHasMore: true, bucketLoading: false, bucketOffset: 72,
            bucketSeen: new Set(), bucketGridEl: { isConnected: true },
            observer: { disconnect() {} }, bucketObserver: { disconnect() {} },
        });
        page.currentLanguageParams = () => ({ source: page.sourceSelect.value });
        page.shouldShowRails = () => false;
        page.populateLanguageFacets = async () => {};
        page.loadCategories = () => categories.promise;
        const calls = [];
        page.loadMovies = page.loadSeries = async () => { calls.push(page.sourceSelect.value); };

        const append = page.loadBucketPage();
        page.sourceSelect.value = 'provider-b';
        const pending = change();
        oldPage.resolve({ items: [{ id: 'old-title' }], hasMore: true });
        await append;
        // Even if an old observer callback was already queued (or re-observed
        // by the completion of its initial load), it must not query this offset.
        await page.loadBucketPage();
        assert.equal(requests.length, 1);
        assert.equal(page.bucketOffset, 72);
        assert.deepEqual(calls, []);
        categories.resolve();
        await pending;
        assert.deepEqual(calls, ['provider-b']);
    });
}
