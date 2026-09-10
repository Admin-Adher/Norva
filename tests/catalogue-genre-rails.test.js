'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function sandbox() {
    const context = { window: {}, console, Intl, setTimeout, clearTimeout,
        NorvaI18n: { language: 'fr', t: (_key, options) => options.defaultValue },
        document: { documentElement: { lang: 'fr' } } };
    vm.createContext(context);
    vm.runInContext(read('public/js/utils/mediaUtils.js'), context);
    vm.runInContext(read('public/js/utils/GenreRails.js'), context);
    return context;
}

test('source rails cover every nonempty visible genre with bounded scoped reads', async () => {
    const { window } = sandbox();
    const calls = [];
    let active = 0, peak = 0;
    const api = {
        genreRails() { throw new Error('Global candidates cannot serve a selected source'); },
        async genreSummary(params) {
            calls.push(params);
            return { genres: [
                { bucket: 'action', label: 'Action', count: 1200 },
                { bucket: 'drame', label: 'Drama', count: 1400 },
                { bucket: 'autres', label: 'Other', count: 1 },
                { bucket: 'horreur', hidden: true, count: 90 },
                { bucket: 'vide', count: 0 }
            ] };
        },
        async genreItems(params) {
            calls.push(params); peak = Math.max(peak, ++active);
            await new Promise(resolve => setTimeout(resolve, params.bucket === 'action' ? 10 : 1));
            active--;
            return { items: [{ title: params.bucket, sourceId: params.source }], count: 1200, hasMore: true };
        }
    };
    const payload = await window.GenreRails.load(api, { type: 'series', source: 'selected', limit: 12 });
    assert.deepEqual(Array.from(payload.rails, rail => rail.curation.bucket), ['action', 'drame', 'autres']);
    assert.equal(peak, 2);
    assert.equal(calls.length, 4);
    for (const call of calls) { assert.equal(call.source, 'selected'); assert.equal(call.type, 'series'); }
    for (const call of calls.slice(1)) { assert.equal(call.limit, 12); assert.equal(call.offset, 0); }
});

test('all-source rails keep the single materialised request', async () => {
    const { window } = sandbox();
    const expected = { rails: [{ id: 'global' }] };
    assert.equal(await window.GenreRails.load({
        async genreRails(params) { assert.equal(params.type, 'movie'); return expected; }
    }, { type: 'movie', limit: 12 }), expected);
});

test('obsolete source work does not enqueue remaining genre pages', async () => {
    const { window } = sandbox();
    let current = true, requests = 0;
    await window.GenreRails.load({
        async genreSummary() { return { genres: Array.from({ length: 12 }, (_, i) => ({ bucket: String(i), count: 1 })) }; },
        async genreItems() { requests++; current = false; return { items: [] }; }
    }, { source: 'old', type: 'movie', limit: 12 }, () => current);
    assert.equal(requests, 1);
});

for (const pageName of ['MoviesPage', 'SeriesPage']) {
    test(pageName + ' preserves source scope, default rails and filtered/TV grids', () => {
        const context = sandbox();
        vm.runInContext(read('public/js/pages/' + pageName + '.js'), context);
        const page = Object.create(context.window[pageName].prototype);
        Object.assign(page, {
            sourceSelect: { value: '2' }, sources: [{ id: 2, cloudId: '898fe2bc-22fa-4067-ae8a-2f77d5bba6ca' }],
            _isTvMode: () => false, isCloudPagedMode: () => true, hasActiveFilters: () => false
        });
        assert.equal(page.shouldShowRails(), true);
        page.hasActiveFilters = () => true;
        assert.equal(page.shouldShowRails(), false);
        page.hasActiveFilters = () => false; page._isTvMode = () => true;
        assert.equal(page.shouldShowRails(), false);
        page._isTvMode = () => false; page.sources = [];
        assert.equal(page.shouldShowRails(), false, 'unresolved source cannot become all sources');
        page.sourceSelect.value = '';
        assert.equal(page.shouldShowRails(), true);
    });
}

test('rail cards use observed audio before provider tags and preserve accessible language labels', () => {
    const context = sandbox();
    let markup = '';
    const container = { classList: { add() {}, remove() {} }, querySelectorAll: () => [],
        set innerHTML(value) { markup = value; } };
    const base = { title: 'Example', providerAudioLanguages: ['te'], providerAudioLanguageStatus: 'provider_declared' };
    const cases = [
        { item: base, expected: 'télougou' },
        { item: { ...base, providerAudioLanguages: ['es'] }, expected: 'espagnol' },
        { item: { ...base, audioLanguages: ['es'], audioLanguageValidationStatus: 'probed' }, expected: 'Espagnol' },
        { item: { title: 'Unknown', original_language: 'fr' }, expected: 'Language unidentified' },
    ];
    for (const { item, expected } of cases) {
        context.window.GenreRails.render(container, [{ items: [item] }]);
        assert.match(markup, new RegExp('class="home-card-language-badge catalog-language-badge[^\"]*" title="' + expected + '" aria-label="' + expected + '"'));
        assert.doesNotMatch(markup, /language-badge-status|Provider · Unverified/);
    }
});

for (const pageName of ['MoviesPage', 'SeriesPage']) {
    test(pageName + ' preserves genre rails when returning after a cached search', async () => {
        const context = sandbox();
        vm.runInContext(read('public/js/pages/' + pageName + '.js'), context);
        const page = Object.create(context.window[pageName].prototype);
        const calls = [];
        Object.assign(page, {
            container: { scrollTop: 0 }, movies: [{ title: 'Previous search' }],
            seriesList: [{ title: 'Previous search' }], _viewRenderedAt: Date.now() - 300001,
            shouldShowRails: () => true, hasActiveFilters: () => false,
            catalogCacheKey: () => 'default',
            renderGenreRails: async () => calls.push('rails'),
            loadCloudMovies: async () => calls.push('grid'),
            loadCloudSeries: async () => calls.push('grid')
        });
        await page.maybeRevalidate();
        assert.deepEqual(calls, ['rails']);

        for (const state of [
            { container: { scrollTop: 200 } },
            { activeBucket: 'action' },
            { hasActiveFilters: () => true },
            { _viewRenderedAt: Date.now() },
            { isLoading: true }
        ]) {
            calls.length = 0;
            const original = Object.fromEntries(Object.keys(state).map(key => [key, page[key]]));
            Object.assign(page, state);
            await page.maybeRevalidate();
            assert.deepEqual(calls, [], 'Do not replace a scrolled, filtered, loading or warm view');
            Object.assign(page, original);
        }

        page.shouldShowRails = () => false; // TV retains its paged grid.
        await page.maybeRevalidate();
        assert.deepEqual(calls, ['grid']);
    });

    test(pageName + ' cannot paint an obsolete source response over a newer view', async () => {
        const context = sandbox();
        context.MediaUtils = context.window.MediaUtils;
        context.MediaUtils.skeletonCards = () => 'loading';
        context.API = { media: {} };
        vm.runInContext(read('public/js/pages/' + pageName + '.js'), context);
        let complete, painted = false;
        context.window.GenreRails.load = () => new Promise(resolve => { complete = resolve; });
        context.window.GenreRails.render = () => { painted = true; };
        const page = Object.create(context.window[pageName].prototype);
        Object.assign(page, {
            container: { classList: { remove() {} }, innerHTML: '' },
            currentBucketViewKey: () => 'source-a',
            selectedCloudSourceId: () => 'source-a', shouldShowRails: () => true, _isTvMode: () => false
        });
        const loading = page.renderGenreRails();
        assert.equal(page.isLoading, true);
        page.currentBucketViewKey = () => 'source-b';
        page.container.innerHTML = 'new source view';
        complete({ rails: [{ items: [{ title: 'old source' }] }] });
        await loading;
        assert.equal(painted, false);
        assert.equal(page.container.innerHTML, 'new source view');
        assert.equal(page._viewRenderedAt, 0);
        assert.equal(page.isLoading, false);
    });
}
