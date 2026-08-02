'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/app.html');
const app = read('public/js/app.js');
const iconsJs = read('public/js/icons.js');
const css = read('public/css/main.css');
const navIconCss = css.slice(css.indexOf('/* Icons */'), css.indexOf('/* Animation Utilities */'));
const navIcons = ['home', 'live-tv', 'movies', 'series', 'settings', 'logout'];

test('navigation SVGs keep the Norva gradients with a filter-free vector core', () => {
  for (const name of navIcons) {
    const svg = read(`public/img/icons/norva-${name}.svg`);
    assert.match(svg, /viewBox="0 0 96 96"/, `${name} keeps its vector viewBox`);
    assert.match(svg, /<linearGradient\b/, `${name} keeps its Norva gradient`);
    assert.doesNotMatch(svg, /<filter\b|feGaussianBlur|filter="url\(/, `${name} has no baked-in blur`);
  }
});

test('navigation icons use an explicit sharp core and one restrained non-TV aura', () => {
  assert.match(
    css,
    /\.nav-link\s*\{[\s\S]*?min-width:\s*48px;[\s\S]*?min-height:\s*48px;/
  );
  assert.match(
    navIconCss,
    /\.nav-link \.norva-ui-icon\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;[\s\S]*?opacity:\s*0\.9;[\s\S]*?filter:\s*none;[\s\S]*?transform:\s*none;/
  );

  const auraRule = navIconCss.match(
    /html:not\(\.tv-mode\) \.nav-link:hover \.norva-ui-icon,[\s\S]*?html:not\(\.tv-mode\) \.nav-link\.active \.norva-ui-icon\s*\{([\s\S]*?)\}/
  );
  assert.ok(auraRule, 'non-TV hover, focus and active states share a restrained aura');
  assert.equal((auraRule[1].match(/drop-shadow\(/g) || []).length, 1, 'only one aura is rendered');
  assert.match(auraRule[1], /drop-shadow\(0 0 4px var\(--color-accent-dim\)\)/);

  assert.doesNotMatch(navIconCss, /drop-shadow\(0 0 (?:12|18)px/);
  assert.doesNotMatch(navIconCss, /translateY\(-1px\)/);
  assert.match(
    navIconCss,
    /html\.tv-mode \.navbar-menu \.nav-link\.active \.norva-ui-icon\s*\{[\s\S]*?filter:\s*none;/
  );
});

test('icon-only navigation links keep an accessible name and current-page state', () => {
  const expectedCounts = new Map([
    ['home', 2],
    ['live', 2],
    ['movies', 2],
    ['series', 2],
    ['settings', 1],
    ['admin', 1],
  ]);
  const labels = {
    home: 'Home',
    live: 'Live TV',
    movies: 'Movies',
    series: 'Series',
    settings: 'Settings',
    admin: 'Admin',
  };

  for (const [page, count] of expectedCounts) {
    const matches = html.match(
      new RegExp(`<a[^>]*data-page="${page}"[^>]*aria-label="${labels[page]}"`, 'g')
    ) || [];
    assert.equal(matches.length, count, `${page} has an explicit name in every navigation set`);
  }

  assert.equal(
    (html.match(/data-page="home"[^>]*aria-current="page"/g) || []).length,
    2,
    'both pre-boot Home links truthfully expose the initial route'
  );
  assert.equal(
    (html.match(/data-action="downloads"[^>]*aria-label="Downloads"/g) || []).length,
    2,
    'Downloads remains named when its label is visually hidden'
  );

  assert.match(app, /logoutLink\.setAttribute\('aria-label', 'Log out'\)/);
  assert.match(app, /const isCurrent = Boolean\(link\.dataset\.page\)/);
  assert.match(app, /link\.setAttribute\('aria-current', 'page'\)/);
  assert.match(app, /link\.removeAttribute\('aria-current'\)/);
});

test('revised SVG URLs bypass existing image and service-worker caches', () => {
  for (const name of ['home', 'live-tv', 'movies', 'series', 'settings']) {
    assert.match(
      html,
      new RegExp(`/img/icons/norva-${name}\\.svg\\?v=sharp-core-1`),
      `${name} has a revised cache key`
    );
  }
  assert.match(app, /norva-logout\.svg\?v=sharp-core-1/);
  assert.match(app, /norva-settings\.svg\?v=sharp-core-1/);
  assert.match(iconsJs, /norva-\$\{name\}\.svg\?v=sharp-core-1/);
  assert.match(html, /\/css\/main\.css\?v=97/);
  assert.match(html, /\/js\/icons\.js\?v=1/);
  assert.match(html, /\/js\/app\.js\?v=61/);
});
