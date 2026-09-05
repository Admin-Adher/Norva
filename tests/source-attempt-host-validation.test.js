const test = require('node:test');
const assert = require('node:assert/strict');

const telemetry = import('../supabase/functions/_shared/source-connection-attempt.mjs');

test('names, emails and malformed hosts never acquire a domain or host hash', async () => {
  const { summarizeSourceConnectionAttempt } = await telemetry;
  const invalid = [
    'auditname', 'https://auditname', 'audit@example.com', 'audit@example.com/list.m3u',
    'mailto:audit@example.com', '12345', '127.1', '0x7f000001', '0177.0.0.1',
    'https://example..com', 'https://-example.com', 'https://example-.com',
    'https://exa_mple.com', 'https://example.123', 'http://999.0.0.1',
    'http://[not:ipv6]', 'https://exam\tple.com', 'https://example.com\\other',
  ];
  for (const url of invalid) {
    for (const sourceType of ['m3u', 'xtream']) {
      const result = await summarizeSourceConnectionAttempt({ sourceType, url, inputPathShape: 'get.php' });
      assert.equal(result.domainNormalized, null, url);
      assert.equal(result.hostHash, null, url);
      assert.equal(result.pathShape, 'invalid', url);
    }
  }
});

test('real DNS, explicit userinfo URLs and standard IP literals remain classifiable', async () => {
  const { summarizeSourceConnectionAttempt } = await telemetry;
  for (const [url, domain] of [
    ['provider.test:8080/get.php?username=test&password=secret', 'provider.test'],
    ['https://user:secret@panel.provider.test/get.php', 'provider.test'],
    ['https://PROVIDER.TEST./list.m3u', 'provider.test'],
    ['https://bücher.example/list.m3u', 'xn--bcher-kva.example'],
    ['http://192.0.2.1:8080', 'ip-address'],
    ['http://[2001:db8::1]:8080', 'ip-address'],
    ['http://box.local/list.m3u', 'local-address'],
  ]) {
    const result = await summarizeSourceConnectionAttempt({ sourceType: 'm3u', url });
    assert.equal(result.domainNormalized, domain, url);
    assert.match(result.hostHash, /^[a-f0-9]{64}$/, url);
    assert.doesNotMatch(JSON.stringify(result), /secret|username|password|bücher/);
  }
});

test('the direct domain normalizer rejects invalid browser diagnostic labels', async () => {
  const { normalizedSourceAttemptDomain } = await telemetry;
  for (const host of ['pseudonym', 'someone@example.com', 'foo..com', '-foo.com',
    'foo-.com', 'foo_bar.com', 'foo.123', '999.0.0.1', 'invalid:address', 'localhost',
    '::1]/path', `${'a'.repeat(64)}.test`]) {
    assert.equal(normalizedSourceAttemptDomain(host), null, host);
  }
  assert.equal(normalizedSourceAttemptDomain('[2001:0db8:0:0:0:0:0:1]'), 'ip-address');
});
