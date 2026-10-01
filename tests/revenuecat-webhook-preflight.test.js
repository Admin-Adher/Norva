const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHmac } = require('node:crypto');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
// Execute the real HTTP preflight, stopping at the first business-event branch.
// No database client exists in this harness: TEST must return without a write.
const preflight = source.slice(source.indexOf('Deno.serve(async (req) => {') + 11,
  source.indexOf('  if (eventType === "TRANSFER")'));
const authHelpers = source.slice(source.indexOf('function verifyAuth('), source.indexOf('function msToIso('));

async function handler() {
  const boundary = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/revenuecat-transfer.mjs')).href);
  const code = transformSync(`return (${preflight}\nreturn json({businessEvent: true}, 299);\n});\n${authHelpers}`, {loader:'ts'}).code;
  return new Function('verifyRevenueCatWebhookSignature', 'revenueCatEventAppAllowed',
    'REVENUECAT_ALLOWED_APP_IDS', 'WEBHOOK_AUTH', 'REVENUECAT_WEBHOOK_HMAC_SECRET',
    'MAX_WEBHOOK_BYTES', 'json', 'stringOrNull', 'productionAdmin', code)(
      boundary.verifyRevenueCatWebhookSignature, boundary.revenueCatEventAppAllowed,
      boundary.parseRevenueCatAllowedAppIds('app_norva_phone'), 'test-auth', 'test-signing',
      2_000_000, (data,status=200)=>new Response(JSON.stringify(data),{status}),
      value=>typeof value==='string' ? value : null,
      new Proxy({}, {get(){throw new Error('Preflight must not access the database');}}));
}

function request(type, {app='synthetic_dashboard_app', auth='test-auth', signed=true, age=0, corrupt=false}={}) {
  const body = JSON.stringify({event:{type,app_id:app, id:'preflight-only'}});
  const timestamp = Math.floor(Date.now()/1000) - age;
  const signature = createHmac('sha256','test-signing').update(`${timestamp}.${body}`).digest('hex');
  return new Request('https://example.test/webhook', {method:'POST', body:corrupt ? body+' ' : body,
    headers:{Authorization:auth, ...(signed ? {'X-RevenueCat-Webhook-Signature':`t=${timestamp},v1=${signature}`} : {})}});
}

test('authenticated signed dashboard TEST is acknowledged without business processing', async()=>{
  const run=await handler();
  const result=await run(request('TEST'));
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{ok:true,test:true});
});

test('dashboard TEST cannot bypass authorization, signature integrity or freshness', async()=>{
  const run=await handler();
  for (const options of [{auth:'wrong'},{signed:false},{age:601},{corrupt:true}]) {
    assert.equal((await run(request('TEST',options))).status,401);
  }
});

test('real billing events still require the configured application after authentication', async()=>{
  const run=await handler();
  for (const type of ['INITIAL_PURCHASE','RENEWAL','CANCELLATION','TRANSFER']) {
    assert.equal((await run(request(type))).status,403);
    const accepted=await run(request(type,{app:'app_norva_phone'}));
    assert.equal(accepted.status,299);
    assert.deepEqual(await accepted.json(),{businessEvent:true});
  }
});
