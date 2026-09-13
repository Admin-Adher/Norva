'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createHash } = require('node:crypto');
const { build, migrated } = require('./fixtures/build-provider-audit-parity.cjs');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const aliasMigration = 'supabase/migrations/20260913172750_provider_ex_yugoslav_catalog_region.sql';

test('published alias migration stays immutable and matches the browser without being rewritten', () => {
    const source = read('public/js/utils/mediaUtils.js'), sql = read(aliasMigration);
    // LF-normalized digest of the already published migration, not the new
    // parser-only repair. An alias change needs a separate forward migration.
    assert.equal(createHash('sha256').update(sql).digest('hex'),
        '7823c610a7dbe2fb16acc136f80b9258d7b4b7ccde3438f7fdd3e58f2804ec89');
    const table = source.slice(source.indexOf('    const VERSION_PROVIDER_LANGUAGE_TAGS = {'), source.indexOf('\n\n    function versionProviderLanguageHint'));
    const aliases = JSON.parse(JSON.stringify(vm.runInNewContext(table + '\nVERSION_PROVIDER_LANGUAGE_TAGS')));
    const actual = JSON.parse(sql.match(/-- BEGIN GENERATED ALIASES\s+select '([^']+)'::jsonb/)[1]);
    assert.deepEqual(actual, aliases);
    assert.equal(actual.ku, 'ku'); assert.equal(actual.mt, 'mt');
    for (const country of ['ir', 'iran', 'malta', 'af', 'pk', 'exyu']) assert.equal(actual[country], undefined);
    assert.equal(actual.hu, null);
    const builder = read('scripts/build-provider-language-parser.cjs');
    assert.ok(builder.includes(aliasMigration));
    assert.doesNotMatch(builder, /20260910152938_catalog_provider_language_facets\.sql/);
    const written = [];
    vm.runInNewContext(builder, { __dirname: path.join(root, 'scripts'), process: { argv: [] },
        require(name) {
            if (name === 'node:fs') return { ...fs, writeFileSync(file) { written.push(path.relative(root, file).replace(/\\/g, '/')); } };
            return require(name);
        },
    });
    assert.deepEqual(written, ['supabase/functions/_shared/provider-catalog-language.mjs']);
    assert.doesNotMatch(read(migrated), /GENERATED ALIASES|create or replace function public\.catalog_provider_language_alias/i);
    const historical = read('supabase/migrations/20260910152938_catalog_provider_language_facets.sql');
    assert.doesNotMatch(historical, /"ku":"ku"|"mt":"mt"/);
});

test('parser-only SQL repair preserves audio evidence, helpers, constraints and the installed service-only ACL', () => {
    const sql = read(migrated);
    assert.equal((sql.match(/create or replace function/g) || []).length, 1);
    assert.equal((sql.match(/immutable security invoker set search_path = ''/g) || []).length, 1);
    const definitions = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(match => match[1]);
    assert.deepEqual(definitions, ['catalog_provider_language']);
    // Allow only the transaction, timeouts and exact replacement declaration
    // outside its body: no ACL/table/helper change can hitchhike on this repair.
    const outer = sql.replace(/\$f\$[\s\S]*?\$f\$/, 'BODY').replace(/--[^\n]*/g, '');
    assert.deepEqual(outer.split(';').map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean), [
        'begin', "set local lock_timeout = '2s'", "set local statement_timeout = '30s'",
        "create or replace function public.catalog_provider_language(p_metadata jsonb, p_external_id text, p_raw_title text) returns text language plpgsql immutable security invoker set search_path = '' as BODY",
        'commit',
    ]);
    assert.match(sql, /selection text := public\.selection_provider_audio_language\(p_metadata,p_external_id\)/);
    assert.ok(sql.indexOf('if selection is not null then return selection') < sql.indexOf('prefix_match := regexp_match'));
    assert.match(sql, /part := public\.catalog_provider_dubbed_category\(part\)/);
    assert.match(read(aliasMigration), /revoke all on function public\.catalog_provider_language_alias\(text\), public\.catalog_provider_language\(jsonb,text,text\) from public,anon,authenticated/);
    assert.match(read(aliasMigration), /grant execute on function public\.catalog_provider_language_alias\(text\), public\.catalog_provider_language\(jsonb,text,text\) to service_role/);
    assert.doesNotMatch(sql, /security definer|cloud_catalog_effective_audio_languages|backfill|\b(?:insert into|update|delete from|create table|alter|drop|grant|revoke|execute|truncate|copy|call)\b/i);
    assert.deepEqual([...new Set([...sql.matchAll(/public\.([a-z_]+)\(/g)].map(match => match[1]))].sort(),
        ['catalog_provider_dubbed_category', 'catalog_provider_language', 'catalog_provider_language_alias', 'selection_provider_audio_language']);
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
    assert.equal(rows.filter(row => row.case_group === 'crossProvider').length, 95);
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
