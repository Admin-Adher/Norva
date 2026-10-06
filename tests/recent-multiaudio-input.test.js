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
const seedSource=source.slice(source.indexOf('async function trySeedRecentMultiAudioInput('),source.indexOf('\nasync function capturePrivateResumeWindow('));
for(const hit of [true,false]) test(`multi-audio input ${hit?'hit':'miss'} preserves ordinary output and restores indexed input`,async()=>{
    const calls=[],session={seekOffset:100,startupTimings:{},multiAudioHls:{enabled:true,audioRenditions:[1,2,3]}};
    const topology=JSON.stringify(session.multiAudioHls);
    const run=vm.runInNewContext('('+seedSource+')',{
        Date,privateResumeMultiAudioInputBinding:()=>binding,
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
        Date,privateResumeMultiAudioInputBinding:()=>binding,
        privateResumeHlsCache:{inputRevalidationPlan:()=>({}),acquireInput:()=>assert.fail('acquire')},
        revalidateRecentResumeSession:async()=>observed(),prepareFiniteMkvSeekBroker:()=>assert.fail('prepare'),
        abortedVodInputPumpError:()=>Error('aborted')});
    await assert.rejects(run({seekOffset:100,startupTimings:{}},signal),/aborted/);
});
