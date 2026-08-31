'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(ROOT, file), 'utf8')
  .replace(/\r\n?/g, '\n');
const catalog = read('supabase/functions/norva-catalog/index.ts');
const playback = read('supabase/functions/norva-playback/index.ts');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function assertNoBaseSelect(source, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(
    source,
    new RegExp(`\\.from\\("${escaped}"\\)\\s*\\.select\\(`),
    `${table} must not be a SELECT source`,
  );
}

test('every user-facing norva-catalog projection reads centralized visible views', () => {
  for (const view of [
    'cloud_catalog_visible_media_items',
    'cloud_catalog_visible_titles',
    'cloud_catalog_visible_title_variants',
    'cloud_catalog_visible_live_logical_channels',
    'cloud_catalog_visible_live_variants',
  ]) {
    assert.match(catalog, new RegExp(`\\.from\\("${view}"\\)`), `missing visible view ${view}`);
  }

  for (const table of [
    'cloud_sources',
    'cloud_media_items',
    'cloud_titles',
    'cloud_title_variants',
    'cloud_live_logical_channels',
    'cloud_live_variants',
  ]) assertNoBaseSelect(catalog, table);

  assert.doesNotMatch(catalog, /cloud_title_variants!inner/);
  assert.match(catalog, /\.from\("cloud_catalog_visible_sources"\)/);
  const sourceContext = section(
    catalog,
    'async function sourceCatalogContextFor(',
    '\nasync function sourceHealthFor(',
  );
  assert.match(sourceContext, /\.from\("cloud_catalog_visible_sources"\)/);
  assert.match(sourceContext, /\.in\("source_id", visibleSourceIds\)/);
  assert.doesNotMatch(catalog, /useCatalog \? "catalog_titles" : "cloud_titles"/);
  assert.match(catalog, /\.from\("cloud_titles"\)\s*\.update\(update\)/);
});

test('source-scoped and all-source genre language paths stay bounded and exact', () => {
  const summary = section(catalog, 'async function listGenreSummary(', '\nconst GENRE_RAIL_MIN_ITEMS');
  const items = section(catalog, 'async function listGenreItems(', '\n// Dynamic menu options:');
  const languagePage = section(
    catalog,
    'async function visibleTitlePageByLanguages(',
    '\n// Distinct ISO-639 languages',
  );

  assert.match(summary, /contains\("visible_source_ids", \[sourceId\]\)/);
  assert.match(items, /contains\("visible_source_ids", \[sourceId\]\)/);
  assert.match(items, /const needsLanguagePage = Boolean\(/);
  assert.match(items, /!sourceId && hasStrictLanguageFilter && !langSort/);
  assert.match(items, /if \(needsLanguagePage\)/);
  assert.match(items, /visibleTitlePageByLanguages\(\{/);
  assert.match(items, /hiddenBuckets: \[\.\.\.hidden\]/);
  assert.match(items, /page\.titleIds/);
  assert.match(items, /count: page\.count/);
  assert.match(languagePage, /db\.rpc\("cloud_catalog_visible_title_language_page"/);
  assert.match(languagePage, /p_source_id: options\.sourceId/);
  assert.match(languagePage, /audio: options\.audioIso/);
  assert.match(languagePage, /subtitle: options\.subtitleIso/);
  assert.doesNotMatch(items, /sourceLanguageTitleIds/);
  assert.doesNotMatch(items, /TITLE_VARIANT_QUERY_CHUNK/);
});

test('playback visibility is fail-closed before sessions and config access', () => {
  const create = section(playback, 'async function createPlaybackSession(', '\nasync function getPlaybackSession(');
  const config = section(playback, 'async function loadSourceConfigRevision(', '\nasync function assertOwnedSource(');

  const ownership = create.indexOf('await assertOwnedSource(sourceId, userId, db)');
  const visibility = create.indexOf('await assertSourceCatalogVisible(sourceId, userId, db)');
  const resolution = create.indexOf('await resolvePlaybackTarget(');
  assert.ok(ownership >= 0 && visibility > ownership && resolution > visibility);

  assert.match(config, /db\.rpc\("norva_source_catalog_visible"/);
  assert.match(config, /p_source_id: sourceId/);
  assert.match(config, /p_user_id: userId/);
  assert.match(config, /if \(error\) throwDb\(error, "Unable to verify source catalog visibility"\)/);
  assert.match(config, /code: "SOURCE_CATALOG_NOT_VISIBLE"/);
  assert.match(config, /\.from\("cloud_source_lifecycle"\)/);
  assert.match(config, /\.select\("config_revision"\)/);
  assert.match(config, /cached\.configRevision === configRevision/);
  assert.match(config, /confirmedRevision !== configRevision/);
  assert.ok(
    (config.match(/await assertSourceCatalogVisible\(sourceId, userId, db\)/g) || []).length >= 2,
    'config loads must re-check visibility around ciphertext decryption',
  );
});

test('background enrichment skips hidden or staging sources and reads visible candidates', () => {
  const entry = section(playback, 'async function runAudioBackfill(', '\nasync function claimProviderFileProbeStrict(');
  const episode = section(playback, 'async function runEpisodeAudioBackfill(', '\nasync function runOneDimension(');
  const dimension = section(playback, 'async function runOneDimension(', '\nasync function runCatalogMirrorVerify');

  for (const source of [entry, episode, dimension]) {
    assert.match(source, /sourceCatalogVisible\(/);
    assert.match(source, /source-catalog-not-visible/);
    assert.match(source, /SOURCE_CATALOG_NOT_VISIBLE/);
  }
  for (const table of ['cloud_media_items', 'cloud_titles', 'cloud_title_variants']) {
    assertNoBaseSelect(playback, table);
  }
  assert.match(entry, /bindCatalogVisibilityEpochShared\(req, auditMeta\.userId, db\)/);
  assert.match(dimension, /\.from\("cloud_catalog_visible_titles"\)/);
  assert.match(dimension, /hydrateVisiblePlaybackTitles\(/);
  assert.match(playback, /db\.rpc\("norva_get_visible_catalog_titles_by_ids"/);
  assert.match(dimension, /\.from\("cloud_catalog_visible_title_variants"\)/);
  assert.match(dimension, /\.from\("cloud_titles"\)\s*\.update\(/);
  assert.match(playback, /\.from\("cloud_title_variants"\)\s*\.update\(/);
});
