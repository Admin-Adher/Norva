const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare } = require('miniflare');

test('real Workers transport retains full and partial byte lengths after revocation wrapping', async () => {
  const helper = fs.readFileSync(path.join(__dirname, '../services/norva-relay/src/relayResponseLength.mjs'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, '../services/norva-relay/src/relayPlaybackSessionPolicy.mjs'), 'utf8');
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-06-18', host: '127.0.0.1', port: 0,
    script: helper + '\n' + policy + `
export default {fetch(request) {
  const control = new URL(request.url).pathname === '/control';
  const range = request.headers.has('range');
  const bytes = new TextEncoder().encode(range ? 'efgh' : 'abcdefghijklmnop');
  const headers = new Headers({'content-type':'video/mp4','content-length':String(bytes.length),'accept-ranges':'bytes'});
  if (range) headers.set('content-range','bytes 4-7/16');
  let sent = false;
  const upstream = new ReadableStream({pull(c) { if(sent){c.close();return;}sent=true;c.enqueue(bytes); }});
  const revocable = createRevocableRelayStream(upstream,{isActive:async()=>true});
  return new Response(control ? revocable : preserveRelayResponseLength(revocable,headers),{status:range?206:200,headers});
}};` });
  try {
    const base = (await mf.ready).toString();
    const before = await fetch(new URL('/control', base));
    assert.equal(before.headers.get('content-length'), null);
    assert.equal(await before.text(), 'abcdefghijklmnop');
    const full = await fetch(new URL('/fixed', base));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), '16');
    assert.equal(await full.text(), 'abcdefghijklmnop');
    const partial = await fetch(new URL('/fixed', base), { headers: { Range: 'bytes=4-7' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-length'), '4');
    assert.equal(partial.headers.get('content-range'), 'bytes 4-7/16');
    assert.equal(await partial.text(), 'efgh');
  } finally { await mf.dispose(); }
});

test('fixed-length wrapping retains cancellation and leaves unknown or encoded bodies alone', async () => {
  const { preserveRelayResponseLength } = await import('../services/norva-relay/src/relayResponseLength.mjs');
  const original = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class extends TransformStream { constructor() { super(); } };
  try {
    for (const headers of [{}, {'content-length':'-1'}, {'content-length':'1e6'}, {'content-length':'9007199254740992'}, {'content-length':'4','content-encoding':'gzip'}]) {
      const body = new ReadableStream();
      assert.equal(preserveRelayResponseLength(body, new Headers(headers)), body);
    }
    assert.equal(preserveRelayResponseLength(null, new Headers({'content-length':'4'})), null);
    let cancelled;
    const body = new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));},cancel(reason){cancelled=reason;}});
    const reader = preserveRelayResponseLength(body, new Headers({'content-length':'100'})).getReader();
    assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
    await reader.cancel('viewer-seek');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 'viewer-seek');
  } finally {
    if (original === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = original;
  }
});
