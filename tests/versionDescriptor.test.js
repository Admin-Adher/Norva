'use strict';

// Version-button label builder for the Movie/Series fiches (MediaUtils.versionDescriptor):
// language lead (garbage-filtered), playback-fluidity tier, and differentiator chips that
// only appear when they actually vary across the title's versions.
// mediaUtils.js is a browser IIFE (assigns window.MediaUtils); load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

test('garbage provider prefix ("PREFIX") is never shown as a language', () => {
    const a = { raw_title: 'PREFIX - Oscar Shaw (2026)', container_extension: 'mkv', sourceId: 's1' };
    const b = { raw_title: 'AR - Oscar Shaw (2026)', container_extension: 'mkv', sourceId: 's1' };
    const d = M.versionDescriptor(a, { siblings: [a, b], index: 0 });
    assert.notStrictEqual(d.primary, 'PREFIX');
    assert.ok(!/PREFIX/i.test(d.primary), `primary should not contain PREFIX, got "${d.primary}"`);
});

test('language is read from the provider prefix, incl. the "▎" bar separator', () => {
    const it = { raw_title: 'IT ▎ The Return', container_extension: 'mkv', sourceId: 's1' };
    const ar = { raw_title: 'AR ▎ The Return', container_extension: 'mkv', sourceId: 's1' };
    const dIt = M.versionDescriptor(it, { siblings: [it, ar], index: 0 });
    const dAr = M.versionDescriptor(ar, { siblings: [it, ar], index: 1 });
    // Both resolve to a real language name (not the "Version N" fallback) and they differ.
    assert.ok(!/^Version \d/.test(dIt.primary), `IT primary was a fallback: "${dIt.primary}"`);
    assert.ok(!/^Version \d/.test(dAr.primary), `AR primary was a fallback: "${dAr.primary}"`);
    assert.notStrictEqual(dIt.primary, dAr.primary);
});

test('fluidity tier maps compatibility_tier to a labelled pill (or nothing when unknown)', () => {
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'direct' }).tier.key, 'direct');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'direct' }).tier.label, 'Lecture directe');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'video_transcode' }).tier.key, 'transcode');
    assert.strictEqual(M.versionDescriptor({ compatibility_tier: 'unknown' }).tier, null);
    assert.strictEqual(M.versionDescriptor({}).tier, null);
});

test('constant attributes are hidden; only differentiators become chips', () => {
    // Same language, same container, same source -> no attribute chips (just a Version tag
    // so the two buttons aren\'t identical).
    const a = { raw_title: 'AR - X', container_extension: 'mkv', sourceId: 's1' };
    const b = { raw_title: 'AR - X', container_extension: 'mkv', sourceId: 's1' };
    const da = M.versionDescriptor(a, { siblings: [a, b], index: 0 });
    assert.ok(!da.chips.includes('MKV'), 'container is constant -> should be hidden');
    assert.deepStrictEqual(da.chips, ['Version 1'], 'indistinguishable versions get a numeric tag');

    // Different container -> container chip appears (the sole differentiator).
    const c = { raw_title: 'AR - X', container_extension: 'mkv', sourceId: 's1' };
    const e = { raw_title: 'AR - X', container_extension: 'mp4', sourceId: 's1' };
    const dc = M.versionDescriptor(c, { siblings: [c, e], index: 0 });
    assert.ok(dc.chips.includes('MKV'), 'container varies -> should be shown');
    assert.ok(!dc.chips.some(x => /^Version/.test(x)), 'has a real differentiator -> no numeric tag');
});

test('provider chip only when versions span multiple sources', () => {
    const a = { raw_title: 'AR - X', container_extension: 'mkv', sourceId: 's1' };
    const b = { raw_title: 'AR - X', container_extension: 'mkv', sourceId: 's2' };
    const names = { s1: 'AtlasPro', s2: 'KING365' };
    const d = M.versionDescriptor(a, { siblings: [a, b], index: 0, resolveSourceName: (id) => names[id] });
    assert.ok(d.chips.includes('AtlasPro'), `expected provider chip, got ${JSON.stringify(d.chips)}`);

    // Single source -> no provider chip.
    const solo = M.versionDescriptor(a, { siblings: [a, { ...a }], index: 0, resolveSourceName: (id) => names[id] });
    assert.ok(!solo.chips.includes('AtlasPro'), 'same source -> provider hidden');
});
