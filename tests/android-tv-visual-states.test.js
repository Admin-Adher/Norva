'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const app = read('public/js/app.js');
const css = read('public/css/main.css');
const html = read('public/app.html');
const home = read('public/js/pages/HomePage.js');
const livePage = read('public/js/pages/LivePage.js');
const channelList = read('public/js/components/ChannelList.js');
const liveGuide = read('public/js/components/LiveGuideFusion.js');
const movies = read('public/js/pages/MoviesPage.js');
const series = read('public/js/pages/SeriesPage.js');
const settings = read('public/js/pages/Settings.js');

test('TV boot and route changes always keep a painted state', () => {
  const init = app.indexOf('async init()');
  const firstRoute = app.indexOf('this.navigateTo(initialPage, true)', init);
  const releaseSplash = app.indexOf(
    'requestAnimationFrame(() => this.finishTvLaunchScreen())',
    init
  );

  assert.ok(init >= 0 && firstRoute > init, 'initial route must be painted during boot');
  assert.ok(
    releaseSplash > firstRoute,
    'launch screen must remain until the initial destination has painted'
  );
  assert.match(app, /beginTvRouteTransition\(pageName\)/);
  assert.match(app, /this\._tvRouteFailsafe\s*=\s*window\.setTimeout/);
  assert.match(app, /main\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /if \(!this\._profileGateComplete\)[\s\S]*ensureSelected/);
  assert.equal(
    (app.match(/NorvaProfiles\.ensureSelected/g) || []).length,
    1,
    'ordinary SPA navigation must not reopen the profile gate'
  );
  assert.match(css, /html\.tv-mode \.tv-route-stage\s*\{/);
  assert.match(css, /\.tv-route-stage\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('Home exposes full-size loading, recoverable error and non-zero skeleton cards', () => {
  assert.match(home, /id="home-loading-state"[\s\S]*role="status"/);
  assert.match(home, /classList\.toggle\('is-home-loading', active\)/);
  assert.match(home, /class="premium-state premium-state-error" role="alert"/);
  assert.match(home, /data-home-retry/);
  assert.match(css, /#home-content\.is-home-loading > :not\(\.tv-home-loading-state\)/);
  assert.match(
    css,
    /\.tv-home-loading-visual > span\s*\{[\s\S]*grid-template-columns:\s*repeat\(6/
  );
  assert.match(
    css,
    /\.tv-home-loading-visual > span > i\s*\{[\s\S]*aspect-ratio:\s*16\s*\/\s*10/
  );
  assert.match(home, /homeRequestTimeoutMs\s*=\s*10000/);
  assert.match(home, /HOME_REQUEST_TIMEOUT/);
  assert.match(home, /cancelPendingLoad\(\)[\s\S]*this\.loadGeneration \+= 1/);
  assert.match(home, /if \(!this\.isCurrentLoad\(generation\)\) return/);
  assert.match(app, /this\.pages\.home\.cancelPendingLoad\?\.\(\)/);
});

test('Live synchronously paints explicit loading, empty and recoverable error states', () => {
  assert.match(livePage, /channelList\.isLoading\s*=\s*true/);
  assert.match(livePage, /liveGuideFusion\?\.render\(\)/);
  assert.match(channelList, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(channelList, /window\.app\?\.liveGuideFusion\?\.render\(\)/);
  assert.match(liveGuide, /live-guide-status is-loading[\s\S]*Preparing your channel guide/);
  assert.match(liveGuide, /live-guide-status is-error[\s\S]*data-action="reload-live"/);
  assert.match(liveGuide, /live-guide-status is-empty[\s\S]*No channels yet/);
  assert.match(css, /#page-live \.live-guide-status\s*\{[\s\S]*min-height:/);
});

test('TV notifications are viewport-safe, modal, focus-contained and restorative', () => {
  assert.match(app, /modal-overlay active norva-notif-tv-overlay/);
  assert.match(app, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(app, /panel\.dataset\.restoreFocus\s*=\s*'nav-bell'/);
  assert.match(app, /first\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /ev\.key === 'Tab'/);
  assert.match(app, /bell\.focus\(\{ preventScroll: true \}\)/);
  assert.match(
    css,
    /#norva-notif-panel\.norva-notif-tv-overlay\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/
  );
  assert.match(css, /\.norva-notif-tv-surface\s*\{[\s\S]*max-height:\s*calc\(100vh/);
});

test('Settings entry keeps header and tabs fixed while only the active panel scrolls', () => {
  assert.match(html, /class="tabs" role="tablist"/);
  assert.match(html, /class="tab active"[^>]*aria-selected="true"/);
  assert.match(settings, /\.setAttribute\('aria-selected'/);
  assert.match(settings, /\.setAttribute\('aria-hidden'/);
  assert.match(settings, /activePanel\.scrollTop\s*=\s*0/);
  assert.match(
    css,
    /#page-settings \.settings-container\s*\{[\s\S]*grid-template-rows:\s*max-content max-content minmax\(0, 1fr\)/
  );
  assert.match(
    css,
    /#page-settings \.settings-container > \.tab-content\s*\{[\s\S]*overflow-y:\s*auto/
  );
});

test('Movie and series catalogue states stay intentional while metadata is pending', () => {
  assert.match(movies, /poster\.src\s*=\s*'\/img\/norva-media-placeholder\.png'/);
  assert.match(movies, /title\.textContent\s*=\s*'Select a movie'/);
  assert.match(movies, /Audio pending\|Identifying audio/);
  assert.match(series, /Audio pending\|Identifying audio/);
  assert.match(movies, /return \/\^\(\?:Audio pending\|Identifying audio\)\$\/i\.test\(text\) \? '' : text/);
  assert.match(series, /return \/\^\(\?:Audio pending\|Identifying audio\)\$\/i\.test\(text\) \? '' : text/);
  assert.match(movies, /data-movies-retry/);
  assert.match(series, /data-series-retry/);
  assert.doesNotMatch(movies, /empty-state rich-empty premium-state[^`]*[🎬📽️]/u);
  assert.doesNotMatch(series, /empty-state rich-empty premium-state[^`]*[📺🎬]/u);
  assert.match(css, /#movie-details\.tv-preview-empty/);
});

test('TV focus uses branded contrast without harsh full-white menu selection', () => {
  const premiumFocus = css.slice(css.lastIndexOf('Premium focus:'));
  assert.match(
    premiumFocus,
    /\.navbar-menu \.nav-link:focus\s*\{[\s\S]*background:\s*linear-gradient/
  );
  assert.doesNotMatch(
    premiumFocus,
    /\.navbar-menu \.nav-link:focus\s*\{[^}]*background:\s*#fff(?:fff)?\s*;/i
  );
  assert.match(premiumFocus, /scale\(1\.045\)/);
  assert.match(premiumFocus, /outline:\s*3px solid #b9d2ff/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
