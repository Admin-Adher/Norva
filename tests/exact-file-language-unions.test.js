const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  assert.ok(report.includes('this._observedLangsPending === key'));
  assert.ok(report.includes(
    'result?.ok === true && result?.updated === true && result?.exact === true',
  ));
  assert.ok(
    report.indexOf('result?.ok === true && result?.updated === true && result?.exact === true') <
      report.lastIndexOf('this._observedLangsSent = key'),
  );
  assert.ok(!report.includes('this._observedLangsSent = key;\n            window.API'));
});

test('Watch retries exact-file reporting until the server confirms a persisted update', async () => {
  const watch = read('public/js/pages/WatchPage.js');
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
  };
  vm.runInNewContext(watch, context, { filename: 'public/js/pages/WatchPage.js' });

  const outcomes = [
    () => Promise.reject(new Error('temporary 500')),
    () => Promise.resolve({ ok: true, updated: false, exact: true }),
    () => Promise.resolve({ ok: true, updated: true, exact: true }),
  ];
  let calls = 0;
  context.window.API = {
    isCloudMode: () => true,
    media: {
      reportObservedLanguages: () => outcomes[calls++](),
    },
  };
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    content: {
      titleId: '11111111-1111-4111-8111-111111111111',
      sourceId: 'source-local',
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      externalId: 'movie-42',
      type: 'movie',
    },
    _relayAudioTracks: [
      { index: 1, lang: 'fr' },
      { index: 2, lang: 'ja' },
    ],
  });

  for (let attempt = 0; attempt < outcomes.length; attempt += 1) {
    page.reportObservedAudioLanguages();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(page._observedLangsPending, null);
    if (attempt < outcomes.length - 1) {
      assert.equal(page._observedLangsSent, undefined);
      const callsBeforeThrottleCheck = calls;
      page.reportObservedAudioLanguages();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, callsBeforeThrottleCheck, 'a failed write is backoff-throttled');
      page._observedLangsRetryAt = 0;
    }
  }

  assert.equal(calls, 3);
  assert.match(page._observedLangsSent, /movie-42:1:fr\|2:ja$/);

  page.reportObservedAudioLanguages();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 3, 'a confirmed exact update is sent only once');
});

test('catalog resolves a missing title id from complete tenant file coordinates', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const record = between(
    catalog,
    'async function recordObservedLanguages(',
    '\nasync function listTitleRail(',
  );

  assert.ok(record.includes('let preResolvedVariant: JsonRecord | null = null'));
  assert.ok(record.includes('.from("cloud_catalog_visible_title_variants")'));
  assert.ok(record.includes('.eq("user_id", userId)'));
  assert.ok(record.includes('.eq("source_id", requestedSourceId)'));
  assert.ok(record.includes('.eq("item_type", requestedTypeRaw)'));
  assert.ok(record.includes('.eq("external_id", variantExternalId)'));
  assert.ok(record.includes('titleId = stringOrNull(preResolvedVariant.title_id)'));
  assert.ok(record.includes('reason: variants.length ? "variant_ambiguous" : "variant_not_owned"'));
  assert.ok(
    record.indexOf('titleId = stringOrNull(preResolvedVariant.title_id)') <
      record.indexOf('.from("cloud_catalog_visible_titles")'),
  );
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

test('probe evidence and speech verification remain separate catalogue facts', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260719200000_restore_audio_probe_continuity.sql'),
    'utf8'
  );
  const catalog = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'norva-catalog', 'index.ts'),
    'utf8'
  );

  assert.ok(migration.includes('file_audio_verified_languages'));
  assert.match(migration, /\nbegin;\s*\n/);
  assert.match(migration, /commit;\s*$/);
  assert.ok(migration.includes('where variant_id = default_variant_id'));
  assert.ok(!migration.includes('or matching_count = 1'));
  assert.ok(!migration.includes('cloud_titles_file_audio_verified_languages_gin'));
  assert.ok(migration.includes('and observation.audio_verified_at is not null'));
  assert.ok(migration.includes('Audio facet continuity check failed'));
  assert.ok(migration.includes('file_audio_verified_languages <@ title.file_audio_languages'));
  assert.ok(catalog.includes('? "verified"'));
  assert.ok(catalog.includes(': observedLanguages.length ? "probed" : "pending"'));
  assert.ok(catalog.includes('? "verified_union"'));
  assert.ok(catalog.includes(': observedAudioLanguages.length ? "probed_union"'));
  assert.ok(catalog.includes('strictlyVerifiedVariants.length >= expectedVariantCount'));
  assert.ok(catalog.includes('variants.length >= expectedVariantCount'));
  assert.ok(catalog.includes('audio_languages: observedAudioLanguages'));
  assert.ok(catalog.includes('audio_verified_languages: verifiedAudioLanguages'));
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

test('audio and subtitle facets share one modern canonical language namespace', () => {
  const migration = read(
    'supabase/migrations/20260830153000_catalog_language_canonicalization_v1.sql',
  );
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const mediaUtils = read('public/js/utils/mediaUtils.js');
  const record = between(
    catalog,
    'async function recordObservedLanguages(',
    '\nasync function listTitleRail(',
  );
  const facetItems = between(
    catalog,
    'function exactLanguageFacetItems(',
    '\nasync function listLanguageFacets(',
  );

  for (const source of [catalog, playback]) {
    assert.match(source, /iw:\s*"he"/);
    assert.match(source, /in:\s*"id"/);
    assert.match(source, /ji:\s*"yi"/);
    assert.match(source, /jw:\s*"jv"/);
    assert.match(source, /mo:\s*"ro"/);
    assert.match(source, /sh:\s*"sr"/);
  }
  for (const [legacy, canonical] of Object.entries({
    iw: 'he', in: 'id', ji: 'yi', jw: 'jv', mo: 'ro', sh: 'sr',
  })) {
    assert.ok(mediaUtils.includes(`${legacy}: '${canonical}'`));
  }

  assert.ok(record.includes(
    'const cleanLanguage = (value: unknown): string | null => canonicalFileLanguage(value);',
  ));
  assert.ok(facetItems.includes('canonicalFileLanguage(rawValue)'));
  assert.ok(migration.includes(
    'create or replace function public.norva_canonical_language_code(p_value text)',
  ));
  assert.ok(migration.includes(
    'create or replace function public.cloud_file_track_languages(p_tracks jsonb)',
  ));
  assert.ok(migration.includes('perform public.recompute_cloud_title_file_languages('));
  assert.ok(migration.includes("set refreshed_at = 'epoch'::timestamptz"));
  assert.match(migration, /when 'por' then 'pt'/);
  assert.match(migration, /when 'iw' then 'he'/);
  assert.match(migration, /when 'in' then 'id'/);
  assert.match(migration, /where language_code is not null/);
});

test('Movies, Series and player menus normalize locale and legacy track codes identically', () => {
  const context = { window: {} };
  vm.runInNewContext(read('public/js/utils/mediaUtils.js'), context);
  const normalize = context.window.MediaUtils.normalizeLanguagePreference;

  assert.strictEqual(normalize('iw'), 'he');
  assert.strictEqual(normalize('jw'), 'jv');
  assert.strictEqual(normalize('sh'), 'sr');
  assert.strictEqual(normalize('heb'), 'he');
  assert.strictEqual(normalize('sqi'), 'sq');
  assert.strictEqual(normalize('pt-BR'), 'pt');
  assert.strictEqual(normalize('en_US'), 'en');
  assert.strictEqual(normalize('true-french'), 'fr');

  for (const playerPath of [
    'public/js/pages/WatchPage.js',
    'public/js/components/VideoPlayer.js',
  ]) {
    const player = read(playerPath);
    assert.match(
      player,
      /normalizeTrackLanguage\(language\) \{[\s\S]{0,500}MediaUtils\.normalizeLanguagePreference\(language\)/,
    );
  }
});
