'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fixture(type, tv = false) {
    const name = type === 'movie' ? 'Movies' : 'Series';
    const requests = [];
    const paints = [];
    const errors = [];
    const window = { API: {}, GenreRails: { appendCards() {}, render() { paints.push('rails'); } } };
    const sandbox = {
        window,
        console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
        document: { getElementById: () => null },
        IntersectionObserver: class { observe() {} disconnect() {} },
        API: { media: { page(params) {
            const pending = deferred();
            requests.push({ ...pending, params });
            return pending.promise;
        } } },
        MediaUtils: { skeletonCards: () => 'loading', escapeHtml: value => value },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../public/js/pages/${name}Page.js`), 'utf8'), sandbox);
    const page = Object.create(window[`${name}Page`].prototype);
    const dataField = type === 'movie' ? 'movies' : 'seriesList';
    const idField = type === 'movie' ? 'stream_id' : 'series_id';
    Object.assign(page, {
        [dataField]: [], cloudRequestId: 0, cloudLoadingMore: false, isLoading: false,
        cloudOffset: 0, cloudTotal: null, cloudHasMore: false, cloudPageSize: 120,
        currentBatch: 0, batchSize: 24, filteredCards: [], hiddenCategoryIds: new Set(),
        _pendingCloudReset: false, _tvPendingCloudReset: false, selectedSource: 'first',
        container: {
            classList: { remove() {}, add() {} }, innerHTML: '', querySelectorAll: () => [],
            querySelector: () => ({ isConnected: true }), scrollIntoView() {},
        },
        _isTvMode: () => tv,
        currentBucketViewKey() { return this.selectedSource; },
        selectedCloudSourceId() { return this.selectedSource; },
        currentLanguageParams: () => ({}),
        shouldShowRails: () => true,
        catalogCacheKey: () => null,
        cloudPageParams(offset) { return { sourceId: this.selectedSource, offset }; },
        populateGenres() {},
        filterAndRender() { paints.push(Array.from(this[dataField], item => item[idField])); },
        buildFilteredCards() { return this[dataField]; },
        updateResultChrome() {}, renderNextBatch() { paints.push('append'); },
        renderLoadError() { paints.push('error'); },
    });
    return {
        page, requests, paints, errors, sandbox,
        load: options => page[`loadCloud${name}`](options),
        ids: () => Array.from(page[dataField], item => item[idField]),
        payload: id => ({ items: [{ sourceId: 'provider', [idField]: id }], films: 1, offset: 0, count: 1, hasMore: false }),
    };
}

for (const type of ['movie', 'series']) {
    test(`${type}: a source reset during append is replayed once with the latest controls`, async () => {
        const f = fixture(type);
        f.page.cloudOffset = 120;
        const append = f.load({ reset: false });
        f.page.selectedSource = 'second';
        await f.load({ reset: true });
        f.page.selectedSource = 'third';
        await f.load({ reset: true });
        assert.equal(f.requests.length, 1);
        f.requests[0].resolve(f.payload('old-append'));
        await append;
        assert.equal(f.requests.length, 2);
        assert.deepEqual(f.requests[1].params, { sourceId: 'third', offset: 0 });
        assert.deepEqual(f.paints, [], 'old append must never reach the changed grid');
        f.requests[1].resolve(f.payload('current'));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.ids(), ['current']);
        assert.equal(f.page.isLoading, false);
    });

    test(`${type}: an obsolete reset failure cannot replace a successful newer grid`, async () => {
        const f = fixture(type);
        const old = f.load({ reset: true });
        f.page.selectedSource = 'second';
        const current = f.load({ reset: true });
        f.requests[1].resolve(f.payload('current'));
        await current;
        f.requests[0].reject(new Error('old request failed'));
        await old;
        assert.deepEqual(f.ids(), ['current']);
        assert.deepEqual(f.paints, [['current']]);
        assert.deepEqual(f.errors, []);
    });

    test(`${type}: an obsolete completion does not release the newer request loading guard`, async () => {
        const f = fixture(type);
        const old = f.load({ reset: true });
        f.page.selectedSource = 'second';
        const current = f.load({ reset: true });
        f.requests[0].resolve(f.payload('old'));
        await old;
        assert.equal(f.page.isLoading, true);
        await f.load({ reset: false });
        assert.equal(f.requests.length, 2, 'append stays blocked until the active reset finishes');
        f.requests[1].resolve(f.payload('current'));
        await current;
        assert.deepEqual(f.ids(), ['current']);
        assert.equal(f.page.isLoading, false);
    });

    test(`${type}: TV still coalesces repeated searches while the first page is pending`, async () => {
        const f = fixture(type, true);
        const first = f.load({ reset: true });
        f.page.selectedSource = 'second';
        await f.load({ reset: true });
        assert.equal(f.requests.length, 1);
        f.requests[0].resolve(f.payload('old'));
        await first;
        assert.equal(f.requests.length, 2);
        assert.deepEqual(f.paints, []);
        f.requests[1].resolve(f.payload('current'));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.ids(), ['current']);
        assert.equal(f.page.isLoading, false);
    });

    test(`${type}: opening a language bucket retires any flat-grid response or failure`, async () => {
        for (const failing of [false, true]) {
            const f = fixture(type);
            const old = f.load({ reset: true });
            f.page.loadBucketPage = async () => {};
            f.page.openBucket({ title: 'French audio', curation: { bucket: 'all' } });
            const bucketSurface = f.page.container.innerHTML;
            assert.match(bucketSurface, /genre-bucket-grid/);
            if (failing) f.requests[0].reject(new Error('old grid failure'));
            else f.requests[0].resolve(f.payload('old'));
            await old;
            assert.equal(f.page.container.innerHTML, bucketSurface);
            assert.deepEqual(f.paints, []);
            assert.deepEqual(f.errors, []);
        }
    });

    test(`${type}: an obsolete append cannot overwrite rails or release their loading state`, async () => {
        const f = fixture(type);
        const old = f.load({ reset: false });
        const rail = deferred();
        f.sandbox.window.GenreRails.load = () => rail.promise;
        const current = f.page.renderGenreRails();
        f.requests[0].resolve(f.payload('old-append'));
        await old;
        assert.equal(f.page.isLoading, true);
        assert.deepEqual(f.paints, []);
        rail.resolve({ rails: [{ items: [{ id: 'rail-current' }] }] });
        await current;
        assert.deepEqual(f.paints, ['rails']);
        assert.equal(f.page.isLoading, false);
    });

    test(`${type}: a retired append cannot unlock a new source append`, async () => {
        const f = fixture(type);
        const old = f.load({ reset: false });
        f.page._retireCloudGridRequest();
        const current = f.load({ reset: false });
        f.requests[0].resolve(f.payload('old'));
        await old;
        assert.equal(f.page.cloudLoadingMore, true);
        assert.deepEqual(f.paints, []);
        f.requests[1].resolve(f.payload('current'));
        await current;
        assert.equal(f.page.cloudLoadingMore, false);
        assert.deepEqual(f.ids(), ['current']);
    });

    test(`${type}: an obsolete bucket failure cannot stop the new filter pagination`, async () => {
        const f = fixture(type);
        const bucketRequests = [];
        f.sandbox.API.media.genreItems = () => {
            const request = deferred(); bucketRequests.push(request); return request.promise;
        };
        Object.assign(f.page, {
            activeBucket: 'drama', bucketRequestId: 1, bucketLoading: false,
            bucketHasMore: true, bucketOffset: 0, bucketGridEl: { isConnected: true },
            bucketSeen: new Set(),
        });
        const old = f.page.loadBucketPage();
        f.page.bucketRequestId += 1;
        f.page.bucketLoading = false;
        f.page.activeBucket = 'comedy';
        const current = f.page.loadBucketPage();
        bucketRequests[0].reject(new Error('old bucket failed'));
        await old;
        assert.equal(f.page.bucketLoading, true);
        assert.equal(f.page.bucketHasMore, true);
        assert.deepEqual(f.errors, []);
        bucketRequests[1].resolve({ items: [], hasMore: false });
        await current;
        assert.equal(f.page.bucketLoading, false);
        assert.equal(f.page.bucketHasMore, false);
    });
}
