const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..');

function load(file,globals={}) {
  const code=esbuild.buildSync({entryPoints:[path.join(root,file)],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
  const sandbox={module:{exports:{}},exports:{},Date,Intl,TextEncoder,TextDecoder,Response,Headers,AbortSignal,DOMException,btoa,atob,crypto:webcrypto,encodeURIComponent,console,...globals};
  vm.runInNewContext(code,sandbox);return sandbox.module.exports;
}
const routing=load('supabase/functions/_shared/telegram-routing.mjs');
const env=(values)=>({get:k=>values[k]});
test('six explicit category routes, strict mode and partial configuration cannot leak',()=>{
  assert.equal(routing.TELEGRAM_CATEGORIES.length,6);
  const legacy={TELEGRAM_BOT_TOKEN:'old',TELEGRAM_CHAT_ID:'oldchat'};
  assert.equal(routing.telegramCredentials(env(legacy),'growth').token,'old');
  assert.equal(routing.telegramCredentials(env({...legacy,TELEGRAM_GROWTH_BOT_TOKEN:'new'}),'growth').chatId,'');
  assert.equal(routing.telegramCredentials(env({...legacy,TELEGRAM_CATEGORY_ROUTING_STRICT:'1'}),'growth').token,'');
  assert.throws(()=>routing.telegramCredentials(env({}),'bogus'));
});
test('all operational families and crons route deterministically',()=>{
  for(const [key,category] of Object.entries({sources_error:'catalogue',sources_incomplete:'catalogue',lid_cascade_expired:'catalogue',gateway_down:'catalogue',relay_down:'catalogue',billing_past_due:'finance',vat_threshold:'finance',partners_kyc_quota_warning:'partners',support_stale:'support',snapshot_stale:'infrastructure','cron:norva-revolut-billing':'finance','cron:norva-signup-telegram-delivery':'growth','cron:norva-playback-language-validation-worker':'catalogue','cron:partners-health':'partners'}))assert.equal(routing.opsTelegramCategory(key),category,key);
});
test('long HTML is complete and safely chunked without splitting emoji',()=>{
  const text='<b>'+('é&lt;&amp;🎬'.repeat(1500))+'</b>';
  const chunks=routing.telegramMessageChunks(text);
  assert.ok(chunks.length>1);
  for(const c of chunks){assert.ok(c.text.length<=3900);assert.equal(c.parse_mode,undefined);assert.doesNotMatch(c.text,/\uFFFD/);}
  assert.equal(chunks.map(c=>c.text).join(''),'é<&🎬'.repeat(1500));
});
test('transport acknowledges JSON ok and message id, routes growth, and hides provider diagnostics',async()=>{
  const calls=[];
  const api=load('supabase/functions/_shared/telegram.ts',{Deno:{env:env({TELEGRAM_GROWTH_BOT_TOKEN:'growth-secret',TELEGRAM_GROWTH_CHAT_ID:'growth-chat'})},fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:{message_id:42}})};}});
  assert.equal((await api.sendTelegramDetailed('Essai',{category:'growth'})).accepted,true);
  assert.equal(calls[0].body.chat_id,'growth-chat');assert.ok(calls[0].url.includes('growth-secret'));
  assert.equal((await api.sendTelegramDetailed('Other',{category:'finance'})).accepted,false);
});

function fakeDb(initial=[]) {
  const rows=structuredClone(initial), writes=[];
  return {rows,writes,from(table){assert.equal(table,'admin_alert_delivery_state');return {
    select:async()=>({data:rows}),
    upsert:async(items)=>{writes.push({type:'upsert',items});for(const i of items){const idx=rows.findIndex(r=>r.category===i.category&&r.channel===i.channel&&r.key===i.key);if(idx<0)rows.push(i);else rows[idx]=i;}return {error:null};},
    delete(){const filter={};return {eq(k,v){filter[k]=v;return this;},async in(k,values){writes.push({type:'delete',filter,values});for(let i=rows.length-1;i>=0;i--)if(Object.entries(filter).every(([k,v])=>rows[i][k]===v)&&values.includes(rows[i][k]))rows.splice(i,1);return {error:null};}};}
  };}};
}
function opsRuntime(failingChat) {
  const values={NORVA_POSTAL_WIRE_KEY:'7'.repeat(64),TELEGRAM_CATEGORY_ROUTING_STRICT:'1'};
  for(const c of routing.TELEGRAM_CATEGORIES){values[`TELEGRAM_${c.toUpperCase()}_BOT_TOKEN`]=c;values[`TELEGRAM_${c.toUpperCase()}_CHAT_ID`]=c;}
  const calls=[];
  const api=load('supabase/functions/_shared/ops-notifications.ts',{Deno:{env:env(values)},fetch:async(url,options)=>{
    if(url.includes('norva-private-mail-gateway')){
      const {postalDouble}=await import('./helpers/postal-wire-double.mjs');
      return postalDouble(async(clear)=>{calls.push(clear.messages);return{status:200,body:{id:'postal_accepted'}};})(url,options);
    }
    const body=JSON.parse(options.body);calls.push(body);
    return {ok:body.chat_id!==failingChat,status:body.chat_id===failingChat?503:200,text:async()=>JSON.stringify({ok:body.chat_id!==failingChat,result:{message_id:1}})};
  }});
  return {api,calls};
}
test('one failed category is retried without resending successful categories or email',async()=>{
  const db=fakeDb(),run=opsRuntime('catalogue');
  const problems=[{key:'sources_incomplete',detail:'source'},{key:'billing_past_due',detail:'billing'}];
  await run.api.dispatchOpsNotifications(db,problems,'ops@example.test');
  assert.equal(db.rows.length,3);
  run.calls.length=0;
  await run.api.dispatchOpsNotifications(db,problems,'ops@example.test');
  assert.equal(run.calls.length,1);assert.equal(run.calls[0].chat_id,'catalogue');
});
test('recovery clears only the acknowledged channel, preserves original category and retries',async()=>{
  const base={category:'partners',key:'partners_test',details:'safe',last_alerted_at:new Date(Date.now()-7*3600000).toISOString()};
  const db=fakeDb([{...base,channel:'email'},{...base,channel:'telegram'}]);
  const failing=opsRuntime('partners');await failing.api.dispatchOpsNotifications(db,[],'ops@example.test');
  assert.equal(db.rows.length,1);assert.equal(db.rows[0].channel,'telegram');
  const passing=opsRuntime();await passing.api.dispatchOpsNotifications(db,[],'ops@example.test');
  assert.equal(db.rows.length,0);assert.equal(passing.calls[0].chat_id,'partners');
});
test('flapping source and overlapping LID incident do not generate false recoveries',async()=>{
  const db=fakeDb(['sources_error','lid_cascade_expiring'].map(key=>({category:'catalogue',channel:'telegram',key,details:key,last_alerted_at:new Date().toISOString()})));
  const run=opsRuntime();await run.api.dispatchOpsNotifications(db,[{key:'lid_cascade_expired',detail:'expired'}],'');
  assert.ok(run.calls.every(c=>!c.text.includes('résolu')));assert.equal(db.rows.length,3);
});
test('trial outbox is authoritative, idempotent, leased, private and not backfilled',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260904194500_trial_telegram_outbox.sql'),'utf8');
  for(const expected of ['after insert or update on public.cloud_entitlement_projection',"new.status <> 'trialing'",'new.trial_consumed_at is null','new.trial_ends_at <= clock_timestamp()','old.trial_consumed_at is not null','admin_internal_accounts','on conflict(user_id) do nothing','for update skip locked','lease_token=p_lease','attempt_count >= 12','enable row level security'])assert.ok(sql.includes(expected),expected);
  assert.doesNotMatch(sql,/insert into public.cloud_trial_telegram_outbox[\s\S]{0,150}select /i);
});
