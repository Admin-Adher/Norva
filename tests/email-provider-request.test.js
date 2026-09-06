const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const boundary=import('../supabase/functions/_shared/email-provider-request.mjs');
const doubles=import('./helpers/postal-wire-double.mjs');
const request=()=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'norva-internal-fixture'},
 body:JSON.stringify({from:'Norva <support@norva.tv>',to:['owner@example.test'],text:'fixture-private-token'}),signal:AbortSignal.timeout(4000)});

test('Postal boundary encrypts exact single/batch content and preserves deadline and stable authority',async()=>{
 const {requestEmailProvider}=await boundary;const{key,postalDouble}=await doubles;
 for(const batch of [false,true]){
  const init=request();if(batch)init.body=`[${init.body},${init.body}]`;let calls=0;
  const response=await requestEmailProvider(batch?'postal:batch':'postal:send',init,{wireKey:key,
   fetchImpl:postalDouble(async(clear,wire)=>{
    calls++;assert.equal(clear.kind,batch?'batch':'single');assert.equal(clear.key,init.headers['Idempotency-Key']);
    assert.deepEqual(clear.messages,JSON.parse(init.body));assert.equal(wire.signal,init.signal);
    assert.ok(!wire.body.includes('fixture-private-token'));
    return{status:200,body:{id:'postal_fixture'}};
   })});
  assert.deepEqual(await response.json(),{id:'postal_fixture'});assert.equal(calls,1);
 }
});
test('No Resend, public Postal or arbitrary URL may be selected',async()=>{
 const{requestEmailProvider}=await boundary;
 for(const operation of ['https://api.resend.com/emails','https://postal.norva.tv/api/v1/send/message','http://norva-private-mail-gateway:18185/v1/mail','postal:send?redirect=1']){
  await assert.rejects(requestEmailProvider(operation,request(),{fetchImpl:()=>assert.fail('network')}),/email_operation_not_allowed/);
 }
});
test('Invalid metadata and missing encryption key fail before network I/O',async()=>{
 const{requestEmailProvider}=await boundary;
 for(const change of [{method:'GET'},{body:null},{signal:undefined},{headers:{}},{headers:{...request().headers,'Idempotency-Key':'bad key'}}]){
  await assert.rejects(requestEmailProvider('postal:send',{...request(),...change},{fetchImpl:()=>assert.fail('network')}),/invalid_email_transport_request/);
 }
 await assert.rejects(requestEmailProvider('postal:send',request(),{wireKey:'',fetchImpl:()=>assert.fail('network')}));
});
test('A timeout never triggers a hidden retry or provider fallback',async()=>{
 const{requestEmailProvider}=await boundary;const{key}=await doubles;let calls=0;
 const error=new DOMException('fixture','TimeoutError');
 await assert.rejects(requestEmailProvider('postal:send',request(),{wireKey:key,fetchImpl:async()=>{calls++;throw error;}}),e=>e===error);
 assert.equal(calls,1);
});
test('Durable queue pending is not SMTP success and preserves retry delay',async()=>{
 const{requestEmailProvider}=await boundary;const{key,postalDouble}=await doubles;
 const r=await requestEmailProvider('postal:send',request(),{wireKey:key,fetchImpl:postalDouble(async()=>({status:425,body:{name:'postal_pending'},retryAfter:15}))});
 assert.equal(r.status,425);assert.equal(r.ok,false);assert.equal(r.headers.get('retry-after'),'15');
});
test('All ten real sending boundaries use the private Postal request with no Resend key dependency',()=>{
 const senders=['norva-auth-email/index.ts','norva-auth-challenge/index.ts','norva-support/index.ts','norva-account-delete/index.ts','norva-import-notify/index.ts','norva-revolut-billing/index.ts','norva-provider-access-notify/index.ts','norva-playback/index.ts','_shared/ops-notifications.ts','_shared/resend-transport.mjs'];
 for(const file of senders){const code=fs.readFileSync(path.join(__dirname,'../supabase/functions',file),'utf8');
  assert.match(code,/import \{ requestEmailProvider \}/,file);assert.match(code,/await requestEmailProvider\(/,file);
  assert.doesNotMatch(code,/https:\/\/api\.resend\.com|RESEND_API_KEY/,file);
 }
});
