'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { pipeNativeMp4 } = require('../services/media-gateway/src/native-mp4-sessions');

test('real native HTTP adapter translates full GET and preserves exact seek and HEAD semantics', async t => {
    const body = Buffer.from('native finite movie');
    const observed = [];
    const broker = http.createServer((req, res) => {
        observed.push([req.method, req.headers.range]);
        res.setHeader('Accept-Ranges', 'bytes');
        if (req.method === 'HEAD') { res.setHeader('Content-Length',body.length); return res.end(); }
        if (!['bytes=0-', 'bytes=7-12'].includes(req.headers.range)) {
            res.writeHead(416, {'Content-Range':`bytes */${body.length}`}); return res.end();
        }
        const start=req.headers.range==='bytes=0-'?0:7;
        const end=req.headers.range==='bytes=0-'?body.length-1:12;
        res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${body.length}`});
        res.end(body.subarray(start,end+1));
    }).listen(0,'127.0.0.1');
    await once(broker,'listening');
    const entry={ac:new AbortController(),closed:false,claims:{scope:'native-vod-recovery'}};
    const adapter=http.createServer((req,res)=>void pipeNativeMp4(req,res,entry,
        {inputUrl:`http://127.0.0.1:${broker.address().port}/finite`}))
        .listen(0,'127.0.0.1');
    await once(adapter,'listening');
    t.after(async()=>{adapter.closeAllConnections();broker.closeAllConnections();await Promise.all([
        new Promise(r=>adapter.close(r)),new Promise(r=>broker.close(r))]);});
    const url=`http://127.0.0.1:${adapter.address().port}/native.mp4`;
    const full=await fetch(url);
    assert.equal(full.status,200);
    assert.equal(full.headers.get('content-length'),String(body.length));
    assert.equal(full.headers.get('content-range'),null);
    assert.equal(full.headers.get('content-type'),'application/octet-stream');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),body);
    const seek=await fetch(url,{headers:{Range:'bytes=7-12'}});
    assert.equal(seek.status,206);
    assert.equal(seek.headers.get('content-range'),`bytes 7-12/${body.length}`);
    assert.deepEqual(Buffer.from(await seek.arrayBuffer()),body.subarray(7,13));
    const head=await fetch(url,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(body.length));
    assert.equal((await head.arrayBuffer()).byteLength,0);
    const bad=await fetch(url,{headers:{Range:'bytes=999-'}});
    assert.equal(bad.status,416);assert.equal(bad.headers.get('content-range'),`bytes */${body.length}`);
    await bad.arrayBuffer();
    assert.deepEqual(observed,[['GET','bytes=0-'],['GET','bytes=7-12'],['HEAD',undefined],['GET','bytes=999-']]);
});
