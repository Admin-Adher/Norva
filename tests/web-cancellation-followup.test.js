const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const source = fs.readFileSync(path.join(__dirname, '../public/js/signup-email-preference.js'), 'utf8');
function fixture(user = { email: 'new@example.test', email_confirmed_at: '2026-10-01' }) {
  const storage = new Map(), requests = [];
  const ctx = vm.createContext({ Date, JSON, AbortSignal, sessionStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  }, window: { NorvaAuth: { getUser: async () => user, getAccessToken: async () => 'synthetic-token' } },
  fetch: async (_url, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true }; } });
  vm.runInContext(source, ctx);
  return { choice: ctx.window.NorvaSignupEmailPreference, requests, storage };
}
test('unchecked signup never creates consent; opt-in is bound to verified email and consumed once', async () => {
  const f = fixture(); f.choice.remember('new@example.test', false); await f.choice.apply();
  assert.equal(f.requests.length, 0);
  f.choice.remember(' NEW@example.test ', true); await f.choice.apply(); await f.choice.apply();
  assert.deepEqual(f.requests, [{ marketing_email: true, source: 'signup_checkbox' }]);
});
test('a different account, an unverified email or an expired choice cannot inherit consent', async () => {
  for (const user of [{email:'other@example.test',email_confirmed_at:'yes'}, {email:'new@example.test'}]) {
    const f = fixture(user); f.choice.remember('new@example.test', true); await f.choice.apply(); assert.equal(f.requests.length,0);
  }
  const f = fixture(); f.storage.set('norva-signup-email-choice-v1', JSON.stringify({email:'new@example.test',at:1}));
  await f.choice.apply(); assert.equal(f.requests.length,0);
});
test('cancellation receipt is localized, neutral and keeps the access boundary in all product languages', async () => {
  const {renderCancellationReceipt} = await importTypescriptModule(path.join(__dirname,'../supabase/functions/_shared/cancellation-email.ts'));
  for (const {code} of require('../i18n/locales.json')) {
    const result=renderCancellationReceipt({locale:code,effectiveAt:'2026-10-08T06:49:00Z'});
    assert.match(result.html,new RegExp(`lang="${code}"`));
    assert.ok(result.tags.some(t=>t.name==='category' && t.value==='transactional'));
    assert.doesNotMatch(result.text,/20\s*%|discount|offre|offer|unsubscribe/i);
    assert.match(result.text,/2026|२०२६|২০২৬|٢٠٢٦/);
  }
  const fr=renderCancellationReceipt({locale:'fr-FR',effectiveAt:'2026-10-08T06:49:00Z'});
  assert.match(fr.text,/8 octobre 2026/); assert.match(fr.text,/ne sera pas renouvelé/);
});
test('billing fast lane is authenticated and cannot run marketing/behavioral sweeps', () => {
  const worker=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-lifecycle/index.ts'),'utf8');
  const route=worker.indexOf('if (url.pathname.endsWith("/cron/billing-events"))');
  assert.ok(route>worker.indexOf('if (authErr || ok !== true)'));
  assert.match(worker.slice(route,route+200),/return json\(\{ ok: true, billing_events: await runBillingEventIntents\(db\) \}\)/);
});

test('a cancellation always queues a receipt; only consented Revolut owners get a separately gated offer', async () => {
  const worker=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-lifecycle/index.ts'),'utf8');
  const part=worker.slice(worker.indexOf('async function runBillingEventIntents('),worker.indexOf('async function runWelcome('));
  const js=require('esbuild').transformSync(part,{loader:'ts',target:'es2022'}).code;
  for(const [provider,consented,marketingFails] of [['revolut',false,false],['revolut',true,false],['google_play',true,false],['revolut',true,true]]) {
    const queued=[],rpc=[];
    const ctx=vm.createContext({ BILLING_LIVE:true,LC_WINBACK:true,MARKETING_READY:true,console:{warn(){}},
      intentIso:x=>x, billingIntentDedupe:async()=> 'unique-receipt',
      renderCancellationConfirmed:()=>({subject:'receipt'}), renderRetentionOffer:()=>({subject:'offer'}),
      marketingEmailAllowed:async()=>consented,
      queueUserEmail:async(_db,_user,make,options)=>{
        if(options.marketing && marketingFails)throw Error('transport unavailable');
        queued.push({rendered:make(null,{locale:'fr'}),options});return {durable:true,created:true,outboxId:'outbox'};
      }
    });
    vm.runInContext(js,ctx);
    const result=await ctx.runBillingEventIntents({rpc:async(name)=>{
      rpc.push(name);
      if(name==='claim_lifecycle_billing_intents')return {data:[{id:'intent',user_id:'owner',source_provider:provider,source_event_id:'cancel',event_type:'cancellation_confirmed',payload:{}}]};
      if(name==='norva_retention_offer')return {data:{id:'offer',charge_mode:'next_cycle'}};
      return {data:true};
    }});
    assert.equal(result.queued,1);assert.equal(result.retry_scheduled,0);
    assert.equal(queued[0].rendered.subject,'receipt');assert.equal(queued[0].options.marketing,undefined);
    const promotion=queued.find(x=>x.options.marketing);
    assert.equal(Boolean(promotion),provider==='revolut'&&consented&&!marketingFails);
    if(promotion) {assert.equal(promotion.options.markerKind,'retention');assert.equal(promotion.options.dedupeKey,'lifecycle:retention:offer:pre');}
    assert.ok(!rpc.includes('norva_retention_action'));
  }
});
