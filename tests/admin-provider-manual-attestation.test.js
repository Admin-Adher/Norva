'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
  .replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260830121746_admin_attested_provider_identity.sql');
const adminPageSource = read('public/js/pages/AdminPage.js');

function section(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert.ok(start >= 0, `missing section start: ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing section end: ${endNeedle}`);
  return text.slice(start, end);
}

function loadAdminPage() {
  const window = {
    matchMedia() { return { matches: false }; },
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
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
  vm.runInContext(adminPageSource, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

test('manual attestation adds an explicit source-local verification method', () => {
  assert.match(migration, /add column if not exists verification_method text not null default 'automatic'/);
  assert.match(migration, /check \(verification_method in \('automatic', 'admin_attested_source_local'\)\)/);

  const resolver = section(
    migration,
    'create or replace function public.norva_resolve_provider_identity(',
    'revoke all on function public.norva_resolve_provider_identity(',
  );
  assert.match(resolver, /if v_verification_method = 'automatic' then/);
  const manualExistingLink = section(resolver, '    else\n      insert into public.catalog_provider_identities as alias', '    end if;');
  assert.doesNotMatch(manualExistingLink, /identity_id\s*=/);
  assert.match(resolver, /v_min_sample constant integer := 32/);
  assert.match(resolver, /v_threshold constant numeric := 0\.5/);
  assert.match(resolver, /verification_method = 'automatic'/);
});

test('admin attestation is audited, bounded and cannot seed cross-account fanout', () => {
  const attestation = section(
    migration,
    'create or replace function public.admin_attest_source_provider_identity(',
    'revoke all on function public.admin_attest_source_provider_identity(',
  );
  assert.match(attestation, /security definer[\s\S]*set search_path = ''/);
  assert.match(attestation, /if not public\.is_admin\(\)/);
  assert.match(attestation, /length\(v_reason\) < 3 or length\(v_reason\) > 500/);
  assert.match(attestation, /source\.source_type <> 'xtream' or not v_source\.enabled or v_source\.sync_status <> 'ready'/);
  assert.match(attestation, /v_candidate\.evidence_count < 1/);
  assert.match(attestation, /v_candidate\.evidence_count >= v_candidate\.required_evidence/);
  assert.match(attestation, /if v_alias_identity is not null then[\s\S]*explicit merge review is required/);
  assert.match(attestation, /array\[\]::text\[\]/);
  assert.match(attestation, /'admin-attested-source-local-v1'/);
  assert.match(attestation, /'admin_attested_source_local'/);
  assert.match(attestation, /delete from public\.catalog_source_provider_identity_candidates/);
  assert.match(attestation, /insert into public\.admin_events/);
  assert.match(attestation, /'cross_account_eligible', false/);
  assert.doesNotMatch(attestation, /update public\.catalog_provider_identities[\s\S]*set identity_id = v_identity/);

  assert.match(migration, /revoke all on function public\.admin_attest_source_provider_identity\(uuid, text\)[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.admin_attest_source_provider_identity\(uuid, text\)[\s\S]*to authenticated, service_role/);
});

test('admin attestation UI explains isolation, requires a reason and prevents double submit', async () => {
  const attestation = section(
    adminPageSource,
    '    async _attestProviderIdentity(button)',
    '    _renderIdentities(list)',
  );
  assert.match(attestation, /aucun rapprochement ni partage automatique avec un autre compte/);
  assert.match(attestation, /validate: value => value\.length >= 3 && value\.length <= 500/);
  assert.match(attestation, /button\.disabled = true/);
  assert.match(attestation, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(attestation, /this\._rpc\('admin_attest_source_provider_identity'/);
  assert.match(attestation, /result\.cross_account_eligible !== false/);
  assert.doesNotMatch(attestation, /JSON\.stringify\(error|error\?\.message|error\.message/);

  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const calls = [];
  const toasts = [];
  Object.assign(page, {
    async _modal(options) {
      assert.equal(options.maxLength, 500);
      assert.equal(options.validate('motif de test'), true);
      return 'motif de test';
    },
    async _rpc(name, params) {
      calls.push({ name, params });
      return { status: 'verified', cross_account_eligible: false };
    },
    _toast(message, kind) { toasts.push({ message, kind }); },
    async _loadIdentities(options) { this.reloadOptions = options; },
  });
  const attributes = new Map();
  const button = {
    disabled: false,
    textContent: 'Valider manuellement',
    dataset: {
      sourceId: '00000000-0000-4000-8000-000000000001',
      sourceName: 'Source de test',
      evidenceCount: '1',
      requiredEvidence: '32',
    },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };

  await page._attestProviderIdentity(button);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'admin_attest_source_provider_identity');
  assert.equal(calls[0].params.p_source_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(calls[0].params.p_reason, 'motif de test');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Source validée');
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(page.reloadOptions.quiet, true);
  assert.equal(toasts.at(-1).kind, 'ok');
});
