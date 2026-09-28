const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/norva-playback/index.ts','utf8');
const start=source.indexOf('async function loadNativeMovieAccessProof(');const end=source.indexOf('// Exact membership',start);
const code=source.slice(start,end).replace(/options: \{[\s\S]*?\}\) \{/,'options) {');
async function fixture({owned=true,dbError=false,profile={container:'mpegts',probeSource:'gatewayprobe',probedAt:new Date().toISOString(),fileSizeBytes:123456}}={}) {
 const calls=[];const {nativeVodFileProof}=await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
 const db={from(table){calls.push(['table',table]);return{select(){return this},eq(k,v){calls.push([k,v]);return this},async maybeSingle(){return table==='cloud_catalog_visible_title_variants'?{data:owned?{id:'owned-id'}:null}:{data:{observed_profile_snapshot:profile},error:dbError}}}}};
 const ctx={nativeVodFileProof,resolveSourceIdentity:async(s,u)=>{calls.push(['identity',s,u]);return{key:'verified-provider'}}};vm.createContext(ctx);vm.runInContext(code,ctx);
 return {calls,run:()=>ctx.loadNativeMovieAccessProof({db,userId:'owner',sourceId:'source',itemId:'movie'})};
}
test('missing tenant profile reuses exact server TS evidence without opening a provider',async()=>{const f=await fixture();assert.equal((await f.run()).fileSizeBytes,123456);for(const filter of [['user_id','owner'],['source_id','source'],['server_host','verified-provider'],['external_id','movie'],['item_type','movie']])assert.ok(f.calls.some(x=>JSON.stringify(x)===JSON.stringify(filter)));assert.ok(!code.includes('fetch('));});
test('invisible movie never reaches shared evidence',async()=>{const f=await fixture({owned:false});assert.equal(await f.run(),null);assert.ok(!f.calls.some(x=>x[0]==='identity'));});
test('stale, missing, caller-origin and failed database evidence are rejected',async()=>{for(const options of [{dbError:true},{profile:null},{profile:{container:'mpegts',fileSizeBytes:123456,probedAt:new Date().toISOString(),probeSource:'client'}},{profile:{container:'mpegts',fileSizeBytes:123456,probedAt:'2001-01-01',probeSource:'gatewayprobe'}}]){const f=await fixture(options);assert.equal(await f.run(),null);}});
