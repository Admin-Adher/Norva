'use strict';
// Source-error classification parity lock.
//
// The classifier exists in TWO places that MUST agree:
//   1. supabase/functions/_shared/source-sync-error.mjs  (edge, authoritative)
//   2. public/js/utils/sourceHealth.js                   (browser mirror)
//
// They decide two things that have to stay coherent: what the user is told
// about their own provider, and what wakes the operator up. Before 2026-08-21
// the browser checked auth BEFORE expired while ops checked expired first, so
// "401 subscription expired" got two different verdicts. Worse, the browser
// filed the old generic "Media gateway refused..." under `unreachable` and
// treated it as transient — the user saw a healthy catalog while the operator
// was paged every six hours about the same source.
//
// The browser cannot import from supabase/functions, so the copies are real
// duplicates (same house pattern as GenreTaxonomy.js). This test is what keeps
// them honest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

function loadBrowserMirror() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/utils/sourceHealth.js'), 'utf8');
  const sandbox = { window: {}, document: undefined, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sourceHealth.js' });
  return sandbox.window.NorvaSourceHealth;
}

const loadAuthoritative = () => import(pathToFileURL(
  path.join(ROOT, 'supabase/functions/_shared/source-sync-error.mjs'),
).href);

// Each fixture is [input, expected kind]. The expected values pin the canonical
// ORDER, not just agreement between the copies.
const FIXTURES = [
  // The real Ninja failure, in the format the sync path now persists.
  ['[401] Media gateway refused the metadata request (IPTV provider request failed)', 'auth'],
  // What was persisted before the status was kept: our own gateway, no signal.
  ['Media gateway refused the metadata request', 'infra'],
  // The ordering fix: cause outranks symptom.
  ['[401] provider says subscription expired', 'expired'],
  ['403 unauthorized', 'auth'],
  // A busy slot outranks everything: the account is valid, another device holds it.
  ['[458] account busy, subscription expired', 'busy'],
  ['user_multi_ip detected', 'busy'],
  // Our infrastructure, which must keep alerting.
  ['[502] Media gateway refused the metadata request (upstream unavailable)', 'infra'],
  ['[504] timed out', 'infra'],
  ['enotfound dns failure', 'infra'],
  // A redacted Xtream URL must NOT drag a gateway outage into `auth`.
  ['[502] Media gateway refused the metadata request (http://p:8080/player_api.php?username=***&password=***)', 'infra'],
  // Nothing to go on.
  ['', 'unknown'],
  ['something we have never seen', 'unknown'],
];

test('browser mirror exposes the classifier and its labels', () => {
  const mirror = loadBrowserMirror();
  assert.ok(mirror, 'window.NorvaSourceHealth missing');
  assert.equal(typeof mirror.classifyErrorKind, 'function');
  assert.ok(mirror.ERROR_KIND_LABELS && typeof mirror.ERROR_KIND_LABELS === 'object');
});

test('both copies return the same kind for every fixture', async () => {
  const mirror = loadBrowserMirror();
  const shared = await loadAuthoritative();
  for (const [input, expected] of FIXTURES) {
    const edge = shared.classifyOpsSourceError(input);
    const browser = mirror.classifyErrorKind(input);
    assert.equal(edge, expected, 'edge disagreed on: ' + input);
    assert.equal(browser, expected, 'browser disagreed on: ' + input);
  }
});

test('both copies carry the same operator labels', async () => {
  const mirror = loadBrowserMirror();
  const shared = await loadAuthoritative();
  const kinds = ['busy', 'expired', 'auth', 'infra', 'unknown'];
  for (const kind of kinds) {
    assert.equal(
      mirror.ERROR_KIND_LABELS[kind],
      shared.OPS_SOURCE_ERROR_LABELS[kind],
      'label drift for ' + kind,
    );
    assert.ok(shared.OPS_SOURCE_ERROR_LABELS[kind], 'missing label for ' + kind);
  }
});

test('the suppressed kinds are the user-actionable ones', async () => {
  const shared = await loadAuthoritative();
  assert.deepEqual(
    [...shared.SILENT_OPS_SOURCE_ERROR_KINDS].sort(),
    ['auth', 'busy', 'expired'],
  );
  assert.equal(shared.SILENT_OPS_SOURCE_ERROR_KINDS.has('infra'), false);
  assert.equal(shared.SILENT_OPS_SOURCE_ERROR_KINDS.has('unknown'), false);
});
