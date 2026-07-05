'use strict';

// Version-button label builder for the Movie/Series fiches (MediaUtils.versionDescriptor).
// A title's "versions" are usually the SAME film re-imported across a provider's regional
// catalogue sections and across providers. The label is two-tier — { headline, meta,
// badge, tier } — leading with whatever DIFFERS (market by default, provider when the
// market is constant), the constants demoted to the muted meta line. mediaUtils.js is a
// browser IIFE; load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

const names = { s1: 'Strng IPTV 8K', s2: 'AtlasPro', s3: 'KING365' };
const resolve = (id) => names[id] || '';
const mk = (raw, extra) => Object.assign({ raw_title: raw, container_extension: 'mkv', sourceId: 's1' }, extra || {});
const desc = (item, siblings) => M.versionDescriptor(item, { siblings: siblings || [item], resolveSourceName: resolve });

test('headline = humanised MARKET; provider·container demoted to meta', () => {
    const d = desc(mk('GR - One Last Adventure'));
    assert.strictEqual(d.headline, 'Greek');
    assert.strictEqual(d.meta, 'Strng IPTV 8K · MKV');
});

test('ISO tokens resolve via the language map incl. the "▎" bar separator', () => {
    assert.strictEqual(desc(mk('ES ▎ X')).headline, 'Spanish');
    assert.strictEqual(desc(mk('AR ▎ X')).headline, 'Arabic');
    assert.strictEqual(desc(mk('FR - X')).headline, 'French');
});

test('non-ISO IPTV tokens get a human label (Nordic / Netflix / Multi / Latino)', () => {
    assert.strictEqual(desc(mk('SCAN ▎ X')).headline, 'Nordic');
    assert.strictEqual(desc(mk('NF - X')).headline, 'Netflix');
    assert.strictEqual(desc(mk('LAT - X')).headline, 'Latino');
    // No leading token, but the category names the platform.
    assert.strictEqual(desc(mk('One Last Adventure - 2026', { category_name: 'Multi-Sub★ TOP NEW' })).headline, 'Multi');
});

test('subtitle-only markets carry a "· ST" nuance', () => {
    assert.strictEqual(desc(mk('AR-SUBS - Something')).headline, 'Arabic · ST');
});

test('quality rides as a badge (4K flagged), never duplicated in the headline', () => {
    const d = desc(mk('EN - One Last Adventure 4K (2026)'));
    assert.strictEqual(d.headline, 'English');
    assert.strictEqual(d.badge, '4K');
    assert.ok(!/4K/i.test(d.meta), 'quality should not repeat in meta');
});

test('garbage / noise prefixes never become the headline', () => {
    // "PREFIX" and "TOP" are not markets -> fall through to the provider lead, no market shown.
    for (const raw of ['PREFIX - Oscar Shaw', 'TOP - Some Title']) {
        const d = desc(mk(raw));
        assert.strictEqual(d.headline, 'Strng IPTV 8K');
        assert.ok(!/PREFIX|TOP/i.test(d.headline + d.meta), `noise leaked for "${raw}"`);
    }
});

test('ADAPTIVE: market constant but provider varies -> provider leads', () => {
    const set = [mk('EN - X', { sourceId: 's1' }), mk('EN - X', { sourceId: 's2' }), mk('EN - X', { sourceId: 's3' })];
    const d0 = M.versionDescriptor(set[0], { siblings: set, resolveSourceName: resolve });
    const d1 = M.versionDescriptor(set[1], { siblings: set, resolveSourceName: resolve });
    assert.strictEqual(d0.headline, 'Strng IPTV 8K');       // provider leads
    assert.strictEqual(d1.headline, 'AtlasPro');
    assert.ok(d0.meta.includes('English'), 'the constant market demotes to meta');
});

test('market varies -> market leads even across multiple providers', () => {
    const set = [mk('EN - X', { sourceId: 's1' }), mk('FR - X', { sourceId: 's2' })];
    const d0 = M.versionDescriptor(set[0], { siblings: set, resolveSourceName: resolve });
    assert.strictEqual(d0.headline, 'English');
    assert.ok(d0.meta.includes('Strng IPTV 8K'));
});

test('true duplicates (same market+provider+container+quality) split by raw category', () => {
    const a = mk('EN - X', { sourceId: 's1', category_name: '|EN| DOCUMENTARY' });
    const b = mk('EN - X', { sourceId: 's1', category_name: 'EN ▎CINEMA MOVIES' });
    const da = M.versionDescriptor(a, { siblings: [a, b], resolveSourceName: resolve });
    const db = M.versionDescriptor(b, { siblings: [a, b], resolveSourceName: resolve });
    assert.ok(da.meta.includes('EN DOCUMENTARY'), `A needs category: ${da.meta}`);
    assert.ok(db.meta.includes('EN ▎CINEMA MOVIES'), `B needs category: ${db.meta}`);
    assert.notStrictEqual(da.meta, db.meta);
});

test('headline is never repeated in meta (market label == provider name)', () => {
    // Provider literally named "Netflix"; NF market also resolves to "Netflix".
    const nf = (id) => ({ x: 'Netflix' }[id] || '');
    const d = M.versionDescriptor(mk('NF - The Film', { sourceId: 'x' }), { resolveSourceName: nf });
    assert.strictEqual(d.headline, 'Netflix');
    assert.ok(!d.meta.split(' · ').includes('Netflix'), `Netflix duplicated in meta: ${d.meta}`);
    assert.strictEqual(d.meta, 'MKV');
});

test('SCAND (5-char Nordic prefix) resolves; no literal token leaks', () => {
    assert.strictEqual(desc(mk('SCAND - The Movie')).headline, 'Nordic');
    assert.strictEqual(desc(mk('SCAN ▎ X')).headline, 'Nordic');
});

test('a null hole in siblings does not throw', () => {
    const a = mk('EN - X');
    assert.doesNotThrow(() => M.versionDescriptor(a, { siblings: [a, null, undefined], resolveSourceName: resolve }));
});

test('fluidity tier maps to a dot descriptor (or null when unknown)', () => {
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'direct' }).tier.cls, 'tier-direct');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'video_transcode' }).tier.cls, 'tier-transcode');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'unknown' }).tier, null);
});
