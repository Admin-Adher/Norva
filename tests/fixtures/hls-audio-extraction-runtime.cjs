// Run in a disposable production image with --network none, using loopback only.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm'),http=require('node:http'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
(async()=>{
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac','-f','mpegts','/tmp/audio.ts']);
 const segment=fs.readFileSync('/tmp/audio.ts');
 const server=http.createServer((req,res)=>{if(req.url==='/audio'){res.end(segment);return;}res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n'+(req.url==='/local.m3u8'?'file:///tmp/audio.ts':'/audio')+'\n#EXT-X-ENDLIST\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const source=fs.readFileSync('/app/src/index.js','utf8'),from=source.indexOf('function extractAudioWav('),to=source.indexOf('// V2 chunked pipeline',from);assert.ok(from>0&&to>from);
 const ctx={fs,fsp,path,os,crypto,Date,setTimeout,clearTimeout,spawn,console:{warn:()=>{}},FFMPEG_PATH:'ffmpeg',codecProbeInputOptions:require('/app/src/codec-probe-input-options').codecProbeInputOptions,viewerPlaybackActiveLocally:()=>false,proxyKeyFromUrl:()=> 'fixture',proxyEnvFor:()=>process.env,registerAccountExtraction:()=>({release:()=>{}}),redactCreds:v=>v};vm.createContext(ctx);vm.runInContext(source.slice(from,to),ctx);
 try{const good=await ctx.extractAudioWav(base+'/index.m3u8','Norva-QA',0,0,1,5000);const blocked=await ctx.extractAudioWav(base+'/local.m3u8','Norva-QA',0,0,1,5000);assert.equal(good.ok,true);assert.equal(blocked.ok,false);assert.ok(blocked.error.includes('ffmpeg exit'));await fsp.unlink(good.path);console.log(JSON.stringify({extensionlessAudioDecoded:true,nestedLocalFileDenied:true}));}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(()=>{console.error('HLS extraction fixture failed');process.exitCode=1;});
