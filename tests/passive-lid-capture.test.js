'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const { spawn }=require('node:child_process');
const { passiveTrackLanguageUnknown,passiveProfileEvidenceEligible,passiveProfileFingerprint,passiveCaptureBinding,passiveResourcesAvailable,passiveWindowPlan,createPassiveLidCapture }=require('../services/media-gateway/src/passive-lid-capture');
const { StrictLidCaptureStore }=require('../services/media-gateway/src/strict-lid-capture-store');
const { createStrictLidCapturePipeline }=require('../services/media-gateway/src/strict-lid-capture-pipeline');
const { planStrictSpeechWindow }=require('../services/media-gateway/src/strict-lid-speech-window');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const profile=()=>({ metadataComplete:true,probeSource:'gateway_probe',probedAt:'2026-09-11T20:00:00.000Z',container:'matroska',
    durationSeconds:120,fileSizeBytes:1000000,audioTracks:[{ index:1,codec:'aac',channels:2,default:true }] });
const normalBinding=()=>({ jobId:'12345678-1234-4234-8234-123456789012',userId:'23456789-1234-4234-8234-123456789012',
    profileFingerprint:passiveProfileFingerprint(profile()),sourceUrlHash:'b'.repeat(64),trackIndex:1,
    durationSeconds:120,fileSizeBytes:1000000,windowOrdinal:1,windowCount:6,
    offsetMilliseconds:planStrictSpeechWindow(120,1).anchorOffsetMilliseconds,
    method:'whisper-strict-consensus-v4',modelDigest:'c'.repeat(64),configDigest:'d'.repeat(64),selectionProtocol:1 });
const list=(count=30)=>['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:4','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:EVENT',
    ...Array.from({length:count},(_,i)=>[`#EXTINF:4.000000,`,`segment-${String(i).padStart(5,'0')}.ts`]).flat()].join('\n');
function wav(seconds=20) {
    const b=Buffer.alloc(44+seconds*32000); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
    b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);
    b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;
}
async function fixture(t) {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'norva-passive-proof-')));
    const media=path.join(root,'viewer');await fs.mkdir(media);
    await fs.writeFile(path.join(media,'playlist.m3u8'),list());
    for(let i=0;i<30;i++) await fs.writeFile(path.join(media,`segment-${String(i).padStart(5,'0')}.ts`),Buffer.alloc(188,0x47));
    let now=Date.now();
    const config={root:path.join(root,'buffer'),secret:'private-synthetic-passive-fixture',now:()=>now,
        ...(process.platform==='linux'?{}:{acquireOwnership:async()=>({isHeld:()=>true,close:async()=>{}})})};
    let store=new StrictLidCaptureStore(config);await store.open();
    t.after(async()=>{
        await store.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('norva-passive-proof-'));
        await fs.rm(root,{recursive:true,force:true});
    });
    return { media,get store(){return store;},advance:ms=>{now+=ms;},
        async restart(){await store.close();store=new StrictLidCaptureStore(config);await store.open();},
        source:{root:media,playlistName:'playlist.m3u8',segmentPrefix:'segment',isCurrent:()=>true} };
}

test('passive windows require a complete contiguous local origin timeline; remote/indirect inputs fail closed',()=>{
    const options={startSeconds:7,durationSeconds:20,prefix:'segment'};
    const plan=passiveWindowPlan(list(),options);assert.equal(plan.seekSeconds,3);assert.equal(plan.segments.length,6);
    for(const changed of [list(5),list().replace('MEDIA-SEQUENCE:0','MEDIA-SEQUENCE:5'),
        list().replace('segment-00000.ts','https://example.invalid/a.ts'),list().replace('segment-00000.ts','../a.ts'),
        list().replace('segment-00000.ts','segment-00001.ts'),list()+'\n#EXT-X-DISCONTINUITY',
        list()+'\n#EXT-X-KEY:METHOD=AES-128,URI="secret"',list()+'\n#EXT-X-MAP:URI="init.mp4"',
        list().replace('4.000000,','NaN,'),list().replace('PLAYLIST-TYPE:EVENT','PLAYLIST-TYPE:LIVE')]) {
        assert.equal(passiveWindowPlan(changed,options),null);
    }
});

test('passive profile fingerprint matches the actual Edge protocol-2 payload',async()=>{
    const src=await fs.readFile(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
    const start=src.indexOf('function languageValidationProfilePayload('),end=src.indexOf('\nasync function runLanguageValidationRetryWorker',start);
    // Execute the actual body on the production Node 20 image too. The only
    // TypeScript in this bounded function is these three parameter annotations.
    const original=src.slice(start,end);
    const signature=/^function languageValidationProfilePayload\(\s*profile: JsonRecord,\s*audioTracks: JsonRecord\[\],\s*fileSizeBytes: number,\s*\)/;
    assert.match(original,signature);
    const code=original.replace(signature,'function languageValidationProfilePayload(profile,audioTracks,fileSizeBytes)');
    const actual=require('node:vm').runInNewContext(`(${code})`,{LANGUAGE_VALIDATION_PROTOCOL:2,
        normalizeCodecToken:v=>String(v||'').toLowerCase().replace(/[^a-z0-9.]+/g,''),
        boundedNullableInt:(v,min,max)=>v===null||v===undefined||v===''?null:Math.max(min,Math.min(max,Number.parseInt(String(v),10))),
        stringOr:(v,fallback)=>typeof v==='string'?v:fallback});
    for(const audioTracks of [profile().audioTracks,[{index:3,codec:'E-AC-3',channels:6},{index:1,codec:'AAC',channels:'2',default:true}]]) {
        const p={...profile(),audioTracks};assert.equal(passiveProfileFingerprint(p),hash(actual(p,audioTracks,p.fileSizeBytes)));
    }
});

test('passive resource admission allows idle headroom but rejects startup, stale telemetry and pressure',()=>{
    const at=Date.now(),sample={at,cpuRatio:.1,memoryRatio:.4,hostLoadRatio:.2};
    assert.equal(passiveResourcesAvailable(sample,{viewer:true},at),true);
    for(const activity of [{starting:true},{foreground:true},{benchmark:true}]) assert.equal(passiveResourcesAvailable(sample,activity,at),false);
    for(const bad of [null,{...sample,at:at+1},{...sample,at:at-10001},{...sample,cpuRatio:.5},
        {...sample,memoryRatio:.65},{...sample,hostLoadRatio:.6},{...sample,cpuRatio:NaN}]) assert.equal(passiveResourcesAvailable(bad,{},at),false);
});

test('passive evidence accepts exact Gateway probes without inventing EBML completeness and rejects incomplete inband/hints',()=>{
    const now=Date.parse('2026-09-12T12:00:00Z');
    for(const container of ['mkv','matroska,webm','mp4','mov','mov,mp4,m4a,3gp,3g2,mj2','m4v',
        'avi','ogg','flv','mpg','mpeg','ts','mpegts']) {
        for(const metadataComplete of [true,false,undefined]) {
            const p={...profile(),container,metadataComplete};const before=structuredClone(p);
            assert.equal(passiveProfileEvidenceEligible(p,now),true,container);
            assert.deepEqual(p,before,'observation and protocol identity remain unchanged');
        }
    }
    assert.equal(passiveProfileEvidenceEligible({...profile(),probeSource:'gateway_inband'},now),true);
    for(const change of [{probeSource:'gateway_inband',metadataComplete:false},{probeSource:'request'},
        {probeSource:'provider'},{probeSource:''},{container:'mp4,secret'},{container:'webm'},
        {probedAt:''},{probedAt:new Date(now+300001).toISOString()},{durationSeconds:79},{durationSeconds:86401},
        {fileSizeBytes:null},{audioTracks:[]},{audioTracks:[null]},{audioTracks:[{index:1},{index:1}]}]) {
        assert.equal(passiveProfileEvidenceEligible({...profile(),...change},now),false);
    }
    assert.equal(passiveProfileEvidenceEligible({...profile(),probedAt:new Date(now+300000).toISOString()},now),true);
});

test('passive supported demuxers and probe authority agree with the actual Edge observation predicate',async()=>{
    const src=await fs.readFile(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
    const begin=src.indexOf('function canonicalVodContainer('),end=src.indexOf('\nfunction containerEvidenceKind(',begin);
    const original=src.slice(begin,end);
    assert.match(original,/^function canonicalVodContainer\(value: unknown\): string \| null/);
    const code=original.replace('value: unknown): string | null','value)');
    const actual=require('node:vm').runInNewContext(`(${code})`,{normalizeCodecToken:v=>String(v||'').toLowerCase().replace(/[^a-z0-9.]+/g,'')});
    for(const container of ['mkv','matroska','matroskawebm','mp4','mov','movmp4m4a3gp3g2mj2','m4v','avi',
        'ogg','flv','mpg','mpeg','ts','mpegts','webm','hls','m3u8','mp4,unknown','unknown','']) {
        assert.equal(passiveProfileEvidenceEligible({...profile(),container,metadataComplete:false}),!!actual(container));
    }
    const exact=src.slice(src.indexOf('function exactLanguageValidationProfileFromSnapshot('),src.indexOf('\nasync function loadExactEpisodeLanguageValidationProfile('));
    const authority=exact.match(/const exactGatewayProfile = ([\s\S]*?);/);
    assert.ok(authority);
    const edgeAuthority=require('node:vm').runInNewContext(`(profile,probeSource)=>(${authority[1]})`);
    for(const probeSource of ['gatewayprobe','gatewayinband','request','provider','']) {
        for(const metadataComplete of [true,false,undefined]) {
            const p={...profile(),probeSource,metadataComplete};
            assert.equal(passiveProfileEvidenceEligible(p),edgeAuthority(p,probeSource));
        }
    }
});

test('passive track eligibility matches the actual Edge declared-language contract, including aliases and nonlanguage markers',async()=>{
    const src=await fs.readFile(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
    const start=src.indexOf('function normalizeIsoLang('),end=src.indexOf('\ntype BasicLidEvidence',start);
    assert.ok(start>=0&&end>start);
    const original=src.slice(start,end);
    const code=original.replace('value: string | null): string | null','value)')
        .replace('const map: Record<string, string>','const map');
    const normalize=require('node:vm').runInNewContext(`(${code.trim()})`);
    const aliases=[...original.matchAll(/\b([a-z]{2,3}): "[a-z]{2}"/g)].map(m=>m[1]);
    assert.ok(aliases.length>70,'exercise the real alias map, not a tiny duplicated fixture');
    const cases=[null,undefined,'','unknown','un','und','mis','mul','zxx','nar','qaa','xyz','engl','français',
        '0','1en','fr/en',...aliases,...Array.from({length:676},(_,i)=>String.fromCharCode(97+Math.floor(i/26),97+i%26))];
    for(const value of cases) {
        for(const tag of typeof value==='string'?[value,` ${value.toUpperCase()} `,`${value}-US`,`${value}_Latn`]:[value]) {
            assert.equal(passiveTrackLanguageUnknown(tag),normalize(tag)===null,`eligibility differs for ${JSON.stringify(tag)}`);
        }
    }
});

test('actual Gateway adapter accepts only exact ready origin playback and never invents an audio mapping',async()=>{
    const src=await fs.readFile(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start=src.indexOf('function passiveLidSessionSources('),end=src.indexOf('\nasync function collectPassiveLidWindow',start);
    assert.ok(start>=0&&end>start);
    const sessions=new Map();const output=path.resolve(os.tmpdir(),'passive-adapter-output');
    let allowSource=true;let scope;
    const {sources,resolve}=require('node:vm').runInNewContext(`(()=>{${src.slice(start,end)};return{sources:passiveLidSessionSources,resolve:resolvePassiveLidSource};})()`,{
        path,sessions,OUTPUT_DIR:output,passiveTrackLanguageUnknown,passiveProfileEvidenceEligible,passiveProfileFingerprint,sha256Hex:hash,
        isLiveSession:s=>s.live===true,isWithin:(root,p)=>path.dirname(p)===root,
        controlledLocalPlaylistName:n=>n==='playlist.m3u8',hlsMediaPlaylistTargetsForSession:s=>s.targets,
        enrichmentPilot:{allowsPassiveSource:(...args)=>allowSource&&scope.allowsPassiveSource(...args)},
    });
    const target=normalBinding();const session={id:'synthetic-session',status:'ready',seekOffset:0,actualStartOffset:0,sourceTimestamps:false,
        ownerKey:hash(target.userId),sourceUrl:'https://example.invalid/private/test.mkv',outputDir:path.join(output,'session'),
        codecProfile:profile(),actualMappedAudioStreamIndex:1,targets:[{kind:'single',streamIndex:1,playlistName:'playlist.m3u8'}]};
    const at=Date.now();scope=require('../services/media-gateway/src/enrichment-pilot-admission').createEnrichmentPilotAdmission({
        protocol:1,createdAt:new Date(at).toISOString(),expiresAt:new Date(at+60000).toISOString(),fileKeys:['d'.repeat(64)],
        passiveSources:[{ownerHash:session.ownerKey,sourceUrlHash:hash(session.sourceUrl),
            profileFingerprint:passiveProfileFingerprint(session.codecProfile),fileKey:'d'.repeat(64)}],
    },{mode:'pilot',now:()=>at});
    sessions.set(session.id,session);
    assert.equal(sources(session).length,1);
    for(const lang of ['und','mis','nar','unknown','qaa',' UND_us ']) {
        assert.equal(sources({...session,codecProfile:{...profile(),audioTracks:[{...profile().audioTracks[0],lang}]}}).length,1,
            `unknown ${lang} must remain eligible for already-received audio`);
    }
    for(const lang of ['en','en-US','pt_BR',' ENG ','fre','fil',' hi ']) {
        assert.equal(sources({...session,codecProfile:{...profile(),audioTracks:[{...profile().audioTracks[0],lang}]}}).length,0,
            `declared ${lang} needs no passive audio work`);
    }
    for(const changed of [{status:'starting'},{live:true},{seekOffset:20},{actualStartOffset:20},{sourceTimestamps:true},
        {actualMappedAudioStreamIndex:null},{ownerKey:''},{ownerKey:'f'.repeat(64)},
        {sourceUrl:'https://example.invalid/private/other.mkv'},{codecProfile:{...profile(),durationSeconds:121}},
        {outputDir:output},{codecProfile:{...profile(),metadataComplete:false}},
        {codecProfile:{...profile(),audioTracks:[{...profile().audioTracks[0],lang:'en'}]}}]) assert.equal(sources({...session,...changed}).length,0);
    const binding=passiveCaptureBinding({...target,sourceUrlHash:hash(session.sourceUrl)},session.ownerKey);
    const source=resolve(binding,{sessionId:session.id,playlistName:'playlist.m3u8'});assert.ok(source);assert.equal(source.isCurrent(),true);
    allowSource=false;assert.equal(sources(session).length,0);assert.equal(source.isCurrent(),false);
    assert.equal(resolve(binding,{sessionId:session.id,playlistName:'playlist.m3u8'}),null);allowSource=true;
    assert.equal(resolve({...binding,sourceUrlHash:'f'.repeat(64)},{sessionId:session.id,playlistName:'playlist.m3u8'}),null);
    session.actualMappedAudioStreamIndex=3;assert.equal(source.isCurrent(),false);
    session.actualMappedAudioStreamIndex=1;
    for(const [probeSource,metadataComplete,expected] of [['gateway_probe',false,1],['gateway_inband',false,0],
        ['gateway_inband',true,1],['request',true,0]]) {
        session.codecProfile={...profile(),container:'ts',probeSource,metadataComplete};
        scope=require('../services/media-gateway/src/enrichment-pilot-admission').createEnrichmentPilotAdmission({
            protocol:1,createdAt:new Date(at).toISOString(),expiresAt:new Date(at+60000).toISOString(),fileKeys:['d'.repeat(64)],
            passiveSources:[{ownerHash:session.ownerKey,sourceUrlHash:hash(session.sourceUrl),
                profileFingerprint:passiveProfileFingerprint(session.codecProfile),fileKey:'d'.repeat(64)}],
        },{mode:'pilot',now:()=>at});
        assert.equal(sources(session).length,expected,`${probeSource} completeness=${metadataComplete}`);
    }
});

test('closed local segments become private audio, survive restart, and are adopted without extending expiry or opening a provider',async t=>{
    const f=await fixture(t);const target=normalBinding();const passive=passiveCaptureBinding(target,hash(target.userId));
    let extractions=0;
    let adapter=createPassiveLidCapture({store:f.store,resolveSource:()=>f.source,resourcesAvailable:()=>true,
        extract:async({input,output})=>{extractions++;assert.equal((await fs.stat(input)).size,5*188);await fs.writeFile(output,wav());return{ok:true,processClosed:true};}});
    const captured=await adapter.capture(passive,{});assert.equal(captured.captured,true);assert.equal(extractions,1);
    assert.deepEqual((await fs.readdir(f.store.root)).filter(n=>n.startsWith('compute-')),[]);
    f.advance(60_000);await f.restart();
    adapter=createPassiveLidCapture({store:f.store,resolveSource:()=>{throw Error('no source access on adoption');},resourcesAvailable:()=>false});
    for(const changed of [{userId:crypto.randomUUID()},{profileFingerprint:'e'.repeat(64)},{sourceUrlHash:'e'.repeat(64)},
        {trackIndex:2},{modelDigest:'e'.repeat(64)}]) assert.equal(await adapter.adopt({...target,...changed}),false);
    const pipeline=createStrictLidCapturePipeline({store:f.store,adoptPassive:b=>adapter.adopt(b),claimNetwork:()=>{throw Error('provider forbidden');},
        openBroker:()=>{throw Error('provider forbidden');},extract:()=>{throw Error('provider forbidden');},infer:async p=>hash(await fs.readFile(p))});
    const ready=await pipeline.status(target);assert.equal(ready.captured,true);assert.equal(ready.expiresAt,captured.expiresAt);
    assert.equal(await f.store.get(passive),null);assert.equal(f.store.snapshot().entries,1);
    assert.equal(await pipeline.compute(target,{},null),hash(wav()));assert.equal(extractions,1);
});

test('pressure, missing segments, changed sessions, hard links and an uncertain child cannot start repeated passive work',async t=>{
    const f=await fixture(t);const target=normalBinding();const b=passiveCaptureBinding(target,hash(target.userId));let extractions=0;
    const make=extra=>createPassiveLidCapture({store:f.store,resolveSource:()=>f.source,resourcesAvailable:()=>true,
        extract:async()=>{extractions++;return{ok:false,processClosed:false};},...extra});
    assert.equal((await make({resourcesAvailable:()=>false}).capture(b,{})).captured,false);
    assert.equal((await make({resolveSource:()=>null}).capture(b,{})).captured,false);
    f.source.isCurrent=()=>false;assert.equal((await make().capture(b,{})).captured,false);f.source.isCurrent=()=>true;
    await fs.link(path.join(f.media,'segment-00000.ts'),path.join(f.media,'held.ts'));
    assert.equal((await make().capture(b,{})).captured,false);assert.equal(extractions,0);await fs.unlink(path.join(f.media,'held.ts'));
    const blocked=make();assert.equal((await blocked.capture(b,{})).captured,false);assert.equal(blocked.snapshot().blocked,true);
    assert.equal((await blocked.capture(b,{})).captured,false);assert.equal(extractions,1);assert.equal(f.store.snapshot().entries,0);
    assert.equal((await fs.stat(path.join(f.media,'segment-00000.ts'))).size,188,'playback data untouched');
});

test('a passive snapshot over 16 MiB remains a miss, leaves playback intact and frees its workspace',async t=>{
    const f=await fixture(t);const b=passiveCaptureBinding(normalBinding(),hash(normalBinding().userId));
    const first=path.join(f.media,'segment-00000.ts');const payload=Buffer.alloc(16*1024*1024+1,0x47);
    await fs.writeFile(first,payload);let extracted=false;
    const adapter=createPassiveLidCapture({store:f.store,resolveSource:()=>f.source,resourcesAvailable:()=>true,
        extract:async()=>{extracted=true;throw Error('oversized snapshot must never reach FFmpeg');}});
    assert.equal((await adapter.capture(b,{})).captured,false);assert.equal(extracted,false);
    assert.equal((await fs.stat(first)).size,payload.length);
    const state=f.store.snapshot();assert.equal(state.entries,0);assert.equal(state.bytes,0);
    assert.equal(state.reservations,0);assert.equal(state.computations,0);
    assert.deepEqual((await fs.readdir(f.store.root)).filter(n=>n.startsWith('compute-')),[]);
});

test('native passive FFmpeg extracts a bounded local HLS snapshot with no provider-capable input',
    {skip:process.env.NORVA_CAPTURE_REAL_FFMPEG!=='1'},async t=>{
    const f=await fixture(t);
    await new Promise((resolve,reject)=>{
        const child=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=350:sample_rate=16000:duration=120',
            '-c:a','aac','-f','hls','-hls_time','4','-hls_list_size','0','-hls_playlist_type','event','-hls_flags','temp_file',
            '-hls_segment_filename',path.join(f.media,'segment-%05d.ts'),path.join(f.media,'playlist.m3u8')],{stdio:'ignore'});
        child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('synthetic_hls_failed')));
    });
    const target=normalBinding();const b=passiveCaptureBinding(target,hash(target.userId));
    const adapter=createPassiveLidCapture({store:f.store,resolveSource:()=>f.source,resourcesAvailable:()=>true,bin:'ffmpeg'});
    const result=await adapter.capture(b,{});assert.equal(result.captured,true);
    assert.equal((await f.store.get(b)).wav.length>640000,true);assert.ok(adapter.snapshot().snapshotBytes<=16*1024*1024);
    t.diagnostic(JSON.stringify({syntheticPassive:true,externalProviderRequests:0,...adapter.snapshot()}));
});
