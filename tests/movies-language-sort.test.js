const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Movies language bucket forwards explicit sort filters to the server', () => {
  const src = read('public/js/pages/MoviesPage.js');
  assert.match(src, /const sort = this\.sortSelect\?\.value \|\| '';/);
  assert.match(src, /if \(sort && sort !== 'default'\) params\.sort = sort;/);
  assert.match(src, /if \(this\.addedSelect\?\.value\) params\.addedDays = this\.addedSelect\.value;/);
  assert.match(src, /const langKey = this\.currentBucketViewKey\(\);/);
});

test('genre-items respects explicit Newest/Recently Added ordering instead of poster-first order', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /const sort = \(url\.searchParams\.get\("sort"\) \|\| "default"\)/);
  assert.match(src, /sort === "year" \? "release_year"/);
  assert.match(src, /sort === "added" \? "created_at"/);
  assert.match(src, /sort === "name" \? "title"/);
  assert.match(src, /Only the default grid prioritises artwork before recency/);
  const orderBlock = src.slice(src.indexOf('const { data, count, error }'), src.indexOf('.range(offset, offset + limit - 1);'));
  const posterOrder = orderBlock.indexOf('"poster_url"');
  const sortOrder = orderBlock.indexOf('sort === "year-asc" ? "release_year"');
  assert.ok(sortOrder !== -1 && posterOrder !== -1 && sortOrder < posterOrder,
    'explicit sort selection must be evaluated before falling back to poster_url');
});


test('Movies filter diagnostics log route and request parameters for browser debugging', () => {
  const src = read('public/js/pages/MoviesPage.js');
  assert.match(src, /console\.info\(`\[Movies\]\[filters\] \$\{event\}`/);
  assert.match(src, /filterDebugSnapshot\(trigger = 'unknown'\)/);
  assert.match(src, /this\.debugFilterLog\('route:language-bucket'/);
  assert.match(src, /this\.debugFilterLog\('bucket:request'/);
  assert.match(src, /this\.debugFilterLog\('bucket:response'/);
  assert.match(src, /firstTitles: \(payload\?\.items \|\| \[\]\)\.slice\(0, 8\)/);
});
