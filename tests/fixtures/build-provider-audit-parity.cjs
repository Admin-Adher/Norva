'use strict';
// Builds a rollback-only, pg_temp fixture; never installs a public function.
// Usage: node tests/fixtures/build-provider-audit-parity.cjs OUTPUT.sql [EVIDENCE.json] [--reconciliation]
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migrated = 'supabase/migrations/20260913165456_provider_nl_hindi_category_language.sql';
const knownCases = name => {
    const match = read(name).match(/const cases\s*=\s*(\[[\s\S]*?\n\]);/);
    if (!match) throw Error('Fixture cases missing: ' + name);
    return vm.runInNewContext(match[1]);
};
const definition = (file, name) => {
    const match = read(file).match(new RegExp('create(?: or replace)? function public\\.' + name
        + '\\([\\s\\S]*?\\$(f|function)\\$;'));
    if (!match) throw Error('Function definition missing: ' + name);
    return match[0];
};
async function build(evidenceFile, includeReconciliation = false) {
    const rows = [];
    for (const [group, file] of [
        ['existing', 'tests/catalog-provider-language-filters.test.js'],
        ['audit', 'tests/catalog-provider-language-audit-regressions.test.js'],
    ]) for (const [raw, category, expected] of knownCases(file)) rows.push({
        case_id: rows.length, case_group: group, metadata: { categoryName: category },
        external_id: 'fixture', raw_title: raw, expected,
    });
    const fixtureId = 'norva-selection:movie:' + 'a'.repeat(64);
    const base = { selectionRevision: 'selection-vod-20260906-v1', categoryName: 'EN' };
    for (const [metadata, expected] of [
        [{ ...base, discoveryFeed: 'babuperumana-vod', selectionVodGroup: 'Movies / Hindi / 2024' }, 'hi'],
        [{ ...base, discoveryFeed: 'klysmgt-tested-vod', selectionFilenameAudio: { version: 1, language: 'es', urlSha256: 'b'.repeat(64) }, selectionPlaybackValidation: { urlSha256: 'b'.repeat(64) } }, 'es'],
        [{ ...base, discoveryFeed: 'klysmgt-tested-vod', selectionFilenameAudio: { version: 1, language: 'es', urlSha256: 'b'.repeat(64) }, selectionPlaybackValidation: { urlSha256: 'c'.repeat(64) } }, 'en'],
        [{ ...base, selectionRevision: 'wrong', discoveryFeed: 'babuperumana-vod', selectionVodGroup: 'Movies / Hindi / 2024' }, 'en'],
    ]) rows.push({ case_id: rows.length, case_group: 'selection', metadata,
        external_id: fixtureId, raw_title: 'EN | Example', expected });
    if (evidenceFile) {
        const { providerCatalogLanguage } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/provider-catalog-language.mjs')));
        const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
        for (const record of evidence.rows) {
            // Grammar replay only: omit private identities and all stream URLs.
            const item = { raw_title: record.raw_title, category_name: record.category };
            rows.push({ case_id: rows.length, case_group: 'cohort',
                metadata: { categoryName: record.category }, external_id: 'fixture',
                raw_title: record.raw_title, expected: providerCatalogLanguage(item) });
        }
    }
    const functions = [
        definition('supabase/migrations/20260909203657_selection_filename_audio_declarations.sql', 'selection_provider_audio_language'),
        definition(migrated, 'catalog_provider_language_alias'),
        definition('supabase/migrations/20260913102000_provider_dubbed_language_target.sql', 'catalog_provider_dubbed_category'),
        definition(migrated, 'catalog_provider_language'),
    ].join('\n').replace(/public\.(selection_provider_audio_language|catalog_provider_language_alias|catalog_provider_dubbed_category|catalog_provider_language)\b/g, 'pg_temp.$1');
    let reconciliation = '';
    if (includeReconciliation) {
        const fixture = read('tests/fixtures/audited-language-hint-reconciliation.sql').split('-- FUNCTIONS UNDER TEST');
        if (fixture.length !== 2) throw Error('Reconciliation fixture boundary missing');
        const file = 'supabase/migrations/20260913145852_audited_language_hint_reconciliation.sql';
        const copies = ['cloud_catalog_reconcile_provider_language_hints', 'cloud_catalog_effective_audio_languages']
            .map(name => definition(file, name)).join('\n')
            .replace(/public\.(cloud_[a-z0-9_]+|catalog_provider_language)\b/g, 'pg_temp.$1');
        if (/public\.(?!norva_canonical_language_code\b)[a-z0-9_]+/.test(copies)) throw Error('Unexpected public dependency in reconciliation fixture');
        reconciliation = fixture[0] + '\n' + copies + '\n' + fixture[1];
    }
    const encoded = "'" + JSON.stringify(rows).replaceAll("'", "''") + "'";
    const sql = `-- ROLLBACK-ONLY PRIVATE FIXTURE: pg_temp functions, no public DDL or catalogue writes.
begin;
set local statement_timeout = '20s';
set local lock_timeout = '2s';
create temporary table provider_language_parity_cases (
  case_id integer, case_group text, metadata jsonb, external_id text, raw_title text, expected text
) on commit drop;
${functions}
insert into pg_temp.provider_language_parity_cases
select * from jsonb_to_recordset(${encoded}::jsonb)
  as input(case_id integer,case_group text,metadata jsonb,external_id text,raw_title text,expected text);
create temporary table provider_language_parity_results on commit drop as
select input.*, pg_temp.catalog_provider_language(metadata,external_id,raw_title) as actual
from pg_temp.provider_language_parity_cases input;
do $test$
declare failed record;
begin
  select case_id,case_group,expected,actual into failed from pg_temp.provider_language_parity_results
    where actual is distinct from expected order by case_id limit 1;
  if found then raise exception 'Provider language SQL parity failed: case %, group %, expected %, actual %',
    failed.case_id,failed.case_group,failed.expected,failed.actual; end if;
  if exists(select 1 from pg_proc where oid in (
    'pg_temp.catalog_provider_language(jsonb,text,text)'::regprocedure,
    'pg_temp.catalog_provider_language_alias(text)'::regprocedure,
    'pg_temp.catalog_provider_dubbed_category(text)'::regprocedure,
    'pg_temp.selection_provider_audio_language(jsonb,text)'::regprocedure)
    and (prosecdef or provolatile <> 'i' or not coalesce('search_path=""'=any(proconfig),false)))
  then raise exception 'Provider language SQL security contract failed'; end if;
end
$test$;
select jsonb_build_object('passed',true,'cases',count(*),'mismatches',count(*) filter(where actual is distinct from expected),
  'existingCases',count(*) filter(where case_group='existing'),'auditCases',count(*) filter(where case_group='audit'),
  'selectionCases',count(*) filter(where case_group='selection'),'cohortRows',count(*) filter(where case_group='cohort'),
  'scope','pg_temp only; transaction rolled back') from pg_temp.provider_language_parity_results;
${reconciliation}
rollback;
`;
    if (/\b(?:create|alter|drop)(?: or replace)? function public\./i.test(sql)) throw Error('Unsafe public DDL in parity fixture');
    return { sql, rows };
}
module.exports = { build, migrated };
if (require.main === module) {
    if (!process.argv[2]) throw Error('Output path required');
    build(process.argv[3] === '--reconciliation' ? undefined : process.argv[3], process.argv.includes('--reconciliation')).then(({ sql, rows }) => {
        fs.writeFileSync(process.argv[2], sql);
        console.log(JSON.stringify({ output: process.argv[2], cases: rows.length,
            groups: rows.reduce((out, row) => (out[row.case_group] = (out[row.case_group] || 0) + 1, out), {}) }));
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
