const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const compose = fs.readFileSync(path.join(
  __dirname, '..', 'ops', 'hetzner', 'docker-compose.supabase.yml',
), 'utf8');
const envExample = fs.readFileSync(path.join(
  __dirname, '..', 'ops', 'hetzner', '.env.hetzner.example',
), 'utf8');
const edge = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'functions', 'norva-provider-access', 'index.ts',
), 'utf8');
const scheduler = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260824120100_provider_access_detection_scheduler_v1.sql',
), 'utf8');
const refreshWorkerScheduler = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260825013000_active_catalog_refresh_worker_heartbeat_cron_v1.sql',
), 'utf8');

test('both Edge runtimes inherit the dedicated Provider Access worker token', () => {
  assert.match(compose, /environment: &functions-env[\s\S]*NORVA_PROVIDER_ACCESS_WORKER_TOKEN: \$\{NORVA_PROVIDER_ACCESS_WORKER_TOKEN:-\}/);
  assert.match(compose, /container_name: norva-edge-functions-2[\s\S]*environment: \*functions-env/);
  assert.match(envExample, /^NORVA_PROVIDER_ACCESS_WORKER_TOKEN=$/m);
});

test('Edge and database cron bind distinct copies of the same dedicated secret', () => {
  assert.match(edge, /Deno\.env\.get\("NORVA_PROVIDER_ACCESS_WORKER_TOKEN"\)/);
  assert.match(edge, /X-Norva-Worker-Token/);
  assert.match(scheduler, /name='norva_provider_access_worker_token'/);
  assert.match(scheduler, /'X-Norva-Worker-Token'/);
});

test('active catalog refresh worker heartbeat is explicit, authenticated, and independent from rollout flags', () => {
  assert.match(refreshWorkerScheduler, /norva_install_active_catalog_refresh_worker_cron/);
  assert.match(refreshWorkerScheduler, /norva-active-catalog-refresh-worker/);
  assert.match(refreshWorkerScheduler, /internal\/worker\/drain/);
  assert.match(refreshWorkerScheduler, /name='norva_cron_shared_secret'/);
  assert.match(refreshWorkerScheduler, /name='norva_provider_access_worker_token'/);
  assert.match(refreshWorkerScheduler, /credential-transition-worker-v3-active-catalog-refresh/);
  assert.doesNotMatch(refreshWorkerScheduler, /provider_access_v1_enabled/);
});
