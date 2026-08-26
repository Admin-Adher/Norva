'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'norva-source-sync', 'index.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

test('legacy finalizers without a durable version proof restart discovery instead of guessing', () => {
  const start = source.indexOf('async function cronResumeStuck(');
  const end = source.indexOf('\nasync function cronFinalizeSource(', start);
  assert.ok(start >= 0 && end > start, 'cronResumeStuck block must exist');
  const watchdog = source.slice(start, end);

  assert.match(watchdog, /const missingFinalizeProof = inFinalize/);
  assert.match(watchdog, /Number\.isSafeInteger\(catalogVersion\)[\s\S]*catalogVersion <= 0/);
  assert.match(watchdog, /Number\.isSafeInteger\(expectedTotal\)[\s\S]*expectedTotal < 0/);
  assert.match(
    watchdog,
    /if \(inDiscovery \|\| missingFinalizeProof\)[\s\S]*driveXtreamSyncToReady/,
    'missing proof must restart authoritative discovery',
  );
  assert.doesNotMatch(
    watchdog,
    /missingFinalizeProof[\s\S]*max\s*\([^)]*catalog_version/i,
    'the recovery must not infer a winning catalogue version',
  );
});
