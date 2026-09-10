'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {transformSync}=require('esbuild');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/vod-title-projection.ts'),'utf8');
function harness(transport=async()=>{throw Error('Unexpected network')}) {
  const module={exports:{}};
  const dependencies={...require('../supabase/functions/_shared/tmdb-search-policy.mjs'),
    ...require('../supabase/functions/_shared/tmdb-enrichment-policy.mjs'),
    isRollingRpcUnavailable:e=>['42883','PGRST202'].includes(e?.code),fetchBoundedProviderJson:transport};
  vm.runInNewContext(transformSync(source+'\nexport {tmdbPosterPath};',{loader:'ts',format:'cjs',target:'node22'}).code,{
    module,exports:module.exports,require:()=>dependencies,TextEncoder,URL,crypto:webcrypto,console,
    Deno:{env:{get:()=>''}},setTimeout:fn=>queueMicrotask(fn),
  });
  return module.exports;
}
const goodDetails={id:70160,title:'The Hunger Games',original_title:'The Hunger Games',release_date:'2012-03-21',
  translations:{translations:[{iso_639_1:'pt',data:{title:'Jogos Vorazes',overview:'Public overview'}}]},
  poster_path:'/ValidPoster.jpg'};

test('real incident: deleted first search candidate does not pin Jogos Vorazes or later accounts',async()=>{
  const requests=[];
  const api=harness(async raw=>{
    const url=new URL(raw);requests.push(url.pathname);
    if(url.pathname.includes('/search/')) return {response:{ok:true},value:{results:[
      {id:1701563,title:'New Trilogy Collection'},{id:70160,title:'The Hunger Games'},
      {id:101299,title:'The Hunger Games Catching Fire'}]}};
    if(url.pathname.endsWith('/1701563')) return {response:{ok:false,status:404,headers:new Headers()},value:{}};
    if(url.pathname.endsWith('/70160')) return {response:{ok:true},value:goodDetails};
    return {response:{ok:true},value:{id:101299,title:'Catching Fire',release_date:'2013-01-01'}};
  });
  const result=await api.searchTmdbMatch('fixture','movie','Jogos Vorazes',null);
  assert.equal(result.tmdbId,'70160');assert.ok(result.confidence>=0.9);
  assert.equal(requests.filter(x=>x.endsWith('/1701563')).length,1);
});
test('all removed candidates yield a completed miss, not an endless inflight item',async()=>{
  const api=harness(async raw=>new URL(raw).pathname.includes('/search/')
    ? {response:{ok:true},value:{results:[{id:99,title:'Test Movie'}]}}
    : {response:{ok:false,status:404,headers:new Headers()},value:{}});
  assert.equal(await api.searchTmdbMatch('fixture','movie','Test Movie',null),null);
});
for(const status of [401,403,429,503]) test(`TMDB ${status} remains an error, never a definitive miss`,async()=>{
  let requests=0;
  const api=harness(async()=>{requests++;return {response:{ok:false,status,headers:new Headers()},value:{}};});
  await assert.rejects(api.searchTmdbMatch('fixture','movie','Example',null),e=>e.name==='TmdbRequestError'&&e.status===status);
  assert.equal(requests,status===429||status>=500?3:1);
});
test('search deadline bounds new requests and poster proof rejects lookalike provider URLs',async()=>{
  const api=harness();
  await assert.rejects(api.searchTmdbMatch('fixture','movie','Example',null,null,0),/budget exhausted/);
  assert.equal(api.tmdbPosterPath('https://provider.invalid/t/p/w500/X.jpg'),null);
  assert.equal(api.tmdbPosterPath('https://image.tmdb.org/t/p/w500/X.jpg'),'/X.jpg');
  assert.equal(api.tmdbPosterPath('/x.jpg'),'/x.jpg');
});
const row={itemType:'movie',title:'The Squad: Home Run (2023)',originalTitle:null,releaseYear:2023,posterUrl:null,metadata:{}};
const cached={query_index:0,provider_tmdb_id:'101',metadata:{
  tmdb:{id:101,title:'The Squad: Home Run',release_date:'2023-01-01',genres:['Action']},
  tmdbValidation:{valid:true,title:'The Squad: Home Run',year:'2023'},i18n:{en:{title:'The Squad: Home Run'}}}};
test('public metadata reuse needs no provider/account identity or network and batches at 50',async()=>{
  const calls=[];const api=harness();
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:args.p_queries.map((_,query_index)=>({...cached,query_index})),error:null};}};
  const result=await api.reusePublicCatalogTitleMatches(db,Array(121).fill(row));
  assert.equal(result.size,121);assert.deepEqual(calls.map(x=>x.args.p_queries.length),[50,50,21]);
  assert.ok(calls.every(x=>x.name==='norva_public_catalog_title_candidates'));
  assert.doesNotMatch(JSON.stringify(calls),/userId|sourceId|externalId|audio/);
});
test('repeated or invalid cache evidence, wrong year and editorial rejection are not matches',async()=>{
  const api=harness();
  for(const data of [[cached,cached],[{...cached,provider_tmdb_id:'999'}],[{...cached,metadata:{...cached.metadata,tmdbValidation:{valid:false}}}]]){
    const db={rpc:async()=>({data,error:null})};
    if(data.length>1) await assert.rejects(api.reusePublicCatalogTitleMatches(db,[row]),/Invalid public title cache response/);
    else assert.equal((await api.reusePublicCatalogTitleMatches(db,[row])).size,0);
  }
  const db={rpc:async()=>({data:[cached],error:null})};
  assert.equal((await api.reusePublicCatalogTitleMatches(db,[{...row,releaseYear:1990,title:'The Squad Home Run'}])).size,0);
  assert.equal((await api.reusePublicCatalogTitleMatches(db,[{...row,metadata:{tmdbSearchReview:{rejectedTmdbIds:['101']}}}])).size,0);
});
test('rolling missing RPC can degrade but authorization and database failures cannot be hidden',async()=>{
  const api=harness();
  assert.equal((await api.reusePublicCatalogTitleMatches({rpc:async()=>({error:{code:'PGRST202'}})},[row])).size,0);
  for(const code of ['42501','PT409','57014']) await assert.rejects(api.reusePublicCatalogTitleMatches({rpc:async()=>({error:{code}})},[row]),e=>e.code===code);
});
