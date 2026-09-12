'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ops/hetzner/scripts/deploy-startup-subtitle-20260912.py'), 'utf8');
test('startup release pins the current exact image, native evidence and two-file scope', () => {
  assert.match(source, /mkv-early-prefix-20260912/);
  assert.match(source, /FILES = \('index.js',\)/);
  assert.match(source, /EDGE_FILE = 'norva-playback\/index.ts'/);
  assert.match(source, /proof\.get\('image'\) == current\['Image'\]/);
  assert.match(source, /gw\.sha\(data\) == proof\['sourceHashes'\]\[entry.name\]/);
  assert.match(source, /before_edge\.get\(EDGE_FILE\) == BASE_EDGE_SHA/);
  assert.match(source, /if k != EDGE_FILE/);
  assert.match(source, /'--network','none'/);
  assert.match(source, /global APP_COMMIT\s+APP_COMMIT = sys.argv\[2\]/);
});
test('release preserves mono-session work and protected records and owns any rollback', () => {
  assert.match(source, /op\.base\.previous\.d\.idle\(\)/);
  assert.match(source, /flags_or_quarantine_changed/);
  assert.match(source, /protected_evidence_changed/);
  assert.match(source, /'passiveEnabled':False/);
  assert.match(source, /receipts\.get\(name,\{\}\)\.get\('candidateContainer'\)/);
  assert.match(source, /op\.restore_crons\(plan\)/);
  assert.doesNotMatch(source, /docker','rm|delete from|truncate|drop table/i);
});
