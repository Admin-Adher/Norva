'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { build, migrated } = require('./fixtures/build-provider-audit-parity.cjs');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

test('forward migration mirrors the audited alias table without modifying historical migrations', () => {
    const source = read('public/js/utils/mediaUtils.js'), sql = read(migrated);
    const table = source.slice(source.indexOf('    const VERSION_PROVIDER_LANGUAGE_TAGS = {'), source.indexOf('\n\n    function versionProviderLanguageHint'));
    const aliases = JSON.parse(JSON.stringify(vm.runInNewContext(table + '\nVERSION_PROVIDER_LANGUAGE_TAGS')));
    const actual = JSON.parse(sql.match(/-- BEGIN GENERATED ALIASES\s+select '([^']+)'::jsonb/)[1]);
    assert.deepEqual(actual, aliases);
    assert.equal(actual.ku, 'ku'); assert.equal(actual.mt, 'mt');
    for (const country of ['ir', 'iran', 'malta', 'af', 'pk', 'exyu']) assert.equal(actual[country], undefined);
    assert.equal(actual.hu, null);
    assert.ok(read('scripts/build-provider-language-parser.cjs').includes(migrated));
    assert.doesNotMatch(read('scripts/build-provider-language-parser.cjs'), /20260910152938_catalog_provider_language_facets\.sql/);
    const historical = read('supabase/migrations/20260910152938_catalog_provider_language_facets.sql');
    assert.doesNotMatch(historical, /"ku":"ku"|"mt":"mt"/);
});

test('SQL repair preserves audio evidence, Selection/dubbed helpers and service-only invoker execution', () => {
    const sql = read(migrated);
    assert.equal((sql.match(/create or replace function/g) || []).length, 2);
    assert.equal((sql.match(/immutable security invoker set search_path = ''/g) || []).length, 2);
    assert.match(sql, /selection text := public\.selection_provider_audio_language\(p_metadata,p_external_id\)/);
    assert.ok(sql.indexOf('if selection is not null then return selection') < sql.indexOf('prefix_match := regexp_match'));
    assert.match(sql, /part := public\.catalog_provider_dubbed_category\(part\)/);
    assert.match(sql, /from public,anon,authenticated/);
    assert.match(sql, /to service_role/);
    assert.doesNotMatch(sql, /security definer|cloud_catalog_effective_audio_languages|backfill|\b(?:insert into|update|delete from|create table)\b/i);
    assert.equal((sql.match(/alter table/g) || []).length, 1);
    assert.match(sql, /alter table public\.cloud_catalog_provider_language_hints/);
    assert.ok(sql.includes("check (language ~ '^([a-z]{2,3}|nordic|exyu)$')"));
    assert.match(sql, /when region_hint then 'exyu'/);
    assert.match(sql, /not audio_blocked and cardinality\(tags\)=1/);
    assert.match(sql, /annotation_only/);
    assert.match(sql, /array\['da','sv','no'\]/);
    assert.ok(sql.includes("nl_hindi_category := category ~* '^\\s*NL\\s*\\|\\s*HINDI\\s*$'"));
    assert.match(sql, /nl_hindi_category and provider_prefix and prefix='NL'/);
    assert.match(sql, /when 2 then case when nl_hindi_category then 'HINDI' else category end/);
});

test('standalone SQL parity fixture is temporary, rollback-only and covers old/new/Selection cases', async () => {
    const { sql, rows } = await build();
    assert.equal(rows.filter(row => row.case_group === 'existing').length, 65);
    assert.ok(rows.filter(row => row.case_group === 'audit').length >= 62);
    assert.equal(rows.filter(row => row.case_group === 'selection').length, 4);
    assert.doesNotMatch(sql, /create(?: or replace)? function public\./i);
    assert.equal((sql.match(/create(?: or replace)? function pg_temp\./gi) || []).length, 4);
    assert.match(sql, /\nrollback;\n$/);
    assert.match(sql, /prosecdef or provolatile/);
});

test('optional reconciliation fixture copies only temporary functions and writable objects', async () => {
    const { sql } = await build(undefined, true);
    assert.equal((sql.match(/create(?: or replace)? function pg_temp\./gi) || []).length, 6);
    assert.doesNotMatch(sql, /\bpublic\.(?:cloud_|catalog_provider_|selection_provider_)/);
    assert.match(sql, /public\.norva_canonical_language_code\(raw_code\)/);
    assert.match(sql, /perform pg_temp\.cloud_catalog_reconcile_provider_language_hints/);
    assert.match(sql, /\nrollback;\n$/);
    assert.doesNotMatch(sql, /\n(?:commit;|notify |grant |revoke )/i);
});
