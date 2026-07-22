const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('commercial surfaces name the shipped platforms consistently', () => {
  const exact = /Web, Android mobile and Android TV/;
  for (const file of [
    'public/index.html',
    'public/landing.html',
    'public/subscribe.html',
    'public/paywall.html',
    'public/checkout-revolut.html',
  ]) {
    assert.match(read(file), exact, file);
  }
  for (const file of ['public/index.html', 'public/landing.html']) {
    assert.doesNotMatch(read(file), /Web, mobile and TV|phone, tablet(?:\s*&| and) TV/i, file);
  }
});
test('legacy premium codes never advertise a non-existent Premium plan', () => {
  const subscription = read('public/subscription.html');
  const settings = read('public/js/pages/Settings.js');
  assert.doesNotMatch(subscription, /Norva Premium/);
  assert.doesNotMatch(settings, /Norva Premium/);
  assert.match(subscription, /p === 'premium'[\s\S]{0,80}return 'Norva'/);
  assert.match(settings, /plan === 'premium' \|\| plan === 'plus'\) return 'Norva'/);
});

test('transaction screens keep readable secondary text, visible focus and narrow reflow', () => {
  for (const file of [
    'public/subscribe.html',
    'public/paywall.html',
    'public/checkout-revolut.html',
    'public/subscription.html',
  ]) {
    const source = read(file);
    assert.match(source, /--quiet:\s*#8490aa/,
      `${file} must use the secondary-text token that exceeds 4.5:1 on Norva panels`);
    assert.match(source, /focus-visible[\s\S]{0,180}outline:\s*3px/,
      `${file} must expose a visible keyboard or D-pad focus ring`);
    assert.match(source, /overflow-wrap:\s*anywhere/,
      `${file} must allow long localized or transactional text to reflow`);
    assert.match(source, /@media \(max-width:\s*(?:420|520|560)px\)/,
      `${file} must include a narrow-layout treatment`);
  }
  const subscribe = read('public/subscribe.html');
  const compact = subscribe.slice(subscribe.indexOf('@media (min-width: 640px) and (max-height: 799px)'), subscribe.indexOf('</style>'));
  assert.doesNotMatch(compact, /\.(?:lead|note|compare)\s*\{\s*display:\s*none/,
    'short or zoomed viewports must not lose explanatory or legal copy');
});
