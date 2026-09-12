'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const start = source.indexOf('function playbackErrorDiagnostic(');
const end = source.indexOf('type ActiveCatalogPatchResult', start);
const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
const diagnostic = vm.runInNewContext(`${code}; playbackErrorDiagnostic`, { URL });
const req = { url: 'https://norva.test/norva-playback/session?token=SECRET' };

test('internal playback diagnostic identifies SQL timeouts without any raw private data', () => {
  const error = Object.assign(new Error('canceling statement due to statement timeout SELECT SECRET'), {
    code: '57014', stack: 'Error: SECRET\n at f (file:///home/deno/functions/norva-playback/index.ts:834:17)\n at x (https://SECRET:SECRET@private/file.ts:45:12)',
  });
  const result = diagnostic(error, req);
  assert.equal(result.category, 'database-statement-timeout');
  assert.equal(result.route, 'session');
  assert.deepEqual(Array.from(result.codes), ['57014']);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0].module, 'norva-playback/index.ts');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.match(source, /if \(status >= 500\)[\s\S]{0,150}norva-playback:diagnostic/);
});

test('diagnostics traverse bounded causes, filter unknown codes, and handle malformed thrown values', () => {
  const nested = { message: 'fetch failed SECRET', code: 'SECRET', cause: { message: 'connect timed out', code: 'ETIMEDOUT' } };
  nested.cause.cause = nested;
  assert.deepEqual(Array.from(diagnostic(nested, req).codes), ['ETIMEDOUT']);
  assert.equal(JSON.stringify(diagnostic(nested, req)).includes('SECRET'), false);
  const bad = { get message() { throw Error('SECRET'); } };
  for (const value of [bad, null, undefined, 'SECRET', 17]) {
    assert.equal(diagnostic(value, req).category, 'unclassified');
    assert.equal(JSON.stringify(diagnostic(value, req)).includes('SECRET'), false);
  }
  assert.equal(diagnostic({ message: 'remaining connection slots are reserved' }, req).category, 'database-capacity');
  assert.equal(diagnostic({ message: 'relation SECRET does not exist' }, req).category, 'database-schema');
  assert.equal(diagnostic({ message: 'Could not resolve title', details: { message: 'canceling statement due to statement timeout' } }, req).category, 'database-statement-timeout');
});
