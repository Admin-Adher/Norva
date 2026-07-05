'use strict';

// Resolved synopsis language (VOD i18n Phase 2) — MediaUtils.resolveContentLanguage.
// A synopsis is read, so the chain is subtitle → audio → region → device locale → en.
// mediaUtils.js is a browser IIFE; load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;
const R = (o) => M.resolveContentLanguage(o);

test('subtitle preference leads (a synopsis is read)', () => {
    assert.strictEqual(R({ subtitle: 'fr', audio: 'en', regionLang: 'de', locale: 'pt-BR' }), 'fr');
});

test('"No subtitles"/empty subtitle is skipped → audio', () => {
    assert.strictEqual(R({ subtitle: 'none', audio: 'ar', regionLang: 'de' }), 'ar');
    assert.strictEqual(R({ subtitle: '', audio: 'ar', regionLang: 'de' }), 'ar');
});

test('audio "original" is not a readable language → region default', () => {
    assert.strictEqual(R({ subtitle: '', audio: 'original', regionLang: 'ar' }), 'ar');
});

test('region default, then device locale, then English floor', () => {
    assert.strictEqual(R({ subtitle: '', audio: '', regionLang: 'pt' }), 'pt');
    assert.strictEqual(R({ subtitle: '', audio: '', regionLang: '', locale: 'pt-BR' }), 'pt');
    assert.strictEqual(R({ subtitle: '', audio: '', regionLang: '', locale: '' }), 'en');
    assert.strictEqual(R({}), 'en');
});

test('full locale tags and region codes normalise to a 2-letter code', () => {
    assert.strictEqual(R({ subtitle: 'fr-FR' }), 'fr');
    assert.strictEqual(R({ audio: 'EN_US' }), 'en');
    assert.strictEqual(R({ regionLang: 'PT' }), 'pt');
});

test('garbage values are ignored, falling through the chain', () => {
    assert.strictEqual(R({ subtitle: 'xyz', audio: '123', regionLang: 'de' }), 'de'); // bad subs/audio skipped
    assert.strictEqual(R({ subtitle: 'zzzz', locale: 'en-US' }), 'en');
});
