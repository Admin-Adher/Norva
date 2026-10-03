'use strict';
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/js/utils/mediaUtils.js'),'utf8').replace(/\r\n/g,'\n');
const rules=vm.runInNewContext('('+source.match(/const VERSION_PROVIDER_SCOPED_MARKET_TAGS = (\{[\s\S]*?\n    \});/)[1]+')');
let sql=fs.readFileSync(path.join(root,'supabase/migrations/20261003151500_provider_language_shelf_spelling.sql'),'utf8').replace(/\r\n/g,'\n');
sql=sql.replace('-- Normalize two full supplier shelves with misspelled Indian language names.\n-- No country aliases, observations, constraints or catalogue rows are changed.',
  '-- Catalogue-language conventions scoped to matching supplier shelves.\n-- Only fallback hints change; file observations and owner isolation are preserved.');
sql=sql.replace('  category_key text; category_match text[]; declared_french_multi boolean;',
  '  category_key text; category_match text[]; declared_french_multi boolean; declared_indian_multi boolean;\n  market_match text[]; market_rule jsonb; indian_qualifier text; indian_category text;');
const marker="  category_key := btrim(regexp_replace(category,'\\s+',' ','g'));";
sql=sql.replace(marker,()=>marker+`\n  market_match := regexp_match(raw,'^\\s*((?:4K-)?)((?:BR|HU|IS|QC|IR|IL|MY|PH|CH|CN|SW|PB|SC))(?=\\s*[-–—]\\s+|\\s+[-–—]\\s*|\\s*[|:])');
-- BEGIN GENERATED SCOPED MARKET TAGS
  market_rule := '${JSON.stringify(rules).replaceAll("'","''")}'::jsonb -> market_match[2];
-- END GENERATED SCOPED MARKET TAGS
  if market_rule is not null and category_key ~* (market_rule->>'category') then
    raw := regexp_replace(raw,'^\\s*((?:4K-)?)' || market_match[2],coalesce(market_match[1],'') || (market_rule->>'language'));
  end if;`);
const before='  prefix_match := regexp_match(raw,prefix_pattern);';
if(!sql.includes(before))throw Error('prefix insertion missing');
sql=sql.replace(before,()=>`  indian_qualifier := (regexp_match(raw,'^\\s*INI?\\s*[|:]\\s*([A-Z]+)\\s*[|:]'))[1];
  indian_category := regexp_replace(category_key,'^\\[IN\\] ','');
  indian_qualifier := coalesce('{"KANADA":"KANNADA","GUJARTI":"GUJARATI","TELUG":"TELUGU"}'::jsonb->>indian_qualifier,indian_qualifier);
  indian_category := coalesce('{"KANADA":"KANNADA","GUJARTI":"GUJARATI","TELUG":"TELUGU"}'::jsonb->>indian_category,indian_category);
  declared_indian_multi := category_key ~ '^\\[IN\\] (HINDI|TAMIL|TELUGU|MALAYALAM|KANADA|GUJARTI)$'
    and raw ~ '^\\s*INI?(?=\\s*[-–—]\\s+|\\s+[-–—]\\s*|\\s*[|:])'
    and raw ~* '\\[MULTI[ -]AUDIO\\]\\s*(?:(?:19|20)[0-9]{2})?\\s*$'
    and regexp_replace(regexp_replace(raw,'\\[MULTI[ -]AUDIO\\]','','i'),'\\((?:19|20)[0-9]{2}\\)','','g') !~ '[\\[\\]()]'
    and (indian_qualifier is null or indian_qualifier=indian_category);
`+before);
sql=sql.replace('if has_multi and not declared_french_multi then','if has_multi and not declared_french_multi and not declared_indian_multi then');
const target=path.join(root,'supabase/migrations/20261003163000_provider_scoped_market_language_tags.sql');
if(process.argv.includes('--check')){
 if(fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n')!==sql)throw Error('Scoped language migration drift');
}else fs.writeFileSync(target,sql);
