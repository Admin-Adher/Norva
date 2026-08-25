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

function loadAdminPage(overrides = {}) {
  const window = {};
  const context = vm.createContext({
    window,
    document: overrides.document || {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { hash: '#admin/finance/archive' },
    history: { state: null, replaceState() {} },
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

test('legal archive route and form are explicit, bounded and accessible', () => {
  const AdminPage = loadAdminPage();

  assert.equal(AdminPage.validRoute('finance/archive'), 'finance/archive');
  assert.match(source, /data-ftab="archive"/);
  assert.match(source, /id="legal-archive-form"/);
  assert.match(source, /id="legal-archive-value"[\s\S]*maxlength="300"/);
  assert.match(source, /id="legal-archive-case"[\s\S]*minlength="12"[\s\S]*maxlength="120"/);
  assert.match(source, /id="legal-archive-status"[\s\S]*aria-live="polite"/);
  assert.match(source, /Maximum 20 pièces par consultation/);
  assert.match(source, /@media\(max-width:560px\)[\s\S]*legal-archive-field input[\s\S]*font-size:16px/);
  assert.doesNotMatch(source, /from\s+public\.legal_billing_archive/i);
  assert.doesNotMatch(source, /legal_billing_archive_access_events/);
});

test('legal archive request validation mirrors the PostgreSQL allowlist', () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const valid = {
    lookupKind: 'order_id',
    lookupValue: 'order-proof-1',
    caseReference: 'NORVA-LEGAL-PROOF-20260825',
    reason: 'statutory_audit',
  };

  assert.deepEqual({ ...page._normalizeLegalArchiveRequest(valid) }, valid);
  for (const [patch, field] of [
    [{ lookupKind: 'email' }, 'lookupKind'],
    [{ lookupValue: '' }, 'lookupValue'],
    [{ lookupValue: 'x'.repeat(301) }, 'lookupValue'],
    [{ caseReference: 'short' }, 'caseReference'],
    [{ caseReference: 'NORVA LEGAL INVALID' }, 'caseReference'],
    [{ reason: 'marketing' }, 'reason'],
  ]) {
    assert.throws(
      () => page._normalizeLegalArchiveRequest({ ...valid, ...patch }),
      (error) => error && error.code === 'legal_archive_validation' && error.field === field,
    );
  }
});

test('legal archive read elevates AAL2 before the exact audited RPC', async () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const calls = [];
  page._partnersEnsureAal2 = async () => { calls.push(['aal2']); return true; };
  page._rpc = async (name, args) => {
    calls.push(['rpc', name, args]);
    return {
      contract: 'legal-billing-archive-read-v1',
      caseReference: args.p_case_reference,
      records: [],
      returnedRows: 0,
      truncated: false,
    };
  };

  const result = await page._readLegalArchive({
    lookupKind: 'order_id',
    lookupValue: 'nonexistent-production-aal2-proof',
    caseReference: 'NORVA-LEGAL-AAL2-PROOF-20260825',
    reason: 'statutory_audit',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['aal2'],
    ['rpc', 'norva_read_legal_billing_archive', {
      p_lookup_kind: 'order_id',
      p_lookup_value: 'nonexistent-production-aal2-proof',
      p_case_reference: 'NORVA-LEGAL-AAL2-PROOF-20260825',
      p_reason: 'statutory_audit',
    }],
  ]);
  assert.equal(result.returnedRows, 0);
  assert.equal(result.caseReference, 'NORVA-LEGAL-AAL2-PROOF-20260825');
  assert.equal(Object.hasOwn(result, 'lookupValue'), false);
});

test('legal archive read cannot call PostgreSQL when AAL2 is cancelled', async () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  let rpcCalls = 0;
  page._partnersEnsureAal2 = async () => false;
  page._rpc = async () => { rpcCalls += 1; };

  await assert.rejects(
    page._readLegalArchive({
      lookupKind: 'order_id',
      lookupValue: 'order-proof-1',
      caseReference: 'NORVA-LEGAL-PROOF-20260825',
      reason: 'statutory_audit',
    }),
    (error) => error && error.code === 'legal_archive_aal2_required',
  );
  assert.equal(rpcCalls, 0);
});

test('legal archive response contract is fail-closed and rendered values are escaped', async () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  page._partnersEnsureAal2 = async () => true;
  page._rpc = async () => ({ contract: 'wrong', records: [], returnedRows: 0 });
  await assert.rejects(
    page._readLegalArchive({
      lookupKind: 'order_id',
      lookupValue: 'order-proof-1',
      caseReference: 'NORVA-LEGAL-PROOF-20260825',
      reason: 'statutory_audit',
    }),
    (error) => error && error.code === 'legal_archive_invalid_response',
  );

  const empty = page._renderLegalArchiveRecords({ records: [], truncated: false });
  assert.match(empty, /Aucune pièce correspondante/);
  const html = page._renderLegalArchiveRecords({
    truncated: false,
    records: [{
      orderId: '<img src=x onerror=alert(1)>',
      kind: 'invoice',
      status: 'issued',
      amountMinor: 1234,
      currency: 'eur',
      issuedAt: '2026-08-25T12:00:00Z',
    }],
  });
  assert.doesNotMatch(html, /<img src=/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /1[\s\u202f]?234 unités mineures/);
});

test('legal archive errors never echo raw server payloads to the operator', () => {
  const AdminPage = loadAdminPage();
  const page = Object.create(AdminPage.prototype);
  const raw = 'super-secret-returned-record';
  const message = page._legalArchiveErrorMessage(new Error(`500 ${raw}`));
  assert.doesNotMatch(message, new RegExp(raw));
  assert.match(message, /n’a pas abouti/);
});

test('legal archive form ignores a concurrent second submit', async () => {
  let submitHandler;
  const elements = new Map();
  const makeElement = (extra = {}) => ({
    dataset: {},
    disabled: false,
    textContent: '',
    className: '',
    value: '',
    innerHTML: '',
    addEventListener(type, handler) { if (type === 'submit') submitHandler = handler; },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    ...extra,
  });
  for (const id of [
    'legal-archive-form', 'legal-archive-submit', 'legal-archive-status',
    'legal-archive-results', 'legal-archive-value', 'legal-archive-case',
    'legal-archive-kind', 'legal-archive-reason',
  ]) elements.set(id, makeElement());
  elements.get('legal-archive-value').value = 'nonexistent-local-proof';
  elements.get('legal-archive-case').value = 'NORVA-LEGAL-LOCAL-20260825';
  elements.get('legal-archive-kind').value = 'order_id';
  elements.get('legal-archive-reason').value = 'statutory_audit';

  const AdminPage = loadAdminPage({
    document: {
      getElementById(id) { return elements.get(id) || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
  });
  const page = Object.create(AdminPage.prototype);
  let resolveRead;
  let readCalls = 0;
  page._readLegalArchive = async () => {
    readCalls += 1;
    return new Promise(resolve => { resolveRead = resolve; });
  };
  page._renderLegalArchiveRecords = () => '<p>empty</p>';
  page._wireLegalArchiveReader();

  const event = { preventDefault() {} };
  const first = submitHandler(event);
  const second = submitHandler(event);
  assert.equal(readCalls, 1);
  assert.equal(elements.get('legal-archive-submit').disabled, true);

  resolveRead({ records: [], returnedRows: 0, truncated: false, caseReference: 'NORVA-LEGAL-LOCAL-20260825' });
  await Promise.all([first, second]);
  assert.equal(elements.get('legal-archive-submit').disabled, false);
  assert.equal(elements.get('legal-archive-value').value, '');
});
