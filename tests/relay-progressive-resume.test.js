const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function response({ start = 0, end = 15, total = 16, bytes = 'abcdefghijklmnop', etag = '"file-v1"', failure, status = 206 } = {}) {
  let sent = false;
  const body = new ReadableStream({ pull(c) {
    if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(bytes)); return; }
    if (failure === 'error') c.error(new Error('connection reset'));
    else if (failure !== 'hang') c.close();
  } });
  const headers = new Headers({ 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${total}` });
  if (etag) headers.set('etag', etag);
  return new Response(body, { status, headers });
}
async function api() { return import('../services/norva-relay/src/relayProgressiveStream.mjs'); }

test('the independent relay deployment runs the streaming regression suite before publishing', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy-relay.yml'), 'utf8');
  const install = workflow.indexOf('run: npm ci --ignore-scripts');
  const verify = workflow.indexOf('run: node --test tests/relay-*.test.js');
  const publish = workflow.indexOf('- name: Deploy Worker');
  assert.ok(install > 0 && verify > install && publish > verify);
});

test('open-ended progressive ranges are bounded without changing engine or suffix ranges', async () => {
  const { boundedProgressiveRange } = await api();
  assert.equal(boundedProgressiveRange('bytes=0-'), 'bytes=0-8388607');
  assert.equal(boundedProgressiveRange('bytes=306048360-', 7041043829), 'bytes=306048360-314436967');
  assert.equal(boundedProgressiveRange('bytes=7040958464-', 7041043829), 'bytes=7040958464-7041043828');
  assert.equal(boundedProgressiveRange('bytes=0-', 100), 'bytes=0-99');
  for (const range of ['', 'bytes=-100', 'bytes=10-20', 'bytes=0-10,20-30', 'bytes=9007199254740991-']) assert.equal(boundedProgressiveRange(range), null);
  assert.equal(boundedProgressiveRange('bytes=100-', 100), null);
  assert.equal(boundedProgressiveRange('bytes=8388608-49031773', 49031774, true), 'bytes=8388608-16777215');
  assert.equal(boundedProgressiveRange('bytes=8388608-49031773', 49031774, false), null);
  assert.equal(boundedProgressiveRange('bytes=10-20', 100, true), 'bytes=10-20');
});

test('the relay bounds finite VOD only, including browser EOF requests but not engine windows', async () => {
  const { boundedProgressiveRange } = await api();
  const source = fs.readFileSync(path.join(__dirname, '../services/norva-relay/src/index.js'), 'utf8');
  const helper = source.slice(source.indexOf('function finiteVodRange('), source.indexOf('\nasync function proxyImage('));
  const finite = require('node:vm').runInNewContext(`(${helper})`, {
    CONTENT_LENGTH_CACHE: new Map(), CONTENT_LENGTH_TTL_MS: 300000, boundedProgressiveRange,
  });
  const native = new Headers({ 'sec-fetch-dest': 'video' });
  assert.equal(finite('bytes=8388608-49031773', new URL('https://provider.invalid/movie/u/p/1.mp4'), native), 'bytes=8388608-16777215');
  assert.equal(finite('bytes=8388608-49031773', new URL('https://provider.invalid/series/u/p/1.mkv'), new Headers()), null);
  for (const file of ['/live/u/p/1.ts', '/movie/u/p/index.m3u8', '/opaque.ts']) {
    assert.equal(finite('bytes=0-', new URL('https://provider.invalid'+file), native), null, file);
  }
  assert.match(source, /finiteVodRange\(requestedRange, targetUrl, request.headers\)/);
  assert.match(source, /boundedUpstreamRange\(requestedRange, targetUrl, headers, request.headers\)/);
  assert.match(source, /headers.set\("accept-encoding", "identity"\)/);
  assert.match(source, /retryHeaders.set\("if-range", etag\)/);
});

for (const failure of ['short', 'error', 'hang']) {
  test(`a ${failure} body resumes at the next byte without duplication or a new playback session`, async () => {
    const { createResumableProgressiveBody } = await api();
    let attempts = 0, aborts = 0;
    const body = createResumableProgressiveBody(response({ bytes: 'abcd', failure }), {
      readTimeoutMs: 10, abort() { aborts++; }, isActive: async () => true,
      async fetchRange({ start, end, etag, signal }) {
        attempts++;
        assert.equal(aborts, 1, 'the old upstream is closed before a replacement opens');
        assert.equal(start, 4); assert.equal(end, 15); assert.equal(etag, '"file-v1"');
        assert.equal(signal.aborted, false);
        return { response: response({ start, bytes: 'efghijklmnop' }) };
      },
    });
    assert.equal(await new Response(body).text(), 'abcdefghijklmnop');
    assert.equal(attempts, 1);
  });
}

test('seek recovery preserves absolute file offsets and closes at content length, not socket EOF', async () => {
  const { createResumableProgressiveBody } = await api();
  let cancelled = false;
  const original = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('efgh')); }, cancel() { cancelled = true; } }), {
    status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 4-7/16', etag: '"file-v1"' },
  });
  assert.equal(await new Response(createResumableProgressiveBody(original, { fetchRange() { assert.fail('unneeded retry'); } })).text(), 'efgh');
  assert.equal(cancelled, true);
  const body = createResumableProgressiveBody(response({ start: 4, bytes: 'ef' }), {
    isActive: async () => true,
    async fetchRange({ start, end }) {
      assert.equal(start, 6); assert.equal(end, 15);
      return { response: response({ start, bytes: 'ghijklmnop' }) };
    },
  });
  assert.equal(await new Response(body).text(), 'efghijklmnop');
});

test('unknown, weakly validated, encoded or inconsistent bodies are never stitched', async () => {
  const { createResumableProgressiveBody, progressiveRangeIdentity } = await api();
  for (const change of [r => r.headers.delete('etag'), r => r.headers.set('etag', 'W/"file-v1"'),
    r => r.headers.set('content-encoding', 'gzip'), r => r.headers.delete('content-length'),
    r => r.headers.set('content-range', 'bytes 0-14/16')]) {
    const r = response(); change(r);
    assert.equal(progressiveRangeIdentity(r), null);
    assert.equal(createResumableProgressiveBody(r, { fetchRange() { assert.fail(); } }), r.body);
    await r.body.cancel();
  }
});

for (const change of [{ etag: '"another-file"' }, { total: 17 }, { status: 200 }, { start: 0 }, { status: 458 }]) {
  test(`refuses an unsafe range continuation: ${JSON.stringify(change)}`, async () => {
    const { createResumableProgressiveBody } = await api();
    let retries = 0;
    const body = createResumableProgressiveBody(response({ bytes: 'abcd' }), {
      isActive: async () => true,
      async fetchRange() { retries++; return { response: response({ start: 4, bytes: 'efghijklmnop', ...change }) }; },
    });
    await assert.rejects(new Response(body).text(), /RELAY_UNSAFE_RANGE_RESUME/);
    assert.equal(retries, 1, 'never retry a provider-busy, ignored-range or changed-file response');
  });
}

test('recovery is capped at two attempts and requires live session authority', async () => {
  const { createResumableProgressiveBody } = await api();
  let attempts = 0;
  const body = createResumableProgressiveBody(response({ bytes: 'a' }), {
    isActive: async () => true,
    async fetchRange({ start }) { attempts++; return { response: response({ start, bytes: 'b' }) }; },
  });
  await assert.rejects(new Response(body).text(), /RELAY_UPSTREAM_TRUNCATED/);
  assert.equal(attempts, 2);
  const revoked = createResumableProgressiveBody(response({ bytes: 'a' }), {
    isActive: async () => false, fetchRange() { assert.fail('revoked playback must not reopen a provider connection'); },
  });
  await assert.rejects(new Response(revoked).text(), /PLAYBACK_SUPERSEDED/);
});

test('Back/cancellation aborts a pending range request without a late retry', async () => {
  const { createResumableProgressiveBody } = await api();
  let retrySignal, began;
  const ready = new Promise(resolve => { began = resolve; });
  const reader = createResumableProgressiveBody(response({ bytes: 'a' }), {
    isActive: async () => true,
    fetchRange({ signal }) {
      retrySignal = signal; began();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
    },
  }).getReader();
  await reader.read();
  const pending = reader.read();
  await ready;
  await reader.cancel('viewer-back');
  assert.equal(retrySignal.aborted, true);
  assert.equal((await pending).done, true);
});

test('a hanging range handshake is aborted within its own deadline', async () => {
  const { createResumableProgressiveBody } = await api();
  let attempts = 0;
  const body = createResumableProgressiveBody(response({ bytes: 'a' }), {
    resumeTimeoutMs: 10, isActive: async () => true,
    fetchRange({ signal }) {
      attempts++;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('handshake timeout'))));
    },
  });
  await assert.rejects(new Response(body).text(), /handshake timeout/);
  assert.equal(attempts, 1);
});

test('Workers sends exact 206 bytes and Content-Length after an interrupted upstream', async () => {
  const { Miniflare } = require('miniflare');
  const root = path.join(__dirname, '../services/norva-relay/src');
  const script = ['relayProgressiveStream.mjs', 'relayPlaybackSessionPolicy.mjs', 'relayResponseLength.mjs']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-06-18', host: '127.0.0.1', port: 0,
    script: script + `\nexport default {fetch() {
      const headers = new Headers({'content-length':'16','content-range':'bytes 0-15/16','etag':'"v1"','content-type':'video/mp4'});
      const partial = new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('abcd'));c.close();}}), {status:206,headers});
      const body = createResumableProgressiveBody(partial, {isActive:async()=>true,fetchRange:async({start,end,etag})=>{
        if(start!==4||end!==15||etag!=='"v1"')throw new Error('wrong range');
        return {response:new Response('efghijklmnop',{status:206,headers:{'content-length':'12','content-range':'bytes 4-15/16','etag':'"v1"'}})};
      }});
      return new Response(preserveRelayResponseLength(createRevocableRelayStream(body,{isActive:async()=>true}),headers),{status:206,headers});
    }};` });
  try {
    const result = await fetch(await mf.ready);
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-length'), '16');
    assert.equal(result.headers.get('content-range'), 'bytes 0-15/16');
    assert.equal(await result.text(), 'abcdefghijklmnop');
  } finally { await mf.dispose(); }
});
