'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/norva-cloud/index.ts'), 'utf8');

test('first login normalizes an account display name to the profile table limit', () => {
  const provisioner = source.match(/async function getOrCreateDefaultProfileId\([\s\S]*?\r?\n}\r?\n/);
  const normalizer = source.match(/function normalizeProfileName\([\s\S]*?\r?\n}\r?\n/);
  assert.ok(provisioner && normalizer, 'profile provisioning and normalization must exist');
  assert.match(provisioner[0], /normalizeProfileName\(account\?\.display_name\) \|\| "Profile 1"/);

  const { code } = esbuild.transformSync(normalizer[0], { loader: 'ts', format: 'cjs' });
  const normalizeProfileName = Function(`${code}\nreturn normalizeProfileName;`)();
  const longAlias = 'adrienhernandez20+norva-qa-commercial-20260924';
  assert.equal(longAlias.length, 46);
  assert.equal(normalizeProfileName(longAlias).length, 40);
  assert.equal(normalizeProfileName('  Customer  '), 'Customer');
  assert.equal(normalizeProfileName(null) || 'Profile 1', 'Profile 1');
});
