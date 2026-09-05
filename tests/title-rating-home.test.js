'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HOME_SOURCE = fs.readFileSync(
    path.join(ROOT, 'public/js/pages/HomePage.js'),
    'utf8'
);
const API_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/api.js'), 'utf8');

function homeHarness({ currentPage = 'home' } = {}) {
    const listeners = new Map();
    const calls = {
        clearRailCache: 0,
        removed: [],
        loads: [],
    };
    const document = {
        addEventListener(type, listener) {
            const group = listeners.get(type) || [];
            group.push(listener);
            listeners.set(type, group);
        },
        getElementById() {
            return null;
        },
    };
    const window = {
        addEventListener() {},
        API: {
            media: {
                clearRailCache() {
                    calls.clearRailCache += 1;
                },
            },
            catalogSignature: () => 1,
        },
        NorvaCatalogCache: {
            remove(key) {
                calls.removed.push(key);
            },
        },
        NorvaCloud: {
            profiles: { getActiveId: () => 'profile-a' },
            contentLanguage: () => 'en',
        },
    };
    window.window = window;

    const context = {
        window,
        document,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    vm.runInNewContext(
        `${HOME_SOURCE}\nwindow.HomePage = HomePage;`,
        context,
        { filename: 'public/js/pages/HomePage.js' }
    );

    const page = new window.HomePage({ currentPage });
    page.lastLoadedAt = 12345;
    page.loadDashboardData = (options) => {
        calls.loads.push(options);
        return Promise.resolve();
    };

    return {
        page,
        calls,
        dispatch(type, detail = {}) {
            for (const listener of listeners.get(type) || []) listener({ type, detail });
        },
    };
}

test('a confirmed title rating invalidates every Home rail cache and forces a visible refetch', () => {
    const { page, calls, dispatch } = homeHarness();

    dispatch('norva:title-rating-changed', { rating: 1, revision: 8 });

    assert.equal(page.lastLoadedAt, 0);
    assert.equal(page._freshRailsPending, true);
    assert.equal(calls.clearRailCache, 1);
    assert.deepEqual(calls.removed, ['home-dashboard:profile-a:en']);
    assert.equal(calls.loads.length, 1);
    assert.equal(calls.loads[0].skipCache, true);
    assert.equal(calls.loads[0].freshRails, true);
});

test('a hidden Home stays invalidated and waits for its next visible load', () => {
    const { page, calls, dispatch } = homeHarness({ currentPage: 'movies' });

    dispatch('norva:title-rating-changed', { rating: -1, revision: 3 });

    assert.equal(page.lastLoadedAt, 0);
    assert.equal(page._freshRailsPending, true);
    assert.equal(calls.clearRailCache, 1);
    assert.equal(calls.removed.length, 1);
    assert.equal(calls.loads.length, 0);
});

test('fresh Home rails bypass the process cache and query-bust the catalogue request', () => {
    assert.match(API_SOURCE, /if \(!freshToken\) \{[\s\S]*homeRailCache\.get\(cacheKey\)/);
    assert.match(API_SOURCE, /\.\.\.\(freshToken \? \{ fresh: freshToken \} : \{\}\)/);
    assert.match(API_SOURCE, /fresh:\s*query\.get\('fresh'\) \|\| ''/);
    assert.match(HOME_SOURCE, /!skipCache && !forceFreshRails && !gatedBefore/);
    assert.match(HOME_SOURCE, /`&fresh=\$\{Date\.now\(\)\}-\$\{generation\}`/);
});

test('Home and genre rail memory caches are isolated by active profile', () => {
    assert.match(
        API_SOURCE,
        /function profileCacheScope\(\)[\s\S]*NorvaCloud\?\.profiles\?\.getActiveId\?\.\(\)/,
    );
    assert.equal(
        (API_SOURCE.match(/profile:\s*profileCacheScope\(\)/g) || []).length,
        2,
        'both personalized Home rails and profile-filtered genre rails must use the profile scope',
    );
});

test('Because You Liked has honest editorial copy, For You hero treatment and no false See all', () => {
    const { page } = homeHarness({ currentPage: 'movies' });
    const rail = {
        id: 'because-you-liked-anchor',
        itemType: 'movie',
        curation: {
            kind: 'because_you_liked',
            anchorTitle: 'Arrival',
        },
    };

    assert.equal(page.railTitle(rail), 'Because You Liked Arrival');
    assert.equal(page.railSubtitle(rail), 'Suggestions inspired by titles you liked');
    assert.equal(page.railSeeAllPage(rail), null);
    assert.match(
        HOME_SOURCE,
        /popular\|because-you-\(\?:watched\|liked\)/
    );
    assert.match(
        HOME_SOURCE,
        /because-you-\(\?:watched\|liked\)[^\n]*return \(?\s*'foryou'/
    );
});

test('fast Home genre rails disambiguate movie and series rows with the same genre', () => {
    const { page } = homeHarness();

    assert.equal(page.railTitle({
        title: 'Action',
        itemType: 'movie',
        curation: { kind: 'genre', genre: 'Action' },
    }), 'Action Movies');
    assert.equal(page.railTitle({
        title: 'Action',
        itemType: 'series',
        curation: { kind: 'genre', genre: 'Action' },
    }), 'Action Series');
    assert.equal(page.railTitle({
        title: 'Action Movies',
        itemType: 'movie',
        curation: { kind: 'genre', genre: 'Action' },
    }), 'Action Movies');
    assert.equal(page.railTitle({
        title: 'Action',
        itemType: 'series',
        curation: { kind: 'genre_bucket', bucket: 'action' },
    }), 'Action Series');
});
