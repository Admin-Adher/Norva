const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('unsigned acquisition CTAs enter the app instead of the plan picker', () => {
  for (const file of ['public/index.html', 'public/landing.html']) {
    const source = read(file);
    assert.match(source, /returnTo=%2Fapp%23home/, file);
    assert.doesNotMatch(source, /returnTo=%2Fsubscribe\.html/, file);
  }

  const landingJs = read('public/js/landing.js');
  assert.match(landingJs, /account\.searchParams\.set\('returnTo', '\/app#home'\)/);
  assert.doesNotMatch(landingJs, /returnTo=%2Fsubscribe\.html/);

  assert.match(read('scripts/blog/lib/templates.js'), /returnTo=%2Fapp%23home/);
  assert.doesNotMatch(read('scripts/blog/lib/templates.js'), /returnTo=%2Fsubscribe\.html/);
  assert.match(read('public/blog/index.html'), /returnTo=%2Fapp%23home/);
  assert.doesNotMatch(read('public/blog/index.html'), /returnTo=%2Fsubscribe\.html/);
});

test('playback still routes the free-browse wall to the plan picker', () => {
  const api = read('public/js/api.js');
  assert.match(api, /function routeToSubscribeWall/);
  assert.match(api, /window\.location\.replace\('\/subscribe\.html\?returnTo='/);
});
