'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
const source = fs.readFileSync('supabase/functions/norva-playback/index.ts','utf8').replace(/\r\n/g,'\n');
const receiptHelper = fs.readFileSync('supabase/functions/_shared/playback-receipt-visibility.mjs','utf8').replaceAll('export async function','async function');
const sha = async value => createHash('sha256').update(value).digest('hex');
class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
function between(start,end) { const a=source.indexOf(start),b=source.indexOf(end,a); assert.ok(a>=0&&b>a); return source.slice(a,b); }
async function receipt({ prepared='mp4', current='mp4', sourceChanged=false, hidden=false, aborted=false }={}) {
 let cleaned=0;
 const chain={select(){return this;},eq(){return this;},async maybeSingle(){return {data:hidden?null:{id:'owned'}};}};
 const bindCode=stripTypeScriptTypes(between('  const bindPreparedPlaybackReceipt = async (','\n  if (mode === "direct")'),{mode:'strip'});
 const context={ WeakMap,DOMException,Boolean,String,HttpError,req:{signal:{aborted}},itemType:'movie',episodeCoordinates:null,resolved:{itemCas:{id:'owned'}},userId:'owner',sourceId:'source',itemId:'item',deviceId:null,db:{from(){return chain;}},preparation:null,playbackGeneration:{},parentSeriesId:null,requestedPlaybackHint:{},targetUrlHash:await sha('https://example.invalid/movie/u/p/1.mkv'),preparedPlaybackTargetUrlHash:await sha('https://example.invalid/movie/u/p/1.'+prepared),
 stringOrNull:x=>typeof x==='string'?x:null,recordOrEmpty:x=>x&&typeof x==='object'?x:{},catalogVisibilityEpochHeaders:()=>({'X-Norva-Global-Visibility-Epoch':'1'}),bindCatalogVisibilityEpochShared:async()=>{},adoptActiveCatalogUserVisibilityEpoch:async()=>{if(sourceChanged)throw new HttpError(409,'generation changed');},assertSourceCatalogVisible:async()=>{},resolvePlaybackTarget:async()=>({targetUrl:'https://example.invalid/movie/u/p/1.'+current}),sha256Hex:sha };
 const bind=vm.runInNewContext(`(()=>{${receiptHelper}\n${bindCode}\nreturn bindPreparedPlaybackReceipt;})()`,context);
 try { await bind(async()=>{cleaned++;}); return {ok:true,cleaned}; } catch(error) {return {ok:false,cleaned,status:error.status,name:error.name};}
}
test('the cold corrected file passes the exact final receipt while original admission stays immutable',async()=>{
 assert.deepEqual(await receipt(),{ok:true,cleaned:0});
 assert.deepEqual(await receipt({prepared:'mkv',current:'mkv'}),{ok:true,cleaned:0});
 assert.equal((await receipt({prepared:'mkv',current:'mp4'})).ok,false);
});
test('another target, hidden item, generation change and cancellation still clean up the prepared video',async()=>{
 for(const scenario of [{current:'avi'},{hidden:true},{sourceChanged:true},{aborted:true}]){
  const result=await receipt(scenario);assert.equal(result.ok,false);assert.equal(result.cleaned,1);
 }
});
async function recovery({persisted=true,retryOk=true,mismatch=true}={}) {
 const block=between('  let { response, body: gatewayBody } = await requestGatewaySession(','\n  if (!response.ok) {\n    const gatewayFailureCode');
 let calls=0,persistenceCalls=0,waits=0;
 const original='https://example.invalid/movie/u/p/1.mkv',corrected='https://example.invalid/movie/u/p/1.mp4';
 const originalHash=await sha(original);
 const run=vm.runInNewContext(`(async()=>{let preparedTargetUrlHash=originalTargetUrlHash;${block};return {preparedTargetUrlHash,containerCorrectionRetried,response};})`,{
 HttpError,requestGatewaySession:async(_url,_token,body)=>{calls++;if(calls===1)return {response:{ok:!mismatch,status:mismatch?422:201},body:{preparedTargetUrlHash:'untrusted'}};
 assert.equal(body.sourceUrl,corrected);assert.equal(body.sourceContainerAuthority.sourceUrlSha256,await sha(corrected));
 return {response:{ok:retryOk,status:retryOk?201:502},body:{preparedTargetUrlHash:'untrusted'}};},
 normalizeGatewaySourceContainerMismatch:(_status,_body,hash)=>{assert.equal(hash,originalHash);return mismatch?{declaredContainer:'mkv',observedContainer:'mp4',evidence:{kind:'iso-bmff-ftyp-v1',prefixSha256:'a'.repeat(64)}}:null;},
 persistGatewaySourceContainerMismatch:async(_db,options)=>{persistenceCalls++;assert.equal(options.expectedTargetUrlHash,originalHash);return persisted;},
 gatewayRoute:{url:'http://gateway.invalid',token:'test'},baseGatewayBody:{sourceUrl:original,playbackIdentity:{}},requestSignal:null,originalTargetUrlHash:originalHash,
 playbackSessionId:'session',userId:'owner',db:{},playbackIdentity:{sourceId:'source',itemType:'movie',itemId:'1'},playbackHint:{sourceType:'xtream'},playbackGeneration:{},
 PROVIDER_SLOT_RELEASE_DELAY_MS:1,sleep:async()=>{waits++;},rewriteVodContainerUrl:(url,from,to,type)=>{assert.equal(url,original);assert.equal(from,'mkv');assert.equal(to,'mp4');assert.equal(type,'xtream');return corrected;},
 stringOr:(v,f)=>v||f,playbackHintForObservedContainer:x=>x,gatewayPlaybackHints:()=>({}),stripMkvH264FastStartInternalHints:x=>x,identityForTarget:sha,sha256Hex:sha,targetUrl:original,
 });
 try {return {...await run(),calls,persistenceCalls,waits,originalHash,correctedHash:await sha(corrected)};}catch(e){return {error:e.status,calls,persistenceCalls,waits};}
}
test('only persisted exact correction and successful sequential recovery produce the prepared target hash',async()=>{
 const r=await recovery();assert.equal(r.preparedTargetUrlHash,r.correctedHash);assert.equal(r.calls,2);assert.equal(r.waits,1);assert.equal(r.persistenceCalls,1);
 const failed=await recovery({retryOk:false});assert.equal(failed.preparedTargetUrlHash,failed.originalHash);assert.equal(failed.calls,2);
 const unchanged=await recovery({mismatch:false});assert.equal(unchanged.preparedTargetUrlHash,unchanged.originalHash);assert.equal(unchanged.calls,1);
});
test('failed persistence rejects before a second provider request',async()=>{
 assert.deepEqual(await recovery({persisted:false}),{error:409,calls:1,persistenceCalls:1,waits:0});
});
