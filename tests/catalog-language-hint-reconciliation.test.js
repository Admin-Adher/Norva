'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');

test('placeholder-only observations leave a real supplier language usable, exact audio still wins', async () => {
    const { catalogVariantMatchesAudio: matches } = await import(pathToFileURL(path.join(root,
        'supabase/functions/_shared/selection-provider-languages.mjs')));
    const supplier = { raw_title: 'DK | Example', metadata: { categoryName: 'SCANDINAVIA' }, __file_audio_observed: true };
    for (const languages of [[], ['und'], ['unknown', 'un'], ['und', null, '']]) {
        const row = { ...supplier, __file_audio_languages: languages };
        assert.equal(matches(row, 'unidentified'), false);
        assert.equal(matches(row, 'catalog-da'), true);
    }
    for (const languages of [['de'], ['und', 'de']]) {
        const row = { ...supplier, __file_audio_languages: languages };
        assert.equal(matches(row, 'unidentified'), false);
        assert.equal(matches(row, 'catalog-da'), false);
        assert.equal(matches(row, 'catalog-de'), true);
    }
    assert.equal(matches({ __file_audio_observed: true, __file_audio_languages: ['und'] }, 'unidentified'), true);
});

test('derived hint reconciliation is owner-scoped, bounded, idempotent and does not rewrite evidence', () => {
    const sql = fs.readFileSync(path.join(root,
        'supabase/migrations/20260913145852_audited_language_hint_reconciliation.sql'), 'utf8');
    assert.match(sql, /p_user_id is null/);
    assert.match(sql, /p_limit>2000/);
    assert.match(sql, /variant.user_id=p_user_id/);
    assert.match(sql, /for share of variant/);
    assert.match(sql, /is distinct from/);
    assert.match(sql, /join codes on codes.raw_code=language.value and codes.code is not null/);
    assert.match(sql, /observation.file_external_id=variant.external_id/);
    assert.match(sql, /from public,anon,authenticated/);
    assert.doesNotMatch(sql, /security definer|(?:update|delete from|insert into) public\.(?:cloud_title_variants|cloud_media_items|catalog_file_tracks|cloud_title_file_language_observations)/i);
});
