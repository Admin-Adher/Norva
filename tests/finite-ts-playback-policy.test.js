'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { finiteTsStartupPolicy, decodeStartupSegment, verifyFiniteTsStartupSegments, applyFiniteTsAccurateResume } = require('../services/media-gateway/src/finite-ts-startup');
const fixture = () => ({codecProfileSource:'request',playbackIdentity:{itemType:'movie'},playbackHint:{container:'ts'},audioStreamIndex:1,
    codecProfile:{container:'ts',probeSource:'gateway_probe',probedAt:new Date().toISOString(),durationSeconds:5471,
        fileSizeBytes:951409344,videoCodec:'h264',audioTracks:[{index:1,codec:'aac'}]},finiteTsFastInput:true,
    startupTimings:{sustainedMediaProductionRateX:5.662,playlistBufferSeconds:24,playlistSegmentCount:2,playlistPostFirstBufferSeconds:12},
    finiteTsStartupEvidence:{verified:true,segmentCount:2,maxSegmentSeconds:12}});
function clients() {
    const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
    const block=source.slice(source.indexOf('function normalizeGatewayStartupPolicy('),source.indexOf('\nfunction normalizeCodecProfile(',source.indexOf('function normalizeGatewayStartupPolicy(')));
    const code=require('esbuild').transformSync(block+'\nglobalThis.normalize=normalizeGatewayStartupPolicy;',{loader:'ts',format:'iife'}).code;
    const env={recordOrEmpty:v=>v&&typeof v==='object'?v:{},stringOr:(v,f)=>typeof v==='string'?v:f,
        boundedNullableNumber:(v,min,max)=>v==null?null:Math.max(min,Math.min(max,Number(v)))};
    vm.runInNewContext(code,env);
    const browser={window:{},console};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/pages/WatchPage.js'),'utf8'),browser);
    return {edge:env.normalize,watch:Object.create(browser.window.WatchPage.prototype)};
}
test('real TS evidence reaches Edge and browser without the old 96-second fallback',()=>{
    const {edge,watch}=clients();
    for(const pipeline of ['copy','audio-transcode']) {
        const policy=finiteTsStartupPolicy(fixture(),pipeline);
        assert.equal(policy.eligible,true);assert.equal(policy.targetBufferSeconds,12);
        const result=watch.gatewayStartupBufferOptions(edge(policy));
        assert.equal(result.minimumSeconds,12);assert.equal(result.policy.reason,'finite-ts-verified-ready');
    }
});

test('a ready playback response does not wait for catalogue persistence, but sharing still waits for its success', {timeout:2000}, async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
    const start=source.indexOf('  if (sourceId && gateway.codecProfile && !deferGatewayProfilePersistenceForMkvFastStart)');
    const end=source.indexOf('  const responseCodecProfile',start);assert.ok(start>0 && end>start);
    const code='async function respond(){'+source.slice(start,end)+' return "ready";}';
    for(const outcome of [true,false,'error','mkv-cas']) {
        let release,reject,calls=0,shared=0;const queue=[];
        const pending=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
        const env={sourceId:'source',userId:'owner',itemType:'movie',itemId:'file',db:{},
            gateway:{codecProfile:{container:'ts'},codecProfileSource:'request',startupMs:20,audioMode:'transcode'},
            deferGatewayProfilePersistenceForMkvFastStart:outcome==='mkv-cas',
            persistObservedCodecProfile:()=>{calls++;return pending;},
            shareObservedGatewayProfileTracks:async (_db,args)=>{assert.equal(args.codecProfileSource,'request');shared++;},
            runBackground:task=>queue.push(Promise.resolve(task).catch(()=>{}))};
        vm.createContext(env);vm.runInContext(code,env);
        assert.equal(await env.respond(),'ready');assert.equal(shared,0);
        assert.equal(calls,outcome==='mkv-cas'?0:1);
        if(outcome==='error')reject(Error('catalogue unavailable'));else release(outcome===true);
        await Promise.all(queue);assert.equal(shared,outcome===true?1:0);
    }
});

test('actual Gateway playlist adapter admits two complete long segments only after local proof',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8').replace(/\r\n/g,'\n');
    const block=(name,next)=>{
        let start=source.indexOf('function '+name+'('), end=source.indexOf('function '+next+'(',start);
        assert.ok(start>=0 && end>start);
        if(source.slice(start-6,start)==='async ')start-=6;
        return source.slice(start,end).replace(/\s*async\s*$/,'');
    };
    const dir=await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(),'norva-ts-adapter-')));
    let calls=0;
    const context={fs,fsp:fs.promises,path,Date,FINITE_TS_FAST_START_ENABLED:true,FFMPEG_PATH:'/local-only',
        MIN_HLS_STARTUP_SEGMENTS:3,MIN_HLS_STARTUP_BUFFER_SECONDS:10,
        multiAudioHlsEnabled:()=>false,exactSubtitleHlsEnabled:()=>false,
        mappedAudioStreamIndexForSession:()=>1,videoModeForSession:()=> 'copy',
        isWithin:(root,p)=>path.dirname(p)===root,
        abortedVodInputPumpError:()=>Error('aborted'),waitForVodInputRetry:async()=>true,
        verifyFiniteTsStartupSegments:async p=>{
            assert.equal(p.root,dir);assert.deepEqual(Array.from(p.durations),[12,12]);
            assert.deepEqual(Array.from(p.files),['segment-00000.ts','segment-00001.ts']);calls++;
            return {verified:true,segmentCount:2,maxSegmentSeconds:12};
        }};
    vm.createContext(context);
    vm.runInContext(block('hlsMediaPlaylistTargetsForSession','inspectHlsMediaPlaylistArtifact')+
        block('inspectHlsMediaPlaylistArtifact','inspectHlsStartupPlaylist')+
        block('inspectHlsStartupPlaylist','inspectMediaCacheLiveJoinGraph')+
        block('waitForPlaylist','stopSession'),context);
    try{
        const origin=Date.now()-10000, session={...fixture(),finiteTsStartupEvidence:null,outputDir:dir,
            playlistPath:path.join(dir,'playlist.m3u8'),minHlsStartupSegments:2,minHlsStartupBufferSeconds:12,
            hlsCacheProductionStartedAtMs:origin,startupTimings:{}};
        fs.writeFileSync(session.playlistPath,'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:12,\nsegment-00000.ts\n#EXTINF:12,\nsegment-00001.ts\n');
        for(let i=0;i<2;i++){
            const file=path.join(dir,`segment-0000${i}.ts`);fs.writeFileSync(file,Buffer.alloc(188));
            fs.utimesSync(file,new Date(origin+1000+i*3000),new Date(origin+1000+i*3000));
        }
        await context.waitForPlaylist(session,100);
        assert.equal(calls,1);assert.equal(session.startupTimings.finiteTsStartupDecoded,true);
        assert.equal(session.startupTimings.playlistSegmentCount,2);
        const {edge,watch}=clients();
        assert.equal(watch.gatewayStartupBufferOptions(edge(finiteTsStartupPolicy(session,'copy'))).minimumSeconds,12);
        session.finiteTsStartupEvidence=null;
        fs.appendFileSync(session.playlistPath,'#EXT-X-DISCONTINUITY\n');
        await context.waitForPlaylist(session,100);
        assert.equal(calls,1);assert.equal(session.startupTimings.finiteTsStartupDecoded,false);
        assert.equal(finiteTsStartupPolicy(session,'copy').eligible,false);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('medium and marginal TS rates receive a larger measured reserve; slow sources remain protected',()=>{
    const s=fixture();s.startupTimings.sustainedMediaProductionRateX=2.292;
    assert.equal(finiteTsStartupPolicy(s,'copy').targetBufferSeconds,24);
    s.finiteTsStartupEvidence.maxSegmentSeconds=4;s.startupTimings.sustainedMediaProductionRateX=1.6;
    assert.equal(finiteTsStartupPolicy(s,'copy').targetBufferSeconds,24);
    for(const rate of [0,0.54,1.49,NaN,Infinity,21]) {
        s.startupTimings.sustainedMediaProductionRateX=rate;
        assert.equal(finiteTsStartupPolicy(s,'copy').eligible,false);
    }
});
test('missing decode, undersized reserve, bad containers, long GOPs and live sources cannot earn TS startup',()=>{
    for(const change of [s=>{s.finiteTsStartupEvidence.verified=false;},s=>{s.finiteTsStartupEvidence.segmentCount=1;},
        s=>{s.finiteTsStartupEvidence.maxSegmentSeconds=30;},s=>{s.startupTimings.playlistBufferSeconds=8;},
        s=>{s.startupTimings.playlistPostFirstBufferSeconds=2;},s=>{s.playbackIdentity.itemType='live';},
        s=>{s.codecProfile.probeSource='provider';},s=>{s.codecProfile.container='mkv';}]) {
        const s=fixture();change(s);assert.notEqual(finiteTsStartupPolicy(s,'copy')?.eligible,true);
    }
    assert.equal(finiteTsStartupPolicy(fixture(),'video-transcode'),null);
});

test('a verified HD TS resume uses aligned A/V, accurate input seeking and the existing measured VAAPI contract',()=>{
    const s=fixture();s.seekOffset=17;Object.assign(s.codecProfile,{videoWidth:1280,videoHeight:720});
    const before=JSON.stringify(s.codecProfile);
    assert.equal(applyFiniteTsAccurateResume(s,{backend:'vaapi',ready:true}),true);
    assert.equal(s.videoMode,'encode');assert.equal(s.hlsTargetSeconds,2);
    assert.equal(JSON.stringify(s.codecProfile),before);
    s.startupTimings.videoEncoder='vaapi';
    const {edge,watch}=clients();
    const policy=finiteTsStartupPolicy(s,'video-transcode');
    assert.equal(policy.minimumEncodeRateX,2);assert.equal(policy.reason,'vaapi-transcode-ready');
    assert.equal(watch.gatewayStartupBufferOptions(edge(policy)).minimumSeconds,12);
    s.startupTimings.sustainedMediaProductionRateX=1.9;
    assert.equal(finiteTsStartupPolicy(s,'video-transcode').eligible,false);
    const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8').replace(/\r\n/g,'\n');
    const seek=vm.runInNewContext('('+source.slice(source.indexOf('function seekArgsForSession('),source.indexOf('\nfunction usesSourceTimestampedCopySeek(')).trim()+')');
    assert.deepEqual(JSON.parse(JSON.stringify(seek(s,true))),{preInputSeek:[],postInputSeek:['-ss','17']});
    assert.deepEqual(JSON.parse(JSON.stringify(seek({...s,seekOffset:8},true))),{preInputSeek:[],postInputSeek:['-ss','8']});
    assert.deepEqual(JSON.parse(JSON.stringify(seek({...s,seekOffset:31},true))),{preInputSeek:['-ss','16'],postInputSeek:['-ss','15']});
    const audio=vm.runInNewContext('('+source.slice(source.indexOf('function shouldCopyAudio('),source.indexOf('\nfunction ',source.indexOf('function shouldCopyAudio(')+1)).trim()+')');
    assert.equal(audio(s),false);
    for(const mutate of [x=>{x.seekOffset=0;},x=>{x.codecProfile.videoWidth=3840;},x=>{delete x.codecProfile.videoWidth;},
        x=>{x.playbackIdentity.itemType='live';},x=>{x.codecProfile.probeSource='provider';}]) {
        const x=fixture();x.seekOffset=17;Object.assign(x.codecProfile,{videoWidth:1280,videoHeight:720});mutate(x);
        assert.equal(applyFiniteTsAccurateResume(x,{backend:'vaapi',ready:true}),false);
        assert.equal(x.finiteTsResumeAligned,undefined);
    }
    assert.equal(applyFiniteTsAccurateResume(s,{backend:'software',ready:true}),false);
});
test('both policy boundaries reject underbuffered or mismatched TS policies and preserve existing MKV rules',()=>{
    const {edge,watch}=clients(), good=finiteTsStartupPolicy(fixture(),'copy');
    for(const bad of [{...good,targetBufferSeconds:6},{...good,targetBufferSeconds:25},
        {...good,minimumEncodeRateX:1.15},{...good,pipeline:'video-transcode'},{...good,observedEncodeRateX:1}]) {
        assert.equal(edge(bad),null);assert.equal(watch.normalizeGatewayStartupPolicy(bad),null);
    }
    assert.equal(watch.gatewayStartupBufferOptions(null).minimumSeconds,96);
    const mkv={...good,pipeline:'video-transcode',reason:'vaapi-transcode-ready',minimumEncodeRateX:2,targetBufferSeconds:6};
    assert.equal(watch.gatewayStartupBufferOptions(edge(mkv)).minimumSeconds,6);
});
test('local decoder has exactly one inherited pipe input, bounded output and hard cancellation',async()=>{
    const controller=new AbortController();let killed=0,captured;
    const result=decodeStartupSegment('/ffmpeg',42,{signal:controller.signal,spawnImpl:(bin,args,opts)=>{
        captured={bin,args,opts};const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
        child.kill=()=>{killed++;queueMicrotask(()=>child.emit('close',137));};return child;
    }});
    controller.abort();assert.equal(await result,false);assert.equal(killed,1);
    assert.deepEqual(captured.opts.stdio,['ignore','pipe','pipe',42]);
    assert.equal(captured.args.filter(a=>a==='-i').length,1);
    assert.equal(captured.args[captured.args.indexOf('-protocol_whitelist')+1],'pipe');
});
test('local proof refuses traversal, unavailable media and cancelled playback without remote work',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'norva-ts-proof-'));
    try {
        let decoded=0;const decode=async()=>{decoded++;return true;};
        const params={root:await fs.promises.realpath(dir),files:['segment-00000.ts','segment-00001.ts'],durations:[12,12],bin:'/unused',decode};
        assert.equal((await verifyFiniteTsStartupSegments({...params,files:['../evil.ts','segment-00001.ts']})).verified,false);
        assert.equal(decoded,0);
        for(const name of params.files)fs.writeFileSync(path.join(dir,name),'test');
        const valid=await verifyFiniteTsStartupSegments(params);
        assert.equal(valid.verified,true,JSON.stringify(valid));assert.equal(decoded,2);
        const controller=new AbortController();controller.abort();
        assert.equal((await verifyFiniteTsStartupSegments({...params,signal:controller.signal})).verified,false);assert.equal(decoded,2);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('version cards prefer an observed container without mutating provider URL identity',()=>{
    const win={};new Function('window',fs.readFileSync(path.join(__dirname,'../public/js/utils/mediaUtils.js'),'utf8'))(win);
    const item={container_extension:'mkv',codecProfile:fixture().codecProfile};const before=JSON.stringify(item);
    assert.match(win.MediaUtils.versionDescriptor(item).meta,/MPEG-TS/);assert.equal(JSON.stringify(item),before);
    item.codecProfile.probeSource='provider';assert.match(win.MediaUtils.versionDescriptor(item).meta,/MKV/);
    item.codecProfile.probeSource='gateway_inband';item.codecProfile.container='ts';
    assert.match(win.MediaUtils.versionDescriptor(item).meta,/MKV/);
    item.codecProfile.metadataComplete=true;assert.match(win.MediaUtils.versionDescriptor(item).meta,/MPEG-TS/);
});
