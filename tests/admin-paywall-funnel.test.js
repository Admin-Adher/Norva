const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260722120000_paywall_experiments_funnel.sql'),
  'utf8',
);

test('Finance loads paywall analytics as a non-blocking optional RPC', () => {
  assert.match(admin, /this\._rpc\('admin_paywall_funnel_30d'\)\.catch\(error => \(\{/);
  assert.match(admin, /unavailable: true/);
  assert.match(admin, /this\._renderFinance\(f \|\| \{\}, sparks && sparks\.series, vat, paywall\)/);
  assert.match(admin, /Analyse paywall indisponible[\s\S]*reste de Finance restent accessibles/);
});

test('the paywall funnel uses exact 30-day unique rollups in journey order', () => {
  const order = admin.match(/const PAYWALL_ORDER = \[([^\]]+)\]/)?.[1] || '';
  const stages = [
    'paywall_exposed',
    'checkout_started',
    'order_authorized',
    'payment_captured',
    'entitlement_activated',
    'first_play',
  ];
  let previous = -1;
  for (const stage of stages) {
    const index = order.indexOf(`'${stage}'`);
    assert.ok(index > previous, `${stage} must follow the prior funnel stage`);
    previous = index;
  }
  assert.match(admin, /const hasPwRollup = Array\.isArray\(pw\.stage_rollup\)/);
  assert.match(admin, /const pwStageTotals = Array\.isArray\(pw\.stage_totals\)/);
  assert.doesNotMatch(admin, /pwStageTotals\.reduce/);
  assert.match(admin, /Never sum users from `stage_totals`/);

  assert.match(migration, /'stage_rollup', v_stage_rollup/);
  assert.match(migration, /group by e\.event_type/);
  assert.match(migration, /count\(distinct e\.user_id\)::integer as users/);
});

test('the analysis separates the new paywall funnel from legacy conversion data', () => {
  assert.match(admin, /Funnel paywall \(30 j\)/);
  assert.match(admin, /Funnel historique \(30 j\)/);
  assert.match(admin, /Comptes uniques sur toute la fenêtre, calculés côté serveur/);
  assert.match(admin, /comptes internes exclus/);
});

test('experiment allocation, assignments, and dimensional cohorts stay visible and explicit', () => {
  assert.match(admin, /experiment\.variants/);
  assert.match(admin, /allocation_bps/);
  assert.match(admin, /assignedAccounts\(experiment\.experiment_key, variant\.variant\)/);
  assert.match(admin, /Détail par variante, placement et surface/);
  assert.match(admin, /Ne pas additionner les lignes entre placements ou surfaces/);
  for (const dimension of ['experiment_key', 'variant', 'placement', 'surface']) {
    assert.match(admin, new RegExp(`row\\.${dimension}`));
  }
});
