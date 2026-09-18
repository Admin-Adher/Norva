'use strict';
// Exercise the actual Gateway, not a replacement implementation. All source
// bytes and the proxy are synthetic loopback-only; no provider is contacted.
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), fixtureDir = path.resolve(process.argv[2] || '');
if (!fixtureDir.startsWith(path.join(root, 'output', 'playwright') + path.sep)) throw Error('FIXTURE_DIRECTORY_INVALID');
const output = path.join(fixtureDir, 'gateway-' + Date.now());
const formats = (process.env.NORVA_TEST_FORMATS || 'mp4,mkv,ts').split(',');
if (formats.some(format => !['mp4', 'mkv', 'ts'].includes(format))) throw Error('FORMAT_INVALID');
const bin = process.env.NORVA_TEST_FFMPEG, probe = process.env.NORVA_TEST_FFPROBE;
if (!bin || !probe) throw Error('Set NORVA_TEST_FFMPEG and NORVA_TEST_FFPROBE');
const ownerKey = 'a'.repeat(64), token = crypto.randomBytes(32).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let child, origin, proxy, base, currentId, log = '', active = 0, peak = 0;
const requests = [];
const chunkDelayMs = Number(process.env.NORVA_TEST_CHUNK_DELAY_MS || 0);
const disconnectOnce = process.env.NORVA_TEST_DISCONNECT_ONCE === 'true';
const faultPhase = process.env.NORVA_TEST_FAULT_PHASE || '';
const stallOnceMs = Number(process.env.NORVA_TEST_STALL_ONCE_MS || 0);
let injectedDisconnect = false;
let injectedStall = false;
const browserProof = process.env.NORVA_TEST_BROWSER_PROOF === 'true';
const liveInfo = new Map(), browserResults = new Map();let browserServer,phase='setup';
const run = (binary, args) => new Promise((resolve, reject) => {
    const p = spawn(binary, args, { windowsHide: true }); let out = '', err = '';
    p.stdout.on('data', b => out += b); p.stderr.on('data', b => err += b);
    p.once('error', reject); p.once('exit', code => code === 0 ? resolve({ out, err }) : reject(Error(`CHILD_${code}: ${err.slice(-8000)}`)));
});
async function tracedFetch(url, options) {
    const startedAt = Date.now();
    try { return await fetch(url, options); }
    catch (error) {
        error.norvaTestHttpOperation = { phase, path: new URL(url).pathname, method: options?.method || 'GET',
            elapsedMs: Date.now() - startedAt, message: error.message, code: error.cause?.code };
        throw error;
    }
}
async function request(route, body, method = 'GET') {
    const r = await tracedFetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
    const text = await r.text(); if (!r.ok) throw Error(`${route} ${r.status}: ${text.slice(0, 1000)}`);
    return text ? JSON.parse(text) : {};
}
async function waitHealth() {
    for (let i = 0; i < 100; i++) {
        try { return await request('/health'); } catch (_) { if (child.exitCode !== null) throw Error('GATEWAY_EXIT: ' + log.slice(-4000)); }
        await sleep(100);
    } throw Error('GATEWAY_NOT_READY');
}
(async () => {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output,'execution.json'),JSON.stringify({at:new Date().toISOString(),node:process.version,
        formats,chunkDelayMs,disconnectOnce,stallOnceMs,faultPhase,browserProof,
        releaseDelayMs:process.env.NORVA_TEST_RELEASE_DELAY_MS??'gateway-default',
        gatewaySha256:crypto.createHash('sha256').update(await fs.readFile(path.join(root,'services/media-gateway/src/index.js'))).digest('hex')},null,2));
    const sources = new Map();
    for (const format of ['mp4', 'mkv', 'ts']) {
        const file = path.join(fixtureDir, 'source.' + format), bytes = await fs.readFile(file);
        sources.set('/movie/fixture/account/source.' + format, bytes);
    }
    origin = http.createServer(async (req, res) => {
        const bytes = sources.get(req.url); if (!bytes) { res.statusCode=404;return res.end(); }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const from = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : bytes.length-1;
        if (from > end || end >= bytes.length) { res.statusCode=416;return res.end(); }
        const observed = { at: Date.now(), phase, path: req.url, method: req.method, from, end, activeBefore:active };
        requests.push(observed);
        active++;peak=Math.max(active,peak);res.once('close',()=>{active--;observed.closedAt=Date.now();});
        res.writeHead(range ? 206 : 200, { 'content-length':end-from+1,'accept-ranges':'bytes','content-type':'application/octet-stream',
            ...(range ? { 'content-range':`bytes ${from}-${end}/${bytes.length}` } : {}),
            etag:'"'+crypto.createHash('sha256').update(bytes).digest('hex')+'"','cache-control':'public, max-age=60' });
        if(req.method==='HEAD'){res.end();return;}
        if(!chunkDelayMs&&!disconnectOnce&&!stallOnceMs){res.end(bytes.subarray(from,end+1));return;}
        // Bounded, deterministic network impairment of synthetic media only.
        for(let at=from;at<=end&&!res.destroyed;at+=65536){
            const canFault=(!faultPhase||phase.endsWith(faultPhase))&&from>1024*1024&&at-from>=262144;
            if(stallOnceMs&&!injectedStall&&canFault){injectedStall=true;observed.injectedStallMs=stallOnceMs;await sleep(stallOnceMs);}
            if(res.destroyed)return;
            if(disconnectOnce&&!injectedDisconnect&&canFault){
                injectedDisconnect=true;observed.injectedDisconnect=true;res.destroy();return;
            }
            if(!res.write(bytes.subarray(at,Math.min(at+65536,end+1)))){
                await new Promise(resolve=>{
                    const done=()=>{res.off('drain',done);res.off('close',done);res.off('error',done);resolve();};
                    res.once('drain',done);res.once('close',done);res.once('error',done);
                });
            }
            // Pace payload, not the already-complete response. An artificial
            // delay after Content-Length is satisfied overcounts open bodies.
            if(chunkDelayMs&&at+65536<=end)await sleep(chunkDelayMs);
        }
        if(!res.destroyed)res.end();
    }).listen(0,'127.0.0.1');await once(origin,'listening');
    const providerPort=origin.address().port;
    proxy=http.createServer((req,res)=>{res.statusCode=405;res.end();});
    proxy.on('connect',(req,socket,head)=>{
        if(req.url!=='127.0.0.1:'+providerPort){socket.destroy();return;}
        const upstream=net.connect(providerPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});
        socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
        socket.on('close',()=>upstream.destroy());
    }).listen(0,'127.0.0.1');await once(proxy,'listening');
    const reservation=net.createServer().listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise(r=>reservation.close(r));base='http://127.0.0.1:'+port;
    const env={};for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','NODE_PATH'])
        if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{PORT:String(port),GATEWAY_TOKEN:token,OUTPUT_DIR:path.join(output,'runtime'),FFMPEG_PATH:bin,FFPROBE_PATH:probe,
        PROVIDER_PROXY_URLS:'http://127.0.0.1:'+proxy.address().port,
        PRIVATE_RESUME_CACHE_ENABLED:'true',SHARED_PLAYBACK_RANGES_ENABLED:'true',MKV_COMPLETE_HLS_CACHE_ENABLED:'false',
        MEDIA_CACHE_SHARED_ENABLED:'false',ACCOUNT_ACTIVITY_REPORT_MS:'0'});
    if(process.env.NORVA_TEST_RELEASE_DELAY_MS!==undefined)env.PROVIDER_SLOT_RELEASE_DELAY_MS=process.env.NORVA_TEST_RELEASE_DELAY_MS;
    child=spawn(process.execPath,[path.join(root,'services/media-gateway/src/index.js')],{env,cwd:root,windowsHide:true});
    child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);await waitHealth();
    if(browserProof){
        const {page}=require('./local-hybrid-cache-proof.cjs');
        browserServer=http.createServer(async(req,res)=>{
            try{
                const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/');
                res.setHeader('Cache-Control','no-store');
                if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}
                if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
                if(url.pathname==='/hls.js'||url.pathname==='/watch.js'){
                    res.setHeader('Content-Type','application/javascript');res.end(await fs.readFile(path.join(root,
                        url.pathname==='/hls.js'?'public/js/vendor/hls-1.7.3.min.js':'public/js/pages/WatchPage.js')));return;
                }
                if(parts[1]==='info'&&formats.includes(parts[2])){
                    const info=liveInfo.get(parts[2]);res.statusCode=info?200:202;res.setHeader('Content-Type','application/json');
                    res.end(JSON.stringify(info||{}));return;
                }
                if(parts[1]==='result'&&formats.includes(parts[2])&&req.method==='POST'){
                    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>131072)throw Error('RESULT_TOO_LARGE');chunks.push(chunk);}
                    const result=JSON.parse(Buffer.concat(chunks));await fs.writeFile(path.join(output,'browser-'+parts[2]+'.json'),JSON.stringify(result,null,2));
                    browserResults.set(parts[2],result);console.log(JSON.stringify({browserComplete:parts[2],playedSeconds:result.playedSeconds,
                        elapsedSeconds:result.elapsedSeconds,stalls:result.stalls,errors:result.errors,quality:result.quality}));
                    res.end('ok');return;
                }
                res.statusCode=404;res.end();
            }catch(e){res.statusCode=500;res.end('fixture error');console.error(e.message);}
        }).listen(0,'127.0.0.1');await once(browserServer,'listening');
        console.log(JSON.stringify({browserUrl:'http://127.0.0.1:'+browserServer.address().port+'/?sequential=1&formats='+formats.join(',')
            +(process.env.NORVA_TEST_UNMUTED==='true'?'&unmuted=1':''),output}));
    }
    const report=[];
    for(const format of formats){
        const file=path.join(fixtureDir,'source.'+format), bytes=sources.get('/movie/fixture/account/source.'+format);
        const raw=JSON.parse((await run(probe,['-v','error','-show_streams','-show_format','-of','json',file])).out);
        const video=raw.streams.find(s=>s.codec_type==='video'),audio=raw.streams.find(s=>s.codec_type==='audio');
        const profile={metadataComplete:true,probeSource:'gateway_probe',probedAt:new Date().toISOString(),fileSizeBytes:bytes.length,
            container:raw.format.format_name,durationSeconds:Number(raw.format.duration),videoStreamIndex:video.index,
            videoCodec:video.codec_name,videoProfile:video.profile,videoPixelFormat:video.pix_fmt,videoWidth:video.width,videoHeight:video.height,
            audioCodec:audio.codec_name,audioChannels:audio.channels,audioSampleRate:Number(audio.sample_rate),
            audioTracks:[{index:audio.index,codec:audio.codec_name,profile:audio.profile,channels:audio.channels,sampleRate:Number(audio.sample_rate),
                channelLayout:audio.channel_layout,default:true}],subtitles:[]};
        const body={sourceUrl:'http://127.0.0.1:'+providerPort+'/movie/fixture/account/source.'+format,ownerKey,mode:'transcode',
            expiresAt:new Date(Date.now()+15*60_000).toISOString(),playbackHint:{container:format,itemType:'movie',streamType:'movie'},
            playbackIdentity:{sourceId:'private-proof-source',sourceRevision:'1',itemType:'movie',itemId:format,variantId:format},
            codecProfile:profile,audioCodec:audio.codec_name,audioChannels:audio.channels,audioStreamIndex:audio.index,
            audioMode:'transcode',videoCodec:video.codec_name,clientAudioPassthrough:false};
        phase=format+'-cold';
        const at=Date.now(),cold=await request('/sessions',{...body,playbackSessionId:crypto.randomUUID(),seekOffset:0},'POST');
        const coldMs=Date.now()-at;
        currentId=cold.id;await fs.writeFile(path.join(output,format+'-cold.json'),JSON.stringify(cold,null,2));
        let first='';
        const bufferedSeconds = text => [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((n,m)=>n+Number(m[1]),0);
        for(let i=0;i<600;i++){
            const r=await tracedFetch(cold.hlsUrl);first=await r.text();
            if(bufferedSeconds(first)>=80)break;
            await sleep(100);
        }
        assert.ok(bufferedSeconds(first)>=80,'synthetic cold output needs a window, not the whole movie');
        await request('/sessions/'+cold.id+'?resumePosition=10.375',null,'DELETE');currentId=null;
        const afterStop=await request('/health');
        assert.ok(afterStop.privateResumeHlsCache.entries>0,format+' must capture a playable window');
        phase=format+'-resume';
        const resumeAt=Date.now(),resumed=await request('/sessions',{...body,playbackSessionId:crypto.randomUUID(),seekOffset:10.375},'POST');
        currentId=resumed.id;const resumeMs=Date.now()-resumeAt;
        await fs.writeFile(path.join(output,format+'-resume.json'),JSON.stringify(resumed,null,2));
        assert.equal(resumed.startupPolicy?.reason,'private-resume-window-ready',format+' must use cached startup');
        liveInfo.set(format,{hlsUrl:resumed.hlsUrl,offset:resumed.localSeekTarget,
            splice:resumed.startupPolicy.cachedAheadSeconds+resumed.localSeekTarget});
        let playlist='',continuationCompleteMs=null;const progress=[];
        for(let i=0;i<(browserProof?2400:800);i++){
            const r=await tracedFetch(resumed.hlsUrl);playlist=await r.text();
            if(i%10===0){
                const state=await request('/sessions/'+resumed.id);
                progress.push({at:Date.now(),elapsedMs:Date.now()-resumeAt,httpStatus:r.status,
                    seconds:bufferedSeconds(playlist),segments:playlist.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).length,
                    requests:requests.length,active,status:state.status,lastError:state.lastError,
                    startupTimings:state.startupTimings,logTail:state.logTail});
                await fs.writeFile(path.join(output,format+'-progress.json'),JSON.stringify(progress,null,2));
                await fs.writeFile(path.join(output,'provider-requests.json'),JSON.stringify(requests,null,2));
                if(i%50===0)await fs.writeFile(path.join(output,format+'-debug.json'),JSON.stringify(await request('/debug/sessions'),null,2));
                if(state.lastError)throw Error('CONTINUATION_ERROR: '+state.lastError);
            }
            if(playlist.includes('#EXT-X-ENDLIST'))continuationCompleteMs??=Date.now()-resumeAt;
            if(playlist.includes('#EXT-X-ENDLIST')&&(!browserProof||browserResults.has(format)))break;
            await sleep(100);
        }
        assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g)||[]).length,1);
        assert.ok(playlist.includes('#EXT-X-ENDLIST'),'continuation must finish');
        const browserValidationErrors=[];
        if(browserProof){
            const result=browserResults.get(format);
            assert.ok(result?.finished&&result.playedSeconds>=120,'120 seconds effective playback required');
            if(result.stalls.length)browserValidationErrors.push('playback must not wait after startup');
            if(result.errors.some(e=>e.fatal))browserValidationErrors.push('no fatal HLS error');
            if(!(result.quality.totalVideoFrames>=2900&&result.quality.droppedVideoFrames/result.quality.totalVideoFrames<=0.001))
                browserValidationErrors.push('25 fps fixture must decode two minutes with at most 0.1% dropped frames');
            if(process.env.NORVA_TEST_UNMUTED==='true'&&result.elapsedSeconds>122)
                browserValidationErrors.push('media clock must advance with wall time');
        }
        const directory=path.join(output,format);await fs.mkdir(directory);
        const segments=playlist.split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
        for(const uri of segments){
            const url=new URL(uri,resumed.hlsUrl),name=path.basename(url.pathname);
            assert.match(name,/^[a-z0-9._-]+\.ts$/i);
            const r=await tracedFetch(url);assert.equal(r.status,200);await fs.writeFile(path.join(directory,name),Buffer.from(await r.arrayBuffer()));
        }
        const local=playlist.split(/\r?\n/).map(line=>line&&!line.startsWith('#')?path.basename(new URL(line,resumed.hlsUrl).pathname):line).join('\n');
        await fs.writeFile(path.join(directory,'playlist.m3u8'),local);
        const decoded=await run(bin,['-hide_banner','-nostdin','-v','warning','-i',path.join(directory,'playlist.m3u8'),'-map','0:v:0','-map','0:a:0','-f','null','-']);
        await fs.writeFile(path.join(directory,'decode-warnings.txt'),decoded.err);
        await request('/sessions/'+resumed.id,null,'DELETE');currentId=null;
        assert.equal((await tracedFetch(resumed.hlsUrl)).status,404,'stopped grants cannot read cached media');
        report.push({format,coldMs,resumeMs,actualStartOffset:resumed.actualStartOffset,
            localSeekTarget:resumed.localSeekTarget,startupPolicy:resumed.startupPolicy,peakProviderConnections:peak,decodeExit:0,
            continuationCompleteMs,testElapsedMs:Date.now()-resumeAt,injectedDisconnect,injectedStall,
            browserValidationErrors,warnings:decoded.err.length});console.log(JSON.stringify(report.at(-1)));
        await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    }
    assert.equal(peak,1,'provider requests must remain serialized');
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    // Preserve segments, measure the other formats, and still fail the entire
    // run on a playback defect. Never turn a late micro-stall into a success.
    assert.deepEqual(report.flatMap(row=>row.browserValidationErrors),[],'browser continuity validation failed');
    console.log(JSON.stringify({complete:true,output}));
})().catch(async e=>{
    await fs.writeFile(path.join(output,'failure-operation.json'),JSON.stringify({phase,failedHttpOperation:e.norvaTestHttpOperation,
        message:e.message,stack:e.stack,causeCode:e.cause?.code},null,2));
    if(currentId){
        await fs.writeFile(path.join(output,'failure-session.json'),JSON.stringify(await request('/sessions/'+currentId).catch(()=>null),null,2));
        await fs.writeFile(path.join(output,'failure-health.json'),JSON.stringify(await request('/health').catch(()=>null),null,2));
        const current=await request('/sessions/'+currentId).catch(()=>null);
        if(current?.hlsUrl)await fs.writeFile(path.join(output,'failure-playlist.txt'),await (await fetch(current.hlsUrl)).text());
    }
    console.error(e);process.exitCode=1;
}).finally(async()=>{
    if(currentId&&base)await request('/sessions/'+currentId,null,'DELETE').catch(()=>{});
    child?.kill();proxy?.close();origin?.close();browserServer?.close();
    await fs.writeFile(path.join(output,'gateway.log'),log).catch(()=>{});
    await fs.writeFile(path.join(output,'provider-requests.json'),JSON.stringify(requests,null,2)).catch(()=>{});
});
