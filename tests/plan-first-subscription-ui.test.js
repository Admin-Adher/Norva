const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('subscription selection is plan-first and keeps one explicit continuation action', () => {
  const source = read('public/subscribe.html');
  const gridAt = source.indexOf('class="grid" role="radiogroup"');
  const benefitsAt = source.indexOf('class="shared-benefits"');
  const decisionAt = source.indexOf('class="plan-decision"');
  const proofAt = source.indexOf('class="product-proof"');

  assert.match(source, /<h1 id="page-title">[\s\S]{0,160}Choose your Norva plan\.[\s\S]{0,160}<\/h1>/);
  assert.match(source, /class="title-landscape">Choose your plan\.<\/span>/);
  assert.match(source, /Every plan includes the complete Norva experience/);
  assert.match(source, /Every feature is included\. Choose how many personal profiles/);
  assert.equal((source.match(/class="plan-choice-input sr-only" type="radio"/g) || []).length, 2);
  assert.equal((source.match(/class="btn buy plan-source-buy"/g) || []).length, 2,
    'the authenticated pricing buttons remain the source actions for each plan');
  assert.equal((source.match(/id="continue-plan"/g) || []).length, 1);
  assert.ok(gridAt > 0 && benefitsAt > gridAt && decisionAt > benefitsAt && proofAt > decisionAt,
    'selection and decision precede secondary product proof in reading order');
  assert.match(source, /\/js\/plan-selection-ui\.js\?v=1/);
  assert.match(source, /\/css\/commerce\.css\?v=2/);
});

test('the presentation adapter delegates without becoming a pricing authority', () => {
  const source = read('public/js/plan-selection-ui.js');
  const adapter = require('../public/js/plan-selection-ui.js');

  assert.equal(typeof adapter.init, 'function');
  assert.match(source, /sourceButton\.click\(\)/);
  assert.match(source, /MutationObserver\(sync\)/);
  assert.match(source, /\['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\]/);
  assert.match(source, /'Continue with ' \+ planName/);
  assert.doesNotMatch(source, /NorvaBilling|RevenueCat|revolutCreateOrder|\b4\.99\b|\b8\.99\b|\b41\.99\b|\b74\.99\b/,
    'selection UI mirrors verified DOM offers and never invents commerce terms');
});

test('desktop, portrait phone, compact phone, and landscape phone layouts are explicit', () => {
  const css = read('public/css/commerce.css');

  assert.match(css, /\/\* Plan-first subscription selector \*\//);
  assert.match(css, /\.commerce-subscribe \.grid\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.commerce-subscribe \.plan-decision\s*\{[\s\S]{0,220}position:\s*fixed/);
  assert.match(css, /padding:\s*15px 16px max\(12px, env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(css, /@media \(max-width: 420px\) and \(max-height: 720px\)/);
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) and \(max-width: 960px\)/);
  assert.match(css, /\.commerce-subscribe \.decision-cta\s*\{[\s\S]{0,120}min-height:\s*52px/);
  assert.match(css, /\.commerce-subscribe \.secure-context\s*\{[\s\S]{0,120}min-height:\s*44px/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test('the multi-screen proof fills its intended 8:5 slot without clipping', () => {
  const html = read('public/subscribe.html');
  const css = read('public/css/commerce.css');
  const asset = path.join(root, 'public/assets/landing/norva-every-screen-premium.webp');

  assert.match(html, /norva-every-screen-premium\.webp\?v=1/);
  assert.match(html, /width="1586" height="992"/);
  assert.match(css, /\.commerce-subscribe \.product-proof img\s*\{[\s\S]{0,260}max-height:\s*none;[\s\S]{0,160}aspect-ratio:\s*8\s*\/\s*5;[\s\S]{0,220}padding:\s*0;[\s\S]{0,220}object-fit:\s*cover;/);
  assert.ok(fs.existsSync(asset), 'the project-bound WebP asset is present');
  assert.ok(fs.statSync(asset).size < 100_000, 'the visual remains lightweight enough for the commerce funnel');
  assert.equal(fs.readFileSync(asset, null).subarray(8, 12).toString('ascii'), 'WEBP');
});

test('the Android phone shell trusts the canonical extensionless plan URL', () => {
  const main = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  const helperAt = main.indexOf('private static boolean isTrustedBillingPage');
  const helper = main.slice(helperAt, helperAt + 700);

  assert.match(helper, /"\/subscribe"\.equals\(path\)/);
  assert.match(helper, /"\/subscribe\.html"\.equals\(path\)/);
  assert.match(helper, /"\/subscription\.html"\.equals\(path\)/);
});
