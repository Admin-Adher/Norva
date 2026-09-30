'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogTransportManifest: create, combineCatalogTransportManifests: combine } = require('../services/media-gateway/src/catalog-transport-manifest');

function inventory(type, rows) {
    const manifest = create(type);
    rows.forEach(row => manifest.add(row));
    return manifest.result();
}
const rows = [{ stream_id: 7, name: 'Film « été »', category_id: 3 },
    { stream_id: '8', name: 'Second film', category_id: null }];
const other = [inventory('series', [{ series_id: 7, name: 'Série', category_id: 4 }]), inventory('live', [])];

test('transport identity ignores order and presentation but binds all semantic coordinates', () => {
    const baseline = combine([inventory('movie', rows), ...other]);
    assert.equal(baseline.count, 3);
    // Independently evaluated with PostgreSQL jsonb_build_array, SHA-256,
    // signed bigint lanes, numeric sums and bit_xor (30 September 2026).
    assert.equal(baseline.checksum, '00b72846c91969868930e61ec33a81be1eff58477645b3c3bcbc50b316050606');
    assert.deepEqual(combine([inventory('movie', rows.slice().reverse().map(row => ({ ...row, stream_icon: 'https://new.invalid/art', rating: '9' }))), ...other]), baseline);
    for (const change of [{ stream_id: '9' }, { name: 'Another title' }, { category_id: 5 }]) {
        assert.notEqual(combine([inventory('movie', [{ ...rows[0], ...change }, rows[1]]), ...other]).checksum, baseline.checksum);
    }
});

test('duplicate IDs, missing rows, malformed lanes and incomplete inventories cannot prove identity', () => {
    assert.equal(combine([inventory('movie', [rows[0], rows[0]]), ...other]), null);
    assert.equal(combine([inventory('movie', [{ stream_id: 7 }]), ...other]), null);
    assert.equal(combine(other), null);
    const part = inventory('movie', rows);
    assert.equal(combine([{ ...part, xors: ['9223372036854775808', '0', '0', '0'] }, ...other]), null);
    assert.equal(combine([{ ...part, sums: ['oops', '0', '0', '0'] }, ...other]), null);
    assert.throws(() => create('episode'));
    const bounded = create('movie', 1);
    bounded.add(rows[0]);
    assert.throws(() => bounded.add(rows[1]), /bound/);
});
