const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {bundleTypescriptModule}=require('./helpers/bundle-typescript-module');
test('OTP requires a complete acknowledgement, not just HTTP 200',async()=>{
  const beforeDeno=globalThis.Deno,beforeFetch=globalThis.fetch;
  const {key,postalDouble}=await import('./helpers/postal-wire-double.mjs');
  globalThis.Deno={env:{get:name=>name==='NORVA_POSTAL_WIRE_KEY'?key:undefined}};
  try {
    const {sendChallenge}=await bundleTypescriptModule(path.join(__dirname,'../supabase/functions/norva-auth-challenge/index.ts'));
    for(const [body,status,expected] of [['{}',200,false],['not-json',200,false],['{"id":null}',200,false],
      ['{"id":"receipt-1"}',500,false],['{"id":"receipt-1"}',200,true]]) {
      let calls=0;globalThis.fetch=postalDouble(async(r)=>{
        calls++;assert.equal(r.kind,'single');assert.equal(r.key,'norva-mailbox-proof-fixture');
        let value;try{value=JSON.parse(body);}catch{value=body;}
        return {status,body:value};
      });
      assert.equal(await sendChallenge('owner@example.test','123456','fixture'),expected);assert.equal(calls,1);
    }
  } finally {globalThis.fetch=beforeFetch;if(beforeDeno===undefined)delete globalThis.Deno;else globalThis.Deno=beforeDeno;}
});
