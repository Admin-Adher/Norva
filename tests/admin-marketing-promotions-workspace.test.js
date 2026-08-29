'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/pages/AdminPage.js'),
  'utf8',
);

const promotionsStart = source.indexOf('    async _loadWebPrices()');
const promotionsEnd = source.indexOf('    _renderFinance(', promotionsStart);
const promotions = source.slice(promotionsStart, promotionsEnd);
const marketingStart = source.indexOf('    async _pageMarketing()');
const marketingEnd = source.indexOf('    async _loadMarketingOverview()', marketingStart);
const marketing = source.slice(marketingStart, marketingEnd);
const promoCssStart = source.indexOf('#page-admin .promo-workspace');
const promoCssEnd = source.indexOf('#page-admin .pev{', promoCssStart);
const promoCss = source.slice(promoCssStart, promoCssEnd);

test('Promotions uses the approved guided campaign with secondary bulk action and expandable preview', () => {
  assert.ok(promotionsStart > 0 && promotionsEnd > promotionsStart);
  assert.match(promotions, /promo-workspace/);
  assert.match(promotions, /Construire une campagne/);
  assert.match(promotions, /Offres incluses/);
  assert.match(promotions, /id="promo-bulk-apply"/);
  assert.match(promotions, /Action secondaire : elle remplit les prix, sans enregistrer ni publier/);
  assert.match(promotions, /id="promo-preview-expand"[^>]+aria-expanded="false"/);
  assert.match(promotions, /Aperçu storefront/);
  assert.match(promotions, /promo-catalogue/);
  assert.doesNotMatch(promotions, /window\.confirm/);
  assert.doesNotMatch(source, /price-grid|price-cell/);
});

test('Promotion and catalogue writes remain separated behind explicit inline reviews', () => {
  assert.match(promotions, /id="promo-review" hidden tabindex="-1"/);
  assert.match(promotions, /Vérification avant activation/);
  assert.match(promotions, /id="fin-prices-save"[^>]+disabled/);
  assert.match(promotions, /this\._rpc\('admin_billing_promo_set', \{/);
  for (const parameter of [
    'p_plan', 'p_period', 'p_amount_cents', 'p_event', 'p_ends_at',
    'p_label', 'p_cycles', 'p_ref_monthly',
  ]) {
    assert.match(promotions, new RegExp(`${parameter}:`));
  }
  assert.match(promotions, /id="promo-catalogue-review" hidden tabindex="-1"/);
  assert.match(promotions, /this\._rpc\('admin_billing_price_set', \{/);
  assert.match(promotions, /abonnés existants inchangés/);
});

test('Promotion workspace uses product assets, semantic controls and safe user-facing errors', () => {
  assert.match(promotions, /\/img\/norva-app-icon-96\.webp/);
  assert.match(promotions, /\/img\/promo-wallpapers\//);
  assert.match(promotions, /<label class="promo-field" for="promo-campaign-event">/);
  assert.match(promotions, /aria-live="polite"/);
  assert.match(promotions, /aria-busy/);
  assert.match(promotions, /role="alert"/);
  assert.match(promotions, /Vérifiez votre connexion puis réessayez/);
  assert.doesNotMatch(promotions, /response\.text\(\)|error\.message\s*\+|JSON\.stringify\(error/);
  assert.doesNotMatch(promotions, /[🎨🚀⚙️📣🎯💸🏷️🖼️👁️]/u);
});

test('Promotion styles preserve focus, touch size, reduced motion and responsive layouts', () => {
  assert.ok(promoCssStart > 0 && promoCssEnd > promoCssStart);
  assert.match(promoCss, /min-height:44px/);
  assert.match(promoCss, /touch-action:manipulation/);
  assert.match(promoCss, /:focus-visible/);
  assert.match(promoCss, /outline:2px solid var\(--color-accent\)/);
  assert.match(promoCss, /@media\(max-width:760px\)/);
  assert.match(promoCss, /@media\(max-width:520px\)/);
  assert.match(promoCss, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(promoCss, /#[0-9a-fA-F]{3,8}\b/);
});

test('Marketing tabs expose selection state and keyboard navigation', () => {
  assert.ok(marketingStart > 0 && marketingEnd > marketingStart);
  assert.match(marketing, /role="tablist"/);
  assert.match(marketing, /aria-controls="mkt-tab-overview"/);
  assert.match(marketing, /aria-controls="mkt-tab-promos"/);
  assert.match(marketing, /aria-selected/);
  assert.match(marketing, /ArrowLeft/);
  assert.match(marketing, /ArrowRight/);
  assert.match(marketing, /Home/);
  assert.match(marketing, /End/);
  assert.match(marketing, /role="tabpanel"/);
});
