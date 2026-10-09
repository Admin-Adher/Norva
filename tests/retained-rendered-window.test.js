'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), sync=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {createHlsOutputAdmission}=require('../services/media-gateway/src/hls-output-admission');
const {ResumePlaylistClock}=require('../services/media-gateway/src/private-resume-playlist-clock');
const playlist=(end)=>{const start=Math.max(0,end-63);return '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:'+start+'\n'+Array.from({length:end-start+1},(_,j)=>'#EXTINF:2.002,\nvideo-'+String(start+j).padStart(5,'0')+'.ts\n').join('');};
const put=(url,body='x')=>new Promise((resolve,reject)=>{const req=http.request(url,{method:'PUT',headers:{Expect:'100-continue','Content-Length':Buffer.byteLength(body)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('continue',()=>req.end(body));req.on('error',reject);req.flushHeaders();});
const settle=()=>new Promise(resolve=>setTimeout(resolve,35));
async function setup(t,enabled=true){const root=await fs.mkdtemp(path.join(os.tmpdir(),'norva-rendered-'));const a=await createHlsOutputAdmission({root,targetSeconds:2,maxBytes:1024*1024,trackPlaybackPosition:enabled,onFailure:()=>assert.fail('writer failed')});t.after(async()=>{await a.stop();assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});return {a,root};}
async function publish(a,end){assert.equal(await put(a.urlFor('video-'+String(end).padStart(5,'0')+'.ts')),200);assert.equal(await put(a.urlFor('video.m3u8'),playlist(end)),200);a.served('video-'+String(end).padStart(5,'0')+'.ts');}

test('clock maps a rendered position through published durations and refuses missing history',()=>{
 const c=new ResumePlaylistClock();for(let i=0;i<=141;i++)c.observe('video.m3u8',playlist(i));
 assert.equal(c.sequenceAt('video.m3u8',101),null);
 assert.equal(c.sequenceAt('video.m3u8',160.16),80);
 for(const x of [-1,NaN,Infinity,10000])assert.equal(c.sequenceAt('video.m3u8',x),null);
 assert.equal(c.sequenceAt('audio_0.m3u8',160),null);
});

test('real writer keeps the rendered position inside 64 segments despite 120s browser prefetch',async t=>{
 const {a,root}=await setup(t);await publish(a,0);assert.equal(a.reportPlaybackPosition('video.m3u8',0),true);
 // Every downloaded segment is acknowledged. It must not count as rendered.
 for(let i=1;i<62;i++)await publish(a,i);
 let done=false;const pending=put(a.urlFor('video-00062.ts')).then(s=>{done=true;return s;});await settle();assert.equal(done,false);
 assert.equal(a.snapshot().renderedSequence,0);assert.equal(a.snapshot().consumed,61);assert.equal(a.snapshot().produced,61);
 // 124 seconds exist: the unchanged 96-second startup reserve can be reached.
 assert.ok(62*2.002>=96);
 assert.equal(a.reportPlaybackPosition('video.m3u8',101),true);assert.equal(await pending,200);
 await put(a.urlFor('video.m3u8'),playlist(62));a.served('video-00062.ts');
 for(let i=63;i<112;i++)await publish(a,i);
 done=false;const second=put(a.urlFor('video-00112.ts')).then(s=>{done=true;return s;}).catch(()=>null);await settle();assert.equal(done,false);
 const text=await fs.readFile(path.join(root,'video.m3u8'),'utf8');const origin=a.resumePlaylistClock.originFor('video.m3u8',text);
 assert.ok(origin<=101);assert.ok(origin+64*2.002>101);
 assert.equal(a.snapshot().maxBytes,1024*1024);assert.ok(a.snapshot().bytes<=1024*1024);
 await a.stop();await second;
});

test('unreported and disabled clients retain the ordinary writer behavior',async t=>{
 for(const enabled of [true,false]){const {a}=await setup(t,enabled);for(let i=0;i<75;i++)await publish(a,i);assert.equal(a.snapshot().renderedSequence,null);}
});

test('invalid or undelivered positions cannot advance the output; a stale position grants no forward credit',async t=>{
 const {a}=await setup(t);await publish(a,0);assert.equal(a.reportPlaybackPosition('video.m3u8',0),true);
 for(let i=1;i<12;i++)await publish(a,i);
 for(const v of [-1,Infinity,NaN,1000,'12'])assert.equal(a.reportPlaybackPosition('video.m3u8',v),false);
 assert.equal(a.reportPlaybackPosition('audio_0.m3u8',3),false);
 assert.equal(a.reportPlaybackPosition('video.m3u8',10),true);assert.equal(a.snapshot().renderedSequence,4);
 assert.equal(a.reportPlaybackPosition('video.m3u8',2),true);assert.equal(a.snapshot().renderedSequence,0);
 assert.equal(a.reportPlaybackPosition('video.m3u8',24.024),false);
});

function watch(){const ctx={window:{location:{href:'https://norva.tv/app'}},console,setTimeout,clearTimeout,URL};vm.runInNewContext(sync.readFileSync(path.join(__dirname,'../public/js/pages/WatchPage.js'),'utf8'),ctx);return Object.create(ctx.window.WatchPage.prototype);}
test('WatchPage reports local rendered time only to the exact authenticated Gateway playlist scope',()=>{
 const p=watch();p.video={currentTime:101.25,readyState:4};const root='https://gateway.invalid/sessions/one/playlist.m3u8?token=private';
 const good=root.replace('playlist.m3u8','video.m3u8');assert.equal(new URL(p.gatewayPlaybackPositionUrl(good,root)).searchParams.get('renderedPosition'),'101.25');
 for(const bad of [good.replace('gateway.invalid','other.invalid'),good.replace('/one/','/two/'),good.replace('.m3u8','.ts'),good.replace('private','different')])assert.equal(p.gatewayPlaybackPositionUrl(bad,root),bad);
 p.video.readyState=0;assert.equal(new URL(p.gatewayPlaybackPositionUrl(good,root)).searchParams.get('renderedPosition'),'0');
 p.video={currentTime:Infinity,readyState:4};assert.equal(p.gatewayPlaybackPositionUrl(good,root),good);
});

const gatewaySource=sync.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
function reportHarness(){let received=null;const code=gatewaySource.slice(gatewaySource.indexOf('function reportRetainedPlaybackPosition('),gatewaySource.indexOf("app.get('/sessions/:id/playlist.m3u8'"));const report=vm.runInNewContext(code+';reportRetainedPlaybackPosition',{retainedSubtitleClock:s=>s.enabled,timingSafeEqual:(a,b)=>a===b});const session={enabled:true,accessToken:'exact',primaryViewerAttached:true,expiresAt:new Date(Date.now()+60000),actualStartOffset:600,retainedViewerStartOffset:700,hlsOutputAdmission:{reportPlaybackPosition:(name,p)=>{received={name,p};return true;}}};const req={query:{renderedPosition:'1.25'},playbackToken:'exact'};return {report,session,req,received:()=>received};}
test('Gateway binds local playhead to the adopted origin without losing primary-token or expiry checks',()=>{
 const h=reportHarness();assert.equal(h.report(h.req,h.session),true);assert.deepEqual(h.received(),{name:'video.m3u8',p:101.25});
 for(const mutate of [h=>h.req.playbackToken='old',h=>h.req.playbackAttachmentId='viewer',h=>h.session.primaryViewerAttached=false,h=>h.session.enabled=false,h=>h.session.retainedSessionState='parked',h=>h.session.expiresAt=new Date(0),h=>h.session.sourceTimestamps=true,h=>h.session.actualStartOffset=NaN]){
  const g=reportHarness();mutate(g);assert.equal(g.report(g.req,g.session),false);assert.equal(g.received(),null);
 }
 for(const value of ['NaN','Infinity','1e2','-1','86400','1.1234567',['1'],1,'01']){const g=reportHarness();g.req.query.renderedPosition=value;assert.equal(g.report(g.req,g.session),false);}
});
test('real WatchPage loader reports refreshed time, stops on replaced attempts/Hls, and preserves buffer limits',()=>{
 let config;const captured=Error('load captured');class Hls{constructor(c){config=c;}loadSource(){throw captured;}} Hls.Events={};
 const ctx={window:{location:{href:'https://norva.tv/app'}},console,setTimeout,clearTimeout,URL,Request,Hls};vm.runInNewContext(sync.readFileSync(path.join(__dirname,'../public/js/pages/WatchPage.js'),'utf8'),ctx);
 const p=Object.create(ctx.window.WatchPage.prototype);Object.assign(p,{video:{readyState:4,currentTime:12.34},_committedSubtitleStreams:[2],_playbackAttemptId:3,isGatewayPlaybackUrl:()=>true});
 const url='https://gateway.invalid/sessions/one/playlist.m3u8?token=private';assert.throws(()=>p.playHls(url,{playbackAttemptId:3}),e=>e===captured);
 let opened;const xhr={open:(method,u,async)=>opened={method,u,async}};config.xhrSetup(xhr,url);assert.equal(new URL(opened.u).searchParams.get('renderedPosition'),'12.34');
 p.video.currentTime=23.45;assert.equal(new URL(config.fetchSetup({url},{}).url).searchParams.get('renderedPosition'),'23.45');
 assert.equal(config.maxBufferLength,120);assert.equal(config.maxMaxBufferLength,120);
 p._playbackAttemptId=4;opened=null;config.xhrSetup(xhr,url);assert.equal(opened,null);p._playbackAttemptId=3;p.hls={};opened=null;config.xhrSetup(xhr,url);assert.equal(opened,null);
});
