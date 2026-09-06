const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const base='../ops/hetzner/postal/full-transport-v1/';
const modules=Promise.all([import(base+'model.mjs'),import(base+'store.mjs'),import(base+'worker.mjs'),import('../supabase/functions/_shared/postal-mail-wire.mjs')]);
const mail=(to='controlled@example.test')=>({from:'Norva <support@norva.tv>',to:[to],reply_to:'support@norva.tv',subject:'Controlled fixture',html:'<p>Fixture</p>',text:'Fixture',tags:[{name:'flow',value:'support_reply'}]});
async function fixture(t,auth=false){const [{validateRequest},{MailStore},worker,wire]=await modules;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'norva-mail-proof-'));const key=crypto.randomBytes(32).toString('hex');
 const store=new MailStore(path.join(dir,'mail.sqlite'),key);let closed=false;
 const close=()=>{if(!closed){store.close();closed=true;}};t.after(close);
 const input={kind:'single',key:auth?'norva-auth-fixture-single':'fixture-key',messages:mail()};
 return {store,close,key,input,validateRequest,worker,wire,dir};}
test('atomic auth pair binds two distinct recipients and dedupes signed content',async t=>{
 const f=await fixture(t,true);f.input.kind='batch';f.input.messages=[mail('old@example.test'),mail('new@example.test')];
 const r=f.validateRequest(f.input),a=f.store.accept(r),b=f.store.accept(f.validateRequest({...f.input,key:'norva-auth-another-webhook'}));
 assert.equal(a.length,2);assert.deepEqual(a,b);assert.notEqual(a[0].id,a[1].id);
 assert.throws(()=>f.validateRequest({...f.input,messages:[mail(),mail()]}),/invalid_auth_pair/);
 assert.throws(()=>f.validateRequest({...f.input,messages:[mail()]}),/invalid_auth_pair/);
});
test('suppression rejects the entire pair before creating any job',async t=>{
 const f=await fixture(t,true);f.store.suppress(f.store.hash('new@example.test'),'complaint');
 assert.throws(()=>f.store.accept(f.validateRequest({kind:'batch',key:f.input.key,messages:[mail(),mail('new@example.test')]})),/suppressed/);
 assert.equal(f.store.status().counts.length,0);
});
test('strict bounded payload and header policy',async t=>{
 const f=await fixture(t);
 for(const patch of [{to:['a@example.test','b@example.test']},{to:['a@example.test\r\nBcc:x@y.test']},{from:'Third Party <x@outside.test>'},{headers:{Bcc:'x@y.test'}},{attachments:[{}]},{subject:'a\nb'},{html:'x'.repeat(180001)}])
  assert.throws(()=>f.validateRequest({...f.input,messages:{...mail(),...patch}}));
 const r=f.validateRequest({...f.input,messages:{...mail(),headers:{'List-Unsubscribe':'<https://norva.tv/unsubscribe?token=fixture>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}});
 assert.match(r.messages[0].headers['List-Unsubscribe'],/norva/);
});
test('queue persists encrypted payload and permanent idempotency across reopen',async t=>{
 const f=await fixture(t),r=f.validateRequest(f.input);f.store.accept(r);
 assert.throws(()=>f.store.accept(f.validateRequest({...f.input,messages:{...mail(),subject:'changed'}})),/idempotency_conflict/);
 const bytes=Buffer.concat(['mail.sqlite','mail.sqlite-wal'].filter(n=>fs.existsSync(path.join(f.dir,n))).map(n=>fs.readFileSync(path.join(f.dir,n))));
 assert.equal(bytes.includes(Buffer.from('controlled@example.test')),false);assert.equal(bytes.includes(Buffer.from('<p>Fixture')),false);
 const {MailStore}=await import(base+'store.mjs');const reopened=new MailStore(path.join(f.dir,'mail.sqlite'),f.key);t.after(()=>reopened.close());
 assert.deepEqual(reopened.accept(r),f.store.accept(r));assert.equal(reopened.payload(reopened.next()).message.to,'controlled@example.test');
});
test('queue limits reject whole auth batch rather than partial insertion',async t=>{
 const f=await fixture(t,true);const r=f.validateRequest({kind:'batch',key:f.input.key,messages:[mail(),mail('new@example.test')]});
 assert.throws(()=>f.store.accept(r,{dailyLimit:1}),/queue_limit/);assert.equal(f.store.status().counts.length,0);
});
test('AEAD request and response bind direction, id, timestamp and content',async t=>{
 const f=await fixture(t);const e=await f.wire.sealMailWire(f.input,f.key,'request');
 assert.deepEqual(await f.wire.openMailWire(e,f.key,'request'),f.input);
 await assert.rejects(f.wire.openMailWire(e,f.key,'response'));
 await assert.rejects(f.wire.openMailWire(e,f.key,'request',crypto.randomUUID()));
 await assert.rejects(f.wire.openMailWire({...e,t:e.t-400000},f.key,'request'));
 await assert.rejects(f.wire.openMailWire({...e,c:e.c.slice(0,5)+'AAAA'+e.c.slice(9)},f.key,'request'));
 await assert.rejects(f.wire.openMailWire(e,'0'.repeat(64),'request'));
});
test('ordinary business mail succeeds only on a TLS SMTP receipt and scrubs content',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));const calls=[];
 const runner=async v=>{calls.push(v.mode);return v.mode==='hold'?{held:true,messageId:8}:{state:'Sent',secure:true};};
 assert.equal(await f.worker.workOne({store:f.store,runner,authorize:async()=> 'allow',enabled:true}),'sent');
 assert.deepEqual(calls,['hold','dispatch']);assert.equal(f.store.next(),undefined);assert.equal(f.store.unsynced()[0].state,'sent');
 assert.equal(f.store.db.prepare('select cipher from jobs').get().cipher,null);
});
test('conversion after API hold cancels before DATA',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));let authorizations=0,calls=0;
 const r=await f.worker.workOne({store:f.store,runner:async v=>{calls++;assert.equal(v.mode,'hold');return {held:true,messageId:9};},authorize:async()=>++authorizations===1?'allow':'cancel',enabled:true});
 assert.equal(r,'canceled');assert.equal(calls,1);
});
test('uncertain DATA is terminal and never replayed',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));let calls=0;
 const opts={store:f.store,runner:async v=>{calls++;return v.mode==='hold'?{held:true,messageId:9}:{state:'unknown',secure:true,provedNoAcceptance:false};},authorize:async()=> 'allow',enabled:true};
 assert.equal(await f.worker.workOne(opts),'uncertain');assert.equal(await f.worker.workOne(opts),'idle');assert.equal(calls,2);
});
test('crash after API submission recovers by finding a receipt, never POST twice',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));
 await assert.rejects(f.worker.workOne({store:f.store,runner:async()=>{throw Error('crash');},authorize:async()=> 'allow',enabled:true}));
 assert.equal(f.store.next().state,'api_started');f.store.recover();const calls=[];
 await f.worker.workOne({store:f.store,runner:async v=>{calls.push(v.mode);return v.mode==='find'?{held:true,messageId:10}:{state:'Sent',secure:true};},authorize:async()=> 'allow',enabled:true});
 assert.deepEqual(calls,['find','dispatch']);
});
test('crash during SMTP is receipt-only on restart',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));
 await assert.rejects(f.worker.workOne({store:f.store,runner:async v=>{if(v.mode==='hold')return {held:true,messageId:11};throw Error('lost reply');},authorize:async()=> 'allow',enabled:true}));
 assert.equal(f.store.next().state,'sending');
 await f.worker.workOne({store:f.store,runner:async v=>{assert.equal(v.mode,'receipt');return {state:'Sent',secure:true};},authorize:async()=>{throw Error('must not authorize replay');},enabled:true});
 assert.equal(f.store.unsynced()[0].state,'sent');
});
test('known SMTP 4xx waits with bounded retry; an insecure success is not acknowledged',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));
 assert.equal(await f.worker.workOne({store:f.store,runner:async v=>v.mode==='hold'?{held:true,messageId:12}:{state:'retry',provedNoAcceptance:true},authorize:async()=> 'allow',enabled:true}),'retry');
 assert.equal(f.store.next(),undefined);f.store.db.exec('update jobs set next_at=0');
 assert.equal(await f.worker.workOne({store:f.store,runner:async()=>({state:'Sent',secure:false}),authorize:async()=> 'allow',enabled:true}),'uncertain');
});
test('expiry and disabled gate never send',async t=>{
 const f=await fixture(t);f.store.accept(f.validateRequest(f.input));const opt={store:f.store,runner:async()=>{throw Error('no send');},authorize:async()=>{throw Error('no authorization');}};
 assert.equal(await f.worker.workOne({...opt,enabled:false}),'disabled');f.store.db.exec('update jobs set expires=0');
 assert.equal(await f.worker.workOne({...opt,enabled:true}),'expired');
});

test('only bound no-source business email gets a 72h spool, never auth or other flows',async t=>{
 const f=await fixture(t);let now=1800000000000;f.store.now=()=>now;
 const cases=[
  ['norva-branded-70000000-0000-0000-0000-000000000001','behavioral_no_source',72*3600000],
  ['norva-branded-70000000-0000-0000-0000-000000000002','behavioral_import_unresolved',24*3600000],
  ['ordinary-key','behavioral_no_source',24*3600000],
  ['norva-auth-ttl-fixture','behavioral_no_source',15*60000],
 ];
 for(const [key,flow,ttl]of cases){
  const [job]=f.store.accept(f.validateRequest({kind:'single',key,messages:{...mail(),tags:[{name:'flow',value:flow}]}}));
  assert.equal(f.store.db.prepare('select expires-created as ttl from jobs where id=?').get(job.id).ttl,ttl);
 }
});

test('a newly granted push defers a held email past 24h, then resumes the same job once',async t=>{
 const f=await fixture(t);let now=1800000000000;f.store.now=()=>now;
 const request=f.validateRequest({kind:'single',key:'norva-branded-70000000-0000-0000-0000-000000000003',
  messages:{...mail(),tags:[{name:'flow',value:'behavioral_no_source'}]}});
 const [job]=f.store.accept(request);let checks=0;const calls=[];
 const runner=async v=>{calls.push(v.mode);return v.mode==='hold'?{held:true,messageId:19}:{state:'Sent',secure:true};};
 assert.equal(await f.worker.workOne({store:f.store,runner,authorize:async()=>++checks===1?'allow':'defer',enabled:true}),'deferred');
 assert.deepEqual(calls,['hold']);assert.equal(f.store.db.prepare('select attempts from jobs').get().attempts,0);
 f.close();
 now+=52*3600000;
 const {MailStore}=await import(base+'store.mjs');const reopened=new MailStore(path.join(f.dir,'mail.sqlite'),f.key,{now:()=>now});t.after(()=>reopened.close());
 assert.equal(reopened.accept(request)[0].id,job.id);
 assert.equal(await f.worker.workOne({store:reopened,runner,authorize:async()=> 'allow',enabled:true}),'sent');
 assert.deepEqual(calls,['hold','dispatch']);
 assert.equal(await f.worker.workOne({store:reopened,runner,authorize:async()=> 'allow',enabled:true}),'idle');
 assert.equal(reopened.db.prepare('select cipher from jobs where id=?').get(job.id).cipher,null);
});

test('deferred no-source email still cancels after conversion and has a hard expiry',async t=>{
 const f=await fixture(t);let now=1800000000000;f.store.now=()=>now;
 for(const suffix of ['4','5'])f.store.accept(f.validateRequest({kind:'single',
  key:'norva-branded-70000000-0000-0000-0000-00000000000'+suffix,
  messages:{...mail(),tags:[{name:'flow',value:'behavioral_no_source'}]}}));
 const runner=async()=>{throw Error('No provider call is allowed');};
 assert.equal(await f.worker.workOne({store:f.store,runner,authorize:async()=> 'cancel',enabled:true}),'canceled');
 now+=72*3600000+1;
 assert.equal(await f.worker.workOne({store:f.store,runner,authorize:async()=>{throw Error('expired');},enabled:true}),'expired');
 assert.equal(f.store.next(),undefined);
});
