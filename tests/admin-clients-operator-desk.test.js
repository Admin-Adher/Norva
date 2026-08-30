'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/pages/AdminPage.js'),
  'utf8',
);

function fakeElement() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    children: [],
    dataset: {},
    attributes: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function loadAdminPage(documentOverride) {
  const window = {
    matchMedia() { return { matches: false }; },
    addEventListener() {},
    removeEventListener() {},
  };
  const history = {
    state: null,
    replaceState(state) { this.state = state; },
    pushState(state) { this.state = state; },
    back() {},
  };
  const context = vm.createContext({
    window,
    document: documentOverride || {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { href: 'https://norva.tv/app#admin/clients', hash: '#admin/clients' },
    history,
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Map,
    Set,
    Promise,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

test('Clients page renders the approved operator desk without list charts', () => {
  const view = fakeElement();
  const elements = Object.fromEntries([
    'admin-users-sort', 'admin-users-search', 'admin-users-country', 'admin-users-tag',
    'admin-users-csv', 'admin-users-prev', 'admin-users-next',
  ].map((id) => [id, fakeElement()]));
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  const calls = [];
  Object.assign(page, {
    _users: { page: 0, limit: 25, search: '', sort: 'created_desc', tagId: '', billing: '', country: '', total: 0, selectedId: '', inspectorOpen: false },
    _usersRows: [],
    _allTags: [],
    _countries: [],
    _setCrumb(value) { calls.push(['crumb', value]); },
    _view() { return view; },
    _finishCloseClientSheet() {},
    _loadUsers() { calls.push(['users']); },
    _loadClientSummary() { calls.push(['summary']); },
  });

  page._pageClients();

  assert.match(view.innerHTML, /client-desk-workspace/);
  assert.match(view.innerHTML, /Vues enregistrées/);
  assert.match(view.innerHTML, /id="client-desk-inspector"/);
  assert.match(view.innerHTML, /aucune action automatique/);
  assert.doesNotMatch(view.innerHTML, /admin-clients-charts|admin-clients-kpis|admin-users-billing/);
  assert.doesNotMatch(source, /_loadClientCharts/);
  assert.deepEqual(calls, [['crumb', 'Clients'], ['users'], ['summary']]);
});

test('Clients compact summary uses only admin_overview and populates saved-view counts', async () => {
  const summary = fakeElement();
  const counts = Object.fromEntries(['all', 'active', 'trialing', 'past_due', 'cancel_pending'].map((key) => [key, fakeElement()]));
  const document = {
    getElementById(id) { return id === 'admin-clients-summary' ? summary : null; },
    querySelector(selector) {
      const match = selector.match(/data-client-view-count="([^"]+)"/);
      return match ? counts[match[1]] || null : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  const rpcCalls = [];
  Object.assign(page, {
    _route: 'clients',
    _nav: 4,
    async _rpc(name) {
      rpcCalls.push(name);
      return {
        users_total: 31,
        users_active_7d: 24,
        billing_active: 18,
        billing_trialing: 4,
        billing_past_due: 2,
        billing_cancel_pending: 1,
      };
    },
  });

  await page._loadClientSummary();

  assert.deepEqual(rpcCalls, ['admin_overview']);
  assert.match(summary.innerHTML, /Actifs sur 7 j/);
  assert.match(summary.innerHTML, /Paiement à vérifier/);
  assert.equal(summary.attributes.get('aria-busy'), 'false');
  assert.equal(counts.all.textContent, '31');
  assert.equal(counts.active.textContent, '18');
  assert.equal(counts.past_due.textContent, '2');
});

test('Client priorities are explicit, deterministic and never infer risk from geography', () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);

  assert.equal(page._clientPriority({ banned: true, billing_status: 'past_due', email_confirmed: false }).label, 'Suspendu');
  assert.equal(page._clientPriority({ billing_status: 'grace', email_confirmed: true }).label, 'Paiement');
  assert.equal(page._clientPriority({ email_confirmed: false }).label, 'Email non vérifié');
  assert.equal(page._clientPriority({ email_confirmed: true, signup_attribution: { capture_stage: 'unavailable' } }).label, 'Origine indisponible');
  assert.equal(page._clientPriority({ email_confirmed: true, country_code: 'ZZ', last_sign_in_at: '2026-08-29T08:00:00Z' }).label, 'Sain');
});

test('Client rows render as a keyboard list with a contextual inspector, not a wide table', () => {
  const users = fakeElement();
  const inspector = fakeElement();
  const document = {
    getElementById(id) {
      if (id === 'admin-users') return users;
      if (id === 'client-desk-inspector') return inspector;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  Object.assign(page, {
    _users: { selectedId: '', inspectorOpen: false },
    _usersRows: [],
  });
  const row = {
    user_id: '11111111-1111-4111-8111-111111111111',
    email: 'client@example.fr',
    created_at: '2026-08-28T15:42:00Z',
    last_sign_in_at: '2026-08-29T08:00:00Z',
    email_confirmed: true,
    billing_status: 'past_due',
    plan_code: 'family',
    sources_count: 2,
    country_code: 'FR',
    country_source: 'store',
    tags: [{ label: 'Onboarding' }],
    signup_attribution: { signup_platform: 'mobile_android', signup_surface: 'account' },
  };

  page._renderUsers([row]);

  assert.match(users.innerHTML, /role="listbox"/);
  assert.match(users.innerHTML, /role="option"/);
  assert.match(users.innerHTML, /client-priority-bar danger/);
  assert.match(users.innerHTML, /Contrôler le statut/);
  assert.doesNotMatch(users.innerHTML, /<table/);
  assert.match(inspector.innerHTML, /Action potentielle/);
  assert.match(inspector.innerHTML, /Ouvrir le dossier complet/);
  assert.match(inspector.innerHTML, /Bannir le client/);
  assert.match(inspector.innerHTML, /Supprimer définitivement/);
  assert.match(inspector.innerHTML, /data-client-account-action="delete"/);
  assert.match(inspector.innerHTML, /App Android mobile · Compte/);
});

test('Client inspector exposes unban instead of ban for an already banned account', () => {
  const inspector = fakeElement();
  const document = {
    getElementById(id) { return id === 'client-desk-inspector' ? inspector : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);

  page._renderClientInspector({
    user_id: '22222222-2222-4222-8222-222222222222',
    email: 'banni@example.fr',
    banned: true,
    email_confirmed: true,
    sources_count: 0,
  });

  assert.match(inspector.innerHTML, /client-account-state is-banned">Banni/);
  assert.match(inspector.innerHTML, /data-client-account-action="unban"/);
  assert.match(inspector.innerHTML, /Lever le bannissement/);
  assert.doesNotMatch(inspector.innerHTML, />Bannir le client</);
});

test('Mobile client inspector contract includes focus isolation and Back handling', () => {
  const start = source.indexOf('    _openClientSheet(trigger)');
  const section = source.slice(start, source.indexOf('    _renderBulkBar()', start));
  assert.match(section, /_isolateModalBackground\(layer\)/);
  assert.match(section, /aria-modal/);
  assert.match(section, /GoBack/);
  assert.match(section, /BrowserBack/);
  assert.match(section, /history\.pushState/);
  assert.match(section, /restoreFocus/);
});

test('Intermediate client layout contains rows before the inspector', () => {
  assert.match(source, /\.client-desk-list-pane\{[^}]*overflow:hidden/);
  assert.match(source, /\.client-desk-row\{[^}]*overflow:hidden/);
  assert.match(source, /@media\(max-width:1380px\)\{[\s\S]*grid-template-columns:minmax\(0,1\.5fr\) minmax\(0,\.75fr\) minmax\(0,\.9fr\)/);
  assert.match(source, /\.client-desk-list-head>:nth-child\(5\)[^}]*\.client-desk-row>:nth-child\(5\)\{display:none/);
  assert.match(source, /@media\(max-width:900px\)\{[\s\S]*\.client-desk-row>:nth-child\(5\)\{display:block/);
  assert.match(source, /\.client-desk-inspector\{[^}]*overflow-x:hidden/);
});
