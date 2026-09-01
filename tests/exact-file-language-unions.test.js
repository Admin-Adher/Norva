const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};

test('Watch reports only complete exact-file audio/subtitle maps', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const report = between(
    watch,
    '\n    reportObservedAudioLanguages() {',
    '\n    updateAudioTracks()',
  );

  assert.ok(report.includes('Array.isArray(this._relayAudioTracks)'));
  assert.ok(report.includes('if (!hasExactAudioMap && !hasExactSubtitleMap) return;'));
  assert.ok(report.includes("audioTracksScope: 'file'"));
  assert.ok(report.includes('audioTracks: orderedTracks'));
  assert.ok(report.includes("subtitleTracksScope: 'file'"));
  assert.ok(report.includes('subtitleTracks: orderedSubtitleTracks'));
  assert.ok(!report.includes('const codes = new Set()'));
  assert.ok(!report.includes('content?.audioLanguages'));
  assert.ok(!report.includes('content?.audio_languages'));
  assert.ok(!report.includes('cloudAudioInfo.language'));
  assert.ok(!report.includes('\n                audio:'));
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

test('Watch retries HTTP 400/503 exact-file reports until the server confirms a persisted update', async () => {
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

  const httpFailure = (status) => () => Promise.reject(
    Object.assign(new Error(`HTTP ${status}`), { status }),
  );
  const outcomes = [
    httpFailure(400),
    httpFailure(503),
    () => Promise.resolve({ ok: false, updated: false, exact: false }),
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

  assert.equal(calls, outcomes.length);
  assert.match(page._observedLangsSent, /movie-42:audio:1:fr\|2:ja:subtitles:-$/);

  page.reportObservedAudioLanguages();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, outcomes.length, 'a confirmed exact update is sent only once');
});

test('catalog resolves a missing titleId only through one tenant-owned exact variant', async () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const source = between(
    catalog,
    'async function recordObservedLanguages(',
    '\ntype CatalogTitleSelectorMode',
  )
    .replace(
      'async function recordObservedLanguages(req: Request, userId: string)',
      'async function recordObservedLanguages(req, userId)',
    )
    .replace(/: JsonRecord \| null/g, '')
    .replace(/: JsonRecord/g, '')
    .replace(/: unknown/g, '')
    .replace(/: string \| null/g, '')
    .replace(/ as JsonRecord\[\]/g, '')
    .replace(/ as unknown\[\]/g, '')
    .replace(/ as JsonRecord/g, '')
    .replace(/\.filter\(\(code\): code is string =>/g, '.filter((code) =>');

  const helpers = vm.runInNewContext(
    `(() => {
      class HttpError extends Error {
        constructor(status, message) { super(message); this.status = status; }
      }
      const recordOrEmpty = (value) => value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
      const stringOrNull = (value) => value == null || String(value).trim() === ''
        ? null
        : String(value).trim();
      const canonicalFileLanguage = (value) => stringOrNull(value)?.toLowerCase() || null;
      const normalizeObservedSubtitleTracks = () => [];
      const throwDb = (error) => { throw error; };
      const FACET_CACHE = new Map();
      let mergeCalls = [];
      const mergeObservedExactFileLanguages = async (_db, values) => {
        mergeCalls.push(values);
        return 'merged';
      };
      let scenario = 'owned';
      let queryLog = [];
      const ownedVariant = {
        id: '33333333-3333-4333-8333-333333333333',
        user_id: 'tenant-a',
        title_id: '11111111-1111-4111-8111-111111111111',
        source_id: '22222222-2222-4222-8222-222222222222',
        item_type: 'movie',
        external_id: 'movie-42',
      };
      class Query {
        constructor(table) { this.table = table; this.filters = []; this.operation = 'select'; }
        select() { return this; }
        update(value) { this.operation = 'update'; this.value = value; return this; }
        eq(column, value) { this.filters.push([column, value]); return this; }
        limit(value) { this.limitValue = value; return this; }
        maybeSingle() { return Promise.resolve(this.execute(true)); }
        then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
        execute(single) {
          queryLog.push({ table: this.table, operation: this.operation, filters: this.filters.slice() });
          if (this.operation === 'update') return { data: null, error: null };
          if (this.table === 'cloud_catalog_visible_title_variants') {
            const resolving = !this.filters.some(([column]) => column === 'title_id');
            if (resolving) {
              if (scenario === 'foreign') return { data: [], error: null };
              if (scenario === 'ambiguous') return { data: [ownedVariant, { ...ownedVariant, id: '44444444-4444-4444-8444-444444444444' }], error: null };
              return { data: [ownedVariant], error: null };
            }
            return { data: [ownedVariant, { ...ownedVariant, id: '55555555-5555-4555-8555-555555555555' }], error: null };
          }
          if (this.table === 'cloud_catalog_visible_titles') {
            return {
              data: single ? {
                id: ownedVariant.title_id,
                item_type: 'movie',
                variant_count: 2,
                audio_languages: [],
                audio_tracks: null,
                audio_probed_at: null,
                subtitle_tracks: null,
                subtitle_probed_at: null,
              } : [],
              error: null,
            };
          }
          throw new Error('unexpected table ' + this.table);
        }
      }
      const db = { from: (table) => new Query(table) };
      ${source}
      return {
        async run(nextScenario) {
          scenario = nextScenario;
          queryLog = [];
          mergeCalls = [];
          const req = { json: async () => ({
            cloudSourceId: ownedVariant.source_id,
            itemType: 'movie',
            externalId: ownedVariant.external_id,
            audioTracksScope: 'file',
            audioTracks: [{ index: 1, lang: 'fr' }],
          }) };
          const result = await recordObservedLanguages(req, 'tenant-a');
          return { result, queryLog, mergeCalls };
        },
      };
    })()`,
  );

  const owned = await helpers.run('owned');
  assert.equal(owned.result.updated, true);
  assert.equal(owned.result.exact, true);
  assert.equal(owned.mergeCalls.length, 1);
  assert.equal(owned.mergeCalls[0].titleId, '11111111-1111-4111-8111-111111111111');
  assert.equal(owned.mergeCalls[0].userId, 'tenant-a');
  const resolvingQuery = owned.queryLog.find((query) =>
    query.table === 'cloud_catalog_visible_title_variants' &&
    !query.filters.some(([column]) => column === 'title_id'));
  assert.ok(resolvingQuery);
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolvingQuery.filters)),
    [
      ['user_id', 'tenant-a'],
      ['source_id', '22222222-2222-4222-8222-222222222222'],
      ['item_type', 'movie'],
      ['external_id', 'movie-42'],
    ],
  );

  const foreign = await helpers.run('foreign');
  assert.equal(foreign.result.updated, false);
  assert.equal(foreign.result.reason, 'variant_not_owned');
  assert.equal(foreign.mergeCalls.length, 0);

  const ambiguous = await helpers.run('ambiguous');
  assert.equal(ambiguous.result.updated, false);
  assert.equal(ambiguous.result.reason, 'variant_ambiguous');
  assert.equal(ambiguous.mergeCalls.length, 0);
});

test('Watch persists an explicitly complete empty subtitle map without manufacturing audio', async () => {
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

  const payloads = [];
  context.window.API = {
    isCloudMode: () => true,
    media: {
      reportObservedLanguages: async (payload) => {
        payloads.push(payload);
        return { ok: true, updated: true, exact: true };
      },
    },
  };
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    content: {
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      externalId: 'movie-no-subs',
      type: 'movie',
    },
    _relayAudioTracks: null,
  });

  assert.equal(page.captureExactSubtitleTrackMap([], {}), false);
  page.reportObservedAudioLanguages();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(payloads.length, 0, 'an unproven empty list is not file evidence');

  assert.equal(page.captureExactSubtitleTrackMap([], { subtitleProbeComplete: true }), true);
  page.reportObservedAudioLanguages();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(payloads.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(payloads[0].subtitleTracks)), []);
  assert.equal(payloads[0].subtitleTracksScope, 'file');
  assert.equal(Object.hasOwn(payloads[0], 'audioTracks'), false);
  assert.equal(Object.hasOwn(payloads[0], 'audioTracksScope'), false);
});

test('Watch treats a successful gateway subtitle enumeration as exact file evidence', async () => {
  const watch = read('public/js/pages/WatchPage.js');
  let requestedUrl = null;
  const context = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
    fetch: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          // This is the production gateway shape: it intentionally has no
          // subtitleProbeComplete/subtitleTracksScope compatibility fields.
          subtitles: [{ index: 7, language: 'fr', codec: 'subrip', extractable: true }],
          audioTracks: [],
        }),
      };
    },
  };
  vm.runInNewContext(watch, context, { filename: 'public/js/pages/WatchPage.js' });

  let payload = null;
  context.window.API = {
    isCloudMode: () => true,
    media: {
      reportObservedLanguages: async (value) => {
        payload = value;
        return { ok: true, updated: true, exact: true };
      },
    },
  };
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    content: {
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      externalId: 'movie-engine-subs',
      type: 'movie',
    },
    contentType: 'movie',
    baseStreamUrl: 'https://gateway.example/raw/playback-token',
    _playbackAttemptId: 'attempt-1',
    _relayAudioTracks: null,
    norvaEngine: {
      subtitleStreams: () => [7],
      audioStreamIndices: () => [],
    },
    isStalePlaybackAttempt: () => false,
    normalizeTrackLanguage: (language) => language,
    updateCaptionsTracks: () => {},
  });

  await page.enrichEngineSubtitleTracks();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requestedUrl, 'https://gateway.example/subtitle/playback-token');
  assert.equal(page._observedSubtitleProbeComplete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.subtitleTracks)), [{
    index: 7,
    lang: 'fr',
    codec: 'subrip',
    subtitleType: 'text',
    extractable: true,
    forced: false,
    default: false,
  }]);
  assert.equal(payload.subtitleTracksScope, 'file');
});

test('Watch episode handoffs preserve cloud title and exact file coordinates', async () => {
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
    MediaUtils: {
      playbackHintFromItem: () => ({}),
    },
  };
  vm.runInNewContext(watch, context, { filename: 'public/js/pages/WatchPage.js' });

  const played = [];
  const reports = [];
  context.window.API = {
    isCloudMode: () => true,
    media: {
      reportObservedLanguages: async (payload) => {
        reports.push(payload);
        return { ok: true, updated: true, exact: true };
      },
    },
  };
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    content: {
      sourceId: 'provider-local-id',
      cloud_source_id: '22222222-2222-4222-8222-222222222222',
      title_id: '11111111-1111-4111-8111-111111111111',
      series_id: 'series-9',
      title: 'Series title',
    },
    seriesInfo: { episodes: {} },
    findEpisodeById: (id) => ({ id, container_extension: 'mkv' }),
    getPlaybackPreferences: () => ({}),
    applyPlaybackPreferencesToHint: (hint) => hint,
    play: async function play(content) {
      played.push(content);
      this.content = content;
    },
  });
  const episodeEl = {
    dataset: {
      episodeId: 'episode-list',
      season: '1',
      episode: '2',
      container: 'mkv',
    },
    querySelector: () => ({ textContent: 'Second episode' }),
  };

  await page.playEpisodeFromList(episodeEl);
  await page.playEpisode({
    id: 'episode-next',
    seasonNum: 1,
    episode_num: 3,
    title: 'Third episode',
    container_extension: 'mkv',
  });

  assert.equal(played.length, 2);
  for (const [content, externalId] of [
    [played[0], 'episode-list'],
    [played[1], 'episode-next'],
  ]) {
    assert.equal(content.cloudSourceId, '22222222-2222-4222-8222-222222222222');
    assert.equal(content.titleId, '11111111-1111-4111-8111-111111111111');
    assert.equal(content.type, 'series');
    assert.equal(content.externalId, externalId);
    assert.equal(content.parentExternalId, 'series-9');

    page.content = content;
    page.resetObservedTrackPersistenceState();
    page._relayAudioTracks = [{ index: 1, lang: 'fr' }];
    page.reportObservedAudioLanguages();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(reports.length, 2, 'both real handoff shapes remain eligible for exact reporting');
  assert.deepEqual(reports.map((payload) => ({
    titleId: payload.titleId,
    cloudSourceId: payload.cloudSourceId,
    itemType: payload.itemType,
    externalId: payload.externalId,
    parentExternalId: payload.parentExternalId,
  })), [
    {
      titleId: '11111111-1111-4111-8111-111111111111',
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      itemType: 'series',
      externalId: 'episode-list',
      parentExternalId: 'series-9',
    },
    {
      titleId: '11111111-1111-4111-8111-111111111111',
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      itemType: 'series',
      externalId: 'episode-next',
      parentExternalId: 'series-9',
    },
  ]);
});

test('Watch combines independently proven audio and subtitle maps and completes series coordinates', async () => {
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

  let payload;
  context.window.API = {
    isCloudMode: () => true,
    media: {
      reportObservedLanguages: async (value) => {
        payload = value;
        return { ok: true, updated: true, exact: true };
      },
    },
  };
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    contentType: 'series',
    content: {
      cloudSourceId: '22222222-2222-4222-8222-222222222222',
      externalId: 'episode-4',
      series_id: 'series-9',
      type: 'series',
    },
    _relayAudioTracks: [{ index: 1, lang: 'fr' }],
  });
  page.captureExactSubtitleTrackMap([
    { index: 3, language: 'en', codec: 'subrip', extractable: true },
  ], { subtitleTracksScope: 'file' });

  page.reportObservedAudioLanguages();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(payload.parentExternalId, 'series-9');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.audioTracks)), [{ index: 1, lang: 'fr' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.subtitleTracks)), [{
    index: 3,
    lang: 'en',
    codec: 'subrip',
    subtitleType: null,
    extractable: true,
    forced: false,
    default: false,
  }]);
});

test('Watch resets exact observation state when playback identity changes', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const context = { window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(watch, context, { filename: 'public/js/pages/WatchPage.js' });
  const page = Object.create(context.window.WatchPage.prototype);
  Object.assign(page, {
    _observedExactSubtitleTracks: [],
    _observedSubtitleProbeComplete: true,
    _observedLangsSent: 'old',
    _observedLangsPending: 'old',
    _observedLangsRetryKey: 'old',
    _observedLangsRetryCount: 4,
    _observedLangsRetryAt: 123,
    _observedLangsGeneration: 8,
  });

  page.resetObservedTrackPersistenceState();

  assert.equal(page._observedLangsGeneration, 9);
  assert.equal(page._observedExactSubtitleTracks, null);
  assert.equal(page._observedSubtitleProbeComplete, false);
  assert.equal(page._observedLangsSent, null);
  assert.equal(page._observedLangsPending, null);
  assert.equal(page._observedLangsRetryKey, null);
  assert.equal(page._observedLangsRetryCount, 0);
  assert.equal(page._observedLangsRetryAt, 0);
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

test('catalog preserves subtitle default and rejects non-member series episodes before merge', async () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const normalizeSource = between(
    catalog,
    'function normalizeObservedSubtitleTracks(',
    '\nfunction exactTenantEpisodeCoordinatesMatch(',
  )
    .replace(
      'function normalizeObservedSubtitleTracks(value: unknown): JsonRecord[]',
      'function normalizeObservedSubtitleTracks(value)',
    )
    .replace('value: unknown', 'value')
    .replace(/\(value as unknown\[\]\)/g, 'value');
  const matcherSource = between(
    catalog,
    'function exactTenantEpisodeCoordinatesMatch(',
    '\nasync function mergeObservedExactFileLanguages(',
  )
    .replace('value: unknown', 'value')
    .replace(
      /,\n  expected: \{[\s\S]*?\n  \},\n\): boolean \{/,
      ', expected\n) {',
    );
  const mergeSource = between(
    catalog,
    'async function mergeObservedExactFileLanguages(',
    '\n// Capture audio/subtitle languages observed by a client',
  ).replace(
    /async function mergeObservedExactFileLanguages\([\s\S]*?\n\): Promise<"merged" \| "episode-not-owned"> \{/,
    'async function mergeObservedExactFileLanguages(db, values) {',
  );
  const helpers = vm.runInNewContext(
    `(() => {
      const recordOrEmpty = (value) => value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
      const stringOrNull = (value) => value == null || value === '' ? null : String(value);
      const canonicalFileLanguage = (value) => stringOrNull(value)?.toLowerCase() || null;
      const throwDb = (error) => { throw error; };
      ${normalizeSource}
      ${matcherSource}
      ${mergeSource}
      return {
        normalizeObservedSubtitleTracks,
        exactTenantEpisodeCoordinatesMatch,
        mergeObservedExactFileLanguages,
      };
    })()`,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.normalizeObservedSubtitleTracks([
      { index: 3, language: 'FR', codecName: 'subrip', default: true, forced: false },
      { index: 4, lang: 'en', codec: 'ass', default: false, forced: true },
    ]))),
    [
      {
        index: 3, lang: 'fr', codec: 'subrip', subtitleType: null,
        extractable: false, forced: false, default: true,
      },
      {
        index: 4, lang: 'en', codec: 'ass', subtitleType: null,
        extractable: false, forced: true, default: false,
      },
    ],
  );

  const expected = {
    userId: 'user-1', sourceId: 'source-1', titleId: 'title-1',
    variantId: 'variant-1', parentSeriesId: 'series-1', episodeId: 'episode-1',
  };
  const row = {
    user_id: 'user-1', source_id: 'source-1', title_id: 'title-1',
    variant_id: 'variant-1', parent_series_id: 'series-1', episode_id: 'episode-1',
  };
  assert.equal(helpers.exactTenantEpisodeCoordinatesMatch([row], expected), true);
  assert.equal(helpers.exactTenantEpisodeCoordinatesMatch([
    { ...row, user_id: 'other-user' },
  ], expected), false);
  assert.equal(helpers.exactTenantEpisodeCoordinatesMatch([
    { ...row, episode_id: 'forged-episode' },
  ], expected), false);

  const mergeValues = {
    ...expected,
    itemType: 'series',
    fileExternalId: expected.episodeId,
    audioTracks: [{ index: 1, lang: 'fr' }],
    subtitleTracks: [{ index: 2, lang: 'en', default: true }],
    hasAudio: true,
    hasSubtitle: true,
  };
  delete mergeValues.episodeId;
  const invokeMerge = async ({ coordinates = [row], coordinateError = null } = {}) => {
    const calls = [];
    const db = {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === 'catalog_series_episode_coordinates') {
          return { data: coordinates, error: coordinateError };
        }
        if (name === 'merge_cloud_title_file_languages') {
          return { data: null, error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const result = await helpers.mergeObservedExactFileLanguages(db, mergeValues);
    return { result, calls };
  };

  const accepted = await invokeMerge();
  assert.equal(accepted.result, 'merged');
  assert.deepEqual(accepted.calls.map((call) => call.name), [
    'catalog_series_episode_coordinates',
    'merge_cloud_title_file_languages',
  ]);
  for (const forged of [
    { ...row, user_id: 'other-user' },
    { ...row, source_id: 'other-source' },
    { ...row, title_id: 'other-title' },
    { ...row, variant_id: 'other-variant' },
    { ...row, parent_series_id: 'other-series' },
    { ...row, episode_id: 'other-episode' },
  ]) {
    const rejected = await invokeMerge({ coordinates: [forged] });
    assert.equal(rejected.result, 'episode-not-owned');
    assert.deepEqual(rejected.calls.map((call) => call.name), [
      'catalog_series_episode_coordinates',
    ], 'a forged episode tuple must never reach the merge RPC');
  }
  const errorCalls = [];
  await assert.rejects(
    helpers.mergeObservedExactFileLanguages({
      async rpc(name) {
        errorCalls.push(name);
        return { data: null, error: new Error('membership unavailable') };
      },
    }, mergeValues),
    /membership unavailable/,
  );
  assert.deepEqual(errorCalls, ['catalog_series_episode_coordinates']);

  const record = between(
    catalog,
    'async function recordObservedLanguages(',
    '\nasync function listTitleRail(',
  );
  const membershipCheck = mergeSource.indexOf('"catalog_series_episode_coordinates"');
  const merge = mergeSource.indexOf('db.rpc("merge_cloud_title_file_languages"');
  assert.ok(membershipCheck >= 0 && membershipCheck < merge,
    'tenant episode membership must be proven before the series merge');
  assert.ok(record.includes('mergeObservedExactFileLanguages(db'));
  assert.ok(record.includes('reason: "episode_not_owned"'));
});

test('catalog exact-language writes and facet reads fail closed without caching false empties', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const facets = between(
    catalog,
    'async function listLanguageFacets(',
    '\n// Capture audio/subtitle languages observed by a client',
  );
  const record = between(
    catalog,
    'async function recordObservedLanguages(',
    '\nasync function listTitleRail(',
  );

  assert.ok(facets.includes('if (error) throwDb(error, "Unable to load exact language facets")'));
  assert.ok(!facets.includes('cloud_language_facets'));
  assert.ok(!facets.includes('leave the menus empty'));
  assert.ok(
    facets.indexOf('if (error) throwDb(error, "Unable to load exact language facets")') <
      facets.lastIndexOf('FACET_CACHE.set(cacheKey'),
    'an RPC failure must throw before a new cache entry can be written',
  );
  assert.ok(facets.includes('const value: { audio: unknown[]; subtitles: unknown[] }'));

  assert.ok(catalog.includes('if (error) throwDb(error, "Unable to merge exact file languages")'));
  assert.ok(record.includes('unionMerged = true'));
  assert.ok(!record.includes('unionMerged = !error'));
  assert.ok(!record.includes('rolling deploy: legacy single-movie update below remains safe'));
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
  assert.ok(enrichment.includes('subtitleProbeComplete: true'));
  assert.ok(enrichment.includes("subtitleTracksScope: 'file'"));
  assert.ok(enrichment.includes('this.captureExactSubtitleTrackMap(tracks, exactSubtitleEvidence)'));
  assert.ok(
    enrichment.indexOf('this.captureExactSubtitleTrackMap(tracks, exactSubtitleEvidence)') <
      enrichment.indexOf('if (!tracks.length) return;'),
    'a complete empty subtitle probe must be persisted before the UI early return',
  );
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
  assert.ok(record.includes('audioTracks: orderedTracks'));
  assert.ok(record.includes('hasAudio: hasExactAudioMap'));
  assert.ok(record.includes('hasSubtitle: hasExactSubtitleMap'));
  assert.ok(catalog.includes('p_audio_tracks: values.audioTracks'));
  assert.ok(catalog.includes('p_has_audio: values.hasAudio'));
  assert.ok(catalog.includes('p_has_subtitle: values.hasSubtitle'));
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
