const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const wrapperPath = 'scripts/15-provider-presence-gate-audit-v3.sh';
const canonicalPath = 'ops/hetzner/scripts/15-provider-presence-gate-audit-v3.sh';

test('provider presence audit root wrapper is valid bash', () => {
  const result = spawnSync('bash', ['-n', wrapperPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('provider presence audit root wrapper delegates to canonical ops script', () => {
  const source = readFileSync(wrapperPath, 'utf8');
  assert.match(source, new RegExp(`TARGET=.*${canonicalPath.replaceAll('/', '\\/')}`));
  assert.match(source, /exec "\$TARGET" "\$@"/);
  assert.match(source, /git fetch origin main && git pull --ff-only origin main/);
});
