'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('public/js/app.js');
const multiSelect = read('public/js/components/MultiSelect.js');
const movies = read('public/js/pages/MoviesPage.js');
const series = read('public/js/pages/SeriesPage.js');
const home = read('public/js/pages/HomePage.js');
const settings = read('public/js/pages/Settings.js');
const css = read('public/css/main.css');

test('mobile catalogue filters are a focus-contained modal with a safe close target', () => {
  assert.match(app, /filterBar\.setAttribute\('role', 'dialog'\)/);
  assert.match(app, /filterBar\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(app, /filterBar\.setAttribute\('aria-hidden', 'false'\)/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /focusTarget\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /setBackgroundInert\(true\)/);
  assert.match(app, /setBackgroundInert\(false\)/);
  assert.match(app, /restoreDesktopSemantics\(\)/);
  assert.match(app, /fieldWrappers\.forEach\(\(field, name\) =>/);
  assert.match(app, /if \(nextMode === layoutMode\) return/);
  assert.match(app, /const focusWillBeHidden = \[\.\.\.fieldWrappers\.keys\(\)\]\.some/);
  assert.match(app, /if \(focusWillBeHidden\)[\s\S]{0,240}filterBtn\.focus/);
  assert.match(app, /const focusWasInside = Boolean\(activeBefore && filterBar\.contains\(activeBefore\)\)/);
  assert.match(app, /const activeStillUsable = activeBefore\?\.isConnected/);
  assert.match(app, /class="btn btn-sm btn-ghost mobile-filter-close"[^>]*>Done</);
  assert.match(css, /\.mobile-filter-close\s*\{[\s\S]*?min-height:\s*48px/);
});

test('opening Category from the touch sheet never summons the IME automatically', () => {
  assert.match(multiSelect, /max-width: 1024px/);
  assert.match(multiSelect, /closest\('\.filter-bar'\)\?\.classList\.contains\('mobile-open'\)/);
  assert.match(multiSelect, /const avoidAutomaticIme/);
  assert.match(multiSelect, /firstAction\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(multiSelect, /this\.btn\.setAttribute\('aria-controls', this\.panel\.id\)/);
  assert.match(multiSelect, /this\.btn\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(multiSelect, /event\.key !== 'Escape'/);
  assert.match(multiSelect, /this\.setOpen\(false, \{ restoreFocus: true \}\)/);
});

test('Settings tabs always start at their own heading instead of inheriting scroll', () => {
  assert.match(settings, /if \(selected\) c\.scrollTop = 0/);
  assert.match(settings, /settingsPage\.scrollTop = 0/);
  assert.match(settings, /settingsContainer\.scrollTop = 0/);
  assert.match(settings, /activePanel\.scrollTop = 0/);
  assert.match(settings, /requestAnimationFrame\(resetTabScroll\)/);
});

test('narrow bottom navigation uses one selected label and keeps 48px account close', () => {
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.bottom-nav \.nav-link\.active/);
  assert.match(css, /\.account-close\s*\{\s*width:\s*48px;\s*height:\s*48px/);
});

test('global search ranks accent-insensitive exact titles before loose matches', () => {
  assert.match(app, /const rankGroups = \(groups\) =>/);
  assert.match(app, /M\?\.searchableText\?\.\(q\)/);
  assert.match(app, /if \(title === needle\) return 0/);
  assert.match(app, /const gMovies = rankGroups/);
  assert.match(app, /const gSeries = rankGroups/);
});

test('global search is a real isolated dialog and distinguishes outage from no results', () => {
  assert.match(app, /this\._searchInertSnapshot = \[\.\.\.document\.body\.children\]/);
  assert.match(app, /ov\.setAttribute\('aria-hidden', 'false'\)/);
  assert.match(app, /if \(event\.key === 'Escape'\)/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /Promise\.allSettled/);
  assert.match(app, /Search is temporarily unavailable\./);
  assert.match(app, /class="btn btn-sm gsearch-retry"[^>]*>Try again/);
  assert.match(app, /Some results could not be loaded/);
});

test('delayed search and fiche work is invalidated by route and same-page intent', () => {
  assert.match(app, /const navigationToken = this\._navigationToken/);
  assert.match(app, /navigationToken === this\._navigationToken && this\.currentPage === page/);
  assert.match(app, /navigationToken === this\._navigationToken && this\.currentPage === pageName/);
  assert.match(app, /const ficheIntentToken = pageObj\??\.beginFicheIntent\?\.\(\)/);
  assert.match(app, /if \(!isRouteCurrent\(\)\)[\s\S]{0,180}hideDetails/);
  assert.match(app, /if \(!isIntentCurrent\(\)\) return/);
  for (const page of [movies, series]) {
    assert.match(page, /beginFicheIntent\(\)/);
    assert.match(page, /isFicheIntentCurrent\(token\)/);
    assert.match(page, /async openByItem\(item, \{ intentToken = null \} = \{\}\)/);
    assert.match(page, /if \(!this\.isFicheIntentCurrent\(token\)\) return false/);
  }
  assert.match(series, /tryNextHealthyVersion\([\s\S]{0,180}intentToken = null/);
  assert.match(series, /rememberOnSuccess: remember,[\s\S]{0,80}intentToken/);
  assert.match(home, /page\.openByItem\(mapped, \{ intentToken \}\)/);
  assert.match(home, /if \(!isCurrent\(\)\) return/);
});

test('global search transfers keyboard and TalkBack focus into the destination', () => {
  assert.match(app, /\{ moveFocus: event\.detail === 0 \}/);
  assert.match(app, /seeAllInPage\(type, q, \{ moveFocus = true \} = \{\}\)/);
  assert.match(app, /openSearchResult\(type, idx, \{ moveFocus = true \} = \{\}\)/);
  assert.match(app, /else if \(moveFocus && input\)[\s\S]{0,520}input\.focus/);
  assert.match(app, /const primary = pageObj\?\.primaryActionBtn/);
  assert.match(app, /if \(!isCurrent\(\)\) return/);
});

test('small primary action labels use the contrast-safe action blue', () => {
  assert.match(css, /--color-accent-action:\s*#2563EB/);
  assert.match(css, /\.btn-primary\s*\{[\s\S]*?background:\s*var\(--color-accent-action\)/);
  assert.match(css, /\.mobile-filter-badge\s*\{[\s\S]*?background:\s*var\(--color-accent-action\)/);
});
