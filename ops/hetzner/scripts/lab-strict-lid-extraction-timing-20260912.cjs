'use strict';
// Synthetic tones only. Run in a networkless runtime copy, not the live app.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const {runStrictLidMultiExtract}=require('../../../services/media-gateway/src/strict-lid-multi-extract');
const {parsePcm16Wav}=require('../../../services/media-gateway/src/strict-lid-audio-evidence');
async function main(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'norva-timing-proof-')));
 let bytes=Buffer.alloc(0),requests=0;
 const server=http.createServer((req,res)=>{
  requests++;const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'bytes=0-');
  if(!m||req.url!='/strict-lid/synthetic'){res.writeHead(400);res.end();return;}
  const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),bytes.length-1):bytes.length-1;
  if(start>=bytes.length){res.writeHead(416);res.end();return;}
  res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1,
   'Accept-Ranges':'bytes',Connection:'close'});res.end(bytes.subarray(start,end+1));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  for(const [codec,ext,rate] of [['aac','mp4',44100],['ac3','mkv',48000],['libmp3lame','avi',44100],['flac','mkv',16000]]){
   const source=path.join(root,codec+'.'+ext);
   await new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',['-y','-v','error','-f','lavfi','-i',`sine=frequency=440:sample_rate=${rate}:duration=180`,
     '-threads','1','-c:a',codec,'-output_ts_offset','0.023',source],{stdio:['ignore','ignore','pipe']});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('fixture_generation_failed:'+codec)));
   });
   bytes=await fs.readFile(source);const observations=[];let before;
   for(const reset of [false,true]){
    const destination=path.join(root,`output-${reset}.wav`);requests=0;
    const result=await runStrictLidMultiExtract({bin:'ffmpeg',inputUrl:`http://127.0.0.1:${server.address().port}/strict-lid/synthetic`,
     outputs:[{index:0,path:destination}],startSeconds:23.417,durationSeconds:60,timeoutMs:15000,
     spawnImpl:(bin,args,options)=>spawn(bin,reset?args.flatMap(a=>a==='-ac'?['-af','asetpts=PTS-STARTPTS',a]:[a]):args,options)});
    let observation={codec,reset,ok:result.ok,requests};
    if(result.ok){const data=await fs.readFile(destination),wav=parsePcm16Wav(data),pcm=data.subarray(wav.dataOffset,wav.dataOffset+wav.dataBytes);
     observation={...observation,durationSeconds:wav.durationSeconds,samples:wav.sampleCount};
     if(reset&&before)observation.sharedPcmPrefixEqual=before.subarray(0,Math.min(before.length,pcm.length)).equals(pcm.subarray(0,Math.min(before.length,pcm.length)));
     if(!reset)before=pcm;
    }
    observations.push(observation);
   }
   console.log(JSON.stringify({syntheticOnly:true,providerRequests:0,observations}));
  }
 }finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(path.dirname(root)!==await fs.realpath(os.tmpdir())||!path.basename(root).startsWith('norva-timing-proof-'))throw Error('cleanup_scope');
  await fs.rm(root,{recursive:true,force:true});
 }
}
main().catch(()=>{console.error('synthetic_timing_lab_failed');process.exitCode=1;});
