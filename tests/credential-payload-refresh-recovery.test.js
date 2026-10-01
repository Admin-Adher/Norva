const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = name => fs.readFileSync(require.resolve('../supabase/migrations/' + name), 'utf8').replaceAll('\r\n','\n');

test('invalid-payload recovery retains the entire existing CAS, audit and fresh-proof contract', () => {
  const before = read('20260926031000_credential_refresh_rebuild.sql');
  const after = read('20261001230000_credential_payload_refresh_recovery.sql');
  const definition = text => text.slice(text.indexOf('create or replace function'));
  assert.equal(definition(after).replace("not in ('catalog_unhealthy','internal_error','invalid_payload')",
    "not in ('catalog_unhealthy','internal_error')"), definition(before));
  assert.notEqual(definition(after), definition(before));
});
