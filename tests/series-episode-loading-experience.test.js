'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('series episode loading is reassuring, semantic, and previews the arriving rows', () => {
  const source = read('public/js/pages/SeriesPage.js');
  const start = source.indexOf('this.seasonsContainer.innerHTML = `');
  const end = source.indexOf('const tvEpisodeCount', start);
  const loading = source.slice(start, end);

  assert.match(loading, /class="series-episode-loading" role="status"/);
  assert.match(loading, /aria-live="polite" aria-atomic="true"/);
  assert.match(loading, /aria-label="Loading episodes\. Please wait\."/);
  assert.match(loading, /Gathering this season/);
  assert.match(loading, /your episodes are loading\. This can take a few seconds\./);
  assert.equal((loading.match(/series-episode-loader-number/g) || []).length, 3);
  assert.doesNotMatch(loading, /class="loading series-episode-loading"/,
    'the generic circular spinner utility must not distort the full loading panel');
});

test('series episode loading motion is composited, bounded, and reduced-motion safe', () => {
  const css = read('public/css/main.css');
  const start = css.indexOf('.series-episode-loading {');
  const end = css.indexOf('.series-episodes-toolbar {', start);
  const loadingCss = css.slice(start, end);

  assert.match(loadingCss, /var\(--color-bg-secondary\)/);
  assert.match(loadingCss, /var\(--color-accent\)/);
  assert.match(loadingCss, /@keyframes series-episode-loader-breathe/);
  assert.match(loadingCss, /transform:\s*translate3d/);
  assert.match(loadingCss, /will-change:\s*transform, opacity/);
  assert.match(loadingCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(loadingCss, /animation:\s*none/);
  assert.doesNotMatch(loadingCss, /transition:\s*all/);
  assert.doesNotMatch(loadingCss, /#[0-9a-f]{3,8}\b/i,
    'the loading experience must use the canonical Norva tokens');
});

