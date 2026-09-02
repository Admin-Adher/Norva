const test = require('node:test');
const assert = require('node:assert/strict');

async function loadServer() {
  return import('../tools/norva-growth-mcp/server.mjs');
}

test('Norva Growth MCP normalizes safe cohort filters', async () => {
  const { validateFilters } = await loadServer();
  assert.deepEqual(validateFilters({ lookback_days: 14, country_code: 'in', platform: 'mobile_android' }), {
    lookbackDays: 14,
    countryCode: 'IN',
    platform: 'mobile_android',
  });
  assert.equal(validateFilters({ platform: 'android_tv' }).platform, 'android_tv');
});

test('Norva Growth MCP rejects unknown and injectable filters', async () => {
  const { validateFilters } = await loadServer();
  assert.throws(() => validateFilters({ country_code: "IN'; DROP TABLE auth.users; --" }), /deux lettres/);
  assert.throws(() => validateFilters({ arbitrary_sql: 'select 1' }), /non pris en charge/);
  assert.throws(() => validateFilters({ lookback_days: 366 }), /compris entre 1 et 365/);
});

test('all generated SQL is fixed, read-only and excludes internal accounts', async () => {
  const { TOOL_DEFINITIONS, buildQuery } = await loadServer();
  for (const tool of TOOL_DEFINITIONS) {
    const args = tool.name === 'norva_health_check'
      ? {}
      : { lookback_days: 7, country_code: 'IN', platform: 'mobile_android' };
    const sql = buildQuery(tool.name, args);
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/);
    assert.match(sql, /SET LOCAL statement_timeout = '8s';/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
    if (tool.name === 'norva_get_source_connection_attempts') {
      assert.match(sql, /analytics_private\.source_connection_attempts/);
      assert.match(sql, /country_code, ''\)\) = 'IN'/);
      assert.match(sql, /a\.platform, 'unknown'\) = 'mobile_android'/);
      assert.match(sql, /count\(DISTINCT host_hash\)/);
      assert.match(sql, /'host_hashes_returned', false/);
      assert.match(sql, /'user_identifiers_stored_in_telemetry', false/);
      assert.match(sql, /'by_connection_pattern'/);
      assert.match(sql, /'by_app_version'/);
    } else if (tool.name !== 'norva_health_check') {
      assert.match(sql, /admin_internal_accounts/);
      assert.match(sql, /country_code, ''\)\) = 'IN'/);
      assert.match(sql, /signup_platform, 'unknown'\) = 'mobile_android'/);
    }
  }
});

test('MCP handshake and tool calls return protocol-compliant aggregate results', async () => {
  const { handleRequest } = await loadServer();
  const initialized = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(listed.result.tools.length, 5);
  assert.ok(listed.result.tools.every((tool) => tool.annotations.readOnlyHint === true));

  const expected = { source: 'hetzner_postgresql', funnel: { signups: 4 } };
  const called = await handleRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'norva_get_growth_funnel', arguments: { country_code: 'IN' } },
    },
    async () => expected,
  );
  assert.deepEqual(called.result.structuredContent, expected);
  assert.equal(called.result.isError, false);
});

test('psql parser accepts one aggregate JSON object and rejects non-JSON output', async () => {
  const { parsePsqlJson } = await loadServer();
  assert.deepEqual(parsePsqlJson('\n{"status":"ok"}\n'), { status: 'ok' });
  assert.throws(() => parsePsqlJson('not-json'), /agrégat JSON valide/);
});
