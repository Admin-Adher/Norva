const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const catalog = require('../scripts/i18n/catalog.cjs').load();
const { copy } = require('../public/js/plan-selection-ui.js');
const locales = require('../i18n/locales.json');

test('subscription amounts, savings and selected plans stay localized in all ten locales', () => {
  const previous = globalThis.NorvaI18n;
  try {
    for (const { code } of locales) {
      globalThis.NorvaI18n = { language: code, t(key, values = {}) {
        assert.ok(catalog[key]?.[code], `${key}/${code} is registered`);
        return catalog[key][code].replace(/\{\{(\w+)\}\}/g, (_, p) => values[p]);
      } };
      const note = copy.annualNote(41.99 / 12);
      assert.ok(note.includes(copy.money(3.5)), 'monthly equivalent rounds without changing the annual charge');
      assert.ok(copy.continueWith('family').includes(copy.planName('family')));
      assert.ok(copy.selected('family', '5').includes(copy.planName('family')));
      assert.doesNotMatch(copy.savePercent(30), /Enregistrer|Salvar|Guardar|Kaydet|Simpan/);
      assert.doesNotMatch(note + copy.selected('family', '5'), /undefined|\{\{/);
      if (code !== 'en') {
        assert.doesNotMatch(note, /billed annually|per month/);
        assert.notEqual(copy.cadence('annual'), '/yr');
        assert.notEqual(copy.cadence('monthly'), '/mo');
      }
    }
  } finally { globalThis.NorvaI18n = previous; }
});

test('price failures remain purchase-blocking and web helpers do not inherit a native loading state', () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, '../public/subscribe.html'), 'utf8');
  const helper = html.slice(html.indexOf('function refreshDecisionHelper()'), html.indexOf('function refreshCtas()'));
  assert.match(helper, /pendingNative = nativeOffersRequired && !nativeOffersReady/);
  assert.match(helper, /pendingWeb = webPricesRequired && !webPricesReady/);
  assert.match(helper, /appUserId\(\) \|\| !offersTrial\(\)/);
  assert.match(html, /continueButton|planSelection\.sync\(\)/);
  assert.match(html, /if \(webPricesRequired && !webPricesReady\) \{\s*b.disabled = true/);
  assert.doesNotMatch(html, /You save \$|That's about|const firstTxt|return denied\.message/);
});
