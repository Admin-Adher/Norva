const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual socket parser/body, with a Workers-native byte stream.
// A generic JS stream cannot reproduce readAtLeast or the per-fragment work
// that exhausted the production Worker's CPU allowance.
test('socket fallback batches fragments after headers, preserves bytes and cancels promptly', async () => {
  const { Miniflare } = require('miniflare');
  const root = path.join(__dirname, '../services/norva-relay/src');
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const socketCode = source.slice(source.indexOf('function indexOfDoubleCRLF('),
    source.indexOf('// Normalize one Xtream get_vod_info'));
  assert.ok(socketCode.includes('async function fetchNodeViaSocket('));
  const streamCode = fs.readFileSync(path.join(root, 'relayProgressiveStream.mjs'), 'utf8');
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-06-18', host: '127.0.0.1', port: 0,
    script: streamCode + `
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    export default {async fetch(request) {
      const mode = new URL(request.url).pathname;
      const total = 1024 * 1024 + 79;
      const native = new IdentityTransformStream(), writer = native.writable.getWriter();
      const stats = {defaultReads:0,batches:[],closed:0,cancelled:0};
      const head = encoder.encode('HTTP/1.1 206 Partial Content\\r\\nContent-Length: '+total+
        '\\r\\nContent-Range: bytes 0-'+(total-1)+'/'+total+'\\r\\nETag: W/"weak-is-still-streamable"\\r\\n\\r\\n');
      const producer = (async()=>{
        // Fragment the header, including the CRLF terminator, and then tiny
        // provider packets. No new request or body identity is manufactured.
        await writer.write(head.slice(0,17));
        await writer.write(head.slice(17,head.length-1));
        const leftover = mode === '/leftover' ? 73 : 0;
        const lastHeader = new Uint8Array(1+leftover);lastHeader[0]=head[head.length-1];
        for(let i=0;i<leftover;i++)lastHeader[i+1]=i%251;
        await writer.write(lastHeader);
        const limit = mode === '/cancel' ? 16384 : total;
        for(let offset=leftover;offset<limit;offset+=512){
          const bytes=new Uint8Array(Math.min(512,limit-offset));
          for(let i=0;i<bytes.length;i++)bytes[i]=(offset+i)%251;
          await writer.write(bytes);
        }
        if(mode !== '/cancel')await writer.close();
      })().catch(()=>{});
      const connect = () => ({opened:Promise.resolve(),
        writable:new WritableStream({write(){}}),
        readable:{getReader(options){
          const reader=native.readable.getReader(options);
          const wrapped={read(){stats.defaultReads++;return reader.read();},
            cancel(reason){stats.cancelled++;return reader.cancel(reason);},
            releaseLock(){reader.releaseLock();}};
          if(typeof reader.readAtLeast==='function')wrapped.readAtLeast=(n,view)=>{
            stats.batches.push(n);return reader.readAtLeast(n,view);};
          return wrapped;
        }},close(){stats.closed++;}});
      ${socketCode}
      const response=await fetchNodeViaSocket(new URL('http://provider.invalid:8080/movie/u/p/1.mp4'),
        mode === '/head' ? 'HEAD' : 'GET','bytes=0-'+(total-1),'test-agent');
      if(mode === '/head'){
        await producer;return Response.json({stats,body:response.body,status:response.status});
      }
      if(mode === '/cancel'){
        const reader=response.body.getReader();
        const first=await reader.read();
        const pending=reader.read();
        await reader.cancel('viewer-back');
        await pending;await producer;
        return Response.json({stats,firstBytes:first.value?.length});
      }
      const bytes=new Uint8Array(await new Response(response.body).arrayBuffer());
      await producer;
      let exact=bytes.length===total;
      for(let i=0;i<bytes.length;i++)if(bytes[i]!==i%251){exact=false;break;}
      return Response.json({stats,exact,length:bytes.length,status:response.status,
        contentRange:response.headers.get('content-range'),etag:response.headers.get('etag')});
    }};` });
  try {
    const url = await mf.ready;
    const full = await (await fetch(url)).json();
    assert.equal(full.exact, true);
    assert.equal(full.status, 206);
    assert.equal(full.contentRange, 'bytes 0-1048654/1048655');
    assert.equal(full.etag, 'W/"weak-is-still-streamable"');
    assert.ok(full.stats.defaultReads <= 3, 'only the header uses unbatched reads');
    assert.equal(full.stats.batches[0], 16384, 'first body read remains small');
    assert.ok(full.stats.batches.length <= 7, 'thousands of provider fragments must not cross JS wrappers individually');
    assert.ok(full.stats.batches.every(n => n > 0 && n <= 262144));
    assert.ok(full.stats.closed > 0);
    const leftover = await (await fetch(new URL('/leftover', url))).json();
    assert.equal(leftover.exact, true, 'body bytes received with the header are not lost or duplicated');
    assert.ok(leftover.stats.batches.length <= 7);
    const cancel = await (await fetch(new URL('/cancel', url))).json();
    assert.equal(cancel.firstBytes, 16384);
    assert.ok(cancel.stats.cancelled > 0);
    assert.ok(cancel.stats.closed > 0, 'Back closes even while a batch is waiting for bytes');
    const head = await (await fetch(new URL('/head', url))).json();
    assert.equal(head.body, null);
    assert.equal(head.stats.batches.length, 0);
    assert.ok(head.stats.cancelled > 0);
  } finally { await mf.dispose(); }
});
