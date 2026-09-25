const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const acorn = require('acorn');
const catalog = require('../scripts/i18n/catalog.cjs').load();
const html = fs.readFileSync(path.join(__dirname, '../public/subscription.html'), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
const ast = acorn.parse(script, { ecmaVersion: 'latest' });
const functions = new Map();
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, script.slice(node.start, node.end));
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
}
visit(ast);
function node() {
  return { children: [], textContent: '', appendChild(child) { this.children.push(child); },
    setAttribute() {}, classList: { add() {} } };
}
function context() {
  const ctx = vm.createContext({
    document: { documentElement: { lang: 'fr' }, createElement: node, createDocumentFragment: node },
    storeNote: node(),
    NorvaI18n: { t(key, options) {
      return (catalog[key]?.fr || options.defaultValue).replace(/\{\{(\w+)\}\}/g, (_, name) => options[name]);
    } },
  });
  for (const name of ['copy', 'el', 'fmtDate', 'planLabel', 'detailRows', 'showActionError']) vm.runInContext(functions.get(name), ctx);
  return ctx;
}
for (const status of ['active', 'cancelled_at_period_end']) {
  test(`${status} shows the current access boundary rather than an old trial date`, () => {
    const ctx = context();
    const result = ctx.detailRows({ status, planCode: 'plus', projection: {
      provider: 'revolut', trial_ends_at: '2026-10-01T12:00:00Z', current_period_end: '2026-11-01T12:00:00Z',
    } });
    const rows = result.children.map(row => row.children.map(child => child.textContent));
    assert.deepEqual(rows[0], ['Forfait', 'Norva Plus']);
    assert.equal(rows[2][1], '1 novembre 2026');
    if (status === 'cancelled_at_period_end') assert.deepEqual(rows[1], ['Statut', 'Renouvellement annulé']);
    assert.ok(!JSON.stringify(rows).includes('cancelled_at_period_end'));
  });
}
test('a failed cancellation never exposes backend diagnostics to the customer', () => {
  const ctx = context();
  const message = ctx.showActionError('cancel', new Error('database internal identifier private-test-value'));
  assert.match(message, /Réessayez/);
  assert.doesNotMatch(message, /database|private-test-value/);
  assert.equal(ctx.storeNote.textContent, message);
});
