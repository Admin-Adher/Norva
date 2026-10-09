'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
const exact = source.slice(source.indexOf('async function loadExactMovieRecoveryTitles('), source.indexOf('async function listMediaItems('));
const sourceId = '11111111-1111-4111-8111-111111111111';
const foreignSource = '22222222-2222-4222-8222-222222222222';
const url = (type = 'movie') => new URL(`https://example.invalid/media-items?sourceId=${sourceId}&externalId=provider-file&type=${type}&lang=fr`);

function fixture({ matches = [{ title_id: 'current-title' }], title = { id: 'current-title', item_type: 'movie' },
  variants = [{ source_id: sourceId, external_id: 'provider-file' }], error = null,
  recovery = null, recoveryError = null, hydratedTitles = null, variantsByTitle = null } = {}) {
  const filters = {}, reads = [];
  const moduleFixture = { exports: {} };
  const query = { select: () => query, eq: (key, value) => { filters[key] = value; return query; },
    limit: async count => { assert.equal(count, 2); return { data: matches, error }; } };
  vm.runInNewContext(transformSync(exact + '\nexport { listExactCatalogMediaItems };', { loader: 'ts', format: 'cjs' }).code, {
    module: moduleFixture, exports: moduleFixture.exports,
    stringOrNull: value => typeof value === 'string' && value.trim() ? value.trim() : null,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    db: { from: table => { reads.push(table); return query; }, rpc: async (name, args) => {
      assert.equal(name, 'norva_get_owned_movie_recovery_title_ids');
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { p_user_id: 'owner', p_anchor_title_id: title.id,
        p_expected_visibility_epoch: 7, p_limit: 64 });
      reads.push('canonical-recovery');
      return { data: recovery, error: recoveryError };
    } },
    throwDb: err => { throw new Error(err.message); },
    loadTitleById: async (owner, id) => { assert.equal(owner, 'owner'); assert.equal(id, matches[0].title_id); reads.push('hydrate'); return title; },
    HOME_RAIL_VARIANT_LIMIT: 10,
    listVariantsByTitleIds: async (ids, owner, limit, audio, source, requiredFile) => {
      assert.equal(owner, 'owner'); reads.push({ variantTitleIds: Array.from(ids) });
      assert.equal(limit, 10); assert.equal(audio, null); assert.equal(source, null);
      assert.deepEqual(JSON.parse(JSON.stringify(requiredFile)), {
        titleId: matches[0].title_id, sourceId, externalId: 'provider-file',
      });
      return variantsByTitle || new Map([[matches[0].title_id, variants]]);
    },
    catalogTextStatusEligible: value => ['provider_verified', 'matched', 'manual'].includes(value),
    catalogTitleUuid: value => {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value))) throw new Error('catalogue unavailable');
      return value;
    },
    requiredCatalogTitleVisibilityEpoch: owner => { assert.equal(owner, 'owner'); return 7; },
    catalogTitleReadUnavailable: () => new Error('catalogue unavailable'),
    catalogTitleVisibilityEpoch: (received, expected) => {
      if (received !== expected) throw new Error('catalogue unavailable');
    },
    isRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    hydrateVisibleCatalogTitlesByIds: async (owner, ids, epoch) => {
      assert.equal(owner, 'owner'); assert.equal(epoch, 7); reads.push({ hydratedTitleIds: Array.from(ids) });
      return hydratedTitles;
    },
    railLang: value => value.searchParams.get('lang'),
    applyCatalogOverlay: async (titles, type, lang) => { assert.equal(type, title.item_type); assert.equal(lang, 'fr'); titles[0].overview = 'Synopsis actuel'; },
    titleRailItem: (row, files, lang) => ({ ...row, variants: files, lang }),
  });
  return { run: moduleFixture.exports.listExactCatalogMediaItems, filters, reads };
}

test('exact fiche lookup is owner/source/file scoped and hydrates the current localized title', async () => {
  const f = fixture();
  const result = await f.run(url(), 'owner');
  assert.deepEqual(f.filters, { user_id: 'owner', source_id: sourceId, item_type: 'movie', external_id: 'provider-file' });
  assert.equal(f.reads[0], 'cloud_catalog_visible_title_variants');
  assert.equal(result.items[0].overview, 'Synopsis actuel');
  assert.equal(result.count, 1);
  assert.equal(result.hasMore, false);
  const { sanitizeCatalogMediaPayload } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  const publicResponse = sanitizeCatalogMediaPayload(result);
  assert.equal(publicResponse.items.length, 1, 'the production response filter must retain exact fiche items');
  assert.equal(publicResponse.items[0].overview, 'Synopsis actuel');
});
test('series lookup uses the parent series identity and the same localized projection', async () => {
  const f = fixture({ title: { id: 'current-title', item_type: 'series' } });
  assert.equal((await f.run(url('series'), 'owner')).items[0].item_type, 'series');
});
test('missing or ambiguous file identity never guesses a homonym', async () => {
  for (const matches of [[], [{ title_id: 'a' }, { title_id: 'b' }]]) {
    const f = fixture({ matches });
    assert.equal((await f.run(url(), 'owner')).items.length, 0);
    assert.equal(f.reads.includes('hydrate'), false);
  }
});
test('visibility changes and cross-source provider-ID collisions fail closed', async () => {
  for (const values of [{ title: null }, { title: { item_type: 'series' } },
    { variants: [{ source_id: foreignSource, external_id: 'provider-file' }] }]) {
    const f = fixture(values);
    assert.equal((await f.run(url(), 'owner')).items.length, 0);
  }
});
test('invalid or incomplete identity is rejected before database access', async () => {
  const f = fixture();
  for (const query of ['externalId=1&type=movie', `sourceId=${sourceId}&externalId=1&type=live`,
    `sourceId=${sourceId}&externalId=${'x'.repeat(257)}&type=movie`]) {
    await assert.rejects(f.run(new URL('https://example.invalid/media-items?' + query), 'owner'), err => err.status === 400);
  }
  assert.equal(f.reads.length, 0);
});
test('database failures remain failures, without fabricated title data', async () => {
  await assert.rejects(fixture({ error: { message: 'unavailable' } }).run(url(), 'owner'), /unavailable/);
});

const anchorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siblingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const canonicalTitle = (id = anchorId) => ({ id, user_id: 'owner', item_type: 'movie',
  provider_tmdb_id: '1060046', match_status: 'provider_verified', release_year: 2025 });
const recoveryReceipt = (extra = {}) => ({ contract: 'owned-movie-recovery-v1', visibilityEpoch: 7,
  anchorTitleId: anchorId, titleIds: [anchorId, siblingId], ...extra });
const canonicalFixture = (extra = {}) => fixture({ matches: [{ title_id: anchorId }],
  title: canonicalTitle(), recovery: recoveryReceipt(), hydratedTitles: [canonicalTitle(), canonicalTitle(siblingId)],
  variantsByTitle: new Map([
    [anchorId, [{ source_id: sourceId, external_id: 'provider-file', audio_languages: ['es'] }]],
    [siblingId, [{ source_id: foreignSource, external_id: 'other-file', audio_languages: ['en'] }]],
  ]), ...extra });

test('an exact movie file can return distinct owned title groups with one proven canonical identity', async () => {
  const f = canonicalFixture();
  const result = await f.run(url(), 'owner');
  assert.equal(result.items.length, 2);
  assert.equal(result.count, 2);
  assert.equal(result.films, 1, 'internal title groups must not inflate the number of films');
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.items.map(item => item.id), [anchorId, siblingId]);
  assert.equal(result.items[0].variants[0].external_id, 'provider-file');
  assert.equal(result.items[1].variants[0].external_id, 'other-file');
  assert.deepEqual(result.items[0].variants[0].audio_languages, ['es']);
  assert.deepEqual(result.items[1].variants[0].audio_languages, ['en']);
  assert.deepEqual(f.reads.find(read => read.variantTitleIds)?.variantTitleIds, [anchorId, siblingId]);
  const { sanitizeCatalogMediaPayload } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  assert.equal(sanitizeCatalogMediaPayload(result).items.length, 2);
});

test('unverified IDs and title-only homonyms never request canonical alternatives', async () => {
  for (const patch of [{ provider_tmdb_id: null }, { provider_tmdb_id: '0' },
    { provider_tmdb_id: 'tt1060046' }, { match_status: 'provider_unverified' }, { match_status: 'unmatched' }]) {
    const f = canonicalFixture({ title: { ...canonicalTitle(), ...patch } });
    assert.equal((await f.run(url(), 'owner')).items.length, 1);
    assert.equal(f.reads.includes('canonical-recovery'), false);
  }
});

test('canonical lookup failure or incomplete contract cannot claim no alternatives', async () => {
  for (const recovery of [null, recoveryReceipt({ contract: 'other' }), recoveryReceipt({ visibilityEpoch: 8 }),
    recoveryReceipt({ anchorTitleId: siblingId }), recoveryReceipt({ titleIds: [] }),
    recoveryReceipt({ titleIds: [siblingId, anchorId] }), recoveryReceipt({ titleIds: [anchorId, anchorId] }),
    recoveryReceipt({ titleIds: [anchorId, 'not-a-title-id'] }),
    recoveryReceipt({ titleIds: Array(65).fill(anchorId) })]) {
    await assert.rejects(canonicalFixture({ recovery }).run(url(), 'owner'), /catalogue unavailable/);
  }
  await assert.rejects(canonicalFixture({ recoveryError: { code: '57014' } }).run(url(), 'owner'), /catalogue unavailable/);
});

test('changed owner, generation visibility, media type or canonical identity fails closed after hydration', async () => {
  for (const hydratedTitles of [[canonicalTitle()],
    [canonicalTitle(), { ...canonicalTitle(siblingId), user_id: 'other-owner' }],
    [canonicalTitle(), { ...canonicalTitle(siblingId), item_type: 'series' }],
    [canonicalTitle(), { ...canonicalTitle(siblingId), provider_tmdb_id: '999' }],
    [canonicalTitle(), { ...canonicalTitle(siblingId), match_status: 'unmatched' }],
    [canonicalTitle(siblingId), canonicalTitle()]]) {
    await assert.rejects(canonicalFixture({ hydratedTitles }).run(url(), 'owner'), /catalogue unavailable/);
  }
});

test('canonical alternatives do not substitute a missing original selected file', async () => {
  const f = canonicalFixture({ variantsByTitle: new Map([
    [anchorId, [{ source_id: foreignSource, external_id: 'provider-file' }]],
    [siblingId, [{ source_id: foreignSource, external_id: 'other-file' }]],
  ]) });
  assert.equal((await f.run(url(), 'owner')).items.length, 0);
});

test('cloud adapter preserves localized editorial data and exact-file language scope for every owned version', async () => {
  const requests = [], storage = new Map([['norva-cloud-session', JSON.stringify({ access_token: 'fixture', user: { id: 'owner' } })]]);
  const NorvaCloud = { contentLanguage: () => 'fr', mediaItems: { list: async params => {
    requests.push(params);
    return { items: [{ id: 'current-title', item_type: 'movie', title: 'Titre traduit',
      poster_url: 'https://example.invalid/current.jpg', year: 2022,
      metadata: { tmdb: { title: 'English title', overview: 'English synopsis' } },
      data: { title: 'English title', overview: 'Synopsis actuel', genres: ['Drama'] },
      variants: [sourceId, foreignSource].map((id, index) => ({ id: 'variant-' + index, source_id: id,
        raw_title: 'PT | Provider title',
        external_id: params.externalId, container_extension: 'mkv', audio_languages: [index ? 'fr' : 'en'],
        audio_languages_scope: 'file', audio_language_validation_status: 'verified' }))
    }], count: 1, films: 1, limit: 1, offset: 0, hasMore: false };
  } } };
  const context = vm.createContext({ window: { NorvaCloud, location: { hostname: 'norva.tv', origin: 'https://norva.tv' } },
    NorvaCloud, URL, URLSearchParams, AbortController, Headers, navigator: { userAgent: 'fixture' },
    console, setTimeout, clearTimeout, localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8') + '\nthis.adapter = CloudAdapter;', context);
  for (const fileId of ['file-a', 'file-b']) {
    const page = await context.adapter.request('GET', `/media/page?sourceId=${sourceId}&type=movie&externalId=${fileId}&limit=1`);
    assert.equal(page.items.length, 2);
    for (const item of page.items) {
      assert.equal(item.stream_id, fileId);
      assert.equal(item.title, 'Titre traduit');
      assert.equal(item.data.title, 'Titre traduit');
      assert.equal(item.name, 'PT | Provider title');
      assert.equal(item.raw_title, 'PT | Provider title', 'provider tags remain available for version language evidence');
      assert.equal(item.data.overview, 'Synopsis actuel');
      assert.equal(item.poster_url, 'https://example.invalid/current.jpg');
      assert.equal(item.year, 2022);
      assert.equal(item.container_extension, 'mkv');
      assert.equal(item.audioLanguagesScope, 'file');
    }
    assert.deepEqual(Array.from(page.items[0].audioLanguages), ['en']);
    assert.deepEqual(Array.from(page.items[1].audioLanguages), ['fr']);
    assert.notEqual(page.items[0].sourceId, page.items[1].sourceId);
  }
  assert.equal(requests.length, 2, 'exact file identities must have separate cache keys');
  assert.deepEqual(requests.map(request => request.externalId), ['file-a', 'file-b']);
});

test('real cloud normalization and movie grouping reopen all canonical projections without playing or changing the selected file', async () => {
  const requests = [], displayed = [];
  const storage = new Map([['norva-cloud-session', JSON.stringify({ access_token: 'fixture', user: { id: 'owner' } })]]);
  const NorvaCloud = { contentLanguage: () => 'fr', sources: { list: async () => ({
    sources: [sourceId, foreignSource].map(id => ({ id, enabled: true, source_type: 'xtream' })),
  }) }, mediaItems: { list: async params => {
    requests.push(params);
    assert.ok(params.q == null || params.q === '', 'no provider title search is permitted');
    return { items: [anchorId, siblingId].map((id, index) => ({ id, title_id: id, item_type: 'movie',
      provider_tmdb_id: '1060046', match_status: 'provider_verified', title: 'Un film', year: index ? null : 2025,
      variants: [{ id: `variant-${index}`, source_id: index ? foreignSource : sourceId,
        external_id: index ? 'other-file' : params.externalId, raw_title: index ? 'FR | Raw alternate' : 'EN | Raw selected',
        container_extension: index ? 'mp4' : 'mkv', audio_languages: [index ? 'fr' : 'en'],
        audio_languages_scope: 'file', audio_language_validation_status: 'verified' }],
    })), count: 2, films: 1, limit: 1, offset: 0, hasMore: false };
  } } };
  const context = vm.createContext({ window: { NorvaCloud, location: { hostname: 'norva.tv', origin: 'https://norva.tv' } },
    NorvaCloud, URL, URLSearchParams, AbortController, Headers, navigator: { userAgent: 'fixture' }, console,
    document: { addEventListener() {} }, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext('(function () {\n' + fs.readFileSync('public/js/api.js', 'utf8') + '\nthis.adapter = CloudAdapter;\n}).call(this);', context);
  vm.runInContext(fs.readFileSync('public/js/utils/mediaUtils.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('public/js/pages/MoviesPage.js', 'utf8'), context);
  let lookupFailure = null;
  let normalizedPage = null;
  context.API = { media: { page: async params => {
    try { normalizedPage = await context.adapter.request('GET', '/media/page?' + new URLSearchParams(params)); return normalizedPage; }
    catch (error) { lookupFailure = error; throw error; }
  } },
    proxy: { xtream: { getStreamUrl: () => assert.fail('looking up versions must not start playback') } } };
  const movies = Object.create(context.window.MoviesPage.prototype);
  movies.openGroup = (group, options) => { displayed.push({ group, options }); return true; };
  const selectedLocalSource = context.adapter.localSourceId(sourceId);
  const alternateLocalSource = context.adapter.localSourceId(foreignSource);
  const opened = await movies.openByItem({ sourceId: selectedLocalSource, stream_id: 'selected-file' }, { requireOwned: true, focusVersions: true });
  assert.equal(lookupFailure, null);
  assert.equal(normalizedPage?.items?.[0]?.stream_id, 'selected-file');
  assert.equal(normalizedPage?.items?.[0]?.sourceId, selectedLocalSource);
  assert.equal(context.window.MediaUtils.groupItems(normalizedPage.items).length, 1);
  assert.equal(opened, true);
  assert.equal(requests.length, 1);
  assert.equal(displayed.length, 1);
  const { group, options } = displayed[0];
  assert.equal(group.items.length, 2, 'same canonical identity groups distinct internal titles even if one has no year');
  assert.equal(options.selectedMovie.stream_id, 'selected-file');
  assert.equal(options.selectedMovie.sourceId, selectedLocalSource);
  assert.equal(options.focusVersions, true);
  const alternate = group.items.find(item => item.sourceId === alternateLocalSource);
  assert.equal(alternate.stream_id, 'other-file');
  assert.equal(alternate.container_extension, 'mp4');
  assert.deepEqual(Array.from(alternate.audioLanguages), ['fr']);
  assert.deepEqual(Array.from(options.selectedMovie.audioLanguages), ['en']);
});
