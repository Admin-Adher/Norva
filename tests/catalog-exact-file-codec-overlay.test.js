const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
}

test('flat movie rows receive codec facts only from their exact owned variant', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const overlay = between(
    catalog,
    'async function attachFlatMediaFileLanguages(',
    '\nasync function listVariantsByTitleIds(',
  );

  assert.match(overlay, /\.select\("id,user_id,source_id,media_item_id,item_type,external_id,playback_hint,codec_profile"\)/);
  assert.match(overlay, /\.eq\("user_id", userId\)/);
  assert.match(overlay, /\.eq\("item_type", "movie"\)/);
  assert.match(overlay, /\.in\("media_item_id", mediaIds\.slice\(index, index \+ 500\)\)/);
  assert.match(overlay, /flatMediaVariantKey\(variant\)/);
  assert.match(overlay, /flatMediaVariantKey\(item\)/);
  assert.doesNotMatch(overlay, /variantByExternalId|variantBySourceExternalId/);
});

test('the exact-file overlay exposes both API naming conventions and preserves useful row hints', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const overlay = between(
    catalog,
    'async function attachFlatMediaFileLanguages(',
    '\nasync function listVariantsByTitleIds(',
  );

  assert.match(overlay, /const codecProfile = recordOrEmpty\(variant\.codec_profile\)/);
  assert.match(overlay, /item\.codec_profile = codecProfile/);
  assert.match(overlay, /item\.codecProfile = codecProfile/);
  assert.match(overlay, /const mergedPlaybackHint = \{ \.\.\.recordOrEmpty\(item\.playback_hint \?\? item\.playbackHint\), \.\.\.variantPlaybackHint \}/);
  assert.match(overlay, /item\.playback_hint = mergedPlaybackHint/);
  assert.match(overlay, /item\.playbackHint = mergedPlaybackHint/);
  assert.match(overlay, /if \(Object\.keys\(codecProfile\)\.length\)/);
  assert.match(overlay, /if \(Object\.keys\(variantPlaybackHint\)\.length\)/);
});

test('flat variant identity requires media item, source and provider external id', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const key = between(
    catalog,
    'function flatMediaVariantKey(',
    '\nasync function attachFlatMediaFileLanguages(',
  );

  assert.match(key, /row\.media_item_id \?\? row\.mediaItemId \?\? row\.id/);
  assert.match(key, /row\.source_id \?\? row\.sourceId/);
  assert.match(key, /row\.external_id \?\? row\.externalId/);
  assert.match(key, /if \(!mediaItemId \|\| !sourceId \|\| !externalId\) return null/);
  assert.match(key, /JSON\.stringify\(\[mediaItemId, sourceId, externalId\]\)/);
});

test('catalog rollout proves the exact-file codec protocol on every Edge replica', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');
  const app = read('public/app.html');

  assert.match(catalog, /version:\s*6/);
  assert.match(catalog, /flatCodecProfileProtocol:\s*1/);
  assert.match(deploy, /EXPECTED_CATALOG_VERSION=6/);
  assert.match(deploy, /EXPECTED_FLAT_CODEC_PROFILE_PROTOCOL=1/);
  assert.match(deploy, /function_health_in_service "\$service" norva-catalog/);
  assert.match(deploy, /norva-catalog source digest mismatch/);
  assert.match(app, /\/js\/api\.js\?v=84/);
  assert.match(app, /\/js\/pages\/WatchPage\.js\?v=143/);
});
