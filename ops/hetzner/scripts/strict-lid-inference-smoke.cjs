// Internal WAV only: no provider, enqueue, persistence, or catalogue traffic.
const fs=require('node:fs/promises'), os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {runWhisperBatchProcess}=require('./strict-lid-batch');
const {createStrictLidInference}=require('./strict-lid-inference');
(async()=>{
 const health=await(await fetch('http://127.0.0.1:'+ (process.env.PORT||8080)+'/health')).json();
 assert.equal(health.activeSessions,0);assert.equal(health.activeStrictLidBrokers,0);
 assert.equal(health.languageDetectEngine.runtimeVerified,true);
 const response=await fetch('https://raw.githubusercontent.com/ggml-org/whisper.cpp/080bbbe85230f624f0b52127f1ae1218247989f9/samples/jfk.wav');
 assert.equal(response.ok,true);const data=Buffer.from(await response.arrayBuffer());
 assert.equal(crypto.createHash('sha256').update(data).digest('hex'),'59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'norva-strict-smoke-'));
 try{
  const wav=path.join(dir,'speech.wav');await fs.writeFile(wav,data);
  // Add silent padding to the same known speech, staying inside a strict 20s window.
  let pos=12,pcm=null;
  while(pos+8<=data.length){const n=data.readUInt32LE(pos+4);if(data.toString('ascii',pos,pos+4)==='data'){pcm=data.subarray(pos+8,pos+8+n);break;}pos+=8+n+(n%2);}
  assert.ok(pcm);const total=20*16000*2;assert.ok(pcm.length<total);
  const padded=Buffer.alloc(44+total);padded.write('RIFF');padded.writeUInt32LE(36+total,4);padded.write('WAVEfmt ',8);padded.writeUInt32LE(16,16);padded.writeUInt16LE(1,20);padded.writeUInt16LE(1,22);padded.writeUInt32LE(16000,24);padded.writeUInt32LE(32000,28);padded.writeUInt16LE(2,32);padded.writeUInt16LE(16,34);padded.write('data',36);padded.writeUInt32LE(total,40);pcm.copy(padded,44+Math.floor((total-pcm.length)/4)*2);
  const sparse=path.join(dir,'sparse.wav');await fs.writeFile(sparse,padded);
  const options={bin:process.env.WHISPER_BIN,model:process.env.WHISPER_MODEL,wavPaths:[wav],threads:2,timeoutMs:60000};
  for(const [label,vadModel,sample] of [['baseline',null,wav],['vad',process.env.WHISPER_VAD_MODEL,wav],['sparse-baseline',null,sparse],['sparse-vad',process.env.WHISPER_VAD_MODEL,sparse],['broken-vad-fallback','/nonexistent/norva-test-vad',wav]]){
   const engine=createStrictLidInference();const start=performance.now();
   const value=await engine.run({...options,wavPaths:[sample],vadModel},runWhisperBatchProcess);
   assert.equal(value.ok,true);assert.equal(value.samples.length,1);assert.equal(value.samples[0].lang,'en');
   assert.ok(value.samples[0].text.length>30);
   console.log(JSON.stringify({label,wallMs:Math.round(performance.now()-start),language:value.samples[0].lang,prob:value.samples[0].prob,textLength:value.samples[0].text.length,stats:engine.health()}));
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error('internal-smoke-failed',e.message);process.exitCode=1;});
