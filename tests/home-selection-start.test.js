'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
    const timers = [], images = [];
    const nodes = { 'home-rails': { innerHTML: '' } };
    const document = { addEventListener() {}, getElementById: id => nodes[id] || null };
    const window = { addEventListener() {}, MediaUtils: { skeletonCards: () => '<i class="skeleton-card"></i>' } };
    const context = vm.createContext({ window, document, console, AbortController,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
        Image: class { constructor() { images.push(this); } } });
    vm.runInContext(fs.readFileSync('public/js/utils/sourceHealth.js', 'utf8'), context);
    vm.runInContext(fs.readFileSync('public/js/pages/HomePage.js', 'utf8') + '\nwindow.HomePage = HomePage;', context);
    const page = new window.HomePage({ currentPage: 'home' });
    return { page, window, nodes, timers, images };
}

const source = { id: 'selection', source_type: 'm3u', enabled: true, sync_status: 'syncing',
    config_hint: { playlistHost: 'norva.tv', syncProgress: { status: 'syncing', percent: 86 } } };

test('Selection opens compact Home immediately without unlocking unprepared categories', () => {
    const h = harness();
    const summary = h.window.NorvaSourceHealth.summarize([source]);
    assert.equal(h.window.NorvaSourceHealth.catalogAvailability(summary).gate, true);
    assert.equal(h.page.shouldShowSetupGate(summary), false);
    const ordinary = h.window.NorvaSourceHealth.summarize([{ ...source, config_hint: { playlistHost: 'provider.example' } }]);
    assert.equal(h.page.shouldShowSetupGate(ordinary), true);
    assert.equal(h.page.shouldShowSetupGate(h.window.NorvaSourceHealth.summarize([])), true);
    assert.equal(h.page.shouldShowSetupGate(h.window.NorvaSourceHealth.summarize([{ ...source, enabled: false }])), true);
});

test('a pending empty Selection shows placeholders and schedules one fresh read, not a live-only success', () => {
    const h = harness();
    h.page.sourceSummary = h.window.NorvaSourceHealth.summarize([source]);
    h.page.renderCloudRails({ rails: [], liveOnly: true });
    h.page.renderCloudRails({ rails: [], liveOnly: true });
    assert.match(h.nodes['home-rails'].innerHTML, /skeleton-card/);
    assert.doesNotMatch(h.nodes['home-rails'].innerHTML, /Live TV is ready|data-open-live|home-state-panel/);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 4000);
    let options;
    h.page.loadDashboardData = value => { options = value; };
    h.timers[0].fn();
    assert.equal(options.skipCache, true);
    assert.equal(options.freshRails, true);
    h.page.schedulePendingCatalogRefresh();
    h.page.app.currentPage = 'movies';
    options = null;
    h.timers[1].fn();
    assert.equal(options, null, 'leaving Home retires the refresh');
});

test('a completed live-only catalogue keeps its normal live entry point', () => {
    const h = harness();
    h.page.sourceSummary = h.window.NorvaSourceHealth.summarize([{ ...source, sync_status: 'ready', config_hint: {} }]);
    h.page.renderCloudRails({ rails: [], liveOnly: true });
    assert.match(h.nodes['home-rails'].innerHTML, /data-open-live/);
    assert.equal(h.timers.length, 0);
});

test('late hero images cannot paint a removed or replaced catalogue', () => {
    const h = harness();
    const layers = [{ style: { opacity: '1' } }, { style: { opacity: '0' } }];
    const hero = { querySelector: () => null, contains: element => layers.includes(element),
        querySelectorAll: selector => selector === '.home-hero-bg' ? layers : [] };
    h.nodes['home-hero'] = hero;
    h.page.resolveImageUrl = url => url;
    h.page._heroSlides = [{ item: { backdrop_url: 'https://example.test/first.jpg' } }];
    h.page.showHeroSlide(0);
    h.page._heroSlides = [{ item: { backdrop_url: 'https://example.test/second.jpg' } }];
    h.images[0].onload();
    assert.equal(layers[1].style.backgroundImage, undefined);
    h.page.showHeroSlide(0);
    h.images[1].onload();
    assert.match(layers[1].style.backgroundImage, /second.jpg/);
    delete h.nodes['home-hero'];
    assert.doesNotThrow(() => h.images[1].onerror());
    h.nodes['home-hero'] = { ...hero, querySelectorAll: () => [] };
    assert.doesNotThrow(() => h.page.showHeroSlide(0));
});
