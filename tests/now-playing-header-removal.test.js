'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Watch has no redundant Now Playing control in the global navigation', () => {
  const html = read('public/app.html');
  const app = read('public/js/app.js');
  const watch = read('public/js/pages/WatchPage.js');
  const css = read('public/css/main.css');

  assert.doesNotMatch(html, /now-playing-indicator|now-playing-text/);
  assert.doesNotMatch(app, /now-playing-indicator/);
  assert.doesNotMatch(watch, /showNowPlaying\(|hideNowPlaying\(|now-playing-indicator/);
  assert.doesNotMatch(css, /\.now-playing-indicator|\.now-playing-icon|\.now-playing-text|now-playing-pulse/);
});

test('removing the header control preserves Media Session metadata', () => {
  const watch = read('public/js/pages/WatchPage.js');
  assert.match(watch, /await this\.loadVideo\([\s\S]*?this\.updateMediaSessionMetadata\(\);/);
  assert.match(watch, /updateMediaSessionMetadata\(\) \{/);
});
