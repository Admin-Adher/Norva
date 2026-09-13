'use strict';
// Emits an isolated PostgreSQL fixture. Never run this setup against production.
const fs=require('node:fs'),path=require('node:path');
const {cases}=require('../tests/catalog-provider-language-filters.test.js');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const old=read('supabase/migrations/20260910152938_catalog_provider_language_facets.sql');
const migration=read('supabase/migrations/20260913102000_provider_dubbed_language_target.sql');
const literal=v=>v===null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const functions=['catalog_provider_language_alias','catalog_provider_language'].map(name=>{
    const definition=old.match(new RegExp('create function public\\.'+name+'\\([\\s\\S]*?\\$f\\$;'));
    if (!definition) throw Error('Missing original parser');
    return definition[0];
});
const assertions=cases.map(([raw,category,expected],i)=>
    `IF public.catalog_provider_language(jsonb_build_object('categoryName',${literal(category)}),'fixture',${literal(raw)}) IS DISTINCT FROM ${literal(expected)} THEN RAISE EXCEPTION 'parser case ${i}'; END IF;`).join('\n');
const sql=`-- ISOLATED FIXTURE ONLY
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION public.selection_provider_audio_language(jsonb,text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT NULL::text';
${functions.join('\n')}
REVOKE ALL ON FUNCTION public.catalog_provider_language_alias(text),public.catalog_provider_language(jsonb,text,text) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_provider_language_alias(text),public.catalog_provider_language(jsonb,text,text) TO service_role;
${migration}
DO $test$ BEGIN
${assertions}
IF has_function_privilege('anon','public.catalog_provider_dubbed_category(text)','EXECUTE')
 OR has_function_privilege('authenticated','public.catalog_provider_dubbed_category(text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.catalog_provider_dubbed_category(text)','EXECUTE') THEN RAISE EXCEPTION 'helper permissions'; END IF;
IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public.catalog_provider_language(jsonb,text,text)'::regprocedure,
 'public.catalog_provider_dubbed_category(text)'::regprocedure) AND (prosecdef OR provolatile<>'i')) THEN RAISE EXCEPTION 'parser privileges'; END IF;
END $test$;
SELECT jsonb_build_object('passed',true,'cases',${cases.length},'securityChecks',2,'definitions',
 (SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))) FROM pg_proc p
 WHERE p.oid IN ('public.catalog_provider_language(jsonb,text,text)'::regprocedure,'public.catalog_provider_dubbed_category(text)'::regprocedure)));
`;
if (!process.argv[2]) throw Error('Output path required');
fs.writeFileSync(process.argv[2],sql);
