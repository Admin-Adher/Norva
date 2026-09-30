'use strict';

const { createHash } = require('node:crypto');

// Same semantic rows and signed lanes as norva_catalog_content_manifest v2.
// No URLs, passwords, artwork, enrichment or local UUIDs enter the digest.
function pgJsonArray(values) {
    return '[' + values.map(value => JSON.stringify(value)).join(', ') + ']';
}

function createCatalogTransportManifest(itemType, maxItems = 1_000_000) {
    if (!['movie', 'series', 'live'].includes(itemType)) throw new Error('Invalid inventory type');
    const sums = [0n, 0n, 0n, 0n];
    const xors = [0n, 0n, 0n, 0n];
    const seen = new Set();
    let eligible = true;
    let count = 0;
    const text = value => value == null ? '' : String(value).normalize('NFC').trim();
    return {
        add(item) {
            if (++count > maxItems) throw new Error('Inventory exceeds manifest bound');
            const scalar = value => value == null || typeof value === 'string'
                || (typeof value === 'number' && Number.isFinite(value));
            if (!item || typeof item !== 'object' || Array.isArray(item)
                || ![item.stream_id ?? item.series_id ?? item.id, item.name ?? item.title, item.category_id].every(scalar)) {
                eligible = false;
                return;
            }
            const id = text(item.stream_id ?? item.series_id ?? item.id);
            const title = text(item.name ?? item.title);
            const parent = text(item.category_id) || null;
            // Duplicate IDs and invalid provider rows take the ordinary import
            // path: guessing which version SQL would retain is not a proof.
            if (!id || !title || id.length > 1200 || title.length > 2000
                || /[\u0000-\u001f\u007f]/u.test(id + title + (parent || '')) || seen.has(id)) {
                eligible = false;
                return;
            }
            seen.add(id);
            const digest = createHash('sha256').update(pgJsonArray(['media', itemType, id, parent, title])).digest();
            for (let lane = 0; lane < 4; lane++) {
                const value = digest.readBigInt64BE(lane * 8);
                sums[lane] += value;
                xors[lane] ^= value;
            }
        },
        result() {
            return { version: 2, itemType, eligible, count,
                sums: sums.map(String), xors: xors.map(String) };
        },
    };
}

function combineCatalogTransportManifests(parts) {
    if (!Array.isArray(parts) || parts.length !== 3
        || new Set(parts.map(part => part?.itemType)).size !== 3) return null;
    const sums = [0n, 0n, 0n, 0n], xors = [0n, 0n, 0n, 0n];
    let count = 0;
    for (const part of parts) {
        if (part?.version !== 2 || part.eligible !== true
            || !['movie', 'series', 'live'].includes(part.itemType)
            || !Number.isSafeInteger(part.count) || part.count < 0 || part.count > 1_000_000
            || !Array.isArray(part.sums) || part.sums.length !== 4
            || !Array.isArray(part.xors) || part.xors.length !== 4) return null;
        count += part.count;
        for (let lane = 0; lane < 4; lane++) {
            if (!/^-?\d{1,26}$/.test(part.sums[lane]) || !/^-?\d{1,20}$/.test(part.xors[lane])) return null;
            const xor = BigInt(part.xors[lane]);
            if (BigInt.asIntN(64, xor) !== xor) return null;
            sums[lane] += BigInt(part.sums[lane]);
            xors[lane] ^= xor;
        }
    }
    const values = ['norva-catalog-content-manifest-v2', count];
    for (let lane = 0; lane < 4; lane++) values.push(String(sums[lane]), String(xors[lane]));
    return { count, checksum: createHash('sha256').update(pgJsonArray(values)).digest('hex') };
}

module.exports = { createCatalogTransportManifest, combineCatalogTransportManifests };
