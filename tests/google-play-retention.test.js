const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const modulePath = path.join(__dirname, '../supabase/functions/_shared/play-retention.ts');

test('Play offer actions bind exclusively to the authenticated owner', async () => {
  const { playRetention } = await importTypescriptModule(modulePath);
  let called;
  const db = { rpc: async (name, args) => { called = {name,args}; return {data:{id:args.p_offer}}; } };
  const result = await playRetention(new Request('https://example.test', {method:'POST', body:JSON.stringify({
    action:'claim', offerId:'00000000-0000-4000-8000-000000000001', userId:'another-owner', price:1,
  })}), 'real-owner', db);
  assert.equal(result.body.contract, 1);
  assert.equal(called.args.p_user, 'real-owner');
  assert.deepEqual(Object.keys(called.args).sort(), ['p_action','p_offer','p_user']);
});
test('Ineligible, pending, invalid and unavailable Play claims fail closed', async () => {
  const { playRetention } = await importTypescriptModule(modulePath);
  for (const [data, error, expected] of [[null,null,409],[{pending:true},null,409],[null,{code:'db'},503]]) {
    const db = {rpc:async()=>({data,error})};
    const r=await playRetention(new Request('https://example.test',{method:'POST',body:JSON.stringify({action:'claim',offerId:'00000000-0000-4000-8000-000000000001'})}),'owner',db);
    assert.equal(r.status,expected);
  }
  for (const body of [{action:'accept',offerId:'00000000-0000-4000-8000-000000000001'},{action:'claim',offerId:'bad'},null]) {
    const r=await playRetention(new Request('https://example.test',{method:'POST',body:JSON.stringify(body)}),'owner',{rpc(){throw new Error('must not call');}});
    assert.equal(r.status,400);
  }
});
test('Play retention emails use store terms and never a web checkout', async () => {
  global.Deno = {env:{get:()=>''}};
  const {renderPlayRetention} = await importTypescriptModule(path.join(__dirname,'../supabase/functions/_shared/play-retention-email.ts'));
  const locales = require('../i18n/locales.json').map(x => x.code);
  const subjects = new Set();
  for (const locale of locales) for (const period of ['monthly','annual']) {
    const r=renderPlayRetention({period,expiresAt:'2026-10-01T00:00:00Z'},{locale,unsubscribeUrl:'https://example.test/unsubscribe'});
    assert.match(r.text,/Google Play/); assert.match(r.text,/settings\/account/);
    assert.doesNotMatch(r.text,/checkout-revolut|subscription\?retention|\bUSD\b/);
    assert.equal(r.tags.find(t=>t.name==='flow').value,'play_retention_offer');
    assert.match(r.html,/example.test\/unsubscribe/);
    assert.ok(r.html.includes(`lang="${locale}"`));
    subjects.add(r.subject);
  }
  assert.equal(subjects.size, locales.length);
});

test('confirmation is read-only, owner-scoped and requires a verified purchase', async () => {
  const { playRetention } = await importTypescriptModule(modulePath);
  const id='00000000-0000-4000-8000-000000000001';
  for (const [row,expected] of [
    [{state:'accepted',accepted_at:'2026-10-01',purchase_event:'verified'},'confirmed'],
    [{state:'accepted',accepted_at:'2026-10-01'},'pending'],
    [{state:'offered',claimed_at:'2026-10-01'},'pending'],
    [{state:'declined'},'declined'],
    [{state:'offered',expires_at:'2001-01-01'},'expired'],
    [{state:'offered'},'available'],
  ]) {
    const filters=[];
    const query={select(){return this;},eq(k,v){filters.push([k,v]);return this;},
      maybeSingle:async()=>({data:{expires_at:'2099-01-01',...row}})};
    const db={from: name=>{assert.equal(name,'cloud_play_retention_offers');return query;},rpc(){throw Error('no mutation');}};
    const result=await playRetention(new Request(`https://example.test?offerId=${id}&userId=other`),'real-owner',db);
    assert.equal(result.body.confirmation.state,expected);
    assert.deepEqual(filters,[['user_id','real-owner'],['id',id]]);
    assert.deepEqual(Object.keys(result.body.confirmation),['state']);
  }
});

test('invalid, missing and unavailable confirmation cannot become success', async () => {
  const { playRetention }=await importTypescriptModule(modulePath);
  const invalid=await playRetention(new Request('https://example.test?offerId=bad'),'owner',{from(){throw Error('invalid query');}});
  assert.equal(invalid.status,400);
  for (const [result,status] of [[{data:null},404],[{error:{}},503]]) {
    const q={select(){return this;},eq(){return this;},maybeSingle:async()=>result};
    const r=await playRetention(new Request('https://example.test?offerId=00000000-0000-4000-8000-000000000001'),'owner',{from:()=>q});
    assert.equal(r.status,status);
    assert.equal(r.body.confirmation,undefined);
  }
});

test('reopening the offer remembers the owner pending purchase without granting access', async()=>{
  const {playRetention}=await importTypescriptModule(modulePath);
  const filters=[];
  const db={rpc:async()=>({data:{id:'quote'}}),from(table){
    return {select(){return this;},eq(k,v){filters.push([table,k,v]);return this;},gte(){return this;},order(){return this;},limit(){return this;},
      maybeSingle:async()=>({data:table==='cloud_play_retention_preferences'?{push_opt_in:false}:{id:'claim',state:'offered'}})};
  }};
  const result=await playRetention(new Request('https://example.test'),'owner',db);
  assert.deepEqual(result.body.confirmation,{offerId:'claim',state:'pending'});
  assert.equal(result.body.pushOptIn,false);
  assert.equal(filters.filter(([,k,v])=>k==='user_id'&&v==='owner').length,2);
});

test('mobile cancellation receipts never direct a store subscriber to web billing', async()=>{
  const {renderCancellationReceipt}=await importTypescriptModule(path.join(__dirname,'../supabase/functions/_shared/cancellation-email.ts'));
  for (const {code} of require('../i18n/locales.json')) for (const provider of ['google_play','store','revolut']) {
    const r=renderCancellationReceipt({locale:code,effectiveAt:'2026-10-08T12:00:00Z',provider});
    if(provider==='google_play')assert.match(r.text,/play\.google\.com\/store\/account\/subscriptions/);
    if(provider!=='revolut')assert.doesNotMatch(r.text,/norva\.tv\/subscription|checkout-revolut/);
    else assert.match(r.text,/norva\.tv\/subscription/);
    assert.doesNotMatch(r.text,/20\s*%|10\s*%/);
    assert.equal(r.tags.find(t=>t.name==='category').value,'transactional');
  }
});
