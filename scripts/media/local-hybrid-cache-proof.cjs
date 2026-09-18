'use strict';
// Local synthetic media only. No credentials, provider connection or deployment.
// Run with NORVA_TEST_FFMPEG set; artifacts use a unique output/playwright folder.
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process'), crypto = require('node:crypto');
const { PrivateResumeHlsCache } = require('../../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../../services/media-gateway/src/private-resume-binding');
const root = path.resolve(__dirname, '../..');
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'output/playwright', `hybrid-cache-${Date.now()}`);
if (!output.startsWith(path.join(root, 'output', 'playwright') + path.sep)) throw new Error('FIXTURE_DIRECTORY_INVALID');
const gatewayOutput = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (gatewayOutput && !gatewayOutput.startsWith(path.join(root, 'output', 'playwright') + path.sep)) throw new Error('GATEWAY_FIXTURE_DIRECTORY_INVALID');
const exists = file => fs.stat(file).then(s => s.isFile()).catch(() => false);
const ffmpeg = process.env.NORVA_TEST_FFMPEG;
if (!ffmpeg && !gatewayOutput) throw new Error('Set NORVA_TEST_FFMPEG to an existing local FFmpeg binary');
const fixtures = new Map();
const run = args => new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'warning', '-y', ...args], { windowsHide: true });
    let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-32_000); });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(err) : reject(new Error(`FFMPEG_${code}: ${err}`)));
});
const encoder = ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k',
    '-ar', '48000', '-ac', '2', '-threads', '2'];
const hls = directory => [...encoder, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_playlist_type', 'event', '-hls_segment_type', 'mpegts', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(directory, 'segment-%04d.ts'), path.join(directory, 'playlist.m3u8')];

async function prepare() {
    await fs.mkdir(output, { recursive: true });
    if (gatewayOutput) {
        const report = JSON.parse(await fs.readFile(path.join(gatewayOutput, 'report.json'), 'utf8'));
        for (const row of report) {
            const directory = path.join(gatewayOutput, row.format);
            const combined = await fs.readFile(path.join(directory, 'playlist.m3u8'), 'utf8');
            const initial = combined.split('#EXT-X-DISCONTINUITY')[0];
            const splice = [...initial.matchAll(/#EXTINF:([\d.]+)/g)].reduce((n, m) => n + Number(m[1]), 0);
            fixtures.set(row.format, { initial, combined, directory, firstRequestAt: null,
                offset: row.localSeekTarget, splice, actualStartOffset: row.actualStartOffset });
        }
        fixtures.set('control', { file: path.join(gatewayOutput, '..', 'source.mp4'), offset: 0, splice: 0 });
        return;
    }
    const original = path.join(output, 'source.mp4');
    if (!await exists(original)) await run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
        '-t', '160', ...encoder.slice(4), '-movflags', '+faststart', original]);
    for (const format of ['mp4', 'mkv', 'ts']) {
        const source = path.join(output, `source.${format}`);
        if (!await exists(source)) await run(['-i', original, '-map', '0', '-c', 'copy', source]);
        const directory = path.join(output, format), first = path.join(directory, 'first'), rest = path.join(directory, 'rest');
        await fs.mkdir(first, { recursive: true }); await fs.mkdir(rest, { recursive: true });
        if (!await exists(path.join(first, 'playlist.m3u8'))) await run(['-i', source, ...hls(first)]);
        const fileSizeBytes = (await fs.stat(source)).size;
        const observed = { fileSizeBytes, validator: { kind: 'etag', value: `"${format}-fixture"` },
            effectiveUrlIdentitySha256: crypto.createHash('sha256').update(source).digest('hex') };
        const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: `http://fixture.invalid/only.${format}`,
            sourceId: 'fixture-owned-source', sourceRevision: '1', fileSizeBytes, profile: 'h264-aac-stereo' });
        const cache = new PrivateResumeHlsCache();
        const captured = await cache.capture({ binding, observed, position: 10.375, actualStartOffset: 0,
            playlist: await fs.readFile(path.join(first, 'playlist.m3u8'), 'utf8'), readAsset: name => fs.readFile(path.join(first, name)) });
        if (!captured) throw new Error(`FIXTURE_CACHE_MISS_${format}`);
        const lease = cache.acquire(binding, 10.375, observed);
        if (!await exists(path.join(rest, 'playlist.m3u8'))) await run(['-ss', String(lease.end), '-i', source, ...hls(rest)]);
        const continuation = await fs.readFile(path.join(rest, 'playlist.m3u8'), 'utf8');
        const initial = lease.playlist(), combined = lease.playlist(continuation);
        for (const name of initial.split('\n').filter(line => line.endsWith('.ts'))) await fs.writeFile(path.join(rest, name), lease.asset(name));
        await fs.writeFile(path.join(rest, 'merged.m3u8'), combined);
        const decodeWarnings = await run(['-i', path.join(rest, 'merged.m3u8'), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
        await fs.writeFile(path.join(directory, 'decode-warnings.txt'), decodeWarnings);
        fixtures.set(format, { initial, combined, directory: rest, firstRequestAt: null, lease,
            offset: 10.375 - lease.start, splice: lease.end - lease.start, fileSizeBytes, cache: cache.publicStatus() });
        console.log(JSON.stringify({ fixture: format, fileSizeBytes, cachedBytes: cache.publicStatus().bytes,
            spliceSeconds: lease.end - lease.start, decodeExit: 0, warnings: decodeWarnings.length }));
    }
    await fs.writeFile(path.join(output, 'fixture-report.json'), JSON.stringify([...fixtures].map(([format, f]) => ({ format,
        fileSizeBytes: f.fileSizeBytes, offset: f.offset, spliceSeconds: f.splice, cache: f.cache })), null, 2));
}
const page = `<!doctype html><meta charset="utf-8"><title>Norva — preuve locale cache hybride</title>
<h1>Test synthétique du raccord de reprise</h1><p>Aucun accès fournisseur. Trois sources, HLS.js Norva.</p>
<button id="start">Lancer les lectures (120 secondes effectives)</button><div id="players"></div><pre id="status"></pre>
<script src="/hls.js"></script><script src="/watch.js"></script><script>
window.results=[]; const active=[];
document.getElementById('start').onclick=async()=>{
 if(active.length)return;
 const selection=(new URLSearchParams(location.search).get('formats')||'mp4,mkv,ts').split(',')
 .filter(f=>['mp4','mkv','ts','control'].includes(f));
 for(const format of selection){
  let response;const deadline=Date.now()+180000;
  do{response=await fetch('/info/'+format);if(response.status===202)await new Promise(r=>setTimeout(r,250));}
   while(response.status===202&&Date.now()<deadline);
  if(response.status!==200)throw Error('Fixture not ready: '+format);
  const info=await response.json();
  let complete;const done=new Promise(resolve=>complete=resolve);
  const label=document.createElement('section');label.textContent=format.toUpperCase();
  const video=document.createElement('video');video.width=320;video.height=180;video.controls=true;
  video.muted=new URLSearchParams(location.search).get('unmuted')!=='1';label.append(video);
  document.getElementById('players').append(label);
  const r={format,startAt:performance.now(),firstFrameMs:null,firstMotionMs:null,frames:0,stalls:[],errors:[],offset:info.offset,splice:info.splice,
   mutedAtStart:video.muted,gaps:[],events:[],fragments:[],samples:[],frameIntervals:[],mediaIntervals:[],visibility:[{at:performance.now(),state:document.visibilityState}]};
  window.results.push(r);let waitAt=null,baseline=null,requested=false,playingAt=null;
  let previousTick=null,previousMedia=null,previousFrame=null,previousFrameMedia=null,playingDate=null;
  document.addEventListener('visibilitychange',()=>r.visibility.push({at:performance.now(),state:document.visibilityState}));
  for(const name of ['pause','play','waiting','playing','seeking','seeked','ratechange','stalled','ended'])video.addEventListener(name,()=>
   r.events.push({name,at:performance.now()-r.startAt,media:video.currentTime,rate:video.playbackRate,
    readyState:video.readyState,networkState:video.networkState,
    buffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])}));
  const watch=Object.create(WatchPage.prototype);watch.video=video;
  const policy={protocol:3,eligible:true,pipeline:'video-transcode',reason:'private-resume-window-ready',targetBufferSeconds:6,
    cachedAheadSeconds:info.splice-info.offset,fileIdentityRevalidated:true};
  r.minimumBuffer=format==='control' ? 0.25 : watch.gatewayStartupBufferOptions(policy).minimumSeconds;
  const player=format==='control'?null:new Hls({maxBufferLength:90,maxMaxBufferLength:180,startPosition:info.offset});active.push(player||video);
  player?.on(Hls.Events.FRAG_CHANGED,(_,e)=>{if(r.fragments.length<100)r.fragments.push({at:performance.now()-r.startAt,
    media:video.currentTime,start:e.frag.start,duration:e.frag.duration,sn:e.frag.sn,cc:e.frag.cc});});
  player?.on(Hls.Events.ERROR,(_,e)=>{if(r.errors.length<50)r.errors.push({type:e.type,details:e.details,fatal:e.fatal,
    at:performance.now()-r.startAt,media:video.currentTime,bufferAhead:watch.gatewayBufferedAheadSeconds(),started:playingAt!==null});});
  video.addEventListener('waiting',()=>{if(playingAt&&waitAt===null)waitAt=performance.now();});
  video.addEventListener('playing',()=>{if(!playingAt){playingAt=performance.now();playingDate=Date.now();}if(waitAt!==null){r.stalls.push(performance.now()-waitAt);waitAt=null;}});
  const frame=(now,meta)=>{r.frames++;r.presentedFrames=meta.presentedFrames;if(r.firstFrameMs===null)r.firstFrameMs=now-r.startAt;
   if(baseline===null)baseline=meta.mediaTime;
   if(r.firstMotionMs===null&&!video.paused&&meta.mediaTime>baseline+.02)r.firstMotionMs=now-r.startAt;
   if(previousFrame!==null&&!video.paused){r.frameIntervals.push(now-previousFrame);r.mediaIntervals.push(meta.mediaTime-previousFrameMedia);
    if(now-previousFrame>250)r.gaps.push({kind:'frame',ms:now-previousFrame,media:meta.mediaTime});}
   previousFrame=now;previousFrameMedia=meta.mediaTime;r.lastMediaTime=meta.mediaTime;if(!r.finished)video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
  if(player){player.attachMedia(video);player.loadSource(info.hlsUrl||'/play/'+format+'/playlist.m3u8');}else video.src='/control.mp4';
  const tick=setInterval(async()=>{
   if(!requested&&watch.gatewayBufferedAheadSeconds()>=r.minimumBuffer){requested=true;await video.play().catch(e=>r.errors.push({play:e.name}));}
   r.currentTime=video.currentTime;r.bufferAhead=watch.gatewayBufferedAheadSeconds();r.paused=video.paused;
   const now=performance.now();if(previousTick!==null&&playingAt&&now-previousTick>1000)
    r.gaps.push({kind:'timer',ms:now-previousTick,advance:video.currentTime-previousMedia,media:video.currentTime});
   previousTick=now;previousMedia=video.currentTime;
   if(playingAt&&r.samples.length<Math.floor((now-playingAt)/10000))r.samples.push({elapsed:(now-playingAt)/1000,media:video.currentTime});
   if(playingAt&&(video.currentTime-info.offset>=120||performance.now()-playingAt>=180000)){
    clearInterval(tick);r.finished=true;video.pause();r.playedSeconds=video.currentTime-info.offset;
    r.elapsedSeconds=(performance.now()-playingAt)/1000;
    r.elapsedDateSeconds=(Date.now()-playingDate)/1000;
    if(waitAt!==null)r.stalls.push(performance.now()-waitAt);
    const q=video.getVideoPlaybackQuality();r.quality={totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames};
    const sorted=r.frameIntervals.slice().sort((a,b)=>a-b);
    r.frameCadence={count:sorted.length,meanMs:r.frameIntervals.reduce((n,v)=>n+v,0)/sorted.length,
     p95Ms:sorted[Math.floor(sorted.length*.95)],p99Ms:sorted[Math.floor(sorted.length*.99)],maxMs:sorted.at(-1)};
    delete r.frameIntervals;delete r.mediaIntervals;
    await fetch('/result/'+format,{method:'POST',body:JSON.stringify(r)});player?.destroy();complete();}
   // Do not serialize thousands of per-frame samples into the DOM while
   // measuring rendering. That instrumentation itself blocks frame callbacks.
   document.getElementById('status').textContent=JSON.stringify(window.results.map(r=>({format:r.format,
    finished:r.finished,currentTime:r.currentTime,firstMotionMs:r.firstMotionMs,frames:r.frames,
    stalls:r.stalls,errors:r.errors,playedSeconds:r.playedSeconds,elapsedSeconds:r.elapsedSeconds,
    quality:r.quality,frameCadence:r.frameCadence})),null,2);
  },200);
  if(new URLSearchParams(location.search).get('sequential')==='1')await done;
 }
};</script>`;

if(require.main===module)(async () => {
    await prepare();
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost'); res.setHeader('Cache-Control', 'no-store');
            if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page); }
            if (url.pathname === '/control.mp4' && fixtures.get('control')) {
                const bytes = await fs.readFile(fixtures.get('control').file);
                const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
                const start = range ? Number(range[1]) : 0;
                const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
                if (start > end) { res.statusCode = 416; return res.end(); }
                res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
                    ...(range ? { 'Content-Range': 'bytes '+start+'-'+end+'/'+bytes.length } : {}) });
                return res.end(bytes.subarray(start, end + 1));
            }
            if (url.pathname === '/hls.js' || url.pathname === '/watch.js') {
                res.setHeader('Content-Type', 'application/javascript');
                return res.end(await fs.readFile(path.join(root, url.pathname === '/hls.js' ? 'public/js/vendor/hls-1.7.3.min.js' : 'public/js/pages/WatchPage.js')));
            }
            const parts = url.pathname.split('/'); const fixture = fixtures.get(parts[2]);
            if (!fixture) { res.statusCode = 404; return res.end(); }
            if (parts[1] === 'info') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ offset: fixture.offset, splice: fixture.splice })); }
            if (parts[1] === 'result' && req.method === 'POST') {
                const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>65536)throw Error('RESULT_TOO_LARGE');chunks.push(b);}
                const result=JSON.parse(Buffer.concat(chunks));await fs.writeFile(path.join(output, 'browser-'+parts[2]+'.json'),JSON.stringify(result,null,2));
                return res.end('ok');
            }
            if (parts[1] !== 'play') { res.statusCode=404;return res.end(); }
            const file = parts[3];
            if(file==='playlist.m3u8'){
                fixture.firstRequestAt ??= Date.now();res.setHeader('Content-Type','application/vnd.apple.mpegurl');
                return res.end(Date.now()-fixture.firstRequestAt<2000?fixture.initial:fixture.combined);
            }
            if(!/^(resume-\d+|segment-\d+|seg_\d+)\.ts$/.test(file||'')){res.statusCode=404;return res.end();}
            res.setHeader('Content-Type','video/mp2t');res.end(await fs.readFile(path.join(fixture.directory,file)));
        } catch (error) { res.statusCode=500;res.end('fixture error');console.error(error.message); }
    }).listen(0,'127.0.0.1',()=>console.log(JSON.stringify({ ready:true,url:'http://127.0.0.1:'+server.address().port,output })));
})().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={page};
