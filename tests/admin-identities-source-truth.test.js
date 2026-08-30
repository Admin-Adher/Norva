'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const source = read('public/js/pages/AdminPage.js');
const migration = read('supabase/migrations/20260830080313_admin_identities_verified_source_truth_v2.sql');

function fakeElement() {
  return {
    innerHTML: '',
    textContent: '',
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
    location: { href: 'https://norva.tv/app#admin/identites', hash: '#admin/identites' },
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

test('Identities RPC uses only server-verified source links and excludes deleted sources', () => {
  assert.match(migration, /create or replace function public\.admin_identities_v2\(\)/);
  assert.match(migration, /stable[\s\S]*security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /if not public\.is_admin\(\)/);
  assert.match(migration, /join public\.catalog_source_provider_identities link[\s\S]*link\.source_id = source\.source_id[\s\S]*link\.user_id = source\.user_id/);
  assert.match(migration, /where source\.deleted_at is null/);
  assert.doesNotMatch(migration, /display_name\s+in\s*\(/i);
  assert.match(migration, /left join public\.catalog_source_provider_identities link[\s\S]*where link\.source_id is null/);
  assert.match(migration, /'resolution_state', case when source\.identity_id is null then 'unresolved' else 'verified' end/);
  assert.match(migration, /'deleted_source_count_excluded'/);
  assert.match(migration, /'intake_source_count'/);
  assert.match(migration, /'intake_sample_limit', 100/);
  assert.match(migration, /revoke all on function public\.admin_identities_v2\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_identities_v2\(\)[\s\S]*to authenticated/);
  assert.match(migration, /return v_result;\s*end;\s*\$function\$/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.doesNotMatch(migration, /'sync_error'\s*,/);
});

test('Identities workspace exposes the intake queue, compatibility fallback and bounded refresh', () => {
  const start = source.indexOf('    _pageIdentites()');
  const end = source.indexOf('    // ── Page: Moteur', start);
  assert.ok(start > 0 && end > start);
  const identities = source.slice(start, end);

  assert.match(identities, /Sources non résolues \/ récemment ajoutées/);
  assert.match(identities, /Rattachements vérifiés/);
  assert.match(identities, /this\._rpc\('admin_identities_v2'\)/);
  assert.match(identities, /PGRST202[\s\S]*this\._rpc\('admin_identities'\)/);
  assert.match(identities, /window\.setInterval[\s\S]*30000/);
  assert.match(identities, /document\.visibilityState !== 'visible'/);
  assert.match(identities, /sourceCount > sources\.length/);
  assert.match(identities, /driverSourceCountOf\(it\) > 0/);
  assert.doesNotMatch(identities, /AdminPage\.esc\(error\.message|JSON\.stringify\(error/);
  assert.match(source, /from === 'identites' && route !== 'identites'[\s\S]*window\.clearInterval\(this\._identityPoll\)/);
});

test('Identities styles keep controls touch-sized, responsive and visibly focused', () => {
  const start = source.indexOf('#page-admin .id-integrity');
  const end = source.indexOf('/* Système: health gauge', start);
  assert.ok(start > 0 && end > start);
  const css = source.slice(start, end);

  assert.match(css, /\.id-intake-open\{[^}]*min-height:44px/);
  assert.match(css, /#id-search[^}]*min-height:44px/);
  assert.match(css, /\.id-intake-open:focus-visible\{[^}]*outline:2px solid var\(--adm-blue\)/);
  assert.match(css, /@media\(max-width:920px\)/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

test('Identity rendering deduplicates recent unresolved sources and reports exact counts', () => {
  const elements = Object.fromEntries([
    'admin-identities',
    'admin-identity-intake',
    'id-intake-count',
    'id-kpis',
    'id-integrity-status',
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
  const verified = {
    source_id: 'source-gotv',
    display_name: 'Gotv',
    owner_email: 'client@example.fr',
    source_type: 'xtream',
    sync_status: 'ready',
    enabled: true,
    created_at: '2026-08-19T12:00:00Z',
    last_synced_at: '2026-08-30T07:00:00Z',
    identity_name: 'Panel vérifié',
    resolution_state: 'verified',
  };
  const unresolved = {
    source_id: 'source-pending',
    display_name: 'Source en attente',
    owner_email: '<img src=x onerror=alert(1)>',
    source_type: 'xtream',
    sync_status: 'pending',
    enabled: true,
    created_at: '2026-08-30T07:30:00Z',
    resolution_state: 'unresolved',
  };
  Object.assign(page, {
    _idFilter: 'driver',
    _idSearch: '',
    _identityRecentWindowDays: 30,
    _identityLegacyFallback: false,
    _identitySummary: {
      active_identity_count: 1,
      mirror_identity_count: 0,
      linked_source_count: 1,
      unresolved_source_count: 1,
      recent_source_count: 2,
      intake_source_count: 2,
      disabled_source_count: 0,
      deleted_source_count_excluded: 1,
    },
    _identityRecentSources: [verified, unresolved],
    _identityUnresolvedSources: [unresolved],
  });
  const identities = [{
    id: 'identity-verified',
    display_name: 'Panel vérifié',
    status: 'active',
    first_seen: '2026-08-01T00:00:00Z',
    last_seen: '2026-08-30T07:00:00Z',
    key_count: 3,
    brands: ['Gotv'],
    source_count: 1,
    account_count: 1,
    driver_source_count: 1,
    sources: [{ ...verified, user_id: 'user-1', is_driver: false }],
  }];

  page._renderIdentities(identities);

  assert.equal(elements['id-intake-count'].textContent, '2');
  assert.equal((elements['admin-identity-intake'].innerHTML.match(/class="id-intake-row/g) || []).length, 2);
  assert.match(elements['admin-identity-intake'].innerHTML, /Source en attente/);
  assert.match(elements['admin-identity-intake'].innerHTML, /Empreinte non résolue/);
  assert.match(elements['admin-identity-intake'].innerHTML, /Voir dans Providers/);
  assert.doesNotMatch(elements['admin-identity-intake'].innerHTML, /<img src=x/);
  assert.match(elements['admin-identity-intake'].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(elements['admin-identities'].innerHTML, /Panel vérifié/);
  assert.match(elements['admin-identities'].innerHTML, /<b>1<\/b> source\(s\) vérifiée\(s\)/);
  assert.match(elements['id-integrity-status'].innerHTML, /1 source supprimée exclue/);
  assert.doesNotMatch(elements['admin-identities'].innerHTML + elements['admin-identity-intake'].innerHTML, /Source supprimée fantôme/);

  page._identityLegacyFallback = true;
  page._identityRecentSources = [];
  page._identityUnresolvedSources = [];
  page._renderIdentityIntake('');
  assert.equal(elements['id-intake-count'].textContent, '—');
  assert.match(elements['admin-identity-intake'].innerHTML, /File temporairement indisponible/);
  assert.doesNotMatch(elements['admin-identity-intake'].innerHTML, /File de rattachement à jour/);
});

test('Identity loader prefers v2 and only falls back when PostgREST has not loaded it yet', async () => {
  const intake = fakeElement();
  const document = {
    getElementById(id) { return id === 'admin-identity-intake' ? intake : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const AdminPage = loadAdminPage(document);
  const calls = [];
  const page = Object.create(AdminPage.prototype);
  Object.assign(page, {
    _route: 'identites',
    _nav: 7,
    _identityLoadInFlight: false,
    async _rpc(name) {
      calls.push(name);
      return {
        schema_version: 2,
        summary: { unresolved_source_count: 1 },
        identities: [{ id: 'identity-v2' }],
        unresolved_sources: [{ source_id: 'pending' }],
        recent_sources: [{ source_id: 'recent' }],
        recent_window_days: 30,
      };
    },
    _dressHeader() {},
    _renderIdentities(list) { this.rendered = list; },
  });

  await page._loadIdentities();

  assert.deepEqual(calls, ['admin_identities_v2']);
  assert.equal(page._identities[0].id, 'identity-v2');
  assert.equal(page._identityUnresolvedSources[0].source_id, 'pending');
  assert.equal(page._identityLegacyFallback, false);

  const fallbackCalls = [];
  const fallback = Object.create(AdminPage.prototype);
  Object.assign(fallback, {
    _route: 'identites',
    _nav: 8,
    _identityLoadInFlight: false,
    async _rpc(name) {
      fallbackCalls.push(name);
      if (name === 'admin_identities_v2') {
        const error = new Error('function missing');
        error.payload = { code: 'PGRST202' };
        throw error;
      }
      return [{ id: 'legacy-identity' }];
    },
    _dressHeader() {},
    _renderIdentities(list) { this.rendered = list; },
  });

  await fallback._loadIdentities();

  assert.deepEqual(fallbackCalls, ['admin_identities_v2', 'admin_identities']);
  assert.equal(fallback._identities[0].id, 'legacy-identity');
  assert.equal(fallback._identityLegacyFallback, true);
});
