// Full signed HTTP hook + actual renderer + current provider adapter, with a
// controlled HTTP provider double. No real authentication mutation or email.
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHmac}=require('node:crypto');
const {bundleTypescriptModule}=require('./helpers/bundle-typescript-module');
const key=Buffer.alloc(32,19);
let handler;
const beforeDeno=globalThis.Deno,beforeFetch=globalThis.fetch,beforeLog=console.error;
const logs=[];
let postalDouble;
globalThis.Deno={env:{get:name=>({NORVA_POSTAL_WIRE_KEY:'7'.repeat(64),SEND_EMAIL_HOOK_SECRET:`v1,whsec_${key.toString('base64')}`,
  PUBLIC_SITE_URL:'https://norva.tv'})[name]},serve:fn=>{handler=fn;}};
const loading=bundleTypescriptModule(path.join(__dirname,'../supabase/functions/norva-auth-email/index.ts'));
const payload=()=>({user:{email:'current@example.test',new_email:'next@example.test'},email_data:{
  email_action_type:'email_change',token:'111111',token_new:'222222',token_hash:'next-fixture-hash',token_hash_new:'current-fixture-hash',
  redirect_to:'https://norva.tv/app#settings'}});
function request(body=payload(),id='hook-fixture',valid=true) {
  const text=JSON.stringify(body),ts=String(Math.floor(Date.now()/1000));
  const sig=createHmac('sha256',key).update(`${id}.${ts}.${text}`).digest('base64');
  return new Request('https://api.norva.tv/functions/v1/norva-auth-email',{method:'POST',body:text,
    headers:{'webhook-id':id,'webhook-timestamp':ts,'webhook-signature':`v1,${valid?sig:'invalid'}`}});
}
test.before(async()=>{await loading;({postalDouble}=await import('./helpers/postal-wire-double.mjs'));console.error=(...args)=>logs.push(args);});
test.after(()=>{globalThis.fetch=beforeFetch;console.error=beforeLog;
  if(beforeDeno===undefined)delete globalThis.Deno;else globalThis.Deno=beforeDeno;});

test('signed secure email change binds each actual rendered link to its recipient',async()=>{
  let calls=0;
  globalThis.fetch=postalDouble(async(r,init)=>{
    calls++;assert.equal(r.kind,'batch');
    const emails=r.messages;assert.equal(emails.length,2);
    assert.deepEqual(emails.map(x=>x.to),[['current@example.test'],['next@example.test']]);
    assert.ok(emails[0].html.includes('token_hash=current-fixture-hash'));
    assert.ok(!emails[0].html.includes('token_hash=next-fixture-hash'));
    assert.ok(emails[1].html.includes('token_hash=next-fixture-hash'));
    assert.ok(!emails[1].html.includes('token_hash=current-fixture-hash'));
    assert.ok(init.signal instanceof AbortSignal);
    return {status:200,body:{data:[{id:'current-receipt'},{id:'next-receipt'}]}};
  });
  assert.equal((await handler(request())).status,200);assert.equal(calls,1);
});
test('partial provider acknowledgement cannot falsely complete the two-email hook',async()=>{
  globalThis.fetch=postalDouble(async()=>({status:200,body:{data:[{id:'current-receipt'}]}}));
  const r=await handler(request());assert.equal(r.status,503);assert.equal((await r.json()).retryable,true);
});
test('duplicate acknowledgement IDs cannot stand in for two confirmations',async()=>{
  globalThis.fetch=postalDouble(async()=>({status:200,body:{data:[{id:'same'},{id:'same'}]}}));
  assert.equal((await handler(request())).status,503);
});
test('retry with a new webhook ID retains identical provider payload and idempotency authority',async()=>{
  const calls=[];
  globalThis.fetch=postalDouble(async(r)=>{calls.push(r);return {status:200,body:{data:[{id:'a'},{id:'b'}]}};});
  assert.equal((await handler(request(payload(),'first-webhook'))).status,200);
  assert.equal((await handler(request(payload(),'different-webhook'))).status,200);
  assert.deepEqual(calls[0].messages,calls[1].messages);assert.equal(calls[0].key,calls[1].key);
});
test('forged hook signature has no provider side effect',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};
  assert.equal((await handler(request(payload(),'forged',false))).status,401);assert.equal(calls,0);
});
test('missing new recipient is rejected before either confirmation is sent',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};const body=payload();delete body.user.new_email;
  assert.equal((await handler(request(body))).status,400);assert.equal(calls,0);
});
test('timeout fails safely without in-hook retry or second-provider fallback',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new DOMException('fixture','TimeoutError');};
  const r=await handler(request());assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'2');assert.equal(calls,1);
});
test('hook failure logs exclude addresses, action tokens and raw provider response',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({name:'fixture_error',message:'next@example.test next-fixture-hash'}),{status:500});
  await handler(request());assert.ok(logs.length>0);
  assert.doesNotMatch(JSON.stringify(logs),/current@example|next@example|next-fixture-hash|current-fixture-hash|synthetic-resend-key/);
});
