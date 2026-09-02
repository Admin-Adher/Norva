'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const production = fs.readFileSync(path.join(root, 'workers/media-cache/wrangler.toml'), 'utf8');
const canary = fs.readFileSync(path.join(root, 'workers/media-cache/wrangler.canary.toml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-relay.yml'), 'utf8');
const client = fs.readFileSync(path.join(root, 'ops/cloudflare/media-cache-canary-client.mjs'), 'utf8');

test('Cloudflare media-cache canary uses names that cannot target production', () => {
  assert.match(production, /name = "norva-media-cache"/);
  assert.match(production, /bucket_name = "norva-media-cache"/);
  assert.match(canary, /name = "norva-media-cache-canary"/);
  assert.match(canary, /bucket_name = "norva-media-cache-canary"/);
  assert.match(canary, /pattern = "media-cache-canary\.norva\.tv"/);
  assert.doesNotMatch(canary, /name = "norva-media-cache"\s*$/m);
  assert.doesNotMatch(canary, /bucket_name = "norva-media-cache"\s*$/m);
});

test('canary is manual-only while the existing relay main deployment remains unchanged', () => {
  assert.match(workflow, /target:[\s\S]*media-cache-canary/);
  assert.match(workflow, /if: github\.event_name == 'push' \|\| inputs\.target == 'relay'/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && inputs\.target == 'media-cache-canary'/);
  assert.match(workflow, /group: norva-media-cache-canary\s+cancel-in-progress: false/);
  assert.match(workflow, /MEDIA_CACHE_CANARY_BUCKET_CREATED=true/);
  assert.match(workflow, /MEDIA_CACHE_CANARY_WORKER_ATTEMPTED=true/);
  assert.match(workflow, /MEDIA_CACHE_CANARY_READY=true/);
  assert.match(workflow, /if \[ "\$MEDIA_CACHE_CANARY_READY" = 'true' \]/);
  assert.match(workflow, /secrets\.CLOUDFLARE_MEDIA_CACHE_DEPLOY_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_MEDIA_CACHE_PURGE_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ZONE_ID: \$\{\{ vars\.CLOUDFLARE_ZONE_ID \}\}/);
  assert.match(workflow, /client\/v4\/zones\/\$CLOUDFLARE_ZONE_ID/);
  assert.doesNotMatch(workflow, /zones\?[^\n]*account\.id/);
  assert.match(workflow, /MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN: process\.env\.MEDIA_CACHE_CANARY_PURGE_TOKEN/);
  assert.doesNotMatch(workflow, /MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN: process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /workers\/scripts\/norva-media-cache-canary\?force=true/);
  assert.match(workflow, /--request DELETE/);
  assert.doesNotMatch(workflow, /wrangler delete norva-media-cache-canary/);
  assert.match(workflow, /wrangler r2 bucket delete norva-media-cache-canary/);
  assert.doesNotMatch(workflow, /wrangler delete norva-media-cache --force/);
  assert.doesNotMatch(workflow, /wrangler r2 bucket delete norva-media-cache(?:\s|$)/);
});

test('canary receipt requires private delivery, exact tracks, CDN hit, purge and recovery', () => {
  assert.match(client, /anonymous\.status !== 401/);
  assert.match(client, /TYPE=AUDIO/);
  assert.match(client, /TYPE=SUBTITLES/);
  assert.match(client, /coldLayer: 'r2'/);
  assert.match(client, /hotLayer: 'cdn'/);
  assert.match(client, /globalEdgePurgeCompleted/);
  assert.match(client, /verified-quarantined/);
  assert.match(client, /Cloudflare does not guarantee isolate affinity/);
  assert.match(client, /const layerMetricValues = \[/);
  assert.match(client, /secretFreeMetrics: true/);
});
