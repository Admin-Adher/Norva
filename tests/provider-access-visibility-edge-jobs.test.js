'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('series-info rejects a hidden or staging source before provider access', () => {
  const source = read('supabase/functions/norva-series-info/index.ts');
  const routeStart = source.indexOf('segments[2] === "series-info"');
  const providerStart = source.indexOf('getXtreamSeriesInfo(', routeStart);

  assert.notEqual(routeStart, -1);
  assert.ok(
    source.indexOf('await assertVisibleSource(sourceId, identity.userId, supabase)', routeStart) < providerStart,
    'visibility must be checked before the provider-backed lookup',
  );
  assert.match(source, /db\.rpc\("norva_source_catalog_visible", \{[\s\S]*p_source_id: sourceId,[\s\S]*p_user_id: userId/);
  assert.match(source, /SOURCE_CATALOG_NOT_VISIBLE/);
  assert.match(source, /\.from\("cloud_catalog_visible_media_items"\)/);
});

test('series prewarm fails closed before loading credentials or contacting the gateway', () => {
  const source = read('supabase/functions/norva-series-prewarm/index.ts');
  const prewarm = source.slice(source.indexOf('async function prewarm('), source.indexOf('async function getRuntimeCfg('));

  const guard = prewarm.indexOf('await sourceCatalogVisible(sourceId, userId)');
  const credentials = prewarm.indexOf('await getRuntimeCfg()');
  assert.ok(guard >= 0 && credentials > guard, 'visibility must precede runtime credential access');
  assert.match(prewarm, /SOURCE_CATALOG_NOT_VISIBLE/);
  assert.match(source, /\.from\("cloud_catalog_visible_media_items"\)/);
  assert.match(source, /supabase\.rpc\("norva_source_catalog_visible"/);
});

test('import digests suppress every notification whose source is no longer visible', () => {
  const source = read('supabase/functions/norva-import-notify/index.ts');
  const stats = source.slice(source.indexOf('async function providerStats('), source.indexOf('function htmlEscape('));
  const digest = source.slice(source.indexOf('async function runDigest('), source.indexOf('Deno.serve'));

  assert.match(stats, /\.from\("cloud_catalog_visible_sources"\)/);
  assert.match(stats, /\.from\("cloud_catalog_visible_media_items"\)/);
  assert.doesNotMatch(stats, /\.from\("cloud_sources"\)/);
  assert.doesNotMatch(stats, /\.from\("cloud_media_items"\)/);
  assert.match(digest, /if \(providers\.length === 0\) \{[\s\S]*skipDelivery\(claim, "source is no longer catalog-visible", email\);[\s\S]*continue;/);
});
