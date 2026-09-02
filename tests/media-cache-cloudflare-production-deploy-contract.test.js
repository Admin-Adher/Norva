'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = fs.readFileSync(path.join(root, 'workers/media-cache/wrangler.toml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-media-cache.yml'), 'utf8');
const gatewayCompose = fs.readFileSync(path.join(root, 'ops/hetzner/media/docker-compose.vaapi.yml'), 'utf8');
const edgeCompose = fs.readFileSync(path.join(root, 'ops/hetzner/docker-compose.supabase.yml'), 'utf8');

test('production media cache owns one persistent private bucket and exact custom domain', () => {
  assert.match(config, /name = "norva-media-cache"/);
  assert.match(config, /bucket_name = "norva-media-cache"/);
  assert.match(config, /pattern = "media-cache\.norva\.tv"/);
  assert.match(config, /custom_domain = true/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /MEDIA_CACHE_R2_MAX_BYTES = "2199023255552"/);
  assert.doesNotMatch(config, /media-cache-canary/);
});

test('production deployment is manual, main-only, confirmed and never deletes persistent data', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s*push:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /DEPLOY_PRIVATE_MEDIA_CACHE/);
  assert.match(workflow, /group: norva-media-cache-production\s+cancel-in-progress: false/);
  assert.match(workflow, /secrets\.CLOUDFLARE_MEDIA_CACHE_DEPLOY_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_MEDIA_CACHE_PURGE_TOKEN/);
  assert.match(workflow, /secrets\.NORVA_MEDIA_CACHE_WORKER_TOKEN/);
  assert.match(workflow, /secrets\.NORVA_MEDIA_CACHE_MANIFEST_HMAC_KEY/);
  assert.match(workflow, /secrets\.NORVA_MEDIA_CACHE_TICKET_HMAC_KEY/);
  assert.match(workflow, /wrangler secret bulk --config workers\/media-cache\/wrangler\.toml/);
  assert.match(workflow, /anonymous\.status !== 401/);
  assert.doesNotMatch(workflow, /r2 bucket delete norva-media-cache/);
  assert.doesNotMatch(workflow, /workers\/scripts\/norva-media-cache\?force=true/);
});

test('Hetzner profiles propagate every cache gate while preserving dark defaults', () => {
  for (const key of [
    'PROVIDER_ADAPTIVE_ROUTE_ENABLED',
    'PROVIDER_ROUTE_BENCHMARK_ENABLED',
    'NORVA_SHARED_MEDIA_CACHE_ENABLED',
    'MEDIA_CACHE_LIVE_JOIN_ENABLED',
    'NORVA_SHARED_MEDIA_CACHE_BACKGROUND_CONTINUATION_ENABLED',
  ]) {
    assert.match(gatewayCompose, new RegExp(`${key}: \\${'${'}${key}:-false\\}`));
  }
  for (const key of [
    'NORVA_MEDIA_CACHE_WORKER_URL',
    'NORVA_MEDIA_CACHE_WORKER_TOKEN',
    'NORVA_MEDIA_CACHE_TICKET_HMAC_KEY',
    'NORVA_MEDIA_CACHE_ENABLED',
    'NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED',
    'NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED',
    'NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY',
  ]) {
    assert.match(edgeCompose, new RegExp(`${key}: \\${'${'}${key}:-\\}`));
  }
});
