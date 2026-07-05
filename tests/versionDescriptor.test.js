'use strict';

// Version-button label builder for the Movie/Series fiches (MediaUtils.versionDescriptor).
// A title's "versions" are usually the SAME film re-imported across a provider's regional
// catalogue sections and across providers, so the label is a compact, everything-visible
// line "Provider · Quality · Container · Market", falling back to the raw provider
// category when that collides. mediaUtils.js is a browser IIFE; load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

const names = { s1: 'AtlasPro', s2: 'KING365', s3: 'FlixHD' };
const resolve = (id) => names[id] || '';

test('compact line = Provider · Quality · Container · Market, present fields only', () => {
    const it = { raw_title: 'EN - One Last Adventure 4K (2026)', container_extension: 'mkv', sourceId: 's1' };
    const d = M.versionDescriptor(it, { siblings: [it], index: 0, resolveSourceName: resolve });
    assert.deepStrictEqual(d.segments, ['AtlasPro', '4K', 'MKV', 'EN']);
});

test('market token read from the prefix incl. the "▎" bar; "PREFIX"/title words rejected', () => {
    const ar = M.versionDescriptor({ raw_title: 'AR ▎ The Return', container_extension: 'mkv', sourceId: 's2' },
        { resolveSourceName: resolve });
    assert.ok(ar.segments.includes('AR'), `expected AR market, got ${JSON.stringify(ar.segments)}`);

    // "PREFIX" is >4 chars with no valid following separator match -> no bogus market token.
    const junk = M.versionDescriptor({ raw_title: 'PREFIX - Oscar Shaw', container_extension: 'mkv', sourceId: 's1' },
        { resolveSourceName: resolve });
    assert.ok(!junk.segments.includes('PREFIX'), `PREFIX leaked: ${JSON.stringify(junk.segments)}`);

    // A clean title (no prefix) yields no market token.
    const clean = M.versionDescriptor({ raw_title: 'One Last Adventure 2026', container_extension: 'mp4', sourceId: 's3' },
        { resolveSourceName: resolve });
    assert.deepStrictEqual(clean.segments, ['FlixHD', 'MP4']);
});

test('container varies -> visible on every button (no smart-hide)', () => {
    const a = { raw_title: 'EN - X', container_extension: 'mkv', sourceId: 's1' };
    const b = { raw_title: 'EN - X', container_extension: 'mp4', sourceId: 's1' };
    const da = M.versionDescriptor(a, { siblings: [a, b], index: 0, resolveSourceName: resolve });
    assert.ok(da.segments.includes('MKV'), `container should always show, got ${JSON.stringify(da.segments)}`);
});

test('when the line would collide, the raw provider category disambiguates', () => {
    // Same provider, same container, same market -> identical line -> append category.
    const a = { raw_title: 'EN - X', container_extension: 'mkv', sourceId: 's1', category_name: '|EN| DOCUMENTARY' };
    const b = { raw_title: 'EN - X', container_extension: 'mkv', sourceId: 's1', category_name: 'EN ▎CINEMA MOVIES' };
    const da = M.versionDescriptor(a, { siblings: [a, b], index: 0, resolveSourceName: resolve });
    const db = M.versionDescriptor(b, { siblings: [a, b], index: 1, resolveSourceName: resolve });
    assert.ok(da.segments.includes('EN DOCUMENTARY'), `A needs category, got ${JSON.stringify(da.segments)}`);
    assert.ok(db.segments.includes('EN ▎CINEMA MOVIES'), `B needs category, got ${JSON.stringify(db.segments)}`);
    assert.notDeepStrictEqual(da.segments, db.segments); // the two buttons are now distinct
});

test('distinct providers/markets do NOT trigger the category fallback', () => {
    const a = { raw_title: 'EN - X', container_extension: 'mkv', sourceId: 's1', category_name: '|EN| DOCUMENTARY' };
    const b = { raw_title: 'TR ▎ X', container_extension: 'mkv', sourceId: 's2', category_name: 'TR ▎NETFLIX' };
    const da = M.versionDescriptor(a, { siblings: [a, b], index: 0, resolveSourceName: resolve });
    assert.deepStrictEqual(da.segments, ['AtlasPro', 'MKV', 'EN']); // no category appended
});

test('nothing distinctive at all -> a numeric tag so buttons are never identical', () => {
    const a = { raw_title: 'X', container_extension: '', sourceId: null };
    const d = M.versionDescriptor(a, { siblings: [a, { ...a }], index: 2, resolveSourceName: resolve });
    assert.deepStrictEqual(d.segments, ['Version 3']);
});

test('fluidity tier still maps (rendered as a leading colour dot)', () => {
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'direct' }).tier.key, 'direct');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'video_transcode' }).tier.cls, 'tier-transcode');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'unknown' }).tier, null);
});
