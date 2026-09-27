const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/norva-playback/index.ts','utf8');
const a=source.indexOf('async function loadNativeEpisodeAccessProof('), b=source.indexOf('async function resolveExactEpisodePlaybackTarget(',a);
const code=source.slice(a,b).replace(/options: \{[\s\S]*?\}\) \{/, 'options) {');
const profile=()=>({container:'mpegts',fileSizeBytes:100000,durationSeconds:2985,probeSource:'gateway_probe',probedAt:new Date().toISOString()});
async function fixture({cached=null,drained=true,valid=true,busy=false,timeout=false,coordinates={}}={}) {
 const {nativeVodFileProof}=await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
 const calls=[]; const q={select(){return this},eq(k,v){calls.push(['filter',k,v]);return this},async maybeSingle(){return {data:{observed_profile_snapshot:cached}}}};
 class HttpError extends Error {constructor(status,message){super(message);this.status=status}}
 const ctx={HttpError,nativeVodFileProof,crypto:require('node:crypto').webcrypto,AbortSignal,
 stringOr:(v,f)=>typeof v==='string'?v:f, recordOrEmpty:v=>v&&typeof v==='object'?v:{},
 resolveSourceIdentity:async()=>({key:'verified-provider'}), getRuntimeConfig:async()=>({}),
 mediaGatewayRouteForPlaybackUser:async()=>({url:'https://gateway.test',token:'private'}),
 claimProviderFileProbeStrict:async()=>{calls.push(['claim']);return !busy},
 releaseProviderFileProbe:async()=>calls.push(['release']),
 sanitizedProviderErrorCode:()=>null,providerProbeResponseAllowsLeaseRelease:()=>drained,
 shareObservedGatewayFile:async(db,v)=>{calls.push(['save',v]);return true},
 fetch:async(url,opts)=>{calls.push(['probe',JSON.parse(opts.body)]);if(timeout)throw new Error('timeout');return{ok:true,status:200,json:async()=>({codecProfile:valid?profile():{},audioProbeComplete:true,subtitleProbeComplete:true})}},
 };
 vm.createContext(ctx);vm.runInContext(code,ctx);
 const options={db:{from:()=>q},userId:'owner',sourceId:'source',itemId:'episode',targetUrl:'https://owned.test/exact.mp4',userAgent:null,episodeCoordinates:{user_id:'owner',source_id:'source',episode_id:'episode',variant_id:'parent',...coordinates}};
 return {calls,run:()=>ctx.loadNativeEpisodeAccessProof(options)};
}
test('exact cached TS profile avoids a provider connection',async()=>{const f=await fixture({cached:profile()});assert.equal((await f.run()).fileSizeBytes,100000);assert.ok(!f.calls.some(x=>x[0]==='probe'));assert.ok(f.calls.some(x=>x[1]==='external_id'&&x[2]==='episode'));});
test('fresh exact episode probe closes before proof is accepted and saved',async()=>{const f=await fixture();assert.equal((await f.run()).fileSizeBytes,100000);assert.deepEqual(f.calls.filter(x=>['claim','probe','save','release'].includes(x[0])).map(x=>x[0]),['claim','probe','save','release']);const saved=f.calls.find(x=>x[0]==='save')[1];assert.equal(saved.itemType,'episode');assert.equal(saved.variantId,'parent');});
test('mismatched episode ownership never opens the provider',async()=>{for(const coordinates of [{user_id:'other'},{source_id:'other'},{episode_id:'other'}]){const f=await fixture({coordinates});await assert.rejects(f.run(),e=>e.status===409);assert.equal(f.calls.length,0);}});
test('busy lease, missing drain, timeout and invalid profile cannot grant native access',async()=>{for(const opts of [{busy:true},{drained:false},{timeout:true},{valid:false}]){const f=await fixture(opts);await assert.rejects(f.run());assert.ok(!f.calls.some(x=>x[0]==='save'));if(opts.timeout||opts.drained===false)assert.ok(!f.calls.some(x=>x[0]==='release'));}});
test('stale profile is refreshed and client profile is not used',async()=>{const f=await fixture({cached:{...profile(),probedAt:'2001-01-01'}});await f.run();assert.equal(f.calls.filter(x=>x[0]==='probe').length,1);assert.equal(f.calls.find(x=>x[0]==='probe')[1].url,'https://owned.test/exact.mp4');assert.ok(!code.includes('requestHint'));});

test("normalized persisted MP4 family reuses the exact profile without probing",async()=>{const f=await fixture({cached:{...profile(),container:"movmp4m4a3gp3g2mj2",probeSource:"gatewayprobe"}});assert.equal((await f.run()).fileSizeBytes,100000);assert.ok(!f.calls.some(x=>x[0]==="probe"));});
