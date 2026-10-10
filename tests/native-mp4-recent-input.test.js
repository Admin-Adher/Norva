'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { revalidateNativeRecentInput } = require('../services/media-gateway/src/native-mp4-recent-input');

for (const changed of ['none', 'bytes', 'target', 'partial']) test(`native recent input requires four fresh ranges, ${changed}`, async t => {
    const N=65536, size=8*N, target='c'.repeat(64), data=Buffer.alloc(size, 7);
    const binding={ownerKey:'a'.repeat(64),sourceUrlHash:'b'.repeat(64),profileHash:'d'.repeat(64),fileSizeBytes:size};
    const cache=new PrivateResumeHlsCache({recentRevalidation:true,perFileBytes:1024*1024});
    const samples=[0,N,2*N,3*N].map(start=>({start,payload:Buffer.from(data.subarray(start,start+N))}));
    assert.equal(cache.captureInput({binding,observed:{fileSizeBytes:size,effectiveUrlIdentitySha256:target,samples},inputWindows:[{start:0,payload:data}]}),true);
    let requests=0,closed=false;
    const server=http.createServer((req,res)=>{requests++;const [start,end]=req.headers.range.slice(6).split('-').map(Number);
        const bytes=Buffer.from(data.subarray(start,end+1));if(changed==='bytes'&&start===N)bytes[0]^=1;
        res.writeHead(206,{'Content-Length':changed==='partial'?bytes.length-1:bytes.length});res.end(changed==='partial'?bytes.subarray(0,-1):bytes);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const result=await revalidateNativeRecentInput({cache,binding,scope:{id:'test'},createBroker:async(signal,onIdentity,scope,plan)=>{
        assert.equal(plan.target,target);
        assert.equal(scope.id,'test');
        onIdentity({effectiveUrlIdentitySha256:changed==='target'?'e'.repeat(64):target});
        return {inputUrl:`http://127.0.0.1:${server.address().port}/file`,close:async()=>{closed=true;},takeFreshValidatedHeader:()=>({fresh:true})};
    }});
    assert.equal(closed,true);
    if(changed==='none') { assert.equal(requests,4);assert.deepEqual(result.snapshot.windows[0].payload,data);result.lease.release(); }
    else { assert.equal(result,null);assert.equal(requests,changed==='bytes'?4:1);
        if(changed==='partial') assert.ok(cache.inputRevalidationPlan(binding),'unavailable read preserves original bounded candidate');
    }
});
test('native input cache miss makes no provider request', async()=>{
    const cache=new PrivateResumeHlsCache({recentRevalidation:true});let opened=0;
    assert.equal(await revalidateNativeRecentInput({cache,binding:null,createBroker:()=>{opened++;}}),null);
    assert.equal(opened,0);
});
