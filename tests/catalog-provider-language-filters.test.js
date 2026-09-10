'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const load=()=>import(pathToFileURL(path.join(root,'supabase/functions/_shared/selection-provider-languages.mjs')));
const cases=[
  ['AL | Example','AL | DISNEY+','sq'],['AR | Example','AR | FOREIGN','ar'],['Example','GREECE','el'],
  ['Example','Nordic','nordic'],['HU | Example','SCANDINAVIA','nordic'],['Example','ASIA | HINDI','hi'],
  ['Example','NL | DISNEY+','nl'],['Bandit','AL ▎PRIME VIDEO','sq'],['Japan Malayalam Dubbed 2023','','ml'],
  ['4K-DE - Example','','de'],['[ES] Example','','es'],['Example [PT] (2024)','','pt'],
  ['Example - Tamil Dubbed 2023','','ta'],['Example - EN','','en'],['Example','ASIA | TELUGU','te'],
  ['Example','ASIA | ਪੰਜਾਬੀ','pa'],['Example','हिन्दी','hi'],['Example','தமிழ்','ta'],
  ['Example','മലയാളം','ml'],['Example','বাংলা','bn'],['Example','العربية','ar'],
  ['Example','日本語','ja'],['Example','한국어','ko'],['Example','中文','zh'],['Example','فارسی','fa'],
  ['Example','Français','fr'],['Example','Español','es'],['Example','FILIPINO','fil'],
  ['Hindi Medium','',null],['Johnny English','',null],['It','',null],['So - Example','',null],
  ['Example: Hindi','',null],['Example','FILMES DE AÇÃO',null],['Example','NO ADS',null],
  ['IN | Example','INDIA',null],['AF | Example','AFRICAN MOVIES',null],['HU | Example','',null],
  ['Example [VOSTFR]','',null],['AR-SUBS | Example','',null],['Example','HINDI SUBTITLES',null],
  ['FR | Example','AR',null],['Example [EN/FR]','',null],['MULTI | Example','ENGLISH MULTI',null],
  ['Example','constructor __proto__ toString',null],['Example','CANTONESE','yue']
];
module.exports={cases};
test('browser and server interpret exactly the same provider catalogue grammar',async()=>{
  const {catalogProviderAudioLanguages}=await load();
  const ctx={window:{},Intl,console};vm.runInNewContext(read('public/js/utils/mediaUtils.js'),ctx);
  for(const [raw,category,expected] of cases){
    const row={raw_title:raw,metadata:{categoryName:category},item_type:'movie'};
    assert.deepEqual(catalogProviderAudioLanguages(row),expected?[expected]:[],raw+'/'+category);
    const info=ctx.window.MediaUtils.catalogLanguageInfo(row);
    assert.equal(info.audioSource==='provider-label',Boolean(expected),raw+'/'+category);
  }
});
test('the chosen filter selects its matching file without overriding observed contradictory audio',async()=>{
  const {catalogVariantMatchesAudio:matches,providerAudioFacet}=await load();
  const row={raw_title:'AR | Example',metadata:{categoryName:'AR | FOREIGN'}};
  assert.equal(matches(row,'catalog-ar'),true);
  assert.equal(matches(row,'catalog-fr'),false);
  const observed={...row,__file_audio_observed:true,__file_audio_languages:['fr']};
  assert.equal(matches(observed,'catalog-ar'),false);
  assert.equal(matches(observed,'catalog-fr'),true);
  assert.equal(matches({...row,__file_audio_observed:true,__file_audio_languages:[]},'catalog-ar'),true);
  assert.equal(matches({...row,__file_audio_probed_at:'2026-09-10',__file_audio_tracks:[]},'catalog-ar'),false);
  assert.equal(matches({...row,__file_audio_tracks:[{lang:'fr'}]},'catalog-ar'),false);
  assert.equal(matches({metadata:{categoryName:'Filipino'}},'catalog-tl'),true);
  assert.equal(providerAudioFacet('catalog-nordic'),'nordic');
  assert.equal(providerAudioFacet('catalog-yue'),'yue');
  assert.equal(providerAudioFacet('catalog-yi'),'yi');
  assert.equal(providerAudioFacet('catalog-und'),null);
});
test('SQL counters and bounded page filtering share the exact visible per-variant union',()=>{
  const sql=read('supabase/migrations/20260910152938_catalog_provider_language_facets.sql');
  assert.match(sql,/enable row level security/);
  assert.doesNotMatch(sql,/security definer/i);
  assert.match(sql,/from public,anon,authenticated/g);
  assert.match(sql,/count\(distinct title_id\)/);
  assert.equal((sql.match(/from public\.cloud_catalog_effective_audio_languages\(/g)||[]).length,2);
  assert.match(sql,/variant\.user_id=hint\.user_id/);
  assert.match(sql,/variant\.source_id=hint\.source_id/);
  assert.match(sql,/observation\.variant_id=matching\.variant_id and observation\.subtitle_observed/);
  assert.match(sql,/for share of variant/);
  assert.match(sql,/on delete cascade/);
  assert.match(sql,/after update of metadata,raw_title,external_id,user_id,title_id,source_id,item_type/);
  assert.doesNotMatch(sql,/update public\.(cloud_title_variants|cloud_media_items|cloud_title_file_language_observations)/);
  const guard=read('supabase/migrations/20260910160152_catalog_language_counts_title_type_guard.sql');
  assert.match(guard,/title\.id=effective\.title_id and title\.user_id=p_user_id and title\.item_type=p_item_type/);
});
