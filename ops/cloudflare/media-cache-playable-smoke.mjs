import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PrivateMediaCacheStoreClient}=require('/app/src/privateMediaCacheStoreClient');
const {SharedHlsObjectPublisher}=require('/app/src/sharedHlsObjectPublisher');
const {deriveGlobalMediaCacheObjectKey}=require('/app/src/mediaCacheIdentity');
const exec=promisify(execFile);
const base='https://media-cache.norva.tv';
const service=process.env.MEDIA_CACHE_CANARY_SERVICE_TOKEN;
const manifest=process.env.MEDIA_CACHE_CANARY_MANIFEST_HMAC_KEY;
const secret=process.env.MEDIA_CACHE_CANARY_TICKET_HMAC_KEY;
if(!service||!manifest||!secret)throw Error('Missing smoke configuration');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'norva-playable-cache-'));
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function ticket(objectKey,session) {
 const now=Date.now();const p={bindingId:crypto.randomUUID(),expiresAtMs:now+120000,issuedAtMs:now,nonce:crypto.randomBytes(16).toString('base64url'),objectKey,playbackSessionId:session,schema:1};
 const encoded=Buffer.from(canonical(p)).toString('base64url');
 return 'mc1.'+encoded+'.'+crypto.createHmac('sha256',Buffer.from(secret,'hex')).update('norva-media-cache-ticket-v1\0'+encoded).digest('base64url');
}
async function request(url,options={}) {return fetch(url,{...options,signal:AbortSignal.timeout(20000)});}
const ffmpeg=async args=>exec('ffmpeg',['-hide_banner','-loglevel','error','-nostdin',...args],{timeout:30000,maxBuffer:1024*1024});
let objectKey=null;let published=false;let report;
try {
 const source=path.join(dir,'source.mp4');
 await ffmpeg(['-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','20','-sc_threshold','0','-c:a','aac','-metadata:s:a:0','language=eng',source]);
 const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',source],{timeout:10000})).stdout);
 const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio');
 const [num,den]=video.r_frame_rate.split('/').map(Number);
 const bytes=await fs.readFile(source);
 const identity={contentSha256:sha(bytes),fileSizeBytes:bytes.length,videoProfile:{streamIndex:video.index,codec:video.codec_name,profile:video.profile,level:video.level,width:video.width,height:video.height,pixelFormat:video.pix_fmt,frameRateNumerator:num,frameRateDenominator:den},audioTopology:[{streamIndex:audio.index,codec:audio.codec_name,language:'eng',channels:audio.channels,sampleRate:Number(audio.sample_rate),title:null,default:true,forced:false}],subtitleTopology:[],durationMilliseconds:Math.round(Number(probe.format.duration)*1000),pipelineBuild:'qa-generated-h264-aac-'+crypto.randomUUID(),segmenterBuild:'qa-ffmpeg-copy-hls-v1'};
 objectKey=deriveGlobalMediaCacheObjectKey(identity).key;
 const output=path.join(dir,'out');await fs.mkdir(output);
 await ffmpeg(['-i',source,'-c','copy','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename',path.join(output,'segment-%03d.ts'),path.join(output,'index.m3u8')]);
 const files=await fs.readdir(output);
 const store=new PrivateMediaCacheStoreClient({baseUrl:base,serviceToken:service,timeoutMs:20000,retryDelaysMs:[200]});
 const publisher=new SharedHlsObjectPublisher({objectStore:store,manifestHmacKey:manifest,ttlMs:3600000,maxFiles:64,maxEntryBytes:16777216});
 published=true;
 await publisher.publish({identity,sourceDirectory:output,rootPlaylist:'index.m3u8',files,completion:{kind:'complete-hls',sourceEof:true,ffmpegExitCode:0}});
 const session=crypto.randomUUID(),auth={authorization:'Bearer '+ticket(objectKey,session),origin:'https://norva.tv'};
 const target=base+'/v1/hls/'+objectKey+'/';
 const anonymous=await request(target+'index.m3u8');await anonymous.body?.cancel();if(anonymous.status!==401)throw Error('Anonymous request accepted');
 const wrong=await request(target+'index.m3u8',{headers:{...auth,authorization:'Bearer '+ticket('0'.repeat(64),crypto.randomUUID())}});await wrong.body?.cancel();if(wrong.status!==403)throw Error('Cross-object ticket accepted');
 const downloaded=path.join(dir,'download');await fs.mkdir(downloaded);const layers=[];
 for(const file of files) {
  const response=await request(target+file,{headers:auth});const body=Buffer.from(await response.arrayBuffer());
  if(!response.ok||sha(body)!==sha(await fs.readFile(path.join(output,file))))throw Error('Cache bytes differ');
  layers.push(response.headers.get('x-norva-cache-layer'));await fs.writeFile(path.join(downloaded,file),body);
 }
 const decoded=await ffmpeg(['-i',path.join(downloaded,'index.m3u8'),'-threads','1','-progress','pipe:1','-f','null','-']);
 const times=[...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map(m=>Number(m[1]));
 const seconds=Math.max(...times)/1000000;if(seconds<5.5)throw Error('Incomplete decoded playback');
 const revoke=await request(base+'/internal/v1/revocations/'+session,{method:'PUT',headers:{authorization:'Bearer '+service}});await revoke.body?.cancel();if(!revoke.ok)throw Error('Revocation refused');
 await new Promise(r=>setTimeout(r,2200));
 const denied=await request(target+'index.m3u8',{headers:auth});await denied.body?.cancel();if(denied.status!==403)throw Error('Revoked ticket accepted');
 report={ok:true,objectKey,files:files.length,sourceBytes:bytes.length,decodedSeconds:seconds,videoCodec:video.codec_name,audioCodec:audio.codec_name,width:video.width,height:video.height,bytesPreserved:true,anonymousDenied:true,crossObjectDenied:true,revocationDenied:true,layers};
} finally {
 if(published&&objectKey) {
  const response=await request(base+'/internal/v1/cache-objects/'+objectKey,{method:'DELETE',headers:{authorization:'Bearer '+service,'x-norva-purge-reason':'eviction'}});
  const result=await response.json();if(!response.ok||!result.globalEdgePurgeCompleted)throw Error('QA cleanup failed');
  if(report)report.purgedObjects=result.objectsPurged;
 }
 await fs.rm(dir,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
