const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('source-sync gets the production CPU grace without forcing a fresh isolate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'main', 'index.ts'), 'utf8');
  assert.match(src, /function sourceSyncCpuLimits\(serviceName: string\)/);
  assert.match(src, /serviceName === 'norva-source-sync'\s*\?\s*\{ cpuTimeSoftLimitMs: 10_000, cpuTimeHardLimitMs: 120_000, forceCreate: false \}\s*:\s*\{\}/);
  const create = src.slice(src.indexOf('userWorkers.create('), src.indexOf('return await worker.fetch(req)'));
  assert.match(create, /\.\.\.sourceSyncCpuLimits\(service_name\)/);
  assert.doesNotMatch(create, /forceCreate:\s*true/);
});
