const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};

test('Watch reports only a complete exact-file audio map', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const report = between(
    watch,
    '\n    reportObservedAudioLanguages() {',
    '\n    updateAudioTracks()',
  );

  assert.ok(report.includes('Array.isArray(this._relayAudioTracks)'));
  assert.ok(report.includes('if (!orderedTracks.length) return;'));
  assert.ok(report.includes("audioTracksScope: 'file'"));
  assert.ok(report.includes('audioTracks: orderedTracks'));
  assert.ok(!report.includes('const codes = new Set()'));
  assert.ok(!report.includes('content?.audioLanguages'));
  assert.ok(!report.includes('content?.audio_languages'));
  assert.ok(!report.includes('cloudAudioInfo.language'));
  assert.ok(!report.includes('audio:'));
});

test('gateway enrichment preserves unknown tracks before exact-file reporting', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const enrichment = between(
    watch,
    '\n    async enrichEngineSubtitleTracks() {',
    '\n    gatewaySubtitleUrlForTrack(streamIndex) {',
  );

  assert.ok(enrichment.includes('.filter((a) => Number.isInteger(Number(a.index)))'));
  assert.ok(enrichment.includes('lang: this.normalizeTrackLanguage(a.language || a.lang) || null'));
  assert.ok(enrichment.includes('const gatewayHasLang = gwAudio.some'));
  assert.ok(enrichment.includes('if (gatewayHasLang && !relayHasLang)'));
  assert.ok(!enrichment.includes('Number.isInteger(Number(a.index)) && a.language'));
  assert.ok(!enrichment.includes('.filter((a) => a.lang && a.lang !== \'und\')'));
});

test('catalog never promotes code-only or title hints to exact file evidence', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const record = between(
    catalog,
    'async function recordObservedLanguages(',
    '\nasync function listTitleRail(',
  );

  assert.ok(record.includes('audioTracksScope === "file" && orderedTracks.length > 0'));
  assert.ok(record.includes('subtitleTracksScope === "file" && subtitleTracksArrayProvided'));
  assert.ok(record.includes('if (hasExactAudioMap || hasExactSubtitleMap)'));
  assert.ok(record.includes('p_audio_tracks: orderedTracks'));
  assert.ok(record.includes('p_has_audio: hasExactAudioMap'));
  assert.ok(record.includes('p_has_subtitle: hasExactSubtitleMap'));
  assert.ok(!record.includes('unionAudioTracks'));
  assert.ok(!record.includes('upsert_catalog_file_tracks'));
  assert.ok(!record.includes('fanout_file_tracks_to_users'));
});

test('catalog exposes tenant exact-file language sets without manufacturing track indexes', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const observations = between(
    catalog,
    'async function fileLanguageObservationsByVariant(',
    '\n// Attach the GLOBAL cache entry',
  );
  const variantItem = between(
    catalog,
    'function titleVariantItem(',
    '\nasync function listRawMediaRail(',
  );
  const mediaUtils = read('public/js/utils/mediaUtils.js');

  assert.ok(observations.includes('cloud_title_file_language_observations'));
  assert.ok(observations.includes('audio_observed'));
  assert.ok(observations.includes('__file_audio_languages'));
  assert.ok(!observations.includes('audio_tracks'));
  assert.ok(variantItem.includes('audio_languages_scope: audioLanguages !== undefined ? "file"'));
  assert.ok(variantItem.includes('subtitle_languages_scope: subtitleLanguages !== undefined ? "file"'));
  assert.ok(mediaUtils.includes("source: 'file-languages'"));
  assert.ok(mediaUtils.includes("if (scope !== 'file'"));
});

test('flat movie pages join tenant observations by owned media variant', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const flat = between(
    catalog,
    'async function attachFlatMediaFileLanguages(',
    '\nasync function listVariantsByTitleIds(',
  );
  assert.ok(flat.includes('.eq("user_id", userId)'));
  assert.ok(flat.includes('.in("media_item_id"'));
  assert.ok(flat.includes('audio_languages_scope = "file"'));
  assert.ok(!flat.includes('audio_tracks ='));
});

test('an audio-filtered rail prefers the exact tenant-observed matching version', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const variants = between(
    catalog,
    'async function listVariantsByTitleIds(',
    '\n// User display language',
  );
  assert.ok(variants.includes('variant.__file_audio_observed === true'));
  assert.ok(variants.includes('variant.__file_audio_languages'));
  assert.ok(variants.includes('orderedTrackMatch || tenantLanguageMatch'));
});

test('title recompute invalidates facets only when exact arrays change', () => {
  const migration = read('supabase/migrations/20260719130000_exact_file_language_unions.sql');
  const recompute = between(
    migration,
    'create or replace function public.recompute_cloud_title_file_languages(',
    '\nrevoke all on function public.recompute_cloud_title_file_languages(',
  );
  const merge = between(
    migration,
    'create or replace function public.merge_cloud_title_file_languages(',
    '\nrevoke all on function public.merge_cloud_title_file_languages(',
  );
  const hydrate = between(
    migration,
    'create or replace function public.hydrate_cloud_title_file_languages(',
    '\nrevoke all on function public.hydrate_cloud_title_file_languages(',
  );

  assert.ok(recompute.includes('is distinct from v_audio'));
  assert.ok(recompute.includes('is distinct from v_subtitles'));
  assert.ok(recompute.includes('returning t.item_type into v_item_type'));
  assert.ok(recompute.includes("set refreshed_at = 'epoch'::timestamptz"));
  assert.ok(!merge.includes("set refreshed_at = 'epoch'::timestamptz"));
  assert.ok(!hydrate.includes("set refreshed_at = 'epoch'::timestamptz"));
});

test('all exact-language RPC callers pass variant and file identity', () => {
  const migration = read('supabase/migrations/20260719130000_exact_file_language_unions.sql');
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const playback = read('supabase/functions/norva-playback/index.ts');

  for (const source of [migration, catalog, playback]) {
    assert.ok(source.includes('p_variant_id'));
    assert.ok(source.includes('p_file_external_id'));
  }
  assert.ok(migration.includes(
    'uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean',
  ));
});
