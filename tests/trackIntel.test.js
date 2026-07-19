'use strict';

// Phase 1 "track intelligence" — label/category parser used by the player to show
// the real audio language and burned-in subtitle status (mediaUtils.deriveTrackIntel).
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

const audio = (title, category, hasSub) => {
    const a = M.deriveTrackIntel({ title, category, hasSubtitleStream: hasSub }).audio;
    return a ? { name: a.name, isDub: a.isDub } : null;
};
const sub = (title, category, hasSub) => {
    const s = M.deriveTrackIntel({ title, category, hasSubtitleStream: hasSub }).subtitle;
    return s ? { name: s.name, type: s.type } : null;
};

test('IR version: Persian audio + Persian burned-in subtitles', () => {
    assert.deepStrictEqual(audio('IR - The Secret Agent (2025) مامور مخفی', 'IR - PERSIAN SUB/DUB', false), { name: 'Persian', isDub: true });
    assert.deepStrictEqual(sub('IR - The Secret Agent (2025) مامور مخفی', 'IR - PERSIAN SUB/DUB', false), { name: 'Persian', type: 'burned-in' });
});

test('AR-SUBS: Arabic burned-in subtitles (no subtitle stream)', () => {
    assert.strictEqual(audio('AR-SUBS - The Secret Agent (2025)', 'أفلام أجنبية 2025', false), null);
    assert.deepStrictEqual(sub('AR-SUBS - The Secret Agent (2025)', 'أفلام أجنبية 2025', false), { name: 'Arabic', type: 'burned-in' });
});

test('AR-SUBS with a real soft subtitle track -> soft, not burned-in', () => {
    assert.deepStrictEqual(sub('AR-SUBS - The Secret Agent (2025)', '', true), { name: 'Arabic', type: 'soft' });
});

test('region prefixes map to the right audio language', () => {
    assert.strictEqual(audio('ES - El agente secreto (2025)', '', false).name, 'Spanish');
    assert.strictEqual(audio('PT - O Agente Secreto 2025', '', false).name, 'Portuguese');
    assert.strictEqual(audio('DE - The Secret Agent (2025)', '', false).name, 'German');
    assert.strictEqual(audio('GR - The Secret Agent (2025)', '', false).name, 'Greek');
    assert.strictEqual(audio('AL - The Secret Agent (2025)', '', false).name, 'Albanian');
    assert.strictEqual(audio('4K-AR - The Secret Agent (2025)', '', false).name, 'Arabic');
    assert.strictEqual(audio('IN-EN - The Secret Agent (2025)', '', false).name, 'English'); // explicit lang wins
    assert.strictEqual(audio('IN - The Secret Agent (2025)', '', false).name, 'Hindi'); // India -> Hindi best-effort
});

test('parseVersionInfo exposes the region audio signal (player audio-menu path)', () => {
    const code = (t) => (M.parseVersionInfo(t).audioSignals[0] || {}).language || null;
    assert.strictEqual(code('IR - The Secret Agent (2025)'), 'fa');
    assert.strictEqual(code('GR - The Secret Agent (2025)'), 'el');
    assert.strictEqual(code('AL - The Secret Agent (2025)'), 'sq');
});

test('no false positives on ordinary film titles', () => {
    assert.strictEqual(M.deriveTrackIntel({ title: 'Once Upon a Time in America (1984)', hasSubtitleStream: false }).audio, null);
    assert.strictEqual(M.deriveTrackIntel({ title: 'Spider-Man: No Way Home (2021)', hasSubtitleStream: false }).audio, null);
    assert.strictEqual(M.deriveTrackIntel({ title: 'DC - League of Super-Pets', hasSubtitleStream: false }).audio, null);
    assert.strictEqual(M.parseVersionInfo('IT (2017)').audioSignals.length, 0);
});

test('spelled-out language NAMES in a title are not mistaken for an audio tag', () => {
    // Regression: full language words ("Italian", "English", …) are common title words and used to
    // false-positive ("The Italian Job"→it). They must NOT resolve to an audio language from the title.
    for (const t of [
        'The Italian Job (2003)', 'The English Patient (1996)', 'Spanish Affair',
        'Chinese Zodiac (2012)', 'Japanese Story', 'The Russian Bride', 'Turkish Delight',
        'The Polish Brothers', 'A Portuguese Tale', 'Dutch (1991)', 'Korean Cinema',
    ]) {
        assert.strictEqual(M.deriveTrackIntel({ title: t, hasSubtitleStream: false }).audio, null, t);
    }
    // …but a delimiter-guarded abbreviation tag still works, and the curated category still resolves names.
    assert.strictEqual(M.deriveTrackIntel({ title: 'The Secret Agent (2025) [ITA]', hasSubtitleStream: false }).audio.name, 'Italian');
    assert.strictEqual(M.deriveTrackIntel({ title: 'Some Movie', category: 'IT - ITALIANO', hasSubtitleStream: false }).audio.name, 'Italian');
});

test('probed, no subtitle signal -> subtitle type "none"', () => {
    assert.deepStrictEqual(sub('DE - The Secret Agent (2025)', '', false), { name: null, type: 'none' });
});
