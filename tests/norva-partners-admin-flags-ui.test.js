'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');
const managedFlags = [
  'partners_enabled',
  'partners_invite_only',
  'partners_cash_pilot_allowlist_only',
  'partners_earnings_enabled',
  'partners_credit_redemptions_enabled',
  'partners_shadow_mode',
  'partners_payouts_live',
  'partners_tv_relay_enabled',
];

function loadAdminPage(document) {
  const window = {};
  const context = vm.createContext({
    window,
    document,
    localStorage: { getItem() { return null; } },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

function renderFlags(flags) {
  const host = { innerHTML: '' };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'sys-flags' ? host : null;
    },
  });
  const page = Object.create(AdminPage.prototype);
  page._renderFlags(flags);
  return host.innerHTML;
}

test('managed Partners flags render as premium read-only release states', () => {
  const html = renderFlags([
    ...managedFlags.map((key, index) => ({
      key,
      enabled: index % 2 === 0,
      description: `Managed ${index}`,
      updated_by: 'release-control',
    })),
    {
      key: 'ordinary_experiment',
      enabled: true,
      description: 'Generic flag',
      updated_by: 'admin',
    },
  ]);

  for (const key of managedFlags) {
    assert.match(html, new RegExp(`data-managed-partners-flag="${key}"`));
    assert.match(
      html,
      new RegExp(`aria-label="${key} — contrôle de release sécurisé, état (?:activé|désactivé), lecture seule"`),
    );
  }
  assert.equal(
    (html.match(/Contrôle de release sécurisé · lecture seule dans cette vue/g) || []).length,
    managedFlags.length,
  );
  assert.doesNotMatch(html, /class="flag-toggle" data-key="partners_/);
  assert.doesNotMatch(html, /class="flag-del" data-key="partners_/);

  assert.match(html, /class="flag-toggle" data-key="ordinary_experiment"/);
  assert.match(html, /class="flag-del" data-key="ordinary_experiment"/);
  assert.match(html, /class="flag-create tag-add-chip"/);
});

test('managed flag guard blocks generic mutation paths while other flags stay unchanged', async () => {
  const AdminPage = loadAdminPage({ getElementById() { return null; } });
  const page = Object.create(AdminPage.prototype);
  const calls = [];
  page._toast = (message) => calls.push(['toast', message]);
  page._loadFlags = () => calls.push(['reload']);
  page._rpc = (...args) => {
    calls.push(['rpc', ...args]);
    return Promise.resolve();
  };

  await page._flagToggle({
    dataset: { key: 'partners_enabled' },
    checked: true,
  });
  assert.equal(calls.some((entry) => entry[0] === 'rpc'), false);
  assert.equal(calls.some((entry) => entry[0] === 'reload'), true);

  calls.length = 0;
  await page._flagToggle({
    dataset: { key: 'ordinary_experiment' },
    checked: true,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.find((entry) => entry[0] === 'rpc'))),
    ['rpc', 'admin_flag_set', { p_key: 'ordinary_experiment', p_enabled: true }],
  );
});

test('managed release styling is responsive and has no interactive switch affordance', () => {
  assert.match(source, /\.flag-row--managed\{[\s\S]{0,260}border-radius:11px/);
  assert.match(source, /\.flag-managed-detail\{[^}]*flex-wrap:wrap/);
  assert.match(source, /\.flag-managed-state\{[^}]*min-width:74px/);
  assert.match(source, /\.flag-managed-badge\{[^}]*min-height:24px/);
  for (const key of managedFlags) assert.match(source, new RegExp(`'${key}'`));
});
