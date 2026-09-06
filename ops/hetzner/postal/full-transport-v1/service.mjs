import http from 'node:http';
import fs from 'node:fs';
import {createPublicKey} from 'node:crypto';
import pg from 'pg';
import ssh2 from 'ssh2';
import {MailStore} from './store.mjs';
import {validateRequest,sha} from './model.mjs';
import {workOne} from './worker.mjs';
import {openMailWire,sealMailWire} from './postal-mail-wire.mjs';
import {verifyPostalWebhook} from './postal-webhook-verifier.mjs';
process.umask(0o077);
const config=()=>JSON.parse(fs.readFileSync('/private/config.json','utf8'));
const initial=config(),store=new MailStore('/data/mail.sqlite',initial.storeKey);
store.recover();
const pool=new pg.Pool({...initial.database,max:3,connectionTimeoutMillis:1500,idleTimeoutMillis:10000,
 statement_timeout:2500,query_timeout:3000,application_name:'norva-private-mail-v1'});
let stopping=false,busy=false,lastFault=null,lastFeedback=0,lastTick=0,guestVerified=false;
pool.on('error',()=>{lastFault='database_unavailable';});
const one=async(text,values=[])=>{const r=await pool.query({text,values});if(r.rows.length!==1)throw Error('sql_result');return r.rows[0].result;};
function runner(input){
 const c=config();return new Promise((resolve,reject)=>{
  const client=new ssh2.Client();let output=Buffer.alloc(0),done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);client.end();error?reject(Error('private_runner_failed')):resolve(value);};
  const timer=setTimeout(()=>finish(true),145000);
  client.on('error',()=>finish(true));
  client.on('ready',()=>client.exec('norva-full-mail-v1',(error,stream)=>{
   if(error)return finish(true);
   stream.on('data',chunk=>{output=Buffer.concat([output,chunk]);if(output.length>700000){stream.close();finish(true);}});
   stream.stderr.on('data',()=>{});
   stream.on('close',code=>{try{if(code!==0)throw Error();finish(false,JSON.parse(output.toString('utf8').trim()));}catch{finish(true);}});
   stream.end(JSON.stringify(input));
  }));
  client.connect({host:'127.0.0.1',port:22265,username:'postaladmin',privateKey:fs.readFileSync('/private/runner.key'),
   hostHash:'sha256',hostVerifier:h=>h===c.sshHostSha256,readyTimeout:7000,keepaliveInterval:10000,keepaliveCountMax:1});
 });
}
async function authorize({deliveryKey,message,jobId}){
 return one('select norva_postal_full.authorize($1,$2,$3,$4,$5) as result',
  [jobId,deliveryKey,message.to,message.auth,message.flow]);
}
async function sync(){
 for(const j of store.unsynced()){
  const r=await one('select norva_postal_full.receipt($1,$2,$3,$4) as result',[j.id,j.state,j.postal_id,j.secure===1]);
  if(r!==true)throw Error('receipt_not_persisted');store.synced(j.id);
 }
}
async function feedback(){
 const c=config(),out=await runner({mode:'feedback'});
 if(!Array.isArray(out.events)||out.events.length>16)throw Error('feedback_bounds');
 const key=createPublicKey({key:c.postalPublicJwk,format:'jwk'}).export({format:'pem',type:'spki'});
 for(const item of out.events){
  const headers=new Headers({'X-Postal-Signature-KID':c.postalPublicJwk.kid,'X-Postal-Signature-256':item.signature});
  const e=await verifyPostalWebhook(new Uint8Array(Buffer.from(item.body)),headers,{[c.postalPublicJwk.kid]:key},Date.now(),'mail');
  if(!e.valid||e.direction!=='outgoing'||e.deliveryKey!==item.tag)throw Error('feedback_signature_or_binding');
  const id='postal_'+item.tag.slice('norva-mail-'.length);
  const r=await one('select norva_postal_full.feedback($1,$2,$3,$4,$5,$6) as result',
   [id,e.eventId,sha(item.body),e.providerMessageId,e.event,new Date(e.timestamp).toISOString()]);
  if(!['applied','duplicate'].includes(r))throw Error('feedback_persistence');
  store.feedback(e.eventId,id,e.event);
  await runner({mode:'ack',requestId:item.requestId,tag:item.tag});
 }
 lastFeedback=Date.now();
}
async function tick(){
 if(stopping||busy)return;busy=true;
 try{
  if(!guestVerified){const health=await runner({mode:'health'});if(health.ok!==true)throw Error('guest_health');guestVerified=true;}
  await sync();
  if(Date.now()-lastFeedback>60000)await feedback();
  const c=config();
  const outcome=await workOne({store,runner,authorize,enabled:c.enabled===true});
  await sync();lastTick=Date.now();
  if(['uncertain','api_uncertain','failed'].includes(outcome))lastFault=outcome;
 }catch{lastFault='mail_worker_needs_review';}
 finally{busy=false;}
}
async function body(req){const chunks=[];let n=0;for await(const part of req){n+=part.length;if(n>1100000)throw Error('body_limit');chunks.push(part);}return JSON.parse(Buffer.concat(chunks).toString());}
const handler=async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 if(req.method==='GET'&&req.url==='/health'){
  res.end(JSON.stringify({service:'norva-private-mail-v1',enabled:config().enabled===true,guestVerified,busy,lastFault,
   lastTick,lastFeedback,...store.status()}));return;
 }
 if(req.method!=='POST'||req.url!=='/v1/mail'){res.writeHead(404);res.end('{}');return;}
 let envelope,c,authenticated=false;
 try{
  c=config();envelope=await body(req);
  const clear=await openMailWire(envelope,c.wireKey,'request');
  authenticated=true;
  let result;
  if(c.enabled!==true)result={status:503,body:{name:'postal_disabled'},retryAfter:60};
  else{
   const r=validateRequest(clear);
   // All recipients are checked before committing an authentication pair.
   const existing=store.existing(r);
   for(const m of existing?[]:r.messages){const allowed=await one('select norva_postal_full.preflight($1,$2,$3,$4) as result',[r.key,m.to,m.auth,m.flow]);
    if(allowed!==true)throw Error('recipient_or_source_ineligible');}
   const jobs=existing??store.accept(r,{dailyLimit:c.dailyLimit??1000,activeLimit:c.activeLimit??500});
   // Store is atomic and FULL-synchronous before an auth hook gets its ack.
   // Ordinary business outboxes only receive success after a TLS SMTP receipt.
   if(jobs.some(j=>['failed','canceled'].includes(j.state)))result={status:422,body:{name:'postal_terminal_failure'}};
   else if(jobs.some(j=>j.state==='uncertain'))result={status:409,body:{name:'postal_uncertain_do_not_replay'}};
   else if(r.auth||jobs.every(j=>j.state==='sent'&&j.secure===1)){
    if(!r.auth)await sync();
    const ids=jobs.map(j=>({id:j.id,provider:'postal',postal_message_id:j.postal_id,secure:j.secure===1}));
    result={status:200,body:r.kind==='batch'?{data:ids,provider:'postal',durable:r.auth}:ids[0]};
   }else result={status:425,body:{name:'postal_pending',provider:'postal'},retryAfter:15};
   setImmediate(tick);
  }
  res.end(JSON.stringify(await sealMailWire(result,c.wireKey,'response',envelope.id)));
 }catch(e){
  const messages={idempotency_conflict:409,queue_limit:429,recipient_suppressed:422,recipient_or_source_ineligible:422};
  const code=messages[e.message];
  if(code&&envelope?.id&&c){res.end(JSON.stringify(await sealMailWire({status:code,body:{name:e.message},retryAfter:code===429?60:undefined},c.wireKey,'response',envelope.id)));}
  else if(authenticated){res.end(JSON.stringify(await sealMailWire({status:503,body:{name:'postal_temporarily_unavailable'},retryAfter:30},c.wireKey,'response',envelope.id)));}
  else {res.writeHead(400);res.end('{"error":"mail_request_refused"}');}
 }
};
const server=http.createServer(handler);
const socketPath='/bridge/mail.sock';
if(fs.existsSync(socketPath)){
 const previous=fs.lstatSync(socketPath);
 if(!previous.isSocket()||previous.uid!==process.getuid())throw Error('foreign_socket');
 fs.unlinkSync(socketPath);
}
const unixServer=http.createServer(handler);
unixServer.headersTimeout=5000;unixServer.requestTimeout=8000;unixServer.maxConnections=12;unixServer.keepAliveTimeout=1000;
unixServer.listen(socketPath,()=>fs.chmodSync(socketPath,0o600));
server.headersTimeout=5000;server.requestTimeout=8000;server.maxConnections=12;server.keepAliveTimeout=1000;
server.listen(18185,'172.18.0.1',()=>{console.log('PRIVATE_POSTAL_MAIL_SERVICE_STARTED');tick();});
const timer=setInterval(tick,1500);timer.unref();
async function stop(){stopping=true;clearInterval(timer);server.close();unixServer.close();while(busy)await new Promise(r=>setTimeout(r,100));await pool.end();store.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
