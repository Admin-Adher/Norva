'use strict';

// Norva content regions (js/data/regions.js) — the ISO-3166 country/bundle model backing the
// "Your region" setting and (Phase 2) the region→synopsis-language link.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const R = require(path.join(__dirname, '..', 'public', 'js', 'utils', 'regions.js'));

test('catalogue is a healthy size: ~50 countries + 4 bundles, unique codes', () => {
    assert.ok(R.COUNTRIES.length >= 40, `too few countries: ${R.COUNTRIES.length}`);
    assert.strictEqual(R.BUNDLES.length, 4);
    const codes = R.ALL.map((r) => r.code);
    assert.strictEqual(new Set(codes).size, codes.length, 'duplicate region codes');
});

test('every entry is well-formed (2-letter country codes; valid shape)', () => {
    const PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/; // must match cloudApi CONTENT_REGION_PATTERN
    for (const r of R.ALL) {
        assert.ok(PATTERN.test(r.code), `bad code: ${r.code}`);
        assert.ok(r.name && r.flag && r.defaultLanguage, `incomplete entry: ${r.code}`);
        assert.ok(Array.isArray(r.languages) && r.languages.length, `no languages: ${r.code}`);
        assert.ok(/^[a-z]{2,3}$/.test(r.defaultLanguage), `bad defaultLanguage: ${r.code}=${r.defaultLanguage}`);
        if (r.kind === 'country') assert.ok(/^[A-Z]{2}$/.test(r.code), `country not alpha-2: ${r.code}`);
    }
});

test('the 4 legacy bundles + FR/US/IN survive (no stored preference breaks)', () => {
    for (const code of ['FR', 'US', 'IN', 'MAGHREB', 'LUSOPHONE', 'INTERNATIONAL']) {
        assert.strictEqual(R.normalize(code), code, `legacy region dropped: ${code}`);
        assert.ok(R.byCode(code), `no entry for legacy region: ${code}`);
    }
});

test('normalize resolves aliases and rejects junk', () => {
    assert.strictEqual(R.normalize('UK'), 'GB');
    assert.strictEqual(R.normalize('uk'), 'GB');
    assert.strictEqual(R.normalize('scandinavia'), 'NORDIC');
    assert.strictEqual(R.normalize('  fr  '), 'FR');
    assert.strictEqual(R.normalize('ZZ'), 'ZZ');   // uncurated 2-letter ISO passes through, not dropped
    assert.strictEqual(R.normalize('!!'), '');
    assert.strictEqual(R.normalize(''), '');
});

test('defaultLanguage gives the region→language link Phase 2 needs', () => {
    assert.strictEqual(R.defaultLanguage('FR'), 'fr');
    assert.strictEqual(R.defaultLanguage('US'), 'en');
    assert.strictEqual(R.defaultLanguage('MAGHREB'), 'ar');
    assert.strictEqual(R.defaultLanguage('LUSOPHONE'), 'pt');
    assert.strictEqual(R.defaultLanguage('IR'), 'fa');
    assert.strictEqual(R.defaultLanguage('BR'), 'pt');
    assert.strictEqual(R.defaultLanguage('UNKNOWN_XYZ'), 'en'); // safe floor
});

test('inferFromLocale prefers an explicit country subtag, else maps language', () => {
    assert.strictEqual(R.inferFromLocale(['fr-CA']), 'CA');
    assert.strictEqual(R.inferFromLocale(['pt-BR']), 'BR');
    assert.strictEqual(R.inferFromLocale(['en-GB']), 'GB');
    assert.strictEqual(R.inferFromLocale(['de']), 'DE');      // language-only → representative region
    assert.strictEqual(R.inferFromLocale(['ar']), 'MAGHREB');
    assert.strictEqual(R.inferFromLocale(['zz', 'qq']), 'INTERNATIONAL'); // unknown → floor
    // Empty array falls back to the platform's navigator locale (env-dependent), so we only
    // assert it yields a valid, known region code.
    assert.ok(R.byCode(R.inferFromLocale([])), 'empty locale should still resolve to a known region');
});

test('list is Countries A-Z then bundles; search filters by name or code', () => {
    const list = R.list();
    assert.strictEqual(list[list.length - 1].code, 'INTERNATIONAL'); // bundles last
    assert.ok(list.slice(0, R.COUNTRIES.length).every((r) => r.kind === 'country'));
    // countries sorted by name
    const names = list.filter((r) => r.kind === 'country').map((r) => r.name);
    assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
    assert.deepStrictEqual(R.search('portugal').map((r) => r.code), ['PT']);
    assert.ok(R.search('BR').some((r) => r.code === 'BR')); // by code
    assert.strictEqual(R.search('zzzznope').length, 0);
});

test('tmdbRegion + flag helpers resolve', () => {
    assert.strictEqual(R.tmdbRegion('MAGHREB'), 'MA');
    assert.strictEqual(R.tmdbRegion('FR'), 'FR');
    assert.strictEqual(R.flag('FR'), '🇫🇷');
    assert.strictEqual(R.flag('UNKNOWN_XYZ'), '🌐');
});
