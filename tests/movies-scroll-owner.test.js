'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function cssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} rule must exist`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `${selector} rule must close`);
  return source.slice(start, end + 2);
}

test('Movies grid uses the remaining flex height as its single scroll surface', () => {
  const rule = cssRule(read('public/css/main.css'), '.movies-grid');

  assert.match(rule, /flex:\s*1\s*;/);
  assert.match(rule, /min-height:\s*0\s*;/);
  assert.match(rule, /height:\s*auto\s*;/);
  assert.match(rule, /overflow-y:\s*auto\s*;/);
  assert.doesNotMatch(rule, /100(?:d)?vh/);
});

test('Movies bucket pagination observes the Movies grid instead of the viewport', () => {
  const source = read('public/js/pages/MoviesPage.js');
  const observerStart = source.indexOf('this.bucketObserver = new IntersectionObserver');
  const observerEnd = source.indexOf('this.loadBucketPage().then', observerStart);
  assert.notEqual(observerStart, -1);
  assert.notEqual(observerEnd, -1);
  const observer = source.slice(observerStart, observerEnd);

  assert.match(observer, /root:\s*this\.container/);
  assert.match(observer, /rootMargin:\s*'0px 0px 700px 0px'/);
});

test('Movies scroll assets are cache-busted together', () => {
  const app = read('public/app.html');
  assert.match(app, /\/css\/main\.css\?v=4fb2cde48b/);
  assert.match(app, /\/js\/pages\/MoviesPage\.js\?v=61/);
});
