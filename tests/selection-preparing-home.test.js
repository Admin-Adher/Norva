'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function harness({ sourceCount = 1, status = 'syncing', previousSync = false, selection = true, error = false } = {}) {
    const calls = [];
    const code = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
    const start = code.indexOf('async function listPreparingSelectionHomeRails(');
    const end = code.indexOf('// Netflix-style genre rails:', start);
    const db = { from(table) {
        const call = { table, filters: [] }; calls.push(call);
        const query = {
            select(value) { call.select = value; return query; },
            eq(...args) { call.filters.push(args); return query; },
            order() { return query; }, limit(value) { call.limit = value; return query; },
            then(resolve, reject) {
                const data = table === 'cloud_catalog_visible_sources'
                    ? Array.from({ length: sourceCount }, (_, i) => ({ id: `source-${i}`, sync_status: status,
                        config_hint: previousSync ? { lastSync: { syncedAt: '2026-09-01' } } : {} }))
                    : [{ title_id: 'current' }, { title_id: 'current' }, { title_id: 'second' }];
                return Promise.resolve({ data, error: error ? { code: 'unavailable' } : null }).then(resolve, reject);
            }
        }; return query;
    } };
    const context = vm.createContext({ db, DISCOVERY_SELECTION_ENABLED: true,
        isDiscoverySourceId: async (id, owner) => selection && id === 'source-0' && owner === 'owner',
        catalogTitleReadUnavailable: () => Error('unavailable'), requiredCatalogTitleVisibilityEpoch: () => '7',
        catalogTitleUuid: value => value,
        hydrateVisibleCatalogTitlesByIds: async (owner, ids, epoch) => {
            assert.equal(owner, 'owner'); assert.equal(epoch, '7');
            assert.deepEqual(Array.from(ids), ['current', 'second']);
            return ids.map(id => ({ id, backdrop_url: 'existing-backdrop' }));
        },
        listVariantsByTitleIds: async () => new Map(),
        applyCatalogOverlay: async (titles, itemType, lang) => {
            assert.equal(lang, 'fr'); assert.ok(['movie', 'series'].includes(itemType));
        },
        titleRailItem: row => row,
    });
    vm.runInContext(transformSync(code.slice(start, end) + '\nglobalThis.run = listPreparingSelectionHomeRails;', { loader: 'ts' }).code, context);
    return { run: (...args) => context.run(...args), calls };
}

test('initial Selection Home reads only current visible variants, preserves backdrops and deduplicates titles', async () => {
    const h = harness();
    const result = await h.run('owner', null, 12, 'fr');
    assert.equal(result.preparing, true);
    assert.equal(result.rails.length, 2);
    assert.ok(result.rails.every(rail => rail.items.length === 2 && rail.items[0].backdrop_url));
    for (const call of h.calls) {
        assert.ok(call.filters.some(([key, value]) => key === 'user_id' && value === 'owner'));
        if (call.table.endsWith('title_variants')) {
            assert.equal(call.limit, 24);
            assert.ok(call.filters.some(([key, value]) => key === 'source_id' && value === 'source-0'));
        }
    }
    assert.ok(h.calls.every(call => call.table.startsWith('cloud_catalog_visible_')));
});

for (const options of [{ sourceCount: 2 }, { sourceCount: 0 }, { status: 'ready' }, { previousSync: true }, { selection: false }]) {
    test(`normal recommendation ranking stays in place for ${JSON.stringify(options)}`, async () => {
        const h = harness(options);
        assert.equal(await h.run('owner', 'movie', 12, 'fr'), null);
        assert.equal(h.calls.length, 1);
    });
}

test('a source visibility read failure cannot turn into an empty successful Home', async () => {
    await assert.rejects(harness({ error: true }).run('owner', null, 12, 'fr'), /unavailable/);
});
