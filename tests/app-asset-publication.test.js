'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint } = require('../scripts/fingerprint-app-assets.cjs');
const { verify } = require('../scripts/verify-app-deployment.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'js/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'js/pages/HomePage.js'), 'window.home="new";');
  fs.writeFileSync(path.join(root, 'css/main.css'), 'body{background:url(../img/a.png)}');
  fs.writeFileSync(path.join(root, 'app.html'), '<script defer src="/js/pages/HomePage.js?v=new"></script><link rel="stylesheet" href="/css/main.css?v=1"><script src="https://example.com/sdk.js"></script>');
  return root;
}
test('content filenames and integrity refer to exact bytes, preserve CSS paths and are repeatable', t => {
  const root = fixture(t), manifest = fingerprint(root);
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    assert.match(asset.url, /\.app-v2\.[a-f0-9]{16}\.(js|css)$/);
    assert.match(asset.url, /\.[a-f0-9]{16}\.(js|css)$/);
    assert.equal(path.posix.dirname(asset.url), path.posix.dirname(asset.source));
    assert.deepEqual(fs.readFileSync(path.join(root, asset.url)), fs.readFileSync(path.join(root, asset.source)));
  }
  assert.deepEqual(fingerprint(root), manifest);
  assert.match(fs.readFileSync(path.join(root,'app.html'),'utf8'), /https:\/\/example.com\/sdk.js/);
  fs.writeFileSync(path.join(root, 'js/pages/HomePage.js'), 'window.home="next";');
  const next = fingerprint(root);
  assert.notEqual(next.assets[0].url, manifest.assets[0].url);
  assert.equal(fs.readFileSync(path.join(root, manifest.assets[0].url),'utf8'),'window.home="new";');
});

test('legacy immutable URLs are migrated without changing source bytes or asset directories', t => {
  const root = fixture(t);
  const oldUrl = '/js/pages/HomePage.legacy0123456789.js';
  const source = '/js/pages/HomePage.js';
  fs.writeFileSync(path.join(root, 'app.html'), `<script src="${oldUrl}"></script>`);
  fs.writeFileSync(path.join(root, 'app-assets.json'), JSON.stringify({ assets: [{ source, url: oldUrl }] }));
  const bytes = fs.readFileSync(path.join(root, source));
  const manifest = fingerprint(root);
  assert.equal(manifest.assets[0].source, source);
  assert.notEqual(manifest.assets[0].url, oldUrl);
  assert.deepEqual(fs.readFileSync(path.join(root, manifest.assets[0].url)), bytes);
  assert.deepEqual(fingerprint(root), manifest);
});
test('delivery verification detects old bytes behind a correctly labelled URL', async t => {
  const root = fixture(t), manifest = fingerprint(root);
  const serve = (stale = false, shell = false) => async url => new Response(url.pathname === '/app'
    ? (shell ? '<script src="/js/pages/HomePage.js?v=new"></script>' : fs.readFileSync(path.join(root,'app.html')))
    : (stale && url.pathname.endsWith('.js') ? 'window.home="old";' : fs.readFileSync(path.join(root,url.pathname))));
  assert.deepEqual(await verify('https://norva.test',manifest,serve()),{verifiedAssets:2});
  await assert.rejects(verify('https://norva.test',manifest,serve(true)),/hash mismatch/);
  await assert.rejects(verify('https://norva.test',manifest,serve(false,true)),/Stale application shell/);
});
test('an existing immutable filename with different bytes fails publication', t => {
  const root = fixture(t), manifest = fingerprint(root);
  fs.writeFileSync(path.join(root,manifest.assets[0].url),'wrong');
  assert.throws(()=>fingerprint(root),/collision/);
});

test('every production Pages publisher preserves and verifies immutable application assets', () => {
  const workflows = path.join(__dirname, '../.github/workflows');
  const publishers = fs.readdirSync(workflows).filter(name => name.endsWith('.yml'))
    .map(name => ({ name, text: fs.readFileSync(path.join(workflows, name), 'utf8') }))
    .filter(({ text }) => text.includes('pages deploy public --project-name=norva-web --branch=main'));
  assert.ok(publishers.length >= 2);
  for (const { name, text } of publishers) {
    const deploy = text.indexOf('pages deploy public --project-name=norva-web --branch=main');
    const fingerprint = text.indexOf('run: node scripts/fingerprint-app-assets.cjs');
    const verification = text.indexOf('run: node scripts/verify-app-deployment.cjs https://norva.tv');
    assert.ok(fingerprint >= 0 && fingerprint < deploy, `${name}: unversioned application publication`);
    assert.ok(verification > deploy, `${name}: delivery must be verified after publication`);
    assert.match(text, /concurrency:\s*\r?\n\s+group: norva-web-production/, `${name}: publication race`);
  }
});
