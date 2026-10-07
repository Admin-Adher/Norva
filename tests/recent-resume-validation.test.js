'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SAMPLE_BYTES: N, RECENT_TTL_MS, sampleProof, samplesMatch, captureSamples } = require('../services/media-gateway/src/recent-resume-samples');
const { validateRecentResume } = require('../services/media-gateway/src/recent-resume-validation');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const size = 100*N, target = 'b'.repeat(64);
const samples = () => [0, 20*N, 40*N, 60*N].map((start, i) => ({ start, payload: Buffer.alloc(N, i+1) }));
const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://fixture.invalid/movie',
    sourceId: 'source', sourceRevision: '1', fileSizeBytes: size, profile: 'audio=1;subtitles=2' });
const observed = () => ({ fileSizeBytes: size, effectiveUrlIdentitySha256: target, samples: samples() });
const capture = (cache, more = {}) => cache.capture({ binding, observed: observed(), position: 10, actualStartOffset: 0,
    playlist: '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' + Array.from({ length: 20 }, (_,i) => `#EXTINF:4,\nseg-${i}.ts\n`).join(''),
    readAsset: async () => Buffer.alloc(188, 0x47), ...more });
test('sample proof is explicitly partial; no fabricated strong ETag or whole-file hash', () => {
    const proof = sampleProof(samples(), size, target);
    assert.equal(proof.kind, 'sampled-recent-v1'); assert.equal(proof.validator, undefined);
    assert.equal(samplesMatch(proof, samples(), size, target), true);
    assert.equal(JSON.stringify(proof).includes('payload'), false);
    const changed = samples(); changed[2].payload[4]++;
    assert.equal(samplesMatch(proof, changed, size, target), false);
    assert.equal(samplesMatch(proof, samples(), size+1, target), false);
    assert.equal(samplesMatch(proof, samples(), size, 'c'.repeat(64)), false);
});
for (const malformed of ['missing', 'overlap', 'length', 'header', 'bounds', 'order']) test(`reject ${malformed} samples`, () => {
    const list = samples();
    if (malformed === 'missing') list.pop();
    if (malformed === 'overlap') list[1].start = N-1;
    if (malformed === 'length') list[1].payload = Buffer.alloc(N-1);
    if (malformed === 'header') list[0].start = 1;
    if (malformed === 'bounds') list[3].start = size;
    if (malformed === 'order') list.reverse();
    assert.equal(sampleProof(list, size, target), null);
});
test('capture retains only detached bounded samples and requires header and body', () => {
    const entries = [{ start: 0, payload: Buffer.alloc(N, 1) }, { start: 20*N, payload: Buffer.alloc(8*N, 2) }];
    const snapshot = captureSamples(entries);
    assert.equal(snapshot.length, 4); assert.equal(snapshot.reduce((sum,s) => sum+s.payload.length, 0), 4*N);
    entries[1].payload.fill(9); assert.equal(snapshot[1].payload[0], 2);
    assert.equal(captureSamples(entries.slice(1)), null);
    assert.equal(captureSamples(entries.slice(0,1)), null);
});
test('recent mode is opt-in; exact private binding, short TTL and revocation apply', async () => {
    assert.equal(await capture(new PrivateResumeHlsCache()), false);
    let now = 100;
    const cache = new PrivateResumeHlsCache({ recentRevalidation: true, now: () => now });
    assert.equal(await capture(cache), true);
    const plan = cache.revalidationPlan(binding, 10);
    assert.equal(plan.ranges.length, 4); assert.equal(plan.ranges[0].digest, undefined);
    assert.equal(plan.target, target);
    for (const other of [{ ...binding, ownerKey:'c'.repeat(64) }, { ...binding, profileHash:'d'.repeat(64) },
        { ...binding, sourceUrlHash:'e'.repeat(64) }]) assert.equal(cache.hasCandidate(other,10), false);
    const lease = cache.acquire(binding, 10, observed());
    assert.equal(lease.validationMode, 'sampled-recent-v1');
    assert.equal(cache.publicStatus().sampledHits, 1);
    cache.revokeOwner(binding.ownerKey); assert.throws(() => lease.playlist(), /REVOKED/); lease.release();
    assert.equal(await capture(cache), true); now += RECENT_TTL_MS;
    assert.equal(cache.hasCandidate(binding,10), false);
});
test('mismatch or failed validation discards the cached window', async () => {
    for (const current of [null, { ...observed(), samples: [] }, { ...observed(), effectiveUrlIdentitySha256:'f'.repeat(64) }]) {
        const cache = new PrivateResumeHlsCache({ recentRevalidation: true }); await capture(cache);
        assert.equal(cache.acquire(binding, 10, current), null); assert.equal(cache.publicStatus().entries, 0);
    }
});
test('four sequential fresh reads and drain precede successful return', async () => {
    let active=0, maxActive=0, requests=0, closed=false;
    const plan = { kind:'sampled-recent-v1', ranges:samples().map(s => ({ start:s.start, length:N })) };
    const result = await validateRecentResume({ plan,
        createBroker: async () => ({ inputUrl:'http://fixture.invalid', close:async () => { assert.equal(active,0); closed=true; } }),
        fetchImpl: async (_,opts) => { requests++; active++; maxActive=Math.max(maxActive,active);
            assert.match(opts.headers.Range,/^bytes=\d+-\d+$/);
            return { status:206, arrayBuffer:async () => { active--; return Buffer.alloc(N); } }; } });
    assert.equal(result.length,4); assert.equal(requests,4); assert.equal(maxActive,1); assert.equal(closed,true);
});
test('timeout aborts the current read, drains, and never retries or starts another range', async () => {
    let requests=0, closed=false, active=false;
    const result=await validateRecentResume({ plan:{ kind:'sampled-recent-v1', ranges:samples().map(s => ({ start:s.start,length:N })) },budgetMs:10,
        createBroker:async () => ({ inputUrl:'http://fixture.invalid', close:async () => { assert.equal(active,false); closed=true; } }),
        fetchImpl:async (_,opts) => { requests++; active=true; return new Promise((_,reject) => {
            opts.signal.addEventListener('abort',() => { active=false; reject(Error('aborted')); },{once:true}); }); } });
    assert.equal(result,null); assert.equal(requests,1); assert.equal(closed,true);
});
test('already cancelled request opens no provider broker', async () => {
    const controller=new AbortController(); controller.abort();
    assert.equal(await validateRecentResume({ plan:{kind:'sampled-recent-v1',ranges:samples().map(s=>({start:s.start,length:N}))},
        signal:controller.signal,createBroker:async()=>{throw Error('must not open');} }),null);
});

for (const rejectAt of [1, 2, 0]) test(`identity rejection stops remaining fresh reads and drains: ${rejectAt || 'no rejection'}`, async () => {
    let requests=0, active=false, closed=false, rejected=0;
    const result=await validateRecentResume({
        plan:{kind:'sampled-recent-v1',target,ranges:samples().map(s=>({start:s.start,length:N}))},
        acceptIdentity:()=>{assert.equal(active,false);return !rejectAt || requests<rejectAt;},
        onIdentityRejected:()=>{rejected++;},
        createBroker:async()=>({inputUrl:'http://fixture.invalid',close:async()=>{assert.equal(active,false);closed=true;}}),
        fetchImpl:async()=>{assert.equal(active,false);active=true;requests++;
            return {status:206,arrayBuffer:async()=>{active=false;return Buffer.alloc(N);}};}
    });
    assert.equal(requests,rejectAt || 4);assert.equal(closed,true);
    assert.equal(rejected,rejectAt?1:0);
    if(rejectAt)assert.equal(result,null);else assert.equal(result.length,4);
});

test('Gateway checks the fresh target and rejects without publishing partial proof', async()=>{
    const fs=require('node:fs'),vm=require('node:vm');
    const source=fs.readFileSync(require('node:path').join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=source.indexOf('function recentDeliveryRouteKey('),end=source.indexOf('\nasync function tryStartPrivateResumeWindow',start);
    for(const same of [false,true]){
        const session={startupTimings:{}}, calls=[];
        const run=vm.runInNewContext('(()=>{'+source.slice(start,end)+';return revalidateRecentResumeSession;})()',{
            AbortController,closeFiniteMkvSeekBroker:async()=>calls.push('old-drained'),
            closePreopenedBoundedMkvInput:async()=>{},fileSizeBytesForSession:()=>size,
            FFMPEG_USER_AGENT:'fixture',pinnedProxyAgentFactoryForRoute:()=>null,providerNodeRouteForSession:()=>null,
            PROVIDER_SLOT_RELEASE_DELAY_MS:0,
            compareRecentResumeTargetParts:()=>null,
            createStrictLidBroker:async opts=>{opts.onProviderIdentity({effectiveUrlIdentitySha256:same?target:'c'.repeat(64)});return {};},
            validateRecentResume:async opts=>{await opts.createBroker();
                if(!opts.acceptIdentity()){opts.onIdentityRejected();return null;}
                return samples();},
        });
        const result=await run(session,{target});
        assert.deepEqual(calls,['old-drained']);
        assert.equal(session.recentResumeValidationPromise,null);
        if(same){assert.equal(result.samples.length,4);assert.equal(session.startupTimings.recentResumeValidationOutcome,undefined);}
        else{assert.equal(result,null);assert.equal(session.startupTimings.recentResumeValidationOutcome,'target-changed');}
    }
});

test('target diagnostics expose only component equality and never authorize changed targets',()=>{
    const {recentResumeTargetParts:parts,compareRecentResumeTargetParts:compare}=require('../services/media-gateway/src/recent-resume-validation');
    const a=parts('https://user:secret@fixture.invalid/token-a/file?sign=secret-one');
    const b=parts('https://user:secret@fixture.invalid/token-b/file?sign=secret-two');
    assert.deepEqual(compare(a,b),{protocol:true,host:true,path:false,queryKeys:true});
    assert.deepEqual(compare(a,parts('https://fixture.invalid/token-a/file?sign=rotated')),
        {protocol:true,host:true,path:true,queryKeys:true});
    assert.equal(compare(a,null),null);assert.equal(parts('file:///private'),null);
    assert.ok(Object.values(a).every(v=>/^[a-f0-9]{64}$/.test(v)));
    assert.equal(JSON.stringify(a).includes('secret'),false);
    assert.equal(samplesMatch(sampleProof(samples(),size,target),samples(),size,'c'.repeat(64)),false);
});

for (const hit of [false,true]) test(`Gateway recreates indexed input after sampled validation: ${hit ? 'hit' : 'miss'}`, async () => {
    const fs=require('node:fs'),vm=require('node:vm');
    const source=fs.readFileSync(require('node:path').join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=source.indexOf('async function tryStartPrivateResumeWindow('),end=source.indexOf('\nfunction usesFiniteMkvSeekBroker',start);
    const calls=[],session={seekOffset:20,startupTimings:{}};
    const run=vm.runInNewContext('('+source.slice(start,end)+')',{
        AbortController,Date,Error,Number,
        privateResumeHlsBindingForSession:()=>binding,privateResumeFormat:()=> 'mkv',canUseRecentResumeSamples:()=>true,
        privateResumeHlsCache:{hasCandidate:()=>true,revalidationPlan:()=>({kind:'sampled-recent-v1'}),
            acquire:()=>{calls.push('acquire');return hit?{start:10,end:70,aheadSeconds:50,
                inputSnapshot:()=>({windows:[]}),validationMode:'sampled-recent-v1'}:null;}},
        revalidateRecentResumeSession:async()=>{calls.push('validation-drained');return observed();},
        applyFiniteMkvSeekProviderIdentity:()=>{},
        prepareFiniteMkvSeekBroker:async()=>{calls.push('indexed-input');session.finiteMkvSeekBroker={
            seedRecentInput:()=>{calls.push('seed');return 100;}};return session.finiteMkvSeekBroker;},
        startSessionWithProviderRetry:async()=>{calls.push('encoder');return true;},
        observeSessionStartOffset:async()=>{},abortedVodInputPumpError:()=>Error('aborted'),
    });
    assert.equal(await run(session),hit);
    assert.deepEqual(calls.slice(0,3),['validation-drained','indexed-input','acquire']);
    assert.equal(calls.includes('encoder'),hit);
    assert.equal(calls.includes('seed'),hit);
    if(hit) assert.ok(calls.indexOf('acquire')<calls.indexOf('seed') && calls.indexOf('seed')<calls.indexOf('encoder'));
    if(hit){await session.privateResumeContinuationPromise;assert.equal(session.privateResumeContinuationReady,true);}
});

test('retained input is bounded, detached, deduplicated and only exposed by a freshly validated lease', async () => {
    const {captureInputWindows} = require('../services/media-gateway/src/recent-resume-samples');
    const original = [{start:0,payload:Buffer.alloc(4*N,1)}, {start:2*N,payload:Buffer.alloc(4*N,2)}];
    const windows = captureInputWindows(original,size,5*N);
    assert.equal(windows.reduce((n,w)=>n+w.payload.length,0),5*N);
    assert.deepEqual(windows.map(w=>w.start),[0,4*N]);
    original[0].payload.fill(7); assert.equal(windows[0].payload[0],1);
    const cache = new PrivateResumeHlsCache({recentRevalidation:true});
    await capture(cache,{inputWindows:windows});
    assert.ok(cache.publicStatus().bytes > 5*N);
    const lease = cache.acquire(binding,10,observed());
    const copy = lease.inputSnapshot(); assert.equal(copy.target,target);
    assert.equal(copy.windows[0].payload[0],1); copy.windows[0].payload.fill(8);
    assert.equal(lease.inputSnapshot().windows[0].payload[0],1);
    cache.revokeOwner(binding.ownerKey);
    assert.throws(()=>lease.inputSnapshot(),/REVOKED/);
    assert.equal(cache.publicStatus().bytes,0);
    await capture(cache,{inputWindows:windows});
    const changed=observed();changed.samples[1].payload[0]++;
    assert.equal(cache.acquire(binding,10,changed),null);
    assert.equal(cache.publicStatus().bytes,0);
});

test('retained input never escapes the existing aggregate memory reservation', async () => {
    const cache=new PrivateResumeHlsCache({recentRevalidation:true,maxBytes:8*N,perFileBytes:2*N});
    assert.equal(await capture(cache,{inputWindows:[{start:0,payload:Buffer.alloc(4*N)}]}),false);
    assert.equal(cache.publicStatus().lastCaptureRejection,'reservation-budget');
    assert.equal(cache.publicStatus().bytes,0);assert.equal(cache.publicStatus().reservedBytes,0);
});


test('successful fresh header is handed off after all four reads drain; failures never hand it off', async()=>{
    for(const failAt of [0,2,4]){
        let reads=0,closed=false,handoffs=0;
        const result=await validateRecentResume({plan:{kind:'sampled-recent-v1',ranges:samples().map(s=>({start:s.start,length:N}))},
            createBroker:async()=>({inputUrl:'http://fixture.invalid',close:async()=>{closed=true;}}),
            fetchImpl:async()=>{reads++;if(reads===failAt)throw Error('transfer failed');return{status:206,arrayBuffer:async()=>Buffer.alloc(N,3)};},
            onFreshValidatedHeader:(_,payload)=>{assert.equal(closed,true);assert.equal(reads,4);assert.equal(payload[0],3);handoffs++;}});
        assert.equal(handoffs,failAt?0:1);assert.equal(Boolean(result),!failAt);
    }
});

test('only a matching private cache candidate exposes an opaque delivery hint',async()=>{
    const token=Object.freeze({}),cache=new PrivateResumeHlsCache({recentRevalidation:true});
    assert.equal(await capture(cache,{observed:{...observed(),deliveryTarget:token}}),true);
    assert.equal(cache.revalidationPlan(binding,10).deliveryTarget,token);
    for(const key of ['ownerKey','profileHash','sourceUrlHash','sourceRevision'])
        assert.equal(cache.revalidationPlan({...binding,[key]:'different'},10),null);
    assert.equal(JSON.stringify(cache.publicStatus()).includes('deliveryTarget'),false);
    cache.revokeOwner(binding.ownerKey);assert.equal(cache.revalidationPlan(binding,10),null);
});
