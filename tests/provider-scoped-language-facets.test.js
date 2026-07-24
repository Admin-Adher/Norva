'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('provider facet RPC counts exact observed titles only inside the owned source', () => {
    const migration = read('supabase/migrations/20260724170000_provider_scoped_language_facets.sql');

    assert.match(migration, /cloud_exact_language_counts_by_source\s*\(/);
    assert.match(migration, /source\.user_id = p_user_id/);
    assert.match(migration, /variant\.source_id = owned_source\.id/);
    assert.match(migration, /cloud_title_file_language_observations observation/);
    assert.match(migration, /observation\.audio_observed/);
    assert.match(migration, /observation\.subtitle_observed/);
    assert.match(migration, /count\(distinct title_id\)::bigint/);
    assert.doesNotMatch(migration, /file_audio_languages/);
    assert.doesNotMatch(migration, /file_subtitle_languages/);
    assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

test('catalog facets route scopes RPC, memo and labels to provider plus media type', () => {
    const catalog = read('supabase/functions/norva-catalog/index.ts');

    assert.match(catalog, /url\.searchParams\.get\("source"\)/);
    assert.match(catalog, /cloud_exact_language_counts_by_source/);
    assert.match(catalog, /p_source_id: sourceId/);
    assert.match(catalog, /`\$\{userId\}:\$\{itemType\}:\$\{sourceId \|\| "all"\}`/);
    assert.match(catalog, /itemType === "series" \? "series" : "movies"/);
    assert.match(catalog, /`\$\{name\} · \$\{FACET_NUMBER\.format\(count\)\} \$\{noun\}`/);
    assert.match(catalog, /else if \(!sourceId\)/);
});

test('mobile catalog sheet exposes accessible language controls and counts them as filters', () => {
    const app = read('public/js/app.js');

    assert.match(app, /audio: 'movies-audio'/);
    assert.match(app, /subtitle: 'movies-subtitle'/);
    assert.match(app, /audio: 'series-audio'/);
    assert.match(app, /subtitle: 'series-subtitle'/);
    assert.match(app, /createMobileFilterSection\('Languages'\)/);
    assert.match(app, /\['audio', 'subtitle'\]\.forEach\(name => addField\(languageSection\.body, name\)\)/);
    assert.match(app, /label\.htmlFor = el\.id/);
    assert.match(app, /el\.setAttribute\?\.\('aria-label', labelText\)/);
    assert.match(app, /elements\.audio\?\.value/);
    assert.match(app, /elements\.subtitle\?\.value/);

    const badge = app.slice(
        app.indexOf('const updateBadge = () => {'),
        app.indexOf('const restore = () => {')
    );
    assert.doesNotMatch(badge, /elements\.source\?\.value/);
});
