'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');

test('durable finalizer retries structured upstream timeout objects', () => {
  const source = fs.readFileSync(
    path.join(root, 'supabase/functions/norva-source-sync/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const start = source.indexOf('function isTransientFinalizeError(');
  const end = source.indexOf('\nasync function driveFinalizeToReady(', start);
  assert.ok(start >= 0 && end > start, 'missing transient-finalize classifier');

  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = isTransientFinalizeError;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    HttpError,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'finalize-transient-error.ts' });
  const isTransient = sandbox.module.exports;

  assert.equal(isTransient({ message: 'The upstream server is timing out', request_id: 'opaque' }), true);
  assert.equal(isTransient(new Error('canceling statement due to statement timeout')), true);
  assert.equal(isTransient(new HttpError(503, 'temporarily unavailable', {})), true);
  assert.equal(isTransient({ message: 'candidate generation is not active' }), false);
});

test('operator stepper clears only its exact durable cursor and lease after READY', () => {
  const stepper = fs.readFileSync(
    path.join(root, 'ops/hetzner/scripts/run-durable-catalog-finalize-stepper.ps1'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  assert.match(stepper, /function Clear-OperatorStateAfterReady/);
  assert.match(stepper, /s\.sync_status='ready'/);
  assert.match(stepper, /syncProgress'->>'stage'='ready'/);
  assert.match(stepper, /steps'->'finalize'->>'status'='done'/);
  assert.match(stepper, /finalizeCursor'=jsonb_build_object/);
  assert.match(stepper, /finalizeLease'->>'owner'='durable-catalog-finalize-stepper-v1'/);
  assert.match(stepper, /h\.active_generation_id='\$GenerationId'::uuid/);
  assert.match(
    stepper,
    /if \(\[string\]\$payload\.status -eq 'ready'\) \{[\s\S]*Clear-OperatorStateAfterReady[\s\S]*Write-Output "READY/,
  );
});
