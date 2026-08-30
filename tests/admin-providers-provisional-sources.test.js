'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const source = read('public/js/pages/AdminPage.js');
const migration = read('supabase/migrations/20260830123000_admin_sources_provisional_v2.sql');
const completeMigration = read('supabase/migrations/20260830123737_admin_sources_complete_v3.sql');

function fakeElement() {
  const classes = new Set();
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    attributes: new Map(),
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
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
  const document = documentOverride || {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { href: 'https://norva.tv/app#admin/providers', hash: '#admin/providers' },
    history: { state: null, replaceState() {}, pushState() {}, back() {} },
    navigator: { clipboard: { async writeText() {} } },
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

test('Providers v2 contract appends bounded provisional sources from authoritative links', () => {
  assert.match(migration, /create or replace function public\.admin_sources_v2\(\)/);
  assert.match(migration, /stable[\s\S]*security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /if not public\.is_admin\(\)/);
  assert.match(migration, /v_cached := coalesce\(public\.admin_sources\(\)/);
  assert.match(migration, /join public\.catalog_source_provider_identity_candidates candidate/);
  assert.match(migration, /left join public\.catalog_source_provider_identities verified[\s\S]*verified\.source_id = source\.id[\s\S]*verified\.user_id = source\.user_id/);
  assert.match(migration, /where source\.deleted_at is null[\s\S]*verified\.source_id is null/);
  assert.match(migration, /'resolution_state', 'provisional'/);
  assert.match(migration, /'evidence_count', candidate\.evidence_count/);
  assert.match(migration, /'required_evidence', candidate\.required_evidence/);
  assert.match(migration, /candidate\.provisional_rank <= v_provisional_sample_limit/);
  assert.match(migration, /'provisional_source_count'/);
  assert.match(migration, /'provisional_sources_emitted'/);
  assert.match(migration, /'provisional_sources_truncated'/);
  assert.doesNotMatch(migration, /provider_key/);
  assert.doesNotMatch(migration, /last_error/);
  assert.match(migration, /revoke all on function public\.admin_sources_v2\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_sources_v2\(\)[\s\S]*to authenticated/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('Providers v3 starts from every live Xtream source and attaches authoritative state', () => {
  assert.match(completeMigration, /create or replace function public\.admin_sources_v3\(\)/);
  assert.match(completeMigration, /stable[\s\S]*security definer[\s\S]*set search_path = ''/);
  assert.match(completeMigration, /if not public\.is_admin\(\)/);
  assert.match(completeMigration, /from public\.cloud_sources source[\s\S]*where source\.deleted_at is null[\s\S]*source\.source_type = 'xtream'/);
  assert.match(completeMigration, /left join public\.catalog_source_provider_identities verified[\s\S]*verified\.source_id = source\.id[\s\S]*verified\.user_id = source\.user_id/);
  assert.match(completeMigration, /left join public\.catalog_source_provider_identity_candidates candidate[\s\S]*candidate\.source_id = source\.id[\s\S]*candidate\.user_id = source\.user_id/);
  assert.match(completeMigration, /join live_sources source[\s\S]*source\.source_id = item\.source_id[\s\S]*source\.user_id = item\.user_id/);
  assert.match(completeMigration, /join live_sources source[\s\S]*source\.source_id = variant\.source_id[\s\S]*source\.user_id = variant\.user_id/);
  assert.match(completeMigration, /'inventory_scope', 'all_live_xtream_sources'/);
  assert.match(completeMigration, /'source_count', count\(\*\)/);
  assert.match(completeMigration, /'verified_source_count'/);
  assert.match(completeMigration, /'provisional_source_count'/);
  assert.match(completeMigration, /'unresolved_source_count'/);
  assert.doesNotMatch(completeMigration, /public\.admin_sources\(\)|provider_key|last_error/);
  assert.doesNotMatch(completeMigration, /limit\s+\d+/i);
  assert.match(completeMigration, /revoke all on function public\.admin_sources_v3\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(completeMigration, /grant execute on function public\.admin_sources_v3\(\)[\s\S]*to authenticated/);
  assert.match(completeMigration, /notify pgrst, 'reload schema'/);
});

test('Providers loader prefers complete v3 and falls back only while PostgREST loads it', async () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const calls = [];
  Object.assign(page, {
    async _rpc(name) {
      calls.push(name);
      return {
        schema_version: 3,
        generated_at: '2026-08-30T10:00:00Z',
        inventory_scope: 'all_live_xtream_sources',
        statistics_source: 'live_indexed_aggregates',
        summary: {
          source_count: 2,
          verified_source_count: 1,
          provisional_source_count: 1,
          unresolved_source_count: 0,
        },
        sources: [{ source_id: 'verified-1' }, { source_id: 'provisional-1' }],
      };
    },
  });

  const rows = await page._loadProviderSources();
  assert.deepEqual(calls, ['admin_sources_v3']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_id, 'verified-1');
  assert.equal(page._providerSourcesMeta.sourceCount, 2);
  assert.equal(page._providerSourcesMeta.verifiedSourceCount, 1);
  assert.equal(page._providerSourcesMeta.provisionalSourceCount, 1);
  assert.equal(page._providerSourcesMeta.sourceInventoryComplete, true);
  assert.equal(page._providerSourcesLegacyFallback, false);

  const fallbackCalls = [];
  const fallback = Object.create(AdminPage.prototype);
  Object.assign(fallback, {
    async _rpc(name) {
      fallbackCalls.push(name);
      if (name === 'admin_sources_v3') {
        const error = new Error('function missing');
        error.payload = { code: 'PGRST202' };
        throw error;
      }
      return {
        schema_version: 2,
        generated_at: '2026-08-30T10:00:00Z',
        sources: [{ source_id: 'v2-source' }],
        provisional_source_count: 0,
        provisional_sources_emitted: 0,
        provisional_sources_truncated: false,
        provisional_sample_limit: 100,
      };
    },
  });

  const fallbackRows = await fallback._loadProviderSources();
  assert.deepEqual(fallbackCalls, ['admin_sources_v3', 'admin_sources_v2']);
  assert.equal(fallbackRows[0].source_id, 'v2-source');
  assert.equal(fallback._providerSourcesLegacyFallback, true);
  assert.equal(fallback._providerSourcesMeta.contractVersion, 2);
  assert.equal(fallback._providerSourcesMeta.sourceInventoryComplete, false);

  const legacyCalls = [];
  const legacy = Object.create(AdminPage.prototype);
  Object.assign(legacy, {
    async _rpc(name) {
      legacyCalls.push(name);
      if (name === 'admin_sources_v3' || name === 'admin_sources_v2') {
        const error = new Error('function missing');
        error.payload = { code: 'PGRST202' };
        throw error;
      }
      return [{ source_id: 'legacy-source' }];
    },
  });
  const legacyRows = await legacy._loadProviderSources();
  assert.deepEqual(legacyCalls, ['admin_sources_v3', 'admin_sources_v2', 'admin_sources']);
  assert.equal(legacyRows[0].source_id, 'legacy-source');
  assert.equal(legacy._providerSourcesMeta.contractVersion, 1);

  const fatalCalls = [];
  const fatal = Object.create(AdminPage.prototype);
  Object.assign(fatal, {
    async _rpc(name) {
      fatalCalls.push(name);
      const error = new Error('forbidden');
      error.payload = { code: '42501' };
      throw error;
    },
  });
  await assert.rejects(() => fatal._loadProviderSources(), /forbidden/);
  assert.deepEqual(fatalCalls, ['admin_sources_v3']);
});

test('Providers rendering makes provisional isolation and progress explicit', () => {
  const elements = {
    'admin-sources': fakeElement(),
    'prov-bulk-resync': fakeElement(),
    'prov-kpis': fakeElement(),
    'prov-scope': fakeElement(),
  };
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const page = Object.create(AdminPage.prototype);
  Object.assign(page, {
    _provFilter: 'provisional',
    _provSearch: '',
    _providerSourcesLegacyFallback: false,
    _providerSourcesMeta: {
      sourceInventoryComplete: true,
      sourceCount: 2,
      provisionalSourceCount: 3,
      provisionalSourcesEmitted: 2,
      provisionalSourcesTruncated: true,
      provisionalSampleLimit: 100,
    },
  });
  const rows = [{
    source_id: 'source-provisional',
    user_id: 'user-1',
    owner_email: '<img src=x onerror=alert(1)>',
    display_name: 'Xtream Demo <script>alert(1)</script>',
    source_type: 'xtream',
    sync_status: 'ready',
    resolution_state: 'provisional',
    evidence_count: 1,
    required_evidence: 32,
    movie_titles: 0,
    series_titles: 0,
    media_items: 1,
    provider_key: 'must-never-render',
  }, {
    source_id: 'source-unresolved',
    display_name: 'Sans empreinte',
    sync_status: 'ready',
    resolution_state: 'unresolved',
  }];
  page._sources = rows;

  page._renderSources(rows);
  const html = elements['admin-sources'].innerHTML;
  assert.match(html, /Xtream Demo &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Provisoire · <b>1\/32 signaux<\/b>/);
  assert.match(html, /Traitements isolés à cette source jusqu’à vérification/);
  assert.match(html, /relancer la résolution/);
  assert.doesNotMatch(html, /Sans empreinte/);
  assert.doesNotMatch(html, /must-never-render/);
  assert.doesNotMatch(html, /<script>|<img src=x/);

  page._renderProvKpis({ identities_active: 4, titles_movie: 10, titles_series: 5 }, rows, {});
  assert.match(elements['prov-kpis'].innerHTML, /Provisoires/);
  assert.match(elements['prov-kpis'].innerHTML, /Non résolues/);

  page._renderProviderScope();
  assert.match(elements['prov-scope'].innerHTML, /2 source\(s\) provisoire\(s\) affichée\(s\) sur 3/);
  assert.equal(elements['prov-scope'].hidden, false);
  assert.equal(elements['prov-scope'].classList.contains('is-warn'), true);
});

test('Providers styles keep search and row actions touch-sized and focused', () => {
  const start = source.indexOf('/* Sources triage console');
  const end = source.indexOf('/* Identités:', start);
  assert.ok(start > 0 && end > start);
  const css = source.slice(start, end);

  assert.match(css, /\.src-toolbar \.sup-search\{[^}]*min-height:44px/);
  assert.match(css, /\.src-mini,#page-admin \.src-acts \.resync-btn\{[^}]*min-height:44px/);
  assert.match(css, /\.src-row\.prov\{[^}]*var\(--adm-amber\)/);
  assert.match(css, /\.resync-btn:focus-visible[^{]*\{[^}]*outline:2px solid var\(--adm-blue\)/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

test('Providers delivery updates both frontend cache-busting links', () => {
  const adminSource = read('public/js/pages/AdminPage.js').replace(/\r\n/g, '\n');
  const appSource = read('public/js/app.js').replace(/\r\n/g, '\n');
  const shell = read('public/app.html');
  const adminHash = crypto.createHash('sha256').update(adminSource).digest('hex').slice(0, 10);
  const appHash = crypto.createHash('sha256').update(appSource).digest('hex').slice(0, 10);

  assert.match(appSource, new RegExp(`/js/pages/AdminPage\\.js\\?v=${adminHash}`));
  assert.match(shell, new RegExp(`/js/app\\.js\\?v=${appHash}`));
});
