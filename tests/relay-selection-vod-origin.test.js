import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { selectionVodOrigin, proxySelectionVodOrigin } from '../services/norva-relay/src/selectionVodOrigin.mjs';

const origin = 'https://hls2.vcdnx.com/hls/abcdefgh/video';
const wrapper = url => 'https://movierulz.babuperumana.workers.dev/proxy?url=' + encodeURIComponent(url);
const request = new Request('https://relay.test/relay/signed');
const target = new URL(origin);
const sign = async url => 'https://relay.test/signed?u=' + encodeURIComponent(url);
const fetcher = bytes => async () => new Response(bytes);

test('origin adapter is restricted to the reviewed signed wrapper and media origin', () => {
  assert.equal(selectionVodOrigin(wrapper(origin)).href, origin);
  for (const url of [origin, wrapper('http://hls2.vcdnx.com/hls/abcdefgh/video'),
    wrapper('https://localhost/hls/abcdefgh/video'), wrapper(origin + '?url=https://attacker.test'),
    wrapper(origin) + '&url=' + encodeURIComponent(origin), wrapper(origin) + '&host=attacker',
    wrapper(origin).replace('/proxy?', '/other?'), wrapper(origin).replace('https:', 'http:')]) {
    assert.equal(selectionVodOrigin(url), null);
  }
});

test('manifest rewrites relative segments and keys into normally signed wrapper requests', async () => {
  const response = await proxySelectionVodOrigin(request, target, sign,
    fetcher('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:5,\nsegment\n#EXT-X-ENDLIST'));
  const text = await response.text();
  assert.match(response.headers.get('content-type'), /mpegurl/);
  assert.ok(text.includes(await sign(wrapper(origin.replace('/video', '/segment')))));
  assert.ok(text.includes(await sign(wrapper(origin.replace('/video', '/key')))));
});

test('PNG prefix is removed across split reads while remaining TS bytes are preserved', async () => {
  const bytes = new Uint8Array(69 + 188 * 10).fill(17);
  bytes.set([137,80,78,71,13,10,26,10]);
  for (let i = 69; i < bytes.length; i += 188) bytes[i] = 0x47;
  let at = 0;
  const response = await proxySelectionVodOrigin(request, target, sign, async () => new Response(new ReadableStream({
    pull(c) { if (at === bytes.length) return c.close(); const end = Math.min(at + 31, bytes.length); c.enqueue(bytes.slice(at, end)); at = end; },
  })));
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(69));
});

test('unexpected origins, byte ranges, malformed PNG and error pages fail closed', async () => {
  for (const body of ['#EXTM3U\nhttps://attacker.test/segment', '#EXTM3U\n#EXT-X-BYTERANGE:30\nsegment',
    '<html>provider error</html>', new Uint8Array([137,80,78,71,13,10,26,10])]) {
    await assert.rejects(proxySelectionVodOrigin(request, target, sign, fetcher(body)), /temporarily unavailable/);
  }
});

test('playlist without Content-Length is still bounded and upstream is cancelled', async () => {
  let cancelled = false, first = true;
  await assert.rejects(proxySelectionVodOrigin(request, target, sign, async () => new Response(new ReadableStream({
    pull(c) { if (first) { first = false; c.enqueue(new TextEncoder().encode('#EXTM3U\n')); }
      else c.enqueue(new Uint8Array(100_000).fill(32)); },
    cancel() { cancelled = true; },
  }))), /temporarily unavailable/);
  assert.equal(cancelled, true);
});

test('segment cancellation closes the upstream reader and aborts its fetch', async () => {
  let cancelled = false, signal;
  const response = await proxySelectionVodOrigin(request, target, sign, async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }));
  });
  await response.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, true);
});

test('Workers runtime streams the corrected segment without a stale byte length', async () => {
  const { Miniflare } = createRequire(import.meta.url)('miniflare');
  const helper = readFileSync(new URL('../services/norva-relay/src/selectionVodOrigin.mjs', import.meta.url), 'utf8');
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-06-18', host: '127.0.0.1', port: 0,
    script: helper + `
export default { async fetch(request) {
  const bytes = new Uint8Array(69 + 188 * 10).fill(17);
  bytes.set([137,80,78,71,13,10,26,10]);
  for (let i = 69; i < bytes.length; i += 188) bytes[i] = 71;
  return proxySelectionVodOrigin(request, new URL('${origin}'), async u => u,
    async () => new Response(bytes, {headers:{'content-length':String(bytes.length)}}));
}};` });
  try {
    const response = await fetch((await mf.ready).toString());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp2t');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, 1880);
    assert.equal(bytes[0], 71);
    assert.equal(bytes[188], 71);
  } finally { await mf.dispose(); }
});
