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
  for (const locale of ['fr','en']) for (const period of ['monthly','annual']) {
    const r=renderPlayRetention({period,expiresAt:'2026-10-01T00:00:00Z'},{locale,unsubscribeUrl:'https://example.test/unsubscribe'});
    assert.match(r.text,/Google Play/); assert.match(r.text,/settings\/account/);
    assert.doesNotMatch(r.text,/checkout-revolut|subscription\?retention|\bUSD\b/);
    assert.equal(r.tags.find(t=>t.name==='flow').value,'play_retention_offer');
    assert.match(r.html,/example.test\/unsubscribe/);
  }
});
