'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const CLOUD_PATH = path.join(ROOT, 'supabase/functions/norva-cloud/index.ts');
const PUBLIC_PATH = path.join(ROOT, 'supabase/functions/_shared/cloud-public-view.mjs');
const SOURCE_PUBLIC_PATH = path.join(ROOT, 'supabase/functions/_shared/source-public-view.mjs');
const CLOUD = fs.readFileSync(CLOUD_PATH, 'utf8').replace(/\r\n/g, '\n');

function section(start, end) {
  const from = CLOUD.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = CLOUD.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return CLOUD.slice(from, to);
}

test('paired sources and content events are constrained by the centralized visible-source projection', () => {
  const paired = section('if (scope === "device") {', '\n  const user = await requireUser');
  assert.match(paired, /listVisibleSources\(device\.user_id, db\)/);
  assert.match(paired, /segments\[3\] === "test"[\s\S]*await assertVisibleSource\(action, device\.user_id, db\)/);
  assert.match(paired, /listVisibleContentEvents\(url, device\.user_id, db\)/);

  const visibleSources = section('async function listVisibleSources(', 'async function listVisibleSourceIds(');
  assert.match(visibleSources, /cloud_catalog_visible_sources/);
  assert.match(visibleSources, /SOURCE_CATALOG_PUBLIC_SELECT/);
  assert.match(visibleSources, /sanitizeCatalogSource/);
  assert.doesNotMatch(visibleSources, /cloud_source_management_sources|cloud_sources/);

  const events = section('function visibleContentEventFilter(', 'async function managedSourceSnapshot(');
  assert.match(events, /visibleContentEventFilter\(await listVisibleSourceIds\(userId, db\)\)/);
  assert.match(events, /source_id\.is\.null,source_id\.in/);
  assert.match(events, /\.or\(sourceFilter\)/);
  assert.match(events, /\.map\(sanitizeContentEvent\)\.filter\(Boolean\)/);
  assert.match(events, /unreadRes\.count/);
});

test('content-event sanitizer keeps the inbox contract without raw source/provider identifiers or bodies', async () => {
  const { sanitizeContentEvent } = await import(pathToFileURL(PUBLIC_PATH).href);
  const sourceId = '10000000-0000-4000-8000-000000000001';
  const event = sanitizeContentEvent({
    id: '20000000-0000-4000-8000-000000000002',
    user_id: '30000000-0000-4000-8000-000000000003',
    source_id: sourceId,
    kind: 'subtitle_ready',
    summary: 'Ready https://provider.example/player_api.php?username=alice&password=secret password=secret',
    payload: {
      itemType: 'series',
      externalId: 'raw-provider-id',
      kind: 'transcript',
      lang: 'fr',
      watch: `series/open:${sourceId}:series_42:My%20Show`,
      providerResponse: { token: 'provider-secret' },
      credentials: { username: 'alice', password: 'secret' },
    },
    created_at: '2026-08-23T00:00:00Z',
    seen_at: null,
  });

  assert.equal(event.id, '20000000-0000-4000-8000-000000000002');
  assert.equal(event.kind, 'subtitle_ready');
  assert.equal(event.payload.itemType, 'series');
  assert.equal(event.payload.kind, 'transcript');
  assert.equal(event.payload.lang, 'fr');
  assert.equal(event.payload.watch, `series/open:${sourceId}:series_42:My%20Show`);
  assert.equal(event.seen_at, null);
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    '"source_id"',
    'externalId',
    'raw-provider-id',
    'providerResponse',
    'provider-secret',
    'player_api.php',
    'alice',
    'password=secret',
  ]) assert.equal(serialized.includes(forbidden), false, `content event leaked ${forbidden}`);

  const wrongSource = sanitizeContentEvent({
    id: '20000000-0000-4000-8000-000000000004',
    source_id: sourceId,
    kind: 'subtitle_ready',
    summary: 'Ready',
    payload: {
      watch: 'series/open:90000000-0000-4000-8000-000000000009:series_42:My%20Show',
    },
    created_at: '2026-08-23T00:00:00Z',
  });
  assert.equal(Object.hasOwn(wrongSource.payload, 'watch'), false);
});

test('series-info and short-EPG sanitizers preserve playback/display fields and remove credential-bearing provider data', async () => {
  const { sanitizeXtreamSeriesInfo, sanitizeXtreamShortEpg } = await import(pathToFileURL(PUBLIC_PATH).href);
  const series = sanitizeXtreamSeriesInfo({
    user_id: 'raw-account-id',
    info: {
      name: 'Example show',
      plot: 'A safe synopsis',
      overview: 'Provider echoed alice and secret',
      cover: 'https://alice:secret@provider.example/images/show.jpg',
      cover_big: 'https://cdn.example/show.jpg',
      direct_source: 'https://provider.example/series/alice/secret/42.mkv',
      credentials: { username: 'alice', password: 'secret' },
    },
    seasons: [{ id: 1, name: 'Season 1', season_number: 1, cover: 'https://cdn.example/s1.jpg', token: 'secret' }],
    episodes: {
      1: [{
        id: 'episode_7',
        episode_num: 7,
        title: 'Episode 7',
        container_extension: 'mkv',
        direct_source: 'https://provider.example/series/alice/secret/7.mkv',
        target_url: 'https://provider.example/player_api.php?username=alice&password=secret',
        info: {
          plot: 'Episode synopsis',
          movie_image: 'https://cdn.example/e7.jpg',
          provider_body: { password: 'secret' },
        },
      }],
    },
    provider_body: { password: 'secret' },
  }, { knownSecrets: ['alice', 'secret'] });

  assert.equal(series.info.name, 'Example show');
  assert.equal(series.info.cover_big, 'https://cdn.example/show.jpg');
  assert.equal(Object.hasOwn(series.info, 'cover'), false);
  assert.equal(series.episodes['1'][0].id, 'episode_7');
  assert.equal(series.episodes['1'][0].episode_num, 7);
  assert.equal(series.episodes['1'][0].container_extension, 'mkv');
  assert.equal(series.episodes['1'][0].info.movie_image, 'https://cdn.example/e7.jpg');
  const seriesJson = JSON.stringify(series);
  for (const forbidden of [
    'direct_source',
    'target_url',
    'player_api.php',
    'raw-account-id',
    'provider_body',
    'credentials',
    'alice',
    'secret',
  ]) assert.equal(seriesJson.includes(forbidden), false, `series info leaked ${forbidden}`);

  const adversarialImages = sanitizeXtreamSeriesInfo({
    info: {
      name: 'Credential URL probes',
      cover: 'https://cdn.example/cover.jpg?sig=BEARER456',
      cover_big: 'https://cdn.example/cover.jpg?X-Amz-Signature=BEARER456',
      movie_image: 'https://provider.example/images/u/pw/cover.jpg',
    },
    seasons: [{ id: 1, cover: 'https://cdn.example/s1.jpg?Policy=private-policy' }],
    episodes: {
      1: [{
        id: 'episode_probe',
        info: { movie_image: 'https://provider.example/series/u/pw/42.mkv' },
      }],
    },
  }, { knownSecrets: ['u', 'pw'] });
  const adversarialJson = JSON.stringify(adversarialImages);
  for (const forbidden of [
    'BEARER456',
    'X-Amz-Signature',
    'Policy',
    '/images/u/pw/',
    '/series/u/pw/',
  ]) assert.equal(adversarialJson.includes(forbidden), false, `series image leaked ${forbidden}`);

  const title = Buffer.from('Evening news', 'utf8').toString('base64');
  const description = Buffer.from(
    'Details https://provider.example/player_api.php?username=alice&password=secret',
    'utf8',
  ).toString('base64');
  const epg = sanitizeXtreamShortEpg({
    epg_listings: [{
      title,
      description,
      start_timestamp: '1787443200',
      stop_timestamp: '1787446800',
      direct_source: 'https://provider.example/live/alice/secret/42.ts',
      token: 'secret',
    }, {
      title: 'invalid',
      start_timestamp: '20',
      stop_timestamp: '10',
    }],
    username: 'alice',
    password: 'secret',
  });
  assert.equal(epg.epg_listings.length, 1);
  assert.equal(Buffer.from(epg.epg_listings[0].title, 'base64').toString('utf8'), 'Evening news');
  const cleanDescription = Buffer.from(epg.epg_listings[0].description, 'base64').toString('utf8');
  assert.equal(cleanDescription.includes('player_api.php'), false);
  assert.equal(cleanDescription.includes('alice'), false);
  const epgJson = JSON.stringify(epg);
  for (const forbidden of ['direct_source', 'token', 'username', 'password', 'secret']) {
    assert.equal(epgJson.includes(forbidden), false, `EPG leaked ${forbidden}`);
  }
});

test('history writes promote an embedded visible source and history reads reject hidden embedded references', () => {
  const save = section('async function saveHistory(', 'async function recordPlaybackEvent(');
  assert.match(save, /let sourceId = strictOptionalSourceReference\(body\.sourceId, body\.source_id, "sourceId"\)/);
  assert.match(save, /if \(!sourceId\)[\s\S]*rawHistoryData\.sourceId[\s\S]*rawHistoryData\.source_id/);
  assert.match(save, /sourceId\) await assertVisibleSource\(sourceId, userId, db\)/);
  assert.match(save, /delete historyData\.source_id[\s\S]*historyData\.sourceId = sourceId/);

  const normalize = section('function normalizeHistoryRowForVisibility(', 'async function loadLegacyNullHistoryData(');
  assert.match(normalize, /visibleSourceIds\.has\(topLevelSourceId\)/);
  assert.match(normalize, /if \(embedded\.invalid\) return null/);
  assert.match(normalize, /visibleSourceIds\.has\(embedded\.sourceId\)/);
  assert.match(normalize, /row\.source_id = embedded\.sourceId/);

  const targeted = section('async function getHistoryItem(', 'async function listHistory(');
  assert.match(targeted, /loadLegacyNullHistoryData/);
  assert.match(targeted, /normalizeHistoryRowForVisibility/);
  assert.match(targeted, /sourceId && visible\.source_id && visible\.source_id !== sourceId/);

  const list = section('async function listHistory(', 'async function listHistorySources(');
  assert.match(list, /const visibleSourceIds = await listVisibleSourceIds\(userId, db\)/);
  assert.match(list, /normalizeHistoryRowForVisibility\(row, visibleSourceIds\)/);
});

test('paired source sanitizer omits management-only relationships and private configuration', async () => {
  const { sanitizeCatalogSource, SOURCE_CATALOG_PUBLIC_SELECT } = await import(pathToFileURL(SOURCE_PUBLIC_PATH).href);
  const source = sanitizeCatalogSource({
    id: '10000000-0000-4000-8000-000000000001',
    user_id: 'private-account-id',
    display_name: 'Living room',
    source_type: 'xtream',
    config_ciphertext: 'ciphertext-secret',
    config_hint: { serverHost: 'provider.example', username: 'alice', password: 'secret' },
    replaces_source_id: '20000000-0000-4000-8000-000000000002',
    replaced_by_source_id: '30000000-0000-4000-8000-000000000003',
    rollback_until: '2026-09-01T00:00:00Z',
  });
  assert.equal(source.catalog_visible, true);
  assert.equal(source.config_hint.serverHost, 'provider.example');
  const serialized = JSON.stringify(source);
  for (const forbidden of [
    'user_id',
    'private-account-id',
    'config_ciphertext',
    'ciphertext-secret',
    'username',
    'password',
    'replaces_source_id',
    'replaced_by_source_id',
    'rollback_until',
  ]) assert.equal(serialized.includes(forbidden), false, `paired source leaked ${forbidden}`);
  assert.equal(SOURCE_CATALOG_PUBLIC_SELECT.includes('user_id'), false);
  assert.equal(SOURCE_CATALOG_PUBLIC_SELECT.includes('config_ciphertext'), false);
});

test('legacy source PATCH is cosmetic-only and cannot mutate provider configuration or sync internals', () => {
  const update = section('async function updateSource(', '\nconst LEGACY_SOURCE_CREDENTIAL_FIELDS');
  assert.match(update, /assertLegacySourcePatchAllowlisted\(body\)/);
  assert.match(update, /\.update\(\{ display_name: displayName \}\)/);
  assert.match(update, /\.is\("deleted_at", null\)/);
  assert.doesNotMatch(update, /buildSourceConfig|validateCloudSource|encryptSourceConfig|config_ciphertext|sync_status|sync_error|config_hint|last_synced_at/);

  const guard = section(
    'const LEGACY_SOURCE_CREDENTIAL_FIELDS',
    '\nasync function syncExistingSource(',
  );
  for (const field of [
    'serverUrl',
    'server_url',
    'username',
    'password',
    'playlistUrl',
    'playlist_url',
    'epgUrl',
    'epg_url',
    'url',
    'config',
    'configCiphertext',
    'config_ciphertext',
  ]) assert.match(guard, new RegExp(`"${field}"`), `legacy guard omitted ${field}`);
  assert.match(guard, /LEGACY_SOURCE_PATCH_FIELDS = new Set\(\["displayName", "display_name"\]\)/);
  assert.match(guard, /DIRECT_CREDENTIAL_MUTATION_FORBIDDEN/);
  assert.match(guard, /keys\.some\(\(key\) => !LEGACY_SOURCE_PATCH_FIELDS\.has\(key\)\)/);
  assert.doesNotMatch(guard, /syncNow|sourceType|configHint|syncStatus|syncError|lastSyncedAt/);
});
