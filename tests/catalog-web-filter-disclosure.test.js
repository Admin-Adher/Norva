'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/app.html');
const app = read('public/js/app.js');
const css = read('public/css/main.css');

test('web catalogue keeps the live filter nodes behind one accessible disclosure per page', () => {
  for (const key of ['movies', 'series']) {
    assert.match(html, new RegExp(`id="${key}-catalog-filter-toggle"[\\s\\S]{0,240}aria-controls="${key}-filter-bar"[\\s\\S]{0,120}aria-expanded="false"`));
    assert.equal((html.match(new RegExp(`id="${key}-filter-bar"`, 'g')) || []).length, 1);
    assert.equal((html.match(new RegExp(`id="${key}-sort"`, 'g')) || []).length, 1);
    assert.equal((html.match(new RegExp(`id="${key}-count"`, 'g')) || []).length, 1);
    assert.match(html, new RegExp(`class="filter-bar catalog-filter-panel is-collapsed" id="${key}-filter-bar"`));
  }
});

test('desktop disclosure exposes state, active-filter count and Escape focus restoration', () => {
  assert.match(app, /this\.initDesktopCatalogFilters\(\)/);
  assert.match(app, /initDesktopCatalogFilters\(\)\s*\{/);
  assert.match(app, /button\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(app, /panel\.classList\.toggle\('is-collapsed', !expanded\)/);
  assert.match(app, /\.filter-chip:not\(\.filter-chip-clear\)/);
  assert.match(app, /if \(event\.key !== 'Escape' \|\| !isDesktopWeb\(\)\) return/);
  assert.match(app, /button\.focus\(\{ preventScroll: true \}\)/);
});

test('compact presentation applies only to desktop web and keeps semantic tokens', () => {
  const disclosureCss = css.match(/\.catalog-filter-disclosure \{[\s\S]*?\n\}\r?\n\r?\n\.filter-select/);
  assert.ok(disclosureCss, 'catalogue disclosure CSS block should stay locally inspectable');
  assert.match(css, /@media \(min-width: 1025px\)[\s\S]*?html:not\(\.tv-mode\) \.catalog-filter-panel\.is-collapsed/);
  assert.match(css, /\.catalog-filter-disclosure-toggle\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /background:\s*var\(--color-bg-secondary\)/);
  assert.match(css, /border-color:\s*var\(--color-border/);
  assert.doesNotMatch(disclosureCss[0], /#[0-9a-fA-F]{3,8}/);
});

test('phone sheet and TV fallback remain explicit overrides', () => {
  assert.match(css, /@media \(max-width: 1024px\)[\s\S]*?\.catalog-filter-disclosure-toolbar\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /html\.tv-mode \.catalog-filter-disclosure-toggle[\s\S]*?display:\s*none/);
  assert.match(css, /html\.tv-mode #page-movies:not\(\.tv-movies-layout-ready\) \.catalog-filter-disclosure-toolbar/);
  assert.match(css, /html\.tv-mode #page-series:not\(\.tv-series-layout-ready\) \.catalog-filter-disclosure-toolbar/);
  assert.match(app, /if \(!isDesktopWeb\(\)\) return/);
  assert.match(app, /navigator\.userAgent\.includes\('NorvaTV-AndroidTV'\)/);
});
