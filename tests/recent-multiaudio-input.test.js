'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { SAMPLE_BYTES:N, RECENT_TTL_MS } = require('../services/media-gateway/src/recent-resume-samples');
const size=64*N, target='b'.repeat(64);
const binding=privateResumeBinding({ownerKey:'a'.repeat(64),sourceUrl:'https://fixture.invalid/a',sourceId:'one',sourceRevision:'1',fileSizeBytes:size,profile:'three tracks'});
const observed=()=>({fileSizeBytes:size,effectiveUrlIdentitySha256:target,
    samples:[0,8*N,16*N,24*N].map((start,i)=>({start,payload:Buffer.alloc(N,i+1)}))});
const capture=(cache)=>cache.captureInput({binding,observed:observed(),inputWindows:[{start:0,payload:Buffer.alloc(4*N,3)}]});

test('multi-audio input can be reused only after fresh proof; never supplies a HLS window',()=>{
    const cache=new PrivateResumeHlsCache({recentRevalidation:true});
    assert.equal(capture(cache),true); assert.equal(cache.hasCandidate(binding,10),false);
    assert.equal(cache.revalidationPlan(binding,10),null);
    assert.equal(cache.inputRevalidationPlan(binding).ranges.length,4);
    const lease=cache.acquireInput(binding,observed());
    assert.equal(lease.inputSnapshot().windows[0].payload.length,4*N);
    assert.throws(()=>lease.playlist(),/INPUT_ONLY/);
    const copy=lease.inputSnapshot();copy.windows[0].payload.fill(0);
    assert.equal(lease.inputSnapshot().windows[0].payload[0],3);
    assert.equal(cache.publicStatus().inputHits,1);assert.equal(cache.publicStatus().sampledHits,0);
    cache.revokeOwner(binding.ownerKey);assert.throws(()=>lease.inputSnapshot(),/REVOKED/);lease.release();
    assert.equal(cache.publicStatus().bytes,0);
});
test('input cache retains owner/profile/source isolation and expires at the existing short TTL',()=>{
    let now=0;const cache=new PrivateResumeHlsCache({recentRevalidation:true,now:()=>now});capture(cache);
    for(const key of ['ownerKey','profileHash','sourceUrlHash'])
        assert.equal(cache.inputRevalidationPlan({...binding,[key]:'c'.repeat(64)}),null);
    now=RECENT_TTL_MS;assert.equal(cache.inputRevalidationPlan(binding),null);assert.equal(cache.publicStatus().bytes,0);
});
test('all four samples, exact size and resolved target remain required',()=>{
    for(const alter of [o=>null,o=>({...o,fileSizeBytes:size+1}),o=>({...o,effectiveUrlIdentitySha256:'c'.repeat(64)}),
        o=>{o.samples[2].payload[9]++;return o;}]){
        const cache=new PrivateResumeHlsCache({recentRevalidation:true});capture(cache);
        assert.equal(cache.acquireInput(binding,alter(observed())),null);assert.equal(cache.publicStatus().bytes,0);
    }
});
test('no second memory budget, unbounded capture, or admission without header',()=>{
    assert.equal(capture(new PrivateResumeHlsCache()),false);
    const cache=new PrivateResumeHlsCache({recentRevalidation:true,maxBytes:4*N,perFileBytes:3*N});
    assert.equal(capture(cache),false);assert.equal(cache.publicStatus().reservedBytes,0);
    const bounded=new PrivateResumeHlsCache({recentRevalidation:true,maxBytes:16*N,perFileBytes:4*N});
    assert.equal(capture(bounded),true);assert.equal(bounded.publicStatus().bytes,4*N);
    assert.equal(bounded.captureInput({binding,observed:observed(),inputWindows:[{start:N,payload:Buffer.alloc(N)}]}),false);
    assert.equal(bounded.publicStatus().bytes,4*N);
});

const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const seedSource=source.slice(source.indexOf('async function trySeedRecentRetainedInput('),source.indexOf('\nasync function capturePrivateResumeWindow('));
for(const hit of [true,false]) test(`multi-audio input ${hit?'hit':'miss'} preserves ordinary output and restores indexed input`,async()=>{
    const calls=[],session={seekOffset:100,startupTimings:{},multiAudioHls:{enabled:true,audioRenditions:[1,2,3]}};
    const topology=JSON.stringify(session.multiAudioHls);
    const run=vm.runInNewContext('('+seedSource+')',{
        Date,RECENT_MULTI_INPUT_MAX_BYTES:64*1024*1024,privateResumeRetainedInputBinding:()=>binding,privateResumeHlsBindingForSession:()=>null,
        multiAudioHlsEnabled:s=>s.multiAudioHls?.enabled===true,
        privateResumeHlsCache:{inputRevalidationPlan:()=>({}),acquireInput:()=>{calls.push('acquire');return hit?{
            inputSnapshot:()=>({windows:[]}),release:()=>calls.push('release')}:null;}},
        revalidateRecentResumeSession:async()=>{calls.push('fresh-drained');return observed();},
        applyFiniteMkvSeekProviderIdentity:()=>calls.push('identity'),
        prepareFiniteMkvSeekBroker:async()=>{calls.push('prepare');return{seedRecentInput:()=>{calls.push('seed');return N;}};},
        abortedVodInputPumpError:()=>Error('aborted')});
    assert.equal(await run(session),hit);
    assert.deepEqual(calls.slice(0,4),['fresh-drained','identity','prepare','acquire']);
    assert.equal(calls.includes('seed'),hit);assert.equal(calls.includes('release'),hit);
    assert.equal(session.privateResumeLease,undefined);assert.equal(session.startupPolicy,undefined);
    assert.equal(JSON.stringify(session.multiAudioHls),topology);
});
test('cancelled validation never seeds or acquires an input lease',async()=>{
    const signal={aborted:true};
    const run=vm.runInNewContext('('+seedSource+')',{
        Date,RECENT_MULTI_INPUT_MAX_BYTES:64*1024*1024,privateResumeRetainedInputBinding:()=>binding,privateResumeHlsBindingForSession:()=>null,
        privateResumeHlsCache:{inputRevalidationPlan:()=>({}),acquireInput:()=>assert.fail('acquire')},
        revalidateRecentResumeSession:async()=>observed(),prepareFiniteMkvSeekBroker:()=>assert.fail('prepare'),
        abortedVodInputPumpError:()=>Error('aborted')});
    await assert.rejects(run({seekOffset:100,startupTimings:{}},signal),/aborted/);
});

test('input-only body uses the configured per-file allowance while HLS defaults stay at eight MiB',()=>{
    const {captureInputWindows}=require('../services/media-gateway/src/recent-resume-samples');
    const MiB=1024*1024, largeSize=100*MiB;
    const chunks=[{start:0,payload:Buffer.alloc(8*MiB,1)},{start:30*MiB,payload:Buffer.alloc(16*MiB,2)}];
    assert.equal(captureInputWindows(chunks,largeSize).reduce((n,w)=>n+w.payload.length,0),8*MiB);
    assert.deepEqual(captureInputWindows(chunks,largeSize,65*MiB),[]);
    const largeBinding={...binding,fileSizeBytes:largeSize};
    const cache=new PrivateResumeHlsCache({recentRevalidation:true,maxBytes:64*MiB,perFileBytes:24*MiB});
    const identity={...observed(),fileSizeBytes:largeSize};
    assert.equal(cache.captureInput({binding:largeBinding,observed:identity,inputWindows:chunks}),true);
    assert.equal(cache.publicStatus().bytes,24*MiB);assert.equal(cache.publicStatus().reservedBytes,0);
    const lease=cache.acquireInput(largeBinding,identity);
    assert.equal(lease.inputSnapshot().windows.reduce((n,w)=>n+w.payload.length,0),24*MiB);
    lease.release();cache.revokeOwner(binding.ownerKey);assert.equal(cache.publicStatus().bytes,0);
});

test('partial subtitle input retains the full ordinary plan and selected tracks in its private binding',()=>{
    const start=source.indexOf('function privateResumeRetainedInputBinding('),end=source.indexOf('\nasync function trySeedRecentRetainedInput',start);
    const run=vm.runInNewContext('('+source.slice(start,end)+')',{
        canUsePrivateResumeCache:()=>true,canUseRecentResumeSamples:()=>true,
        privateResumeFormat:s=>s.format,multiAudioHlsEnabled:s=>s.multiAudioHls?.enabled===true,
        exactSubtitleHlsEnabled:s=>s.exactSubtitleHls?.enabled===true,
        selectedAudioTrackForSession:s=>s.audio,audioRenditionsForSession:s=>s.multiAudioHls.tracks,
        exactSubtitleRenditionsForSession:s=>s.exactSubtitleHls.renditions,
        asRecord:x=>x||{},privateResumeBinding,fileSizeBytesForSession:s=>s.size,
        VIDEO_ENCODER_CONFIG:{backend:'vaapi'},
    });
    const session={ownerKey:'a'.repeat(64),sourceUrl:'https://fixture.invalid/a',size,format:'mkv',
        playbackIdentity:{sourceId:'one',sourceRevision:'1'},audio:{index:1,codec:'aac'},
        exactSubtitleHls:{enabled:true,cacheEligible:false,sourceTrackCount:21,
            renditions:Array.from({length:8},(_,i)=>({streamIndex:i+2,language:'en'}))}};
    const before=JSON.stringify(session),a=run(session);
    assert.ok(a);assert.equal(JSON.stringify(session),before);
    for(const change of [{subtitleStreamIndex:12},{audio:{index:3,codec:'aac'}},
        {exactSubtitleHls:{...session.exactSubtitleHls,sourceTrackCount:22}},
        {playbackIdentity:{sourceId:'one',sourceRevision:'2'}}])
        assert.notEqual(run({...session,...change}).profileHash,a.profileHash);
    for(const change of [{format:'mp4'},{size:null},{audio:null},{completeHlsCacheLease:{}},
        {exactSubtitleHls:{...session.exactSubtitleHls,enabled:false}}])
        assert.equal(run({...session,...change}),null);
    assert.ok(run({...session,exactSubtitleHls:{...session.exactSubtitleHls,cacheEligible:true}}));
});

test('a usable HLS window keeps priority over subtitle input fallback without a second validation',async()=>{
    const run=vm.runInNewContext('('+seedSource+')',{
        privateResumeRetainedInputBinding:()=>binding,privateResumeHlsBindingForSession:()=>binding,
        privateResumeHlsCache:{hasCandidate:()=>true,inputRevalidationPlan:()=>assert.fail('extra-validation')}});
    assert.equal(await run({seekOffset:10}),false);
});

const hlsPlaylist='#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'+Array.from({length:20},(_,i)=>`#EXTINF:4,\nsegment-${i}.ts\n`).join('');
const fallbackArgs=()=>({binding,inputBinding:{...binding,profileHash:'d'.repeat(64)},observed:observed(),
    inputWindows:[{start:0,payload:Buffer.alloc(4*N,3)}],position:10,actualStartOffset:0,
    playlist:hlsPlaylist,readAsset:async()=>Buffer.alloc(188,0x47)});
test('subtitle input fallback preserves HLS preference and refuses a sliding playlist clock',async()=>{
    const cache=new PrivateResumeHlsCache({recentRevalidation:true});
    const args=fallbackArgs();assert.equal(await cache.captureWithInputFallback(args),true);
    assert.equal(cache.hasCandidate(binding,10),true);assert.equal(cache.publicStatus().inputStores,0);
    cache.revokeOwner(binding.ownerKey);
    args.playlist=args.playlist.replace('#EXTM3U','#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:78');
    assert.equal(await cache.captureWithInputFallback(args),true);
    assert.equal(cache.hasCandidate(binding,10),false);
    assert.equal(cache.publicStatus().lastCaptureRejection,'sliding-playlist-unbound-clock');
    assert.equal(cache.inputRevalidationPlan(args.inputBinding).ranges.length,4);
    const lease=cache.acquireInput(args.inputBinding,observed());
    assert.throws(()=>lease.playlist(),/INPUT_ONLY/);lease.release();
});
test('subtitle input fallback cannot repopulate a revoked owner or cross a source binding',async()=>{
    const cache=new PrivateResumeHlsCache({recentRevalidation:true});
    const args=fallbackArgs();args.readAsset=async()=>{cache.revokeOwner(binding.ownerKey);return null;};
    assert.equal(await cache.captureWithInputFallback(args),false);
    assert.equal(cache.publicStatus().entries,0);assert.equal(cache.publicStatus().reservedBytes,0);
    for(const k of ['ownerKey','sourceUrlHash','fileSizeBytes']){
        const changed=fallbackArgs();changed.readAsset=async()=>null;
        changed.inputBinding={...changed.inputBinding,[k]:k==='fileSizeBytes'?size+1:'e'.repeat(64)};
        assert.equal(await cache.captureWithInputFallback(changed),false);
    }
    assert.equal(cache.publicStatus().entries,0);
});
