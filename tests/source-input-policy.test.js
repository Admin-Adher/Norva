'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/components/SourceManager.js'), 'utf8');
const policy = import('../supabase/functions/_shared/source-input-policy.mjs');
const telemetry = import('../supabase/functions/_shared/source-connection-attempt.mjs');

function harness(extra = {}) {
  const context = { window: {}, URL, console, TextEncoder, crypto: globalThis.crypto, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(source, context);
  return { context, manager: Object.create(context.window.SourceManager.prototype) };
}

const invalid = [
  'auditname', 'https://auditname', 'http://provider:8080', 'audit@example.test',
  'audit@example.test/list.m3u', 'mailto:audit@example.test', '12345', '127.1',
  '0x7f000001', '0177.0.0.1', 'https://bad_name.test/list.m3u',
  'https://bad..test', 'https://-bad.test', 'https://bad-.test', 'https://example.123',
  'http://999.0.0.1', 'http://[not:ipv6]', 'https://exam\tple.test',
  'https://example.test\\path', 'ftp://provider.test/list.m3u',
  'javascript:alert(1)', 'https://provider.test:99999',
];

test('the synchronous browser distribution is generated from the server policy', () => {
  const result = spawnSync(process.execPath, ['scripts/build-source-input-policy.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SOURCE_INPUT_POLICY_PARITY_OK/);
});

test('original invalid input is rejected before Xtream rewrite and never acquires a diagnostic host', async () => {
  const { manager } = harness();
  const core = await policy;
  const server = await telemetry;
  for (const value of invalid) {
    assert.equal(core.parseSourceInputUrl(value), null, value);
    assert.equal(manager.parseXtreamLink(value), null, value);
    assert.equal(manager.hostFromUrl(value), '', value);
    for (const type of ['m3u', 'xtream']) {
      assert.equal(manager.sourceInputFeedback(value, type).state, 'invalid', value);
      assert.throws(() => manager.buildSourceConnection({ type, url: value, username: 'fixture', password: 'fixture' }),
        error => error.code === 'INVALID_SOURCE_ADDRESS' && !error.message.includes(value), value);
      const client = await manager.sourceAttemptDiagnostic({ type, url: value, inputPathShape: 'get.php' });
      const edge = await server.summarizeSourceConnectionAttempt({ sourceType: type, url: value, inputPathShape: 'get.php' });
      assert.deepEqual(JSON.parse(JSON.stringify(client)), edge, value);
      assert.equal(client.domainNormalized, null, value);
      assert.equal(client.hostHash, null, value);
      assert.equal(client.pathShape, 'invalid', value);
    }
  }
});

test('valid root, unusual playlist paths, IDN and canonical IP literals remain checkable', async () => {
  const { manager } = harness();
  const server = await telemetry;
  for (const url of ['provider.test:8080', 'https://provider.test/', 'https://provider.test/download?id=fixture',
    'https://provider.test/get.php?username=fixture&password=fixture', 'https://provider.test/list.m3u8',
    'https://bücher.example/list.m3u', 'https://PROVIDER.TEST./list.m3u',
    'http://192.0.2.1:8080', 'http://[2001:db8::1]:8080', 'http://box.local/list.m3u',
    'https://user:fixture@panel.provider.test/list.m3u', 'https://bit.ly/fixture']) {
    assert.notEqual(manager.sourceInputFeedback(url, 'm3u').state, 'invalid', url);
    assert.equal(manager.buildSourceConnection({ type: 'm3u', url }).url, /^https?:\/\//i.test(url) ? url : `http://${url}`);
    const client = await manager.sourceAttemptDiagnostic({ type: 'm3u', url });
    const edge = await server.summarizeSourceConnectionAttempt({ sourceType: 'm3u', url });
    assert.deepEqual(JSON.parse(JSON.stringify(client)), edge, url);
    assert.doesNotMatch(JSON.stringify(client), /fixture|username|password|https/);
  }
});

test('malformed percent-encoded stream credentials do not crash the form', () => {
  const { manager } = harness();
  assert.equal(manager.parseXtreamLink('https://provider.test/live/%ZZ/test/12.ts'), null);
  assert.throws(() => manager.buildSourceConnection({ type: 'xtream', url: 'https://provider.test/live/%ZZ/test/12.ts' }), /username and password/);
});

test('Xtream requires all three fields while full links still prefill correctly', () => {
  const { manager } = harness();
  for (const input of [{}, { username: 'fixture' }, { password: 'fixture' }]) {
    assert.throws(() => manager.buildSourceConnection({ type: 'xtream', url: 'https://provider.test', ...input }), /username and password/);
  }
  const parsed = manager.buildSourceConnection({ type: 'xtream', url: 'https://provider.test/get.php?username=fixture&password=fixture' });
  assert.equal(parsed.url, 'https://provider.test');
  assert.equal(parsed.username, 'fixture');
  assert.equal(parsed.password, 'fixture');
  assert.equal(parsed.inputPathShape, 'get.php');
});

test('metadata-only edits retain saved secrets; credential replacements are validated', () => {
  const { manager } = harness();
  for (const type of ['m3u', 'xtream', 'epg']) {
    assert.equal(manager.buildSourceConnection({ existing: true, type, name: 'Renamed', url: 'Saved connection' }).credentialsProvided, false);
  }
  assert.throws(() => manager.buildSourceConnection({ existing: true, type: 'xtream', url: 'audit@example.test', username: 'fixture', password: 'fixture' }), { code: 'INVALID_SOURCE_ADDRESS' });
  assert.throws(() => manager.buildSourceConnection({ existing: true, type: 'm3u', url: 'https://bad_name.test/list.m3u' }), { code: 'INVALID_SOURCE_ADDRESS' });
});

test('invalid form submission cannot estimate, connect or create a source', async () => {
  const input = { value: 'audit@example.test', dataset: {}, setAttribute() {}, focus() { this.focused = true; } };
  const error = { textContent: '', hidden: true, scrollIntoView(options) { this.revealed = options.block; } };
  let operations = 0;
  const { manager } = harness({
    document: { getElementById: id => id === 'source-url' ? input : id === 'source-url-error' ? error : null },
    API: { sources: { estimateByUrl() { operations++; }, create() { operations++; } } },
    NorvaModal: { toast() {} },
  });
  await manager.saveNewSource('m3u');
  assert.equal(operations, 0);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /email or app login/);
  assert.doesNotMatch(error.textContent, /audit@example/);
  assert.equal(input.focused, true);
  assert.equal(error.revealed, 'nearest');
});

test('localized required-field errors are mapped from bounded codes/messages, never raw server text', () => {
  const { manager } = harness({ NorvaI18n: { t: key => `translated:${key}` } });
  assert.equal(manager.sourceFormErrorMessage(new Error('Provider URL is required.')), 'translated:ui_web_baf76e6a65bf');
  assert.equal(manager.sourceFormErrorMessage(new Error('private provider response')), 'translated:ui_web_47783937825b');
  assert.equal(manager.sourceFormErrorMessage({ code: 'INVALID_SOURCE_ADDRESS', inputProblem: 'email_or_login' }), 'translated:ui_web_source_email_not_url');
});
