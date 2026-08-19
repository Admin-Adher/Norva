'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const home = read('public/js/pages/HomePage.js');
const live = read('public/js/components/LiveGuideFusion.js');
const livePage = read('public/js/pages/LivePage.js');
const channels = read('public/js/components/ChannelList.js');
const movies = read('public/js/pages/MoviesPage.js');
const css = read('public/css/main.css');
const appHtml = read('public/app.html');

test('mobile Home always paints an explicit loading, error or empty state', () => {
  assert.match(home, /class="home-loading-state tv-home-loading-state"/);
  assert.match(home, /state\.setAttribute\('aria-busy', active \? 'true' : 'false'\)/);
  assert.match(home, /class="premium-state premium-state-error" role="alert" data-home-state-panel="error"/);
  assert.match(home, /home-sync-hint home-state-panel" role="status" aria-live="polite"/);
  assert.match(css, /html:not\(\.tv-mode\) #page-home \.home-loading-state\s*\{[\s\S]*?display:\s*grid/);
  assert.match(css, /#home-content\.is-home-loading > :not\(\.home-loading-state\)/);
});

test('mobile Home scroll clearance keeps the ecosystem module above Android navigation', () => {
  assert.match(css, /#page-home\s*\{[\s\S]*?scroll-padding-block-end:/);
  assert.match(css, /#page-home \.dashboard-content\s*\{[\s\S]*?padding-bottom:\s*calc\(32px \+ env\(safe-area-inset-bottom/);
  assert.match(css, /#home-ecosystem\s*\{[\s\S]*?scroll-margin-block-end:\s*calc\(var\(--bottom-nav-h\)/);
});

test('phone Live source selection is a branded accessible sheet, not a native select', () => {
  assert.match(live, /class="live-guide-source-trigger"/);
  assert.doesNotMatch(live, /return `<select class="live-guide-source"/);
  assert.match(live, /overlay\.className = 'modal-overlay active live-source-overlay'/);
  assert.match(live, /sheet\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(live, /list\.setAttribute\('role', 'listbox'\)/);
  assert.match(live, /item\.setAttribute\('role', 'option'\)/);
  assert.match(live, /item\.setAttribute\('aria-selected'/);
  assert.match(live, /element\.inert = true/);
  assert.match(live, /currentTrigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(live, /closeButton\.onclick = \(\) => close\(\)/);
  assert.match(live, /event\.key === 'GoBack'/);
  assert.match(css, /\.live-guide-source-trigger\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(css, /\.live-source-option\s*\{[\s\S]*?min-height:\s*56px/);
});

test('Live reports sanitized loading, source-failure, channel-failure and empty states', () => {
  assert.match(live, /if \(cl\.isLoading\)/);
  assert.match(live, /const sourceFailure = Boolean\(cl\.sourceDiscoveryError\)/);
  assert.match(live, /if \(cl\.loadError\)/);
  assert.match(live, /No channels yet/);
  assert.match(channels, /this\.loadError = 'sources-unavailable'/);
  assert.match(channels, /this\.loadError = 'channels-unavailable'/);
  assert.doesNotMatch(channels, /this\.container\.innerHTML = `[^`]*\$\{err\.message\}/);
  assert.match(livePage, /finally \{\s*livePage\?\.removeAttribute\('aria-busy'\)/);
  assert.match(livePage, /closeSourceSheet\?\.\(\{ restoreFocus: false \}\)/);
});

test('Movie cards and details clean visible titles and never expose a zero rating', () => {
  const context = {
    window: {},
    MediaUtils: {
      cleanReleaseName(value) {
        return String(value).replace(/^\[[^\]]+\]\s*/, '');
      }
    }
  };
  vm.runInNewContext(movies, context);
  const page = Object.create(context.window.MoviesPage.prototype);

  assert.equal(page.cleanMovieTitle('[ Provider ] Premium title'), 'Premium title');
  assert.equal(page.getMovieRatingText({ rating: 0 }), '');
  assert.equal(page.getMovieRatingText({ rating: '0', tmdb: { vote_average: 8.2 } }), '8.2');
  assert.equal(page.getMovieRatingText({ rating: '7.0' }), '7');

  assert.match(movies, /const rating = this\.getMovieRatingText\(movie\)/);
  assert.match(movies, /const displayName = this\.cleanMovieTitle\(/);
  assert.match(movies, /getMovieDisplayTitle\(movie = this\.currentMovie\)/);
  assert.match(movies, /const rating = this\.getMovieRatingText\(displayMovie\)/);
});

test('cache versions publish the changed phone surfaces', () => {
  assert.match(appHtml, /main\.css\?v=116/);
  assert.match(appHtml, /MultiSelect\.js\?v=4/);
  assert.match(appHtml, /ChannelList\.js\?v=49/);
  assert.match(appHtml, /SourceManager\.js\?v=43/);
  assert.match(appHtml, /LiveGuideFusion\.js\?v=29/);
  assert.match(appHtml, /api\.js\?v=84/);
  assert.match(appHtml, /HomePage\.js\?v=63/);
  assert.match(appHtml, /LivePage\.js\?v=9/);
  assert.match(appHtml, /MoviesPage\.js\?v=57/);
  assert.match(appHtml, /SeriesPage\.js\?v=57/);
  assert.match(appHtml, /WatchPage\.js\?v=148/);
});
