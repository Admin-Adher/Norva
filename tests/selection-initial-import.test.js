'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const shared = import('../supabase/functions/_shared/selection-initial-import.mjs');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function handoffHarness({ missing = false, writeFails = false, superseded = false, imported = true, starterReady = false } = {}) {
    const events = [], filters = [];
    let written;
    const hint = { unrelated: 'preserved', lastSync: { total: 80 },
        syncProgress: { counts: { total: 7697 }, moviesReady: starterReady,
            steps: { import: { status: imported ? 'done' : 'running' } } } };
    const db = { from(table) {
        assert.equal(table, 'cloud_sources');
        let update = false;
        const query = { select() { return query; },
            update(value) { update = true; written = value; return query; },
            eq(...args) { filters.push(args); return query; }, is(...args) { filters.push(args); return query; },
            async maybeSingle() {
                events.push(update ? 'persist' : 'read');
                return update ? { data: writeFails ? null : { id: 'source' } }
                    : { data: missing ? null : { config_hint: hint } };
            } };
        return query;
    } };
    const options = { db, sourceId: 'source', userId: 'owner', generation: { configRevision: '3', sourceVisibilityEpoch: '5' },
        assertCurrent: async () => { events.push('fence'); if (superseded && written) throw Error('superseded'); },
        releaseTransport: async () => events.push('release'), invokeFinalizer: async () => events.push('invoke') };
    return { options, events, filters, written: () => written };
}

test('Selection persists recovery before releasing transport and starting a fresh finalizer', async () => {
    const { handoffSelectionFinalization } = await shared;
    const h = handoffHarness();
    await handoffSelectionFinalization(h.options);
    assert.deepEqual(h.events, ['fence', 'read', 'fence', 'persist', 'fence', 'release', 'invoke']);
    assert.deepEqual(h.written().config_hint.finalizeCursor, { phase: 'titles', offset: 0, afterId: '' });
    assert.equal(h.written().config_hint.unrelated, 'preserved');
    assert.equal(h.written().config_hint.lastSync.total, 80, 'a prior ready catalogue remains available during refresh');
    assert.equal(h.written().sync_status, 'syncing');
    assert.equal(h.written().config_hint.syncProgress.browseReady, false);
    for (const filter of [['user_id', 'owner'], ['enabled', true], ['deleted_at', null], ['config_revision', '3'], ['visibility_epoch', '5']]) {
        assert.ok(h.filters.some(value => JSON.stringify(value) === JSON.stringify(filter)));
    }
});

for (const option of ['missing', 'writeFails', 'superseded']) {
    test(`Selection ${option} cannot release or schedule a stale handoff`, async () => {
        const { handoffSelectionFinalization } = await shared;
        const h = handoffHarness({ [option]: true });
        await assert.rejects(handoffSelectionFinalization(h.options));
        assert.ok(!h.events.includes('release') && !h.events.includes('invoke'));
    });
}

test('an incomplete raw import cannot be promoted to finalization', async () => {
    const { handoffSelectionFinalization } = await shared;
    const h = handoffHarness({ imported: false });
    await assert.rejects(handoffSelectionFinalization(h.options), /raw import is not complete/);
    assert.equal(h.written(), undefined);
});

test('durable handoff preserves the actual starter page without claiming complete import', async () => {
    const { handoffSelectionFinalization } = await shared;
    const h = handoffHarness({ starterReady: true });
    await handoffSelectionFinalization(h.options);
    const progress = h.written().config_hint.syncProgress;
    assert.equal(progress.moviesReady, true);
    assert.equal(progress.browseReady, true);
    assert.equal(progress.seriesReady, false);
    assert.equal(progress.liveReady, false);
    assert.equal(progress.usable, false);
    assert.equal(h.written().sync_status, 'syncing');
});

test('only the first Selection title slice uses the small batch', async () => {
    const { initialTitleBatchLimit } = await shared;
    assert.equal(initialTitleBatchLimit(true, false), 60);
    assert.equal(initialTitleBatchLimit(true, true), 300);
    assert.equal(initialTitleBatchLimit(false, false), 300);
});

test('starter titles are bounded, identifiable, illustrated and deduplicated by type', async () => {
    const { selectionStarterRows } = await shared;
    const row = (item_type, id, poster_url = 'poster') => ({ item_type, poster_url, metadata: { providerTmdbId: id } });
    const input = [row('live', '10'), row('movie', '0'), row('movie', 'bad'), row('movie', '5', ''),
        ...Array.from({ length: 25 }, (_, i) => row('movie', String(i + 1))), row('movie', '1'),
        ...Array.from({ length: 8 }, (_, i) => row('series', String(i + 1)))];
    const result = selectionStarterRows(input);
    assert.equal(result.filter(r => r.item_type === 'movie').length, 12);
    assert.equal(result.filter(r => r.item_type === 'series').length, 4);
    assert.equal(result.filter(r => r.item_type === 'movie' && r.metadata.providerTmdbId === '1').length, 1);
    assert.equal(input.length, 38, 'selection does not remove rows from the complete catalogue');
});

test('the real activation importer hands off Selection before any whole-catalogue projection', async () => {
    const { selectionStarterRows } = await shared;
    const source = read('supabase/functions/norva-cloud/index.ts');
    const fn = source.slice(source.indexOf('async function syncM3uSource('), source.indexOf('\nasync function replaceSourceItems('));
    const projected = [], reports = [], saved = [];
    const selectionUrl = 'https://norva.tv/catalog/discovery.m3u';
    const items = Array.from({ length: 501 }, (_, i) => ({ title: `Film ${i}`, tvgId: `film-${i}`, item_type: 'movie',
        logo: 'poster', metadata: i < 20 ? { providerTmdbId: String(i + 1) } : {} }));
    const context = vm.createContext({
        DISCOVERY_PLAYLIST_URL: selectionUrl, stringOr: (value, fallback) => value || fallback,
        selectionStarterRows,
        compactRecord: value => value, sha256Hex: async () => 'unused',
        assertActiveCatalogGenerationCurrent: async () => {},
        fetchDiscoverySelection: async () => ({ items, sources: ['selection'] }),
        discoveryCatalogFields: (_, item) => ({ item_type: item.item_type, metadata: item.metadata }),
        replaceSourceItems: async (id, owner, rows) => { saved.push(...rows); return rows; },
        refreshMaterializedLiveCatalog: async () => { projected.push('live'); },
        refreshVodTitleProjection: async options => { projected.push(options.rows.length); assert.equal(options.tmdbValidateLimit, 0); },
    });
    vm.runInContext(transformSync(fn + '\nglobalThis.run = syncM3uSource;', { loader: 'ts', target: 'es2022' }).code, context);
    const result = await context.run('source', 'owner', { playlistUrl: selectionUrl }, {}, {}, async p => reports.push(p));
    assert.equal(result.finalizePending, true);
    assert.equal(result.total, 501);
    assert.equal(saved.length, 501, 'the background worker retains the entire catalogue');
    assert.ok(saved.every(row => row.user_id === 'owner' && row.source_id === 'source'));
    assert.deepEqual(projected, [12]);
    assert.equal(reports.at(-2).steps.import.status, 'done');
    assert.equal(reports.at(-1).moviesReady, true);
});

test('activation and durable worker use the same handoff protocol without an early READY', () => {
    const cloud = read('supabase/functions/norva-cloud/index.ts');
    const start = cloud.indexOf('if (recordOrEmpty(result).finalizePending === true)');
    const end = cloud.indexOf('const syncedAt =', start);
    const branch = cloud.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.match(branch, /handoffSelectionFinalization/);
    assert.match(branch, /norva-source-sync\/cron\/finalize/);
    assert.match(branch, /return;/);
    assert.doesNotMatch(branch, /sync_status:\s*"ready"/);
    const worker = read('supabase/functions/norva-source-sync/index.ts');
    assert.match(worker, /isDiscoverySourceId\(sourceId, userId\)/);
    assert.match(worker, /initialTitleBatchLimit\(isSelection, firstSliceReady\)/);
});
