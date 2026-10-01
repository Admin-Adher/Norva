const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {transformSync}=require('esbuild');
const source=fs.readFileSync(require('node:path').join(__dirname,'../supabase/functions/norva-source-sync/index.ts'),'utf8');
const start=source.indexOf('async function selfInvokeFinalize(');
const end=source.indexOf('type FinalizeCloudSourceOptions',start);
const compiled=transformSync(source.slice(start,end)+'\nmodule.exports=selfInvokeFinalize;',{loader:'ts',format:'cjs'}).code;
function harness(replies){
  const calls=[],warnings=[];
  const context={module:{exports:{}},SUPABASE_URL:'https://api.example',SUPABASE_SERVICE_KEY:'scoped-test',
    AbortSignal,console:{warn:(...args)=>warnings.push(args)},setTimeout:fn=>fn(),
    fetch:async(url,options)=>{
      calls.push({url,options});
      const reply=replies.shift();
      if(reply instanceof Error)throw reply;
      return new Response(JSON.stringify(reply?.body??{}),{status:reply?.status??503});
    }};
  vm.runInNewContext(compiled,context);
  return {run:()=>context.module.exports('owned-source','FR'),calls,warnings};
}
const accepted={status:200,body:{ok:true,started:true,sourceId:'owned-source'}};
test('accepted source-bound handoff returns immediately',async()=>{
  const h=harness([accepted]);assert.equal(await h.run(),true);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].options.method,'POST');assert.ok(h.calls[0].options.signal);
  assert.match(h.calls[0].url,/owned-source\?country=FR$/);
});
test('server failure and ambiguous timeout retry then accept the same source',async()=>{
  const h=harness([{status:502},new Error('timeout'),accepted]);
  assert.equal(await h.run(),true);assert.equal(h.calls.length,3);assert.equal(h.warnings.length,0);
});
test('missing or foreign receipts do not claim a successful handoff',async()=>{
  const h=harness([{status:200,body:{ok:true}},
    {status:200,body:{ok:true,started:true,sourceId:'foreign'}},{status:500}]);
  assert.equal(await h.run(),false);assert.equal(h.calls.length,3);assert.equal(h.warnings.length,1);
});
test('authority refusal stops retries and leaves recovery to the guarded watchdog',async()=>{
  for(const reply of [{status:401},{status:403},{status:404},{status:200,body:{ok:false}}]){
    const h=harness([reply,accepted]);assert.equal(await h.run(),false);assert.equal(h.calls.length,1);
  }
});
