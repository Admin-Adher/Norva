'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const full=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
const code=stripTypeScriptTypes(full.slice(full.indexOf('async function renewStoryboard('),full.indexOf('async function checkStoryboardAdmission(')));
const userId=crypto.randomUUID(),sourceId=crypto.randomUUID(),jobId=crypto.randomUUID();
function harness(options={}) {
 const state={minted:0,sourceReads:0,jobReads:0,gateCalls:0};
 const row={job_id:jobId,job_user_id:userId,status:'processing',provider_key:'provider',item_type:'movie',
  external_id:'42',sprite_path:`provider/movie-42-${jobId}.jpg`,job_source_id:sourceId,job_container:'mkv',job_duration:120,...options.row};
 const db={from(table){const filters=[];return {
  select(){return this;},eq(k,v){filters.push([k,v]);return this;},is(k,v){filters.push([k,v]);return this;},
  async maybeSingle(){
   if(table==='catalog_storyboards') {state.jobReads++;return {data: options.jobReplaced&&state.jobReads>1?null:filters.every(([k,v])=>row[k]===v)?row:null,error:null};}
   assert.equal(table,'cloud_sources'); state.sourceReads++;
   const src={id:sourceId,user_id:userId,enabled:true,deleted_at:null,sync_status:'ready',config_ciphertext:'encrypted-v1',...options.source};
   if(options.changed&&state.sourceReads>1)src.config_ciphertext='encrypted-v2';
   return {data:filters.every(([k,v])=>src[k]===v)?src:null,error:null};
  }};},storage:{from(){return {async createSignedUploadUrl(p){assert.equal(p,row.sprite_path);return {data:{signedUrl:'https://internal/storage/upload'},error:null};}};}}};
 class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
 const c={Request,Date,JSON,HttpError,STORYBOARD_BUCKET:'norva-storyboards',SUPABASE_URL:'https://internal',PUBLIC_ORIGIN:'https://api.norva.tv',
  getRuntimeConfig:async()=>({mediaGatewayToken:'qa-only-token'}),recordOrEmpty:v=>v||{},stringOr:(v,d)=>typeof v==='string'?v:d,
  throwDb:e=>{throw e;},runPregenGate:async()=>{state.gateCalls++;return {defer:!!options.busy};},
  resolveSourceIdentity:async()=>({key:options.identity||'provider'}),
  resolveVariantUrl:async()=>options.target===null?null:(options.target||'https://provider.invalid/private-url'),
  sha256Hex:async s=>crypto.createHash('sha256').update(s).digest('hex'),
  createBytePipeAccess:async(purpose,owner,target,expiry)=>{assert.equal(purpose,'storyboard-job');assert.equal(owner,userId);assert.ok(Date.parse(expiry)-Date.now()<=900000);state.minted++;return {url:'https://gateway.invalid/raw/grant'};}};
 vm.runInNewContext(code+'\nthis.renew=renewStoryboard;',c);
 return {state,run:(body={},token='qa-only-token')=>c.renew(new Request('https://api.norva.tv/storyboard-renew',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({jobId,userId,...body})}),db)};
}
test('renewal returns a short-lived grant bound to the current source and exact target',async()=>{
 const h=harness(),a=await h.run();assert.equal(a.sourceId,sourceId);assert.equal(a.duration,120);assert.match(a.sourceBinding,/^[a-f0-9]{64}$/);
 assert.equal(a.uploadUrl,'https://api.norva.tv/storage/upload');assert.equal(h.state.sourceReads,2);assert.equal(h.state.jobReads,2);
 const b=await harness({target:'https://provider.invalid/replacement'}).run();assert.notEqual(a.sourceBinding,b.sourceBinding);
});
for(const [name,opts,body,token,status] of [
 ['bad authentication',{}, {},'invalid',401],
 ['foreign owner',{}, {userId:crypto.randomUUID()},undefined,410],
 ['finished job',{row:{status:'ready'}},{},undefined,410],
 ['legacy unbound job',{row:{job_source_id:null}},{},undefined,410],
 ['disabled source',{source:{enabled:false}},{},undefined,410],
 ['removed source',{source:{deleted_at:'now'}},{},undefined,410],
 ['foreign source',{source:{user_id:crypto.randomUUID()}},{},undefined,410],
 ['provider identity change',{identity:'other'},{},undefined,410],
 ['temporarily unresolved target',{target:null},{},undefined,503],
]) test(name+' is rejected before minting a transport grant',async()=>{
 const h=harness(opts);await assert.rejects(h.run(body,token),e=>e.status===status);assert.equal(h.state.minted,0);
});
for(const [name,opts] of [['import in progress',{source:{sync_status:'syncing'}}],['viewer active',{busy:true}]])
 test(name+' defers without minting',async()=>{const h=harness(opts);assert.equal((await h.run()).defer,true);assert.equal(h.state.minted,0);});
for(const opts of [{changed:true},{jobReplaced:true}]) test('renewal rechecks state before returning minted grants '+JSON.stringify(opts),async()=>{
 const h=harness(opts);await assert.rejects(h.run(),e=>e.status===410);assert.equal(h.state.minted,1);
});
