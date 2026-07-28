const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const premiumCss = fs.readFileSync(
  path.join(root, 'public/css/landing-premium.css'),
  'utf8',
);
const landingJs = fs.readFileSync(
  path.join(root, 'public/js/landing.js'),
  'utf8',
);

test('landscape tablets keep the complete landing navigation visible', () => {
  assert.match(
    premiumCss,
    /@media \(min-width: 981px\) and \(max-width: 1100px\)[\s\S]*?\.nav-shell\.landing-nav \.nav-toggle\s*\{\s*display: none;/,
  );
  assert.match(
    premiumCss,
    /@media \(min-width: 981px\) and \(max-width: 1100px\)[\s\S]*?\.nav-shell\.landing-nav \.nav-links,[\s\S]*?display: flex;/,
  );
  assert.match(
    premiumCss,
    /@media \(min-width: 981px\) and \(max-width: 1100px\)[\s\S]*?\.nav-shell\.landing-nav \.nav-actions\s*\{\s*display: flex;/,
  );
});

test('mobile navigation behavior and accessibility share the 980px breakpoint', () => {
  assert.match(
    premiumCss,
    /@media \(max-width: 980px\)[\s\S]*?\.nav-shell\.landing-nav:not\(\.open\) \.nav-links/,
  );
  assert.match(
    landingJs,
    /const mobile = window\.matchMedia\('\(max-width: 980px\)'\);/,
  );
  assert.doesNotMatch(landingJs, /max-width: 1100px/);
  assert.match(
    landingJs,
    /controlled\.setAttribute\('aria-hidden', String\(!open && mobile\.matches\)\)/,
  );
});
