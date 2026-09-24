'use strict';
// Run inside an isolated production-image container with --network none.
const fs=require('node:fs/promises'), path=require('node:path'), http=require('node:http');
const crypto=require('node:crypto'), assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {StoryboardStore}=require('/app/src/storyboard-store');
const root='/tmp/storyboard-restart-qa';
const token=crypto.randomBytes(32).toString('hex');
const sourceId=crypto.randomUUID(),uid=crypto.randomUUID(),jobId=crypto.randomUUID();
const origin='http://127.0.0.1:19091';
let child,server,allowCallback=false,reads=0,renewals=0,uploads=0,callbacks=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=100000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(250);}throw Error('Runtime proof timed out');}
function sign(claims){const payload=JSON.stringify(claims);return Buffer.from(payload).toString('base64url')+'.'+crypto.createHmac('sha256',token).update(payload).digest('base64url');}
async function stop(){if(!child)return; const p=child;child=null;if(p.exitCode===null){process.kill(-p.pid,'SIGKILL');await new Promise(r=>p.once('exit',r));}}
async function boot(){child=spawn(process.execPath,['/app/src/index.js'],{env:{...process.env,PORT:'19092',GATEWAY_TOKEN:token,
 WHISPER_BIN:'',WHISPER_MODEL:'',ARGOS_ENABLED:'false',OUTPUT_DIR:root+'/output',
 STORYBOARD_PRIVATE_DIR:root+'/jobs',STORYBOARD_DURABLE_SOURCE_IDS:sourceId,NORVA_BACKEND_ORIGINS:origin,
 ACCOUNT_ACTIVITY_REPORT_MS:'0',JOB_GATE_POLL_MS:'5000',STORYBOARD_PROVIDER_COOLDOWN_MS:'0'},detached:true,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>{logs=(logs+b).slice(-5000);});child.stderr.on('data',b=>{logs=(logs+b).slice(-5000);});
 try{await until(async()=>{if(child.exitCode!==null)throw Error('Gateway exited: '+logs);try{return (await fetch('http://127.0.0.1:19092/health')).ok;}catch{return false;}},30000);}catch(e){throw Error(e.message+' '+logs);}}
(async()=>{try{
 await fs.mkdir(root,{recursive:true});
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=212x120:rate=2','-t','30','-an','-c:v','libx264','-threads','1','-y',root+'/sample.mp4']);
 const media=await fs.readFile(root+'/sample.mp4');
 server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,origin);
 if(url.pathname==='/media.mp4'){
 reads++;const range=String(req.headers.range||'').match(/^bytes=(\d+)-(\d*)$/);
 const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),media.length-1):media.length-1;
 if(start>=media.length){res.writeHead(416,{'Content-Range':'bytes */'+media.length});res.end();return;}
 const headers={'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes'};
 if(range)headers['Content-Range']='bytes '+start+'-'+end+'/'+media.length;
 res.writeHead(range?206:200,headers);res.end(media.subarray(start,end+1));return;
 }
 if(req.headers.authorization!=='Bearer '+token && url.pathname!=='/storage/upload'){res.writeHead(401);res.end();return;}
 let body='';for await(const chunk of req)body+=chunk;
 const data=body&&url.pathname!=='/storage/upload'?JSON.parse(body):{};
 let result={defer:false};
 if(url.pathname==='/storyboard-renew'){renewals++;assert.equal(data.userId,uid);assert.equal(data.jobId,jobId);result={sourceId,sourceBinding:'a'.repeat(64),duration:20,
  pipeUrl:origin+'/raw/'+sign({v:1,uid,sid:'storyboard-job',url:origin+'/media.mp4',exp:Math.floor(Date.now()/1000)+900}),uploadUrl:origin+'/storage/upload'};}
 else if(url.pathname==='/storyboard-admission'){assert.equal(data.ownerId,uid);assert.equal(data.sourceId,sourceId);result={active:true};}
 else if(url.pathname==='/storage/upload'){uploads++;assert.ok(Buffer.byteLength(body)>100);result={ok:true};}
 else if(url.pathname==='/storyboard-callback'&&!data.heartbeat){callbacks++;assert.equal(data.ok,true,JSON.stringify(data));if(!allowCallback){res.writeHead(503);res.end();return;}result={ok:true};}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(500);res.end();console.error('Fixture failure: '+e.message);}});
 await new Promise(r=>server.listen(19091,'127.0.0.1',r));
 const store=new StoryboardStore(root+'/jobs',token);
 await store.save({jobId,uid,sourceId,callbackUrl:origin+'/storyboard-callback',duration:20,durable:true});
 await boot();
 await until(async()=>{const [j]=await store.load();return j?.progress?.next===2;});
 await stop();
 const frameDir=path.join(store.dir(jobId),'frames');
 const hashes=async()=>Promise.all((await fs.readdir(frameDir)).sort().map(async n=>crypto.createHash('sha256').update(await fs.readFile(path.join(frameDir,n))).digest('hex')));
 const before=await hashes(),readsBefore=reads;
 console.log(JSON.stringify({phase:'checkpoint-after-extraction',frames:before.length,reads,renewals}));
 await boot();
 await until(async()=>{const [j]=await store.load();return j?.terminal?.ok===true;});
 await stop();assert.deepEqual(await hashes(),before);assert.equal(reads,readsBefore);assert.equal(uploads,1);
 console.log(JSON.stringify({phase:'restart-assembled-existing-frames',reads,uploads,callbacks}));
 allowCallback=true;await boot();
 await until(async()=>(await store.load()).length===0);
 assert.equal(reads,readsBefore);assert.equal(uploads,1);assert.ok(callbacks>=2);
 console.log(JSON.stringify({passed:true,processStarts:3,reads,renewals,uploads,callbacks,scope:'real Gateway and FFmpeg, synthetic HTTP backend/media; not production Edge or app'}));
 }finally{await stop();if(server)await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e.message);process.exitCode=1;});
