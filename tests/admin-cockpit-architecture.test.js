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

function loadAdminPage(documentOverride = null, env = {}) {
  const window = {};
  const context = vm.createContext({
    window,
    document: documentOverride || {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: env.location || { hash: '#admin/cockpit' },
    history: env.history || { state: null, replaceState() {} },
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

function count(html, needle) {
  return html.split(needle).length - 1;
}

function createNavigationHarness(AdminPage, main, from = 'cockpit') {
  const calls = [];
  const page = Object.create(AdminPage.prototype);
  Object.assign(page, {
    _route: from,
    _nav: 8,
    _setActiveNav(route) { calls.push(['active', route]); },
    _dressHeader() { calls.push(['dress']); },
    _partnersAbortAll() { calls.push(['partners-abort']); },
  });
  [
    '_pageCockpit',
    '_pageFinance',
    '_pageMarketing',
    '_pageClients',
    '_pagePartners',
    '_pagePartnerDetailByPublicId',
    '_pagePartnerDetail',
    '_pageSupport',
    '_pageTicket',
    '_pageClientDetail',
    '_pageProviders',
    '_pageIdentites',
    '_pageMoteur',
    '_pageSysteme',
    '_pageTelemetrie',
  ].forEach((method) => {
    page[method] = (...args) => calls.push([method, ...args]);
  });
  main.scrollTop = 500;
  main.focusCalls = 0;
  return { page, calls };
}

test('Admin Cockpit keeps its RPC and render contract', async () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const overview = { refreshed_at: '2026-08-10T10:00:00Z', billing_mrr_cents: 4200 };
  const sources = [{ id: 'source-a' }];
  const sparks = { series: { mrr_cents: [1, 2] } };
  const rpcCalls = [];
  const renderCalls = [];
  const view = { innerHTML: '' };

  Object.assign(page, {
    _nav: 4,
    _lastTs: null,
    _setCrumb(...args) { renderCalls.push(['crumb', ...args]); },
    _view() { return view; },
    async _rpc(name, params) {
      rpcCalls.push([name, params]);
      if (name === 'admin_overview') return overview;
      if (name === 'admin_sources') return sources;
      if (name === 'admin_metric_sparks') return sparks;
      throw new Error(`Unexpected RPC ${name}`);
    },
    _renderCockpitSummary(...args) { renderCalls.push(['summary', ...args]); },
    _renderOverview(...args) { renderCalls.push(['overview', ...args]); },
    _renderAlerts(...args) { renderCalls.push(['alerts', ...args]); },
  });

  await page._pageCockpit();

  assert.deepEqual(rpcCalls.map(([name]) => name), [
    'admin_overview',
    'admin_sources',
    'admin_metric_sparks',
  ]);
  assert.equal(rpcCalls[0][1], undefined);
  assert.equal(rpcCalls[1][1], undefined);
  assert.equal(rpcCalls[2][1].p_days, 14);
  assert.match(view.innerHTML, /id="cockpit-summary"/);
  assert.match(view.innerHTML, /id="admin-overview"/);
  assert.match(view.innerHTML, /id="admin-alerts"/);
  assert.equal(page._lastTs, overview.refreshed_at);
  assert.deepEqual(renderCalls.filter(([kind]) => kind !== 'crumb'), [
    ['summary', overview, sources],
    ['overview', overview, sparks.series],
    ['alerts', sources, overview],
  ]);
});

test('Admin navigation keeps every route, alias, URL and page dispatch compatible', () => {
  const state = { hash: '#admin/cockpit', urls: [] };
  const location = { get hash() { return state.hash; }, set hash(value) { state.hash = value; } };
  const history = {
    state: { app: 'norva' },
    replaceState(_state, _title, url) {
      state.urls.push(url);
      state.hash = url;
    },
  };
  const main = {
    scrollTop: 0,
    focus() { this.focusCalls += 1; },
  };
  const document = {
    getElementById() { return null; },
    querySelector(selector) { return selector === '#page-admin .crm-main' ? main : null; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document, { location, history });
  const id = '11111111-1111-4111-8111-111111111111';
  const publicId = `prt_${'a'.repeat(24)}`;
  const cases = [
    ['cockpit', '_pageCockpit', [], 'cockpit', '#admin/cockpit'],
    ['finance', '_pageFinance', [], 'finance', '#admin/finance'],
    ['finance/vat', '_pageFinance', [], 'finance', '#admin/finance/vat'],
    ['finance/paiements', '_pageFinance', [], 'finance', '#admin/finance/paiements'],
    ['finance/analyse', '_pageFinance', [], 'finance', '#admin/finance/analyse'],
    ['finance/archive', '_pageFinance', [], 'finance', '#admin/finance/archive'],
    ['finance/promos', '_pageMarketing', [], 'marketing', '#admin/marketing/promos'],
    ['marketing', '_pageMarketing', [], 'marketing', '#admin/marketing'],
    ['marketing/promos', '_pageMarketing', [], 'marketing', '#admin/marketing/promos'],
    ['marketing/notifs', '_pageMarketing', [], 'marketing', '#admin/marketing/notifs'],
    ['clients', '_pageClients', [], 'clients', '#admin/clients'],
    ['partners', '_pagePartners', [], 'partners', '#admin/partners'],
    [`partner-public:${publicId}`, '_pagePartnerDetailByPublicId', [publicId], `partner-public:${publicId}`, `#admin/partner-public:${publicId}`],
    [`partner:${id}`, '_pagePartnerDetail', [id], `partner:${id}`, `#admin/partner:${id}`],
    ['support', '_pageSupport', [], 'support', '#admin/support'],
    [`ticket:${id}`, '_pageTicket', [id], `ticket:${id}`, `#admin/ticket:${id}`],
    [`client:${id}`, '_pageClientDetail', [id], `client:${id}`, `#admin/client:${id}`],
    ['providers', '_pageProviders', [], 'providers', '#admin/providers'],
    ['identites', '_pageIdentites', [], 'identites', '#admin/identites'],
    ['moteur', '_pageMoteur', [], 'moteur', '#admin/moteur'],
    ['systeme', '_pageSysteme', [], 'systeme', '#admin/systeme'],
    ['telemetrie', '_pageTelemetrie', [], 'telemetrie', '#admin/telemetrie'],
  ];

  for (const [route, expectedMethod, expectedArgs, finalRoute, finalUrl] of cases) {
    state.hash = '#admin/cockpit';
    state.urls = [];
    const { page, calls } = createNavigationHarness(AdminPage, main);

    page._navigate(route);

    assert.equal(page._route, finalRoute, route);
    assert.equal(page._nav, 9, route);
    assert.equal(state.urls.at(-1), finalUrl, route);
    assert.equal(main.scrollTop, 0, route);
    assert.equal(main.focusCalls, 1, route);
    assert.deepEqual(
      calls.find(([kind]) => kind === expectedMethod),
      [expectedMethod, ...expectedArgs],
      route,
    );
    assert.equal(calls.filter(([kind]) => kind.startsWith('_page')).length, 1, route);
    assert.equal(calls.filter(([kind]) => kind === 'dress').length, 1, route);
  }
});

test('Admin navigation preserves Partners cleanup and fiche/ticket return targets', () => {
  const state = { hash: '#admin/partners' };
  const location = { get hash() { return state.hash; } };
  const history = { state: null, replaceState(_state, _title, url) { state.hash = url; } };
  const main = { scrollTop: 0, focus() {} };
  const document = {
    getElementById() { return null; },
    querySelector() { return main; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document, { location, history });
  const id = '22222222-2222-4222-8222-222222222222';
  const { page, calls } = createNavigationHarness(AdminPage, main, 'partners');
  page._partnersSearchDebounce = 1;
  page._partnersRoutesDebounce = 2;
  page._partnersPayoutOnboardingDebounce = 3;
  page._partnersFiscalDebounce = 4;

  page._navigate(`client:${id}`);

  assert.equal(page._ficheReturn, 'partners');
  assert.equal(page._partnersSearchDebounce, null);
  assert.equal(page._partnersRoutesDebounce, null);
  assert.equal(page._partnersPayoutOnboardingDebounce, null);
  assert.equal(page._partnersFiscalDebounce, null);
  assert.equal(calls.filter(([kind]) => kind === 'partners-abort').length, 1);

  page._navigate(`ticket:${id}`);
  assert.equal(page._ticketReturn, `client:${id}`);
});

test('Admin Cockpit summary remains recovery-aware and actionable', () => {
  const summary = { className: '', innerHTML: '' };
  const alerts = {
    scrollCalls: [],
    scrollIntoView(options) { this.scrollCalls.push(options); },
  };
  const cta = {
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
  const document = {
    getElementById(id) {
      if (id === 'cockpit-summary') return summary;
      if (id === 'cs-cta') return summary.innerHTML.includes('id="cs-cta"') ? cta : null;
      if (id === 'admin-alerts') return alerts;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);

  page._renderCockpitSummary({
    billing_mrr_cents: 125000,
    billing_past_due: 1,
    cron_ko: 0,
    cron_fails_24h: 9,
    gensubs_failed: 0,
    refreshed_at: '2026-08-10T10:00:00Z',
  }, [{ incomplete: true }]);

  assert.equal(summary.className, 'cockpit-summary alert');
  assert.match(summary.innerHTML, /Dégradé/);
  assert.match(summary.innerHTML, /MRR/);
  assert.match(summary.innerHTML, /Dernier refresh/);
  assert.match(summary.innerHTML, /id="cs-cta"/);
  cta.listeners.click();
  assert.equal(alerts.scrollCalls.length, 1);
  assert.equal(alerts.scrollCalls[0].behavior, 'smooth');
  assert.equal(alerts.scrollCalls[0].block, 'center');

  page._renderCockpitSummary({
    billing_mrr_cents: 125000,
    billing_past_due: 0,
    cron_ko: 0,
    cron_fails_24h: 9,
    gensubs_failed: 0,
  }, []);
  assert.equal(summary.className, 'cockpit-summary ok');
  assert.match(summary.innerHTML, /Tout est sain/);
  assert.doesNotMatch(summary.innerHTML, /id="cs-cta"/);
});

test('Admin Cockpit exposes only actionable priority exceptions and keeps canonical KPIs', () => {
  const overview = { innerHTML: '' };
  const document = {
    getElementById(id) { return id === 'admin-overview' ? overview : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  page._renderOverview({
    billing_mrr_cents: 125000,
    billing_trialing: 3,
    billing_active: 42,
    billing_past_due: 2,
    billing_conversions_7d: 6,
    billing_collected_30d_cents: 250000,
    sources_total: 8,
    sources_incomplete: 1,
    sources_error: 2,
    cron_active: 7,
    cron_paused: 1,
    cron_fails_24h: 3,
    identities_active: 6,
    titles_movie: 100,
    titles_series: 50,
    gensubs_ready: 10,
    gensubs_processing: 1,
    gensubs_failed: 1,
  });

  assert.match(overview.innerHTML, /Signaux prioritaires/);
  assert.match(overview.innerHTML, /exceptions actionnables/i);
  assert.match(overview.innerHTML, /Paiements à régulariser/);
  assert.match(overview.innerHTML, /Sources à réparer/);
  assert.match(overview.innerHTML, /Crons à relancer/);
  assert.match(overview.innerHTML, /data-route="finance\/paiements"/);
  assert.match(overview.innerHTML, /data-route="providers"/);
  assert.match(overview.innerHTML, /data-route="systeme"/);
  assert.equal(count(overview.innerHTML, 'kpi kpi-exception alert'), 3);
  assert.equal(count(overview.innerHTML, '>MRR<'), 1);
  assert.equal(count(overview.innerHTML, '>Actifs payants<'), 1);
  assert.equal(count(overview.innerHTML, '>Conversions 7 j<'), 1);
  assert.equal(count(overview.innerHTML, '>Échecs paiement<'), 1);
  assert.equal(count(overview.innerHTML, '>Sources en erreur<'), 1);
  assert.equal(count(overview.innerHTML, '>Échecs 24 h<'), 1);
  assert.match(overview.innerHTML, />En essai</);
  assert.match(overview.innerHTML, />Encaissé 30 j</);
  assert.match(overview.innerHTML, />Sync incomplète</);
  assert.match(overview.innerHTML, />Identités</);
  assert.match(overview.innerHTML, />Prêts</);
});

test('Admin Cockpit priority section collapses to a healthy state without exceptions', () => {
  const overview = { innerHTML: '' };
  const document = {
    getElementById(id) { return id === 'admin-overview' ? overview : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  page._renderOverview({
    billing_mrr_cents: 125000,
    billing_active: 42,
    billing_past_due: 0,
    billing_conversions_7d: 6,
    sources_error: 0,
    cron_ko: 0,
    cron_fails_24h: 3,
  });

  assert.match(overview.innerHTML, /Aucune exception actionnable/);
  assert.doesNotMatch(overview.innerHTML, /kpi-exception(?:\s|")/);
  assert.equal(count(overview.innerHTML, '>MRR<'), 1);
  assert.equal(count(overview.innerHTML, '>Actifs payants<'), 1);
  assert.equal(count(overview.innerHTML, '>Conversions 7 j<'), 1);
});

test('Admin navigation uses a compatible Cockpit-first facade and preserves _navigate', () => {
  const state = { hash: '#admin/cockpit' };
  const location = { get hash() { return state.hash; } };
  const history = { state: null, replaceState(_state, _title, url) { state.hash = url; } };
  const main = { scrollTop: 0, focus() {} };
  const document = {
    getElementById() { return null; },
    querySelector() { return main; },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(document, { location, history });
  const { page, calls } = createNavigationHarness(AdminPage, main);

  assert.equal(typeof page._navigate, 'function');
  page._navigate('cockpit');

  const facade = page._adminNavigation;
  assert.ok(facade);
  assert.equal(typeof facade.navigate, 'function');
  assert.equal(facade.handles('cockpit'), true);
  assert.equal(facade.handles('clients'), false);
  assert.equal(calls.filter(([kind]) => kind === '_pageCockpit').length, 1);

  page._navigate('clients');
  assert.equal(page._adminNavigation, facade);
  assert.equal(calls.filter(([kind]) => kind === '_pageClients').length, 1);
});
