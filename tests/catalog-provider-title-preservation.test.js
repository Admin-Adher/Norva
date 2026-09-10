'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-catalog/index.ts'), 'utf8');
const start = source.indexOf('function prepareProviderMediaRow(');
const end = source.indexOf('\nasync function listMediaItems(', start);
assert.ok(start >= 0 && end > start);
const prepare = vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '; prepareProviderMediaRow');

test('flat provider labels survive localization and the public serializer for every source type', async () => {
    const { sanitizeCatalogMediaItem } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
    for (const sourceKind of ['xtream', 'm3u', 'selection']) {
        for (const type of ['movie', 'series']) {
            for (const prefix of ['ALB', 'FR', 'GR', 'HU', 'IN', 'NL', 'SO']) {
                const row = {item_type:type,title:`${prefix} ▎ Example`,name:`${prefix} ▎ Example`,
                    release_year:2023,source_id:sourceKind,audio_language_validation_status:'not_analyzed'};
                prepare(row);
                row.title = 'Localized display title'; row.name = row.title;
                const result = sanitizeCatalogMediaItem(row);
                assert.equal(result.raw_title, `${prefix} ▎ Example`);
                assert.equal(result.rawTitle, `${prefix} ▎ Example`);
                assert.equal(result.title, 'Localized display title');
                assert.equal(result.year, 2023);
                assert.equal(result.audio_language_validation_status, 'not_analyzed');
                assert.equal(result.audio_tracks, undefined);
                assert.equal(result.provider_audio_languages, undefined);
            }
        }
    }
});

test('an existing raw title wins and empty or invalid labels are never manufactured', () => {
    assert.equal(prepare({raw_title:'SO | Original',title:'Translated'}).rawTitle, 'SO | Original');
    assert.equal(prepare({rawTitle:'AL | Original',title:'Translated'}).raw_title, 'AL | Original');
    assert.equal(prepare({raw_title:'',rawTitle:' ',title:'FR | Original'}).raw_title, 'FR | Original');
    const row = {title:null,name:0,metadata:{title:'Do not inherit metadata'},audio_tracks:[{index:4,lang:'fr'}]};
    const tracks = row.audio_tracks;
    assert.equal(prepare(row).raw_title, undefined);
    assert.equal(row.audio_tracks, tracks);
});

test('both owned-inventory read paths preserve labels before enrichment without new queries', () => {
    const list = source.slice(source.indexOf('async function listMediaItems('), source.indexOf('// Flat media rows'));
    assert.equal((list.match(/\.map\(prepareProviderMediaRow\)/g) || []).length, 2);
    for (const section of list.split('.map(prepareProviderMediaRow)').slice(1)) {
        assert.ok(section.indexOf('await attachMediaLanguages') >= 0);
        assert.ok(section.indexOf('await localizeMediaTitles') > section.indexOf('await attachMediaLanguages'));
    }
    assert.doesNotMatch(source.slice(start, end), /db\.|fetch\(|audio_tracks\s*=|audio_languages\s*=/);
});
